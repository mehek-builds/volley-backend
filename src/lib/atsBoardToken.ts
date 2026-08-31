import type { SupportedJobBoard } from './jobMonitor';

const DNS_LABEL_ATS = new Set<SupportedJobBoard>(['breezy', 'recruitee']);
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PATH_SEGMENT = /^[a-z0-9](?:[a-z0-9._~-]{0,126}[a-z0-9])?$/;

/**
 * Normalize an untrusted catalog value only when it can be executed by that provider's poller.
 *
 * Breezy and Recruitee interpolate the token into a hostname, so their values must be one complete
 * DNS label. Every other current poller uses one URL path segment or an encoded form of it. Those
 * tokens use a deliberately small ASCII slug vocabulary and a 128-character bound. Slashes,
 * spaces, credentials, query syntax, and trailing punctuation are rejected before they can count
 * toward source-catalog completeness.
 */
export function normalizeExecutableAtsBoardToken(
  atsName: SupportedJobBoard,
  value: unknown,
): string | null {
  if (typeof value !== 'string') return null;
  let token = value.trim();
  if (!token) return null;
  if (token.includes('%')) {
    try {
      token = decodeURIComponent(token);
    } catch {
      return null;
    }
  }
  token = token.trim().toLowerCase();
  if (!token) return null;
  return (DNS_LABEL_ATS.has(atsName) ? DNS_LABEL : PATH_SEGMENT).test(token)
    ? token
    : null;
}
