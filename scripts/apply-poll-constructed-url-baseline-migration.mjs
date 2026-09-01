/* One additive column for the per-poll CONSTRUCTED action-URL baseline, the sibling of the
 * rejection baseline in apply-poll-rejection-baseline-migration.mjs.
 *
 * See constructionSpikeExceedsBaseline in src/routes/jobMonitor.ts for why it exists: since the
 * employer-hosted embed fallback, a Greenhouse posting whose absolute_url fails strict validation
 * is no longer rejected but CONSTRUCTED from token + id, so provider URL-format drift now clears
 * both the fully-rejected guard and the rejection-spike check while quietly demoting every
 * posting_url on the board from a readable job page to a bare embed application form.
 *
 * A SCRIPT, NOT `db:push`, for the reason apply-employment-type-index.mjs states: push reconciles
 * BOTH directions and would drop any live column schema.ts does not declare, which has cost this
 * repo real columns twice. ADD COLUMN IF NOT EXISTS cannot drop anything.
 *
 * NULLABLE AND NOT BACKFILLED, which is the design and not an omission: NULL means "no completed
 * Greenhouse poll under this code yet", which the spike predicate reads as "no baseline, never
 * alert". The first completed poll after deploy writes each source's baseline for free. It stays
 * NULL forever on every non-Greenhouse source, because no other normalizer constructs.
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

console.log('adding career_page_sources.last_poll_constructed_count...');
await client.query(
  `alter table career_page_sources add column if not exists last_poll_constructed_count integer`,
);

const [{ present }] = (
  await client.query(`
    select count(*)::int as present
    from information_schema.columns
    where table_name = 'career_page_sources'
      and column_name = 'last_poll_constructed_count'
  `)
).rows;

if (!present) {
  console.log('FAILED: the column is missing after the ALTER');
  await client.end();
  process.exit(1);
}

/* Reported so the operator can watch the baselines fill over the next poll cycle rather than
   assuming they did. Greenhouse only, because that is the only provider that will ever fill it.
   Counts only; nothing per-row is read. */
const [counts] = (
  await client.query(`
    select
      count(*)::int as total,
      count(last_poll_constructed_count)::int as with_baseline
    from career_page_sources
    where enabled and ats_name = 'greenhouse'
  `)
).rows;

console.log('ready: column present');
console.log(
  `${counts.with_baseline} of ${counts.total} enabled Greenhouse sources carry a constructed-URL ` +
    'baseline. The rest write theirs on their next completed poll; until then the construction ' +
    'spike check stays silent for them.',
);

await client.end();
process.exit(0);
