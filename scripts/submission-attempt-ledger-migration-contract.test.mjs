import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import pg from 'pg';

const MIGRATION = 'scripts/apply-submission-attempt-ledger-schema.mjs';

function startMigration(databaseUrl, extraEnv = {}) {
  const child = spawn(process.execPath, [MIGRATION], {
    cwd: process.cwd(),
    env: { ...process.env, ...extraEnv, DATABASE_URL: databaseUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Migration exited ${code}: ${stderr || stdout}`));
    });
  });

  const waitForStdout = (fragment) => {
    if (stdout.includes(fragment)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onData = () => {
        if (!stdout.includes(fragment)) return;
        cleanup();
        resolve();
      };
      const onClose = (code) => {
        cleanup();
        reject(new Error(`Migration exited ${code} before emitting ${fragment}: ${stderr || stdout}`));
      };
      const cleanup = () => {
        child.stdout.off('data', onData);
        child.off('close', onClose);
      };
      child.stdout.on('data', onData);
      child.on('close', onClose);
    });
  };

  return { completed, waitForStdout };
}

function runMigration(databaseUrl, extraEnv = {}) {
  return startMigration(databaseUrl, extraEnv).completed;
}

async function createEmptyLegacySourceSchema(database) {
  const sql = `
    create table users (
      id uuid primary key,
      email text not null
    );
    create table generated_resumes (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      job_context jsonb not null default '{}'::jsonb,
      spec jsonb not null default '{}'::jsonb,
      resume_object_key text,
      pipeline_stage text,
      created_at timestamptz not null default now()
    );
    create table applications (
      id uuid primary key,
      user_id uuid not null references users(id) on delete cascade,
      legacy_generated_resume_id uuid,
      submission_state text,
      tracker_state text,
      company_name text not null,
      role text not null,
      job_id uuid,
      portal_url text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create table application_submission_events (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      application_id uuid not null references applications(id) on delete cascade,
      event_id uuid not null,
      outcome text not null,
      final_url text not null,
      portal_identity text,
      created_at timestamptz not null default now(),
      observed_at timestamptz not null default now()
    );
    create table autofill_events (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      ats_name text not null,
      job_context jsonb not null,
      fields_filled integer default 0,
      fields_skipped integer default 0,
      submitted_by_user boolean,
      auto_submitted boolean default false,
      created_at timestamptz default now()
    )
  `;
  if (typeof database.exec === 'function') await database.exec(sql);
  else await database.query(sql);
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

async function startEphemeralPostgres() {
  let bindir = '';
  try {
    bindir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`pg_config is required for the source-lock contract: ${error.message}`);
  }
  const initdb = join(bindir, 'initdb');
  const postgres = join(bindir, 'postgres');
  if (!existsSync(initdb) || !existsSync(postgres)) {
    throw new Error(`PostgreSQL server binaries are required in ${bindir}`);
  }

  const rootDir = mkdtempSync('/tmp/litos-ledger-postgres-');
  const dataDir = join(rootDir, 'data');
  const socketDir = join(rootDir, 'socket');
  mkdirSync(socketDir);
  await runProcess(initdb, [
    '--pgdata', dataDir,
    '--auth=trust',
    '--encoding=UTF8',
    '--no-locale',
    '--username=postgres',
  ]);

  const port = 54321;
  const child = spawn(postgres, [
    '-D', dataDir,
    '-p', String(port),
    '-h', '',
    '-k', socketDir,
    '-F',
    '-c', 'synchronous_commit=off',
    '-c', 'full_page_writes=off',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  const databaseUrl = `postgresql://postgres@localhost:${port}/postgres?host=${socketDir}`;

  let ready = false;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) break;
    const probe = new pg.Client({ connectionString: databaseUrl });
    try {
      await probe.connect();
      await probe.query('select 1');
      ready = true;
      await probe.end();
      break;
    } catch {
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!ready) {
    child.kill('SIGTERM');
    rmSync(rootDir, { recursive: true, force: true });
    throw new Error(`Ephemeral PostgreSQL did not become ready: ${logs}`);
  }

  const stop = async () => {
    if (child.exitCode === null) {
      const closed = new Promise((resolve) => child.once('close', resolve));
      child.kill('SIGTERM');
      await closed;
    }
    rmSync(rootDir, { recursive: true, force: true });
  };
  return { databaseUrl, stop };
}

test('migration-only release wiring has no runtime ledger dependency', () => {
  const source = readFileSync(new URL(import.meta.url), 'utf8');
  const imports = source.match(/^import[^;]+;/gm)?.join('\n') ?? '';
  assert.doesNotMatch(imports, /from ['"]\.\.\/src\//);
  assert.doesNotMatch(imports, /submissionAttemptLedger|duplicateApplication|db\/schema/);
  const migrationSource = readFileSync(MIGRATION, 'utf8');
  const migrationImports = migrationSource.match(/^import[^;]+;/gm)?.join('\n') ?? '';
  assert.doesNotMatch(migrationImports, /from ['"]\.\.\/src\//);
  assert.doesNotMatch(migrationImports, /submissionAttemptLedger|duplicateApplication|db\/schema/);
  const advisoryLock = migrationSource.indexOf("pg_advisory_xact_lock($1, $2)', [1414090051, 20260826]");
  const sourceLock = migrationSource.indexOf('lock table\n        generated_resumes');
  const ownershipPreflight = migrationSource.indexOf('legacyEventOwnershipMismatch');
  const markerDecision = migrationSource.indexOf('const cutoverState');
  assert.ok(advisoryLock >= 0);
  assert.ok(sourceLock > advisoryLock);
  assert.ok(ownershipPreflight > sourceLock);
  assert.ok(markerDecision > ownershipPreflight);
  const sourceLockSql = migrationSource.slice(sourceLock, ownershipPreflight);
  for (const table of [
    'generated_resumes',
    'applications',
    'application_submission_events',
    'autofill_events',
  ]) assert.match(sourceLockSql, new RegExp(`\\b${table}\\b`));
  assert.match(sourceLockSql, /in share mode/);

  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(
    packageJson.scripts?.['test:submission-attempt-ledger-migration'],
    'node --test scripts/submission-attempt-ledger-migration-contract.test.mjs',
  );
  assert.equal(
    packageJson.scripts?.['db:submission-attempt-ledger'],
    `node ${MIGRATION}`,
  );

  const workflow = readFileSync('.github/workflows/submission-attempt-ledger-migration.yml', 'utf8');
  const proof = workflow.indexOf('npm run test:submission-attempt-ledger-migration');
  const firstFreezeProof = workflow.indexOf('Require the exact frozen backend revision');
  const fenceProof = workflow.indexOf('Prove issuer and worker fences are active');
  const oldBackendDrain = workflow.indexOf('sleep 310');
  const secondFreezeProof = workflow.indexOf('Recheck the same frozen revision after the drain');
  const production = workflow.indexOf('npm run db:submission-attempt-ledger');
  const postMigrationFreezeProof = workflow.indexOf('Require freeze remained active through migration');
  assert.ok(proof >= 0);
  assert.ok(firstFreezeProof > proof);
  assert.ok(fenceProof > firstFreezeProof);
  assert.ok(oldBackendDrain > fenceProof);
  assert.ok(secondFreezeProof > oldBackendDrain);
  assert.ok(production > secondFreezeProof);
  assert.ok(postMigrationFreezeProof > production);
  assert.match(workflow, /\.submission_cutover\.mode == "freeze"/);
  assert.match(workflow, /\.submission_cutover\.config_valid == true/);
  assert.match(workflow, /\.revision == \$revision/);
  assert.match(workflow, /SUBMISSION_CUTOVER_FROZEN/);
  assert.match(workflow.slice(postMigrationFreezeProof), /\.revision == \$revision/);
  assert.doesNotMatch(workflow, /src\/db\/submissionAttemptLedgerMigration\.test\.ts/);

  const runbook = readFileSync('DEPLOY.md', 'utf8');
  assert.match(runbook, /migration-only\s+release/);
  assert.match(runbook, /test:submission-attempt-ledger-migration/);
  assert.match(runbook, /Old backend behavior remains byte-equivalent/);
});

test('ownership preflight rejects a legacy event attributed to another application owner', async () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'litos-ledger-ownership-preflight-'));
  const database = await PGlite.create();
  let server = null;
  try {
    const applicationOwnerId = 'b1264d0f-a921-466a-9652-faf1565ec001';
    const eventOwnerId = 'b1264d0f-a921-466a-9652-faf1565ec002';
    const applicationId = 'b1264d0f-a921-466a-9652-faf1565ec003';
    const eventId = 'b1264d0f-a921-466a-9652-faf1565ec004';
    await createEmptyLegacySourceSchema(database);
    await database.exec(`
      insert into users (id, email) values
        ('${applicationOwnerId}', 'application-owner@example.test'),
        ('${eventOwnerId}', 'event-owner@example.test');
      insert into applications (
        id, user_id, submission_state, tracker_state, company_name, role, portal_url
      ) values (
        '${applicationId}', '${applicationOwnerId}', 'needs_attention', 'applying',
        'Ownership Co', 'Engineer', 'https://ownership.example/jobs/engineer'
      );
      insert into application_submission_events (
        id, user_id, application_id, event_id, outcome, final_url, portal_identity
      ) values (
        '${eventId}', '${eventOwnerId}', '${applicationId}',
        'b1264d0f-a921-466a-9652-faf1565ec005', 'unknown',
        'https://ownership.example/jobs/engineer', 'https://ownership.example'
      )
    `);

    server = new PGLiteSocketServer({
      db: database,
      path: join(socketDir, '.s.PGSQL.5432'),
      maxConnections: 5,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

    await assert.rejects(
      runMigration(databaseUrl),
      new RegExp(
        `ownership mismatch: event ${eventId} belongs to user ${eventOwnerId}, `
        + `application belongs to ${applicationOwnerId}`,
      ),
    );
    const afterFailure = await database.query(`
      select
        to_regclass('application_submission_attempt_events') is null as no_event_ledger,
        to_regclass('application_submission_attempt_bindings') is null as no_binding_ledger,
        to_regclass('application_submission_attempt_ledger_cutovers') is null as no_marker_table,
        (select count(*)::int from application_submission_events) as source_events
    `);
    assert.deepEqual(afterFailure.rows[0], {
      no_event_ledger: true,
      no_binding_ledger: true,
      no_marker_table: true,
      source_events: 1,
    });
  } finally {
    await server?.stop().catch(() => undefined);
    await database.close().catch(() => undefined);
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test('source SHARE lock defers a concurrent autofill write until the marker commits', async () => {
  let postgresServer = null;
  let setup = null;
  let writer = null;
  try {
    const userId = 'c1264d0f-a921-466a-9652-faf1565ec001';
    const autofillEventId = 'c1264d0f-a921-466a-9652-faf1565ec002';
    const packetId = 'c1264d0f-a921-466a-9652-faf1565ec003';
    const attemptId = 'c1264d0f-a921-466a-9652-faf1565ec004';
    postgresServer = await startEphemeralPostgres();
    setup = new pg.Client({ connectionString: postgresServer.databaseUrl });
    await setup.connect();
    await createEmptyLegacySourceSchema(setup);
    await setup.query(`
      insert into users (id, email)
      values ('${userId}', 'source-lock@example.test')
    `);
    await setup.end();
    setup = null;

    const migration = startMigration(postgresServer.databaseUrl, {
      NODE_ENV: 'test',
      SUBMISSION_ATTEMPT_LEDGER_TEST_SOURCE_LOCK_HOLD_MS: '1000',
    });
    await migration.waitForStdout('Test hook: legacy source locks acquired.');

    writer = new pg.Client({ connectionString: postgresServer.databaseUrl });
    await writer.connect();
    await writer.query('begin');
    let sourceInsertSettled = false;
    const concurrentWrite = (async () => {
      await writer.query(`
        insert into autofill_events (
          id, user_id, ats_name, job_context, fields_filled, fields_skipped,
          submitted_by_user, auto_submitted, created_at
        ) values (
          '${autofillEventId}', '${userId}', 'workable',
          '{"company":"Post Marker Co","role":"Safety Engineer"}'::jsonb,
          1, 0, false, true, '2026-08-26T10:00:00Z'
        )
      `);
      sourceInsertSettled = true;
      const marker = await writer.query(`
        select exists (
          select 1 from application_submission_attempt_ledger_cutovers
          where cutover_key = 'legacy_backfill_v1'
        ) as marker_visible
      `);

      /* A writer admitted after the marker follows the live dual-write contract. This proves the
         blocked source fact does not disappear after being forced out of the legacy snapshot. */
      await writer.query(`
        insert into application_submission_attempt_events (
          user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
          company_role, company_name, role, evidence_code, observed_at
        ) values
        (
          '${userId}', '${packetId}', 'c1264d0f-a921-466a-9652-faf1565ec005', '${attemptId}',
          'attempt_opened', 'chrome_extension', 'initial_submission',
          'post marker co|safety engineer', 'Post Marker Co', 'Safety Engineer',
          'live_autofill_auto_submit_report', '2026-08-26T10:00:00Z'
        ),
        (
          '${userId}', '${packetId}', 'c1264d0f-a921-466a-9652-faf1565ec006', '${attemptId}',
          'press_observed', 'chrome_extension', 'initial_submission',
          'post marker co|safety engineer', 'Post Marker Co', 'Safety Engineer',
          'live_autofill_auto_submit_click', '2026-08-26T10:00:00Z'
        )
      `);
      await writer.query('commit');
      return marker.rows[0]?.marker_visible === true;
    })();

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      sourceInsertSettled,
      false,
      'the source mutation must wait while the migration owns the SHARE lock',
    );

    const [migrationResult, markerWasVisible] = await Promise.all([
      migration.completed,
      concurrentWrite,
    ]);
    assert.match(migrationResult.stdout, /immutable submission attempt ledger schema is present/);
    assert.equal(markerWasVisible, true, 'the deferred writer may proceed only after marker commit');

    const finalState = await writer.query(`
      select
        (select count(*)::int from autofill_events where id = '${autofillEventId}') as source_facts,
        (select count(*)::int from application_submission_attempt_events
          where attempt_id = '${attemptId}') as ledger_facts,
        (select count(*)::int from application_submission_attempt_ledger_cutovers
          where cutover_key = 'legacy_backfill_v1') as markers
    `);
    assert.deepEqual(finalState.rows[0], { source_facts: 1, ledger_facts: 2, markers: 1 });
  } finally {
    if (setup) await setup.end().catch(() => undefined);
    if (writer) {
      await writer.query('rollback').catch(() => undefined);
      await writer.end().catch(() => undefined);
    }
    await postgresServer?.stop().catch(() => undefined);
  }
});

test('standalone migration creates, backfills, verifies, and preserves immutable evidence', async () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'litos-ledger-migration-contract-'));
  const database = await PGlite.create();
  let server = null;
  try {
    const userId = 'd1264d0f-a921-466a-9652-faf1565ec001';
    const resolvedPacketId = 'd1264d0f-a921-466a-9652-faf1565ec002';
    const unresolvedPacketId = 'd1264d0f-a921-466a-9652-faf1565ec006';
    const claimedPacketId = 'd1264d0f-a921-466a-9652-faf1565ec00a';
    const maxPacketId = 'c43b9eeb-c1f3-4fd9-b9ba-d74e4dd0ad30';
    const terminalApplicationId = 'd1264d0f-a921-466a-9652-faf1565ec003';
    const unknownApplicationId = 'd1264d0f-a921-466a-9652-faf1565ec004';
    const unknownEventId = 'd1264d0f-a921-466a-9652-faf1565ec005';
    const postCutoverPacketId = 'd1264d0f-a921-466a-9652-faf1565ec007';
    const postCutoverApplicationId = 'd1264d0f-a921-466a-9652-faf1565ec008';
    const rawGeneratedPacketId = 'd1264d0f-a921-466a-9652-faf1565ec020';
    const linkedDefaultApplicationId = 'd1264d0f-a921-466a-9652-faf1565ec021';
    const blankPortalApplicationId = 'd1264d0f-a921-466a-9652-faf1565ec022';
    const autoTrueEventId = 'd1264d0f-a921-466a-9652-faf1565ec023';
    const autoTrueSecondEventId = 'd1264d0f-a921-466a-9652-faf1565ec024';
    const autoBlankEventId = 'd1264d0f-a921-466a-9652-faf1565ec025';
    const autoFalseEventId = 'd1264d0f-a921-466a-9652-faf1565ec026';
    const autoNullEventId = 'd1264d0f-a921-466a-9652-faf1565ec027';
    const terminalGeneratedPacketId = 'd1264d0f-a921-466a-9652-faf1565ec028';

    await database.exec(`
      create table users (
        id uuid primary key,
        email text not null
      );
      create table generated_resumes (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        job_context jsonb not null default '{}'::jsonb,
        spec jsonb not null default '{}'::jsonb,
        resume_object_key text,
        pipeline_stage text,
        created_at timestamptz not null default now()
      );
      create table applications (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        legacy_generated_resume_id uuid,
        submission_state text,
        tracker_state text,
        company_name text not null,
        role text not null,
        job_id uuid,
        portal_url text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table application_submission_events (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        application_id uuid not null references applications(id) on delete cascade,
        event_id uuid not null,
        outcome text not null,
        final_url text not null,
        portal_identity text,
        created_at timestamptz not null default now(),
        observed_at timestamptz not null default now()
      );
      create table autofill_events (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        ats_name text not null,
        job_context jsonb not null,
        fields_filled integer default 0,
        fields_skipped integer default 0,
        submitted_by_user boolean,
        auto_submitted boolean default false,
        created_at timestamptz default now()
      );

      insert into users (id, email) values ('${userId}', 'migration-contract@example.test');
      insert into generated_resumes (
        id, user_id, job_context, spec, resume_object_key, pipeline_stage, created_at
      ) values
      (
        '${resolvedPacketId}', '${userId}',
        '{"company":"Resolved Co","role":"Engineer","job_id":"JOB-RESOLVED"}'::jsonb,
        '{"_review":{"status":"needs_attention","portal_url":"https://jobs.ashbyhq.com/resolved/1","submission_run_id":"resolved-run","submission_attempted_at":"2026-08-21T10:00:00Z","unverified_submission":{"at":"2026-08-21T10:00:00Z","submission_run_id":"resolved-run","resolution":"not_sent","resolved_at":"2026-08-21T11:00:00Z"}}}'::jsonb,
        'resumes/resolved.pdf', null, '2026-08-21T09:00:00Z'
      ),
      (
        '${unresolvedPacketId}', '${userId}',
        '{"company":"Unresolved Co","role":"Safety Engineer","job_id":"JOB-UNRESOLVED"}'::jsonb,
        '{"_review":{"status":"needs_attention","portal_url":"https://jobs.ashbyhq.com/unresolved/1","submission_run_id":"unresolved-run","submission_attempted_at":"2026-08-22T10:00:00Z","unverified_submission":{"at":"2026-08-22T10:00:00Z","submission_run_id":"unresolved-run"}}}'::jsonb,
        'resumes/unresolved.pdf', null, '2026-08-22T09:00:00Z'
      ),
      (
        '${claimedPacketId}', '${userId}',
        '{"company":"Claimed Co","role":"Cutover Engineer","job_id":"JOB-CLAIMED"}'::jsonb,
        '{"_review":{"status":"submission_claimed","portal_url":"https://jobs.lever.co/claimed/1","submission_run_id":"claimed-run","submission_claim_id":"d1264d0f-a921-466a-9652-faf1565ec00b","submission_claimed_at":"2026-08-22T12:00:00Z"}}'::jsonb,
        'resumes/claimed.pdf', null, '2026-08-22T11:00:00Z'
      ),
      (
        '${maxPacketId}', '${userId}',
        '{"company":"Max Borges Agency","role":"Public Relations Account Executive","job_id":"1149b1b6-8ea9-4cde-ae5f-15a1ecb9849b"}'::jsonb,
        '{"_review":{"status":"needs_attention","portal_url":"https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply/","submission_run_id":"latest-safe-run","submission_stop":{"before_click":true,"at":"2026-08-24T08:00:00Z","submission_run_id":"latest-safe-run"}}}'::jsonb,
        'resumes/max.pdf', null, '2026-08-24T07:00:00Z'
      ),
      (
        '${rawGeneratedPacketId}', '${userId}',
        '{"company":"Linked Capability Co","role":"Research Engineer"}'::jsonb,
        '{}'::jsonb, 'resumes/raw-generated.pdf', null, '2026-08-18T07:00:00Z'
      ),
      (
        '${terminalGeneratedPacketId}', '${userId}',
        '{"company":"Terminal Packet Co","role":"Staff Engineer"}'::jsonb,
        '{"_review":{"status":"submitted","portal_url":"https://terminal-packet.example/apply","submitted_at":"2026-08-19T10:00:00Z"}}'::jsonb,
        'resumes/terminal-generated.pdf', null, '2026-08-19T09:00:00Z'
      );
      insert into applications (
        id, user_id, submission_state, tracker_state, company_name, role, job_id,
        portal_url, created_at, updated_at
      ) values
      (
        '${terminalApplicationId}', '${userId}', 'submitted', 'applied',
        'Terminal Co', 'Platform Engineer', 'd1264d0f-a921-466a-9652-faf1565ec013',
        'https://terminal.example/jobs/platform', '2026-08-20T09:00:00Z', '2026-08-20T10:00:00Z'
      ),
      (
        '${unknownApplicationId}', '${userId}', 'needs_attention', 'applying',
        'Unknown Co', 'Risk Engineer', 'd1264d0f-a921-466a-9652-faf1565ec014',
        'https://unknown.example/jobs/risk', '2026-08-22T09:00:00Z', '2026-08-22T10:00:00Z'
      ),
      (
        '${linkedDefaultApplicationId}', '${userId}', 'not_started', 'saved',
        'Linked Capability Co', 'Research Engineer', 'd1264d0f-a921-466a-9652-faf1565ec029',
        'https://linked.example/jobs/research', '2026-08-18T08:00:00Z', '2026-08-18T08:00:00Z'
      ),
      (
        '${blankPortalApplicationId}', '${userId}', 'not_started', 'saved',
        'Blank Portal Co', 'Analyst', 'd1264d0f-a921-466a-9652-faf1565ec030',
        null, '2026-08-18T08:00:00Z', '2026-08-18T08:00:00Z'
      );
      update applications
      set legacy_generated_resume_id = '${rawGeneratedPacketId}'
      where id = '${linkedDefaultApplicationId}';
      insert into application_submission_events (
        user_id, application_id, event_id, outcome, final_url, portal_identity,
        created_at, observed_at
      ) values (
        '${userId}', '${unknownApplicationId}', '${unknownEventId}', 'unknown',
        'https://unknown.example/jobs/risk', 'https://unknown.example',
        '2026-08-22T10:00:00Z', '2026-08-22T10:00:00Z'
      );
      insert into autofill_events (
        id, user_id, ats_name, job_context, fields_filled, fields_skipped,
        submitted_by_user, auto_submitted, created_at
      ) values
      (
        '${autoTrueEventId}', '${userId}', 'workable',
        '{"company":"Signal Co","role":"Safety Engineer"}'::jsonb,
        0, 3, false, true, '2026-08-17T10:00:00Z'
      ),
      (
        '${autoTrueSecondEventId}', '${userId}', 'workable',
        '{"company":"Signal Co","role":"Safety Engineer"}'::jsonb,
        0, 0, false, true, '2026-08-17T10:01:00Z'
      ),
      (
        '${autoBlankEventId}', '${userId}', 'custom',
        '{"company":"","role":""}'::jsonb,
        0, 0, false, true, '2026-08-17T10:02:00Z'
      ),
      (
        '${autoFalseEventId}', '${userId}', 'greenhouse',
        '{"company":"False Signal Co","role":"Engineer"}'::jsonb,
        4, 1, true, false, '2026-08-17T10:03:00Z'
      ),
      (
        '${autoNullEventId}', '${userId}', 'workday',
        '{"company":"Null Signal Co","role":"Engineer"}'::jsonb,
        5, 0, true, null, '2026-08-17T10:04:00Z'
      );
    `);

    server = new PGLiteSocketServer({
      db: database,
      path: join(socketDir, '.s.PGSQL.5432'),
      maxConnections: 5,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
    const first = await runMigration(databaseUrl);
    const afterFirst = await database.query(`
      select count(*)::int as total from application_submission_attempt_events
    `);
    const markerAfterFirst = await database.query(`
      select cutover_key, completed_at
      from application_submission_attempt_ledger_cutovers
    `);
    assert.equal(markerAfterFirst.rows.length, 1);
    assert.equal(markerAfterFirst.rows[0].cutover_key, 'legacy_backfill_v1');

    /* Resolve the already-imported unresolved attempt through the runtime ledger, then mutate the
       source snapshot. A replaying backfill would append a second terminal fact to this attempt. */
    await database.exec(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, parent_attempt_id,
        event_kind, source, operation, submission_run_id, submission_claim_id, packet_version,
        posting_key, job_id, company_role, company_name, role, portal_url, portal_identity,
        proof_kind, evidence_code, observed_at
      )
      select
        binding.user_id, binding.application_id, binding.packet_id,
        'd1264d0f-a921-466a-9652-faf1565ec009'::uuid, binding.attempt_id,
        binding.parent_attempt_id, 'not_sent_proven', binding.source, binding.operation,
        binding.submission_run_id, binding.submission_claim_id, binding.packet_version,
        binding.posting_key, binding.job_id, binding.company_role, binding.company_name,
        binding.role, binding.portal_url, binding.portal_identity,
        'applicant_checked_not_sent', 'runtime_resolution_after_cutover',
        '2026-08-22T11:00:00Z'::timestamptz
      from application_submission_attempt_bindings binding
      where binding.user_id = '${userId}' and binding.packet_id = '${unresolvedPacketId}'
        and exists (
          select 1 from application_submission_attempt_events opened
          where opened.user_id = binding.user_id
            and opened.attempt_id = binding.attempt_id
            and opened.evidence_code = 'legacy_current_unresolved_risk'
        )
    `);
    await database.exec(`
      update generated_resumes
      set spec = '{"_review":{"status":"needs_attention","portal_url":"https://jobs.ashbyhq.com/unresolved/1","submission_run_id":"unresolved-run","submission_attempted_at":"2026-08-22T10:00:00Z","unverified_submission":{"at":"2026-08-22T10:00:00Z","submission_run_id":"unresolved-run","resolution":"not_sent","resolved_at":"2026-08-22T11:00:00Z"}}}'::jsonb
      where id = '${unresolvedPacketId}';

      update generated_resumes
      set
        job_context = '{"company":"Changed Submitted Co","role":"Changed Role","job_id":"CHANGED-JOB"}'::jsonb,
        spec = '{"_review":{"status":"submitted","portal_url":"https://changed.example/apply","submission_run_id":"changed-run","submitted_at":"2026-08-25T10:00:00Z"}}'::jsonb
      where id = '${resolvedPacketId}';

      insert into generated_resumes (
        id, user_id, job_context, spec, resume_object_key, pipeline_stage, created_at
      ) values (
        '${postCutoverPacketId}', '${userId}',
        '{"company":"Post Cutover Packet Co","role":"New Engineer","job_id":"POST-PACKET"}'::jsonb,
        '{"_review":{"status":"submitted","portal_url":"https://post-packet.example/apply","submission_run_id":"post-packet-run","submitted_at":"2026-08-25T12:00:00Z"}}'::jsonb,
        'resumes/post-cutover.pdf', 'applied', '2026-08-25T11:00:00Z'
      );

      insert into applications (
        id, user_id, submission_state, tracker_state, company_name, role, job_id,
        portal_url, created_at, updated_at
      ) values (
        '${postCutoverApplicationId}', '${userId}', 'submitted', 'applied',
        'Post Cutover Canonical Co', 'New Platform Engineer',
        'd1264d0f-a921-466a-9652-faf1565ec018',
        'https://post-canonical.example/jobs/platform',
        '2026-08-25T11:00:00Z', '2026-08-25T12:00:00Z'
      )
    `);
    const second = await runMigration(databaseUrl);
    const afterSecond = await database.query(`
      select count(*)::int as total from application_submission_attempt_events
    `);
    assert.match(first.stdout, /immutable submission attempt ledger schema is present/);
    assert.match(second.stdout, /immutable submission attempt ledger schema is present/);
    assert.equal(
      afterSecond.rows[0].total,
      afterFirst.rows[0].total + 1,
      'only the explicit runtime resolution may be added after cutover',
    );

    const resolved = await database.query(`
      select event_kind, proof_kind, evidence_code from application_submission_attempt_events
      where packet_id = '${resolvedPacketId}' order by event_kind, evidence_code
    `);
    assert.deepEqual(resolved.rows, [
      {
        event_kind: 'attempt_opened',
        proof_kind: null,
        evidence_code: 'legacy_current_resolved_not_sent',
      },
      {
        event_kind: 'attempt_opened',
        proof_kind: null,
        evidence_code: 'legacy_possible_unrecorded_generated_capability',
      },
      {
        event_kind: 'not_sent_proven',
        proof_kind: 'applicant_checked_not_sent',
        evidence_code: 'legacy_applicant_not_sent_resolution',
      },
    ]);

    const unresolved = await database.query(`
      select event_kind, proof_kind, evidence_code
      from application_submission_attempt_events
      where packet_id = '${unresolvedPacketId}'
      order by event_kind, evidence_code
    `);
    assert.deepEqual(unresolved.rows, [
      { event_kind: 'attempt_opened', proof_kind: null, evidence_code: 'legacy_current_unresolved_risk' },
      {
        event_kind: 'attempt_opened',
        proof_kind: null,
        evidence_code: 'legacy_possible_unrecorded_generated_capability',
      },
      {
        event_kind: 'not_sent_proven',
        proof_kind: 'applicant_checked_not_sent',
        evidence_code: 'runtime_resolution_after_cutover',
      },
      { event_kind: 'press_observed', proof_kind: null, evidence_code: 'legacy_current_press_evidence' },
    ]);
    assert.equal(
      unresolved.rows.filter((row) => row.event_kind === 'not_sent_proven').length,
      1,
      'a mutable resolution must not synthesize a second terminal fact on migration replay',
    );

    const claimed = await database.query(`
      select event_kind, evidence_code, observed_at::text as observed_at
      from application_submission_attempt_events
      where packet_id = '${claimedPacketId}'
      order by event_kind
    `);
    assert.deepEqual(claimed.rows.map((row) => [row.event_kind, row.evidence_code]), [
      ['attempt_opened', 'legacy_current_unresolved_risk'],
      ['attempt_opened', 'legacy_possible_unrecorded_generated_capability'],
      ['press_observed', 'legacy_current_press_evidence'],
    ]);
    assert.ok(
      claimed.rows
        .filter((row) => row.evidence_code !== 'legacy_possible_unrecorded_generated_capability')
        .every((row) => new Date(row.observed_at).toISOString() === '2026-08-22T12:00:00.000Z'),
      'a live pre-cutover claim is frozen as employer-contact risk at the claim boundary',
    );

    const frozenResolvedBinding = await database.query(`
      select binding.job_id, binding.company_role, binding.company_name, binding.role,
        binding.portal_url, binding.portal_identity
      from application_submission_attempt_bindings binding
      where binding.user_id = '${userId}' and binding.packet_id = '${resolvedPacketId}'
        and exists (
          select 1 from application_submission_attempt_events opened
          where opened.user_id = binding.user_id
            and opened.attempt_id = binding.attempt_id
            and opened.evidence_code = 'legacy_current_resolved_not_sent'
        )
    `);
    assert.equal(frozenResolvedBinding.rows.length, 1);
    assert.deepEqual(frozenResolvedBinding.rows[0], {
      job_id: 'job-resolved',
      company_role: 'resolved co|engineer',
      company_name: 'Resolved Co',
      role: 'Engineer',
      portal_url: 'https://jobs.ashbyhq.com/resolved/1',
      portal_identity: 'https://jobs.ashbyhq.com',
    });

    const postCutoverSyntheticFacts = await database.query(`
      select count(*)::int as total
      from application_submission_attempt_events
      where packet_id = '${postCutoverPacketId}'
        or application_id = '${postCutoverApplicationId}'
    `);
    assert.equal(
      postCutoverSyntheticFacts.rows[0].total,
      0,
      'post-cutover packet and canonical state must not be reinterpreted as legacy history',
    );

    const terminal = await database.query(`
      select event_kind from application_submission_attempt_events
      where application_id = '${terminalApplicationId}' order by event_kind
    `);
    assert.deepEqual(terminal.rows, [
      { event_kind: 'attempt_opened' },
      { event_kind: 'submission_confirmed' },
    ]);

    const unknown = await database.query(`
      select event_kind, evidence_code from application_submission_attempt_events
      where application_id = '${unknownApplicationId}' order by event_kind, evidence_code
    `);
    assert.deepEqual(unknown.rows, [
      {
        event_kind: 'attempt_opened',
        evidence_code: 'legacy_canonical_manual_unknown',
      },
      {
        event_kind: 'attempt_opened',
        evidence_code: 'legacy_possible_unrecorded_canonical_fill_capability',
      },
      {
        event_kind: 'press_observed',
        evidence_code: 'legacy_canonical_manual_unknown_press',
      },
    ]);

    const linkedCapability = await database.query(`
      select event_kind, operation, evidence_code, application_id, packet_id
      from application_submission_attempt_events
      where application_id = '${linkedDefaultApplicationId}'
      order by operation, evidence_code
    `);
    assert.deepEqual(linkedCapability.rows, [
      {
        event_kind: 'attempt_opened',
        operation: 'initial_submission',
        evidence_code: 'legacy_possible_unrecorded_generated_capability',
        application_id: linkedDefaultApplicationId,
        packet_id: rawGeneratedPacketId,
      },
      {
        event_kind: 'attempt_opened',
        operation: 'manual_submission',
        evidence_code: 'legacy_possible_unrecorded_canonical_fill_capability',
        application_id: linkedDefaultApplicationId,
        packet_id: rawGeneratedPacketId,
      },
    ]);
    const blankPortalFacts = await database.query(`
      select count(*)::int as total from application_submission_attempt_events
      where application_id = '${blankPortalApplicationId}'
    `);
    assert.equal(blankPortalFacts.rows[0].total, 0);
    const terminalCapabilityFacts = await database.query(`
      select count(*)::int as total from application_submission_attempt_events
      where packet_id = '${terminalGeneratedPacketId}'
        and evidence_code = 'legacy_possible_unrecorded_generated_capability'
    `);
    assert.equal(terminalCapabilityFacts.rows[0].total, 0);

    const autofillFacts = await database.query(`
      select
        event.event_kind,
        event.source,
        event.operation,
        event.company_role,
        event.application_id,
        event.packet_id,
        event.attempt_id,
        event.evidence_code,
        event.observed_at,
        event.created_at > min(event.created_at) over (
          partition by event.attempt_id
        ) as created_after_opening,
        autofill.id as autofill_event_id,
        autofill.created_at as autofill_created_at,
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
    assert.ok(autofillFacts.rows.every((row) => row.packet_is_namespaced === true));
    assert.ok(autofillFacts.rows.every((row) => row.packet_id !== row.autofill_event_id));
    assert.ok(autofillFacts.rows.every((row) =>
      new Date(row.observed_at).toISOString() === new Date(row.autofill_created_at).toISOString()));
    assert.deepEqual(
      new Set(autofillFacts.rows.map((row) => row.evidence_code)),
      new Set(['legacy_autofill_auto_submit_report', 'legacy_autofill_auto_submit_click']),
    );
    assert.deepEqual(
      autofillFacts.rows.filter((row) => row.autofill_event_id === autoTrueEventId)
        .map((row) => row.event_kind),
      ['attempt_opened', 'press_observed'],
    );
    assert.deepEqual(
      autofillFacts.rows.filter((row) => row.autofill_event_id === autoTrueSecondEventId)
        .map((row) => row.event_kind),
      ['attempt_opened', 'press_observed'],
    );
    const blankAutofillFacts = autofillFacts.rows
      .filter((row) => row.autofill_event_id === autoBlankEventId);
    assert.equal(blankAutofillFacts.length, 2);
    assert.ok(blankAutofillFacts.every((row) => row.company_role === null));
    for (const autofillId of [autoTrueEventId, autoTrueSecondEventId, autoBlankEventId]) {
      const pair = autofillFacts.rows.filter((row) => row.autofill_event_id === autofillId);
      assert.equal(pair[0].created_after_opening, false);
      assert.equal(pair[1].created_after_opening, true, 'press creation must order after its opening');
    }
    assert.equal(
      autofillFacts.rows.some((row) => [autoFalseEventId, autoNullEventId].includes(row.autofill_event_id)),
      false,
    );

    const maxHold = await database.query(`
      select event_kind, evidence_code, observed_at::text as observed_at
      from application_submission_attempt_events
      where packet_id = '${maxPacketId}' and evidence_code = 'vault_pressed_unverified_2026_08_20'
      order by event_kind
    `);
    assert.deepEqual(maxHold.rows.map((row) => [row.event_kind, row.evidence_code]), [
      ['attempt_opened', 'vault_pressed_unverified_2026_08_20'],
      ['press_observed', 'vault_pressed_unverified_2026_08_20'],
    ]);
    assert.ok(maxHold.rows.every((row) =>
      new Date(row.observed_at).toISOString() === '2026-08-20T00:00:00.000Z'));

    const triggers = await database.query(`
      select trigger_name from information_schema.triggers
      where event_object_table in (
        'application_submission_attempt_events', 'application_submission_attempt_bindings',
        'application_submission_attempt_ledger_cutovers'
      ) order by trigger_name
    `);
    assert.deepEqual(triggers.rows.map((row) => row.trigger_name), [
      'application_submission_attempt_bindings_no_direct_delete',
      'application_submission_attempt_bindings_no_update',
      'application_submission_attempt_events_no_direct_delete',
      'application_submission_attempt_events_no_update',
      'application_submission_attempt_events_one_binding',
      'application_submission_attempt_ledger_cutovers_no_delete',
      'application_submission_attempt_ledger_cutovers_no_update',
    ]);

    const columns = await database.query(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_events'
      order by ordinal_position
    `);
    assert.deepEqual(columns.rows.map((row) => row.column_name), [
      'id', 'user_id', 'application_id', 'packet_id', 'event_id', 'attempt_id',
      'parent_attempt_id', 'event_kind', 'source', 'operation', 'submission_run_id',
      'submission_claim_id', 'packet_version', 'posting_key', 'job_id', 'company_role',
      'company_name', 'role', 'portal_url', 'portal_identity', 'proof_kind', 'evidence_code',
      'boundary_activation_id', 'boundary_expires_at',
      'observed_at', 'created_at',
    ]);
    const bindingColumns = await database.query(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_bindings'
      order by ordinal_position
    `);
    assert.deepEqual(bindingColumns.rows.map((row) => row.column_name), [
      'user_id', 'attempt_id', 'application_id', 'packet_id', 'parent_attempt_id', 'source',
      'operation', 'submission_run_id', 'submission_claim_id', 'packet_version', 'posting_key',
      'job_id', 'company_role', 'company_name', 'role', 'portal_url', 'portal_identity', 'created_at',
    ]);
    const cutoverColumns = await database.query(`
      select column_name from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_submission_attempt_ledger_cutovers'
      order by ordinal_position
    `);
    assert.deepEqual(cutoverColumns.rows.map((row) => row.column_name), [
      'cutover_key', 'completed_at',
    ]);
    const indexes = await database.query(`
      select indexname from pg_indexes
      where schemaname = current_schema()
        and tablename = 'application_submission_attempt_events'
      order by indexname
    `);
    assert.deepEqual(indexes.rows.map((row) => row.indexname), [
      'application_submission_attempt_events_packet_time_idx',
      'application_submission_attempt_events_pkey',
      'application_submission_attempt_events_user_attempt_time_idx',
      'application_submission_attempt_events_user_company_role_idx',
      'application_submission_attempt_events_user_event_unique',
      'application_submission_attempt_events_user_job_idx',
      'application_submission_attempt_events_user_posting_idx',
      'submission_attempt_events_user_attempt_boundary_uq',
    ]);
    const constraints = await database.query(`
      select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conrelid in (
        'application_submission_attempt_events'::regclass,
        'application_submission_attempt_bindings'::regclass,
        'application_submission_attempt_ledger_cutovers'::regclass
      )
      order by conname
    `);
    const constraintNames = constraints.rows.map((row) => row.conname);
    for (const required of [
      'application_submission_attempt_bindings_operation_check',
      'application_submission_attempt_bindings_parent_check',
      'application_submission_attempt_bindings_pkey',
      'application_submission_attempt_bindings_source_check',
      'application_submission_attempt_ledger_cutovers_key_check',
      'application_submission_attempt_ledger_cutovers_pkey',
      'application_submission_attempt_events_kind_check',
      'submission_attempt_events_boundary_auth_check',
      'application_submission_attempt_events_operation_check',
      'application_submission_attempt_events_parent_check',
      'application_submission_attempt_events_pkey',
      'application_submission_attempt_events_proof_check',
      'application_submission_attempt_events_source_check',
    ]) assert.ok(constraintNames.includes(required), required);
    const proofConstraint = constraints.rows.find(
      (row) => row.conname === 'application_submission_attempt_events_proof_check',
    )?.definition ?? '';
    const kindConstraint = constraints.rows.find(
      (row) => row.conname === 'application_submission_attempt_events_kind_check',
    )?.definition ?? '';
    for (const eventKind of [
      'attempt_opened',
      'boundary_authorized',
      'press_observed',
      'submission_confirmed',
      'not_sent_proven',
    ]) assert.match(kindConstraint, new RegExp(eventKind));
    const boundaryConstraint = constraints.rows.find(
      (row) => row.conname === 'submission_attempt_events_boundary_auth_check',
    )?.definition ?? '';
    assert.match(boundaryConstraint, /boundary_activation_id/);
    assert.match(boundaryConstraint, /boundary_expires_at/);
    assert.match(boundaryConstraint, /boundary_expires_at.*observed_at/is);
    for (const proof of [
      'typed_pre_click_stop',
      'applicant_checked_not_sent',
      'applicant_checked_all_possible_destinations_not_sent',
      'employer_rejected_not_filed',
      'employer_verification_pending_not_filed',
      'provider_definitive_rejection',
      'extension_cancelled_before_press',
    ]) assert.match(proofConstraint, new RegExp(proof));

    const invalidEvent = (suffix, eventKind, source, operation, proofSql = 'null') => database.exec(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_name, role, proof_kind
      ) values (
        '${userId}', '${resolvedPacketId}',
        'e1264d0f-a921-466a-9652-faf1565ec0${suffix}',
        'f1264d0f-a921-466a-9652-faf1565ec0${suffix}',
        '${eventKind}', '${source}', '${operation}', 'Invalid Co', 'Invalid Role', ${proofSql}
      )
    `);
    await assert.rejects(invalidEvent('11', 'bogus', 'legacy_backfill', 'initial_submission'), /check constraint/);
    await assert.rejects(invalidEvent('12', 'attempt_opened', 'bogus', 'initial_submission'), /check constraint/);
    await assert.rejects(invalidEvent('13', 'attempt_opened', 'legacy_backfill', 'bogus'), /check constraint/);
    await assert.rejects(invalidEvent(
      '14',
      'not_sent_proven',
      'legacy_backfill',
      'initial_submission',
      "'invented_proof'",
    ), /check constraint/);
    await assert.rejects(
      invalidEvent('16', 'boundary_authorized', 'legacy_backfill', 'manual_submission'),
      /check constraint/,
    );
    await database.exec(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_name, role, boundary_activation_id, boundary_expires_at, observed_at, created_at
      ) values (
        '${userId}', '${resolvedPacketId}',
        'e1264d0f-a921-466a-9652-faf1565ec017',
        'f1264d0f-a921-466a-9652-faf1565ec017',
        'boundary_authorized', 'legacy_backfill', 'manual_submission',
        'Authorized Co', 'Authorized Role', 'a1264d0f-a921-466a-9652-faf1565ec017',
        '2026-08-24T12:03:00Z', '2026-08-24T12:00:00Z', '2026-08-24T12:00:00Z'
      )
    `);
    await assert.rejects(invalidEvent(
      '15',
      'attempt_opened',
      'legacy_backfill',
      'initial_submission',
      "'typed_pre_click_stop'",
    ), /check constraint/);

    const [sample] = (await database.query(`
      select id, attempt_id, packet_id, application_id, company_name, role
      from application_submission_attempt_events where user_id = '${userId}' limit 1
    `)).rows;
    const relationId = 'd1264d0f-a921-466a-9652-faf1565ec071';
    const candidateApplicationId = 'd1264d0f-a921-466a-9652-faf1565ec072';
    const candidatePacketId = 'd1264d0f-a921-466a-9652-faf1565ec073';
    const candidateDigest = 'a'.repeat(64);
    await database.exec(`
      insert into application_posting_distinctions (
        user_id, relation_id, prior_attempt_id,
        candidate_application_id, candidate_packet_id,
        candidate_identity_version, candidate_identity_digest, candidate_identity_snapshot,
        candidate_company_role, candidate_portal_url, proof_kind
      ) values (
        '${userId}', '${relationId}', '${sample.attempt_id}',
        '${candidateApplicationId}', '${candidatePacketId}',
        'posting-distinction-candidate-v1', '${candidateDigest}',
        '{"version":"posting-distinction-candidate-v1","posting_key":null,"job_id":null,"company_role":"candidate co|engineer","portal_url":"https://candidate.example/jobs/2002"}'::jsonb,
        'candidate co|engineer', 'https://candidate.example/jobs/2002',
        'applicant_confirmed_distinct_posting_pair'
      )
    `);
    const distinction = await database.query(`
      select relation_id, prior_attempt_id, candidate_application_id, candidate_packet_id,
        candidate_identity_version, candidate_identity_digest, proof_kind
      from application_posting_distinctions
      where user_id = '${userId}' and relation_id = '${relationId}'
    `);
    assert.deepEqual(distinction.rows, [{
      relation_id: relationId,
      prior_attempt_id: sample.attempt_id,
      candidate_application_id: candidateApplicationId,
      candidate_packet_id: candidatePacketId,
      candidate_identity_version: 'posting-distinction-candidate-v1',
      candidate_identity_digest: candidateDigest,
      proof_kind: 'applicant_confirmed_distinct_posting_pair',
    }]);
    await assert.rejects(database.exec(`
      insert into application_posting_distinctions (
        user_id, relation_id, prior_attempt_id,
        candidate_application_id, candidate_packet_id,
        candidate_identity_version, candidate_identity_digest, candidate_identity_snapshot,
        candidate_portal_url, proof_kind
      ) values (
        '${userId}', '${relationId}', '${sample.attempt_id}',
        'd1264d0f-a921-466a-9652-faf1565ec074', 'd1264d0f-a921-466a-9652-faf1565ec075',
        'posting-distinction-candidate-v1', '${'b'.repeat(64)}', '{}'::jsonb,
        'https://candidate.example/jobs/2003', 'applicant_confirmed_distinct_posting_pair'
      )
    `), /unique constraint/);
    await assert.rejects(database.exec(`
      insert into application_posting_distinctions (
        user_id, relation_id, prior_attempt_id,
        candidate_application_id, candidate_packet_id,
        candidate_identity_version, candidate_identity_digest, candidate_identity_snapshot,
        candidate_company_role, candidate_portal_url, proof_kind
      ) values (
        '${userId}', 'd1264d0f-a921-466a-9652-faf1565ec076', '${sample.attempt_id}',
        '${candidateApplicationId}', '${candidatePacketId}',
        'posting-distinction-candidate-v1', '${candidateDigest}', '{}'::jsonb,
        'candidate co|engineer', 'https://candidate.example/jobs/2002',
        'applicant_confirmed_distinct_posting_pair'
      )
    `), /unique constraint/);
    await assert.rejects(database.exec(`
      insert into application_posting_distinctions (
        user_id, relation_id, prior_attempt_id,
        candidate_application_id, candidate_packet_id,
        candidate_identity_version, candidate_identity_digest, candidate_identity_snapshot,
        candidate_portal_url, proof_kind
      ) values (
        '${userId}', 'd1264d0f-a921-466a-9652-faf1565ec077',
        'd1264d0f-a921-466a-9652-faf1565ec078',
        '${candidateApplicationId}', '${candidatePacketId}',
        'posting-distinction-candidate-v1', '${candidateDigest}', '{}'::jsonb,
        'https://candidate.example/jobs/2002', 'applicant_confirmed_distinct_posting_pair'
      )
    `), /foreign key constraint/);
    await assert.rejects(
      database.exec(`update application_submission_attempt_events set role = 'Changed' where id = '${sample.id}'`),
      /append-only/,
    );
    await assert.rejects(
      database.exec(`delete from application_submission_attempt_events where id = '${sample.id}'`),
      /privacy erasure/,
    );
    await assert.rejects(
      database.exec(`
        update application_posting_distinctions
        set candidate_portal_url = 'https://candidate.example/jobs/changed'
        where relation_id = '${relationId}'
      `),
      /append-only/,
    );
    await assert.rejects(
      database.exec(`delete from application_posting_distinctions where relation_id = '${relationId}'`),
      /privacy erasure/,
    );
    await assert.rejects(
      database.exec(`
        update application_submission_attempt_ledger_cutovers
        set completed_at = clock_timestamp()
        where cutover_key = 'legacy_backfill_v1'
      `),
      /cutover markers are immutable/,
    );
    await assert.rejects(
      database.exec(`
        delete from application_submission_attempt_ledger_cutovers
        where cutover_key = 'legacy_backfill_v1'
      `),
      /cutover markers are immutable/,
    );
    await assert.rejects(database.exec(`
      insert into application_submission_attempt_events (
        user_id, application_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_name, role, evidence_code
      ) values (
        '${userId}', ${sample.application_id ? `'${sample.application_id}'` : 'null'},
        '${sample.packet_id}', 'd1264d0f-a921-466a-9652-faf1565ec099', '${sample.attempt_id}',
        'press_observed', 'legacy_backfill', 'manual_submission', '${sample.company_name}',
        'Conflicting Role', 'migration-contract-binding-conflict'
      )
    `), /binding conflict/);

    await database.exec(`delete from users where id = '${userId}'`);
    const erased = await database.query(`
      select
        (select count(*)::int from application_submission_attempt_events) as events,
        (select count(*)::int from application_submission_attempt_bindings) as bindings,
        (select count(*)::int from application_posting_distinctions) as distinctions
    `);
    assert.deepEqual(erased.rows[0], { events: 0, bindings: 0, distinctions: 0 });
  } finally {
    await server?.stop().catch(() => undefined);
    await database.close().catch(() => undefined);
    rmSync(socketDir, { recursive: true, force: true });
  }
});

test('concurrent empty cutovers converge and missing-marker event state fails closed unchanged', async () => {
  const socketDir = mkdtempSync(join(tmpdir(), 'litos-ledger-cutover-contract-'));
  const database = await PGlite.create();
  let server = null;
  try {
    const userId = 'a2264d0f-a921-466a-9652-faf1565ec001';
    await database.exec(`
      create table users (
        id uuid primary key,
        email text not null
      );
      create table generated_resumes (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        job_context jsonb not null default '{}'::jsonb,
        spec jsonb not null default '{}'::jsonb,
        resume_object_key text,
        pipeline_stage text,
        created_at timestamptz not null default now()
      );
      create table applications (
        id uuid primary key,
        user_id uuid not null references users(id) on delete cascade,
        legacy_generated_resume_id uuid,
        submission_state text,
        tracker_state text,
        company_name text not null,
        role text not null,
        job_id uuid,
        portal_url text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create table application_submission_events (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        application_id uuid not null references applications(id) on delete cascade,
        event_id uuid not null,
        outcome text not null,
        final_url text not null,
        portal_identity text,
        created_at timestamptz not null default now(),
        observed_at timestamptz not null default now()
      );
      create table autofill_events (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        ats_name text not null,
        job_context jsonb not null,
        fields_filled integer default 0,
        fields_skipped integer default 0,
        submitted_by_user boolean,
        auto_submitted boolean default false,
        created_at timestamptz default now()
      )
    `);

    server = new PGLiteSocketServer({
      db: database,
      path: join(socketDir, '.s.PGSQL.5432'),
      maxConnections: 5,
    });
    await server.start();
    const databaseUrl = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
    const concurrent = await Promise.all([
      runMigration(databaseUrl),
      runMigration(databaseUrl),
    ]);
    assert.ok(concurrent.every((result) => /immutable submission attempt ledger schema is present/.test(result.stdout)));
    const emptyCutover = await database.query(`
      select
        (select count(*)::int from application_submission_attempt_ledger_cutovers) as markers,
        (select count(*)::int from application_submission_attempt_events) as events,
        (select count(*)::int from application_submission_attempt_bindings) as bindings
    `);
    assert.deepEqual(emptyCutover.rows[0], { markers: 1, events: 0, bindings: 0 });

    await database.exec(`
      insert into users (id, email) values ('${userId}', 'missing-marker@example.test');
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_name, role
      ) values (
        '${userId}', 'a2264d0f-a921-466a-9652-faf1565ec002',
        'a2264d0f-a921-466a-9652-faf1565ec003',
        'a2264d0f-a921-466a-9652-faf1565ec004', 'attempt_opened',
        'managed_browser', 'initial_submission', 'Runtime Co', 'Engineer'
      )
    `);
    const beforeMissingMarker = await database.query(`
      select
        (select count(*)::int from application_submission_attempt_events) as events,
        (select count(*)::int from application_submission_attempt_bindings) as bindings
    `);
    assert.deepEqual(beforeMissingMarker.rows[0], { events: 1, bindings: 1 });

    /* Simulate a partial or tampered deployment. Ordinary writes cannot remove the marker, so the
       test temporarily disables only its delete trigger to create the impossible production state. */
    await database.exec(`
      alter table application_submission_attempt_ledger_cutovers
        disable trigger application_submission_attempt_ledger_cutovers_no_delete;
      delete from application_submission_attempt_ledger_cutovers
      where cutover_key = 'legacy_backfill_v1';
      alter table application_submission_attempt_ledger_cutovers
        enable trigger application_submission_attempt_ledger_cutovers_no_delete
    `);
    await assert.rejects(database.exec(`
      insert into application_submission_attempt_events (
        user_id, packet_id, event_id, attempt_id, event_kind, source, operation,
        company_name, role
      ) values (
        '${userId}', 'a2264d0f-a921-466a-9652-faf1565ec005',
        'a2264d0f-a921-466a-9652-faf1565ec006',
        'a2264d0f-a921-466a-9652-faf1565ec007', 'boundary_authorized',
        'managed_browser', 'initial_submission', 'Blocked Co', 'Engineer'
      )
    `), /cutover marker is missing/);

    await assert.rejects(
      runMigration(databaseUrl),
      /contains events without the immutable legacy backfill cutover marker/,
    );
    const afterRejectedMigration = await database.query(`
      select
        (select count(*)::int from application_submission_attempt_ledger_cutovers) as markers,
        (select count(*)::int from application_submission_attempt_events) as events,
        (select count(*)::int from application_submission_attempt_bindings) as bindings
    `);
    assert.deepEqual(
      afterRejectedMigration.rows[0],
      { markers: 0, events: 1, bindings: 1 },
      'the failed migration must roll back every repair and leave prior evidence untouched',
    );
  } finally {
    await server?.stop().catch(() => undefined);
    await database.close().catch(() => undefined);
    rmSync(socketDir, { recursive: true, force: true });
  }
});
