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
    await client.query(`
      create table if not exists application_email_aliases (
        id uuid primary key default gen_random_uuid(),
        user_id uuid not null references users(id) on delete cascade,
        generated_resume_id uuid not null references generated_resumes(id) on delete cascade,
        local_part text not null unique,
        email text not null unique,
        forwarding_email text not null,
        enabled boolean not null default true,
        created_at timestamp with time zone not null default now(),
        updated_at timestamp with time zone not null default now()
      )
    `);
    await client.query(`
      create unique index if not exists application_email_aliases_resume_unique
      on application_email_aliases(generated_resume_id)
    `);
    await client.query(`
      create index if not exists application_email_aliases_user_idx
      on application_email_aliases(user_id)
    `);
    await client.query(`
      create table if not exists application_email_messages (
        id uuid primary key default gen_random_uuid(),
        alias_id uuid not null references application_email_aliases(id) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        generated_resume_id uuid references generated_resumes(id) on delete cascade,
        provider_message_id text,
        from_email text,
        from_name text,
        to_email text not null,
        subject text not null,
        text_body text,
        html_body text,
        dedupe_key text not null unique,
        raw_json jsonb,
        forwarded_message_id text,
        forwarding_claimed_at timestamp with time zone,
        forwarded_at timestamp with time zone,
        forward_error text,
        created_at timestamp with time zone not null default now()
      )
    `);
    await client.query(`
      create index if not exists application_email_messages_alias_created_idx
      on application_email_messages(alias_id, created_at)
    `);
    await client.query(`
      create index if not exists application_email_messages_user_created_idx
      on application_email_messages(user_id, created_at)
    `);
    await client.query(`
      create index if not exists application_email_messages_provider_message_idx
      on application_email_messages(provider_message_id)
    `);
    await client.query(`
      alter table application_email_messages
      add column if not exists dedupe_key text
    `);
    await client.query(`
      alter table application_email_messages
      add column if not exists forwarding_claimed_at timestamp with time zone
    `);
    await client.query(`
      update application_email_messages
      set dedupe_key = coalesce(provider_message_id, id::text)
      where dedupe_key is null
    `);
    await client.query(`
      alter table application_email_messages
      alter column dedupe_key set not null
    `);
    await client.query(`
      create unique index if not exists application_email_messages_dedupe_unique
      on application_email_messages(dedupe_key)
    `);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log('Ready: application email aliases and routed message tables are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Application email migration failed:', message);
  process.exit(1);
});
