/* THE THINGS LITOS MAY INTERRUPT A STUDENT WITH, and the record of her saying so.
 *
 * THE DIGEST RULE WAS REVERSED DELIBERATELY, 2026-08-19, by Mehek. This file used to say "no
 * digest, ever" and it meant it; the reasoning is kept here because the replacement has to answer
 * it rather than forget it. A digest of EVERYTHING OPEN is still refused, and the measurement that
 * made that call is still true: one real account holds 144 packets wanting attention, so a
 * notification reporting the backlog reports the same number every day, is unactionable, and
 * teaches somebody to dismiss the sender. What ships instead is a DELTA - what changed since the
 * last one - which is silent on a quiet day and is a list of events rather than a census. See
 * lib/activityDigest.ts, where that distinction is enforced rather than described.
 *
 * Still refused: weekly roundups, "tips", re-engagement mail, anything counting consecutive days.
 * The Guardrails ban daily-login rewards and streaks outright (non-relitigable, 2026-07-27), and a
 * notification subsystem is precisely the machinery somebody reaches for when they want to build
 * one, so the kinds are a closed list here and the send path refuses anything not on it. "Come back
 * to the platform" is only ever legitimate when something real is waiting, and the digest says so
 * by naming the thing rather than by naming the absence.
 *
 * WHY THIS IS NOT PART OF automationConsent.ts, which it visibly resembles. Those permissions
 * license Litos to ACT on an employer's form in the applicant's name, so each carries a consent
 * VERSION and a grant is read as invalid when the words change. These license a message. Nothing
 * downstream depends on which wording she saw, revocation reaches back nothing because nothing was
 * done under the grant, and a version column that no reader checks is worse than no column: it
 * looks like a guarantee. The grant timestamp is kept, because "when did you subscribe me to this"
 * is a question an unsubscribe complaint actually asks.
 */

export const NOTIFICATION_KINDS = ['strong_match', 'employer_reply', 'activity_digest'] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export function isNotificationKind(value: string): value is NotificationKind {
  return (NOTIFICATION_KINDS as readonly string[]).includes(value);
}

/**
 * How many of a kind may reach one student in one day, or null for no cap.
 *
 * TWO DIFFERENT ANSWERS ON PURPOSE, and the asymmetry is the product decision rather than an
 * oversight. A strong-match alert is Litos deciding on its own schedule that something is worth
 * interrupting somebody for, so it is capped at one a day and carries exactly one posting: a
 * digest of everything open is the thing this feature exists INSTEAD of. An employer reply is a
 * fact somebody else created about an application she already sent, and holding the second one
 * until tomorrow because a first arrived this morning would be Litos sitting on her mail.
 *
 * The cap is enforced by a unique index (notification_sends.daily_slot), never by a read. See
 * dailySlotFor and the table comment in db/schema.ts for why a read cannot do it.
 */
export const DAILY_CAP: Record<NotificationKind, number | null> = {
  strong_match: 1,
  /* Capped, and for a second reason on top of politeness: the digest reports what changed SINCE THE
     LAST ONE, so two in a day would make the second one's window a few hours wide and its counts
     meaninglessly small. One a day is what makes "since yesterday" true. */
  activity_digest: 1,
  employer_reply: null,
};

/**
 * The reservation string a send claims, or null for a kind with no cap.
 *
 * UTC DAYS, not the student's local day, and the choice is deliberate rather than lazy. Litos does
 * not store a timezone for anybody, so a "local day" would have to be guessed from the account's
 * locations or from the request that is not there (this runs on a cron, from nobody's browser).
 * Guessing wrong shifts the boundary and lets two alerts land in one of her days, which is the
 * exact failure the cap exists to prevent. A fixed UTC boundary can only ever be off by putting
 * the two alerts FURTHER apart than a day, which breaks nothing.
 *
 * Null for an uncapped kind, and the null is load-bearing: Postgres does not collide NULLs in a
 * unique index, so an uncapped kind writes a row that can never conflict with anything.
 */
export function dailySlotFor(kind: NotificationKind, at: Date): string | null {
  if (DAILY_CAP[kind] === null) return null;
  return `${kind}:${at.toISOString().slice(0, 10)}`;
}

/** The stored shape every preference verdict is derived from. Optional because the columns can be
 *  absent from a database the deploy has arrived ahead of. See notificationPreferencesFrom. */
export type NotificationPreferenceRow = {
  notify_strong_match_enabled?: boolean | null;
  notify_strong_match_granted_at?: Date | null;
  notify_employer_reply_enabled?: boolean | null;
  notify_employer_reply_granted_at?: Date | null;
  notify_activity_digest_enabled?: boolean | null;
  notify_activity_digest_granted_at?: Date | null;
};

export type NotificationPreference = { enabled: boolean; granted_at: string | null };
export type NotificationPreferences = Record<NotificationKind, NotificationPreference>;

/**
 * The preferences as every surface reports them, from a row that may be missing the columns.
 *
 * ABSENT READS AS OFF, and that is the same answer a migrated database holds by default, so the
 * window between a deploy and its migration behaves as an account that has not turned anything on.
 * That is the state every account is in until it does. The alternative - failing the read - would
 * take out /notifications/preferences and, through it, screen 08, for every student in the window.
 */
export function notificationPreferencesFrom(
  row: NotificationPreferenceRow | null | undefined,
): NotificationPreferences {
  return {
    strong_match: {
      enabled: row?.notify_strong_match_enabled === true,
      granted_at: row?.notify_strong_match_granted_at?.toISOString() ?? null,
    },
    employer_reply: {
      enabled: row?.notify_employer_reply_enabled === true,
      granted_at: row?.notify_employer_reply_granted_at?.toISOString() ?? null,
    },
    activity_digest: {
      enabled: row?.notify_activity_digest_enabled === true,
      granted_at: row?.notify_activity_digest_granted_at?.toISOString() ?? null,
    },
  };
}

/**
 * The column values one submitted change writes.
 *
 * THE GRANT TIMESTAMP IS ONLY WRITTEN BY A GRANT. Turning a permission ON stamps the moment;
 * turning it OFF clears it; leaving it alone writes nothing at all, including the timestamp. That
 * third case is what makes "she saved screen 08 without changing anything" not silently re-date a
 * consent she gave last month, and it is why this returns a partial object rather than a full row.
 *
 * RE-GRANTING RE-STAMPS. Somebody who turns an alert off in March and back on in June granted it
 * in June, and dating that back to March would misreport when Litos was allowed to start mailing
 * her. The caller does not compare against the stored value; a grant is a grant.
 */
export function notificationPreferenceUpdate(
  changes: Partial<Record<NotificationKind, boolean>>,
  at: Date,
): Record<string, boolean | Date | null> {
  const update: Record<string, boolean | Date | null> = {};
  if (changes.strong_match !== undefined) {
    update.notify_strong_match_enabled = changes.strong_match;
    update.notify_strong_match_granted_at = changes.strong_match ? at : null;
  }
  if (changes.employer_reply !== undefined) {
    update.notify_employer_reply_enabled = changes.employer_reply;
    update.notify_employer_reply_granted_at = changes.employer_reply ? at : null;
  }
  if (changes.activity_digest !== undefined) {
    update.notify_activity_digest_enabled = changes.activity_digest;
    update.notify_activity_digest_granted_at = changes.activity_digest ? at : null;
  }
  return update;
}
