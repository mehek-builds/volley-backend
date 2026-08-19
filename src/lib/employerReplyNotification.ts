import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes, users } from '../db/schema';
import type { ApplicationEmailClassification } from './applicationEmail';
import { employerReplyEmail } from './notificationEmail';
import { sendNotification, type NotificationOutcome } from './notificationSend';

/* "TELL ME WHEN AN EMPLOYER REPLIES", and the one thing it must never become: a second copy of the
 * forwarding path.
 *
 * Employer mail arriving at an application alias already has a delivery rule, and it predates this
 * feature: applicationEmailForwardingDecision sends submission receipts and interview logistics
 * straight on to the applicant, in full, and keeps everything else internal. That rule is not a
 * notification preference and this module does not touch it. Forwarding is MAIL DELIVERY, the
 * standing purpose of the alias the student handed to the employer, and putting it behind a toggle
 * added later would mean somebody who declines an alert stops receiving their own interview
 * invitations. Nobody asked for that and nobody would expect it.
 *
 * So this fills the hole the forwarding rule leaves rather than duplicating what it covers:
 *
 *   submission_confirmation  FORWARDED. The mail itself lands. A notification saying mail landed,
 *   interview_request        arriving beside the mail, is the same event announced twice.
 *   verification_code        NEVER. Held internally on purpose so the managed session can read the
 *                            code out of it, and it is a credential. "An employer replied" is also
 *                            simply not what a six digit code is.
 *   applicant_reply          NEVER. That is the STUDENT'S own message on its way out. Telling her
 *                            she has replied to herself is the shape of bug that survives review
 *                            because nobody pictures the outbound leg.
 *   recruiter_reply          NOTIFIED. A human wrote back and nothing else would tell her.
 *   other                    NOTIFIED, and this is the important one rather than the leftover. The
 *                            classifier is regexes over a subject line; a real reply reading "Hi,
 *                            are you free Thursday?" matches none of them and lands here. Excluding
 *                            `other` would mean the plainest human replies were the ones this
 *                            feature missed.
 *
 * BECAUSE `other` IS INCLUDED, THE COPY CANNOT OVERCLAIM. See notificationEmail.ts: the message
 * says mail arrived for this application and where to read it, never what it said and never
 * whether it is good news.
 */

/** Classifications this feature is silent about, whatever the account has switched on. */
const NEVER_NOTIFIED: ReadonlySet<ApplicationEmailClassification> = new Set([
  'verification_code',
  'applicant_reply',
]);

export function shouldNotifyEmployerReply(input: {
  classification: ApplicationEmailClassification;
  /** True when the forwarding path has already put this exact message in the student's inbox. */
  forwarded: boolean;
}): boolean {
  if (input.forwarded) return false;
  return !NEVER_NOTIFIED.has(input.classification);
}

/** One inbound message produces one notification, however many times the webhook redelivers it. */
export function employerReplyDedupeKey(messageId: string): string {
  return `employer_reply:${messageId}`;
}

type PacketIdentity = { company: string | null; role: string | null };

/**
 * Which employer and role this alias was applying to, when the packet says.
 *
 * Both halves are nullable and the email renders around whichever it has. `job_context` is written
 * by every generation path but its contents are the caller's, so neither key is guaranteed to be a
 * string, and an alias with no packet behind it (a routing alias that was never bound) has neither.
 */
async function packetIdentity(applicationId: string | null): Promise<PacketIdentity> {
  if (!applicationId) return { company: null, role: null };
  const [row] = await db
    .select({ job_context: generated_resumes.job_context })
    .from(generated_resumes)
    .where(eq(generated_resumes.id, applicationId))
    .limit(1);
  const context = row?.job_context as { company?: unknown; role?: unknown } | null | undefined;
  return {
    company: typeof context?.company === 'string' && context.company.trim() ? context.company.trim() : null,
    role: typeof context?.role === 'string' && context.role.trim() ? context.role.trim() : null,
  };
}

export type EmployerReplyNotificationInput = {
  userId: string;
  /** The stored application_email_messages row this concerns. The dedupe key is built from it. */
  messageId: string;
  applicationId: string | null;
  classification: ApplicationEmailClassification;
  receivedAt: Date;
  forwarded: boolean;
};

/**
 * Send the alert, or say why not.
 *
 * NEVER THROWS PAST ITS CALLER'S EXPECTATIONS, because of where it is called from. The inbound
 * webhook's contract is that a throw means "not handled, redeliver", and it is a contract worth
 * protecting: the forwarding path uses it to retry a failed forward. A notification is not worth
 * a redelivery of the whole message, so the caller wraps this and swallows, and this returns a
 * reason rather than signalling by exception wherever it can.
 *
 * THE ADDRESS IS THE VERIFIED ACCOUNT EMAIL, not the alias row's forward_to. They are usually the
 * same and the difference matters when they are not: forward_to is where EMPLOYER mail is relayed,
 * which a student may point at a second mailbox, while this is Litos writing to the account holder
 * about their tracker. Sending only to a verified address is also what keeps a bounce rate off the
 * domain that every student's application mail depends on.
 */
export async function notifyEmployerReply(
  input: EmployerReplyNotificationInput,
): Promise<NotificationOutcome | { sent: false; reason: 'not_notifiable' | 'not_subscribed' | 'no_verified_email' }> {
  if (!shouldNotifyEmployerReply(input)) return { sent: false, reason: 'not_notifiable' };

  const [account] = await db
    .select({ email: users.email, enabled: users.notify_employer_reply_enabled })
    .from(users)
    .where(and(eq(users.id, input.userId), eq(users.email_verified, true), eq(users.is_guest, false)))
    .limit(1);
  if (!account?.email) return { sent: false, reason: 'no_verified_email' };
  if (account.enabled !== true) return { sent: false, reason: 'not_subscribed' };

  const identity = await packetIdentity(input.applicationId);
  const to = account.email;

  return sendNotification({
    userId: input.userId,
    kind: 'employer_reply',
    dedupeKey: employerReplyDedupeKey(input.messageId),
    applicationEmailMessageId: input.messageId,
    build: (unsubscribeUrl) => employerReplyEmail({
      to,
      unsubscribeUrl,
      company: identity.company,
      role: identity.role,
      receivedAt: input.receivedAt,
    }),
  });
}
