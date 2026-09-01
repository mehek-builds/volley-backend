import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';

/* THE SPACEX WIPE, END TO END. On 2026-08-30 Greenhouse began decorating every absolute_url with
   `?gh_jid=<job id>`. The strict action-URL validator rejected all 2,239 SpaceX postings, and
   pollSource then reported a clean SUCCESS: the sweep flipped every monitored_jobs row inactive,
   the upsert loop had nothing to write, last_polled_at and last_successful_poll_at advanced, and
   last_error was cleared. This file pins all three halves of the fix through the real pollSource
   against a real database: the gh_jid suffix ingests, a fully rejected list preserves live rows
   and records a queryable last_error, and an aborted list fetch also lands in last_error. */

const SOURCE_ID = '92000000-0000-4000-8000-000000000001';
const COMPANY = 'Launch Systems Company';
const TOKEN = 'launch-systems';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};
const previousFetch = globalThis.fetch;

let socketDir: string;
let database: PGlite;
let socketServer: PGLiteSocketServer;
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');
let monitor: typeof import('./jobMonitor');

before(async () => {
  process.env.ENCRYPTION_KEY = 'job-monitor-rejected-fetch-database-test-key';
  process.env.JWT_SIGNING_SECRET = 'job-monitor-rejected-fetch-database-test-secret';

  socketDir = mkdtempSync(join(tmpdir(), 'litos-job-monitor-rejected-fetch-'));
  database = await PGlite.create();
  socketServer = new PGLiteSocketServer({
    db: database,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 10,
  });
  await socketServer.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await database.exec(statement);
  monitor = await import('./jobMonitor');
});

after(async () => {
  globalThis.fetch = previousFetch;
  await pool?.end();
  await socketServer?.stop();
  await database?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function greenhousePayload(absoluteUrl: (id: string) => string) {
  const content = `<p>${'Design, build, and operate reliable launch-control software with the flight software team. '.repeat(3)}</p>`;
  return JSON.stringify({
    jobs: ['4001', '4002'].map((id) => ({
      id,
      title: `Flight Software Engineer ${id}`,
      absolute_url: absoluteUrl(id),
      location: { name: 'Hawthorne, CA' },
      company_name: COMPANY,
      content,
      updated_at: new Date().toISOString(),
    })),
  });
}

function respond(body: string) {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

async function sourceState() {
  const [row] = await db.select({
    last_polled_at: schema.career_page_sources.last_polled_at,
    last_successful_poll_at: schema.career_page_sources.last_successful_poll_at,
    last_error: schema.career_page_sources.last_error,
  }).from(schema.career_page_sources).where(eq(schema.career_page_sources.id, SOURCE_ID));
  return row!;
}

async function activeJobCount() {
  const rows = await db.select({ is_active: schema.monitored_jobs.is_active })
    .from(schema.monitored_jobs)
    .where(eq(schema.monitored_jobs.source_id, SOURCE_ID));
  return rows.filter((row) => row.is_active).length;
}

test('a fully rejected or aborted list fetch preserves the board and lands in last_error', async () => {
  const now = new Date();
  const [source] = await db.insert(schema.career_page_sources).values({
    id: SOURCE_ID,
    company_name: COMPANY,
    ats_name: 'greenhouse',
    board_token: TOKEN,
    career_url: `https://job-boards.greenhouse.io/${TOKEN}`,
    company_domain: `${TOKEN}.example`,
    company_logo_url: `https://${TOKEN}.example/logo.png`,
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: now,
    portal_company_name: COMPANY,
    portal_name_mismatch: false,
    enabled: true,
  }).returning();

  /* 1. The gh_jid-decorated board ingests: the exact payload shape that zeroed SpaceX. */
  globalThis.fetch = async () => respond(greenhousePayload(
    (id) => `https://boards.greenhouse.io/${TOKEN}/jobs/${id}?gh_jid=${id}`,
  ));
  const healthy = await monitor.pollSource(source);
  assert.equal(healthy.ok, true, JSON.stringify(healthy));
  assert.equal(healthy.jobs, 2);
  assert.equal(await activeJobCount(), 2);
  const afterSuccess = await sourceState();
  assert.equal(afterSuccess.last_error, null);
  assert.ok(afterSuccess.last_successful_poll_at);
  const [stored] = await db.select({ posting_url: schema.monitored_jobs.posting_url })
    .from(schema.monitored_jobs)
    .where(eq(schema.monitored_jobs.external_id, '4001'));
  assert.equal(stored?.posting_url, `https://boards.greenhouse.io/${TOKEN}/jobs/4001`,
    'the tracking suffix must be canonicalized away before storage');

  /* 2. A provider drift that rejects every listed posting must not wipe those two rows, and must
     be queryable instead of finishing as a clean poll. */
  await new Promise((resolve) => setTimeout(resolve, 5));
  globalThis.fetch = async () => respond(greenhousePayload(
    (id) => `https://careers.launch-systems.example/jobs/${id}?gh_jid=${id}`,
  ));
  const rejected = await monitor.pollSource({ ...source, last_error: afterSuccess.last_error });
  assert.equal(rejected.ok, false);
  assert.match(rejected.ok === false ? rejected.error : '', /none survived normalization/);
  assert.equal(await activeJobCount(), 2, 'live rows must survive a fully rejected fetch');
  const afterRejected = await sourceState();
  assert.match(afterRejected.last_error ?? '', /listed 2 postings/);
  assert.match(afterRejected.last_error ?? '', /keeping the 2 live rows/);
  assert.ok(afterRejected.last_polled_at! > afterSuccess.last_polled_at!,
    'the source must still advance through the oldest-first queue');
  assert.equal(
    afterRejected.last_successful_poll_at?.getTime(),
    afterSuccess.last_successful_poll_at?.getTime(),
    'a fully rejected fetch must not mint success evidence',
  );

  /* 3. An aborted list fetch - the shape a large board takes when its transfer exceeds the list
     budget - must also record a queryable last_error rather than vanish. */
  await new Promise((resolve) => setTimeout(resolve, 5));
  globalThis.fetch = async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  };
  const aborted = await monitor.pollSource({ ...source, last_error: afterRejected.last_error });
  assert.equal(aborted.ok, false);
  const afterAborted = await sourceState();
  assert.match(afterAborted.last_error ?? '', /aborted due to timeout/);
  assert.equal(await activeJobCount(), 2, 'an aborted fetch must not touch the board');
  assert.equal(
    afterAborted.last_successful_poll_at?.getTime(),
    afterSuccess.last_successful_poll_at?.getTime(),
  );

  /* 4. Recovery needs no manual repair: the next healthy poll simply re-ingests. */
  globalThis.fetch = async () => respond(greenhousePayload(
    (id) => `https://boards.greenhouse.io/${TOKEN}/jobs/${id}?gh_jid=${id}`,
  ));
  const recovered = await monitor.pollSource({ ...source, last_error: afterAborted.last_error });
  assert.equal(recovered.ok, true);
  assert.equal(await activeJobCount(), 2);
  assert.equal((await sourceState()).last_error, null);
});
