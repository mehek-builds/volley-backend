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
 * FINDING #1's PROOF (round 2): a real, PGlite-backed account walking the /start flow's OWN call
 * sequence, in the OWN order, must never 402 -- and the same account reaching for a route that flow
 * never calls (the dashboard, network, documents, the applications list, ordinary post-onboarding job
 * board browsing) must always 402, whether it tries that BEFORE touching onboarding at all (the
 * original bug: a gated account's JWT hitting a data route directly, out of band) or AFTER actually
 * sending its one free application.
 *
 * TIER B2's closure signal changed in this round: it used to be `flow.acknowledged.includes(
 * 'notifications')`, a voluntary client acknowledgement with no server-side ordering or requirement.
 * A code review (2026-08-29) found that never closed for a client that simply never sent the
 * acknowledgement, and closed too early for a client that sent it first, before building anything.
 * It is now a real row in generated_resumes -- status='submitted', written only by
 * submissionRunner.ts after a verified send, with submission_authorization.source=
 * 'per_application_approval', the value only the student's own review-and-send screen writes (see
 * lib/approvedApplicationSubmissions.ts). POST /applications/:id/submit-request is stubbed in this
 * suite the same way every other TIER B2 route is (what is under test is THE GATE's decision, not
 * submissionRunner.ts's real pipeline), so this suite writes that row directly to simulate the
 * pipeline's own eventual write, exactly the way markSubmitted below is documented to.
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

  // The real onboarding routes: this is what actually writes the acknowledgement ledger, so a
  // client walking the real /start sequence exercises the same writes production does -- even
  // though THE GATE itself no longer reads that ledger (see the file header).
  await app.register(onboardingRoutes);
  // The real dashboard bootstrap route: what is under test on it is only its own outer gate (see
  // Finding #3, round 1), so its internal fastify.inject sub-fetches never need to succeed here.
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
  app.post('/notifications/push/subscribe', { preHandler: requireAuth }, stub200);
  app.post('/notifications/push/unsubscribe', { preHandler: requireAuth }, stub200);
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

/**
 * Writes the row hasApprovedSubmittedApplication (lib/approvedApplicationSubmissions.ts) looks for --
 * status='submitted', submission_authorization.source='per_application_approval' -- standing in for
 * submissionRunner.ts's real write, which this suite's stubbed /applications/:id/submit-request does
 * not perform. This is the ONLY thing that closes TIER B2 now; the acknowledgement ledger this
 * suite's onboarding routes still write is exercised for its own sake, not because THE GATE reads it.
 */
async function markSubmitted(userId: string) {
  await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: {},
    resume_object_key: 'test-resume-key',
    spec: {
      _review: {
        status: 'submitted',
        submission_authorization: { source: 'per_application_approval', authorized_at: new Date().toISOString() },
      },
    },
  });
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

    await t.test('THE LEGITIMATE SEQUENCE: every route /start actually calls, in its own order, never 402s, and nothing has been submitted yet so TIER B2 stays fully open throughout', async () => {
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

      // 'review': ReviewStep.tsx sends the application. The real handler is stubbed, so this call
      // authorizes a browser run but writes no generated_resumes row -- exactly like production
      // before submissionRunner.ts's async pipeline finishes the send.
      assert.equal((await app.inject({ method: 'POST', url: '/applications/app-1/submit-request', headers: auth })).statusCode, 200);
      await ack('review');

      // 'trial': no API call of its own, only the acknowledgement.
      await ack('trial');

      // 'notifications': NotificationsStep.tsx reads and writes the two permissions. These are TIER
      // B1 now (FINDING #1's related question), not TIER B2, and reachable with or without an
      // acknowledgement -- unlike round 1, this step no longer has any bearing on THE GATE at all.
      assert.equal((await app.inject({ method: 'GET', url: '/notifications/preferences', headers: auth })).statusCode, 200);
      assert.equal((await app.inject({
        method: 'PUT',
        url: '/notifications/preferences',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: { strong_match: true },
      })).statusCode, 200);
      assert.equal((await app.inject({
        method: 'POST',
        url: '/notifications/push/subscribe',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: {},
      })).statusCode, 200, 'FINDING #2: push/subscribe used to be reachable from no tier at all');
      await ack('notifications');

      // Still nothing submitted (submit-request is stubbed): TIER B2 must still be fully open.
      assert.equal((await app.inject({ method: 'GET', url: '/jobs?limit=5', headers: auth })).statusCode, 200);
      assert.equal((await app.inject({ method: 'POST', url: '/applications/from-job', headers: auth })).statusCode, 200);

      // 'plan' itself is TIER A (billing) and is exercised by the existing requireAuth suite; this
      // account stops here, at the payment wall, exactly where a real locked account would.
    });

    await t.test("FINDING #1a proof: TIER B2 does not close on its own just because every application step got acknowledged, including 'notifications' -- only a real submission does", async () => {
      const response = await app.inject({ method: 'POST', url: '/applications/from-job', headers: auth });
      assert.equal(response.statusCode, 200, 'every step above has been acknowledged and nothing has been submitted, so the build routes must still be open');
    });

    await t.test('AFTER FINISHING THE ONE APPLICATION: TIER B2 build routes close the moment a real submission lands, even with no ledger acknowledgement change', async () => {
      await markSubmitted(user.id);

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
        assert.equal(response.statusCode, 402, `${method} ${url} should 402 once a real submission exists`);
      }
    });

    await t.test('the never-onboarding routes are STILL blocked, same as before the sequence ran', async () => {
      for (const { method, url } of NEVER_ONBOARDING_PATHS) {
        const response = await app.inject({ method, url, headers: auth });
        assert.equal(response.statusCode, 402, `${method} ${url} should still 402`);
      }
    });

    await t.test('TIER A and TIER B1 stay reachable throughout: the account can still pay, check state, fix its profile, or finish notifications/push setup, even after spending its one free build', async () => {
      assert.equal((await app.inject({ method: 'GET', url: '/onboarding/state', headers: auth })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/profile', headers: auth })).statusCode, 200);
      assert.equal((await app.inject({ method: 'GET', url: '/notifications/preferences', headers: auth })).statusCode, 200);
      assert.equal((await app.inject({
        method: 'PUT',
        url: '/notifications/preferences',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: { strong_match: false },
      })).statusCode, 200);
      assert.equal((await app.inject({
        method: 'POST',
        url: '/notifications/push/subscribe',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: {},
      })).statusCode, 200);
      assert.equal((await app.inject({
        method: 'POST',
        url: '/notifications/push/unsubscribe',
        headers: { ...auth, 'content-type': 'application/json' },
        payload: { endpoint: 'https://example.com/push/abc' },
      })).statusCode, 200);
    });
  } finally {
    await app.close();
  }
});

test('THE CARD GATE, a locked account that submits without ever acknowledging any onboarding flow step', async (t) => {
  // FINDING #1's own required proof: TIER B2 closes on a real submission "regardless of what
  // ledger acknowledgements exist or don't" (spec). This account never calls POST
  // /onboarding/flow/steps at all -- the old mechanism could never have closed TIER B2 for it.
  process.env.CARD_GATE_FROM = '2026-08-19T00:00:00.000Z';
  const app = await buildApp();
  const user = await lockedUser('cardgate-no-acknowledgements@example.com');
  const token = await signToken(user.id);
  const auth = { authorization: `Bearer ${token}` };

  try {
    assert.equal((await app.inject({ method: 'GET', url: '/jobs?limit=5', headers: auth })).statusCode, 200);

    await markSubmitted(user.id);

    const response = await app.inject({ method: 'POST', url: '/applications/from-job', headers: auth });
    assert.equal(response.statusCode, 402, 'a real submission closes TIER B2 with an entirely empty acknowledgement ledger');

    // TIER B1's account settings, including notifications/push, remain open regardless.
    assert.equal((await app.inject({ method: 'GET', url: '/notifications/preferences', headers: auth })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('THE CARD GATE, a locked account that acknowledges "notifications" as its very first call', async (t) => {
  // FINDING #1's other confirmed failure mode (round 1): a client sending step:'notifications' as
  // its literal first call used to slam TIER B2 shut on an account that had built and seen nothing.
  // It must not do that any more -- acknowledging a step has no bearing on TIER B2 at all now.
  process.env.CARD_GATE_FROM = '2026-08-19T00:00:00.000Z';
  const app = await buildApp();
  const user = await lockedUser('cardgate-early-ack@example.com');
  const token = await signToken(user.id);
  const auth = { authorization: `Bearer ${token}` };

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/flow/steps',
      headers: { ...auth, 'content-type': 'application/json' },
      payload: { flow_version: CURRENT_ONBOARDING_FLOW_VERSION, step: 'notifications', disposition: 'continued' },
    });
    assert.equal(response.statusCode, 200, response.body);

    // Nothing has been submitted, so TIER B2 must still be wide open -- the fresh account has built
    // and seen nothing, exactly the case round 1's bug closed prematurely.
    assert.equal((await app.inject({ method: 'GET', url: '/jobs?limit=5', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/resume/generate', headers: auth })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/applications/from-job', headers: auth })).statusCode, 200);
  } finally {
    await app.close();
  }
});
