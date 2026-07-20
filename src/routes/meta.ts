import type { FastifyInstance } from 'fastify';
import { publicProductConfig } from '../lib/product';

export async function metaRoutes(fastify: FastifyInstance) {
  fastify.get('/v1/meta', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
    return reply.status(200).send(publicProductConfig());
  });
}
