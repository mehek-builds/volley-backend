import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MINIMUM_MATCHES_PER_TARGET_ROLE,
  summarizeTargetRoleCoverage,
  targetRoleCoverageFromCounts,
  unavailableTargetRoleCoverage,
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
  assert.equal('zero_result_role_samples' in result, false, 'literal user input is not copied into monitoring');
});

test('database aggregate counts produce the same zero-result coverage contract', () => {
  assert.deepEqual(targetRoleCoverageFromCounts(4, 3), {
    distinct_target_roles: 4,
    covered_target_roles: 3,
    zero_result_target_roles: 1,
    zero_result_share: 0.25,
    minimum_matches_per_target_role: 1,
    coverage_threshold_met: false,
    measurement_available: true,
  });
  assert.equal(targetRoleCoverageFromCounts(0, 0).coverage_threshold_met, true);
  assert.equal(targetRoleCoverageFromCounts(2, 9).covered_target_roles, 2);
});

test('an empty target population is healthy and zero safe', () => {
  const result = summarizeTargetRoleCoverage([], ['Software Engineer']);
  assert.equal(result.distinct_target_roles, 0);
  assert.equal(result.zero_result_share, 0);
  assert.equal(result.coverage_threshold_met, true);
});

test('monitoring remains aggregate-only when many literal roles have zero results', () => {
  const roles = Array.from({ length: 23 }, (_, index) => `Identifying role ${index}`);
  const serialized = JSON.stringify(summarizeTargetRoleCoverage(roles, []));
  assert.doesNotMatch(serialized, /identifying role/i);
});

test('a failed database measurement is explicit, unhealthy, and aggregate-only', () => {
  const result = unavailableTargetRoleCoverage();
  assert.equal(result.measurement_available, false);
  assert.equal(result.coverage_threshold_met, false);
  assert.equal(result.zero_result_target_roles, null);
  assert.doesNotMatch(JSON.stringify(result), /role_samples|titles/);
});
