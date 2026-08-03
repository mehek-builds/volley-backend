import type { ApplicationReviewState } from './applicationReview';
import type { CaptchaProvider, CaptchaStopStage } from './portalSubmission';

export type StallSurface = 'server_run' | 'extension';

export type StallInput = {
  surface: StallSurface;
  provider: CaptchaProvider;
  stage: CaptchaStopStage;
  /**
   * Whether the provider was SEEN on a live page or inferred from the portal family.
   *
   * Without this the two get averaged into one counter and the counter stops meaning anything.
   * The paths that stop before opening a browser can only infer, and inferring is fine, but an
   * inferred label must never be counted as evidence that a family really uses that provider -
   * that would be the metric confirming its own assumption.
   */
  source: 'observed' | 'assumed';
};

/**
 * Begin (or continue) a human-verification stall.
 *
 * `stalled_at` is the queue's sort key and survives re-observation: a re-poll that finds the same
 * challenge still waiting has not restarted the wait. Refreshing it would send the longest-waiting
 * application to the back of a queue ordered oldest-first on every re-poll, and the application
 * nobody has dealt with is precisely the one that keeps getting re-polled, so the worst case would
 * be the one thing never surfaced.
 *
 * A stall that was already RESOLVED starts a fresh clock. That is a genuinely new wait: the
 * applicant cleared the last one, the application moved on, and something stopped it again.
 */
export function beginStall(
  current: Pick<ApplicationReviewState, 'stall'>,
  input: StallInput,
  now: () => string = () => new Date().toISOString(),
): Pick<ApplicationReviewState, 'stall'> {
  const open = current.stall && !current.stall.resolved_at ? current.stall : null;
  return {
    stall: {
      kind: 'human_verification',
      stalled_at: open?.stalled_at ?? now(),
      surface: input.surface,
      provider: input.provider,
      stage: input.stage,
      source: input.source,
    },
  };
}

/**
 * Close a stall when the application stops waiting on a human. Does NOT delete it.
 *
 * An earlier version deleted the stall on any status other than 'needs_attention'. That was wrong
 * twice over, and the two mistakes hid each other:
 *
 *  1. It broke the clock it was supposed to protect. A re-run moves the row through 'preparing' and
 *     'submitting' before it can stall again, and those transitions deleted the stall, so
 *     `beginStall` never saw a previous `stalled_at` and minted a new one every cycle. The set-once
 *     rule was unreachable in production while its unit test passed on a hand-built object the
 *     pipeline could not produce.
 *  2. It threw away the measurement. Time-to-resolution is the number that decides whether a
 *     challenge is a two-second annoyance or the reason applications never get sent, and it can only
 *     be computed from a stall that outlives its own resolution.
 *
 * Deleting was never necessary anyway: the queue selects on status, so a resolved stall on a
 * submitted application is invisible to it regardless. Keeping the record is strictly more useful
 * and strictly less fragile.
 */
export function settleStall(review: ApplicationReviewState, now: () => string = () => new Date().toISOString()): ApplicationReviewState {
  if (!review.stall || review.stall.resolved_at) return review;
  if (review.status === 'needs_attention') return review;
  return { ...review, stall: { ...review.stall, resolved_at: now() } };
}

/**
 * The queue predicate. Status is the authority on whether the applicant still owes an action;
 * the stall only says the reason is a human-verification check.
 *
 * Both halves are required. Status alone would sweep in every other reason an application needs
 * attention (a missing field, an unanswered attestation), and a stall alone would resurrect
 * finished work.
 */
export function isWaitingOnHuman(review: Pick<ApplicationReviewState, 'status' | 'stall'>): boolean {
  return review.status === 'needs_attention' && !!review.stall && !review.stall.resolved_at;
}

/**
 * Oldest first. The queue's whole promise is that the longest wait is at the top.
 *
 * Rows with no stall sort LAST, not first. Comparison is a plain string compare on fixed-width
 * ISO-8601 UTC, which is the same convention the submission cap relies on: lexicographic order and
 * chronological order coincide, and unlike localeCompare it cannot shift under a different ICU
 * collation.
 */
export function orderByStalledAt<T extends { stall?: { stalled_at: string } }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => {
    const a = left.stall?.stalled_at;
    const b = right.stall?.stalled_at;
    if (a === b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    return a < b ? -1 : 1;
  });
}

/**
 * The one place a review patch is merged.
 *
 * Every writer goes through here, including the ones in routes/applications.ts that predate stalls
 * and know nothing about them. That is the point: a rule enforced at a dozen call sites is a rule
 * that holds until someone adds the thirteenth.
 */
export function applyReviewPatch(
  current: ApplicationReviewState,
  patch: Partial<ApplicationReviewState>,
  now: () => string = () => new Date().toISOString(),
): ApplicationReviewState {
  return settleStall({ ...current, ...patch, updated_at: now() }, now);
}
