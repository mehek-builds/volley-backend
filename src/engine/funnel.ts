/**
 * The student's own job-search funnel, built only from what Litos actually observes.
 *
 * The teardown found "a throughput number the user sees themselves" in every product with real
 * retention: Simplify's users quote going from 3-5 applications a day to 10-15, and that self-
 * evident progress is the reason they open it again. Litos had the data and showed none of it.
 *
 * WHAT THIS DELIBERATELY DOES NOT REPORT
 *
 * Interview rate, response rate, and offer rate. Jobright, AIApply and LoopCV all headline those
 * ("3x more interviews", "61% get an interview within 10 days"), and Litos cannot see any of them:
 * nothing tells us when a company replies. The only honest versions would be a number the student
 * types in, which is a different feature, or an inference from silence, which is a guess about
 * their life dressed as a measurement.
 *
 * It also does not report time saved. Every competitor multiplies applications by a made-up
 * minutes-per-application constant. We know how many FIELDS were filled, which is a real count, so
 * that is what it says.
 */

export interface FunnelWeek {
  /** ISO date of the Monday that starts the week. */
  week_start: string;
  submitted: number;
  tailored: number;
}

export interface FunnelSummary {
  resumes_tailored: number;
  applications_submitted: number;
  /** Real fields the extension filled, summed. Not converted into a time claim. */
  fields_filled: number;
  /** Submissions in the last 7 days, the number a student checks. */
  submitted_this_week: number;
  /** Oldest to newest. Empty when there is no history yet. */
  weeks: FunnelWeek[];
  /** True until there is enough history for a weekly shape to mean anything. */
  too_early: boolean;
}

/** Below this many submissions, a per-week chart is noise shaped like a trend. */
export const MIN_SUBMISSIONS_FOR_WEEKLY = 3;

/**
 * The Monday that starts the week containing `date`, IN THE STUDENT'S OWN TIMEZONE.
 *
 * Bucketing by UTC put a Los Angeles student's Sunday-evening applications into the following
 * week's bar, and a Dubai student's Monday-morning ones into the previous week's. Both are the
 * common case rather than an edge: applying in the evening and applying before work are when
 * students apply. The offset is minutes EAST of UTC (the inverse of Date#getTimezoneOffset), sent
 * by the client, defaulting to 0 so a caller that omits it gets the old UTC behaviour rather than
 * a wrong one.
 */
export function mondayOf(date: Date, offsetMinutes = 0): string {
  const local = new Date(date.getTime() + offsetMinutes * 60_000);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
  // getUTCDay: 0 is Sunday, so Sunday belongs to the week that started six days earlier.
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

export interface FunnelInput {
  /** created_at of every generated resume. */
  tailoredAt: Date[];
  /** submitted_at (or the review timestamp) of every submitted application. */
  submittedAt: Date[];
  fieldsFilled: number;
  /** Injected so the weekly buckets are testable and do not depend on the wall clock. */
  now: Date;
  weeks?: number;
  /** Minutes east of UTC, from the client. Weeks are the student's weeks, not the server's. */
  offsetMinutes?: number;
}

export function buildFunnel({
  tailoredAt,
  submittedAt,
  fieldsFilled,
  now,
  weeks = 8,
  offsetMinutes = 0,
}: FunnelInput): FunnelSummary {
  const buckets = new Map<string, FunnelWeek>();
  const cursor = new Date(now);
  for (let i = 0; i < weeks; i++) {
    const key = mondayOf(cursor, offsetMinutes);
    buckets.set(key, { week_start: key, submitted: 0, tailored: 0 });
    cursor.setUTCDate(cursor.getUTCDate() - 7);
  }

  // A timestamp in the future cannot be bucketed and would otherwise inflate the headline while
  // contributing nothing to the chart, so it is clamped to now and counted where it can be seen.
  const clamp = (at: Date) => (at > now ? now : at);

  for (const at of tailoredAt) {
    const bucket = buckets.get(mondayOf(clamp(at), offsetMinutes));
    if (bucket) bucket.tailored += 1;
  }
  for (const at of submittedAt) {
    const bucket = buckets.get(mondayOf(clamp(at), offsetMinutes));
    if (bucket) bucket.submitted += 1;
  }

  const windowStart = new Date(now);
  windowStart.setUTCDate(windowStart.getUTCDate() - weeks * 7);
  const inWindow = submittedAt.filter((at) => clamp(at) >= windowStart).length;

  const weekAgo = new Date(now);
  weekAgo.setUTCDate(weekAgo.getUTCDate() - 7);

  return {
    resumes_tailored: tailoredAt.length,
    applications_submitted: submittedAt.length,
    fields_filled: fieldsFilled,
    submitted_this_week: submittedAt.filter((at) => clamp(at) >= weekAgo).length,
    weeks: [...buckets.values()].sort((a, b) => a.week_start.localeCompare(b.week_start)),
    // Gated on submissions INSIDE the charted window, not on the all-time total. A returning
    // student with 40 applications in February and one in July was shown a confident chart of
    // empty bars under a headline of 41.
    too_early: inWindow < MIN_SUBMISSIONS_FOR_WEEKLY,
  };
}
