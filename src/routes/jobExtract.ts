import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { isBrowserbaseConfigured, isManagedStratusProvider, runManagedBrowser } from '../lib/browserbase';
import { leadRequirementCandidates } from '../engine/leadAlignment';
import { canonicalMonitoredPortalUrl } from '../lib/portalSubmission';
import { db } from '../db/index';
import { career_page_sources, monitored_jobs } from '../db/schema';

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
/* The other boards whose candidate form lives on a separate route from the posting. Each pattern
 * is the family's own application route, measured on live tenants: a pasted apply link is the
 * commonest shape a student has (it is what the board's Apply button copies), and reading the form
 * page instead of the posting yields "Litos could not find a stated requirement on that page"
 * (measured 2026-09-02 on a Crelate apply link). The rewrite keeps the family's tenant and posting
 * identity and drops only the form segment, so the monitored-inventory lookup (which keys on both
 * apply_url and posting_url) and the browser read both land on the posting. Per host on purpose,
 * exactly like Workable and Lever above: a trailing form segment means whatever the board says it
 * means, so nothing is stripped on a host we have not checked. */
/* The job code is Crelate's 26-character id, the same shape APPLY_PATHS.crelate accepts, so the
   tenant's general-consideration form (/job/apply/general) is not rewritten to a page that is not a
   posting. */
const CRELATE_APPLICATION_PATH = /^\/(portal\/[^/]+\/job)\/apply\/([a-z0-9]{26})\/?$/i;
const RECRUITEE_APPLICATION_PATH = /^\/(o\/[^/]+)\/c\/new\/?$/i;
const TEAMTAILOR_APPLICATION_PATH = /^\/(jobs\/[^/]+)\/applications\/new\/?$/i;
const PINPOINT_APPLICATION_PATH = /^\/((?:[a-z]{2}\/)?postings\/[^/]+)\/applications\/new\/?$/i;
const BREEZY_APPLICATION_PATH = /^\/(p\/[^/]+)\/apply\/?$/i;
const SEPARATE_FORM_ROUTES: ReadonlyArray<{ host: (hostname: string) => boolean; path: RegExp; posting: (match: RegExpMatchArray) => string }> = [
  { host: (h) => h === 'jobs.crelate.com', path: CRELATE_APPLICATION_PATH, posting: (m) => `/${m[1]}/${m[2]}` },
  /* Tenant subdomains only: the vendor's own www/app/api hosts serve no posting, so a form-shaped
     path there is left exactly as pasted. Teamtailor's regional tenants (<tenant>.na.teamtailor.com)
     are real career sites and are read like any other; whether the submission side supports them
     is HOSTS.teamtailor's question, not this reader's. */
  { host: (h) => /^(?!(?:www|app|api)\.)[a-z0-9-]+\.recruitee\.com$/i.test(h), path: RECRUITEE_APPLICATION_PATH, posting: (m) => `/${m[1]}` },
  { host: (h) => /^(?!(?:www|app|api)\.)[a-z0-9-]+(?:\.[a-z]{2})?\.teamtailor\.com$/i.test(h), path: TEAMTAILOR_APPLICATION_PATH, posting: (m) => `/${m[1]}` },
  { host: (h) => /^(?!(?:www|app|api)\.)[a-z0-9-]+\.pinpointhq\.com$/i.test(h), path: PINPOINT_APPLICATION_PATH, posting: (m) => `/${m[1]}` },
  { host: (h) => /^(?!(?:www|app|api)\.)[a-z0-9-]+\.breezy\.hr$/i.test(h), path: BREEZY_APPLICATION_PATH, posting: (m) => `/${m[1]}` },
];

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

  if (url.protocol === 'https:') {
    const hostname = url.hostname.toLowerCase();
    for (const route of SEPARATE_FORM_ROUTES) {
      if (!route.host(hostname)) continue;
      const match = url.pathname.match(route.path);
      if (!match) return rawUrl;
      url.pathname = route.posting(match);
      url.search = '';
      url.hash = '';
      return url.toString();
    }
  }

  return rawUrl;
}

/** The pasted URL without query or fragment, or undefined when it has neither (or cannot parse). */
function urlWithoutTrackingState(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (!url.search && !url.hash) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Equality keys used only to SELECT candidate monitored rows for a pasted URL. This is deliberately
 * looser than the route's per-ATS rewrite rule: a wrong variant here cannot extract a wrong page,
 * because a candidate row becomes a match only when monitoredJobDescriptionMatch proves posting
 * identity through canonicalMonitoredPortalUrl. The variants exist so the common paste shapes -
 * with or without a trailing slash, the overview versus its /apply form, a copied link with
 * tracking state - still find the row whose stored URL is the other shape.
 */
export function monitoredInventoryLookupKeys(rawUrl: string): string[] {
  const keys = new Set<string>([rawUrl]);
  try {
    keys.add(jobDescriptionSourceUrl(rawUrl));
    const url = new URL(rawUrl);
    url.search = '';
    url.hash = '';
    const basePath = url.pathname.replace(/\/$/, '');
    for (const pathname of [
      basePath,
      `${basePath}/`,
      /\/apply$/i.test(basePath) ? basePath.replace(/\/apply$/i, '') : `${basePath}/apply`,
    ]) {
      url.pathname = pathname;
      keys.add(url.toString());
    }
  } catch {
    // The route's schema already validated the URL; an unparsable value keeps only its raw key.
  }
  return [...keys];
}

export type MonitoredInventoryJob = {
  external_id: string;
  apply_url: string;
  posting_url: string;
  title: string;
  /* Optional only so older callers and fixtures that never carried it keep compiling; the route's
     own lookup always selects it. */
  company_name?: string | null;
  description: string;
  ats_name: string | null;
  board_token: string | null;
};

/**
 * Decide whether a pasted URL IS this monitored posting, by the same bar
 * repairReviewPortalFromMonitoredJob applies to stored packet state: both the row's own apply_url
 * and the pasted URL must canonicalize under the row's source-owned family, board token, and
 * external id, and to the SAME application URL. String equality against apply_url/posting_url only
 * nominates candidates; this is what makes one a match. A row whose source family is not
 * autonomous, whose token is missing, or whose tenant or posting id disagrees with the pasted URL
 * fails closed here and the route falls back to the managed browser, which was its whole behavior
 * before this lookup existed.
 */
export function monitoredJobDescriptionMatch(
  rawUrl: string,
  job: MonitoredInventoryJob,
): { jdText: string; pageTitle: string; companyName: string } | undefined {
  const storedCanonical = canonicalMonitoredPortalUrl(
    job.apply_url,
    job.ats_name,
    job.board_token,
    job.external_id,
    job.posting_url,
  );
  if (!storedCanonical) return undefined;
  /* RAW FIRST, THEN WITHOUT TRACKING STATE, and the order is the whole point. Outside Greenhouse,
     canonicalMonitoredPortalUrl rejects any query string outright, which is right for a STORED
     provider-owned URL and wrong for one a student pasted: links copied off LinkedIn or an
     aggregator carry `?utm_source=` and `?lever-source=`, and that is the commonest paste shape
     there is. Greenhouse is why the raw attempt has to come first - its embed URL carries the
     posting's identity IN the query (`?for=&token=`), so stripping it there destroys the match.
     Dropping the query cannot select a WRONG posting: the row's tenant and external id are still
     proven below, and jobDescriptionSourceUrl already treats this state as not part of what
     identifies a posting. */
  const pastedCanonical = [rawUrl, urlWithoutTrackingState(rawUrl)]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map((candidate) => canonicalMonitoredPortalUrl(
      candidate,
      job.ats_name,
      job.board_token,
      job.external_id,
      job.posting_url,
    ))
    .find((canonical) => canonical === storedCanonical);
  if (!pastedCanonical) return undefined;
  const jdText = clipJdText(job.description);
  if (!jdText) return undefined;
  return { jdText, pageTitle: job.title.trim(), companyName: (job.company_name ?? '').trim() };
}

/**
 * Look the pasted URL up against the monitored jobs inventory before ever paying for a browser
 * run. Observed live 2026-09-01: extraction transiently 502ed on a Breezy posting that sat in
 * monitored_jobs with a full substantive description the board was already serving. When the
 * inventory holds the exact posting, its stored description is strictly better than a fresh render:
 * it was captured from the provider's own feed, it cannot be a consent banner or an application
 * form, and it is immune to the SPA-render timing this route documents below.
 *
 * Gated to rows the board itself would serve (is_active, ingest_eligible, enabled source), so a
 * closed or unvalidated row never short-circuits a live read.
 */
export async function findMonitoredJobDescription(
  rawUrl: string,
): Promise<{ jobId: string; jdText: string; pageTitle: string; companyName: string } | undefined> {
  const keys = monitoredInventoryLookupKeys(rawUrl);
  const candidates = await db.select({
    id: monitored_jobs.id,
    external_id: monitored_jobs.external_id,
    apply_url: monitored_jobs.apply_url,
    posting_url: monitored_jobs.posting_url,
    title: monitored_jobs.title,
    company_name: monitored_jobs.company_name,
    // Same bounded read the portal repair path uses: the route clips to MAX_JD_TEXT_CHARS anyway,
    // so there is no reason to move a multi-hundred-kilobyte description over the wire.
    description: sql<string>`left(${monitored_jobs.description}, 60000)`,
    ats_name: career_page_sources.ats_name,
    board_token: career_page_sources.board_token,
  })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(and(
      or(
        inArray(monitored_jobs.apply_url, keys),
        inArray(monitored_jobs.posting_url, keys),
      ),
      eq(monitored_jobs.is_active, true),
      eq(monitored_jobs.ingest_eligible, true),
      eq(career_page_sources.enabled, true),
    ))
    /* Ordered so a URL that several rows claim resolves to the freshest capture rather than to
       whatever the planner returned first. Duplicates are possible in principle: apply_url carries
       no uniqueness constraint, and a posting reachable through two enabled sources is one row per
       source. The cap is small because every extra candidate is a canonical check against the same
       pasted URL, and past a handful they can no longer be telling the truth about one posting. */
    .orderBy(desc(monitored_jobs.last_seen_at))
    .limit(5);
  for (const candidate of candidates) {
    const match = monitoredJobDescriptionMatch(rawUrl, candidate);
    if (match) return { jobId: candidate.id, ...match };
  }
  return undefined;
}

export async function jobExtractRoutes(fastify: FastifyInstance) {
  // POST /jobs/extract - given a posting URL, first answer from the monitored jobs inventory when
  // the URL canonically matches a posting the monitor already holds (see
  // findMonitoredJobDescription above); otherwise render it in the managed browser (the same
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

    /* INVENTORY FIRST, BROWSER SECOND. If the pasted URL is a posting the monitor already holds,
       the stored description answers without a render: no SPA timing race, no consent banner, no
       application form, and no transient 502 on a page the board is serving right now (observed
       live 2026-09-01 on a Breezy posting). The lookup is best-effort by design: any database
       error, canonical mismatch, or description that states no requirement simply falls through to
       the managed-browser path, which then behaves exactly as it did before this lookup existed.
       Sits ahead of the runner-config check on purpose, so a deployment without a managed browser
       can still answer for postings it monitors. */
    let monitored: Awaited<ReturnType<typeof findMonitoredJobDescription>>;
    try {
      monitored = await findMonitoredJobDescription(body.job_url);
    } catch (err) {
      fastify.log.warn(
        { err, userId, job_url: body.job_url },
        'monitored inventory lookup failed; falling back to browser extraction',
      );
      monitored = undefined;
    }
    if (monitored) {
      /* The same bar the browser path applies below, on the same clipped text that would be frozen
         into the packet. A stored description that states no requirement is not proof the live page
         states none (the monitor may have captured a shape leadAlignment cannot read), so it is a
         fall-through to the browser rather than a refusal: the inventory path may only ever
         short-circuit with a GOOD result, never introduce a new failure. */
      if (leadRequirementCandidates(monitored.jdText).length > 0) {
        fastify.log.info(
          {
            userId,
            job_url: body.job_url,
            monitored_job_id: monitored.jobId,
            title: monitored.pageTitle,
            textLen: monitored.jdText.length,
          },
          'job description served from monitored inventory',
        );
        /* The posting's identity rides with its text. The composer asks for company and role
           before it will tailor or fill, and a student who pasted a link should not be typing
           either back in when the monitor already holds both for this exact posting. */
        return reply.status(200).send({
          jd_text: monitored.jdText,
          page_title: monitored.pageTitle || undefined,
          company: monitored.companyName || undefined,
          role: monitored.pageTitle || undefined,
        });
      }
      fastify.log.warn(
        { userId, job_url: body.job_url, monitored_job_id: monitored.jobId },
        'monitored inventory description states no requirement; falling back to browser extraction',
      );
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
      /* SAY WHAT WAS DETERMINED, NOT WHAT IT PROBABLY MEANS. This read "That page looks like an
         application form rather than a job description", which the predicate does not establish:
         leadRequirementCandidates returns nothing when it finds no stated requirement, and a form
         is only the most common reason. It is not the only one. splitClauses works on LINES and
         drops any over 300 characters, so a genuine posting written as flowing paragraphs rather
         than bullets also lands here, correctly refused and wrongly explained. Measured on this
         repo's own fixtures: the abridged Databricks posting behind ISSUE-014 is a single 458
         character line and states no ask by this test, and adding a section heading above it does
         not change that.

         A refusal with a false reason is worse than a blunt one. It sends the operator hunting for
         a form that is not there and reads as a product defect rather than as what it is, which is
         that the captured text did not contain a requirement. The form remains a hint because it is
         genuinely the usual cause, but it is offered as a possibility rather than asserted. */
      return reply.status(502).send({
        error: descriptionPushedPastCap
          ? 'Litos read that page, but its requirements sit past the amount of text Litos captures. Paste the job description manually instead.'
          : 'Litos could not find a stated requirement on that page. It may be the application form rather than the posting itself. Paste the job description manually instead.',
        code: descriptionPushedPastCap ? 'job_extract_truncated_past_description' : 'job_extract_no_requirements',
      });
    }

    return reply.status(200).send({ jd_text: jdText, page_title: result.title || undefined });
  });
}
