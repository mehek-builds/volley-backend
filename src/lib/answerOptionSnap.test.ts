import test from 'node:test';
import assert from 'node:assert/strict';
import {
  knownAnswerLookup,
  refreshKnownQuestionAnswers,
  snapAnswerToOfferedOption,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { resolveSubmittedApplicationAnswers } from './submittedAnswers';
import { reopenUnfitClosedChoiceQuestions, storedAnswerMatchesNoExactOption } from './questionMetadata';
import { blankRequiredQuestionLabels } from './submissionSafety';
import { isDeclineToState } from './selfIdentification';
import type { ApplicationReviewQuestion } from './applicationReview';

/* ── The Hudson River Trading gender control, byte for byte ────────────────────────────────────
 *
 * MEASURED IN PRODUCTION 2026-09-03 on packet 4a79eec1 (Hudson River Trading, greenhouse). The
 * required control asks "What is your gender?" and offers Woman / Man / Non-binary / I don't wish
 * to answer. Her stored eeo_prefs.gender is "Female", which is on none of them, so the fill can
 * select nothing and the packet cannot proceed. PR #888 shipped the Female/Woman equivalence into
 * the FILL path and no save has ever reached it.
 *
 * EVERY SAFETY CLAIM HERE IS TESTED THROUGH resolveSubmittedApplicationAnswers, the function
 * routes/applications.ts calls on Save, and NOT through the leaf. That is deliberate and it is the
 * whole lesson of the first round of this PR: the refresh inside that composition REPLACES a stored
 * answer with the profile's value, so a leaf test hands the snap a string the real path never hands
 * it, and four rewrites that a leaf test called safe were live in the composed path. Leaf tests
 * below are confined to the matcher's own arithmetic and say so. */
const HRT_GENDER_OPTIONS = ['Woman', 'Man', 'Non-binary', "I don't wish to answer"];
const ROUND = '2026-09-03T09:14:00.000Z';
const AS_OF = new Date('2026-09-03T09:14:00.000Z');

const HER_PROFILE = {
  eeo_prefs: {
    gender: 'Female', race: 'South Asian', veteran_status: 'No', hispanic: 'No',
  },
} as unknown as ApplicationProfileLike;

const question = (overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion => ({
  id: 'gender',
  question: 'What is your gender?',
  answer: 'Female',
  kind: 'required',
  required: true,
  portal_input_type: 'radio',
  options: [...HRT_GENDER_OPTIONS],
  ...overrides,
});

/**
 * The real save path: merge, then refresh and re-open to a fixpoint. Not a stand-in for it.
 *
 * `submitted` is the stored list posted back unchanged, which is what an untouched Save actually
 * sends: the client posts back the rows it was shown. Passing an EMPTY submitted list is not the
 * same thing and quietly changes the answer under test, because the merge strips answer_source from
 * a stored question with no counterpart in the review.
 */
const savePath = (
  questions: readonly ApplicationReviewQuestion[],
  profile: ApplicationProfileLike = HER_PROFILE,
) => resolveSubmittedApplicationAnswers({
  current: { questions: [...questions], questions_reviewed_at: null, jd_text: undefined } as never,
  submitted: questions.map((one) => ({ ...one })),
  profile,
  now: () => ROUND,
  asOf: AS_OF,
}).questions;

test('the HRT gender answer reaches the employer in the employer\'s own spelling instead of blocking the send', () => {
  const [saved] = savePath([question()]);

  assert.equal(saved.answer, 'Woman', '"Female" is re-spelled as the option the control offers');
  assert.deepEqual(saved.options, HRT_GENDER_OPTIONS, 'the employer\'s list is untouched');
  assert.deepEqual(
    blankRequiredQuestionLabels([saved]),
    [],
    'the pre-send gate clears: this is no longer "1 answer needs you"',
  );
  assert.equal('answer_draft' in saved, false, 'nothing was re-opened, so no draft is minted');
});

test('the repair reaches every control type that may hold a fit answer, combobox included', () => {
  /* #896 infers that HRT's own gender control is a combobox, and on a combobox the re-open never
   * fires, so the deadlock is at fill time rather than as a blanked card. Both shapes must clear,
   * because the packet's own portal_input_type could not be read from here. */
  for (const portal_input_type of ['radio', 'select', 'select-one', 'listbox', 'combobox']) {
    assert.equal(
      savePath([question({ portal_input_type })])[0].answer,
      'Woman',
      `${portal_input_type} is a control that may hold a fit answer`,
    );
  }
});

test('the equivalence runs both ways, for the boards that spell it Female and Male', () => {
  const otherVocabulary = savePath(
    [question({ answer: 'Woman', options: ['Female', 'Male', 'Decline To Self Identify'] })],
    { eeo_prefs: { gender: 'Woman' } } as unknown as ApplicationProfileLike,
  );
  assert.equal(otherVocabulary[0].answer, 'Female', 'a stored "Woman" reaches a Female/Male list');

  const male = savePath(
    [question({ answer: 'Male' })],
    { eeo_prefs: { gender: 'Male' } } as unknown as ApplicationProfileLike,
  );
  assert.equal(male[0].answer, 'Man');
});

/* ── The answer the refresh wrote over hers is NEVER the thing re-spelled ──────────────────────
 *
 * THE DEFECT THIS PINS, measured through resolveSubmittedApplicationAnswers on the first version of
 * this PR, profile gender "Female", HRT list, radio:
 *
 *   stored "Trans woman"        ->  "Woman"   SENT as her self-identification
 *   stored "Prefer not to say"  ->  "Woman"   a stored REFUSAL turned into an affirmative claim
 *   stored "Genderqueer"        ->  "Woman"
 *   stored "Intersex"           ->  "Woman"
 *
 * refreshKnownQuestionAnswers clobbers each stored answer with the profile value "Female", and
 * re-spelling THAT made it fit the control, so reopenUnfitClosedChoiceQuestions stopped blanking it
 * and blankRequiredQuestionLabels stopped gating the send. On main the clobber is self-defeating:
 * the value is unpaintable, the row re-opens, and she answers. Measured on 0763733, every row below
 * settles to "" there, which is what these assert. */
const NEVER_HERS_TO_REWRITE: ReadonlyArray<{ label: string; answer: string }> = [
  { label: 'What is your gender?', answer: 'Trans woman' },
  { label: 'What is your gender?', answer: 'Prefer not to say' },
  { label: 'What is your gender?', answer: 'Genderqueer' },
  { label: 'What is your sex?', answer: 'Intersex' },
];

for (const { label, answer } of NEVER_HERS_TO_REWRITE) {
  test(`a stored "${answer}" is re-opened for her, never re-spelled as the profile's gender`, () => {
    const [saved] = savePath([question({ id: 'x', question: label, answer })]);

    assert.equal(saved.answer, '', 'the row re-opens exactly as it does on main, and she picks');
    assert.notEqual(saved.answer, 'Woman');
    assert.deepEqual(
      blankRequiredQuestionLabels([saved]),
      [label],
      'and the send stays gated on it, which is the system asking her',
    );
  });
}

/* ── Never a decline, through the composition ─────────────────────────────────────────────────
 *
 * PR #892 rewrote each of these to the control's own opt-out. Every list below carries exactly one
 * decline, so the wrong answer is always reachable. Asserted against the OPTIONS rather than
 * against a fixed string, because what must never happen is that the machine lands on the
 * employer's own refusal. */
const NEVER_A_DECLINE: ReadonlyArray<{ label: string; answer: string; options: string[] }> = [
  {
    label: 'What is your race/ethnicity?',
    answer: 'South Asian',
    options: ['Asian', 'Black or African American', 'White', 'Decline to self-identify'],
  },
  {
    label: 'What is your race/ethnicity?',
    answer: 'Middle Eastern',
    options: ['Asian', 'White', 'Two or More Races', 'I do not wish to answer'],
  },
  { label: 'What is your gender?', answer: 'Trans woman', options: [...HRT_GENDER_OPTIONS] },
  {
    label: 'What is your age?',
    answer: '20',
    options: ['18-24', '25-34', '35-44', 'Prefer not to say'],
  },
];

for (const { label, answer, options } of NEVER_A_DECLINE) {
  test(`"${answer}" never lands on the control's own decline, through the save path`, () => {
    const [saved] = savePath([question({ id: 'x', question: label, answer, options: [...options] })]);
    const declines = options.filter((option) => isDeclineToState(option));

    assert.equal(declines.length, 1, 'the list really does offer a decline to land on');
    assert.equal(
      declines.includes(saved.answer.trim()), false,
      `the save path answered ${JSON.stringify(saved.answer)}, which must not be the opt-out`,
    );
    assert.equal(
      options.includes(saved.answer.trim()) && saved.answer.trim() !== answer, false,
      'and it did not silently land on any other option of the employer\'s either',
    );
  });
}

test('a widening is not a re-spelling: a coarser federal race category is never written', () => {
  /* selfIdentificationStatedForms offers "Asian" as the category containing "South Asian", and
   * resolveProfileField takes it when CHOOSING what to put in an empty control. Rewriting an answer
   * already in a packet is a different act, so this path takes only the symmetric rung. */
  const [saved] = savePath([question({
    id: 'race',
    question: 'What is your race/ethnicity?',
    answer: 'South Asian',
    options: ['Asian', 'White', 'Black or African American'],
  })]);
  assert.notEqual(saved.answer, 'Asian', 'the coarser category is never written for her');
  assert.equal(saved.answer, '', 're-opened instead, byte for byte what 0763733 does');
});

test('a skip cannot ride onto a machine-rewritten answer', () => {
  /* submissionRunner's skipOutlivedItsAnswer rule: a skip means "the value is right, the portal's
   * menu will not take it, leave the field alone", it is bound to a NON-EMPTY answer
   * (applicationReview.ts), and carried onto a value the machine has since rewritten it silences
   * the send gate for something she never saw. */
  const skipped = question({ answer_state: 'skipped' } as Partial<ApplicationReviewQuestion>);
  const snapped = snapAnswerToOfferedOption(skipped, 'Female') as Record<string, unknown>;

  assert.equal(snapped.answer, 'Woman', 'the answer really did change');
  assert.equal('answer_state' in snapped, false, 'so the skip taken against "Female" is gone');
});

test('a snapped answer sheds every claim made about the string it replaced', () => {
  const claimed = question({
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
    answer_override_of: 'Woman',
    consent_permission_version: 'v3',
    consent_permission_granted_at: ROUND,
  } as Partial<ApplicationReviewQuestion>);

  const snapped = snapAnswerToOfferedOption(claimed, 'Female') as Record<string, unknown>;

  assert.equal(snapped.answer, 'Woman');
  for (const field of [
    'answer_source', 'answer_reviewed_at', 'answer_override_of',
    'consent_permission_version', 'consent_permission_granted_at',
  ]) {
    assert.equal(field in snapped, false, `${field} belongs to the answer it was made about`);
  }
  assert.equal(
    snapped.answer_option_source, 'Female',
    'and the profile value it was snapped from is recorded, which is what that field is for',
  );
});

test('the repair survives a second save instead of lasting exactly one round trip', () => {
  /* answer_option_source is load-bearing here. Without it the self-identification currency branch
   * cannot prove "Woman" still states "Female", the next save recomputes it back and re-opens the
   * question, and the applicant sees the same ask again. */
  const first = savePath([question()]);
  assert.equal(first[0].answer, 'Woman');

  const second = savePath(first);
  assert.equal(second[0].answer, 'Woman', 'a second Save does not undo the first');
  assert.deepEqual(savePath(second), second, 'and the record has settled');
});

test('an answer she reviewed and picked from the control\'s own list is still kept verbatim', () => {
  const [saved] = savePath([question({
    answer: 'Man',
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
  } as Partial<ApplicationReviewQuestion>)]);

  assert.equal(saved.answer, 'Man');
  assert.equal(saved.answer_source, 'applicant_review', 'her provenance rides along untouched');
});

test('the lookup answers what the refresh serves, so an untouched Save mints no applicant claim', () => {
  /* mergeSubmittedApplicationReviewQuestions asks whether the posted answer is the resolver's own
   * value, because GET /applications/:id/submission refreshes on read and the client posts back
   * what it was shown. A lookup answering "Female" while the screen shows "Woman" would read an
   * untouched Save as an edit and stamp a gender she never selected. It must also agree on the rows
   * the snap refuses, which is why both are checked. */
  for (const stored of [question(), question({ answer: 'Trans woman' })]) {
    const served = refreshKnownQuestionAnswers(
      [stored], HER_PROFILE, undefined, ROUND, undefined, undefined, AS_OF,
    )[0].answer;
    assert.equal(
      knownAnswerLookup(HER_PROFILE, undefined, undefined, undefined, AS_OF)(stored),
      served,
      `lookup and refresh disagree for stored ${JSON.stringify(stored.answer)}`,
    );
  }
});

/* ── The matcher's own arithmetic ──────────────────────────────────────────────────────────────
 *
 * These call the leaf on purpose and pass the answer of record explicitly, because what they pin is
 * the gate/matcher relation rather than any claim about the composed path. Every safety claim about
 * what a save can do to a real packet is above, through resolveSubmittedApplicationAnswers. */

test('a stored answer the control already offers is not re-spelled at all', () => {
  const bothSpellings = question({ answer: 'Female', options: ['Female', 'Woman', 'Non-binary'] });
  assert.equal(storedAnswerMatchesNoExactOption(bothSpellings), false, 'the list already holds it');
  assert.deepEqual(snapAnswerToOfferedOption(bothSpellings, 'Female'), bothSpellings);
  assert.equal(
    snapAnswerToOfferedOption(question({ options: ['Woman', 'Man'] }), 'Female').answer,
    'Woman',
    'and drop "Female" from that list and the same record does snap',
  );
});

test('"C#" against ["C", "C#", "Java", "Python"] is not rewritten to "C"', () => {
  /* THE GATE AND THE MATCHER ARE ONE RELATION. comparableOption folds "C#" onto "c", which is also
   * "C"'s key, so usableOptions de-duplicates the two and the strict gate calls the answer
   * off-list. A matcher on a looser relation than its gate then finds "C" and rewrites a language
   * she named to a different one. That was PR #892's second critical. */
  const stored = question({
    id: 'lang', question: 'Primary programming language', answer: 'C#',
    options: ['C', 'C#', 'Java', 'Python'],
  });
  assert.equal(storedAnswerMatchesNoExactOption(stored), true, 'the strict gate calls it off-list');
  assert.deepEqual(snapAnswerToOfferedOption(stored, 'C#'), stored);
  const [saved] = savePath([stored]);
  assert.notEqual(saved.answer, 'C', 'and the save path never turns her language into another one');
  assert.equal(saved.answer, '', 're-opened instead, byte for byte what 0763733 does');
});

test('two options spelling the same re-spelling refuse rather than picking by DOM order', () => {
  const ambiguous = question({ options: ['Woman', 'woman', 'Man'] });
  assert.deepEqual(snapAnswerToOfferedOption(ambiguous, 'Female'), ambiguous);
  assert.equal(
    snapAnswerToOfferedOption(question({ options: ['Woman', 'Woman', 'Man'] }), 'Female').answer,
    'Woman',
    'two rows spelling it identically are one option, and that one is adopted',
  );
});

test('an open control is never snapped, whatever it happens to carry beside it', () => {
  for (const portal_input_type of ['textarea', 'text', 'checkbox', 'select-multiple']) {
    const stored = question({ portal_input_type });
    assert.deepEqual(snapAnswerToOfferedOption(stored, 'Female'), stored);
  }
});

test('a control with no readable options cannot produce a rewrite', () => {
  for (const options of [null, undefined, [], ['   ']]) {
    const stored = question({ options: options as string[] | null });
    assert.deepEqual(snapAnswerToOfferedOption(stored, 'Female'), stored);
  }
  assert.equal(
    snapAnswerToOfferedOption(question({ options: ['   ', 'Woman', 'Man'] }), 'Female').answer,
    'Woman',
  );
});
