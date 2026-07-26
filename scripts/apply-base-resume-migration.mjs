#!/usr/bin/env node

// The base resume: one stored ResumeSpec per student, built once at onboarding.
//
// Both columns are nullable with no default, deliberately. NULL means "never built", which every
// account created before this shipped genuinely is, and /onboarding/state reads that NULL to decide
// whether the base step still has work to do. Backfilling a default would erase the distinction
// between a resume the student has approved and one nobody has ever seen.
//
// Idempotent (add column if not exists), so it is safe to re-run and safe to run before the deploy
// that reads the columns. Run this FIRST, then deploy: a backend that reads a column the database
// does not have is the 401/404 outage shape from 2026-07-17 all over again.

import pg from 'pg';

const COLUMNS = [
  { name: 'base_resume_json', definition: 'jsonb' },
  { name: 'base_resume_built_at', definition: 'timestamp with time zone' },
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
      console.log(`Ensuring profiles.${column.name}...`);
      await client.query(
        `alter table "profiles" add column if not exists ${quoteIdentifier(column.name)} ${column.definition}`,
      );
    }
    await client.query('commit');

    // Prove it, rather than trusting that the DDL meant what we think. A silent no-op here is the
    // failure that only surfaces later as a 500 on the first real build.
    const { rows } = await client.query(
      `select column_name from information_schema.columns
        where table_name = 'profiles' and column_name = any($1::text[])`,
      [COLUMNS.map((c) => c.name)],
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

  console.log('Ready: profiles.base_resume_json and profiles.base_resume_built_at are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Base resume migration failed:', message);
  process.exit(1);
});
