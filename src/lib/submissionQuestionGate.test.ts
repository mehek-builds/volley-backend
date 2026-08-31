import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewQuestion, ApplicationReviewState } from './applicationReview';
import { submissionQuestionGate } from './submissionSafety';

function question(overrides: Partial<ApplicationReviewQuestion>): ApplicationReviewQuestion {
  return {
    id: 'question-1',
    question: 'Would you like to add anything else?',
    answer: '',
    kind: 'essay',
    required: false,
    ...overrides,
  };
}

function review(
  questions: ApplicationReviewQuestion[],
  blockers: ApplicationReviewState['question_metadata_blockers'] = [],
): Pick<ApplicationReviewState, 'questions' | 'question_metadata_blockers'> {
  return { questions, question_metadata_blockers: blockers };
}

test('metadata blockers close the shared send gate even when every answer is complete', () => {
  const gate = submissionQuestionGate(review([
    question({ answer: 'Applicant answer' }),
  ], [{
    kind: 'missing_exact_options',
    required: false,
    portal_input_type: 'select-one',
    question: 'Choose one',
  }]));
  assert.equal(gate.clear, false);
  assert.equal(gate.metadataBlockerCount, 1);
  assert.deepEqual(gate.requiredQuestionLabels, []);
  assert.deepEqual(gate.optionalQuestionLabels, []);
});

test('optional unanswered and Litos-refused states require Answer or Skip', () => {
  const unanswered = question({ answer_state: 'unanswered' });
  const refusedWithStaleText = question({
    id: 'question-2',
    question: 'Share a portfolio note',
    answer: 'stale draft',
    answer_state: 'litos_refused',
  });
  const gate = submissionQuestionGate(review([unanswered, refusedWithStaleText]));
  assert.equal(gate.clear, false);
  assert.deepEqual(gate.optionalQuestionLabels, [
    unanswered.question,
    refusedWithStaleText.question,
  ]);
});

test('an explicit optional answer or Skip clears the optional decision gate', () => {
  const gate = submissionQuestionGate(review([
    question({ answer: 'Applicant answer', answer_state: undefined }),
    question({ id: 'question-2', question: 'Second optional', answer_state: 'skipped' }),
  ]));
  assert.equal(gate.clear, true);
  assert.deepEqual(gate.optionalQuestionLabels, []);
});

test('required blanks remain part of the same fail-closed decision', () => {
  const required = question({ required: true, kind: 'required' });
  const gate = submissionQuestionGate(review([required]));
  assert.equal(gate.clear, false);
  assert.deepEqual(gate.requiredQuestionLabels, [required.question]);
});
