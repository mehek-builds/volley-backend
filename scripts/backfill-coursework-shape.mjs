#!/usr/bin/env node
/*
 * ISSUE-044: parsed_json.coursework rows stored as a JSON STRING, back to the JSON ARRAY every
 * reader of that field expects.
 *
 * PATCH /profile/parsed used to write the review screen's one comma separated line straight into
 * parsed_json, turning the parser's array into a string. engine/resumePolicy.ts educationFrom()
 * gated on Array.isArray, so those profiles generated resumes with an EMPTY "Relevant coursework"
 * line - a 200 on the save, no error anywhere, and the loss visible only in a generated PDF.
 *
 * The route no longer writes that shape and the reader now tolerates both, so this backfill is a
 * cleanup rather than a rescue: nothing is broken while it has not run. It exists so the stored data
 * matches the declared shape, and so the reader tolerance stays a deploy-window guard rather than
 * the thing holding real rows together.
 *
 * DRY RUN BY DEFAULT. Pass --apply to write. Idempotent either way: rows already stored as an array
 * are not touched, so re-running it is a no-op.
 *
 * Splits on COMMAS ONLY, matching courseworkFromParsed in src/engine/resumePolicy.ts. Course titles
 * contain "and" and "&" inside a single title ("Data Structures and Object-Oriented Design",
 * "Financial Analysis & Valuation"), so any other separator would cut a real course in half.
 */
import { config } from 'dotenv';
import pg from 'pg';

const apply = process.argv.includes('--apply');

/* .env.local FIRST, and the host printed before anything runs.
 *
 * The sibling scripts here take `dotenv/config`, which reads .env - and .env holds a LOCALHOST
 * DATABASE_URL while production is the Neon URL in .env.local. A backfill pointed at localhost
 * connects, finds zero rows to convert, prints a clean summary and exits 0, which reads exactly like
 * a successful run against production. That failure has cost this project real time before, so this
 * script prefers .env.local and states which host it touched. An explicit DATABASE_URL in the
 * environment still wins over both. */
config({ path: '.env.local' });
config();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set. Production is the Neon URL in .env.local.');
  process.exit(2);
}

const host = new URL(connectionString).host;
console.log(`Database: ${host}${apply ? '  (APPLY - this will write)' : '  (dry run)'}\n`);
if (apply && (host.startsWith('localhost') || host.startsWith('127.0.0.1'))) {
  console.error('Refusing to --apply against localhost: that is the .env URL, not production.');
  process.exit(2);
}

/* Deliberately a copy of courseworkFromParsed rather than an import: this is a plain .mjs script and
 * the engine module is TypeScript. Kept to comma-split + trim + case-insensitive dedupe, and covered
 * on the TypeScript side by src/routes/courseworkRoundTrip.test.ts. */
function courseworkList(value) {
  const courses = [];
  for (const candidate of String(value).split(',')) {
    const course = candidate.trim();
    if (!course || courses.some((existing) => existing.toLowerCase() === course.toLowerCase())) continue;
    courses.push(course);
  }
  return courses;
}

const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } });
try {
  await client.connect();

  const shapes = await client.query(
    `select coalesce(jsonb_typeof(parsed_json->'coursework'), 'absent') as shape, count(*)::int as rows
       from profiles group by 1 order by 2 desc`,
  );
  console.log('coursework shapes before:');
  for (const row of shapes.rows) console.log(`  ${row.shape.padEnd(7)} ${row.rows}`);

  const { rows } = await client.query(
    `select user_id, parsed_json->>'coursework' as coursework
       from profiles
      where jsonb_typeof(parsed_json->'coursework') = 'string'`,
  );

  if (rows.length === 0) {
    console.log('\nNothing to backfill.');
  } else {
    console.log(`\n${rows.length} row(s) to convert:`);
    for (const row of rows) {
      const courses = courseworkList(row.coursework);
      console.log(`  ${row.user_id}: ${courses.length} course(s) -> ${JSON.stringify(courses)}`);
      if (!apply) continue;
      /* jsonb_set on the one key, never a whole-object rewrite: parsed_json holds the entire parse
       * and a read-modify-write of the document here would race any concurrent save of the rest of
       * it. The where clause re-checks the shape so a row fixed between the select and the update
       * is left alone. */
      await client.query(
        `update profiles
            set parsed_json = jsonb_set(parsed_json, '{coursework}', $2::jsonb, true),
                updated_at = now()
          where user_id = $1
            and jsonb_typeof(parsed_json->'coursework') = 'string'`,
        [row.user_id, JSON.stringify(courses)],
      );
    }
  }

  if (!apply) {
    console.log('\nDRY RUN. Nothing was written. Re-run with --apply to convert these rows.');
  } else {
    const after = await client.query(
      `select coalesce(jsonb_typeof(parsed_json->'coursework'), 'absent') as shape, count(*)::int as rows
         from profiles group by 1 order by 2 desc`,
    );
    console.log('\ncoursework shapes after:');
    for (const row of after.rows) console.log(`  ${row.shape.padEnd(7)} ${row.rows}`);
  }
} finally {
  await client.end();
}
