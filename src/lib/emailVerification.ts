import { composioRequest } from './composioApi';

const CODE_CONTEXT = /\b(?:verification|security|authentication|confirmation|one[ -]?time|passcode|otp)\b/i;
const CODE_PATTERN = /(?<!\d)(\d{4,8})(?!\d)/g;
const MAX_CODE_AGE_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 30_000;

const PORTAL_SENDER_DOMAINS: Array<{ portal: RegExp; senders: string[] }> = [
  { portal: /(?:^|\.)greenhouse\.io$/i, senders: ['greenhouse.io', 'grnh.se'] },
  { portal: /(?:^|\.)lever\.co$/i, senders: ['lever.co'] },
  { portal: /(?:^|\.)ashbyhq\.com$/i, senders: ['ashbyhq.com'] },
  { portal: /(?:^|\.)smartrecruiters\.com$/i, senders: ['smartrecruiters.com'] },
  { portal: /(?:^|\.)(?:myworkdayjobs|workday)\.com$/i, senders: ['workday.com', 'myworkday.com', 'myworkdayjobs.com'] },
];

type EmailProvider = 'gmail' | 'outlook';

type EmailMessage = {
  provider: EmailProvider;
  subject: string;
  sender: string;
  receivedAt: Date | null;
  text: string;
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
      messages.push({ provider, subject, sender, receivedAt: receivedDate(record), text: bodyText(record) });
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
  let host = '';
  try {
    host = new URL(portalUrl).hostname.toLowerCase();
  } catch {
    return [];
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
): VerificationCodeMatch | null {
  const allowedDomains = expectedSenderDomains(portalUrl);
  if (allowedDomains.length === 0 || Number.isNaN(requestedAt.getTime())) return null;
  const earliest = requestedAt.getTime() - CLOCK_SKEW_MS;
  const latest = requestedAt.getTime() + MAX_CODE_AGE_MS;

  const matches = payloads
    .flatMap(({ provider, data }) => messagesFromPayload(data, provider))
    .flatMap((message) => {
      if (!message.receivedAt) return [];
      const received = message.receivedAt.getTime();
      if (received < earliest || received > latest) return [];
      const domain = senderDomain(message.sender);
      if (!domain || !allowedSender(domain, allowedDomains)) return [];
      const code = extractCodeFromVerificationText(`${message.subject}\n${message.text}`);
      return code ? [{ message, code, domain }] : [];
    })
    .sort((left, right) => right.message.receivedAt!.getTime() - left.message.receivedAt!.getTime());

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
  return Boolean(process.env.COMPOSIO_API_KEY?.trim());
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
  executor?: EmailToolExecutor;
}): Promise<VerificationCodeMatch | null> {
  if (!options.executor && !isAutomaticEmailVerificationConfigured()) return null;
  const execute = options.executor ?? defaultExecutor();
  const after = new Date(options.requestedAt.getTime() - CLOCK_SKEW_MS);
  const gmailQuery = `after:${after.toISOString().slice(0, 10).replace(/-/g, '/')} {subject:"verification code" subject:"security code" subject:passcode subject:OTP}`;

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
        query: '"verification code" OR "security code" OR passcode OR OTP',
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
  return extractVerificationCode(payloads, options.portalUrl, options.requestedAt);
}
