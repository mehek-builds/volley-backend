#!/usr/bin/env node

// What a posting pays, on monitored_jobs. See src/lib/compensation.ts for how the four are derived.
//
// ADDITIVE ONLY, and that is the point. `db:push` would also work here, but push reconciles the
// WHOLE schema in both directions: it drops anything live that schema.ts does not declare. That has
// already cost this repo real columns twice (2026-07-17, `profiles.skills` and `availability_term`),
// which is why scripts/check-schema-drift.mjs exists. `add column if not exists` cannot drop
// anything, so it is the safe way to close a MISSING-only drift.
//
// All four are nullable with no default and no backfill, deliberately. NULL means "the employer
// published no pay", which is true of roughly two thirds of the board, and it is the state every
// existing row should start in. A default would claim a salary nobody stated.
//
// Idempotent, so it is safe to re-run and safe to run BEFORE the deploy that reads the columns.
// Run this FIRST, then deploy: a backend that reads a column the database does not have is the
// outage shape from 2026-07-17 all over again. The poll only starts writing pay once the deploy
// lands, so the window between the two is harmless - the columns simply stay null.
//
// Usage:
//   DATABASE_URL=... node scripts/apply-job-pay-schema.mjs
//   npm run db:job-pay
//
// The connection string is read only from the environment and never printed, including on error
// paths. NOTE: prod is Neon and lives in .env.local; a bare `.env` here points at localhost, so
// running this with the wrong file silently migrates a database nobody is using.

import pg from 'pg';

const TABLE = 'monitored_jobs';

const COLUMNS = [
  // double precision, not real: the largest annual figure on the live board is 14,878,400 (JPY),
  // and float4 carries about 7 significant digits, so `real` would round it. Not numeric either,
  // which the driver hands back as a string - these are displayed and range-compared, never summed.
  { name: 'salary_min', definition: 'double precision' },
  { name: 'salary_max', definition: 'double precision' },
  // ISO 4217. 19 distinct codes appear live, so this is NOT safe to assume is USD.
  { name: 'salary_currency', definition: 'text' },
  // 'year' | 'month' | 'hour'. Text rather than an enum, matching sponsorship_status and
  // job_country on this same table.
  { name: 'salary_interval', definition: 'text' },
];

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

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
    for (const column of COLUMNS) {
      console.log(`Ensuring ${TABLE}.${column.name}...`);
      await client.query(
        `alter table ${quoteIdentifier(TABLE)} add column if not exists ${quoteIdentifier(column.name)} ${column.definition}`,
      );
    }
    await client.query('commit');

    // Prove it, rather than trusting that the DDL meant what we think. A silent no-op here is the
    // failure that only surfaces later as a 500 on the first request that selects the column.
    const { rows } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = $1 and column_name = any($2::text[])`,
      [TABLE, COLUMNS.map((c) => c.name)],
    );
    const present = new Set(rows.map((r) => r.column_name));
    const missing = COLUMNS.map((c) => c.name).filter((name) => !present.has(name));
    if (missing.length > 0) {
      throw new Error(`Columns still missing after migration: ${missing.join(', ')}`);
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log(`Ready: ${COLUMNS.map((c) => `${TABLE}.${c.name}`).join(', ')} are present.`);
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Job pay migration failed:', message);
  process.exit(1);
});
