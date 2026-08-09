import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
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
import {
  applyApplicationReviewEdit,
  deriveEditedTerms,
  mergeSubmittedApplicationReviewQuestions,
  normalizeApplicationReviewQuestions,
  readApplicationReview,
  type ApplicationReviewQuestion,
} from '../lib/applicationReview';
import { repairReviewPortalFromMonitoredJob } from '../lib/applicationPortalRepair';
import { getLiveViewUrl, isBrowserbaseConfigured } from '../lib/browserbase';
import { apiBaseFor } from '../lib/apiBase';
import { extractPdfText } from '../lib/pdfText';
import { storedCoverLetter } from '../lib/coverLetterService';
import { mintDownloadToken } from '../lib/resumeAccess';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import { requireAuth } from '../middleware/auth';
import { declaredSkillsList } from './profile';
import { buildPacket, finishSecurityCodeSubmission, processSubmissionApplication } from './submissionRunner';
import { refreshKnownQuestionAnswers, sensitiveQuestionRequiresAttention, type ApplicationProfileLike } from '../lib/questionDiscovery';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import { rememberReusableAnswers } from '../lib/savedAnswerStore';
import { blankRequiredQuestionLabels, preparedRunCanRestart, preparedRunHandoffExpired, resumeEditDisposition, submitRequestDisposition } from '../lib/submissionSafety';
import {
  detectPortal,
  isPortalSupported,
} from '../lib/portalSubmission';
import { dailySubmissionCap, withinDailyCap } from '../lib/submissionQueue';
import { canStartExtensionSubmission, extensionOutcomePatch, isSafeExtensionReceiptUrl } from '../lib/extensionSubmission';
import {
  candidateEducationFromParsedProfile,
  educationDriftResponse,
  packetEducationDrift,
} from '../lib/submissionEducationGuard';
import { resumeFileNameForRole } from '../lib/resumeFileName';
import { sendUnsupportedPortalApplicationEmail } from '../lib/unsupportedPortalEmailFallback';
import { assessAtsSubmissionChannel } from '../lib/atsSubmissionChannels';
import {
  duplicateApplicationResponse,
  duplicateApplicationVerdict,
  type DuplicateApplicationVerdict,
} from '../lib/duplicateApplication';
import { resolveFrozenApplicantEmail } from '../lib/applicationEmail';
import { findComposioVerificationCode } from '../lib/emailVerification';
import { registerWorkdayVerificationRoute } from './workdayVerification';

const paramsSchema = z.object({ id: z.string().uuid() });
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
const extensionStartBodySchema = z.object({
  authorization: z.enum(['standing_consent', 'user_initiated']),
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

function freshSubmitRequestReview(
  current: ApplicationReviewState,
  questions: ApplicationReviewQuestion[],
): ApplicationReviewState {
  return {
    ...current,
    questions,
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

function editableResumeSpec(value: unknown): ResumeSpec {
  const spec = normalizeSpec(value);
  if (!spec.school && spec.experience.length === 0 && spec.skills.length === 0) {
    throw new Error('Resume content is empty');
  }
  return spec;
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
    ...visual.issues,
    ...validatePdfLayout(parsedPdf.text, parsedPdf.numpages).issues,
    ...findPdfSafeMarginIssues(parsedPdf.pages, rendered.layout),
    ...findPdfTextFidelityIssues(parsedPdf.text, rendered.spec, { ...contact, full_name: contact.full_name }),
  ];
}

function normalizedFilledFields(fields: readonly string[] | undefined): Set<string> {
  return new Set((fields ?? []).map((field) => field.toLowerCase().replace(/[^a-z0-9]/g, '')));
}

function finalApprovalFieldIssues(review: ApplicationReviewState, coverLetterRequired: boolean): string[] {
  const normalized = normalizedFilledFields(review.filled_fields);
  const has = (needle: string) => [...normalized].some((field) => field.includes(needle));
  const issues: string[] = [];
  if (!has('email')) issues.push('The filled form did not record an email field.');
  if (!has('resume')) issues.push('The filled form did not record a resume upload.');
  if (!has('name') && !(has('first') && has('last'))) {
    issues.push('The filled form did not record the applicant name fields.');
  }
  if (coverLetterRequired && !has('cover')) {
    issues.push('The filled form did not record the cover letter attachment.');
  }
  return issues;
}

async function loadSensitiveQuestionProfile(userId: string): Promise<ApplicationProfileLike> {
  return loadApplicationProfileLike(userId);
}

function sensitiveQuestionFor(
  questions: readonly ApplicationReviewQuestion[],
  profile: ApplicationProfileLike,
  jdText: string | undefined,
): ApplicationReviewQuestion | undefined {
  return normalizeApplicationReviewQuestions(questions)
    .find((question) => sensitiveQuestionRequiresAttention(question.question, question.answer, 'text', profile, jdText));
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
    attention_categories: ['duplicate_application'],
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
       * Ahead of the transaction, not inside it, so the read is not competing with the advisory
       * lock the claim takes. Nothing is claimed yet at this point, so there is nothing to undo. */
      const [precheckRow] = await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, params.data.id),
        eq(generated_resumes.user_id, userId),
      )).limit(1);
      const precheckReview = precheckRow ? readApplicationReview(precheckRow.spec) : null;
      if (precheckRow && precheckReview && precheckReview.status !== 'submitted') {
        const verdict = await refuseDuplicateApplication(precheckRow, precheckReview, userId, fastify.log);
        if (verdict.kind === 'duplicate') return reply.status(409).send(duplicateApplicationResponse(verdict));
      }
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
        const rows = await tx.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, params.data.id),
          eq(generated_resumes.user_id, userId),
        )).limit(1);
        const row = rows[0];
        if (!row) return { kind: 'not_found' as const };
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
        const refreshedQuestions = refreshKnownQuestionAnswers(
          current.questions,
          sensitiveProfile,
          current.jd_text,
          current.questions_reviewed_at,
        );
        const sensitive = sensitiveQuestionFor(refreshedQuestions, sensitiveProfile, current.jd_text);
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
          submission_claimed_at: now,
          submission_claim_id: claimId,
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
      if (current.status === 'submitted') return reply.send({ application_id: row.id, review: current });
      if (current.submission_claim_id !== parsed.data.claim_id || current.status !== 'submitting') {
        return reply.status(409).send({ error: 'This extension submission is no longer active' });
      }
      const now = new Date().toISOString();
      // Through applyReviewPatch, not a bare spread. extensionOutcomePatch's 'failed' arm writes
      // attention_reason: undefined, so the spread persisted a terminal state with no stated cause
      // in exactly the way the server runner used to.
      const next = applyReviewPatch(current, extensionOutcomePatch(parsed.data.outcome, now, {
        confirmationText: parsed.data.confirmation_text,
        finalUrl: parsed.data.final_url,
      }), () => now);
      const updated = await db.update(generated_resumes).set({
        spec: reviewSpec(next),
        ...(parsed.data.outcome === 'confirmed' ? { pipeline_stage: 'applied', pipeline_stage_at: new Date(now) } : {}),
      }).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, request.jwtPayload!.userId),
        sql`${generated_resumes.spec}->'_review'->>'submission_claim_id' = ${parsed.data.claim_id}`,
        sql`${generated_resumes.spec}->'_review'->>'status' = 'submitting'`,
      )).returning({ id: generated_resumes.id });
      if (!updated.length) return reply.status(409).send({ error: 'The application state changed before the outcome was recorded' });
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
      if (validation.issues.length > 0) {
        return reply.status(422).send({
          error: 'Fix the flagged resume content before continuing.',
          issues: validation.issues,
        });
      }

      const rendered = await renderResumePdf(edited, { ...contact, full_name: contact.full_name }, review.jd_text);
      const visual = validateResumeVisualLayout(rendered.layout);
      const parsedPdf = await extractPdfText(rendered.buffer);
      const pdfIssues = [
        ...visual.issues,
        ...validatePdfLayout(parsedPdf.text, parsedPdf.numpages).issues,
        ...findPdfSafeMarginIssues(parsedPdf.pages, rendered.layout),
        ...findPdfTextFidelityIssues(parsedPdf.text, rendered.spec, { ...contact, full_name: contact.full_name }),
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
        ...('_applicant_email' in stored ? { _applicant_email: stored._applicant_email } : {}),
        ...('_application_email' in stored ? { _application_email: stored._application_email } : {}),
        // Through settleStall like every other writer: this route can run on an application that is
      // waiting on a challenge, and abandoning that wait has to close it rather than carry an open
      // stall into a status the queue no longer looks at.
      _review: settleStall(updatedReview as ApplicationReviewState),
        ...(stored._cover_letter ? { _cover_letter: stored._cover_letter } : {}),
        _quality: {
          ...(stored._quality as Record<string, unknown> | undefined),
          atsCoverage: validation.ats_keyword_coverage_pct,
          visualWarnings: visual.warnings,
          groundingRemoved: grounded.removed,
          layoutOmissions: rendered.omissions,
        },
      };
      const updated = await db
        .update(generated_resumes)
        .set({ spec: updatedSpec, resume_object_key: blob.pathname })
        .where(and(
          eq(generated_resumes.id, row.id),
          eq(generated_resumes.user_id, userId),
          sql`${generated_resumes.spec}->'_review'->>'status' = ${review.status}`,
        ))
        .returning({ id: generated_resumes.id });
      if (updated.length === 0) {
        return reply.status(409).send({ error: 'The application state changed before the resume edit finished' });
      }

      return reply.send({
        id: row.id,
        spec: updatedSpec,
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
      if (submitRequestDisposition(current.status) !== 'start') {
        return reply.status(409).send({ error: 'This application can no longer be edited from its current submission state' });
      }
      // Not a spread here: an edit that changes portal_url has to re-derive portal_supported with
      // it, or the review persists a new URL next to the old verdict. See applyApplicationReviewEdit.
      const next = applyApplicationReviewEdit(current, parsed.data);
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
      return reply.send({ application_id: row.id, review: next });
    },
  );

  fastify.post(
    '/applications/:id/submit-request',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const parsed = submitBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid answers', detail: parsed.error.issues });
      const stored = row.spec as StoredSpec;
      let current = readApplicationReview(stored);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      current = await repairReviewPortalFromMonitoredJob(row, current);
      const disposition = submitRequestDisposition(current.status, Boolean(current.submission_claimed_at));
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
      const mergedSubmittedQuestions = mergeSubmittedApplicationReviewQuestions(
        current.questions,
        submittedQuestions,
        current.questions_reviewed_at,
      );
      const normalizedSubmittedQuestions = refreshKnownQuestionAnswers(
        mergedSubmittedQuestions,
        sensitiveProfile,
        current.jd_text,
        current.questions_reviewed_at,
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
      const preSendIssues = await preSendResumeVerificationIssues(request.jwtPayload!.userId, stored);
      if (preSendIssues.length > 0) {
        return reply.status(422).send({
          error: 'Verify the resume before sending. The current packet is not ready for submission.',
          code: 'PRE_SEND_VERIFICATION_FAILED',
          issues: preSendIssues,
        });
      }
      const sensitive = sensitiveQuestionFor(normalizedSubmittedQuestions, sensitiveProfile, current.jd_text);
      // A supported portal needs the browser run to discover and surface the live form's
      // declarations. Blocking that run on the pre-run snapshot creates a deadlock: the question
      // cannot be answered until the form has been inspected, but inspection never starts. The
      // unsupported path below has no intervening fill and emails the employer immediately, so it
      // remains a send gate here. Final approval and direct browser submission retain their own
      // post-discovery gates.
      if (current.portal_url && !isPortalSupported(current.portal_url) && sensitive) {
        return reply.status(422).send({ error: `Sensitive question requires your attention: ${sensitive.question.slice(0, 120)}` });
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
        const base = freshSubmitRequestReview(current, normalizedSubmittedQuestions);
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
      const next = freshSubmitRequestReview(current, normalizedSubmittedQuestions);
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
        ),
      };
      let handoff_url: string | undefined;
      if (review.status === 'needs_attention' && review.browser_session_id) {
        try {
          handoff_url = await getLiveViewUrl(review.browser_session_id);
        } catch {
          handoff_url = undefined;
        }
      }
      return reply.send({
        application_id: row.id,
        review,
        cover_letter: storedCoverLetter(row),
        handoff_url,
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
        const finalUrl = parsed.data.final_url ?? current.portal_url;
        if (!finalUrl) return reply.status(409).send({ error: 'This application is missing the company page URL' });
        const next = {
          ...current,
          status: 'submitted' as const,
          submitted_at: now,
          attention_reason: undefined,
          submission_error: undefined,
          updated_at: now,
          receipt: {
            confirmation_text: parsed.data.confirmation_text?.trim()
              || 'Submitted by the applicant in the live company page',
            final_url: finalUrl,
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
            sql`${generated_resumes.spec}->'_review'->>'status' = 'needs_attention'`,
          ))
          .returning({ id: generated_resumes.id });
        if (submitted.length === 0) {
          const refreshed = await ownedResume(request, reply);
          if (!refreshed) return;
          const review = readApplicationReview(refreshed.spec);
          return reply.status(202).send({ application_id: row.id, review: review ?? current });
        }
        return reply.send({ application_id: row.id, review: next, cover_letter: storedCoverLetter(row) });
      }
      const next = { ...current, status: 'ready_for_final_approval' as const, attention_reason: undefined, updated_at: now };
      const completed = await db.update(generated_resumes)
        .set({ spec: reviewSpec(next) })
        .where(and(
          eq(generated_resumes.id, row.id),
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
      const coverLetter = storedCoverLetter(row);
      if (approvalReview.cover_letter_supported === true && !coverLetter) {
        approvalIssues.push('The cover letter must be reviewed before sending.');
      }
      approvalReview.questions = normalizeApplicationReviewQuestions(approvalReview.questions);
      approvalIssues.push(...finalApprovalFieldIssues(approvalReview, approvalReview.cover_letter_supported === true && Boolean(coverLetter)));
      if (approvalReview.questions.some((question) => question.required && !question.answer.trim())) {
        approvalIssues.push('A required application answer is still blank.');
      }
      const sensitive = sensitiveQuestionFor(approvalReview.questions, sensitiveProfile, approvalReview.jd_text);
      if (sensitive) {
        approvalIssues.push(`Sensitive question requires your attention: ${sensitive.question.slice(0, 120)}`);
      }
      approvalIssues.push(...await preSendResumeVerificationIssues(request.jwtPayload!.userId, stored));
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
    automaticVerificationEnabled: async (userId) => {
      const [settings] = await db.select({ enabled: users.automatic_verification_enabled })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      return settings?.enabled === true;
    },
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
      if (submitRequestDisposition(current.status) !== 'start') {
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
}
