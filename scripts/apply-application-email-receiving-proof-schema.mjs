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
      create table if not exists application_email_receiving_proofs (
        provider_message_hash text primary key,
        route_fingerprint text not null,
        proof_version integer not null,
        domain text not null,
        verified_at timestamptz not null,
        created_at timestamptz not null default now()
      )
    `);
    await client.query(`
      create unique index if not exists application_email_receiving_proofs_route_fingerprint_unique
      on application_email_receiving_proofs(route_fingerprint)
    `);
    await client.query(`
      create index if not exists application_email_receiving_proofs_verified_at_idx
      on application_email_receiving_proofs(verified_at)
    `);
    await client.query('commit');
    const { rows } = await client.query(`
      select column_name from information_schema.columns
      where table_schema = current_schema() and table_name = 'application_email_receiving_proofs'
    `);
    const present = new Set(rows.map((row) => row.column_name));
    const required = ['provider_message_hash', 'route_fingerprint', 'proof_version', 'domain', 'verified_at', 'created_at'];
    const missing = required.filter((column) => !present.has(column));
    if (missing.length > 0) throw new Error(`Receiving proof columns still missing: ${missing.join(', ')}`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  console.log('Ready: application email receiving proof schema is present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Application email receiving proof schema failed:', message);
  process.exit(1);
});
