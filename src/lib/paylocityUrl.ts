type PaylocityJobRoute = 'Apply' | 'Details';

// Public recruiting tenants use recruiting.paylocity.com or a tenant prefix ending in
// "recruiting", such as 2000recruiting.paylocity.com. Matching the raw URL keeps parser path
// normalization, credentials, ports, query state, and fragments from widening the exact route.
const PAYLOCITY_JOB_URL =
  /^https:\/\/(?:[a-z0-9-]*recruiting)\.paylocity\.com\/Recruiting\/Jobs\/(Apply|Details)\/(\d+)(\/[^/?#]+)?$/i;

function rewritePaylocityJobRoute(
  rawUrl: string,
  from: PaylocityJobRoute,
  to: PaylocityJobRoute,
): string | undefined {
  const match = rawUrl.match(PAYLOCITY_JOB_URL);
  if (!match || match[1].toLowerCase() !== from.toLowerCase()) return undefined;
  const [, , jobId, slug = ''] = match;
  const url = new URL(rawUrl);
  const rawPath = `/Recruiting/Jobs/${match[1]}/${jobId}${slug}`;
  if (url.pathname !== rawPath || /%2f|%5c/i.test(slug)) return undefined;
  url.pathname = `/Recruiting/Jobs/${to}/${jobId}${slug}`;
  return url.toString();
}

export function paylocityApplicationUrl(rawUrl: string): string | undefined {
  return rewritePaylocityJobRoute(rawUrl, 'Details', 'Apply');
}

export function paylocityDetailsUrl(rawUrl: string): string | undefined {
  return rewritePaylocityJobRoute(rawUrl, 'Apply', 'Details');
}
