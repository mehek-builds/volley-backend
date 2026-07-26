import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import { waitUntil } from '@vercel/functions';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { readExperienceBank } from '../db/experienceBank';
import { generated_resumes, profiles } from '../db/schema';
import {
  findPdfTextFidelityIssues,
  renderResumePdf,
  validateResumeVisualLayout,
} from '../engine/resumeRender';
import { validatePdfLayout, validateResumeSpec } from '../engine/resumeValidate';
import { resumeSafeTargetRole } from '../engine/resumePolicy';
import {
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
import { authorizedGreenhouseRoute } from '../lib/authorizedAts';
import { detectPortal } from '../lib/portalSubmission';

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

type StoredSpec = Record<string, unknown>;

function reviewSpec(review: unknown) {
  return sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(review)}::jsonb, true)`;
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

export async function applicationRoutes(fastify: FastifyInstance) {
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
      const bank = await readExperienceBank(userId);
      const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
      const parsed = profileRows[0]?.parsed_json as {
        school?: string;
        degree?: string;
        grad_date?: string;
        grad_year?: number;
        currently_enrolled?: boolean;
        coursework?: string[];
      } | undefined;
      const education = {
        school: parsed?.school ?? '',
        degree: parsed?.degree,
        grad_date: parsed?.grad_date || (parsed?.grad_year ? String(parsed.grad_year) : undefined),
        grad_year: parsed?.grad_year,
        currently_enrolled: parsed?.currently_enrolled,
        coursework: Array.isArray(parsed?.coursework) ? parsed.coursework : [],
      };
      const validation = validateResumeSpec(
        edited,
        review.jd_text,
        bank,
        declaredSkillsList(profileRows[0]?.skills),
        education,
        review.role,
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
        _review: updatedReview,
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
      if (!parsed.success) return reply.status(400).send({ error: 'Invalid review packet', detail: parsed.error.issues });
      const stored = row.spec as StoredSpec;
      const current = readApplicationReview(stored);
      if (!current) return reply.status(409).send({ error: 'Application review is not available for this resume' });
      if (submitRequestDisposition(current.status) !== 'start') {
        return reply.status(409).send({ error: 'This application can no longer be edited from its current submission state' });
      }
      const next = {
        ...current,
        ...parsed.data,
        status: parsed.data.questions.length > 0 ? 'questions_ready' : 'ready_to_submit',
        updated_at: new Date().toISOString(),
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
        return reply.status(200).send({ application_id: row.id, review: current });
      }
      if (disposition === 'in_flight') {
        return reply.status(202).send({ application_id: row.id, review: current });
      }
      if (disposition === 'reject') {
        return reply.status(409).send({ error: 'This application cannot start another submission run from its current state' });
      }
      const sensitive = parsed.data.questions.find((question) => isRefusedQuestion(question.question));
      if (sensitive) {
        return reply.status(422).send({ error: `Sensitive question requires your attention: ${sensitive.question.slice(0, 120)}` });
      }
      const controlledTest = process.env.LITOS_ENABLE_TEST_PORTAL === 'true'
        && current.portal_url
        && detectPortal(current.portal_url) === 'controlled_test';
      if (!controlledTest && !isBrowserbaseConfigured() && !authorizedGreenhouseRoute(current.portal_url ?? '')) {
        return reply.status(503).send({
          error: 'The secure portal runner is not configured yet.',
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
        browser_context_id: undefined,
        browser_session_id: undefined,
        preparation_claimed_at: undefined,
        preparation_claim_id: undefined,
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
      const task = processSubmissionApplication(row.id, fastify).catch((error) => {
        fastify.log.error({ error, applicationId: row.id }, 'Background application runner failed');
      });
      if (process.env.VERCEL) waitUntil(task);
      else void task;
      return reply.status(202).send({ application_id: row.id, review: next });
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
          handoff_url = await getLiveViewUrl(
            review.browser_session_id,
            review.captcha?.provider_requested ? 'browserbase' : undefined,
          );
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
        return reply.status(409).send({ error: 'This application is not waiting for portal attention' });
      }
      if (current.handoff_expires_at && Date.parse(current.handoff_expires_at) < Date.now()) {
        return reply.status(409).send({ error: 'The secure portal session expired. Start the submission again.' });
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
      return reply.send({ application_id: row.id, review: next });
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
        return reply.status(409).send({ error: 'Review the prepared portal before final approval' });
      }
      if (current.handoff_expires_at && Date.parse(current.handoff_expires_at) < Date.now()) {
        return reply.status(409).send({ error: 'The secure portal session expired. Start the submission again.' });
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
      return reply.status(202).send({ application_id: row.id, review: processed ?? next });
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
        submission_error: parsed.data.error ?? 'The company portal rejected the submission.',
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
