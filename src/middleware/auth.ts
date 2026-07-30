import { FastifyRequest, FastifyReply } from 'fastify';
import { jwtVerify } from 'jose';
import { db } from '../db/index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface JWTPayload {
  userId: string;
  email?: string;
  isGuest: boolean;
  authMethod: 'guest' | 'legacy' | 'google' | 'email_code' | 'password';
  sessionVersion: number;
  authenticatedAt: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    jwtPayload?: JWTPayload;
  }
}

// Token-epoch check. JWT iat has second precision while session_valid_from has
// millisecond precision, so floor both to seconds: a token minted in the same
// second as the epoch bump (the one verify-code issues right after adoption)
// must stay valid, while anything minted in an earlier second is dead.
export function issuedBeforeEpoch(iatSeconds: number | undefined, sessionValidFrom: Date | null): boolean {
  if (!sessionValidFrom) return false;
  // A token with no iat cannot prove it postdates the epoch; treat it as stale.
  if (iatSeconds === undefined) return true;
  return iatSeconds < Math.floor(sessionValidFrom.getTime() / 1000);
}

export function sessionVersionIsStale(tokenVersion: unknown, storedVersion: number): boolean {
  const normalizedTokenVersion = typeof tokenVersion === 'number' ? tokenVersion : 0;
  return normalizedTokenVersion !== storedVersion;
}

/** Why a session either verifies or does not, with no third answer. */
type SessionOutcome =
  | { ok: true; payload: JWTPayload }
  /** No credential was presented at all. Distinct from a bad one: optionalAuth continues here. */
  | { ok: false; reason: 'anonymous' }
  /** A credential was presented and did not hold up. Never treated as anonymous. */
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'misconfigured' };

const inFlightSessions = new Map<string, Promise<SessionOutcome>>();

/**
 * The ONE place a bearer token is turned into a session.
 *
 * requireAuth and optionalAuth both call this. That is the point: the epoch check, the
 * session-version check, the guest-expiry check and the isGuest cross-check are the account
 * revocation backstops, and a second hand-rolled copy of them in an "optional" variant is exactly
 * how a route ends up honouring a token the real one would have killed.
 */
async function resolveSession(request: FastifyRequest): Promise<SessionOutcome> {
  const authHeader = request.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'anonymous' };
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SIGNING_SECRET;

  if (!secret) {
    return { ok: false, reason: 'misconfigured' };
  }

  const existing = inFlightSessions.get(token);
  if (existing) return existing;

  /* Dashboard bootstrap fans out into several authenticated projections at
     once. They all carry the same token, so independently verifying the JWT
     and reading the same user row turns one browser request into eight
     identical auth queries. Share only the active resolution. The entry is
     removed as soon as it settles, so revocation still reaches the next
     request rather than waiting behind a time-based cache. */
  const resolution = resolveToken(token, secret);
  inFlightSessions.set(token, resolution);
  const cleanup = () => {
    if (inFlightSessions.get(token) === resolution) inFlightSessions.delete(token);
  };
  resolution.then(cleanup, cleanup);
  return resolution;
}

async function resolveToken(token: string, secret: string): Promise<SessionOutcome> {
  try {
    const secretBytes = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretBytes);

    if (!payload['userId']) {
      return { ok: false, reason: 'invalid' };
    }

    const userId = payload['userId'] as string;

    // Epoch check: reject tokens minted before the account's session_valid_from.
    // This is the revocation backstop for the pre-registration hole: verify-code
    // bumps the epoch when the real owner first adopts an unverified account, so
    // a 30-day token minted for that email during a break-glass window dies here.
    // Cost: one indexed PK read per authed request (accepted tradeoff, 2026-07-16).
    const row = await db
      .select({
        session_valid_from: users.session_valid_from,
        session_version: users.session_version,
        email: users.email,
        is_guest: users.is_guest,
        guest_expires_at: users.guest_expires_at,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (row.length === 0) return { ok: false, reason: 'invalid' };
    if (issuedBeforeEpoch(payload.iat, row[0].session_valid_from)) return { ok: false, reason: 'invalid' };
    if (sessionVersionIsStale(payload['sessionVersion'], row[0].session_version)) return { ok: false, reason: 'invalid' };
    if (row[0].is_guest && row[0].guest_expires_at && row[0].guest_expires_at <= new Date()) {
      return { ok: false, reason: 'invalid' };
    }
    if (Boolean(payload['isGuest']) !== row[0].is_guest) return { ok: false, reason: 'invalid' };

    return {
      ok: true,
      payload: {
        userId,
        ...(row[0].email ? { email: row[0].email } : {}),
        isGuest: row[0].is_guest,
        authMethod: typeof payload['authMethod'] === 'string'
          ? payload['authMethod'] as JWTPayload['authMethod']
          : 'legacy',
        sessionVersion: row[0].session_version,
        authenticatedAt: payload.iat ?? 0,
      },
    };
  } catch {
    return { ok: false, reason: 'invalid' };
  }
}

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const outcome = await resolveSession(request);
  if (outcome.ok) {
    request.jwtPayload = outcome.payload;
    return;
  }
  if (outcome.reason === 'misconfigured') {
    return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
  }
  if (outcome.reason === 'anonymous') {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }
  return reply.status(401).send({ error: 'Invalid or expired token' });
}

/**
 * For routes that serve everyone but serve a signed-in person MORE.
 *
 * Sets `request.jwtPayload` when a session verifies and leaves it undefined otherwise, so the
 * handler decides what the extra is. The route must still treat the anonymous case as the default:
 * this middleware grants nothing on its own.
 *
 * A BAD token is not the same as no token, and this does not paper over one. If someone presents a
 * revoked or forged credential we answer 401 rather than silently downgrading them to anonymous,
 * because a client whose session just died needs to find that out and sign in again, not quietly
 * receive a stranger's view of the page for the next thirty days.
 */
export async function optionalAuth(request: FastifyRequest, reply: FastifyReply) {
  const outcome = await resolveSession(request);
  if (outcome.ok) {
    request.jwtPayload = outcome.payload;
    return;
  }
  if (outcome.reason === 'anonymous') return;
  /* A missing signing secret is a server fault, and it answers like one — the SAME 500 requireAuth
     gives, deliberately.
     Degrading it to the anonymous path was the tempting version and it is the worse one: nobody
     presenting a token is anonymous, and with the secret gone that branch would serve every
     signed-in user the signed-out view, at 200, with no error anywhere, while the requireAuth
     routes 500 loudly and nobody connects the two. A feature that silently evaporates for 100% of
     users is harder to notice than an outage.
     Note the ordering this depends on: resolveSession checks for the header BEFORE it reads the
     secret, so a genuinely anonymous caller never reaches this branch and the public list keeps
     working. */
  if (outcome.reason === 'misconfigured') {
    request.log.error('JWT_SIGNING_SECRET not configured; refusing to resolve a presented token');
    return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
  }
  return reply.status(401).send({ error: 'Invalid or expired token' });
}
