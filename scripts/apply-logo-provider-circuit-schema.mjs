/**
 * Add the durable provider circuit and per-source 429 counter used by logo verification.
 *
 * This migration is intentionally additive and idempotent. It can run before the API deploy while
 * the current logo worker continues using the older columns, and reruns preserve live circuit and
 * attempt state.
 */

import pg from 'pg';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });

try {
  await client.connect();
  await client.query("set lock_timeout = '5s'");
  await client.query("set statement_timeout = '5min'");

  await client.query(`
    alter table career_page_sources
      add column if not exists logo_provider_429_attempts integer not null default 0
  `);
  await client.query(`
    create table if not exists logo_verification_provider_circuits (
      provider text primary key,
      circuit_open_until timestamptz,
      active_claim_token text,
      active_claim_expires_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )
  `);
  await client.query(`
    do $migration$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'career_page_sources_logo_provider_429_attempts_check'
          and conrelid = 'career_page_sources'::regclass
      ) then
        alter table career_page_sources
          add constraint career_page_sources_logo_provider_429_attempts_check
          check (logo_provider_429_attempts between 0 and 3) not valid;
      end if;
    end
    $migration$
  `);
  await client.query(`
    alter table career_page_sources
      validate constraint career_page_sources_logo_provider_429_attempts_check
  `);
  await client.query(`
    do $migration$
    begin
      if not exists (
        select 1 from pg_constraint
        where conname = 'logo_verification_provider_circuits_claim_pair_check'
          and conrelid = 'logo_verification_provider_circuits'::regclass
      ) then
        alter table logo_verification_provider_circuits
          add constraint logo_verification_provider_circuits_claim_pair_check
          check ((active_claim_token is null) = (active_claim_expires_at is null)) not valid;
      end if;
    end
    $migration$
  `);
  await client.query(`
    alter table logo_verification_provider_circuits
      validate constraint logo_verification_provider_circuits_claim_pair_check
  `);
  await client.query(`
    insert into logo_verification_provider_circuits (provider)
    values ('crelate')
    on conflict (provider) do nothing
  `);

  console.log('Logo provider circuit schema is ready.');
} catch (error) {
  const message = String(error?.message ?? error)
    .replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Logo provider circuit migration failed:', message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
