#!/usr/bin/env node

/* The standing permission to accept an employer's privacy statement, terms or code of conduct.
 *
 * RUN THIS AGAINST PRODUCTION BEFORE THE PR MERGES. Merging this repo to main IS a production
 * deploy (there is no workflow file to grep for; Vercel's own GitHub integration does it), and
 * src/routes/onboarding.ts reads these three columns by name. A deploy that leads the migration
 * makes /onboarding/state 42703 for every account, which is the whole product.
 *
 * The one read on the submission hot path, loadApplicationProfileLike, is written to survive the
 * window on its own: it catches 42703 and falls back to the pre-existing projection, which reads
 * the permission as never granted and therefore behaves exactly as main does today. That fallback
 * is a seatbelt for the runner, not a licence to merge first.
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
      add column if not exists automatic_consent_acceptance_enabled boolean not null default false,
      add column if not exists automatic_consent_acceptance_consented_at timestamp with time zone,
      add column if not exists automatic_consent_acceptance_consent_version text,
      add column if not exists automatic_conduct_acceptance_enabled boolean not null default false,
      add column if not exists automatic_conduct_acceptance_consented_at timestamp with time zone,
      add column if not exists automatic_conduct_acceptance_consent_version text
  `);
  await client.query('commit');
  console.log('Consent acceptance permission columns are present.');
} catch (error) {
  await client.query('rollback').catch(() => undefined);
  console.error(`Consent acceptance schema update failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => undefined);
}
