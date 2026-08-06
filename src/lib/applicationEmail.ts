import { createHash, createHmac } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { application_email_aliases, application_email_messages } from '../db/schema';
import { emailSender, sendEmail, type OutboundEmail } from './email';
import { PRODUCT_NAME } from './product';

type InboundMessage = {
  providerMessageId?: string;
  fromEmail?: string;
  fromName?: string;
  toEmail: string;
  recipientEmails?: string[];
  subject: string;
  textBody?: string;
  htmlBody?: string;
  rawJson?: unknown;
};

const LOCAL_PART_PREFIX = 'apply';

export function applicationEmailDomain(): string | null {
  const domain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return null;
  return domain;
}

function aliasSecret(): string | null {
  const configured = process.env.LITOS_APPLICATION_EMAIL_SECRET?.trim()
    || process.env.JWT_SIGNING_SECRET?.trim();
  return configured || null;
}

export function applicationAliasLocalPart(userId: string, applicationId: string): string {
  const secret = aliasSecret();
  if (!secret) throw new Error('Application email alias secret is not configured');
  const digest = createHmac('sha256', secret)
    .update(`${userId}:${applicationId}`)
    .digest('base64url')
    .slice(0, 18)
    .toLowerCase();
  return `${LOCAL_PART_PREFIX}-${digest}`;
}

export function applicationAliasEmail(userId: string, applicationId: string): string | null {
  const domain = applicationEmailDomain();
  if (!domain || !aliasSecret()) return null;
  return `${applicationAliasLocalPart(userId, applicationId)}@${domain}`;
}

export async function ensureApplicationEmailAlias(input: {
  userId: string;
  applicationId: string;
  forwardingEmail: string | null | undefined;
}): Promise<string | null> {
  const forwardingEmail = input.forwardingEmail?.trim().toLowerCase();
  const email = applicationAliasEmail(input.userId, input.applicationId);
  if (!email || !forwardingEmail) return null;
  const localPart = email.slice(0, email.indexOf('@'));
  const [row] = await db.insert(application_email_aliases)
    .values({
      user_id: input.userId,
      generated_resume_id: input.applicationId,
      local_part: localPart,
      email,
      forwarding_email: forwardingEmail,
      enabled: true,
      updated_at: new Date(),
    })
    .onConflictDoUpdate({
      target: application_email_aliases.generated_resume_id,
      set: {
        forwarding_email: forwardingEmail,
        enabled: true,
        updated_at: new Date(),
      },
    })
    .returning({ email: application_email_aliases.email });
  return row?.email ?? email;
}

export function plainTextFromHtml(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export function inboundDedupeKey(input: {
  aliasId: string;
  providerMessageId?: string;
  fromEmail?: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
}): string {
  if (input.providerMessageId?.trim()) return `provider:${input.aliasId}:${input.providerMessageId.trim()}`;
  const digest = createHash('sha256')
    .update([
      input.aliasId,
      input.fromEmail?.trim().toLowerCase() ?? '',
      input.subject.trim(),
      input.textBody ?? '',
      input.htmlBody ?? '',
    ].join('\n'))
    .digest('hex');
  return `body:${input.aliasId}:${digest}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlBlock(value: string): string {
  const paragraphs = value
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
  return paragraphs.length
    ? paragraphs.map((part) => `<p>${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('')
    : '<p>No plain-text body was included.</p>';
}

export function buildForwardedApplicationEmail(input: {
  inbound: InboundMessage;
  forwardingEmail: string;
  applicationEmail: string;
}): OutboundEmail {
  const body = input.inbound.htmlBody?.trim()
    ? input.inbound.htmlBody
    : htmlBlock(input.inbound.textBody ?? '');
  const from = [
    input.inbound.fromName,
    input.inbound.fromEmail ? `<${input.inbound.fromEmail}>` : undefined,
  ].filter(Boolean).join(' ').trim() || 'Unknown sender';
  return {
    from: emailSender(),
    to: [input.forwardingEmail],
    reply_to: input.inbound.fromEmail,
    subject: `[${PRODUCT_NAME} application] ${input.inbound.subject || 'Employer email'}`,
    text: [
      `Forwarded by ${PRODUCT_NAME}.`,
      `Original from: ${from}`,
      `Original to: ${input.inbound.toEmail}`,
      '',
      input.inbound.textBody || plainTextFromHtml(body),
    ].join('\n'),
    html: [
      `<p>Forwarded by ${PRODUCT_NAME}.</p>`,
      `<p>Original from: ${escapeHtml(from)}<br>Original to: ${escapeHtml(input.inbound.toEmail)}</p>`,
      body,
    ].join(''),
  };
}

function uniqueEmails(values: Array<string | undefined>): string[] {
  return [...new Set(values
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value)))];
}

export async function recordAndForwardApplicationEmail(input: {
  inbound: InboundMessage;
  fetchImpl?: typeof fetch;
}): Promise<{ status: 'forwarded' | 'duplicate' | 'not_found' | 'disabled' | 'failed'; messageId?: string }> {
  const recipients = uniqueEmails([input.inbound.toEmail, ...(input.inbound.recipientEmails ?? [])]);
  if (recipients.length === 0) return { status: 'not_found' };
  const [alias] = await db.select().from(application_email_aliases)
    .where(and(
      inArray(application_email_aliases.email, recipients),
      eq(application_email_aliases.enabled, true),
    ))
    .limit(1);
  if (!alias) return { status: 'not_found' };
  const dedupeKey = inboundDedupeKey({
    aliasId: alias.id,
    providerMessageId: input.inbound.providerMessageId,
    fromEmail: input.inbound.fromEmail,
    subject: input.inbound.subject || 'Employer email',
    textBody: input.inbound.textBody,
    htmlBody: input.inbound.htmlBody,
  });

  const [inserted] = await db.insert(application_email_messages)
    .values({
      alias_id: alias.id,
      user_id: alias.user_id,
      generated_resume_id: alias.generated_resume_id,
      provider_message_id: input.inbound.providerMessageId,
      from_email: input.inbound.fromEmail,
      from_name: input.inbound.fromName,
      to_email: alias.email,
      subject: input.inbound.subject || 'Employer email',
      text_body: input.inbound.textBody,
      html_body: input.inbound.htmlBody,
      dedupe_key: dedupeKey,
      raw_json: input.inbound.rawJson,
    })
    .onConflictDoNothing({ target: application_email_messages.dedupe_key })
    .returning({ id: application_email_messages.id, forwarded_at: application_email_messages.forwarded_at });
  const [message] = inserted
    ? [inserted]
    : await db.select({
      id: application_email_messages.id,
      forwarded_at: application_email_messages.forwarded_at,
    })
      .from(application_email_messages)
      .where(eq(application_email_messages.dedupe_key, dedupeKey))
      .limit(1);
  if (!message) return { status: 'failed' };
  if (message.forwarded_at) return { status: 'duplicate', messageId: message.id };

  if (!alias.forwarding_email || !alias.enabled) return { status: 'disabled', messageId: message.id };

  const [claimed] = await db.update(application_email_messages)
    .set({ forwarding_claimed_at: new Date() })
    .where(sql`
      ${application_email_messages.id} = ${message.id}
      and ${application_email_messages.forwarded_at} is null
      and (
        ${application_email_messages.forwarding_claimed_at} is null
        or ${application_email_messages.forwarding_claimed_at} < now() - interval '10 minutes'
      )
    `)
    .returning({ id: application_email_messages.id });
  if (!claimed) return { status: 'duplicate', messageId: message.id };

  try {
    const forwardedId = await sendEmail(buildForwardedApplicationEmail({
      inbound: input.inbound,
      forwardingEmail: alias.forwarding_email,
      applicationEmail: alias.email,
    }), input.fetchImpl);
    await db.update(application_email_messages)
      .set({ forwarded_message_id: forwardedId, forwarded_at: new Date(), forward_error: null })
      .where(eq(application_email_messages.id, message.id));
    return { status: 'forwarded', messageId: message.id };
  } catch (error) {
    await db.update(application_email_messages)
      .set({
        forward_error: String((error as Error)?.message ?? error).slice(0, 2000),
        forwarding_claimed_at: null,
      })
      .where(eq(application_email_messages.id, message.id));
    return { status: 'failed', messageId: message.id };
  }
}

export async function applicationEmailHealth() {
  const domainConfigured = Boolean(applicationEmailDomain());
  const inboundSecretConfigured = Boolean(process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET?.trim());
  const forwardingConfigured = Boolean(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM?.trim());
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(application_email_aliases)
    .where(eq(application_email_aliases.enabled, true));
  return {
    domain_configured: domainConfigured,
    inbound_webhook_configured: inboundSecretConfigured,
    forwarding_configured: forwardingConfigured,
    enabled_aliases: count,
  };
}
