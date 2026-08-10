#!/usr/bin/env node
// portal_credentials: the account Litos holds on an employer ATS tenant.
//
// Run against a database, never against a live employer portal. The table holds one row per
// (user_id, portal_family, tenant); the unique index is the part that matters, because a second
// account on the same tenant is how an applicant gets locked out of the first one.
//
// The password column holds AES-256-GCM ciphertext produced by src/lib/fieldCrypto.ts. Nothing in
// this script reads, prints, or transforms a stored value.

import pg from 'pg';

const TABLE = 'portal_credentials';

const REQUIRED_COLUMNS = [
  'id',
  'user_id',
  'portal_family',
  'tenant',
  'username',
  'password_encrypted',
  'created_at',
  'updated_at',
  'last_used_at',
  'last_revealed_at',
  'reveal_count',
];

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
    await client.query(`
      create table if not exists portal_credentials (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        portal_family text not null,
        tenant text not null,
        username text not null,
        password_encrypted text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        last_used_at timestamptz,
        last_revealed_at timestamptz,
        reveal_count integer not null default 0
      )
    `);
    // Added separately so a database that already carries an earlier shape of this table gains the
    // audit columns rather than silently keeping a table the app declares differently.
    await client.query('alter table portal_credentials add column if not exists last_used_at timestamptz');
    await client.query('alter table portal_credentials add column if not exists last_revealed_at timestamptz');
    await client.query('alter table portal_credentials add column if not exists reveal_count integer not null default 0');
    await client.query(`
      create unique index if not exists portal_credentials_user_family_tenant_unique
      on portal_credentials(user_id, portal_family, tenant)
    `);
    await client.query('create index if not exists portal_credentials_user_id_idx on portal_credentials(user_id)');
    await client.query('commit');

    const { rows } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = current_schema() and table_name = $1`,
      [TABLE],
    );
    const present = new Set(rows.map((row) => row.column_name));
    const missing = REQUIRED_COLUMNS.filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new Error(`Columns still missing after migration: ${missing.join(', ')}`);
    }
    const { rows: indexes } = await client.query(
      'select indexname from pg_indexes where schemaname = current_schema() and tablename = $1',
      [TABLE],
    );
    const indexNames = new Set(indexes.map((row) => row.indexname));
    if (!indexNames.has('portal_credentials_user_family_tenant_unique')) {
      throw new Error('The one-account-per-tenant unique index is missing after migration.');
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log('Ready: portal credentials schema is present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Portal credentials schema failed:', message);
  process.exit(1);
});
