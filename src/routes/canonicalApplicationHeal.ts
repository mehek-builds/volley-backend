import type { FastifyInstance, FastifyPluginOptions, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import {
  reconcileCanonicalApplicationRows,
  type CanonicalReconcileOutcome,
} from '../lib/canonicalApplicationSync';

export type CanonicalApplicationHealDependencies = {
  reconcile: (input: { userId?: string; limit?: number }) => Promise<CanonicalReconcileOutcome>;
};

type CanonicalApplicationHealRouteOptions = FastifyPluginOptions & {
  dependencies?: Partial<CanonicalApplicationHealDependencies>;
};

/* Optional narrowing for a hand-run pass: one account while diagnosing it, or a smaller batch
 * while watching the first run land. Bad input is a 400, not a silently widened sweep - a typo'd
 * user_id that fell back to "everyone" would heal rows the operator was deliberately not touching
 * yet. */
const healQuerySchema = z.object({
  user_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

/* THE HOST FOR THE READER-SIDE HEAL, and nothing else.
 *
 * reconcileCanonicalApplicationRows closes the split the packet writers can leave behind - a
 * packet whose review says 'submitted' beside an applications row still offering to send it - and
 * this route is how it runs: on demand, authorized, and deliberately NOT scheduled. There is no
 * vercel.json entry for it, the same stance reconcileSubmissionConfirmations takes and for the
 * same reason: putting a healing write on a clock is a separate decision with its own blast
 * radius, and it should be taken by someone looking at this route's counters, not implied here.
 *
 * The counters are the point of the response. `scanned` is how many split rows exist right now,
 * which is the size of the problem; `healed` is how many this pass fixed; a nonzero `failed` means
 * the applications table refused writes and the pass should be re-run. A second pass over the same
 * data is safe however it went: the guarded UPDATE only ever moves a row that still needs moving.
 */
async function handleHeal(
  request: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  dependencies: CanonicalApplicationHealDependencies,
) {
  // Refusals log, for the reason lib/cronAuth.ts records: a 503 or 401 answered in silence is how
  // an internal endpoint dies unnoticed, and an operator curling this one deserves the reason.
  if (!isCronConfigured()) {
    fastify.log.warn('canonical application heal REFUSED: neither INTERNAL_CRON_SECRET nor CRON_SECRET is set');
    return reply.status(503).send({
      error: 'canonical application heal not configured (set INTERNAL_CRON_SECRET or CRON_SECRET)',
    });
  }
  if (!isCronAuthorized(request)) {
    fastify.log.warn('canonical application heal REFUSED: caller presented no valid secret');
    return reply.status(401).send({ error: 'unauthorized' });
  }
  const parsed = healQuerySchema.safeParse(request.query ?? {});
  if (!parsed.success) {
    return reply.status(400).send({ error: 'Invalid heal query: user_id must be a uuid and limit an integer from 1 to 1000' });
  }

  const outcome = await dependencies.reconcile({ userId: parsed.data.user_id, limit: parsed.data.limit });
  if (outcome.failed > 0) {
    fastify.log.error(
      { ...outcome },
      'canonical application heal left rows unhealed: the applications table refused writes for some packets; re-run once it recovers',
    );
  }
  return reply.send({ checked_at: new Date().toISOString(), ...outcome });
}

export async function canonicalApplicationHealRoutes(fastify: FastifyInstance, options: CanonicalApplicationHealRouteOptions = {}) {
  const dependencies: CanonicalApplicationHealDependencies = {
    reconcile: reconcileCanonicalApplicationRows,
    ...options.dependencies,
  };
  // POST for manual/tooling triggers (curl + x-internal-secret); GET so that if this is ever
  // deliberately scheduled, Vercel Cron - which issues GET only and authenticates via the
  // Authorization header - can call it without a code change. Same pairing as
  // /internal/managed-receiving-canary.
  fastify.post('/internal/canonical-application-heal', (request, reply) => handleHeal(request, reply, fastify, dependencies));
  fastify.get('/internal/canonical-application-heal', (request, reply) => handleHeal(request, reply, fastify, dependencies));
}
