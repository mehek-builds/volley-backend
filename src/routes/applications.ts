import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { settleStall } from '../lib/applicationStall';
import type { ApplicationReviewState } from '../lib/applicationReview';
import { readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import { generated_resumes, profiles, users, type ExperienceBankEntry } from '../db/schema';
import {
  findPdfTextFidelityIssues,
  findPdfSafeMarginIssues,
  renderResumePdf,
  validateResumeVisualLayout,
} from '../engine/resumeRender';
import { validatePdfLayout, validateResumeSpec } from '../engine/resumeValidate';
import { resumeSafeTargetRole } from '../engine/resumePolicy';
import {
  applyApplicationReviewEdit,
  deriveEditedTerms,
  readApplicationReview,
  type ApplicationReviewQuestion,
} from '../lib/applicationReview';
import { getLiveViewUrl, isBrowserbaseConfigured } from '../lib/browserbase';
import { apiBaseFor } from '../lib/apiBase';
import { extractPdfText } from '../lib/pdfText';
import { storedCoverLetter } from '../lib/coverLetterService';
import { mintDownloadToken } from '../lib/resumeAccess';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import { requireAuth } from '../middleware/auth';
import { declaredSkillsList } from './profile';
import { processSubmissionApplication } from './submissionRunner';
import { isRefusedQuestion } from '../lib/questionDiscovery';
import { submitRequestDisposition } from '../lib/submissionSafety';
import { detectPortal, isPortalSupported } from '../lib/portalSubmission';
import { dailySubmissionCap, withinDailyCap } from '../lib/submissionQueue';
import { canStartExtensionSubmission, extensionOutcomePatch, isSafeExtensionReceiptUrl } from '../lib/extensionSubmission';
import {
  candidateEducationFromParsedProfile,
  educationDriftResponse,
  packetEducationDrift,
} from '../lib/submissionEducationGuard';

const paramsSchema = z.object({ id: z.string().uuid() });
const questionSchema = z.object({
  id: z.string().min(1).max(200),
  question: z.string().min(1).max(4000),
  answer: z.string().max(20_000),
  kind: z.enum(['essay', 'required']),
  required: z.boolean(),
});
const reviewBodySchema = z.object({
  ats_name: z.string().min(1).max(100),
  portal_url: z.string().url().max(4000),
  questions: z.array(questionSchema).max(100),
  skipped_reasons: z.array(z.string().max(1000)).max(100).default([]),
});
const submitBodySchema = z.object({
  questions: z.array(questionSchema).max(100),
});
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
  outcome: z.enum(['confirmed', 'failed', 'unknown']),
  confirmation_text: z.string().max(2000).optional(),
  final_url: extensionReceiptUrlSchema,
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
  if (!has('name') && !(has('firstname') && has('lastname'))) {
    issues.push('The filled form did not record the applicant name fields.');
  }
  if (coverLetterRequired && !has('cover')) {
    issues.push('The filled form did not record the cover letter attachment.');
  }
  return issues;
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
        const sensitive = current.questions.find((question) => isRefusedQuestion(question.question));
        if (sensitive) return { kind: 'sensitive_question' as const, question: sensitive.question };
        if (!withinDailyCap(countRows[0]?.total ?? 0, dailySubmissionCap())) return { kind: 'cap' as const };
        const now = new Date().toISOString();
        const claimId = randomUUID();
        const next = {
          ...current,
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
      const next = { ...current, ...extensionOutcomePatch(parsed.data.outcome, now, {
        confirmationText: parsed.data.confirmation_text,
        finalUrl: parsed.data.final_url,
      }), updated_at: now };
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
      if (submitRequestDisposition(review.status) !== 'start') {
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
      const validation = validateResumeSpec(
        edited,
        review.jd_text,
        bank,
        declaredSkillsList(profileRows[0]?.skills),
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
        // Through settleStall like every other writer: this route can run on an application that is
      // waiting on a challenge, and abandoning that wait has to close it rather than carry an open
      // stall into a status the queue no longer looks at.
      _review: settleStall(updatedReview as ApplicationReviewState),
        ...(stored._cover_letter ? { _cover_letter: stored._cover_letter } : {}),
        _quality: {
          ...(stored._quality as Record<string, unknown> | undefined),
          atsCoverage: validation.ats_keyword_coverage_pct,
          visualWarnings: visual.warnings,
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
        download_url: `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(userId, blob.pathname, { blobUrl: blob.url })}`,
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
      if (parsed.data.questions.some((question) => question.required && !question.answer.trim())) {
        return reply.status(422).send({ error: 'Answer every required question before submitting.' });
      }
      const stored = row.spec as StoredSpec;
      const current = readApplicationReview(stored);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      const disposition = submitRequestDisposition(current.status, Boolean(current.submission_claimed_at));
      if (disposition === 'submitted') {
        return reply.status(200).send({ application_id: row.id, review: current, cover_letter: storedCoverLetter(row) });
      }
      if (disposition === 'in_flight') {
        return reply.status(202).send({ application_id: row.id, review: current, cover_letter: storedCoverLetter(row) });
      }
      if (disposition === 'reject') {
        return reply.status(409).send({ error: 'This application cannot start another submission run from its current state' });
      }
      // Guarded here as well as on extension-start, and not because this route is unattended today.
      // The dashboard now refuses to send a drifted packet, but a frontend check is not an
      // enforcement point: this audit exists because a client-side assumption turned out to be
      // false, and submit-request accepts a bare list of answers from any authenticated caller. The
      // review screen saves through PATCH /resume before it sends, and that route runs this exact
      // comparison, so a correctly-saved packet reaches this line with nothing to report.
      const submitProfileRows = await db.select({ parsed_json: profiles.parsed_json })
        .from(profiles).where(eq(profiles.user_id, request.jwtPayload!.userId)).limit(1);
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
      const sensitive = parsed.data.questions.find((question) => isRefusedQuestion(question.question));
      if (sensitive) {
        return reply.status(422).send({ error: `Sensitive question requires your attention: ${sensitive.question.slice(0, 120)}` });
      }
      // Refused here, before anything is claimed or a browser is booked, because the answer has
      // been available since the packet was created. Without this the run started, drove a managed
      // browser for minutes, and only then failed on detectPortal's throw - which is how nine of
      // one account's ten failures came to be multi-minute waits for a verdict we already had. A
      // client that respects portal_supported never reaches this line; it exists because a
      // client-side check is not an enforcement point.
      if (current.portal_url && !isPortalSupported(current.portal_url)) {
        return reply.status(422).send({
          error: 'Litos cannot fill in this company’s application page yet. Your tailored resume is ready to download, so you can apply on their site.',
          code: 'PORTAL_NOT_SUPPORTED',
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
      const next = {
        ...current,
        questions: parsed.data.questions as ApplicationReviewQuestion[],
        status: 'submit_requested' as const,
        updated_at: new Date().toISOString(),
        attention_reason: undefined,
        handoff_expires_at: undefined,
        browser_session_id: undefined,
      };
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
    '/applications/:id/submission',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await ownedResume(request, reply);
      if (!row) return;
      const review = readApplicationReview(row.spec);
      if (!review) return reply.status(409).send({ error: 'Application review is not available for this resume' });
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
      const stored = row.spec as StoredSpec;
      const current = readApplicationReview(stored);
      if (!current || current.status !== 'needs_attention') {
        return reply.status(409).send({ error: 'This application is not waiting on you' });
      }
      if (current.handoff_expires_at && Date.parse(current.handoff_expires_at) < Date.now()) {
        return reply.status(409).send({ error: 'That took too long and timed out. Start the application again.' });
      }
      const next = { ...current, status: 'ready_for_final_approval' as const, attention_reason: undefined, updated_at: new Date().toISOString() };
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
      if (current.handoff_expires_at && Date.parse(current.handoff_expires_at) < Date.now()) {
        return reply.status(409).send({ error: 'That took too long and timed out. Start the application again.' });
      }
      const approvalIssues: string[] = [];
      if (current.portal_url && !isPortalSupported(current.portal_url)) {
        approvalIssues.push('Litos cannot fill in this company’s application page yet.');
      }
      if (!current.preview_screenshot_url?.trim()) {
        approvalIssues.push('The filled form preview is missing.');
      }
      if ((current.filled_fields ?? []).length === 0) {
        approvalIssues.push('No filled application fields were recorded.');
      }
      const coverLetter = storedCoverLetter(row);
      if (current.cover_letter_supported === true && !coverLetter) {
        approvalIssues.push('The cover letter must be reviewed before sending.');
      }
      approvalIssues.push(...finalApprovalFieldIssues(current, current.cover_letter_supported === true && Boolean(coverLetter)));
      if (current.questions.some((question) => question.required && !question.answer.trim())) {
        approvalIssues.push('A required application answer is still blank.');
      }
      const sensitive = current.questions.find((question) => isRefusedQuestion(question.question));
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
        ...current,
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
