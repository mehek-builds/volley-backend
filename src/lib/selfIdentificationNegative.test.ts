/* SAYING NO AND SAYING NOTHING ARE DIFFERENT ANSWERS, AND ONLY ONE OF THEM IS HERS.
 *
 * The applicant said, on 2026-08-13: "my answer is no. I have never had a disability, nor have I
 * ever been a veteran." Her stored eeo_prefs held "Decline to self-identify" on both, which she
 * never chose; it is what an unanswered self-identification field defaults to.
 *
 * Storing the answer she actually gave is not enough on its own, and the reason is measured rather
 * than argued. Before this change, a stored "No" on either control did NOT come back unmatched. It
 * came back as a refusal:
 *
 *   veteran_status     "No"  ->  "I decline to self-identify for protected veteran status"
 *   disability_status  "No"  ->  "I do not want to answer"
 *
 * because chooseClosestOption correctly refuses to read "No" as "I am not a protected veteran"
 * (the option adds a claim the answer did not make), and eeoAnswerLadder then continued into
 * DECLINE_WORDINGS, one of which each list does carry. So the applicant states an answer and a
 * refusal is submitted in her name, which is the same substitution declineWordingForControl
 * forbids in the other direction.
 *
 * THE OPTION LISTS BELOW ARE MEASURED, NOT GUESSED. Option text is not persisted with a packet, so
 * they were recovered on 2026-08-13 from the discovery signature, where managed discovery
 * concatenates a select's option text onto the label blob. Across 2968 recorded questions the
 * corpus holds exactly ONE distinct option list per control, and both are complete:
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
  isStatedSelfIdentificationNegative,
  negativeWordingForControl,
  selfIdentificationNegativeWording,
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

/* The label spellings the corpus actually recorded for each control, all 75 instances of each
 * carrying the handle. The handle is what the vocabulary keys on, so the label is a fixture in its
 * own right and not decoration. */
const MEASURED_VETERAN_LABEL = 'veteran status veteran_status';
const MEASURED_DISABILITY_LABEL = 'disability status disability_status';

/* Every distinct wording the two controls offer, tabulated per control: the affirmative, the
 * negative, and the opt-out. The negative column is what a stored "No" must resolve to, and the
 * opt-out column is what a stored refusal must still resolve to. */
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

/* Every refusal spelling her packets actually store, counted on 2026-08-13: 111
 * "Decline to self-identify", 33 "I do not want to answer", 32 "I don't wish to answer", 9
 * "I decline to self-identify for protected veteran status". A stored negative must not make any
 * of them stop working. */
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

describe('the stated-negative predicate', () => {
  test('the three measured negative wordings are recognised', () => {
    assert.equal(isStatedSelfIdentificationNegative('No'), true);
    assert.equal(isStatedSelfIdentificationNegative('no'), true);
    assert.equal(isStatedSelfIdentificationNegative(' No '), true, 'surrounding space is normalised');
    /* THE BOUNDARY, PINNED RATHER THAN WIDENED. comparableOption keeps `.` on purpose, so that
     * "N/A" and "3.5" survive it, which means "No." reduces to "no." and is not recognised here.
     * That is the failing-closed direction and it is left alone: the value can only reach this
     * predicate from a fixed three-way choice on the profile surface, which stores "No" exactly,
     * and inventing punctuation tolerance for an input nobody can produce is how a negation grammar
     * starts growing. If a free-text path for this field is ever reintroduced, widen it then and
     * with a measurement. */
    assert.equal(isStatedSelfIdentificationNegative('No.'), false);
    for (const row of MEASURED_CONTROLS) {
      assert.equal(
        isStatedSelfIdentificationNegative(row.negative),
        true,
        `the board's own negative must be recognised: ${row.negative}`,
      );
    }
  });

  test('no refusal is ever read as a stated negative', () => {
    /* The whole point of a separate predicate. If any refusal leaked in here it would suppress the
     * decline fallthrough for a person who actually declined, which is the mirror of the bug. */
    for (const wording of STORED_DECLINE_SPELLINGS) {
      assert.equal(
        isStatedSelfIdentificationNegative(wording),
        false,
        `a refusal must not read as a statement: ${wording}`,
      );
    }
    assert.equal(isStatedSelfIdentificationNegative('No answer'), false);
    assert.equal(isStatedSelfIdentificationNegative('Prefer not to say'), false);
  });

  test('and no stated negative is ever read as a refusal', () => {
    // The same assertion from the other side, on the predicate the decline path is gated on.
    assert.equal(isDeclineToState('No'), false);
    for (const row of MEASURED_CONTROLS) {
      assert.equal(isDeclineToState(row.negative), false, `must not read as a refusal: ${row.negative}`);
    }
  });

  test('the affirmative is not a negative, and neither is a near-miss negation', () => {
    /* Narrow on purpose. Everything here would be caught by an open-ended negation grammar, and
     * each one is a different claim that must not be turned into "No" on a legal form. */
    for (const row of MEASURED_CONTROLS) {
      assert.equal(isStatedSelfIdentificationNegative(row.affirmative), false, row.affirmative);
    }
    assert.equal(isStatedSelfIdentificationNegative('Yes'), false);
    assert.equal(isStatedSelfIdentificationNegative('I do not identify with any of the above'), false);
    assert.equal(isStatedSelfIdentificationNegative('I do not identify as having a disability'), false);
    assert.equal(isStatedSelfIdentificationNegative('None of the above'), false);
    assert.equal(isStatedSelfIdentificationNegative('No, I am not able to relocate'), false);
    assert.equal(isStatedSelfIdentificationNegative('Not specified'), false);
  });
});

describe('a stored negative resolves to the option the control offers', () => {
  for (const row of MEASURED_CONTROLS) {
    test(`${row.control}: the measured list answers a stored "No"`, () => {
      assert.equal(chooseEeoOption(row.label, 'No', row.options), row.negative);
    });

    test(`${row.control}: the same answer through the whole resolver`, () => {
      const resolved = resolveProfileField(
        { label: row.label, inputType: 'text', options: row.options },
        profileWith('No', 'No'),
      );
      assert.equal(resolved?.value, row.negative);
      assert.equal(resolved?.matchedOption, true);
    });

    test(`${row.control}: an already-respelled negative still resolves to itself`, () => {
      /* The value round-trips: knownAnswerForLabel writes the control's wording into the packet, so
       * the resolver sees the long form on a re-run and must not treat it as an unknown string. */
      assert.equal(chooseEeoOption(row.label, row.negative, row.options), row.negative);
    });

    test(`${row.control}: the packet answer is written in the control's own words`, () => {
      assert.equal(negativeWordingForControl(row.label, 'No'), row.negative);
      assert.equal(selfIdentificationNegativeWording(row.label), row.negative);
    });

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

    test(`${row.control}: a stated negative never becomes a refusal`, () => {
      /* THE FIXTURE THAT CAN WIN, and the exact failure measured before this change. Both of these
       * assertions passed the wrong way round: the ladder ran off the end into DECLINE_WORDINGS and
       * the list's opt-out matched. */
      assert.notEqual(
        chooseEeoOption(row.label, 'No', row.options),
        row.decline,
        'her stated answer must not be submitted as a refusal',
      );
      // And on a list that offers a refusal and nothing that can hold a plain "No", the honest
      // outcome is no match at all rather than a refusal chosen on her behalf.
      const noNegativeOffered = ['Select ...', row.affirmative, row.decline];
      assert.equal(chooseEeoOption(row.label, 'No', noNegativeOffered), null);
      // The same list still answers a genuine refusal, so the guard above cannot be satisfied by
      // breaking the opt-out.
      assert.equal(
        chooseEeoOption(row.label, 'Decline to self-identify', noNegativeOffered),
        row.decline,
      );
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

  test('a numeric question id is not a handle', () => {
    for (const label of EMPLOYER_AUTHORED_LABELS) {
      assert.equal(
        selfIdentificationNegativeWording(label),
        undefined,
        `employer-authored label must name no vocabulary: ${label}`,
      );
      assert.equal(
        negativeWordingForControl(label, 'No'),
        'No',
        `her own wording must survive on: ${label}`,
      );
    }
  });

  test('and such a control is still answered from her own words', () => {
    /* Falling through to today's behaviour is the requirement, not an accident: the employer's own
     * list offers a plain "No", which the ordinary exact-match stage selects without any help from
     * the vocabulary. */
    const resolved = resolveProfileField(
      {
        label: 'are you a person living with a disability? 4000995002',
        inputType: 'text',
        options: ['Yes', 'No', 'Prefer not to say'],
      },
      profileWith('No', 'No'),
    );
    assert.equal(resolved?.value, 'No');
    assert.equal(resolved?.matchedOption, true);
  });

  test('a handle must be the whole label or its last word', () => {
    // The same containment rule the decline vocabulary states, asserted for the negative one.
    assert.equal(selfIdentificationNegativeWording('veteran_status'), 'I am not a protected veteran');
    assert.equal(selfIdentificationNegativeWording('veteran_status_other'), undefined);
    assert.equal(selfIdentificationNegativeWording('spouse_veteran_status'), undefined);
    assert.equal(selfIdentificationNegativeWording('disability_status_2'), undefined);
  });

  test('the three controls without a measured negative fall through', () => {
    /* race and gender have no negative at all, and hispanic_ethnicity's negative is the literal
     * "No" the exact-match stage already selects. None of them may acquire a guessed wording. */
    for (const label of ['race', 'gender', 'are you hispanic/latino? hispanic_ethnicity']) {
      assert.equal(selfIdentificationNegativeWording(label), undefined, label);
      assert.equal(negativeWordingForControl(label, 'No'), 'No', label);
    }
    // And hispanic_ethnicity still answers a stored "No" off its own measured list.
    assert.equal(
      chooseEeoOption(
        'are you hispanic/latino? hispanic_ethnicity',
        'No',
        ['Yes', 'No', 'Decline To Self Identify'],
      ),
      'No',
    );
    // While a stored refusal on that same list still reaches the unhyphenated spelling, which is
    // the failure the decline vocabulary was built for.
    assert.equal(
      chooseEeoOption(
        'are you hispanic/latino? hispanic_ethnicity',
        'Decline to self-identify',
        ['Yes', 'No', 'Decline To Self Identify'],
      ),
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
    // And it still refuses to rewrite a statement, in either direction.
    assert.equal(declineWordingForControl(MEASURED_VETERAN_LABEL, 'No'), 'No');
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
      const resolved = resolveProfileField(
        { label: row.label, inputType: 'text' },
        profileWith('No', 'No'),
      );
      assert.equal(resolved?.value, row.negative);
    }
  });

  test('and keeps her own word when it does not', () => {
    const resolved = resolveProfileField(
      { label: 'are you a person living with a disability? 4000995002', inputType: 'text' },
      profileWith('No', 'No'),
    );
    assert.equal(resolved?.value, 'No');
  });
});
