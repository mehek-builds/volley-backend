import assert from 'node:assert/strict';
import { test } from 'node:test';
import { managedRunStopSummary, previewScreenshotMissing } from './managedRunStopSummary';

const DOB = '2005-03-14';
const LABEL = 'question_date:0:2:date of birth';

test('a run that never rendered says so, instead of hiding behind the missing preview', () => {
  const { sentence, detail } = managedRunStopSummary({ title: '', url: 'https://x.breezy.hr/p/1', text: '' });
  assert.equal(detail.textLength, 0);
  assert.match(sentence, /^the page never rendered, none fields filled/u);
  const { error, detail: errorDetail } = previewScreenshotMissing({ title: '', url: 'https://x.breezy.hr/p/1', text: '' });
  assert.match(error.message, /^Stratus managed browser did not return a preview screenshot; the run reported: the page never rendered/u);
  assert.equal(errorDetail.textLength, 0);
  assert.equal(Object.keys(error).length, 0, 'nothing is attached to the error for a serializer to copy');
});

test('the sentence carries states and counts, never a skip sentence, a blocker sentence, a label, a value or the title', () => {
  const result = {
    title: 'Apply at Acme SECRET-TITLE',
    url: 'https://x.breezy.hr/p/1/apply',
    text: 'form',
    blockers: ['CAPTCHA requires your attention'],
    skipped: [`${LABEL}: this control is a date picker and "${DOB}" is not a date Litos can read, left for you`],
    humanVerification: { kind: 'security_code', fieldCount: 1, sentTo: null },
    submitOutcome: { pressed: false, state: 'not_attempted', message: 'SECRET MESSAGE' },
    requiredFieldConfirmation: { version: 2, status: 'blocked', passes: [] } as never,
    blockedSubmits: 1,
    filledFields: ['name', 'email'],
    actionDiagnostics: [{ outcome: 'filled' }, { outcome: 'filled' }, { outcome: 'refused' }, { outcome: DOB }] as never,
  };
  const { sentence, detail } = managedRunStopSummary(result);
  assert.equal(detail.filledFields, 2);
  assert.equal(detail.blockerCount, 1);
  assert.equal(detail.skippedCount, 1);
  assert.deepEqual(detail.actionOutcomes, { filled: 2, refused: 1, other: 1 });
  for (const expected of [
    'the page rendered',
    'several fields filled',
    'one blocker',
    'one answer left for you',
    'a security code challenge',
    'submit not pressed (not attempted)',
    'required-field check blocked',
    'one blocked submit',
    'action outcomes filled/other/refused',
  ]) assert.ok(sentence.includes(expected), `${expected} in ${sentence}`);
  const everything = sentence + JSON.stringify(detail);
  for (const leaked of [DOB, LABEL, 'CAPTCHA requires', 'SECRET', 'breezy.hr', 'date picker']) {
    assert.equal(everything.includes(leaked), false, `${leaked} must not appear`);
  }
});

test('the sentence is the same for two runs that stopped the same way, so they share one fingerprint', () => {
  const a = managedRunStopSummary({ text: 'x'.repeat(100), filledFields: ['a', 'b', 'c'], blockers: ['p', 'q'] });
  const b = managedRunStopSummary({ text: 'y'.repeat(9000), filledFields: ['a', 'b'], blockers: ['r', 's', 't'] });
  assert.equal(a.sentence, b.sentence);
  assert.notEqual(a.detail.textLength, b.detail.textLength);
});

test('a null result summarises without throwing', () => {
  const { sentence, detail } = managedRunStopSummary(null);
  assert.equal(detail.blockerCount, 0);
  assert.equal(sentence, 'the page never rendered, none fields filled');
});
