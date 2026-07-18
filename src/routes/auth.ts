import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { SignJWT } from 'jose';
import { createHash, randomInt } from 'node:crypto';
import { db } from '../db/index';
import { users, email_verification_codes } from '../db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { allowHourly, rateLimitedReply, LIMITS, TRIAL_DAYS } from '../middleware/quota';

const sessionBodySchema = z.object({
  email: z.string().email(),
});

const verifyBodySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
});

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function trialEnd(): Date {
  return new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}
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

// The Resend payload, exported so tests can pin the user-facing copy: this email kept
// saying "Volley" after the rename (R-044), the same stale-name class that already cost
// a store rejection (R-037), so the product name is now asserted instead of trusted.
export function buildVerificationEmail(email: string, code: string) {
  return {
    from: process.env.RESEND_FROM || 'RoleQuick <onboarding@resend.dev>',
    to: [email],
    subject: `${code} is your RoleQuick verification code`,
    html: `<p>Welcome to RoleQuick. Your verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px">${code}</p><p>It expires in 10 minutes. If you didn't request this, you can ignore this email.</p>`,
  };
}

// Sends the 6-digit code via Resend's HTTPS API. Requires RESEND_API_KEY and
// RESEND_FROM (a sender on a domain verified in Resend, e.g. "RoleQuick <hi@yourdomain>").
async function sendVerificationEmail(email: string, code: string): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    // Bound the wait so a hung Resend can't hold the request open indefinitely; the caller
    // treats a throw here as "verification unavailable" and 503s the client to the fallback.
    signal: AbortSignal.timeout(10000),
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildVerificationEmail(email, code)),
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

    // Normalize the email the same way the code flow does (request-code / verify-code both
    // lowercase). users.email is a case-sensitive unique key, so without this an attacker could
    // sidestep the gate below (and legacy accounts) just by changing letter case.
    const email = body.email.toLowerCase();

    const secret = process.env.JWT_SIGNING_SECRET;
    if (!secret) {
      return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
    }

    if (!(await allowHourly(email, 'session', LIMITS.perHour.session))) {
      return rateLimitedReply(reply);
    }

    try {
      // This legacy path does NO proof that the caller owns `email`, so when email verification is
      // available it must not mint a 30-day token AT ALL - not for an account that already exists
      // (anyone who knew the email could read its decrypted profile), and not for a new one either.
      // Minting a token for a not-yet-registered email lets an attacker PRE-REGISTER a victim's
      // address, hold a valid 30-day token, and read the victim's data once they later adopt that
      // account through the code flow (verify-code merges by email onto the SAME user id, without
      // rotating it). So gate EVERY request here and route all signup/login through the emailed-code
      // flow (/auth/request-code + /auth/verify-code), which proves ownership before any token or
      // adoptable account exists.
      //
      // Break-glass: when email verification isn't configured (no RESEND_API_KEY) there is no code
      // flow to fall back to, so we preserve find-or-create rather than brick auth. Once
      // RESEND_API_KEY is set, every account (new AND existing) is gated here. DEPLOY NOTE: the
      // PUBLISHED client must handle this 403 by routing to /auth/request-code + /auth/verify-code,
      // or enabling RESEND blocks ALL new signups on it (not just a new-device login for existing
      // users). An email-provider OUTAGE with the key set is deliberately NOT a break-glass either:
      // better a brief inability to sign in than reopening token-minting-for-anyone.
      const verificationConfigured = !!process.env.RESEND_API_KEY;
      if (verificationConfigured) {
        return reply.status(403).send({ error: 'verification_required' });
      }

      // Break-glass only (no email provider configured): find or create the account by email.
      let user = await db.select().from(users).where(eq(users.email, email)).limit(1);
      if (user.length === 0) {
        const newUserId = uuidv4();
        await db.insert(users).values({ id: newUserId, email, trial_ends_at: trialEnd(), created_at: new Date() });
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
    if (!(await allowHourly(email, 'request-code', LIMITS.perHour.requestCode))) {
      return rateLimitedReply(reply);
    }
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
      // Send failure (e.g. Resend domain not verified yet, provider outage):
      // report verification as unavailable so clients fall back to the legacy
      // signup path instead of dead-ending the user.
      return reply.status(503).send({ error: 'verification_unavailable' });
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
    if (!(await allowHourly(email, 'verify-code', 15))) {
      return rateLimitedReply(reply);
    }

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
        await db.insert(users).values({ id: uuidv4(), email, email_verified: true, trial_ends_at: trialEnd(), created_at: new Date() });
        user = await db.select().from(users).where(eq(users.email, email)).limit(1);
      } else if (!user[0].email_verified) {
        // Adopting a pre-existing UNVERIFIED account onto the same users.id. Any
        // token already out for this account was minted without proof of email
        // ownership (a no-RESEND break-glass window), so bump the token epoch:
        // requireAuth rejects every JWT with iat before session_valid_from. The
        // token we sign below postdates this instant and stays valid.
        await db
          .update(users)
          .set({ email_verified: true, session_valid_from: new Date() })
          .where(eq(users.email, email));
      }

      const token = await signSessionToken(user[0].id, user[0].email);
      return reply.status(200).send({ token });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to verify code' });
    }
  });
}
