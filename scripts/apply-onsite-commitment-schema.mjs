#!/usr/bin/env node

/* Adds the application_profile columns for WHERE SHE WILL WORK FROM, and removes the column
 * default that was answering a different question for her.
 *
 * WHY. `src/lib/questionDiscovery.ts` had, in resolveKnownAnswer:
 *
 *     case 'onsite_commitment':
 *       return { value: 'Yes' };
 *
 * A hardcoded Yes. No column consulted, nothing stored behind it. A Redwood Materials packet was
 * ready to send with "Are you available to work from our office in San Francisco?" answered YES,
 * for an applicant whose phone number is +971 and whose university is in Los Angeles. That is a
 * commitment about where she will physically be, authored by a machine, going to a real employer
 * under her name - the same class of defect as R-105's auto-"Yes" to Akuna's exclusivity clause.
 *
 * WHY THESE COLUMNS AND NOT AN ASK AT APPLY. Counted by replaying every distinct question label in
 * the stored corpus (1924 stored questions, 495 distinct label/type pairs, from generated_resumes
 * spec._review.questions, posting_questions and saved_application_answers) through the resolver:
 *
 *   office / onsite / in-person commitment ..... 15 labels / 12 companies / 45 occurrences
 *   how did you hear about us .................. 25 labels / 20 companies / 90 occurrences
 *   preferred work location choice ............. 10 labels /  6 companies / 19 occurrences
 *   relocation willingness .....................  3 labels /  3 companies /  5 occurrences
 *
 * The product rule is two postings. All four clear it, so all four become onboarding facts rather
 * than a question asked at every Apply. The two that did NOT clear it - the AI-interview-conduct
 * policy (1 company) and the past-employer restriction agreement (1 company) - are not given
 * columns; the code change refuses them instead and the existing ask-at-Apply machinery collects
 * them, which is the correct outcome for a one-employer question.
 *
 * WHY THREE COLUMNS. onsite_commitment carries a LOCATION DIMENSION that no boolean can hold: yes
 * to Los Angeles and no to New York are both true, and which one an employer is owed depends on
 * which office the question names. onsite_locations is the list, ordered, so it doubles as the
 * answer to "what is your preferred work location?". relocation_willingness is separate because
 * agreeing to commute to an office in the city you already live in says nothing about moving.
 *
 *   onsite_commitment      text     'anywhere' | 'listed_locations' | 'no'
 *   onsite_locations       jsonb    string[], her own words, most preferred first
 *   relocation_willingness text     'yes' | 'no'
 *
 * Every column is additive and nullable, so it is safe to run BEFORE the code that reads it ships.
 * NULL means "never asked", the resolver refuses on NULL, and an existing user who has not answered
 * is therefore ASKED rather than defaulted. That is deliberate and it is the whole point: silently
 * defaulting after the migration would be the same wrong answer the constant was.
 *
 * ---------------------------------------------------------------------------------------------
 * THE SECOND HALF, AND IT IS NOT AUTOMATIC.
 *
 * application_profile.referral_source_default was declared `.default('Company website')`. Measured
 * 2026-08-09: all 16 production rows carry "Company website" and not one was typed by a person -
 * the column default put it there. So "how did you hear about this job?", the most-asked question
 * in the corpus, was answered on every application with a statement of fact nobody made, and one
 * that is usually false, because Litos finds these postings on a monitored board.
 *
 * This script ALWAYS drops the default, so new rows are honest.
 *
 * It clears the existing 16 values ONLY with --reset-referral-default, because doing so starts
 * asking 16 accounts a question they were previously answering without noticing, and that is a
 * product decision rather than a schema one. Until it is run with that flag, those accounts keep
 * relaying "Company website" - which is at least a value the resolver can point at a column for,
 * and is no worse than today.
 *
 * Usage:
 *   node scripts/apply-onsite-commitment-schema.mjs
 *   node scripts/apply-onsite-commitment-schema.mjs --reset-referral-default
 */

import pg from 'pg';

// name -> column type. Kept as data so the post-check below cannot drift from what was added.
const COLUMNS = {
  onsite_commitment: 'text',
  onsite_locations: 'jsonb',
  relocation_willingness: 'text',
};

async function main() {
  const resetReferral = process.argv.includes('--reset-referral-default');

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

    // Metadata-only. Existing rows are untouched by this; only future inserts change.
    await client.query('alter table application_profile alter column referral_source_default drop default');

    let cleared = 0;
    if (resetReferral) {
      const { rowCount } = await client.query(
        "update application_profile set referral_source_default = null where referral_source_default = 'Company website'",
      );
      cleared = rowCount ?? 0;
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

    const { rows: defaults } = await client.query(
      `select column_default from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'application_profile'
          and column_name = 'referral_source_default'`,
    );
    if (defaults[0]?.column_default) {
      throw new Error(`referral_source_default still has a default: ${defaults[0].column_default}`);
    }

    console.log(`Ready: application_profile has all ${Object.keys(COLUMNS).length} onsite-commitment columns.`);
    console.log('Ready: referral_source_default no longer defaults to "Company website" for new rows.');
    console.log(resetReferral
      ? `Cleared the unchosen "Company website" value on ${cleared} existing row(s); those accounts will now be asked.`
      : 'Existing rows keep their unchosen "Company website" value. Re-run with --reset-referral-default to clear it.');
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Onsite commitment schema failed:', message);
  process.exit(1);
});
