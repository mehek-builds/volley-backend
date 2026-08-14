import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { packetAuditSha256 } from '../lib/packetAudit';
import * as schema from './schema';

function runMigration(databaseUrl: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/apply-litos-plus-v2-schema.mjs'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        ENTITLEMENT_V2_CUTOVER_AT: '2026-08-14T00:00:00.000Z',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Migration exited ${code}: ${stderr || stdout}`));
    });
  });
}

test('production Litos+ migration creates the complete schema and is idempotent', async () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'litos-migration-'));
  const database = await PGlite.create();
  let server: PGLiteSocketServer | null = null;
  try {
    const initial = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema as unknown as Record<string, unknown>),
    );
    for (const statement of initial) await database.exec(statement);

    // Keep the pre-existing regional billing tables that the migration alters, and remove only
    // the tables this migration owns so its CREATE statements are exercised rather than skipped.
    await database.exec(`
      drop index if exists "pricing_offers_one_live_litos_checkout_idx";
      drop table if exists "candidate_visibility_profiles" cascade;
      drop table if exists "network_company_matches" cascade;
      drop table if exists "network_edges" cascade;
      drop table if exists "network_people" cascade;
      drop table if exists "network_imports" cascade;
      drop table if exists "linked_network_accounts" cascade;
      drop table if exists "network_consents" cascade;
      drop table if exists "monetization_events" cascade;
      drop table if exists "pending_premium_actions" cascade;
      drop table if exists "application_submission_events" cascade;
      drop table if exists "application_artifacts" cascade;
      drop table if exists "artifact_versions" cascade;
      drop table if exists "applications" cascade;
      drop table if exists "artifacts" cascade;
      drop table if exists "entitlement_usage_reservations" cascade;
      drop table if exists "trial_company_usage" cascade;
      drop table if exists "trial_answer_applications" cascade;
      drop table if exists "trial_generation_usage" cascade;
      drop table if exists "billing_subscriptions" cascade;
      drop table if exists "billing_account_deletion_tombstones" cascade;
      drop table if exists "outreach_draft_generations" cascade;
      drop table if exists "user_contact_unlocks" cascade;
    `);
    await database.exec(`
      insert into "users" ("email", "created_at", "trial_ends_at", "automatic_submission_enabled")
      values ('grandfathered@example.test', '2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z', true);
      insert into "users" ("email", "created_at")
      values ('rollout-gap@example.test', '2026-08-14T01:00:00.000Z');
      insert into "generated_resumes" (
        "id", "user_id", "job_context", "spec", "resume_object_key", "created_at"
      ) select
        '0b84c4eb-5c91-43d0-a5a0-62b508d8ce55', "id",
        '{"role":"Engineer","company":"Example"}'::jsonb,
        '{"zeta":3,"alpha":{"second":2,"first":1},"_review":{"role":"Engineer","jd_text":"Frozen JD text"}}'::jsonb,
        'users/legacy/resumes/frozen.pdf', '2026-08-02T00:00:00.000Z'
      from "users" where "email" = 'grandfathered@example.test'
    `);

    server = new PGLiteSocketServer({
      db: database,
      path: join(socketDir, '.s.PGSQL.5432'),
      maxConnections: 5,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
    const first = await runMigration(databaseUrl);
    await database.exec(`
      drop index if exists "pending_premium_actions_user_idempotency_binding_unique";
      alter table "pending_premium_actions" drop column if exists "idempotency_binding";
      insert into "pending_premium_actions" (
        "nonce_hash", "user_id", "feature_key", "return_route", "idempotency_key", "expires_at"
      )
      select
        'legacy-pending-action-one', "id", 'ai_resume_tailoring', '/dashboard/applications',
        'legacy-duplicate-key', timestamptz '2099-01-01T00:00:00.000Z'
      from "users" where "email" = 'grandfathered@example.test'
      union all
      select
        'legacy-pending-action-two', "id", 'ai_resume_tailoring', '/dashboard/applications',
        'legacy-duplicate-key', timestamptz '2099-01-01T00:00:00.000Z'
      from "users" where "email" = 'grandfathered@example.test';
    `);
    await database.exec(`
      create unique index "billing_subscriptions_one_effective_idx"
      on "billing_subscriptions" ("user_id")
      where "status" in ('active', 'trialing', 'past_due', 'paused')
    `);
    await database.exec(`
      update "generated_resumes" set
        "spec" = '{"summary":"mutable later value"}'::jsonb,
        "resume_object_key" = 'users/legacy/resumes/mutable-later.pdf'
      where "id" = '0b84c4eb-5c91-43d0-a5a0-62b508d8ce55'
    `);
    await database.exec(`
      insert into "users" (
        "email", "created_at", "entitlement_policy_version", "trial_started_at", "trial_ends_at"
      ) values (
        'new-v2@example.test', '2026-08-13T12:00:00.000Z', 'litos-entitlements-v2',
        '2026-08-13T12:00:00.000Z', '2026-08-20T12:00:00.000Z'
      )
    `);
    const second = await runMigration(databaseUrl);
    assert.match(first.stdout, /Ready: Litos\+ v2 schema/);
    assert.match(second.stdout, /Ready: Litos\+ v2 schema/);

    const columns = await database.query<{ table_name: string; column_name: string }>(`
      select table_name, column_name from information_schema.columns
      where table_name in (
        'network_imports', 'network_people', 'applications', 'candidate_visibility_profiles',
        'entitlement_usage_reservations', 'billing_account_deletion_tombstones',
        'user_contact_unlocks', 'outreach_draft_generations', 'artifact_versions',
        'application_submission_events', 'pending_premium_actions'
      )
    `);
    const names = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
    for (const expected of [
      'network_imports.raw_deleted_at',
      'network_imports.preview_rows',
      'network_people.provenance',
      'applications.resume_attached',
      'applications.resume_source',
      'applications.resume_attached_at',
      'candidate_visibility_profiles.enabled',
      'entitlement_usage_reservations.requested_units',
      'billing_account_deletion_tombstones.provider_subscription_hash',
      'billing_account_deletion_tombstones.cancellation_confirmed_at',
      'billing_account_deletion_tombstones.account_deleted_at',
      'user_contact_unlocks.company_scope_key',
      'user_contact_unlocks.source',
      'outreach_draft_generations.operation_id',
      'outreach_draft_generations.request_hash',
      'outreach_draft_generations.contact_id',
      'outreach_draft_generations.application_id',
      'outreach_draft_generations.draft_type',
      'outreach_draft_generations.generation_source',
      'outreach_draft_generations.contact_email',
      'outreach_draft_generations.original_subject',
      'outreach_draft_generations.original_body',
      'outreach_draft_generations.subject',
      'outreach_draft_generations.body',
      'artifact_versions.rendered_object_key',
      'artifact_versions.rendered_blob_url',
      'application_submission_events.event_id',
      'application_submission_events.applied_submission_state',
      'pending_premium_actions.idempotency_binding',
    ]) assert.equal(names.has(expected), true, `${expected} missing after migration`);

    const indexes = await database.query<{ indexname: string }>(`
      select indexname from pg_indexes where schemaname = current_schema()
        and indexname in (
          'network_consents_one_active_idx',
          'network_people_user_identity_unique',
          'network_edges_user_person_relationship_unique',
          'network_company_matches_user_company_unique',
          'pricing_offers_one_live_litos_checkout_idx',
          'billing_subscriptions_one_effective_idx',
          'billing_account_deletion_tombstone_provider_subscription_unique',
          'billing_account_deletion_tombstone_expiry_idx',
          'user_contact_unlocks_user_company_idx',
          'outreach_draft_generations_user_operation_unique',
          'outreach_draft_generations_user_created_idx',
          'outreach_draft_generations_application_created_idx',
          'artifact_versions_rendered_object_key_unique',
          'application_submission_events_user_event_unique',
          'application_submission_events_application_time_idx',
          'pending_premium_actions_user_idempotency_binding_unique'
        )
    `);
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const expected of [
      'network_consents_one_active_idx',
      'network_people_user_identity_unique',
      'network_edges_user_person_relationship_unique',
      'network_company_matches_user_company_unique',
      'pricing_offers_one_live_litos_checkout_idx',
      'billing_account_deletion_tombstone_provider_subscription_unique',
      'billing_account_deletion_tombstone_expiry_idx',
      'user_contact_unlocks_user_company_idx',
      'outreach_draft_generations_user_operation_unique',
      'outreach_draft_generations_user_created_idx',
      'outreach_draft_generations_application_created_idx',
      'artifact_versions_rendered_object_key_unique',
      'application_submission_events_user_event_unique',
      'application_submission_events_application_time_idx',
      'pending_premium_actions_user_idempotency_binding_unique',
    ]) assert.equal(indexNames.has(expected), true, `${expected} missing after migration`);
    assert.equal(indexNames.has('billing_subscriptions_one_effective_idx'), false);
    const legacyPendingActions = await database.query<{ total: number; bound: number }>(`
      select count(*)::int as total, count("idempotency_binding")::int as bound
      from "pending_premium_actions" where "idempotency_key" = 'legacy-duplicate-key'
    `);
    assert.deepEqual(legacyPendingActions.rows[0], { total: 2, bound: 0 });
    await database.exec(`
      update "pending_premium_actions" set "idempotency_binding" = 'new-replay-binding'
      where "nonce_hash" = 'legacy-pending-action-one'
    `);
    const duplicateBinding = await database.query<{ id: string }>(`
      insert into "pending_premium_actions" (
        "nonce_hash", "user_id", "feature_key", "return_route", "idempotency_key",
        "idempotency_binding", "expires_at"
      )
      select
        'new-pending-action-conflict', "id", 'ai_resume_tailoring', '/dashboard/applications',
        'new-replay-binding', 'new-replay-binding', '2099-01-01T00:00:00.000Z'
      from "users" where "email" = 'grandfathered@example.test'
      on conflict do nothing returning "id"
    `);
    assert.equal(duplicateBinding.rows.length, 0);
    const constraints = await database.query<{ conname: string }>(`
      select conname from pg_constraint where conname in (
        'applications_resume_attachment_state_check',
        'entitlement_reservations_requested_units_check',
        'outreach_draft_generations_draft_type_check',
        'outreach_draft_generations_generation_source_check'
      )
    `);
    const constraintNames = new Set(constraints.rows.map((row) => row.conname));
    assert.equal(constraintNames.has('applications_resume_attachment_state_check'), true);
    assert.equal(constraintNames.has('entitlement_reservations_requested_units_check'), true);
    assert.equal(constraintNames.has('outreach_draft_generations_draft_type_check'), true);
    assert.equal(constraintNames.has('outreach_draft_generations_generation_source_check'), true);
    const outreachTypeConstraint = await database.query<{ definition: string }>(`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'outreach_draft_generations_draft_type_check'
    `);
    for (const type of ['first_note', 'follow_up', 'thank_you', 'referral_ask', 'offer_stage']) {
      assert.match(outreachTypeConstraint.rows[0].definition, new RegExp(type));
    }
    const attachmentConstraint = await database.query<{ definition: string }>(`
      select pg_get_constraintdef(oid) as definition from pg_constraint
      where conname = 'applications_resume_attachment_state_check'
    `);
    assert.match(attachmentConstraint.rows[0].definition, /resume_source.*base_resume/i);
    assert.doesNotMatch(attachmentConstraint.rows[0].definition, /base_resume[^)]*selected_resume_artifact_id/i);

    const account = await database.query<{
      grandfather_policy: string;
      automatic_submission_legacy_granted: boolean;
      trial_ends_at: Date;
    }>(`select "grandfather_policy", "automatic_submission_legacy_granted", "trial_ends_at"
       from "users" where "email" = 'grandfathered@example.test'`);
    assert.equal(account.rows[0].grandfather_policy, 'legacy_free_v1');
    assert.equal(account.rows[0].automatic_submission_legacy_granted, true);
    assert.equal(new Date(account.rows[0].trial_ends_at).toISOString(), '2026-08-20T00:00:00.000Z');

    const v2Account = await database.query<{
      entitlement_policy_version: string;
      grandfather_policy: string | null;
      trial_ends_at: Date;
    }>(`select "entitlement_policy_version", "grandfather_policy", "trial_ends_at"
       from "users" where "email" = 'new-v2@example.test'`);
    assert.equal(v2Account.rows[0].entitlement_policy_version, 'litos-entitlements-v2');
    assert.equal(v2Account.rows[0].grandfather_policy, null);
    assert.equal(new Date(v2Account.rows[0].trial_ends_at).toISOString(), '2026-08-20T12:00:00.000Z');

    const rolloutGap = await database.query<{
      entitlement_policy_version: string;
      grandfather_policy: string | null;
      trial_started_at: Date;
      trial_ends_at: Date;
    }>(`select "entitlement_policy_version", "grandfather_policy", "trial_started_at", "trial_ends_at"
       from "users" where "email" = 'rollout-gap@example.test'`);
    assert.equal(rolloutGap.rows[0].entitlement_policy_version, 'litos-entitlements-v2');
    assert.equal(rolloutGap.rows[0].grandfather_policy, null);
    assert.equal(new Date(rolloutGap.rows[0].trial_started_at).toISOString(), '2026-08-14T01:00:00.000Z');
    assert.equal(new Date(rolloutGap.rows[0].trial_ends_at).toISOString(), '2026-08-21T01:00:00.000Z');

    const frozenVersion = await database.query<{
      content_hash: string;
      structured_content: unknown;
      rendered_object_key: string;
    }>(`select "content_hash", "structured_content", "rendered_object_key"
       from "artifact_versions" where "artifact_id" = '0b84c4eb-5c91-43d0-a5a0-62b508d8ce55'`);
    assert.equal(frozenVersion.rows.length, 1);
    assert.deepEqual(frozenVersion.rows[0].structured_content, {
      _review: { jd_text: 'Frozen JD text', role: 'Engineer' },
      alpha: { first: 1, second: 2 },
      zeta: 3,
    });
    assert.equal(
      frozenVersion.rows[0].content_hash,
      packetAuditSha256(frozenVersion.rows[0].structured_content),
    );
    assert.equal(frozenVersion.rows[0].rendered_object_key, 'users/legacy/resumes/frozen.pdf');

    const migratedOwner = await database.query<{ id: string }>(`
      select "id" from "users" where "email" = 'grandfathered@example.test'
    `);
    const priorRuntimeEnv = {
      databaseUrl: process.env.DATABASE_URL,
      vercel: process.env.VERCEL,
      jwt: process.env.JWT_SIGNING_SECRET,
      nodeEnv: process.env.NODE_ENV,
    };
    process.env.DATABASE_URL = databaseUrl;
    process.env.VERCEL = '1';
    process.env.JWT_SIGNING_SECRET = 'migration-runtime-jwt-secret-at-least-32';
    process.env.NODE_ENV = 'test';
    const { canonicalApplicationRoutes } = await import('../routes/canonicalApplications');
    const runtimeDb = await import('./index');
    const runtimeApp = Fastify({ logger: false });
    try {
      await runtimeApp.register(canonicalApplicationRoutes);
      await runtimeApp.ready();
      const runtimeToken = await new SignJWT({
        userId: migratedOwner.rows[0].id,
        email: 'grandfathered@example.test',
        isGuest: false,
        sessionVersion: 0,
        authMethod: 'password',
      }).setProtectedHeader({ alg: 'HS256' }).setIssuedAt()
        .sign(new TextEncoder().encode(process.env.JWT_SIGNING_SECRET));
      const adopted = await runtimeApp.inject({
        method: 'POST',
        url: '/applications',
        headers: { authorization: `Bearer ${runtimeToken}` },
        payload: { company: 'Example', role: 'Engineer', source: 'dashboard' },
      });
      assert.equal(adopted.statusCode, 200, adopted.body);
      assert.equal(adopted.json().application.id, '0b84c4eb-5c91-43d0-a5a0-62b508d8ce55');
      assert.equal(adopted.json().adopted, true);
      const migratedApplications = await database.query<{ total: number; legacy_generated_resume_id: string }>(`
        select count(*)::int as total, min("legacy_generated_resume_id"::text) as "legacy_generated_resume_id"
        from "applications" where "user_id" = '${migratedOwner.rows[0].id}'
      `);
      assert.deepEqual(migratedApplications.rows[0], {
        total: 1,
        legacy_generated_resume_id: '0b84c4eb-5c91-43d0-a5a0-62b508d8ce55',
      });
    } finally {
      await runtimeApp.close();
      await runtimeDb.pool.end();
      if (priorRuntimeEnv.databaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = priorRuntimeEnv.databaseUrl;
      if (priorRuntimeEnv.vercel === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = priorRuntimeEnv.vercel;
      if (priorRuntimeEnv.jwt === undefined) delete process.env.JWT_SIGNING_SECRET;
      else process.env.JWT_SIGNING_SECRET = priorRuntimeEnv.jwt;
      if (priorRuntimeEnv.nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorRuntimeEnv.nodeEnv;
    }

    const checkoutAccount = await database.query<{ id: string }>(`
      insert into "users" ("email", "created_at", "entitlement_policy_version")
      values ('checkout-race@example.test', '2026-08-14T02:00:00.000Z', 'litos-entitlements-v2')
      returning "id"
    `);
    await database.exec(`
      insert into "billing_subscriptions" (
        "user_id", "provider", "provider_customer_id", "provider_subscription_id",
        "provider_price_id", "product_code", "term_code", "status", "provider_event_created_at"
      ) values
        ('${checkoutAccount.rows[0].id}', 'stripe', 'cus_replacement', 'sub_old_past_due',
         'price_month', 'litos_plus', 'month', 'past_due', '2026-08-14T01:00:00.000Z'),
        ('${checkoutAccount.rows[0].id}', 'stripe', 'cus_replacement', 'sub_new_active',
         'price_month', 'litos_plus', 'month', 'active', '2026-08-14T02:00:00.000Z')
    `);
    const replacementSubscriptions = await database.query<{ total: number }>(`
      select count(*)::int as total from "billing_subscriptions"
      where "user_id" = '${checkoutAccount.rows[0].id}'
    `);
    assert.equal(replacementSubscriptions.rows[0].total, 2);
    const insertOffer = (id: string, clientKey: string) => database.query<{ id: string }>(`
      insert into "pricing_offers" (
        "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code",
        "band", "experiment_variant", "billing_interval", "currency", "base_amount_cents",
        "amount_cents", "status", "expires_at", "product_code", "term_code", "client_idempotency_key"
      ) values (
        '${id}', '${checkoutAccount.rows[0].id}', 'checkout-race@example.test', 'v2:${clientKey}',
        'litos-entitlements-v2', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
        'creating', '2026-08-15T02:00:00.000Z', 'litos_plus', 'month', '${clientKey}'
      ) on conflict do nothing returning "id"
    `);
    const competing = await Promise.all([
      insertOffer('80fb4526-6c0b-40db-9f4f-bbd5e80910cf', 'first-key'),
      insertOffer('3f8f6066-9e34-4ac7-b20a-29685956ddca', 'second-key'),
    ]);
    assert.equal(competing.reduce((sum, result) => sum + result.rows.length, 0), 1);
    const liveOffers = await database.query<{ total: number }>(`
      select count(*)::int as total from "pricing_offers"
      where "user_id" = '${checkoutAccount.rows[0].id}'
        and "product_code" = 'litos_plus'
        and "status" in ('creating', 'checkout_created')
    `);
    assert.equal(liveOffers.rows[0].total, 1);

    const pendingAction = await database.query<{ id: string }>(`
      insert into "pending_premium_actions" (
        "nonce_hash", "user_id", "feature_key", "return_route", "idempotency_key", "expires_at"
      ) values (
        'pending-action-concurrency-hash', '${checkoutAccount.rows[0].id}', 'ai_resume_tailoring',
        '/dashboard/applications', 'pending-action-operation', '2099-01-01T00:00:00.000Z'
      ) returning "id"
    `);
    const consume = () => database.query<{ id: string }>(`
      update "pending_premium_actions" set "state" = 'consumed', "consumed_at" = now()
      where "id" = '${pendingAction.rows[0].id}' and "state" = 'pending' and "expires_at" > now()
      returning "id"
    `);
    const consumed = await Promise.all([consume(), consume()]);
    assert.equal(consumed.reduce((sum, result) => sum + result.rows.length, 0), 1);
  } finally {
    await server?.stop();
    await database.close();
    rmSync(socketDir, { recursive: true, force: true });
  }
});
