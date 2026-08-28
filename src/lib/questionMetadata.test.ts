import assert from 'node:assert/strict';
import test from 'node:test';
import {
  reopenUnfitClosedChoiceQuestions,
  storedAnswerMatchesNoExactOption,
} from './questionMetadata';
import { blankRequiredQuestionLabels } from './submissionSafety';
import type { ApplicationReviewQuestion } from './applicationReview';

/* THE PRODUCTION SHAPE, byte for byte. Measured live on the Mytos Lever packet (application
 * 55de7c9e-13c0-44fd-8f78-0dee280dbd33, 2026-08-28): a required degree-classification select with
 * nine exact discovered options and a reviewed free-text answer that matches none of them. The
 * runner correctly refused the final press ("1 required field confirmation failed"), and the
 * dashboard never re-asked - the pending-question flow only surfaces unanswered questions, so the
 * row sat permanently between an unfillable answer and an unaskable question. */
const MYTOS_OPTIONS = [
  'First-Class Honours',
  'Upper Second-Class Honours (2:1)',
  'Lower Second-Class Honours (2:2)',
  'Third-Class Honours',
  'GPA <3.0',
  'GPA 3.0-3.4',
  'GPA 3.5-3.8',
  'GPA 3.9+',
  'Other',
];

const REVIEWED_AT = '2026-08-27T18:30:00.000Z';

const mytosQuestion = (overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion => ({
  id: 'degree-classification',
  question: 'what was your degree classification? ✱',
  answer: '3.89/4.00 (US 4.0 scale)',
  kind: 'required',
  required: true,
  portal_selector: 'select[name="cards[bd5d6c5e][field2]"]',
  portal_input_type: 'select-one',
  options: [...MYTOS_OPTIONS],
  answer_source: 'applicant_review',
  answer_reviewed_at: REVIEWED_AT,
  ...overrides,
});

test('a required reviewed answer that fits no exact option re-opens the question with its options', () => {
  const [reopened] = reopenUnfitClosedChoiceQuestions([mytosQuestion()]);

  assert.equal(reopened.answer, '', 'the unfillable answer is cleared so the question is askable again');
  assert.deepEqual(reopened.options, MYTOS_OPTIONS, 'the exact employer options are presented beside it');
  assert.equal(reopened.answer_draft, '3.89/4.00 (US 4.0 scale)', 'her own words survive as the prefilled draft');
  assert.equal(reopened.required, true);
  assert.equal(reopened.portal_selector, mytosQuestion().portal_selector, 'the control identity is untouched');
  assert.deepEqual(
    blankRequiredQuestionLabels([reopened]),
    ['what was your degree classification? ✱'],
    'the re-opened question enters the required-answer send gate until she answers it',
  );
});

test('the re-open is what turns the stuck row into a blocked-but-answerable one', () => {
  const stuck = mytosQuestion();
  assert.deepEqual(
    blankRequiredQuestionLabels([stuck]),
    [],
    'before the re-open the send gate saw an answered question, so nothing ever re-asked it',
  );
  assert.equal(storedAnswerMatchesNoExactOption(stuck), true);
});

test('an answer that matches an option exactly, case aside, stays closed and untouched', () => {
  const fit = mytosQuestion({ answer: 'gpa 3.5-3.8' });
  const [kept] = reopenUnfitClosedChoiceQuestions([fit]);

  assert.deepEqual(kept, fit, 'the fill can place this answer, so nothing is re-opened');
  assert.deepEqual(blankRequiredQuestionLabels([kept]), []);
});

test('an open free-text question is untouched, whatever its answer', () => {
  const essay = mytosQuestion({
    id: 'why-mytos',
    question: 'why do you want to work at mytos? ✱',
    answer: 'Because automating biology needs software people.',
    kind: 'essay',
    portal_input_type: 'textarea',
    options: null,
  });
  const noOptions = mytosQuestion({ options: undefined, portal_input_type: 'text' });

  assert.deepEqual(reopenUnfitClosedChoiceQuestions([essay]), [essay]);
  assert.deepEqual(reopenUnfitClosedChoiceQuestions([noOptions]), [noOptions]);
});

test('placeholder rows are not options: a placeholder-only inventory judges nothing', () => {
  const placeholderOnly = mytosQuestion({ options: ['Select...', 'Please select'] });
  assert.deepEqual(
    reopenUnfitClosedChoiceQuestions([placeholderOnly]),
    [placeholderOnly],
    'PR 711 trap: a placeholder is not an option, so this control has no measured inventory to enforce',
  );
});

test('an optional unfit answer re-opens without blocking, per the optional-question convention', () => {
  const optional = mytosQuestion({ required: false });
  const [reopened] = reopenUnfitClosedChoiceQuestions([optional]);

  assert.equal(reopened.answer, '', 'the unfillable answer still clears');
  assert.equal(reopened.answer_draft, '3.89/4.00 (US 4.0 scale)');
  assert.deepEqual(
    blankRequiredQuestionLabels([reopened]),
    [],
    'an optional blank never enters the required-answer send gate',
  );
});

test('controls outside the strict single-choice set are never judged', () => {
  const combobox = mytosQuestion({ portal_input_type: 'combobox' });
  const checkbox = mytosQuestion({
    portal_input_type: 'checkbox',
    options: ['I have read and agree to the privacy policy'],
    answer: 'Yes',
  });
  const multiple = mytosQuestion({ portal_input_type: 'select-multiple' });

  assert.deepEqual(
    reopenUnfitClosedChoiceQuestions([combobox]),
    [combobox],
    'a searchable combobox can land an answer its first-read menu never enumerated',
  );
  assert.deepEqual(
    reopenUnfitClosedChoiceQuestions([checkbox]),
    [checkbox],
    'PR 711 trap: a single privacy checkbox is not an option list',
  );
  assert.deepEqual(
    reopenUnfitClosedChoiceQuestions([multiple]),
    [multiple],
    'a multi-select answer can honestly name several options at once',
  );
});

test('an explicit consent refusal is never blanked into something a resolver could re-accept', () => {
  const refusal = mytosQuestion({
    question: 'do you agree to the privacy policy? ✱',
    answer: 'I do not agree',
    options: ['I agree', 'Acknowledge/Confirm'],
  });
  assert.deepEqual(reopenUnfitClosedChoiceQuestions([refusal]), [refusal]);
});

test('the draft clears the moment the question carries a real answer again, and the pass is idempotent', () => {
  const [reopened] = reopenUnfitClosedChoiceQuestions([mytosQuestion()]);
  assert.deepEqual(
    reopenUnfitClosedChoiceQuestions([reopened]),
    [reopened],
    'a re-opened question is a fixed point of the pass',
  );

  const answered = { ...reopened, answer: 'GPA 3.5-3.8' };
  const [settled] = reopenUnfitClosedChoiceQuestions([answered]);
  assert.equal(settled.answer, 'GPA 3.5-3.8');
  assert.equal('answer_draft' in settled, false, 'a draft never lingers beside an accepted answer');
});

test('a draft already present is kept in preference to a later machine refill', () => {
  const refilled = mytosQuestion({
    answer: 'Bachelor of Science in Computer Science',
    answer_draft: '3.89/4.00 (US 4.0 scale)',
    answer_source: undefined,
    answer_reviewed_at: undefined,
  });
  const [reopened] = reopenUnfitClosedChoiceQuestions([refilled]);

  assert.equal(reopened.answer, '');
  assert.equal(
    reopened.answer_draft,
    '3.89/4.00 (US 4.0 scale)',
    'her original words survive a refresh-refill/re-open cycle instead of being replaced by the resolver value',
  );
});
