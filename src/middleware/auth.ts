import { FastifyRequest, FastifyReply } from 'fastify';
import { jwtVerify, decodeJwt } from 'jose';
import { db } from '../db/index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { accountIsCardGateLocked, cardGateRouteReachable } from '../lib/cardGate';

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
  /* cardGateLocked travels separately from JWTPayload on purpose: it is a fact read off the
     user row at resolution time (see resolveToken), not a claim the token itself carries, and
     JWTPayload is the shape handed to callers as request.jwtPayload -- routes destructuring it
     should not have to know the card gate exists. Only requireAuth reads cardGateLocked. */
  | { ok: true; payload: JWTPayload; cardGateLocked: boolean }
  /** No credential was presented at all. Distinct from a bad one: optionalAuth continues here. */
  | { ok: false; reason: 'anonymous' }
  /** A credential was presented and did not hold up. Never treated as anonymous. */
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'misconfigured' };

/**
 * Every reason resolveToken answers 'invalid', so a rejection is diagnosable after the fact
 * instead of only from a live repro. Added 2026-09-04: a live dashboard session signed itself
 * out on a token that was, by every check this file makes, still good -- not past its own exp
 * claim, not epoch-revoked (session_valid_from was NULL on the account), not version-stale
 * (session_version was 0 and had never been bumped) -- and the previous bare
 * `catch { return invalid }` gave nobody a way to tell a signature failure from any of the
 * other five rejections after the fact. See src/middleware/auth.test.ts for the coverage this
 * exists to keep honest: the outcome returned to every caller, and the 401 body a client sees,
 * are unchanged by this. It only adds a log line.
 */
type TokenRejectionReason =
  | 'no_user_id'
  | 'user_not_found'
  | 'issued_before_epoch'
  | 'session_version_stale'
  | 'guest_expired'
  | 'guest_flag_mismatch'
  | 'verify_threw';

/**
 * Logs enough to tell these six apart after the fact, without ever logging the token or the
 * signing secret. `log` is optional and called through `?.` on purpose: plenty of tests in this
 * file construct a bare `{ headers }` request with no Fastify logger attached, and a rejection
 * path that only exists in a request handler's error branch is exactly the kind of thing a test
 * exercises without wiring up every incidental collaborator.
 */
function logRejectedToken(
  log: FastifyRequest['log'] | undefined,
  token: string,
  rejectionReason: TokenRejectionReason,
  verifyError?: unknown,
): void {
  /* decodeJwt reads the payload without checking the signature, so this still works for the
     exact case under investigation: a token whose signature no longer verifies against the
     current secret. A token too malformed even for that is itself informative, so the decode
     failure is captured rather than thrown past. */
  let claims: { userId?: unknown; sessionVersion?: unknown; iat?: unknown; exp?: unknown } | null = null;
  let claimDecodeError: string | null = null;
  try {
    claims = decodeJwt(token);
  } catch (decodeError) {
    claimDecodeError = decodeError instanceof Error ? decodeError.message : String(decodeError);
  }
  log?.warn(
    {
      tokenRejection: {
        reason: rejectionReason,
        verifyErrorName: verifyError instanceof Error ? verifyError.name : undefined,
        verifyErrorMessage: verifyError instanceof Error ? verifyError.message : undefined,
        claimDecodeError,
        claimUserId: typeof claims?.userId === 'string' ? claims.userId : undefined,
        claimSessionVersion: typeof claims?.sessionVersion === 'number' ? claims.sessionVersion : undefined,
        claimIat: typeof claims?.iat === 'number' ? claims.iat : undefined,
        claimExp: typeof claims?.exp === 'number' ? claims.exp : undefined,
        nowSeconds: Math.floor(Date.now() / 1000),
      },
    },
    'requireAuth rejected a presented token',
  );
}

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
  const resolution = resolveToken(token, secret, request.log);
  inFlightSessions.set(token, resolution);
  const cleanup = () => {
    if (inFlightSessions.get(token) === resolution) inFlightSessions.delete(token);
  };
  resolution.then(cleanup, cleanup);
  return resolution;
}

async function resolveToken(
  token: string,
  secret: string,
  log?: FastifyRequest['log'],
): Promise<SessionOutcome> {
  try {
    const secretBytes = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretBytes);

    if (!payload['userId']) {
      logRejectedToken(log, token, 'no_user_id');
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
        // The three columns THE CARD GATE (lib/cardGate.ts) needs. Added to this same indexed
        // PK read rather than a second query -- resolveToken already runs on every authed
        // request via the inFlightSessions cache, so a separate lookup would double it.
        billing_provider: users.billing_provider,
        billing_customer_id: users.billing_customer_id,
        created_at: users.created_at,
        onboarding_completed_at: users.onboarding_completed_at,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (row.length === 0) {
      logRejectedToken(log, token, 'user_not_found');
      return { ok: false, reason: 'invalid' };
    }
    if (issuedBeforeEpoch(payload.iat, row[0].session_valid_from)) {
      logRejectedToken(log, token, 'issued_before_epoch');
      return { ok: false, reason: 'invalid' };
    }
    if (sessionVersionIsStale(payload['sessionVersion'], row[0].session_version)) {
      logRejectedToken(log, token, 'session_version_stale');
      return { ok: false, reason: 'invalid' };
    }
    if (row[0].is_guest && row[0].guest_expires_at && row[0].guest_expires_at <= new Date()) {
      logRejectedToken(log, token, 'guest_expired');
      return { ok: false, reason: 'invalid' };
    }
    if (Boolean(payload['isGuest']) !== row[0].is_guest) {
      logRejectedToken(log, token, 'guest_flag_mismatch');
      return { ok: false, reason: 'invalid' };
    }

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
      cardGateLocked: accountIsCardGateLocked(row[0]),
    };
  } catch (error) {
    logRejectedToken(log, token, 'verify_threw', error);
    return { ok: false, reason: 'invalid' };
  }
}

/**
 * The path this request actually matched, for the card gate's route allowlist.
 *
 * By the time a preHandler runs, Fastify has already resolved routing, so
 * routeOptions.url is the registered template ('/onboarding/state', not
 * '/onboarding/state?x=1', and not a dynamic segment's literal value). request.url is
 * the fallback for the rare case routing has not attached it (matches the pattern
 * lib/submissionCutover.ts's onRequest hook already uses for the same reason).
 */
function requestPathForCardGate(request: FastifyRequest): string {
  return request.routeOptions?.url ?? request.url ?? '/';
}

/**
 * THE CARD GATE's shared enforcement point, called from both requireAuth and optionalAuth (for a
 * caller optionalAuth actually resolved a session for -- see the comment on optionalAuth's own call
 * site). Sends the 402 itself and reports whether it did, so each caller's own control flow stays a
 * one-line `if`.
 */
async function rejectIfCardGateLocked(
  request: FastifyRequest,
  reply: FastifyReply,
  cardGateLocked: boolean,
  userId: string,
): Promise<boolean> {
  if (!cardGateLocked) return false;
  if (await cardGateRouteReachable(requestPathForCardGate(request), userId)) return false;
  reply.status(402).send({
    error: 'A payment method is required to continue using Litos.',
    code: 'payment_method_required',
    onboarding_state_url: '/onboarding/state',
    billing_checkout_url: '/billing/checkout',
  });
  return true;
}

/**
 * THE CARD GATE's enforcement point. See lib/cardGate.ts for what "locked" means and what the
 * three route tiers cover.
 *
 * Lives inside requireAuth, not as a separate hook chained after it, so every one of the ~40
 * route files that already do `preHandler: requireAuth` gets the enforcement for free: no route
 * file needs to import a second preHandler, and a future route that adds `preHandler: requireAuth`
 * is gated by default rather than by remembering to opt in.
 */
export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const outcome = await resolveSession(request);
  if (outcome.ok) {
    request.jwtPayload = outcome.payload;
    if (await rejectIfCardGateLocked(request, reply, outcome.cardGateLocked, outcome.payload.userId)) return;
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
 *
 * THE CARD GATE applies here too, for a session that DID resolve. jobMonitor.ts's GET /jobs,
 * /jobs/grouped, /jobs/facets and /jobs/:id all sit behind optionalAuth rather than requireAuth
 * specifically so an anonymous visitor can browse the public board, and a code review (2026-08-29)
 * found that same design meant a locked, signed-in account reading request.jwtPayload.userId off
 * these routes got real, personalized, resume-ranked job data with zero enforcement -- the exact
 * bypass requireAuth's own gate exists to close, just reached through a route that does not require
 * a session instead of one that does. A genuinely anonymous caller (outcome.reason === 'anonymous',
 * checked below and returned on before this ever runs) is completely unaffected: cardGateLocked is
 * only ever read off a session this branch already knows resolved.
 */
export async function optionalAuth(request: FastifyRequest, reply: FastifyReply) {
  const outcome = await resolveSession(request);
  if (outcome.ok) {
    request.jwtPayload = outcome.payload;
    if (await rejectIfCardGateLocked(request, reply, outcome.cardGateLocked, outcome.payload.userId)) return;
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
