import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import { apiBaseFor } from '../lib/apiBase';
import { generateStoredCoverLetter, saveStoredCoverLetter } from '../lib/coverLetterService';
import { mintDownloadToken } from '../lib/resumeAccess';
import { requireAuth } from '../middleware/auth';

const paramsSchema = z.object({ id: z.string().uuid() });
const updateSchema = z.object({ body: z.string().trim().min(100).max(10_000) });

async function ownedApplication(request: FastifyRequest, reply: FastifyReply) {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid application id' });
    return null;
  }
  const rows = await db.select().from(generated_resumes).where(and(
    eq(generated_resumes.id, parsed.data.id),
    eq(generated_resumes.user_id, request.jwtPayload!.userId),
  )).limit(1);
  if (!rows[0]) {
    reply.status(404).send({ error: 'Application not found' });
    return null;
  }
  return rows[0];
}

function responseFor(
  request: FastifyRequest,
  row: typeof generated_resumes.$inferSelect,
  result: Awaited<ReturnType<typeof generateStoredCoverLetter>>,
) {
  return {
    cover_letter: result.cover_letter,
    download_url: `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(
      row.user_id,
      result.cover_letter.object_key,
      { blobUrl: result.blob_url },
    )}`,
  };
}

function generationError(reply: FastifyReply, error: unknown) {
  const detail = error as Error & { issues?: string[] };
  return reply.status(detail.issues ? 422 : 409).send({ error: detail.message, issues: detail.issues });
}

export async function coverLetterRoutes(fastify: FastifyInstance) {
  fastify.post('/applications/:id/cover-letter', { preHandler: requireAuth }, async (request, reply) => {
    const row = await ownedApplication(request, reply);
    if (!row) return;
    try {
      return reply.send(responseFor(request, row, await generateStoredCoverLetter(row, true)));
    } catch (error) {
      return generationError(reply, error);
    }
  });

  fastify.patch('/applications/:id/cover-letter', { preHandler: requireAuth }, async (request, reply) => {
    const row = await ownedApplication(request, reply);
    if (!row) return;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid cover letter' });
    try {
      return reply.send(responseFor(request, row, await saveStoredCoverLetter(row, parsed.data.body)));
    } catch (error) {
      return generationError(reply, error);
    }
  });
}
