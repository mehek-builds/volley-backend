import { composioRequest } from './composioApi';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db';
import { application_email_messages } from '../db/schema';

const CODE_CONTEXT = /\b(?:verification|security|authentication|confirmation|one[ -]?time|passcode|otp)\b/i;
// Most providers send a 4 to 8 digit code. Greenhouse currently sends an 8-character
// alphanumeric code, so support that shape without treating ordinary words as credentials. An
// alphanumeric candidate must contain at least one letter and one digit and still has to appear
// near verification language below.
const CODE_PATTERN = /(?<![A-Z0-9])((?=[A-Z0-9]{8}(?![A-Z0-9]))(?=[A-Z0-9]{0,7}[A-Z])(?=[A-Z0-9]{0,7}\d)[A-Z0-9]{8}|\d{4,8})(?![A-Z0-9])/gi;
const MAX_CODE_AGE_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 30_000;

const PORTAL_SENDER_DOMAINS: Array<{ portal: RegExp; senders: string[] }> = [
  { portal: /(?:^|\.)greenhouse\.io$/i, senders: ['greenhouse.io', 'grnh.se', 'us.greenhouse-mail.io'] },
  { portal: /(?:^|\.)lever\.co$/i, senders: ['lever.co'] },
  { portal: /(?:^|\.)ashbyhq\.com$/i, senders: ['ashbyhq.com'] },
  { portal: /(?:^|\.)smartrecruiters\.com$/i, senders: ['smartrecruiters.com'] },
  { portal: /(?:^|\.)(?:myworkdayjobs|workday)\.com$/i, senders: ['workday.com', 'myworkday.com', 'myworkdayjobs.com'] },
];

type EmailProvider = 'gmail' | 'outlook' | 'litos';

type EmailMessage = {
  provider: EmailProvider;
  subject: string;
  sender: string;
  receivedAt: Date | null;
  text: string;
  recipients: string[];
  senderAuthenticated: boolean;
};

export type VerificationCodeMatch = {
  code: string;
  provider: EmailProvider;
  receivedAt: string;
  senderDomain: string;
};

export type EmailToolExecutor = (
  tool: string,
  input: { userId: string; version: string; arguments: Record<string, unknown> },
) => Promise<{ successful: boolean; data: Record<string, unknown>; error?: string | null }>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function headerValue(record: Record<string, unknown>, name: string): string {
  const headers = record.headers ?? asRecord(record.payload)?.headers;
  if (!Array.isArray(headers)) return '';
  const match = headers.find((header) => {
    const item = asRecord(header);
    return item && firstString(item, ['name']).toLowerCase() === name.toLowerCase();
  });
  return match ? firstString(asRecord(match) ?? {}, ['value']) : '';
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function bodyText(record: Record<string, unknown>): string {
  const direct = firstString(record, ['text', 'bodyText', 'body_text', 'messageText', 'message_text', 'snippet', 'bodyPreview']);
  const body = record.body;
  if (typeof body === 'string') return `${direct}\n${body}`.trim();
  const bodyRecord = asRecord(body);
  if (bodyRecord) {
    const content = firstString(bodyRecord, ['content', 'text', 'value']);
    const encoded = firstString(bodyRecord, ['data']);
    return `${direct}\n${content}\n${encoded ? decodeBase64Url(encoded) : ''}`.trim();
  }
  const payload = asRecord(record.payload);
  const encoded = payload ? firstString(asRecord(payload.body) ?? {}, ['data']) : '';
  return `${direct}\n${encoded ? decodeBase64Url(encoded) : ''}`.trim();
}

function recipientAddresses(record: Record<string, unknown>): string[] {
  const direct = firstString(record, ['to', 'recipient', 'recipients', 'deliveredTo', 'delivered_to'])
    || headerValue(record, 'To')
    || headerValue(record, 'Delivered-To')
    || headerValue(record, 'X-Original-To');
  const structured = record.toRecipients ?? record.to_recipients;
  return [...`${direct}\n${structured ? JSON.stringify(structured) : ''}`
    .matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+/gi)]
    .map((match) => match[0].toLowerCase());
}

function authenticatedSender(record: Record<string, unknown>, sender: string): boolean {
  const authentication = firstString(record, ['authenticationResults', 'authentication_results'])
    || headerValue(record, 'Authentication-Results');
  if (/\bdmarc=pass\b/i.test(authentication) && !/\bdmarc=fail\b/i.test(authentication)) return true;
  const fromDomain = senderDomain(sender);
  if (!fromDomain) return false;
  const aligned = (identity: string | undefined) => Boolean(identity)
    && (allowedSender(fromDomain, [identity!]) || allowedSender(identity!, [fromDomain]));
  const dkimIdentity = authentication.match(/\bheader\.d=([a-z0-9.-]+)/i)?.[1]
    ?? authentication.match(/\bdkim=pass\b[^;\r\n]*\bd=([a-z0-9.-]+)/i)?.[1];
  if (/\bdkim=pass\b/i.test(authentication) && aligned(dkimIdentity)) return true;
  const spfIdentity = authentication.match(/\bsmtp\.mailfrom=([^\s;@]+@)?([a-z0-9.-]+)/i)?.[2]
    ?? authentication.match(/\bspf=pass\b[^;\r\n]*\bmailfrom=([^\s;@]+@)?([a-z0-9.-]+)/i)?.[2];
  return /\bspf=pass\b/i.test(authentication) && aligned(spfIdentity);
}

function receivedDate(record: Record<string, unknown>): Date | null {
  const raw = firstString(record, [
    'receivedDateTime',
    'received_at',
    'receivedAt',
    'date',
    'internalDate',
    'internal_date',
  ]) || headerValue(record, 'Date');
  if (!raw) return null;
  const numeric = Number(raw);
  const date = Number.isFinite(numeric) && numeric > 0 ? new Date(numeric) : new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

function looksLikeMessage(record: Record<string, unknown>): boolean {
  return Boolean(
    firstString(record, ['subject'])
      || headerValue(record, 'Subject')
      || firstString(record, ['sender', 'from', 'from_email', 'senderEmail'])
      || headerValue(record, 'From'),
  );
}

function messagesFromPayload(value: unknown, provider: EmailProvider): EmailMessage[] {
  const messages: EmailMessage[] = [];
  const seen = new Set<object>();

  function visit(node: unknown) {
    if (!node || typeof node !== 'object' || seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const record = node as Record<string, unknown>;
    if (looksLikeMessage(record)) {
      const subject = firstString(record, ['subject']) || headerValue(record, 'Subject');
      const senderValue = record.sender;
      const senderRecord = asRecord(senderValue);
      const emailAddress = senderRecord ? asRecord(senderRecord.emailAddress) : null;
      const sender = firstString(record, ['from', 'from_email', 'senderEmail'])
        || firstString(senderRecord ?? {}, ['address', 'email'])
        || firstString(emailAddress ?? {}, ['address', 'email'])
        || headerValue(record, 'From');
      messages.push({
        provider,
        subject,
        sender,
        receivedAt: receivedDate(record),
        text: bodyText(record),
        recipients: recipientAddresses(record),
        senderAuthenticated: authenticatedSender(record, sender),
      });
    }
    for (const nested of Object.values(record)) visit(nested);
  }

  visit(value);
  return messages;
}

function senderDomain(sender: string): string {
  const match = sender.toLowerCase().match(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-z0-9.-]+)/i);
  return match?.[1]?.replace(/\.$/, '') ?? '';
}

function expectedSenderDomains(portalUrl: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(portalUrl);
  } catch {
    return [];
  }
  const host = parsed.hostname.toLowerCase();
  const controlledQaPortal = process.env.NODE_ENV !== 'production'
    && parsed.pathname.startsWith('/qa/portal-submission');
  if (controlledQaPortal && parsed.searchParams.get('board')?.toLowerCase() === 'greenhouse') {
    return PORTAL_SENDER_DOMAINS[0].senders;
  }
  const configured = PORTAL_SENDER_DOMAINS.find(({ portal }) => portal.test(host));
  return configured?.senders ?? [host];
}

function allowedSender(actual: string, allowed: string[]): boolean {
  return allowed.some((domain) => actual === domain || actual.endsWith(`.${domain}`));
}

function stripMarkup(value: string): string {
  return value
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractCodeFromVerificationText(value: string): string | null {
  const text = stripMarkup(value);
  const candidates = new Set<string>();
  for (const match of text.matchAll(CODE_PATTERN)) {
    const start = Math.max(0, (match.index ?? 0) - 100);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 100);
    if (CODE_CONTEXT.test(text.slice(start, end))) candidates.add(match[1]);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function extractVerificationCode(
  payloads: Array<{ provider: EmailProvider; data: unknown }>,
  portalUrl: string,
  requestedAt: Date,
  expectedRecipient?: string,
  applicationId?: string,
): VerificationCodeMatch | null {
  const allowedDomains = expectedSenderDomains(portalUrl);
  if (allowedDomains.length === 0 || Number.isNaN(requestedAt.getTime())) return null;
  const earliest = requestedAt.getTime() - CLOCK_SKEW_MS;
  const latest = requestedAt.getTime() + MAX_CODE_AGE_MS;
  const recipient = expectedRecipient?.trim().toLowerCase() ?? '';
  if (expectedRecipient && !recipient) return null;
  if (recipient && applicationId && /(?:^app-|\+app-)/i.test(recipient)) {
    const packetPrefix = applicationId.replace(/-/g, '').slice(0, 10).toLowerCase();
    if (!recipient.includes(packetPrefix)) return null;
  }

  const matches = payloads
    .flatMap(({ provider, data }) => messagesFromPayload(data, provider))
    .flatMap((message) => {
      if (recipient && !message.recipients.includes(recipient)) return [];
      if (recipient && !message.senderAuthenticated) return [];
      if (!message.receivedAt) return [];
      const received = message.receivedAt.getTime();
      if (received < earliest || received > latest) return [];
      const domain = senderDomain(message.sender);
      if (!domain || !allowedSender(domain, allowedDomains)) return [];
      const code = extractCodeFromVerificationText(`${message.subject}\n${message.text}`);
      return code ? [{ message, code, domain }] : [];
    })
    .sort((left, right) => right.message.receivedAt!.getTime() - left.message.receivedAt!.getTime());

  if (new Set(matches.map((match) => match.code)).size > 1) return null;
  const best = matches[0];
  if (!best) return null;
  return {
    code: best.code,
    provider: best.message.provider,
    receivedAt: best.message.receivedAt!.toISOString(),
    senderDomain: best.domain,
  };
}

export function isAutomaticEmailVerificationConfigured(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY?.trim() || process.env.LITOS_APPLICATION_EMAIL_DOMAIN?.trim());
}

type LitosVerificationRow = {
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  received_at: Date | null;
  raw_json: unknown;
};

export function extractLitosVerificationCode(
  rows: LitosVerificationRow[],
  portalUrl: string,
  requestedAt: Date,
  expectedRecipient: string,
): VerificationCodeMatch | null {
  const payload = rows.map((row) => {
    const raw = asRecord(row.raw_json);
    const authentication = asRecord(raw?.authentication);
    const authenticationResults = authentication
      ? Object.entries(authentication).map(([name, verdict]) => `${name}=${String(verdict)}`).join(' ')
      : '';
    return {
      subject: row.subject ?? '',
      from: row.from_email ?? '',
      to: row.to_email ?? '',
      text: `${row.text ?? ''}\n${row.html ?? ''}`,
      received_at: row.received_at?.toISOString() ?? '',
      authenticationResults,
    };
  });
  return extractVerificationCode(
    [{ provider: 'litos', data: payload }],
    portalUrl,
    requestedAt,
    expectedRecipient,
  );
}

async function findLitosVerificationCode(options: {
  userId: string;
  portalUrl: string;
  requestedAt: Date;
  expectedRecipient: string;
  applicationId?: string;
}): Promise<VerificationCodeMatch | null> {
  const recipient = options.expectedRecipient.trim().toLowerCase();
  if (!recipient) return null;
  if (options.applicationId) {
    const packetPrefix = options.applicationId.replace(/-/g, '').slice(0, 10).toLowerCase();
    if (!recipient.includes(packetPrefix)) return null;
  }
  const earliest = new Date(options.requestedAt.getTime() - CLOCK_SKEW_MS);
  const latest = new Date(options.requestedAt.getTime() + MAX_CODE_AGE_MS);
  const rows = await db.select({
    from_email: application_email_messages.from_email,
    to_email: application_email_messages.to_email,
    subject: application_email_messages.subject,
    text: application_email_messages.text,
    html: application_email_messages.html,
    received_at: application_email_messages.received_at,
    raw_json: application_email_messages.raw_json,
  }).from(application_email_messages).where(and(
    eq(application_email_messages.user_id, options.userId),
    eq(application_email_messages.alias, recipient),
    eq(application_email_messages.generated_resume_id, options.applicationId ?? ''),
    gte(application_email_messages.received_at, earliest),
    lte(application_email_messages.received_at, latest),
  )).orderBy(desc(application_email_messages.received_at)).limit(10);
  return extractLitosVerificationCode(rows, options.portalUrl, options.requestedAt, recipient);
}

function defaultExecutor(): EmailToolExecutor {
  return async (tool, input) => composioRequest(`/api/v3.1/tools/execute/${encodeURIComponent(tool)}`, {
    method: 'POST',
    body: {
      user_id: input.userId,
      version: input.version,
      arguments: input.arguments,
      allow_tracing: false,
    },
    signal: AbortSignal.timeout(10_000),
  });
}

export async function findComposioVerificationCode(options: {
  userId: string;
  portalUrl: string;
  requestedAt: Date;
  expectedRecipient?: string;
  applicationId?: string;
  executor?: EmailToolExecutor;
}): Promise<VerificationCodeMatch | null> {
  if (!options.expectedRecipient?.trim()) return null;
  const litosMatch = await findLitosVerificationCode({
    userId: options.userId,
    portalUrl: options.portalUrl,
    requestedAt: options.requestedAt,
    expectedRecipient: options.expectedRecipient,
    applicationId: options.applicationId,
  }).catch(() => null);
  if (litosMatch) return litosMatch;
  if (!options.executor && !process.env.COMPOSIO_API_KEY?.trim()) return null;
  const execute = options.executor ?? defaultExecutor();
  const after = new Date(options.requestedAt.getTime() - CLOCK_SKEW_MS);
  const recipientQuery = options.expectedRecipient?.trim() ? ` to:${options.expectedRecipient.trim()}` : '';
  const gmailQuery = `after:${after.toISOString().slice(0, 10).replace(/-/g, '/')}${recipientQuery} {subject:"verification code" subject:"security code" subject:passcode subject:OTP}`;

  const calls = await Promise.allSettled([
    execute('GMAIL_FETCH_EMAILS', {
      userId: options.userId,
      version: process.env.COMPOSIO_TOOLKIT_VERSION_GMAIL ?? '20260702_01',
      arguments: { query: gmailQuery, max_results: 5, include_payload: true, user_id: 'me' },
    }).then((result) => ({ provider: 'gmail' as const, result })),
    execute('OUTLOOK_SEARCH_MESSAGES', {
      userId: options.userId,
      version: process.env.COMPOSIO_TOOLKIT_VERSION_OUTLOOK ?? '20260714_00',
      arguments: {
        query: `to:${options.expectedRecipient.trim()} AND ("verification code" OR "security code" OR passcode OR OTP)`,
        size: 5,
        enable_top_results: false,
      },
    }).then((result) => ({ provider: 'outlook' as const, result })),
  ]);

  const payloads: Array<{ provider: EmailProvider; data: unknown }> = [];
  for (const call of calls) {
    if (call.status !== 'fulfilled' || !call.value.result.successful) continue;
    payloads.push({ provider: call.value.provider, data: call.value.result.data });
  }
  return extractVerificationCode(
    payloads,
    options.portalUrl,
    options.requestedAt,
    options.expectedRecipient,
    options.applicationId,
  );
}
