#!/usr/bin/env node

/* Adds the append-only ledger for the versioned onboarding walkthrough.
 *
 * The original users.onboarding_completed_at is not reset. It is the privacy boundary that stops
 * first-application harvesting, so changing it for a UI replay would change an existing user's
 * consent state. These two tables record only which walkthrough version and screens were reviewed.
 *
 * Run this against production before deploying the backend. The route also tolerates a missing
 * table during a rolling deploy and falls back to the legacy flow, but migration first avoids any
 * interval where existing accounts cannot begin version 2. */

import pg from 'pg';

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
    await client.query(`
      create table if not exists onboarding_flow_runs (
        user_id uuid not null references users(id) on delete cascade,
        flow_version integer not null,
        started_at timestamptz not null default now(),
        replay_required boolean not null default false,
        completed_at timestamptz,
        primary key (user_id, flow_version)
      )
    `);
    await client.query(
      'alter table onboarding_flow_runs add column if not exists replay_required boolean not null default false',
    );
    await client.query(`
      create table if not exists onboarding_flow_step_acknowledgements (
        user_id uuid not null references users(id) on delete cascade,
        flow_version integer not null,
        step text not null,
        disposition text not null check (disposition in ('continued', 'skipped')),
        acknowledged_at timestamptz not null default now(),
        primary key (user_id, flow_version, step)
      )
    `);

    /* Snapshot every account that exists before version 2 launches. This is intentionally not
       derived from legacy completion: incomplete existing accounts must review the same additive
       walkthrough without deleting the facts they already saved. New accounts created after the
       backend launch have no seeded run and follow the ordinary data-derived setup. */
    const { rowCount: enrolledAccounts } = await client.query(`
      insert into onboarding_flow_runs (user_id, flow_version, replay_required)
      select id, 2, true from users
      on conflict (user_id, flow_version) do nothing
    `);

    const { rows } = await client.query(
      `select table_name from information_schema.tables
        where table_schema = current_schema()
          and table_name = any($1::text[])`,
      [['onboarding_flow_runs', 'onboarding_flow_step_acknowledgements']],
    );
    const present = new Set(rows.map((row) => row.table_name));
    const missing = ['onboarding_flow_runs', 'onboarding_flow_step_acknowledgements']
      .filter((table) => !present.has(table));
    if (missing.length > 0) throw new Error(`Onboarding flow tables still missing: ${missing.join(', ')}`);

    const { rows: [accountCount] } = await client.query(
      'select count(*)::int as n from onboarding_flow_runs where flow_version = 2 and replay_required = true',
    );
    console.log(`Existing accounts enrolled in version 2: ${accountCount?.n ?? 0}. Newly enrolled: ${enrolledAccounts ?? 0}.`);
  } finally {
    await client.end();
  }

  console.log('Ready: versioned onboarding flow ledger exists.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Onboarding flow schema failed:', message);
  process.exit(1);
});
