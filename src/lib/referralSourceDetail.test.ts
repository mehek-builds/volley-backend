/* The free-text box beside "How did you hear about us?", and the boxes it must never touch.
 *
 * Her declaration is that this box says Litos. The risk that makes it worth a file of its own is
 * not getting the referral box wrong; it is capturing the wrong box. "Please specify" and "if
 * other, please describe" sit beside gender, ethnicity, disability and veteran controls on the same
 * forms, and writing anything into one of those is exactly the EEO self-identification Litos is
 * forbidden to speak for. Every negative case below is a real control shape from the corpus.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveKnownAnswer, type ApplicationProfileLike } from './questionDiscovery';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

const jobBoard: ApplicationProfileLike = { referral_source_default: 'Job board' };

const answerFor = (label: string, ap: ApplicationProfileLike = jobBoard) =>
  resolveKnownAnswer(label, 'text', ap, undefined);

test('the referral detail box is answered Litos', () => {
  // Greenhouse's own wording, read live on Jane Street 2026-08-16.
  assert.deepEqual(answerFor('Additional information (for source)'), { value: 'Litos' });
  assert.deepEqual(answerFor('Additional information for source'), { value: 'Litos' });
  assert.deepEqual(answerFor('If other, please specify how you heard about us'), { value: 'Litos' });
  assert.deepEqual(answerFor('Referral source - additional details'), { value: 'Litos' });
});

test('a bare "please specify" is not claimed by this rule at all', () => {
  /* null, not a value and not even a hold: the rule must not recognise a specify box that does not
   * say what it is specifying. Whatever answers this label, it is not the referral detail rule. */
  assert.equal(answerFor('If other, please specify'), null);
});

test('"Please specify your referral source" is still held by the compound-question guard', () => {
  /* Documented rather than fixed. siblingQuestionRefusal classifies this phrasing as a compound
   * referral question and refuses it before this rule is reached, so the box stays empty - exactly
   * as it did before this change, so no regression. Reordering a refusal that exists to stop Litos
   * answering two questions with one value is not something to do on the way past; if this wording
   * shows up on a real board it needs its own look at parseSiblingQuestion. */
  const held = answerFor('Please specify your referral source');
  assert.ok(held && 'skipReason' in held);
});

test('it never speaks for an EEO or personal free-text box', () => {
  /* THE WHOLE POINT OF THE FILE. Each of these is a "please specify" beside a control only she may
   * answer, and a looser regex reaches every one of them. */
  for (const label of [
    'If you selected self-describe, please specify your pronouns',
    'If other, please specify your gender',
    'Please specify your race/ethnicity',
    'If you selected other, please describe your disability',
    'Veteran status - if other, please specify',
    'Please specify your preferred name',
    'If yes, please provide further explanation below',
    'Please describe your visa status',
  ]) {
    const answer = answerFor(label);
    assert.notDeepEqual(answer, { value: 'Litos' }, label);
  }
});

test('it is relayed from her stored source, not asserted for everyone', () => {
  // No stored job-board default means she has not declared this, and a constant would be the
  // generated claim selfDeclaration.ts forbids.
  assert.notDeepEqual(answerFor('Additional information (for source)', {}), { value: 'Litos' });
  assert.notDeepEqual(
    answerFor('Additional information (for source)', { referral_source_default: 'LinkedIn' }),
    { value: 'Litos' },
  );
});

test('the choice control itself is still the referral question, not the detail box', () => {
  // referralAnswer must decline the detail label, or the prose box would be handed the closed
  // choice's answer and the choice would be left blank.
  const choice = resolveKnownAnswer('How did you hear about us?', 'select', jobBoard, undefined);
  assert.notDeepEqual(choice, { value: 'Litos' });
});

/* THE TARGET THE QUESTION NAMES, when it is this posting written in more than one word.
 *
 * Palantir's Lever form, live 2026-08-16: "HOW DID YOU HEAR ABOUT THIS INTERNSHIP OPPORTUNITY?"
 * came back held while Greenhouse's "How did you hear about us?" resolved in the same run. The
 * target patterns allowed exactly one noun after the determiner, and "this internship opportunity"
 * is two, so it fell through to the employer check and failed it.
 */
test('a multi-word generic target is still this posting', () => {
  for (const label of [
    'HOW DID YOU HEAR ABOUT THIS INTERNSHIP OPPORTUNITY?',
    'How did you hear about this job opportunity?',
    'How did you become aware of this internship opportunity?',
    'Where did you find this job posting?',
    // The single-noun forms that already worked must keep working.
    'How did you hear about us?',
    'How did you hear about this role?',
  ]) {
    assert.deepEqual(resolveKnownAnswer(label, 'select', jobBoard, undefined), { value: 'Job board' }, label);
  }
});

test('widening the target does not answer a question scoped to someone else', () => {
  /* The safety boundary, and the reason the noun list is closed. Any word outside it means the
   * target is not plainly this posting, and the question goes back to employer validation - which
   * fails closed with no packet employer. */
  for (const label of [
    'How did you hear about this role at Palantir?',
    'How did you hear about our CEO?',
    'How did you hear about this event?',
    'How did you hear about our diversity program at Stanford?',
  ]) {
    const answer = resolveKnownAnswer(label, 'select', jobBoard, undefined);
    assert.notDeepEqual(answer, { value: 'Job board' }, label);
  }
});

test('an open-source question is never mistaken for the referral detail box', () => {
  /* SHIPPED WRONG on 2026-08-16 and caught by review the next day. The predicate matched the bare
   * word "source" after a "please describe"-shaped opener, so an employer asking about her
   * open-source work was answered "Litos". parseReferralQuestion has guarded this exact hazard from
   * the start with a `source code` exclusion; this predicate runs earlier and had none. */
  for (const label of [
    'Please describe your open source contributions',
    'Please specify your open source experience',
    'Tell us about your open source work - additional details',
    'Please describe your source code management experience',
    'List the open-source projects you maintain, please specify',
  ]) {
    assert.notDeepEqual(answerFor(label), { value: 'Litos' }, label);
  }
});

test('a qualified source phrase is still the referral detail box', () => {
  assert.deepEqual(answerFor('Please specify your application source'), { value: 'Litos' });
  assert.deepEqual(answerFor('Recruiting source - additional information'), { value: 'Litos' });
});
