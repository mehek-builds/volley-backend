import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { allowHourly, getEntitlements, getCount, bumpCounter, monthPeriod, quotaExceededPayload, rateLimitedReply, LIMITS } from '../middleware/quota';
import { generateDraft } from '../llm/draft';
import { declaredSkillsList } from './profile';

const draftBodySchema = z.object({
  contact: z.object({
    full_name: z.string().min(1),
    title: z.string(),
    persona: z.string(),
    company: z.string(),
    school_match: z.boolean(),
    linkedin_url: z.string().optional(),
  }),
  role: z.string().min(1),
  company: z.string().min(1),
  user_profile: z.object({
    experience: z.array(
      z.object({
        company: z.string(),
        title: z.string(),
        start: z.string(),
        end: z.string(),
        description: z.string(),
      })
    ),
    skills: z.array(z.string()),
    school: z.string(),
    grad_year: z.number(),
  }),
});

// A non-empty DECLARED skills list replaces whatever the client sent (R-027). /draft's
// user_profile arrives from the client, which historically built it from GET /profile's bare
// parsed_json spread - so outreach drafts ran on resume-INFERRED skills even after R-015 made
// profiles.skills authoritative for the resume. Fixing GET /profile helps a current client, but
// the server cannot know the caller rebuilt its cache, so the override is enforced here too:
// the declared list reaches drafting no matter what the extension has stored. An empty declared
// list means "never declared" and leaves the client's skills alone (same NULL-vs-[] semantics
// as the resume path).
export function applyDeclaredSkills<T extends { skills: string[] }>(userProfile: T, declared: string[]): T {
  return declared.length > 0 ? { ...userProfile, skills: declared } : userProfile;
}

export async function draftRoutes(fastify: FastifyInstance) {
  fastify.post('/draft', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof draftBodySchema>;

    try {
      body = draftBodySchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const { contact, role, company, user_profile } = body;

    const userId = request.jwtPayload!.userId;
    if (!(await allowHourly(userId, 'draft', LIMITS.perHour.draft))) {
      return rateLimitedReply(reply);
    }
    const ent = await getEntitlements(userId);
    const usedDrafts = await getCount(userId, monthPeriod(), 'drafts');
    if (usedDrafts >= ent.monthlyDrafts) {
      return reply.status(402).send(quotaExceededPayload(ent, usedDrafts, 'drafts'));
    }

    // Read the declared list server-side rather than trusting the body. Non-fatal on a read
    // failure, but LOUD: silently drafting from client-supplied skills is exactly the half-applied
    // R-015 state this override exists to end, so a fallback here must be visible in logs.
    let declared: string[] = [];
    try {
      const profileRows = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);
      declared = declaredSkillsList(profileRows[0]?.skills);
    } catch (err) {
      fastify.log.error({ err, userId }, 'could not read declared skills for outreach draft; falling back to client-supplied skills (R-027 override skipped)');
    }

    try {
      const draft = await generateDraft(contact, role, company, applyDeclaredSkills(user_profile, declared));
      await bumpCounter(userId, monthPeriod(), 'drafts');
      return reply.status(200).send(draft);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to generate draft' });
    }
  });
}
