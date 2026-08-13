import { randomUUID } from 'node:crypto';
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
import {
  normalizeApplicationReviewQuestions,
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
  continueManagedBrowser,
  createBrowserContext,
  createBrowserSession,
  getBrowserSession,
  HANDOFF_WINDOW_MS,
  isBrowserbaseConfigured,
  isManagedStratusProvider,
  managedApplicationSubmitOptions,
  managedContinuationFingerprint,
  runManagedBrowser,
} from '../lib/browserbase';
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
  budgetDroppedReviewedQuestions,
  attachManagedFieldOptions,
  buildManagedDiscoveredOptionProbeBatches,
  managedOptionProbeAnalysis,
  managedOptionProbeControlId,
  managedUnexplainedAnswers,
  managedUnexplainedAnswerReasons,
  managedResultFieldOptions,
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
  portalCanAutoSubmit,
  portalHandoffReason,
  readManagedReceipt,
  unattendedHandoffReason,
  readReceipt,
  type SubmissionPacket,
  type SupportedPortal,
  ManagedActionBudgetError,
  ManagedConfirmationUnprovenError,
  assertManagedRequiredFieldsConfirmed,
  managedApplicationProofIsRequired,
  NoSubmitControlError,
} from '../lib/portalSubmission';
import {
  isManagedNoSubmitControl,
  isManagedRunTimeout,
  managedSubmitVerdict,
  observeManagedReceiptOnce,
  readManagedSubmitOutcome,
  submissionProvablyNotSent,
  unverifiedSubmissionReason,
} from '../lib/managedSubmitOutcome';
import { classifySubmissionStop, submissionClaimPatch, submissionStopRecord } from '../lib/submissionStop';
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
import { rerenderFrozenCoverLetter } from '../lib/packetDocumentRecovery';
import { PACKET_EXPIRED_REASON } from '../lib/packetResumeRestore';
import { currentAcknowledgedPacketAudit, currentPacketAudit } from '../lib/packetAuditService';
import { createDashboardHandoffBinding } from '../lib/extensionHandoffPacket';
import { decryptRow } from './applicationProfile';
import { readExperienceBank } from '../db/experienceBank';
import { declaredSkillsList } from './profile';
import { applicantGroundingFacts, draftApplicationAnswer, type ApplicantGroundingFacts } from '../llm/applicationAnswer';
import { isBillingOrAuthFailure } from './resume';
import {
  completeEmailVerificationIfPresent,
  managedResultNeedsEmailVerification,
  prepareManagedEmailVerification,
  type BrowserVerificationResult,
} from '../lib/browserVerification';
import {
  discoverPageQuestions,
  discoveredFieldIsRequired,
  consentAcknowledgementLicence,
  isCoreIdentityField,
  isOpenEndedQuestion,
  isRefusedQuestion,
  normalizeDiscoveredLabel,
  normalizeReviewQuestionLabel,
  normalizeStoredPortalQuestions,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  fitToBudget,
  frozenJobEmployerContext,
  frozenJobLocationContext,
  frozenJobRelocationLocationContext,
  WORK_ELIGIBILITY_QUESTION,
  workEligibilitySkipReason,
  discoveredFieldIsNotAQuestion,
  type ApplicationProfileLike,
  type DiscoveredQuestion,
  controlCanAcceptADocument,
} from '../lib/questionDiscovery';
import { isSelfDeclarationQuestion, selfDeclarationSkipReason } from '../lib/selfDeclaration';
import {
  referralSourceForApplication,
  type ReferralSourceEvidence,
} from '../lib/referralSource';
import { savedAnswerFor, type AnswerReuseContext } from '../lib/answerReuse';
import { profileBackedBlockerLabels, resolveProfileField, usableOptions } from '../lib/profileFieldResolution';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import { loadSavedAnswers } from '../lib/savedAnswerStore';
import type { ApplicationReviewQuestion } from '../lib/applicationReview';
import { jobCountry, postingCountryCodeFromJobContext, postingCountryFromJobContext } from '../lib/jobLocation';
import { generateStoredCoverLetter, storedCoverLetter } from '../lib/coverLetterService';
import { repairReviewPortalFromMonitoredJob } from '../lib/applicationPortalRepair';
import { selectApplicationProfileRow } from '../lib/applicationFacts';
import { mayClickFinalSubmit, preparedSubmissionStatus } from '../lib/submissionAuthorization';
import { blankRequiredQuestionLabels, directPreparationIsSafe } from '../lib/submissionSafety';
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
import { assessAtsSubmissionChannel, tryAtsSubmissionChannel } from '../lib/atsSubmissionChannels';
import { duplicateApplicationVerdict } from '../lib/duplicateApplication';
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
  await writeReview(row, review);
  return review;
}

export function atsApiSubmissionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LITOS_ATS_API_SUBMISSION_ENABLED === 'true';
}

async function writeReview(row: ResumeRow, review: ApplicationReviewState) {
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(review)}::jsonb, true)`,
  }).where(eq(generated_resumes.id, row.id));
}

async function standingAuthorization(userId: string): Promise<StandingAuthorization> {
  const [user] = await db.select({
    enabled: users.automatic_submission_enabled,
    consentedAt: users.automatic_submission_consented_at,
    consentVersion: users.automatic_submission_consent_version,
  }).from(users).where(eq(users.id, userId)).limit(1);
  return {
    enabled: user?.enabled === true,
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

async function claimSubmission(row: ResumeRow, alreadyHeld = false): Promise<ResumeRow | null> {
  const current = readApplicationReview(row.spec);
  if (alreadyHeld) return submissionClaimIsHeld(current) ? row : null;
  if (!current || current.status !== 'submitting' || current.submission_claimed_at) return null;
  const claimed = nextReview(current, submissionClaimPatch(new Date().toISOString(), randomUUID()));
  const rows = await db.update(generated_resumes)
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
  return rows[0] ?? null;
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
  const rows = await db.update(generated_resumes)
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
  return rows[0] ?? null;
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

async function holdRevokedSubmission(row: ResumeRow, review: ApplicationReviewState) {
  await writeReview(row, nextReview(review, {
    status: 'ready_for_final_approval',
    submission_authorization: undefined,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
  }));
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
  fetchObject: (url: string) => Promise<{ ok: boolean; arrayBuffer: () => Promise<ArrayBuffer> }>;
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
  const blobUrl = await dependencies.resolveObjectUrl(objectKey);
  /* Typed, because this is the retention sweep arriving rather than a malfunction. See
     PacketDocumentExpiredError for why an untyped throw here told the applicant to go and look for
     a confirmation of an application that was never filled in. Only the resolve is typed: a key that
     resolves to a URL which then fails to download is a live storage fault, not an expired packet,
     and the two owe different sentences. */
  if (!blobUrl) throw new PacketDocumentExpiredError('resume');
  const response = await dependencies.fetchObject(blobUrl);
  if (!response.ok) throw new Error('Generated resume file could not be downloaded');
  return Buffer.from(await response.arrayBuffer());
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

export async function buildPacket(row: ResumeRow, controlledTest = false): Promise<SubmissionPacket> {
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
  const resume = await resumeBytesForPacket(row.resume_object_key, controlledTest);
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
  const refreshedQuestions = refreshKnownQuestionAnswers(
    review.questions,
    applicationProfile,
    applicationContextForQuestionResolution(row, review),
    review.questions_reviewed_at,
    postingCountryFromJobContext(row.job_context),
    postingCountryCodeFromJobContext(row.job_context),
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
    roleLocation: typeof context.location === 'string' ? context.location : undefined,
    roleLocations,
    roleCountry: postingCountryFromJobContext(row.job_context),
    roleCountryCode: postingCountryCodeFromJobContext(row.job_context),
    applicationProfile,
    applicantSnapshot,
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
    questions: refreshedQuestions.map((item) => ({
      question: item.question,
      answer: item.answer,
      portalSelector: item.portal_selector,
      portalInputType: item.portal_input_type,
      atsApiField: item.ats_api_field,
      // Carried through so the fill can tell an option the resolver read off this control from a
      // profile value that merely survived the refresh. Dropping it here would leave the fill
      // unable to distinguish them and it would fall back to the computed bucket, which is exactly
      // the state this packet was in before. See greenhouseReviewedAnswerIsResolved.
      answerOptionSource: item.answer_option_source,
    })),
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

const REQUIRED_AND_EMPTY_BLOCKER = /^"(.+)" is required and is still empty$/;

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
): Promise<{ packet: SubmissionPacket; coverLetterIssue?: string }> {
  if (!supported) return { packet: omitCoverLetter(await buildPacket(row, controlledTest)) };
  if (!storedCoverLetter(row)) {
    try {
      await generateStoredCoverLetter(row, false, true);
    } catch (error) {
      // Raw message to the log, fixed sentence to the applicant. See the note above the function.
      fastify.log.warn({ error, applicationId: row.id }, 'Cover letter generation failed, continuing without it');
      return {
        packet: omitCoverLetter(await buildPacket(row, controlledTest)),
        coverLetterIssue: 'We could not write your cover letter for this one, so it is not attached. Everything else is filled in, and you can write or retry a cover letter from your dashboard.',
      };
    }
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
    return { packet: await buildPacket(rows[0], controlledTest) };
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
    return {
      packet: omitCoverLetter(await buildPacket(
        { ...rows[0], spec: strippedCoverLetterSpec(rows[0].spec) },
        controlledTest,
      )),
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

export function applicationContextForQuestionResolution(row: ResumeRow, current: ApplicationReviewState): string {
  const context = (row.job_context && typeof row.job_context === 'object' ? row.job_context : {}) as Record<string, unknown>;
  /* SPLIT ON THE SEMICOLON BEFORE CLASSIFYING, because a multi-office posting writes its offices
   * into ONE string: Anduril's 2027 intern posting stores `job_context.location` as
   * "Atlanta, Georgia, United States; Boston, Massachusetts, United States; ..." and five more.
   *
   * Classifying the composite is wrong in both directions. It reached jobCountry as a single value
   * and passed the every-one-is-US test on the strength of the American cities in it, so a posting
   * mixing Chicago with London would have frozen as safe; and it was then frozen as ONE location,
   * which is the shape the resolver could not read at all. One city per entry makes the every-one
   * test mean what it says and gives the resolver something it can check. */
  const locationValues = [
    typeof context.location === 'string' ? context.location : '',
    ...(Array.isArray(context.locations) ? context.locations.filter((value): value is string => typeof value === 'string') : []),
  ].flatMap((value) => value.split(';')).map((value) => value.trim()).filter(Boolean);
  const classifiedLocations = [...new Set(locationValues)].map((value) => ({ value, country: jobCountry(value) }));
  const safeLocations = classifiedLocations.length > 0 && classifiedLocations.every((item) => item.country === 'us')
    ? frozenJobLocationContext(classifiedLocations.map((item) => item.value))
    : '';
  const packetEmployer = frozenJobEmployerContext(jobContextCompany(row));
  const relocationLocations = frozenJobRelocationLocationContext(locationValues);
  return [current.role, current.jd_text, packetEmployer, relocationLocations, safeLocations]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
}

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
): Promise<{ questions: ApplicationReviewQuestion[]; attentionReasons: string[]; invalidatedQuestionKeys: string[] }> {
  const existingByLabel = new Map(
    current.questions.map((q) => [normalizeReviewQuestionLabel(q.question).toLowerCase(), q] as const),
  );
  const questions: ApplicationReviewQuestion[] = [];
  const attentionReasons: string[] = [];
  const invalidatedQuestionKeys = new Set<string>();

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
    if (portal === 'greenhouse' && /^combobox$/i.test(field.inputType)) return field.selector;
    return /^(?:text|email|tel|url|number|date|textarea)?$/i.test(field.inputType)
      ? field.selector
      : undefined;
  };

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
  ): ApplicationReviewQuestion => ({
    id: existing?.id ?? randomUUID(),
    question: reviewLabel,
    // Ordinary unresolved fields preserve an applicant answer. Refusal branches pass false because
    // an old value may have been created by a superseded unsafe resolver and must be re-confirmed.
    answer: preserveExistingAnswer ? (existing?.answer ?? '') : '',
    kind: 'required',
    required: true,
    portal_selector: portalSelectorForField(field),
    portal_input_type: field.inputType,
  });

  for (const field of discovered) {
    const label = normalizeDiscoveredLabel(field.label);
    const reviewLabel = normalizeReviewQuestionLabel(field.label);
    if (!label || !reviewLabel || normalizeStoredPortalQuestions([{ question: label, answer: '' }], portal).length === 0) continue;
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
    const existing = existingByLabel.get(reviewLabel.toLowerCase());
    const profileKnown = resolveKnownAnswer(
      label, field.inputType, ap, questionContext, postingCountry, postingCountryCode,
      controlCanAcceptADocument(field.inputType, field.options),
    );
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
        { label, inputType: field.inputType, options: field.options },
        ap,
        questionContext,
        postingCountry,
        postingCountryCode,
      )
      : null;
    const knownValue = resolvedField?.value ?? (known && 'value' in known ? known.value : '');
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
    const answerOptionSource = resolvedField?.matchedOption
      && profileKnown && 'value' in profileKnown
      && profileKnown.value.trim()
      && resolvedField.value.trim().toLowerCase() !== profileKnown.value.trim().toLowerCase()
      ? profileKnown.value
      : undefined;
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
      attentionReasons.push(`none of the options match your saved answer, so this one is left for you: "${label.slice(0, 60)}"`);
    }
    if (rememberedWithoutOptionConstraint !== undefined
      && remembered === undefined
      && usableOptions(field.options).length > 0) {
      invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      attentionReasons.push(`none of the options exactly match your remembered answer, so this one is left for you: "${label.slice(0, 60)}"`);
      if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing, false));
      continue;
    }
    if (known && 'skipReason' in known) {
      invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      attentionReasons.push(known.skipReason);
      if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing, false));
      continue;
    }
    if (!known && isRefusedQuestion(label)) {
      invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
      attentionReasons.push(WORK_ELIGIBILITY_QUESTION.test(label)
        ? workEligibilitySkipReason(label)
        : `sensitive question left for you: "${label.slice(0, 60)}"`);
      if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing, false));
      continue;
    }
    if (isSelfDeclarationQuestion(label)) {
      if (!known) {
        invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
        attentionReasons.push(selfDeclarationSkipReason(label));
        if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
        continue;
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
    const closedControl = /^(?:select|radio|checkbox|combobox)$/i.test(field.inputType)
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
        questions.push({
          ...existing,
          question: reviewLabel,
          answer: knownValue,
          kind: 'required',
          required: fieldIsRequired,
          portal_selector: portalSelectorForField(field),
          portal_input_type: field.inputType,
          answer_option_source: answerOptionSource,
          // Last, so a re-run over a packet whose provenance was stripped by a review merge stamps
          // the acceptance back on rather than inheriting a blank.
          ...consentTrail,
        });
      } else if (staleDraftedAnswer) {
        invalidatedQuestionKeys.add(reviewLabel.toLowerCase());
        if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing, false));
      } else if (existing.answer.trim()) {
        questions.push({
          ...existing,
          question: reviewLabel,
          required: existing.required || fieldIsRequired,
          portal_selector: portalSelectorForField(field),
          portal_input_type: field.inputType,
        });
      } else if (fieldIsRequired) {
        questions.push(unansweredRequiredQuestion(field, reviewLabel, existing, true));
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
        portal_input_type: field.inputType,
        answer_option_source: answerOptionSource,
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
      if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
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
        attentionReasons.push(`open-ended question left for you (no experience bank on file): "${label.slice(0, 60)}"`);
        if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
        continue;
      }
      const { answer, warnings } = await draftApplicationAnswer(
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
        attentionReasons.push(`open-ended question left for you (could not draft a confident answer): "${label.slice(0, 60)}"`);
        if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
        continue;
      }
      questions.push({ id: randomUUID(), question: reviewLabel, answer: fitted, kind: 'essay', required: fieldIsRequired, portal_selector: field.selector, portal_input_type: field.inputType });
      if (warnings.length > 0) {
        attentionReasons.push(`drafted answer needs your review: ${warnings.join('; ').slice(0, 300)}`);
      }
      if (!automaticSubmissionEnabled) {
        attentionReasons.push(`AI-drafted answer needs your review before this goes out: "${label.slice(0, 60)}"`);
      }
    } catch (error) {
      if (isBillingOrAuthFailure(error)) throw error; // this is a real outage, not a per-field skip
      attentionReasons.push(`open-ended question left for you (draft generation failed): "${label.slice(0, 60)}"`);
      if (fieldIsRequired) questions.push(unansweredRequiredQuestion(field, reviewLabel, existing));
    }
  }

  return { questions, attentionReasons, invalidatedQuestionKeys: [...invalidatedQuestionKeys] };
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

export function mergeDiscoveredPortalQuestions(
  discovered: readonly ApplicationReviewQuestion[],
  stored: readonly ApplicationReviewQuestion[],
  invalidatedQuestionKeys: readonly string[],
  invalidatedFieldIds: ReadonlySet<string> = new Set(),
): ApplicationReviewQuestion[] {
  const invalidated = new Set(invalidatedQuestionKeys);
  return normalizeApplicationReviewQuestions([
    ...discovered,
    ...stored.filter((question) => {
      if (invalidated.has(normalizeReviewQuestionLabel(question.question).toLowerCase())) return false;
      const controlId = managedOptionProbeControlId({
        label: question.question,
        selector: question.portal_selector,
      });
      return !controlId || !invalidatedFieldIds.has(controlId);
    }),
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
export function optionProbeAttentionReasons(
  failures: readonly { controlId: string; reason: string }[],
  failedFields: readonly { controlId: string; label?: string }[],
): string[] {
  const labelById = new Map(failedFields.map((field) => [field.controlId, field.label?.trim()]));
  return failures.map(({ controlId, reason }) => {
    const label = labelById.get(controlId);
    const named = label ? `"${label.slice(0, 80)}"` : `the control ${controlId.slice(0, 80)}`;
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
) {
  await writeReview(row, nextReview(current, {
    status: 'filling',
    submission_run_id: runId,
    submission_error: undefined,
  }));
  // Neither document goes on the discovery pass. It runs before anything is known about the form,
  // and its whole job is to read the page; carrying a file there would spend an upload action on a
  // control this run has not yet established exists.
  let packet = omitTranscript(omitCoverLetter(await buildPacket(row, packetUsesControlledResumeFixture(portal))));

  // R-055 on the managed path: a cheap first call fills only the fixed fields and asks
  // stratus-browser-cloud's 'discover' action (PR #7) to scan the resulting page for custom
  // questions - the only way this path ever sees the live DOM, since /api/run is otherwise
  // stateless. Resolved through the SAME questionDiscovery.ts logic the direct-Playwright path
  // uses, so the two providers can never answer a question differently.
  const applicationUrl = portalApplicationUrl(portal, current.portal_url!);
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
  const discoveryResult = await runManagedBrowser(applicationUrl, buildManagedDiscoveryActions(portal, packet))
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
  // The closed lists' REAL option texts, read off the live page by the discovery pass. Without
  // these, resolveProfileField's option snapping (PR #361) is inert on this path: the managed
  // provider's discover action reports no options at all, so a control offering "Computer Science"
  // was handed the stored major, matched nothing, and came back required-and-empty.
  const discoveryFieldOptions = managedResultFieldOptions(discoveryResult);
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
    discoveryResult?.discovered ?? [],
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
    const result = await runManagedBrowser(applicationUrl, actions, { screenshot: false })
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
    discoveryResult?.discovered ?? [],
    discoveryFieldOptions,
    [discoveryResult, ...optionProbeResults],
    optionProbeBatchFailures,
    discoveryRoleCapability,
  );
  /* NOT pushed into discoveryFailures. That array is the WHOLE-FORM honesty gate, and a per-control
   * read failure promoted into it made Litos tell her it could not read any of this form's questions
   * when it had read all but one of them. The failure is real and stays visible, and it still holds
   * the send below; what changes is that it now speaks only for the control it happened to.
   *
   * This is a change to the packet's account of itself, not to any answer. See
   * optionProbeAttentionReasons for why resolution cannot see this array at all. */
  if (optionProbe.failures.length > 0) {
    fastify.log.error(
      { applicationId: row.id, portal, controls: optionProbe.failures },
      'Closed controls whose option list could not be read, so each one alone is left for the applicant',
    );
  }
  const fieldOptions = optionProbe.options;
  const failedFields = (discoveryResult?.discovered ?? []).flatMap((field) => {
    const controlId = managedOptionProbeControlId(field);
    if (!controlId || !optionProbe.failedIds.has(controlId)) return [];
    return [{ controlId, label: field.label, selector: field.selector, inputType: field.inputType }];
  });
  const optionProbeAttention = optionProbeAttentionReasons(optionProbe.failures, failedFields);
  const discoveredFields = attachManagedFieldOptions(discoveryResult?.discovered ?? [], fieldOptions)
    .filter((field) => {
      const controlId = managedOptionProbeControlId(field);
      return !controlId || !optionProbe.failedIds.has(controlId);
    });
  const coverLetterSupported = managedResultHasCoverLetterUpload(discoveryResult, portal);
  const coverLetterOutcome = await packetForCoverLetterCapability(
    row,
    coverLetterSupported,
    fastify,
    packetUsesControlledResumeFixture(portal),
  );
  /* The same question about the second document, off the same discovery read, and applied to the
   * packet the cover-letter step just produced rather than to a rebuild - see
   * packetForTranscriptCapability for why a rebuild here would be handed the wrong row. */
  const transcriptSupported = managedResultHasTranscriptUpload(discoveryResult, portal);
  const transcriptOutcome = packetForTranscriptCapability(coverLetterOutcome.packet, transcriptSupported);
  if (coverLetterOutcome.packet.transcriptUnavailableReason) {
    // The raw reason to the log, the fixed sentence to the applicant, same split as the cover
    // letter's two failures. Whoever has to fix a dead pointer reads logs.
    fastify.log.warn(
      { applicationId: row.id, reason: coverLetterOutcome.packet.transcriptUnavailableReason },
      'Attached transcript could not be loaded, continuing without it',
    );
  }
  packet = transcriptOutcome.packet;
  const storedQuestions = normalizeStoredPortalQuestions(current.questions, portal);
  const resolutionCurrent = { ...current, questions: storedQuestions };
  const applicationProfile = applicationProfileForPacket(
    await loadApplicationProfileLike(row.user_id),
    packet,
  );
  const savedAnswers = await loadSavedAnswers(row.user_id);
  const {
    questions: discoveredQuestions,
    attentionReasons: discoveryAttention,
    invalidatedQuestionKeys,
  } = await discoverAndResolveQuestions(
    discoveredFields,
    row,
    resolutionCurrent,
    applicationProfile,
    authorization.enabled,
    portal,
    savedAnswers,
  );
  const failedQuestionKeys = failedFields.map((field) => normalizeReviewQuestionLabel(field.label).toLowerCase());
  const mergedQuestions = mergeDiscoveredPortalQuestions(
    discoveredQuestions,
    storedQuestions,
    [...invalidatedQuestionKeys, ...failedQuestionKeys],
    optionProbe.failedIds,
  );
  packet.questions = mergedQuestions.map((q) => ({
    question: q.question,
    answer: q.answer,
    portalSelector: q.portal_selector,
    portalInputType: q.portal_input_type,
  }));
  // The fill run gets the same option lists, so the fixed education comboboxes type an exact option
  // instead of the profile's own phrasing. It only ever gets ONE attempt at a react-select (a second
  // click closes the menu the first one opened), so the first value has to be the right one.
  packet.fieldOptions = fieldOptions;
  packet.failedFields = failedFields;

  const fillActions = buildManagedPortalActions(portal, packet);
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
  const result = await runManagedBrowser(applicationUrl, fillActions);
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
  const blockers = corroborateManagedCaptchaBlockers(
    portal,
    attentionBlockersForManagedResult(
      portal,
      sanitizeProviderBlockers(result.blockers ?? []),
      result,
      packet,
    ),
    result,
  );
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
  // The optionProbe term holds the send for exactly as long as it did while a per-control read
  // failure was promoted to the run level. Narrowing the blast radius of the MESSAGE is not
  // permission to send a form carrying a question Litos knowingly left blank. It reads the failure
  // ARRAY rather than the rendered prose, for the reason the direct path's comment below gives: a
  // sentence that renders to nothing must never be able to restore `safe`.
  const unansweredRequiredQuestions = blankRequiredQuestionLabels(mergedQuestions);
  const safe = blockers.length === 0
    && discoveryAttention.length === 0
    && evidenceBlockers.length === 0
    && discoveryFailures.length === 0
    && optionProbe.failures.length === 0
    && coverLetterAttention.length === 0
    // A question the run never attempted is an answer she gave Litos and Litos did not use. The
    // submit path refuses outright rather than trade one away; this is the same refusal on the path
    // that has no submit button to withhold, and it is what makes the trim above safe to allow.
    && unattemptedQuestions.length === 0
    && unansweredRequiredQuestions.length === 0
    // See transcriptAttention: this one holds back a send nothing else would refuse.
    && transcriptAttention.length === 0;
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
    cover_letter_supported: coverLetterSupported,
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
    ...(discoveryFailures.length === 0 ? { transcript_supported: transcriptSupported } : {}),
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
  const result = await runManagedBrowser(
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

async function prepare(row: ResumeRow, fastify: FastifyInstance, unattended = false) {
  let current = readApplicationReview(row.spec);
  if (!current) throw new Error('We do not have a link to the company application page');
  current = await repairReviewPortalFromMonitoredJob(row, current);
  /* The audit is also where a packet past its retention window gets its file rebuilt, so the row it
     returns can carry a NEW resume_object_key. Everything below reads from that row, never from
     inputRow, or the run assembles a packet from the key the sweep deleted. */
  const packetAudit = await currentPacketAudit(row, { restoreExpiredResume: 'authorizing_send' });
  if (!packetAudit.valid) {
    fastify.log.warn(
      { applicationId: row.id, code: packetAudit.code },
      'Application preparation withheld because the exact packet audit is missing or stale',
    );
    await writeReview(row, nextReview(current, {
      status: 'needs_attention',
      attention_reason: packetAudit.reason,
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
  const atsAssessment = atsApiSubmissionEnabled() ? assessAtsSubmissionChannel(portalUrl) : null;
  if (atsAssessment?.status === 'available') {
    /* The one preparation that reads no form at all, so `safe` cannot be a literal.
     *
     * This branch opens no browser, computes no blockers and never sees the employer's page: it
     * decides the posting can be submitted through an employer-authorized API and hands off. `true`
     * was therefore the honest answer about the FORM and the wrong answer about the PACKET - with
     * standing consent it turns straight into 'submitting' and submit() posts the application, and
     * nothing between here and there had ever read the question list. Latent today because
     * atsApiSubmissionEnabled() gates the branch, and the shape is what bites the day that flag goes
     * on. submit() refuses at the click as well; this is what stops the packet being DESCRIBED as
     * ready in the first place. */
    const atsUnansweredRequired = blankRequiredQuestionLabels(current.questions);
    await writeReview(row, nextReview(current, {
      ...preparedReviewPatch(authorization, atsUnansweredRequired.length === 0),
      ...(atsUnansweredRequired.length > 0
        ? {
          attention_reason: `${atsUnansweredRequired.length} required `
            + `${atsUnansweredRequired.length === 1 ? 'question is' : 'questions are'} still unanswered: `
            + `${atsUnansweredRequired.map((label) => `"${label.slice(0, 60)}"`).join(', ').slice(0, 400)}`,
        }
        : {}),
      submission_run_id: runId,
      browser_context_id: undefined,
      browser_session_id: undefined,
      submission_error: undefined,
    }));
    fastify.log.info(
      { applicationId: row.id, provider: atsAssessment.provider, unansweredRequired: atsUnansweredRequired.length },
      'Application prepared for employer-authorized ATS API submission',
    );
    return;
  }
  if (shouldUseLocalControlledBrowser(portal)) {
    await prepareControlled(row, current, runId, authorization, fastify);
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
  if (
    isAccountWalledFamily(portal)
    || !autoRunShouldPrepare({ canAutoSubmit: portalCanAutoSubmit(portal), unattended })
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
    await prepareManaged(row, current, portal, runId, fastify, authorization);
    return;
  }
  const contextId = current.browser_context_id ?? (await createBrowserContext());
  const session = await createBrowserSession(contextId, portalUrl);
  {
    const verificationRequestedAt = new Date();
    const connected = await connectToSession(session);
    const page = connected.page;
    await writeReview(row, nextReview(current, {
      status: 'filling',
      submission_run_id: runId,
      browser_context_id: contextId,
      browser_session_id: session.id,
      submission_error: undefined,
    }));
    await page.goto(portalUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // SmartRecruiters follows its captured link. Workable canonicalizes to /apply and clears its
    // optional-cookie overlay. Every other portal is a no-op here.
    await navigateToApplicationForm(page, portal);
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
    const builtOutcome = await packetForCoverLetterCapability(
      row,
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

    // R-055: discover and resolve the posting's own custom questions before filling, so a
    // dashboard-only submission does not depend on the extension having run first.
    /* `.catch(() => [])` was the whole error handling here, and it is the direct-Playwright twin of
     * the bug prepareManaged carries a long comment about: an empty array is what this path gets
     * from a form with no custom questions AND from a scan that threw, so the two are
     * indistinguishable downstream. The run then fills the fixed fields, writes zero question
     * records, and reports no error - and on this path the consequence is worse than on the managed
     * one, because standing consent turns a `safe` preparation into a click inside the same call.
     *
     * A scan that did not run cannot be the evidence that a form is complete. Same three
     * consequences as the managed path: it is logged as an error because it is a product defect
     * first, it is said to the applicant in her own attention list, and it gates `safe`. */
    // An array rather than a nullable local, for the same reason prepareManaged uses one: TypeScript
    // does not narrow across a closure it cannot prove ran.
    const discoveryFailures: string[] = [];
    const discovered = await discoverPageQuestions(page).catch((error: unknown) => {
      // Normalized rather than taken raw, because `new Error()` carries `message === ''` and an
      // empty string reaches discoveryHonestyReasons as falsy: the run would be correctly held back
      // and the applicant would be shown no reason for it.
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
    const {
      questions: discoveredQuestions,
      attentionReasons: discoveryAttention,
      invalidatedQuestionKeys,
    } =
      await discoverAndResolveQuestions(
        discovered,
        row,
        resolutionCurrent,
        applicationProfileForPacket(await loadApplicationProfileLike(row.user_id), packet),
        authorization.enabled,
        portal,
        await loadSavedAnswers(row.user_id),
      );
    const mergedQuestions = mergeDiscoveredPortalQuestions(discoveredQuestions, storedQuestions, invalidatedQuestionKeys);
    packet.questions = mergedQuestions.map((q) => ({
      question: q.question,
      answer: q.answer,
      portalSelector: q.portal_selector,
      portalInputType: q.portal_input_type,
    }));

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
      browser_context_id: contextId,
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
) {
  if (process.env.LITOS_ENABLE_TEST_PORTAL !== 'true') throw new Error('Controlled portal is disabled');
  const browser = await chromium.launch({ executablePath: controlledChromeExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(current.portal_url!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const packet = await buildPacket(row, true);
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

async function submitControlled(row: ResumeRow, review: ApplicationReviewState, fastify: FastifyInstance) {
  if (process.env.LITOS_ENABLE_TEST_PORTAL !== 'true') throw new Error('Controlled portal is disabled');
  const browser = await chromium.launch({ executablePath: controlledChromeExecutable(), headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(review.portal_url!, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await fillPortal(page, 'controlled_test', await buildPacket(row, true));
    await clickFinalSubmit(page);
    const receipt = await readReceipt(page);
    const capturedAt = new Date().toISOString();
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    await writeReview(row, nextReview(review, {
      status: 'submitted',
      submitted_at: capturedAt,
      submission_error: undefined,
      receipt: {
        confirmation_text: receipt.confirmationText,
        final_url: receipt.finalUrl,
        screenshot_url: `data:image/png;base64,${screenshot.toString('base64')}`,
        captured_at: capturedAt,
        reference_id: receipt.referenceId,
      },
    }));
    fastify.log.info({ applicationId: row.id }, 'Controlled application submission receipt verified');
  } finally {
    await browser.close();
  }
}

function packetForApiSubmission(review: ApplicationReviewState, builtPacket: SubmissionPacket): SubmissionPacket {
  const withCoverLetter = review.cover_letter_supported === false ? omitCoverLetter(builtPacket) : builtPacket;
  /* THE TRANSCRIPT READS THE FLAG THE OTHER WAY ROUND FROM THE LETTER, and the asymmetry is the
   * point rather than an oversight.
   *
   * The letter is kept unless the prepared form explicitly rejected it, because an unmeasured packet
   * predates the field and a letter she approved should still go. The transcript is dropped unless
   * the form was explicitly measured as able to take one: every packet carrying a transcript was
   * prepared on a build that writes transcript_supported on both prepare paths, so `undefined` here
   * means the file was attached after the last prepare and no run has ever looked at this form for
   * somewhere to put it. Attaching on a guess sends an unasked-for document, in her name, through a
   * channel where nobody sees the form first. */
  return review.transcript_supported === true ? withCoverLetter : omitTranscript(withCoverLetter);
}

async function submitViaAtsSubmissionChannel(
  row: ResumeRow,
  review: ApplicationReviewState,
  fastify: FastifyInstance,
): Promise<boolean> {
  if (!atsApiSubmissionEnabled()) return false;
  review = await repairReviewPortalFromMonitoredJob(row, review);
  if (!await authorizationValidAtClick(row, review)) {
    await holdRevokedSubmission(row, review);
    return true;
  }
  const packet = packetForApiSubmission(review, await buildPacket(row));
  const atsResult = await tryAtsSubmissionChannel(review.portal_url, packet);
  if (atsResult.kind === 'submitted') {
    const capturedAt = new Date().toISOString();
    await writeReview(row, nextReview(review, {
      status: 'submitted',
      submitted_at: capturedAt,
      submission_error: undefined,
      receipt: {
        confirmation_text: atsResult.confirmationText,
        final_url: atsResult.finalUrl,
        captured_at: capturedAt,
        reference_id: atsResult.referenceId,
        source: 'ats_api',
      },
    }));
    fastify.log.info({ applicationId: row.id, provider: atsResult.provider }, 'Application submission accepted by ATS API');
    return true;
  }
  if (atsResult.assessment.status === 'unavailable') {
    fastify.log.info(
      { applicationId: row.id, provider: atsResult.assessment.provider, reason: atsResult.assessment.reason },
      'ATS API submission channel unavailable, continuing with browser submission',
    );
  }
  return false;
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
  const packetAudit = await currentAcknowledgedPacketAudit(row, { restoreExpiredResume: 'authorizing_send' });
  if (!packetAudit.valid) {
    const finishingSecurityCode = Boolean(options.securityCode) && Boolean(current.security_code);
    fastify.log.error(
      { applicationId: row.id, code: packetAudit.code },
      'Submission withheld because the exact packet audit is missing or stale',
    );
    await writeReview(row, nextReview(current, {
      status: finishingSecurityCode ? 'awaiting_security_code' : 'needs_attention',
      attention_reason: finishingSecurityCode
        ? `${securityCodeAttentionReason(current.security_code!)}\n${packetAudit.reason}`
        : packetAudit.reason,
      attention_categories: packetAudit.code === 'PACKET_RESUME_EXPIRED'
        ? (finishingSecurityCode ? ['security_code', 'packet_expired'] : ['packet_expired'])
        : (finishingSecurityCode ? ['security_code', 'evidence_gap'] : ['evidence_gap']),
      submission_authorization: undefined,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
    }));
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
    );
    return;
  }
  const authorization = await standingAuthorization(row.user_id);
  if (!mayClickFinalSubmit({
    source: current.submission_authorization?.source,
    standingConsentEnabled: authorization.enabled,
  })) {
    if (current.submission_authorization?.source === 'standing_consent') {
      await writeReview(row, nextReview(current, {
        status: 'ready_for_final_approval',
        submission_authorization: undefined,
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
      }));
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
  const duplicate = await duplicateApplicationVerdict({
    userId: row.user_id,
    applicationId: row.id,
    jobContext: row.job_context,
    portalUrl: current.portal_url,
  });
  if (duplicate.kind === 'unidentifiable') {
    fastify.log.warn(
      { applicationId: row.id },
      'duplicate guard abstained: no shared posting key with any submitted application',
    );
  }
  if (duplicate.kind === 'duplicate') {
    fastify.log.info(
      { applicationId: row.id, duplicateOf: duplicate.match.application_id, basis: duplicate.match.basis },
      'Submission refused: this user already applied to this posting',
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
        ? ['security_code', 'duplicate_application']
        : ['duplicate_application'],
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
  let claimedReview = readApplicationReview(row.spec);
  if (!claimedReview) return;
  claimedReview = await repairReviewPortalFromMonitoredJob(row, claimedReview);
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
  const unansweredRequired = blankRequiredQuestionLabels(claimedReview.questions);
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
    await writeReview(row, nextReview(claimedReview, {
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
    }));
    return;
  }
  const claimedPortal = detectPortal(claimedReview.portal_url!);
  assertControlledPortalEnabled(claimedPortal);
  if (shouldUseLocalControlledBrowser(claimedPortal)) {
    await submitControlled(row, claimedReview, fastify);
    return;
  }
  if (await submitViaAtsSubmissionChannel(row, claimedReview, fastify)) return;
  // Portals that cannot be submitted in one run stop HERE, before either provider path.
  //
  // This gate used to live only inside buildManagedPortalActions, which was wrong in two ways that
  // a review caught before it shipped. Removing the click from the managed action list does not stop
  // the code below from calling readManagedReceipt and writing status:'submitted' - so a JazzHR or
  // Paylocity run that clicked nothing could still be recorded as submitted the moment the page text
  // happened to contain "success". And it did nothing at all for the direct-Playwright path, which
  // calls clickFinalSubmit(page) unconditionally: on JazzHR that presses submit behind an unsolved
  // reCAPTCHA, and on Paylocity it presses a control halfway through a four-page wizard.
  //
  // Gating at the call site is the only place that covers both providers and the status write.
  {
    const portal = claimedPortal;
    if (!portalCanAutoSubmit(portal)) {
      await writeReview(row, nextReview(claimedReview, {
        status: 'needs_attention',
        attention_reason: portalHandoffReason(portal) ?? undefined,
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
      }));
      return;
    }
  }
  if (isManagedStratusProvider()) {
    const portal = claimedPortal;
    if (!await authorizationValidAtClick(row, claimedReview)) {
      await holdRevokedSubmission(row, claimedReview);
      return;
    }
    const applicationUrl = portalApplicationUrl(portal, claimedReview.portal_url!);
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
    const captchaProbe = await runManagedBrowser(applicationUrl, buildManagedCaptchaProbeActions(), { screenshot: false })
      // A probe that cannot run must not take down a submission that would otherwise succeed. It
      // fails open to the pre-probe behaviour, same as managedResultRequiresCaptchaAttention does.
      // Only the message is logged, bounded: the runner's error string is remote-controlled and
      // Playwright-shaped failures embed page markup.
      .catch((error: unknown) => {
        const detail = String(error instanceof Error ? error.message : error).slice(0, 200);
        fastify.log.warn({ applicationId: row.id, detail }, 'CAPTCHA probe failed, continuing unprobed');
        return null;
      });
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
    const builtPacket = await buildPacket(row, packetUsesControlledResumeFixture(portal));
    const withCoverLetter = claimedReview.cover_letter_supported === true ? builtPacket : omitCoverLetter(builtPacket);
    // Re-derived from what the prepare measured, not probed again: this run has no discovery pass,
    // and the form it is about to submit is the one the prepare read. See packetForApiSubmission for
    // why the transcript needs an explicit true where the letter needs only "not explicitly false".
    const packet = claimedReview.transcript_supported === true
      ? withCoverLetter
      : omitTranscript(withCoverLetter);
    const verificationRequestedAt = new Date();
    /* THE FIRST HALF IS THE SAME RUN WHETHER OR NOT A CODE IS IN HAND, and that is the fix.
     *
     * The managed runner is stateless and one-shot: every run loads the form fresh, and on first
     * paint a Greenhouse application form carries no security-code control, because Greenhouse only
     * renders one after a submit has been refused. So a code cannot be attached to this list. It is
     * attached to the CONTINUATION below, which runs on the very DOM this submit produced. */
    const initialActions = buildManagedPortalActions(portal, packet, true);
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
    const result = await runManagedBrowser(
      applicationUrl,
      initialActions,
      managedApplicationSubmitOptions(SECURITY_CODE_CONTINUATION_TTL_SECONDS),
    );
    const initialChallengeCandidate = readManagedSecurityCodeChallenge(result);
    const initialSubmitOutcome = readManagedSubmitOutcome(result);
    const initialChallenge = securityCodeChallengeMatchesRecipient(initialChallengeCandidate, packet.email)
      ? initialChallengeCandidate
      : null;
    if (initialChallengeCandidate && initialSubmitOutcome?.pressed === false && !initialChallenge) {
      await writeReview(row, preClickSecurityRecipientMismatchReview(
        claimedReview,
        initialChallengeCandidate,
        verificationRequestedAt.toISOString(),
      ));
      return;
    }
    // Required-field confirmation is a barrier inside the same remote action list, immediately
    // before submit. Require its per-field proof as well: an older runner that ignores or does not
    // understand the protocol must not be allowed to turn a silent fill into a submitted state.
    if (managedApplicationProofIsRequired(initialChallenge, initialSubmitOutcome)) {
      assertManagedRequiredFieldsConfirmed(result, 'application');
    }
    let receiptResult = result;
    let verification: ApplicationReviewState['verification'] = { status: 'not_needed' };
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
      const continuationEvidence = continuationIsLive
        ? {
          runner: 'stratus-managed' as const,
          continuation_fingerprint: managedContinuationFingerprint(continuationToken),
          continuation_resumed: false,
        }
        : {};
      if (continuationIsLive && verificationAllowed) {
        // The continuation capability stays call-local. Persisting it would turn the review JSON,
        // which is returned to dashboard and extension clients, into a browser-session credential.
        await writeReview(row, nextReview(claimedReview, {
          verification: {
            status: 'searching',
            requested_at: requestedAt,
            retry_count: 0,
            ...continuationEvidence,
          },
          attention_reason: undefined,
          submission_error: undefined,
        }));
        const prepared = await prepareManagedEmailVerification({
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
        const codeWasAlreadyAttempted = prepared.status === 'ready'
          && Boolean(initialSecurityCodeState && findSecurityCodeAttempt(
            initialSecurityCodeState,
            securityCodeFingerprint(row.id, prepared.code),
          ));
        if (prepared.status === 'ready' && !codeWasAlreadyAttempted && Date.parse(continuationExpiresAt) > Date.now()) {
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
            await writeReview(row, preClickVerificationContinuationBlockedReview(
              claimedReview,
              initialSecurityCodeState,
              actionBlockCause,
              initialSubmitOutcome?.pressed === true ? verificationRequestedAt.toISOString() : undefined,
            ));
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
          await writeReview(row, nextReview(claimedReview, { security_code: enteredSecurityCodeState }));
          const codeActions = securityCodeContinuationActions(initialActions, prepared.code) ?? prepared.actions;
          try {
            // Exactly one continuation call. An uncertain click is never retried.
            receiptResult = await continueManagedBrowser(continuationToken, codeActions);
            // A continuation has its own physical submit. Its v2 action must confirm the active
            // verification form and own that click atomically, just like the initial application
            // send. The first receipt cannot authorize a later DOM or a replaced submit node.
            assertManagedRequiredFieldsConfirmed(receiptResult, 'verification');
          } catch (error) {
            /* AN UNCERTAIN CLICK IS NEVER RETRIED, and that outranks landing somewhere friendlier.
             *
             * A throw here can come from either side of the physical submit: the call itself can
             * fail before anything is clicked, and the confirmation assertion above runs after the
             * continuation has already returned, which means after a click may have landed. Nothing
             * available here separates those two, so the packet must not go back to a state that
             * invites another send. Some boards cap re-applications outright - Deepgram's form says
             * candidates may not apply more than twice in 60 days - and a duplicate filed because
             * Litos could not read its own outcome is worse than a packet that asks for a person.
             *
             * The attempt is still recorded, because the fingerprint is what stops the same code
             * being spent again, and 'error' is the honest outcome for a code whose fate is unknown.
             * needs_attention is not a dead end: it carries the portal and the receipt screenshot,
             * which is exactly what someone finishing this by hand needs. */
            const failedAt = new Date().toISOString();
            await writeReview(row, nextReview(claimedReview, {
              status: 'needs_attention',
              security_code: recordEnteredCodeOutcome('error', failedAt),
              verification: { status: 'verification_pending', requested_at: requestedAt, retry_count: 1 },
              attention_reason: 'Litos entered the employer verification step, but could not prove the final result. Check the employer portal before trying anything again.',
              submission_error: error instanceof Error ? error.message.slice(0, 500) : 'Managed verification continuation failed',
            }));
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
     * Ashby and Greenhouse both replace their application UI after the request completes. The
     * runner waits a bounded three seconds, but two production sends reached that deadline between
     * the click and the ATS state transition. They were written as terminal unverified rows even
     * though the exact browser page was still alive behind the continuation capability this request
     * had already asked Stratus to create.
     *
     * The observer receives no URL and the continuation receives an empty action list. It cannot
     * reopen, navigate, click, or submit. It only lets Stratus run its existing ATS readers on the
     * same Page once more. The helper accepts only Ashby's published success/failure containers or
     * Greenhouse's confirmation route; timeout, weak page text, and a second unknown keep the
     * original unverified verdict. An uncertain submit is never retried. */
    let receiptEvidenceResult = receiptResult;
    let delayedObservedChallenge = false;
    if (!initialChallenge) {
      const observation = await observeManagedReceiptOnce({
        initial: receiptResult,
        expectedApplicationUrl: applicationUrl,
        observe: (continuationToken) => continueManagedBrowser(continuationToken, [], { screenshot: true }),
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
    if (!receiptEvidenceResult.screenshot) throw new Error('Stratus managed browser did not return a receipt screenshot');
    const capturedAt = new Date().toISOString();
    const blob = await storeReceiptScreenshot(
      `users/${row.user_id}/submission-runs/${claimedReview.submission_run_id}/receipt.png`,
      Buffer.from(receiptEvidenceResult.screenshot, 'base64'),
    );
    if (delayedObservedChallenge) {
      const delayedChallenge = readManagedSecurityCodeChallenge(receiptResult);
      if (!delayedChallenge) throw new Error('Delayed security-code challenge disappeared before handoff');
      const securityCode = beginSecurityCodeState({
        challenge: delayedChallenge,
        attemptedAt: capturedAt,
        authorized: true,
        existing: claimedReview.security_code,
      });
      await writeReview(row, delayedSecurityCodeHandoffReview(claimedReview, {
        verification,
        securityCode,
        attemptedAt: capturedAt,
        screenshotUrl: blob.url,
      }));
      fastify.log.warn({
        applicationId: row.id,
        sentTo: securityCode.sent_to,
        digits: securityCode.digits,
      }, 'Employer security-code challenge appeared after the receipt observation capability was consumed');
      return;
    }
    /* THE SUBMIT LANDED AND THE EMPLOYER ASKED FOR A CODE, so this is not 'submitted'.
     *
     * Read off the control the runner found, never off the page's text: readManagedReceipt scrapes
     * a confirmation SENTENCE, and a Greenhouse page that has just refused an application still
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
      await writeReview(row, nextReview(claimedReview, {
        status: 'awaiting_security_code',
        // Preserve the polling result computed above. Rebuilding from claimedReview here used to
        // erase verification_pending back to not_needed after a code email arrived but could not
        // be matched, hiding the exact reason the continuation stopped.
        verification: verification.status === 'not_needed'
          ? claimedReview.verification ?? verification
          : verification,
        security_code: attempted,
        submission_attempted_at: capturedAt,
        preview_screenshot_url: blob.url,
        submission_error: undefined,
        attention_reason: securityCodeAttentionReason(attempted),
        attention_categories: ['security_code'],
        // Cleared so the packet is not left looking mid-flight. The claim is what blocks a re-run
        // through the ordinary path, and it is not needed for that here: submitRequestDisposition
        // rejects this status outright, claim or no claim.
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
      }));
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
    const verdict = managedSubmitVerdict(receiptResult);
    if (verdict.kind === 'refused') {
      const refusedCodeOutcome = receiptResult.securityCodeAttempt?.outcome === 'rejected'
        ? 'rejected' as const
        : 'error' as const;
      await writeReview(row, nextReview(claimedReview, {
        status: 'needs_attention',
        ...(enteredCode ? { security_code: recordEnteredCodeOutcome(refusedCodeOutcome, capturedAt) } : {}),
        submission_attempted_at: capturedAt,
        preview_screenshot_url: blob.url,
        submission_error: undefined,
        attention_reason: 'The employer refused this application at the last step and said: '
          + `“${verdict.message.slice(0, 300)}”. Nothing was filed, so there is no confirmation to look for. `
          + 'Litos will not send it again until this is sorted out.',
        attention_categories: ['unknown'],
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
      }));
      return;
    }
    /* NOTHING WAS SENT, AND THAT IS KNOWN, so this must not become an unverified submission. The
     * runner reached the end of its action list without pressing Send, which is what the pre-submit
     * gate does when a required field is still empty. Writing 'unverified' here would tell her Litos
     * pressed Send, send her hunting for a receipt that cannot exist, and leave an unresolved record
     * that blocks every later application to this posting. The claim is released because the packet
     * is safe to run again the moment the missing answer exists. */
    if (verdict.kind === 'not_attempted') {
      const notAttemptedCodeOutcome = receiptResult.securityCodeAttempt?.outcome === 'no_control'
        ? 'no_control' as const
        : receiptResult.securityCodeAttempt?.outcome === 'not_entered'
          ? 'not_entered' as const
          : 'error' as const;
      await writeReview(row, nextReview(claimedReview, {
        status: 'needs_attention',
        ...(enteredCode ? { security_code: recordEnteredCodeOutcome(notAttemptedCodeOutcome, capturedAt) } : {}),
        submission_attempted_at: capturedAt,
        preview_screenshot_url: blob.url,
        submission_error: undefined,
        attention_reason: 'Litos filled this application but stopped before sending it, because the '
          + 'form was not complete. Nothing reached the employer, so there is no confirmation to look '
          + 'for. Fill in what is missing below and send it again.',
        attention_categories: ['required_field'],
        submission_claimed_at: undefined,
        submission_claim_id: undefined,
      }));
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
      await writeReview(row, nextReview(claimedReview, {
        ...unverifiedSubmissionPatch(claimedReview, {
          at: capturedAt,
          cause: 'no_confirmation_state',
          previewUrl: blob.url,
        }),
        ...(enteredCode ? { security_code: recordEnteredCodeOutcome(unverifiedCodeOutcome, capturedAt) } : {}),
      }));
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
        await writeReview(row, nextReview(claimedReview, {
          ...unverifiedSubmissionPatch(claimedReview, {
            at: capturedAt,
            cause: 'no_confirmation_state',
            previewUrl: blob.url,
          }),
          security_code: recordEnteredCodeOutcome(
            codeOutcome === 'rejected' ? 'rejected'
              : codeOutcome === 'no_control' ? 'no_control'
                : codeOutcome === 'not_entered' ? 'not_entered'
                  : 'error',
            capturedAt,
          ),
        }));
        return;
      }
    }
    /* 'unreported' means a runner older than submitOutcome, and it keeps the previous behaviour
       exactly: scrape the body, and throw if there is nothing to scrape. Only 'confirmed' skips the
       scrape, because on that arm the page said so itself. */
    const scraped = (() => {
      try { return readManagedReceipt(receiptResult); } catch { return null; }
    })();
    const receipt = verdict.kind === 'confirmed'
      // The employer's own confirmation sentence, and the reference id the scrape can still find in
      // the body when there is one. The scrape is now enrichment; it is no longer the proof.
      ? { confirmationText: verdict.confirmationText, finalUrl: receiptResult.url, referenceId: scraped?.referenceId }
      : readManagedReceipt(receiptResult);
    await writeReview(row, nextReview(claimedReview, {
      status: 'submitted',
      submitted_at: capturedAt,
      submission_error: undefined,
      verification,
      // Present only when a code finished this one, and it is the fact that makes the receipt
      // legible: this application was sent, refused, and completed with the code the same run read
      // out of the mailbox while holding the challenged page open.
      ...(enteredCode
        ? { security_code: recordEnteredCodeOutcome('accepted', capturedAt) }
        : enteredSecurityCodeState && codeAttempts.length > 0
          ? { security_code: withSecurityCodeAttempts(enteredSecurityCodeState, codeAttempts) }
          : {}),
      receipt: {
        confirmation_text: receipt.confirmationText,
        final_url: receipt.finalUrl,
        screenshot_url: blob.url,
        captured_at: capturedAt,
        reference_id: receipt.referenceId,
        source: 'managed_browser',
      },
    }));
    fastify.log.info({ applicationId: row.id }, 'Application submission receipt verified with Stratus Sandbox');
    return;
  }
  if (!claimedReview.browser_session_id) throw new Error('The prepared run is missing its session.');
  const session = await getBrowserSession(claimedReview.browser_session_id);
  let browser;
  try {
    const connected = await connectToSession(session);
    browser = connected.browser;
    const page = connected.page;
    if (!await authorizationValidAtClick(row, claimedReview)) {
      await holdRevokedSubmission(row, claimedReview);
      return;
    }
    const portal = detectPortal(claimedReview.portal_url!);
    const builtPacket = await buildPacket(row);
    const withCoverLetter = claimedReview.cover_letter_supported === true ? builtPacket : omitCoverLetter(builtPacket);
    // Same re-derivation as the managed submit above, on the path that reconnects to the session the
    // prepare left open. Both submit sites and the ATS channel read this one flag.
    const packet = claimedReview.transcript_supported === true
      ? withCoverLetter
      : omitTranscript(withCoverLetter);
    await fillPortal(page, portal, packet);
    await clickFinalSubmit(page);
    const receipt = await readReceipt(page);
    const capturedAt = new Date().toISOString();
    const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
    const blob = await storeReceiptScreenshot(
      `users/${row.user_id}/submission-runs/${claimedReview.submission_run_id}/receipt.png`,
      screenshot,
    );
    await writeReview(row, nextReview(claimedReview, {
      status: 'submitted',
      submitted_at: capturedAt,
      submission_error: undefined,
      receipt: {
        confirmation_text: receipt.confirmationText,
        final_url: receipt.finalUrl,
        screenshot_url: blob.url,
        captured_at: capturedAt,
        reference_id: receipt.referenceId,
      },
    }));
    fastify.log.info({ applicationId: row.id }, 'Application submission receipt verified');
  } finally {
    await browser?.close().catch(() => undefined);
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
  uncertainAfterClaim: boolean;
  externalGate: boolean;
  providerSessionFailure: boolean;
  currentAttentionReason: string | undefined;
}): SubmissionFailureOutcome {
  const { captchaStop, noSubmitControl, regenerationRequired, packetDocumentExpired, actionBudgetStop, uncertainAfterClaim, externalGate, providerSessionFailure } = input;
  const status: TerminalRunStatus | 'submit_requested' = captchaStop || noSubmitControl || regenerationRequired || packetDocumentExpired || actionBudgetStop || uncertainAfterClaim || providerSessionFailure
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

/** The exact persisted review for an atomic chooser stop that occurs before submitHandle.click. */
export function preClickNoSubmitReview(
  current: ApplicationReviewState,
  message: string,
  now: () => string = () => new Date().toISOString(),
): ApplicationReviewState {
  const outcome = submissionFailureOutcome({
    captchaStop: null,
    noSubmitControl: true,
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

/** A standing code wall for another recipient is pre-click and must never enter mailbox handling. */
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
  const attentionReason = 'This application is already waiting at the employer security-code step, but that step names a different application email than this packet. Litos did not click the verification button. Open the employer portal and resolve the email mismatch before regenerating or retrying this application.';
  return nextReview(current, {
    status: 'awaiting_security_code',
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_authorization: undefined,
    unverified_submission: undefined,
    submitted_at: undefined,
    receipt: undefined,
    security_code: securityCode,
    verification: { status: 'verification_pending', requested_at: observedAt, retry_count: 0 },
    submission_error: 'Managed security-code recipient did not match the packet email',
    attention_reason: attentionReason,
    attention_categories: ['security_code', 'evidence_gap'],
  });
}

/** A code match grants no click if consent or the exact email route changed during mailbox polling. */
export function preClickVerificationContinuationBlockedReview(
  current: ApplicationReviewState,
  securityCode: NonNullable<ApplicationReviewState['security_code']>,
  cause: 'authorization_revoked' | 'email_route_changed' | 'email_permission_revoked',
  attemptedAt?: string,
): ApplicationReviewState {
  const attentionReason = cause === 'authorization_revoked'
    ? 'This application is already waiting at the employer security-code step. Automatic submission permission was revoked before Litos could finish verification, so Litos stopped without clicking the verification button. Review this application before authorizing another attempt.'
    : cause === 'email_permission_revoked'
      ? 'This application is already waiting at the employer security-code step. Automatic inbox verification was turned off before Litos could finish, so Litos stopped without clicking the verification button. Review this application before authorizing another attempt.'
    : 'This application is already waiting at the employer security-code step. Its email route changed before Litos could finish verification, so Litos stopped without clicking the verification button. Regenerate this application before trying again.';
  return nextReview(current, {
    status: 'awaiting_security_code',
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_authorization: undefined,
    submission_attempted_at: current.submission_attempted_at ?? attemptedAt,
    unverified_submission: undefined,
    submitted_at: undefined,
    receipt: undefined,
    security_code: securityCode,
    verification: {
      status: 'verification_pending',
      requested_at: securityCode.requested_at,
      retry_count: 0,
    },
    submission_error: cause === 'authorization_revoked'
      ? 'Submission authorization was revoked before security-code continuation'
      : cause === 'email_permission_revoked'
        ? 'Automatic inbox verification was disabled before security-code continuation'
        : 'Application email route changed before security-code continuation',
    attention_reason: attentionReason,
    attention_categories: ['security_code', 'evidence_gap'],
  });
}

/* A DELAYED POST-CLICK CODE WALL IS STILL A CODE WALL, AND IT NEEDS THE SAME DOOR AS ITS SIBLINGS.
 *
 * This wrote status 'needs_attention' while keeping the claim, and that combination closed every
 * exit the packet had:
 *
 *   submitRequestDisposition('needs_attention', claimed) is 'reject', and resumeEditDisposition
 *   delegates to it, so neither another run nor a resume edit could move it.
 *
 *   POST /applications/:id/security-code answered 'not_awaiting', because finishSecurityCodeSubmission
 *   requires status 'awaiting_security_code' - and claimSecurityCodeSubmission additionally requires
 *   submission_claimed_at to be null, so the status alone would not have been enough.
 *
 *   POST /applications/:id/submission/unverified answered 409, because unverified_submission was
 *   explicitly cleared and that route resolves nothing else.
 *
 * A packet in that state could not be finished, retried, edited or resolved by anybody. That is the
 * exact trap submitRequestDisposition names in its own parameter docs, and the one the Skydio packet
 * 13bccb2d work existed to remove.
 *
 * SO IT NOW WRITES WHAT ITS SIBLINGS WRITE. preClickSecurityRecipientMismatchReview and the ordinary
 * post-click challenge branch both land on 'awaiting_security_code' with the claim released, and
 * that pair is not a relaxation: submitRequestDisposition rejects 'awaiting_security_code' outright,
 * claim or no claim, so the ordinary path still cannot re-run and re-send. What it opens is the ONE
 * route that is safe from here, the applicant's own code, which re-enters on the standing wall the
 * employer is already holding rather than on a fresh form.
 */
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
    status: 'awaiting_security_code',
    verification: input.verification,
    security_code: input.securityCode,
    submission_attempted_at: input.attemptedAt,
    preview_screenshot_url: input.screenshotUrl,
    submission_error: undefined,
    attention_reason: 'The employer showed a verification-code step after Litos used its one safe receipt check. Litos will not open a fresh form or send this application again on its own. Enter the code the employer emailed you, or open the employer portal and finish the verification there.',
    attention_categories: ['security_code', 'evidence_gap'],
    unverified_submission: undefined,
    // Released together with the status, because both are required for the code route to open:
    // finishSecurityCodeSubmission checks the status and claimSecurityCodeSubmission checks that the
    // claim is null. The lock that matters is kept by the status itself.
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_authorization: undefined,
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
  input: { at: string; cause: NonNullable<ApplicationReviewState['unverified_submission']>['cause']; previewUrl?: string },
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
    },
    attention_reason: unverifiedSubmissionReason({
      atsName: review.ats_name,
      portalUrl: review.portal_url,
      cause: input.cause,
    }),
    attention_categories: ['unverified_submission'],
  };
}

export function isProviderSessionFailureMessage(message: string): boolean {
  return /sandbox stream was closed|not accepting commands/i.test(message);
}

async function fail(row: ResumeRow, error: unknown) {
  const latestRows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, row.id)).limit(1);
  const current = latestRows[0] ? readApplicationReview(latestRows[0].spec) : null;
  if (!current) return;
  await writeReview(latestRows[0], submissionFailureReview(current, error));
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
  const message = error instanceof Error ? error.message : 'Submission runner failed';
  const externalGate = /browserbase|stratus managed browser is not configured|secure browser provider is not configured/i.test(message);
  const providerSessionFailure = isProviderSessionFailureMessage(message);
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
  const noSubmitControl = error instanceof NoSubmitControlError || isManagedNoSubmitControl(message);
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
  if (noSubmitControl) return preClickNoSubmitReview(current, message, now);

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
    captchaStop, noSubmitControl, regenerationRequired, packetDocumentExpired, actionBudgetStop, uncertainAfterClaim, externalGate, providerSessionFailure,
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
  | { kind: 'done'; review: ApplicationReviewState };

/**
 * Finish an application the employer is holding behind an emailed security code.
 *
 * It moves the packet back onto the ordinary submit path with a per-application authorization - the
 * applicant supplying a code IS the approval, and it is the same shape of authorization the approve
 * route writes - and then runs submit(). Everything downstream is the plumbing that already exists.
 *
 * THE QUESTION THIS USED TO LEAVE OPEN IS ANSWERED, AND THE ANSWER BREAKS THE OLD DESIGN. The note
 * here previously said that whether Greenhouse re-issues a code on the finishing run's own submit
 * "has not been answered against a live posting", and that the first real use would be the
 * measurement. It was measured, on a live Cresta application on 2026-08-09: three codes to one
 * mailbox at 20:24:03, 21:13:07 and 21:13:53, each send issuing a new one and invalidating the
 * last. Since a code control only exists on a page that has just been sent, and this endpoint must
 * send to reach one, the code she pasted is dead before it can be typed - every time, not
 * sometimes. No amount of care in the typing can win that; the loop is structural.
 *
 * SO THE CODE SHE SUPPLIES IS NOT THE CODE THAT IS TYPED. It authorizes one more attempt, and its
 * fingerprint stops the same dead code authorizing a second - which matters, because every attempt
 * sends the form again and every send emails her another code. What gets typed is read from her
 * connected mailbox inside the run, on the page that asked for it, while that page is still open.
 * The attempt is recorded as 'superseded' rather than as a wrong code, because it was never wrong.
 *
 * WHICH MEANS THE HAPPY PATH DOES NOT COME THROUGH HERE AT ALL. When automatic verification is on
 * and the mailbox is connected, the run that raises the challenge finishes it in the same breath and
 * this endpoint is never reached. It exists for the case where that read failed, and the honest
 * thing it can offer is another attempt with a fresh in-session read - not a promise to use the
 * string she typed.
 */
export async function finishSecurityCodeSubmission(
  applicationId: string,
  rawCode: unknown,
  fastify: FastifyInstance,
): Promise<SecurityCodeSubmissionOutcome> {
  const rows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  const row = rows[0];
  if (!row) return { kind: 'not_found' };
  const current = readApplicationReview(row.spec);
  if (!current) return { kind: 'not_found' };
  if (current.status !== 'awaiting_security_code' || !current.security_code) {
    return { kind: 'not_awaiting', status: current.status };
  }
  const code = normalizeSecurityCode(rawCode, current.security_code.digits);
  if (!code) return { kind: 'invalid_code' };
  const fingerprint = securityCodeFingerprint(row.id, code);
  const seen = findSecurityCodeAttempt(current.security_code, fingerprint);
  if (seen) return { kind: 'already_attempted', outcome: seen.outcome, review: current };

  const leadIssues = runnerLeadAlignmentIssues(row);
  if (leadIssues.length > 0) {
    const withheld = await withholdInvalidLeadAlignment(row, current, leadIssues, true);
    return { kind: 'done', review: withheld };
  }

  // Onto the submit path. per_application_approval is the same source the approve route writes, and
  // it is the honest one here: the applicant produced a code out of her own mailbox for this one
  // application, which is a decision about this application and not a standing setting.
  //
  // Take the claim in the same conditional update that leaves the waiting state. Two requests can
  // read the same code state, but only one can change that state and receive the claimed row. The
  // loser never starts a browser and never clears the winner's claim.
  const activeRow = await claimSecurityCodeSubmission(row, current);
  if (!activeRow) {
    const latestRows = await db.select().from(generated_resumes)
      .where(eq(generated_resumes.id, applicationId)).limit(1);
    const latest = latestRows[0] ? readApplicationReview(latestRows[0].spec) : null;
    if (!latest) return { kind: 'not_found' };
    return { kind: 'not_awaiting', status: latest.status };
  }
  try {
    await submit(activeRow, fastify, { securityCode: code, claimAlreadyHeld: true });
  } catch (error) {
    fastify.log.error({ error, applicationId }, 'Security-code submission failed');
    await fail(activeRow, error);
  }
  const refreshed = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  const review = refreshed[0] ? readApplicationReview(refreshed[0].spec) : null;
  if (!review) return { kind: 'not_found' };
  // A run that ended somewhere other than the two expected states still owes an attempt record, or
  // the same code could be replayed against the employer a moment later. fail() has already written
  // the cause; this only makes sure the fingerprint is remembered.
  if (review.status !== 'submitted' && review.status !== 'awaiting_security_code' && review.security_code) {
    const recorded = nextReview(review, {
      security_code: withSecurityCodeAttempt(review.security_code, {
        at: new Date().toISOString(),
        fingerprint,
        outcome: 'error',
      }),
    });
    await writeReview(refreshed[0], recorded);
    return { kind: 'done', review: recorded };
  }
  return { kind: 'done', review };
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
    fastify.log.error({ error, applicationId: row.id }, 'Application runner step failed');
    const latest = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
    await fail(latest[0] ?? activeRow, error);
  }
  const refreshed = await db.select().from(generated_resumes).where(eq(generated_resumes.id, applicationId)).limit(1);
  return refreshed[0] ? readApplicationReview(refreshed[0].spec) : null;
}

export async function submissionRunnerRoutes(fastify: FastifyInstance) {
  fastify.get('/internal/application-submission-runner', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isCronConfigured() || !isCronAuthorized(request)) return reply.status(401).send({ error: 'Unauthorized' });
    if (!isBrowserbaseConfigured()) return reply.status(503).send({ error: 'Litos cannot fill in company pages yet. Not configured', processed: 0 });
    const startedAt = Date.now();
    // Oldest first. Without an order the queue is whatever Postgres returns, so a row could sit
    // behind newer ones indefinitely once the queue is longer than one batch.
    //
    // Already-claimed rows are excluded, and ordering is exactly why that matters now. A row left
    // in 'submitting' with a claim on it cannot be progressed by anyone: claimSubmission refuses a
    // second claim, so processing it is a no-op. Unordered, such a row was one arbitrary pick among
    // many. Oldest-first, it would sit at the head of every batch forever and consume a slot on
    // every invocation, which turns one stranded row into a permanently narrower queue.
    const rows = await db
      .select()
      .from(generated_resumes)
      .where(and(
        sql`${generated_resumes.spec}->'_review'->>'status' in ('submit_requested', 'submitting')`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' is null`,
      ))
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
      const already = await countSubmissionsClaimedToday(row.user_id);
      if (!withinDailyCap(already, cap)) {
        deferredForCap += 1;
        continue;
      }
      try {
        await processSubmissionApplication(row.id, fastify, { unattended: true });
        processed += 1;
      } catch (error) {
        fastify.log.error({ error, applicationId: row.id }, 'Application runner step failed');
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
    return reply.send({ processed, deferred_for_time: deferredForTime, deferred_for_cap: deferredForCap, configured: true });
  });
}
