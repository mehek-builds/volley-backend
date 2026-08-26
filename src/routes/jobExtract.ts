import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { isBrowserbaseConfigured, isManagedStratusProvider, runManagedBrowser } from '../lib/browserbase';
import { leadRequirementCandidates } from '../engine/leadAlignment';

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
const LEVER_APPLICATION_PATH = /^\/([^/]+)\/([^/]+)\/apply\/?$/i;
const LEVER_HOSTS = new Set(['jobs.lever.co', 'jobs.eu.lever.co']);

/**
 * An application route contains form labels, not the job description. Read the exact job overview
 * for extraction while leaving the caller's application URL untouched for submission.
 *
 * PER ATS, NEVER A BLANKET RULE. It is tempting to strip a trailing `/apply` from anything, and it
 * is wrong: a path segment means whatever the board says it means, and a rewrite that guesses would
 * silently extract the wrong page rather than fail. Each board gets its own shape, and a URL that
 * matches none is returned untouched so the guard below can still refuse what comes back.
 *
 * LEVER was added 2026-08-27 on live evidence. A Belvedere Trading packet stored
 * `jobs.lever.co/{org}/{id}/apply` as its portal_url and froze 20,000 characters of that form as
 * its job description, of which a `Name of School` select holding roughly three thousand university
 * names consumed the entire cap. It scored 1 of 12 with a gap list of `Japanese Red`, `Red Cross`,
 * `Nursing`, `British Columbia`, `LinkedIn URL` and `Loading`, every one a dropdown option or a
 * form label. Lever's overview is the same path without the trailing `/apply`.
 *
 * This matters beyond new extractions: a repair that re-extracts a broken row from its STORED
 * portal_url gets the form again on any row whose stored URL is the apply route, so without this
 * the row cannot be repaired from the data it already has.
 */
export function jobDescriptionSourceUrl(rawUrl: string): string {
  const url = new URL(rawUrl);

  if (url.origin === 'https://apply.workable.com') {
    const workableApplication = url.pathname.match(WORKABLE_APPLICATION_PATH);
    if (!workableApplication) return rawUrl;

    const [, overviewPath] = workableApplication;
    url.pathname = `/${overviewPath}/`;
    // These values belong to the application form and are not needed to identify its job overview.
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  if (url.protocol === 'https:' && LEVER_HOSTS.has(url.host)) {
    const leverApplication = url.pathname.match(LEVER_APPLICATION_PATH);
    if (!leverApplication) return rawUrl;

    const [, org, postingId] = leverApplication;
    url.pathname = `/${org}/${postingId}`;
    /* Dropped for the same reason as Workable's: `lever-source` and friends are application-form
       and tracking state, not part of what identifies the posting. Safe because this helper feeds
       extraction ONLY - the submission path uses the caller's original URL untouched. */
    url.search = '';
    url.hash = '';
    return url.toString();
  }

  return rawUrl;
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

    /* NON-EMPTY WAS NEVER THE RIGHT BAR, and this route already knew it for one board: the Workable
     * rewrite above exists because "Workable's application route contains form labels, not the job
     * description". The rewrite only knows one board, and `extract: 'body'` reaches the same shape
     * by several routes: a company-hosted embed (Jane Street, below) and, confirmed on a second
     * account the same night, a plain Lever apply route. Do not read this as a company-hosted-board
     * problem. What the shapes share is that the URL was an APPLICATION page, and on those the body
     * is a consent banner, site nav, the FORM, and a footer, with the description nowhere in it.
     *
     * Observed live 2026-08-26 on packet 496cff97, a Jane Street Software Engineer Internship:
     * 3,696 characters and 78 lines, of which the posting contributed a title and a location. The
     * rest was the banner, the top nav, `* Required fields`, `Legal first name`, `Email
     * confirmation`, the pronoun list, `How did you hear about us?`, `Select an option`, and the
     * legal footer. It passed the non-empty check, was frozen into the packet, and the review
     * screen scored it 0 of 5 with "Not much overlap" beside it, which reads as "your resume is a
     * poor match" when the truth is "we never read the posting".
     *
     * WHAT IS ASKED HERE IS THE QUESTION THE REST OF THE SYSTEM ALREADY ASKS. leadAlignment refuses
     * to cite a lead requirement when the frozen description "contains no supported primary ask",
     * and calls that unscoreable job fit rather than a defect. Downstream already recognises this
     * page as not-a-description; extraction simply never checked, so the packet got built anyway.
     * Reusing that exact predicate is deliberate: a second private heuristic here would drift from
     * the one that decides what a requirement is everywhere else.
     *
     * A POSTING THAT CARRIES ITS FORM INLINE IS NOT AFFECTED, which is the case that matters most
     * because most Greenhouse pages are exactly that. The test is whether any ask survives, not
     * whether form labels are present: measured on a real posting with its application form
     * appended, 7 asks; on the same posting alone, 5; on the Jane Street page, 0.
     *
     * Refusing costs the operator one paste. Accepting costs a frozen packet scored against a form,
     * junk requirement terms drawn from dropdown options, and a gap list built out of them. The
     * 502 contract documented above is the designed route for a page this run cannot read. */
    if (leadRequirementCandidates(jdText).length === 0) {
      /* CHECKED ON THE CLIPPED TEXT, DELIBERATELY, because the clipped text is what gets frozen into
         the packet and scored. Validating result.text instead would let a page pass on requirements
         that MAX_JD_TEXT_CHARS then cuts away, which is the failure this guard exists to stop.
         Separating the two cases costs one more call and makes the distinction visible in the log:
         a Lever posting seen on another account filled all 20,000 characters with a `Name of School`
         dropdown of roughly three thousand university names, so a page whose description sits below
         a long <select> is a real shape, not a hypothetical, and it wants a different diagnosis from
         a page that never had a description at all. The operator is told the same thing either way
         because the remedy is the same paste. */
      const fullText = (result.text ?? '').trim();
      const truncated = fullText.length > jdText.length;
      // Only worth asking when text was actually cut: otherwise the two inputs are the same string.
      const descriptionPushedPastCap = truncated && leadRequirementCandidates(fullText).length > 0;
      fastify.log.warn(
        {
          userId,
          job_url: body.job_url,
          extraction_url: extractionUrl,
          textLen: jdText.length,
          truncated,
          reason: descriptionPushedPastCap ? 'description_pushed_past_cap' : 'page_states_no_requirement',
        },
        'job description extraction returned no stated requirement',
      );
      return reply.status(502).send({
        error: 'That page looks like an application form rather than a job description. Paste the job description manually instead.',
        code: descriptionPushedPastCap ? 'job_extract_truncated_past_description' : 'job_extract_no_requirements',
      });
    }

    return reply.status(200).send({ jd_text: jdText, page_title: result.title || undefined });
  });
}
