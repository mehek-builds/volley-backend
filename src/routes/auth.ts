import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload as JoseJWTPayload } from 'jose';
import { createHash, randomInt } from 'node:crypto';
import { db } from '../db/index';
import { users, email_verification_codes } from '../db/schema';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { allowHourly, rateLimitedReply, LIMITS, TRIAL_DAYS } from '../middleware/quota';
import { PRODUCT_LINKS, PRODUCT_NAME } from '../lib/product';

const sessionBodySchema = z.object({
  email: z.string().email(),
});

const verifyBodySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
});

const googleBodySchema = z.object({
  credential: z.string().min(1).max(10_000),
});

const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'] as const;
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export type GoogleIdentity = {
  subject: string;
  email: string;
  hostedDomain: string | null;
};

export function googleIdentityFromClaims(payload: JoseJWTPayload): GoogleIdentity | null {
  if (
    typeof payload.sub !== 'string' ||
    payload.sub.length === 0 ||
    typeof payload.email !== 'string' ||
    !z.string().email().safeParse(payload.email).success ||
    payload.email_verified !== true
  ) {
    return null;
  }

  return {
    subject: payload.sub,
    email: payload.email.toLowerCase(),
    hostedDomain: typeof payload.hd === 'string' && payload.hd.length > 0 ? payload.hd : null,
  };
}

export function googleIsAuthoritativeForEmail(identity: GoogleIdentity): boolean {
  if (identity.email.endsWith('@gmail.com')) return true;
  return identity.hostedDomain !== null &&
    identity.email.endsWith(`@${identity.hostedDomain.toLowerCase()}`);
}

export async function verifyGoogleCredential(
  credential: string,
  clientId: string,
): Promise<GoogleIdentity | null> {
  try {
    const { payload } = await jwtVerify(credential, googleKeys, {
      audience: clientId,
      issuer: [...GOOGLE_ISSUERS],
    });
    return googleIdentityFromClaims(payload);
  } catch {
    return null;
  }
}

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function trialEnd(now = new Date()): Date {
  return new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}
const MAX_ATTEMPTS = 5;

export function googleRegistrationValues(
  identity: GoogleIdentity,
  now = new Date(),
  id = uuidv4(),
) {
  return {
    id,
    email: identity.email,
    email_verified: true,
    google_subject: identity.subject,
    plan: 'free',
    trial_ends_at: trialEnd(now),
    created_at: now,
    onboarding_completed_at: null,
  };
}

type VerificationRecord = {
  code_hash: string;
  expires_at: Date;
  attempts: number;
};

type VerificationFailure = {
  status: 400 | 429;
  error: string;
  incrementAttempts: boolean;
};

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

export function verificationFailure(
  record: VerificationRecord | undefined,
  submittedCode: string,
  now = new Date(),
): VerificationFailure | null {
  if (!record || record.expires_at < now) {
    return {
      status: 400,
      error: 'Code expired or not found. Request a new one.',
      incrementAttempts: false,
    };
  }
  if (record.attempts >= MAX_ATTEMPTS) {
    return {
      status: 429,
      error: 'Too many attempts. Request a new code.',
      incrementAttempts: false,
    };
  }
  if (record.code_hash !== hashCode(submittedCode)) {
    return { status: 400, error: 'Incorrect code.', incrementAttempts: true };
  }
  return null;
}

function verificationSender(): string {
  const configured = process.env.RESEND_FROM?.trim() || 'onboarding@resend.dev';
  const openBracket = configured.lastIndexOf('<');
  const mailbox =
    openBracket >= 0 && configured.endsWith('>')
      ? configured.slice(openBracket + 1, -1).trim()
      : configured;

  if (!z.string().email().safeParse(mailbox).success) {
    throw new Error('RESEND_FROM must contain a valid email address');
  }

  return `${PRODUCT_NAME} <${mailbox}>`;
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

export function buildVerificationEmail(email: string, code: string) {
  if (!/^\d{6}$/.test(code)) throw new Error('Verification code must be six digits');
  const signInUrl = new URL('/login', PRODUCT_LINKS.website).toString();
  const iconUrl = new URL('/icon.png', PRODUCT_LINKS.website).toString();

  return {
    from: verificationSender(),
    to: [email],
    subject: `${code} is your ${PRODUCT_NAME} verification code`,
    html: `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background-color:#f7f7f5;color:#12120f;">
    <p style="display:none;max-height:0;overflow:hidden;opacity:0;">Your ${PRODUCT_NAME} verification code is ${code}. It expires in 10 minutes.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;background-color:#ffffff;border:1px solid #e8e6e1;border-radius:20px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px;background-color:#eef1fe;border-bottom:1px solid #e8e6e1;">
                <p style="margin:0;">
                  <img src="${iconUrl}" width="40" height="40" alt="${PRODUCT_NAME}" style="display:inline-block;vertical-align:middle;border:0;" />
                  <strong style="vertical-align:middle;color:#12120f;">${PRODUCT_NAME}</strong>
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:36px 32px;">
                <h1 style="margin:0 0 16px;color:#12120f;">You're one quick step away</h1>
                <p style="margin:0 0 24px;color:#6b6a64;">We're so excited to have you here. Enter this code to finish signing in and keep your job search moving with ${PRODUCT_NAME}.</p>
                <p style="margin:0 0 8px;color:#6b6a64;">Your verification code</p>
                <h2 aria-label="Verification code ${code.split('').join(' ')}" style="margin:0 0 24px;padding:18px 20px;background-color:#eef1fe;border:1px solid #dce2fa;border-radius:12px;color:#12120f;">${code}</h2>
                <p style="margin:0 0 28px;">
                  <a href="${signInUrl}" style="display:inline-block;padding:13px 20px;background-color:#6b84e8;color:#ffffff;text-decoration:none;border-radius:999px;">Finish signing in</a>
                </p>
                <p style="margin:0 0 28px;color:#6b6a64;">If the button does not work, open <a href="${signInUrl}" style="color:#4f68c9;">${signInUrl}</a>.</p>
                <h2 style="margin:0 0 12px;color:#12120f;">Once you're in</h2>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 20px;background-color:#f7f7f5;border:1px solid #e8e6e1;border-radius:12px;">
                  <tr>
                    <td align="center" style="padding:14px 8px;color:#12120f;">Find roles</td>
                    <td align="center" style="padding:14px 4px;color:#6b84e8;">&#8594;</td>
                    <td align="center" style="padding:14px 8px;color:#12120f;">Tailor</td>
                    <td align="center" style="padding:14px 4px;color:#6b84e8;">&#8594;</td>
                    <td align="center" style="padding:14px 8px;color:#12120f;">Apply</td>
                  </tr>
                </table>
                <ul style="margin:0 0 28px;padding-left:20px;color:#6b6a64;">
                  <li style="margin-bottom:8px;">Tailor and fill applications with less repetitive work.</li>
                  <li style="margin-bottom:8px;">Keep every opportunity organized in one dashboard.</li>
                  <li>Draft thoughtful recruiter outreach when you want it.</li>
                </ul>
                <p style="margin:0;color:#6b6a64;">This code expires in 10 minutes. If you did not request it, you can safely ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`,
    text: `You're one quick step away\n\nWe're so excited to have you here. Enter this code to finish signing in to ${PRODUCT_NAME}:\n\n${code}\n\nFinish signing in: ${signInUrl}\n\nOnce you're in, ${PRODUCT_NAME} can help you tailor and fill applications, keep opportunities organized, and draft recruiter outreach.\n\nThis code expires in 10 minutes. If you did not request it, you can safely ignore this email.`,
  };
}

// Sends the 6-digit code via Resend's HTTPS API. Requires RESEND_API_KEY and
// RESEND_FROM, which must be a sender on a domain verified in Resend.
export async function sendVerificationEmail(
  email: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl('https://api.resend.com/emails', {
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

  const result = (await res.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof result?.id !== 'string' || result.id.length === 0) {
    throw new Error('Resend API accepted the request without returning an email id');
  }
  return result.id;
}

export async function authRoutes(fastify: FastifyInstance) {
  // Exchange a Google Identity Services ID token for the same Litos session
  // used by email-code sign-in and the Chrome extension.
  fastify.post('/auth/google', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof googleBodySchema>;
    try {
      body = googleBodySchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: 'A Google credential is required' });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
    if (!clientId) {
      return reply.status(503).send({ error: 'google_auth_unavailable' });
    }
    if (!process.env.JWT_SIGNING_SECRET) {
      return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
    }

    const identity = await verifyGoogleCredential(body.credential, clientId);
    if (!identity) {
      return reply.status(401).send({ error: 'invalid_google_credential' });
    }

    try {
      const googleUser = await db.transaction(async (tx) => {
        const bySubject = await tx
          .select()
          .from(users)
          .where(eq(users.google_subject, identity.subject))
          .limit(1);
        if (bySubject[0]) {
          return {
            user: { id: bySubject[0].id, email: bySubject[0].email },
            isNewUser: false,
          };
        }

        // Google warns that it is not authoritative for a non-Gmail address
        // outside Google Workspace. Do not merge that identity into an account
        // by email, because a stale third-party address could take over data.
        if (!googleIsAuthoritativeForEmail(identity)) return null;

        const byEmail = await tx.select().from(users).where(eq(users.email, identity.email)).limit(1);
        if (byEmail[0]) {
          if (byEmail[0].google_subject && byEmail[0].google_subject !== identity.subject) {
            return null;
          }
          await tx
            .update(users)
            .set({
              google_subject: identity.subject,
              email_verified: true,
              ...(!byEmail[0].email_verified ? { session_valid_from: new Date() } : {}),
            })
            .where(eq(users.id, byEmail[0].id));
          return {
            user: { id: byEmail[0].id, email: byEmail[0].email },
            isNewUser: false,
          };
        }

        const created = await tx
          .insert(users)
          .values(googleRegistrationValues(identity))
          .returning({ id: users.id, email: users.email });
        return created[0]
          ? { user: created[0], isNewUser: true }
          : null;
      });

      if (!googleUser) {
        return reply.status(409).send({ error: 'google_email_requires_verification' });
      }

      const token = await signSessionToken(googleUser.user.id, googleUser.user.email);
      return reply.status(200).send({
        token,
        email: googleUser.user.email,
        is_new_user: googleUser.isNewUser,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to sign in with Google' });
    }
  });

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

    const [emailAllowed, ipAllowed] = await Promise.all([
      allowHourly(email, 'session', LIMITS.perHour.session),
      allowHourly(`ip:${request.ip}`, 'session-ip', LIMITS.perHour.sessionPerIp),
    ]);
    if (!emailAllowed || !ipAllowed) {
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
    const [emailAllowed, ipAllowed] = await Promise.all([
      allowHourly(email, 'request-code', LIMITS.perHour.requestCode),
      allowHourly(`ip:${request.ip}`, 'request-code-ip', LIMITS.perHour.requestCodePerIp),
    ]);
    if (!emailAllowed || !ipAllowed) {
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

      const emailId = await sendVerificationEmail(email, code);
      fastify.log.info({ emailId, email, event: 'verification_email_accepted' });
      return reply.status(200).send({ sent: true, resend_available_in_seconds: 30 });
    } catch (err) {
      fastify.log.error(err);
      // Send failure (e.g. Resend domain not verified yet, provider outage):
      // report verification as unavailable. Clients must keep ownership verification
      // mandatory and provide a retry path rather than minting an unverified session.
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
    const [emailAllowed, ipAllowed] = await Promise.all([
      allowHourly(email, 'verify-code', 15),
      allowHourly(`ip:${request.ip}`, 'verify-code-ip', LIMITS.perHour.verifyCodePerIp),
    ]);
    if (!emailAllowed || !ipAllowed) {
      return rateLimitedReply(reply);
    }

    try {
      const rows = await db
        .select()
        .from(email_verification_codes)
        .where(eq(email_verification_codes.email, email))
        .limit(1);
      const record = rows[0];
      const failure = verificationFailure(record, body.code);
      if (failure) {
        if (failure.incrementAttempts && record) {
        await db
          .update(email_verification_codes)
            .set({ attempts: sql`${email_verification_codes.attempts} + 1` })
            .where(
              and(
                eq(email_verification_codes.email, email),
                eq(email_verification_codes.code_hash, record.code_hash),
                lt(email_verification_codes.attempts, MAX_ATTEMPTS),
              ),
            );
        }
        return reply.status(failure.status).send({ error: failure.error });
      }

      // Consume the exact code and create or update the user in one transaction. A
      // concurrent verify cannot reuse the code, and a database failure rolls the
      // deletion back so the user can retry instead of being stranded.
      const verifiedUser = await db.transaction(async (tx) => {
        const consumed = await tx
          .delete(email_verification_codes)
          .where(
            and(
              eq(email_verification_codes.email, email),
              eq(email_verification_codes.code_hash, hashCode(body.code)),
              gte(email_verification_codes.expires_at, new Date()),
              lt(email_verification_codes.attempts, MAX_ATTEMPTS),
            ),
          )
          .returning({ email: email_verification_codes.email });
        if (consumed.length === 0) return null;

        const existing = await tx.select().from(users).where(eq(users.email, email)).limit(1);
        if (existing.length === 0) {
          const created = await tx
            .insert(users)
            .values({
              id: uuidv4(),
              email,
              email_verified: true,
              trial_ends_at: trialEnd(),
              created_at: new Date(),
            })
            .returning({ id: users.id, email: users.email });
          return created[0] ?? null;
        }

        if (!existing[0].email_verified) {
          // Adopting a pre-existing UNVERIFIED account onto the same users.id. Any
          // old unverified token is invalidated before this verified token is signed.
          await tx
            .update(users)
            .set({ email_verified: true, session_valid_from: new Date() })
            .where(eq(users.email, email));
        }
        return { id: existing[0].id, email: existing[0].email };
      });

      if (!verifiedUser) {
        return reply.status(400).send({ error: 'Code expired or not found. Request a new one.' });
      }

      const token = await signSessionToken(verifiedUser.id, verifiedUser.email);
      return reply.status(200).send({ token });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to verify code' });
    }
  });
}
