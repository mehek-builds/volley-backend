#!/usr/bin/env node

/* Adds application_profile.setup_gaps_asked_at, the column that makes the setup gaps screen exitable.
 *
 * WHY THIS COLUMN. /start regained a 'gaps' step: a student whose resume never printed a GPA or a
 * major is asked for them once, immediately before the Done screen. Every field on that screen is
 * optional and skippable, which is exactly why PR #116 deleted the step in the first place - its
 * diff recorded the failure in one line:
 *
 *   "Every gap field is optional and skippable, so gating on `gaps.length` derives 'gaps' FOREVER
 *    for anyone who skipped them."
 *
 * Skipping leaves the fields empty, and the fields being empty was the gate. This column separates
 * the two questions the old gate confused: "has the student answered" (the fields) from "has the
 * student been ASKED" (this timestamp). Save and Skip both stamp it, because both mean asked.
 *
 * ADDITIVE AND NULLABLE, so it is safe to run BEFORE or AFTER the code that reads it ships, which
 * matters because a merge to main IS a production deploy on Vercel and this migration is run by
 * hand. The two orderings behave as follows, and neither is an outage:
 *
 *   migration first, deploy second  Every row reads NULL. Nothing reads the column yet.
 *   deploy first, migration second  'setup_gaps_asked_at' is in APPLICATION_FACT_COLUMNS, so
 *                                   selectApplicationProfileRow's 42703 fallback drops it from the
 *                                   projection and the key is ABSENT from the row rather than null.
 *                                   routes/onboarding.ts gapsAskedFrom reads an absent key as
 *                                   ASKED, which suppresses the gaps step entirely, so the flow
 *                                   behaves exactly as production does today until this runs.
 *
 * That third state is the whole reason the reader distinguishes absent from null: a step that
 * cannot record having been asked is a step nobody can leave, so in the unmigrated window the
 * correct behaviour is not to route anyone to it.
 *
 * Run against PRODUCTION with the Neon URL, not the localhost DATABASE_URL in .env:
 *   DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-)" npm run db:setup-gaps-asked
 */

import pg from 'pg';

const COLUMNS = {
  setup_gaps_asked_at: 'timestamptz',
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

    /* Existing rows stay NULL on purpose, which means "never asked".
     *
     * The alternative - backfilling every current account as already-asked - would be the safer
     * looking choice and the wrong one: these students have never seen the screen, so NULL is the
     * honest value. The blast radius is bounded by what the gate actually is (a missing gpa,
     * gpa_scale or major, all three of which academicSeedFrom already seeds from the resume parse),
     * so the accounts that see the screen once are the ones whose resume genuinely did not print
     * them, which is the population the screen exists for. */
    const { rows: [pending] } = await client.query(
      `select count(*)::int as n from application_profile
        where setup_gaps_asked_at is null
          and (nullif(trim(coalesce(gpa, '')), '') is null
            or nullif(trim(coalesce(gpa_scale, '')), '') is null
            or nullif(trim(coalesce(major, '')), '') is null)`,
    );
    console.log(`Accounts that will be asked the setup gaps screen once: ${pending?.n ?? 0}.`);
  } finally {
    await client.end();
  }

  console.log('Ready: application_profile.setup_gaps_asked_at exists.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Setup gaps asked schema failed:', message);
  process.exit(1);
});
