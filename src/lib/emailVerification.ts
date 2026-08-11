import { composioRequest } from './composioApi';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db';
import { application_email_aliases, application_email_messages } from '../db/schema';
import { isControlledTestPortalUrl } from './controlledTestPortal';
import { aliasUsesManagedReceiving, applicationAliasFor, isAliasAddress } from './applicationEmail';
import { applicationAliasDeliverability } from './applicationEmailDeliverability';

const CODE_CONTEXT = /\b(?:verification|security|authentication|confirmation|one[ -]?time|passcode|otp)\b/i;
// Most providers send a 4 to 8 digit code. Greenhouse currently sends an 8-character
// alphanumeric code, so support that shape without treating ordinary words as credentials. An
// alphanumeric candidate must contain at least one letter and one digit and still has to appear
// near verification language below.
const CODE_PATTERN = /(?<![A-Z0-9])((?=[A-Z0-9]{8}(?![A-Z0-9]))(?=[A-Z0-9]{0,7}[A-Z])(?=[A-Z0-9]{0,7}\d)[A-Z0-9]{8}|\d{4,8})(?![A-Z0-9])/gi;
/* Greenhouse also issues letter-only, case-sensitive 8-character codes. Treating every 8-letter
 * word as a credential would turn ordinary email prose into a submit capability, so this format is
 * accepted only where the message grammar explicitly identifies the token as a code. */
const CONTEXTUAL_ALPHA_CODE_PATTERNS = [
  /\b(?:verification|security|authentication|confirmation|one[ -]?time)\s+code\s*(?:is|[:=-])\s*([A-Za-z]{8})\b/gi,
  /\b(?:passcode|otp)\s*(?:is|[:=-])\s*([A-Za-z]{8})\b/gi,
  /\b(?:enter|type|use|provide)\s+(?:this\s+|the\s+|your\s+)?(?:verification|security|authentication|confirmation|one[ -]?time)\s+code\s+([A-Za-z]{8})\b/gi,
  /* THE SENTENCE GREENHOUSE ACTUALLY WRITES, which none of the three above matches.
   *
   * Measured against the real emails, not against a paraphrase. Greenhouse's body is:
   *
   *     "Copy and paste this code into the security code field on your application: TPHJrFMJ.
   *      After you enter the code, resubmit your application."
   *
   * Every pattern above wants the token to follow the word "code" either immediately or after an
   * "is"/":"; here twenty-eight characters of instruction sit in between, so all three miss, and the
   * three codes on record from this applicant's mailbox on 2026-08-09 - LSlOXjvZ, yFxeFpSl, and the
   * TPHJrFMJ in Greenhouse's own support copy - were unreadable. Automatic retrieval cannot work on
   * a Greenhouse board without this, and the held-session design that reads a code in the seconds
   * after a submit has nothing to read.
   *
   * The colon is what makes it a hand-over rather than prose: a clause that names a code and then
   * ends in a colon is introducing one. Bounded to a single line and 80 characters so it cannot
   * reach across a paragraph, and the token still has to survive isGreenhouseLetterCode's
   * lower-to-upper test, which is what keeps 'Thursday' and 'Required' out.
   */
  /\bcode\b[^:\n]{0,80}:\s*([A-Za-z]{8})\b/gi,
];
const MAX_CODE_AGE_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 30_000;
const STANDING_GREENHOUSE_CODE_LOOKBACK_MS = 24 * 60 * 60_000;

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
  const controlledQaPortal = isControlledTestPortalUrl(portalUrl);
  if (controlledQaPortal && parsed.searchParams.get('board')?.toLowerCase() === 'greenhouse') {
    return PORTAL_SENDER_DOMAINS[0].senders;
  }
  const configured = PORTAL_SENDER_DOMAINS.find(({ portal }) => portal.test(host));
  return configured?.senders ?? [host];
}

function isGreenhouseVerificationPortal(portalUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(portalUrl);
  } catch {
    return false;
  }
  if (PORTAL_SENDER_DOMAINS[0].portal.test(parsed.hostname.toLowerCase())) return true;
  return isControlledTestPortalUrl(portalUrl)
    && parsed.searchParams.get('board')?.toLowerCase() === 'greenhouse';
}

/** The 24-hour exception is narrower than ordinary Greenhouse sender recognition. */
function isManagedGreenhouseStandingPortal(portalUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(portalUrl);
  } catch {
    return false;
  }
  if (isControlledTestPortalUrl(portalUrl)) {
    return parsed.searchParams.get('board')?.toLowerCase() === 'greenhouse';
  }
  return parsed.protocol === 'https:'
    && !parsed.username
    && !parsed.password
    && (!parsed.port || parsed.port === '443')
    && /^(?:job-boards|boards)(?:\.eu)?\.greenhouse\.io$/.test(parsed.hostname.toLowerCase());
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

function isGreenhouseLetterCode(value: string): boolean {
  // Greenhouse's observed letter-only value is mixed case in a non-word casing pattern. Requiring
  // a lower-to-upper transition rejects ordinary sentence words such as Required and Password.
  return /^[A-Za-z]{8}$/.test(value) && /[a-z][A-Z]/.test(value);
}

export function extractCodeFromVerificationText(value: string, allowGreenhouseLetterCode = false): string | null {
  const text = stripMarkup(value);
  const candidates = new Set<string>();
  for (const match of text.matchAll(CODE_PATTERN)) {
    const start = Math.max(0, (match.index ?? 0) - 100);
    const end = Math.min(text.length, (match.index ?? 0) + match[0].length + 100);
    if (CODE_CONTEXT.test(text.slice(start, end))) candidates.add(match[1]);
  }
  if (allowGreenhouseLetterCode) {
    for (const pattern of CONTEXTUAL_ALPHA_CODE_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        if (isGreenhouseLetterCode(match[1])) candidates.add(match[1]);
      }
    }
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

export function extractVerificationCode(
  payloads: Array<{ provider: EmailProvider; data: unknown }>,
  portalUrl: string,
  requestedAt: Date,
  expectedRecipient?: string,
  applicationId?: string,
  preferNewest = false,
  window: { beforeMs: number; afterMs: number } = {
    beforeMs: CLOCK_SKEW_MS,
    afterMs: MAX_CODE_AGE_MS,
  },
): VerificationCodeMatch | null {
  const allowedDomains = expectedSenderDomains(portalUrl);
  if (allowedDomains.length === 0 || Number.isNaN(requestedAt.getTime())) return null;
  const earliest = requestedAt.getTime() - window.beforeMs;
  const latest = requestedAt.getTime() + window.afterMs;
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
      const code = extractCodeFromVerificationText(
        `${message.subject}\n${message.text}`,
        isGreenhouseVerificationPortal(portalUrl),
      );
      return code ? [{ message, code, domain }] : [];
    })
    .sort((left, right) => right.message.receivedAt!.getTime() - left.message.receivedAt!.getTime());

  if (!preferNewest && new Set(matches.map((match) => match.code)).size > 1) return null;
  if (preferNewest && matches.length > 1) {
    const newestReceivedAt = matches[0].message.receivedAt!.getTime();
    const newestCodes = new Set(matches
      .filter((match) => match.message.receivedAt!.getTime() === newestReceivedAt)
      .map((match) => match.code));
    if (newestCodes.size > 1) return null;
  }
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

export type VerificationEmailRoute = 'application_alias' | 'personal_address' | 'invalid_alias';

export type VerificationEmailRouteDependencies = {
  deliverability?: typeof applicationAliasDeliverability;
  currentAlias?: typeof applicationAliasFor;
  activeAlias?: (input: { userId: string; applicationId: string; alias: string }) => Promise<boolean>;
};

async function exactActiveAlias(input: {
  userId: string;
  applicationId: string;
  alias: string;
}): Promise<boolean> {
  const [row] = await db.select({ alias: application_email_aliases.alias })
    .from(application_email_aliases)
    .where(and(
      eq(application_email_aliases.alias, input.alias),
      eq(application_email_aliases.user_id, input.userId),
      eq(application_email_aliases.generated_resume_id, input.applicationId),
      eq(application_email_aliases.status, 'active'),
    ))
    .limit(1);
  return Boolean(row);
}

/**
 * Decides which inbox may supply a code for one application.
 *
 * An address shaped like a Litos alias is never treated as a personal inbox. It must still be the
 * alias generated by the current receiving route, be active for this exact user and application,
 * and pass the live route-health check. Any miss fails closed, so a stale alias can never fall
 * through to Gmail or Outlook.
 */
export async function resolveVerificationEmailRoute(options: {
  userId: string;
  applicationId?: string;
  expectedRecipient?: string;
}, dependencies: VerificationEmailRouteDependencies = {}): Promise<VerificationEmailRoute> {
  const recipient = options.expectedRecipient?.trim().toLowerCase() ?? '';
  if (!recipient) return 'invalid_alias';
  if (!isAliasAddress(recipient)) return 'personal_address';
  if (!aliasUsesManagedReceiving(recipient)) return 'invalid_alias';
  if (!options.applicationId) return 'invalid_alias';

  const currentAlias = (dependencies.currentAlias ?? applicationAliasFor)(options.userId, options.applicationId);
  if (!currentAlias || currentAlias.trim().toLowerCase() !== recipient) return 'invalid_alias';
  const deliverability = await (dependencies.deliverability ?? applicationAliasDeliverability)().catch(() => null);
  if (!deliverability?.deliverable) return 'invalid_alias';
  const active = await (dependencies.activeAlias ?? exactActiveAlias)({
    userId: options.userId,
    applicationId: options.applicationId,
    alias: recipient,
  }).catch(() => false);
  return active ? 'application_alias' : 'invalid_alias';
}

export function extractLitosVerificationCode(
  rows: LitosVerificationRow[],
  portalUrl: string,
  requestedAt: Date,
  expectedRecipient: string,
  standingGreenhouse = false,
): VerificationCodeMatch | null {
  const useStandingGreenhouseWindow = standingGreenhouse
    && isManagedGreenhouseStandingPortal(portalUrl);
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
    undefined,
    useStandingGreenhouseWindow,
    useStandingGreenhouseWindow
      ? { beforeMs: STANDING_GREENHOUSE_CODE_LOOKBACK_MS, afterMs: CLOCK_SKEW_MS }
      : undefined,
  );
}

async function findLitosVerificationCode(options: {
  userId: string;
  portalUrl: string;
  requestedAt: Date;
  expectedRecipient: string;
  applicationId?: string;
  standingChallenge?: boolean;
}): Promise<VerificationCodeMatch | null> {
  const recipient = options.expectedRecipient.trim().toLowerCase();
  if (!recipient) return null;
  if (options.applicationId) {
    const packetPrefix = options.applicationId.replace(/-/g, '').slice(0, 10).toLowerCase();
    if (!recipient.includes(packetPrefix)) return null;
  }
  const standingGreenhouse = options.standingChallenge === true
    && isManagedGreenhouseStandingPortal(options.portalUrl)
    && Boolean(options.applicationId);
  const earliest = new Date(options.requestedAt.getTime() - (
    standingGreenhouse ? STANDING_GREENHOUSE_CODE_LOOKBACK_MS : CLOCK_SKEW_MS
  ));
  const latest = new Date(options.requestedAt.getTime() + (
    standingGreenhouse ? CLOCK_SKEW_MS : MAX_CODE_AGE_MS
  ));
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
  return extractLitosVerificationCode(
    rows,
    options.portalUrl,
    options.requestedAt,
    recipient,
    standingGreenhouse,
  );
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
  standingChallenge?: boolean;
  executor?: EmailToolExecutor;
  resolveRoute?: typeof resolveVerificationEmailRoute;
  findAliasCode?: typeof findLitosVerificationCode;
}): Promise<VerificationCodeMatch | null> {
  if (!options.expectedRecipient?.trim()) return null;
  const route = await (options.resolveRoute ?? resolveVerificationEmailRoute)({
    userId: options.userId,
    applicationId: options.applicationId,
    expectedRecipient: options.expectedRecipient,
  }).catch(() => 'invalid_alias' as const);
  if (route === 'application_alias') {
    // A retained Greenhouse wall can predate this run. Search backward only after the route has
    // proved the exact active alias belongs to this user and application, and only for Greenhouse.
    // Personal inboxes and other ATS families never get this exception. The held verification page
    // gets only the newest authenticated message from this exact application alias, and the caller
    // can spend that code in one verification continuation without resending the application.
    const standingGreenhouse = options.standingChallenge === true
      && isManagedGreenhouseStandingPortal(options.portalUrl)
      && Boolean(options.applicationId);
    return (options.findAliasCode ?? findLitosVerificationCode)({
      userId: options.userId,
      portalUrl: options.portalUrl,
      requestedAt: options.requestedAt,
      expectedRecipient: options.expectedRecipient,
      applicationId: options.applicationId,
      standingChallenge: standingGreenhouse,
    }).catch(() => null);
  }
  if (route !== 'personal_address') return null;
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
