import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import pg from 'pg';
import { duplicateApplicationVerdict } from '../lib/duplicateApplication';
import {
  appendSubmissionAttemptEvent,
  SUBMISSION_ATTEMPT_EVENT_KINDS,
  SUBMISSION_ATTEMPT_OPERATIONS,
  SUBMISSION_ATTEMPT_SOURCES,
  SUBMISSION_NOT_SENT_PROOF_KINDS,
  SubmissionAttemptBindingConflictError,
  submissionAttemptsOpenedToday,
  submissionAttemptRetrySafetyForPacketEvents,
  type SubmissionAttemptEventRecord,
  type SubmissionAttemptLedgerExecutor,
} from '../lib/submissionAttemptLedger';
import * as schema from './schema';

test('production rollout makes the verified ledger migration an explicit first step', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  assert.equal(
    packageJson.scripts?.['db:submission-attempt-ledger'],
    'node scripts/apply-submission-attempt-ledger-schema.mjs',
  );

  const workflow = readFileSync('.github/workflows/submission-attempt-ledger-migration.yml', 'utf8');
  assert.match(workflow, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /environment: production/);
  assert.match(workflow, /DATABASE_URL: \$\{\{ secrets\.SCHEMA_CHECK_DATABASE_URL \}\}/);
  const proofIndex = workflow.indexOf('npm run test:submission-attempt-ledger-migration');
  const productionIndex = workflow.indexOf('npm run db:submission-attempt-ledger');
  const postMigrationFreezeIndex = workflow.indexOf('Require freeze remained active through migration');
  assert.ok(proofIndex >= 0, 'workflow must prove the migration contract against an isolated database');
  assert.ok(productionIndex > proofIndex, 'production migration must run only after its contract test');
  assert.ok(
    postMigrationFreezeIndex > productionIndex,
    'workflow must prove the exact backend stayed frozen through the production transaction',
  );
  assert.doesNotMatch(
    workflow.slice(workflow.indexOf('Prove schema, backfill'), workflow.indexOf('Apply and verify production')),
    /DATABASE_URL/,
    'isolated proof must never receive production credentials',
  );

  const runbook = readFileSync('DEPLOY.md', 'utf8');
  const fenceIndex = runbook.indexOf('1. Deploy PR0 fence with backend mode `off`.');
  const migrationOnlyIndex = runbook.indexOf('2. Deploy PR1 migration-only revision with backend mode `off`.');
  const stratusCompatIndex = runbook.indexOf('3. Deploy correlation-aware Stratus in compatibility mode, unquiesced.');
  const drainIndex = runbook.indexOf('4. Set the PR1 backend to `drain`');
  const migrationIndex = runbook.indexOf('5. Set the same PR1 backend revision to `freeze`');
  const backendIndex = runbook.indexOf('6. Rebase, verify, and deploy PR2 ledger writers');
  const frontendIndex = runbook.indexOf('7. Deploy the website and extension retry-safety clients');
  const reopenIndex = runbook.indexOf('10. Set the exact PR2 backend revision to `off`');
  assert.ok(fenceIndex >= 0 && fenceIndex < migrationOnlyIndex);
  assert.ok(migrationOnlyIndex < stratusCompatIndex);
  assert.ok(stratusCompatIndex < drainIndex);
  assert.ok(drainIndex < migrationIndex);
  assert.ok(migrationIndex < backendIndex);
  assert.ok(backendIndex < frontendIndex);
  assert.ok(frontendIndex < reopenIndex);
  assert.match(runbook, /Do not reopen the old submission runtime/);
  assert.match(runbook, /c43b9eeb-c1f3-4fd9-b9ba-d74e4dd0ad30/);
});

function runMigration(databaseUrl: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/apply-submission-attempt-ledger-schema.mjs'], {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: databaseUrl },
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

test('submission attempt ledger migration is idempotent, constrained, and append-only', async () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'submission-attempt-ledger-'));
  const database = await PGlite.create();
  let server: PGLiteSocketServer | null = null;
  try {
    const userId = '4a4dc523-53be-4c14-9b89-8ac0e14aa001';
    const applicationId = '4a4dc523-53be-4c14-9b89-8ac0e14aa002';
    const packetId = '4a4dc523-53be-4c14-9b89-8ac0e14aa003';
    const attemptId = '4a4dc523-53be-4c14-9b89-8ac0e14aa004';
    const openedEventId = '4a4dc523-53be-4c14-9b89-8ac0e14aa005';
    const submittedPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa010';
    const unverifiedPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa011';
    const resolvedPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa012';
    const typedStopPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa013';
    const contradictoryStopPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa014';
    const securityPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa015';
    const vocabularyPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa016';
    const capPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa017';
    const linkedNonRiskPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa018';
    const postCutoverPacketId = '4a4dc523-53be-4c14-9b89-8ac0e14aa019';
    const canonicalSubmittedAppId = '4a4dc523-53be-4c14-9b89-8ac0e14aa020';
    const canonicalManualConfirmedAppId = '4a4dc523-53be-4c14-9b89-8ac0e14aa021';
    const canonicalManualUnknownAppId = '4a4dc523-53be-4c14-9b89-8ac0e14aa022';
    const canonicalManualFailedAppId = '4a4dc523-53be-4c14-9b89-8ac0e14aa023';
    const canonicalLinkedSubmittedAppId = '4a4dc523-53be-4c14-9b89-8ac0e14aa024';
    const postCutoverApplicationId = '4a4dc523-53be-4c14-9b89-8ac0e14aa025';
    const autofillTrueEventId = '4a4dc523-53be-4c14-9b89-8ac0e14aa026';
    const autofillTrueSecondEventId = '4a4dc523-53be-4c14-9b89-8ac0e14aa027';
    const autofillBlankEventId = '4a4dc523-53be-4c14-9b89-8ac0e14aa028';
    const autofillFalseEventId = '4a4dc523-53be-4c14-9b89-8ac0e14aa029';
    const postCutoverAutofillEventId = '4a4dc523-53be-4c14-9b89-8ac0e14aa030';
    const maxBorgesPacketId = 'c43b9eeb-c1f3-4fd9-b9ba-d74e4dd0ad30';
    const initial = await generateMigration(
      generateDrizzleJson({}),
      generateDrizzleJson(schema as unknown as Record<string, unknown>),
    );
    for (const statement of initial) await database.exec(statement);
    await database.exec('drop table application_submission_attempt_events cascade');
    await database.exec('drop table application_submission_attempt_bindings cascade');
    await database.exec(`
      insert into users (id, email) values ('${userId}', 'attempt-ledger@example.test');
      insert into generated_resumes (
        id, user_id, job_context, spec, resume_object_key, pipeline_stage, created_at
      ) values
      (
        '${submittedPacketId}', '${userId}',
        '{"company":"Backfill & Co.","role":"Platform Engineer","job_id":"JOB-SUBMITTED"}'::jsonb,
        '{"_review":{"status":"submitted","portal_url":"https://apply.workable.com/backfill/j/ABC123/","submission_run_id":"legacy-submitted-run","submitted_at":"2026-08-20T10:00:00.000Z","receipt":{"confirmation_text":"Received","final_url":"https://apply.workable.com/backfill/j/ABC123/confirmation","captured_at":"2026-08-20T10:00:01.000Z"}}}'::jsonb,
        'resumes/backfill-submitted.pdf', 'applied', '2026-08-20T09:00:00.000Z'
      ),
      (
        '${unverifiedPacketId}', '${userId}',
        '{"company":"Backfill Co","role":"Risk Engineer","job_id":"JOB-UNVERIFIED"}'::jsonb,
        '{"_review":{"status":"needs_attention","portal_url":"https://job-boards.greenhouse.io/backfill/jobs/101","submission_run_id":"legacy-unverified-run","submission_claim_id":"4a4dc523-53be-4c14-9b89-8ac0e14aa111","submission_claimed_at":"2026-08-21T10:00:00.000Z","submission_attempted_at":"2026-08-21T10:00:01.000Z","unverified_submission":{"at":"2026-08-21T10:00:01.000Z","cause":"no_confirmation_state","submission_run_id":"legacy-unverified-run"}}}'::jsonb,
        'resumes/backfill-unverified.pdf', null, '2026-08-21T09:00:00.000Z'
      ),
      (
        '${resolvedPacketId}', '${userId}',
        '{"company":"Backfill Co","role":"Resolved Engineer","job_id":"JOB-RESOLVED"}'::jsonb,
        '{"_review":{"status":"needs_attention","portal_url":"https://jobs.ashbyhq.com/backfill/1b6ff6e1-4a19-4cf2-a789-7e61f0a42222","submission_run_id":"legacy-resolved-run","submission_attempted_at":"2026-08-22T10:00:01.000Z","unverified_submission":{"at":"2026-08-22T10:00:01.000Z","cause":"no_confirmation_state","submission_run_id":"legacy-resolved-run","resolution":"not_sent","resolved_at":"2026-08-22T11:00:00.000Z"}}}'::jsonb,
        'resumes/backfill-resolved.pdf', null, '2026-08-22T09:00:00.000Z'
      ),
      (
        '${typedStopPacketId}', '${userId}',
        '{"company":"Backfill Co","role":"Stopped Engineer","job_id":"JOB-STOPPED"}'::jsonb,
        '{"_review":{"status":"needs_attention","portal_url":"https://jobs.lever.co/backfill/stopped","submission_run_id":"legacy-stop-run","submission_stop":{"reason":"no_submit_control","before_click":true,"at":"2026-08-23T10:00:00.000Z","submission_run_id":"legacy-stop-run"}}}'::jsonb,
        'resumes/backfill-stop.pdf', null, '2026-08-23T09:00:00.000Z'
      ),
      (
        '${contradictoryStopPacketId}', '${userId}',
        '{"company":"Backfill Co","role":"Claimed Engineer","job_id":"JOB-CLAIMED"}'::jsonb,
        '{"_review":{"status":"submission_claimed","portal_url":"https://jobs.lever.co/backfill/claimed","submission_run_id":"legacy-claimed-run","submission_claim_id":"4a4dc523-53be-4c14-9b89-8ac0e14aa114","submission_claimed_at":"2026-08-23T12:00:00.000Z","submission_stop":{"reason":"no_submit_control","before_click":true,"at":"2026-08-23T11:59:00.000Z","submission_run_id":"legacy-claimed-run"}}}'::jsonb,
        'resumes/backfill-claimed.pdf', null, '2026-08-23T11:00:00.000Z'
      ),
      (
        '${securityPacketId}', '${userId}',
        '{"company":"Backfill Co","role":"Verified Engineer","job_id":"JOB-SECURITY"}'::jsonb,
        '{"_review":{"status":"awaiting_security_code","portal_url":"https://job-boards.greenhouse.io/backfill/jobs/102","submission_run_id":"legacy-security-run","security_code":{"digits":6,"requested_at":"2026-08-23T13:00:00.000Z","submit_was_authorized":true}}}'::jsonb,
        'resumes/backfill-security.pdf', null, '2026-08-23T12:00:00.000Z'
      ),
      (
        '${maxBorgesPacketId}', '${userId}',
        '{"company":"Max Borges Agency","role":"Public Relations Account Executive","job_id":"1149b1b6-8ea9-4cde-ae5f-15a1ecb9849b"}'::jsonb,
        '{"_review":{"status":"needs_attention","portal_url":"https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/","submission_run_id":"latest-safe-max-run","submission_stop":{"reason":"provider_session_failure_before_submit","before_click":true,"at":"2026-08-24T08:00:00.000Z","submission_run_id":"latest-safe-max-run"}}}'::jsonb,
        'resumes/max-borges.pdf', null, '2026-08-24T07:00:00.000Z'
      ),
      (
        '${linkedNonRiskPacketId}', '${userId}',
        '{"company":"Linked Canonical Co","role":"Distributed Systems Engineer","job_id":"JOB-LINKED-CANONICAL"}'::jsonb,
        '{"_review":{"status":"ready","portal_url":"https://linked-canonical.example/jobs/distributed-systems-engineer"}}'::jsonb,
        'resumes/linked-canonical.pdf', null, '2026-08-18T08:00:00.000Z'
      )
    `);
    await database.exec(`
      insert into autofill_events (
        id, user_id, ats_name, job_context, fields_filled, fields_skipped,
        submitted_by_user, auto_submitted, created_at
      ) values
      (
        '${autofillTrueEventId}', '${userId}', 'workable',
        '{"company":"Autofill Risk Co","role":"Safety Engineer"}'::jsonb,
        0, 3, false, true, '2026-08-17T10:00:00.000Z'
      ),
      (
        '${autofillTrueSecondEventId}', '${userId}', 'workable',
        '{"company":"Autofill Risk Co","role":"Safety Engineer"}'::jsonb,
        0, 0, false, true, '2026-08-17T10:01:00.000Z'
      ),
      (
        '${autofillBlankEventId}', '${userId}', 'custom',
        '{"company":"","role":""}'::jsonb,
        0, 0, false, true, '2026-08-17T10:02:00.000Z'
      ),
      (
        '${autofillFalseEventId}', '${userId}', 'workday',
        '{"company":"Telemetry Only Co","role":"Engineer"}'::jsonb,
        5, 0, true, false, '2026-08-17T10:03:00.000Z'
      )
    `);
    await database.exec(`
      insert into applications (
        id, user_id, job_id, company_scope_key, company_name, role, portal_url,
        source_surface, tracker_state, review_state, submission_state,
        application_fingerprint, created_at, updated_at
      ) values
      (
        '${canonicalSubmittedAppId}', '${userId}', '4a4dc523-53be-4c14-9b89-8ac0e14ab020',
        'domain:canonical-submitted.example', 'Canonical Submitted Co', 'Reliability Engineer',
        'https://canonical-submitted.example/careers/reliability-engineer',
        'extension', 'applied', 'ready', 'submitted', 'canonical-submitted-fixture',
        '2026-08-19T09:00:00.000Z', '2026-08-19T10:00:00.000Z'
      ),
      (
        '${canonicalManualConfirmedAppId}', '${userId}', '4a4dc523-53be-4c14-9b89-8ac0e14ab021',
        'domain:canonical-confirmed.example', 'Canonical Confirmed Co', 'Platform Engineer',
        'https://canonical-confirmed.example/jobs/platform-engineer',
        'extension', 'saved', 'not_started', 'not_started', 'canonical-confirmed-event-fixture',
        '2026-08-20T09:00:00.000Z', '2026-08-20T09:00:00.000Z'
      ),
      (
        '${canonicalManualUnknownAppId}', '${userId}', '4a4dc523-53be-4c14-9b89-8ac0e14ab022',
        'domain:canonical-unknown.example', 'Canonical Unknown Co', 'Risk Engineer',
        'https://canonical-unknown.example/jobs/risk-engineer',
        'extension', 'applying', 'filling', 'needs_attention', 'canonical-unknown-event-fixture',
        '2026-08-21T09:00:00.000Z', '2026-08-21T10:00:00.000Z'
      ),
      (
        '${canonicalManualFailedAppId}', '${userId}', '4a4dc523-53be-4c14-9b89-8ac0e14ab023',
        'domain:canonical-failed.example', 'Canonical Failed Co', 'Systems Engineer',
        'https://canonical-failed.example/jobs/systems-engineer',
        'extension', 'applying', 'filling', 'needs_attention', 'canonical-failed-event-fixture',
        '2026-08-22T09:00:00.000Z', '2026-08-22T10:00:00.000Z'
      );

      insert into application_submission_events (
        user_id, application_id, event_id, outcome, final_url, portal_identity,
        confirmation_text, applied_submission_state, observed_at, created_at
      ) values
      (
        '${userId}', '${canonicalManualConfirmedAppId}',
        '4a4dc523-53be-4c14-9b89-8ac0e14ac021', 'confirmed',
        'https://canonical-confirmed.example/jobs/platform-engineer/receipt',
        'https://canonical-confirmed.example', 'Application received', 'submitted',
        '2026-08-20T10:00:00.000Z', '2026-08-20T10:00:01.000Z'
      ),
      (
        '${userId}', '${canonicalManualUnknownAppId}',
        '4a4dc523-53be-4c14-9b89-8ac0e14ac022', 'unknown',
        'https://canonical-unknown.example/jobs/risk-engineer',
        'https://canonical-unknown.example', null, 'needs_attention',
        '2026-08-21T10:00:00.000Z', '2026-08-21T10:00:01.000Z'
      ),
      (
        '${userId}', '${canonicalManualFailedAppId}',
        '4a4dc523-53be-4c14-9b89-8ac0e14ac023', 'failed',
        'https://canonical-failed.example/jobs/systems-engineer',
        'https://canonical-failed.example', 'Employer returned an error', 'needs_attention',
        '2026-08-22T10:00:00.000Z', '2026-08-22T10:00:01.000Z'
      )
    `);
    await database.exec(`
      insert into applications (
        id, user_id, job_id, company_scope_key, company_name, role, portal_url,
        source_surface, tracker_state, review_state, submission_state,
        application_fingerprint, legacy_generated_resume_id, created_at, updated_at
      ) values (
        '${canonicalLinkedSubmittedAppId}', '${userId}', '4a4dc523-53be-4c14-9b89-8ac0e14ab024',
        'domain:linked-canonical.example', 'Linked Canonical Co', 'Distributed Systems Engineer',
        'https://linked-canonical.example/jobs/distributed-systems-engineer',
        'dashboard', 'applied', 'ready', 'submitted', 'canonical-linked-submitted-fixture',
        '${linkedNonRiskPacketId}', '2026-08-18T09:00:00.000Z', '2026-08-18T10:00:00.000Z'
      )
    `);

    server = new PGLiteSocketServer({
      db: database,
      path: join(socketDir, '.s.PGSQL.5432'),
      maxConnections: 5,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
    const first = await runMigration(databaseUrl);
    const markerAfterFirst = await database.query<{ cutover_key: string; total: number }>(`
      select min(cutover_key) as cutover_key, count(*)::int as total
      from application_submission_attempt_ledger_cutovers
    `);
    assert.deepEqual(markerAfterFirst.rows[0], { cutover_key: 'legacy_backfill_v1', total: 1 });
    const ledgerTotalsAfterFirst = await database.query<{ events: number; bindings: number }>(`
      select
        (select count(*)::int from application_submission_attempt_events) as events,
        (select count(*)::int from application_submission_attempt_bindings) as bindings
    `);

    /* A human resolution is a new immutable fact on the already imported attempt. The mutable
       packet snapshot is then changed to the same resolution. Migration replay must not synthesize
       another terminal fact from that projection. */
    await database.exec(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, parent_attempt_id,
        event_kind, source, operation, submission_run_id, submission_claim_id, packet_version,
        posting_key, job_id, company_role, company_name, role, portal_url, portal_identity,
        proof_kind, evidence_code, observed_at
      )
      select
        binding.user_id, binding.application_id, binding.packet_id,
        '4a4dc523-53be-4c14-9b89-8ac0e14aa119'::uuid, binding.attempt_id,
        binding.parent_attempt_id, 'not_sent_proven', binding.source, binding.operation,
        binding.submission_run_id, binding.submission_claim_id, binding.packet_version,
        binding.posting_key, binding.job_id, binding.company_role, binding.company_name,
        binding.role, binding.portal_url, binding.portal_identity,
        'applicant_checked_not_sent', 'runtime_resolution_after_cutover',
        '2026-08-21T11:00:00.000Z'::timestamptz
      from application_submission_attempt_bindings binding
      where binding.user_id = '${userId}' and binding.packet_id = '${unverifiedPacketId}'
        and exists (
          select 1 from application_submission_attempt_events opened
          where opened.user_id = binding.user_id
            and opened.attempt_id = binding.attempt_id
            and opened.evidence_code = 'legacy_current_unresolved_risk'
        )
    `);
    await database.exec(`
      update generated_resumes
      set spec = '{"_review":{"status":"needs_attention","portal_url":"https://job-boards.greenhouse.io/backfill/jobs/101","submission_run_id":"legacy-unverified-run","submission_claim_id":"4a4dc523-53be-4c14-9b89-8ac0e14aa111","submission_claimed_at":"2026-08-21T10:00:00.000Z","submission_attempted_at":"2026-08-21T10:00:01.000Z","unverified_submission":{"at":"2026-08-21T10:00:01.000Z","cause":"no_confirmation_state","submission_run_id":"legacy-unverified-run","resolution":"not_sent","resolved_at":"2026-08-21T11:00:00.000Z"}}}'::jsonb
      where id = '${unverifiedPacketId}';

      update generated_resumes
      set
        job_context = '{"company":"Changed Backfill Co","role":"Changed Platform Role","job_id":"CHANGED-SUBMITTED"}'::jsonb,
        spec = '{"_review":{"status":"submitted","portal_url":"https://changed.example/apply","submission_run_id":"changed-submitted-run","submitted_at":"2026-08-25T10:00:00.000Z"}}'::jsonb
      where id = '${submittedPacketId}';

      insert into generated_resumes (
        id, user_id, job_context, spec, resume_object_key, pipeline_stage, created_at
      ) values (
        '${postCutoverPacketId}', '${userId}',
        '{"company":"Post Cutover Packet Co","role":"New Engineer","job_id":"POST-PACKET"}'::jsonb,
        '{"_review":{"status":"submitted","portal_url":"https://post-packet.example/apply","submission_run_id":"post-packet-run","submitted_at":"2026-08-25T12:00:00.000Z"}}'::jsonb,
        'resumes/post-cutover.pdf', 'applied', '2026-08-25T11:00:00.000Z'
      );

      insert into applications (
        id, user_id, job_id, company_scope_key, company_name, role, portal_url,
        source_surface, tracker_state, review_state, submission_state,
        application_fingerprint, created_at, updated_at
      ) values (
        '${postCutoverApplicationId}', '${userId}',
        '4a4dc523-53be-4c14-9b89-8ac0e14ab025', 'domain:post-canonical.example',
        'Post Cutover Canonical Co', 'New Platform Engineer',
        'https://post-canonical.example/jobs/platform', 'dashboard', 'applied', 'ready',
        'submitted', 'post-cutover-canonical-fixture',
        '2026-08-25T11:00:00.000Z', '2026-08-25T12:00:00.000Z'
      );

      insert into autofill_events (
        id, user_id, ats_name, job_context, fields_filled, fields_skipped,
        submitted_by_user, auto_submitted, created_at
      ) values (
        '${postCutoverAutofillEventId}', '${userId}', 'workable',
        '{"company":"Post Cutover Telemetry Co","role":"Engineer"}'::jsonb,
        0, 0, false, true, '2026-08-25T12:01:00.000Z'
      )
    `);
    const second = await runMigration(databaseUrl);
    assert.match(first.stdout, /immutable submission attempt ledger schema is present/);
    assert.match(second.stdout, /immutable submission attempt ledger schema is present/);
    const ledgerTotalsAfterSecond = await database.query<{ events: number; bindings: number }>(`
      select
        (select count(*)::int from application_submission_attempt_events) as events,
        (select count(*)::int from application_submission_attempt_bindings) as bindings
    `);
    assert.equal(
      ledgerTotalsAfterSecond.rows[0]?.events,
      (ledgerTotalsAfterFirst.rows[0]?.events ?? 0) + 1,
      'only the explicit runtime resolution may add an event after the cutover marker',
    );
    assert.equal(
      ledgerTotalsAfterSecond.rows[0]?.bindings,
      ledgerTotalsAfterFirst.rows[0]?.bindings,
      'migration replay and the resolution of an existing attempt must add no binding',
    );
    const ledgerDb = drizzle(database, { schema });

    const backfilled = await database.query<{
      packet_id: string;
      event_kind: string;
      proof_kind: string | null;
      job_id: string | null;
      company_role: string | null;
      portal_identity: string | null;
    }>(`
      select packet_id, event_kind, proof_kind, job_id, company_role, portal_identity
      from application_submission_attempt_events
      where packet_id in (
        '${submittedPacketId}', '${unverifiedPacketId}', '${resolvedPacketId}',
        '${typedStopPacketId}', '${contradictoryStopPacketId}', '${securityPacketId}',
        '${maxBorgesPacketId}'
      )
      order by packet_id, event_kind
    `);
    const packetFacts = (id: string) => backfilled.rows
      .filter((row) => row.packet_id === id)
      .map((row) => [row.event_kind, row.proof_kind]);
    assert.deepEqual(packetFacts(submittedPacketId), [
      ['attempt_opened', null],
      ['submission_confirmed', null],
    ]);
    assert.deepEqual(packetFacts(unverifiedPacketId), [
      ['attempt_opened', null],
      ['attempt_opened', null],
      ['not_sent_proven', 'applicant_checked_not_sent'],
      ['press_observed', null],
    ]);
    assert.deepEqual(packetFacts(resolvedPacketId), [
      ['attempt_opened', null],
      ['attempt_opened', null],
      ['not_sent_proven', 'applicant_checked_not_sent'],
    ]);
    assert.deepEqual(packetFacts(typedStopPacketId), [
      ['attempt_opened', null],
      ['attempt_opened', null],
      ['not_sent_proven', 'typed_pre_click_stop'],
    ]);
    assert.deepEqual(packetFacts(contradictoryStopPacketId), [
      ['attempt_opened', null],
      ['attempt_opened', null],
      ['press_observed', null],
    ]);
    assert.deepEqual(packetFacts(securityPacketId), [
      ['attempt_opened', null],
      ['attempt_opened', null],
      ['press_observed', null],
    ]);
    assert.deepEqual(packetFacts(maxBorgesPacketId), [
      ['attempt_opened', null],
      ['attempt_opened', null],
      ['attempt_opened', null],
      ['not_sent_proven', 'typed_pre_click_stop'],
      ['press_observed', null],
    ]);
    const rawMaxEvents = await database.query<SubmissionAttemptEventRecord>(`
      select * from application_submission_attempt_events
      where user_id = '${userId}' and packet_id = '${maxBorgesPacketId}'
      order by created_at, id
    `);
    const dateValue = (value: unknown) => value instanceof Date ? value : new Date(String(value));
    const rawClaimedEvents = await database.query<SubmissionAttemptEventRecord>(`
      select * from application_submission_attempt_events
      where user_id = '${userId}' and packet_id = '${contradictoryStopPacketId}'
      order by created_at, id
    `);
    const claimedSafety = submissionAttemptRetrySafetyForPacketEvents(rawClaimedEvents.rows.map((event) => ({
      ...event,
      observed_at: dateValue(event.observed_at),
      created_at: dateValue(event.created_at),
    })));
    assert.equal(claimedSafety.kind, 'blocked_unverified');
    if (claimedSafety.kind !== 'blocked_unverified') throw new Error('Claimed cutover attempt was not blocking');
    assert.equal(claimedSafety.reason, 'pressed');
    const maxSafety = submissionAttemptRetrySafetyForPacketEvents(rawMaxEvents.rows.map((event) => ({
      ...event,
      observed_at: dateValue(event.observed_at),
      created_at: dateValue(event.created_at),
    })));
    assert.equal(maxSafety.kind, 'blocked_unverified');
    if (maxSafety.kind !== 'blocked_unverified') throw new Error('Max operational hold was not blocking');
    assert.match(maxSafety.attemptId, /^[0-9a-f-]{36}$/i);
    assert.equal(maxSafety.at, '2026-08-20T00:00:00.000Z');
    assert.equal(maxSafety.reason, 'pressed');
    const maxHoldCodes = await database.query<{ evidence_code: string }>(`
      select evidence_code from application_submission_attempt_events
      where user_id = '${userId}' and packet_id = '${maxBorgesPacketId}'
        and evidence_code = 'vault_pressed_unverified_2026_08_20'
    `);
    assert.equal(maxHoldCodes.rows.length, 2);
    const frozenSubmitted = backfilled.rows.find((row) => row.packet_id === submittedPacketId);
    assert.equal(frozenSubmitted?.job_id, 'job-submitted');
    assert.equal(frozenSubmitted?.company_role, 'backfill co|platform engineer');
    assert.equal(frozenSubmitted?.portal_identity, 'https://apply.workable.com');
    const frozenSubmittedBinding = await database.query<{
      job_id: string | null;
      company_role: string | null;
      company_name: string;
      role: string;
      portal_url: string | null;
      portal_identity: string | null;
    }>(`
      select job_id, company_role, company_name, role, portal_url, portal_identity
      from application_submission_attempt_bindings
      where user_id = '${userId}' and packet_id = '${submittedPacketId}'
    `);
    assert.deepEqual(frozenSubmittedBinding.rows[0], {
      job_id: 'job-submitted',
      company_role: 'backfill co|platform engineer',
      company_name: 'Backfill & Co.',
      role: 'Platform Engineer',
      portal_url: 'https://apply.workable.com/backfill/j/ABC123/',
      portal_identity: 'https://apply.workable.com',
    });
    const rawUnverifiedEvents = await database.query<SubmissionAttemptEventRecord>(`
      select * from application_submission_attempt_events
      where user_id = '${userId}' and packet_id = '${unverifiedPacketId}'
      order by created_at, id
    `);
    const unverifiedSafety = submissionAttemptRetrySafetyForPacketEvents(
      rawUnverifiedEvents.rows.map((event) => ({
        ...event,
        observed_at: dateValue(event.observed_at),
        created_at: dateValue(event.created_at),
      })),
    );
    assert.equal(unverifiedSafety.kind, 'blocked_unverified');
    if (unverifiedSafety.kind !== 'blocked_unverified') {
      throw new Error('The independent generated capability hold was incorrectly released');
    }
    assert.equal(unverifiedSafety.reason, 'opened');
    assert.equal(
      rawUnverifiedEvents.rows.filter((event) => event.event_kind === 'not_sent_proven').length,
      1,
      'the cutover marker must prevent a synthetic second terminal fact on replay',
    );
    const postCutoverSyntheticFacts = await database.query<{ total: number }>(`
      select count(*)::int as total
      from application_submission_attempt_events
      where packet_id = '${postCutoverPacketId}'
        or application_id = '${postCutoverApplicationId}'
    `);
    assert.equal(
      postCutoverSyntheticFacts.rows[0]?.total,
      0,
      'post-cutover packet and canonical state must not be reinterpreted as legacy history',
    );
    const postCutoverAutofillFacts = await database.query<{ total: number }>(`
      select count(*)::int as total
      from application_submission_attempt_events
      where attempt_id = md5(
        'litos:legacy-autofill-auto-submit-attempt:v1:${userId}:${postCutoverAutofillEventId}'
      )::uuid
    `);
    assert.equal(
      postCutoverAutofillFacts.rows[0]?.total,
      0,
      'post-cutover telemetry must not be reinterpreted by a sealed legacy backfill',
    );
    assert.equal(backfilled.rows.length, 23, 'rerunning the migration must not duplicate backfill facts');

    const canonicalFacts = await database.query<{
      application_id: string;
      event_kind: string;
      evidence_code: string;
      job_id: string | null;
      company_role: string | null;
      portal_identity: string | null;
    }>(`
      select application_id, event_kind, evidence_code, job_id, company_role, portal_identity
      from application_submission_attempt_events
      where application_id in (
        '${canonicalSubmittedAppId}', '${canonicalManualConfirmedAppId}',
        '${canonicalManualUnknownAppId}', '${canonicalManualFailedAppId}',
        '${canonicalLinkedSubmittedAppId}'
      )
      order by application_id, event_kind
    `);
    const applicationFacts = (id: string) => canonicalFacts.rows
      .filter((row) => row.application_id === id)
      .map((row) => row.event_kind);
    assert.deepEqual(applicationFacts(canonicalSubmittedAppId), [
      'attempt_opened',
      'submission_confirmed',
    ]);
    assert.deepEqual(applicationFacts(canonicalManualConfirmedAppId), [
      'attempt_opened',
      'press_observed',
      'submission_confirmed',
    ]);
    assert.deepEqual(applicationFacts(canonicalManualUnknownAppId), [
      'attempt_opened',
      'attempt_opened',
      'press_observed',
    ]);
    assert.deepEqual(applicationFacts(canonicalManualFailedAppId), [
      'attempt_opened',
      'attempt_opened',
      'press_observed',
    ]);
    assert.deepEqual(applicationFacts(canonicalLinkedSubmittedAppId), [
      'attempt_opened',
      'attempt_opened',
      'submission_confirmed',
    ]);
    assert.equal(canonicalFacts.rows.length, 14, 'rerunning the migration must not duplicate canonical facts');
    const linkedCanonicalFacts = await database.query<{ packet_id: string }>(`
      select packet_id from application_submission_attempt_events
      where application_id = '${canonicalLinkedSubmittedAppId}'
    `);
    assert.deepEqual(
      new Set(linkedCanonicalFacts.rows.map((row) => row.packet_id)),
      new Set([linkedNonRiskPacketId]),
      'linked terminal application facts must bind to the original packet',
    );
    const frozenCanonicalUnknown = canonicalFacts.rows.find((row) => row.application_id === canonicalManualUnknownAppId);
    assert.equal(frozenCanonicalUnknown?.job_id, '4a4dc523-53be-4c14-9b89-8ac0e14ab022');
    assert.equal(frozenCanonicalUnknown?.company_role, 'canonical unknown co|risk engineer');
    assert.equal(frozenCanonicalUnknown?.portal_identity, 'https://canonical-unknown.example');

    const ledgerExecutor = ledgerDb as unknown as SubmissionAttemptLedgerExecutor;
    const maxPostingAliasVerdict = await duplicateApplicationVerdict({
      userId,
      applicationId: '4a4dc523-53be-4c14-9b89-8ac0e14ad031',
      jobContext: {
        company: 'Renamed PR Agency',
        role: 'Fall Public Relations Intern',
        job_id: 'a-different-surrogate-id',
      },
      portalUrl: 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/',
    }, ledgerExecutor);
    assert.equal(maxPostingAliasVerdict.kind, 'duplicate');
    if (maxPostingAliasVerdict.kind !== 'duplicate') {
      throw new Error('Legacy Workable portal identity did not block the same employer posting');
    }
    assert.equal(maxPostingAliasVerdict.match.basis, 'ats_posting');
    assert.equal(maxPostingAliasVerdict.match.certainty, 'unverified');

    const autofillFacts = await database.query<{
      autofill_event_id: string;
      packet_id: string;
      attempt_id: string;
      event_kind: string;
      source: string;
      operation: string;
      company_role: string | null;
      application_id: string | null;
      packet_is_namespaced: boolean;
    }>(`
      select
        autofill.id as autofill_event_id,
        event.packet_id,
        event.attempt_id,
        event.event_kind,
        event.source,
        event.operation,
        event.company_role,
        event.application_id,
        event.packet_id = md5(
          'litos:legacy-autofill-packet:v1:' || autofill.user_id::text || ':' || autofill.id::text
        )::uuid as packet_is_namespaced
      from application_submission_attempt_events event
      inner join autofill_events autofill
        on event.attempt_id = md5(
          'litos:legacy-autofill-auto-submit-attempt:v1:'
          || autofill.user_id::text || ':' || autofill.id::text
        )::uuid
      order by autofill.created_at, event.event_kind
    `);
    assert.equal(autofillFacts.rows.length, 6);
    assert.equal(new Set(autofillFacts.rows.map((row) => row.attempt_id)).size, 3);
    assert.ok(autofillFacts.rows.every((row) => row.source === 'legacy_backfill'));
    assert.ok(autofillFacts.rows.every((row) => row.operation === 'initial_submission'));
    assert.ok(autofillFacts.rows.every((row) => row.application_id === null));
    assert.ok(autofillFacts.rows.every((row) => row.packet_is_namespaced));
    assert.ok(autofillFacts.rows.every((row) => row.packet_id !== row.autofill_event_id));
    assert.deepEqual(
      autofillFacts.rows.filter((row) => row.autofill_event_id === autofillTrueEventId)
        .map((row) => row.event_kind),
      ['attempt_opened', 'press_observed'],
    );
    assert.deepEqual(
      autofillFacts.rows.filter((row) => row.autofill_event_id === autofillTrueSecondEventId)
        .map((row) => row.event_kind),
      ['attempt_opened', 'press_observed'],
    );
    assert.ok(
      autofillFacts.rows.filter((row) => row.autofill_event_id === autofillBlankEventId)
        .every((row) => row.company_role === null),
    );
    assert.equal(
      autofillFacts.rows.some((row) => row.autofill_event_id === autofillFalseEventId),
      false,
    );
    const unidentifiableAutofillVerdict = await duplicateApplicationVerdict({
      userId,
      applicationId: '4a4dc523-53be-4c14-9b89-8ac0e14ad028',
      jobContext: { company: 'Never Seen Co', role: 'Unique Role' },
      portalUrl: 'https://never-seen.example/jobs/unique-role',
    }, ledgerExecutor);
    assert.equal(unidentifiableAutofillVerdict.kind, 'unidentifiable');

    const submittedAliasVerdict = await duplicateApplicationVerdict({
      userId,
      applicationId: '4a4dc523-53be-4c14-9b89-8ac0e14ad020',
      jobContext: { company: 'Canonical Submitted Co', role: 'Reliability Engineer' },
      portalUrl: 'https://alias.example/apply/reliability-engineer',
    }, ledgerExecutor);
    assert.equal(submittedAliasVerdict.kind, 'unidentifiable');
    if (submittedAliasVerdict.kind !== 'unidentifiable') {
      throw new Error('One-sided internal job identity did not fail closed');
    }
    assert.ok(submittedAliasVerdict.prior_attempt_id);

    const linkedAliasVerdict = await duplicateApplicationVerdict({
      userId,
      applicationId: '4a4dc523-53be-4c14-9b89-8ac0e14ad024',
      jobContext: { company: 'Linked Canonical Co', role: 'Distributed Systems Engineer' },
      portalUrl: 'https://another-alias.example/apply/distributed-systems-engineer',
    }, ledgerExecutor);
    assert.equal(linkedAliasVerdict.kind, 'unidentifiable');

    const unknownAliasVerdict = await duplicateApplicationVerdict({
      userId,
      applicationId: '4a4dc523-53be-4c14-9b89-8ac0e14ad022',
      jobContext: { company: 'Canonical Unknown Co', role: 'Risk Engineer' },
      portalUrl: 'https://alias.example/apply/risk-engineer',
    }, ledgerExecutor);
    assert.equal(unknownAliasVerdict.kind, 'unidentifiable');

    const columns = await database.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_events'
    `);
    const names = new Set(columns.rows.map((row) => row.column_name));
    for (const expected of [
      'user_id', 'application_id', 'packet_id', 'event_id', 'attempt_id', 'parent_attempt_id',
      'event_kind', 'source', 'operation', 'submission_run_id', 'submission_claim_id',
      'packet_version', 'posting_key', 'job_id', 'company_role', 'company_name', 'role',
      'portal_url', 'portal_identity', 'proof_kind', 'evidence_code', 'boundary_activation_id',
      'boundary_expires_at', 'observed_at', 'created_at',
    ]) assert.equal(names.has(expected), true, `${expected} missing after migration`);

    const indexes = await database.query<{ indexname: string }>(`
      select indexname from pg_indexes
      where schemaname = current_schema()
        and tablename = 'application_submission_attempt_events'
    `);
    const indexNames = new Set(indexes.rows.map((row) => row.indexname));
    for (const expected of [
      'application_submission_attempt_events_user_event_unique',
      'application_submission_attempt_events_user_attempt_time_idx',
      'application_submission_attempt_events_packet_time_idx',
      'application_submission_attempt_events_user_posting_idx',
      'application_submission_attempt_events_user_job_idx',
      'application_submission_attempt_events_user_company_role_idx',
      'submission_attempt_events_user_attempt_boundary_uq',
    ]) assert.equal(indexNames.has(expected), true, `${expected} missing after migration`);

    const bindingColumns = await database.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_bindings'
    `);
    const bindingColumnNames = new Set(bindingColumns.rows.map((row) => row.column_name));
    for (const expected of [
      'user_id', 'attempt_id', 'application_id', 'packet_id', 'parent_attempt_id',
      'source', 'operation', 'submission_run_id', 'submission_claim_id', 'packet_version',
      'posting_key', 'job_id', 'company_role', 'company_name', 'role', 'portal_url',
      'portal_identity', 'created_at',
    ]) assert.equal(bindingColumnNames.has(expected), true, `${expected} missing from attempt binding registry`);

    const cutoverColumns = await database.query<{ column_name: string }>(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_ledger_cutovers'
    `);
    assert.deepEqual(
      new Set(cutoverColumns.rows.map((row) => row.column_name)),
      new Set(['cutover_key', 'completed_at']),
    );

    await database.exec(`
      insert into applications (
        id, user_id, company_scope_key, company_name, role, source_surface, application_fingerprint
      ) values (
        '${applicationId}', '${userId}', 'domain:example.test', 'Example', 'Engineer',
        'dashboard', 'attempt-ledger-test'
      );
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        posting_key, company_role, company_name, role, portal_url, portal_identity
      ) values (
        '${userId}', '${applicationId}', '${packetId}', '${openedEventId}', '${attemptId}',
        'attempt_opened', 'managed_browser', 'initial_submission',
        'greenhouse:example:123', 'example|engineer', 'Example', 'Engineer',
        'https://job-boards.greenhouse.io/example/jobs/123', 'https://job-boards.greenhouse.io'
      )
    `);

    await appendSubmissionAttemptEvent({
      userId,
      applicationId,
      packetId,
      attemptId,
      eventId: '4a4dc523-53be-4c14-9b89-8ac0e14aa007',
      eventKind: 'press_observed',
      source: 'managed_browser',
      operation: 'initial_submission',
      postingIdentity: {
        postingKey: 'greenhouse:example:123',
        jobId: null,
        companyRole: 'example|engineer',
        company: 'Example',
        role: 'Engineer',
        portalUrl: 'https://job-boards.greenhouse.io/example/jobs/123',
        portalIdentity: 'https://job-boards.greenhouse.io',
      },
    }, { executor: ledgerDb as unknown as SubmissionAttemptLedgerExecutor });
    await assert.rejects(
      appendSubmissionAttemptEvent({
        userId,
        applicationId,
        packetId: '4a4dc523-53be-4c14-9b89-8ac0e14aafff',
        attemptId,
        eventId: '4a4dc523-53be-4c14-9b89-8ac0e14aa009',
        eventKind: 'submission_confirmed',
        source: 'chrome_extension',
        operation: 'manual_submission',
        postingIdentity: {
          postingKey: 'greenhouse:other:999',
          jobId: 'other-job',
          companyRole: 'other|role',
          company: 'Other',
          role: 'Role',
          portalUrl: 'https://job-boards.greenhouse.io/other/jobs/999',
          portalIdentity: 'https://job-boards.greenhouse.io',
        },
      }, { executor: ledgerDb as unknown as SubmissionAttemptLedgerExecutor }),
      (error: unknown) => error instanceof SubmissionAttemptBindingConflictError,
    );

    const concurrentAttemptId = '4a4dc523-53be-4c14-9b89-8ac0e14aae00';
    const concurrentClientA = new pg.Client({ connectionString: databaseUrl });
    const concurrentClientB = new pg.Client({ connectionString: databaseUrl });
    await Promise.all([concurrentClientA.connect(), concurrentClientB.connect()]);
    try {
      const insertConcurrent = (client: pg.Client, input: {
        eventId: string;
        packetId: string;
        source: string;
        company: string;
      }) => client.query(`
        insert into application_submission_attempt_events (
          user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
          company_name, role
        ) values ($1, $2, $3, $4, 'attempt_opened', $5, 'initial_submission', $6, 'Engineer')
      `, [userId, input.packetId, input.eventId, concurrentAttemptId, input.source, input.company]);
      const results = await Promise.allSettled([
        insertConcurrent(concurrentClientA, {
          eventId: '4a4dc523-53be-4c14-9b89-8ac0e14aae01',
          packetId: '4a4dc523-53be-4c14-9b89-8ac0e14aae11',
          source: 'managed_browser',
          company: 'Concurrent A',
        }),
        insertConcurrent(concurrentClientB, {
          eventId: '4a4dc523-53be-4c14-9b89-8ac0e14aae02',
          packetId: '4a4dc523-53be-4c14-9b89-8ac0e14aae12',
          source: 'chrome_extension',
          company: 'Concurrent B',
        }),
      ]);
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
      assert.match(
        String(results.find((result) => result.status === 'rejected')?.reason),
        /submission attempt binding conflict/i,
      );
      const concurrentFacts = await database.query<{ total: number }>(`
        select count(*)::int as total from application_submission_attempt_events
        where user_id = '${userId}' and attempt_id = '${concurrentAttemptId}'
      `);
      assert.equal(concurrentFacts.rows[0]?.total, 1, 'one concurrent binding wins and the conflict is rejected');
    } finally {
      await Promise.all([
        concurrentClientA.end().catch(() => undefined),
        concurrentClientB.end().catch(() => undefined),
      ]);
    }

    await assert.rejects(database.exec(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation, company_name, role
      ) values (
        '${userId}', '${packetId}', '${openedEventId}',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa099', 'attempt_opened',
        'managed_browser', 'initial_submission', 'Example', 'Engineer'
      )
    `), /unique|duplicate/i);

    await assert.rejects(database.exec(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        posting_key, company_role, company_name, role, portal_url, portal_identity
      ) values (
        '${userId}', '${applicationId}', '${packetId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa006',
        '${attemptId}', 'not_sent_proven', 'managed_browser', 'initial_submission',
        'greenhouse:example:123', 'example|engineer', 'Example', 'Engineer',
        'https://job-boards.greenhouse.io/example/jobs/123', 'https://job-boards.greenhouse.io'
      )
    `), /check|constraint/i);

    for (const [index, eventKind] of SUBMISSION_ATTEMPT_EVENT_KINDS.entries()) {
      const eventId = `4a4dc523-53be-4c14-9b89-${String(800 + index).padStart(12, '0')}`;
      const vocabularyAttemptId = `4a4dc523-53be-4c14-9b89-${String(900 + index).padStart(12, '0')}`;
      await database.exec(`
        insert into application_submission_attempt_events (
          user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
          company_name, role, proof_kind, boundary_activation_id, boundary_expires_at
        ) values (
          '${userId}', '${vocabularyPacketId}', '${eventId}', '${vocabularyAttemptId}',
          '${eventKind}', 'managed_browser', 'initial_submission', 'Example', 'Engineer',
          ${eventKind === 'not_sent_proven' ? "'typed_pre_click_stop'" : 'null'},
          ${eventKind === 'boundary_authorized' ? `'${eventId}'` : 'null'},
          ${eventKind === 'boundary_authorized' ? "clock_timestamp() + interval '3 minutes'" : 'null'}
        )
      `);
    }
    for (const [index, source] of SUBMISSION_ATTEMPT_SOURCES.entries()) {
      const eventId = `4a4dc523-53be-4c14-9b89-${String(820 + index).padStart(12, '0')}`;
      const vocabularyAttemptId = `4a4dc523-53be-4c14-9b89-${String(920 + index).padStart(12, '0')}`;
      await database.exec(`
        insert into application_submission_attempt_events (
          user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
          company_name, role
        ) values (
          '${userId}', '${vocabularyPacketId}', '${eventId}', '${vocabularyAttemptId}',
          'attempt_opened', '${source}', 'initial_submission', 'Example', 'Engineer'
        )
      `);
    }
    for (const [index, operation] of SUBMISSION_ATTEMPT_OPERATIONS.entries()) {
      const eventId = `4a4dc523-53be-4c14-9b89-${String(840 + index).padStart(12, '0')}`;
      const vocabularyAttemptId = `4a4dc523-53be-4c14-9b89-${String(940 + index).padStart(12, '0')}`;
      await database.exec(`
        insert into application_submission_attempt_events (
          user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
          company_name, role
        ) values (
          '${userId}', '${vocabularyPacketId}', '${eventId}', '${vocabularyAttemptId}',
          'attempt_opened', 'managed_browser', '${operation}', 'Example', 'Engineer'
        )
      `);
    }
    const vocabulary = await database.query<{
      event_kind: string;
      source: string;
      operation: string;
    }>(`
      select event_kind, source, operation from application_submission_attempt_events
      where user_id = '${userId}' and packet_id = '${vocabularyPacketId}'
    `);
    assert.deepEqual(new Set(vocabulary.rows.map((row) => row.event_kind)), new Set(SUBMISSION_ATTEMPT_EVENT_KINDS));
    assert.deepEqual(new Set(vocabulary.rows.map((row) => row.source)), new Set(SUBMISSION_ATTEMPT_SOURCES));
    assert.deepEqual(new Set(vocabulary.rows.map((row) => row.operation)), new Set(SUBMISSION_ATTEMPT_OPERATIONS));

    await database.exec(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_name, role, observed_at, created_at
      ) values
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa301',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa201', 'attempt_opened',
        'managed_browser', 'initial_submission', 'Cap Co', 'Engineer',
        '2026-09-01T00:00:00.000Z', '2026-09-01T02:00:00.000Z'
      ),
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa302',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa201', 'attempt_opened',
        'managed_browser', 'initial_submission', 'Cap Co', 'Engineer',
        '2026-09-01T00:01:00.000Z', '2026-09-01T02:01:00.000Z'
      ),
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa303',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa202', 'attempt_opened',
        'managed_browser', 'security_code_continuation', 'Cap Co', 'Engineer',
        '2026-09-01T00:02:00.000Z', '2026-09-01T02:02:00.000Z'
      ),
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa304',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa203', 'attempt_opened',
        'attended_handoff', 'manual_submission', 'Cap Co', 'Engineer',
        '2026-09-01T00:03:00.000Z', '2026-09-01T02:03:00.000Z'
      ),
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa305',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa204', 'attempt_opened',
        'legacy_backfill', 'initial_submission', 'Cap Co', 'Engineer',
        '2026-08-31T23:59:59.000Z', '2026-09-01T02:04:00.000Z'
      ),
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa306',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa206', 'attempt_opened',
        'direct_browser', 'initial_submission', 'Cap Co', 'Direct Engineer',
        '2026-09-01T00:04:00.000Z', '2026-09-01T02:05:00.000Z'
      ),
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa307',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa207', 'attempt_opened',
        'chrome_extension', 'initial_submission', 'Cap Co', 'Extension Engineer',
        '2026-09-01T00:05:00.000Z', '2026-09-01T02:06:00.000Z'
      ),
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa308',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa208', 'attempt_opened',
        'unsupported_email', 'initial_submission', 'Cap Co', 'Email Engineer',
        '2026-09-01T00:06:00.000Z', '2026-09-01T02:07:00.000Z'
      ),
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa309',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa209', 'attempt_opened',
        'ats_api', 'initial_submission', 'Cap Co', 'ATS Engineer',
        '2026-09-01T00:07:00.000Z', '2026-09-01T02:08:00.000Z'
      ),
      (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa310',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa210', 'attempt_opened',
        'legacy_backfill', 'initial_submission', 'Cap Co', 'Today Backfill',
        '2026-09-01T00:08:00.000Z', '2026-09-01T02:09:00.000Z'
      )
    `);
    await database.exec(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_name, role, evidence_code, observed_at, created_at
      ) values (
        '${userId}', '${capPacketId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa311',
        '4a4dc523-53be-4c14-9b89-8ac0e14aa211', 'attempt_opened',
        'legacy_backfill', 'initial_submission', 'Cap Co', 'Delayed Email Bridge',
        'delayed_employer_confirmation_uncorrelated',
        '2026-09-01T00:09:00.000Z', '2026-09-01T02:10:00.000Z'
      )
    `);
    assert.equal(await submissionAttemptsOpenedToday(userId, {
      executor: ledgerDb,
      since: new Date('2026-09-01T00:00:00.000Z'),
    }), 6, 'daily cap counts only real automatic reservations by observed time');

    for (const [index, proofKind] of SUBMISSION_NOT_SENT_PROOF_KINDS.entries()) {
      const eventId = `4a4dc523-53be-4c14-9b89-${String(700 + index).padStart(12, '0')}`;
      await database.exec(`
        insert into application_submission_attempt_events (
          user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
          posting_key, company_role, company_name, role, portal_url, portal_identity, proof_kind
        ) values (
          '${userId}', '${applicationId}', '${packetId}', '${eventId}', '${attemptId}',
          'not_sent_proven', 'managed_browser', 'initial_submission',
          'greenhouse:example:123', 'example|engineer', 'Example', 'Engineer',
          'https://job-boards.greenhouse.io/example/jobs/123', 'https://job-boards.greenhouse.io',
          '${proofKind}'
        )
      `);
    }

    await assert.rejects(database.exec(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        posting_key, company_role, company_name, role, portal_url, portal_identity, proof_kind
      ) values (
        '${userId}', '${applicationId}', '${packetId}', '4a4dc523-53be-4c14-9b89-8ac0e14aa008',
        '${attemptId}', 'not_sent_proven', 'managed_browser', 'initial_submission',
        'greenhouse:example:123', 'example|engineer', 'Example', 'Engineer',
        'https://job-boards.greenhouse.io/example/jobs/123', 'https://job-boards.greenhouse.io',
        'invented_not_sent_proof'
      )
    `), /check|constraint/i);

    await assert.rejects(database.exec(`
      update application_submission_attempt_events
      set event_kind = 'submission_confirmed'
      where event_id = '${openedEventId}'
    `), /append-only/i);

    await assert.rejects(database.exec(`
      update application_submission_attempt_bindings
      set role = 'Changed role'
      where user_id = '${userId}' and attempt_id = '${attemptId}'
    `), /immutable/i);

    await assert.rejects(database.exec(`
      update application_submission_attempt_ledger_cutovers
      set completed_at = clock_timestamp()
      where cutover_key = 'legacy_backfill_v1'
    `), /cutover markers are immutable/i);
    await assert.rejects(database.exec(`
      delete from application_submission_attempt_ledger_cutovers
      where cutover_key = 'legacy_backfill_v1'
    `), /cutover markers are immutable/i);

    const facts = await database.query<{ event_kind: string; proof_kind: string | null }>(`
      select event_kind, proof_kind from application_submission_attempt_events
      where user_id = '${userId}' and packet_id = '${packetId}' order by created_at, event_id
    `);
    assert.equal(facts.rows.filter((row) => row.event_kind === 'attempt_opened').length, 1);
    assert.deepEqual(
      new Set(facts.rows.flatMap((row) => row.proof_kind ? [row.proof_kind] : [])),
      new Set(SUBMISSION_NOT_SENT_PROOF_KINDS),
    );

    await assert.rejects(database.exec(`
      delete from application_submission_attempt_events where event_id = '${openedEventId}'
    `), /privacy erasure/i);
    await assert.rejects(database.exec(`
      delete from application_submission_attempt_bindings
      where user_id = '${userId}' and attempt_id = '${attemptId}'
    `), /privacy erasure/i);
    await database.exec(`delete from users where id = '${userId}'`);
    const afterPrivacyErasure = await database.query<{ total: number }>(`
      select count(*)::int as total from application_submission_attempt_events
      where user_id = '${userId}'
    `);
    assert.equal(afterPrivacyErasure.rows[0]?.total, 0, 'account erasure must cascade through the ledger');
    const bindingsAfterPrivacyErasure = await database.query<{ total: number }>(`
      select count(*)::int as total from application_submission_attempt_bindings
      where user_id = '${userId}'
    `);
    assert.equal(bindingsAfterPrivacyErasure.rows[0]?.total, 0, 'account erasure must cascade through bindings');
  } finally {
    await server?.stop().catch(() => undefined);
    await database.close().catch(() => undefined);
    rmSync(socketDir, { recursive: true, force: true });
  }
});
