import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from 'fastify';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import { reconcileSubmissionConfirmations } from '../lib/applicationEmail';

export type SubmissionConfirmationReconcilerDependencies = {
  reconcile: typeof reconcileSubmissionConfirmations;
};

type RouteOptions = FastifyPluginOptions & {
  dependencies?: Partial<SubmissionConfirmationReconcilerDependencies>;
};

const productionDependencies: SubmissionConfirmationReconcilerDependencies = {
  reconcile: reconcileSubmissionConfirmations,
};

/* Wires the already-built, already-tested reconciler to a schedule.
 *
 * reconcileSubmissionConfirmations has existed since the employer-email pipeline shipped, is
 * read-only about mail (it re-reads stored confirmations and resolves packets; it sends nothing),
 * and was deliberately left unwired pending a decision on the tradeoff. The decision: a managed
 * send that presses Submit and cannot read the confirmation page back (breezy.hr, workable.com,
 * and any future ATS a DOM reader has no dedicated arm for) must not depend on a person opening an
 * inbox to learn whether it went through. This route is that decision, and it only ever resolves a
 * receipt Litos ALREADY holds - the fix for a receipt that never arrives at all is a different
 * project (a DOM-confirmation arm per ATS, or a retry), not this one.
 */
async function handleReconcile(
  request: FastifyRequest,
  reply: FastifyReply,
  fastify: FastifyInstance,
  dependencies: SubmissionConfirmationReconcilerDependencies,
) {
  if (!isCronConfigured()) {
    return reply.status(503).send({
      error: 'submission confirmation reconciler not configured (set INTERNAL_CRON_SECRET or CRON_SECRET)',
    });
  }
  if (!isCronAuthorized(request)) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  try {
    const outcome = await dependencies.reconcile({});
    fastify.log.info(outcome, 'submission confirmation reconciler pass complete');
    return reply.status(200).send({ checked_at: new Date().toISOString(), ...outcome });
  } catch (err) {
    fastify.log.error(err, 'submission confirmation reconciler pass failed');
    return reply.status(500).send({ error: 'reconciliation failed' });
  }
}

export async function submissionConfirmationReconcilerRoutes(
  fastify: FastifyInstance,
  options: RouteOptions = {},
) {
  const dependencies = { ...productionDependencies, ...options.dependencies };
  // GET for Vercel Cron (it only issues GETs); POST for manual/tooling triggers. Same pairing as
  // /internal/resume-retention-sweep and /internal/managed-receiving-canary.
  fastify.get('/internal/submission-confirmation-reconciler', (request, reply) =>
    handleReconcile(request, reply, fastify, dependencies));
  fastify.post('/internal/submission-confirmation-reconciler', (request, reply) =>
    handleReconcile(request, reply, fastify, dependencies));
}
