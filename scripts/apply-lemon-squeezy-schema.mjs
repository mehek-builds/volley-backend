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
    for (const statement of [
      'alter table "users" add column if not exists "billing_provider" text',
      'alter table "users" add column if not exists "billing_customer_id" text',
      'alter table "users" add column if not exists "billing_subscription_id" text',
      'alter table "users" add column if not exists "billing_variant_id" text',
      'alter table "users" add column if not exists "billing_status" text',
      'alter table "users" add column if not exists "billing_renews_at" timestamp with time zone',
      'alter table "users" add column if not exists "billing_ends_at" timestamp with time zone',
      'alter table "users" add column if not exists "billing_portal_url" text',
      'alter table "users" add column if not exists "billing_event_updated_at" timestamp with time zone',
      'create unique index if not exists "users_billing_subscription_unique" on "users" ("billing_subscription_id") where "billing_subscription_id" is not null',
    ]) await client.query(statement);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  console.log('Ready: Lemon Squeezy subscription state columns are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Lemon Squeezy migration failed:', message);
  process.exit(1);
});
