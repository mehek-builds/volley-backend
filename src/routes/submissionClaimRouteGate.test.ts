/* THE CLAIM IS PART OF THE QUESTION, AND TWO ROUTES WERE NOT ASKING IT.
 *
 * submitRequestDisposition's second parameter, submissionWasClaimed, defaults to false. A
 * one-argument call therefore asks "is this status re-runnable when nothing has been claimed", which
 * is the wrong question to put to a row that is holding a claim. Two routes asked it that way:
 *
 *   POST /applications/:id/status  - writes 'failed' over a `...current` spread. Two requests: this
 *                                    one, then POST /submit-request, which starts 'failed'
 *                                    unconditionally.
 *   PUT  /applications/:id/review  - writes 'questions_ready' or 'ready_to_submit' over the same
 *                                    spread. ONE request, and a shorter door than the first.
 *
 * Either way a needs_attention packet holding a confirmed receipt, an unresolved unverified_submission
 * or a standing security_code became runnable again with every one of those fields still on the row.
 * That is a second application at an employer who caps them, and it cannot be withdrawn.
 *
 * WHY REAL ROUTES AND A REAL DATABASE. The hole was not in submitRequestDisposition, which answers
 * correctly for every input it is given; it was in what one call site passed it. A unit test of the
 * predicate passes either way, and a source grep for the fixed call shape would pass against a route
 * that made the call and then ignored it. What matters is the HTTP status the owner gets and the row
 * the database holds afterwards, and the only way to read those is to run them. Fixture is PGlite
 * over a unix socket with the production db module, the production routes and the production auth
 * middleware, and the DDL is generated from db/schema.ts at run time so it cannot drift.
 */

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import type { ApplicationReviewState } from '../lib/applicationReview';

const JWT_SIGNING_SECRET = 'submission-claim-route-gate-secret';
const ENCRYPTION_KEY = 'submission-claim-route-gate-key';

const previousEnv = {
  DATABASE_URL: process.env.DATABASE_URL,
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SIGNING_SECRET: process.env.JWT_SIGNING_SECRET,
};

let socketDir: string;
let pglite: PGlite;
let server: PGLiteSocketServer;
let pool: typeof import('../db/index')['pool'];
let app: FastifyInstance;
let schema: typeof import('../db/schema');
let db: typeof import('../db/index')['db'];
let userId = '';
let token = '';

const CLAIMED_AT = '2026-08-11T12:00:00.000Z';

/** A packet stopped at needs_attention still wearing the claim its send run took. */
function claimedNeedsAttention(extra: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: 'Backend engineer at kos',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: CLAIMED_AT,
    portal_url: 'https://jobs.ashbyhq.com/kos/f0f0f0f0-0000-4000-8000-000000000000/application',
    ats_name: 'ashby',
    submission_run_id: 'run-1',
    submission_claimed_at: CLAIMED_AT,
    submission_claim_id: 'claim-1',
    attention_reason: 'Litos could not confirm what came back.',
    ...extra,
  };
}

const CONFIRMED_RECEIPT = {
  confirmation_text: 'Thanks for applying',
  final_url: 'https://jobs.ashbyhq.com/kos/confirmation',
  captured_at: CLAIMED_AT,
  source: 'managed_browser' as const,
};

const UNRESOLVED_UNVERIFIED = {
  at: CLAIMED_AT,
  cause: 'no_confirmation_state' as const,
  portal_url: 'https://jobs.ashbyhq.com/kos/application',
};

const STANDING_SECURITY_CODE = {
  digits: 8,
  sent_to: 'packet@example.test',
  requested_at: CLAIMED_AT,
  submit_was_authorized: true,
};

async function applicationWith(review: ApplicationReviewState): Promise<string> {
  const [row] = await db.insert(schema.generated_resumes).values({
    user_id: userId,
    job_context: { company: 'kos', role: 'Backend engineer' },
    spec: { _review: review },
    resume_object_key: `users/${userId}/resumes/${crypto.randomUUID()}.pdf`,
  }).returning({ id: schema.generated_resumes.id });
  return row.id;
}

async function storedReview(applicationId: string): Promise<ApplicationReviewState> {
  const { eq } = await import('drizzle-orm');
  const [row] = await db.select({ spec: schema.generated_resumes.spec })
    .from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, applicationId))
    .limit(1);
  return (row?.spec as { _review: ApplicationReviewState })._review;
}

function postStatus(applicationId: string) {
  return app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/status`,
    headers: { authorization: `Bearer ${token}` },
    payload: { status: 'failed', error: 'The company turned this application down.' },
  });
}

function putReview(applicationId: string) {
  return app.inject({
    method: 'PUT',
    url: `/applications/${applicationId}/review`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      ats_name: 'ashby',
      portal_url: 'https://jobs.ashbyhq.com/kos/f0f0f0f0-0000-4000-8000-000000000000/application',
      questions: [],
      skipped_reasons: [],
    },
  });
}

function postSubmitRequest(applicationId: string) {
  return app.inject({
    method: 'POST',
    url: `/applications/${applicationId}/submit-request`,
    headers: { authorization: `Bearer ${token}` },
    payload: { questions: [] },
  });
}

before(async () => {
  process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
  process.env.JWT_SIGNING_SECRET = JWT_SIGNING_SECRET;

  socketDir = mkdtempSync(join(tmpdir(), 'litos-claim-gate-'));
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

  const [account] = await db.insert(schema.users).values({ email: 'claim-gate@example.test' }).returning();
  userId = account.id;

  token = await new SignJWT({
    userId,
    email: 'claim-gate@example.test',
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SIGNING_SECRET));

  const { applicationRoutes } = await import('./applications');
  app = Fastify({ logger: false });
  await app.register(applicationRoutes);
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

/* THE THREE THINGS THAT MEAN AN EMPLOYER MAY ALREADY HOLD THIS APPLICATION.
 *
 * Each asserts the status AND the stored row, because a route that refused with a 409 and wrote the
 * change anyway would pass on the status line alone. */

test('a claimed packet holding a confirmed receipt cannot be marked failed', async () => {
  const id = await applicationWith(claimedNeedsAttention({ receipt: CONFIRMED_RECEIPT }));
  const response = await postStatus(id);
  assert.equal(response.statusCode, 409, response.body);
  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'needs_attention', 'a refused update must not move the packet');
  assert.equal(persisted.submission_claimed_at, CLAIMED_AT, 'and must not drop the claim');
  assert.deepEqual(persisted.receipt, CONFIRMED_RECEIPT);
});

test('a claimed packet with an unresolved unverified submission cannot be marked failed', async () => {
  const id = await applicationWith(claimedNeedsAttention({ unverified_submission: UNRESOLVED_UNVERIFIED }));
  const response = await postStatus(id);
  assert.equal(response.statusCode, 409, response.body);
  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'needs_attention');
  assert.equal(persisted.submission_claimed_at, CLAIMED_AT);
  assert.equal(persisted.unverified_submission?.resolution, undefined,
    'the question she has not answered yet must still be open');
});

test('a claimed packet parked at a standing security code cannot be marked failed', async () => {
  const id = await applicationWith(claimedNeedsAttention({ security_code: STANDING_SECURITY_CODE }));
  const response = await postStatus(id);
  assert.equal(response.statusCode, 409, response.body);
  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'needs_attention');
  assert.deepEqual(persisted.security_code, STANDING_SECURITY_CODE);
});

/* AND THE LEGITIMATE PATH IS UNTOUCHED. Without this the fix could be "refuse everything", which
 * would break the delayed rejection update this route exists for. */
test('an unclaimed needs_attention packet can still be marked failed', async () => {
  const id = await applicationWith(claimedNeedsAttention({
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  }));
  const response = await postStatus(id);
  assert.equal(response.statusCode, 200, response.body);
  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'failed');
  assert.match(persisted.submission_error!, /turned this application down/);
});

/* THE SEQUENCE, END TO END. Not "the first request 409s" but "the packet is still not runnable
 * afterwards", which is the property that actually protects the applicant. */
test('the two-request unlock no longer reaches a runnable state', async () => {
  const id = await applicationWith(claimedNeedsAttention({ receipt: CONFIRMED_RECEIPT }));

  const laundered = await postStatus(id);
  assert.equal(laundered.statusCode, 409, 'step one: the status route must refuse');

  const rerun = await postSubmitRequest(id);
  assert.equal(rerun.statusCode, 409, `step two: the packet must still be unrunnable: ${rerun.body}`);
  assert.equal(rerun.json().code, 'SUBMISSION_RUN_NOT_RESTARTABLE');

  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'needs_attention',
    'the packet never reached submit_requested, so no browser was ever booked');
  assert.equal(persisted.submission_claimed_at, CLAIMED_AT);
  assert.equal(persisted.submission_run_id, 'run-1',
    'a fresh run id would mean freshSubmitRequestReview ran and the send was authorized');
});

/* THE SHORTER DOOR, found while auditing every call site of the same predicate. One request, and it
 * lands on a status submitRequestDisposition starts unconditionally. */
test('a claimed packet holding a receipt cannot be reset to ready_to_submit by a review edit', async () => {
  const id = await applicationWith(claimedNeedsAttention({ receipt: CONFIRMED_RECEIPT }));
  const response = await putReview(id);
  assert.equal(response.statusCode, 409, response.body);
  const persisted = await storedReview(id);
  assert.equal(persisted.status, 'needs_attention',
    'ready_to_submit here would be one request from a duplicate application');
  assert.equal(persisted.submission_claimed_at, CLAIMED_AT);
});

test('an unclaimed packet can still be edited from the review screen', async () => {
  const id = await applicationWith(claimedNeedsAttention({
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  }));
  const response = await putReview(id);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await storedReview(id)).status, 'ready_to_submit');
});
