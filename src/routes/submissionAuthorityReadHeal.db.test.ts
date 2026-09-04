/* A READ CAN SEE THE SAME PROOF A SEND ALREADY DOES.
 *
 * MEASURED 2026-09-05, production. Pony.ai (Workable) packet fdcf4ccb-eca9-44dc-b0cb-d400805ebdeb:
 * `status: failed` from a run on 2026-08-14, no claim, no receipt, no unverified_submission, exact
 * packet audit passed. GET /applications/:id/submission carried NO `submission_authority` key at
 * all, and the dashboard's send gate fell back to the packet's stored null and refused: "Litos
 * cannot start another employer attempt until the exact prior submission evidence is verified" -
 * on a packet the ledger already proves never reached an employer.
 *
 * THE GAP, per PR #941's own body: refuseDuplicateApplication heals exactly this shape, but only on
 * the three send-path POSTs. GET /applications/board, GET /resume/history and
 * GET /applications/:id/submission each fold the same phantom attempt as a block and never call a
 * POST that would heal it. This file pins the fix at the three routes the dashboard actually reads:
 * seed a packet shaped like the measured one, hit the real route handlers with fastify.inject, and
 * check the ledger directly for what a heal is and is not allowed to write.
 *
 * See lib/abandonedAttemptClosure.ts (healAbandonedPreBoundaryAttemptsForRead,
 * retrySafetyLooksLikeClosableCandidate, retrySafetyDiagnosticForAbsentEnvelope) for the mechanism
 * and its pure-function tests.
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { ApplicationReviewState } from '../lib/applicationReview';
import { STALLED_FILL_RUN_RELEASE_MS } from '../lib/stalledFillRunRelease';

const JWT_SECRET = 'submission-authority-read-heal-test-secret-32';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-read-heal-'));
const savedEnv = { ...process.env };
const USER_ID = randomUUID();

let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendDb: any;
let backendPool: { end(): Promise<void> };
let ledger: typeof import('../lib/submissionAttemptLedger');

async function token(userId: string = USER_ID) {
  return new SignJWT({ userId, isGuest: false, sessionVersion: 0, authMethod: 'password' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET));
}

before(async () => {
  database = await PGlite.create();
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
  process.env.ENCRYPTION_KEY = 'submission-authority-read-heal-test-key-32';

  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ledger = await import('../lib/submissionAttemptLedger');
  const { applicationRoutes } = await import('./applications');
  const { resumeRoutes } = await import('./resume');
  const { jdMatchRoutes } = await import('./jdMatch');
  app = Fastify({ logger: false });
  await app.register(applicationRoutes);
  await app.register(resumeRoutes);
  await app.register(jdMatchRoutes);
  await app.ready();

  await backendDb.insert(schema.users).values({
    id: USER_ID,
    email: `read-heal-${USER_ID}@example.com`,
    password_hash: 'x',
  });
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

function freeze() {
  return ledger.freezePostingIdentity({ company: 'Pony.ai', role: 'Software Engineer' }, null);
}

/** A packet shaped like the measured Pony.ai one: a real ApplicationReviewState the routes' own
 * machinery (question resolution, sensitive-question labels, resume-contact staleness) can read
 * without crashing, `status: 'failed'` by default, and no claim, receipt or unverified_submission -
 * exactly the emptiness abandonedPreBoundaryAttemptIsClosable's second proof needs. */
async function seedPacket(review: Partial<ApplicationReviewState> = {}): Promise<string> {
  const packetId = randomUUID();
  const fullReview: ApplicationReviewState = {
    jd_text: 'Build autonomy software at Pony.ai.',
    role: 'Software Engineer',
    portal_url: 'https://apply.workable.com/ponyai/j/ABCDEF1234567890/',
    ats_name: 'workable',
    portal_supported: true,
    status: 'failed',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
    ...review,
  };
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: USER_ID,
    job_context: { company: 'Pony.ai', role: 'Software Engineer' },
    spec: {
      _contact: { full_name: 'Test Applicant', email: 'applicant@example.com' },
      _review: fullReview,
    },
    resume_object_key: `resumes/${packetId}.pdf`,
  });
  return packetId;
}

/** Opens an attempt through the real ledger API - never a raw insert - so its binding, evidence
 * code and event id are exactly what production writes. `createdAt` is the one thing every test
 * below varies: it is what abandonedPreBoundaryAttemptIsClosable's time margin reads. */
async function openAttempt(packetId: string, createdAt: Date): Promise<string> {
  const attemptId = randomUUID();
  await ledger.appendSubmissionAttemptEvent({
    attemptId,
    userId: USER_ID,
    packetId,
    source: 'legacy_backfill',
    operation: 'initial_submission',
    postingIdentity: freeze(),
    eventId: ledger.submissionAttemptEventId(attemptId, 'attempt_opened', 'reservation'),
    eventKind: 'attempt_opened',
    evidenceCode: 'atomic_claim_reserved',
    createdAt,
    observedAt: createdAt,
  });
  return attemptId;
}

async function notSentProvenCount(attemptId: string): Promise<number> {
  const rows = await backendDb.select().from(schema.application_submission_attempt_events).where(and(
    eq(schema.application_submission_attempt_events.attempt_id, attemptId),
    eq(schema.application_submission_attempt_events.event_kind, 'not_sent_proven'),
  ));
  return rows.length;
}

// Comfortably on either side of the 3-hour margin, relative to the real clock - the same pattern
// abandonedAttemptClosure.db.test.ts uses for its own `OLD` fixture.
const OLD = new Date(Date.now() - STALLED_FILL_RUN_RELEASE_MS - 60 * 60_000);
const RECENT = new Date(Date.now() - 60_000);

test('a stale abandoned attempt heals on GET /applications/:id/submission, and a second read never appends twice', async () => {
  const packetId = await seedPacket();
  const attemptId = await openAttempt(packetId, OLD);

  const first = await app.inject({
    method: 'GET',
    url: `/applications/${packetId}/submission`,
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = first.json();
  assert.ok(firstBody.submission_authority, 'the read healed the phantom attempt and published an envelope');
  assert.equal(firstBody.submission_authority.state, 'none');
  assert.equal(firstBody.submission_authority.retry_safety.kind, 'safe_not_sent');
  assert.equal(firstBody.submission_authority.retry_safety.attemptId, attemptId);
  assert.equal(firstBody.submission_authority.retry_safety.proofKind, 'typed_pre_click_stop');
  assert.equal(firstBody.retry_safety_diagnostic, undefined, 'no diagnostic once the envelope publishes');
  assert.equal(await notSentProvenCount(attemptId), 1);

  const second = await app.inject({
    method: 'GET',
    url: `/applications/${packetId}/submission`,
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().submission_authority.retry_safety.kind, 'safe_not_sent');
  assert.equal(await notSentProvenCount(attemptId), 1, 'the second read is idempotent, not a second fact');
});

test('the same heal reaches GET /resume/history and GET /applications/board', async () => {
  const packetId = await seedPacket();
  const attemptId = await openAttempt(packetId, OLD);

  const history = await app.inject({
    method: 'GET',
    url: '/resume/history',
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(history.statusCode, 200, history.body);
  const row = history.json().resumes.find((resume: { id: string }) => resume.id === packetId);
  assert.ok(row, 'the seeded packet is on the page');
  assert.ok(row.submission_authority, 'GET /resume/history healed it too');
  assert.equal(row.submission_authority.state, 'none');
  assert.equal(row.submission_authority.retry_safety.kind, 'safe_not_sent');

  const board = await app.inject({
    method: 'GET',
    url: '/applications/board',
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(board.statusCode, 200, board.body);
  const card = board.json().cards.find((candidate: { id: string }) => candidate.id === packetId);
  assert.ok(card, 'the seeded packet is on the board');
  assert.ok(card.submission_authority, 'the board no longer reports it unverifiable');
  assert.equal(card.submission_authority.state, 'none');
  assert.equal(card.submission_authority.retry_safety.kind, 'safe_not_sent');
  assert.equal(card.submission_authority_unavailable, undefined);

  assert.equal(await notSentProvenCount(attemptId), 1, 'two different GET routes healed the same attempt only once');
});

test('a recent attempt is not yet closable: the gate stays refused and names why on the submission GET', async () => {
  const packetId = await seedPacket();
  const attemptId = await openAttempt(packetId, RECENT);

  const res = await app.inject({
    method: 'GET',
    url: `/applications/${packetId}/submission`,
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.submission_authority, undefined, 'too recent to be sure the run has actually exited');
  assert.equal(body.retry_safety_diagnostic, 'unclosable_attempt');
  assert.equal(await notSentProvenCount(attemptId), 0, 'nothing is written for an attempt that is not provably dead yet');
});

test('a packet whose review says an employer may already hold something is not healed either', async () => {
  // SUBMISSION_BOUNDARY_STATUSES (submitting, submission_claimed, submitted,
  // awaiting_security_code) can never appear here: they are disjoint from
  // FIRST_SEND_REVIEW_STATUSES, so a packet in one of them never reaches this route's envelope
  // logic at all. `submission_attempted_at` is packetReviewProvesNoEmployerContact's OTHER refusal
  // - a standing fact that a click may have landed - and it fires beside a first-send-eligible
  // status exactly like the Databricks security-code case this predicate was written to keep
  // refusing (see abandonedAttemptClosure.test.ts).
  const packetId = await seedPacket({
    status: 'needs_attention',
    submission_attempted_at: new Date().toISOString(),
  });
  const attemptId = await openAttempt(packetId, OLD);

  const res = await app.inject({
    method: 'GET',
    url: `/applications/${packetId}/submission`,
    headers: { authorization: `Bearer ${await token()}` },
  });
  assert.equal(res.statusCode, 200, res.body);
  const body = res.json();
  assert.equal(body.submission_authority, undefined);
  assert.equal(body.retry_safety_diagnostic, 'unclosable_attempt');
  assert.equal(await notSentProvenCount(attemptId), 0);
});
