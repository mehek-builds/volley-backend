import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

function migrationDdl(): string[] {
  const source = readFileSync('scripts/apply-application-email-receiving-proof-schema.mjs', 'utf8');
  return [...source.matchAll(/await client\.query\(`([\s\S]*?)`\);/g)]
    .map((match) => match[1])
    .filter((statement) => /application_email_receiving_proofs/i.test(statement)
      && !/information_schema|pg_indexes/i.test(statement));
}

test('receiving-proof migration converts the old one-row route table into an append-only event ledger', async () => {
  const database = await PGlite.create();
  try {
    await database.exec(`
      create table application_email_receiving_proofs (
        provider_message_hash text primary key,
        route_fingerprint text not null,
        proof_version integer not null,
        domain text not null,
        verified_at timestamptz not null,
        created_at timestamptz not null default now()
      );
      create unique index application_email_receiving_proofs_route_fingerprint_unique
      on application_email_receiving_proofs(route_fingerprint);
      insert into application_email_receiving_proofs
        (provider_message_hash, route_fingerprint, proof_version, domain, verified_at)
      values ('hash-a', 'route-one', 3, 'example.resend.app', '2026-08-17T12:00:00Z');
    `);

    for (const statement of migrationDdl()) await database.exec(statement);

    await database.exec(`
      insert into application_email_receiving_proofs
        (provider_message_hash, route_fingerprint, proof_version, domain, verified_at)
      values ('hash-b', 'route-one', 3, 'example.resend.app', '2026-08-24T12:00:00Z')
      on conflict do nothing;
      insert into application_email_receiving_proofs
        (provider_message_hash, route_fingerprint, proof_version, domain, verified_at)
      values ('hash-a', 'route-one', 3, 'example.resend.app', '2026-08-25T12:00:00Z')
      on conflict do nothing;
      insert into application_email_receiving_proofs
        (provider_message_hash, route_fingerprint, proof_version, domain, verified_at)
      values ('hash-b', 'route-one', 3, 'example.resend.app', '2026-08-25T12:00:00Z')
      on conflict do nothing;
    `);

    const proofs = await database.query<{
      provider_message_hash: string;
      verified_at: Date;
    }>(`
      select provider_message_hash, verified_at
      from application_email_receiving_proofs
      order by provider_message_hash
    `);
    assert.equal(proofs.rows.length, 2);
    assert.deepEqual(proofs.rows.map((row) => row.provider_message_hash), ['hash-a', 'hash-b']);
    assert.equal(new Date(proofs.rows[0].verified_at).toISOString(), '2026-08-17T12:00:00.000Z');
    assert.equal(new Date(proofs.rows[1].verified_at).toISOString(), '2026-08-24T12:00:00.000Z');

    const indexes = await database.query<{ indexname: string; indexdef: string }>(`
      select indexname, indexdef from pg_indexes
      where tablename = 'application_email_receiving_proofs'
      order by indexname
    `);
    const normalized = indexes.rows.map((row) => ({
      name: row.indexname,
      definition: row.indexdef.replace(/"/g, ''),
    }));
    assert.equal(normalized.some((item) => item.name === 'application_email_receiving_proofs_route_fingerprint_unique'), false);
    const routeIndex = normalized.find((item) => item.name === 'application_email_receiving_proofs_route_fingerprint_idx');
    assert.ok(routeIndex);
    assert.doesNotMatch(routeIndex.definition, /\bunique\b/i);
    assert.equal(normalized.some((item) =>
      /\bunique\b/i.test(item.definition) && /\(route_fingerprint\)/i.test(item.definition)), false);
  } finally {
    await database.close();
  }
});
