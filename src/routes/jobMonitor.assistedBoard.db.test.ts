import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';

/* THE DASHBOARD ASSISTED TIER, SURFACED WITHOUT LEAKING INTO ONBOARDING.
 *
 * An assisted board (rippling) is fillable but its send is gated by a human check Litos does not
 * complete, so it fills-and-hands-off. Onboarding must only ever show jobs Litos submits end to end;
 * the dashboard may show assisted jobs too, clearly marked. The line between the two is server-side:
 * an account that has finished onboarding (a real onboarding_completed_at) is on the dashboard and
 * sees assisted jobs; a guest or an account still in setup is in the onboarding flow and does not.
 *
 * This proves all three cases against the real GET /jobs route and a real Postgres, and that the
 * submit_mode the client reads to draw its badge is correct for each family. */

const JWT_SECRET = 'assisted-board-db-test-secret-32chars';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-assisted-board-'));
const savedEnv = { ...process.env };
const COMPLETE_USER = 'c0000000-0000-4000-8000-000000000001';
const SETUP_USER = 'c0000000-0000-4000-8000-000000000002';

let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let db: typeof import('../db/index')['db'];
let schema: typeof import('../db/schema');

type BoardJob = { id: string; ats_name: string; submit_mode?: 'autonomous' | 'assisted' };

async function bearer(userId: string) {
  return `Bearer ${await new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'password' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET))}`;
}

async function boardJobs(headers: Record<string, string>): Promise<BoardJob[]> {
  const response = await app.inject({ method: 'GET', url: '/jobs?offset=0', headers });
  assert.equal(response.statusCode, 200, response.body);
  return (response.json() as { jobs: BoardJob[] }).jobs;
}

const DESCRIPTION = 'Build and operate reliable software used by teams around the world; own implementation, testing, incident response, and technical documentation, meeting the stated engineering requirements.'.repeat(2);

before(async () => {
  database = await PGlite.create();
  schema = await import('../db/schema');
  const initial = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of initial) await database.exec(statement);
  server = new PGLiteSocketServer({ db: database, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();

  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  process.env.ENCRYPTION_KEY = 'assisted-board-db-test-encryption-key';

  const dbModule = await import('../db');
  db = dbModule.db;
  backendPool = dbModule.pool;

  const verifiedNow = new Date();
  const [autonomousSource] = await db.insert(schema.career_page_sources).values({
    company_name: 'Verkada', ats_name: 'greenhouse', board_token: 'verkada',
    career_url: 'https://job-boards.greenhouse.io/verkada', company_domain: 'verkada.example',
    company_logo_url: 'https://assets.verkada.example/logo.png', logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo', logo_verified_at: verifiedNow,
    portal_company_name: 'Verkada', portal_name_mismatch: false, enabled: true,
  }).returning();
  const [assistedSource] = await db.insert(schema.career_page_sources).values({
    company_name: 'Utility', ats_name: 'rippling', board_token: 'utility',
    career_url: 'https://ats.rippling.com/utility/jobs', company_domain: 'utility.example',
    company_logo_url: 'https://assets.utility.example/logo.png', logo_verification_status: 'verified',
    logo_verification_method: 'first_party_ats_employer_logo', logo_verified_at: verifiedNow,
    portal_company_name: 'Utility', portal_name_mismatch: false, enabled: true,
  }).returning();
  await db.insert(schema.monitored_jobs).values([
    {
      source_id: autonomousSource.id, external_id: 'gh-1', company_name: 'Verkada',
      title: 'Backend Engineer', description: DESCRIPTION, ingest_eligible: true,
      apply_url: 'https://job-boards.greenhouse.io/verkada/jobs/1',
      posting_url: 'https://job-boards.greenhouse.io/verkada/jobs/1',
      first_seen_at: verifiedNow, last_seen_at: verifiedNow, is_active: true,
    },
    {
      source_id: assistedSource.id, external_id: 'rip-1', company_name: 'Utility',
      title: 'Platform Engineer', description: DESCRIPTION, ingest_eligible: true,
      apply_url: 'https://ats.rippling.com/utility/jobs/rip-1/apply',
      posting_url: 'https://ats.rippling.com/utility/jobs/rip-1',
      first_seen_at: verifiedNow, last_seen_at: verifiedNow, is_active: true,
    },
  ]);
  await db.insert(schema.users).values([
    { id: COMPLETE_USER, email: 'done@example.com', email_verified: true, is_guest: false,
      session_version: 0, onboarding_completed_at: verifiedNow },
    { id: SETUP_USER, email: 'setup@example.com', email_verified: true, is_guest: false,
      session_version: 0, onboarding_completed_at: null },
  ]);

  const { jobMonitorRoutes } = await import('./jobMonitor');
  app = Fastify({ logger: false });
  await app.register(jobMonitorRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('a guest board is autonomous-only: the assisted (rippling) job is not surfaced', async () => {
  const jobs = await boardJobs({});
  const families = jobs.map((j) => j.ats_name).sort();
  assert.deepEqual(families, ['greenhouse'], 'a guest must see only autonomous jobs');
  assert.equal(jobs.every((j) => j.submit_mode === 'autonomous'), true);
});

test('an account still in setup gets the autonomous-only board (onboarding stays autonomous-only)', async () => {
  const jobs = await boardJobs({ authorization: await bearer(SETUP_USER) });
  assert.deepEqual(jobs.map((j) => j.ats_name).sort(), ['greenhouse'],
    'an in-onboarding account must not see assisted jobs');
});

test('an onboarding-completed account sees the assisted job, marked submit_mode=assisted', async () => {
  const jobs = await boardJobs({ authorization: await bearer(COMPLETE_USER) });
  const byFamily = new Map(jobs.map((j) => [j.ats_name, j]));
  assert.deepEqual([...byFamily.keys()].sort(), ['greenhouse', 'rippling'],
    'the dashboard sees both the autonomous and the assisted job');
  assert.equal(byFamily.get('greenhouse')?.submit_mode, 'autonomous');
  assert.equal(byFamily.get('rippling')?.submit_mode, 'assisted',
    'the assisted job must carry submit_mode=assisted so the client can mark it fill-and-handoff');
});
