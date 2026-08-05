import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { createRemoteJWKSet, jwtVerify, SignJWT, type JWTPayload as JoseJWTPayload } from 'jose';
import { createHash, randomInt } from 'node:crypto';
import { db, withDedicatedDatabase } from '../db/index';
import { users, email_verification_codes } from '../db/schema';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { allowHourly, rateLimitedReply, LIMITS, TRIAL_DAYS } from '../middleware/quota';
import { PRODUCT_LINKS, PRODUCT_NAME } from '../lib/product';
import { emailSender, sendEmail } from '../lib/email';
import { requireAuth, type JWTPayload } from '../middleware/auth';
import { withReadOnlyRetry } from '../db/readOnlyRetry';
import {
  hashPassword,
  normalizePassword,
  passwordHashNeedsUpgrade,
  passwordPolicyError,
  passwordUpdateError,
  verifyPassword,
} from '../lib/passwordAuth';

const sessionBodySchema = z.object({
  email: z.string().email(),
});

const verifyBodySchema = z.object({
  email: z.string().email(),
  code: z.string().regex(/^\d{6}$/),
});

const guestBodySchema = z.object({
  idempotency_key: z.string().uuid(),
});

const googleBodySchema = z.object({
  credential: z.string().min(1).max(10_000),
});

const passwordLoginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(512),
});

const setPasswordBodySchema = z.object({
  password: z.string().min(1).max(512),
  current_password: z.string().max(512).optional(),
});

type AuthMethod = JWTPayload['authMethod'];

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

export function googleVerificationFailure(error: unknown): 'invalid' | 'unavailable' {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : '';
  if (
    error instanceof TypeError ||
    code === 'ERR_JWKS_TIMEOUT' ||
    code === 'ECONNRESET' ||
    code === 'ENOTFOUND' ||
    code === 'ETIMEDOUT'
  ) {
    return 'unavailable';
  }
  return 'invalid';
}

export class GoogleVerificationUnavailable extends Error {}

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
  } catch (error) {
    if (googleVerificationFailure(error) === 'unavailable') {
      throw new GoogleVerificationUnavailable('Google identity verification is unavailable');
    }
    return null;
  }
}

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function trialEnd(now = new Date()): Date {
  return new Date(now.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}
function guestExpiry(now = new Date()): Date {
  return new Date(now.getTime() + (TRIAL_DAYS + 30) * 24 * 60 * 60 * 1000);
}
const MAX_ATTEMPTS = 5;
const RECENT_VERIFICATION_SECONDS = 15 * 60;

export function isRecentVerification(
  authMethod: AuthMethod,
  authenticatedAt: number,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  return (authMethod === 'email_code' || authMethod === 'google')
    && authenticatedAt > 0
    && nowSeconds - authenticatedAt >= 0
    && nowSeconds - authenticatedAt <= RECENT_VERIFICATION_SECONDS;
}

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

export function withVerifyCodeTransactionRetry<T>(
  operation: () => Promise<T>,
  onRetry: (attempt: number) => void = (attempt) =>
    console.warn(`[auth] verify-code transaction hit a read-only backend, retrying (attempt ${attempt})`),
  onExhausted?: () => Promise<T>,
): Promise<T> {
  return withReadOnlyRetry(operation, { onRetry, onExhausted });
}

type SessionTokenOptions = {
  email?: string | null;
  isGuest?: boolean;
  expiresAt?: string | number;
  authMethod: AuthMethod;
  sessionVersion: number;
};

async function signSessionToken(userId: string, options: SessionTokenOptions): Promise<string> {
  const secret = process.env.JWT_SIGNING_SECRET!;
  const secretBytes = new TextEncoder().encode(secret);
  const { email, isGuest = false, expiresAt = '30d', authMethod, sessionVersion } = options;
  return new SignJWT({ userId, ...(email ? { email } : {}), isGuest, authMethod, sessionVersion })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(secretBytes);
}

async function optionalGuestUserId(request: FastifyRequest): Promise<string | null> {
  const authHeader = request.headers.authorization;
  if (!authHeader) return null;
  if (!authHeader.startsWith('Bearer ') || !process.env.JWT_SIGNING_SECRET) {
    throw new Error('invalid_guest_session');
  }
  const secretBytes = new TextEncoder().encode(process.env.JWT_SIGNING_SECRET);
  const { payload } = await jwtVerify(authHeader.slice(7), secretBytes);
  if (typeof payload.userId !== 'string' || payload.isGuest !== true) {
    throw new Error('invalid_guest_session');
  }
  const row = await db
    .select({ id: users.id, is_guest: users.is_guest, guest_expires_at: users.guest_expires_at })
    .from(users)
    .where(eq(users.id, payload.userId))
    .limit(1);
  const guest = row[0];
  if (!guest?.is_guest || !guest.guest_expires_at || guest.guest_expires_at <= new Date()) {
    throw new Error('invalid_guest_session');
  }
  return guest.id;
}

export function buildVerificationEmail(email: string, code: string) {
  if (!/^\d{6}$/.test(code)) throw new Error('Verification code must be six digits');
  const signInUrl = new URL('/login', PRODUCT_LINKS.website).toString();
  const iconUrl = new URL('/icon.png', PRODUCT_LINKS.website).toString();

  return {
    from: emailSender(),
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
                <h1 style="margin:0 0 16px;color:#12120f;">One more step</h1>
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
                  <li style="margin-bottom:8px;">Rewrite your resume for each job, and fill in the form.</li>
                  <li style="margin-bottom:8px;">Keep every job you applied to in one place.</li>
                  <li>Write a short email to a real person at the company.</li>
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
    text: `One more step\n\nWe're so excited to have you here. Enter this code to finish signing in to ${PRODUCT_NAME}:\n\n${code}\n\nFinish signing in: ${signInUrl}\n\nOnce you're in, ${PRODUCT_NAME} can rewrite your resume for each job, fill in the form, keep every job you applied to in one place, and write a short email to a real person at the company.\n\nThis code expires in 10 minutes. If you did not request it, you can safely ignore this email.`,
  };
}

// Sends the 6-digit code. The Resend call itself lives in lib/email.ts, which is
// the backend's single outbound-mail path; this keeps its signature so callers and
// tests are unaffected by that move.
export async function sendVerificationEmail(
  email: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  return sendEmail(buildVerificationEmail(email, code), fetchImpl);
}

export async function authRoutes(fastify: FastifyInstance) {
  // First-run guest mode. The client controls whether the entry point is shown;
  // the backend owns identity, trial timing, quotas, and idempotency.
  fastify.post('/auth/guest', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = guestBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'A valid guest idempotency key is required' });
    }
    if (!process.env.JWT_SIGNING_SECRET) {
      return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
    }

    const keyHash = hashCode(parsed.data.idempotency_key);
    try {
      const existing = await db.select().from(users).where(eq(users.guest_key_hash, keyHash)).limit(1);
      const active = existing[0];
      if (active?.is_guest && active.guest_expires_at && active.guest_expires_at > new Date()) {
        const token = await signSessionToken(active.id, {
          isGuest: true,
          expiresAt: Math.floor(active.guest_expires_at.getTime() / 1000),
          authMethod: 'guest',
          sessionVersion: active.session_version,
        });
        return reply.status(200).send({
          token,
          is_guest: true,
          trial_ends_at: active.trial_ends_at,
          guest_expires_at: active.guest_expires_at,
        });
      }

      const ipAllowed = await allowHourly(`ip:${request.ip}`, 'guest-create-ip', 3);
      if (!ipAllowed) return rateLimitedReply(reply);

      const now = new Date();
      const trial_ends_at = trialEnd(now);
      const guest_expires_at = guestExpiry(now);
      const created = await db
        .insert(users)
        .values({
          id: uuidv4(),
          email: null,
          email_verified: false,
          is_guest: true,
          guest_key_hash: keyHash,
          trial_ends_at,
          guest_expires_at,
          created_at: now,
        })
        .onConflictDoNothing({ target: users.guest_key_hash })
        .returning();
      const guest = created[0]
        ?? (await db.select().from(users).where(eq(users.guest_key_hash, keyHash)).limit(1))[0];
      if (!guest) throw new Error('Guest creation did not return a user');

      const token = await signSessionToken(guest.id, {
        isGuest: true,
        expiresAt: Math.floor((guest.guest_expires_at ?? guest_expires_at).getTime() / 1000),
        authMethod: 'guest',
        sessionVersion: guest.session_version,
      });
      return reply.status(201).send({
        token,
        is_guest: true,
        trial_ends_at: guest.trial_ends_at,
        guest_expires_at: guest.guest_expires_at,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to create guest session' });
    }
  });

  // Exchange a Google Identity Services ID token for the same Litos session
  // used by email-code sign-in and the Chrome extension.
  fastify.post('/auth/google', async (request: FastifyRequest, reply: FastifyReply) => {
    let body: z.infer<typeof googleBodySchema>;
    try {
      body = googleBodySchema.parse(request.body);
    } catch {
      return reply.status(400).send({ error: 'A Google credential is required' });
    }

    const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
      || '719679889441-oto6bdqapcrdmcso8lsfs46qc4nvpb3s.apps.googleusercontent.com';
    if (!process.env.JWT_SIGNING_SECRET) {
      return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
    }

    let identity: GoogleIdentity | null;
    try {
      identity = await verifyGoogleCredential(body.credential, clientId);
    } catch (error) {
      request.log.warn({ err: error }, 'Google identity verification unavailable');
      return reply.status(503).send({ error: 'google_auth_unavailable' });
    }
    if (!identity) {
      return reply.status(401).send({ error: 'invalid_google_credential' });
    }

    try {
      const googleUser = await db.transaction(async (tx) => {
        const bySubject = await tx
          .select({ id: users.id, email: users.email, session_version: users.session_version })
          .from(users)
          .where(eq(users.google_subject, identity.subject))
          .limit(1);
        if (bySubject[0]) {
          return {
            user: bySubject[0],
            isNewUser: false,
          };
        }

        // Google warns that it is not authoritative for a non-Gmail address
        // outside Google Workspace. Do not merge that identity into an account
        // by email, because a stale third-party address could take over data.
        if (!googleIsAuthoritativeForEmail(identity)) return null;

        const linkExistingByEmail = async (attempt = 0): Promise<{
          user: { id: string; email: string; session_version: number };
          isNewUser: false;
        } | null> => {
          const byEmail = await tx
            .select({
              id: users.id,
              email: users.email,
              google_subject: users.google_subject,
              email_verified: users.email_verified,
              session_version: users.session_version,
            })
            .from(users)
            .where(eq(users.email, identity.email))
            .limit(1);
          const existing = byEmail[0];
          if (!existing?.email) return null;
          if (existing.google_subject && existing.google_subject !== identity.subject) {
            return null;
          }
          if (existing.google_subject === identity.subject && existing.email_verified) {
            return {
              user: {
                id: existing.id,
                email: existing.email,
                session_version: existing.session_version,
              },
              isNewUser: false,
            };
          }

          const updated = await tx
            .update(users)
            .set({
              google_subject: identity.subject,
              email_verified: true,
              ...(!existing.email_verified ? { session_valid_from: new Date() } : {}),
              ...(!existing.email_verified
                ? { session_version: sql`${users.session_version} + 1` }
                : {}),
            })
            .where(and(
              eq(users.id, existing.id),
              eq(users.session_version, existing.session_version),
              existing.google_subject
                ? eq(users.google_subject, identity.subject)
                : sql`${users.google_subject} IS NULL`,
            ))
            .returning({
              id: users.id,
              email: users.email,
              session_version: users.session_version,
            });
          if (!updated[0]) {
            // A parallel login or security-sensitive account update won the
            // compare-and-swap. Re-read once so every issued token carries the
            // session version that actually committed.
            return attempt === 0 ? linkExistingByEmail(1) : null;
          }
          return {
            user: {
              id: updated[0].id,
              email: existing.email,
              session_version: updated[0].session_version,
            },
            isNewUser: false,
          };
        };

        const linkedByEmail = await linkExistingByEmail();
        if (linkedByEmail) return linkedByEmail;

        const registration = googleRegistrationValues(identity);
        // Keep first-time Google registration compatible with deployed databases
        // that have not yet received unrelated user-preference columns. Drizzle's
        // generated INSERT includes every modeled column, even when omitted from
        // values, so name the authentication columns explicitly here.
        const created = await tx.execute<{ id: string; email: string; session_version: number }>(sql`
          INSERT INTO ${users} (
            id,
            email,
            email_verified,
            google_subject,
            plan,
            trial_ends_at,
            created_at,
            onboarding_completed_at
          ) VALUES (
            ${registration.id},
            ${registration.email},
            ${registration.email_verified},
            ${registration.google_subject},
            ${registration.plan},
            ${registration.trial_ends_at},
            ${registration.created_at},
            ${registration.onboarding_completed_at}
          )
          ON CONFLICT DO NOTHING
          RETURNING id, email, session_version
        `);
        if (created.rows[0]) return { user: created.rows[0], isNewUser: true };

        // A second valid request can race the first between the lookups and
        // INSERT. Re-read the winning identity instead of turning a harmless
        // retry or parallel-tab sign-in into a 500 response.
        const concurrentBySubject = await tx
          .select({ id: users.id, email: users.email, session_version: users.session_version })
          .from(users)
          .where(eq(users.google_subject, identity.subject))
          .limit(1);
        if (concurrentBySubject[0]) {
          return { user: concurrentBySubject[0], isNewUser: false };
        }
        return linkExistingByEmail();
      });

      if (!googleUser) {
        return reply.status(409).send({ error: 'google_email_requires_verification' });
      }

      const token = await signSessionToken(googleUser.user.id, {
        email: googleUser.user.email,
        authMethod: 'google',
        sessionVersion: googleUser.user.session_version,
      });
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

  fastify.post('/auth/password/login', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = passwordLoginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'A valid email and password are required' });
    }
    if (!process.env.JWT_SIGNING_SECRET) {
      return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
    }

    const email = parsed.data.email.toLowerCase();
    const password = normalizePassword(parsed.data.password);
    const [emailAllowed, ipAllowed] = await Promise.all([
      allowHourly(email, 'password-login', LIMITS.perHour.passwordLogin),
      allowHourly(`ip:${request.ip}`, 'password-login-ip', LIMITS.perHour.passwordLoginPerIp),
    ]);
    if (!emailAllowed || !ipAllowed) return rateLimitedReply(reply);

    try {
      const account = (await db
        .select({
          id: users.id,
          email: users.email,
          email_verified: users.email_verified,
          is_guest: users.is_guest,
          password_hash: users.password_hash,
          session_version: users.session_version,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1))[0];

      // A dummy Argon2 verification keeps unknown emails and accounts without a
      // password on the same computational path as a real account.
      const passwordMatches = await verifyPassword(account?.password_hash ?? null, password);
      if (
        !account ||
        account.is_guest ||
        !account.email_verified ||
        !account.email ||
        !account.password_hash ||
        !passwordMatches
      ) {
        return reply
          .header('Cache-Control', 'private, no-store')
          .status(401)
          .send({ error: 'Invalid email or password', code: 'invalid_credentials' });
      }

      if (passwordHashNeedsUpgrade(account.password_hash)) {
        const upgradedHash = await hashPassword(password);
        await db
          .update(users)
          .set({ password_hash: upgradedHash })
          .where(and(eq(users.id, account.id), eq(users.password_hash, account.password_hash)));
      }

      const token = await signSessionToken(account.id, {
        email: account.email,
        authMethod: 'password',
        sessionVersion: account.session_version,
      });
      return reply
        .header('Cache-Control', 'private, no-store')
        .status(200)
        .send({ token, email: account.email });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to sign in' });
    }
  });

  fastify.put(
    '/auth/password',
    { preHandler: requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = setPasswordBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'A password is required', code: 'invalid_password' });
      }
      const identity = request.jwtPayload;
      if (!identity || identity.isGuest || !identity.email) {
        return reply.status(403).send({ error: 'Verify your email before setting a password' });
      }

      const password = normalizePassword(parsed.data.password);
      const policyError = passwordPolicyError(password, identity.email);
      if (policyError) {
        const messages = {
          password_too_short: 'Use at least 15 characters',
          password_too_long: 'Use no more than 128 characters',
          password_too_common: 'Choose a less common password',
        } as const;
        return reply.status(400).send({ error: messages[policyError], code: policyError });
      }

      try {
        const account = (await db
          .select({
            id: users.id,
            email: users.email,
            email_verified: users.email_verified,
            password_hash: users.password_hash,
            session_version: users.session_version,
          })
          .from(users)
          .where(eq(users.id, identity.userId))
          .limit(1))[0];
        if (!account?.email || !account.email_verified) {
          return reply.status(403).send({ error: 'Verify your email before setting a password' });
        }

        const recoverySession = isRecentVerification(identity.authMethod, identity.authenticatedAt);
        const [userAllowed, ipAllowed] = await Promise.all([
          allowHourly(account.id, 'password-change', LIMITS.perHour.passwordChange),
          allowHourly(`ip:${request.ip}`, 'password-change-ip', LIMITS.perHour.passwordChangePerIp),
        ]);
        if (!userAllowed || !ipAllowed) return rateLimitedReply(reply);

        const updateError = await passwordUpdateError({
          existingHash: account.password_hash,
          newPassword: password,
          currentPassword: parsed.data.current_password,
          recoverySession,
        });
        if (updateError) {
          const failures = {
            recent_verification_required: {
              status: 403,
              error: 'Verify your email again before creating a password',
            },
            current_password_incorrect: {
              status: 401,
              error: 'Current password is incorrect',
            },
            password_unchanged: {
              status: 400,
              error: 'Choose a password you have not used for this account',
            },
          } as const;
          const failure = failures[updateError];
          return reply.status(failure.status).send({ error: failure.error, code: updateError });
        }

        const passwordHash = await hashPassword(password);
        const updated = await db
          .update(users)
          .set({
            password_hash: passwordHash,
            session_version: sql`${users.session_version} + 1`,
            session_valid_from: new Date(),
          })
          .where(and(
            eq(users.id, account.id),
            eq(users.session_version, identity.sessionVersion),
            account.password_hash
              ? eq(users.password_hash, account.password_hash)
              : sql`${users.password_hash} IS NULL`,
          ))
          .returning({ session_version: users.session_version });
        if (!updated[0]) {
          return reply.status(409).send({
            error: 'Your account changed in another session. Verify your email and try again.',
            code: 'session_changed',
          });
        }

        const token = await signSessionToken(account.id, {
          email: account.email,
          authMethod: 'password',
          sessionVersion: updated[0].session_version,
        });
        return reply
          .header('Cache-Control', 'private, no-store')
          .status(200)
          .send({ token, email: account.email });
      } catch (err) {
        fastify.log.error(err);
        return reply.status(500).send({ error: 'Failed to update password' });
      }
    },
  );

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
      if (!foundUser.email) {
        return reply.status(409).send({ error: 'Guest accounts must be claimed with email verification' });
      }
      const token = await signSessionToken(foundUser.id, {
        email: foundUser.email,
        authMethod: 'legacy',
        sessionVersion: foundUser.session_version,
      });

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
    let guestUserId: string | null;
    try {
      guestUserId = await optionalGuestUserId(request);
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired guest session' });
    }
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
      const runVerificationTransaction = (database: typeof db) =>
        database.transaction(async (tx) => {
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
          if (guestUserId) {
            if (existing.length > 0) {
              const existingEmail = existing[0].email;
              if (!existingEmail) return null;
              return {
                user: {
                  id: existing[0].id,
                  email: existingEmail,
                  session_version: existing[0].session_version,
                },
                existingAccount: true,
              };
            }

            const claimed = await tx
              .update(users)
              .set({
                email,
                email_verified: true,
                is_guest: false,
                guest_key_hash: null,
                guest_expires_at: null,
                claimed_at: new Date(),
                session_valid_from: new Date(),
                session_version: sql`${users.session_version} + 1`,
              })
              .where(and(eq(users.id, guestUserId), eq(users.is_guest, true)))
              .returning({ id: users.id, email: users.email, session_version: users.session_version });
            if (!claimed[0]?.email) return null;
            return {
              user: claimed[0],
              existingAccount: false,
            };
          }

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
              .returning({ id: users.id, email: users.email, session_version: users.session_version });
            const user = created[0] ?? null;
            return user?.email
              ? { user, existingAccount: false }
              : null;
          }

          if (!existing[0].email_verified) {
            // Adopting a pre-existing UNVERIFIED account onto the same users.id. Any
            // old unverified token is invalidated before this verified token is signed.
            const updated = await tx
              .update(users)
              .set({
                email_verified: true,
                session_valid_from: new Date(),
                session_version: sql`${users.session_version} + 1`,
              })
              .where(eq(users.email, email))
              .returning({ session_version: users.session_version });
            existing[0].session_version = updated[0]?.session_version ?? existing[0].session_version + 1;
          }
          if (!existing[0].email) return null;
          return {
            user: {
              id: existing[0].id,
              email: existing[0].email,
              session_version: existing[0].session_version,
            },
            existingAccount: false,
          };
        });
      const verificationResult = await withVerifyCodeTransactionRetry(
        () => runVerificationTransaction(db),
        (attempt) =>
          request.log.warn(
            { attempt },
            'verify-code transaction hit a read-only database backend; retrying on a fresh connection',
          ),
        () =>
          withDedicatedDatabase((directDb) => {
            request.log.warn('verify-code pooled transaction stayed read-only; retrying on the direct database endpoint');
            return runVerificationTransaction(directDb);
          }),
      );

      if (!verificationResult) {
        return reply.status(400).send({ error: 'Code expired or not found. Request a new one.' });
      }

      const token = await signSessionToken(verificationResult.user.id, {
        email: verificationResult.user.email,
        authMethod: 'email_code',
        sessionVersion: verificationResult.user.session_version,
      });
      return reply.status(200).send({
        token,
        existing_account: verificationResult.existingAccount,
        guest_workspace_preserved: verificationResult.existingAccount,
      });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to verify code' });
    }
  });
}
