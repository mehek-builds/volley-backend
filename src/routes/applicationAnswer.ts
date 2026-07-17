import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { readExperienceBank } from '../db/experienceBank';
import { requireAuth } from '../middleware/auth';
import { draftApplicationAnswer } from '../llm/applicationAnswer';

const bodySchema = z.object({
  question: z.string().min(1),
  company: z.string().min(1),
  role: z.string().min(1),
  jd_text: z.string().min(1),
});

// POST /application/answer — drafts one open-ended application answer from the student's own
// experience bank + the JD. Cheap enough (one short Sonnet call, ~1-2K tokens) that it isn't
// metered like /resume/generate; the extension flags every drafted field for review.
export async function applicationAnswerRoutes(fastify: FastifyInstance) {
  fastify.post('/application/answer', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid request body', detail: parsed.error.issues });
    }
    const userId = request.jwtPayload!.userId;
    const { question, company, role, jd_text } = parsed.data;

    // Ordered read, always: see readExperienceBank (R-022). The bank goes into a cached prompt
    // prefix, so an unstable order busts the cache as well as making drafts non-reproducible.
    const bank = await readExperienceBank(userId);
    if (bank.length === 0) {
      return reply.status(400).send({ error: 'No experience bank found - complete onboarding first' });
    }
    const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
    const parsedProfile = profileRows[0]?.parsed_json as { school?: string; grad_year?: number } | undefined;

    try {
      const { answer, warnings } = await draftApplicationAnswer(question, company, role, jd_text, bank, {
        school: parsedProfile?.school,
        grad_year: parsedProfile?.grad_year,
      });
      if (!answer) return reply.status(502).send({ error: 'Empty draft returned' });
      return reply.status(200).send({ answer, warnings });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to draft answer' });
    }
  });
}
