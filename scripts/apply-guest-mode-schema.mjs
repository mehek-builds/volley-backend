#!/usr/bin/env node

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
    await client.query('begin');
    await client.query('alter table "users" alter column "email" drop not null');
    await client.query('alter table "users" add column if not exists "is_guest" boolean not null default false');
    await client.query('alter table "users" add column if not exists "guest_key_hash" text');
    await client.query('alter table "users" add column if not exists "guest_expires_at" timestamp with time zone');
    await client.query('alter table "users" add column if not exists "claimed_at" timestamp with time zone');
    await client.query(
      'create unique index if not exists "users_guest_key_hash_unique" on "users" ("guest_key_hash") where "guest_key_hash" is not null',
    );
    // Drizzle emits ON CONFLICT (guest_key_hash) without a predicate. PostgreSQL
    // cannot infer the partial index above for that conflict target. A regular
    // unique index is safe because PostgreSQL permits multiple NULL values.
    await client.query(
      'create unique index if not exists "users_guest_key_hash_conflict_unique" on "users" ("guest_key_hash")',
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log('Ready: guest mode user columns and index are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Guest mode migration failed:', message);
  process.exit(1);
});
