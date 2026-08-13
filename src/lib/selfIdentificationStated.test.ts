/* STATING AN ANSWER AND REFUSING TO STATE ONE ARE DIFFERENT ACTS, AND ONLY SHE DECIDES WHICH.
 *
 * The applicant said, on 2026-08-13: "my answer is no. I have never had a disability, nor have I
 * ever been a veteran." Her stored eeo_prefs held "Decline to self-identify" on both, which she
 * never chose; it is what an unanswered self-identification field defaults to.
 *
 * Storing the answer she actually gave is not enough on its own, and the reason is measured rather
 * than argued. Before this change, a stated answer on either control did NOT come back unmatched.
 * It came back as a refusal, in BOTH directions:
 *
 *   veteran_status     "No"   ->  "I decline to self-identify for protected veteran status"
 *   disability_status  "No"   ->  "I do not want to answer"
 *   veteran_status     "Yes"  ->  "I decline to self-identify for protected veteran status"
 *   disability_status  "Yes"  ->  "I do not want to answer"
 *
 * because chooseClosestOption correctly refuses to read "No" as "I am not a protected veteran" and
 * "Yes" as "Yes, I have a disability, or have had one in the past" (each option adds a claim the
 * bare answer did not make), and eeoAnswerLadder then continued into DECLINE_WORDINGS, one of which
 * each list does carry. So the applicant states an answer and a refusal is submitted in her name,
 * which is the same substitution declineWordingForControl forbids in the other direction.
 *
 * THE HARM IS SYMMETRIC, WHICH IS WHY THIS FILE IS. Someone who says she DOES have a disability, or
 * IS a protected veteran, has exactly the same right not to have that replaced by a refusal she
 * never made. So every behavioural assertion below runs over both controls AND both answers.
 *
 * THE OPTION LISTS ARE MEASURED, NOT GUESSED. Option text is not persisted with a packet
 * (optionBand.ts says so outright), so they were recovered on 2026-08-13 from the discovery
 * signature, where managed discovery concatenates a select's option text onto the label blob.
 * Across 2968 recorded questions the corpus holds exactly ONE distinct option list per control, 75
 * recorded instances each, and both signatures are complete and untruncated:
 *
 *   "veteran statusselect ...i identify as one or more of the classifications of protected veteran
 *    listed abovei am not a protected veterani decline to self-identify for protected veteran
 *    status eeo[veteran]"
 *   "disability statusselect ...yes, i have a disability, or have had one in the pastno, i do not
 *    have a disability and have not had one in the pasti do not want to answer eeo[disability]"
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  declineWordingForControl,
  isDeclineToState,
  isStatedSelfIdentification,
  isStatedSelfIdentificationAffirmative,
  isStatedSelfIdentificationNegative,
  selfIdentificationAffirmativeWording,
  selfIdentificationNegativeWording,
  selfIdentificationStatedWording,
  statedSelfIdentification,
  statedWordingForControl,
} from './selfIdentification';
import { chooseEeoOption, resolveProfileField } from './profileFieldResolution';
import type { ApplicationProfileLike } from './questionDiscovery';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

/* The measured lists, verbatim. "Select ..." is the placeholder the control ships with and is part
 * of what discovery read, so it stays: a matcher that only works once the placeholder is removed
 * is not the matcher that runs. */
const MEASURED_VETERAN_OPTIONS = [
  'Select ...',
  'I identify as one or more of the classifications of protected veteran listed above',
  'I am not a protected veteran',
  'I decline to self-identify for protected veteran status',
];

const MEASURED_DISABILITY_OPTIONS = [
  'Select ...',
  'Yes, I have a disability, or have had one in the past',
  'No, I do not have a disability and have not had one in the past',
  'I do not want to answer',
];

/* The label spellings the corpus actually recorded, all 75 instances of each carrying the handle.
 * The handle is what the vocabulary keys on, so the label is a fixture in its own right. */
const MEASURED_VETERAN_LABEL = 'veteran status veteran_status';
const MEASURED_DISABILITY_LABEL = 'disability status disability_status';

/* Every distinct wording the two controls offer, tabulated per control: the affirmative, the
 * negative, and the opt-out. Each stated column is what the matching stored answer must resolve to,
 * and the opt-out column is what a stored refusal must still resolve to. */
const MEASURED_CONTROLS = [
  {
    control: 'veteran_status',
    label: MEASURED_VETERAN_LABEL,
    options: MEASURED_VETERAN_OPTIONS,
    affirmative: 'I identify as one or more of the classifications of protected veteran listed above',
    negative: 'I am not a protected veteran',
    decline: 'I decline to self-identify for protected veteran status',
  },
  {
    control: 'disability_status',
    label: MEASURED_DISABILITY_LABEL,
    options: MEASURED_DISABILITY_OPTIONS,
    affirmative: 'Yes, I have a disability, or have had one in the past',
    negative: 'No, I do not have a disability and have not had one in the past',
    decline: 'I do not want to answer',
  },
] as const;

/** The two stated answers, as the profile surface stores them. */
const KINDS = [
  { kind: 'negative', stored: 'No' },
  { kind: 'affirmative', stored: 'Yes' },
] as const;

/* Every refusal spelling her packets actually store, counted on 2026-08-13: 111
 * "Decline to self-identify", 33 "I do not want to answer", 32 "I don't wish to answer", 9
 * "I decline to self-identify for protected veteran status". A stated answer in either direction
 * must not make any of them stop working. */
const STORED_DECLINE_SPELLINGS = [
  'Decline to self-identify',
  'I do not want to answer',
  "I don't wish to answer",
  'I decline to self-identify for protected veteran status',
];

function profileWith(veteran: string, disability: string): ApplicationProfileLike {
  // Her real eeo_prefs shape. Race and gender carry values she did choose and must be untouched by
  // anything in this file.
  return {
    eeo_prefs: {
      race: 'South Asian',
      gender: 'Female',
      veteran_status: veteran,
      disability_status: disability,
      sexual_orientation: 'Heterosexual',
      transgender_status: 'Decline to self-identify',
    },
  };
}

describe('the stated-answer predicate', () => {
  test('the six measured stated wordings are recognised, and as the right kind', () => {
    assert.equal(statedSelfIdentification('No'), 'negative');
    assert.equal(statedSelfIdentification('no'), 'negative');
    assert.equal(statedSelfIdentification(' No '), 'negative', 'surrounding space is normalised');
    assert.equal(statedSelfIdentification('Yes'), 'affirmative');
    assert.equal(statedSelfIdentification('yes'), 'affirmative');
    for (const row of MEASURED_CONTROLS) {
      assert.equal(statedSelfIdentification(row.negative), 'negative', row.negative);
      assert.equal(statedSelfIdentification(row.affirmative), 'affirmative', row.affirmative);
    }
    /* THE BOUNDARY, PINNED RATHER THAN WIDENED. comparableOption keeps `.` on purpose, so that
     * "N/A" and "3.5" survive it, which means "No." reduces to "no." and is not recognised here.
     * That is the failing-closed direction and it is left alone: the value can only reach this
     * predicate from a fixed three-way choice on the profile surface, which stores "No" exactly,
     * and inventing punctuation tolerance for an input nobody can produce is how a grammar starts
     * growing. If a free-text path for this field is ever reintroduced, widen it then and with a
     * measurement. */
    assert.equal(statedSelfIdentification('No.'), undefined);
  });

  test('the two kinds never cross', () => {
    // A yes must never read as a no, in either direction, on any measured wording.
    for (const row of MEASURED_CONTROLS) {
      assert.equal(isStatedSelfIdentificationNegative(row.affirmative), false, row.affirmative);
      assert.equal(isStatedSelfIdentificationAffirmative(row.negative), false, row.negative);
    }
    assert.equal(isStatedSelfIdentificationNegative('Yes'), false);
    assert.equal(isStatedSelfIdentificationAffirmative('No'), false);
  });

  test('no refusal is ever read as a stated answer', () => {
    /* The whole point of a separate predicate. If any refusal leaked in here it would suppress the
     * decline fallthrough for a person who actually declined, which is the mirror of the bug. */
    for (const wording of STORED_DECLINE_SPELLINGS) {
      assert.equal(
        statedSelfIdentification(wording),
        undefined,
        `a refusal must not read as a statement: ${wording}`,
      );
    }
    assert.equal(statedSelfIdentification('No answer'), undefined);
    assert.equal(statedSelfIdentification('Prefer not to say'), undefined);
  });

  test('and no stated answer is ever read as a refusal', () => {
    // The same assertion from the other side, on the predicate the decline path is gated on.
    assert.equal(isDeclineToState('No'), false);
    assert.equal(isDeclineToState('Yes'), false);
    for (const row of MEASURED_CONTROLS) {
      assert.equal(isDeclineToState(row.negative), false, `must not read as a refusal: ${row.negative}`);
      assert.equal(isDeclineToState(row.affirmative), false, `must not read as a refusal: ${row.affirmative}`);
    }
  });

  test('AN ABSENT ANSWER IS NOT A STATED ONE, in any shape', () => {
    /* The rule that keeps this whole file from inventing an answer. Nothing empty may acquire a
     * kind, because a kind is what suppresses the decline fallthrough and what selects a board
     * wording, and neither may happen to a person who never answered. */
    for (const empty of [undefined, null, '', '   ', '\t\n']) {
      assert.equal(statedSelfIdentification(empty), undefined, JSON.stringify(empty));
      assert.equal(isStatedSelfIdentification(empty), false, JSON.stringify(empty));
    }
    // And an absent preference still resolves the way it always did, through eeoAnswer's default,
    // which this change does not touch: the decline, never an affirmative and never a negative.
    for (const row of MEASURED_CONTROLS) {
      const resolved = resolveProfileField(
        { label: row.label, inputType: 'text', options: row.options },
        { eeo_prefs: { race: 'South Asian' } },
      );
      assert.equal(resolved?.value, row.decline, `${row.control}: absent must stay absent`);
      assert.notEqual(resolved?.value, row.affirmative);
      assert.notEqual(resolved?.value, row.negative);
    }
  });

  test('a near-miss claim is not a stated answer in either direction', () => {
    /* Narrow on purpose. Everything here would be caught by an open-ended negation or affirmation
     * grammar, and each is a different claim that must not become a yes or a no on a legal form. */
    for (const wording of [
      'I do not identify with any of the above',
      'I do not identify as having a disability',
      'I do not identify as transgender',
      'None of the above',
      'No, I am not able to relocate',
      'Yes - I am authorized to work in the US for any employer',
      'Yes, I require sponsorship',
      'Not specified',
      'Two or More Races',
    ]) {
      assert.equal(statedSelfIdentification(wording), undefined, wording);
    }
  });
});

describe('a stated answer resolves to the option the control offers', () => {
  for (const row of MEASURED_CONTROLS) {
    for (const { kind, stored } of KINDS) {
      const expected = row[kind];

      test(`${row.control}: the measured list answers a stored "${stored}"`, () => {
        assert.equal(chooseEeoOption(row.label, stored, row.options), expected);
      });

      test(`${row.control}: "${stored}" through the whole resolver`, () => {
        const resolved = resolveProfileField(
          { label: row.label, inputType: 'text', options: row.options },
          profileWith(stored, stored),
        );
        assert.equal(resolved?.value, expected);
        assert.equal(resolved?.matchedOption, true);
      });

      test(`${row.control}: an already-respelled "${stored}" still resolves to itself`, () => {
        /* The value round-trips: knownAnswerForLabel writes the control's wording into the packet,
         * so the resolver sees the long form on a re-run and must not treat it as unknown. */
        assert.equal(chooseEeoOption(row.label, expected, row.options), expected);
      });

      test(`${row.control}: "${stored}" is written into the packet in the control's own words`, () => {
        assert.equal(statedWordingForControl(row.label, stored), expected);
        assert.equal(selfIdentificationStatedWording(row.label, kind), expected);
      });

      test(`${row.control}: a stated "${stored}" never becomes a refusal`, () => {
        /* THE FIXTURE THAT CAN WIN, and the exact failure measured before this change. These
         * assertions passed the wrong way round: the ladder ran off the end into DECLINE_WORDINGS
         * and the list's opt-out matched. */
        assert.notEqual(
          chooseEeoOption(row.label, stored, row.options),
          row.decline,
          'her stated answer must not be submitted as a refusal',
        );
        // And on a list that offers a refusal and nothing that can hold a bare answer, the honest
        // outcome is no match at all rather than a refusal chosen on her behalf.
        const otherKind = kind === 'negative' ? row.affirmative : row.negative;
        const notOffered = ['Select ...', otherKind, row.decline];
        assert.equal(chooseEeoOption(row.label, stored, notOffered), null);
        // The same list still answers a genuine refusal, so the guard above cannot be satisfied by
        // breaking the opt-out.
        assert.equal(chooseEeoOption(row.label, 'Decline to self-identify', notOffered), row.decline);
      });

      test(`${row.control}: a stated "${stored}" never becomes the OPPOSITE answer`, () => {
        // The failure this pairing exists to make impossible: a yes filed as a no, or the reverse.
        const opposite = kind === 'negative' ? row.affirmative : row.negative;
        assert.notEqual(chooseEeoOption(row.label, stored, row.options), opposite);
        assert.notEqual(statedWordingForControl(row.label, stored), opposite);
      });
    }

    test(`${row.control}: a stored refusal still resolves to the refusal`, () => {
      // No regression. Every spelling her packets hold must still reach the control's opt-out.
      for (const spelling of STORED_DECLINE_SPELLINGS) {
        assert.equal(
          chooseEeoOption(row.label, spelling, row.options),
          row.decline,
          `${spelling} must still resolve to the opt-out on ${row.control}`,
        );
      }
      const resolved = resolveProfileField(
        { label: row.label, inputType: 'text', options: row.options },
        profileWith('Decline to self-identify', 'Decline to self-identify'),
      );
      assert.equal(resolved?.value, row.decline);
      assert.equal(resolved?.matchedOption, true);
    });

    test(`${row.control}: the answers she did choose are untouched`, () => {
      const ap = profileWith('No', 'No');
      const race = resolveProfileField(
        {
          label: 'how would you describe your racial/ethnic background?',
          inputType: 'text',
          options: ['White', 'Asian', 'Black or African American', 'Decline to self-identify'],
        },
        ap,
      );
      assert.equal(race?.value, 'Asian', 'the federal widening of "South Asian" still applies');
      const gender = resolveProfileField(
        { label: 'gender', inputType: 'text', options: ['Female', 'Male', 'Decline to self-identify'] },
        ap,
      );
      assert.equal(gender?.value, 'Female');
    });
  }

  test('the two controls do not answer each other', () => {
    // One profile, two different stated answers, so a vocabulary keyed on the wrong handle shows up.
    const mixed = profileWith('Yes', 'No');
    const veteran = resolveProfileField(
      { label: MEASURED_VETERAN_LABEL, inputType: 'text', options: MEASURED_VETERAN_OPTIONS },
      mixed,
    );
    const disability = resolveProfileField(
      { label: MEASURED_DISABILITY_LABEL, inputType: 'text', options: MEASURED_DISABILITY_OPTIONS },
      mixed,
    );
    assert.equal(veteran?.value, 'I identify as one or more of the classifications of protected veteran listed above');
    assert.equal(disability?.value, 'No, I do not have a disability and have not had one in the past');
  });
});

describe('the vocabulary is keyed on the handle and on nothing else', () => {
  /* EMPLOYER-AUTHORED DEMOGRAPHIC QUESTIONS MUST NOT BE CAUGHT. Their labels end in a numeric
   * question id rather than a handle, their option lists are the employer's own, and the board
   * vocabulary says nothing about them. All six are real labels from the corpus. */
  const EMPLOYER_AUTHORED_LABELS = [
    'do you identify as a military veteran or service member? * 4000409002',
    'are you a person living with a disability? 4000995002',
    'are you a veteran or active member of the united states armed forces? (select one) 4012870007',
    'are you a veteran or active member of the united states armed forces? 4001613008',
    'do you have a disability?* 249',
    'how would you describe your gender identity? (mark all that apply) 4012865007',
  ];

  test('a numeric question id is not a handle, for either answer', () => {
    for (const label of EMPLOYER_AUTHORED_LABELS) {
      assert.equal(selfIdentificationNegativeWording(label), undefined, `negative: ${label}`);
      assert.equal(selfIdentificationAffirmativeWording(label), undefined, `affirmative: ${label}`);
      assert.equal(statedWordingForControl(label, 'No'), 'No', `her own "No" must survive: ${label}`);
      assert.equal(statedWordingForControl(label, 'Yes'), 'Yes', `her own "Yes" must survive: ${label}`);
    }
  });

  test('and such a control is still answered from her own words, either way', () => {
    /* Falling through to today's behaviour is the requirement, not an accident: the employer's own
     * list offers a plain "Yes" and "No", which the ordinary exact-match stage selects without any
     * help from the vocabulary. */
    for (const { stored } of KINDS) {
      const resolved = resolveProfileField(
        {
          label: 'are you a person living with a disability? 4000995002',
          inputType: 'text',
          options: ['Yes', 'No', 'Prefer not to say'],
        },
        profileWith(stored, stored),
      );
      assert.equal(resolved?.value, stored);
      assert.equal(resolved?.matchedOption, true);
    }
  });

  test('a handle must be the whole label or its last word', () => {
    // The same containment rule the decline vocabulary states, asserted for both stated answers.
    assert.equal(selfIdentificationNegativeWording('veteran_status'), 'I am not a protected veteran');
    assert.equal(
      selfIdentificationAffirmativeWording('veteran_status'),
      'I identify as one or more of the classifications of protected veteran listed above',
    );
    for (const label of ['veteran_status_other', 'spouse_veteran_status', 'disability_status_2']) {
      assert.equal(selfIdentificationNegativeWording(label), undefined, label);
      assert.equal(selfIdentificationAffirmativeWording(label), undefined, label);
    }
  });

  test('the three controls without a measured stated wording fall through', () => {
    /* race and gender have neither: their answer is a category. hispanic_ethnicity's stated answers
     * are the literal "Yes" and "No" the exact-match stage already selects. None may acquire a
     * guessed wording. */
    for (const label of ['race', 'gender', 'are you hispanic/latino? hispanic_ethnicity']) {
      assert.equal(selfIdentificationNegativeWording(label), undefined, label);
      assert.equal(selfIdentificationAffirmativeWording(label), undefined, label);
      assert.equal(statedWordingForControl(label, 'No'), 'No', label);
      assert.equal(statedWordingForControl(label, 'Yes'), 'Yes', label);
    }
    // And hispanic_ethnicity still answers both stated answers off its own measured list.
    const hispanic = ['Yes', 'No', 'Decline To Self Identify'];
    assert.equal(chooseEeoOption('are you hispanic/latino? hispanic_ethnicity', 'No', hispanic), 'No');
    assert.equal(chooseEeoOption('are you hispanic/latino? hispanic_ethnicity', 'Yes', hispanic), 'Yes');
    // While a stored refusal on that same list still reaches the unhyphenated spelling, which is
    // the failure the decline vocabulary was built for.
    assert.equal(
      chooseEeoOption('are you hispanic/latino? hispanic_ethnicity', 'Decline to self-identify', hispanic),
      'Decline To Self Identify',
    );
  });

  test('the decline vocabulary is unchanged by any of this', () => {
    assert.equal(
      declineWordingForControl(MEASURED_VETERAN_LABEL, 'Decline to self-identify'),
      "I don't wish to answer",
    );
    assert.equal(
      declineWordingForControl(MEASURED_DISABILITY_LABEL, 'Decline to self-identify'),
      'I do not want to answer',
    );
    // And it still refuses to rewrite a statement, in every direction.
    assert.equal(declineWordingForControl(MEASURED_VETERAN_LABEL, 'No'), 'No');
    assert.equal(declineWordingForControl(MEASURED_VETERAN_LABEL, 'Yes'), 'Yes');
    assert.equal(
      declineWordingForControl(MEASURED_DISABILITY_LABEL, 'I do not identify with any of the above'),
      'I do not identify with any of the above',
    );
  });
});

describe('a control that reports no options', () => {
  test('gets the control wording when the label names the vocabulary', () => {
    /* The common case on a real run: option text is not persisted, so the fill layer sees the
     * packet answer and nothing else. It must already be the string the control offers. */
    for (const row of MEASURED_CONTROLS) {
      for (const { kind, stored } of KINDS) {
        const resolved = resolveProfileField(
          { label: row.label, inputType: 'text' },
          profileWith(stored, stored),
        );
        assert.equal(resolved?.value, row[kind], `${row.control} "${stored}"`);
      }
    }
  });

  test('and keeps her own word when it does not', () => {
    for (const { stored } of KINDS) {
      const resolved = resolveProfileField(
        { label: 'are you a person living with a disability? 4000995002', inputType: 'text' },
        profileWith(stored, stored),
      );
      assert.equal(resolved?.value, stored);
    }
  });
});
