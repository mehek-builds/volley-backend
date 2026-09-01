/* IS THE BOARD STILL BEING FED?
 *
 * Split out of the route so the one decision that matters here can be tested without a database.
 * The route's job is to read max(last_seen_at); this decides what that reading MEANS, and the
 * interesting cases are the ones with no reading at all.
 */

export type IngestionHealth = {
  stalled: boolean;
  newest_seen_at: string | null;
  staleness_ms: number | null;
  staleness_minutes: number | null;
  threshold_ms: number;
};

/**
 * Whether ingestion has gone quiet for longer than the board can explain.
 *
 * FAILS CLOSED, and every branch that can fail does. A board with no postings at all, or a
 * timestamp that will not parse, or a clock that has somehow run backwards, all read as STALLED
 * rather than healthy. The failure this exists to catch was silent for seven and a half hours
 * precisely because every signal defaulted to "fine" in the absence of evidence; an alarm that
 * treats missing evidence as good news is the same bug wearing a different hat.
 *
 * A FUTURE TIMESTAMP IS NOT FRESHNESS. Clock skew between the database and this process can put
 * max(last_seen_at) slightly ahead of now. That is clamped to zero rather than read as negative
 * staleness, so skew can never manufacture a healthy answer - but it is also not treated as an
 * error, because a few seconds of skew is ordinary and is not what this alarm is for.
 */
export function ingestionHealth(
  newestSeenAt: Date | string | null | undefined,
  thresholdMs: number,
  now: Date = new Date(),
): IngestionHealth {
  const threshold = Number.isFinite(thresholdMs) && thresholdMs > 0 ? thresholdMs : 0;
  const parsed = newestSeenAt === null || newestSeenAt === undefined
    ? null
    : new Date(newestSeenAt);
  const seenMs = parsed && Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
  if (seenMs === null) {
    return {
      stalled: true,
      newest_seen_at: null,
      staleness_ms: null,
      staleness_minutes: null,
      threshold_ms: threshold,
    };
  }
  const stalenessMs = Math.max(0, now.getTime() - seenMs);
  return {
    stalled: stalenessMs > threshold,
    newest_seen_at: new Date(seenMs).toISOString(),
    staleness_ms: stalenessMs,
    staleness_minutes: Math.floor(stalenessMs / 60_000),
    threshold_ms: threshold,
  };
}
