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
import { declineWordingForControl, isDeclineToState } from './selfIdentification';
import { chooseClosestOption, resolveProfileField } from './profileFieldResolution';
import type { ApplicationProfileLike } from './questionDiscovery';

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
