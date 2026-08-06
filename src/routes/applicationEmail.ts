import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { application_email_aliases, generated_resumes } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import {
  applicationAliasEmail,
  recordAndForwardApplicationEmail,
} from '../lib/applicationEmail';

const paramsSchema = z.object({ id: z.string().uuid() });

const recipientSchema = z.union([
  z.string(),
  z.object({ email: z.string().optional() }),
]);

const inboundSchema = z.object({
  id: z.string().max(500).optional(),
  message_id: z.string().max(500).optional(),
  from: z.union([
    z.string(),
    z.object({ email: z.string().optional(), name: z.string().optional() }),
  ]).optional(),
  from_email: z.string().optional(),
  from_name: z.string().optional(),
  to: z.union([
    z.string(),
    z.array(recipientSchema),
  ]).optional(),
  cc: z.union([z.string(), z.array(z.string())]).optional(),
  envelope_to: z.string().optional(),
  delivered_to: z.string().optional(),
  recipient: z.string().optional(),
  recipients: z.array(recipientSchema).optional(),
  subject: z.string().max(1000).optional(),
  text: z.string().optional(),
  text_body: z.string().optional(),
  html: z.string().optional(),
  html_body: z.string().optional(),
}).passthrough()
  .refine((value) => allRecipients(value).length > 0, 'At least one recipient is required');

const WEBHOOK_MAX_SKEW_MS = 5 * 60_000;

function secretMatches(provided: string | undefined, configured: string): boolean {
  if (!provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signedPayload(body: unknown, timestamp: string): string {
  return `${timestamp}.${JSON.stringify(body ?? {})}`;
}

function freshTimestamp(value: string | undefined, now = Date.now()): boolean {
  if (!value || !/^\d+$/.test(value)) return false;
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && Math.abs(now - timestamp) <= WEBHOOK_MAX_SKEW_MS;
}

function expectedSignature(configured: string, body: unknown, timestamp: string): string {
  return createHmac('sha256', configured).update(signedPayload(body, timestamp)).digest('hex');
}

function authorizeInbound(request: FastifyRequest, reply: FastifyReply): boolean {
  const configured = process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET?.trim();
  if (!configured) {
    reply.status(503).send({ error: 'Application email inbound routing is not configured' });
    return false;
  }
  const timestampHeader = request.headers['x-litos-webhook-timestamp'];
  const signatureHeader = request.headers['x-litos-webhook-signature'];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (
    freshTimestamp(timestamp)
    && secretMatches(signature, expectedSignature(configured, request.body, timestamp!))
  ) return true;
  reply.status(401).send({ error: 'Unauthorized inbound email webhook' });
  return false;
}

function recipientsFrom(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value
    .map((item: unknown) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'email' in item) {
        const email = (item as { email?: unknown }).email;
        return typeof email === 'string' ? email : undefined;
      }
      return undefined;
    })
    .filter((email): email is string => Boolean(email));
}

function stringList(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function allRecipients(value: Record<string, unknown>): string[] {
  return [
    ...recipientsFrom(value.to),
    ...recipientsFrom(value.recipients),
    ...stringList(value.cc),
    value.envelope_to,
    value.delivered_to,
    value.recipient,
  ].filter((email): email is string => Boolean(email));
}

function senderParts(value: z.infer<typeof inboundSchema>) {
  if (typeof value.from === 'string') {
    const email = value.from.match(/<([^>]+)>/)?.[1] ?? value.from;
    const name = value.from.includes('<') ? value.from.slice(0, value.from.indexOf('<')).trim().replace(/^"|"$/g, '') : undefined;
    return { email, name };
  }
  return {
    email: value.from_email ?? value.from?.email,
    name: value.from_name ?? value.from?.name,
  };
}

export async function applicationEmailRoutes(fastify: FastifyInstance) {
  fastify.get('/applications/:id/email', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = paramsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid application id' });
    const userId = request.jwtPayload!.userId;
    const [application] = await db.select({ id: generated_resumes.id })
      .from(generated_resumes)
      .where(and(eq(generated_resumes.id, parsed.data.id), eq(generated_resumes.user_id, userId)))
      .limit(1);
    if (!application) return reply.status(404).send({ error: 'Application not found' });

    const [alias] = await db.select()
      .from(application_email_aliases)
      .where(eq(application_email_aliases.generated_resume_id, application.id))
      .limit(1);
    return reply.send({
      configured: Boolean(applicationAliasEmail(userId, application.id)),
      email: alias?.email ?? applicationAliasEmail(userId, application.id),
      enabled: alias?.enabled ?? false,
      forwarding_email: alias?.forwarding_email ?? request.jwtPayload!.email ?? null,
    });
  });

  fastify.post('/application-email/inbound', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!authorizeInbound(request, reply)) return;
    const parsed = inboundSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid inbound email payload' });
    const sender = senderParts(parsed.data);
    const recipients = allRecipients(parsed.data);
    const result = await recordAndForwardApplicationEmail({
      inbound: {
        providerMessageId: parsed.data.message_id ?? parsed.data.id,
        fromEmail: sender.email,
        fromName: sender.name,
        toEmail: recipients[0] ?? '',
        recipientEmails: recipients,
        subject: parsed.data.subject ?? 'Employer email',
        textBody: parsed.data.text_body ?? parsed.data.text,
        htmlBody: parsed.data.html_body ?? parsed.data.html,
        rawJson: {
          provider_message_id: parsed.data.message_id ?? parsed.data.id,
          from_email: sender.email,
          to: recipients,
          subject: parsed.data.subject ?? 'Employer email',
        },
      },
    });
    const statusCode = result.status === 'not_found' ? 404 : result.status === 'failed' ? 502 : 202;
    return reply.status(statusCode).send(result);
  });
}
