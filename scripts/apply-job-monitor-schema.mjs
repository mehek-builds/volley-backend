#!/usr/bin/env node
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required.');
  process.exit(2);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  await client.query('begin');
  await client.query(`
    create table if not exists career_page_sources (
      id uuid primary key default gen_random_uuid(),
      company_name text not null,
      ats_name text not null,
      board_token text not null,
      career_url text not null,
      enabled boolean not null default true,
      last_polled_at timestamptz,
      last_error text,
      created_at timestamptz not null default now()
    )
  `);
  await client.query(`
    create unique index if not exists career_page_sources_ats_board_unique
      on career_page_sources (ats_name, board_token)
  `);
  await client.query(`
    create index if not exists career_page_sources_enabled_idx
      on career_page_sources (enabled)
  `);
  await client.query(`
    create table if not exists monitored_jobs (
      id uuid primary key default gen_random_uuid(),
      source_id uuid not null references career_page_sources(id) on delete cascade,
      external_id text not null,
      company_name text not null,
      title text not null,
      location text,
      department text,
      employment_type text,
      description text not null,
      apply_url text not null,
      posting_url text not null,
      remote boolean not null default false,
      posted_at timestamptz,
      first_seen_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      is_active boolean not null default true,
      raw_json jsonb
    )
  `);
  await client.query(`
    create unique index if not exists monitored_jobs_source_external_unique
      on monitored_jobs (source_id, external_id)
  `);
  await client.query(`
    create index if not exists monitored_jobs_active_posted_idx
      on monitored_jobs (is_active, posted_at desc)
  `);
  await client.query(`
    create index if not exists monitored_jobs_company_idx
      on monitored_jobs (company_name)
  `);
  await client.query('commit');
  console.log('Job monitor schema is ready.');
} catch (error) {
  await client.query('rollback');
  console.error('Job monitor schema failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end();
}
