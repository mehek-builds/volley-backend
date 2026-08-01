export const MINIMUM_LOGO_COVERAGE = 0.75;

export function logoCoverageFloor(configured: string | undefined): number {
  if (configured === undefined) return MINIMUM_LOGO_COVERAGE;
  const requested = Number(configured);
  if (!Number.isFinite(requested)) return MINIMUM_LOGO_COVERAGE;
  return Math.min(1, Math.max(MINIMUM_LOGO_COVERAGE, requested));
}
