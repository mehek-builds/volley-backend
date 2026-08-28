import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { SignJWT } from 'jose';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * FINDING #1's PROOF: a real, PGlite-backed account walking the /start flow's OWN call sequence,
 * in the OWN order, must never 402 -- and the same account reaching for a route that flow never
 * calls (the dashboard, network, documents, the applications list, ordinary post-onboarding job
 * board browsing) must always 402, whether it tries that BEFORE touching onboarding at all (the
 * original bug: a gated account's JWT hitting a data route directly, out of band) or AFTER
 * finishing the one application onboarding grants it.
 *
 * Route sequence traced from role-quick-website origin/main by reading every step component
 * app/start/page.tsx renders and following each api() call to lib/api.ts (see lib/cardGate.ts's
 * TIER B2 comment for the full trace). The real /onboarding/* handlers are registered so the
 * acknowledgement ledger this test drives is the same one production writes; every other route the
 * sequence touches is a thin stub carrying the real path template and the real preHandler
 * (requireAuth or optionalAuth), because what is under test is THE GATE's decision, not the
 * business logic behind each handler.
 */

const previousDatabaseUrl = process.env.DATABASE_URL;
const previousSecret = process.env.JWT_SIGNING_SECRET;
const previousGate = process.env.CARD_GATE_FROM;
const JWT_SECRET = 'test-signing-secret-32-chars-minimum!!';

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let pool: typeof import('../db/index')['pool'];
let db: typeof import('../db/index')['db'];
let schema: typeof import('../db/schema');
let requireAuth: typeof import('./auth')['requireAuth'];
let optionalAuth: typeof import('./auth')['optionalAuth'];
let onboardingRoutes: typeof import('../routes/onboarding')['onboardingRoutes'];
let dashboardBootstrapRoutes: typeof import('../routes/dashboardBootstrap')['dashboardBootstrapRoutes'];
let CURRENT_ONBOARDING_FLOW_VERSION: number;

before(async () => {
  socketDir = mkdtempSync(join(tmpdir(), 'litos-cardgate-sequence-'));
  pglite = await PGlite.create();
  server = new PGLiteSocketServer({ db: pglite, path: join(socketDir, '.s.PGSQL.5432'), maxConnections: 10 });
  await server.start();
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;

  schema = await import('../db/schema');
  const dbModule = await import('../db/index');
  db = dbModule.db;
  pool = dbModule.pool;
  ({ requireAuth, optionalAuth } = await import('./auth'));
  ({ onboardingRoutes } = await import('../routes/onboarding'));
  ({ dashboardBootstrapRoutes } = await import('../routes/dashboardBootstrap'));
  ({ CURRENT_ONBOARDING_FLOW_VERSION } = await import('../lib/onboardingFlowLedger'));

  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await pglite.exec(statement);
});

after(async () => {
  await pool?.end();
  await server?.stop();
  await pglite?.close();
  if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  if (previousSecret === undefined) delete process.env.JWT_SIGNING_SECRET;
  else process.env.JWT_SIGNING_SECRET = previousSecret;
  if (previousGate === undefined) delete process.env.CARD_GATE_FROM;
  else process.env.CARD_GATE_FROM = previousGate;
});

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // The real onboarding routes: this is what actually writes the acknowledgement ledger, so the
  // "notifications acknowledged" boundary TIER B2 reads is the same write path production uses.
  await app.register(onboardingRoutes);
  // The real dashboard bootstrap route: what is under test on it is only its own outer gate (see
  // Finding #3), so its internal fastify.inject sub-fetches never need to succeed here.
  await app.register(dashboardBootstrapRoutes);

  // TIER B2's other real path templates: thin stubs, because what is under test is whether THE
  // GATE lets the request reach a handler at all, not what /resume/generate's real pipeline does.
  const stub200 = async (_req: unknown, reply: { status: (n: number) => { send: (b: unknown) => void } }) =>
    reply.status(200).send({ ok: true });
  app.get('/jobs', { preHandler: optionalAuth }, stub200);
  app.get('/jobs/grouped', { preHandler: optionalAuth }, stub200);
  app.get('/jobs/facets', { preHandler: optionalAuth }, stub200);
  app.get('/jobs/:id', { preHandler: optionalAuth }, stub200);
  app.post('/resume/generate', { preHandler: requireAuth }, stub200);
  app.get('/resume/base', { preHandler: requireAuth }, stub200);
  app.post('/resume/base/stream', { preHandler: requireAuth }, stub200);
  app.get('/postings/:jobId/questions', { preHandler: requireAuth }, stub200);
  app.post('/applications/from-job', { preHandler: requireAuth }, stub200);
  app.post('/applications/:id/submit-request', { preHandler: requireAuth }, stub200);
  app.get('/notifications/preferences', { preHandler: requireAuth }, stub200);
  app.put('/notifications/preferences', { preHandler: requireAuth }, stub200);
  app.get('/profile', { preHandler: requireAuth }, stub200);
  // Never-onboarding, always-blocked-while-locked routes -- the direct-hit bypass this whole gate
  // exists to close.
  app.get('/network/people', { preHandler: requireAuth }, stub200);
  app.get('/documents', { preHandler: requireAuth }, stub200);
  app.get('/applications', { preHandler: requireAuth }, stub200);

  await app.ready();
  return app;
}

async function lockedUser(email: string) {
  const [user] = await db.insert(schema.users).values({
    email,
    email_verified: true,
    // Well after CARD_GATE_FROM (set in the test below) and with no billing_provider/customer_id,
    // so requiresPaymentMethodFor -- and therefore accountIsCardGateLocked -- is true immediately.
    created_at: new Date('2026-08-20T00:00:00.000Z'),
  }).returning();
  return user;
}

function signToken(userId: string): Promise<string> {
  return new SignJWT({ userId, isGuest: false, authMethod: 'password', sessionVersion: 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET));
}

const NEVER_ONBOARDING_PATHS: readonly { method: 'GET' | 'POST'; url: string }[] = [
  { method: 'GET', url: '/dashboard/bootstrap' },
  { method: 'GET', url: '/network/people' },
  { method: 'GET', url: '/documents' },
  { method: 'GET', url: '/applications' },
  { method: 'GET', url: '/jobs/grouped' },
  { method: 'GET', url: '/jobs/facets' },
];

test('THE CARD GATE, walking the real /start sequence against a real database', async (t) => {
  process.env.CARD_GATE_FROM = '2026-08-19T00:00:00.000Z';
  const app = await buildApp();
  const user = await lockedUser('cardgate-sequence@example.com');
  const token = await signToken(user.id);
  const auth = { authorization: `Bearer ${token}` };

  try {
    await t.test('THE ORIGINAL BUG: before touching onboarding at all, every never-onboarding route 402s', async () => {
      for (const { method, url } of NEVER_ONBOARDING_PATHS) {
        const response = await app.inject({ method, url, headers: auth });
        assert.equal(response.statusCode, 402, `${method} ${url} should 402 for a locked account with an empty ledger`);
        assert.equal(response.json().code, 'payment_method_required');
      }
    });

    const ack = async (step: string) => {
      const response = await app.inject({
        method: 'POST',
        url: '/onboarding/flow/steps',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: { flow_version: CURRENT_ONBOARDING_FLOW_VERSION, step, disposition: 'continued' },
      });
      assert.equal(response.statusCode, 200, `acknowledging '${step}' should succeed: ${response.body}`);
    };

    await t.test('THE LEGITIMATE SEQUENCE: every route /start actually calls, in its own order, never 402s', async () => {
      // GET /onboarding/state -- TIER A, the first call /start makes.
      assert.equal((await app.inject({ method: 'GET', url: '/onboarding/state', headers: auth })).statusCode, 200);

      // 'match': MatchStep.tsx pulls the ranked board from GET /jobs.
      assert.equal((await app.inject({ method: 'GET', url: '/jobs?limit=5', headers: auth })).statusCode, 200);
      // BuildStep.tsx: builds the packet, looks up the chosen posting, and checks its extra questions.
      assert.equal((await app.inject({ method: 'POST', url: '/resume/generate', headers: auth })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/jobs/job-1', headers: auth })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/postings/job-1/questions', headers: auth })).statusCode, 200);
      await ack('match');

      // 'questions': QuestionsStep.tsx saves what the employer asked.
      assert.equal((await app.inject({
        method: 'POST',
        url: '/onboarding/answers',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: { answers: [] },
      })).statusCode, 200);
      await ack('questions');

      // 'review': ReviewStep.tsx sends the application.
      assert.equal((await app.inject({ method: 'POST', url: '/applications/app-1/submit-request', headers: auth })).statusCode, 200);
      await ack('review');

      // 'trial': no API call of its own, only the acknowledgement.
      await ack('trial');

      // 'notifications': NotificationsStep.tsx reads and writes the two permissions.
      assert.equal((await app.inject({ method: 'GET', url: '/notifications/preferences', headers: auth })).statusCode, 200);
      assert.equal((await app.inject({
        method: 'PUT',
        url: '/notifications/preferences',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: { strong_match: true },
      })).statusCode, 200);
      await ack('notifications');

      // 'plan' itself is TIER A (billing) and is exercised by the existing requireAuth suite; this
      // account stops here, at the payment wall, exactly where a real locked account would.
    });

    await t.test('AFTER FINISHING THE ONE APPLICATION: TIER B2 build routes close, even though the account is still locked', async () => {
      const buildRoutes: { method: 'GET' | 'POST'; url: string }[] = [
        { method: 'GET', url: '/jobs?limit=5' },
        { method: 'GET', url: '/jobs/job-2' },
        { method: 'POST', url: '/resume/generate' },
        { method: 'GET', url: '/postings/job-2/questions' },
        { method: 'POST', url: '/applications/from-job' },
        { method: 'POST', url: '/applications/app-2/submit-request' },
      ];
      for (const { method, url } of buildRoutes) {
        const response = await app.inject({ method, url, headers: auth });
        assert.equal(response.statusCode, 402, `${method} ${url} should 402 once notifications has been acknowledged`);
      }
    });

    await t.test('the never-onboarding routes are STILL blocked, same as before the sequence ran', async () => {
      for (const { method, url } of NEVER_ONBOARDING_PATHS) {
        const response = await app.inject({ method, url, headers: auth });
        assert.equal(response.statusCode, 402, `${method} ${url} should still 402`);
      }
    });

    await t.test('TIER A and TIER B1 stay reachable throughout: the account can still pay, check state, or fix its profile', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/onboarding/state', headers: auth })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/profile', headers: auth })).statusCode, 200);
    });
  } finally {
    await app.close();
  }
});
