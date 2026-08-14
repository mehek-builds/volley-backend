import { createHash } from 'node:crypto';
import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { candidate_visibility_profiles } from '../db/schema';
import { requireFeature } from '../lib/entitlements';
import { requireAuth } from '../middleware/auth';

export const RECRUITER_VISIBILITY_CONSENT_VERSION = 'recruiter_visibility_v1';
export const RECRUITER_VISIBILITY_DISCLOSURE = [
  'If recruiter visibility becomes available, only the fields you approve may appear to verified recruiters.',
  'Litos will not expose your phone, personal email, answers about race and gender, salary, home address, saved answers, or application history.',
  'You can withdraw consent at any time.',
].join(' ');
export const RECRUITER_VISIBILITY_FUNCTIONAL = false;
const DISCLOSURE_HASH = createHash('sha256').update(RECRUITER_VISIBILITY_DISCLOSURE).digest('hex');

const bodySchema = z.object({
  enabled: z.boolean(),
  consent: z.boolean().optional(),
  consent_version: z.string().optional(),
  approved_fields: z.array(z.enum([
    'role_targets',
    'skills',
    'location_preference',
    'work_authorization_summary',
    'experience_highlights',
    'approved_resume',
  ])).max(6).optional(),
  resume_artifact_id: z.string().uuid().nullable().optional(),
}).strict();

async function projection(userId: string) {
  const [row] = await db.select({
    enabled: candidate_visibility_profiles.enabled,
    updated_at: candidate_visibility_profiles.updated_at,
  }).from(candidate_visibility_profiles).where(eq(candidate_visibility_profiles.user_id, userId)).limit(1);
  return {
    // No recruiter-side product exists yet, so even a stale or manually written row cannot make a
    // profile discoverable. This must change only with the complete verified access layer.
    enabled: RECRUITER_VISIBILITY_FUNCTIONAL && row?.enabled === true,
    functional: RECRUITER_VISIBILITY_FUNCTIONAL,
    updated_at: row?.updated_at.toISOString() ?? null,
    consent_version: RECRUITER_VISIBILITY_CONSENT_VERSION,
  };
}

export async function recruiterVisibilityRoutes(fastify: FastifyInstance) {
  const getHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store');
    return reply.status(200).send(await projection(request.jwtPayload!.userId));
  };

  const putHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid request body', detail: parsed.error.issues });
    const userId = request.jwtPayload!.userId;
    if (!parsed.data.enabled) {
      const now = new Date();
      await db.insert(candidate_visibility_profiles).values({
        user_id: userId,
        enabled: false,
        approved_fields: [],
        indexed_state: 'private',
        withdrawn_at: now,
        updated_at: now,
      }).onConflictDoUpdate({
        target: candidate_visibility_profiles.user_id,
        set: {
          enabled: false,
          approved_fields: [],
          resume_artifact_id: null,
          indexed_state: 'private',
          withdrawn_at: now,
          updated_at: now,
        },
      });
      reply.header('Cache-Control', 'private, no-store');
      return reply.status(200).send(await projection(userId));
    }

    const feature = await requireFeature(userId, 'recruiter_visibility', 'recruiter_visibility_enable');
    if (!feature.allowed) return reply.status(402).send(feature.denial);
    if (parsed.data.consent !== true || parsed.data.consent_version !== RECRUITER_VISIBILITY_CONSENT_VERSION) {
      return reply.status(400).send({
        error: 'Review and accept the current recruiter visibility disclosure.',
        code: 'consent_required',
        consent_version: RECRUITER_VISIBILITY_CONSENT_VERSION,
        disclosure_hash: DISCLOSURE_HASH,
      });
    }
    // Enabling remains closed until verified recruiter access, moderation, contact relay, abuse
    // reporting, and audit logging are all live. Storing consent without a functional product
    // would create a misleading paid toggle and an unsafe future activation path.
    return reply.status(409).send({
      error: 'Recruiter visibility is not available yet.',
      code: 'feature_not_functional',
      enabled: false,
      functional: false,
    });
  };

  fastify.get('/account/recruiter-visibility', { preHandler: requireAuth }, getHandler);
  fastify.put('/account/recruiter-visibility', { preHandler: requireAuth }, putHandler);
  // Compatibility aliases follow the canonical profile contract in the end-to-end specification.
  fastify.get('/profile/recruiter-visibility', { preHandler: requireAuth }, getHandler);
  fastify.put('/profile/recruiter-visibility', { preHandler: requireAuth }, putHandler);
}
