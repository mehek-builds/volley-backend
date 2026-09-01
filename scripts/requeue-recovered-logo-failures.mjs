#!/usr/bin/env node
/**
 * Re-queue the logo-verification failure classes that PR #788 made recoverable.
 *
 *   DATABASE_URL=... node scripts/requeue-recovered-logo-failures.mjs            # dry run
 *   DATABASE_URL=... node scripts/requeue-recovered-logo-failures.mjs --apply    # write
 *
 * WHY THIS EXISTS. The redirect and trailing-brand recovery shipped, but ats:http_301/302/307 and
 * homepage:identity_mismatch are correctly NON-transient classes, so every source already sitting
 * failed on them only becomes eligible again when its logo_last_checked_at ages past the 7-day
 * failed-retry window. The ~4,100 sources the recovery targets would therefore trickle back over
 * a week, one source at a time as its own clock expired, and the first days after the deploy
 * would look exactly like the fix not working (review finding 2026-09-01).
 *
 * WHAT IT DOES. Clears logo_last_checked_at for enabled, failed sources whose persisted reason is
 * one of the recovered classes. A null last-checked is the worker's "never tried" state, so the
 * next verification pass sweeps them immediately; nothing else about the rows changes, and the
 * exact failure reason stays queryable until the re-run overwrites it. Sources that fail again
 * re-enter the normal 7-day cadence with a fresh timestamp.
 *
 * Dry run by default: it prints the per-reason counts it would touch and exits. --apply writes.
 */

import pg from 'pg';

/* Component-anchored, same boundaries the eligibility SQL in routes/jobMonitor.ts uses: composite
   reasons join with ';' and prefix with the failing stage, so 'ats:http_301' must match while
   'ats:http_3010' or a reason merely containing the text must not. */
const RECOVERED_REASON_SQL = String.raw`(^|;)\s*(ats:http_30[127]|homepage:identity_mismatch)\s*(;|$)`;

const apply = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows: counts } = await client.query(
    `select logo_verification_error as reason, count(*)::int as sources
       from career_page_sources
      where enabled
        and logo_verification_status = 'failed'
        and logo_last_checked_at is not null
        and coalesce(logo_verification_error, '') ~ $1
      group by logo_verification_error
      order by sources desc`,
    [RECOVERED_REASON_SQL],
  );
  const total = counts.reduce((sum, row) => sum + row.sources, 0);
  for (const row of counts.slice(0, 20)) {
    console.log(`  ${String(row.sources).padStart(6)}  ${row.reason}`);
  }
  if (counts.length > 20) console.log(`  ...and ${counts.length - 20} more distinct reasons.`);
  console.log(`${total} failed source(s) carry a recovered reason class.`);

  if (!apply) {
    console.log('Dry run: nothing written. Re-run with --apply to re-queue them.');
    process.exit(0);
  }

  const { rowCount } = await client.query(
    `update career_page_sources
        set logo_last_checked_at = null
      where enabled
        and logo_verification_status = 'failed'
        and logo_last_checked_at is not null
        and coalesce(logo_verification_error, '') ~ $1`,
    [RECOVERED_REASON_SQL],
  );
  console.log(`Re-queued ${rowCount} source(s); the next verification pass sweeps them.`);
} finally {
  await client.end();
}
