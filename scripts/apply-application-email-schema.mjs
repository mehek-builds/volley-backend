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
        alias text primary key,
        user_id uuid not null references users(id) on delete cascade,
        generated_resume_id uuid references generated_resumes(id) on delete cascade,
        forward_to text not null,
        status text not null default 'active',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `);
    await client.query('create index if not exists application_email_aliases_user_id_idx on application_email_aliases(user_id)');
    await client.query('create index if not exists application_email_aliases_resume_id_idx on application_email_aliases(generated_resume_id)');
    await client.query(`
      create table if not exists application_email_messages (
        id uuid primary key default gen_random_uuid(),
        alias text not null references application_email_aliases(alias) on delete cascade,
        user_id uuid not null references users(id) on delete cascade,
        generated_resume_id uuid references generated_resumes(id) on delete cascade,
        direction text not null,
        provider text,
        provider_message_id text,
        from_email text,
        to_email text,
        subject text,
        text text,
        html text,
        classification text not null default 'other',
        raw_json jsonb,
        received_at timestamptz,
        forwarded_at timestamptz,
        created_at timestamptz not null default now()
      )
    `);
    await client.query('create index if not exists application_email_messages_user_created_idx on application_email_messages(user_id, created_at)');
    await client.query('create index if not exists application_email_messages_alias_created_idx on application_email_messages(alias, created_at)');
    await client.query(`
      create unique index if not exists application_email_messages_provider_id_unique
      on application_email_messages(provider, provider_message_id)
      where provider_message_id is not null
    `);
    await client.query('commit');

    const { rows } = await client.query(
      `select table_name from information_schema.tables
        where table_schema = current_schema() and table_name = any($1::text[])`,
      [['application_email_aliases', 'application_email_messages']],
    );
    const present = new Set(rows.map((row) => row.table_name));
    const missing = ['application_email_aliases', 'application_email_messages'].filter((table) => !present.has(table));
    if (missing.length > 0) {
      throw new Error(`Tables still missing after migration: ${missing.join(', ')}`);
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log('Ready: application email schema is present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Application email schema failed:', message);
  process.exit(1);
});
