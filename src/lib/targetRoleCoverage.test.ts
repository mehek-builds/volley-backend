import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MINIMUM_MATCHES_PER_TARGET_ROLE,
  ZERO_RESULT_ROLE_SAMPLE_LIMIT,
  summarizeTargetRoleCoverage,
} from './targetRoleCoverage';

test('reports distinct user-entered roles that return zero current board titles', () => {
  const result = summarizeTargetRoleCoverage(
    ['Software Engineer', 'software   engineer', 'Product Designer', 'Marine Biologist'],
    ['Senior Software Engineer', 'Product Designer II'],
  );
  assert.equal(MINIMUM_MATCHES_PER_TARGET_ROLE, 1);
  assert.equal(result.distinct_target_roles, 3);
  assert.equal(result.covered_target_roles, 2);
  assert.equal(result.zero_result_target_roles, 1);
  assert.equal(result.zero_result_share, 0.333);
  assert.equal(result.coverage_threshold_met, false);
  assert.deepEqual(result.zero_result_role_samples, ['marine biologist']);
});

test('an empty target population is healthy and zero safe', () => {
  const result = summarizeTargetRoleCoverage([], ['Software Engineer']);
  assert.equal(result.distinct_target_roles, 0);
  assert.equal(result.zero_result_share, 0);
  assert.equal(result.coverage_threshold_met, true);
});

test('zero-result samples are bounded while the full count remains visible', () => {
  const roles = Array.from({ length: ZERO_RESULT_ROLE_SAMPLE_LIMIT + 3 }, (_, index) => `Role ${index}`);
  const result = summarizeTargetRoleCoverage(roles, []);
  assert.equal(result.zero_result_target_roles, roles.length);
  assert.equal(result.zero_result_role_samples.length, ZERO_RESULT_ROLE_SAMPLE_LIMIT);
  assert.equal(result.sample_truncated, true);
});
