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
import pg from 'pg';

const SCHEMA_FILE = 'src/db/schema.ts';

// A schema this small dropping to near-zero parsed tables means the parser broke, not that the
// schema emptied. Guard the guard: a regex that silently matches nothing would report "no drift"
// forever and this whole file would become decoration. That is the exact shape of the bug it exists
// to catch, so it fails loudly instead.
const MIN_EXPECTED_TABLES = 10;

// Parses `export const x = pgTable('name', { col: type('db_col') ... })`. The DB column name is the
// string literal inside each column's builder, which is what information_schema will report.
function parseDeclaredSchema(src) {
  const tables = {};
  const tableRe = /export const \w+\s*=\s*pgTable\(\s*['"`]([a-z_]+)['"`]\s*,\s*\{([\s\S]*?)\n\}\s*[,)]/g;
  for (const m of src.matchAll(tableRe)) {
    tables[m[1]] = [...m[2].matchAll(/^\s+\w+:\s*\w+\(\s*['"`]([a-zA-Z_]+)['"`]/gm)].map((c) => c[1]);
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

  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const missing = [];
  const extra = [];
  try {
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
