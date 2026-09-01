import assert from 'node:assert/strict';
import { test } from 'node:test';
import { managedRunStopSummary, previewScreenshotMissingError } from './managedRunStopSummary';

test('a run that never rendered says so, instead of hiding behind the missing preview', () => {
  const { sentence, detail } = managedRunStopSummary({ title: '', url: 'https://x.breezy.hr/p/1', text: '' });
  assert.equal(detail.textLength, 0);
  assert.match(sentence ?? '', /page text 0 chars \(the page never rendered\)/u);
  const error = previewScreenshotMissingError({ title: '', url: 'https://x.breezy.hr/p/1', text: '' });
  assert.match(error.message, /^Stratus managed browser did not return a preview screenshot; the run reported: /u);
  assert.equal(error.stop.detail.url, 'https://x.breezy.hr/p/1');
});

test('blockers, skips, the challenge, the submit outcome and the action outcomes all ride on the sentence', () => {
  const { sentence, detail } = managedRunStopSummary({
    title: 'Apply',
    url: 'https://x.breezy.hr/p/1/apply',
    text: 'form',
    blockers: ['CAPTCHA requires your attention'],
    skipped: ['cover letter: not supported'],
    humanVerification: { kind: 'security_code', fieldCount: 1, sentTo: null },
    submitOutcome: { pressed: false, state: 'not_attempted', message: null },
    requiredFieldConfirmation: { version: 2, status: 'blocked', passes: [] } as never,
    blockedSubmits: 1,
    filledFields: ['name', 'email'],
    actionDiagnostics: [{ outcome: 'filled' }, { outcome: 'filled' }, { outcome: 'refused' }] as never,
  });
  assert.equal(detail.filledFields, 2);
  assert.deepEqual(detail.actionOutcomes, { filled: 2, refused: 1 });
  for (const expected of [
    'blockers: CAPTCHA requires your attention',
    'skipped: cover letter: not supported',
    'human verification: security_code',
    'submit: not pressed, not_attempted',
    'required-field confirmation: blocked',
    'blocked submits: 1',
    'actions: filled 2, refused 1',
    'filled 2, page text 4 chars, title "Apply"',
  ]) assert.ok(sentence?.includes(expected), `${expected} in ${sentence}`);
});

test('the sentence is bounded and never carries page text', () => {
  const { sentence } = managedRunStopSummary({
    title: 'T'.repeat(500),
    url: 'https://x',
    text: 'SECRET PAGE TEXT '.repeat(100),
    blockers: Array.from({ length: 40 }, (_, i) => `blocker number ${i} with a long explanation attached`),
  });
  assert.ok((sentence ?? '').length <= 600);
  assert.equal(sentence?.includes('SECRET PAGE TEXT'), false);
});

test('a null result summarises without throwing', () => {
  const { sentence, detail } = managedRunStopSummary(null);
  assert.equal(detail.blockers.length, 0);
  assert.match(sentence ?? '', /page text 0 chars/u);
});
