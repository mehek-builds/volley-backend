import type { ApplicationReviewState } from './applicationReview';
import type { CaptchaProvider, CaptchaStopStage } from './portalSubmission';

export type StallSurface = 'server_run' | 'extension';

export type StallInput = {
  surface: StallSurface;
  provider: CaptchaProvider;
  stage: CaptchaStopStage;
};

/**
 * Begin (or continue) a human-verification stall.
 *
 * `stalled_at` is set ONCE. If the application is already stalled the original timestamp survives,
 * because a re-poll that finds the same challenge still waiting has not restarted the wait.
 * Refreshing it would quietly send that row to the back of a queue ordered oldest-first, which is
 * the single thing that queue exists to prevent: the application nobody has dealt with is exactly
 * the one that keeps getting re-polled, so a naive refresh would bury the worst case forever.
 *
 * Everything else IS refreshed. A stall that started before the fill and is re-observed at submit
 * has genuinely changed stage, and the applicant is owed the sentence that matches.
 */
export function beginStall(
  current: Pick<ApplicationReviewState, 'stall'>,
  input: StallInput,
  now: () => string = () => new Date().toISOString(),
): Pick<ApplicationReviewState, 'stall'> {
  return {
    stall: {
      kind: 'human_verification',
      stalled_at: current.stall?.stalled_at ?? now(),
      surface: input.surface,
      provider: input.provider,
      stage: input.stage,
    },
  };
}

/**
 * The invariant: a stall exists only while the application is waiting on a human.
 *
 * Enforced as a function every write passes through rather than as a rule each of a dozen write
 * sites has to remember. The failure it prevents is silent and user-visible: an application that
 * stalled on a challenge, then got submitted on a later run, would keep its stall record and show
 * up forever in a "waiting on you" queue for work that is already done. Someone would open it,
 * find nothing to do, and trust the queue less every time.
 */
export function withStallInvariant(review: ApplicationReviewState): ApplicationReviewState {
  if (review.status === 'needs_attention' || !review.stall) return review;
  const { stall: _dropped, ...rest } = review;
  return rest;
}

/** Oldest first. The queue's whole promise is that the longest-waiting application is at the top. */
export function orderByStalledAt<T extends { stall?: { stalled_at: string } }>(rows: T[]): T[] {
  return [...rows].sort((left, right) => (
    (left.stall?.stalled_at ?? '').localeCompare(right.stall?.stalled_at ?? '')
  ));
}
