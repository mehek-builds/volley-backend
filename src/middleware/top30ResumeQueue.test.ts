import assert from 'node:assert/strict';
import test from 'node:test';
import { LIMITS } from './quota';

test('the hourly resume allowance can prepare the top 30 daily matches with retry headroom', () => {
  assert.ok(LIMITS.perHour.resume >= 30);
  assert.ok(LIMITS.pro.monthlyResumes >= 30);
});
