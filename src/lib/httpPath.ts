/**
 * Path normalization and prefix matching shared by every request-time route allowlist or
 * denylist in this codebase that has to classify a request by its path: submission cutover
 * (lib/submissionCutover.ts) and THE CARD GATE (lib/cardGate.ts).
 *
 * Extracted after the two carried independently-written copies of the same two functions that had
 * already drifted: submissionCutover's stripped a URL fragment and cardGate's did not, so the same
 * literal request path could get two different answers depending on which allowlist asked. A single
 * request path claiming to be "at or below /billing" (or not) is not supposed to be a question with
 * two implementations.
 */

/**
 * Strip a query string and/or fragment and collapse a trailing slash, so `/billing/`,
 * `/billing?x=1` and `/billing#y` all normalize to the same `/billing` a caller can compare
 * against a literal root.
 */
export function normalizedRequestPath(rawPath: string): string {
  const queryAt = rawPath.indexOf('?');
  const fragmentAt = rawPath.indexOf('#');
  const cutAt = [queryAt, fragmentAt]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), rawPath.length);
  const withoutQuery = rawPath.slice(0, cutAt) || '/';
  return withoutQuery.length > 1 ? withoutQuery.replace(/\/+$/, '') : withoutQuery;
}

/** Whether `path` is exactly `root`, or a segment below it (`/billing/checkout` is below `/billing`;
 *  `/billingx` is not, and neither is `/billing` a match for root `/billingx`). */
export function isAtOrBelowPath(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
