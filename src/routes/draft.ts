import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { generateDraft } from '../llm/draft';

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

export async function draftRoutes(fastify: FastifyInstance) {
  fastify.post('/draft', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof draftBodySchema>;

    try {
      body = draftBodySchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body' });
    }

    const { contact, role, company, user_profile } = body;

    try {
      const draft = await generateDraft(contact, role, company, user_profile);
      return reply.status(200).send(draft);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to generate draft' });
    }
  });
}
