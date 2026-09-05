import type { ApplicationReviewState } from './applicationReview';

export type SubmissionOutcomeRecovery = {
  attempt_id: string;
  state: 'pending' | 'checking' | 'unresolved';
  checks: number;
  next_check_at: string;
};

/** A finite recovery queue, separate from authorization to submit. Email receipts can still heal later. */
export function outcomeRecoveryDue(review: ApplicationReviewState, now = Date.now()): boolean {
  if (review.status !== 'needs_attention' || !review.unverified_submission
    || review.unverified_submission.resolution || review.receipt || review.submitted_at
    || !review.submission_claim_id || !review.submission_run_id) return false;
  const recovery = review.outcome_recovery;
  if (!recovery || recovery.attempt_id !== review.submission_claim_id) return true;
  return recovery.state !== 'unresolved' && Number.isFinite(Date.parse(recovery.next_check_at))
    && Date.parse(recovery.next_check_at) <= now;
}

export function claimOutcomeRecovery(review: ApplicationReviewState, now = Date.now()): SubmissionOutcomeRecovery {
  const previous = review.outcome_recovery?.attempt_id === review.submission_claim_id ? review.outcome_recovery : undefined;
  return {
    attempt_id: review.submission_claim_id!,
    state: 'checking',
    checks: Math.min((previous?.checks ?? 0) + 1, 3),
    // A worker crash must expire its lease instead of parking the application forever.
    next_check_at: new Date(now + 5 * 60_000).toISOString(),
  };
}

export function finishOutcomeRecovery(claim: SubmissionOutcomeRecovery, now = Date.now()): SubmissionOutcomeRecovery {
  return {
    ...claim,
    state: claim.checks >= 3 ? 'unresolved' : 'pending',
    next_check_at: new Date(now + (claim.checks === 1 ? 60_000 : 15 * 60_000)).toISOString(),
  };
}

/** Keep exact result artifacts while recovery can still use them, never beyond two hours. */
export function retainOutcomeEvidence(review: ApplicationReviewState | null, now = Date.now()): boolean {
  if (!review || review.status !== 'needs_attention' || !review.unverified_submission
    || review.unverified_submission.resolution || !review.submission_claim_id || review.receipt || review.submitted_at) return false;
  if (review.outcome_recovery?.attempt_id === review.submission_claim_id && review.outcome_recovery.state === 'unresolved') return false;
  const started = Date.parse(review.submission_claimed_at ?? '');
  return Number.isFinite(started) && started <= now && now - started < 2 * 60 * 60_000;
}
