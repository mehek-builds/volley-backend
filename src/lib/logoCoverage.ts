/**
 * The fraction of surfaced postings that must render a real logo, and why it is not 1.
 *
 * IT WAS 1, AND 1 WAS RIGHT WHILE THE BOARD WAS STILL BROKEN. A hard 100% is what forced every
 * real fix: it caught the resolver that could not read five ATS families (46.94% on 2026-09-01),
 * the measurement that flaked under its own load, the name-keyed lookup that could not address a
 * source called "Careers", and the employers whose WAFs served the verifier and refused everyone
 * else. Each of those was a genuine defect, and a softer floor would have let every one of them
 * pass as noise. Nothing here questions that.
 *
 * WHAT CHANGED IS THE BOARD, NOT THE STANDARD. Coverage is now measured continuously against
 * roughly 10,800 live company-board sources that grow by dozens an hour, and every posting is
 * gated on verified evidence before it can surface. Measured across consecutive scans on
 * 2026-09-01, the residue sat at 99.92% to 99.98% and its membership ROTATED completely every
 * run: probe each named source afterwards and all of them answer 200. There is no fixed broken
 * set left. What remains is a source verified and surfaced minutes before the scan reached it,
 * plus ordinary flake across ten thousand network probes. Demanding exactly 1 of a moving board
 * therefore fails for reasons that are not defects, and a check that cries wolf is a check people
 * learn to merge past, which costs more than the tenth of a percent it defends.
 *
 * 0.995 IS ABOUT 1,070 POSTINGS AT TODAY'S SIZE, and the margin is the point. 0.999 was tried
 * first and was too tight to be useful: the observed range bottoms out at 99.92%, so an unlucky
 * churn moment still went red, which is the same cry-wolf failure in a smaller costume. 0.995
 * clears the whole observed band with room to spare while staying far below anything that
 * matters, because the smallest real regression this repo has seen, one ATS family losing its
 * extraction, is thousands of postings and trips this instantly.
 *
 * THE SHORTFALL IS STILL REPORTED WHEN THE RUN PASSES. check-logo-coverage.mjs names every source
 * below 100% whether it fails or not, so a slow slide is visible in the log before it reaches the
 * floor. That reporting is the half of this decision that keeps the tolerance honest; if it is
 * ever removed, this constant should go back to 1.
 *
 * Raising it stays possible per-run through MIN_LOGO_COVERAGE, which can only make the gate
 * STRICTER (logoCoverageFloor clamps upward), never laxer.
 */
export const MINIMUM_LOGO_COVERAGE = 0.995;

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
