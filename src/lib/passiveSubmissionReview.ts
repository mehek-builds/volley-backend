import type { ApplicationReviewState } from './applicationReview';

/* A passive poll may describe the application, but it may not carry a browser destination.
 *
 * This is intentionally recursive and keyed by field shape instead of being a short destructuring
 * list. ApplicationReviewState has already gained employer URLs in four different branches. A new
 * nested `redirect_href` or `applicationUrl` must therefore be hidden by default, without waiting
 * for a second list to be updated after it ships.
 *
 * Screenshot evidence and the applicant's own public profile links are not employer navigation
 * capabilities. Their exact paths are the only URL-shaped exceptions. Moving either value under a
 * new field makes it private again until that path is deliberately reviewed here.
 */
const PASSIVE_NON_EMPLOYER_URL_PATHS = new Set([
  'progress_screenshot_url',
  'preview_screenshot_url',
  'receipt.screenshot_url',
  'applicant_snapshot.application_profile.linkedin_url',
  'applicant_snapshot.application_profile.github_url',
  'applicant_snapshot.application_profile.portfolio_url',
]);

function isUrlShapedField(key: string): boolean {
  const compact = key.replace(/[-_]/g, '').toLowerCase();
  return compact.endsWith('url')
    || compact.endsWith('urls')
    || compact.endsWith('uri')
    || compact.endsWith('uris')
    || compact.endsWith('href')
    || compact.endsWith('hrefs')
    || compact.endsWith('link')
    || compact.endsWith('links');
}

function passiveValue(value: unknown, path: readonly string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => passiveValue(entry, path));
  }
  if (!value || typeof value !== 'object') return value;

  const projected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...path, key];
    const joinedPath = nextPath.join('.');
    if (isUrlShapedField(key) && !PASSIVE_NON_EMPLOYER_URL_PATHS.has(joinedPath)) continue;
    projected[key] = passiveValue(entry, nextPath);
  }
  return projected;
}

/** A JSON-safe review for GET /applications/:id/submission. */
export function passiveSubmissionReview(
  review: ApplicationReviewState,
): Record<string, unknown> {
  return passiveValue(review, []) as Record<string, unknown>;
}
