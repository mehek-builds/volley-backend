export const MINIMUM_LOGO_COVERAGE = 0.75;

export function logoCoverageFloor(configured: string | undefined): number {
  if (configured === undefined) return MINIMUM_LOGO_COVERAGE;
  const requested = Number(configured);
  if (!Number.isFinite(requested)) return MINIMUM_LOGO_COVERAGE;
  return Math.min(1, Math.max(MINIMUM_LOGO_COVERAGE, requested));
}

/** One employer and how many live rows the board holds for it. */
export interface CompanyRowCount {
  company_name: string;
  rows: number;
}

export interface CoverageTally {
  /** Live rows the board holds, across every company counted. */
  totalRows: number;
  /** Rows whose employer resolves to a domain that actually serves a logo. */
  rowsWithLogo: number;
  /** rowsWithLogo / totalRows, or 0 when the board is empty. */
  coverage: number;
  /** Distinct employers counted. */
  companies: string[];
  /**
   * Employers whose rows render an initial instead of a logo. Deliberately NOT called "unmapped":
   * it covers both a company with no domain in the map AND one whose domain serves no favicon, and
   * the caller reports those two separately because they need different fixes.
   */
  withoutLogo: string[];
}

/**
 * Weight coverage by ROWS, not by companies.
 *
 * The figure has to answer "what fraction of the board a job seeker scrolls shows a real logo",
 * so one employer with 300 postings counts 300 times more than one with a single posting. Counting
 * companies instead would let a long tail of one-posting employers dominate a number that is meant
 * to describe what the board looks like.
 *
 * Split out of check-logo-coverage.mjs so the two ways of obtaining the counts, one grouped query
 * against /jobs/facets and the legacy full paged scan, cannot drift into computing the verdict
 * differently. The script picks how to COUNT; this decides what the counts MEAN.
 */
export function tallyCoverage(
  counts: readonly CompanyRowCount[],
  hasWorkingLogo: (companyName: string) => boolean,
): CoverageTally {
  let totalRows = 0;
  let rowsWithLogo = 0;
  const companies: string[] = [];
  const withoutLogo: string[] = [];

  for (const { company_name, rows } of counts) {
    if (!company_name) continue;
    /* A negative or non-finite count is a broken measurement, not a company with no postings, and
       silently summing it would move the verdict. */
    if (!Number.isFinite(rows) || rows < 0) {
      throw new Error(`company_counts gave ${company_name} a row count of ${rows}`);
    }
    companies.push(company_name);
    totalRows += rows;
    if (hasWorkingLogo(company_name)) rowsWithLogo += rows;
    else withoutLogo.push(company_name);
  }

  return {
    totalRows,
    rowsWithLogo,
    coverage: totalRows === 0 ? 0 : rowsWithLogo / totalRows,
    companies,
    withoutLogo,
  };
}
