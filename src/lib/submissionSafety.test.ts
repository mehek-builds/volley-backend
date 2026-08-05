import assert from 'node:assert/strict';
import test from 'node:test';
import { directPreparationIsSafe, resumeEditDisposition, submitRequestDisposition } from './submissionSafety';

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

test('a not-yet-sent final approval packet can reopen resume editing', () => {
  assert.equal(resumeEditDisposition('ready_to_submit'), 'start');
  assert.equal(resumeEditDisposition('ready_for_final_approval'), 'start');
  assert.equal(resumeEditDisposition('ready_for_final_approval', true), 'reject');
  assert.equal(resumeEditDisposition('submitted'), 'reject');
  assert.equal(resumeEditDisposition('submitting'), 'reject');
});

test('verification handoff prevents automatic submission even without native required markup', () => {
  assert.equal(directPreparationIsSafe({ blockerCount: 0, attentionCount: 0, verificationStatus: 'handoff' }), false);
  assert.equal(directPreparationIsSafe({ blockerCount: 0, attentionCount: 0, verificationStatus: 'completed' }), true);
});
