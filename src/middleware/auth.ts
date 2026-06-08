import { FastifyRequest, FastifyReply } from 'fastify';
import { jwtVerify } from 'jose';

export interface JWTPayload {
  userId: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    jwtPayload?: JWTPayload;
  }
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

    request.jwtPayload = {
      userId: payload['userId'] as string,
      email: payload['email'] as string,
    };
  } catch (err) {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }
}
