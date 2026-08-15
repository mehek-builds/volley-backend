#!/usr/bin/env node

/* Gives existing accounts the resume address the code now sets at upload time.
 *
 * WHY. `profiles.parsed_json.resume_email` is read by the base resume, the tailored resume, the
 * packet audit and the academic-email answer, and until 2026-08-16 nothing wrote it: the parser
 * extracts no email, so its only source was a text box under "Edit parsed details" in Documents
 * that onboarding never mentions. Measured on production that day, 16 of 17 profiles had none, and
 * the base resume's ATS gate refused to save a resume for every one of them.
 *
 * The code fix seeds this at upload. That only helps an account that uploads AGAIN, so anyone
 * already stuck stays stuck until this runs.
 *
 * WHAT IT WRITES. `users.email`, the verified login address, for accounts that have one and no
 * resume_email yet. That is the same value `GET /resume/base/file` already prints and the same one
 * routes/profile.ts now stores on upload, so this introduces no value the product was not already
 * showing. It is stored where the student can see and change it, in Documents.
 *
 * WHAT IT REFUSES TO TOUCH:
 *   - any profile that already has a resume_email, because that one is the student's own choice
 *   - guests, who have no login email; there is nothing truthful to write, and the ATS gate no
 *     longer blocks them when the resume carries a phone an employer can call
 *
 * Idempotent. Safe to run twice; the second run reports 0 rows.
 */

import pg from 'pg';

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set.');
    process.exit(2);
  }
  const dryRun = process.argv.includes('--dry-run');

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("set lock_timeout = '5s'");
    await client.query("set statement_timeout = '2min'");

    const candidates = await client.query(`
      select u.id, u.email
      from profiles p
      join users u on u.id = p.user_id
      where p.parsed_json->>'resume_email' is null
        and u.email is not null
        and btrim(u.email) <> ''
        and u.is_guest = false
      order by u.email
    `);

    console.log(`${candidates.rowCount} profile(s) need a resume email.`);
    for (const row of candidates.rows) console.log(`  ${row.email}`);

    if (dryRun) {
      console.log('Dry run, nothing written.');
      return;
    }

    /* jsonb_set on the existing document rather than a rewrite: parsed_json holds the whole parse,
       and replacing it here would discard everything the upload put there. */
    const updated = await client.query(`
      update profiles p
      set parsed_json = jsonb_set(
            coalesce(p.parsed_json, '{}'::jsonb),
            '{resume_email}',
            to_jsonb(lower(btrim(u.email))),
            true
          ),
          updated_at = now()
      from users u
      where u.id = p.user_id
        and p.parsed_json->>'resume_email' is null
        and u.email is not null
        and btrim(u.email) <> ''
        and u.is_guest = false
    `);
    console.log(`Updated ${updated.rowCount} profile(s).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
