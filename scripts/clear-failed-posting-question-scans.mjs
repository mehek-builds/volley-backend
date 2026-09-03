#!/usr/bin/env node

/* Clear cached posting-question scans that stored a non-OK status, so the next request re-scans
 * instead of serving a stale failure. A failed scan is cached for 6 hours
 * (POSTING_QUESTIONS_FAILED_TTL_MS), which after a provider-side fix would keep showing the old
 * failure screen for postings scanned just before the fix. The row is only a cache keyed by
 * job_id; deleting it forces a fresh scan and loses nothing durable.
 *
 * Read-then-write: lists what it will clear before clearing. Connects like the other operator
 * scripts (TCP proxy under `railway run --service Postgres`, identity printed first).
 */

import pg from 'pg';

function databaseUrlFromEnvironment() {
  const { PGUSER, PGPASSWORD, PGDATABASE, RAILWAY_TCP_PROXY_DOMAIN, RAILWAY_TCP_PROXY_PORT } = process.env;
  if (PGUSER && PGPASSWORD && PGDATABASE && RAILWAY_TCP_PROXY_DOMAIN && RAILWAY_TCP_PROXY_PORT) {
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT}/${encodeURIComponent(PGDATABASE)}`;
  }
  return process.env.DATABASE_URL ?? null;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const databaseUrl = databaseUrlFromEnvironment();
  if (!databaseUrl) {
    console.error('No database environment present.');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const identity = await client.query('select current_database() as db');
    console.log(`Connected to "${identity.rows[0].db}".`);
    const doomed = await client.query(
      `select pq."job_id", j."company_name", pq."portal", pq."discovery_status", pq."discovered_at"
         from "posting_questions" pq
         left join "monitored_jobs" j on j."id" = pq."job_id"
        where pq."discovery_status" in ('failed', 'form_not_reached', 'metadata_incomplete')
        order by pq."discovered_at" desc nulls last`,
    );
    if (doomed.rowCount === 0) {
      console.log('No non-OK scan caches to clear.');
      return;
    }
    for (const r of doomed.rows) {
      console.log(`${apply ? 'clearing' : 'would clear'}: ${String(r.company_name).slice(0, 28).padEnd(28)} ${String(r.portal).padEnd(12)} ${r.discovery_status}  ${r.discovered_at?.toISOString?.() ?? r.discovered_at}`);
    }
    if (!apply) {
      console.log(`\n${doomed.rowCount} row(s) would be cleared. Re-run with --apply to delete them (each re-scans on next request).`);
      return;
    }
    const deleted = await client.query(
      `delete from "posting_questions"
        where "discovery_status" in ('failed', 'form_not_reached', 'metadata_incomplete')`,
    );
    console.log(`\nCleared ${deleted.rowCount} cached scan(s). Each posting re-scans on its next request.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Clear failed:', String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]'));
  process.exit(1);
});
