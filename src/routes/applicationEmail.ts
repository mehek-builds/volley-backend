import { createHmac, timingSafeEqual } from 'crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { application_email_aliases, application_email_messages } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import {
  type InboundApplicationEmail,
  inboundWebhookSecret,
  isApplicationEmailConfigured,
  processInboundApplicationEmail,
  retrieveResendReceivedEmail,
} from '../lib/applicationEmail';

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

function inboundSecretMatches(request: FastifyRequest): boolean {
  const secret = inboundWebhookSecret();
  const timestampHeader = request.headers['x-litos-webhook-timestamp'];
  const signatureHeader = request.headers['x-litos-webhook-signature'];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const provided = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!secret || !timestamp || !provided) return false;
  const epochMs = Number(timestamp);
  if (!Number.isFinite(epochMs) || Math.abs(Date.now() - epochMs) > WEBHOOK_MAX_SKEW_MS) return false;
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${JSON.stringify(request.body ?? {})}`)
    .digest('hex');
  return safeEqual(provided, expected);
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

function unauthorized(reply: FastifyReply) {
  return reply.status(401).send({ error: 'Invalid inbound email webhook secret' });
}

async function inboundEmailFromWebhookBody(body: unknown): Promise<InboundApplicationEmail | null> {
  const resend = resendReceivedBodySchema.safeParse(body);
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

  const direct = directInboundBodySchema.safeParse(body);
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
    raw: sanitized.rawJson,
  };
}

export async function applicationEmailRoutes(fastify: FastifyInstance) {
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
    return reply.send({
      configured: isApplicationEmailConfigured(),
      domain: process.env.LITOS_APPLICATION_EMAIL_DOMAIN?.trim() || null,
      aliases,
    });
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
    if (!inboundSecretMatches(request)) {
      return unauthorized(reply);
    }

    const inbound = await inboundEmailFromWebhookBody(request.body);
    if (!inbound) return reply.status(400).send({ error: 'Invalid inbound email payload' });
    const result = await processInboundApplicationEmail(inbound);
    return reply.status(result.accepted ? 202 : 404).send(result);
  });
}
