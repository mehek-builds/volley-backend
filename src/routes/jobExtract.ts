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

export async function jobExtractRoutes(fastify: FastifyInstance) {
  // POST /jobs/extract - given a posting URL, render it in the managed browser (the same
  // provider used for portal submission) and return its visible text as a starting point for the
  // job description field. This exists so "New application" can go from a pasted URL to a
  // reviewable packet without the operator hand-copying text out of a separate tab: the dashboard
  // is the one surface, per the 2026-07-24 product decision to stop treating JD-sourcing as a
  // side-channel step. Best-effort only - a paywalled, bot-gated, or JS-hostile posting can still
  // come back empty or wrong, so the caller must let the student review/edit before generating.
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

    let result: Awaited<ReturnType<typeof runManagedBrowser>>;
    try {
      // The Stratus run validates every action and requires a non-empty selector, even for
      // 'extract' - 'body' pulls the whole rendered page's visible text, matching what
      // ManagedBrowserResult.text already carries for the fill actions elsewhere in this codebase.
      // runManagedBrowser's fixed run config waits only for 'domcontentloaded', which fires before
      // client-rendered ATS boards (Ashby, Workday, Google Careers) have painted the JD - a bare
      // extract right after came back empty on those live in this session. A leading, optional
      // waitForSelector on 'h1' gives client-side rendering a real chance to finish first: job
      // postings render a heading early, and 'optional' means a page without one (or one that
      // times out) still falls through to the extract instead of aborting the whole run.
      result = await runManagedBrowser(body.job_url, [
        { type: 'waitForSelector', selector: 'h1', timeout: 8000, optional: true },
        { type: 'extract', selector: 'body' },
      ]);
    } catch (err) {
      fastify.log.error({ err, userId, job_url: body.job_url }, 'job description extraction failed');
      return reply.status(502).send({
        error: 'Could not read that posting. Paste the job description manually instead.',
        code: 'job_extract_failed',
      });
    }

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
