import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';
import pdfParse from 'pdf-parse';
import { db } from '../db/index';
import { profiles, generated_resumes, autofill_events } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { readExperienceBank } from '../db/experienceBank';
import { allowHourly, bumpCounter, getCount, getEntitlements, LIMITS, monthPeriod, quotaExceededPayload, rateLimitedReply } from '../middleware/quota';
import { generateResumeSpec, type ResumeSpec } from '../llm/resumeSpec';
import { renderResumePdf } from '../engine/resumeRender';
import { validateResumeSpec, validatePdfLayout, pruneUngroundedContent } from '../engine/resumeValidate';
import { mintDownloadToken, readDownloadToken, resolveBlobUrl } from '../lib/resumeAccess';
import { apiBaseFor } from '../lib/apiBase';

const MAX_SPEC_ATTEMPTS = 2; // 1 initial pass + 1 feedback-driven retry, per PRD-v2 Section 6.4's
// "automated quality gate" - bounded so a stubborn JD can't loop the endpoint indefinitely.

const bodySchema = z.object({
  company: z.string().min(1),
  role: z.string().min(1),
  jd_text: z.string().min(20),
  // GET /profile/application returns null (not undefined) for unset fields (same shape the PUT
  // endpoint already accepts, per the 2026-07-02 fix) - the extension passes those straight
  // through as this endpoint's contact fields, so this must accept null too.
  contact: z.object({
    full_name: z.string().min(1),
    email: z.string().nullable().optional().transform((v) => v ?? undefined),
    phone: z.string().nullable().optional().transform((v) => v ?? undefined),
    linkedin_url: z.string().nullable().optional().transform((v) => v ?? undefined),
    github_url: z.string().nullable().optional().transform((v) => v ?? undefined),
    portfolio_url: z.string().nullable().optional().transform((v) => v ?? undefined),
  }),
});

export async function resumeRoutes(fastify: FastifyInstance) {
  // POST /resume/generate - tailor a resume to a specific JD from the student's experience bank
  fastify.post('/resume/generate', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err) {
      const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : undefined;
      return reply.status(400).send({ error: 'Invalid request body', detail });
    }

    // Resume-gen + autofill is available on every tier (2026-07-02 decision): free gets
    // 20/month that resets like contacts/drafts (Apollo.io-style recurring credits, not a
    // one-time lifetime trial - keeps free students returning monthly). Pro/trial's
    // monthlyResumes is deliberately huge (see quota.ts) so it's a no-op cap in practice.
    // The monthly quota check (read-only) runs BEFORE the hourly limiter, which increments a
    // counter: a student already over their monthly cap gets a clean 402 without also spending
    // one of their hourly rate-limit slots on the rejected call.
    const ent = await getEntitlements(userId);
    const period = monthPeriod();
    const usedResumes = await getCount(userId, period, 'resumes');
    if (usedResumes >= ent.monthlyResumes) {
      return reply.status(402).send(quotaExceededPayload(ent, usedResumes, 'resumes'));
    }

    if (!(await allowHourly(userId, 'resume', LIMITS.perHour.resume))) {
      return rateLimitedReply(reply);
    }

    // Ordered read, always: see readExperienceBank for why the order is load-bearing (R-022).
    const bank = await readExperienceBank(userId);
    if (bank.length === 0) {
      return reply.status(400).send({ error: 'No experience bank found - complete onboarding first' });
    }

    const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
    const parsed = profileRows[0]?.parsed_json as { school?: string; grad_year?: number; full_name?: string; degree?: string } | undefined;
    // The student's declared skills, the only authoritative source for the SKILLS line (R-015).
    // Filtered rather than cast: this is jsonb, so a hand-edited row can hold anything, and a
    // non-string in here would reach the model as junk and the validator as an unmatchable entry.
    const declaredSkills = (Array.isArray(profileRows[0]?.skills) ? profileRows[0].skills : [])
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

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
          { school: parsed?.school ?? '', degree: parsed?.degree, grad_year: parsed?.grad_year },
          attempt > 1 ? specIssues : undefined,
          declaredSkills,
        );
      } catch (err) {
        fastify.log.error(err);
        // A malformed/truncated model response is as retryable as a validation failure.
        if (spec) break; // a prior attempt already produced a usable spec - accept it best-effort
        if (attempt === MAX_SPEC_ATTEMPTS) {
          return reply.status(500).send({ error: 'Failed to generate resume spec' });
        }
        continue;
      }

      const result = validateResumeSpec(spec, body.jd_text, bank, declaredSkills);
      specIssues = result.issues;
      specWarnings = result.warnings;
      atsCoverage = result.ats_keyword_coverage_pct;

      if (specIssues.length === 0 || attempt === MAX_SPEC_ATTEMPTS) break;
      fastify.log.warn({ specIssues }, 'resume spec failed validation, retrying with feedback');
    }
    if (!spec) {
      return reply.status(500).send({ error: 'Failed to generate resume spec' });
    }

    // Grounding backstop: if the spec STILL cites anything not in the bank after the retry loop,
    // strip the offending content rather than render a fabricated claim (Mehek's hard rule). We
    // never let this empty the resume - if pruning would remove every entry (usually an org-name
    // formatting mismatch, not real fabrication), keep the spec and surface a loud quality issue
    // instead of shipping a blank page.
    let groundingRemoved: string[] = [];
    const pruned = pruneUngroundedContent(spec, bank, declaredSkills);
    if (pruned.removed.length > 0) {
      if (pruned.spec.experience.length === 0 && spec.experience.length > 0) {
        // Every entry failed to match the bank. Usually an org-name formatting mismatch rather than
        // real fabrication, so we ship unpruned rather than a blank resume - but this is exactly the
        // case where fabrication could slip through with only an advisory, so make it loud in logs
        // (not just the user-facing quality note) for monitoring.
        fastify.log.error(
          { userId, company: body.company, removed: pruned.removed },
          'resume grounding pruned ALL experience entries; shipping unpruned - review for fabrication',
        );
        specIssues = [...specIssues, 'grounding: could not verify any experience entry against the bank; shipped unpruned - review before sending'];
        // ...but still take the pruned SKILLS. The reason this branch ships unpruned is that an
        // empty experience list is a blank page, which is worse than an unverified one. That
        // reasoning does not extend to skills: dropping a fabricated skill costs nothing, and
        // letting one ride through on an experience-matching quirk is exactly the R-015 harm.
        spec = { ...spec, skills: pruned.spec.skills };
      } else {
        spec = pruned.spec;
        groundingRemoved = pruned.removed;
      }
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
    const requestedKey = `users/${userId}/resumes/${jdHash}-${Date.now()}.pdf`;

    let resumeUrl: string;
    let objectKey: string;
    try {
      // `access: 'public'` is not a choice - it is the only value @vercel/blob@0.27.3 accepts.
      // What we control is who ever learns the resulting URL, and the answer is nobody: the
      // blob URL is permanent and unauthenticated, so it stays server-side and the client gets
      // a capability link to /resume/download instead. See lib/resumeAccess.ts.
      const blob = await put(requestedKey, pdfBuffer, {
        access: 'public',
        contentType: 'application/pdf',
      });
      // Store the pathname the API actually assigned, NOT the one we asked for. `addRandomSuffix`
      // defaults to TRUE in this SDK (create-folder-*.d.ts documents `@defaultvalue true`, and the
      // header is only sent when the option is set explicitly), so the stored object is really at
      // `<requestedKey minus .pdf>-<random>.pdf`. Writing requestedKey here instead made every
      // later key -> URL lookup miss, which 404'd every download and silently shipped applications
      // with no resume attached. The suffix is left ON deliberately: an unguessable pathname is
      // defence in depth on an object we cannot make private.
      objectKey = blob.pathname;
      resumeUrl = `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(userId, objectKey)}`;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to store generated resume' });
    }

    const jobContext = { company: body.company, role: body.role, jd_hash: jdHash };

    try {
      await db.insert(generated_resumes).values({
        user_id: userId,
        job_context: jobContext,
        spec: { ...spec, _quality: { specIssues, layoutIssues, atsCoverage, trimmedForFit, sparse, groundingRemoved } },
        resume_object_key: objectKey,
      });
    } catch (err) {
      fastify.log.error(err);
      // The file is already generated and returned below; failing to log it for audit
      // shouldn't block the student from getting their resume.
    }

    await bumpCounter(userId, period, 'resumes');

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
        grounding_removed: groundingRemoved,
      },
    });
  });

  // GET /resume/download?t=... - streams a generated resume via its capability token.
  //
  // Deliberately NOT behind requireAuth. The extension fetches resume_url from the content
  // script, which runs in the ATS page's origin and has no access to the auth token (that lives
  // in the background worker's chrome.storage) - it does a bare `fetch(resume_url)`. An
  // Authorization header is therefore impossible here, and the token in `t` is the credential
  // instead. It is opaque, single-purpose, scoped to one object key, and expires (see
  // DOWNLOAD_TOKEN_TTL_MS, which is the one place that number lives),
  // which is what makes handing it to a page origin acceptable when handing over a permanent
  // public blob URL was not.
  fastify.get('/resume/download', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request.query as { t?: string }).t;
    if (!token) return reply.status(400).send({ error: 'Missing download token' });

    // One 403 for every failure mode (tampered, truncated, expired, wrong key). Distinguishing
    // them would turn this into an oracle for probing keys.
    const payload = readDownloadToken(token);
    if (!payload) return reply.status(403).send({ error: 'Invalid or expired download link' });

    let blobUrl: string | null;
    try {
      blobUrl = await resolveBlobUrl(payload.k);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(502).send({ error: 'Could not reach resume storage' });
    }
    // Expected once the retention sweep has been through: the link is still cryptographically
    // valid but the file is intentionally gone. That is a 404, not an error.
    if (!blobUrl) return reply.status(404).send({ error: 'This resume has been deleted' });

    let pdf: Buffer;
    try {
      const upstream = await fetch(blobUrl);
      if (!upstream.ok) throw new Error(`blob fetch ${upstream.status}`);
      pdf = Buffer.from(await upstream.arrayBuffer());
    } catch (err) {
      fastify.log.error(err);
      return reply.status(502).send({ error: 'Could not read resume from storage' });
    }

    return reply
      .status(200)
      .header('Content-Type', 'application/pdf')
      // The whole point is that this URL is short-lived; a shared cache holding the PDF against
      // the token would quietly recreate the unauthenticated-copy problem.
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', 'attachment; filename="resume.pdf"')
      .send(pdf);
  });

  // POST /autofill/event - client-reported fill outcome. auto_submitted is true only when the
  // student had opted in to auto-submit (AutofillSetupScreen toggle, off by default) and their
  // own cancelable countdown ran out without them cancelling it.
  fastify.post('/autofill/event', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    const eventSchema = z.object({
      ats_name: z.string().min(1),
      job_context: z.object({ company: z.string(), role: z.string() }),
      fields_filled: z.number().int().min(0),
      fields_skipped: z.number().int().min(0),
      auto_submitted: z.boolean().optional(),
    });

    let body: z.infer<typeof eventSchema>;
    try {
      body = eventSchema.parse(request.body);
    } catch (err) {
      const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : undefined;
      return reply.status(400).send({ error: 'Invalid request body', detail });
    }

    try {
      await db.insert(autofill_events).values({ user_id: userId, ...body });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to log autofill event' });
    }

    return reply.status(204).send();
  });

  // GET /resume/history - past generated resumes for this student.
  //
  // Each row carries a fresh download link. Until now the history rows held only the object
  // key, so nothing could actually retrieve a past resume; the token makes the list usable and
  // is minted per-request so the links expire with the response rather than being stored.
  // Files older than the retention window are gone, and their link 404s by design.
  fastify.get('/resume/history', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const rows = await db
      .select()
      .from(generated_resumes)
      .where(eq(generated_resumes.user_id, userId))
      .orderBy(desc(generated_resumes.created_at))
      .limit(50);
    const base = apiBaseFor(request);
    const resumes = rows.map((row) => ({
      ...row,
      download_url: `${base}/resume/download?t=${mintDownloadToken(userId, row.resume_object_key)}`,
    }));
    return reply.status(200).send({ resumes });
  });
}
