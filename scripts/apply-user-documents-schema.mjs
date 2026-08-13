#!/usr/bin/env node

/* Creates user_documents, the table behind "attach your transcript once and stop being asked".
 *
 * WHY A NEW TABLE AND NOT A COLUMN. This is the whole design and it is a deploy-safety argument,
 * not a modelling preference. Drizzle names every declared column in the INSERT column list, and
 * compiles `db.select().from(profiles)` to an explicit column list too. There are 29 unguarded
 * `.from(profiles)` reads and exactly one `.insert(profiles)` (src/routes/profile.ts:820), and none
 * of them carries the isUndefinedColumnError guard that application_profile reads have. So a column
 * declared on profiles before this migration runs does not degrade one screen, it 42703s every
 * signup, every resume upload, onboarding state, autofill, /account/export, the base-resume build,
 * jdMatch, jobMonitor ranking, cover letters and the submission runner at once, for the length of
 * the window. A table nothing has ever selected from cannot do that in either order, because no
 * existing query names it.
 *
 * THE ORDER STILL MATTERS, for a smaller reason: scripts/check-schema-drift.mjs exits 1 on EXTRA as
 * well as MISSING, and an undeclared table counts. Run this, then merge within minutes, and do not
 * run db:push in that window - a push from a branch that does not declare user_documents would drop
 * it along with whatever a student had already attached.
 *
 * WHY THE FILE IS NOT IN THIS TABLE. byte_size is the plaintext length, object_key and blob_url
 * point at Vercel Blob, and what sits at the other end is AES-256-GCM ciphertext (see
 * src/lib/documentCrypto.ts). Blob objects can only be written `access: 'public'` on the version we
 * are on, so anyone holding the URL can read the bytes forever; encrypting before the write is what
 * makes "we encrypt it and keep it until you remove it" a sentence the build can honour. blob_url
 * is a column rather than a resolveBlobUrl call because that resolver is list-backed and eventually
 * consistent with no bound, measured 404ing 54 seconds after a write.
 *
 * The table is NOT backfilled and cannot be: there is no existing store of student-attached files
 * anywhere. Every row here arrives from an upload she performed herself.
 *
 * Run against PRODUCTION with the Neon URL, not the localhost DATABASE_URL in .env:
 *   DATABASE_URL="$(grep '^DATABASE_URL=' .env.local | cut -d= -f2-)" npm run db:user-documents
 */

import pg from 'pg';

const STATEMENTS = [
  `create table if not exists user_documents (
     id uuid primary key default gen_random_uuid(),
     user_id uuid not null references users(id) on delete cascade,
     kind text not null,
     file_name text not null,
     content_type text not null,
     byte_size integer not null,
     object_key text not null,
     blob_url text not null,
     encryption_scheme text not null,
     reusable boolean not null default true,
     deleted_at timestamptz,
     last_used_at timestamptz,
     first_application_id uuid,
     created_at timestamptz not null default now(),
     updated_at timestamptz not null default now()
   )`,
  `create index if not exists user_documents_user_kind_idx
     on user_documents (user_id, kind, created_at)`,
];

const EXPECTED_TABLES = ['user_documents'];

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

    for (const statement of STATEMENTS) {
      // Every statement is `create ... if not exists` on a table nothing reads yet, so this takes
      // no lock on anything in the serving path and is safe to re-run.
      await client.query(statement);
    }

    const { rows } = await client.query(
      `select table_name from information_schema.tables
        where table_schema = current_schema()
          and table_name = any($1::text[])`,
      [EXPECTED_TABLES],
    );
    const present = new Set(rows.map((row) => row.table_name));
    const missing = EXPECTED_TABLES.filter((table) => !present.has(table));
    if (missing.length > 0) {
      throw new Error(`still missing after the migration: ${missing.join(', ')}`);
    }
  } finally {
    await client.end();
  }

  console.log('Ready: user_documents exists. It is empty, and there is nothing to backfill it from.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('User documents schema failed:', message);
  process.exit(1);
});
