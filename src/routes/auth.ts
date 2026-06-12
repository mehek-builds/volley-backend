import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SignJWT } from 'jose';
import { createHash, randomInt } from 'node:crypto';
import { db } from '../db/index';
import { users, email_verification_codes } from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

const sessionBodySchema = z.object({
  email: z.string().email(),
});

const verifyBodySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
});

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

async function signSessionToken(userId: string, email: string): Promise<string> {
  const secret = process.env.JWT_SIGNING_SECRET!;
  const secretBytes = new TextEncoder().encode(secret);
  return new SignJWT({ userId, email })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(secretBytes);
}

// Sends the 6-digit code via Resend's HTTPS API. Requires RESEND_API_KEY and
// RESEND_FROM (a sender on a domain verified in Resend, e.g. "Volley <hi@yourdomain>").
async function sendVerificationEmail(email: string, code: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM || 'Volley <onboarding@resend.dev>',
      to: [email],
      subject: `${code} is your Volley verification code`,
      html: `<p>Welcome to Volley. Your verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`Resend API ${res.status}: ${text}`);
  }
}

export async function authRoutes(fastify: FastifyInstance) {
  // Legacy passwordless session, used by extension v0.1.0 (the build under store
  // review). Kept so installed clients keep working; remove once v0.2.0 (code
  // verification) is the published version.
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
      const token = await signSessionToken(foundUser.id, foundUser.email);

      return reply.status(200).send({ token });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to create session' });
    }
  });

  // Step 1 of verified signup: email a 6-digit code.
  fastify.post('/auth/request-code', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof sessionBodySchema>;
    try {
      body = sessionBodySchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body: email is required and must be valid' });
    }

    if (!process.env.RESEND_API_KEY) {
      // Email sending is not configured yet; clients fall back to /auth/session.
      return reply.status(503).send({ error: 'verification_unavailable' });
    }

    const email = body.email.toLowerCase();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');

    try {
      await db
        .insert(email_verification_codes)
        .values({ email, code_hash: hashCode(code), expires_at: new Date(Date.now() + CODE_TTL_MS), attempts: 0 })
        .onConflictDoUpdate({
          target: email_verification_codes.email,
          set: { code_hash: hashCode(code), expires_at: new Date(Date.now() + CODE_TTL_MS), attempts: 0, created_at: new Date() },
        });

      await sendVerificationEmail(email, code);
      return reply.status(200).send({ sent: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to send verification code' });
    }
  });

  // Step 2: exchange email + code for a session token.
  fastify.post('/auth/verify-code', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof verifyBodySchema>;
    try {
      body = verifyBodySchema.parse(request.body);
    } catch (err) {
      return reply.status(400).send({ error: 'Invalid request body: email and 6-digit code are required' });
    }

    if (!process.env.JWT_SIGNING_SECRET) {
      return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
    }

    const email = body.email.toLowerCase();

    try {
      const rows = await db
        .select()
        .from(email_verification_codes)
        .where(eq(email_verification_codes.email, email))
        .limit(1);
      const record = rows[0];

      if (!record || record.expires_at < new Date()) {
        return reply.status(400).send({ error: 'Code expired or not found. Request a new one.' });
      }
      if (record.attempts >= MAX_ATTEMPTS) {
        return reply.status(429).send({ error: 'Too many attempts. Request a new code.' });
      }

      if (record.code_hash !== hashCode(body.code)) {
        await db
          .update(email_verification_codes)
          .set({ attempts: record.attempts + 1 })
          .where(eq(email_verification_codes.email, email));
        return reply.status(400).send({ error: 'Incorrect code.' });
      }

      // Code is good: burn it, mark the user verified, issue a session.
      await db.delete(email_verification_codes).where(eq(email_verification_codes.email, email));

      let user = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (user.length === 0) {
        await db.insert(users).values({ id: uuidv4(), email, email_verified: true, created_at: new Date() });
        user = await db.select().from(users).where(eq(users.email, email)).limit(1);
      } else if (!user[0].email_verified) {
        await db.update(users).set({ email_verified: true }).where(eq(users.email, email));
      }

      const token = await signSessionToken(user[0].id, user[0].email);
      return reply.status(200).send({ token });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to verify code' });
    }
  });
}
