#!/usr/bin/env node

/* Adds users.application_email_forward_to, the explicit destination for employer mail that lands
 * on a Litos application alias.
 *
 * Additive and nullable, so it is safe to run before the code that reads it ships: existing rows
 * read NULL, which means "use the account email", which is exactly what happens today. The reader
 * (lib/applicationEmail.ts) also survives this migration NOT having run, because on Vercel a merge
 * is a deploy and the two can land in either order. */

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
    await client.query('alter table users add column if not exists application_email_forward_to text');

    const { rows } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'users'
          and column_name = 'application_email_forward_to'`,
    );
    if (rows.length === 0) throw new Error('users.application_email_forward_to is still missing after the migration');
  } finally {
    await client.end();
  }

  console.log('Ready: users.application_email_forward_to is present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Application email forwarding schema failed:', message);
  process.exit(1);
});
