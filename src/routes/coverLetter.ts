import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { put } from '@vercel/blob';
import { z } from 'zod';
import { db } from '../db/index';
import { generated_resumes, profiles } from '../db/schema';
import { readExperienceBank } from '../db/experienceBank';
import { readApplicationReview } from '../lib/applicationReview';
import { renderCoverLetterPdf } from '../lib/coverLetterPdf';
import { apiBaseFor } from '../lib/apiBase';
import { mintDownloadToken } from '../lib/resumeAccess';
import { generateCoverLetter, validateCoverLetter } from '../llm/coverLetter';
import { requireAuth } from '../middleware/auth';

const paramsSchema = z.object({ id: z.string().uuid() });
const updateSchema = z.object({ body: z.string().trim().min(100).max(10_000) });
type StoredSpec = Record<string, unknown>;

async function ownedApplication(request: FastifyRequest, reply: FastifyReply) {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid application id' });
    return null;
  }
  const rows = await db.select().from(generated_resumes).where(and(
    eq(generated_resumes.id, parsed.data.id),
    eq(generated_resumes.user_id, request.jwtPayload!.userId),
  )).limit(1);
  if (!rows[0]) {
    reply.status(404).send({ error: 'Application not found' });
    return null;
  }
  return rows[0];
}

async function candidateContext(row: typeof generated_resumes.$inferSelect) {
  const [bank, profileRows] = await Promise.all([
    readExperienceBank(row.user_id),
    db.select().from(profiles).where(eq(profiles.user_id, row.user_id)).limit(1),
  ]);
  const stored = row.spec as StoredSpec;
  return JSON.stringify({
    education: profileRows[0]?.parsed_json ?? {},
    declared_skills: profileRows[0]?.skills ?? [],
    selected_resume: Object.fromEntries(Object.entries(stored).filter(([key]) => !key.startsWith('_'))),
    experience_bank: bank,
  });
}

async function persistCoverLetter(
  request: FastifyRequest,
  row: typeof generated_resumes.$inferSelect,
  body: string,
  warnings: string[],
  wordCount: number,
) {
  const stored = row.spec as StoredSpec;
  const review = readApplicationReview(stored);
  const contact = (stored._contact ?? {}) as { full_name?: string; email?: string };
  const job = row.job_context as { company?: string; role?: string };
  if (!review?.jd_text || !job.company || !job.role || !contact.full_name) throw new Error('Application packet is incomplete');
  const pdf = await renderCoverLetterPdf({ full_name: contact.full_name, email: contact.email }, job.company, body);
  const blob = await put(`users/${row.user_id}/resumes/${row.id}-cover-letter-${Date.now()}.pdf`, pdf, {
    access: 'public',
    contentType: 'application/pdf',
  });
  const generatedAt = new Date().toISOString();
  const coverLetter = {
    body,
    word_count: wordCount,
    warnings,
    generated_at: generatedAt,
    object_key: blob.pathname,
    file_name: `${contact.full_name.replace(/\s+/g, '_')}_${job.company.replace(/\s+/g, '_')}_Cover_Letter.pdf`,
  };
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(${generated_resumes.spec}, '{_cover_letter}', ${JSON.stringify(coverLetter)}::jsonb, true)`,
  }).where(and(eq(generated_resumes.id, row.id), eq(generated_resumes.user_id, row.user_id)));
  return {
    cover_letter: coverLetter,
    download_url: `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(row.user_id, blob.pathname, { blobUrl: blob.url })}`,
  };
}

export async function coverLetterRoutes(fastify: FastifyInstance) {
  fastify.post('/applications/:id/cover-letter', { preHandler: requireAuth }, async (request, reply) => {
    const row = await ownedApplication(request, reply);
    if (!row) return;
    const stored = row.spec as StoredSpec;
    const review = readApplicationReview(stored);
    const job = row.job_context as { company?: string; role?: string };
    if (!review?.jd_text || !job.company || !job.role) return reply.status(409).send({ error: 'Application packet is incomplete' });
    const source = await candidateContext(row);
    let body = '';
    let validation = { issues: ['not generated'], warnings: [] as string[], word_count: 0, body: '' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      body = await generateCoverLetter({ company: job.company, role: job.role, jd_text: review.jd_text, candidate_source: source }, validation.issues);
      validation = validateCoverLetter(body, job.company, job.role, source);
      if (validation.issues.length === 0) break;
    }
    if (validation.issues.length > 0) {
      return reply.status(422).send({ error: 'The cover letter did not pass grounding checks.', issues: validation.issues });
    }
    return reply.send(await persistCoverLetter(request, row, validation.body, validation.warnings, validation.word_count));
  });

  fastify.patch('/applications/:id/cover-letter', { preHandler: requireAuth }, async (request, reply) => {
    const row = await ownedApplication(request, reply);
    if (!row) return;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid cover letter' });
    const job = row.job_context as { company?: string; role?: string };
    if (!job.company || !job.role) return reply.status(409).send({ error: 'Application packet is incomplete' });
    const source = await candidateContext(row);
    const validation = validateCoverLetter(parsed.data.body, job.company, job.role, source);
    if (validation.issues.length > 0) return reply.status(422).send({ error: 'Fix the cover letter before saving.', issues: validation.issues });
    return reply.send(await persistCoverLetter(request, row, validation.body, validation.warnings, validation.word_count));
  });
}
