import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';
import pdfParse from 'pdf-parse';
import { db } from '../db/index';
import { experience_bank, profiles, generated_resumes, autofill_events } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import {
  allowHourly,
  bumpCounter,
  getCount,
  getEntitlements,
  FREE_LIFETIME_RESUME_LIMIT,
  LIFETIME_PERIOD,
  LIMITS,
  monthPeriod,
  quotaExceededPayload,
  rateLimitedReply,
} from '../middleware/quota';
import { generateResumeSpec, type ResumeSpec } from '../llm/resumeSpec';
import { renderResumePdf } from '../engine/resumeRender';
import { validateResumeSpec, validatePdfLayout } from '../engine/resumeValidate';

const MAX_SPEC_ATTEMPTS = 2; // 1 initial pass + 1 feedback-driven retry, per PRD-v2 Section 6.4's
// "automated quality gate" - bounded so a stubborn JD can't loop the endpoint indefinitely.

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

    // Resume-gen + autofill is available on every tier (2026-07-02 decision), but free
    // gets a LIFETIME cap rather than a monthly one - crossing it is what moves a student
    // onto the $399/mo tier, so the counter period differs by tier rather than the quota
    // existing at all. Pro/trial's monthlyResumes is deliberately huge (see quota.ts).
    const ent = await getEntitlements(userId);
    const resumeQuotaPeriod = ent.tier === 'free' ? LIFETIME_PERIOD : monthPeriod();
    const resumeQuotaLimit = ent.tier === 'free' ? FREE_LIFETIME_RESUME_LIMIT : ent.monthlyResumes;
    const usedResumes = await getCount(userId, resumeQuotaPeriod, 'resumes');
    if (usedResumes >= resumeQuotaLimit) {
      return reply.status(402).send(quotaExceededPayload(ent, usedResumes, 'resumes', resumeQuotaLimit));
    }

    const bank = await db.select().from(experience_bank).where(eq(experience_bank.user_id, userId));
    if (bank.length === 0) {
      return reply.status(400).send({ error: 'No experience bank found - complete onboarding first' });
    }

    const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
    const parsed = profileRows[0]?.parsed_json as { school?: string; grad_year?: number; full_name?: string } | undefined;

    // Generate -> validate -> (if issues) regenerate once with the issues as feedback -> validate
    // again and accept best-effort. Same two-layer pattern as the Dubai engine: the prompt states
    // the rules (resumeSpec.ts's SYSTEM_PROMPT), the validator (resumeValidate.ts) checks them,
    // and only genuine drift triggers a second Claude call instead of trusting the prompt alone.
    let spec: ResumeSpec | undefined;
    let specIssues: string[] = [];
    let specWarnings: ReturnType<typeof validateResumeSpec>['warnings'] = [];
    let atsCoverage = 0;

    for (let attempt = 1; attempt <= MAX_SPEC_ATTEMPTS; attempt++) {
      try {
        spec = await generateResumeSpec(
          body.jd_text,
          body.company,
          body.role,
          bank,
          { school: parsed?.school ?? '', grad_year: parsed?.grad_year },
          attempt > 1 ? specIssues : undefined,
        );
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: 'Failed to generate resume spec' });
      }

      const result = validateResumeSpec(spec, body.jd_text);
      specIssues = result.issues;
      specWarnings = result.warnings;
      atsCoverage = result.ats_keyword_coverage_pct;

      if (specIssues.length === 0 || attempt === MAX_SPEC_ATTEMPTS) break;
      fastify.log.warn({ specIssues }, 'resume spec failed validation, retrying with feedback');
    }
    if (!spec) {
      return reply.status(500).send({ error: 'Failed to generate resume spec' });
    }

    let pdfBuffer: Buffer;
    let trimmedForFit: boolean;
    let sparse: boolean;
    try {
      const rendered = await renderResumePdf(spec, body.contact);
      pdfBuffer = rendered.buffer;
      trimmedForFit = rendered.trimmed;
      sparse = rendered.sparse;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to render resume PDF' });
    }

    // Authoritative post-render check (mirrors validate_resume.py's PDF section): confirms the
    // pre-render height estimate actually held, and that the text is really extractable.
    let layoutIssues: string[] = [];
    try {
      const parsedPdf = await pdfParse(pdfBuffer);
      layoutIssues = validatePdfLayout(parsedPdf.text, parsedPdf.numpages).issues;
    } catch (err) {
      fastify.log.warn(err, 'could not post-render-validate the generated PDF');
    }

    const jdHash = createHash('sha256').update(body.jd_text).digest('hex').slice(0, 16);
    const objectKey = `users/${userId}/resumes/${jdHash}-${Date.now()}.pdf`;

    let resumeUrl: string;
    try {
      const blob = await put(objectKey, pdfBuffer, {
        access: 'public',
        contentType: 'application/pdf',
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
        spec: { ...spec, _quality: { specIssues, layoutIssues, atsCoverage, trimmedForFit, sparse } },
        resume_object_key: objectKey,
      });
    } catch (err) {
      fastify.log.error(err);
      // The file is already generated and returned below; failing to log it for audit
      // shouldn't block the student from getting their resume.
    }

    await bumpCounter(userId, resumeQuotaPeriod, 'resumes');

    return reply.status(200).send({
      resume_url: resumeUrl,
      file_name: `${body.contact.full_name.replace(/\s+/g, '_')}_${body.company.replace(/\s+/g, '_')}_Resume.pdf`,
      spec,
      quality: {
        issues: [...specIssues, ...layoutIssues],
        warnings: specWarnings,
        ats_keyword_coverage_pct: atsCoverage,
        trimmed_for_one_page_fit: trimmedForFit,
        sparse_add_more_experience: sparse,
      },
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
