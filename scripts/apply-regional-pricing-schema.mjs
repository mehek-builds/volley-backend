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
      'alter table "users" add column if not exists "pricing_country" text',
      'alter table "users" add column if not exists "pricing_band" text',
      'alter table "users" add column if not exists "pricing_policy_version" text',
      'alter table "users" add column if not exists "pricing_experiment_id" text',
      'alter table "users" add column if not exists "pricing_experiment_variant" text',
      'alter table "users" add column if not exists "pricing_interval" text',
      'alter table "users" add column if not exists "pricing_currency" text',
      'alter table "users" add column if not exists "pricing_amount_cents" integer',
      'alter table "users" add column if not exists "pricing_verification_status" text',
      `create table if not exists "pricing_experiment_assignments" (
        "user_id" uuid not null references "users"("id") on delete cascade,
        "experiment_id" text not null,
        "variant" text not null,
        "assigned_at" timestamp with time zone not null default now(),
        primary key ("user_id", "experiment_id")
      )`,
      `create table if not exists "pricing_offers" (
        "id" uuid primary key default gen_random_uuid(),
        "user_id" uuid not null references "users"("id") on delete cascade,
        "subject_id" text not null,
        "idempotency_key" text not null,
        "quote_token_hash" text,
        "policy_version" text not null,
        "country_code" text not null,
        "detected_country_code" text,
        "requested_country_code" text,
        "billing_country_code" text,
        "country_mismatch" boolean not null default false,
        "band" text not null,
        "experiment_id" text,
        "experiment_variant" text not null,
        "billing_interval" text not null,
        "currency" text not null,
        "base_amount_cents" integer not null,
        "amount_cents" integer not null,
        "status" text not null default 'creating',
        "provider_checkout_id" text,
        "provider_checkout_url" text,
        "provider_customer_id" text,
        "provider_subscription_id" text,
        "expires_at" timestamp with time zone not null,
        "checkout_created_at" timestamp with time zone,
        "paid_at" timestamp with time zone,
        "verified_at" timestamp with time zone,
        "created_at" timestamp with time zone not null default now(),
        "updated_at" timestamp with time zone not null default now()
      )`,
      'create unique index if not exists "pricing_offers_idempotency_unique" on "pricing_offers" ("idempotency_key")',
      'create unique index if not exists "pricing_offers_checkout_unique" on "pricing_offers" ("provider_checkout_id") where "provider_checkout_id" is not null',
      'create index if not exists "pricing_offers_subscription_idx" on "pricing_offers" ("provider_subscription_id")',
      'create index if not exists "pricing_offers_user_created_idx" on "pricing_offers" ("user_id", "created_at")',
      'create index if not exists "pricing_offers_experiment_created_idx" on "pricing_offers" ("experiment_id", "created_at")',
      `create table if not exists "billing_webhook_events" (
        "event_key" text primary key,
        "provider" text not null,
        "event_name" text,
        "result" text not null default 'processing',
        "received_at" timestamp with time zone not null default now(),
        "processed_at" timestamp with time zone
      )`,
    ]) await client.query(statement);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  console.log('Ready: regional pricing tables and user snapshot columns are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Regional pricing migration failed:', message);
  process.exit(1);
});
