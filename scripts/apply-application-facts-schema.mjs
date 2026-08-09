#!/usr/bin/env node

/* Adds the application_profile columns for the facts employers keep asking that nothing on file
 * could answer, so they are answered ONCE in onboarding instead of blocking every application.
 *
 * WHY THESE COLUMNS AND NOT OTHERS. Counted across the 25 most recent production packets for the
 * owner account, against spec._review.questions and spec._review.attention_reason. Each row below
 * is "distinct job postings the field would unblock" / "distinct companies":
 *
 *   university start month and year .................... 7 postings / 4 companies  (added 2026-08-09)
 *   outstanding offers or deadlines .................... 5 postings / 5 companies
 *   attestation + privacy acknowledgement checkboxes ... 5 postings / 4 companies
 *   previously applied to this employer ................ 4 postings / 3 companies
 *   further-education plans (NOT on the original list) . 4 postings / 3 companies
 *   high school graduation month and year .............. 3 postings / 2 companies
 *   personal pronouns .................................. 2 postings / 1 company  (9 packets)
 *   legal first name vs preferred name ................. 2 postings / 1 company  (7 packets)
 *   military or veteran service (non-EEO, required) .... 1 posting  / 1 company
 *   politically exposed person, self and family ........ 1 posting  / 1 company
 *
 * SAT and ACT scores were on the proposed list, measured at 1 posting / 1 company (IMC), and are
 * deliberately NOT here. Military service and PEP are below the two-posting bar too, and are here
 * anyway for one reason: both were already being ANSWERED WRONG by a catch-all (PEP got the
 * applicant's home city, "Dubai", because `\bstate\b` matched inside "state-owned"), and the guard
 * that stops that has to exist regardless. Storing the declaration is what keeps the guard from
 * being a permanent dead end.
 *
 * Every column is additive and nullable, so it is safe to run BEFORE the code that reads it ships:
 * existing rows read NULL, which means "never asked", which is exactly the behaviour today. The
 * reader also survives this migration NOT having run - loadApplicationProfileLike selects the row
 * through Drizzle, and every consumer treats a missing value as "never asked" - because on Vercel
 * a merge is a deploy and the two can land in either order.
 */

import pg from 'pg';

// name -> column type. Kept as data so the post-check below cannot drift from what was added.
const COLUMNS = {
  pronouns: 'text',
  legal_first_name: 'text',
  preferred_first_name: 'text',
  high_school_grad_date: 'text',
  education_start_date: 'text',
  prior_application_employers: 'jsonb',
  has_outstanding_offers: 'boolean',
  outstanding_offer_details: 'text',
  military_service: 'text',
  politically_exposed: 'text',
  politically_exposed_family: 'text',
  advanced_study_plan: 'text',
  attest_truthful_information: 'boolean',
  accept_privacy_notices: 'boolean',
  application_attestations_consented_at: 'timestamptz',
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

  console.log(`Ready: application_profile has all ${Object.keys(COLUMNS).length} application-fact columns.`);
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Application facts schema failed:', message);
  process.exit(1);
});
