import assert from 'node:assert/strict';
import test from 'node:test';
import { monitoredDescriptionHash, monitoredJdAgrees } from './monitoredPortalRepair';

const canonical = `${'Customer discovery, product analytics, and SQL. '.repeat(8)}Ship a product end to end with engineers.`;
const legacyPreview = canonical.slice(0, 420);

test('canonical description hash agrees with generated packet hash', () => {
  assert.equal(monitoredJdAgrees(monitoredDescriptionHash(canonical), 'different stored review text', canonical), true);
});

test('legacy preview agrees only when the stored hash belongs to that preview', () => {
  assert.equal(monitoredJdAgrees(monitoredDescriptionHash(legacyPreview), legacyPreview, canonical), true);
});

test('legacy preview prefix cannot bypass a mismatched generated packet hash', () => {
  assert.equal(monitoredJdAgrees(monitoredDescriptionHash('different job text'), legacyPreview, canonical), false);
});

test('same hash is not enough when legacy text is not a canonical prefix', () => {
  const nonPrefix = `${legacyPreview.slice(20)} unrelated ending`;
  assert.equal(monitoredJdAgrees(monitoredDescriptionHash(nonPrefix), nonPrefix, canonical), false);
});
