import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import {
  managedReceivingCanaryHttpStatus,
  sendManagedReceivingCanary,
} from '../lib/managedReceivingCanary';

async function handleCanary(request: FastifyRequest, reply: FastifyReply, fastify: FastifyInstance) {
  if (!isCronConfigured()) {
    return reply.status(503).send({
      error: 'managed receiving canary not configured (set INTERNAL_CRON_SECRET or CRON_SECRET)',
    });
  }
  if (!isCronAuthorized(request)) {
    return reply.status(401).send({ error: 'unauthorized' });
  }

  const outcome = await sendManagedReceivingCanary();

  /* Loud, because the consequence is delayed and arrives somewhere else.
   *
   * A failed canary breaks nothing today - the existing proof carries the route for up to the
   * refresh lead. What it does is guarantee that packet audits start refusing later, with a reason
   * that names the email route and gives no hint that a send failed days earlier. */
  if (outcome.reason === 'send_failed' || outcome.reason === 'sender_not_configured') {
    fastify.log.error(
      { reason: outcome.reason, detail: outcome.detail },
      'managed receiving canary did NOT send: the receiving proof will expire and packet audits will then refuse every submission',
    );
  }

  return reply
    .status(managedReceivingCanaryHttpStatus(outcome.reason))
    .send({ checked_at: new Date().toISOString(), ...outcome });
}

export async function managedReceivingCanaryRoutes(fastify: FastifyInstance) {
  // POST for manual/tooling triggers (curl + x-internal-secret); GET for Vercel Cron, which only
  // issues GET requests and authenticates via the Authorization header. Same pairing as
  // /internal/adapter-health-check.
  fastify.post('/internal/managed-receiving-canary', (request, reply) => handleCanary(request, reply, fastify));
  fastify.get('/internal/managed-receiving-canary', (request, reply) => handleCanary(request, reply, fastify));
}
