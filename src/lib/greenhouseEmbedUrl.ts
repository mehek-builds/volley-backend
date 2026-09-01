/* THE ONE GREENHOUSE EMBED-ROUTE TEMPLATE.
 *
 * `https://{host}/embed/job_app?for={board}&token={jobId}` had grown four independent spellings:
 * the monitor's constructed action URL (jobMonitor.normalizeGreenhouseJobs), the employer-hosted
 * board resolver (greenhouseEmbeddedBoards.embeddedGreenhouseApplicationUrl), the submission-time
 * canonicalizer (portalSubmission.canonicalMonitoredPortalUrl), and detectPortal's own family of
 * legacy-host builders. They must agree exactly: the monitor STORES what the canonicalizer will
 * later demand, and a one-character divergence between the two makes a stored posting canonicalize
 * to undefined and become unappliable.
 *
 * The region rule lives here for the same reason. An EU-silo tenant's embed route does not exist on
 * the US host, so picking the wrong one produces a 404 that looks like a dead posting; when
 * Greenhouse adds a third silo, this is the single place that has to learn about it.
 *
 * The HOST IS ALWAYS THE CALLER'S, never defaulted, because the legacy `boards.greenhouse.io` and
 * the current `job-boards.greenhouse.io` are both live and each caller has already established
 * which one its evidence points at.
 */

export const GREENHOUSE_EMBED_HOST = 'job-boards.greenhouse.io';
export const GREENHOUSE_EU_EMBED_HOST = 'job-boards.eu.greenhouse.io';
/** Still answered by Greenhouse, and still what detectPortal's evidence resolves to. */
export const GREENHOUSE_LEGACY_EMBED_HOST = 'boards.greenhouse.io';

const GREENHOUSE_EMBED_HOSTS: ReadonlySet<string> = new Set([
  GREENHOUSE_EMBED_HOST,
  GREENHOUSE_EU_EMBED_HOST,
  GREENHOUSE_LEGACY_EMBED_HOST,
]);

/**
 * Which regional embed host a board's postings apply through, given any host Greenhouse serves that
 * board from. REGION ONLY: the caller's host selects between first-party constants and is never
 * itself trusted or propagated, so an employer's custom domain resolves to the default host - the
 * same one the board API that listed the posting answers from.
 */
export function greenhouseEmbedHostForHostname(hostname: string): string {
  const host = hostname.toLowerCase();
  return host === 'boards.eu.greenhouse.io' || host === GREENHOUSE_EU_EMBED_HOST
    ? GREENHOUSE_EU_EMBED_HOST
    : GREENHOUSE_EMBED_HOST;
}

/**
 * Build the embed application URL for a board token and job id on an already-chosen host.
 *
 * `boardToken` is optional because one shape genuinely carries no tenant: a Databricks posting
 * resolves to an id alone, and Greenhouse answers that route without a `for`.
 *
 * Both parts are encoded. Every caller today validates its job id as digits first, so encoding it
 * cannot change a single URL this produces - but the four spellings this replaced each carried that
 * guarantee in their own caller, and a shared builder is reachable from callers that do not exist
 * yet. Encoding here means an unvalidated id can never append a second query parameter.
 */
export function buildGreenhouseEmbedUrl(
  host: string,
  jobId: string,
  boardToken?: string,
): string {
  const tenant = boardToken ? `for=${encodeURIComponent(boardToken)}&` : '';
  return `https://${host}/embed/job_app?${tenant}token=${encodeURIComponent(jobId)}`;
}

/**
 * Whether a URL is an embed application route this module builds - the bare application FORM rather
 * than a readable hosted job page.
 *
 * This is the counter half of the builder above and deliberately sits beside it: pollSource reports
 * how many of a board's stored action URLs are constructed embed routes rather than validated
 * hosted pages, and that count is only honest while the two definitions cannot drift apart.
 */
export function isGreenhouseEmbedApplicationUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:'
    && GREENHOUSE_EMBED_HOSTS.has(url.hostname.toLowerCase())
    && url.pathname === '/embed/job_app';
}
