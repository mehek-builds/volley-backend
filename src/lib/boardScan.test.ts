import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanBoard, BoardScanError } from './boardScan';

interface Row { id: string }

/**
 * A job board that behaves like the live one: newest-first, so the poller PREPENDS and every later
 * offset shifts. This is the shape that made scripts/check-logo-coverage.mjs flaky.
 */
function fakeBoard(options: {
  startRows: number;
  /** Rows the poller inserts, every `insertEvery` requests. */
  insertEvery?: number;
  insertCount?: number;
  /** A single bulk delete, like purgeExpiredPostings, at request number `purgeAt`. */
  purgeAt?: number;
  purgeRows?: number;
  /** Serve empty pages at or past this offset, simulating a truncated read. */
  truncateAfter?: number;
}) {
  const insertEvery = options.insertEvery ?? 0;
  const insertCount = options.insertCount ?? 1;
  let seq = 0;
  let rows: Row[] = Array.from({ length: options.startRows }, () => ({ id: `id-${seq++}` }));
  let requests = 0;
  let purged = false;

  const readPage = async (offset: number, limit: number) => {
    requests++;
    if (insertEvery > 0 && requests % insertEvery === 0) {
      rows = [...Array.from({ length: insertCount }, () => ({ id: `id-${seq++}` })), ...rows];
    }
    if (options.purgeAt && !purged && requests >= options.purgeAt) {
      purged = true;
      rows = rows.slice(0, Math.max(0, rows.length - (options.purgeRows ?? 0)));
    }
    const truncated = options.truncateAfter !== undefined && offset >= options.truncateAfter;
    return { jobs: truncated ? [] : rows.slice(offset, offset + limit), total: rows.length };
  };

  return { readPage, requestCount: () => requests, liveRows: () => rows.length };
}

const idOf = (row: Row) => row.id;

test('a board that never moves is read exactly', async () => {
  const board = fakeBoard({ startRows: 950 });
  const scan = await scanBoard({ readPage: board.readPage, idOf });

  assert.equal(scan.rows.length, 950);
  assert.equal(scan.lowest, 950);
  assert.equal(scan.highest, 950);
  assert.equal(new Set(scan.rows.map(idOf)).size, 950, 'rows must be distinct');
});

test('a board smaller than one page is read exactly', async () => {
  const board = fakeBoard({ startRows: 7 });
  const scan = await scanBoard({ readPage: board.readPage, idOf });
  assert.equal(scan.rows.length, 7);
});

test('an empty board scans to zero rows rather than throwing', async () => {
  const board = fakeBoard({ startRows: 0 });
  const scan = await scanBoard({ readPage: board.readPage, idOf });
  assert.deepEqual(scan.rows, []);
});

/**
 * The regression. Before the fix this threw "expected 20620 rows but read 20621" whenever CI
 * overlapped a poll, failing PRs over a race that had nothing to do with their diff.
 */
test('the board growing mid-scan does not fail the scan', async () => {
  const board = fakeBoard({ startRows: 20_620, insertEvery: 5, insertCount: 1 });
  const scan = await scanBoard({ readPage: board.readPage, idOf });

  assert.ok(scan.highest > 20_620, 'the board must actually have grown for this to be the race');
  assert.equal(new Set(scan.rows.map(idOf)).size, scan.rows.length, 'no duplicates despite shifted offsets');
  assert.ok(
    scan.rows.length >= Math.floor(scan.lowest * 0.995),
    `read ${scan.rows.length} of ${scan.lowest} rows, below the 99.5% completeness bar`,
  );
});

test('growth is tolerated across a range of poll rates', async () => {
  for (const insertEvery of [1, 2, 3, 5, 8]) {
    for (const insertCount of [1, 2, 3]) {
      const board = fakeBoard({ startRows: 5_000, insertEvery, insertCount });
      const scan = await scanBoard({ readPage: board.readPage, idOf });
      assert.ok(
        scan.rows.length >= Math.floor(scan.lowest * 0.995),
        `insertEvery=${insertEvery} insertCount=${insertCount}: read ${scan.rows.length} of ${scan.lowest}`,
      );
      assert.equal(new Set(scan.rows.map(idOf)).size, scan.rows.length);
    }
  }
});

test('a bulk purge mid-scan restarts the scan instead of reporting a skipped read', async () => {
  const board = fakeBoard({ startRows: 20_620, insertEvery: 5, purgeAt: 60, purgeRows: 8_702 });
  const retries: string[] = [];
  const scan = await scanBoard({ readPage: board.readPage, idOf, onRetry: (r) => retries.push(r) });

  assert.equal(retries.length, 1, 'the shrink must be detected once and retried');
  assert.match(retries[0], /shrank/);
  // The retry reads the post-purge board, so the result is complete against what is now live.
  assert.ok(scan.rows.length >= Math.floor(scan.lowest * 0.995));
  assert.equal(new Set(scan.rows.map(idOf)).size, scan.rows.length);
});

/**
 * The tolerance must not become a blanket excuse. A read that silently loses pages is the exact
 * failure this check exists to catch, so it has to survive the flakiness fix.
 */
test('a truncated read fails even while the board is churning', async () => {
  const board = fakeBoard({ startRows: 5_000, insertEvery: 5, truncateAfter: 3_000 });
  await assert.rejects(
    () => scanBoard({ readPage: board.readPage, idOf }),
    (error: unknown) => error instanceof BoardScanError && /short of/.test((error as Error).message),
  );
});

test('a quiet board that reads short gets no churn allowance at all', async () => {
  // 100 rows missing out of 50,000 is 0.2%, comfortably inside the 0.5% band a churning board
  // would be forgiven. Nothing was writing to this board, so it is a bug, and it must still fail.
  const board = fakeBoard({ startRows: 50_000, truncateAfter: 49_900 });
  await assert.rejects(
    () => scanBoard({ readPage: board.readPage, idOf }),
    (error: unknown) => error instanceof BoardScanError && /0-row allowance/.test((error as Error).message),
  );
});

/**
 * A full scan is hundreds of requests. One flaky response must not put a red X on an unrelated PR,
 * which is the same failure class the churn handling exists to remove.
 */
test('a transient page failure is retried rather than failing the scan', async () => {
  const board = fakeBoard({ startRows: 1_500 });
  let failures = 0;
  const readPage = async (offset: number, limit: number) => {
    if (offset === 500 && failures < 2) {
      failures++;
      throw new Error('GET /jobs answered 502 at offset 500');
    }
    return board.readPage(offset, limit);
  };

  const scan = await scanBoard({ readPage, idOf });
  assert.equal(failures, 2, 'the flaky page must actually have failed twice');
  assert.equal(scan.rows.length, 1_500, 'the retried page still lands in the result');
});

test('an endpoint that is genuinely down still fails the scan', async () => {
  const readPage = async () => {
    throw new Error('GET /jobs answered 503 at offset 0');
  };
  await assert.rejects(
    () => scanBoard({ readPage, idOf }),
    (error: unknown) => /503/.test((error as Error).message),
  );
});

test('a row without a usable id is rejected rather than counted', async () => {
  const readPage = async () => ({ jobs: [{ id: '' } as Row], total: 1 });
  await assert.rejects(
    () => scanBoard({ readPage, idOf }),
    (error: unknown) => error instanceof BoardScanError && /usable id/.test((error as Error).message),
  );
});

test('the scan does not page past the offset the board accepts', async () => {
  let maxOffsetSeen = 0;
  const board = fakeBoard({ startRows: 3_000 });
  const readPage = async (offset: number, limit: number) => {
    maxOffsetSeen = Math.max(maxOffsetSeen, offset);
    return board.readPage(offset, limit);
  };
  await scanBoard({ readPage, idOf, maxOffset: 1_000 });
  assert.ok(maxOffsetSeen < 1_000, `paged to offset ${maxOffsetSeen}, past the cap`);
});
