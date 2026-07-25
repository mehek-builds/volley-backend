import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { readExperienceBank } from '../db/experienceBank';
import { requireAuth } from '../middleware/auth';
import { draftApplicationAnswer } from '../llm/applicationAnswer';
import { declaredSkillsList } from './profile';
import { isBillingOrAuthFailure, LLM_BILLING_LOG, LLM_BILLING_PAYLOAD } from './resume';

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
    // The declared skills list (profiles.skills, R-015's authority) rides along for the R-042
    // ranking grounding: a "rank these languages" ask may rank only the intersection of the
    // question's own items and this list. [] means "never declared" and disables the check.
    const declaredSkills = declaredSkillsList(profileRows[0]?.skills);

    try {
      const { answer, warnings } = await draftApplicationAnswer(question, company, role, jd_text, bank, {
        school: parsedProfile?.school,
        grad_year: parsedProfile?.grad_year,
      }, declaredSkills);
      if (!answer) return reply.status(502).send({ error: 'Empty draft returned' });
      return reply.status(200).send({ answer, warnings, grounded: warnings.length === 0 });
    } catch (err) {
      fastify.log.error(err);
      // Same classification as /resume/generate (R-012): the essay drafter dies on the exact
      // same exhausted account, and its generic 500 hid the cause just as thoroughly - three
      // required essays came back empty on a live Perplexity fill with nothing naming billing.
      if (isBillingOrAuthFailure(err)) {
        fastify.log.error({ status: (err as { status?: number })?.status, userId }, LLM_BILLING_LOG);
        return reply.status(503).send(LLM_BILLING_PAYLOAD);
      }
      return reply.status(500).send({ error: 'Failed to draft answer' });
    }
  });
}
