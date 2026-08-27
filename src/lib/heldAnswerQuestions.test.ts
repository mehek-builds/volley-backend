/* The four questions Mercari's Workable form parked on, 2026-08-26, and the lines each rule must
 * not cross. Every label below is read off that live form or is a shape from the same corpus. */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  referralAnswer,
  graduationWindowAnswer,
  monthOrdinal,
} from './heldAnswerQuestions';

const MERCARI_REFERRAL =
  "If your application is a referral from an employee of mercari group, please enter the employee's name. if your application is not a referral, please enter na.";

test('the referral question answers in the token the employer asked for', () => {
  assert.deepEqual(referralAnswer(MERCARI_REFERRAL), { value: 'na' });
  assert.deepEqual(referralAnswer('Referred by (employee name)? If none, please enter N/A'), { value: 'N/A' });
  // No token named: held, not guessed. See the doctrine on the free-text branch.
  assert.equal(referralAnswer('Name of referring employee'), null);
});

test('a closed referral control says no in the employer\'s own wording', () => {
  assert.deepEqual(referralAnswer('Were you referred by a current employee?', ['Yes', 'No']), { value: 'No' });
  assert.deepEqual(referralAnswer('Are you a referral?', ['YES', 'NO']), { value: 'NO' });
  // A list with no negative entry is not a referral yes/no at all.
  assert.equal(referralAnswer('Which employee referred you?', ['Alice', 'Bob']), null);
});

test('it never touches the acquisition-channel question', () => {
  /* "How did you hear about us" is owned by referralSource.ts against her stored default. A
   * referral is only one possible answer there, and answering it "N/A" would discard a true one. */
  assert.equal(referralAnswer('How did you hear about us?'), null);
  assert.equal(referralAnswer('How did you hear about this job? (referral, job board, ...)'), null);
  assert.equal(referralAnswer('Referral source'), null);
  // Compound channel + referrer controls belong to the sibling guard, not to this rule.
  assert.equal(referralAnswer('Where did you first hear about NASA and who referred you?'), null);
  assert.equal(referralAnswer('Where did you learn about Acme who referred you'), null);
});




test('the graduation window is read from the date on file', () => {
  const may2028 = 'May 2028';
  assert.deepEqual(
    graduationWindowAnswer('Are you a student graduating in or after april 2027?', may2028),
    { value: 'Yes' },
  );
  assert.deepEqual(
    graduationWindowAnswer('Are you graduating before April 2027?', may2028),
    { value: 'No' },
  );
  assert.deepEqual(
    graduationWindowAnswer('Will you graduate by December 2026?', may2028),
    { value: 'No' },
  );
  assert.deepEqual(
    graduationWindowAnswer('Are you graduating on or after May 2028?', may2028),
    { value: 'Yes' },
  );
});

test('inclusivity is read from the words rather than assumed', () => {
  // "in or after May 2028" includes her month; a bare "after May 2028" does not.
  assert.deepEqual(graduationWindowAnswer('graduating in or after May 2028?', 'May 2028'), { value: 'Yes' });
  assert.deepEqual(graduationWindowAnswer('graduating after May 2028?', 'May 2028'), { value: 'No' });
  // A bare year with "after" means the following year onward.
  assert.deepEqual(graduationWindowAnswer('graduating after 2027?', 'May 2028'), { value: 'Yes' });
  assert.deepEqual(graduationWindowAnswer('graduating after 2028?', 'May 2028'), { value: 'No' });
});

test('an eligibility gate abstains rather than guess', () => {
  // No date on file, an unreadable date, and a compound window each go back to her.
  assert.equal(graduationWindowAnswer('graduating in or after april 2027?', undefined), null);
  assert.equal(graduationWindowAnswer('graduating in or after spring?', 'May 2028'), null);
  assert.equal(graduationWindowAnswer('graduating after 2026 and before 2028?', 'May 2028'), null);
  // Not a graduation-window question at all.
  assert.equal(graduationWindowAnswer('Did you graduate from an accredited university?', 'May 2028'), null);
});

test('month ordinals parse the spellings forms actually use', () => {
  assert.equal(monthOrdinal('May 2028'), 2028 * 12 + 4);
  assert.equal(monthOrdinal('05/2028'), 2028 * 12 + 4);
  assert.equal(monthOrdinal('2028'), 2028 * 12);
  assert.equal(monthOrdinal('Sept. 2027'), 2027 * 12 + 8);
  assert.equal(monthOrdinal('not a date'), null);
});
