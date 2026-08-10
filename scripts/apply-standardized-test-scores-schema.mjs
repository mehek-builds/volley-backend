#!/usr/bin/env node

/* Standardized test scores, plus the authoritative coursework list.
 *
 * MEASURED, NOT GUESSED. Counted over the owner account's full 158-packet corpus on 2026-08-11,
 * from attention_reason lines of the shape `"X" is required and is still empty`, as DISTINCT
 * packets blocked:
 *
 *   standardized test score type    9
 *   SAT score                       9
 *   ACT score                       9
 *
 * The 2026-08-08 facts migration explicitly left these out, and its header records why: "Fields
 * that appeared on exactly one posting (SAT/ACT scores at IMC) were deliberately left out rather
 * than added speculatively." That was right at 25 packets. At 158 each of the three clears the
 * two-posting bar the rest of that group was chosen by, four times over.
 *
 * coursework is on `profiles`, not `application_profile`, and the split is deliberate: it belongs
 * with `skills` as a student-declared list the resume tailorer must be able to read, whereas
 * application_profile's contract is "sensitive, encrypted, never in a drafting-LLM prompt". See
 * the comments on both columns in src/db/schema.ts.
 *
 * ALL FOUR ARE NULLABLE AND NOTHING IS BACKFILLED. Null means "never asked" and the resolver
 * refuses on it, so an existing account is ASKED rather than silently given a default. Inventing a
 * test score would be a checkable false claim about an academic record made to an employer, which
 * is the exact defect class this column group exists to remove.
 *
 * Idempotent: `add column if not exists` throughout, and the verification below re-reads
 * information_schema rather than trusting the DDL to have done what it said.
 */

import pg from 'pg';

const APPLICATION_PROFILE_COLUMNS = ['standardized_test_type', 'sat_score', 'act_score'];

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
      alter table application_profile
      add column if not exists standardized_test_type text,
      add column if not exists sat_score text,
      add column if not exists act_score text
    `);
    await client.query(`
      alter table profiles
      add column if not exists coursework jsonb
    `);
    await client.query('commit');

    const { rows } = await client.query(
      `
      select table_name, column_name, data_type, is_nullable
      from information_schema.columns
      where table_schema = current_schema()
        and (
          (table_name = 'application_profile' and column_name = any($1))
          or (table_name = 'profiles' and column_name = 'coursework')
        )
      `,
      [APPLICATION_PROFILE_COLUMNS],
    );
    const found = new Map(rows.map((row) => [`${row.table_name}.${row.column_name}`, row]));

    for (const column of APPLICATION_PROFILE_COLUMNS) {
      const row = found.get(`application_profile.${column}`);
      if (!row) throw new Error(`application_profile.${column} is missing`);
      if (row.data_type !== 'text') {
        throw new Error(`application_profile.${column} is ${row.data_type}, expected text`);
      }
      // A NOT NULL here would destroy the one state the resolver depends on: "never asked".
      if (row.is_nullable !== 'YES') {
        throw new Error(`application_profile.${column} must stay nullable; null means never asked`);
      }
    }

    const coursework = found.get('profiles.coursework');
    if (!coursework) throw new Error('profiles.coursework is missing');
    if (coursework.data_type !== 'jsonb') {
      throw new Error(`profiles.coursework is ${coursework.data_type}, expected jsonb`);
    }
    if (coursework.is_nullable !== 'YES') {
      throw new Error('profiles.coursework must stay nullable; null means never asked and [] means none');
    }
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  console.log('Ready: standardized test score columns and the coursework list are present.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Standardized test scores schema failed:', message);
  process.exit(1);
});
