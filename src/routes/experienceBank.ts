import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { experience_bank } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { readExperienceBank } from '../db/experienceBank';

const entrySchema = z.object({
  id: z.string().uuid().optional(), // present on update, absent on create
  type: z.enum(['job', 'project']),
  org: z.string().min(1),
  title: z.string().optional(),
  date_range: z.string().optional(),
  bullet_variants: z.array(z.string()).min(1),
  tags: z.array(z.string()).optional(),
});

// Replaces the whole bank in one call: simplest contract for the onboarding flow
// (bulk-seed from a resume parse) and for later edits (student adds/removes entries).
const putBodySchema = z.object({
  entries: z.array(entrySchema),
});

export async function experienceBankRoutes(fastify: FastifyInstance) {
  fastify.get('/profile/experience-bank', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const rows = await readExperienceBank(userId);
    return reply.status(200).send({ entries: rows });
  });

  fastify.put('/profile/experience-bank', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof putBodySchema>;
    try {
      body = putBodySchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    try {
      await db.transaction(async (tx) => {
        await tx.delete(experience_bank).where(eq(experience_bank.user_id, userId));
        if (body.entries.length > 0) {
          await tx.insert(experience_bank).values(
            body.entries.map((e) => ({
              user_id: userId,
              type: e.type,
              org: e.org,
              title: e.title ?? null,
              date_range: e.date_range ?? null,
              bullet_variants: e.bullet_variants,
              tags: e.tags ?? [],
            })),
          );
        }
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to save experience bank' });
    }

    const rows = await readExperienceBank(userId);
    return reply.status(200).send({ entries: rows });
  });
}
