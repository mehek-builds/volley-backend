import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import {
  createEmailConnectionLink,
  disconnectEmailProvider,
  getEmailConnectionStates,
  isComposioConfigured,
} from '../lib/composioConnections';

const providerParams = z.object({ provider: z.enum(['gmail', 'outlook']) });

function unavailable(reply: FastifyReply) {
  return reply.status(503).send({ error: 'Email connections are not configured yet' });
}

export async function emailConnectionRoutes(fastify: FastifyInstance) {
  fastify.get('/email-connections', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isComposioConfigured()) {
      return reply.send({ configured: false, connections: [] });
    }
    const connections = await getEmailConnectionStates(request.jwtPayload!.userId);
    return reply.send({ configured: true, connections });
  });

  fastify.post('/email-connections/:provider/connect', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isComposioConfigured()) return unavailable(reply);
    const parsed = providerParams.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Unsupported email provider' });
    const redirect_url = await createEmailConnectionLink(request.jwtPayload!.userId, parsed.data.provider);
    return reply.status(201).send({ redirect_url });
  });

  fastify.delete('/email-connections/:provider', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isComposioConfigured()) return unavailable(reply);
    const parsed = providerParams.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Unsupported email provider' });
    const removed = await disconnectEmailProvider(request.jwtPayload!.userId, parsed.data.provider);
    return reply.send({ disconnected: true, removed });
  });
}
