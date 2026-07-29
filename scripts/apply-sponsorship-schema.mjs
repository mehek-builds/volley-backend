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
import { jobCountry } from '../src/lib/jobLocation.ts';
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
      lca_certifications integer not null default 0,
      fiscal_years jsonb not null default '[]'::jsonb,
      verified_at timestamptz not null default now()
    )
  `);
  await client.query(`
    create unique index if not exists sponsor_employers_normalized_unique
      on sponsor_employers (normalized_name)
  `);
  /* For a table that already exists from the first run of this script. */
  await client.query(`
    alter table sponsor_employers add column if not exists lca_certifications integer not null default 0
  `);
  await client.query(`
    alter table career_page_sources
      add column if not exists sponsor_employer_id uuid references sponsor_employers(id) on delete set null,
      add column if not exists portal_company_name text,
      add column if not exists portal_name_mismatch boolean not null default false
  `);
  await client.query(`
    alter table monitored_jobs
      add column if not exists sponsorship_status text not null default 'unstated',
      add column if not exists job_country text not null default 'unknown'
  `);
  await client.query(`
    create index if not exists monitored_jobs_sponsorship_idx
      on monitored_jobs (is_active, sponsorship_status, job_country)
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
         (normalized_name, company_name, legal_names, evidence_source, approvals, denials, fiscal_years, lca_certifications, verified_at)
       values ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8, now())
       on conflict (normalized_name) do update set
         company_name = excluded.company_name,
         legal_names = excluded.legal_names,
         evidence_source = excluded.evidence_source,
         approvals = excluded.approvals,
         denials = excluded.denials,
         fiscal_years = excluded.fiscal_years,
         lca_certifications = excluded.lca_certifications,
         verified_at = now()`,
      [
        employer.normalized,
        employer.company,
        JSON.stringify(employer.legal_names),
        employer.evidence,
        employer.approvals,
        employer.denials,
        JSON.stringify(employer.fiscal_years),
        employer.lca_certifications,
      ],
    );
    employers += 1;
  }

  /* An employer whose filings have since been withdrawn from the data has to LOSE its row, not
     keep the one it was seeded with. Cleared before relinking so a stale confirmation cannot
     survive a refresh - the whole point of re-running the ingest is that the answer can change.
     THE EMPTY-LIST GUARD IS NOT DEFENSIVE PADDING. In Postgres `x <> ALL('{}')` is TRUE, so with no
     confirmed employers this statement deletes EVERY row - verified against the real table, where
     it matched all 45. The ON DELETE SET NULL on career_page_sources.sponsor_employer_id then
     blanks every source in the same committed transaction, and the sponsor-only board silently
     becomes empty for everyone who needs it. Reachable from a bad rebuild alone: boardCompanies()
     parses jobSources.ts with a regex, and a change to that file's shape yields zero employers
     rather than an error. */
  const confirmed = H1B_EMPLOYERS.filter((e) => e.sponsors).map((e) => e.normalized);
  if (confirmed.length === 0) {
    await client.query('rollback');
    console.error('Refusing to seed: the generated data contains no confirmed employers. Re-run: npm run sponsors:build');
    await client.end();
    process.exit(1);
  }
  const stale = await client.query(
    `delete from sponsor_employers
      where normalized_name <> all ($1::text[])
      returning company_name`,
    [confirmed],
  );

  /* 2. Link the boards. Matched on the normalised name, computed in JS by the same function the
     rest of the product uses, rather than re-implemented in SQL. */
  const sources = await client.query('select id, company_name, portal_name_mismatch from career_page_sources');
  const byNormalized = new Map(
    (await client.query('select id, normalized_name from sponsor_employers')).rows.map((row) => [
      row.normalized_name,
      row.id,
    ]),
  );
  const { normalizeEmployerName } = await import('../src/lib/sponsorship.ts');
  let linked = 0;
  let unlinked = 0;
  let mismatched = 0;
  for (const source of sources.rows) {
    /* A board whose portal name disagrees with ours is one we cannot identify, so it gets no
       employer link regardless of what the name matching says. The poller sets this flag; the seed
       has to respect it or the next seed would quietly restore the link the poller removed. */
    if (source.portal_name_mismatch) {
      await client.query('update career_page_sources set sponsor_employer_id = null where id = $1', [source.id]);
      mismatched += 1;
      unlinked += 1;
      continue;
    }
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
  console.log(`Linked ${linked} career page sources; ${unlinked} have no confirmed sponsorship`
    + `${mismatched ? `, of which ${mismatched} are boards the portal names differently than we do` : ''}.`);
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
  /* Paged by id rather than read in one go. The unpaged version pulled every posting's 20KB of
     description into one array: ~140MB at today's 7,100 rows, and unbounded as the board grows, on
     a pooled serverless connection. Keyset pagination rather than OFFSET so the cost per page does
     not climb with the page number. */
  const changes = new Map();
  const countryChanges = new Map();
  let scanned = 0;
  let cursor = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const { rows } = await client.query(
      `select id, left(description, 20000) as description, sponsorship_status, location, job_country
         from monitored_jobs where id > $1 order by id limit 1000`,
      [cursor],
    );
    if (rows.length === 0) break;
    scanned += rows.length;
    for (const row of rows) {
      const status = readPostingSponsorship(row.description);
      if (status !== row.sponsorship_status) changes.set(row.id, status);
      const country = jobCountry(row.location);
      if (country !== row.job_country) countryChanges.set(row.id, country);
    }
    cursor = rows[rows.length - 1].id;
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
  const byCountry = { us: [], non_us: [], unknown: [] };
  for (const [id, country] of countryChanges) byCountry[country].push(id);
  for (const [country, ids] of Object.entries(byCountry)) {
    for (let index = 0; index < ids.length; index += 500) {
      await client.query('update monitored_jobs set job_country = $1 where id = any($2::uuid[])', [
        country,
        ids.slice(index, index + 500),
      ]);
    }
  }

  const summary = await client.query(
    `select sponsorship_status, count(*)::int as n from monitored_jobs where is_active group by 1 order by 2 desc`,
  );
  console.log(`Backfilled ${changes.size} sponsorship statuses and ${countryChanges.size} job countries, of ${scanned} postings.`);
  for (const row of summary.rows) console.log(`  ${row.sponsorship_status}: ${row.n}`);
} catch (error) {
  console.error('Backfill failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end();
}
