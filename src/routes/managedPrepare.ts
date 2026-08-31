import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import {
  ManagedPrepareError,
  prepareManagedApplication,
  type ManagedPrepareDependencies,
  type ManagedPrepareResult,
} from '../lib/managedPrepare';

const managedPrepareBodySchema = z.object({
  job_id: z.string().uuid(),
  resume_source: z.literal('main_resume'),
}).strict();

export type ManagedPrepareRouteOptions = {
  prepare?: (input: { userId: string; jobId: string }) => Promise<ManagedPrepareResult>;
  dependencies?: Partial<ManagedPrepareDependencies>;
};

export async function managedPrepareRoutes(
  fastify: FastifyInstance,
  options: ManagedPrepareRouteOptions = {},
) {
  fastify.post('/applications/managed-prepare', { preHandler: requireAuth }, async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const parsed = managedPrepareBodySchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Send exactly one job_id and resume_source main_resume.',
        code: 'managed_prepare_request_invalid',
      });
    }
    try {
      const prepare = options.prepare
        ?? ((input: { userId: string; jobId: string }) => prepareManagedApplication(input, options.dependencies));
      const result = await prepare({
        userId: request.jwtPayload!.userId,
        jobId: parsed.data.job_id,
      });
      return reply.header('Cache-Control', 'private, no-store').status(200).send(result);
    } catch (error) {
      if (error instanceof ManagedPrepareError) {
        return reply.status(error.statusCode).send({ error: error.message, code: error.code });
      }
      request.log.error({ err: error }, 'managed main resume preparation failed');
      return reply.status(500).send({
        error: 'Litos could not prepare this application. Nothing was opened or sent.',
        code: 'managed_prepare_failed',
      });
    }
  });
}
