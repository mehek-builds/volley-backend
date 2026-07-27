#!/usr/bin/env node

// The pipeline stage: where the student says this application actually stands.
//
// A DIFFERENT AXIS from spec._review.status. That one is submission machinery (resume_ready,
// preparing, filling, submitted, failed) and it belongs to Litos: it records what the automation
// did. This one belongs to the student and records what the COMPANY did. They move independently:
// a submission is "submitted" forever while the student moves from applied to interview to offer,
// and reusing the status field for both would make an interview indistinguishable from a retry.
//
// NULLABLE WITH NO DEFAULT, and no backfill. NULL means "the student has never moved this", and
// the reader derives a starting stage from the submission status instead. Writing a default would
// claim every historical row had been triaged when none of them had.
//
// Idempotent (add column if not exists), so it is safe to re-run and safe to run before the deploy
// that reads the column. Run this FIRST, then deploy: a backend that reads a column the database
// does not have is the 401/404 outage shape from 2026-07-17 all over again.

import pg from 'pg';

const COLUMNS = [
  { name: 'pipeline_stage', definition: 'text' },
  { name: 'pipeline_stage_at', definition: 'timestamp with time zone' },
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
      console.log(`Ensuring generated_resumes.${column.name}...`);
      await client.query(
        `alter table "generated_resumes" add column if not exists ${quoteIdentifier(column.name)} ${column.definition}`,
      );
    }
    await client.query('commit');

    // Prove it, rather than trusting that the DDL meant what we think. A silent no-op here is the
    // failure that only surfaces later as a 500 on the first real build.
    const { rows } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = 'generated_resumes' and column_name = any($1::text[])`,
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

  console.log('Ready: generated_resumes.pipeline_stage and generated_resumes.pipeline_stage_at are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Pipeline stage migration failed:', message);
  process.exit(1);
});
