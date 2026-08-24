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
      drop index if exists application_email_receiving_proofs_route_fingerprint_unique
    `);
    await client.query(`
      create index if not exists application_email_receiving_proofs_route_fingerprint_idx
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

    const indexResult = await client.query(`
      select indexname, indexdef from pg_indexes
      where schemaname = current_schema() and tablename = 'application_email_receiving_proofs'
    `);
    const indexes = indexResult.rows.map((row) => ({
      name: String(row.indexname),
      definition: String(row.indexdef).replace(/"/g, ''),
    }));
    const providerMessageIsUnique = indexes.some((item) =>
      /\bunique\b/i.test(item.definition) && /\(provider_message_hash\)/i.test(item.definition));
    if (!providerMessageIsUnique) throw new Error('Receiving proof provider_message_hash is not uniquely indexed');

    const routeIndex = indexes.find((item) => item.name === 'application_email_receiving_proofs_route_fingerprint_idx');
    if (!routeIndex || /\bunique\b/i.test(routeIndex.definition)) {
      throw new Error('Receiving proof route_fingerprint append-only index is missing or unique');
    }
    const obsoleteUnique = indexes.find((item) =>
      /\bunique\b/i.test(item.definition) && /\(route_fingerprint\)/i.test(item.definition));
    if (obsoleteUnique) throw new Error(`Receiving proof route_fingerprint is still unique: ${obsoleteUnique.name}`);
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
