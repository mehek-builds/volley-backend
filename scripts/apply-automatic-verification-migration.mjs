#!/usr/bin/env node

import pg from 'pg';

const COLUMNS = [
  {
    name: 'automatic_verification_enabled',
    definition: 'boolean not null default false',
  },
  {
    name: 'automatic_verification_consented_at',
    definition: 'timestamp with time zone',
  },
];

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

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
    for (const column of COLUMNS) {
      console.log(`Ensuring users.${column.name}...`);
      await client.query(
        `alter table "users" add column if not exists ${quoteIdentifier(column.name)} ${column.definition}`,
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log('Ready: automatic verification consent columns are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Automatic verification migration failed:', message);
  process.exit(1);
});
