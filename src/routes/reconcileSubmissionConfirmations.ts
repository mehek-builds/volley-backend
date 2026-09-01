import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { reconcileSubmissionConfirmations } from '../lib/applicationEmail';

/* THE AUTOMATIC WAY BACK FOR CONFIRMATIONS THAT ARE ALREADY IN THE LEDGER.
 *
 * The email fallback only resolves a packet at the instant an inbound employer confirmation is
 * stored (handleStoredEmployerMessage). Any confirmation that misses that instant - one that arrived
 * out of order relative to the pressed attempt, during a forwarding-failure window, or before the
 * resolution logic itself was deployed - stays a receipt Litos holds and has never acted on. Until
 * now the only way to act on those was reconcileSubmissionConfirmations run by hand, or a manual
 * per-application repair dispatch (submission-confirmation-repair.yml). Neither runs on its own, so a
 * held confirmation could sit behind a "sent, could not confirm" banner indefinitely.
 *
 * This route is the missing scheduler surface. reconcileSubmissionConfirmations is safe to run on a
 * cadence by construction: it only ever reads rows already classified 'submission_confirmation' for a
 * real application (listStoredConfirmations), and resolvePacketFromConfirmation is idempotent,
 * evidence-guarded (it confirms only when a boundary_authorized send preceded the email and the
 * result is not stale or already confirmed), atomic, and never-throwing. It cannot fabricate a
 * confirmation; it can only heal one Litos was already told about. The same cron-secret guard every
 * other /internal/* endpoint uses gates it.
 */

export type ReconcileSubmissionConfirmationsDependencies = {
  reconcile: typeof reconcileSubmissionConfirmations;
};

const productionDependencies: ReconcileSubmissionConfirmationsDependencies = {
  reconcile: reconcileSubmissionConfirmations,
};

type RouteOptions = FastifyPluginOptions & {
  dependencies?: Partial<ReconcileSubmissionConfirmationsDependencies>;
};

/* A positive integer limit, or undefined to take reconcileSubmissionConfirmations' own default. The
 * reconciler clamps to [1, 1000] itself, so a hostile value cannot widen the pass; anything that is
 * not a clean positive integer is ignored rather than errored, because a cron URL is not a place to
 * argue about query syntax. */
function requestedLimit(request: FastifyRequest): number | undefined {
  const raw = (request.query as Record<string, unknown> | undefined)?.limit;
  if (typeof raw === 'number') return Number.isInteger(raw) && raw > 0 ? raw : undefined;
  // Digits only, so a value like "25abc" is ignored rather than silently read as 25.
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    return value > 0 ? value : undefined;
  }
  return undefined;
}

async function handleReconcile(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: ReconcileSubmissionConfirmationsDependencies,
) {
  if (!isCronConfigured()) {
    return reply.status(503).send({ error: 'reconcile not configured (set INTERNAL_CRON_SECRET or CRON_SECRET)' });
  }
  if (!isCronAuthorized(request)) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  const limit = requestedLimit(request);
  const result = await deps.reconcile(limit === undefined ? {} : { limit });
  return reply.send(result);
}

export async function reconcileSubmissionConfirmationsRoutes(
  fastify: FastifyInstance,
  options: RouteOptions = {},
) {
  const deps = { ...productionDependencies, ...options.dependencies };
  // GET for the cron; POST for manual/tooling triggers. Same pairing every other internal route uses.
  fastify.get('/internal/reconcile-submission-confirmations', (request, reply) => handleReconcile(request, reply, deps));
  fastify.post('/internal/reconcile-submission-confirmations', (request, reply) => handleReconcile(request, reply, deps));
}
