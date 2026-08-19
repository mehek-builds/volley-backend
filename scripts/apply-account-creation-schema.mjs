#!/usr/bin/env node

/* The standing permission for Litos to OPEN AN ACCOUNT on an employer's job platform.
 *
 * RUN THIS AGAINST PRODUCTION BEFORE THE PR MERGES. Merging this repo to main IS a production
 * deploy (Vercel's own GitHub integration does it, so there is no workflow file to grep for), and
 * src/routes/onboarding.ts reads these three columns by name through schema.ts's explicit column
 * list. A deploy that leads the migration makes /onboarding/state answer 42703 for every account,
 * which is the whole product. That exact shape locked every existing user out on 2026-08-19; see
 * MIGRATION_PENDING_COLUMNS, which now names these three as its seatbelt.
 *
 * Idempotent: add column if not exists, three times, inside one transaction.
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
      add column if not exists automatic_account_creation_enabled boolean not null default false,
      add column if not exists automatic_account_creation_consented_at timestamp with time zone,
      add column if not exists automatic_account_creation_consent_version text
  `);
  await client.query('commit');
  const { rows: [granted] } = await client.query(
    'select count(*)::int as n from users where automatic_account_creation_enabled = true'
  );
  console.log(`Account creation permission columns are present. Accounts holding the grant: ${granted?.n ?? 0}.`);
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error(`Account creation schema update failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
