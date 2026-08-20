import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { del, put } from '@vercel/blob';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { applyReviewPatch, settleStall } from '../lib/applicationStall';
import type { ApplicationReviewState } from '../lib/applicationReview';
import { readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import { career_page_sources, generated_resumes, monitored_jobs, profiles, users, type ExperienceBankEntry } from '../db/schema';
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
import { connectToSession, getBrowserSession, getLiveViewUrl, isBrowserbaseConfigured } from '../lib/browserbase';
import { apiBaseFor } from '../lib/apiBase';
import { extractPdfText } from '../lib/pdfText';
import { storedCoverLetter } from '../lib/coverLetterService';
import { specWithoutDocumentPointers, storedDocuments } from '../lib/documentStore';
import { documentAsksLitosCannotResolve } from '../lib/requiredDocuments';
import { mintDownloadToken } from '../lib/resumeAccess';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import { requireAuth } from '../middleware/auth';
import { declaredSkillsList } from './profile';
import { buildPacket, finishSecurityCodeSubmission, processSubmissionApplication } from './submissionRunner';
import { postingCountryCodeFromJobContext, postingCountryFromJobContext, type JobCountry } from '../lib/jobLocation';
import { knownAnswerLookup, refreshKnownQuestionAnswers, sensitiveQuestionRequiresAttention, type ApplicationProfileLike } from '../lib/questionDiscovery';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import { rememberReusableAnswers } from '../lib/savedAnswerStore';
import { resolveSubmittedApplicationAnswers } from '../lib/submittedAnswers';
import { blankRequiredQuestionLabels, preparedRunCanRestart, preparedRunHandoffExpired, resumeEditDisposition, reviewAnswerSaveDisposition, submitRequestDisposition } from '../lib/submissionSafety';
import { releasedExpiredAttendedHandoffReview } from '../lib/expiredHandoffClaimRelease';
import { submissionClaimPatch } from '../lib/submissionStop';
import { advanceCanonicalApplicationFromPacketSubmission } from '../lib/canonicalApplicationSync';
import { extensionAuthorizationRequiresAutomaticSubmission } from '../lib/submissionAuthorization';
import {
  detectPortal,
  isPortalSupported,
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
import { sendUnsupportedPortalApplicationEmail } from '../lib/unsupportedPortalEmailFallback';
import { requireFeature } from '../lib/entitlements';
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
  type DuplicateApplicationVerdict,
} from '../lib/duplicateApplication';
import { resolveFrozenApplicantEmail } from '../lib/applicationEmail';
import { findComposioVerificationCode } from '../lib/emailVerification';
import { registerWorkdayVerificationRoute } from './workdayVerification';
import { createAndPersistPacketAudit, currentAcknowledgedPacketAudit, currentPacketAudit, packetAuditClientError } from '../lib/packetAuditService';
import { createPdfGenerationBinding } from '../lib/pdfGenerationBinding';
import { resumeEmailOfRecord, resumePacketEmailIsCurrent } from '../lib/resumeEmail';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';

const paramsSchema = z.object({ id: z.string().uuid() });
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
async function repairExpiredAttendedHandoffClaim(
  row: NonNullable<Awaited<ReturnType<typeof ownedResume>>>,
  userId: string,
  log: FastifyRequest['log'],
): Promise<NonNullable<Awaited<ReturnType<typeof ownedResume>>> | null> {
  const current = readApplicationReview(row.spec);
  if (!current) return null;
  const released = await releasedExpiredAttendedHandoffReview(row.id, userId, current);
  if (!released) return null;
  const updated = await db.update(generated_resumes)
    .set({ spec: reviewSpec(released) })
    .where(and(
      eq(generated_resumes.id, row.id),
      eq(generated_resumes.user_id, userId),
      sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
    ))
    .returning({ id: generated_resumes.id });
  if (updated.length === 0) return null;
  log.info(
    {
      applicationId: row.id,
      releasedClaimId: released.claim_released?.claim_id ?? null,
      handoffExpiredAt: current.handoff_expires_at,
    },
    'Released the submission claim of an expired attended handoff whose run never pressed send',
  );
  return { ...row, spec: { ...(row.spec as StoredSpec), _review: released } };
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
  if (verdict.kind === 'unidentifiable') {
    log.warn(
      { applicationId: row.id },
      'duplicate guard abstained: no shared posting key with any submitted application',
    );
    return verdict;
  }
  if (verdict.kind !== 'duplicate') return verdict;
  const now = new Date().toISOString();
  const refused = applyReviewPatch(current, {
    status: 'needs_attention',
    attention_reason: verdict.reason,
    // Derived from the match rather than hardcoded. A refusal grounded in an UNVERIFIED twin is not
    // a duplicate_application: nobody knows yet whether there is a duplicate to be had, and filing
    // it as one would be the same false certainty the sentence itself is careful to avoid.
    attention_categories: [verdict.match.certainty === 'unverified' ? 'unverified_submission' : 'duplicate_application'],
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
    { applicationId: row.id, duplicateOf: verdict.match.application_id, basis: verdict.match.basis },
    'Submission refused: this user already applied to this posting',
  );
  return verdict;
}

export async function applicationRoutes(fastify: FastifyInstance) {
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
      const review = readApplicationReview(row.spec);
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
        const auditQuestions = refreshKnownQuestionAnswers(
          review.questions,
          await loadSensitiveQuestionProfile(request.jwtPayload!.userId),
          review.jd_text,
          review.questions_reviewed_at,
          postingCountryFromJobContext(row.job_context),
          postingCountryCodeFromJobContext(row.job_context),
        );
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
        /* A VALID CACHED AUDIT STILL HAS TO STORE THE QUESTIONS IT HASHED.
         *
         * currentPacketAudit can prove that an existing audit matches auditQuestions without
         * changing the row. That is normally the fast path, but it left a split packet whenever
         * refreshKnownQuestionAnswers changed a visible value: the audit and acknowledgement bound
         * the refreshed set while review.questions retained the older set. The next submit request
         * refreshed from that older record and could produce a different version, rejecting the
         * audit the applicant had acknowledged seconds earlier as packet_stale.
         *
         * The uncached path already persists auditQuestions through createAndPersistPacketAudit.
         * Make the cached path obey the same invariant. This exact CAS also protects a concurrent
         * edit or fill from being overwritten. cached.row matters because review_only may have
         * restored an expired PDF before returning the valid audit. */
        let packetRow = cached.valid ? cached.row : row;
        let cachedQuestionsPersisted = true;
        if (cached.valid) {
          const cachedReview = readApplicationReview(cached.row.spec);
          if (!cachedReview) {
            cachedQuestionsPersisted = false;
          } else if (!isDeepStrictEqual(cachedReview.questions, auditQuestions)) {
            const exactPacketReview = { ...cachedReview, questions: auditQuestions };
            const updated = await db.update(generated_resumes)
              .set({ spec: reviewSpec(exactPacketReview) })
              .where(and(
                eq(generated_resumes.id, cached.row.id),
                eq(generated_resumes.user_id, request.jwtPayload!.userId),
                sql`${generated_resumes.spec} = ${JSON.stringify(cached.row.spec)}::jsonb`,
                sql`${generated_resumes.resume_object_key} = ${cached.row.resume_object_key}`,
              ))
              .returning({ id: generated_resumes.id });
            cachedQuestionsPersisted = updated.length === 1;
            if (cachedQuestionsPersisted) {
              packetRow = {
                ...cached.row,
                spec: { ...(cached.row.spec as StoredSpec), _review: exactPacketReview },
              };
            }
          }
        }
        const result = cached.valid
          ? { audit: cached.audit, persisted: cachedQuestionsPersisted, pdfBytes: cached.pdfBytes }
          : await createAndPersistPacketAudit(row, { questions: auditQuestions });
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
      /* review_only: this IS the human step, not a send. The acknowledgement it writes is the
         applicant's own, checked against the digests she was shown, so it must never be preceded by
         a machine-written one. A rebuild here therefore leaves the digests she submitted stale and
         answers 409, which sends her back to re-audit the file that now exists. */
      const verdict = await currentPacketAudit(row, { restoreExpiredResume: 'review_only' });
      if (!verdict.valid) return reply.status(409).send(packetAuditClientError(verdict));
      const audit = verdict.audit;
      if (parsed.data.audit_digest !== audit.audit_digest
        || parsed.data.packet_version !== audit.packet_version
        || parsed.data.pdf_sha256 !== audit.bindings.pdf.sha256
        || parsed.data.size_bytes !== audit.bindings.pdf.sizeBytes) {
        return reply.status(409).send({
          error: 'The rendered packet no longer matches the saved application. Reload it before continuing.',
          code: 'PACKET_AUDIT_STALE',
        });
      }
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
      const review = readApplicationReview(row.spec);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });

      // This action-time read is the dashboard's sole authority to navigate. It deliberately
      // repeats every live packet check instead of trusting the audit object or URL held in React:
      // currentAcknowledgedPacketAudit revalidates the exact PDF/spec/JD/answers, current personal
      // resume email, and active owner/application Litos alias before any company URL is disclosed.
      const audit = await currentAcknowledgedPacketAudit(row, { restoreExpiredResume: 'authorizing_send' });
      if (!audit.valid) return reply.status(409).send(packetAuditClientError(audit));

      // PDF and alias verification perform external reads. Re-read the owner-scoped row after
      // those awaits and reject unless the complete saved packet is still byte-for-byte the one
      // that was audited. The URL below is derived only from this refreshed row, never the earlier
      // snapshot, so a concurrent portal/job/status/claim mutation cannot release a stale URL.
      const refreshed = await ownedResume(request, reply);
      if (!refreshed) return;
      if (refreshed.resume_object_key !== row.resume_object_key
        || !isDeepStrictEqual(refreshed.spec, row.spec)) {
        return reply.status(409).send({
          error: 'This application changed while its company handoff was being verified. Reload it before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
        });
      }
      const refreshedReview = readApplicationReview(refreshed.spec);
      if (!refreshedReview) {
        return reply.status(409).send({ error: 'Application review is not available for this resume' });
      }

      const url = verifiedDashboardHandoffUrl({
        applicationId: refreshed.id,
        userId: refreshed.user_id,
        frozenUrl: refreshedReview.portal_url,
        frozenHandoffUrl: refreshedReview.extension_handoff_url,
        frozenHandoffBinding: refreshedReview.extension_handoff_binding,
        frozenAtsName: refreshedReview.ats_name,
        status: refreshedReview.status,
        attentionReason: refreshedReview.attention_reason,
        attentionCategories: refreshedReview.attention_categories,
        submissionClaimedAt: refreshedReview.submission_claimed_at,
        submissionClaimId: refreshedReview.submission_claim_id,
        submissionPacketVersion: refreshedReview.submission_packet_version,
        submissionAttemptedAt: refreshedReview.submission_attempted_at,
        submittedAt: refreshedReview.submitted_at,
        receipt: refreshedReview.receipt,
        unverifiedSubmission: refreshedReview.unverified_submission,
      });
      if (!url) {
        return reply.status(409).send({
          error: 'This application no longer has a verified company handoff. Reload it before continuing.',
          code: 'MANUAL_HANDOFF_STALE',
        });
      }

      return reply.send({
        manual_handoff: {
          url,
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
      const auditVerdict = await currentAcknowledgedPacketAudit(row);
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
      if (extensionAuthorizationRequiresAutomaticSubmission(parsed.data.authorization)) {
        const automaticSubmission = await requireFeature(
          userId,
          'automatic_submission',
          'extension_automatic_submission',
        );
        if (!automaticSubmission.allowed) return reply.status(402).send(automaticSubmission.denial);
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
      const [precheckRow] = await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, params.data.id),
        eq(generated_resumes.user_id, userId),
      )).limit(1);
      const precheckReview = precheckRow ? readApplicationReview(precheckRow.spec) : null;
      let precheckPacketVersion: string | null = null;
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
        const auditVerdict = await currentAcknowledgedPacketAudit(precheckRow, { restoreExpiredResume: 'authorizing_send' });
        if (!auditVerdict.valid) {
          return reply.status(409).send(packetAuditClientError(auditVerdict));
        }
        precheckPacketVersion = auditVerdict.audit.packet_version;
        const verdict = await refuseDuplicateApplication(precheckRow, precheckReview, userId, fastify.log);
        if (verdict.kind === 'duplicate') return reply.status(409).send(duplicateApplicationResponse(verdict));
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
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
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
        const startOfDay = new Date();
        startOfDay.setUTCHours(0, 0, 0, 0);
        const [countRows, consent] = await Promise.all([
          tx.select({ total: sql<number>`count(*)::int` }).from(generated_resumes).where(and(
            eq(generated_resumes.user_id, userId),
            sql`${generated_resumes.spec}->'_review'->>'submission_claimed_at' >= ${startOfDay.toISOString()}`,
          )),
          tx.select({
          automatic_submission_enabled: users.automatic_submission_enabled,
          automatic_submission_consented_at: users.automatic_submission_consented_at,
          automatic_submission_consent_version: users.automatic_submission_consent_version,
          }).from(users).where(eq(users.id, userId)).limit(1),
        ]);
        const consentRow = consent[0];
        const disposition = canStartExtensionSubmission(current, parsed.data.authorization, consentRow?.automatic_submission_enabled === true);
        if (disposition !== 'start') return { kind: disposition, row, current };
        // The packet's PDF was frozen when it was built, so this is the last moment anything can
        // notice that the education block it prints no longer matches the profile. Checked BEFORE
        // the daily cap because drift is the actionable failure of the two: being told to fix a
        // graduation date is useful, being told to come back tomorrow is not.
        const profileRows = await tx.select({ parsed_json: profiles.parsed_json })
          .from(profiles).where(eq(profiles.user_id, userId)).limit(1);
        const educationIssues = packetEducationDrift(row.spec, profileRows[0]?.parsed_json);
        if (educationIssues.length > 0) return { kind: 'education_drift' as const, issues: educationIssues };
        const sensitiveProfile = await loadSensitiveQuestionProfile(userId);
        const packetCountry = postingCountryFromJobContext(row.job_context);
        const packetCountryCode = postingCountryCodeFromJobContext(row.job_context);
        const refreshedQuestions = refreshKnownQuestionAnswers(
          current.questions,
          sensitiveProfile,
          current.jd_text,
          current.questions_reviewed_at,
          packetCountry,
          packetCountryCode,
        );
        if (parsed.data.handoff_version && !isDeepStrictEqual(refreshedQuestions, current.questions)) {
          return { kind: 'changed' as const };
        }
        const sensitive = sensitiveQuestionFor(refreshedQuestions, sensitiveProfile, current.jd_text, packetCountry, packetCountryCode);
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
        if (!withinDailyCap(countRows[0]?.total ?? 0, dailySubmissionCap())) return { kind: 'cap' as const };
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
        return updated.length ? { kind: 'started' as const, row, claimId, next } : { kind: 'changed' as const };
      });
      if (result.kind === 'not_found') return reply.status(404).send({ error: 'Application not found' });
      if (result.kind === 'no_review') return reply.status(409).send({ error: 'Application review is not available for this resume' });
      if (result.kind === 'consent_required') return reply.status(403).send({ error: 'Automatic submission is turned off' });
      if (result.kind === 'submitted') return reply.send({ application_id: result.row.id, already_submitted: true, review: result.current });
      if (result.kind === 'in_flight') return reply.status(409).send({ error: 'This application already has an active submission' });
      if (result.kind === 'reject') return reply.status(409).send({ error: 'This application cannot be submitted again from its current state' });
      if (result.kind === 'education_drift') return reply.status(422).send(educationDriftResponse(result.issues));
      if (result.kind === 'sensitive_question') {
        return reply.status(422).send({ error: `Sensitive question requires your attention: ${result.question.slice(0, 120)}` });
      }
      if (result.kind === 'required_answer_missing') {
        // Same body shape as the unsupported-portal email refusal below, so a client can handle one
        // "you still owe an answer" response rather than two that differ only in wording.
        return reply.status(422).send({
          error: 'Answer every required question before submitting.',
          questions: result.questions,
        });
      }
      if (result.kind === 'cap') return reply.status(429).send({ error: 'Daily automatic submission safety limit reached' });
      if (result.kind === 'changed') return reply.status(409).send({ error: 'The application state changed before the extension could reserve it' });
      return reply.send({ application_id: result.row.id, claim_id: result.claimId, review: result.next });
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
      const outcomeAudit = await currentAcknowledgedPacketAudit(row);
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
      // Through applyReviewPatch, not a bare spread. extensionOutcomePatch's 'failed' arm writes
      // attention_reason: undefined, so the spread persisted a terminal state with no stated cause
      // in exactly the way the server runner used to.
      const next = applyReviewPatch(current, extensionOutcomePatch(outcome, now, {
        confirmationText: parsed.data.confirmation_text,
        finalUrl: parsed.data.final_url,
      }), () => now);
      const updated = await db.update(generated_resumes).set({
        spec: reviewSpec(next),
        ...(outcome === 'confirmed' ? { pipeline_stage: 'applied', pipeline_stage_at: new Date(now) } : {}),
      }).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, request.jwtPayload!.userId),
        sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
        sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
        sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${parsed.data.claim_id}`,
        sql`${generated_resumes.spec}->'_review'->>'status' = 'submitting'`,
      )).returning({ id: generated_resumes.id });
      if (!updated.length) return reply.status(409).send({ error: 'The application state changed before the outcome was recorded' });
      // The canonical row learns what the packet just did, gated on the status the persisted
      // review actually landed on rather than re-deriving it from the outcome the extension sent.
      if (next.status === 'submitted') {
        await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
      }
      return reply.send({ application_id: row.id, review: next });
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
      const contact = stored._contact as {
        full_name?: string;
        email?: string;
        phone?: string;
        linkedin_url?: string;
        github_url?: string;
        portfolio_url?: string;
      } | undefined;
      if (!review?.jd_text || !contact?.full_name) {
        return reply.status(409).send({ error: 'This older resume cannot be edited in the dashboard. Generate it again first.' });
      }
      /* Same refusal as the pre-send check, and for the same reason: this route re-renders the PDF
         from the STORED contact block, so editing a bullet on one of the contactless packets would
         write a fresh, still-contactless file over the old one. Editing cannot add an address; only
         regenerating reads the account again. */
      if (!hasContactRoute({ ...contact, full_name: contact.full_name })) {
        return reply.status(409).send({ error: 'This resume was made without an email address or a phone number on it. Generate it again to add your contact details, then edit it.' });
      }
      if (resumeEditDisposition(review.status, Boolean(review.submission_claimed_at)) !== 'start') {
        return reply.status(409).send({ error: 'This resume cannot be edited while its application is active or complete' });
      }
      if (review.role) {
        edited.target_role = resumeSafeTargetRole(review.role);
      }

      const userId = request.jwtPayload!.userId;
      const bank = await readExperienceBankOrSeedFromBaseResume(userId);
      const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
      const currentResumeEmail = resumeEmailOfRecord(profileRows[0]?.parsed_json);
      if (!resumePacketEmailIsCurrent(contact.email, currentResumeEmail)) {
        return reply.status(409).send({
          error: 'Your personal resume email changed or is missing. Regenerate this application before editing it.',
          code: 'resume_email_regeneration_required',
        });
      }
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
      let updated: Array<{ id: string }>;
      try {
        updated = await db.transaction(async (tx) => {
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
        return reply.status(202).send({ application_id: row.id, review: review ?? current });
      }
      return reply.send({ application_id: row.id, review: next });
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
      const stored = row.spec as StoredSpec;
      let current = readApplicationReview(stored);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
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
          : current.unverified_submission && !current.unverified_submission.resolution
            ? {
              error: 'Litos pressed Send on this one and could not confirm what came back, so it will '
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
      if (duplicateVerdict.kind === 'duplicate') {
        return reply.status(409).send(duplicateApplicationResponse(duplicateVerdict));
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
      const { questions: normalizedSubmittedQuestions, questionsReviewedAt: submittedReviewedAt } =
        resolveSubmittedApplicationAnswers({
          current,
          submitted: submittedQuestions,
          profile: sensitiveProfile,
          postingCountry: postingCountryFromJobContext(row.job_context),
          postingCountryCode: postingCountryCodeFromJobContext(row.job_context),
        });
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
      const blankRequired = blankRequiredQuestionLabels(normalizedSubmittedQuestions);
      if (sendsWithoutAnotherRun && blankRequired.length > 0) {
        return reply.status(422).send({
          error: 'Answer every required question before submitting.',
          questions: blankRequired,
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
        normalizedSubmittedQuestions, sensitiveProfile, current.jd_text,
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
        return reply.status(422).send({ error: `Sensitive question requires your attention: ${sensitive.question.slice(0, 120)}` });
      }
      const submitAudit = await currentAcknowledgedPacketAudit(row, {
        questions: normalizedSubmittedQuestions,
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
        normalizedSubmittedQuestions.map((question) => ({ question: question.question, answer: question.answer })),
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
        const base = freshSubmitRequestReview(current, normalizedSubmittedQuestions, submittedReviewedAt);
        const pending: ApplicationReviewState = {
          ...base,
          status: 'submitting',
          updated_at: authorizedAt,
          submission_authorization: current.submission_authorization ?? {
            source: 'per_application_approval',
            authorized_at: authorizedAt,
          },
        };
        const claimed = await db.update(generated_resumes)
          .set({ spec: reviewSpec(pending) })
          .where(and(
            eq(generated_resumes.id, row.id),
            eq(generated_resumes.user_id, request.jwtPayload!.userId),
            sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
            sql`${generated_resumes.spec}->'_review'->>'status' = ${current.status}`,
          ))
          .returning();
        if (claimed.length === 0) {
          const refreshed = await ownedResume(request, reply);
          if (!refreshed) return;
          const review = readApplicationReview(refreshed.spec);
          return reply.status(202).send({ application_id: row.id, review: review ?? current });
        }
        const claimedRow = claimed[0];
        let sent: { messageId: string; recipient: string };
        try {
          sent = await sendUnsupportedPortalApplicationEmail({
            application: claimedRow,
            review: pending,
            packet: await buildPacket(claimedRow),
          });
        } catch (error) {
          request.log.warn({ error, applicationId: row.id }, 'Unsupported portal email fallback failed');
          const failedAt = new Date().toISOString();
          // Same reason as the extension outcome above: a terminal status written by a bare spread
          // skips the one place that guarantees it carries a cause. This one at least has a
          // sentence worth showing, so it names it rather than falling back to the generic.
          const failed = applyReviewPatch(pending, {
            status: 'failed',
            submission_error: 'Litos could not email this application.',
            attention_reason: 'Litos could not email this application to the company, so nothing has been sent. Try it again once outbound application email is working.',
          }, () => failedAt);
          await db.update(generated_resumes)
            .set({ spec: reviewSpec(failed) })
            .where(and(
              eq(generated_resumes.id, row.id),
              sql`${generated_resumes.spec}->'_review'->>'status' = 'submitting'`,
            ));
          return reply.status(503).send({
            error: 'Litos could not email this application. Try again once outbound application email is configured.',
            code: 'UNSUPPORTED_PORTAL_EMAIL_UNAVAILABLE',
          });
        }
        const submittedAt = new Date().toISOString();
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
          ))
          .returning({ id: generated_resumes.id });
        if (updated.length === 0) {
          const refreshed = await ownedResume(request, reply);
          if (!refreshed) return;
          const review = readApplicationReview(refreshed.spec);
          return reply.status(202).send({ application_id: row.id, review: review ?? current });
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
      const next = freshSubmitRequestReview(current, normalizedSubmittedQuestions, submittedReviewedAt);
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
      const row = await ownedResume(request, reply);
      if (!row) return;
      let review = readApplicationReview(row.spec);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      review = await repairReviewPortalFromMonitoredJob(row, review);
      const profile = await loadSensitiveQuestionProfile(request.jwtPayload!.userId);
      review = {
        ...review,
        questions: refreshKnownQuestionAnswers(
          review.questions,
          profile,
          review.jd_text,
          review.questions_reviewed_at,
          postingCountryFromJobContext(row.job_context),
          postingCountryCodeFromJobContext(row.job_context),
        ),
      };
      let handoff_url: string | undefined;
      let handoff_packet_valid = true;
      if ((review.status === 'filling' || review.status === 'needs_attention') && review.browser_session_id) {
        const audit = await currentAcknowledgedPacketAudit(row);
        handoff_packet_valid = audit.valid;
        if (audit.valid) {
          try {
            handoff_url = await getLiveViewUrl(review.browser_session_id);
          } catch {
            handoff_url = undefined;
          }
        }
      }
      return reply.send({
        application_id: row.id,
        review,
        cover_letter: storedCoverLetter(row),
        // Keyed by kind, and built by the one reader that strips object_key. The spec holds the
        // Blob pointer because the packet builder needs it; this envelope must never carry it,
        // since a Blob object is public-read forever to anyone holding its URL.
        documents: storedDocuments(row),
        handoff_url,
        handoff_packet_valid,
        configured: isBrowserbaseConfigured(),
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
      const stored = row.spec as StoredSpec;
      const current = readApplicationReview(stored);
      if (!current || current.status !== 'needs_attention') {
        return reply.status(409).send({ error: 'This application is not waiting on you' });
      }
      const handoffAudit = await currentAcknowledgedPacketAudit(row);
      if (!handoffAudit.valid) {
        return reply.status(409).send(packetAuditClientError(handoffAudit));
      }
      const now = new Date().toISOString();
      /* Unchanged in meaning, narrowed to the case it was always describing. This route's
       * 'submitted' branch below refuses outright without a browser_session_id, so on the path that
       * genuinely needs a live session the two checks now agree instead of one of them answering
       * for packets the other would decline. A managed stop, which has no session, keeps its
       * "I cleared the check" for as long as it sits there. */
      if (preparedRunHandoffExpired(current)) {
        return reply.status(409).send({ error: 'That took too long and timed out. Start the application again.' });
      }
      if (parsed.data.outcome === 'submitted') {
        if (!current.browser_session_id) {
          return reply.status(409).send({ error: 'Open the company page first so we can attach this submission to a live handoff.' });
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
          });
        }
        const next = {
          ...current,
          status: 'submitted' as const,
          submitted_at: now,
          attention_reason: undefined,
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
        const submitted = await db.update(generated_resumes)
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
          ))
          .returning({ id: generated_resumes.id });
        if (submitted.length === 0) {
          const refreshed = await ownedResume(request, reply);
          if (!refreshed) return;
          const review = readApplicationReview(refreshed.spec);
          return reply.status(202).send({ application_id: row.id, review: review ?? current });
        }
        // The verified receipt filed the packet; the canonical row learns the same fact.
        await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
        return reply.send({ application_id: row.id, review: next, cover_letter: storedCoverLetter(row) });
      }
      const next = { ...current, status: 'ready_for_final_approval' as const, attention_reason: undefined, updated_at: now };
      const completed = await db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
          sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
          sql`${generated_resumes.spec}->'_review'->>'status' = 'needs_attention'`,
        ))
        .returning({ id: generated_resumes.id });
      if (completed.length === 0) {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        const review = readApplicationReview(refreshed.spec);
        return reply.status(202).send({ application_id: row.id, review: review ?? current });
      }
      return reply.send({ application_id: row.id, review: next, cover_letter: storedCoverLetter(row) });
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
      const submitted = await db.update(generated_resumes)
        .set({
          spec: reviewSpec(next),
          pipeline_stage: 'applied',
          pipeline_stage_at: new Date(now),
        })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, request.jwtPayload!.userId),
          // Conditional on the status this answered for, so a send that started somewhere else in
          // the meantime is not overwritten by an answer about the screen before it.
          sql`${generated_resumes.spec}->'_review'->>'status' = 'ready_for_final_approval'`,
        ))
        .returning({ id: generated_resumes.id });
      if (submitted.length === 0) {
        const refreshed = await ownedResume(request, reply);
        if (!refreshed) return;
        return reply.status(202).send({
          application_id: row.id,
          review: readApplicationReview(refreshed.spec) ?? current,
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
      });
    },
  );

  fastify.post(
    '/applications/:id/submission/approve',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const automaticSubmission = await requireFeature(
        request.jwtPayload!.userId,
        'automatic_submission',
        'dashboard_automatic_submission',
      );
      if (!automaticSubmission.allowed) return reply.status(402).send(automaticSubmission.denial);
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
      if (approvalDuplicate.kind === 'duplicate') {
        return reply.status(409).send(duplicateApplicationResponse(approvalDuplicate));
      }
      const sensitiveProfile = await loadSensitiveQuestionProfile(request.jwtPayload!.userId);
      const approvalReview: ApplicationReviewState = {
        ...current,
        questions: refreshKnownQuestionAnswers(
          current.questions,
          sensitiveProfile,
          current.jd_text,
          current.questions_reviewed_at,
          postingCountryFromJobContext(row.job_context),
          postingCountryCodeFromJobContext(row.job_context),
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
      const securityCodeAudit = await currentAcknowledgedPacketAudit(row, { restoreExpiredResume: 'authorizing_send' });
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
      const current = readApplicationReview(row.spec as StoredSpec);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      const pending = current.unverified_submission;
      if (!pending) {
        return reply.status(409).send({
          error: 'This application is not waiting on an unverified submission',
          status: current.status,
        });
      }
      if (pending.resolution) {
        // Idempotent rather than an error. The same answer twice is a retry, not a mistake, and a
        // retry of a resolved 'sent' is also the heal path for a canonical advance that failed the
        // first time.
        if (current.status === 'submitted') {
          await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
        }
        return reply.status(200).send({ application_id: row.id, already_resolved: true, review: current });
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
            confirmation_text: 'Confirmed by you: you found this application in the employer\u2019s portal '
              + 'after Litos pressed Send and lost the answer.',
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
      const updated = await db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
          // Conditional on the record still being unresolved, so two clients answering at once
          // cannot both win and leave the packet in the loser's state.
          sql`${generated_resumes.spec}->'_review'->'unverified_submission'->>'resolution' is null`,
        ))
        .returning({ id: generated_resumes.id });
      if (updated.length === 0) {
        return reply.status(409).send({ error: 'This application was resolved somewhere else first' });
      }
      // Only the arm that landed on 'submitted' filed anything; the released claim changes nothing
      // canonical. Gated on the persisted status, the same predicate the runner's writeReview uses.
      if (next.status === 'submitted') {
        await advanceCanonicalApplicationFromPacketSubmission({ packetId: row.id, userId: request.jwtPayload!.userId });
      }
      return reply.status(200).send({ application_id: row.id, review: next });
    },
  );
}
