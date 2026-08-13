#!/usr/bin/env node

/* Standardized test scores.
 *
 * ---------------------------------------------------------------------------------------------
 * HOW TO RUN THIS: BY HAND, AGAINST PRODUCTION, BEFORE MERGING THE BRANCH THAT DECLARES THE
 * COLUMNS. There is no GitHub Actions workflow for it, deliberately.
 *
 *   DATABASE_URL='<the production connection string>' npm run db:standardized-test-scores
 *
 * A workflow WAS written for this and was removed, because it could not have worked. A
 * `workflow_dispatch` workflow is only addressable once it exists ON THE DEFAULT BRANCH: GitHub
 * assigns the workflow id at that point, and without an id there is nothing for the Run workflow
 * button or the dispatch API to target. Measured: the sibling
 * country-work-eligibility-migration.yml resolves to a live workflow id, and a file present only on
 * a feature branch 404s. So a migration workflow shipped in the SAME pull request as its script can
 * never be dispatched before that pull request merges, which makes it precisely useless for the one
 * ordering it exists to serve. Removing the `if: github.ref` gate did not change this; the gate was
 * never the binding constraint.
 *
 * If a workflow is wanted later, it has to land on main in its own change that declares no columns,
 * so it registers first and is dispatchable afterwards.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THE ORDER IS MIGRATION FIRST, THEN MERGE. These columns are additive and nullable, so they
 * are backward compatible with the code already in production and applying them early breaks
 * nothing. Deploying first does break things, and not only the feature: Drizzle names every declared
 * column in an INSERT regardless of payload, so with the columns absent, PUT /profile/application
 * 500s even for a payload that never mentions them, POST /profile/harvest 500s, and the academic
 * prefill is silently dropped. Reads survive, because selectApplicationProfileRow narrows its
 * projection. See lib/applicationFacts.ts for why the write path has no equivalent tolerance and
 * cannot be given one.
 *
 * MEASURED, NOT GUESSED. Counted over the owner account's full 158-packet corpus on 2026-08-11
 * (366 packets carry a review-questions array across all accounts; this count is the owner's),
 * from attention_reason lines of the shape `"X" is required and is still empty`, as DISTINCT
 * packets blocked:
 *
 *   standardized test score type    8
 *   SAT score                       8
 *   ACT score                       8
 *
 * In postings, which is the unit the 2026-08-08 facts group counts in, those 8 packets are 2
 * postings at ONE employer, retried four times each. That clears the letter of that group's
 * two-posting bar and no more. The argument for the columns is not the count: nothing can harvest a
 * test score because a form asks for one and never offers one, all 24 occurrences were required and
 * blank, and the type question needs a closed list. See db/schema.ts, which records the honest
 * counterpoint too.
 *
 * ALL THREE ARE NULLABLE AND NOTHING IS BACKFILLED. Null means "never asked" and the resolver
 * refuses on it, so an existing account is ASKED rather than silently given a default. Inventing a
 * test score would be a checkable false claim about an academic record made to an employer, which
 * is the exact defect class this column group exists to remove.
 *
 * Idempotent: `add column if not exists` throughout, and the verification below re-reads
 * information_schema rather than trusting the DDL to have done what it said.
 */

import pg from 'pg';

const APPLICATION_PROFILE_COLUMNS = ['standardized_test_type', 'sat_score', 'act_score'];

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
      add column if not exists standardized_test_type text,
      add column if not exists sat_score text,
      add column if not exists act_score text
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
      // A NOT NULL here would destroy the one state the resolver depends on: "never asked".
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
  console.log('Ready: standardized test score columns are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Standardized test scores schema failed:', message);
  process.exit(1);
});
