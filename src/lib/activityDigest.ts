import { and, eq, gt, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { application_email_messages, generated_resumes, notification_sends } from '../db/schema';

/* WHAT CHANGED SINCE THE LAST TIME LITOS INTERRUPTED YOU, and nothing that did not.
 *
 * A DELTA, NOT A STANDING TOTAL, and the difference is the whole feature. Measured on the live
 * database while this was being designed, one real account held 118 packets in `needs_attention`,
 * 24 `failed` and 2 `ready_for_final_approval`: 144 items that "need you". A notification reporting
 * that number reports it again tomorrow, and the day after, because a backlog is a state rather
 * than an event. It is unactionable by construction (144 is not a to-do, it is a mood) and it
 * trains somebody to dismiss the sender, which then costs them the one notification that mattered.
 *
 * So every number here is bounded by a timestamp: things that BECAME true since the last digest.
 * On a quiet day every count is zero and the caller sends nothing at all, which is the behaviour
 * that makes a noisy day worth reading.
 *
 * WHERE THE TIMESTAMPS COME FROM, because this was nearly impossible and then turned out not to be.
 * `application_submission_events` looks like the right source and is EMPTY: zero rows in
 * production, ever. Nothing writes it. The real record lives inside `generated_resumes.spec`, under
 * `_review`:
 *
 *   _review.submitted_at   present on exactly the packets whose status is 'submitted' (27 of 27
 *                          when measured), so "applied for you" is exact rather than inferred.
 *   _review.updated_at     present on every packet with a review at all (452 of 452). This is when
 *                          the review state last moved, which is what makes "came back needing you"
 *                          a dated event instead of a census of the backlog.
 *
 * Both are JSON text rather than columns, so they are cast in SQL. A row whose timestamp will not
 * cast is EXCLUDED rather than counted, which is the safe direction: an uncountable packet makes
 * the digest quieter, never louder, and never invents an event that has no time attached.
 */

/**
 * The statuses that genuinely want the student, and only those.
 *
 * `ready_to_submit` is deliberately absent even though it is arguably waiting on her. It is the
 * ordinary resting state of a prepared packet, so counting it would put a number in every digest
 * forever and undo the point of a delta. `awaiting_security_code` IS here: Litos has already sent
 * that application once and is stuck on eight characters in her mailbox, which is the most
 * time-sensitive thing this product ever has to say.
 */
export const NEEDS_YOU_STATUSES = [
  'needs_attention',
  'ready_for_final_approval',
  'awaiting_security_code',
  'failed',
] as const;

export type ActivityDigest = {
  /** Packets whose `_review.submitted_at` fell in the window. Litos sent these to an employer. */
  applied: number;
  /** Packets that MOVED into a state wanting the student during the window. */
  needs_you: number;
  /** Employer mail that arrived in the window. Counted, never quoted. */
  employer_replies: number;
  /** The employers behind `applied`, for a line that names something rather than counting it. */
  applied_companies: string[];
  /** True when there is nothing worth interrupting anybody for. */
  empty: boolean;
};

export function digestIsEmpty(digest: Omit<ActivityDigest, 'empty'>): boolean {
  return digest.applied === 0 && digest.needs_you === 0 && digest.employer_replies === 0;
}

/**
 * When this account was last sent a digest, or null if never.
 *
 * THE WINDOW IS THE LEDGER, not a fixed 24 hours, and that is what makes a missed run harmless. If
 * the cron fails on Tuesday, Wednesday's digest covers both days rather than silently dropping
 * Tuesday's activity on the floor. It also means the first digest an account ever receives is
 * bounded by `fallback` instead of reaching back over its entire history, which would otherwise
 * open with "Litos applied to 27 roles" for work done months ago.
 */
export async function lastDigestAt(userId: string, fallback: Date): Promise<Date> {
  const [row] = await db
    .select({ at: sql<Date | null>`max(${notification_sends.created_at})` })
    .from(notification_sends)
    .where(and(eq(notification_sends.user_id, userId), eq(notification_sends.kind, 'activity_digest')));
  const at = row?.at ? new Date(row.at) : null;
  if (!at || Number.isNaN(at.getTime())) return fallback;
  return at > fallback ? at : fallback;
}

/**
 * Everything that happened for one account in one window.
 *
 * Three independent reads rather than one join. They touch different tables on different keys and
 * a join would make the whole digest fail when any one of them does, which for a courtesy
 * notification is the wrong trade: two thirds of a digest is still worth sending.
 */
export async function activityDigestFor(userId: string, since: Date): Promise<ActivityDigest> {
  const reviewedAt = sql`(${generated_resumes.spec}->'_review'->>'updated_at')`;
  const submittedAt = sql`(${generated_resumes.spec}->'_review'->>'submitted_at')`;
  /* Postgres refuses to cast a malformed timestamp and takes the statement down with it, so every
     comparison is guarded by a regex on the text first. A packet carrying a nonsense date is
     dropped from the count rather than allowed to fail the read for everything else. */
  const castable = (column: ReturnType<typeof sql>) =>
    sql`${column} ~ '^\\d{4}-\\d{2}-\\d{2}T' and (${column})::timestamptz`;

  const [appliedRows, needsRows, replyRows] = await Promise.all([
    db.select({
      company: sql<string>`coalesce(${generated_resumes.job_context}->>'company', '')`,
    })
      .from(generated_resumes)
      .where(and(
        eq(generated_resumes.user_id, userId),
        sql`${submittedAt} is not null`,
        sql`${castable(submittedAt)} > ${since.toISOString()}`,
      )),
    db.select({ n: sql<number>`count(*)::int` })
      .from(generated_resumes)
      .where(and(
        eq(generated_resumes.user_id, userId),
        sql`${generated_resumes.spec}->'_review'->>'status' in ${NEEDS_YOU_STATUSES}`,
        sql`${reviewedAt} is not null`,
        sql`${castable(reviewedAt)} > ${since.toISOString()}`,
      )),
    db.select({ n: sql<number>`count(*)::int` })
      .from(application_email_messages)
      .where(and(
        eq(application_email_messages.user_id, userId),
        /* Employer mail only. `applicant_reply` is the student's own message on its way out, and
           counting it would report her to herself. */
        sql`${application_email_messages.direction} <> 'outbound'`,
        sql`${application_email_messages.classification} <> 'applicant_reply'`,
        gt(application_email_messages.created_at, since),
      )),
  ]);

  const companies = [...new Set(appliedRows.map((row) => row.company.trim()).filter(Boolean))];
  const counts = {
    applied: appliedRows.length,
    needs_you: needsRows[0]?.n ?? 0,
    employer_replies: replyRows[0]?.n ?? 0,
    applied_companies: companies,
  };
  return { ...counts, empty: digestIsEmpty(counts) };
}

/**
 * The sentence a laptop notification actually shows, and its length is the constraint.
 *
 * A push notification is a title and a couple of lines in an OS panel; there is no room for a
 * table and no second chance if it is truncated mid-word. So the body names at most the two
 * biggest facts and the click takes them to the tracker for the rest.
 *
 * IT NEVER SAYS "APPLIED" FOR WORK THAT WAS NOT SENT. `applied` counts packets carrying a real
 * `submitted_at`, which is written when an employer actually received the form. Packets that were
 * merely built say nothing here, because "Litos applied to 22 roles for you" when it prepared 22
 * and sent none is the single most damaging sentence this product could put on a screen.
 */
export function digestMessage(digest: ActivityDigest): { title: string; body: string } | null {
  if (digest.empty) return null;
  const parts: string[] = [];
  if (digest.applied > 0) {
    const named = digest.applied_companies.slice(0, 2).join(' and ');
    parts.push(digest.applied === 1 && named
      ? `Applied to ${named}`
      : `Applied to ${digest.applied} role${digest.applied === 1 ? '' : 's'}${named ? `, including ${named}` : ''}`);
  }
  if (digest.employer_replies > 0) {
    parts.push(`${digest.employer_replies} employer ${digest.employer_replies === 1 ? 'reply' : 'replies'}`);
  }
  if (digest.needs_you > 0) {
    parts.push(`${digest.needs_you} need${digest.needs_you === 1 ? 's' : ''} your input`);
  }
  return {
    title: digest.applied > 0 ? 'Litos applied for you' : 'Your applications moved',
    body: parts.join('. ') + '.',
  };
}

/** One digest per account per window. The window is in the key so a re-run cannot re-announce it. */
export function activityDigestDedupeKey(userId: string, at: Date): string {
  return `activity_digest:${userId}:${at.toISOString().slice(0, 10)}`;
}
