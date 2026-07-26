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
    await client.query('alter table "users" add column if not exists "password_hash" text');
    await client.query('alter table "users" add column if not exists "session_version" integer not null default 0');
  } finally {
    await client.end();
  }

  console.log('Ready: Litos users can store Argon2id password credentials.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Password auth migration failed:', message);
  process.exit(1);
});
