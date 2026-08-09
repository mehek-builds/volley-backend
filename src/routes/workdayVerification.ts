import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import { readApplicationReview } from '../lib/applicationReview';
import { aliasUsesManagedReceiving, readPinnedApplicantEmail } from '../lib/applicationEmail';

const bodySchema = z.object({ requested_at: z.string().datetime() });

export type WorkdayVerificationApplication = { id: string; spec: unknown };

export type WorkdayVerificationDependencies = {
  requireAuth: preHandlerHookHandler;
  ownedApplication: (request: FastifyRequest, reply: FastifyReply) => Promise<WorkdayVerificationApplication | null>;
  resolveActiveAlias: (input: { userId: string; applicationId: string; spec: unknown }) => Promise<{ address: string }>;
  findCode: (input: {
    userId: string;
    portalUrl: string;
    requestedAt: Date;
    expectedRecipient: string;
    applicationId: string;
  }) => Promise<{ code: string; provider: string } | null>;
};

export function registerWorkdayVerificationRoute(
  fastify: FastifyInstance,
  deps: WorkdayVerificationDependencies,
): void {
  fastify.get(
    '/applications/:id/workday-account-identity',
    { preHandler: deps.requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await deps.ownedApplication(request, reply);
      if (!row) return;
      const portalUrl = readApplicationReview(row.spec)?.portal_url;
      if (!portalUrl) return reply.status(409).send({ error: 'This application has no verified portal URL' });
      let portalHost = '';
      try { portalHost = new URL(portalUrl).hostname.toLowerCase().replace(/^www\./, ''); } catch { portalHost = ''; }
      if (!portalHost.endsWith('.myworkdayjobs.com') && !portalHost.endsWith('.workday.com')) {
        return reply.status(409).send({ error: 'This application is not on a Workday tenant' });
      }
      const pinned = readPinnedApplicantEmail(row.spec);
      if (!pinned?.address || pinned.source !== 'litos_alias' || pinned.tracked !== true
        || !aliasUsesManagedReceiving(pinned.address)) {
        return reply.status(409).send({ error: 'This packet does not have a pinned managed Litos application alias' });
      }
      const userId = request.jwtPayload!.userId;
      let activeAlias: { address: string };
      try {
        activeAlias = await deps.resolveActiveAlias({ userId, applicationId: row.id, spec: row.spec });
      } catch {
        return reply.status(409).send({ error: 'This packet no longer has its exact active Litos application alias' });
      }
      if (activeAlias.address.trim().toLowerCase() !== pinned.address.trim().toLowerCase()) {
        return reply.status(409).send({ error: 'This packet no longer has its exact active Litos application alias' });
      }
      return reply.send({
        user_id: userId,
        application_id: row.id,
        email: activeAlias.address.trim().toLowerCase(),
        portal_host: portalHost,
      });
    },
  );

  fastify.post(
    '/applications/:id/workday-verification-code',
    { preHandler: deps.requireAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const row = await deps.ownedApplication(request, reply);
      if (!row) return;
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: 'A valid verification request time is required' });
      const portalUrl = readApplicationReview(row.spec)?.portal_url;
      if (!portalUrl) return reply.status(409).send({ error: 'This application has no verified portal URL' });
      let host = '';
      try { host = new URL(portalUrl).hostname.toLowerCase(); } catch { host = ''; }
      if (!host.endsWith('.myworkdayjobs.com') && !host.endsWith('.workday.com')) {
        return reply.status(409).send({ error: 'This application is not on a Workday tenant' });
      }
      const requestedAt = new Date(parsed.data.requested_at);
      const ageMs = Date.now() - requestedAt.getTime();
      if (ageMs < -60_000 || ageMs > 10 * 60_000) {
        return reply.status(400).send({ error: 'The verification request is no longer current' });
      }
      const pinned = readPinnedApplicantEmail(row.spec);
      if (!pinned?.address || pinned.source !== 'litos_alias' || pinned.tracked !== true
        || !aliasUsesManagedReceiving(pinned.address)) {
        return reply.status(409).send({ error: 'This packet does not have a pinned managed Litos application alias' });
      }
      const userId = request.jwtPayload!.userId;
      let activeAlias: { address: string };
      try {
        activeAlias = await deps.resolveActiveAlias({ userId, applicationId: row.id, spec: row.spec });
      } catch {
        return reply.status(409).send({ error: 'This packet no longer has its exact active Litos application alias' });
      }
      if (activeAlias.address.trim().toLowerCase() !== pinned.address.trim().toLowerCase()) {
        return reply.status(409).send({ error: 'This packet no longer has its exact active Litos application alias' });
      }
      const match = await deps.findCode({
        userId,
        portalUrl,
        requestedAt,
        expectedRecipient: activeAlias.address,
        applicationId: row.id,
      });
      if (!match) return reply.status(202).send({ status: 'pending' });
      return reply.send({ status: 'ready', code: match.code, provider: match.provider });
    },
  );
}
