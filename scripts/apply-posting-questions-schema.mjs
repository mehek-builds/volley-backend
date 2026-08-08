#!/usr/bin/env node

/* Creates the two tables behind "ask her the extra questions at the moment she hits Apply".
 *
 *   posting_questions          one row per board posting: what its application form asks.
 *   saved_application_answers  one row per (student, question): the answers she gave once.
 *
 * WHY posting_questions IS KEYED ON THE POSTING AND HOLDS NO ANSWERS. The expensive half of
 * answering an employer's form is looking at it, and the form is the same form for every applicant.
 * The cheap half - deciding which questions a particular profile already covers - is a pure
 * function run per applicant at Apply time. So the browser cost is paid once per posting and shared
 * by everyone, while nothing about any student is stored here.
 *
 * WHY THIS TABLE IS NOT BACKFILLED, and must not be. There are 22,644 active postings. Filling this
 * table eagerly means one managed browser run per posting. The daily cron is a Vercel Hobby job
 * capped at 300 seconds, which at the ~15 seconds a page load and DOM walk take clears about 20
 * postings a day: over three years to cover a board whose median row is gone in weeks. It is not an
 * expensive plan, it is a plan that never catches up with its own input. The table fills itself
 * lazily, one posting per Apply, and each row is then reused by every later applicant.
 *
 * The read side survives this migration NOT having run - both readers treat Postgres 42P01
 * ("relation does not exist") as "nothing cached / nothing remembered", which is exactly today's
 * behaviour - because on Vercel a merge is a deploy and the two can land in either order.
 */

import pg from 'pg';

const STATEMENTS = [
  `create table if not exists posting_questions (
     job_id uuid primary key references monitored_jobs(id) on delete cascade,
     apply_url text not null,
     portal text,
     questions jsonb not null,
     discovery_status text not null,
     discovered_at timestamptz not null default now(),
     scan_count integer not null default 1
   )`,
  `create index if not exists posting_questions_discovered_at_idx
     on posting_questions (discovered_at)`,
  `create table if not exists saved_application_answers (
     user_id uuid not null references users(id) on delete cascade,
     question_key text not null,
     question text not null,
     answer text not null,
     first_answered_job_id uuid,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now(),
     primary key (user_id, question_key)
   )`,
];

const EXPECTED_TABLES = ['posting_questions', 'saved_application_answers'];

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

    for (const statement of STATEMENTS) {
      // Every statement is `create ... if not exists` on a table nothing reads yet, so this takes
      // no lock on anything in the serving path and is safe to re-run.
      await client.query(statement);
    }

    const { rows } = await client.query(
      `select table_name from information_schema.tables
        where table_schema = current_schema()
          and table_name = any($1::text[])`,
      [EXPECTED_TABLES],
    );
    const present = new Set(rows.map((row) => row.table_name));
    const missing = EXPECTED_TABLES.filter((table) => !present.has(table));
    if (missing.length > 0) {
      throw new Error(`still missing after the migration: ${missing.join(', ')}`);
    }
  } finally {
    await client.end();
  }

  console.log(`Ready: ${EXPECTED_TABLES.join(' and ')} exist. Neither is backfilled, by design.`);
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Posting questions schema failed:', message);
  process.exit(1);
});
