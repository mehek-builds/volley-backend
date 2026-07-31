export const MINIMUM_MATCHES_PER_TARGET_ROLE = 1;
export const ZERO_RESULT_ROLE_SAMPLE_LIMIT = 20;

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Measure whether every distinct title a user entered can return at least one current board role.
 * Matching mirrors GET /jobs?title=: a case-insensitive substring over the posting title.
 */
export function summarizeTargetRoleCoverage(
  targetRoles: readonly string[],
  boardTitles: readonly string[],
) {
  const roles = [...new Set(targetRoles.map(normalize).filter(Boolean))].sort();
  const titles = [...new Set(boardTitles.map(normalize).filter(Boolean))];
  const zeroResultRoles = roles.filter((role) => !titles.some((title) => title.includes(role)));

  return {
    distinct_target_roles: roles.length,
    covered_target_roles: roles.length - zeroResultRoles.length,
    zero_result_target_roles: zeroResultRoles.length,
    zero_result_share: roles.length === 0
      ? 0
      : Number((zeroResultRoles.length / roles.length).toFixed(3)),
    minimum_matches_per_target_role: MINIMUM_MATCHES_PER_TARGET_ROLE,
    coverage_threshold_met: zeroResultRoles.length === 0,
    zero_result_role_samples: zeroResultRoles.slice(0, ZERO_RESULT_ROLE_SAMPLE_LIMIT),
    sample_truncated: zeroResultRoles.length > ZERO_RESULT_ROLE_SAMPLE_LIMIT,
  };
}
