#!/usr/bin/env node

/* A student can take an application off their Tracker (Mehek, 2026-09-01).
 *
 * WHY A STAMP AND NOT A DELETE. Nine tables carry an application_id with no foreign key: the
 * submission attempt bindings and events, monetization_events, trial_answer_applications,
 * application_posting_distinctions, pending_premium_actions and user_documents.first_application_id
 * among them. A DELETE cannot cascade to any of those, and the attempt ledger is precisely what
 * stops Litos submitting the same application to the same employer twice. Orphaning it to tidy a
 * Tracker trades a cosmetic problem for a duplicate send to a real employer, so removal is a
 * filter and every one of those references stays valid.
 *
 * The route that sets this refuses any application with submission history, so a removed row is
 * always one that never reached an employer.
 *
 * ADDITIVE AND IDEMPOTENT: one nullable column and one partial index, both `if not exists`. Nothing
 * is backfilled, because NULL already means "on the Tracker" for every existing row. Safe to run
 * before the code that reads it, which is the required order here - the deploy is triggered by the
 * merge, so this must be applied to Railway prod FIRST.
 *
 * Run against REAL Railway prod (postgres.railway.internal is NXDOMAIN off-network; construct the
 * TCP-proxy URL from PGUSER/PGPASSWORD/RAILWAY_TCP_PROXY_DOMAIN:PORT inside
 * `railway run --service Postgres`). A localhost DATABASE_URL reports success and changes nothing
 * real.
 */

import pg from 'pg';

/* Under `railway run --service Postgres` there is no DATABASE_URL, only the service's own PG*
 * variables and the TCP proxy coordinates, so the script assembles the URL itself rather than
 * asking the operator to compose one on a command line (where the password would land in shell
 * history). Nothing sensitive is ever printed: the one log line names host and port alone. */
function databaseUrlFromEnvironment() {
  /* THE PROXY WINS over the service's own DATABASE_URL. Under railway run the env carries both,
     and the DATABASE_URL host is postgres.railway.internal, which is NXDOMAIN off Railway's
     network: preferring it made this script fail from exactly the machine it is documented to run
     on. A caller with only DATABASE_URL (the CI secret path) still works through the fallback. */
  const { PGUSER, PGPASSWORD, PGDATABASE, RAILWAY_TCP_PROXY_DOMAIN, RAILWAY_TCP_PROXY_PORT } = process.env;
  if (PGUSER && PGPASSWORD && PGDATABASE && RAILWAY_TCP_PROXY_DOMAIN && RAILWAY_TCP_PROXY_PORT) {
    console.log(`Connecting through the TCP proxy at ${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT}...`);
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT}/${encodeURIComponent(PGDATABASE)}`;
  }
  return process.env.DATABASE_URL ?? null;
}

async function main() {
  const databaseUrl = databaseUrlFromEnvironment();
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set, and no Railway Postgres service environment is present.');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    /* Say which database this actually is before touching it. The inspection-scripts trap is a
       localhost or stale-Neon URL reporting success against nothing real, so the identity is
       printed for the operator to read back. */
    const identity = await client.query('select current_database() as db, inet_server_addr()::text as addr, version() as v');
    console.log(`Connected to "${identity.rows[0].db}" at ${identity.rows[0].addr ?? 'local socket'} (${String(identity.rows[0].v).split(' on ')[0]}).`);
    await client.query("set lock_timeout = '5s'");
    await client.query("set statement_timeout = '2min'");
    await client.query('begin');
    console.log('Ensuring applications.removed_at...');
    await client.query(
      'alter table "applications" add column if not exists "removed_at" timestamptz',
    );
    console.log('Ensuring the partial index the Tracker query uses...');
    await client.query(
      `create index if not exists "applications_user_live_updated_idx"
         on "applications" ("user_id", "updated_at")
         where "removed_at" is null`,
    );
    await client.query('commit');

    const counts = await client.query(
      'select count(*)::int as total, count("removed_at")::int as removed from "applications"',
    );
    console.log(`applications: ${counts.rows[0].total} total, ${counts.rows[0].removed} currently removed.`);
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log('Ready: applications.removed_at is present. Merge the code that reads it.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Application removal migration failed:', message);
  process.exit(1);
});
