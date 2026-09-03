import test from 'node:test';
import assert from 'node:assert/strict';

import {
  eeoAnswer,
  eeoSubjectPreferenceKeys,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  selfIdentificationSkipReason,
  questionRequiresHumanAttention,
} from './questionDiscovery';
import { chooseEeoOption, resolveProfileField } from './profileFieldResolution';
import { reopenUnfitClosedChoiceQuestions } from './questionMetadata';
import { packetQuestionFixpoint } from './packetQuestionIdentity';
import { resolveSubmittedApplicationAnswers } from './submittedAnswers';
import type { ApplicationProfileLike } from './questionDiscovery';
import type { ApplicationReviewQuestion } from './applicationReview';

/* AN UNASKED QUESTION IS NOT A REFUSAL.
 *
 * THE DEFECT, reported by the owner and then measured. Her stored profile, read live from
 * GET /profile/application on account a18f774b-a306-4804-93f3-cd6020c27fb3, is PROFILE below. It
 * holds six self-identification subjects and no hispanic or ethnicity key of any kind, because the
 * Settings screen that writes eeo_prefs has no such field. Six live packets across Verkada,
 * Databricks and Flow nonetheless carried an answer to "are you hispanic/latino?", and on two of
 * them answer_source read 'applicant_review', so the packet asserted she had read the refusal and
 * chosen it.
 *
 * Her own words: "all the stored answers are wrong, that's not what i had listed".
 *
 * WHERE IT CAME FROM, measured rather than assumed. resolveKnownAnswer produces the refusal with no
 * option list in hand at all, which excludes every option-matching rule including chooseEeoOption's
 * sole-decline last resort. The whole mechanism was eeoAnswer's absent-value constant, and the two
 * spellings in production are its signature: declineWordingForControl respells it to the greenhouse
 * vocabulary only when the label carries the hispanic_ethnicity handle, and leaves it alone when it
 * does not. Both rows are reproduced below, byte for byte, against origin/main.
 *
 * WHY REFUSING RATHER THAN DERIVING "No" FROM HER RACE. Race and ethnicity are separate axes under
 * the federal taxonomy and a person can be both Hispanic and Asian, so "South Asian" entails
 * nothing about Hispanic origin unless the stored field is provably race-only and provably
 * exclusive. It is neither: the Settings field is labelled "Race / ethnicity" and its list carries
 * "Hispanic or Latino" beside "Asian", so it is a merged single-select, and "South Asian" is not on
 * that list at all, so it was not chosen against it. Deriving a No would write an identity claim
 * she never made, which is the same act as writing the refusal.
 */

const PROFILE = {
  eeo_prefs: {
    race: 'South Asian',
    gender: 'Female',
    veteran_status: 'No',
    disability_status: 'No',
    sexual_orientation: 'Heterosexual',
    transgender_status: 'No',
  },
  pronouns: 'she/her',
  military_service: 'No',
} as unknown as ApplicationProfileLike;

/** Greenhouse's own published list for the hispanic control, quoted in selfIdentification.ts. */
const GREENHOUSE_HISPANIC = ['Yes', 'No', 'Decline To Self Identify'];
const GREENHOUSE_RACE = [
  'American Indian or Alaska Native', 'Asian', 'Black or African American', 'Hispanic or Latino',
  'Native Hawaiian or Other Pacific Islander', 'White', 'Two or More Races',
  'Decline To Self Identify',
];
const GREENHOUSE_GENDER = ['Woman', 'Man', 'Non-binary', "I don't wish to answer"];
/** Verkada, greenhouse, packet f1b2df5a. */
const VERKADA_VETERAN = [
  "I don't wish to answer",
  'I identify as one or more of the classifications of a protected veteran',
  'I am not a protected veteran',
];
const VERKADA_DISABILITY = [
  'I do not want to answer',
  'No, I do not have a disability and have not had one in the past',
  'Yes, I have a disability, or have had one in the past',
];

const HISPANIC_WITH_HANDLE = 'are you hispanic/latino? hispanic_ethnicity';
const HISPANIC_PLAIN = 'are you hispanic/latino?';

function known(label: string, ap: ApplicationProfileLike = PROFILE) {
  return resolveKnownAnswer(label, 'text', ap, undefined);
}

test('the hispanic question has no stored preference, so it is left for her rather than declined', () => {
  for (const label of [HISPANIC_WITH_HANDLE, HISPANIC_PLAIN]) {
    /* The subject ladder is right and the profile simply cannot satisfy it. Asserted rather than
     * assumed so that adding the key later turns this test into the one that says so. */
    assert.deepEqual(
      eeoSubjectPreferenceKeys(label),
      ['hispanic_ethnicity', 'hispanic', 'ethnicity'],
      'the hispanic ladder is already wired and reads hispanic_ethnicity first',
    );
    for (const key of eeoSubjectPreferenceKeys(label)) {
      assert.equal(
        (PROFILE.eeo_prefs as Record<string, string>)[key],
        undefined,
        `her profile holds no ${key}`,
      );
    }

    const resolved = known(label);
    assert.ok(resolved && 'skipReason' in resolved, `${label}: the resolver must refuse`);
    assert.equal(resolved.skipReason, selfIdentificationSkipReason(label));
    /* THE LITERAL PHRASE AS WELL, because the line above compares the function with itself and any
     * implementation satisfies it. attentionCategoriesForReasons files a held question by matching
     * the sentence, so the words are behaviour and not decoration; and "sensitive question" is what
     * ageAttestationSkipReason uses for the same filing, deliberately not borrowed here so the two
     * gaps stay tellable apart on a dashboard row. */
    assert.match(resolved.skipReason, /^self-identification question left for you, because your profile has no saved answer for it: /);
    assert.ok(resolved.skipReason.includes(label.slice(0, 60)), `${label}: names the question`);

    /* THE FILL PATH REFUSES TOO, and with a list that DOES carry exactly one decline, so the sole-
     * decline last resort is reachable in principle and is proved unreachable in fact. */
    assert.equal(
      resolveProfileField(
        { label, inputType: 'select', options: GREENHOUSE_HISPANIC },
        PROFILE,
      ),
      null,
      `${label}: nothing is filled into a question she was never asked`,
    );
  }
});

test('both production spellings of the unrequested hispanic decline are gone', () => {
  /* THE PRE-FIX VALUES, quoted from origin/main so the diff is legible without running it:
   *
   *   "are you hispanic/latino? hispanic_ethnicity"  ->  "Decline To Self Identify"
   *   "are you hispanic/latino?"                     ->  "Decline to self-identify"
   *
   * The handle is what makes them differ, which is why both are pinned: a fix that only stopped one
   * spelling would leave four of the six measured packets untouched. */
  for (const [label, wasProducing] of [
    [HISPANIC_WITH_HANDLE, 'Decline To Self Identify'],
    [HISPANIC_PLAIN, 'Decline to self-identify'],
  ] as const) {
    const resolved = known(label);
    const value = resolved && 'value' in resolved ? resolved.value : null;
    assert.notEqual(value, wasProducing, `${label}: must no longer produce ${wasProducing}`);
    assert.equal(value, null);
  }
});

test('every subject she DID store answers exactly as before, byte for byte', () => {
  /* THE BLAST-RADIUS PIN. The change is only ever allowed to affect a subject with no stored
   * preference, so each of her six is measured on the employer's real list and expected verbatim.
   * A regression here is the change reaching an answer she gave. */
  const cases: Array<{ label: string; options: string[]; resolved: string; filled: string }> = [
    {
      label: 'what is your gender? gender',
      options: GREENHOUSE_GENDER,
      resolved: 'Female',
      filled: 'Woman',
    },
    {
      label: 'what is your race/ethnicity?',
      options: GREENHOUSE_RACE,
      resolved: 'South Asian',
      filled: 'Asian',
    },
    {
      label: 'veteran status veteran_status',
      options: VERKADA_VETERAN,
      resolved: 'No',
      filled: 'I am not a protected veteran',
    },
    {
      label: 'disability status disability_status',
      options: VERKADA_DISABILITY,
      resolved: 'No',
      filled: 'No, I do not have a disability and have not had one in the past',
    },
    {
      label: 'what is your sexual orientation?',
      options: ['Heterosexual', 'Gay', 'Lesbian', 'Bisexual', 'Decline to self-identify'],
      resolved: 'Heterosexual',
      filled: 'Heterosexual',
    },
    {
      label: 'do you identify as transgender?',
      options: ['Yes', 'No', 'Decline to self-identify'],
      resolved: 'No',
      filled: 'No',
    },
  ];
  for (const c of cases) {
    const resolved = known(c.label);
    assert.ok(resolved && 'value' in resolved, `${c.label}: still answered`);
    assert.equal(resolved.value, c.resolved, `${c.label}: resolver value`);
    const filled = resolveProfileField(
      { label: c.label, inputType: 'select', options: c.options },
      PROFILE,
    );
    assert.equal(filled?.value, c.filled, `${c.label}: filled value`);
    assert.equal(filled?.matchedOption, true, `${c.label}: still matches an option`);
  }
});

test('a decline she actually stored is still hers, and is still respelled to the control', () => {
  /* THE LOAD-BEARING NEGATIVE. The Settings screen offers "Decline to self-identify" as a stored
   * value on every self-identification field, which is the whole reason absence cannot mean it. So
   * the decline path must keep working end to end for a decline she selected. */
  const declined = {
    ...PROFILE,
    eeo_prefs: { ...(PROFILE.eeo_prefs as Record<string, string>), race: 'Decline to self-identify' },
  } as unknown as ApplicationProfileLike;

  const resolved = known('what is your race/ethnicity? race', declined);
  assert.ok(resolved && 'value' in resolved);
  // declineWordingForControl still respells it into the board's own vocabulary.
  assert.equal(resolved.value, 'Decline To Self Identify');

  const filled = resolveProfileField(
    { label: 'what is your race/ethnicity? race', inputType: 'select', options: GREENHOUSE_RACE },
    declined,
  );
  assert.equal(filled?.value, 'Decline To Self Identify');
  assert.equal(filled?.matchedOption, true);

  // And a hispanic decline she stores is honoured the moment the key exists, with no other change.
  const withHispanic = {
    ...PROFILE,
    eeo_prefs: { ...(PROFILE.eeo_prefs as Record<string, string>), hispanic_ethnicity: 'No' },
  } as unknown as ApplicationProfileLike;
  const answered = known(HISPANIC_WITH_HANDLE, withHispanic);
  assert.ok(answered && 'value' in answered, 'a stored hispanic answer is answered');
  assert.equal(answered.value, 'No');
  assert.equal(
    resolveProfileField(
      { label: HISPANIC_WITH_HANDLE, inputType: 'select', options: GREENHOUSE_HISPANIC },
      withHispanic,
    )?.value,
    'No',
  );
});

test('a question class with no stored preference is left unanswered rather than declined', () => {
  /* THE GENERALIZATION THE HISPANIC ROW IS ONE INSTANCE OF. eeoSubjectPreferenceKeys returns an
   * empty ladder for these labels, so no key could ever satisfy them, and every one of them was
   * answered with the constant before this change. Each list below carries exactly one decline, so
   * the wrong answer is reachable and is proved not to be taken. */
  const unstored: Array<{ label: string; options: string[] }> = [
    { label: 'what is your age?', options: ['18-24', '25-34', '35-44', 'Prefer not to say'] },
    { label: 'what is your current age?', options: ['Under 20', '20-29', 'I decline to self-identify'] },
    { label: 'do you identify as lgbtq+?', options: ['Yes', 'No', 'Prefer not to say'] },
    {
      label: 'which categories describe you? 4012865007',
      options: ['Asian', 'White', 'I do not wish to answer'],
    },
    { label: HISPANIC_WITH_HANDLE, options: GREENHOUSE_HISPANIC },
  ];
  for (const c of unstored) {
    /* Nothing in her profile can answer it, whether because no ladder claims the label at all or
     * because the ladder that does claim it names keys she has never been asked for. Both are the
     * same fact to the resolver and both used to end in the same manufactured refusal. */
    for (const key of eeoSubjectPreferenceKeys(c.label)) {
      assert.equal(
        (PROFILE.eeo_prefs as Record<string, string>)[key],
        undefined,
        `${c.label}: her profile holds no ${key}`,
      );
    }
    const resolved = known(c.label);
    assert.ok(resolved && 'skipReason' in resolved, `${c.label}: refused`);
    assert.equal(
      resolveProfileField({ label: c.label, inputType: 'radio', options: c.options }, PROFILE),
      null,
      `${c.label}: nothing filled`,
    );
    /* The list really could have produced a refusal, so the negative above is about this change and
     * not about an unreachable branch. */
    assert.notEqual(
      chooseEeoOption(c.label, 'Decline to self-identify', c.options),
      null,
      `${c.label}: a decline IS on this list and would have been selected`,
    );
  }
});

test('an account that never opted in is asked rather than answered for', () => {
  /* eeo_prefs is nullable and "only set if the student explicitly opts in" (db/schema.ts). Before
   * this change every self-identification question on such an account was answered with a refusal
   * nobody had given, which is the reported defect with every key missing instead of one. */
  for (const prefs of [null, {}]) {
    const ap = { pronouns: 'she/her', eeo_prefs: prefs } as unknown as ApplicationProfileLike;
    for (const label of [
      HISPANIC_WITH_HANDLE, 'what is your gender? gender', 'what is your race/ethnicity?',
      'veteran status veteran_status', 'disability status disability_status',
    ]) {
      const resolved = known(label, ap);
      assert.ok(resolved && 'skipReason' in resolved, `${label}: refused on an opt-out account`);
    }
    // Pronouns are a different rule and are untouched: she stored them, so they still answer.
    const pronouns = known('pronouns', ap);
    assert.ok(pronouns && 'value' in pronouns);
    assert.equal(pronouns.value, 'she/her');
  }

  /* A KEY PRESENT BUT EMPTY IS ALSO NOTHING STORED, and it has to be, because that is the shape the
   * Settings screen writes. Its select carries "" as its first option, so clearing a field leaves
   * the key in place holding an empty string; a whitespace-only value is the same fact arriving
   * through the API. Neither is an answer, and neither may become a refusal. */
  for (const blank of ['', '   ', '\t']) {
    const ap = { eeo_prefs: { gender: blank, race: blank } } as unknown as ApplicationProfileLike;
    for (const label of ['what is your gender? gender', 'what is your race/ethnicity?']) {
      const resolved = known(label, ap);
      assert.ok(resolved && 'skipReason' in resolved, `${label}: blank ${JSON.stringify(blank)} is not an answer`);
    }
  }
});

// ---- through the real save path ----

function eeoRow(over: Partial<ApplicationReviewQuestion> & { question: string; answer: string }) {
  return {
    kind: 'required',
    required: true,
    portal_input_type: 'select',
    ...over,
  } as ApplicationReviewQuestion;
}

/** reopen(refresh(...)) under packetQuestionFixpoint, which is what a save actually runs. */
function savePath(rows: ApplicationReviewQuestion[], reviewedAt = '2026-09-01T00:00:00.000Z') {
  return packetQuestionFixpoint(rows, (candidate) => reopenUnfitClosedChoiceQuestions(
    refreshKnownQuestionAnswers(candidate, PROFILE, undefined, reviewedAt),
  ));
}

test('the save path erases the unrequested decline and keeps nothing behind it', () => {
  const rows = [
    eeoRow({
      question: HISPANIC_WITH_HANDLE,
      answer: 'Decline To Self Identify',
      options: GREENHOUSE_HISPANIC,
      answer_option_source: 'Decline to self-identify',
    }),
    eeoRow({
      question: HISPANIC_PLAIN,
      answer: 'Decline to self-identify',
      portal_input_type: 'radio',
      options: ['Yes', 'No', 'Decline to self-identify'],
    }),
  ];
  const out = savePath(rows);
  for (const [i, row] of out.entries()) {
    assert.equal(row.answer, '', `row ${i}: the refusal is gone`);
    /* NOT KEPT AS A DRAFT, and that is deliberate. reopenUnfitClosedChoiceQuestions preserves a
     * removed answer as answer_draft because it was hers; this string never was, so there is
     * nothing to offer back. */
    assert.equal(row.answer_draft, undefined, `row ${i}: no draft of a machine refusal`);
    assert.equal(row.answer_source, undefined, `row ${i}: no provenance survives`);
    assert.equal(row.answer_option_source, undefined, `row ${i}: no snap claim survives`);
    assert.equal(questionRequiresHumanAttention(row), true, `row ${i}: surfaced to her`);
  }
  // The chain settles: a second save is a no-op rather than an oscillation.
  assert.deepEqual(savePath(out), out);
});

test('a row already stamped applicant_review stays frozen, which is the half this does NOT close', () => {
  /* PINNED SO IT IS VISIBLE RATHER THAN ASSUMED, and so a claim that this PR closed the laundering
   * hole cannot be made by accident.
   *
   * Two of the six measured rows carry answer_source 'applicant_review' in the packet's own current
   * review round. refreshKnownQuestionAnswers returns such a row untouched before any recompute
   * (the applicantReviewedCurrentAnswer early return at questionDiscovery.ts), and submittedAnswers
   * freezes the round at `current.questions_reviewed_at ?? now()`, so the round never advances on
   * its own. MEASURED on all three paths a live packet takes: the rebuild keeps it, the fixpoint
   * keeps it, and a save that posts the row back keeps it. Those rows need the review-provenance
   * work now in flight in mergeSubmittedApplicationReviewQuestions, plus a data repair of the six
   * stored rows, and neither is in this diff. */
  const reviewedAt = '2026-09-01T00:00:00.000Z';
  const laundered = eeoRow({
    question: HISPANIC_WITH_HANDLE,
    answer: 'Decline To Self Identify',
    options: GREENHOUSE_HISPANIC,
    answer_source: 'applicant_review',
    answer_reviewed_at: reviewedAt,
  });

  // The packet rebuild, which is what keeps the live rows in place.
  const rebuilt = refreshKnownQuestionAnswers([laundered], PROFILE, undefined, reviewedAt);
  assert.equal(rebuilt[0].answer, 'Decline To Self Identify');
  assert.equal(rebuilt[0].answer_source, 'applicant_review');
  assert.deepEqual(savePath([laundered], reviewedAt), [laundered], 'the fixpoint keeps it too');

  // And a save that posts the same row back, which is what the dashboard does.
  const { questions } = resolveSubmittedApplicationAnswers({
    current: { questions: [laundered], questions_reviewed_at: reviewedAt, jd_text: '' },
    submitted: [laundered],
    profile: PROFILE,
  });
  assert.equal(questions[0].answer, 'Decline To Self Identify');
  assert.equal(questions[0].answer_source, 'applicant_review');

  /* The row NOT carrying that stamp is erased by the same save, so the difference is the stamp and
   * nothing else. Four of the six measured rows are in this state. */
  const machine = eeoRow({
    question: HISPANIC_PLAIN,
    answer: 'Decline to self-identify',
    options: GREENHOUSE_HISPANIC,
  });
  const plain = resolveSubmittedApplicationAnswers({
    current: { questions: [machine], questions_reviewed_at: reviewedAt, jd_text: '' },
    submitted: [machine],
    profile: PROFILE,
  });
  assert.equal(plain.questions[0].answer, '', 'the machine-written refusal is erased');
});

test('a stored answer the control cannot spell is a DIFFERENT defect and is untouched here', () => {
  /* ashby/deepgram holds `race` with an EMPTY answer while "South Asian" is stored, and it is not
   * this defect. The refresh has no option list (ApplicationReviewQuestion carries none), so it
   * returns her raw profile value, and reopenUnfitClosedChoiceQuestions blanks it because no
   * offered option spells it. Her answer survives as answer_draft, which is the tell that separates
   * the two families: this one keeps her words, the hispanic row had none to keep. The fill path
   * resolves the same control correctly to "Asian", so the answer is not lost, only unsynced.
   * Reproduced here so that a future fix to the refresh/re-open composition changes a test that
   * states what the behaviour is rather than one that quietly asserts a blank. */
  const ashbyRace = ['American Indian or Alaska Native', 'Asian', 'Black or African American',
    'Hispanic or Latino', 'Native Hawaiian or Other Pacific Islander', 'White', 'Two or More Races',
    'Decline to self-identify'];
  const [row] = savePath([eeoRow({ question: 'race', answer: 'South Asian', options: ashbyRace })]);
  assert.equal(row.answer, '');
  assert.equal(row.answer_draft, 'South Asian', 'her own answer is kept as the draft');
  assert.equal(
    resolveProfileField({ label: 'race', inputType: 'select', options: ashbyRace }, PROFILE)?.value,
    'Asian',
    'the fill path answers it correctly, so this is a sync defect and not a decline substitution',
  );
});

test('eeoAnswer is the only place a self-identification answer can be made, and absence makes none', () => {
  assert.equal(eeoAnswer(undefined), undefined);
  assert.equal(eeoAnswer(''), undefined);
  assert.equal(eeoAnswer(' \t '), undefined);
  assert.equal(eeoAnswer('South Asian'), 'South Asian');
  assert.equal(eeoAnswer('Decline to self-identify'), 'Decline to self-identify');
});
