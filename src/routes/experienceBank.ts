import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { experience_bank } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { readExperienceBank } from '../db/experienceBank';

const entrySchema = z.object({
  id: z.string().uuid().optional(), // present on update, absent on create
  type: z.enum(['job', 'project', 'leadership']),
  org: z.string().min(1),
  title: z.string().optional(),
  date_range: z.string().optional(),
  /* THIS ROUTE DELETES THE WHOLE BANK AND REWRITES IT, so any field missing from this schema is
     not merely un-settable, it is ERASED on every save. location was absent here while being
     written by the two other bank writers, so a single trip through the work-history editor
     silently wiped every city the parser had read. Measured on a live account: 17 rows, all
     recreated in one batch, all locations gone.

     The rule for anyone adding a bank field: there are THREE writers, and it has to be in all of
     them. bankEntriesFrom (insert on upload), planBankReconciliation (enrich existing rows), and
     this. Two out of three is a field that looks like it works and quietly disappears. */
  location: z.string().optional(),
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
              location: e.location ?? null,
              bullet_variants: e.bullet_variants,
              tags: e.tags ?? [],
            })),
          );
        }
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Could not save your work history' });
    }

    const rows = await readExperienceBank(userId);
    return reply.status(200).send({ entries: rows });
  });
}
