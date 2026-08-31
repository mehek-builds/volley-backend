#!/usr/bin/env node

/* Read-only: the most recent posting-question scans, so a "could not verify every employer
 * question" report can be diagnosed from what the scanner actually stored instead of from the
 * log tail. Connects like the other operator scripts: under `railway run --service Postgres` it
 * assembles the TCP-proxy URL itself and prints the database identity first. */

import pg from 'pg';

function databaseUrlFromEnvironment() {
  const { PGUSER, PGPASSWORD, PGDATABASE, RAILWAY_TCP_PROXY_DOMAIN, RAILWAY_TCP_PROXY_PORT } = process.env;
  if (PGUSER && PGPASSWORD && PGDATABASE && RAILWAY_TCP_PROXY_DOMAIN && RAILWAY_TCP_PROXY_PORT) {
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT}/${encodeURIComponent(PGDATABASE)}`;
  }
  return process.env.DATABASE_URL ?? null;
}

async function main() {
  const databaseUrl = databaseUrlFromEnvironment();
  if (!databaseUrl) {
    console.error('No database environment present.');
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const identity = await client.query('select current_database() as db');
    console.log(`Connected to "${identity.rows[0].db}" (read-only inspection).`);
    const rows = await client.query(
      `select pq."job_id", j."company_name", pq."portal", pq."discovery_status",
              pq."discovered_at", pq."scan_count", pq."apply_url",
              jsonb_array_length(pq."questions") as record_count,
              pq."questions" as records
         from "posting_questions" pq
         left join "monitored_jobs" j on j."id" = pq."job_id"
        order by pq."discovered_at" desc nulls last
        limit 12`,
    );
    for (const r of rows.rows) {
      const records = Array.isArray(r.records) ? r.records : [];
      const blockers = records.filter((item) => item && typeof item === 'object' && !('question' in item));
      console.log(`${r.discovered_at?.toISOString?.() ?? r.discovered_at}  ${String(r.company_name).slice(0, 24).padEnd(24)}  ${String(r.portal).padEnd(12)}  status=${r.discovery_status}  url=${r.apply_url}  scans=${r.scan_count}  records=${r.record_count}  blockerish=${JSON.stringify(blockers).slice(0, 400)}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Inspection failed:', String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[redacted]'));
  process.exit(1);
});
