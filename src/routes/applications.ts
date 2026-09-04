import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { deleteObjects, objectStorageUsesRailway, putObject } from '../lib/objectStorage';
import { packetIsUntailoredMainResume } from '../lib/managedPrepare';
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
import { monitoredPortalProofUnavailable } from '../lib/applicationPortalRepair';
import { postingStatusBlocksSend } from '../lib/applicationPortalRepair';
import { derivePostingDeadlineStatus } from '../lib/postingDeadline';
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
import { applicationContextForQuestionResolution, knownAnswerLookup, reviewQuestionRequiresAttention, type ApplicationProfileLike } from '../lib/questionDiscovery';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import { rememberReusableAnswers } from '../lib/savedAnswerStore';
import { machineAnswerLookup, resolveSubmittedApplicationAnswers } from '../lib/submittedAnswers';
import {
  blankRequiredQuestionLabels,
  preparedRunCanRestart,
  preparedRunHandoffExpired,
  resumeContactRefreshDisposition,
  resumeEditDisposition,
  reviewAnswerSaveDisposition,
  submissionQuestionGate,
  submitRequestDisposition,
} from '../lib/submissionSafety';
import {
  attemptNeverReachedEmployerIsReleasable,
  expiredAttendedHandoffClaimIsReleasable,
  releaseAttemptThatNeverReachedEmployer,
  releaseExpiredAttendedHandoffClaim,
} from '../lib/expiredHandoffClaimRelease';
import {
  releaseStalledFillRun,
  stalledFillRunReleaseIsAdmissible,
} from '../lib/stalledFillRunRelease';
import { attemptNeverPressedReason, employerMayHoldApplication } from '../lib/managedSubmitOutcome';
import {
  healAbandonedPreBoundaryAttemptsForRead,
  retrySafetyDiagnosticForAbsentEnvelope,
  retrySafetyLooksLikeClosableCandidate,
} from '../lib/abandonedAttemptClosure';
import { submissionClaimPatch } from '../lib/submissionStop';
import {
  advanceCanonicalApplicationFromPacketSubmission,
  syncCanonicalApplicationRow,
} from '../lib/canonicalApplicationSync';
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
  extensionOutcomePatch,
  isSafeExtensionReceiptUrl,
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
import { getEntitlementSnapshot } from '../lib/entitlements';
import { AUTOMATIC_SUBMISSION_CONSENT_VERSION } from '../lib/automationConsent';
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
import { LEGACY_MUTABLE_CONTACT_FIELDS, refreshResumeContactFromProfile, resumeContactStaleness } from '../lib/resumeContactOfRecord';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { reconcileCanonicalCoverLetterForPacket } from '../lib/canonicalCoverLetterService';
import { planPacketJdRepair, repairPacketJd } from '../lib/packetJdRepair';
import { canonicalApplicationForNewPacketAttempt } from '../lib/canonicalPacketBinding';
import {
  appendSubmissionAttemptEvent,
  ATTEMPT_NEVER_REACHED_EMPLOYER_EVIDENCE,
  attemptNeverReachedEmployer,
  authorizeFinalSubmissionBoundary,
  freezePostingIdentity,
  lockSubmissionAttemptUser,
  submissionBoundaryAuthorization,
  submissionAttemptBindingFromEvent,
  submissionAttemptEventId,
  submissionAttemptEventsForPacket,
  submissionAttemptsOpenedToday,
  submissionAttemptRetrySafety,
  submissionAttemptRetrySafetyForPacketEvents,
  tryLockSubmissionAttemptUser,
  type SubmissionAttemptBinding,
  type SubmissionAttemptEventRecord,
} from '../lib/submissionAttemptLedger';
import {
  unsupportedEmailConfirmationEvidenceCode,
  unsupportedEmailConfirmationText,
} from '../lib/unsupportedEmailReceipt';
import {
  applicantFoundSubmissionReceiptText,
  authoritativeConfirmedProjectionMatches,
  authoritativeSubmissionProjection,
  measuredPersistedReceiptMatchesOpening,
  selfSubmittedSubmissionReceiptText,
} from '../lib/authoritativeSubmissionProjection';
import { submissionAuthorityEnvelopeForUnattemptedPacket } from './resume';
import { submissionAuthorityPublicationForPacket } from '../lib/submissionAuthorityEnvelope';
import { conditionalWriteRows, isAuthorityRevisionConflictError, withAuthorityRevisionRetry } from '../db/authorityRevisionRetry';

const paramsSchema = z.object({ id: z.string().uuid() });
const extensionPacketQuerySchema = z.object({ current_url: z.string().url().max(4000) });

/**
 * The public submission-authority envelope a submission-state response from this file must carry
 * before the dashboard will authorise a first employer send.
 *
 * The dashboard installs these responses as its live submission state and re-derives the send gate
 * from `response.submission_authority` alone, with the same fail-closed contract it applies to a
 * `/resume/history` packet: an absent or unparsable envelope is quarantined, and every send then
 * refuses with "the exact prior submission evidence is verified" - including for a packet that has
 * never opened one attempt. `/resume/history` already attaches this envelope for genuinely
 * un-attempted packets, but a response from this file overwrites that state WITHOUT one, so
 * selecting an application re-quarantined the very packet the history route had just freed.
 * Observed live 2026-09-01 on a fresh never-attempted packet: GET
 * /applications/:id/submission installed, then the review screen's fill refused.
 *
 * Same rules as the history route's envelope, via the same helper: attached ONLY when the
 * authoritative projection is `none` with `no_evidence` retry safety, which hold together exactly
 * when the packet has no attempt-opened event. A packet with ANY attempt history gets nothing here
 * and stays as fail-closed as before, and a projection read failure also attaches nothing - the
 * gate then blocks, which is exactly today's behaviour, never an unauthorised send.
 */
/**
 * The only review statuses from which the dashboard can offer a FIRST employer send, i.e. the only
 * states where this envelope changes anything. Every other status either has an attempt open or is
 * actively opening one, so the projection could never be `none` and the helper would pay a
 * projection transaction (and its per-user `pg_advisory_xact_lock`) on every poll of a live fill
 * only to attach nothing. Skipping there is behaviour-identical and keeps the polling hot path off
 * the submission-attempt lock.
 *
 * `ready_for_final_approval` BELONGS HERE. A managed prepare parks at that status through
 * `claimPreparation`, which writes no ledger event; `attempt_opened` is only written by
 * `claimSubmission` when the applicant approves the filled form. So a filled, never-sent packet
 * projects `none` with `no_evidence`, exactly the shape the helper turns into an envelope, and the
 * dashboard offers `/submission/approve` from this status and nowhere else. Without the envelope
 * the dashboard's fail-closed display rule rewrote a server `ready_for_final_approval` review into
 * `needs_attention`: no "Send application" control, the "Review the application packet before
 * Litos fills the company form again" card instead, and the only offered action a NEW submit-request
 * the server then refuses with PREPARED_RUN_RESTARTABLE. Observed live 2026-09-02 on The Maven
 * Group (crelate) packet, the first packet of the campaign to reach the send step.
 */
const FIRST_SEND_REVIEW_STATUSES = new Set([
  'resume_ready',
  'questions_ready',
  'ready_to_submit',
  'ready_for_final_approval',
  'needs_attention',
  'failed',
]);

async function unattemptedPacketSubmissionAuthority(
  userId: string,
  packetId: string,
  reviewStatus: string,
  log: FastifyRequest['log'],
): Promise<{
  submission_authority?: ReturnType<typeof submissionAuthorityEnvelopeForUnattemptedPacket>;
  /* WHY THE GATE STILL REFUSES, so the next person can see it on the wire instead of measuring it
   * by hand - see healAbandonedPreBoundaryAttemptsForRead's doc (lib/abandonedAttemptClosure.ts)
   * for the Pony.ai measurement this answers. `no_projection` names the projection read itself
   * failing (the catch block below); the other two are retrySafetyDiagnosticForAbsentEnvelope's. */
  retry_safety_diagnostic?: 'no_projection' | 'blocked_by_attempt' | 'unclosable_attempt';
}> {
  if (!FIRST_SEND_REVIEW_STATUSES.has(reviewStatus)) return {};
  try {
    let projections = await authoritativeSubmissionProjection({ userId, packetIds: [packetId] });
    let projection = projections.byPacketId.get(packetId);
    let retrySafety = projections.retrySafetyByPacketId.get(packetId);
    let envelope = submissionAuthorityEnvelopeForUnattemptedPacket({
      packetId,
      projectionState: projection?.state,
      retrySafety,
      revision: projections.revision,
    });
    /* A READ CAN HEAL WHAT A SEND ALREADY WOULD. Full mechanism and safety argument on
     * healAbandonedPreBoundaryAttemptsForRead's doc (lib/abandonedAttemptClosure.ts). Tried only
     * when the cheap path just above found nothing to publish AND the retry verdict is the one
     * shape a heal could ever change, so every packet with an envelope already and every packet
     * blocked for a real reason - pressed, boundary_authorized, confirmed - costs this hot 2.5s
     * poll nothing beyond what it already paid above.
     *
     * SCOPED TO THIS ONE PACKET - REVIEW ROUND 1, 2026-09-05. This route answers for exactly one
     * packet, so `packetIds: [packetId]` is the whole of what this read could ever need healed;
     * see healAbandonedPreBoundaryAttemptsForRead's own doc for why an unscoped heal here could
     * stall a concurrent send on this account's whole backlog instead. */
    let closedAttemptIds: readonly string[] = [];
    if (!envelope && retrySafetyLooksLikeClosableCandidate(retrySafety)) {
      const blockingAttemptId = retrySafety.attemptId;
      closedAttemptIds = (await healAbandonedPreBoundaryAttemptsForRead({
        userId,
        log,
        logContext: { packetId, route: 'GET /applications/:id/submission' },
        packetIds: [packetId],
        trigger: 'read_heal',
      })).closedAttemptIds;
      if (closedAttemptIds.includes(blockingAttemptId)) {
        projections = await authoritativeSubmissionProjection({ userId, packetIds: [packetId] });
        projection = projections.byPacketId.get(packetId);
        retrySafety = projections.retrySafetyByPacketId.get(packetId);
        envelope = submissionAuthorityEnvelopeForUnattemptedPacket({
          packetId,
          projectionState: projection?.state,
          retrySafety,
          revision: projections.revision,
        });
      }
    }
    if (envelope) return { submission_authority: envelope };
    /* THE SCREEN THAT SHOWS THE BANNER LOGGED NOTHING. This helper returned a bare `{}` on every
     * refusal, so the one surface a student actually reads - "Litos cannot start another employer
     * attempt until the exact prior submission evidence is verified", on the packet review screen -
     * left no server-side trace of WHY, while the board next door logged a reason per card. On
     * 2026-09-03 that banner stood on 163 of this account's 200 packets and nothing on any wire
     * said which check refused them.
     *
     * DIAGNOSIS ONLY, PUBLICATION UNCHANGED. What this response carries is still exactly the
     * unattempted builder's envelope: `none` projection, `no_evidence` or a well-shaped
     * `safe_not_sent`, and nothing else. submissionAuthorityPublicationForPacket classifies every
     * projection state, so it is read here purely for its refusal - a packet with real history
     * publishes there and refuses here, which is correct on both surfaces and is why only its
     * `published: false` is logged. Calling it cannot change the bytes above; it is pure over data
     * already in hand and its return value is never returned to the caller. It adds no read beyond
     * whatever the heal above already paid for: this classifies the LATEST projection, re-read
     * after a heal attempt when one ran.
     *
     * THE VOLUME IS DELIBERATE AND SELF-LIMITING. The dashboard polls this route every 2.5s for the
     * ONE packet a student has open, so a blocked packet writes a line every 2.5s for as long as
     * she is looking at the banner, and none once she navigates away. That is the ratio worth
     * having while a refusal is unexplained: the signal appears exactly when somebody is stuck on
     * it. If it ever needs damping, drop the state-only reasons and keep the ones carrying a
     * `rejected` - those are the refusals nothing else in the system can name. */
    const publication = submissionAuthorityPublicationForPacket({
      packetId,
      projection,
      retrySafety,
      revision: projections.revision,
    });
    if (!publication.published) {
      log.warn(
        {
          packetId,
          reason: publication.reason,
          projectionState: projection?.state,
          retrySafetyKind: retrySafety?.kind,
          rejectedBranch: publication.rejected?.branch,
          rejectedField: publication.rejected?.field,
          rejectedShape: publication.rejected?.shape,
        },
        'packet has no publishable submission authority envelope; the send gate stays fail-closed',
      );
    }
    return {
      retry_safety_diagnostic: retrySafetyDiagnosticForAbsentEnvelope({ retrySafety, closedAttemptIds }),
    };
  } catch (error) {
    log.warn(
      { err: error, packetId },
      'submission authority projection unavailable for submission response; packet stays fail-closed at the send gate',
    );
    return { retry_safety_diagnostic: 'no_projection' };
  }
}
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
  answer_state: z.enum(['unanswered', 'skipped', 'litos_refused']).optional(),
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

type StoredResumeRow = typeof generated_resumes.$inferSelect;

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
});
export const extensionStartBodySchema = z.object({
  authorization: z.enum(['standing_consent', 'user_initiated']),
  activation_contract: z.literal('server-lease-v1'),
  handoff_version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  current_url: z.string().url().max(4000).optional(),
});
const extensionReceiptUrlSchema = z.string().url().max(4000).refine(isSafeExtensionReceiptUrl, 'Confirmation URL must use HTTPS');
export const extensionOutcomeBodySchema = z.object({
  activation_contract: z.literal('server-lease-v1'),
  activation_id: z.string().uuid(),
  activation_lease_id: z.string().uuid(),
  activation_expires_at: z.string().datetime({ offset: true }),
  claim_id: z.string().uuid(),
  outcome: z.enum(['confirmed', 'failed', 'unknown', 'cancelled']),
  confirmation_text: z.string().max(2000).optional(),
  final_url: extensionReceiptUrlSchema,
});
const handoffCompleteBodySchema = z.object({
  outcome: z.enum(['cleared', 'submitted']).default('cleared'),
  confirmation_text: z.string().max(2000).optional(),
  final_url: extensionReceiptUrlSchema.optional(),
}).default({ outcome: 'cleared' });

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

/** Stored employer handoff locations stay server-side until the action-time POST authorizes them. */
export function reviewWithoutPassiveHandoffUrl(review: ApplicationReviewState): ApplicationReviewState {
  const {
    extension_handoff_url: _extensionHandoffUrl,
    extension_handoff_binding: _extensionHandoffBinding,
    ...safe
  } = review;
  return safe;
}

export function manualHandoffAvailable(review: ApplicationReviewState): boolean {
  return Boolean(review.extension_handoff_url
    || ((review.status === 'filling' || review.status === 'needs_attention')
      && review.browser_session_id));
}

const ALTERNATE_SUBMISSION_SOURCES = new Set([
  'chrome_extension',
  'attended_handoff',
  'unsupported_email',
]);

/** An expired employer capability remains possible delivery, so ask once and never resend it. */
export function expiredAlternateSubmissionReview(
  review: ApplicationReviewState,
  events: readonly SubmissionAttemptEventRecord[],
  now: Date = new Date(),
): ApplicationReviewState | null {
  const claimId = review.submission_claim_id;
  if (!claimId || review.status === 'submitted' || review.submitted_at || review.receipt) return null;
  const exact = events.filter((event) => event.attempt_id === claimId);
  const opening = exact.find((event) => event.event_kind === 'attempt_opened');
  if (!opening
    || !ALTERNATE_SUBMISSION_SOURCES.has(opening.source)) return null;
  const safety = submissionAttemptRetrySafety(exact);
  const boundaries = exact.filter((event) => event.event_kind === 'boundary_authorized');
  const boundaryExpiry = boundaries.length === 1 ? boundaries[0]!.boundary_expires_at : null;
  if (safety.kind !== 'blocked_unverified'
    || (safety.reason !== 'boundary_authorized' && safety.reason !== 'pressed')
    || !boundaryExpiry
    || boundaryExpiry.getTime() > now.getTime()) return null;
  const nowIso = now.toISOString();
  return applyReviewPatch(review, {
    status: 'needs_attention',
    submission_error: undefined,
    attention_reason: 'Did this application reach the employer? Choose Yes or No before Litos does anything else.',
    attention_categories: ['unverified_submission'],
    unverified_submission: {
      at: safety.at,
      cause: 'no_confirmation_state',
      ...(review.portal_url ? { portal_url: review.portal_url } : {}),
      ...(review.submission_run_id ? { submission_run_id: review.submission_run_id } : {}),
    },
  }, () => nowIso);
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
/* The cheapest possible "could either repair branch move this row" question, asked of the row a
 * route has ALREADY read, before the helper opens a transaction or touches a lock at all.
 *
 * Both branches need a claim: expiredAlternateSubmissionReview returns null without
 * submission_claim_id, and expiredAttendedHandoffClaimIsReleasable returns null without
 * submission_claimed_at. Both refuse a submitted row and a row carrying a receipt - the alternate
 * branch explicitly, the release branch through employerMayHoldApplication. So a row failing this
 * predicate cannot be repaired by either branch, and skipping it changes no outcome.
 *
 * GET /applications/:id/submission runs the helper on every 2.5s dashboard poll, so for the vast
 * majority of rows this turns a transaction plus an advisory lock into a field read. */
export function expiredHandoffClaimRepairIsPossible(
  review: Pick<
    ApplicationReviewState,
    'status' | 'submission_claim_id' | 'submission_claimed_at' | 'submitted_at' | 'receipt'
  > | null,
): boolean {
  if (!review) return false;
  if (!review.submission_claim_id && !review.submission_claimed_at) return false;
  if (review.status === 'submitted' || review.submitted_at || review.receipt) return false;
  return true;
}

async function repairExpiredAttendedHandoffClaim(
  row: NonNullable<Awaited<ReturnType<typeof ownedResume>>>,
  userId: string,
  log: FastifyRequest['log'],
): Promise<NonNullable<Awaited<ReturnType<typeof ownedResume>>> | null> {
  if (!expiredHandoffClaimRepairIsPossible(readApplicationReview(row.spec))) return null;
  const result = await db.transaction(async (tx) => {
    /* TRY, NEVER WAIT. This helper is documented best-effort: "null on any miss, and the caller
     * proceeds with the stored row, whose gates then refuse exactly as they did before". A lost
     * race for the lock is exactly such a miss, and it costs one more request. Waiting for it is
     * what let a 280s managed provider call hold this route open on every dashboard poll, pinning
     * a pool client until the whole API queued under its 10s checkout ceiling. */
    if (!await tryLockSubmissionAttemptUser(tx, userId)) return null;
    const [locked] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, userId),
    )).limit(1).for('update');
    const current = locked ? readApplicationReview(locked.spec) : null;
    if (!locked || !current) return null;
    const clockResult = await tx.execute(sql`select clock_timestamp() as now`);
    const clockValue = (clockResult.rows[0] as { now?: Date | string } | undefined)?.now;
    const databaseNow = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
    if (Number.isNaN(databaseNow.getTime())) throw new Error('Database reconciliation clock was unavailable');
    const events = await submissionAttemptEventsForPacket(userId, locked.id, { executor: tx });
    const reconciled = expiredAlternateSubmissionReview(current, events, databaseNow);
    if (reconciled) {
      const [updated] = await tx.update(generated_resumes)
        .set({ spec: reviewSpec(reconciled) })
        .where(and(
          eq(generated_resumes.id, locked.id),
          eq(generated_resumes.user_id, userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
        ))
        .returning({ id: generated_resumes.id });
      if (!updated) return null;
      return { row: locked, review: reconciled, disposition: 'unverified' as const };
    }

    const claimEvents = current.submission_claim_id
      ? events.filter((event) => event.attempt_id === current.submission_claim_id)
      : [];
    /* THE ATTEMPT THAT NEVER REACHED THE EMPLOYER, released and closed in one transaction.
     *
     * Ordered after expiredAlternateSubmissionReview, which reconciles an expired capability whose
     * boundary WAS authorized, and before the legacy empty-ledger arm below. This arm is the exact
     * middle case those two leave out: a durable attempt exists and it never crossed the boundary.
     *
     * BOTH WRITES OR NEITHER. The row release and the ledger's not_sent_proven are one atomic write
     * under the user advisory lock already held above. A row released without the fact would still
     * be refused by duplicateApplicationVerdict, which reads the ledger and not the row; a fact
     * written without the release would leave the packet locked. See
     * attemptNeverReachedEmployerIsReleasable for what this refuses. */
    if (claimEvents.length > 0
      && attemptNeverReachedEmployer(claimEvents)
      && attemptNeverReachedEmployerIsReleasable(current)) {
      const opening = claimEvents.find((event) => event.event_kind === 'attempt_opened')!;
      const released = releaseAttemptThatNeverReachedEmployer(
        current,
        attemptNeverPressedReason(),
        databaseNow.toISOString(),
      );
      const [updated] = await tx.update(generated_resumes)
        .set({ spec: reviewSpec(released) })
        .where(and(
          eq(generated_resumes.id, locked.id),
          eq(generated_resumes.user_id, userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
        ))
        .returning({ id: generated_resumes.id });
      if (!updated) return null;
      await appendSubmissionAttemptEvent({
        ...submissionAttemptBindingFromEvent(opening),
        eventId: submissionAttemptEventId(opening.attempt_id, 'not_sent_proven', 'never-reached-employer'),
        eventKind: 'not_sent_proven',
        proofKind: 'typed_pre_click_stop',
        evidenceCode: ATTEMPT_NEVER_REACHED_EMPLOYER_EVIDENCE,
      }, { executor: tx });
      return { row: locked, review: released, disposition: 'never_reached' as const };
    }
    /* Legacy handoffs can predate the immutable attempt ledger. Only that empty-ledger case may
     * use the old pre-click release rule, and its canonical observation check runs under the same
     * user lock as the row write. */
    if (claimEvents.length > 0
      || !expiredAttendedHandoffClaimIsReleasable(current, databaseNow.getTime())) return null;
    const [canonicalEvent] = await tx.select({ id: application_submission_events.id })
      .from(application_submission_events)
      .innerJoin(applications, eq(application_submission_events.application_id, applications.id))
      .where(and(
        eq(application_submission_events.user_id, userId),
        eq(applications.user_id, userId),
        eq(applications.legacy_generated_resume_id, locked.id),
      ))
      .limit(1);
    if (canonicalEvent) return null;
    const released = releaseExpiredAttendedHandoffClaim(current, databaseNow.toISOString());
    const [updated] = await tx.update(generated_resumes)
      .set({ spec: reviewSpec(released) })
      .where(and(
        eq(generated_resumes.id, locked.id),
        eq(generated_resumes.user_id, userId),
        sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
      ))
      .returning({ id: generated_resumes.id });
    if (!updated) return null;
    return { row: locked, review: released, disposition: 'released' as const };
  });
  if (!result) return null;
  log.info(
    {
      applicationId: result.row.id,
      claimId: result.review.submission_claim_id ?? result.review.claim_released?.claim_id ?? null,
      disposition: result.disposition,
    },
    result.disposition === 'unverified'
      ? 'Reconciled an expired employer capability to an applicant outcome question'
      : result.disposition === 'never_reached'
        ? 'Released a submission attempt the ledger proves never reached the employer boundary'
        : 'Released a legacy attended handoff whose pre-click claim expired',
  );
  return {
    ...result.row,
    spec: { ...(result.row.spec as StoredSpec), _review: result.review },
  };
}

/* The cheapest possible "could this row be a stalled fill" question, asked of the row a route has
 * ALREADY read, before the helper opens a transaction or touches a lock at all. The same discipline
 * as expiredHandoffClaimRepairIsPossible above, and for the same reason: GET
 * /applications/:id/submission runs on every 2.5s dashboard poll, and for the vast majority of rows
 * this has to be a field read rather than a transaction plus an advisory lock.
 *
 * DELIBERATELY NOT the full rule. It answers only "is this the right SHAPE of row", never "may it be
 * released" - the clock and the ledger proof both live in stalledFillRunReleaseIsAdmissible and are
 * asked under the lock, against the freshly locked row and the database's own clock. A predicate
 * that can be checked cheaply and a predicate that decides a release are different things, and
 * conflating them is how a decision ends up made against a stale read. */
export function stalledFillRunRepairIsPossible(
  review: ApplicationReviewState | null,
): boolean {
  if (!review) return false;
  if (review.status !== 'preparing' && review.status !== 'filling') return false;
  return !review.submission_claim_id && !review.submission_claimed_at && !review.browser_session_id;
}

/* THE FILL RUN THAT DIED WITHOUT WRITING A TERMINAL STATE, bounded so the packet frees itself.
 *
 * Measured live 2026-09-04 on Palantir packet f1cfb841 - status `filling`, no claim, no ledger
 * attempt, frozen since 06:53:50.899Z, and unreachable by the cron, by the runner's own step, by
 * every re-run route and by repairExpiredAttendedHandoffClaim. See lib/stalledFillRunRelease.ts for
 * the whole mechanism and for why this is neither of the two open rules on the neighbouring shapes.
 *
 * WHY IT IS A SEPARATE HELPER rather than a fourth arm of repairExpiredAttendedHandoffClaim. That
 * helper's every arm is about a CLAIM: its precondition returns false as its first line on a row
 * with neither submission_claim_id nor submission_claimed_at, which is exactly this row, and each
 * of its arms then releases a claim and writes a ledger fact against the attempt that claim names.
 * This row has no claim and no attempt, so it shares neither the precondition, nor the arms, nor
 * the ledger write. Folding it in would mean loosening that precondition for every arm at once,
 * which is precisely the sort of widening that lets one rule's row reach another rule's release.
 *
 * NO LEDGER WRITE, and that is the whole reason a clock is affordable here. There is no attempt to
 * close, so this cannot poison a live run's own late fold the way a premature not_sent_proven would.
 * The single write is the row's status.
 *
 * Best effort, exactly like its neighbour: null on any miss - a lost try-lock, a lost CAS, a row a
 * concurrent run has already moved - and the caller proceeds with the stored row, whose gates then
 * refuse precisely as they did before. A missed release costs one more request; a wrong release
 * could cost an applicant a duplicate, which is why the ledger proof is required under the lock and
 * the write is CAS'd against the exact spec that was read. */
async function repairStalledFillRun(
  row: NonNullable<Awaited<ReturnType<typeof ownedResume>>>,
  userId: string,
  log: FastifyRequest['log'],
): Promise<NonNullable<Awaited<ReturnType<typeof ownedResume>>> | null> {
  if (!stalledFillRunRepairIsPossible(readApplicationReview(row.spec))) return null;
  const result = await db.transaction(async (tx) => {
    /* TRY, NEVER WAIT, for the reason its neighbour states: waiting on this lock is what let a 280s
     * managed provider call hold a route open on every dashboard poll. The lock is taken at all
     * because claimSubmission takes the same one, so holding it means no attempt can be opened
     * between the ledger read below and the write.
     *
     * BUT IT SAYS SO WHEN IT LOSES, which is why this arm is no longer a bare `return null`.
     * Measured 2026-09-04: two packets sat in `filling` for 6 hours and 3 days, this release was
     * wired into GET /applications/:id/submission (the 2.5s poll) and into packet-audit, the
     * packet page was open for 40+ seconds, and nothing happened and nothing was logged. This is
     * the arm that was losing. The projection read behind that very poll held this same key
     * account-wide and exclusively for the length of a whole-account snapshot, so a poll arriving
     * while the previous one was still reading found the key taken and gave up silently - forever,
     * on an account big enough that the snapshot outran the poll interval.
     *
     * The holder is fixed where it is caused (readers now take the key shared), and the silence is
     * fixed here: a repair that declines has to be distinguishable from a repair that had nothing
     * to do, or the next person measures 40 seconds of nothing and cannot tell which. */
    if (!await tryLockSubmissionAttemptUser(tx, userId)) return 'lock_contended' as const;
    const [locked] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, userId),
    )).limit(1).for('update');
    const current = locked ? readApplicationReview(locked.spec) : null;
    if (!locked || !current) return null;
    const clockResult = await tx.execute(sql`select clock_timestamp() as now`);
    const clockValue = (clockResult.rows[0] as { now?: Date | string } | undefined)?.now;
    const databaseNow = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
    if (Number.isNaN(databaseNow.getTime())) throw new Error('Database reconciliation clock was unavailable');
    const events = await submissionAttemptEventsForPacket(userId, locked.id, { executor: tx });
    const retrySafety = submissionAttemptRetrySafetyForPacketEvents(events);
    if (!stalledFillRunReleaseIsAdmissible(current, retrySafety, databaseNow.getTime())) return null;
    const released = releaseStalledFillRun(current, databaseNow.toISOString());
    const [updated] = await tx.update(generated_resumes)
      .set({ spec: reviewSpec(released) })
      .where(and(
        eq(generated_resumes.id, locked.id),
        eq(generated_resumes.user_id, userId),
        sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
      ))
      .returning({ id: generated_resumes.id });
    if (!updated) return null;
    return { row: locked, review: released, stalledStatus: current.status, retrySafety: retrySafety.kind };
  });
  if (result === 'lock_contended') {
    log.warn(
      { applicationId: row.id },
      'Stalled fill release skipped: another actor on this account holds the submission attempt lock',
    );
    return null;
  }
  if (!result) return null;
  log.info(
    {
      applicationId: result.row.id,
      stalledStatus: result.stalledStatus,
      retrySafetyKind: result.retrySafety,
    },
    'Released a prepare run that stopped mid-fill without writing a terminal state',
  );
  return {
    ...result.row,
    spec: { ...(result.row.spec as StoredSpec), _review: result.review },
  };
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
    untailored: packetIsUntailoredMainResume(stored),
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
  /* One provenance read for both generator gates on this packet: the lead citation (below, and
   * applicationLeadAlignmentIssues above) and the skills-grounding rule. See validateResumeSpec's
   * `untailored` option for why her own uploaded document is not judged as a generation. */
  const untailored = packetIsUntailoredMainResume(stored);
  const validation = validateResumeSpec(
    spec,
    review.jd_text,
    bank,
    declaredSkillsList(profileRows[0]?.skills),
    candidateEducationFromParsedProfile(parsed),
    review.role,
    {
      allowedSingleBulletEntries: allowedSparseEntriesForApplicationEdit(parsed, bank),
      untailored,
    },
  );
  if (validation.issues.length > 0) return validation.issues;

  const rendered = await renderResumePdf(spec, { ...contact, full_name: contact.full_name }, review.jd_text);
  const visual = validateResumeVisualLayout(rendered.layout);
  const parsedPdf = await extractPdfText(rendered.buffer);
  return [
    ...leadAlignmentIssues(rendered.spec, review.jd_text, {
      context: { company, role: review.role },
      untailored,
    }),
    ...visual.issues,
    ...validatePdfLayout(parsedPdf.text, parsedPdf.numpages).issues,
    ...findPdfSafeMarginIssues(parsedPdf.pages, rendered.layout),
    ...findPdfTextFidelityIssues(parsedPdf.text, rendered.spec, { ...contact, full_name: contact.full_name }),
  ];
}

async function loadSensitiveQuestionProfile(userId: string): Promise<ApplicationProfileLike> {
  return loadApplicationProfileLike(userId);
}

/**
 * EVERY sensitive question still waiting on her, in packet order.
 *
 * sensitiveQuestionFor below is this list's head and the send gates keep using it, because a refusal
 * names one thing to go and do. This full list exists for the surfaces that have to SHOW her the
 * work: GET /applications/:id/submission returns it so the dashboard can mark the exact rows that
 * need a confirmation, instead of the applicant discovering them one 422 at a time. Three sessions
 * were spent on packet 4a79eec1 without anyone seeing which question was blocking, because the only
 * place the answer existed was a paragraph of error text after pressing Send.
 *
 * EXPORTED FOR ONE END-TO-END TEST AND NOTHING ELSE IN src. That test composes the real send path -
 * resolveSubmittedApplicationAnswers, then resolvePacketAuditQuestionFixpoint to a fixpoint - and
 * has to ask "would the send still refuse this packet". The only honest way to ask it is to call
 * THIS function, the one POST /submission/approve calls; re-implementing its filter in a test file
 * would pass whatever this function happened to do, which is the vacuous-test shape.
 */
export function sensitiveQuestionsFor(
  questions: readonly ApplicationReviewQuestion[],
  profile: ApplicationProfileLike,
  jdText: string | undefined,
  postingCountry: JobCountry | undefined,
  postingCountryCode?: string,
  /* The packet's own review round, so a question she answered herself in THIS round can satisfy a
   * gate that the resolver has declined to answer for her. Omitting it is fail-closed: every
   * question then reads as unreviewed and the gate behaves exactly as it did before. */
  questionsReviewedAt?: string,
): ApplicationReviewQuestion[] {
  return normalizeApplicationReviewQuestions(questions)
    /* An OPTIONAL sensitive question with no answer is an offer, not a blocker. R-096 now mints
       answerless records for refused questions the employer left voluntary (the normal case for
       an EEO section) so she can answer them in the product; an empty answer generates no fill
       action, so there is nothing here a send could disclose, and refusing the send over it would
       hold a complete application hostage to a section the employer itself marked optional. A
       REQUIRED sensitive question keeps the gate exactly as it stands, answered or not. */
    .filter((question) => question.required || question.answer.trim().length > 0)
    /* THE RECORD-FIRST FORM, so her own confirmation and her own current-round review are both
     * inputs to the gate that is asking about her, and so that neither can stop being one by
     * accident. The label-and-answer form takes the record and the reviewed flag as trailing
     * optional arguments, and dropping either at a call site is a one-token change with no type
     * error and no failing test that silently reverts one of the two fixes. See
     * reviewQuestionRequiresAttention, which is why the round is passed here rather than a boolean
     * derived from it. */
    .filter((question) => reviewQuestionRequiresAttention(
      question, profile, jdText, postingCountry, postingCountryCode, questionsReviewedAt,
    ));
}

/** The head of the list above. Exported for the same one end-to-end test, and for the same reason. */
export function sensitiveQuestionFor(
  questions: readonly ApplicationReviewQuestion[],
  profile: ApplicationProfileLike,
  jdText: string | undefined,
  postingCountry: JobCountry | undefined,
  postingCountryCode?: string,
  /* FORWARDED, AND THIS IS THE LINE THE MERGE WOULD HAVE EATEN. The list form gained the review
   * round while the head form was being split out of it; a head form that quietly dropped the round
   * would have left every send gate in this file resolving a declined question as unreviewed, which
   * is the whole defect, with every test still green because the list form kept working. */
  questionsReviewedAt?: string,
): ApplicationReviewQuestion | undefined {
  return sensitiveQuestionsFor(
    questions, profile, jdText, postingCountry, postingCountryCode, questionsReviewedAt,
  )[0];
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
  /* HEAL WHAT LITOS CAN PROVE BEFORE REFUSING ANYTHING, so a block that needs no human never
   * reaches one.
   *
   * Measured 2026-09-03 on Databricks 1d4c8113: the refusal named an earlier attempt carrying
   * `attempt_opened` alone and sent the applicant to check the employer's page for it. The ledger
   * already proves that attempt never crossed the boundary, so there was nothing on that page to
   * find, and the block it created was permanent. closeAbandonedPreBoundaryAttempts writes the
   * not-sent fact the ledger already licenses, and the verdict below is then computed against a
   * ledger that no longer holds a phantom.
   *
   * HERE, AND NOT INSIDE duplicateApplicationVerdict, which the gates call to ask a question, not
   * to change one. The heal itself now also runs from three GET projections (`unattemptedPacketSubmissionAuthority`
   * below, GET /resume/history, GET /applications/board) through the same
   * healAbandonedPreBoundaryAttemptsForRead this call was factored into - a read no longer has to
   * wait for a send-path POST to see what the ledger already proves. See that function's doc
   * (lib/abandonedAttemptClosure.ts) for why healing from a GET is safe: same proof, a lock that
   * never waits, and paid only on the shape this module exists to close.
   *
   * BEST EFFORT, NEVER BLOCKING. A failure here leaves the ledger exactly as it was and the verdict
   * refuses precisely as it did before, so the worst case is the behaviour that shipped yesterday.
   *
   * DELIBERATELY UNSCOPED - REVIEW ROUND 1, 2026-09-05. Unlike the three GET callers, this send
   * path has no one packet or page to narrow to: `row.id` is what is being sent, but
   * duplicateApplicationVerdict right below can refuse it over an abandoned attempt on a DIFFERENT
   * packet against the same posting, so scoping this heal to `row.id` alone could leave exactly
   * the cross-packet phantom this module exists to close. It still cannot run unbounded, though -
   * see READ_HEAL_MAX_CANDIDATES on healAbandonedPreBoundaryAttemptsForRead's doc
   * (lib/abandonedAttemptClosure.ts) for why the whole-ledger case is now capped too. */
  await healAbandonedPreBoundaryAttemptsForRead({
    userId,
    log,
    logContext: { applicationId: row.id },
    trigger: 'send_path',
  });
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
    attention_categories: [verdict.kind === 'unidentifiable'
      ? 'unverified_submission'
      : verdict.match.certainty === 'unverified'
        ? 'unverified_submission'
        : 'duplicate_application'],
    submission_error: undefined,
  }, () => now);
  await db.update(generated_resumes)
    .set({ spec: reviewSpec(refused) })
    .where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, userId),
      sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
    ));
  if (verdict.kind === 'unidentifiable') {
    log.warn(
      { applicationId: row.id, priorApplicationId: verdict.application_id },
      'Submission refused: an earlier attempt cannot be safely distinguished from this posting',
    );
  } else {
    log.info(
      { applicationId: row.id, duplicateOf: verdict.match.application_id, basis: verdict.match.basis },
      'Submission refused: this user already applied to this posting',
    );
  }
  return verdict;
}

function duplicateRiskResponse(verdict: Exclude<DuplicateApplicationVerdict, { kind: 'clear' }>) {
  return verdict.kind === 'duplicate'
    ? duplicateApplicationResponse(verdict)
    : unidentifiableDuplicateApplicationResponse(verdict);
}

export async function applicationRoutes(fastify: FastifyInstance) {
  /**
   * POST /applications/:id/jd-repair - replace a frozen job description that is an application form.
   *
   * WHY A ROUTE AND NOT A CRON OR A READ PATH. packetJdRepair moves `jd_text`, which is hashed into
   * packetBindings.jdSha256, so a repair moves `packet_version` and takes any stored acknowledgement
   * to packet_stale. That is a consequence the operator has to choose, per row, having seen what the
   * replacement would be. A read path that repaired on sight would do it to rows nobody asked about,
   * and a cron would do it to all of them at once.
   *
   * PLAN-ONLY BY DEFAULT. Without `confirm: true` this performs no write at all: it returns the plan
   * planPacketJdRepair produced, including the refusals, so a row can be inspected before anything
   * touches it. The write-back is the one step in this feature nobody has yet observed on real data,
   * and defaulting to it would be the wrong way round.
   *
   * THE REFUSALS ARE THE POINT, not an edge case. Measured on Jane Street packet 496cff97 while
   * wiring this: `submitted_at` is null but `submission_attempted_at` is set, a `security_code` is
   * on the row, and attention_reason reads "Litos entered the employer verification step, but could
   * not prove the final result." An employer may hold that application. Its description is wrong and
   * it must still not be rewritten, because the frozen description is the record of what was sent.
   * planPacketJdRepair already refuses it through employerMayHoldApplication; this route must never
   * grow an override for that.
   */
  fastify.post(
    '/applications/:id/jd-repair',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;

      const confirm = (request.body as { confirm?: unknown } | undefined)?.confirm === true;

      if (!(await allowHourly(request.jwtPayload!.userId, 'jdRepair', LIMITS.perHour.jobExtract))) {
        return rateLimitedReply(reply);
      }

      const planned = await planPacketJdRepair(row);
      if (!planned) {
        /* One shape for every refusal, deliberately. The reasons are not equally safe to publish -
         * "an employer may hold this" and "this description is fine" are different facts about the
         * row - and the caller's next action is identical either way: leave it alone. */
        return reply.status(200).send({ repaired: false, planned: false });
      }

      const preview = {
        source: planned.replacement.source,
        chars: planned.replacement.text.length,
        head: planned.replacement.text.slice(0, 300),
      };
      if (!confirm) return reply.status(200).send({ repaired: false, planned: true, preview });

      const written = await repairPacketJd(row);
      if (!written) {
        /* A lost CAS, or a row that stopped qualifying between the plan and the write. Never retried
         * here: repairPacketJd returns null precisely so the caller re-reads rather than replaying a
         * plan built against a spec that is no longer on the row. */
        return reply.status(409).send({ repaired: false, planned: true, code: 'jd_repair_row_moved' });
      }
      request.log.warn(
        { applicationId: row.id, userId: row.user_id, source: preview.source, chars: preview.chars },
        'packet job description repaired',
      );
      return reply.status(200).send({ repaired: true, planned: true, preview });
    },
  );

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
      row = await repairStalledFillRun(row, request.jwtPayload!.userId, request.log) ?? row;
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
        if (monitoredPortalProofUnavailable(row, auditSourceReview)) {
          return reply.status(409).send({
            error: 'Current verified posting not found',
            code: 'job_not_available',
          });
        }
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
        if (monitoredPortalProofUnavailable(packetRow, repairedPacketReview)) {
          return reply.status(409).send({
            error: 'Current verified posting not found',
            code: 'job_not_available',
          });
        }
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
        /* A WRITE CONFLICT IS NOT A VERDICT ABOUT THE PACKET, and this catch was publishing it as
         * one - with the statement attached.
         *
         * Every OTHER throw reaching here is an authored sentence about this application, written
         * to be read: "The stored resume is not a verified PDF", "The stored resume PDF is not bound
         * to this exact saved resume. Generate it again." Echoing `error.message` at 422 is right
         * for those and only for those. The submission-authority revision guard's 40001 is not one
         * of them: drizzle-orm wraps the pg error in a DrizzleQueryError whose message is `Failed
         * query: <the whole UPDATE>\nparams: <every bound value>`, so this line shipped the audit's
         * update, its predicate and its parameter shape to the browser under a code that says the
         * packet failed verification. Measured live 2026-09-04 on packet 73768339, alongside the
         * same statement's 500 out of PUT /review/answers - two paths, two status codes, one
         * condition, and neither of them the condition.
         *
         * Rethrown so it reaches the global handler, which answers 503 with Retry-After: 1 and the
         * sentence toPublicError already carries for this SQLSTATE. Nothing was written, the packet
         * is unchanged, and the only true instruction is "try again in a moment". */
        if (isAuthorityRevisionConflictError(error)) {
          request.log.warn(
            { applicationId: row.id },
            'Packet audit lost the authority revision guard; answering 503 rather than a packet verdict',
          );
          throw error;
        }
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
      /* Retried on the authority guard's 40001, and NOT collapsed into the zero-row branch, for the
       * same reason createAndPersistPacketAudit is not: the refusal below is PACKET_AUDIT_STALE,
       * which the dashboard treats as terminal and answers by throwing away her acknowledgement and
       * sending her back to re-review the packet. A lock held for a few milliseconds by a poll must
       * not cost her that. An exhausted window propagates and answers 503 with Retry-After. */
      const updated = await withAuthorityRevisionRetry(() => db.update(generated_resumes)
        .set({ spec: reviewSpec(next) }).where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
        )).returning({ id: generated_resumes.id }), {
        onRetry: (attempt) => request.log.warn(
          { applicationId: row.id, attempt },
          'packet audit acknowledgement hit the authority revision guard; retrying',
        ),
      });
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
      const review = readApplicationReview(row.spec);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });

      // This action-time read is the dashboard's sole authority to navigate. It deliberately
      // repeats every live packet check instead of trusting the audit object or URL held in React:
      // currentAcknowledgedPacketAudit revalidates the exact PDF/spec/JD/answers, current personal
      // resume email, and active owner/application Litos alias before any company URL is disclosed.
      const audit = await currentAcknowledgedPacketAudit(row, {
        questions: await resolvedPacketAuditQuestions(row, review),
        restoreExpiredResume: 'authorizing_send',
      });
      if (!audit.valid) return reply.status(409).send(packetAuditClientError(audit));
      const auditedRow = audit.row;
      const userId = request.jwtPayload!.userId;
      const result = await db.transaction(async (tx) => {
        await lockSubmissionAttemptUser(tx, userId);
        const [locked] = await tx.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, auditedRow.id),
          eq(generated_resumes.user_id, userId),
        )).limit(1).for('update');
        if (!locked
          || locked.resume_object_key !== auditedRow.resume_object_key
          || !isDeepStrictEqual(locked.job_context, auditedRow.job_context)
          || !sameApplicationPacketSpec(locked.spec, auditedRow.spec)) {
          return { kind: 'changed' as const };
        }
        const current = readApplicationReview(locked.spec);
        if (!current) return { kind: 'no_review' as const };
        if (current.status === 'filling' && current.browser_session_id) {
          return { kind: 'active_fill' as const };
        }
        const retainedSessionId = current.status === 'needs_attention'
          ? current.browser_session_id
          : undefined;
        const url = retainedSessionId ? undefined : verifiedDashboardHandoffUrl({
          applicationId: locked.id,
          userId: locked.user_id,
          frozenUrl: current.portal_url,
          frozenHandoffUrl: current.extension_handoff_url,
          frozenHandoffBinding: current.extension_handoff_binding,
          frozenAtsName: current.ats_name,
          status: current.status,
          attentionReason: current.attention_reason,
          attentionCategories: current.attention_categories,
          submissionClaimedAt: current.submission_claimed_at,
          submissionClaimId: current.submission_claim_id,
          submissionPacketVersion: current.submission_packet_version,
          submissionAttemptedAt: current.submission_attempted_at,
          submittedAt: current.submitted_at,
          receipt: current.receipt,
          unverifiedSubmission: current.unverified_submission,
        });
        if (!retainedSessionId && !url) return { kind: 'unavailable' as const };
        const postingIdentity = freezePostingIdentity(locked.job_context, current.portal_url);
        const duplicate = await duplicateApplicationVerdict({
          userId,
          applicationId: locked.id,
          jobContext: locked.job_context,
          portalUrl: current.portal_url,
        }, tx);
        if (duplicate.kind !== 'clear') return { kind: 'duplicate_risk' as const, verdict: duplicate };
        const canonicalApplication = await canonicalApplicationForNewPacketAttempt(tx, {
          userId,
          packetId: locked.id,
          postingIdentity,
        });
        const claimId = randomUUID();
        const now = new Date().toISOString();
        const next: ApplicationReviewState = {
          ...current,
          ...submissionClaimPatch(now, claimId),
          submission_packet_version: audit.audit.packet_version,
          submission_authorization: {
            source: 'user_initiated_extension',
            authorized_at: now,
          },
          updated_at: now,
        };
        const [updated] = await tx.update(generated_resumes).set({ spec: reviewSpec(next) }).where(and(
          eq(generated_resumes.id, locked.id),
          eq(generated_resumes.user_id, userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null`,
        )).returning({ id: generated_resumes.id });
        if (!updated) return { kind: 'changed' as const };
        const binding: SubmissionAttemptBinding = {
          attemptId: claimId,
          userId,
          packetId: locked.id,
          applicationId: canonicalApplication.id,
          parentAttemptId: null,
          source: 'attended_handoff',
          operation: 'manual_submission',
          postingIdentity,
          submissionRunId: current.submission_run_id ?? null,
          submissionClaimId: claimId,
          packetVersion: audit.audit.packet_version,
        };
        await appendSubmissionAttemptEvent({
          ...binding,
          eventId: submissionAttemptEventId(claimId, 'attempt_opened', 'manual-handoff-reservation'),
          eventKind: 'attempt_opened',
          evidenceCode: `attended_handoff_capability_v1:manual_handoff:${audit.audit.audit_digest}:${audit.audit.packet_version}`,
          observedAt: new Date(now),
        }, { executor: tx });
        const authorization = await authorizeFinalSubmissionBoundary(binding, {
          executor: tx,
          factKey: 'manual-handoff-boundary',
          evidenceCode: 'attended_handoff_employer_boundary_authorized',
        });
        if (authorization.kind !== 'fresh') throw new Error('MANUAL_HANDOFF_BOUNDARY_CONFLICT');
        let retainedSessionUrl: string | undefined;
        let disclosureAuthorization = authorization.authorization;
        if (retainedSessionId) {
          try {
            retainedSessionUrl = await getLiveViewUrl(retainedSessionId, { timeoutMs: 5_000 });
          } catch {
            throw new Error('MANUAL_HANDOFF_RETAINED_SESSION_UNAVAILABLE');
          }
          // The provider call is bounded but still consumes time. Read the database clock again
          // while the shared user lock is held, then bind disclosure to the exact lease opened
          // above. A URL obtained after expiry, replacement, or binding drift never leaves Litos.
          const currentAuthorization = await submissionBoundaryAuthorization(
            userId,
            binding.attemptId,
            { executor: tx },
          );
          if (!currentAuthorization
            || !currentAuthorization.active
            || currentAuthorization.attemptId !== authorization.authorization.attemptId
            || currentAuthorization.leaseId !== authorization.authorization.leaseId
            || currentAuthorization.activationId !== authorization.authorization.activationId
            || currentAuthorization.expiresAt !== authorization.authorization.expiresAt) {
            throw new Error('MANUAL_HANDOFF_RETAINED_SESSION_LEASE_EXPIRED');
          }
          disclosureAuthorization = currentAuthorization;
        }
        return {
          kind: 'authorized' as const,
          url,
          retainedSessionId,
          retainedSessionUrl,
          next,
          claimId,
          authorization: disclosureAuthorization,
        };
      }).catch((error: unknown) => {
        if (error instanceof Error
          && error.message === 'MANUAL_HANDOFF_RETAINED_SESSION_UNAVAILABLE') {
          return { kind: 'retained_session_unavailable' as const };
        }
        if (error instanceof Error
          && error.message === 'MANUAL_HANDOFF_RETAINED_SESSION_LEASE_EXPIRED') {
          return { kind: 'retained_session_lease_expired' as const };
        }
        throw error;
      });
      if (result.kind === 'active_fill') {
        return reply.status(409).send({
          error: 'Litos is still filling this company form. Wait for the dashboard to finish before opening it.',
          code: 'MANUAL_HANDOFF_FILL_ACTIVE',
        });
      }
      if (result.kind === 'retained_session_unavailable') {
        return reply.status(409).send({
          error: 'The retained company session is no longer available. Reload this application before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
        });
      }
      if (result.kind === 'retained_session_lease_expired') {
        return reply.status(409).send({
          error: 'The retained company session authorization expired before it could be opened. Reload this application before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
        });
      }
      if (result.kind === 'authorized' && result.retainedSessionId) {
        return reply.send({
          manual_handoff: {
            mode: 'retained_session',
            url: result.retainedSessionUrl,
            claim_id: result.claimId,
            activation_contract: 'server-lease-v1',
            activation_id: result.authorization.activationId,
            activation_lease_id: result.authorization.leaseId,
            activation_expires_at: result.authorization.expiresAt,
            activation_server_now: result.authorization.serverNow,
            audit_digest: audit.audit.audit_digest,
            packet_version: audit.audit.packet_version,
            pdf_sha256: audit.audit.bindings.pdf.sha256,
            size_bytes: audit.audit.bindings.pdf.sizeBytes,
          },
        });
      }
      if (result.kind === 'changed') {
        return reply.status(409).send({
          error: 'This application changed while its company handoff was being verified. Reload it before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
        });
      }
      if (result.kind === 'no_review') {
        return reply.status(409).send({ error: 'Application review is not available for this resume' });
      }
      if (result.kind === 'unavailable') {
        return reply.status(409).send({
          error: 'This application no longer has a verified company handoff. Reload it before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
        });
      }
      if (result.kind === 'duplicate_risk') {
        return reply.status(409).send(duplicateRiskResponse(result.verdict));
      }
      return reply.send({
        manual_handoff: {
          mode: 'chrome_extension',
          url: result.url,
          claim_id: result.claimId,
          activation_contract: 'server-lease-v1',
          activation_id: result.authorization.activationId,
          activation_lease_id: result.authorization.leaseId,
          activation_expires_at: result.authorization.expiresAt,
          activation_server_now: result.authorization.serverNow,
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
      let authorizedManualClaim = false;
      if (review.submission_claim_id && review.submission_packet_version) {
        const events = (await submissionAttemptEventsForPacket(row.user_id, row.id))
          .filter((event) => event.attempt_id === review.submission_claim_id);
        const opening = events.find((event) => event.event_kind === 'attempt_opened');
        const authorization = await submissionBoundaryAuthorization(
          row.user_id,
          review.submission_claim_id,
        );
        const safety = submissionAttemptRetrySafety(events);
        authorizedManualClaim = Boolean(opening
          && opening.source === 'attended_handoff'
          && opening.operation === 'manual_submission'
          && opening.submission_claim_id === review.submission_claim_id
          && opening.packet_version === review.submission_packet_version
          && authorization?.active
          && safety.kind === 'blocked_unverified'
          && safety.reason === 'boundary_authorized'
          && safety.leaseId === authorization.leaseId
          && safety.expiresAt === authorization.expiresAt);
      }
      if (!extensionHandoffPacketMatches({
        frozenUrl: review.portal_url,
        frozenHandoffUrl: review.extension_handoff_url,
        currentUrl: query.data.current_url,
        frozenAtsName: review.ats_name,
        status: review.status,
        attentionReason: review.attention_reason,
        submissionClaimedAt: authorizedManualClaim ? undefined : review.submission_claimed_at,
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
      const parsed = extensionStartBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid extension submission request' });
      const params = paramsSchema.safeParse(request.params);
      if (!params.success) return reply.status(400).send({ error: 'Invalid application id' });
      const userId = request.jwtPayload!.userId;
      /* THE DUPLICATE GATE for the extension path, and it is the only one of the five that never
       * touches submissionRunner.submit: the extension does the filling and the clicking in the
       * applicant's own browser, and this route is the moment Litos authorizes it to. Refusing at
       * extension-outcome would be refusing to record a send that already happened.
       *
       * The expensive PDF verification runs ahead of the transaction. The transaction below then
       * requires the row to be the same JSON value before it authorizes the extension,
       * and the conditional update repeats that predicate. This binds the verification to the exact
       * packet version that receives the claim. */
      const [precheckRow] = await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, params.data.id),
        eq(generated_resumes.user_id, userId),
      )).limit(1);
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
          return reply.status(409).send({ error: 'Reload this saved application before submitting from Chrome' });
        }
        if (binding === 'mismatch') {
          return reply.status(409).send({ error: 'This saved application does not match the company form open in Chrome' });
        }
        if (binding === 'stale') {
          return reply.status(409).send({ error: 'The saved application changed. Reload it before submitting.' });
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
          return reply.status(409).send(packetAuditClientError(auditVerdict));
        }
        precheckPacketVersion = auditVerdict.audit.packet_version;
        precheckPacketQuestions = packetQuestions;
        precheckSensitiveProfile = sensitiveProfile;
        const verdict = await refuseDuplicateApplication(precheckRow, precheckReview, userId, fastify.log);
        if (verdict.kind !== 'clear') return reply.status(409).send(duplicateRiskResponse(verdict));
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
        const [openedToday, consent] = await Promise.all([
          submissionAttemptsOpenedToday(userId, { executor: tx }),
          tx.select({
          automatic_submission_enabled: users.automatic_submission_enabled,
          automatic_submission_consented_at: users.automatic_submission_consented_at,
          automatic_submission_consent_version: users.automatic_submission_consent_version,
          }).from(users).where(eq(users.id, userId)).limit(1),
        ]);
        const consentRow = consent[0];
        const disposition = canStartExtensionSubmission(current, parsed.data.authorization, consentRow?.automatic_submission_enabled === true);
        if (disposition !== 'start') return { kind: disposition, row, current };
        if (parsed.data.authorization === 'standing_consent') {
          const standingConsentIsCurrent = consentRow?.automatic_submission_enabled === true
            && Boolean(consentRow.automatic_submission_consented_at)
            && consentRow.automatic_submission_consent_version === AUTOMATIC_SUBMISSION_CONSENT_VERSION;
          if (!standingConsentIsCurrent) return { kind: 'consent_required' as const, row, current };
          const entitlement = await getEntitlementSnapshot(userId, new Date(), tx);
          if (!entitlement.features.automatic_submission) {
            return { kind: 'entitlement_required' as const, row, current };
          }
        }
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
          current.questions_reviewed_at,
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
        const questionGate = submissionQuestionGate({
          questions: refreshedQuestions,
          question_metadata_blockers: current.question_metadata_blockers,
        });
        if (questionGate.metadataBlockerCount > 0) {
          return { kind: 'question_metadata_incomplete' as const, count: questionGate.metadataBlockerCount };
        }
        const unansweredRequired = questionGate.requiredQuestionLabels;
        if (unansweredRequired.length > 0) return { kind: 'required_answer_missing' as const, questions: unansweredRequired };
        if (questionGate.optionalQuestionLabels.length > 0) {
          return { kind: 'optional_decision_missing' as const, questions: questionGate.optionalQuestionLabels };
        }
        if (!withinDailyCap(openedToday, dailySubmissionCap())) return { kind: 'cap' as const };
        const postingIdentity = freezePostingIdentity(row.job_context, current.portal_url);
        const duplicate = await duplicateApplicationVerdict({
          userId,
          applicationId: row.id,
          jobContext: row.job_context,
          portalUrl: current.portal_url,
        }, tx);
        if (duplicate.kind !== 'clear') return { kind: 'duplicate_risk' as const, verdict: duplicate };
        const canonicalApplication = await canonicalApplicationForNewPacketAttempt(tx, {
          userId,
          packetId: row.id,
          postingIdentity,
        });
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
              consent_version: consentRow?.automatic_submission_consent_version,
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
        )).returning({ id: generated_resumes.id });
        if (updated.length === 0) return { kind: 'changed' as const };
        const binding: SubmissionAttemptBinding = {
          attemptId: claimId,
          userId,
          packetId: row.id,
          applicationId: canonicalApplication.id,
          parentAttemptId: null,
          source: 'chrome_extension',
          operation: 'initial_submission',
          postingIdentity,
          submissionRunId: current.submission_run_id ?? null,
          submissionClaimId: claimId,
          packetVersion: precheckPacketVersion,
        };
        await appendSubmissionAttemptEvent({
          ...binding,
          eventId: submissionAttemptEventId(claimId, 'attempt_opened', 'reservation'),
          eventKind: 'attempt_opened',
          evidenceCode: 'atomic_extension_claim_reserved',
          observedAt: new Date(now),
        }, { executor: tx });
        const authorization = await authorizeFinalSubmissionBoundary(binding, {
          executor: tx,
          factKey: 'extension-start-boundary',
          evidenceCode: 'chrome_extension_employer_boundary_authorized',
        });
        if (authorization.kind !== 'fresh') {
          throw new Error('EXTENSION_BOUNDARY_AUTHORIZATION_CONFLICT');
        }
        return {
          kind: 'started' as const,
          row,
          claimId,
          next,
          activationId: authorization.authorization.activationId,
          activationLeaseId: authorization.authorization.leaseId,
          activationExpiresAt: authorization.authorization.expiresAt,
          activationServerNow: authorization.authorization.serverNow,
        };
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
      if (result.kind === 'not_found') return reply.status(404).send({ error: 'Application not found' });
      if (result.kind === 'no_review') return reply.status(409).send({ error: 'Application review is not available for this resume' });
      if (result.kind === 'consent_required') return reply.status(403).send({ error: 'Automatic submission is turned off' });
      if (result.kind === 'entitlement_required') {
        return reply.status(402).send({
          error: 'Automatic submission is no longer included in the current plan.',
          code: 'AUTOMATIC_SUBMISSION_ENTITLEMENT_REQUIRED',
        });
      }
      if (result.kind === 'submitted') return reply.send({ application_id: result.row.id, already_submitted: true, review: result.current });
      if (result.kind === 'in_flight') return reply.status(409).send({ error: 'This application already has an active submission' });
      if (result.kind === 'reject') return reply.status(409).send({ error: 'This application cannot be submitted again from its current state' });
      if (result.kind === 'education_drift') return reply.status(422).send(educationDriftResponse(result.issues));
      if (result.kind === 'sensitive_question') {
        /* THE CODE AND THE LABEL, so the client can put her in front of the right row instead of
         * printing a paragraph. Beside the sentence and never instead of it: the prose is what a
         * person reads, the code is what the dashboard branches on, and every other refusal in this
         * file that a client has to act on carries both. `questions` is an array of one to match the
         * shape the required-answer and optional-decision refusals already use, so one client
         * handler reads all three. The full label, not the truncated sentence, because the client
         * matches it against the question rows it is holding. */
        return reply.status(422).send({
          error: `Sensitive question requires your attention: ${result.question.slice(0, 120)}`,
          code: 'SENSITIVE_QUESTION_CONFIRMATION_REQUIRED',
          questions: [result.question],
        });
      }
      if (result.kind === 'question_metadata_incomplete') {
        return reply.status(422).send({
          error: 'Litos could not read complete employer question metadata, so it did not open the Chrome send capability.',
          code: 'QUESTION_METADATA_INCOMPLETE',
          count: result.count,
        });
      }
      if (result.kind === 'required_answer_missing') {
        // Same body shape as the unsupported-portal email refusal below, so a client can handle one
        // "you still owe an answer" response rather than two that differ only in wording.
        return reply.status(422).send({
          error: 'Answer every required question before submitting.',
          questions: result.questions,
        });
      }
      if (result.kind === 'optional_decision_missing') {
        return reply.status(422).send({
          error: 'Choose Answer or Skip for every optional question before submitting.',
          code: 'OPTIONAL_QUESTION_DECISION_REQUIRED',
          questions: result.questions,
        });
      }
      if (result.kind === 'duplicate_risk') {
        return reply.status(409).send(duplicateRiskResponse(result.verdict));
      }
      if (result.kind === 'cap') return reply.status(429).send({ error: 'Daily automatic submission safety limit reached' });
      if (result.kind === 'changed') return reply.status(409).send({ error: 'The application state changed before the extension could reserve it' });
      return reply.send({
        application_id: result.row.id,
        claim_id: result.claimId,
        activation_contract: 'server-lease-v1',
        activation_id: result.activationId,
        activation_lease_id: result.activationLeaseId,
        activation_expires_at: result.activationExpiresAt,
        activation_server_now: result.activationServerNow,
        review: result.next,
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
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid extension submission outcome' });
      const current = readApplicationReview(row.spec);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      if (current.status === 'submitted') {
        /* The packet already knows. The canonical row may not: an earlier outcome call whose
         * canonical advance failed leaves this retry as the one natural heal trigger, exactly the
         * way the email path's already-submitted branch heals on replay. */
        await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
        return reply.send({ application_id: row.id, review: current });
      }
      if (current.submission_claim_id !== parsed.data.claim_id || current.status !== 'submitting') {
        return reply.status(409).send({ error: 'This extension submission is no longer active' });
      }
      const outcomeAudit = await currentAcknowledgedPacketAudit(row, {
        /* The extension may already have pressed Submit. Verify the exact snapshot captured by the
         * claim, not a new profile or clock reading that could change after the employer received
         * it and prevent Litos from recording the receipt. */
        questions: current.questions,
      });
      if (!outcomeAudit.valid || current.submission_packet_version !== outcomeAudit.audit.packet_version) {
        // packetAuditClientError, never the raw verdict: a failed verdict's reason can be a
        // developer token such as packet_stale, and this reply is read by an applicant.
        return reply.status(409).send(outcomeAudit.valid
          ? {
            error: 'The audited packet no longer matches the extension submission claim.',
            code: 'PACKET_AUDIT_STALE' as const,
          }
          : packetAuditClientError(outcomeAudit));
      }
      const now = new Date().toISOString();
      const outcome = parsed.data.outcome === 'confirmed' && !extensionEmployerReceiptIsSufficient({
        portalUrl: current.portal_url,
        atsName: current.ats_name,
        confirmationText: parsed.data.confirmation_text,
        finalUrl: parsed.data.final_url,
      })
        ? 'unknown' as const
        : parsed.data.outcome;
      const terminal = await db.transaction(async (tx) => {
        await lockSubmissionAttemptUser(tx, request.jwtPayload!.userId);
        const [latest] = await tx.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
        )).limit(1).for('update');
        const latestReview = latest ? readApplicationReview(latest.spec) : null;
        if (!latest || !latestReview
          || latestReview.status !== 'submitting'
          || latestReview.submission_claim_id !== parsed.data.claim_id
          || latestReview.submission_packet_version !== outcomeAudit.audit.packet_version) return null;
        const events = (await submissionAttemptEventsForPacket(
          latest.user_id,
          latest.id,
          { executor: tx },
        )).filter((event) => event.attempt_id === parsed.data.claim_id);
        const opening = events.find((event) => event.event_kind === 'attempt_opened');
        if (!opening
          || opening.source !== 'chrome_extension'
          || opening.operation !== 'initial_submission'
          || !events.some((event) => event.event_kind === 'boundary_authorized')) {
          throw new Error('EXTENSION_ATTEMPT_AUTHORITY_MISSING');
        }
        const authorization = await submissionBoundaryAuthorization(
          latest.user_id,
          parsed.data.claim_id,
          { executor: tx },
        );
        if (!authorization
          || authorization.activationId !== parsed.data.activation_id
          || authorization.leaseId !== parsed.data.activation_lease_id
          || authorization.expiresAt !== parsed.data.activation_expires_at) {
          throw new Error('EXTENSION_ACTIVATION_LEASE_MISMATCH');
        }
        const binding = submissionAttemptBindingFromEvent(opening);
        const pressMayHaveOccurred = outcome !== 'cancelled';
        if (pressMayHaveOccurred && !events.some((event) => event.event_kind === 'press_observed')) {
          await appendSubmissionAttemptEvent({
            ...binding,
            eventId: submissionAttemptEventId(binding.attemptId, 'press_observed', 'extension-outcome'),
            eventKind: 'press_observed',
            evidenceCode: 'extension_submit_may_have_been_pressed',
            observedAt: new Date(now),
          }, { executor: tx });
        }
        const receiptIsAuthoritative = outcome === 'confirmed'
          && measuredPersistedReceiptMatchesOpening(
            opening,
            {
              ...opening,
              event_kind: 'submission_confirmed',
              evidence_code: 'extension_receipt_verified',
              observed_at: new Date(now),
              created_at: new Date(now),
            },
            parsed.data.final_url,
            parsed.data.confirmation_text ?? 'Application submitted',
          );
        const safeOutcome = receiptIsAuthoritative ? 'confirmed' as const : 'unknown' as const;
        const patch = safeOutcome === 'confirmed'
          ? extensionOutcomePatch('confirmed', now, {
            confirmationText: parsed.data.confirmation_text,
            finalUrl: parsed.data.final_url,
            portalUrl: latestReview.portal_url,
            submissionRunId: latestReview.submission_run_id,
          })
          : pressMayHaveOccurred
            ? extensionOutcomePatch('unknown', now, {
              confirmationText: parsed.data.confirmation_text,
              finalUrl: parsed.data.final_url,
              portalUrl: latestReview.portal_url,
              submissionRunId: latestReview.submission_run_id,
            })
            : {
              status: 'needs_attention' as const,
              submission_error: undefined,
              attention_reason: 'The Chrome send capability was opened, but Litos did not receive proof that it stayed unused. Check the employer portal before trying again.',
              unverified_submission: {
                at: now,
                cause: 'provider_error' as const,
                ...(latestReview.portal_url ? { portal_url: latestReview.portal_url } : {}),
                ...(latestReview.submission_run_id
                  ? { submission_run_id: latestReview.submission_run_id }
                  : {}),
              },
            };
        const next = applyReviewPatch(latestReview, patch, () => now);
        if (safeOutcome === 'confirmed') {
          await appendSubmissionAttemptEvent({
            ...binding,
            eventId: submissionAttemptEventId(binding.attemptId, 'submission_confirmed', 'extension-receipt'),
            eventKind: 'submission_confirmed',
            evidenceCode: 'extension_receipt_verified',
            observedAt: new Date(now),
          }, { executor: tx });
        }
        const updated = await tx.update(generated_resumes).set({
          spec: reviewSpec(next),
          ...(safeOutcome === 'confirmed'
            ? { pipeline_stage: 'applied', pipeline_stage_at: new Date(now) }
            : {}),
        }).where(and(
          eq(generated_resumes.id, latest.id),
          eq(generated_resumes.user_id, latest.user_id),
          sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${parsed.data.claim_id}`,
          sql`${generated_resumes.spec}->'_review'->>'status' = 'submitting'`,
        )).returning({ id: generated_resumes.id });
        if (!updated.length) throw new Error('EXTENSION_OUTCOME_WRITE_CONFLICT');
        if (safeOutcome === 'confirmed') {
          await syncCanonicalApplicationRow({
            attemptId: binding.attemptId,
            packetId: latest.id,
            userId: latest.user_id,
            applicationId: binding.applicationId,
            packetVersion: binding.packetVersion,
            postingIdentity: binding.postingIdentity,
          }, tx);
          const canonicalId = binding.applicationId;
          if (!canonicalId) throw new Error('EXTENSION_CANONICAL_APPLICATION_MISSING');
          const projections = await authoritativeSubmissionProjection({
            userId: latest.user_id,
            packetIds: [latest.id],
            applicationIds: [canonicalId],
            executor: tx,
          });
          const exact = {
            attemptId: binding.attemptId,
            canonicalApplicationId: canonicalId,
            packetId: latest.id,
          };
          if (!authoritativeConfirmedProjectionMatches(projections.byPacketId.get(latest.id), exact)
            || !authoritativeConfirmedProjectionMatches(projections.byApplicationId.get(canonicalId), exact)) {
            throw new Error('EXTENSION_CONFIRMATION_PROJECTION_INCOMPLETE');
          }
        }
        return next;
      });
      if (!terminal) {
        return reply.status(409).send({ error: 'The application state changed before the outcome was recorded' });
      }
      return reply.send({ application_id: row.id, review: terminal });
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
        // Named explicitly, not the wider default a bare two-argument call would now reach for:
        // this route calls the helper unconditionally on every content save, so widening what it
        // silently rewrites would start dropping a per-packet LinkedIn or portfolio link she set
        // deliberately at generation time under an edited bullet - see
        // LEGACY_MUTABLE_CONTACT_FIELDS.
        { fields: LEGACY_MUTABLE_CONTACT_FIELDS },
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
      /* Same rule as the generate route: the selector no longer reports "nothing citable here" as
         an issue, so an edit that leaves the resume with no shared word is ordered by
         rankLeadWithoutCitation and saved, not rejected. What is still rejected is a citation that
         is present and does not hold. */
      const editedLeadIssues = leadAlignmentIssues(edited, review.jd_text, {
        context: { company: applicationCompany(row), role: review.role },
        untailored: packetIsUntailoredMainResume(stored),
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
          untailored: packetIsUntailoredMainResume(stored),
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
      const blob = await putObject(requestedKey, rendered.buffer, { contentType: 'application/pdf' });
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
        /* THE WHOLE TRANSACTION IS THE RETRY UNIT HERE, not the statement inside it.
         *
         * The submission-authority revision guard raises 40001 from a BEFORE trigger on the UPDATE
         * above, and a raise inside an explicit transaction aborts that ENTIRE transaction - so
         * retrying the statement in place cannot succeed, and withAuthorityRevisionRetry's own
         * documentation says as much. Wrapping the transaction is the form that works: nothing was
         * committed, the artifact-version insert did not happen either, and the retried transaction
         * re-runs the identical exact-spec CAS, so it can only land on the row this edit was
         * composed against.
         *
         * OUTSIDE withReadOnlyRetry, deliberately. That helper's exhaustion path moves to a
         * dedicated writer endpoint because the pooled backend was READ-ONLY, which is a different
         * fault with a different remedy; a lock the account's own poll holds for four milliseconds
         * is not fixed by changing endpoints. The blob was uploaded before this block, so no retry
         * here re-uploads anything. */
        updated = await withAuthorityRevisionRetry(() => withReadOnlyRetry(
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
        ), {
          onRetry: (attempt) => request.log.warn(
            { attempt, applicationId: row.id },
            'Resume edit transaction hit the authority revision guard; retrying the whole transaction',
          ),
        });
      } catch (error) {
        await deleteObjects(blob.pathname).catch(() => undefined);
        throw error;
      }
      if (updated.length === 0) {
        await deleteObjects(blob.pathname).catch(() => undefined);
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
          ...(objectStorageUsesRailway() ? {} : { blobUrl: blob.url }),
          fileName: resumeFileNameForRole(contact.full_name, ((row.job_context ?? {}) as { role?: unknown }).role),
        })}`,
      });
    },
  );

  /* THE MEASURED DEFECT, live on trylitos.com 2026-09-04: every packet built before the applicant
   * moved still attaches its exact resume PDF with the OLD contact header. Pony.ai (fdcf4ccb),
   * Belvedere Trading (c4413bff, 6fda0404, 4de84885), Transparent Hiring (6f8524ca) and others were
   * built while application_profile read "Dubai" / "+971 567417451"; the profile now reads "Los
   * Angeles" / "+1 213 574 6270", the managed form fills the NEW pair live at submit time (it reads
   * the same profile row this route does), and the attached PDF still prints the OLD one. The form
   * and its own attachment disagree, on an axis neither one alone can show her.
   *
   * "Tailor resume" was the only existing remedy, and it is the wrong tool for a fact the tailoring
   * never touches: it spends one of the Free tier's 20 monthly builds, calls the LLM to re-select
   * and re-word content that was already correct, and (PR #855, open) forks a second Tracker row
   * for the one application. None of that is what a moved applicant needs.
   *
   * THE MECHANISM IS THE ONE THE EDIT-RESUME ROUTE ABOVE ALREADY USES FOR ITS OWN SILENT REFRESH.
   * That route calls refreshResumeContactFromProfile on every content save so an edit never
   * reintroduces a stale phone or residence underneath it; this route is that call BY ITSELF,
   * reachable without touching a bullet, a date, or the LLM. renderResumePdf is the same renderer,
   * called the same way (no bank argument, so no unused-bullet expansion): the ResumeSpec content
   * that goes in is byte-identical to what is already on the row, so packetBindings.specSha256
   * cannot move and this is not a new tailoring. Only the header text changes, so only the rendered
   * PDF's bytes change - which is deliberately enough to make the packet's audit re-run.
   *
   * `_review.packet_audit` and `_review.packet_audit_acknowledgement` are DELIBERATELY left
   * untouched, exactly as the edit-resume route leaves them. generated_resumes.resume_object_key
   * moves; `_review.packet_audit.bindings.pdf` does not, so the very next currentPacketAudit /
   * currentAcknowledgedPacketAudit call - the send gate, and the packet-audit screen - reads
   * `stored.pdf.objectKey !== currentBindings.pdf.objectKey`, answers 'packet_stale', and refuses
   * to honour whatever acknowledgement she already gave (see packetAudit.ts,
   * verifyCurrentPacketAudit). That is the whole immutability rule this route relies on rather than
   * reimplements: any prior acknowledgement is void the moment the PDF changes, and she re-reviews
   * the exact packet before it can be sent. `_quality.pdfGenerationBinding` IS updated, on purpose:
   * leaving it pointed at the old bytes would make hasCurrentGenerationBinding refuse the new PDF
   * outright ("Generate it again") instead of the graceful, re-reviewable 'packet_stale' this route
   * means to produce. */
  fastify.post(
    '/applications/:id/resume/contact-refresh',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const userId = request.jwtPayload!.userId;
      const stored = row.spec as StoredSpec;
      const review = readApplicationReview(stored);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      const storedContact = stored._contact as {
        full_name?: string;
        email?: string;
        phone?: string;
        location?: string;
        linkedin_url?: string;
        github_url?: string;
        portfolio_url?: string;
      } | undefined;
      if (!storedContact?.full_name) {
        return reply.status(409).send({ error: 'This older resume has no contact header to refresh. Generate it again first.' });
      }
      /* Same question PUT /review/answers asks of a saved answer, asked here of a swapped PDF: a
       * run holds this row, or the row's own evidence says an employer may already have this
       * packet. Neither state is one this route may write underneath - see
       * reviewAnswerSaveDisposition for exactly what it refuses and why, including
       * employerMayHoldApplication (an unclaimed row can still carry evidence the employer already
       * has it).
       *
       * NOT reviewAnswerSaveDisposition itself, though: its ready_for_final_approval refusal is
       * unconditional, which is right for an ANSWER save (rewriting an answer underneath the
       * preview she is looking at changes what that preview means) and wrong here - a header
       * refresh leaves every answer untouched, and the packet-audit path already voids her
       * acknowledgement the moment the PDF's bytes move (see this route's own comment above,
       * verifyCurrentPacketAudit -> packet_stale). resumeContactRefreshDisposition opens exactly
       * that one status, exactly the way the sibling PATCH /applications/:id/resume route already
       * does via resumeEditDisposition, while keeping every other reviewAnswerSaveDisposition
       * refusal - claimed or evidence-bearing alike. */
      if (resumeContactRefreshDisposition(review) !== 'save') {
        return reply.status(409).send({
          error: 'This application’s packet cannot be refreshed from its current submission state',
          code: 'CONTACT_REFRESH_NOT_AVAILABLE',
        });
      }

      const [profileRows, applicationProfile] = await Promise.all([
        db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1),
        loadApplicationProfileLike(userId),
      ]);
      /* Same refusal as the resume edit route, and for the same reason: refreshing phone, location
       * and links from the current profile is safe, but silently carrying a changed resume email
       * onto a frozen packet is not - that email is pinned into the applicant-email routing and the
       * packet audit's resumeContactEmailSha256, both decided at generation time. */
      const currentResumeEmail = resumeEmailOfRecord(profileRows[0]?.parsed_json);
      if (!resumePacketEmailIsCurrent(storedContact.email, currentResumeEmail)) {
        return reply.status(409).send({
          error: 'Your personal resume email changed or is missing. Regenerate this application before refreshing it.',
          code: 'resume_email_regeneration_required',
        });
      }

      const fullContact = { ...storedContact, full_name: storedContact.full_name };
      // The same comparison GET /applications/:id/submission uses for resume_contact_stale, so the
      // signal that offers this button and the route behind it can never disagree about whether
      // there is anything to do.
      const staleness = resumeContactStaleness(fullContact, applicationProfile as Record<string, unknown>);
      if (!staleness) {
        return reply.send({
          application_id: row.id,
          review,
          contact: { before: fullContact, after: fullContact },
        });
      }
      const newContact = staleness.current;
      if (!hasContactRoute(newContact)) {
        return reply.status(422).send({ error: 'Litos did not refresh this resume because it would have no way for an employer to reach you.' });
      }

      let contentSpec: ResumeSpec;
      try {
        contentSpec = editableResumeSpec(stored);
      } catch (error) {
        return reply.status(409).send({ error: error instanceof Error ? error.message : 'Invalid resume' });
      }
      // No LLM call, no jd-alignment re-check, no bank (fourth argument, defaulted): the content is
      // not moving, only the header is. Same renderer, same no-bank call the edit route above makes.
      const rendered = await renderResumePdf(contentSpec, newContact, review.jd_text);

      /* THE LONGER HEADER CAN COST A BULLET. planResumeLayout fits the page against whatever the
       * header takes up, so a header that grew - a state spelled out in full, a third link that
       * was not there before - can trim content that fit under the old, shorter one. rendered.spec
       * is the only spec that is true of these bytes, which is why it is what gets stored below
       * rather than contentSpec, and why it has to clear the same one-page checks
       * PATCH /applications/:id/resume runs after every edit, for the same reason: a PDF nobody
       * validated is not one this route may hand back labelled "refreshed". */
      const visual = validateResumeVisualLayout(rendered.layout);
      const parsedPdf = await extractPdfText(rendered.buffer);
      const pdfIssues = [
        ...visual.issues,
        ...validatePdfLayout(parsedPdf.text, parsedPdf.numpages).issues,
        ...findPdfSafeMarginIssues(parsedPdf.pages, rendered.layout),
        ...findPdfTextFidelityIssues(parsedPdf.text, rendered.spec, newContact),
      ];
      if (pdfIssues.length > 0) {
        return reply.status(422).send({ error: 'Litos could not refresh this resume’s header without breaking its one-page layout.', issues: pdfIssues });
      }

      const requestedKey = `users/${userId}/resumes/${row.id}-contact-refresh-${randomUUID()}.pdf`;
      let blob: Awaited<ReturnType<typeof putObject>>;
      try {
        blob = await putObject(requestedKey, rendered.buffer, { contentType: 'application/pdf' });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: 'Failed to store the refreshed resume' });
      }

      const now = new Date().toISOString();
      /* A refresh that left status at ready_for_final_approval would leave the applicant approving
       * a preview of a packet whose PDF just changed underneath her - verifyCurrentPacketAudit
       * already answers packet_stale for the swapped object key (see this route's comment above),
       * but the STATUS also has to move off the approval screen, the same move PATCH
       * /applications/:id/resume makes for every edit it starts from, or the dashboard is left
       * offering to approve and send a picture nobody has reviewed. Every other status this route
       * reaches keeps its status exactly as it was: a phone, a residence or a link is not a
       * question answer and does not invalidate one. */
      const statusAfterRefresh = review.status === 'ready_for_final_approval'
        ? (review.questions.length > 0 ? 'questions_ready' as const : 'ready_to_submit' as const)
        : review.status;
      // Through settleStall like every other _review writer in this file - a no-op for every status
      // this route reaches, since none of them are needs_attention with an open stall, but the rule
      // is "every writer", not "every writer that currently needs it".
      const finalReview = settleStall({ ...review, status: statusAfterRefresh, updated_at: now });
      const updatedSpec = {
        // rendered.spec, NOT stored: this is the content that actually produced these PDF bytes,
        // and it is what pdfGenerationBindingIsCurrent recomputes specSha256 from on every later
        // read. Storing the pre-render spec here while binding to the rendered one is how a header
        // that trims a bullet fails closed as PACKET_PDF_INVALID - "Generate it again" - on a
        // packet nothing was wrong with.
        ...rendered.spec,
        _contact: newContact,
        // Every stored key this route does not recompute, from the one list that names them - see
        // preservedApplicationSpecKeys. Before _review and _quality because those two ARE
        // recomputed and have to win.
        ...preservedApplicationSpecKeys(stored),
        _quality: {
          ...(stored._quality as Record<string, unknown> | undefined),
          pdfGenerationBinding: createPdfGenerationBinding(rendered.spec, blob.pathname, rendered.buffer, newContact.email ?? ''),
        },
        _review: finalReview,
      };

      const runContactRefreshTransaction = (database: typeof db) => database.transaction(async (tx) => {
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
        // The same artifact-version carry the edit route above performs, so the canonical artifact
        // table - which prepareManagedApplication's own-candidate check reads independently of
        // generated_resumes - never falls out of step with the object key this write just moved.
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
        updated = await withAuthorityRevisionRetry(() => withReadOnlyRetry(
          () => runContactRefreshTransaction(db),
          {
            onRetry: (attempt) => request.log.warn(
              { attempt, applicationId: row.id },
              'Contact refresh transaction reached a read-only backend; retrying on a fresh pooled connection',
            ),
            onExhausted: () => withDedicatedDatabase((directDb) => {
              request.log.warn(
                { applicationId: row.id },
                'Contact refresh pooled transactions stayed read-only; retrying on the direct database endpoint',
              );
              return runContactRefreshTransaction(directDb);
            }),
          },
        ), {
          onRetry: (attempt) => request.log.warn(
            { attempt, applicationId: row.id },
            'Contact refresh transaction hit the authority revision guard; retrying the whole transaction',
          ),
        });
      } catch (error) {
        await deleteObjects(blob.pathname).catch(() => undefined);
        throw error;
      }
      if (updated.length === 0) {
        await deleteObjects(blob.pathname).catch(() => undefined);
        return reply.status(409).send({ error: 'The application state changed before the contact refresh finished' });
      }

      return reply.send({
        application_id: row.id,
        review: finalReview,
        contact: { before: fullContact, after: newContact },
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
      /* Same authority guard, same reading as the two save routes below: a 40001 out of this
       * statement's BEFORE trigger means nothing was written, so retry it unchanged - CAS predicate
       * included, which is what keeps a retry from landing on a run's committed work - and read a
       * window that never clears as this edit not having landed. That is the 202 below. */
      const claimed = await conditionalWriteRows(() => db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
        ))
        .returning({ id: generated_resumes.id }), {
        onRetry: (attempt) => request.log.warn(
          { applicationId: row.id, attempt },
          'review edit hit the authority revision guard; retrying',
        ),
        onLostToGuard: () => request.log.warn(
          { applicationId: row.id },
          'review edit lost the authority revision guard for its whole window; answering 202',
        ),
      });
      if (claimed.length === 0) {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const responseReview = readApplicationReview(refreshed.spec) ?? current;
        return reply.status(202).send({
          application_id: row.id,
          review: reviewWithoutPassiveHandoffUrl(responseReview),
          manual_handoff_available: manualHandoffAvailable(responseReview),
          ...(await unattemptedPacketSubmissionAuthority(request.jwtPayload!.userId, row.id, responseReview.status, request.log)),
        });
      }
      return reply.send({
        application_id: row.id,
        review: next,
        ...(await unattemptedPacketSubmissionAuthority(request.jwtPayload!.userId, row.id, next.status, request.log)),
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
        /* THE REFUSAL THAT WAS RIGHT AND NAMED NO WAY OUT, WHICH THIS ROUTE'S NEIGHBOUR ALREADY
         * CALLS A BUG IN ITSELF.
         *
         * Measured live 2026-09-04, account mehekmandal05@gmail.com: Flow Traders packet
         * 8dc65cd0-cab5-4af2-a1d8-2583766fd2d4 (greenhouse) at ready_for_final_approval. The
         * dashboard drew "Answer 1 question", opened the editor with the essay in it, took her
         * typing, and every Save came back with the sentence below. The essay contained a factual
         * error. Nothing in the response said where a correction could go, so from the client there
         * was no difference between "this cannot be edited here" and "this cannot be edited".
         *
         * THE REFUSAL DOES NOT MOVE. reviewAnswerSaveDisposition is correct for this status and its
         * reason is the one written above it: the form is filled and there is a preview screenshot
         * of it, and this route writes answers "and nothing else", so a save through it would leave
         * the picture the applicant approves describing a different form. That is the invariant, and
         * widening the state set here would break it rather than serve her.
         *
         * WHAT IS ADDED IS THE EXIT, and it is the one that already exists. preparedRunCanRestart
         * admits exactly this shape - ready_for_final_approval with no claim - and
         * POST /applications/:id/submit-request with `restart: true` takes the corrected answers in
         * its body, discards the filled form, fills it again FROM them and takes a fresh preview. So
         * the answers and the picture move together in one request, which is the invariant honoured
         * rather than spent. Said in the same shape submit-request's own 409 uses for the same door
         * (see PREPARED_RUN_RESTARTABLE), so a client learns the route from either side.
         *
         * The code stays REVIEW_ANSWERS_NOT_EDITABLE and the status stays 409: this IS still a
         * refusal of this route, and clients keying on either must not see it turn into a success.
         * `restart_with_answers` is additive, and the generic sentence is untouched for every other
         * refusal - a packet at the employer has no exit and must not be handed one. */
        const restartWithAnswers = preparedRunCanRestart(
          current.status,
          Boolean(current.submission_claimed_at),
        ) && !employerMayHoldApplication(current);
        return reply.status(409).send(restartWithAnswers
          ? {
            error: 'This application’s form is already filled in and waiting for you to look it over, '
              + 'so its answers cannot be edited in place - a new answer underneath the filled form '
              + 'would leave the preview you approve describing something else. To correct one, POST '
              + '/applications/:id/submit-request with the corrected questions and restart true: '
              + 'Litos will throw that filled form away, fill it again from your answers and show you '
              + 'a fresh preview.',
            code: 'REVIEW_ANSWERS_NOT_EDITABLE',
            restart_with_answers: true,
            run_revision: current.run_revision ?? null,
          }
          : {
            error: 'These answers can no longer be edited from this application’s current submission state',
            code: 'REVIEW_ANSWERS_NOT_EDITABLE',
            restart_with_answers: false,
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
      const answersSaveProfile = await loadSensitiveQuestionProfile(request.jwtPayload!.userId);
      const resolverAnswerFor = knownAnswerLookup(
        answersSaveProfile,
        current.jd_text,
        postingCountryFromJobContext(row.job_context),
        postingCountryCodeFromJobContext(row.job_context),
      );
      /* AND THE SNAPPED HALF OF THE SAME RESOLUTION, because the paragraph above is right about the
       * mechanism and named only half of the strings it produces. What the screen displays is
       * resolveProfileField's output - the resolver's value written in the employer's own option
       * text - and knownAnswerLookup answers the value BEFORE that snap. So a control offering
       * "Woman" against a profile that says "Female" rendered "Woman", the body echoed it, and the
       * merge read an edit. See machineAnswerLookup for the packet this was measured on. */
      const machineAnswerFor = machineAnswerLookup(
        answersSaveProfile,
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
        machineAnswerFor,
      );
      const next: ApplicationReviewState = {
        ...current,
        questions: merged,
        questions_reviewed_at: reviewedAt,
        updated_at: new Date().toISOString(),
      };
      /* THE OTHER WAY THIS SAVE LOSES THE RACE, and until now it was the only one that reached the
       * applicant as a crash.
       *
       * The zero-row branch below is one half of "a run wrote to this packet". The other half never
       * gets that far: the submission-authority revision guard fires from a BEFORE trigger on this
       * very statement, takes the per-user advisory lock with pg_try_advisory_xact_lock - TRY, never
       * wait - and RAISES 40001 the moment anything else on the account holds it. A managed run
       * holds it for the length of its transaction; the dashboard's own 2.5-second poll holds it for
       * a few milliseconds while it reads the authority projection. So the applicant typing on the
       * answer-confirmation screen the send flow opens FOR her, while her run works the packet, is
       * the single most likely person in the product to hit it.
       *
       * MEASURED LIVE 2026-09-04, account mehekmandal05@gmail.com, Exa packet 73768339: this save
       * answered 500 carrying the raw UPDATE and its bound parameters, the dashboard printed
       * "Internal Server Error", and the identical save answered 200 the moment the run finished.
       *
       * Retried, then answered as what it is. The retry re-runs THIS statement unchanged, exact-spec
       * predicate and all, so it cannot overwrite whatever the run recorded: if the run only held
       * the lock the save lands, and if the run committed, the predicate matches nothing and the
       * branch below runs. If the guard is still held after the whole window, the save did not land,
       * and this route already has the honest word for that - a 202 carrying `saved: false`, which
       * the dashboard renders as "Litos was working on this application while you were typing, so
       * these answers were not saved. They are still on this screen, so try again." Every clause of
       * that is true of a guard conflict, and a 500 was true of none of it. */
      const saved = await conditionalWriteRows(() => db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
        ))
        .returning({ id: generated_resumes.id }), {
        onRetry: (attempt) => request.log.warn(
          { applicationId: row.id, attempt },
          'review answers save hit the authority revision guard; retrying',
        ),
        onLostToGuard: () => request.log.warn(
          { applicationId: row.id },
          'review answers save lost the authority revision guard for its whole window; answering 202',
        ),
      });
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
      /* Same guard, same answer as the answers route above: the authority revision trigger raises
       * 40001 rather than waiting, so a poll or a run holding the per-user lock would otherwise turn
       * a checkbox into a 500. Retried unchanged - the exact-spec predicate rides along, so the
       * retry cannot land on top of a run's write - and a window that never clears means the tick
       * did not land, which is exactly what the 202 below says. */
      const saved = await conditionalWriteRows(() => db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
        ))
        .returning({ id: generated_resumes.id }), {
        onRetry: (attempt) => request.log.warn(
          { applicationId: row.id, attempt },
          'attention acknowledgement hit the authority revision guard; retrying',
        ),
        onLostToGuard: () => request.log.warn(
          { applicationId: row.id },
          'attention acknowledgement lost the authority revision guard for its whole window; answering 202',
        ),
      });
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

  /**
   * HER OWN WORD THAT A POSTING PAST ITS STATED DEADLINE STILL ACCEPTS APPLICATIONS.
   *
   * The one action that can turn a 'deadline_passed' posting_status back into a sendable review -
   * see postingStatusBlocksSend and derivePostingDeadlineStatus. Deliberately narrow: it writes
   * exactly one timestamp (posting_confirmed_open_at) and nothing else, so the actual "is this
   * safe to send" question is answered fresh, every time, by re-deriving posting_status from it -
   * never by trusting a snapshot minted at confirmation time that a later read could disagree with.
   *
   * REFUSED FOR A 'closed' TAKE-DOWN, on purpose. There is no confirmation route for one: Litos
   * does not ask her to override what the employer's own missing posting already proved, the way
   * it does ask for a stated deadline that Workable (Mercari's own case) may still be honouring.
   * Also refused when neither derivation finds anything to confirm - most often because she is
   * confirming a packet that has since gone back to normal on its own (the parsed deadline moved,
   * or the posting text changed), in which case there is nothing left for this to do.
   */
  fastify.post(
    '/applications/:id/posting-status/confirm-open',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const current = readApplicationReview(row.spec as StoredSpec);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      const todaysVerdict = derivePostingDeadlineStatus(await repairReviewPortalFromMonitoredJob(row, current));
      if (todaysVerdict.posting_status?.state !== 'deadline_passed') {
        return reply.status(409).send({
          error: 'This application has no stated deadline waiting on your confirmation.',
          code: 'posting_status_not_confirmable',
        });
      }
      const next = applyReviewPatch(current, {
        posting_confirmed_open_at: new Date().toISOString(),
      });
      const saved = await conditionalWriteRows(() => db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
        ))
        .returning({ id: generated_resumes.id }), {
        onRetry: (attempt) => request.log.warn(
          { applicationId: row.id, attempt },
          'posting-status confirm-open hit the authority revision guard; retrying',
        ),
        onLostToGuard: () => request.log.warn(
          { applicationId: row.id },
          'posting-status confirm-open lost the authority revision guard for its whole window; answering 202',
        ),
      });
      if (saved.length === 0) {
        // Same discriminator as attention-acks and the answers route: a run wrote under this
        // confirmation, so it did not land and must not be retried blind against a fresher report.
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({ application_id: row.id, review: review ?? current, saved: false });
      }
      return reply.send({
        application_id: row.id,
        review: derivePostingDeadlineStatus(await repairReviewPortalFromMonitoredJob(row, next)),
        saved: true,
      });
    },
  );

  fastify.post(
    '/applications/:id/submit-request',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = submitBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid answers', detail: parsed.error.issues });
      /* The second half of the expired-handoff trap. submitRequestDisposition rightly refuses a
       * claimed needs_attention row, and its only key - the applicant's own 'not_sent' answer -
       * exists only for runs whose press outcome was unknown. A run that parked at an attended
       * handoff BEFORE pressing has no unverified record, so there is no question to answer and
       * this route refused it forever. The repair releases the claim only on the row's own proof
       * that nothing was pressed and the attended window is over; the disposition below then reads
       * the released row and answers 'start' the ordinary way, with every other gate intact. */
      row = await repairExpiredAttendedHandoffClaim(row, request.jwtPayload!.userId, request.log) ?? row;
      row = await repairStalledFillRun(row, request.jwtPayload!.userId, request.log) ?? row;
      const stored = row.spec as StoredSpec;
      let current = readApplicationReview(stored);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      current = await repairReviewPortalFromMonitoredJob(row, current);
      if (monitoredPortalProofUnavailable(row, current)) {
        return reply.status(409).send({
          error: 'Current verified posting not found',
          code: 'job_not_available',
        });
      }
      /* THE POSTING ITSELF REFUSES A SEND HERE, before a claim is minted or a browser is booked -
       * the fast, synchronous half of the same refusal prepare() in submissionRunner.ts repeats as
       * its own last line of defense for any caller that reaches a run without going through this
       * route (a retried unattended cycle, a security-code continuation). A take-down never clears;
       * a stated deadline clears the moment she confirms the employer still accepts applications
       * through POST /applications/:id/posting-status/confirm-open. */
      current = derivePostingDeadlineStatus(current);
      if (postingStatusBlocksSend(current)) {
        return reply.status(409).send({
          error: current.attention_reason
            ?? 'This posting is no longer accepting applications through Litos.',
          code: 'posting_not_sendable',
          posting_status: current.posting_status,
        });
      }
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
        return reply.status(200).send({ application_id: row.id, review: current, cover_letter: storedCoverLetter(row) });
      }
      if (disposition === 'in_flight') {
        return reply.status(202).send({ application_id: row.id, review: current, cover_letter: storedCoverLetter(row) });
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
      /* THE REFUSAL BELOW IS ALLOWED TO SAY "pressed Send" ONLY IF THE LEDGER SAYS SO.
       *
       * This is the second surface that asserted a press with nothing behind it but the presence of
       * an unverified_submission record - the first being unverifiedSubmissionReason, which wrote
       * the record's own sentence. Both are answered from the same fact, reduced the way
       * duplicateApplication.ts already reduces it, so the refusal and the row cannot disagree.
       *
       * Read only when the record exists and is unresolved, which is the one branch that says it,
       * so an ordinary refusal still costs no query. */
      const unresolvedUnverified = Boolean(
        current.unverified_submission && !current.unverified_submission.resolution,
      );
      const unverifiedNeverPressed = unresolvedUnverified && current.submission_claim_id
        ? attemptNeverReachedEmployer(
          (await submissionAttemptEventsForPacket(request.jwtPayload!.userId, row.id))
            .filter((event) => event.attempt_id === current.submission_claim_id),
        )
        : false;
      if (disposition === 'reject' && !(restartable && parsed.data.restart === true)) {
        return reply.status(409).send(restartable
          ? {
            error: 'This application is already filled and waiting for you to look it over. '
              + 'Ask again with restart to discard that filled form and fill it again.',
            code: 'PREPARED_RUN_RESTARTABLE',
            restartable: true,
            run_revision: current.run_revision ?? null,
          }
          /* A REFUSAL THAT SAYS WHY, when the thing holding this packet is an unresolved submit.
           *
           * The generic sentence below is the one Skydio packet 13bccb2d would have got: the
           * applicant was told by attention_reason to check the portal and try again, and trying
           * again returned "cannot start another submission run from its current state" with no
           * cause and no exit. The refusal is correct - the employer may already hold this
           * application - but a correct refusal that names neither the reason nor the way out is
           * indistinguishable from a bug. */
          : unresolvedUnverified
            ? {
              error: unverifiedNeverPressed
                ? 'Litos opened an attempt on this one and stopped before pressing Send, so it will '
                  + 'not start another until that attempt is closed. There is nothing to check on the '
                  + 'employer’s page. Answer POST /applications/:id/submission/unverified with found '
                  + 'false and Litos will record that nothing was sent and send this one for you.'
                : 'Litos pressed Send on this one and could not confirm what came back, so it will '
                  + 'not send it a second time until you have looked. Open the employer’s page, then tell '
                  + 'Litos whether the application is there: POST /applications/:id/submission/unverified '
                  + 'with found true or false. If it is not there, Litos will send this one for you.',
              code: 'SUBMISSION_OUTCOME_UNVERIFIED',
              restartable: false,
              unverified_submission: current.unverified_submission,
            }
          : {
            error: 'This application cannot start another submission run from its current state',
            code: 'SUBMISSION_RUN_NOT_RESTARTABLE',
            restartable: false,
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
        return reply.status(409).send(duplicateRiskResponse(duplicateVerdict));
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
      const questionGate = submissionQuestionGate({
        questions: canonicalSubmittedQuestions,
        question_metadata_blockers: current.question_metadata_blockers,
      });
      if (sendsWithoutAnotherRun && questionGate.metadataBlockerCount > 0) {
        return reply.status(422).send({
          error: 'Litos could not read complete employer question metadata, so it did not email this application.',
          code: 'QUESTION_METADATA_INCOMPLETE',
          count: questionGate.metadataBlockerCount,
        });
      }
      if (sendsWithoutAnotherRun && questionGate.requiredQuestionLabels.length > 0) {
        /* Two sentences over one list. A blank box wants an answer; a paragraph Litos drafted is
           already written and wants a read, so saying "answer it" sends her looking for a field
           that is not empty. Same stop and same list either way. */
        return reply.status(422).send({
          error: questionGate.draftQuestionLabels.length > 0
            ? 'Approve or change the answers Litos drafted for you, and answer every required question, before submitting.'
            : 'Answer every required question before submitting.',
          questions: questionGate.requiredQuestionLabels,
        });
      }
      if (sendsWithoutAnotherRun && questionGate.optionalQuestionLabels.length > 0) {
        return reply.status(422).send({
          error: 'Choose Answer or Skip for every optional question before submitting.',
          code: 'OPTIONAL_QUESTION_DECISION_REQUIRED',
          questions: questionGate.optionalQuestionLabels,
        });
      }
      const submitEducationIssues = packetEducationDrift(stored, submitProfileRows[0]?.parsed_json);
      if (submitEducationIssues.length > 0) {
        return reply.status(422).send(educationDriftResponse(submitEducationIssues));
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
        });
      }
      const sensitive = sensitiveQuestionFor(
        canonicalSubmittedQuestions, sensitiveProfile, current.jd_text,
        postingCountryFromJobContext(row.job_context),
        postingCountryCodeFromJobContext(row.job_context),
        /* submittedReviewedAt, NOT current.questions_reviewed_at. canonicalSubmittedQuestions is
         * built as { ...current, questions_reviewed_at: submittedReviewedAt } and its answers are
         * stamped answer_reviewed_at: submittedReviewedAt, which resolveSubmittedApplicationAnswers
         * mints fresh when the packet has no prior round. Passing the stored value hands this gate
         * undefined for exactly those packets, so every answer reads as unreviewed and the gate
         * refuses an answer she just supplied. Lines below pass submittedReviewedAt alongside this
         * same question array for the same reason. */
        submittedReviewedAt,
      );
      // A supported portal needs the browser run to discover and surface the live form's
      // declarations. Blocking that run on the pre-run snapshot creates a deadlock: the question
      // cannot be answered until the form has been inspected, but inspection never starts. The
      // unsupported path below has no intervening fill and emails the employer immediately, so it
      // remains a send gate here. Final approval and direct browser submission retain their own
      // post-discovery gates.
      if (current.portal_url && !isPortalSupported(current.portal_url) && sensitive) {
        // Same envelope as the submit-request refusal above, for the same client handler.
        return reply.status(422).send({
          error: `Sensitive question requires your attention: ${sensitive.question.slice(0, 120)}`,
          code: 'SENSITIVE_QUESTION_CONFIRMATION_REQUIRED',
          questions: [sensitive.question],
        });
      }
      const submitAudit = await currentAcknowledgedPacketAudit(row, {
        questions: canonicalSubmittedQuestions,
        restoreExpiredResume: 'authorizing_send',
      });
      if (!submitAudit.valid) {
        return reply.status(409).send(packetAuditClientError(submitAudit));
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
        const base = freshSubmitRequestReview(current, canonicalSubmittedQuestions, submittedReviewedAt);
        const claimId = randomUUID();
        const pending: ApplicationReviewState = {
          ...base,
          status: 'submitting',
          ...submissionClaimPatch(authorizedAt, claimId),
          updated_at: authorizedAt,
          submission_authorization: current.submission_authorization ?? {
            source: 'per_application_approval',
            authorized_at: authorizedAt,
          },
        };
        const packetRow = {
          ...row,
          spec: { ...(row.spec as StoredSpec), _review: pending },
        };
        const packet = await buildPacket(packetRow, false, canonicalSubmittedQuestions);
        const preparedEmail = prepareUnsupportedPortalApplicationEmail({
          application: packetRow,
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
        await transportVerifiedBuiltPacket(
          packet,
          submitAudit.audit,
          canonicalSubmittedQuestions,
          async () => undefined,
          'full',
          envelope,
        );
        const reservation = await db.transaction(async (tx) => {
          await lockSubmissionAttemptUser(tx, request.jwtPayload!.userId);
          const [latest] = await tx.select().from(generated_resumes).where(and(
            eq(generated_resumes.id, row.id),
            eq(generated_resumes.user_id, request.jwtPayload!.userId),
          )).limit(1).for('update');
          const latestReview = latest ? readApplicationReview(latest.spec) : null;
          if (!latest || !latestReview
            || !isDeepStrictEqual(latest.spec, row.spec)
            || latest.resume_object_key !== row.resume_object_key
            || !isDeepStrictEqual(latest.job_context, row.job_context)
            || latestReview.status !== current.status) return { kind: 'changed' as const };
          const latestQuestionGate = submissionQuestionGate({
            questions: canonicalSubmittedQuestions,
            question_metadata_blockers: latestReview.question_metadata_blockers,
          });
          if (!latestQuestionGate.clear) {
            return { kind: 'questions_changed' as const, gate: latestQuestionGate };
          }
          const duplicate = await duplicateApplicationVerdict({
            userId: latest.user_id,
            applicationId: latest.id,
            jobContext: latest.job_context,
            portalUrl: latestReview.portal_url,
          }, tx);
          if (duplicate.kind !== 'clear') return { kind: 'duplicate_risk' as const, verdict: duplicate };
          const openedToday = await submissionAttemptsOpenedToday(latest.user_id, { executor: tx });
          if (!withinDailyCap(openedToday, dailySubmissionCap())) return { kind: 'cap' as const };
          const postingIdentity = freezePostingIdentity(latest.job_context, latestReview.portal_url);
          const canonicalApplication = await canonicalApplicationForNewPacketAttempt(tx, {
            userId: latest.user_id,
            packetId: latest.id,
            postingIdentity,
          });
          const [claimedRow] = await tx.update(generated_resumes)
            .set({ spec: reviewSpec(pending) })
            .where(and(
              eq(generated_resumes.id, latest.id),
              eq(generated_resumes.user_id, latest.user_id),
              sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
              sql`${generated_resumes.resume_object_key} is not distinct from ${latest.resume_object_key}`,
              sql`${generated_resumes.job_context} is not distinct from ${JSON.stringify(latest.job_context ?? null)}::jsonb`,
              sql`${generated_resumes.spec}->'_review'->>'status' = ${latestReview.status}`,
              sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null`,
            ))
            .returning();
          if (!claimedRow) return { kind: 'changed' as const };
          const binding: SubmissionAttemptBinding = {
            attemptId: claimId,
            userId: latest.user_id,
            packetId: latest.id,
            applicationId: canonicalApplication.id,
            parentAttemptId: null,
            source: 'unsupported_email',
            operation: 'initial_submission',
            postingIdentity,
            submissionRunId: pending.submission_run_id ?? null,
            submissionClaimId: claimId,
            packetVersion: submitAudit.audit.packet_version,
          };
          await appendSubmissionAttemptEvent({
            ...binding,
            eventId: submissionAttemptEventId(claimId, 'attempt_opened', 'reservation'),
            eventKind: 'attempt_opened',
            evidenceCode: 'atomic_email_claim_reserved',
            observedAt: new Date(authorizedAt),
          }, { executor: tx });
          const authorization = await authorizeFinalSubmissionBoundary(binding, {
            executor: tx,
            factKey: 'unsupported-email-boundary',
            evidenceCode: 'unsupported_email_employer_boundary_authorized',
          });
          if (authorization.kind !== 'fresh') {
            throw new Error('UNSUPPORTED_EMAIL_BOUNDARY_AUTHORIZATION_CONFLICT');
          }
          return { kind: 'reserved' as const, row: claimedRow, binding };
        });
        if (reservation.kind === 'changed') {
          const refreshed = await ownedResume(request, reply);
          if (!refreshed) return;
          return reply.status(202).send({
            application_id: row.id,
            review: readApplicationReview(refreshed.spec) ?? current,
          });
        }
        if (reservation.kind === 'duplicate_risk') {
          return reply.status(409).send(duplicateRiskResponse(reservation.verdict));
        }
        if (reservation.kind === 'cap') {
          return reply.status(429).send({ error: 'Daily automatic submission safety limit reached' });
        }
        if (reservation.kind === 'questions_changed') {
          return reply.status(422).send({
            error: 'Application questions changed before the email capability could be opened.',
            code: 'APPLICATION_QUESTIONS_CHANGED',
            gate: reservation.gate,
          });
        }
        await db.transaction(async (tx) => {
          await lockSubmissionAttemptUser(tx, reservation.binding.userId);
          const [dispatchRow] = await tx.select().from(generated_resumes).where(and(
            eq(generated_resumes.id, reservation.binding.packetId),
            eq(generated_resumes.user_id, reservation.binding.userId),
          )).limit(1).for('update');
          const dispatchReview = dispatchRow ? readApplicationReview(dispatchRow.spec) : null;
          if (!dispatchRow
            || !dispatchReview
            || dispatchReview.status !== 'submitting'
            || dispatchReview.submission_claim_id !== reservation.binding.attemptId) {
            throw new Error('UNSUPPORTED_EMAIL_ATTEMPT_NOT_DISPATCHABLE');
          }
          const events = (await submissionAttemptEventsForPacket(
            reservation.binding.userId,
            reservation.binding.packetId,
            { executor: tx },
          )).filter((event) => event.attempt_id === reservation.binding.attemptId);
          if (!events.some((event) => event.event_kind === 'attempt_opened')
            || !events.some((event) => event.event_kind === 'boundary_authorized')
            || events.some((event) => event.event_kind === 'press_observed'
              || event.event_kind === 'submission_confirmed'
              || event.event_kind === 'not_sent_proven')) {
            throw new Error('UNSUPPORTED_EMAIL_ATTEMPT_NOT_DISPATCHABLE');
          }
          await appendSubmissionAttemptEvent({
            ...reservation.binding,
            eventId: submissionAttemptEventId(
              reservation.binding.attemptId,
              'press_observed',
              'unsupported-email-dispatch',
            ),
            eventKind: 'press_observed',
            evidenceCode: 'unsupported_email_dispatch_started',
          }, { executor: tx });
        });
        let sent: { messageId: string; recipient: string };
        try {
          sent = await sendPreparedUnsupportedPortalApplicationEmail(preparedEmail);
        } catch (error) {
          request.log.warn({ error, applicationId: row.id }, 'Unsupported portal email outcome is unverified');
          const failedAt = new Date().toISOString();
          await db.transaction(async (tx) => {
            await lockSubmissionAttemptUser(tx, reservation.binding.userId);
            const [latest] = await tx.select().from(generated_resumes).where(and(
              eq(generated_resumes.id, reservation.binding.packetId),
              eq(generated_resumes.user_id, reservation.binding.userId),
            )).limit(1).for('update');
            const latestReview = latest ? readApplicationReview(latest.spec) : null;
            if (!latest || !latestReview
              || latestReview.submission_claim_id !== reservation.binding.attemptId) return;
            const uncertain = applyReviewPatch(latestReview, {
              status: 'needs_attention',
              submission_attempted_at: failedAt,
              submission_error: 'The email provider response was not verified.',
              attention_reason: 'Litos started the employer email request but could not verify the provider response. Check for a receipt before deciding whether to send again.',
              attention_categories: ['unverified_submission'],
              unverified_submission: {
                at: failedAt,
                cause: 'provider_error',
                ...(latestReview.portal_url ? { portal_url: latestReview.portal_url } : {}),
                ...(latestReview.submission_run_id
                  ? { submission_run_id: latestReview.submission_run_id }
                  : {}),
              },
            }, () => failedAt);
            await tx.update(generated_resumes).set({ spec: reviewSpec(uncertain) }).where(and(
              eq(generated_resumes.id, latest.id),
              eq(generated_resumes.user_id, latest.user_id),
              sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
            ));
          });
          return reply.status(503).send({
            error: 'The employer email result is unverified. Check for a receipt before trying again.',
            code: 'UNSUPPORTED_PORTAL_EMAIL_OUTCOME_UNVERIFIED',
          });
        }
        const submittedAt = new Date().toISOString();
        const confirmationText = unsupportedEmailConfirmationText(sent);
        const confirmationEvidenceCode = unsupportedEmailConfirmationEvidenceCode(sent);
        const committed = await db.transaction(async (tx) => {
          await lockSubmissionAttemptUser(tx, reservation.binding.userId);
          const [latest] = await tx.select().from(generated_resumes).where(and(
            eq(generated_resumes.id, reservation.binding.packetId),
            eq(generated_resumes.user_id, reservation.binding.userId),
          )).limit(1).for('update');
          const latestReview = latest ? readApplicationReview(latest.spec) : null;
          if (!latest || !latestReview
            || latestReview.submission_claim_id !== reservation.binding.attemptId
            || latestReview.status !== 'submitting') return false;
          const events = (await submissionAttemptEventsForPacket(
            latest.user_id,
            latest.id,
            { executor: tx },
          )).filter((event) => event.attempt_id === reservation.binding.attemptId);
          if (!events.some((event) => event.event_kind === 'press_observed')) {
            throw new Error('UNSUPPORTED_EMAIL_DISPATCH_EVIDENCE_MISSING');
          }
          const receiptFinalUrl = reservation.binding.postingIdentity.portalUrl;
          if (!receiptFinalUrl) throw new Error('UNSUPPORTED_EMAIL_POSTING_URL_MISSING');
          const next: ApplicationReviewState = {
            ...latestReview,
            status: 'submitted',
            updated_at: submittedAt,
            submitted_at: submittedAt,
            submission_error: undefined,
            attention_reason: undefined,
            attention_categories: undefined,
            unverified_submission: undefined,
            receipt: {
              confirmation_text: confirmationText,
              final_url: receiptFinalUrl,
              captured_at: submittedAt,
              reference_id: sent.messageId,
              source: 'email_fallback',
            },
          };
          await appendSubmissionAttemptEvent({
            ...reservation.binding,
            eventId: submissionAttemptEventId(
              reservation.binding.attemptId,
              'submission_confirmed',
              'unsupported-email-provider-result',
            ),
            eventKind: 'submission_confirmed',
            evidenceCode: confirmationEvidenceCode,
            observedAt: new Date(submittedAt),
          }, { executor: tx });
          const [updated] = await tx.update(generated_resumes)
            .set({
              spec: reviewSpec(next),
              pipeline_stage: 'applied',
              pipeline_stage_at: new Date(submittedAt),
            })
            .where(and(
              eq(generated_resumes.id, latest.id),
              eq(generated_resumes.user_id, latest.user_id),
              sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
              sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${reservation.binding.attemptId}`,
              sql`${generated_resumes.spec}->'_review'->>'status' = 'submitting'`,
            ))
            .returning({ id: generated_resumes.id });
          if (!updated) throw new Error('UNSUPPORTED_EMAIL_CONFIRMATION_WRITE_CONFLICT');
          await syncCanonicalApplicationRow({
            attemptId: reservation.binding.attemptId,
            packetId: latest.id,
            userId: latest.user_id,
            applicationId: reservation.binding.applicationId,
            packetVersion: reservation.binding.packetVersion,
            postingIdentity: reservation.binding.postingIdentity,
          }, tx);
          const canonicalId = reservation.binding.applicationId;
          if (!canonicalId) throw new Error('UNSUPPORTED_EMAIL_CANONICAL_APPLICATION_MISSING');
          const projections = await authoritativeSubmissionProjection({
            userId: latest.user_id,
            packetIds: [latest.id],
            applicationIds: [canonicalId],
            executor: tx,
          });
          const exact = {
            attemptId: reservation.binding.attemptId,
            canonicalApplicationId: canonicalId,
            packetId: latest.id,
          };
          if (!authoritativeConfirmedProjectionMatches(projections.byPacketId.get(latest.id), exact)
            || !authoritativeConfirmedProjectionMatches(projections.byApplicationId.get(canonicalId), exact)) {
            throw new Error('UNSUPPORTED_EMAIL_CONFIRMATION_PROJECTION_INCOMPLETE');
          }
          return next;
        });
        if (!committed) {
          return reply.status(409).send({
            error: 'The application state changed after the email provider accepted it. Do not send it again.',
            code: 'UNSUPPORTED_PORTAL_EMAIL_CONFIRMATION_CONFLICT',
          });
        }
        const [refreshed] = await db.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
        )).limit(1);
        const responseRow = refreshed ?? {
          ...reservation.row,
          spec: { ...(reservation.row.spec as StoredSpec), _review: committed },
        };
        return reply.status(202).send({
          application_id: row.id,
          review: readApplicationReview(responseRow.spec) ?? committed,
          cover_letter: storedCoverLetter(responseRow),
        });
      }
      const controlledTest = process.env.LITOS_ENABLE_TEST_PORTAL === 'true'
        && current.portal_url
        && detectPortal(current.portal_url) === 'controlled_test';
      if (!controlledTest && !isBrowserbaseConfigured()) {
        return reply.status(503).send({
          error: 'Litos cannot fill in company pages yet.',
          code: 'PORTAL_RUNNER_NOT_CONFIGURED',
        });
      }
      const next = freshSubmitRequestReview(current, canonicalSubmittedQuestions, submittedReviewedAt);
      /* The revision guard behind this write's trigger try-locks the per-user advisory lock and
       * raises "retry the request" (40001) instead of waiting, so this claim fails whenever an
       * authority projection read - a dashboard poll, a history load - holds the lock for a few
       * milliseconds. Observed live 2026-09-01: this exact statement 500'd and the applicant's run
       * reported failed. The raise aborts the statement before anything commits, and the status
       * guard makes a rerun land in the designed contention path, so retrying here is safe. */
      const claimed = await withAuthorityRevisionRetry(() => db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
        ))
        .returning({ id: generated_resumes.id }), {
        onRetry: (attempt) => request.log.warn(
          { applicationId: row.id, attempt },
          'submit-request claim hit the authority revision guard; retrying',
        ),
      });
      if (claimed.length === 0) {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({
          application_id: row.id,
          review: review ?? current,
          ...(await unattemptedPacketSubmissionAuthority(request.jwtPayload!.userId, row.id, (review ?? current).status, request.log)),
        });
      }
      const processed = await processSubmissionApplication(row.id, fastify);
      const [refreshed] = await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, request.jwtPayload!.userId),
      )).limit(1);
      const responseRow = refreshed ?? row;
      const responseReview = readApplicationReview(responseRow.spec) ?? processed ?? next;
      return reply.status(202).send({
        application_id: row.id,
        review: reviewWithoutPassiveHandoffUrl(responseReview),
        manual_handoff_available: manualHandoffAvailable(responseReview),
        cover_letter: storedCoverLetter(responseRow),
        /* Not only the contention 202 above: a run can end here having opened NO attempt at all - a
         * packet-drift hold parks the row `needs_attention` before the atomic claim, with the
         * ledger still empty (observed live 2026-09-01 on packet f04623c3: projection `none`,
         * retry safety `no_evidence`, after "how Litos reaches this employer" drift). The dashboard
         * installs THIS response as its submission state, so without the envelope the next approve
         * quarantines a packet the ledger says was never attempted. The helper's own status gate
         * and none/no_evidence rule keep every response for a genuinely opened attempt unchanged. */
        ...(await unattemptedPacketSubmissionAuthority(request.jwtPayload!.userId, row.id, responseReview.status, request.log)),
      });
    },
  );

  fastify.get(
    '/applications/:id/submission/channels',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let row = await ownedResume(request, reply);
      if (!row) return;
      row = await repairExpiredAttendedHandoffClaim(row, request.jwtPayload!.userId, request.log) ?? row;
      row = await repairStalledFillRun(row, request.jwtPayload!.userId, request.log) ?? row;
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
      row = await repairExpiredAttendedHandoffClaim(row, request.jwtPayload!.userId, request.log) ?? row;
      row = await repairStalledFillRun(row, request.jwtPayload!.userId, request.log) ?? row;
      let review = readApplicationReview(row.spec);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      review = await repairReviewPortalFromMonitoredJob(row, review);
      // The deadline half of the same projection - see resume.ts's withPostingDeadlineStatus for
      // why it has to run after the monitor's is_active repair rather than before it.
      review = derivePostingDeadlineStatus(review);
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
      if ((review.status === 'filling' || review.status === 'needs_attention') && review.browser_session_id) {
        const audit = await currentAcknowledgedPacketAudit(row, {
          // The response and this verdict must describe one snapshot. Re-resolving here could
          // validate Q2 while the response below displayed Q1 from the profile read above.
          questions: review.questions,
        });
        handoff_packet_valid = audit.valid;
      }
      /* THE READ-ONLY HALF OF THE CONTACT-REFRESH SIGNAL, so a client can offer the button on POST
       * /applications/:id/resume/contact-refresh only when it would do anything. `profile` above is
       * loadApplicationProfileLike's own shape (loadSensitiveQuestionProfile is a thin alias for
       * it), which is exactly what resumeContactStaleness and the refresh route both expect - one
       * profile read, one comparison function, shared by the signal and the write it describes. */
      const storedContactForStaleness = (row.spec && typeof row.spec === 'object' ? row.spec as Record<string, unknown> : {})._contact as {
        full_name?: string;
        email?: string;
        phone?: string;
        location?: string;
        linkedin_url?: string;
        github_url?: string;
        portfolio_url?: string;
      } | undefined;
      const resumeContactStale = storedContactForStaleness?.full_name
        ? resumeContactStaleness(
          { ...storedContactForStaleness, full_name: storedContactForStaleness.full_name },
          profile as Record<string, unknown>,
        )
        : null;
      return reply.send({
        application_id: row.id,
        review: reviewWithoutPassiveHandoffUrl(review),
        manual_handoff_available: handoff_packet_valid && manualHandoffAvailable(review),
        cover_letter: storedCoverLetter(row),
        // Keyed by kind, and built by the one reader that strips object_key. The spec holds the
        // Blob pointer because the packet builder needs it; this envelope must never carry it,
        // since a Blob object is public-read forever to anyone holding its URL.
        documents: storedDocuments(row),
        handoff_packet_valid,
        configured: isBrowserbaseConfigured(),
        // Present only when the header actually would change - see resumeContactStaleness. Absent
        // is the common case and must stay cheap to read: no PDF fetch, no packet audit, just the
        // one profile read this route already makes and a handful of string comparisons.
        ...(resumeContactStale ? { resume_contact_stale: resumeContactStale } : {}),
        /* THE QUESTIONS ONLY SHE CAN CLEAR, NAMED BEFORE SHE PRESSES SEND.
         *
         * Every send gate in this file refuses on these already, and until now that refusal existed
         * nowhere else: it was a sentence in a 422 body, after the press, naming one question and
         * offering no action. Packet 4a79eec1 sat blocked through three sessions on a question that
         * was answered, because nothing in the product ever said which question needed her or what
         * "needs you" meant for it.
         *
         * WHAT THE DASHBOARD MUST DO WITH IT. Each label here is a row on the answers screen that
         * must render as needing her, and its resolution is one request: PUT
         * /applications/:id/review/answers with that question carrying `confirmed: true` beside the
         * answer she is affirming. That flag is the only thing that clears this list, which is the
         * whole point - it is her word, not a value round-tripping through a save. A row already
         * carrying an answer needs the answer left as it is and confirmed; a blank one needs an
         * answer typed and confirmed in the same save.
         *
         * LABELS, NOT RECORDS. The full question objects are already in `review.questions` above;
         * repeating them would give the client two copies to disagree about. This says which. */
        sensitive_questions_requiring_confirmation: sensitiveQuestionsFor(
          review.questions,
          profile,
          review.jd_text,
          postingCountryFromJobContext(row.job_context),
          postingCountryCodeFromJobContext(row.job_context),
          /* THE SAME ROUND THE SEND GATE READS. Without it this surface lists a question the send
           * would let through - she answered it herself in this round - and the applicant is sent
           * to confirm something nothing is waiting on. A list that disagrees with the gate it
           * describes is worse than no list. */
          review.questions_reviewed_at,
        ).map((question) => question.question),
        ...(await unattemptedPacketSubmissionAuthority(request.jwtPayload!.userId, row.id, review.status, request.log)),
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
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid handoff completion request' });
      const current = readApplicationReview(row.spec as StoredSpec);
      if (!current || current.status !== 'needs_attention') {
        return reply.status(409).send({ error: 'This application is not waiting on you' });
      }
      const handoffQuestionGate = submissionQuestionGate(current);
      if (handoffQuestionGate.metadataBlockerCount > 0) {
        return reply.status(422).send({
          error: 'Litos could not read complete employer question metadata, so this handoff cannot be completed.',
          code: 'QUESTION_METADATA_INCOMPLETE',
          count: handoffQuestionGate.metadataBlockerCount,
        });
      }
      if (handoffQuestionGate.requiredQuestionLabels.length > 0) {
        return reply.status(422).send({
          error: handoffQuestionGate.draftQuestionLabels.length > 0
            ? 'Approve or change the answers Litos drafted for you, and answer every required question, before completing this handoff.'
            : 'Answer every required question before completing this handoff.',
          questions: handoffQuestionGate.requiredQuestionLabels,
        });
      }
      if (handoffQuestionGate.optionalQuestionLabels.length > 0) {
        return reply.status(422).send({
          error: 'Choose Answer or Skip for every optional question before completing this handoff.',
          code: 'OPTIONAL_QUESTION_DECISION_REQUIRED',
          questions: handoffQuestionGate.optionalQuestionLabels,
        });
      }
      const handoffAudit = await currentAcknowledgedPacketAudit(row, {
        // This route can observe a receipt from a form already submitted in the retained session.
        // Bind that receipt to the stored prepared snapshot without a post-send resolver read.
        questions: current.questions,
      });
      if (!handoffAudit.valid) {
        return reply.status(409).send(packetAuditClientError(handoffAudit));
      }
      let observedReceipt: Awaited<ReturnType<typeof readReceipt>> | null = null;
      if (parsed.data.outcome === 'submitted' && current.browser_session_id) {
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
          });
        }
        if (!observedReceipt || !extensionEmployerReceiptIsSufficient({
          atsName: current.ats_name,
          portalUrl: current.portal_url,
          confirmationText: observedReceipt.confirmationText,
          finalUrl: observedReceipt.finalUrl,
        })) {
          return reply.status(409).send({
            error: 'The retained company session does not show a verified receipt for this exact application.',
          });
        }
      }
      const userId = request.jwtPayload!.userId;
      const result = await db.transaction(async (tx) => {
        await lockSubmissionAttemptUser(tx, userId);
        const [locked] = await tx.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, handoffAudit.row.id),
          eq(generated_resumes.user_id, userId),
        )).limit(1).for('update');
        if (!locked
          || locked.resume_object_key !== handoffAudit.row.resume_object_key
          || !isDeepStrictEqual(locked.job_context, handoffAudit.row.job_context)
          || !sameApplicationPacketSpec(locked.spec, handoffAudit.row.spec)) {
          return { kind: 'changed' as const };
        }
        const latest = readApplicationReview(locked.spec);
        if (!latest || latest.status !== 'needs_attention' || !latest.submission_claim_id) {
          return { kind: 'changed' as const };
        }
        const clockResult = await tx.execute(sql`select clock_timestamp() as now`);
        const clockValue = (clockResult.rows[0] as { now?: Date | string } | undefined)?.now;
        const databaseNow = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
        if (Number.isNaN(databaseNow.getTime())) throw new Error('Database completion clock was unavailable');
        const now = databaseNow.toISOString();
        const events = (await submissionAttemptEventsForPacket(userId, locked.id, { executor: tx }))
          .filter((event) => event.attempt_id === latest.submission_claim_id);
        const opening = events.find((event) => event.event_kind === 'attempt_opened');
        if (!opening
          || opening.packet_version !== handoffAudit.audit.packet_version
          || opening.submission_claim_id !== latest.submission_claim_id
          || opening.application_id === null) return { kind: 'authority_missing' as const };
        const binding = submissionAttemptBindingFromEvent(opening);
        const safety = submissionAttemptRetrySafety(events);

        if (parsed.data.outcome === 'cleared') {
          if (safety.kind !== 'blocked_unverified') return { kind: 'authority_conflict' as const };
          if (safety.reason !== 'opened') {
            const waiting = applyReviewPatch(latest, {
              status: 'needs_attention',
              submission_error: undefined,
              attention_reason: 'Did this application reach the employer? Choose Yes or No before Litos does anything else.',
              attention_categories: ['unverified_submission'],
              unverified_submission: {
                at: safety.at,
                cause: 'no_confirmation_state',
                ...(latest.portal_url ? { portal_url: latest.portal_url } : {}),
                ...(latest.submission_run_id ? { submission_run_id: latest.submission_run_id } : {}),
              },
            }, () => now);
            const [updated] = await tx.update(generated_resumes).set({ spec: reviewSpec(waiting) }).where(and(
              eq(generated_resumes.id, locked.id),
              eq(generated_resumes.user_id, userId),
              sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
              sql`${generated_resumes.spec}->'_review'->>'status' = 'needs_attention'`,
            )).returning({ id: generated_resumes.id });
            if (!updated) throw new Error('HANDOFF_UNVERIFIED_WRITE_CONFLICT');
            return { kind: 'needs_answer' as const, review: waiting };
          }
          await appendSubmissionAttemptEvent({
            ...binding,
            eventId: submissionAttemptEventId(binding.attemptId, 'not_sent_proven', 'attended-cleared-before-boundary'),
            eventKind: 'not_sent_proven',
            proofKind: 'typed_pre_click_stop',
            evidenceCode: 'attended_challenge_cleared_before_boundary',
            observedAt: databaseNow,
          }, { executor: tx });
          const next = applyReviewPatch(latest, {
            status: 'ready_for_final_approval',
            attention_reason: undefined,
            submission_error: undefined,
            submission_claimed_at: undefined,
            submission_claim_id: undefined,
            submission_packet_version: undefined,
            submission_authorization: undefined,
          }, () => now);
          const [updated] = await tx.update(generated_resumes).set({ spec: reviewSpec(next) }).where(and(
            eq(generated_resumes.id, locked.id),
            eq(generated_resumes.user_id, userId),
            sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
          )).returning({ id: generated_resumes.id });
          if (!updated) throw new Error('HANDOFF_CLEAR_WRITE_CONFLICT');
          return { kind: 'cleared' as const, review: next };
        }

        const boundary = await submissionBoundaryAuthorization(userId, binding.attemptId, { executor: tx });
        if (!boundary
          || events.some((event) => event.event_kind === 'submission_confirmed'
            || event.event_kind === 'not_sent_proven')) {
          return { kind: 'authority_conflict' as const };
        }
        const applicantAttestation = !observedReceipt;
        if (applicantAttestation
          ? opening.source !== 'attended_handoff' || opening.operation !== 'manual_submission'
          : (opening.source !== 'managed_browser' && opening.source !== 'direct_browser')
            || opening.operation !== 'initial_submission') {
          return { kind: 'authority_missing' as const };
        }
        const confirmationText = observedReceipt?.confirmationText
          ?? applicantFoundSubmissionReceiptText(events.some((event) => event.event_kind === 'press_observed'));
        const finalUrl = observedReceipt?.finalUrl ?? latest.portal_url;
        if (!finalUrl) return { kind: 'authority_missing' as const };
        const confirmationPrototype = {
          ...opening,
          event_kind: 'submission_confirmed',
          evidence_code: 'attended_receipt_confirmed',
          observed_at: databaseNow,
          created_at: databaseNow,
        } as SubmissionAttemptEventRecord;
        if (observedReceipt && !measuredPersistedReceiptMatchesOpening(
          opening,
          confirmationPrototype,
          finalUrl,
          confirmationText,
          observedReceipt.referenceId,
        )) return { kind: 'receipt_invalid' as const };
        if (applicantAttestation && !events.some((event) => event.event_kind === 'press_observed')) {
          await appendSubmissionAttemptEvent({
            ...binding,
            eventId: submissionAttemptEventId(binding.attemptId, 'press_observed', 'applicant-attended-submit'),
            eventKind: 'press_observed',
            evidenceCode: 'applicant_attended_submission',
            observedAt: databaseNow,
          }, { executor: tx });
        }
        await appendSubmissionAttemptEvent({
          ...binding,
          eventId: submissionAttemptEventId(
            binding.attemptId,
            'submission_confirmed',
            applicantAttestation ? 'applicant-attestation' : 'retained-session-receipt',
          ),
          eventKind: 'submission_confirmed',
          evidenceCode: applicantAttestation ? 'applicant_found_submission' : 'attended_receipt_confirmed',
          observedAt: databaseNow,
        }, { executor: tx });
        const next = applyReviewPatch(latest, {
          status: 'submitted',
          submitted_at: now,
          attention_reason: undefined,
          attention_categories: undefined,
          submission_error: undefined,
          receipt: {
            confirmation_text: confirmationText,
            final_url: finalUrl,
            ...(observedReceipt?.referenceId ? { reference_id: observedReceipt.referenceId } : {}),
            captured_at: now,
            source: 'attended_handoff',
          },
        }, () => now);
        const [updated] = await tx.update(generated_resumes).set({
          spec: reviewSpec(next),
          pipeline_stage: 'applied',
          pipeline_stage_at: databaseNow,
        }).where(and(
          eq(generated_resumes.id, locked.id),
          eq(generated_resumes.user_id, userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
        )).returning({ id: generated_resumes.id });
        if (!updated) throw new Error('HANDOFF_SUBMISSION_WRITE_CONFLICT');
        await syncCanonicalApplicationRow({
          attemptId: binding.attemptId,
          packetId: locked.id,
          userId,
          applicationId: binding.applicationId,
          packetVersion: binding.packetVersion,
          postingIdentity: binding.postingIdentity,
        }, tx);
        const canonicalId = binding.applicationId!;
        const projections = await authoritativeSubmissionProjection({
          userId,
          packetIds: [locked.id],
          applicationIds: [canonicalId],
          executor: tx,
        });
        const exact = { attemptId: binding.attemptId, canonicalApplicationId: canonicalId, packetId: locked.id };
        if (!authoritativeConfirmedProjectionMatches(projections.byPacketId.get(locked.id), exact)
          || !authoritativeConfirmedProjectionMatches(projections.byApplicationId.get(canonicalId), exact)) {
          throw new Error('HANDOFF_CONFIRMATION_PROJECTION_INCOMPLETE');
        }
        return { kind: 'submitted' as const, review: next };
      });
      if (result.kind === 'changed') {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({ application_id: row.id, review: review ?? current });
      }
      if (result.kind === 'authority_missing' || result.kind === 'authority_conflict') {
        return reply.status(409).send({
          error: 'This handoff is missing exact submission authority. Litos did not change its outcome.',
          code: 'HANDOFF_AUTHORITY_MISSING',
        });
      }
      if (result.kind === 'receipt_invalid') {
        return reply.status(409).send({
          error: 'The retained company session does not show a receipt bound to this exact job.',
          code: 'HANDOFF_RECEIPT_INVALID',
        });
      }
      return reply.status(result.kind === 'needs_answer' ? 202 : 200).send({
        application_id: row.id,
        review: result.review,
        cover_letter: storedCoverLetter(row),
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
      const current = readApplicationReview(row.spec);
      if (!current || current.status !== 'ready_for_final_approval') {
        return reply.status(409).send({ error: 'This application is not waiting for you to send it' });
      }
      const unresolvable = documentAsksLitosCannotResolve(current, storedDocuments(row));
      if (unresolvable.length === 0) {
        return reply.status(409).send({
          error: 'Litos can still finish this one. Review the filled form and send it from here.',
        });
      }
      const audit = await currentAcknowledgedPacketAudit(row, {
        questions: current.questions,
      });
      if (!audit.valid) return reply.status(409).send(packetAuditClientError(audit));
      const userId = request.jwtPayload!.userId;
      const result = await db.transaction(async (tx) => {
        await lockSubmissionAttemptUser(tx, userId);
        const [locked] = await tx.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, audit.row.id),
          eq(generated_resumes.user_id, userId),
        )).limit(1).for('update');
        if (!locked
          || locked.resume_object_key !== audit.row.resume_object_key
          || !isDeepStrictEqual(locked.job_context, audit.row.job_context)
          || !sameApplicationPacketSpec(locked.spec, audit.row.spec)) return { kind: 'changed' as const };
        const latest = readApplicationReview(locked.spec);
        if (!latest || latest.status !== 'ready_for_final_approval' || latest.submission_claimed_at) {
          return { kind: 'changed' as const };
        }
        if (documentAsksLitosCannotResolve(latest, storedDocuments(locked)).length === 0) {
          return { kind: 'resolvable' as const };
        }
        if (!latest.portal_url) return { kind: 'portal_missing' as const };
        const postingIdentity = freezePostingIdentity(locked.job_context, latest.portal_url);
        const duplicate = await duplicateApplicationVerdict({
          userId,
          applicationId: locked.id,
          jobContext: locked.job_context,
          portalUrl: latest.portal_url,
        }, tx);
        if (duplicate.kind !== 'clear') return { kind: 'duplicate_risk' as const, verdict: duplicate };
        const canonicalApplication = await canonicalApplicationForNewPacketAttempt(tx, {
          userId,
          packetId: locked.id,
          postingIdentity,
        });
        const clockResult = await tx.execute(sql`select clock_timestamp() as now`);
        const clockValue = (clockResult.rows[0] as { now?: Date | string } | undefined)?.now;
        const databaseNow = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
        if (Number.isNaN(databaseNow.getTime())) throw new Error('Database self-submit clock was unavailable');
        const claimAt = databaseNow.toISOString();
        const claimId = randomUUID();
        const binding: SubmissionAttemptBinding = {
          attemptId: claimId,
          userId,
          packetId: locked.id,
          applicationId: canonicalApplication.id,
          parentAttemptId: null,
          source: 'attended_handoff',
          operation: 'manual_submission',
          postingIdentity,
          submissionRunId: latest.submission_run_id ?? null,
          submissionClaimId: claimId,
          packetVersion: audit.audit.packet_version,
        };
        await appendSubmissionAttemptEvent({
          ...binding,
          eventId: submissionAttemptEventId(claimId, 'attempt_opened', 'self-submit-reservation'),
          eventKind: 'attempt_opened',
          evidenceCode: `attended_handoff_capability_v1:self_submit:${audit.audit.audit_digest}:${audit.audit.packet_version}`,
          observedAt: databaseNow,
        }, { executor: tx });
        const authorization = await authorizeFinalSubmissionBoundary(binding, {
          executor: tx,
          factKey: 'self-submit-boundary',
          evidenceCode: 'attended_handoff_employer_boundary_authorized',
        });
        if (authorization.kind !== 'fresh') throw new Error('SELF_SUBMIT_BOUNDARY_CONFLICT');
        const completionAt = new Date(authorization.authorization.authorizedAt);
        const completionIso = completionAt.toISOString();
        await appendSubmissionAttemptEvent({
          ...binding,
          eventId: submissionAttemptEventId(claimId, 'press_observed', 'self-submit-press'),
          eventKind: 'press_observed',
          evidenceCode: 'applicant_attended_submission',
          observedAt: completionAt,
        }, { executor: tx });
        await appendSubmissionAttemptEvent({
          ...binding,
          eventId: submissionAttemptEventId(claimId, 'submission_confirmed', 'self-submit-receipt'),
          eventKind: 'submission_confirmed',
          evidenceCode: 'attended_receipt_confirmed',
          observedAt: completionAt,
        }, { executor: tx });
        const next = applyReviewPatch(latest, {
          status: 'submitted',
          submitted_at: completionIso,
          ...submissionClaimPatch(claimAt, claimId),
          submission_packet_version: audit.audit.packet_version,
          submission_authorization: {
            source: 'user_initiated_extension',
            authorized_at: authorization.authorization.authorizedAt,
          },
          attention_reason: undefined,
          attention_categories: undefined,
          submission_error: undefined,
          receipt: {
            confirmation_text: selfSubmittedSubmissionReceiptText(),
            final_url: latest.portal_url,
            captured_at: completionIso,
            source: 'attended_handoff',
          },
        }, () => completionIso);
        const [updated] = await tx.update(generated_resumes).set({
          spec: reviewSpec(next),
          pipeline_stage: 'applied',
          pipeline_stage_at: completionAt,
        }).where(and(
          eq(generated_resumes.id, locked.id),
          eq(generated_resumes.user_id, userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
        )).returning({ id: generated_resumes.id });
        if (!updated) throw new Error('SELF_SUBMIT_WRITE_CONFLICT');
        await syncCanonicalApplicationRow({
          attemptId: claimId,
          packetId: locked.id,
          userId,
          applicationId: canonicalApplication.id,
          packetVersion: audit.audit.packet_version,
          postingIdentity,
        }, tx);
        const projections = await authoritativeSubmissionProjection({
          userId,
          packetIds: [locked.id],
          applicationIds: [canonicalApplication.id],
          executor: tx,
        });
        const exact = {
          attemptId: claimId,
          canonicalApplicationId: canonicalApplication.id,
          packetId: locked.id,
        };
        if (!authoritativeConfirmedProjectionMatches(projections.byPacketId.get(locked.id), exact)
          || !authoritativeConfirmedProjectionMatches(
            projections.byApplicationId.get(canonicalApplication.id),
            exact,
          )) throw new Error('SELF_SUBMIT_CONFIRMATION_PROJECTION_INCOMPLETE');
        return { kind: 'submitted' as const, review: next };
      });
      if (result.kind === 'changed') {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        return reply.status(202).send({
          application_id: row.id,
          review: readApplicationReview(refreshed.spec) ?? current,
        });
      }
      if (result.kind === 'resolvable') {
        return reply.status(409).send({
          error: 'Litos can still finish this one. Review the filled form and send it from here.',
        });
      }
      if (result.kind === 'portal_missing') {
        return reply.status(409).send({ error: 'This application has no exact employer page to bind the receipt to.' });
      }
      if (result.kind === 'duplicate_risk') {
        return reply.status(409).send(duplicateRiskResponse(result.verdict));
      }
      return reply.send({
        application_id: row.id,
        review: result.review,
        cover_letter: storedCoverLetter(row),
        // Carried so the screen this answers keeps the marks it was drawing. Built by the reader that
        // strips object_key, like every other envelope in this file.
        documents: storedDocuments(row),
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
        return reply.status(409).send({ error: 'Look over the filled form before you send it' });
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
        return reply.status(409).send(duplicateRiskResponse(approvalDuplicate));
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
      const approvalQuestionGate = submissionQuestionGate(approvalReview);
      if (approvalQuestionGate.metadataBlockerCount > 0) {
        approvalIssues.push(`${approvalQuestionGate.metadataBlockerCount} employer question controls have incomplete metadata.`);
      }
      /* Two sentences over one list, because the two states need different actions from her. A blank
         box wants an answer; a draft is already written and wants a read. Saying "still blank" about
         a paragraph Litos composed sends her looking for a field that is not empty. */
      if (approvalQuestionGate.draftQuestionLabels.length > 0) {
        approvalIssues.push('Approve or change the answer Litos drafted for you before sending.');
      }
      if (approvalQuestionGate.requiredQuestionLabels.length > approvalQuestionGate.draftQuestionLabels.length) {
        approvalIssues.push('A required application answer is still blank.');
      }
      if (approvalQuestionGate.optionalQuestionLabels.length > 0) {
        approvalIssues.push('Choose Answer or Skip for every optional question before sending.');
      }
      const sensitive = sensitiveQuestionFor(
        approvalReview.questions, sensitiveProfile, approvalReview.jd_text,
        postingCountryFromJobContext(row.job_context),
        postingCountryCodeFromJobContext(row.job_context),
        approvalReview.questions_reviewed_at,
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
      /* Retried on the authority guard's 40001 - the applicant pressing Send while her own dashboard
       * polls the authority projection is the ordinary case, and this statement's BEFORE trigger
       * refuses rather than waits. NOT collapsed into the zero-row branch: this route's 202 is the
       * same body a STARTED send answers with, so reporting a write that never happened as one would
       * tell the dashboard a submission is under way when nothing was claimed. An exhausted window
       * propagates instead and answers 503 with Retry-After, which is the only true reading of a
       * statement that aborted before it touched the row. */
      const approved = await withAuthorityRevisionRetry(() => db.update(generated_resumes)
        .set({ spec: approvedReviewSpec(next, now) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
          sql`${generated_resumes.spec}->'_review'->>'status' = 'ready_for_final_approval'`,
        ))
        .returning({ id: generated_resumes.id }), {
        onRetry: (attempt) => request.log.warn(
          { applicationId: row.id, attempt },
          'final approval hit the authority revision guard; retrying',
        ),
      });
      if (approved.length === 0) {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({ application_id: row.id, review: review ?? current });
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
      if (!securityCodeReview) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      const securityCodeAudit = await currentAcknowledgedPacketAudit(row, {
        questions: await resolvedPacketAuditQuestions(row, securityCodeReview),
        restoreExpiredResume: 'authorizing_send',
      });
      if (!securityCodeAudit.valid) {
        // The applicant sentence, not the verdict token. This is the exact reply that printed the
        // bare "packet_stale" on the Jane Street code step before the tokens were translated.
        return reply.status(409).send(packetAuditClientError(securityCodeAudit));
      }
      const body = request.body as { code?: unknown } | undefined;
      const outcome = await finishSecurityCodeSubmission(row.id, body?.code, fastify);
      if (outcome.kind === 'not_found') {
        return reply.status(404).send({ error: 'That application is not available' });
      }
      if (outcome.kind === 'not_awaiting') {
        // 409 and not 400: nothing is wrong with the request, the packet has simply moved on. The
        // status travels back so the dashboard can re-render rather than guess.
        return reply.status(409).send({
          error: 'This application is not waiting on a security code',
          status: outcome.status,
        });
      }
      if (outcome.kind === 'invalid_code') {
        return reply.status(400).send({
          error: 'That does not look like the code from the email. Enter the characters exactly as they appear.',
          code: 'INVALID_SECURITY_CODE',
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
        });
      }
      return reply.status(200).send({ application_id: row.id, review: outcome.review });
    },
  );

  fastify.post(
    '/applications/:id/status',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = statusBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid submission status' });
      const stored = row.spec as StoredSpec;
      const current = readApplicationReview(stored);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
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
        return reply.status(409).send({ error: 'An active or completed submission cannot be replaced by a delayed failure update' });
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
        .returning({ id: generated_resumes.id });
      if (updated.length === 0) {
        return reply.status(409).send({ error: 'The application state changed before the failure update was recorded' });
      }
      return reply.send({ application_id: row.id, review: next });
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
        return reply.status(400).send({ error: 'Say whether you found the application, with found true or false' });
      }
      const userId = request.jwtPayload!.userId;
      const result = await db.transaction(async (tx) => {
        await lockSubmissionAttemptUser(tx, userId);
        const [locked] = await tx.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, userId),
        )).limit(1).for('update');
        const current = locked ? readApplicationReview(locked.spec) : null;
        if (!locked || !current) return { kind: 'no_review' as const };
        const pending = current.unverified_submission;
        if (!pending) return { kind: 'not_waiting' as const, review: current };
        if (pending.resolution) return { kind: 'already_resolved' as const, review: current };
        const claimId = current.submission_claim_id;
        if (!claimId) return { kind: 'authority_missing' as const };
        const events = (await submissionAttemptEventsForPacket(userId, locked.id, { executor: tx }))
          .filter((event) => event.attempt_id === claimId);
        const opening = events.find((event) => event.event_kind === 'attempt_opened');
        const expectedPacketVersion = current.submission_packet_version
          ?? current.packet_audit?.packet_version
          ?? null;
        if (!opening
          || opening.submission_claim_id !== claimId
          || opening.application_id === null
          || !opening.packet_version
          || opening.packet_version !== expectedPacketVersion) {
          return { kind: 'authority_missing' as const };
        }
        const safety = submissionAttemptRetrySafety(events);
        if (safety.kind !== 'blocked_unverified') return { kind: 'authority_conflict' as const };
        const binding = submissionAttemptBindingFromEvent(opening);
        const clockResult = await tx.execute(sql`select clock_timestamp() as now`);
        const clockValue = (clockResult.rows[0] as { now?: Date | string } | undefined)?.now;
        const databaseNow = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
        if (Number.isNaN(databaseNow.getTime())) throw new Error('Database outcome clock was unavailable');
        const now = databaseNow.toISOString();
        const resolved = {
          ...pending,
          resolution: parsed.data.found ? 'sent' as const : 'not_sent' as const,
          resolved_at: now,
        };

        if (!parsed.data.found) {
          /* THE DOOR THAT WAS BOLTED FROM THE INSIDE.
           *
           * This arm demanded a boundary authorization, and returned 409
           * UNVERIFIED_ATTEMPT_AUTHORITY_MISSING - "This question is not bound to an exact
           * submission attempt" - without one. An attempt that never reached the boundary has none
           * by construction, so for exactly the rows where "it is not there" is PROVABLY the right
           * answer, it was the one answer the product refused. The only control that still worked
           * was "I found it there", which writes a submission_confirmed and a receipt. Measured
           * 2026-09-02 on attempt 22b9663a: a packet whose ledger held attempt_opened alone could be
           * moved only by recording a confirmation for an application that was never sent.
           *
           * The requirement is right where an authorization exists: that lease is durable employer
           * risk, and the applicant's look is only admissible after it expires, which is what the
           * active-lease refusal below enforces. It is meaningless where none was ever taken, and
           * attemptNeverReachedEmployer is what tells the two apart. Everything else on this arm is
           * unchanged, including the post-write assertion that the ledger really did fold to
           * safe_not_sent before the row is allowed to move. */
          const boundary = await submissionBoundaryAuthorization(userId, claimId, { executor: tx });
          if (!boundary && !attemptNeverReachedEmployer(events)) {
            return { kind: 'authority_missing' as const };
          }
          if (boundary?.active) return { kind: 'lease_active' as const, expiresAt: boundary.expiresAt };
          await appendSubmissionAttemptEvent({
            ...binding,
            eventId: submissionAttemptEventId(claimId, 'not_sent_proven', 'applicant-checked-not-sent'),
            eventKind: 'not_sent_proven',
            proofKind: 'applicant_checked_not_sent',
            evidenceCode: 'applicant_checked_not_sent',
            observedAt: databaseNow,
          }, { executor: tx });
          const exactEvents = (await submissionAttemptEventsForPacket(userId, locked.id, { executor: tx }))
            .filter((event) => event.attempt_id === claimId);
          const resolvedSafety = submissionAttemptRetrySafety(exactEvents);
          if (resolvedSafety.kind !== 'safe_not_sent'
            || resolvedSafety.proofKind !== 'applicant_checked_not_sent') {
            throw new Error('UNVERIFIED_NOT_SENT_FACT_INCOMPLETE');
          }
          const next = applyReviewPatch(current, {
            status: 'needs_attention',
            unverified_submission: resolved,
            submission_claimed_at: undefined,
            submission_claim_id: undefined,
            submission_packet_version: undefined,
            submission_authorization: undefined,
            attention_reason: 'You checked and the employer does not have this one. Litos can send it again when you are ready.',
            attention_categories: ['unverified_submission'],
          }, () => now);
          const [updated] = await tx.update(generated_resumes).set({ spec: reviewSpec(next) }).where(and(
            eq(generated_resumes.id, locked.id),
            eq(generated_resumes.user_id, userId),
            sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
          )).returning({ id: generated_resumes.id });
          if (!updated) throw new Error('UNVERIFIED_NOT_SENT_WRITE_CONFLICT');
          return { kind: 'resolved' as const, review: next };
        }

        const finalUrl = pending.portal_url ?? current.portal_url;
        if (!finalUrl) return { kind: 'authority_missing' as const };
        const hasPress = events.some((event) => event.event_kind === 'press_observed');
        const confirmationText = applicantFoundSubmissionReceiptText(hasPress);
        await appendSubmissionAttemptEvent({
          ...binding,
          eventId: submissionAttemptEventId(claimId, 'submission_confirmed', 'applicant-found-submission'),
          eventKind: 'submission_confirmed',
          evidenceCode: 'applicant_found_submission',
          observedAt: databaseNow,
        }, { executor: tx });
        const next = applyReviewPatch(current, {
          status: 'submitted',
          submitted_at: now,
          submission_error: undefined,
          attention_reason: undefined,
          attention_categories: undefined,
          unverified_submission: resolved,
          receipt: {
            confirmation_text: confirmationText,
            final_url: finalUrl,
            captured_at: now,
            source: 'attended_handoff',
          },
        }, () => now);
        const [updated] = await tx.update(generated_resumes).set({
          spec: reviewSpec(next),
          pipeline_stage: 'applied',
          pipeline_stage_at: databaseNow,
        }).where(and(
          eq(generated_resumes.id, locked.id),
          eq(generated_resumes.user_id, userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
        )).returning({ id: generated_resumes.id });
        if (!updated) throw new Error('UNVERIFIED_SENT_WRITE_CONFLICT');
        await syncCanonicalApplicationRow({
          attemptId: claimId,
          packetId: locked.id,
          userId,
          applicationId: binding.applicationId,
          packetVersion: binding.packetVersion,
          postingIdentity: binding.postingIdentity,
        }, tx);
        const canonicalId = binding.applicationId!;
        const projections = await authoritativeSubmissionProjection({
          userId,
          packetIds: [locked.id],
          applicationIds: [canonicalId],
          executor: tx,
        });
        const exact = { attemptId: claimId, canonicalApplicationId: canonicalId, packetId: locked.id };
        if (!authoritativeConfirmedProjectionMatches(projections.byPacketId.get(locked.id), exact)
          || !authoritativeConfirmedProjectionMatches(projections.byApplicationId.get(canonicalId), exact)) {
          throw new Error('UNVERIFIED_CONFIRMATION_PROJECTION_INCOMPLETE');
        }
        return { kind: 'resolved' as const, review: next };
      });
      if (result.kind === 'no_review') {
        return reply.status(409).send({ error: 'Application review is not available for this resume' });
      }
      if (result.kind === 'not_waiting') {
        return reply.status(409).send({
          error: 'This application is not waiting on an unverified submission',
          status: result.review.status,
        });
      }
      if (result.kind === 'already_resolved') {
        return reply.status(200).send({ application_id: row.id, already_resolved: true, review: result.review });
      }
      if (result.kind === 'lease_active') {
        return reply.status(409).send({
          error: 'The current employer send window is still active. Wait for it to close before choosing No.',
          code: 'SUBMISSION_AUTHORIZATION_ACTIVE',
          activation_expires_at: result.expiresAt,
        });
      }
      if (result.kind === 'authority_missing' || result.kind === 'authority_conflict') {
        return reply.status(409).send({
          error: 'This question is not bound to an exact submission attempt. Litos did not change the application.',
          code: 'UNVERIFIED_ATTEMPT_AUTHORITY_MISSING',
        });
      }
      return reply.status(200).send({ application_id: row.id, review: result.review });
    },
  );
}
