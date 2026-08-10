import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { allowHourly, LIMITS, rateLimitedReply } from '../middleware/quota';
import { FieldDecryptError } from '../lib/fieldCrypto';
import { listPortalCredentials, revealPortalCredentialForOwner } from '../lib/portalCredentials';

/* THE OWNER'S VIEW OF THE ACCOUNTS LITOS HOLDS FOR HER.
 *
 * Two routes, and the split between them is the whole design. The listing says which employer
 * portals have an account and what address it is registered under, which is what a dashboard needs
 * and what an applicant checks. The reveal returns one password, one at a time, on a deliberate
 * POST, rate limited, counted on the row, and never cached.
 *
 * A password appears in exactly one response body in this codebase: the reveal below. It is not
 * logged, not echoed in an error, and not present in the listing.
 */

/** A merge is a deploy here, so this route can be live before the migration has run. */
function isUndefinedTableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    if ((current as { code?: string }).code === '42P01') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export async function portalCredentialRoutes(fastify: FastifyInstance) {
  fastify.get('/portal-credentials', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    try {
      const credentials = await listPortalCredentials(userId);
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({ credentials });
    } catch (error) {
      if (isUndefinedTableError(error)) {
        return reply.status(503).send({ error: 'Portal accounts are not available yet' });
      }
      throw error;
    }
  });

  fastify.post('/portal-credentials/:id/reveal', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid credential id' });
    const userId = request.jwtPayload!.userId;

    if (!await allowHourly(userId, 'portal_credential_reveal', LIMITS.perHour.portalCredentialReveal)) {
      return rateLimitedReply(reply);
    }

    try {
      const revealed = await revealPortalCredentialForOwner(userId, params.data.id);
      /* Not this user's credential and no such credential are the same answer on purpose. Any
       * difference between them would turn this route into an oracle for whether a given id
       * exists in somebody else's account. */
      if (!revealed) return reply.status(404).send({ error: 'No such portal account' });
      return reply
        .header('Cache-Control', 'private, no-store')
        .send({
          id: revealed.id,
          portal_family: revealed.portal_family,
          tenant: revealed.tenant,
          username: revealed.username,
          password: revealed.password,
        });
    } catch (error) {
      if (isUndefinedTableError(error)) {
        return reply.status(503).send({ error: 'Portal accounts are not available yet' });
      }
      /* A stored value that will not decrypt is a configuration fault, and it gets its own wording
       * rather than the global handler echoing an error message that names the key. */
      if (error instanceof FieldDecryptError) {
        return reply.status(503).send({ error: 'This portal account cannot be read with the current server configuration' });
      }
      throw error;
    }
  });
}
