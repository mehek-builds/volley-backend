import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { applications, generated_resumes } from '../db/schema';
import { apiBaseFor } from '../lib/apiBase';
import {
  canonicalStoredCoverLetter,
  deleteCanonicalCoverLetters,
  generateCanonicalCoverLetter,
  listCanonicalStoredCoverLetters,
  reuseCanonicalCoverLetter,
  saveCanonicalCoverLetter,
  uploadCanonicalCoverLetter,
} from '../lib/canonicalCoverLetterService';
import { readApplicationReview } from '../lib/applicationReview';
import { mintDownloadToken } from '../lib/resumeAccess';
import { requireAuth } from '../middleware/auth';
import {
  commitEntitledUsage,
  entitledUsageRequestHash,
  releaseEntitledUsage,
  reserveEntitledUsage,
} from '../lib/entitlements';

const paramsSchema = z.object({ id: z.string().uuid() });
const updateSchema = z.object({ body: z.string().trim().min(1).max(20_000) });
const generationSchema = z.object({
  operation_id: z.string().uuid().optional(),
  jd_text: z.string().trim().min(1).max(200_000).optional(),
});
const reuseSchema = z.object({ artifact_id: z.string().uuid() }).strict();

export type OwnedCoverLetterTarget =
  | {
    kind: 'found';
    application: typeof applications.$inferSelect;
    row: typeof generated_resumes.$inferSelect | null;
    canonicalApplicationId: string;
  }
  | { kind: 'not_found' };

export async function resolveOwnedCoverLetterTarget(userId: string, id: string): Promise<OwnedCoverLetterTarget> {
  const [canonical] = await db.select().from(applications).where(and(
    eq(applications.id, id),
    eq(applications.user_id, userId),
  )).limit(1);
  if (canonical) {
    const row = canonical.legacy_generated_resume_id
      ? (await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, canonical.legacy_generated_resume_id),
        eq(generated_resumes.user_id, userId),
      )).limit(1))[0] ?? null
      : null;
    return { kind: 'found', application: canonical, row, canonicalApplicationId: canonical.id };
  }
  const [row] = await db.select().from(generated_resumes).where(and(
    eq(generated_resumes.id, id),
    eq(generated_resumes.user_id, userId),
  )).limit(1);
  if (!row) return { kind: 'not_found' };
  const [linkedCanonical] = await db.select().from(applications).where(and(
    eq(applications.user_id, userId),
    eq(applications.legacy_generated_resume_id, row.id),
  )).limit(1);
  return linkedCanonical
    ? { kind: 'found', application: linkedCanonical, row, canonicalApplicationId: linkedCanonical.id }
    : { kind: 'not_found' };
}

async function ownedApplication(request: FastifyRequest, reply: FastifyReply) {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid application id', code: 'invalid_request' });
    return null;
  }
  const target = await resolveOwnedCoverLetterTarget(request.jwtPayload!.userId, parsed.data.id);
  if (target.kind === 'not_found') {
    reply.status(404).send({ error: 'Application not found', code: 'application_not_found' });
    return null;
  }
  return target;
}

function responseFor(
  request: FastifyRequest,
  target: Extract<OwnedCoverLetterTarget, { kind: 'found' }>,
  result: { cover_letter: { object_key: string }; blob_url?: string },
) {
  return {
    application_id: target.canonicalApplicationId,
    packet_id: target.row?.id ?? null,
    cover_letter: result.cover_letter,
    download_url: `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(
      target.application.user_id,
      result.cover_letter.object_key,
      { blobUrl: result.blob_url },
    )}`,
  };
}

function generationError(reply: FastifyReply, error: unknown) {
  const detail = error as Error & { issues?: string[] };
  return reply.status(detail.issues ? 422 : 409).send({ error: detail.message, issues: detail.issues });
}

function refreshedCoverLetterReplay(request: FastifyRequest, userId: string, body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const response = body as Record<string, unknown>;
  const coverLetter = response.cover_letter;
  if (!coverLetter || typeof coverLetter !== 'object' || Array.isArray(coverLetter)) return body;
  const objectKey = (coverLetter as Record<string, unknown>).object_key;
  if (typeof objectKey !== 'string' || objectKey.length === 0) return body;
  return {
    ...response,
    download_url: `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(userId, objectKey)}`,
  };
}

function packetJdText(row: typeof generated_resumes.$inferSelect | null): string | null {
  if (!row) return null;
  return readApplicationReview(row.spec)?.jd_text ?? null;
}

export async function coverLetterRoutes(fastify: FastifyInstance) {
  fastify.get('/cover-letters', { preHandler: requireAuth }, async (request, reply) => {
    const userId = request.jwtPayload!.userId;
    const stored = await listCanonicalStoredCoverLetters(userId);
    const coverLetters = await Promise.all(stored.map(async (entry) => {
      const row = entry.application.legacy_generated_resume_id
        ? (await db.select().from(generated_resumes).where(and(
          eq(generated_resumes.id, entry.application.legacy_generated_resume_id),
          eq(generated_resumes.user_id, userId),
        )).limit(1))[0] ?? null
        : null;
      return responseFor(request, {
        kind: 'found',
        application: entry.application,
        row,
        canonicalApplicationId: entry.application.id,
      }, {
        cover_letter: entry.cover_letter,
        blob_url: entry.row.rendered_blob_url ?? undefined,
      });
    }));
    return reply.header('Cache-Control', 'private, no-store').send({ cover_letters: coverLetters });
  });

  fastify.get('/applications/:id/cover-letter', { preHandler: requireAuth }, async (request, reply) => {
    const target = await ownedApplication(request, reply);
    if (!target) return;
    const stored = await canonicalStoredCoverLetter(target.application.user_id, target.application.id);
    if (!stored) return reply.status(404).send({ error: 'Cover letter not found', code: 'cover_letter_not_found' });
    return reply.header('Cache-Control', 'private, no-store').send(responseFor(request, target, {
      cover_letter: stored.cover_letter,
      blob_url: stored.row.rendered_blob_url ?? undefined,
    }));
  });

  fastify.post('/applications/:id/cover-letter', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = generationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid cover letter request' });
    const target = await ownedApplication(request, reply);
    if (!target) return;
    const jdText = parsed.data.jd_text ?? packetJdText(target.row);
    if (!jdText) return reply.status(400).send({
      error: 'A job description is required to generate this cover letter.',
      code: 'jd_text_required',
    });
    const operationId = parsed.data.operation_id ?? randomUUID();
    const requestHash = entitledUsageRequestHash('cover_letter', {
      application_id: target.canonicalApplicationId,
      company: target.application.company_name,
      role: target.application.role,
      jd_text: jdText,
    });
    let reservation: Awaited<ReturnType<typeof reserveEntitledUsage>>;
    try {
      reservation = await reserveEntitledUsage({
        userId: target.application.user_id,
        kind: 'cover_letter',
        idempotencyKey: operationId,
        requestHash,
        trigger: 'cover_letter_generate',
        applicationId: target.canonicalApplicationId,
      });
    } catch (error) {
      const candidate = error as { statusCode?: number; code?: string; message?: string };
      return reply.status(candidate.statusCode ?? 409).send({
        error: candidate.message ?? 'Cover letter operation is already in progress.',
        code: candidate.code ?? 'cover_letter_operation_conflict',
      });
    }
    if (!reservation.allowed) return reply.status(402).send(reservation.denial);
    if (reservation.replay) {
      return reply.status(reservation.replay.statusCode).send(
        refreshedCoverLetterReplay(request, target.application.user_id, reservation.replay.body),
      );
    }
    try {
      const result = await generateCanonicalCoverLetter({ application: target.application, jdText });
      const response = responseFor(request, target, result);
      await commitEntitledUsage(reservation.reservationId, 1, new Date(), { statusCode: 200, body: response });
      return reply.send(response);
    } catch (error) {
      await releaseEntitledUsage(reservation.reservationId);
      return generationError(reply, error);
    }
  });

  // Manual create and edit are Free. This route performs no model call and no entitlement check.
  fastify.patch('/applications/:id/cover-letter', { preHandler: requireAuth }, async (request, reply) => {
    const target = await ownedApplication(request, reply);
    if (!target) return;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid cover letter' });
    try {
      return reply.send(responseFor(
        request,
        target,
        await saveCanonicalCoverLetter(target.application, parsed.data.body),
      ));
    } catch (error) {
      return generationError(reply, error);
    }
  });

  fastify.post('/applications/:id/cover-letter/reuse', { preHandler: requireAuth }, async (request, reply) => {
    const target = await ownedApplication(request, reply);
    if (!target) return;
    const parsed = reuseSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid cover letter reuse request', code: 'invalid_request' });
    const reused = await reuseCanonicalCoverLetter({
      userId: target.application.user_id,
      applicationId: target.application.id,
      artifactId: parsed.data.artifact_id,
    });
    if (!reused) return reply.status(404).send({ error: 'Cover letter artifact not found', code: 'cover_letter_not_found' });
    return reply.send(responseFor(request, target, {
      cover_letter: reused.cover_letter,
      blob_url: reused.row.rendered_blob_url ?? undefined,
    }));
  });

  // User uploads are kept as user documents until explicit removal or account deletion.
  fastify.post('/applications/:id/cover-letter/upload', { preHandler: requireAuth }, async (request, reply) => {
    const target = await ownedApplication(request, reply);
    if (!target) return;
    const file = await request.file({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
    if (!file) return reply.status(400).send({ error: 'Cover letter file is required', code: 'file_required' });
    const allowed = new Set(['application/pdf', 'text/plain']);
    if (!allowed.has(file.mimetype)) return reply.status(415).send({
      error: 'Upload a PDF or plain-text cover letter.',
      code: 'unsupported_file_type',
    });
    const bytes = await file.toBuffer();
    if (bytes.length === 0) return reply.status(400).send({ error: 'Cover letter file is empty', code: 'empty_file' });
    try {
      return reply.status(201).send(responseFor(request, target, await uploadCanonicalCoverLetter({
        application: target.application,
        bytes,
        fileName: file.filename,
        contentType: file.mimetype,
      })));
    } catch (error) {
      return generationError(reply, error);
    }
  });

  fastify.delete('/applications/:id/cover-letter', { preHandler: requireAuth }, async (request, reply) => {
    const target = await ownedApplication(request, reply);
    if (!target) return;
    await deleteCanonicalCoverLetters({
      userId: target.application.user_id,
      applicationId: target.application.id,
      legacyPacketId: target.row?.id,
    });
    return reply.status(204).send();
  });
}
