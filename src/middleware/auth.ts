import { FastifyRequest, FastifyReply } from 'fastify';
import { jwtVerify } from 'jose';
import { db } from '../db/index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';

export interface JWTPayload {
  userId: string;
  email: string;
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

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);
  const secret = process.env.JWT_SIGNING_SECRET;

  if (!secret) {
    return reply.status(500).send({ error: 'JWT_SIGNING_SECRET not configured' });
  }

  try {
    const secretBytes = new TextEncoder().encode(secret);
    const { payload } = await jwtVerify(token, secretBytes);

    if (!payload['userId'] || !payload['email']) {
      return reply.status(401).send({ error: 'Invalid token payload' });
    }

    const userId = payload['userId'] as string;

    // Epoch check: reject tokens minted before the account's session_valid_from.
    // This is the revocation backstop for the pre-registration hole: verify-code
    // bumps the epoch when the real owner first adopts an unverified account, so
    // a 30-day token minted for that email during a break-glass window dies here.
    // Cost: one indexed PK read per authed request (accepted tradeoff, 2026-07-16).
    const row = await db
      .select({ session_valid_from: users.session_valid_from })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (row.length === 0) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }
    if (issuedBeforeEpoch(payload.iat, row[0].session_valid_from)) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }

    request.jwtPayload = {
      userId,
      email: payload['email'] as string,
    };
  } catch (err) {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}
