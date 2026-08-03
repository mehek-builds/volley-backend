import type { ApplicationReviewState } from './applicationReview';

/**
 * The measurement the whole stall feature was built to make possible.
 *
 * The question that has been open since this started is: is a human-verification check a two-second
 * annoyance, or is it the reason applications never get sent? Nothing could answer it, because the
 * only record was a prose sentence written for a person. That is what the typed stall exists for,
 * and this is where it gets read.
 *
 * Every function here is pure and takes its rows, so the numbers can be tested without a database
 * and without waiting for real stalls to accumulate.
 */

export type StallRecord = NonNullable<ApplicationReviewState['stall']>;

export type StallRow = {
  atsName?: string;
  stall: StallRecord;
};

export type StallSummary = {
  /** Applications that hit a challenge at all. */
  stalled: number;
  /** Of those, how many the applicant got past. */
  resolved: number;
  /** Still waiting. The number that decides whether this is an annoyance or a ceiling. */
  open: number;
  /**
   * Median seconds from stall to resolution, over resolved stalls only.
   *
   * Median, not mean: one application someone came back to a week later would drag an average into
   * meaninglessness, and the useful question is what the ordinary case costs.
   */
  medianSecondsToResolve: number | null;
  byProvider: Record<string, number>;
  byAts: Record<string, number>;
  bySurface: Record<string, number>;
  /**
   * Counted separately from byProvider, because an inferred provider is not evidence.
   *
   * A stall whose provider came from the portal family rather than a live page would otherwise let
   * the metric confirm its own assumption about which families use which vendor.
   */
  observedProviders: number;
  assumedProviders: number;
};

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/** Seconds from stall to resolution, or null when it is still open or the timestamps are unusable. */
export function secondsToResolve(stall: StallRecord): number | null {
  if (!stall.resolved_at) return null;
  const started = Date.parse(stall.stalled_at);
  const ended = Date.parse(stall.resolved_at);
  if (Number.isNaN(started) || Number.isNaN(ended)) return null;
  // A negative duration means the clocks disagreed, not that it resolved before it began. Dropping
  // it keeps one bad row out of the median rather than letting it distort the answer.
  return ended < started ? null : Math.round((ended - started) / 1000);
}

function tally(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

export function summarizeStalls(rows: readonly StallRow[]): StallSummary {
  const summary: StallSummary = {
    stalled: rows.length,
    resolved: 0,
    open: 0,
    medianSecondsToResolve: null,
    byProvider: {},
    byAts: {},
    bySurface: {},
    observedProviders: 0,
    assumedProviders: 0,
  };
  const durations: number[] = [];

  for (const row of rows) {
    if (row.stall.resolved_at) summary.resolved += 1;
    else summary.open += 1;
    tally(summary.byProvider, row.stall.provider);
    tally(summary.byAts, row.atsName ?? 'unknown');
    tally(summary.bySurface, row.stall.surface);
    if (row.stall.source === 'observed') summary.observedProviders += 1;
    else summary.assumedProviders += 1;
    const seconds = secondsToResolve(row.stall);
    if (seconds !== null) durations.push(seconds);
  }

  summary.medianSecondsToResolve = median(durations);
  return summary;
}

/**
 * The share of applications a challenge stopped.
 *
 * Returned as a fraction with its denominator alongside, never as a bare percentage: "8%" off six
 * applications and "8%" off six hundred are different facts, and a number that hides which one it
 * is invites a decision the data cannot support.
 */
export function stallRate(stalled: number, totalApplications: number): { rate: number | null; of: number } {
  if (totalApplications <= 0) return { rate: null, of: 0 };
  return { rate: stalled / totalApplications, of: totalApplications };
}

/**
 * Stalls old enough to be worth an email.
 *
 * Only OPEN ones, and only past the threshold. The point is to catch the application someone has
 * genuinely forgotten, not to chase someone who stepped away for ten minutes - a nudge that arrives
 * while they are still looking at the page teaches them to ignore the next one.
 */
export function nudgeableStalls<T extends { stall: StallRecord }>(
  rows: readonly T[],
  now: number,
  olderThanMs: number,
): T[] {
  return rows.filter((row) => {
    if (row.stall.resolved_at) return false;
    const started = Date.parse(row.stall.stalled_at);
    if (Number.isNaN(started)) return false;
    return now - started >= olderThanMs;
  });
}
