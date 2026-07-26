import assert from 'node:assert/strict';
import test from 'node:test';
import {
  directPreparationIsSafe,
  preparationClaimOwnsReview,
  stalePreSubmitLease,
  submitRequestDisposition,
} from './submissionSafety';

test('a submitted or active application cannot begin another submission run', () => {
  assert.equal(submitRequestDisposition('submitted'), 'submitted');
  assert.equal(submitRequestDisposition('submit_requested'), 'in_flight');
  assert.equal(submitRequestDisposition('preparing'), 'in_flight');
  assert.equal(submitRequestDisposition('submitting'), 'in_flight');
});

test('pre-submit attention can retry, but a post-click uncertainty cannot risk a duplicate application', () => {
  assert.equal(submitRequestDisposition('ready_to_submit'), 'start');
  assert.equal(submitRequestDisposition('failed'), 'start');
  assert.equal(submitRequestDisposition('needs_attention', false), 'start');
  assert.equal(submitRequestDisposition('needs_attention', true), 'reject');
  assert.equal(submitRequestDisposition('ready_for_final_approval'), 'reject');
});

test('verification handoff prevents automatic submission even without native required markup', () => {
  assert.equal(directPreparationIsSafe({ blockerCount: 0, attentionCount: 0, verificationStatus: 'handoff' }), false);
  assert.equal(directPreparationIsSafe({ blockerCount: 0, attentionCount: 0, verificationStatus: 'completed' }), true);
});

test('only stale pre-submit work may be reclaimed', () => {
  const now = Date.parse('2026-07-26T12:10:00.000Z');
  assert.equal(stalePreSubmitLease('preparing', '2026-07-26T12:00:00.000Z', now), true);
  assert.equal(stalePreSubmitLease('filling', '2026-07-26T12:09:00.000Z', now), false);
  assert.equal(stalePreSubmitLease('submitting', '2026-07-26T12:00:00.000Z', now), false);
});

test('an expired preparation worker cannot write after another worker reclaims the row', () => {
  const workerA = 'claim-a';
  const workerB = 'claim-b';
  let state = { claimId: workerA, status: 'preparing' };
  state = { claimId: workerB, status: 'preparing' };
  if (preparationClaimOwnsReview(state.claimId, workerA)) state.status = 'filling';
  assert.deepEqual(state, { claimId: workerB, status: 'preparing' });
  assert.equal(preparationClaimOwnsReview(state.claimId, workerB), true);
});

test('an expired preparation worker cannot write a failure after another worker reclaims the row', () => {
  const state = { claimId: 'claim-b', status: 'filling' };
  const afterWorkerAThrows = preparationClaimOwnsReview(state.claimId, 'claim-a')
    ? { claimId: 'claim-a', status: 'failed' }
    : state;
  assert.deepEqual(afterWorkerAThrows, { claimId: 'claim-b', status: 'filling' });
});
