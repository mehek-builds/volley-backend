import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, desc } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { put } from '@vercel/blob';
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
import { extractPdfText } from '../lib/pdfText';
import { applyResumePolicy, type CandidateEducation } from '../engine/resumePolicy';

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

// The OTHER permanent failure class R-012 exposed, distinct from both a transient overload and a
// genuinely bad request. Anthropic surfaces credit exhaustion as a 400 invalid_request_error
// whose message says so ("Your credit balance is too low to access the Anthropic API. Please go
// to Plans & Billing to upgrade or purchase credits."), and a revoked/wrong key as a 401 or 403.
// None of these are the student's fault and none are transient: retrying cannot refill a balance,
// and the generic "Failed to generate resume spec" card made a product-down incident look like a
// flaky JD for hours (live, 2026-07-17) - the student's only move was clicking "Yes, fill it"
// forever. Message-matching the 400 is deliberate and narrow: a 400 WITHOUT billing language is a
// malformed request from OUR code and must stay a plain 500, never be blamed on billing.
export function isBillingOrAuthFailure(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status === 401 || status === 403) return true;
  if (status !== 400) return false;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? '');
  return /credit balance|billing|purchase credits/i.test(message);
}

// One log line + one payload for every route that calls the model, so the operator action is
// named identically wherever the failure surfaces. 503 + code llm_billing mirrors the
// llm_overloaded plumbing shape, but deliberately carries NO retry_after_ms: the client must not
// hammer a dead account, and the distinct code is how it knows this one is permanent until an
// owner acts.
export const LLM_BILLING_LOG =
  'ANTHROPIC BILLING/AUTH FAILURE: every model-backed feature is DOWN for every user until the owner acts. Fix: top up credits in the Anthropic console, or rotate/restore ANTHROPIC_API_KEY (R-012)';
export const LLM_BILLING_PAYLOAD = {
  error: 'Drafting is temporarily unavailable. This is a problem on our side, not something you did, and retrying will not fix it. The Litos team needs to restore service.',
  code: 'llm_billing',
} as const;

// Honor Retry-After when the API sends one, else exponential backoff with jitter. Jitter matters:
// every Litos client retrying a shared incident on the same schedule would synchronize into a
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

// POST /autofill/event's body. Strip-mode on purpose (zod's default): unknown keys from newer
// extension builds are dropped rather than rejected, so the two sides can version independently.
// The flip side is that a field the extension sends but this schema does not name is dropped
// SILENTLY, which is how the R-030 telemetry almost vanished: the extension branch
// fix/r027-tags-r030-log ships r030_candidate_labels (the labels where linkQuestion matched with
// asksForLink false on a text input - the population the register says to sample live before
// designing any fix) and without the field here every sample would have been stripped on arrival.
// Not R-030-only anymore: the extension branch fix/r039-location-commitment-veto reuses the same
// channel for its telemetry, riding tag-prefixed entries "r039-veto:<label>" and
// "r039-third-party:<label>" alongside the plain R-030 label strings, so a consumer of this
// column must filter by prefix rather than assume every row is an R-030 sample.
// Bounds are telemetry-sized: 50 labels of 200 chars covers any real form and caps what a
// misbehaving client can store per event. Optional: older extensions and label-less fills omit it.
export const autofillEventSchema = z.object({
  ats_name: z.string().min(1),
  job_context: z.object({ company: z.string(), role: z.string() }),
  fields_filled: z.number().int().min(0),
  fields_skipped: z.number().int().min(0),
  auto_submitted: z.boolean().optional(),
  r030_candidate_labels: z.array(z.string().max(200)).max(50).optional(),
});

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
    const parsed = profileRows[0]?.parsed_json as {
      school?: string;
      degree?: string;
      grad_date?: string;
      grad_year?: number;
      currently_enrolled?: boolean;
      coursework?: string[];
      full_name?: string;
    } | undefined;
    const education: CandidateEducation = {
      school: parsed?.school ?? '',
      degree: parsed?.degree,
      grad_date: parsed?.grad_date || (parsed?.grad_year ? String(parsed.grad_year) : undefined),
      grad_year: parsed?.grad_year,
      currently_enrolled: parsed?.currently_enrolled,
      coursework: Array.isArray(parsed?.coursework)
        ? parsed.coursework.filter((course): course is string => typeof course === 'string')
        : [],
    };
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
        if (spec) break; // keep the prior spec and run it through the final deterministic gate
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
              const generated = await generateResumeSpec(
                body.jd_text,
                body.company,
                body.role,
                bank,
                education,
                attempt > 1 ? specIssues : undefined,
                declaredSkills,
                budget,
              );
              return applyResumePolicy(generated, education, bank, body.jd_text).spec;
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
        if (spec) break; // a prior spec still has to pass pruning and final validation below
        // Billing/auth first: it is PERMANENT, so neither the transient 503 (which invites a
        // retry) nor the generic 500 (which reads as a bad JD) is honest about it. Distinct code,
        // not-your-fault message, and a log that names the operator action (R-012).
        if (isBillingOrAuthFailure(err)) {
          fastify.log.error({ status: (err as { status?: number })?.status, userId }, LLM_BILLING_LOG);
          return reply.status(503).send(LLM_BILLING_PAYLOAD);
        }
        // A transient capacity failure is a "come back", not a failure to report. Say so in a way
        // the client can act on: a 500 here is indistinguishable from a bad JD, so the extension
        // could only surface a hard "Failed to generate resume spec" and strand the fill. This is
        // the half of the fix that survives an incident longer than the 60s function ceiling, since
        // only a fresh request can outlive it.
        if (isTransientOverload(err)) {
          return reply.status(503).send({
            error: 'The model is busy right now. Litos will retry automatically.',
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

      const result = validateResumeSpec(spec, body.jd_text, bank, declaredSkills, education);
      specIssues = result.issues;
      specWarnings = result.warnings;
      atsCoverage = result.ats_keyword_coverage_pct;

      if (specIssues.length === 0 || attempt === MAX_SPEC_ATTEMPTS) break;
      fastify.log.warn({ specIssues }, 'resume spec failed validation, retrying with feedback');
    }
    if (!spec) {
      return reply.status(500).send({ error: 'Failed to generate resume spec' });
    }

    // Grounding backstop: if the spec still cites anything not in the bank after the retry loop,
    // strip the offending content rather than render a fabricated claim. If that would remove
    // every entry, hold the resume for review instead of attaching either a blank or unverified file.
    let groundingRemoved: string[] = [];
    const pruned = pruneUngroundedContent(spec, bank, declaredSkills);
    if (pruned.removed.length > 0) {
      if (pruned.spec.experience.length === 0 && spec.experience.length > 0) {
        // Every entry failed to match the bank. This may be an organization-name mismatch, but the
        // system cannot safely distinguish that from fabrication at this point.
        fastify.log.error(
          { userId, company: body.company, removed: pruned.removed },
          'resume grounding could not verify any experience entry; holding attachment',
        );
        return reply.status(422).send({
          error: 'Litos could not verify this resume against the uploaded experience, so it was not attached.',
          code: 'resume_quality_hold',
          quality: {
            ready_to_attach: false,
            issues: ['grounding: could not verify any experience entry against the bank'],
            warnings: specWarnings,
            omissions: pruned.removed,
          },
        });
      } else {
        spec = pruned.spec;
        groundingRemoved = pruned.removed;
      }
    }

    let pdfBuffer: Buffer;
    let trimmedForFit: boolean;
    let sparse: boolean;
    let layoutOmissions: string[];
    try {
      const rendered = await renderResumePdf(spec, body.contact, body.jd_text);
      pdfBuffer = rendered.buffer;
      spec = rendered.spec;
      trimmedForFit = rendered.trimmed;
      sparse = rendered.sparse;
      layoutOmissions = rendered.omissions;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to render resume PDF' });
    }

    // Authoritative post-render check (mirrors validate_resume.py's PDF section): confirms the
    // pre-render height estimate actually held, and that the text is really extractable.
    // extractPdfText, not bare pdfParse: the raw call threw "bad XRef entry" on every ~2.5KB
    // pooled render buffer (R-017; the byteOffset story lives in lib/pdfText.ts), so this check
    // had NEVER run and its empty issues array read downstream as a clean pass.
    const finalSpecValidation = validateResumeSpec(spec, body.jd_text, bank, declaredSkills, education);
    specWarnings = finalSpecValidation.warnings;
    atsCoverage = finalSpecValidation.ats_keyword_coverage_pct;
    if (finalSpecValidation.issues.length > 0) {
      fastify.log.error(
        { userId, company: body.company, issues: finalSpecValidation.issues },
        'resume blocked after final content validation',
      );
      return reply.status(422).send({
        error: 'This resume needs review before Litos can attach it.',
        code: 'resume_quality_hold',
        quality: {
          ready_to_attach: false,
          issues: finalSpecValidation.issues,
          warnings: specWarnings,
          omissions: layoutOmissions,
        },
      });
    }

    let layoutIssues: string[] = [];
    try {
      const parsedPdf = await extractPdfText(pdfBuffer);
      layoutIssues = validatePdfLayout(parsedPdf.text, parsedPdf.numpages).issues;
    } catch (err) {
      // LOUD on purpose, and still non-fatal to the response. A validation step that fails
      // silently is worse than none: layoutIssues stays [] below, which downstream reads as
      // "validated, no issues". If this fires, the one-page/extractability guarantees are
      // UNVERIFIED for the resume being returned - the student still gets their file, but this
      // resume shipped unchecked and the parser needs fixing again (R-017's failure mode).
      fastify.log.error(
        { err, userId, company: body.company },
        'POST-RENDER PDF VALIDATION DID NOT RUN: rendered resume could not be parsed, so its quality.issues are INCOMPLETE and the one-page/extractability guarantees are unverified (R-017)',
      );
      return reply.status(500).send({
        error: 'Litos could not verify the generated PDF, so it was not attached.',
        code: 'resume_quality_hold',
      });
    }

    if (layoutIssues.length > 0) {
      fastify.log.error({ userId, company: body.company, layoutIssues }, 'resume blocked after PDF validation');
      return reply.status(422).send({
        error: 'This resume did not pass the one-page PDF check, so it was not attached.',
        code: 'resume_quality_hold',
        quality: { ready_to_attach: false, issues: layoutIssues, warnings: specWarnings, omissions: layoutOmissions },
      });
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
      // R-040: carry put()'s own URL inside the sealed token. The download route's key -> URL
      // lookup rides list(), which is eventually consistent with no bound - a fresh resume can
      // 404 as "deleted" for the whole window a student is submitting in. put()'s URL is a
      // strong read target and it is in hand right here.
      resumeUrl = `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(userId, objectKey, { blobUrl: blob.url })}`;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to store generated resume' });
    }

    const jobContext = { company: body.company, role: body.role, jd_hash: jdHash };

    try {
      await db.insert(generated_resumes).values({
        user_id: userId,
        job_context: jobContext,
        spec: { ...spec, _quality: { specIssues: [], layoutIssues, atsCoverage, trimmedForFit, sparse, groundingRemoved, layoutOmissions } },
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
        ready_to_attach: true,
        issues: [],
        warnings: specWarnings,
        ats_keyword_coverage_pct: atsCoverage,
        trimmed_for_one_page_fit: trimmedForFit,
        sparse_add_more_experience: sparse,
        grounding_removed: groundingRemoved,
        omissions: layoutOmissions,
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

    // R-040: tokens minted since the fix carry the blob URL itself (payload.b) - a strong
    // point-read with no list() consistency dependence. Tokens from before the fix (<= 5 min
    // old at any moment) fall back to the list()-based key lookup they were minted against.
    let blobUrl: string | null;
    if (payload.b) {
      blobUrl = payload.b;
    } else {
      try {
        blobUrl = await resolveBlobUrl(payload.k);
      } catch (err) {
        fastify.log.error(err);
        return reply.status(502).send({ error: 'Could not reach resume storage' });
      }
    }
    // Expected once the retention sweep has been through: the link is still cryptographically
    // valid but the file is intentionally gone. That is a 404, not an error.
    if (!blobUrl) return reply.status(404).send({ error: 'This resume has been deleted' });

    let pdf: Buffer;
    try {
      const upstream = await fetch(blobUrl);
      // A sweep-deleted blob answers 404 at the store; keep the same contract the resolve path
      // has always had rather than turning "intentionally gone" into a 502.
      if (upstream.status === 404 || upstream.status === 410) {
        return reply.status(404).send({ error: 'This resume has been deleted' });
      }
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

    let body: z.infer<typeof autofillEventSchema>;
    try {
      body = autofillEventSchema.parse(request.body);
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
