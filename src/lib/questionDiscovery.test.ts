import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyField,
  eeoAnswer,
  fitToBudget,
  isOpenEndedQuestion,
  isRefusedQuestion,
  resolveKnownAnswer,
  WORK_ELIGIBILITY_QUESTION,
} from './questionDiscovery';

// The single most important guarantee this module carries over from the extension: these
// questions are NEVER answered, regardless of what the stored profile holds. See R-004 in the
// extension's generic.ts - a false legal declaration shipped on a live application the one time
// this was gotten wrong.
test('never answers work-authorization or sponsorship questions', () => {
  const labels = [
    'are you legally authorized to work in the United States?',
    'will you now or in the future require sponsorship for employment visa status?',
    'do you require visa sponsorship to work in the US?',
  ];
  for (const label of labels) {
    assert.equal(isRefusedQuestion(label), true, label);
    assert.equal(classifyField(label), null, label);
    // Never a *value* - it may come back as a skip reason (surfaced to the human, holds
    // auto-submit) but resolveKnownAnswer must never return `{ value }` for one of these.
    const resolved = resolveKnownAnswer(label, 'text', { citizenship: 'Indian', address_country: 'UAE' }, undefined);
    assert.equal(resolved === null || 'skipReason' in resolved, true, label);
  }
});

test('never answers EEO / demographic questions', () => {
  const labels = ['what is your gender?', 'are you hispanic or latino?', 'veteran status'];
  for (const label of labels) {
    assert.equal(isRefusedQuestion(label), true, label);
    assert.equal(classifyField(label), null, label);
  }
});

test('never answers SSN or driver license fields', () => {
  assert.equal(isRefusedQuestion('social security number'), true);
  assert.equal(isRefusedQuestion("driver's license number"), true);
});

test('citizenship is answered but never substituted for residence', () => {
  assert.equal(classifyField('country of citizenship'), 'citizenship');
  assert.equal(classifyField('which country do you currently reside in?'), 'address_country');
  const resolved = resolveKnownAnswer('country of citizenship', 'text', { citizenship: 'Indian' }, undefined);
  assert.deepEqual(resolved, { value: 'India' });
});

test('a location-commitment question is never answered from a stored city (R-039)', () => {
  const label = 'this role is in-office three days a week, can you commit to that?';
  assert.equal(classifyField(label), null);
  assert.equal(resolveKnownAnswer(label, 'text', { address_city: 'Dubai' }, undefined), null);
});

test('duration beats start date on an ambiguous "availab" label (R-014)', () => {
  assert.equal(classifyField('length or term/length of availability'), 'availability_term');
  assert.equal(classifyField('when can you start?'), 'availability_date');
});

test('a bare salary figure only fills when the posting currency matches the stored one (R-031)', () => {
  const ap = { desired_salary: '80000', desired_salary_currency: 'USD' };
  const usd = resolveKnownAnswer('expected salary (USD)', 'text', ap, undefined);
  assert.ok(usd && 'value' in usd);
  const eur = resolveKnownAnswer('expected salary (EUR)', 'text', ap, undefined);
  assert.ok(eur && 'skipReason' in eur, 'a currency mismatch must flag, never convert');
});

test('a stated range in the label fills its median regardless of stored value', () => {
  const resolved = resolveKnownAnswer('desired salary (e.g. USD 90,000 - 110,000)', 'text', {}, undefined);
  assert.ok(resolved && 'value' in resolved);
  assert.match((resolved as { value: string }).value, /100,000/);
});

test('eeoAnswer is exact-match-only, never a near-miss (R-018)', () => {
  assert.equal(eeoAnswer('Male'), 'Male');
  assert.equal(eeoAnswer(undefined), 'Decline to self-identify');
});

test('isOpenEndedQuestion recognizes prose asks and rejects short field labels', () => {
  assert.equal(isOpenEndedQuestion('Why do you want to work here?'), true);
  assert.equal(isOpenEndedQuestion('Tell us about a project you are proud of'), true);
  assert.equal(isOpenEndedQuestion('First Name'), false);
  assert.equal(isOpenEndedQuestion('LinkedIn URL'), false);
});

test('a link question resolves via classifyField, so callers never reach the essay drafter', () => {
  // isOpenEndedQuestion is a lone-standing heuristic (a "share" verb fires it here, same as the
  // extension's own copy), and by design it does NOT know about classifyField - see the
  // extension's comment on isOpenEndedQuestion: "Callers must ALSO check that the label maps to
  // no profile field". The real guarantee lives in call ORDER: discoverAndResolveQuestions in
  // submissionRunner.ts always tries resolveKnownAnswer first and only falls through to the
  // drafter when it returns null, so a resolvable link question never reaches isOpenEndedQuestion
  // in practice, even though the predicate alone would fire on this label.
  const label = 'please share a link to your GitHub';
  assert.equal(classifyField(label), 'github_url');
  const resolved = resolveKnownAnswer(label, 'text', { github_url: 'https://github.com/example' }, undefined);
  assert.deepEqual(resolved, { value: 'https://github.com/example' });
});

test('fitToBudget clips to a whole sentence, never mid-word, and returns null when none fits (R-029)', () => {
  const text =
    'I built a real-time data pipeline at Acme that cut p99 latency by 40%. It cut latency by 40%. This is a fragment';
  assert.equal(fitToBudget(text, 1000), text);
  const clipped = fitToBudget(text, 80);
  assert.equal(clipped, 'I built a real-time data pipeline at Acme that cut p99 latency by 40%.');
  // Under the ~40-char floor a "sentence" is almost certainly a fragment of the first clause, not
  // a real answer - a blank flagged for the student beats a confident non-answer.
  assert.equal(fitToBudget('Yes. This is a fragment', 6), null);
  assert.equal(fitToBudget('short', 3), null);
});

test('an unclassifiable, non-essay label resolves to nothing rather than a guess', () => {
  assert.equal(resolveKnownAnswer('First Name', 'text', {}, undefined), null);
  assert.equal(isOpenEndedQuestion('First Name'), false);
});

test('WORK_ELIGIBILITY_QUESTION does not fire on unrelated "sponsor" mentions', () => {
  // A bare `sponsor` match previously classified "How did you hear about us? [..., Sponsored ad]"
  // as a work-eligibility question - see the extension's own comment on this regex.
  assert.equal(WORK_ELIGIBILITY_QUESTION.test('how did you hear about us? (LinkedIn, Sponsored ad, ...)'), false);
});
