import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  GB,
  MB,
  NEON_MONTHLY_TRANSFER,
  OBSERVED,
  coldLoadsPerMonth,
  fullBoardScanBytes,
  humanBytes,
  worstCaseRankedLoadBytes,
} from './egressBudget';
import {
  BOARD_PREVIEW_CHARS,
  MAX_PAGE_SIZE,
  RANKING_POOL,
  SCORING_CHARS,
} from '../routes/jobMonitor';

/**
 * THE GUARD THE 2026-08-04 OUTAGE NEEDED AND DID NOT HAVE.
 *
 * Neon refused every connection with "exceeded the data transfer quota" and the public board went
 * down. Nothing in this repo could see it coming, because reading more bytes per row is invisible:
 * same query shape, same plan, same tests, same response. The cost shows up on an invoice and then
 * as a total outage.
 *
 * So the caps that bound those reads are imported from the route itself and priced here. Raising
 * one is still allowed. Raising one WITHOUT noticing is not: this recomputes the worst case and
 * fails, and the failure message says what the new number costs in board loads per month.
 *
 * Sized against the FREE allowance on purpose, even though the project now sits on the paid Launch
 * plan. Budgeting to 500 GB would let the board drift back into a shape that cannot survive a
 * downgrade, a fresh project, or a second environment on the free tier.
 */

/**
 * Worst case for one uncached ranked board load.
 *
 * Not a law of nature: it sits a little above where the code is today (937.5 KB) after the
 * mitigations in #174 cut the pool 300 to 150 and the scored slice 20k to 6k. Before those, the same
 * arithmetic gives 5.78 MB, which is 885 cold loads to burn 5 GB, and that is how the month went.
 */
const MAX_COLD_LOAD_BYTES = 1.1 * MB;

/** A board this popular must survive a month of cold loads without the mitigations helping. */
const MIN_COLD_LOADS_PER_MONTH = 4_000;

const shape = {
  poolSize: RANKING_POOL,
  scoringChars: SCORING_CHARS,
  previewChars: BOARD_PREVIEW_CHARS,
  pageSize: MAX_PAGE_SIZE,
};

describe('Neon data transfer budget', () => {
  test('one cold ranked board load stays inside its byte ceiling', () => {
    const bytes = worstCaseRankedLoadBytes(shape);
    assert.ok(
      bytes <= MAX_COLD_LOAD_BYTES,
      `A cold ranked board load now reads ${humanBytes(bytes)}, above the ${humanBytes(MAX_COLD_LOAD_BYTES)} ceiling.\n`
      + `  RANKING_POOL=${RANKING_POOL} x SCORING_CHARS=${SCORING_CHARS}, plus `
      + `MAX_PAGE_SIZE=${MAX_PAGE_SIZE} x BOARD_PREVIEW_CHARS=${BOARD_PREVIEW_CHARS}.\n`
      + `  That is ${coldLoadsPerMonth(NEON_MONTHLY_TRANSFER.free, bytes).toLocaleString()} cold loads `
      + `before 5 GB is gone. On 2026-08-04 that ran out and every route answered 500.\n`
      + '  If the new cost is genuinely wanted, raise MAX_COLD_LOAD_BYTES in this file deliberately.',
    );
  });

  test('the free allowance survives a realistic month of cold loads', () => {
    const bytes = worstCaseRankedLoadBytes(shape);
    const loads = coldLoadsPerMonth(NEON_MONTHLY_TRANSFER.free, bytes);
    assert.ok(
      loads >= MIN_COLD_LOADS_PER_MONTH,
      `Only ${loads.toLocaleString()} cold board loads fit in the 5 GB free allowance, `
      + `below the ${MIN_COLD_LOADS_PER_MONTH.toLocaleString()} this board should survive.`,
    );
  });

  test('the shape that caused the outage would fail this test', () => {
    // The guard is worth nothing if it would have passed on 2026-08-03. Pool 300, scored slice
    // 20,000: 5.78 MB a load, 885 loads to exhaust 5 GB. A serverless process cache with a 60 second
    // TTL is cold far more often than warm, so that ceiling is reachable in ordinary traffic.
    const before = worstCaseRankedLoadBytes({ ...shape, poolSize: 300, scoringChars: 20_000 });
    assert.ok(before > MAX_COLD_LOAD_BYTES, 'the pre-incident shape must not pass');
    assert.ok(
      coldLoadsPerMonth(NEON_MONTHLY_TRANSFER.free, before) < 1_000,
      'the pre-incident shape burned the month in under a thousand cold loads',
    );
  });

  test('description is the bill, so its caps are the ones that matter', () => {
    // Measured on the live table: 84 MB of description in a 216 MB table. Any path that reads this
    // column for many rows is the egress bill, whatever else the query does.
    assert.ok(OBSERVED.descriptionShareOfRowBytes > 0.6);
    // Reading the column uncapped for the scoring pool, rather than a bounded slice, is the shape
    // that has to stay impossible.
    const uncapped = worstCaseRankedLoadBytes({ ...shape, scoringChars: OBSERVED.avgDescriptionBytes * 3 });
    assert.ok(uncapped > MAX_COLD_LOAD_BYTES, 'an uncapped scoring read must not fit the budget');
  });

  test('paging the whole board is priced so nobody re-adds it casually', () => {
    // check-logo-coverage.mjs did exactly this on every CI run, to read two columns. Measured
    // against production: 222 requests, 29.6 MB. The grouped count replaced it with 15,538 bytes.
    const perRow = 139_878 / 100; // one real page of 100 rows, measured 2026-08-04
    const scan = fullBoardScanBytes(OBSERVED.rows, perRow);
    const grouped = 15_538;

    assert.ok(scan > 25 * MB, `a full board scan should price above 25 MB, got ${humanBytes(scan)}`);
    assert.ok(scan / grouped > 1_000, 'the grouped count must be orders of magnitude cheaper');
    // Ten such scans is a real fraction of the free month, which is why CI must not do it per PR.
    assert.ok((scan * 10) / NEON_MONTHLY_TRANSFER.free > 0.05);
  });

  test('a caller cannot ask for a bigger page than the budget assumes', () => {
    // The ceiling above is computed from MAX_PAGE_SIZE. If the route let a caller exceed it, the
    // arithmetic here would be describing a limit that does not exist.
    assert.equal(MAX_PAGE_SIZE, 100);
    assert.ok(BOARD_PREVIEW_CHARS <= 1_000, 'the list preview must stay a slice, never the column');
  });

  test('humanBytes reads the way an incident note needs it to', () => {
    assert.equal(humanBytes(15_538), '15.2 KB');
    assert.equal(humanBytes(31_052_916), '29.61 MB');
    assert.equal(humanBytes(5 * GB), '5.00 GB');
  });
});
