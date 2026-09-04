export type WorkableApplicationUrlIdentity = {
  href: string;
  origin: string;
  tenant: string | null;
  jobToken: string;
  search: string;
  shape: 'bare' | 'tenant';
};

/** Parse only the two application URL shapes published by Workable's candidate service. */
export function readWorkableApplicationUrl(value: string | URL): WorkableApplicationUrlIdentity | null {
  let url: URL;
  try {
    url = new URL(value.toString());
  } catch {
    return null;
  }
  url.hash = '';
  if (url.protocol !== 'https:'
    || url.hostname.toLowerCase() !== 'apply.workable.com'
    || url.username
    || url.password
    || (url.port && url.port !== '443')) return null;

  const bare = url.pathname.match(/^\/j\/([A-Fa-f0-9]{10})\/apply\/?$/);
  if (bare) {
    return {
      href: url.href,
      origin: url.origin,
      tenant: null,
      jobToken: bare[1].toUpperCase(),
      search: url.search,
      shape: 'bare',
    };
  }

  const tenant = url.pathname.match(/^\/([A-Za-z0-9][A-Za-z0-9-]{0,99})\/j\/([A-Fa-f0-9]{10})\/apply\/?$/);
  return tenant
    ? {
        href: url.href,
        origin: url.origin,
        tenant: tenant[1],
        jobToken: tenant[2].toUpperCase(),
        search: url.search,
        shape: 'tenant',
      }
    : null;
}

/**
 * Workable's public feed publishes /j/<token>/apply and its candidate site redirects that URL to
 * /<tenant>/j/<token>/apply. One of the two non-identical redirects accepted at an applicant-data
 * boundary. The host, scheme, job identity, and complete query string must remain unchanged.
 */
export function isWorkableCanonicalApplicationRedirect(
  expected: string | URL,
  observed: string | URL,
): boolean {
  const from = readWorkableApplicationUrl(expected);
  const to = readWorkableApplicationUrl(observed);
  return from?.shape === 'bare'
    && to?.shape === 'tenant'
    && from.origin === to.origin
    && from.jobToken === to.jobToken
    && from.search === to.search;
}

const GREENHOUSE_LEGACY_REDIRECT_HOST = 'boards.greenhouse.io';
const GREENHOUSE_CURRENT_REDIRECT_HOST = 'job-boards.greenhouse.io';

/**
 * Greenhouse's legacy host answers a 301 to its current host with the path and query carried across
 * byte-for-byte. Measured 2026-09-04 from the shell:
 *
 *   GET https://boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004
 *     -> 301 location: https://job-boards.greenhouse.io/embed/job_app?for=sage49&token=6131185004
 *     -> 200
 *   GET https://boards.greenhouse.io/sage49/jobs/6131185004
 *     -> 301 location: https://job-boards.greenhouse.io/sage49/jobs/6131185004
 *     -> 200
 *
 * THE HOSTNAME IS THE ONLY COMPONENT THAT MOVES, and it is a whole-host migration rather than a
 * per-route rewrite - both shapes take the same 301 - so an IDENTICAL pathname is demanded rather
 * than a pattern-matched one. Greenhouse keeps the job identity in the query string
 * (?for=<board>&token=<jobId>), which stays bound byte-for-byte, so a different board or a
 * different job id cannot resolve.
 *
 * WHY THIS EXISTS: portalApplicationUrl sends every Greenhouse packet to an embed URL built on the
 * legacy host (greenhouseEmbedApplicationUrl -> GREENHOUSE_LEGACY_EMBED_HOST), so the expected URL
 * is always legacy and the landed URL is always current. Without this the managed runner's own
 * boundary check aborted before the first application action, and this repo's proof reconciliation
 * would reject the landed boundary even once the runner accepted it. Measured live on Sage
 * application aae653a3-2d5a-4f3e-ba3b-afea4219df37, which failed twice with nothing filled.
 *
 * ONE-WAY, because that is the direction Greenhouse redirects. boards.eu.greenhouse.io is
 * deliberately absent: greenhouseEmbedHostForHostname already builds EU URLs on the current
 * job-boards.eu host, so no caller can present an EU legacy host as its expected URL.
 *
 * Kept in lockstep with stratus-browser-cloud's resolvedManagedExactPageUrl. The two run on
 * opposite sides of the same comparison - the runner decides whether to act, this repo decides
 * whether to believe the proof it returns - so a rule accepted by one and refused by the other
 * turns a working run into an unprovable one.
 */
export function isGreenhouseLegacyHostRedirect(
  expected: string | URL,
  observed: string | URL,
): boolean {
  let from: URL;
  let to: URL;
  try {
    from = new URL(expected.toString());
    to = new URL(observed.toString());
  } catch {
    return false;
  }
  if (from.protocol !== 'https:' || to.protocol !== 'https:'
    || from.username || from.password || to.username || to.password
    || (from.port && from.port !== '443') || (to.port && to.port !== '443')) return false;
  if (from.hostname.toLowerCase() !== GREENHOUSE_LEGACY_REDIRECT_HOST
    || to.hostname.toLowerCase() !== GREENHOUSE_CURRENT_REDIRECT_HOST) return false;
  // A host migration carries the path across untouched, and the query holds the job identity.
  if (from.pathname !== to.pathname || from.search !== to.search) return false;
  // An embed route naming no job has no identity for the equal query strings to have bound.
  return from.pathname !== '/embed/job_app' || Boolean(to.searchParams.get('token'));
}

/**
 * Query params carry a posting's identity (Greenhouse's ?for=<board>&token=<jobId>) and can never
 * be dropped, but some ATS front ends re-serialize their own address bar after mount, reordering
 * the same params they were given - confirmed live on Redwood Materials (3/3 identical
 * "employer page redirected away from the approved destination" failures, same applicationId, via
 * backend logs). Sorting by key-then-value can only make two URLs compare equal if their param
 * SETS were already identical, so a genuinely different board or job id still fails every
 * exact-page-url check this feeds. Mutates the URL in place, mirroring
 * stratus-browser-cloud's own canonicalPageUrl so both sides of every comparison agree on one sort.
 */
export function sortManagedPageUrlParams(url: URL): void {
  const params = [...url.searchParams.entries()].sort(
    ([keyA, valueA], [keyB, valueB]) => (keyA < keyB ? -1 : keyA > keyB ? 1 : (valueA < valueB ? -1 : valueA > valueB ? 1 : 0))
  );
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);
}

/**
 * Return the exact observed boundary only when it is the approved URL, or one of the two measured
 * first-party redirects that provably land on the same job: Workable's short-link canonicalization
 * and Greenhouse's legacy-host 301.
 */
export function resolvedApprovedApplicationPageUrl(
  expected: string | URL,
  observed: string | URL,
): string | null {
  let from: URL;
  let to: URL;
  try {
    from = new URL(expected.toString());
    to = new URL(observed.toString());
  } catch {
    return null;
  }
  from.hash = '';
  to.hash = '';
  if (from.href === to.href) return to.href;
  return isWorkableCanonicalApplicationRedirect(from, to)
    || isGreenhouseLegacyHostRedirect(from, to)
    ? to.href
    : null;
}
