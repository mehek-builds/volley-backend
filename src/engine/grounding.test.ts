import { test } from 'node:test';
import assert from 'node:assert/strict';
import { numberSignatures, ungroundedNumbers, wordSet, ungroundedProperNouns } from './grounding';

test('a number present in the source is grounded', () => {
  const src = numberSignatures('Handled 40K requests per day across the pipeline');
  assert.deepEqual(ungroundedNumbers('Scaled the service to 40K requests/day', src), []);
});

test('a fabricated metric when the source has no numbers is flagged', () => {
  const src = numberSignatures('Built an internal dashboard for the analytics team');
  assert.deepEqual(ungroundedNumbers('Built a dashboard serving 40K requests/day', src), ['40K']);
});

test('number written differently still matches its source value (40K vs 40,000)', () => {
  const src = numberSignatures('processed 40,000 events');
  assert.deepEqual(ungroundedNumbers('processed 40K events', src), []);
  const src2 = numberSignatures('cut latency by 40K ms');
  assert.deepEqual(ungroundedNumbers('cut latency by 40,000 ms', src2), []);
});

test('percentages and multipliers are checked against source', () => {
  const src = numberSignatures('improved conversion by 25% and cut costs 3x');
  assert.deepEqual(ungroundedNumbers('improved conversion 25%, a 3x gain', src), []);
  assert.deepEqual(ungroundedNumbers('improved conversion 90%', src).length, 1);
});

test('a percentage/multiplier is NOT grounded by a bare count of the same digits', () => {
  // "team of 25" must not license a fabricated "25%"; "3 projects" must not license "3x".
  const src = numberSignatures('Led a team of 25 across 3 projects');
  assert.deepEqual(ungroundedNumbers('Improved conversion by 25%', src), ['25%']);
  assert.deepEqual(ungroundedNumbers('Delivered a 3x speedup', src), ['3x']);
  // ...but a real percentage in the source still grounds the same percentage.
  const src2 = numberSignatures('cut costs by 25%');
  assert.deepEqual(ungroundedNumbers('cut costs 25%', src2), []);
});

test('tech identifiers like S3 / EC2 / GPT-4 are not treated as fabricated metrics', () => {
  const src = numberSignatures('Deployed a service'); // no numbers in source
  // None of these should be flagged as ungrounded numbers.
  assert.deepEqual(ungroundedNumbers('Deployed on AWS S3 and EC2 using GPT-4', src), []);
});

test('bare single digits are ignored (too noisy to be a metric signal)', () => {
  const src = numberSignatures('Worked on a team project');
  assert.deepEqual(ungroundedNumbers('Worked with 2 other engineers', src), []);
});

test('wordSet lowercases, drops stopwords, and keeps content tokens', () => {
  const ws = wordSet('Software Engineer at Google Cloud');
  assert.equal(ws.has('software'), true);
  assert.equal(ws.has('google'), true);
  assert.equal(ws.has('at'), false); // stopword dropped
});

test('ungroundedProperNouns flags multi-word names and acronyms absent from the corpus', () => {
  const corpus = wordSet('I built a payments dashboard at Stripe using Python');
  const out = ungroundedProperNouns('I led a team at Goldman Sachs and used NASA data.', corpus);
  assert.ok(out.includes('Goldman Sachs'));
  assert.ok(out.includes('NASA'));
});

test('ungroundedProperNouns does not flag names that appear in the corpus', () => {
  const corpus = wordSet('Interned at Stripe on the payments team');
  const out = ungroundedProperNouns('At Stripe I owned the payments flow.', corpus);
  assert.deepEqual(out, []);
});
