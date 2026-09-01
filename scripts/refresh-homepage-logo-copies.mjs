#!/usr/bin/env node
/**
 * Bring already-verified homepage sources forward for a re-verification that keeps a durable copy.
 *
 *   DATABASE_URL=... node scripts/refresh-homepage-logo-copies.mjs            # dry run
 *   DATABASE_URL=... node scripts/refresh-homepage-logo-copies.mjs --apply    # write
 *
 * WHY. Homepage-proven sources verified before durable copies shipped still carry the EMPLOYER's
 * asset URL, and for a real class of employers that URL serves the verifier and nobody else, so
 * the row reads verified while a job seeker sees a monogram. Re-verifying mints our own copy. The
 * 23-day recheck cadence would get there eventually; this makes it now.
 *
 * WHY IT MOVES A TIMESTAMP RATHER THAN CLEARING THE STATUS. Setting logo_verification_status to
 * 'unverified' would pull every one of these sources off the public board until the worker caught
 * up, trading a monogram for a missing job. Ageing logo_verified_at past the recheck window makes
 * the same rows eligible immediately while they stay surfaced, and the schema's logo-evidence
 * check constraint requires a non-null timestamp on a verified row anyway.
 *
 * Safe to run repeatedly: a source that has already been re-verified carries a durable-copy
 * method and is skipped.
 */

import pg from 'pg';

/* The pre-durable homepage methods. A source on the durable variant is already done. */
const STALE_HOMEPAGE_METHODS = [
  'homepage_identity_and_logo_asset',
  'first_party_ats_identity_and_homepage_logo_asset',
];
/* Comfortably past VERIFIED_LOGO_RECHECK_DAYS (23) so the worker's own eligibility query picks
   these up on its next pass without any other change in behaviour. */
const AGE_DAYS = 30;

const apply = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const { rows: counts } = await client.query(
    `select logo_verification_method as method, count(*)::int as sources
       from career_page_sources
      where enabled
        and logo_verification_status = 'verified'
        and logo_verification_method = any($1)
        and logo_verified_at > now() - ($2 || ' days')::interval
      group by logo_verification_method
      order by sources desc`,
    [STALE_HOMEPAGE_METHODS, String(AGE_DAYS)],
  );
  const total = counts.reduce((sum, row) => sum + row.sources, 0);
  for (const row of counts) console.log(`  ${String(row.sources).padStart(6)}  ${row.method}`);
  console.log(`${total} verified homepage source(s) still carry the employer's own asset URL.`);

  if (!apply) {
    console.log('Dry run: nothing written. Re-run with --apply to bring them forward.');
    process.exit(0);
  }

  const { rowCount } = await client.query(
    `update career_page_sources
        set logo_verified_at = now() - ($2 || ' days')::interval,
            logo_last_checked_at = null
      where enabled
        and logo_verification_status = 'verified'
        and logo_verification_method = any($1)
        and logo_verified_at > now() - ($2 || ' days')::interval`,
    [STALE_HOMEPAGE_METHODS, String(AGE_DAYS)],
  );
  console.log(`Brought ${rowCount} source(s) forward; they stay on the board until re-verified.`);
} finally {
  await client.end();
}
