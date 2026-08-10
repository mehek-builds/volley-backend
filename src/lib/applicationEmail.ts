import { createHash, timingSafeEqual } from 'crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { application_email_aliases, application_email_messages, generated_resumes, users } from '../db/schema';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
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
  /* THE ACCOUNT WALL. An employer portal that will not show an application form until an account
   * exists, and every step of building that account arrives by mail: confirm this address, verify
   * this account, your account has been created, activate it, set a password, reset a password.
   *
   * One classification rather than six because they are one job with one destination. Every one of
   * them is useless to a machine and only actionable by the person holding the mailbox, which is
   * exactly why the previous whitelist made account-walled portals (jobvite, icims, oraclecloud,
   * ultipro, sap_successfactors, oracle_taleo, adp_recruiting, avature) impossible to register on:
   * the activation link was stored and never reached anyone. */
  | 'account_registration'
  | 'recruiter_reply'
  // The applicant answering the employer through her own alias. Never produced by the text
  // classifier: it is decided by WHO SENT IT, not by what it says.
  | 'applicant_reply'
  | 'other';

/* Why a message was kept from the applicant. There is exactly one reason, and it is narrow on
 * purpose: see applicationEmailForwardingDecision. */
export type ApplicationEmailWithholdReason =
  /* A one-time code that a managed session is spending on this same application right now. */
  | 'security_code_in_flight'
  /* Her own message, travelling outward through the relay. Sending it back in would be an echo. */
  | 'applicant_reply';

export type ApplicationEmailForwardingDecision =
  | { forward: true }
  | { forward: false; reason: ApplicationEmailWithholdReason };

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

/* THE NOUN AN ACCOUNT-WALL MESSAGE IS ABOUT, and the whole reason these patterns are anchored.
 *
 * "Activate your account" and "activate your career alerts" differ by one noun, and the second is a
 * marketing blast every ATS sends. A loose alternation on the verbs alone would classify both, so
 * the verb has to reach an object out of this list for the message to be about an account at all. */
const ACCOUNT_NOUN = '(?:accounts?|profiles?|logins?|registrations?'
  + '|candidate (?:account|profile|home|portal)'
  + '|career(?:s)? (?:account|profile|portal|site|cent(?:er|re))'
  + '|talent (?:profile|community|network)'
  + '|applicant (?:account|profile))';

export function classifyApplicationEmail(subject = '', text = ''): ApplicationEmailClassification {
  const haystack = `${subject}\n${text}`.toLowerCase();
  /* "confirm your email" USED TO LIVE HERE and does not any more. It is the opening line of an
   * account-wall activation mail and it carries no code, so treating it as a security code both
   * misnamed it and, under the old whitelist, buried it. A message is a verification_code when it
   * hands over a credential, which is what every alternative below actually names. */
  if (/\b(verification code|security code|one[- ]?time|otp|passcode)\b/.test(haystack)) {
    return 'verification_code';
  }
  /* BEFORE the account-wall test, so a confirmation that opens "Welcome to Acme" and closes with a
   * link to the candidate portal stays what it is: a receipt for an application that was filed. */
  if (/\b(thank you for applying|thanks for applying|application (?:has been )?received|we received your application|successfully submitted|application submitted)\b/.test(haystack)) {
    return 'submission_confirmation';
  }
  const accountRegistration =
    // "Please confirm your email address", "Verify your account", "Activate your candidate account".
    new RegExp(`\\b(?:confirm|verify|validate|activate)\\b.{0,30}\\b(?:your|the)\\b.{0,25}\\b(?:e-?mail(?: address)?|${ACCOUNT_NOUN})\\b`).test(haystack)
    // "Your account has been created", "A candidate profile was created for you".
    || new RegExp(`\\b(?:your|a|an|the)\\s+(?:new\\s+)?${ACCOUNT_NOUN}\\s+(?:has been|have been|was|were|is|are)\\s+(?:created|registered|set up|activated)\\b`).test(haystack)
    || new RegExp(`\\b${ACCOUNT_NOUN}\\s+(?:created|activated|registered)\\b`).test(haystack)
    // "Thanks for registering", "Welcome to the Acme careers portal".
    || /\b(?:thanks|thank you)\s+for\s+(?:registering|signing up|creating (?:an|your) account)\b/.test(haystack)
    || new RegExp(`\\bwelcome\\b.{0,40}\\b${ACCOUNT_NOUN}\\b`).test(haystack)
    // "Reset your password", "Set your password", "Password reset requested".
    || /\b(?:reset|set|create|choose|change)\b.{0,20}\byour\b.{0,20}\bpassword\b/.test(haystack)
    || /\bpassword\s+reset\b/.test(haystack);
  if (accountRegistration) return 'account_registration';
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

/* THE WINDOW IN WHICH A RUN IS STILL SPENDING A CODE, mirroring MAX_CODE_AGE_MS and CLOCK_SKEW_MS
 * in lib/emailVerification.ts, which is the window the code READER accepts. Deliberately not
 * imported: emailVerification imports this module, and an import cycle between them would be a
 * worse defect than a repeated number. If one moves, move both. */
const SECURITY_CODE_CONSUMPTION_WINDOW_MS = 10 * 60_000;
const SECURITY_CODE_CLOCK_SKEW_MS = 30_000;

/* Is a managed session consuming a one-time code for this application AT THIS MOMENT.
 *
 * This is the entire justification for the one thing Litos withholds, so it answers narrowly and
 * it answers no when it does not know. A packet that is not waiting on a code, or whose wait began
 * more than the reader's own window ago, is not racing anybody: the run has already finished,
 * failed, or timed out, and the code in that message is hers to use by hand.
 */
export function managedSessionIsConsumingSecurityCode(
  review: Pick<ApplicationReviewState, 'status' | 'security_code' | 'verification'> | null | undefined,
  now: Date,
): boolean {
  if (!review) return false;
  const verificationStatus = review.verification?.status;
  const requestedAt = review.status === 'awaiting_security_code'
    ? review.security_code?.requested_at ?? review.verification?.requested_at
    : (verificationStatus === 'searching' || verificationStatus === 'verification_pending')
      ? review.verification?.requested_at
      : undefined;
  if (!requestedAt) return false;
  const requested = new Date(requestedAt).getTime();
  if (Number.isNaN(requested)) return false;
  const age = now.getTime() - requested;
  return age >= -SECURITY_CODE_CLOCK_SKEW_MS && age <= SECURITY_CODE_CONSUMPTION_WINDOW_MS;
}

/* WHAT LEAVES LITOS. This is a list of what to WITHHOLD, and it has one entry.
 *
 * It used to be the opposite: an allowlist of two classifications, submission_confirmation and
 * interview_request, with everything else stored and dropped in silence. Measured against the
 * shipped classifier on 2026-08-10, that meant an activation link, a password reset, an assessment
 * invitation, a rejection and an OFFER LETTER all landed in the ledger and reached nobody, with
 * direction still 'inbound', forwarded_at NULL and forward_error NULL, which is indistinguishable
 * from a message nothing had looked at. It forwarded zero messages in the day it was live.
 *
 * The direction is inverted because the premise was wrong. The applicant's own address is the one
 * the employer thinks it is writing to; the alias is a forwarding address, not an editor. So the
 * question is no longer "is this important enough to send on", which is a judgement Litos is not
 * entitled to make about someone else's mail, but "is there a concrete mechanical reason this
 * exact message must not go out right now".
 *
 * There is exactly one such reason, and it is not importance:
 *
 *   verification_code, while a managed session is consuming it. A one-time code is spent by
 *   whoever types it first. If the runner is mid-submit and she is also handed the code, the two
 *   race, the code burns, and the application is filed by neither. Outside that window (see
 *   managedSessionIsConsumingSecurityCode) nothing is racing her, so the code forwards like
 *   everything else, which is what makes a stalled or failed run recoverable by hand.
 *
 *   applicant_reply is listed too, but it is not a policy: it is her own message on its way OUT
 *   through relayApplicantReply, and mailing it back to her would be an echo between two mail
 *   systems. The inbound path routes by sender before it classifies and can never reach this
 *   branch; it is here so the function is total.
 *
 * Everything else forwards, including 'other'. That bucket does not mean unimportant, it means
 * unrecognised, and it is where the offer letter and the rejection both land. A classifier's
 * failure to name a message is not grounds for keeping it from the person it was addressed to.
 *
 * Every withhold is written to application_email_messages.forward_decision and counted in /health,
 * so a drop can be seen. An invisible drop is the failure this function exists to end.
 */
export function applicationEmailForwardingDecision(
  classification: ApplicationEmailClassification,
  context: { securityCodeInFlight?: boolean } = {},
): ApplicationEmailForwardingDecision {
  if (classification === 'applicant_reply') return { forward: false, reason: 'applicant_reply' };
  if (classification === 'verification_code' && context.securityCodeInFlight === true) {
    return { forward: false, reason: 'security_code_in_flight' };
  }
  return { forward: true };
}

function storedApplicationEmailClassification(value: string): ApplicationEmailClassification {
  switch (value) {
    case 'submission_confirmation':
    case 'interview_request':
    case 'verification_code':
    case 'account_registration':
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

/* Record what the router decided about one stored message.
 *
 * Tolerates the column not existing, because on Vercel a merge is a deploy and this can be live
 * before `npm run db:application-email-forward-decision` has run. Losing the annotation for a few
 * minutes is survivable; refusing to deliver the mail because we could not annotate it is not, so
 * this never fails the delivery path on that one error. Any other database failure still throws:
 * a webhook that cannot write is a real incident and the caller retries against a deduped row. */
async function recordForwardDecision(messageId: string, decision: string): Promise<void> {
  try {
    await db.update(application_email_messages)
      .set({ forward_decision: decision })
      .where(eq(application_email_messages.id, messageId));
  } catch (error) {
    if (!isUndefinedColumnError(error)) throw error;
  }
}

/* Whether a managed session is spending a one-time code on this application as the message lands.
 *
 * Answers false when there is no application, no packet, or no readable review. Not knowing is not
 * evidence of a race, and the cost of the two errors is not symmetric: a needless forward is one
 * extra email, while a needless withhold is a code she never sees and an application nobody can
 * finish. */
async function securityCodeConsumptionInFlight(applicationId: string | null, now: Date): Promise<boolean> {
  if (!applicationId) return false;
  try {
    const rows = await db
      .select({ spec: generated_resumes.spec })
      .from(generated_resumes)
      .where(eq(generated_resumes.id, applicationId))
      .limit(1);
    return managedSessionIsConsumingSecurityCode(readApplicationReview(rows[0]?.spec), now);
  } catch {
    return false;
  }
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
  const storedClassification = message
    ? storedApplicationEmailClassification(message.classification)
    : classification;
  // Only a code can be withheld, so only a code is worth a second read of the packet.
  const securityCodeInFlight = storedClassification === 'verification_code'
    ? await securityCodeConsumptionInFlight(aliasRow.generated_resume_id, receivedAt)
    : false;
  const forwardingDecision = applicationEmailForwardingDecision(storedClassification, { securityCodeInFlight });
  if (!forwardingDecision.forward) {
    if (message) await recordForwardDecision(message.id, `withheld:${forwardingDecision.reason}`);
    return {
      accepted: true,
      alias: aliasRow.alias,
      classification: storedClassification,
      forwarded: false,
      reason: forwardingDecision.reason,
    };
  }
  if (!message || message.forwarded_at) {
    return { accepted: true, alias: aliasRow.alias, classification: storedClassification, forwarded: false };
  }
  /* Written BEFORE the claim and the send, so the row states the decision even if the send then
   * throws. A failed send leaves forward_decision 'forward' and the cause in forward_error, which
   * are two different facts and are recorded as two. */
  await recordForwardDecision(message.id, 'forward');

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
      inbound: {
        from: message.from_email ?? undefined,
        to: [aliasRow.alias],
        subject: message.subject ?? undefined,
        text: message.text ?? undefined,
        html: message.html ?? undefined,
        receivedAt: message.received_at ?? undefined,
      },
      classification: storedClassification,
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

  if (storedClassification === 'submission_confirmation' && aliasRow.generated_resume_id) {
    await markSubmittedFromConfirmation({
      applicationId: aliasRow.generated_resume_id,
      alias: aliasRow.alias,
      subject: message.subject ?? undefined,
      receivedAt: message.received_at ?? receivedAt,
    });
  }
  return { accepted: true, alias: aliasRow.alias, classification: storedClassification, forwarded };
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
  /* HOW MUCH MAIL WAS STORED AND DELIBERATELY NOT SENT ON, in the window below.
   *
   * last_inbound_message_at was the only message fact here, and it cannot see this failure: during
   * the whole of 2026-08-10 messages were arriving, that timestamp was fresh, and every one of
   * them was being dropped. A probe that only asks "is mail landing" reports a healthy inbox for a
   * service that is delivering nothing.
   *
   * NULL means the count could not be taken, including on a database that has not run the
   * forward_decision migration. It is deliberately not 0: "nothing was withheld" and "we cannot
   * see what was withheld" are different answers, and reporting the second as the first is the
   * exact shape of the bug this field exists to expose. */
  withheld_messages_recent: number | null;
  withheld_messages_window_hours: number;
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
export const WITHHELD_MESSAGE_WINDOW_HOURS = 24;

export async function applicationEmailHealth(): Promise<ApplicationEmailHealth> {
  const check = await applicationAliasDeliverability();
  const route = applicationEmailRouteSelection();
  const withheldSince = new Date(Date.now() - WITHHELD_MESSAGE_WINDOW_HOURS * 60 * 60 * 1000);
  const [aliasCount, lastInbound, withheldCount] = await Promise.all([
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
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(application_email_messages)
      .where(and(
        sql`${application_email_messages.forward_decision} like 'withheld:%'`,
        sql`coalesce(${application_email_messages.received_at}, ${application_email_messages.created_at}) >= ${withheldSince}`,
      ))
      .then((rows) => Number(rows[0]?.count ?? 0))
      // Including the undefined_column error a database that has not run the migration raises. See
      // the field comment: null here means unmeasurable, never "none".
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
    withheld_messages_recent: withheldCount,
    withheld_messages_window_hours: WITHHELD_MESSAGE_WINDOW_HOURS,
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
