/* Additive index for the job-type filter and the internship freshness window.
 *
 * A SCRIPT, NOT `db:push`. check-schema-drift reports missing-only drift here, and push reconciles
 * BOTH directions: it would drop any live column schema.ts does not declare, which has cost this
 * repo real columns twice. CREATE INDEX IF NOT EXISTS cannot drop anything.
 *
 * CONCURRENTLY so the board stays readable while it builds. That forbids a transaction, which is
 * why this runs outside one and is safe to re-run: a failed CONCURRENTLY build leaves an INVALID
 * index, and the DROP below clears it before retrying.
 */
import 'dotenv/config';
import { Client } from 'pg';

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const [{ current_database: db }] = (await client.query('select current_database()')).rows;
console.log(`connected to ${db}`);

const [invalid] = (await client.query(`
  select 1 from pg_class c
  join pg_index i on i.indexrelid = c.oid
  where c.relname = 'monitored_jobs_type_posted_idx' and not i.indisvalid
`)).rows;
if (invalid) {
  console.log('dropping a previous INVALID build');
  await client.query('drop index concurrently if exists monitored_jobs_type_posted_idx');
}

console.log('creating monitored_jobs_type_posted_idx (concurrently)...');
await client.query(`
  create index concurrently if not exists monitored_jobs_type_posted_idx
    on monitored_jobs (is_active, employment_type, posted_at)
`);
const [{ count }] = (await client.query(`
  select count(*)::int as count from pg_class where relname = 'monitored_jobs_type_posted_idx'
`)).rows;
console.log(count === 1 ? 'ready: index present' : 'FAILED: index missing');
await client.end();
process.exit(count === 1 ? 0 : 1);
