import { createHash, timingSafeEqual } from 'crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { application_email_aliases, application_email_messages, generated_resumes, users } from '../db/schema';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
import { syncCanonicalApplicationRow } from './canonicalApplicationSync';
import { applyReviewPatch } from './applicationStall';
import { isUndefinedColumnError } from './applicationFacts';
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
import { applicationEmailRouteSelection, type ApplicationEmailRouteMode } from './applicationEmailRoute';
import { resendReceivingApiKey } from './resendReceiving';

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

export type ApplicationEmailForwardingDecision =
  | { forward: true }
  | { forward: false; reason: 'internal_only' };

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
  return applicationEmailRouteSelection().mailbox;
}

function configuredDomain(): string | null {
  const selection = applicationEmailRouteSelection();
  return selection.mailbox ? null : selection.domain;
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
  return applicationEmailRouteSelection().route_label;
}

function digest(value: string, length = 10): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

export function applicationEmailRouteGenerationFingerprint(): string | null {
  const secret = applicationAliasSecret();
  const route = applicationEmailRouteLabel();
  if (!secret || !route) return null;
  const mode = applicationEmailRouteSelection().mode;
  return digest(`application-email-route-v2:${mode}:${route}:${secret}`, 20);
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
    // Through the cause chain, because Drizzle wraps the pg error and the code is not on the
    // outside. See isUndefinedColumnError, where testing the outer `code` alone was measured to
    // never match and to defeat the whole fallback.
    if (isUndefinedColumnError(error)) return fallback;
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
 * Resolves the tracked form email while keeping it separate from the address printed in the PDF.
 *
 * New packets carry a tracked `_applicant_email` alias and a personal `_contact.email`. Legacy,
 * nonalias, equal-address, inactive, or stale-route packets are regeneration holds. There is no
 * personal-email fallback at submit time.
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
  const pinned = readPinnedApplicantEmail(stored);
  if (!pinned) throw new ApplicantEmailRegenerationRequiredError('no tracked Litos applicant email is stored');
  if (pinned.source !== 'litos_alias' || pinned.tracked !== true || !isAliasAddress(pinned.address)) {
    throw new ApplicantEmailRegenerationRequiredError('the stored applicant email is not a tracked Litos alias');
  }
  const contact = stored._contact && typeof stored._contact === 'object' && !Array.isArray(stored._contact)
    ? normalizedAddress((stored._contact as Record<string, unknown>).email)
    : null;
  if (!contact) throw new ApplicantEmailRegenerationRequiredError('no personal resume email is stored');
  if (contact === pinned.address) {
    throw new ApplicantEmailRegenerationRequiredError('the resume email and tracked applicant email are not separate');
  }

  const deliverability = await (deps.deliverability ?? applicationAliasDeliverability)().catch(() => null);
  if (!deliverability?.deliverable) {
    throw new ApplicantEmailRegenerationRequiredError(
      `the pinned Litos email is not receivable (${deliverability?.reason ?? 'deliverability_check_failed'})`,
    );
  }
  const currentAlias = applicationAliasFor(input.userId, input.applicationId);
  if (!currentAlias || pinned.address !== currentAlias) {
    throw new ApplicantEmailRegenerationRequiredError(
      'the pinned Litos email does not match the current inbound email route',
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

/** True for an address shaped like a Litos alias, including one stored on an older route. */
export function isAliasAddress(value: string | null | undefined): boolean {
  const address = value?.trim().toLowerCase();
  if (!address) return false;
  const separator = address.lastIndexOf('@');
  const local = separator > 0 ? address.slice(0, separator) : '';
  // Packets outlive provider and domain migrations. Recognize both supported alias shapes without
  // naming a retired domain, otherwise a dead alias becomes a personal address after configuration
  // changes and can silently reach an employer again.
  if (/^app-[a-f0-9]{10}-[a-f0-9]{12}$/.test(local)) return true;
  if (/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+\+app-[a-f0-9]{10}-[a-f0-9]{12}$/.test(local)) return true;
  return false;
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
  if (/\b(verification code|security code|one[- ]?time|otp|passcode|confirm your email)\b/.test(haystack)) {
    return 'verification_code';
  }
  /* The receipt wordings here are all measured, not invented. The first row is the classic
   * Greenhouse/Lever family. The second row is the 2026-08-18 additions, each from a stored
   * message this function got wrong that night: Ashby writes "thank you for submitting your
   * application" (no "for applying" anywhere), and Personio's bilingual receipt says
   * "we have received your documents" / "deine Unterlagen sind bei uns angekommen" while its
   * closing line ("we will invite you to an interview") used to fall through to the interview
   * matcher and file a plain receipt as an interview request. Receipts are checked before
   * interview logistics for exactly that reason: a message that confirms receipt IS a receipt,
   * whatever it promises about later steps.
   *
   * The document phrases require their affirmative subject: "we have received your documents"
   * with the prefix mandatory, because the bare tail also lives inside "we have NOT yet received
   * your documents", an upload reminder that must never resolve a packet. The German form accepts
   * the compound "Bewerbungsunterlagen", which \bunterlagen alone can never match. */
  if (/\b(thank you for applying|thanks for applying|application (?:has been )?received|we received your application|successfully submitted|application submitted)\b/.test(haystack)
    || /\b(thank you for submitting your application|(?:we have|we've) received your documents|documents have arrived|(?:bewerbungs)?unterlagen sind (?:bei uns )?angekommen)\b/.test(haystack)) {
    return 'submission_confirmation';
  }
  const interviewStage = '(?:interview|phone screen|technical screen|onsite interview)';
  const interviewRequestOrConfirmation =
    new RegExp(`\\b(?:schedule|reschedule|book|confirm)\\b.{0,40}\\b(?:${interviewStage}|call)\\b`).test(haystack)
    || new RegExp(`\\b${interviewStage}\\b.{0,40}\\b(?:scheduled|confirmed|rescheduled)\\b`).test(haystack)
    || new RegExp(`\\b${interviewStage}\\s+(?:invitation|request)\\b`).test(haystack)
    || new RegExp(`\\b(?:invite|invitation)\\b.{0,50}\\b${interviewStage}\\b`).test(haystack)
    || new RegExp(`\\b${interviewStage}\\b.{0,40}\\bavailability\\b`).test(haystack)
    || new RegExp(`\\bavailability\\b.{0,40}\\b(?:for|to schedule)\\b.{0,30}\\b(?:${interviewStage}|call)\\b`).test(haystack)
    || /\b(?:share|send|select|choose)\b.{0,30}\b(?:availability|time slot|timeslot)\b.{0,30}\b(?:interview|call|screen)\b/.test(haystack);
  if (interviewRequestOrConfirmation) return 'interview_request';
  if (/\b(recruiter|talent|hiring team|next steps|following up)\b/.test(haystack)) {
    return 'recruiter_reply';
  }
  return 'other';
}

/**
 * Employer mail is always stored, but only terminal submission receipts and interview logistics
 * leave Litos automatically. Verification codes remain available to the managed-session reader,
 * and recruiter or miscellaneous messages remain available in the application email ledger.
 */
export function applicationEmailForwardingDecision(
  classification: ApplicationEmailClassification,
): ApplicationEmailForwardingDecision {
  return classification === 'submission_confirmation' || classification === 'interview_request'
    ? { forward: true }
    : { forward: false, reason: 'internal_only' };
}

function storedApplicationEmailClassification(value: string): ApplicationEmailClassification {
  switch (value) {
    case 'submission_confirmation':
    case 'interview_request':
    case 'verification_code':
    case 'recruiter_reply':
    case 'applicant_reply':
    case 'other':
      return value;
    default:
      return 'other';
  }
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
export function aliasUsesManagedReceiving(alias: string): boolean {
  const normalized = normalizedAddress(alias);
  const domain = normalized?.slice(normalized.lastIndexOf('@') + 1) ?? '';
  // Resend-managed receiving aliases are permanently inbound-only. Infer that capability from the
  // strict provider domain shape rather than today's environment, because packets and active alias
  // rows can outlive a route migration.
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.resend\.app$/i.test(domain);
}

export function forwardEmailPayload(input: {
  alias: string;
  forwardTo: string;
  inbound: InboundApplicationEmail;
  classification: ApplicationEmailClassification;
}): OutboundEmail {
  const subject = input.inbound.subject?.trim() || '(no subject)';
  const from = input.inbound.from?.trim() || 'unknown sender';
  const bodyText = inboundBodyText(input.inbound);
  const managedReceiving = aliasUsesManagedReceiving(input.alias);
  const replyInstruction = managedReceiving
    ? `This Litos receiving address cannot send replies. Contact ${from} directly from your own mailbox.`
    : `Reply to this message and Litos sends your answer to ${from} from your application address.`;
  return {
    from: emailSender(),
    to: [input.forwardTo],
    ...(managedReceiving ? {} : { reply_to: input.alias }),
    subject: `[Litos] ${subject}`,
    text: [
      `Litos received this application email at ${input.alias}.`,
      `From: ${from}`,
      `Classification: ${input.classification}`,
      replyInstruction,
      ``,
      bodyText,
    ].join('\n'),
    html: [
      `<p>Litos received this application email at ${escapeHtml(input.alias)}.</p>`,
      `<p><strong>From:</strong> ${escapeHtml(from)}</p>`,
      `<p><strong>Classification:</strong> ${escapeHtml(input.classification)}</p>`,
      `<p>${escapeHtml(replyInstruction)}</p>`,
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
  | { kind: 'drop'; reason: 'self_addressed' | 'sender_authentication_failed' | 'managed_reply_unsupported' };

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
  if (aliasUsesManagedReceiving(alias)) return { kind: 'drop', reason: 'managed_reply_unsupported' };
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
  const key = resendReceivingApiKey();
  if (!key) throw new Error('RESEND_RECEIVING_API_KEY or RESEND_API_KEY is required to read received email content');
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

/* WHAT AN EMPLOYER'S OWN CONFIRMATION DOES TO THE PACKET.
 *
 * TWO DEFECTS LIVED IN THE FIVE LINES THIS REPLACES, and both of them reached the owner.
 *
 * 1. It spread `...current` and overrode only status, submitted_at, updated_at, submission_error
 *    and receipt. `attention_reason`, `attention_categories` and `security_code` survived untouched,
 *    so a packet could read `status: submitted` while still telling her, in the same object, that
 *    Litos had read a code from her mailbox, the employer had not accepted it, and she needed to go
 *    and finish the application in the portal herself. Measured on packet
 *    8e29df51-09ed-4c67-b2fc-153966471473 (Cresta): the code was requested at 17:35:04, the employer
 *    confirmed receipt at 17:36:04, and the row still carries the security-code sentence and the
 *    'security_code' category next to submitted_at. Those fields are not decoration - they are the
 *    live instruction the dashboard renders - and an instruction contradicted by the state beside it
 *    is worse than no instruction at all.
 *
 * 2. It built the next review by bare spread and wrote it with a raw jsonb_set, which is exactly the
 *    shape applyReviewPatch exists to stop. settleStall never ran, so a packet that stalled on a
 *    human check and was then confirmed by email kept an OPEN stall forever: still in the
 *    "waiting on you" queue, still accruing time-to-resolution on a wait that had ended.
 *    withTerminalCause never ran either, which happens to be harmless on this particular transition
 *    and is not something a caller should have to know.
 *
 * The clearing is deliberate rather than incidental. An employer receipt answers every open request
 * for her hands on THIS application: there is nothing left for her to type, and no code left to
 * enter. `security_code` is dropped for the same reason - every reader of it (submissionSafety, the
 * code-entry route, the runner's continuation) is gated on status 'awaiting_security_code', so on a
 * submitted packet it is inert state whose only remaining effect is to make the row read as unfiled.
 */
export function reviewFromSubmissionConfirmation(
  current: ApplicationReviewState,
  input: { alias: string; subject?: string; receivedAt: Date },
): ApplicationReviewState {
  const at = input.receivedAt.toISOString();
  return applyReviewPatch(current, {
    status: 'submitted',
    submitted_at: at,
    submission_error: undefined,
    attention_reason: undefined,
    attention_categories: undefined,
    security_code: undefined,
    receipt: {
      confirmation_text: input.subject?.trim() || `Application confirmation received at ${input.alias}`,
      final_url: current.portal_url ?? input.alias,
      captured_at: at,
      source: 'email_fallback',
    },
  }, () => at);
}

/**
 * `null` means no packet with this id belongs to this user. `{ review: null }` means the packet is
 * there and carries no review yet. The two are different answers and the caller reports them as
 * different reasons, because one of them is an ownership failure.
 */
export type PacketReviewLookup = { review: ApplicationReviewState | null } | null;

export type SubmissionConfirmationOutcome =
  | { resolved: true; review: ApplicationReviewState }
  | {
    resolved: false;
    reason: 'packet_not_found' | 'review_missing' | 'already_submitted' | 'stale_confirmation';
  };

/* A RECEIPT MAY ONLY MOVE A PACKET FORWARD, never backwards over something newer.
 *
 * Resolution now runs on every delivery of a confirmation rather than only on the first successful
 * forward, which is the whole point of the reordering above. That opens a window this guard closes:
 * the same message can arrive twice, and reconcileSubmissionConfirmations can replay a message from
 * weeks ago. While the packet stays 'submitted' the status check alone is enough. The moment it
 * leaves - a re-run, a restart, anything that puts a new attempt in front of an employer - a replay
 * of the OLD confirmation would stamp its receipt over the new one and, worse, clear the
 * attention_reason and security_code the new run had just written. The clearing in
 * reviewFromSubmissionConfirmation is correct for the receipt that answers the CURRENT attempt and
 * wrong for one that answers a previous one.
 *
 * Three timestamps decide it, and each is read as "the packet knows about something at least this
 * recent": a receipt already captured at or after this message, or a submission attempted, claimed
 * or completed after it. Comparison is a plain string compare on fixed-width ISO-8601 UTC, the same
 * convention orderByStalledAt relies on: every writer of these fields produces toISOString(), so
 * lexicographic and chronological order coincide.
 *
 * It is not reachable through the webhook today, because submitRequestDisposition refuses to re-run
 * a submitted packet, so nothing takes a packet back out of 'submitted' for a stale receipt to land
 * on. It becomes reachable the moment the reconciler is wired to anything, which is precisely why it
 * is here now rather than in the change that wires it.
 */
export function confirmationIsStale(current: ApplicationReviewState, receivedAt: Date): boolean {
  const at = receivedAt.toISOString();
  if (current.receipt?.captured_at && current.receipt.captured_at >= at) return true;
  return [current.submitted_at, current.submission_attempted_at, current.submission_claimed_at]
    .some((stamp) => Boolean(stamp && stamp > at));
}

export type SubmissionConfirmationDeps = {
  loadReview?: (input: { applicationId: string; userId: string }) => Promise<PacketReviewLookup>;
  saveReview?: (input: {
    applicationId: string;
    userId: string;
    review: ApplicationReviewState;
    receivedAt: Date;
  }) => Promise<void>;
  syncCanonicalApplication?: (input: {
    packetId: string;
    userId: string;
  }) => Promise<void>;
};

/* Scoped by OWNER as well as by id, on both the read and the write.
 *
 * The application id on a message row is a foreign key the alias put there, and the alias carries
 * the user it belongs to. Reading the packet by id alone was correct only for as long as nothing
 * else could ever supply that id; scoping it means a confirmation can only ever resolve a packet
 * belonging to the mailbox it arrived at, whatever hands the id to this function later. */
async function loadPacketReview(input: { applicationId: string; userId: string }): Promise<PacketReviewLookup> {
  const rows = await db
    .select({ spec: generated_resumes.spec })
    .from(generated_resumes)
    .where(and(
      eq(generated_resumes.id, input.applicationId),
      eq(generated_resumes.user_id, input.userId),
    ))
    .limit(1);
  if (rows.length === 0) return null;
  return { review: readApplicationReview(rows[0].spec) };
}

async function savePacketReview(input: {
  applicationId: string;
  userId: string;
  review: ApplicationReviewState;
  receivedAt: Date;
}): Promise<void> {
  await db.update(generated_resumes).set({
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(input.review)}::jsonb, true)`,
    pipeline_stage: 'applied',
    pipeline_stage_at: input.receivedAt,
  }).where(and(
    eq(generated_resumes.id, input.applicationId),
    eq(generated_resumes.user_id, input.userId),
    // The read and the write are two statements, so the status is re-checked in the WHERE rather
    // than trusted from the read. A second confirmation arriving in that gap must not restamp a
    // receipt over the one already recorded.
    sql`${generated_resumes.spec}->'_review'->>'status' <> 'submitted'`,
  ));
}

/**
 * Resolve one packet from one employer confirmation. Idempotent: a packet already submitted is left
 * exactly as it is, and reports why.
 */
export async function resolvePacketFromConfirmation(input: {
  applicationId: string;
  userId: string;
  alias: string;
  subject?: string;
  receivedAt: Date;
}, deps: SubmissionConfirmationDeps = {}): Promise<SubmissionConfirmationOutcome> {
  const lookup = await (deps.loadReview ?? loadPacketReview)({
    applicationId: input.applicationId,
    userId: input.userId,
  });
  if (!lookup) return { resolved: false, reason: 'packet_not_found' };
  const current = lookup.review;
  if (!current) return { resolved: false, reason: 'review_missing' };
  /* Best-effort on both paths, by design. Before this sync existed the already-submitted branch
   * was a pure read that could never fail a webhook delivery; a canonical write must not change
   * that, or a degraded applications table turns every duplicate receipt into a Resend retry
   * storm. A swallowed failure here is not lost: the packet is the source of truth and the
   * reconciler replays this exact branch until the heal lands. */
  const syncCanonical = async () => {
    try {
      await (deps.syncCanonicalApplication ?? syncCanonicalApplicationRow)({
        packetId: input.applicationId,
        userId: input.userId,
      });
    } catch {
      // The confirmation outcome must not depend on the canonical write.
    }
  };
  if (current.status === 'submitted') {
    /* The packet already knows. The canonical row may not: every confirmation resolved before the
     * sync below existed left a submitted packet beside a still-sendable applications row, and the
     * reconciler replays exactly this branch. Healing it here makes one reconcile pass fix them
     * all, and the guarded UPDATE makes the heal a no-op when nothing is wrong. */
    await syncCanonical();
    return { resolved: false, reason: 'already_submitted' };
  }
  if (confirmationIsStale(current, input.receivedAt)) return { resolved: false, reason: 'stale_confirmation' };
  const review = reviewFromSubmissionConfirmation(current, input);
  await (deps.saveReview ?? savePacketReview)({
    applicationId: input.applicationId,
    userId: input.userId,
    review,
    receivedAt: input.receivedAt,
  });
  await syncCanonical();
  return { resolved: true, review };
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

export type InboundApplicationEmailResult = {
  accepted: boolean;
  alias?: string;
  classification?: ApplicationEmailClassification;
  forwarded?: boolean;
  relayed?: boolean;
  /** Whether this message moved its packet to submitted. Absent on paths with no packet to move. */
  resolved?: boolean;
  reason?: string;
};

/** The stored ledger row, which is what the forward is built from rather than the raw webhook. */
export type StoredInboundMessage = {
  id: string;
  forwarded_at: Date | null;
  from_email: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  received_at: Date | null;
};

export type StoredEmployerMessageDeps = {
  resolveConfirmation: (input: {
    applicationId: string;
    userId: string;
    alias: string;
    subject?: string;
    receivedAt: Date;
  }) => Promise<SubmissionConfirmationOutcome>;
  /** True when this process now owns the forward. False means another one already does. */
  claimForwarding: (messageId: string) => Promise<boolean>;
  forward: (input: {
    alias: string;
    forwardTo: string;
    inbound: InboundApplicationEmail;
    classification: ApplicationEmailClassification;
  }) => Promise<void>;
  markForwarded: (messageId: string) => Promise<void>;
  recordForwardFailure: (input: { messageId: string; error: string }) => Promise<void>;
  onResolutionError?: (error: unknown) => void;
};

/* WHAT HAPPENS TO AN EMPLOYER MESSAGE ONCE IT IS SAFELY IN THE LEDGER, and why resolution comes
 * first.
 *
 * RECEIVING AND CLASSIFYING A CONFIRMATION IS WHAT RESOLVES THE PACKET. It used to be a side effect
 * of a successful FIRST forward: the call sat at the very end of the function, behind three gates
 * that each returned before it.
 *   - a message whose `forwarded_at` was already set returned early, so every row written before
 *     the resolution existed at all could never resolve, and neither could a redelivery;
 *   - a lost forwarding claim returned early;
 *   - and a `sendEmail` that threw rethrew, so the line below it was unreachable.
 * The consequence is one sentence long: a confirmation that arrived while forwarding was degraded
 * left the application reading as unsent, indefinitely, with the employer's own receipt sitting in
 * the ledger one row away. Forwarding is a courtesy copy into her mailbox. Whether the employer
 * received the application is a fact about the application, and it must not depend on that copy.
 *
 * A resolution failure does not block the forward either, and the reverse of the same rule is why:
 * neither of these two jobs is allowed to swallow the other. It is remembered and rethrown once the
 * forward has been dealt with, so the webhook still retries; a retry is safe because the dedupe key
 * makes the store idempotent, `forwarded_at` stops a second copy going out, and the resolution
 * itself is idempotent. If the FORWARD also throws, that error wins and the resolution error is only
 * logged - the caller can act on one error, and the forward is the one with a claim to release.
 */
export async function handleStoredEmployerMessage(input: {
  aliasRow: { alias: string; user_id: string; generated_resume_id: string | null; forward_to: string };
  message: StoredInboundMessage | null;
  classification: ApplicationEmailClassification;
  receivedAt: Date;
}, deps: StoredEmployerMessageDeps): Promise<InboundApplicationEmailResult> {
  const { aliasRow, message, classification, receivedAt } = input;
  let resolved = false;
  let resolutionError: unknown = null;
  /* THE LEDGER ROW IS REQUIRED, and only the FORWARDING gates were removed.
   *
   * A packet reading "submitted, source email_fallback" is a claim about a message, so the message
   * has to exist to be pointed at: the evidence and the state stay together or the next person
   * investigating has a status with nothing behind it. This is the one thing the original ordering
   * got right and it is kept deliberately, separate from the three gates that were wrong.
   *
   * It costs nothing. `message` is null only if the insert conflicted AND the follow-up select by
   * dedupe key then found nothing, which the conflict itself says is impossible; if it ever happens
   * it is a database anomaly, the webhook is told nothing was accepted, and the redelivery both
   * stores the row and resolves the packet. */
  if (classification === 'submission_confirmation' && aliasRow.generated_resume_id && message) {
    try {
      const outcome = await deps.resolveConfirmation({
        applicationId: aliasRow.generated_resume_id,
        userId: aliasRow.user_id,
        alias: aliasRow.alias,
        subject: message.subject ?? undefined,
        receivedAt: message.received_at ?? receivedAt,
      });
      resolved = outcome.resolved;
    } catch (error) {
      resolutionError = error;
      deps.onResolutionError?.(error);
    }
  }
  // Every early return goes through here, so a deferred resolution failure cannot be lost by
  // whichever branch happens to be taken.
  const done = (result: InboundApplicationEmailResult): InboundApplicationEmailResult => {
    if (resolutionError) throw resolutionError;
    return result;
  };
  const base = { accepted: true, alias: aliasRow.alias, classification, resolved };

  const forwardingDecision = applicationEmailForwardingDecision(classification);
  if (!forwardingDecision.forward) {
    return done({ ...base, forwarded: false, reason: forwardingDecision.reason });
  }
  if (!message) return done({ ...base, forwarded: false, reason: 'message_not_stored' });
  if (message.forwarded_at) return done({ ...base, forwarded: false, reason: 'already_forwarded' });
  if (!await deps.claimForwarding(message.id)) {
    return done({ ...base, forwarded: false, reason: 'claimed_elsewhere' });
  }

  try {
    await deps.forward({
      alias: aliasRow.alias,
      forwardTo: aliasRow.forward_to,
      inbound: {
        from: message.from_email ?? undefined,
        to: [aliasRow.alias],
        subject: message.subject ?? undefined,
        text: message.text ?? undefined,
        html: message.html ?? undefined,
        receivedAt: message.received_at ?? undefined,
      },
      classification,
    });
    await deps.markForwarded(message.id);
  } catch (error) {
    await deps.recordForwardFailure({
      messageId: message.id,
      error: String(error instanceof Error ? error.message : error).slice(0, 1000),
    });
    throw error;
  }
  return done({ ...base, forwarded: true });
}

/** The live collaborators for handleStoredEmployerMessage. Nothing here decides anything. */
function storedEmployerMessageDeps(): StoredEmployerMessageDeps {
  return {
    resolveConfirmation: (confirmation) => resolvePacketFromConfirmation(confirmation),
    claimForwarding: async (messageId) => {
      const staleClaimBefore = new Date(Date.now() - 10 * 60 * 1000);
      const claimed = await db.update(application_email_messages)
        .set({ forwarding_claimed_at: new Date(), forward_error: null })
        .where(and(
          eq(application_email_messages.id, messageId),
          sql`${application_email_messages.forwarded_at} is null`,
          sql`(${application_email_messages.forwarding_claimed_at} is null or ${application_email_messages.forwarding_claimed_at} < ${staleClaimBefore})`,
        ))
        .returning({ id: application_email_messages.id });
      return claimed.length > 0;
    },
    forward: async (payload) => {
      await sendEmail(forwardEmailPayload(payload));
    },
    markForwarded: async (messageId) => {
      await db.update(application_email_messages)
        .set({ direction: 'forwarded', forwarded_at: new Date(), forward_error: null })
        .where(eq(application_email_messages.id, messageId));
    },
    recordForwardFailure: async ({ messageId, error }) => {
      await db.update(application_email_messages)
        .set({ forwarding_claimed_at: null, forward_error: error })
        .where(eq(application_email_messages.id, messageId));
    },
  };
}

export async function processInboundApplicationEmail(input: InboundApplicationEmail): Promise<InboundApplicationEmailResult> {
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
    from_email: application_email_messages.from_email,
    subject: application_email_messages.subject,
    text: application_email_messages.text,
    html: application_email_messages.html,
    classification: application_email_messages.classification,
    received_at: application_email_messages.received_at,
  });
  const message = inserted[0] ?? (await db
    .select({
      id: application_email_messages.id,
      forwarded_at: application_email_messages.forwarded_at,
      from_email: application_email_messages.from_email,
      subject: application_email_messages.subject,
      text: application_email_messages.text,
      html: application_email_messages.html,
      classification: application_email_messages.classification,
      received_at: application_email_messages.received_at,
    })
    .from(application_email_messages)
    .where(eq(application_email_messages.dedupe_key, dedupeKey))
    .limit(1))[0];
  // The STORED classification is the authority from here on, including on the redelivery of a
  // message this deployment classified differently: the ledger row is what the applicant and the
  // packet were told, and two answers for one message is worse than either answer.
  const storedClassification = message
    ? storedApplicationEmailClassification(message.classification)
    : classification;
  return handleStoredEmployerMessage({
    aliasRow,
    message: message ?? null,
    classification: storedClassification,
    receivedAt,
  }, storedEmployerMessageDeps());
}

/* THE WAY BACK FOR CONFIRMATIONS THAT ARE ALREADY IN THE LEDGER.
 *
 * The ordering fix above only helps a message arriving from now on. Every confirmation stored before
 * it - including every row written before the resolution existed at all, and any stored while
 * forwarding was failing - is a receipt Litos holds and has never acted on. This is the function
 * that acts on them.
 *
 * Read-only about the mail: it re-reads the ledger and resolves packets. It sends nothing, forwards
 * nothing, and writes nothing to application_email_messages, so it cannot mail an employer or an
 * applicant however often it runs.
 *
 * NOT WIRED TO A SCHEDULER. There is no cron entry for it in vercel.json and no workflow calling it,
 * deliberately: adding one is a separate decision with its own blast radius. It is callable from a
 * route, a script, or a one-off.
 */
export async function reconcileSubmissionConfirmations(
  input: { userId?: string; limit?: number } = {},
  deps: {
    listConfirmations?: (query: { userId?: string; limit: number }) => Promise<Array<{
      applicationId: string;
      userId: string;
      alias: string;
      subject: string | null;
      receivedAt: Date;
    }>>;
    resolve?: typeof resolvePacketFromConfirmation;
  } = {},
): Promise<{ scanned: number; resolved: number; unchanged: number; reasons: Record<string, number> }> {
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
  const rows = await (deps.listConfirmations ?? listStoredConfirmations)({ userId: input.userId, limit });
  // Newest first from the query, so the first row seen for a packet is its most recent receipt and
  // the older ones would only report 'already_submitted' behind it.
  const newestPerPacket = new Map<string, typeof rows[number]>();
  for (const row of rows) {
    if (!newestPerPacket.has(row.applicationId)) newestPerPacket.set(row.applicationId, row);
  }
  const reasons: Record<string, number> = {};
  let resolved = 0;
  let unchanged = 0;
  for (const row of newestPerPacket.values()) {
    // One failing packet must not abort the pass: the rows iterate in a stable order, so an
    // uncaught throw here would not just lose this pass's counters, it would deterministically
    // kill every future pass at the same row.
    let outcome: SubmissionConfirmationOutcome;
    try {
      outcome = await (deps.resolve ?? resolvePacketFromConfirmation)({
        applicationId: row.applicationId,
        userId: row.userId,
        alias: row.alias,
        subject: row.subject ?? undefined,
        receivedAt: row.receivedAt,
      });
    } catch {
      unchanged += 1;
      reasons.resolver_error = (reasons.resolver_error ?? 0) + 1;
      continue;
    }
    if (outcome.resolved) {
      resolved += 1;
      continue;
    }
    unchanged += 1;
    reasons[outcome.reason] = (reasons[outcome.reason] ?? 0) + 1;
  }
  return { scanned: newestPerPacket.size, resolved, unchanged, reasons };
}

async function listStoredConfirmations(query: { userId?: string; limit: number }) {
  const rows = await db
    .select({
      applicationId: application_email_messages.generated_resume_id,
      userId: application_email_messages.user_id,
      alias: application_email_messages.alias,
      subject: application_email_messages.subject,
      receivedAt: application_email_messages.received_at,
      createdAt: application_email_messages.created_at,
    })
    .from(application_email_messages)
    .where(and(
      eq(application_email_messages.classification, 'submission_confirmation'),
      sql`${application_email_messages.generated_resume_id} is not null`,
      // Employer mail only. An 'outbound' row is the applicant's own reply leaving through the
      // alias, and nothing she writes may file her own application.
      sql`${application_email_messages.direction} <> 'outbound'`,
      ...(query.userId ? [eq(application_email_messages.user_id, query.userId)] : []),
    ))
    .orderBy(desc(sql`coalesce(${application_email_messages.received_at}, ${application_email_messages.created_at})`))
    .limit(query.limit);
  return rows.map((row) => ({
    applicationId: row.applicationId as string,
    userId: row.userId,
    alias: row.alias,
    subject: row.subject,
    receivedAt: row.receivedAt ?? row.createdAt,
  }));
}

export type ApplicationEmailHealth = {
  status: 'ok' | 'degraded' | 'not_configured';
  reason: AliasDeliverabilityReason;
  route_mode: ApplicationEmailRouteMode | null;
  route_mode_explicit: boolean;
  invalid_route_mode_present: boolean;
  ignored_legacy_domain_present: boolean;
  ignored_legacy_mailbox_present: boolean;
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
  const route = applicationEmailRouteSelection();
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
      : (check.reason === 'inbound_disabled' || (check.reason === 'alias_not_configured' && !route.explicit)
        ? 'not_configured'
        : 'degraded'),
    reason: check.reason,
    route_mode: route.mode,
    route_mode_explicit: route.explicit,
    invalid_route_mode_present: route.invalid_mode_present,
    ignored_legacy_domain_present: route.ignored_legacy_domain_present,
    ignored_legacy_mailbox_present: route.ignored_legacy_mailbox_present,
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
