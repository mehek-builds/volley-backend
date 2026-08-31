import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { and, eq } from 'drizzle-orm';
import * as schema from '../db/schema';
import type { ApplicationReviewState } from './applicationReview';
import { immutableDocumentContentHash } from './immutableDocumentHash';
import { createPacketAudit } from './packetAudit';
import { createPdfGenerationBinding } from './pdfGenerationBinding';
import type { SubmissionAttemptBinding } from './submissionAttemptLedger';

const savedEnv = { ...process.env };
const socketDir = mkdtempSync(join(tmpdir(), 'litos-confirmation-repair-'));
const PORTAL_URL = 'https://apply.workable.com/example/j/A1B2C3D4E5/apply/';
const RECEIPT_URL = `${PORTAL_URL}?success`;
const RECEIPT_TEXT = 'Your application has been submitted successfully.';
/* Anchored to run time, and every risk event carries an explicit created_at.
 *
 * These were fixed 2026-08-31 timestamps. retrySafety rejects the sequence when a
 * boundary_authorized row's created_at precedes the attempt_opened row's, and only
 * boundary_authorized set created_at explicitly; attempt_opened and press_observed fell back to
 * the column default, which is insertion time. So the fixture was valid only while the wall clock
 * was still behind the hardcoded 09:57Z, and from 10:02Z on 2026-08-31 the three eligibility cases
 * began failing everywhere, on unrelated commits. Anchoring the dates alone does not fix it: the
 * ordering has to be explicit on all three, or attempt_opened keeps landing at "now". */
const RECEIPT_BASE = Date.now();
const at = (offsetMinutes: number) => new Date(RECEIPT_BASE + offsetMinutes * 60_000);
const RECEIPT_AT = at(0).toISOString();
const JOB_CONTEXT = {
  job_id: 'aa283015-a491-4c0f-b41b-0964bb850dc0',
  company: 'Example Company',
  role: 'Example Role',
};

let database: PGlite;
let server: PGLiteSocketServer;
let backendDb: any;
let backendPool: { end(): Promise<void> };
let appendSubmissionAttemptEvent:
  typeof import('./submissionAttemptLedger').appendSubmissionAttemptEvent;
let freezePostingIdentity: typeof import('./submissionAttemptLedger').freezePostingIdentity;
let submissionAttemptEventId: typeof import('./submissionAttemptLedger').submissionAttemptEventId;
let repairMissingSubmissionConfirmation:
  typeof import('./submissionConfirmationRepair').repairMissingSubmissionConfirmation;

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
    maxConnections: 10,
  });
  await server.start();
  process.env.NODE_ENV = 'test';
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  ({ db: backendDb, pool: backendPool } = await import('../db'));
  ({
    appendSubmissionAttemptEvent,
    freezePostingIdentity,
    submissionAttemptEventId,
  } = await import('./submissionAttemptLedger'));
  ({ repairMissingSubmissionConfirmation } = await import('./submissionConfirmationRepair'));
});

after(async () => {
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

async function seedRepairCandidate(overrides: {
  screenshotUrl?: string;
  confirmationText?: string;
  portalUrl?: string;
  receiptUrl?: string;
  atsName?: string;
} = {}) {
  const portalUrl = overrides.portalUrl ?? PORTAL_URL;
  const receiptUrl = overrides.receiptUrl ?? RECEIPT_URL;
  const userId = randomUUID();
  const packetId = randomUUID();
  const applicationId = randomUUID();
  const artifactId = randomUUID();
  const attemptId = randomUUID();
  const submissionRunId = randomUUID();
  const attachedAt = at(-60);
  const objectKey = `users/${userId}/resumes/${randomUUID()}.pdf`;
  const pdfBytes = new TextEncoder().encode(`repair-packet:${packetId}`);
  const resumeEmail = `resume-${userId}@example.test`;
  const applicantEmail = `applicant-${userId}@example.test`;
  const baseStructuredContent = { summary: 'Exact repair packet' };
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
    role: JOB_CONTEXT.role,
    portal_url: portalUrl,
    portal_supported: true,
    ats_name: overrides.atsName ?? 'workable',
    status: 'submitted',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: RECEIPT_AT,
    submitted_at: RECEIPT_AT,
    submission_run_id: submissionRunId,
    submission_claimed_at: at(-5).toISOString(),
    submission_claim_id: attemptId,
    receipt: {
      confirmation_text: overrides.confirmationText ?? RECEIPT_TEXT,
      final_url: receiptUrl,
      ...(overrides.screenshotUrl === undefined
        ? { screenshot_url: `https://receipts.example/users/${userId}/submission-runs/${submissionRunId}/receipt.png` }
        : overrides.screenshotUrl
          ? { screenshot_url: overrides.screenshotUrl }
          : {}),
      captured_at: RECEIPT_AT,
      source: 'managed_browser',
    },
  };
  const packetAudit = createPacketAudit({
    ownerId: userId,
    applicationId: packetId,
    jdText: review.jd_text,
    spec: structuredContent,
    jobContext: JOB_CONTEXT,
    questions: review.questions,
    applicantSnapshot: {},
    resumeEmail,
    applicantEmail,
    employerDelivery: {
      version: 'employer_delivery_v1',
      mode: 'extension',
      sha256: 'e'.repeat(64),
    },
    pdfObjectKey: objectKey,
    pdfBytes,
    editedTerms: [],
    clauses: [{
      text: review.jd_text,
      start: 0,
      end: review.jd_text.length,
      verdict: 'unscoreable',
    }],
    rejected: [],
    degraded: false,
    terms: { covered: [], missing: [], edited: [] },
  });
  review.packet_audit = packetAudit;
  review.submission_packet_version = packetAudit.packet_version;

  await backendDb.insert(schema.users).values({
    id: userId,
    email: `repair-${userId}@example.test`,
  });
  await backendDb.insert(schema.generated_resumes).values({
    id: packetId,
    user_id: userId,
    job_context: JOB_CONTEXT,
    spec: { ...structuredContent, _review: review },
    resume_object_key: objectKey,
    pipeline_stage: 'applied',
    pipeline_stage_at: new Date(RECEIPT_AT),
  });
  await backendDb.insert(schema.artifacts).values({
    id: artifactId,
    user_id: userId,
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
    user_id: userId,
    legacy_generated_resume_id: packetId,
    job_id: JOB_CONTEXT.job_id,
    company_scope_key: `repair:${packetId}`,
    company_name: JOB_CONTEXT.company,
    role: JOB_CONTEXT.role,
    portal_url: portalUrl,
    source_surface: 'dashboard',
    tracker_state: 'applied',
    submission_state: 'submitted',
    application_fingerprint: `repair:${packetId}`,
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

  const binding: SubmissionAttemptBinding = {
    attemptId,
    userId,
    packetId,
    applicationId,
    parentAttemptId: null,
    source: 'managed_browser',
    operation: 'initial_submission',
    postingIdentity: freezePostingIdentity(JOB_CONTEXT, portalUrl),
    submissionRunId: review.submission_run_id,
    submissionClaimId: attemptId,
    packetVersion: packetAudit.packet_version,
  };
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'attempt_opened', 'reservation'),
    eventKind: 'attempt_opened',
    evidenceCode: 'atomic_claim_reserved',
    observedAt: at(-5),
    createdAt: at(-5),
  });
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'boundary_authorized', 'repair-boundary'),
    eventKind: 'boundary_authorized',
    evidenceCode: 'managed_browser_employer_boundary_authorized',
    boundaryActivationId: randomUUID(),
    boundaryExpiresAt: at(2),
    observedAt: at(-3),
    createdAt: at(-3),
  });
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'press_observed', 'managed-initial-submit'),
    eventKind: 'press_observed',
    evidenceCode: 'stratus_application_press_echoed',
    observedAt: at(-1),
    createdAt: at(-1),
  });
  return { userId, applicationId, packetId, attemptId };
}

async function confirmationCount(userId: string, packetId: string): Promise<number> {
  const rows = await backendDb.select().from(schema.application_submission_attempt_events).where(and(
    eq(schema.application_submission_attempt_events.user_id, userId),
    eq(schema.application_submission_attempt_events.packet_id, packetId),
    eq(schema.application_submission_attempt_events.event_kind, 'submission_confirmed'),
  ));
  return rows.length;
}

test('dry-run proves one exact repair without writing, apply writes once, and replay is idempotent', async () => {
  const fixture = await seedRepairCandidate();
  const dryRun = await repairMissingSubmissionConfirmation({
    userId: fixture.userId,
    applicationId: fixture.applicationId,
  });
  assert.equal(dryRun.status, 'eligible', JSON.stringify(dryRun));
  assert.equal(dryRun.dryRun, true);
  assert.equal(await confirmationCount(fixture.userId, fixture.packetId), 0);

  const applied = await repairMissingSubmissionConfirmation({
    userId: fixture.userId,
    applicationId: fixture.applicationId,
    dryRun: false,
  });
  assert.equal(applied.status, 'applied');
  assert.equal(await confirmationCount(fixture.userId, fixture.packetId), 1);

  const replay = await repairMissingSubmissionConfirmation({
    userId: fixture.userId,
    applicationId: fixture.applicationId,
    dryRun: false,
  });
  assert.equal(replay.status, 'already_applied');
  assert.equal(await confirmationCount(fixture.userId, fixture.packetId), 1);
});

test('repair refuses an incomplete screenshot tuple without writing a fact', async () => {
  const fixture = await seedRepairCandidate({ screenshotUrl: '' });
  const result = await repairMissingSubmissionConfirmation({
    userId: fixture.userId,
    applicationId: fixture.applicationId,
    dryRun: false,
  });
  assert.deepEqual(
    { status: result.status, code: result.status === 'refused' ? result.code : null },
    { status: 'refused', code: 'receipt_incomplete' },
  );
  assert.equal(await confirmationCount(fixture.userId, fixture.packetId), 0);
});

test('repair refuses a screenshot path owned by another user or run', async () => {
  const fixture = await seedRepairCandidate({
    screenshotUrl: 'https://receipts.example/users/another-user/submission-runs/another-run/receipt.png',
  });
  const result = await repairMissingSubmissionConfirmation({
    userId: fixture.userId,
    applicationId: fixture.applicationId,
    dryRun: false,
  });
  assert.deepEqual(
    { status: result.status, code: result.status === 'refused' ? result.code : null },
    { status: 'refused', code: 'receipt_incomplete' },
  );
  assert.equal(await confirmationCount(fixture.userId, fixture.packetId), 0);
});

test('repair refuses a generic Ashby application route and mutable success text', async () => {
  const postingId = '4d7cc169-5a18-4a40-b9cf-dd519dbd7bcb';
  const portalUrl = `https://jobs.ashbyhq.com/example/${postingId}`;
  const fixture = await seedRepairCandidate({
    portalUrl,
    receiptUrl: `${portalUrl}/application`,
    atsName: 'ashby',
    confirmationText: 'Thank you for applying. Your application was submitted.',
  });
  const result = await repairMissingSubmissionConfirmation({
    userId: fixture.userId,
    applicationId: fixture.applicationId,
    dryRun: false,
  });
  assert.deepEqual(
    { status: result.status, code: result.status === 'refused' ? result.code : null },
    { status: 'refused', code: 'receipt_not_verified' },
  );
  assert.equal(await confirmationCount(fixture.userId, fixture.packetId), 0);
});

test('repair preserves the exact Greenhouse confirmation route used by Jump', async () => {
  const portalUrl = 'https://boards.greenhouse.io/jumptrading/jobs/7654321';
  const fixture = await seedRepairCandidate({
    portalUrl,
    receiptUrl: `${portalUrl}/application_confirmation`,
    atsName: 'greenhouse',
    confirmationText: 'Thank you for applying to Jump Trading.',
  });
  const dryRun = await repairMissingSubmissionConfirmation({
    userId: fixture.userId,
    applicationId: fixture.applicationId,
  });
  assert.equal(dryRun.status, 'eligible', JSON.stringify(dryRun));
  assert.equal(await confirmationCount(fixture.userId, fixture.packetId), 0);
});
