import type { FastifyRequest } from 'fastify';

// Shared guard for /internal/* scheduled endpoints. Extracted from adapterHealth.ts when the
// resume retention sweep became the second cron: this check has already been got wrong once
// (only INTERNAL_CRON_SECRET was accepted, so Vercel Cron 401'd and the daily job silently
// never ran), and a copy of it is a copy of that bug waiting to happen.
//
// Accepts either our own INTERNAL_CRON_SECRET (curl/tooling, via x-internal-secret or Bearer)
// or Vercel Cron's `Authorization: Bearer <CRON_SECRET>`. Vercel injects CRON_SECRET
// automatically and it is usually a DIFFERENT value from INTERNAL_CRON_SECRET.
export function isCronAuthorized(request: FastifyRequest): boolean {
  const internal = process.env.INTERNAL_CRON_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const header = request.headers['authorization'];
  const auth = typeof header === 'string' ? header : '';
  if (internal && request.headers['x-internal-secret'] === internal) return true;
  if (internal && auth === `Bearer ${internal}`) return true;
  if (cronSecret && auth === `Bearer ${cronSecret}`) return true;
  return false;
}

// With neither secret set there is nothing to check against, so the endpoint must refuse
// rather than run unauthenticated.
export function isCronConfigured(): boolean {
  return Boolean(process.env.INTERNAL_CRON_SECRET || process.env.CRON_SECRET);
}
