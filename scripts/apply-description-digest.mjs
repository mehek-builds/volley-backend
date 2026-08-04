/* Additive column for the poll-time scoring digest. See src/lib/descriptionDigest.ts for why.
 *
 * A SCRIPT, NOT `db:push`, for the reason apply-employment-type-index.mjs states: push reconciles
 * BOTH directions and would drop any live column schema.ts does not declare, which has cost this
 * repo real columns twice. ADD COLUMN IF NOT EXISTS cannot drop anything.
 *
 * NULLABLE AND NOT BACKFILLED, which is the whole design and not an omission. Backfilling would
 * mean reading all ~22k descriptions out of Neon to compute a value the daily poll rewrites for
 * free, spending exactly the transfer allowance this column exists to save, on a database whose
 * compute is suspended for having spent it. The read path coalesces to the old capped prefix, so
 * the board is correct from the moment this runs, and the column fills itself as sources are
 * polled.
 *
 * CHECK THE TARGET BEFORE RUNNING. The DATABASE_URL in .env is a LOCAL Postgres; production is the
 * Neon URL in .env.local. This prints the database it connected to before it changes anything, for
 * exactly that reason.
 */
import 'dotenv/config';
import { Client } from 'pg';

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const [{ current_database: db, host }] = (
  await client.query(`select current_database(), inet_server_addr()::text as host`)
).rows;
console.log(`connected to ${db} (${host ?? 'local socket'})`);

console.log('adding monitored_jobs.description_digest...');
await client.query(`alter table monitored_jobs add column if not exists description_digest text`);

const [{ present }] = (
  await client.query(`
    select count(*)::int as present
    from information_schema.columns
    where table_name = 'monitored_jobs' and column_name = 'description_digest'
  `)
).rows;

if (present !== 1) {
  console.log('FAILED: column missing after the ALTER');
  await client.end();
  process.exit(1);
}

/* Reported so the operator can watch the column fill over the next poll cycle rather than assuming
   it did. Counts only, no description text is read, so this costs nothing meaningful in transfer. */
const [counts] = (
  await client.query(`
    select
      count(*)::int as total,
      count(description_digest)::int as with_digest
    from monitored_jobs
    where is_active
  `)
).rows;

console.log(`ready: column present`);
console.log(
  `${counts.with_digest} of ${counts.total} active postings have a digest. ` +
    `The rest use the capped-prefix fallback until their source is next polled.`,
);

await client.end();
process.exit(0);
