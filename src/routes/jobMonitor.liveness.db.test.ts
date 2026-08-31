import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

const POISON_SOURCE_ID = '91000000-0000-4000-8000-000000000001';
const HEALTHY_SOURCE_ID = '91000000-0000-4000-8000-000000000002';

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
  process.env.ENCRYPTION_KEY = 'job-monitor-liveness-database-test-key';
  process.env.JWT_SIGNING_SECRET = 'job-monitor-liveness-database-test-secret';

  socketDir = mkdtempSync(join(tmpdir(), 'litos-job-monitor-liveness-'));
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

function sourceValues(id: string, token: string, company: string) {
  const now = new Date();
  return {
    id,
    company_name: company,
    ats_name: 'greenhouse',
    board_token: token,
    career_url: `https://job-boards.greenhouse.io/${token}`,
    company_domain: `${token}.example`,
    company_logo_url: `https://${token}.example/logo.png`,
    logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo',
    logo_verified_at: now,
    portal_company_name: company,
    portal_name_mismatch: false,
    enabled: true,
  };
}

test('a poison persistence source terminates while a healthy sibling certifies', async () => {
  const poisonCompany = 'Poison Persistence Company';
  const healthyCompany = 'Healthy Persistence Company';
  const [poison, healthy] = await db.insert(schema.career_page_sources).values([
    sourceValues(POISON_SOURCE_ID, 'poison-persistence', poisonCompany),
    sourceValues(HEALTHY_SOURCE_ID, 'healthy-persistence', healthyCompany),
  ]).returning();

  await database.exec(`
    create sequence poison_persistence_attempts;
    create function reject_poison_persistence() returns trigger language plpgsql as $$
    begin
      if new.source_id = '${POISON_SOURCE_ID}'::uuid then
        perform nextval('poison_persistence_attempts');
        raise exception 'deterministic poison persistence row' using errcode = '23514';
      end if;
      return new;
    end $$;
    create trigger reject_poison_persistence
      before insert or update on monitored_jobs
      for each row execute function reject_poison_persistence();
  `);

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const token = url.pathname.split('/')[3]!;
    const isPoison = token === 'poison-persistence';
    const id = isPoison ? 'poison-job' : 'healthy-job';
    const company = isPoison ? poisonCompany : healthyCompany;
    return new Response(JSON.stringify({
      jobs: [{
        id,
        title: 'Platform Engineer',
        absolute_url: `https://job-boards.greenhouse.io/${token}/jobs/${id}`,
        location: { name: 'New York, NY' },
        company_name: company,
        content: `<p>${'Build and operate reliable production services with a collaborative engineering team. '.repeat(3)}</p>`,
        updated_at: new Date().toISOString(),
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const drainStartedAt = new Date(Date.now() - 1_000);
  const run = await Promise.all([monitor.pollSource(poison), monitor.pollSource(healthy)]);
  assert.equal(run.length, 2);
  assert.equal(run.find((result) => result.source_id === POISON_SOURCE_ID)?.ok, false);
  assert.equal(run.find((result) => result.source_id === HEALTHY_SOURCE_ID)?.ok, true);

  const attemptResult = await db.execute<{ last_value: number }>(sql`
    select last_value::int from poison_persistence_attempts
  `);
  const [attempts] = attemptResult.rows;
  assert.equal(Number(attempts?.last_value), monitor.POLL_SOURCE_PERSISTENCE_ATTEMPTS);

  const sourceRows = await db.select({
    id: schema.career_page_sources.id,
    last_polled_at: schema.career_page_sources.last_polled_at,
    last_successful_poll_at: schema.career_page_sources.last_successful_poll_at,
    last_error: schema.career_page_sources.last_error,
  }).from(schema.career_page_sources).where(or(
    eq(schema.career_page_sources.id, POISON_SOURCE_ID),
    eq(schema.career_page_sources.id, HEALTHY_SOURCE_ID),
  ));
  const poisonState = sourceRows.find((row) => row.id === POISON_SOURCE_ID)!;
  const healthyState = sourceRows.find((row) => row.id === HEALTHY_SOURCE_ID)!;
  assert.ok(poisonState.last_polled_at && poisonState.last_polled_at >= drainStartedAt);
  assert.equal(poisonState.last_successful_poll_at, null);
  assert.match(poisonState.last_error ?? '', /deterministic poison persistence row/);
  assert.ok(healthyState.last_successful_poll_at && healthyState.last_successful_poll_at >= drainStartedAt);

  const [remaining] = await db.select({ total: sql<number>`count(*)::int` })
    .from(schema.career_page_sources)
    .where(and(
      or(
        eq(schema.career_page_sources.id, POISON_SOURCE_ID),
        eq(schema.career_page_sources.id, HEALTHY_SOURCE_ID),
      ),
      or(
        isNull(schema.career_page_sources.last_polled_at),
        lt(schema.career_page_sources.last_polled_at, drainStartedAt),
      ),
    ));
  assert.equal(remaining?.total, 0, 'the poison source must not pin the oldest-first queue');

  const persistedFailures = await monitor.currentDrainPollFailures(drainStartedAt);
  const finalResults = monitor.mergeCurrentDrainPollFailures([], persistedFailures);
  assert.deepEqual(finalResults.map((result) => ({
    source_id: result.source_id,
    ok: result.ok,
    error: result.error,
  })), [{
    source_id: POISON_SOURCE_ID,
    ok: false,
    error: poisonState.last_error,
  }]);

  const inventory = await monitor.boardInventoryMetrics(db, drainStartedAt);
  assert.equal(inventory.certifiedUniqueJobs, 1,
    'only the healthy source can mint current-drain certified inventory');
});
