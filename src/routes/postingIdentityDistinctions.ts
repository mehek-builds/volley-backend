import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import {
  duplicateApplicationResponse,
  duplicateApplicationVerdict,
  unidentifiableDuplicateApplicationResponse,
} from '../lib/duplicateApplication';
import {
  appendPostingDistinction,
  POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION,
  PostingDistinctionError,
} from '../lib/postingIdentityDistinction';

const distinctionSchema = z.object({
  relation_id: z.string().uuid(),
  prior_attempt_id: z.string().uuid(),
  candidate_application_id: z.string().uuid(),
  candidate_packet_id: z.string().uuid(),
  candidate_identity_version: z.literal(POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION),
  candidate_identity_digest: z.string().regex(/^[0-9a-f]{64}$/),
  confirmed_distinct_postings: z.literal(true),
}).strict();

function distinctionErrorReply(reply: FastifyReply, error: PostingDistinctionError) {
  const status = error.code === 'invalid_identifier'
    ? 400
    : error.code === 'candidate_not_found'
      ? 404
      : 409;
  return reply.status(status).send({
    error: error.message,
    code: `posting_distinction_${error.code}`,
  });
}

/**
 * Save one applicant-confirmed difference between two exact public postings.
 *
 * This endpoint never retries or submits the candidate. It only appends pair-specific evidence,
 * reloads the server-owned candidate, and reruns the duplicate guard so the applicant can press
 * Send again after reviewing the result.
 */
export async function postingIdentityDistinctionRoutes(fastify: FastifyInstance) {
  fastify.post('/submission-risks/posting-distinctions', { preHandler: requireAuth }, async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    reply.header('Cache-Control', 'private, no-store');
    const body = distinctionSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({
        error: 'Confirm the exact two posting records before saving that they are different.',
        code: 'posting_distinction_invalid_request',
      });
    }

    let appended;
    try {
      appended = await appendPostingDistinction({
        userId: request.jwtPayload!.userId,
        relationId: body.data.relation_id,
        priorAttemptId: body.data.prior_attempt_id,
        candidateApplicationId: body.data.candidate_application_id,
        candidatePacketId: body.data.candidate_packet_id,
        expectedCandidateIdentityVersion: body.data.candidate_identity_version,
        expectedCandidateIdentityDigest: body.data.candidate_identity_digest,
      });
    } catch (error) {
      if (error instanceof PostingDistinctionError) return distinctionErrorReply(reply, error);
      throw error;
    }

    const verdict = await duplicateApplicationVerdict({
      userId: request.jwtPayload!.userId,
      applicationId: appended.candidate.applicationId,
      jobContext: appended.candidate.jobContext,
      portalUrl: appended.candidate.portalUrl,
    });
    const remainingRisk = verdict.kind === 'clear'
      ? null
      : verdict.kind === 'duplicate'
        ? duplicateApplicationResponse(verdict)
        : unidentifiableDuplicateApplicationResponse(verdict);

    return reply.status(200).send({
      relation_id: appended.distinction.relation_id,
      replay: appended.replay,
      candidate_application_id: appended.candidate.applicationId,
      candidate_packet_id: appended.candidate.packetId,
      candidate_identity_version: appended.candidate.identity.version,
      candidate_identity_digest: appended.candidate.identity.digest,
      duplicate_guard: verdict.kind,
      remaining_risk: remainingRisk,
    });
  });
}
