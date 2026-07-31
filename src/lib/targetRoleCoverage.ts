export const MINIMUM_MATCHES_PER_TARGET_ROLE = 1;

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
  const zeroResultRoles = roles.filter((role) => {
    let matches = 0;
    for (const title of titles) {
      if (title.includes(role)) matches += 1;
      if (matches >= MINIMUM_MATCHES_PER_TARGET_ROLE) return false;
    }
    return true;
  });

  return {
    distinct_target_roles: roles.length,
    covered_target_roles: roles.length - zeroResultRoles.length,
    zero_result_target_roles: zeroResultRoles.length,
    zero_result_share: roles.length === 0
      ? 0
      : Number((zeroResultRoles.length / roles.length).toFixed(3)),
    minimum_matches_per_target_role: MINIMUM_MATCHES_PER_TARGET_ROLE,
    coverage_threshold_met: zeroResultRoles.length === 0,
    measurement_available: true,
  };
}

export function targetRoleCoverageFromCounts(distinctTargetRoles: number, coveredTargetRoles: number) {
  const total = Math.max(0, distinctTargetRoles);
  const covered = Math.min(total, Math.max(0, coveredTargetRoles));
  const zero = total - covered;
  return {
    distinct_target_roles: total,
    covered_target_roles: covered,
    zero_result_target_roles: zero,
    zero_result_share: total === 0 ? 0 : Number((zero / total).toFixed(3)),
    minimum_matches_per_target_role: MINIMUM_MATCHES_PER_TARGET_ROLE,
    coverage_threshold_met: zero === 0,
    measurement_available: true,
  };
}

/** Keep a failed coverage measurement visible without failing the inventory monitor itself. */
export function unavailableTargetRoleCoverage() {
  return {
    distinct_target_roles: null,
    covered_target_roles: null,
    zero_result_target_roles: null,
    zero_result_share: null,
    minimum_matches_per_target_role: MINIMUM_MATCHES_PER_TARGET_ROLE,
    coverage_threshold_met: false,
    measurement_available: false,
    monitoring_error: 'target_role_coverage_unavailable',
  } as const;
}
