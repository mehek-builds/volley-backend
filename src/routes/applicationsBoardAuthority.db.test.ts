import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { SignJWT } from 'jose';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import * as schema from '../db/schema';
import type { ApplicationReviewState } from '../lib/applicationReview';
import { immutableDocumentContentHash } from '../lib/immutableDocumentHash';
import { createPacketAudit } from '../lib/packetAudit';
import { createPdfGenerationBinding } from '../lib/pdfGenerationBinding';
import {
  unsupportedEmailConfirmationEvidenceCode,
  unsupportedEmailConfirmationText,
} from '../lib/unsupportedEmailReceipt';

/**
 * GET /applications/board as the dashboard's board loader reads it.
 *
 * role-quick-website (origin/main 9c27017, PR #466) rejects the whole board unless the payload is a
 * complete passive authority collection: top-level `schema_version` and a canonical
 * `submission_authority_revision`, and on EVERY card a `submission_authority` envelope whose
 * `revision` equals the collection's and whose `application_id` and `packet_id` are the card id.
 * Measured in prod 2026-09-02 the payload carried none of this, so the board rendered "Could not
 * load your board" for every user. This pins the contract from the server side so it cannot
 * silently regress to that shape again.
 */

const JWT_SECRET = 'applications-board-authority-test-secret-32';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-board-authority-'));
const savedEnv = { ...process.env };
let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let backendDb: any;

const USER_ID = '5f1a0d1e-2b6c-4a7e-9f00-8a1c2d3e4f51';
const OTHER_USER_ID = '9c2f77aa-1111-4222-8333-444455556667';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

let neverAttempted: string;
let held: string;
let heldAttempt: string;
const heldAt = new Date('2026-08-28T08:00:00.000Z');
let legacySent: string;
/* The three unpublishable classes. */
let boundaryHeld: string;
let boundaryHeldAttempt: string;
let emailConfirmed: string;
let attendedOnManaged: string;

let appendSubmissionAttemptEvent:
  typeof import('../lib/submissionAttemptLedger').appendSubmissionAttemptEvent;
let freezePostingIdentity: typeof import('../lib/submissionAttemptLedger').freezePostingIdentity;
let submissionAttemptEventId:
  typeof import('../lib/submissionAttemptLedger').submissionAttemptEventId;

/* Every confirmed fixture below is written on this explicit clock. Nothing may fall back to the
 * column default: retry safety rejects a boundary whose created_at precedes its opening's, and a
 * default created_at is insertion time, which silently invalidates the sequence at some wall-clock
 * hour rather than on any code change. */
const CONFIRMED_OPENED_AT = new Date('2026-08-29T09:00:00.000Z');
const CONFIRMED_BOUNDARY_AT = new Date('2026-08-29T09:01:00.000Z');
const CONFIRMED_BOUNDARY_EXPIRES_AT = new Date('2026-08-29T09:04:00.000Z');
const CONFIRMED_PRESSED_AT = new Date('2026-08-29T09:02:00.000Z');
const CONFIRMED_AT = new Date('2026-08-29T09:05:00.000Z');
const CONFIRMED_ISO = CONFIRMED_AT.toISOString();

async function token(userId: string) {
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
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({
    appendSubmissionAttemptEvent,
    freezePostingIdentity,
    submissionAttemptEventId,
  } = await import('../lib/submissionAttemptLedger'));
  const { jdMatchRoutes } = await import('./jdMatch');
  app = Fastify({ logger: false });
  await app.register(jdMatchRoutes);
  await app.ready();
  await backendDb.insert(schema.users).values([
    { id: USER_ID, email: 'board@example.com', password_hash: 'x' },
    { id: OTHER_USER_ID, email: 'other-board@example.com', password_hash: 'x' },
  ]);
  // One packet per projection state the board must publish, plus a foreign packet that must not
  // leak. Seeded in the same hook as the schema so the ordering is explicit.
  neverAttempted = await makePacket();
  held = await makePacket();
  heldAttempt = await openAttempt(held, heldAt);
  legacySent = await makePacket({
    review: { status: 'submitted', submitted_at: '2026-08-20T10:00:00.000Z' },
  });
  await makePacket({ userId: OTHER_USER_ID });

  /* CLASS 1: an open employer-boundary authorization with no press. Every managed submission
   * occupies this state between authorizeFinalSubmissionBoundary and the press event, and stays in
   * it permanently when the runner dies inside that window, because the retry fold reads
   * boundary_authorized off "authorized, not pressed" and never downgrades on lease expiry. */
  boundaryHeld = await makePacket();
  /* The boundary event must repeat the opening's whole immutable binding, run id included: the
   * retry fold reads a differing signature as an invalid sequence, not as an authorized hold. */
  const boundaryHeldRunId = randomUUID();
  boundaryHeldAttempt = await openAttempt(boundaryHeld, heldAt, boundaryHeldRunId);
  await backendDb.insert(schema.application_submission_attempt_events).values({
    user_id: USER_ID,
    application_id: null,
    packet_id: boundaryHeld,
    event_id: randomUUID(),
    attempt_id: boundaryHeldAttempt,
    parent_attempt_id: null,
    event_kind: 'boundary_authorized',
    source: 'managed_browser',
    operation: 'initial_submission',
    submission_run_id: boundaryHeldRunId,
    submission_claim_id: boundaryHeldAttempt,
    packet_version: 'f'.repeat(64),
    company_role: 'example company::example role',
    company_name: 'Example Company',
    role: 'Example Role',
    portal_url: 'https://job-boards.greenhouse.io/example/jobs/1',
    evidence_code: 'managed_browser_employer_boundary_authorized',
    boundary_activation_id: randomUUID(),
    boundary_expires_at: new Date(heldAt.getTime() + 3 * 60_000),
    observed_at: new Date(heldAt.getTime() + 60_000),
    created_at: new Date(heldAt.getTime() + 60_000),
  });

  /* CLASS 2: the unsupported-portal EMAIL channel. A real, confirmed send whose attempt source is
   * unsupported_email and whose receipt source is email_fallback. The ledger permits the pair; the
   * dashboard's confirmed vocabulary has no word for either. */
  emailConfirmed = await seedConfirmedPacket({
    portalUrl: 'https://careers.example.com/openings/1234',
    receiptUrl: 'https://careers.example.com/openings/1234',
    atsName: 'unsupported',
    portalSupported: false,
    source: 'unsupported_email',
    openingEvidence: 'atomic_email_claim_reserved',
    boundaryEvidence: 'unsupported_email_employer_boundary_authorized',
    pressEvidence: 'unsupported_email_dispatch_started',
    confirmationEvidence: unsupportedEmailConfirmationEvidenceCode({
      recipient: 'careers@example.com',
      messageId: 'msg-board-authority-1',
    }),
    confirmationText: unsupportedEmailConfirmationText({
      recipient: 'careers@example.com',
      messageId: 'msg-board-authority-1',
    }),
    receiptSource: 'email_fallback',
    referenceId: 'msg-board-authority-1',
  });

  /* CLASS 3: a managed opening whose retained receipt is an attended handoff. Confirmed, and the
   * client's receipt-source rule for a managed opening admits only a managed receipt. */
  attendedOnManaged = await seedConfirmedPacket({
    portalUrl: 'https://apply.workable.com/example/j/A1B2C3D4E5/apply/',
    receiptUrl: 'https://apply.workable.com/example/j/A1B2C3D4E5/apply/?success',
    atsName: 'workable',
    portalSupported: true,
    source: 'managed_browser',
    openingEvidence: 'atomic_claim_reserved',
    boundaryEvidence: 'managed_browser_employer_boundary_authorized',
    pressEvidence: 'stratus_application_press_echoed',
    confirmationEvidence: 'attended_receipt_confirmed',
    confirmationText: 'Your application has been submitted successfully.',
    receiptSource: 'attended_handoff',
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

async function makePacket(overrides: { userId?: string; review?: Record<string, unknown>; pipelineStage?: string } = {}) {
  const id = randomUUID();
  await backendDb.insert(schema.generated_resumes).values({
    id,
    user_id: overrides.userId ?? USER_ID,
    job_context: { company: 'Example Company', role: 'Example Role' },
    spec: overrides.review ? { _review: overrides.review } : {},
    resume_object_key: `users/${USER_ID}/resumes/${id}.pdf`,
    pipeline_stage: overrides.pipelineStage ?? null,
  });
  return id;
}

async function openAttempt(packetId: string, observedAt: Date, submissionRunId = randomUUID()) {
  const attemptId = randomUUID();
  await backendDb.insert(schema.application_submission_attempt_events).values({
    user_id: USER_ID,
    application_id: null,
    packet_id: packetId,
    event_id: randomUUID(),
    attempt_id: attemptId,
    parent_attempt_id: null,
    event_kind: 'attempt_opened',
    source: 'managed_browser',
    operation: 'initial_submission',
    submission_run_id: submissionRunId,
    submission_claim_id: attemptId,
    packet_version: 'f'.repeat(64),
    company_role: 'example company::example role',
    company_name: 'Example Company',
    role: 'Example Role',
    portal_url: 'https://job-boards.greenhouse.io/example/jobs/1',
    evidence_code: 'atomic_claim_reserved',
    observed_at: observedAt,
    created_at: observedAt,
  });
  return attemptId;
}

/**
 * One packet the authoritative projection classifies `confirmed`, built the way a real send builds
 * one: a complete document tuple, a terminal canonical row, and the exact four-event ledger
 * sequence for the given source. Only the confirmation evidence and the receipt source vary, which
 * is what separates a publishable confirmation from the two that are outside the client's
 * vocabulary. A fixture that drifts out of `confirmed` cannot pass the assertions below, because
 * `repair_required` publishes an envelope.
 */
async function seedConfirmedPacket(options: {
  portalUrl: string;
  receiptUrl: string;
  atsName: string;
  portalSupported: boolean;
  source: 'managed_browser' | 'unsupported_email';
  openingEvidence: string;
  boundaryEvidence: string;
  pressEvidence: string;
  confirmationEvidence: string;
  confirmationText: string;
  receiptSource: 'managed_browser' | 'attended_handoff' | 'email_fallback';
  referenceId?: string;
}) {
  const packetId = randomUUID();
  const applicationId = randomUUID();
  const artifactId = randomUUID();
  const attemptId = randomUUID();
  const submissionRunId = randomUUID();
  const attachedAt = new Date(CONFIRMED_OPENED_AT.getTime() - 60 * 60_000);
  const jobContext = {
    job_id: randomUUID(),
    company: 'Example Company',
    role: 'Example Role',
  };
  const objectKey = `users/${USER_ID}/resumes/${packetId}.pdf`;
  const pdfBytes = new TextEncoder().encode(`board-authority-packet:${packetId}`);
  const resumeEmail = `resume-${packetId}@example.test`;
  const baseStructuredContent = { summary: 'Exact board authority packet' };
  const structuredContent = {
    ...baseStructuredContent,
    _quality: {
      pdfGenerationBinding: createPdfGenerationBinding(
        baseStructuredContent,
        objectKey,
        pdfBytes,
        resumeEmail,
      ),
    },
  };
  const review: ApplicationReviewState = {
    jd_text: 'Complete the exact Example Company application.',
    role: jobContext.role,
    portal_url: options.portalUrl,
    portal_supported: options.portalSupported,
    ats_name: options.atsName,
    status: 'submitted',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: CONFIRMED_ISO,
    submitted_at: CONFIRMED_ISO,
    submission_run_id: submissionRunId,
    submission_claimed_at: CONFIRMED_OPENED_AT.toISOString(),
    submission_claim_id: attemptId,
    receipt: {
      confirmation_text: options.confirmationText,
      final_url: options.receiptUrl,
      captured_at: CONFIRMED_ISO,
      ...(options.referenceId ? { reference_id: options.referenceId } : {}),
      source: options.receiptSource,
    },
  };
  const packetAudit = createPacketAudit({
    ownerId: USER_ID,
    applicationId: packetId,
    jdText: review.jd_text,
    spec: structuredContent,
    jobContext,
    questions: review.questions,
    applicantSnapshot: {},
    resumeEmail,
    applicantEmail: `applicant-${packetId}@example.test`,
    employerDelivery: { version: 'employer_delivery_v1', mode: 'extension', sha256: 'e'.repeat(64) },
    pdfObjectKey: objectKey,
    pdfBytes,
    editedTerms: [],
    clauses: [{ text: review.jd_text, start: 0, end: review.jd_text.length, verdict: 'unscoreable' }],
    rejected: [],
    degraded: false,
    terms: { covered: [], missing: [], edited: [] },
  });
  review.packet_audit = packetAudit;
  review.submission_packet_version = packetAudit.packet_version;

  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: USER_ID,
    job_context: jobContext,
    spec: { ...structuredContent, _review: review },
    resume_object_key: objectKey,
    pipeline_stage: 'applied',
    pipeline_stage_at: CONFIRMED_AT,
  });
  await backendDb.insert(schema.artifacts).values({
    id: artifactId,
    user_id: USER_ID,
    legacy_generated_resume_id: packetId,
    kind: 'tailored_resume',
    structured_content: structuredContent,
    rendered_object_key: objectKey,
    source: 'ai_tailored',
  });
  await backendDb.insert(schema.artifact_versions).values({
    artifact_id: artifactId,
    version_number: 1,
    generation_source: 'ai_tailored',
    content_hash: immutableDocumentContentHash(structuredContent),
    structured_content: structuredContent,
    rendered_object_key: objectKey,
  });
  await backendDb.insert(schema.applications).values({
    id: applicationId,
    user_id: USER_ID,
    legacy_generated_resume_id: packetId,
    job_id: jobContext.job_id,
    company_scope_key: `board-authority:${packetId}`,
    company_name: jobContext.company,
    role: jobContext.role,
    portal_url: options.portalUrl,
    source_surface: 'dashboard',
    tracker_state: 'applied',
    submission_state: 'submitted',
    application_fingerprint: `board-authority:${packetId}`,
    selected_resume_artifact_id: artifactId,
    resume_attached: true,
    resume_source: 'artifact',
    resume_attached_at: attachedAt,
  });
  await backendDb.insert(schema.application_artifacts).values({
    application_id: applicationId,
    artifact_id: artifactId,
    purpose: 'resume',
    selected: true,
    attachment_result: 'attached',
    attached_at: attachedAt,
  });

  const binding = {
    attemptId,
    userId: USER_ID,
    packetId,
    applicationId,
    parentAttemptId: null,
    source: options.source,
    operation: 'initial_submission' as const,
    postingIdentity: freezePostingIdentity(jobContext, options.portalUrl),
    submissionRunId,
    submissionClaimId: attemptId,
    packetVersion: packetAudit.packet_version,
  };
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'attempt_opened', 'reservation'),
    eventKind: 'attempt_opened',
    evidenceCode: options.openingEvidence,
    observedAt: CONFIRMED_OPENED_AT,
    createdAt: CONFIRMED_OPENED_AT,
  });
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'boundary_authorized', 'boundary'),
    eventKind: 'boundary_authorized',
    evidenceCode: options.boundaryEvidence,
    boundaryActivationId: randomUUID(),
    boundaryExpiresAt: CONFIRMED_BOUNDARY_EXPIRES_AT,
    observedAt: CONFIRMED_BOUNDARY_AT,
    createdAt: CONFIRMED_BOUNDARY_AT,
  });
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'press_observed', 'press'),
    eventKind: 'press_observed',
    evidenceCode: options.pressEvidence,
    observedAt: CONFIRMED_PRESSED_AT,
    createdAt: CONFIRMED_PRESSED_AT,
  });
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'submission_confirmed', 'receipt'),
    eventKind: 'submission_confirmed',
    evidenceCode: options.confirmationEvidence,
    observedAt: CONFIRMED_AT,
    createdAt: CONFIRMED_AT,
  });
  return packetId;
}

async function board(userId = USER_ID) {
  const res = await app.inject({
    method: 'GET',
    url: '/applications/board',
    headers: { authorization: `Bearer ${await token(userId)}` },
  });
  assert.equal(res.statusCode, 200);
  return res.json() as {
    stages: string[];
    limit: number;
    revision: string | null;
    schema_version?: string;
    submission_authority_revision?: string;
    cards: Array<Record<string, any>>;
  };
}

test('regression: the payload is a complete authority collection, which origin/main never sent', async () => {
  const payload = await board();
  // The measured 2026-09-02 prod shape was exactly [stages, limit, revision, cards], and every
  // card lacked submission_authority. Each of these fails on that shape.
  assert.equal(payload.schema_version, 'submission-authority-v1');
  assert.match(payload.submission_authority_revision ?? '', /^(?:0|[1-9][0-9]*)$/);
  assert.equal(payload.cards.length, 6, 'only this user\'s packets');
  for (const card of payload.cards) {
    // Exactly one of the two, on every card. Silently carrying neither is what made an unverifiable
    // card indistinguishable from a server that does not speak this contract.
    assert.equal(
      ('submission_authority' in card) !== ('submission_authority_unavailable' in card),
      true,
      `card ${card.id} carries an envelope or a marker, never both and never neither`,
    );
  }
  assert.deepEqual(
    payload.cards.filter((card) => 'submission_authority' in card).map((card) => card.id).sort(),
    [neverAttempted, held, legacySent].sort(),
    'the publishable cards still carry envelopes',
  );
  // The pre-existing fields survive beside the collection fields.
  assert.deepEqual(payload.stages, ['saved', 'applied', 'interview', 'offer', 'closed']);
  assert.equal(payload.limit, 200);
  assert.ok('revision' in payload, 'the build revision stays on the payload');
});

test('every card envelope carries the collection revision and binds both ids to the card', async () => {
  const payload = await board();
  const revision = payload.submission_authority_revision!;
  for (const card of payload.cards.filter((candidate) => 'submission_authority' in candidate)) {
    const authority = card.submission_authority;
    assert.equal(authority.schema_version, 'submission-authority-v1');
    assert.equal(authority.revision, revision, `card ${card.id} matches the collection revision`);
    assert.equal(authority.application_id, card.id);
    assert.equal(authority.packet_id, card.id);
    assert.equal(authority.state, authority.projection.state);
    assert.deepEqual(Object.keys(authority).sort(), [
      'application_id', 'packet_id', 'projection', 'retry_safety', 'revision', 'schema_version', 'state',
    ]);
    // The card must not carry the sibling keys the client cross-checks against the envelope.
    for (const key of ['requested_application_id', 'canonical_application_id', 'application_id', 'packet_id', 'submission_projection', 'retry_safety']) {
      assert.equal(key in card, false, `card must not carry ${key}`);
    }
  }
});

test('a never-attempted packet projects none with no evidence', async () => {
  const payload = await board();
  const card = payload.cards.find((candidate) => candidate.id === neverAttempted)!;
  assert.deepEqual(card.submission_authority, {
    schema_version: 'submission-authority-v1',
    revision: payload.submission_authority_revision,
    state: 'none',
    application_id: neverAttempted,
    packet_id: neverAttempted,
    projection: { state: 'none' },
    retry_safety: { kind: 'no_evidence' },
  });
  // The row's own fields are left for the client to interpret.
  assert.equal(card.stage, 'saved');
  assert.equal(card.submission_status, null);
});

test('a held attempt projects unverified, with the retry verdict describing that attempt', async () => {
  const payload = await board();
  const card = payload.cards.find((candidate) => candidate.id === held)!;
  const authority = card.submission_authority;
  assert.equal(authority.state, 'unverified');
  assert.deepEqual(authority.projection, {
    state: 'unverified',
    attempt_id: heldAttempt,
    observed_at: heldAt.toISOString(),
    reason: 'opened',
  });
  assert.deepEqual(authority.retry_safety, {
    kind: 'blocked_unverified',
    attemptId: heldAttempt,
    at: heldAt.toISOString(),
    reason: 'opened',
  });
  assert.match(authority.projection.attempt_id, UUID);
  assert.match(authority.retry_safety.at, STRICT_TIMESTAMP);
});

test('a legacy sent packet with no ledger evidence projects repair_required with a null verdict', async () => {
  const payload = await board();
  const card = payload.cards.find((candidate) => candidate.id === legacySent)!;
  assert.deepEqual(card.submission_authority, {
    schema_version: 'submission-authority-v1',
    revision: payload.submission_authority_revision,
    state: 'repair_required',
    application_id: legacySent,
    packet_id: legacySent,
    projection: {
      state: 'repair_required',
      reasons: ['mutable_sent_without_confirmation'],
      packet_id: legacySent,
    },
    retry_safety: null,
  });
  // The server still derives applied from the mutable status; the client demotes it from the
  // envelope. Changing the stage here would make the two surfaces disagree about the derivation.
  assert.equal(card.stage, 'applied');
  assert.equal(card.submission_status, 'submitted');
});

test('an empty board is still a complete collection', async () => {
  const fresh = randomUUID();
  await backendDb.insert(schema.users).values({ id: fresh, email: `${fresh}@example.com`, password_hash: 'x' });
  const payload = await board(fresh);
  assert.equal(payload.schema_version, 'submission-authority-v1');
  assert.equal(payload.submission_authority_revision, '0');
  assert.deepEqual(payload.cards, []);
});

/**
 * The three reachable classes of card the server genuinely cannot publish an envelope for.
 *
 * Each asserts the same three things, because they are the design: the collection identity survives
 * (so the payload still proves the server speaks this contract), the publishable cards on the SAME
 * board still carry their envelopes (so one unverifiable card is one card, not the whole board), and
 * the unverifiable card carries an explicit marker naming why and no envelope (so no reader can
 * mistake it for authority to send).
 */
function unavailable(payload: Awaited<ReturnType<typeof board>>, packetId: string) {
  const card = payload.cards.find((candidate) => candidate.id === packetId)!;
  assert.equal(payload.schema_version, 'submission-authority-v1', 'the collection identity survives');
  assert.match(payload.submission_authority_revision ?? '', /^(?:0|[1-9][0-9]*)$/);
  for (const publishable of [neverAttempted, held, legacySent]) {
    const sibling = payload.cards.find((candidate) => candidate.id === publishable)!;
    assert.ok('submission_authority' in sibling, `card ${publishable} still carries its envelope`);
    assert.equal(sibling.submission_authority.revision, payload.submission_authority_revision);
  }
  assert.equal('submission_authority' in card, false, 'no envelope is invented for it');
  return card;
}

test('a boundary-authorized hold is marked unverifiable, and takes no other card with it', async () => {
  const payload = await board();
  const card = unavailable(payload, boundaryHeld);
  assert.deepEqual(card.submission_authority_unavailable, {
    schema_version: 'submission-authority-v1',
    packet_id: boundaryHeld,
    reason: 'boundary_authorized',
  });
  // The card's own fields are untouched: the marker says the send state is unverifiable, it does
  // not restate or move the packet.
  assert.equal(card.stage, 'saved');
  assert.equal(card.submission_status, null);
});

test('an unsupported_email confirmation with an email_fallback receipt is marked, not omitted', async () => {
  const payload = await board();
  const card = unavailable(payload, emailConfirmed);
  assert.deepEqual(card.submission_authority_unavailable, {
    schema_version: 'submission-authority-v1',
    packet_id: emailConfirmed,
    reason: 'unpublishable_receipt_source',
  });
  // Genuinely sent, and the server keeps saying so on the card's own fields. What it cannot do is
  // publish an envelope in a vocabulary the client does not have.
  assert.equal(card.stage, 'applied');
  assert.equal(card.submission_status, 'submitted');
});

test('an attended receipt retained on a managed opening is marked, not omitted', async () => {
  const payload = await board();
  const card = unavailable(payload, attendedOnManaged);
  assert.deepEqual(card.submission_authority_unavailable, {
    schema_version: 'submission-authority-v1',
    packet_id: attendedOnManaged,
    reason: 'unpublishable_receipt_source',
  });
  assert.equal(card.stage, 'applied');
  assert.equal(card.submission_status, 'submitted');
});
