import assert from 'node:assert/strict';
import test from 'node:test';
import {
  blankRequiredQuestionLabels,
  directPreparationIsSafe,
  preparedRunCanRestart,
  resumeEditDisposition,
  submitRequestDisposition,
} from './submissionSafety';
import type { ApplicationReviewQuestion } from './applicationReview';

const question = (over: Partial<ApplicationReviewQuestion>): ApplicationReviewQuestion => ({
  id: 'q',
  question: 'Discipline',
  answer: '',
  kind: 'required',
  required: true,
  ...over,
});

test('a submitted or active application cannot begin another submission run', () => {
  assert.equal(submitRequestDisposition('submitted'), 'submitted');
  assert.equal(submitRequestDisposition('submit_requested', true), 'in_flight');
  assert.equal(submitRequestDisposition('preparing'), 'in_flight');
  assert.equal(submitRequestDisposition('submitting'), 'in_flight');
});

test('pre-submit attention can retry, but a post-click uncertainty cannot risk a duplicate application', () => {
  assert.equal(submitRequestDisposition('submit_requested', false), 'start');
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

test('an unanswered required question stops the direct send without stopping the run', () => {
  // The run has already happened by the time this is consulted. What it withholds is the CLICK.
  assert.equal(directPreparationIsSafe({
    blockerCount: 0,
    attentionCount: 0,
    unansweredRequiredCount: 1,
    verificationStatus: 'completed',
  }), false);
  assert.equal(directPreparationIsSafe({
    blockerCount: 0,
    attentionCount: 0,
    unansweredRequiredCount: 0,
    verificationStatus: 'completed',
  }), true);
  // Defaulted, so an existing caller that does not pass a count keeps its previous meaning.
  assert.equal(directPreparationIsSafe({ blockerCount: 0, attentionCount: 0, verificationStatus: 'completed' }), true);
});

test('only a required question with no answer counts as blank', () => {
  assert.deepEqual(blankRequiredQuestionLabels([
    question({ question: 'Discipline', answer: '' }),
    // Whitespace is not an answer.
    question({ question: 'Personal pronouns', answer: '   ' }),
    question({ question: 'Overall GPA', answer: '3.89' }),
    // Optional and blank is fine: the employer will accept the form without it.
    question({ question: 'LinkedIn', answer: '', required: false }),
  ]), ['Discipline', 'Personal pronouns']);
  assert.deepEqual(blankRequiredQuestionLabels([]), []);
  assert.deepEqual(blankRequiredQuestionLabels(undefined), []);
});

test('a filled but unsent packet can be re-run, a claimed one never can', () => {
  /* The trap this closes: a packet frozen at ready_for_final_approval against an old build, with
     R-066 forbidding a delete and the only escape being a full resume edit that changes nothing
     about the resume. Claimed is the line, because a claim means the employer may already hold it. */
  assert.equal(preparedRunCanRestart('ready_for_final_approval'), true);
  assert.equal(preparedRunCanRestart('ready_for_final_approval', true), false);
  assert.equal(preparedRunCanRestart('submitted'), false);
  assert.equal(preparedRunCanRestart('submitting'), false);
  // States that can already start a run have no need of a restart flag and must not imply one.
  assert.equal(preparedRunCanRestart('ready_to_submit'), false);
  assert.equal(preparedRunCanRestart('needs_attention'), false);
});
