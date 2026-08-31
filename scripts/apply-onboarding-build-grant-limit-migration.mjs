#!/usr/bin/env node

/* The onboarding build grant becomes a counter with a limit of two (Mehek, 2026-09-01).
 *
 * One free build made going back a paid action: a student who returned to the resume step and
 * uploaded a better file hit the paywall on the rebuild. The second build exists for exactly that
 * student. The old single-stamp column stays (it now records the most recent claim time); the new
 * integer is what enforces the limit, in the WHERE clause of the claim's conditional UPDATE.
 *
 * BACKFILL: an account whose old stamp is set has used exactly one build under the old rule, so it
 * starts at 1 and has one rebuild left, which is precisely the policy change. The backfill guards
 * on `onboarding_builds_used = 0` so re-running this script never resets a count the new code has
 * since moved.
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
    console.log('Ensuring users.onboarding_builds_used...');
    await client.query(
      'alter table "users" add column if not exists "onboarding_builds_used" integer not null default 0',
    );
    console.log('Backfilling one used build wherever the old single stamp is set...');
    const backfilled = await client.query(
      `update "users"
          set "onboarding_builds_used" = 1
        where "onboarding_build_granted_at" is not null
          and "onboarding_builds_used" = 0`,
    );
    console.log(`Backfilled ${backfilled.rowCount} account(s).`);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  console.log('Ready: the onboarding build counter is present and backfilled.');
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Onboarding build grant limit migration failed:', message);
  process.exit(1);
});
