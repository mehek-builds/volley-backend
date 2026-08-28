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
import {
  attendedHandoffCapabilityEvidenceCode,
  type AttendedHandoffCapability,
  type AttendedHandoffCapabilityKind,
} from '../lib/attendedHandoffCapability';
import { createDashboardHandoffBinding } from '../lib/extensionHandoffPacket';
import { monitoredDescriptionHash } from '../lib/monitoredPortalRepair';
import { MANAGED_NETWORK_ACCESS_RESTRICTION_REASON } from '../lib/portalSubmission';
import { continueManagedBrowser, startManagedBrowserRequestBudget } from '../lib/browserbase';
import type {
  SubmissionAttemptBinding,
  SubmissionAttemptEventRecord,
  SubmissionNotSentProofKind,
  SubmissionAttemptSource,
} from '../lib/submissionAttemptLedger';

const JWT_SECRET = 'boundary-authorization-test-secret-32';
const PORTAL_URL = 'https://apply.workable.com/example/j/BOUNDARY1/';
const EXTENSION_HANDOFF_URL = 'https://apply.workable.com/example/j/BOUNDARY1/?handoff=extension';
const UNVERIFIED_PORTAL_URL = 'https://apply.workable.com/example/j/BOUNDARY1/?handoff=check';
const EMPLOYER_NETWORK_URL = 'https://apply.workable.com/example/j/BOUNDARY1/submit';
const EMPLOYER_RECEIPT_URL = 'https://apply.workable.com/example/j/BOUNDARY1/confirmation';
const MANUAL_POSTING_URL = 'https://jobs.smartrecruiters.com/Example/744000000000001-role';
const MANUAL_HANDOFF_URL = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/123e4567-e89b-12d3-a456-426614174000';
const RESERVED_AT = '2026-08-24T08:05:00.000Z';
const PACKET_VERSION = 'packet-boundary-v1';
const JOB_CONTEXT = {
  job_id: 'aa283015-a491-4c0f-b41b-0964bb850dc0',
  company: 'Example Company',
  role: 'Example Role',
};

type ResumeRow = typeof schema.generated_resumes.$inferSelect;
type FinalSource = Extract<SubmissionAttemptSource,
  'managed_browser' | 'direct_browser' | 'unsupported_email'>;

const savedEnv = { ...process.env };
const socketDir = mkdtempSync(join(tmpdir(), 'litos-boundary-authorization-'));
let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: any;
let backendPool: { end(): Promise<void> };
let app: FastifyInstance;
let attendedApp: FastifyInstance;
let appendSubmissionAttemptEvent: typeof import('../lib/submissionAttemptLedger').appendSubmissionAttemptEvent;
let authorizeFinalSubmissionBoundary: typeof import('../lib/submissionAttemptLedger').authorizeFinalSubmissionBoundary;
let freezePostingIdentity: typeof import('../lib/submissionAttemptLedger').freezePostingIdentity;
let lockSubmissionAttemptUser: typeof import('../lib/submissionAttemptLedger').lockSubmissionAttemptUser;
let submissionAttemptEventId: typeof import('../lib/submissionAttemptLedger').submissionAttemptEventId;
let submissionAttemptEventsForPacket: typeof import('../lib/submissionAttemptLedger').submissionAttemptEventsForPacket;
let submissionAttemptRetrySafety: typeof import('../lib/submissionAttemptLedger').submissionAttemptRetrySafety;
let submissionBoundaryAuthorization: typeof import('../lib/submissionAttemptLedger').submissionBoundaryAuthorization;
let assertFinalRunnerBoundaryClear: typeof import('./submissionRunner').assertFinalRunnerBoundaryClear;
let assertManagedSecurityCodeContinuationBoundaryClear:
  typeof import('./submissionRunner').assertManagedSecurityCodeContinuationBoundaryClear;
let executeAfterFinalSubmissionBoundary: typeof import('./submissionRunner').executeAfterFinalSubmissionBoundary;
let managedContinuationExecutionFingerprint:
  typeof import('./submissionRunner').managedContinuationExecutionFingerprint;
let MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS:
  typeof import('./submissionRunner').MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS;
let MANAGED_SECURITY_CODE_CONTINUATION_DISPATCH_MARGIN_MS:
  typeof import('./submissionRunner').MANAGED_SECURITY_CODE_CONTINUATION_DISPATCH_MARGIN_MS;
let MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS:
  typeof import('./submissionRunner').MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS;
let recordManagedAuthorizedAttemptUnverified:
  typeof import('./submissionRunner').recordManagedAuthorizedAttemptUnverified;
let recordManagedSecurityCodeContinuationUnverified:
  typeof import('./submissionRunner').recordManagedSecurityCodeContinuationUnverified;
let recordManagedSubmissionConfirmed:
  typeof import('./submissionRunner').recordManagedSubmissionConfirmed;
let finalApplicationBoundaryGate: typeof import('./applications').finalApplicationBoundaryGate;
let completeAttendedHandoffNotSent: typeof import('./applications').completeAttendedHandoffNotSent;
let managedContinuationCallbackMayBeLive:
  typeof import('./applications').managedContinuationCallbackMayBeLive;
let repairExpiredAttendedHandoffClaim: typeof import('./applications').repairExpiredAttendedHandoffClaim;
let reserveAttendedManualAttempt: typeof import('./applications').reserveAttendedManualAttempt;
let attendedHandoffCapabilityForRow: typeof import('./applications').attendedHandoffCapabilityForRow;
let finalizeAttendedHandoffCapability: typeof import('./applications').finalizeAttendedHandoffCapability;

function reviewForAttempt(
  attemptId: string,
  overrides: Partial<ApplicationReviewState> = {},
): ApplicationReviewState {
  const runId = randomUUID();
  return {
    jd_text: 'Complete the application for this example role.',
    role: JOB_CONTEXT.role,
    portal_url: PORTAL_URL,
    portal_supported: true,
    ats_name: 'workable',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: RESERVED_AT,
    submission_run_id: runId,
    submission_claimed_at: RESERVED_AT,
    submission_claim_id: attemptId,
    submission_packet_version: PACKET_VERSION,
    submission_authorization: {
      source: 'per_application_approval',
      authorized_at: RESERVED_AT,
    },
    attention_reason: 'Check whether the employer received this exact attempt.',
    attention_categories: ['unverified_submission'],
    ...overrides,
  };
}

function passiveEmployerNavigationLeaks(): Partial<ApplicationReviewState> {
  return {
    extension_handoff_url: EXTENSION_HANDOFF_URL,
    provider_diagnostics: {
      request: {
        method: 'GET',
        employer_url: EMPLOYER_NETWORK_URL,
      },
    },
    unverified_submission: {
      at: RESERVED_AT,
      cause: 'provider_error',
      portal_url: UNVERIFIED_PORTAL_URL,
      network: [{ method: 'POST', url: EMPLOYER_NETWORK_URL, status: null }],
    },
  } as Partial<ApplicationReviewState>;
}

function assertPassiveResponseHidesEmployerNavigation(body: any): void {
  assert.ok(body.review && typeof body.review === 'object');
  assert.equal('portal_url' in body, false);
  assert.equal('extension_handoff_url' in body, false);
  assert.equal('portal_url' in body.review, false);
  assert.equal('extension_handoff_url' in body.review, false);
  if (body.review.unverified_submission) {
    assert.equal('portal_url' in body.review.unverified_submission, false);
    assert.equal('url' in body.review.unverified_submission.network?.[0], false);
    assert.equal(body.review.unverified_submission.network?.[0]?.method, 'POST');
  }
  if (body.review.provider_diagnostics) {
    assert.equal('employer_url' in body.review.provider_diagnostics.request, false);
    assert.equal(body.review.provider_diagnostics.request.method, 'GET');
  }
  if (body.review.receipt) {
    assert.equal('final_url' in body.review.receipt, false);
    assert.equal(body.review.receipt.confirmation_text, 'Application received');
  }
  const serialized = JSON.stringify(body);
  for (const employerUrl of [
    PORTAL_URL,
    EXTENSION_HANDOFF_URL,
    UNVERIFIED_PORTAL_URL,
    EMPLOYER_NETWORK_URL,
    EMPLOYER_RECEIPT_URL,
  ]) {
    assert.equal(serialized.includes(employerUrl), false, `passive response leaked ${employerUrl}`);
  }
}

async function createUser(label: string): Promise<string> {
  const userId = randomUUID();
  await backendDb.insert(schema.users).values({
    id: userId,
    email: `${label}-${userId}@example.test`,
    plan: 'plus',
    manual_access_override: 'plus_paid',
  });
  return userId;
}

async function createPacket(userId: string, review: ApplicationReviewState): Promise<ResumeRow> {
  const [row] = await backendDb.insert(schema.generated_resumes).values({
    id: randomUUID(),
    user_id: userId,
    job_context: JOB_CONTEXT,
    spec: { summary: 'Exact boundary packet', _review: review },
    resume_object_key: `users/${userId}/resumes/${randomUUID()}.pdf`,
  }).returning();
  return row;
}

function attemptBinding(
  row: ResumeRow,
  review: ApplicationReviewState,
  attemptId: string,
  source: SubmissionAttemptSource,
  operation: SubmissionAttemptBinding['operation'] = 'initial_submission',
): SubmissionAttemptBinding {
  return {
    attemptId,
    userId: row.user_id,
    packetId: row.id,
    applicationId: null,
    parentAttemptId: null,
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

async function appendOpening(
  binding: SubmissionAttemptBinding,
  factKey: string,
  capability?: AttendedHandoffCapability,
): Promise<void> {
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(binding.attemptId, 'attempt_opened', factKey),
    eventKind: 'attempt_opened',
    evidenceCode: capability ? attendedHandoffCapabilityEvidenceCode(capability) : factKey,
  });
}

async function factsFor(binding: SubmissionAttemptBinding): Promise<SubmissionAttemptEventRecord[]> {
  return submissionAttemptEventsForPacket(binding.userId, binding.packetId);
}

async function storedReview(row: ResumeRow): Promise<ApplicationReviewState> {
  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, row.id)).limit(1);
  assert.ok(stored, 'the packet must still exist');
  return (stored.spec as { _review: ApplicationReviewState })._review;
}

async function authToken(userId: string): Promise<string> {
  return new SignJWT({
    userId,
    email: `boundary-${userId}@example.test`,
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function resolveNotSent(row: ResumeRow, attemptId: string) {
  return app.inject({
    method: 'POST',
    url: `/applications/${row.id}/submission/unverified`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
    payload: { found: false, attempt_id: attemptId },
  });
}

async function resolveFound(row: ResumeRow, attemptId: string) {
  return app.inject({
    method: 'POST',
    url: `/applications/${row.id}/submission/unverified`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
    payload: { found: true, attempt_id: attemptId },
  });
}

function isExpectedBoundaryStop(error: unknown): boolean {
  return error instanceof Error && [
    'FinalSubmissionBoundaryBlockedError',
    'FinalSubmissionBoundaryChangedError',
    'FinalSubmissionAuthorizationChangedError',
    'FinalSubmissionBoundaryAlreadyAuthorizedError',
  ].includes(error.name);
}

async function assertAuthorizationPrecedesCallback(
  binding: SubmissionAttemptBinding,
): Promise<void> {
  const events = await factsFor(binding);
  assert.equal(
    events.filter((event) => event.attempt_id === binding.attemptId
      && event.event_kind === 'boundary_authorized').length,
    1,
    'one durable boundary authorization must exist before the external callback begins',
  );
}

async function crossFinalCapability(
  source: FinalSource,
  row: ResumeRow,
  review: ApplicationReviewState,
  binding: SubmissionAttemptBinding,
  externalCallback: () => Promise<void>,
): Promise<'crossed' | 'blocked'> {
  if (source === 'managed_browser' || source === 'direct_browser') {
    try {
      await executeAfterFinalSubmissionBoundary(
        () => assertFinalRunnerBoundaryClear(row, review, binding),
        async () => {
          await assertAuthorizationPrecedesCallback(binding);
          await externalCallback();
        },
      );
      return 'crossed';
    } catch (error) {
      if (isExpectedBoundaryStop(error)) return 'blocked';
      throw error;
    }
  }

  const gate = await finalApplicationBoundaryGate({
    row,
    binding,
    factKey: `${source}-boundary-test`,
  });
  if (gate.kind !== 'clear') return 'blocked';
  await assertAuthorizationPrecedesCallback(binding);
  await externalCallback();
  return 'crossed';
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
  process.env.ENCRYPTION_KEY = 'boundary-authorization-encryption-key';

  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({
    appendSubmissionAttemptEvent,
    authorizeFinalSubmissionBoundary,
    freezePostingIdentity,
    lockSubmissionAttemptUser,
    submissionAttemptEventId,
    submissionAttemptEventsForPacket,
    submissionAttemptRetrySafety,
    submissionBoundaryAuthorization,
  } = await import('../lib/submissionAttemptLedger'));
  ({
    MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS,
    MANAGED_SECURITY_CODE_CONTINUATION_DISPATCH_MARGIN_MS,
    MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS,
    assertFinalRunnerBoundaryClear,
    assertManagedSecurityCodeContinuationBoundaryClear,
    executeAfterFinalSubmissionBoundary,
    managedContinuationExecutionFingerprint,
    recordManagedAuthorizedAttemptUnverified,
    recordManagedSecurityCodeContinuationUnverified,
    recordManagedSubmissionConfirmed,
  } = await import('./submissionRunner'));
  const applications = await import('./applications');
  attendedHandoffCapabilityForRow = applications.attendedHandoffCapabilityForRow;
  completeAttendedHandoffNotSent = applications.completeAttendedHandoffNotSent;
  finalApplicationBoundaryGate = applications.finalApplicationBoundaryGate;
  finalizeAttendedHandoffCapability = applications.finalizeAttendedHandoffCapability;
  managedContinuationCallbackMayBeLive = applications.managedContinuationCallbackMayBeLive;
  repairExpiredAttendedHandoffClaim = applications.repairExpiredAttendedHandoffClaim;
  reserveAttendedManualAttempt = applications.reserveAttendedManualAttempt;
  app = Fastify({ logger: false });
  await app.register(applications.applicationRoutes);
  await app.ready();
  attendedApp = Fastify({ logger: false });
  await attendedApp.register(applications.applicationRoutes, {
    attendedPacketAudit: async (row: ResumeRow) => ({
      valid: true as const,
      audit: {
        audit_digest: 'a'.repeat(64),
        packet_version: 'attended-route-test-packet-v1',
        bindings: { pdf: { sha256: 'b'.repeat(64), sizeBytes: 128 } },
      },
      pdfBytes: Buffer.from('%PDF-1.7\nattended route test packet'),
      row,
    }) as never,
  });
  await attendedApp.ready();
});

after(async () => {
  await attendedApp?.close();
  await app?.close();
  await backendPool?.end();
  await server?.stop();
  await database?.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('final authorization fails closed when an interposed writer makes its final fold terminal', async () => {
  const userId = await createUser('authorization-final-fold');
  const attemptId = randomUUID();
  const injectedId = randomUUID();
  const injectedEventId = randomUUID();
  const review = reviewForAttempt(attemptId);
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'managed_browser');
  await appendOpening(binding, 'authorization-final-fold-opening');

  await database.exec(`
    create function test_inject_confirmation_after_boundary()
    returns trigger language plpgsql as $$
    begin
      if new.event_kind = 'boundary_authorized' then
        insert into application_submission_attempt_events (
          id, user_id, application_id, packet_id, event_id, attempt_id, parent_attempt_id,
          event_kind, source, operation, submission_run_id, submission_claim_id, packet_version,
          posting_key, job_id, company_role, company_name, role, portal_url, portal_identity,
          proof_kind, evidence_code, boundary_activation_id, boundary_expires_at,
          observed_at, created_at
        ) values (
          '${injectedId}', new.user_id, new.application_id, new.packet_id,
          '${injectedEventId}', new.attempt_id, new.parent_attempt_id,
          'submission_confirmed', new.source, new.operation, new.submission_run_id,
          new.submission_claim_id, new.packet_version, new.posting_key, new.job_id,
          new.company_role, new.company_name, new.role, new.portal_url, new.portal_identity,
          null, 'test_interposed_confirmation', null, null,
          new.observed_at + interval '1 millisecond', new.created_at + interval '1 millisecond'
        );
      end if;
      return new;
    end;
    $$;
    create trigger test_inject_confirmation_after_boundary_trigger
      after insert on application_submission_attempt_events
      for each row execute function test_inject_confirmation_after_boundary();
  `);
  try {
    const result = await backendDb.transaction(async (tx: any) => {
      await lockSubmissionAttemptUser(tx, userId);
      return authorizeFinalSubmissionBoundary(binding, {
        executor: tx,
        factKey: 'authorization-final-fold-boundary',
      });
    });
    assert.equal(result.kind, 'blocked');
    assert.equal(
      result.kind === 'blocked' && result.retrySafety.kind,
      'blocked_confirmed',
      'a terminal fact observed by the final read must veto a fresh employer capability',
    );
  } finally {
    await database.exec(`
      drop trigger if exists test_inject_confirmation_after_boundary_trigger
        on application_submission_attempt_events;
      drop function if exists test_inject_confirmation_after_boundary();
    `);
  }
});

test('a drained legacy press accepts the applicant checked-not-sent resolution', async () => {
  const userId = await createUser('legacy-press-applicant-resolution');
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, { unverified_submission: undefined });
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'legacy_backfill');
  await appendOpening(binding, 'legacy-press-resolution-opening');
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'press_observed', 'legacy-press-resolution-press'),
    eventKind: 'press_observed',
    evidenceCode: 'legacy_pressed_unverified',
  });

  const response = await resolveNotSent(row, attemptId);
  assert.equal(response.statusCode, 200, response.body);
  const events = await factsFor(binding);
  const safety = submissionAttemptRetrySafety(
    events.filter((event) => event.attempt_id === attemptId),
  );
  assert.equal(safety.kind, 'safe_not_sent');
  assert.equal(
    safety.kind === 'safe_not_sent' && safety.proofKind,
    'applicant_checked_not_sent',
  );
  assert.equal((await storedReview(row)).submission_claim_id, undefined);
});

for (const source of ['managed_browser', 'direct_browser', 'unsupported_email'] as const) {
  test(`${source}: a not-sent resolution that linearizes first blocks the external capability`, async () => {
    const userId = await createUser(`resolver-first-${source}`);
    const attemptId = randomUUID();
    const review = reviewForAttempt(attemptId);
    const row = await createPacket(userId, review);
    const binding = attemptBinding(row, review, attemptId, source);
    await appendOpening(binding, `${source}-resolver-first-opening`);

    const resolution = await resolveNotSent(row, attemptId);
    assert.equal(resolution.statusCode, 200, resolution.body);
    let externalCalls = 0;
    const outcome = await crossFinalCapability(source, row, review, binding, async () => {
      externalCalls += 1;
    });

    assert.equal(outcome, 'blocked');
    assert.equal(externalCalls, 0, 'a released claim cannot retain an employer capability');
    const events = await factsFor(binding);
    assert.equal(events.some((event) => event.attempt_id === attemptId
      && event.event_kind === 'not_sent_proven'), true);
    assert.equal(events.some((event) => event.attempt_id === attemptId
      && event.event_kind === 'boundary_authorized'), false);
  });

  test(`${source}: authorization that linearizes first refuses found false without releasing the claim`, async () => {
    const userId = await createUser(`authorization-first-${source}`);
    const attemptId = randomUUID();
    const review = reviewForAttempt(attemptId);
    const row = await createPacket(userId, review);
    const binding = attemptBinding(row, review, attemptId, source);
    await appendOpening(binding, `${source}-authorization-first-opening`);

    let externalCalls = 0;
    const outcome = await crossFinalCapability(source, row, review, binding, async () => {
      externalCalls += 1;
    });
    assert.equal(outcome, 'crossed');
    assert.equal(externalCalls, 1);

    const replay = await crossFinalCapability(source, row, review, binding, async () => {
      externalCalls += 1;
    });
    assert.equal(replay, 'blocked');
    assert.equal(externalCalls, 1, 'an active authorization is not a second employer capability');

    const resolution = await resolveNotSent(row, attemptId);
    assert.equal(resolution.statusCode, 409, resolution.body);
    const current = await storedReview(row);
    assert.equal(current.submission_claim_id, attemptId, 'an authorized attempt keeps its duplicate lock');
    assert.equal(current.unverified_submission?.resolution, undefined);
    const events = await factsFor(binding);
    assert.equal(events.filter((event) => event.attempt_id === attemptId
      && event.event_kind === 'boundary_authorized').length, 1);
    assert.equal(events.some((event) => event.attempt_id === attemptId
      && event.event_kind === 'not_sent_proven'), false,
    'a generic found-false answer cannot prove that an already authorized callback did not cross');
  });
}

test('a resolved mutable attempt cannot hide or release a separate legacy capability hold', async () => {
  const userId = await createUser('legacy-independent-resolution');
  const attemptA = randomUUID();
  const attemptB = randomUUID();
  const resolvedAtA = '2026-08-22T11:00:00.000Z';
  const baseReview = reviewForAttempt(attemptA);
  const review: ApplicationReviewState = {
    ...baseReview,
    unverified_submission: {
      at: '2026-08-22T10:00:00.000Z',
      cause: 'provider_error',
      portal_url: PORTAL_URL,
      submission_run_id: baseReview.submission_run_id!,
      resolution: 'not_sent',
      resolved_at: resolvedAtA,
    },
  };
  const row = await createPacket(userId, review);
  const bindingA = attemptBinding(row, review, attemptA, 'legacy_backfill');
  await appendOpening(bindingA, 'legacy-current-resolved-opening');
  await appendSubmissionAttemptEvent({
    ...bindingA,
    eventId: submissionAttemptEventId(attemptA, 'not_sent_proven', 'legacy-current-resolution'),
    eventKind: 'not_sent_proven',
    proofKind: 'applicant_checked_not_sent',
    evidenceCode: 'applicant_checked_not_sent',
    observedAt: new Date(resolvedAtA),
  });

  const bindingB: SubmissionAttemptBinding = {
    attemptId: attemptB,
    userId,
    packetId: row.id,
    applicationId: null,
    parentAttemptId: null,
    source: 'legacy_backfill',
    operation: 'initial_submission',
    postingIdentity: freezePostingIdentity(row.job_context, review.portal_url),
    submissionRunId: null,
    submissionClaimId: null,
    packetVersion: null,
  };
  await appendOpening(bindingB, 'legacy-generated-capability-opening');

  const resolvedB = await resolveNotSent(row, attemptB);
  assert.equal(resolvedB.statusCode, 200, resolvedB.body);
  assert.equal(resolvedB.json().retry_safety.kind, 'safe_not_sent');
  const current = await storedReview(row);
  assert.equal(current.unverified_submission?.resolution, 'not_sent');
  assert.notEqual(current.unverified_submission?.resolved_at, resolvedAtA);
  assert.equal(current.submission_claim_id, undefined);

  const events = await factsFor(bindingB);
  const eventKinds = (attemptId: string) => events
    .filter((event) => event.attempt_id === attemptId)
    .map((event) => event.event_kind)
    .sort();
  assert.deepEqual(eventKinds(attemptA), ['attempt_opened', 'not_sent_proven']);
  assert.deepEqual(eventKinds(attemptB), ['attempt_opened', 'not_sent_proven']);
  assert.equal(
    events.filter((event) => event.attempt_id === attemptB
      && event.event_kind === 'not_sent_proven'
      && event.evidence_code === 'applicant_checked_not_sent').length,
    1,
  );

  const replay = await resolveNotSent(row, attemptB);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().already_resolved, true);

  const laterPositive = await resolveFound(row, attemptB);
  assert.equal(laterPositive.statusCode, 200, laterPositive.body);
  assert.equal(laterPositive.json().retry_safety.kind, 'blocked_confirmed');
  const confirmedReview = await storedReview(row);
  assert.equal(confirmedReview.status, 'submitted');
  assert.equal(confirmedReview.unverified_submission?.resolution, 'sent');
  const confirmedFacts = await factsFor(bindingB);
  assert.equal(confirmedFacts.filter((event) => event.attempt_id === attemptB
    && event.event_kind === 'submission_confirmed').length, 1);

  const noDowngrade = await resolveNotSent(row, attemptB);
  assert.equal(noDowngrade.statusCode, 409, noDowngrade.body);
  const unrelatedAttempt = randomUUID();
  const unrelated = await resolveNotSent(row, unrelatedAttempt);
  assert.equal(unrelated.statusCode, 409, unrelated.body);
  const finalEvents = await factsFor(bindingB);
  assert.equal(finalEvents.filter((event) => event.attempt_id === attemptB
    && event.event_kind === 'not_sent_proven').length, 1);
  assert.equal(finalEvents.some((event) => event.attempt_id === unrelatedAttempt), false);
});

for (const source of ['managed_browser', 'direct_browser', 'unsupported_email'] as const) {
  test(`${source}: A authorization wins before resolution and prevents a retry B capability`, async () => {
    const userId = await createUser(`authorization-interleave-${source}`);
    const attemptA = randomUUID();
    const reviewA = reviewForAttempt(attemptA);
    const rowA = await createPacket(userId, reviewA);
    const bindingA = attemptBinding(rowA, reviewA, attemptA, source);
    await appendOpening(bindingA, `${source}-interleave-A-opening`);

    const reviewB = reviewForAttempt(randomUUID(), {
      submission_run_id: undefined,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
      submission_packet_version: undefined,
      submission_authorization: undefined,
    });
    const rowB = await createPacket(userId, reviewB);
    let externalCalls = 0;

    const outcomeA = await crossFinalCapability(source, rowA, reviewA, bindingA, async () => {
      const staleResolution = await resolveNotSent(rowA, attemptA);
      assert.equal(staleResolution.statusCode, 409, staleResolution.body);

      const reservationB = await reserveAttendedManualAttempt(rowB, reviewB);
      assert.equal(reservationB.kind, 'duplicate_risk',
        'attempt B must see A authorization before it can reserve another employer capability');
      externalCalls += 1;
    });

    assert.equal(outcomeA, 'crossed');
    assert.equal(externalCalls, 1);
    const factsA = await factsFor(bindingA);
    assert.equal(factsA.some((event) => event.event_kind === 'boundary_authorized'), true);
    assert.equal(factsA.some((event) => event.event_kind === 'not_sent_proven'), false);
    const factsB = await submissionAttemptEventsForPacket(userId, rowB.id);
    assert.equal(factsB.length, 0, 'blocked retry B must not mint an opening or authorization');
  });
}

async function managedPressedChallengeFixture(
  operation: SubmissionAttemptBinding['operation'],
  label: string,
  options: {
    authorizationTtlMs?: number;
    providerExpiresInMs?: number;
  } = {},
) {
  const userId = await createUser(label);
  const attemptId = randomUUID();
  const baseReview = reviewForAttempt(attemptId);
  const submissionAttempt = {
    runId: baseReview.submission_run_id!,
    claimId: attemptId,
    executionId: randomUUID(),
  };
  const continuationFingerprint = 'a'.repeat(64);
  const providerExpiresAt = new Date(
    Date.now() + (options.providerExpiresInMs ?? 2 * 60 * 1000),
  ).toISOString();
  const review: ApplicationReviewState = {
    ...baseReview,
    security_code: {
      digits: 6,
      sent_to: 'applicant@example.test',
      requested_at: RESERVED_AT,
      submit_was_authorized: true,
    },
    verification: {
      status: 'searching',
      requested_at: RESERVED_AT,
      retry_count: 0,
      runner: 'stratus-managed',
      continuation_fingerprint: continuationFingerprint,
      continuation_execution_fingerprint: managedContinuationExecutionFingerprint(submissionAttempt),
      continuation_resumed: false,
    },
  };
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'managed_browser', operation);
  await appendOpening(binding, `${label}-opening`);
  await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    const authorization = await authorizeFinalSubmissionBoundary(binding, {
      executor: tx,
      factKey: `${label}-initial-boundary`,
      ...(options.authorizationTtlMs ? { ttlMs: options.authorizationTtlMs } : {}),
    });
    assert.equal(authorization.kind, 'fresh');
  });
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'press_observed', 'managed-initial-submit'),
    eventKind: 'press_observed',
    evidenceCode: 'test_initial_security_challenge_press',
  });
  return { row, review, binding, submissionAttempt, continuationFingerprint, providerExpiresAt };
}

test('managed email-code continuation consumes the exact parent once and confirmation closes it', async () => {
  const fixture = await managedPressedChallengeFixture('initial_submission', 'managed-parent-continuation');
  let continuationCalls = 0;
  await executeAfterFinalSubmissionBoundary(
    () => assertManagedSecurityCodeContinuationBoundaryClear(
      fixture.row,
      fixture.review,
      fixture.binding,
      fixture.continuationFingerprint,
      fixture.submissionAttempt,
      fixture.providerExpiresAt,
      fixture.review.security_code!,
    ),
    async () => { continuationCalls += 1; },
  );
  const consumedReview = await storedReview(fixture.row);
  assert.equal(consumedReview.verification?.status, 'verification_pending');
  assert.equal(consumedReview.verification?.continuation_resumed, true);

  await assert.rejects(
    executeAfterFinalSubmissionBoundary(
      () => assertManagedSecurityCodeContinuationBoundaryClear(
        fixture.row,
        fixture.review,
        fixture.binding,
        fixture.continuationFingerprint,
        fixture.submissionAttempt,
        fixture.providerExpiresAt,
        fixture.review.security_code!,
      ),
      async () => { continuationCalls += 1; },
    ),
    isExpectedBoundaryStop,
  );
  assert.equal(continuationCalls, 1, 'the same retained continuation cannot call Stratus twice');

  await appendSubmissionAttemptEvent({
    ...fixture.binding,
    eventId: submissionAttemptEventId(fixture.binding.attemptId, 'submission_confirmed', 'managed-code-receipt'),
    eventKind: 'submission_confirmed',
    evidenceCode: 'test_managed_code_receipt',
  });
  const events = await factsFor(fixture.binding);
  assert.equal(events.filter((event) => event.event_kind === 'attempt_opened').length, 1);
  assert.equal(events.filter((event) => event.event_kind === 'boundary_authorized').length, 1);
  assert.equal(submissionAttemptRetrySafety(events).kind, 'blocked_confirmed',
    'the code receipt closes the parent rather than leaving an independent pressed attempt behind');
});

test('a manually claimed security-code attempt uses the same one-shot parent continuation gate', async () => {
  const fixture = await managedPressedChallengeFixture(
    'security_code_continuation',
    'managed-manual-code-continuation',
  );
  await assert.doesNotReject(assertManagedSecurityCodeContinuationBoundaryClear(
    fixture.row,
    fixture.review,
    fixture.binding,
    fixture.continuationFingerprint,
    fixture.submissionAttempt,
    fixture.providerExpiresAt,
    fixture.review.security_code!,
  ));
  await assert.rejects(
    assertManagedSecurityCodeContinuationBoundaryClear(
      fixture.row,
      fixture.review,
      fixture.binding,
      fixture.continuationFingerprint,
      fixture.submissionAttempt,
      fixture.providerExpiresAt,
      fixture.review.security_code!,
    ),
    isExpectedBoundaryStop,
  );
});

test('managed continuation rejects a different execution identity without consuming the exact one', async () => {
  const fixture = await managedPressedChallengeFixture('initial_submission', 'managed-execution-identity');
  await assert.rejects(
    assertManagedSecurityCodeContinuationBoundaryClear(
      fixture.row,
      fixture.review,
      fixture.binding,
      fixture.continuationFingerprint,
      { ...fixture.submissionAttempt, executionId: randomUUID() },
      fixture.providerExpiresAt,
      fixture.review.security_code!,
    ),
    isExpectedBoundaryStop,
  );
  assert.equal((await storedReview(fixture.row)).verification?.continuation_resumed, false);
  await assert.doesNotReject(assertManagedSecurityCodeContinuationBoundaryClear(
    fixture.row,
    fixture.review,
    fixture.binding,
    fixture.continuationFingerprint,
    fixture.submissionAttempt,
    fixture.providerExpiresAt,
    fixture.review.security_code!,
  ));
});

test('managed continuation excludes only its parent and still blocks another same-posting risk', async () => {
  const fixture = await managedPressedChallengeFixture('initial_submission', 'managed-parent-only-exclusion');
  const otherReview = reviewForAttempt(randomUUID());
  const otherRow = await createPacket(fixture.row.user_id, otherReview);
  const other = attemptBinding(
    otherRow,
    otherReview,
    otherReview.submission_claim_id!,
    'direct_browser',
  );
  await appendOpening(other, 'managed-parent-only-unrelated-opening');
  await appendSubmissionAttemptEvent({
    ...other,
    eventId: submissionAttemptEventId(other.attemptId, 'press_observed', 'unrelated-press'),
    eventKind: 'press_observed',
    evidenceCode: 'test_unrelated_same_posting_press',
  });

  await assert.rejects(
    assertManagedSecurityCodeContinuationBoundaryClear(
      fixture.row,
      fixture.review,
      fixture.binding,
      fixture.continuationFingerprint,
      fixture.submissionAttempt,
      fixture.providerExpiresAt,
      fixture.review.security_code!,
    ),
    (error: unknown) => error instanceof Error && error.name === 'ManagedSecurityCodeContinuationRefusedError',
  );
  assert.equal((await storedReview(fixture.row)).verification?.continuation_resumed, false);
});

test('near-expiry managed continuation refuses before callback and never records not-sent', async () => {
  const fixture = await managedPressedChallengeFixture(
    'initial_submission',
    'managed-near-expiry-refusal',
    { providerExpiresInMs: 60_000 },
  );
  let continuationCalls = 0;

  await assert.rejects(
    executeAfterFinalSubmissionBoundary(
      () => assertManagedSecurityCodeContinuationBoundaryClear(
        fixture.row,
        fixture.review,
        fixture.binding,
        fixture.continuationFingerprint,
        fixture.submissionAttempt,
        fixture.providerExpiresAt,
        fixture.review.security_code!,
      ),
      async () => { continuationCalls += 1; },
    ),
    (error: unknown) => error instanceof Error
      && error.name === 'ManagedSecurityCodeContinuationRefusedError'
      && (error as Error & { reason?: string }).reason === 'lease_window_too_short',
  );

  assert.equal(continuationCalls, 0);
  const current = await storedReview(fixture.row);
  assert.equal(current.status, 'needs_attention');
  assert.equal(current.submission_claim_id, fixture.binding.attemptId);
  assert.deepEqual(current.submission_authorization, fixture.review.submission_authorization);
  assert.equal(current.unverified_submission?.cause, 'no_confirmation_state');
  assert.equal(current.unverified_submission?.resolution, undefined);
  assert.equal(current.verification?.continuation_resumed, false);
  assert.equal(current.verification?.continuation_call_started_at, undefined);
  assert.equal(current.verification?.continuation_call_deadline_at, undefined);
  const events = await factsFor(fixture.binding);
  assert.equal(events.some((event) => event.event_kind === 'not_sent_proven'), false);
  assert.equal(submissionAttemptRetrySafety(events).kind, 'blocked_unverified');
});

test('two managed continuation callers linearize to one provider callback', async () => {
  const fixture = await managedPressedChallengeFixture(
    'initial_submission',
    'managed-concurrent-continuation',
  );
  let continuationCalls = 0;
  const cross = () => executeAfterFinalSubmissionBoundary(
    () => assertManagedSecurityCodeContinuationBoundaryClear(
      fixture.row,
      fixture.review,
      fixture.binding,
      fixture.continuationFingerprint,
      fixture.submissionAttempt,
      fixture.providerExpiresAt,
      fixture.review.security_code!,
    ),
    async () => { continuationCalls += 1; },
  );

  const results = await Promise.allSettled([cross(), cross()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.ok(rejected && isExpectedBoundaryStop(rejected.reason));
  assert.equal(continuationCalls, 1);
  const current = await storedReview(fixture.row);
  assert.equal(current.verification?.continuation_resumed, true);
  assert.equal(current.submission_claim_id, fixture.binding.attemptId);
});

test('consumed provider uncertainty preserves spent code and the bounded provider deadline', async () => {
  const fixture = await managedPressedChallengeFixture(
    'initial_submission',
    'managed-consumed-provider-uncertainty',
  );
  const authorization = await submissionBoundaryAuthorization(
    fixture.row.user_id,
    fixture.binding.attemptId,
  );
  assert.ok(authorization);
  const spentAttempt = {
    at: new Date().toISOString(),
    fingerprint: 'spent-managed-code-fingerprint',
    outcome: 'error' as const,
  };
  const spentCode = {
    ...fixture.review.security_code!,
    attempts: [spentAttempt],
  };

  const continuationAuthorization = await assertManagedSecurityCodeContinuationBoundaryClear(
    fixture.row,
    fixture.review,
    fixture.binding,
    fixture.continuationFingerprint,
    fixture.submissionAttempt,
    fixture.providerExpiresAt,
    spentCode,
  );
  const consumed = await storedReview(fixture.row);
  assert.equal(consumed.verification?.continuation_resumed, true);
  assert.equal(
    consumed.verification?.continuation_call_deadline_at,
    continuationAuthorization.providerDeadlineAt,
  );
  assert.ok(
    Date.parse(continuationAuthorization.providerDeadlineAt) < Date.parse(authorization.expiresAt),
    'the applicant fence records the bounded provider call, not the broader parent lease',
  );
  assert.equal(
    Date.parse(continuationAuthorization.providerDeadlineAt)
      - Date.parse(consumed.verification!.continuation_call_started_at!),
    MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS,
    'the persisted provider fence is exactly the one accepted call budget',
  );
  assert.ok(
    Date.parse(authorization.expiresAt) - Date.parse(continuationAuthorization.providerDeadlineAt)
      > MANAGED_SECURITY_CODE_CONTINUATION_DISPATCH_MARGIN_MS,
    'the accepted call ends before the parent applicant-resolution fence',
  );
  assert.deepEqual(consumed.security_code?.attempts, [spentAttempt]);

  const persisted = await recordManagedSecurityCodeContinuationUnverified(
    fixture.row,
    fixture.binding,
    'Managed provider connection closed after the continuation was consumed',
    { previewUrl: 'https://proof.example/managed-timeout.png' },
  );
  assert.equal(persisted, true);
  const uncertain = await storedReview(fixture.row);
  assert.equal(uncertain.status, 'needs_attention');
  assert.equal(uncertain.submission_claim_id, fixture.binding.attemptId);
  assert.equal(uncertain.unverified_submission?.cause, 'no_confirmation_state');
  assert.equal(uncertain.unverified_submission?.resolution, undefined);
  assert.equal(uncertain.preview_screenshot_url, 'https://proof.example/managed-timeout.png');
  assert.equal(uncertain.verification?.continuation_resumed, true);
  assert.equal(
    uncertain.verification?.continuation_call_deadline_at,
    continuationAuthorization.providerDeadlineAt,
  );
  assert.deepEqual(uncertain.security_code?.attempts, [spentAttempt]);
  assert.equal((await factsFor(fixture.binding)).some(
    (event) => event.event_kind === 'not_sent_proven',
  ), false);
});

test('a post-gate pause beyond the dispatch margin makes zero provider calls and keeps the claim blocked', async () => {
  const fixture = await managedPressedChallengeFixture(
    'initial_submission',
    'managed-post-gate-dispatch-delay',
  );
  const requestBudget = startManagedBrowserRequestBudget(
    MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS,
  );
  const continuationAuthorization = await assertManagedSecurityCodeContinuationBoundaryClear(
    fixture.row,
    fixture.review,
    fixture.binding,
    fixture.continuationFingerprint,
    fixture.submissionAttempt,
    fixture.providerExpiresAt,
    fixture.review.security_code!,
  );
  const persistedAfterGate = await storedReview(fixture.row);
  assert.equal(
    persistedAfterGate.verification?.continuation_call_deadline_at,
    continuationAuthorization.providerDeadlineAt,
  );

  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let providerCalls = 0;
  globalThis.fetch = (async () => {
    providerCalls += 1;
    throw new Error('the expired dispatch margin reached Stratus');
  }) as typeof fetch;

  try {
    await new Promise<void>((resolve) => setTimeout(
      resolve,
      MANAGED_SECURITY_CODE_CONTINUATION_DISPATCH_MARGIN_MS + 25,
    ));
    await assert.rejects(
      continueManagedBrowser('c'.repeat(43), [{ type: 'click', selector: '#verify' }], {
        submissionAttempt: fixture.submissionAttempt,
        requestBudget,
        providerDeadlineAt: continuationAuthorization.providerDeadlineAt,
        minimumDispatchBudgetMs: MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS,
      }),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
  assert.equal(providerCalls, 0, 'the delayed continuation must refuse before provider dispatch');

  assert.equal(await recordManagedSecurityCodeContinuationUnverified(
    fixture.row,
    fixture.binding,
    'The provider budget expired before dispatch',
  ), true);
  const response = await resolveNotSent(fixture.row, fixture.binding.attemptId);
  assert.equal(response.statusCode, 409, response.body);
  const blocked = await storedReview(fixture.row);
  assert.equal(blocked.submission_claim_id, fixture.binding.attemptId);
  assert.equal(blocked.unverified_submission?.resolution, undefined);
  assert.equal((await factsFor(fixture.binding)).some(
    (event) => event.event_kind === 'not_sent_proven',
  ), false);
});

test('managed provider refusal remains an unresolved claimed parent', async () => {
  const fixture = await managedPressedChallengeFixture(
    'initial_submission',
    'managed-provider-refusal',
  );
  const spentAttempt = {
    at: new Date().toISOString(),
    fingerprint: 'provider-refused-code-fingerprint',
    outcome: 'error' as const,
  };
  const spentCode = { ...fixture.review.security_code!, attempts: [spentAttempt] };
  await assertManagedSecurityCodeContinuationBoundaryClear(
    fixture.row,
    fixture.review,
    fixture.binding,
    fixture.continuationFingerprint,
    fixture.submissionAttempt,
    fixture.providerExpiresAt,
    spentCode,
  );
  const rejectedCode = {
    ...spentCode,
    attempts: [{ ...spentAttempt, outcome: 'rejected' as const }],
  };
  const persisted = await recordManagedAuthorizedAttemptUnverified(
    fixture.row,
    fixture.binding,
    {
      message: 'Employer verification was refused',
      attentionReason: 'Check the employer portal and record whether this exact application was received.',
      attentionCategories: ['unverified_submission'],
      securityCode: rejectedCode,
    },
  );
  assert.equal(persisted, true);

  const current = await storedReview(fixture.row);
  assert.equal(current.status, 'needs_attention');
  assert.equal(current.submission_claim_id, fixture.binding.attemptId);
  assert.deepEqual(current.submission_authorization, fixture.review.submission_authorization);
  assert.equal(current.unverified_submission?.resolution, undefined);
  assert.equal(current.security_code?.attempts?.at(-1)?.outcome, 'rejected');
  assert.equal(current.verification?.continuation_resumed, true);
  const events = await factsFor(fixture.binding);
  assert.equal(events.some((event) => event.event_kind === 'not_sent_proven'), false);
  assert.equal(submissionAttemptRetrySafety(events).kind, 'blocked_unverified');
});

test('found false is blocked while the managed callback deadline is live', async () => {
  const fixture = await managedPressedChallengeFixture(
    'initial_submission',
    'managed-live-resolver-block',
  );
  await assertManagedSecurityCodeContinuationBoundaryClear(
    fixture.row,
    fixture.review,
    fixture.binding,
    fixture.continuationFingerprint,
    fixture.submissionAttempt,
    fixture.providerExpiresAt,
    fixture.review.security_code!,
  );
  assert.equal(await recordManagedSecurityCodeContinuationUnverified(
    fixture.row,
    fixture.binding,
    'Managed callback has not returned a durable result',
  ), true);

  const current = await storedReview(fixture.row);
  const authorization = await submissionBoundaryAuthorization(
    fixture.row.user_id,
    fixture.binding.attemptId,
  );
  assert.ok(authorization?.active);
  assert.equal(managedContinuationCallbackMayBeLive(current, authorization), true);
  const response = await resolveNotSent(fixture.row, fixture.binding.attemptId);
  assert.equal(response.statusCode, 409, response.body);
  const unchanged = await storedReview(fixture.row);
  assert.equal(unchanged.submission_claim_id, fixture.binding.attemptId);
  assert.equal(unchanged.unverified_submission?.resolution, undefined);
  assert.equal((await factsFor(fixture.binding)).some(
    (event) => event.event_kind === 'not_sent_proven',
  ), false);
});

test('locked managed confirmation closes the parent exactly once', async () => {
  const fixture = await managedPressedChallengeFixture(
    'initial_submission',
    'managed-locked-confirmation',
  );
  await assertManagedSecurityCodeContinuationBoundaryClear(
    fixture.row,
    fixture.review,
    fixture.binding,
    fixture.continuationFingerprint,
    fixture.submissionAttempt,
    fixture.providerExpiresAt,
    fixture.review.security_code!,
  );
  assert.equal(await recordManagedSecurityCodeContinuationUnverified(
    fixture.row,
    fixture.binding,
    'The first receipt read was uncertain',
  ), true);
  const capturedAt = new Date().toISOString();
  const confirmation = {
    capturedAt,
    verification: {
      status: 'completed' as const,
      runner: 'stratus-managed' as const,
      continuation_fingerprint: fixture.continuationFingerprint,
      continuation_execution_fingerprint: managedContinuationExecutionFingerprint(fixture.submissionAttempt),
      continuation_resumed: true,
    },
    securityCode: fixture.review.security_code!,
    receipt: {
      confirmation_text: 'Application received',
      final_url: PORTAL_URL,
      captured_at: capturedAt,
      source: 'managed_browser' as const,
    },
  };
  const results = await Promise.all([
    recordManagedSubmissionConfirmed(fixture.row, fixture.binding, confirmation),
    recordManagedSubmissionConfirmed(fixture.row, fixture.binding, confirmation),
  ]);
  assert.deepEqual(results, [true, true]);

  const current = await storedReview(fixture.row);
  assert.equal(current.status, 'submitted');
  assert.equal(current.unverified_submission?.resolution, 'sent');
  assert.equal(current.receipt?.confirmation_text, 'Application received');
  const events = await factsFor(fixture.binding);
  assert.equal(events.filter((event) => event.event_kind === 'submission_confirmed').length, 1);
  assert.equal(submissionAttemptRetrySafety(events).kind, 'blocked_confirmed');
});

test('managed confirmation closes before stalled screenshot enrichment passes its boundary deadline', async () => {
  const userId = await createUser('managed-confirmation-before-screenshot');
  const attemptId = randomUUID();
  const attemptedAt = new Date().toISOString();
  const review = reviewForAttempt(attemptId, {
    status: 'needs_attention',
    submission_attempted_at: attemptedAt,
    unverified_submission: {
      at: attemptedAt,
      cause: 'no_confirmation_state',
      portal_url: PORTAL_URL,
    },
  });
  review.unverified_submission!.submission_run_id = review.submission_run_id;
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'managed_browser');
  await appendOpening(binding, 'managed-confirmation-before-screenshot-opening');
  await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    const authorization = await authorizeFinalSubmissionBoundary(binding, {
      executor: tx,
      factKey: 'managed-confirmation-before-screenshot-boundary',
      ttlMs: 250,
    });
    assert.equal(authorization.kind, 'fresh');
  });
  assert.equal((await submissionBoundaryAuthorization(userId, attemptId))?.active, true);

  const capturedAt = new Date().toISOString();
  const receipt = {
    confirmation_text: 'Employer confirmed the exact managed application',
    final_url: PORTAL_URL,
    captured_at: capturedAt,
    source: 'managed_browser' as const,
  };
  const confirmedBeforeScreenshot = await recordManagedSubmissionConfirmed(row, binding, {
    capturedAt,
    verification: { status: 'not_needed' },
    receipt,
  });
  assert.equal(confirmedBeforeScreenshot, true);
  const beforeScreenshot = await storedReview(row);
  assert.equal(beforeScreenshot.status, 'submitted');
  assert.equal(beforeScreenshot.unverified_submission?.resolution, 'sent');
  assert.equal(beforeScreenshot.receipt?.confirmation_text, receipt.confirmation_text);
  assert.equal(beforeScreenshot.receipt?.screenshot_url, undefined);
  assert.equal((await factsFor(binding)).filter(
    (event) => event.event_kind === 'submission_confirmed',
  ).length, 1);

  let releaseScreenshot!: () => void;
  const screenshotStored = new Promise<void>((resolve) => { releaseScreenshot = resolve; });
  const enrichment = screenshotStored.then(() => recordManagedSubmissionConfirmed(row, binding, {
    capturedAt,
    verification: { status: 'not_needed' },
    receipt: {
      ...receipt,
      screenshot_url: 'https://proof.example/managed-confirmed-receipt.png',
    },
  }));
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  assert.equal((await submissionBoundaryAuthorization(userId, attemptId))?.active, false,
    'the receipt upload remains stalled beyond the immutable boundary deadline');

  const negative = await resolveNotSent(row, attemptId);
  assert.equal(negative.statusCode, 409, negative.body);
  const whileStalled = await storedReview(row);
  assert.equal(whileStalled.status, 'submitted');
  assert.equal(whileStalled.submission_claim_id, attemptId);
  assert.equal(whileStalled.receipt?.screenshot_url, undefined);
  assert.equal((await factsFor(binding)).some(
    (event) => event.event_kind === 'not_sent_proven',
  ), false);

  releaseScreenshot();
  assert.equal(await enrichment, true);
  const enriched = await storedReview(row);
  assert.equal(enriched.status, 'submitted');
  assert.equal(
    enriched.receipt?.screenshot_url,
    'https://proof.example/managed-confirmed-receipt.png',
  );
  const finalEvents = await factsFor(binding);
  assert.equal(finalEvents.filter((event) => event.event_kind === 'submission_confirmed').length, 1);
  assert.equal(finalEvents.some((event) => event.event_kind === 'not_sent_proven'), false);
  assert.equal(submissionAttemptRetrySafety(finalEvents).kind, 'blocked_confirmed');
});

test('late managed confirmation closes after an expired pressed attempt refuses found false', async () => {
  const fixture = await managedPressedChallengeFixture(
    'initial_submission',
    'managed-late-confirmation-heal',
    { authorizationTtlMs: 1 },
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const expiredDeadline = new Date(Date.now() - 1_000).toISOString();
  const projected = await recordManagedAuthorizedAttemptUnverified(
    fixture.row,
    fixture.binding,
    {
      message: 'Managed callback expired before its receipt was persisted',
      attentionReason: 'Check the employer portal and record whether this exact application was received.',
      attentionCategories: ['security_code', 'unverified_submission'],
      securityCode: fixture.review.security_code!,
      verification: {
        ...fixture.review.verification!,
        status: 'verification_pending',
        continuation_resumed: true,
        continuation_call_started_at: expiredDeadline,
        continuation_call_deadline_at: expiredDeadline,
      },
    },
  );
  assert.equal(projected, true);
  const expiredAuthorization = await submissionBoundaryAuthorization(
    fixture.row.user_id,
    fixture.binding.attemptId,
  );
  assert.ok(expiredAuthorization && !expiredAuthorization.active);
  assert.equal(
    managedContinuationCallbackMayBeLive(await storedReview(fixture.row), expiredAuthorization),
    false,
  );

  const resolved = await resolveNotSent(fixture.row, fixture.binding.attemptId);
  assert.equal(resolved.statusCode, 409, resolved.body);
  const blockedBeforeConfirmation = await storedReview(fixture.row);
  assert.equal(blockedBeforeConfirmation.status, 'needs_attention');
  assert.equal(blockedBeforeConfirmation.submission_claim_id, fixture.binding.attemptId);
  assert.equal(blockedBeforeConfirmation.unverified_submission?.resolution, undefined);
  assert.equal(submissionAttemptRetrySafety(await factsFor(fixture.binding)).kind, 'blocked_unverified');

  const capturedAt = new Date().toISOString();
  const healed = await recordManagedSubmissionConfirmed(
    fixture.row,
    fixture.binding,
    {
      capturedAt,
      verification: {
        ...blockedBeforeConfirmation.verification!,
        status: 'completed',
        continuation_resumed: true,
      },
      securityCode: {
        ...fixture.review.security_code!,
        attempts: [{
          at: capturedAt,
          fingerprint: 'late-confirmed-code-fingerprint',
          outcome: 'accepted',
        }],
      },
      receipt: {
        confirmation_text: 'Late callback confirmed receipt',
        final_url: PORTAL_URL,
        captured_at: capturedAt,
        source: 'managed_browser',
      },
    },
  );
  assert.equal(healed, true);
  const current = await storedReview(fixture.row);
  assert.equal(current.status, 'submitted');
  assert.equal(current.submitted_at, capturedAt);
  assert.equal(current.unverified_submission?.resolution, 'sent');
  assert.equal(current.unverified_submission?.resolved_at, capturedAt);
  assert.equal(current.receipt?.confirmation_text, 'Late callback confirmed receipt');
  const events = await factsFor(fixture.binding);
  assert.equal(events.filter((event) => event.event_kind === 'not_sent_proven').length, 0);
  assert.equal(events.filter((event) => event.event_kind === 'submission_confirmed').length, 1);
  assert.equal(submissionAttemptRetrySafety(events).kind, 'blocked_confirmed');
});

async function exposeAttendedUrl(
  row: ResumeRow,
  review: ApplicationReviewState,
): Promise<string | null> {
  const reservation = await reserveAttendedManualAttempt(row, review);
  if (reservation.kind !== 'reserved') return null;
  const gate = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-url-exposure',
  });
  if (gate.kind !== 'clear') return null;
  await assertAuthorizationPrecedesCallback(reservation.binding);
  return reservation.review.portal_url ?? null;
}

async function reservedAttendedFixture(
  label: string,
  overrides: Partial<ApplicationReviewState> = {},
  capabilityKind?: AttendedHandoffCapabilityKind,
) {
  const userId = await createUser(label);
  const initialReview = reviewForAttempt(randomUUID(), {
    submission_run_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
    ...overrides,
  });
  const row = await createPacket(userId, initialReview);
  const attendedCapability = capabilityKind
    ? attendedHandoffCapabilityForRow(row, initialReview, capabilityKind)
    : null;
  if (capabilityKind) assert.ok(attendedCapability, `Expected a ${capabilityKind} capability`);
  const reservation = await reserveAttendedManualAttempt(row, initialReview, {
    ...(attendedCapability ? { attendedHandoffCapability: attendedCapability.capability } : {}),
  });
  assert.equal(reservation.kind, 'reserved');
  if (reservation.kind !== 'reserved') throw new Error('Expected attended reservation');
  return { row, reservation, attendedCapability };
}

async function manualCapabilityFixture(label: string) {
  const userId = await createUser(label);
  const initialReview = reviewForAttempt(randomUUID(), {
    portal_url: MANUAL_POSTING_URL,
    extension_handoff_url: MANUAL_HANDOFF_URL,
    ats_name: 'smartrecruiters',
    status: 'needs_attention',
    attention_reason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
    attention_categories: ['unknown'],
    submission_run_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
  });
  const unboundRow = await createPacket(userId, initialReview);
  const review: ApplicationReviewState = {
    ...initialReview,
    extension_handoff_binding: createDashboardHandoffBinding({
      applicationId: unboundRow.id,
      userId,
      frozenUrl: MANUAL_POSTING_URL,
      frozenHandoffUrl: MANUAL_HANDOFF_URL,
      frozenAtsName: 'smartrecruiters',
      attentionReason: MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
      attentionCategories: ['unknown'],
    }),
  };
  const [row] = await backendDb.update(schema.generated_resumes)
    .set({ spec: { summary: 'Exact boundary packet', _review: review } })
    .where(eq(schema.generated_resumes.id, unboundRow.id))
    .returning();
  assert.ok(row);
  const attendedCapability = attendedHandoffCapabilityForRow(row, review, 'manual_handoff');
  assert.ok(attendedCapability);
  return { row, review, attendedCapability };
}

async function reservedManualCapabilityFixture(label: string) {
  const { row, review, attendedCapability } = await manualCapabilityFixture(label);
  const reservation = await reserveAttendedManualAttempt(row, review, {
    attendedHandoffCapability: attendedCapability.capability,
  });
  assert.equal(reservation.kind, 'reserved');
  if (reservation.kind !== 'reserved') throw new Error('Expected manual attended reservation');
  return { row, reservation, attendedCapability };
}

test('an exact attended authorization tuple re-delivers one immutable capability', async () => {
  const { reservation } = await reservedAttendedFixture('attended-exact-replay');
  const initial = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-exact-replay-initial',
  });
  assert.equal(initial.kind, 'clear');
  if (initial.kind !== 'clear') throw new Error('Expected fresh attended authorization');
  assert.equal(initial.replay, false);
  const before = await factsFor(reservation.binding);

  const replay = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-exact-replay-repeat',
    replay: {
      attemptId: reservation.binding.attemptId,
      leaseId: initial.authorization.leaseId,
      activationId: initial.authorization.activationId,
    },
  });
  assert.equal(replay.kind, 'clear');
  if (replay.kind !== 'clear') throw new Error('Expected exact attended replay');
  assert.equal(replay.replay, true);
  assert.deepEqual({
    leaseId: replay.authorization.leaseId,
    attemptId: replay.authorization.attemptId,
    activationId: replay.authorization.activationId,
    authorizedAt: replay.authorization.authorizedAt,
    expiresAt: replay.authorization.expiresAt,
  }, {
    leaseId: initial.authorization.leaseId,
    attemptId: initial.authorization.attemptId,
    activationId: initial.authorization.activationId,
    authorizedAt: initial.authorization.authorizedAt,
    expiresAt: initial.authorization.expiresAt,
  }, 'replay returns the original immutable authorization rather than renewing it');
  const after = await factsFor(reservation.binding);
  assert.deepEqual(after.map((event) => event.event_id), before.map((event) => event.event_id));
  assert.equal(after.filter((event) => event.event_kind === 'boundary_authorized').length, 1);
});

test('a replay tuple cannot authorize an opening-only attended attempt', async () => {
  const { reservation } = await reservedAttendedFixture('attended-opening-replay');
  const rejected = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-opening-replay-rejected',
    replay: {
      attemptId: reservation.binding.attemptId,
      leaseId: randomUUID(),
      activationId: randomUUID(),
    },
  });
  assert.equal(rejected.kind, 'already_authorized');
  const afterRejected = await factsFor(reservation.binding);
  assert.equal(afterRejected.filter((event) => event.event_kind === 'attempt_opened').length, 1);
  assert.equal(afterRejected.some((event) => event.event_kind === 'boundary_authorized'), false);

  const initial = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-opening-replay-initial',
  });
  assert.equal(initial.kind, 'clear', 'a rejected guessed replay must not consume the initial click');
});

test('a stale complete replay tuple cannot reserve a fresh opening', async () => {
  const userId = await createUser('attended-stale-replay-reservation');
  const review = reviewForAttempt(randomUUID(), {
    submission_run_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
  });
  const row = await createPacket(userId, review);
  const reservation = await reserveAttendedManualAttempt(row, review, {
    replayAttemptId: randomUUID(),
  });
  assert.equal(reservation.kind, 'replay_mismatch');
  assert.equal((await submissionAttemptEventsForPacket(userId, row.id)).length, 0);
  assert.equal((await storedReview(row)).submission_claim_id, undefined);
});

test('any mismatched replay coordinate fails closed without another ledger fact', async () => {
  const { reservation } = await reservedAttendedFixture('attended-mismatched-replay');
  const initial = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-mismatched-replay-initial',
  });
  assert.equal(initial.kind, 'clear');
  if (initial.kind !== 'clear') throw new Error('Expected fresh attended authorization');
  const before = await factsFor(reservation.binding);
  const mismatches = [
    {
      attemptId: randomUUID(),
      leaseId: initial.authorization.leaseId,
      activationId: initial.authorization.activationId,
    },
    {
      attemptId: reservation.binding.attemptId,
      leaseId: randomUUID(),
      activationId: initial.authorization.activationId,
    },
    {
      attemptId: reservation.binding.attemptId,
      leaseId: initial.authorization.leaseId,
      activationId: randomUUID(),
    },
  ];
  for (const replay of mismatches) {
    const rejected = await finalApplicationBoundaryGate({
      row: reservation.row,
      binding: reservation.binding,
      factKey: 'attended-mismatched-replay-rejected',
      replay,
    });
    assert.equal(rejected.kind, 'already_authorized');
  }
  const after = await factsFor(reservation.binding);
  assert.deepEqual(after.map((event) => event.event_id), before.map((event) => event.event_id));
});

test('concurrent exact attended replays converge without renewing the boundary', async () => {
  const { reservation } = await reservedAttendedFixture('attended-concurrent-replay');
  const initial = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-concurrent-replay-initial',
  });
  assert.equal(initial.kind, 'clear');
  if (initial.kind !== 'clear') throw new Error('Expected fresh attended authorization');
  const exactReplay = {
    attemptId: reservation.binding.attemptId,
    leaseId: initial.authorization.leaseId,
    activationId: initial.authorization.activationId,
  };
  const results = await Promise.all([
    finalApplicationBoundaryGate({
      row: reservation.row,
      binding: reservation.binding,
      factKey: 'attended-concurrent-replay-a',
      replay: exactReplay,
    }),
    finalApplicationBoundaryGate({
      row: reservation.row,
      binding: reservation.binding,
      factKey: 'attended-concurrent-replay-b',
      replay: exactReplay,
    }),
  ]);
  assert.equal(results.every((result) => result.kind === 'clear' && result.replay), true);
  const events = await factsFor(reservation.binding);
  assert.equal(events.filter((event) => event.event_kind === 'boundary_authorized').length, 1);
});

test('initial manual state exposes one URL-free capability without creating an attempt', async () => {
  const { row, attendedCapability } = await manualCapabilityFixture(
    'attended-initial-manual-capability',
  );
  const beforeFacts = await submissionAttemptEventsForPacket(row.user_id, row.id);
  assert.deepEqual(beforeFacts, []);

  const passive = await attendedApp.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
  });
  assert.equal(passive.statusCode, 200, passive.body);
  const passiveBody = passive.json();
  assert.deepEqual(passiveBody.attended_handoff_capability, attendedCapability.capability);
  assert.equal(passiveBody.attended_handoff_capability.kind, 'manual_handoff');
  assert.equal(passiveBody.manual_handoff_resume_available, false);
  assert.equal('manual_attempt_id' in passiveBody, false);
  assert.equal('boundary_lease_id' in passiveBody, false);
  assert.equal('boundary_activation_id' in passiveBody, false);
  assertPassiveResponseHidesEmployerNavigation(passiveBody);
  assert.equal(JSON.stringify(passiveBody).includes(MANUAL_POSTING_URL), false);
  assert.equal(JSON.stringify(passiveBody).includes(MANUAL_HANDOFF_URL), false);
  assert.deepEqual(await submissionAttemptEventsForPacket(row.user_id, row.id), [],
    'passive capability derivation must remain ledger-read-only');

  const started = await attendedApp.inject({
    method: 'POST',
    url: `/applications/${row.id}/submission/manual-handoff`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
    payload: {},
  });
  assert.equal(started.statusCode, 200, started.body);
  const startedBody = started.json();
  assert.deepEqual(startedBody.attended_handoff_capability, passiveBody.attended_handoff_capability);
  assert.equal(startedBody.manual_handoff.url, MANUAL_HANDOFF_URL);
  assert.match(startedBody.manual_attempt_id, /^[0-9a-f-]{36}$/);
  assert.match(startedBody.boundary_lease_id, /^[0-9a-f-]{36}$/);
  assert.match(startedBody.boundary_activation_id, /^[0-9a-f-]{36}$/);
});

test('a changed manual URL projection changes passive identity and invalidates the old authorization', async () => {
  const { row } = await manualCapabilityFixture('attended-manual-capability-drift');
  const initialPassive = await attendedApp.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
  });
  assert.equal(initialPassive.statusCode, 200, initialPassive.body);
  const oldCapability = initialPassive.json().attended_handoff_capability;
  const started = await attendedApp.inject({
    method: 'POST',
    url: `/applications/${row.id}/submission/manual-handoff`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
    payload: {},
  });
  assert.equal(started.statusCode, 200, started.body);
  const oldAuthorization = started.json();

  const [stored] = await backendDb.select().from(schema.generated_resumes)
    .where(eq(schema.generated_resumes.id, row.id)).limit(1);
  assert.ok(stored);
  const current = (stored.spec as { _review: ApplicationReviewState })._review;
  const changedHandoffUrl = 'https://jobs.smartrecruiters.com/oneclick-ui/company/Example/publication/123e4567-e89b-12d3-a456-426614174001';
  const changedReview: ApplicationReviewState = {
    ...current,
    extension_handoff_url: changedHandoffUrl,
    extension_handoff_binding: createDashboardHandoffBinding({
      applicationId: stored.id,
      userId: stored.user_id,
      frozenUrl: current.portal_url,
      frozenHandoffUrl: changedHandoffUrl,
      frozenAtsName: current.ats_name,
      attentionReason: current.attention_reason,
      attentionCategories: current.attention_categories,
    }),
  };
  await backendDb.update(schema.generated_resumes).set({
    spec: { ...(stored.spec as object), _review: changedReview },
  }).where(eq(schema.generated_resumes.id, row.id));

  const changedPassive = await attendedApp.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
  });
  assert.equal(changedPassive.statusCode, 200, changedPassive.body);
  const changedBody = changedPassive.json();
  assert.equal(changedBody.attended_handoff_capability.kind, 'manual_handoff');
  assert.notEqual(changedBody.attended_handoff_capability.capability_sha256, oldCapability.capability_sha256);
  assert.notEqual(changedBody.attended_handoff_capability.url_sha256, oldCapability.url_sha256);
  assert.equal(changedBody.manual_handoff_resume_available, false);
  assert.equal('manual_attempt_id' in changedBody, false);
  assert.equal('boundary_lease_id' in changedBody, false);
  assert.equal('boundary_activation_id' in changedBody, false);
  assertPassiveResponseHidesEmployerNavigation(changedBody);
  assert.equal(JSON.stringify(changedBody).includes(changedHandoffUrl), false);

  const staleReplay = await attendedApp.inject({
    method: 'POST',
    url: `/applications/${row.id}/submission/manual-handoff`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
    payload: {
      attempt_id: oldAuthorization.manual_attempt_id,
      boundary_lease_id: oldAuthorization.boundary_lease_id,
      boundary_activation_id: oldAuthorization.boundary_activation_id,
    },
  });
  assert.equal(staleReplay.statusCode, 409, staleReplay.body);
  assert.equal('manual_handoff' in staleReplay.json(), false);
  assert.equal(JSON.stringify(staleReplay.json()).includes(changedHandoffUrl), false);
});

test('initial document self-submit GET and POST share one exact capability', async () => {
  const userId = await createUser('attended-initial-self-submit-capability');
  const review = reviewForAttempt(randomUUID(), {
    status: 'ready_for_final_approval',
    attention_reason: 'The employer requires an official transcript sent outside this form.',
    attention_categories: ['required_document'],
    required_documents: [{
      label: 'Official transcript',
      kind: 'transcript',
      official_requested: true,
    }],
    transcript_supported: false,
    submission_run_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
  });
  const row = await createPacket(userId, review);
  const expected = attendedHandoffCapabilityForRow(row, review, 'self_submit');
  assert.ok(expected);

  const passive = await app.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(userId)}` },
  });
  assert.equal(passive.statusCode, 200, passive.body);
  const passiveBody = passive.json();
  assert.deepEqual(passiveBody.attended_handoff_capability, expected.capability);
  assert.equal(passiveBody.attended_handoff_capability.kind, 'self_submit');
  assert.equal(passiveBody.manual_handoff_resume_available, false);
  assert.equal('manual_attempt_id' in passiveBody, false);
  assert.equal('boundary_lease_id' in passiveBody, false);
  assert.equal('boundary_activation_id' in passiveBody, false);
  assertPassiveResponseHidesEmployerNavigation(passiveBody);
  assert.deepEqual(await submissionAttemptEventsForPacket(userId, row.id), [],
    'passive self-submit capability derivation must not append an attempt fact');

  const started = await app.inject({
    method: 'POST',
    url: `/applications/${row.id}/submission/self-submit-start`,
    headers: { authorization: `Bearer ${await authToken(userId)}` },
    payload: {},
  });
  assert.equal(started.statusCode, 200, started.body);
  const startedBody = started.json();
  assert.deepEqual(startedBody.attended_handoff_capability, passiveBody.attended_handoff_capability);
  assert.equal(startedBody.portal_url, PORTAL_URL);
  assert.match(startedBody.manual_attempt_id, /^[0-9a-f-]{36}$/);
  assert.match(startedBody.boundary_lease_id, /^[0-9a-f-]{36}$/);
  assert.match(startedBody.boundary_activation_id, /^[0-9a-f-]{36}$/);
});

test('canonicalized legacy self-submit URL keeps exact GET-to-POST capability parity', async () => {
  const legacyUrl = 'https://jobs.smartrecruiters.com/Lumina1/744000001027275-software-engineer?trid=tracking#share';
  const canonicalUrl = 'https://jobs.smartrecruiters.com/Lumina1/744000001027275-software-engineer';
  const userId = await createUser('attended-canonicalized-self-submit-capability');
  const review = reviewForAttempt(randomUUID(), {
    portal_url: legacyUrl,
    ats_name: 'smartrecruiters',
    status: 'ready_for_final_approval',
    required_documents: [{
      label: 'Official transcript',
      kind: 'transcript',
      official_requested: true,
    }],
    transcript_supported: false,
    submission_run_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
  });
  const row = await createPacket(userId, review);

  const passive = await app.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(userId)}` },
  });
  assert.equal(passive.statusCode, 200, passive.body);
  const passiveCapability = passive.json().attended_handoff_capability;
  assert.equal(passiveCapability.kind, 'self_submit');
  assert.equal(JSON.stringify(passive.json()).includes(legacyUrl), false);
  assert.equal(JSON.stringify(passive.json()).includes(canonicalUrl), false);
  assert.deepEqual(await submissionAttemptEventsForPacket(userId, row.id), []);

  const started = await app.inject({
    method: 'POST',
    url: `/applications/${row.id}/submission/self-submit-start`,
    headers: { authorization: `Bearer ${await authToken(userId)}` },
    payload: {},
  });
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().portal_url, canonicalUrl);
  assert.deepEqual(started.json().attended_handoff_capability, passiveCapability);
});

test('monitored portal repair keeps document self-submit GET and POST on one capability', async () => {
  const userId = await createUser('attended-monitored-self-submit-capability');
  const company = `Monitored Company ${randomUUID()}`;
  const role = 'Monitored Systems Engineer';
  const description = 'Build reliable monitored systems and document their operational guarantees.';
  const [source] = await backendDb.insert(schema.career_page_sources).values({
    company_name: company,
    ats_name: 'smartrecruiters',
    board_token: `monitored-${randomUUID()}`,
    career_url: 'https://jobs.smartrecruiters.com/Example',
    enabled: true,
  }).returning();
  const [job] = await backendDb.insert(schema.monitored_jobs).values({
    source_id: source.id,
    external_id: `monitored-${randomUUID()}`,
    company_name: company,
    title: role,
    description,
    apply_url: MANUAL_POSTING_URL,
    posting_url: MANUAL_POSTING_URL,
    is_active: true,
  }).returning();
  const review = reviewForAttempt(randomUUID(), {
    jd_text: description,
    role,
    portal_url: undefined,
    portal_supported: false,
    ats_name: undefined,
    status: 'ready_for_final_approval',
    required_documents: [{
      label: 'Official transcript',
      kind: 'transcript',
      official_requested: true,
    }],
    transcript_supported: false,
    submission_run_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
  });
  const [row] = await backendDb.insert(schema.generated_resumes).values({
    id: randomUUID(),
    user_id: userId,
    job_context: {
      job_id: job.id,
      company,
      role,
      jd_hash: monitoredDescriptionHash(description),
    },
    spec: { summary: 'Monitored portal packet', _review: review },
    resume_object_key: `users/${userId}/resumes/${randomUUID()}.pdf`,
  }).returning();

  const passive = await app.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(userId)}` },
  });
  assert.equal(passive.statusCode, 200, passive.body);
  const passiveCapability = passive.json().attended_handoff_capability;
  assert.equal(passiveCapability.kind, 'self_submit');
  assert.equal(JSON.stringify(passive.json()).includes(MANUAL_POSTING_URL), false);
  assert.deepEqual(await submissionAttemptEventsForPacket(userId, row.id), []);

  const started = await app.inject({
    method: 'POST',
    url: `/applications/${row.id}/submission/self-submit-start`,
    headers: { authorization: `Bearer ${await authToken(userId)}` },
    payload: {},
  });
  assert.equal(started.statusCode, 200, started.body);
  assert.equal(started.json().portal_url, MANUAL_POSTING_URL);
  assert.deepEqual(started.json().attended_handoff_capability, passiveCapability);
});

test('passive submission recovery returns only the exact resumable authorization metadata', async () => {
  const { row, reservation, attendedCapability } = await reservedAttendedFixture(
    'attended-passive-recovery',
    {
      ...passiveEmployerNavigationLeaks(),
      unverified_submission: undefined,
    },
    'self_submit',
  );
  assert.ok(attendedCapability);
  const beforeAuthorization = await app.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
  });
  assert.equal(beforeAuthorization.statusCode, 200, beforeAuthorization.body);
  assert.equal(beforeAuthorization.json().manual_handoff_resume_available, false);
  assert.equal('manual_attempt_id' in beforeAuthorization.json(), false);
  assert.equal('boundary_lease_id' in beforeAuthorization.json(), false);
  assert.equal('boundary_activation_id' in beforeAuthorization.json(), false);
  assertPassiveResponseHidesEmployerNavigation(beforeAuthorization.json());

  const initial = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-passive-recovery-initial',
    attendedHandoffCapability: attendedCapability.capability,
  });
  assert.equal(initial.kind, 'clear');
  if (initial.kind !== 'clear') throw new Error('Expected fresh attended authorization');
  const recovered = await app.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
  });
  assert.equal(recovered.statusCode, 200, recovered.body);
  assert.equal(recovered.json().manual_handoff_resume_available, true);
  assert.equal(recovered.json().manual_attempt_id, reservation.binding.attemptId);
  assert.equal(recovered.json().boundary_lease_id, initial.authorization.leaseId);
  assert.equal(recovered.json().boundary_activation_id, initial.authorization.activationId);
  assert.deepEqual(recovered.json().attended_handoff_capability, attendedCapability.capability);
  assert.doesNotMatch(JSON.stringify(recovered.json().attended_handoff_capability), /apply\.workable\.com/);
  assert.equal('manual_handoff' in recovered.json(), false);
  assert.equal('portal_url' in recovered.json(), false);
  assertPassiveResponseHidesEmployerNavigation(recovered.json());
});

test('self-submit finalization refuses a terminal fact that lands after the first boundary gate', async () => {
  const { reservation, attendedCapability } = await reservedAttendedFixture(
    'self-submit-finalization-interleaving',
    {},
    'self_submit',
  );
  assert.ok(attendedCapability);
  const gate = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'self-submit-finalization-interleaving-gate',
    attendedHandoffCapability: attendedCapability.capability,
  });
  assert.equal(gate.kind, 'clear');
  if (gate.kind !== 'clear') throw new Error('Expected self-submit boundary authorization');
  await appendSubmissionAttemptEvent({
    ...reservation.binding,
    eventId: submissionAttemptEventId(
      reservation.binding.attemptId,
      'press_observed',
      'self-submit-finalization-interleaving-press',
    ),
    eventKind: 'press_observed',
    evidenceCode: 'test_self_submit_terminal_interleaving',
  });

  const finalized = await finalizeAttendedHandoffCapability({
    row: reservation.row,
    binding: reservation.binding,
    authorization: gate.authorization,
    attendedHandoffCapability: attendedCapability.capability,
  });
  assert.equal(finalized.kind, 'blocked');
  assert.equal('url' in finalized, false);
  assert.equal(finalized.retrySafety.kind, 'blocked_unverified');
  assert.equal(
    finalized.retrySafety.kind === 'blocked_unverified' && finalized.retrySafety.reason,
    'pressed',
  );
});

test('manual-handoff finalization refuses a terminal fact that lands after the first boundary gate', async () => {
  const { reservation, attendedCapability } = await reservedManualCapabilityFixture(
    'manual-finalization-interleaving',
  );
  const gate = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'manual-finalization-interleaving-gate',
    attendedHandoffCapability: attendedCapability.capability,
  });
  assert.equal(gate.kind, 'clear');
  if (gate.kind !== 'clear') throw new Error('Expected manual boundary authorization');
  await appendSubmissionAttemptEvent({
    ...reservation.binding,
    eventId: submissionAttemptEventId(
      reservation.binding.attemptId,
      'submission_confirmed',
      'manual-finalization-interleaving-confirmed',
    ),
    eventKind: 'submission_confirmed',
    evidenceCode: 'test_manual_terminal_interleaving',
  });

  const finalized = await finalizeAttendedHandoffCapability({
    row: reservation.row,
    binding: reservation.binding,
    authorization: gate.authorization,
    attendedHandoffCapability: attendedCapability.capability,
  });
  assert.equal(finalized.kind, 'blocked');
  assert.equal('url' in finalized, false);
  assert.equal(finalized.retrySafety.kind, 'blocked_confirmed');
});

test('concurrent exact replay finalizes one immutable active capability without appending facts', async () => {
  const { reservation, attendedCapability } = await reservedAttendedFixture(
    'attended-capability-concurrent-finalization',
    {},
    'self_submit',
  );
  assert.ok(attendedCapability);
  const initial = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-capability-concurrent-initial',
    attendedHandoffCapability: attendedCapability.capability,
  });
  assert.equal(initial.kind, 'clear');
  if (initial.kind !== 'clear') throw new Error('Expected attended boundary authorization');
  const replay = {
    attemptId: reservation.binding.attemptId,
    leaseId: initial.authorization.leaseId,
    activationId: initial.authorization.activationId,
  };
  const replayGates = await Promise.all([
    finalApplicationBoundaryGate({
      row: reservation.row,
      binding: reservation.binding,
      factKey: 'attended-capability-concurrent-replay-a',
      replay,
      attendedHandoffCapability: attendedCapability.capability,
    }),
    finalApplicationBoundaryGate({
      row: reservation.row,
      binding: reservation.binding,
      factKey: 'attended-capability-concurrent-replay-b',
      replay,
      attendedHandoffCapability: attendedCapability.capability,
    }),
  ]);
  assert.equal(replayGates.every((result) => result.kind === 'clear' && result.replay), true);
  const finalized = await Promise.all(replayGates.map(async (gate) => {
    if (gate.kind !== 'clear') throw new Error('Expected exact replay authorization');
    return finalizeAttendedHandoffCapability({
      row: reservation.row,
      binding: reservation.binding,
      authorization: gate.authorization,
      attendedHandoffCapability: attendedCapability.capability,
    });
  }));
  assert.equal(finalized.every((result) => result.kind === 'clear'), true);
  assert.equal(finalized.every((result) => result.kind !== 'clear'
    || result.url === attendedCapability.url), true);
  assert.equal(finalized.every((result) => result.kind !== 'clear'
    || JSON.stringify(result.attendedHandoffCapability) === JSON.stringify(attendedCapability.capability)), true);
  const events = await factsFor(reservation.binding);
  assert.deepEqual(events.map((event) => event.event_kind), ['attempt_opened', 'boundary_authorized']);
});

test('both attended start routes reject a partial replay tuple before reserving anything', async () => {
  const userId = await createUser('attended-partial-replay');
  const review = reviewForAttempt(randomUUID(), {
    submission_run_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
  });
  const row = await createPacket(userId, review);
  for (const route of ['manual-handoff', 'self-submit-start']) {
    const response = await app.inject({
      method: 'POST',
      url: `/applications/${row.id}/submission/${route}`,
      headers: { authorization: `Bearer ${await authToken(userId)}` },
      payload: { attempt_id: randomUUID() },
    });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().code, 'MANUAL_HANDOFF_REPLAY_INVALID');
    assert.equal('manual_handoff' in response.json(), false);
    assert.equal('portal_url' in response.json(), false);
  }
  assert.equal((await submissionAttemptEventsForPacket(userId, row.id)).length, 0);
});

test('sequential attended handoff calls expose the employer URL exactly once', async () => {
  const userId = await createUser('attended-sequential');
  const initialReview = reviewForAttempt(randomUUID(), {
    submission_run_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
  });
  const row = await createPacket(userId, initialReview);

  const first = await exposeAttendedUrl(row, initialReview);
  const current = await storedReview(row);
  const second = await exposeAttendedUrl(
    { ...row, spec: { ...(row.spec as object), _review: current } },
    current,
  );

  assert.equal(first, PORTAL_URL);
  assert.equal(second, null, 'replaying an authorized attempt must not disclose the URL again');
});

test('concurrent attended handoff calls expose the employer URL exactly once', async () => {
  const userId = await createUser('attended-concurrent');
  const initialReview = reviewForAttempt(randomUUID(), {
    submission_run_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
  });
  const row = await createPacket(userId, initialReview);

  const results = await Promise.all([
    exposeAttendedUrl(row, initialReview),
    exposeAttendedUrl(row, initialReview),
  ]);
  assert.equal(results.filter((value) => value === PORTAL_URL).length, 1);
  assert.equal(results.filter((value) => value === null).length, 1);
});

async function authorizeWithShortLease(binding: SubmissionAttemptBinding): Promise<void> {
  const result = await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, binding.userId);
    return authorizeFinalSubmissionBoundary(binding, {
      executor: tx,
      factKey: 'short-lived-attended-authorization',
      evidenceCode: 'test_attended_boundary_authorized',
      ttlMs: 1,
    });
  });
  assert.equal(result.kind, 'fresh');
}

test('an expired attended authorization refuses exact replay without changing the ledger', async () => {
  const userId = await createUser('attended-expired-replay');
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, passiveEmployerNavigationLeaks());
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'attended_handoff', 'manual_submission');
  const attendedCapability = attendedHandoffCapabilityForRow(row, review, 'self_submit');
  assert.ok(attendedCapability);
  await appendOpening(binding, 'attended-expired-replay-opening', attendedCapability.capability);
  await authorizeWithShortLease(binding);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const authorization = await submissionBoundaryAuthorization(userId, attemptId);
  assert.ok(authorization);
  assert.equal(authorization.active, false);
  const before = await factsFor(binding);

  const replay = await finalApplicationBoundaryGate({
    row,
    binding,
    factKey: 'attended-expired-exact-replay',
    replay: {
      attemptId,
      leaseId: authorization.leaseId,
      activationId: authorization.activationId,
    },
  });
  assert.equal(replay.kind, 'already_authorized');
  const after = await factsFor(binding);
  assert.deepEqual(after.map((event) => event.event_id), before.map((event) => event.event_id));
  assert.equal(after.filter((event) => event.event_kind === 'boundary_authorized').length, 1);
  const passive = await app.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(row.user_id)}` },
  });
  assert.equal(passive.statusCode, 200, passive.body);
  assert.equal(passive.json().manual_handoff_resume_available, false);
  assert.equal(passive.json().manual_attempt_id, attemptId,
    'positive applicant outcome controls retain the exact attempt identity after lease expiry');
  assert.equal('boundary_lease_id' in passive.json(), false);
  assert.equal('boundary_activation_id' in passive.json(), false);
  assert.deepEqual(passive.json().attended_handoff_capability, attendedCapability.capability);
  assertPassiveResponseHidesEmployerNavigation(passive.json());
});

test('a terminal attended fact disables exact re-delivery', async () => {
  const { reservation } = await reservedAttendedFixture('attended-terminal-replay');
  const initial = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-terminal-replay-initial',
  });
  assert.equal(initial.kind, 'clear');
  if (initial.kind !== 'clear') throw new Error('Expected fresh attended authorization');
  await appendSubmissionAttemptEvent({
    ...reservation.binding,
    eventId: submissionAttemptEventId(
      reservation.binding.attemptId,
      'press_observed',
      'attended-terminal-replay-press',
    ),
    eventKind: 'press_observed',
    evidenceCode: 'test_attended_terminal_replay_press',
  });

  const replay = await finalApplicationBoundaryGate({
    row: reservation.row,
    binding: reservation.binding,
    factKey: 'attended-terminal-replay-rejected',
    replay: {
      attemptId: reservation.binding.attemptId,
      leaseId: initial.authorization.leaseId,
      activationId: initial.authorization.activationId,
    },
  });
  assert.equal(replay.kind, 'already_authorized');
  const events = await factsFor(reservation.binding);
  assert.equal(events.filter((event) => event.event_kind === 'boundary_authorized').length, 1);
  assert.equal(events.filter((event) => event.event_kind === 'press_observed').length, 1);
});

test('a terminal passive submission read keeps receipt facts but withholds every employer URL', async () => {
  const userId = await createUser('attended-terminal-passive-secrecy');
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, {
    ...passiveEmployerNavigationLeaks(),
    status: 'submitted',
    submitted_at: RESERVED_AT,
    receipt: {
      confirmation_text: 'Application received',
      final_url: EMPLOYER_RECEIPT_URL,
      screenshot_url: 'https://proof.example/receipt.png',
      captured_at: RESERVED_AT,
      source: 'attended_handoff',
    },
  });
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'attended_handoff', 'manual_submission');
  await appendOpening(binding, 'attended-terminal-passive-opening');
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'submission_confirmed', 'attended-terminal-passive-confirmed'),
    eventKind: 'submission_confirmed',
    evidenceCode: 'test_attended_terminal_passive_confirmed',
  });

  const passive = await app.inject({
    method: 'GET',
    url: `/applications/${row.id}/submission`,
    headers: { authorization: `Bearer ${await authToken(userId)}` },
  });
  assert.equal(passive.statusCode, 200, passive.body);
  const body = passive.json();
  assert.equal(body.review.status, 'submitted');
  assert.equal(body.retry_safety.kind, 'blocked_confirmed');
  assert.equal(body.manual_handoff_resume_available, false);
  assert.equal('manual_attempt_id' in body, false);
  assert.equal(body.review.receipt.screenshot_url, 'https://proof.example/receipt.png');
  assertPassiveResponseHidesEmployerNavigation(body);
});

test('attended clear refuses an active URL lease and retains the exact claim', async () => {
  const userId = await createUser('attended-active-clear');
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, { unverified_submission: undefined });
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'attended_handoff', 'manual_submission');
  await appendOpening(binding, 'attended-active-clear-opening');
  await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    const authorization = await authorizeFinalSubmissionBoundary(binding, {
      executor: tx,
      factKey: 'attended-active-clear-boundary',
    });
    assert.equal(authorization.kind, 'fresh');
  });

  const completion = await completeAttendedHandoffNotSent(row, userId, attemptId);
  assert.equal(completion.kind, 'active_boundary');
  assert.equal((await storedReview(row)).submission_claim_id, attemptId);
  assert.equal((await factsFor(binding)).some((event) => event.event_kind === 'not_sent_proven'), false);
});

test('expired attended authorization keeps negative resolution closed and accepts a late positive confirmation', async () => {
  const userId = await createUser('attended-expired-clear');
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, { unverified_submission: undefined });
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'attended_handoff', 'manual_submission');
  await appendOpening(binding, 'attended-expired-clear-opening');
  await authorizeWithShortLease(binding);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  const genericResolution = await resolveNotSent(row, attemptId);
  assert.equal(genericResolution.statusCode, 409,
    'generic unverified resolution stays conservatively blocked for attended URL capability');
  const completion = await completeAttendedHandoffNotSent(row, userId, attemptId);
  assert.equal(completion.kind, 'boundary_risk');
  const retained = await storedReview(row);
  assert.equal(retained.submission_claim_id, attemptId,
    'boundary expiry must not release the duplicate lock');
  const reexposed = await exposeAttendedUrl(
    { ...row, spec: { ...(row.spec as object), _review: retained } },
    retained,
  );
  assert.equal(reexposed, null, 'the expired authorization cannot reserve or expose another attempt');
  const heldEvents = await factsFor(binding);
  assert.equal(heldEvents.filter((event) => event.event_kind === 'attempt_opened').length, 1);
  assert.equal(heldEvents.filter((event) => event.event_kind === 'boundary_authorized').length, 1);
  assert.equal(heldEvents.some((event) => event.event_kind === 'not_sent_proven'), false);
  const heldSafety = submissionAttemptRetrySafety(heldEvents);
  assert.equal(heldSafety.kind, 'blocked_unverified');
  assert.equal(heldSafety.kind === 'blocked_unverified' && heldSafety.reason, 'boundary_authorized');

  const confirmation = await resolveFound(row, attemptId);
  assert.equal(confirmation.statusCode, 200, confirmation.body);
  assert.equal(confirmation.json().retry_safety.kind, 'blocked_confirmed');
  const confirmed = await storedReview(row);
  assert.equal(confirmed.status, 'submitted');
  assert.equal(confirmed.submission_claim_id, attemptId);
  const finalEvents = await factsFor(binding);
  assert.equal(finalEvents.some((event) => event.event_kind === 'not_sent_proven'), false);
  assert.equal(finalEvents.filter((event) => event.event_kind === 'submission_confirmed').length, 1,
    'a late positive confirmation remains admissible for the exact retained attempt');
});

for (const terminalKind of ['press_observed', 'submission_confirmed'] as const) {
  test(`expired attended clear refuses immutable ${terminalKind} risk`, async () => {
    const userId = await createUser(`attended-risk-${terminalKind}`);
    const attemptId = randomUUID();
    const review = reviewForAttempt(attemptId, { unverified_submission: undefined });
    const row = await createPacket(userId, review);
    const binding = attemptBinding(row, review, attemptId, 'attended_handoff', 'manual_submission');
    await appendOpening(binding, `${terminalKind}-opening`);
    await authorizeWithShortLease(binding);
    await appendSubmissionAttemptEvent({
      ...binding,
      eventId: submissionAttemptEventId(attemptId, terminalKind, `attended-${terminalKind}`),
      eventKind: terminalKind,
      evidenceCode: `test_attended_${terminalKind}`,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const completion = await completeAttendedHandoffNotSent(row, userId, attemptId);
    assert.equal(completion.kind, 'boundary_risk');
    assert.equal((await storedReview(row)).submission_claim_id, attemptId);
    assert.equal((await factsFor(binding)).some((event) => event.event_kind === 'not_sent_proven'), false);
  });
}

test('an expired direct-browser authorization permanently vetoes applicant not-sent retry B', async () => {
  const userId = await createUser('expired-applicant-recovery');
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, { unverified_submission: undefined });
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'direct_browser');
  await appendOpening(binding, 'expired-applicant-recovery-opening');
  await authorizeWithShortLease(binding);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  const response = await resolveNotSent(row, attemptId);
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().retry_safety.kind, 'blocked_unverified');
  assert.equal(response.json().retry_safety.reason, 'boundary_authorized');
  const events = await factsFor(binding);
  assert.equal(events.some((event) => event.event_kind === 'press_observed'), false);
  assert.equal(events.some((event) => event.event_kind === 'submission_confirmed'), false);
  assert.equal(events.some((event) => event.event_kind === 'not_sent_proven'), false);
});

test('applicant found true preserves confirmation even while boundary authorization is active', async () => {
  const userId = await createUser('active-applicant-confirmation');
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, { unverified_submission: undefined });
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'direct_browser');
  await appendOpening(binding, 'active-applicant-confirmation-opening');
  await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    const authorization = await authorizeFinalSubmissionBoundary(binding, {
      executor: tx,
      factKey: 'active-applicant-confirmation-authorization',
    });
    assert.equal(authorization.kind, 'fresh');
  });

  const response = await resolveFound(row, attemptId);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().retry_safety.kind, 'blocked_confirmed');
  const events = await factsFor(binding);
  assert.equal(events.some((event) => event.event_kind === 'submission_confirmed'), true);
});

for (const proofKind of [
  'typed_pre_click_stop',
  'provider_definitive_rejection',
] as const satisfies readonly SubmissionNotSentProofKind[]) {
  test(`${proofKind} after authorization cannot make the attempt retry-safe`, async () => {
    const userId = await createUser(`machine-proof-${proofKind}`);
    const attemptId = randomUUID();
    const review = reviewForAttempt(attemptId, { unverified_submission: undefined });
    const row = await createPacket(userId, review);
    const binding = attemptBinding(row, review, attemptId, 'attended_handoff', 'manual_submission');
    await appendOpening(binding, `${proofKind}-opening`);
    await backendDb.transaction(async (tx: any) => {
      await lockSubmissionAttemptUser(tx, userId);
      const authorization = await authorizeFinalSubmissionBoundary(binding, {
        executor: tx,
        factKey: `${proofKind}-authorization`,
        evidenceCode: 'test_machine_proof_boundary_authorized',
      });
      assert.equal(authorization.kind, 'fresh');
    });
    await appendSubmissionAttemptEvent({
      ...binding,
      eventId: submissionAttemptEventId(attemptId, 'not_sent_proven', proofKind),
      eventKind: 'not_sent_proven',
      proofKind,
      evidenceCode: `test_${proofKind}`,
    });

    const safety = submissionAttemptRetrySafety(await factsFor(binding));
    assert.equal(safety.kind, 'blocked_unverified');
    assert.equal(safety.kind === 'blocked_unverified' && safety.reason, 'invalid_sequence');
    const gate = await finalApplicationBoundaryGate({
      row,
      binding,
      factKey: `${proofKind}-retry`,
    });
    assert.equal(gate.kind, 'already_authorized');
  });
}

test('an expired boundary authorization never auto-releases its claim or exposes a new capability', async () => {
  const userId = await createUser('authorized-expiry');
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, {
    handoff_expires_at: '2026-08-24T07:00:00.000Z',
    unverified_submission: undefined,
  });
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'attended_handoff', 'manual_submission');
  await appendOpening(binding, 'authorized-expiry-opening');
  await authorizeWithShortLease(binding);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));

  const repaired = await repairExpiredAttendedHandoffClaim(row, userId, { info() {} } as any);
  assert.equal(repaired, null, 'a boundary fact remains risk after its short activation window expires');
  const current = await storedReview(row);
  assert.equal(current.submission_claim_id, attemptId);

  const reexposed = await exposeAttendedUrl(row, review);
  assert.equal(reexposed, null, 'an expired authorization cannot expose the employer URL again');

  const replay = await backendDb.transaction(async (tx: any) => {
    await lockSubmissionAttemptUser(tx, userId);
    return authorizeFinalSubmissionBoundary(binding, {
      executor: tx,
      factKey: 'short-lived-attended-authorization',
      evidenceCode: 'test_attended_boundary_authorized',
      ttlMs: 1,
    });
  });
  assert.notEqual(replay.kind, 'fresh', 'expiry cannot mint a replacement employer capability');
  const events = await factsFor(binding);
  assert.equal(events.some((event) => event.event_kind === 'not_sent_proven'), false);
});

test('an expired opening-only handoff still repairs as a typed pre-click stop', async () => {
  const userId = await createUser('opening-only-expiry');
  const attemptId = randomUUID();
  const review = reviewForAttempt(attemptId, {
    handoff_expires_at: '2026-08-24T07:00:00.000Z',
    unverified_submission: undefined,
  });
  const row = await createPacket(userId, review);
  const binding = attemptBinding(row, review, attemptId, 'attended_handoff', 'manual_submission');
  await appendOpening(binding, 'opening-only-expiry');

  const repaired = await repairExpiredAttendedHandoffClaim(row, userId, { info() {} } as any);
  assert.ok(repaired, 'the repair path must remain available before boundary authorization');
  const current = await storedReview(row);
  assert.equal(current.submission_claim_id, undefined);
  const events = await factsFor(binding);
  const notSent = events.find((event) => event.event_kind === 'not_sent_proven');
  assert.equal(notSent?.proof_kind, 'typed_pre_click_stop');
  assert.equal(notSent?.evidence_code, 'expired_attended_handoff_proven_before_press');
});
