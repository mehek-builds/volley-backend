#!/usr/bin/env node

/* Creates the immutable evidence ledger used by the duplicate-risk gate.
 *
 * This script is additive and does not rewrite generated_resumes.spec._review. Its first successful
 * transaction deterministically copies only facts visible in that current projection and seals the
 * import with an immutable marker. Later runs repair and verify schema without reinterpreting a
 * changed projection as new history. Runtime dual-read keeps the source projection active while
 * every new employer-boundary attempt starts writing this ledger.
 *
 * UPDATE and direct row DELETE are rejected. Deletion is allowed only from the users foreign-key
 * cascade so account/privacy erasure remains possible.
 */

import pg from 'pg';

const REQUIRED_COLUMNS = [
  'id',
  'user_id',
  'application_id',
  'packet_id',
  'event_id',
  'attempt_id',
  'parent_attempt_id',
  'event_kind',
  'source',
  'operation',
  'submission_run_id',
  'submission_claim_id',
  'packet_version',
  'posting_key',
  'job_id',
  'company_role',
  'company_name',
  'role',
  'portal_url',
  'portal_identity',
  'proof_kind',
  'evidence_code',
  'boundary_activation_id',
  'boundary_expires_at',
  'observed_at',
  'created_at',
];

const REQUIRED_BINDING_COLUMNS = [
  'user_id',
  'attempt_id',
  'application_id',
  'packet_id',
  'parent_attempt_id',
  'source',
  'operation',
  'submission_run_id',
  'submission_claim_id',
  'packet_version',
  'posting_key',
  'job_id',
  'company_role',
  'company_name',
  'role',
  'portal_url',
  'portal_identity',
  'created_at',
];

const REQUIRED_DISTINCTION_COLUMNS = [
  'id',
  'user_id',
  'relation_id',
  'prior_attempt_id',
  'candidate_application_id',
  'candidate_packet_id',
  'candidate_identity_version',
  'candidate_identity_digest',
  'candidate_identity_snapshot',
  'candidate_posting_key',
  'candidate_job_id',
  'candidate_company_role',
  'candidate_portal_url',
  'proof_kind',
  'observed_at',
  'created_at',
];

const REQUIRED_INDEXES = [
  'application_submission_attempt_events_pkey',
  'application_submission_attempt_events_user_event_unique',
  'application_submission_attempt_events_user_attempt_time_idx',
  'submission_attempt_events_user_attempt_boundary_uq',
  'application_submission_attempt_events_packet_time_idx',
  'application_submission_attempt_events_user_posting_idx',
  'application_submission_attempt_events_user_job_idx',
  'application_submission_attempt_events_user_company_role_idx',
];

const REQUIRED_DISTINCTION_INDEXES = [
  'application_posting_distinctions_pkey',
  'application_posting_distinctions_user_relation_unique',
  'application_posting_distinctions_pair_identity_unique',
  'application_posting_distinctions_candidate_lookup_idx',
  'application_posting_distinctions_prior_attempt_idx',
];

const REQUIRED_CONSTRAINTS = [
  'application_submission_attempt_events_kind_check',
  'application_submission_attempt_events_source_check',
  'application_submission_attempt_events_operation_check',
  'application_submission_attempt_events_proof_check',
  'submission_attempt_events_boundary_auth_check',
  'application_submission_attempt_events_parent_check',
];

const REQUIRED_BINDING_CONSTRAINTS = [
  'application_submission_attempt_bindings_pkey',
  'application_submission_attempt_bindings_source_check',
  'application_submission_attempt_bindings_operation_check',
  'application_submission_attempt_bindings_parent_check',
];

const REQUIRED_DISTINCTION_CONSTRAINTS = [
  'application_posting_distinctions_pkey',
  'application_posting_distinctions_prior_attempt_fk',
  'application_posting_distinctions_identity_version_check',
  'application_posting_distinctions_identity_digest_check',
  'application_posting_distinctions_portal_url_check',
  'application_posting_distinctions_proof_kind_check',
];

const LEGACY_BACKFILL_MARKER = 'legacy_backfill_v1';

const REQUIRED_CUTOVER_COLUMNS = [
  'cutover_key',
  'completed_at',
];

const REQUIRED_CUTOVER_CONSTRAINTS = [
  'application_submission_attempt_ledger_cutovers_pkey',
  'application_submission_attempt_ledger_cutovers_key_check',
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("set lock_timeout = '2min'");
    await client.query("set statement_timeout = '2min'");
    await client.query('begin');
    /* Serializes the one-time marker decision across concurrent migration runners. The lock lives
       only for this transaction, so a failed migration releases it together with every schema and
       backfill write. */
    await client.query('select pg_advisory_xact_lock($1, $2)', [1414090051, 20260826]);
    /* Freeze every legacy evidence source before reading any of them or deciding whether the
       one-time marker exists. SHARE conflicts with INSERT, UPDATE, and DELETE while still allowing
       ordinary readers. An in-flight writer must finish before these locks are granted, so its fact
       enters this snapshot. A writer that arrives later cannot cross the snapshot-to-marker window
       and resumes only after this transaction commits. */
    await client.query(`
      lock table
        generated_resumes,
        applications,
        application_submission_events,
        autofill_events
      in share mode
    `);

    /* This hook exists only to make the lock boundary observable in the standalone concurrency
       contract. It is unreachable in production because NODE_ENV must be exactly test. */
    const testSourceLockHoldMs = process.env.NODE_ENV === 'test'
      ? Number.parseInt(process.env.SUBMISSION_ATTEMPT_LEDGER_TEST_SOURCE_LOCK_HOLD_MS ?? '', 10)
      : 0;
    if (Number.isInteger(testSourceLockHoldMs) && testSourceLockHoldMs > 0) {
      if (testSourceLockHoldMs > 5_000) {
        throw new Error('Test source-lock hold may not exceed 5000ms');
      }
      console.log('Test hook: legacy source locks acquired.');
      await new Promise((resolve) => setTimeout(resolve, testSourceLockHoldMs));
    }

    const legacyEventOwnershipMismatch = await client.query(`
      select
        manual_event.id as event_id,
        manual_event.user_id as event_user_id,
        application.user_id as application_user_id
      from application_submission_events manual_event
      inner join applications application on application.id = manual_event.application_id
      where manual_event.user_id is distinct from application.user_id
      limit 1
    `);
    if (legacyEventOwnershipMismatch.rows[0]) {
      const mismatch = legacyEventOwnershipMismatch.rows[0];
      throw new Error(
        `Legacy application submission event ownership mismatch: event ${mismatch.event_id} `
        + `belongs to user ${mismatch.event_user_id}, application belongs to ${mismatch.application_user_id}`,
      );
    }

    await client.query(`
      create table if not exists application_submission_attempt_ledger_cutovers (
        cutover_key text primary key,
        completed_at timestamptz not null default now(),
        constraint application_submission_attempt_ledger_cutovers_key_check check (
          cutover_key = '${LEGACY_BACKFILL_MARKER}'
        )
      )
    `);
    await client.query(`
      alter table application_submission_attempt_ledger_cutovers
        drop constraint if exists application_submission_attempt_ledger_cutovers_key_check
    `);
    await client.query(`
      alter table application_submission_attempt_ledger_cutovers
        add constraint application_submission_attempt_ledger_cutovers_key_check check (
          cutover_key = '${LEGACY_BACKFILL_MARKER}'
        )
    `);
    await client.query(`
      create or replace function reject_submission_attempt_ledger_cutover_change()
      returns trigger language plpgsql as $$
      begin
        raise exception 'application submission attempt ledger cutover markers are immutable'
          using errcode = '55000';
      end
      $$
    `);
    await client.query(`
      drop trigger if exists application_submission_attempt_ledger_cutovers_no_update
      on application_submission_attempt_ledger_cutovers
    `);
    await client.query(`
      create trigger application_submission_attempt_ledger_cutovers_no_update
      before update on application_submission_attempt_ledger_cutovers
      for each row execute function reject_submission_attempt_ledger_cutover_change()
    `);
    await client.query(`
      drop trigger if exists application_submission_attempt_ledger_cutovers_no_delete
      on application_submission_attempt_ledger_cutovers
    `);
    await client.query(`
      create trigger application_submission_attempt_ledger_cutovers_no_delete
      before delete on application_submission_attempt_ledger_cutovers
      for each row execute function reject_submission_attempt_ledger_cutover_change()
    `);
    await client.query(`
      create table if not exists application_submission_attempt_bindings (
        user_id uuid not null references users(id) on delete cascade,
        attempt_id uuid not null,
        application_id uuid,
        packet_id uuid not null,
        parent_attempt_id uuid,
        source text not null,
        operation text not null,
        submission_run_id text,
        submission_claim_id text,
        packet_version text,
        posting_key text,
        job_id text,
        company_role text,
        company_name text not null,
        role text not null,
        portal_url text,
        portal_identity text,
        created_at timestamptz not null default now(),
        constraint application_submission_attempt_bindings_pkey primary key (user_id, attempt_id),
        constraint application_submission_attempt_bindings_source_check check (
          source in (
            'managed_browser', 'direct_browser', 'chrome_extension', 'unsupported_email',
            'ats_api', 'attended_handoff', 'legacy_backfill'
          )
        ),
        constraint application_submission_attempt_bindings_operation_check check (
          operation in ('initial_submission', 'security_code_continuation', 'manual_submission')
        ),
        constraint application_submission_attempt_bindings_parent_check check (
          parent_attempt_id is null or parent_attempt_id <> attempt_id
        )
      )
    `);
    await client.query(`
      alter table application_submission_attempt_bindings
        drop constraint if exists application_submission_attempt_bindings_source_check,
        drop constraint if exists application_submission_attempt_bindings_operation_check,
        drop constraint if exists application_submission_attempt_bindings_parent_check
    `);
    await client.query(`
      alter table application_submission_attempt_bindings
        add constraint application_submission_attempt_bindings_source_check check (
          source in (
            'managed_browser', 'direct_browser', 'chrome_extension', 'unsupported_email',
            'ats_api', 'attended_handoff', 'legacy_backfill'
          )
        ),
        add constraint application_submission_attempt_bindings_operation_check check (
          operation in ('initial_submission', 'security_code_continuation', 'manual_submission')
        ),
        add constraint application_submission_attempt_bindings_parent_check check (
          parent_attempt_id is null or parent_attempt_id <> attempt_id
        )
    `);
    await client.query(`
      create table if not exists application_submission_attempt_events (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        application_id uuid,
        packet_id uuid not null,
        event_id uuid not null,
        attempt_id uuid not null,
        parent_attempt_id uuid,
        event_kind text not null,
        source text not null,
        operation text not null,
        submission_run_id text,
        submission_claim_id text,
        packet_version text,
        posting_key text,
        job_id text,
        company_role text,
        company_name text not null,
        role text not null,
        portal_url text,
        portal_identity text,
        proof_kind text,
        evidence_code text,
        boundary_activation_id uuid,
        boundary_expires_at timestamptz,
        observed_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        constraint application_submission_attempt_events_kind_check check (
          event_kind in (
            'attempt_opened', 'boundary_authorized', 'press_observed',
            'submission_confirmed', 'not_sent_proven'
          )
        ),
        constraint application_submission_attempt_events_source_check check (
          source in (
            'managed_browser', 'direct_browser', 'chrome_extension', 'unsupported_email',
            'ats_api', 'attended_handoff', 'legacy_backfill'
          )
        ),
        constraint application_submission_attempt_events_operation_check check (
          operation in ('initial_submission', 'security_code_continuation', 'manual_submission')
        ),
        constraint application_submission_attempt_events_proof_check check (
          (event_kind = 'not_sent_proven' and proof_kind is not null and proof_kind in (
            'typed_pre_click_stop', 'applicant_checked_not_sent',
            'applicant_checked_all_possible_destinations_not_sent', 'employer_rejected_not_filed',
            'employer_verification_pending_not_filed', 'provider_definitive_rejection',
            'extension_cancelled_before_press'
          ))
          or (event_kind <> 'not_sent_proven' and proof_kind is null)
        ),
        constraint submission_attempt_events_boundary_auth_check check (
          (event_kind = 'boundary_authorized'
            and boundary_activation_id is not null
            and boundary_expires_at is not null
            and boundary_expires_at > observed_at
            and boundary_expires_at <= observed_at + interval '5 minutes')
          or (event_kind <> 'boundary_authorized'
            and boundary_activation_id is null
            and boundary_expires_at is null)
        ),
        constraint application_submission_attempt_events_parent_check check (
          parent_attempt_id is null or parent_attempt_id <> attempt_id
        )
      )
    `);
    await client.query(`
      alter table application_submission_attempt_events
        add column if not exists boundary_activation_id uuid,
        add column if not exists boundary_expires_at timestamptz
    `);
    /* Recreate vocabulary checks even when an earlier additive run already created the table. This
       is what makes adding a proof kind idempotent instead of leaving code and live SQL misaligned. */
    await client.query(`
      alter table application_submission_attempt_events
        drop constraint if exists application_submission_attempt_events_kind_check,
        drop constraint if exists application_submission_attempt_events_source_check,
        drop constraint if exists application_submission_attempt_events_operation_check,
        drop constraint if exists application_submission_attempt_events_proof_check,
        drop constraint if exists submission_attempt_events_boundary_auth_check,
        drop constraint if exists application_submission_attempt_events_parent_check
    `);
    await client.query(`
      alter table application_submission_attempt_events
        add constraint application_submission_attempt_events_kind_check check (
          event_kind in (
            'attempt_opened', 'boundary_authorized', 'press_observed',
            'submission_confirmed', 'not_sent_proven'
          )
        ),
        add constraint application_submission_attempt_events_source_check check (
          source in (
            'managed_browser', 'direct_browser', 'chrome_extension', 'unsupported_email',
            'ats_api', 'attended_handoff', 'legacy_backfill'
          )
        ),
        add constraint application_submission_attempt_events_operation_check check (
          operation in ('initial_submission', 'security_code_continuation', 'manual_submission')
        ),
        add constraint application_submission_attempt_events_proof_check check (
          (event_kind = 'not_sent_proven' and proof_kind is not null and proof_kind in (
            'typed_pre_click_stop', 'applicant_checked_not_sent',
            'applicant_checked_all_possible_destinations_not_sent', 'employer_rejected_not_filed',
            'employer_verification_pending_not_filed', 'provider_definitive_rejection',
            'extension_cancelled_before_press'
          ))
          or (event_kind <> 'not_sent_proven' and proof_kind is null)
        ),
        add constraint submission_attempt_events_boundary_auth_check check (
          (event_kind = 'boundary_authorized'
            and boundary_activation_id is not null
            and boundary_expires_at is not null
            and boundary_expires_at > observed_at
            and boundary_expires_at <= observed_at + interval '5 minutes')
          or (event_kind <> 'boundary_authorized'
            and boundary_activation_id is null
            and boundary_expires_at is null)
        ),
        add constraint application_submission_attempt_events_parent_check check (
          parent_attempt_id is null or parent_attempt_id <> attempt_id
        )
    `);
    await client.query(`
      create unique index if not exists application_submission_attempt_events_user_event_unique
      on application_submission_attempt_events(user_id, event_id)
    `);
    await client.query(`
      create index if not exists application_submission_attempt_events_user_attempt_time_idx
      on application_submission_attempt_events(user_id, attempt_id, created_at)
    `);
    await client.query(`
      create unique index if not exists submission_attempt_events_user_attempt_boundary_uq
      on application_submission_attempt_events (user_id, attempt_id)
      where event_kind = 'boundary_authorized'
    `);
    await client.query(`
      create index if not exists application_submission_attempt_events_packet_time_idx
      on application_submission_attempt_events(packet_id, created_at)
    `);
    await client.query(`
      create index if not exists application_submission_attempt_events_user_posting_idx
      on application_submission_attempt_events(user_id, posting_key)
    `);
    await client.query(`
      create index if not exists application_submission_attempt_events_user_job_idx
      on application_submission_attempt_events(user_id, job_id)
    `);
    await client.query(`
      create index if not exists application_submission_attempt_events_user_company_role_idx
      on application_submission_attempt_events(user_id, company_role)
    `);
    await client.query(`
      create or replace function reject_submission_attempt_event_update()
      returns trigger language plpgsql as $$
      begin
        raise exception 'application submission attempt events are append-only' using errcode = '55000';
      end
      $$
    `);
    await client.query(`
      drop trigger if exists application_submission_attempt_events_no_update
      on application_submission_attempt_events
    `);
    await client.query(`
      create trigger application_submission_attempt_events_no_update
      before update on application_submission_attempt_events
      for each row execute function reject_submission_attempt_event_update()
    `);
    await client.query(`
      create or replace function reject_submission_attempt_event_direct_delete()
      returns trigger language plpgsql as $$
      begin
        if exists (select 1 from users where id = old.user_id) then
          raise exception 'application submission attempt events may only be deleted by account privacy erasure'
            using errcode = '55000';
        end if;
        return old;
      end
      $$
    `);
    await client.query(`
      drop trigger if exists application_submission_attempt_events_no_direct_delete
      on application_submission_attempt_events
    `);
    await client.query(`
      create trigger application_submission_attempt_events_no_direct_delete
      before delete on application_submission_attempt_events
      for each row execute function reject_submission_attempt_event_direct_delete()
    `);
    await client.query(`
      create or replace function reject_submission_attempt_binding_update()
      returns trigger language plpgsql as $$
      begin
        if row(
          old.user_id, old.attempt_id, old.application_id, old.packet_id, old.parent_attempt_id,
          old.source, old.operation, old.submission_run_id, old.submission_claim_id,
          old.packet_version, old.posting_key, old.job_id, old.company_role, old.company_name,
          old.role, old.portal_url, old.portal_identity, old.created_at
        ) is distinct from row(
          new.user_id, new.attempt_id, new.application_id, new.packet_id, new.parent_attempt_id,
          new.source, new.operation, new.submission_run_id, new.submission_claim_id,
          new.packet_version, new.posting_key, new.job_id, new.company_role, new.company_name,
          new.role, new.portal_url, new.portal_identity, new.created_at
        ) then
          raise exception 'application submission attempt bindings are immutable' using errcode = '55000';
        end if;
        return old;
      end
      $$
    `);
    await client.query(`
      drop trigger if exists application_submission_attempt_bindings_no_update
      on application_submission_attempt_bindings
    `);
    await client.query(`
      create trigger application_submission_attempt_bindings_no_update
      before update on application_submission_attempt_bindings
      for each row execute function reject_submission_attempt_binding_update()
    `);
    await client.query(`
      create or replace function reject_submission_attempt_binding_direct_delete()
      returns trigger language plpgsql as $$
      begin
        if exists (select 1 from users where id = old.user_id) then
          raise exception 'application submission attempt bindings may only be deleted by account privacy erasure'
            using errcode = '55000';
        end if;
        return old;
      end
      $$
    `);
    await client.query(`
      drop trigger if exists application_submission_attempt_bindings_no_direct_delete
      on application_submission_attempt_bindings
    `);
    await client.query(`
      create trigger application_submission_attempt_bindings_no_direct_delete
      before delete on application_submission_attempt_bindings
      for each row execute function reject_submission_attempt_binding_direct_delete()
    `);
    await client.query(`
      create table if not exists application_posting_distinctions (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        relation_id uuid not null,
        prior_attempt_id uuid not null,
        candidate_application_id uuid not null,
        candidate_packet_id uuid not null,
        candidate_identity_version text not null,
        candidate_identity_digest text not null,
        candidate_identity_snapshot jsonb not null,
        candidate_posting_key text,
        candidate_job_id text,
        candidate_company_role text,
        candidate_portal_url text not null,
        proof_kind text not null,
        observed_at timestamptz not null default now(),
        created_at timestamptz not null default now(),
        constraint application_posting_distinctions_prior_attempt_fk
          foreign key (user_id, prior_attempt_id)
          references application_submission_attempt_bindings(user_id, attempt_id)
          on delete cascade,
        constraint application_posting_distinctions_identity_version_check check (
          candidate_identity_version = 'posting-distinction-candidate-v1'
        ),
        constraint application_posting_distinctions_identity_digest_check check (
          candidate_identity_digest ~ '^[0-9a-f]{64}$'
        ),
        constraint application_posting_distinctions_portal_url_check check (
          candidate_portal_url like 'https://%'
        ),
        constraint application_posting_distinctions_proof_kind_check check (
          proof_kind = 'applicant_confirmed_distinct_posting_pair'
        )
      )
    `);
    await client.query(`
      alter table application_posting_distinctions
        drop constraint if exists application_posting_distinctions_prior_attempt_fk,
        drop constraint if exists application_posting_distinctions_identity_version_check,
        drop constraint if exists application_posting_distinctions_identity_digest_check,
        drop constraint if exists application_posting_distinctions_portal_url_check,
        drop constraint if exists application_posting_distinctions_proof_kind_check
    `);
    await client.query(`
      alter table application_posting_distinctions
        add constraint application_posting_distinctions_prior_attempt_fk
          foreign key (user_id, prior_attempt_id)
          references application_submission_attempt_bindings(user_id, attempt_id)
          on delete cascade,
        add constraint application_posting_distinctions_identity_version_check check (
          candidate_identity_version = 'posting-distinction-candidate-v1'
        ),
        add constraint application_posting_distinctions_identity_digest_check check (
          candidate_identity_digest ~ '^[0-9a-f]{64}$'
        ),
        add constraint application_posting_distinctions_portal_url_check check (
          candidate_portal_url like 'https://%'
        ),
        add constraint application_posting_distinctions_proof_kind_check check (
          proof_kind = 'applicant_confirmed_distinct_posting_pair'
        )
    `);
    await client.query(`
      create unique index if not exists application_posting_distinctions_user_relation_unique
      on application_posting_distinctions(user_id, relation_id)
    `);
    await client.query(`
      create unique index if not exists application_posting_distinctions_pair_identity_unique
      on application_posting_distinctions(
        user_id, prior_attempt_id, candidate_application_id, candidate_packet_id,
        candidate_identity_version, candidate_identity_digest
      )
    `);
    await client.query(`
      create index if not exists application_posting_distinctions_candidate_lookup_idx
      on application_posting_distinctions(
        user_id, candidate_application_id, candidate_packet_id,
        candidate_identity_version, candidate_identity_digest
      )
    `);
    await client.query(`
      create index if not exists application_posting_distinctions_prior_attempt_idx
      on application_posting_distinctions(user_id, prior_attempt_id)
    `);
    await client.query(`
      create or replace function reject_application_posting_distinction_update()
      returns trigger language plpgsql as $$
      begin
        raise exception 'application posting distinctions are append-only' using errcode = '55000';
      end
      $$
    `);
    await client.query(`
      drop trigger if exists application_posting_distinctions_no_update
      on application_posting_distinctions
    `);
    await client.query(`
      create trigger application_posting_distinctions_no_update
      before update on application_posting_distinctions
      for each row execute function reject_application_posting_distinction_update()
    `);
    await client.query(`
      create or replace function reject_application_posting_distinction_direct_delete()
      returns trigger language plpgsql as $$
      begin
        if exists (select 1 from users where id = old.user_id) then
          raise exception 'application posting distinctions may only be deleted by account privacy erasure'
            using errcode = '55000';
        end if;
        return old;
      end
      $$
    `);
    await client.query(`
      drop trigger if exists application_posting_distinctions_no_direct_delete
      on application_posting_distinctions
    `);
    await client.query(`
      create trigger application_posting_distinctions_no_direct_delete
      before delete on application_posting_distinctions
      for each row execute function reject_application_posting_distinction_direct_delete()
    `);
    const cutoverState = await client.query(`
      select
        exists (
          select 1 from application_submission_attempt_ledger_cutovers
          where cutover_key = $1
        ) as marker_present,
        exists (select 1 from application_submission_attempt_events) as events_present
    `, [LEGACY_BACKFILL_MARKER]);
    const markerPresent = cutoverState.rows[0]?.marker_present === true;
    const eventsPresent = cutoverState.rows[0]?.events_present === true;
    if (!markerPresent && eventsPresent) {
      throw new Error(
        'Submission attempt ledger contains events without the immutable legacy backfill cutover marker',
      );
    }
    const shouldRunLegacyBackfill = !markerPresent;
    const existingBindingConflict = await client.query(`
      select first.user_id, first.attempt_id
      from application_submission_attempt_events first
      inner join application_submission_attempt_events second
        on second.user_id = first.user_id
        and second.attempt_id = first.attempt_id
        and second.id <> first.id
      where row(
        first.packet_id, first.application_id, first.parent_attempt_id,
        first.source, first.operation, first.submission_run_id,
        first.submission_claim_id, first.packet_version, first.posting_key,
        first.job_id, first.company_role, first.company_name, first.role,
        first.portal_url, first.portal_identity
      ) is distinct from row(
        second.packet_id, second.application_id, second.parent_attempt_id,
        second.source, second.operation, second.submission_run_id,
        second.submission_claim_id, second.packet_version, second.posting_key,
        second.job_id, second.company_role, second.company_name, second.role,
        second.portal_url, second.portal_identity
      )
      limit 1
    `);
    if (existingBindingConflict.rows[0]) {
      throw new Error(`Existing submission attempt has conflicting immutable bindings: ${existingBindingConflict.rows[0].attempt_id}`);
    }
    await client.query(`
      insert into application_submission_attempt_bindings (
        user_id, attempt_id, application_id, packet_id, parent_attempt_id,
        source, operation, submission_run_id, submission_claim_id, packet_version,
        posting_key, job_id, company_role, company_name, role, portal_url, portal_identity,
        created_at
      )
      select distinct on (event.user_id, event.attempt_id)
        event.user_id, event.attempt_id, event.application_id, event.packet_id, event.parent_attempt_id,
        event.source, event.operation, event.submission_run_id, event.submission_claim_id,
        event.packet_version, event.posting_key, event.job_id, event.company_role,
        event.company_name, event.role, event.portal_url, event.portal_identity, event.created_at
      from application_submission_attempt_events event
      order by event.user_id, event.attempt_id, event.created_at, event.id
      on conflict (user_id, attempt_id) do nothing
    `);
    const registryMismatch = await client.query(`
      select event.user_id, event.attempt_id
      from application_submission_attempt_events event
      inner join application_submission_attempt_bindings binding
        on binding.user_id = event.user_id and binding.attempt_id = event.attempt_id
      where row(
        event.packet_id, event.application_id, event.parent_attempt_id,
        event.source, event.operation, event.submission_run_id,
        event.submission_claim_id, event.packet_version, event.posting_key,
        event.job_id, event.company_role, event.company_name, event.role,
        event.portal_url, event.portal_identity
      ) is distinct from row(
        binding.packet_id, binding.application_id, binding.parent_attempt_id,
        binding.source, binding.operation, binding.submission_run_id,
        binding.submission_claim_id, binding.packet_version, binding.posting_key,
        binding.job_id, binding.company_role, binding.company_name, binding.role,
        binding.portal_url, binding.portal_identity
      )
      limit 1
    `);
    if (registryMismatch.rows[0]) {
      throw new Error(`Submission attempt binding registry mismatch: ${registryMismatch.rows[0].attempt_id}`);
    }
    await client.query(`
      create or replace function reject_submission_attempt_binding_change()
      returns trigger language plpgsql as $$
      declare registered_attempt_id uuid;
      begin
        if (new.source <> 'legacy_backfill' or new.event_kind = 'boundary_authorized') and not exists (
          select 1 from application_submission_attempt_ledger_cutovers
          where cutover_key = '${LEGACY_BACKFILL_MARKER}'
        ) then
          raise exception 'submission attempt ledger cutover marker is missing; employer boundary is closed'
            using errcode = '55000';
        end if;
        insert into application_submission_attempt_bindings (
          user_id, attempt_id, application_id, packet_id, parent_attempt_id,
          source, operation, submission_run_id, submission_claim_id, packet_version,
          posting_key, job_id, company_role, company_name, role, portal_url, portal_identity
        ) values (
          new.user_id, new.attempt_id, new.application_id, new.packet_id, new.parent_attempt_id,
          new.source, new.operation, new.submission_run_id, new.submission_claim_id,
          new.packet_version, new.posting_key, new.job_id, new.company_role,
          new.company_name, new.role, new.portal_url, new.portal_identity
        )
        on conflict (user_id, attempt_id) do update
          set attempt_id = excluded.attempt_id
          where row(
            application_submission_attempt_bindings.packet_id,
            application_submission_attempt_bindings.application_id,
            application_submission_attempt_bindings.parent_attempt_id,
            application_submission_attempt_bindings.source,
            application_submission_attempt_bindings.operation,
            application_submission_attempt_bindings.submission_run_id,
            application_submission_attempt_bindings.submission_claim_id,
            application_submission_attempt_bindings.packet_version,
            application_submission_attempt_bindings.posting_key,
            application_submission_attempt_bindings.job_id,
            application_submission_attempt_bindings.company_role,
            application_submission_attempt_bindings.company_name,
            application_submission_attempt_bindings.role,
            application_submission_attempt_bindings.portal_url,
            application_submission_attempt_bindings.portal_identity
          ) is not distinct from row(
            excluded.packet_id, excluded.application_id, excluded.parent_attempt_id,
            excluded.source, excluded.operation, excluded.submission_run_id,
            excluded.submission_claim_id, excluded.packet_version, excluded.posting_key,
            excluded.job_id, excluded.company_role, excluded.company_name, excluded.role,
            excluded.portal_url, excluded.portal_identity
          )
        returning attempt_id into registered_attempt_id;
        if registered_attempt_id is null then
          raise exception 'submission attempt binding conflict for attempt %', new.attempt_id
            using errcode = '23514';
        end if;
        return new;
      end
      $$
    `);
    await client.query(`
      drop trigger if exists application_submission_attempt_events_one_binding
      on application_submission_attempt_events
    `);
    await client.query(`
      create trigger application_submission_attempt_events_one_binding
      before insert on application_submission_attempt_events
      for each row execute function reject_submission_attempt_binding_change()
    `);

    if (shouldRunLegacyBackfill) {
      /* PostgreSQL's timestamptz cast aborts a whole migration on one malformed legacy string. This
         session-local parser preserves the evidence row while falling back to the packet timestamp. */
      await client.query(`
      create or replace function pg_temp.submission_attempt_safe_time(value text, fallback timestamptz)
      returns timestamptz language plpgsql stable as $$
      begin
        if value is null or btrim(value) = '' then return fallback; end if;
        return value::timestamptz;
      exception when others then
        return fallback;
      end
      $$
    `);

    /* One frozen candidate per current packet attempt. The state precedence is intentionally
       conservative: a receipt or submitted marker wins, an applicant's exact not-sent resolution
       comes next, unresolved employer risk comes next, and typed pre-click proof is accepted only
       when none of those contradictory risk facts remains on the snapshot. */
      await client.query(`
      create temporary table submission_attempt_legacy_backfill_candidates on commit drop as
      with snapshots as (
        select
          resume.id as packet_id,
          resume.user_id,
          resume.job_context,
          resume.pipeline_stage,
          resume.created_at,
          case
            when jsonb_typeof(resume.spec->'_review') = 'object' then resume.spec->'_review'
            else '{}'::jsonb
          end as review
        from generated_resumes resume
      ), evidence as (
        select
          snapshot.*,
          snapshot.review->'unverified_submission' as unverified,
          snapshot.review->'submission_stop' as submission_stop,
          snapshot.review->'security_code' as security_code,
          nullif(btrim(snapshot.review->>'portal_url'), '') as portal_url,
          nullif(btrim(snapshot.review->>'submission_run_id'), '') as current_submission_run_id,
          nullif(btrim(snapshot.review->>'submission_claim_id'), '') as submission_claim_id,
          nullif(btrim(snapshot.review->>'submission_claimed_at'), '') as submission_claimed_at,
          nullif(btrim(snapshot.review->>'submission_attempted_at'), '') as submission_attempted_at,
          nullif(btrim(snapshot.review->>'submitted_at'), '') as submitted_at,
          coalesce(nullif(btrim(snapshot.job_context->>'company'), ''), '') as company_name,
          coalesce(
            nullif(btrim(snapshot.job_context->>'role'), ''),
            nullif(btrim(snapshot.review->>'role'), ''),
            ''
          ) as role,
          nullif(lower(btrim(snapshot.job_context->>'job_id')), '') as job_id,
          nullif(btrim(snapshot.review#>>'{packet_audit,packet_version}'), '') as audit_packet_version,
          nullif(btrim(snapshot.review->>'submission_packet_version'), '') as submission_packet_version,
          (
            snapshot.review->>'status' = 'submitted'
            or snapshot.pipeline_stage = 'applied'
            or nullif(btrim(snapshot.review->>'submitted_at'), '') is not null
            or jsonb_typeof(snapshot.review->'receipt') = 'object'
            or snapshot.review#>>'{unverified_submission,resolution}' = 'sent'
          ) as confirmed_present,
          (
            jsonb_typeof(snapshot.review->'unverified_submission') = 'object'
            and snapshot.review#>>'{unverified_submission,resolution}' is null
          ) as unresolved_unverified_present,
          (
            jsonb_typeof(snapshot.review->'unverified_submission') = 'object'
            and snapshot.review#>>'{unverified_submission,resolution}' = 'not_sent'
          ) as resolved_not_sent_present,
          (
            jsonb_typeof(snapshot.review->'security_code') = 'object'
            or snapshot.review->>'status' = 'awaiting_security_code'
          ) as security_present,
          snapshot.review#>>'{submission_stop,before_click}' = 'true' as typed_pre_click_present
        from snapshots snapshot
      ), classified as (
        select
          evidence.*,
          case
            when confirmed_present then 'confirmed'
            when resolved_not_sent_present then 'resolved_not_sent'
            when unresolved_unverified_present
              or submission_attempted_at is not null
              or security_present
              or submission_claimed_at is not null
              or submission_claim_id is not null
              or review->>'status' in ('submitting', 'submission_claimed')
              then 'unresolved_risk'
            when typed_pre_click_present then 'typed_pre_click_stop'
            else null
          end as evidence_state,
          coalesce(
            nullif(btrim(evidence.unverified->>'submission_run_id'), ''),
            nullif(btrim(evidence.submission_stop->>'submission_run_id'), ''),
            evidence.current_submission_run_id,
            evidence.submission_claim_id,
            nullif(btrim(evidence.unverified->>'at'), ''),
            evidence.submission_attempted_at,
            nullif(btrim(evidence.security_code->>'requested_at'), ''),
            nullif(btrim(evidence.submission_stop->>'at'), ''),
            'current'
          ) as attempt_source_key,
          coalesce(
            nullif(btrim(evidence.unverified->>'submission_run_id'), ''),
            evidence.current_submission_run_id
          ) as frozen_submission_run_id,
          (
            evidence.unresolved_unverified_present
            or evidence.submission_attempted_at is not null
            or evidence.security_present
            or evidence.submission_claimed_at is not null
            or evidence.submission_claim_id is not null
            or evidence.review->>'status' in ('submitting', 'submission_claimed')
          ) as press_present,
          pg_temp.submission_attempt_safe_time(
            coalesce(
              evidence.submission_claimed_at,
              nullif(btrim(evidence.unverified->>'at'), ''),
              evidence.submission_attempted_at,
              nullif(btrim(evidence.security_code->>'requested_at'), ''),
              nullif(btrim(evidence.submission_stop->>'at'), ''),
              evidence.submitted_at,
              nullif(btrim(evidence.review#>>'{receipt,captured_at}'), ''),
              nullif(btrim(evidence.review->>'updated_at'), '')
            ),
            coalesce(evidence.created_at, transaction_timestamp())
          ) as opened_at,
          pg_temp.submission_attempt_safe_time(
            coalesce(
              nullif(btrim(evidence.unverified->>'at'), ''),
              evidence.submission_attempted_at,
              nullif(btrim(evidence.security_code->>'requested_at'), ''),
              evidence.submission_claimed_at
            ),
            coalesce(evidence.created_at, transaction_timestamp())
          ) as pressed_at,
          pg_temp.submission_attempt_safe_time(
            coalesce(
              nullif(btrim(evidence.review#>>'{receipt,captured_at}'), ''),
              evidence.submitted_at,
              nullif(btrim(evidence.unverified->>'resolved_at'), ''),
              nullif(btrim(evidence.unverified->>'at'), ''),
              nullif(btrim(evidence.submission_stop->>'at'), ''),
              nullif(btrim(evidence.review->>'updated_at'), '')
            ),
            coalesce(evidence.created_at, transaction_timestamp())
          ) as outcome_at
        from evidence
      ), identified as (
        select
          classified.*,
          md5(
            'litos:legacy-attempt:v1:' || classified.user_id::text || ':'
            || classified.packet_id::text || ':' || classified.attempt_source_key
          )::uuid as attempt_id,
          nullif(
            btrim(regexp_replace(lower(classified.company_name), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_company,
          nullif(
            btrim(regexp_replace(lower(classified.role), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_role
        from classified
        where classified.evidence_state is not null
      )
      select
        identified.user_id,
        identified.packet_id,
        identified.attempt_id,
        identified.evidence_state,
        identified.press_present,
        identified.frozen_submission_run_id as submission_run_id,
        identified.submission_claim_id,
        coalesce(identified.audit_packet_version, identified.submission_packet_version) as packet_version,
        null::text as posting_key,
        identified.job_id,
        case
          when identified.normalized_company is not null and identified.normalized_role is not null
            then identified.normalized_company || '|' || identified.normalized_role
          else null
        end as company_role,
        identified.company_name,
        identified.role,
        identified.portal_url,
        substring(lower(identified.portal_url) from '^(https?://[^/?#]+)') as portal_identity,
        identified.opened_at,
        identified.pressed_at,
        identified.outcome_at
      from identified
    `);

      await client.query(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        submission_run_id, submission_claim_id, packet_version,
        posting_key, job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at
      )
      select
        candidate.user_id,
        candidate.packet_id,
        md5(
          'litos:legacy-event:v1:' || candidate.user_id::text || ':'
          || candidate.attempt_id::text || ':attempt_opened'
        )::uuid,
        candidate.attempt_id,
        'attempt_opened',
        'legacy_backfill',
        'initial_submission',
        candidate.submission_run_id,
        candidate.submission_claim_id,
        candidate.packet_version,
        candidate.posting_key,
        candidate.job_id,
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        candidate.portal_url,
        candidate.portal_identity,
        'legacy_current_' || candidate.evidence_state,
        candidate.opened_at
      from submission_attempt_legacy_backfill_candidates candidate
      on conflict (user_id, event_id) do nothing
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        submission_run_id, submission_claim_id, packet_version,
        posting_key, job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at
      )
      select
        candidate.user_id,
        candidate.packet_id,
        md5(
          'litos:legacy-event:v1:' || candidate.user_id::text || ':'
          || candidate.attempt_id::text || ':press_observed'
        )::uuid,
        candidate.attempt_id,
        'press_observed',
        'legacy_backfill',
        'initial_submission',
        candidate.submission_run_id,
        candidate.submission_claim_id,
        candidate.packet_version,
        candidate.posting_key,
        candidate.job_id,
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        candidate.portal_url,
        candidate.portal_identity,
        'legacy_current_press_evidence',
        candidate.pressed_at
      from submission_attempt_legacy_backfill_candidates candidate
      where candidate.evidence_state = 'unresolved_risk'
        and candidate.press_present
      on conflict (user_id, event_id) do nothing
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        submission_run_id, submission_claim_id, packet_version,
        posting_key, job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at
      )
      select
        candidate.user_id,
        candidate.packet_id,
        md5(
          'litos:legacy-event:v1:' || candidate.user_id::text || ':'
          || candidate.attempt_id::text || ':submission_confirmed'
        )::uuid,
        candidate.attempt_id,
        'submission_confirmed',
        'legacy_backfill',
        'initial_submission',
        candidate.submission_run_id,
        candidate.submission_claim_id,
        candidate.packet_version,
        candidate.posting_key,
        candidate.job_id,
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        candidate.portal_url,
        candidate.portal_identity,
        'legacy_current_confirmation',
        candidate.outcome_at
      from submission_attempt_legacy_backfill_candidates candidate
      where candidate.evidence_state = 'confirmed'
      on conflict (user_id, event_id) do nothing
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        submission_run_id, submission_claim_id, packet_version,
        posting_key, job_id, company_role, company_name, role, portal_url, portal_identity,
        proof_kind, evidence_code, observed_at
      )
      select
        candidate.user_id,
        candidate.packet_id,
        md5(
          'litos:legacy-event:v1:' || candidate.user_id::text || ':'
          || candidate.attempt_id::text || ':not_sent_proven'
        )::uuid,
        candidate.attempt_id,
        'not_sent_proven',
        'legacy_backfill',
        'initial_submission',
        candidate.submission_run_id,
        candidate.submission_claim_id,
        candidate.packet_version,
        candidate.posting_key,
        candidate.job_id,
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        candidate.portal_url,
        candidate.portal_identity,
        case
          when candidate.evidence_state = 'resolved_not_sent' then 'applicant_checked_not_sent'
          else 'typed_pre_click_stop'
        end,
        case
          when candidate.evidence_state = 'resolved_not_sent' then 'legacy_applicant_not_sent_resolution'
          else 'legacy_typed_pre_click_stop'
        end,
        candidate.outcome_at
      from submission_attempt_legacy_backfill_candidates candidate
      where candidate.evidence_state in ('resolved_not_sent', 'typed_pre_click_stop')
      on conflict (user_id, event_id) do nothing
    `);

    /* Older generated-resume routes could return a packet that an extension used to click Submit
       before any review metadata, portal URL, run, or claim was persisted. A later mutable status
       cannot prove that an already returned capability was never used. Preserve one distinct,
       opening-only attempt for every generated row that is not positively terminal. It
       intentionally shares no run or claim identity with the current-snapshot attempt above, so a
       safe result for one cannot release the other. */
    await client.query(`
      create temporary table submission_attempt_legacy_generated_capabilities on commit drop as
      with snapshots as (
        select
          resume.id as packet_id,
          resume.user_id,
          resume.job_context,
          resume.spec,
          resume.pipeline_stage,
          case
            when jsonb_typeof(resume.spec->'_review') = 'object' then resume.spec->'_review'
            else '{}'::jsonb
          end as review
        from generated_resumes resume
      ), candidates as (
        select
          snapshot.user_id,
          linked_application.id as application_id,
          snapshot.packet_id,
          md5(
            'litos:legacy-unrecorded-capability:v1:generated:'
            || snapshot.user_id::text || ':' || snapshot.packet_id::text
          )::uuid as attempt_id,
          coalesce(nullif(btrim(snapshot.job_context->>'company'), ''), '') as company_name,
          coalesce(
            nullif(btrim(snapshot.job_context->>'role'), ''),
            nullif(btrim(snapshot.review->>'role'), ''),
            ''
          ) as role,
          nullif(lower(btrim(snapshot.job_context->>'job_id')), '') as job_id,
          coalesce(
            nullif(btrim(snapshot.review->>'portal_url'), ''),
            nullif(btrim(snapshot.review->>'extension_handoff_url'), '')
          ) as portal_url
        from snapshots snapshot
        left join applications linked_application
          on linked_application.user_id = snapshot.user_id
          and linked_application.legacy_generated_resume_id = snapshot.packet_id
        where not (
            coalesce(snapshot.review->>'status' = 'submitted', false)
            or coalesce(snapshot.pipeline_stage = 'applied', false)
            or nullif(btrim(snapshot.review->>'submitted_at'), '') is not null
            or coalesce(jsonb_typeof(snapshot.review->'receipt') = 'object', false)
            or coalesce(snapshot.review#>>'{unverified_submission,resolution}' = 'sent', false)
          )
      ), normalized as (
        select
          candidate.*,
          nullif(
            btrim(regexp_replace(lower(candidate.company_name), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_company,
          nullif(
            btrim(regexp_replace(lower(candidate.role), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_role
        from candidates candidate
      )
      select
        normalized.*,
        case
          when normalized.normalized_company is not null and normalized.normalized_role is not null
            then normalized.normalized_company || '|' || normalized.normalized_role
          else null
        end as company_role,
        substring(lower(normalized.portal_url) from '^(https?://[^/?#]+)') as portal_identity
      from normalized
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at, created_at
      )
      select
        candidate.user_id,
        candidate.application_id,
        candidate.packet_id,
        md5(
          'litos:legacy-unrecorded-capability-event:v1:generated:'
          || candidate.user_id::text || ':' || candidate.packet_id::text || ':attempt_opened'
        )::uuid,
        candidate.attempt_id,
        'attempt_opened',
        'legacy_backfill',
        'initial_submission',
        candidate.job_id,
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        candidate.portal_url,
        candidate.portal_identity,
        'legacy_possible_unrecorded_generated_capability',
        transaction_timestamp(),
        transaction_timestamp()
      from submission_attempt_legacy_generated_capabilities candidate
      on conflict (user_id, event_id) do nothing
    `);

    /* Canonical applications have their own history outside generated_resumes. Preserve two
       positive sources that the packet snapshot cannot supply:

       1. A terminal canonical application is confirmed even when its linked generated packet has
          no risk evidence. A linked packet that already carries confirmation is not duplicated.
       2. Historical manual outcome rows prove a press. confirmed adds a receipt, while unknown and
          failed remain unresolved because neither proves the employer did not receive the form.

       The canonical application UUID is the synthetic packet key when no legacy packet exists.
       Every posting comparison field is frozen from the canonical row at migration time. */
    await client.query(`
      create temporary table submission_attempt_canonical_backfill_candidates on commit drop as
      with terminal_applications as (
        select
          application.user_id,
          application.id as application_id,
          coalesce(application.legacy_generated_resume_id, application.id) as packet_id,
          md5(
            'litos:canonical-application-attempt:v1:' || application.user_id::text || ':'
            || application.id::text
          )::uuid as attempt_id,
          'canonical_submitted_state'::text as evidence_state,
          false as press_present,
          true as confirmed_present,
          application.company_name,
          application.role,
          application.job_id::text as job_id,
          nullif(btrim(application.portal_url), '') as portal_url,
          substring(lower(nullif(btrim(application.portal_url), '')) from '^(https?://[^/?#]+)')
            as portal_identity,
          coalesce(application.updated_at, application.created_at, transaction_timestamp()) as opened_at,
          null::timestamptz as pressed_at,
          coalesce(application.updated_at, application.created_at, transaction_timestamp()) as outcome_at
        from applications application
        where (application.submission_state = 'submitted' or application.tracker_state = 'applied')
          and not exists (
            select 1
            from application_submission_events manual_event
            where manual_event.application_id = application.id
              and manual_event.outcome = 'confirmed'
          )
          and not exists (
            select 1
            from submission_attempt_legacy_backfill_candidates packet_candidate
            where packet_candidate.user_id = application.user_id
              and packet_candidate.packet_id = application.legacy_generated_resume_id
              and packet_candidate.evidence_state = 'confirmed'
          )
      ), manual_events as (
        select
          manual_event.user_id,
          application.id as application_id,
          coalesce(application.legacy_generated_resume_id, application.id) as packet_id,
          md5(
            'litos:canonical-manual-attempt:v1:' || manual_event.user_id::text || ':'
            || manual_event.event_id::text
          )::uuid as attempt_id,
          ('canonical_manual_' || manual_event.outcome)::text as evidence_state,
          true as press_present,
          manual_event.outcome = 'confirmed' as confirmed_present,
          application.company_name,
          application.role,
          application.job_id::text as job_id,
          coalesce(
            nullif(btrim(application.portal_url), ''),
            nullif(btrim(manual_event.final_url), '')
          ) as portal_url,
          coalesce(
            nullif(lower(btrim(manual_event.portal_identity)), ''),
            substring(lower(nullif(btrim(application.portal_url), '')) from '^(https?://[^/?#]+)')
          ) as portal_identity,
          least(manual_event.created_at, manual_event.observed_at) as opened_at,
          manual_event.observed_at as pressed_at,
          manual_event.observed_at as outcome_at
        from application_submission_events manual_event
        inner join applications application on application.id = manual_event.application_id
        where manual_event.outcome in ('confirmed', 'unknown', 'failed')
      ), candidates as (
        select * from terminal_applications
        union all
        select * from manual_events
      )
      select
        candidate.*,
        case
          when nullif(
            btrim(regexp_replace(lower(candidate.company_name), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) is not null
          and nullif(
            btrim(regexp_replace(lower(candidate.role), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) is not null
          then nullif(
            btrim(regexp_replace(lower(candidate.company_name), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) || '|' || nullif(
            btrim(regexp_replace(lower(candidate.role), '[^a-z0-9]+', ' ', 'g')),
            ''
          )
          else null
        end as company_role
      from candidates candidate
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at, created_at
      )
      select
        candidate.user_id,
        candidate.application_id,
        candidate.packet_id,
        md5(
          'litos:canonical-backfill-event:v1:' || candidate.user_id::text || ':'
          || candidate.attempt_id::text || ':attempt_opened'
        )::uuid,
        candidate.attempt_id,
        'attempt_opened',
        'legacy_backfill',
        'manual_submission',
        candidate.job_id,
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        candidate.portal_url,
        candidate.portal_identity,
        'legacy_' || candidate.evidence_state,
        candidate.opened_at,
        transaction_timestamp()
      from submission_attempt_canonical_backfill_candidates candidate
      on conflict (user_id, event_id) do nothing
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at, created_at
      )
      select
        candidate.user_id,
        candidate.application_id,
        candidate.packet_id,
        md5(
          'litos:canonical-backfill-event:v1:' || candidate.user_id::text || ':'
          || candidate.attempt_id::text || ':press_observed'
        )::uuid,
        candidate.attempt_id,
        'press_observed',
        'legacy_backfill',
        'manual_submission',
        candidate.job_id,
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        candidate.portal_url,
        candidate.portal_identity,
        'legacy_' || candidate.evidence_state || '_press',
        candidate.pressed_at,
        transaction_timestamp() + interval '1 microsecond'
      from submission_attempt_canonical_backfill_candidates candidate
      where candidate.press_present
      on conflict (user_id, event_id) do nothing
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at, created_at
      )
      select
        candidate.user_id,
        candidate.application_id,
        candidate.packet_id,
        md5(
          'litos:canonical-backfill-event:v1:' || candidate.user_id::text || ':'
          || candidate.attempt_id::text || ':submission_confirmed'
        )::uuid,
        candidate.attempt_id,
        'submission_confirmed',
        'legacy_backfill',
        'manual_submission',
        candidate.job_id,
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        candidate.portal_url,
        candidate.portal_identity,
        'legacy_' || candidate.evidence_state || '_confirmation',
        candidate.outcome_at,
        transaction_timestamp() + interval '2 microseconds'
      from submission_attempt_canonical_backfill_candidates candidate
      where candidate.confirmed_present
      on conflict (user_id, event_id) do nothing
    `);

    /* Free fill-data could return a portal handoff and attachment capability from the default
       saved state and wrote no issuance fact. Every nonterminal canonical row with a portal gets a
       separate manual opening. A linked generated packet keeps its own opening too because the two
       routes have different resolution contracts. */
    await client.query(`
      create temporary table submission_attempt_legacy_canonical_capabilities on commit drop as
      with candidates as (
        select
          application.user_id,
          application.id as application_id,
          coalesce(application.legacy_generated_resume_id, application.id) as packet_id,
          md5(
            'litos:legacy-unrecorded-capability:v1:canonical:'
            || application.user_id::text || ':' || application.id::text
          )::uuid as attempt_id,
          application.job_id::text as job_id,
          application.company_name,
          application.role,
          nullif(btrim(application.portal_url), '') as portal_url
        from applications application
        where nullif(btrim(application.portal_url), '') is not null
          and application.submission_state <> 'submitted'
          and application.tracker_state <> 'applied'
          and not exists (
            select 1
            from application_submission_events manual_event
            where manual_event.application_id = application.id
              and manual_event.outcome = 'confirmed'
          )
      ), normalized as (
        select
          candidate.*,
          nullif(
            btrim(regexp_replace(lower(candidate.company_name), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_company,
          nullif(
            btrim(regexp_replace(lower(candidate.role), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_role
        from candidates candidate
      )
      select
        normalized.*,
        case
          when normalized.normalized_company is not null and normalized.normalized_role is not null
            then normalized.normalized_company || '|' || normalized.normalized_role
          else null
        end as company_role,
        substring(lower(normalized.portal_url) from '^(https?://[^/?#]+)') as portal_identity
      from normalized
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at, created_at
      )
      select
        candidate.user_id,
        candidate.application_id,
        candidate.packet_id,
        md5(
          'litos:legacy-unrecorded-capability-event:v1:canonical:'
          || candidate.user_id::text || ':' || candidate.application_id::text || ':attempt_opened'
        )::uuid,
        candidate.attempt_id,
        'attempt_opened',
        'legacy_backfill',
        'manual_submission',
        candidate.job_id,
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        candidate.portal_url,
        candidate.portal_identity,
        'legacy_possible_unrecorded_canonical_fill_capability',
        transaction_timestamp(),
        transaction_timestamp()
      from submission_attempt_legacy_canonical_capabilities candidate
      on conflict (user_id, event_id) do nothing
    `);

    /* Before durable extension reservations existed, auto_submitted=true meant the extension had
       already clicked the employer's Submit control. The telemetry has no packet, application,
       posting URL, receipt, or idempotency key, so freeze only its exact company and role on a
       namespaced orphan packet. A click is press evidence, never confirmation. */
    await client.query(`
      create temporary table submission_attempt_legacy_autofill_presses on commit drop as
      with candidates as (
        select
          autofill_event.id as autofill_event_id,
          autofill_event.user_id,
          md5(
            'litos:legacy-autofill-packet:v1:' || autofill_event.user_id::text
            || ':' || autofill_event.id::text
          )::uuid as packet_id,
          md5(
            'litos:legacy-autofill-auto-submit-attempt:v1:' || autofill_event.user_id::text
            || ':' || autofill_event.id::text
          )::uuid as attempt_id,
          coalesce(nullif(btrim(autofill_event.job_context->>'company'), ''), '') as company_name,
          coalesce(nullif(btrim(autofill_event.job_context->>'role'), ''), '') as role,
          coalesce(autofill_event.created_at, transaction_timestamp()) as observed_at
        from autofill_events autofill_event
        where autofill_event.auto_submitted is true
      ), normalized as (
        select
          candidate.*,
          nullif(
            btrim(regexp_replace(lower(candidate.company_name), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_company,
          nullif(
            btrim(regexp_replace(lower(candidate.role), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_role
        from candidates candidate
      )
      select
        normalized.*,
        case
          when normalized.normalized_company is not null and normalized.normalized_role is not null
            then normalized.normalized_company || '|' || normalized.normalized_role
          else null
        end as company_role
      from normalized
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_role, company_name, role, evidence_code, observed_at, created_at
      )
      select
        candidate.user_id,
        candidate.packet_id,
        md5(
          'litos:legacy-autofill-auto-submit-event:v1:' || candidate.user_id::text
          || ':' || candidate.autofill_event_id::text || ':attempt_opened'
        )::uuid,
        candidate.attempt_id,
        'attempt_opened',
        'legacy_backfill',
        'initial_submission',
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        'legacy_autofill_auto_submit_report',
        candidate.observed_at,
        transaction_timestamp()
      from submission_attempt_legacy_autofill_presses candidate
      on conflict (user_id, event_id) do nothing
    `);

    await client.query(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_role, company_name, role, evidence_code, observed_at, created_at
      )
      select
        candidate.user_id,
        candidate.packet_id,
        md5(
          'litos:legacy-autofill-auto-submit-event:v1:' || candidate.user_id::text
          || ':' || candidate.autofill_event_id::text || ':press_observed'
        )::uuid,
        candidate.attempt_id,
        'press_observed',
        'legacy_backfill',
        'initial_submission',
        candidate.company_role,
        candidate.company_name,
        candidate.role,
        'legacy_autofill_auto_submit_click',
        candidate.observed_at,
        transaction_timestamp() + interval '1 microsecond'
      from submission_attempt_legacy_autofill_presses candidate
      on conflict (user_id, event_id) do nothing
    `);

    /* Exact operational hold for evidence that survives only in the owner handoff, not in the live
       mutable snapshot. The 2026-08-20 session log says Max Borges Workable was pressed and never
       confirmed, with an explicit do-not-rerun instruction. It records no clock time for this packet,
       so observed_at deliberately uses midnight UTC as day-granularity rather than inventing a time.
       The current packet may now show a newer typed pre-click stop; this distinct older attempt must
       remain unresolved so that safe retry cannot erase the prior press. If the packet is absent, the
       SELECT inserts nothing. */
    await client.query(`
      create temporary table submission_attempt_operational_hold_max_borges on commit drop as
      with packet as (
        select
          resume.id as packet_id,
          resume.user_id,
          resume.job_context,
          case
            when jsonb_typeof(resume.spec->'_review') = 'object' then resume.spec->'_review'
            else '{}'::jsonb
          end as review
        from generated_resumes resume
        where resume.id = 'c43b9eeb-c1f3-4fd9-b9ba-d74e4dd0ad30'::uuid
      ), frozen as (
        select
          packet.*,
          coalesce(nullif(btrim(packet.job_context->>'company'), ''), '') as company_name,
          coalesce(
            nullif(btrim(packet.job_context->>'role'), ''),
            nullif(btrim(packet.review->>'role'), ''),
            ''
          ) as role,
          nullif(lower(btrim(packet.job_context->>'job_id')), '') as job_id,
          nullif(btrim(packet.review->>'portal_url'), '') as portal_url,
          nullif(
            btrim(regexp_replace(lower(coalesce(packet.job_context->>'company', '')), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_company,
          nullif(
            btrim(regexp_replace(lower(coalesce(packet.job_context->>'role', packet.review->>'role', '')), '[^a-z0-9]+', ' ', 'g')),
            ''
          ) as normalized_role
        from packet
      )
      select
        frozen.user_id,
        frozen.packet_id,
        md5(
          'litos:operational-hold:v1:' || frozen.packet_id::text
          || ':vault_pressed_unverified_2026_08_20'
        )::uuid as attempt_id,
        frozen.job_id,
        case
          when frozen.normalized_company is not null and frozen.normalized_role is not null
            then frozen.normalized_company || '|' || frozen.normalized_role
          else null
        end as company_role,
        frozen.company_name,
        frozen.role,
        frozen.portal_url,
        substring(lower(frozen.portal_url) from '^(https?://[^/?#]+)') as portal_identity,
        nullif(btrim(frozen.review#>>'{packet_audit,packet_version}'), '') as packet_version,
        '2026-08-20T00:00:00Z'::timestamptz as observed_at
      from frozen
    `);
    await client.query(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        packet_version, job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at
      )
      select
        hold.user_id,
        hold.packet_id,
        md5(
          'litos:operational-hold-event:v1:' || hold.attempt_id::text || ':attempt_opened'
        )::uuid,
        hold.attempt_id,
        'attempt_opened',
        'legacy_backfill',
        'initial_submission',
        hold.packet_version,
        hold.job_id,
        hold.company_role,
        hold.company_name,
        hold.role,
        hold.portal_url,
        hold.portal_identity,
        'vault_pressed_unverified_2026_08_20',
        hold.observed_at
      from submission_attempt_operational_hold_max_borges hold
      on conflict (user_id, event_id) do nothing
    `);
    await client.query(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        packet_version, job_id, company_role, company_name, role, portal_url, portal_identity,
        evidence_code, observed_at
      )
      select
        hold.user_id,
        hold.packet_id,
        md5(
          'litos:operational-hold-event:v1:' || hold.attempt_id::text || ':press_observed'
        )::uuid,
        hold.attempt_id,
        'press_observed',
        'legacy_backfill',
        'initial_submission',
        hold.packet_version,
        hold.job_id,
        hold.company_role,
        hold.company_name,
        hold.role,
        hold.portal_url,
        hold.portal_identity,
        'vault_pressed_unverified_2026_08_20',
        hold.observed_at
      from submission_attempt_operational_hold_max_borges hold
      on conflict (user_id, event_id) do nothing
    `);
      await client.query(`
        insert into application_submission_attempt_ledger_cutovers (cutover_key)
        values ($1)
      `, [LEGACY_BACKFILL_MARKER]);
    }
    await client.query('commit');

    const columns = await client.query(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_events'
    `);
    const presentColumns = new Set(columns.rows.map((row) => row.column_name));
    const missingColumns = REQUIRED_COLUMNS.filter((column) => !presentColumns.has(column));
    if (missingColumns.length > 0) {
      throw new Error(`Submission attempt ledger columns still missing: ${missingColumns.join(', ')}`);
    }

    const bindingColumns = await client.query(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_bindings'
    `);
    const presentBindingColumns = new Set(bindingColumns.rows.map((row) => row.column_name));
    const missingBindingColumns = REQUIRED_BINDING_COLUMNS.filter((column) => !presentBindingColumns.has(column));
    if (missingBindingColumns.length > 0) {
      throw new Error(`Submission attempt binding columns still missing: ${missingBindingColumns.join(', ')}`);
    }

    const distinctionColumns = await client.query(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_posting_distinctions'
    `);
    const presentDistinctionColumns = new Set(distinctionColumns.rows.map((row) => row.column_name));
    const missingDistinctionColumns = REQUIRED_DISTINCTION_COLUMNS
      .filter((column) => !presentDistinctionColumns.has(column));
    if (missingDistinctionColumns.length > 0) {
      throw new Error(`Posting distinction columns still missing: ${missingDistinctionColumns.join(', ')}`);
    }

    const indexes = await client.query(`
      select indexname from pg_indexes
      where schemaname = current_schema()
        and tablename = 'application_submission_attempt_events'
    `);
    const presentIndexes = new Set(indexes.rows.map((row) => row.indexname));
    const missingIndexes = REQUIRED_INDEXES.filter((index) => !presentIndexes.has(index));
    if (missingIndexes.length > 0) {
      throw new Error(`Submission attempt ledger indexes still missing: ${missingIndexes.join(', ')}`);
    }

    const distinctionIndexes = await client.query(`
      select indexname from pg_indexes
      where schemaname = current_schema()
        and tablename = 'application_posting_distinctions'
    `);
    const presentDistinctionIndexes = new Set(distinctionIndexes.rows.map((row) => row.indexname));
    const missingDistinctionIndexes = REQUIRED_DISTINCTION_INDEXES
      .filter((index) => !presentDistinctionIndexes.has(index));
    if (missingDistinctionIndexes.length > 0) {
      throw new Error(`Posting distinction indexes still missing: ${missingDistinctionIndexes.join(', ')}`);
    }

    const constraints = await client.query(`
      select constraint_name from information_schema.table_constraints
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_events'
    `);
    const presentConstraints = new Set(constraints.rows.map((row) => row.constraint_name));
    const missingConstraints = REQUIRED_CONSTRAINTS.filter((constraint) => !presentConstraints.has(constraint));
    if (missingConstraints.length > 0) {
      throw new Error(`Submission attempt ledger constraints still missing: ${missingConstraints.join(', ')}`);
    }

    const bindingConstraints = await client.query(`
      select constraint_name from information_schema.table_constraints
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_bindings'
    `);
    const presentBindingConstraints = new Set(bindingConstraints.rows.map((row) => row.constraint_name));
    const missingBindingConstraints = REQUIRED_BINDING_CONSTRAINTS
      .filter((constraint) => !presentBindingConstraints.has(constraint));
    if (missingBindingConstraints.length > 0) {
      throw new Error(`Submission attempt binding constraints still missing: ${missingBindingConstraints.join(', ')}`);
    }

    const distinctionConstraints = await client.query(`
      select constraint_name from information_schema.table_constraints
      where table_schema = current_schema()
        and table_name = 'application_posting_distinctions'
    `);
    const presentDistinctionConstraints = new Set(
      distinctionConstraints.rows.map((row) => row.constraint_name),
    );
    const missingDistinctionConstraints = REQUIRED_DISTINCTION_CONSTRAINTS
      .filter((constraint) => !presentDistinctionConstraints.has(constraint));
    if (missingDistinctionConstraints.length > 0) {
      throw new Error(`Posting distinction constraints still missing: ${missingDistinctionConstraints.join(', ')}`);
    }

    const cutoverColumns = await client.query(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_ledger_cutovers'
    `);
    const presentCutoverColumns = new Set(cutoverColumns.rows.map((row) => row.column_name));
    const missingCutoverColumns = REQUIRED_CUTOVER_COLUMNS
      .filter((column) => !presentCutoverColumns.has(column));
    if (missingCutoverColumns.length > 0) {
      throw new Error(`Submission attempt ledger cutover columns still missing: ${missingCutoverColumns.join(', ')}`);
    }

    const cutoverConstraints = await client.query(`
      select constraint_name from information_schema.table_constraints
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_ledger_cutovers'
    `);
    const presentCutoverConstraints = new Set(cutoverConstraints.rows.map((row) => row.constraint_name));
    const missingCutoverConstraints = REQUIRED_CUTOVER_CONSTRAINTS
      .filter((constraint) => !presentCutoverConstraints.has(constraint));
    if (missingCutoverConstraints.length > 0) {
      throw new Error(
        `Submission attempt ledger cutover constraints still missing: ${missingCutoverConstraints.join(', ')}`,
      );
    }

    const cutoverRows = await client.query(`
      select count(*)::int as total
      from application_submission_attempt_ledger_cutovers
      where cutover_key = $1
    `, [LEGACY_BACKFILL_MARKER]);
    if (cutoverRows.rows[0]?.total !== 1) {
      throw new Error('Submission attempt ledger legacy backfill cutover marker is missing');
    }

    const triggers = await client.query(`
      select trigger_name from information_schema.triggers
      where event_object_schema = current_schema()
        and event_object_table = 'application_submission_attempt_events'
    `);
    const presentTriggers = new Set(triggers.rows.map((row) => row.trigger_name));
    for (const required of [
      'application_submission_attempt_events_no_update',
      'application_submission_attempt_events_no_direct_delete',
      'application_submission_attempt_events_one_binding',
    ]) {
      if (!presentTriggers.has(required)) {
        throw new Error(`Submission attempt ledger immutability trigger is missing: ${required}`);
      }
    }
    const bindingTriggers = await client.query(`
      select trigger_name from information_schema.triggers
      where event_object_schema = current_schema()
        and event_object_table = 'application_submission_attempt_bindings'
    `);
    const presentBindingTriggers = new Set(bindingTriggers.rows.map((row) => row.trigger_name));
    for (const required of [
      'application_submission_attempt_bindings_no_update',
      'application_submission_attempt_bindings_no_direct_delete',
    ]) {
      if (!presentBindingTriggers.has(required)) {
        throw new Error(`Submission attempt binding immutability trigger is missing: ${required}`);
      }
    }
    const distinctionTriggers = await client.query(`
      select trigger_name from information_schema.triggers
      where event_object_schema = current_schema()
        and event_object_table = 'application_posting_distinctions'
    `);
    const presentDistinctionTriggers = new Set(distinctionTriggers.rows.map((row) => row.trigger_name));
    for (const required of [
      'application_posting_distinctions_no_update',
      'application_posting_distinctions_no_direct_delete',
    ]) {
      if (!presentDistinctionTriggers.has(required)) {
        throw new Error(`Posting distinction immutability trigger is missing: ${required}`);
      }
    }
    const cutoverTriggers = await client.query(`
      select trigger_name from information_schema.triggers
      where event_object_schema = current_schema()
        and event_object_table = 'application_submission_attempt_ledger_cutovers'
    `);
    const presentCutoverTriggers = new Set(cutoverTriggers.rows.map((row) => row.trigger_name));
    for (const required of [
      'application_submission_attempt_ledger_cutovers_no_update',
      'application_submission_attempt_ledger_cutovers_no_delete',
    ]) {
      if (!presentCutoverTriggers.has(required)) {
        throw new Error(`Submission attempt ledger cutover immutability trigger is missing: ${required}`);
      }
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log('Ready: immutable submission attempt ledger schema is present.');
  console.warn('Operational hold rule applied: Max Borges Agency on Workable remains pressed/unverified '
    + 'until a person resolves whether the employer received it. Its handoff records only the day, so '
    + 'the immutable fact is timestamped at 2026-08-20T00:00:00Z with day granularity.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Submission attempt ledger schema failed:', message);
  process.exit(1);
});
