import { eq } from 'drizzle-orm';
import { db } from '../db/index';
import { notification_sends } from '../db/schema';
import { sendEmail, type OutboundEmail } from './email';
import { dailySlotFor, type NotificationKind } from './notificationPreferences';
import { mintUnsubscribeToken, unsubscribeUrl } from './notificationUnsubscribe';

/* THE ONE DOOR EVERY NOTIFICATION LEAVES BY, and the reason there is only one.
 *
 * Three rules have to hold on every send, and each of them is the kind that gets forgotten by the
 * second caller rather than the first: reserve before sending so the cap survives concurrency,
 * never send without a working unsubscribe link, and never leave a reservation behind for a send
 * that did not happen. A second send site that got any one of them wrong would look identical in
 * review to one that got them right, so the rules live in a function instead of in a convention.
 *
 * THE ORDER IS RESERVE, SEND, COMMIT, and it is not the obvious order. Sending first and recording
 * afterwards reads better and is wrong: two overlapping runs both send, then both record, and the
 * student gets two emails for a cap of one. Inserting first means the loser of that race is
 * rejected by a unique index before it can call Resend, which is the only version of the cap that
 * does not depend on a lock nobody would remember to take.
 *
 * A FAILED SEND RELEASES ITS RESERVATION. If Resend times out, the row is deleted and the next run
 * may try the same thing again. The alternative, keeping the row, would spend the student's daily
 * slot on an email that never arrived. The narrow window between the insert and the delete is the
 * only place a crash can strand a reservation, and a stranded reservation costs one email rather
 * than sending a duplicate, which is the correct side to fail on.
 */

export type NotificationSuppression = 'daily_cap' | 'already_notified' | 'suppressed';

export type NotificationOutcome =
  | { sent: true; id: string; provider_message_id: string }
  | { sent: false; reason: NotificationSuppression | 'unsubscribe_unavailable' };

/**
 * Which index refused the reservation, which is to say WHY this student is not getting this email.
 *
 * THE CAUSE CHAIN IS WALKED, NOT THE TOP ERROR, and that is not defensiveness. drizzle wraps every
 * failed statement in a DrizzleQueryError carrying the pg error as `cause`, so `error.code` on what
 * this actually receives is undefined and a check that only looked at the top object would decide
 * every unique violation was an unexpected error and rethrow it. That turns the daily cap from
 * "this student already had one today" into a 500 out of the cron, and the shape of that mistake is
 * exactly why lib/applicationFacts.ts already walks the chain for 42703. Bounded at five links so a
 * cause that points at itself cannot spin.
 *
 * Read from the CONSTRAINT NAME rather than the message text: the message is a localisable server
 * string, the constraint name is the schema. An unrecognised unique violation is reported as
 * `suppressed` rather than guessed at, because the two real reasons carry different meanings for an
 * operator reading a cron summary and inventing one would be worse than admitting the gap.
 */
export function suppressionFor(error: unknown): NotificationSuppression | null {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    if ((current as { code?: unknown }).code === '23505') {
      const constraint = (current as { constraint?: unknown }).constraint;
      if (constraint === 'notification_sends_daily_slot_unique') return 'daily_cap';
      if (constraint === 'notification_sends_dedupe_key_unique') return 'already_notified';
      return 'suppressed';
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * Claim the right to notify, before anything is actually sent.
 *
 * SPLIT OUT SO EMAIL AND PUSH SHARE ONE LIMITER. The cap is a unique index, and an index only
 * protects the writers that go through it: a second transport that recorded its own sends its own
 * way would give every student two "one a day" allowances that neither one could see. There is one
 * ledger, one reservation, and the channel is a detail of what happens after it is granted.
 *
 * Returns the reservation id to commit or release. A caller that forgets to do either leaves a row
 * holding a daily slot for a send that never happened, which costs one notification rather than
 * sending a duplicate: the correct side to fail on, and the same trade the email path makes.
 */
export async function reserveNotification(input: {
  userId: string;
  kind: NotificationKind;
  dedupeKey: string;
  at: Date;
  monitoredJobId?: string | null;
  applicationEmailMessageId?: string | null;
}): Promise<{ reserved: true; id: string } | { reserved: false; reason: NotificationSuppression }> {
  try {
    const [row] = await db.insert(notification_sends).values({
      user_id: input.userId,
      kind: input.kind,
      daily_slot: dailySlotFor(input.kind, input.at),
      dedupe_key: input.dedupeKey,
      monitored_job_id: input.monitoredJobId ?? null,
      application_email_message_id: input.applicationEmailMessageId ?? null,
      created_at: input.at,
    }).returning({ id: notification_sends.id });
    if (!row) return { reserved: false, reason: 'suppressed' };
    return { reserved: true, id: row.id };
  } catch (error) {
    const suppression = suppressionFor(error);
    if (suppression) return { reserved: false, reason: suppression };
    throw error;
  }
}

/** Stamp a reservation as actually delivered. `providerMessageId` is null for channels that
 *  return no id of their own, which push does not. */
export async function commitNotification(id: string, at: Date, providerMessageId: string | null): Promise<void> {
  await db.update(notification_sends)
    .set({ sent_at: at, provider_message_id: providerMessageId })
    .where(eq(notification_sends.id, id));
}

/** Give the slot back, so the next run may try again. Best effort: the send error is the one worth
 *  reporting, and a failure to release costs one notification rather than sending a duplicate. */
export async function releaseNotification(id: string): Promise<void> {
  await db.delete(notification_sends).where(eq(notification_sends.id, id)).catch(() => undefined);
}

export type NotificationSendDeps = {
  send?: (payload: OutboundEmail) => Promise<string>;
  now?: () => Date;
};

export type NotificationSendInput = {
  userId: string;
  kind: NotificationKind;
  /** What this notification is ABOUT, prefixed by kind. One thing is announced once, ever. */
  dedupeKey: string;
  monitoredJobId?: string | null;
  applicationEmailMessageId?: string | null;
  /**
   * The message, built from the unsubscribe URL this send minted.
   *
   * A callback rather than a finished payload so the link cannot be omitted by a caller: there is
   * no way to reach this function with an email that has not been handed one. An account whose
   * deployment cannot mint a link never reaches the builder at all and never sends.
   */
  build: (unsubscribeUrl: string) => OutboundEmail;
};

export async function sendNotification(
  input: NotificationSendInput,
  deps: NotificationSendDeps = {},
): Promise<NotificationOutcome> {
  const at = (deps.now ?? (() => new Date()))();

  /* NO LINK, NO SEND, checked before the reservation so a misconfigured deployment does not burn a
     daily slot discovering it. An email a student cannot stop is not one Litos is entitled to put
     in her inbox, whatever she agreed to on screen 08. */
  let link: string | null = null;
  try {
    link = unsubscribeUrl(mintUnsubscribeToken(input.userId, input.kind));
  } catch {
    link = null;
  }
  if (!link) return { sent: false, reason: 'unsubscribe_unavailable' };

  const reservation = await reserveNotification({ ...input, at });
  if (!reservation.reserved) return { sent: false, reason: reservation.reason };

  let providerMessageId: string;
  try {
    providerMessageId = await (deps.send ?? sendEmail)(input.build(link));
  } catch (error) {
    /* Release, so tomorrow's run may try again. Deleting is deliberate rather than marking the row
       failed: a failure row would still hold the unique daily slot, which is the same as spending
       it. */
    await releaseNotification(reservation.id);
    throw error;
  }

  await commitNotification(reservation.id, at, providerMessageId);
  return { sent: true, id: reservation.id, provider_message_id: providerMessageId };
}
