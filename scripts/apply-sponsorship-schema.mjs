#!/usr/bin/env node
/**
 * THE SPONSOR-ONLY BOARD, IN THE DATABASE.
 *
 *   npm run db:sponsorship            # create the table and columns (idempotent)
 *   npm run db:sponsorship -- --seed  # ...and load the employers, link the sources, backfill jobs
 *
 * Hand-written DDL rather than `drizzle-kit push`, deliberately and for a recorded reason: this
 * database carries columns that exist in production and not in schema.ts, and a push would DROP
 * them (one holds 19 rows). Every statement below is `if not exists` / `add column if not exists`,
 * so re-running it is a no-op and a half-applied run is not a state anyone has to reason about.
 *
 * --seed does three things, in an order that matters:
 *   1. upsert sponsor_employers from the generated USCIS data
 *   2. point every career_page_sources row at its employer (or at NULL, when there is no filing)
 *   3. recompute monitored_jobs.sponsorship_status for every posting already stored
 * Step 3 is the one that cannot be skipped on first run: the poller writes the column going
 * forward, but the ~7,000 postings already in the table were stored before it existed, and they
 * would all sit at the 'unstated' default until their board next refreshed.
 */

import pg from 'pg';
import { readPostingSponsorship } from '../src/lib/sponsorship.ts';
import { H1B_EMPLOYERS, H1B_SOURCE } from '../src/lib/sponsorEmployers.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const seed = process.argv.includes('--seed');

// Local PostgreSQL commonly has TLS disabled. Hosted providers used by Litos require it.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);
const client = new pg.Client({
  connectionString,
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
});
await client.connect();

try {
  await client.query('begin');

  await client.query(`
    create table if not exists sponsor_employers (
      id uuid primary key default gen_random_uuid(),
      normalized_name text not null,
      company_name text not null,
      legal_names jsonb not null default '[]'::jsonb,
      evidence_source text not null,
      approvals integer not null default 0,
      denials integer not null default 0,
      fiscal_years jsonb not null default '[]'::jsonb,
      verified_at timestamptz not null default now()
    )
  `);
  await client.query(`
    create unique index if not exists sponsor_employers_normalized_unique
      on sponsor_employers (normalized_name)
  `);
  await client.query(`
    alter table career_page_sources
      add column if not exists sponsor_employer_id uuid references sponsor_employers(id) on delete set null
  `);
  await client.query(`
    alter table monitored_jobs
      add column if not exists sponsorship_status text not null default 'unstated'
  `);
  await client.query(`
    create index if not exists monitored_jobs_sponsorship_idx
      on monitored_jobs (is_active, sponsorship_status)
  `);
  await client.query(`
    alter table users
      add column if not exists sponsorship_required_at_onboarding boolean,
      add column if not exists sponsorship_declared_at timestamptz,
      add column if not exists sponsorship_answer text,
      add column if not exists sponsor_only_jobs_enabled boolean not null default false
  `);

  await client.query('commit');
  console.log('Sponsorship schema is ready.');
} catch (error) {
  await client.query('rollback');
  console.error('Sponsorship schema failed:', error instanceof Error ? error.message : String(error));
  await client.end();
  process.exit(1);
}

if (!seed) {
  await client.end();
  console.log('Run again with --seed to load employers and backfill postings.');
  process.exit(0);
}

try {
  await client.query('begin');

  /* 1. The employers. Only the confirmed ones become rows: sponsor_employers is the list of
     companies Litos will show, so an unconfirmed company belongs in it as an ABSENCE. The
     generated file keeps the full record of what was checked, including the misses. */
  let employers = 0;
  for (const employer of H1B_EMPLOYERS) {
    if (!employer.sponsors) continue;
    await client.query(
      `insert into sponsor_employers
         (normalized_name, company_name, legal_names, evidence_source, approvals, denials, fiscal_years, verified_at)
       values ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, now())
       on conflict (normalized_name) do update set
         company_name = excluded.company_name,
         legal_names = excluded.legal_names,
         evidence_source = excluded.evidence_source,
         approvals = excluded.approvals,
         denials = excluded.denials,
         fiscal_years = excluded.fiscal_years,
         verified_at = now()`,
      [
        employer.normalized,
        employer.company,
        JSON.stringify(employer.legal_names),
        'uscis_h1b',
        employer.approvals,
        employer.denials,
        JSON.stringify(employer.fiscal_years),
      ],
    );
    employers += 1;
  }

  /* An employer whose filings have since been withdrawn from the data has to LOSE its row, not
     keep the one it was seeded with. Cleared before relinking so a stale confirmation cannot
     survive a refresh - the whole point of re-running the ingest is that the answer can change. */
  const stale = await client.query(
    `delete from sponsor_employers
      where normalized_name <> all ($1::text[])
      returning company_name`,
    [H1B_EMPLOYERS.filter((e) => e.sponsors).map((e) => e.normalized)],
  );

  /* 2. Link the boards. Matched on the normalised name, computed in JS by the same function the
     rest of the product uses, rather than re-implemented in SQL. */
  const sources = await client.query('select id, company_name from career_page_sources');
  const byNormalized = new Map(
    (await client.query('select id, normalized_name from sponsor_employers')).rows.map((row) => [
      row.normalized_name,
      row.id,
    ]),
  );
  const { normalizeEmployerName } = await import('../src/lib/sponsorship.ts');
  let linked = 0;
  let unlinked = 0;
  for (const source of sources.rows) {
    const employerId = byNormalized.get(normalizeEmployerName(source.company_name)) ?? null;
    await client.query('update career_page_sources set sponsor_employer_id = $1 where id = $2', [
      employerId,
      source.id,
    ]);
    if (employerId) linked += 1; else unlinked += 1;
  }

  await client.query('commit');
  console.log(`Seeded ${employers} sponsoring employers from ${H1B_SOURCE}.`);
  if (stale.rowCount) console.log(`Removed ${stale.rowCount} employer(s) no longer in the data: ${stale.rows.map((r) => r.company_name).join(', ')}`);
  console.log(`Linked ${linked} career page sources; ${unlinked} have no confirmed sponsorship.`);
} catch (error) {
  await client.query('rollback');
  console.error('Seeding failed:', error instanceof Error ? error.message : String(error));
  await client.end();
  process.exit(1);
}

/* 3. Backfill every stored posting.
   Outside a single transaction on purpose: this reads and writes ~7,000 rows, and holding one
   transaction open across that on a pooled serverless connection is how a migration turns into an
   outage. Each chunk is atomic, and a re-run is idempotent because the classification is a pure
   function of text that is already stored. */
try {
  const { rows } = await client.query(
    `select id, left(description, 20000) as description, sponsorship_status from monitored_jobs`,
  );
  const changes = new Map();
  for (const row of rows) {
    const status = readPostingSponsorship(row.description);
    if (status !== row.sponsorship_status) changes.set(row.id, status);
  }
  const byStatus = { offers: [], refuses: [], unstated: [] };
  for (const [id, status] of changes) byStatus[status].push(id);
  for (const [status, ids] of Object.entries(byStatus)) {
    for (let index = 0; index < ids.length; index += 500) {
      await client.query('update monitored_jobs set sponsorship_status = $1 where id = any($2::uuid[])', [
        status,
        ids.slice(index, index + 500),
      ]);
    }
  }
  const summary = await client.query(
    `select sponsorship_status, count(*)::int as n from monitored_jobs where is_active group by 1 order by 2 desc`,
  );
  console.log(`Backfilled ${changes.size} of ${rows.length} postings.`);
  for (const row of summary.rows) console.log(`  ${row.sponsorship_status}: ${row.n}`);
} catch (error) {
  console.error('Backfill failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end();
}
