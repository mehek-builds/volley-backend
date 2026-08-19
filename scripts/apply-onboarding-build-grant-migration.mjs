#!/usr/bin/env node

/* The one tailored build a new account gets before it is asked for a card.
 *
 * Onboarding shows a real posting and builds a real application for it at step 3, and the card is
 * taken at step 10. Tailoring is a Litos+ feature and a new account is `free_new` with no trial
 * (the trial is a Stripe subscription with a card attached now, not a signup grant), so without
 * this column every new account stops dead at step 3 on "This action is part of Litos+".
 *
 * One column, one stamp, first-write-wins. Null means unused; a timestamp means spent and it is
 * never spent twice, because the claim is a conditional UPDATE rather than a read followed by a
 * write. See src/lib/onboardingBuildGrant.ts.
 */

import pg from 'pg';

const COLUMNS = [
  {
    name: 'onboarding_build_granted_at',
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

  console.log('Ready: the onboarding build grant column is present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Onboarding build grant migration failed:', message);
  process.exit(1);
});
