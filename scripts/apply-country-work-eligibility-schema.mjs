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
      alter table application_profile
      add column if not exists work_eligibility_by_country text
    `);
    await client.query('commit');

    const { rows } = await client.query(`
      select data_type
      from information_schema.columns
      where table_schema = current_schema()
        and table_name = 'application_profile'
        and column_name = 'work_eligibility_by_country'
    `);
    if (rows[0]?.data_type !== 'text') {
      throw new Error('application_profile.work_eligibility_by_country is missing or is not encrypted-text compatible');
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  console.log('Ready: encrypted country work eligibility storage is present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Country work eligibility schema failed:', message);
  process.exit(1);
});
