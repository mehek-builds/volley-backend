/* DECLINING TO ANSWER AND SAYING NONE OF THEM DESCRIBE YOU ARE DIFFERENT STATEMENTS.
 *
 * The whole file is the confusable pair, because that is the only fixture that can win here. An
 * EEO control routinely offers BOTH:
 *
 *   "I decline to self-identify"                   a refusal: she is not answering
 *   "I do not identify with any of the above"      a claim: she answered, and the answer is none
 *
 * They are one word apart and mean opposite things, and two call sites act on the difference.
 * declineWordingForControl rewrites anything read as a refusal into the control's own opt-out
 * spelling, so reading the second as a refusal REPLACES her claim with a refusal she did not make.
 * chooseEeoOption selects the sole matching option as a stand-in refusal, so on a list carrying the
 * second and no true opt-out it asserts on her behalf that none of the listed categories describe
 * her.
 *
 * The pre-existing test on this predicate asserted only the AFFIRMATIVE shape, "I identify as one
 * or more of the classifications of protected veteran listed above", which never matched. The
 * negated shape is the one that did.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  declineWordingForControl,
  isDeclineToState,
  selfIdentificationPolarClaimOption,
} from './selfIdentification';
import { chooseClosestOption, chooseEeoOption, resolveProfileField } from './profileFieldResolution';
import { refreshKnownQuestionAnswers, type ApplicationProfileLike } from './questionDiscovery';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

/* EVERY REFUSAL WORDING THIS REPO HAS RECORDED FROM A REAL CONTROL, plus the ones its own comments
 * name as examples. All 18 must keep matching: the fix must not buy correctness on the claims by
 * quietly losing the opt-outs, which is the failure direction that leaves a control blank. */
const REFUSALS = [
  'Decline to self-identify',
  'Decline To Self Identify',
  'I decline to self-identify for protected veteran status',
  "I don't wish to answer",
  'I do not want to answer',
  'I do not wish to answer',
  'I do not wish to self-identify',
  'Prefer not to say',
  'Prefer not to answer',
  'I prefer not to disclose',
  'I choose not to disclose',
  'I would rather not say',
  'I would not like to disclose this',
  'I decline to answer',
  'I decline',
  'No answer',
  'Not specified',
  'Undisclosed',
];

/* THE ADVERSARY. Each is a SUBSTANTIVE answer, and the first seven were read as refusals before
 * this change. They are written out rather than generated because each one is a real option
 * vocabulary an EEO block uses. */
const CLAIMS = [
  'I do not identify with any of the above',
  'I don’t identify with any of the above',
  'I do not identify with any of these categories',
  'I do not identify as having a disability',
  'I do not identify as transgender',
  'I choose not to identify with any of the above',
  'I prefer not to identify with any of the above',
  'None of the above',
  'I am not a protected veteran',
  'I identify as one or more of the classifications of protected veteran listed above',
  'No, I do not have a disability and have not had one in the past',
  'Asian',
  'White',
  'Female',
  'Yes',
  'No',
];

describe('the predicate itself', () => {
  test('every recorded refusal is still recognised', () => {
    for (const wording of REFUSALS) {
      assert.equal(isDeclineToState(wording), true, `refusal must still match: ${wording}`);
    }
  });

  test('no substantive claim is read as a refusal', () => {
    for (const wording of CLAIMS) {
      assert.equal(isDeclineToState(wording), false, `claim must not be read as a refusal: ${wording}`);
    }
  });

  test('the pair that differs by one word resolves opposite ways', () => {
    // The single assertion this file exists for, stated on its own so a failure names it.
    assert.equal(isDeclineToState('I decline to self-identify'), true);
    assert.equal(isDeclineToState('I do not identify with any of the above'), false);
  });

  test('volition is what separates them, not the negation', () => {
    /* "do not" says nothing about willingness, so it needs a volition verb. "prefer not" and
     * "choose not" are themselves volitional. This is the rule, asserted as a rule. */
    assert.equal(isDeclineToState('I do not wish to disclose'), true);
    assert.equal(isDeclineToState('I do not disclose'), false);
    assert.equal(isDeclineToState('I prefer not to say'), true);
    assert.equal(isDeclineToState('I do not say'), false);
  });

  /* THE THREE WORDINGS THE TWO RUNTIMES DISAGREED ON, pinned here so the next drift fails a suite
   * instead of a spot check. Found while aligning the stratus-browser-cloud copy of this predicate
   * against this one: read out of both shipped sources and compared on one table, these were the
   * only three of 21 wordings where the answers differed.
   *
   * Both causes were silent because both failed in the SAFE direction. A refusal misread as a claim
   * leaves the control blank and surfaces a line to the applicant; it does not assert anything she
   * did not say. So nothing in the corpus ever came back wrong, only unanswered.
   */
  test('a refusal survives the apostrophe the keyboard actually produced', () => {
    /* The backtick and the acute accent are not apostrophes in Unicode, but they sit on the
     * apostrophe key across common layouts and portals receive them typed for one. Uncollapsed they
     * became a SPACE, so "don`t" compared as "don t" and matched no volitional branch. */
    assert.equal(isDeclineToState('I don`t wish to answer'), true, 'backtick U+0060');
    assert.equal(isDeclineToState('I don´t wish to answer'), true, 'acute accent U+00B4');
    // The straight and curly forms already worked and must stay working.
    assert.equal(isDeclineToState("I don't wish to answer"), true);
    assert.equal(isDeclineToState('I don’t wish to answer'), true);
    /* And collapsing them buys nothing on the claim side: "dont" is still not followed by a volition
     * verb, so the confusable pair this file exists for stays resolved the way it was. */
    assert.equal(isDeclineToState('I don`t identify with any of the above'), false);
    assert.equal(isDeclineToState('I don´t identify with any of the above'), false);
  });

  test('a refusal survives the bare stem of an irregular verb', () => {
    /* `wish` takes -es, so `wishes? not` parsed as "wishe" plus an optional "s" and matched the
     * inflected form while missing the bare one a person types. Its neighbours are regular verbs
     * where `s?` is correct, which is why the one irregular stem read as right for as long as it
     * did. Both forms are asserted so a repair of either direction cannot drop the other. */
    assert.equal(isDeclineToState('I wish not to answer'), true, 'bare stem');
    assert.equal(isDeclineToState('I wishes not to answer'), true, 'inflected');
    assert.equal(isDeclineToState('She wishes not to disclose'), true);
    // The same shape on the regular neighbours, which were never broken and must not become so.
    assert.equal(isDeclineToState('I want not to answer'), true);
    assert.equal(isDeclineToState('She prefers not to say'), true);
    assert.equal(isDeclineToState('She chooses not to disclose'), true);
  });
});

describe('what the predicate is used for', () => {
  test('a claim is never rewritten into the control opt-out spelling', () => {
    /* declineWordingForControl's own comment says it is "a substitution of one refusal for the same
     * refusal, never of a refusal for a statement". This asserts that sentence. */
    const label = 'are you hispanic/latino? hispanic_ethnicity';
    const claim = 'I do not identify with any of the above';
    assert.equal(declineWordingForControl(label, claim), claim, 'her claim must survive unrewritten');
    // And a genuine refusal is still respelled in the control's own vocabulary, which is the
    // behaviour this function exists for and which must not be lost.
    assert.notEqual(declineWordingForControl(label, 'Decline to self-identify'), '');
  });

  test('a race list offering the claim and no opt-out does not select the claim', () => {
    /* THE FIXTURE THAT CAN WIN. chooseEeoOption picks the sole option it reads as a decline. With
     * the claim misread, this list has exactly one, so it was selected: Litos asserting on her
     * behalf that no listed category describes her. Her stored answer is not on this list at all. */
    const stored: ApplicationProfileLike = { eeo_prefs: { race: 'South Asian' } };
    const options = ['White', 'Black or African American', 'I do not identify with any of the above'];
    const resolved = resolveProfileField(
      { label: 'please select your racial/ethnic background', inputType: 'select', options },
      stored,
    );
    assert.notEqual(
      resolved?.value,
      'I do not identify with any of the above',
      'a claim must never stand in as her refusal',
    );
  });

  test('and a list offering a REAL opt-out still uses it', () => {
    // The other direction, so the test above cannot be satisfied by breaking the opt-out entirely.
    const stored: ApplicationProfileLike = { eeo_prefs: { race: 'South Asian' } };
    const options = ['White', 'Black or African American', 'I decline to self-identify'];
    const resolved = resolveProfileField(
      { label: 'please select your racial/ethnic background', inputType: 'select', options },
      stored,
    );
    assert.equal(resolved?.value, 'I decline to self-identify');
  });

  test('a list offering BOTH keeps the refusal and never the claim', () => {
    /* The real shape of a modern EEO block: both strings on one list. Before the fix this read as
     * two declines and chooseEeoOption failed closed, so the bug was masked exactly where it was
     * most visible. Now there is one decline, and it is the right one. */
    const options = [
      'White',
      'Asian',
      'I do not identify with any of the above',
      'I decline to self-identify',
    ];
    const stored: ApplicationProfileLike = { eeo_prefs: { race: 'Prefer not to say' } };
    const resolved = resolveProfileField(
      { label: 'please select your racial/ethnic background', inputType: 'select', options },
      stored,
    );
    assert.equal(resolved?.value, 'I decline to self-identify');
  });

  test('the generic option matcher is untouched by any of this', () => {
    // chooseClosestOption has no decline rung; asserted so a future edit here cannot silently
    // borrow one.
    assert.equal(chooseClosestOption(['Yes'], ['Yes', 'No']), 'Yes');
    assert.equal(chooseClosestOption(['South Asian'], ['White', 'Asian']), null);
  });
});

/* THE OTHER DIRECTION OF THE SAME MISTAKE: A REFUSAL STANDING IN FOR A STATED ANSWER.
 *
 * Everything above is about not reading a claim as a refusal. This block is about not ANSWERING
 * with a refusal when she stated something, which is the failure the same stage produces from the
 * other side, and it is silent where the first one is visible: the option is selected, the resolver
 * reports matchedOption, and nothing is surfaced to her.
 *
 * Every option list below is verbatim from a control measured on 2026-09-03. eeo_prefs for the
 * owner account holds veteran_status "No" and disability_status "No", and neither of those two
 * words appears on either employer's list.
 */
const OWNER_EEO_PREFS: ApplicationProfileLike = {
  eeo_prefs: {
    race: 'South Asian',
    gender: 'Female',
    veteran_status: 'No',
    disability_status: 'No',
    sexual_orientation: 'Heterosexual',
    transgender_status: 'No',
  },
};

// Verkada, greenhouse, packet f1b2df5a.
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
/* Zeus Fire and Security, breezy, packet f04623c3. The employer writes the veteran block in caps,
 * and the three radios share name="eeoc.veteran_status" - which is why the label discovery stores
 * for this control is the FIRST option's own text rather than a question. */
const BREEZY_VETERAN = [
  'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN LISTED ABOVE',
  'I AM NOT A PROTECTED VETERAN',
  "I DON'T WISH TO ANSWER",
];
const BREEZY_VETERAN_LABEL = 'I IDENTIFY AS ONE OR MORE OF THE CLASSIFICATIONS OF PROTECTED VETERAN LISTED ABOVE';
const BREEZY_DISABILITY = [
  'Yes, I have a disability, or have had one in the past',
  "No, I don't have a disability",
  "I don't wish to answer",
];

describe('a stated answer is never answered with a refusal', () => {
  test('a stored "No" reaches the sentence the control uses to say no', () => {
    /* MEASURED before this rule existed: both of these returned the list's opt-out, because "No" is
     * in CLOSED_SET_ANSWER_RE so no option may extend it, and the stage below the ladder picks the
     * sole option that reads as a refusal. The disability list lost even earlier - its refusal is
     * spelled "I do not want to answer", which is a DECLINE_WORDINGS entry byte for byte, so the
     * ladder's own exact pass took it. */
    assert.equal(chooseEeoOption('Veteran Status', 'No', VERKADA_VETERAN), 'I am not a protected veteran');
    assert.equal(
      chooseEeoOption('Disability Status', 'No', VERKADA_DISABILITY),
      'No, I do not have a disability and have not had one in the past',
    );
    // The same two questions in the other employer's wording, including the shouted one.
    assert.equal(chooseEeoOption(BREEZY_VETERAN_LABEL, 'No', BREEZY_VETERAN), 'I AM NOT A PROTECTED VETERAN');
    assert.equal(
      chooseEeoOption('Voluntary Self-Identification of Disability', 'No', BREEZY_DISABILITY),
      "No, I don't have a disability",
    );
  });

  test('and the affirmative sentence is never what a stored "No" reaches', () => {
    // The failure direction that would put a claim she did not make on a live application.
    for (const [label, options] of [
      ['Veteran Status', VERKADA_VETERAN],
      [BREEZY_VETERAN_LABEL, BREEZY_VETERAN],
      ['Disability Status', VERKADA_DISABILITY],
      ['Voluntary Self-Identification of Disability', BREEZY_DISABILITY],
    ] as const) {
      const chosen = chooseEeoOption(label, 'No', options);
      assert.equal(/^(?:yes|i identify as one or more)/i.test(chosen ?? ''), false, `${label}: ${chosen}`);
    }
  });

  test('a stored "Yes" reaches the affirmative and nothing else', () => {
    /* Both directions, so the rule cannot be satisfied by a table that only ever says no. The
     * profile below is not the owner's; it exists to assert that an applicant who IS a protected
     * veteran gets her own answer rather than the opt-out. */
    assert.equal(
      chooseEeoOption('Veteran Status', 'Yes', VERKADA_VETERAN),
      'I identify as one or more of the classifications of a protected veteran',
    );
    assert.equal(
      chooseEeoOption('Disability Status', 'Yes', VERKADA_DISABILITY),
      'Yes, I have a disability, or have had one in the past',
    );
  });

  test('a stored refusal still reaches the refusal, on the same lists', () => {
    // The behaviour the new stage sits in front of, asserted so it cannot be lost to it.
    assert.equal(chooseEeoOption('Veteran Status', 'Decline to self-identify', VERKADA_VETERAN), "I don't wish to answer");
    assert.equal(chooseEeoOption('Disability Status', 'Prefer not to say', VERKADA_DISABILITY), 'I do not want to answer');
  });

  test('the measured hyphen case binds, end to end, and reports a match', () => {
    /* The Verkada hispanic control. The stored answer is the resolver's constant
     * "Decline to self-identify" and the list carries "Decline To Self Identify": one hyphen and
     * two capitals apart. comparableOption has always folded both, and this pins that it still
     * does AND that the resolver says so, because matchedOption false is what makes the runner
     * mint "none of the options match your saved answer". */
    const resolved = resolveProfileField(
      { label: 'Are you Hispanic/Latino?', inputType: 'select', options: ['Yes', 'No', 'Decline To Self Identify'] },
      OWNER_EEO_PREFS,
    );
    assert.equal(resolved?.value, 'Decline To Self Identify');
    assert.equal(resolved?.matchedOption, true);
  });

  test('a lone affirmative option answers nothing at all', () => {
    /* THE STALE BREEZY SNAPSHOT, and the honest outcome for it. Discovery read this control before
     * stratus-browser-cloud walked the same-name peers (fixed there 2026-09-01), so the packet's
     * field_options held ONE option for a three-radio group: the affirmative claim, and no denial
     * and no opt-out. There is nothing on this list she can truthfully be given, so the question
     * comes back to her. It must not be the affirmative, and there is no refusal to fall back to. */
    assert.equal(chooseEeoOption(BREEZY_VETERAN_LABEL, 'No', [BREEZY_VETERAN_LABEL]), null);
    assert.equal(
      chooseEeoOption('Voluntary Self-Identification of Disability', 'No', ['Yes, I have a disability, or have had one in the past']),
      null,
    );
  });

  test('the polar rule refuses an ambiguous list and never picks a refusal', () => {
    // Two options state the same denial: there is nothing left to rank them by, so it declines.
    assert.equal(
      selfIdentificationPolarClaimOption('Veteran Status', 'No', ['I am not a protected veteran', 'I am not a veteran']),
      null,
    );
    /* An opt-out that happens to spell out the subject is still an opt-out. Without the refusal
     * guard this wording satisfies the denial pattern's own shape on some lists. */
    assert.equal(
      selfIdentificationPolarClaimOption('Veteran Status', 'No', ["I don't wish to answer", 'I decline to self-identify for protected veteran status']),
      null,
    );
  });

  test('the polar rule never fires on a question that is not a yes or a no', () => {
    /* Gender and race are deliberately absent from the table: neither is a polar question, and a
     * polar rule for them could only invent a category. Asserted as a rule so a later edit that
     * adds one fails here. */
    assert.equal(selfIdentificationPolarClaimOption('Gender', 'Female', ['Male', 'Female']), null);
    assert.equal(selfIdentificationPolarClaimOption('Race', 'South Asian', ['Asian', 'White']), null);
    // And a stored answer that is already a sentence belongs to the ordinary matcher, not this one.
    assert.equal(
      selfIdentificationPolarClaimOption('Veteran Status', 'I am not a protected veteran', VERKADA_VETERAN),
      null,
    );
  });
});

/* THE REFRESH IS THE OTHER HALF, AND WITHOUT IT NONE OF THE ABOVE REACHES AN EMPLOYER.
 *
 * refreshKnownQuestionAnswers recomputes every known answer on packet rebuild, from the profile and
 * with no option list in hand, and overwrites the stored one unless a branch proves it current.
 * MEASURED on 2026-09-03 by running it over the shapes the packets actually hold: all three snapped
 * self-identification answers were replaced with the profile's own wording, which is a string the
 * control does not offer. That is the dashboard row reading ANSWERED with nothing selected.
 */
describe('a snapped self-identification answer survives the rebuild', () => {
  const refreshed = (row: Record<string, string>): string => {
    const [out] = refreshKnownQuestionAnswers([row as never], OWNER_EEO_PREFS, undefined, undefined);
    return (out as { answer: string }).answer;
  };

  test('the employer spelling of a refusal is kept, not rewritten to hers', () => {
    assert.equal(
      refreshed({
        question: 'Are you Hispanic/Latino?',
        answer: 'Decline To Self Identify',
        answer_option_source: 'Decline to self-identify',
      }),
      'Decline To Self Identify',
    );
    /* AND THE CASE-ONLY SPELLING, which is the shape that parked application 6de82956 and the one a
     * comparableOption-based "is there anything to preserve" guard silently drops: these two strings
     * fold to the same key, so such a guard reads "nothing moved" about the row that moved. The
     * guard is a byte comparison for this reason and this assertion is what holds it there. */
    assert.equal(
      refreshed({
        question: 'Do you identify as a member of the LGBTQIA community?',
        answer: 'Decline To Self-Identify',
        answer_option_source: 'Decline to self-identify',
      }),
      'Decline To Self-Identify',
    );
  });

  test('the sentence that states a stored "No" is kept', () => {
    assert.equal(
      refreshed({ question: 'Veteran Status', answer: 'I am not a protected veteran', answer_option_source: 'No' }),
      'I am not a protected veteran',
    );
    assert.equal(
      refreshed({
        question: 'Disability Status',
        answer: 'No, I do not have a disability and have not had one in the past',
        answer_option_source: 'No',
      }),
      'No, I do not have a disability and have not had one in the past',
    );
    // The gender equivalence too, which is the same shape on the Hudson River Trading control.
    assert.equal(refreshed({ question: 'Gender', answer: 'Woman', answer_option_source: 'Female' }), 'Woman');
  });

  test('a REFUSAL recorded against a stated answer is not kept', () => {
    /* The one thing this branch must never do. A packet written before the stage above existed can
     * carry the opt-out beside a snap claim of "No", and preserving it would freeze the exact
     * substitution the rest of this file exists to prevent. It recomputes instead, and the next
     * resolution against a real option list produces the denial. */
    assert.equal(
      refreshed({ question: 'Veteran Status', answer: "I don't wish to answer", answer_option_source: 'No' }),
      'No',
    );
  });

  test('a derivation the profile has moved past is not kept', () => {
    // She corrected her answer after the snap, so the record is stale and is overwritten, exactly
    // as every other family's stale record is. This is what keeps the profile the source of truth.
    assert.equal(
      refreshed({ question: 'Veteran Status', answer: 'I am not a protected veteran', answer_option_source: 'Yes' }),
      'No',
    );
  });

  test('an answer with no recorded snap is not kept', () => {
    // Absent answer_option_source means "cannot prove this is current", which is the same reading
    // storedOptionAnswerIsCurrent takes and for the same reason.
    assert.equal(refreshed({ question: 'Veteran Status', answer: 'I am not a protected veteran' }), 'No');
  });
});
