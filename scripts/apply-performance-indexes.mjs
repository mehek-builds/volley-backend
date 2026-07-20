#!/usr/bin/env node

import pg from 'pg';

const INDEXES = [
  ['contacts_company_domain_idx', 'contacts', 'company_domain'],
  ['email_resolutions_contact_id_idx', 'email_resolutions', 'contact_id'],
  ['outreach_events_user_contact_channel_idx', 'outreach_events', 'user_id, contact_id, channel'],
  ['outreach_events_user_created_idx', 'outreach_events', 'user_id, sent_at'],
  ['learning_signals_user_created_idx', 'learning_signals', 'user_id, created_at'],
  ['experience_bank_user_id_idx', 'experience_bank', 'user_id'],
  ['generated_resumes_user_created_idx', 'generated_resumes', 'user_id, created_at'],
  ['autofill_events_user_created_idx', 'autofill_events', 'user_id, created_at'],
  ['autofill_events_ats_created_idx', 'autofill_events', 'ats_name, created_at'],
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
    await client.query("set statement_timeout = '10min'");

    for (const [name, table, columns] of INDEXES) {
      const columnList = columns
        .split(',')
        .map((column) => quoteIdentifier(column.trim()))
        .join(', ');
      const sql = `create index concurrently if not exists ${quoteIdentifier(name)} on ${quoteIdentifier(table)} (${columnList})`;
      console.log(`Ensuring ${name}...`);
      await client.query(sql);
    }
  } finally {
    await client.end();
  }

  console.log(`Ready: ${INDEXES.length} production performance indexes.`);
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Index application failed:', message);
  process.exit(1);
});
