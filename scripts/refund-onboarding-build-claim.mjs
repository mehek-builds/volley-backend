#!/usr/bin/env node

/* Hand back one onboarding build claim that a flow defect consumed.
 *
 * WHY THIS EXISTS. Until role-quick-website's 2026-09-01 reorder, the onboarding build generated
 * the resume BEFORE verifying the employer's form could be read, so a form-scan failure killed the
 * flow with the claim already spent on a packet the student never saw in the flow. The code fix
 * stops it happening again; this script repairs the accounts it already happened to.
 *
 * Two modes, and the read comes first by design:
 *   (no args)          list accounts still in setup that are at the claim limit, with timestamps,
 *                      so the operator can see exactly who a refund would touch. Read-only.
 *   --refund <email>   decrement that one account's counter by one, only while it is at the limit
 *                      and still in setup. The WHERE clause is the guard: re-running is a no-op
 *                      once the account is below the limit, and a finished account is never
 *                      touched. The grant stamp stays, because a claim is still outstanding.
 *
 * Connects like apply-onboarding-build-grant-limit-migration.mjs: under
 * `railway run --service Postgres` it assembles the TCP-proxy URL itself and prints the connected
 * database's identity before doing anything.
 */

import pg from 'pg';

const LIMIT = 2;

function databaseUrlFromEnvironment() {
  const { PGUSER, PGPASSWORD, PGDATABASE, RAILWAY_TCP_PROXY_DOMAIN, RAILWAY_TCP_PROXY_PORT } = process.env;
  if (PGUSER && PGPASSWORD && PGDATABASE && RAILWAY_TCP_PROXY_DOMAIN && RAILWAY_TCP_PROXY_PORT) {
    console.log(`Connecting through the TCP proxy at ${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT}...`);
    return `postgresql://${encodeURIComponent(PGUSER)}:${encodeURIComponent(PGPASSWORD)}@${RAILWAY_TCP_PROXY_DOMAIN}:${RAILWAY_TCP_PROXY_PORT}/${encodeURIComponent(PGDATABASE)}`;
  }
  return process.env.DATABASE_URL ?? null;
}

async function main() {
  const refundFlag = process.argv.indexOf('--refund');
  /* --reset hands the whole grant back: counter to zero, stamp cleared, as if no setup build was
     ever claimed. Exists for the operator's own test accounts (asked for by name, 2026-09-01);
     the same still-in-setup guard applies, so it can never turn a finished account into a free
     tier. --refund stays the narrow repair: one claim back, only at the limit. */
  const resetFlag = process.argv.indexOf('--reset');
  if (refundFlag !== -1 && resetFlag !== -1) {
    console.error('Pick one of --refund or --reset.');
    process.exit(2);
  }
  const mode = refundFlag !== -1 ? 'refund' : resetFlag !== -1 ? 'reset' : 'list';
  const email = mode === 'refund' ? process.argv[refundFlag + 1] : mode === 'reset' ? process.argv[resetFlag + 1] : null;
  if (mode !== 'list' && !email) {
    console.error('Usage: refund-onboarding-build-claim.mjs [--refund <email> | --reset <email>]');
    process.exit(2);
  }

  const databaseUrl = databaseUrlFromEnvironment();
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set, and no Railway Postgres service environment is present.');
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const identity = await client.query('select current_database() as db, inet_server_addr()::text as addr');
    console.log(`Connected to "${identity.rows[0].db}" at ${identity.rows[0].addr ?? 'local socket'}.`);
    await client.query("set statement_timeout = '30s'");

    if (mode === 'reset') {
      const updated = await client.query(
        `update "users"
            set "onboarding_builds_used" = 0,
                "onboarding_build_granted_at" = null
          where "email" = $1
            and "onboarding_completed_at" is null
          returning "email"`,
        [email],
      );
      if (updated.rowCount === 0) {
        console.log(`Nothing reset: "${email}" was not found still in setup.`);
        return;
      }
      console.log(`Reset: ${updated.rows[0].email} has both setup builds available again (0 of ${LIMIT} used).`);
      return;
    }

    if (!email) {
      const rows = await client.query(
        `select "email", "onboarding_builds_used", "onboarding_build_granted_at"
           from "users"
          where "onboarding_builds_used" >= $1 and "onboarding_completed_at" is null
          order by "onboarding_build_granted_at" desc nulls last`,
        [LIMIT],
      );
      if (rows.rowCount === 0) {
        console.log('No account still in setup is at the claim limit. Nothing to refund.');
        return;
      }
      for (const row of rows.rows) {
        console.log(`${row.email}  used=${row.onboarding_builds_used}  last claim=${row.onboarding_build_granted_at?.toISOString?.() ?? row.onboarding_build_granted_at}`);
      }
      console.log(`\nRe-run with --refund <email> to hand one claim back to one of these accounts.`);
      return;
    }

    const updated = await client.query(
      `update "users"
          set "onboarding_builds_used" = "onboarding_builds_used" - 1
        where "email" = $1
          and "onboarding_builds_used" >= $2
          and "onboarding_completed_at" is null
        returning "email", "onboarding_builds_used"`,
      [email, LIMIT],
    );
    if (updated.rowCount === 0) {
      console.log(`Nothing refunded: "${email}" is not at the limit while still in setup.`);
      return;
    }
    console.log(`Refunded one claim: ${updated.rows[0].email} is now at ${updated.rows[0].onboarding_builds_used} of ${LIMIT}.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const message = String(error?.message ?? error).replace(/postgres(ql)?:\/\/\S+/gi, '[connection string redacted]');
  console.error('Refund failed:', message);
  process.exit(1);
});
