import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import * as schema from '../db/schema';
import type { ApplicationReviewState } from '../lib/applicationReview';
import type { SubmissionAttemptBinding } from '../lib/submissionAttemptLedger';
import { NoSubmitControlError } from '../lib/portalSubmission';

const JWT_SECRET = 'runtime-interleaving-test-secret-32-chars';
const PORTAL_URL = 'https://apply.workable.com/max-borges-agency/j/ABC123/';
const CONSENTED_AT = '2026-08-24T08:00:00.000Z';
const CONSENT_VERSION = 'automatic-submission-v1';
const RESERVED_AT = '2026-08-24T08:05:00.000Z';
const PACKET_VERSION = 'packet-v1';
const JOB_CONTEXT = {
  job_id: 'aa283015-a491-4c0f-b41b-0964bb850dc0',
  company: 'Max Borges Agency',
  role: 'Account Manager',
};

const savedEnv = { ...process.env };
const socketDir = mkdtempSync(join(tmpdir(), 'litos-runtime-interleaving-'));
let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: any;
let backendPool: { end(): Promise<void> };
let app: FastifyInstance;
let appendSubmissionAttemptEvent: typeof import('../lib/submissionAttemptLedger').appendSubmissionAttemptEvent;
let authorizeFinalSubmissionBoundary: typeof import('../lib/submissionAttemptLedger').authorizeFinalSubmissionBoundary;
let freezePostingIdentity: typeof import('../lib/submissionAttemptLedger').freezePostingIdentity;
let lockSubmissionAttemptUser: typeof import('../lib/submissionAttemptLedger').lockSubmissionAttemptUser;
let submissionBoundaryAuthorization: typeof import('../lib/submissionAttemptLedger').submissionBoundaryAuthorization;
let submissionAttemptEventId: typeof import('../lib/submissionAttemptLedger').submissionAttemptEventId;
let submissionAttemptEventsForPacket: typeof import('../lib/submissionAttemptLedger').submissionAttemptEventsForPacket;
let submissionAttemptRetrySafetyForPacket: typeof import('../lib/submissionAttemptLedger').submissionAttemptRetrySafetyForPacket;
let assertFinalRunnerBoundaryClear: typeof import('./submissionRunner').assertFinalRunnerBoundaryClear;
let executeAfterFinalSubmissionBoundary: typeof import('./submissionRunner').executeAfterFinalSubmissionBoundary;
let recordSubmissionRunnerFailure: typeof import('./submissionRunner').recordSubmissionRunnerFailure;
let commitExtensionSubmissionOutcome: typeof import('./applications').commitExtensionSubmissionOutcome;
let commitUnverifiedSubmissionResolution: typeof import('./applications').commitUnverifiedSubmissionResolution;
let repairExpiredAttendedHandoffClaim: typeof import('./applications').repairExpiredAttendedHandoffClaim;
let reserveAttendedManualAttempt: typeof import('./applications').reserveAttendedManualAttempt;

function reviewForAttempt(
  claimId: string | undefined,
  overrides: Partial<ApplicationReviewState> = {},
): ApplicationReviewState {
  return {
    jd_text: 'Own client relationships and coordinate integrated communications programs.',
    role: 'Account Manager',
    portal_url: PORTAL_URL,
    portal_supported: true,
    ats_name: 'workable',
    status: claimId ? 'submitting' : 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: RESERVED_AT,
    submission_run_id: randomUUID(),
    ...(claimId ? {
      submission_claimed_at: RESERVED_AT,
      submission_claim_id: claimId,
      submission_packet_version: PACKET_VERSION,
      submission_authorization: {
        source: 'standing_consent' as const,
        authorized_at: RESERVED_AT,
        consented_at: CONSENTED_AT,
        consent_version: CONSENT_VERSION,
      },
    } : {}),
    ...overrides,
  };
}

async function createUser(input: {
  automaticSubmissionEnabled?: boolean;
  emailPrefix: string;
}): Promise<string> {
  const userId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `${input.emailPrefix}-${userId}@example.test`,
    plan: 'plus',
    manual_access_override: 'plus_paid',
    automatic_submission_enabled: input.automaticSubmissionEnabled ?? true,
    automatic_submission_consented_at: new Date(CONSENTED_AT),
    automatic_submission_consent_version: CONSENT_VERSION,
  });
  return userId;
}

async function createPacket(
  userId: string,
  review: ApplicationReviewState,
): Promise<typeof schema.generated_resumes.$inferSelect> {
  const [row] = await backendDb.insert(schema.generated_resumes).values({
    id: randomUUID(),
    user_id: userId,
    job_context: JOB_CONTEXT,
    spec: { summary: 'Exact runtime packet', _review: review },
    resume_object_key: `users/${userId}/resumes/${randomUUID()}.pdf`,
  }).returning();
  return row;
}

function attemptBinding(
  row: typeof schema.generated_resumes.$inferSelect,
  review: ApplicationReviewState,
  attemptId: string,
  source: SubmissionAttemptBinding['source'] = 'direct_browser',
  operation: SubmissionAttemptBinding['operation'] = 'initial_submission',
): SubmissionAttemptBinding {
  return {
    attemptId,
    userId: row.user_id,
    packetId: row.id,
    source,
    operation,
    postingIdentity: freezePostingIdentity(row.job_context, review.portal_url),
    submissionRunId: review.submission_run_id ?? null,
    submissionClaimId: attemptId,
    packetVersion: review.packet_audit?.packet_version
      ?? review.submission_packet_version
      ?? null,
  };
}

async function appendFact(
  binding: SubmissionAttemptBinding,
  eventKind: 'attempt_opened' | 'press_observed' | 'submission_confirmed',
  factKey: string,
  executor?: any,
) {
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(binding.attemptId, eventKind, factKey),
    eventKind,
    evidenceCode: factKey,
  }, { executor });
}

async function authToken(userId: string): Promise<string> {
  return new SignJWT({
    userId,
    email: `runtime-${userId}@example.test`,
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

before(async () => {
  database = await PGlite.create();
  const statements = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of statements) await database.exec(statement);
  server = new PGLiteSocketServer({
    db: database,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 20,
  });
  await server.start();
  process.env.VERCEL = '1';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  process.env.ENCRYPTION_KEY = 'runtime-interleaving-encryption-key';

  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({
    appendSubmissionAttemptEvent,
    authorizeFinalSubmissionBoundary,
    freezePostingIdentity,
    lockSubmissionAttemptUser,
    submissionBoundaryAuthorization,
    submissionAttemptEventId,
    submissionAttemptEventsForPacket,
    submissionAttemptRetrySafetyForPacket,
  } = await import('../lib/submissionAttemptLedger'));
  ({
    assertFinalRunnerBoundaryClear,
    executeAfterFinalSubmissionBoundary,
    recordSubmissionRunnerFailure,
  } = await import('./submissionRunner'));
  const applications = await import('./applications');
  commitExtensionSubmissionOutcome = applications.commitExtensionSubmissionOutcome;
  commitUnverifiedSubmissionResolution = applications.commitUnverifiedSubmissionResolution;
  repairExpiredAttendedHandoffClaim = applications.repairExpiredAttendedHandoffClaim;
  reserveAttendedManualAttempt = applications.reserveAttendedManualAttempt;
  app = Fastify({ logger: false });
  await app.register(applications.applicationRoutes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await backendPool?.end();
  await server?.stop();
  await database?.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('a delayed prior confirmation after reservation blocks the runner before the external call', async () => {
  const userId = await createUser({ emailPrefix: 'delayed-confirmation' });
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId);
  const row = await createPacket(userId, review);
  const reserved = attemptBinding(row, review, attemptId);
  await appendFact(reserved, 'attempt_opened', 'reserved-runner-attempt');

  const priorAttemptId = randomUUID();
  const prior = {
    ...attemptBinding(row, review, priorAttemptId),
    packetId: randomUUID(),
    submissionClaimId: priorAttemptId,
  };
  await appendFact(prior, 'attempt_opened', 'prior-attempt');
  await appendFact(prior, 'submission_confirmed', 'delayed-prior-receipt');

  let externalCalls = 0;
  await assert.rejects(
    executeAfterFinalSubmissionBoundary(
      () => assertFinalRunnerBoundaryClear(row, review, reserved),
      async () => { externalCalls += 1; },
    ),
    (error: unknown) => error instanceof Error && error.name === 'FinalSubmissionBoundaryBlockedError',
  );
  assert.equal(externalCalls, 0, 'the employer boundary must not run after delayed duplicate evidence arrives');
});

test('a replaced claim blocks the old runner before the external call', async () => {
  const userId = await createUser({ emailPrefix: 'claim-replacement' });
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId);
  const row = await createPacket(userId, review);
  const reserved = attemptBinding(row, review, attemptId);
  await appendFact(reserved, 'attempt_opened', 'old-runner-attempt');

  const replacement = reviewForAttempt(randomUUID());
  await backendDb.update(schema.generated_resumes)
    .set({ spec: { summary: 'Exact runtime packet', _review: replacement } })
    .where(eq(schema.generated_resumes.id, row.id));

  let externalCalls = 0;
  await assert.rejects(
    executeAfterFinalSubmissionBoundary(
      () => assertFinalRunnerBoundaryClear(row, review, reserved),
      async () => { externalCalls += 1; },
    ),
    (error: unknown) => error instanceof Error && error.name === 'FinalSubmissionBoundaryChangedError',
  );
  assert.equal(externalCalls, 0, 'run A must not spend the employer capability reserved by run B');
});

test('standing consent revoked after reservation blocks the runner before the external call', async () => {
  const userId = await createUser({ emailPrefix: 'consent-revocation' });
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId);
  const row = await createPacket(userId, review);
  const reserved = attemptBinding(row, review, attemptId);
  await appendFact(reserved, 'attempt_opened', 'consented-runner-attempt');
  await backendDb.update(schema.users)
    .set({ automatic_submission_enabled: false })
    .where(eq(schema.users.id, userId));

  let externalCalls = 0;
  await assert.rejects(
    executeAfterFinalSubmissionBoundary(
      () => assertFinalRunnerBoundaryClear(row, review, reserved),
      async () => { externalCalls += 1; },
    ),
    (error: unknown) => error instanceof Error && error.name === 'FinalSubmissionAuthorizationChangedError',
  );
  assert.equal(externalCalls, 0, 'revoked consent must not reach the employer boundary');
});

test('a stale outer failure observes authorization and preserves the winning continuation evidence', async () => {
  const userId = await createUser({ emailPrefix: 'stale-authorized-failure' });
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, {
    security_code: {
      digits: 6,
      sent_to: 'applicant@example.test',
      requested_at: RESERVED_AT,
      submit_was_authorized: true,
      attempts: [{ at: RESERVED_AT, fingerprint: 'older-code', outcome: 'superseded' }],
    },
    verification: {
      status: 'searching',
      requested_at: RESERVED_AT,
      runner: 'stratus-managed',
      continuation_fingerprint: 'continuation-fingerprint',
      continuation_execution_fingerprint: 'execution-fingerprint',
      continuation_resumed: false,
    },
  });
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'managed_browser');
  await appendFact(binding, 'attempt_opened', 'stale-failure-opening');

  let failurePromise: ReturnType<typeof recordSubmissionRunnerFailure> | undefined;
  const winningDeadline = new Date(Date.now() + 2 * 60 * 1000).toISOString();
  await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    failurePromise = recordSubmissionRunnerFailure(
      row,
      new NoSubmitControlError('stale pre-click classification'),
      'failure-code',
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const authorization = await authorizeFinalSubmissionBoundary(binding, {
      executor: tx,
      factKey: 'stale-failure-boundary',
    });
    assert.equal(authorization.kind, 'fresh');
    const winner: ApplicationReviewState = {
      ...review,
      security_code: {
        ...review.security_code!,
        attempts: [
          ...(review.security_code?.attempts ?? []),
          { at: RESERVED_AT, fingerprint: 'winning-spent-code', outcome: 'error' },
        ],
      },
      verification: {
        ...review.verification!,
        status: 'verification_pending',
        continuation_resumed: true,
        continuation_call_started_at: new Date().toISOString(),
        continuation_call_deadline_at: winningDeadline,
      },
    };
    await tx.update(schema.generated_resumes)
      .set({ spec: { summary: 'Exact runtime packet', _review: winner } })
      .where(eq(schema.generated_resumes.id, row.id));
  });

  assert.ok(failurePromise, 'the stale failure must wait behind the winning authorization lock');
  assert.equal(await failurePromise, true);
  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, row.id)).limit(1);
  const current = (stored.spec as { _review: ApplicationReviewState })._review;
  assert.equal(current.submission_claim_id, attemptId, 'post-authorization failure keeps the parent claim');
  assert.equal(current.unverified_submission?.resolution, undefined);
  assert.equal(current.verification?.continuation_resumed, true);
  assert.equal(current.verification?.continuation_call_deadline_at, winningDeadline);
  assert.deepEqual(
    current.security_code?.attempts?.map((attempt) => attempt.fingerprint),
    ['older-code', 'winning-spent-code', 'failure-code'],
    'the stale failure appends its own evidence without erasing the winning spent-code state',
  );
  const facts = await submissionAttemptEventsForPacket(userId, row.id);
  assert.equal(facts.some((fact) => fact.event_kind === 'boundary_authorized'), true);
  assert.equal(facts.some((fact) => fact.event_kind === 'not_sent_proven'), false,
    'authorization, ledger decision, and row projection must linearize without a machine not-sent fact');
});

test('a wrong-source generated extension outcome returns 409 and appends no fact', async () => {
  const userId = await createUser({ emailPrefix: 'wrong-source-extension' });
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, {
    submission_authorization: {
      source: 'user_initiated_extension',
      authorized_at: RESERVED_AT,
    },
  });
  const row = await createPacket(userId, review);
  const managedAttempt = attemptBinding(row, review, attemptId, 'managed_browser');
  await appendFact(managedAttempt, 'attempt_opened', 'managed-opening');
  const beforeFacts = await submissionAttemptEventsForPacket(userId, row.id);

  const response = await app.inject({
    method: 'POST',
    url: `/applications/${row.id}/submission/extension-outcome`,
    headers: { authorization: `Bearer ${await authToken(userId)}` },
    payload: {
      claim_id: attemptId,
      outcome: 'unknown',
      final_url: PORTAL_URL,
    },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'EXTENSION_ATTEMPT_BINDING_MISMATCH');
  const afterFacts = await submissionAttemptEventsForPacket(userId, row.id);
  assert.deepEqual(afterFacts, beforeFacts, 'binding refusal must happen before press or receipt evidence is appended');
});

test('extension confirmation linearizes before a queued negative resolution and heals the locked projection', async () => {
  const userId = await createUser({ emailPrefix: 'extension-confirmation-race' });
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, {
    submission_authorization: {
      source: 'user_initiated_extension',
      authorized_at: RESERVED_AT,
    },
  });
  const row = await createPacket(userId, review);
  const extensionAttempt = attemptBinding(row, review, attemptId, 'chrome_extension');
  await appendFact(extensionAttempt, 'attempt_opened', 'extension-opening');

  let confirmationPromise: ReturnType<typeof commitExtensionSubmissionOutcome> | undefined;
  let negativePromise: ReturnType<typeof commitUnverifiedSubmissionResolution> | undefined;
  await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    confirmationPromise = commitExtensionSubmissionOutcome({
      packetId: row.id,
      userId,
      claimId: attemptId,
      reportedOutcome: 'confirmed',
      confirmationText: 'Thank you for your application.',
      finalUrl: PORTAL_URL,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Simulate an unknown projection landing after the route's ownership read but before its user
    // lock. The exact claim and immutable opening remain the authorities for the late receipt.
    const projectedAt = '2026-08-24T08:06:00.000Z';
    const unverified: ApplicationReviewState = {
      ...review,
      status: 'needs_attention',
      submission_attempted_at: projectedAt,
      unverified_submission: {
        at: projectedAt,
        cause: 'no_confirmation_state',
        portal_url: PORTAL_URL,
        submission_run_id: review.submission_run_id,
      },
      attention_reason: 'Check the employer portal before trying again.',
      attention_categories: ['unverified_submission'],
      updated_at: projectedAt,
    };
    const [projectedRow] = await tx.update(schema.generated_resumes)
      .set({ spec: { summary: 'Exact runtime packet', _review: unverified } })
      .where(eq(schema.generated_resumes.id, row.id))
      .returning();
    const negativeAt = '2026-08-24T08:07:00.000Z';
    const negative: ApplicationReviewState = {
      ...unverified,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
      unverified_submission: {
        ...unverified.unverified_submission!,
        resolution: 'not_sent',
        resolved_at: negativeAt,
      },
      attention_reason: 'You checked and the employer does not have this one.',
      attention_categories: ['unverified_submission'],
      updated_at: negativeAt,
    };
    negativePromise = commitUnverifiedSubmissionResolution({
      row: projectedRow,
      userId,
      attemptId,
      found: false,
      current: unverified,
      pending: unverified.unverified_submission!,
      next: negative,
      now: negativeAt,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  assert.ok(confirmationPromise, 'the confirmation must have queued behind the held user lock');
  assert.ok(negativePromise, 'the negative resolver must have started while that lock was held');
  const confirmation = await confirmationPromise;
  const negative = await negativePromise;
  assert.equal(confirmation.kind, 'recorded');
  if (confirmation.kind !== 'recorded') throw new Error('Expected the extension receipt to persist');
  assert.equal(confirmation.review.status, 'submitted');
  assert.equal(negative.length, 0, 'the negative resolver loses its exact row precondition after confirmation');

  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, row.id)).limit(1);
  const storedReview = (stored.spec as { _review: ApplicationReviewState })._review;
  assert.equal(storedReview.status, 'submitted', 'the exact late receipt heals the locked unknown projection');
  assert.equal(storedReview.submission_claim_id, attemptId, 'the losing negative resolver cannot clear the claim');
  assert.equal(storedReview.unverified_submission?.resolution, 'sent');
  assert.equal(stored.pipeline_stage, 'applied');

  const facts = await submissionAttemptEventsForPacket(userId, row.id);
  const exactFacts = facts.filter((fact) => fact.attempt_id === attemptId);
  assert.equal(exactFacts.filter((fact) => fact.event_kind === 'press_observed').length, 1);
  assert.equal(exactFacts.filter((fact) => fact.event_kind === 'submission_confirmed').length, 1);
  assert.equal(exactFacts.some((fact) => fact.event_kind === 'not_sent_proven'), false,
    'no retry-authorizing negative fact may land after the press and receipt facts');
  const safety = await submissionAttemptRetrySafetyForPacket(userId, row.id);
  assert.equal(safety.kind, 'blocked_confirmed');
});

test('an exact extension receipt heals a negative resolution that linearized first', async () => {
  const userId = await createUser({ emailPrefix: 'extension-negative-first' });
  const attemptId = randomUUID();
  const unverifiedAt = '2026-08-24T08:06:00.000Z';
  const review = reviewForAttempt(attemptId, {
    status: 'needs_attention',
    submission_authorization: {
      source: 'user_initiated_extension',
      authorized_at: RESERVED_AT,
    },
    submission_attempted_at: unverifiedAt,
    unverified_submission: {
      at: unverifiedAt,
      cause: 'no_confirmation_state',
      portal_url: PORTAL_URL,
    },
    attention_reason: 'Check the employer portal before trying again.',
    attention_categories: ['unverified_submission'],
  });
  review.unverified_submission!.submission_run_id = review.submission_run_id;
  const row = await createPacket(userId, review);
  const extensionAttempt = attemptBinding(row, review, attemptId, 'chrome_extension');
  await appendFact(extensionAttempt, 'attempt_opened', 'extension-negative-first-opening');

  const negativeAt = '2026-08-24T08:07:00.000Z';
  const negativeProjection: ApplicationReviewState = {
    ...review,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    unverified_submission: {
      ...review.unverified_submission!,
      resolution: 'not_sent',
      resolved_at: negativeAt,
    },
    attention_reason: 'You checked and the employer does not have this one.',
    attention_categories: ['unverified_submission'],
    updated_at: negativeAt,
  };
  let negativePromise: ReturnType<typeof commitUnverifiedSubmissionResolution> | undefined;
  let confirmationPromise: ReturnType<typeof commitExtensionSubmissionOutcome> | undefined;
  let packetAuditChecks = 0;
  await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    negativePromise = commitUnverifiedSubmissionResolution({
      row,
      userId,
      attemptId,
      found: false,
      current: review,
      pending: review.unverified_submission!,
      next: negativeProjection,
      now: negativeAt,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    confirmationPromise = commitExtensionSubmissionOutcome({
      packetId: row.id,
      userId,
      claimId: attemptId,
      reportedOutcome: 'confirmed',
      confirmationText: 'Thank you for your application.',
      finalUrl: PORTAL_URL,
    }, {
      verifyPacket: async () => {
        packetAuditChecks += 1;
        return {
          valid: false,
          response: { error: 'Stale audit after the employer receipt', code: 'PACKET_AUDIT_STALE' },
        };
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  });

  assert.ok(negativePromise);
  assert.ok(confirmationPromise);
  const negative = await negativePromise;
  const confirmation = await confirmationPromise;
  assert.equal(negative.length, 1);
  const negativeReview = (negative[0]!.spec as { _review: ApplicationReviewState })._review;
  assert.equal(negativeReview.unverified_submission?.resolution, 'not_sent');
  assert.equal(confirmation.kind, 'recorded');
  if (confirmation.kind !== 'recorded') throw new Error('Expected the exact late receipt to heal the row');
  assert.equal(confirmation.review.status, 'submitted');
  assert.equal(packetAuditChecks, 0,
    'a sufficient exact employer receipt must heal without a post-press packet audit veto');

  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, row.id)).limit(1);
  const storedReview = (stored.spec as { _review: ApplicationReviewState })._review;
  assert.equal(storedReview.status, 'submitted');
  assert.equal(storedReview.submission_claim_id, undefined,
    'the receipt does not recreate a mutable claim after immutable binding recovery');
  assert.equal(storedReview.unverified_submission?.resolution, 'sent',
    'the positive receipt replaces the stale negative packet projection');
  assert.equal(storedReview.receipt?.source, 'chrome_extension');
  assert.equal(stored.pipeline_stage, 'applied');

  const exactFacts = (await submissionAttemptEventsForPacket(userId, row.id))
    .filter((fact) => fact.attempt_id === attemptId);
  assert.equal(exactFacts.filter((fact) => fact.event_kind === 'not_sent_proven').length, 1);
  assert.equal(exactFacts.filter((fact) => fact.event_kind === 'press_observed').length, 1);
  assert.equal(exactFacts.filter((fact) => fact.event_kind === 'submission_confirmed').length, 1);
  const safety = await submissionAttemptRetrySafetyForPacket(userId, row.id);
  assert.equal(safety.kind, 'blocked_confirmed', 'the positive immutable fact closes retry after the healed receipt');
});

test('an expired extension boundary cannot be cleared or replaced by retry B', async () => {
  const userId = await createUser({ emailPrefix: 'expired-extension-boundary' });
  const attemptId = randomUUID();
  const unverifiedAt = '2026-08-24T08:06:00.000Z';
  const review = reviewForAttempt(attemptId, {
    status: 'needs_attention',
    submission_authorization: {
      source: 'user_initiated_extension',
      authorized_at: RESERVED_AT,
    },
    submission_attempted_at: unverifiedAt,
    unverified_submission: {
      at: unverifiedAt,
      cause: 'no_confirmation_state',
      portal_url: PORTAL_URL,
    },
    attention_reason: 'Check the employer portal before trying again.',
    attention_categories: ['unverified_submission'],
  });
  review.unverified_submission!.submission_run_id = review.submission_run_id;
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'chrome_extension');
  await appendFact(binding, 'attempt_opened', 'expired-extension-opening');
  await backendDb.transaction(async (tx: any) => {
    const authorization = await authorizeFinalSubmissionBoundary(binding, {
      executor: tx,
      factKey: 'expired-extension-boundary',
      ttlMs: 1,
    });
    assert.equal(authorization.kind, 'fresh');
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal((await submissionBoundaryAuthorization(userId, attemptId))?.active, false);

  const negativeAt = '2026-08-24T08:08:00.000Z';
  const negativeProjection: ApplicationReviewState = {
    ...review,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    unverified_submission: {
      ...review.unverified_submission!,
      resolution: 'not_sent',
      resolved_at: negativeAt,
    },
    attention_reason: 'You checked and the employer does not have this one.',
    attention_categories: ['unverified_submission'],
    updated_at: negativeAt,
  };
  const negative = await commitUnverifiedSubmissionResolution({
    row,
    userId,
    attemptId,
    found: false,
    current: review,
    pending: review.unverified_submission!,
    next: negativeProjection,
    now: negativeAt,
  });
  assert.equal(negative.length, 0);

  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, row.id)).limit(1);
  const storedReview = (stored.spec as { _review: ApplicationReviewState })._review;
  assert.equal(storedReview.submission_claim_id, attemptId);
  assert.equal(storedReview.unverified_submission?.resolution, undefined);
  const exactFacts = (await submissionAttemptEventsForPacket(userId, row.id))
    .filter((fact) => fact.attempt_id === attemptId);
  assert.equal(exactFacts.some((fact) => fact.event_kind === 'boundary_authorized'), true);
  assert.equal(exactFacts.some((fact) => fact.event_kind === 'not_sent_proven'), false);
  const retryB = await reserveAttendedManualAttempt(stored, storedReview);
  assert.equal(retryB.kind, 'blocked', 'the retained extension claim cannot be replaced by a retry reservation');
  const safety = await submissionAttemptRetrySafetyForPacket(userId, row.id);
  assert.equal(safety.kind, 'blocked_unverified');
});

test('an expired managed callback with a press fact cannot be resolved as not sent', async () => {
  const userId = await createUser({ emailPrefix: 'expired-callback-press' });
  const attemptId = randomUUID();
  const unverifiedAt = '2026-08-24T08:06:00.000Z';
  const review = reviewForAttempt(attemptId, {
    status: 'needs_attention',
    submission_attempted_at: unverifiedAt,
    unverified_submission: {
      at: unverifiedAt,
      cause: 'provider_error',
      portal_url: PORTAL_URL,
    },
    attention_reason: 'The provider returned but receipt persistence is still finishing.',
    attention_categories: ['unverified_submission'],
    verification: {
      status: 'verification_pending',
      requested_at: RESERVED_AT,
      runner: 'stratus-managed',
      continuation_fingerprint: 'expired-callback-fingerprint',
      continuation_execution_fingerprint: 'expired-callback-execution',
      continuation_resumed: true,
      continuation_call_started_at: '2026-08-24T08:05:30.000Z',
      continuation_call_deadline_at: '2026-08-24T08:05:31.000Z',
    },
  });
  review.unverified_submission!.submission_run_id = review.submission_run_id;
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'managed_browser');
  await appendFact(binding, 'attempt_opened', 'expired-callback-opening');
  await backendDb.transaction(async (tx: any) => {
    const authorization = await authorizeFinalSubmissionBoundary(binding, {
      executor: tx,
      factKey: 'expired-callback-boundary',
      ttlMs: 1,
    });
    assert.equal(authorization.kind, 'fresh');
  });
  await appendFact(binding, 'press_observed', 'provider-response-retained');
  await new Promise<void>((resolve) => setTimeout(resolve, 5));
  assert.equal((await submissionBoundaryAuthorization(userId, attemptId))?.active, false);

  const negativeAt = '2026-08-24T08:08:00.000Z';
  const negativeProjection: ApplicationReviewState = {
    ...review,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    unverified_submission: {
      ...review.unverified_submission!,
      resolution: 'not_sent',
      resolved_at: negativeAt,
    },
    attention_reason: 'You checked and the employer does not have this one.',
    attention_categories: ['unverified_submission'],
    updated_at: negativeAt,
  };
  const negative = await commitUnverifiedSubmissionResolution({
    row,
    userId,
    attemptId,
    found: false,
    current: review,
    pending: review.unverified_submission!,
    next: negativeProjection,
    now: negativeAt,
  });
  assert.equal(negative.length, 0);

  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, row.id)).limit(1);
  const storedReview = (stored.spec as { _review: ApplicationReviewState })._review;
  assert.equal(storedReview.submission_claim_id, attemptId);
  assert.equal(storedReview.unverified_submission?.resolution, undefined);
  const exactFacts = (await submissionAttemptEventsForPacket(userId, row.id))
    .filter((fact) => fact.attempt_id === attemptId);
  assert.equal(exactFacts.some((fact) => fact.event_kind === 'press_observed'), true);
  assert.equal(exactFacts.some((fact) => fact.event_kind === 'not_sent_proven'), false);
  const safety = await submissionAttemptRetrySafetyForPacket(userId, row.id);
  assert.equal(safety.kind, 'blocked_unverified');
  if (safety.kind === 'blocked_unverified') assert.equal(safety.reason, 'pressed');
});

test('two manual-handoff reservations racing on one packet expose exactly one attempt', async () => {
  const userId = await createUser({ emailPrefix: 'manual-race' });
  const review = reviewForAttempt(undefined, {
    attention_reason: 'The applicant must complete one employer-owned control.',
    attention_categories: ['privacy_consent'],
  });
  const row = await createPacket(userId, review);

  const results = await Promise.all([
    reserveAttendedManualAttempt(row, review),
    reserveAttendedManualAttempt(row, review),
  ]);
  const reserved = results.filter((result) => result.kind === 'reserved');
  assert.equal(reserved.length, 1, 'only one caller may receive a manual employer capability');
  assert.equal(results.filter((result) => result.kind === 'changed').length, 1);
  const facts = await submissionAttemptEventsForPacket(userId, row.id);
  assert.equal(facts.filter((fact) => fact.event_kind === 'attempt_opened').length, 1);
  assert.equal(facts[0]?.attempt_id, reserved[0]?.kind === 'reserved' ? reserved[0].binding.attemptId : null);
});

test('expired handoff repair cannot clear a claim that a concurrent writer replaced', async () => {
  const userId = await createUser({ emailPrefix: 'expired-repair-race' });
  const expiredAttemptId = randomUUID();
  const expired = reviewForAttempt(expiredAttemptId, {
    status: 'needs_attention',
    handoff_expires_at: '2026-08-24T07:00:00.000Z',
    attention_reason: 'Complete the employer form yourself.',
    attention_categories: ['privacy_consent'],
  });
  const row = await createPacket(userId, expired);
  const expiredBinding = attemptBinding(row, expired, expiredAttemptId, 'attended_handoff', 'manual_submission');
  await appendFact(expiredBinding, 'attempt_opened', 'expired-handoff-opening');

  const replacementAttemptId = randomUUID();
  let repairPromise: ReturnType<typeof repairExpiredAttendedHandoffClaim> | undefined;
  await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    repairPromise = repairExpiredAttendedHandoffClaim(row, userId, { info() {} } as any);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const replacement = reviewForAttempt(replacementAttemptId, {
      handoff_expires_at: '2026-08-24T09:00:00.000Z',
    });
    await tx.update(schema.generated_resumes)
      .set({ spec: { summary: 'Exact runtime packet', _review: replacement } })
      .where(eq(schema.generated_resumes.id, row.id));
    await appendFact(
      attemptBinding(row, replacement, replacementAttemptId),
      'attempt_opened',
      'replacement-opening',
      tx,
    );
  });

  assert.ok(repairPromise, 'the repair must have started while the competing lock was held');
  assert.equal(await repairPromise, null);
  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, row.id)).limit(1);
  const storedReview = (stored.spec as { _review: ApplicationReviewState })._review;
  assert.equal(storedReview.submission_claim_id, replacementAttemptId);
  const facts = await submissionAttemptEventsForPacket(userId, row.id);
  assert.equal(facts.some((fact) => fact.attempt_id === expiredAttemptId
    && fact.event_kind === 'not_sent_proven'), false,
  'a repair that lost the race must not close the old attempt or overwrite the replacement');
  assert.equal(facts.some((fact) => fact.attempt_id === replacementAttemptId
    && fact.event_kind === 'attempt_opened'), true);
});
