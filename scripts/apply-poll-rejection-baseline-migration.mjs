/* Additive columns for the per-poll rejection baseline. See rejectionSpikeExceedsBaseline in
 * src/routes/jobMonitor.ts for why: a PARTIAL action-URL drift (most but not all of a board
 * rejected) completes as a clean success and sweeps the failed rows, and the only honest alarm is
 * the rejection count MOVING against the previous completed poll, because employer-hosted
 * absolute_url boards are host-rejected at a steady baseline by design.
 *
 * A SCRIPT, NOT `db:push`, for the reason apply-employment-type-index.mjs states: push reconciles
 * BOTH directions and would drop any live column schema.ts does not declare, which has cost this
 * repo real columns twice. ADD COLUMN IF NOT EXISTS cannot drop anything.
 *
 * NULLABLE AND NOT BACKFILLED, which is the design and not an omission: NULL means "no completed
 * poll under this code yet", which the spike predicate reads as "no baseline, never alert". The
 * first completed poll after deploy writes each source's baseline for free; nothing needs
 * reconstructing from history that was never recorded.
 *
 * CHECK THE TARGET BEFORE RUNNING. The DATABASE_URL in .env is a LOCAL Postgres that makes
 * migrations report success while touching nothing real; production is Railway Postgres, reachable
 * only through the TCP proxy URL constructed inside `railway run --service Postgres` (there is no
 * DATABASE_PUBLIC_URL). This prints the database it connected to before it changes anything, for
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

console.log('adding career_page_sources rejection-baseline columns...');
await client.query(
  `alter table career_page_sources add column if not exists last_poll_listed_count integer`,
);
await client.query(
  `alter table career_page_sources add column if not exists last_poll_normalized_count integer`,
);

const [{ present }] = (
  await client.query(`
    select count(*)::int as present
    from information_schema.columns
    where table_name = 'career_page_sources'
      and column_name in ('last_poll_listed_count', 'last_poll_normalized_count')
  `)
).rows;

if (present !== 2) {
  console.log('FAILED: a column is missing after the ALTER');
  await client.end();
  process.exit(1);
}

/* Reported so the operator can watch the baselines fill over the next poll cycle rather than
   assuming they did. Counts only; nothing per-row is read. */
const [counts] = (
  await client.query(`
    select
      count(*)::int as total,
      count(last_poll_listed_count)::int as with_baseline
    from career_page_sources
    where enabled
  `)
).rows;

console.log('ready: both columns present');
console.log(
  `${counts.with_baseline} of ${counts.total} enabled sources carry a rejection baseline. ` +
    'The rest write theirs on their next completed poll; until then the spike check stays silent for them.',
);

await client.end();
process.exit(0);
