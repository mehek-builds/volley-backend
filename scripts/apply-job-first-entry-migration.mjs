#!/usr/bin/env node

/* Job-first onboarding entry: a visitor who clicked a specific posting on /browse-jobs, rather
 * than one who arrived through the front door.
 *
 * job_first_entry is permanent, set once at guest creation, and stays true for the life of the
 * account: onboardingStepFrom reads it to keep resume ordered ahead of focus, and it must not
 * silently flip back once the pin below is spent.
 *
 * pinned_onboarding_job_id is the specific posting, cleared once the match step spends it. See
 * src/db/schema.ts and src/routes/onboarding.ts (MIGRATION_PENDING_COLUMNS covers both, so a
 * deploy that lands before this migration runs degrades to the ordinary flow rather than 500ing).
 */

import pg from 'pg';

const COLUMNS = [
  { name: 'job_first_entry', definition: 'boolean not null default false' },
  { name: 'pinned_onboarding_job_id', definition: 'uuid' },
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
      console.log(`Ensuring users.${column.name}...`);
      await client.query(
        `alter table "users" add column if not exists ${quoteIdentifier(column.name)} ${column.definition}`,
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log('Ready: job_first_entry and pinned_onboarding_job_id are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Job-first entry migration failed:', message);
  process.exit(1);
});
