import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SignJWT } from 'jose';
import { db } from '../db/index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const sessionBodySchema = z.object({
  email: z.string().email(),
});

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/auth/session', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof sessionBodySchema>;

    try {
      body = sessionBodySchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body: email is required and must be valid' });
    }

    const { email } = body;

    const secret = process.env.JWT_SIGNING_SECRET;
    if (!secret) {
      return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
    }

    try {
      // Find or create user
      let user = await db.select().from(users).where(eq(users.email, email)).limit(1);

      if (user.length === 0) {
        const newUserId = uuidv4();
        await db.insert(users).values({ id: newUserId, email, created_at: new Date() });
        user = await db.select().from(users).where(eq(users.email, email)).limit(1);
      }

      const foundUser = user[0];

      // Sign JWT with 30-day expiry
      const secretBytes = new TextEncoder().encode(secret);
      const token = await new SignJWT({ userId: foundUser.id, email: foundUser.email })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('30d')
        .sign(secretBytes);

      return reply.status(200).send({ token });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to create session' });
    }
  });
}
