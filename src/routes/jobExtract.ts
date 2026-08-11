import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { isBrowserbaseConfigured, isManagedStratusProvider, runManagedBrowser } from '../lib/browserbase';

// Bounded so a page with an unusually large DOM (or a hostile one padding its text node) cannot
// blow past resumeGenerateBodySchema's jd_text cap (100_000) once the frontend forwards this
// straight into POST /resume/generate.
export const MAX_JD_TEXT_CHARS = 20_000;

export const jobExtractBodySchema = z.object({
  job_url: z.string().url().max(2000),
});

export function clipJdText(rawText: string | undefined | null): string {
  return (rawText ?? '').trim().slice(0, MAX_JD_TEXT_CHARS);
}

const WORKABLE_APPLICATION_PATH = /^\/((?:[a-z0-9][a-z0-9._-]*\/)?j\/[a-z0-9]+)\/apply\/?$/i;

/**
 * Workable's application route contains form labels, not the job description. Read the exact job
 * overview for extraction while leaving the caller's application URL untouched for submission.
 */
export function jobDescriptionSourceUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  if (url.origin !== 'https://apply.workable.com') return rawUrl;

  const workableApplication = url.pathname.match(WORKABLE_APPLICATION_PATH);
  if (!workableApplication) return rawUrl;

  const [, overviewPath] = workableApplication;
  url.pathname = `/${overviewPath}/`;
  // These values belong to the application form and are not needed to identify its job overview.
  url.search = '';
  url.hash = '';
  return url.toString();
}

export async function jobExtractRoutes(fastify: FastifyInstance) {
  // POST /jobs/extract - given a posting URL, render it in the managed browser (the same
  // provider used for portal submission) and return its visible text as a starting point for the
  // job description field. This exists so "New application" can go from a pasted URL to a
  // reviewable packet without the operator hand-copying text out of a separate tab: the dashboard
  // is the one surface, per the 2026-07-24 product decision to stop treating JD-sourcing as a
  // side-channel step. Genuinely best-effort, confirmed live: server-rendered boards (Greenhouse,
  // SmartRecruiters, plain company career pages) come back clean. At least one heavily
  // client-rendered board (Ashby) returned a correct page title but empty text even after forcing
  // several seconds of render delay before extracting - some SPA renders this run cannot reach
  // (shadow DOM, virtualization, or something else opaque to the managed browser). Callers MUST
  // treat a 502 here as "fall back to the manual paste field," not as a bug to keep chasing.
  fastify.post('/jobs/extract', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof jobExtractBodySchema>;
    try {
      body = jobExtractBodySchema.parse(request.body);
    } catch (err) {
      const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : undefined;
      return reply.status(400).send({ error: 'Invalid request body', detail });
    }

    if (new URL(body.job_url).protocol !== 'https:') {
      return reply.status(400).send({ error: 'Job URL must use HTTPS' });
    }

    if (!(await allowHourly(userId, 'jobExtract', LIMITS.perHour.jobExtract))) {
      return rateLimitedReply(reply);
    }

    if (!isBrowserbaseConfigured() && !isManagedStratusProvider()) {
      return reply.status(503).send({
        error: 'Job description extraction is not configured on this deployment.',
        code: 'PORTAL_RUNNER_NOT_CONFIGURED',
      });
    }

    const extractionUrl = jobDescriptionSourceUrl(body.job_url);
    let result: Awaited<ReturnType<typeof runManagedBrowser>>;
    try {
      // The Stratus run validates every action and requires a non-empty selector, even for
      // 'extract' - 'body' pulls the whole rendered page's visible text, matching what
      // ManagedBrowserResult.text already carries for the fill actions elsewhere in this codebase.
      // runManagedBrowser's fixed run config waits only for 'domcontentloaded', which fires before
      // client-rendered ATS boards (Ashby, Workday, Google Careers) have painted the JD. Live
      // testing this session showed waiting on a real heading selector is not reliable timing: a
      // client-rendered Ashby posting came back with the correct <title> (set early by the SPA)
      // but zero extracted text, so document.title updating is not proof the body has painted.
      // A selector that can never match forces waitForSelector to burn its FULL timeout before
      // 'optional' lets the run continue - a deterministic render-delay that does not depend on
      // guessing any site's heading markup.
      result = await runManagedBrowser(extractionUrl, [
        { type: 'waitForSelector', selector: '.litos-jd-extract-render-delay-noop', timeout: 5000, optional: true },
        { type: 'extract', selector: 'body' },
      ]);
    } catch (err) {
      fastify.log.error({ err, userId, job_url: body.job_url }, 'job description extraction failed');
      return reply.status(502).send({
        error: 'Could not read that posting. Paste the job description manually instead.',
        code: 'job_extract_failed',
      });
    }

    fastify.log.info(
      {
        userId,
        job_url: body.job_url,
        extraction_url: extractionUrl,
        title: result.title,
        url: result.url,
        textLen: result.text?.length ?? 0,
        blockers: result.blockers,
      },
      'job description extraction result',
    );
    const jdText = clipJdText(result.text);
    if (!jdText) {
      return reply.status(502).send({
        error: 'That page returned no readable text. Paste the job description manually instead.',
        code: 'job_extract_empty',
      });
    }

    return reply.status(200).send({ jd_text: jdText, page_title: result.title || undefined });
  });
}
