#!/usr/bin/env node

import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Refusing to change any database.');
  process.exit(2);
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });

try {
  await client.connect();
  await client.query('begin');
  await client.query(`
    alter table users
      add column if not exists automatic_submission_enabled boolean not null default false,
      add column if not exists automatic_submission_consented_at timestamp,
      add column if not exists automatic_submission_consent_version text,
      add column if not exists automatic_verification_enabled boolean not null default false,
      add column if not exists automatic_verification_consented_at timestamp
  `);
  await client.query('commit');
  console.log('Automation consent columns are present.');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error(`Automation consent schema update failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
