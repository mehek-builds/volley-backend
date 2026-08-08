import test from 'node:test';
import assert from 'node:assert/strict';
import {
  answerReuseScope,
  companyNameTokens,
  labelNamesCompany,
  reusableAnswersToStore,
  savedAnswerFor,
  savedAnswerKey,
} from './answerReuse';

/* Every label in this file is verbatim from the production run of 2026-08-08 unless it is marked
 * as a constructed sibling. The point of the file is the LINE between the two directions, so each
 * test asserts both sides of it rather than one. */

const EXPORT_CONTROL = 'Astranis complies with U.S. Government space technology export regulations, including the International Traffic in Arms Regulations (ITAR). Are you a U.S. person as defined by these regulations?';
const FAIRE_TEAM = 'Based on the team descriptions above, which opening would you be most interested in contributing to?';
const POINT72_LOCATION = 'What is your preferred work location?';
const DRW_RATING = 'Please rate your skill level in C++';
const DRW_SETTINGS = 'In which settings have you used C++? Select all that apply';
const TRUVETA_SPONSORSHIP = 'Do you now OR in the future require visa sponsorship to continue working in the US? We are unable to sponsor work visas.';

test('a declaration about the applicant carries to the next posting', () => {
  for (const label of [EXPORT_CONTROL, DRW_RATING, DRW_SETTINGS, TRUVETA_SPONSORSHIP]) {
    assert.equal(answerReuseScope(label), 'reusable', label.slice(0, 50));
  }
  // Constructed siblings of the same class, so a narrow regex cannot pass this file by accident.
  assert.equal(answerReuseScope('Please rate your skill level in Python'), 'reusable');
  assert.equal(answerReuseScope('What are your SAT scores?'), 'reusable');
  assert.equal(answerReuseScope('Have you served in the military?'), 'reusable');
  assert.equal(answerReuseScope('What are your personal pronouns?'), 'reusable');
});

test('an answer about THIS posting never carries to another', () => {
  for (const label of [FAIRE_TEAM, POINT72_LOCATION]) {
    assert.equal(answerReuseScope(label), 'posting_specific', label.slice(0, 50));
  }
  assert.equal(answerReuseScope('Which team would you like to join?'), 'posting_specific');
  assert.equal(answerReuseScope('Why do you want to work here?'), 'posting_specific');
  assert.equal(answerReuseScope('Rank the offices below in order of preference'), 'posting_specific');
  assert.equal(answerReuseScope('What interests you about this role?'), 'posting_specific');
  assert.equal(answerReuseScope('How did you hear about this job?'), 'posting_specific');
});

test('a question that names the employer stays with that employer', () => {
  const label = 'Have you previously applied to work at Point72?';
  assert.equal(answerReuseScope(label, { company: 'Point72' }), 'posting_specific');
  // And with no company on the packet at all: the prior-application question is per-employer
  // whether or not the label managed to name anybody, so "Have you applied to us before?" is held
  // back too. A "No" given to a firm she has never approached must not be replayed at one she
  // applied to last month.
  assert.equal(answerReuseScope('Have you applied to us before?'), 'posting_specific');
  assert.equal(answerReuseScope('Have you previously applied with Akuna in the past?'), 'posting_specific');
});

test('the employer veto reads the distinctive part of the name, not its suffixes', () => {
  assert.deepEqual(companyNameTokens('Akuna Capital LLC'), ['akuna']);
  assert.deepEqual(companyNameTokens('Tower Research Capital'), ['tower']);
  assert.ok(labelNamesCompany('Why Akuna?', 'Akuna Capital'));
  // "capital" alone must not flag every question at every fund as naming the employer.
  assert.ok(!labelNamesCompany('What is your desired capital allocation?', 'Akuna Capital'));
});

test('posting-scoped wording beats the declaration test, whichever order they appear in', () => {
  // Both true at once: a self-rating that is scoped to this posting's stack. The veto wins, which
  // is the asymmetry the whole module is built on.
  assert.equal(
    answerReuseScope('Please rate your skill level with the tools listed above for this role'),
    'posting_specific',
  );
});

test('the question key survives punctuation and keeps C, C++ and C# apart', () => {
  assert.equal(savedAnswerKey('Please rate your skill level in C++'), savedAnswerKey('Please rate your skill level in C++:'));
  assert.equal(savedAnswerKey('Please rate your skill level in C++*'), savedAnswerKey('please rate your skill level in c++'));
  assert.notEqual(savedAnswerKey('Please rate your skill level in C++'), savedAnswerKey('Please rate your skill level in C'));
  assert.notEqual(savedAnswerKey('Please rate your skill level in C#'), savedAnswerKey('Please rate your skill level in C++'));
});

test('only the answers that carry are written to the store', () => {
  const stored = reusableAnswersToStore([
    { question: EXPORT_CONTROL, answer: 'Yes' },
    { question: DRW_RATING, answer: 'Advanced' },
    { question: FAIRE_TEAM, answer: 'Payments' },
    { question: POINT72_LOCATION, answer: 'New York' },
    { question: DRW_SETTINGS, answer: 'Coursework, personal projects' },
    // A blank is not an answer and is not remembered as one.
    { question: 'What are your SAT scores?', answer: '   ' },
  ], { company: 'DRW' });
  assert.deepEqual(
    stored.map((item) => item.answer).sort(),
    ['Advanced', 'Coursework, personal projects', 'Yes'],
  );
});

test('the read side re-checks the scope against the employer asking now', () => {
  const saved = new Map([
    [savedAnswerKey(EXPORT_CONTROL), 'Yes'],
    [savedAnswerKey('Have you applied to us before?'), 'No'],
    [savedAnswerKey('Please rate your skill level in C++'), 'Advanced'],
  ]);
  assert.equal(savedAnswerFor(EXPORT_CONTROL, saved, { company: 'Anduril' }), 'Yes');
  assert.equal(savedAnswerFor(DRW_RATING, saved, { company: 'Jane Street' }), 'Advanced');
  // Stored under a per-employer question, so it is never handed back however it got in there.
  assert.equal(savedAnswerFor('Have you applied to us before?', saved, { company: 'Akuna Capital' }), undefined);
  // Nothing stored for this one.
  assert.equal(savedAnswerFor(POINT72_LOCATION, saved, { company: 'Point72' }), undefined);
});

test('the default is posting-specific, so an unrecognised question is asked again rather than replayed', () => {
  assert.equal(answerReuseScope('What is your favourite trade of the last year?'), 'posting_specific');
  assert.equal(answerReuseScope(''), 'posting_specific');
  assert.equal(reusableAnswersToStore([{ question: 'Anything at all', answer: 'something' }]).length, 0);
});
