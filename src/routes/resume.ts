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

// Hard wall-clock ceiling for the whole request, measured from function entry (reqStart) so it
// accounts for the pre-loop work (auth, quota, bank/profile reads) too. Vercel kills the function at
// 60s; every model call is bounded to (deadline - post-gen reserve - elapsed), so a slow Anthropic
// response fails fast instead of 504ing AND there is guaranteed room after the last spec for the PDF
// render + parse + blob upload + audit inserts.
const REQUEST_DEADLINE_MS = 55000;
const POST_GEN_RESERVE_MS = 9000;

// ─── Transient model-capacity handling (live QA 2026-07-16) ──────────────────
// A real Anthropic `overloaded_error` incident killed a whole fill: the card showed "Failed to
// generate resume spec" and the only recovery was the student re-clicking "Yes, fill it". Two
// separate defects produced that, and they need two separate fixes.
//
// 1. IN-REQUEST WASTE. A 529 fails FAST (~1s), not slow. So an overload burned both
//    MAX_SPEC_ATTEMPTS in ~10s and gave up with ~45s of function budget still unspent. Worse, the
//    single attempt counter conflated two unrelated reasons to retry - a transient CAPACITY failure
//    and a QUALITY feedback pass - so one 529 silently consumed the feedback retry that exists to
//    raise ATS coverage. Fixed here: capacity retries get their own counter and backoff, and only a
//    real (non-transient) error or an exhausted budget ends the attempt.
//
// 2. THE CEILING. In-request retry CANNOT be the whole fix, and it is important not to pretend it
//    is. Vercel kills this function at 60s (vercel.json maxDuration), REQUEST_DEADLINE_MS is 55s,
//    and the observed incident needed ~6 attempts over ~2.5 MINUTES to get a 200. No in-request
//    retry can outlive a 60s function, so surviving an incident of that length is necessarily the
//    CLIENT's job: only a fresh request escapes the ceiling. That is why exhausting these retries
//    returns a 503 + `code: 'llm_overloaded'` + `retry_after_ms` rather than a generic 500 - it is
//    a machine-readable "come back", and the extension retries on it across requests while showing
//    a "capacity busy" state. A 500 is indistinguishable from a bad JD, so the client could only
//    give up. Large prompts are shed first during an overload and this route sends the JD plus the
//    whole experience bank, so it is most fragile exactly when capacity is tight.
const MAX_OVERLOAD_ATTEMPTS = 4;
const MIN_CALL_BUDGET_MS = 6000; // never start a model call with less than this left
const MAX_BACKOFF_MS = 6000;

// Anthropic returns 529 overloaded_error during a capacity incident and 429 when rate limited; the
// SDK surfaces both as APIError with a numeric `status`. Connection resets carry no status, so match
// those on the message. Deliberately NOT retried: 4xx other than 429 (a bad request stays bad), and
// APIUserAbortError (status undefined, message names an abort) - that is OUR deadline firing, and
// retrying it would just burn the budget we already ran out of.
export function isTransientOverload(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  if (!(err instanceof Error)) return false;
  if (/abort/i.test(err.name) || /abort/i.test(err.message)) return false;
  // Our own parse/truncation errors (resumeSpec.ts) embed up to 200 chars of MODEL OUTPUT in the
  // message. A JD or resume about networking puts the word "network" in that snippet, which would
  // satisfy the connection regex below and misclassify a deterministic parse failure as a transient
  // capacity blip - the client would then retry a request that fails identically every time. Name
  // those errors explicitly before any substring matching.
  if (/^(Claude returned invalid JSON|Resume spec truncated)/.test(err.message)) return false;
  return /connection|econnreset|socket|network|fetch failed/i.test(err.message);
}

// Honor Retry-After when the API sends one, else exponential backoff with jitter. Jitter matters:
// every RoleQuick client retrying a shared incident on the same schedule would synchronize into a
// thundering herd against an API that is already shedding load.
export function overloadBackoffMs(err: unknown, attempt: number): number {
  const headers = (err as { headers?: { get?: (k: string) => string | null } })?.headers;
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  const seconds = raw === null || raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const expo = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return expo + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
    const reqStart = Date.now(); // wall-clock anchor for the whole-request time budget (see budgetLeftMs)
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

    const budgetLeftMs = () => REQUEST_DEADLINE_MS - POST_GEN_RESERVE_MS - (Date.now() - reqStart);

    for (let attempt = 1; attempt <= MAX_SPEC_ATTEMPTS; attempt++) {
      if (budgetLeftMs() < MIN_CALL_BUDGET_MS) {
        // Not enough of the function budget left for another full model call plus the reserved
        // render/upload time within Vercel's 60s.
        if (spec) break; // ship the best-effort spec from a prior attempt
        return reply.status(503).send({ error: 'Resume generation is taking too long. Please try again.' });
      }
      try {
        // Capacity retries run HERE, on their own counter, rather than consuming an outer
        // MAX_SPEC_ATTEMPTS slot: an `overloaded_error` says nothing about spec quality, so
        // spending the feedback pass on one meant a transient 529 could quietly cost the student
        // ATS coverage on a resume that did eventually generate.
        spec = await (async () => {
          let lastErr: unknown;
          for (let tries = 1; tries <= MAX_OVERLOAD_ATTEMPTS; tries++) {
            const budget = budgetLeftMs();
            if (budget < MIN_CALL_BUDGET_MS) break;
            try {
              return await generateResumeSpec(
                body.jd_text,
                body.company,
                body.role,
                bank,
                { school: parsed?.school ?? '', degree: parsed?.degree, grad_year: parsed?.grad_year },
                attempt > 1 ? specIssues : undefined,
                declaredSkills,
                budget,
              );
            } catch (err) {
              lastErr = err;
              if (!isTransientOverload(err)) throw err;
              const waitMs = overloadBackoffMs(err, tries);
              // Only sleep if a real attempt could still follow it; otherwise fall out now and let
              // the 503 go back while the client still has time to act on it.
              if (budgetLeftMs() - waitMs < MIN_CALL_BUDGET_MS) break;
              fastify.log.warn(
                { tries, waitMs, budgetLeftMs: budgetLeftMs(), status: (err as { status?: number })?.status },
                'model capacity overloaded, backing off and retrying in-request',
              );
              await sleep(waitMs);
            }
          }
          throw lastErr ?? new Error('resume spec generation exhausted its budget');
        })();
      } catch (err) {
        fastify.log.error(err);
        if (spec) break; // a prior attempt already produced a usable spec - accept it best-effort
        // A transient capacity failure is a "come back", not a failure to report. Say so in a way
        // the client can act on: a 500 here is indistinguishable from a bad JD, so the extension
        // could only surface a hard "Failed to generate resume spec" and strand the fill. This is
        // the half of the fix that survives an incident longer than the 60s function ceiling, since
        // only a fresh request can outlive it.
        if (isTransientOverload(err)) {
          return reply.status(503).send({
            error: 'The model is busy right now. RoleQuick will retry automatically.',
            code: 'llm_overloaded',
            retry_after_ms: 5000,
          });
        }
        // A malformed/truncated model response is as retryable as a validation failure - but not if
        // we're out of budget.
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
