#!/usr/bin/env node

/* The notification subsystem's storage: two permissions on the account, and the send ledger that
 * is also the rate limiter.
 *
 * RUN THIS AGAINST PRODUCTION BEFORE THE PR MERGES. Merging this repo to main IS a production
 * deploy (Vercel's GitHub integration does it; there is no workflow file to grep for), and
 * src/routes/notifications.ts reads these columns by name.
 *
 * GET /notifications/preferences survives the window on its own - it catches 42703 and reports
 * every permission as off, which is what an un-migrated database effectively holds - but the PUT
 * deliberately does NOT fail open, and nothing at all covers a missing notification_sends table.
 * Those fallbacks are seatbelts, not a licence to merge first.
 *
 * Idempotent: add column if not exists, create table if not exists, create index if not exists.
 * Safe to run twice, safe to run against a database that already has some of it.
 */

import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Refusing to change any database.');
  process.exit(2);
}

const client = new pg.Client({ connectionString });

try {
  await client.connect();
  await client.query('begin');

  await client.query(`
    alter table users
      add column if not exists notify_strong_match_enabled boolean not null default false,
      add column if not exists notify_strong_match_granted_at timestamp with time zone,
      add column if not exists notify_employer_reply_enabled boolean not null default false,
      add column if not exists notify_employer_reply_granted_at timestamp with time zone,
      add column if not exists notify_activity_digest_enabled boolean not null default false,
      add column if not exists notify_activity_digest_granted_at timestamp with time zone
  `);

  /* One browser on one device that has agreed to be interrupted. Per device rather than per
     account, which is the shape of the Web Push standard: see the table comment in db/schema.ts.
     The endpoint is the identity and the unique index on it is what stops a row per page load. */
  await client.query(`
    create table if not exists push_subscriptions (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      endpoint text not null,
      p256dh text not null,
      auth text not null,
      user_agent text,
      created_at timestamp with time zone not null default now(),
      last_success_at timestamp with time zone,
      failure_count integer not null default 0
    )
  `);
  await client.query(`
    create unique index if not exists push_subscriptions_endpoint_unique
      on push_subscriptions (endpoint)
  `);
  await client.query(`
    create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id)
  `);

  await client.query(`
    create table if not exists notification_sends (
      id uuid primary key default gen_random_uuid(),
      user_id uuid not null references users(id) on delete cascade,
      kind text not null,
      daily_slot text,
      dedupe_key text not null,
      monitored_job_id uuid references monitored_jobs(id) on delete set null,
      application_email_message_id uuid references application_email_messages(id) on delete set null,
      provider_message_id text,
      sent_at timestamp with time zone,
      created_at timestamp with time zone not null default now()
    )
  `);

  /* THE TWO UNIQUE INDEXES ARE THE FEATURE, not housekeeping. The first IS the one-a-day limiter
     (NULL daily_slot never collides, which is how an uncapped kind opts out of it); the second is
     what stops one posting or one inbound message being announced twice. Without them the send
     path's reserve-then-send has nothing to lose a race against and the cap is decorative. */
  await client.query(`
    create unique index if not exists notification_sends_daily_slot_unique
      on notification_sends (user_id, daily_slot)
  `);
  await client.query(`
    create unique index if not exists notification_sends_dedupe_key_unique
      on notification_sends (dedupe_key)
  `);
  await client.query(`
    create index if not exists notification_sends_user_created_idx
      on notification_sends (user_id, created_at)
  `);

  await client.query('commit');
  console.log('Notification preference columns, the notification_sends ledger and push_subscriptions are present.');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error(`Notification schema update failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
