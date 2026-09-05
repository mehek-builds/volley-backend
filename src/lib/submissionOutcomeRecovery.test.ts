import assert from 'node:assert/strict';
import test from 'node:test';
import { claimOutcomeRecovery, finishOutcomeRecovery, outcomeRecoveryDue } from './submissionOutcomeRecovery';
import type { ApplicationReviewState } from './applicationReview';
const now = Date.parse('2026-09-05T10:00:00.000Z');
const review = (over: Partial<ApplicationReviewState> = {}): ApplicationReviewState => ({
  status: 'needs_attention', jd_text: '', questions: [], submission_claim_id: 'attempt', submission_run_id: 'run',
  unverified_submission: { at: new Date(now).toISOString(), cause: 'no_confirmation_state' }, ...over,
} as ApplicationReviewState);

test('only a held unknown attempt can enter automatic recovery', () => {
  assert.equal(outcomeRecoveryDue(review(), now), true);
  for (const over of [{ status: 'submitting' }, { status: 'submitted' }, { submission_claim_id: undefined },
    { receipt: {} }, { unverified_submission: undefined },
    { unverified_submission: { at: new Date(now).toISOString(), cause: 'no_confirmation_state', resolution: 'not_sent' } }]) {
    assert.equal(outcomeRecoveryDue(review(over as Partial<ApplicationReviewState>), now), false);
  }
});
test('leases survive a crash, retries back off, and three completed checks stop polling', () => {
  let state = review();
  let time = now;
  for (let check = 1; check <= 3; check++) {
    assert.equal(outcomeRecoveryDue(state, time), true);
    const claim = claimOutcomeRecovery(state, time);
    assert.equal(claim.checks, check);
    assert.equal(outcomeRecoveryDue(review({ outcome_recovery: claim }), time), false);
    assert.equal(outcomeRecoveryDue(review({ outcome_recovery: claim }), time + 300_000), true);
    const finished = finishOutcomeRecovery(claim, time);
    state = review({ outcome_recovery: finished });
    time = Date.parse(finished.next_check_at);
  }
  assert.equal(outcomeRecoveryDue(state, time + 86_400_000), false);
});
test('an old attempt lease cannot suppress recovery of another attempt', () => {
  const previous = finishOutcomeRecovery({ ...claimOutcomeRecovery(review(), now), checks: 3 }, now);
  assert.equal(outcomeRecoveryDue(review({ submission_claim_id: 'different', outcome_recovery: previous }), now), true);
});

test('terminal evidence remains available during recovery and is released at a finite deadline', async () => {
  const { retainOutcomeEvidence } = await import('./submissionOutcomeRecovery');
  const pending = review({ submission_claimed_at: new Date(now).toISOString() });
  assert.equal(retainOutcomeEvidence(pending, now + 60_000), true);
  assert.equal(retainOutcomeEvidence(pending, now + 2 * 60 * 60_000), false);
  assert.equal(retainOutcomeEvidence(review(), now), false, 'missing timestamps cannot retain forever');
  assert.equal(retainOutcomeEvidence({ ...pending, status: 'submitted' }, now), false);
  assert.equal(retainOutcomeEvidence({ ...pending, outcome_recovery: {
    attempt_id: 'attempt', state: 'unresolved', checks: 3, next_check_at: new Date(now).toISOString(),
  } }, now), false);
});
