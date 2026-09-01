import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { decide, isBlocked } from '../engine/eligibility';
import { chromium, type Page } from 'playwright-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import {
  application_profile,
  career_page_sources,
  generated_resumes,
  monitored_jobs,
  profiles,
  user_documents,
  users,
} from '../db/schema';
import { getEntitlementSnapshot } from '../lib/entitlements';
import { confirmedPacketPipelineProjection } from '../lib/canonicalApplicationLifecycle';
import {
  normalizeManagedFormSnapshot,
  normalizeApplicationReviewQuestions,
  readManagedFormSnapshot,
  readApplicationReview,
  type ApplicationAttentionCategory,
  type ApplicationReviewState,
  type SecurityCodeAttempt,
} from '../lib/applicationReview';
import {
  beginSecurityCodeState,
  findSecurityCodeAttempt,
  normalizeSecurityCode,
  readManagedSecurityCodeChallenge,
  securityCodeChallengeMatchesRecipient,
  securityCodeAttentionReason,
  securityCodeContinuationActions,
  securityCodeFingerprint,
  withSecurityCodeAttempt,
  withSecurityCodeAttempts,
} from '../lib/securityCode';
import { storeFilledPreviewScreenshot, storeReceiptScreenshot } from '../lib/receiptScreenshot';
import {
  connectToSession,
  acknowledgeManagedBrowserTerminalResult,
  assertManagedBrowserRequestBudgetAtClock,
  browserDeliveryRuntimeIdentity,
  continueManagedBrowser,
  getBrowserSession,
  getManagedBrowserTerminalResult,
  HANDOFF_WINDOW_MS,
  isBrowserbaseConfigured,
  isManagedStratusProvider,
  managedActionsWithExactPageUrl,
  managedApplicationSubmitOptions,
  MANAGED_PREPARE_FILL_OPTIONS,
  MANAGED_PREPARE_SCAN_OPTIONS,
  managedBrowserTerminalResultId,
  managedBrowserTerminalFailureError,
  managedContinuationFingerprint,
  ManagedBrowserAssertionFailureError,
  type ManagedSubmissionAttempt,
  type ManagedBrowserAction,
  type ManagedBrowserResult,
  type ManagedBrowserRunProgress,
  ManagedBrowserPreSubmitCrashError,
  ManagedBrowserProviderProgressError,
  runManagedBrowser,
  startManagedBrowserRequestBudget,
} from '../lib/browserbase';
import { createFencedBrowserSession, databaseNow } from '../lib/browserProviderResourceCleanup';
import { resolvedApprovedApplicationPageUrl, sortManagedPageUrlParams } from '../lib/workableApplicationUrl';
import {
  managedContinuationAttemptFingerprint,
  managedContinuationTerminalDecision,
  managedRecoveryReviewFoldIsDurable,
  planManagedContinuationRecovery,
} from '../lib/managedContinuationRecovery';
import {
  blockersIncludeCaptcha,
  CAPTCHA_BLOCKER,
  buildManagedCaptchaProbeActions,
  buildManagedDiscoveryActions,
  corroborateManagedCaptchaBlockers,
  managedNetworkAccessRestrictionReason,
  managedCaptchaProvider,
  detectCaptchaProvider,
  captchaProviderForFamily,
  buildManagedAttendedAccountProbeActions,
  buildManagedPortalActions,
  buildWorkablePhoneEvidenceActions,
  isWorkablePhoneReadbackAssertionLabel,
  workablePhoneEvidenceSummary,
  budgetDroppedReviewedQuestions,
  attachManagedFieldOptions,
  buildManagedDiscoveredOptionProbeBatches,
  managedOptionProbeAnalysis,
  managedOptionProbeControlId,
  managedOptionProbeTargets,
  managedUnexplainedAnswers,
  managedUnexplainedAnswerReasons,
  managedResultFieldOptions,
  mergeManagedFieldOptions,
  managedResultSupportsDiscoveryRole,
  CaptchaUnresolvedError,
  clickFinalSubmit,
  canonicalSmartRecruitersOneClickUrl,
  canonicalSupportedPortalUrl,
  detectPortal,
  managedResultRequiresCaptchaAttention,
  isManagedCaptchaEvidenceExtract,
  blockersRequireCoverLetter,
  fillPortal,
  hasCoverLetterUpload,
  hasTranscriptUpload,
  managedResultFilledFields,
  managedResumeUploadDisplacement,
  managedAnswerLossReasons,
  managedResultHasCoverLetterUpload,
  managedResultHasTranscriptUpload,
  managedAttendedAccountHold,
  managedAttendedAccountUrlIsSupported,
  navigateToApplicationForm,
  portalApplicationUrl,
  isAccountWalledFamily,
  isManagedAttendedAccountPortal,
  isCaptchaGatedFamily,
  isConsentGrantConditionalFamily,
  managedConsentTickPlan,
  managedImpliedConsentSubmitLicence,
  durablePortalSelector,
  consentTickCoveredBlockers,
  portalCanAutoSubmit,
  portalCanAutoSubmitWithConsentGrant,
  portalHandoffReason,
  unattendedHandoffReason,
  type SubmissionPacket,
  type SupportedPortal,
  ManagedActionBudgetError,
  ManagedConfirmationUnprovenError,
  ManagedRequiredFieldConfirmationError,
  assertManagedApplicationFinalSubmitSelected,
  assertManagedApplicationSubmitConsistency,
  assertManagedRequiredFieldsConfirmed,
  managedApplicationUsesAtomicSubmitV4,
  managedApplicationProofIsRequired,
  NoSubmitControlError,
} from '../lib/portalSubmission';
import {
  greenhousePublicApplicationSchema,
  greenhousePublicQuestionLabelKey,
} from '../lib/greenhousePublicApplication';
import {
  ashbyPublicApplicationSchema,
  ashbyPublicQuestionLabelKey,
} from '../lib/ashbyPublicApplication';
import {
  exactManagedSubmitVerdict,
  isManagedRunTimeout,
  managedSubmitVerdict,
  observeManagedReceiptOnce,
  readExactManagedPageReceipt,
  readManagedSubmitOutcome,
  submissionProvablyNotSent,
  unverifiedSubmissionReason,
  type ManagedReceiptResult,
} from '../lib/managedSubmitOutcome';
import { classifySubmissionStop, submissionClaimPatch, submissionStopRecord } from '../lib/submissionStop';
import {
  advanceCanonicalApplicationFromPacketSubmission,
  CanonicalApplicationProjectionConflictError,
  syncCanonicalApplicationRow,
} from '../lib/canonicalApplicationSync';
import {
  canonicalApplicationForAttemptProjection,
  canonicalApplicationForNewPacketAttempt,
  CanonicalPacketBindingError,
} from '../lib/canonicalPacketBinding';
import {
  authoritativeConfirmedProjectionMatches,
  authoritativeSubmissionProjection,
} from '../lib/authoritativeSubmissionProjection';
import { applyReviewPatch, beginStall } from '../lib/applicationStall';
import {
  attentionCategoriesForReasons,
  UNEXPLAINED_RUN_FAILURE_REASON,
  type TerminalRunStatus,
} from '../lib/submissionTerminalCause';
import { sanitizeProviderBlockers } from '../lib/fieldLabel';
import { documentAsksOpenToReuse, requiredDocumentAsks, type RequiredDocumentAsk } from '../lib/requiredDocuments';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { PacketDocumentExpiredError, resolveBlobUrl } from '../lib/resumeAccess';
import { objectStorageUsesRailway } from '../lib/objectStorage';
import { storedGeneratedResumeBlobUrl } from '../lib/resumeArtifactVersions';
import { rerenderFrozenCoverLetter } from '../lib/packetDocumentRecovery';
import { PACKET_EXPIRED_REASON } from '../lib/packetResumeRestore';
import { currentAcknowledgedPacketAudit, currentPacketAudit, packetAuditClientError } from '../lib/packetAuditService';
import { packetAuditSha256, packetAuditTextSha256, type PacketAudit } from '../lib/packetAudit';
import { packetQuestionFixpoint } from '../lib/packetQuestionIdentity';
import {
  browserEmployerDeliveryChannel,
  employerDeliveryBindingIssue,
  employerDeliveryEnvelope,
  packetForEmployerDelivery,
  type EmployerDeliveryEnvelope,
  type EmployerPacketDeliveryMode,
} from '../lib/employerDeliveryIdentity';
import { createDashboardHandoffBinding } from '../lib/extensionHandoffPacket';
import {
  CONTROLLED_RECEIPT_TEXT,
  exactControlledTestReceiptRoute,
  isControlledTestPortalUrl,
} from '../lib/controlledTestPortal';
import { decryptRow } from './applicationProfile';
import { readExperienceBank } from '../db/experienceBank';
import { declaredSkillsList } from './profile';
import {
  applicantGroundingFacts,
  draftApplicationAnswer,
  rankingGroundingFor,
  rankingRuleText,
  validateDraftedApplicationAnswer,
  type ApplicantGroundingFacts,
} from '../llm/applicationAnswer';
import { generateCompactApplicationMaterials, type CompactMaterialQuestion } from '../llm/applicationMaterials';
import {
  completeEmailVerificationIfPresent,
  managedResultNeedsEmailVerification,
  prepareManagedEmailVerification,
  type BrowserVerificationResult,
} from '../lib/browserVerification';
import {
  discoverPageQuestions,
  discoveredFieldIsFixedPortalProfileControl,
  discoveredFieldIsRequired,
  consentAcknowledgementLicence,
  isCoreIdentityField,
  isCoverLetterTextQuestion,
  isOpenEndedQuestion,
  isRefusedQuestion,
  normalizeDiscoveredLabel,
  normalizeReviewQuestionLabel,
  normalizeStoredPortalQuestions,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  fitToBudget,
  applicationContextForQuestionResolution,
  WORK_ELIGIBILITY_QUESTION,
  workEligibilitySkipReason,
  discoveredFieldIsNotAQuestion,
  type ApplicationProfileLike,
  type DiscoveredQuestion,
} from '../lib/questionDiscovery';
import {
  REQUIRED_AND_EMPTY_BLOCKER,
  unmetConditionalFollowUpBlockers,
} from '../lib/conditionalFollowUp';
import { isSelfDeclarationQuestion, selfDeclarationSkipReason } from '../lib/selfDeclaration';
import {
  isJobBoardReferralClaim,
  otherReferralOption,
  REFERRAL_OTHER_DETAIL,
  referralSourceForApplication,
  type ReferralSourceEvidence,
} from '../lib/referralSource';
import { savedAnswerFor, type AnswerReuseContext } from '../lib/answerReuse';
import { profileBackedBlockerLabels, resolveProfileField, usableOptions } from '../lib/profileFieldResolution';
import { loadApplicationProfileLike, loadUnattendedConsentGrant } from '../lib/applicationProfileLike';
import { loadSavedAnswers } from '../lib/savedAnswerStore';
import type { ApplicationReviewQuestion } from '../lib/applicationReview';
import { applicantChoseStoredAnswer } from '../lib/applicantAnswer';
import { postingCountryCodeFromJobContext, postingCountryFromJobContext, type JobCountry } from '../lib/jobLocation';
import {
  dedupeQuestionMetadataBlockers,
  discoveredQuestionNeedsExactOptionsBeforeResolution,
  discoveredQuestionsForExactOptionProbe,
  discoveredQuestionControlType,
  questionMetadataBlockerForDiscovered,
  questionMetadataBlockersForOptionProbeFailures,
  questionMetadataBlockerReason,
  questionLabelIsGenericAnswerControl,
  reopenUnfitClosedChoiceQuestions,
  type QuestionMetadataBlocker,
} from '../lib/questionMetadata';
import {
  normalizePaylocityDiscoveredField,
  paylocityFieldIsFilledFromProfile,
} from '../lib/paylocityFields';
import {
  coverLetterCandidateContext,
  generateStoredCoverLetter,
  persistGeneratedCoverLetterBody,
  storedCoverLetter,
} from '../lib/coverLetterService';
import { repairReviewPortalFromMonitoredJob } from '../lib/applicationPortalRepair';
import { monitoredPortalProofUnavailable } from '../lib/applicationPortalRepair';
import { selectApplicationProfileRow } from '../lib/applicationFacts';
import { mayClickFinalSubmit, preparedSubmissionStatus } from '../lib/submissionAuthorization';
import {
  blankRequiredQuestionLabels,
  directPreparationIsSafe,
  submissionQuestionGate,
  undecidedOptionalQuestionLabels,
} from '../lib/submissionSafety';
import { resolveRevision } from '../lib/buildInfo';
import {
  autoRunShouldPrepare,
  dailySubmissionCap,
  hasTimeForAnotherApplication,
  submissionBatchSize,
  withinDailyCap,
} from '../lib/submissionQueue';
import { coverLetterFileNameForRole, resumeFileNameForRole, transcriptFileNameForRole } from '../lib/resumeFileName';
import {
  claimReusableDocument,
  documentBytesFromPointer,
  ForeignDocumentPointerError,
  storedDocuments,
  MAX_USER_DOCUMENT_BYTES,
} from '../lib/documentStore';
import { duplicateApplicationVerdict, type DuplicateApplicationVerdict } from '../lib/duplicateApplication';
import {
  authorizeFinalSubmissionBoundary,
  appendSubmissionAttemptEvent,
  assertSubmissionAccountNotDraining,
  freezePostingIdentity,
  lockSubmissionAttemptUser,
  submissionAttemptBindingFromEvent,
  submissionBoundaryAuthorization,
  submissionAttemptEventId,
  submissionAttemptEventsForPacket,
  submissionAttemptsOpenedToday,
  SubmissionAccountDeletionDrainError,
  type SubmissionBoundaryAuthorization,
  type SubmissionAttemptBinding,
  type SubmissionAttemptEventKind,
  type SubmissionNotSentProofKind,
} from '../lib/submissionAttemptLedger';
import {
  ApplicantEmailRegenerationRequiredError,
  readPinnedApplicantEmail,
  resolveFrozenApplicantEmail,
} from '../lib/applicationEmail';
import { resolveVerificationEmailRoute } from '../lib/emailVerification';
import { leadAlignmentIssues } from '../engine/leadAlignment';
import { normalizeSpec } from '../llm/resumeSpec';

export type ResumeRow = typeof generated_resumes.$inferSelect;
type StoredSpec = Record<string, unknown>;

type StandingAuthorization = {
  enabled: boolean;
  consentedAt?: string;
  consentVersion?: string;
};

// Thin wrapper. The merge and the stall bookkeeping live in applicationStall.ts so that
// routes/applications.ts, which writes _review directly and knows nothing about stalls, goes
// through exactly the same code.
//
// THE RUN'S REVISION IS STAMPED HERE, next to updated_at and for the same reason applyReviewPatch
// writes updated_at rather than trusting each caller to: this is the one function every review the
// runner produces passes through, and a rule enforced at a dozen call sites is a rule that holds
// until someone adds the thirteenth. Only the RUNNER stamps it. A review edit or a stage change
// writes review state without learning anything new about the form, and stamping those would make a
// packet look freshly tested when all that happened was somebody renamed a question.
//
// Cleared, not preserved, when the environment supplies no SHA. run_revision means "the build whose
// run produced this", and carrying a previous deployment's SHA through a run that happened on an
// unidentifiable build would be a confident wrong answer where absent is the honest one.
function nextReview(current: ApplicationReviewState, patch: Partial<ApplicationReviewState>): ApplicationReviewState {
  return applyReviewPatch(current, { ...patch, run_revision: resolveRevision().revision ?? undefined });
}

function runnerApplicationCompany(row: Pick<ResumeRow, 'job_context'>): string {
  const context = row.job_context && typeof row.job_context === 'object'
    ? row.job_context as Record<string, unknown>
    : {};
  return typeof context.company === 'string' ? context.company.trim() : '';
}

/** The final runner gate is deliberately pure so every entry path can share and test one decision. */
export function runnerLeadAlignmentIssues(row: Pick<ResumeRow, 'spec' | 'job_context'>): string[] {
  const review = readApplicationReview(row.spec);
  if (!review?.jd_text) {
    return ['This application has no frozen job description for its lead-experience citation.'];
  }
  return leadAlignmentIssues(normalizeSpec(row.spec), review.jd_text, {
    context: { company: runnerApplicationCompany(row), role: review.role },
  });
}

async function withholdInvalidLeadAlignment(
  row: ResumeRow,
  current: ApplicationReviewState,
  issues: string[],
  preserveSecurityCodeState = false,
  persist: (review: ApplicationReviewState) => Promise<unknown> =
    (review) => writeReview(row, review),
): Promise<ApplicationReviewState> {
  const reason = `This resume's lead experience is no longer supported by its frozen job description. Regenerate or edit it before sending. ${issues.join(' ')}`.slice(0, 1200);
  const review = nextReview(current, {
    status: preserveSecurityCodeState ? 'awaiting_security_code' : 'needs_attention',
    attention_reason: preserveSecurityCodeState && current.security_code
      ? `${securityCodeAttentionReason(current.security_code)}\n${reason}`
      : reason,
    attention_categories: preserveSecurityCodeState
      ? ['security_code', 'required_document']
      : ['required_document'],
    submission_authorization: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  });
  await persist(review);
  return review;
}

export function atsApiSubmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LITOS_ATS_API_SUBMISSION_ENABLED === 'true';
}

export async function writeReview(row: ResumeRow, review: ApplicationReviewState): Promise<boolean> {
  const expected = readApplicationReview(row.spec);
  const updated = await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1).for('update');
    if (!latest) return [];
    /* A confirmation is stronger than every progress, hold, failure, or not-sent review patch.
     * The claim and run deliberately survive confirmed writes, so checking only those mutable
     * keys let a stale same-run callback replace the exact receipt. Fold the immutable ledger
     * under the same user lock as this write and refuse every generic writer after confirmation. */
    const events = await submissionAttemptEventsForPacket(row.user_id, row.id, { executor: tx });
    if (events.some((event) => event.event_kind === 'submission_confirmed')) return [];
    const conditions = [
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    ];
    /* A runner result belongs to one exact run and, after the external-send reservation, one exact
     * claim. Read the expected values from the row the caller acted on, not from `review`, because
     * terminal patches intentionally clear claims. The locked row makes the check and write one
     * decision even when another Vercel instance is trying to finish the same packet. */
    if (expected?.submission_run_id) {
      conditions.push(sql`${generated_resumes.spec}->'_review'->>'submission_run_id' = ${expected.submission_run_id}`);
    } else {
      conditions.push(sql`${generated_resumes.spec}->'_review'->>'submission_run_id' is null`);
    }
    if (expected?.submission_claim_id) {
      conditions.push(sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${expected.submission_claim_id}`);
    } else {
      conditions.push(sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' is null`);
    }
    return tx.update(generated_resumes).set({
      spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(review)}::jsonb, true)`,
    }).where(and(...conditions)).returning({ id: generated_resumes.id });
  });
  /* Every submit path in this file - ATS API, managed, retained-session, controlled - stamps its
   * packet submitted through this one statement, so this is where the canonical applications row
   * learns the same fact. Best-effort by construction: the receipt the run just captured must not
   * be lost to the tracker table having a bad day. */
  if (updated.length > 0 && review.status === 'submitted') {
    try {
      const binding = expected?.submission_claim_id
        ? await persistedRunnerAttemptBinding(row, expected)
        : null;
      if (binding) await advanceCanonicalApplicationFromPacketSubmission({
        packetId: row.id,
        userId: row.user_id,
        applicationId: binding.applicationId,
        postingIdentity: binding.postingIdentity,
      });
    } catch {
      // Exact receipt writers project atomically. This legacy review-only heal remains best effort.
    }
  }
  return updated.length > 0;
}

async function standingAuthorization(userId: string): Promise<StandingAuthorization> {
  const [[user], entitlement] = await Promise.all([
    db.select({
      enabled: users.automatic_submission_enabled,
      consentedAt: users.automatic_submission_consented_at,
      consentVersion: users.automatic_submission_consent_version,
    }).from(users).where(eq(users.id, userId)).limit(1),
    getEntitlementSnapshot(userId),
  ]);
  return {
    enabled: user?.enabled === true && entitlement.features.automatic_submission,
    consentedAt: user?.consentedAt?.toISOString(),
    consentVersion: user?.consentVersion ?? undefined,
  };
}

function preparedReviewPatch(authorization: StandingAuthorization, safe: boolean): Partial<ApplicationReviewState> {
  const status = preparedSubmissionStatus({ safe, standingConsentEnabled: authorization.enabled });
  if (status !== 'submitting') return { status };
  const now = new Date().toISOString();
  return {
    status: 'submitting',
    submission_authorization: {
      source: 'standing_consent',
      authorized_at: now,
      consented_at: authorization.consentedAt,
      consent_version: authorization.consentVersion,
    },
  };
}

// Applications that may have REACHED an employer for this user since 00:00 UTC.
//
// Counted off submission_claimed_at, not submitted_at, and the difference is the whole point of the
// cap. A run that clicks submit and then fails to parse the receipt, upload the screenshot or write
// the row lands in needs_attention with no submitted_at, while the employer already has the
// application. Counting confirmed receipts would let a systematic post-click failure send the
// entire queue while the counter read zero, which is precisely the runaway the cap exists to bound.
// The claim is written atomically immediately before the click, so it is the last honest marker of
// "this one may already be out there".
//
// Compared as TEXT, not cast to timestamptz. _review is unvalidated JSON, and one malformed value
// in one row would abort the whole cron request with "invalid input syntax for type timestamp with
// time zone". Every writer of this field uses toISOString(), which is fixed-width UTC, so
// lexicographic order and chronological order are the same thing and the comparison cannot throw.
async function countSubmissionsClaimedToday(userId: string): Promise<number> {
  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(generated_resumes)
    .where(and(
      eq(generated_resumes.user_id, userId),
      sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' >= ${startOfDay.toISOString()}`,
    ));
  return counted?.total ?? 0;
}

function runnerAttemptSource(): SubmissionAttemptBinding['source'] {
  return isManagedStratusProvider() ? 'managed_browser' : 'direct_browser';
}

function runnerAttemptBinding(
  row: ResumeRow,
  review: ApplicationReviewState,
  operation: SubmissionAttemptBinding['operation'],
  applicationId: string,
): SubmissionAttemptBinding {
  const claimId = review.submission_claim_id;
  if (!claimId || !review.submission_run_id) {
    throw new Error('Submission attempt reservation is missing its exact run or claim id');
  }
  return {
    // One claim releases one employer-boundary capability. Reusing the UUID here makes every
    // later route able to recover the immutable attempt without adding another mutable review key.
    attemptId: claimId,
    userId: row.user_id,
    packetId: row.id,
    applicationId,
    source: runnerAttemptSource(),
    operation,
    postingIdentity: freezePostingIdentity(row.job_context, review.portal_url),
    submissionRunId: review.submission_run_id,
    submissionClaimId: claimId,
    packetVersion: review.packet_audit?.packet_version ?? review.submission_packet_version ?? null,
  };
}

async function persistedRunnerAttemptBinding(
  row: ResumeRow,
  review: ApplicationReviewState,
): Promise<SubmissionAttemptBinding> {
  const claimId = review.submission_claim_id;
  if (!claimId) throw new Error('Submission attempt claim is missing');
  const events = await submissionAttemptEventsForPacket(row.user_id, row.id);
  const opened = events.find((event) => event.attempt_id === claimId && event.event_kind === 'attempt_opened');
  if (!opened) throw new Error('Submission attempt reservation was not durably recorded');
  return submissionAttemptBindingFromEvent(opened);
}

async function appendRunnerAttemptFact(
  binding: SubmissionAttemptBinding,
  eventKind: SubmissionAttemptEventKind,
  factKey: string,
  options: {
    proofKind?: SubmissionNotSentProofKind;
    evidenceCode?: string;
    observedAt?: Date;
  } = {},
): Promise<void> {
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(binding.attemptId, eventKind, factKey),
    eventKind,
    ...options,
  });
}

/**
 * Record a pre-click stop and its visible packet state as one authority decision.
 *
 * The old two-call pattern committed not_sent_proven, released the user lock, and only then wrote
 * a whole review object. A confirmation could linearize in that gap and the stale review would
 * delete its receipt because the run and claim identifiers intentionally remain stable. This
 * helper owns the user lock for the immutable fact, terminal check, and review write together.
 */
export async function writeReviewWithRunnerNotSentFact(
  row: ResumeRow,
  review: ApplicationReviewState,
  binding: SubmissionAttemptBinding,
  factKey: string,
  input: {
    proofKind: SubmissionNotSentProofKind;
    evidenceCode: string;
  },
): Promise<boolean> {
  const expected = readApplicationReview(row.spec);
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1).for('update');
    const latestReview = latest ? readApplicationReview(latest.spec) : null;
    if (!latest || !latestReview
      || latest.user_id !== binding.userId
      || latest.id !== binding.packetId
      || (latestReview.submission_run_id ?? null) !== (expected?.submission_run_id ?? null)
      || (latestReview.submission_claim_id ?? null) !== (expected?.submission_claim_id ?? null)) {
      return false;
    }
    const events = await submissionAttemptEventsForPacket(row.user_id, row.id, { executor: tx });
    const opening = events.find((event) => event.attempt_id === binding.attemptId
      && event.event_kind === 'attempt_opened');
    if (!opening || !isDeepStrictEqual(submissionAttemptBindingFromEvent(opening), binding)) {
      return false;
    }
    const exactEvents = events.filter((event) => event.attempt_id === binding.attemptId);
    if (exactEvents.some((event) => event.event_kind === 'boundary_authorized'
      || event.event_kind === 'press_observed'
      || event.event_kind === 'submission_confirmed')) {
      return false;
    }
    await appendSubmissionAttemptEvent({
      ...binding,
      eventId: submissionAttemptEventId(binding.attemptId, 'not_sent_proven', factKey),
      eventKind: 'not_sent_proven',
      proofKind: input.proofKind,
      evidenceCode: input.evidenceCode,
    }, { executor: tx });
    const updated = await tx.update(generated_resumes).set({
      spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(review)}::jsonb, true)`,
    }).where(and(
      eq(generated_resumes.id, latest.id),
      eq(generated_resumes.user_id, latest.user_id),
    )).returning({ id: generated_resumes.id });
    if (updated.length === 0) throw new Error('RUNNER_NOT_SENT_REVIEW_WRITE_CONFLICT');
    return true;
  });
}

class FinalSubmissionBoundaryBlockedError extends Error {
  constructor(readonly verdict: Exclude<DuplicateApplicationVerdict, { kind: 'clear' }>) {
    super(verdict.reason);
    this.name = 'FinalSubmissionBoundaryBlockedError';
  }
}

class FinalSubmissionBoundaryChangedError extends Error {
  constructor() {
    super('The reserved submission changed before the final employer boundary');
    this.name = 'FinalSubmissionBoundaryChangedError';
  }
}

class FinalSubmissionAuthorizationChangedError extends Error {
  constructor() {
    super('Submission authorization changed before the final employer boundary');
    this.name = 'FinalSubmissionAuthorizationChangedError';
  }
}

class FinalSubmissionBoundaryAlreadyAuthorizedError extends Error {
  constructor() {
    super('The reserved submission capability was already authorized');
    this.name = 'FinalSubmissionBoundaryAlreadyAuthorizedError';
  }
}

/**
 * Stratus bounds one retained-session continuation at 60 seconds. The parent boundary lease must
 * outlive that entire remote window plus enough time for the HTTP result to return and be recorded.
 * This fence is checked against the database clock under the same user lock as the continuation
 * CAS, so a lock wait or mailbox delay cannot spend a lease that only looks live to the app host.
 */
export const MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS = 60_000;
export const MANAGED_SECURITY_CODE_CONTINUATION_RESPONSE_MARGIN_MS = 10_000;
export const MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS =
  MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS
  + MANAGED_SECURITY_CODE_CONTINUATION_RESPONSE_MARGIN_MS;
export const MANAGED_SECURITY_CODE_CONTINUATION_DISPATCH_MARGIN_MS = 10_000;

export function managedProviderProgressDisposition(
  progress: ManagedBrowserRunProgress,
  expectedSubmitKind: 'application' | 'verification',
): 'none' | 'pressed' {
  const pressed = expectedSubmitKind === 'application'
    ? progress.phase === 0 && progress.submitKind === 'application' && progress.applicationSubmitPressed
    : progress.phase === 1 && progress.submitKind === 'verification' && progress.verificationSubmitPressed;
  if (!pressed) return 'none';
  /* Provider progress has no terminal URL, so it can prove that the physical press happened but
   * cannot bind a receipt to the immutable posting. The full result must pass exactAtsReceipt. */
  return 'pressed';
}

export class ManagedSecurityCodeContinuationRefusedError extends Error {
  constructor(readonly reason: 'lease_window_too_short' | 'duplicate_risk') {
    super(reason === 'lease_window_too_short'
      ? 'The retained employer verification session no longer has a safe execution window'
      : 'A duplicate-safety fact appeared before employer verification could continue');
    this.name = 'ManagedSecurityCodeContinuationRefusedError';
  }
}

export function finalBoundaryAuthorizationMatches(
  review: ApplicationReviewState,
  user: {
    enabled: boolean | null;
    consentedAt: Date | null;
    consentVersion: string | null;
  } | undefined,
  automaticSubmissionEntitled: boolean,
): boolean {
  const authorization = review.submission_authorization;
  if (authorization?.source === 'per_application_approval') return true;
  if (authorization?.source !== 'standing_consent'
    || user?.enabled !== true
    || !automaticSubmissionEntitled) return false;
  return Boolean(authorization.consented_at)
    && authorization.consented_at === user.consentedAt?.toISOString()
    && Boolean(authorization.consent_version)
    && authorization.consent_version === user.consentVersion;
}

export function finalRunnerReservationMatches(
  row: ResumeRow,
  review: ApplicationReviewState,
  attemptBinding: SubmissionAttemptBinding,
  latest: ResumeRow | null | undefined,
): boolean {
  if (!latest) return false;
  const latestReview = readApplicationReview(latest.spec);
  if (!latestReview) return false;
  const expectedSpec = JSON.parse(JSON.stringify({
    ...(row.spec as StoredSpec),
    _review: review,
  })) as StoredSpec;
  const latestPacketVersion = latestReview.packet_audit?.packet_version
    ?? latestReview.submission_packet_version
    ?? null;
  return isDeepStrictEqual(latest.spec, expectedSpec)
    && latest.resume_object_key === row.resume_object_key
    && isDeepStrictEqual(latest.job_context, row.job_context)
    && attemptBinding.packetId === latest.id
    && latestReview.submission_claim_id === attemptBinding.attemptId
    && (latestReview.submission_run_id ?? null) === attemptBinding.submissionRunId
    && latestPacketVersion === attemptBinding.packetVersion
    && isDeepStrictEqual(
      freezePostingIdentity(latest.job_context, latestReview.portal_url),
      attemptBinding.postingIdentity,
    );
}

export async function executeAfterFinalSubmissionBoundary<T, V = void>(
  verify: () => Promise<V>,
  externalBoundary: (verified: V) => Promise<T>,
): Promise<T> {
  const verified = await verify();
  return externalBoundary(verified);
}

/** Recheck under the user lock after reservation and immediately before an employer boundary. */
export async function assertFinalRunnerBoundaryClear(
  row: ResumeRow,
  review: ApplicationReviewState,
  attemptBinding: SubmissionAttemptBinding,
  options: { reuseAuthorization?: SubmissionBoundaryAuthorization } = {},
): Promise<SubmissionBoundaryAuthorization> {
  const result = await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    await assertSubmissionAccountNotDraining(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1);
    if (!finalRunnerReservationMatches(row, review, attemptBinding, latest)) {
      throw new FinalSubmissionBoundaryChangedError();
    }
    const latestReview = readApplicationReview(latest!.spec)!;
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
      }).from(users).where(eq(users.id, row.user_id)).limit(1);
      automaticSubmissionEntitled = (await getEntitlementSnapshot(
        row.user_id,
        new Date(),
        tx,
      )).features.automatic_submission;
    }
    if (!finalBoundaryAuthorizationMatches(
      latestReview,
      authorizationUser,
      automaticSubmissionEntitled,
    )) throw new FinalSubmissionAuthorizationChangedError();
    const verdict = await duplicateApplicationVerdict({
      userId: latest.user_id,
      applicationId: latest.id,
      jobContext: latest.job_context,
      portalUrl: latestReview.portal_url,
      excludeAttemptId: attemptBinding.attemptId,
    }, tx);
    if (verdict.kind !== 'clear') return { kind: 'blocked' as const, verdict };
    const authorization = await authorizeFinalSubmissionBoundary(attemptBinding, {
      executor: tx,
      factKey: 'runner-final-boundary',
      evidenceCode: `${attemptBinding.source}_employer_boundary_authorized`,
      ...(options.reuseAuthorization
        ? { activationId: options.reuseAuthorization.activationId }
        : {}),
    });
    if (authorization.kind === 'fresh') {
      return { kind: 'clear' as const, authorization: authorization.authorization };
    }
    if (authorization.kind === 'existing'
      && options.reuseAuthorization
      && authorization.authorization.active
      && authorization.authorization.activationId === options.reuseAuthorization.activationId
      && authorization.authorization.leaseId === options.reuseAuthorization.leaseId) {
      return { kind: 'clear' as const, authorization: authorization.authorization };
    }
    return { kind: 'already_authorized' as const, retrySafety: authorization.retrySafety };
  });
  if (result.kind === 'blocked') throw new FinalSubmissionBoundaryBlockedError(result.verdict);
  if (result.kind === 'already_authorized') throw new FinalSubmissionBoundaryAlreadyAuthorizedError();
  return result.authorization;
}

/** Keep provider preparation inside the same user-fence critical section as its final drain check. */
async function runManagedBrowserWithAccountFence(
  userId: string,
  ...args: Parameters<typeof runManagedBrowser>
): Promise<ManagedBrowserResult> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, userId);
    await assertSubmissionAccountNotDraining(tx, userId);
    return runManagedBrowser(...args);
  });
}

/** Keep every retained-session provider POST behind the account drain until the call finishes. */
async function continueManagedBrowserWithAccountFence(
  userId: string,
  continuationToken: Parameters<typeof continueManagedBrowser>[0],
  actions: Parameters<typeof continueManagedBrowser>[1],
  options: Parameters<typeof continueManagedBrowser>[2],
): Promise<ManagedBrowserResult> {
  if (options.requestBudget && options.timeoutMs !== undefined) {
    throw new Error('Fenced managed continuation cannot carry two request budgets');
  }
  if (!options.requestBudget && options.timeoutMs === undefined) {
    throw new Error('Fenced managed continuation requires one bounded request budget');
  }
  if (options.minimumDispatchBudgetMs === undefined) {
    throw new Error('Fenced managed continuation requires a minimum dispatch budget');
  }
  if (options.requestBudget && options.providerDeadlineAt === undefined) {
    throw new Error('Fenced managed continuation with a pre-existing budget requires its provider deadline');
  }
  const { timeoutMs, ...boundedOptions } = options;
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, userId);
    await assertSubmissionAccountNotDraining(tx, userId);
    const fenceNow = await databaseNow(tx);
    /* A budget we own starts only after the advisory lock is held. pg_advisory_xact_lock blocks
     * with no timeout, and this fence holds it across a whole provider call, so starting the clock
     * before the wait would charge another caller's provider call to this one and then trip the
     * minimum-dispatch assertion below on a call that still has its full window. */
    const requestBudget = options.requestBudget
      ?? startManagedBrowserRequestBudget(timeoutMs!);
    const providerDeadlineAt = options.providerDeadlineAt
      ?? new Date(fenceNow.getTime() + timeoutMs!).toISOString();
    assertManagedBrowserRequestBudgetAtClock(
      requestBudget,
      providerDeadlineAt,
      options.minimumDispatchBudgetMs!,
      fenceNow.getTime(),
    );
    return continueManagedBrowser(continuationToken, actions, {
      ...boundedOptions,
      requestBudget,
      providerDeadlineAt,
      minimumDispatchBudgetMs: options.minimumDispatchBudgetMs!,
    });
  });
}

/** Keep an initial provider callback behind its immutable database-clock authorization expiry. */
export function managedInitialCallTimeoutMs(authorization: SubmissionBoundaryAuthorization): number {
  const deadlineMs = Date.parse(managedInitialProviderDeadlineAt(authorization));
  const timeoutMs = Math.floor(deadlineMs - Date.parse(authorization.serverNow));
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 5 * 60 * 1000) {
    throw new FinalSubmissionBoundaryChangedError();
  }
  return timeoutMs;
}

/** Absolute database-clock cutoff sent through every layer of the initial managed provider call. */
export function managedInitialProviderDeadlineAt(
  authorization: SubmissionBoundaryAuthorization,
): string {
  const expiresAtMs = Date.parse(authorization.expiresAt);
  const serverNowMs = Date.parse(authorization.serverNow);
  const deadlineMs = expiresAtMs - MANAGED_SECURITY_CODE_CONTINUATION_RESPONSE_MARGIN_MS;
  if (!Number.isFinite(expiresAtMs)
    || !Number.isFinite(serverNowMs)
    || deadlineMs <= serverNowMs
    || deadlineMs - serverNowMs > 5 * 60 * 1000) {
    throw new FinalSubmissionBoundaryChangedError();
  }
  return new Date(deadlineMs).toISOString();
}

/** The immutable boundary activation is the one execution identity allowed to reach Stratus. */
export function managedInitialSubmissionAttempt(
  binding: SubmissionAttemptBinding,
  authorization: SubmissionBoundaryAuthorization,
): ManagedSubmissionAttempt {
  if (!binding.submissionRunId
    || !binding.submissionClaimId
    || binding.attemptId !== binding.submissionClaimId
    || authorization.attemptId !== binding.attemptId) {
    throw new FinalSubmissionBoundaryChangedError();
  }
  return {
    runId: binding.submissionRunId,
    claimId: binding.submissionClaimId,
    executionId: authorization.activationId,
  };
}

export function managedContinuationSubmissionAttempt(
  binding: SubmissionAttemptBinding,
  purpose: 'security_code' | 'receipt_observation',
): ManagedSubmissionAttempt {
  if (!binding.submissionRunId
    || !binding.submissionClaimId
    || binding.attemptId !== binding.submissionClaimId) {
    throw new FinalSubmissionBoundaryChangedError();
  }
  return {
    runId: binding.submissionRunId,
    claimId: binding.submissionClaimId,
    executionId: submissionAttemptEventId(
      binding.attemptId,
      'press_observed',
      `stratus-${purpose}-execution`,
    ),
  };
}

export function managedContinuationExecutionFingerprint(
  submissionAttempt: ManagedSubmissionAttempt,
): string {
  return managedContinuationAttemptFingerprint(submissionAttempt);
}

export type ManagedSecurityCodeContinuationRecoveryPlan =
  | { kind: 'none' }
  | {
      kind: 'invalid';
      reason: 'binding_mismatch' | 'execution_mismatch' | 'deadline_invalid';
      submissionAttempt: ManagedSubmissionAttempt | null;
    }
  | { kind: 'expired'; submissionAttempt: ManagedSubmissionAttempt; providerDeadlineAt: string }
  | { kind: 'poll'; submissionAttempt: ManagedSubmissionAttempt; providerDeadlineAt: string };

/**
 * Rebuild the only Stratus execution a persisted security-code continuation may observe.
 * The raw continuation credential is deliberately absent. Once continuation_resumed is true,
 * recovery is GET-only and the deterministic tuple is the complete remote authority.
 */
export function managedSecurityCodeContinuationRecoveryPlan(
  review: ApplicationReviewState,
  attemptBinding: SubmissionAttemptBinding,
  nowMs = Date.now(),
): ManagedSecurityCodeContinuationRecoveryPlan {
  const verification = review.verification;
  const bindingMatches = attemptBinding.source === 'managed_browser'
    && attemptBinding.operation === 'initial_submission'
    && review.submission_claim_id === attemptBinding.attemptId
    && review.submission_run_id === attemptBinding.submissionRunId
    && Boolean(attemptBinding.submissionRunId)
    && Boolean(attemptBinding.submissionClaimId);
  if (!attemptBinding.submissionRunId || !attemptBinding.submissionClaimId) {
    if (verification?.runner === 'stratus-managed'
      && verification.status === 'verification_pending'
      && verification.continuation_resumed === true) {
      return { kind: 'invalid', reason: 'binding_mismatch', submissionAttempt: null };
    }
    return { kind: 'none' };
  }
  const submissionAttempt = managedContinuationSubmissionAttempt(attemptBinding, 'security_code');
  return planManagedContinuationRecovery({
    state: verification ? {
      runner: verification.runner,
      status: verification.status,
      continuationResumed: verification.continuation_resumed,
      continuationExecutionFingerprint: verification.continuation_execution_fingerprint,
      continuationCallDeadlineAt: verification.continuation_call_deadline_at,
    } : undefined,
    bindingMatches,
    submissionAttempt,
    nowMs,
  });
}

/** A claimed continuation remains cron-visible even though its durable handoff uses needs_attention. */
export function managedSecurityCodeContinuationRecoveryIsHeld(
  review: ApplicationReviewState | null | undefined,
): boolean {
  return Boolean(
    review?.submission_claim_id
    && review.submission_claimed_at
    && review.verification?.runner === 'stratus-managed'
    && (
      (review.verification.status === 'searching'
        && review.verification.continuation_resumed === false)
      || (review.verification.status === 'verification_pending'
        && review.verification.continuation_resumed === true)
    ),
  );
}

/**
 * Consume the one retained-session verification submit already covered by the parent application
 * attempt. The first press has permanently made that parent a duplicate risk, so the continuation
 * does not mint a second attempt. Instead, this gate atomically changes the exact continuation from
 * unconsumed to pending under the user lock. Every receipt and uncertainty fact remains on the
 * parent, allowing confirmation to close the whole flow while a lost result stays blocked.
 */
export async function assertManagedSecurityCodeContinuationBoundaryClear(
  row: ResumeRow,
  review: ApplicationReviewState,
  attemptBinding: SubmissionAttemptBinding,
  continuationFingerprint: string,
  submissionAttempt: ManagedSubmissionAttempt,
  providerExpiresAt: string,
  continuationSecurityCode: NonNullable<ApplicationReviewState['security_code']>,
  cleanupMarkers: readonly ManagedTerminalCleanupMarker[] = [],
): Promise<{ providerDeadlineAt: string }> {
  if (
    attemptBinding.source !== 'managed_browser'
    || attemptBinding.parentAttemptId
    || attemptBinding.packetId !== row.id
    || attemptBinding.userId !== row.user_id
    || attemptBinding.attemptId !== review.submission_claim_id
    || attemptBinding.submissionClaimId !== review.submission_claim_id
    || attemptBinding.submissionRunId !== review.submission_run_id
    || submissionAttempt.runId !== attemptBinding.submissionRunId
    || submissionAttempt.claimId !== attemptBinding.submissionClaimId
    || !continuationFingerprint.trim()
    || !providerExpiresAt.trim()
    || !continuationSecurityCode.submit_was_authorized
  ) throw new FinalSubmissionBoundaryChangedError();
  const executionFingerprint = managedContinuationExecutionFingerprint(submissionAttempt);

  const result = await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    await assertSubmissionAccountNotDraining(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1);
    if (!finalRunnerReservationMatches(row, review, attemptBinding, latest)) {
      return { kind: 'changed' as const };
    }
    const latestReview = readApplicationReview(latest!.spec)!;
    const verification = latestReview.verification;
    if (
      !latestReview.security_code
      || verification?.status !== 'searching'
      || verification.runner !== 'stratus-managed'
      || verification.continuation_fingerprint !== continuationFingerprint
      || verification.continuation_execution_fingerprint !== executionFingerprint
      || verification.continuation_resumed !== false
    ) return { kind: 'changed' as const };

    const persistRefusal = async (
      reason: ManagedSecurityCodeContinuationRefusedError['reason'],
      observedAt: string,
    ) => {
      const refusedReview = managedSecurityCodeContinuationRefusalReview(
        latestReview,
        reason,
        observedAt,
        continuationSecurityCode,
      );
      const foldedSpec = specWithManagedTerminalFold(
        latest!.spec,
        refusedReview,
        cleanupMarkers,
      );
      const updated = await tx.update(generated_resumes).set({
        spec: sql`${JSON.stringify(foldedSpec)}::jsonb`,
      }).where(and(
        eq(generated_resumes.id, latest!.id),
        eq(generated_resumes.user_id, latest!.user_id),
        sql`${generated_resumes.spec} = ${JSON.stringify(latest!.spec)}::jsonb`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${attemptBinding.attemptId}`,
        sql`${generated_resumes.spec}->'_review'->'verification'->>'continuation_resumed' = 'false'`,
      )).returning({ id: generated_resumes.id });
      return updated.length > 0
        ? { kind: 'refused' as const, reason }
        : { kind: 'changed' as const };
    };

    const initialAuthorization = await submissionBoundaryAuthorization(
      row.user_id,
      attemptBinding.attemptId,
      { executor: tx },
    );
    const exactEvents = (await submissionAttemptEventsForPacket(row.user_id, row.id, { executor: tx }))
      .filter((event) => event.attempt_id === attemptBinding.attemptId);
    const parentHasOneAuthorizedUnresolvedPress = Boolean(initialAuthorization)
      && exactEvents.filter((event) => event.event_kind === 'boundary_authorized').length === 1
      && exactEvents.some((event) => event.event_kind === 'press_observed')
      && !exactEvents.some((event) => event.event_kind === 'submission_confirmed'
        || event.event_kind === 'not_sent_proven');
    if (!parentHasOneAuthorizedUnresolvedPress || !initialAuthorization) {
      return { kind: 'changed' as const };
    }

    const duplicate = await duplicateApplicationVerdict({
      userId: latest!.user_id,
      applicationId: latest!.id,
      jobContext: latest!.job_context,
      portalUrl: latestReview.portal_url,
      excludeAttemptId: attemptBinding.attemptId,
    }, tx);
    if (duplicate.kind !== 'clear') {
      return persistRefusal('duplicate_risk', initialAuthorization.serverNow);
    }

    // Refresh the database clock after every potentially slow duplicate query. The first read only
    // established immutable parent lineage; this one decides whether a new remote call may start.
    const authorization = await submissionBoundaryAuthorization(
      row.user_id,
      attemptBinding.attemptId,
      { executor: tx },
    );
    if (!authorization) return { kind: 'changed' as const };
    const serverNowMs = Date.parse(authorization.serverNow);
    const boundaryExpiresAtMs = Date.parse(authorization.expiresAt);
    const providerExpiresAtMs = Date.parse(providerExpiresAt);
    const providerDeadlineAtMs = serverNowMs + MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS;
    const minimumSafeExpiryMs = providerDeadlineAtMs
      + MANAGED_SECURITY_CODE_CONTINUATION_DISPATCH_MARGIN_MS;
    if (!Number.isFinite(serverNowMs)
      || !Number.isFinite(boundaryExpiresAtMs)
      || !Number.isFinite(providerExpiresAtMs)
      || boundaryExpiresAtMs <= minimumSafeExpiryMs
      || providerExpiresAtMs <= minimumSafeExpiryMs) {
      return persistRefusal('lease_window_too_short', authorization.serverNow);
    }
    const providerDeadlineAt = new Date(providerDeadlineAtMs).toISOString();

    const [authorizationUser] = await tx.select({
      enabled: users.automatic_submission_enabled,
      consentedAt: users.automatic_submission_consented_at,
      consentVersion: users.automatic_submission_consent_version,
    }).from(users).where(eq(users.id, row.user_id)).limit(1);
    const automaticSubmissionEntitled = (await getEntitlementSnapshot(
      row.user_id,
      new Date(authorization.serverNow),
      tx,
    )).features.automatic_submission;
    if (!finalBoundaryAuthorizationMatches(
      latestReview,
      authorizationUser,
      automaticSubmissionEntitled,
    )) return { kind: 'authorization_changed' as const };

    const pendingReview = nextReview(latestReview, {
      security_code: continuationSecurityCode,
      verification: {
        ...verification,
        status: 'verification_pending',
        continuation_resumed: true,
        continuation_call_started_at: authorization.serverNow,
        // This is the provider budget approved under the database lock, not the broader parent
        // lease. The caller starts the matching timer before entering this gate and never restarts
        // it after commit, so an accepted callback cannot cross this applicant-resolution fence.
        continuation_call_deadline_at: providerDeadlineAt,
      },
    });
    const updated = await tx.update(generated_resumes).set({
      spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(pendingReview)}::jsonb, true)`,
    }).where(and(
      eq(generated_resumes.id, latest!.id),
      eq(generated_resumes.user_id, latest!.user_id),
      sql`${generated_resumes.spec} = ${JSON.stringify(latest!.spec)}::jsonb`,
      sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${attemptBinding.attemptId}`,
      sql`${generated_resumes.spec}->'_review'->'verification'->>'continuation_resumed' = 'false'`,
    )).returning({ id: generated_resumes.id });
    return updated.length > 0
      ? { kind: 'clear' as const, providerDeadlineAt }
      : { kind: 'changed' as const };
  });
  if (result.kind === 'refused') throw new ManagedSecurityCodeContinuationRefusedError(result.reason);
  if (result.kind === 'authorization_changed') throw new FinalSubmissionAuthorizationChangedError();
  if (result.kind !== 'clear') throw new FinalSubmissionBoundaryAlreadyAuthorizedError();
  return { providerDeadlineAt: result.providerDeadlineAt };
}

function mergeManagedSecurityCodeEvidence(
  latest: ApplicationReviewState['security_code'],
  incoming: ApplicationReviewState['security_code'],
): ApplicationReviewState['security_code'] {
  if (!incoming) return latest;
  if (!latest) return incoming;
  const latestRequestedAt = Date.parse(latest.requested_at);
  const incomingRequestedAt = Date.parse(incoming.requested_at);
  const incomingIsNewer = Number.isFinite(incomingRequestedAt)
    && (!Number.isFinite(latestRequestedAt) || incomingRequestedAt >= latestRequestedAt);
  const mergedBase = {
    ...(incomingIsNewer ? latest : incoming),
    ...(incomingIsNewer ? incoming : latest),
    attempts: latest.attempts,
  };
  return withSecurityCodeAttempts(mergedBase, incoming.attempts ?? []);
}

function mergeManagedVerificationEvidence(
  latest: ApplicationReviewState['verification'],
  incoming: ApplicationReviewState['verification'],
): ApplicationReviewState['verification'] {
  if (!incoming) return latest;
  const merged = { ...latest, ...incoming };
  if (!latest) return merged;
  // Continuation identity and consumption are monotonic. A stale outcome may change the visible
  // status, but it cannot turn a consumed exact capability back into an unconsumed one or shorten
  // the callback-live fence that a resolver trusts.
  return {
    ...merged,
    ...(latest.runner ? { runner: latest.runner } : {}),
    ...(latest.continuation_fingerprint
      ? { continuation_fingerprint: latest.continuation_fingerprint }
      : {}),
    ...(latest.continuation_execution_fingerprint
      ? { continuation_execution_fingerprint: latest.continuation_execution_fingerprint }
      : {}),
    ...(latest.continuation_resumed !== undefined
      ? { continuation_resumed: latest.continuation_resumed }
      : {}),
    ...(latest.continuation_call_started_at
      ? { continuation_call_started_at: latest.continuation_call_started_at }
      : {}),
    ...(latest.continuation_call_deadline_at
      ? { continuation_call_deadline_at: latest.continuation_call_deadline_at }
      : {}),
  };
}

type ManagedAuthorizedUnverifiedInput = {
  message: string;
  attentionReason: string;
  attentionCategories: ApplicationAttentionCategory[];
  securityCode?: ApplicationReviewState['security_code'];
  verification?: ApplicationReviewState['verification'];
  previewUrl?: string;
  network?: NonNullable<ApplicationReviewState['unverified_submission']>['network'];
  challengeOnScreen?: boolean;
  requireContinuationResumed?: boolean;
  allowInvalidContinuationBinding?: boolean;
  cleanupMarkers?: readonly ManagedTerminalCleanupMarker[];
  cleanupQuarantines?: readonly ManagedTerminalCleanupQuarantine[];
};

/** Every managed stop after boundary authorization remains an unresolved parent, never not-sent. */
export async function recordManagedAuthorizedAttemptUnverified(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  input: ManagedAuthorizedUnverifiedInput,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1);
    const latestReview = latest ? readApplicationReview(latest.spec) : null;
    if (!latest || !latestReview) return false;
    if (input.allowInvalidContinuationBinding
      && !isDeepStrictEqual(latest.spec, row.spec)) return false;
    if (!input.allowInvalidContinuationBinding
      && (latestReview.submission_claim_id !== attemptBinding.attemptId
        || latestReview.submission_run_id !== attemptBinding.submissionRunId)) return false;
    if (input.requireContinuationResumed && (
      latestReview.verification?.runner !== 'stratus-managed'
      || latestReview.verification.continuation_resumed !== true
    )) return false;
    const authorization = await submissionBoundaryAuthorization(
      row.user_id,
      attemptBinding.attemptId,
      { executor: tx },
    );
    if (!authorization) return false;
    const exactEvents = (await submissionAttemptEventsForPacket(row.user_id, row.id, { executor: tx }))
      .filter((event) => event.attempt_id === attemptBinding.attemptId);
    if (exactEvents.some((event) => event.event_kind === 'submission_confirmed'
        || event.event_kind === 'not_sent_proven')) return false;
    const mergedSecurityCode = mergeManagedSecurityCodeEvidence(
      latestReview.security_code,
      input.securityCode,
    );
    const mergedVerification = mergeManagedVerificationEvidence(
      latestReview.verification,
      input.verification,
    );
    const unresolved = nextReview(latestReview, {
      ...unverifiedSubmissionPatch(latestReview, {
        at: authorization.serverNow,
        cause: 'no_confirmation_state',
        ...(input.previewUrl ? { previewUrl: input.previewUrl } : {}),
        ...(input.network ? { network: input.network } : {}),
        ...(input.challengeOnScreen ? { challengeOnScreen: true } : {}),
      }),
      ...(mergedSecurityCode ? { security_code: mergedSecurityCode } : {}),
      ...(mergedVerification ? { verification: mergedVerification } : {}),
      submission_error: input.message.slice(0, 500),
      attention_reason: input.attentionReason,
      attention_categories: input.attentionCategories,
    });
    const conditions = [
      eq(generated_resumes.id, latest.id),
      eq(generated_resumes.user_id, latest.user_id),
      sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
    ];
    if (!input.allowInvalidContinuationBinding) {
      conditions.push(sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${attemptBinding.attemptId}`);
    }
    if (input.requireContinuationResumed) {
      conditions.push(sql`${generated_resumes.spec}->'_review'->'verification'->>'continuation_resumed' = 'true'`);
    }
    const foldedSpec = specWithManagedTerminalFold(
      latest.spec,
      unresolved,
      input.cleanupMarkers ?? [],
      input.cleanupQuarantines ?? [],
    );
    const updated = await tx.update(generated_resumes).set({
      spec: sql`${JSON.stringify(foldedSpec)}::jsonb`,
    }).where(and(...conditions)).returning({ id: generated_resumes.id });
    return updated.length > 0;
  });
}

/** Persist exact post-call uncertainty after the provider capability was consumed. */
export async function recordManagedSecurityCodeContinuationUnverified(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  message: string,
  options: {
    previewUrl?: string;
    securityCode?: ApplicationReviewState['security_code'];
    verification?: ApplicationReviewState['verification'];
    cleanupMarkers?: readonly ManagedTerminalCleanupMarker[];
    cleanupQuarantines?: readonly ManagedTerminalCleanupQuarantine[];
    allowInvalidContinuationBinding?: boolean;
  } = {},
): Promise<boolean> {
  return recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
    message,
    attentionReason: 'Litos used the employer verification control, but could not prove the final result. Check the employer portal and record whether this exact application was received.',
    attentionCategories: ['security_code', 'unverified_submission'],
    ...(options.previewUrl ? { previewUrl: options.previewUrl } : {}),
    ...(options.securityCode ? { securityCode: options.securityCode } : {}),
    ...(options.cleanupMarkers ? { cleanupMarkers: options.cleanupMarkers } : {}),
    ...(options.cleanupQuarantines ? { cleanupQuarantines: options.cleanupQuarantines } : {}),
    ...(options.allowInvalidContinuationBinding
      ? { allowInvalidContinuationBinding: true }
      : {}),
    verification: {
      ...options.verification,
      status: 'handoff',
    },
    requireContinuationResumed: true,
  });
}

/** Durably bind the retained provider capability to the exact challenged parent before polling. */
export async function recordManagedSecurityCodeContinuationSearch(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  input: {
    securityCode: NonNullable<ApplicationReviewState['security_code']>;
    verification: NonNullable<ApplicationReviewState['verification']>;
  },
): Promise<{ row: ResumeRow; review: ApplicationReviewState } | null> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1);
    const latestReview = latest ? readApplicationReview(latest.spec) : null;
    if (!latest || !latestReview
      || latestReview.submission_claim_id !== attemptBinding.attemptId
      || latestReview.submission_run_id !== attemptBinding.submissionRunId) return null;
    if (latestReview.verification?.runner === 'stratus-managed'
      && latestReview.verification.continuation_resumed !== undefined) {
      const sameSearch = latestReview.verification.status === 'searching'
        && latestReview.verification.continuation_resumed === false
        && latestReview.verification.continuation_fingerprint
          === input.verification.continuation_fingerprint
        && latestReview.verification.continuation_execution_fingerprint
          === input.verification.continuation_execution_fingerprint
        && latestReview.verification.requested_at === input.verification.requested_at
        && latestReview.security_code?.digits === input.securityCode.digits
        && (latestReview.security_code.sent_to ?? '').trim().toLowerCase()
          === (input.securityCode.sent_to ?? '').trim().toLowerCase()
        && latestReview.security_code.requested_at === input.securityCode.requested_at
        && latestReview.security_code.submit_was_authorized
          === input.securityCode.submit_was_authorized;
      return sameSearch ? { row: latest, review: latestReview } : null;
    }
    const authorization = await submissionBoundaryAuthorization(
      row.user_id,
      attemptBinding.attemptId,
      { executor: tx },
    );
    if (!authorization) return null;
    const exactEvents = (await submissionAttemptEventsForPacket(row.user_id, row.id, { executor: tx }))
      .filter((event) => event.attempt_id === attemptBinding.attemptId);
    if (exactEvents.some((event) => event.event_kind === 'submission_confirmed'
        || event.event_kind === 'not_sent_proven')) return null;
    const searchingReview = nextReview(latestReview, {
      ...unverifiedSubmissionPatch(latestReview, {
        at: authorization.serverNow,
        cause: 'no_confirmation_state',
      }),
      security_code: mergeManagedSecurityCodeEvidence(latestReview.security_code, input.securityCode),
      verification: mergeManagedVerificationEvidence(latestReview.verification, input.verification),
      submission_error: 'Employer verification is pending in the retained managed session',
      attention_categories: ['security_code', 'unverified_submission'],
    });
    const [updated] = await tx.update(generated_resumes).set({
      spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(searchingReview)}::jsonb, true)`,
    }).where(and(
      eq(generated_resumes.id, latest.id),
      eq(generated_resumes.user_id, latest.user_id),
      sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
      sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${attemptBinding.attemptId}`,
    )).returning();
    return updated ? { row: updated, review: searchingReview } : null;
  });
}

type ManagedSubmissionConfirmedInput = {
  capturedAt: string;
  verification: ApplicationReviewState['verification'];
  securityCode?: ApplicationReviewState['security_code'];
  receipt: NonNullable<ApplicationReviewState['receipt']>;
  receiptEvidence: {
    result: ManagedReceiptResult;
    expectedApplicationUrl: string;
  };
  cleanupMarkers?: readonly ManagedTerminalCleanupMarker[];
  /** Test seam for proving the exact commit heals one whole-row CAS loss. */
  beforeConfirmedProjectionWrite?: (
    latest: ResumeRow,
    executor: Pick<typeof db, 'update'>,
    attemptNumber: number,
  ) => Promise<void>;
};

type VerifiedSubmissionConfirmedInput = Pick<
  ManagedSubmissionConfirmedInput,
  'capturedAt' | 'verification' | 'securityCode' | 'receipt' | 'cleanupMarkers' | 'beforeConfirmedProjectionWrite'
> & {
  factKey: string;
  evidenceCode: string;
};

const RUNNER_CONFIRMED_PROJECTION_AUTHORITY_REQUIRED =
  'RUNNER_CONFIRMED_PROJECTION_AUTHORITY_REQUIRED';

function runnerConfirmedProjectionErrorIsRepairable(error: unknown): boolean {
  return error instanceof CanonicalPacketBindingError
    || error instanceof CanonicalApplicationProjectionConflictError
    || (error instanceof Error
      && error.message === RUNNER_CONFIRMED_PROJECTION_AUTHORITY_REQUIRED);
}

function runnerRepairRequiredReview(
  review: ApplicationReviewState,
  attemptBinding: SubmissionAttemptBinding,
  receipt: NonNullable<ApplicationReviewState['receipt']>,
  receiptAt: string,
): ApplicationReviewState {
  return nextReview(review, {
    status: 'needs_attention',
    submitted_at: undefined,
    receipt,
    submission_error: undefined,
    attention_reason: 'Litos captured the employer receipt, but its saved application projection '
      + 'needs repair. Do not send this application again.',
    attention_categories: ['unverified_submission'],
    unverified_submission: {
      at: receiptAt,
      cause: 'no_confirmation_state',
      portal_url: attemptBinding.postingIdentity.portalUrl ?? receipt.final_url,
      ...(attemptBinding.submissionRunId
        ? { submission_run_id: attemptBinding.submissionRunId }
        : {}),
    },
  });
}

async function commitVerifiedSubmissionConfirmed(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  input: VerifiedSubmissionConfirmedInput,
): Promise<boolean> {
  await input.beforeConfirmedProjectionWrite?.(row, db, 1);
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1).for('update');
    const latestReview = latest ? readApplicationReview(latest.spec) : null;
    if (!latest || !latestReview
      || latest.user_id !== attemptBinding.userId
      || latest.id !== attemptBinding.packetId) return false;
    const events = await submissionAttemptEventsForPacket(row.user_id, row.id, { executor: tx });
    const opening = events.find((event) => event.attempt_id === attemptBinding.attemptId
      && event.event_kind === 'attempt_opened');
    if (!opening
      || !isDeepStrictEqual(submissionAttemptBindingFromEvent(opening), attemptBinding)) return false;
    const exactEvents = events.filter((event) => event.attempt_id === attemptBinding.attemptId);
    if (!exactEvents.some((event) => event.event_kind === 'boundary_authorized')
      || !exactEvents.some((event) => event.event_kind === 'press_observed')) return false;
    const providerEventId = submissionAttemptEventId(
      attemptBinding.attemptId,
      'submission_confirmed',
      input.factKey,
    );
    const existingProviderConfirmation = exactEvents.find((event) =>
      event.event_kind === 'submission_confirmed' && event.event_id === providerEventId);
    const receiptAt = existingProviderConfirmation?.observed_at.toISOString() ?? input.capturedAt;
    if (!existingProviderConfirmation) {
      await appendSubmissionAttemptEvent({
        ...attemptBinding,
        eventId: providerEventId,
        eventKind: 'submission_confirmed',
        evidenceCode: input.evidenceCode,
        observedAt: new Date(receiptAt),
      }, { executor: tx });
    }
    const securityCode = mergeManagedSecurityCodeEvidence(
      latestReview.security_code,
      input.securityCode,
    );
    const verification = mergeManagedVerificationEvidence(
      latestReview.verification,
      input.verification,
    );
    const priorProviderReceipt = existingProviderConfirmation
      && latestReview.receipt
      && latestReview.receipt.captured_at === receiptAt
      && latestReview.receipt.source === input.receipt.source
      ? latestReview.receipt
      : null;
    const receipt = {
      ...(priorProviderReceipt ?? input.receipt),
      ...(input.receipt.screenshot_url ? { screenshot_url: input.receipt.screenshot_url } : {}),
      captured_at: receiptAt,
    };
    const submitted = nextReview(latestReview, {
      status: 'submitted',
      submitted_at: receiptAt,
      submission_error: undefined,
      attention_reason: undefined,
      attention_categories: undefined,
      ...(verification ? { verification } : {}),
      ...(securityCode ? { security_code: securityCode } : {}),
      ...(latestReview.unverified_submission ? {
        unverified_submission: {
          ...latestReview.unverified_submission,
          resolution: 'sent',
          resolved_at: receiptAt,
        },
      } : {}),
      receipt,
    });
    let canonicalTargetResolved = true;
    try {
      await canonicalApplicationForAttemptProjection(tx, attemptBinding);
    } catch {
      canonicalTargetResolved = false;
    }
    if (canonicalTargetResolved) {
      try {
        return await tx.transaction(async (projectionTx) => {
          const foldedSpec = specWithManagedTerminalFold(
            latest.spec,
            submitted,
            input.cleanupMarkers ?? [],
          );
          const updated = await projectionTx.update(generated_resumes).set({
            spec: sql`${JSON.stringify(foldedSpec)}::jsonb`,
            ...confirmedPacketPipelineProjection(new Date(receiptAt)),
          }).where(and(
            eq(generated_resumes.id, latest.id),
            eq(generated_resumes.user_id, latest.user_id),
          )).returning({ id: generated_resumes.id });
          if (updated.length === 0) {
            throw new Error(RUNNER_CONFIRMED_PROJECTION_AUTHORITY_REQUIRED);
          }
          await syncCanonicalApplicationRow({
            packetId: row.id,
            userId: row.user_id,
            applicationId: attemptBinding.applicationId,
            postingIdentity: attemptBinding.postingIdentity,
          }, projectionTx);
          const canonical = await canonicalApplicationForAttemptProjection(
            projectionTx,
            attemptBinding,
          );
          const projections = await authoritativeSubmissionProjection({
            userId: row.user_id,
            packetIds: [row.id],
            applicationIds: [canonical.id],
            executor: projectionTx,
          });
          const expected = {
            attemptId: attemptBinding.attemptId,
            canonicalApplicationId: canonical.id,
            packetId: row.id,
          };
          if (!authoritativeConfirmedProjectionMatches(
            projections.byPacketId.get(row.id),
            expected,
          ) || !authoritativeConfirmedProjectionMatches(
            projections.byApplicationId.get(canonical.id),
            expected,
          )) throw new Error(RUNNER_CONFIRMED_PROJECTION_AUTHORITY_REQUIRED);
          return true;
        });
      } catch (error) {
        if (!runnerConfirmedProjectionErrorIsRepairable(error)) throw error;
      }
    }
    const repair = runnerRepairRequiredReview(
      latestReview,
      attemptBinding,
      receipt,
      receiptAt,
    );
    const repairSpec = specWithManagedTerminalFold(
      latest.spec,
      repair,
      input.cleanupMarkers ?? [],
    );
    await tx.update(generated_resumes).set({
      spec: sql`${JSON.stringify(repairSpec)}::jsonb`,
    }).where(and(
      eq(generated_resumes.id, latest.id),
      eq(generated_resumes.user_id, latest.user_id),
    ));
    return false;
  });
}

/**
 * Confirmation is the strongest exact-attempt fact. Append it and heal the packet projection under
 * one user lock, even if a safe-expiry applicant answer cleared the claim just before the receipt.
 */
export async function recordManagedSubmissionConfirmed(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  input: ManagedSubmissionConfirmedInput,
): Promise<boolean> {
  if ((attemptBinding.source !== 'managed_browser' && attemptBinding.source !== 'direct_browser')
    || (attemptBinding.operation !== 'initial_submission'
      && attemptBinding.operation !== 'security_code_continuation')
    || !attemptBinding.postingIdentity.portalUrl) return false;
  let expectedApplicationUrl: string;
  try {
    expectedApplicationUrl = portalApplicationUrl(
      detectPortal(attemptBinding.postingIdentity.portalUrl),
      attemptBinding.postingIdentity.portalUrl,
    );
  } catch {
    return false;
  }
  if (input.receiptEvidence.expectedApplicationUrl !== expectedApplicationUrl) return false;
  const exactVerdict = exactManagedSubmitVerdict(
    input.receiptEvidence.result,
    expectedApplicationUrl,
  );
  if (exactVerdict.kind !== 'confirmed'
    || typeof input.receiptEvidence.result.url !== 'string'
    || input.receipt.final_url !== input.receiptEvidence.result.url
    || input.receipt.confirmation_text !== exactVerdict.confirmationText
    || input.receipt.captured_at !== input.capturedAt
    || input.receipt.source !== 'managed_browser') return false;
  const acceptedSecurityCode = input.securityCode?.attempts?.some(
    (attempt) => attempt.outcome === 'accepted',
  ) === true;
  return commitVerifiedSubmissionConfirmed(row, attemptBinding, {
    capturedAt: input.capturedAt,
    verification: input.verification,
    ...(input.securityCode ? { securityCode: input.securityCode } : {}),
    receipt: input.receipt,
    factKey: 'managed-receipt',
    evidenceCode: attemptBinding.operation === 'security_code_continuation' || acceptedSecurityCode
      ? 'managed_security_code_receipt'
      : 'managed_application_receipt',
    ...(input.cleanupMarkers ? { cleanupMarkers: input.cleanupMarkers } : {}),
    ...(input.beforeConfirmedProjectionWrite
      ? { beforeConfirmedProjectionWrite: input.beforeConfirmedProjectionWrite }
      : {}),
  });
}

export type ManagedTerminalRecoveryOutcome = 'not_recoverable' | 'pending' | 'folded';

const MANAGED_TERMINAL_CLEANUP_ENTRY_VERSION = 'managed-terminal-cleanup-entry-v2' as const;
const MANAGED_TERMINAL_CLEANUP_OUTBOX_VERSION = 'managed-terminal-cleanup-outbox-v2' as const;
const MANAGED_TERMINAL_CLEANUP_OUTBOX_KEY = '_managed_terminal_cleanup_outbox';
const MANAGED_TERMINAL_CLEANUP_QUARANTINE_VERSION = 'managed-terminal-cleanup-quarantine-v1' as const;
const MANAGED_TERMINAL_CLEANUP_QUARANTINE_KEY = '_managed_terminal_cleanup_quarantine';
const MANAGED_TERMINAL_RESULT_ID = /^[a-f0-9]{64}$/u;
const MANAGED_SUBMISSION_ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export function managedTerminalCleanupRetrievalDisposition(
  state: 'pending' | 'not_found' | 'completed' | 'failed' | 'indeterminate' | 'gone',
): 'retry' | 'acknowledge' | 'complete' {
  if (state === 'gone') return 'complete';
  if (state === 'completed' || state === 'failed' || state === 'indeterminate') {
    return 'acknowledge';
  }
  return 'retry';
}

const MANAGED_TERMINAL_CLEANUP_FAIRNESS_WINDOW_MS = 60_000;

export function managedTerminalCleanupBatchWindow(
  totalRows: number,
  batchSize: number,
  nowMs = Date.now(),
): { firstOffset: number; firstLimit: number; wrapLimit: number } {
  if (!Number.isSafeInteger(totalRows) || totalRows <= 0
    || !Number.isSafeInteger(batchSize) || batchSize <= 0
    || !Number.isFinite(nowMs)) {
    return { firstOffset: 0, firstLimit: 0, wrapLimit: 0 };
  }
  const boundedBatchSize = Math.min(batchSize, totalRows);
  if (boundedBatchSize === totalRows) {
    return { firstOffset: 0, firstLimit: totalRows, wrapLimit: 0 };
  }
  const cycle = Math.max(0, Math.floor(nowMs / MANAGED_TERMINAL_CLEANUP_FAIRNESS_WINDOW_MS));
  const firstOffset = ((cycle % totalRows) * boundedBatchSize) % totalRows;
  const firstLimit = Math.min(boundedBatchSize, totalRows - firstOffset);
  return {
    firstOffset,
    firstLimit,
    wrapLimit: boundedBatchSize - firstLimit,
  };
}

export type ManagedTerminalCleanupMarker = {
  version: typeof MANAGED_TERMINAL_CLEANUP_ENTRY_VERSION;
  attemptId: string;
  submissionAttempt: ManagedSubmissionAttempt;
  resultId: string | null;
};

export type BoundManagedTerminalCleanupMarker = ManagedTerminalCleanupMarker & { resultId: string };

export type ManagedTerminalCleanupOutbox = {
  version: typeof MANAGED_TERMINAL_CLEANUP_OUTBOX_VERSION;
  entries: Record<string, ManagedTerminalCleanupMarker>;
};

export type ManagedTerminalCleanupQuarantine = {
  version: typeof MANAGED_TERMINAL_CLEANUP_QUARANTINE_VERSION;
  attemptId: string;
  reason: 'binding_mismatch' | 'execution_mismatch' | 'deadline_invalid';
  continuationExecutionFingerprint: string | null;
};

function managedTerminalCleanupQuarantineKey(entry: ManagedTerminalCleanupQuarantine): string {
  return `${entry.attemptId}:${entry.reason}:${entry.continuationExecutionFingerprint ?? 'unreconstructible'}`;
}

function exactManagedTerminalCleanupQuarantine(input: {
  attemptId: string;
  reason: ManagedTerminalCleanupQuarantine['reason'];
  continuationExecutionFingerprint?: string | null;
}): ManagedTerminalCleanupQuarantine {
  const attemptId = input.attemptId.toLowerCase();
  if (!MANAGED_SUBMISSION_ATTEMPT_ID.test(attemptId)) {
    throw new Error('Managed terminal cleanup quarantine requires an exact attempt ID');
  }
  const fingerprint = input.continuationExecutionFingerprint?.trim().toLowerCase() ?? null;
  if (fingerprint !== null && !MANAGED_TERMINAL_RESULT_ID.test(fingerprint)) {
    throw new Error('Managed terminal cleanup quarantine requires an exact execution fingerprint');
  }
  return {
    version: MANAGED_TERMINAL_CLEANUP_QUARANTINE_VERSION,
    attemptId,
    reason: input.reason,
    continuationExecutionFingerprint: fingerprint,
  };
}

export function specWithManagedTerminalCleanupQuarantines(
  spec: unknown,
  quarantines: readonly ManagedTerminalCleanupQuarantine[],
): Record<string, unknown> {
  const nextSpec = spec && typeof spec === 'object' && !Array.isArray(spec)
    ? { ...(spec as Record<string, unknown>) }
    : {};
  if (quarantines.length === 0) return nextSpec;
  const raw = nextSpec[MANAGED_TERMINAL_CLEANUP_QUARANTINE_KEY];
  const current = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : null;
  if (raw !== undefined && (!current
    || current.version !== MANAGED_TERMINAL_CLEANUP_QUARANTINE_VERSION
    || !current.entries
    || typeof current.entries !== 'object'
    || Array.isArray(current.entries))) {
    throw new Error('Managed terminal cleanup quarantine is malformed');
  }
  const entries = { ...((current?.entries as Record<string, unknown> | undefined) ?? {}) };
  for (const quarantine of quarantines) {
    const exact = exactManagedTerminalCleanupQuarantine(quarantine);
    if (!isDeepStrictEqual(exact, quarantine)) {
      throw new Error('Managed terminal cleanup quarantine requires exact normalized entries');
    }
    const key = managedTerminalCleanupQuarantineKey(exact);
    const existing = entries[key];
    if (existing && !isDeepStrictEqual(existing, exact)) {
      throw new Error('Managed terminal cleanup quarantine key is already bound');
    }
    entries[key] = exact;
  }
  if (Object.keys(entries).length > 32) {
    throw new Error('Managed terminal cleanup quarantine exceeds its bounded capacity');
  }
  nextSpec[MANAGED_TERMINAL_CLEANUP_QUARANTINE_KEY] = {
    version: MANAGED_TERMINAL_CLEANUP_QUARANTINE_VERSION,
    entries,
  };
  return nextSpec;
}

function managedTerminalCleanupMarker(value: unknown): ManagedTerminalCleanupMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  if (Object.keys(marker).sort().join(',') !== 'attemptId,resultId,submissionAttempt,version'
    || marker.version !== MANAGED_TERMINAL_CLEANUP_ENTRY_VERSION
    || typeof marker.attemptId !== 'string'
    || !MANAGED_SUBMISSION_ATTEMPT_ID.test(marker.attemptId)
    || (marker.resultId !== null
      && (typeof marker.resultId !== 'string' || !MANAGED_TERMINAL_RESULT_ID.test(marker.resultId)))
    || !marker.submissionAttempt
    || typeof marker.submissionAttempt !== 'object'
    || Array.isArray(marker.submissionAttempt)) return null;
  const submissionAttempt = marker.submissionAttempt as Record<string, unknown>;
  if (Object.keys(submissionAttempt).sort().join(',') !== 'claimId,executionId,runId'
    || typeof submissionAttempt.runId !== 'string'
    || !MANAGED_SUBMISSION_ATTEMPT_ID.test(submissionAttempt.runId)
    || typeof submissionAttempt.claimId !== 'string'
    || !MANAGED_SUBMISSION_ATTEMPT_ID.test(submissionAttempt.claimId)
    || typeof submissionAttempt.executionId !== 'string'
    || !MANAGED_SUBMISSION_ATTEMPT_ID.test(submissionAttempt.executionId)) return null;
  return {
    version: MANAGED_TERMINAL_CLEANUP_ENTRY_VERSION,
    attemptId: marker.attemptId.toLowerCase(),
    submissionAttempt: {
      runId: submissionAttempt.runId.toLowerCase(),
      claimId: submissionAttempt.claimId.toLowerCase(),
      executionId: submissionAttempt.executionId.toLowerCase(),
    },
    resultId: marker.resultId,
  };
}

function managedTerminalCleanupEntryKey(marker: ManagedTerminalCleanupMarker): string {
  return `${marker.submissionAttempt.executionId}:${marker.resultId ?? 'pending'}`;
}

function managedTerminalCleanupOutbox(value: unknown): ManagedTerminalCleanupOutbox | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(',') !== 'entries,version'
    || candidate.version !== MANAGED_TERMINAL_CLEANUP_OUTBOX_VERSION
    || !candidate.entries
    || typeof candidate.entries !== 'object'
    || Array.isArray(candidate.entries)) return null;
  const rawEntries = candidate.entries as Record<string, unknown>;
  if (Object.keys(rawEntries).length === 0 || Object.keys(rawEntries).length > 32) return null;
  const entries: Record<string, ManagedTerminalCleanupMarker> = {};
  for (const [key, value] of Object.entries(rawEntries)) {
    const marker = managedTerminalCleanupMarker(value);
    if (!marker || managedTerminalCleanupEntryKey(marker) !== key) return null;
    entries[key] = marker;
  }
  return { version: MANAGED_TERMINAL_CLEANUP_OUTBOX_VERSION, entries };
}

function managedTerminalCleanupOutboxFromSpec(spec: unknown): ManagedTerminalCleanupOutbox | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  return managedTerminalCleanupOutbox(
    (spec as Record<string, unknown>)[MANAGED_TERMINAL_CLEANUP_OUTBOX_KEY],
  );
}

function sameManagedTerminalCleanupExecution(
  left: ManagedTerminalCleanupMarker,
  right: ManagedTerminalCleanupMarker,
): boolean {
  return left.version === right.version
    && left.attemptId === right.attemptId
    && isDeepStrictEqual(left.submissionAttempt, right.submissionAttempt);
}

/**
 * Add cleanup obligations without collapsing distinct initial, continuation, or observation runs.
 * The returned object is written in the same UPDATE as the terminal review fold.
 */
export function specWithManagedTerminalCleanupEntries(
  spec: unknown,
  markers: readonly ManagedTerminalCleanupMarker[],
): Record<string, unknown> {
  const nextSpec = spec && typeof spec === 'object' && !Array.isArray(spec)
    ? { ...(spec as Record<string, unknown>) }
    : {};
  if (markers.length === 0) return nextSpec;
  const hasRawOutbox = Object.prototype.hasOwnProperty.call(
    nextSpec,
    MANAGED_TERMINAL_CLEANUP_OUTBOX_KEY,
  );
  const current = managedTerminalCleanupOutboxFromSpec(nextSpec);
  if (hasRawOutbox && !current) throw new Error('Managed terminal cleanup outbox is malformed');
  const entries = { ...(current?.entries ?? {}) };
  for (const marker of markers) {
    const exact = managedTerminalCleanupMarker(marker);
    if (!exact || !isDeepStrictEqual(exact, marker)) {
      throw new Error('Managed terminal cleanup outbox requires exact normalized entries');
    }
    const sameExecution = Object.entries(entries).find(([, existing]) =>
      existing.submissionAttempt.executionId === exact.submissionAttempt.executionId);
    if (sameExecution) {
      const [existingKey, existing] = sameExecution;
      if (!sameManagedTerminalCleanupExecution(existing, exact)) {
        throw new Error('Managed terminal cleanup execution is already bound to another attempt');
      }
      if (existing.resultId !== null && exact.resultId === null) continue;
      if (existing.resultId !== null && exact.resultId !== existing.resultId) {
        throw new Error('Managed terminal cleanup execution is already bound to another result');
      }
      if (existing.resultId === null && exact.resultId !== null) delete entries[existingKey];
    }
    const key = managedTerminalCleanupEntryKey(exact);
    const existingAtKey = entries[key];
    if (existingAtKey && !isDeepStrictEqual(existingAtKey, exact)) {
      throw new Error('Managed terminal cleanup key is already bound to another result');
    }
    entries[key] = exact;
  }
  nextSpec[MANAGED_TERMINAL_CLEANUP_OUTBOX_KEY] = {
    version: MANAGED_TERMINAL_CLEANUP_OUTBOX_VERSION,
    entries,
  } satisfies ManagedTerminalCleanupOutbox;
  return nextSpec;
}

export function specWithManagedTerminalFold(
  spec: unknown,
  review: ApplicationReviewState,
  markers: readonly ManagedTerminalCleanupMarker[],
  quarantines: readonly ManagedTerminalCleanupQuarantine[] = [],
): Record<string, unknown> {
  const folded = spec && typeof spec === 'object' && !Array.isArray(spec)
    ? { ...(spec as Record<string, unknown>), _review: review }
    : { _review: review };
  return specWithManagedTerminalCleanupQuarantines(
    specWithManagedTerminalCleanupEntries(folded, markers),
    quarantines,
  );
}

function specWithoutManagedTerminalCleanupEntry(
  spec: unknown,
  marker: ManagedTerminalCleanupMarker,
): Record<string, unknown> {
  const nextSpec = specWithManagedTerminalCleanupEntries(spec, []);
  const outbox = managedTerminalCleanupOutboxFromSpec(nextSpec);
  if (!outbox) return nextSpec;
  const key = managedTerminalCleanupEntryKey(marker);
  const existing = outbox.entries[key];
  if (!existing) return nextSpec;
  if (!isDeepStrictEqual(existing, marker)) {
    throw new Error('Managed terminal cleanup completion did not match its durable result');
  }
  const entries = { ...outbox.entries };
  delete entries[key];
  if (Object.keys(entries).length === 0) {
    delete nextSpec[MANAGED_TERMINAL_CLEANUP_OUTBOX_KEY];
  } else {
    nextSpec[MANAGED_TERMINAL_CLEANUP_OUTBOX_KEY] = { ...outbox, entries };
  }
  return nextSpec;
}

function exactManagedTerminalCleanupMarker(input: {
  attemptBinding: SubmissionAttemptBinding;
  submissionAttempt: ManagedSubmissionAttempt;
  resultId: string;
}): BoundManagedTerminalCleanupMarker {
  const marker = managedTerminalCleanupMarker({
    version: MANAGED_TERMINAL_CLEANUP_ENTRY_VERSION,
    attemptId: input.attemptBinding.attemptId,
    submissionAttempt: input.submissionAttempt,
    resultId: input.resultId,
  });
  if (!marker
    || marker.attemptId !== input.attemptBinding.attemptId.toLowerCase()
    || marker.submissionAttempt.claimId !== input.attemptBinding.submissionClaimId?.toLowerCase()
    || marker.submissionAttempt.runId !== input.attemptBinding.submissionRunId?.toLowerCase()) {
    throw new Error('Managed terminal cleanup requires one exact durable attempt and result ID');
  }
  return marker as BoundManagedTerminalCleanupMarker;
}

function pendingManagedTerminalCleanupMarker(input: {
  attemptBinding: SubmissionAttemptBinding;
  submissionAttempt: ManagedSubmissionAttempt;
}): ManagedTerminalCleanupMarker {
  const marker = managedTerminalCleanupMarker({
    version: MANAGED_TERMINAL_CLEANUP_ENTRY_VERSION,
    attemptId: input.attemptBinding.attemptId,
    submissionAttempt: input.submissionAttempt,
    resultId: null,
  });
  if (!marker
    || marker.attemptId !== input.attemptBinding.attemptId.toLowerCase()
    || marker.submissionAttempt.claimId !== input.attemptBinding.submissionClaimId?.toLowerCase()
    || marker.submissionAttempt.runId !== input.attemptBinding.submissionRunId?.toLowerCase()) {
    throw new Error('Managed terminal cleanup retrieval requires one exact durable attempt');
  }
  return marker;
}

async function completeManagedTerminalCleanupMarker(
  row: ResumeRow,
  marker: ManagedTerminalCleanupMarker,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1).for('update');
    if (!latest) return;
    const nextSpec = specWithoutManagedTerminalCleanupEntry(latest.spec, marker);
    if (isDeepStrictEqual(nextSpec, latest.spec)) return;
    const updated = await tx.update(generated_resumes).set({
      spec: sql`${JSON.stringify(nextSpec)}::jsonb`,
    }).where(and(
      eq(generated_resumes.id, latest.id),
      eq(generated_resumes.user_id, latest.user_id),
      sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
    )).returning({ id: generated_resumes.id });
    if (!updated[0]) throw new Error('Managed terminal cleanup completion lost its exact marker');
  });
}

async function bindManagedTerminalCleanupResultId(
  row: ResumeRow,
  marker: ManagedTerminalCleanupMarker,
  resultId: string,
): Promise<BoundManagedTerminalCleanupMarker> {
  if (!MANAGED_TERMINAL_RESULT_ID.test(resultId)) {
    throw new Error('Managed terminal cleanup cannot bind a malformed result ID');
  }
  const bound = { ...marker, resultId } as BoundManagedTerminalCleanupMarker;
  await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1).for('update');
    if (!latest) throw new Error('Managed terminal cleanup packet no longer exists');
    const outbox = managedTerminalCleanupOutboxFromSpec(latest.spec);
    if (!outbox) throw new Error('Managed terminal cleanup retrieval outbox is missing');
    const pendingKey = managedTerminalCleanupEntryKey(marker);
    const boundKey = managedTerminalCleanupEntryKey(bound);
    const existingBound = outbox.entries[boundKey];
    if (existingBound) {
      if (!isDeepStrictEqual(existingBound, bound)) {
        throw new Error('Managed terminal cleanup result ID did not match its durable entry');
      }
      return;
    }
    const existingPending = outbox.entries[pendingKey];
    if (!isDeepStrictEqual(existingPending, marker)) {
      throw new Error('Managed terminal cleanup retrieval marker changed before result binding');
    }
    const nextSpec = specWithManagedTerminalCleanupEntries(latest.spec, [bound]);
    const updated = await tx.update(generated_resumes).set({
      spec: sql`${JSON.stringify(nextSpec)}::jsonb`,
    }).where(and(
      eq(generated_resumes.id, latest.id),
      eq(generated_resumes.user_id, latest.user_id),
      sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
    )).returning({ id: generated_resumes.id });
    if (!updated[0]) throw new Error('Managed terminal cleanup result ID lost its retrieval marker');
  });
  return bound;
}

export async function retryManagedTerminalCleanupDelivery(
  marker: BoundManagedTerminalCleanupMarker,
  dependencies: {
    acknowledge: (submissionAttempt: ManagedSubmissionAttempt, resultId: string) => Promise<unknown>;
    complete: (marker: BoundManagedTerminalCleanupMarker) => Promise<unknown>;
    failed?: (error: unknown) => void;
  },
): Promise<boolean> {
  try {
    await dependencies.acknowledge(marker.submissionAttempt, marker.resultId);
    await dependencies.complete(marker);
    return true;
  } catch (error) {
    dependencies.failed?.(error);
    return false;
  }
}

type ManagedTerminalCleanupRetrieval =
  | { state: 'pending' | 'not_found' | 'gone' }
  | { state: 'completed' | 'failed' | 'indeterminate'; resultId: string };

export async function drainManagedTerminalCleanupEntries(
  markers: readonly ManagedTerminalCleanupMarker[],
  dependencies: {
    retrieve: (marker: ManagedTerminalCleanupMarker) => Promise<ManagedTerminalCleanupRetrieval>;
    bind: (
      marker: ManagedTerminalCleanupMarker,
      resultId: string,
    ) => Promise<BoundManagedTerminalCleanupMarker>;
    acknowledge: (marker: BoundManagedTerminalCleanupMarker) => Promise<unknown>;
    complete: (marker: ManagedTerminalCleanupMarker) => Promise<unknown>;
    failed?: (marker: ManagedTerminalCleanupMarker, error: unknown) => void;
  },
): Promise<{ attempted: number; completed: number; pending: number }> {
  let completed = 0;
  let pending = 0;
  for (const marker of markers) {
    try {
      let deliveryMarker: BoundManagedTerminalCleanupMarker;
      if (marker.resultId === null) {
        const terminal = await dependencies.retrieve(marker);
        const disposition = managedTerminalCleanupRetrievalDisposition(terminal.state);
        if (disposition === 'complete') {
          await dependencies.complete(marker);
          completed += 1;
          continue;
        }
        if (disposition === 'retry') {
          pending += 1;
          continue;
        }
        if (terminal.state !== 'completed'
          && terminal.state !== 'failed'
          && terminal.state !== 'indeterminate') {
          throw new Error('Managed terminal cleanup disposition lost its terminal result');
        }
        deliveryMarker = await dependencies.bind(marker, terminal.resultId);
      } else {
        deliveryMarker = marker as BoundManagedTerminalCleanupMarker;
      }
      await dependencies.acknowledge(deliveryMarker);
      await dependencies.complete(deliveryMarker);
      completed += 1;
    } catch (error) {
      pending += 1;
      dependencies.failed?.(marker, error);
    }
  }
  return { attempted: markers.length, completed, pending };
}

async function managedAttemptHasDurableFold(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  submissionAttempt: ManagedSubmissionAttempt,
): Promise<boolean> {
  const events = (await submissionAttemptEventsForPacket(row.user_id, row.id))
    .filter((event) => event.attempt_id === attemptBinding.attemptId);
  if (events.some((event) => event.event_kind === 'submission_confirmed'
    || event.event_kind === 'not_sent_proven')) return true;
  const [latest] = await db.select().from(generated_resumes).where(and(
    eq(generated_resumes.id, row.id),
    eq(generated_resumes.user_id, row.user_id),
  )).limit(1);
  const review = latest ? readApplicationReview(latest.spec) : null;
  if (!review
    || review.submission_run_id !== attemptBinding.submissionRunId
    || review.submission_claim_id !== attemptBinding.attemptId
    || !review.unverified_submission) return false;
  const continuationAttempt = managedContinuationSubmissionAttempt(attemptBinding, 'security_code');
  const continuationExecutionFingerprint = managedContinuationExecutionFingerprint(continuationAttempt);
  const isSecurityCodeContinuation = submissionAttempt.runId === continuationAttempt.runId
    && submissionAttempt.claimId === continuationAttempt.claimId
    && submissionAttempt.executionId === continuationAttempt.executionId;
  return managedRecoveryReviewFoldIsDurable({
    kind: isSecurityCodeContinuation ? 'continuation' : 'initial',
    hasUnverifiedResult: true,
    state: review.verification ? {
      runner: review.verification.runner,
      status: review.verification.status,
      continuationResumed: review.verification.continuation_resumed,
      continuationExecutionFingerprint: review.verification.continuation_execution_fingerprint,
      continuationCallDeadlineAt: review.verification.continuation_call_deadline_at,
    } : undefined,
    expectedExecutionFingerprint: continuationExecutionFingerprint,
  });
}

async function ensureManagedTerminalCleanupForDurableFold(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  marker: ManagedTerminalCleanupMarker,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1).for('update');
    const latestReview = latest ? readApplicationReview(latest.spec) : null;
    if (!latest || !latestReview) return false;
    const exactEvents = (await submissionAttemptEventsForPacket(
      row.user_id,
      row.id,
      { executor: tx },
    )).filter((event) => event.attempt_id === attemptBinding.attemptId);
    const continuationAttempt = managedContinuationSubmissionAttempt(
      attemptBinding,
      'security_code',
    );
    const isSecurityCodeContinuation = marker.submissionAttempt.runId === continuationAttempt.runId
      && marker.submissionAttempt.claimId === continuationAttempt.claimId
      && marker.submissionAttempt.executionId === continuationAttempt.executionId;
    const durableReview = latestReview.submission_run_id === attemptBinding.submissionRunId
      && latestReview.submission_claim_id === attemptBinding.attemptId
      && managedRecoveryReviewFoldIsDurable({
        kind: isSecurityCodeContinuation ? 'continuation' : 'initial',
        hasUnverifiedResult: Boolean(latestReview.unverified_submission),
        state: latestReview.verification ? {
          runner: latestReview.verification.runner,
          status: latestReview.verification.status,
          continuationResumed: latestReview.verification.continuation_resumed,
          continuationExecutionFingerprint:
            latestReview.verification.continuation_execution_fingerprint,
          continuationCallDeadlineAt: latestReview.verification.continuation_call_deadline_at,
        } : undefined,
        expectedExecutionFingerprint: managedContinuationExecutionFingerprint(
          continuationAttempt,
        ),
      });
    const durableFact = exactEvents.some((event) => event.event_kind === 'submission_confirmed'
      || event.event_kind === 'not_sent_proven');
    if (!durableReview && !durableFact) return false;
    const nextSpec = specWithManagedTerminalCleanupEntries(latest.spec, [marker]);
    if (isDeepStrictEqual(nextSpec, latest.spec)) return true;
    const updated = await tx.update(generated_resumes).set({
      spec: sql`${JSON.stringify(nextSpec)}::jsonb`,
    }).where(and(
      eq(generated_resumes.id, latest.id),
      eq(generated_resumes.user_id, latest.user_id),
      sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
    )).returning({ id: generated_resumes.id });
    return updated.length > 0;
  });
}

async function acknowledgeManagedTerminalFold(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  submissionAttempt: ManagedSubmissionAttempt,
  resultId: string,
  fastify: FastifyInstance,
): Promise<void> {
  if (!await managedAttemptHasDurableFold(row, attemptBinding, submissionAttempt)) return;
  const marker = exactManagedTerminalCleanupMarker({ attemptBinding, submissionAttempt, resultId });
  const [latest] = await db.select({ spec: generated_resumes.spec }).from(generated_resumes).where(and(
    eq(generated_resumes.id, row.id),
    eq(generated_resumes.user_id, row.user_id),
  )).limit(1);
  const queued = latest ? managedTerminalCleanupOutboxFromSpec(latest.spec) : null;
  const queuedMarker = queued?.entries[managedTerminalCleanupEntryKey(marker)];
  if (!queuedMarker || !isDeepStrictEqual(queuedMarker, marker)) {
    fastify.log.error({
      applicationId: row.id,
      attemptId: attemptBinding.attemptId,
      executionId: submissionAttempt.executionId,
      resultId,
    }, 'Managed terminal fold did not contain its exact atomic cleanup entry');
    return;
  }
  try {
    await acknowledgeManagedBrowserTerminalResult(submissionAttempt, resultId);
    await completeManagedTerminalCleanupMarker(row, marker);
  } catch (error) {
    fastify.log.warn({
      applicationId: row.id,
      attemptId: attemptBinding.attemptId,
      detail: error instanceof Error ? error.message.slice(0, 200) : 'Terminal acknowledgement failed',
    }, 'Managed terminal result was folded but its acknowledgement remains queued');
  }
}

async function acknowledgeManagedTerminalCleanupMarkers(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  markers: readonly ManagedTerminalCleanupMarker[],
  fastify: FastifyInstance,
): Promise<void> {
  for (const marker of markers) {
    if (marker.resultId === null) continue;
    await acknowledgeManagedTerminalFold(
      row,
      attemptBinding,
      marker.submissionAttempt,
      marker.resultId,
      fastify,
    );
  }
}

export async function retryManagedTerminalCleanupOutbox(
  fastify: FastifyInstance,
  options: { userId?: string } = {},
): Promise<{ attempted: number; completed: number; pending: number }> {
  const cleanupRows = sql`${generated_resumes.spec}->'_managed_terminal_cleanup_outbox'->>'version' = ${MANAGED_TERMINAL_CLEANUP_OUTBOX_VERSION}`;
  const cleanupRowsForScope = options.userId
    ? and(cleanupRows, eq(generated_resumes.user_id, options.userId))
    : cleanupRows;
  const [counted] = await db.select({ total: sql<number>`count(*)::int` })
    .from(generated_resumes)
    .where(cleanupRowsForScope);
  const batchWindow = managedTerminalCleanupBatchWindow(
    counted?.total ?? 0,
    options.userId ? Math.max(1, counted?.total ?? 0) : submissionBatchSize(),
  );
  const rows = batchWindow.firstLimit > 0
    ? await db.select().from(generated_resumes).where(cleanupRowsForScope)
      .orderBy(generated_resumes.created_at, generated_resumes.id)
      .limit(batchWindow.firstLimit)
      .offset(batchWindow.firstOffset)
    : [];
  if (batchWindow.wrapLimit > 0) {
    rows.push(...await db.select().from(generated_resumes).where(cleanupRowsForScope)
      .orderBy(generated_resumes.created_at, generated_resumes.id)
      .limit(batchWindow.wrapLimit));
  }
  let attempted = 0;
  let completed = 0;
  let pending = 0;
  for (const row of rows) {
    const outbox = managedTerminalCleanupOutboxFromSpec(row.spec);
    if (!outbox) {
      fastify.log.error({ applicationId: row.id }, 'Managed terminal cleanup outbox is malformed');
      pending += 1;
      continue;
    }
    const drained = await drainManagedTerminalCleanupEntries(Object.values(outbox.entries), {
      retrieve: (marker) => getManagedBrowserTerminalResult(marker.submissionAttempt),
      bind: (marker, resultId) => bindManagedTerminalCleanupResultId(row, marker, resultId),
      acknowledge: (marker) => acknowledgeManagedBrowserTerminalResult(
        marker.submissionAttempt,
        marker.resultId,
      ),
      complete: (marker) => completeManagedTerminalCleanupMarker(row, marker),
      failed: (marker, error) => {
        fastify.log.warn({
          applicationId: row.id,
          attemptId: marker.attemptId,
          executionId: marker.submissionAttempt.executionId,
          detail: error instanceof Error ? error.message.slice(0, 200) : 'Terminal cleanup failed',
        }, 'Managed terminal cleanup remains queued');
      },
    });
    attempted += drained.attempted;
    completed += drained.completed;
    pending += drained.pending;
  }
  return { attempted, completed, pending };
}

export async function drainManagedTerminalCleanupBeforeAccountDeletion(
  userId: string,
  fastify: FastifyInstance,
): Promise<{
  ready: boolean;
  attempted: number;
  completed: number;
  pending: number;
  blockedPackets: number;
}> {
  const drained = await retryManagedTerminalCleanupOutbox(fastify, { userId });
  const rows = await db.select({ id: generated_resumes.id, spec: generated_resumes.spec })
    .from(generated_resumes)
    .where(eq(generated_resumes.user_id, userId));
  let blockedPackets = 0;
  for (const row of rows) {
    const spec = row.spec && typeof row.spec === 'object' && !Array.isArray(row.spec)
      ? row.spec as Record<string, unknown>
      : {};
    const review = readApplicationReview(row.spec);
    const hasCleanupOutbox = Object.prototype.hasOwnProperty.call(
      spec,
      MANAGED_TERMINAL_CLEANUP_OUTBOX_KEY,
    );
    const hasCleanupQuarantine = Object.prototype.hasOwnProperty.call(
      spec,
      MANAGED_TERMINAL_CLEANUP_QUARANTINE_KEY,
    );
    const claimedExecutionMayStillExist = Boolean(review?.submission_claim_id
      && !review.browser_session_id
      && (
      review.status === 'submitting'
      || review.status === 'submission_claimed'
      || review.status === 'awaiting_security_code'
      || (review.verification?.runner === 'stratus-managed'
        && (review.verification.status === 'searching'
          || review.verification.status === 'verification_pending'))
    ));
    // Managed preparation has no persistent session id and must finish before deletion. A direct
    // filling row is drained by the independent provider-resource fence below this check, so it
    // must not prevent account deletion from reaching the release request.
    const managedExecutionMayStillExist = (review?.status === 'filling' && !review.browser_session_id)
      || claimedExecutionMayStillExist;
    if (hasCleanupOutbox || hasCleanupQuarantine || managedExecutionMayStillExist) {
      blockedPackets += 1;
    }
  }
  return {
    ready: blockedPackets === 0,
    ...drained,
    blockedPackets,
  };
}

async function managedTerminalCleanupMarkerAfterRetrieval(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  submissionAttempt: ManagedSubmissionAttempt,
  fastify: FastifyInstance,
): Promise<ManagedTerminalCleanupMarker | null> {
  const pending = pendingManagedTerminalCleanupMarker({ attemptBinding, submissionAttempt });
  let terminal;
  try {
    terminal = await getManagedBrowserTerminalResult(submissionAttempt);
  } catch (error) {
    fastify.log.warn({
      applicationId: row.id,
      attemptId: attemptBinding.attemptId,
      detail: error instanceof Error ? error.message.slice(0, 200) : 'Terminal result ID retrieval failed',
    }, 'Managed terminal cleanup is waiting to identify the exact result ID');
    return pending;
  }
  const disposition = managedTerminalCleanupRetrievalDisposition(terminal.state);
  if (disposition === 'complete') return null;
  if (disposition === 'retry') return pending;
  if (terminal.state !== 'completed'
    && terminal.state !== 'failed'
    && terminal.state !== 'indeterminate') {
    throw new Error('Managed terminal cleanup disposition lost its terminal result');
  }
  return exactManagedTerminalCleanupMarker({
    attemptBinding,
    submissionAttempt,
    resultId: terminal.resultId,
  });
}

function recoveredSecurityCodeState(
  review: ApplicationReviewState,
  result: ManagedBrowserResult,
  capturedAt: string,
): ApplicationReviewState['security_code'] {
  const current = review.security_code;
  if (!current) return undefined;
  const challenge = readManagedSecurityCodeChallenge(result);
  const challenged = challenge
    ? beginSecurityCodeState({
      challenge,
      attemptedAt: capturedAt,
      authorized: true,
      existing: current,
    })
    : current;
  const provisional = [...(current.attempts ?? [])]
    .reverse()
    .find((attempt) => attempt.outcome === 'error');
  if (!provisional) return challenged;
  const observed = result.securityCodeAttempt?.outcome;
  const outcome: SecurityCodeAttempt['outcome'] = observed === 'accepted' && !challenge
    ? 'accepted'
    : observed === 'rejected' && challenge
      ? 'rejected'
      : observed === 'no_control'
        ? 'no_control'
        : observed === 'not_entered'
          ? 'not_entered'
          : 'error';
  return withSecurityCodeAttempt(challenged, {
    at: capturedAt,
    fingerprint: provisional.fingerprint,
    outcome,
  });
}

async function recoveredManagedPreviewUrl(
  row: ResumeRow,
  review: ApplicationReviewState,
  result: ManagedBrowserResult,
  fastify: FastifyInstance,
): Promise<string | undefined> {
  if (!result.screenshot) return undefined;
  try {
    const blob = await storeReceiptScreenshot(
      `users/${row.user_id}/submission-runs/${review.submission_run_id}/receipt.png`,
      Buffer.from(result.screenshot, 'base64'),
    );
    return blob.url;
  } catch (error) {
    fastify.log.warn({
      applicationId: row.id,
      detail: error instanceof Error ? error.message.slice(0, 200) : 'Receipt enrichment failed',
    }, 'Recovered managed result could not store its screenshot');
    return undefined;
  }
}

async function foldManagedSecurityCodeContinuationResult(
  row: ResumeRow,
  review: ApplicationReviewState,
  attemptBinding: SubmissionAttemptBinding,
  submissionAttempt: ManagedSubmissionAttempt,
  resultId: string,
  result: ManagedBrowserResult,
  capturedAt: string,
  fastify: FastifyInstance,
  additionalCleanupMarkers: readonly ManagedTerminalCleanupMarker[] = [],
): Promise<ManagedTerminalRecoveryOutcome> {
  const cleanupMarker = exactManagedTerminalCleanupMarker({
    attemptBinding,
    submissionAttempt,
    resultId,
  });
  const cleanupMarkers = [...additionalCleanupMarkers, cleanupMarker];
  const expectedPortalUrl = attemptBinding.postingIdentity.portalUrl;
  if (!expectedPortalUrl) {
    await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      'The retained verification result has no immutable employer URL binding',
      { cleanupMarkers },
    );
    await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
    return 'folded';
  }
  const expectedApplicationUrl = portalApplicationUrl(
    detectPortal(expectedPortalUrl),
    expectedPortalUrl,
  );
  const outcome = readManagedSubmitOutcome(result);
  if (outcome?.pressed === true) {
    await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'managed-security-code-submit', {
      evidenceCode: 'stratus_verification_press_echoed',
    });
  }
  try {
    assertManagedRequiredFieldsConfirmed(result, 'verification');
  } catch (error) {
    await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      error instanceof Error ? error.message.slice(0, 500) : 'Recovered verification proof was incomplete',
      { verification: review.verification, cleanupMarkers },
    );
    await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
    return 'folded';
  }

  const securityCode = recoveredSecurityCodeState(review, result, capturedAt);
  const challenge = readManagedSecurityCodeChallenge(result);
  const expectedRecipient = review.applicant_email?.address ?? review.security_code?.sent_to ?? '';
  const challengeMatches = !challenge
    || securityCodeChallengeMatchesRecipient(challenge, expectedRecipient);
  const verdict = exactManagedSubmitVerdict(result, expectedApplicationUrl);
  const accepted = securityCode?.attempts?.some((attempt) => attempt.outcome === 'accepted') === true;
  const verification: NonNullable<ApplicationReviewState['verification']> = {
    ...review.verification,
    status: challenge ? 'handoff' : 'completed',
    retry_count: Math.max(1, review.verification?.retry_count ?? 0),
    completed_at: capturedAt,
  };

  if (!challenge && verdict.kind === 'confirmed' && accepted) {
    const receipt: NonNullable<ApplicationReviewState['receipt']> = {
      confirmation_text: verdict.confirmationText,
      final_url: result.url,
      captured_at: capturedAt,
      source: 'managed_browser',
    };
    const confirmed = await recordManagedSubmissionConfirmed(row, attemptBinding, {
      capturedAt,
      verification,
      ...(securityCode ? { securityCode } : {}),
      receipt,
      receiptEvidence: { result, expectedApplicationUrl },
      cleanupMarkers,
    });
    if (confirmed) {
      const screenshotUrl = await recoveredManagedPreviewUrl(row, review, result, fastify);
      if (screenshotUrl) {
        await recordManagedSubmissionConfirmed(row, attemptBinding, {
          capturedAt,
          verification,
          ...(securityCode ? { securityCode } : {}),
          receipt: { ...receipt, screenshot_url: screenshotUrl },
          receiptEvidence: { result, expectedApplicationUrl },
        });
      }
      await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
      return 'folded';
    }
  }

  const previewUrl = await recoveredManagedPreviewUrl(row, review, result, fastify);
  await recordManagedSecurityCodeContinuationUnverified(
    row,
    attemptBinding,
    challenge
      ? challengeMatches
        ? 'The employer still requires its emailed security code after the retained continuation'
        : 'The retained verification result named a different application email'
      : verdict.kind === 'confirmed'
        ? 'The retained verification result did not prove that the exact security code was accepted'
        : `The retained verification result was ${verdict.kind}`,
    {
      ...(previewUrl ? { previewUrl } : {}),
      ...(securityCode ? { securityCode } : {}),
      verification,
      cleanupMarkers,
    },
  );
  await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
  return 'folded';
}

/** Poll only the exact continuation execution that was committed before the remote call. */
export async function recoverManagedSecurityCodeContinuationTerminalResult(
  row: ResumeRow,
  review: ApplicationReviewState,
  attemptBinding: SubmissionAttemptBinding,
  fastify: FastifyInstance,
): Promise<ManagedTerminalRecoveryOutcome> {
  if (attemptBinding.packetId !== row.id || attemptBinding.userId !== row.user_id) {
    return 'not_recoverable';
  }
  const plan = managedSecurityCodeContinuationRecoveryPlan(review, attemptBinding);
  if (plan.kind === 'none') return 'not_recoverable';
  const initialCleanupMarkers: ManagedTerminalCleanupMarker[] = [];
  const authorization = await submissionBoundaryAuthorization(row.user_id, attemptBinding.attemptId);
  if (authorization) {
    try {
      const initialSubmissionAttempt = managedInitialSubmissionAttempt(
        attemptBinding,
        authorization,
      );
      const initialCleanupMarker = await managedTerminalCleanupMarkerAfterRetrieval(
        row,
        attemptBinding,
        initialSubmissionAttempt,
        fastify,
      );
      if (initialCleanupMarker) initialCleanupMarkers.push(initialCleanupMarker);
    } catch (error) {
      fastify.log.warn({
        applicationId: row.id,
        attemptId: attemptBinding.attemptId,
        detail: error instanceof Error ? error.message.slice(0, 200) : 'Initial cleanup binding failed',
      }, 'Managed continuation recovery could not reconstruct its initial cleanup entry');
    }
  }
  if (plan.kind === 'invalid') {
    const continuationCleanupMarkers = plan.submissionAttempt
      ? [pendingManagedTerminalCleanupMarker({
          attemptBinding,
          submissionAttempt: plan.submissionAttempt,
        })]
      : [];
    const cleanupQuarantines = plan.submissionAttempt
      ? []
      : [exactManagedTerminalCleanupQuarantine({
          attemptId: attemptBinding.attemptId,
          reason: plan.reason,
          continuationExecutionFingerprint:
            review.verification?.continuation_execution_fingerprint,
        })];
    const retained = await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      `The retained verification recovery binding was invalid: ${plan.reason}`,
      {
        verification: review.verification,
        cleanupMarkers: [...initialCleanupMarkers, ...continuationCleanupMarkers],
        cleanupQuarantines,
        allowInvalidContinuationBinding: true,
      },
    );
    if (!retained) {
      fastify.log.error({
        applicationId: row.id,
        attemptId: attemptBinding.attemptId,
        reason: plan.reason,
      }, 'Managed continuation cleanup could not be retained for invalid recovery state');
      return 'pending';
    }
    await acknowledgeManagedTerminalCleanupMarkers(
      row,
      attemptBinding,
      initialCleanupMarkers,
      fastify,
    );
    return 'folded';
  }
  if (plan.kind === 'expired') {
    const cleanupMarker = pendingManagedTerminalCleanupMarker({
      attemptBinding,
      submissionAttempt: plan.submissionAttempt,
    });
    const cleanupMarkers = [...initialCleanupMarkers, cleanupMarker];
    await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      'The retained verification result stayed pending until its provider deadline expired',
      { verification: review.verification, cleanupMarkers },
    );
    await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
    return 'folded';
  }

  let terminal;
  try {
    terminal = await getManagedBrowserTerminalResult(plan.submissionAttempt);
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 500) : 'Terminal retrieval failed';
    if (/did not match its durable submission attempt/i.test(detail)) {
      const cleanupMarker = pendingManagedTerminalCleanupMarker({
        attemptBinding,
        submissionAttempt: plan.submissionAttempt,
      });
      const cleanupMarkers = [...initialCleanupMarkers, cleanupMarker];
      await recordManagedSecurityCodeContinuationUnverified(
        row,
        attemptBinding,
        detail,
        { verification: review.verification, cleanupMarkers },
      );
      await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
      return 'folded';
    }
    fastify.log.warn({
      applicationId: row.id,
      attemptId: attemptBinding.attemptId,
      detail: detail.slice(0, 200),
    }, 'Managed verification terminal result could not be retrieved yet');
    if (Date.now() < Date.parse(plan.providerDeadlineAt)) return 'pending';
    const cleanupMarker = pendingManagedTerminalCleanupMarker({
      attemptBinding,
      submissionAttempt: plan.submissionAttempt,
    });
    const cleanupMarkers = [...initialCleanupMarkers, cleanupMarker];
    await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      'The retained verification result could not be retrieved before its provider deadline expired',
      { verification: review.verification, cleanupMarkers },
    );
    await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
    return 'folded';
  }
  const terminalDecision = managedContinuationTerminalDecision(
    terminal.state,
    plan.providerDeadlineAt,
    Date.now(),
  );
  if (terminalDecision === 'pending') return 'pending';
  if (terminalDecision === 'deadline_expired') {
    const cleanupMarker = pendingManagedTerminalCleanupMarker({
      attemptBinding,
      submissionAttempt: plan.submissionAttempt,
    });
    const cleanupMarkers = [...initialCleanupMarkers, cleanupMarker];
    await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      'The retained verification result stayed pending until its provider deadline expired',
      { verification: review.verification, cleanupMarkers },
    );
    await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
    return 'folded';
  }
  if (terminalDecision === 'gone') {
    const cleanupMarker = pendingManagedTerminalCleanupMarker({
      attemptBinding,
      submissionAttempt: plan.submissionAttempt,
    });
    const cleanupMarkers = [...initialCleanupMarkers, cleanupMarker];
    await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      'The retained verification result expired before Litos could fold it',
      { verification: review.verification, cleanupMarkers },
    );
    await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
    return 'folded';
  }
  if ((terminalDecision === 'failed' || terminalDecision === 'indeterminate')
    && (terminal.state === 'failed' || terminal.state === 'indeterminate')) {
    const cleanupMarker = exactManagedTerminalCleanupMarker({
      attemptBinding,
      submissionAttempt: plan.submissionAttempt,
      resultId: terminal.resultId,
    });
    const cleanupMarkers = [...initialCleanupMarkers, cleanupMarker];
    const error = managedBrowserTerminalFailureError(terminal);
    if (error instanceof ManagedBrowserProviderProgressError
      && managedProviderProgressDisposition(error.runProgress, 'verification') === 'pressed') {
      await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'managed-security-code-submit', {
        evidenceCode: 'stratus_verification_press_progress',
      });
    }
    await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      error.message.slice(0, 500) || 'The retained verification run ended without a terminal receipt',
      { verification: review.verification, cleanupMarkers },
    );
    await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
    return 'folded';
  }
  if (terminal.state !== 'completed') {
    const cleanupMarker = pendingManagedTerminalCleanupMarker({
      attemptBinding,
      submissionAttempt: plan.submissionAttempt,
    });
    const cleanupMarkers = [...initialCleanupMarkers, cleanupMarker];
    await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      'The retained verification result could not be classified',
      { verification: review.verification, cleanupMarkers },
    );
    await acknowledgeManagedTerminalCleanupMarkers(row, attemptBinding, cleanupMarkers, fastify);
    return 'folded';
  }
  return foldManagedSecurityCodeContinuationResult(
    row,
    review,
    attemptBinding,
    plan.submissionAttempt,
    terminal.resultId,
    terminal.run,
    terminal.completedAt,
    fastify,
    initialCleanupMarkers,
  );
}

async function recoverManagedInitialSecurityCodeChallenge(
  row: ResumeRow,
  review: ApplicationReviewState,
  attemptBinding: SubmissionAttemptBinding,
  initialSubmissionAttempt: ManagedSubmissionAttempt,
  initialResultId: string,
  result: ManagedBrowserResult,
  capturedAt: string,
  challenge: NonNullable<ReturnType<typeof readManagedSecurityCodeChallenge>>,
  fastify: FastifyInstance,
  options: { actions?: ManagedBrowserAction[] },
): Promise<ManagedTerminalRecoveryOutcome> {
  const initialCleanupMarker = exactManagedTerminalCleanupMarker({
    attemptBinding,
    submissionAttempt: initialSubmissionAttempt,
    resultId: initialResultId,
  });
  const continuationSubmissionAttempt = managedContinuationSubmissionAttempt(
    attemptBinding,
    'security_code',
  );
  const continuationExecutionFingerprint = managedContinuationExecutionFingerprint(
    continuationSubmissionAttempt,
  );
  const securityCode = beginSecurityCodeState({
    challenge,
    attemptedAt: capturedAt,
    authorized: true,
    existing: review.security_code,
  });
  const continuationToken = result.continuationToken;
  const continuationExpiresAt = result.continuationExpiresAt;
  const continuationIsLive = typeof continuationToken === 'string'
    && typeof continuationExpiresAt === 'string'
    && Number.isFinite(Date.parse(continuationExpiresAt))
    && continuationExpiresAt === new Date(Date.parse(continuationExpiresAt)).toISOString()
    && Date.parse(continuationExpiresAt) > Date.now();
  let continuationFingerprint: string | undefined;
  if (continuationIsLive) {
    try {
      continuationFingerprint = managedContinuationFingerprint(continuationToken);
    } catch {
      continuationFingerprint = undefined;
    }
  }
  const baseVerification: NonNullable<ApplicationReviewState['verification']> = {
    status: 'handoff',
    requested_at: capturedAt,
    retry_count: 0,
    runner: 'stratus-managed',
    continuation_execution_fingerprint: continuationExecutionFingerprint,
    continuation_resumed: false,
    ...(continuationFingerprint ? { continuation_fingerprint: continuationFingerprint } : {}),
  };
  const persistHandoff = async (message: string) => {
    await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
      message,
      attentionReason: `${securityCodeAttentionReason(securityCode)} Check the employer portal and record whether this exact application was received.`,
      attentionCategories: ['security_code', 'unverified_submission'],
      securityCode,
      verification: baseVerification,
      cleanupMarkers: [initialCleanupMarker],
    });
    await acknowledgeManagedTerminalFold(
      row,
      attemptBinding,
      initialSubmissionAttempt,
      initialResultId,
      fastify,
    );
    return 'folded' as const;
  };

  const expectedRecipient = review.applicant_email?.address ?? '';
  if (!securityCodeChallengeMatchesRecipient(challenge, expectedRecipient)) {
    return persistHandoff(
      expectedRecipient
        ? 'The recovered employer verification recipient did not match this packet'
      : 'The recovered employer verification challenge had no frozen packet email to match',
    );
  }
  const leadIssues = runnerLeadAlignmentIssues(row);
  if (leadIssues.length > 0) {
    return persistHandoff(
      `The recovered application packet no longer has valid lead-experience evidence: ${leadIssues.join(' ')}`,
    );
  }
  if (!continuationIsLive || !continuationFingerprint) {
    return persistHandoff('The recovered employer verification capability was missing or expired');
  }

  const [verificationSettings] = await db.select({ enabled: users.automatic_verification_enabled })
    .from(users).where(eq(users.id, row.user_id)).limit(1);
  const verificationRoute = await resolveVerificationEmailRoute({
    userId: row.user_id,
    applicationId: row.id,
    expectedRecipient,
  });
  const verificationAllowed = verificationRoute === 'application_alias'
    || (verificationRoute === 'personal_address' && verificationSettings?.enabled === true);
  if (!verificationAllowed) {
    return persistHandoff('Automatic mailbox verification was not authorized for the recovered challenge');
  }

  const searchingProjection = await recordManagedSecurityCodeContinuationSearch(
    row,
    attemptBinding,
    {
      securityCode,
      verification: {
        ...baseVerification,
        status: 'searching',
      },
    },
  );
  if (!searchingProjection) {
    if (await ensureManagedTerminalCleanupForDurableFold(
      row,
      attemptBinding,
      initialCleanupMarker,
    )) {
      await acknowledgeManagedTerminalFold(
        row,
        attemptBinding,
        initialSubmissionAttempt,
        initialResultId,
        fastify,
      );
    }
    return 'folded';
  }
  let prepared: Awaited<ReturnType<typeof prepareManagedEmailVerification>>;
  try {
    prepared = await prepareManagedEmailVerification({
      result,
      userId: row.user_id,
      portalUrl: attemptBinding.postingIdentity.portalUrl ?? result.url,
      requestedAt: new Date(capturedAt),
      permissionGranted: true,
      expectedRecipient,
      applicationId: row.id,
      standingChallenge: readManagedSubmitOutcome(result)?.pressed === false,
      attempts: SECURITY_CODE_MAILBOX_ATTEMPTS,
      delayMs: SECURITY_CODE_MAILBOX_DELAY_MS,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message.slice(0, 300) : 'Mailbox verification failed';
    return persistHandoff(`Automatic mailbox verification failed for the recovered challenge: ${detail}`);
  }
  const alreadyAttempted = prepared.status === 'ready'
    && Boolean(findSecurityCodeAttempt(
      searchingProjection.review.security_code,
      securityCodeFingerprint(row.id, prepared.code),
    ));
  if (prepared.status !== 'ready' || alreadyAttempted) {
    await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
      message: prepared.status === 'ready'
        ? 'The recovered mailbox code was already spent on this application'
        : 'No safe mailbox code arrived for the recovered employer challenge',
      attentionReason: `${securityCodeAttentionReason(securityCode)} Check the employer portal and record whether this exact application was received.`,
      attentionCategories: ['security_code', 'unverified_submission'],
      securityCode,
      verification: baseVerification,
      cleanupMarkers: [initialCleanupMarker],
    });
    await acknowledgeManagedTerminalFold(
      row,
      attemptBinding,
      initialSubmissionAttempt,
      initialResultId,
      fastify,
    );
    return 'folded';
  }

  const actionAuthorizationValid = await authorizationValidAtClick(row, review);
  const actionVerificationRoute = await resolveVerificationEmailRoute({
    userId: row.user_id,
    applicationId: row.id,
    expectedRecipient,
  });
  const actionPersonalVerificationEnabled = verificationRoute === 'personal_address'
    ? (await db.select({ enabled: users.automatic_verification_enabled })
      .from(users).where(eq(users.id, row.user_id)).limit(1))[0]?.enabled === true
    : false;
  const actionVerificationRouteValid = verificationRoute === 'application_alias'
    ? actionVerificationRoute === 'application_alias'
    : verificationRoute === 'personal_address'
      && actionVerificationRoute === 'personal_address'
      && actionPersonalVerificationEnabled;
  if (!actionAuthorizationValid || !actionVerificationRouteValid) {
    return persistHandoff(
      !actionAuthorizationValid
        ? 'Submission authorization changed before recovered employer verification'
        : 'The application email route changed before recovered employer verification',
    );
  }

  const enteredSecurityCode = withSecurityCodeAttempt(securityCode, {
    at: new Date().toISOString(),
    fingerprint: securityCodeFingerprint(row.id, prepared.code),
    outcome: 'error',
  });
  const codeActions = securityCodeContinuationActions(
    options.actions ?? [],
    prepared.code,
    result.url,
  ) ?? prepared.actions;
  const requestBudget = startManagedBrowserRequestBudget(
    MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS,
  );
  let continuationAuthorization: { providerDeadlineAt: string };
  try {
    continuationAuthorization = await assertManagedSecurityCodeContinuationBoundaryClear(
      searchingProjection.row,
      searchingProjection.review,
      attemptBinding,
      continuationFingerprint,
      continuationSubmissionAttempt,
      continuationExpiresAt,
      enteredSecurityCode,
      [initialCleanupMarker],
    );
  } catch (error) {
    if (error instanceof ManagedSecurityCodeContinuationRefusedError) {
      return persistHandoff(
        `Recovered employer verification was withheld by the continuation gate: ${error.message}`,
      );
    }
    if (error instanceof SubmissionAccountDeletionDrainError) {
      return persistHandoff(
        'Account deletion stopped the recovered employer verification continuation',
      );
    }
    if (error instanceof FinalSubmissionBoundaryBlockedError
      || error instanceof FinalSubmissionBoundaryChangedError
      || error instanceof FinalSubmissionAuthorizationChangedError
      || error instanceof FinalSubmissionBoundaryAlreadyAuthorizedError) {
      const [latest] = await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, row.user_id),
      )).limit(1);
      const latestReview = latest ? readApplicationReview(latest.spec) : null;
      if (latest && latestReview
        && latestReview.verification?.runner === 'stratus-managed'
        && latestReview.verification.status === 'verification_pending'
        && latestReview.verification.continuation_resumed === true) {
        const recovery = await recoverManagedSecurityCodeContinuationTerminalResult(
          latest,
          latestReview,
          attemptBinding,
          fastify,
        );
        if (recovery !== 'not_recoverable') return recovery;
      }
      if (!latestReview || latestReview.verification?.status !== 'searching') {
        return persistHandoff(
          `Recovered employer verification reached a competing terminal state: ${error.message}`,
        );
      }
      return persistHandoff(
        `Recovered employer verification was withheld by the exact boundary gate: ${error.message}`,
      );
    }
    throw error;
  }

  try {
    const continued = await continueManagedBrowserWithAccountFence(row.user_id, continuationToken, codeActions, {
      submissionAttempt: continuationSubmissionAttempt,
      requestBudget,
      providerDeadlineAt: continuationAuthorization.providerDeadlineAt,
      minimumDispatchBudgetMs: MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS,
    });
    const [pendingRow] = await db.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1);
    const pendingReview = pendingRow ? readApplicationReview(pendingRow.spec) : null;
    if (!pendingRow || !pendingReview) return 'folded';
    const folded = await foldManagedSecurityCodeContinuationResult(
      pendingRow,
      pendingReview,
      attemptBinding,
      continuationSubmissionAttempt,
      managedBrowserTerminalResultId(continued),
      continued,
      new Date().toISOString(),
      fastify,
      [initialCleanupMarker],
    );
    await acknowledgeManagedTerminalFold(
      row,
      attemptBinding,
      initialSubmissionAttempt,
      initialResultId,
      fastify,
    );
    return folded;
  } catch (error) {
    if (error instanceof ManagedBrowserProviderProgressError
      && managedProviderProgressDisposition(error.runProgress, 'verification') === 'pressed') {
      await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'managed-security-code-submit', {
        evidenceCode: 'stratus_verification_press_progress',
      });
    }
    const [pendingRow] = await db.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1);
    const pendingReview = pendingRow ? readApplicationReview(pendingRow.spec) : null;
    if (pendingRow && pendingReview) {
      const recovered = await recoverManagedSecurityCodeContinuationTerminalResult(
        pendingRow,
        pendingReview,
        attemptBinding,
        fastify,
      );
      if (recovered !== 'not_recoverable') return recovered;
    }
    await recordManagedSecurityCodeContinuationUnverified(
      row,
      attemptBinding,
      error instanceof Error ? error.message : 'Recovered managed verification continuation failed',
      {
        securityCode: enteredSecurityCode,
        verification: baseVerification,
        cleanupMarkers: [
          initialCleanupMarker,
          pendingManagedTerminalCleanupMarker({
            attemptBinding,
            submissionAttempt: continuationSubmissionAttempt,
          }),
        ],
      },
    );
    await acknowledgeManagedTerminalFold(
      row,
      attemptBinding,
      initialSubmissionAttempt,
      initialResultId,
      fastify,
    );
    return 'folded';
  }
}

/**
 * Fold a retained Stratus result for one immutable boundary without opening another sandbox.
 * A pending result leaves the exact claim in flight so the next runner pass can poll it again.
 */
export async function recoverManagedSubmissionTerminalResult(
  row: ResumeRow,
  review: ApplicationReviewState,
  attemptBinding: SubmissionAttemptBinding,
  fastify: FastifyInstance,
  options: { actions?: ManagedBrowserAction[] } = {},
): Promise<ManagedTerminalRecoveryOutcome> {
  if (attemptBinding.source !== 'managed_browser'
    || attemptBinding.operation !== 'initial_submission'
    || attemptBinding.packetId !== row.id
    || attemptBinding.userId !== row.user_id
    || review.submission_claim_id !== attemptBinding.attemptId
    || review.submission_run_id !== attemptBinding.submissionRunId) return 'not_recoverable';
  const continuationRecovery = await recoverManagedSecurityCodeContinuationTerminalResult(
    row,
    review,
    attemptBinding,
    fastify,
  );
  if (continuationRecovery !== 'not_recoverable') return continuationRecovery;
  const authorization = await submissionBoundaryAuthorization(
    row.user_id,
    attemptBinding.attemptId,
  );
  if (!authorization) return 'not_recoverable';
  const submissionAttempt = managedInitialSubmissionAttempt(attemptBinding, authorization);
  const persistUnverified = async (
    message: string,
    categories: ApplicationAttentionCategory[],
    resultId?: string,
  ) => {
    const cleanupMarker = resultId
      ? exactManagedTerminalCleanupMarker({ attemptBinding, submissionAttempt, resultId })
      : pendingManagedTerminalCleanupMarker({ attemptBinding, submissionAttempt });
    await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
      message,
      attentionReason: 'Litos could not prove the final employer result for this exact application. Check the employer portal and record whether it was received.',
      attentionCategories: [...new Set([...categories, 'unverified_submission' as const])],
      cleanupMarkers: [cleanupMarker],
    });
    if (resultId) {
      await acknowledgeManagedTerminalFold(
        row,
        attemptBinding,
        submissionAttempt,
        resultId,
        fastify,
      );
    }
    return 'folded' as const;
  };
  let terminal;
  try {
    terminal = await getManagedBrowserTerminalResult(submissionAttempt, {
      ...(options.actions ? { actions: options.actions } : {}),
    });
  } catch (error) {
    fastify.log.warn({
      applicationId: row.id,
      attemptId: attemptBinding.attemptId,
      detail: error instanceof Error ? error.message.slice(0, 200) : 'Terminal retrieval failed',
    }, 'Managed terminal result could not be retrieved yet');
    const freshAuthorization = await submissionBoundaryAuthorization(
      row.user_id,
      attemptBinding.attemptId,
    );
    if (freshAuthorization?.active) return 'pending';
    await persistUnverified(
      'The managed result could not be retrieved before its employer-boundary authorization expired',
      [],
    );
    return 'folded';
  }
  if (terminal.state === 'pending' || (terminal.state === 'not_found' && authorization.active)) {
    return 'pending';
  }

  if (terminal.state === 'not_found' || terminal.state === 'gone') {
    return persistUnverified(
      terminal.state === 'gone'
        ? 'The retained managed result expired before Litos could fold it'
        : 'The managed result was not retained before its employer-boundary authorization expired',
      [],
    );
  }
  if (terminal.state === 'failed' || terminal.state === 'indeterminate') {
    const error = managedBrowserTerminalFailureError(terminal, options.actions ?? []);
    if (error instanceof ManagedBrowserProviderProgressError
      && managedProviderProgressDisposition(error.runProgress, 'application') === 'pressed') {
      await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'managed-initial-submit', {
        evidenceCode: 'stratus_application_press_progress',
      });
    }
    return persistUnverified(
      error.message.slice(0, 500) || 'The retained managed run ended without a terminal receipt',
      [],
      terminal.resultId,
    );
  }
  if (terminal.state !== 'completed') {
    return persistUnverified('The retained managed result could not be classified', []);
  }

  const result = terminal.run;
  if (!attemptBinding.postingIdentity.portalUrl) {
    return persistUnverified(
      'The retained managed result has no immutable employer URL binding',
      [],
      terminal.resultId,
    );
  }
  const expectedApplicationUrl = portalApplicationUrl(
    detectPortal(attemptBinding.postingIdentity.portalUrl),
    attemptBinding.postingIdentity.portalUrl,
  );
  const outcome = readManagedSubmitOutcome(result);
  if (outcome?.pressed === true) {
    await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'managed-initial-submit', {
      evidenceCode: 'stratus_application_press_echoed',
    });
  }
  const challenge = readManagedSecurityCodeChallenge(result);
  try {
    if (managedApplicationProofIsRequired(challenge, outcome)) {
      if (managedApplicationUsesAtomicSubmitV4(
        detectPortal(expectedApplicationUrl),
        expectedApplicationUrl,
      )) {
        assertManagedApplicationFinalSubmitSelected(result, expectedApplicationUrl);
      }
      assertManagedRequiredFieldsConfirmed(result, 'application');
      if (managedApplicationUsesAtomicSubmitV4(
        detectPortal(expectedApplicationUrl),
        expectedApplicationUrl,
      )) {
        assertManagedApplicationSubmitConsistency(result, expectedApplicationUrl);
      }
    }
  } catch (error) {
    return persistUnverified(
      error instanceof Error ? error.message.slice(0, 500) : 'Recovered managed proof was incomplete',
      ['required_field'],
      terminal.resultId,
    );
  }
  if (challenge) {
    return recoverManagedInitialSecurityCodeChallenge(
      row,
      review,
      attemptBinding,
      submissionAttempt,
      terminal.resultId,
      result,
      terminal.completedAt,
      challenge,
      fastify,
      options,
    );
  }
  const verdict = exactManagedSubmitVerdict(result, expectedApplicationUrl);
  if (verdict.kind !== 'confirmed') {
    return persistUnverified(
      `The recovered managed result was ${verdict.kind}`,
      [],
      terminal.resultId,
    );
  }
  const capturedAt = terminal.completedAt;
  const cleanupMarker = exactManagedTerminalCleanupMarker({
    attemptBinding,
    submissionAttempt,
    resultId: terminal.resultId,
  });
  const baseReceipt: NonNullable<ApplicationReviewState['receipt']> = {
    confirmation_text: verdict.confirmationText,
    final_url: result.url,
    captured_at: capturedAt,
    source: 'managed_browser',
  };
  const confirmed = await recordManagedSubmissionConfirmed(row, attemptBinding, {
    capturedAt,
    verification: { status: 'not_needed' },
    receipt: baseReceipt,
    receiptEvidence: { result, expectedApplicationUrl },
    cleanupMarkers: [cleanupMarker],
  });
  if (!confirmed) {
    return persistUnverified(
      'The recovered confirmation did not match its immutable application and packet binding',
      [],
      terminal.resultId,
    );
  }
  if (result.screenshot) {
    try {
      const blob = await storeReceiptScreenshot(
        `users/${row.user_id}/submission-runs/${review.submission_run_id}/receipt.png`,
        Buffer.from(result.screenshot, 'base64'),
      );
      await recordManagedSubmissionConfirmed(row, attemptBinding, {
        capturedAt,
        verification: { status: 'not_needed' },
        receipt: { ...baseReceipt, screenshot_url: blob.url },
        receiptEvidence: { result, expectedApplicationUrl },
      });
    } catch (error) {
      fastify.log.warn({
        applicationId: row.id,
        attemptId: attemptBinding.attemptId,
        detail: error instanceof Error ? error.message.slice(0, 200) : 'Receipt enrichment failed',
      }, 'Recovered confirmation persisted before screenshot enrichment failed');
    }
  }
  await acknowledgeManagedTerminalFold(
    row,
    attemptBinding,
    submissionAttempt,
    terminal.resultId,
    fastify,
  );
  return 'folded';
}

async function claimSubmission(row: ResumeRow, alreadyHeld = false): Promise<ResumeRow | null> {
  const current = readApplicationReview(row.spec);
  if (alreadyHeld) {
    if (!submissionClaimIsHeld(current)) return null;
    // A held claim without its immutable opening fact is legacy or partially written state. It can
    // never be allowed to cross an employer boundary after the ledger gate is active.
    await persistedRunnerAttemptBinding(row, current!);
    return row;
  }
  if (!current || current.status !== 'submitting' || current.submission_claimed_at) return null;
  const claimed = nextReview(current, submissionClaimPatch(new Date().toISOString(), randomUUID()));
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const duplicate = await duplicateApplicationVerdict({
      userId: row.user_id,
      applicationId: row.id,
      jobContext: row.job_context,
      portalUrl: current.portal_url,
    }, tx);
    if (duplicate.kind !== 'clear') return null;
    const openedToday = await submissionAttemptsOpenedToday(row.user_id, { executor: tx });
    if (!withinDailyCap(openedToday, dailySubmissionCap())) return null;
    const rows = await tx.update(generated_resumes)
      .set({
        spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(claimed)}::jsonb, true)`,
      })
      .where(and(
        eq(generated_resumes.id, row.id),
        sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
        sql`${generated_resumes.spec}->'_review'->>'status' = 'submitting'`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null`,
      ))
      .returning();
    if (!rows[0]) return null;
    const canonicalApplication = await canonicalApplicationForNewPacketAttempt(tx, {
      userId: rows[0].user_id,
      packetId: rows[0].id,
      postingIdentity: freezePostingIdentity(rows[0].job_context, claimed.portal_url),
    });
    const binding = runnerAttemptBinding(rows[0], claimed, 'initial_submission', canonicalApplication.id);
    await appendSubmissionAttemptEvent({
      ...binding,
      eventId: submissionAttemptEventId(binding.attemptId, 'attempt_opened', 'reservation'),
      eventKind: 'attempt_opened',
      evidenceCode: 'atomic_claim_reserved',
    }, { executor: tx });
    return rows[0];
  });
}

export function submissionClaimIsHeld(review: ApplicationReviewState | null | undefined): boolean {
  return review?.status === 'submitting'
    && typeof review.submission_claimed_at === 'string'
    && review.submission_claimed_at.trim().length > 0
    && typeof review.submission_claim_id === 'string'
    && review.submission_claim_id.trim().length > 0;
}

async function claimSecurityCodeSubmission(
  row: ResumeRow,
  current: ApplicationReviewState,
): Promise<ResumeRow | null> {
  if (current.status !== 'awaiting_security_code' || !current.security_code) return null;
  const requested = nextReview(current, {
    status: 'submitting',
    submission_authorization: {
      source: 'per_application_approval',
      authorized_at: new Date().toISOString(),
    },
    ...submissionClaimPatch(new Date().toISOString(), randomUUID()),
    submission_error: undefined,
  });
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const duplicate = await duplicateApplicationVerdict({
      userId: row.user_id,
      applicationId: row.id,
      jobContext: row.job_context,
      portalUrl: current.portal_url,
    }, tx);
    if (duplicate.kind !== 'clear') return null;
    const openedToday = await submissionAttemptsOpenedToday(row.user_id, { executor: tx });
    if (!withinDailyCap(openedToday, dailySubmissionCap())) return null;
    const rows = await tx.update(generated_resumes)
      .set({
        spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(requested)}::jsonb, true)`,
      })
      .where(and(
        eq(generated_resumes.id, row.id),
        sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
        sql`${generated_resumes.spec}->'_review'->>'status' = 'awaiting_security_code'`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null`,
      ))
      .returning();
    if (!rows[0]) return null;
    const canonicalApplication = await canonicalApplicationForNewPacketAttempt(tx, {
      userId: rows[0].user_id,
      packetId: rows[0].id,
      postingIdentity: freezePostingIdentity(rows[0].job_context, requested.portal_url),
    });
    const binding = runnerAttemptBinding(
      rows[0],
      requested,
      'security_code_continuation',
      canonicalApplication.id,
    );
    await appendSubmissionAttemptEvent({
      ...binding,
      eventId: submissionAttemptEventId(binding.attemptId, 'attempt_opened', 'reservation'),
      eventKind: 'attempt_opened',
      evidenceCode: 'atomic_security_code_claim_reserved',
    }, { executor: tx });
    return rows[0];
  });
}

async function claimPreparation(row: ResumeRow): Promise<ResumeRow | null> {
  const current = readApplicationReview(row.spec);
  if (!current || current.status !== 'submit_requested') return null;
  const preparing = nextReview(current, {
    status: 'preparing',
    submission_run_id: current.submission_run_id ?? randomUUID(),
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  });
  const rows = await db.update(generated_resumes)
    .set({
      spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(preparing)}::jsonb, true)`,
    })
    .where(and(
      eq(generated_resumes.id, row.id),
      sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
      sql`${generated_resumes.spec}->'_review'->>'status' = 'submit_requested'`,
    ))
    .returning();
  return rows[0] ?? null;
}

async function authorizationValidAtClick(row: ResumeRow, review: ApplicationReviewState): Promise<boolean> {
  if (review.submission_authorization?.source === 'per_application_approval') return true;
  if (review.submission_authorization?.source !== 'standing_consent') return false;
  return (await standingAuthorization(row.user_id)).enabled;
}

async function holdRevokedSubmission(
  row: ResumeRow,
  review: ApplicationReviewState,
  binding: SubmissionAttemptBinding,
  factKey: string,
  evidenceCode: string,
) {
  await writeReviewWithRunnerNotSentFact(row, nextReview(review, {
    status: 'ready_for_final_approval',
    submission_authorization: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  }), binding, factKey, {
    proofKind: 'typed_pre_click_stop',
    evidenceCode,
  });
}

const SUBMISSION_GRAD_MONTH_NAMES: Record<string, string> = {
  '01': 'January',
  '02': 'February',
  '03': 'March',
  '04': 'April',
  '05': 'May',
  '06': 'June',
  '07': 'July',
  '08': 'August',
  '09': 'September',
  '10': 'October',
  '11': 'November',
  '12': 'December',
};

export function submissionGraduationDateParts(
  gradDate: string | undefined,
  gradYear: number | undefined,
): { month?: string; year?: string } {
  const text = gradDate?.trim();
  if (!text && !gradYear) return {};
  const isoMatches = [...(text?.matchAll(/\b((?:19|20)\d{2})-(\d{2})(?:-\d{2})?\b/g) ?? [])];
  const iso = isoMatches.find((match) => match[1] === String(gradYear ?? '')) ?? isoMatches.at(-1);
  if (iso) return { year: iso[1], month: SUBMISSION_GRAD_MONTH_NAMES[iso[2]] };
  const years = text?.match(/\b(?:19|20)\d{2}\b/g) ?? [];
  const year = String(gradYear ?? years.at(-1) ?? '').trim() || undefined;
  const monthYearMatches = [...(text?.matchAll(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b[^0-9]{0,20}\b((?:19|20)\d{2})\b/gi) ?? [])];
  const monthYear = monthYearMatches.find((match) => match[2] === year) ?? monthYearMatches.at(-1);
  const month = monthYear?.[1] ?? text?.match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i)?.[1];
  return { month: month ? month[0].toUpperCase() + month.slice(1).toLowerCase() : undefined, year };
}

export function sanitizeEeoPrefs(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const cleaned: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (trimmed) cleaned[key] = trimmed;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function majorFromAcademicProfile(major: string | undefined, degree: string | undefined): string | undefined {
  if (major?.trim()) return major.trim();
  const trimmed = degree?.trim();
  if (!trimmed) return undefined;
  const cleaned = trimmed
    .replace(/\b(?:b\.?s\.?|b\.?a\.?|m\.?s\.?|m\.?a\.?|m\.?b\.?a\.?)\b/gi, ' ')
    .replace(/\b(?:bachelor|bachelor's|bachelors|master|master's|masters|doctor|doctorate|ph\.?d)\s+(?:of\s+)?(?:science|arts|business\s+administration)?\s+(?:degree\s+)?(?:in\s+)?/gi, ' ')
    .replace(/\b(?:degree\s+in|with\s+a\s+degree\s+in|in)\b/gi, ' ')
    .replace(/(?:,\s*)?[^,;&()]{0,40}\b(?:emphasis|concentration|minor)\b.*$/i, '')
    .replace(/[(),]/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || trimmed;
}

/**
 * The blob key of the cover letter this packet should carry, or null when there is nothing to carry.
 *
 * THE ONE CONDITION THAT KEPT EVERY COVER LETTER OFF EVERY FORM. This used to also require
 * `_cover_letter.approved_at` to be a string, and that single term is why no application Litos has
 * ever filled reached an employer with a cover letter attached. Measured against prod on
 * 2026-08-09: of the 112 packets whose form HAS a cover-letter control and which hold a written
 * letter, 111 recorded no cover-letter upload in filled_fields, and exactly one had `approved_at`
 * set at all.
 *
 * The requirement was circular, and the circle closed on the applicant. `approved_at` is written in
 * exactly one place, approvedReviewSpec in routes/applications.ts, on the FINAL APPROVE. Final
 * approve refuses (422, FINAL_APPROVAL_VERIFICATION_FAILED) unless filled_fields already records a
 * cover entry. filled_fields can only record one if the fill run carried the file. The fill run
 * could only carry the file once `approved_at` was set. So the only route to an attached cover
 * letter ran through an approval that could not be granted until the cover letter was attached.
 * Cresta packet 8142004c-3358-4538-8778-16df5e31c5bb sat in exactly that state: a complete
 * 294-word letter, a live 3121-byte PDF in blob storage, and a Send button that returned 422.
 *
 * Attaching is now decided by the same fact the product promises on the pre-fill screen: the form
 * has somewhere to put a cover letter and the applicant has one. WHETHER to attach is not this
 * function's question and never was - every caller already gates on `cover_letter_supported`
 * through omitCoverLetter, which is the honest reading of "does this form have a slot".
 */
export function coverLetterObjectKeyToAttach(spec: unknown): string | null {
  const stored = (spec && typeof spec === 'object' ? spec : {}) as Record<string, unknown>;
  const meta = (stored._cover_letter ?? {}) as Record<string, unknown>;
  const key = typeof meta.object_key === 'string' ? meta.object_key.trim() : '';
  return key || null;
}

/**
 * The blob key of the transcript this packet should carry, or null when there is nothing to carry.
 *
 * ONE TERM, AND IT IS THE FILE ITSELF. The condition above this one is the record of what a second
 * term costs: requiring an approval that the fill has to happen before is a circle, and 111 of the
 * 112 packets in the corpus that held a written cover letter were sitting inside it. Nothing here
 * may grow into that shape. Not an approval stamp, not attached_at, not a review status - if the
 * object key is on the spec, the file exists and she put it there, and that is the whole question.
 *
 * WHETHER to attach it is a different question with a different owner, exactly as it is for the
 * letter: the form has to have somewhere to put it, which is transcript_supported, measured by the
 * run and applied through omitTranscript by every caller. Splitting the two is what keeps this
 * function unable to deadlock.
 *
 * A blank key is not a key: resolveBlobUrl would list the whole store on an empty prefix.
 */
export function transcriptObjectKeyToAttach(spec: unknown): string | null {
  const stored = (spec && typeof spec === 'object' ? spec : {}) as Record<string, unknown>;
  const documents = stored._documents;
  if (!documents || typeof documents !== 'object' || Array.isArray(documents)) return null;
  const entry = (documents as Record<string, unknown>).transcript;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const key = (entry as Record<string, unknown>).object_key;
  return (typeof key === 'string' ? key.trim() : '') || null;
}

function referralIdentity(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

/**
 * Evidence that this packet was created from Litos's monitored job board, not from a profile
 * default or from the URL where the browser happens to be now. The company and role checks bind
 * the UUID to this packet, so an unrelated monitored row cannot be attached merely to obtain a
 * source answer.
 */
export async function referralSourceEvidenceForRow(row: ResumeRow): Promise<ReferralSourceEvidence | undefined> {
  const context = (row.job_context && typeof row.job_context === 'object' && !Array.isArray(row.job_context)
    ? row.job_context
    : {}) as Record<string, unknown>;
  const jobId = typeof context.job_id === 'string' ? context.job_id : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) return undefined;
  const [source] = await db.select({
    sourceId: monitored_jobs.source_id,
    company: monitored_jobs.company_name,
    role: monitored_jobs.title,
    sourceUrl: monitored_jobs.posting_url,
    observedAt: monitored_jobs.first_seen_at,
  })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(eq(monitored_jobs.id, jobId))
    .limit(1);
  if (!source) return undefined;
  if (referralIdentity(source.company) !== referralIdentity(context.company)) return undefined;
  if (referralIdentity(source.role) !== referralIdentity(context.role)) return undefined;
  return {
    kind: 'litos_job_board',
    value: 'Job board',
    jobId,
    sourceId: source.sourceId,
    sourceUrl: source.sourceUrl,
    observedAt: source.observedAt.toISOString(),
  };
}

type ResumePacketDependencies = {
  resolveObjectUrl: (objectKey: string) => Promise<string | null>;
  fetchObject: (url: string) => Promise<{
    ok: boolean;
    status?: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
  }>;
  verifiedBytes?: Buffer;
  initialObjectUrl?: string;
  waitBeforeRetry?: (delayMs: number) => Promise<void>;
};

/**
 * The controlled fixture is selected from the already-detected portal family, never from a URL or
 * object-key prefix. detectPortal only returns controlled_test for the signed QA route, and
 * assertControlledPortalEnabled separately refuses that family unless its test-only environment
 * gate is enabled. Keeping this predicate exact prevents an employer URL or a qa-looking Blob key
 * from opting itself into fixture documents.
 */
export function packetUsesControlledResumeFixture(portal: SupportedPortal): boolean {
  return portal === 'controlled_test';
}

/**
 * The packet questions handed to fillPortal, with her provenance carried through.
 *
 * A NAMED FUNCTION RATHER THAN THE INLINE MAP IT REPLACES, because the defect was the map's field
 * list and an inline literal has nowhere to hang a test. This is the last thing that touches
 * packet.questions before the fill, and it dropped answer_source, so every question arrived with
 * answerSource undefined regardless of what the earlier packet builds (~1024, ~2713) had set.
 *
 * applicantChoseAnswer is `answerSource === 'applicant_review'`. With it undefined here, three
 * merged fixes were inert on this path: #573 (an applicant answer beats a bucket recomputed from
 * the profile), #574 (her referral choice leads the typed candidates), #577 (the trailing label
 * pass types her choice, not the stored default). That is why the referral bug outlived all three.
 *
 * Measured on DV Trading e0a0eb84, 2026-08-18, live: the packet question read "Other" with
 * answer_source applicant_review right up to the submit, the run reported `no option matched
 * "Job board"` - packet.referralSourceDefault, the value pushGreenhouseReferralSourceAliases falls
 * back to when it cannot see an applicant choice - and her answer came back blanked.
 *
 * Ruled out first, by direct measurement rather than by reading: refreshKnownQuestionAnswers leaves
 * an applicant-reviewed "Other" untouched, and knownAnswerLookup returns undefined for a referral
 * label under every profile shape, including the packet-style injected one. Neither rewrites her
 * answer. This map did.
 */
type PacketQuestionSource = Pick<ApplicationReviewQuestion, 'question' | 'answer'>
  & Partial<Pick<ApplicationReviewQuestion,
    | 'required'
    | 'portal_selector'
    | 'portal_input_type'
    | 'ats_api_field'
    | 'answer_option_source'
    | 'answer_source'>>;

export function packetQuestionsForFill(
  mergedQuestions: readonly PacketQuestionSource[],
): SubmissionPacket['questions'] {
  return mergedQuestions.map((q) => ({
    question: q.question,
    answer: q.answer,
    portalSelector: q.portal_selector,
    portalInputType: q.portal_input_type,
    atsApiField: q.ats_api_field,
    answerOptionSource: q.answer_option_source,
    answerSource: q.answer_source,
    required: q.required,
  }));
}

function submissionPacketQuestions(
  questions: readonly ApplicationReviewQuestion[],
): SubmissionPacket['questions'] {
  return packetQuestionsForFill(questions);
}

export function stableManagedDocumentCapability(input: {
  authoritative?: boolean;
  discovered: boolean;
  prior?: boolean;
  current?: boolean;
}): boolean {
  if (input.authoritative !== undefined) return input.authoritative;
  if (input.discovered) return true;
  return input.prior ?? input.current ?? false;
}

export function managedFormSnapshotWithStableCapabilities(input: {
  discoveryFailed: boolean;
  fieldOptions?: SubmissionPacket['fieldOptions'];
  failedFields?: SubmissionPacket['failedFields'];
  prior?: ReturnType<typeof normalizeManagedFormSnapshot>;
  coverLetterSupported: boolean;
  transcriptSupported: boolean;
}): ReturnType<typeof normalizeManagedFormSnapshot> {
  return normalizeManagedFormSnapshot({
    fieldOptions: input.discoveryFailed ? input.prior?.field_options : input.fieldOptions,
    failedFields: input.discoveryFailed ? input.prior?.failed_fields : input.failedFields,
    coverLetterSupported: input.coverLetterSupported,
    transcriptSupported: input.transcriptSupported,
  });
}

/* THE WRITE SIDE OF THE SNAP CONTRACT: the record must say what the build actually did.
 *
 * This decides whether a resolved closed-choice answer carries a snap claim; the gate immediately
 * below decides what to do with one. They are two halves of one rule and are kept together for
 * that reason - the value written into `answer` is the employer's option text byte for byte, so
 * the test for "did anything move" has to be byte identity too. It was not.
 *
 * THE DEFECT, and it is a gap between two equivalence classes rather than a missing rule.
 * chooseClosestOption matches on comparableOption (lib/selfIdentification.ts): it folds case,
 * deletes apostrophes, collapses every other punctuation run to a space - and then returns the
 * CONTROL's own bytes. The guard here asked only whether the resolved value differed from the
 * profile value after trim + toLowerCase, an equivalence class strictly NARROWER than the
 * matcher's. Everything in the gap is a snap that changes bytes without changing meaning, and the
 * single largest class in that gap is the one that differs by capitalization alone: the answer was
 * rewritten to the employer's spelling and nothing on the record said so.
 *
 * CONFIRMED BY MEASUREMENT, not inferred. Application 6de82956, run 097ddf87, Lever, 2026-08-26
 * 11:31:38 UTC, reproduced on every consecutive attempt (deterministic, not flaky). Driving the
 * real resolvers with the three EEO controls that run's diagnostic listed reproduces its `changed`
 * array exactly, and exactly one row parks:
 *
 *   LGBTQIA label, decline listed "Decline To Self-Identify"  -> moved ["answer"]              PARK
 *   "veteran status",    decline "I don't wish to answer"     -> moved ["answer","answerOS"]   pass
 *   "disability status", decline "I do not want to answer"    -> moved ["answer","answerOS"]   pass
 *
 * The last two differ from the resolver's "Decline to self-identify" case-INSENSITIVELY as well, so
 * the old guard fired, recorded the claim, and e0aaa88's exemption accepted them - which is why the
 * warn line kept listing all three and why that commit looked inert. Only the case-only row was
 * silenced, and one refused row fails the whole multiset, so the run parked,
 * holdPreparationForPacketDrift cleared the acknowledgement, and the applicant was bounced back to
 * re-approve a packet nobody had changed, for as many rounds as she was willing to do it. Both
 * logged issue strings came from that one row: the delivery check's `questionsMatch &&`
 * short-circuits, so the payload line is a shadow of the questions line, not a second fault.
 *
 * A STRICT INCREASE IN WHAT IS WRITTEN DOWN, and nothing else. This suppresses no comparison,
 * widens no exemption and touches no part of the gate. packetQuestionEqualsAcknowledged still
 * demands snapClaim.length > 0 AND snapClaim === the acknowledged answer byte for byte, so an
 * answer that moved with no claim beside it still refuses, a claim naming any other value still
 * refuses, a minted answerSource still refuses, and a question added, removed or moved in any
 * non-snap field still refuses. It completes e0aaa88 by feeding that rule the evidence it asks for.
 *
 * THE TRUST ANCHOR IS matchedOption, here at write time: the value really did come off the
 * control's own list. The gate does not re-verify list membership, which is the same trade e0aaa88
 * already made for punctuation-differing snaps - widened, not created, by byte identity.
 *
 * INFERRED, not measured: that no other family reaches this line with a case-only snap today.
 * Nothing here is keyed on a label, a portal or the EEO family and nothing here should be - any
 * closed-choice control whose option differs from the profile value by capitalization alone sat in
 * the same gap and now records the same claim.
 */
export function optionSnapClaim(
  resolvedField: { value: string; matchedOption: boolean } | null | undefined,
  profileKnown: { value: string } | { skipReason: string } | null | undefined,
): string | undefined {
  if (!resolvedField?.matchedOption) return undefined;
  if (!profileKnown || !('value' in profileKnown) || !profileKnown.value.trim()) return undefined;
  return resolvedField.value !== profileKnown.value ? profileKnown.value : undefined;
}

/* A DOCUMENTED OPTION SNAP IS THE ACKNOWLEDGED ANSWER, not a change to it.
 *
 * The prepare pass resolves closed-choice answers against the LIVE option lists and types the
 * employer's exact phrasing, recording the value it snapped FROM in answer_option_source (the
 * ANSWER-CLAIM contract in applicationReview.ts: "this value was snapped for profile value X").
 * The audit-side reading resolves the same questions without those lists, so its answers keep the
 * acknowledged phrasing and no snap claim. Byte-comparing the two parked every single round on
 * fee9f00c (Greenhouse: gpa + three EEO selects), c4413bff and 6de82956 (Lever: three education
 * comboboxes, plus form order), 2026-08-26 - the questionsDrift diagnostic showed added:[],
 * removed:[], with only `answer` and `answerOptionSource` moving, which is the snap's exact
 * signature and nobody else's.
 *
 * So a packet question is accepted against its acknowledged counterpart when it is byte-equal, OR
 * when the ONLY moved fields are answer and answerOptionSource and the snap claim names the
 * acknowledged answer byte-for-byte (trimmed). Anything else - a different value, an undocumented
 * rewrite, a question added or dropped - still refuses. Order is compared as a multiset because
 * the live form's own sequence is not applicant content; what she approved is the set of answers.
 */
/* answer and answerOptionSource move together in a snap; answerSource may only be DROPPED by one.
 * The applicant's review claim is keyed on the byte-identity of the answer (APPLICANT_CLAIM_FIELDS
 * in applicationReview.ts), so the snap that rephrases her answer rightly sheds the claim - but a
 * packet that MINTS a claim the acknowledged reading never held is asserting she reviewed a value
 * she did not, and refuses. */
const SNAP_EXEMPT_FIELDS = new Set(['answer', 'answerOptionSource', 'answerSource']);

/* WHERE THE ANSWER IS TYPED IS THE LIVE FORM'S BUSINESS, NOT HER APPROVAL'S, and comparing it is the
 * second half of the same deadlock the snap rule closed - the half that made a RETRY pointless.
 *
 * This is the argument applicationReview.ts already makes for `options`: the employer receives the
 * VALUE she chose, never the control it was chosen on, so hashing the control spends a stored
 * acknowledgement the first time a board's DOM moves. These three are read fresh off the page every
 * run. portalSelectorForField hands back the per-page-load `[data-litos-discovered-N]` marker for
 * any control with no durable id, portal_input_type flaps text/combobox on a react-select that
 * mounts late, and `required` is whatever the form advertised this minute. The acknowledged copy is
 * not her reading of them; it is the PREVIOUS run's reading of the same page, and it is the older
 * and likelier-wrong of the two. Because the marker is renumbered on every load, the packet could
 * never equal the audit however many times she re-approved.
 *
 * Refusing on them cannot protect the boundary: no selector change can put an answer she never
 * approved INTO the packet. It can only put an approved answer in the wrong control, and the
 * managed runner's own post-fill value verification is what catches that. atsApiField stays
 * compared - on the ATS API channel it is the DESTINATION KEY, not aiming. */
const LIVE_FORM_READING_FIELDS = new Set(['portalSelector', 'portalInputType', 'required']);

function packetQuestionEqualsAcknowledged(
  packetQ: SubmissionPacket['questions'][number],
  verifiedQ: SubmissionPacket['questions'][number],
): boolean {
  if (isDeepStrictEqual(packetQ, verifiedQ)) return true;
  const fields = new Set([...Object.keys(packetQ), ...Object.keys(verifiedQ)]) as Set<keyof typeof packetQ>;
  for (const field of fields) {
    if (SNAP_EXEMPT_FIELDS.has(field) || LIVE_FORM_READING_FIELDS.has(field)) continue;
    if (!isDeepStrictEqual(packetQ[field], verifiedQ[field])) return false;
  }
  if (packetQ.answerSource !== undefined && !isDeepStrictEqual(packetQ.answerSource, verifiedQ.answerSource)) {
    return false;
  }
  /* The acknowledged answer, unchanged, with only the live form's aiming moved beneath it. There is
   * no snap to document because nothing about the ANSWER moved, so the claim rule below - which
   * exists to license a REPHRASING - must not be asked to license this. */
  if (isDeepStrictEqual(packetQ.answer, verifiedQ.answer)
    && isDeepStrictEqual(packetQ.answerOptionSource, verifiedQ.answerOptionSource)) return true;
  const snapClaim = typeof packetQ.answerOptionSource === 'string' ? packetQ.answerOptionSource.trim() : '';
  const acknowledged = typeof verifiedQ.answer === 'string' ? verifiedQ.answer.trim() : '';
  return snapClaim.length > 0
    && snapClaim === acknowledged
    && typeof packetQ.answer === 'string'
    && packetQ.answer.trim().length > 0;
}

/* ABSENT answer_source IS NOT EVIDENCE OF ANYTHING, and treating it as a licence to send is how a
 * fix for the old equal-length rule widens the boundary it was meant to protect.
 *
 * MEASURED live on trylitos.com, 2026-08-26. Six parked applications were retried. Pony.ai carried 2
 * questions and reached ready_for_final_approval; Old Mission (9), Jump Trading (11), Tower Research
 * (14), IMC Trading (22) and Cloudflare (22) all parked here, every one telling the applicant "this
 * application changed after you approved" about a change she had not made. The two sides are not the
 * same population: packet.questions is the LIVE form at fill time, verifiedProjected is the audit's
 * set, and a form carrying more fields than the audit met is ordinary rather than tampered.
 *
 * The flag is 'applicant_review' | 'consent_permission' and NOTHING ELSE (applicationReview.ts), so
 * it is absent on every MACHINE answer, not merely on profile relays: the essay drafter pushes its
 * paragraph with no flag, and answerReuse hands back a sentence she typed on a DIFFERENT employer's
 * form with no flag either. "Carries no claim of hers" and "safe to send unreviewed" are not the
 * same set, and the second one is empty.
 *
 * So an extra question is SORTED, not judged. It is not DRIFT - nothing she approved moved, and
 * telling her the application changed sends her back to re-approve a packet with nothing wrong in
 * it, which is the loop that never converged. It is also not SENDABLE, because the audit never
 * showed it to her. It is a question, and the answer to a question is to ask it: the prepare hold
 * writes the merged set onto the review and drops the acknowledgement, so her next approval covers
 * it and the round after completes. One extra round, once, instead of forever. */
export function packetQuestionAcknowledgement(
  packetQuestions: SubmissionPacket['questions'],
  verifiedProjected: SubmissionPacket['questions'],
): { missing: string[]; unacknowledged: string[]; forged: string[] } {
  const unmatched = [...verifiedProjected];
  const extras: SubmissionPacket['questions'] = [];
  for (const packetQ of packetQuestions) {
    // Exact matches claim their twin first so a snap cannot steal a duplicate label's exact pair.
    let index = unmatched.findIndex((verifiedQ) => isDeepStrictEqual(packetQ, verifiedQ));
    if (index === -1) {
      index = unmatched.findIndex((verifiedQ) => packetQuestionEqualsAcknowledged(packetQ, verifiedQ));
    }
    if (index === -1) {
      extras.push(packetQ);
      continue;
    }
    unmatched.splice(index, 1);
  }
  return {
    missing: unmatched.map((verifiedQ) => verifiedQ.question),
    unacknowledged: extras.filter((q) => q.answerSource === undefined).map((q) => q.question),
    forged: extras.filter((q) => q.answerSource !== undefined).map((q) => q.question),
  };
}

export function packetQuestionsMatchAcknowledged(
  packetQuestions: SubmissionPacket['questions'],
  verifiedProjected: SubmissionPacket['questions'],
): boolean {
  const { missing, unacknowledged, forged } = packetQuestionAcknowledgement(packetQuestions, verifiedProjected);
  return missing.length === 0 && unacknowledged.length === 0 && forged.length === 0;
}

/**
 * Compare the exact packet about to cross the employer boundary with the audit that authorized it.
 * The caller must send this same object after the check, never rebuild it.
 */
export function verifiedBuiltPacketIssues(
  packet: SubmissionPacket,
  audit: PacketAudit,
  verifiedQuestions: readonly ApplicationReviewQuestion[],
  mode: EmployerPacketDeliveryMode,
  envelope: EmployerDeliveryEnvelope,
): string[] {
  const issues: string[] = [];
  if (packetAuditSha256(packet.applicantSnapshot) !== audit.bindings.applicantSnapshotSha256) {
    issues.push('applicant snapshot changed after packet approval');
  }
  if (packetAuditTextSha256(packet.jdText ?? '') !== audit.bindings.jdSha256) {
    issues.push('job description changed after packet approval');
  }
  if (packet.email.trim().toLowerCase() !== audit.identities.applicant_email.trim().toLowerCase()) {
    issues.push('applicant email changed after packet approval');
  }
  if (packet.resume.byteLength !== audit.bindings.pdf.sizeBytes
    || createHash('sha256').update(packet.resume).digest('hex') !== audit.bindings.pdf.sha256) {
    issues.push('resume file changed after packet approval');
  }
  const verifiedProjected = submissionPacketQuestions(verifiedQuestions);
  const acknowledgement = packetQuestionAcknowledgement(packet.questions, verifiedProjected);
  /* Drift is the stronger statement and refuses on its own, so the ask never rides beside it: a
   * packet that moved something she approved is not a packet with a new question on it. */
  if (acknowledgement.missing.length > 0 || acknowledgement.forged.length > 0) {
    issues.push('application questions changed after packet approval');
  } else if (acknowledgement.unacknowledged.length > 0) {
    issues.push(PACKET_QUESTIONS_UNACKNOWLEDGED_ISSUE);
  }
  /* The delivery re-hash below may only stand down for a packet whose questions ALL matched. An
   * unacknowledged extra is still a question the audit never bound, so it must not buy the snap-only
   * exemption any more than a drift would. */
  const questionsMatch = acknowledgement.missing.length === 0
    && acknowledgement.unacknowledged.length === 0
    && acknowledgement.forged.length === 0;
  const deliveryIssue = employerDeliveryBindingIssue(packet, audit.bindings.employerDelivery, mode, envelope);
  if (deliveryIssue) {
    /* The delivery sha hashes the whole projection, questions included, so documented snaps fail
     * it even though the gate above just accepted them. Substituting the acknowledged questions
     * back and re-hashing tests the strongest remaining claim: every OTHER byte of the payload and
     * envelope is exactly what the audit bound. A live form whose options, capabilities or
     * destination actually moved still mismatches here and still parks. */
    const snapOnly = questionsMatch
      && employerDeliveryBindingIssue(
        { ...packet, questions: verifiedProjected },
        audit.bindings.employerDelivery,
        mode,
        envelope,
      ) === null;
    if (!snapOnly) issues.push(deliveryIssue);
  }
  return issues;
}

function assertVerifiedBuiltPacket(
  packet: SubmissionPacket,
  audit: PacketAudit,
  verifiedQuestions: readonly ApplicationReviewQuestion[],
  mode: EmployerPacketDeliveryMode,
  envelope: EmployerDeliveryEnvelope,
): void {
  const issues = verifiedBuiltPacketIssues(packet, audit, verifiedQuestions, mode, envelope);
  if (issues.length > 0) {
    throw new Error(`The employer-bound packet changed after approval: ${issues.join('; ')}`);
  }
}

export async function transportVerifiedBuiltPacket<T>(
  packet: SubmissionPacket,
  audit: PacketAudit,
  verifiedQuestions: readonly ApplicationReviewQuestion[],
  transport: (exactPacket: SubmissionPacket) => Promise<T>,
  mode: EmployerPacketDeliveryMode,
  envelope: EmployerDeliveryEnvelope,
): Promise<T> {
  assertVerifiedBuiltPacket(packet, audit, verifiedQuestions, mode, envelope);
  return transport(packet);
}

export function employerPageUrlIssue(expected: string, observed: string | undefined): string | null {
  try {
    const expectedUrl = new URL(expected);
    const observedUrl = new URL(observed ?? '');
    expectedUrl.hash = '';
    observedUrl.hash = '';
    /* observedUrl comes straight from this process's own page.url(), not through Stratus's managed
     * sandbox, so nothing upstream has already normalized param order the way the managed-run
     * proof does - some ATS front ends (Greenhouse's embed bootstrap, confirmed live on Redwood
     * Materials) re-serialize the same params in a different order after mount, so both sides need
     * the same sort or a page that never moved can still fail here. */
    sortManagedPageUrlParams(expectedUrl);
    sortManagedPageUrlParams(observedUrl);
    return resolvedApprovedApplicationPageUrl(expectedUrl, observedUrl)
      ? null
      : 'the employer page redirected away from the approved destination';
  } catch {
    return 'the employer page did not report a valid approved destination';
  }
}

function assertEmployerPageUrl(expected: string, observed: string | undefined): void {
  const issue = employerPageUrlIssue(expected, observed);
  if (issue) throw new Error(issue);
}

/** Private operator context for runner failures. Keep applicant values out of hosted logs. */
export function privateRunnerStepDiagnostic(error: unknown): {
  errorName: string;
  errorCode?: string;
  errorMessage: string;
  errorFingerprint: string;
} {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown } | null;
  const raw = typeof candidate?.message === 'string'
    ? candidate.message
    : 'Unknown application runner failure';
  const errorName = typeof candidate?.name === 'string' && /^[A-Za-z][A-Za-z0-9_$]{0,79}$/.test(candidate.name)
    ? candidate.name
    : 'Error';
  const errorCode = typeof candidate?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate.code)
    ? candidate.code
    : undefined;
  const errorMessage = raw
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\+?\d(?:[\s().-]*\d){7,}/g, '[phone]')
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[token]')
    .slice(0, 300);
  return {
    errorName,
    ...(errorCode ? { errorCode } : {}),
    errorMessage,
    errorFingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 16),
  };
}

/* THE APPLICANT'S SENTENCE FOR EACH DRIFT BINDING, keyed by verifiedBuiltPacketIssues' exact
 * strings. Those strings are for operators and thrown errors; an applicant who is told only "it
 * changed" reopens the packet, sees nothing different, approves, and lands here again - the same
 * shape as the four-round Easy Dynamics loop of 2026-08-20, except this time nothing anywhere said
 * WHICH binding moved. Naming the moved part is what lets her (or us) break the cycle. */
/* Its own issue string, and it must stay one: assertVerifiedBuiltPacket throws on ANY issue, so the
 * send paths stay exactly as fail-closed as they were, while the prepare hold can read this one and
 * say the true sentence instead of the drift one. */
export const PACKET_QUESTIONS_UNACKNOWLEDGED_ISSUE = 'this form asks questions the packet approval never covered';

const APPLICANT_PACKET_DRIFT_PHRASES: Record<string, string> = {
  'applicant snapshot changed after packet approval': 'your saved profile details',
  'job description changed after packet approval': 'the job description',
  'applicant email changed after packet approval': 'the application email',
  'resume file changed after packet approval': 'the resume file',
  'application questions changed after packet approval': 'the application questions',
  // Only reached when a real drift rides alongside the ask; on its own it gets its own sentence.
  [PACKET_QUESTIONS_UNACKNOWLEDGED_ISSUE]: 'the questions this form asks',
};

/* WHICH QUESTIONS MOVED, AND HOW - employer labels and field names only, never answer values.
 * The pair of issues measured on fee9f00c/c4413bff/6de82956 (2026-08-26) recurred identically on
 * every round across two portals, and the issue strings alone cannot say whether the sets differ,
 * one projected field differs, or only the ORDER differs (the gate's isDeepStrictEqual is
 * order-sensitive). This diff is what turns "the questions changed" into a fixable statement.
 *
 * READ IT AS A DIFF, NEVER AS THE GATE'S VERDICT. It is computed independently of
 * packetQuestionsMatchAcknowledged and does not consult a single one of its exemptions, so a
 * documented option snap and a live form reorder both show up here on runs that PROCEED. On
 * 6de82956/097ddf87 (2026-08-26) that cost real time: three EEO rows were listed `changed` and
 * orderChanged was true, but two of the three carried their snap claim and were already being
 * accepted, and the order has not been able to park a run since e0aaa88 made the comparison a
 * multiset. Only one row - `fields: ["answer"]`, no claim - was the fault. The success signal for
 * any fix in this area is therefore the ABSENCE of the enclosing warn line, not a cleaner diff
 * inside it, and a row that carries answerOptionSource is the least interesting row in the list. */
export function packetQuestionsDriftDiagnostic(
  packetQuestions: SubmissionPacket['questions'],
  verifiedQuestions: SubmissionPacket['questions'],
): {
  added: string[];
  removed: string[];
  changed: Array<{ question: string; fields: string[] }>;
  orderChanged: boolean;
} {
  const label = (q: SubmissionPacket['questions'][number]) => q.question;
  const byLabel = (list: SubmissionPacket['questions']) => {
    const map = new Map<string, SubmissionPacket['questions'][number]>();
    for (const q of list) if (!map.has(label(q))) map.set(label(q), q);
    return map;
  };
  const packetMap = byLabel(packetQuestions);
  const verifiedMap = byLabel(verifiedQuestions);
  const added = [...packetMap.keys()].filter((k) => !verifiedMap.has(k));
  const removed = [...verifiedMap.keys()].filter((k) => !packetMap.has(k));
  const COMPARED_FIELDS = [
    'answer', 'portalSelector', 'portalInputType', 'atsApiField',
    'answerOptionSource', 'answerSource', 'required',
  ] as const;
  const changed: Array<{ question: string; fields: string[] }> = [];
  for (const [key, packetQ] of packetMap) {
    const verifiedQ = verifiedMap.get(key);
    if (!verifiedQ) continue;
    const fields = COMPARED_FIELDS.filter((f) => !isDeepStrictEqual(packetQ[f], verifiedQ[f]))
      // 'answer' may hold the applicant's own text; name the field, never the values.
      .map((f) => String(f));
    if (fields.length > 0) changed.push({ question: key, fields });
  }
  const sharedPacketOrder = packetQuestions.map(label).filter((k) => verifiedMap.has(k));
  const sharedVerifiedOrder = verifiedQuestions.map(label).filter((k) => packetMap.has(k));
  return {
    added,
    removed,
    changed,
    orderChanged: !isDeepStrictEqual(sharedPacketOrder, sharedVerifiedOrder),
  };
}

export function packetDriftAttentionReason(issues: readonly string[]): string {
  /* Not drift, so not the drift sentence. She changed nothing; the form asks more than the packet she
   * approved covered, and the only honest next step is the one that actually clears it. */
  if (issues.length > 0 && issues.every((issue) => issue === PACKET_QUESTIONS_UNACKNOWLEDGED_ISSUE)) {
    return 'This company form asks questions your approved packet did not cover, so nothing was sent.'
      + ' Open it, answer them, and approve it again.';
  }
  const phrases = [...new Set(issues.map((issue) =>
    APPLICANT_PACKET_DRIFT_PHRASES[issue] ?? 'how Litos reaches this employer'))];
  const what = phrases.length > 0 ? ` What changed: ${phrases.join(', ')}.` : '';
  return 'This application changed after you approved the exact packet Litos prepared, so it was not sent.'
    + what
    + ' Open it to review the current one and send from there.';
}

async function holdPreparationForPacketDrift(input: {
  row: ResumeRow;
  current: ApplicationReviewState;
  packet: SubmissionPacket;
  audit: PacketAudit;
  verifiedQuestions: readonly ApplicationReviewQuestion[];
  mode: EmployerPacketDeliveryMode;
  envelope: EmployerDeliveryEnvelope;
  patch: Partial<ApplicationReviewState>;
  log: FastifyInstance['log'];
}): Promise<boolean> {
  const issues = verifiedBuiltPacketIssues(
    input.packet,
    input.audit,
    input.verifiedQuestions,
    input.mode,
    input.envelope,
  );
  if (issues.length === 0) return false;
  /* The issue strings are static English naming a binding, never applicant values, so they are
   * safe for hosted logs - and without this line the drift class is invisible: the run parks, the
   * applicant re-approves, and no record anywhere says which binding kept moving. */
  input.log.warn(
    {
      applicationId: input.row.id,
      runId: input.patch.submission_run_id,
      packetDriftIssues: issues,
      ...(issues.includes('application questions changed after packet approval')
        ? {
          questionsDrift: packetQuestionsDriftDiagnostic(
            input.packet.questions,
            submissionPacketQuestions(input.verifiedQuestions),
          ),
        }
        : {}),
    },
    'Application preparation withheld because the built packet drifted from the acknowledged audit',
  );
  await writeReview(input.row, nextReview(input.current, {
    ...input.patch,
    status: 'needs_attention',
    attention_reason: packetDriftAttentionReason(issues),
    /* A question waiting to be asked is something she can finish, not a gap in her evidence. */
    attention_categories: issues.every((issue) => issue === PACKET_QUESTIONS_UNACKNOWLEDGED_ISSUE)
      ? ['required_field']
      : ['evidence_gap'],
    packet_audit_acknowledgement: undefined,
    submission_authorization: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  }));
  return true;
}

async function persistQuestionMetadataMeasurement(
  row: ResumeRow,
  runId: string,
  blockers: readonly QuestionMetadataBlocker[],
): Promise<void> {
  const serialized = JSON.stringify([...blockers]);
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(
      coalesce(${generated_resumes.spec}, '{}'::jsonb),
      '{_review}',
      coalesce(${generated_resumes.spec}->'_review', '{}'::jsonb)
        || jsonb_build_object('question_metadata_blockers', ${serialized}::jsonb),
      true
    )`,
  }).where(and(
    eq(generated_resumes.id, row.id),
    sql`${generated_resumes.spec}->'_review'->>'submission_run_id' = ${runId}`,
  ));
}

/** Load the resume bytes independently from the rest of packet assembly so fixture isolation is testable. */
export async function resumeBytesForPacket(
  objectKey: string,
  controlledTest: boolean,
  dependencies: ResumePacketDependencies = {
    resolveObjectUrl: resolveBlobUrl,
    fetchObject: (url) => fetch(url),
  },
): Promise<Buffer> {
  if (controlledTest && process.env.LITOS_ENABLE_TEST_PORTAL === 'true') {
    return Buffer.from('%PDF-1.4\n% Litos controlled submission fixture\n%%EOF\n');
  }
  /* currentPacketAudit already downloaded and hash-verified these exact bytes. Reuse that same
     immutable copy for the employer packet instead of making a second Blob request between the
     audit and the fill. The copy keeps later packet assembly from mutating the cache-owned Buffer. */
  if (dependencies.verifiedBytes !== undefined) return Buffer.from(dependencies.verifiedBytes);
  let blobUrl = dependencies.initialObjectUrl?.trim()
    || await dependencies.resolveObjectUrl(objectKey);
  /* Typed, because this is the retention sweep arriving rather than a malfunction. See
     PacketDocumentExpiredError for why an untyped throw here told the applicant to go and look for
     a confirmation of an application that was never filled in. Only the resolve is typed: a key that
     resolves to a URL which then fails to download is a live storage fault, not an expired packet,
     and the two owe different sentences. */
  if (!blobUrl) throw new PacketDocumentExpiredError('resume');
  const waitBeforeRetry = dependencies.waitBeforeRetry
    ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const retryDelays = [100, 400] as const;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      const response = await dependencies.fetchObject(blobUrl);
      if (response.ok) return Buffer.from(await response.arrayBuffer());
    } catch {
      // A failed body read and a failed request have the same safe outcome: retry the exact object,
      // then stop before any employer action if storage remains unavailable.
    }
    if (attempt === retryDelays.length) break;
    await waitBeforeRetry(retryDelays[attempt]);
    try {
      blobUrl = (await dependencies.resolveObjectUrl(objectKey)) || blobUrl;
    } catch {
      // Keep the already-authorized strong pointer for the next bounded attempt. Resolver failure
      // is not evidence that the audited object disappeared after the first successful resolve.
    }
  }
  throw new Error('Generated resume file could not be downloaded');
}

async function fetchStoredCoverLetter(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Generated cover letter file could not be downloaded');
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The letter rebuilt from the row, for a packet whose letter file has been swept.
 *
 * Reads through storedCoverLetter rather than the raw `_cover_letter` object so that a half-written
 * artifact is treated as no letter at all, exactly as every other reader of it does. A letter that
 * cannot be rebuilt raises the typed error, which packetForCoverLetterCapability degrades into
 * "written but not attached" - the same outcome an unreachable file already produced, so nothing
 * gets worse than it was when the rebuild is impossible.
 */
async function rerenderStoredCoverLetter(row: ResumeRow, stored: StoredSpec): Promise<Buffer> {
  const artifact = storedCoverLetter(row);
  const job = (row.job_context ?? {}) as { company?: unknown };
  const contact = (stored._contact ?? {}) as Record<string, unknown>;
  if (!artifact || typeof job.company !== 'string') throw new PacketDocumentExpiredError('cover_letter');
  return rerenderFrozenCoverLetter({
    fullName: String(contact.full_name ?? '').trim(),
    email: typeof contact.email === 'string' ? contact.email : undefined,
    company: job.company,
    body: artifact.body,
    generatedAt: artifact.generated_at,
  });
}

/**
 * The plaintext bytes of a document the student attached herself, for the fill.
 *
 * THREE DEPARTURES FROM THE COVER LETTER'S BRANCH, each one measured rather than stylistic.
 *
 * IT KEEPS THE FIXTURE BRANCH. packetUsesControlledResumeFixture covers the resume only, so a
 * controlled QA run carrying a transcript would go to Vercel Blob for a real object and fail on a
 * portal that exists to have no dependencies. A controlled run gets fixture bytes for every file it
 * carries or it is not a controlled run.
 *
 * IT READS blob_url BEFORE resolveBlobUrl. The resolver goes through list({ prefix }), which is
 * eventually consistent with no stated bound: reproduced server-side still 404ing 54 seconds after
 * the write, and R-040 was every Ashby fill of 2026-07-18 shipping without a resume because of it. A
 * transcript uploaded and attached in one sitting is exactly that window, and the failure is silent
 * in the worst direction - a file that is there reads as missing. The URL put() returned is a column
 * on the row for this reason; the resolver stays as the fallback for a row written before it.
 *
 * IT UNSEALS. The bytes in the blob are AES-256-GCM ciphertext, not a PDF. That is what makes the
 * privacy sentence true, and it means every read has to come through here rather than through a
 * plain fetch, or the form gets an unreadable file named transcript.pdf.
 *
 * THE SCOPED ROW IS THE AUTHORISATION, AND A MISS IS A REFUSAL. That sentence is the correction of a
 * real hole, not a restatement of an intention, and the shape of the hole is worth keeping because
 * the same shape is available to any future reader of this store. The lookup was scoped by user from
 * the first line it was written, and the miss then handed `blob_url: null` on to
 * documentBytesFromPointer - which falls back to resolveBlobUrl, a resolver that takes an object key
 * and NOTHING ELSE and resolves any key in the store. So a spec naming another account's key missed
 * the scoped row and then fetched that account's file through the back door, while the comment here
 * and the test in transcriptAttachment.test.ts both asserted the scoping and both stayed green,
 * because what they checked was the query and what was wrong was the fall-through underneath it.
 *
 * Encryption is not a second line of defence here and should not be read as one: the key comes from
 * one server secret and one fixed salt (lib/documentCrypto.ts), so any bytes that resolve are bytes
 * that decrypt. The scope check is the whole of the control.
 *
 * So the miss throws, and the only object key that can now reach a resolver is one read back off a
 * row this user owns. Throwing rather than returning nothing is what makes the failure legible:
 * buildPacket's catch carries it as the packet's unavailable reason, both prepares log the message
 * verbatim, and packetForTranscriptCapability owes the applicant a sentence. A silent empty
 * attachment would be an application that claims a transcript and sends none, which is the exact
 * failure this whole path exists to prevent.
 *
 * Tombstones are deliberately not filtered out: a removed document's row is the fastest way to a
 * clear 404 on a dead pointer, where filtering it would turn a pointer that IS hers into the
 * refusal above and name the wrong reason on the log line.
 */
export async function documentBytesForPacket(
  userId: string,
  objectKey: string,
  controlledTest: boolean,
  dependencies?: ResumePacketDependencies,
): Promise<Buffer> {
  if (controlledTest && process.env.LITOS_ENABLE_TEST_PORTAL === 'true') {
    return Buffer.from('%PDF-1.4\n% Litos controlled attached-document fixture\n%%EOF\n');
  }
  const [row] = await db.select({
    blob_url: user_documents.blob_url,
    object_key: user_documents.object_key,
  })
    .from(user_documents)
    .where(and(eq(user_documents.object_key, objectKey), eq(user_documents.user_id, userId)))
    .limit(1);
  if (!row) throw new ForeignDocumentPointerError();
  // The row's own key, not the argument, even though the predicate makes them equal. It costs one
  // selected column to make the fall-through structurally unable to resolve anything but a key that
  // came back off an owned row, and equality by predicate is exactly the kind of reasoning the bug
  // above was made of.
  return documentBytesFromPointer({ blobUrl: row.blob_url, objectKey: row.object_key }, dependencies);
}

export async function buildPacket(
  row: ResumeRow,
  controlledTest = false,
  verifiedQuestionSnapshot?: readonly ApplicationReviewQuestion[],
  strictStoredAttachments = false,
  verifiedResumeBytes?: Buffer,
): Promise<SubmissionPacket> {
  const stored = row.spec as StoredSpec;
  const contact = (stored._contact ?? {}) as Record<string, unknown>;
  const [userRow, appRow, profileRow, referralSourceEvidence] = await Promise.all([
    db.select().from(users).where(eq(users.id, row.user_id)).limit(1),
    // Tolerant read, see lib/applicationFacts.ts.
    selectApplicationProfileRow(row.user_id),
    db.select().from(profiles).where(eq(profiles.user_id, row.user_id)).limit(1),
    referralSourceEvidenceForRow(row),
  ]);
  const app = appRow ? decryptRow(appRow) : {};
  const parsed = (profileRow[0]?.parsed_json ?? {}) as Record<string, unknown>;
  const review = readApplicationReview(stored);
  if (!review) throw new Error('We could not find this application');
  const managedFormSnapshot = readManagedFormSnapshot(review);
  /* NO REBUILD HERE, DELIBERATELY, and this is the second design it has had.
     It first rebuilt the resume in memory at this line. That could never run: every send path
     passes a packet-audit gate that loads resume_object_key and refuses before buildPacket is
     called. Worse, it would have been wrong if it had run. renderResumePdf is not byte-deterministic
     (pdfkit stamps CreationDate; two renders of one spec differ in sha256 at identical length), and
     three records bind the exact bytes: the generation binding, packet_audit.bindings.pdf.sha256,
     and the acknowledgement. An in-memory rebuild here would have the audit verifying one document
     and the employer receiving another.
     The rebuild now happens once, before the gate, in restoreExpiredPacketResume, which writes the
     file and re-issues all three records against it. By the time buildPacket runs the file exists,
     so a throw here means the file went missing AFTER the audit passed, which is a real anomaly and
     should stop the run rather than be papered over with unaudited bytes. */
  const storedResumeBlobUrl = controlledTest
    ? null
    : await storedGeneratedResumeBlobUrl({
      userId: row.user_id,
      generatedResumeId: row.id,
      objectKey: row.resume_object_key,
    });
  const resume = await resumeBytesForPacket(row.resume_object_key, controlledTest, {
    verifiedBytes: verifiedResumeBytes,
    initialObjectUrl: objectStorageUsesRailway() ? undefined : storedResumeBlobUrl ?? undefined,
    resolveObjectUrl: resolveBlobUrl,
    fetchObject: (url) => fetch(url),
  });
  /* THE ATTACHED TRANSCRIPT, LOADED HERE AND NOT ALLOWED TO THROW.
   *
   * The cover letter below throws when its object cannot be resolved or fetched, and exactly one of
   * this function's nine callers catches it. That is a known, named hazard for the letter; for this
   * file it would be a live one on the ordinary path. `DELETE /documents/:id` deletes the blob and
   * tombstones the row, and it deliberately does not rewrite the spec of every application that
   * already carried the file - a sent application still has to be able to say what went out with it.
   * So a student who tidies her library leaves live pointers at a file that is gone, and a throw
   * here would turn that into an aborted prepare, or a failed send, on applications that are
   * otherwise complete.
   *
   * The failure is carried on the packet instead, where packetForTranscriptCapability turns it into
   * one fixed sentence and the run logs the detail. Silence is the one thing not on offer: an
   * application that says it carries a transcript and does not is the failure this whole path exists
   * to prevent.
   *
   * ABOVE THE COVER LETTER, and that position is load-bearing rather than incidental.
   * submissionRunner.test.ts fences off everything from the letter's own declaration to the end of
   * this function and asserts that no controlled-fixture decision appears inside it, so that a
   * choice made for the resume can never reach the letter's resolution. The transcript genuinely
   * needs that flag - a controlled run must not go to blob storage for any file it carries - so it
   * is resolved above the fence rather than inside it.
   */
  let transcript: Buffer | undefined;
  let transcriptUnavailableReason: string | undefined;
  const transcriptKey = transcriptObjectKeyToAttach(stored);
  if (transcriptKey) {
    try {
      transcript = await documentBytesForPacket(row.user_id, transcriptKey, controlledTest);
    } catch (error) {
      transcriptUnavailableReason = error instanceof Error ? error.message : String(error);
    }
  }
  let coverLetter: Buffer | undefined;
  const coverLetterKey = coverLetterObjectKeyToAttach(stored);
  if (coverLetterKey) {
    const coverLetterUrl = await resolveBlobUrl(coverLetterKey);
    if (!coverLetterUrl && strictStoredAttachments) throw new PacketDocumentExpiredError('cover_letter');
    coverLetter = coverLetterUrl
      ? await fetchStoredCoverLetter(coverLetterUrl)
      /* Same recovery, same frozen inputs, and it matters more here than it looks: the letter's own
         degrade path sends the application WITHOUT the attachment, so before this an expired letter
         quietly cost the applicant the one document she wrote by hand. */
      : await rerenderStoredCoverLetter(row, stored);
  }
  const fullName = String(contact.full_name ?? parsed.full_name ?? '').trim();
  const accountEmail = String(userRow[0]?.email ?? '').trim();
  /* THE ADDRESS THE EMPLOYER WILL BE ASKED TO WRITE TO.
   *
   * This line used to take the minted alias first and fall through to the contact and account
   * addresses only if there was no alias, which put a generated alias on a real employer's form on
   * the strength of an environment variable being set. On 2026-08-08 apply.trylitos.com had no MX
   * record, so that address could not receive
   * mail: every confirmation and every recruiter reply bounced, and the applicant was unreachable
   * on an application she cannot send twice.
   *
   * resolveFrozenApplicantEmail keeps the address written into this packet fixed. It refuses a
   * pinned alias that is no longer receivable instead of silently typing a different address into
   * the employer form than the one printed in the PDF. */
  const applicantEmail = await resolveFrozenApplicantEmail({
    userId: row.user_id,
    applicationId: row.id,
    spec: stored,
    accountEmail,
  });
  const email = applicantEmail.address.trim();
  if (!fullName || !email) throw new Error('Full name and email are required before submission');
  const roleTitle = (row.job_context as { role?: unknown } | null)?.role;
  const base = (profileRow[0]?.base_resume_json && typeof profileRow[0].base_resume_json === 'object'
    ? profileRow[0].base_resume_json
    : {}) as Record<string, unknown>;
  const academicStr = (key: string): string | undefined => {
    const parsedValue = parsed[key];
    if (typeof parsedValue === 'string' && parsedValue.trim()) return parsedValue.trim();
    const baseValue = base[key];
    return typeof baseValue === 'string' && baseValue.trim() ? baseValue.trim() : undefined;
  };
  const academicNum = (key: string): number | undefined => {
    const parsedValue = parsed[key];
    if (typeof parsedValue === 'number' && parsedValue > 0) return parsedValue;
    const baseValue = base[key];
    return typeof baseValue === 'number' && baseValue > 0 ? baseValue : undefined;
  };
  const academicBoolean = (key: string): boolean | undefined => {
    const parsedValue = parsed[key];
    if (typeof parsedValue === 'boolean') return parsedValue;
    const baseValue = base[key];
    return typeof baseValue === 'boolean' ? baseValue : undefined;
  };
  const graduationDate = academicStr('grad_date');
  const graduationYear = academicNum('grad_year');
  const graduationParts = submissionGraduationDateParts(graduationDate, graduationYear);
  const degree = academicStr('degree');
  const appStr = (key: string): string | undefined => (typeof app[key] === 'string' && (app[key] as string).trim()
    ? (app[key] as string).trim()
    : undefined);
  const rawApplicationProfile = await loadApplicationProfileLike(row.user_id);
  const referralSourceDefault = referralSourceForApplication(
    typeof app.referral_source_default === 'string' ? app.referral_source_default : undefined,
    referralSourceEvidence,
  );
  const applicationProfile: ApplicationProfileLike = {
    ...rawApplicationProfile,
    referral_source_default: referralSourceDefault,
    referral_source_evidence: referralSourceEvidence,
  };
  const context = (row.job_context && typeof row.job_context === 'object' ? row.job_context : {}) as Record<string, unknown>;
  const roleLocations = Array.isArray(context.locations)
    ? context.locations.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    : undefined;
  /* THE SAME RESOLUTION CONTEXT THE DISCOVERY PASS USES, and it was not before.
   *
   * There are two places a stored question's answer is resolved: discoverAndResolveQuestions, which
   * passes applicationContextForQuestionResolution(row, review), and this one, which passed a bare
   * review.jd_text. Any resolver that reads the posting's structured locations could therefore
   * answer in one and refuse in the other, on the same question, in the same run.
   *
   * Measured on Anduril b64168b8: with the location gate fixed, "Are you willing to work in-person
   * for 12 weeks during the internship?" resolves to Yes from the frozen job locations under the
   * discovery context and stayed blank here, so the packet the fill run was built from still
   * carried no answer for it. */
  const refreshedQuestions = verifiedQuestionSnapshot
    ? [...verifiedQuestionSnapshot]
    : resolvePacketAuditQuestionFixpoint(
      review,
      applicationProfile,
      applicationContextForQuestionResolution(row, review),
      postingCountryFromJobContext(row.job_context),
      postingCountryCodeFromJobContext(row.job_context),
      new Date(),
    );
  const snapshotExperience = (value: unknown): NonNullable<SubmissionPacket['applicantSnapshot']>['profile']['experience'] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const entry = item as Record<string, unknown>;
      const string = (...keys: string[]): string | undefined => {
        for (const key of keys) {
          const candidate = entry[key];
          if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
        }
        return undefined;
      };
      const company = string('company', 'org');
      const title = string('title', 'role');
      if (!company || !title) return [];
      return [{
        company,
        title,
        start: string('start', 'start_date', 'startDate', 'from') ?? '',
        end: string('end', 'end_date', 'endDate', 'to') ?? '',
        description: string('description', 'summary') ?? '',
      }];
    });
  };
  const stringList = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
  const snapshotProjects = (value: unknown): Array<{ name: string; description: string }> | undefined => {
    if (!Array.isArray(value)) return undefined;
    const projects = value.flatMap((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const project = item as Record<string, unknown>;
      const name = typeof project.name === 'string' ? project.name.trim() : '';
      const description = typeof project.description === 'string' ? project.description.trim() : '';
      return name ? [{ name, description }] : [];
    });
    return projects.length ? projects : undefined;
  };
  const applicantSnapshot: NonNullable<SubmissionPacket['applicantSnapshot']> = {
    profile: {
      full_name: fullName,
      email,
      experience: snapshotExperience(Array.isArray(parsed.experience) ? parsed.experience : base.experience),
      skills: stringList(profileRow[0]?.skills ?? parsed.skills ?? base.skills),
      ...(snapshotProjects(parsed.projects ?? base.projects) ? { projects: snapshotProjects(parsed.projects ?? base.projects) } : {}),
      school: academicStr('school') ?? '',
      ...(degree ? { degree } : {}),
      ...(graduationDate ? { grad_date: graduationDate } : {}),
      grad_year: graduationYear ?? (Number.parseInt(graduationParts.year ?? '', 10) || 0),
      ...(academicBoolean('currently_enrolled') !== undefined
        ? { currently_enrolled: academicBoolean('currently_enrolled') }
        : {}),
      ...(stringList(parsed.coursework ?? base.coursework).length
        ? { coursework: stringList(parsed.coursework ?? base.coursework) }
        : {}),
      ...(stringList(parsed.target_roles ?? base.target_roles).length
        ? { target_roles: stringList(parsed.target_roles ?? base.target_roles) }
        : {}),
      ...(typeof (parsed.voice_pref ?? base.voice_pref) === 'string'
        ? { voice_pref: String(parsed.voice_pref ?? base.voice_pref).trim() }
        : {}),
    },
    application_profile: applicationProfile,
  };
  return {
    fullName,
    email,
    phone: typeof app.phone === 'string' ? app.phone : undefined,
    city: typeof app.address_city === 'string' ? app.address_city : undefined,
    country: typeof app.address_country === 'string' ? app.address_country : undefined,
    linkedinUrl: typeof app.linkedin_url === 'string' ? app.linkedin_url : undefined,
    githubUrl: typeof app.github_url === 'string' ? app.github_url : undefined,
    portfolioUrl: typeof app.portfolio_url === 'string' ? app.portfolio_url : undefined,
    school: academicStr('school'),
    degree,
    graduationDate,
    graduationMonth: graduationParts.month,
    graduationYear: graduationParts.year,
    gpa: appStr('gpa') ?? academicStr('gpa'),
    major: appStr('major') ?? majorFromAcademicProfile(academicStr('major'), degree),
    currentlyEnrolled: academicBoolean('currently_enrolled'),
    referralSourceDefault,
    referralSourceEvidence,
    ...(managedFormSnapshot
      ? {
        fieldOptions: managedFormSnapshot.field_options,
        failedFields: managedFormSnapshot.failed_fields,
      }
      : {}),
    roleLocation: typeof context.location === 'string' ? context.location : undefined,
    roleLocations,
    roleCountry: postingCountryFromJobContext(row.job_context),
    roleCountryCode: postingCountryCodeFromJobContext(row.job_context),
    applicationProfile,
    applicantSnapshot,
    // The one proper noun the consent grammar may account for. Teamtailor's platform-default
    // consent sentence embeds the tenant's name, and the fill-time licence re-derivation in
    // managedConsentTickPlan can only place it when the packet says who the employer is.
    ...(jobContextCompany(row) ? { employerName: jobContextCompany(row) } : {}),
    jdText: review.jd_text,
    resume,
    resumeName: resumeFileNameForRole(fullName, roleTitle),
    coverLetter,
    coverLetterName: coverLetter
      ? coverLetterFileNameForRole(fullName, roleTitle)
      : undefined,
    transcript,
    // The conditional name is what makes an application with no transcript a no-op rather than a
    // half-populated packet: uploadFirst and managedUpload both return before doing anything unless
    // the file and the name are both set, so the two must go missing together.
    transcriptName: transcript ? transcriptFileNameForRole(fullName, roleTitle) : undefined,
    transcriptUnavailableReason,
    eeoPrefs: sanitizeEeoPrefs(app.eeo_prefs),
    // Metadata, not a fill field: `email` above is what gets typed. Carried on the packet so the
    // prepare paths can write which address was used, and why, onto the review state.
    applicantEmail,
    mostRecentRole: readMostRecentRole(parsed),
    questions: submissionPacketQuestions(refreshedQuestions),
  };
}

// The first entry of the parsed resume's experience list, for portals that ask for work history as
// structured fields (Paylocity). First, not "latest by date": resumes are written most-recent-first
// and the parser preserves that order, whereas the date strings are free text ("Jun 2025 - Present",
// "Summer 2024") and cannot be reliably compared. Trusting the resume's own ordering is both simpler
// and closer to what the student actually wrote.
export function readMostRecentRole(parsed: Record<string, unknown>): SubmissionPacket['mostRecentRole'] {
  const experience = parsed.experience;
  if (!Array.isArray(experience) || experience.length === 0) return undefined;
  // The `as` cast below is only safe behind this guard: `experience` is whatever the resume parser
  // wrote into parsed_json, so entry[0] can be null, a string, or an array. It used to throw a
  // TypeError on `entry.company` for a null entry - and because buildPacket runs on EVERY prepare
  // and submit, one malformed parsed profile would have failed Greenhouse/Lever/Ashby runs that
  // previously succeeded. A portal-specific nicety must never break the portals that came before it.
  const raw = experience[0];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = raw as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);
  const company = str(entry.company) ?? str(entry.org);
  const title = str(entry.title);
  // Both are required by every portal that asks for work history at all, so a partial entry is
  // worse than none: it produces a row the student must notice and finish rather than one she can
  // simply confirm.
  if (!company || !title) return undefined;
  return { company, title, summary: str(entry.description), startDate: str(entry.start), endDate: str(entry.end) };
}

function omitCoverLetter(packet: SubmissionPacket): SubmissionPacket {
  return { ...packet, coverLetter: undefined, coverLetterName: undefined };
}

/* The transcript's twin, and it clears the reason as well as the file.
 *
 * Both fields go, because both of them are read downstream and they disagree in different ways: the
 * bytes decide whether an upload action is spent, and the reason decides whether the applicant is
 * told something went wrong. On a form with nowhere to put a transcript there is nothing to spend
 * and nothing to report, so a packet that has been stripped must not still be carrying either. */
function omitTranscript(packet: SubmissionPacket): SubmissionPacket {
  return {
    ...packet,
    transcript: undefined,
    transcriptName: undefined,
    transcriptUnavailableReason: undefined,
  };
}

function normalizedFilledFields(fields: readonly string[] | undefined): Set<string> {
  return new Set((fields ?? []).map((field) => field.toLowerCase().replace(/[^a-z0-9]/g, '')));
}

/* WHAT THE FILLED FIELDS PROVE, AND THE ONE THING THEY CANNOT.
 *
 * `fields` is a list of labels the run pushed after each control accepted what it was given. Every
 * check below is therefore an absence check, and absence was the only failure this function knew how
 * to describe. A resume that was uploaded correctly and then REPLACED by a later document leaves
 * 'resume' in that list, because it really was recorded, at the moment it was true. The run then
 * reports both documents attached and an application goes out with a transcript in the resume's slot
 * and no resume at all, which is the worst outcome this file exists to prevent and the one it could
 * not see.
 *
 * So the evidence argument. It carries the managed runner's read-back of the resume's own control,
 * taken after the last upload that could have taken it, and managedResumeUploadDisplacement turns it
 * into a named answer. The direct Playwright path has no such read and needs none: it holds the live
 * page, claims each control by DOM node as it fills it, and refuses the second upload outright
 * rather than replacing the first. Two paths, two mechanisms, one thing that must never happen.
 *
 * Optional so that the callers with no evidence to offer keep working unchanged; every one of them
 * is a path where displacement is structurally impossible or already reported. */
function filledFieldBlockers(
  fields: readonly string[] | undefined,
  packet: SubmissionPacket,
  evidence?: ReadonlyArray<{ label?: string; selector?: string; value: string | null }>,
): string[] {
  const normalized = normalizedFilledFields(fields);
  const has = (needle: string) => [...normalized].some((field) => field.includes(needle));
  const issues: string[] = [];
  if (!has('email')) issues.push('The filled form did not record an email field.');
  if (!has('resume')) issues.push('The filled form did not record a resume upload.');
  const displacedBy = managedResumeUploadDisplacement(evidence, packet);
  if (displacedBy) {
    issues.push(
      `The form's resume control is holding your ${displacedBy === 'transcript' ? 'transcript' : 'cover letter'} `
      + 'instead of your resume, so this application would be sent without a resume. Nothing has been '
      + 'sent. Please attach the documents yourself on the employer\'s form.',
    );
  }
  if (!has('name') && !(has('first') && has('last'))) {
    issues.push('The filled form did not record the applicant name fields.');
  }
  if (packet.coverLetter && !has('cover')) {
    issues.push('The filled form did not record the cover letter attachment.');
  }
  /* THE ONLY SIGNAL THERE IS THAT THE TRANSCRIPT SELECTOR MATCHED NOTHING, and it is worth being
   * exact about how much it proves.
   *
   * Both upload paths fail quietly by design. uploadFirst steps over a selector that resolves to a
   * non-file element with a bare `continue` and swallows a failed setInputFiles with
   * `catch { continue; }`; the managed runner reports a non-matching optional selector into
   * `skipped` rather than `filledFields`. So a transcript that never reached the form leaves no
   * error anywhere, and this sentence is what turns that into something she is told about.
   *
   * WHAT IT DOES NOT PROVE: that the employer's own uploader registered the file. A control can
   * accept setInputFiles while the page's JavaScript never notices, and nothing on either path can
   * see that. This says the run did not record the attachment; it does not say the attachment
   * arrived, and it must not be read or described as if it did. */
  if (packet.transcript && !has('transcript')) {
    issues.push('The filled form did not record the transcript attachment.');
  }
  return issues;
}

function previewContentBlockers(text: string | undefined): string[] {
  const normalized = (text ?? '').toLowerCase();
  if (!normalized.trim()) return ['The filled form preview did not include readable page text.'];
  if (
    /sorry,?\s+but\s+we\s+can(?:not|'t)\s+find\s+that\s+page/.test(normalized)
    || /\b(?:404|page not found|not found|access denied)\b/.test(normalized)
    || /\b(?:sign in|log in|login required)\b/.test(normalized)
  ) {
    return ['The filled form preview looks like an error, login, or missing page instead of a completed application form.'];
  }
  return [];
}

function compactEvidenceText(value: string | undefined): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function gpaEvidenceValues(value: string | undefined): string[] {
  const match = value?.match(/\b([0-4](?:\.\d+)?)\b/);
  if (!match) return [];
  const numeric = Number(match[1]);
  if (!Number.isFinite(numeric)) return [];
  return [numeric.toFixed(1).replace(/\.0$/, '.0')];
}

function selectEvidenceValues(answer: string | undefined): string[] {
  const trimmed = answer?.trim();
  if (!trimmed) return [];
  const values = [trimmed];
  const lower = trimmed.toLowerCase();
  if (lower === 'yes') values.push('Yes');
  if (lower === 'no') values.push('No');
  if (/^company website$/i.test(trimmed)) values.push('Other', 'Company Website', 'Company website');
  if (/\bbachelor/.test(lower)) values.push('Bachelors');
  if (/\bmaster/.test(lower)) values.push('Masters');
  values.push(...gpaEvidenceValues(trimmed));
  return [...new Set(values)];
}

function academicEvidenceValuesForLabel(label: string, packet: SubmissionPacket): string[] {
  const normalizedLabel = normalizeReviewQuestionLabel(label).toLowerCase();
  const values: string[] = [];
  if (/\bgraduation\s+month\b/.test(normalizedLabel)) values.push(...selectEvidenceValues(packet.graduationMonth));
  if (/\bgraduation\s+year\b|\byear\s+of\s+graduation\b|\bexpected\s+graduation\s+year\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.graduationYear));
  }
  if (/\bgraduation\s+date\b|\bexpected\s+graduation\b|\bexpect\s+to\s+graduate\b|\bgraduate\s+or\s+complete\s+your\s+program\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.graduationDate));
    values.push(...selectEvidenceValues(packet.graduationYear));
  }
  if (/\bgpa\b|\boverall\s+gpa\b|\bgrade\s+point\b/.test(normalizedLabel)) values.push(...selectEvidenceValues(packet.gpa));
  if (/\bdiscipline\b|\bfield\s+of\s+study\b|\bmajor\b|\bcourse\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.major));
    if (/computer science/i.test(packet.degree ?? '')) values.push('Computer Science');
  }
  if (/\bschool\b|\buniversity\b|\bcollege\b|\binstitution\b/.test(normalizedLabel)
    && !/\bhigh\s+school\b/.test(normalizedLabel)
    && !/\bgraduat/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.school));
    if (/university of southern california/i.test(packet.school ?? '')) values.push('University of Southern California');
  }
  if (/\bdegree\b|\beducation\s+level\b|\blevel\s+of\s+education\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.degree));
  }
  if (/\bhow\s+did\s+you\s+hear\b|\bhear\s+about\b|\breferral\s+source\b|\bsource\b/.test(normalizedLabel)) {
    values.push(...selectEvidenceValues(packet.referralSourceDefault));
  }
  if (/\b(?:candidate|applicant)\s+privacy\s+(?:policy|notice)\b|\bnotice\s+at\s+collection\b|\bprocess\s+your\s+personal\s+data\b|\bprocessing\s+of\s+personal\s+data\b/.test(normalizedLabel)) {
    values.push('Yes', 'I agree', 'Acknowledge/Confirm', 'Yes, I consent');
  }
  return [...new Set(values)];
}

function expectedGreenhouseRequiredValues(label: string, packet: SubmissionPacket): string[] {
  const normalizedLabel = normalizeReviewQuestionLabel(label);
  const values: string[] = [];
  values.push(...academicEvidenceValuesForLabel(label, packet));
  for (const question of packet.questions) {
    const normalizedQuestion = normalizeReviewQuestionLabel(question.question);
    if (!normalizedQuestion) continue;
    if (!normalizedQuestion.includes(normalizedLabel) && !normalizedLabel.includes(normalizedQuestion.slice(0, 80))) continue;
    values.push(...selectEvidenceValues(question.answer));
  }
  return [...new Set(values)];
}

function resultEvidenceMatchesRequiredLabel(
  label: string,
  result: { text?: string; filledFields?: string[] },
  packet: SubmissionPacket,
): boolean {
  const labelKey = compactEvidenceText(label).slice(0, 80);
  if (!labelKey) return false;
  const text = compactEvidenceText(result.text);
  if (!text.includes(labelKey)) return false;
  return expectedGreenhouseRequiredValues(label, packet).some((value) => {
    const valueKey = compactEvidenceText(value);
    return valueKey.length > 0 && text.includes(`${labelKey}${valueKey}`);
  });
}

export function reconcileManagedProviderBlockers(
  portal: SupportedPortal,
  blockers: readonly string[],
  result: { text?: string; filledFields?: string[] },
  packet: SubmissionPacket,
): string[] {
  if (portal !== 'greenhouse') return [...blockers];
  return blockers.filter((blocker) => {
    const match = blocker.match(/^"(.+)" is required and is still empty$/);
    if (!match) return true;
    return !resultEvidenceMatchesRequiredLabel(match[1]!, result, packet);
  });
}

/**
 * The one sentence for a run that has no evidence it ever reached the application form.
 *
 * It claims only what zero evidence supports: not that the form was absent, but that Litos cannot
 * confirm reaching it. That distinction is the point. Saying "the form did not record your email"
 * asserts a form was filled, and the five owner packets of 2026-08-06 that said exactly that had
 * preview screenshots of a job description page - Jump Trading's was a branded careers page whose
 * only application control is an "Apply" button, with no form on it anywhere.
 */
export const FORM_NOT_REACHED_REASON =
  'Litos could not confirm it reached this company\u2019s application form. Nothing was filled in and nothing has been sent. Open it when you have a minute and finish it off.';

/* THE POSTING THE EMPLOYER TOOK DOWN, recognised by the page's own words. Measured on the live
 * moburst.teamtailor.com PR Account Coordinator posting, 2026-08-20: behind the cookie dialog the
 * page says "This position is no longer active - Either the position was filled, or the ad has
 * expired", there is no form anywhere, and the not-reached sentence told the applicant to "open
 * it when you have a minute and finish it off" - homework on a job that no longer exists. The
 * vocabulary is each board's own closed-posting sentence, matched only on the no-evidence path,
 * so a live form whose job description happens to contain similar words can never trip it. */
const POSTING_CLOSED_RE = /this (?:position|posting|job(?: posting)?|role) is no longer (?:active|open|available|accepting applications)|no longer accepting applications|position was filled, or the ad has expired|this job is not available anymore|job (?:has been|was) (?:filled|closed)/i;

/* The boards' own closed BANNERS, word for word, safe to read even on a page the reached
 * heuristic believes in. Measured on the live Redwood Materials board, 2026-08-21: greenhouse
 * answers a closed token with the full job LIST plus the banner "The job you are looking for is
 * no longer open." - a page busy enough that the reached heuristic can believe it, so the
 * not-reached-only check above never ran and the run reported three missing-field blockers about
 * a form that does not exist. A banner this specific appears in no job description, so it is
 * checked before the evidence question rather than behind it. */
const POSTING_CLOSED_BANNER_RE = /the job you are looking for is no longer open|position was filled, or the ad has expired/i;

export function postingClosedReason(text: string | undefined): string | null {
  const match = POSTING_CLOSED_RE.exec(text ?? '');
  if (match) {
    return 'The employer has taken this posting down: the page says "' + match[0].trim() + '". '
      + 'There is no application form any more, nothing was filled in and nothing was sent. '
      + 'There is nothing left to do on this one.';
  }
  /* THE APPLY PAGE THAT 404s. Measured on the same moburst posting one URL over: the posting page
   * says "no longer active", but the runner lands on /applications/new, which teamtailor renders
   * as "The page you were looking for doesn't exist - You may have mistyped the address or the
   * page may have moved" behind the cookie dialog. That is not proof the JOB is gone, so the
   * sentence claims less: the application page is, and looking at the posting is the next step. */
  const vanished = /the page you (?:are|were) looking for (?:doesn(?:'|\u2019)t|does not) exist|you may have mistyped the address or the page may have moved/i.exec(text ?? '');
  if (vanished) {
    return 'The employer\u2019s application page no longer exists: it says "' + vanished[0].trim() + '". '
      + 'The posting has most likely closed or moved, so nothing was filled in and nothing was '
      + 'sent. Check the posting itself if you want to be sure.';
  }
  return null;
}

/**
 * Whether the run has POSITIVE evidence it was looking at the application form.
 *
 * Positive evidence only. The absence of a filled field is not evidence of anything on its own,
 * which is precisely how "filled nothing" got reported as "the filled form is missing an email":
 * the old code read an empty filled_fields list and described the form it assumed was there.
 *
 * Each signal below is something that cannot be produced by a page with no form on it:
 *  - a recorded filled field means a control was located and typed into;
 *  - a provider blocker naming a specific control as required-and-still-empty means the provider
 *    found that control (this is what makes the Nuro run of 2026-08-06 genuinely "form reached,
 *    fields empty" while the Jump Trading run beside it was not);
 *  - a discovered question means the discover pass enumerated real inputs;
 *  - a non-null extract of something on the FORM means the probed element existed;
 *  - the applicant's own email appearing in the page text means it was typed there, whatever the
 *    provider did or did not report back.
 *
 * CAPTCHA EVIDENCE IS SUBTRACTED FIRST, and this is the part that has to stay. Every managed fill
 * run appends the challenge reads to its extract list, and one of them is a reCAPTCHA anchor iframe
 * whose selector deliberately does not exclude the badge, because the badge's own anchor is the
 * only thing that identifies an invisible-only page. That anchor exists on a large share of
 * employer pages, application form or not - the Akuna Greenhouse page carries one over a page this
 * runner never filled a field on. Counting it as reach turned "we cannot confirm we reached your
 * application form" into the three-sentence description of a form that was never opened, on every
 * reCAPTCHA-bearing page, which is precisely the sentence the not-reached reason exists to delete.
 *
 * A challenge widget is evidence that a page loaded. It is not evidence of an application form.
 */
export function applicationFormWasReached(input: {
  filledFields?: readonly string[];
  providerBlockers?: readonly string[];
  discoveredQuestionCount?: number;
  extracted?: ReadonlyArray<{ label?: string; selector?: string; value: string | null }>;
  text?: string;
  email?: string;
}): boolean {
  if ((input.filledFields?.length ?? 0) > 0) return true;
  if ((input.providerBlockers ?? []).some((blocker) => REQUIRED_AND_EMPTY_BLOCKER.test(blocker))) return true;
  if ((input.discoveredQuestionCount ?? 0) > 0) return true;
  const formExtracts = (input.extracted ?? []).filter((item) => !isManagedCaptchaEvidenceExtract(item));
  if (formExtracts.some((item) => item.value?.trim())) return true;
  const email = compactEvidenceText(input.email);
  return email.length > 0 && compactEvidenceText(input.text).includes(email);
}

export function questionMetadataMeasurementIsComplete(input: {
  discoveryFailed: boolean;
  filledFields?: readonly string[];
  providerBlockers?: readonly string[];
  discoveredQuestionCount?: number;
  extracted?: ReadonlyArray<{ label?: string; selector?: string; value: string | null }>;
  text?: string;
  email?: string;
}): boolean {
  if (input.discoveryFailed) return false;
  return applicationFormWasReached(input);
}

export function preparationEvidenceBlockers(
  result: {
    text?: string;
    filledFields?: string[];
    blockers?: readonly string[];
    discovered?: ReadonlyArray<unknown>;
    extracted?: ReadonlyArray<{ label?: string; selector?: string; value: string | null }>;
  },
  packet: SubmissionPacket,
): string[] {
  const previewBlockers = previewContentBlockers(result.text);
  if (previewBlockers.length > 0) return previewBlockers;
  const bannerClosed = POSTING_CLOSED_BANNER_RE.exec(result.text ?? '');
  if (bannerClosed) {
    return ['The employer has taken this posting down: the page says "' + bannerClosed[0].trim() + '". '
      + 'There is no application form any more, nothing was filled in and nothing was sent. '
      + 'There is nothing left to do on this one.'];
  }
  // The abort case gets ONE honest sentence and no fabricated field list. Returning the per-field
  // blockers here is what made those runs unreadable, and inventing a blocker list to fill the
  // space would repeat the same lie in different words.
  if (!applicationFormWasReached({
    filledFields: result.filledFields,
    providerBlockers: result.blockers,
    discoveredQuestionCount: result.discovered?.length ?? 0,
    extracted: result.extracted,
    text: result.text,
    email: packet.email,
  })) {
    const closed = postingClosedReason(result.text);
    if (closed) return [closed];
    return [FORM_NOT_REACHED_REASON];
  }
  return filledFieldBlockers(result.filledFields, packet, result.extracted);
}

// Classification now lives in lib/submissionTerminalCause so that applyReviewPatch, which is in
// lib/ and cannot import a route module, enforces the terminal-cause invariant with the SAME
// classifier the runner uses. Re-exported here because that is where every existing caller and
// test reaches for it.
export { attentionCategoriesForReasons };

export function attentionBlockersForManagedResult(
  portal: SupportedPortal,
  blockers: readonly string[],
  result: {
    title?: string;
    text?: string;
    filledFields?: string[];
    discovered?: unknown[];
  },
  packet: SubmissionPacket,
): string[] {
  const accessRestriction = managedNetworkAccessRestrictionReason(portal, result.text, result.title, result);
  if (accessRestriction) {
    return [
      ...blockers.filter((blocker) => blocker !== CAPTCHA_BLOCKER),
      accessRestriction,
    ];
  }
  if (!blockersIncludeCaptcha(blockers)) return [...blockers];
  return reconcileManagedProviderBlockers(portal, blockers, result, packet);
}

export function managedExtensionHandoffUrl(
  portal: SupportedPortal,
  observedUrl: string | undefined,
  networkAccessRestriction: string | null,
  captchaAttention: boolean,
): string | undefined {
  if (portal === 'smartrecruiters') {
    return networkAccessRestriction || captchaAttention
      ? canonicalSmartRecruitersOneClickUrl(observedUrl)
      : undefined;
  }
  return networkAccessRestriction ? canonicalSupportedPortalUrl(observedUrl, portal) : undefined;
}

/**
 * Build the packet, writing a cover letter first when the portal has somewhere to put one.
 *
 * A cover letter problem MUST NOT kill the run. This used to throw straight out of the middle of a
 * prepare, which took the whole submission down: the dashboard was still showing "Litos is typing
 * in your saved answers" while the run behind it was already dead, and the applicant had no error,
 * no retry and no way to tell. Reproduced in prod on a Greenhouse posting on 2026-08-04, where a
 * cover letter that had merely failed to PARSE aborted a submission that was otherwise fine.
 *
 * Degrading beats aborting: losing a whole filled application to protect one attachment is the
 * worse trade, and the applicant can still write or retry a letter from her dashboard.
 *
 * WHAT THIS PARAGRAPH USED TO SAY, and why it is worth keeping the correction visible: "the
 * generated letter is written unapproved (approved=false), and buildPacket only ATTACHES a cover
 * letter once approved_at is set. So a failure at this step costs the applicant nothing they were
 * about to send." Both sentences were true and the conclusion was wrong. It cost her the send
 * itself: on a form with a cover-letter control, /submission/approve refuses with 422 whenever the
 * portal supports a letter and the packet has none recorded, so a degrade here produced a packet
 * that read `ready_for_final_approval` and could never be sent. That is why `coverLetterIssue` now
 * gates `safe` at both call sites rather than only being displayed. See coverLetterObjectKeyToAttach
 * for the approved_at term itself, which is gone.
 *
 * The reason is returned rather than swallowed so the caller can put it in front of the applicant
 * as an attention reason. A silent degrade would be its own version of this bug.
 *
 * That reason is a FIXED sentence, and the thrown message is logged instead of interpolated. The
 * two failures this generator actually throws are "Cover letter truncated at max_tokens (1203
 * chars) - raise the cap" and "Claude returned an invalid cover letter: {"body":"I'm writing to
 * apply for the Software Eng..." - one an instruction to an operator, the other 200 characters of
 * raw model output with a vendor name in front of it. Both were reaching a student's screen. They
 * also describe one situation from the applicant's side, with one recovery, so there is nothing a
 * second variant of the sentence could usefully say. Whoever has to fix the generator reads logs.
 */
async function packetForCoverLetterCapability(
  row: ResumeRow,
  supported: boolean,
  fastify: FastifyInstance,
  controlledTest: boolean,
): Promise<{ packet: SubmissionPacket; row: ResumeRow; coverLetterIssue?: string }> {
  if (!supported) {
    const strippedRow = { ...row, spec: strippedCoverLetterSpec(row.spec) } as ResumeRow;
    return { packet: omitCoverLetter(await buildPacket(strippedRow, controlledTest)), row: strippedRow };
  }
  /* Always enter the generator gate, including when a letter is already stored. That function now
     revalidates historical artifacts against every current grounding rule and returns immediately
     for a still-valid letter. Skipping it on `storedCoverLetter(row)` is how pre-rule artifacts
     reached live employer controls indefinitely. */
  try {
    await generateStoredCoverLetter(row, false, true);
  } catch (error) {
    // Raw message to the log, fixed sentence to the applicant. See the note above the function.
    fastify.log.warn({ error, applicationId: row.id }, 'Cover letter generation or revalidation failed, continuing without it');
    const strippedRow = { ...row, spec: strippedCoverLetterSpec(row.spec) } as ResumeRow;
    return {
      packet: omitCoverLetter(await buildPacket(strippedRow, controlledTest)),
      row: strippedRow,
      coverLetterIssue: 'We could not safely prepare your cover letter for this one, so it is not attached. Everything else is filled in, and you can write or retry a cover letter from your dashboard.',
    };
  }
  const rows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, row.id)).limit(1);
  if (!rows[0]) throw new Error('This application went missing while we wrote the cover letter');
  /* The SECOND way this step can fail, and it only became reachable when the approved_at term came
     out of coverLetterObjectKeyToAttach. buildPacket now goes to blob storage for the letter on
     every supported form, and it throws when the object key resolves to nothing or the fetch is not
     ok. Before, that block was entered on approximately no run, so the throw was theoretical; now it
     sits on the hot path of every Greenhouse prepare, and an unhandled throw here would abort a
     filled application over a missing attachment - the exact failure the paragraph above this
     function exists to prevent, reintroduced one line lower down. Same degrade, same shape, its own
     sentence, because "we could not write it" and "we wrote it and could not attach it" are
     different facts and the second one is ours to fix rather than hers to retry. */
  try {
    return { packet: await buildPacket(rows[0], controlledTest), row: rows[0] };
  } catch (error) {
    /* THE RESUME IS NOT THE COVER LETTER'S PROBLEM TO DEGRADE.
       buildPacket loads both documents, so an expired RESUME lands in this catch too. Degrading it
       here was wrong twice over: it logged a resume failure under 'Cover letter file could not be
       attached', and the rebuild below re-enters buildPacket, which throws on the same missing
       resume a second time. The rethrow costs nothing that was ever recoverable - a packet with no
       resume has nothing to send either way - and it keeps the typed error intact for fail(), which
       is the whole point of typing it. */
    if (error instanceof PacketDocumentExpiredError && error.document === 'resume') throw error;
    fastify.log.warn({ error, applicationId: row.id }, 'Cover letter file could not be attached, continuing without it');
    const strippedRow = { ...rows[0], spec: strippedCoverLetterSpec(rows[0].spec) } as ResumeRow;
    return {
      packet: omitCoverLetter(await buildPacket(strippedRow, controlledTest)),
      row: strippedRow,
      coverLetterIssue: 'Your cover letter is written but we could not attach the file to this form. Everything else is filled in. Open the application and send it again, and if it keeps happening the cover letter is the part to retry.',
    };
  }
}

/** The same spec with the cover letter artifact removed, so a rebuild cannot re-enter the fetch. */
function strippedCoverLetterSpec(spec: unknown): Record<string, unknown> {
  const stored = { ...((spec && typeof spec === 'object' ? spec : {}) as Record<string, unknown>) };
  delete stored._cover_letter;
  return stored;
}

/* The largest transcript that can be carried on every path, which is the same number the upload
 * route already refuses above and for the same reason.
 *
 * The managed sandbox transports an upload as base64 and rejects any file over 6,000,000 characters
 * before a browser opens, which is about 4.29 MiB decoded, per file, with no aggregate cap and no
 * request-body limit in front of it - so a larger body is either a 400 with an INVALID_UPLOAD code
 * or an opaque platform rejection with no run record at all, indistinguishable from an outage.
 *
 * The bytes it counts are packet.transcript, which is PLAINTEXT: documentBytesForPacket unseals
 * before the packet carries anything, so the sealed object in Blob and its 28-byte envelope are
 * invisible to every runner. At this cap that is 5,333,336 characters, comfortably under the
 * ceiling. This paragraph used to do the sum on the sealed bytes and land on 5,333,372, which is
 * near enough to pass a glance and wrong enough to mislead anyone deriving a different cap from it.
 *
 * Defence in depth rather than the enforcement point: putUserDocument refuses a larger file at the
 * door, so this is unreachable through the shipped upload path. It is here because the packet is
 * built from stored state that a future path could write by some other route, and because the check
 * costs one comparison against the alternative of finding out from a runner error.
 *
 * Applied on every path and not only the managed one, deliberately. The ceiling belongs to the
 * sandbox, but the packet does not know which runner will carry it: a prepare on direct Playwright
 * can be sent through the ATS API channel, and the same bytes then travel a route the measurement
 * was never taken on. One cap, applied where the file is decided rather than where it is delivered.
 */
export const MANAGED_TRANSCRIPT_MAX_BYTES = MAX_USER_DOCUMENT_BYTES;

const TRANSCRIPT_UNAVAILABLE_ISSUE =
  'You attached a transcript to this application and we could not load the file, so it is not on the form. Everything else is filled in. Attach it again from your dashboard, and nothing has been sent in the meantime.';
const TRANSCRIPT_TOO_LARGE_ISSUE =
  'Your transcript is larger than the 4 MB Litos can put on an application, so it is not attached. Everything else is filled in. Upload a smaller PDF and try again.';

/**
 * The transcript half of the capability decision, applied to a packet that has already been built.
 *
 * IT DOES NOT REBUILD, and that is the one place it departs from packetForCoverLetterCapability's
 * shape. That function rebuilds because it WRITES: it generates a letter and then has to re-read the
 * row to see it. Nothing here writes anything - the file either exists on the spec or it does not -
 * so a rebuild would buy nothing and cost a second full packet, four queries and a resume fetch, on
 * every prepare. It would also be wrong rather than merely expensive at the managed prepare, where
 * the packet it would be handed came from a row this function never saw.
 *
 * IT CANNOT THROW, and neither can the load it reports on: see buildPacket. That is what stands in
 * for the try/catch the cover letter needs, and it covers all nine of buildPacket's callers rather
 * than the two that catch.
 *
 * WHAT IT DECIDES, in order:
 *   - the form has nowhere to put a transcript: strip it, say nothing. There is no failure here, and
 *     a sentence about a document the employer never asked for is noise on every packet that has one
 *     stored.
 *   - the file could not be loaded: strip it and owe her a sentence, because the application she
 *     believes carries a transcript is about to go without one.
 *   - the file is too large to carry: same, with the size named, because that one she can act on.
 *
 * Exported so the branches can be tested by calling them rather than by grepping for them. A test
 * that greps a file cannot tell a correct branch from a deleted one, which is the argument written
 * out at length above submissionFailureOutcome and it applies with more force here: three of these
 * four exits decide whether a document reaches an employer.
 */
export function packetForTranscriptCapability(
  packet: SubmissionPacket,
  supported: boolean,
): { packet: SubmissionPacket; transcriptIssue?: string } {
  if (!supported) return { packet: omitTranscript(packet) };
  if (packet.transcriptUnavailableReason) {
    return { packet: omitTranscript(packet), transcriptIssue: TRANSCRIPT_UNAVAILABLE_ISSUE };
  }
  if (!packet.transcript) return { packet: omitTranscript(packet) };
  if (packet.transcript.length > MANAGED_TRANSCRIPT_MAX_BYTES) {
    return { packet: omitTranscript(packet), transcriptIssue: TRANSCRIPT_TOO_LARGE_ISSUE };
  }
  return { packet };
}

/** The employer this packet is for, from job_context. Empty when the packet has no company on it. */
export function jobContextCompany(row: ResumeRow): string {
  const context = (row.job_context && typeof row.job_context === 'object' ? row.job_context : {}) as Record<string, unknown>;
  const company = context.company;
  return typeof company === 'string' ? company.trim() : '';
}

/* MOVED TO lib/questionDiscovery.ts on 2026-08-20, re-exported here for every existing import of
 * this name (this file's own three call sites below, and submissionRunner.test.ts).
 *
 * It moved because it needed to stop being an export ONLY this file's two "canonical" resolution
 * call sites (discoverAndResolveQuestions, buildPacket) used. Six other call sites across
 * routes/applications.ts, routes/resume.ts and lib/submittedAnswers.ts were independently
 * recomputing "the packet's current questions" against review.jd_text bare, which is a materially
 * POORER context than this function's output - it carries no job_context.company, no job_context
 * location, and none of the frozen-marker lines several resolveKnownAnswer branches key off. Two
 * different literal inputs for what was meant to be one packet identity produced two different
 * literal answers for the same stored question, hashed into two different packet_version values,
 * and no re-audit could ever converge because the audit side kept recomputing on the poorer
 * context. See the function's own comment in lib/questionDiscovery.ts for the mechanism and the
 * production measurement. A lib module is where every one of those callers can reach it without a
 * route file importing another route file. */
export { applicationContextForQuestionResolution } from '../lib/questionDiscovery';

// R-055 fix: the dashboard flow used to send only whatever `review.questions` the client already
// supplied (empty on a fresh dashboard-only run), so a real posting's custom questions - GPA,
// sponsorship, GitHub, essays - were never attempted. This resolves a raw discovered-question list
// (however the caller obtained it) against the stored profile, drafts the genuinely open-ended
// ones through the SAME essay endpoint the extension calls, and otherwise leaves a question alone
// rather than guess.
//
// Provider-agnostic on purpose: the direct-Playwright path gets `discovered` from its own live
// Page (discoverPageQuestions), and the managed-Stratus path gets it from the 'discover' action's
// result (buildManagedDiscoveryActions / stratus-browser-cloud PR #7) - this function has no
// browser dependency of its own, so both callers share one resolution path and can never drift on
// what counts as an answerable question.
export function discoveredControlInputType(field: Pick<DiscoveredQuestion, 'inputType' | 'role' | 'options'>): string {
  return discoveredQuestionControlType(field);
}

/**
 * The open prose controls worth including in the compact packet call.
 *
 * Resolution remains authoritative. This is only a conservative preselection made before that
 * loop, and an answer is used later only if the normal resolver reaches its essay branch and the
 * normal deterministic validator accepts it.
 */
export function compactMaterialQuestions(
  discovered: readonly DiscoveredQuestion[],
  current: ApplicationReviewState,
  portal: SupportedPortal,
  declaredSkills: readonly string[],
): CompactMaterialQuestion[] {
  const existing = new Map(
    current.questions.map((question) => [normalizeReviewQuestionLabel(question.question).toLowerCase(), question]),
  );
  const selected = new Map<string, CompactMaterialQuestion>();
  for (const field of discovered) {
    const label = normalizeDiscoveredLabel(field.label);
    const reviewLabel = normalizeReviewQuestionLabel(field.label);
    if (!label || !reviewLabel) continue;
    if (normalizeStoredPortalQuestions([{ question: label, answer: '' }], portal).length === 0) continue;
    if (discoveredFieldIsFixedPortalProfileControl(portal, field)) continue;
    if (discoveredFieldIsNotAQuestion({ label: field.label, options: field.options })
      || discoveredFieldIsNotAQuestion({ label: reviewLabel, options: field.options })) continue;
    const controlType = discoveredControlInputType(field);
    const compactClosedControl = /^(?:select|radio|checkbox|combobox)$/i.test(controlType)
      || usableOptions(field.options).length > 0;
    if (compactClosedControl || !isOpenEndedQuestion(label) || isRefusedQuestion(label) || isSelfDeclarationQuestion(label)) continue;
    const id = reviewLabel.toLowerCase();
    if (existing.get(id)?.answer.trim()) continue;
    const ranking = rankingGroundingFor(label, [...declaredSkills]);
    selected.set(id, {
      id,
      question: label,
      ...(ranking ? { ranking_rule: rankingRuleText(ranking) } : {}),
    });
  }
  return [...selected.values()];
}

function applicantChoseStoredAnswerInRound(
  question: { answer: string; answer_source?: string; answer_reviewed_at?: string },
  questionsReviewedAt: string | undefined,
): boolean {
  const answerReviewedAt = question.answer_reviewed_at?.trim();
  const reviewRound = questionsReviewedAt?.trim();
  return applicantChoseStoredAnswer(question)
    && Boolean(answerReviewedAt)
    && Boolean(reviewRound)
    && answerReviewedAt === reviewRound;
}

export async function discoverAndResolveQuestions(
  discovered: DiscoveredQuestion[],
  row: ResumeRow,
  current: ApplicationReviewState,
  ap: ApplicationProfileLike,
  automaticSubmissionEnabled: boolean,
  portal: SupportedPortal,
  /* The answers she gave once on an earlier posting, keyed by lib/answerReuse.savedAnswerKey.
   *
   * Optional and defaulted, so every existing caller and test keeps working with no store at all.
   * A remembered answer is consulted only where Litos has nothing of its own, and answerReuse
   * re-checks the reuse scope against THIS posting's employer before handing one over - see
   * savedAnswerFor for why the read side has to check again rather than trust the write side. */
  savedAnswers: ReadonlyMap<string, string> = new Map(),
  compactAnswers: ReadonlyMap<string, string> = new Map(),
): Promise<{
  questions: ApplicationReviewQuestion[];
  attentionReasons: string[];
  optionalAttentionReasons: string[];
  invalidatedQuestionKeys: string[];
  questionMetadataBlockers: QuestionMetadataBlocker[];
}> {
  const existingByLabel = new Map(
    current.questions.map((q) => [normalizeReviewQuestionLabel(q.question).toLowerCase(), q] as const),
  );
  const existingBySelector = new Map<string, ApplicationReviewQuestion[]>();
  for (const question of current.questions) {
    const selector = durablePortalSelector(question.portal_selector);
    if (!selector) continue;
    existingBySelector.set(selector, [
      ...(existingBySelector.get(selector) ?? []),
      question,
    ]);
  }
  const questions: ApplicationReviewQuestion[] = [];
  const attentionReasons: string[] = [];
  /* Attention about a control the employer left OPTIONAL. Shown to her exactly like the rest,
     but it does not gate `safe`: a left-for-you skip or an option mismatch on an optional field
     was parking complete applications (measured on Easy Dynamics' optional pronouns, 2026-08-20,
     and on Transparent Hiring's optional start date before it) over answers the employer does
     not demand. A REQUIRED field's attention still parks, exactly as before. */
  const optionalAttentionReasons: string[] = [];
  const invalidatedQuestionKeys = new Set<string>();
  const questionMetadataBlockers: QuestionMetadataBlocker[] = [];

  let bank: Awaited<ReturnType<typeof readExperienceBank>> | null = null;
  let declaredSkills: string[] = [];
  let groundingFacts: ApplicantGroundingFacts = {};
  let company = 'this company';
  try {
    company = new URL(current.portal_url!).hostname.replace(/^www\./, '').split('.')[0];
  } catch {
    // keep the fallback
  }
  const questionContext = applicationContextForQuestionResolution(row, current);
  /* WHERE THE POSTING IS, for the one rule that is allowed to ask.
   *
   * Read off `job_context` - the structured location the portal published, copied onto the packet
   * when it was created - and NOT off `questionContext`, which is role + jd_text + locations glued
   * into one blob for the drafting-shaped rules. A country read out of prose is the inference
   * be1bccf removed; this is the field the employer filled in to say where the job is. */
  const postingCountry = postingCountryFromJobContext(row.job_context);
  const postingCountryCode = postingCountryCodeFromJobContext(row.job_context);
  const reuseContext: AnswerReuseContext = { company: jobContextCompany(row) };
  // Tested against the RAW label on purpose: normalizeDiscoveredLabel now strips the `--0`
  // section handle, because leaving it in the stored question text is what made every
  // `label:has-text(...)` scope miss. The handle is still the honest signal for "this is an
  // education-section combobox", so read it before it is stripped rather than after.
  const managedGreenhouseEducationCombobox = (field: DiscoveredQuestion): boolean =>
    portal === 'greenhouse'
    && /\b(?:school|degree|discipline)--\d+\b/i.test(field.label);
  const portalSelectorForField = (field: DiscoveredQuestion): string | undefined => {
    if (managedGreenhouseEducationCombobox(field)) return undefined;
    /* A DURABLE SELECTOR BEATS THE MARKER, on every control shape.
     *
     * Everything below hands back `field.selector`, which is the `[data-litos-discovered-N]` marker
     * stamped on the element by the DISCOVERY page load. durablePortalSelector refuses that marker at
     * fill time - rightly, because the fill run is a separate stateless call against a page where the
     * attribute does not exist - so every one of these questions is really filled by matching the
     * employer's label text, and whether that lands is decided by a hand-maintained regex.
     * profileFieldResolution.ts has argued for reporting a real selector instead since it was
     * written; this is that. An id, a name, or an ATS field handle survives the reload.
     *
     * Returned for CHOICE shapes too, unlike the marker. A durable selector on a radio, checkbox or
     * select is not a promise that a text fill will work on it - portal_input_type travels beside it
     * and buildManagedPortalActions dispatches on that. The marker was withheld from those shapes
     * because it resolved to nothing useful, not because a real selector would be wrong.
     */
    const durable = field.durableSelector?.trim();
    if (durable) return durable;
    const controlType = discoveredControlInputType(field);
    if (portal === 'greenhouse' && controlType === 'combobox') return field.selector;
    return /^(?:text|email|tel|url|number|date|textarea)?$/i.test(controlType)
      ? field.selector
      : undefined;
  };

  const genericStoredQuestionsBySelector = new Map<string, ApplicationReviewQuestion[]>();
  for (const question of current.questions) {
    if (!questionLabelIsGenericAnswerControl(question.question)) continue;
    const selector = durablePortalSelector(question.portal_selector);
    if (!selector) continue;
    genericStoredQuestionsBySelector.set(selector, [
      ...(genericStoredQuestionsBySelector.get(selector) ?? []),
      question,
    ]);
  }

  /* R-096. A required field the applicant is the only one who can answer.
   *
   * This loop used to record a question ONLY when Litos had produced an answer for it, and drop the
   * field otherwise - by `continue` on a refusal, on a skip, and, at the end, on anything that was
   * neither a known field nor an essay. The fill pass then met the same control, found it required
   * and empty, and wrote '"Discipline" is required and is still empty' into attention_reason. So the
   * dashboard named a field it had no input for, and the applicant could not answer it inside the
   * product no matter which button she pressed. 126 of 242 blocker sentences across the owner's 83
   * packets named a field with no question record at all.
   *
   * The record carries NO answer, and that is the point. Discovery reaches here precisely when
   * profile resolution, the refusals, and the drafter have all declined, and the refusals are load
   * bearing: legal attestations, export controls, and every self-declaration must stay unanswered
   * until the applicant answers them herself. Surfacing the field is what makes that refusal
   * actionable instead of terminal. */
  const unansweredRequiredQuestion = (
    field: DiscoveredQuestion,
    reviewLabel: string,
    existing: ApplicationReviewQuestion | undefined,
    preserveExistingAnswer = false,
    /* False when the employer left the control optional. The record is still minted on the
       left-for-you branches - a question Litos refuses to answer must reach her as something she
       CAN answer inside the product (R-096), whether or not the employer demands it - but an
       optional blank must never enter blankRequiredQuestionLabels, or the send gate would hold a
       complete application over a field the employer does not require. */
    required = true,
    answerState: ApplicationReviewQuestion['answer_state'] = required ? undefined : 'unanswered',
  ): ApplicationReviewQuestion => ({
    id: existing?.id ?? randomUUID(),
    question: reviewLabel,
    // Ordinary unresolved fields preserve an applicant answer. Refusal branches pass false because
    // an old value may have been created by a superseded unsafe resolver and must be re-confirmed.
    answer: preserveExistingAnswer ? (existing?.answer ?? '') : '',
    kind: 'required',
    required,
    portal_selector: portalSelectorForField(field),
    portal_input_type: discoveredControlInputType(field),
    /* THE MENU, CARRIED TO HER. This is the branch that says "you answer this", so it is exactly the
       branch that must not hand her a blank box: discovery already read the control's options and
       nothing kept them, so a required question arrived with no hint of what it accepts. Display
       only - see the field's comment in applicationReview.ts for why it is not packet identity. */
    ...(field.options?.length ? { options: [...field.options] } : {}),
    ...(answerState ? { answer_state: answerState } : {}),
  });

  const surfaceUnansweredQuestion = (
    field: DiscoveredQuestion,
    reviewLabel: string,
    existing: ApplicationReviewQuestion | undefined,
    preserveExistingAnswer = false,
    required = true,
    answerState: ApplicationReviewQuestion['answer_state'] = required ? undefined : 'unanswered',
  ): void => {
    const metadataBlocker = questionMetadataBlockerForDiscovered(field, {
      closedControlRequiresOptions: true,
    });
    if (metadataBlocker) {
      const measured = { ...metadataBlocker, required };
      questionMetadataBlockers.push(measured);
      (required ? attentionReasons : optionalAttentionReasons).push(
        questionMetadataBlockerReason(measured),
      );
      invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      return;
    }
    questions.push(unansweredRequiredQuestion(
      field,
      reviewLabel,
      existing,
      preserveExistingAnswer,
      required,
      answerState,
    ));
  };

  const paylocityPortal = portal === 'paylocity' || portal === 'controlled_paylocity';
  for (const rawField of discovered) {
    const field = paylocityPortal ? normalizePaylocityDiscoveredField(rawField) : rawField;
    const label = normalizeDiscoveredLabel(field.label);
    const reviewLabel = normalizeReviewQuestionLabel(field.label);
    if (paylocityPortal && paylocityFieldIsFilledFromProfile(field, ap)) {
      if (reviewLabel) invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      const selector = durablePortalSelector(portalSelectorForField(field));
      for (const stored of selector ? existingBySelector.get(selector) ?? [] : []) {
        invalidatedQuestionKeys.add(normalizeReviewQuestionLabel(stored.question).toLowerCase());
      }
      continue;
    }
    if (discoveredFieldIsFixedPortalProfileControl(portal, field)) continue;
    if (!label || !reviewLabel) {
      const metadataBlocker = questionMetadataBlockerForDiscovered(field);
      if (metadataBlocker) {
        questionMetadataBlockers.push(metadataBlocker);
        (metadataBlocker.required ? attentionReasons : optionalAttentionReasons).push(
          questionMetadataBlockerReason(metadataBlocker),
        );
      }
      continue;
    }
    if (normalizeStoredPortalQuestions([{ question: label, answer: '' }], portal).length === 0) continue;
    /* A radio's own option, or a composite widget's whole rendered subtree, is not a question, and
     * recording one manufactures work the applicant cannot do: the Apply screen shows her "Yes" and
     * asks her to answer it. The same test runs on the pre-script's ingest, so the two surfaces
     * cannot disagree about what the form asked. Both the raw and the normalized label are tested;
     * see the note at the matching call in postingQuestionsFromDiscovered for why. */
    if (discoveredFieldIsNotAQuestion({ label: field.label, options: field.options })
      || discoveredFieldIsNotAQuestion({ label: reviewLabel, options: field.options })) continue;
    // Read from the RAW label, so it has to happen before the normalized label is used anywhere:
    // normalizeDiscoveredLabel strips the employer's `*` required marker along with the handles.
    // Name and email are excluded: the fixed-field pass has already typed them into the page, and
    // making them "required answer missing" would block every application on data Litos supplied.
    const fieldIsRequired = discoveredFieldIsRequired(field) && !isCoreIdentityField(label);
    const reviewKey = reviewLabel.toLowerCase();
    const currentSelector = durablePortalSelector(portalSelectorForField(field));
    const relabeledGenericQuestions = (currentSelector
      ? genericStoredQuestionsBySelector.get(currentSelector) ?? []
      : []).filter((question) => normalizeReviewQuestionLabel(question.question).toLowerCase() !== reviewKey);
    for (const stale of relabeledGenericQuestions) {
      invalidatedQuestionKeys.add(normalizeReviewQuestionLabel(stale.question).toLowerCase());
    }
    // A durable selector proves which control was relabeled, but it cannot prove the applicant saw
    // the missing question text when she entered an earlier value. Retire the generic row and make
    // the newly readable question earn a fresh answer under its real label.
    const existing = existingByLabel.get(reviewKey);
    const metadataBlocker = questionMetadataBlockerForDiscovered(field, {
      closedControlRequiresOptions: discoveredQuestionNeedsExactOptionsBeforeResolution(field),
    });
    if (metadataBlocker) {
      const measured = { ...metadataBlocker, required: fieldIsRequired };
      const targetAttention = fieldIsRequired ? attentionReasons : optionalAttentionReasons;
      questionMetadataBlockers.push(measured);
      targetAttention.push(questionMetadataBlockerReason(measured));
      if (metadataBlocker.kind === 'missing_exact_options') {
        if (isRefusedQuestion(label)) {
          targetAttention.push(WORK_ELIGIBILITY_QUESTION.test(label)
            ? workEligibilitySkipReason(label)
            : `sensitive question left for you: "${label.slice(0, 60)}"`);
        } else if (isSelfDeclarationQuestion(label)) {
          targetAttention.push(selfDeclarationSkipReason(label));
        }
      }
      const currentSelector = portalSelectorForField(field);
      if (metadataBlocker.kind === 'missing_exact_options'
        && existing
        && applicantChoseStoredAnswerInRound(existing, current.questions_reviewed_at)
        && currentSelector
        && existing.portal_selector === currentSelector) {
        questions.push({
          ...existing,
          question: reviewLabel,
          required: existing.required || fieldIsRequired,
          portal_selector: currentSelector,
          portal_input_type: discoveredControlInputType(field),
        });
      } else {
        invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      }
      continue;
    }
    if (!fieldIsRequired
      && existing?.answer_state === 'skipped'
      && !existing.answer.trim()) {
      questions.push(unansweredRequiredQuestion(
        field,
        reviewLabel,
        existing,
        false,
        false,
        'skipped',
      ));
      continue;
    }
    // field.options is passed for one rule only: a declared absence of test scores is spoken in the
    // employer's own wording or not at all. See the parameter's note in lib/questionDiscovery.ts.
    const controlType = discoveredControlInputType(field);
    const profileKnown = resolveKnownAnswer(label, controlType, ap, questionContext, postingCountry, postingCountryCode, field.options ?? undefined);
    /* A REMEMBERED ANSWER, and where it sits in the order.
     *
     * It stands in only where Litos has nothing of its own. The structured profile wins over a copy
     * of something she typed on another employer's form, because the profile is the thing she keeps
     * current and the copy is a snapshot. Where the profile is silent - an export-control
     * declaration, a "rate your skill level in C++" - the remembered answer is the whole point of
     * having asked her once, and it is her own words being replayed rather than anything inferred.
     *
     * Which questions may be remembered at all is answerReuse's decision, not this loop's: nothing
     * tied to one posting ever reaches here. */
    const rememberedWithoutOptionConstraint = savedAnswerFor(label, savedAnswers, reuseContext);
    const remembered = savedAnswerFor(label, savedAnswers, reuseContext, field.options);
    const known = (profileKnown && 'value' in profileKnown)
      ? profileKnown
      : (remembered !== undefined ? ({ value: remembered } as const) : profileKnown);
    // One resolution layer for the value itself. resolveKnownAnswer still decides WHETHER the
    // question is answerable (and owns every skip and refusal); resolveProfileField decides what
    // the answer should LOOK LIKE for this particular control, snapping it onto the field's real
    // option list when discovery reported one. Without this a closed list was handed the
    // profile's own phrasing and selected nothing at all.
    //
    // Only for a PROFILE value. A remembered answer is used verbatim: she typed it against this
    // exact question once, and snapping her own words onto a neighbouring option would rewrite a
    // declaration she made.
    const resolvedField = profileKnown && 'value' in profileKnown
      ? resolveProfileField(
        { label, inputType: controlType, options: field.options },
        ap,
        questionContext,
        postingCountry,
        postingCountryCode,
      )
      : null;
    const rawKnownValue = resolvedField?.value ?? (known && 'value' in known ? known.value : '');
    /*
     * KNOWN-ANSWER TEXT MUST FIT THE CONTROL'S OWN maxLength, THE SAME PROMISE THE DRAFTED-ANSWER
     * PATH ALREADY KEEPS (fitToBudget, further down this function, for the essay-drafter path).
     *
     * Nothing guarded this before. gpaAnswer's classification/percentage branch (questionDiscovery
     * .ts) can now produce a string like "3.89/4.00 (US 4.0 scale)" - roughly six times the length
     * of the bare "3.89" this path used to type - and a text control enforcing its own maxLength
     * truncates whatever is typed into it with no signal back to Litos that anything was cut. A
     * truncated GPA record ("3.89/4.00 (US 4.0 sc") submitted with no attention flag reads as a
     * deliberate, malformed answer, which is worse than leaving the field for her.
     *
     * Falls back to the BARE stored value, never to a truncation of the long form - a chopped
     * sentence can land mid-word with no honest reading, where the plain "3.89" is both short
     * enough to fit virtually any real control and exactly true on its own terms. Scoped to a
     * 'gpa' key that did NOT already match one of the control's own options: an option chosen from
     * the control's real list (matchedOption) is that control's own text, and swapping it for a
     * value that is not one of its options would break an exact match rather than protect it.
     */
    const knownValueFitsField = field.maxLength === null || rawKnownValue.length <= field.maxLength;
    const gpaBareFallback = ap.gpa?.trim();
    const knownValue = knownValueFitsField
      ? rawKnownValue
      : (resolvedField?.key === 'gpa' && !resolvedField.matchedOption && gpaBareFallback && gpaBareFallback.length <= (field.maxLength as number))
        ? gpaBareFallback
        : rawKnownValue;
    const offeredOptions = usableOptions(field.options);
    const unreadClosedControl = questionMetadataBlockerForDiscovered(field, {
      closedControlRequiresOptions: true,
    });
    const reviewedOption = existing?.answer_source === 'applicant_review'
      ? offeredOptions.find((option) => option.trim().toLowerCase() === existing.answer.trim().toLowerCase())
      : undefined;
    const reviewedAnswerStillFits = existing !== undefined
      && applicantChoseStoredAnswerInRound(existing, current.questions_reviewed_at)
      && existing.answer.trim().length > 0
      && unreadClosedControl?.kind !== 'missing_exact_options'
      && (
        (!(known && 'value' in known) && (offeredOptions.length === 0 || reviewedOption !== undefined))
        /* HER CURRENT-ROUND CHOICE OF AN OFFERED OPTION OUTRANKS A PROFILE VALUE THE CONTROL
         * CANNOT EXPRESS. Measured on the live jobs.lever.co Mytos form, 2026-08-20 (packet
         * 16f1c744): the degree-classification select offers UK honours rows and GPA rows, she
         * reviewed and chose "GPA 3.5-3.8" - byte for byte an offered option - and the profile's
         * answer for that label is "Bachelor's Degree", which matches nothing on the list. The
         * old rule required the profile to be SILENT, so her choice was discarded on every
         * rebuild, resolveProfileField snapped onto nothing, and the run re-minted "none of the
         * options match your saved answer" about a choice she had already made: a required
         * select no save could ever answer. When the resolver itself can name an offered option
         * (matchedOption), the profile still wins, which is what keeps a review that contradicts
         * her own corrected facts from riding a stale round. */
        || (reviewedOption !== undefined && resolvedField !== null && !resolvedField.matchedOption)
      );
    if (reviewedAnswerStillFits && existing) {
      questions.push({
        ...existing,
        question: reviewLabel,
        // The menu proves the applicant's value still selects an exact employer option. It does
        // not authorize rewriting the value she reviewed to the employer's capitalization.
        answer: existing.answer,
        required: existing.required || fieldIsRequired,
        portal_selector: portalSelectorForField(field),
        portal_input_type: controlType,
        options: offeredOptions.length > 0 ? offeredOptions : null,
      });
      continue;
    }
    /* WHAT THAT SNAPPED VALUE WAS SNAPPED FROM, recorded so a later pass can tell current from stale.
     *
     * Only when resolveProfileField really picked off the control's list. matchedOption is false for
     * every free-text field and for a stored answer that matched nothing, and in both of those the
     * stored answer IS the profile value, so there is nothing to preserve and nothing to record.
     *
     * The value recorded is profileKnown.value, the profile's own answer for this label, because
     * that is precisely what refreshKnownQuestionAnswers recomputes later. Equal means the profile
     * has not moved and the snapped answer may stand; different means she has corrected something
     * and the record is stale. It is the only fact that makes that decidable: the answer alone
     * cannot say, and field options do not survive into the packet.
     *
     * A CONSENT ACCEPTANCE IS LEFT ON THIS PATH ON PURPOSE. A select-shaped consent records "Yes"
     * here beside an answer of "I agree", and the recompute that follows is exactly the behaviour a
     * REVOCABLE permission owes: once she turns the permission off, resolveKnownAnswer stops
     * answering "Yes" for that label, the profile no longer says what it said, and the tick is
     * recomputed out of any packet that has not been sent. */
    // The rule itself is optionSnapClaim, up beside the gate that reads what it writes.
    const answerOptionSource = optionSnapClaim(resolvedField, profileKnown);
    /* THE ACCEPTANCE, WRITTEN DOWN ON THE QUESTION IT WAS MADE ON.
     *
     * Litos may tick an employer's privacy statement, applicant terms or code of conduct only under
     * the standing permission the applicant granted at onboarding. The packet must therefore be able
     * to say so: without this the audit shows a required consent that is simply answered "Yes", which
     * is indistinguishable from her having ticked it herself, and that is the one reading this
     * feature must never produce.
     *
     * Keyed on the PROFILE resolution, never on a remembered answer. A remembered answer is her own
     * words replayed, and labelling it as machine acceptance would misreport the opposite way.
     *
     * The licence comes from consentAcknowledgementLicence, the SAME call that decides whether the
     * control may be accepted at all, so the trail cannot claim a grant the resolver did not use.
     * For a label naming both a privacy notice and a code of conduct it names both grants. */
    const consentLicence = profileKnown && 'value' in profileKnown
      ? consentAcknowledgementLicence(label, ap, questionContext)
      : null;
    const consentTrail = consentLicence
      ? {
        answer_source: 'consent_permission' as const,
        consent_permission_version: consentLicence.version,
        ...(consentLicence.granted_at ? { consent_permission_granted_at: consentLicence.granted_at } : {}),
      }
      : {};
    // "I had an answer and deliberately did not pick anything off this list."
    //
    // resolveProfileField reports that as matchedOption: false, and this loop used to throw the
    // flag away, so the one case where Litos KNOWS a control will be left unfilled was the one case
    // the applicant never heard about. The refusal itself is correct: snapping a stored answer onto
    // a closed list it does not actually appear in is how a wrong answer gets submitted under a
    // question with legal weight. But a select nobody chose from is a required field left empty at
    // the portal, so it is work for her, and it has to reach her as work rather than as silence.
    //
    // Only when the control really had a list. matchedOption is false for every free-text field
    // too, and those are filled with the value beside it.
    if (resolvedField && !resolvedField.matchedOption && usableOptions(field.options).length > 0) {
      (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(`none of the options match your saved answer, so this one is left for you: "${label.slice(0, 60)}"`);
    }
    if (rememberedWithoutOptionConstraint !== undefined
      && remembered === undefined
      && usableOptions(field.options).length > 0) {
      invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(`none of the options exactly match your remembered answer, so this one is left for you: "${label.slice(0, 60)}"`);
      surfaceUnansweredQuestion(field, reviewLabel, existing, false, fieldIsRequired);
      continue;
    }
    if (known && 'skipReason' in known) {
      invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(known.skipReason);
      surfaceUnansweredQuestion(field, reviewLabel, existing, false, fieldIsRequired, 'litos_refused');
      continue;
    }
    if (!known && isRefusedQuestion(label)) {
      invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(WORK_ELIGIBILITY_QUESTION.test(label)
        ? workEligibilitySkipReason(label)
        : `sensitive question left for you: "${label.slice(0, 60)}"`);
      surfaceUnansweredQuestion(field, reviewLabel, existing, false, fieldIsRequired, 'litos_refused');
      continue;
    }
    if (isSelfDeclarationQuestion(label)) {
      if (!known) {
        invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
        (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(selfDeclarationSkipReason(label));
        surfaceUnansweredQuestion(field, reviewLabel, existing, false, fieldIsRequired, 'litos_refused');
        continue;
      }
    }
    /* A STORED MACHINE VALUE CANNOT STAND IN FOR AN UNREAD EMPLOYER MENU.
     *
     * A native select can be rediscovered after an earlier run wrote a machine answer while its
     * current option inventory is absent. Replaying that stored text would turn missing metadata
     * into apparent authority to fill a closed control. Profile-backed values retain the existing
     * search-combobox path above, but anything that exists only on the old review row is quarantined
     * until the employer's exact choices are measured again. A current-round applicant answer may
     * remain visible, under the same exact-selector proof used by the placeholder-only branch, while
     * the metadata blocker still holds the send.
     *
     * This sits after the refusal and self-declaration branches on purpose. Those branches explain
     * why a question belongs to the applicant, and missing metadata must not erase that explanation.
     */
    if (unreadClosedControl?.kind === 'missing_exact_options'
      && !(profileKnown && 'value' in profileKnown)) {
      const measured = { ...unreadClosedControl, required: fieldIsRequired };
      questionMetadataBlockers.push(measured);
      (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(
        questionMetadataBlockerReason(measured),
      );
      const selector = portalSelectorForField(field);
      if (existing
        && applicantChoseStoredAnswerInRound(existing, current.questions_reviewed_at)
        && selector
        && existing.portal_selector === selector) {
        questions.push({
          ...existing,
          question: reviewLabel,
          required: existing.required || fieldIsRequired,
          portal_selector: selector,
          portal_input_type: controlType,
          options: null,
        });
      } else {
        invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      }
      continue;
    }
    /* A COVER-LETTER TEXT BOX GETS THE LETTER LITOS ALREADY WRITES.
     *
     * Measured live on Quandela (Workable, 2026-08-20): discovery stored a required "cover letter"
     * textarea as a question with an empty answer, and the run parked with '"Cover letter" is
     * required and is still empty'. But the product's own disclosed behaviour for cover-letter
     * ATTACHMENT controls is to write a letter and attach it even when the control is optional, and
     * the packet already carries that letter as a rendered PDF. Same product, same form, same
     * letter: the only difference is that this employer asked for the letter as text instead of a
     * file. So the text control gets the SAME stored body the attachment path uses, generated
     * through the same generateStoredCoverLetter gate (grounding validation included) when none is
     * stored yet. The discovered textarea is itself the proof this form takes a cover letter, which
     * is what capabilityConfirmed means to that gate. This is the shared discovery-to-review path,
     * so JazzHR and Breezy, whose cover-letter controls are also TEXT, are covered by the same
     * branch, not just Workable.
     *
     * An answer she wrote herself is never overwritten: applicant_review provenance with a
     * non-empty answer skips this branch entirely and is replayed by the existing-answer arm below,
     * exactly as the duplicate-question merge keeps her answer. A profile-known or remembered value
     * also wins, because those are her declarations. And when no letter can be produced - missing
     * jd_text, a body that fails the grounding gate, a maxLength no whole sentence fits - the field
     * falls through and parks exactly as it did before this branch existed, never crashing the run. */
    const coverLetterTextControl = isCoverLetterTextQuestion(label)
      && /^(?:text|textarea)$/i.test(controlType)
      && usableOptions(field.options).length === 0;
    const applicantWroteExisting = existing?.answer_source === 'applicant_review'
      && existing.answer.trim().length > 0;
    if (coverLetterTextControl && !(known && 'value' in known) && !applicantWroteExisting) {
      try {
        const body = storedCoverLetter(row)?.body.trim()
          || (await generateStoredCoverLetter(row, false, true)).cover_letter.body;
        const fitted = fitToBudget(body, field.maxLength ?? 100_000);
        if (fitted) {
          questions.push({
            id: existing?.id ?? randomUUID(),
            question: reviewLabel,
            answer: fitted,
            kind: 'essay',
            required: fieldIsRequired,
            portal_selector: portalSelectorForField(field),
            portal_input_type: controlType,
          });
          continue;
        }
      } catch (error) {
        // A model outage does not make a saved packet unsafe. Fall through to the ordinary
        // unanswered-question path, which blocks required fields and ignores optional ones.
      }
    }
    /* THE DRAFTER NEVER WRITES PROSE INTO A CONTROL THAT OFFERS A LIST.
     *
     * The belt to isOpenEndedQuestion's braces, and it is separate from it because it is a fact
     * about the CONTROL, which that function cannot see. A select, radio or checkbox accepts one of
     * its own options and nothing else, so a paragraph aimed at one cannot land however well it
     * reads: Virtu and Faire each came back "no option matched" with a drafted answer quoted back
     * at them. A required field the applicant can see and pick from is strictly better than a
     * wrong-shaped value nobody can use. */
    const closedControl = /^(?:select|radio|checkbox|combobox)$/i.test(controlType)
      || usableOptions(field.options).length > 0;
    const wouldNotDraftNow = !isOpenEndedQuestion(label) || closedControl;
    /* A PARAGRAPH AN EARLIER BUILD DRAFTED, on a question this build would not draft at all.
     *
     * Without this the guard above changes nothing on a packet that already carries one: the
     * `existing.answer.trim()` arm below replays a stored answer verbatim, so Virtu's 186 characters
     * of prose would be typed at the same closed control on every future run of that packet.
     *
     * Only a DRAFTED answer, and only one this build has just declined to produce.
     * `answer_source: 'applicant_review'` is her own, and she is allowed to write a sentence into a
     * field Litos would not have. */
    const staleDraftedAnswer = existing?.kind === 'essay'
      && Boolean(existing.answer.trim())
      && existing.answer_source !== 'applicant_review'
      && wouldNotDraftNow;
    if (existing) {
      if (known && 'value' in known) {
        /* The spread must not carry HER provenance onto a machine value. `existing` can be an
         * applicant_review record whose reviewed answer no longer fits (reviewedAnswerStillFits
         * above is false whenever the resolver knows a value for this label), and replacing the
         * answer while inheriting answer_source would mint a machine value that every
         * applicant-override reader, including the failed-probe exemptions, then treats as a
         * choice she made. Provenance follows the ANSWER: it survives only when the value is
         * still the one she reviewed. */
        const provenanceStillHers = applicantChoseStoredAnswerInRound(
          existing,
          current.questions_reviewed_at,
        )
          && knownValue.trim() === existing.answer.trim();
        questions.push({
          ...existing,
          ...(existing.answer_source === 'applicant_review' && !provenanceStillHers
            ? { answer_source: undefined, answer_reviewed_at: undefined }
            : {}),
          question: reviewLabel,
          answer: knownValue,
          kind: 'required',
          required: fieldIsRequired,
          portal_selector: portalSelectorForField(field),
          portal_input_type: controlType,
          answer_option_source: answerOptionSource,
          /* The answer can come from the profile while the choices come from this live employer
           * control. Preserve both. Otherwise an already-known answer keeps its text but the
           * dashboard has no option list and renders the employer's select as a text box. */
          options: usableOptions(field.options).length > 0 ? usableOptions(field.options) : null,
          // Last, so a re-run over a packet whose provenance was stripped by a review merge stamps
          // the acceptance back on rather than inheriting a blank.
          ...consentTrail,
        });
      } else if (staleDraftedAnswer) {
        invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
        surfaceUnansweredQuestion(field, reviewLabel, existing, false, fieldIsRequired);
      } else if (existing.answer.trim()) {
        const provenanceStillHers = applicantChoseStoredAnswerInRound(
          existing,
          current.questions_reviewed_at,
        );
        questions.push({
          ...existing,
          ...(closedControl && existing.answer_source === 'applicant_review' && !provenanceStillHers
            ? { answer_source: undefined, answer_reviewed_at: undefined }
            : {}),
          question: reviewLabel,
          required: existing.required || fieldIsRequired,
          portal_selector: portalSelectorForField(field),
          portal_input_type: controlType,
          /* A stored answer predates this live form read, but the employer's menu does not. Keep
           * the applicant's answer and refresh the display-only choices beside it. Without this,
           * every already-answered Greenhouse select was returned to the dashboard as a free-text
           * field even though the option probe had just read the exact allowed values. */
          options: usableOptions(field.options).length > 0 ? usableOptions(field.options) : null,
        });
      } else {
        surfaceUnansweredQuestion(field, reviewLabel, existing, true, fieldIsRequired);
      }
      continue; // already answered by the client or a prior run
    }

    if (known && 'value' in known) {
      questions.push({
        id: randomUUID(),
        question: reviewLabel,
        answer: knownValue,
        kind: 'required',
        required: fieldIsRequired,
        portal_selector: portalSelectorForField(field),
        portal_input_type: controlType,
        answer_option_source: answerOptionSource,
        /* THE MENU RIDES WITH THE RECORD, display-only, exactly as R-096 carries it for the
           unanswered mint. The option-mismatch branch above warns her an answer matched nothing
           the control offers; without the list beside it the Review answers screen hands her a
           bare box and no hint of what the employer accepts (measured on Rippling's pronouns
           list, 2026-08-20: "she/her" matched nothing and nothing showed her what would). */
        ...(usableOptions(field.options).length > 0 ? { options: usableOptions(field.options) } : {}),
        ...consentTrail,
      });
      continue;
    }
    /* THE DRAFTER MAY NOT WRITE A DECLARATION ABOUT HER. This is the last door, and it is the one
     * the 600-word essay walked through: "Have you previously applied to Akuna?" is open-ended by
     * every measure isOpenEndedQuestion applies, so it went to the model, and the model wrote a
     * confident paragraph opening "I have not applied to Akuna in the past" with nothing on file
     * that said so.
     *
     * Each specific case since has been closed where it happened, in resolveKnownAnswer, and each
     * of those fixes only covers a label somebody had already seen go wrong. This is the general
     * form: a question whose answer is a statement she makes about herself is never drafted, however
     * open-ended it reads, whether or not any rule above recognised it. She is asked instead, which
     * is what the pre-script now does before the run ever starts. */
    if (wouldNotDraftNow) {
      // The single biggest source of unanswerable blockers. "Discipline", "Graduation Month",
      // "EXPORT CONTROLS - ...": not a field Litos knows, not an essay it can draft, and until now
      // dropped without even an attention reason. Required means the employer will not accept the
      // form without it, so it is the applicant's to answer and she has to be able to see it.
      surfaceUnansweredQuestion(field, reviewLabel, existing, false, fieldIsRequired);
      continue;
    }

    // Open-ended answers remain grounded by draftApplicationAnswer. Standing consent authorizes
    // those grounded drafts to proceed; without it, the existing per-application review remains.
    try {
      if (bank === null) {
        bank = await readExperienceBank(row.user_id);
        const [profileRow] = await db.select().from(profiles).where(eq(profiles.user_id, row.user_id)).limit(1);
        groundingFacts = applicantGroundingFacts(profileRow?.parsed_json, ap);
        declaredSkills = declaredSkillsList(profileRow?.skills);
      }
      if (bank.length === 0) {
        (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(`open-ended question left for you (no experience bank on file): "${label.slice(0, 60)}"`);
        surfaceUnansweredQuestion(field, reviewLabel, existing, false, fieldIsRequired);
        continue;
      }
      const compactAnswer = compactAnswers.get(reviewLabel.toLowerCase());
      const compactValidation = compactAnswer === undefined
        ? null
        : validateDraftedApplicationAnswer(
          compactAnswer,
          label,
          current.jd_text,
          bank,
          groundingFacts,
          declaredSkills,
        );
      // A compact answer enters the form only when the normal gate accepts it. If it misses, this
      // one item falls back to the existing dedicated generator and keeps all of its feedback
      // retries. Other accepted items from the same packet are still reused.
      const { answer, warnings } = compactValidation && compactValidation.blockingIssues.length === 0
        ? compactValidation
        : await draftApplicationAnswer(
          label,
          company,
          current.role ?? 'this role',
          current.jd_text,
          bank,
          groundingFacts,
          declaredSkills,
        );
      const fitted = answer ? fitToBudget(answer, field.maxLength ?? 100_000) : null;
      if (!fitted) {
        (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(`open-ended question left for you (could not draft a confident answer): "${label.slice(0, 60)}"`);
        surfaceUnansweredQuestion(field, reviewLabel, existing, false, fieldIsRequired);
        continue;
      }
      questions.push({ id: randomUUID(), question: reviewLabel, answer: fitted, kind: 'essay', required: fieldIsRequired, portal_selector: field.selector, portal_input_type: controlType });
      if (warnings.length > 0) {
        (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(`drafted answer needs your review: ${warnings.join('; ').slice(0, 300)}`);
      }
      if (!automaticSubmissionEnabled) {
        (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(`AI-drafted answer needs your review before this goes out: "${label.slice(0, 60)}"`);
      }
    } catch (error) {
      (fieldIsRequired ? attentionReasons : optionalAttentionReasons).push(`open-ended question left for you (draft generation failed): "${label.slice(0, 60)}"`);
      surfaceUnansweredQuestion(field, reviewLabel, existing, false, fieldIsRequired);
    }
  }

  return {
    questions,
    attentionReasons,
    optionalAttentionReasons,
    invalidatedQuestionKeys: [...invalidatedQuestionKeys],
    questionMetadataBlockers: dedupeQuestionMetadataBlockers(questionMetadataBlockers),
  };
}

function applicationProfileForPacket(
  profile: ApplicationProfileLike,
  packet: SubmissionPacket,
): ApplicationProfileLike {
  return {
    ...profile,
    referral_source_default: packet.referralSourceDefault,
    referral_source_evidence: packet.referralSourceEvidence,
  };
}

const RECENT_EXPERIENCE_EMPLOYER_QUESTION =
  /\bwhere\s+did\s+you\s+complete\s+your\s+most\s+recent\b[^?]{0,80}\b(?:internship|research\s+experience)\b/i;
const REFERRAL_SOURCE_CHOICE_QUESTION =
  /\b(?:how\s+did\s+you\s+hear|how\s+did\s+you\s+find|where\s+did\s+you\s+hear|referral\s+source|source\s+of\s+(?:your\s+|the\s+)?application)\b/i;
const GENERIC_OTHER_DETAIL_QUESTION =
  /^if\s+other\b[^?]{0,80}\b(?:explain|specify|describe|provide|tell)\b/i;
const EMPLOYEE_REFERRAL_DETAIL_QUESTION =
  /^if\s+(?:you\s+(?:were|are)\s+)?referred\s+by\b[^?]{0,160}\b(?:employee|intern)\b/i;

function isTruthfulJobBoardOtherReferral(
  question: Pick<ApplicationReviewQuestion, 'question' | 'answer' | 'answer_option_source' | 'options'>,
): boolean {
  const original = question.answer_option_source?.trim();
  const other = otherReferralOption(usableOptions(question.options));
  return Boolean(
    original
    && isJobBoardReferralClaim(original)
    && REFERRAL_SOURCE_CHOICE_QUESTION.test(normalizeReviewQuestionLabel(question.question))
    && other
    && question.answer.trim().toLowerCase() === other.toLowerCase(),
  );
}

function isTruthfulRecentEmployerOther(
  question: Pick<ApplicationReviewQuestion, 'question' | 'answer' | 'answer_option_source' | 'options'>,
): boolean {
  const original = question.answer_option_source?.trim();
  const other = otherReferralOption(usableOptions(question.options));
  return Boolean(
    original
    && RECENT_EXPERIENCE_EMPLOYER_QUESTION.test(normalizeReviewQuestionLabel(question.question))
    && other
    && question.answer.trim().toLowerCase() === other.toLowerCase()
    && original.toLowerCase() !== other.toLowerCase(),
  );
}

export function filterAutomaticallyResolvedReferralAttention(
  reasons: readonly string[],
  questions: readonly ApplicationReviewQuestion[],
): string[] {
  const jobBoardOtherResolved = questions.some(isTruthfulJobBoardOtherReferral);
  const resolvedPrefixes = questions.flatMap((question) => {
    const normalized = normalizeReviewQuestionLabel(question.question);
    const automaticallyResolved = isTruthfulJobBoardOtherReferral(question)
      || isTruthfulRecentEmployerOther(question)
      || (jobBoardOtherResolved
        && EMPLOYEE_REFERRAL_DETAIL_QUESTION.test(normalized)
        && /^n\/?a$/i.test(question.answer.trim()));
    return automaticallyResolved ? [normalized.slice(0, 60).toLowerCase()] : [];
  });
  return reasons.filter((reason) => {
    const normalized = reason.toLowerCase();
    if (resolvedPrefixes.some((prefix) => prefix && normalized.includes(prefix))) return false;
    /* Discovery can emit the refusal before the corresponding optional detail row survives the
     * failed-control merge. The source row still proves the same narrow fact: Litos converted the
     * applicant's stored Job board source to the employer's Other option, so a conditional employee
     * or intern name is not applicable. Match only that exact refusal shape. A primary referral
     * question such as "Were you referred by an employee?" still remains held, and an applicant-
     * reviewed Other has no Job board provenance and never enters this branch. */
    return !(jobBoardOtherResolved
      && /how you heard about this role is yours to answer:\s*["']if\s+(?:you\s+(?:were|are)\s+)?referred\s+by\b[^"']{0,160}\b(?:employee|intern)\b/i.test(reason));
  });
}

/**
 * Closed-list reads that may safely fall back to an exact search.
 *
 * Greenhouse's fixed school taxonomy can exceed the render cap before the applicant types. That
 * does not make the stored school a guess: the fill types the full school name and clicks only an
 * exactly matching visible option. If the employer spells it differently, no option click occurs
 * and the required-field blocker still prevents send. Every custom control and every non-windowed
 * read failure remains fail-closed.
 */
export function managedSearchFillableWindowedFailureIds(
  failures: readonly { controlId: string; reason: string }[],
  school: string | undefined,
): Set<string> {
  if (!school?.trim()) return new Set();
  return new Set(failures
    .filter(({ controlId, reason }) => controlId === 'school--0'
      && reason === 'the option list was windowed at the render cap')
    .map(({ controlId }) => controlId));
}

/**
 * The literal "Other" option that truthfully carries an answer the employer omitted from a closed
 * taxonomy. This is deliberately not a general fuzzy fallback. It covers only two facts the
 * applicant already supplied:
 *
 * - a job-board referral when the source list has no generic job-board entry;
 * - the named employer of the applicant's most recent internship or research experience when that
 *   employer is absent from the employer's company list.
 *
 * In both cases selecting a neighbouring named option would change the fact, while "Other" is the
 * exact branch the control reserves for it. Every other option mismatch remains applicant work.
 */
export function truthfulOtherChoice(
  question: string,
  answer: string,
  options: readonly string[] | null | undefined,
): string | undefined {
  const offered = usableOptions(options);
  const value = answer.trim();
  if (!value || offered.length === 0) return undefined;
  if (offered.some((option) => option.trim().toLowerCase() === value.toLowerCase())) return undefined;
  const other = otherReferralOption(offered);
  if (!other) return undefined;
  if (REFERRAL_SOURCE_CHOICE_QUESTION.test(question) && isJobBoardReferralClaim(value)) return other;
  if (RECENT_EXPERIENCE_EMPLOYER_QUESTION.test(question)) return other;
  return undefined;
}

export function resolveApplicantClosedChoiceFallbacks(
  discovered: readonly DiscoveredQuestion[],
  questions: readonly ApplicationReviewQuestion[],
  currentReferralSource?: string | null,
  currentRecentEmployer?: string | null,
): ApplicationReviewQuestion[] {
  const legacyLitosDetailPresent = questions.some((question) => {
    const label = normalizeReviewQuestionLabel(question.question);
    return GENERIC_OTHER_DETAIL_QUESTION.test(label)
      && !question.answer_source
      && question.answer.trim() === REFERRAL_OTHER_DETAIL;
  });

  const resolved = questions.map((question) => {
    const normalized = normalizeReviewQuestionLabel(question.question);
    const fallback = truthfulOtherChoice(normalized, question.answer, question.options);
    if (!fallback) {
      const other = otherReferralOption(usableOptions(question.options));
      const recentEmployer = currentRecentEmployer?.trim();
      const recoverLegacyProvenance = !question.answer_source
        && !question.answer_option_source?.trim()
        && (isJobBoardReferralClaim(currentReferralSource)
          || legacyLitosDetailPresent)
        && REFERRAL_SOURCE_CHOICE_QUESTION.test(normalized)
        && Boolean(other)
        && question.answer.trim().toLowerCase() === other?.toLowerCase();
      const recoverRecentEmployerProvenance = !question.answer_option_source?.trim()
        && Boolean(recentEmployer)
        && RECENT_EXPERIENCE_EMPLOYER_QUESTION.test(normalized)
        && Boolean(other)
        && question.answer.trim().toLowerCase() === other?.toLowerCase()
        && recentEmployer?.toLowerCase() !== other?.toLowerCase()
        && !usableOptions(question.options).some((option) => option.trim().toLowerCase() === recentEmployer?.toLowerCase());
      return recoverLegacyProvenance
        ? { ...question, answer_option_source: isJobBoardReferralClaim(currentReferralSource) ? currentReferralSource?.trim() : 'Job board' }
        : recoverRecentEmployerProvenance
          ? { ...question, answer_option_source: recentEmployer }
          : question;
    }
    return {
      ...question,
      answer: fallback,
      answer_source: undefined,
      answer_reviewed_at: undefined,
      answer_option_source: question.answer.trim(),
    };
  });

  const resolvedByLabel = new Map(resolved.map((question) => [
    normalizeReviewQuestionLabel(question.question).toLowerCase(),
    question,
  ] as const));
  const referralDetailLabels = new Set<string>();
  const collectAdjacentReferralDetail = (items: readonly { label: string }[]) => {
    for (let index = 0; index < items.length - 1; index += 1) {
      const sourceLabel = normalizeReviewQuestionLabel(items[index]?.label ?? '');
      const detailLabel = normalizeReviewQuestionLabel(items[index + 1]?.label ?? '');
      const source = resolvedByLabel.get(sourceLabel.toLowerCase());
      if (!source
        || !REFERRAL_SOURCE_CHOICE_QUESTION.test(sourceLabel)
        || !GENERIC_OTHER_DETAIL_QUESTION.test(detailLabel)) continue;
      const expectedOther = truthfulOtherChoice(
        sourceLabel,
        source.answer_option_source ?? '',
        source.options,
      );
      if (expectedOther?.toLowerCase() === source.answer.trim().toLowerCase()) {
        referralDetailLabels.add(detailLabel.toLowerCase());
      }
    }
  };
  collectAdjacentReferralDetail(discovered);
  collectAdjacentReferralDetail(resolved.map((question) => ({ label: question.question })));
  const jobBoardOtherResolved = resolved.some(isTruthfulJobBoardOtherReferral);

  return resolved.map((question) => {
    const normalized = normalizeReviewQuestionLabel(question.question);
    const referralOtherDetail = referralDetailLabels.has(normalized.toLowerCase());
    const employeeDetailDoesNotApply = jobBoardOtherResolved
      && EMPLOYEE_REFERRAL_DETAIL_QUESTION.test(normalized);
    if (!referralOtherDetail && !employeeDetailDoesNotApply) return question;
    return {
      ...question,
      answer: referralOtherDetail ? REFERRAL_OTHER_DETAIL : 'N/A',
      kind: 'required',
      answer_source: undefined,
      answer_reviewed_at: undefined,
      answer_option_source: undefined,
    };
  });
}

export function mergeDiscoveredPortalQuestions(
  discovered: readonly ApplicationReviewQuestion[],
  stored: readonly ApplicationReviewQuestion[],
  invalidatedQuestionKeys: readonly string[],
  invalidatedFieldIds: ReadonlySet<string> = new Set(),
  questionsReviewedAt?: string,
): ApplicationReviewQuestion[] {
  const invalidated = new Set(invalidatedQuestionKeys);
  const kept = stored.filter((question) => {
    if (invalidated.has(normalizeReviewQuestionLabel(question.question).toLowerCase())) return false;
    const controlId = managedOptionProbeControlId({
      label: question.question,
      selector: question.portal_selector,
    });
    if (!controlId || !invalidatedFieldIds.has(controlId)) return true;
    // invalidatedFieldIds are the controls whose live option probe FAILED, meaning the list
    // could not be read this run. An answer she chose herself does not need the list read; a
    // stored machine answer does, because restoring it replays a value nobody stands behind
    // against a control nobody read. Measured on Jump Trading packet 2e593ac5, 2026-08-17 late.
    return applicantChoseStoredAnswerInRound(question, questionsReviewedAt);
  });
  /* HER ANSWER LEADS THE COLLISION, because ordering here decides who wins one.
   *
   * normalizeApplicationReviewQuestions is FIRST-WINS on the answer: for a duplicate label it keeps
   * `existing.answer` and takes the later one only when the first is empty
   * (`answer: existing.answer.trim() ? existing.answer : question.answer`), and the row it keeps is
   * `{ ...existing }`. With `...discovered` spread first, the discovered row was always `existing`,
   * so a freshly resolved answer beat an answer she had reviewed AND took its `answer_source` down
   * with it.
   *
   * Measured on DV Trading e0a0eb84, 2026-08-18, live and end to end. Saved "Other" through
   * PUT /review/answers; read it back as `Other` / `applicant_review`; ran the fill; the persisted
   * row afterwards was `answer: "Job board"` with NO answer_source, and the run reported
   * `no option matched "Job board"` against a list whose entries are LinkedIn / DV Recruitment /
   * DV Employee / DV Intern / DV Website / Student Organization / Campus Event / Word of Mouth /
   * SHRM / Other. So discovery resolves that label to "Job board" every run, and her choice was
   * being discarded every run.
   *
   * This is the principle the filter above already states in so many words - "an answer she chose
   * herself does not need the list read" - applied to the collision instead of only to which stored
   * rows survive it. Scoped exactly as that filter scopes it: `applicant_review` with a non-empty
   * answer, nothing else moves.
   *
   * The discovered row is NOT discarded. normalizeApplicationReviewQuestions merges
   * portal_selector, portal_input_type and ats_api_field from the later occurrence regardless of
   * which side won the answer, so this run's live selector still reaches the fill. Only the answer
   * and its provenance change hands. */
  return normalizeApplicationReviewQuestions([
    ...kept.filter((question) => applicantChoseStoredAnswerInRound(question, questionsReviewedAt)),
    ...discovered,
    ...kept.filter((question) => !applicantChoseStoredAnswerInRound(question, questionsReviewedAt)),
  ]);
}

/**
 * Shortest label worth comparing by prefix. Providers truncate a long blocker label, so a stored
 * question and a blocker naming the same field agree only on their opening; below this length that
 * agreement is a coincidence rather than a match.
 */
const BLOCKER_PREFIX_MATCH_MIN_LENGTH = 8;

/**
 * The required fields this run has left the applicant no way to answer.
 *
 * A blocker is Litos saying "the employer will not accept the form without this". A question record
 * is Litos giving her somewhere to put the answer. When the first exists without the second, the
 * dashboard names an obstacle and offers no control that can clear it, and the run has, until now,
 * reported no error at all - the DRW packet carried 27 of these and called itself
 * `needs_attention` with an empty `questions` array and `submission_error: null`.
 *
 * Counting them is what turns that into a sentence she can act on and an engineer can measure. It
 * says nothing about WHY the field is unanswerable: a transcript upload she has never given Litos
 * and a question the discovery pass simply never saw both land here, and both are honest to report.
 */
export function unansweredRequiredBlockerLabels(
  blockers: readonly string[],
  questions: readonly { question: string }[],
): string[] {
  const asked = questions
    .map((item) => normalizeReviewQuestionLabel(item.question).toLowerCase())
    .filter(Boolean);
  const out: string[] = [];
  for (const blocker of blockers) {
    const label = blocker.match(REQUIRED_AND_EMPTY_BLOCKER)?.[1];
    if (!label) continue;
    const needle = normalizeReviewQuestionLabel(label).toLowerCase();
    if (!needle) continue;
    const matched = asked.some((question) => {
      if (question === needle) return true;
      if (question.length < BLOCKER_PREFIX_MATCH_MIN_LENGTH || needle.length < BLOCKER_PREFIX_MATCH_MIN_LENGTH) return false;
      return question.startsWith(needle) || needle.startsWith(question);
    });
    if (matched) continue;
    out.push(label);
  }
  return [...new Set(out)];
}

/** Optional questions that still need an explicit applicant answer or skip decision. */
export { undecidedOptionalQuestionLabels };

/**
 * The documents this form asked for, off both measurements a prepare has, in one place.
 *
 * TWO SOURCES, AND ONLY ONE OF THEM CAN FIRE TODAY. Say which, because the difference decides what
 * a screen built on this may promise.
 *
 * The blocker labels are the employer's own "is required and is still empty" sentences for fields
 * no question record answers. That is the live source, on both runners, and at present it is the
 * ONLY one.
 *
 * The required-file questions are the second, and NEITHER discovery pass produces one yet. The
 * direct-Playwright walk enumerates text, email, tel, url, number, date, untyped inputs, textarea,
 * select, radio and checkbox (lib/questionDiscovery.ts:4195) and no file input; stratus's managed
 * discover scan builds its candidate list the same way. So this filter is empty on both paths as
 * the code stands, and it is written anyway because it costs nothing, it is the half that will
 * start working the day either walk is widened, and a row that appeared only after a run had
 * already failed is the behaviour that widening fixes.
 *
 * The practical consequence, which no test here can catch: a required transcript control is visible
 * to Litos only through a portal's own required-field complaint, after a run has stopped. If a
 * portal marks the field required without emitting that sentence, this measures nothing and the
 * dashboard shows nothing. That is unproven against a live form either way.
 *
 * Blockers go in first so the label that names the row is the employer's own sentence rather than
 * whatever the discovery pass reconstructed. Everything else - the transcript vocabulary, the
 * word boundaries, the dedupe, the one-row-per-kind collapse and the length clip - belongs to
 * requiredDocumentAsks and is tested there.
 */
export function measuredRequiredDocuments(
  unansweredRequired: readonly string[],
  questions: readonly { question: string; required: boolean; portal_input_type?: string }[],
): RequiredDocumentAsk[] {
  return requiredDocumentAsks([
    ...unansweredRequired,
    ...questions
      .filter((question) => question.required && question.portal_input_type === 'file')
      .map((question) => question.question),
  ]);
}

/**
 * Attach the files she has already given Litos to the application that has just asked for them.
 *
 * THIS IS THE PROMISE, NOT A CONVENIENCE. The modal's checkbox says "Reuse this for future
 * applications that ask" and its confirmation says the next employer that asks gets it
 * automatically; /privacy publishes "so a later application can use the same file without us asking
 * you for it again". Until this ran, `user_documents.reusable` was written on every upload and read
 * as a filter by nothing, so all three sentences described behaviour the build did not have.
 *
 * SERVER-SIDE, AT PREPARE TIME, AND THAT IS THE DECISION. The client alternative is one call from
 * the review screen when it notices an outstanding ask beside a matching library file, and it is
 * simpler. It is also wrong here, three times over:
 *
 *   - It only reuses when she LOOKS. `preparedReviewPatch` sends straight to 'submitting' under
 *     standing consent, so an account with automatic submission on never opens the screen that would
 *     have done the attaching, and the promise is kept for exactly the users who never rely on it.
 *   - It would run on a render, inside a component the 2.5s poll re-renders on every tick, which
 *     makes "attach if missing" a write that fires repeatedly and races its own response.
 *   - It would fight removal. "Remove this file" detaches and deletes in that order, and a screen
 *     whose rule is "no mark plus a reusable file means attach" would put the mark straight back
 *     between those two requests.
 *
 * The prepare run is where the ask is MEASURED, so it is the one moment that knows an ask exists,
 * and it happens once per run whether or not anybody is watching.
 *
 * AFTER writeReview, NOT BEFORE, and inside a catch. This is additive: the application is already
 * durably prepared by the time it runs, so a blob outage or a lost connection costs a reuse and
 * never the run. Both writes are jsonb_set on different paths of the same column, so neither can
 * clobber the other whichever lands first.
 *
 * WHAT THE APPLICANT SEES BEFORE ANYTHING IS SENT. Nothing is sent by this. The attachment lands in
 * `spec._documents`, GET /applications/:id/submission serves it as `documents`, and the review screen
 * lists it with a control that opens the modal and removes it. `automatic_submission_enabled` is a
 * separate decision she made once; attaching a file she uploaded and marked reusable to an employer
 * who asked for that exact file is the behaviour she was promised, and it is still visible and still
 * removable at the approval gate.
 */
export async function reuseStoredDocuments(
  row: ResumeRow,
  review: ApplicationReviewState,
  fastify: FastifyInstance,
): Promise<void> {
  try {
    const open = documentAsksOpenToReuse(review, storedDocuments(row));
    if (open.length === 0) return;
    for (const ask of open) {
      const document = await claimReusableDocument(row.user_id, ask.kind);
      if (!document) continue;
      const attached = await db.update(generated_resumes).set({
        /* The same merge POST /applications/:id/documents uses, and for the same measured reason:
           jsonb_set with create_missing only creates the LAST element of the path, so writing
           '{_documents,transcript}' into a spec that has never held a document is a silent no-op
           that reports one row updated. The `||` also keeps every other kind. */
        spec: sql`jsonb_set(
          coalesce(${generated_resumes.spec}, '{}'::jsonb),
          '{_documents}',
          coalesce(${generated_resumes.spec} -> '_documents', '{}'::jsonb) || ${JSON.stringify({
          [ask.kind]: {
            document_id: document.id,
            file_name: document.file_name,
            object_key: document.object_key,
            attached_at: new Date().toISOString(),
            ordered_at: null,
            employer_label: ask.label,
            official_requested: ask.official_requested,
          },
        })}::jsonb,
          true
        )`,
      }).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, row.user_id),
        /* Only into a kind that still has no record. She may have attached or ordered on another tab
           between the measurement and this write, and reuse must never overwrite her own answer. */
        sql`${generated_resumes.spec} -> '_documents' -> ${ask.kind} is null`,
      )).returning({ id: generated_resumes.id });
      if (attached.length === 0) continue;
      fastify.log.info({ applicationId: row.id, kind: ask.kind }, 'Reused a stored document for a measured ask');
    }
  } catch (error) {
    // Never fatal. The application is already prepared and she can still attach the file by hand;
    // losing the run over a reuse would be the convenience costing the thing it was decorating.
    fastify.log.error({ err: error, applicationId: row.id }, 'Could not reuse a stored document');
  }
}

/**
 * A thrown value turned into a sentence that is never empty.
 *
 * `new Error()` carries `message === ''`, and both prepare paths feed this string to
 * discoveryHonestyReasons, which tests it for truthiness. An empty message therefore renders NO
 * admission at all: the run is correctly held back from sending, and the applicant is shown a
 * packet that stops without saying why. The fallback is deliberately plain rather than a stack
 * trace, since this text is read by her, not by us; the log line carries the rest.
 */
export function describeDiscoveryFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.trim() || 'the scan failed without reporting a reason';
}

const MANAGED_DIAGNOSTIC_TAGS = new Set(['unknown', 'input', 'select', 'textarea', 'button', 'div', 'other']);
const MANAGED_DIAGNOSTIC_ROUTES = new Set([
  'unresolved',
  'native_select',
  'custom_choice',
  'bare_opener',
  'text',
  'text_then_choice',
]);
const MANAGED_DIAGNOSTIC_STATES = new Set(['not_read', 'chosen', 'empty', 'unknown', 'other']);
const MANAGED_DIAGNOSTIC_OUTCOMES = new Set([
  'started',
  'target_unresolved',
  'native_option_unmatched',
  'native_committed',
  'native_uncommitted',
  'choice_committed',
  'choice_uncommitted',
  'choice_already_answered',
  'choice_unmatched',
  'text_committed',
  'text_uncommitted',
]);

/**
 * Whitelist the managed runner diagnostic contract before it reaches production logs. The
 * provider response is an external boundary even when its TypeScript type is narrow, so unknown
 * keys and all strings except fixed enums and durable Greenhouse control ids are dropped here.
 */
export function managedActionDiagnosticsForLog(value: unknown): Array<Record<string, string | number | boolean>> {
  if (!Array.isArray(value)) return [];
  const boundedCount = (input: unknown) => Number.isInteger(input) && Number(input) >= 0
    ? Math.min(Number(input), 100)
    : 0;
  const boundedEnum = (input: unknown, allowed: ReadonlySet<string>, fallback: string) =>
    typeof input === 'string' && allowed.has(input) ? input : fallback;
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const entry = raw as Record<string, unknown>;
    const controlId = typeof entry.controlId === 'string' && /^question_\d{1,20}$/.test(entry.controlId)
      ? entry.controlId
      : null;
    if (!controlId) return [];
    return [{
      controlId,
      locatorCount: boundedCount(entry.locatorCount),
      targetResolved: entry.targetResolved === true,
      targetVisible: entry.targetVisible === true,
      targetTag: boundedEnum(entry.targetTag, MANAGED_DIAGNOSTIC_TAGS, 'unknown'),
      targetInChoiceShell: entry.targetInChoiceShell === true,
      targetPlaceholderSignal: entry.targetPlaceholderSignal === true,
      targetValuePlaceholderSignal: entry.targetValuePlaceholderSignal === true,
      targetPseudoPlaceholderSignal: entry.targetPseudoPlaceholderSignal === true,
      labelCount: boundedCount(entry.labelCount),
      labelledQuestionCount: boundedCount(entry.labelledQuestionCount),
      locatorChoicePlaceholderCount: boundedCount(entry.locatorChoicePlaceholderCount),
      labelChoicePlaceholderCount: boundedCount(entry.labelChoicePlaceholderCount),
      choicePeerCount: boundedCount(entry.choicePeerCount),
      nearbyChoiceIndicator: entry.nearbyChoiceIndicator === true,
      route: boundedEnum(entry.route, MANAGED_DIAGNOSTIC_ROUTES, 'unresolved'),
      choiceAttempted: entry.choiceAttempted === true,
      choiceFilled: entry.choiceFilled === true,
      choiceLanded: entry.choiceLanded === true,
      choiceControlOpened: entry.choiceControlOpened === true,
      choiceUnreadable: entry.choiceUnreadable === true,
      choiceRefused: entry.choiceRefused === true,
      choiceStateKind: boundedEnum(entry.choiceStateKind, MANAGED_DIAGNOSTIC_STATES, 'other'),
      outcome: boundedEnum(entry.outcome, MANAGED_DIAGNOSTIC_OUTCOMES, 'started'),
    }];
  }).slice(0, 60);
}

/**
 * ONE CONTROL LITOS COULD NOT READ, NAMED ON ITS OWN.
 *
 * THIS CHANGES WHAT THE PACKET SAYS, NOT WHAT REACHES THE FORM. Read that sentence before trusting
 * anything else here, because the first version of this comment claimed the opposite and was wrong.
 *
 * A control whose option list came back unreadable used to be pushed into `discoveryFailures`. That
 * array is the run-level honesty gate, so a single windowed control made the packet tell her "we
 * could not read the questions this form asks", about a form whose other questions had been read
 * perfectly. That sentence is the defect, and a per-control sentence is the fix.
 *
 * What it did NOT do is change any answer. `discoveryFailures` is read in exactly five places in
 * prepareManaged, all of them after `discoverAndResolveQuestions` and `mergeDiscoveredPortalQuestions`
 * have already run, and neither takes it as an argument. Resolution and the merge cannot see it.
 * Verified by running the chain at unmodified main: the merged answer is the same either way.
 *
 * Measured on IMC packet 920a6751, 2026-08-11: `question_9177934101` legitimately failed its option
 * read because its list was windowed at the render cap, and `question_9176667101` beside it read
 * fine and resolved to "January 2028 - July 2028". The applicant was told the form was unreadable.
 * She was told that about a form Litos had read. Separately, and NOT caused by this, the graduation
 * control was still sent a bucket rather than its resolved answer; see the open defect noted on the
 * test fixture for where that actually comes from.
 *
 * The honesty the old code was protecting is kept, at the scope it belongs to: the failed control is
 * still removed from `discoveredFields` before any alias resolution, still carried in
 * `packet.failedFields` so no action can target it, still never silently answered, and it still
 * holds the send. What it no longer does is speak for controls it knows nothing about.
 *
 * The label is preferred over the durable id because it is the only half of the pair she can find on
 * the page; the id is the fallback for a control discovery reported without one.
 */
/* THE FAILED READS WHOSE CONTROLS HER OWN REVIEWED ANSWER ALREADY COVERS, as one set both readers
 * share. optionProbeAttentionReasons uses it to choose the sentence ("typed exactly as you wrote
 * it" vs "left for you"), and the `safe` gate uses it to decide whether the failure is a WALL.
 * One derivation, because the day the sentence and the gate disagree about which case a control
 * is, the applicant is told her answer was typed while the send is held for a blank - or the
 * reverse, which is worse. Coverage matches the way the merge exemption matches: by the label key
 * or the probe control id of her stored record. */
export function coveredOptionProbeFailureIds(
  failures: readonly { controlId: string; reason: string }[],
  failedFields: readonly { controlId: string; label?: string }[],
  storedQuestions: readonly {
    question: string;
    answer: string;
    answer_source?: string;
    answer_reviewed_at?: string;
    portal_selector?: string;
  }[] = [],
  questionsReviewedAt?: string,
): Set<string> {
  const chosen = storedQuestions.filter((question) =>
    applicantChoseStoredAnswerInRound(question, questionsReviewedAt));
  const chosenLabels = new Set(chosen.map((question) => normalizeReviewQuestionLabel(question.question).toLowerCase()));
  /* SELECTOR-DERIVED IDS ONLY, deliberately narrower than managedOptionProbeControlId's full
   * reading. The id fallback that mines handles out of the LABEL text can cover a failure whose
   * label does not otherwise match her stored question - and the fill builder's own exemption
   * (reviewQuestionFieldTarget) derives ids from the selector alone, so that is exactly the case
   * where coverage here would excuse a wall while the fill stays suppressed. Coverage that the
   * builder cannot honour is not coverage; the label-TEXT arm below stays, because the builder's
   * label match is coarser than it, never finer. */
  const chosenControlIds = new Set(chosen
    .map((question) => managedOptionProbeControlId({ selector: question.portal_selector }))
    .filter(Boolean));
  const labelById = new Map(failedFields.map((field) => [field.controlId, field.label?.trim()]));
  return new Set(failures
    .filter(({ controlId }) => {
      const label = labelById.get(controlId);
      return chosenControlIds.has(controlId)
        || (label !== undefined && chosenLabels.has(normalizeReviewQuestionLabel(label).toLowerCase()));
    })
    .map(({ controlId }) => controlId));
}

export function uncoveredRequiredOptionProbeFailures<T extends { controlId: string }>(
  failures: readonly T[],
  requiredControlIds: ReadonlySet<string>,
  coveredControlIds: ReadonlySet<string>,
): T[] {
  return failures.filter(({ controlId }) =>
    requiredControlIds.has(controlId) && !coveredControlIds.has(controlId));
}

export function optionProbeAttentionReasons(
  failures: readonly { controlId: string; reason: string }[],
  failedFields: readonly { controlId: string; label?: string }[],
  /* The stored questions the merge will consult, so this report and the fill agree. A failed
   * control covered by an applicant-chosen answer is no longer "left for you rather than answered
   * with a guess": her reviewed answer IS typed at it, verbatim, and telling her otherwise sends
   * her to hand-answer a filled field. The sentence for that case says what really happens, and
   * still asks her to look, because the run could not read the list and cannot promise the option
   * text matched. Coverage matches the way the merge exemption matches: by the label key or the
   * probe control id of her stored record. */
  storedQuestions: readonly {
    question: string;
    answer: string;
    answer_source?: string;
    answer_reviewed_at?: string;
    portal_selector?: string;
  }[] = [],
  questionsReviewedAt?: string,
): string[] {
  const coveredIds = coveredOptionProbeFailureIds(
    failures,
    failedFields,
    storedQuestions,
    questionsReviewedAt,
  );
  const labelById = new Map(failedFields.map((field) => [field.controlId, field.label?.trim()]));
  return failures.map(({ controlId, reason }) => {
    const label = labelById.get(controlId);
    const named = label ? `"${label.slice(0, 80)}"` : `the control ${controlId.slice(0, 80)}`;
    if (coveredIds.has(controlId)) {
      return `Litos could not read the choices ${named} offers, so your reviewed answer was typed `
        + `exactly as you wrote it (${reason.slice(0, 160)}). Check it landed before sending.`;
    }
    return `Litos could not read the choices ${named} offers, so it was left for you rather than `
      + `answered with a guess (${reason.slice(0, 160)}). The other questions on this form are unaffected.`;
  });
}

/**
 * What the run owes the applicant about its own blind spots, in her words.
 *
 * Two separate admissions, and they are not the same failure. The first is "the scan did not run";
 * the second is "the scan ran and still there are required fields you cannot answer here". A run
 * can produce either, both, or neither.
 */
export function discoveryHonestyReasons(
  discoveryFailure: string | undefined,
  unansweredRequired: readonly string[],
): string[] {
  const reasons: string[] = [];
  if (discoveryFailure) {
    reasons.push(
      'we could not read the questions this form asks, so anything beyond the standard fields is not '
      + `answerable in Litos on this run (${discoveryFailure.slice(0, 200)})`,
    );
  }
  if (unansweredRequired.length > 0) {
    const named = unansweredRequired.map((label) => `"${label.slice(0, 60)}"`).join(', ');
    reasons.push(
      `${unansweredRequired.length} required ${unansweredRequired.length === 1 ? 'field has' : 'fields have'} `
      + `no question you can answer in Litos: ${named.slice(0, 400)}`,
    );
  }
  return reasons;
}

async function prepareManaged(
  row: ResumeRow,
  current: ApplicationReviewState,
  portal: SupportedPortal,
  runId: string,
  fastify: FastifyInstance,
  authorization: StandingAuthorization,
  audit: PacketAudit,
  verifiedQuestions: readonly ApplicationReviewQuestion[],
  verifiedResumeBytes: Buffer,
) {
  const priorManagedFormSnapshot = readManagedFormSnapshot(current);
  await writeReview(row, nextReview(current, {
    status: 'filling',
    submission_run_id: runId,
    submission_error: undefined,
    progress_screenshot_url: undefined,
    progress_stage: 'Opening the company form',
    progress_updated_at: new Date().toISOString(),
  }));
  // Neither document goes on the discovery pass. It runs before anything is known about the form,
  // and its whole job is to read the page; carrying a file there would spend an upload action on a
  // control this run has not yet established exists.
  let packet = packetForEmployerDelivery(
    await buildPacket(
      row,
      packetUsesControlledResumeFixture(portal),
      verifiedQuestions,
      false,
      verifiedResumeBytes,
    ),
    current,
    'browser',
  );

  // R-055 on the managed path: a cheap first call fills only the fixed fields and asks
  // stratus-browser-cloud's 'discover' action (PR #7) to scan the resulting page for custom
  // questions - the only way this path ever sees the live DOM, since /api/run is otherwise
  // stateless. Resolved through the SAME questionDiscovery.ts logic the direct-Playwright path
  // uses, so the two providers can never answer a question differently.
  const applicationUrl = portalApplicationUrl(portal, current.portal_url!);
  const prepareEnvelope = employerDeliveryEnvelope({
    channel: browserEmployerDeliveryChannel(browserDeliveryRuntimeIdentity().provider),
    destinationUrl: applicationUrl,
    portalFamily: portal,
    runtime: browserDeliveryRuntimeIdentity(),
    coverLetterSupported: current.cover_letter_supported,
    transcriptSupported: current.transcript_supported,
  });
  assertVerifiedBuiltPacket(packet, audit, verifiedQuestions, 'browser', prepareEnvelope);
  /* `.catch(() => null)` used to be the whole error handling here, and it is how a total failure of
   * the discovery pass became indistinguishable from a form that simply had no custom questions.
   *
   * Measured on DRW's Software Developer Intern packet, 2026-08-08: the action list was 145 long,
   * the runner rejects anything over 120 before opening a browser, so this call returned HTTP 400
   * and nothing at all was discovered. The run then filled the fixed fields, recorded 27 separate
   * "is required and is still empty" blockers, wrote zero question records, and reported no error.
   * The applicant was handed 27 named obstacles and no way to answer any of them.
   *
   * The budget bug is fixed in buildManagedDiscoveryActions. This is the second half: a discovery
   * pass that fails for ANY reason now says so, in the applicant's own attention list, and the run
   * cannot be called safe on the strength of a page it never read. */
  // An array rather than a nullable local so the assignment inside the catch callback is visible to
  // the code below it; TypeScript does not narrow across a closure it cannot prove ran.
  const discoveryFailures: string[] = [];
  /* scanCorrelation on every prepare-path run that touches the page, because stratus's
   * correlation-required policy classifies ANY mutation as boundary-capable, not just submits.
   * The discovery pass fills the fixed fields before it reads, so without a correlation the very
   * first provider call of a managed fill is refused with SUBMISSION_ATTEMPT_REQUIRED - measured
   * live on the first post-cutover fill, application e4b0420c (OpenAI, Ashby, 2026-09-01), where
   * this .catch swallowed the refusal as a discovery failure and the uncorrelated fill run below
   * then failed the whole packet with the same sentence. A prepare run truly cannot submit (no
   * allowSubmit, no final action, both enforced server-side), so the ephemeral scan pair is the
   * correct correlation; the DURABLE attempt stays what it means - claimSubmission's ledger row,
   * opened only when a submit-capable run is about to launch.
   *
   * This pass runs FIRST, which is why its uncorrelated form was the worst of the four: it fails
   * closed before the option-probe and fill runs are ever reached, and the .catch below files the
   * refusal as a discovery failure, so the applicant is told the form's questions could not be read
   * rather than that a correlation was missing. The widened window is for the two big runs of the
   * prepare path (this and the fill), which are the two that can legitimately reach stratus's own
   * run budget. See MANAGED_PREPARE_SCAN_OPTIONS for why it is 280s and not more. */
  const discoveryResult = await runManagedBrowserWithAccountFence(
    row.user_id,
    applicationUrl,
    managedActionsWithExactPageUrl(buildManagedDiscoveryActions(portal, packet), applicationUrl),
    MANAGED_PREPARE_SCAN_OPTIONS,
  )
    .catch((error: unknown) => {
      // Normalized rather than taken raw, because `new Error()` carries `message === ''` and an
      // empty string reaches discoveryHonestyReasons as falsy: the run would be correctly held back
      // and the applicant would be shown no reason for it.
      const message = describeDiscoveryFailure(error);
      discoveryFailures.push(message);
      fastify.log.error(
        { applicationId: row.id, portal, error: message },
        'Question discovery pass failed, so this run cannot see the questions this form asks',
      );
      return null;
    });
  if (discoveryResult) assertEmployerPageUrl(applicationUrl, discoveryResult.url);
  let progressScreenshotUrl: string | undefined;
  if (discoveryResult?.screenshot) {
    try {
      const progressPreview = await storeFilledPreviewScreenshot(
        `users/${row.user_id}/submission-runs/${runId}/progress-discovery.png`,
        Buffer.from(discoveryResult.screenshot, 'base64'),
      );
      progressScreenshotUrl = progressPreview.url;
    } catch (error) {
      fastify.log.warn(
        { applicationId: row.id, error: error instanceof Error ? error.message : String(error) },
        'Could not store the in-progress form preview',
      );
    }
  }
  await writeReview(row, nextReview(current, {
    status: 'filling',
    submission_run_id: runId,
    progress_screenshot_url: progressScreenshotUrl,
    progress_stage: 'Reading the company questions',
    progress_updated_at: new Date().toISOString(),
  }));
  /* Greenhouse publishes the exact form schema for this posting. Use it as a second read beside
   * the live DOM, never instead of the live page: a question still has to be discovered on the
   * employer form before it enters the packet. The public schema supplies the stable option list
   * for array-named multi-selects that Stratus sees as one combobox, and the stable document
   * capability that otherwise alternates when an optional file input finishes mounting late. */
  let greenhouseSchema: Awaited<ReturnType<typeof greenhousePublicApplicationSchema>> = null;
  if (portal === 'greenhouse') {
    try {
      greenhouseSchema = await greenhousePublicApplicationSchema(applicationUrl);
      if (greenhouseSchema) {
        fastify.log.info({
          applicationId: row.id,
          publicOptionFieldCount: Object.keys(greenhouseSchema.fieldOptions).length,
          coverLetterSupported: greenhouseSchema.coverLetterSupported,
          transcriptSupported: greenhouseSchema.transcriptSupported,
        }, 'Read the employer-published Greenhouse form schema');
      }
    } catch (error) {
      fastify.log.warn({
        applicationId: row.id,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'Could not read the employer-published Greenhouse form schema, keeping the live DOM read');
    }
  }
  /* THE SAME READ FOR ASHBY, and here it is the ONLY read rather than a second one.
   *
   * managedOptionProbeTargets is gated to ['greenhouse','rippling','paylocity'] and
   * pushManagedReactSelectOptionProbeActions returns early off the greenhouse family, so no pass in
   * this runner ever opens an Ashby control to see what it offers. Ashby renders its choice controls
   * with the option list absent until the menu is opened, so discovery's DOM walk reports a closed
   * control with nothing on it and questionMetadataBlockerForDiscovered files missing_exact_options.
   * The dashboard's "read the employer fields again" button re-enters THIS function, so the retry
   * reproduces the same blocker forever - a hold with no exit rather than a slow one.
   *
   * Measured on OpenAI's Software Engineer, Internal Applications - Enterprise (posting
   * db053b0e-c1a5-4b7a-bcb6-6e766629e7b1) on 2026-09-01: two required MultiValueSelect controls,
   * "Applicant Arbitration Agreement Acknowledgement" and "I hereby certify that I have not
   * knowingly withheld any information...", each offering exactly ONE accepted value, both blocked.
   *
   * THIS DOES NOT MAKE LITOS ANSWER THEM. Both labels return no consent class from
   * consentAcknowledgementClasses - arbitration is deliberately outside the privacy_and_terms and
   * conduct licence, per the CONSENT_PRIVACY_DOCUMENT_ACCEPTANCE note that it "cannot absorb
   * arbitration" - so they stay held for the applicant either way. What changes is that she is now
   * handed the employer's exact wording to accept or decline, instead of a refusal telling her Litos
   * could not read the control. A legal attestation she cannot see is not safer than one she can. */
  let ashbySchema: Awaited<ReturnType<typeof ashbyPublicApplicationSchema>> = null;
  if (portal === 'ashby' || portal === 'controlled_ashby') {
    try {
      ashbySchema = await ashbyPublicApplicationSchema(applicationUrl);
      if (ashbySchema) {
        fastify.log.info({
          applicationId: row.id,
          publicOptionLabelCount: Object.keys(ashbySchema.optionsByLabel).length,
          multiSelectLabelCount: ashbySchema.multiSelectLabels.length,
        }, 'Read the employer-published Ashby form schema');
      }
    } catch (error) {
      fastify.log.warn({
        applicationId: row.id,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      }, 'Could not read the employer-published Ashby form schema, keeping the live DOM read');
    }
  }
  // The closed lists' REAL option texts, read off the live page by the discovery pass. Without
  // these, resolveProfileField's option snapping (PR #361) is inert on this path: the managed
  // provider's discover action reports no options at all, so a control offering "Computer Science"
  // was handed the stored major, matched nothing, and came back required-and-empty.
  const discoveryFieldOptions = mergeManagedFieldOptions(
    managedResultFieldOptions(discoveryResult),
    greenhouseSchema?.fieldOptions,
  );
  const normalizedDiscoveredFields = (discoveryResult?.discovered ?? []).map((field) =>
    (portal === 'paylocity' || portal === 'controlled_paylocity')
      ? normalizePaylocityDiscoveredField(field as DiscoveredQuestion)
      : field as DiscoveredQuestion)
    .map((field) => {
      if (!greenhouseSchema) return field;
      const labelKey = greenhousePublicQuestionLabelKey(normalizeDiscoveredLabel(field.label));
      const options = labelKey ? greenhouseSchema.optionsByLabel[labelKey] : undefined;
      return options?.length ? { ...field, options } : field;
    });
  /* The Ashby join, by label, because the public form definition names its fields by UUID `path`
   * and the live DOM never carries that path - there is no control id to join on, only the wording.
   *
   * TWO THINGS THIS DOES THAT THE GREENHOUSE JOIN ABOVE DOES NOT, both required for it to work:
   *
   * 1. `optionsComplete: true`. questionMetadataBlockerForDiscovered files missing_exact_options
   *    whenever `optionsComplete === false`, REGARDLESS of whether options are present, so attaching
   *    a list without clearing the flag would leave the blocker exactly where it was. The flag is
   *    honest here: this is the employer's own published inventory for the control, which is the
   *    same claim attachManagedFieldOptions makes when a probe read one off the live page. Greenhouse
   *    is deliberately left alone - it has a live probe as its second source and does not need this.
   * 2. An ambiguity guard on the DISCOVERED side. The parser already drops a label two published
   *    fields share; this drops one that two DISCOVERED fields share, so a duplicated question on
   *    the page can never take a list that might belong to its twin. Same rule as
   *    attachManagedFieldOptions' refusal to attach one list to two controls sharing a durable id. */
  const ashbyDiscoveredLabelCounts = new Map<string, number>();
  if (ashbySchema) {
    for (const field of normalizedDiscoveredFields) {
      const labelKey = ashbyPublicQuestionLabelKey(normalizeDiscoveredLabel(field.label));
      if (labelKey) {
        ashbyDiscoveredLabelCounts.set(labelKey, (ashbyDiscoveredLabelCounts.get(labelKey) ?? 0) + 1);
      }
    }
  }
  const publicSchemaDiscoveredFields = !ashbySchema
    ? normalizedDiscoveredFields
    : normalizedDiscoveredFields.map((field) => {
      if (field.options?.length && field.optionsComplete !== false) return field;
      const labelKey = ashbyPublicQuestionLabelKey(normalizeDiscoveredLabel(field.label));
      if (!labelKey || ashbyDiscoveredLabelCounts.get(labelKey) !== 1) return field;
      const options = ashbySchema.optionsByLabel[labelKey];
      return options?.length ? { ...field, options, optionsComplete: true } : field;
    });
  const discoveredForOptionProbe = discoveredQuestionsForExactOptionProbe(
    publicSchemaDiscoveredFields,
  );
  /* THE THIRD STAGE, and the reason option snapping reaches every confirmed closed control.
   *
   * The discovery pass probes four ids compiled into this repo, because those four are Greenhouse's
   * own and are knowable before any page is read. Every other closed control on a Greenhouse form is
   * an employer-configured question whose id only the live page knows, so every one of them reached
   * resolveProfileField with `options: undefined` and was answered by a blind alias ladder. Measured
   * on the owner's run of 2026-08-08 and re-read off the live forms on 2026-08-09: nine required
   * controls across DRW, IMC, Point72, Five Rings and Virtu were sent an answer the employer does
   * not offer, including "3.89" into a control whose choices are GPA bands and "Company website"
   * into a list whose closest entry is "DRW Careers Page".
   *
   * It cannot be folded into the discovery pass. That pass already trims itself to land under the
   * runner's 120-action ceiling, and the ids this reads are its own output, so there is neither room
   * nor information until it has returned.
   *
   * Native selects are read without clicking. Custom lists are identity-checked, opened, read and
   * closed twice so an async first read can warm the second. Whole controls are batched under the
   * provider's 120-action ceiling. Any missing, windowed, conflicting or failed closed-control read
   * is removed before resolution, so a blind alias is never sent in its place. */
  const discoveryRoleCapability = managedResultSupportsDiscoveryRole(discoveryResult);
  const optionProbeBatches = buildManagedDiscoveredOptionProbeBatches(
    portal,
    discoveredForOptionProbe,
    discoveryFieldOptions,
    discoveryRoleCapability,
  );
  const optionProbeResults = [];
  const optionProbeBatchFailures: Array<{ controlIds: string[]; reason: string }> = [];
  for (const actions of optionProbeBatches) {
    const controlIds = [...new Set(actions.flatMap((action) => {
      const label = action.label ?? '';
      const id = label.startsWith('options:')
        ? label.slice('options:'.length)
        : label.match(/^closed_control:(.+)$/)?.[1];
      return id ? [id] : [];
    }))];
    const result = await runManagedBrowserWithAccountFence(
      row.user_id,
      applicationUrl,
      actions,
      // Option-probe clicks open dropdowns to read their choices: a mutation that never submits, so
      // it needs the same ephemeral scan correlation as the fill and the pre-scan, or stratus
      // correlationRequired refuses it for lacking a submissionAttempt. The standard read-scan
      // window is right for a probe batch: it is far smaller than a full fill.
      { screenshot: false, scanCorrelation: true },
    )
      .catch((error: unknown) => {
        const reason = describeDiscoveryFailure(error);
        optionProbeBatchFailures.push({ controlIds, reason });
        fastify.log.error(
          {
            applicationId: row.id,
            portal,
            error: reason,
            controls: controlIds,
          },
          'Option probe batch failed, so its closed controls are blocked from blind fallback',
        );
        return null;
      });
    optionProbeResults.push(result);
  }
  const optionProbe = managedOptionProbeAnalysis(
    portal,
    discoveredForOptionProbe,
    discoveryFieldOptions,
    [discoveryResult, ...optionProbeResults],
    optionProbeBatchFailures,
    discoveryRoleCapability,
  );
  const searchFillableWindowedIds = managedSearchFillableWindowedFailureIds(
    optionProbe.failures,
    packet.school,
  );
  const blockingOptionProbeFailures = optionProbe.failures
    .filter(({ controlId }) => !searchFillableWindowedIds.has(controlId));
  const blockingOptionProbeFailedIds = new Set(
    blockingOptionProbeFailures.map(({ controlId }) => controlId),
  );
  const requiredOptionProbeControlIds = new Set(
    discoveredForOptionProbe.flatMap((field) => {
      const controlId = managedOptionProbeControlId(field);
      return controlId && discoveredFieldIsRequired(field) ? [controlId] : [];
    }),
  );
  /* NOT pushed into discoveryFailures. That array is the WHOLE-FORM honesty gate, and a per-control
   * read failure promoted into it made Litos tell her it could not read any of this form's questions
   * when it had read all but one of them. The failure is real and stays visible, and it still holds
   * the send below; what changes is that it now speaks only for the control it happened to.
   *
   * This is a change to the packet's account of itself, not to any answer. See
   * optionProbeAttentionReasons for why resolution cannot see this array at all. */
  if (blockingOptionProbeFailures.length > 0) {
    fastify.log.error(
      { applicationId: row.id, portal, controls: blockingOptionProbeFailures },
      'Closed controls whose option list could not be read, so each one alone is left for the applicant',
    );
  }
  if (searchFillableWindowedIds.size > 0) {
    fastify.log.info(
      { applicationId: row.id, portal, controls: [...searchFillableWindowedIds] },
      'Windowed fixed school taxonomy will use exact stored-school search with required-field verification',
    );
  }
  const fieldOptions = optionProbe.options;
  const targetedControlIds = managedOptionProbeTargets(
    portal,
    discoveredForOptionProbe,
    undefined,
    discoveryRoleCapability,
  );
  /* WHAT THE PROBE ACTUALLY DID, because until now only its FAILURES were observable.
   *
   * `optionProbe.failures` is logged above and nothing logs a success, so a probe that ran and
   * produced nothing looks identical from outside to a probe that never targeted anything. Measured
   * on production 2026-08-17: 384 info logs and ZERO error logs across three Greenhouse runs, while
   * every one of them ended with `no option matched "<raw profile value>"` on degree, referral and
   * GPA. No failures, no options, and no way to tell which half was broken.
   *
   * That gap cost four separate investigations and three retracted root causes - a database column
   * that is runtime-only, a capability flag read with the wrong grep, and a cross-repo contract that
   * was fine. Every one came from inferring, because inference was all the instrumentation allowed.
   *
   * These three numbers separate the two remaining causes on the next run:
   *   targeted 0                -> the fault is in managedOptionProbeTarget's own gating
   *   targeted > 0, read 0      -> the fault is the probe's read or the merge
   *
   * Deliberately `info` and deliberately counts only. No label, no option text, no applicant answer:
   * this is a diagnostic about the RUN, and option text can carry employer-specific and demographic
   * wording that has no business in a log line. */
  fastify.log.info(
    {
      applicationId: row.id,
      portal,
      discovered: (discoveryResult?.discovered ?? []).length,
      targeted: targetedControlIds.length,
      read: Object.keys(fieldOptions).length,
      failures: blockingOptionProbeFailures.length,
      searchableWindowed: searchFillableWindowedIds.size,
      roleCapability: discoveryRoleCapability,
      /* WHICH controls, not just how many. The counts said targeted 5 of 16 discovered and read 5,
       * so the probe is healthy and the question moved to why the other eleven were never targeted -
       * the degree control among them, which the same run reports as required-and-still-empty.
       *
       * Both lists, because the useful comparison is what got in against what did not. Capped and
       * truncated: these are control HANDLES, but managedOptionProbeControlId can derive one from a
       * label, and these forms carry demographic questions whose wording does not belong in a log. */
      targetedIds: targetedControlIds.slice(0, 15).map((id) => id.slice(0, 60)),
      untargetedIds: (discoveryResult?.discovered ?? [])
        .map((field) => managedOptionProbeControlId(field))
        .filter((id): id is string => Boolean(id) && !targetedControlIds.includes(id!))
        .slice(0, 15)
        .map((id) => id.slice(0, 60)),
    },
    'Option probe outcome: how many controls were targeted and how many option lists came back',
  );
  const failedFields = normalizedDiscoveredFields.flatMap((field) => {
    const controlId = managedOptionProbeControlId(field);
    if (!controlId || !blockingOptionProbeFailedIds.has(controlId)) return [];
    return [{
      controlId,
      label: field.label,
      selector: field.selector,
      inputType: discoveredControlInputType(field),
    }];
  });
  const storedQuestions = normalizeStoredPortalQuestions(current.questions, portal);
  const optionProbeAttention = optionProbeAttentionReasons(
    blockingOptionProbeFailures,
    failedFields,
    storedQuestions,
    current.questions_reviewed_at,
  );
  /* The failed reads that are NOT excused by a reviewed answer. These are the ones that hold the
   * send; see the `safe` term below and coveredOptionProbeFailureIds for the one shared
   * derivation. */
  const uncoveredProbeFailures = (() => {
    const covered = coveredOptionProbeFailureIds(
      blockingOptionProbeFailures,
      failedFields,
      storedQuestions,
      current.questions_reviewed_at,
    );
    return uncoveredRequiredOptionProbeFailures(
      blockingOptionProbeFailures,
      requiredOptionProbeControlIds,
      covered,
    );
  })();
  const discoveredFields = attachManagedFieldOptions(publicSchemaDiscoveredFields, fieldOptions)
    .filter((field) => {
      const controlId = managedOptionProbeControlId(field);
      return !controlId || !blockingOptionProbeFailedIds.has(controlId);
    });
  const resolutionCurrent = { ...current, questions: storedQuestions };
  const applicationProfile = applicationProfileForPacket(
    await loadApplicationProfileLike(row.user_id),
    packet,
  );
  const savedAnswers = await loadSavedAnswers(row.user_id);
  const coverLetterSupported = stableManagedDocumentCapability({
    authoritative: greenhouseSchema?.coverLetterSupported,
    discovered: managedResultHasCoverLetterUpload(discoveryResult, portal),
    prior: priorManagedFormSnapshot?.cover_letter_supported,
    current: current.cover_letter_supported,
  });
  let compactAnswers: ReadonlyMap<string, string> = new Map();
  let packetRow = row;
  try {
    const context = await coverLetterCandidateContext(row);
    const compactQuestions = compactMaterialQuestions(
      discoveredFields,
      resolutionCurrent,
      portal,
      context.declaredSkills,
    );
    const includeCoverLetter = coverLetterSupported && !storedCoverLetter(row);
    if (includeCoverLetter || compactQuestions.length > 0) {
      const materials = await generateCompactApplicationMaterials({
        company: jobContextCompany(row) || 'this company',
        role: current.role ?? 'this role',
        jdText: current.jd_text,
        candidateSource: context.source,
        contestedMetrics: context.contested.labels,
        includeCoverLetter,
        questions: compactQuestions,
      });
      fastify.log.info({
        applicationId: row.id,
        model: 'claude-sonnet-5',
        coverLetterRequested: includeCoverLetter,
        answerCount: compactQuestions.length,
        ...materials.usage,
      }, 'Compact generation usage');
      compactAnswers = materials.answers;
      if (includeCoverLetter && materials.coverLetter) {
        try {
          await persistGeneratedCoverLetterBody(row, materials.coverLetter, context);
          const refreshedRows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, row.id)).limit(1);
          if (refreshedRows[0]) packetRow = refreshedRows[0];
        } catch (error) {
          // The dedicated cover-letter path below retains its own feedback retry. A rejected
          // bundled letter never enters the packet, while accepted bundled essays remain reusable.
          fastify.log.warn({ error, applicationId: row.id }, 'Compact cover letter failed validation, retrying it through the dedicated generator');
        }
      }
    }
  } catch (error) {
    // Any unavailable model falls back item by item. Required prose becomes a dashboard question;
    // optional prose stays optional. Existing reviewed answers never need a healthy model.
    fastify.log.warn({ error, applicationId: row.id }, 'Compact generation failed, using dedicated generators');
  }
  const coverLetterOutcome = await packetForCoverLetterCapability(
    packetRow,
    coverLetterSupported,
    fastify,
    packetUsesControlledResumeFixture(portal),
  );
  /* The same question about the second document, off the same discovery read, and applied to the
   * packet the cover-letter step just produced rather than to a rebuild - see
   * packetForTranscriptCapability for why a rebuild here would be handed the wrong row. */
  const transcriptSupported = stableManagedDocumentCapability({
    authoritative: greenhouseSchema?.transcriptSupported,
    discovered: managedResultHasTranscriptUpload(discoveryResult, portal),
    prior: priorManagedFormSnapshot?.transcript_supported,
    current: current.transcript_supported,
  });
  const transcriptOutcome = packetForTranscriptCapability(
    coverLetterOutcome.packet,
    transcriptSupported,
  );
  if (coverLetterOutcome.packet.transcriptUnavailableReason) {
    // The raw reason to the log, the fixed sentence to the applicant, same split as the cover
    // letter's two failures. Whoever has to fix a dead pointer reads logs.
    fastify.log.warn(
      { applicationId: row.id, reason: coverLetterOutcome.packet.transcriptUnavailableReason },
      'Attached transcript could not be loaded, continuing without it',
    );
  }
  packet = transcriptOutcome.packet;
  const {
    questions: discoveredQuestions,
    attentionReasons: discoveredAttentionReasons,
    optionalAttentionReasons: discoveryOptionalAttention,
    invalidatedQuestionKeys,
    questionMetadataBlockers: discoveredQuestionMetadataBlockers,
  } = await discoverAndResolveQuestions(
    discoveredFields,
    coverLetterOutcome.row,
    resolutionCurrent,
    applicationProfile,
    authorization.enabled,
    portal,
    savedAnswers,
    compactAnswers,
  );
  const optionProbeMetadataBlockers = questionMetadataBlockersForOptionProbeFailures(
    portal,
    normalizedDiscoveredFields,
    blockingOptionProbeFailures,
  );
  const questionMetadataBlockers = dedupeQuestionMetadataBlockers([
    ...discoveredQuestionMetadataBlockers,
    ...optionProbeMetadataBlockers,
  ]);
  const discoveryMetadataMeasurementComplete = questionMetadataMeasurementIsComplete({
    discoveryFailed: discoveryFailures.length > 0,
    filledFields: discoveryResult?.filledFields,
    providerBlockers: discoveryResult?.blockers,
    discoveredQuestionCount: discoveryResult?.discovered?.length ?? 0,
    extracted: discoveryResult?.extracted,
    text: discoveryResult?.text,
  });
  if (discoveryMetadataMeasurementComplete) {
    await persistQuestionMetadataMeasurement(row, runId, questionMetadataBlockers);
  }
  /* A failed option probe must not take an applicant-chosen answer out of the packet.
   *
   * Measured on Jump Trading packet 2e593ac5, 2026-08-17 late: the graduation control's probe
   * failed on the live run, the label key computed here dropped her stored "Spring/Summer 2028"
   * (answer_source applicant_review, verbatim on the employer's list) out of the merge, and the
   * only value that ever reached the control was the speculative ladder's profile-derived
   * "May 2028". A failed probe means the option list could not be READ this run; her answer does
   * not need it read, because the fill types it verbatim and clicks the option whose text matches.
   * Resolver-driven invalidation keys are untouched: those branches deliberately blank an answer
   * so she re-confirms it, and this exemption is only for the read failure. */
  const storedApplicantAnswerKeys = new Set(storedQuestions
    .filter((question) => applicantChoseStoredAnswerInRound(question, current.questions_reviewed_at))
    .map((question) => normalizeReviewQuestionLabel(question.question).toLowerCase()));
  const failedQuestionKeys = failedFields
    .map((field) => normalizeReviewQuestionLabel(field.label).toLowerCase())
    .filter((key) => !storedApplicantAnswerKeys.has(key));
  /* OLD JUNK RETIRES WHEN ITS CONTROL IS RE-CAPTURED UNDER ITS REAL NAME.
   *
   * A discovery defect mints a question under a wrong label ("Type your response",
   * "B1 (Intermediate) or below"); the defect gets fixed; the next discovery captures the same
   * control under the employer's actual words - and the old row used to stay forever, a required
   * question nobody can act on, sitting NEXT TO its clean twin and holding the review loop open
   * (measured on Transparent Hiring and Mytos, 2026-08-19/20). Retired only under three proofs,
   * because a transient miss must not eat real questions: the stale label was NOT re-discovered,
   * its selector WAS re-discovered (form reached, control present) under a DIFFERENT label, and
   * the applicant never touched the row - an answer she chose herself is never retired by a label
   * rename, exactly as the option-probe exemption above keeps hers. */
  const discoveredLabelKeys = new Set(discoveredQuestions
    .map((question) => normalizeReviewQuestionLabel(question.question).toLowerCase()));
  /* DURABLE selectors only, on both sides. A [data-litos-discovered-N] marker is stamped per
     discovery page load, so run A's marker 3 and run B's marker 3 are the same STRING for
     potentially different controls - an ordinal coincidence that would satisfy the
     "selector re-discovered" proof and retire a legitimate row on a transient miss.
     durablePortalSelector already refuses markers for exactly this reason. */
  const discoveredLabelBySelector = new Map(discoveredQuestions
    .flatMap((question) => {
      const durable = durablePortalSelector(question.portal_selector);
      return durable ? [[durable, normalizeReviewQuestionLabel(question.question).toLowerCase()] as const] : [];
    }));
  const staleRelabeledKeys = storedQuestions
    .filter((stored) => {
      if (applicantChoseStoredAnswer(stored)) return false;
      /* ANY standing answer keeps the row, whatever wrote it. The label-flap class (X one run,
         Y the next, one stable control) would otherwise retire and re-mint on every flip, and a
         drafted essay or resolver answer riding the retired row would be spent each time. The
         junk this exists to clear is the UNANSWERED machine-labelled row that blocks the review
         loop, and empty is the only shape that row has. */
      if (stored.answer?.trim()) return false;
      const selector = durablePortalSelector(stored.portal_selector);
      if (!selector) return false;
      const key = normalizeReviewQuestionLabel(stored.question).toLowerCase();
      if (discoveredLabelKeys.has(key)) return false;
      const rediscovered = discoveredLabelBySelector.get(selector);
      return Boolean(rediscovered && rediscovered !== key);
    })
    .map((stored) => normalizeReviewQuestionLabel(stored.question).toLowerCase());
  if (staleRelabeledKeys.length > 0) {
    fastify.log.info(
      { applicationId: row.id, portal, retired: staleRelabeledKeys },
      'Stored machine-labelled questions retired: their controls re-discovered under real labels',
    );
  }
  const mergedQuestions = reopenUnfitClosedChoiceQuestions(resolveApplicantClosedChoiceFallbacks(
    discoveredFields,
    mergeDiscoveredPortalQuestions(
      discoveredQuestions,
      storedQuestions,
      [...invalidatedQuestionKeys, ...failedQuestionKeys, ...staleRelabeledKeys],
      blockingOptionProbeFailedIds,
      current.questions_reviewed_at,
    ),
    referralSourceForApplication(
      applicationProfile.referral_source_default,
      applicationProfile.referral_source_evidence,
    ),
    packet.mostRecentRole?.company,
  ));
  const referralResolutionDiagnostics = mergedQuestions.flatMap((question) => {
    const label = normalizeReviewQuestionLabel(question.question);
    const family = REFERRAL_SOURCE_CHOICE_QUESTION.test(label)
      ? 'source'
      : GENERIC_OTHER_DETAIL_QUESTION.test(label)
        ? 'other_detail'
        : EMPLOYEE_REFERRAL_DETAIL_QUESTION.test(label)
          ? 'employee_detail'
          : null;
    if (!family) return [];
    const other = otherReferralOption(usableOptions(question.options));
    const answer = question.answer.trim();
    const answerShape = !answer
      ? 'empty'
      : other && answer.toLowerCase() === other.toLowerCase()
        ? 'other_option'
        : answer === REFERRAL_OTHER_DETAIL
          ? 'litos_detail'
          : /^n\/?a$/i.test(answer)
            ? 'not_applicable'
            : 'other_value';
    const optionSource = question.answer_option_source?.trim();
    return [{
      family,
      answerShape,
      answerSource: question.answer_source ?? null,
      optionSourceShape: !optionSource
        ? 'empty'
        : isJobBoardReferralClaim(optionSource)
          ? 'job_board'
          : 'other_value',
      optionCount: usableOptions(question.options).length,
    }];
  });
  if (referralResolutionDiagnostics.length > 0) {
    fastify.log.info(
      { applicationId: row.id, portal, referralResolutionDiagnostics },
      'Referral resolution provenance shape',
    );
  }
  const discoveryAttention = filterAutomaticallyResolvedReferralAttention(
    discoveredAttentionReasons,
    mergedQuestions,
  );
  const filteredDiscoveryOptionalAttention = filterAutomaticallyResolvedReferralAttention(
    discoveryOptionalAttention,
    mergedQuestions,
  );
  packet.questions = packetQuestionsForFill(mergedQuestions);
  // The fill run gets the same option lists, so the fixed education comboboxes type an exact option
  // instead of the profile's own phrasing. It only ever gets ONE attempt at a react-select (a second
  // click closes the menu the first one opened), so the first value has to be the right one.
  const managedFormSnapshot = managedFormSnapshotWithStableCapabilities({
    discoveryFailed: discoveryFailures.length > 0,
    fieldOptions,
    failedFields,
    prior: priorManagedFormSnapshot,
    coverLetterSupported,
    transcriptSupported,
  });
  packet.fieldOptions = managedFormSnapshot.field_options;
  packet.failedFields = managedFormSnapshot.failed_fields;

  const measuredPrepareEnvelope = employerDeliveryEnvelope({
    channel: browserEmployerDeliveryChannel(browserDeliveryRuntimeIdentity().provider),
    destinationUrl: applicationUrl,
    portalFamily: portal,
    runtime: browserDeliveryRuntimeIdentity(),
    coverLetterSupported: managedFormSnapshot.cover_letter_supported,
    transcriptSupported: managedFormSnapshot.transcript_supported,
  });
  if (await holdPreparationForPacketDrift({
    row,
    current,
    packet,
    audit,
    verifiedQuestions,
    mode: 'browser',
    envelope: measuredPrepareEnvelope,
    log: fastify.log,
    patch: {
      submission_run_id: runId,
      questions: mergedQuestions,
      managed_form_snapshot: managedFormSnapshot,
      ...(discoveryMetadataMeasurementComplete ? { question_metadata_blockers: questionMetadataBlockers } : {}),
      ...(managedFormSnapshot.cover_letter_supported !== undefined
        ? { cover_letter_supported: managedFormSnapshot.cover_letter_supported }
        : {}),
      ...(managedFormSnapshot.transcript_supported !== undefined
        ? { transcript_supported: managedFormSnapshot.transcript_supported }
        : {}),
      ...(packet.applicantEmail ? { applicant_email: packet.applicantEmail } : {}),
      ...(packet.applicantSnapshot ? { applicant_snapshot: packet.applicantSnapshot } : {}),
    },
  })) return;

  const fillActions = buildManagedPortalActions(portal, packet);
  /* Action shape only, never question text or answer values. A required field can be discovered,
   * answered, and still remain empty because the final packet aimed it by label rather than by the
   * provider's durable control id. The existing option-probe diagnostic cannot distinguish those
   * paths because probing and filling use separate action lists. Recording the control handle,
   * action type, and scoping mechanism makes that boundary observable without logging applicant
   * data or employer option text. */
  const reviewedActionShapeDiagnostics = fillActions.flatMap((action) => {
    if (!action.label?.startsWith('question:')
      && !action.label?.startsWith('question_combo')) return [];
    return [{
      type: action.type,
      controlId: managedOptionProbeControlId({ label: '', selector: action.selector }) ?? null,
      scopedByLabel: Boolean(action.text?.trim()),
    }];
  }).slice(0, 60);
  fastify.log.info({
    applicationId: row.id,
    portal,
    reviewedActionCount: reviewedActionShapeDiagnostics.length,
    reviewedActionShapes: reviewedActionShapeDiagnostics,
  }, 'Managed reviewed-question action shapes');
  /* Which reviewed questions this run will not even attempt.
   *
   * On a form small enough to fit the runner's action ceiling this is empty and costs nothing. On
   * one that does not fit, the builder trims rather than throwing - a prepare run cannot press
   * submit, so there is no send to protect and a partly filled form she can finish beats a dead
   * packet - and this is what stops that trade being made behind her back. Read off the finished
   * action list rather than predicted from the budget, because every silent drop this module has
   * shipped looked correct in the arithmetic that produced it. */
  const unattemptedQuestions = budgetDroppedReviewedQuestions(packet, fillActions);
  if (unattemptedQuestions.length > 0) {
    fastify.log.error({
      applicationId: row.id,
      portal,
      actionCount: fillActions.length,
      unattemptedQuestions,
    }, 'The action budget could not hold every reviewed question, so some were not attempted');
  }
  await writeReview(row, nextReview(current, {
    status: 'filling',
    submission_run_id: runId,
    progress_screenshot_url: progressScreenshotUrl,
    progress_stage: 'Filling your answers',
    progress_updated_at: new Date().toISOString(),
  }));
  /* This prepare run fills the employer form and screenshots it for review; it never presses
   * submit (buildManagedPortalActions was called without `submit`, so there is no confirmAndSubmit
   * and no allowSubmit). But typing into the form is a mutation, and under stratus
   * correlationRequired every mutating run needs a submissionAttempt and providerDeadline or it is
   * refused with "A durable submissionAttempt is required for every submit-capable or continuable
   * run". scanCorrelation mints the ephemeral throwaway pair for exactly this case - a mutation
   * that is not a submission - the same way the posting-question pre-scans already do. Without it
   * the fill fails closed and nothing is ever shown or sent.
   *
   * The widened window rather than the read-scan default: this and the discovery pass are the two
   * big runs of the prepare path (up to 120 actions including document uploads), so they are the
   * two that can legitimately reach stratus's own run budget. See MANAGED_PREPARE_SCAN_OPTIONS.
   *
   * FILL options, not the shared scan options: this is the one run whose missing screenshot is
   * fatal below, so it is the one run that asks stratus to wait for the capture. */
  const result = await runManagedBrowserWithAccountFence(
    row.user_id,
    applicationUrl,
    managedActionsWithExactPageUrl(fillActions, applicationUrl),
    MANAGED_PREPARE_FILL_OPTIONS,
  );
  const actionDiagnostics = managedActionDiagnosticsForLog(result.actionDiagnostics);
  if (actionDiagnostics.length > 0) {
    fastify.log.info({
      applicationId: row.id,
      portal,
      actionDiagnostics,
    }, 'Managed provider-owned question action diagnostics');
  }
  if (!result.screenshot) throw new Error('Stratus managed browser did not return a preview screenshot');
  /* A value Litos typed that the run then never accounted for.
   *
   * Measured on DRW, 2026-08-08: `question:legal first name` was a single fill of "Mehek" into a
   * plain visible textarea, sat at index 55 of an accepted 120-action list, the run reported fills
   * as late as index 100, and the result named it in neither filledFields nor skipped.
   *
   * WHAT CHANGED ON 2026-08-09, and it is the reason this is now three things rather than one log
   * line. The 25-application run was the run this diagnostic was shipped to observe, and it stayed
   * silent while Deepgram's `question:expected graduation year` went missing exactly as predicted.
   * Silence was the answer: the only way the old test could pass was a `result.skipped` line that
   * STARTED with the label and explained nothing, which the sanitizer then dropped as alias-ladder
   * noise. One predicate was answering both "did anyone mention this" and "is this worth showing
   * her", and a line that satisfied the first while failing the second fell through both. So: the
   * suppression test is now an EXPLANATION test, she gets a sentence saying the blank field is
   * ours, and the provider's own words are kept on the row for the labels that lost a value. */
  const unexplainedAnswers = managedUnexplainedAnswers(fillActions, result);
  if (unexplainedAnswers.length > 0) {
    fastify.log.error(
      {
        applicationId: row.id,
        portal,
        fields: unexplainedAnswers.map((entry) => entry.label),
        rawMentions: unexplainedAnswers.map((entry) => entry.rawMentions),
      },
      'Answers were typed into the form and the run accounted for them in neither a fill nor a reason',
    );
  }
  const preview = await storeFilledPreviewScreenshot(
    `users/${row.user_id}/submission-runs/${runId}/filled.png`,
    Buffer.from(result.screenshot, 'base64'),
  );
  // Sanitized at the boundary, not upstream: the managed provider scans the form in its own
  // service and returns finished sentences, so it never passes through this repo's label
  // resolution. Live QA proved that gap by showing three raw UUIDs on a real Ashby posting.
  //
  // THIS IS WHERE EVERY STALLED PACKET ACTUALLY STOPPED, measured against prod on 2026-08-08: all
  // fourteen open stalls in the database were written below by this function, not by the submit
  // path's probe. Each one carries `submission_error: null` and an attention_reason whose first line
  // is the provider's own "CAPTCHA requires your attention" - the throw at the submit probe writes a
  // submission_error and a different sentence, and neither appears on any row Litos has ever
  // written. So the runner's CAPTCHA verdict, arriving here in result.blockers, is what stopped
  // them, on Greenhouse pages whose only challenge is an invisible reCAPTCHA behind the badge.
  // corroborateManagedCaptchaBlockers is the layer that asks the page rather than the provider.
  const providerBlockers = corroborateManagedCaptchaBlockers(
    portal,
    attentionBlockersForManagedResult(
      portal,
      sanitizeProviderBlockers(result.blockers ?? []),
      result,
      packet,
    ),
    result,
  );
  /* A REQUIRED-FIELD SENTENCE ABOUT A FIELD THE EMPLOYER DID NOT MARK REQUIRED.
   *
   * Measured on Scale AI packet 9ddffb88 (2026-08-13): the whole send stopped on '"If yes, please
   * provide further explanation below." is required and is still empty', about `question_8788020005`,
   * which carries aria-required="false", no required attribute and no asterisk in its label. The
   * provider's readiness gate reads a leaf element whose text matches its field-error vocabulary as
   * a validation message, and "please provide" is in that vocabulary, so the employer's own QUESTION
   * was read back as the employer's own COMPLAINT. The same false sentence then propagated into
   * `unansweredRequired` below as "1 required field has no question you can answer in Litos",
   * because a field the employer left optional correctly has no question record.
   *
   * Refused HERE rather than in the gate, because the gate that produced it runs in the managed
   * provider's own service. See lib/conditionalFollowUp.ts for the four independent facts a refusal
   * needs, and for why the absence of any one of them keeps the blocker: this is the only edit in
   * this function that can make a packet MORE sendable, and every other measured instance keeps its
   * blocker because the gating question was itself left unanswered.
   *
   * Read before every other use of `blockers`, so the send gate, the unanswerable count and the
   * applicant's attention_reason cannot disagree about which sentences this run stands behind. */
  const unmetFollowUps = unmetConditionalFollowUpBlockers(providerBlockers, discoveredFields, mergedQuestions);
  const afterFollowUps = unmetFollowUps.length > 0
    ? providerBlockers.filter((blocker) => !unmetFollowUps.includes(blocker))
    : providerBlockers;
  if (unmetFollowUps.length > 0) {
    fastify.log.info(
      { applicationId: row.id, portal, blockers: unmetFollowUps },
      'Conditional follow-up reported required on a field the employer marked optional, and its condition is unmet',
    );
  }
  /* The discovery pass and the managed fill provider can report the same referral refusal through
   * separate channels. The discovery channel is filtered above. Apply the identical proof to the
   * provider channel too: only an employer Other option that still carries the applicant's exact
   * Job board provenance can retire its source/detail refusal. An applicant-reviewed Other without
   * that provenance, or any primary employee-referral question, remains a blocker. */
  const afterReferralResolution = filterAutomaticallyResolvedReferralAttention(
    afterFollowUps,
    mergedQuestions,
  );
  /* The consent control the submit-time tick plan already covers is not a prepare-time blocker.
   *
   * The fill run leaves it untouched BY DESIGN (no pre-ticked consent, ever), the tick runs as the
   * action immediately before submit, and the plan below is the same fail-closed licence the submit
   * path demands. Without this excusal the readiness gate reads the deliberately-untouched checkbox
   * as required-and-still-empty, `safe` goes false, and the Send press that would run the tick can
   * never be offered - measured live on Transparent Hiring (breezy), 2026-08-20. */
  const prepareConsentTickPlan = managedConsentTickPlan(portal, packet);
  const consentTickExcused = consentTickCoveredBlockers(afterReferralResolution, prepareConsentTickPlan);
  const blockers = consentTickExcused.length > 0
    ? afterReferralResolution.filter((blocker) => !consentTickExcused.includes(blocker))
    : afterReferralResolution;
  if (consentTickExcused.length > 0) {
    fastify.log.info(
      { applicationId: row.id, portal, blockers: consentTickExcused },
      'Consent control covered by the standing submit-time tick plan excused from prepare blockers',
    );
  }
  const networkAccessRestriction = managedNetworkAccessRestrictionReason(portal, result.text, result.title, result);
  // A blocker naming a field the stored profile CAN answer is a Litos defect, never work for the
  // applicant. Twenty-five prod packets carried exactly these lines (GPA, university, education
  // level, graduation month and year, referral source) with the resolved answer already sitting
  // in the same row, and nothing recorded that the two facts contradicted each other. Logging it
  // by name is what turns the next occurrence into a bug report instead of another silent stall.
  const unattemptedProfileFields = profileBackedBlockerLabels(
    blockers,
    applicationProfile,
    applicationContextForQuestionResolution(row, resolutionCurrent),
    packet.roleCountry,
    packet.roleCountryCode,
  );
  if (unattemptedProfileFields.length > 0) {
    fastify.log.error(
      { applicationId: row.id, portal, fields: unattemptedProfileFields },
      'Profile-backed fields reported as required and still empty',
    );
  }
  const verificationHandoff = blockers.some((blocker) =>
    /verification code|security code|one[ -]?time code|passcode|\botp\b/i.test(blocker),
  );
  /* A MISSING COVER LETTER IS A BLOCKER ON A FORM THAT ASKS FOR ONE. This line used to read "worth
     telling the applicant about, but it is not a blocker: the form is filled and sendable without
     it", and it is not sendable without it. /submission/approve refuses a packet with 422 when
     cover_letter_supported is true and no cover letter is recorded, so leaving `safe` alone here
     produced the one outcome that is worse than either honest answer: a packet described to her as
     ready, with a Send button that cannot work. It reaches `safe` below rather than only
     attention_reason. This branch is only ever populated when the form HAS a cover-letter control,
     because packetForCoverLetterCapability returns no issue when `supported` is false. */
  const coverLetterAttention = coverLetterOutcome.coverLetterIssue ? [coverLetterOutcome.coverLetterIssue] : [];
  /* A transcript she attached that this run could not carry, and it gates `safe` below for a
   * different reason than the cover letter does.
   *
   * The letter gates because /submission/approve refuses the packet outright, so calling it ready
   * would offer a Send button the server will not honour. Nothing refuses a missing transcript: the
   * application is sendable, and under standing consent `safe` turns straight into a click in this
   * same call. That is exactly why this has to hold it back. An application she attached a
   * transcript to, sent without it and without her being told, is the silent drop this file spends
   * most of its length preventing in other forms. Not safe means she sees the sentence and decides. */
  const transcriptAttention = transcriptOutcome.transcriptIssue ? [transcriptOutcome.transcriptIssue] : [];
  const filledFields = managedResultFilledFields(result);
  const questionMetadataMeasurementComplete = questionMetadataMeasurementIsComplete({
    discoveryFailed: discoveryFailures.length > 0,
    filledFields,
    providerBlockers: [...(result.blockers ?? []), ...(discoveryResult?.blockers ?? [])],
    discoveredQuestionCount: discoveryResult?.discovered?.length ?? 0,
    extracted: [...(result.extracted ?? []), ...(discoveryResult?.extracted ?? [])],
    text: result.text,
    email: packet.email,
  });
  // Both passes count as evidence the form was reached. The discovery pass enumerates the live
  // inputs and probes the core fields, so a run whose fill pass came back empty can still have
  // proven the form was there - and a run where NEITHER pass saw anything has proven the opposite.
  const evidenceBlockers = preparationEvidenceBlockers({
    ...result,
    filledFields,
    blockers: [...(result.blockers ?? []), ...(discoveryResult?.blockers ?? [])],
    discovered: discoveredFields,
    extracted: [...(result.extracted ?? []), ...(discoveryResult?.extracted ?? [])],
  }, packet);
  // The gap between what the employer demands and what Litos can offer her a place to type. See
  // unansweredRequiredBlockerLabels: this is the measurement the DRW run should have carried and did
  // not, and it is logged as an error because a non-zero count is a product defect first and the
  // applicant's problem second.
  const unansweredRequired = unansweredRequiredBlockerLabels(blockers, mergedQuestions);
  /* The same labels again, read for WHICH DOCUMENT rather than HOW MANY.
   *
   * unansweredRequired above is a count and a sentence: it says the employer wants something there
   * is nowhere to type. This says the employer wants a transcript, which is a thing the applicant
   * can actually hand over, and it is the field the dashboard draws its upload row from. Same
   * measurement, two readings, and they are separated because the count is honest about everything
   * while only some of it is actionable. */
  const requiredDocuments = measuredRequiredDocuments(unansweredRequired, mergedQuestions);
  if (unansweredRequired.length > 0 || discoveryFailures.length > 0) {
    fastify.log.error({
      applicationId: row.id,
      portal,
      discoveryFailure: discoveryFailures[0],
      discoveredCount: discoveredFields.length,
      questionCount: mergedQuestions.length,
      unansweredRequired,
      requiredDocuments: requiredDocuments.map((ask) => ask.kind),
    }, 'Required fields with no answerable question record');
  }
  const honestyReasons = discoveryHonestyReasons(discoveryFailures[0], unansweredRequired);
  /* The runner's own account of the answers that did not stick, from both passes.
   *
   * Surfaced, deliberately NOT added to the `safe` gate below. A value that failed to persist on a
   * REQUIRED control already comes back as the employer's own "is required and is still empty"
   * blocker, which does gate the send; on an optional control it is a field Litos did not embellish,
   * and refusing to send a complete application over one of those is the deadlock this codebase has
   * already had to unwind twice. */
  const answerLossReasons = managedAnswerLossReasons({
    skipped: [...(result.skipped ?? []), ...(discoveryResult?.skipped ?? [])],
  });
  /* A value that WAS typed and whose outcome the run never accounted for.
   *
   * Third of three, and the three are not the same fact, which is why all three are here. Read in
   * order of how much the run knows:
   *
   *   answerLossReasons        Litos typed it, the page rejected it, the run SAID SO. Known bad,
   *                            not a gate: a required control that lost its value already comes
   *                            back as the employer's own "is required and is still empty".
   *   unexplainedAnswerReasons Litos typed it and the run accounted for it in NEITHER a fill nor
   *                            an explanation. Outcome unknown, and not a gate for the same reason
   *                            as the line above: whatever happened, if the control was required
   *                            the employer's blocker gates it, and if it was optional this is not
   *                            worth refusing a complete application over.
   *   budgetShortfallReasons   Litos never typed it at all. THIS ONE GATES, below.
   *
   * The uncertainty runs the other way for the third: the first two ran the action and the form
   * had its say, so the employer's own required-field blocker is a reliable backstop. A question
   * with no action never reached the form, so nothing downstream can notice it - no filled_fields
   * entry, no provider blocker unless the employer happens to mark it required, and a preview
   * screenshot showing a blank that looks like every other optional blank. */
  const unexplainedAnswerReasons = managedUnexplainedAnswerReasons(unexplainedAnswers);
  /* The questions the action budget could not hold, in her words.
   *
   * Unlike answerLossReasons directly above, this DOES gate the send, and the difference is which
   * way the uncertainty runs. A value that did not stick is a value Litos tried to type and the page
   * did not keep; if that control was required, the employer's own blocker already says so. A
   * question with no action was never typed at all, on a form Litos was handed an answer for, and
   * nothing else in this function will notice: it is not in filled_fields, it produces no provider
   * blocker unless the employer happens to mark it required, and the preview screenshot shows a
   * blank that looks like every other optional blank. Sending that under standing consent is the
   * silent drop this whole budget exists to prevent, one layer up. */
  const budgetShortfallReasons = unattemptedQuestions.length > 0
    ? [
      `This application asks more questions than Litos can fill in one pass, so ${unattemptedQuestions.length} `
      + `of them ${unattemptedQuestions.length === 1 ? 'was' : 'were'} left untouched and nothing has been sent: `
      + `${unattemptedQuestions.map((q) => `"${q.slice(0, 60)}"`).join(', ').slice(0, 400)}. `
      + 'Open it when you have a minute and finish those by hand.',
    ]
    : [];
  const attentionReasons = [
    ...blockers,
    ...discoveryAttention,
    /* Shown, never gating: see optionalAttentionReasons in discoverAndResolveQuestions. */
    ...filteredDiscoveryOptionalAttention,
    ...evidenceBlockers,
    ...coverLetterAttention,
    ...transcriptAttention,
    ...answerLossReasons,
    ...unexplainedAnswerReasons,
    ...budgetShortfallReasons,
    ...optionProbeAttention,
    ...honestyReasons,
  ];
  const attentionCategories = attentionCategoriesForReasons(attentionReasons);
  const captchaAttention = blockersIncludeCaptcha(blockers);
  // A discovery pass that never ran cannot be the basis for calling a form complete, so its failure
  // is a gate on `safe` in its own right: without this, a page whose fixed fields all filled would
  // still be sent while every question the employer asked went unread.
  //
  // The blank-required term is the half of the pre-submit gate that had to MOVE rather than be
  // deleted. Refusing the run in front of the browser was a deadlock (see
  // blankRequiredQuestionLabels); refusing the SEND after the run is not, because by this line the
  // run has happened and mergedQuestions is the freshly discovered truth about this form rather
  // than a pre-run snapshot. Standing consent turns `safe` straight into 'submitting' in the same
  // call, so this is the only thing between an unanswered required question and a click on this
  // path. Not safe means ready_for_final_approval, where she is shown the blank question and can
  // answer it - which is exactly the loop the run gate had no exit from.
  //
  // The optionProbe term holds the send ONLY for the failures whose control was genuinely left
  // blank. Narrowing the blast radius of the MESSAGE is not permission to send a form carrying a
  // question Litos knowingly left blank - and a COVERED failure is not that form. Its control was
  // typed with her reviewed answer, verbatim, by this same run (see optionProbeAttentionReasons:
  // the covered sentence says exactly this), so what the wall was protecting is protected by the
  // machinery that watches the typing itself: a required value that did not stay trips the
  // employer's own required-empty blocker in `blockers`, and an unconfirmable choice commit trips
  // the unverified-choice mark the pre-submit gate reads. Measured on the Easy Dynamics Rippling
  // packet (2026-08-20): the phone number's dial-code list read back conflicting windows on every
  // run, the number itself was typed, verified, and sat in filled_fields - and the row re-parked
  // on the same sentence forever, with the dashboard's only affordance a checkbox that writes
  // nothing. It reads the failure ARRAY rather than the rendered prose, for the reason the direct
  // path's comment below gives: a sentence that renders to nothing must never be able to restore
  // `safe`.
  const unansweredRequiredQuestions = blankRequiredQuestionLabels(mergedQuestions);
  const undecidedOptionalQuestions = undecidedOptionalQuestionLabels(mergedQuestions);
  const discoveryAttentionDiagnostics = discoveryAttention.map((reason) => {
    const questionStem = /(?:left for you|answer):\s*["']([^"']{1,160})/i.exec(reason)?.[1]
      ?? /(?:question|answer)[^"']*["']([^"']{1,160})/i.exec(reason)?.[1]
      ?? null;
    const normalized = reason.toLowerCase();
    const reasonShape = normalized.startsWith('none of the options match')
      ? 'closed_option_mismatch'
      : normalized.startsWith('none of the options exactly match')
        ? 'remembered_option_mismatch'
        : normalized.startsWith('open-ended question left for you')
          ? 'open_ended_unanswered'
          : normalized.startsWith('drafted answer needs your review')
            ? 'draft_review'
            : normalized.startsWith('ai-drafted answer needs your review')
              ? 'ai_draft_review'
              : normalized.includes('how you heard about this role is yours to answer')
                ? 'referral_unresolved'
                : 'other';
    return { reasonShape, questionStem };
  });
  const recentEmployerResolutionDiagnostics = mergedQuestions
    .filter((question) => RECENT_EXPERIENCE_EMPLOYER_QUESTION.test(normalizeReviewQuestionLabel(question.question)))
    .map((question) => {
      const recentEmployer = packet.mostRecentRole?.company?.trim();
      const optionSource = question.answer_option_source?.trim();
      return {
        answerShape: question.answer.trim().toLowerCase() === otherReferralOption(usableOptions(question.options))?.toLowerCase()
          ? 'other_option'
          : question.answer.trim() ? 'other_value' : 'empty',
        answerSource: question.answer_source ?? null,
        optionSourceShape: !optionSource
          ? 'empty'
          : recentEmployer && optionSource.toLowerCase() === recentEmployer.toLowerCase()
            ? 'current_recent_employer'
            : 'other_value',
        recentEmployerPresent: Boolean(recentEmployer),
        recentEmployerListed: Boolean(recentEmployer && usableOptions(question.options)
          .some((option) => option.trim().toLowerCase() === recentEmployer.toLowerCase())),
        optionCount: usableOptions(question.options).length,
      };
    });
  const safe = blockers.length === 0
    && discoveryAttention.length === 0
    && filteredDiscoveryOptionalAttention.length === 0
    && evidenceBlockers.length === 0
    && discoveryFailures.length === 0
    && uncoveredProbeFailures.length === 0
    && coverLetterAttention.length === 0
    // A question the run never attempted is an answer she gave Litos and Litos did not use. The
    // submit path refuses outright rather than trade one away; this is the same refusal on the path
    // that has no submit button to withhold, and it is what makes the trim above safe to allow.
    && unattemptedQuestions.length === 0
    && unansweredRequiredQuestions.length === 0
    && undecidedOptionalQuestions.length === 0
    // See transcriptAttention: this one holds back a send nothing else would refuse.
    && transcriptAttention.length === 0;
  fastify.log.info({
    applicationId: row.id,
    portal,
    blockerCount: blockers.length,
    discoveryAttentionCount: discoveryAttention.length,
    optionalAttentionCount: filteredDiscoveryOptionalAttention.length,
    evidenceBlockerCount: evidenceBlockers.length,
    discoveryFailureCount: discoveryFailures.length,
    uncoveredProbeFailureCount: uncoveredProbeFailures.length,
    coverLetterAttentionCount: coverLetterAttention.length,
    unattemptedQuestionCount: unattemptedQuestions.length,
    unansweredRequiredQuestionCount: unansweredRequiredQuestions.length,
    undecidedOptionalQuestionCount: undecidedOptionalQuestions.length,
    transcriptAttentionCount: transcriptAttention.length,
    discoveryAttentionDiagnostics,
    recentEmployerResolutionDiagnostics,
    safe,
  }, 'Managed prepare safety gate shape');
  /* A FILL RUN THAT FOUND A SECURITY-CODE SCREEN HAS SUBMITTED THIS APPLICATION.
   *
   * Measured 2026-08-08: three Greenhouse packets (Redwood Materials, Scale AI, Cresta) came out of
   * this exact function at 'ready_for_final_approval', and the applicant's mailbox held a Greenhouse
   * security-code email timestamped to the minute of each run. submission_claimed_at,
   * submission_authorization and browser_session_id were all null on all three, so submit() never
   * ran: the fill run itself put an application in front of an employer.
   *
   * Two things follow, and the order matters. First, this state OUTRANKS the prepared status, which
   * would otherwise offer her a green "Send it" button over a form the employer has already seen -
   * pressing it issues another code and files nothing. Second, submit_was_authorized: false records
   * that no authorization existed, because that is a Litos defect and not a fact about the employer,
   * and it needs to be countable rather than reconstructed from timestamps a year from now.
   *
   * The runner's own submit guard is what should keep this branch cold; blockedSubmits says whether
   * it ever fired. This branch stays regardless: the guard cannot see a page that posts from its own
   * click handler, and a state Litos cannot describe is the failure this whole change is about. */
  const challenge = readManagedSecurityCodeChallenge(result);
  if (result.blockedSubmits) {
    fastify.log.error(
      { applicationId: row.id, portal, blockedSubmits: result.blockedSubmits },
      'A fill run attempted to submit the employer form and was stopped',
    );
  }
  const securityCode = challenge
    ? beginSecurityCodeState({
      challenge,
      attemptedAt: new Date().toISOString(),
      authorized: false,
      existing: current.security_code,
    })
    : null;
  if (securityCode) {
    fastify.log.error(
      { applicationId: row.id, portal, sentTo: securityCode.sent_to, digits: securityCode.digits },
      'A fill run reached an emailed security-code screen, so this application was submitted without authorization',
    );
  }
  const extensionHandoffUrl = managedExtensionHandoffUrl(
    portal,
    result.url,
    networkAccessRestriction,
    captchaAttention,
  );
  const preparedAttentionReason = [
    ...(securityCode ? [securityCodeAttentionReason(securityCode)] : []),
    ...attentionReasons,
  ].join('\n') || undefined;
  const preparedAttentionCategories = securityCode
    ? ['security_code' as const, ...attentionCategories.filter((category) => category !== 'security_code')]
    : attentionCategories.length > 0 ? attentionCategories : undefined;
  const extensionHandoffBinding = extensionHandoffUrl
    ? createDashboardHandoffBinding({
      applicationId: row.id,
      userId: row.user_id,
      frozenUrl: current.portal_url,
      frozenHandoffUrl: extensionHandoffUrl,
      frozenAtsName: current.ats_name,
      attentionReason: preparedAttentionReason,
      attentionCategories: preparedAttentionCategories,
    })
    : undefined;
  const review = nextReview(current, {
    ...preparedReviewPatch(authorization, safe),
    ...(securityCode
      ? {
        status: 'awaiting_security_code' as const,
        security_code: securityCode,
        submission_attempted_at: securityCode.requested_at,
      }
      : {}),
    /* A SECURITY-CODE SCREEN OUTRANKS THE CAPTCHA STALL, and until now the two branches simply both
     * applied to this same patch.
     *
     * A stall is the record of a HUMAN-VERIFICATION wait: it is what the "waiting on you" queue is
     * ordered by and what the time-to-resolution measurement is computed from. A run that reached an
     * emailed security-code screen is not waiting on a human verification, it is waiting on eight
     * characters out of her mailbox, and it already carries that state in `security_code` plus its
     * own attention category. Writing a human_verification stall beside it puts a row in the CAPTCHA
     * queue that no CAPTCHA is holding, and counts it in the stall metrics as one, which is the
     * metric confirming a challenge nobody saw.
     *
     * The captcha ATTENTION CATEGORY is untouched: the page really may have carried a widget, and
     * the categories list is allowed to name more than one thing. It is the stall - the queue's
     * entry and the clock - that must belong to exactly one wait. */
    ...(captchaAttention && !securityCode
      ? beginStall(current, {
        surface: 'server_run',
        // Read off the page's own markup rather than hard-coded. `unknown` was written on every one
        // of the fourteen stalls in prod, including pages carrying a reCAPTCHA anchor iframe, which
        // made the instrumentation unable to answer the single question it exists for: which
        // providers actually gate us. A run that stops owes a reason, and "I did not look" is not one.
        provider: managedCaptchaProvider(result, portal),
        /* 'at_submit', because by the time this line runs THE FILL ALREADY HAPPENED. The managed run
           above filled the form and returned the preview screenshot; filled_fields below is written
           off that same result. Measured against prod on 2026-08-08, the fourteen open stalls this
           site wrote carry between 5 and 15 filled fields each, and every one of them was labelled
           'before_fill'. That is the sentence stallNudge renders as "Nothing is filled in yet" about
           a form Litos had completed and screenshotted for them: the exact mistake the stage field
           exists to prevent, pointed the other way round. Latent rather than delivered so far, and
           only because /internal/captcha-stall-nudge has no scheduler in vercel.json or in Actions.
           A label that is wrong until someone wires up the cron is still wrong.
           The direct Playwright path in prepare() draws it the same way, for the identical
           fill-then-observe shape - it records 'at_submit' from prepare too. 'before_fill' still
           belongs to the two sites that genuinely stop before touching the form: the pre-browser
           family gate in prepare(), and the submit path's CAPTCHA probe. */
        stage: 'at_submit',
        source: 'observed',
      })
      : {}),
    submission_run_id: runId,
    extension_handoff_url: extensionHandoffUrl,
    extension_handoff_binding: extensionHandoffBinding,
    filled_fields: filledFields,
    /* The documents the form asked for that this run could not supply. Written as an array on every
     * prepare, empty included, so an unmeasured packet (undefined) stays distinguishable from a
     * measured one that owes nothing. See ApplicationReviewState.required_documents. */
    required_documents: requiredDocuments,
    // The other half of filled_fields, and it was always empty before: what the runner tried and
    // could not leave on the form. See managedAnswerLossReasons.
    skipped_reasons: answerLossReasons,
    /* The provider's own words about the answers nobody accounted for, kept so the NEXT
     * investigation reads a row instead of re-deriving the run. Bounded to the labels that lost a
     * value, and written as an empty array rather than omitted so a run that has been re-tried on
     * this build can be told from one that predates the field. See ApplicationReviewState. */
    unexplained_fills: unexplainedAnswers.map((entry) => ({
      label: entry.label,
      question: entry.question,
      raw: entry.rawMentions,
    })),
    // Which address this form was filled with, and why. See ApplicationReviewState.applicant_email.
    ...(packet.applicantEmail ? { applicant_email: packet.applicantEmail } : {}),
    ...(packet.applicantSnapshot ? { applicant_snapshot: packet.applicantSnapshot } : {}),
    preview_screenshot_url: preview.url,
    verification: { status: verificationHandoff ? 'handoff' : 'not_needed' },
    questions: mergedQuestions,
    managed_form_snapshot: managedFormSnapshot,
    ...(questionMetadataMeasurementComplete ? { question_metadata_blockers: questionMetadataBlockers } : {}),
    ...(managedFormSnapshot.cover_letter_supported !== undefined
      ? { cover_letter_supported: managedFormSnapshot.cover_letter_supported }
      : {}),
    /* Measured, not assumed. `blockers` here is the merge of the discovery pass's required-field
     * scan and the fill run's, which is the same evidence every other required field on this form
     * is judged by. Written only when the form HAS a cover-letter control: on a portal with no such
     * control there is nothing to require and nothing was looked at, and `undefined` says so. */
    ...(coverLetterSupported
      ? {
        cover_letter_required: blockersRequireCoverLetter([
          ...blockers,
          ...(discoveryResult?.blockers ?? []),
        ]),
      }
      : {}),
    cover_letter_attached: Boolean(packet.coverLetter),
    /* Whether this form has somewhere to put a transcript, measured by the discovery pass.
     *
     * Written including false, because the SUBMIT run re-derives its attach decision from this flag
     * rather than probing the page again - it has no discovery pass of its own. A prepare that
     * measured the capability and did not write it down produces the one failure with no symptom:
     * the transcript attaches on the preview she approves and is missing from the application that
     * is actually sent, with nothing recorded either way.
     *
     * But written ONLY when the discovery pass actually ran. `runManagedBrowser`'s catch above
     * returns null for any failure, and managedResultHasTranscriptUpload(null) is false, so writing
     * this unconditionally records "this employer's form has nowhere to put a transcript" whenever
     * discovery merely errored. That is a measurement Litos never took, and the screen states it to
     * her as fact: the ask is filed undeliverable, the Add control is withheld, and she is told to
     * go and finish the application by hand on a form that may well have taken the file. Absent
     * means never measured, which is the same tri-state cover_letter_required uses ten lines above
     * and the same one the website reads. A discovery failure already holds the run back on its own
     * evidence; it must not also invent a fact about the employer. */
    ...(managedFormSnapshot.transcript_supported !== undefined
      ? { transcript_supported: managedFormSnapshot.transcript_supported }
      : {}),
    // The security-code sentence LEADS when there is one, and it leads because it is the only line
    // here that says an application has already reached the employer. The blockers below it are
    // still worth reading - they describe the form that was sent - but a list of empty fields shown
    // above "this was submitted" reads as a form that was not.
    attention_reason: preparedAttentionReason,
    attention_categories: preparedAttentionCategories,
    handoff_expires_at: new Date(Date.now() + HANDOFF_WINDOW_MS).toISOString(),
    submission_error: undefined,
  });
  await writeReview(row, review);
  /* The ask has just been measured, so this is the first moment anything knows this employer wants a
     file she may already have given Litos. See reuseStoredDocuments for why it runs here and not on
     the review screen, and why it runs after the write rather than before it. */
  await reuseStoredDocuments(row, review, fastify);
  fastify.log.info({
    applicationId: row.id,
    portal,
    status: review.status,
    attentionCategories,
    attentionReasonCount: attentionReasons.length,
    captchaOnly: attentionCategories.length === 1 && attentionCategories[0] === 'captcha',
  }, 'Application portal prepared with Stratus Sandbox');
}

/**
 * Capture the exact attended gate for Jobvite, iCIMS, or the measured Oracle URL without operating it. Unlike the generic
 * managed preparation this sends no identity, file, answer, consent, CAPTCHA, or submit action.
 * Building the packet first is intentional: it validates the immutable generated PDF and the
 * packet-specific Litos email before Chrome is offered the handoff.
 */
async function prepareManagedAttendedAccountGate(
  row: ResumeRow,
  current: ApplicationReviewState,
  portal: SupportedPortal,
  runId: string,
  fastify: FastifyInstance,
) {
  await writeReview(row, nextReview(current, {
    status: 'filling',
    submission_run_id: runId,
    submission_error: undefined,
  }));
  // No document reaches an account gate. This probe sends no identity, file, answer, consent,
  // CAPTCHA or submit action by design, and a transcript is the last thing that should be the
  // exception: the packet is built here only to validate it before Chrome is offered the handoff.
  const packet = omitTranscript(omitCoverLetter(await buildPacket(row, packetUsesControlledResumeFixture(portal))));
  const applicationUrl = portalApplicationUrl(portal, current.portal_url!);
  const result = await runManagedBrowserWithAccountFence(
    row.user_id,
    applicationUrl,
    buildManagedAttendedAccountProbeActions(portal),
    { screenshot: false },
  );
  const hold = managedAttendedAccountHold(portal, current.portal_url!, result);
  const attentionReason = hold?.reason
    ?? 'Litos could not verify the exact account gate for this application, so it did not enter any information or send anything. Open the saved company page in Chrome to continue.';
  const attentionCategories = hold?.categories ?? ['form_not_reached' as const];
  const extensionHandoffUrl = hold ? canonicalSupportedPortalUrl(result.url, portal) : undefined;
  const extensionHandoffBinding = extensionHandoffUrl
    ? createDashboardHandoffBinding({
      applicationId: row.id,
      userId: row.user_id,
      frozenUrl: current.portal_url,
      frozenHandoffUrl: extensionHandoffUrl,
      frozenAtsName: current.ats_name,
      attentionReason,
      attentionCategories,
    })
    : undefined;
  const review = nextReview(current, {
    status: 'needs_attention',
    submission_run_id: runId,
    filled_fields: [],
    extension_handoff_url: extensionHandoffUrl,
    extension_handoff_binding: extensionHandoffBinding,
    ...(packet.applicantEmail ? { applicant_email: packet.applicantEmail } : {}),
    ...(packet.applicantSnapshot ? { applicant_snapshot: packet.applicantSnapshot } : {}),
    verification: { status: hold?.kind === 'security_code' ? 'handoff' : 'not_needed' },
    attention_reason: attentionReason,
    attention_categories: attentionCategories,
    ...(hold?.captchaProvider
      ? beginStall(current, {
        surface: 'server_run',
        provider: hold.captchaProvider,
        stage: 'before_fill',
        source: 'observed',
      })
      : {}),
    submission_error: undefined,
  });
  await writeReview(row, review);
  fastify.log.info({
    applicationId: row.id,
    portal,
    gate: hold?.kind ?? 'unverified',
    applicantEmailSource: packet.applicantEmail?.source,
  }, 'Application held at an attended account gate without operating it');
}

/* THE QUESTIONS EVERY PACKET VERIFIER MUST HASH, resolved once, the same way everywhere.
 *
 * There are four places a stored packet is compared against its audit: the audit route (which
 * creates and acknowledges it), the submit-request gate, prepare(), and submit(). The first two
 * have always hashed the RESOLVED reading - refreshKnownQuestionAnswers over the applicant's
 * profile and the application's full resolution context - because that is the packet the fill
 * actually types (see the #649 fix and the audit route's own comment). prepare() and submit()
 * hashed the RAW stored rows instead.
 *
 * That skew is a deadlock, not a corner. The fill run's merge writes the raw merged set back to
 * the row, so the moment any resolver answers a question the merge minted blank - R-096 mints
 * availability and self-declaration offers answerless on purpose - the stored rows and the
 * audited rows hash differently by construction: the audit binds the resolved reading, the run
 * re-mints the blank one, and submit() then refuses the very packet the applicant just audited
 * and acknowledged as packet_stale. Measured live on the Easy Dynamics Rippling packet
 * (2026-08-20, application 165c42fb): four consecutive audit-acknowledge-send rounds, four
 * packet_stale refusals, questionsSha256 the only differing binding each time.
 *
 * Same loader, same context builder, same country reads as the audit route, deliberately: the
 * constructor and the verifier must be looking at one packet, and this helper is the one place
 * that says what that packet's questions are. */
export function normalizedPacketAuditQuestions(review: ApplicationReviewState) {
  if (!review.portal_url) return review.questions;
  const portal = detectPortal(review.portal_url);
  return normalizeStoredPortalQuestions(review.questions, portal);
}

export function resolvePacketAuditQuestionFixpoint(
  review: ApplicationReviewState,
  profile: ApplicationProfileLike,
  questionContext: string,
  postingCountry?: JobCountry,
  postingCountryCode?: string,
  asOf: Date = new Date(),
): ApplicationReviewQuestion[] {
  const normalize = (questions: readonly ApplicationReviewQuestion[]) => normalizedPacketAuditQuestions({
    ...review,
    questions: [...questions],
  });
  const packetMayBeWithEmployer = Boolean(review.submission_claimed_at)
    || review.status === 'submitted'
    || review.status === 'awaiting_security_code';
  return packetQuestionFixpoint(
    normalize(review.questions),
    (questions) => {
      const refreshed = refreshKnownQuestionAnswers(
        questions,
        profile,
        questionContext,
        review.questions_reviewed_at,
        postingCountry,
        postingCountryCode,
        asOf,
      );
      return normalize(packetMayBeWithEmployer ? refreshed : reopenUnfitClosedChoiceQuestions(refreshed));
    },
  );
}

export async function resolvedPacketAuditQuestions(row: ResumeRow, review: ApplicationReviewState) {
  const asOf = new Date();
  return resolvePacketAuditQuestionFixpoint(
    review,
    await loadApplicationProfileLike(row.user_id),
    applicationContextForQuestionResolution(row, review),
    postingCountryFromJobContext(row.job_context),
    postingCountryCodeFromJobContext(row.job_context),
    asOf,
  );
}

/* One stable reading everywhere. The former runner-only raw fallback was asymmetric: it could let
 * prepare and submit accept a stored answer after the profile-backed reading had changed, while
 * audit, acknowledgement and submit-request still rejected the same row. Resolving to a true
 * fixpoint before the audit is minted gives every request one identity and preserves fail-closed
 * behavior for any real answer, label, control, profile, document or posting change. */
async function verifiedPacketForRun(
  row: ResumeRow,
  current: ApplicationReviewState,
  verify: typeof currentPacketAudit | typeof currentAcknowledgedPacketAudit,
) {
  const questions = await resolvedPacketAuditQuestions(row, current);
  const verdict = await verify(row, {
    questions,
    restoreExpiredResume: 'authorizing_send',
  });
  return { ...verdict, questions };
}

async function prepare(row: ResumeRow, fastify: FastifyInstance, unattended = false) {
  let current = readApplicationReview(row.spec);
  if (!current) throw new Error('We do not have a link to the company application page');
  current = await repairReviewPortalFromMonitoredJob(row, current);
  if (monitoredPortalProofUnavailable(row, current)) {
    fastify.log.warn(
      { applicationId: row.id, code: 'job_not_available' },
      'Application preparation withheld because its monitored posting proof is unavailable',
    );
    await writeReview(row, nextReview(current, {
      status: 'needs_attention',
      attention_reason: 'This job is no longer available from its verified company source. Nothing was opened or sent.',
      attention_categories: ['evidence_gap'],
      submission_authorization: undefined,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
    }));
    return;
  }
  /* The audit is also where a packet past its retention window gets its file rebuilt, so the row it
     returns can carry a NEW resume_object_key. Everything below reads from that row, never from
     inputRow, or the run assembles a packet from the key the sweep deleted. */
  const packetAudit = await verifiedPacketForRun(row, current, currentPacketAudit);
  if (!packetAudit.valid) {
    fastify.log.warn(
      { applicationId: row.id, code: packetAudit.code },
      'Application preparation withheld because the exact packet audit is missing or stale',
    );
    await writeReview(row, nextReview(current, {
      status: 'needs_attention',
      /* The authored sentence, never the raw verdict. verifyCurrentPacketAudit's reasons are
         developer tokens, and writing one here is how the dashboard printed the bare word
         "packet_stale" on the live Moburst packet on 2026-08-20. packetAuditClientError is the one
         rule for what an applicant may read; the token stays in the log line above. */
      attention_reason: packetAuditClientError(packetAudit).error,
      /* An expired packet is not an evidence gap. It gets the category whose next step is the one
         that works, a regenerate, rather than the bucket that reads as "Litos broke, try again". */
      attention_categories: packetAudit.code === 'PACKET_RESUME_EXPIRED' ? ['packet_expired'] : ['evidence_gap'],
      submission_authorization: undefined,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
    }));
    return;
  }
  row = packetAudit.row;
  const stored = row.spec as StoredSpec;
  const verificationRecipient = readPinnedApplicantEmail(stored)?.address;
  // Re-read: a retention restore rewrote _review with a fresh audit and acknowledgement.
  current = readApplicationReview(stored) ?? current;
  const portalUrl = current.portal_url;
  if (!portalUrl) throw new Error('We do not have a link to the company application page');
  const portal = detectPortal(portalUrl);
  const runId = current.submission_run_id ?? randomUUID();

  /* THE GRADUATION BLOCK, and it stops the unattended run before anything is spent or sent.
   *
   * Only on the UNATTENDED path. A student who clicks Prepare on a role has looked at it and
   * chosen it, and this gate is arithmetic over a parsed title - it is not entitled to overrule a
   * person about their own application. Autopilot has made no such choice, so it gets the strict
   * reading: an application auto-sent to an internship the student cannot legally hold spends a
   * real application slot and a real employer relationship on their behalf, and they never
   * decided to.
   *
   * Placed above prepareControlled and above the account-walled stop for the same reason those
   * sit where they do: a gate that only covers the submit path is not a gate, because prepare
   * runs first, independently, and costs billed browser calls of its own. */
  if (unattended) {
    /* StoredSpec is Record<string, unknown> - the packet spec is not typed at this layer - so the
       two fields are read defensively. A spec missing either one yields `unknown` from decide(),
       which never blocks, and that is the right default for a record we cannot read. */
    const role = typeof (stored.job_context as { role?: unknown } | undefined)?.role === 'string'
      ? ((stored.job_context as { role?: string }).role as string)
      : '';
    const gradDate = typeof stored.grad_date === 'string' ? stored.grad_date : null;
    const gate = decide({ title: role, employment_type: null }, gradDate);
    if (isBlocked(gate)) {
      fastify.log.warn(
        { userId: row.user_id, resumeId: row.id, role, reason: gate.reason },
        'autopilot blocked: graduation',
      );
      await writeReview(row, nextReview(current, {
        status: 'needs_attention',
        submission_run_id: runId,
        /* Named plainly, because this one is worth reading. The student is being told a fact about
           themselves and this role, not that something went wrong. */
        attention_reason: `Not sent: this role ${gate.reason}. Autopilot does not apply to roles you are not eligible for.`,
      }));
      return;
    }
  }

  const authorization = await standingAuthorization(row.user_id);
  assertControlledPortalEnabled(portal);
  if (String(packetAudit.audit.bindings.employerDelivery?.mode) === 'ats_api') {
    throw new Error('ATS API delivery is withheld until Litos can verify and send one prebuilt request object');
  }
  if (shouldUseLocalControlledBrowser(portal)) {
    await prepareControlled(row, current, runId, authorization, fastify, packetAudit.audit, packetAudit.questions);
    return;
  }
  if (isManagedStratusProvider() && isManagedAttendedAccountPortal(portal)
    && managedAttendedAccountUrlIsSupported(portal, current.portal_url!)) {
    await prepareManagedAttendedAccountGate(row, current, portal, runId, fastify);
    return;
  }
  // Account-walled portals stop HERE, before any browser opens, and this is a second instance of
  // the 2026-07-28 review finding rather than a new idea: a gate that only covers the submit path
  // is not a gate. portalCanAutoSubmit is already checked at submit time, but prepare runs FIRST
  // and independently, and for these four it would:
  //   1. spend two managed-browser calls (they are billed) discovering and filling a page that has
  //      no application fields on it at all, then
  //   2. capture a preview screenshot of a data-consent page, a login form or an
  //      "enter the code we emailed you" screen, and
  //   3. present that screenshot to the student as the filled application she is approving to send.
  // She would approve a login page, and only at submit time learn nothing was ever filled. Better
  // to say so now, before spending anything, in the words that name her actual next step.
  //
  // The same stop applies to the multi-step and CAPTCHA-gated families once standing consent is on,
  // for the same reason one step further down the funnel: see autoRunShouldPrepare.
  //
  // The grant-conditional families (teamtailor, pinpoint) are the one per-account exception: an
  // account whose standing consent-acceptance permission is live CAN be carried through submit on
  // the managed path, so an unattended prepare for it is not wasted spend. Loaded only for those
  // families, and only on the managed provider - the direct-Playwright path builds no consent tick,
  // so widening its prepare would buy exactly the parked spend this gate exists to avoid.
  const prepareConsentGrant = isManagedStratusProvider() && isConsentGrantConditionalFamily(portal)
    ? await loadUnattendedConsentGrant(row.user_id)
    : null;
  if (
    isAccountWalledFamily(portal)
    || !autoRunShouldPrepare({
      canAutoSubmit: portalCanAutoSubmitWithConsentGrant(portal, prepareConsentGrant),
      unattended,
    })
  ) {
    await writeReview(row, nextReview(current, {
      status: 'needs_attention',
      submission_run_id: runId,
      // Nothing was filled on this path, so the wording has to be the one that does not claim it was.
      attention_reason: unattendedHandoffReason(portal) ?? undefined,
      // Only the CAPTCHA-gated families produce a stall. This branch also catches multi-step and
      // account-walled portals, and those are waiting on something else entirely - typing them as
      // human_verification would put "prove you are human" rows in the queue for a wizard that just
      // needs its last page answered.
      ...(isCaptchaGatedFamily(portal)
        ? beginStall(current, {
          surface: 'server_run',
          provider: captchaProviderForFamily(portal),
          stage: 'before_fill',
          source: 'assumed',
        })
        : {}),
      submission_error: undefined,
    }));
    return;
  }
  if (isManagedStratusProvider()) {
    await prepareManaged(
      row,
      current,
      portal,
      runId,
      fastify,
      authorization,
      packetAudit.audit,
      packetAudit.questions,
      packetAudit.pdfBytes,
    );
    return;
  }
  const initialDirectPacket = packetForEmployerDelivery(
    await buildPacket(
      row,
      packetUsesControlledResumeFixture(portal),
      packetAudit.questions,
      false,
      packetAudit.pdfBytes,
    ),
    current,
    'browser',
  );
  assertVerifiedBuiltPacket(
    initialDirectPacket,
    packetAudit.audit,
    packetAudit.questions,
    'browser',
    employerDeliveryEnvelope({
      channel: browserEmployerDeliveryChannel(browserDeliveryRuntimeIdentity().provider),
      destinationUrl: portalApplicationUrl(portal, current.portal_url!),
      portalFamily: portal,
      runtime: browserDeliveryRuntimeIdentity(),
      coverLetterSupported: current.cover_letter_supported,
      transcriptSupported: current.transcript_supported,
    }),
  );
  const directProvider = browserDeliveryRuntimeIdentity().provider;
  if (directProvider === 'stratus-managed') throw new Error('Managed provider reached direct session creation');
  const session = await createFencedBrowserSession({
    userId: row.user_id,
    provider: directProvider,
    portalUrl,
  });
  {
    const verificationRequestedAt = new Date();
    const connected = await connectToSession(session);
    const page = connected.page;
    await writeReview(row, nextReview(current, {
      status: 'filling',
      submission_run_id: runId,
      browser_context_id: undefined,
      browser_session_id: session.id,
      submission_error: undefined,
    }));
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // SmartRecruiters follows its captured link. Workable canonicalizes to /apply and clears its
    // optional-cookie overlay. Every other portal is a no-op here.
    await navigateToApplicationForm(page, portal);
    assertEmployerPageUrl(portalApplicationUrl(portal, current.portal_url!), page.url());
    const [verificationSettings] = await db.select({ enabled: users.automatic_verification_enabled })
      .from(users).where(eq(users.id, row.user_id)).limit(1);
    const verificationRoute = await resolveVerificationEmailRoute({
      userId: row.user_id,
      applicationId: row.id,
      expectedRecipient: verificationRecipient,
    });
    const verificationAllowed = verificationRoute === 'application_alias'
      || (verificationRoute === 'personal_address' && verificationSettings?.enabled === true);
    let verification: BrowserVerificationResult = await completeEmailVerificationIfPresent({
      page,
      userId: row.user_id,
      portalUrl,
      requestedAt: verificationRequestedAt,
      permissionGranted: verificationAllowed,
      expectedRecipient: verificationRecipient,
      applicationId: row.id,
    });
    const coverLetterSupported = await hasCoverLetterUpload(page, portal);
    // Discover before generating documents so the cover letter and all unresolved prose fields can
    // share the same call on this provider too. Discovery only reads the page and does not depend
    // on the packet that is built below.
    const discoveryFailures: string[] = [];
    const discovered = await discoverPageQuestions(page).catch((error: unknown) => {
      const message = describeDiscoveryFailure(error);
      discoveryFailures.push(message);
      fastify.log.error(
        { applicationId: row.id, portal, error: message },
        'Question discovery pass failed, so this run cannot see the questions this form asks',
      );
      return [];
    });
    const storedQuestions = normalizeStoredPortalQuestions(current.questions, portal);
    const resolutionCurrent = { ...current, questions: storedQuestions };
    let compactAnswers: ReadonlyMap<string, string> = new Map();
    let packetRow = row;
    try {
      const context = await coverLetterCandidateContext(row);
      const compactQuestions = compactMaterialQuestions(discovered, resolutionCurrent, portal, context.declaredSkills);
      const includeCoverLetter = coverLetterSupported && !storedCoverLetter(row);
      if (includeCoverLetter || compactQuestions.length > 0) {
        const materials = await generateCompactApplicationMaterials({
          company: jobContextCompany(row) || 'this company',
          role: current.role ?? 'this role',
          jdText: current.jd_text,
          candidateSource: context.source,
          contestedMetrics: context.contested.labels,
          includeCoverLetter,
          questions: compactQuestions,
        });
        fastify.log.info({
          applicationId: row.id,
          model: 'claude-sonnet-5',
          coverLetterRequested: includeCoverLetter,
          answerCount: compactQuestions.length,
          ...materials.usage,
        }, 'Compact generation usage');
        compactAnswers = materials.answers;
        if (includeCoverLetter && materials.coverLetter) {
          try {
            await persistGeneratedCoverLetterBody(row, materials.coverLetter, context);
            const refreshedRows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, row.id)).limit(1);
            if (refreshedRows[0]) packetRow = refreshedRows[0];
          } catch (error) {
            fastify.log.warn({ error, applicationId: row.id }, 'Compact cover letter failed validation, retrying it through the dedicated generator');
          }
        }
      }
    } catch (error) {
      fastify.log.warn({ error, applicationId: row.id }, 'Compact generation failed, using dedicated generators');
    }
    const builtOutcome = await packetForCoverLetterCapability(
      packetRow,
      coverLetterSupported,
      fastify,
      packetUsesControlledResumeFixture(portal),
    );
    // The direct path reads the capability off the live page it already has open, where the managed
    // one has to ask the discovery run. Same question, same field written below, and it has to be
    // asked on both or the transcript row fires on some portals and looks broken on the rest.
    const transcriptSupported = await hasTranscriptUpload(page, portal);
    const transcriptOutcome = packetForTranscriptCapability(builtOutcome.packet, transcriptSupported);
    if (builtOutcome.packet.transcriptUnavailableReason) {
      fastify.log.warn(
        { applicationId: row.id, reason: builtOutcome.packet.transcriptUnavailableReason },
        'Attached transcript could not be loaded, continuing without it',
      );
    }
    const packet = transcriptOutcome.packet;
    const coverLetterAttention = builtOutcome.coverLetterIssue ? [builtOutcome.coverLetterIssue] : [];
    // See the managed path's transcriptAttention: this holds back a send that nothing else refuses.
    const transcriptAttention = transcriptOutcome.transcriptIssue ? [transcriptOutcome.transcriptIssue] : [];

    // R-055: resolve the posting's custom questions before filling, using the discovery above.
    const {
      questions: discoveredQuestions,
      attentionReasons: discoveryAttention,
      invalidatedQuestionKeys,
      questionMetadataBlockers,
    } =
      await discoverAndResolveQuestions(
        discovered,
        builtOutcome.row,
        resolutionCurrent,
        applicationProfileForPacket(await loadApplicationProfileLike(row.user_id), packet),
        authorization.enabled,
        portal,
        await loadSavedAnswers(row.user_id),
        compactAnswers,
      );
    const discoveryMetadataMeasurementComplete = questionMetadataMeasurementIsComplete({
      discoveryFailed: discoveryFailures.length > 0,
      discoveredQuestionCount: discovered.length,
    });
    if (discoveryMetadataMeasurementComplete) {
      await persistQuestionMetadataMeasurement(row, runId, questionMetadataBlockers);
    }
    const mergedQuestions = mergeDiscoveredPortalQuestions(
      discoveredQuestions,
      storedQuestions,
      invalidatedQuestionKeys,
      new Set(),
      current.questions_reviewed_at,
    );
    /* The LAST thing that touches packet.questions before the fill on the next line, and it dropped
     * answer_source, which made applicantChoseAnswer false for every question here. See
     * packetQuestionsForFill for the measurement and for the three merged fixes it left inert. */
    packet.questions = packetQuestionsForFill(mergedQuestions);

    const directPrepareEnvelope = employerDeliveryEnvelope({
      channel: browserEmployerDeliveryChannel(browserDeliveryRuntimeIdentity().provider),
      destinationUrl: portalApplicationUrl(portal, current.portal_url!),
      portalFamily: portal,
      runtime: browserDeliveryRuntimeIdentity(),
      coverLetterSupported,
      transcriptSupported,
    });
    if (await holdPreparationForPacketDrift({
      row,
      current,
      packet,
      audit: packetAudit.audit,
      verifiedQuestions: packetAudit.questions,
      mode: 'browser',
      envelope: directPrepareEnvelope,
      log: fastify.log,
      patch: {
        submission_run_id: runId,
        browser_context_id: undefined,
        browser_session_id: session.id,
        questions: mergedQuestions,
        ...(discoveryMetadataMeasurementComplete ? { question_metadata_blockers: questionMetadataBlockers } : {}),
        cover_letter_supported: coverLetterSupported,
        transcript_supported: transcriptSupported,
        ...(packet.applicantEmail ? { applicant_email: packet.applicantEmail } : {}),
        ...(packet.applicantSnapshot ? { applicant_snapshot: packet.applicantSnapshot } : {}),
      },
    })) return;

    let result = await fillPortal(page, portal, packet);
    const postFillVerification = await completeEmailVerificationIfPresent({
      page,
      userId: row.user_id,
      portalUrl,
      requestedAt: verificationRequestedAt,
      permissionGranted: verificationAllowed,
      expectedRecipient: verificationRecipient,
      applicationId: row.id,
    });
    if (postFillVerification.status !== 'not_needed') verification = postFillVerification;
    // Re-scan only after a successful verification so an empty OTP field reported during the
    // first pass cannot remain as a stale blocker. This does not click the final submit control.
    if (postFillVerification.status === 'completed') result = await fillPortal(page, portal, packet);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const preview = await storeFilledPreviewScreenshot(
      `users/${row.user_id}/submission-runs/${runId}/filled.png`,
      screenshot,
    );
    const sanitizedBlockers = sanitizeProviderBlockers(result.blockers);
    const pageText = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
    const questionMetadataMeasurementComplete = questionMetadataMeasurementIsComplete({
      discoveryFailed: discoveryFailures.length > 0,
      filledFields: result.filledFields,
      providerBlockers: result.blockers,
      discoveredQuestionCount: discovered.length,
      text: pageText,
      email: packet.email,
    });
    // Same reach evidence as the managed path: the live-page question scan and the portal's own
    // required-field blockers both prove the form was in front of us, which is what separates
    // "reached it and left fields empty" from "never reached it".
    const evidenceBlockers = preparationEvidenceBlockers({
      text: pageText,
      filledFields: result.filledFields,
      blockers: result.blockers,
      discovered,
    }, packet);
    /* THE MEASUREMENT THIS PATH NEVER TOOK, AND THE REASON THE PROSE STILL DOES NOT USE IT.
     *
     * prepareManaged compares the portal's required-and-empty blockers against the question list
     * and writes down which required fields the applicant was given nowhere to answer. This path
     * did not compute it at all: the second argument to discoveryHonestyReasons below was a
     * hard-coded empty array, and no other line here made the comparison either. So a required
     * transcript on a Greenhouse posting produced a structured ask on the managed runner and
     * nothing whatsoever on the direct one, on the same form. A dashboard row keyed on that field
     * would have fired on some portals and looked broken on the rest, which is indistinguishable
     * from the feature being broken.
     *
     * The labels are now measured here too, for required_documents on the patch below.
     *
     * They are deliberately NOT passed to discoveryHonestyReasons. That function renders prose into
     * attention_reason, and turning it on here would add a sentence to every direct-path packet
     * carrying an unanswerable required field - a user-visible change to what stopped runs say,
     * on a path whose send decision (`safe`, below) does not read this count at all. Two different
     * changes, and only one of them was asked for. Whoever takes the second should note that the
     * two paths would then agree, which is an argument for it rather than against.
     */
    const unansweredRequired = unansweredRequiredBlockerLabels(sanitizedBlockers, mergedQuestions);
    const requiredDocuments = measuredRequiredDocuments(unansweredRequired, mergedQuestions);
    // What the scan owes her when it did not run. See the note directly above for why the second
    // argument stays empty now that the measurement exists.
    const honestyReasons = discoveryHonestyReasons(discoveryFailures[0], []);
    /* Same reasoning as the managed path above: the required-answer check moved off the run and on
     * to the send, and this is the direct-Playwright path's send decision.
     *
     * Counted as `discoveryFailures.length`, NOT `honestyReasons.length`. The two are equal today
     * and it would be tempting to use the array that is already built, but discoveryHonestyReasons
     * renders PROSE and drops a falsy message: `new Error()` carries `message === ''`, so a scan
     * that threw one would produce no sentence, contribute nothing to this count, and leave `safe`
     * true. That is the bug this whole change exists to remove, reintroduced through the back door
     * of the presentation layer. The send decision reads the failure itself; the applicant-facing
     * text is downstream of it and cannot weaken it. */
    const safe = directPreparationIsSafe({
      blockerCount: sanitizedBlockers.length + evidenceBlockers.length,
      // coverLetterAttention counts here for the same reason it gates `safe` on the managed path:
      // on a form with a cover-letter control, a packet with no cover letter recorded is one that
      // /submission/approve will refuse with 422, so calling it ready is a promise the send cannot
      // keep. Folded into attentionCount rather than blockerCount because it is our failure to
      // report, not a field the employer's page left empty.
      //
      // discoveryFailures is a separate and independent reason to hold the same send: the first
      // says the packet is missing something we owed it, the second says we never read the form
      // well enough to know what it owed. Either alone is enough; they are summed, not chosen
      // between, so a run carrying both is not counted as carrying one.
      //
      // transcriptAttention is the third, and the only one no server refusal backs up: nothing
      // rejects a packet for a missing transcript, so standing consent would simply send it.
      attentionCount: discoveryAttention.length + coverLetterAttention.length + discoveryFailures.length + transcriptAttention.length,
      unansweredRequiredCount: blankRequiredQuestionLabels(mergedQuestions).length,
      verificationStatus: verification.status,
    });
    const review = nextReview(current, {
      ...preparedReviewPatch(authorization, safe),
      submission_run_id: runId,
      browser_context_id: undefined,
      browser_session_id: session.id,
      filled_fields: result.filledFields,
      /* Same field, same shape, same always-written array as the managed path. Writing it on both
       * is the whole of G5: measured on one runner only, the dashboard row fires on some portals
       * and is silently absent on the rest. See ApplicationReviewState.required_documents. */
      required_documents: requiredDocuments,
      // Which address this form was filled with, and why. See ApplicationReviewState.applicant_email.
      ...(packet.applicantEmail ? { applicant_email: packet.applicantEmail } : {}),
      preview_screenshot_url: preview.url,
      verification: {
        status: verification.status,
        provider: verification.provider,
        completed_at: verification.status === 'completed' ? new Date().toISOString() : undefined,
      },
      questions: mergedQuestions,
      ...(questionMetadataMeasurementComplete ? { question_metadata_blockers: questionMetadataBlockers } : {}),
      cover_letter_supported: coverLetterSupported,
      // Same measurement as the managed path, off this path's own required-field scan. See
      // ApplicationReviewState.cover_letter_required.
      ...(coverLetterSupported
        ? { cover_letter_required: blockersRequireCoverLetter(sanitizedBlockers) }
        : {}),
      cover_letter_attached: Boolean(packet.coverLetter),
      // Written here for the same reason it is written on the managed patch: the submit run reads
      // this flag instead of probing, so a prepare that measured the capability and did not record
      // it sends an application missing a document the preview showed attached.
      transcript_supported: transcriptSupported,
      // Already human on this path, but the BLOCKERS are sanitized anyway so both providers are
      // held to one guarantee and a future change to either cannot quietly reintroduce identifiers.
      // The other two arrays do not go through the sanitizer and do not need to: they are written
      // here, in this repo, in the product's own voice, and neither one interpolates provider or
      // model text. Sending them through it would not have caught the cover-letter leak either,
      // since that message was prose and prose passes straight through.
      // The two document sentences sit together, and honestyReasons stays immediately after the
      // cover letter's, because a test pins that pair by its exact text: the scan-failed admission
      // being present at all is what the swallow fix bought.
      attention_reason:
        [...sanitizedBlockers, ...discoveryAttention, ...evidenceBlockers, ...transcriptAttention, ...coverLetterAttention, ...honestyReasons]
          .join('\n') || undefined,
      // The only path that OBSERVES a challenge on a board nobody had typed as gated, which makes it
      // the one that matters most. Without it the stall is written only for JazzHR and BambooHR,
      // families already known to gate, so the instrumentation could confirm what was already
      // assumed and could never discover anything new. Provider is read off the live page here, so
      // it is 'observed'.
      ...(blockersIncludeCaptcha(sanitizedBlockers)
        ? beginStall(current, {
          surface: 'server_run',
          provider: await detectCaptchaProvider(page),
          stage: 'at_submit',
          source: 'observed',
        })
        : {}),
      handoff_expires_at: new Date(Date.now() + HANDOFF_WINDOW_MS).toISOString(),
      submission_error: undefined,
    });
    await writeReview(row, review);
    /* Both prepare paths, for the reason both of them write required_documents: measured on one
       runner only, the promise is kept on some portals and quietly broken on the rest. */
    await reuseStoredDocuments(row, review, fastify);
    fastify.log.info({ applicationId: row.id, portal, status: review.status }, 'Application portal prepared');
  }
}

function controlledChromeExecutable(): string {
  return process.env.LITOS_TEST_BROWSER_EXECUTABLE
    ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
}

export function shouldUseLocalControlledBrowser(portal: SupportedPortal): boolean {
  return portal === 'controlled_test' && !isManagedStratusProvider();
}

function assertControlledPortalEnabled(portal: SupportedPortal): void {
  if (portal === 'controlled_test' && process.env.LITOS_ENABLE_TEST_PORTAL !== 'true') {
    throw new Error('Controlled portal is disabled');
  }
}

async function prepareControlled(
  row: ResumeRow,
  current: ApplicationReviewState,
  runId: string,
  authorization: StandingAuthorization,
  fastify: FastifyInstance,
  audit: PacketAudit,
  verifiedQuestions: readonly ApplicationReviewQuestion[],
) {
  if (process.env.LITOS_ENABLE_TEST_PORTAL !== 'true') throw new Error('Controlled portal is disabled');
  const packet = await buildPacket(row, true, verifiedQuestions);
  assertVerifiedBuiltPacket(
    packet,
    audit,
    verifiedQuestions,
    'full',
    employerDeliveryEnvelope({
      channel: 'controlled_browser',
      destinationUrl: current.portal_url!,
      portalFamily: 'controlled_test',
      runtime: { provider: 'local_playwright', executable: controlledChromeExecutable() },
      coverLetterSupported: current.cover_letter_supported,
      transcriptSupported: current.transcript_supported,
    }),
  );
  const browser = await chromium.launch({ executablePath: controlledChromeExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(current.portal_url!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assertEmployerPageUrl(current.portal_url!, page.url());
    const result = await fillPortal(page, 'controlled_test', packet);
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const pageText = await page.locator('body').innerText({ timeout: 1_000 }).catch(() => '');
    const evidenceBlockers = preparationEvidenceBlockers({
      text: pageText,
      filledFields: result.filledFields,
      blockers: result.blockers,
    }, packet);
    const safe = result.blockers.length === 0 && evidenceBlockers.length === 0;
    const review = nextReview(current, {
      ...preparedReviewPatch(authorization, safe),
      submission_run_id: runId,
      filled_fields: result.filledFields,
      preview_screenshot_url: `data:image/png;base64,${screenshot.toString('base64')}`,
      verification: { status: 'not_needed' },
      attention_reason: [...result.blockers, ...evidenceBlockers].join('\n') || undefined,
      handoff_expires_at: new Date(Date.now() + HANDOFF_WINDOW_MS).toISOString(),
      submission_error: undefined,
    });
    await writeReview(row, review);
    fastify.log.info({ applicationId: row.id, status: review.status }, 'Controlled application portal prepared');
  } finally {
    await browser.close();
  }
}

async function submitControlled(
  row: ResumeRow,
  review: ApplicationReviewState,
  fastify: FastifyInstance,
  audit: PacketAudit,
  verifiedQuestions: readonly ApplicationReviewQuestion[],
  attemptBinding: SubmissionAttemptBinding,
) {
  if (process.env.LITOS_ENABLE_TEST_PORTAL !== 'true') throw new Error('Controlled portal is disabled');
  const packet = await buildPacket(row, true, verifiedQuestions);
  const envelope = employerDeliveryEnvelope({
    channel: 'controlled_browser',
    destinationUrl: review.portal_url!,
    portalFamily: 'controlled_test',
    runtime: { provider: 'local_playwright', executable: controlledChromeExecutable() },
    coverLetterSupported: review.cover_letter_supported,
    transcriptSupported: review.transcript_supported,
  });
  assertVerifiedBuiltPacket(packet, audit, verifiedQuestions, 'full', envelope);
  const browser = await chromium.launch({ executablePath: controlledChromeExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(review.portal_url!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    assertEmployerPageUrl(review.portal_url!, page.url());
    await transportVerifiedBuiltPacket(packet, audit, verifiedQuestions, async (exactPacket) => {
      await fillPortal(page, 'controlled_test', exactPacket);
      assertEmployerPageUrl(review.portal_url!, page.url());
      await executeAfterFinalSubmissionBoundary(
        () => assertFinalRunnerBoundaryClear(row, review, attemptBinding),
        () => clickFinalSubmit(page),
      );
      await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'controlled-submit', {
        evidenceCode: 'controlled_submit_returned',
      });
    }, 'full', envelope);
    const receipt = await readExactControlledTestPageReceipt(page, review.portal_url!);
    if (!receipt) throw new Error('The controlled portal did not reach its exact terminal route');
    const capturedAt = new Date().toISOString();
    const confirmed = await recordControlledSubmissionConfirmed(row, attemptBinding, {
      capturedAt,
      receiptEvidence: receipt,
    });
    if (!confirmed) return;
    try {
      const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
      await recordControlledSubmissionConfirmed(row, attemptBinding, {
        capturedAt,
        receiptEvidence: receipt,
        screenshotUrl: `data:image/png;base64,${screenshot.toString('base64')}`,
      });
    } catch (error) {
      fastify.log.warn({
        applicationId: row.id,
        detail: error instanceof Error ? error.message.slice(0, 200) : 'Controlled receipt screenshot failed',
      }, 'Controlled confirmation persisted before screenshot enrichment failed');
    }
    fastify.log.info({ applicationId: row.id }, 'Controlled application submission receipt verified');
  } finally {
    await browser.close();
  }
}

const CONTROLLED_RECEIPT_BRAND = Symbol('controlled-receipt-brand');

type ExactControlledTestPageReceipt = {
  confirmationText: typeof CONTROLLED_RECEIPT_TEXT;
  finalUrl: string;
  expectedApplicationUrl: string;
  [CONTROLLED_RECEIPT_BRAND]: true;
};

async function recordControlledSubmissionConfirmed(
  row: ResumeRow,
  attemptBinding: SubmissionAttemptBinding,
  input: {
    capturedAt: string;
    receiptEvidence: ExactControlledTestPageReceipt;
    screenshotUrl?: string;
  },
): Promise<boolean> {
  const frozenApplicationUrl = attemptBinding.postingIdentity.portalUrl;
  if (!frozenApplicationUrl
    || input.receiptEvidence.expectedApplicationUrl !== frozenApplicationUrl
    || input.receiptEvidence[CONTROLLED_RECEIPT_BRAND] !== true
    || input.receiptEvidence.confirmationText !== CONTROLLED_RECEIPT_TEXT
    || !exactControlledTestReceiptRoute(
      frozenApplicationUrl,
      input.receiptEvidence.finalUrl,
    )) return false;
  return commitVerifiedSubmissionConfirmed(row, attemptBinding, {
    capturedAt: input.capturedAt,
    verification: { status: 'not_needed' },
    receipt: {
      confirmation_text: input.receiptEvidence.confirmationText,
      final_url: input.receiptEvidence.finalUrl,
      ...(input.screenshotUrl ? { screenshot_url: input.screenshotUrl } : {}),
      captured_at: input.capturedAt,
      source: 'managed_browser',
    },
    factKey: 'controlled-receipt',
    evidenceCode: 'controlled_receipt_verified',
  });
}

export async function readExactControlledTestPageReceipt(
  page: Pick<Page, 'url' | 'locator'>,
  expectedApplicationUrl: string,
): Promise<ExactControlledTestPageReceipt | null> {
  if (!exactControlledTestReceiptRoute(expectedApplicationUrl, page.url())) return null;
  const forms = page.locator('form');
  const formCount = Math.min(await forms.count().catch(() => 0), 20);
  for (let index = 0; index < formCount; index += 1) {
    if (await forms.nth(index).isVisible().catch(() => false)) return null;
  }
  return {
    confirmationText: CONTROLLED_RECEIPT_TEXT,
    finalUrl: page.url(),
    expectedApplicationUrl,
    [CONTROLLED_RECEIPT_BRAND]: true,
  };
}

async function submitViaAtsSubmissionChannel(
  row: ResumeRow,
  review: ApplicationReviewState,
  fastify: FastifyInstance,
  audit: PacketAudit,
  verifiedQuestions: readonly ApplicationReviewQuestion[],
): Promise<boolean> {
  if (String(audit.bindings.employerDelivery?.mode) !== 'ats_api') return false;
  throw new Error('ATS API delivery is withheld until Litos can verify and send one prebuilt request object');
}

/**
 * HOW LONG THE CHALLENGED PAGE IS HELD OPEN, and how long the mailbox is read for inside it.
 *
 * The window is the runner's continuation TTL, and since the runner started counting it from the
 * moment the challenge appears rather than from the fork, it is a budget for THIS - reading a code
 * and coming back - rather than whatever a hundred-action form fill happened to leave over. 180
 * seconds against a mailbox read that finishes in a few is deliberately generous: the cost of it
 * being too short is a resend, and a resend costs the applicant another email and invalidates the
 * code Litos is holding.
 *
 * The read itself is bounded so the whole submit still fits inside one 300 second invocation, which
 * also has to pay for the CAPTCHA probe, the packet build, the fill run and the continuation. 15
 * passes three seconds apart is about 45 seconds of waiting plus the searches themselves. The
 * measured gap between a Greenhouse send and its code is seconds, not minutes; this is sized for a
 * slow mailbox rather than for a slow reader.
 */
const SECURITY_CODE_CONTINUATION_TTL_SECONDS = 180;
const SECURITY_CODE_MAILBOX_ATTEMPTS = 15;
const SECURITY_CODE_MAILBOX_DELAY_MS = 3_000;

class SubmissionExecutionError extends Error {
  constructor(
    readonly actedOnRow: ResumeRow,
    readonly submissionCause: unknown,
  ) {
    super(submissionCause instanceof Error ? submissionCause.message : 'Submission runner failed');
    this.name = 'SubmissionExecutionError';
  }
}

// `securityCode` is the code the applicant pasted in, and it is a PARAMETER rather than a stored
// field on purpose: it is a live credential to a real employer's form, and the review object it
// would have to live in is unvalidated JSON that is serialized to the dashboard and the extension.
// Only its salted digest is ever written down, and only to make the endpoint idempotent.
//
// IT IS NO LONGER THE CODE THAT GETS TYPED. Greenhouse issues a new code on every send and a code
// control only exists on a page that has just been sent, so a code that arrives from outside a run
// is dead before that run can reach a field to put it in. What it still does is authorize one more
// attempt and, through its fingerprint, stop the same dead code authorizing a second. The code that
// is actually entered is read from the mailbox inside the run, on the page that asked for it.
//
// Threaded through submit() rather than given its own run, so the finishing path inherits every
// guard this one already has: the authorization check, the claim, the daily cap, the portal gates,
// the ATS channel and the CAPTCHA probe. A parallel path would inherit none of them.
async function submit(row: ResumeRow, fastify: FastifyInstance, options: {
  securityCode?: string;
  claimAlreadyHeld?: boolean;
} = {}) {
  const current = readApplicationReview(row.spec);
  if (!current?.submission_run_id || !current.portal_url) throw new Error('The prepared run is missing');
  const writeHeldPreSendStop = async (
    review: ApplicationReviewState,
    factKey: string,
    evidenceCode: string,
  ) => {
    if (!options.claimAlreadyHeld || !current.submission_claim_id) {
      return writeReview(row, review);
    }
    const binding = await persistedRunnerAttemptBinding(row, current);
    return writeReviewWithRunnerNotSentFact(row, review, binding, factKey, {
      proofKind: 'typed_pre_click_stop',
      evidenceCode,
    });
  };
  const packetAudit = await verifiedPacketForRun(row, current, currentAcknowledgedPacketAudit);
  if (!packetAudit.valid) {
    const finishingSecurityCode = Boolean(options.securityCode) && Boolean(current.security_code);
    fastify.log.error(
      { applicationId: row.id, code: packetAudit.code, bindingMismatchKeys: packetAudit.bindingMismatchKeys ?? [] },
      'Submission withheld because the exact packet audit is missing or stale',
    );
    await writeHeldPreSendStop(nextReview(current, {
      status: finishingSecurityCode ? 'awaiting_security_code' : 'needs_attention',
      /* The authored sentence, never the raw verdict token. Same rule and same measured leak as
         the prepare() write above; see packetAuditClientError. */
      attention_reason: finishingSecurityCode
        ? `${securityCodeAttentionReason(current.security_code!)}\n${packetAuditClientError(packetAudit).error}`
        : packetAuditClientError(packetAudit).error,
      attention_categories: packetAudit.code === 'PACKET_RESUME_EXPIRED'
        ? (finishingSecurityCode ? ['security_code', 'packet_expired'] : ['packet_expired'])
        : (finishingSecurityCode ? ['security_code', 'evidence_gap'] : ['evidence_gap']),
      submission_authorization: undefined,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
    }), 'held-packet-audit-stop', 'packet_audit_invalid_before_send');
    return;
  }
  const leadIssues = runnerLeadAlignmentIssues(row);
  if (leadIssues.length > 0) {
    fastify.log.error(
      { applicationId: row.id, issues: leadIssues },
      'Submission withheld at the click: resume lead evidence is stale or unsupported',
    );
    await withholdInvalidLeadAlignment(
      row,
      current,
      leadIssues,
      Boolean(options.securityCode) && Boolean(current.security_code),
      (review) => writeHeldPreSendStop(
        review,
        'held-lead-alignment-stop',
        'lead_alignment_invalid_before_send',
      ),
    );
    return;
  }
  const authorization = await standingAuthorization(row.user_id);
  if (!mayClickFinalSubmit({
    source: current.submission_authorization?.source,
    standingConsentEnabled: authorization.enabled,
  })) {
    if (current.submission_authorization?.source === 'standing_consent') {
      await writeHeldPreSendStop(nextReview(current, {
        status: 'ready_for_final_approval',
        submission_authorization: undefined,
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
      }), 'held-authorization-stop', 'standing_authorization_revoked_before_send');
      return;
    }
    throw new Error('Submission authorization is missing');
  }
  /* THE DUPLICATE GATE, and it is here because here is where three of the five send paths meet.
   *
   * submit() is reached by POST /submission/approve, by standing consent (prepare writes
   * 'submitting' and the cron picks it up, never touching the approve route), and it contains the
   * ATS API channel. The other two are guarded at their own doors: POST /submit-request for the
   * unsupported-portal email fallback, and POST /submission/extension-start for the extension.
   *
   * BEFORE claimSubmission, not after. The claim is the last honest marker of "this one may
   * already be out there" and it is what the daily cap counts; taking one for an application that
   * is about to be refused would spend a cap slot on a send that never happens.
   *
   * A read failure does NOT open the gate. The whole point is that a duplicate cannot be
   * withdrawn, so an unreadable database is a reason to stop rather than a reason to proceed. */
  const duplicate = options.claimAlreadyHeld
    ? { kind: 'clear' as const }
    : await duplicateApplicationVerdict({
      userId: row.user_id,
      applicationId: row.id,
      jobContext: row.job_context,
      portalUrl: current.portal_url,
    });
  if (duplicate.kind !== 'clear') {
    fastify.log.info(
      {
        applicationId: row.id,
        duplicateOf: duplicate.kind === 'duplicate' ? duplicate.match.application_id : duplicate.application_id,
        basis: duplicate.kind === 'duplicate' ? duplicate.match.basis : 'unidentifiable',
      },
      'Submission refused: an earlier application attempt is not safe to repeat',
    );
    /* Refuse, but do not DEMOTE a packet the employer already holds.
     *
     * Same hazard as the blank-required gate below, and it has to be answered the same way or the
     * two drift. A packet finishing a security-code submission has already had its form accepted
     * once and is waiting on the emailed code; needs_attention says nothing was sent, and
     * submitRequestDisposition treats needs_attention as re-runnable, so demoting here would reopen
     * the ordinary submit path on an application that is already with the employer. The refusal
     * itself stands - if another packet for this posting really did go out, this one must not follow
     * it - and both facts are told to the applicant, hers first. */
    const finishingSecurityCode = Boolean(options.securityCode) && Boolean(current.security_code);
    await writeReview(row, nextReview(current, {
      status: finishingSecurityCode ? 'awaiting_security_code' : 'needs_attention',
      attention_reason: finishingSecurityCode
        ? `${securityCodeAttentionReason(current.security_code!)}\n${duplicate.reason}`
        : duplicate.reason,
      attention_categories: finishingSecurityCode
        ? ['security_code', duplicate.kind === 'duplicate' && duplicate.match.certainty === 'submitted'
          ? 'duplicate_application' : 'unverified_submission']
        : [duplicate.kind === 'duplicate' && duplicate.match.certainty === 'submitted'
          ? 'duplicate_application' : 'unverified_submission'],
      submission_authorization: undefined,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
    }));
    return;
  }
  /* Adopted here, not earlier: a retention restore inside the audit gives the packet a new
     resume_object_key, and claimSubmission and everything after it must work from that row. */
  row = packetAudit.row;
  const claimedRow = await claimSubmission(row, options.claimAlreadyHeld);
  if (!claimedRow) return;
  row = claimedRow;
  try {
    let claimedReview = readApplicationReview(row.spec);
    if (!claimedReview) return;
    const attemptBinding = await persistedRunnerAttemptBinding(row, claimedReview);
  /* THE LAST PLACE THIS CAN BE ASKED, and the only one that covers every path to 'submitted'.
   *
   * blankRequiredQuestionLabels already gates the two PREPARE decisions and the approve route, and
   * between them those cover standing consent and the applicant pressing send. They do not cover
   * everything that gets here:
   *
   *   - the ATS API channel prepares with `safe` as a LITERAL true (see the atsAssessment branch in
   *     prepare): no browser, no blockers, no question list consulted, straight to
   *     ready_for_final_approval or to 'submitting'. submitViaAtsSubmissionChannel below then posts
   *     the application to the employer's API. Nothing on that path had ever read the questions;
   *   - the controlled-browser path, which returns before either provider block;
   *   - and any packet whose stored questions changed between the prepare that judged it and this
   *     click. The approve route re-reads them, the standing-consent path does not.
   *
   * Below claimSubmission so it reads the review as it stands at the moment of the click, and above
   * every send so it gates the decision rather than one implementation of it.
   *
   * needs_attention, not a throw: nothing has been sent, the applicant can answer the question and
   * run it again, and 'failed' would say the opposite of what happened. The claim is released for
   * the same reason - the packet is waiting on her, not in flight.
   */
  const questionGate = submissionQuestionGate(claimedReview);
  if (questionGate.metadataBlockerCount > 0) {
    const metadataSentence = `${questionGate.metadataBlockerCount} employer question `
      + `${questionGate.metadataBlockerCount === 1 ? 'control has' : 'controls have'} incomplete metadata. `
      + 'Litos did not expose or use a send capability.';
    await writeReviewWithRunnerNotSentFact(row, nextReview(claimedReview, {
      status: 'needs_attention',
      attention_reason: metadataSentence,
      attention_categories: ['evidence_gap'],
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
    }), attemptBinding, 'question-metadata-withheld', {
      proofKind: 'typed_pre_click_stop',
      evidenceCode: 'question_metadata_incomplete',
    });
    return;
  }
  const unansweredRequired = questionGate.requiredQuestionLabels;
  if (unansweredRequired.length > 0) {
    fastify.log.error(
      { applicationId: row.id, fields: unansweredRequired },
      'Submission withheld at the click: required questions are still unanswered',
    );
    /* THE ONE PACKET THIS GATE MUST NOT DEMOTE.
     *
     * A packet finishing a security-code submission has ALREADY reached the employer: the form went
     * in, the employer emailed a code, and this call exists to send it back. needs_attention says
     * the opposite of all three - "this was not sent" is false, and submitRequestDisposition treats
     * needs_attention as re-runnable, so demoting here would reopen the ordinary submit path on an
     * application an employer already holds. That is the exact failure the awaiting_security_code
     * status was introduced to close.
     *
     * The refusal itself is right and stands: refilling a form with a blank required answer sends a
     * worse application than the one already in, and the runner's own pre-submit gate would withhold
     * the click anyway. Only the state it lands in changes. Keyed on options.securityCode rather
     * than on the status, because finishSecurityCodeSubmission has already moved the packet to
     * 'submitting' by the time it gets here - the request is the only thing that still knows.
     *
     * The security-code sentence LEADS, for the same reason it leads in prepareManaged: it is the
     * only line that says an application has already gone to the employer. */
    const finishingSecurityCode = Boolean(options.securityCode) && Boolean(claimedReview.security_code);
    const requiredSentence = `${unansweredRequired.length} required `
      + `${unansweredRequired.length === 1 ? 'question is' : 'questions are'} still unanswered, so this was not sent: `
      + `${unansweredRequired.map((label) => `"${label.slice(0, 60)}"`).join(', ').slice(0, 400)}`;
    await writeReviewWithRunnerNotSentFact(row, nextReview(claimedReview, {
      status: finishingSecurityCode ? 'awaiting_security_code' : 'needs_attention',
      attention_reason: finishingSecurityCode
        ? `${securityCodeAttentionReason(claimedReview.security_code!)}\n${unansweredRequired.length} required `
          + `${unansweredRequired.length === 1 ? 'question is' : 'questions are'} still unanswered on the form, `
          + `so Litos did not send it again: `
          + `${unansweredRequired.map((label) => `"${label.slice(0, 60)}"`).join(', ').slice(0, 400)}`
        : requiredSentence,
      ...(finishingSecurityCode ? { attention_categories: ['security_code' as const] } : {}),
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
    }), attemptBinding, 'required-questions-withheld', {
      proofKind: 'typed_pre_click_stop',
      evidenceCode: 'required_questions_unanswered',
    });
    return;
  }
  const undecidedOptional = questionGate.optionalQuestionLabels;
  if (undecidedOptional.length > 0) {
    const optionalSentence = `${undecidedOptional.length} optional `
      + `${undecidedOptional.length === 1 ? 'question needs' : 'questions need'} an Answer or Skip choice before Litos can send this application: `
      + `${undecidedOptional.map((label) => `"${label.slice(0, 60)}"`).join(', ').slice(0, 400)}`;
    await writeReviewWithRunnerNotSentFact(row, nextReview(claimedReview, {
      status: 'needs_attention',
      attention_reason: optionalSentence,
      attention_categories: ['required_field'],
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
    }), attemptBinding, 'optional-questions-withheld', {
      proofKind: 'typed_pre_click_stop',
      evidenceCode: 'optional_questions_undecided',
    });
    return;
  }
  const claimedPortal = detectPortal(claimedReview.portal_url!);
  assertControlledPortalEnabled(claimedPortal);
  if (shouldUseLocalControlledBrowser(claimedPortal)) {
    await submitControlled(row, claimedReview, fastify, packetAudit.audit, packetAudit.questions, attemptBinding);
    return;
  }
  if (await submitViaAtsSubmissionChannel(
    row,
    claimedReview,
    fastify,
    packetAudit.audit,
    packetAudit.questions,
  )) return;
  // Portals that cannot be submitted in one run stop HERE, before either provider path.
  //
  // This gate used to live only inside buildManagedPortalActions, which was wrong in two ways that
  // a review caught before it shipped. Removing the click from the managed action list does not stop
  // the code below from accepting a receipt and writing status:'submitted' - so a JazzHR or
  // Paylocity run that clicked nothing could still be recorded as submitted the moment the page text
  // happened to contain "success". And it did nothing at all for the direct-Playwright path, which
  // calls clickFinalSubmit(page) unconditionally: on JazzHR that presses submit behind an unsolved
  // reCAPTCHA, and on Paylocity it presses a control halfway through a four-page wizard.
  //
  // Gating at the call site is the only place that covers both providers and the status write.
  {
    const portal = claimedPortal;
    /* The per-account exception to the family ceiling: a grant-conditional family (teamtailor,
     * pinpoint) whose account holds a live standing consent-acceptance permission may proceed to
     * the managed submit path, where buildManagedPortalActions builds the guarded consent tick and
     * the submit press together or neither. Managed provider only: the direct-Playwright path
     * builds no tick, and letting it through here would press submit around an unticked required
     * consent. Everything else keeps portalCanAutoSubmit's answer byte for byte. */
    const submitConsentGrant = isManagedStratusProvider() && isConsentGrantConditionalFamily(portal)
      ? await loadUnattendedConsentGrant(row.user_id)
      : null;
    if (!portalCanAutoSubmitWithConsentGrant(portal, submitConsentGrant)) {
      await writeReviewWithRunnerNotSentFact(row, nextReview(claimedReview, {
        status: 'needs_attention',
        attention_reason: portalHandoffReason(portal) ?? undefined,
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
        // Same family test as the unattended branch above, different stage: this path DID fill the
        // form, so the applicant is finishing a filled application rather than starting a blank one.
        ...(isCaptchaGatedFamily(portal)
          ? beginStall(claimedReview, {
            surface: 'server_run',
            provider: captchaProviderForFamily(portal),
            stage: 'at_submit',
            source: 'assumed',
          })
          : {}),
      }), attemptBinding, 'portal-handoff', {
        proofKind: 'typed_pre_click_stop',
        evidenceCode: 'portal_requires_attended_handoff',
      });
      return;
    }
  }
  if (isManagedStratusProvider()) {
    const portal = claimedPortal;
    if (!await authorizationValidAtClick(row, claimedReview)) {
      await holdRevokedSubmission(
        row,
        claimedReview,
        attemptBinding,
        'authorization-revoked-before-managed',
        'authorization_revoked_before_managed_submit',
      );
      return;
    }
    const applicationUrl = portalApplicationUrl(portal, claimedReview.portal_url!);
    const builtPacket = await buildPacket(
      row,
      packetUsesControlledResumeFixture(portal),
      packetAudit.questions,
      false,
      packetAudit.pdfBytes,
    );
    const packet = packetForEmployerDelivery(builtPacket, claimedReview, 'browser');
    const envelope = employerDeliveryEnvelope({
      channel: browserEmployerDeliveryChannel(browserDeliveryRuntimeIdentity().provider),
      destinationUrl: applicationUrl,
      portalFamily: portal,
      runtime: browserDeliveryRuntimeIdentity(),
      coverLetterSupported: claimedReview.cover_letter_supported,
      transcriptSupported: claimedReview.transcript_supported,
    });
    assertVerifiedBuiltPacket(packet, packetAudit.audit, packetAudit.questions, 'browser', envelope);
    // There is no Playwright Page on this path - the actions run inside the remote runner - so
    // neither fillPortal's blocker check nor clickFinalSubmit's guard executes here, and the code
    // below writes status:'submitted' on a receipt screenshot. Without this probe, portalCanAutoSubmit
    // would be the only CAPTCHA protection: fine for JazzHR and BambooHR, useless for a Greenhouse or
    // Lever board whose employer switched a challenge on last week.
    //
    // A separate call, because /api/run is stateless and runs the whole list before returning: a
    // check inside the submit list cannot stop the click it exists to gate. Deliberately placed
    // ABOVE buildPacket so a stopped application pays for neither the packet nor the fill run, and
    // asks for no screenshot, so it transfers one attribute rather than a full-page PNG.
    //
    // Costs one extra remote session and page load per managed submission. That is the price of the
    // statelessness, and it is worth naming: the challenge state is read from a DIFFERENT page load
    // than the one that submits.
    const captchaProbe = await runManagedBrowserWithAccountFence(
      row.user_id,
      applicationUrl,
      buildManagedCaptchaProbeActions(),
      { screenshot: false },
    )
      // A probe that cannot run must not take down a submission that would otherwise succeed. It
      // fails open to the pre-probe behaviour, same as managedResultRequiresCaptchaAttention does.
      // Only the message is logged, bounded: the runner's error string is remote-controlled and
      // Playwright-shaped failures embed page markup.
      .catch((error: unknown) => {
        const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
        fastify.log.warn({ applicationId: row.id, detail }, 'CAPTCHA probe failed, continuing unprobed');
        return null;
      });
    if (!captchaProbe) throw new Error('The employer destination could not be verified before submission');
    assertEmployerPageUrl(applicationUrl, captchaProbe.url);
    // ONE check, named once. This used to read
    //   managedResultRequiresCaptchaAttention(probe) && managedCaptchaVerdictIsCorroborated(portal, probe)
    // and presented itself as probe-plus-corroboration. It was not. Both terms call
    // readManagedCaptchaEvidence on the same probe result and short-circuit on the same invisible
    // predicate, so on an autonomous family the second cannot disagree with the first and the
    // conjunction is a tautology. Corroboration is a real question exactly where the two sources
    // differ - the prepare path, which is judging the REMOTE RUNNER's blocker list against markup
    // this repo read itself - and it is still asked there. Here there is only one source, so
    // writing it as two invited the next reader to trust a layer that does not exist.
    if (managedResultRequiresCaptchaAttention(captchaProbe)) {
      // The provider is passed, not defaulted. Defaulting recorded `unknown` on pages carrying a
      // g-recaptcha-response and a reCAPTCHA anchor iframe, which is a reporting defect of its own:
      // the stall's whole job is to say what stopped the run, and this was the one stop site in the
      // codebase that declined to.
      throw new CaptchaUnresolvedError('before_fill', managedCaptchaProvider(captchaProbe, portal));
    }
    /* A grant-conditional family got past the gate above on the ACCOUNT's grant; whether THIS
     * packet licenses a tick is the plan's stricter question (exactly one captured consent control,
     * routine class, recorded consent_permission acceptance). No plan means park at the handoff
     * now, before paying for a fill run whose submit action would never be built - the same
     * needs_attention state the family reached before this feature, with the same sentence. */
    if (!portalCanAutoSubmit(portal) && !managedConsentTickPlan(portal, packet)
      && !managedImpliedConsentSubmitLicence(portal, packet)) {
      await writeReviewWithRunnerNotSentFact(row, nextReview(claimedReview, {
        status: 'needs_attention',
        attention_reason: portalHandoffReason(portal) ?? undefined,
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
      }), attemptBinding, 'consent-plan-withheld', {
        proofKind: 'typed_pre_click_stop',
        evidenceCode: 'managed_consent_plan_unavailable',
      });
      return;
    }
    const verificationRequestedAt = new Date();
    /* THE FIRST HALF IS THE SAME RUN WHETHER OR NOT A CODE IS IN HAND, and that is the fix.
     *
     * The managed runner is stateless and one-shot: every run loads the form fresh, and on first
     * paint a Greenhouse application form carries no security-code control, because Greenhouse only
     * renders one after a submit has been refused. So a code cannot be attached to this list. It is
     * attached to the CONTINUATION below, which runs on the very DOM this submit produced. */
    const initialActions = buildManagedPortalActions(portal, packet, true, applicationUrl);
    const atomicSubmitV4 = managedApplicationUsesAtomicSubmitV4(portal, applicationUrl);
    /* NO continuationCheckpoint, AND THE COMMENT THAT USED TO SIT HERE WAS SIMPLY WRONG.
     *
     * It said "an ordinary unknown receipt does not offer a continuation, so it needs an explicit
     * checkpoint". Read against the merged runner, stratus-browser-cloud@48ea9b5:
     *
     *     const pressedUnknown = phase === 0 && submitOutcome.pressed === true
     *       && submitOutcome.state === 'unknown';
     *     const continuationOffered = input.requestContinuation === true
     *       && (Boolean(humanVerification) || input.continuationCheckpoint === true || pressedUnknown);
     *
     * pressedUnknown alone already offers it. The flag bought nothing, and it cost two things.
     *
     * FIRST, the observation window. receiptObservationOnly requires continuationCheckpoint to be
     * absent, and it is what caps the held employer page at 15 seconds. With the flag the cap became
     * this caller's full clamped TTL, so a live sandbox sat on the employer's post-submit page for
     * minutes rather than for the seconds the one read-only look needs.
     *
     * SECOND, and worse, continuationOffered became true for EVERY managed submit outcome, including
     * confirmed, rejected and not_attempted. continuationEligible returns that value verbatim, so
     * keepAlive stayed true and sandbox.stop() was skipped in the finally of every successful
     * submission, leaking one sandbox per application while the runner waited on a continuation
     * nothing was going to send. */
    const managedBoundaryAuthorization = await assertFinalRunnerBoundaryClear(
      row,
      claimedReview,
      attemptBinding,
    );
    const successfulSubmissionAttempt = managedInitialSubmissionAttempt(
      attemptBinding,
      managedBoundaryAuthorization,
    );
    const securityCodeSubmissionAttempt = managedContinuationSubmissionAttempt(
      attemptBinding,
      'security_code',
    );
    const receiptObservationSubmissionAttempt = managedContinuationSubmissionAttempt(
      attemptBinding,
      'receipt_observation',
    );
    let result: ManagedBrowserResult;
    try {
      result = await runManagedBrowserWithAccountFence(
        row.user_id,
        applicationUrl,
        initialActions,
        {
          ...managedApplicationSubmitOptions(
            SECURITY_CODE_CONTINUATION_TTL_SECONDS,
            successfulSubmissionAttempt,
          ),
          timeoutMs: managedInitialCallTimeoutMs(managedBoundaryAuthorization),
          providerDeadlineAt: managedInitialProviderDeadlineAt(managedBoundaryAuthorization),
        },
      );
    } catch (error) {
      if (error instanceof ManagedBrowserAssertionFailureError
        && isWorkablePhoneReadbackAssertionLabel(error.assertionLabel)
        && managedApplicationUsesAtomicSubmitV4(portal, applicationUrl)) {
        try {
          // The evidence run's cookie-decline click classifies as a mutation, so it needs the
          // ephemeral scan correlation too; its extracts alone would not.
          const evidenceRun = await runManagedBrowserWithAccountFence(
            row.user_id,
            applicationUrl,
            buildWorkablePhoneEvidenceActions(),
            { screenshot: false, scanCorrelation: true },
          );
          error.attachEvidence(workablePhoneEvidenceSummary(evidenceRun));
        } catch (evidenceError) {
          const detail = String(evidenceError instanceof Error
            ? evidenceError.message
            : evidenceError).slice(0, 200);
          fastify.log.warn(
            { applicationId: row.id, detail },
            'Workable phone readback evidence run failed; the refusal is recorded without evidence',
          );
        }
      }
      if (error instanceof ManagedBrowserProviderProgressError
        && managedProviderProgressDisposition(error.runProgress, 'application') === 'pressed') {
        await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'managed-initial-submit', {
          evidenceCode: 'stratus_application_press_progress',
        });
      }
      const recovery = await recoverManagedSubmissionTerminalResult(
        row,
        claimedReview,
        attemptBinding,
        fastify,
        { actions: initialActions },
      );
      if (recovery !== 'not_recoverable') return;
      throw error;
    }
    const initialTerminalResultId = managedBrowserTerminalResultId(result);
    const initialCleanupMarker = exactManagedTerminalCleanupMarker({
      attemptBinding,
      submissionAttempt: successfulSubmissionAttempt,
      resultId: initialTerminalResultId,
    });
    const initialChallengeCandidate = readManagedSecurityCodeChallenge(result);
    const initialSubmitOutcome = readManagedSubmitOutcome(result);
    if (initialSubmitOutcome?.pressed === true) {
      await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'managed-initial-submit', {
        evidenceCode: 'stratus_application_press_echoed',
      });
    }
    const initialChallenge = securityCodeChallengeMatchesRecipient(initialChallengeCandidate, packet.email)
      ? initialChallengeCandidate
      : null;
    if (initialChallengeCandidate && initialSubmitOutcome?.pressed === false && !initialChallenge) {
      const mismatch = preClickSecurityRecipientMismatchReview(
        claimedReview,
        initialChallengeCandidate,
        verificationRequestedAt.toISOString(),
      );
      await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
        message: mismatch.submission_error ?? 'Employer verification recipient did not match this packet',
        attentionReason: `${mismatch.attention_reason ?? 'The employer verification recipient did not match this packet.'} Check the employer portal and record whether this exact application was received.`,
        attentionCategories: ['security_code', 'unverified_submission'],
        securityCode: mismatch.security_code,
        verification: mismatch.verification,
        cleanupMarkers: [initialCleanupMarker],
      });
      await acknowledgeManagedTerminalFold(
        row,
        attemptBinding,
        successfulSubmissionAttempt,
        initialTerminalResultId,
        fastify,
      );
      return;
    }
    // Required-field confirmation is a barrier inside the same remote action list, immediately
    // before submit. Require its per-field proof as well: an older runner that ignores or does not
    // understand the protocol must not be allowed to turn a silent fill into a submitted state.
    try {
      if (managedApplicationProofIsRequired(initialChallenge, initialSubmitOutcome)) {
        if (atomicSubmitV4) assertManagedApplicationFinalSubmitSelected(result, applicationUrl);
        assertManagedRequiredFieldsConfirmed(result, 'application');
        if (atomicSubmitV4) assertManagedApplicationSubmitConsistency(result, applicationUrl);
      }
    } catch (error) {
      await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
        message: error instanceof Error
          ? error.message.slice(0, 500)
          : 'Managed application proof was incomplete',
        attentionReason: 'Litos could not prove the exact final employer action. Check the employer portal and record whether this application was received.',
        attentionCategories: ['required_field', 'unverified_submission'],
        cleanupMarkers: [initialCleanupMarker],
      });
      await acknowledgeManagedTerminalFold(
        row,
        attemptBinding,
        successfulSubmissionAttempt,
        initialTerminalResultId,
        fastify,
      );
      return;
    }
    let receiptResult = result;
    let securityCodeTerminalResultId: string | undefined;
    let receiptObservationTerminalResultId: string | undefined;
    let receiptObservationStarted = false;
    const managedCleanupMarkers = (): ManagedTerminalCleanupMarker[] => [
      initialCleanupMarker,
      ...(securityCodeTerminalResultId ? [exactManagedTerminalCleanupMarker({
        attemptBinding,
        submissionAttempt: securityCodeSubmissionAttempt,
        resultId: securityCodeTerminalResultId,
      })] : []),
      ...(receiptObservationTerminalResultId ? [exactManagedTerminalCleanupMarker({
        attemptBinding,
        submissionAttempt: receiptObservationSubmissionAttempt,
        resultId: receiptObservationTerminalResultId,
      })] : receiptObservationStarted ? [pendingManagedTerminalCleanupMarker({
        attemptBinding,
        submissionAttempt: receiptObservationSubmissionAttempt,
      })] : []),
    ];
    const acknowledgeManagedCleanupMarkers = async () => {
      await acknowledgeManagedTerminalCleanupMarkers(
        row,
        attemptBinding,
        managedCleanupMarkers(),
        fastify,
      );
    };
    let verification: ApplicationReviewState['verification'] = { status: 'not_needed' };
    const foldManagedLiveTerminalUnverified = async (
      message: string,
      input: {
        categories?: ApplicationAttentionCategory[];
        securityCode?: ApplicationReviewState['security_code'];
        verification?: ApplicationReviewState['verification'];
        previewUrl?: string;
      } = {},
    ) => {
      await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
        message,
        attentionReason: 'Litos could not prove the final employer result for this exact application. Check the employer portal and record whether it was received.',
        attentionCategories: [...new Set([
          ...(input.categories ?? []),
          'unverified_submission' as const,
        ])],
        ...(input.securityCode ? { securityCode: input.securityCode } : {}),
        ...(input.previewUrl ? { previewUrl: input.previewUrl } : {}),
        verification: input.verification ?? verification,
        cleanupMarkers: managedCleanupMarkers(),
      });
      await acknowledgeManagedCleanupMarkers();
    };
    const initialSecurityCodeState = initialChallenge
      ? beginSecurityCodeState({
        challenge: initialChallenge,
        attemptedAt: verificationRequestedAt.toISOString(),
        authorized: true,
        existing: claimedReview.security_code,
      })
      : claimedReview.security_code;
    /* THE SECOND HALF HAPPENS ON THE PAGE THE FIRST HALF PRODUCED, and there is now only one way in.
     *
     * WHAT WAS MEASURED, on a live Cresta application on 2026-08-09. Greenhouse emailed this
     * applicant three security codes:
     *
     *     20:24:03  LSlOXjvZ   issued by the first submit
     *     21:13:07  LH0Yjubx   issued by approve/submit
     *     21:13:53  yFxeFpSl   issued by the code attempt itself, 46 seconds later
     *
     * Each one invalidates its predecessor. And a code control only exists on a page that has just
     * been sent: on first paint a Greenhouse application form has no code field at all. Put those
     * two facts together and a code that arrives from outside the run is unusable BY CONSTRUCTION -
     * the run has to send the form to reach a field to type it into, and that send replaces it. The
     * old shape did exactly that and then typed the dead code, so every attempt was one generation
     * stale, and the packet's own attention_reason told her, honestly and uselessly, to "use the
     * newest email".
     *
     * So there is one continuation branch, not a resend branch. A newly raised challenge reads the
     * code its own submit caused. A retained Greenhouse challenge may instead read the newest code
     * already bound to this exact active application alias during the preceding 24 hours. In both
     * cases the security-code control is already standing, so no second application send occurs.
     *
     * THE WAIT IS BOUNDED AND SHORT BECAUSE THE READER IS NOT A PERSON. A held browser session is a
     * bad place to wait for a human to open an email; it is a fine place to wait a minute for a
     * mailbox fetch. The window it waits inside is the runner's continuation TTL, which now starts
     * when the challenge appears rather than when the sandbox was forked, so this budget is real
     * rather than whatever the form fill happened to leave behind.
     *
     * A CODE SHE SUPPLIED IS STILL WORTH SOMETHING, just not what it used to be. It is her
     * instruction to try this application again, and its fingerprint is what stops the same dead
     * code triggering send after send - each of which costs her another email. It is recorded as
     * 'superseded' and it is never typed. */
    const codeAttempts: SecurityCodeAttempt[] = [];
    if (options.securityCode && initialChallenge) {
      codeAttempts.push({
        at: new Date().toISOString(),
        fingerprint: securityCodeFingerprint(row.id, options.securityCode),
        outcome: 'superseded',
      });
    }
    // The code this run actually typed. It is either read just after this run raises the wall, or,
    // for an already standing Greenhouse wall only, is the newest authenticated code for this exact
    // active application alias. Null until a mailbox read produces one.
    let enteredCode: string | null = null;
    let enteredSecurityCodeState = initialSecurityCodeState;
    const recordEnteredCodeOutcome = (
      outcome: SecurityCodeAttempt['outcome'],
      at: string,
    ): ApplicationReviewState['security_code'] => {
      if (!enteredCode || !enteredSecurityCodeState) return enteredSecurityCodeState;
      enteredSecurityCodeState = withSecurityCodeAttempt(enteredSecurityCodeState, {
        at,
        fingerprint: securityCodeFingerprint(row.id, enteredCode),
        outcome,
      });
      return enteredSecurityCodeState;
    };
    if (initialChallenge && managedResultNeedsEmailVerification(result)) {
      const requestedAt = verificationRequestedAt.toISOString();
      const continuationExpiresAt = result.continuationExpiresAt;
      const continuationToken = result.continuationToken;
      const [verificationSettings] = await db.select({ enabled: users.automatic_verification_enabled })
        .from(users).where(eq(users.id, row.user_id)).limit(1);
      const verificationRoute = await resolveVerificationEmailRoute({
        userId: row.user_id,
        applicationId: row.id,
        expectedRecipient: packet.email,
      });
      const verificationAllowed = verificationRoute === 'application_alias'
        || (verificationRoute === 'personal_address' && verificationSettings?.enabled === true);
      const continuationIsLive = typeof continuationToken === 'string'
        && typeof continuationExpiresAt === 'string'
        && Date.parse(continuationExpiresAt) > Date.now();
      let continuationFingerprint: string | null = null;
      if (continuationIsLive) {
        try {
          continuationFingerprint = managedContinuationFingerprint(continuationToken);
        } catch {
          continuationFingerprint = null;
        }
      }
      const continuationEvidence = continuationFingerprint
        ? {
          runner: 'stratus-managed' as const,
          continuation_fingerprint: continuationFingerprint,
          continuation_execution_fingerprint: managedContinuationExecutionFingerprint(securityCodeSubmissionAttempt),
          continuation_resumed: false,
        }
        : {};
      if (continuationIsLive && verificationAllowed) {
        // The continuation capability stays call-local. Persisting it would turn the review JSON,
        // which is returned to dashboard and extension clients, into a browser-session credential.
        if (!initialSecurityCodeState) throw new Error('Managed security-code state was not initialized');
        const searchingProjection = await recordManagedSecurityCodeContinuationSearch(
          row,
          attemptBinding,
          {
            securityCode: initialSecurityCodeState,
            verification: {
              status: 'searching',
              requested_at: requestedAt,
              retry_count: 0,
              ...continuationEvidence,
            },
          },
        );
        // A confirmation or competing exact-state winner may have moved the parent while the
        // initial provider response was being processed. Such a loser never polls or writes.
        if (!searchingProjection) {
          if (await ensureManagedTerminalCleanupForDurableFold(
            row,
            attemptBinding,
            initialCleanupMarker,
          )) {
            await acknowledgeManagedTerminalFold(
              row,
              attemptBinding,
              successfulSubmissionAttempt,
              initialTerminalResultId,
              fastify,
            );
          }
          return;
        }
        const searchingReview = searchingProjection.review;
        let prepared: Awaited<ReturnType<typeof prepareManagedEmailVerification>>;
        try {
          prepared = await prepareManagedEmailVerification({
            result,
            userId: row.user_id,
            portalUrl: applicationUrl,
            requestedAt: verificationRequestedAt,
            permissionGranted: true,
            expectedRecipient: packet.email,
            applicationId: row.id,
            standingChallenge: initialSubmitOutcome?.pressed === false,
            attempts: SECURITY_CODE_MAILBOX_ATTEMPTS,
            delayMs: SECURITY_CODE_MAILBOX_DELAY_MS,
          });
        } catch (error) {
          await foldManagedLiveTerminalUnverified(
            error instanceof Error
              ? `Automatic mailbox verification failed: ${error.message.slice(0, 300)}`
              : 'Automatic mailbox verification failed',
            {
              categories: ['security_code'],
              securityCode: initialSecurityCodeState,
              verification: searchingReview.verification,
            },
          );
          return;
        }
        const codeWasAlreadyAttempted = prepared.status === 'ready'
          && Boolean(initialSecurityCodeState && findSecurityCodeAttempt(
            initialSecurityCodeState,
            securityCodeFingerprint(row.id, prepared.code),
          ));
        if (prepared.status === 'ready' && !codeWasAlreadyAttempted) {
          const actionAuthorizationValid = await authorizationValidAtClick(row, claimedReview);
          const actionVerificationRoute = await resolveVerificationEmailRoute({
            userId: row.user_id,
            applicationId: row.id,
            expectedRecipient: packet.email,
          });
          const actionPersonalVerificationEnabled = verificationRoute === 'personal_address'
            ? (await db.select({ enabled: users.automatic_verification_enabled })
              .from(users).where(eq(users.id, row.user_id)).limit(1))[0]?.enabled === true
            : false;
          const actionVerificationRouteValid = verificationRoute === 'application_alias'
            ? actionVerificationRoute === 'application_alias'
            : verificationRoute === 'personal_address'
              && actionVerificationRoute === 'personal_address'
              && actionPersonalVerificationEnabled;
          if (!actionAuthorizationValid || !actionVerificationRouteValid) {
            if (!initialSecurityCodeState) throw new Error('Managed security-code state was not initialized');
            const actionBlockCause = !actionAuthorizationValid
              ? 'authorization_revoked' as const
              : verificationRoute === 'personal_address'
                  && actionVerificationRoute === 'personal_address'
                  && !actionPersonalVerificationEnabled
                ? 'email_permission_revoked' as const
                : 'email_route_changed' as const;
            const blocked = preClickVerificationContinuationBlockedReview(
              searchingReview,
              initialSecurityCodeState,
              actionBlockCause,
              initialSubmitOutcome?.pressed === true ? verificationRequestedAt.toISOString() : undefined,
            );
            await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
              message: blocked.submission_error ?? 'Managed verification continuation was withheld',
              attentionReason: blocked.attention_reason ?? 'Litos could not safely continue employer verification. Check the employer portal before retrying.',
              attentionCategories: ['security_code', 'unverified_submission'],
              securityCode: blocked.security_code,
              verification: blocked.verification,
              cleanupMarkers: managedCleanupMarkers(),
            });
            await acknowledgeManagedCleanupMarkers();
            return;
          }
          /* THE PACKET'S OWN SUBMIT ACTION, CARRYING THE CODE, and it is one action rather than ten.
           *
           * securityCodeContinuationActions derives the terminal atomic submit from the list this
           * run already sent, so the selector, chooser policy, contract version and retry budget are
           * the ones the runner validates field by field - and the runner types the code into the
           * eight-box widget itself, at zero extra action cost. The generic ten-action list stays as
           * the fallback for a packet with no atomic submit to derive from, which is the same
           * upstream gate portalCanAutoSubmit already applies. */
          enteredCode = prepared.code;
          const spentAt = new Date().toISOString();
          if (!initialSecurityCodeState) throw new Error('Managed security-code state was not initialized');
          enteredSecurityCodeState = withSecurityCodeAttempts(initialSecurityCodeState, [
            ...codeAttempts,
            {
              at: spentAt,
              fingerprint: securityCodeFingerprint(row.id, prepared.code),
              outcome: 'error',
            },
          ]);
          // Spend the exact code before the one-shot remote call. If the worker stops after this
          // write, the same retained code cannot be selected and submitted on another run.
          const codeActions = securityCodeContinuationActions(initialActions, prepared.code, result.url) ?? prepared.actions;
          // Start the only request timer before the locked continuation gate. Commit delay, OIDC
          // acquisition, and fetch all spend this same budget; none can mint a fresh 70 seconds.
          const continuationRequestBudget = startManagedBrowserRequestBudget(
            MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS,
          );
          let continuationAuthorization: { providerDeadlineAt: string };
          try {
            if (!continuationFingerprint) throw new FinalSubmissionBoundaryChangedError();
            // The retained runner token is one-shot. Atomically consume the exact mutable
            // continuation before calling it, while the parent's immutable press keeps retries
            // blocked if the worker dies before a receipt is recorded.
            continuationAuthorization = await assertManagedSecurityCodeContinuationBoundaryClear(
              searchingProjection.row,
              searchingReview,
              attemptBinding,
              continuationFingerprint,
              securityCodeSubmissionAttempt,
              continuationExpiresAt,
              enteredSecurityCodeState,
              [initialCleanupMarker],
            );
          } catch (error) {
            // A gate loser or a policy refusal never enters the stale initial-run failure handler.
            // Near-expiry and duplicate refusals already wrote the exact mutable resolution exit
            // under the user lock. A changed/replayed loser writes nothing over the winner.
            if (error instanceof ManagedSecurityCodeContinuationRefusedError) {
              await acknowledgeManagedTerminalCleanupMarkers(
                row,
                attemptBinding,
                [initialCleanupMarker],
                fastify,
              );
              return;
            }
            if (error instanceof FinalSubmissionBoundaryBlockedError
              || error instanceof FinalSubmissionAuthorizationChangedError
              || error instanceof SubmissionAccountDeletionDrainError) {
              await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
                message: error.message,
                attentionReason: 'Litos could not safely continue employer verification. Check the employer portal and record whether this exact application was received.',
                attentionCategories: ['security_code', 'unverified_submission'],
                securityCode: enteredSecurityCodeState,
                verification: searchingReview.verification,
                cleanupMarkers: [initialCleanupMarker],
              });
              await acknowledgeManagedTerminalCleanupMarkers(
                row,
                attemptBinding,
                [initialCleanupMarker],
                fastify,
              );
              return;
            }
            if (error instanceof FinalSubmissionBoundaryChangedError
              || error instanceof FinalSubmissionBoundaryAlreadyAuthorizedError) return;
            throw error;
          }
          try {
            // Exactly one bounded continuation call. An uncertain click is never retried.
            receiptResult = await continueManagedBrowserWithAccountFence(row.user_id, continuationToken, codeActions, {
              submissionAttempt: securityCodeSubmissionAttempt,
              requestBudget: continuationRequestBudget,
              providerDeadlineAt: continuationAuthorization.providerDeadlineAt,
              minimumDispatchBudgetMs: MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS,
            });
            securityCodeTerminalResultId = managedBrowserTerminalResultId(receiptResult);
            if (readManagedSubmitOutcome(receiptResult)?.pressed === true) {
              await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'managed-security-code-submit', {
                evidenceCode: 'stratus_verification_press_echoed',
              });
            }
            // A continuation has its own physical submit. Its v2 action must confirm the active
            // verification form and own that click atomically, just like the initial application
            // send. The first receipt cannot authorize a later DOM or a replaced submit node.
            assertManagedRequiredFieldsConfirmed(receiptResult, 'verification');
          } catch (error) {
            if (error instanceof ManagedBrowserProviderProgressError) {
              const disposition = managedProviderProgressDisposition(error.runProgress, 'verification');
              if (disposition === 'pressed') {
                await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'managed-security-code-submit', {
                  evidenceCode: 'stratus_verification_press_progress',
                });
              }
            }
            // The one-shot capability was consumed before this call. Recovery may only poll the
            // deterministic tuple that the gate committed, and a pending read must stay scheduled.
            const [pendingRow] = await db.select().from(generated_resumes).where(and(
              eq(generated_resumes.id, row.id),
              eq(generated_resumes.user_id, row.user_id),
            )).limit(1);
            const pendingReview = pendingRow ? readApplicationReview(pendingRow.spec) : null;
            if (pendingRow && pendingReview) {
              const recovery = await recoverManagedSecurityCodeContinuationTerminalResult(
                pendingRow,
                pendingReview,
                attemptBinding,
                fastify,
              );
              if (recovery !== 'not_recoverable') return;
            }
            recordEnteredCodeOutcome('error', new Date().toISOString());
            await recordManagedSecurityCodeContinuationUnverified(
              row,
              attemptBinding,
              error instanceof Error ? error.message : 'Managed verification continuation failed',
              {
                securityCode: enteredSecurityCodeState,
                cleanupMarkers: [
                  ...managedCleanupMarkers(),
                  pendingManagedTerminalCleanupMarker({
                    attemptBinding,
                    submissionAttempt: securityCodeSubmissionAttempt,
                  }),
                ],
              },
            );
            await acknowledgeManagedCleanupMarkers();
            return;
          }
          if (!readManagedSecurityCodeChallenge(receiptResult)) {
            verification = {
              status: 'completed',
              provider: prepared.provider,
              requested_at: requestedAt,
              retry_count: 1,
              ...continuationEvidence,
              continuation_resumed: true,
            };
          } else {
            verification = {
              status: 'verification_pending',
              requested_at: requestedAt,
              retry_count: 1,
              ...continuationEvidence,
              continuation_resumed: true,
            };
          }
        } else {
          verification = { status: 'verification_pending', requested_at: requestedAt, retry_count: 0, ...continuationEvidence };
        }
      } else {
        verification = { status: 'verification_pending', requested_at: requestedAt, retry_count: 0, ...continuationEvidence };
      }
    }
    /* ONE READ-ONLY SECOND LOOK, ONLY WHEN THE CLICK LANDED AND THE FIRST VERDICT WAS UNKNOWN.
     *
     * Ashby, Greenhouse, and Workable replace their application UI after the request completes. The
     * runner watches for a bounded 30 seconds, but a production transition can still land after its
     * first reading. Without this second look, that delayed receipt becomes a terminal unverified
     * row even though the exact browser page is still alive behind the continuation capability this
     * request already asked Stratus to create.
     *
     * The observer receives no URL and the continuation receives an empty action list. It cannot
     * reopen, navigate, click, or submit. It only lets Stratus run its existing ATS readers on the
     * same Page once more. The helper accepts only Ashby's published success/failure containers,
     * Greenhouse's confirmation route, or Workable's exact bound successful-submit state. Timeout,
     * weak page text, and a second unknown keep the original unverified verdict. An uncertain submit
     * is never retried. */
    let receiptEvidenceResult = receiptResult;
    let delayedObservedChallenge = false;
    if (!initialChallenge) {
      const observation = await observeManagedReceiptOnce({
        initial: receiptResult,
        expectedApplicationUrl: applicationUrl,
        observe: async (continuationToken) => {
          receiptObservationStarted = true;
          const observed = await continueManagedBrowserWithAccountFence(row.user_id, continuationToken, [], {
            screenshot: true,
            submissionAttempt: receiptObservationSubmissionAttempt,
            // This continuation is read-only, but it still must not hold the runner or a provider
            // socket forever while the parent attempt is waiting for an exact receipt verdict.
            timeoutMs: MANAGED_SECURITY_CODE_CONTINUATION_CALL_TIMEOUT_MS,
            minimumDispatchBudgetMs: MANAGED_SECURITY_CODE_CONTINUATION_REMOTE_BUDGET_MS,
          });
          receiptObservationTerminalResultId = managedBrowserTerminalResultId(observed);
          return observed;
        },
      });
      receiptResult = observation.receiptResult;
      receiptEvidenceResult = observation.evidenceResult;
      const delayedChallengeCandidate = observation.observedResult
        ? readManagedSecurityCodeChallenge(observation.observedResult)
        : null;
      const delayedChallenge = securityCodeChallengeMatchesRecipient(delayedChallengeCandidate, packet.email)
        ? delayedChallengeCandidate
        : null;
      if (delayedChallenge && observation.observedResult) {
        // The empty observation can land after the click but before a delayed Greenhouse code wall
        // renders. Its one-shot token is already consumed, so this run cannot safely recurse into a
        // second continuation. Carry the exact typed challenge into the ordinary handoff below,
        // keep its latest screenshot, and release the claim without ever calling it unverified.
        receiptResult = observation.observedResult;
        delayedObservedChallenge = true;
        verification = {
          status: 'verification_pending',
          requested_at: verificationRequestedAt.toISOString(),
          retry_count: 0,
        };
      }
      if (observation.error) {
        const detail = String(observation.error instanceof Error ? observation.error.message : observation.error).slice(0, 200);
        fastify.log.warn({ applicationId: row.id, detail }, 'Managed receipt observation failed closed');
      }
    }
    const capturedAt = new Date().toISOString();
    /* LINEARIZE TYPED CONFIRMATION BEFORE RECEIPT STORAGE.
     *
     * Blob storage is enrichment and may block after the bounded provider callback has returned.
     * Once the correlated runner result, required-field barrier, absent code wall, and accepted
     * entered code all agree that the employer confirmed this exact attempt, its immutable fact
     * must win before that unbounded work starts. The later locked writer adds the screenshot and
     * packet projection idempotently using the same deterministic fact id. */
    const typedConfirmationVerdict = exactManagedSubmitVerdict(receiptResult, applicationUrl);
    const typedConfirmationChallengeCandidate = readManagedSecurityCodeChallenge(receiptResult);
    const typedConfirmationChallenge = securityCodeChallengeMatchesRecipient(
      typedConfirmationChallengeCandidate,
      packet.email,
    ) ? typedConfirmationChallengeCandidate : null;
    const typedConfirmationHasAcceptedCode = !enteredCode
      || receiptResult.securityCodeAttempt?.outcome === 'accepted';
    let confirmedSecurityCode: ApplicationReviewState['security_code'];
    let typedConfirmationReceipt: NonNullable<ApplicationReviewState['receipt']> | undefined;
    if (!delayedObservedChallenge
      && !typedConfirmationChallenge
      && typedConfirmationVerdict.kind === 'confirmed'
      && typedConfirmationHasAcceptedCode) {
      confirmedSecurityCode = enteredCode
        ? recordEnteredCodeOutcome('accepted', capturedAt)
        : enteredSecurityCodeState && codeAttempts.length > 0
          ? withSecurityCodeAttempts(enteredSecurityCodeState, codeAttempts)
          : undefined;
      typedConfirmationReceipt = {
        confirmation_text: typedConfirmationVerdict.confirmationText,
        final_url: receiptResult.url,
        captured_at: capturedAt,
        source: 'managed_browser',
      };
      const confirmedBeforeReceiptStorage = await recordManagedSubmissionConfirmed(row, attemptBinding, {
        capturedAt,
        verification,
        ...(confirmedSecurityCode ? { securityCode: confirmedSecurityCode } : {}),
        receipt: typedConfirmationReceipt,
        receiptEvidence: {
          result: receiptResult,
          expectedApplicationUrl: applicationUrl,
        },
        cleanupMarkers: managedCleanupMarkers(),
      });
      if (!confirmedBeforeReceiptStorage) {
        fastify.log.warn(
          { applicationId: row.id, attemptId: attemptBinding.attemptId },
          'Managed confirmation did not match its immutable submission opening',
        );
        let durableCleanupFold = true;
        for (const marker of managedCleanupMarkers()) {
          if (!await ensureManagedTerminalCleanupForDurableFold(
            row,
            attemptBinding,
            marker,
          )) durableCleanupFold = false;
        }
        if (durableCleanupFold) {
          await acknowledgeManagedCleanupMarkers();
        } else {
          await foldManagedLiveTerminalUnverified(
            'Managed confirmation did not match its immutable submission opening',
            { securityCode: confirmedSecurityCode },
          );
        }
        return;
      }
      await acknowledgeManagedCleanupMarkers();
    }
    if (!receiptEvidenceResult.screenshot) {
      if (typedConfirmationReceipt) {
        fastify.log.warn(
          { applicationId: row.id, attemptId: attemptBinding.attemptId },
          'Managed confirmation was persisted without an available receipt screenshot',
        );
        return;
      }
      await foldManagedLiveTerminalUnverified(
        'Stratus managed browser did not return a receipt screenshot',
        { securityCode: enteredSecurityCodeState },
      );
      return;
    }
    let blob: Awaited<ReturnType<typeof storeReceiptScreenshot>>;
    try {
      blob = await storeReceiptScreenshot(
        `users/${row.user_id}/submission-runs/${claimedReview.submission_run_id}/receipt.png`,
        Buffer.from(receiptEvidenceResult.screenshot, 'base64'),
      );
    } catch (error) {
      if (!typedConfirmationReceipt) {
        await foldManagedLiveTerminalUnverified(
          error instanceof Error
            ? `Receipt screenshot storage failed: ${error.message.slice(0, 300)}`
            : 'Receipt screenshot storage failed',
          { securityCode: enteredSecurityCodeState },
        );
        return;
      }
      fastify.log.warn({
        applicationId: row.id,
        attemptId: attemptBinding.attemptId,
        detail: error instanceof Error ? error.message.slice(0, 200) : 'Receipt screenshot storage failed',
      }, 'Managed confirmation was persisted before receipt screenshot storage failed');
      return;
    }
    if (delayedObservedChallenge) {
      const delayedChallenge = readManagedSecurityCodeChallenge(receiptResult);
      if (!delayedChallenge) {
        await foldManagedLiveTerminalUnverified(
          'Delayed security-code challenge disappeared before handoff',
          { categories: ['security_code'], previewUrl: blob.url },
        );
        return;
      }
      const securityCode = beginSecurityCodeState({
        challenge: delayedChallenge,
        attemptedAt: capturedAt,
        authorized: true,
        existing: claimedReview.security_code,
      });
      const delayed = delayedSecurityCodeHandoffReview(claimedReview, {
        verification,
        securityCode,
        attemptedAt: capturedAt,
        screenshotUrl: blob.url,
      });
      await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
        message: 'Employer security-code challenge appeared after the receipt observation capability was consumed',
        attentionReason: `${delayed.attention_reason ?? securityCodeAttentionReason(securityCode)} Check the employer portal and record whether this exact application was received.`,
        attentionCategories: ['security_code', 'unverified_submission'],
        securityCode,
        verification,
        previewUrl: blob.url,
        cleanupMarkers: managedCleanupMarkers(),
      });
      await acknowledgeManagedCleanupMarkers();
      fastify.log.warn({
        applicationId: row.id,
        sentTo: securityCode.sent_to,
        digits: securityCode.digits,
      }, 'Employer security-code challenge appeared after the receipt observation capability was consumed');
      return;
    }
    /* THE SUBMIT LANDED AND THE EMPLOYER ASKED FOR A CODE, so this is not 'submitted'.
     *
     * Read off the control the runner found, never off the page's text. A Greenhouse page that has
     * just refused an application can still
     * carries plenty of encouraging prose. Recording a receipt here would mean telling the applicant
     * an application was filed while the employer holds nothing, which is the single worst thing
     * this system can say.
     *
     * The screenshot is kept either way. It is the evidence of what was actually on screen, and it
     * is what makes the next state debuggable rather than a claim. */
    const challengeCandidate = readManagedSecurityCodeChallenge(receiptResult);
    const challenge = securityCodeChallengeMatchesRecipient(challengeCandidate, packet.email)
      ? challengeCandidate
      : null;
    if (challenge) {
      const securityCode = beginSecurityCodeState({
        challenge,
        attemptedAt: capturedAt,
        authorized: true,
        existing: enteredSecurityCodeState,
      });
      const attempted = withSecurityCodeAttempts(securityCode, [
        ...codeAttempts,
        // The runner says what happened to the code IT typed, and it says it by re-reading the
        // control after the resubmit. 'rejected' when it typed the code and the challenge was still
        // there; the other two mean Litos could not get the code into the page at all, which is a
        // defect of ours and must never be reported to her as a wrong code. Recorded only when a
        // code was actually typed, which now means only when this run read one in-session.
        ...(enteredCode ? [{
          at: capturedAt,
          fingerprint: securityCodeFingerprint(row.id, enteredCode),
          outcome: (receiptResult.securityCodeAttempt?.outcome === 'rejected' ? 'rejected'
            : receiptResult.securityCodeAttempt?.outcome === 'no_control' ? 'no_control'
              : 'not_entered') as SecurityCodeAttempt['outcome'],
        }] : []),
      ]);
      await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
        message: 'Employer is holding this application behind an emailed security code',
        attentionReason: `${securityCodeAttentionReason(attempted)} Check the employer portal and record whether this exact application was received.`,
        attentionCategories: ['security_code', 'unverified_submission'],
        securityCode: attempted,
        verification: verification.status === 'not_needed'
          ? claimedReview.verification ?? verification
          : verification,
        previewUrl: blob.url,
        cleanupMarkers: managedCleanupMarkers(),
      });
      await acknowledgeManagedCleanupMarkers();
      fastify.log.warn({
        applicationId: row.id,
        sentTo: attempted.sent_to,
        digits: attempted.digits,
        codeSupplied: Boolean(options.securityCode),
        codeReadInSession: Boolean(enteredCode),
        codeOutcome: receiptResult.securityCodeAttempt?.outcome ?? null,
      }, 'Employer is holding this application behind an emailed security code');
      return;
    }
    /* THE RUN'S OWN READING OF THE PAGE WINS, and there are three answers rather than two.
     *
     * Until this, the only question asked here was "does the body text match RECEIPT_PROOF_RE", and
     * a miss threw into fail(), which reported the submit as unverifiable with a sentence that led
     * nowhere. Skydio packet 13bccb2d never even got that far, but the same code path is what would
     * have handled it had the run survived. The runner now reports what the ATS rendered.
     *
     * 'refused' is the arm that did not exist at all. An employer that says out loud that it could
     * not take the application is the cheapest possible thing to be certain about, and it was being
     * folded into the same "we cannot tell" bucket as a run that died mid-click.
     */
    const verdict = exactManagedSubmitVerdict(receiptResult, applicationUrl);
    // The press-window network record, for the unverified arms below. Read once, next to the
    // verdict it annotates, so the two cannot come from different readings of the result.
    const pressNetwork = readManagedSubmitOutcome(receiptResult)?.network ?? undefined;
    /* The runner's own post-run CAPTCHA verdict, read from the same result as the verdict above.
     * Measured on the live Mytos Lever form (run 6757f19a, 2026-08-20): the press fetched an
     * hCaptcha drag puzzle, the receipt shows it standing over the fully filled form, and the
     * unverified sentence promised a re-send that would hit the same wall. */
    const pressChallengeOnScreen = blockersIncludeCaptcha(corroborateManagedCaptchaBlockers(
      portal,
      (receiptResult.blockers ?? []) as readonly string[],
      receiptResult,
    ));
    if (verdict.kind === 'refused') {
      const refusedCodeOutcome = receiptResult.securityCodeAttempt?.outcome === 'rejected'
        ? 'rejected' as const
        : 'error' as const;
      const refusedSecurityCode = enteredCode
        ? recordEnteredCodeOutcome(refusedCodeOutcome, capturedAt)
        : undefined;
      /* Provider prose is not typed phase-1 no-press evidence. After authorization it cannot
       * machine-close the parent, even when the page says "refused". */
      await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
        message: `Employer verification was refused: ${verdict.message.slice(0, 300)}`,
        attentionReason: `The employer refused this application at the last step and said: “${verdict.message.slice(0, 300)}”. Litos cannot prove from that page alone that no employer action occurred. Check the employer portal and record whether this exact application was received.`,
        attentionCategories: ['unverified_submission'],
        ...(refusedSecurityCode ? { securityCode: refusedSecurityCode } : {}),
        previewUrl: blob.url,
        cleanupMarkers: managedCleanupMarkers(),
      });
      await acknowledgeManagedCleanupMarkers();
      return;
    }
    /* A PROVIDER LABEL IS NOT PHASE-1 PROOF. This result arrived only after the immutable employer
     * capability was authorized. Until Stratus returns a correlated pre-activation stop record, a
     * not_attempted label cannot close the parent or release its duplicate lock. */
    if (verdict.kind === 'not_attempted') {
      const notAttemptedCodeOutcome = receiptResult.securityCodeAttempt?.outcome === 'no_control'
        ? 'no_control' as const
        : receiptResult.securityCodeAttempt?.outcome === 'not_entered'
          ? 'not_entered' as const
          : 'error' as const;
      const notAttemptedSecurityCode = enteredCode
        ? recordEnteredCodeOutcome(notAttemptedCodeOutcome, capturedAt)
        : undefined;
      /* The managed result does not yet expose correlated phase-1 pre-activation proof. Its
       * not_attempted label therefore stays unresolved after an immutable authorization. */
      await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
        message: 'Managed provider reported not_attempted after employer-boundary authorization',
        attentionReason: 'The secure browser reported that it did not complete the final action, but it did not provide typed phase-1 no-press proof. Check the employer portal and record whether this exact application was received.',
        attentionCategories: ['required_field', 'unverified_submission'],
        ...(notAttemptedSecurityCode ? { securityCode: notAttemptedSecurityCode } : {}),
        previewUrl: blob.url,
        cleanupMarkers: managedCleanupMarkers(),
      });
      await acknowledgeManagedCleanupMarkers();
      return;
    }
    if (verdict.kind === 'unverified') {
      const unverifiedCodeOutcome = receiptResult.securityCodeAttempt?.outcome === 'rejected'
        ? 'rejected' as const
        : receiptResult.securityCodeAttempt?.outcome === 'no_control'
          ? 'no_control' as const
          : receiptResult.securityCodeAttempt?.outcome === 'not_entered'
            ? 'not_entered' as const
            : 'error' as const;
      /* THE RAW READ, LOGGED RATHER THAN DROPPED. managedSubmitVerdict never reads outcome.message
       * on this branch - it cannot promote an unverified send to a claim - but the page Stratus
       * actually saw is exactly the evidence a real confirmation arm for breezy.hr or workable.com
       * would be built from, and no such arm exists yet for either (measured 2026-08-20: no real
       * post-submit DOM has ever been captured). Logging it here, at the one place every unverified
       * outcome already passes through, means the next real send to either produces that evidence
       * instead of another silent dead end. */
      const rawOutcome = readManagedSubmitOutcome(receiptResult);
      if (rawOutcome?.source === 'unmatched_page_text') {
        fastify.log.warn({
          applicationId: row.id,
          portalUrl: rawOutcome.evidence,
          pageText: rawOutcome.message,
        }, 'Unrecognised post-submit page: no confirmation arm exists for this ATS shape yet');
      }
      const unverifiedSecurityCode = enteredCode
        ? recordEnteredCodeOutcome(unverifiedCodeOutcome, capturedAt)
        : undefined;
      await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
        message: 'Managed submission result did not contain a confirmation state',
        attentionReason: unverifiedSubmissionReason({
          atsName: claimedReview.ats_name,
          portalUrl: claimedReview.portal_url,
          cause: 'no_confirmation_state',
          network: pressNetwork ?? null,
          challengeOnScreen: pressChallengeOnScreen,
        }),
        attentionCategories: ['unverified_submission'],
        ...(unverifiedSecurityCode ? { securityCode: unverifiedSecurityCode } : {}),
        previewUrl: blob.url,
        network: pressNetwork,
        challengeOnScreen: pressChallengeOnScreen,
        cleanupMarkers: managedCleanupMarkers(),
      });
      await acknowledgeManagedCleanupMarkers();
      return;
    }
    /* A CODE RUN OWES TWO PROOFS, AND "NO ERROR VISIBLE" IS NEITHER OF THEM.
     *
     * The challenge branch above has already returned, so by here the code control is gone from the
     * page. Gone is not filed. Greenhouse unmounts the whole application form and navigates to its
     * confirmation route on success, and it also unmounts the code control when it re-renders the
     * form for any other reason, so the disappearance on its own distinguishes nothing. The two
     * facts that do are the runner's own reading of what it did with the code, and the page's own
     * confirmation state - and this used to demand neither, writing outcome 'accepted' onto the
     * attempt as a literal regardless of what the runner reported.
     *
     * Anything short of both is 'unverified', which is a state with a next step, rather than
     * 'submitted', which is a claim. */
    if (enteredCode) {
      const codeOutcome = receiptResult.securityCodeAttempt?.outcome ?? null;
      if (codeOutcome !== 'accepted' || verdict.kind !== 'confirmed') {
        fastify.log.warn(
          { applicationId: row.id, codeOutcome, verdict: verdict.kind },
          'Security-code submission could not be proved, recording it as unverified',
        );
        const uncertainSecurityCode = recordEnteredCodeOutcome(
          codeOutcome === 'rejected' ? 'rejected'
            : codeOutcome === 'no_control' ? 'no_control'
              : codeOutcome === 'not_entered' ? 'not_entered'
                : 'error',
          capturedAt,
        );
        await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
          message: 'Security-code submission could not be proved',
          attentionReason: unverifiedSubmissionReason({
            atsName: claimedReview.ats_name,
            portalUrl: claimedReview.portal_url,
            cause: 'no_confirmation_state',
            network: pressNetwork ?? null,
            challengeOnScreen: pressChallengeOnScreen,
          }),
          attentionCategories: ['security_code', 'unverified_submission'],
          ...(uncertainSecurityCode ? { securityCode: uncertainSecurityCode } : {}),
          previewUrl: blob.url,
          network: pressNetwork,
          challengeOnScreen: pressChallengeOnScreen,
          cleanupMarkers: managedCleanupMarkers(),
        });
        await acknowledgeManagedCleanupMarkers();
        return;
      }
    }
    if (verdict.kind === 'unreported') {
      await recordManagedAuthorizedAttemptUnverified(row, attemptBinding, {
        message: 'Managed provider did not return the typed terminal receipt contract',
        attentionReason: unverifiedSubmissionReason({
          atsName: claimedReview.ats_name,
          portalUrl: claimedReview.portal_url,
          cause: 'no_confirmation_state',
          network: pressNetwork ?? null,
          challengeOnScreen: pressChallengeOnScreen,
        }),
        attentionCategories: ['unverified_submission'],
        previewUrl: blob.url,
        network: pressNetwork,
        challengeOnScreen: pressChallengeOnScreen,
        cleanupMarkers: managedCleanupMarkers(),
      });
      await acknowledgeManagedCleanupMarkers();
      return;
    }
    if (verdict.kind !== 'confirmed') throw new Error('Managed receipt verdict did not reach a terminal branch');
    const receipt = { confirmationText: verdict.confirmationText, finalUrl: receiptResult.url };
    // Present only when a code finished this one, and it is the fact that makes the receipt
    // legible: this application was sent, refused, and completed with the code the same run read
    // out of the mailbox while holding the challenged page open.
    confirmedSecurityCode ??= enteredCode
      ? recordEnteredCodeOutcome('accepted', capturedAt)
      : enteredSecurityCodeState && codeAttempts.length > 0
        ? withSecurityCodeAttempts(enteredSecurityCodeState, codeAttempts)
        : undefined;
    const confirmed = await recordManagedSubmissionConfirmed(row, attemptBinding, {
      capturedAt,
      verification,
      ...(confirmedSecurityCode ? { securityCode: confirmedSecurityCode } : {}),
      receipt: typedConfirmationReceipt ? {
        ...typedConfirmationReceipt,
        screenshot_url: blob.url,
      } : {
        confirmation_text: receipt.confirmationText,
        final_url: receipt.finalUrl,
        screenshot_url: blob.url,
        captured_at: capturedAt,
        source: 'managed_browser',
      },
      receiptEvidence: {
        result: receiptResult,
        expectedApplicationUrl: applicationUrl,
      },
    });
    if (!confirmed) {
      fastify.log.warn(
        { applicationId: row.id, attemptId: attemptBinding.attemptId },
        'Managed receipt belonged to a replaced submission run and did not change its packet',
      );
      return;
    }
    fastify.log.info({ applicationId: row.id }, 'Application submission receipt verified with Stratus Sandbox');
    return;
  }
  if (!claimedReview.browser_session_id) throw new Error('The prepared run is missing its session.');
  const directPortal = detectPortal(claimedReview.portal_url!);
  const directBuiltPacket = await buildPacket(row, false, packetAudit.questions, false, packetAudit.pdfBytes);
  const directPacket = packetForEmployerDelivery(directBuiltPacket, claimedReview, 'browser');
  const directEnvelope = employerDeliveryEnvelope({
    channel: browserEmployerDeliveryChannel(browserDeliveryRuntimeIdentity().provider),
    destinationUrl: portalApplicationUrl(directPortal, claimedReview.portal_url!),
    portalFamily: directPortal,
    runtime: browserDeliveryRuntimeIdentity(),
    coverLetterSupported: claimedReview.cover_letter_supported,
    transcriptSupported: claimedReview.transcript_supported,
  });
  assertVerifiedBuiltPacket(
    directPacket,
    packetAudit.audit,
    packetAudit.questions,
    'browser',
    directEnvelope,
  );
  const session = await getBrowserSession(claimedReview.browser_session_id);
  let browser;
  try {
    const connected = await connectToSession(session);
    browser = connected.browser;
    const page = connected.page;
    assertEmployerPageUrl(directEnvelope.destinationUrl, page.url());
    if (!await authorizationValidAtClick(row, claimedReview)) {
      await holdRevokedSubmission(
        row,
        claimedReview,
        attemptBinding,
        'authorization-revoked-before-direct',
        'authorization_revoked_before_direct_submit',
      );
      return;
    }
    await fillPortal(page, directPortal, directPacket);
    assertEmployerPageUrl(directEnvelope.destinationUrl, page.url());
    await executeAfterFinalSubmissionBoundary(
      () => assertFinalRunnerBoundaryClear(row, claimedReview, attemptBinding),
      () => clickFinalSubmit(page),
    );
    await appendRunnerAttemptFact(attemptBinding, 'press_observed', 'direct-submit', {
      evidenceCode: 'direct_submit_returned',
    });
    const receipt = await readExactManagedPageReceipt(page, directEnvelope.destinationUrl);
    if (!receipt) {
      throw new Error('The employer page did not show an exact receipt for this application');
    }
    const capturedAt = new Date().toISOString();
    const exactReceipt = {
      confirmation_text: receipt.confirmationText,
      final_url: receipt.finalUrl,
      captured_at: capturedAt,
      source: 'managed_browser' as const,
    };
    const confirmed = await recordManagedSubmissionConfirmed(row, attemptBinding, {
      capturedAt,
      verification: { status: 'not_needed' },
      receipt: exactReceipt,
      receiptEvidence: {
        result: receipt.result,
        expectedApplicationUrl: directEnvelope.destinationUrl,
      },
    });
    if (!confirmed) return;
    try {
      const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
      const blob = await storeReceiptScreenshot(
        `users/${row.user_id}/submission-runs/${claimedReview.submission_run_id}/receipt.png`,
        screenshot,
      );
      const enriched = await recordManagedSubmissionConfirmed(row, attemptBinding, {
        capturedAt,
        verification: { status: 'not_needed' },
        receipt: {
          ...exactReceipt,
          screenshot_url: blob.url,
        },
        receiptEvidence: {
          result: receipt.result,
          expectedApplicationUrl: directEnvelope.destinationUrl,
        },
      });
      if (!enriched) {
        fastify.log.warn(
          { applicationId: row.id, attemptId: attemptBinding.attemptId },
          'Direct confirmation persisted but receipt enrichment lost its exact packet binding',
        );
      }
    } catch (error) {
      fastify.log.warn({
        applicationId: row.id,
        attemptId: attemptBinding.attemptId,
        detail: error instanceof Error ? error.message.slice(0, 200) : 'Receipt enrichment failed',
      }, 'Direct confirmation persisted before screenshot or Blob enrichment failed');
    }
    fastify.log.info({ applicationId: row.id }, 'Application submission receipt verified');
  } finally {
    await browser?.close().catch(() => undefined);
  }
  } catch (error) {
    throw new SubmissionExecutionError(row, error);
  }
}


/**
 * What a failed run tells the applicant, derived rather than written inline.
 *
 * EXTRACTED SO IT CAN BE TESTED. This is the user-visible half of the no-submit-control change and
 * it had no behavioural coverage at all - the only thing watching this file was a test that greps
 * it as a string, which cannot tell a correct branch from a deleted one. A review pass proved it by
 * deleting each branch in turn and finding the suite still green.
 *
 * THE PRECEDENCE IS THE POINT, and it runs stop-reason first, uncertainty last. `uncertainAfterClaim`
 * is true on every one of these paths, because the claim is taken at the top of the run - so any
 * branch that does not outrank it inherits "the submission was attempted and we could not verify
 * it", which sends someone hunting for a receipt that cannot exist.
 */
export type SubmissionFailureOutcome =
  /* Requeued, not terminal: the provider was unreachable, so the run goes back to the queue and
     the applicant is owed nothing yet. This is the ONLY arm allowed a missing reason. */
  | { status: 'submit_requested'; attentionReason: string | undefined; attentionCategories: ApplicationAttentionCategory[] }
  /* Terminal. `attentionReason: string` is not a style choice: it makes "a stopped run with no
     stated cause" fail to compile here, which is the half of the invariant that catches a mistake
     before it can ever be written, with withTerminalCause catching whatever gets past it. */
  | { status: TerminalRunStatus; attentionReason: string; attentionCategories: ApplicationAttentionCategory[] };

export function submissionFailureOutcome(input: {
  captchaStop: 'before_fill' | 'at_submit' | null;
  noSubmitControl: boolean;
  regenerationRequired?: boolean;
  /* The packet's own resume file is gone from storage, so no packet could be assembled at all. */
  packetDocumentExpired?: boolean;
  /* The applicant-facing sentence from a ManagedActionBudgetError, or null. A string rather than a
     boolean because the error composes its own reason from the portal and the question count, and
     re-deriving it here would be a second place to keep that wording correct. */
  actionBudgetStop?: string | null;
  /* A ManagedRequiredFieldConfirmationError, which is a NoSubmitControlError by inheritance and is
     NOT one in fact. See the arm below for what that inheritance was costing the applicant. */
  requiredFieldConfirmation?: boolean;
  fieldProofFailedBeforeSubmit?: boolean;
  uncertainAfterClaim: boolean;
  externalGate: boolean;
  providerSessionFailure: boolean;
  currentAttentionReason: string | undefined;
}): SubmissionFailureOutcome {
  const { captchaStop, noSubmitControl, regenerationRequired, packetDocumentExpired, actionBudgetStop, requiredFieldConfirmation, fieldProofFailedBeforeSubmit, uncertainAfterClaim, externalGate, providerSessionFailure } = input;
  const status: TerminalRunStatus | 'submit_requested' = captchaStop || noSubmitControl || regenerationRequired || packetDocumentExpired || actionBudgetStop || requiredFieldConfirmation || fieldProofFailedBeforeSubmit || uncertainAfterClaim || providerSessionFailure
    ? 'needs_attention'
    : externalGate ? 'submit_requested' : 'failed';
  const attentionReason = captchaStop === 'at_submit'
    ? 'This company\u2019s application page asks you to prove you are human, and that check is still waiting. Litos filled everything in and stopped there, so nothing has been sent. Open it when you have a minute and finish the last step.'
    : captchaStop === 'before_fill'
      ? 'This company asks you to prove you are human before it will take an application, so Litos cannot send this one while you are away. Open it when you have a minute and Litos will fill it in for you.'
      : regenerationRequired
        ? 'This application must be regenerated before submission because its stored Litos email no longer matches the active inbound email route. Nothing was sent to the employer.'
      : packetDocumentExpired
        /* Ranked here for the same reason as its neighbours, and it is the earliest stop of the
           whole family: buildPacket throws before a browser session is opened, so nothing was
           filled and nothing was sent. Without this arm it inherited uncertainAfterClaim, because
           the submit() call site runs after the claim.

           THE RETENTION IS NAMED, not hidden behind "something went wrong". This is the privacy
           promise working exactly as published (RESUME_RETENTION_DAYS, and app/privacy on the site
           says the file is gone after 30 days), so the honest thing is to say so. An apology for a
           malfunction would be a lie about a feature, and it would leave the applicant expecting a
           retry to fix it when only a regenerate will.

           "normally what has happened here" rather than a flat assertion: the throw fires whenever
           the object key resolves to nothing, and retention is the overwhelmingly likely cause but
           not a proven one on any given row. Same discipline as the cause-neutral wording on
           noSubmitControl below. The recovery is identical either way, so nothing is lost by not
           claiming more than is known. */
        ? PACKET_EXPIRED_REASON
      : actionBudgetStop
        /* Ranked above uncertainAfterClaim for the same reason as its two neighbours: the throw
           happens before the browser is driven, so nothing was sent and there is no confirmation to
           hunt for. The error's own sentence is used verbatim - it already names the portal and the
           question count, which is what makes this one actionable rather than mysterious. */
        ? `${actionBudgetStop} Nothing was sent. Remove or answer fewer optional questions on this application, then try again.`
      : requiredFieldConfirmation
        /* RANKED ABOVE noSubmitControl, AND THAT ORDER IS THE WHOLE ARM.
           ManagedRequiredFieldConfirmationError extends NoSubmitControlError, deliberately and
           correctly: fail() reads that type as "the click PROVABLY did not happen", which is the one
           thing that must stay true of it. What came with the inheritance was the SENTENCE, and the
           sentence is about a different event. Every required-field stop, right or wrong, told the
           applicant "Litos could not find the button that sends this application" about a run that
           found the button, bound it uniquely and then withheld the press on purpose. Reading that
           about a form whose Submit button is plainly on screen teaches her the message is noise,
           which is exactly the wrong lesson from the one stop she can actually act on.

           What is always true here, and is the only thing claimed: the form was reached, the send
           control was found, one required answer could not be confirmed as accepted, and the press
           was withheld because of it. Cause-neutral about WHICH answer for the same reason
           noSubmitControl is cause-neutral - the error carries its own field list into
           submission_error, and the blockers the run produced are surfaced on their own. */
        ? 'Litos filled this application in and found the button that sends it, but could not confirm one of the required answers had been accepted, so it did not press it. Nothing has been sent and there is no confirmation to look for. Open it when you have a minute and finish it off.'
      : fieldProofFailedBeforeSubmit
        ? 'Litos filled this application in, but could not prove one of the answers it typed was still on the form, so it stopped before pressing the button that sends it. Nothing has been sent and there is no confirmation to look for. Retrying will very likely stop at the same place, so open it when you have a minute and finish it off.'
      : noSubmitControl
        /* CAUSE-NEUTRAL. NoSubmitControlError is thrown for a multi-step first page, a page that
           renders nothing in a headless browser, a control relabelled mid-run, and a click that
           timed out before dispatching - so naming any one cause would be false most of the time.
           What is always true, and all that matters, is that nothing was sent. */
        ? 'Litos could not find the button that sends this application, so nothing has been sent and there is no confirmation to look for. Open it when you have a minute and finish it off.'
        : providerSessionFailure
          ? 'Litos hit a temporary secure-browser error before it could finish this application. Nothing was sent. Try this one again in a few minutes.'
          : uncertainAfterClaim
            ? 'The final submission was attempted, but Litos could not verify the employer confirmation. Check the portal or your email before trying again.'
          : input.currentAttentionReason?.trim() || undefined;
  if (status === 'submit_requested') {
    return { status, attentionReason, attentionCategories: attentionCategoriesForReasons(attentionReason ? [attentionReason] : []) };
  }
  /* THE HOLE THAT WAS HERE. This branch used to end at `input.currentAttentionReason ?? undefined`,
     so a run that threw during PREPARE - before any blocker had been written, which is when the
     runner throws most often - reached status 'failed' with attention_reason unset. Three owner
     packets did exactly that on 2026-08-06: the only record of why was submission_error, holding
     "Each selector must be a non-empty string no longer than 500 characters", which is the remote
     runner talking to whoever maintains it and is not shown to anyone. The row read as a run that
     had simply stopped.

     The fallback is deliberately generic and says so. Guessing a cause here would mean inventing
     one, and an invented cause is the failure this whole change exists to remove. */
  const reason = attentionReason ?? UNEXPLAINED_RUN_FAILURE_REASON;
  const attentionCategories = attentionCategoriesForReasons(reason.split('\n').filter((line) => line.trim()));
  return {
    status,
    attentionReason: reason,
    attentionCategories: attentionCategories.length > 0 ? attentionCategories : ['unknown'],
  };
}

/** Fields a managed atomic chooser failure must remove because it occurs before any submit click. */
export function preClickNoSubmitReleasePatch(): Partial<ApplicationReviewState> {
  return {
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_authorization: undefined,
    submission_attempted_at: undefined,
    unverified_submission: undefined,
    submitted_at: undefined,
    receipt: undefined,
  };
}

/** The exact persisted review for an atomic chooser stop that occurs before submitHandle.click.
 *
 * `requiredFieldConfirmation` is passed rather than sniffed out of `message`, and it is passed
 * BECAUSE this function is the one that runs. submissionFailureReview returns here for every
 * NoSubmitControlError, subclasses included, so an arm added to submissionFailureOutcome alone
 * would be correct, tested, and unreachable on the path that produces the sentence. The typed stop
 * stays 'no_submit_control': what the row records about WHEN the run stopped is unchanged and
 * already right, and only what the applicant reads about WHY differs between the two.
 */
export function preClickNoSubmitReview(
  current: ApplicationReviewState,
  message: string,
  now: () => string = () => new Date().toISOString(),
  requiredFieldConfirmation = false,
): ApplicationReviewState {
  const outcome = submissionFailureOutcome({
    captchaStop: null,
    noSubmitControl: true,
    requiredFieldConfirmation,
    uncertainAfterClaim: true,
    externalGate: false,
    providerSessionFailure: false,
    currentAttentionReason: current.attention_reason,
  });
  return nextReview(current, {
    status: outcome.status,
    ...preClickNoSubmitReleasePatch(),
    /* Written even though this branch releases the claim outright, because the release is not the
     * only reader. A row that lands here and is later moved by another path still carries the typed
     * proof, so nothing downstream has to re-derive it from the sentence in submission_error. */
    submission_stop: submissionStopRecord('no_submit_control', now(), current.submission_run_id),
    ...(current.verification?.status === 'searching'
      ? { verification: { ...current.verification, status: 'verification_pending' as const } }
      : {}),
    submission_error: message,
    attention_reason: outcome.attentionReason,
    attention_categories: outcome.attentionCategories,
  });
}

/** A mismatched recipient after managed authorization remains an unresolved exact parent. */
export function preClickSecurityRecipientMismatchReview(
  current: ApplicationReviewState,
  challenge: NonNullable<ReturnType<typeof readManagedSecurityCodeChallenge>>,
  observedAt: string,
): ApplicationReviewState {
  const matchingExistingState = current.security_code?.sent_to
    && securityCodeChallengeMatchesRecipient(challenge, current.security_code.sent_to)
    ? current.security_code
    : undefined;
  const securityCode = beginSecurityCodeState({
    challenge,
    attemptedAt: observedAt,
    authorized: matchingExistingState?.submit_was_authorized ?? false,
    existing: matchingExistingState,
  });
  const attentionReason = 'The employer security-code step named a different application email than this packet after the managed employer capability was authorized. Check the employer portal and record whether this exact application was received before taking another action.';
  return nextReview(current, {
    ...unverifiedSubmissionPatch(current, {
      at: observedAt,
      cause: 'no_confirmation_state',
    }),
    security_code: securityCode,
    verification: {
      ...current.verification,
      status: 'verification_pending',
      requested_at: observedAt,
      retry_count: current.verification?.retry_count ?? 0,
    },
    submission_error: 'Managed security-code recipient did not match the packet email',
    attention_reason: attentionReason,
    attention_categories: ['security_code', 'unverified_submission'],
  });
}

/** A withheld continuation cannot release a parent whose initial managed capability was authorized. */
export function preClickVerificationContinuationBlockedReview(
  current: ApplicationReviewState,
  securityCode: NonNullable<ApplicationReviewState['security_code']>,
  cause: 'authorization_revoked' | 'email_route_changed' | 'email_permission_revoked',
  attemptedAt?: string,
): ApplicationReviewState {
  const attentionReason = cause === 'authorization_revoked'
    ? 'Automatic submission permission was revoked before Litos could finish employer verification. The already authorized parent remains unresolved. Check the employer portal and record whether this exact application was received.'
    : cause === 'email_permission_revoked'
      ? 'Automatic inbox verification was turned off before Litos could finish employer verification. The already authorized parent remains unresolved. Check the employer portal and record whether this exact application was received.'
      : 'The application email route changed before Litos could finish employer verification. The already authorized parent remains unresolved. Check the employer portal and record whether this exact application was received.';
  return nextReview(current, {
    ...unverifiedSubmissionPatch(current, {
      at: attemptedAt ?? securityCode.requested_at,
      cause: 'no_confirmation_state',
    }),
    submission_attempted_at: current.submission_attempted_at ?? attemptedAt ?? securityCode.requested_at,
    security_code: securityCode,
    verification: {
      ...current.verification,
      status: 'verification_pending',
      requested_at: securityCode.requested_at,
      retry_count: current.verification?.retry_count ?? 0,
    },
    submission_error: cause === 'authorization_revoked'
      ? 'Submission authorization was revoked before security-code continuation'
      : cause === 'email_permission_revoked'
        ? 'Automatic inbox verification was disabled before security-code continuation'
        : 'Application email route changed before security-code continuation',
    attention_reason: attentionReason,
    attention_categories: ['security_code', 'unverified_submission'],
  });
}

/**
 * A retained verification capability can be refused after the parent application was already
 * pressed. This is not an initial pre-click stop: the parent claim and immutable risk must remain.
 * Persist the applicant's exact resolution door without writing machine not-sent evidence.
 */
export function managedSecurityCodeContinuationRefusalReview(
  current: ApplicationReviewState,
  reason: ManagedSecurityCodeContinuationRefusedError['reason'],
  observedAt: string,
  securityCode: NonNullable<ApplicationReviewState['security_code']>,
): ApplicationReviewState {
  const detail = reason === 'lease_window_too_short'
    ? 'The retained employer verification session did not have enough time left for one bounded, safely recorded continuation.'
    : 'A duplicate-safety fact appeared before the retained employer verification session could continue.';
  return nextReview(current, {
    ...unverifiedSubmissionPatch(current, {
      at: observedAt,
      cause: 'no_confirmation_state',
    }),
    verification: current.verification
      ? {
        ...current.verification,
        status: 'verification_pending',
        continuation_resumed: false,
        continuation_call_started_at: undefined,
        continuation_call_deadline_at: undefined,
      }
      : { status: 'verification_pending' },
    security_code: securityCode,
    submission_error: detail,
    attention_reason: `${detail} Check the employer portal and record whether this exact application was received.`,
    attention_categories: ['security_code', 'unverified_submission'],
  });
}

/** A delayed post-authorization code wall retains the parent and opens only human resolution. */
export function delayedSecurityCodeHandoffReview(
  current: ApplicationReviewState,
  input: {
    securityCode: NonNullable<ApplicationReviewState['security_code']>;
    verification: NonNullable<ApplicationReviewState['verification']>;
    attemptedAt: string;
    screenshotUrl: string;
  },
): ApplicationReviewState {
  return nextReview(current, {
    ...unverifiedSubmissionPatch(current, {
      at: input.attemptedAt,
      cause: 'no_confirmation_state',
    }),
    verification: mergeManagedVerificationEvidence(current.verification, input.verification),
    security_code: mergeManagedSecurityCodeEvidence(current.security_code, input.securityCode),
    submission_attempted_at: input.attemptedAt,
    preview_screenshot_url: input.screenshotUrl,
    submission_error: undefined,
    attention_reason: 'The employer showed a verification-code step after Litos used its receipt check. The authorized parent remains unresolved. Check the employer portal and record whether this exact application was received.',
    attention_categories: ['security_code', 'unverified_submission'],
  });
}

/* THE PATCH FOR "LITOS DOES NOT KNOW", IN ONE PLACE.
 *
 * Two call sites reach it - a run that finished and could not read a confirmation, and a run that
 * was cut off mid-submit - and they must write the same shape or the resolution route has two
 * states to handle instead of one.
 *
 * Three things are written that the Skydio packet did not have.
 *
 *   submission_attempted_at. The click happened, or may have. That is the fact every downstream
 *   reader needs and nothing on the row was carrying it.
 *
 *   unverified_submission. The structured half: when, why, and where to look. The row can now be
 *   found by a query rather than by grepping prose, and the resolution route has something to
 *   resolve.
 *
 *   The CLAIM IS KEPT. Deliberately. The claim is what stops the ordinary path re-running and
 *   sending a second application to an employer who may already have the first, and that protection
 *   is exactly right here. What was wrong before was not the lock, it was that there was no key: the
 *   applicant is now asked a question whose answer unlocks it, instead of being told to try again by
 *   a system that would refuse her.
 */
function unverifiedSubmissionPatch(
  review: ApplicationReviewState,
  input: {
    at: string;
    cause: NonNullable<ApplicationReviewState['unverified_submission']>['cause'];
    previewUrl?: string;
    /* The runner's record of what the submit request came back with. Carried on the record so the
     * person (or session) resolving it has the one fact the page refused to show. */
    network?: NonNullable<ApplicationReviewState['unverified_submission']>['network'];
    /* The runner's own CAPTCHA blocker was standing when the run ended: a rendered challenge over
     * the pressed form. Selects the human-check sentence and travels on the record. */
    challengeOnScreen?: boolean;
  },
): Partial<ApplicationReviewState> {
  return {
    status: 'needs_attention',
    submission_attempted_at: input.at,
    ...(input.previewUrl ? { preview_screenshot_url: input.previewUrl } : {}),
    unverified_submission: {
      at: input.at,
      cause: input.cause,
      ...(review.portal_url ? { portal_url: review.portal_url } : {}),
      ...(review.submission_run_id ? { submission_run_id: review.submission_run_id } : {}),
      ...(input.network && input.network.length > 0 ? { network: input.network } : {}),
      ...(input.challengeOnScreen ? { challenge_on_screen: true as const } : {}),
    },
    attention_reason: unverifiedSubmissionReason({
      atsName: review.ats_name,
      portalUrl: review.portal_url,
      cause: input.cause,
      network: input.network ?? null,
      challengeOnScreen: input.challengeOnScreen,
    }),
    attention_categories: ['unverified_submission'],
  };
}

export function isProviderSessionFailureMessage(message: string): boolean {
  return /sandbox stream was closed|not accepting commands/i.test(message);
}

/**
 * Linearize a runner failure against authorization, terminal evidence, and the packet projection.
 * A stale caller either updates the exact still-current attempt or writes nothing.
 */
export async function recordSubmissionRunnerFailure(
  row: ResumeRow,
  cause: unknown,
  securityCodeAttemptFingerprint?: string,
): Promise<boolean> {
  const actedOnReview = readApplicationReview(row.spec);
  if (!actedOnReview) return false;
  return db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, row.user_id);
    const [latest] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, row.user_id),
    )).limit(1);
    const latestReview = latest ? readApplicationReview(latest.spec) : null;
    if (!latest || !latestReview
      || (latestReview.submission_run_id ?? null) !== (actedOnReview.submission_run_id ?? null)) {
      return false;
    }
    const attemptId = actedOnReview.submission_claim_id;
    if (attemptId && latestReview.submission_claim_id !== attemptId) return false;
    const exactEvents = attemptId
      ? (await submissionAttemptEventsForPacket(row.user_id, row.id, { executor: tx }))
        .filter((event) => event.attempt_id === attemptId)
      : [];
    if (exactEvents.some((event) => event.event_kind === 'submission_confirmed'
        || event.event_kind === 'not_sent_proven')) return false;

    let failed = submissionFailureReview(latestReview, cause);
    if (securityCodeAttemptFingerprint && failed.security_code) {
      failed = nextReview(failed, {
        security_code: withSecurityCodeAttempt(failed.security_code, {
          at: new Date().toISOString(),
          fingerprint: securityCodeAttemptFingerprint,
          outcome: 'error',
        }),
      });
    }
    const boundary = attemptId
      ? await submissionBoundaryAuthorization(row.user_id, attemptId, { executor: tx })
      : null;
    if (boundary) {
      const securityCode = mergeManagedSecurityCodeEvidence(
        latestReview.security_code,
        failed.security_code,
      );
      const verification = mergeManagedVerificationEvidence(
        latestReview.verification,
        failed.verification,
      );
      failed = nextReview(latestReview, {
        ...unverifiedSubmissionPatch(latestReview, {
          at: boundary.serverNow,
          cause: 'provider_error',
        }),
        ...(securityCode ? { security_code: securityCode } : {}),
        ...(verification ? { verification } : {}),
        submission_error: failed.submission_error
          ?? (cause instanceof Error ? cause.message : 'Submission runner failed'),
        attention_reason: failed.attention_reason
          ?? 'Litos could not prove the final employer result. Check the employer portal and record whether this exact application was received.',
        attention_categories: failed.attention_categories?.length
          ? [...new Set([...failed.attention_categories, 'unverified_submission' as const])]
          : ['unverified_submission'],
      });
    } else if (attemptId && !failed.submission_claim_id) {
      const opening = exactEvents.find((event) => event.event_kind === 'attempt_opened');
      if (!opening) throw new Error('Submission attempt reservation was not durably recorded');
      const binding = submissionAttemptBindingFromEvent(opening);
      await appendSubmissionAttemptEvent({
        ...binding,
        eventId: submissionAttemptEventId(attemptId, 'not_sent_proven', 'typed-runner-stop'),
        eventKind: 'not_sent_proven',
        proofKind: 'typed_pre_click_stop',
        evidenceCode: failed.submission_stop?.reason ?? 'typed_pre_click_stop',
      }, { executor: tx });
    }

    const updated = await tx.update(generated_resumes).set({
      spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(failed)}::jsonb, true)`,
    }).where(and(
      eq(generated_resumes.id, latest.id),
      eq(generated_resumes.user_id, latest.user_id),
      sql`${generated_resumes.spec} = ${JSON.stringify(latest.spec)}::jsonb`,
    )).returning({ id: generated_resumes.id });
    if (updated.length === 0) throw new FinalSubmissionBoundaryChangedError();
    return true;
  });
}

async function fail(row: ResumeRow, error: unknown, securityCodeAttemptFingerprint?: string) {
  const actedOnRow = error instanceof SubmissionExecutionError ? error.actedOnRow : row;
  const cause = error instanceof SubmissionExecutionError ? error.submissionCause : error;
  await recordSubmissionRunnerFailure(actedOnRow, cause, securityCodeAttemptFingerprint);
}

/* WHAT A STOPPED RUN LEAVES ON THE ROW, AND WHETHER THE ROW CAN STILL BE MOVED AFTERWARDS.
 *
 * EXTRACTED FROM fail() SO IT CAN BE DRIVEN. Everything below used to sit inside a function that
 * needs a database and a live runner to reach, so the only thing watching it was a pair of tests
 * that read this file as text and matched regexes against it - which cannot tell a correct branch
 * from a deleted one, and is how the defect this function now fixes survived two rounds of repair.
 * fail() keeps the database read and the write; every decision is here, pure, and tested by calling
 * it with real error instances.
 *
 * THE DEFECT. The claim is taken at the top of a send run, so ANY throw after that point leaves it
 * on the row. Only two families ever took it off - regenerationRequired/packetDocumentExpired, and
 * the noSubmitControl branch - so ManagedActionBudgetError, CaptchaUnresolvedError, a provider
 * session failure and every generic throw landed at needs_attention wearing the claim and carrying
 * no unverified_submission record. That combination closes all four exits at once:
 * submitRequestDisposition refuses a claimed needs_attention row, resumeEditDisposition delegates to
 * it, the security-code route wants a different status, and the unverified-resolution route wants a
 * record nobody wrote. The comment that used to sit on actionBudgetStop described this trap as
 * something that arm had dealt with. It had not; it fixed the SENTENCE the applicant reads and left
 * the lock exactly where it was.
 *
 * THE RULE, and it is one rule rather than a list of arms:
 *
 *   A stop that PROVABLY preceded the click does not carry the claim forward.
 *   A stop that cannot be proven pre-click keeps the claim AND is given an exit.
 *
 * "Provably" is two things and needs both. The typed stop reason must be one whose throw site is
 * structurally ahead of the click, and the row's own evidence must agree - the same five refusals
 * submissionProvablyNotSent already applies, because a CAPTCHA standing on a page can be there
 * BECAUSE an earlier attempt submitted, and a stop record describes this run only. Where the proof
 * fails, the lock is right and stays, and the row gets an unverified_submission record so POST
 * /applications/:id/submission/unverified can reach it. A locked row with a route out is a safety
 * property. A locked row with no route is the defect.
 */
export function submissionFailureReview(
  current: ApplicationReviewState,
  error: unknown,
  now: () => string = () => new Date().toISOString(),
): ApplicationReviewState {
  if (error instanceof FinalSubmissionBoundaryChangedError) {
    return nextReview(current, {
      status: 'needs_attention',
      ...preClickNoSubmitReleasePatch(),
      submission_error: error.message,
      attention_reason: 'This submission changed after its employer attempt was reserved, so Litos stopped before sending anything. Reload the application before trying again.',
      attention_categories: ['evidence_gap'],
    });
  }
  if (error instanceof SubmissionAccountDeletionDrainError) {
    return nextReview(current, {
      status: 'needs_attention',
      ...preClickNoSubmitReleasePatch(),
      submission_error: error.message,
      attention_reason: 'Account deletion paused this submission before Litos contacted the employer.',
      attention_categories: ['evidence_gap'],
    });
  }
  if (error instanceof FinalSubmissionAuthorizationChangedError) {
    return nextReview(current, {
      status: 'ready_for_final_approval',
      ...preClickNoSubmitReleasePatch(),
      submission_error: error.message,
      attention_reason: 'Submission permission changed before the employer send. Review this application and approve it again before retrying.',
      attention_categories: ['evidence_gap'],
    });
  }
  if (error instanceof FinalSubmissionBoundaryBlockedError) {
    return nextReview(current, {
      status: 'needs_attention',
      ...preClickNoSubmitReleasePatch(),
      submission_error: 'Submission withheld by the final duplicate-safety recheck',
      attention_reason: error.verdict.reason,
      attention_categories: [error.verdict.kind === 'duplicate'
        && error.verdict.match.certainty === 'submitted'
        ? 'duplicate_application'
        : 'unverified_submission'],
    });
  }
  const message = error instanceof Error ? error.message : 'Submission runner failed';
  const externalGate = /browserbase|stratus managed browser is not configured|secure browser provider is not configured/i.test(message);
  const providerSessionFailureBeforeSubmit = error instanceof ManagedBrowserPreSubmitCrashError;
  const fieldProofFailedBeforeSubmit = error instanceof ManagedBrowserAssertionFailureError;
  const providerSessionFailure = providerSessionFailureBeforeSubmit || isProviderSessionFailureMessage(message);
  const uncertainAfterClaim = Boolean(current.submission_claimed_at);
  const stoppedAt = now();

  // Takes precedence over uncertainAfterClaim, and that precedence is the whole point. The claim is
  // taken at the top of the run, so by the time clickFinalSubmit refuses to press the button this is
  // ALWAYS "uncertain after claim" - and that branch says the submission was attempted and could not
  // be verified. Here the opposite is true and known: the click provably did not happen, so nothing
  // was sent. Telling someone to go check their email for a confirmation of an application that was
  // never submitted sends them looking for a receipt that cannot exist, and costs the trust to
  // believe the next message. Same reasoning as portalHandoffReason vs unattendedHandoffReason.
  const captchaError = error instanceof CaptchaUnresolvedError ? error : null;
  const captchaStop = captchaError?.stage ?? null;
  /* Same precedence, same reason as the captcha branch above. When clickFinalSubmit finds no
     submit control the click PROVABLY did not happen, so uncertainAfterClaim's "check the portal
     or your email" is the one thing that must not be said: there is no receipt to find. This is
     the routine outcome on a multi-step first page, not an edge case. */
  /* A managed no-control stop reaches this branch only after the v4 telemetry, exact URL proof,
     screenshot, and no-click result were validated and converted to the typed error. The legacy
     runner sentence is not proof and stays on the unverified path. */
  const noSubmitControl = error instanceof NoSubmitControlError;
  /* A MEMBER OF THAT FAMILY THAT IS NOT A MISSING BUTTON. The run found the submit control, bound
     it uniquely, and withheld the press because a required answer could not be confirmed. The
     pre-click classification above is right and is kept, including the release and everything
     preClickNoSubmitReleasePatch erases; only the sentence differs, and it differed by inheritance
     rather than by decision. */
  const requiredFieldConfirmation = error instanceof ManagedRequiredFieldConfirmationError;
  const regenerationRequired = error instanceof ApplicantEmailRegenerationRequiredError;
  /* The third member of the same family as the two branches above, and it arrives with proof.
     buildManagedPortalActions throws this while ASSEMBLING the action list, before runManagedBrowser
     is called at all, and it records submitActionAppended: false to say so. So the click provably
     did not happen and nothing reached the employer. */
  const actionBudgetStop = error instanceof ManagedActionBudgetError ? error.blocker : null;
  /* Only the resume. An expired cover letter never reaches here: packetForCoverLetterCapability
     degrades and the application still goes, with its own sentence. */
  const packetDocumentExpired = error instanceof PacketDocumentExpiredError && error.document === 'resume';
  /* The reporting barrier could not read the run's proof, so the click state is UNKNOWN. This must
     never join the pre-click family above: the remote actions had already executed when the read
     failed, and on 2026-08-11 the runner had actually pressed Submit. It classifies as its own
     typed stop, keeps the claim, and takes the unverified exit below. */
  const confirmationUnproven = error instanceof ManagedConfirmationUnprovenError;
  const runTimedOut = isManagedRunTimeout(message);

  /* THE TYPED HALF, written on every arm including the ones that release outright.
     Deliberately derived from the SAME booleans the applicant's sentence is derived from, so the
     prose and the record cannot disagree about what stopped this run. */
  const stop = submissionStopRecord(
    classifySubmissionStop({
      captchaStop,
      noSubmitControl,
      regenerationRequired,
      packetDocumentExpired,
      actionBudget: actionBudgetStop !== null,
      confirmationUnproven,
      fieldProofFailedBeforeSubmit,
      providerSessionFailureBeforeSubmit,
      providerSessionFailure,
      runTimedOut,
      providerUnconfigured: externalGate,
    }),
    stoppedAt,
    current.submission_run_id,
  );

  /* THE CHOOSER STOP KEEPS ITS OWN WRITER, because it clears more than the claim.
     preClickNoSubmitReleasePatch also removes submission_attempted_at, submitted_at and the receipt,
     which is PR 494's decision about a stop known to happen before submitHandle.click, and folding
     it into the general rule below would quietly change what that branch erases. */
  if (noSubmitControl) return preClickNoSubmitReview(current, message, now, requiredFieldConfirmation);

  /* CAN THIS ROW PROVE NOTHING WAS SENT? The typed stop is offered to the row's own evidence rather
     than trusted on its own. submissionProvablyNotSent still refuses a receipt, a standing code
     wall, an unresolved unverified record, a recorded attempt and a pressed:true outcome, so a
     pre-click stop on a row that already carries any of those does NOT release anything. */
  const provablyNotSent = submissionProvablyNotSent({ ...current, submission_stop: stop });
  const releasesClaim = uncertainAfterClaim && provablyNotSent;
  /* A claim held with no proof behind it. Every such row must leave here with a door, and the only
     door that fits a state nobody can classify is the applicant's own look at the employer page. */
  const needsExit = uncertainAfterClaim && !releasesClaim && !current.unverified_submission;

  const outcome = submissionFailureOutcome({
    captchaStop, noSubmitControl, regenerationRequired, packetDocumentExpired, actionBudgetStop, fieldProofFailedBeforeSubmit, uncertainAfterClaim, externalGate, providerSessionFailure,
    currentAttentionReason: current.attention_reason,
  });

  return nextReview(current, {
    ...(captchaError
      ? beginStall(current, {
        surface: 'server_run',
        provider: captchaError.provider,
        stage: captchaError.stage,
        source: 'observed',
      })
      : {}),
    status: outcome.status,
    submission_stop: stop,
    ...(current.verification?.status === 'searching'
      ? {
        verification: {
          ...current.verification,
          status: 'verification_pending' as const,
        },
      }
      : {}),
    submission_error: message,
    attention_reason: outcome.attentionReason,
    // The typed half. attention_reason is prose written for the applicant and cannot be counted;
    // without this a 'failed' row was unqueryable as well as unreadable, so "how often does the
    // runner break, and on what" had no answer at all.
    attention_categories: outcome.attentionCategories.length > 0 ? outcome.attentionCategories : undefined,
    /* THE RELEASE, ON THE WRITE PATH AND NOT ONLY ON A READ GATE.
       regenerationRequired and packetDocumentExpired used to be listed here by name; both are now
       covered by the rule, because both throw before a browser drives the form and both therefore
       classify pre-click. What the rule adds is every other pre-click stop - the action-budget throw
       above all - and what it takes away is the case those two names got wrong: a row that already
       carries send evidence keeps its lock even when this run stopped early. */
    ...(releasesClaim
      ? {
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
        submission_authorization: undefined,
      }
      : {}),
    /* THE EXIT, for the stops that keep their lock. Last in the object on purpose: it overrides the
       status and the sentence above with the resolvable pair - submission_attempted_at and the
       unverified_submission record - which is what POST /submission/unverified resolves and what
       turns a terminal row into one the applicant can answer. The cause is the run's own, so
       "Litos pressed Send and the secure browser failed" is only said where that is what happened. */
    ...(needsExit
      ? unverifiedSubmissionPatch(current, {
        at: stoppedAt,
        cause: runTimedOut ? 'run_timed_out' : providerSessionFailure ? 'provider_error' : 'no_confirmation_state',
      })
      : {}),
  });
}

export type SecurityCodeSubmissionOutcome =
  | { kind: 'not_found' }
  /* The packet is not waiting on a code. Covers the ordinary races - it was finished in another tab,
   * or the state moved on - and is deliberately distinct from a rejected code. */
  | { kind: 'not_awaiting'; status: ApplicationReviewState['status'] }
  | { kind: 'invalid_code' }
  /* This exact code was already tried. The stored outcome is returned and NO RUN IS MADE, which is
   * the whole idempotency guarantee: a double-click, a retried request or a refreshed page cannot
   * put a second application in front of an employer. */
  | { kind: 'already_attempted'; outcome: SecurityCodeAttempt['outcome']; review: ApplicationReviewState }
  | { kind: 'manual_review_required'; review: ApplicationReviewState }
  | { kind: 'done'; review: ApplicationReviewState };

/**
 * Compatibility-only refusal for the retired manual email-code continuation.
 *
 * Mailbox APIs and Receiving API headers do not independently prove sender authority. A typed code
 * also cannot safely restart the parent form, because that new submit can issue and invalidate a
 * different code. The public route now returns a review-only response without calling this helper,
 * and this export remains hard-fenced so an old or future caller cannot revive the unsafe flow.
 */
export async function finishSecurityCodeSubmission(
  applicationId: string,
  rawCode: unknown,
  fastify: FastifyInstance,
): Promise<SecurityCodeSubmissionOutcome> {
  // Generic mailbox headers do not establish sender authority. This legacy entry point stays
  // exported only for compatibility, but it cannot claim a packet, open an employer session, or
  // spend the applicant's typed value. The authenticated route now returns the same review-only
  // result directly. Keeping the refusal here prevents a future caller from reconnecting the old
  // submit-and-reread loop by importing this function.
  void rawCode;
  void fastify;
  const rows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  const row = rows[0];
  if (!row) return { kind: 'not_found' };
  const current = readApplicationReview(row.spec);
  if (!current) return { kind: 'not_found' };
  if (current.status !== 'awaiting_security_code' || !current.security_code) {
    return { kind: 'not_awaiting', status: current.status };
  }
  return { kind: 'manual_review_required', review: current };
}

// `unattended` is the CRON path saying "nobody is watching this run", and it is deliberately not
// derived from standing consent. Consent is a persistent setting: a user who turned auto-submit on
// is still sitting at their dashboard when they press submit on a Paylocity job, and deriving
// "away" from "consented" would take fill-and-hand-off away from exactly the people who opted into
// the product most. Provenance is a property of the caller, so the caller passes it.
export async function processSubmissionApplication(
  applicationId: string,
  fastify: FastifyInstance,
  options: { unattended?: boolean } = {},
): Promise<ApplicationReviewState | null> {
  const rows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  let activeRow = row;
  try {
    let review = readApplicationReview(activeRow.spec);
    if (submissionClaimIsHeld(review) || managedSecurityCodeContinuationRecoveryIsHeld(review)) {
      const attemptBinding = await persistedRunnerAttemptBinding(activeRow, review!);
      const recovery = await recoverManagedSubmissionTerminalResult(
        activeRow,
        review!,
        attemptBinding,
        fastify,
      );
      if (recovery !== 'not_recoverable') {
        const recovered = await db.select().from(generated_resumes)
          .where(eq(generated_resumes.id, applicationId)).limit(1);
        return recovered[0] ? readApplicationReview(recovered[0].spec) : null;
      }
    }
    if (review && (review.status === 'submit_requested' || review.status === 'submitting')) {
      const leadIssues = runnerLeadAlignmentIssues(activeRow);
      if (leadIssues.length > 0) {
        await withholdInvalidLeadAlignment(activeRow, review, leadIssues);
        const withheld = await db.select().from(generated_resumes)
          .where(eq(generated_resumes.id, applicationId)).limit(1);
        return withheld[0] ? readApplicationReview(withheld[0].spec) : null;
      }
    }
    if (review?.status === 'submit_requested') {
      const claimed = await claimPreparation(activeRow);
      if (!claimed) return review;
      activeRow = claimed;
      await prepare(activeRow, fastify, options.unattended === true);
      const prepared = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
      if (prepared[0]) activeRow = prepared[0];
      review = readApplicationReview(activeRow.spec);
    }
    if (review?.status === 'submitting') await submit(activeRow, fastify);
  } catch (error) {
    const cause = error instanceof SubmissionExecutionError ? error.submissionCause : error;
    fastify.log.error({
      err: cause,
      applicationId: row.id,
      ...privateRunnerStepDiagnostic(cause),
    }, 'Application runner step failed');
    await fail(activeRow, error);
  }
  const refreshed = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  return refreshed[0] ? readApplicationReview(refreshed[0].spec) : null;
}

export async function submissionRunnerRoutes(fastify: FastifyInstance) {
  fastify.get('/internal/application-submission-runner', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) return reply.status(401).send({ error: 'Unauthorized' });
    if (!isBrowserbaseConfigured()) return reply.status(503).send({ error: 'Litos cannot fill in company pages yet. Not configured', processed: 0 });
    const startedAt = Date.now();
    // Terminal cleanup is its own durable queue. A packet leaves the submission selector as soon as
    // its employer result is folded, so acknowledgement retries must run before and independently
    // of the application work below.
    const cleanup = await retryManagedTerminalCleanupOutbox(fastify);
    // Oldest first. Without an order the queue is whatever Postgres returns, so a row could sit
    // behind newer ones indefinitely once the queue is longer than one batch.
    //
    // Ordinary claimed rows remain excluded. A managed claim with an immutable boundary fact is
    // included only so the runner can retrieve its retained terminal result without relaunching.
    const rows = await db
      .select()
      .from(generated_resumes)
      .where(sql`(
        (${generated_resumes.spec}->'_review'->>'status' in ('submit_requested', 'submitting')
          and ${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null)
        or (${generated_resumes.spec}->'_review'->>'submission_claimed_at' is not null
          and (
            ${generated_resumes.spec}->'_review'->>'status' = 'submitting'
            or (
              ${generated_resumes.spec}->'_review'->'verification'->>'runner' = 'stratus-managed'
              and (
                (${generated_resumes.spec}->'_review'->'verification'->>'status' = 'searching'
                  and ${generated_resumes.spec}->'_review'->'verification'->>'continuation_resumed' = 'false')
                or (${generated_resumes.spec}->'_review'->'verification'->>'status' = 'verification_pending'
                  and ${generated_resumes.spec}->'_review'->'verification'->>'continuation_resumed' = 'true')
              )
            )
          )
          and exists (
            select 1 from application_submission_attempt_events recovery_event
            where recovery_event.user_id = ${generated_resumes.user_id}
              and recovery_event.packet_id = ${generated_resumes.id}
              and recovery_event.attempt_id::text = ${generated_resumes.spec}->'_review'->>'submission_claim_id'
              and recovery_event.event_kind = 'boundary_authorized'
              and recovery_event.source = 'managed_browser'
          ))
      )`)
      .orderBy(generated_resumes.created_at)
      .limit(submissionBatchSize());
    const cap = dailySubmissionCap();
    let processed = 0;
    let deferredForTime = 0;
    let deferredForCap = 0;
    for (const row of rows) {
      if (!hasTimeForAnotherApplication(Date.now() - startedAt)) {
        deferredForTime = rows.length - processed - deferredForCap;
        break;
      }
      // Recounted per row rather than cached per invocation. The count is a snapshot either way,
      // but a per-invocation cache stays stale for the whole batch, so a run alongside the manual
      // submit endpoint could overshoot by the length of the batch. Per row, the stale window
      // shrinks to one application. This is a ceiling check on a rare path, not a lock: the exact
      // guarantee is "about the cap", and buying an exact one costs a database counter updated
      // inside the submission claim.
      const queuedReview = readApplicationReview(row.spec);
      const recoveringExistingAttempt = submissionClaimIsHeld(queuedReview)
        || managedSecurityCodeContinuationRecoveryIsHeld(queuedReview);
      if (!recoveringExistingAttempt) {
        const already = await countSubmissionsClaimedToday(row.user_id);
        if (!withinDailyCap(already, cap)) {
          deferredForCap += 1;
          continue;
        }
      }
      try {
        await processSubmissionApplication(row.id, fastify, { unattended: true });
        processed += 1;
      } catch (error) {
        fastify.log.error({
          err: error,
          applicationId: row.id,
          ...privateRunnerStepDiagnostic(error),
        }, 'Application runner step failed');
        await fail(row, error);
      }
    }
    // Logged, never silent. A queue that stops moving because everyone hit the cap looks exactly
    // like an empty queue from the outside, which is the failure mode that kept the jobs board at
    // zero postings for months.
    if (deferredForTime || deferredForCap) {
      fastify.log.info(
        { deferredForTime, deferredForCap, cap },
        'Submission batch ended with applications still queued',
      );
    }
    return reply.send({
      processed,
      deferred_for_time: deferredForTime,
      deferred_for_cap: deferredForCap,
      cleanup_acknowledgements_attempted: cleanup.attempted,
      cleanup_acknowledgements_completed: cleanup.completed,
      configured: true,
    });
  });
}
