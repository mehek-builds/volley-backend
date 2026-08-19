import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  accountSponsorshipAnswer,
  declarationFromEmployerAnswers,
  isAuthorizationQuestion,
  isSponsorshipQuestion,
  yesNo,
} from './declarationFromEmployerAnswers';

/* Building a work-eligibility declaration out of what an employer asked.
 *
 * The measured case for this: across 318 real packets, 39.9% ask BOTH the authorization and the
 * sponsorship question, so for two in five students the work-visa screen is asking again what the
 * application already asked. This turns those answers into the account's declaration for that
 * posting's country so the screen can be skipped.
 *
 * Every case below is really about the same rule: a record is built only when the answers SUPPORT
 * one. Everything else returns null and the student is asked directly, because a guessed
 * declaration is a false legal statement made on her behalf. */

const AUTH = 'Are you legally authorized to work in the United States?';
const SPON = 'Will you now or in the future require sponsorship for employment visa status?';

describe('reading the two questions', () => {
  test('it recognises the authorization and sponsorship families', () => {
    assert.equal(isAuthorizationQuestion(AUTH), true);
    assert.equal(isSponsorshipQuestion(SPON), true);
    assert.equal(isAuthorizationQuestion('What is your cumulative GPA?'), false);
    assert.equal(isSponsorshipQuestion('How did you hear about us?'), false);
  });

  test('only a clean yes or no is read as an answer', () => {
    assert.equal(yesNo('Yes'), true);
    assert.equal(yesNo('no'), false);
    // A refusal to declare must never become a declaration.
    assert.equal(yesNo('Decline to answer'), null);
    assert.equal(yesNo('Prefer not to say'), null);
    assert.equal(yesNo(''), null);
    assert.equal(yesNo('It depends on the role'), null);
  });
});

describe('when a record may be built', () => {
  test('both questions, both answered cleanly, gives a complete record', () => {
    const record = declarationFromEmployerAnswers(
      [{ question: AUTH, answer: 'Yes' }, { question: SPON, answer: 'Yes' }],
      'US',
    );
    assert.ok(record);
    assert.equal(record.country_code, 'US');
    assert.equal(record.authorized_now, true);
    // Authorized now means no sponsorship needed now, by definition of being authorized.
    assert.equal(record.needs_sponsorship_now, false);
    assert.equal(record.needs_sponsorship_future, true);
  });

  test('the F-1 OPT shape: authorized now, sponsorship later', () => {
    const record = declarationFromEmployerAnswers(
      [{ question: AUTH, answer: 'Yes' }, { question: 'Will you in the future require sponsorship?', answer: 'Yes' }],
      'US',
    );
    assert.deepEqual(
      { a: record?.authorized_now, n: record?.needs_sponsorship_now, f: record?.needs_sponsorship_future },
      { a: true, n: false, f: true },
    );
  });

  test('needing nothing is recorded as needing nothing', () => {
    const record = declarationFromEmployerAnswers(
      [{ question: AUTH, answer: 'Yes' }, { question: SPON, answer: 'No' }],
      'US',
    );
    assert.equal(record?.needs_sponsorship_now, false);
    assert.equal(record?.needs_sponsorship_future, false);
    assert.equal(accountSponsorshipAnswer(record!), 'no');
  });

  test('the account answer follows sponsorship needed ANYWHERE, because the board filter is account-wide', () => {
    const future = declarationFromEmployerAnswers(
      [{ question: AUTH, answer: 'Yes' }, { question: SPON, answer: 'Yes' }],
      'US',
    );
    assert.equal(accountSponsorshipAnswer(future!), 'yes');
  });
});

describe('when it must refuse', () => {
  test('one question alone is never enough', () => {
    /* A sponsorship answer sets at most two of three booleans. Filling the third from nothing is
       the false-declaration failure this module exists to avoid. */
    assert.equal(declarationFromEmployerAnswers([{ question: SPON, answer: 'Yes' }], 'US'), null);
    assert.equal(declarationFromEmployerAnswers([{ question: AUTH, answer: 'Yes' }], 'US'), null);
  });

  test('an unreadable answer refuses rather than guesses', () => {
    assert.equal(
      declarationFromEmployerAnswers(
        [{ question: AUTH, answer: 'Yes' }, { question: SPON, answer: 'Decline to answer' }],
        'US',
      ),
      null,
    );
  });

  test('no country means no record, because eligibility is per country', () => {
    const answers = [{ question: AUTH, answer: 'Yes' }, { question: SPON, answer: 'No' }];
    assert.equal(declarationFromEmployerAnswers(answers, null), null);
    assert.equal(declarationFromEmployerAnswers(answers, 'unknown'), null);
    assert.equal(declarationFromEmployerAnswers(answers, ''), null);
  });

  test('an incoherent pair refuses instead of writing something the schema rejects', () => {
    // Not authorized now and not needing sponsorship now is a combination the stored schema bans.
    assert.equal(
      declarationFromEmployerAnswers(
        [{ question: AUTH, answer: 'No' }, { question: 'Will you in the future require sponsorship?', answer: 'No' }],
        'US',
      ),
      null,
    );
  });

  test('not authorized and needing sponsorship now is a real, storable answer', () => {
    const record = declarationFromEmployerAnswers(
      [{ question: AUTH, answer: 'No' }, { question: SPON, answer: 'Yes' }],
      'GB',
    );
    assert.equal(record?.authorized_now, false);
    assert.equal(record?.needs_sponsorship_now, true);
    assert.equal(accountSponsorshipAnswer(record!), 'yes');
  });
});
