import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/index';
import { profiles } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { parseResumeWithClaude } from '../llm/parse';
import pdfParse from 'pdf-parse';
import { MultipartFile } from '@fastify/multipart';

export async function profileRoutes(fastify: FastifyInstance) {
  // POST /profile - upload resume + parse
  fastify.post('/profile', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let resumeBuffer: Buffer | null = null;
    let voice_pref: string | undefined;

    try {
      const parts = request.parts();
      for await (const part of parts) {
        if (part.type === 'file' && part.fieldname === 'resume') {
          const chunks: Buffer[] = [];
          for await (const chunk of part.file) {
            chunks.push(chunk);
          }
          resumeBuffer = Buffer.concat(chunks);
        } else if (part.type === 'field' && part.fieldname === 'voice_pref') {
          voice_pref = part.value as string;
        }
      }
    } catch (err) {
      fastify.log.error(err);
      return reply.status(400).send({ error: 'Failed to parse multipart form data' });
    }

    if (!resumeBuffer || resumeBuffer.length === 0) {
      return reply.status(400).send({ error: 'resume file is required' });
    }

    let resumeText: string;
    try {
      const parsed = await pdfParse(resumeBuffer);
      resumeText = parsed.text;
    } catch (err) {
      fastify.log.error(err);
      return reply.status(400).send({ error: 'Failed to parse PDF - ensure the file is a valid PDF' });
    }

    if (!resumeText || resumeText.trim().length < 50) {
      return reply.status(400).send({ error: 'PDF appears to be empty or could not be parsed' });
    }

    let parsedProfile;
    try {
      parsedProfile = await parseResumeWithClaude(resumeText);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to parse resume with AI' });
    }

    const resumeObjectKey = `users/${userId}/resume.pdf`;

    try {
      await db
        .insert(profiles)
        .values({
          user_id: userId,
          parsed_json: parsedProfile,
          resume_object_key: resumeObjectKey,
          voice_pref: voice_pref ?? null,
          updated_at: new Date(),
        })
        .onConflictDoUpdate({
          target: profiles.user_id,
          set: {
            parsed_json: parsedProfile,
            resume_object_key: resumeObjectKey,
            voice_pref: voice_pref ?? null,
            updated_at: new Date(),
          },
        });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to save profile to database' });
    }

    return reply.status(200).send(parsedProfile);
  });

  // GET /profile - retrieve user profile
  fastify.get('/profile', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    try {
      const profile = await db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1);

      if (profile.length === 0) {
        return reply.status(404).send({ error: 'Profile not found - upload a resume first' });
      }

      return reply.status(200).send(profile[0].parsed_json);
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to retrieve profile' });
    }
  });
}
