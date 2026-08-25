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
 * /<tenant>/j/<token>/apply. This is the only non-identical redirect accepted at an applicant-data
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

/** Return the exact observed boundary only when it is the approved URL or Workable's one redirect. */
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
  return isWorkableCanonicalApplicationRedirect(from, to) ? to.href : null;
}
