#!/usr/bin/env node

/* Adds application_email_messages.forward_decision, the record of what the forwarding router
 * decided about one stored message: 'forward' or 'withheld:<reason>'.
 *
 * It exists because a deliberately dropped message used to be indistinguishable from an
 * unprocessed one. Both carried direction 'inbound', forwarded_at NULL and forward_error NULL, so
 * a policy that stopped delivering mail entirely could not be counted or noticed from the row.
 * forward_error could not carry this: it means "the send was attempted and failed", and reusing it
 * would erase the difference between a bug and a decision.
 *
 * Additive and nullable, so it is safe to run before or after the code that writes it: existing
 * rows read NULL, which is the truth about them, and the writer (lib/applicationEmail.ts,
 * recordForwardDecision) survives this migration NOT having run, because on Vercel a merge is a
 * deploy and the two can land in either order. */

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
    await client.query('alter table application_email_messages add column if not exists forward_decision text');

    const { rows } = await client.query(
      `select column_name from information_schema.columns
        where table_schema = current_schema()
          and table_name = 'application_email_messages'
          and column_name = 'forward_decision'`,
    );
    if (rows.length === 0) {
      throw new Error('application_email_messages.forward_decision is still missing after the migration');
    }
  } finally {
    await client.end();
  }

  console.log('Ready: application_email_messages.forward_decision is present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Application email forward decision schema failed:', message);
  process.exit(1);
});
