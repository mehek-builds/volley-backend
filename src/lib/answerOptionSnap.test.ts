import test from 'node:test';
import assert from 'node:assert/strict';
import {
  knownAnswerLookup,
  refreshKnownQuestionAnswers,
  snapAnswerToOfferedOption,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { reopenUnfitClosedChoiceQuestions, storedAnswerMatchesNoExactOption } from './questionMetadata';
import { packetQuestionFixpoint } from './packetQuestionIdentity';
import { blankRequiredQuestionLabels } from './submissionSafety';
import type { ApplicationReviewQuestion } from './applicationReview';

/* ── The Hudson River Trading gender control, byte for byte ────────────────────────────────────
 *
 * MEASURED IN PRODUCTION 2026-09-03 on packet 4a79eec1 (Hudson River Trading, greenhouse). The
 * required control asks "What is your gender?" and offers Woman / Man / Non-binary / I don't wish
 * to answer. Her stored eeo_prefs.gender is "Female". Pressing Save on the live dashboard returned
 * 200 with the answer still "Female"; reopenUnfitClosedChoiceQuestions then blanked it, the card
 * rendered with every radio unchecked, and the packet could not proceed.
 *
 * Commit 7a3d1b2 (PR #888) had already shipped the Female/Woman equivalence and was measured on
 * this exact packet. It lives in the FILL path, and a save has never reached it, so it was correct,
 * deployed and unreachable. These tests exercise the composed save path, refresh then re-open, that
 * routes/applications.ts runs through resolveSubmittedApplicationAnswers, not the snap alone. */
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
  portal_input_type: 'select-one',
  options: [...HRT_GENDER_OPTIONS],
  ...overrides,
});

/** The save path's own composition: refresh, then re-open, driven to a fixpoint. */
const savePath = (
  questions: readonly ApplicationReviewQuestion[],
  profile: ApplicationProfileLike = HER_PROFILE,
) => packetQuestionFixpoint(questions, (candidate) => reopenUnfitClosedChoiceQuestions(
  refreshKnownQuestionAnswers(candidate, profile, undefined, ROUND, undefined, undefined, AS_OF),
));

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

test('the equivalence runs both ways, for the boards that spell it Female and Male', () => {
  assert.equal(
    snapAnswerToOfferedOption(question({ answer: 'Woman', options: ['Female', 'Male', 'Decline To Self Identify'] })).answer,
    'Female',
    'a stored "Woman" reaches an older list written in the other vocabulary',
  );
  assert.equal(
    snapAnswerToOfferedOption(question({ answer: 'Male', options: [...HRT_GENDER_OPTIONS] })).answer,
    'Man',
  );
});

/* ── The four answers a machine must never answer for her ──────────────────────────────────────
 *
 * PR #892 attempted this repair through profileAnswerAliases, whose ladder ends in the decline
 * wordings, and chooseEeoOption, whose last resort is the sole option reading as a refusal.
 * Measured on that branch: "South Asian" became "Prefer not to say", "Middle Eastern" became
 * "I do not wish to answer", "Trans woman" became "I do not wish to answer", and an age of "20"
 * became "Prefer not to say". Each of those is a claim she never made, on the one question family
 * where the honest outcome of "no option fits" is to ask her.
 *
 * Every list below carries a decline, so a decline is always reachable and always the wrong answer.
 * The rule that forbids it is structural rather than a check: the only candidates are
 * selfIdentificationRespellings, which is her own wording plus the paired gender term, and the
 * decline wordings live one rung further down in eeoAnswerLadder, which this path does not call. */
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
  test(`"${answer}" is never rewritten to a decline, and is left for her to answer`, () => {
    const stored = question({ id: 'x', question: label, answer, options: [...options] });

    /* THE ROW IS GENUINELY IN THE DANGEROUS STATE, which is what makes the refusal below mean
     * something: this is the set the re-open is about to blank and the set PR #892 rewrote. */
    assert.equal(storedAnswerMatchesNoExactOption(stored), true, 'no option holds this answer');
    assert.deepEqual(snapAnswerToOfferedOption(stored), stored, 'the record is returned untouched');

    const [reopened] = reopenUnfitClosedChoiceQuestions([snapAnswerToOfferedOption(stored)]);
    assert.equal(reopened.answer, '', 'the question re-opens exactly as it does today');
    assert.equal(reopened.answer_draft, answer, 'and her own words are kept for the dashboard');
  });
}

test('a refusal she gave is not re-spelled into the control\'s refusal either', () => {
  /* eeoAnswerLadder does respell one refusal as another for a FILL, and the ladder argues that is a
   * substitution of the same refusal for itself. This path still declines to do it: a refusal is
   * not a stated answer, the only candidates here are her own wording and the paired gender term,
   * and main leaves this row exactly as it stands. */
  const stored = question({
    id: 'hispanic',
    question: 'Are you Hispanic or Latino?',
    answer: 'Decline to self-identify',
    options: ['Yes', 'No', 'Prefer not to say'],
  });
  assert.deepEqual(snapAnswerToOfferedOption(stored), stored);
  assert.equal(
    snapAnswerToOfferedOption(question({ answer: 'Female' })).answer,
    'Woman',
    'and the snap is live on the same shape of record: only the refusal is refused',
  );
});

test('a widening is not a re-spelling: a coarser federal race category is never written here', () => {
  /* selfIdentificationStatedForms offers "Asian" as the category that wholly contains "South
   * Asian", and resolveProfileField takes it when it is CHOOSING what to put in an empty control.
   * Rewriting an answer already in a packet is a different act: the alternative to widening is that
   * she is asked, so this path takes only the symmetric rung. */
  const stored = question({
    id: 'race',
    question: 'What is your race/ethnicity?',
    answer: 'South Asian',
    options: ['Asian', 'White', 'Black or African American'],
  });
  assert.equal(storedAnswerMatchesNoExactOption(stored), true, 'no option holds "South Asian"');
  assert.deepEqual(snapAnswerToOfferedOption(stored), stored);
});

test('a stored answer the control already offers is not re-spelled at all', () => {
  /* THE GATE. Without it the loop reaches the paired term even when the list carries her own
   * spelling, and rewrites "Female" to "Woman" on a control that would have accepted "Female",
   * shedding her provenance for nothing. */
  const bothSpellings = question({ answer: 'Female', options: ['Female', 'Woman', 'Non-binary'] });
  assert.equal(storedAnswerMatchesNoExactOption(bothSpellings), false, 'the list already holds it');
  assert.deepEqual(snapAnswerToOfferedOption(bothSpellings), bothSpellings);
  assert.equal(
    snapAnswerToOfferedOption(question({ answer: 'Female', options: ['Woman', 'Man'] })).answer,
    'Woman',
    'and drop "Female" from that list and the same record does snap',
  );

  const foldedByPunctuation = question({
    answer: "I don't wish to answer",
    options: ['Woman', 'Man', 'I dont wish to answer'],
  });
  assert.deepEqual(snapAnswerToOfferedOption(foldedByPunctuation), foldedByPunctuation);
});

test('"C#" against ["C", "C#", "Java", "Python"] is not rewritten to "C"', () => {
  /* THE GATE AND THE MATCHER ARE ONE RELATION, and this is the case that proves it. comparableOption
   * folds "C#" onto "c", which is also "C"'s key, so usableOptions de-duplicates the two. A gate
   * asking the STRICTER question (lowercase byte equality) calls "C#" off-list, and the matcher then
   * finds "C" and rewrites a language she named to a different language. That was PR #892's second
   * critical, and it is not specific to EEO: it is what any two-relation rewrite does. */
  const stored = question({
    id: 'lang',
    question: 'Primary programming language',
    answer: 'C#',
    options: ['C', 'C#', 'Java', 'Python'],
  });
  assert.equal(
    storedAnswerMatchesNoExactOption(stored), true,
    'usableOptions de-duplicates "C#" away and the strict gate calls the answer off-list: this is'
    + ' exactly the state a second, looser matcher turns into a rewrite',
  );
  assert.deepEqual(snapAnswerToOfferedOption(stored), stored);
  assert.equal(
    refreshKnownQuestionAnswers([stored], HER_PROFILE, undefined, ROUND, undefined, undefined, AS_OF)[0].answer,
    'C#',
    'and the whole refresh leaves it alone too',
  );
});

test('two options spelling the same re-spelling refuse rather than picking by DOM order', () => {
  const stored = question({ answer: 'Female', options: ['Woman', 'woman', 'Man'] });
  assert.equal(storedAnswerMatchesNoExactOption(stored), true);
  assert.deepEqual(snapAnswerToOfferedOption(stored), stored);
  assert.equal(
    snapAnswerToOfferedOption(question({ answer: 'Female', options: ['Woman', 'Woman', 'Man'] })).answer,
    'Woman',
    'two rows spelling it identically are one option, and that one is adopted',
  );
});

test('an open control is never snapped, whatever it happens to carry beside it', () => {
  /* THE CONTROL-TYPE GATE. SINGLE_CHOICE_EXACT_OPTION_TYPE is the same constant
   * reopenUnfitClosedChoiceQuestions gates on, so a control this path may rewrite is always one
   * that path would otherwise blank. */
  for (const portal_input_type of ['textarea', 'text', 'checkbox', 'select-multiple', 'combobox']) {
    const stored = question({ answer: 'Female', portal_input_type });
    assert.deepEqual(
      snapAnswerToOfferedOption(stored),
      stored,
      `${portal_input_type} is not a strict single choice and is never rewritten`,
    );
  }
});

test('a control with no readable options cannot produce a rewrite', () => {
  /* Nothing can be adopted that the employer did not put on the control, so "the list must be
   * complete" arrives by construction rather than as a check. The positive control is the point of
   * the test: the same record snaps the moment the list carries the word. */
  for (const options of [null, undefined, [], ['   ']]) {
    const stored = question({ options: options as string[] | null });
    assert.deepEqual(snapAnswerToOfferedOption(stored), stored);
  }
  assert.equal(
    snapAnswerToOfferedOption(question({ options: ['   ', 'Woman', 'Man'] })).answer,
    'Woman',
  );
});

test('a snapped answer is a machine value and sheds every claim made about the old one', () => {
  /* THE PROVENANCE RULE. `answer_source: 'applicant_review'` beside a value she was never shown is
   * the laundering applications.ts records a prior incident for, and it is self-sealing: the
   * refresh keeps a reviewed answer that matches an offered option ahead of every recompute rule,
   * so the rewritten value would be immune to later correction. Every field here is a claim about
   * the OLD string. */
  const claimed = question({
    answer: 'Female',
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
    answer_option_source: 'Female',
    answer_override_of: 'Woman',
    consent_permission_version: 'v3',
    consent_permission_granted_at: ROUND,
  } as Partial<ApplicationReviewQuestion>);

  const snapped = snapAnswerToOfferedOption(claimed) as Record<string, unknown>;

  assert.equal(snapped.answer, 'Woman', 'the answer really did change, so the claims below are stale');
  for (const field of [
    'answer_source',
    'answer_reviewed_at',
    'answer_option_source',
    'answer_override_of',
    'consent_permission_version',
    'consent_permission_granted_at',
  ]) {
    assert.equal(field in snapped, false, `${field} belongs to the answer it was made about`);
  }
});

test('an answer she reviewed and picked from the control\'s own list is still kept verbatim', () => {
  /* The refresh's existing early return, unweakened: a reviewed answer that IS an offered option is
   * returned before anything else runs, and the snap's gate refuses it a second time. */
  const [saved] = savePath([question({
    answer: 'Man',
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
  } as Partial<ApplicationReviewQuestion>)]);

  assert.equal(saved.answer, 'Man');
  assert.equal(saved.answer_source, 'applicant_review', 'her provenance rides along untouched');
  assert.equal(saved.answer_reviewed_at, ROUND);
});

test('the lookup answers what the refresh serves, so an untouched Save mints no applicant claim', () => {
  /* mergeSubmittedApplicationReviewQuestions asks whether the posted answer is the resolver's own
   * value, because GET /applications/:id/submission refreshes on read and the client posts back
   * what it was shown. A lookup still answering "Female" while the screen shows "Woman" would read
   * an untouched Save as an edit and stamp a gender she never selected. */
  const stored = question();
  const served = refreshKnownQuestionAnswers(
    [stored], HER_PROFILE, undefined, ROUND, undefined, undefined, AS_OF,
  )[0].answer;

  assert.equal(
    knownAnswerLookup(HER_PROFILE, undefined, undefined, undefined, AS_OF)(stored),
    served,
    'the lookup and the refresh cannot disagree about the value the screen displays',
  );
});

test('the save path settles, so packetQuestionFixpoint never sees an oscillating packet', () => {
  /* Full-record deep equality with an 8-pass ceiling that THROWS, so a snap that fought the
   * resolver every pass would take the whole save down rather than degrade. */
  const settled = savePath([question()]);
  assert.deepEqual(savePath(settled), settled);
  assert.equal(settled[0].answer, 'Woman');
});
