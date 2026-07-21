import { randomUUID } from 'node:crypto';
import { put } from '@vercel/blob';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
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
import {
  deriveEditedTerms,
  readApplicationReview,
  type ApplicationReviewQuestion,
} from '../lib/applicationReview';
import { apiBaseFor } from '../lib/apiBase';
import { extractPdfText } from '../lib/pdfText';
import { mintDownloadToken } from '../lib/resumeAccess';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import { requireAuth } from '../middleware/auth';
import { declaredSkillsList } from './profile';

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
  status: z.enum(['submitting', 'submitted', 'failed']),
  error: z.string().max(2000).optional(),
});

type StoredSpec = Record<string, unknown>;

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
        _quality: {
          ...(stored._quality as Record<string, unknown> | undefined),
          atsCoverage: validation.ats_keyword_coverage_pct,
          visualWarnings: visual.warnings,
          layoutOmissions: rendered.omissions,
        },
      };
      await db
        .update(generated_resumes)
        .set({ spec: updatedSpec, resume_object_key: blob.pathname })
        .where(and(eq(generated_resumes.id, row.id), eq(generated_resumes.user_id, userId)));

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
      const next = {
        ...current,
        ...parsed.data,
        status: parsed.data.questions.length > 0 ? 'questions_ready' : 'ready_to_submit',
        updated_at: new Date().toISOString(),
      };
      await db.update(generated_resumes).set({ spec: { ...stored, _review: next } }).where(eq(generated_resumes.id, row.id));
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
      const next = {
        ...current,
        questions: parsed.data.questions as ApplicationReviewQuestion[],
        status: 'submit_requested' as const,
        updated_at: new Date().toISOString(),
      };
      await db.update(generated_resumes).set({ spec: { ...stored, _review: next } }).where(eq(generated_resumes.id, row.id));
      return reply.status(202).send({ application_id: row.id, review: next });
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
      const now = new Date().toISOString();
      const next = {
        ...current,
        status: parsed.data.status,
        updated_at: now,
        ...(parsed.data.status === 'submitted' ? { submitted_at: now, submission_error: undefined } : {}),
        ...(parsed.data.status === 'failed' ? { submission_error: parsed.data.error ?? 'The company portal rejected the submission.' } : {}),
      };
      await db.update(generated_resumes).set({ spec: { ...stored, _review: next } }).where(eq(generated_resumes.id, row.id));
      return reply.send({ application_id: row.id, review: next });
    },
  );
}
