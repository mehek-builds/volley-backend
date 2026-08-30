import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

const MIGRATION = 'scripts/apply-job-logo-evidence-schema.mjs';

const SOURCE_IDS = {
  valid: '10000000-0000-4000-8000-000000000001',
  legacyDomain: '10000000-0000-4000-8000-000000000002',
  invalidProof: '10000000-0000-4000-8000-000000000003',
  failedRetry: '10000000-0000-4000-8000-000000000004',
  reviewedCandidate: '10000000-0000-4000-8000-000000000005',
};

const JOB_IDS = {
  h1b: '20000000-0000-4000-8000-000000000001',
  localVisa: '20000000-0000-4000-8000-000000000002',
  refuses: '20000000-0000-4000-8000-000000000003',
  unstated: '20000000-0000-4000-8000-000000000004',
};

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
  let bindir;
  try {
    bindir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`pg_config is required for this migration contract: ${error.message}`);
  }
  const initdb = join(bindir, 'initdb');
  const postgres = join(bindir, 'postgres');
  if (!existsSync(initdb) || !existsSync(postgres)) {
    throw new Error(`PostgreSQL server binaries are required in ${bindir}`);
  }

  // Keep this path short enough for PostgreSQL's 103-byte Unix socket limit on macOS.
  const rootDir = mkdtempSync('/tmp/litos-logo-proof-');
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

  const port = 55439;
  const server = spawn(postgres, [
    '-D', dataDir,
    '-p', String(port),
    '-h', '',
    '-k', socketDir,
    '-F',
    '-c', 'synchronous_commit=off',
    '-c', 'full_page_writes=off',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  server.stdout.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  server.stderr.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  const databaseUrl = `postgresql://postgres@localhost:${port}/postgres?host=${socketDir}`;

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) break;
    const probe = new pg.Client({ connectionString: databaseUrl });
    try {
      await probe.connect();
      await probe.query('select 1');
      await probe.end();
      ready = true;
      break;
    } catch {
      await probe.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  if (!ready) {
    server.kill('SIGTERM');
    rmSync(rootDir, { recursive: true, force: true });
    throw new Error(`Ephemeral PostgreSQL did not become ready: ${logs}`);
  }

  const stop = async () => {
    if (server.exitCode === null) {
      const closed = new Promise((resolve) => server.once('close', resolve));
      server.kill('SIGTERM');
      await closed;
    }
    rmSync(rootDir, { recursive: true, force: true });
  };
  return { databaseUrl, stop };
}

function runMigration(databaseUrl, phase) {
  return runProcess(process.execPath, [
    '--import', 'tsx', MIGRATION, `--phase=${phase}`,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function createLegacySchema(client) {
  await client.query(`
    create table career_page_sources (
      id uuid primary key,
      company_name text not null,
      ats_name text not null,
      board_token text not null,
      career_url text not null,
      enabled boolean not null default true,
      last_polled_at timestamptz,
      last_error text,
      portal_company_name text,
      portal_name_mismatch boolean not null default false,
      created_at timestamptz not null default now()
    );
    create unique index career_page_sources_ats_board_unique
      on career_page_sources (ats_name, board_token);

    create table monitored_jobs (
      id uuid primary key,
      source_id uuid not null references career_page_sources(id) on delete cascade,
      external_id text not null,
      company_name text not null,
      title text not null,
      description text not null,
      apply_url text not null,
      posting_url text not null,
      last_seen_at timestamptz not null default now(),
      is_active boolean not null default true,
      sponsorship_status text not null default 'unstated',
      job_country text not null default 'unknown'
    );
    create unique index monitored_jobs_source_external_unique
      on monitored_jobs (source_id, external_id);
  `);

  await client.query(`
    insert into career_page_sources (
      id, company_name, ats_name, board_token, career_url, portal_company_name
    ) values
      ($1, 'Valid Co', ' GreenHouse ', ' VALID-CO ', 'https://boards.example/valid', 'Valid Co'),
      ($2, 'Legacy Domain Co', 'lever', 'legacy-domain', 'https://boards.example/legacy', 'Legacy Domain Co'),
      ($3, 'Invalid Proof Co', 'ashby', 'invalid-proof', 'https://boards.example/invalid', 'Invalid Proof Co'),
      ($4, 'Failed Retry Co', 'workable', 'failed-retry', 'https://boards.example/retry', 'Failed Retry Co'),
      ($5, 'Airbnb', 'greenhouse', 'airbnb', 'https://boards.example/airbnb', 'Airbnb')
  `, Object.values(SOURCE_IDS));

  await client.query(`
    insert into monitored_jobs (
      id, source_id, external_id, company_name, title, description,
      apply_url, posting_url, sponsorship_status, job_country
    ) values
      ($1, $5, 'h1b-role', 'Airbnb', 'US Engineer',
       'The company offers H-1B sponsorship for this role.',
       'https://apply.example/h1b', 'https://jobs.example/h1b', 'offers', 'us'),
      ($2, $5, 'local-visa-role', 'Airbnb', 'Germany Engineer',
       'Visa sponsorship and relocation support are available for this position.',
       'https://apply.example/local', 'https://jobs.example/local', 'offers', 'non_us'),
      ($3, $5, 'refuses-role', 'Airbnb', 'No Sponsorship Engineer',
       'Applicants must already have work authorization. Sponsorship is not available.',
       'https://apply.example/refuses', 'https://jobs.example/refuses', 'refuses', 'us'),
      ($4, $5, 'unstated-role', 'Airbnb', 'Unstated Engineer',
       'Build reliable systems with the product engineering group.',
       'https://apply.example/unstated', 'https://jobs.example/unstated', 'unstated', 'unknown')
  `, [
    JOB_IDS.h1b,
    JOB_IDS.localVisa,
    JOB_IDS.refuses,
    JOB_IDS.unstated,
    SOURCE_IDS.reviewedCandidate,
  ]);
}

test('package commands require the two explicit verified-inventory migration phases', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(
    packageJson.scripts?.['db:job-logo-evidence:columns'],
    `node --import tsx ${MIGRATION} --phase=columns`,
  );
  assert.equal(
    packageJson.scripts?.['db:job-logo-evidence:finalize'],
    `node --import tsx ${MIGRATION} --phase=finalize`,
  );
  assert.equal(
    packageJson.scripts?.['test:job-logo-evidence-migration'],
    'node --test scripts/apply-job-logo-evidence-schema.test.mjs',
  );
});

test('finalize repairs interrupted concurrent indexes before reporting them ready', () => {
  const source = readFileSync(MIGRATION, 'utf8');
  assert.match(source, /if \(state && \(!state\.indisready \|\| !state\.indisvalid\)\)/);
  assert.match(source, /drop index concurrently if exists \$\{name\}/);
  assert.match(source, /if \(!verified\.rows\[0\]\?\.indisready \|\| !verified\.rows\[0\]\?\.indisvalid\)/);
});

test('both migration phases preserve valid evidence and retry state across reruns', {
  timeout: 120_000,
}, async () => {
  const postgres = await startEphemeralPostgres();
  const client = new pg.Client({ connectionString: postgres.databaseUrl });
  try {
    await client.connect();
    await createLegacySchema(client);

    const firstColumns = await runMigration(postgres.databaseUrl, 'columns');
    assert.match(firstColumns.stdout, /Verified-inventory columns are ready/);

    const addedColumns = await client.query(`
      select table_name, column_name
      from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'career_page_sources' and column_name in (
            'company_domain', 'company_logo_url', 'logo_verification_status',
            'logo_verification_method', 'logo_verified_at', 'logo_last_checked_at',
            'logo_verification_error', 'last_successful_poll_at'
          ))
          or (table_name = 'monitored_jobs' and column_name in (
            'ingest_eligible', 'certification_fingerprint', 'sponsorship_scope'
          ))
        )
      order by table_name, column_name
    `);
    assert.equal(addedColumns.rowCount, 11);
    const legacyEligibility = await client.query(`
      select bool_and(ingest_eligible = false) as all_fail_closed
      from monitored_jobs
    `);
    assert.equal(legacyEligibility.rows[0].all_fail_closed, true);

    await client.query(`
      update career_page_sources
      set company_domain = 'valid.example',
          company_logo_url = 'https://cdn.valid.example/logo.png',
          logo_verification_status = 'verified',
          logo_verification_method = 'first_party_ats_employer_logo',
          logo_verified_at = now() - interval '1 day'
      where id = $1
    `, [SOURCE_IDS.valid]);
    await client.query(`
      update career_page_sources
      set company_domain = 'legacy.example',
          company_logo_url = 'https://cdn.legacy.example/logo.png',
          logo_verification_status = 'verified',
          logo_verification_method = 'reviewed_company_domain_map',
          logo_verified_at = now() - interval '1 day',
          logo_last_checked_at = now() - interval '2 hours',
          logo_verification_error = 'legacy-original-error'
      where id = $1
    `, [SOURCE_IDS.legacyDomain]);
    await client.query(`
      update career_page_sources
      set company_domain = 'invalid.example',
          company_logo_url = 'https://cdn.invalid.example/logo.png',
          logo_verification_status = 'verified',
          logo_verification_method = 'ats_asset',
          logo_verified_at = now() + interval '1 day',
          logo_last_checked_at = now() - interval '1 hour',
          logo_verification_error = 'invalid-original-error'
      where id = $1
    `, [SOURCE_IDS.invalidProof]);
    await client.query(`
      update career_page_sources
      set logo_verification_status = 'failed',
          logo_verification_method = 'ats_asset_candidate',
          logo_last_checked_at = now() - interval '3 hours',
          logo_verification_error = 'provider-timeout'
      where id = $1
    `, [SOURCE_IDS.failedRetry]);
    await client.query(`
      update monitored_jobs
      set sponsorship_scope = 'us_h1b'
      where id = $1
    `, [JOB_IDS.unstated]);

    const retryBefore = await client.query(`
      select logo_last_checked_at, logo_verification_error
      from career_page_sources
      where id = $1
    `, [SOURCE_IDS.failedRetry]);

    const firstFinalize = await runMigration(postgres.databaseUrl, 'finalize');
    assert.match(firstFinalize.stdout, /Verified-inventory schema finalization is ready/);
    assert.match(firstFinalize.stdout, /1 of 5 sources currently have strict logo proof/);

    const sourcesAfterFirstRun = await client.query(`
      select id, ats_name, board_token, company_domain, company_logo_url,
        logo_verification_status, logo_verification_method, logo_verified_at,
        logo_last_checked_at, logo_verification_error
      from career_page_sources
      order by id
    `);
    const bySource = new Map(sourcesAfterFirstRun.rows.map((row) => [row.id, row]));

    const valid = bySource.get(SOURCE_IDS.valid);
    assert.equal(valid.ats_name, 'greenhouse');
    assert.equal(valid.board_token, 'valid-co');
    assert.equal(valid.logo_verification_status, 'verified');
    assert.equal(valid.company_logo_url, 'https://cdn.valid.example/logo.png');
    assert.equal(valid.logo_verification_method, 'first_party_ats_employer_logo');
    assert.equal(valid.logo_last_checked_at.toISOString(), valid.logo_verified_at.toISOString());

    const legacyDomain = bySource.get(SOURCE_IDS.legacyDomain);
    assert.equal(legacyDomain.logo_verification_status, 'unverified');
    assert.equal(legacyDomain.company_logo_url, null);
    assert.equal(legacyDomain.logo_verified_at, null);
    assert.equal(legacyDomain.logo_verification_method, 'reviewed_company_domain_candidate');
    assert.equal(legacyDomain.logo_verification_error, 'legacy_domain_only_proof_revoked');

    const invalidProof = bySource.get(SOURCE_IDS.invalidProof);
    assert.equal(invalidProof.logo_verification_status, 'failed');
    assert.equal(invalidProof.company_logo_url, null);
    assert.equal(invalidProof.logo_verified_at, null);
    assert.equal(invalidProof.logo_verification_error, 'migration_invalid_legacy_logo_evidence');

    const failedRetry = bySource.get(SOURCE_IDS.failedRetry);
    assert.equal(failedRetry.logo_verification_status, 'failed');
    assert.equal(failedRetry.logo_verification_error, 'provider-timeout');
    assert.equal(
      failedRetry.logo_last_checked_at.toISOString(),
      retryBefore.rows[0].logo_last_checked_at.toISOString(),
    );

    const reviewedCandidate = bySource.get(SOURCE_IDS.reviewedCandidate);
    assert.equal(reviewedCandidate.company_domain, 'airbnb.com');
    assert.equal(reviewedCandidate.logo_verification_method, 'reviewed_company_domain_candidate');

    const jobScopes = await client.query(`
      select id, sponsorship_scope, ingest_eligible
      from monitored_jobs
      order by id
    `);
    const byJob = new Map(jobScopes.rows.map((row) => [row.id, row]));
    assert.equal(byJob.get(JOB_IDS.h1b).sponsorship_scope, 'us_h1b');
    assert.equal(byJob.get(JOB_IDS.localVisa).sponsorship_scope, 'job_country');
    assert.equal(byJob.get(JOB_IDS.refuses).sponsorship_scope, null);
    assert.equal(byJob.get(JOB_IDS.unstated).sponsorship_scope, null);
    assert.equal(jobScopes.rows.every((row) => row.ingest_eligible === false), true);

    const constraints = await client.query(`
      select conname, convalidated
      from pg_constraint
      where conname in (
        'career_page_sources_logo_status_check',
        'career_page_sources_logo_evidence_check',
        'career_page_sources_normalized_identity_check',
        'monitored_jobs_certification_fingerprint_check',
        'monitored_jobs_sponsorship_scope_check'
      )
      order by conname
    `);
    assert.deepEqual(
      constraints.rows.map((row) => row.conname),
      [
        'career_page_sources_logo_evidence_check',
        'career_page_sources_logo_status_check',
        'career_page_sources_normalized_identity_check',
        'monitored_jobs_certification_fingerprint_check',
        'monitored_jobs_sponsorship_scope_check',
      ],
    );
    assert.equal(constraints.rows.every((row) => row.convalidated), true);

    await assert.rejects(
      client.query(`
        update career_page_sources
        set logo_verification_status = 'verified',
            company_logo_url = 'http://airbnb.example/logo.png',
            logo_verification_method = 'ats_asset',
            logo_verified_at = now()
        where id = $1
      `, [SOURCE_IDS.reviewedCandidate]),
      (error) => error.code === '23514'
        && error.constraint === 'career_page_sources_logo_evidence_check',
    );
    await assert.rejects(
      client.query(`
        update career_page_sources set ats_name = ' GreenHouse ' where id = $1
      `, [SOURCE_IDS.valid]),
      (error) => error.code === '23514'
        && error.constraint === 'career_page_sources_normalized_identity_check',
    );
    await assert.rejects(
      client.query(`
        update monitored_jobs set sponsorship_scope = null where id = $1
      `, [JOB_IDS.h1b]),
      (error) => error.code === '23514'
        && error.constraint === 'monitored_jobs_sponsorship_scope_check',
    );
    await assert.rejects(
      client.query(`
        update monitored_jobs set certification_fingerprint = 'v1:not-a-valid-hash' where id = $1
      `, [JOB_IDS.unstated]),
      (error) => error.code === '23514'
        && error.constraint === 'monitored_jobs_certification_fingerprint_check',
    );

    const indexes = await client.query(`
      select indexrelid::regclass::text as index_name, indisready, indisvalid
      from pg_index
      where indexrelid::regclass::text in (
        'career_page_sources_verified_logo_idx',
        'monitored_jobs_active_last_seen_idx',
        'monitored_jobs_verified_inventory_idx',
        'monitored_jobs_sponsorship_scope_idx'
      )
      order by index_name
    `);
    assert.deepEqual(
      indexes.rows.map((row) => row.index_name),
      [
        'career_page_sources_verified_logo_idx',
        'monitored_jobs_active_last_seen_idx',
        'monitored_jobs_sponsorship_scope_idx',
        'monitored_jobs_verified_inventory_idx',
      ],
    );
    assert.equal(indexes.rows.every((row) => row.indisready && row.indisvalid), true);

    const retryAt = new Date(Date.now() - 60_000);
    await client.query(`
      update career_page_sources
      set logo_last_checked_at = $2,
          logo_verification_error = 'post-migration-retry'
      where id in ($1, $3, $4)
    `, [
      SOURCE_IDS.valid,
      retryAt,
      SOURCE_IDS.legacyDomain,
      SOURCE_IDS.invalidProof,
    ]);

    const secondColumns = await runMigration(postgres.databaseUrl, 'columns');
    const secondFinalize = await runMigration(postgres.databaseUrl, 'finalize');
    assert.match(secondColumns.stdout, /Verified-inventory columns are ready/);
    assert.match(secondFinalize.stdout, /Verified-inventory schema finalization is ready/);
    assert.match(secondFinalize.stdout, /1 of 5 sources currently have strict logo proof/);

    const afterRerun = await client.query(`
      select id, company_domain, company_logo_url, logo_verification_status,
        logo_verification_method, logo_verified_at, logo_last_checked_at,
        logo_verification_error
      from career_page_sources
      where id in ($1, $2, $3, $4, $5)
      order by id
    `, Object.values(SOURCE_IDS));
    const afterRerunBySource = new Map(afterRerun.rows.map((row) => [row.id, row]));
    for (const id of [SOURCE_IDS.valid, SOURCE_IDS.legacyDomain, SOURCE_IDS.invalidProof]) {
      const row = afterRerunBySource.get(id);
      assert.equal(row.logo_last_checked_at.toISOString(), retryAt.toISOString());
      assert.equal(row.logo_verification_error, 'post-migration-retry');
    }
    assert.equal(
      afterRerunBySource.get(SOURCE_IDS.valid).company_logo_url,
      'https://cdn.valid.example/logo.png',
    );
    assert.equal(afterRerunBySource.get(SOURCE_IDS.valid).logo_verification_status, 'verified');
    assert.equal(
      afterRerunBySource.get(SOURCE_IDS.legacyDomain).logo_verification_method,
      'reviewed_company_domain_candidate',
    );
    assert.equal(afterRerunBySource.get(SOURCE_IDS.invalidProof).logo_verification_status, 'failed');
    assert.equal(afterRerunBySource.get(SOURCE_IDS.reviewedCandidate).company_domain, 'airbnb.com');
    assert.equal(
      afterRerunBySource.get(SOURCE_IDS.failedRetry).logo_verification_error,
      'provider-timeout',
    );
  } finally {
    await client.end().catch(() => undefined);
    await postgres.stop();
  }
});
