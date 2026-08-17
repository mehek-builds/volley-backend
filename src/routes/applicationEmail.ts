import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { application_email_aliases, application_email_messages, users } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { isUndefinedColumnError } from '../lib/applicationFacts';
import {
  type InboundApplicationEmail,
  applicationEmailRouteLabel,
  applicationEmailRouteGenerationFingerprint,
  applicationForwardingAddress,
  forwardingAddressWouldLoop,
  inboundWebhookSecret,
  isApplicationEmailConfigured,
  isValidForwardingAddress,
  processInboundApplicationEmail,
  retrieveResendReceivedEmail,
} from '../lib/applicationEmail';
import {
  applicationAliasDeliverability,
  resetApplicationAliasDeliverabilityCache,
} from '../lib/applicationEmailDeliverability';
import {
  acceptSignedManagedReceivingCanary,
  recordManagedReceivingProofFromDelivery,
  type SignedResendCanaryEvent,
} from '../lib/applicationEmailReceivingProof';
import { normalizedApplicationEmailWebhookEndpoint } from '../lib/applicationEmailRoute';
import { managedReceivingProofNeedsRefresh } from '../lib/managedReceivingCanary';

const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

function recipientValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(recipientValues);
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
}

function allRecipients(value: {
  to?: string | string[];
  recipients?: string | string[];
  cc?: string | string[];
  envelope_to?: string | string[];
  delivered_to?: string | string[];
  recipient?: string | string[];
}): string[] {
  return [
    ...recipientValues(value.to),
    ...recipientValues(value.recipients),
    ...recipientValues(value.cc),
    ...recipientValues(value.envelope_to),
    ...recipientValues(value.delivered_to),
    ...recipientValues(value.recipient),
  ];
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rawPayload(body: unknown): string {
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  if (typeof body === 'string') return body;
  return JSON.stringify(body ?? {});
}

function parsedJsonBody(body: unknown): unknown {
  if (Buffer.isBuffer(body) || typeof body === 'string') {
    return JSON.parse(rawPayload(body));
  }
  return body;
}

function svixSecretBytes(secret: string): Buffer {
  const value = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  return Buffer.from(value, 'base64');
}

export function svixSignatureMatches(request: FastifyRequest, secret: string): boolean {
  const idHeader = request.headers['svix-id'];
  const timestampHeader = request.headers['svix-timestamp'];
  const signatureHeader = request.headers['svix-signature'];
  const id = Array.isArray(idHeader) ? idHeader[0] : idHeader;
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const provided = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!id || !timestamp || !provided) return false;
  const epochMs = Number(timestamp) * 1000;
  if (!Number.isFinite(epochMs) || Math.abs(Date.now() - epochMs) > WEBHOOK_MAX_SKEW_MS) return false;
  const expected = createHmac('sha256', svixSecretBytes(secret))
    .update(`${id}.${timestamp}.${rawPayload(request.body)}`)
    .digest('base64');
  return provided
    .split(' ')
    .map((part) => part.trim())
    .some((part) => part.startsWith('v1,') && safeEqual(part.slice(3), expected));
}

export function inboundSecretMatches(request: FastifyRequest): boolean {
  const secret = inboundWebhookSecret();
  if (secret && svixSignatureMatches(request, secret)) return true;
  const timestampHeader = request.headers['x-litos-webhook-timestamp'];
  const signatureHeader = request.headers['x-litos-webhook-signature'];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const provided = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!secret || !timestamp || !provided) return false;
  const epochMs = Number(timestamp);
  if (!Number.isFinite(epochMs) || Math.abs(Date.now() - epochMs) > WEBHOOK_MAX_SKEW_MS) return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${rawPayload(request.body)}`)
    .digest('hex');
  return safeEqual(provided, expected);
}

/** Canary proof has one trust root: Resend's own webhook signing secret. Compatibility secrets
 * may authorize ordinary inbound test-provider routing, but can never establish provider-bound
 * managed receiving proof, even when presented in Svix-shaped headers. */
export function resendProofSignatureMatches(request: FastifyRequest): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET?.trim();
  return Boolean(secret && svixSignatureMatches(request, secret));
}

function firstHeader(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(',')[0]?.trim().toLowerCase() || null;
}

/** The signed body is necessary but not enough for route proof. A captured valid delivery replayed
 * to another host must not vouch for the configured production endpoint. Vercel supplies and
 * overwrites the forwarded host and protocol at its trusted edge. */
export function signedWebhookRequestMatchesConfiguredEndpoint(request: FastifyRequest): boolean {
  const configured = normalizedApplicationEmailWebhookEndpoint();
  if (!configured) return false;
  const expected = new URL(configured);
  const host = firstHeader(request.headers['x-forwarded-host']) ?? firstHeader(request.headers.host);
  const protocol = firstHeader(request.headers['x-forwarded-proto']) ?? request.protocol?.toLowerCase();
  const path = request.url.split('?')[0]?.replace(/\/+$/, '') || '/';
  return host === expected.host.toLowerCase()
    && protocol === expected.protocol.slice(0, -1)
    && path === expected.pathname;
}

const directInboundBodySchema = z.object({
  provider: z.string().trim().max(80).optional(),
  provider_message_id: z.string().trim().max(200).optional(),
  from: z.string().trim().max(500).optional(),
  to: z.union([z.string(), z.array(z.string())]).optional(),
  recipients: z.union([z.string(), z.array(z.string())]).optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  envelope_to: z.union([z.string(), z.array(z.string())]).optional(),
  delivered_to: z.union([z.string(), z.array(z.string())]).optional(),
  recipient: z.union([z.string(), z.array(z.string())]).optional(),
  subject: z.string().max(1000).optional(),
  text: z.string().max(200_000).optional(),
  html: z.string().max(500_000).optional(),
  received_at: z.string().datetime().optional(),
  authentication: z.object({
    spf: z.string().max(40).optional(),
    dkim: z.string().max(40).optional(),
    dmarc: z.string().max(40).optional(),
  }).optional(),
}).passthrough().refine((value) => allRecipients(value).length > 0, 'At least one recipient is required');

const resendReceivedBodySchema = z.object({
  type: z.literal('email.received'),
  data: z.object({
    email_id: z.string().trim().min(1).max(200),
    from: z.string().trim().max(500).optional(),
    to: z.array(z.string()).default([]),
    subject: z.string().max(1000).optional(),
    created_at: z.string().datetime().optional(),
    message_id: z.string().max(500).optional(),
  }).passthrough(),
}).passthrough();

export function signedResendCanaryEvent(body: unknown): SignedResendCanaryEvent | null {
  let parsed: unknown;
  try {
    parsed = parsedJsonBody(body);
  } catch {
    return null;
  }
  const resend = resendReceivedBodySchema.safeParse(parsed);
  if (!resend.success) return null;
  return {
    emailId: resend.data.data.email_id,
    recipients: resend.data.data.to,
  };
}

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({ error: 'Invalid inbound email webhook secret' });
}

async function inboundEmailFromWebhookBody(body: unknown): Promise<InboundApplicationEmail | null> {
  let parsed: unknown;
  try {
    parsed = parsedJsonBody(body);
  } catch {
    return null;
  }
  const resend = resendReceivedBodySchema.safeParse(parsed);
  if (resend.success) {
    const sanitized = {
      rawJson: {
        provider: 'resend',
        email_id: resend.data.data.email_id,
        message_id: resend.data.data.message_id,
        to: resend.data.data.to,
        subject: resend.data.data.subject,
      },
    };
    const fallback: InboundApplicationEmail = {
      provider: 'resend',
      providerMessageId: resend.data.data.message_id || resend.data.data.email_id,
      from: resend.data.data.from,
      to: resend.data.data.to.map((item) => item.trim().toLowerCase()).filter(Boolean),
      subject: resend.data.data.subject,
      receivedAt: resend.data.data.created_at ? new Date(resend.data.data.created_at) : undefined,
      raw: sanitized.rawJson,
    };
    return retrieveResendReceivedEmail({ emailId: resend.data.data.email_id, fallback });
  }

  const direct = directInboundBodySchema.safeParse(parsed);
  if (!direct.success) return null;
  const sanitized = {
    rawJson: {
      provider: direct.data.provider,
      provider_message_id: direct.data.provider_message_id,
      from: direct.data.from,
      to: allRecipients(direct.data),
      subject: direct.data.subject,
    },
  };
  return {
    provider: direct.data.provider,
    providerMessageId: direct.data.provider_message_id,
    from: direct.data.from,
    to: allRecipients(direct.data),
    subject: direct.data.subject,
    text: direct.data.text,
    html: direct.data.html,
    receivedAt: direct.data.received_at ? new Date(direct.data.received_at) : undefined,
    authentication: direct.data.authentication,
    raw: sanitized.rawJson,
  };
}

export async function applicationEmailRoutes(fastify: FastifyInstance) {
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body);
  });

  fastify.get('/application-email', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    const aliases = await db
      .select({
        alias: application_email_aliases.alias,
        generated_resume_id: application_email_aliases.generated_resume_id,
        forward_to: application_email_aliases.forward_to,
        status: application_email_aliases.status,
        created_at: application_email_aliases.created_at,
      })
      .from(application_email_aliases)
      .where(eq(application_email_aliases.user_id, userId))
      .orderBy(desc(application_email_aliases.created_at))
      .limit(50);
    /* `configured` says an environment variable is set. `tracking_active` says employer replies
     * will actually come back through Litos, which is the only one of the two a person cares
     * about, and the two disagreed for the entire life of the 2026-08-08 outage. Both are sent so
     * a client can tell "never set up" apart from "set up and broken". */
    const deliverability = await applicationAliasDeliverability();
    return reply.send({
      configured: isApplicationEmailConfigured(),
      tracking_active: deliverability.deliverable,
      tracking_blocked_reason: deliverability.deliverable ? null : deliverability.reason,
      domain: applicationEmailRouteLabel(),
      route_generation_fingerprint: applicationEmailRouteGenerationFingerprint(),
      forward_to: await applicationForwardingAddress(userId),
      aliases,
    });
  });

  /* WHERE MAIL FROM AN ALIAS IS DELIVERED, as a setting the applicant owns.
   *
   * It was previously whatever address she happened to sign in with, chosen by one argument deep
   * inside the submission runner. Storing it makes it hers: an account claimed with a school
   * address that expires at graduation can point employer replies at a mailbox that will not.
   *
   * Only future aliases and the next write to an existing one are re-pointed. Rewriting the rows
   * of threads already in flight would move a live conversation to a different mailbox without
   * the employer or the applicant asking for it. */
  fastify.put('/application-email/forwarding', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = z.object({ forward_to: z.string().trim().min(3).max(320).nullable() }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'A forwarding email address is required' });
    const userId = request.jwtPayload!.userId;
    const requested = parsed.data.forward_to?.trim().toLowerCase() || null;
    if (requested && !isValidForwardingAddress(requested)) {
      return reply.status(400).send({ error: 'That does not look like an email address' });
    }
    // A destination on our own alias domain forwards our mail to ourselves, forever.
    if (requested && forwardingAddressWouldLoop(requested)) {
      return reply.status(400).send({ error: 'Choose a mailbox you can read, not a Litos application address' });
    }
    try {
      await db.update(users).set({ application_email_forward_to: requested }).where(eq(users.id, userId));
    } catch (error) {
      // A merge is a deploy on Vercel, so this route can be live before
      // `npm run db:application-email-forwarding` has run. Say so rather than answering 500.
      // Through the cause chain: Drizzle wraps the pg error, so the outer `code` is undefined.
      if (isUndefinedColumnError(error)) {
        return reply.status(503).send({ error: 'Forwarding preferences are not available yet' });
      }
      throw error;
    }
    return reply.send({ forward_to: await applicationForwardingAddress(userId) });
  });

  fastify.get('/applications/:id/email-messages', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return reply.status(400).send({ error: 'Invalid application id' });
    const userId = request.jwtPayload!.userId;
    const messages = await db
      .select({
        id: application_email_messages.id,
        alias: application_email_messages.alias,
        direction: application_email_messages.direction,
        from_email: application_email_messages.from_email,
        to_email: application_email_messages.to_email,
        subject: application_email_messages.subject,
        text: application_email_messages.text,
        classification: application_email_messages.classification,
        received_at: application_email_messages.received_at,
        forwarded_at: application_email_messages.forwarded_at,
        created_at: application_email_messages.created_at,
      })
      .from(application_email_messages)
      .where(eq(application_email_messages.generated_resume_id, params.data.id))
      .orderBy(desc(application_email_messages.created_at))
      .limit(50);
    const owned = messages.filter((message) => message.alias);
    const aliases = await db.select({ alias: application_email_aliases.alias })
      .from(application_email_aliases)
      .where(eq(application_email_aliases.user_id, userId));
    const allowed = new Set(aliases.map((item) => item.alias));
    return reply.send({ messages: owned.filter((message) => allowed.has(message.alias)) });
  });

  fastify.post('/webhooks/application-email/inbound', async (request: FastifyRequest, reply: FastifyReply) => {
    const signedByResend = resendProofSignatureMatches(request);
    if (!signedByResend && !inboundSecretMatches(request)) {
      return unauthorized(reply);
    }

    /* This runs only for a fresh, cryptographically verified Resend webhook and before ordinary
     * alias lookup. The proof helper also requires the same provider content GET used by real
     * aliases, so a sending-only or wrong-account key cannot make health report deliverable. */
    if (signedByResend) {
      const event = signedResendCanaryEvent(request.body);
      if (event) {
        if (!signedWebhookRequestMatchesConfiguredEndpoint(request)) {
          fastify.log.error(
            { branch: 'endpoint_mismatch', delivered_host: firstHeader(request.headers['x-forwarded-host']) ?? firstHeader(request.headers.host) },
            'inbound receiving proof REFUSED: signed delivery arrived on a host that is not the configured webhook endpoint',
          );
          return reply.status(400).send({ error: 'Invalid receiving proof' });
        }
        try {
          const canary = await acceptSignedManagedReceivingCanary(event);
          if (canary.kind === 'accepted') {
            // A new proof must be visible immediately rather than after the five-minute negative
            // deliverability cache expires. The response contains no proof or recipient identity.
            resetApplicationAliasDeliverabilityCache();
            return reply.status(202).send({ accepted: true, receiving_proof: 'verified' });
          }
          if (canary.kind === 'rejected') {
            /* Which guard refused, without naming the recipient.
             *
             * This branch answered a bare 400 and logged nothing, and on 2026-08-17 that cost a whole
             * diagnosis: three signed deliveries were refused here and the only way to tell a
             * consumed one-time recipient (the v1/v2 fingerprint guards in
             * acceptSignedManagedReceivingCanary, which require a NEW canary token) from a
             * recipient-shape mismatch was to read the source and guess. The recipient carries the
             * canary token so it is never logged; the recipient COUNT is the distinguishing fact and
             * carries no secret. */
            fastify.log.error(
              { branch: 'canary_rejected', recipient_count: event.recipients.length, has_email_id: Boolean(event.emailId.trim()) },
              'inbound receiving proof REFUSED: the signed canary was rejected. recipient_count other than 1 means the delivery was copied or carried a foreign recipient; recipient_count of 1 narrows it to a durable-row guard - either this provider message already stored a DIFFERENT proof, or a v1/v2 fingerprint row marks this one-time recipient as consumed, which needs a NEW LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN rather than a retry',
            );
            return reply.status(400).send({ error: 'Invalid receiving proof' });
          }
          /* Two causes reach here and they need different actions, so the message must not pick one:
           * the delivery genuinely was not addressed to the canary (ordinary alias mail, which is
           * expected and harmless), or the managed route is not configured at all so no canary
           * recipient could be derived to compare against. */
          fastify.log.warn(
            { branch: 'not_canary', recipient_count: event.recipients.length },
            'signed Resend delivery was not treated as the canary, either because it is ordinary alias mail or because no managed canary recipient is configured; falling through to ordinary alias processing',
          );
        } catch (err) {
          fastify.log.error({ err, branch: 'proof_unavailable' }, 'inbound receiving proof could not be evaluated');
          return reply.status(503).send({ error: 'Receiving proof is unavailable' });
        }
      }
    }

    const inbound = await inboundEmailFromWebhookBody(request.body);
    if (!inbound) {
      fastify.log.warn(
        { branch: 'invalid_inbound_payload', signed_by_resend: signedByResend },
        'inbound email REFUSED: payload did not parse as an inbound email for any known alias',
      );
      return reply.status(400).send({ error: 'Invalid inbound email payload' });
    }
    const result = await processInboundApplicationEmail(inbound);

    /* An accepted delivery is also proof the route works, and it used to be discarded.
     *
     * Only the cron-sent canary wrote proof, and its recipient embeds a token that is write-only in
     * Vercel, so nothing could re-prove the route between daily runs. Real employer mail arrives on
     * this same path through the same MX, signature and receiving key; recording it means the route
     * re-proves itself from traffic it already gets. Strictly additive: a failure here cannot change
     * the answer this request already earned. */
    if (signedByResend && result.accepted) {
      const delivery = signedResendCanaryEvent(request.body);
      if (delivery && signedWebhookRequestMatchesConfiguredEndpoint(request)) {
        try {
          /* Only when a refresh is actually wanted.
           *
           * Recording costs a Resend content GET, and that GET happens inside a provider webhook the
           * provider will time out. Doing it on every accepted delivery would add that round trip to
           * mail this route already handles fine, to rewrite a proof that is not close to expiring.
           * Gated this way it fires while the proof is inside the canary's refresh lead - or expired,
           * which is the state that blocks submissions - and is skipped the rest of the time. */
          if (await managedReceivingProofNeedsRefresh()
            && await recordManagedReceivingProofFromDelivery(delivery)) {
            resetApplicationAliasDeliverabilityCache();
            fastify.log.info('receiving proof refreshed from an ordinary accepted inbound delivery');
          }
        } catch (err) {
          fastify.log.warn({ err }, 'accepted inbound delivery could not be recorded as receiving proof');
        }
      }
    }

    return reply.status(result.accepted ? 202 : 404).send(result);
  });
}
