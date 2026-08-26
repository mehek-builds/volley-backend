import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { del, put } from '@vercel/blob';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withDedicatedDatabase } from '../db/index';
import { withReadOnlyRetry } from '../db/readOnlyRetry';
import { applyReviewPatch, settleStall } from '../lib/applicationStall';
import type { ApplicationReviewState } from '../lib/applicationReview';
import { readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import {
  application_submission_events,
  applications,
  career_page_sources,
  generated_resumes,
  monitored_jobs,
  profiles,
  users,
  type ExperienceBankEntry,
} from '../db/schema';
import {
  findPdfTextFidelityIssues,
  findPdfSafeMarginIssues,
  hasContactRoute,
  renderResumePdf,
  validateResumeVisualLayout,
} from '../engine/resumeRender';
import { pruneUngroundedSkills, validatePdfLayout, validateResumeSpec } from '../engine/resumeValidate';
import { resumeSafeTargetRole } from '../engine/resumePolicy';
import { leadAlignmentIssues, selectJdAlignedLead } from '../engine/leadAlignment';
import {
  applyApplicationReviewEdit,
  deriveEditedTerms,
  finalApprovalCoverLetterIssue,
  finalApprovalFieldIssues,
  mergeSubmittedApplicationReviewQuestions,
  normalizeApplicationReviewQuestions,
  readApplicationReview,
  type ApplicationReviewQuestion,
  type SubmittedApplicationReviewQuestion,
} from '../lib/applicationReview';
import { repairReviewPortalFromMonitoredJob } from '../lib/applicationPortalRepair';
import { browserDeliveryRuntimeIdentity, connectToSession, getBrowserSession, getLiveViewUrl, isBrowserbaseConfigured } from '../lib/browserbase';
import { apiBaseFor } from '../lib/apiBase';
import { extractPdfText } from '../lib/pdfText';
import { storedCoverLetter } from '../lib/coverLetterService';
import { specWithoutDocumentPointers, storedDocuments } from '../lib/documentStore';
import { documentAsksLitosCannotResolve } from '../lib/requiredDocuments';
import { mintDownloadToken } from '../lib/resumeAccess';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import { requireAuth } from '../middleware/auth';
import { declaredSkillsList } from './profile';
import { buildPacket, finishSecurityCodeSubmission, processSubmissionApplication, resolvePacketAuditQuestionFixpoint, resolvedPacketAuditQuestions,
  transportVerifiedBuiltPacket,
} from './submissionRunner';
import { postingCountryCodeFromJobContext, postingCountryFromJobContext, type JobCountry } from '../lib/jobLocation';
import { applicationContextForQuestionResolution, knownAnswerLookup, sensitiveQuestionRequiresAttention, type ApplicationProfileLike } from '../lib/questionDiscovery';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import { rememberReusableAnswers } from '../lib/savedAnswerStore';
import { resolveSubmittedApplicationAnswers } from '../lib/submittedAnswers';
import { blankRequiredQuestionLabels, preparedRunCanRestart, preparedRunHandoffExpired, resumeEditDisposition, reviewAnswerSaveDisposition, submitRequestDisposition } from '../lib/submissionSafety';
import {
  expiredAttendedHandoffClaimIsReleasable,
  releaseExpiredAttendedHandoffClaim,
} from '../lib/expiredHandoffClaimRelease';
import { submissionClaimPatch } from '../lib/submissionStop';
import { advanceCanonicalApplicationFromPacketSubmission } from '../lib/canonicalApplicationSync';
import { extensionAuthorizationRequiresAutomaticSubmission } from '../lib/submissionAuthorization';
import {
  detectPortal,
  isManagedAttendedAccountPortal,
  isPortalSupported,
  portalApplicationUrl,
  readReceipt,
} from '../lib/portalSubmission';
import { dailySubmissionCap, withinDailyCap } from '../lib/submissionQueue';
import {
  canStartExtensionSubmission,
  extensionEmployerReceiptIsSufficient,
  extensionOutcomeClaimDisposition,
  extensionOutcomePatch,
  isSafeExtensionReceiptUrl,
  type ExtensionOutcome,
} from '../lib/extensionSubmission';
import {
  candidateEducationFromParsedProfile,
  educationDriftResponse,
  packetEducationDrift,
} from '../lib/submissionEducationGuard';
import { resumeFileNameForRole } from '../lib/resumeFileName';
import {
  prepareUnsupportedPortalApplicationEmail,
  sendPreparedUnsupportedPortalApplicationEmail,
} from '../lib/unsupportedPortalEmailFallback';
import {
  browserEmployerDeliveryChannel,
  createEmployerDeliveryBindings,
  employerDeliveryEnvelope,
  extensionBoundApplicationSpec,
  extensionEmployerDeliveryBindingIssue,
  extensionEmployerDeliveryProjection,
} from '../lib/employerDeliveryIdentity';
import { getEntitlementSnapshot, requireFeature } from '../lib/entitlements';
import { appendEditedResumeArtifactVersion } from '../lib/resumeArtifactVersions';
import {
  extensionHandoffPacketMatches,
  extensionHandoffVersion,
  extensionStartHandoffBinding,
  verifiedDashboardHandoffUrl,
} from '../lib/extensionHandoffPacket';
import { assessAtsSubmissionChannel } from '../lib/atsSubmissionChannels';
import {
  duplicateApplicationResponse,
  duplicateApplicationVerdict,
  unidentifiableDuplicateApplicationResponse,
  type DuplicateApplicationVerdict,
} from '../lib/duplicateApplication';
import { resolveFrozenApplicantEmail } from '../lib/applicationEmail';
import { findComposioVerificationCode } from '../lib/emailVerification';
import { registerWorkdayVerificationRoute } from './workdayVerification';
import { createAndPersistPacketAudit, currentAcknowledgedPacketAudit, currentPacketAudit, packetAuditClientError } from '../lib/packetAuditService';
import { verifyStoredPacketAuditAcknowledgement } from '../lib/packetAudit';
import { createPdfGenerationBinding } from '../lib/pdfGenerationBinding';
import { resumeEmailOfRecord, resumePacketEmailIsCurrent } from '../lib/resumeEmail';
import { refreshResumeContactFromProfile } from '../lib/resumeContactOfRecord';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { reconcileCanonicalCoverLetterForPacket } from '../lib/canonicalCoverLetterService';
import { passiveSubmissionReview } from '../lib/passiveSubmissionReview';
import {
  attendedHandoffCapabilitiesMatch,
  attendedHandoffCapabilityEvidenceCode,
  attendedHandoffCapabilityFromEvidenceCode,
  attendedHandoffDashboardBindingSha256,
  createAttendedHandoffCapability,
  type AttendedHandoffCapability,
  type AttendedHandoffCapabilityKind,
} from '../lib/attendedHandoffCapability';
import {
  authorizeFinalSubmissionBoundary,
  appendSubmissionAttemptEvent,
  freezePostingIdentity,
  lockSubmissionAttemptUser,
  submissionAttemptBindingFromEvent,
  submissionBoundaryAuthorization,
  submissionAttemptEventId,
  submissionAttemptEventsForPacket,
  submissionAttemptRetrySafetyForPacket,
  submissionAttemptsOpenedToday,
  type SubmissionAttemptBinding,
  type SubmissionBoundaryAuthorization,
  type SubmissionAttemptEventKind,
  type SubmissionAttemptEventRecord,
  type SubmissionAttemptLedgerExecutor,
  type SubmissionAttemptRetrySafety,
  type SubmissionNotSentProofKind,
} from '../lib/submissionAttemptLedger';

const paramsSchema = z.object({ id: z.string().uuid() });
/**
 * The generated Chrome submission lane is deliberately paused for the 0.6.2 release. Keep the
 * packet/evidence read and outcome receipt routes available, but never mint a new claim or employer
 * boundary while the client-side generated click path is disabled.
 */
export const GENERATED_EXTENSION_SUBMISSION_ENABLED = false;
const extensionPacketQuerySchema = z.object({ current_url: z.string().url().max(4000) });
const packetAuditAcknowledgementSchema = z.object({
  audit_digest: z.string().regex(/^[a-f0-9]{64}$/),
  packet_version: z.string().regex(/^[a-f0-9]{64}$/),
  pdf_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size_bytes: z.number().int().positive(),
});
const questionSchema = z.object({
  id: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  answer: z.string().max(20_000),
  kind: z.enum(['essay', 'required']),
  required: z.boolean(),
  portal_selector: z.string().max(2000).optional(),
  portal_input_type: z.string().max(100).optional(),
});
const reviewBodySchema = z.object({
  ats_name: z.string().min(1).max(100),
  portal_url: z.string().url().max(4000),
  questions: z.array(questionSchema).max(100),
  skipped_reasons: z.array(z.string().max(1000)).max(100).default([]),
});
/* ANSWERS AND NOTHING ELSE. The edit body above requires an ATS name and a portal URL because an
 * edit is allowed to change them; a save from the Review-answers screen changes neither, and asking
 * that screen to post them back would make a round trip of the portal identity every time somebody
 * fixes a typo in an essay. Narrower body, narrower route, nothing to re-derive. */
const reviewAnswersBodySchema = z.object({
  /* Plus the one field only this screen can honestly send. `confirmed` is the applicant's explicit
   * word that she read this exact answer and let it stand, which the merge turns into the
   * applicant-claim an unedited confirmation can never earn through a diff - see
   * applicantConfirmedAnswer in mergeSubmittedApplicationReviewQuestions, and the DV Trading CONFIRM
   * loop it closes. `z.literal(true)` rather than boolean: absent is the only other honest state,
   * and a stored `confirmed: false` would read as "she looked and refused", which no control says. */
  questions: z.array(questionSchema.extend({ confirmed: z.literal(true).optional() })).max(100),
});
/* ONE TICK ON THE "Your turn" PANEL. item_id is the dashboard's checklist row id, derived from the
 * attention sentence the row prints, and label is that sentence as she saw it - stored beside the
 * timestamp so the record still names what was acknowledged after the sentence leaves the report.
 * `acknowledged: false` is the same tick withdrawn. The caps are the panel's own scale: a review
 * carries a handful of blocker lines, never hundreds. */
const attentionAcknowledgementBodySchema = z.object({
  /* THE CHARSET IS A SECURITY DECISION, not tidiness. item_id becomes a KEY on a plain object, and
   * a client-supplied "__proto__" assigned by bracket write re-parents the map instead of creating
   * an own property: the tick vanishes, the route answers 200, and the checkbox is dead again with
   * a success status behind it. The dashboard's keyFor only ever emits lowercase alphanumerics and
   * hyphens, so that is the whole alphabet accepted. The length cap follows the longest sentence
   * the runner itself composes (blocker lines run to ~450 characters before slugging; the whole
   * report is sliced at 1200): a cap tighter than the server's own prose would 400 the tick on the
   * longest rows, which are exactly the ones that matter. */
  item_id: z.string().min(1).max(1200).regex(/^[a-z0-9][a-z0-9-]*$/),
  label: z.string().min(1).max(1300),
  acknowledged: z.boolean(),
});
/** More keys than any real panel has rows. Hitting this means a client is looping, not ticking. */
const ATTENTION_ACKNOWLEDGEMENT_CAP = 100;
const submitBodySchema = z.object({
  questions: z.array(questionSchema).max(100),
  /* "Throw away the form you already filled and fill it again."
   *
   * Only ever consulted for a packet at ready_for_final_approval that has not been claimed - see
   * preparedRunCanRestart for why that is the only state where discarding a prepared run is safe.
   * Optional and default-false, so a client that never sends it behaves exactly as before and a
   * replayed POST still gets its 409 rather than silently discarding a filled form. */
  restart: z.boolean().optional(),
});

/* An attended employer page may be re-delivered only by replaying the complete immutable
 * authorization identity returned by the first explicit click. An empty object is the initial
 * request. Strict alternatives make a partial tuple, an extra field, or a guessed replacement a
 * malformed request before any employer URL can be returned. */
const attendedBoundaryReplaySchema = z.object({
  attempt_id: z.string().uuid(),
  boundary_lease_id: z.string().uuid(),
  boundary_activation_id: z.string().uuid(),
}).strict();
const attendedBoundaryRequestSchema = z.union([
  z.object({}).strict(),
  attendedBoundaryReplaySchema,
]);

type AttendedBoundaryReplay = {
  attemptId: string;
  leaseId: string;
  activationId: string;
};

function attendedBoundaryReplay(
  request: z.infer<typeof attendedBoundaryRequestSchema>,
): AttendedBoundaryReplay | undefined {
  return 'attempt_id' in request
    ? {
      attemptId: request.attempt_id,
      leaseId: request.boundary_lease_id,
      activationId: request.boundary_activation_id,
    }
    : undefined;
}

export type StoredResumeRow = typeof generated_resumes.$inferSelect;

function applicationAttemptBinding(input: {
  row: StoredResumeRow;
  review: ApplicationReviewState;
  attemptId: string;
  source: SubmissionAttemptBinding['source'];
  operation?: SubmissionAttemptBinding['operation'];
  packetVersion?: string | null;
}): SubmissionAttemptBinding {
  return {
    attemptId: input.attemptId,
    userId: input.row.user_id,
    packetId: input.row.id,
    source: input.source,
    operation: input.operation ?? 'initial_submission',
    postingIdentity: freezePostingIdentity(input.row.job_context, input.review.portal_url),
    submissionRunId: input.review.submission_run_id ?? null,
    submissionClaimId: input.review.submission_claim_id ?? input.attemptId,
    packetVersion: input.packetVersion
      ?? input.review.packet_audit?.packet_version
      ?? input.review.submission_packet_version
      ?? null,
  };
}

async function persistedApplicationAttemptBinding(
  row: StoredResumeRow,
  attemptId: string,
  executor?: Pick<SubmissionAttemptLedgerExecutor, 'select'>,
): Promise<SubmissionAttemptBinding> {
  const events = await submissionAttemptEventsForPacket(row.user_id, row.id, { executor });
  const opened = events.find((event) => event.attempt_id === attemptId && event.event_kind === 'attempt_opened');
  if (!opened) throw new Error('Submission attempt reservation was not durably recorded');
  return submissionAttemptBindingFromEvent(opened);
}

async function appendApplicationAttemptFact(
  binding: SubmissionAttemptBinding,
  eventKind: SubmissionAttemptEventKind,
  factKey: string,
  options: {
    proofKind?: SubmissionNotSentProofKind;
    observedAt?: Date;
    evidenceCode?: string;
    executor?: SubmissionAttemptLedgerExecutor;
  } = {},
): Promise<void> {
  const { executor, ...eventOptions } = options;
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(binding.attemptId, eventKind, factKey),
    eventKind,
    ...eventOptions,
  }, { executor });
}

async function attendedManualAttemptBinding(
  row: StoredResumeRow,
  attemptId: string,
  executor?: Pick<SubmissionAttemptLedgerExecutor, 'select'>,
): Promise<SubmissionAttemptBinding | null> {
  try {
    const binding = await persistedApplicationAttemptBinding(row, attemptId, executor);
    return binding.source === 'attended_handoff' && binding.operation === 'manual_submission'
      ? binding
      : null;
  } catch {
    return null;
  }
}

async function attendedManualAttemptCapability(
  row: StoredResumeRow,
  attemptId: string,
  executor?: Pick<SubmissionAttemptLedgerExecutor, 'select'>,
): Promise<AttendedHandoffCapability | null> {
  const events = await submissionAttemptEventsForPacket(row.user_id, row.id, { executor });
  const opening = events.find((event) => event.attempt_id === attemptId
    && event.event_kind === 'attempt_opened'
    && event.source === 'attended_handoff'
    && event.operation === 'manual_submission');
  return attendedHandoffCapabilityFromEvidenceCode(opening?.evidence_code);
}

function exactSelfSubmitUrl(review: ApplicationReviewState): string | null {
  try {
    const parsed = new URL(review.portal_url ?? '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function exactManualHandoffUrl(row: StoredResumeRow, review: ApplicationReviewState): string | null {
  return verifiedDashboardHandoffUrl({
    applicationId: row.id,
    userId: row.user_id,
    frozenUrl: review.portal_url,
    frozenHandoffUrl: review.extension_handoff_url,
    frozenHandoffBinding: review.extension_handoff_binding,
    frozenAtsName: review.ats_name,
    status: review.status,
    attentionReason: review.attention_reason,
    attentionCategories: review.attention_categories,
    // The immutable ledger owns the reservation. URL verification evaluates the packet that was
    // reviewed immediately before that reservation, so the reservation must not invalidate itself.
    submissionClaimedAt: undefined,
    submissionClaimId: undefined,
    submissionPacketVersion: review.submission_packet_version,
    submissionAttemptedAt: review.submission_attempted_at,
    submittedAt: review.submitted_at,
    receipt: review.receipt,
    unverifiedSubmission: review.unverified_submission,
  });
}

function attendedCapabilityDashboardBinding(
  row: StoredResumeRow,
  review: ApplicationReviewState,
  kind: AttendedHandoffCapabilityKind,
): string {
  const audit = review.packet_audit;
  return attendedHandoffDashboardBindingSha256({
    version: 'attended_dashboard_binding_v1',
    kind,
    packet_version: audit?.packet_version ?? review.submission_packet_version ?? null,
    audit_digest: audit?.audit_digest ?? null,
    pdf_sha256: audit?.bindings.pdf.sha256 ?? null,
    resume_object_key: row.resume_object_key ?? null,
    submission_run_id: review.submission_run_id ?? null,
    extension_handoff_binding: kind === 'manual_handoff'
      ? review.extension_handoff_binding ?? null
      : null,
    documents: kind === 'self_submit' ? storedDocuments(row) : null,
  });
}

export function attendedHandoffCapabilityForRow(
  row: StoredResumeRow,
  review: ApplicationReviewState,
  kind: AttendedHandoffCapabilityKind,
): { capability: AttendedHandoffCapability; url: string } | null {
  const url = kind === 'manual_handoff'
    ? exactManualHandoffUrl(row, review)
    : exactSelfSubmitUrl(review);
  if (!url) return null;
  return {
    url,
    capability: createAttendedHandoffCapability({
      userId: row.user_id,
      applicationId: row.id,
      kind,
      canonicalUrl: url,
      dashboardBindingSha256: attendedCapabilityDashboardBinding(row, review, kind),
    }),
  };
}

/**
 * Derive the URL-free identity a first attended click would reserve, without reserving it.
 *
 * Passive polling cannot create an attempt or authorize an employer boundary, but the client must
 * still know which exact server-owned destination it is about to request. The route predicates are
 * kept here with the derivation so a generic ready row cannot accidentally advertise the wrong
 * attended route kind. A changed URL or dashboard projection produces a different hash, which also
 * prevents an older authorization tuple from being replayed against the new state.
 */
export function passiveAttendedHandoffCapabilityForRow(
  row: StoredResumeRow,
  review: ApplicationReviewState,
  options: { manualHandoffPacketValid: boolean },
): AttendedHandoffCapability | null {
  if (review.status === 'needs_attention' && options.manualHandoffPacketValid) {
    return attendedHandoffCapabilityForRow(row, review, 'manual_handoff')?.capability ?? null;
  }
  if (review.status === 'ready_for_final_approval'
    && documentAsksLitosCannotResolve(review, storedDocuments(row)).length > 0) {
    return attendedHandoffCapabilityForRow(row, review, 'self_submit')?.capability ?? null;
  }
  return null;
}

function attendedManualAttemptMatchesCurrent(
  row: StoredResumeRow,
  review: ApplicationReviewState,
  binding: SubmissionAttemptBinding,
): boolean {
  const packetVersion = review.packet_audit?.packet_version
    ?? review.submission_packet_version
    ?? null;
  return binding.userId === row.user_id
    && binding.packetId === row.id
    && binding.source === 'attended_handoff'
    && binding.operation === 'manual_submission'
    && review.submission_claim_id === binding.attemptId
    && binding.submissionClaimId === binding.attemptId
    && (binding.submissionRunId ?? null) === (review.submission_run_id ?? null)
    && (binding.packetVersion ?? null) === packetVersion
    && isDeepStrictEqual(
      binding.postingIdentity,
      freezePostingIdentity(row.job_context, review.portal_url),
    );
}

export function extensionAttemptBindingMatches(
  row: StoredResumeRow,
  review: ApplicationReviewState,
  claimId: string,
  binding: SubmissionAttemptBinding,
): boolean {
  const packetVersion = review.packet_audit?.packet_version
    ?? review.submission_packet_version
    ?? null;
  return binding.userId === row.user_id
    && binding.packetId === row.id
    && binding.source === 'chrome_extension'
    && binding.operation === 'initial_submission'
    && binding.attemptId === claimId
    && binding.submissionClaimId === claimId
    && (binding.submissionRunId ?? null) === (review.submission_run_id ?? null)
    && (binding.packetVersion ?? null) === packetVersion
    && isDeepStrictEqual(
      binding.postingIdentity,
      freezePostingIdentity(row.job_context, review.portal_url),
    );
}

export type ExtensionOutcomePacketVerification =
  | { valid: true }
  | { valid: false; response: { error: string; code: string } };

type ExtensionOutcomeCommitResult =
  | { kind: 'recorded' | 'replayed' | 'submitted_replay'; row: StoredResumeRow; review: ApplicationReviewState }
  | { kind: 'audit_failure'; row: StoredResumeRow; response: { error: string; code: string } }
  | { kind: 'binding_mismatch' | 'stale' | 'changed' | 'no_review'; row?: StoredResumeRow };

const EXTENSION_CONFIRMED_WRITE_RACE = 'EXTENSION_CONFIRMED_WRITE_RACE';

async function verifyExtensionOutcomePacket(
  row: StoredResumeRow,
  review: ApplicationReviewState,
): Promise<ExtensionOutcomePacketVerification> {
  const verdict = await currentAcknowledgedPacketAudit(row, {
    /* The extension may already have pressed Submit. Verify the exact snapshot captured by the
     * claim, not a new profile or clock reading that could change after the employer received it
     * and prevent Litos from recording the receipt. */
    questions: review.questions,
  });
  if (!verdict.valid) return { valid: false, response: packetAuditClientError(verdict) };
  if (review.submission_packet_version !== verdict.audit.packet_version) {
    return {
      valid: false,
      response: {
        error: 'The audited packet no longer matches the extension submission claim.',
        code: 'PACKET_AUDIT_STALE',
      },
    };
  }
  return { valid: true };
}

/**
 * Persist an extension outcome at the same linearization point as negative attempt resolution.
 *
 * The route performs its ownership read before entering here. It is intentionally not part of the
 * write precondition: a receipt may arrive after an unknown projection was persisted. The locked
 * row, immutable opening, exact claim, and canonical binding are the authorities for that replay.
 */
export async function commitExtensionSubmissionOutcome(input: {
  packetId: string;
  userId: string;
  claimId: string;
  reportedOutcome: ExtensionOutcome;
  confirmationText?: string;
  finalUrl: string;
}, dependencies: {
  verifyPacket?: (
    row: StoredResumeRow,
    review: ApplicationReviewState,
  ) => Promise<ExtensionOutcomePacketVerification>;
} = {}): Promise<ExtensionOutcomeCommitResult> {
  const verifyPacket = dependencies.verifyPacket ?? verifyExtensionOutcomePacket;
  try {
    return await db.transaction(async (tx) => {
      await lockSubmissionAttemptUser(tx, input.userId);
      const [latest] = await tx.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, input.packetId),
        eq(generated_resumes.user_id, input.userId),
      )).limit(1);
      if (!latest) return { kind: 'changed' as const };
      const current = readApplicationReview(latest.spec);
      if (!current) return { kind: 'no_review' as const, row: latest };

      let binding: SubmissionAttemptBinding;
      try {
        binding = await persistedApplicationAttemptBinding(latest, input.claimId, tx);
      } catch {
        return { kind: 'binding_mismatch' as const, row: latest };
      }
      if (!extensionAttemptBindingMatches(latest, current, input.claimId, binding)) {
        return { kind: 'binding_mismatch' as const, row: latest };
      }

      const outcome = input.reportedOutcome === 'confirmed' && !extensionEmployerReceiptIsSufficient({
        portalUrl: current.portal_url,
        atsName: current.ats_name,
        confirmationText: input.confirmationText,
        finalUrl: input.finalUrl,
      })
        ? 'unknown' as const
        : input.reportedOutcome;
      const exactClaim = current.submission_claim_id === input.claimId;
      const exactNegativeResolution = current.status === 'needs_attention'
        && !current.submission_claim_id
        && current.unverified_submission?.resolution === 'not_sent'
        && (current.unverified_submission.submission_run_id ?? null) === (binding.submissionRunId ?? null);
      const recoveredSubmittedReplay = current.status === 'submitted'
        && !current.submission_claim_id
        && current.receipt?.source === 'chrome_extension';
      const confirmedRecovery = outcome === 'confirmed'
        && (exactNegativeResolution || recoveredSubmittedReplay);
      if (!exactClaim && !confirmedRecovery) {
        return { kind: 'binding_mismatch' as const, row: latest };
      }
      if (binding.applicationId) {
        const [canonical] = await tx.select({ id: applications.id }).from(applications).where(and(
          eq(applications.id, binding.applicationId),
          eq(applications.user_id, input.userId),
          eq(applications.legacy_generated_resume_id, latest.id),
        )).limit(1);
        if (!canonical) return { kind: 'binding_mismatch' as const, row: latest };
      }

      if (current.status === 'submitted') {
        return { kind: 'submitted_replay' as const, row: latest, review: current };
      }
      const now = new Date().toISOString();
      const disposition = confirmedRecovery
        ? 'promote_confirmed' as const
        : extensionOutcomeClaimDisposition(current, input.claimId, outcome);
      if (disposition === 'stale') return { kind: 'stale' as const, row: latest };

      /* A sufficient exact employer receipt is external reality. Packet drift after the press may
       * explain why an acknowledgement is stale, but it cannot veto that receipt. The confirmation
       * fact and submitted projection below still commit or roll back together. */
      // A response retry and an unknown-to-confirmed promotion replay stable immutable fact ids.
      await appendApplicationAttemptFact(binding, 'press_observed', 'extension-outcome', {
        evidenceCode: 'extension_submit_may_have_been_pressed',
        executor: tx,
      });
      if (outcome === 'confirmed') {
        await appendApplicationAttemptFact(binding, 'submission_confirmed', 'extension-receipt', {
          evidenceCode: 'extension_receipt_verified',
          executor: tx,
        });
      }
      if (disposition === 'replay_unverified') {
        return { kind: 'replayed' as const, row: latest, review: current };
      }
      if (outcome !== 'confirmed') {
        const packet = await verifyPacket(latest, current);
        if (!packet.valid) {
          return { kind: 'audit_failure' as const, row: latest, response: packet.response };
        }
      }

      const outcomePatch = extensionOutcomePatch(outcome, now, {
        confirmationText: input.confirmationText,
        finalUrl: input.finalUrl,
        submissionRunId: current.submission_run_id,
      });
      const next = applyReviewPatch(current, {
        ...outcomePatch,
        ...(outcome === 'confirmed' && current.unverified_submission
          ? {
            unverified_submission: {
              ...current.unverified_submission,
              resolution: 'sent' as const,
              resolved_at: now,
            },
          }
          : {}),
      }, () => now);
      const [updated] = await tx.update(generated_resumes).set({
        spec: reviewSpec(next),
        ...(outcome === 'confirmed' ? { pipeline_stage: 'applied', pipeline_stage_at: new Date(now) } : {}),
      }).where(and(
        eq(generated_resumes.id, latest.id),
        eq(generated_resumes.user_id, input.userId),
        sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
        sql`${generated_resumes.resume_object_key} = ${latest.resume_object_key}`,
        ...(exactClaim
          ? [sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${input.claimId}`]
          : [sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' is null`]),
        sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
      )).returning();
      if (!updated) {
        if (outcome === 'confirmed') throw new Error(EXTENSION_CONFIRMED_WRITE_RACE);
        return { kind: 'changed' as const, row: latest };
      }
      const persisted = readApplicationReview(updated.spec);
      if (!persisted) {
        if (outcome === 'confirmed') throw new Error(EXTENSION_CONFIRMED_WRITE_RACE);
        return { kind: 'changed' as const, row: updated };
      }
      return { kind: 'recorded' as const, row: updated, review: persisted };
    });
  } catch (error) {
    if (error instanceof Error && error.message === EXTENSION_CONFIRMED_WRITE_RACE) {
      return { kind: 'changed' };
    }
    throw error;
  }
}

function finalApplicationAuthorizationMatches(
  review: ApplicationReviewState,
  binding: SubmissionAttemptBinding,
  user: {
    enabled: boolean | null;
    consentedAt: Date | null;
    consentVersion: string | null;
  } | undefined,
  automaticSubmissionEntitled: boolean,
): boolean {
  if (binding.source === 'attended_handoff' && binding.operation === 'manual_submission') return true;
  const authorization = review.submission_authorization;
  if (authorization?.source === 'per_application_approval') return true;
  if (authorization?.source === 'user_initiated_extension'
    && binding.source === 'chrome_extension') return true;
  if (authorization?.source !== 'standing_consent'
    || user?.enabled !== true
    || !automaticSubmissionEntitled) return false;
  return Boolean(authorization.consented_at)
    && authorization.consented_at === user.consentedAt?.toISOString()
    && Boolean(authorization.consent_version)
    && authorization.consent_version === user.consentVersion;
}

type AttendedManualReservation =
  | { kind: 'reserved'; row: StoredResumeRow; review: ApplicationReviewState; binding: SubmissionAttemptBinding }
  | { kind: 'changed' }
  | { kind: 'blocked' }
  | { kind: 'replay_mismatch' }
  | { kind: 'duplicate_risk'; verdict: Exclude<DuplicateApplicationVerdict, { kind: 'clear' }> };

type FinalApplicationBoundaryGate =
  | {
    kind: 'clear';
    authorization: SubmissionBoundaryAuthorization;
    replay: boolean;
    attendedHandoffCapability?: AttendedHandoffCapability;
  }
  | {
    kind: 'already_authorized';
    retrySafety: SubmissionAttemptRetrySafety;
  }
  | { kind: 'changed' }
  | {
    kind: 'blocked';
    verdict: Exclude<DuplicateApplicationVerdict, { kind: 'clear' }>;
    row: StoredResumeRow;
    review: ApplicationReviewState;
  };

/** Close a reserved capability if new duplicate evidence appears before it reaches an employer. */
export async function finalApplicationBoundaryGate(input: {
  row: StoredResumeRow;
  binding: SubmissionAttemptBinding;
  factKey: string;
  replay?: AttendedBoundaryReplay;
  attendedHandoffCapability?: AttendedHandoffCapability;
}): Promise<FinalApplicationBoundaryGate> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, input.row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, input.row.id),
      eq(generated_resumes.user_id, input.row.user_id),
    )).limit(1);
    const latestReview = latest ? readApplicationReview(latest.spec) : null;
    const latestPacketVersion = latestReview?.packet_audit?.packet_version
      ?? latestReview?.submission_packet_version
      ?? null;
    if (!latest
      || !latestReview
      || !sameApplicationPacketSpec(latest.spec, input.row.spec)
      || latest.resume_object_key !== input.row.resume_object_key
      || !isDeepStrictEqual(latest.job_context, input.row.job_context)
      || input.binding.packetId !== latest.id
      || latestReview.submission_claim_id !== input.binding.attemptId
      || (latestReview.submission_run_id ?? null) !== input.binding.submissionRunId
      || latestPacketVersion !== input.binding.packetVersion
      || !isDeepStrictEqual(
        freezePostingIdentity(latest.job_context, latestReview.portal_url),
        input.binding.postingIdentity,
      )) return { kind: 'changed' as const };
    if (input.attendedHandoffCapability) {
      const storedCapability = await attendedManualAttemptCapability(
        latest,
        input.binding.attemptId,
        tx,
      );
      if (!attendedHandoffCapabilitiesMatch(storedCapability, input.attendedHandoffCapability)) {
        return { kind: 'changed' as const };
      }
    }
    const existingReplayAuthorization = input.replay
      ? await submissionBoundaryAuthorization(input.binding.userId, input.binding.attemptId, {
        executor: tx,
      })
      : null;
    if (input.replay && (
      input.binding.source !== 'attended_handoff'
      || input.binding.operation !== 'manual_submission'
      || input.replay.attemptId !== input.binding.attemptId
      || !existingReplayAuthorization
      || !existingReplayAuthorization.active
      || input.replay.leaseId !== existingReplayAuthorization.leaseId
      || input.replay.activationId !== existingReplayAuthorization.activationId
    )) {
      return {
        kind: 'already_authorized' as const,
        retrySafety: await submissionAttemptRetrySafetyForPacket(
          input.binding.userId,
          input.binding.packetId,
          { executor: tx },
        ),
      };
    }
    let authorizationUser: {
      enabled: boolean | null;
      consentedAt: Date | null;
      consentVersion: string | null;
    } | undefined;
    let automaticSubmissionEntitled = false;
    if (latestReview.submission_authorization?.source === 'standing_consent') {
      [authorizationUser] = await tx.select({
        enabled: users.automatic_submission_enabled,
        consentedAt: users.automatic_submission_consented_at,
        consentVersion: users.automatic_submission_consent_version,
      }).from(users).where(eq(users.id, latest.user_id)).limit(1);
      automaticSubmissionEntitled = (await getEntitlementSnapshot(
        latest.user_id,
        new Date(),
        tx,
      )).features.automatic_submission;
    }
    if (!finalApplicationAuthorizationMatches(
      latestReview,
      input.binding,
      authorizationUser,
      automaticSubmissionEntitled,
    )) {
      const stoppedAt = new Date().toISOString();
      const stopped = applyReviewPatch(latestReview, {
        status: 'ready_for_final_approval',
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
        submission_authorization: undefined,
        submission_error: 'Submission authorization changed before the final employer boundary',
        attention_reason: 'Submission permission changed before the employer send. Review this application and approve it again before retrying.',
        attention_categories: ['evidence_gap'],
      }, () => stoppedAt);
      const rows = await tx.update(generated_resumes)
        .set({ spec: reviewSpec(stopped) })
        .where(and(
          eq(generated_resumes.id, input.row.id),
          eq(generated_resumes.user_id, input.row.user_id),
          sql`${generated_resumes.spec} = ${JSON.stringify(input.row.spec)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${input.binding.attemptId}`,
        ))
        .returning();
      if (!rows[0]) throw new Error('FINAL_SUBMISSION_BOUNDARY_CAS_RACE');
      await appendApplicationAttemptFact(input.binding, 'not_sent_proven', `${input.factKey}-authorization`, {
        proofKind: 'typed_pre_click_stop',
        evidenceCode: 'authorization_changed_before_external_boundary',
        observedAt: new Date(stoppedAt),
        executor: tx,
      });
      return { kind: 'changed' as const };
    }
    const verdict = await duplicateApplicationVerdict({
      userId: latest.user_id,
      applicationId: latest.id,
      jobContext: latest.job_context,
      portalUrl: latestReview.portal_url,
      excludeAttemptId: input.binding.attemptId,
    }, tx);
    if (verdict.kind === 'clear') {
      const authorization = await authorizeFinalSubmissionBoundary(input.binding, {
        executor: tx,
        factKey: input.factKey,
        evidenceCode: `${input.binding.source}_employer_boundary_authorized`,
        ...(input.replay ? { activationId: input.replay.activationId } : {}),
      });
      if (authorization.kind !== 'fresh' && authorization.kind !== 'existing') {
        return {
          kind: 'already_authorized' as const,
          retrySafety: authorization.retrySafety,
        };
      }
      if ((!input.replay && authorization.kind !== 'fresh')
        || (input.replay && authorization.kind !== 'existing')
        || (input.replay && (
          !authorization.authorization.active
          || authorization.authorization.leaseId !== input.replay.leaseId
          || authorization.authorization.attemptId !== input.replay.attemptId
          || authorization.authorization.activationId !== input.replay.activationId
        ))) {
        return {
          kind: 'already_authorized' as const,
          retrySafety: authorization.retrySafety,
        };
      }
      return {
        kind: 'clear' as const,
        authorization: authorization.authorization,
        replay: Boolean(input.replay),
        ...(input.attendedHandoffCapability
          ? { attendedHandoffCapability: input.attendedHandoffCapability }
          : {}),
      };
    }

    /* A replay describes a capability that was already exposed. New duplicate evidence may refuse
     * to re-deliver it, but it cannot truthfully convert that prior exposure into a pre-click stop.
     * Preserve the immutable boundary facts and the active claim for positive outcome recovery. */
    if (input.replay) {
      return {
        kind: 'blocked' as const,
        verdict,
        row: latest,
        review: latestReview,
      };
    }

    const stoppedAt = new Date().toISOString();
    const blocked = applyReviewPatch(latestReview, {
      status: 'needs_attention',
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
      submission_authorization: undefined,
      submission_error: 'Submission withheld by the final duplicate-safety recheck',
      attention_reason: verdict.reason,
      attention_categories: [verdict.kind === 'duplicate' && verdict.match.certainty === 'submitted'
        ? 'duplicate_application' : 'unverified_submission'],
    }, () => stoppedAt);
    const rows = await tx.update(generated_resumes)
      .set({ spec: reviewSpec(blocked) })
      .where(and(
        eq(generated_resumes.id, input.row.id),
        eq(generated_resumes.user_id, input.row.user_id),
        sql`${generated_resumes.spec} = ${JSON.stringify(input.row.spec)}::jsonb`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${input.binding.attemptId}`,
      ))
      .returning();
    if (!rows[0]) throw new Error('FINAL_SUBMISSION_BOUNDARY_CAS_RACE');
    await appendApplicationAttemptFact(input.binding, 'not_sent_proven', input.factKey, {
      proofKind: 'typed_pre_click_stop',
      evidenceCode: 'new_duplicate_evidence_before_external_boundary',
      observedAt: new Date(stoppedAt),
      executor: tx,
    });
    return { kind: 'blocked' as const, verdict, row: rows[0], review: blocked };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === 'FINAL_SUBMISSION_BOUNDARY_CAS_RACE') {
      return { kind: 'changed' as const };
    }
    throw error;
  });
}

export type AttendedHandoffFinalization =
  | {
    kind: 'clear';
    row: StoredResumeRow;
    review: ApplicationReviewState;
    authorization: SubmissionBoundaryAuthorization;
    retrySafety: SubmissionAttemptRetrySafety;
    attendedHandoffCapability: AttendedHandoffCapability;
    url: string;
  }
  | { kind: 'blocked'; retrySafety: SubmissionAttemptRetrySafety };

/**
 * Linearization point for an attended URL response.
 *
 * The first boundary gate can be followed by a receipt, press observation, expiry, or mutable row
 * update before the HTTP handler reaches reply.send. This second user-locked read constructs the
 * URL DTO only from the exact current row and the exact two-fact attempt. It appends nothing, so
 * concurrent exact replay can share an active capability without renewing or mutating it.
 */
export async function finalizeAttendedHandoffCapability(input: {
  row: StoredResumeRow;
  binding: SubmissionAttemptBinding;
  authorization: SubmissionBoundaryAuthorization;
  attendedHandoffCapability: AttendedHandoffCapability;
}): Promise<AttendedHandoffFinalization> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, input.row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, input.row.id),
      eq(generated_resumes.user_id, input.row.user_id),
    )).limit(1);
    if (!latest) return { kind: 'blocked' as const, retrySafety: { kind: 'no_evidence' as const } };
    const current = readApplicationReview(latest.spec);
    const retrySafety = await packetRetrySafety(latest, tx);
    if (!current
      || !sameApplicationPacketSpec(latest.spec, input.row.spec)
      || latest.resume_object_key !== input.row.resume_object_key
      || !isDeepStrictEqual(latest.job_context, input.row.job_context)
      || !attendedManualAttemptMatchesCurrent(latest, current, input.binding)) {
      return { kind: 'blocked' as const, retrySafety };
    }

    const events = (await submissionAttemptEventsForPacket(latest.user_id, latest.id, { executor: tx }))
      .filter((event) => event.attempt_id === input.binding.attemptId);
    const opening = events.find((event) => event.event_kind === 'attempt_opened');
    const boundary = await submissionBoundaryAuthorization(
      latest.user_id,
      input.binding.attemptId,
      { executor: tx },
    );
    const storedCapability = attendedHandoffCapabilityFromEvidenceCode(opening?.evidence_code);
    const currentCapability = attendedHandoffCapabilityForRow(
      latest,
      current,
      input.attendedHandoffCapability.kind,
    );
    const exactTwoFactAttempt = events.length === 2
      && events.filter((event) => event.event_kind === 'attempt_opened').length === 1
      && events.filter((event) => event.event_kind === 'boundary_authorized').length === 1;
    const exactRetrySafety = retrySafety.kind === 'blocked_unverified'
      && retrySafety.reason === 'boundary_authorized'
      && retrySafety.attemptId === input.binding.attemptId
      && retrySafety.leaseId === input.authorization.leaseId
      && retrySafety.expiresAt === input.authorization.expiresAt;
    const exactAuthorization = boundary?.active === true
      && boundary.attemptId === input.authorization.attemptId
      && boundary.leaseId === input.authorization.leaseId
      && boundary.activationId === input.authorization.activationId
      && boundary.authorizedAt === input.authorization.authorizedAt
      && boundary.expiresAt === input.authorization.expiresAt;
    if (!exactTwoFactAttempt
      || !exactRetrySafety
      || !exactAuthorization
      || !currentCapability
      || !attendedHandoffCapabilitiesMatch(storedCapability, input.attendedHandoffCapability)
      || !attendedHandoffCapabilitiesMatch(currentCapability.capability, input.attendedHandoffCapability)) {
      return { kind: 'blocked' as const, retrySafety };
    }
    return {
      kind: 'clear' as const,
      row: latest,
      review: current,
      authorization: boundary,
      retrySafety,
      attendedHandoffCapability: currentCapability.capability,
      url: currentCapability.url,
    };
  });
}

/** Reserve the exact employer capability before a live/manual control is returned to the client. */
export async function reserveAttendedManualAttempt(
  row: StoredResumeRow,
  reviewedSnapshot: ApplicationReviewState,
  options: {
    replayAttemptId?: string;
    attendedHandoffCapability?: AttendedHandoffCapability;
  } = {},
): Promise<AttendedManualReservation> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1);
    if (!latest || !sameApplicationPacketSpec(latest.spec, row.spec)) return { kind: 'changed' as const };

    const current = readApplicationReview(latest.spec);
    if (!current) return { kind: 'changed' as const };
    if (options.replayAttemptId && current.submission_claim_id !== options.replayAttemptId) {
      return { kind: 'replay_mismatch' as const };
    }
    if (current.submission_claim_id) {
      const [binding, storedCapability] = await Promise.all([
        attendedManualAttemptBinding(latest, current.submission_claim_id, tx),
        attendedManualAttemptCapability(latest, current.submission_claim_id, tx),
      ]);
      const capabilityMatches = !options.attendedHandoffCapability
        || attendedHandoffCapabilitiesMatch(storedCapability, options.attendedHandoffCapability);
      return binding && capabilityMatches
        ? {
          kind: 'reserved' as const,
          row: latest,
          review: {
            ...current,
            portal_url: reviewedSnapshot.portal_url,
            questions: reviewedSnapshot.questions,
          },
          binding,
        }
        : { kind: 'blocked' as const };
    }

    const duplicate = await duplicateApplicationVerdict({
      userId: latest.user_id,
      applicationId: latest.id,
      jobContext: latest.job_context,
      portalUrl: reviewedSnapshot.portal_url,
    }, tx);
    if (duplicate.kind !== 'clear') {
      return { kind: 'duplicate_risk' as const, verdict: duplicate };
    }

    const attemptId = randomUUID();
    const reservedAt = new Date().toISOString();
    const reserved = applyReviewPatch(
      reviewedSnapshot,
      submissionClaimPatch(reservedAt, attemptId),
      () => reservedAt,
    );
    const rows = await tx.update(generated_resumes)
      .set({ spec: reviewSpec(reserved) })
      .where(and(
        eq(generated_resumes.id, latest.id),
        eq(generated_resumes.user_id, latest.user_id),
        sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null`,
      ))
      .returning();
    if (!rows[0]) return { kind: 'changed' as const };

    const binding = applicationAttemptBinding({
      row: rows[0],
      review: reserved,
      attemptId,
      source: 'attended_handoff',
      operation: 'manual_submission',
    });
    await appendApplicationAttemptFact(binding, 'attempt_opened', 'manual-handoff-reservation', {
      evidenceCode: options.attendedHandoffCapability
        ? attendedHandoffCapabilityEvidenceCode(options.attendedHandoffCapability)
        : 'manual_employer_boundary_reserved_before_exposure',
      observedAt: new Date(reservedAt),
      executor: tx,
    });
    return { kind: 'reserved' as const, row: rows[0], review: reserved, binding };
  });
}

function legacyApplicationAttemptId(row: StoredResumeRow, review: ApplicationReviewState): string {
  if (review.submission_claim_id && z.string().uuid().safeParse(review.submission_claim_id).success) {
    return review.submission_claim_id;
  }
  // Stable UUIDv5 bridge for rows written before attempt ids existed. It is also the id the
  // resolution route uses when it appends the one-time legacy opening fact.
  return submissionAttemptEventId(row.id, 'attempt_opened', 'legacy-attempt-identity');
}

export function mergeSubmissionRetrySafety(
  ledger: SubmissionAttemptRetrySafety,
  mutable: SubmissionAttemptRetrySafety,
): SubmissionAttemptRetrySafety {
  if (ledger.kind === 'blocked_confirmed') return ledger;
  if (mutable.kind === 'blocked_confirmed') return mutable;
  if (ledger.kind === 'blocked_unverified') return ledger;
  if (mutable.kind === 'blocked_unverified') return mutable;
  if (ledger.kind === 'safe_not_sent') return ledger;
  return mutable;
}

async function packetRetrySafety(
  row: StoredResumeRow,
  executor?: Pick<SubmissionAttemptLedgerExecutor, 'select'>,
): Promise<SubmissionAttemptRetrySafety> {
  const ledgerSafety = await submissionAttemptRetrySafetyForPacket(row.user_id, row.id, { executor });
  const review = readApplicationReview(row.spec);
  if (!review) return ledgerSafety;
  const attemptId = legacyApplicationAttemptId(row, review);
  let mutableSafety: SubmissionAttemptRetrySafety = { kind: 'no_evidence' };
  if (review.status === 'submitted' || review.submitted_at || review.receipt) {
    mutableSafety = {
      kind: 'blocked_confirmed',
      attemptId,
      confirmedAt: review.submitted_at ?? review.receipt?.captured_at ?? review.updated_at,
    };
  } else if (review.unverified_submission && !review.unverified_submission.resolution) {
    mutableSafety = {
      kind: 'blocked_unverified',
      attemptId,
      at: review.unverified_submission.at,
      reason: 'pressed',
    };
  } else if (review.submission_claimed_at
    || (review.submission_attempted_at && review.unverified_submission?.resolution !== 'not_sent')) {
    mutableSafety = {
      kind: 'blocked_unverified',
      attemptId,
      at: review.submission_attempted_at ?? review.submission_claimed_at ?? review.updated_at,
      reason: review.submission_attempted_at ? 'pressed' : 'opened',
    };
  }
  return mergeSubmissionRetrySafety(ledgerSafety, mutableSafety);
}

export function resolvedUnverifiedAttemptReplayMatches(
  pending: NonNullable<ApplicationReviewState['unverified_submission']>,
  attemptId: string,
  events: readonly Pick<SubmissionAttemptEventRecord,
    'attempt_id' | 'event_kind' | 'evidence_code' | 'observed_at'>[],
): boolean {
  if (!pending.resolution || !pending.resolved_at) return false;
  const expectedKind = pending.resolution === 'sent' ? 'submission_confirmed' : 'not_sent_proven';
  const expectedEvidence = pending.resolution === 'sent'
    ? 'applicant_found_submission'
    : 'applicant_checked_not_sent';
  return events.some((event) => event.attempt_id === attemptId
    && event.event_kind === expectedKind
    && event.evidence_code === expectedEvidence
    && event.observed_at.toISOString() === pending.resolved_at);
}

export function ledgerBlockedUnverifiedProjection(
  current: Pick<ApplicationReviewState, 'portal_url'>,
  retrySafety: SubmissionAttemptRetrySafety,
  attemptId: string,
  opening: Pick<SubmissionAttemptEventRecord,
    'attempt_id' | 'event_kind' | 'observed_at' | 'submission_run_id'> | undefined,
): NonNullable<ApplicationReviewState['unverified_submission']> | undefined {
  if (retrySafety.kind !== 'blocked_unverified'
    || retrySafety.attemptId !== attemptId
    || !opening
    || opening.attempt_id !== attemptId
    || opening.event_kind !== 'attempt_opened') return undefined;
  return {
    at: retrySafety.at,
    cause: 'provider_error',
    ...(current.portal_url ? { portal_url: current.portal_url } : {}),
    ...(opening.submission_run_id ? { submission_run_id: opening.submission_run_id } : {}),
  };
}

export const UNVERIFIED_LEDGER_RECOVERY_STALE_MS = 15 * 60 * 1000;

/** Opening-only recovery is a crash door, never a way to cancel a live runner claim. */
export function unverifiedLedgerRecoveryClaimIsStale(
  review: Pick<ApplicationReviewState, 'status' | 'submission_claimed_at'>,
  now = new Date(),
): boolean {
  if (!review.submission_claimed_at) return review.status !== 'submitting';
  const claimedAt = new Date(review.submission_claimed_at);
  if (Number.isNaN(claimedAt.getTime()) || claimedAt.getTime() > now.getTime()) return false;
  return now.getTime() - claimedAt.getTime() >= UNVERIFIED_LEDGER_RECOVERY_STALE_MS;
}

/** A managed continuation can be applicant-cleared only after its persisted provider budget ends. */
export function managedContinuationCallbackMayBeLive(
  review: Pick<ApplicationReviewState, 'verification'>,
  boundary: Awaited<ReturnType<typeof submissionBoundaryAuthorization>>,
): boolean {
  const verification = review.verification;
  if (verification?.runner !== 'stratus-managed') return false;
  if (verification.continuation_resumed === false) return false;
  if (verification.continuation_resumed !== true || !verification.continuation_call_deadline_at || !boundary) {
    return true;
  }
  const deadline = Date.parse(verification.continuation_call_deadline_at);
  const serverNow = Date.parse(boundary.serverNow);
  return !Number.isFinite(deadline) || !Number.isFinite(serverNow) || serverNow < deadline;
}

const SUBMISSION_ATTEMPT_RESOLUTION_RACE = 'SUBMISSION_ATTEMPT_RESOLUTION_RACE';

export function exactAttemptPermanentlyBlocksNegativeResolution(
  events: readonly SubmissionAttemptEventRecord[],
  attemptId: string,
): boolean {
  const exact = events.filter((event) => event.attempt_id === attemptId);
  if (exact.some((event) => event.event_kind === 'submission_confirmed')) return true;
  const opening = exact.find((event) => event.event_kind === 'attempt_opened');
  const first = opening ?? exact[0];
  /* A migration fact is created only after the release drain has ended every old callback and
     employer capability. Its press records historical uncertainty, not a still-live writer. The
     applicant's explicit portal and email check is therefore allowed to close that exact legacy
     attempt. Every runtime press remains permanent risk because its callback may outlive us. */
  if (first?.source === 'legacy_backfill') return false;
  if (exact.some((event) => event.event_kind === 'press_observed')) return true;
  const boundary = exact.find((event) => event.event_kind === 'boundary_authorized');
  if (!boundary) return false;
  const capability = opening ?? boundary;
  // A live employer capability can outlive, outpace, or lose its response to this process. Once
  // authorized, none of these machine or attended channels may turn a later applicant answer into
  // retry B. Only a migration-created legacy fact lacks a live capability at its recorded boundary.
  return capability.source !== 'legacy_backfill';
}

/** Commit the generic applicant resolution at the same per-user linearization point as send facts. */
export async function commitUnverifiedSubmissionResolution(input: {
  row: StoredResumeRow;
  userId: string;
  attemptId: string;
  found: boolean;
  replaceResolvedMutableProjection?: boolean;
  current: ApplicationReviewState;
  pending: NonNullable<ApplicationReviewState['unverified_submission']>;
  next: ApplicationReviewState;
  now: string;
}): Promise<StoredResumeRow[]> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, input.userId);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, input.row.id),
      eq(generated_resumes.user_id, input.userId),
    )).limit(1);
    if (!latest || !sameApplicationPacketSpec(latest.spec, input.row.spec)) {
      throw new Error(SUBMISSION_ATTEMPT_RESOLUTION_RACE);
    }
    const lockedReview = readApplicationReview(latest.spec);
    if (!lockedReview) throw new Error(SUBMISSION_ATTEMPT_RESOLUTION_RACE);
    const events = await submissionAttemptEventsForPacket(input.row.user_id, input.row.id, { executor: tx });
    const existingOpening = events.find((event) => event.attempt_id === input.attemptId
      && event.event_kind === 'attempt_opened');
    const exactAttemptEvents = events.filter((event) => event.attempt_id === input.attemptId);
    const immutableOnlyRecovery = !lockedReview.unverified_submission;
    /* A press cannot become unsent again. An extension or attended manual boundary likewise keeps
     * its duplicate risk after lease expiry. This veto runs before boundary metadata is parsed. */
    if (!input.found && exactAttemptPermanentlyBlocksNegativeResolution(events, input.attemptId)) {
      throw new Error(SUBMISSION_ATTEMPT_RESOLUTION_RACE);
    }
    const boundaryAuthorization = await submissionBoundaryAuthorization(
      input.row.user_id,
      input.attemptId,
      { executor: tx },
    );
    if (!input.found && immutableOnlyRecovery && (
      !unverifiedLedgerRecoveryClaimIsStale(lockedReview)
      || boundaryAuthorization?.active
      || Boolean(boundaryAuthorization && exactAttemptEvents.some((event) =>
        event.event_kind === 'press_observed' || event.event_kind === 'submission_confirmed'))
    )) throw new Error(SUBMISSION_ATTEMPT_RESOLUTION_RACE);
    if (!input.found && !immutableOnlyRecovery && (
      boundaryAuthorization?.active
      || managedContinuationCallbackMayBeLive(lockedReview, boundaryAuthorization)
    )) {
      throw new Error(SUBMISSION_ATTEMPT_RESOLUTION_RACE);
    }
    const binding = existingOpening
      ? submissionAttemptBindingFromEvent(existingOpening)
      : applicationAttemptBinding({
        row: input.row,
        review: input.current,
        attemptId: input.attemptId,
        source: 'legacy_backfill',
      });
    if (!existingOpening) {
      await appendApplicationAttemptFact(binding, 'attempt_opened', 'legacy-resolution-bridge', {
        evidenceCode: 'legacy_unverified_resolution_bridge',
        observedAt: new Date(input.pending.at),
        executor: tx,
      });
    }
    await appendApplicationAttemptFact(
      binding,
      input.found ? 'submission_confirmed' : 'not_sent_proven',
      'applicant-resolution',
      {
        ...(input.found ? {} : { proofKind: 'applicant_checked_not_sent' as const }),
        evidenceCode: input.found ? 'applicant_found_submission' : 'applicant_checked_not_sent',
        observedAt: new Date(input.now),
        executor: tx,
      },
    );
    const rows = await tx.update(generated_resumes)
      .set({ spec: reviewSpec(input.next) })
      .where(and(
        eq(generated_resumes.id, input.row.id),
        eq(generated_resumes.user_id, input.userId),
        sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
        ...(input.current.submission_claim_id
          ? [sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${input.current.submission_claim_id}`]
          : [sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' is null`]),
        ...(input.pending.submission_run_id
          ? [sql`${generated_resumes.spec}->'_review'->>'submission_run_id' = ${input.pending.submission_run_id}`]
          : []),
        ...(input.replaceResolvedMutableProjection
          ? []
          : [sql`${generated_resumes.spec}->'_review'->'unverified_submission'->>'resolution' is null`]),
      ))
      .returning();
    if (!rows.length) throw new Error(SUBMISSION_ATTEMPT_RESOLUTION_RACE);
    return rows;
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message === SUBMISSION_ATTEMPT_RESOLUTION_RACE) return [];
    throw error;
  });
}

async function recordAttendedSubmissionFact(
  binding: SubmissionAttemptBinding,
  observedAt: Date,
  factKey: string,
  executor: SubmissionAttemptLedgerExecutor,
): Promise<void> {
  await appendApplicationAttemptFact(binding, 'press_observed', `${factKey}-press`, {
    evidenceCode: 'applicant_attended_submission',
    observedAt,
    executor,
  });
  await appendApplicationAttemptFact(binding, 'submission_confirmed', `${factKey}-receipt`, {
    evidenceCode: 'attended_receipt_confirmed',
    observedAt,
    executor,
  });
}

/** Semantic equality for the packet version that passed an out-of-transaction verification. */
export function sameApplicationPacketSpec(validated: unknown, current: unknown): boolean {
  return isDeepStrictEqual(validated, current);
}

/** The employer a packet is for, so answerReuse can hold back anything that names them. */
function applicationCompany(row: StoredResumeRow): string {
  const context = (row.job_context && typeof row.job_context === 'object' ? row.job_context : {}) as Record<string, unknown>;
  return typeof context.company === 'string' ? context.company.trim() : '';
}

/** The monitored_jobs posting behind a packet, or null. Audit only on the saved-answer row. */
function applicationJobId(row: StoredResumeRow): string | null {
  const context = (row.job_context && typeof row.job_context === 'object' ? row.job_context : {}) as Record<string, unknown>;
  const jobId = context.job_id;
  return typeof jobId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)
    ? jobId
    : null;
}
const statusBodySchema = z.object({
  status: z.literal('failed'),
  error: z.string().max(2000).optional(),
});
/* Her answer after she has looked, and nothing more. Deliberately a BOOLEAN rather than a status:
   the applicant is being asked one question about one page in front of her, not asked to pick a
   state for a packet. Litos turns it into the state. */
const unverifiedOutcomeBodySchema = z.object({
  found: z.boolean(),
  attempt_id: z.string().uuid(),
});
const extensionStartBodySchema = z.object({
  authorization: z.enum(['standing_consent', 'user_initiated']),
  handoff_version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  current_url: z.string().url().max(4000).optional(),
});
const extensionReceiptUrlSchema = z.string().url().max(4000).refine(isSafeExtensionReceiptUrl, 'Confirmation URL must use HTTPS');
const extensionOutcomeBodySchema = z.object({
  claim_id: z.string().uuid(),
  outcome: z.enum(['confirmed', 'failed', 'unknown', 'cancelled']),
  confirmation_text: z.string().max(2000).optional(),
  final_url: extensionReceiptUrlSchema,
});
const handoffCompleteBodySchema = z.object({
  attempt_id: z.string().uuid(),
  outcome: z.enum(['cleared', 'submitted']).default('cleared'),
  confirmation_text: z.string().max(2000).optional(),
  final_url: extensionReceiptUrlSchema.optional(),
});
const selfSubmittedBodySchema = z.object({
  attempt_id: z.string().uuid(),
});

type StoredSpec = Record<string, unknown>;
type StoredContact = {
  full_name?: string;
  email?: string;
  phone?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
};
type ParsedProfileForResume = {
  school?: string;
  degree?: string;
  grad_date?: string;
  grad_year?: number;
  currently_enrolled?: boolean;
  coursework?: string[];
  gpa?: string;
  gpa_scale?: string;
  school_location?: string;
  recent_experience_review?: { selected_entry_id?: string | null; continue_with_found?: boolean };
};

// Every _review write in this file goes through settleStall, including the six that predate stalls
// and know nothing about them. Enforcing it HERE rather than at each call site is the whole point:
// the handoff-complete route moves an application out of needs_attention immediately after the
// applicant clears a challenge, and a rule that each writer has to remember is a rule that holds
// only until someone adds the next writer.
function reviewSpec(review: unknown) {
  const settled = review && typeof review === 'object' && !Array.isArray(review)
    ? settleStall(review as ApplicationReviewState)
    : review;
  return sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(settled)}::jsonb, true)`;
}

function approvedReviewSpec(review: unknown, approvedAt: string) {
  return sql`jsonb_set(${reviewSpec(review)}, '{_cover_letter,approved_at}', ${JSON.stringify(approvedAt)}::jsonb, true)`;
}

/* Exported for its own test. Which state a re-run clears and which it carries forward is the whole
 * of the duplicate-safety story, and it was being asserted only indirectly, through routes. */
export function freshSubmitRequestReview(
  current: ApplicationReviewState,
  questions: ApplicationReviewQuestion[],
  /* The review round the questions above were stamped against. Optional so every caller that has
   * nothing new to record keeps the stored round, and required in spirit for the one that does: a
   * question carrying answer_reviewed_at next to a review carrying a different (or no)
   * questions_reviewed_at is a claim the next reader has to throw away. See submit-request's call
   * site for the 130 packets that were in exactly that state. */
  questionsReviewedAt?: string,
): ApplicationReviewState {
  return {
    ...current,
    questions,
    ...(questionsReviewedAt ? { questions_reviewed_at: questionsReviewedAt } : {}),
    status: 'submit_requested',
    updated_at: new Date().toISOString(),
    submission_run_id: randomUUID(),
    attention_reason: undefined,
    /* Her ticks annotate the attention_reason being cleared on the line above, so they go with it.
     * A fresh run writes a fresh report, and a tick carried onto it would claim she acknowledged
     * sentences that have not been written yet. See attention_acknowledgements in
     * applicationReview.ts. */
    attention_acknowledgements: undefined,
    handoff_expires_at: undefined,
    browser_context_id: undefined,
    browser_session_id: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_authorization: undefined,
    final_approved_at: undefined,
    filled_fields: undefined,
    preview_screenshot_url: undefined,
    submission_error: undefined,
    verification: undefined,
    receipt: undefined,
    stall: undefined,
    /* THE ANSWER EXPIRES WITH THE RUN THAT PROMPTED IT.
     *
     * "I looked and it is not there" is true about ONE attempt. Leaving it on the row makes it true
     * forever: the next uncertain run lands in claimed needs_attention still carrying the stale
     * not_sent, submitRequestDisposition reads it and returns 'start', and the post-click duplicate
     * lock for that posting is off permanently, after a single honest answer.
     *
     * The route's own comment says the packet is "re-runnable exactly once". This is the line that
     * makes that true. */
    unverified_submission: undefined,
    /* AND SO DOES THE PRESS THE ANSWER WAS ABOUT. submission_attempted_at describes the same
     * attempt the unverified record (cleared above) recorded, and it is the other half of the
     * evidence pair employerMayHoldApplication reads. Clearing one without the other minted a row
     * no code path could exit - measured on the Easy Dynamics Rippling packet, 2026-08-20: her
     * not_sent answer was consumed by this reset, the refused re-run left the row at
     * needs_attention, and the ORPHANED attempted_at held every send-adjacent surface shut with
     * no resolution record left to excuse it. A fresh round starts with clean evidence; a new
     * press writes a fresh attempted_at beside a fresh unverified record. */
    submission_attempted_at: undefined,
    /* AND THE TYPED STOP EXPIRES WITH IT, for the same reason and with more force. "This run stopped
     * before the click" is a fact about the run that just ended; left on the row it would still be
     * answering yes after the NEXT run pressed Send, so submissionProvablyNotSent would reopen a
     * packet an employer really holds. Cleared here and again at every claim (see claimSubmission),
     * because this route is not the only way a send starts. */
    submission_stop: undefined,
  };
}

async function ownedResume(request: FastifyRequest, reply: FastifyReply) {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid application id' });
    return null;
  }
  const rows = await db
    .select()
    .from(generated_resumes)
    .where(
      and(
        eq(generated_resumes.id, parsed.data.id),
        eq(generated_resumes.user_id, request.jwtPayload!.userId),
      ),
    )
    .limit(1);
  if (!rows[0]) {
    reply.status(404).send({ error: 'Application not found' });
    return null;
  }
  return rows[0];
}

/* REPAIR ON LOAD, IN THE SHAPE restoreExpiredResume ALREADY SET: the row is healed at the moment a
 * route loads it, with an exact CAS, and the caller keeps working with the healed row.
 *
 * THE TRAP THIS LIFTS, measured live 2026-08-20 on the Fully (teamtailor) packet. A managed run
 * claimed the send, filled the whole form, and parked at the attended consent handoff WITHOUT
 * pressing send - status needs_attention, no submitted_at, no submission_attempted_at, no
 * unverified_submission, no receipt. The claim it still wore then refused the packet audit
 * ("This application can no longer be audited before submission") and refused every re-run
 * (submitRequestDisposition rejects claimed needs_attention, and its only key exists for runs whose
 * press outcome was unknown, which this run's provably was not). The attended finish needs
 * extension >= 0.5.10 while the store serves 0.5.9, and the 55-minute handoff window was long past:
 * a row nothing could ever move again, guarding a send its own record says never happened.
 *
 * The evidence rule lives in lib/expiredHandoffClaimRelease.ts; this helper is only the write. The
 * CAS is against the exact spec that was read, so a run taking the row concurrently wins and the
 * release simply does not happen - null on any miss, and the caller proceeds with the stored row,
 * whose gates then refuse exactly as they did before. That is the safe failure direction: a missed
 * release costs one more request, a wrong release could cost a duplicate application. */
export async function repairExpiredAttendedHandoffClaim(
  row: NonNullable<Awaited<ReturnType<typeof ownedResume>>>,
  userId: string,
  log: FastifyRequest['log'],
): Promise<NonNullable<Awaited<ReturnType<typeof ownedResume>>> | null> {
  const healed = await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, userId);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, userId),
    )).limit(1);
    if (!latest || !sameApplicationPacketSpec(latest.spec, row.spec)) return null;
    const current = readApplicationReview(latest.spec);
    if (!current?.submission_claim_id || !expiredAttendedHandoffClaimIsReleasable(current)) return null;

    const attemptEvents = await submissionAttemptEventsForPacket(userId, latest.id, { executor: tx });
    const opening = attemptEvents.find((event) => event.attempt_id === current.submission_claim_id
      && event.event_kind === 'attempt_opened');
    if (!opening || attemptEvents.some((event) => event.attempt_id === current.submission_claim_id
      && (
        event.event_kind === 'boundary_authorized'
        || event.event_kind === 'press_observed'
        || event.event_kind === 'submission_confirmed'
      ))) return null;

    const [extensionOutcome] = await tx.select({ id: application_submission_events.id })
      .from(application_submission_events)
      .innerJoin(applications, eq(application_submission_events.application_id, applications.id))
      .where(and(
        eq(application_submission_events.user_id, userId),
        eq(applications.user_id, userId),
        eq(applications.legacy_generated_resume_id, latest.id),
      ))
      .limit(1);
    if (extensionOutcome) return null;

    const releasedAt = new Date().toISOString();
    const released = releaseExpiredAttendedHandoffClaim(current, releasedAt);
    const updated = await tx.update(generated_resumes)
      .set({ spec: reviewSpec(released) })
      .where(and(
        eq(generated_resumes.id, latest.id),
        eq(generated_resumes.user_id, userId),
        sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${current.submission_claim_id}`,
      ))
      .returning();
    if (!updated[0]) return null;
    await appendApplicationAttemptFact(
      submissionAttemptBindingFromEvent(opening),
      'not_sent_proven',
      'expired-attended-handoff-release',
      {
        proofKind: 'typed_pre_click_stop',
        evidenceCode: 'expired_attended_handoff_proven_before_press',
        observedAt: new Date(releasedAt),
        executor: tx,
      },
    );
    return { row: updated[0], released, current };
  });
  if (!healed) return null;
  log.info(
    {
      applicationId: row.id,
      releasedClaimId: healed.released.claim_released?.claim_id ?? null,
      handoffExpiredAt: healed.current.handoff_expires_at,
    },
    'Released the submission claim of an expired attended handoff whose run never pressed send',
  );
  return healed.row;
}

export type AttendedHandoffNotSentCompletion =
  | { kind: 'completed'; row: StoredResumeRow; review: ApplicationReviewState }
  | { kind: 'active_boundary' }
  | { kind: 'missing_boundary' }
  | { kind: 'boundary_risk' }
  | { kind: 'changed' };

/**
 * Resolve an attended handoff as not sent only while its exact employer boundary has never been
 * authorized. Boundary expiry ends a replay lease, not the uncertainty created by exposing a real
 * submit capability. The decision, row CAS, and immutable applicant proof share the user advisory
 * lock, so authorization and negative resolution linearize in the safe direction.
 */
export async function completeAttendedHandoffNotSent(
  row: StoredResumeRow,
  userId: string,
  attemptId: string,
): Promise<AttendedHandoffNotSentCompletion> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, userId);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, userId),
    )).limit(1);
    if (!latest
      || latest.resume_object_key !== row.resume_object_key
      || !sameApplicationPacketSpec(latest.spec, row.spec)) return { kind: 'changed' as const };
    const lockedReview = readApplicationReview(latest.spec);
    if (!lockedReview
      || lockedReview.status !== 'needs_attention'
      || lockedReview.submission_claim_id !== attemptId) return { kind: 'changed' as const };
    const lockedAttempt = await attendedManualAttemptBinding(latest, attemptId, tx);
    if (!lockedAttempt) return { kind: 'missing_boundary' as const };
    const exactEvents = (await submissionAttemptEventsForPacket(userId, latest.id, { executor: tx }))
      .filter((event) => event.attempt_id === attemptId);
    const boundary = await submissionBoundaryAuthorization(userId, attemptId, { executor: tx });
    const hasBoundaryFact = exactEvents.some((event) => event.event_kind === 'boundary_authorized');
    if (hasBoundaryFact && boundary?.active) return { kind: 'active_boundary' as const };
    if (hasBoundaryFact
      || exactEvents.some((event) => event.event_kind === 'press_observed'
      || event.event_kind === 'submission_confirmed')) return { kind: 'boundary_risk' as const };

    const resolvedAt = new Date().toISOString();
    const next = {
      ...lockedReview,
      status: 'ready_for_final_approval' as const,
      attention_reason: undefined,
      attention_acknowledgements: undefined,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
      submission_authorization: undefined,
      updated_at: resolvedAt,
    };
    const rows = await tx.update(generated_resumes)
      .set({ spec: reviewSpec(next) })
      .where(and(
        eq(generated_resumes.id, latest.id),
        eq(generated_resumes.user_id, userId),
        sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
        sql`${generated_resumes.resume_object_key} = ${latest.resume_object_key}`,
        sql`${generated_resumes.spec}->'_review'->>'status' = 'needs_attention'`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${attemptId}`,
      ))
      .returning();
    if (!rows[0]) return { kind: 'changed' as const };
    await appendApplicationAttemptFact(lockedAttempt, 'not_sent_proven', 'handoff-cleared', {
      proofKind: 'applicant_checked_not_sent',
      evidenceCode: 'applicant_cleared_handoff_without_submitting',
      observedAt: new Date(resolvedAt),
      executor: tx,
    });
    return { kind: 'completed' as const, row: rows[0], review: next };
  });
}

function editableResumeSpec(value: unknown): ResumeSpec {
  const spec = normalizeSpec(value);
  if (!spec.school && spec.experience.length === 0 && spec.skills.length === 0) {
    throw new Error('Resume content is empty');
  }
  return spec;
}

/* Everything a resume edit must carry over from the packet it is editing.
 *
 * WHAT IS ABSENT FROM THIS LIST IS DELETED BY SAVING AN EDIT, silently. PATCH
 * /applications/:id/resume rebuilds the whole packet out of `rendered.spec`, and rendered.spec is a
 * ResumeSpec: normalizeSpec (llm/resumeSpec.ts:194) reconstructs it field by field from a fixed
 * allowlist, so every underscore-prefixed key the stored packet carried is gone by the time it comes
 * back. The rebuild is not adding to the spec; it is replacing it.
 *
 * _documents is on this list because it was left off the inline version of it. A student who
 * attached a transcript and then fixed one bullet on the review screen lost the attachment: the
 * PATCH answered 200, the spec came back without _documents, and the send gate then asked her for
 * the same file again with nothing on screen to say why. Every other underscore key present in the
 * codebase was carried; the one the newest feature added was not, because the allowlist lives at a
 * call site nobody edits when they add a key.
 *
 * WHAT IS DELIBERATELY NOT HERE: _contact, _review and _quality. All three are recomputed by the
 * edit, so carrying them forward would write the pre-edit values back over the new ones.
 */
const PRESERVED_APPLICATION_SPEC_KEYS = [
  '_applicant_email',
  '_application_email',
  '_cover_letter',
  '_documents',
] as const;

/**
 * The keys above, as they stand on the stored packet, ready to spread into a rebuilt spec.
 *
 * A function rather than three conditional spreads inline, because the inline form cannot be
 * tested: reaching the rebuild needs a database, a renderer and a PDF text extractor, so the one
 * key it dropped was invisible to every test in the suite. This is callable, and
 * resumeEditPacketCarryover.test.ts calls it with a transcript attached, with an acknowledgement
 * that has no file, and with the whole stored packet to prove that what is missing from the list is
 * missing on purpose. documentPacketScope.test.ts, which this comment used to name, is about a
 * different thing entirely: whose object key a packet is allowed to spend.
 *
 * A key present but null is skipped rather than copied. All four are written as objects or not at
 * all - resume.ts:1052 and :1053 spread their two in only when truthy, and the cover letter and the
 * documents map are both written by jsonb_set with an object - so this matches the behaviour of the
 * truthiness checks it replaces on every packet that exists, and refuses to introduce a null-valued
 * key on any that does not.
 */
export function preservedApplicationSpecKeys(stored: StoredSpec): StoredSpec {
  const preserved: StoredSpec = {};
  for (const key of PRESERVED_APPLICATION_SPEC_KEYS) {
    const value = stored[key];
    if (value !== undefined && value !== null) preserved[key] = value;
  }
  return preserved;
}

export function applicationLeadAlignmentIssues(stored: StoredSpec, company?: string): string[] {
  const review = readApplicationReview(stored);
  if (!review?.jd_text) return ['This application has no frozen job description for its lead-experience citation.'];
  return leadAlignmentIssues(editableResumeSpec(stored), review.jd_text, {
    context: { company, role: review.role },
  });
}

/**
 * Preserve the same explicit sparse-source decision that certified the generated resume.
 *
 * A student can continue onboarding when their selected recent role truthfully has fewer than
 * three source bullets. Resume generation records that decision and allows only that bank entry
 * through the minimum-bullet gate. The dashboard edit path used to omit the exception, so saving
 * the unchanged, already-approved resume failed immediately before form filling.
 */
export function allowedSparseEntriesForApplicationEdit(
  parsed: unknown,
  bank: ExperienceBankEntry[],
): ExperienceBankEntry[] {
  const review = (parsed as {
    recent_experience_review?: { selected_entry_id?: unknown; continue_with_found?: unknown };
  } | null)?.recent_experience_review;
  if (review?.continue_with_found !== true || typeof review.selected_entry_id !== 'string') return [];
  const selected = bank.find((entry) => entry.id === review.selected_entry_id);
  return selected ? [selected] : [];
}

export async function preSendResumeVerificationIssues(
  userId: string,
  stored: StoredSpec,
  company?: string,
): Promise<string[]> {
  const review = readApplicationReview(stored);
  const contact = stored._contact as StoredContact | undefined;
  if (!review?.jd_text || !contact?.full_name) {
    return ['This application is missing the saved review or contact details. Regenerate it before sending.'];
  }

  /* THE PACKETS ALREADY IN THE DATABASE, which the producer fix cannot reach.
   *
   * 28 stored packets were generated before /resume/generate resolved the contact block against the
   * account, and their `_contact` has neither an email nor a phone frozen into it. Nothing about
   * this row can be repaired in place: the PDF an employer would receive was rendered at generation
   * time and is immutable in blob storage, so the only cure is regenerating the packet.
   *
   * Stated as an ISSUE rather than left to renderResumePdf's throw, which the render below would
   * otherwise hit. This function's whole contract is a list of sentences the applicant can act on;
   * an exception escaping it turns "your application is on hold because..." into a 500. */
  if (!hasContactRoute({ ...contact, full_name: contact.full_name })) {
    return ['This resume was made without an email address or a phone number on it, so an employer who reads it cannot reply. Generate it again to add your contact details.'];
  }

  const spec = editableResumeSpec(stored);
  if (review.role) spec.target_role = resumeSafeTargetRole(review.role);

  const alignmentIssues = applicationLeadAlignmentIssues(stored, company);
  if (alignmentIssues.length > 0) return alignmentIssues;

  const bank = await readExperienceBankOrSeedFromBaseResume(userId);
  const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
  const parsed = profileRows[0]?.parsed_json as ParsedProfileForResume | undefined;
  const validation = validateResumeSpec(
    spec,
    review.jd_text,
    bank,
    declaredSkillsList(profileRows[0]?.skills),
    candidateEducationFromParsedProfile(parsed),
    review.role,
    {
      allowedSingleBulletEntries: allowedSparseEntriesForApplicationEdit(parsed, bank),
    },
  );
  if (validation.issues.length > 0) return validation.issues;

  const rendered = await renderResumePdf(spec, { ...contact, full_name: contact.full_name }, review.jd_text);
  const visual = validateResumeVisualLayout(rendered.layout);
  const parsedPdf = await extractPdfText(rendered.buffer);
  return [
    ...leadAlignmentIssues(rendered.spec, review.jd_text, { context: { company, role: review.role } }),
    ...visual.issues,
    ...validatePdfLayout(parsedPdf.text, parsedPdf.numpages).issues,
    ...findPdfSafeMarginIssues(parsedPdf.pages, rendered.layout),
    ...findPdfTextFidelityIssues(parsedPdf.text, rendered.spec, { ...contact, full_name: contact.full_name }),
  ];
}

async function loadSensitiveQuestionProfile(userId: string): Promise<ApplicationProfileLike> {
  return loadApplicationProfileLike(userId);
}

function sensitiveQuestionFor(
  questions: readonly ApplicationReviewQuestion[],
  profile: ApplicationProfileLike,
  jdText: string | undefined,
  postingCountry: JobCountry | undefined,
  postingCountryCode?: string,
): ApplicationReviewQuestion | undefined {
  return normalizeApplicationReviewQuestions(questions)
    /* An OPTIONAL sensitive question with no answer is an offer, not a blocker. R-096 now mints
       answerless records for refused questions the employer left voluntary (the normal case for
       an EEO section) so she can answer them in the product; an empty answer generates no fill
       action, so there is nothing here a send could disclose, and refusing the send over it would
       hold a complete application hostage to a section the employer itself marked optional. A
       REQUIRED sensitive question keeps the gate exactly as it stands, answered or not. */
    .filter((question) => question.required || question.answer.trim().length > 0)
    .find((question) => sensitiveQuestionRequiresAttention(
      question.question, question.answer, 'text', profile, jdText, postingCountry, postingCountryCode,
    ));
}

/* THE DUPLICATE GATE as the routes see it.
 *
 * Two things happen on a refusal and both of them matter. The HTTP body answers the caller that is
 * standing there, and the review is written to needs_attention with the same sentence so the
 * Tracker says the same thing to someone who comes back later and never saw the response. A
 * refusal that only exists in a 409 is invisible five minutes afterwards.
 *
 * Written through applyReviewPatch, never by spread, so the terminal-cause invariant holds and the
 * category travels with the prose.
 */
async function refuseDuplicateApplication(
  row: StoredResumeRow,
  current: ApplicationReviewState,
  userId: string,
  log: FastifyInstance['log'],
): Promise<DuplicateApplicationVerdict> {
  const verdict = await duplicateApplicationVerdict({
    userId,
    applicationId: row.id,
    jobContext: row.job_context,
    portalUrl: current.portal_url,
  });
  if (verdict.kind === 'clear') return verdict;
  const now = new Date().toISOString();
  const refused = applyReviewPatch(current, {
    status: 'needs_attention',
    attention_reason: verdict.reason,
    // Derived from the match rather than hardcoded. A refusal grounded in an UNVERIFIED twin is not
    // a duplicate_application: nobody knows yet whether there is a duplicate to be had, and filing
    // it as one would be the same false certainty the sentence itself is careful to avoid.
    attention_categories: [verdict.kind === 'duplicate' && verdict.match.certainty === 'submitted'
      ? 'duplicate_application' : 'unverified_submission'],
    submission_error: undefined,
  }, () => now);
  await db.update(generated_resumes)
    .set({ spec: reviewSpec(refused) })
    .where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, userId),
      sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
    ));
  log.info(
    {
      applicationId: row.id,
      duplicateOf: verdict.kind === 'duplicate' ? verdict.match.application_id : verdict.application_id,
      basis: verdict.kind === 'duplicate' ? verdict.match.basis : 'unidentifiable',
    },
    'Submission refused: an earlier application attempt is not safe to repeat',
  );
  return verdict;
}

function duplicateRiskResponse(verdict: Exclude<DuplicateApplicationVerdict, { kind: 'clear' }>) {
  return verdict.kind === 'duplicate'
    ? duplicateApplicationResponse(verdict)
    : unidentifiableDuplicateApplicationResponse(verdict);
}

export type ApplicationRoutesOptions = {
  /** Narrow seam for exercising the attended disclosure boundary without external Blob/email I/O. */
  attendedPacketAudit?: typeof currentAcknowledgedPacketAudit;
};

export async function applicationRoutes(
  fastify: FastifyInstance,
  options: ApplicationRoutesOptions = {},
) {
  const attendedPacketAudit = options.attendedPacketAudit ?? currentAcknowledgedPacketAudit;
  fastify.post(
    '/applications/:id/packet-audit',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let row = await ownedResume(request, reply);
      if (!row) return;
      /* Ahead of the claim gate below, because that gate is the first half of the trap this repair
       * exists for: a run that parked at an attended handoff without pressing send left the claim
       * on the row, the handoff window closed with the attended finish unavailable, and this route
       * then refused the row forever. The repair releases the claim only when the row itself proves
       * no send can have happened and no attended finish is still possible; on any other row it is
      * a no-op and the gate refuses exactly as before. See repairExpiredAttendedHandoffClaim. */
      row = await repairExpiredAttendedHandoffClaim(row, request.jwtPayload!.userId, request.log) ?? row;
      let review = readApplicationReview(row.spec);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      /* awaiting_security_code is NOT past auditing, and blocking it here deadlocked the code step.
       *
       * POST /applications/:id/security-code gates on currentAcknowledgedPacketAudit, because
       * entering the code performs a FRESH fill and send from this packet - the dashboard says so in
       * as many words: "Litos fills the company form again from this packet and sends it with the
       * code in place". So that step needs a CURRENT acknowledgement, exactly like any other send.
       *
       * The submit attempt that produced the code request also merges the employer questions it
       * discovered on the live form back into the review, which changes packet_version. From that
       * moment the stored acknowledgement was stale, the code route answered packet_stale, and this
       * guard refused the only route that could clear it. Nothing could complete.
       *
       * Measured on Jane Street application 496cff97 on 2026-08-17: submitted at 16:14:01, the
       * employer emailed an 8-character code, the stored audit and acknowledgement agreed with each
       * other (digest cd3feb2b, version f9ed0185) and the live recompute did not, so "Finish sending"
       * answered packet_stale with no way forward.
       *
       * The states that really are past auditing stay refused. Each of those has either claimed the
       * send or completed it, so re-auditing would rewrite what an employer already received. A
       * security code has not been accepted yet, and the send it authorizes has not happened. */
      if (review.submission_claimed_at || review.status === 'submitting' || review.status === 'submission_claimed'
        || review.status === 'submitted') {
        return reply.status(409).send({ error: 'This application can no longer be audited before submission' });
      }
      try {
        /* Canonical cover-letter edits are the authority for the attachment. Historical packets
         * can still name a prior retained blob in `_cover_letter`, so reconcile the exact selected
         * artifact before the audit loads or hashes any employer-bound bytes. This runs after the
         * terminal-state refusal above, so a forbidden re-audit cannot rewrite sent history. */
        row = await reconcileCanonicalCoverLetterForPacket(row);
        review = readApplicationReview(row.spec);
        if (!review) throw new Error('Application review is not available for this resume');
        const auditSourceReview = await repairReviewPortalFromMonitoredJob(row, review);
        /* AUDIT THE PACKET THE SEND GATE WILL CHECK, not the one sitting in the row.
         *
         * submit-request gates on currentAcknowledgedPacketAudit(row, { questions:
         * normalizedSubmittedQuestions }), and those questions come out of
         * refreshKnownQuestionAnswers. This route used to audit the STORED questions instead. While
         * every resolver in that refresh was a no-op for a given packet the two were byte-identical
         * and nothing showed. The moment a resolver starts ANSWERING a question that was stored
         * blank - restrictive_agreements in #515/#518, a declared test-score absence in #509 - the
         * refreshed set and the stored set hash differently, and the two sides converge on
         * different packet_versions by construction:
         *
         *   audit  -> hashes the stored blank answer   -> version A, acknowledged
         *   gate   -> hashes the refreshed answer      -> version B, "packet_stale"
         *
         * and no number of re-audits can clear it, because each side keeps recomputing its own.
         * Measured on production 2026-08-13 after those three merges deployed: every packet on the
         * account deadlocked at once, audit returning a stable version and the send gate rejecting
         * it immediately. This is the same shape as the answer-provenance deadlock recorded in
         * packetAudit.ts, and the same lesson: the constructor and the verifier must be looking at
         * one packet.
         *
         * It is also the more honest thing to show her. What she acknowledges is what the employer
         * receives, and an auto-resolved answer is part of that. Auditing the pre-refresh snapshot
         * asked her to approve a document that was never going to be sent. */
        /* applicationContextForQuestionResolution(row, review), NOT review.jd_text bare.
         *
         * This is the audit whose result gets acknowledged and later checked against the actual
         * fill, and the actual fill - buildPacket and discoverAndResolveQuestions in
         * submissionRunner.ts - has always resolved questions against that richer context (role,
         * jd_text, frozen employer, frozen locations), never against jd_text alone. A resolver
         * gated on the frozen-employer marker (a bare "Source" or "Application Referral" label,
         * several prior-application and relocation labels) is deterministically un-answerable from
         * jd_text alone and deterministically answerable from this function's output, so auditing
         * on the poorer context hashed a different `answer` for the same stored question than the
         * fill a moment later would compute - a packet_stale with no edit and no elapsed time. See
         * applicationContextForQuestionResolution's own comment for the mechanism. */
        /* One shared packet reading for audit and acknowledgement. The shared helper first removes
         * portal-owned controls such as Recruitee candidate.phone, then resolves the remaining
         * questions. Calling refreshKnownQuestionAnswers directly here hashed legacy fixed controls
         * that the acknowledgement route correctly normalized away. */
        let auditQuestions = await resolvedPacketAuditQuestions(row, auditSourceReview);
        // review_only: this route RENDERS the packet for the applicant to look at. It may rebuild
        // a file that aged out so she can see it; it authorizes nothing, and the acknowledgement
        // she has to give is the separate POST below.
        const cached = await currentPacketAudit(row, {
          questions: auditQuestions,
          restoreExpiredResume: 'review_only',
        });
        if (!cached.valid) {
          const allowed = await allowHourly(request.jwtPayload!.userId, 'packet-audit', LIMITS.perHour.packetAudit);
          if (!allowed) return rateLimitedReply(reply);
        }
        /* Build every finite employer-delivery mode now, from the same canonical questions shown in
         * this audit. The hashes are persisted beside the audit, so acknowledgement needs no live
         * profile or resolver read and every later transport can compare its exact effective packet. */
        const packetRow = cached.valid ? cached.row : await ownedResume(request, reply);
        if (!packetRow) return;
        const packetReview = readApplicationReview(packetRow.spec);
        if (!packetReview) throw new Error('Application review is not available for this resume');
        const repairedPacketReview = await repairReviewPortalFromMonitoredJob(packetRow, packetReview);
        if (!cached.valid && (packetRow.resume_object_key !== row.resume_object_key
          || !isDeepStrictEqual(packetRow.spec, row.spec))) {
          auditQuestions = await resolvedPacketAuditQuestions(packetRow, repairedPacketReview);
        }
        const canonicalReview: ApplicationReviewState = { ...repairedPacketReview, questions: auditQuestions };
        const packet = await buildPacket({
          ...packetRow,
          spec: { ...(packetRow.spec as StoredSpec), _review: canonicalReview },
        }, false, auditQuestions, true);
        const boundReview: ApplicationReviewState = {
          ...canonicalReview,
          ...(packet.applicantSnapshot ? { applicant_snapshot: packet.applicantSnapshot } : {}),
          ...(packet.applicantEmail ? { applicant_email: packet.applicantEmail } : {}),
        };
        const extensionProjection = extensionEmployerDeliveryProjection({
          resume: packet.resume,
          fileName: packet.resumeName,
          spec: editableResumeSpec(packetRow.spec as StoredSpec),
          applicationSpec: extensionBoundApplicationSpec(specWithoutDocumentPointers({
            ...(packetRow.spec as StoredSpec),
            _review: boundReview,
          })),
          applicantSnapshot: packet.applicantSnapshot,
        });
        const portalUrl = boundReview.portal_url ?? '';
        let deliverySelection: Parameters<typeof createEmployerDeliveryBindings>[2];
        if (!isPortalSupported(portalUrl)) {
          const preparedEmail = prepareUnsupportedPortalApplicationEmail({
            application: packetRow,
            review: boundReview,
            packet,
          });
          deliverySelection = {
            mode: 'full',
            envelope: employerDeliveryEnvelope({
              channel: 'unsupported_email',
              destinationUrl: preparedEmail.recipient,
              portalFamily: 'unsupported',
              coverLetterSupported: boundReview.cover_letter_supported,
              transcriptSupported: boundReview.transcript_supported,
              email: preparedEmail.message,
            }),
          };
        } else {
          const portal = detectPortal(portalUrl);
          if (portal === 'controlled_test') {
            deliverySelection = {
              mode: 'full',
              envelope: employerDeliveryEnvelope({
                channel: 'controlled_browser',
                destinationUrl: portalUrl,
                portalFamily: portal,
                runtime: {
                  provider: 'local_playwright',
                  executable: process.env.LITOS_TEST_BROWSER_EXECUTABLE
                    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                },
                coverLetterSupported: boundReview.cover_letter_supported,
                transcriptSupported: boundReview.transcript_supported,
              }),
            };
          } else if (isManagedAttendedAccountPortal(portal)) {
            deliverySelection = {
              mode: 'extension',
              extensionProjection,
              envelope: employerDeliveryEnvelope({
                channel: 'extension',
                destinationUrl: boundReview.extension_handoff_url ?? portalUrl,
                portalFamily: portal,
                coverLetterSupported: false,
                transcriptSupported: false,
              }),
            };
          } else {
            /* ATS API serializers still construct multipart requests after the approval check.
             * Until they can send one prebuilt, identity-checked request object, audit only the
             * browser channel. This is an explicit fail-closed choice, not a runtime fallback. */
            deliverySelection = {
              mode: 'browser',
              envelope: employerDeliveryEnvelope({
                channel: browserEmployerDeliveryChannel(browserDeliveryRuntimeIdentity().provider),
                destinationUrl: portalApplicationUrl(portal, portalUrl),
                portalFamily: portal,
                runtime: browserDeliveryRuntimeIdentity(),
                coverLetterSupported: boundReview.cover_letter_supported,
                transcriptSupported: boundReview.transcript_supported,
              }),
            };
          }
        }
        const auditReview: ApplicationReviewState = {
          ...boundReview,
          employer_delivery_bindings: createEmployerDeliveryBindings(packet, boundReview, deliverySelection),
        };
        const result = await createAndPersistPacketAudit(packetRow, { review: auditReview });
        if (!result.persisted) {
          return reply.status(409).send({
            error: 'The saved application changed while it was being audited. Reload it and audit again.',
            code: 'PACKET_AUDIT_STALE',
          });
        }
        const fileName = resumeFileNameForRole(
          ((packetRow.spec as StoredSpec)._contact as StoredContact | undefined)?.full_name,
          (packetRow.job_context as { role?: unknown } | null)?.role,
        );
        const downloadUrl = `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(
          request.jwtPayload!.userId,
          packetRow.resume_object_key,
          { fileName },
        )}`;
        const response = {
          packet_audit: result.audit,
          pdf: {
            object_key: packetRow.resume_object_key,
            sha256: result.audit.bindings.pdf.sha256,
            size_bytes: result.audit.bindings.pdf.sizeBytes,
            download_url: downloadUrl,
          },
          /* THE QUESTIONS THE AUDIT ABOVE ACTUALLY HASHED, not the ones the client walked in with.
           *
           * Without this the client had no way to learn that auditQuestions - refreshed and, per the
           * persist block above, WRITTEN to the row - differs from whatever it still holds locally.
           * Its next request (POST /submit-request) merges its own stale copy back onto the row and
           * re-refreshes, which is a second, independent computation of "the same" packet: on a
           * question the resolver holds with no attributed claim, refreshKnownQuestionAnswers blanks
           * it here (nothing proves she supplied it) but the submit-side merge sees the client's
           * still-original, non-blank copy as a fresh, different answer and reinstates it - two
           * requests, three seconds apart, disagreeing about the same unedited packet. The audit and
           * the acknowledgement it produces are for auditQuestions specifically, so handing them back
           * is what lets a caller keep its local state the packet actually agrees with. */
          questions: auditQuestions,
        };
        return reply.status(200).send(response);
      } catch (error) {
        request.log.warn({ error, applicationId: row.id }, 'Packet audit could not verify the saved application');
        return reply.status(422).send({
          error: error instanceof Error ? error.message : 'The saved application could not be audited',
          code: 'PACKET_AUDIT_FAILED',
        });
      }
    },
  );

  fastify.post(
    '/applications/:id/packet-audit/acknowledge',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = packetAuditAcknowledgementSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid packet audit acknowledgement' });
      const row = await ownedResume(request, reply);
      if (!row) return;
      const review = readApplicationReview(row.spec);
      if (!review || review.submission_claimed_at || review.status === 'submitted') {
        return reply.status(409).send({ error: 'This application cannot be acknowledged in its current state' });
      }
      /* Pure stored acknowledgement. No profile, email, alias, Blob, PDF, resolver, clock, or
       * environment read belongs between the packet the applicant saw and this exact-CAS write.
       * Live drift is rechecked at every send gate and exact delivery payload check. */
      const storedAudit = verifyStoredPacketAuditAcknowledgement({
        audit: review.packet_audit,
        ownerId: request.jwtPayload!.userId,
        applicationId: row.id,
        client: parsed.data,
      });
      if (!storedAudit.valid && storedAudit.reason === 'packet_audit_stale') {
        return reply.status(409).send({
          error: 'The saved application does not have a complete current packet audit. Audit it again before continuing.',
          code: 'PACKET_AUDIT_STALE',
        });
      }
      if (!storedAudit.valid) {
        return reply.status(409).send({
          error: 'The rendered packet no longer matches the saved application. Reload it before continuing.',
          code: 'PACKET_AUDIT_STALE',
        });
      }
      const audit = storedAudit.audit;
      const acknowledgement = {
        ownerSha256: audit.bindings.ownerSha256,
        applicationId: audit.bindings.applicationId,
        audit_digest: audit.audit_digest,
        packet_version: audit.packet_version,
        pdfSha256: audit.bindings.pdf.sha256,
        pdfSizeBytes: audit.bindings.pdf.sizeBytes,
        acknowledged_at: new Date().toISOString(),
      };
      const next: ApplicationReviewState = { ...review, packet_audit_acknowledgement: acknowledgement };
      const updated = await db.update(generated_resumes).set({ spec: reviewSpec(next) }).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, request.jwtPayload!.userId),
        sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
        sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
      )).returning({ id: generated_resumes.id });
      if (!updated.length) {
        return reply.status(409).send({
          error: 'The saved application changed before the acknowledgement was recorded.',
          code: 'PACKET_AUDIT_STALE',
        });
      }
      return reply.send({ acknowledged: true });
    },
  );

  fastify.post(
    '/applications/:id/submission/manual-handoff',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsedBoundaryRequest = attendedBoundaryRequestSchema.safeParse(
        request.body === undefined ? {} : request.body,
      );
      if (!parsedBoundaryRequest.success) {
        return reply.status(400).send({
          error: 'A manual handoff replay requires its complete authorization identity.',
          code: 'MANUAL_HANDOFF_REPLAY_INVALID',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const replay = attendedBoundaryReplay(parsedBoundaryRequest.data);
      let review = readApplicationReview(row.spec);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      review = await repairReviewPortalFromMonitoredJob(row, review);

      // This action-time read is the dashboard's sole authority to navigate. It deliberately
      // repeats every live packet check instead of trusting the audit object or URL held in React:
      // currentAcknowledgedPacketAudit revalidates the exact PDF/spec/JD/answers, current personal
      // resume email, and active owner/application Litos alias before any company URL is disclosed.
      const audit = await attendedPacketAudit(row, {
        questions: await resolvedPacketAuditQuestions(row, review),
        restoreExpiredResume: 'authorizing_send',
      });
      if (!audit.valid) return reply.status(409).send(packetAuditClientError(audit));
      const auditedRow = audit.row;

      // PDF and alias verification perform external reads. Re-read the owner-scoped row after
      // those awaits and reject unless the complete saved packet is still byte-for-byte the one
      // that was audited. The URL below is derived only from this refreshed row, never the earlier
      // snapshot, so a concurrent portal/job/status/claim mutation cannot release a stale URL.
      const refreshed = await ownedResume(request, reply);
      if (!refreshed) return;
      if (refreshed.resume_object_key !== auditedRow.resume_object_key
        || !isDeepStrictEqual(refreshed.spec, auditedRow.spec)) {
        return reply.status(409).send({
          error: 'This application changed while its company handoff was being verified. Reload it before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
        });
      }
      let refreshedReview = readApplicationReview(refreshed.spec);
      if (!refreshedReview) {
        return reply.status(409).send({
          error: 'Application review is not available for this resume',
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      refreshedReview = await repairReviewPortalFromMonitoredJob(refreshed, refreshedReview);
      if (!isDeepStrictEqual(refreshedReview, review)) {
        return reply.status(409).send({
          error: 'This application changed while its company handoff was being verified. Reload it before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
          retry_safety: await packetRetrySafety(refreshed),
        });
      }

      const attendedCapability = attendedHandoffCapabilityForRow(
        refreshed,
        refreshedReview,
        'manual_handoff',
      );
      if (!attendedCapability) {
        return reply.status(409).send({
          error: 'This application no longer has a verified company handoff. Reload it before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
          retry_safety: await packetRetrySafety(refreshed),
        });
      }

      const reservation = await reserveAttendedManualAttempt(refreshed, refreshedReview, {
        ...(replay ? { replayAttemptId: replay.attemptId } : {}),
        attendedHandoffCapability: attendedCapability.capability,
      });
      if (reservation.kind === 'duplicate_risk') {
        return reply.status(409).send({
          ...duplicateRiskResponse(reservation.verdict),
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      if (reservation.kind === 'changed') {
        const changed = await ownedResume(request, reply);
        if (!changed) return;
        return reply.status(409).send({
          error: 'This application changed while its manual handoff was being reserved. Reload before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
          retry_safety: await packetRetrySafety(changed),
        });
      }
      if (reservation.kind === 'blocked') {
        return reply.status(409).send({
          error: 'Another submission attempt is still unresolved. Resolve it before opening the employer page.',
          code: 'MANUAL_HANDOFF_STALE',
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      if (reservation.kind === 'replay_mismatch') {
        return reply.status(409).send({
          error: 'This manual handoff replay does not match the active attempt.',
          code: 'MANUAL_HANDOFF_REPLAY_STALE',
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      const boundaryGate = await finalApplicationBoundaryGate({
        row: reservation.row,
        binding: reservation.binding,
        factKey: 'manual-dashboard-handoff-final-duplicate-recheck',
        replay,
        attendedHandoffCapability: attendedCapability.capability,
      });
      if (boundaryGate.kind === 'blocked') {
        return reply.status(409).send({
          ...duplicateRiskResponse(boundaryGate.verdict),
          retry_safety: await packetRetrySafety(boundaryGate.row),
        });
      }
      if (boundaryGate.kind === 'already_authorized') {
        return reply.status(409).send({
          error: 'This employer handoff was already exposed. Resolve that exact attempt before opening it again.',
          code: 'MANUAL_HANDOFF_ALREADY_EXPOSED',
          retry_safety: boundaryGate.retrySafety,
        });
      }
      if (boundaryGate.kind === 'changed') {
        const changed = await ownedResume(request, reply);
        if (!changed) return;
        return reply.status(409).send({
          error: 'This application changed during its final duplicate-safety recheck.',
          code: 'MANUAL_HANDOFF_STALE',
          retry_safety: await packetRetrySafety(changed),
        });
      }

      if (!boundaryGate.attendedHandoffCapability) {
        return reply.status(409).send({
          error: 'The manual handoff capability could not be finalized safely. Reload before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
          retry_safety: await packetRetrySafety(reservation.row),
        });
      }
      const finalized = await finalizeAttendedHandoffCapability({
        row: reservation.row,
        binding: reservation.binding,
        authorization: boundaryGate.authorization,
        attendedHandoffCapability: boundaryGate.attendedHandoffCapability,
      });
      if (finalized.kind !== 'clear') {
        return reply.status(409).send({
          error: 'This manual handoff changed before its company page could be returned. Reload before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
          retry_safety: finalized.retrySafety,
        });
      }

      return reply.send({
        application_id: finalized.row.id,
        manual_attempt_id: reservation.binding.attemptId,
        boundary_lease_id: finalized.authorization.leaseId,
        boundary_activation_id: finalized.authorization.activationId,
        manual_handoff_resume_available: true,
        replay: boundaryGate.replay,
        attended_handoff_capability: finalized.attendedHandoffCapability,
        review: finalized.review,
        retry_safety: finalized.retrySafety,
        manual_handoff: {
          url: finalized.url,
          audit_digest: audit.audit.audit_digest,
          packet_version: audit.audit.packet_version,
          pdf_sha256: audit.audit.bindings.pdf.sha256,
          size_bytes: audit.audit.bindings.pdf.sizeBytes,
        },
      });
    },
  );

  fastify.get(
    '/applications/:id/submission/extension-packet',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const query = extensionPacketQuerySchema.safeParse(request.query);
      if (!query.success) return reply.status(400).send({ error: 'The current company form URL is required' });
      const row = await ownedResume(request, reply);
      if (!row) return;
      const stored = row.spec as StoredSpec;
      const review = readApplicationReview(stored);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      if (!extensionHandoffPacketMatches({
        frozenUrl: review.portal_url,
        frozenHandoffUrl: review.extension_handoff_url,
        currentUrl: query.data.current_url,
        frozenAtsName: review.ats_name,
        status: review.status,
        attentionReason: review.attention_reason,
        submissionClaimedAt: review.submission_claimed_at,
      })) {
        return reply.status(409).send({ error: 'This saved application does not match the company form open in Chrome' });
      }
      if (!row.resume_object_key) return reply.status(409).send({ error: 'This application has no generated resume to attach' });
      if ((review.ats_name === 'jobvite' || review.ats_name === 'icims' || review.ats_name === 'oraclecloud')
        && !review.applicant_snapshot) {
        return reply.status(409).send({ error: 'This application must be prepared again before Chrome can fill it' });
      }
      const auditVerdict = await currentAcknowledgedPacketAudit(row, {
        questions: await resolvedPacketAuditQuestions(row, review),
      });
      if (!auditVerdict.valid) {
        return reply.status(409).send(packetAuditClientError(auditVerdict));
      }

      const contact = (stored._contact ?? {}) as StoredContact;
      const job = (row.job_context ?? {}) as { role?: unknown };
      const quality = (stored._quality ?? {}) as Record<string, unknown>;
      const issueKeys = ['specIssues', 'contactIssues', 'leadAlignmentIssues', 'layoutIssues'] as const;
      const issues = issueKeys.flatMap((key) => Array.isArray(quality[key])
        ? (quality[key] as unknown[]).filter((value): value is string => typeof value === 'string')
        : []);
      const warnings = Array.isArray(quality.visualWarnings) ? quality.visualWarnings : [];
      const omissions = Array.isArray(quality.layoutOmissions)
        ? quality.layoutOmissions.filter((value): value is string => typeof value === 'string')
        : [];
      const groundingRemoved = Array.isArray(quality.groundingRemoved)
        ? quality.groundingRemoved.filter((value): value is string => typeof value === 'string')
        : [];
      const fileName = resumeFileNameForRole(contact.full_name, job.role);
      const extensionProjection = extensionEmployerDeliveryProjection({
        resume: auditVerdict.pdfBytes,
        fileName,
        spec: editableResumeSpec(stored),
        applicationSpec: extensionBoundApplicationSpec(specWithoutDocumentPointers(stored)),
        applicantSnapshot: review.applicant_snapshot,
      });
      const deliveryIssue = extensionEmployerDeliveryBindingIssue(
        extensionProjection,
        auditVerdict.audit.bindings.employerDelivery,
        employerDeliveryEnvelope({
          channel: 'extension',
          destinationUrl: query.data.current_url,
          portalFamily: detectPortal(query.data.current_url),
          coverLetterSupported: false,
          transcriptSupported: false,
        }),
      );
      if (deliveryIssue) {
        return reply.status(409).send({
          error: 'The employer-bound Chrome packet changed after approval. Audit it again before continuing.',
          code: 'PACKET_AUDIT_STALE',
          issues: [deliveryIssue],
        });
      }
      const handoffVersion = extensionHandoffVersion({
        applicationId: row.id,
        userId: request.jwtPayload!.userId,
        resumeObjectKey: row.resume_object_key,
        spec: row.spec,
        jobContext: row.job_context,
        currentUrl: query.data.current_url,
      });
      if (!handoffVersion) return reply.status(409).send({ error: 'This company form cannot receive the saved application' });

      return reply.send({
        resume_id: row.id,
        handoff_version: handoffVersion,
        resume_url: `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(
          request.jwtPayload!.userId,
          row.resume_object_key,
          { fileName },
        )}`,
        file_name: fileName,
        spec: editableResumeSpec(stored),
        /* THE WHOLE STORED SPEC, WHICH IS WHY IT LEAVES THROUGH THE STRIPPER.
         *
         * This is a second route that answers with a spec without a line of it mentioning
         * documents, so it started serving _documents.transcript.object_key the day the first
         * transcript was attached, exactly as GET /resume/history did. A Blob object is written
         * `access: 'public'` because that is the only mode the SDK has, so that key plus the
         * store's stable base URL is permanent unauthenticated access to a student's transcript -
         * and this particular copy goes to a content script running in the employer's page origin.
         *
         * The extension has no use for the key either way: its only file channel is the resume
         * capability token minted above, there is no cover-letter equivalent and there is no
         * transcript one, so a document attached in the dashboard is not attached by the extension
         * at all. Nothing downstream of here can spend the pointer; it could only escape.
         *
         * Note the RAW spec is still what extensionHandoffVersion hashes above, and has to be. That
         * value binds the packet the extension is about to fill, and stripping a field out of the
         * hash input would change every version string on an application that has an attachment. */
        application: { id: row.id, spec: specWithoutDocumentPointers(stored) },
        applicant_snapshot: review.applicant_snapshot,
        packet_audit: auditVerdict.audit,
        quality: {
          ready_to_attach: issues.length === 0,
          issues,
          warnings,
          ats_keyword_coverage_pct: typeof quality.atsCoverage === 'number' ? quality.atsCoverage : 0,
          trimmed_for_one_page_fit: quality.trimmedForFit === true,
          sparse_add_more_experience: quality.sparse === true,
          grounding_removed: groundingRemoved,
          omissions,
        },
      });
    },
  );

  fastify.post(
    '/applications/:id/submission/extension-start',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({
        error: 'Invalid application id',
        retry_safety: { kind: 'no_evidence' as const },
      });
      const userId = request.jwtPayload!.userId;
      const [precheckRow] = await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, params.data.id),
        eq(generated_resumes.user_id, userId),
      )).limit(1);
      if (!GENERATED_EXTENSION_SUBMISSION_ENABLED) {
        return reply.status(409).send({
          error: 'Generated extension submission is paused for this release.',
          code: 'GENERATED_EXTENSION_SUBMISSION_PAUSED',
          retry_safety: precheckRow
            ? await packetRetrySafety(precheckRow)
            : { kind: 'no_evidence' as const },
        });
      }
      const parsed = extensionStartBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({
        error: 'Invalid extension submission request',
        retry_safety: precheckRow
          ? await packetRetrySafety(precheckRow)
          : { kind: 'no_evidence' as const },
      });
      if (extensionAuthorizationRequiresAutomaticSubmission(parsed.data.authorization)) {
        const automaticSubmission = await requireFeature(
          userId,
          'automatic_submission',
          'extension_automatic_submission',
        );
        if (!automaticSubmission.allowed) return reply.status(402).send({
          ...automaticSubmission.denial,
          retry_safety: precheckRow
            ? await packetRetrySafety(precheckRow)
            : { kind: 'no_evidence' as const },
        });
      }
      /* THE DUPLICATE GATE for the extension path, and it is the only one of the five that never
       * touches submissionRunner.submit: the extension does the filling and the clicking in the
       * applicant's own browser, and this route is the moment Litos authorizes it to. Refusing at
       * extension-outcome would be refusing to record a send that already happened.
       *
       * The expensive PDF verification runs ahead of the transaction. The transaction below then
       * requires the row to be the same JSON value before it authorizes the extension,
       * and the conditional update repeats that predicate. This binds the verification to the exact
       * packet version that receives the claim. */
      const precheckReview = precheckRow ? readApplicationReview(precheckRow.spec) : null;
      let precheckPacketVersion: string | null = null;
      let precheckPacketQuestions: ApplicationReviewQuestion[] | null = null;
      let precheckSensitiveProfile: ApplicationProfileLike | null = null;
      if (precheckRow && precheckReview) {
        const binding = extensionStartHandoffBinding({
          handoffVersion: parsed.data.handoff_version,
          currentUrl: parsed.data.current_url,
          applicationId: precheckRow.id,
          userId,
          resumeObjectKey: precheckRow.resume_object_key ?? '',
          spec: precheckRow.spec,
          jobContext: precheckRow.job_context,
          review: precheckReview,
        });
        if (binding === 'missing') {
          return reply.status(409).send({
            error: 'Reload this saved application before submitting from Chrome',
            retry_safety: await packetRetrySafety(precheckRow),
          });
        }
        if (binding === 'mismatch') {
          return reply.status(409).send({
            error: 'This saved application does not match the company form open in Chrome',
            retry_safety: await packetRetrySafety(precheckRow),
          });
        }
        if (binding === 'stale') {
          return reply.status(409).send({
            error: 'The saved application changed. Reload it before submitting.',
            retry_safety: await packetRetrySafety(precheckRow),
          });
        }
      }
      if (precheckRow && precheckReview && precheckReview.status !== 'submitted') {
        const precheckAsOf = new Date();
        const sensitiveProfile = await loadSensitiveQuestionProfile(userId);
        const packetQuestions = resolvePacketAuditQuestionFixpoint(
          precheckReview,
          sensitiveProfile,
          applicationContextForQuestionResolution(precheckRow, precheckReview),
          postingCountryFromJobContext(precheckRow.job_context),
          postingCountryCodeFromJobContext(precheckRow.job_context),
          precheckAsOf,
        );
        const auditVerdict = await currentAcknowledgedPacketAudit(precheckRow, {
          questions: packetQuestions,
          restoreExpiredResume: 'authorizing_send',
        });
        if (!auditVerdict.valid) {
          return reply.status(409).send({
            ...packetAuditClientError(auditVerdict),
            retry_safety: await packetRetrySafety(precheckRow),
          });
        }
        precheckPacketVersion = auditVerdict.audit.packet_version;
        precheckPacketQuestions = packetQuestions;
        precheckSensitiveProfile = sensitiveProfile;
        const verdict = await refuseDuplicateApplication(precheckRow, precheckReview, userId, fastify.log);
        if (verdict.kind !== 'clear') return reply.status(409).send({
          ...duplicateRiskResponse(verdict),
          retry_safety: await packetRetrySafety(precheckRow),
        });
        const resumeIssues = await preSendResumeVerificationIssues(
          userId,
          precheckRow.spec as StoredSpec,
          applicationCompany(precheckRow),
        );
        if (resumeIssues.length > 0) {
          return reply.status(422).send({
            error: 'Verify the resume before sending. The current packet is not ready for extension submission.',
            code: 'PRE_SEND_VERIFICATION_FAILED',
            issues: resumeIssues,
            retry_safety: await packetRetrySafety(precheckRow),
          });
        }
      }
      const runExtensionStartTransaction = (database: typeof db) => database.transaction(async (tx) => {
        await lockSubmissionAttemptUser(tx, userId);
        const rows = await tx.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, params.data.id),
          eq(generated_resumes.user_id, userId),
        )).limit(1);
        const row = rows[0];
        if (!row) return { kind: 'not_found' as const };
        if (!precheckRow
          || !precheckRow.resume_object_key
          || row.resume_object_key !== precheckRow.resume_object_key
          || !isDeepStrictEqual(row.job_context, precheckRow.job_context)
          || !sameApplicationPacketSpec(row.spec, precheckRow.spec)) {
          return { kind: 'changed' as const };
        }
        const current = readApplicationReview(row.spec);
        if (!current) return { kind: 'no_review' as const };
        const duplicate = await duplicateApplicationVerdict({
          userId,
          applicationId: row.id,
          jobContext: row.job_context,
          portalUrl: current.portal_url,
        }, tx);
        if (duplicate.kind !== 'clear') return { kind: 'duplicate_risk' as const, duplicate };
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        const [openedToday, consent] = await Promise.all([
          submissionAttemptsOpenedToday(userId, { executor: tx, since: startOfDay }),
          tx.select({
          automatic_submission_enabled: users.automatic_submission_enabled,
          automatic_submission_consented_at: users.automatic_submission_consented_at,
          automatic_submission_consent_version: users.automatic_submission_consent_version,
          }).from(users).where(eq(users.id, userId)).limit(1),
        ]);
        const consentRow = consent[0];
        const disposition = canStartExtensionSubmission(current, parsed.data.authorization, consentRow?.automatic_submission_enabled === true);
        if (disposition !== 'start') return { kind: disposition, row, current };
        if (!precheckPacketQuestions || !precheckSensitiveProfile || !precheckPacketVersion) {
          return { kind: 'changed' as const };
        }
        // The packet's PDF was frozen when it was built, so this is the last moment anything can
        // notice that the education block it prints no longer matches the profile. Checked BEFORE
        // the daily cap because drift is the actionable failure of the two: being told to fix a
        // graduation date is useful, being told to come back tomorrow is not.
        const profileRows = await tx.select({ parsed_json: profiles.parsed_json })
          .from(profiles).where(eq(profiles.user_id, userId)).limit(1);
        const educationIssues = packetEducationDrift(row.spec, profileRows[0]?.parsed_json);
        if (educationIssues.length > 0) return { kind: 'education_drift' as const, issues: educationIssues };
        const packetCountry = postingCountryFromJobContext(row.job_context);
        const packetCountryCode = postingCountryCodeFromJobContext(row.job_context);
        /* Carry the exact question snapshot that passed the acknowledged-audit gate above. The row
         * and job context are byte-checked against that precheck before this point. Re-resolving in
         * the transaction used a second profile read and a second clock instant, then only refused
         * Q2 != Q1 when a modern client supplied handoff_version. A legacy client could therefore
         * send Q2 under Q1's packet version. The exact-CAS makes the already-verified snapshot the
         * only honest input here, for clients with and without a handoff version. */
        const refreshedQuestions = precheckPacketQuestions;
        const sensitive = sensitiveQuestionFor(
          refreshedQuestions,
          precheckSensitiveProfile,
          current.jd_text,
          packetCountry,
          packetCountryCode,
        );
        if (sensitive) return { kind: 'sensitive_question' as const, question: sensitive.question };
        /* THE FIFTH SEND SITE, and the one blankRequiredQuestionLabels' own list did not name.
         *
         * This route hands the packet to the extension, which fills the employer's form and presses
         * Submit in the applicant's own browser. Nothing between here and that click reads the
         * answers again: extension-outcome only records what happened. So this is a send, and it has
         * never carried a required-answer check of any kind - a packet with a required question
         * Litos could not answer went out through it in silence.
         *
         * Beside the sensitive-question refusal because they are the same kind of stop and must not
         * drift apart, and BEFORE the tx.update below, so the claim is never taken for a submission
         * that is not allowed to proceed. */
        const unansweredRequired = blankRequiredQuestionLabels(refreshedQuestions);
        if (unansweredRequired.length > 0) return { kind: 'required_answer_missing' as const, questions: unansweredRequired };
        if (!withinDailyCap(openedToday, dailySubmissionCap())) return { kind: 'cap' as const };
        const now = new Date().toISOString();
        const claimId = randomUUID();
        const next = {
          ...current,
          questions: refreshedQuestions,
          status: 'submitting' as const,
          /* THE FOURTH CLAIM SITE, and the one an inline clear at the other three missed.
           *
           * This is a `...current` spread, so a stop record left by an earlier run survives into the
           * claim unless it is cleared here. It matters most on exactly the path an applicant takes
           * after a pre-click stop: the managed run finds no submit control, releases the claim and
           * leaves before_click:true, she retries through the extension, presses Submit herself, and
           * the confirmation cannot be read - and the 'unknown' outcome writes no evidence that
           * contradicts the stale record. The packet would then read as provably-not-sent while its
           * own attention_reason says Submit was clicked. */
          ...submissionClaimPatch(now, claimId),
          submission_packet_version: precheckPacketVersion!,
          submission_authorization: {
            source: parsed.data.authorization === 'standing_consent' ? 'standing_consent' as const : 'user_initiated_extension' as const,
            authorized_at: now,
            ...(parsed.data.authorization === 'standing_consent' ? {
              consented_at: consentRow?.automatic_submission_consented_at?.toISOString(),
              consent_version: consentRow?.automatic_submission_consent_version ?? undefined,
            } : {}),
          },
          updated_at: now,
        };
        const updated = await tx.update(generated_resumes).set({ spec: reviewSpec(next) }).where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(precheckRow.spec)}::jsonb`,
          sql`${generated_resumes.resume_object_key} is not distinct from ${precheckRow.resume_object_key}`,
          sql`${generated_resumes.job_context} is not distinct from ${JSON.stringify(precheckRow.job_context ?? null)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
          sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null`,
        )).returning();
        if (!updated.length) return { kind: 'changed' as const };
        const attemptBinding = applicationAttemptBinding({
          row,
          review: next,
          attemptId: claimId,
          source: 'chrome_extension',
          packetVersion: precheckPacketVersion,
        });
        await appendApplicationAttemptFact(attemptBinding, 'attempt_opened', 'reservation', {
          evidenceCode: 'atomic_extension_claim_reserved',
          executor: tx,
        });
        return { kind: 'started' as const, row: updated[0], claimId, next, attemptBinding };
      });
      const result = await withReadOnlyRetry(
        () => runExtensionStartTransaction(db),
        {
          onRetry: (attempt) => request.log.warn(
            { attempt, applicationId: params.data.id },
            'Extension start transaction reached a read-only backend; retrying on a fresh pooled connection',
          ),
          onExhausted: () => withDedicatedDatabase((directDb) => {
            request.log.warn(
              { applicationId: params.data.id },
              'Extension start pooled transactions stayed read-only; retrying on the direct database endpoint',
            );
            return runExtensionStartTransaction(directDb);
          }),
        },
      );
      const resultRetrySafety = precheckRow
        ? await packetRetrySafety(precheckRow)
        : { kind: 'no_evidence' as const };
      if (result.kind === 'not_found') return reply.status(404).send({
        error: 'Application not found',
        retry_safety: resultRetrySafety,
      });
      if (result.kind === 'no_review') return reply.status(409).send({
        error: 'Application review is not available for this resume',
        retry_safety: resultRetrySafety,
      });
      if (result.kind === 'duplicate_risk') return reply.status(409).send({
        ...duplicateRiskResponse(result.duplicate),
        retry_safety: resultRetrySafety,
      });
      if (result.kind === 'consent_required') return reply.status(403).send({
        error: 'Automatic submission is turned off',
        retry_safety: resultRetrySafety,
      });
      if (result.kind === 'submitted') return reply.send({
        application_id: result.row.id,
        already_submitted: true,
        review: result.current,
        retry_safety: await packetRetrySafety(result.row),
      });
      if (result.kind === 'in_flight') return reply.status(409).send({
        error: 'This application already has an active submission',
        retry_safety: resultRetrySafety,
      });
      if (result.kind === 'reject') return reply.status(409).send({
        error: 'This application cannot be submitted again from its current state',
        retry_safety: resultRetrySafety,
      });
      if (result.kind === 'education_drift') return reply.status(422).send({
        ...educationDriftResponse(result.issues),
        retry_safety: resultRetrySafety,
      });
      if (result.kind === 'sensitive_question') {
        return reply.status(422).send({
          error: `Sensitive question requires your attention: ${result.question.slice(0, 120)}`,
          retry_safety: resultRetrySafety,
        });
      }
      if (result.kind === 'required_answer_missing') {
        // Same body shape as the unsupported-portal email refusal below, so a client can handle one
        // "you still owe an answer" response rather than two that differ only in wording.
        return reply.status(422).send({
          error: 'Answer every required question before submitting.',
          questions: result.questions,
          retry_safety: resultRetrySafety,
        });
      }
      if (result.kind === 'cap') return reply.status(429).send({
        error: 'Daily automatic submission safety limit reached',
        retry_safety: resultRetrySafety,
      });
      if (result.kind === 'changed') return reply.status(409).send({
        error: 'The application state changed before the extension could reserve it',
        retry_safety: resultRetrySafety,
      });
      const boundaryGate = await finalApplicationBoundaryGate({
        row: result.row,
        binding: result.attemptBinding!,
        factKey: 'extension-final-duplicate-recheck',
      });
      if (boundaryGate.kind === 'blocked') {
        return reply.status(409).send({
          ...duplicateRiskResponse(boundaryGate.verdict),
          retry_safety: await packetRetrySafety(boundaryGate.row),
        });
      }
      if (boundaryGate.kind === 'already_authorized') {
        return reply.status(409).send({
          error: 'This extension submission capability was already authorized and cannot be exposed twice.',
          retry_safety: boundaryGate.retrySafety,
        });
      }
      if (boundaryGate.kind === 'changed') {
        const [refreshed] = await db.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, result.row.id),
          eq(generated_resumes.user_id, userId),
        )).limit(1);
        return reply.status(409).send({
          error: 'The application changed during its final duplicate-safety recheck.',
          retry_safety: refreshed
            ? await packetRetrySafety(refreshed)
            : { kind: 'no_evidence' as const },
        });
      }
      return reply.send({
        application_id: result.row.id,
        claim_id: result.claimId,
        review: result.next,
        retry_safety: await packetRetrySafety(result.row),
      });
    },
  );

  fastify.post(
    '/applications/:id/submission/extension-outcome',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = extensionOutcomeBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({
        error: 'Invalid extension submission outcome',
        retry_safety: await packetRetrySafety(row),
      });
      const result = await commitExtensionSubmissionOutcome({
        packetId: row.id,
        userId: request.jwtPayload!.userId,
        claimId: parsed.data.claim_id,
        reportedOutcome: parsed.data.outcome,
        confirmationText: parsed.data.confirmation_text,
        finalUrl: parsed.data.final_url,
      });
      const persistedRow = result.row ?? row;
      if (result.kind === 'no_review') return reply.status(409).send({
        error: 'Application review is not available for this resume',
        retry_safety: await packetRetrySafety(persistedRow),
      });
      if (result.kind === 'binding_mismatch') {
        return reply.status(409).send({
          error: 'This extension outcome does not match the exact reserved extension attempt.',
          code: 'EXTENSION_ATTEMPT_BINDING_MISMATCH',
          retry_safety: await packetRetrySafety(persistedRow),
        });
      }
      if (result.kind === 'stale') {
        return reply.status(409).send({
          error: 'This extension submission is no longer active',
          retry_safety: await packetRetrySafety(persistedRow),
        });
      }
      if (result.kind === 'audit_failure') return reply.status(409).send({
        ...result.response,
        retry_safety: await packetRetrySafety(persistedRow),
      });
      if (result.kind === 'changed') return reply.status(409).send({
        error: 'The application state changed before the outcome was recorded',
        retry_safety: await packetRetrySafety(persistedRow),
      });
      if (!('review' in result) || !result.row) return reply.status(409).send({
        error: 'The application state changed before the outcome was recorded',
        retry_safety: await packetRetrySafety(persistedRow),
      });

      /* The transaction returns the review that actually persisted. This keeps canonical healing
       * outside the packet transaction without re-deriving success from a possibly stale request. */
      if (result.review.status === 'submitted') {
        await advanceCanonicalApplicationFromPacketSubmission({
          packetId: result.row.id,
          userId: request.jwtPayload!.userId,
        });
      }
      return reply.send({
        application_id: result.row.id,
        review: result.review,
        retry_safety: await packetRetrySafety(result.row),
      });
    },
  );

  fastify.patch(
    '/applications/:id/resume',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;

      let edited: ResumeSpec;
      try {
        edited = editableResumeSpec((request.body as { spec?: unknown } | null)?.spec);
      } catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : 'Invalid resume' });
      }

      const stored = row.spec as StoredSpec;
      const review = readApplicationReview(stored);
      const storedContact = stored._contact as {
        full_name?: string;
        email?: string;
        phone?: string;
        location?: string;
        linkedin_url?: string;
        github_url?: string;
        portfolio_url?: string;
      } | undefined;
      if (!review?.jd_text || !storedContact?.full_name) {
        return reply.status(409).send({ error: 'This older resume cannot be edited in the dashboard. Generate it again first.' });
      }
      /* Same refusal as the pre-send check, and for the same reason: refreshing the current profile
         can replace a stale phone or residence, but it cannot safely repair a packet that never had
         either contact route. Those older packets must still be regenerated. */
      if (!hasContactRoute({ ...storedContact, full_name: storedContact.full_name })) {
        return reply.status(409).send({ error: 'This resume was made without an email address or a phone number on it. Generate it again to add your contact details, then edit it.' });
      }
      if (resumeEditDisposition(review.status, Boolean(review.submission_claimed_at)) !== 'start') {
        return reply.status(409).send({ error: 'This resume cannot be edited while its application is active or complete' });
      }
      if (review.role) {
        edited.target_role = resumeSafeTargetRole(review.role);
      }

      const userId = request.jwtPayload!.userId;
      const [bank, profileRows, applicationProfile] = await Promise.all([
        readExperienceBankOrSeedFromBaseResume(userId),
        db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1),
        loadApplicationProfileLike(userId),
      ]);
      const currentResumeEmail = resumeEmailOfRecord(profileRows[0]?.parsed_json);
      if (!resumePacketEmailIsCurrent(storedContact.email, currentResumeEmail)) {
        return reply.status(409).send({
          error: 'Your personal resume email changed or is missing. Regenerate this application before editing it.',
          code: 'resume_email_regeneration_required',
        });
      }
      const contact = refreshResumeContactFromProfile(
        { ...storedContact, full_name: storedContact.full_name },
        applicationProfile as Record<string, unknown>,
      );
      const parsed = profileRows[0]?.parsed_json as {
        school?: string;
        degree?: string;
        grad_date?: string;
        grad_year?: number;
        currently_enrolled?: boolean;
        coursework?: string[];
        gpa?: string;
        gpa_scale?: string;
        school_location?: string;
        recent_experience_review?: { selected_entry_id?: string | null; continue_with_found?: boolean };
      } | undefined;
      // Shared with the send-time guards on submit-request and extension-start. The dashboard and
      // the unattended routes have to read the profile the same way, or a packet this route just
      // approved could be refused seconds later at submission.
      const education = candidateEducationFromParsedProfile(parsed);
      const declaredSkills = declaredSkillsList(profileRows[0]?.skills);
      const grounded = pruneUngroundedSkills(edited, bank, declaredSkills);
      edited = grounded.spec;
      const selectedLead = selectJdAlignedLead(edited, review.jd_text, {
        company: applicationCompany(row),
        role: review.role,
      });
      edited = selectedLead.spec;
      const validation = validateResumeSpec(
        edited,
        review.jd_text,
        bank,
        declaredSkills,
        education,
        review.role,
        {
          allowedSingleBulletEntries: allowedSparseEntriesForApplicationEdit(parsed, bank),
        },
      );
      const editedLeadIssues = selectedLead.issues.length > 0
        ? selectedLead.issues
        : leadAlignmentIssues(edited, review.jd_text, {
          context: { company: applicationCompany(row), role: review.role },
        });
      validation.issues.push(...editedLeadIssues);
      if (validation.issues.length > 0) {
        return reply.status(422).send({
          error: 'Fix the flagged resume content before continuing.',
          issues: validation.issues,
        });
      }

      const rendered = await renderResumePdf(edited, { ...contact, full_name: contact.full_name }, review.jd_text);
      const visual = validateResumeVisualLayout(rendered.layout);
      const parsedPdf = await extractPdfText(rendered.buffer);
      const applicantIdentity = stored._applicant_email && typeof stored._applicant_email === 'object'
        ? stored._applicant_email as { address?: unknown; source?: unknown }
        : null;
      const pdfIssues = [
        ...leadAlignmentIssues(rendered.spec, review.jd_text, {
          context: { company: applicationCompany(row), role: review.role },
        }),
        ...visual.issues,
        ...validatePdfLayout(parsedPdf.text, parsedPdf.numpages).issues,
        ...findPdfSafeMarginIssues(parsedPdf.pages, rendered.layout),
        ...findPdfTextFidelityIssues(parsedPdf.text, rendered.spec, { ...contact, full_name: contact.full_name }),
        ...(applicantIdentity?.source === 'litos_alias'
          && typeof applicantIdentity.address === 'string'
          && parsedPdf.text.toLowerCase().includes(applicantIdentity.address.toLowerCase())
          ? ['the tracked application routing email must not appear on the resume PDF']
          : []),
      ];
      if (pdfIssues.length > 0) {
        return reply.status(422).send({ error: 'The edited resume does not fit the one-page layout.', issues: pdfIssues });
      }

      const requestedKey = `users/${userId}/resumes/${row.id}-edited-${randomUUID()}.pdf`;
      const blob = await put(requestedKey, rendered.buffer, { access: 'public', contentType: 'application/pdf' });
      const updatedReview = {
        ...review,
        status: review.questions.length > 0 ? 'questions_ready' : 'ready_to_submit',
        edited_terms: deriveEditedTerms(rendered.spec, bank),
        updated_at: new Date().toISOString(),
      };
      const updatedSpec = {
        ...rendered.spec,
        _contact: contact,
        // Every stored key the edit does not recompute, from the one list that names them. Spread
        // before _review and _quality because those two ARE recomputed and have to win.
        ...preservedApplicationSpecKeys(stored),
        // Through settleStall like every other writer: this route can run on an application that is
      // waiting on a challenge, and abandoning that wait has to close it rather than carry an open
      // stall into a status the queue no longer looks at.
      _review: settleStall(updatedReview as ApplicationReviewState),
        _quality: {
          ...(stored._quality as Record<string, unknown> | undefined),
          pdfGenerationBinding: createPdfGenerationBinding(rendered.spec, blob.pathname, rendered.buffer, contact.email ?? ''),
          atsCoverage: validation.ats_keyword_coverage_pct,
          visualWarnings: visual.warnings,
          groundingRemoved: grounded.removed,
          layoutOmissions: rendered.omissions,
        },
      };
      const runResumeEditTransaction = (database: typeof db) => database.transaction(async (tx) => {
        const changed = await tx
          .update(generated_resumes)
          .set({ spec: updatedSpec, resume_object_key: blob.pathname })
          .where(and(
            eq(generated_resumes.id, row.id),
            eq(generated_resumes.user_id, userId),
            sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
            sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
            sql`${generated_resumes.spec}->'_review'->>'status' = ${review.status}`,
          ))
          .returning({ id: generated_resumes.id });
        if (changed.length === 0) return changed;
        await appendEditedResumeArtifactVersion(tx, {
          userId,
          legacyGeneratedResumeId: row.id,
          structuredContent: updatedSpec,
          jobContext: row.job_context,
          renderedObjectKey: blob.pathname,
          renderedBlobUrl: blob.url,
        });
        return changed;
      });

      let updated: Array<{ id: string }>;
      try {
        updated = await withReadOnlyRetry(
          () => runResumeEditTransaction(db),
          {
            onRetry: (attempt) => request.log.warn(
              { attempt, applicationId: row.id },
              'Resume edit transaction reached a read-only backend; retrying on a fresh pooled connection',
            ),
            onExhausted: () => withDedicatedDatabase((directDb) => {
              request.log.warn(
                { applicationId: row.id },
                'Resume edit pooled transactions stayed read-only; retrying on the direct database endpoint',
              );
              return runResumeEditTransaction(directDb);
            }),
          },
        );
      } catch (error) {
        await del(blob.url).catch(() => undefined);
        throw error;
      }
      if (updated.length === 0) {
        await del(blob.url).catch(() => undefined);
        return reply.status(409).send({ error: 'The application state changed before the resume edit finished' });
      }

      return reply.send({
        id: row.id,
        /* The rebuilt spec is now carrying _documents, so it is now a Blob pointer on the wire and
         * has to leave through the stripper like every other spec-serializing route. The fix that
         * kept the attachment through an edit is what put the key in this payload: before it, the
         * rebuild dropped _documents entirely and this response was accidentally safe. */
        spec: specWithoutDocumentPointers(updatedSpec),
        download_url: `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(userId, blob.pathname, {
          blobUrl: blob.url,
          fileName: resumeFileNameForRole(contact.full_name, ((row.job_context ?? {}) as { role?: unknown }).role),
        })}`,
      });
    },
  );

  fastify.put(
    '/applications/:id/review',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = reviewBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'We could not read this application', detail: parsed.error.issues });
      const stored = row.spec as StoredSpec;
      const current = readApplicationReview(stored);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      /* THE CLAIM IS PART OF THE QUESTION, and leaving it out made this the shortest way past every
       * submission gate in the product.
       *
       * submissionWasClaimed defaults to false, so a one-argument call asks "is this status
       * re-runnable when nothing has been claimed", which is not the question a claimed row is
       * posing. A needs_attention row wearing the claim its run took answered 'start' here, and
       * applyApplicationReviewEdit writes status 'questions_ready' or 'ready_to_submit' over the
       * top of a `...current` spread - so ONE request turned a packet holding a confirmed receipt,
       * an unresolved unverified_submission or a standing security_code into a state
       * submitRequestDisposition starts unconditionally, with all of that evidence still on the
       * row. That is a duplicate application at an employer who caps them, and it cannot be taken
       * back.
       *
       * DELIBERATELY THE TWO-ARGUMENT FORM, not the four-argument one submit-request uses. The
       * third and fourth parameters are UNLOCK KEYS whose safety was argued for the send path
       * specifically - the applicant's own "I looked and it is not there", and the row's own proof
       * that a stop preceded the click - and widening a security fix to hand those keys to a
       * different route is a change nobody has measured. Nothing is trapped by leaving them out:
       * both keyed states keep their exit through POST /submit-request, which does pass them. */
      if (submitRequestDisposition(current.status, Boolean(current.submission_claimed_at)) !== 'start') {
        return reply.status(409).send({ error: 'This application can no longer be edited from its current submission state' });
      }
      // Not a spread here: an edit that changes portal_url has to re-derive portal_supported with
      // it, or the review persists a new URL next to the old verdict. See applyApplicationReviewEdit.
      const next = applyApplicationReviewEdit(current, parsed.data);
      const claimed = await db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
        ))
        .returning({ id: generated_resumes.id });
      if (claimed.length === 0) {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({
          application_id: row.id,
          review: review ?? current,
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      return reply.send({
        application_id: row.id,
        review: next,
        retry_safety: await packetRetrySafety(row),
      });
    },
  );

  /* SAVE THE ANSWERS. START NOTHING. LEAVE THE STATUS WHERE IT IS.
   *
   * THE DEFECT THIS EXISTS FOR. The Review-answers screen's Save button persisted nothing at all,
   * for packets stopped at needs_attention - the ones whose entire remaining ask is an answer only
   * the applicant can give. It called a local-only handler, showed "Saved." synchronously, and
   * issued no request. Through d0d71a0 that button went to POST /submit-request; 8240abe narrowed
   * the local-only save to the Apply-time pre-script, which is correct for THAT screen because the
   * answers there ride into the packet on the next step; and 5410ba8 then made the local-only
   * version unconditional, so the stalled-run path fell into it too.
   *
   * WHY THIS IS A THIRD ROUTE RATHER THAN EITHER OF THE TWO THAT EXIST.
   *
   *   POST /submit-request   books a browser run. Not starting one is the whole reason the Save
   *                          button stopped calling it, and a save that files an application is a
   *                          worse defect than a save that files nothing.
   *   PUT  /review           writes 'questions_ready' or 'ready_to_submit' over the status - see
   *                          applyApplicationReviewEdit - so it would clear the needs_attention the
   *                          applicant is answering FROM. It also refuses this packet outright:
   *                          its gate is submitRequestDisposition, which answers 'reject' for a
   *                          claimed needs_attention row, which is what a stopped run leaves.
   *
   * So: the same review round both of those rely on, minted here and passed INTO the merge, with the
   * status left alone and a gate that asks the question a save actually poses. See
   * reviewAnswerSaveDisposition for what it refuses and why.
   *
   * MERGED ONTO THE STORED QUESTIONS, not substituted for them, which is where PUT /review's
   * treatment would also have been wrong. questionSchema strips every field a run wrote and a client
   * cannot vouch for, so a wholesale replacement drops the ATS field binding the fill types into and
   * the answer_option_source that says what a banded answer was snapped from.
   * mergeSubmittedApplicationReviewQuestions keeps the stored record and adopts the answer, which is
   * the only thing this route is being asked to change. */
  fastify.put(
    '/applications/:id/review/answers',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = reviewAnswersBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'We could not read these answers', detail: parsed.error.issues });
      const current = readApplicationReview(row.spec as StoredSpec);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      // The row, not its status. needs_attention is also what a run that may have pressed submit
      // leaves behind, and only the evidence fields on the row tell those two apart.
      if (reviewAnswerSaveDisposition(current) !== 'save') {
        return reply.status(409).send({
          error: 'These answers can no longer be edited from this application’s current submission state',
          code: 'REVIEW_ANSWERS_NOT_EDITABLE',
        });
      }
      /* THE MERGE'S OWN NARROW RULE IS THE ONLY THING THAT MAY MINT A CLAIM HERE, and the round is
       * minted FIRST so that rule can actually run.
       *
       * WHAT THE OTHER COMPOSITION DID. Passing `current.questions_reviewed_at` into the merge and
       * then stamping the result with applyApplicantReviewedAnswers is two mistakes that hide each
       * other. The merge's applicantSuppliedAnswer is gated on a round existing, and a round is
       * written only by a save through these routes - NULL on 272 of the 286 needs_attention rows in
       * production on 2026-08-13 - so on those rows the narrow rule was dead and recorded nothing.
       * applyApplicantReviewedAnswers then stamped 'applicant_review' and a fresh answer_reviewed_at
       * on EVERY question in the merged list carrying any non-empty answer, which is a blanket claim
       * about answers the applicant never touched.
       *
       * WHAT THAT LAUNDERED. Replaying both calls against all 272 live NULL-round rows: 802 answers
       * across 174 packets would flip from blanked by refreshKnownQuestionAnswers to surviving it,
       * as HER answers. Among them 'gender' -> 'Female', 'disability status' -> 'I do not want to
       * answer', 'veteran status' -> 'Decline to self-identify', 'do you now or will you in the
       * future require immigration sponsorship' -> 'Yes', and compensation expectations of
       * 'USD 175,000 per year'. Those are EEO self-identifications and personal declarations, which
       * is exactly the category Litos holds back BECAUSE only the applicant may answer them. Against
       * 14 answers carrying applicant_review in all of production and 2531 non-empty unattributed
       * ones, a save that mints 802 claims is not established behaviour, it is a new one.
       *
       * SO: mint the round, pass it in, and let the write set only the round. This is
       * resolveSubmittedApplicationAnswers minus the refresh, which is the composition the send path
       * already uses. An answer typed into a blank still gets its claim, keyed to a round that now
       * exists, which is the whole of what the blocked packets need. An answer she never touched
       * stays unclaimed, and a question the request never mentioned is not touched at all.
       *
       * applyApplicantReviewedAnswers stays where it is for applyApplicationReviewEdit. Its blanket
       * stamp over an edit's own questions is shipped behaviour with its own tests, and narrowing it
       * is not this route's to do. */
      const reviewedAt = current.questions_reviewed_at ?? new Date().toISOString();
      /* WHAT THE SCREEN WAS ACTUALLY SHOWING, which is not what this row holds.
       *
       * GET /applications/:id/submission serves refreshKnownQuestionAnswers' output and persists
       * nothing, so a row carrying a value the resolver has since corrected is DISPLAYED corrected,
       * and this route's body is the whole list the screen was holding. Without the resolver the merge
       * compares against the row, reads every one of those as an edit, and stamps answers she never
       * typed as her own - measured on a stale Gender record displayed as a self-identification.
       * The same lookup also names the value an override was made against. See the merge's
       * resolverAnswerFor parameter. */
      const resolverAnswerFor = knownAnswerLookup(
        await loadSensitiveQuestionProfile(request.jwtPayload!.userId),
        current.jd_text,
        postingCountryFromJobContext(row.job_context),
        postingCountryCodeFromJobContext(row.job_context),
      );
      /* MEASURED, BECAUSE THE STORED CLAIM CANNOT BE. A confirm-minted claim is byte-identical to an
       * edit-minted one on the row, so if a client ever regresses into flagging whole lists - the
       * shape of the 802-answer laundering - the packets themselves cannot show it happened. This
       * line is the trace: the count of confirmations per save, next to the application, in the
       * request log where an incident investigation actually looks. The intended client sends one
       * or two; a save arriving with dozens is the regression announcing itself. */
      const confirmedCount = parsed.data.questions.filter((question) => question.confirmed === true).length;
      if (confirmedCount > 0) {
        request.log.info({ applicationId: row.id, confirmedAnswers: confirmedCount }, 'review answers save carries applicant confirmations');
      }
      const merged = mergeSubmittedApplicationReviewQuestions(
        current.questions,
        parsed.data.questions as SubmittedApplicationReviewQuestion[],
        reviewedAt,
        resolverAnswerFor,
      );
      const next: ApplicationReviewState = {
        ...current,
        questions: merged,
        questions_reviewed_at: reviewedAt,
        updated_at: new Date().toISOString(),
      };
      const saved = await db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
        ))
        .returning({ id: generated_resumes.id });
      if (saved.length === 0) {
        /* The row moved under the save, which for this packet means a run wrote to it. Answer with
         * what is actually stored rather than with what this request wanted to store, so the screen
         * stops showing a save that did not land. Same shape as the edit route above.
         *
         * `saved: false` IS WHAT MAKES THAT CONTRACT REACHABLE, and without it the sentence above
         * described an intention rather than a behaviour. The 202 body was shape-identical to the
         * 200's, and the client's fetch wrapper resolves on any res.ok and returns the parsed body
         * with the status discarded, so nothing downstream could tell the two apart. The screen
         * showed "Saved.", replaced the applicant's typing with the stored review that does not
         * contain it, and navigated away - which is the original defect happening again, on the one
         * response that exists to say it happened. Present ONLY here: a 200 carries no `saved` key,
         * so the client reads the discriminator rather than an absence. */
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({ application_id: row.id, review: review ?? current, saved: false });
      }
      return reply.send({ application_id: row.id, review: next });
    },
  );

  /* TICK ONE ROW OF THE "Your turn" PANEL, AND PERSIST THE TICK. NOTHING ELSE MOVES.
   *
   * THE DEFECT THIS EXISTS FOR. The panel's per-row checkbox ("Mark ... done") had no handler, no
   * state and no request behind it - the same dead-control class as the styled-span action pills
   * this file already repaired. Ticking a box changed nothing, and the next poll re-rendered the
   * panel with the box cleared. Measured on the Easy Dynamics rippling packet, 2026-08-20.
   *
   * WHY A ROUTE OF ITS OWN. PUT /review rewrites the status and refuses a claimed stopped run, and
   * PUT /review/answers writes question answers, which a blocker line does not have: the rows this
   * checkbox sits on are the ones whose only resolution is on the employer's own page. What a tick
   * stores is the applicant's word that she handled that line herself - a claim, never a
   * measurement, which is why it is DISPLAY-ONLY: the send gate keeps reading the run's own
   * measurements, and a required-and-empty field blocks a send whether or not its row is ticked.
   * The status, the claim, the run id and attention_reason are all left exactly where they are.
   *
   * NO DISPOSITION GATE, DELIBERATELY. Every gated route here either starts a run or rewrites what
   * a run measured, and the gates exist to stop those happening twice. This writes an annotation
   * the send path never reads, so there is no state it is unsafe in; a run writing concurrently is
   * handled by the same whole-spec compare-and-swap the sibling routes use, and the runner's own
   * fresh report drops the map anyway (see applyReviewPatch). */
  fastify.post(
    '/applications/:id/review/attention-acks',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = attentionAcknowledgementBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'We could not read this checklist tick', detail: parsed.error.issues });
      const current = readApplicationReview(row.spec as StoredSpec);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      const acknowledgements = { ...(current.attention_acknowledgements ?? {}) };
      /* Object.hasOwn, never `in`: `in` walks the prototype chain, so inherited names like
       * "constructor" would read as already present and slip past the cap. */
      const alreadyTicked = Object.hasOwn(acknowledgements, parsed.data.item_id);
      if (parsed.data.acknowledged) {
        if (!alreadyTicked && Object.keys(acknowledgements).length >= ATTENTION_ACKNOWLEDGEMENT_CAP) {
          return reply.status(400).send({ error: 'This application already carries more checklist ticks than the panel can hold' });
        }
        acknowledgements[parsed.data.item_id] = { label: parsed.data.label, acknowledged_at: new Date().toISOString() };
      } else {
        /* Unticking a row that holds no tick is a no-op, and a no-op must not write: it would bump
         * updated_at and rewrite the whole spec for zero semantic change, and its CAS churn could
         * fail a real concurrent save for nothing. */
        if (!alreadyTicked) return reply.send({ application_id: row.id, review: current });
        delete acknowledgements[parsed.data.item_id];
      }
      /* Through applyReviewPatch like every other writer - its own-property expiry rule does not
       * fire here, because this patch names attention_acknowledgements and never attention_reason,
       * and going around it would skip settleStall and withTerminalCause, the checks the shared
       * merge exists to make unskippable. Empty collapses to absent so an untick of the last row
       * leaves the review byte-identical to one never ticked, which the whole-spec CAS every write
       * in this file uses depends on. */
      const next = applyReviewPatch(current, {
        attention_acknowledgements: Object.keys(acknowledgements).length > 0 ? acknowledgements : undefined,
      });
      const saved = await db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
        ))
        .returning({ id: generated_resumes.id });
      if (saved.length === 0) {
        /* A run wrote to the packet under this tick, so the tick did not land - and must not be
         * retried blind, because the run's fresh report may have replaced the sentence she ticked.
         * Same 202 + `saved: false` discriminator as the answers route above, same reason: the
         * client's fetch wrapper resolves any res.ok and discards the status. */
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({ application_id: row.id, review: review ?? current, saved: false });
      }
      return reply.send({ application_id: row.id, review: next });
    },
  );

  fastify.post(
    '/applications/:id/submit-request',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = submitBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({
        error: 'Invalid answers',
        detail: parsed.error.issues,
        retry_safety: await packetRetrySafety(row),
      });
      /* The second half of the expired-handoff trap. submitRequestDisposition rightly refuses a
       * claimed needs_attention row, and its only key - the applicant's own 'not_sent' answer -
       * exists only for runs whose press outcome was unknown. A run that parked at an attended
       * handoff BEFORE pressing has no unverified record, so there is no question to answer and
       * this route refused it forever. The repair releases the claim only on the row's own proof
       * that nothing was pressed and the attended window is over; the disposition below then reads
       * the released row and answers 'start' the ordinary way, with every other gate intact. */
      row = await repairExpiredAttendedHandoffClaim(row, request.jwtPayload!.userId, request.log) ?? row;
      const stored = row.spec as StoredSpec;
      let current = readApplicationReview(stored);
      if (!current) return reply.status(409).send({
        error: 'Application review is not available for this resume',
        retry_safety: await packetRetrySafety(row),
      });
      current = await repairReviewPortalFromMonitoredJob(row, current);
      const disposition = submitRequestDisposition(
        current.status,
        Boolean(current.submission_claimed_at),
        current.unverified_submission?.resolution,
        // The row itself, so a packet whose stored evidence proves nothing reached the employer can
        // answer the retry question without the applicant being sent to look for an application that
        // was never filed. See submissionProvablyNotSent.
        current,
      );
      if (disposition === 'submitted') {
        return reply.status(200).send({
          application_id: row.id,
          review: current,
          cover_letter: storedCoverLetter(row),
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (disposition === 'in_flight') {
        return reply.status(202).send({
          application_id: row.id,
          review: current,
          cover_letter: storedCoverLetter(row),
          retry_safety: await packetRetrySafety(row),
        });
      }
      /* THE 409, AND THE DOOR OUT OF IT.
       *
       * 'reject' is right for a packet that has already reached the employer, and right by default
       * for one sitting at ready_for_final_approval: it is waiting on the applicant to look at a
       * filled form, not on more filling, and a replayed POST must not throw that away underneath
       * her. But "by default" is doing real work in that sentence. When the code that filled the
       * form has since changed, the stored review is evidence about a build that is no longer
       * running, and before this the only way to refresh it was to submit a full resume edit -
       * re-rendering the PDF and re-running every layout validation - to change nothing about the
       * resume. R-066 makes applications write-once with no delete, so there was no other way out
       * at all. Four of 25 packets were stuck exactly here on 2026-08-08.
       *
       * So restarting is possible and has to be ASKED FOR by name. The response says so, and names
       * the build the stale review came from, so the caller can decide rather than guess. */
      const restartable = preparedRunCanRestart(current.status, Boolean(current.submission_claimed_at));
      if (disposition === 'reject' && !(restartable && parsed.data.restart === true)) {
        return reply.status(409).send(restartable
          ? {
            error: 'This application is already filled and waiting for you to look it over. '
              + 'Ask again with restart to discard that filled form and fill it again.',
            code: 'PREPARED_RUN_RESTARTABLE',
            restartable: true,
            run_revision: current.run_revision ?? null,
            retry_safety: await packetRetrySafety(row),
          }
          /* A REFUSAL THAT SAYS WHY, when the thing holding this packet is an unresolved submit.
           *
           * The generic sentence below is the one Skydio packet 13bccb2d would have got: the
           * applicant was told by attention_reason to check the portal and try again, and trying
           * again returned "cannot start another submission run from its current state" with no
           * cause and no exit. The refusal is correct - the employer may already hold this
           * application - but a correct refusal that names neither the reason nor the way out is
           * indistinguishable from a bug. */
          : current.unverified_submission && !current.unverified_submission.resolution
            ? {
              error: 'Litos pressed Send on this one and could not confirm what came back, so it will '
                + 'not send it a second time until you have looked. Open the employer’s page, then tell '
                + 'Litos whether the application is there: POST /applications/:id/submission/unverified '
                + 'with found true or false. If it is not there, Litos will send this one for you.',
              code: 'SUBMISSION_OUTCOME_UNVERIFIED',
              restartable: false,
              unverified_submission: current.unverified_submission,
              retry_safety: await packetRetrySafety(row),
            }
          : {
            error: 'This application cannot start another submission run from its current state',
            code: 'SUBMISSION_RUN_NOT_RESTARTABLE',
            restartable: false,
            retry_safety: await packetRetrySafety(row),
          });
      }
      /* THE DUPLICATE GATE for everything this route can reach.
       *
       * This route forks below into two sends: the unsupported-portal EMAIL FALLBACK, which
       * reaches the employer inside this same request, and the managed browser run. The browser
       * run is guarded again inside submissionRunner.submit, and that repetition is deliberate
       * rather than redundant, because standing consent reaches submit without ever coming through
       * here. The check sits here as well so the email fallback is covered and so a duplicate
       * costs no browser minutes.
       *
       * After repairReviewPortalFromMonitoredJob, because the posting key is read off portal_url
       * and the repair is what fills it in on a packet that lost it.
       *
       * Ahead of the required-answer, education-drift and sensitive-question gates on purpose. All
       * three ask the applicant to go fix something; this one is telling her there is nothing to
       * fix, and asking her to correct answers on a form that will never be sent wastes her time
       * and reads as though the send is still available. */
      const duplicateVerdict = await refuseDuplicateApplication(
        row,
        current,
        request.jwtPayload!.userId,
        fastify.log,
      );
      if (duplicateVerdict.kind !== 'clear') {
        return reply.status(409).send({
          ...duplicateRiskResponse(duplicateVerdict),
          retry_safety: await packetRetrySafety(row),
        });
      }
      // Guarded here as well as on extension-start, and not because this route is unattended today.
      // The dashboard now refuses to send a drifted packet, but a frontend check is not an
      // enforcement point: this audit exists because a client-side assumption turned out to be
      // false, and submit-request accepts a bare list of answers from any authenticated caller. The
      // review screen saves through PATCH /resume before it sends, and that route runs this exact
      // comparison, so a correctly-saved packet reaches this line with nothing to report.
      const [submitProfileRows, sensitiveProfile] = await Promise.all([
        db.select({ parsed_json: profiles.parsed_json })
          .from(profiles).where(eq(profiles.user_id, request.jwtPayload!.userId)).limit(1),
        loadSensitiveQuestionProfile(request.jwtPayload!.userId),
      ]);
      const submittedQuestions = parsed.data.questions as ApplicationReviewQuestion[];
      /* A REVIEW ROUND FOR THIS BODY, NOT ONLY FOR WHATEVER ROUND THE ROW ALREADY HAD. The merge,
       * the refresh and the review this persists all have to be keyed to the same one, so they are
       * one call. See resolveSubmittedApplicationAnswers for the 130 packets on which reusing an
       * absent stored round erased the applicant's own answer on the request that reaches the
       * employer. */
      /* current.jd_text overridden below to applicationContextForQuestionResolution(row, current),
       * not passed bare. resolveSubmittedApplicationAnswers only reads jd_text to resolve known
       * answers (the merge's resolverAnswerFor lookup and its own refresh), and that resolution has
       * to agree with what the actual fill computes - buildPacket and discoverAndResolveQuestions in
       * submissionRunner.ts, both already on this richer context - or the questions acknowledged
       * here disagree with the packet the fill produces for no reason the applicant caused. See
       * applicationContextForQuestionResolution's own comment for the mechanism. */
      const submitResolutionCurrent = { ...current, jd_text: applicationContextForQuestionResolution(row, current) };
      const submitAsOf = new Date();
      const { questions: normalizedSubmittedQuestions, questionsReviewedAt: submittedReviewedAt } =
        resolveSubmittedApplicationAnswers({
          current: submitResolutionCurrent,
          submitted: submittedQuestions,
          profile: sensitiveProfile,
          postingCountry: postingCountryFromJobContext(row.job_context),
          postingCountryCode: postingCountryCodeFromJobContext(row.job_context),
          asOf: submitAsOf,
        });
      const canonicalSubmittedQuestions = resolvePacketAuditQuestionFixpoint(
        { ...current, questions: normalizedSubmittedQuestions, questions_reviewed_at: submittedReviewedAt },
        sensitiveProfile,
        submitResolutionCurrent.jd_text,
        postingCountryFromJobContext(row.job_context),
        postingCountryCodeFromJobContext(row.job_context),
        submitAsOf,
      );
      /* THE REQUIRED-ANSWER GATE, ON THE SEND AND NOT ON THE RUN.
       *
       * This route has two outcomes and they need opposite treatment. On a supported portal it
       * books a browser and the run FILLS the form, which is the only way a discovered question ever
       * gets answered - so refusing it here for a blank required answer is a closed loop: blank
       * blocks the run, and only the run can un-blank it. Measured on prod on 2026-08-08, this exact
       * check refused 15 of 25 packets, none of them opened a browser, and their untouched
       * attention_reason then reported an earlier build's results as if they were the current one.
       * The Greenhouse Discipline fix in bd1bab3 had been live for an hour and had never run once.
       *
       * On an UNSUPPORTED portal there is no run. The branch further down emails the packet to the
       * employer inside this same request, and that is a send, so the check stays in front of it.
       *
       * Nothing is weakened by the move. What used to be checked here is now checked at every point
       * that can actually reach an employer: the runner's direct-send decision, POST
       * /submission/approve, and clickFinalSubmit's read of the live form - and those see the
       * questions the run discovered rather than this pre-run snapshot of them. */
      const sendsWithoutAnotherRun = Boolean(current.portal_url) && !isPortalSupported(current.portal_url!);
      const blankRequired = blankRequiredQuestionLabels(canonicalSubmittedQuestions);
      if (sendsWithoutAnotherRun && blankRequired.length > 0) {
        return reply.status(422).send({
          error: 'Answer every required question before submitting.',
          questions: blankRequired,
          retry_safety: await packetRetrySafety(row),
        });
      }
      const submitEducationIssues = packetEducationDrift(stored, submitProfileRows[0]?.parsed_json);
      if (submitEducationIssues.length > 0) {
        return reply.status(422).send({
          ...educationDriftResponse(submitEducationIssues),
          retry_safety: await packetRetrySafety(row),
        });
      }
      const preSendIssues = await preSendResumeVerificationIssues(
        request.jwtPayload!.userId,
        stored,
        applicationCompany(row),
      );
      if (preSendIssues.length > 0) {
        return reply.status(422).send({
          error: 'Verify the resume before sending. The current packet is not ready for submission.',
          code: 'PRE_SEND_VERIFICATION_FAILED',
          issues: preSendIssues,
          retry_safety: await packetRetrySafety(row),
        });
      }
      const sensitive = sensitiveQuestionFor(
        canonicalSubmittedQuestions, sensitiveProfile, current.jd_text,
        postingCountryFromJobContext(row.job_context),
        postingCountryCodeFromJobContext(row.job_context),
      );
      // A supported portal needs the browser run to discover and surface the live form's
      // declarations. Blocking that run on the pre-run snapshot creates a deadlock: the question
      // cannot be answered until the form has been inspected, but inspection never starts. The
      // unsupported path below has no intervening fill and emails the employer immediately, so it
      // remains a send gate here. Final approval and direct browser submission retain their own
      // post-discovery gates.
      if (current.portal_url && !isPortalSupported(current.portal_url) && sensitive) {
        return reply.status(422).send({
          error: `Sensitive question requires your attention: ${sensitive.question.slice(0, 120)}`,
          retry_safety: await packetRetrySafety(row),
        });
      }
      const submitAudit = await currentAcknowledgedPacketAudit(row, {
        questions: canonicalSubmittedQuestions,
        restoreExpiredResume: 'authorizing_send',
      });
      if (!submitAudit.valid) {
        return reply.status(409).send({
          ...packetAuditClientError(submitAudit),
          retry_safety: await packetRetrySafety(row),
        });
      }
      /* REMEMBER THE ANSWERS THAT TRAVEL, so she is asked for each of them exactly once.
       *
       * Here rather than on the Apply screen, deliberately: this is the moment her answers are
       * final and have passed every guard above, and it is the ONE path every answer takes -
       * whether she typed it at Apply, edited it on the review screen, or corrected it after a
       * stall. A second write path on the Apply screen would remember answers she then changed.
       *
       * WHICH answers is lib/answerReuse's decision and it defaults to "none": an export-control
       * declaration and a skill self-rating are the same on every form and are kept, while
       * "which opening would you be most interested in" is about this posting and is not. Best
       * effort on purpose - failing to remember an answer costs her one retype on a later posting,
       * and failing her submission over it costs her the application. */
      void rememberReusableAnswers(
        request.jwtPayload!.userId,
        canonicalSubmittedQuestions.map((question) => ({ question: question.question, answer: question.answer })),
        { company: applicationCompany(row), jobId: applicationJobId(row) },
      ).catch((error: unknown) => {
        fastify.log.warn({ error, applicationId: row.id }, 'could not remember the answers that carry to other postings');
      });
      // Unsupported portals are handled here, before a browser is booked, because the answer has
      // been available since the packet was created. Without this branch the run would start, drive
      // a managed browser for minutes, and only then fail on detectPortal's throw. A client-side
      // portal_supported check is helpful UI, not an enforcement point.
      if (current.portal_url && !isPortalSupported(current.portal_url)) {
        const authorizedAt = new Date().toISOString();
        const claimId = randomUUID();
        const base = freshSubmitRequestReview(current, canonicalSubmittedQuestions, submittedReviewedAt);
        const pending: ApplicationReviewState = {
          ...base,
          status: 'submitting',
          updated_at: authorizedAt,
          ...submissionClaimPatch(authorizedAt, claimId),
          submission_authorization: current.submission_authorization ?? {
            source: 'per_application_approval',
            authorized_at: authorizedAt,
          },
        };
        const claimResult = await db.transaction(async (tx) => {
          await lockSubmissionAttemptUser(tx, request.jwtPayload!.userId);
          const duplicate = await duplicateApplicationVerdict({
            userId: request.jwtPayload!.userId,
            applicationId: row.id,
            jobContext: row.job_context,
            portalUrl: current.portal_url,
          }, tx);
          if (duplicate.kind !== 'clear') return { kind: 'duplicate_risk' as const, duplicate };
          const openedToday = await submissionAttemptsOpenedToday(request.jwtPayload!.userId, { executor: tx });
          if (!withinDailyCap(openedToday, dailySubmissionCap())) return { kind: 'cap' as const };
          const claimed = await tx.update(generated_resumes)
            .set({ spec: reviewSpec(pending) })
            .where(and(
              eq(generated_resumes.id, row.id),
              eq(generated_resumes.user_id, request.jwtPayload!.userId),
              sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
              sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
            ))
            .returning();
          if (!claimed[0]) return { kind: 'changed' as const };
          const attemptBinding = applicationAttemptBinding({
            row: claimed[0],
            review: pending,
            attemptId: claimId,
            source: 'unsupported_email',
            packetVersion: submitAudit.audit.packet_version,
          });
          await appendApplicationAttemptFact(attemptBinding, 'attempt_opened', 'reservation', {
            evidenceCode: 'atomic_email_claim_reserved',
            executor: tx,
          });
          return { kind: 'claimed' as const, row: claimed[0], attemptBinding };
        });
        if (claimResult.kind === 'duplicate_risk') {
          return reply.status(409).send({
            ...duplicateRiskResponse(claimResult.duplicate),
            retry_safety: await packetRetrySafety(row),
          });
        }
        if (claimResult.kind === 'cap') {
          return reply.status(429).send({
            error: 'Daily automatic submission safety limit reached',
            retry_safety: await packetRetrySafety(row),
          });
        }
        if (claimResult.kind === 'changed') {
          const refreshed = await ownedResume(request, reply);
          if (!refreshed) return;
          const review = readApplicationReview(refreshed.spec);
          return reply.status(202).send({
            application_id: row.id,
            review: review ?? current,
            retry_safety: await packetRetrySafety(refreshed),
          });
        }
        const claimedRow = claimResult.row;
        const emailAttemptBinding = claimResult.attemptBinding;
        let sent: { messageId: string; recipient: string };
        let crossedSendBoundary = false;
        const finalBoundaryState: {
          stop: Exclude<FinalApplicationBoundaryGate, { kind: 'clear' }> | null;
        } = { stop: null };
        try {
          const packet = await buildPacket(claimedRow, false, canonicalSubmittedQuestions);
          const preparedEmail = prepareUnsupportedPortalApplicationEmail({
            application: claimedRow,
            review: pending,
            packet,
          });
          const envelope = employerDeliveryEnvelope({
            channel: 'unsupported_email',
            destinationUrl: preparedEmail.recipient,
            portalFamily: 'unsupported',
            coverLetterSupported: pending.cover_letter_supported,
            transcriptSupported: pending.transcript_supported,
            email: preparedEmail.message,
          });
          sent = await transportVerifiedBuiltPacket(
            packet,
            submitAudit.audit,
            canonicalSubmittedQuestions,
            async () => {
              const boundaryGate = await finalApplicationBoundaryGate({
                row: claimedRow,
                binding: emailAttemptBinding,
                factKey: 'email-final-duplicate-recheck',
              });
              if (boundaryGate.kind !== 'clear') {
                finalBoundaryState.stop = boundaryGate;
                throw new Error('FINAL_SUBMISSION_BOUNDARY_BLOCKED');
              }
              // Resend can accept the message and then lose the response. Persist the risk first so
              // every throw after this line is treated as possibly delivered, never as safe retry.
              await appendApplicationAttemptFact(emailAttemptBinding, 'press_observed', 'email-dispatch', {
                evidenceCode: 'unsupported_email_dispatch_started',
              });
              crossedSendBoundary = true;
              return sendPreparedUnsupportedPortalApplicationEmail(preparedEmail);
            },
            'full',
            envelope,
          );
        } catch (error) {
          const finalBoundaryStop = finalBoundaryState.stop;
          if (finalBoundaryStop) {
            if (finalBoundaryStop.kind === 'blocked') {
              return reply.status(409).send({
                ...duplicateRiskResponse(finalBoundaryStop.verdict),
                retry_safety: await packetRetrySafety(finalBoundaryStop.row),
              });
            }
            const refreshed = await ownedResume(request, reply);
            if (!refreshed) return;
            return reply.status(409).send({
              error: 'The application changed during its final duplicate-safety recheck.',
              retry_safety: await packetRetrySafety(refreshed),
            });
          }
          request.log.warn({ error, applicationId: row.id }, 'Unsupported portal email fallback failed');
          const failedAt = new Date().toISOString();
          if (!crossedSendBoundary) {
            await appendApplicationAttemptFact(emailAttemptBinding, 'not_sent_proven', 'email-pre-dispatch-stop', {
              proofKind: 'typed_pre_click_stop',
              evidenceCode: 'email_packet_withheld_before_dispatch',
              observedAt: new Date(failedAt),
            });
          }
          const failed = crossedSendBoundary
            ? applyReviewPatch(pending, {
              status: 'needs_attention',
              submission_attempted_at: failedAt,
              unverified_submission: {
                at: failedAt,
                cause: 'no_confirmation_state',
                ...(pending.portal_url ? { portal_url: pending.portal_url } : {}),
                ...(pending.submission_run_id ? { submission_run_id: pending.submission_run_id } : {}),
              },
              submission_error: 'Litos could not verify whether the application email was accepted.',
              attention_reason: 'Litos sent this application email but lost the delivery result. Check with the employer before trying again.',
              attention_categories: ['unverified_submission'],
            }, () => failedAt)
            : applyReviewPatch(pending, {
              status: 'failed',
              submission_claimed_at: undefined,
              submission_claim_id: undefined,
              submission_error: 'Litos could not build the application email.',
              attention_reason: 'Litos stopped before sending this application email. Nothing reached the employer.',
            }, () => failedAt);
          await db.update(generated_resumes)
            .set({ spec: reviewSpec(failed) })
            .where(and(
              eq(generated_resumes.id, row.id),
              sql`${generated_resumes.spec}->'_review'->>'status' = 'submitting'`,
              sql`${generated_resumes.spec}->'_review'->>'submission_run_id' = ${pending.submission_run_id}`,
              sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${claimId}`,
            ));
          return reply.status(503).send({
            error: crossedSendBoundary
              ? 'Litos could not verify the email result. Check with the employer before trying again.'
              : 'Litos stopped before emailing this application.',
            code: 'UNSUPPORTED_PORTAL_EMAIL_UNAVAILABLE',
            retry_safety: await packetRetrySafety(row),
          });
        }
        const submittedAt = new Date().toISOString();
        await appendApplicationAttemptFact(emailAttemptBinding, 'submission_confirmed', 'email-provider-receipt', {
          evidenceCode: 'unsupported_email_provider_accepted',
          observedAt: new Date(submittedAt),
        });
        const next: ApplicationReviewState = {
          ...pending,
          status: 'submitted',
          updated_at: submittedAt,
          submitted_at: submittedAt,
          submission_error: undefined,
          receipt: {
            confirmation_text: `This application was emailed to ${sent.recipient}. Resend message id: ${sent.messageId}`,
            final_url: current.portal_url,
            captured_at: submittedAt,
            reference_id: sent.messageId,
            source: 'email_fallback',
          },
        };
        const updated = await db.update(generated_resumes)
          .set({
            spec: reviewSpec(next),
            pipeline_stage: 'applied',
            pipeline_stage_at: new Date(submittedAt),
          })
          .where(and(
            eq(generated_resumes.id, row.id),
            sql`${generated_resumes.spec}->'_review'->>'status' = 'submitting'`,
            sql`${generated_resumes.spec}->'_review'->>'submission_run_id' = ${pending.submission_run_id}`,
            sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${claimId}`,
          ))
          .returning();
        if (updated.length === 0) {
          const refreshed = await ownedResume(request, reply);
          if (!refreshed) return;
          const review = readApplicationReview(refreshed.spec);
          return reply.status(202).send({
            application_id: row.id,
            review: review ?? current,
            retry_safety: await packetRetrySafety(refreshed),
          });
        }
        // The application left as an email; the canonical row must stop offering to send it.
        await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
        const [refreshed] = await db.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
        )).limit(1);
        const responseRow = refreshed ?? { ...claimedRow, spec: { ...(claimedRow.spec as StoredSpec), _review: next } };
        return reply.status(202).send({
          application_id: row.id,
          review: readApplicationReview(responseRow.spec) ?? next,
          cover_letter: storedCoverLetter(responseRow),
          retry_safety: await packetRetrySafety(row),
        });
      }
      const controlledTest = process.env.LITOS_ENABLE_TEST_PORTAL === 'true'
        && current.portal_url
        && detectPortal(current.portal_url) === 'controlled_test';
      if (!controlledTest && !isBrowserbaseConfigured()) {
        return reply.status(503).send({
          error: 'Litos cannot fill in company pages yet.',
          code: 'PORTAL_RUNNER_NOT_CONFIGURED',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const next = freshSubmitRequestReview(current, canonicalSubmittedQuestions, submittedReviewedAt);
      const claimed = await db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
        ))
        .returning({ id: generated_resumes.id });
      if (claimed.length === 0) {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({
          application_id: row.id,
          review: review ?? current,
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      const processed = await processSubmissionApplication(row.id, fastify);
      const [refreshed] = await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, request.jwtPayload!.userId),
      )).limit(1);
      const responseRow = refreshed ?? row;
      return reply.status(202).send({
        application_id: row.id,
        review: readApplicationReview(responseRow.spec) ?? processed ?? next,
        cover_letter: storedCoverLetter(responseRow),
        retry_safety: await packetRetrySafety(responseRow),
      });
    },
  );

  fastify.get(
    '/applications/:id/submission/channels',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      let review = readApplicationReview(row.spec);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      review = await repairReviewPortalFromMonitoredJob(row, review);
      const assessment = assessAtsSubmissionChannel(review.portal_url);
      return reply.send({
        application_id: row.id,
        review_status: review.status,
        portal_url: review.portal_url,
        channels: assessment ? [assessment] : [],
      });
    },
  );

  fastify.get(
    '/applications/:id/submission',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let row = await ownedResume(request, reply);
      if (!row) return;
      let review = readApplicationReview(row.spec);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      review = await repairReviewPortalFromMonitoredJob(row, review);
      const profile = await loadSensitiveQuestionProfile(request.jwtPayload!.userId);
      review = {
        ...review,
        // Same context every live fill resolves against; see applicationContextForQuestionResolution.
        // What this route displays must agree with what a send will actually compute, or the client's
        // round trip back through submit-request re-diverges from the packet it just showed her.
        questions: resolvePacketAuditQuestionFixpoint(
          review,
          profile,
          applicationContextForQuestionResolution(row, review),
          postingCountryFromJobContext(row.job_context),
          postingCountryCodeFromJobContext(row.job_context),
          new Date(),
        ),
      };
      let handoff_packet_valid = true;
      const passiveManualCapability = review.status === 'needs_attention'
        ? attendedHandoffCapabilityForRow(row, review, 'manual_handoff')
        : null;
      if (review.status === 'needs_attention'
        && (review.browser_session_id || passiveManualCapability)) {
        const audit = await attendedPacketAudit(row, {
          // The response and this verdict must describe one snapshot. Re-resolving here could
          // validate Q2 while the response below displayed Q1 from the profile read above.
          questions: review.questions,
        });
        handoff_packet_valid = audit.valid;
      }
      const retrySafety = await packetRetrySafety(row);
      const claimedAttemptId = review.submission_claim_id;
      let recoverableManualBoundary: {
        attemptId: string;
        leaseId: string;
        activationId: string;
        active: boolean;
        capability: AttendedHandoffCapability;
      } | null = null;
      if (claimedAttemptId
        && z.string().uuid().safeParse(claimedAttemptId).success
        && retrySafety.kind === 'blocked_unverified'
        && retrySafety.attemptId === claimedAttemptId
        && retrySafety.reason === 'boundary_authorized') {
        const [binding, authorization, capability] = await Promise.all([
          attendedManualAttemptBinding(row, claimedAttemptId),
          submissionBoundaryAuthorization(row.user_id, claimedAttemptId),
          attendedManualAttemptCapability(row, claimedAttemptId),
        ]);
        const currentCapability = capability
          ? attendedHandoffCapabilityForRow(row, review, capability.kind)
          : null;
        if (binding
          && attendedManualAttemptMatchesCurrent(row, review, binding)
          && authorization
          && capability
          && currentCapability
          && attendedHandoffCapabilitiesMatch(currentCapability.capability, capability)
          && authorization.attemptId === claimedAttemptId
          && retrySafety.leaseId === authorization.leaseId
          && retrySafety.expiresAt === authorization.expiresAt) {
          recoverableManualBoundary = {
            attemptId: claimedAttemptId,
            leaseId: authorization.leaseId,
            activationId: authorization.activationId,
            active: authorization.active,
            capability,
          };
        }
      }
      const passiveAttendedCapability = recoverableManualBoundary?.capability
        ?? passiveAttendedHandoffCapabilityForRow(row, review, {
          manualHandoffPacketValid: handoff_packet_valid,
        });
      return reply.send({
        application_id: row.id,
        review: passiveSubmissionReview(review),
        retry_safety: retrySafety,
        cover_letter: storedCoverLetter(row),
        // Keyed by kind, and built by the one reader that strips object_key. The spec holds the
        // Blob pointer because the packet builder needs it; this envelope must never carry it,
        // since a Blob object is public-read forever to anyone holding its URL.
        documents: storedDocuments(row),
        handoff_packet_valid,
        configured: isBrowserbaseConfigured(),
        // Read-only recovery of an attempt whose employer boundary was already authorized. The
        // company URL is intentionally absent, so a poll cannot expose or reopen that boundary.
        manual_handoff_resume_available: recoverableManualBoundary?.active === true,
        ...(recoverableManualBoundary ? {
          manual_attempt_id: recoverableManualBoundary.attemptId,
        } : {}),
        ...(passiveAttendedCapability
          ? { attended_handoff_capability: passiveAttendedCapability }
          : {}),
        ...(recoverableManualBoundary?.active ? {
          boundary_lease_id: recoverableManualBoundary.leaseId,
          boundary_activation_id: recoverableManualBoundary.activationId,
        } : {}),
      });
    },
  );

  fastify.post(
    '/applications/:id/submission/self-submit-start',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsedBoundaryRequest = attendedBoundaryRequestSchema.safeParse(
        request.body === undefined ? {} : request.body,
      );
      if (!parsedBoundaryRequest.success) {
        return reply.status(400).send({
          error: 'A self-submit replay requires its complete authorization identity.',
          code: 'MANUAL_HANDOFF_REPLAY_INVALID',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const replay = attendedBoundaryReplay(parsedBoundaryRequest.data);
      let review = readApplicationReview(row.spec);
      if (review) review = await repairReviewPortalFromMonitoredJob(row, review);
      if (!review || review.status !== 'ready_for_final_approval') {
        return reply.status(409).send({
          error: 'This application is not waiting for you to finish it.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (documentAsksLitosCannotResolve(review, storedDocuments(row)).length === 0) {
        return reply.status(409).send({
          error: 'Litos can still finish this one. Review the filled form and send it from here.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const attendedCapability = attendedHandoffCapabilityForRow(row, review, 'self_submit');
      if (!attendedCapability) {
        return reply.status(409).send({
          error: 'This application no longer has an exact HTTPS employer page.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const reservation = await reserveAttendedManualAttempt(row, review, {
        ...(replay ? { replayAttemptId: replay.attemptId } : {}),
        attendedHandoffCapability: attendedCapability.capability,
      });
      if (reservation.kind === 'duplicate_risk') {
        return reply.status(409).send({
          ...duplicateRiskResponse(reservation.verdict),
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (reservation.kind === 'changed') {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        return reply.status(409).send({
          error: 'This application changed while its self-submit handoff was being reserved. Reload before continuing.',
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      if (reservation.kind === 'blocked') {
        return reply.status(409).send({
          error: 'Another submission attempt is still unresolved. Resolve it before opening the employer page.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (reservation.kind === 'replay_mismatch') {
        return reply.status(409).send({
          error: 'This self-submit replay does not match the active attempt.',
          code: 'MANUAL_HANDOFF_REPLAY_STALE',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const boundaryGate = await finalApplicationBoundaryGate({
        row: reservation.row,
        binding: reservation.binding,
        factKey: 'self-submit-start-final-duplicate-recheck',
        replay,
        attendedHandoffCapability: attendedCapability.capability,
      });
      if (boundaryGate.kind === 'blocked') {
        return reply.status(409).send({
          ...duplicateRiskResponse(boundaryGate.verdict),
          retry_safety: await packetRetrySafety(boundaryGate.row),
        });
      }
      if (boundaryGate.kind === 'already_authorized') {
        return reply.status(409).send({
          error: 'This employer handoff was already exposed. Resolve that exact attempt before opening it again.',
          code: 'MANUAL_HANDOFF_ALREADY_EXPOSED',
          retry_safety: boundaryGate.retrySafety,
        });
      }
      if (boundaryGate.kind === 'changed') {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        return reply.status(409).send({
          error: 'The application changed during its final duplicate-safety recheck.',
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      if (!boundaryGate.attendedHandoffCapability) {
        return reply.status(409).send({
          error: 'The self-submit capability could not be finalized safely. Reload before continuing.',
          retry_safety: await packetRetrySafety(reservation.row),
        });
      }
      const finalized = await finalizeAttendedHandoffCapability({
        row: reservation.row,
        binding: reservation.binding,
        authorization: boundaryGate.authorization,
        attendedHandoffCapability: boundaryGate.attendedHandoffCapability,
      });
      if (finalized.kind !== 'clear') {
        return reply.status(409).send({
          error: 'This self-submit handoff changed before its company page could be returned. Reload before continuing.',
          retry_safety: finalized.retrySafety,
        });
      }
      return reply.send({
        application_id: finalized.row.id,
        manual_attempt_id: reservation.binding.attemptId,
        boundary_lease_id: finalized.authorization.leaseId,
        boundary_activation_id: finalized.authorization.activationId,
        manual_handoff_resume_available: true,
        replay: boundaryGate.replay,
        attended_handoff_capability: finalized.attendedHandoffCapability,
        portal_url: finalized.url,
        review: finalized.review,
        retry_safety: finalized.retrySafety,
      });
    },
  );

  fastify.post(
    '/applications/:id/submission/handoff-complete',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = handoffCompleteBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) return reply.status(400).send({
        error: 'Invalid handoff completion request',
        retry_safety: await packetRetrySafety(row),
      });
      const stored = row.spec as StoredSpec;
      const current = readApplicationReview(stored);
      if (!current || current.status !== 'needs_attention') {
        return reply.status(409).send({
          error: 'This application is not waiting on you',
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (current.submission_claim_id !== parsed.data.attempt_id) {
        return reply.status(409).send({
          error: 'This manual submission attempt is no longer active.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const manualAttempt = await attendedManualAttemptBinding(row, parsed.data.attempt_id);
      if (!manualAttempt) {
        return reply.status(409).send({
          error: 'This employer handoff was not durably reserved. Reload before continuing.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const handoffAudit = await currentAcknowledgedPacketAudit(row, {
        // This route can observe a receipt from a form already submitted in the retained session.
        // Bind that receipt to the stored prepared snapshot without a post-send resolver read.
        questions: current.questions,
      });
      if (!handoffAudit.valid) {
        return reply.status(409).send({
          ...packetAuditClientError(handoffAudit),
          retry_safety: await packetRetrySafety(row),
        });
      }
      const now = new Date().toISOString();
      /* A verified receipt is positive evidence about the exact retained session. The short
       * boundary activation window prevents capability replay; it does not make a receipt observed
       * after that window untrue. Negative resolution remains permanently blocked by the immutable
       * boundary fact in completeAttendedHandoffNotSent. */
      if (parsed.data.outcome === 'submitted') {
        if (!current.browser_session_id) {
          return reply.status(409).send({
            error: 'Open the company page first so we can attach this submission to a live handoff.',
            retry_safety: await packetRetrySafety(row),
          });
        }
        let observedReceipt: Awaited<ReturnType<typeof readReceipt>>;
        try {
          const session = await getBrowserSession(current.browser_session_id);
          const connected = await connectToSession(session);
          try {
            observedReceipt = await readReceipt(connected.page);
          } finally {
            await connected.browser.close().catch(() => undefined);
          }
        } catch {
          return reply.status(409).send({
            error: 'Litos could not verify an employer confirmation in the retained company session. Nothing was marked submitted.',
            retry_safety: await packetRetrySafety(row),
          });
        }
        if (!extensionEmployerReceiptIsSufficient({
          atsName: current.ats_name,
          portalUrl: current.portal_url,
          confirmationText: observedReceipt.confirmationText,
          finalUrl: observedReceipt.finalUrl,
        })) {
          return reply.status(409).send({
            error: 'The retained company session does not show a verified receipt for this exact application.',
            retry_safety: await packetRetrySafety(row),
          });
        }
        const next = {
          ...current,
          status: 'submitted' as const,
          submitted_at: now,
          attention_reason: undefined,
          /* This spread bypasses applyReviewPatch, so the report's ticks are cleared by hand where
             the report itself is: they annotate the attention_reason on the line above and must not
             outlive it. */
          attention_acknowledgements: undefined,
          submission_error: undefined,
          updated_at: now,
          receipt: {
            confirmation_text: observedReceipt.confirmationText,
            final_url: observedReceipt.finalUrl,
            ...(observedReceipt.referenceId ? { reference_id: observedReceipt.referenceId } : {}),
            captured_at: now,
            source: 'attended_handoff' as const,
          },
        };
        const submitted = await db.transaction(async (tx) => {
          await lockSubmissionAttemptUser(tx, request.jwtPayload!.userId);
          const rows = await tx.update(generated_resumes)
            .set({
              spec: reviewSpec(next),
              pipeline_stage: 'applied',
              pipeline_stage_at: new Date(now),
            })
            .where(and(
              eq(generated_resumes.id, row.id),
              eq(generated_resumes.user_id, request.jwtPayload!.userId),
              sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
              sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
              sql`${generated_resumes.spec}->'_review'->>'status' = 'needs_attention'`,
              sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${parsed.data.attempt_id}`,
            ))
            .returning({ id: generated_resumes.id });
          if (!rows.length) return rows;
          await recordAttendedSubmissionFact(manualAttempt, new Date(now), 'handoff-complete', tx);
          return rows;
        });
        if (submitted.length === 0) {
          const refreshed = await ownedResume(request, reply);
          if (!refreshed) return;
          const review = readApplicationReview(refreshed.spec);
          return reply.status(202).send({
            application_id: row.id,
            review: review ?? current,
            retry_safety: await packetRetrySafety(refreshed),
          });
        }
        // The verified receipt filed the packet; the canonical row learns the same fact.
        await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
        return reply.send({
          application_id: row.id,
          review: next,
          cover_letter: storedCoverLetter(row),
          retry_safety: await packetRetrySafety(row),
        });
      }
      const completion = await completeAttendedHandoffNotSent(
        row,
        request.jwtPayload!.userId,
        parsed.data.attempt_id,
      );
      if (completion.kind === 'active_boundary') {
        return reply.status(409).send({
          error: 'This employer page was just opened and may still be able to submit. It cannot be marked not sent.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (completion.kind === 'missing_boundary' || completion.kind === 'boundary_risk') {
        return reply.status(409).send({
          error: 'This handoff cannot be proven not sent. Check the employer page and record whether the application was received.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (completion.kind === 'changed') {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({
          application_id: row.id,
          review: review ?? current,
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      return reply.send({
        application_id: row.id,
        review: completion.review,
        cover_letter: storedCoverLetter(row),
        retry_safety: await packetRetrySafety(completion.row),
      });
    },
  );

  /* THE WAY OUT OF AN APPLICATION LITOS CANNOT FINISH AND CANNOT ABANDON.
   *
   * The stranding, exactly. A form asks for an official transcript, she presses "I've ordered it",
   * and POST /applications/:id/documents/ordered writes `ordered_at` and nothing else - correctly,
   * because Litos cannot make a registrar mail a sealed copy. The dashboard's send gate reads
   * `attached_at`, so it stays closed; "Send it" is grey for the rest of that packet's life; and the
   * modal that put her there says "This application then finishes with you rather than with Litos"
   * while the screen it returns to has no control that finishes anything. The same dead end reaches
   * ready_for_final_approval from the other direction when `transcript_supported` is false: the
   * employer's form has no upload control Litos can fill, so no file she adds here changes the state.
   *
   * NO NEW STATE IS INVENTED. This lands on 'submitted' with a receipt whose source is
   * 'attended_handoff' and whose text names HER as the witness, which is exactly what
   * handoff-complete's 'submitted' arm and the unverified-submission route already write for the two
   * other cases where a person, not Litos, saw the application land. Litos does not manufacture a
   * confirmation it never saw, and the receipt says so in its own words.
   *
   * IT IS NOT A GENERAL "MARK ANYTHING SUBMITTED" DOOR, and the gate is what keeps it from becoming
   * one. It answers only for a packet parked at ready_for_final_approval that is held on a measured
   * document ask no upload can clear. An application she could still finish inside Litos has a
   * working control already and gets a 409 here, so this cannot become the quiet way past a send
   * gate that is doing its job.
   */
  fastify.post(
    '/applications/:id/submission/self-submitted',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = selfSubmittedBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Invalid self-submitted completion request',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const current = readApplicationReview(row.spec);
      if (!current || current.status !== 'ready_for_final_approval') {
        return reply.status(409).send({
          error: 'This application is not waiting for you to send it',
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (current.submission_claim_id !== parsed.data.attempt_id) {
        return reply.status(409).send({
          error: 'This manual submission attempt is no longer active.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const manualAttempt = await attendedManualAttemptBinding(row, parsed.data.attempt_id);
      if (!manualAttempt) {
        return reply.status(409).send({
          error: 'This manual submission was not durably reserved. Reload before continuing.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const unresolvable = documentAsksLitosCannotResolve(current, storedDocuments(row));
      if (unresolvable.length === 0) {
        return reply.status(409).send({
          error: 'Litos can still finish this one. Review the filled form and send it from here.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const now = new Date().toISOString();
      /* applyReviewPatch, not a spread, for the reason every other terminal write in this file gives:
         the shared merge is where withTerminalCause enforces that a terminal state carries a cause,
         and three production rows reached 'failed' with no stated reason when a route built its own
         review object. */
      const next = applyReviewPatch(current, {
        status: 'submitted',
        submitted_at: now,
        attention_reason: undefined,
        attention_categories: undefined,
        submission_error: undefined,
        receipt: {
          /* Named for what it is. The document the employer required is one Litos had no way to put
             on their form, so the application was completed by her; the receipt must not read as if
             Litos watched it land. */
          confirmation_text: 'Confirmed by you: this employer asked for a document Litos could not '
            + 'attach, so you sent this application yourself.',
          final_url: current.portal_url ?? '',
          captured_at: now,
          source: 'attended_handoff',
        },
      }, () => now);
      const submitted = await db.transaction(async (tx) => {
        await lockSubmissionAttemptUser(tx, request.jwtPayload!.userId);
        const rows = await tx.update(generated_resumes)
          .set({
            spec: reviewSpec(next),
            pipeline_stage: 'applied',
            pipeline_stage_at: new Date(now),
          })
          .where(and(
            eq(generated_resumes.id, row.id),
            eq(generated_resumes.user_id, request.jwtPayload!.userId),
            sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
            sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
            // Conditional on the status this answered for, so a send that started somewhere else in
            // the meantime is not overwritten by an answer about the screen before it.
            sql`${generated_resumes.spec}->'_review'->>'status' = 'ready_for_final_approval'`,
            sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${parsed.data.attempt_id}`,
          ))
          .returning();
        if (!rows.length) return rows;
        await recordAttendedSubmissionFact(manualAttempt, new Date(now), 'self-submitted', tx);
        return rows;
      });
      if (submitted.length === 0) {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        return reply.status(202).send({
          application_id: row.id,
          review: readApplicationReview(refreshed.spec) ?? current,
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      // She sent it herself; the canonical row must stop offering to send it for her.
      await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
      return reply.send({
        application_id: row.id,
        review: next,
        cover_letter: storedCoverLetter(row),
        // Carried so the screen this answers keeps the marks it was drawing. Built by the reader that
        // strips object_key, like every other envelope in this file.
        documents: storedDocuments(row),
        retry_safety: await packetRetrySafety(row),
      });
    },
  );

  fastify.post(
    '/applications/:id/submission/approve',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const stored = row.spec as StoredSpec;
      const current = readApplicationReview(stored);
      if (!current || current.status !== 'ready_for_final_approval') {
        return reply.status(409).send({
          error: 'Look over the filled form before you send it',
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (current.submission_claim_id) {
        return reply.status(409).send({
          error: 'A manual submission attempt is still unresolved. Finish or clear that exact attempt before asking Litos to send.',
          retry_safety: await packetRetrySafety(row),
        });
      }
      /* THE 55 MINUTE REFUSAL, now asked whether there is anything to refuse for.
       *
       * This line used to read the stamp alone. Cresta packet 8142004c-3358-4538-8778-16df5e31c5bb
       * was refused by it at 03:06 on 2026-08-09: a complete Greenhouse application, no screener
       * questions, filled 56 minutes earlier, and nothing in the submit path below would have
       * touched the fill run's leftovers because there were none. See preparedRunHandoffExpired for
       * what the stamp actually measures and what it was standing in for. The sentence is kept
       * verbatim, because when it fires now it is true.
       *
       * The restart door is POST /applications/:id/submit-request with restart:true, which has no
       * such check, so the sentence's advice is reachable rather than rhetorical. */
      if (preparedRunHandoffExpired(current)) {
        return reply.status(409).send({
          error: 'That took too long and timed out. Start the application again.',
          code: 'PREPARED_RUN_HANDOFF_EXPIRED',
          restartable: preparedRunCanRestart(current.status, Boolean(current.submission_claimed_at)),
          retry_safety: await packetRetrySafety(row),
        });
      }
      /* THE DUPLICATE GATE at the moment she presses send.
       *
       * submissionRunner.submit checks this too and would stop the click either way, but a 202
       * followed by a silent flip to needs_attention is not an answer to somebody who just pressed
       * a button. She asked a direct question and gets a direct refusal, with the same sentence the
       * Tracker will show. */
      const approvalDuplicate = await refuseDuplicateApplication(
        row,
        current,
        request.jwtPayload!.userId,
        fastify.log,
      );
      if (approvalDuplicate.kind !== 'clear') {
        return reply.status(409).send({
          ...duplicateRiskResponse(approvalDuplicate),
          retry_safety: await packetRetrySafety(row),
        });
      }
      const sensitiveProfile = await loadSensitiveQuestionProfile(request.jwtPayload!.userId);
      /* applicationContextForQuestionResolution(row, current), NOT current.jd_text bare.
       *
       * approvalReview.questions is what gets handed to currentAcknowledgedPacketAudit below as
       * the send gate's `questions` override, and by the time this route runs the form has already
       * been filled once by prepare() - through buildPacket/discoverAndResolveQuestions, both of
       * which resolve against this same richer context. Recomputing here on jd_text alone could
       * flip a resolver like the "Source" / "Application Referral" family back to its un-answerable
       * skipReason, producing a packet_version that disagrees with what was just filled and
       * acknowledged, with nothing the applicant did causing it. */
      const approvalReview: ApplicationReviewState = {
        ...current,
        questions: resolvePacketAuditQuestionFixpoint(
          current,
          sensitiveProfile,
          applicationContextForQuestionResolution(row, current),
          postingCountryFromJobContext(row.job_context),
          postingCountryCodeFromJobContext(row.job_context),
          new Date(),
        ),
      };
      const approvalIssues: string[] = [];
      if (approvalReview.portal_url && !isPortalSupported(approvalReview.portal_url)) {
        approvalIssues.push('Litos cannot fill in this company’s application page yet.');
      }
      if (!approvalReview.preview_screenshot_url?.trim()) {
        approvalIssues.push('The filled form preview is missing.');
      }
      if ((approvalReview.filled_fields ?? []).length === 0) {
        approvalIssues.push('No filled application fields were recorded.');
      }
      // THE COVER LETTER GATE. See finalApprovalCoverLetterIssue for why it reads
      // cover_letter_required and not cover_letter_supported, and why undefined never refuses.
      const coverLetterIssue = finalApprovalCoverLetterIssue(approvalReview, Boolean(storedCoverLetter(row)));
      if (coverLetterIssue) approvalIssues.push(coverLetterIssue);
      approvalReview.questions = normalizeApplicationReviewQuestions(approvalReview.questions);
      approvalIssues.push(...finalApprovalFieldIssues(approvalReview, approvalReview.cover_letter_attached === true));
      if (approvalReview.questions.some((question) => question.required && !question.answer.trim())) {
        approvalIssues.push('A required application answer is still blank.');
      }
      const sensitive = sensitiveQuestionFor(
        approvalReview.questions, sensitiveProfile, approvalReview.jd_text,
        postingCountryFromJobContext(row.job_context),
        postingCountryCodeFromJobContext(row.job_context),
      );
      if (sensitive) {
        approvalIssues.push(`Sensitive question requires your attention: ${sensitive.question.slice(0, 120)}`);
      }
      approvalIssues.push(...await preSendResumeVerificationIssues(
        request.jwtPayload!.userId,
        stored,
        applicationCompany(row),
      ));
      const approvalAudit = await currentAcknowledgedPacketAudit(row, {
        questions: approvalReview.questions,
        restoreExpiredResume: 'authorizing_send',
      });
      // The authored sentence, not the raw verdict token: these issues render on the dashboard.
      if (!approvalAudit.valid) approvalIssues.push(packetAuditClientError(approvalAudit).error);
      if (approvalIssues.length > 0) {
        return reply.status(422).send({
          error: 'Verify the complete application before sending. The current packet is not ready for final approval.',
          code: 'FINAL_APPROVAL_VERIFICATION_FAILED',
          issues: approvalIssues,
          retry_safety: await packetRetrySafety(row),
        });
      }
      const now = new Date().toISOString();
      const next = {
        ...approvalReview,
        status: 'submitting' as const,
        final_approved_at: now,
        submission_authorization: {
          source: 'per_application_approval' as const,
          authorized_at: now,
        },
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
        updated_at: now,
      };
      const approved = await db.update(generated_resumes)
        .set({ spec: approvedReviewSpec(next, now) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
          sql`${generated_resumes.spec}->'_review'->>'status' = 'ready_for_final_approval'`,
        ))
        .returning({ id: generated_resumes.id });
      if (approved.length === 0) {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({
          application_id: row.id,
          review: review ?? current,
          retry_safety: await packetRetrySafety(refreshed),
        });
      }
      const processed = await processSubmissionApplication(row.id, fastify);
      const [refreshed] = await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, request.jwtPayload!.userId),
      )).limit(1);
      const responseRow = refreshed ?? row;
      return reply.status(202).send({
        application_id: row.id,
        review: readApplicationReview(responseRow.spec) ?? processed ?? next,
        cover_letter: storedCoverLetter(responseRow),
        retry_safety: await packetRetrySafety(responseRow),
      });
    },
  );

  registerWorkdayVerificationRoute(fastify, {
    requireAuth,
    ownedApplication: ownedResume,
    resolveActiveAlias: resolveFrozenApplicantEmail,
    findCode: findComposioVerificationCode,
  });

  /* The only door into an application the employer is holding behind an emailed security code.
   *
   * Everything else refuses that state: submitRequestDisposition returns 'reject' for it, so the
   * ordinary submit-request path, the cron queue and the resume-edit path all decline to touch a
   * packet that has already been sent to an employer once. This route exists because supplying the
   * code is the one action that can legitimately move it, and because the applicant supplying a code
   * out of her own mailbox IS the approval - the same per-application authorization the approve
   * route writes, from the same person, about the same application.
   *
   * IDEMPOTENT BY THE CODE, not by a request id. finishSecurityCodeSubmission fingerprints the code
   * against the application and answers a repeat from the stored attempt without making a run, so a
   * double-click, a retried request or a refreshed tab cannot put a second application in front of
   * an employer. That matters beyond tidiness: some boards cap re-applications, and Deepgram's form
   * says candidates may not apply more than twice in any 60-day span. */
  fastify.post(
    '/applications/:id/security-code',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const securityCodeReview = readApplicationReview(row.spec);
      if (!securityCodeReview) return reply.status(409).send({
        error: 'Application review is not available for this resume',
        retry_safety: await packetRetrySafety(row),
      });
      const securityCodeAudit = await currentAcknowledgedPacketAudit(row, {
        questions: await resolvedPacketAuditQuestions(row, securityCodeReview),
        restoreExpiredResume: 'authorizing_send',
      });
      if (!securityCodeAudit.valid) {
        // The applicant sentence, not the verdict token. This is the exact reply that printed the
        // bare "packet_stale" on the Jane Street code step before the tokens were translated.
        return reply.status(409).send({
          ...packetAuditClientError(securityCodeAudit),
          retry_safety: await packetRetrySafety(row),
        });
      }
      const body = request.body as { code?: unknown } | undefined;
      const outcome = await finishSecurityCodeSubmission(row.id, body?.code, fastify);
      if (outcome.kind === 'not_found') {
        return reply.status(404).send({
          error: 'That application is not available',
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (outcome.kind === 'not_awaiting') {
        // 409 and not 400: nothing is wrong with the request, the packet has simply moved on. The
        // status travels back so the dashboard can re-render rather than guess.
        return reply.status(409).send({
          error: 'This application is not waiting on a security code',
          status: outcome.status,
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (outcome.kind === 'invalid_code') {
        return reply.status(400).send({
          error: 'That does not look like the code from the email. Enter the characters exactly as they appear.',
          code: 'INVALID_SECURITY_CODE',
          retry_safety: await packetRetrySafety(row),
        });
      }
      if (outcome.kind === 'already_attempted') {
        // NOT an error, and deliberately not a re-run. Litos already tried this exact code and it
        // says what happened, which is the whole point of remembering the fingerprint.
        return reply.status(200).send({
          application_id: row.id,
          already_attempted: true,
          outcome: outcome.outcome,
          review: outcome.review,
          retry_safety: await packetRetrySafety(row),
        });
      }
      return reply.status(200).send({
        application_id: row.id,
        review: outcome.review,
        retry_safety: await packetRetrySafety(row),
      });
    },
  );

  fastify.post(
    '/applications/:id/status',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = statusBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({
        error: 'Invalid submission status',
        retry_safety: await packetRetrySafety(row),
      });
      const stored = row.spec as StoredSpec;
      const current = readApplicationReview(stored);
      if (!current) return reply.status(409).send({
        error: 'Application review is not available for this resume',
        retry_safety: await packetRetrySafety(row),
      });
      /* THE CLAIM IS PART OF THE QUESTION HERE TOO, and this route is where a missing second
       * argument bought a second application at an employer.
       *
       * The one-argument call evaluated a CLAIMED needs_attention row as though it were unclaimed,
       * hit the `!submissionWasClaimed` arm and answered 'start'. The write below is a `...current`
       * spread, so the claim, the receipt, the security_code and an unresolved unverified_submission
       * all survived it, and the destination status 'failed' is one submitRequestDisposition starts
       * UNCONDITIONALLY. Two requests - this one, then POST /submit-request - and a packet the
       * employer may already be holding was runnable again.
       *
       * THE GUARD IS THE WHOLE BOUNDARY, and the spread is deliberately left alone. With the claim
       * counted, every source status this route still accepts is one whose disposition is already
       * 'start', and the destination is 'start', so the route is disposition-PRESERVING: it can no
       * longer manufacture re-runnability out of a state that did not have it. Stripping the
       * receipt, the security_code or the unverified_submission record would not close a gate - it
       * would delete the evidence the gates READ. submissionProvablyNotSent, duplicateApplicationVerdict
       * and POST /submission/unverified all decide from exactly those three fields whether an
       * application ever reached an employer, and a "the company turned this down" update is not a
       * reason to forget that it did. A hole in a gate is fixed by fixing the gate. */
      if (submitRequestDisposition(current.status, Boolean(current.submission_claimed_at)) !== 'start') {
        return reply.status(409).send({
          error: 'An active or completed submission cannot be replaced by a delayed failure update',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const now = new Date().toISOString();
      const next = {
        ...current,
        status: parsed.data.status,
        updated_at: now,
        submission_error: parsed.data.error ?? 'The company turned this application down.',
      };
      const updated = await db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
        ))
        .returning();
      if (updated.length === 0) {
        return reply.status(409).send({
          error: 'The application state changed before the failure update was recorded',
          retry_safety: await packetRetrySafety(row),
        });
      }
      return reply.send({
        application_id: row.id,
        review: next,
        retry_safety: await packetRetrySafety(updated[0]),
      });
    },
  );

  /* THE WAY OUT OF "LITOS DOES NOT KNOW".
   *
   * Skydio packet 13bccb2d, 2026-08-09: a submit that was cut off mid-flight, submitted_at null,
   * receipt null, and a status the submit route refuses to re-run. The applicant was told to check
   * the portal and try again; trying again was refused; building a fresh application for the same
   * posting would have been refused by the duplicate guard if the first one HAD landed. Three walls
   * and no door.
   *
   * This is the door, and the only thing it accepts is what she SAW. Litos never decides this for
   * her: an application that may already be with an employer is not a thing to guess about, and both
   * wrong guesses are expensive - a false "sent" loses her the application silently, a false "not
   * sent" spends one of her attempts at an employer who caps them.
   *
   *   found true  -> recorded as submitted, with the receipt source naming her as the witness. Litos
   *                  does not manufacture a confirmation it never saw.
   *   found false -> the claim is released and the packet becomes re-runnable exactly once through
   *                  the ordinary route. Nothing is sent by this call itself.
   */
  fastify.post(
    '/applications/:id/submission/unverified',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = unverifiedOutcomeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: 'Say whether you found the application, with found true or false',
          retry_safety: await packetRetrySafety(row),
        });
      }
      const current = readApplicationReview(row.spec as StoredSpec);
      if (!current) return reply.status(409).send({
        error: 'Application review is not available for this resume',
        retry_safety: await packetRetrySafety(row),
      });
      const retrySafety = await packetRetrySafety(row);
      const attemptEvents = await submissionAttemptEventsForPacket(row.user_id, row.id);
      const requestedOpening = attemptEvents.find((event) => event.attempt_id === parsed.data.attempt_id
        && event.event_kind === 'attempt_opened');
      const requestedPress = attemptEvents.find((event) => event.attempt_id === parsed.data.attempt_id
        && event.event_kind === 'press_observed');
      const resolutionAttemptId = legacyApplicationAttemptId(row, current);
      const exactLegacyBackfillAttempt = requestedOpening?.source === 'legacy_backfill';
      const mutablePending = current.unverified_submission;
      const mutableResolutionReplaysRequestedAttempt = Boolean(mutablePending)
        && resolvedUnverifiedAttemptReplayMatches(
          mutablePending!,
          parsed.data.attempt_id,
          attemptEvents,
        );
      const mutablePendingMatchesRequestedAttempt = Boolean(mutablePending)
        && (resolutionAttemptId === parsed.data.attempt_id
          || mutableResolutionReplaysRequestedAttempt);
      /* A process can die after the immutable opening or press but before the mutable projection.
         The ledger is authoritative in that gap, so reconstruct the minimum resolvable projection
         for this exact attempt instead of leaving a claimed packet with no resolution door. A
         resolved mutable record from another historical attempt must not hide a separate migration
         opening, or that conservative cutover hold would have no applicant-controlled exit. */
      const pending: NonNullable<ApplicationReviewState['unverified_submission']> | undefined
        = mutablePendingMatchesRequestedAttempt
          ? mutablePending
          : ledgerBlockedUnverifiedProjection(
            current,
            retrySafety,
            parsed.data.attempt_id,
            requestedOpening,
          );
      if (!pending) {
        return reply.status(409).send({
          error: 'This application is not waiting on an unverified submission',
          status: current.status,
          retry_safety: retrySafety,
        });
      }
      /* A migration-created legacy attempt deliberately has its own stable identity. It may not
         equal the mutable claim id left in the old review snapshot, so accept it only when the
         packet fold says that exact immutable legacy opening is the unresolved attempt. Runtime
         openings keep the stricter claim-id equality check. */
      const exactRuntimeAttempt = Boolean(requestedOpening)
        && requestedOpening?.source !== 'legacy_backfill'
        && resolutionAttemptId === parsed.data.attempt_id;
      const transitionalLegacyAttempt = !requestedOpening
        && resolutionAttemptId === parsed.data.attempt_id;
      const exactResolvedReplay = Boolean(requestedOpening)
        && mutableResolutionReplaysRequestedAttempt;
      const isCurrentBlockedAttempt = retrySafety.kind === 'blocked_unverified'
        && retrySafety.attemptId === parsed.data.attempt_id;
      const exactAttemptIdentity = exactLegacyBackfillAttempt
        || exactRuntimeAttempt
        || transitionalLegacyAttempt
        || exactResolvedReplay;
      if (!exactAttemptIdentity || (!pending.resolution && !isCurrentBlockedAttempt)) {
        return reply.status(409).send({
          error: 'That answer belongs to a different submission attempt. Reload this application first.',
          retry_safety: retrySafety,
        });
      }
      if (pending.resolution) {
        if (!parsed.data.found
          && exactAttemptPermanentlyBlocksNegativeResolution(attemptEvents, parsed.data.attempt_id)) {
          return reply.status(409).send({
            error: 'This application crossed an employer submission boundary and cannot be marked not sent.',
            retry_safety: retrySafety,
          });
        }
        const promotesNotSentToConfirmed = parsed.data.found && pending.resolution === 'not_sent';
        if (!promotesNotSentToConfirmed) {
          // Idempotent rather than an error. The same answer twice is a retry, not a mistake, and a
          // retry of a resolved 'sent' is also the heal path for a canonical advance that failed the
          // first time.
          if (current.status === 'submitted') {
            await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
          }
          return reply.status(200).send({
            application_id: row.id,
            already_resolved: true,
            review: current,
            retry_safety: await packetRetrySafety(row),
          });
        }
      }
      const now = new Date().toISOString();
      const resolved = { ...pending, resolution: parsed.data.found ? 'sent' as const : 'not_sent' as const, resolved_at: now };
      /* applyReviewPatch, not a spread. Both arms land on a terminal or attention state, and the
         shared merge is where withTerminalCause enforces that such a state always carries a cause -
         a rule that exists because three production rows reached 'failed' with attention_reason
         unset when a route built its own review object. */
      const next: ApplicationReviewState = parsed.data.found
        ? applyReviewPatch(current, {
          status: 'submitted',
          submitted_at: pending.at,
          submission_error: undefined,
          attention_reason: undefined,
          attention_categories: undefined,
          unverified_submission: resolved,
          receipt: {
            /* NAMED FOR WHAT IT IS. Litos did not see this confirmation and must never write a
               sentence implying it did; the applicant did, and the receipt says so. */
            confirmation_text: requestedPress
              ? 'Confirmed by you: you found this application in the employer\u2019s portal after Litos pressed Send and lost the answer.'
              : 'Confirmed by you: you found this application in the employer\u2019s portal after its submission attempt stopped without a durable result.',
            final_url: pending.portal_url ?? current.portal_url ?? '',
            captured_at: now,
            source: 'attended_handoff',
          },
        }, () => now)
        : applyReviewPatch(current, {
          status: 'needs_attention',
          unverified_submission: resolved,
          // Released, because she has looked and the employer does not have it. This is the single
          // fact that makes another run safe, and it is the only thing that releases the claim.
          submission_claimed_at: undefined,
          submission_claim_id: undefined,
          attention_reason: 'You checked and the employer does not have this one, so nothing was sent. '
            + 'Litos can send it again whenever you are ready.',
          attention_categories: ['unverified_submission'],
        }, () => now);
      const updated = await commitUnverifiedSubmissionResolution({
        row,
        userId: request.jwtPayload!.userId,
        attemptId: parsed.data.attempt_id,
        found: parsed.data.found,
        replaceResolvedMutableProjection: Boolean(
          (exactLegacyBackfillAttempt
            && mutablePending?.resolution
            && !mutablePendingMatchesRequestedAttempt)
          || (parsed.data.found && pending.resolution === 'not_sent')
        ),
        current,
        pending,
        next,
        now,
      });
      if (updated.length === 0) {
        return reply.status(409).send({
          error: 'This application was resolved somewhere else first',
          retry_safety: await packetRetrySafety(row),
        });
      }
      // Only the arm that landed on 'submitted' filed anything; the released claim changes nothing
      // canonical. Gated on the persisted status, the same predicate the runner's writeReview uses.
      if (next.status === 'submitted') {
        await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
      }
      return reply.status(200).send({
        application_id: row.id,
        review: next,
        retry_safety: await packetRetrySafety(updated[0]),
      });
    },
  );
}
