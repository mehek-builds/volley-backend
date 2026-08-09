#!/usr/bin/env node

/* Adds the four application_profile columns that hold a SCOPED, EXPIRING availability window.
 *
 * WHY THESE COLUMNS. Counted across all 112 stored application packets for the owner account,
 * against spec._review.questions, the largest single cluster of required-and-blank questions is one
 * fact asked five ways:
 *
 *   "start date month" / "start date year" ................ 9 each / 5 employers  (education block,
 *                                                           already answered by education_start_date)
 *   "what dates are you available for an internship" ...... blocking production packet fbc1d407
 *   "when do you plan on ending your internship" .......... 6 postings
 *   "please confirm when you will complete your university
 *    studies" ............................................. 7 postings  (a GRADUATION date, now
 *                                                           routed to education_end_date, not here)
 *
 * application_profile.availability_date has held a value the whole time, and the resolver refuses to
 * answer from it on purpose - see the test named "legacy availability facts never authorize a new
 * date, season, duration, or cadence commitment". A bare date carries no recruiting cycle and no
 * expiry, so a value typed for Summer 2026 would answer a Summer 2027 form forever. That refusal is
 * unchanged by this migration; these columns do not replace availability_date, they sit beside it,
 * and the resolver reads only these.
 *
 *   availability_window_start   text, ISO YYYY-MM-DD, the earliest she could begin
 *   availability_window_end     text, ISO YYYY-MM-DD, the latest she is available through
 *   availability_cycle          text, "Summer 2027" - the cycle the window is ABOUT
 *   availability_valid_through  text, ISO YYYY-MM-DD, the explicit expiry she set
 *
 * Every column is additive and nullable, so it is safe to run BEFORE the code that reads it ships:
 * existing rows read NULL, which means "never asked", which is exactly the behaviour today. The
 * reader also survives this migration NOT having run - all four are in APPLICATION_FACT_COLUMNS in
 * lib/applicationFacts.ts, so selectApplicationProfileRow falls back to the legacy column list on
 * 42703 and every one of them reads undefined - because on Vercel a merge is a deploy and the two
 * can land in either order.
 */

import pg from 'pg';

// name -> column type. Kept as data so the post-check below cannot drift from what was added.
const COLUMNS = {
  availability_window_start: 'text',
  availability_window_end: 'text',
  availability_cycle: 'text',
  availability_valid_through: 'text',
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("set lock_timeout = '5s'");
    await client.query("set statement_timeout = '2min'");

    for (const [column, type] of Object.entries(COLUMNS)) {
      // `add column if not exists` with a nullable type takes only a brief ACCESS EXCLUSIVE lock
      // and rewrites nothing, so the 5s lock_timeout above is the whole safety story.
      await client.query(`alter table application_profile add column if not exists ${column} ${type}`);
    }

    const { rows } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'application_profile'
          and column_name = any($1::text[])`,
      [Object.keys(COLUMNS)],
    );
    const present = new Set(rows.map((row) => row.column_name));
    const missing = Object.keys(COLUMNS).filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new Error(`application_profile is still missing after the migration: ${missing.join(', ')}`);
    }
  } finally {
    await client.end();
  }

  console.log(`Ready: application_profile has all ${Object.keys(COLUMNS).length} availability-window columns.`);
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Availability window schema failed:', message);
  process.exit(1);
});
