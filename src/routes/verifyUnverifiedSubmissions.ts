import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { recoverUnverifiedSubmission } from './submissionRunner';
import { runSubmissionVerificationSweep } from '../lib/submissionVerificationSweep';

/* The scheduler surface for lib/submissionVerificationSweep.ts, on the same guard and the same
 * cron pattern as /internal/reconcile-submission-confirmations (see
 * .github/workflows/verify-unverified-submissions.yml). Idempotent: every write inside the sweep is
 * guarded by the ledger's own safety recomputation, so calling it twice changes nothing twice. */
export type VerifyUnverifiedSubmissionsDependencies = {
  sweep: typeof runSubmissionVerificationSweep;
};

const productionDependencies: VerifyUnverifiedSubmissionsDependencies = {
  sweep: runSubmissionVerificationSweep,
};

type RouteOptions = FastifyPluginOptions & {
  dependencies?: Partial<VerifyUnverifiedSubmissionsDependencies>;
};

function requestedLimit(request: FastifyRequest): number | undefined {
  const raw = (request.query as Record<string, unknown> | undefined)?.limit;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) {
    const value = Number.parseInt(raw, 10);
    return value > 0 ? value : undefined;
  }
  return undefined;
}

async function handle(request: FastifyRequest, reply: FastifyReply, deps: VerifyUnverifiedSubmissionsDependencies) {
  if (!isCronConfigured()) {
    return reply.status(503).send({ error: 'verification sweep not configured (set INTERNAL_CRON_SECRET or CRON_SECRET)' });
  }
  if (!isCronAuthorized(request)) return reply.status(401).send({ error: 'unauthorized' });
  const limit = requestedLimit(request);
  return reply.send(await deps.sweep(limit === undefined ? {} : { limit }));
}

export async function verifyUnverifiedSubmissionsRoutes(fastify: FastifyInstance, options: RouteOptions = {}) {
  const deps = {
    ...productionDependencies,
    sweep: (input: Parameters<typeof runSubmissionVerificationSweep>[0]) => runSubmissionVerificationSweep(input, {
      recoverRetainedAttempt: (packetId) => recoverUnverifiedSubmission(packetId, fastify),
    }),
    ...options.dependencies,
  };
  fastify.get('/internal/verify-unverified-submissions', (request, reply) => handle(request, reply, deps));
  fastify.post('/internal/verify-unverified-submissions', (request, reply) => handle(request, reply, deps));
}
