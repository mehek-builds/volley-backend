import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';

/* WHY THIS ROUTE IS TESTED AGAINST A REAL DATABASE.
 *
 * `company_counts` exists to replace a measurement that used to page the ENTIRE board through
 * GET /jobs, pulling full rows including 600 characters of description each, to learn two columns'
 * worth of facts. That was ~17 MB per pass, and on 2026-08-04 this project exhausted its Neon data
 * transfer quota and every database-backed route began answering 500, which took the public board
 * down. The replacement has to be right about two things that only a database can demonstrate:
 *
 * 1. It counts the SAME board GET /jobs serves. Counts drawn from a different predicate would make
 *    check-logo-coverage.mjs measure coverage over rows a job seeker never sees, and the number
 *    would drift from reality without ever failing.
 * 2. It counts EVERY company, not the top fifty the dropdown wants. A truncated count silently
 *    understates the denominator, which inflates coverage and hides exactly the drift the check is
 *    there to catch.
 *
 * The fixture is PGlite speaking the real wire protocol over a unix socket, so the production `db`
 * module connects with the production driver, and the DDL is generated from db/schema.ts at run
 * time so it cannot drift from the real schema.
 */

const ENCRYPTION_KEY = 'job-facets-counts-test-key';
const JWT_SIGNING_SECRET = 'job-facets-counts-test-secret';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let db: typeof import('../db/index')['db'];
let pool: typeof import('../db/index')['pool'];
let schema: typeof import('../db/schema');

/** Postings per employer, chosen so a row-weighted count differs sharply from a company count. */
const SEED: Record<string, number> = { Zscaler: 5, Lucid: 3, Huckberry: 1 };

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-facets-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);

  const { career_page_sources, monitored_jobs } = schema;
  const [source] = await db.insert(career_page_sources).values({
    company_name: 'Fixture Source',
    ats_name: 'greenhouse',
    board_token: 'fixture',
    career_url: 'https://job-boards.greenhouse.io/fixture',
    enabled: true,
  }).returning();

  for (const [company, count] of Object.entries(SEED)) {
    for (let i = 0; i < count; i++) {
      await db.insert(monitored_jobs).values({
        source_id: source.id,
        external_id: `${company}-${i}`,
        company_name: company,
        title: `Engineer ${i}`,
        description: 'x'.repeat(50),
        apply_url: `https://example.com/${company}/${i}`,
        posting_url: `https://example.com/${company}/${i}`,
        // Recently verified, so boardConditions surfaces it exactly as GET /jobs would.
        posted_at: new Date(Date.now() - 24 * 60 * 60 * 1000),
        last_seen_at: new Date(),
        is_active: true,
      });
    }
  }

  const { jobMonitorRoutes } = await import('./jobMonitor');
  app = Fastify({ logger: false });
  await app.register(jobMonitorRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('the default response is unchanged, so the website pays nothing for the new field', async () => {
  const res = await app.inject({ method: 'GET', url: '/jobs/facets' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.companies), 'the dropdown still gets its companies');
  assert.equal('company_counts' in body, false, 'company_counts must be opt-in');
});

test('counts=true returns every company with its true row count', async () => {
  const res = await app.inject({ method: 'GET', url: '/jobs/facets?counts=true' });
  assert.equal(res.statusCode, 200);
  const counts: { company_name: string; rows: number }[] = res.json().company_counts;

  assert.ok(Array.isArray(counts), 'company_counts must be present when asked for');
  // EVERY company, not a top-N slice: a truncated denominator inflates coverage.
  assert.equal(counts.length, Object.keys(SEED).length);

  const byName = Object.fromEntries(counts.map((c) => [c.company_name, c.rows]));
  assert.deepEqual(byName, SEED);

  // The denominator the coverage check divides by has to be the whole board.
  const total = counts.reduce((sum, c) => sum + c.rows, 0);
  assert.equal(total, Object.values(SEED).reduce((a, b) => a + b, 0));
});

test('counts describe the same board GET /jobs serves', async () => {
  // If these two ever disagree, coverage is being measured over rows nobody can see.
  const [facets, jobs] = await Promise.all([
    app.inject({ method: 'GET', url: '/jobs/facets?counts=true' }),
    app.inject({ method: 'GET', url: '/jobs?limit=100' }),
  ]);
  const counted = facets.json().company_counts.reduce((s: number, c: { rows: number }) => s + c.rows, 0);
  assert.equal(counted, jobs.json().total, 'grouped count must equal the board total');
});

test('a posting outside the verification window is counted by neither', async () => {
  // The board hides unverified postings, so a count that included them would overstate the denominator
  // and quietly drag measured coverage down for rows no job seeker is shown.
  const { career_page_sources, monitored_jobs } = schema;
  const [source] = await db.select().from(career_page_sources).limit(1);
  await db.insert(monitored_jobs).values({
    source_id: source.id,
    external_id: 'stale-1',
    company_name: 'Ancient Co',
    title: 'Engineer',
    description: 'x',
    apply_url: 'https://example.com/stale',
    posting_url: 'https://example.com/stale',
    posted_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    last_seen_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    is_active: true,
  });

  const res = await app.inject({ method: 'GET', url: '/jobs/facets?counts=true' });
  const names = res.json().company_counts.map((c: { company_name: string }) => c.company_name);
  assert.ok(!names.includes('Ancient Co'), 'an unverified posting must not enter the denominator');
});

test('an old posting still counts when its employer feed verified it recently', async () => {
  const { career_page_sources, monitored_jobs } = schema;
  const [source] = await db.select().from(career_page_sources).limit(1);
  await db.insert(monitored_jobs).values({
    source_id: source.id,
    external_id: 'old-but-open',
    company_name: 'Long Running Requisition Co',
    title: 'Engineer',
    description: 'A full role description that the employer still publishes on its live careers feed.',
    apply_url: 'https://example.com/old-but-open',
    posting_url: 'https://example.com/old-but-open',
    posted_at: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
    last_seen_at: new Date(),
    is_active: true,
  });

  const res = await app.inject({ method: 'GET', url: '/jobs/facets?counts=true' });
  const names = res.json().company_counts.map((c: { company_name: string }) => c.company_name);
  assert.ok(names.includes('Long Running Requisition Co'));
});
