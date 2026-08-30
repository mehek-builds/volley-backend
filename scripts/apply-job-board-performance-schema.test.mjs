import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import pg from 'pg';

const MIGRATION = 'scripts/apply-job-board-performance-schema.mjs';

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const bindir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
  const initdb = join(bindir, 'initdb');
  const postgres = join(bindir, 'postgres');
  if (!existsSync(initdb) || !existsSync(postgres)) {
    throw new Error(`PostgreSQL server binaries are required in ${bindir}`);
  }
  const rootDir = mkdtempSync('/tmp/litos-board-perf-');
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
  const port = 55441;
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
  if (!ready) throw new Error(`Ephemeral PostgreSQL did not become ready: ${logs}`);
  return {
    databaseUrl,
    stop: async () => {
      if (server.exitCode === null) {
        const closed = new Promise((resolve) => server.once('close', resolve));
        server.kill('SIGTERM');
        await closed;
      }
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

async function createBaseSchema(client, { withFingerprintConstraint = true } = {}) {
  await client.query(`
    create table career_page_sources (
      id uuid primary key,
      company_name text not null,
      ats_name text not null,
      board_token text not null,
      career_url text not null,
      company_domain text,
      company_logo_url text,
      logo_verification_status text not null default 'unverified',
      logo_verification_method text,
      logo_verified_at timestamptz,
      enabled boolean not null default true,
      last_successful_poll_at timestamptz,
      sponsor_employer_id uuid,
      portal_company_name text,
      portal_name_mismatch boolean not null default false
    );
    create table monitored_jobs (
      id uuid primary key,
      source_id uuid not null references career_page_sources(id),
      external_id text not null,
      company_name text not null,
      title text not null,
      location text,
      employment_type text,
      description text not null,
      ingest_eligible boolean not null default false,
      certification_fingerprint text,
      apply_url text not null,
      posting_url text not null,
      remote boolean not null default false,
      posted_at timestamptz,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      is_active boolean not null default true,
      sponsorship_status text not null default 'unstated',
      sponsorship_scope text,
      job_country text not null default 'unknown',
      salary_min double precision,
      salary_max double precision,
      salary_currency text,
      salary_interval text,
      raw_json jsonb
      ${withFingerprintConstraint ? `,constraint monitored_jobs_certification_fingerprint_check check (
        certification_fingerprint is null
        or certification_fingerprint ~ '^v1:[0-9a-f]{64}:[0-9a-f]{64}$'
      )` : ''}
    );
  `);
}

function fingerprint(groupSeed, jobSeed) {
  return `v1:${groupSeed.repeat(64).slice(0, 64)}:${jobSeed.repeat(64).slice(0, 64)}`;
}

test('package exposes the migration and 500k benchmark commands', () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(
    packageJson.scripts?.['db:job-board-performance'],
    `node ${MIGRATION}`,
  );
  assert.equal(
    packageJson.scripts?.['benchmark:job-board-500k'],
    'node scripts/benchmark-job-board-500k.mjs',
  );
});

test('migration and route pin the same verified public evidence contract', () => {
  const migration = readFileSync(MIGRATION, 'utf8');
  const route = readFileSync('src/routes/jobMonitor.ts', 'utf8');
  const branding = readFileSync('src/lib/atsSourceBranding.ts', 'utf8');
  for (const family of [
    'greenhouse', 'lever', 'ashby', 'workable',
    'rippling', 'breezy', 'recruitee', 'crelate',
  ]) {
    assert.match(migration, new RegExp(`'${family}'`));
    assert.match(readFileSync('src/lib/portalSubmission.ts', 'utf8'), new RegExp(`'${family}'`));
  }
  for (const method of [
    'first_party_ats_employer_logo',
    'first_party_ats_employer_logo_durable_copy',
    'first_party_ats_identity_and_homepage_logo_asset',
  ]) {
    assert.match(migration, new RegExp(`'${method}'`));
    assert.match(`${route}\n${branding}`, new RegExp(method));
  }
  assert.match(migration, /j\.last_seen_at >= v_as_of - interval '7 days'/);
  assert.match(route, /export const VERIFIED_ACTIVE_WINDOW_DAYS = 7/);
  assert.match(migration, /s\.logo_verified_at >= v_as_of - interval '30 days'/);
  assert.match(route, /export const VERIFIED_LOGO_EVIDENCE_WINDOW_DAYS = 30/);
  assert.match(migration, /monitored_jobs_certification_fingerprint_check/);
  assert.match(migration, /convalidated/);
  assert.match(migration, /j\.certification_fingerprint is not null as is_certified/);
});

test('migration refuses to trust non-null fingerprints before the format constraint is validated', {
  timeout: 120_000,
}, async () => {
  const postgres = await startEphemeralPostgres();
  const client = new pg.Client({ connectionString: postgres.databaseUrl });
  try {
    await client.connect();
    await createBaseSchema(client, { withFingerprintConstraint: false });
    await assert.rejects(
      runProcess(process.execPath, [MIGRATION], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: postgres.databaseUrl },
      }),
      /monitored_jobs_certification_fingerprint_check must exist and be validated/,
    );
  } finally {
    await client.end().catch(() => undefined);
    await postgres.stop();
  }
});

test('migration reruns safely and rotates a complete indexed generation', {
  timeout: 120_000,
}, async () => {
  const postgres = await startEphemeralPostgres();
  const client = new pg.Client({ connectionString: postgres.databaseUrl });
  try {
    await client.connect();
    await createBaseSchema(client);
    for (let pass = 0; pass < 2; pass += 1) {
      const migration = await runProcess(process.execPath, [MIGRATION], {
        cwd: process.cwd(),
        env: { ...process.env, DATABASE_URL: postgres.databaseUrl },
      });
      assert.match(migration.stdout, /Job board performance schema is ready/);
    }

    const sourceId = '10000000-0000-4000-8000-000000000001';
    await client.query(`
      insert into career_page_sources (
        id, company_name, ats_name, board_token, career_url,
        company_domain, company_logo_url, logo_verification_status,
        logo_verification_method, logo_verified_at, enabled,
        last_successful_poll_at, portal_company_name, portal_name_mismatch
      ) values (
        $1, 'Projection Co', 'greenhouse', 'projection-co',
        'https://careers.projection.example', 'projection.example',
        'https://assets.projection.example/logo.png', 'verified',
        'first_party_ats_employer_logo', now() - interval '1 hour', true,
        now(), 'Projection Co', false
      )
    `, [sourceId]);
    const shared = fingerprint('a', 'b');
    const unique = fingerprint('c', 'd');
    await client.query(`
      insert into monitored_jobs (
        id, source_id, external_id, company_name, title, location,
        employment_type, description, ingest_eligible, certification_fingerprint,
        apply_url, posting_url, remote, posted_at, first_seen_at, last_seen_at,
        is_active, sponsorship_status, sponsorship_scope, job_country
      ) values
        ('30000000-0000-4000-8000-000000000001', $1, 'one', 'Projection Co',
         'Platform Engineer', 'New York, NY', 'Internship', repeat('Detailed role. ', 20),
         true, $2, 'https://apply.example/one', 'https://jobs.example/one', false,
         now(), now() - interval '3 hours', now(), true, 'offers', 'job_country', 'us'),
        ('30000000-0000-4000-8000-000000000002', $1, 'two', 'Projection Co',
         'Platform Engineer', 'London, UK', 'Full-time', repeat('Detailed role. ', 20),
         true, $2, 'https://apply.example/two', 'https://jobs.example/two', false,
         now() - interval '1 hour', now() - interval '4 hours', now(), true, 'unstated', null, 'non_us'),
        ('30000000-0000-4000-8000-000000000003', $1, 'three', 'Projection Co',
         'Data Analyst', 'Toronto, Canada', 'Full-time', repeat('Detailed role. ', 20),
         true, $3, 'https://apply.example/three', 'https://jobs.example/three', true,
         now() - interval '2 hours', now() - interval '5 hours', now(), true, 'unstated', null, 'non_us'),
        ('30000000-0000-4000-8000-000000000004', $1, 'four', 'Projection Co',
         'Product Designer', 'Dubai, UAE', 'Full-time', repeat('Detailed role. ', 20),
         true, null, 'https://apply.example/four', 'https://jobs.example/four', false,
         null, now() - interval '6 hours', now(), true, 'unstated', null, 'non_us')
    `, [sourceId, shared, unique]);

    const certifiedSince = new Date(Date.now() - 60_000);
    const first = await client.query(
      'select refresh_job_board_group_projection($1) as generation',
      [certifiedSince],
    );
    const second = await client.query(
      'select refresh_job_board_group_projection($1) as generation',
      [certifiedSince],
    );
    assert.notEqual(first.rows[0].generation, second.rows[0].generation);
    const state = await client.query('select * from job_board_group_projection_state');
    assert.equal(state.rowCount, 1);
    assert.equal(state.rows[0].generation, second.rows[0].generation);
    assert.equal(state.rows[0].previous_generation, first.rows[0].generation);
    assert.equal(state.rows[0].surfaced_postings, 4);
    assert.equal(state.rows[0].surfaced_grouped_roles, 3);
    assert.equal(state.rows[0].surfaced_sponsor_only_jobs, 1);
    assert.equal(state.rows[0].surfaced_internships, 1);
    assert.equal(state.rows[0].certified_unique_jobs, 2);
    assert.equal(state.rows[0].certified_unique_grouped_roles, 2);
    assert.equal(state.rows[0].certified_unique_sponsor_jobs, 1);
    assert.equal(state.rows[0].certified_unique_internships, 1);
    const generations = await client.query(`
      select generation, count(*)::int as groups
      from job_board_group_projection
      group by generation
      order by generation
    `);
    assert.deepEqual(generations.rows.map((row) => row.groups).sort(), [3, 3]);
    const indexes = await client.query(`
      select indexrelid::regclass::text as name, indisvalid, indisready
      from pg_index
      where indexrelid::regclass::text in (
        'monitored_jobs_cursor_idx',
        'monitored_jobs_group_member_idx',
        'monitored_jobs_title_trgm_idx',
        'monitored_jobs_description_trgm_idx',
        'job_board_group_projection_cursor_idx'
      )
      order by name
    `);
    assert.equal(indexes.rowCount, 5);
    assert.ok(indexes.rows.every((row) => row.indisvalid && row.indisready));
  } finally {
    await client.end().catch(() => undefined);
    await postgres.stop();
  }
});
