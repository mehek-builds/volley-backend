/**
 * How many bytes a request can pull out of Postgres, and how long the month's allowance survives it.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On 2026-08-04 this project exhausted its Neon DATA TRANSFER allowance. Neon then refuses every
 * connection with "Your project has exceeded the data transfer quota", so every database-backed
 * route answered 500 while /health kept answering 200 because it never touches Postgres. The public
 * job board was down. Recovery needed a plan change; there was no code fix available at the time.
 *
 * What makes this failure mode different from the ones the repo already guards is that NOTHING gets
 * slower or louder on the way to it. A query that reads 20,000 characters per row instead of 6,000
 * has the same shape, the same plan, the same tests, and the same response. The cost lands on an
 * invoice and then, once, as a total outage. Measured on the live table the day it happened:
 *
 *   monitored_jobs          216 MB total, 23,561 rows
 *   description column       84 MB, which is 67.6% of all row bytes
 *   average description    3,728 bytes, largest 10,183
 *
 * So `description` IS the egress bill. Any code path that reads it for many rows is the thing to
 * watch, and the caps that bound those paths are one-character edits.
 *
 * WHAT THIS DOES ABOUT IT
 * -----------------------
 * It turns the caps into arithmetic a test can fail on. egressBudget.test.ts imports the REAL
 * constants from routes/jobMonitor.ts, recomputes the worst case here, and fails when a change
 * pushes it past what the plan can survive. Raising a cap is still allowed; doing it silently is
 * not. The test prints what the new number costs in cold board loads per month.
 *
 * These are deliberately worst-case numbers, not observed averages. The point is the ceiling.
 */

export const KB = 1024;
export const MB = 1024 * KB;
export const GB = 1024 * MB;

/**
 * Public network transfer included per project per month.
 *
 * Free is the number that was exhausted. The project now sits on Launch, under the Vercel-managed
 * Neon organisation, which is a PAID plan: the outage was resolved by upgrading, not by waiting for
 * a window to roll over. Both are kept because the budget assertions are written against FREE on
 * purpose. Sizing to 500 GB would let the board drift back to a shape that cannot survive a
 * downgrade, a new project, or a second environment spun up on the free tier.
 */
export const NEON_MONTHLY_TRANSFER = {
  free: 5 * GB,
  launch: 500 * GB,
  scale: 500 * GB,
} as const;

/** Measured on the live table on 2026-08-04. Used to price a read of the description column. */
export const OBSERVED = {
  rows: 23_561,
  avgDescriptionBytes: 3_728,
  maxDescriptionBytes: 10_183,
  descriptionShareOfRowBytes: 0.676,
} as const;

export interface BoardReadShape {
  /** Postings whose text gets read to score a ranked board (RANKING_POOL). */
  poolSize: number;
  /** Characters of posting text read per pooled row (SCORING_CHARS). */
  scoringChars: number;
  /** Characters of description returned per row on the list (BOARD_PREVIEW_CHARS). */
  previewChars: number;
  /** Largest page a caller may request (MAX_PAGE_SIZE). */
  pageSize: number;
}

/**
 * Worst-case bytes out of Postgres for ONE ranked board load that misses every cache.
 *
 * Two reads, because that is what the route does: the scoring pool reads posting text for
 * `poolSize` rows, and the page itself returns a `previewChars` slice for up to `pageSize` rows.
 * Both are capped in code, and both caps are the thing under test.
 *
 * Deliberately ignores the ranking cache, the CDN, and description_digest. Every one of those makes
 * the real number smaller, and every one of them can be cold, bypassed, or absent on a given
 * request. A ceiling that assumes its own mitigations work is not a ceiling.
 */
export function worstCaseRankedLoadBytes(shape: BoardReadShape): number {
  const scoringRead = shape.poolSize * shape.scoringChars;
  const pageRead = shape.pageSize * shape.previewChars;
  return scoringRead + pageRead;
}

/** Cold ranked board loads the month's allowance survives at that worst case. */
export function coldLoadsPerMonth(monthlyBudgetBytes: number, bytesPerLoad: number): number {
  if (bytesPerLoad <= 0) return Infinity;
  return Math.floor(monthlyBudgetBytes / bytesPerLoad);
}

/**
 * Bytes to page the whole board through GET /jobs at `pageSize` rows a request.
 *
 * This is what check-logo-coverage.mjs used to spend on every CI run to read two columns: measured
 * against production it was 29.6 MB per pass. It now asks GET /jobs/facets?counts=true instead,
 * which answered the same question in 15,538 bytes. Kept here so the comparison stays checkable
 * rather than remembered.
 */
export function fullBoardScanBytes(rows: number, bytesPerRow: number): number {
  return rows * bytesPerRow;
}

export const humanBytes = (n: number): string => {
  if (n >= GB) return `${(n / GB).toFixed(2)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(2)} MB`;
  if (n >= KB) return `${(n / KB).toFixed(1)} KB`;
  return `${n} B`;
};
