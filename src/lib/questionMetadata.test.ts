import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discoveredQuestionsForExactOptionProbe,
  questionMetadataBlockerForDiscovered,
  reopenUnfitClosedChoiceQuestions,
  snapStoredAnswersToOfferedOptions,
  storedAnswerMatchesNoExactOption,
} from './questionMetadata';
import { blankRequiredQuestionLabels } from './submissionSafety';
import { refreshKnownQuestionAnswers, type ApplicationProfileLike } from './questionDiscovery';
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

/* ── The Hudson River Trading gender control, byte for byte ─────────────────────────────────────
 *
 * Measured live 2026-09-03 (packet 4a79eec1, greenhouse job-boards). The form asks "What is your
 * gender?" and offers Woman / Man / Non-binary / I don't wish to answer. Her stored
 * `eeo_prefs.gender` is "Female", so the stored row held answer "Female", which is on none of those
 * options: reopenUnfitClosedChoiceQuestions blanked it, the dashboard reported "1 answer needs
 * you", and the send was gated on a question her profile answers. PR #888 taught eeoAnswerLadder
 * the Female/Woman equivalence and fixed the FILL, but refreshKnownQuestionAnswers resolves through
 * resolveKnownAnswer, which by design never consults an option list, so the STORED row refreshed to
 * "Female" forever and the gate never cleared. These pin the composed packet-shaping pass - refresh,
 * snap, re-open - that the three call sites run, not just the snap in isolation. */
const HRT_GENDER_OPTIONS = ['Woman', 'Man', 'Non-binary', "I don't wish to answer"];
const HRT_VETERAN_OPTIONS = ['Yes', 'No', "I don't wish to answer"];
const HRT_RACE_OPTIONS = ['South Asian', 'East Asian', 'White', "I don't wish to answer"];
const HRT_ROUND = '2026-09-03T09:14:00.000Z';

const HER_PROFILE: ApplicationProfileLike = {
  eeo_prefs: { gender: 'Female', race: 'South Asian', veteran_status: 'No', hispanic: 'No' },
};

const hrtQuestion = (overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion => ({
  id: 'gender',
  question: 'What is your gender?',
  answer: 'Female',
  kind: 'required',
  required: true,
  portal_input_type: 'select-one',
  options: [...HRT_GENDER_OPTIONS],
  ...overrides,
});

/** The three passes the packet-shaping call sites compose, in their production order. */
const shapePacket = (
  questions: readonly ApplicationReviewQuestion[],
  profile: ApplicationProfileLike = HER_PROFILE,
) => reopenUnfitClosedChoiceQuestions(snapStoredAnswersToOfferedOptions(
  refreshKnownQuestionAnswers(questions, profile, undefined, HRT_ROUND),
));

test('the HRT gender answer reaches the employer in the employer\'s own spelling instead of blocking the send', () => {
  const [shaped] = shapePacket([hrtQuestion()]);

  assert.equal(shaped.answer, 'Woman', '"Female" snaps onto the option the control actually offers');
  assert.deepEqual(shaped.options, HRT_GENDER_OPTIONS, 'the employer\'s list is untouched');
  assert.deepEqual(
    blankRequiredQuestionLabels([shaped]),
    [],
    'the pre-send gate clears: this is no longer "1 answer needs you"',
  );
  assert.equal('answer_draft' in shaped, false, 'nothing was re-opened, so no draft is minted');
});

test('the other three HRT self-identification rows are already in the form\'s vocabulary and are left alone', () => {
  const veteran = hrtQuestion({
    id: 'veteran',
    question: 'Are you a protected veteran?',
    answer: 'No',
    options: [...HRT_VETERAN_OPTIONS],
  });
  const race = hrtQuestion({
    id: 'race',
    question: 'What is your race/ethnicity?',
    answer: 'South Asian',
    options: [...HRT_RACE_OPTIONS],
  });

  assert.equal(shapePacket([veteran])[0].answer, 'No');
  assert.equal(shapePacket([race])[0].answer, 'South Asian',
    'a stored value the list already carries is never widened to a coarser federal category');
});

test('an answer no option and no alias can hold is left exactly as it stands', () => {
  const selfDescribed = hrtQuestion({ answer: 'Trans woman' });
  const [snapped] = snapStoredAnswersToOfferedOptions([selfDescribed]);

  assert.deepEqual(snapped, selfDescribed,
    'nothing is invented and no decline is substituted; the re-open still handles it as before');
  assert.equal(reopenUnfitClosedChoiceQuestions([snapped])[0].answer, '');
});

test('an answer the applicant reviewed and picked from the control\'s own list is not rewritten', () => {
  const reviewed = hrtQuestion({
    answer: 'Man',
    answer_source: 'applicant_review',
    answer_reviewed_at: HRT_ROUND,
  });
  const [shaped] = shapePacket([reviewed]);

  assert.equal(shaped.answer, 'Man',
    'the refresh\'s reviewed-answer guard wins, and the snap refuses an answer the list already offers');
  assert.equal(shaped.answer_source, 'applicant_review', 'her provenance rides along untouched');
});

test('a control with no options is a no-op, which is every free-text question', () => {
  const essay = hrtQuestion({
    id: 'essay',
    question: 'Describe a project you are proud of',
    answer: 'Female',
    kind: 'essay',
    required: false,
    portal_input_type: 'textarea',
    options: null,
  });
  assert.deepEqual(snapStoredAnswersToOfferedOptions([essay]), [essay]);
});

test('the snap is a fixed point of the refresh/snap chain, so it composes inside packetQuestionFixpoint', () => {
  const first = snapStoredAnswersToOfferedOptions(
    refreshKnownQuestionAnswers([hrtQuestion()], HER_PROFILE, undefined, HRT_ROUND),
  );
  const second = snapStoredAnswersToOfferedOptions(
    refreshKnownQuestionAnswers(first, HER_PROFILE, undefined, HRT_ROUND),
  );
  assert.equal(first[0].answer, 'Woman');
  assert.deepEqual(second, first, 'the chain settles instead of flipping Woman/Female forever');
});

test('the equivalence runs in both directions, for the boards that spell it Female/Male', () => {
  const storedWoman = hrtQuestion({
    answer: 'Woman',
    options: ['Female', 'Male', 'Decline To Self Identify'],
  });
  assert.equal(
    snapStoredAnswersToOfferedOptions([storedWoman])[0].answer,
    'Female',
    'a stored "Woman" reaches an older Greenhouse list written in the other vocabulary',
  );
});
