import { createHash, timingSafeEqual } from 'crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { application_email_aliases, application_email_messages, generated_resumes } from '../db/schema';
import { readApplicationReview } from './applicationReview';
import { emailSender, sendEmail, type OutboundEmail } from './email';

export type ApplicationEmailIdentity = {
  alias: string;
  forwards_to: string;
  mode: 'litos_application_alias';
};

export type ApplicationEmailClassification =
  | 'submission_confirmation'
  | 'interview_request'
  | 'verification_code'
  | 'recruiter_reply'
  | 'other';

export type InboundApplicationEmail = {
  provider?: string;
  providerMessageId?: string;
  from?: string;
  to: string[];
  subject?: string;
  text?: string;
  html?: string;
  receivedAt?: Date;
  raw?: unknown;
};

type ResendReceivedEmail = {
  id?: string;
  to?: string[];
  from?: string;
  created_at?: string;
  subject?: string;
  html?: string | null;
  text?: string | null;
  message_id?: string;
};

function configuredMailbox(): { local: string; domain: string; address: string } | null {
  const mailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX?.trim().toLowerCase();
  const match = mailbox?.match(/^([^@\s]+)@([a-z0-9.-]+\.[a-z]{2,})$/i);
  if (!match) return null;
  const local = match[1];
  const domain = match[2];
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)) return null;
  return { local, domain, address: `${local}@${domain}` };
}

function configuredDomain(): string | null {
  const domain = process.env.LITOS_APPLICATION_EMAIL_DOMAIN?.trim().toLowerCase();
  return domain && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : null;
}

export function applicationAliasSecret(): string | null {
  const configured = process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET?.trim()
    || process.env.LITOS_APPLICATION_EMAIL_SECRET?.trim()
    || process.env.JWT_SIGNING_SECRET?.trim();
  return configured || null;
}

export function inboundWebhookSecret(): string | null {
  const configured = process.env.RESEND_WEBHOOK_SECRET?.trim()
    || process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET?.trim()
    || process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_SECRET?.trim();
  return configured || null;
}

export function isApplicationEmailConfigured(): boolean {
  return Boolean((configuredMailbox() || configuredDomain()) && applicationAliasSecret());
}

export function applicationEmailRouteLabel(): string | null {
  return configuredMailbox()?.address || configuredDomain();
}

function digest(value: string, length = 10): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function applicationAliasFor(userId: string, applicationId: string): string | null {
  const secret = applicationAliasSecret();
  if (!secret) return null;
  const token = digest(`${secret}:${userId}:${applicationId}`, 12);
  const route = `app-${applicationId.replace(/-/g, '').slice(0, 10)}-${token}`;
  const mailbox = configuredMailbox();
  if (mailbox) return `${mailbox.local}+${route}@${mailbox.domain}`;
  const domain = configuredDomain();
  if (!domain) return null;
  return `${route}@${domain}`;
}

export async function ensureApplicationEmailAlias(input: {
  userId: string;
  applicationId: string;
  forwardTo?: string | null;
}): Promise<ApplicationEmailIdentity | null> {
  const forwardTo = input.forwardTo?.trim().toLowerCase();
  const alias = applicationAliasFor(input.userId, input.applicationId);
  if (!alias || !forwardTo) return null;
  await db.insert(application_email_aliases).values({
    alias,
    user_id: input.userId,
    generated_resume_id: input.applicationId,
    forward_to: forwardTo,
    updated_at: new Date(),
  }).onConflictDoUpdate({
    target: application_email_aliases.alias,
    set: {
      forward_to: forwardTo,
      status: 'active',
      updated_at: new Date(),
    },
  });
  return { alias, forwards_to: forwardTo, mode: 'litos_application_alias' };
}

export function classifyApplicationEmail(subject = '', text = ''): ApplicationEmailClassification {
  const haystack = `${subject}\n${text}`.toLowerCase();
  if (/\b(interview|schedule a call|speak with|availability|availability for a call|calendar)\b/.test(haystack)) {
    return 'interview_request';
  }
  if (/\b(verification code|security code|one[- ]?time|otp|passcode|confirm your email)\b/.test(haystack)) {
    return 'verification_code';
  }
  if (/\b(thank you for applying|thanks for applying|application (?:has been )?received|we received your application|successfully submitted|application submitted)\b/.test(haystack)) {
    return 'submission_confirmation';
  }
  if (/\b(recruiter|talent|hiring team|next steps|following up)\b/.test(haystack)) {
    return 'recruiter_reply';
  }
  return 'other';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function forwardEmailPayload(input: {
  alias: string;
  forwardTo: string;
  inbound: InboundApplicationEmail;
  classification: ApplicationEmailClassification;
}): OutboundEmail {
  const subject = input.inbound.subject?.trim() || '(no subject)';
  const from = input.inbound.from?.trim() || 'unknown sender';
  const bodyText = input.inbound.text?.trim() || input.inbound.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || '';
  return {
    from: emailSender(),
    to: [input.forwardTo],
    reply_to: input.inbound.from?.trim() || input.alias,
    subject: `[Litos] ${subject}`,
    text: [
      `Litos received this application email at ${input.alias}.`,
      `From: ${from}`,
      `Classification: ${input.classification}`,
      ``,
      bodyText,
    ].join('\n'),
    html: [
      `<p>Litos received this application email at ${escapeHtml(input.alias)}.</p>`,
      `<p><strong>From:</strong> ${escapeHtml(from)}</p>`,
      `<p><strong>Classification:</strong> ${escapeHtml(input.classification)}</p>`,
      `<p>${escapeHtml(bodyText || 'No plain-text body was provided.').replace(/\n/g, '<br>')}</p>`,
    ].join(''),
  };
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function inboundSecretMatches(value: string | undefined): boolean {
  const expected = inboundWebhookSecret();
  return Boolean(expected && value && safeEqual(value, expected));
}

export async function retrieveResendReceivedEmail(input: {
  emailId: string;
  fallback: InboundApplicationEmail;
}): Promise<InboundApplicationEmail> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) throw new Error('RESEND_API_KEY is required to read received email content');
  const response = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(input.emailId)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!response.ok) {
    throw new Error(`Resend received email lookup failed with ${response.status}`);
  }
  const body = await response.json() as ResendReceivedEmail;
  return {
    provider: 'resend',
    providerMessageId: body.message_id || body.id || input.emailId,
    from: body.from || input.fallback.from,
    to: Array.isArray(body.to) && body.to.length > 0 ? body.to : input.fallback.to,
    subject: body.subject ?? input.fallback.subject,
    text: body.text ?? input.fallback.text,
    html: body.html ?? input.fallback.html,
    receivedAt: body.created_at ? new Date(body.created_at) : input.fallback.receivedAt,
    raw: {
      provider: 'resend',
      email_id: body.id || input.emailId,
      message_id: body.message_id,
      to: body.to,
      subject: body.subject,
    },
  };
}

function dedupeKeyFor(input: InboundApplicationEmail): string {
  const provider = input.provider?.trim().toLowerCase() || 'unknown';
  const providerMessageId = input.providerMessageId?.trim();
  if (providerMessageId) return `provider:${provider}:${providerMessageId}`;
  return `content:${digest(JSON.stringify({
    provider,
    from: input.from?.trim().toLowerCase() || null,
    to: input.to.map((item) => item.trim().toLowerCase()).sort(),
    subject: input.subject?.trim() || null,
    text: input.text?.slice(0, 4096) || null,
    html: input.html?.slice(0, 4096) || null,
    receivedAt: input.receivedAt?.toISOString() || null,
  }), 32)}`;
}

async function markSubmittedFromConfirmation(input: {
  applicationId: string;
  alias: string;
  subject?: string;
  receivedAt: Date;
}) {
  const rows = await db.select().from(generated_resumes).where(eq(generated_resumes.id, input.applicationId)).limit(1);
  const row = rows[0];
  if (!row) return;
  const stored = row.spec as Record<string, unknown>;
  const current = readApplicationReview(stored);
  if (!current || current.status === 'submitted') return;
  const at = input.receivedAt.toISOString();
  const next = {
    ...current,
    status: 'submitted' as const,
    submitted_at: at,
    updated_at: at,
    submission_error: undefined,
    receipt: {
      confirmation_text: input.subject?.trim() || `Application confirmation received at ${input.alias}`,
      final_url: current.portal_url ?? input.alias,
      captured_at: at,
      source: 'email_fallback' as const,
    },
  };
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(next)}::jsonb, true)`,
    pipeline_stage: 'applied',
    pipeline_stage_at: input.receivedAt,
  }).where(and(
    eq(generated_resumes.id, input.applicationId),
    sql`${generated_resumes.spec}->'_review'->>'status' <> 'submitted'`,
  ));
}

export async function processInboundApplicationEmail(input: InboundApplicationEmail): Promise<{
  accepted: boolean;
  alias?: string;
  classification?: ApplicationEmailClassification;
  forwarded?: boolean;
}> {
  const normalizedRecipients = input.to.map((item) => item.trim().toLowerCase()).filter(Boolean);
  const rows = normalizedRecipients.length === 0 ? [] : await db
    .select()
    .from(application_email_aliases)
    .where(inArray(application_email_aliases.alias, normalizedRecipients));
  const aliasRow = rows.find((row) => row.status === 'active');
  if (!aliasRow) return { accepted: false };
  const receivedAt = input.receivedAt ?? new Date();
  const classification = classifyApplicationEmail(input.subject, input.text || input.html);
  const dedupeKey = dedupeKeyFor(input);
  const inserted = await db.insert(application_email_messages).values({
    alias: aliasRow.alias,
    user_id: aliasRow.user_id,
    generated_resume_id: aliasRow.generated_resume_id,
    direction: 'inbound',
    provider: input.provider,
    provider_message_id: input.providerMessageId,
    dedupe_key: dedupeKey,
    from_email: input.from,
    to_email: aliasRow.alias,
    subject: input.subject,
    text: input.text,
    html: input.html,
    classification,
    raw_json: input.raw as Record<string, unknown> | undefined,
    received_at: receivedAt,
  }).onConflictDoNothing({ target: application_email_messages.dedupe_key }).returning({
    id: application_email_messages.id,
    forwarded_at: application_email_messages.forwarded_at,
  });
  const message = inserted[0] ?? (await db
    .select({
      id: application_email_messages.id,
      forwarded_at: application_email_messages.forwarded_at,
    })
    .from(application_email_messages)
    .where(eq(application_email_messages.dedupe_key, dedupeKey))
    .limit(1))[0];
  if (!message || message.forwarded_at) return { accepted: true, alias: aliasRow.alias, classification, forwarded: false };

  const messageId = message.id;
  let forwarded = false;
  const staleClaimBefore = new Date(Date.now() - 10 * 60 * 1000);
  const claimed = await db.update(application_email_messages)
    .set({ forwarding_claimed_at: new Date(), forward_error: null })
    .where(and(
      eq(application_email_messages.id, messageId),
      sql`${application_email_messages.forwarded_at} is null`,
      sql`(${application_email_messages.forwarding_claimed_at} is null or ${application_email_messages.forwarding_claimed_at} < ${staleClaimBefore})`,
    ))
    .returning({ id: application_email_messages.id });
  if (claimed.length === 0) return { accepted: true, alias: aliasRow.alias, classification, forwarded: false };

  try {
    await sendEmail(forwardEmailPayload({
      alias: aliasRow.alias,
      forwardTo: aliasRow.forward_to,
      inbound: input,
      classification,
    }));
    forwarded = true;
    await db.update(application_email_messages)
      .set({ direction: 'forwarded', forwarded_at: new Date(), forward_error: null })
      .where(eq(application_email_messages.id, messageId));
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error).slice(0, 1000);
    await db.update(application_email_messages)
      .set({ forwarding_claimed_at: null, forward_error: message })
      .where(eq(application_email_messages.id, messageId));
    throw error;
  }

  if (classification === 'submission_confirmation' && aliasRow.generated_resume_id) {
    await markSubmittedFromConfirmation({
      applicationId: aliasRow.generated_resume_id,
      alias: aliasRow.alias,
      subject: input.subject,
      receivedAt,
    });
  }
  return { accepted: true, alias: aliasRow.alias, classification, forwarded };
}

export async function applicationEmailHealth(): Promise<{
  domain_configured: boolean;
  inbound_webhook_configured: boolean;
  forwarding_configured: boolean;
  enabled_aliases: number;
}> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(application_email_aliases)
    .where(eq(application_email_aliases.status, 'active'));
  return {
    domain_configured: Boolean(configuredDomain() && applicationAliasSecret()),
    inbound_webhook_configured: Boolean(inboundWebhookSecret()),
    forwarding_configured: Boolean(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM?.trim()),
    enabled_aliases: Number(rows[0]?.count ?? 0),
  };
}
