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

/* Since the employer-hosted embed fallback, a Greenhouse action URL alone can no longer reject a
   posting - only a malformed IDENTITY can (a non-numeric id has no embed route). This is the
   payload shape that still fully rejects: same two listed postings, ids that cannot mint a URL. */
function identityDriftedPayload() {
  const content = `<p>${'Design, build, and operate reliable launch-control software with the flight software team. '.repeat(3)}</p>`;
  return JSON.stringify({
    jobs: ['drifted-4001', 'drifted-4002'].map((id) => ({
      id,
      title: `Flight Software Engineer ${id}`,
      absolute_url: `https://careers.launch-systems.example/jobs/${id}`,
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

async function sourceState(sourceId = SOURCE_ID) {
  const [row] = await db.select({
    last_polled_at: schema.career_page_sources.last_polled_at,
    last_successful_poll_at: schema.career_page_sources.last_successful_poll_at,
    last_error: schema.career_page_sources.last_error,
    last_poll_listed_count: schema.career_page_sources.last_poll_listed_count,
    last_poll_normalized_count: schema.career_page_sources.last_poll_normalized_count,
  }).from(schema.career_page_sources).where(eq(schema.career_page_sources.id, sourceId));
  return row!;
}

/** The row exactly as the drain query hands it to pollSource, baseline counts included. */
async function sourceRow(sourceId: string) {
  const [row] = await db.select().from(schema.career_page_sources)
    .where(eq(schema.career_page_sources.id, sourceId));
  return row!;
}

async function activeJobCount(sourceId = SOURCE_ID) {
  const rows = await db.select({ is_active: schema.monitored_jobs.is_active })
    .from(schema.monitored_jobs)
    .where(eq(schema.monitored_jobs.source_id, sourceId));
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
  assert.equal(afterSuccess.last_poll_listed_count, 2,
    'a completed poll must persist the rejection baseline');
  assert.equal(afterSuccess.last_poll_normalized_count, 2);
  const [stored] = await db.select({ posting_url: schema.monitored_jobs.posting_url })
    .from(schema.monitored_jobs)
    .where(eq(schema.monitored_jobs.external_id, '4001'));
  assert.equal(stored?.posting_url, `https://boards.greenhouse.io/${TOKEN}/jobs/4001`,
    'the tracking suffix must be canonicalized away before storage');

  /* 2. A provider drift that rejects every listed posting must not wipe those two rows, and must
     be queryable instead of finishing as a clean poll. Since the embed fallback, employer-hosted
     URLs INGEST for Greenhouse, so full rejection here means identity drift. */
  await new Promise((resolve) => setTimeout(resolve, 5));
  globalThis.fetch = async () => respond(identityDriftedPayload());
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
  assert.equal(afterRejected.last_poll_listed_count, 2,
    'a guard fault must not poison the rejection baseline');
  assert.equal(afterRejected.last_poll_normalized_count, 2);

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

const SPIKE_SOURCE_ID = '92000000-0000-4000-8000-000000000002';
const SPIKE_COMPANY = 'Orbital Data Company';
const SPIKE_TOKEN = 'orbital-data';

/** A 60-posting board where `drifted` of the postings carry identities that reject normalization.
 *  (Since the embed fallback, an off-host absolute_url alone no longer rejects a Greenhouse
 *  posting; a non-numeric id is the rejection class the spike detector still guards there.) */
function largeBoardPayload(drifted: number) {
  const content = `<p>${'Design, build, and operate reliable data-platform software with the platform team. '.repeat(3)}</p>`;
  return JSON.stringify({
    jobs: Array.from({ length: 60 }, (_, index) => {
      const id = index < drifted ? `drifted-${5000 + index}` : String(5000 + index);
      return {
        id,
        title: `Data Platform Engineer ${id}`,
        /* Drifted rows also publish off-host, because a first-party hosted URL matching the id
           would validate regardless of the id's shape; rejection needs both halves to fail. */
        absolute_url: index < drifted
          ? `https://careers.orbital-data.example/jobs/${id}`
          : `https://boards.greenhouse.io/${SPIKE_TOKEN}/jobs/${id}?gh_jid=${id}`,
        location: { name: 'Austin, TX' },
        company_name: SPIKE_COMPANY,
        content,
        updated_at: new Date().toISOString(),
      };
    }),
  });
}

test('a partial action-URL drift is detected as a rejection spike against the previous poll', async () => {
  /* The accepted gap in the fully-rejected guard, end to end: when MOST but not all of a board
     fails action-URL validation (a new query param rolling through mixed CDN caches), the poll
     completes as a success and sweeps the rejected rows. The sweep stands - one survivor is real
     list evidence - but the drift must land in last_error and the poll result, judged as a DELTA
     against the persisted baseline so a board's steady by-design host rejections never page. */
  const now = new Date();
  await db.insert(schema.career_page_sources).values({
    id: SPIKE_SOURCE_ID,
    company_name: SPIKE_COMPANY,
    ats_name: 'greenhouse',
    board_token: SPIKE_TOKEN,
    career_url: `https://job-boards.greenhouse.io/${SPIKE_TOKEN}`,
    company_domain: `${SPIKE_TOKEN}.example`,
    company_logo_url: `https://${SPIKE_TOKEN}.example/logo.png`,
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: now,
    portal_company_name: SPIKE_COMPANY,
    portal_name_mismatch: false,
    enabled: true,
  });

  /* 1. First completed poll writes the baseline and, having none to compare against, never alerts. */
  globalThis.fetch = async () => respond(largeBoardPayload(0));
  const first = await monitor.pollSource(await sourceRow(SPIKE_SOURCE_ID));
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.ok && first.rejected, 0);
  assert.ok(first.ok && !('rejection_spike' in first));
  const afterFirst = await sourceState(SPIKE_SOURCE_ID);
  assert.equal(afterFirst.last_poll_listed_count, 60);
  assert.equal(afterFirst.last_poll_normalized_count, 60);
  assert.equal(afterFirst.last_error, null);
  assert.equal(await activeJobCount(SPIKE_SOURCE_ID), 60);

  /* 2. Half the board drifts to a rejected host: still a SUCCESS, still swept, but now visible. */
  await new Promise((resolve) => setTimeout(resolve, 5));
  globalThis.fetch = async () => respond(largeBoardPayload(30));
  const spiked = await monitor.pollSource(await sourceRow(SPIKE_SOURCE_ID));
  assert.equal(spiked.ok, true, JSON.stringify(spiked));
  assert.equal(spiked.ok && spiked.rejected, 30);
  assert.match(spiked.ok && spiked.rejection_spike || '', /Action-URL rejections jumped: 30 of 60/);
  const afterSpike = await sourceState(SPIKE_SOURCE_ID);
  assert.match(afterSpike.last_error ?? '', /Action-URL rejections jumped/,
    'the spike must be queryable in career_page_sources.last_error');
  assert.ok(afterSpike.last_successful_poll_at! > afterFirst.last_successful_poll_at!,
    'a spiked poll is still a completed poll');
  assert.equal(afterSpike.last_poll_listed_count, 60);
  assert.equal(afterSpike.last_poll_normalized_count, 30);
  assert.equal(await activeJobCount(SPIKE_SOURCE_ID), 30,
    'the sweep is not second-guessed; detection only');

  /* 3. The same shape again is the new steady baseline: no repeat alert, and the error clears. */
  await new Promise((resolve) => setTimeout(resolve, 5));
  const steady = await monitor.pollSource(await sourceRow(SPIKE_SOURCE_ID));
  assert.equal(steady.ok, true);
  assert.ok(steady.ok && !('rejection_spike' in steady),
    'an unchanged rejection count must not alert again');
  assert.equal((await sourceState(SPIKE_SOURCE_ID)).last_error, null);

  /* 4. A guard-preserved fault never becomes the baseline. */
  await new Promise((resolve) => setTimeout(resolve, 5));
  globalThis.fetch = async () => respond(largeBoardPayload(60));
  const fullyRejected = await monitor.pollSource(await sourceRow(SPIKE_SOURCE_ID));
  assert.equal(fullyRejected.ok, false);
  const afterGuard = await sourceState(SPIKE_SOURCE_ID);
  assert.equal(afterGuard.last_poll_listed_count, 60);
  assert.equal(afterGuard.last_poll_normalized_count, 30,
    'the fully-rejected guard must leave the baseline where the last completed poll put it');

  /* 5. Recovery is an improvement against that baseline, not a spike. */
  await new Promise((resolve) => setTimeout(resolve, 5));
  globalThis.fetch = async () => respond(largeBoardPayload(0));
  const recovered = await monitor.pollSource(await sourceRow(SPIKE_SOURCE_ID));
  assert.equal(recovered.ok, true);
  assert.ok(recovered.ok && !('rejection_spike' in recovered));
  const afterRecovery = await sourceState(SPIKE_SOURCE_ID);
  assert.equal(afterRecovery.last_error, null);
  assert.equal(afterRecovery.last_poll_normalized_count, 60);
  assert.equal(await activeJobCount(SPIKE_SOURCE_ID), 60);
});

test('an empty completed poll never writes a 0/0 baseline for later polls to spike against', async () => {
  /* A brand-new board with nothing listed and nothing live slips PAST the empty-fetch guard (there
     is nothing to preserve) and completes as a success. That poll must not store a zero baseline:
     the next real poll of a steadily host-rejected board would read its by-design rejections as a
     jump from zero and page on a healthy day one. */
  const EMPTY_SOURCE_ID = '92000000-0000-4000-8000-000000000003';
  await db.insert(schema.career_page_sources).values({
    id: EMPTY_SOURCE_ID,
    company_name: 'Quiet Board Company',
    ats_name: 'greenhouse',
    board_token: 'quiet-board',
    career_url: 'https://job-boards.greenhouse.io/quiet-board',
    enabled: true,
  });
  globalThis.fetch = async () => respond(JSON.stringify({ jobs: [] }));
  const emptyPoll = await monitor.pollSource(await sourceRow(EMPTY_SOURCE_ID));
  assert.equal(emptyPoll.ok, true, JSON.stringify(emptyPoll));
  const afterEmpty = await sourceState(EMPTY_SOURCE_ID);
  assert.ok(afterEmpty.last_successful_poll_at, 'a truly empty new board is a completed poll');
  assert.equal(afterEmpty.last_poll_listed_count, null,
    'an empty list carries no rejection rate and must not become the baseline');
  assert.equal(afterEmpty.last_poll_normalized_count, null);
});
