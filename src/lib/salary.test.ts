import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveSalary } from './salary';

test('a stated range in the label fills its median, currency-safe by construction', () => {
  const r = resolveSalary({ label: 'expected salary: USD 90,000 - 110,000', field: 'freetext' }, {});
  assert.equal(r.action, 'fill');
  if (r.action === 'fill') assert.match(r.value, /100,000/);
});

test('a stored bare figure only fills when the currency matches (R-031)', () => {
  const stored = { value: '80000', currency: 'USD' };
  const match = resolveSalary({ label: 'expected salary (USD)', field: 'freetext' }, stored);
  assert.equal(match.action, 'fill');
  const mismatch = resolveSalary({ label: 'expected salary (EUR)', field: 'freetext' }, stored);
  assert.equal(mismatch.action, 'flag');
});

test('a stored bare figure with no detectable posting currency flags rather than guesses', () => {
  const r = resolveSalary({ label: 'expected salary', field: 'freetext' }, { value: '80000', currency: 'USD' });
  assert.equal(r.action, 'flag');
});

test('a stored prose answer always fills a free-text control', () => {
  const r = resolveSalary(
    { label: 'expected salary', field: 'freetext' },
    { value: 'Negotiable, open to your standard intern rate' },
  );
  assert.equal(r.action, 'fill');
});

test('a stored prose answer flags on a numeric-only control rather than mis-typing it', () => {
  const r = resolveSalary(
    { label: 'expected salary', field: 'numeric' },
    { value: 'Negotiable' },
  );
  assert.equal(r.action, 'flag');
});

test('a year-shaped pair is never mistaken for a salary range', () => {
  const r = resolveSalary({ label: 'employment dates 2024-2026', field: 'freetext' }, {});
  assert.equal(r.action, 'flag');
});

test('a range that repeats the currency before the second number is still one range', () => {
  // TixTrack's description, 2026-09-02: "Base annual salary range of $130,000 - $150,000".
  const numeric = resolveSalary(
    { label: 'what are your salary expectations for this position?', field: 'numeric', jdText: 'Base annual salary range of $130,000 - $150,000.' },
    {},
  );
  assert.deepEqual(numeric, { action: 'fill', source: 'jd-range', value: '140000' });
  const text = resolveSalary(
    { label: 'what are your salary expectations for this position?', field: 'freetext', jdText: 'Base annual salary range of $130,000 - $150,000.' },
    {},
  );
  assert.deepEqual(text, { action: 'fill', source: 'jd-range', value: '$140,000' });
  for (const label of ['salary: USD 90,000 to USD 110,000', 'salary $130k - $150k', 'pay range €50.000 - €60.000']) {
    const r = resolveSalary({ label, field: 'freetext' }, {});
    assert.equal(r.action, 'fill', label);
  }
  // A word between the separator and the second number is not a currency and not a range.
  assert.equal(resolveSalary({ label: 'salary 130,000 to the 150,000 band', field: 'freetext' }, {}).action, 'flag');
});
