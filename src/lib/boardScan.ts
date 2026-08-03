/**
 * Read the whole live job board while the job-poll cron is still writing to it.
 *
 * WHY THIS IS NOT JUST A FOR-LOOP OVER OFFSETS
 * --------------------------------------------
 * GET /jobs returns the board newest-first, so an upsert mid-scan PREPENDS and every later offset
 * shifts by one. Paging over a fixed set of offsets therefore re-reads rows it already has and
 * stops short of the end, and the row count it was aiming at has moved by the time it arrives.
 *
 * scripts/check-logo-coverage.mjs used to assert `rows.length === total` against exactly that
 * moving target, and it failed any PR whose CI happened to overlap a poll:
 *
 *   FAILED: could not verify the complete live board (expected 20620 rows but read 20621).
 *
 * That is a race with nothing to do with the diff under review, and it blocked unrelated PRs. The
 * measurement has to tolerate the board growing underneath it without going blind to a read that is
 * genuinely broken, which is what this module is for. It is separated from the script, and given a
 * `readPage` rather than calling fetch itself, so the churn cases can be tested without a network.
 */

export interface BoardPage<Row> {
  jobs: Row[];
  total: number;
}

export interface ScanOptions<Row> {
  readPage: (offset: number, limit: number) => Promise<BoardPage<Row>>;
  idOf: (row: Row) => unknown;
  pageSize?: number;
  /** GET /jobs rejects a larger offset (listQuerySchema in routes/jobMonitor.ts). */
  maxOffset?: number;
  pageConcurrency?: number;
  /** Times the sweep may re-extend to reclaim a tail the poller displaced. */
  topupRounds?: number;
  /** Full re-reads allowed when a mid-scan purge shifts offsets backwards. */
  scanAttempts?: number;
  /** Tries per individual page before the whole scan gives up. */
  pageAttempts?: number;
  /** Largest share of the board the scan may fail to reach and still report. */
  maxShortfall?: number;
  onRetry?: (reason: string) => void;
}

export interface BoardScan<Row> {
  rows: Row[];
  /** Smallest and largest row counts the board reported at any point during the scan. */
  lowest: number;
  highest: number;
}

export const DEFAULT_PAGE_SIZE = 100;
export const DEFAULT_MAX_OFFSET = 100_000;
export const DEFAULT_PAGE_CONCURRENCY = 12;
export const DEFAULT_TOPUP_ROUNDS = 3;
export const DEFAULT_SCAN_ATTEMPTS = 3;
/**
 * A full scan is ~210 requests against a Hobby-tier deployment. Without a per-page retry a single
 * transient 502 fails the whole check, which is the same spurious-CI-failure class this module
 * exists to remove. Matches the two-try retry faviconResponse already uses in the caller.
 */
export const DEFAULT_PAGE_ATTEMPTS = 3;
/**
 * 0.5%. Small enough that it cannot carry a board across the 75% logo-coverage floor, which is the
 * only verdict taken on top of this scan.
 */
export const DEFAULT_MAX_SHORTFALL = 0.005;

export class BoardScanError extends Error {}

type Settled<Row> = Required<Omit<ScanOptions<Row>, 'onRetry'>> & Pick<ScanOptions<Row>, 'onRetry'>;

function settle<Row>(options: ScanOptions<Row>): Settled<Row> {
  return {
    readPage: options.readPage,
    idOf: options.idOf,
    pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    maxOffset: options.maxOffset ?? DEFAULT_MAX_OFFSET,
    pageConcurrency: options.pageConcurrency ?? DEFAULT_PAGE_CONCURRENCY,
    topupRounds: options.topupRounds ?? DEFAULT_TOPUP_ROUNDS,
    scanAttempts: options.scanAttempts ?? DEFAULT_SCAN_ATTEMPTS,
    pageAttempts: options.pageAttempts ?? DEFAULT_PAGE_ATTEMPTS,
    maxShortfall: options.maxShortfall ?? DEFAULT_MAX_SHORTFALL,
    onRetry: options.onRetry,
  };
}

/**
 * One page, retried on transport failure.
 *
 * A full scan is hundreds of requests; without this, one flaky response fails the run and puts a
 * red X on an unrelated PR, which is the exact failure this module exists to stop. A permanently
 * broken endpoint still fails, just after pageAttempts tries rather than one.
 */
async function readPageWithRetry<Row>(
  config: Settled<Row>,
  offset: number,
  limit: number,
): Promise<BoardPage<Row>> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= config.pageAttempts; attempt++) {
    try {
      return await config.readPage(offset, limit);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Read offsets [from, to) and fold them into `rows`, keyed by id so a row read twice counts once.
 *
 * Reports the smallest and largest counts seen across EVERY page rather than just the last one: the
 * low-water mark is what reveals a purge that ran and finished mid-sweep, and that is the signal
 * scanOnce restarts on.
 */
async function sweep<Row>(
  config: Settled<Row>,
  from: number,
  to: number,
  rows: Map<unknown, Row>,
): Promise<{ lowest: number; highest: number }> {
  const offsets: number[] = [];
  for (let offset = from; offset < to; offset += config.pageSize) offsets.push(offset);

  let lowest = Infinity;
  let highest = 0;
  for (let i = 0; i < offsets.length; i += config.pageConcurrency) {
    const batch = offsets.slice(i, i + config.pageConcurrency);
    const pages = await Promise.all(batch.map((offset) => readPageWithRetry(config, offset, config.pageSize)));
    for (const page of pages) {
      for (const row of page.jobs) {
        const id = config.idOf(row);
        if (typeof id !== 'string' || id.length === 0) {
          throw new BoardScanError('the board returned a row without a usable id');
        }
        rows.set(id, row);
      }
      lowest = Math.min(lowest, page.total);
      highest = Math.max(highest, page.total);
    }
  }
  return { lowest, highest };
}

type Attempt<Row> = BoardScan<Row> | { retry: string };

/**
 * One pass over the board.
 *
 * Dedupes by id rather than trusting offsets to be disjoint, then re-reads the count and extends
 * the sweep to reclaim the tail that got pushed past where it stopped. The bar is the SMALLEST
 * count the board reported during the pass: rows the poller added push us over it, rows it deleted
 * pull the bar down to match.
 *
 * Catching up exactly is not always reachable, and pretending otherwise would be the old
 * exact-match bug wearing a loop. Every request is another moment for the poller to insert, the
 * count probe included, so at insert rate r per request the unreached tail settles around
 * r / (1 - r/pageSize) rows rather than reaching zero. So a pass is accepted once the shortfall is
 * within maxShortfall of the board, but ONLY if the board was observed to move at all: a table
 * nobody is writing to must still read exactly, which is what stops a silently truncated read from
 * being waved through as churn. At realistic rates the shortfall is zero and this exits on the
 * first round without using any of it.
 */
async function scanOnce<Row>(config: Settled<Row>): Promise<Attempt<Row>> {
  const rows = new Map<unknown, Row>();
  const first = await sweep(config, 0, config.pageSize, rows);
  const started = first.highest;
  let lowest = first.lowest;
  let highest = first.highest;
  let scannedTo = config.pageSize;

  for (let round = 0; ; round++) {
    const target = Math.min(highest, config.maxOffset);
    if (scannedTo < target) {
      const seen = await sweep(config, scannedTo, target, rows);
      scannedTo = target;
      lowest = Math.min(lowest, seen.lowest);
      highest = Math.max(highest, seen.highest);
    }

    const probe = await readPageWithRetry(config, 0, 1);
    lowest = Math.min(lowest, probe.total);
    highest = Math.max(highest, probe.total);

    const wanted = Math.min(lowest, config.maxOffset);
    const done = (): BoardScan<Row> => ({ rows: [...rows.values()], lowest, highest });
    if (rows.size >= wanted) return done();

    /* A board that never moved gets NO allowance: coming up short against a table nobody is
       writing to is a bug in this scan, not churn, and it has to fail loudly. */
    const allowance = highest === lowest ? 0 : Math.floor(wanted * config.maxShortfall);

    /* Rows deleted mid-scan shift every later offset BACKWARDS, which SKIPS rows rather than
       repeating them, and no amount of extending the sweep gets them back. Start over instead:
       purgeExpiredPostings runs once per poll and deleted 8,702 rows on its first real run, so this
       is a real event and a fresh pass is the only sound answer to it. */
    if (started - lowest > allowance) {
      return { retry: `the board shrank from ${started} to ${lowest} rows mid-scan` };
    }
    if (round >= config.topupRounds) {
      if (rows.size >= wanted - allowance) return done();
      return {
        retry:
          `read ${rows.size} distinct rows after ${config.topupRounds + 1} passes, short of the ${wanted} `
          + `the board reported and outside the ${allowance}-row allowance for churn during the scan`,
      };
    }
  }
}

/**
 * Read the board, restarting when a mid-scan delete makes the pass unsound.
 *
 * Guarantees a full board's worth of DISTINCT live rows, at least 99.5% of it. Does not guarantee
 * the set is byte-identical to any single instant, which no unsnapshotted read of a live table can.
 * That is enough for a coverage ratio measured over the rows actually read.
 *
 * @throws BoardScanError when no pass could read the board cleanly.
 */
export async function scanBoard<Row>(options: ScanOptions<Row>): Promise<BoardScan<Row>> {
  const config = settle(options);
  let last = 'the board could not be read';
  for (let attempt = 1; attempt <= config.scanAttempts; attempt++) {
    const result = await scanOnce(config);
    if (!('retry' in result)) return result;
    last = result.retry;
    if (attempt < config.scanAttempts) config.onRetry?.(last);
  }
  throw new BoardScanError(`${last}, and ${config.scanAttempts} full passes could not read it cleanly`);
}
