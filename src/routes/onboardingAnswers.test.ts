import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { reusableAnswersToStore } from '../lib/answerReuse';

/* What POST /onboarding/answers is allowed to keep.
 *
 * The route is a thin pass to rememberReusableAnswers on purpose, so the rule that matters is the
 * one reusableAnswersToStore applies. These cases pin that rule at the boundary the onboarding
 * screen writes through, because the screen asks employer questions and some of those answers must
 * never become facts about the account. */

describe('what the questions screen may keep', () => {
  test('the store is NARROW, and almost nothing travels between employers', () => {
    /* Corrected after measuring: answerReuseScope defaults every label to posting_specific, so
       "How did you hear about us?" is NOT remembered account-wide. Only an exact standardized test
       score and a placed onsite commitment travel. This is why the questions screen must not
       promise that answers are carried into every application: for almost all of them they are
       not, and the honest destination is the application's own review. */
    assert.deepEqual(reusableAnswersToStore([
      { question: 'How did you hear about us?', answer: 'A friend' },
    ]), []);

    const score = reusableAnswersToStore([{ question: 'What is your SAT score?', answer: '1520' }]);
    assert.equal(score.length, 1, 'an exact standardized score is the one thing that does travel');
  });

  test('a sponsorship declaration is NEVER remembered account-wide', () => {
    /* It is a statement the applicant makes to ONE employer. Replaying it to the next one is the
       class of failure selfDeclaration.ts exists to prevent, and it is why cutting the work-visa
       screen cannot be done by leaning on this store: nothing account-scoped is written here. */
    const stored = reusableAnswersToStore([
      { question: 'Will you now or in the future require sponsorship for employment visa status?', answer: 'Yes' },
    ]);
    assert.deepEqual(stored, []);
  });

  test('an EEO answer is never remembered either', () => {
    const stored = reusableAnswersToStore([
      { question: 'Are you Hispanic/Latino?', answer: 'Decline to self-identify' },
    ]);
    assert.deepEqual(stored, []);
  });

  test('a blank answer is dropped rather than stored as an empty claim', () => {
    // "has not answered" and "answered with nothing" are different, and only the first is true.
    assert.deepEqual(reusableAnswersToStore([{ question: 'How did you hear about us?', answer: '   ' }]), []);
  });

  test('the count the screen reports is what was KEPT, not what was sent', () => {
    /* A screen reporting "2 saved" after storing 1 would be describing a promise it did not keep
       for the declaration the store correctly refused. */
    const submitted = [
      { question: 'What is your SAT score?', answer: '1520' },
      { question: 'Will you now or in the future require sponsorship?', answer: 'Yes' },
    ];
    const stored = reusableAnswersToStore(submitted);
    assert.equal(submitted.length, 2);
    assert.equal(stored.length, 1, 'the declaration must not be stored account-wide');
  });
});

test('work eligibility resolves a job before any answer write', () => {
  const route = readFileSync('src/routes/onboarding.ts', 'utf8');
  const handler = route.slice(
    route.indexOf("fastify.post('/onboarding/answers'"),
    route.indexOf("fastify.post('/onboarding/gaps-asked'"),
  );
  const postingRead = handler.indexOf('await actionPostingRowForUser(parsed.data.job_id, userId)');
  const answerWrite = handler.indexOf('await rememberReusableAnswers(');
  assert.ok(postingRead >= 0);
  assert.ok(answerWrite > postingRead);
  assert.match(handler, /if \(parsed\.data\.job_id && !posting\)/);
  assert.match(handler, /posting\?\.job_country \?\? null/);
  assert.doesNotMatch(handler, /\.from\(monitored_jobs\)/);
});
