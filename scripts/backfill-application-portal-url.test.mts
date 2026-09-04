/* Contract test for scripts/backfill-application-portal-url.mts.
 *
 * Runs the real script as a subprocess against an ephemeral local PostgreSQL, so what is asserted
 * is what the script actually does to a database rather than a restatement of its source. Real
 * PostgreSQL rather than PGlite: the script authenticates over a Unix-socket connectionString the
 * way an operator's DATABASE_URL does, and the point of one of these tests is that connection
 * string containing the literal word "localhost" - a PGlite socket shim would not exercise that.
 *
 * BACKFILL_ALLOW_LOCALHOST_APPLY=1 is passed to every --apply invocation here: the script itself
 * refuses to --apply against anything that looks like localhost (see its own comment), which is
 * exactly right for an operator and exactly wrong for this test, so the test opts back in through
 * the one env var built for that.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import pg from 'pg';

const SCRIPT = 'scripts/backfill-application-portal-url.mts';

function runProcess(command: string, args: string[], options: Record<string, unknown> = {}) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr!.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

async function startEphemeralPostgres() {
  const bindir = execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
  const initdb = join(bindir, 'initdb');
  const postgres = join(bindir, 'postgres');
  if (!existsSync(initdb) || !existsSync(postgres)) {
    throw new Error(`PostgreSQL server binaries are required in ${bindir}`);
  }

  const rootDir = mkdtempSync('/tmp/litos-portal-url-backfill-');
  const dataDir = join(rootDir, 'data');
  const socketDir = join(rootDir, 'socket');
  mkdirSync(socketDir);
  // LC_ALL=C: a locale-dependent initdb/postmaster combination on this host fails startup with
  // "postmaster became multithreaded during startup" otherwise (matches the project's own
  // LC_ALL=C npm test convention).
  await runProcess(initdb, [
    '--pgdata', dataDir,
    '--auth=trust',
    '--encoding=UTF8',
    '--no-locale',
    '--username=postgres',
  ], { env: { ...process.env, LC_ALL: 'C' } });
  const port = 55463;
  const server = spawn(postgres, [
    '-D', dataDir,
    '-p', String(port),
    '-h', '',
    '-k', socketDir,
    '-F',
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C' } });
  let logs = '';
  server.stdout!.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  server.stderr!.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
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
      await new Promise((resolve) => { setTimeout(resolve, 25); });
    }
  }
  if (!ready) {
    server.kill('SIGTERM');
    rmSync(rootDir, { recursive: true, force: true });
    throw new Error(`Ephemeral PostgreSQL did not become ready: ${logs}`);
  }
  return {
    databaseUrl,
    async stop() {
      if (server.exitCode === null) {
        const closed = new Promise<void>((resolve) => { server.once('close', () => resolve()); });
        server.kill('SIGTERM');
        await closed;
      }
      rmSync(rootDir, { recursive: true, force: true });
    },
  };
}

function runBackfill(databaseUrl: string, extraArgs: string[] = [], extraEnv: Record<string, string> = {}) {
  return runProcess(process.execPath, ['--import', 'tsx', SCRIPT, ...extraArgs], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl, ...extraEnv },
  });
}

async function createSchema(client: pg.Client) {
  await client.query(`
    create table career_page_sources (
      id uuid primary key,
      ats_name text not null,
      board_token text not null,
      enabled boolean not null default true
    );
    create table monitored_jobs (
      id uuid primary key,
      source_id uuid not null references career_page_sources(id),
      external_id text not null,
      apply_url text not null,
      posting_url text not null
    );
    create table applications (
      id uuid primary key,
      legacy_generated_resume_id uuid,
      job_id uuid,
      portal_url text,
      updated_at timestamptz not null default now()
    );
  `);
}

const STALE_UPDATED_AT = new Date('2020-01-01T00:00:00Z');

const SUPPORTED_SOURCE = randomUUID();
const SUPPORTED_JOB = randomUUID();
const UNSUPPORTED_SOURCE = randomUUID();
const UNSUPPORTED_JOB = randomUUID();
const DISABLED_SOURCE = randomUUID();
const DISABLED_SOURCE_JOB = randomUUID();
const MISSING_JOB = randomUUID();

const ROW_UPDATES = randomUUID(); // job exists, supported ATS, source enabled -> should update
const ROW_JOB_GONE = randomUUID(); // job_id points nowhere -> must not be touched
const ROW_UNSUPPORTED = randomUUID(); // job exists, unsupported ATS -> must not be touched
const ROW_DISABLED_SOURCE = randomUUID(); // job exists, supported ATS, source disabled -> must not be touched
const ROW_ALREADY_HAS_URL = randomUUID(); // portal_url already set -> not even a candidate
const ROW_NO_JOB_ID = randomUUID(); // job_id null -> out of scope
const ROW_NOT_A_PACKET = randomUUID(); // legacy_generated_resume_id null -> out of scope

const EXPECTED_URL = 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=12345';
const PREEXISTING_URL = 'https://already-has-one.example.com';

async function seedFixtures(client: pg.Client) {
  await client.query(
    `insert into career_page_sources (id, ats_name, board_token, enabled) values
       ($1, 'greenhouse', 'acme', true),
       ($2, 'made_up_ats', 'zzz', true),
       ($3, 'greenhouse', 'acme', false)`,
    [SUPPORTED_SOURCE, UNSUPPORTED_SOURCE, DISABLED_SOURCE],
  );
  await client.query(
    `insert into monitored_jobs (id, source_id, external_id, apply_url, posting_url) values
       ($1, $2, '12345', 'https://boards.greenhouse.io/acme/jobs/12345', 'https://acme.com/careers/12345'),
       ($3, $4, '999', 'https://example.com/careers/999', 'https://example.com/jobs/999'),
       ($5, $6, '55555', 'https://boards.greenhouse.io/acme/jobs/55555', 'https://acme.com/careers/55555')`,
    [SUPPORTED_JOB, SUPPORTED_SOURCE, UNSUPPORTED_JOB, UNSUPPORTED_SOURCE, DISABLED_SOURCE_JOB, DISABLED_SOURCE],
  );
  const packet = () => randomUUID();
  const insertPacketRow = (id: string, jobId: string) => client.query(
    `insert into applications (id, legacy_generated_resume_id, job_id, portal_url) values ($1, $2, $3, null)`,
    [id, packet(), jobId],
  );
  await insertPacketRow(ROW_UPDATES, SUPPORTED_JOB);
  await insertPacketRow(ROW_JOB_GONE, MISSING_JOB);
  await insertPacketRow(ROW_UNSUPPORTED, UNSUPPORTED_JOB);
  await insertPacketRow(ROW_DISABLED_SOURCE, DISABLED_SOURCE_JOB);
  // A deliberately stale updated_at, so the "the backfill must not touch this" assertion below
  // proves an exact, unchanged value rather than merely "not literally this instant".
  await client.query(`update applications set updated_at = $2 where id = $1`, [ROW_UPDATES, STALE_UPDATED_AT]);
  await client.query(
    `insert into applications (id, legacy_generated_resume_id, job_id, portal_url) values ($1, $4, $2, $3)`,
    [ROW_ALREADY_HAS_URL, SUPPORTED_JOB, PREEXISTING_URL, packet()],
  );
  await client.query(
    `insert into applications (id, legacy_generated_resume_id, job_id, portal_url) values ($1, $2, null, null)`,
    [ROW_NO_JOB_ID, packet()],
  );
  await client.query(
    `insert into applications (id, legacy_generated_resume_id, job_id, portal_url) values ($1, null, $2, null)`,
    [ROW_NOT_A_PACKET, SUPPORTED_JOB],
  );
}

async function portalUrlsById(client: pg.Client): Promise<Record<string, string | null>> {
  const { rows } = await client.query('select id, portal_url from applications');
  const map: Record<string, string | null> = {};
  for (const row of rows) map[row.id] = row.portal_url;
  return map;
}

async function updatedAtOf(client: pg.Client, id: string): Promise<Date> {
  const { rows } = await client.query('select updated_at from applications where id = $1', [id]);
  return rows[0].updated_at;
}

let postgres: Awaited<ReturnType<typeof startEphemeralPostgres>>;
let client: pg.Client;

before(async (context) => {
  const bindirProbe = (() => {
    try {
      return execFileSync('pg_config', ['--bindir'], { encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  })();
  if (!bindirProbe) return context.skip('local PostgreSQL binaries are unavailable');
  postgres = await startEphemeralPostgres();
  client = new pg.Client({ connectionString: postgres.databaseUrl });
  await client.connect();
  await createSchema(client);
  await seedFixtures(client);
});

after(async () => {
  await client?.end().catch(() => undefined);
  await postgres?.stop();
});

test('refuses to --apply against a database that looks like localhost, without the test escape hatch', { timeout: 60_000 }, async (context) => {
  if (!postgres) return context.skip('no ephemeral PostgreSQL');
  const result = await runBackfill(postgres.databaseUrl, ['--apply']);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /Refusing to --apply against what looks like localhost/);
  // The refusal must come before any write: every row is exactly as seeded.
  const after = await portalUrlsById(client);
  assert.equal(after[ROW_UPDATES], null);
});

test('dry run reports the candidates and writes nothing', { timeout: 60_000 }, async (context) => {
  if (!postgres) return context.skip('no ephemeral PostgreSQL');
  const result = await runBackfill(postgres.databaseUrl);
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /4 candidate row\(s\)/);
  assert.match(result.stdout, new RegExp(`${ROW_UPDATES}: ${EXPECTED_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(result.stdout, new RegExp(`${ROW_JOB_GONE}: job ${MISSING_JOB} no longer exists`));
  assert.match(result.stdout, new RegExp(`${ROW_UNSUPPORTED}: job ${UNSUPPORTED_JOB} did not reconstruct`));
  assert.match(result.stdout, new RegExp(`${ROW_DISABLED_SOURCE}: job ${DISABLED_SOURCE_JOB}'s source is disabled`));
  assert.match(result.stdout, /DRY RUN\. Nothing was written\./);

  const after = await portalUrlsById(client);
  assert.equal(after[ROW_UPDATES], null, 'dry run must not write the row it would update');
  assert.equal(after[ROW_JOB_GONE], null);
  assert.equal(after[ROW_UNSUPPORTED], null);
  assert.equal(after[ROW_DISABLED_SOURCE], null, 'a row whose source is disabled must never be written');
  assert.equal(after[ROW_ALREADY_HAS_URL], PREEXISTING_URL, 'a row that already had a URL must be untouched');
  assert.equal(after[ROW_NO_JOB_ID], null);
  assert.equal(after[ROW_NOT_A_PACKET], null);
});

test('--apply writes only the row with a surviving job and a supported reconstruction, and is idempotent', { timeout: 60_000 }, async (context) => {
  if (!postgres) return context.skip('no ephemeral PostgreSQL');
  const first = await runBackfill(postgres.databaseUrl, ['--apply'], { BACKFILL_ALLOW_LOCALHOST_APPLY: '1' });
  assert.equal(first.code, 0, first.stderr || first.stdout);
  assert.match(first.stdout, /Updated 1 row\(s\)\./);

  const afterFirst = await portalUrlsById(client);
  assert.equal(afterFirst[ROW_UPDATES], EXPECTED_URL, 'the reconstructable row must be written');
  assert.equal(afterFirst[ROW_JOB_GONE], null, 'a row whose job no longer exists must never be written');
  assert.equal(afterFirst[ROW_UNSUPPORTED], null, 'a row whose reconstruction fails must never be written');
  assert.equal(afterFirst[ROW_DISABLED_SOURCE], null, 'a row whose source is disabled must never be written');
  assert.equal(afterFirst[ROW_ALREADY_HAS_URL], PREEXISTING_URL, 'a row that already had a URL must be untouched');
  assert.equal(afterFirst[ROW_NO_JOB_ID], null, 'a row with no job_id is out of scope and must stay untouched');
  assert.equal(afterFirst[ROW_NOT_A_PACKET], null, 'a non-packet row is out of scope and must stay untouched');

  // GET /applications and existingApplicationForJob both order live rows by updated_at desc, one
  // of them with no removed_at filter, so filling in a fact this row always should have carried
  // must not also jump it to the top of a student's Tracker with a false "just now" timestamp.
  assert.deepEqual(
    await updatedAtOf(client, ROW_UPDATES),
    STALE_UPDATED_AT,
    'writing portal_url must not touch updated_at',
  );

  // Second run: the row updated above is no longer a candidate (portal_url is no longer null), so
  // it must not appear in the report and nothing must be written again.
  const second = await runBackfill(postgres.databaseUrl, ['--apply'], { BACKFILL_ALLOW_LOCALHOST_APPLY: '1' });
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /3 candidate row\(s\)/);
  assert.doesNotMatch(second.stdout, new RegExp(ROW_UPDATES));
  assert.match(second.stdout, /Updated 0 row\(s\)\./);

  const afterSecond = await portalUrlsById(client);
  assert.deepEqual(afterSecond, afterFirst, 'a second --apply run must change nothing');
});
