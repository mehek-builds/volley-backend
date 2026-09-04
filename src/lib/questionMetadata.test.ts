import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoveredQuestionsForExactOptionProbe,
  questionMetadataBlockerForDiscovered,
  reopenUnfitClosedChoiceQuestions,
  snapStoredAnswersToProfileFieldOptions,
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

test('a partial discovered option list is a blocker and is never treated as an exact list', () => {
  const field = {
    label: 'Which office do you prefer?',
    selector: '#office',
    durableSelector: '#office',
    inputType: 'select-one',
    role: null,
    maxLength: null,
    required: false,
    options: ['Dubai', 'London'],
    optionsComplete: false,
  };
  const blocker = questionMetadataBlockerForDiscovered(field);
  assert.equal(blocker?.kind, 'missing_exact_options');
  assert.equal(blocker?.question, field.label);
  assert.equal(blocker?.required, false);
  assert.equal(blocker?.portal_input_type, field.inputType);
  assert.equal(discoveredQuestionsForExactOptionProbe([field])[0]?.options, null,
    'the next probe must re-read the control instead of resolving against a partial list');
});

/* ── snapStoredAnswersToProfileFieldOptions: the Sage graduation-window control ──────────────────
 *
 * Measured live 2026-09-04, account mehekmandal05@gmail.com, Sage Greenhouse packet
 * aae653a3-2d5a-4f3e-ba3b-afea4219df37. "When do you expect to graduate?" is a required `combobox`
 * offering season/year terms; her profile stores grad_date "May 2028". She picked "Spring 2028",
 * the save genuinely stored it, and the very next read overwrote it with the raw "May 2028" -
 * off every option the control offers - because refreshKnownQuestionAnswers never sees a control's
 * option list and nothing downstream re-snapped its output. See questionMetadata.ts's own header on
 * this function for the full trace. */
const GRAD_OPTIONS = ['Spring 2027', 'Fall 2027', 'Spring 2028', 'Fall 2028', 'Spring 2029', 'Fall 2029', '2030 or later'];

const gradQuestion = (overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion => ({
  id: 'grad-date',
  question: 'When do you expect to graduate?',
  answer: 'May 2028',
  kind: 'required',
  required: true,
  portal_input_type: 'combobox',
  options: [...GRAD_OPTIONS],
  ...overrides,
});

test('a graduation date the control cannot hold snaps onto the season/year option it maps to', () => {
  const [snapped] = snapStoredAnswersToProfileFieldOptions([gradQuestion()]);
  assert.equal(snapped.answer, 'Spring 2028', 'May snaps to Spring, the mapping graduationDateLadder already carries');
  assert.equal(snapped.answer_option_source, 'May 2028', 'the pre-snap profile fact is recorded');
  assert.equal(snapped.answer_source, undefined, 'a snap is a machine value, never a stamped applicant review');
});

test('December snaps to Fall, the other half of the season mapping', () => {
  const [snapped] = snapStoredAnswersToProfileFieldOptions([gradQuestion({ answer: 'December 2027' })]);
  assert.equal(snapped.answer, 'Fall 2027');
  assert.equal(snapped.answer_option_source, 'December 2027');
});

test('THE CRUX: combobox is snapped, unlike storedAnswerMatchesNoExactOption\'s strict set', () => {
  const stored = gradQuestion();
  assert.equal(
    storedAnswerMatchesNoExactOption(stored),
    false,
    'combobox is deliberately excluded from the re-open gate, so this must not be mistaken for "fits"',
  );
  assert.notDeepEqual(
    snapStoredAnswersToProfileFieldOptions([stored]),
    [stored],
    'but the wider REVIEWED_PICK_EXACT_OPTION_TYPE gate still lets a fit-by-alias answer be written here',
  );
});

test('every reachable control type snaps the same way, not only combobox', () => {
  for (const portal_input_type of ['select', 'select-one', 'radio', 'listbox', 'combobox']) {
    const [snapped] = snapStoredAnswersToProfileFieldOptions([gradQuestion({ portal_input_type })]);
    assert.equal(snapped.answer, 'Spring 2028', `${portal_input_type} must also snap`);
  }
});

test('a stored answer already on the control\'s list is never touched', () => {
  const fit = gradQuestion({ answer: 'Spring 2028' });
  assert.deepEqual(snapStoredAnswersToProfileFieldOptions([fit]), [fit]);
});

test('a stored answer with no alias on this list is left exactly as it stands', () => {
  const noMatch = gradQuestion({ options: ['2030 or later', '2031 or later'] });
  assert.deepEqual(
    snapStoredAnswersToProfileFieldOptions([noMatch]),
    [noMatch],
    'nothing is invented when the control genuinely cannot hold the profile fact',
  );
});

test('an open control, or a control with no options, is never snapped', () => {
  const openControl = gradQuestion({ portal_input_type: 'text', options: undefined });
  const noOptions = gradQuestion({ options: null });
  const emptyOptions = gradQuestion({ options: [] });
  assert.deepEqual(snapStoredAnswersToProfileFieldOptions([openControl]), [openControl]);
  assert.deepEqual(snapStoredAnswersToProfileFieldOptions([noOptions]), [noOptions]);
  assert.deepEqual(snapStoredAnswersToProfileFieldOptions([emptyOptions]), [emptyOptions]);
});

test('a blank stored answer is never snapped', () => {
  const blank = gradQuestion({ answer: '' });
  assert.deepEqual(snapStoredAnswersToProfileFieldOptions([blank]), [blank]);
});

test('two listed options that fold to the same key are already one option by the time this runs', () => {
  /* usableOptions (shared with storedAnswerMatchesNoExactOption) de-duplicates by comparableOption
   * before this function ever sees the list, first occurrence wins - the same rule the rest of this
   * file already applies to a discovered menu. So "spring 2028 " never becomes a second candidate to
   * disambiguate; it collapses into "Spring 2028" upstream, deterministically. */
  const [snapped] = snapStoredAnswersToProfileFieldOptions(
    [gradQuestion({ options: ['Spring 2028', 'spring 2028 ', 'Fall 2028'] })],
  );
  assert.equal(snapped.answer, 'Spring 2028');
});

test('EEO labels are left untouched: that family belongs to the in-flight #892/#897 snap, not this one', () => {
  const gender = gradQuestion({
    id: 'gender',
    question: 'What is your gender?',
    answer: 'Female',
    options: ['Woman', 'Man', 'Non-binary', "I don't wish to answer"],
  });
  assert.deepEqual(
    snapStoredAnswersToProfileFieldOptions([gender]),
    [gender],
    'profileFieldIntent returns null for every EEO label, so this function is a no-op on it',
  );
});

test('a label this function does not classify at all is left untouched', () => {
  const essay = gradQuestion({
    id: 'why-us',
    question: 'Why do you want to work here?',
    answer: 'Because the mission fits my background.',
    options: ['Option A', 'Option B'],
  });
  assert.deepEqual(snapStoredAnswersToProfileFieldOptions([essay]), [essay]);
});

test('provenance made about the un-snapped string is dropped, and the pass is idempotent', () => {
  const reviewed = gradQuestion({
    answer_source: 'applicant_review',
    answer_reviewed_at: '2026-08-01T00:00:00.000Z',
    answer_override_of: 'some stale note',
    answer_state: 'skipped',
  });
  const [snapped] = snapStoredAnswersToProfileFieldOptions([reviewed]);
  assert.equal(snapped.answer, 'Spring 2028');
  assert.equal(snapped.answer_source, undefined);
  assert.equal(snapped.answer_reviewed_at, undefined);
  assert.equal(snapped.answer_override_of, undefined);
  assert.equal('answer_state' in snapped, false);
  assert.equal(snapped.answer_option_source, 'May 2028');
  assert.deepEqual(
    snapStoredAnswersToProfileFieldOptions([snapped]),
    [snapped],
    'a snapped record is a fixed point of its own pass',
  );
});

test('the mechanism generalizes past graduation dates: a GPA rounds onto the option gpaLadder offers', () => {
  /* Bands ("3.5-3.8") are a different, already-existing mechanism (optionBandAnswer /
   * reviewedOptionBandVerdict) and are deliberately out of scope for this alias-only matcher - nothing
   * here should start guessing whether 3.89 falls inside a range. gpaLadder's own rounded candidate
   * ("3.9") is a plain alias, exactly like the graduation ladder's season word, so a control offering
   * that literal token is exactly what this generalizes to. */
  const gpaQuestion: ApplicationReviewQuestion = {
    id: 'gpa',
    question: 'What is your GPA?',
    answer: '3.89',
    kind: 'required',
    required: true,
    portal_input_type: 'select-one',
    options: ['3.9', '3.5', '3.0'],
  };
  const [snapped] = snapStoredAnswersToProfileFieldOptions([gpaQuestion]);
  assert.equal(snapped.answer, '3.9', 'gpaLadder\'s own rounded-to-one-decimal candidate');
  assert.equal(snapped.answer_option_source, '3.89');
});
