/**
 * Cache headers for the public board endpoints.
 *
 * WHY THIS EXISTS
 * ---------------
 * `/jobs/grouped` and `/jobs/facets` serve trylitos.com/browse-jobs, which is server-rendered with
 * no session, so the overwhelming majority of their traffic is anonymous and identical for every
 * visitor. None of it was cacheable at the CDN: both routes sent no cache headers at all, so every
 * public board load reached Fastify and then Neon. That traffic is a large share of a transfer
 * allowance whose exhaustion suspends the database.
 *
 * WHY THIS IS A HELPER AND NOT A ONE-LINE `reply.header(...)`
 * ----------------------------------------------------------
 * Because marking these routes `public` naively is a REAL BUG, not a style question, and the reason
 * is not visible at the call site.
 *
 * Both routes run under `optionalAuth` and both call `accountRequiresSponsor`. A student who
 * declared at onboarding that they need visa sponsorship gets a filtered board EVEN WHEN the
 * `sponsor_only` query parameter is absent, because that account setting is OR-ed in server-side
 * and deliberately cannot be turned off by omitting a parameter. So two requests for the same URL
 * can legitimately have different bodies depending on who is asking.
 *
 * A shared cache keys on the URL. Marking that response `public` would let one visitor's board be
 * stored and replayed to another, and the direction that matters is the harmful one: an anonymous
 * (unfiltered) response served to a sponsor-required account fills their board with exactly the
 * postings the filter exists to hide, silently, with no error anywhere. That is the same class of
 * defect the sponsorOnly-in-the-cache-key note in rankingCache.ts records.
 *
 * So the rule here is narrow and it is enforced in one place: ONLY an anonymous request may be
 * cached publicly. An authenticated request is `private` and is never stored by a shared cache.
 * `Vary: Authorization` is sent on both, so a cache cannot satisfy an authenticated request from an
 * entry stored for an anonymous one even though the URLs match.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * How long a shared cache may serve a public board response without revalidating.
 *
 * Fifteen minutes. The board is rebuilt by a poll that runs ONCE A DAY (the `/internal/job-monitor`
 * cron), so the underlying data cannot change faster than that no matter what this number says.
 * Anything under a day is conservative; fifteen minutes is chosen to stay well inside the window
 * where a manually triggered poll during development still shows up promptly.
 *
 * This is NOT the same decision as the Next.js Data Cache windows on the website
 * (SUGGESTIONS_REVALIDATE / LISTINGS_REVALIDATE), which are per-deployment, cold after every
 * deploy, and sit in front of these responses rather than beside them. This header governs the
 * shared CDN, which those windows never reached.
 */
export const BOARD_SHARED_MAX_AGE_S = 900;

/**
 * How long a stale response may still be served while a fresh one is fetched behind it.
 *
 * A day, which is the poll cadence. The point is that a cache expiry never becomes a thundering
 * herd of requests onto Neon: past the fifteen-minute window the CDN keeps answering from the
 * stale copy and revalidates once, rather than letting every waiting visitor through to the origin.
 * On a database that gets suspended for transfer, the herd is the failure mode worth preventing.
 */
export const BOARD_STALE_WHILE_REVALIDATE_S = 86_400;

/**
 * Add a field to `Vary` WITHOUT discarding what is already there.
 *
 * `reply.header('Vary', ...)` REPLACES, and something else already sets this header: `@fastify/cors`
 * is registered with a dynamic `origin` function, so it emits `Vary: Origin` on every response.
 * Overwriting that while ALSO marking the response `public` is the dangerous combination, and it is
 * the exact bug this function exists to prevent: a shared cache would then key the entry without
 * Origin, and could hand a response carrying one origin's `Access-Control-Allow-Origin` to a request
 * from a different allowed origin. Verified against a real Fastify instance, not assumed.
 *
 * Case-insensitive on the field names, because `Vary` tokens are, and a duplicate differing only in
 * case would still be a duplicate to a human reading the header.
 */
export function addVary(reply: FastifyReply, field: string): void {
  const existing = reply.getHeader('Vary');
  const tokens = String(existing ?? '')
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean);

  /* `Vary: *` means "never reuse this entry for any other request". Adding a field to it would be
     a weakening, so it is left exactly as found. */
  if (tokens.some((token) => token === '*')) return;
  if (tokens.some((token) => token.toLowerCase() === field.toLowerCase())) return;

  reply.header('Vary', [...tokens, field].join(', '));
}

/**
 * Apply the right cache policy for this request and return the reply for chaining.
 *
 * Anonymous is decided by `request.jwtPayload`, which `optionalAuth` sets only on a VALID token.
 * That is the correct test rather than sniffing the Authorization header: a request carrying an
 * expired token never reaches a handler (optionalAuth 401s it), and a request carrying no token is
 * genuinely anonymous and genuinely gets the unfiltered board.
 */
export function applyBoardCacheHeaders(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  /* Sent on BOTH branches. Without it, a shared cache that stored the anonymous response could
     satisfy a later authenticated request for the same URL from that entry, and the `private` on
     the authenticated branch would never get a chance to prevent it, because the authenticated
     request would not reach the origin at all. */
  addVary(reply, 'Authorization');

  if (request.jwtPayload) {
    /* Per-account, so it must never enter a shared cache. `private` still permits the browser's own
       cache, which is the correct place for it and costs Neon nothing. */
    return reply.header('Cache-Control', 'private, max-age=60');
  }

  return reply.header(
    'Cache-Control',
    `public, s-maxage=${BOARD_SHARED_MAX_AGE_S}, stale-while-revalidate=${BOARD_STALE_WHILE_REVALIDATE_S}`,
  );
}
