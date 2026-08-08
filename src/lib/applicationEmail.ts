import { createHash, timingSafeEqual } from 'crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { application_email_aliases, application_email_messages, generated_resumes, users } from '../db/schema';
import { readApplicationReview } from './applicationReview';
import {
  type AliasDeliverability,
  type AliasDeliverabilityReason,
  applicationAliasDeliverability,
  applicationEmailForwardingConfigured,
  aliasDomain,
  inboundRouteConfigured,
  inboundWebhookEndpoint,
  listResendWebhooks,
} from './applicationEmailDeliverability';
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
  // The applicant answering the employer through her own alias. Never produced by the text
  // classifier: it is decided by WHO SENT IT, not by what it says.
  | 'applicant_reply'
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
  /* Provider verdicts on the envelope sender, when the provider supplies them. Absent means "not
   * stated", never "passed": see senderAuthenticationFailed. */
  authentication?: { spf?: string; dkim?: string; dmarc?: string };
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
  headers?: Record<string, string>;
};

function authenticationFromHeaders(headers: Record<string, string> | undefined): InboundApplicationEmail['authentication'] {
  const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'authentication-results')?.[1] ?? '';
  const verdict = (mechanism: 'spf' | 'dkim' | 'dmarc') => value.match(new RegExp(`\\b${mechanism}=([a-z]+)`, 'i'))?.[1]?.toLowerCase();
  const authentication = { spf: verdict('spf'), dkim: verdict('dkim'), dmarc: verdict('dmarc') };
  return Object.values(authentication).some(Boolean) ? authentication : undefined;
}

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

/* WHERE EMPLOYER MAIL GOES, as a stored setting rather than a side effect.
 *
 * submissionRunner used to pass the login address straight through, so the destination was
 * whatever mailbox happened to be used to sign in. This reads the explicit preference and falls
 * back to the account email, which keeps every existing account and all 50 existing alias rows
 * behaving exactly as they do today.
 *
 * The catch is not decoration. On Vercel a merge IS a deploy, so this code can be live before
 * `npm run db:application-email-forwarding` has run, and selecting a column that does not exist
 * yet is a 42703 that would take down packet generation. Undefined-column falls back to the
 * account email, which is the pre-migration behaviour. */
export async function applicationForwardingAddress(
  userId: string,
  accountEmail?: string | null,
): Promise<string | null> {
  const fallback = accountEmail?.trim().toLowerCase() || null;
  try {
    const rows = await db
      .select({ preferred: users.application_email_forward_to, account: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const row = rows[0];
    const preferred = row?.preferred?.trim().toLowerCase();
    if (preferred) return preferred;
    return row?.account?.trim().toLowerCase() || fallback;
  } catch (error) {
    if ((error as { code?: string } | null)?.code === '42703') return fallback;
    throw error;
  }
}

export function isValidForwardingAddress(value: string): boolean {
  return /^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim());
}

/** Rejects a destination on our own alias domain, which would forward mail to ourselves forever. */
export function forwardingAddressWouldLoop(value: string): boolean {
  const domain = aliasDomain();
  if (!domain) return false;
  return value.trim().toLowerCase().endsWith(`@${domain}`);
}

export type ApplicantEmailSource = 'litos_alias' | 'contact_email' | 'account_email';

export type ApplicantEmailChoice = {
  /** The address that will be typed into the employer's form. Never an undeliverable alias. */
  address: string;
  source: ApplicantEmailSource;
  /** 'deliverable' when the alias was used; otherwise why it was not. */
  reason: AliasDeliverabilityReason | 'alias_unavailable' | 'alias_write_failed' | 'no_forwarding_address';
  /** True only when replies really do come back through Litos. Never claim this on a fallback. */
  tracked: boolean;
  decided_at: string;
};

export class ApplicantEmailRegenerationRequiredError extends Error {
  readonly code = 'applicant_email_regeneration_required';

  constructor(reason: string) {
    super(`This application must be regenerated before submission: ${reason}`);
    this.name = 'ApplicantEmailRegenerationRequiredError';
  }
}

type StoredApplicantEmailSpec = {
  _applicant_email?: unknown;
  _application_email?: unknown;
  _contact?: unknown;
};

function applicantEmailChoice(value: unknown): ApplicantEmailChoice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const address = normalizedAddress(record.address);
  const source = record.source;
  if (!address || (source !== 'litos_alias' && source !== 'contact_email' && source !== 'account_email')) return null;
  return {
    address,
    source,
    reason: typeof record.reason === 'string' && record.reason ? record.reason as ApplicantEmailChoice['reason'] : 'alias_unavailable',
    tracked: record.tracked === true,
    decided_at: typeof record.decided_at === 'string' && record.decided_at ? record.decided_at : new Date(0).toISOString(),
  };
}

/** Reads the immutable email decision written when a packet and its PDF were generated. */
export function readPinnedApplicantEmail(spec: unknown): ApplicantEmailChoice | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  return applicantEmailChoice((spec as StoredApplicantEmailSpec)._applicant_email);
}

export type FrozenApplicantEmailDeps = {
  deliverability?: () => Promise<AliasDeliverability>;
  aliasActive?: (input: { userId: string; applicationId: string; alias: string }) => Promise<boolean>;
};

async function activeAliasForApplication(input: { userId: string; applicationId: string; alias: string }): Promise<boolean> {
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
 * Resolves the form email without ever changing the address printed in the frozen PDF.
 *
 * New packets carry `_applicant_email`. Legacy packets are recovered from `_contact.email`,
 * which was the exact value rendered into their PDF. A pinned alias that is no longer receivable
 * is a regeneration hold. Falling back to a personal address at submit time would make the PDF
 * and employer form disagree, and would also hide that employer replies cannot arrive.
 */
export async function resolveFrozenApplicantEmail(input: {
  userId: string;
  applicationId: string;
  spec: unknown;
  accountEmail?: string | null;
}, deps: FrozenApplicantEmailDeps = {}): Promise<ApplicantEmailChoice> {
  const stored = input.spec && typeof input.spec === 'object' && !Array.isArray(input.spec)
    ? input.spec as StoredApplicantEmailSpec
    : {};
  let pinned = readPinnedApplicantEmail(stored);

  if (!pinned) {
    const contact = stored._contact && typeof stored._contact === 'object' && !Array.isArray(stored._contact)
      ? normalizedAddress((stored._contact as Record<string, unknown>).email)
      : null;
    const legacyIdentity = stored._application_email && typeof stored._application_email === 'object' && !Array.isArray(stored._application_email)
      ? normalizedAddress((stored._application_email as Record<string, unknown>).alias)
      : null;
    const address = contact ?? legacyIdentity ?? normalizedAddress(input.accountEmail);
    if (!address) throw new ApplicantEmailRegenerationRequiredError('no applicant email is stored');
    const alias = isAliasAddress(address);
    pinned = {
      address,
      source: alias ? 'litos_alias' : contact ? 'contact_email' : 'account_email',
      reason: alias ? 'deliverable' : 'alias_unavailable',
      tracked: alias,
      decided_at: new Date(0).toISOString(),
    };
  }

  if (pinned.source !== 'litos_alias' && !isAliasAddress(pinned.address)) return pinned;

  const deliverability = await (deps.deliverability ?? applicationAliasDeliverability)().catch(() => null);
  if (!deliverability?.deliverable) {
    throw new ApplicantEmailRegenerationRequiredError(
      `the pinned Litos email is not receivable (${deliverability?.reason ?? 'deliverability_check_failed'})`,
    );
  }
  const active = await (deps.aliasActive ?? activeAliasForApplication)({
    userId: input.userId,
    applicationId: input.applicationId,
    alias: pinned.address,
  }).catch(() => false);
  if (!active) throw new ApplicantEmailRegenerationRequiredError('the pinned Litos email is not active for this packet');
  return { ...pinned, source: 'litos_alias', reason: 'deliverable', tracked: true };
}

function normalizedAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed && isValidForwardingAddress(trimmed) ? trimmed : null;
}

/** True for any address on the alias domain, including one stored on an older packet. */
export function isAliasAddress(value: string | null | undefined): boolean {
  const domain = aliasDomain();
  const address = value?.trim().toLowerCase();
  if (!address) return false;
  // Packets outlive email-provider migrations. Recognize both historical Litos formats even when
  // today's environment points at a different domain, otherwise an old dead alias is mistaken for
  // a personal address and silently submitted again.
  if (/^app-[a-z0-9-]+@apply\.trylitos\.com$/.test(address)) return true;
  if (/^applications\+app-[a-z0-9-]+@trylitos\.com$/.test(address)) return true;
  if (!domain) return false;
  if (address.endsWith(`@${domain}`)) return true;
  const mailbox = process.env.LITOS_APPLICATION_EMAIL_MAILBOX?.trim().toLowerCase();
  if (!mailbox) return false;
  const [local, mailboxDomain] = mailbox.split('@');
  return address.startsWith(`${local}+`) && address.endsWith(`@${mailboxDomain}`);
}

export type ResolveApplicantEmailDeps = {
  deliverability?: () => Promise<AliasDeliverability>;
  ensureAlias?: typeof ensureApplicationEmailAlias;
  forwardingAddress?: (userId: string, accountEmail?: string | null) => Promise<string | null>;
};

/* THE ONE PLACE THAT DECIDES WHAT EMPLOYERS ARE TOLD TO WRITE TO.
 *
 * Rules, in order, and the order is the safety property:
 *   1. An alias is used ONLY when the alias domain has been measured able to receive mail.
 *   2. Otherwise the applicant's real address is used, and the reason is recorded so nothing
 *      downstream can tell her replies are being tracked when they are not.
 *   3. A stored contact address that is itself an alias is ignored when choosing the fallback.
 *      Packets generated before this shipped have the alias frozen into spec._contact.email, and
 *      falling back to that would reintroduce the undeliverable address by the back door.
 *   4. Any error anywhere lands on the real address. */
export async function resolveApplicantEmail(input: {
  userId: string;
  applicationId: string;
  accountEmail?: string | null;
  contactEmail?: string | null;
  forwardTo?: string | null;
}, deps: ResolveApplicantEmailDeps = {}): Promise<ApplicantEmailChoice> {
  const decidedAt = new Date().toISOString();
  const contact = normalizedAddress(input.contactEmail);
  const account = normalizedAddress(input.accountEmail);
  const realContact = contact && !isAliasAddress(contact) ? contact : null;
  const fallback: ApplicantEmailChoice = realContact
    ? { address: realContact, source: 'contact_email', reason: 'alias_unavailable', tracked: false, decided_at: decidedAt }
    : { address: account ?? '', source: 'account_email', reason: 'alias_unavailable', tracked: false, decided_at: decidedAt };

  const check = await (deps.deliverability ?? applicationAliasDeliverability)().catch((): AliasDeliverability => ({
    deliverable: false,
    domain: null,
    reason: 'check_unavailable',
    mx_hosts: [],
    mx_provider: 'unknown',
    mx_provider_agrees: false,
    resend_domain_status: null,
    resend_receiving_status: null,
    inbound_route_configured: false,
    checked_at: decidedAt,
  }));
  if (!check.deliverable) return { ...fallback, reason: check.reason };

  const forwardTo = normalizedAddress(input.forwardTo)
    ?? normalizedAddress(await (deps.forwardingAddress ?? applicationForwardingAddress)(input.userId, input.accountEmail)
      .catch(() => null));
  if (!forwardTo) return { ...fallback, reason: 'no_forwarding_address' };

  const identity = await (deps.ensureAlias ?? ensureApplicationEmailAlias)({
    userId: input.userId,
    applicationId: input.applicationId,
    forwardTo,
  }).catch(() => null);
  if (!identity?.alias) return { ...fallback, reason: 'alias_write_failed' };

  return {
    address: identity.alias,
    source: 'litos_alias',
    reason: 'deliverable',
    tracked: true,
    decided_at: decidedAt,
  };
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

function inboundBodyText(inbound: InboundApplicationEmail): string {
  return inbound.text?.trim()
    || inbound.html?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    || '';
}

/* REPLY-TO IS THE ALIAS, not the employer.
 *
 * It used to be the employer's own address, which quietly defeated the entire feature: the
 * applicant hit reply and the mail left her personal Gmail straight to the recruiter, publishing
 * the address the alias exists to keep out of the thread and taking the conversation somewhere
 * Litos can never see again. Pointing it back at the alias is what makes the return leg possible
 * (see relayApplicantReply): her reply comes to us, and we send it on as the alias.
 *
 * The employer's address is still printed in the body, so she can always see who she is talking to
 * and can go around Litos on purpose if she wants to. */
function forwardEmailPayload(input: {
  alias: string;
  forwardTo: string;
  inbound: InboundApplicationEmail;
  classification: ApplicationEmailClassification;
}): OutboundEmail {
  const subject = input.inbound.subject?.trim() || '(no subject)';
  const from = input.inbound.from?.trim() || 'unknown sender';
  const bodyText = inboundBodyText(input.inbound);
  return {
    from: emailSender(),
    to: [input.forwardTo],
    reply_to: input.alias,
    subject: `[Litos] ${subject}`,
    text: [
      `Litos received this application email at ${input.alias}.`,
      `From: ${from}`,
      `Classification: ${input.classification}`,
      `Reply to this message and Litos sends your answer to ${from} from your application address.`,
      ``,
      bodyText,
    ].join('\n'),
    html: [
      `<p>Litos received this application email at ${escapeHtml(input.alias)}.</p>`,
      `<p><strong>From:</strong> ${escapeHtml(from)}</p>`,
      `<p><strong>Classification:</strong> ${escapeHtml(input.classification)}</p>`,
      `<p>Reply to this message and Litos sends your answer to ${escapeHtml(from)} from your application address.</p>`,
      `<p>${escapeHtml(bodyText || 'No plain-text body was provided.').replace(/\n/g, '<br>')}</p>`,
    ].join(''),
  };
}

/* The outbound leg. Sent AS the alias so the employer's thread stays on the alias and their next
 * reply comes back to Litos rather than to a personal mailbox that was never disclosed.
 *
 * `from` being the alias is only legitimate because the alias domain is verified in Resend, which
 * applicationAliasDeliverability has already established before any alias reaches a form. If that
 * ever stops being true the send fails loudly and is recorded on the row, which is the correct
 * outcome: it is better for a relay to error than for it to rewrite the applicant's identity. */
export function relayEmailPayload(input: {
  alias: string;
  to: string;
  inbound: InboundApplicationEmail;
}): OutboundEmail {
  const subject = input.inbound.subject?.trim() || '(no subject)';
  const bodyText = inboundBodyText(input.inbound);
  return {
    from: input.alias,
    to: [input.to],
    reply_to: input.alias,
    subject,
    text: bodyText || '(no message body)',
    html: input.inbound.html?.trim()
      || `<p>${escapeHtml(bodyText || '(no message body)').replace(/\n/g, '<br>')}</p>`,
  };
}

export type InboundRoute =
  | { kind: 'employer_message' }
  | { kind: 'applicant_reply' }
  | { kind: 'drop'; reason: 'self_addressed' | 'sender_authentication_failed' };

/* WHO SENT IT decides which direction this message is going, and it is decided here rather than
 * from the words in it.
 *
 * Mail arriving at an alias FROM the applicant's own forwarding address is her answer to the
 * employer and has to go out again as the alias. Anything else is employer mail and is forwarded
 * in. Mail apparently from the alias itself is dropped outright: that is the shape a loop takes,
 * and one loop between two mail systems is thousands of messages before anybody notices.
 *
 * The authentication check is best effort by necessity. A relay is a small open door (an attacker
 * who could forge her From address could push text through the alias to the employer, though never
 * to a recipient of their choosing, since the recipient comes from the stored thread and not from
 * the message). Where the provider gives us an SPF, DKIM or DMARC verdict we refuse on an explicit
 * failure; where it gives us nothing we proceed, and that gap is stated rather than papered over. */
export function routeInboundApplicationEmail(input: {
  from?: string;
  alias: string;
  forwardTo: string;
  authentication?: InboundApplicationEmail['authentication'];
}): InboundRoute {
  const from = input.from?.trim().toLowerCase();
  const alias = input.alias.trim().toLowerCase();
  const forwardTo = input.forwardTo.trim().toLowerCase();
  if (!from) return { kind: 'employer_message' };
  const sender = from.match(/<([^>]+)>/)?.[1]?.trim().toLowerCase() ?? from;
  if (sender === alias) return { kind: 'drop', reason: 'self_addressed' };
  if (sender !== forwardTo) return { kind: 'employer_message' };
  if (senderAuthenticationFailed(input.authentication)) {
    return { kind: 'drop', reason: 'sender_authentication_failed' };
  }
  return { kind: 'applicant_reply' };
}

export function senderAuthenticationFailed(
  authentication: InboundApplicationEmail['authentication'],
): boolean {
  if (!authentication) return false;
  return [authentication.spf, authentication.dkim, authentication.dmarc]
    .some((verdict) => verdict?.trim().toLowerCase() === 'fail');
}

/* Which employer this reply belongs to, taken from the thread Litos already recorded rather than
 * from anything in the reply itself.
 *
 * Trusting a To: header would let whoever composed the reply choose the recipient, and the reply
 * is arriving over SMTP from outside. The stored ledger is the only trustworthy statement of who
 * has written to this alias. Newest correspondent wins, since an application thread can pass from
 * a no-reply confirmation address to a named recruiter.
 *
 * The applicant's own address and the alias are excluded by construction, which is the second loop
 * guard: with no employer on record the relay refuses rather than mailing the applicant back. */
export function relayRecipientFor(
  messages: ReadonlyArray<{ direction: string; from_email: string | null }>,
  context: { alias: string; forwardTo: string },
): string | null {
  const alias = context.alias.trim().toLowerCase();
  const forwardTo = context.forwardTo.trim().toLowerCase();
  for (const message of messages) {
    if (message.direction === 'outbound') continue;
    const candidate = message.from_email?.match(/<([^>]+)>/)?.[1]?.trim().toLowerCase()
      ?? message.from_email?.trim().toLowerCase();
    if (!candidate || !isValidForwardingAddress(candidate)) continue;
    if (candidate === alias || candidate === forwardTo) continue;
    return candidate;
  }
  return null;
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
    headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'Litos/1.0' },
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
    authentication: authenticationFromHeaders(body.headers),
    raw: {
      provider: 'resend',
      email_id: body.id || input.emailId,
      message_id: body.message_id,
      to: body.to,
      subject: body.subject,
      authentication: authenticationFromHeaders(body.headers),
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

/* THE RETURN LEG: the applicant's reply, sent onward to the employer as the alias.
 *
 * This is the half of the design that did not exist. `direction` on application_email_messages
 * only ever held 'inbound' and 'forwarded', so every thread was one-way: employer mail reached the
 * applicant and her answer left her own mailbox, exposing the address the alias exists to protect.
 * One row is written per relay, with a genuine 'outbound' direction, from the alias to the
 * employer, and forwarded_at set when Resend accepts it. */
async function relayApplicantReply(
  input: InboundApplicationEmail,
  aliasRow: { alias: string; user_id: string; generated_resume_id: string | null; forward_to: string },
  receivedAt: Date,
): Promise<{ accepted: boolean; alias: string; classification: ApplicationEmailClassification; relayed: boolean; reason?: string }> {
  const thread = await db
    .select({ direction: application_email_messages.direction, from_email: application_email_messages.from_email })
    .from(application_email_messages)
    .where(eq(application_email_messages.alias, aliasRow.alias))
    .orderBy(desc(application_email_messages.created_at))
    .limit(50);
  const recipient = relayRecipientFor(thread, { alias: aliasRow.alias, forwardTo: aliasRow.forward_to });
  const dedupeKey = `relay:${dedupeKeyFor(input)}`;
  const inserted = await db.insert(application_email_messages).values({
    alias: aliasRow.alias,
    user_id: aliasRow.user_id,
    generated_resume_id: aliasRow.generated_resume_id,
    direction: 'outbound',
    provider: input.provider,
    provider_message_id: input.providerMessageId,
    dedupe_key: dedupeKey,
    from_email: aliasRow.alias,
    to_email: recipient,
    subject: input.subject,
    text: input.text,
    html: input.html,
    classification: 'applicant_reply',
    raw_json: { relay: { origin: aliasRow.forward_to, provider: input.provider ?? null } },
    received_at: receivedAt,
    forward_error: recipient ? null : 'No employer correspondent on this alias yet, so there was nothing to reply to.',
  }).onConflictDoNothing({ target: application_email_messages.dedupe_key }).returning({
    id: application_email_messages.id,
    forwarded_at: application_email_messages.forwarded_at,
  });
  const row = inserted[0] ?? (await db
    .select({ id: application_email_messages.id, forwarded_at: application_email_messages.forwarded_at })
    .from(application_email_messages)
    .where(eq(application_email_messages.dedupe_key, dedupeKey))
    .limit(1))[0];
  if (!recipient) {
    return { accepted: true, alias: aliasRow.alias, classification: 'applicant_reply', relayed: false, reason: 'no_employer_correspondent' };
  }
  if (!row || row.forwarded_at) {
    return { accepted: true, alias: aliasRow.alias, classification: 'applicant_reply', relayed: false, reason: 'already_relayed' };
  }

  const staleClaimBefore = new Date(Date.now() - 10 * 60 * 1000);
  const claimed = await db.update(application_email_messages)
    .set({ forwarding_claimed_at: new Date(), forward_error: null })
    .where(and(
      eq(application_email_messages.id, row.id),
      sql`${application_email_messages.forwarded_at} is null`,
      sql`(${application_email_messages.forwarding_claimed_at} is null or ${application_email_messages.forwarding_claimed_at} < ${staleClaimBefore})`,
    ))
    .returning({ id: application_email_messages.id });
  if (claimed.length === 0) {
    return { accepted: true, alias: aliasRow.alias, classification: 'applicant_reply', relayed: false, reason: 'claimed_elsewhere' };
  }

  try {
    await sendEmail(relayEmailPayload({ alias: aliasRow.alias, to: recipient, inbound: input }));
    await db.update(application_email_messages)
      .set({ forwarded_at: new Date(), forward_error: null })
      .where(eq(application_email_messages.id, row.id));
  } catch (error) {
    await db.update(application_email_messages)
      .set({
        forwarding_claimed_at: null,
        forward_error: String(error instanceof Error ? error.message : error).slice(0, 1000),
      })
      .where(eq(application_email_messages.id, row.id));
    throw error;
  }
  return { accepted: true, alias: aliasRow.alias, classification: 'applicant_reply', relayed: true };
}

export async function processInboundApplicationEmail(input: InboundApplicationEmail): Promise<{
  accepted: boolean;
  alias?: string;
  classification?: ApplicationEmailClassification;
  forwarded?: boolean;
  relayed?: boolean;
  reason?: string;
}> {
  const normalizedRecipients = input.to.map((item) => item.trim().toLowerCase()).filter(Boolean);
  const rows = normalizedRecipients.length === 0 ? [] : await db
    .select()
    .from(application_email_aliases)
    .where(inArray(application_email_aliases.alias, normalizedRecipients));
  const aliasRow = rows.find((row) => row.status === 'active');
  if (!aliasRow) return { accepted: false };
  const receivedAt = input.receivedAt ?? new Date();

  const route = routeInboundApplicationEmail({
    from: input.from,
    alias: aliasRow.alias,
    forwardTo: aliasRow.forward_to,
    authentication: input.authentication,
  });
  // Accepted and deliberately dropped are different answers, and the webhook must not retry a
  // drop: a loop that is retried is still a loop.
  if (route.kind === 'drop') {
    return { accepted: true, alias: aliasRow.alias, forwarded: false, relayed: false, reason: route.reason };
  }
  if (route.kind === 'applicant_reply') {
    return relayApplicantReply(input, aliasRow, receivedAt);
  }

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
    raw_json: {
      payload: input.raw as Record<string, unknown> | undefined,
      authentication: input.authentication,
    },
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

export type ApplicationEmailHealth = {
  status: 'ok' | 'degraded' | 'not_configured';
  reason: AliasDeliverabilityReason;
  domain: string | null;
  // Measured against the world.
  deliverable: boolean;
  mx_hosts: string[];
  mx_provider: AliasDeliverability['mx_provider'];
  mx_provider_agrees: boolean;
  resend_domain_status: string | null;
  resend_receiving_status: string | null;
  inbound_route_configured: boolean;
  last_inbound_message_at: string | null;
  last_inbound_message_age_seconds: number | null;
  enabled_aliases: number | null;
  // Config presence, kept under the old names so existing monitors keep parsing, but no longer
  // the answer to "is the inbox working".
  domain_configured: boolean;
  inbound_webhook_configured: boolean;
  forwarding_configured: boolean;
  checked_at: string;
  detail?: string;
};

/* WHAT /health SAYS ABOUT THE APPLICATION INBOX, and why it used to lie.
 *
 * Until now this reported domain_configured, inbound_webhook_configured and forwarding_configured,
 * and every one of them was a test that an environment variable was a non-empty string. On
 * 2026-08-08 all three answered true, enabled_aliases answered 50, and the truth was that
 * apply.trylitos.com had no MX record and not one message had ever arrived. A monitor pointed here
 * saw a healthy service for the entire life of the outage. That is the same failure the database
 * probe above this one was written to end, arriving through a different door.
 *
 * So the fields that matter here are measurements: the MX hosts that actually resolve, the domain
 * status Resend actually reports, whether an inbound route actually points at our endpoint, and
 * how long it has been since a message actually landed. The three config booleans stay, under
 * their old names, demoted to what they always were.
 *
 * It cannot take /health down. The deliverability probe never throws, and the two database reads
 * degrade to null rather than propagating. */
export async function applicationEmailHealth(): Promise<ApplicationEmailHealth> {
  const check = await applicationAliasDeliverability();
  const [aliasCount, lastInbound] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(application_email_aliases)
      .where(eq(application_email_aliases.status, 'active'))
      .then((rows) => Number(rows[0]?.count ?? 0))
      .catch(() => null),
    db
      .select({ at: sql<string | null>`max(coalesce(received_at, created_at))` })
      .from(application_email_messages)
      .where(sql`${application_email_messages.direction} <> 'outbound'`)
      .then((rows) => rows[0]?.at ?? null)
      .catch(() => null),
  ]);
  const lastAt = lastInbound ? new Date(lastInbound) : null;
  const lastIso = lastAt && !Number.isNaN(lastAt.getTime()) ? lastAt.toISOString() : null;
  return {
    // 'not_configured' is a deployment that never turned the feature on and is not an incident.
    // 'degraded' is a deployment that believes it did and is wrong, which is the state that needs
    // to be loud and distinct from 'ok'.
    status: check.deliverable
      ? 'ok'
      : (check.reason === 'alias_not_configured' || check.reason === 'inbound_disabled' ? 'not_configured' : 'degraded'),
    reason: check.reason,
    domain: check.domain,
    deliverable: check.deliverable,
    mx_hosts: check.mx_hosts,
    mx_provider: check.mx_provider,
    mx_provider_agrees: check.mx_provider_agrees,
    resend_domain_status: check.resend_domain_status,
    resend_receiving_status: check.resend_receiving_status,
    inbound_route_configured: check.inbound_route_configured,
    last_inbound_message_at: lastIso,
    last_inbound_message_age_seconds: lastIso
      ? Math.max(0, Math.round((Date.now() - new Date(lastIso).getTime()) / 1000))
      : null,
    enabled_aliases: aliasCount,
    domain_configured: Boolean((configuredDomain() || configuredMailbox()) && applicationAliasSecret()),
    inbound_webhook_configured: Boolean(inboundWebhookSecret()),
    forwarding_configured: applicationEmailForwardingConfigured(),
    checked_at: check.checked_at,
    ...(check.detail ? { detail: check.detail } : {}),
  };
}

/**
 * The inbound-route half of the probe on its own, for the setup script and for operators who want
 * to know whether Resend will hand a received message to this deployment.
 */
export async function inboundRouteHealth(): Promise<{ endpoint: string; configured: boolean; error?: string }> {
  const endpoint = inboundWebhookEndpoint();
  try {
    return { endpoint, configured: inboundRouteConfigured(await listResendWebhooks(), endpoint) };
  } catch (error) {
    return { endpoint, configured: false, error: String(error instanceof Error ? error.message : error).slice(0, 200) };
  }
}
