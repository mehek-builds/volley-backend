import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';
import { db } from '../db/index';
import { experience_bank, profiles, generated_resumes, autofill_events } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { generateResumeSpec } from '../llm/resumeSpec';
import { renderResumeDocx } from '../engine/resumeRender';

const bodySchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  jd_text: z.string().min(20),
  contact: z.object({
    full_name: z.string().min(1),
    email: z.string().optional(),
    phone: z.string().optional(),
    linkedin_url: z.string().optional(),
    github_url: z.string().optional(),
    portfolio_url: z.string().optional(),
  }),
});

export async function resumeRoutes(fastify: FastifyInstance) {
  // POST /resume/generate - tailor a resume to a specific JD from the student's experience bank
  fastify.post('/resume/generate', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    if (!(await allowHourly(userId, 'resume', LIMITS.perHour.resume))) {
      return rateLimitedReply(reply);
    }

    const bank = await db.select().from(experience_bank).where(eq(experience_bank.user_id, userId));
    if (bank.length === 0) {
      return reply.status(400).send({ error: 'No experience bank found - complete onboarding first' });
    }

    const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
    const parsed = profileRows[0]?.parsed_json as { school?: string; grad_year?: number; full_name?: string } | undefined;

    let spec;
    try {
      spec = await generateResumeSpec(body.jd_text, body.company, body.role, bank, {
        school: parsed?.school ?? '',
        grad_year: parsed?.grad_year,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to generate resume spec' });
    }

    let docxBuffer: Buffer;
    try {
      docxBuffer = await renderResumeDocx(spec, body.contact);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to render resume document' });
    }

    const jdHash = createHash('sha256').update(body.jd_text).digest('hex').slice(0, 16);
    const objectKey = `users/${userId}/resumes/${jdHash}-${Date.now()}.docx`;

    let resumeUrl: string;
    try {
      const blob = await put(objectKey, docxBuffer, {
        access: 'public',
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      resumeUrl = blob.url;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to store generated resume' });
    }

    const jobContext = { company: body.company, role: body.role, jd_hash: jdHash };

    try {
      await db.insert(generated_resumes).values({
        user_id: userId,
        job_context: jobContext,
        spec,
        resume_object_key: objectKey,
      });
    } catch (err) {
      fastify.log.error(err);
      // The file is already generated and returned below; failing to log it for audit
      // shouldn't block the student from getting their resume.
    }

    return reply.status(200).send({
      resume_url: resumeUrl,
      file_name: `${body.contact.full_name.replace(/\s+/g, '_')}_${body.company.replace(/\s+/g, '_')}_Resume.docx`,
      spec,
    });
  });

  // POST /autofill/event - client-reported fill outcome (fields_filled/skipped only; Volley
  // never observes or reports whether Submit was clicked, since it never touches that button).
  fastify.post('/autofill/event', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const eventSchema = z.object({
      ats_name: z.string().min(1),
      job_context: z.object({ company: z.string(), role: z.string() }),
      fields_filled: z.number().int().min(0),
      fields_skipped: z.number().int().min(0),
    });

    let body: z.infer<typeof eventSchema>;
    try {
      body = eventSchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    try {
      await db.insert(autofill_events).values({ user_id: userId, ...body });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to log autofill event' });
    }

    return reply.status(204).send();
  });

  // GET /resume/history - past generated resumes for this student
  fastify.get('/resume/history', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const rows = await db
      .select()
      .from(generated_resumes)
      .where(eq(generated_resumes.user_id, userId))
      .orderBy(desc(generated_resumes.created_at))
      .limit(50);
    return reply.status(200).send({ resumes: rows });
  });
}
