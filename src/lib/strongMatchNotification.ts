import { and, desc, eq, gte, inArray, notInArray, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { career_page_sources, monitored_jobs, notification_sends, users } from '../db/schema';
import { decide, isBlocked } from '../engine/eligibility';
import { companyDomainFor } from './companyDomains';
import { hasTargeting, recommendationTargetingEligible } from './jobPreferences';
import {
  accountJobTargeting,
  accountRequiresSponsor,
  boardConditions,
  MIN_RANKED_MATCH_SCORE,
  PER_COMPANY_CAP,
  pickDiversePool,
  rankByFit,
  rankedMatchEligible,
  RANKING_POOL,
  SCORING_CHARS,
  studentGradDate,
  studentResumeFacts,
} from '../routes/jobMonitor';

/* "TELL ME WHEN A STRONG MATCH OPENS", and the one decision that makes it honest.
 *
 * STRONG MEANS WHAT THE BOARD ALREADY MEANS BY IT. Every filter, gate and score below is imported
 * from routes/jobMonitor.ts rather than restated here, and the imports are the design: a second
 * definition of a good match is a second product, and the two would drift within a release. The
 * failure that produces is specific and bad. A student is emailed "94% match", clicks through, and
 * the board she lands on either does not show that posting at all (it was filtered) or shows it at
 * a different number. At that point the score is not a measurement, it is copy, and every other
 * number Litos prints is worth less.
 *
 * So the chain is exactly the /jobs chain, in the same order:
 *   boardConditions             live, enabled source, autonomous portal family, freshness,
 *                               sponsorship, the account's saved locations and role types
 *   pickDiversePool             one employer cannot own the candidate pool
 *   rankByFit                   the same scorer, against the same resume text
 *   rankedMatchEligible         the same floor, MIN_RANKED_MATCH_SCORE
 *   recommendationTargetingEligible + the graduation gate
 *
 * ONE THING IS ADDED AND ONE IS REMOVED, and both are properties of it being an alert rather than
 * a list. Added: a first_seen_at window, because "opens" is the whole request and a posting from
 * three weeks ago did not open. Removed: relax_targeting, which exists so the match SCREEN can
 * widen past a student's preferences when their own filters return nothing. An empty screen is a
 * dead end that has to be rescued; an empty inbox is the correct outcome of a quiet day, and
 * widening into it would send somebody a posting they told us they did not want.
 *
 * THE RANKING CACHE IS DELIBERATELY NOT USED. rankingCacheKey is keyed on the board's filters and
 * shared between accounts; this pass adds a freshness window that is not in that key, so reading
 * from it would serve a whole-board ordering against a windowed query. Writing to it would be
 * worse: a cron would poison every signed-in student's first page. This runs once a day per
 * subscribed account, so there is nothing to amortise anyway.
 */

/**
 * How far back a run looks for postings it has not announced.
 *
 * The cron is daily, so 24 hours is the honest window and this is 26. The two hours of overlap are
 * not slack, they are what makes a LATE run correct: Vercel does not promise a cron fires at the
 * minute, and a run that starts 40 minutes behind yesterday's would leave a 40 minute band of
 * postings that no run ever considers. Overlap costs nothing, because notification_sends.dedupe_key
 * makes announcing the same posting twice impossible.
 */
export const MATCH_LOOKBACK_HOURS = 26;

export function matchLookbackSince(now: Date): Date {
  return new Date(now.getTime() - MATCH_LOOKBACK_HOURS * 60 * 60 * 1000);
}

/**
 * THE 3-HOUR HARD BARRIER, and the second, higher bar it is written against.
 *
 * MIN_RANKED_MATCH_SCORE (25, in routes/jobMonitor.ts) is the floor for "worth telling somebody
 * about at all" - the ordinary strong-match alert. Mehek's instruction (2026-08-20) is narrower and
 * absolute: a fit THIS strong must reach the student's inbox within STRONG_FIT_SLA_HOURS of
 * monitored_jobs.first_seen_at, the moment Litos found it, never the employer's publish date - see
 * the "Found, never Posted" note in notificationEmail.ts for why that is the only fact Litos can
 * vouch for. 70 is not a new number invented for this: it is the same bar notificationEmail.ts
 * already draws between a score worth printing and one that undercuts its own claim, kept here as
 * its own named constant rather than imported, because eligibility and display are different
 * questions that happen to agree today and must not be forced to agree tomorrow.
 *
 * THE BARRIER IS ENFORCED BY BEING LOUD, NOT BY BEING UNBREAKABLE. Nothing in this file can force a
 * cron to fire on time; what it can do is refuse to stay quiet when one didn't. See
 * routes/notifications.ts, which answers 500 on any breach the same way jobMonitor.ts answers 500
 * on a surfaced-jobs floor breach - a cron that always returns 200 is a cron nobody reads.
 */
export const VERY_STRONG_FIT_SCORE = 70;
export const STRONG_FIT_SLA_HOURS = 3;

export function hoursSinceFound(firstSeenAt: Date, now: Date): number {
  return (now.getTime() - firstSeenAt.getTime()) / (60 * 60 * 1000);
}

/** Whether THIS SEND, happening now, is itself the SLA breach - a very strong fit that sat past its
 *  window before this sweep finally reached it. A weak match sent late is not a breach: the barrier
 *  is a promise about strong fits, not about every posting on the board. */
export function breachesStrongFitSla(
  candidate: Pick<StrongMatchCandidate, 'score' | 'first_seen_at'>,
  now: Date,
): boolean {
  return candidate.score >= VERY_STRONG_FIT_SCORE && hoursSinceFound(candidate.first_seen_at, now) > STRONG_FIT_SLA_HOURS;
}

export type StrongMatchCandidate = {
  id: string;
  company_name: string;
  title: string;
  location: string | null;
  first_seen_at: Date;
  posting_url: string;
  score: number;
  /** Resolved the same way the board resolves it, so the email's logo and the board's logo can
   *  never disagree about a company. See lib/companyDomains.ts. */
  company_domain: string | null;
};

/**
 * Who is subscribed AND reachable, which are two different questions.
 *
 * A guest has no email at all, and an unverified address is one nobody has proved they can read.
 * Mailing either is how a sending domain acquires a bounce rate, and a bounce rate is charged to
 * every student's application mail, not just to the alerts. The toggle is necessary and it is not
 * sufficient.
 */
export async function subscribedMatchAccounts(limit: number): Promise<Array<{ id: string; email: string }>> {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(
      eq(users.notify_strong_match_enabled, true),
      eq(users.is_guest, false),
      eq(users.email_verified, true),
      sql`${users.email} is not null`,
    ))
    /* LONGEST WAITING FIRST, and this ordering is the whole reason the sweep's account budget is
       survivable rather than a quiet injustice. Ordering by anything fixed - id, creation date -
       means the accounts past the budget are the SAME accounts on every run, so a deployment that
       outgrows the limit does not degrade for everybody, it silently stops mailing one stable
       group forever. Ordering by when each account was last mailed makes the set rotate on its
       own: whoever was skipped yesterday has an older timestamp today and leads the queue.
       Nulls first, so an account that has never had an alert outranks every account that has. */
    .orderBy(sql`(
      select max(${notification_sends.created_at})
      from ${notification_sends}
      where ${notification_sends.user_id} = ${users.id}
        and ${notification_sends.kind} = 'strong_match'
    ) asc nulls first`, users.id)
    .limit(limit);
  return rows.filter((row): row is { id: string; email: string } => typeof row.email === 'string' && row.email.length > 0);
}

/**
 * The single best posting to tell this student about, or null.
 *
 * NULL IS A COMMON AND CORRECT ANSWER, and the run reports it as a quiet day rather than as a
 * problem. Internship supply is the board's thinnest tier, most accounts will have no new posting
 * above the floor on most days, and the feature that fills the silence anyway is a digest.
 *
 * NO RESUME MEANS NO ALERT. rankByFit returns null for every row without one, `rankedMatchEligible`
 * is written to pass a null score through when the caller has no resume (the board still has to
 * render), and this deliberately does not take that branch: an unranked posting is not a strong
 * match, it is an unjudged one, and the email would be claiming a fit that was never computed.
 */
export async function strongMatchForAccount(
  userId: string,
  now: Date,
): Promise<StrongMatchCandidate | null> {
  const [sponsorOnly, jobTargeting, resumeFacts, gradDate] = await Promise.all([
    accountRequiresSponsor(userId),
    accountJobTargeting(userId),
    studentResumeFacts(userId),
    studentGradDate(userId),
  ]);
  const resumeText = resumeFacts.resumeText?.trim();
  if (!resumeText) return null;

  const since = matchLookbackSince(now);
  const conditions = [
    ...boardConditions({ sponsorOnly, targeting: jobTargeting }),
    /* first_seen_at, never posted_at. posted_at is nullable on a large share of the board, so a
       window over it would silently exclude every Greenhouse posting; and it is the employer's
       claim, while first_seen_at is ours. The email says "Found" for the same reason. */
    gte(monitored_jobs.first_seen_at, since),
  ];

  /* Never announce the same posting twice, checked before the pool is chosen rather than after.
     The ledger's unique index would refuse the duplicate anyway, but refusing it there ends the
     run with nothing sent; excluding it here lets the next best posting take the slot. */
  const announced = db
    .select({ id: notification_sends.monitored_job_id })
    .from(notification_sends)
    .where(and(eq(notification_sends.user_id, userId), sql`${notification_sends.monitored_job_id} is not null`));

  const candidates = await db
    .select({ id: monitored_jobs.id, company_name: monitored_jobs.company_name })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(and(...conditions, notInArray(monitored_jobs.id, announced)))
    .orderBy(desc(monitored_jobs.first_seen_at), desc(monitored_jobs.id))
    .limit(RANKING_POOL * 4);
  if (candidates.length === 0) return null;

  const poolIds = pickDiversePool(candidates, PER_COMPANY_CAP, RANKING_POOL)
    .slice(0, RANKING_POOL)
    .map((row) => row.id);
  if (poolIds.length === 0) return null;

  const pool = await db
    .select({
      id: monitored_jobs.id,
      company_name: monitored_jobs.company_name,
      title: monitored_jobs.title,
      location: monitored_jobs.location,
      employment_type: monitored_jobs.employment_type,
      remote: monitored_jobs.remote,
      first_seen_at: monitored_jobs.first_seen_at,
      posting_url: monitored_jobs.posting_url,
      /* The same coalesce the board uses: the digest built at poll time, falling back to a capped
         prefix for rows polled before that column existed. */
      scored_description: sql<string>`coalesce(nullif(${monitored_jobs.description_digest}, ''), left(${monitored_jobs.description}, ${SCORING_CHARS}))`,
    })
    .from(monitored_jobs)
    .where(inArray(monitored_jobs.id, poolIds));

  const poolById = new Map(pool.map((row) => [row.id, row]));
  const ordered = poolIds
    .map((id) => poolById.get(id))
    .filter((row): row is (typeof pool)[number] => row !== undefined);

  const ranked = rankByFit(ordered, resumeText, jobTargeting);
  for (const { row, score } of ranked) {
    /* `true` for hasResumeScore is not a shortcut: this function returned null above when there is
       no resume, so the caller-has-no-resume branch of rankedMatchEligible is unreachable here and
       passing anything else would let an unscored posting through as a strong match. */
    if (!rankedMatchEligible(score, true)) continue;
    if (score === null) continue;
    if (hasTargeting(jobTargeting) || resumeFacts.degree) {
      if (!recommendationTargetingEligible(row, jobTargeting, resumeFacts.degree)) continue;
    }
    if (gradDate && isBlocked(decide({ title: row.title, employment_type: row.employment_type }, gradDate))) continue;
    return {
      id: row.id,
      company_name: row.company_name,
      title: row.title,
      location: row.location,
      first_seen_at: row.first_seen_at,
      posting_url: row.posting_url,
      score,
      company_domain: companyDomainFor(row.company_name),
    };
  }
  return null;
}

/** The dedupe key for one posting announced to one student. Prefixed so no two kinds can collide
 *  on a shared uuid. */
export function strongMatchDedupeKey(userId: string, jobId: string): string {
  return `strong_match:${userId}:${jobId}`;
}

export { MIN_RANKED_MATCH_SCORE };
