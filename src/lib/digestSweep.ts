import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { push_subscriptions, users } from '../db/schema';
import {
  activityDigestDedupeKey,
  activityDigestFor,
  digestMessage,
  lastDigestAt,
  type ActivityDigest,
} from './activityDigest';
import { commitNotification, releaseNotification, reserveNotification } from './notificationSend';
import { pushToUser } from './webPush';
import { PRODUCT_LINKS } from './product';

/* THE DAILY DIGEST RUN, and the two ways it stays quiet.
 *
 * QUIET ONE: NOTHING HAPPENED. activityDigestFor returns zeroes and no notification is reserved at
 * all, so a student with a quiet day gets silence rather than "0 applications". That is the whole
 * argument for a delta over a standing total, and it is enforced here by checking `empty` BEFORE
 * touching the ledger: a run that reserved first and then discovered it had nothing to say would
 * burn the daily slot on an empty digest and suppress a real one later the same day.
 *
 * QUIET TWO: NOBODY IS LISTENING. An account with the toggle on but no live push subscription has
 * no device to reach, and the run skips it without spending anything. Push subscriptions die
 * silently (see webPush.ts), so "subscribed" and "reachable" are different questions here in
 * exactly the way "opted in" and "has a verified email" are different for mail.
 *
 * THE WINDOW IS FROM THE LAST DIGEST, not a fixed day. A cron that fails on Tuesday makes
 * Wednesday's digest cover both days rather than dropping Tuesday's activity, and the first digest
 * an account ever gets is bounded by FIRST_DIGEST_LOOKBACK rather than reaching back over its whole
 * history, which would otherwise open with a summary of work done months ago.
 */

/** How far back the FIRST digest for an account may look. */
export const FIRST_DIGEST_LOOKBACK_HOURS = 24;

export type DigestSweepSummary = {
  considered: number;
  with_devices: number;
  had_news: number;
  sent: number;
  suppressed: Record<string, number>;
  failed: number;
};

/**
 * Accounts that want a digest AND have somewhere to put it.
 *
 * The join is the point. Unlike email, where an address is a durable property of the account, a
 * push subscription is per device and evaporates when a browser is reset. Selecting on the toggle
 * alone would report a sweep that "considered" fifty students while reaching nobody.
 */
export async function digestRecipients(limit: number): Promise<Array<{ id: string }>> {
  return db
    .selectDistinct({ id: users.id })
    .from(users)
    .innerJoin(push_subscriptions, eq(push_subscriptions.user_id, users.id))
    .where(and(eq(users.notify_activity_digest_enabled, true), eq(users.is_guest, false)))
    .orderBy(users.id)
    .limit(limit);
}

export type DigestSweepDeps = {
  digestFor?: (userId: string, since: Date) => Promise<ActivityDigest>;
  push?: typeof pushToUser;
};

export async function runDigestSweep(
  now: Date,
  limit: number,
  log?: { warn: (o: unknown, m: string) => void; error: (o: unknown, m: string) => void },
  deps: DigestSweepDeps = {},
): Promise<DigestSweepSummary> {
  const recipients = await digestRecipients(limit);
  const summary: DigestSweepSummary = {
    considered: recipients.length,
    with_devices: recipients.length,
    had_news: 0,
    sent: 0,
    suppressed: {},
    failed: 0,
  };
  const fallback = new Date(now.getTime() - FIRST_DIGEST_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const account of recipients) {
    try {
      const since = await lastDigestAt(account.id, fallback);
      const digest = await (deps.digestFor ?? activityDigestFor)(account.id, since);
      if (digest.empty) continue;
      const message = digestMessage(digest);
      if (!message) continue;
      summary.had_news += 1;

      /* Reserved only once there is something to say, so an empty day never spends the slot. */
      const reservation = await reserveNotification({
        userId: account.id,
        kind: 'activity_digest',
        dedupeKey: activityDigestDedupeKey(account.id, now),
        at: now,
      });
      if (!reservation.reserved) {
        summary.suppressed[reservation.reason] = (summary.suppressed[reservation.reason] ?? 0) + 1;
        continue;
      }

      const delivery = await (deps.push ?? pushToUser)(account.id, {
        title: message.title,
        body: message.body,
        url: new URL('/dashboard/applications', PRODUCT_LINKS.website).toString(),
        /* One tag for the kind, so a digest that was never seen is REPLACED by the next one rather
           than stacking. Two unread summaries of overlapping windows is worse than one current. */
        tag: 'litos-activity-digest',
      });

      if (delivery.delivered === 0) {
        /* Every device was dead or unreachable, so nothing was shown to anybody. Releasing means
           tomorrow can try again, and it keeps the ledger honest: a row claiming a notification was
           sent when no screen ever lit up is worse than no row. */
        await releaseNotification(reservation.id);
        summary.suppressed.no_reachable_device = (summary.suppressed.no_reachable_device ?? 0) + 1;
        continue;
      }
      await commitNotification(reservation.id, now, null);
      summary.sent += 1;
    } catch (error) {
      summary.failed += 1;
      log?.error({ userId: account.id, err: error }, 'activity digest failed for one account');
    }
  }
  return summary;
}

/** Only for the operator endpoint: what a given account's digest says right now, sending nothing. */
export async function previewDigest(userId: string, now: Date) {
  const since = await lastDigestAt(userId, new Date(now.getTime() - FIRST_DIGEST_LOOKBACK_HOURS * 60 * 60 * 1000));
  const digest = await activityDigestFor(userId, since);
  const [devices] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(push_subscriptions)
    .where(eq(push_subscriptions.user_id, userId));
  return { since: since.toISOString(), digest, message: digestMessage(digest), devices: devices?.n ?? 0 };
}
