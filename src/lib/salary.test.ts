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
