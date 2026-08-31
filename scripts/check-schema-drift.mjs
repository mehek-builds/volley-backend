#!/usr/bin/env node
// Fail when the database and src/db/schema.ts disagree, IN EITHER DIRECTION.
//
// Why this exists
// ---------------
// This repo uses schema-push, not committed migrations (drizzle/meta is empty), so the database is
// changed by whoever ran `db:push` last, from whatever branch they were on. That has a failure mode
// nothing else catches:
//
//   A branch runs db:push before it merges -> prod now holds a column `main` does not declare ->
//   the NEXT branch's db:push sees an undeclared column and DROPS it.
//
// It happened twice in one day (2026-07-17): `profiles.skills` and `availability_term` both ended up
// in prod while `main` declared neither, and at that point a db:push from main would have dropped 8
// columns including `application_profile.address_country`, which held real data. The type system
// cannot see this. The test suite cannot see this. Only a two-direction diff of information_schema
// against schema.ts can.
//
// The two directions are NOT the same bug:
//
//   MISSING  declared in schema.ts, absent from the DB
//            -> the app reads a column that isn't there -> a hard 500 on the first query.
//               This is the one a one-direction check finds.
//
//   EXTRA    present in the DB, not declared in schema.ts
//            -> db:push would DROP it, with whatever data it holds.
//               This is the one that bites, and the one a one-direction check misses.
//               The first version of this check only looked for MISSING and reported "in sync"
//               while prod was carrying 8 undeclared columns. Do not "simplify" it back.
//
// Usage
//   DATABASE_URL=... node scripts/check-schema-drift.mjs        # exit 1 on drift
//   npm run schema:check
//
// The connection string is only ever read from the environment and is never printed, including on
// error paths: a drift report that leaks prod credentials into a public CI log would be a worse bug
// than the one it is reporting.

import { readFileSync } from 'node:fs';
import tls from 'node:tls';
import pg from 'pg';

const SCHEMA_FILE = 'src/db/schema.ts';

// A schema this small dropping to near-zero parsed tables means the parser broke, not that the
// schema emptied. Guard the guard: a regex that silently matches nothing would report "no drift"
// forever and this whole file would become decoration. That is the exact shape of the bug it exists
// to catch, so it fails loudly instead.
const MIN_EXPECTED_TABLES = 10;

// Parses `export const x = pgTable('name', { col: type('db_col') ... })`. The DB column name is the
// string literal inside each column's builder, which is what information_schema will report.
// Name classes include digits: r030_candidate_labels was invisible to a digit-less class and
// reported as undeclared drift on every branch (2026-07-18) - the guard failing the guard.
function parseDeclaredSchema(src) {
  const tables = {};
  const tableRe = /export const \w+\s*=\s*pgTable\(\s*['"`]([a-z0-9_]+)['"`]\s*,\s*\{([\s\S]*?)\n\}\s*[,)]/g;
  for (const m of src.matchAll(tableRe)) {
    tables[m[1]] = [...m[2].matchAll(/^\s+\w+:\s*\w+\(\s*['"`]([a-zA-Z0-9_]+)['"`]/gm)].map((c) => c[1]);
  }
  return tables;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('DATABASE_URL is not set. This check needs to read the database it is comparing against.');
    process.exit(2);
  }

  const declared = parseDeclaredSchema(readFileSync(SCHEMA_FILE, 'utf8'));
  const tableCount = Object.keys(declared).length;
  if (tableCount < MIN_EXPECTED_TABLES) {
    console.error(
      `Parsed only ${tableCount} tables from ${SCHEMA_FILE} (expected at least ${MIN_EXPECTED_TABLES}).\n` +
        'The parser has probably broken rather than the schema having shrunk. Refusing to report ' +
        '"no drift" on evidence this thin: that silence is what this check exists to prevent.',
    );
    process.exit(2);
  }

  // Verification on, matching sslOptionForHost in src/db/index.ts. This one runs against the REAL
  // database before every schema change (DEPLOY.md), so it is the last place that should be the
  // loose one.
  const client = new pg.Client({
    connectionString,
    // Guarded like the other scripts and like src/db/index.ts: a LOCAL Postgres often has a
    // self-signed certificate, and forcing verification on it turns a working dev setup into a
    // connection error. `.env.example` points at localhost.
    //
    // Railway prod is reached through its public TCP proxy, whose PostgreSQL presents a
    // certificate from Railway's PRIVATE root (CN=root-ca), so the public trust store can never
    // verify it: that surfaced as "self-signed certificate in certificate chain" the day the
    // secret was repointed off Neon (2026-08-31). SCHEMA_CHECK_DATABASE_SSL_ROOT_CERT carries
    // that root, the same material src/db/index.ts pins from DATABASE_SSL_ROOT_CERT, with the
    // same literal-\n normalization because a GitHub secret can carry either form.
    //
    // The identity check names postgres.railway.internal rather than the host we dialed: the
    // certificate's SAN is [localhost, postgres.railway.internal] and the proxy hostname is not
    // in it, so default verification would reject a legitimately pinned chain. Checking the
    // internal name is still a real identity check, not a bypass: only Railway's own instance
    // holds a certificate for that SAN signed by this private root. Verified live before this
    // change shipped: the pinned handshake against the proxy reports authorized: true.
    ssl: /localhost|127\.0\.0\.1/.test(connectionString)
      ? undefined
      : process.env.SCHEMA_CHECK_DATABASE_SSL_ROOT_CERT?.trim()
        ? {
            rejectUnauthorized: true,
            ca: `${process.env.SCHEMA_CHECK_DATABASE_SSL_ROOT_CERT.trim().replace(/\\n/g, '\n')}\n`,
            checkServerIdentity: (host, cert) => tls.checkServerIdentity('postgres.railway.internal', cert),
          }
        : { rejectUnauthorized: true },
  });
  await client.connect();

  const missing = [];
  const extra = [];
  try {
    /* Whole tables that exist in the database and are declared nowhere.
     *
     * THE LOOP BELOW CANNOT SEE THESE. It iterates the tables schema.ts declares, so a table that
     * is missing from schema.ts entirely is never looked up, and this check reported "the database
     * holds nothing undeclared" while prod carried three of them: billing_webhook_events,
     * pricing_experiment_assignments and pricing_offers, all created by codex/regional-pricing's
     * apply script before the branch merged. A `db:push` from main would have dropped all three
     * with whatever they held. That is precisely the EXTRA case this file's own header calls "the
     * one that bites", so the check was blind to its own headline bug, one table at a time instead
     * of one column at a time.
     *
     * drizzle's own bookkeeping table is excluded because it is not ours to declare. */
    const DRIZZLE_INTERNAL = new Set(['__drizzle_migrations']);
    const { rows: liveTables } = await client.query(
      "select table_name from information_schema.tables where table_schema = current_schema() and table_type = 'BASE TABLE'",
    );
    for (const { table_name } of liveTables) {
      // Object.hasOwn, not `declared[table_name]`: a table named `constructor` or `toString` would
      // otherwise hit Object.prototype, read as declared, and be skipped by the check silently.
      if (DRIZZLE_INTERNAL.has(table_name) || Object.hasOwn(declared, table_name)) continue;
      // Identifiers cannot be parameterised, so this one is quoted the way Postgres quotes them,
      // doubling any embedded quote. The name comes from information_schema rather than a user,
      // but a count that reports a number is not worth leaving an interpolation question open.
      const quoted = `"${table_name.replace(/"/g, '""')}"`;
      const { rows: cnt } = await client.query(`select count(*)::int as n from ${quoted}`);
      extra.push({ what: `${table_name} (whole table)`, rows: cnt[0].n });
    }

    for (const [table, cols] of Object.entries(declared)) {
      const { rows } = await client.query(
        'select column_name from information_schema.columns where table_schema = current_schema() and table_name = $1',
        [table],
      );
      const live = rows.map((r) => r.column_name);

      if (live.length === 0) {
        missing.push({ what: `${table} (whole table)`, why: 'declared, absent from the database' });
        continue;
      }
      for (const c of cols.filter((c) => !live.includes(c))) {
        missing.push({ what: `${table}.${c}`, why: 'declared, absent from the database' });
      }
      for (const c of live.filter((c) => !cols.includes(c))) {
        // Whether it holds data decides how loud this is: dropping an empty column is a nuisance,
        // dropping a populated one is data loss.
        const { rows: cnt } = await client.query(`select count(*) filter (where "${c}" is not null)::int as n from "${table}"`);
        extra.push({ what: `${table}.${c}`, rows: cnt[0].n });
      }
    }
  } finally {
    await client.end();
  }

  console.log(`Compared ${tableCount} tables in ${SCHEMA_FILE} against the database.\n`);

  if (missing.length) {
    console.error('DECLARED BUT NOT IN THE DATABASE - the app will 500 on the first query:');
    for (const m of missing) console.error(`  - ${m.what}`);
    console.error('  Fix: apply the column, ideally `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.\n');
  }

  if (extra.length) {
    console.error('IN THE DATABASE BUT NOT DECLARED - `db:push` from this branch would DROP these:');
    for (const e of extra) console.error(`  - ${e.what}${e.rows > 0 ? `   *** HOLDS DATA (${e.rows} row${e.rows > 1 ? 's' : ''}) ***` : ''}`);
    console.error(
      '\n  This usually means another branch ran db:push before it merged. Declare the columns in\n' +
        `  ${SCHEMA_FILE} (that is the fix, not an inconvenience), or drop them deliberately if they\n` +
        '  are genuinely dead. Do NOT run db:push until this is zero.\n',
    );
  }

  if (missing.length || extra.length) {
    console.error(`Schema drift: ${missing.length} missing, ${extra.length} undeclared.`);
    process.exit(1);
  }

  console.log('No drift: every declared column exists, and the database holds nothing undeclared.');
}

// Never let a stack trace carry the connection string into a CI log.
main().catch((err) => {
  const msg = String(err?.message ?? err).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Schema drift check failed to run:', msg);
  process.exit(2);
});
