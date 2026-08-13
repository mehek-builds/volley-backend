#!/usr/bin/env node

/* The restrictive-agreement declaration.
 *
 * ---------------------------------------------------------------------------------------------
 * HOW TO RUN THIS: BY HAND, AGAINST PRODUCTION, BEFORE MERGING THE BRANCH THAT DECLARES THE
 * COLUMN.
 *
 *   DATABASE_URL='<the production connection string>' npm run db:restrictive-agreements
 *
 * Same ordering, and for the same reason, as apply-standardized-test-scores-schema.mjs: the column
 * is additive and nullable, so applying it early breaks nothing, while deploying first breaks the
 * write path outright. Drizzle names every declared column in an INSERT regardless of payload, so
 * with the column absent, PUT /profile/application 500s even for a payload that never mentions it.
 * Reads survive because selectApplicationProfileRow narrows its projection.
 *
 * ---------------------------------------------------------------------------------------------
 * WHAT THE COLUMN IS FOR, AND WHY IT IS NOT A DEFAULT.
 *
 * "Are you currently bound by any agreements with a current or former employer that may restrict
 * your ability to work for us?" and its non-compete / non-solicitation / notice-period variants.
 *
 * resolveKnownAnswer returned a hardcoded "No" to these until 2026-08-11, when it was removed for
 * the right reason: it is a legal statement about the applicant's contractual obligations to a
 * DIFFERENT employer, made by a machine with no column consulted and nothing on file that could
 * ever have supported it. Restoring the behaviour as a constant would restore the defect.
 *
 * This column is the half that was missing. Null means the question is still left for her, exactly
 * as it is today. A value means she declared it herself and Litos is only relaying it, which is the
 * rule selfDeclaration.ts states: Litos may relay a declaration she has made and may never
 * generate one.
 *
 * MEASURED, NOT GUESSED. Counted over the owner account's packets on 2026-08-13, as DISTINCT
 * packets whose fill run left this question required-and-empty:
 *
 *   Scale AI      "are you currently bound by any agreements with a current or former employer"
 *   DRW           the same question in its restrictive-covenant wording
 *   Jump Trading  "non-compete/notice period comments"  (2 postings)
 *
 * 4 postings across 3 companies, which clears the two-posting bar for an onboarding question
 * rather than an ask-at-Apply.
 *
 * Idempotent: `add column if not exists`, and the verification re-reads information_schema rather
 * than trusting the DDL to have done what it said.
 */

import pg from 'pg';

const APPLICATION_PROFILE_COLUMNS = ['restrictive_agreements'];

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
    await client.query('begin');
    await client.query(`
      alter table application_profile
      add column if not exists restrictive_agreements text
    `);
    await client.query('commit');

    const { rows } = await client.query(
      `
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_profile'
        and column_name = any($1)
      `,
      [APPLICATION_PROFILE_COLUMNS],
    );
    const found = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));

    for (const column of APPLICATION_PROFILE_COLUMNS) {
      const row = found.get(`application_profile.${column}`);
      if (!row) throw new Error(`application_profile.${column} is missing`);
      if (row.data_type !== 'text') {
        throw new Error(`application_profile.${column} is ${row.data_type}, expected text`);
      }
      // A NOT NULL here would destroy the one state the resolver depends on: "never asked", which
      // is what keeps the question held for her instead of answered by a default.
      if (row.is_nullable !== 'YES') {
        throw new Error(`application_profile.${column} must stay nullable; null means never asked`);
      }
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  console.log('Ready: application_profile.restrictive_agreements is present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Restrictive agreements schema failed:', message);
  process.exit(1);
});
