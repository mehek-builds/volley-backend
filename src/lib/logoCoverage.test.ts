import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logoCoverageFloor, MINIMUM_LOGO_COVERAGE } from './logoCoverage';

test('logo coverage can never be configured below 75 percent', () => {
  assert.equal(MINIMUM_LOGO_COVERAGE, 0.75);
  assert.equal(logoCoverageFloor(undefined), 0.75);
  assert.equal(logoCoverageFloor('0.55'), 0.75);
  assert.equal(logoCoverageFloor('invalid'), 0.75);
});

test('logo coverage may be raised but never above 100 percent', () => {
  assert.equal(logoCoverageFloor('0.8'), 0.8);
  assert.equal(logoCoverageFloor('2'), 1);
});
