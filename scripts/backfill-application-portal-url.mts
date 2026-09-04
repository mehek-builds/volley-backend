/* Fills applications.portal_url for canonical rows created from a monitored job id alone.
 *
 * Usage:  node --import tsx scripts/backfill-application-portal-url.mts            dry run
 *         node --import tsx scripts/backfill-application-portal-url.mts --apply    writes
 *
 * WHY. routes/resume.ts computed the canonical row's portal_url from `body.application` being
 * present, not from the job id it already had. A packet built from a job id alone - no
 * `application` in the request body, the shape an extension or job-board-driven generate takes -
 * stored job_id with portal_url left null. The submission runner still derives its own landing URL
 * from that same job id later, so those rows carry no portal evidence to freeze an identity
 * against once a run lands, and the send is refused at CANONICAL_PACKET_BINDING_MISSING. The route
 * fix (canonicalApplicationPortalUrlFor in routes/resume.ts) stops the leak for every packet
 * generated from here on; this backfills the rows it already left behind.
 *
 * Measured on Railway prod 2026-09-04:
 *   select count(*), count(*) filter (where portal_url is null)
 *   from applications where legacy_generated_resume_id is not null;
 *   -> 646 rows, 174 with a null portal_url, 118 of those with a job_id, across 18 accounts.
 * This script's candidate set is exactly those 118 (legacy_generated_resume_id is not null AND
 * portal_url is null AND job_id is not null): the ones a job id can actually reconstruct a URL
 * for. The other 56 have no job_id at all - a caller-typed link or an extension fill with nothing
 * to reconstruct from - and are correctly out of scope for this script and for
 * canonicalApplicationPortalUrlFor's own fix, which only ever acts when a job id is present.
 *
 * WHAT IT WRITES. `applications.portal_url`, reconstructed from the row's own job_id through the
 * SAME PATH routes/resume.ts uses for a live generate: monitored_jobs joined to
 * career_page_sources for apply_url / posting_url / ats_name / board_token / external_id, fed
 * through canonicalMonitoredPortalUrl (lib/portalSubmission.ts). Not a copy of that logic - an
 * import of the exact function - so this can never reconstruct a URL routes/resume.ts or the
 * matcher in lib/canonicalPacketBinding.ts would disagree with.
 *
 * WHAT IT REFUSES TO TOUCH:
 *   - any row whose job_id no longer resolves a monitored_jobs row (the LEFT JOIN below finds
 *     nothing): the job was hard-deleted, and there is nothing left to reconstruct from
 *   - any row whose source (career_page_sources) is disabled. canonicalMonitoredPortalUrl has no
 *     concept of "enabled" - it is a pure URL-shape function - so left alone it would still
 *     reconstruct a plausible URL for a source disabled since this application was created (a
 *     policy issue, a broken adapter, a renamed board token). ownedHistoricalActionPostingRow
 *     (routes/jdMatch.ts), the app's own read path for re-establishing evidence about an existing
 *     application against a posting that may no longer be live, requires enabled = true for
 *     exactly that reason, and this script holds itself to the same bar
 *   - any row whose reconstruction comes back undefined: an unsupported ATS family, a board token
 *     that no longer matches, or a malformed stored URL. canonicalMonitoredPortalUrl is the sole
 *     judge of "supported" beyond the enabled check above; this script never second-guesses it
 *   - any row that already carries a portal_url (excluded by the query itself) or has no job_id
 *     (same) - both are out of scope, not merely skipped
 *
 * DRY RUN BY DEFAULT. Pass --apply to write. Idempotent either way: the UPDATE re-checks
 * `portal_url is null` in its own WHERE clause, so a row already filled - by an earlier run of
 * this script, or by a fresh generate through the fixed route - is never touched twice and a
 * second run reports 0 updated.
 *
 * CHECK THE TARGET BEFORE RUNNING. The DATABASE_URL in .env is a LOCAL Postgres that makes this
 * report success while touching nothing real; the URL in .env.local is stale Neon; production is
 * Railway Postgres, reached through the TCP proxy assembled below from `railway run --service
 * Postgres`. This prints the database and server address it connected to before it changes
 * anything, and refuses to --apply against anything that looks like localhost.
 */
import 'dotenv/config';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { canonicalMonitoredPortalUrl } from '../src/lib/portalSubmission';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');

/* Railway's private root, pinned. Prefer the deploy secret when it is present (GitHub Actions sets
   it); fall back to the copy committed at the repo root, which is the same material and is what
   makes an operator run work without provisioning anything. Matches
   apply-monitored-job-url-lookup-index.mjs and check-schema-drift.mjs. */
function pinnedRailwayRoot(): string | undefined {
  const fromEnv = process.env.SCHEMA_CHECK_DATABASE_SSL_ROOT_CERT?.trim();
  if (fromEnv) return `${fromEnv.replace(/\\n/g, '\n')}\n`;
  const bundled = path.join(REPO_ROOT, 'railway-root-ca.pem');
  return fs.existsSync(bundled) ? fs.readFileSync(bundled, 'utf8') : undefined;
}

/* Off-container we reach Railway through its public TCP proxy, whose PostgreSQL presents a
   certificate from Railway's PRIVATE root, so without the pinned root the connect dies with
   "self-signed certificate in certificate chain" before a single statement runs. The SAN names the
   internal host, so the identity check below is a real check only Railway's own instance passes,
   not a bypass. */
function pinnedProxyTls(): tls.ConnectionOptions | undefined {
  const ca = pinnedRailwayRoot();
  if (!ca) return undefined;
  return {
    rejectUnauthorized: true,
    ca,
    checkServerIdentity: (_host: string, cert) => tls.checkServerIdentity('postgres.railway.internal', cert),
  };
}

type ConnectionTarget = { description: string; config: ConstructorParameters<typeof Client>[0] };

// One pattern, used everywhere "is this host local" matters (SSL selection, the apply-refusal
// check below): two copies of the same regex is how one of them silently stops catching a case
// the other still does.
const LOOKS_LOCAL = /localhost|127\.0\.0\.1/;

/* TWO WAYS IN. Production is Railway Postgres on `postgres.railway.internal`, unreachable off the
   private network, so an operator run reaches it through the public TCP proxy whose address and
   credentials `railway run --service Postgres` injects. Assembled here from discrete fields, never
   a connection string, so a production password is never formatted into anything that could be
   logged or echoed. An explicit DATABASE_URL still wins when set, which is what CI and the
   in-container run use. */
function proxyTarget(): ConnectionTarget | undefined {
  const host = process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const port = process.env.RAILWAY_TCP_PROXY_PORT;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  const database = process.env.PGDATABASE;
  if (!host || !port || !user || !password || !database) return undefined;
  return {
    description: `Railway TCP proxy ${host}:${port}`,
    config: { host, port: Number(port), user, password, database, ssl: pinnedProxyTls() },
  };
}

async function internalHostResolves(hostname: string): Promise<boolean> {
  try {
    await dns.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

async function connectionConfig(): Promise<ConnectionTarget | undefined> {
  const explicit = process.env.DATABASE_URL;
  if (explicit) {
    let hostname = '';
    try {
      hostname = new URL(explicit).hostname.toLowerCase();
    } catch {
      hostname = '';
    }
    const unreachableInternal = hostname.endsWith('.railway.internal')
      && !(await internalHostResolves(hostname));
    if (unreachableInternal) {
      const proxy = proxyTarget();
      if (!proxy) {
        console.error(
          `DATABASE_URL names ${hostname}, which does not resolve from here, and no TCP proxy\n`
            + 'variables are present. Run inside `railway run --service Postgres`.',
        );
        process.exit(2);
      }
      console.log(`DATABASE_URL names ${hostname}, unreachable off the private network; using the proxy instead.`);
      return proxy;
    }
    return {
      description: `DATABASE_URL (${hostname || 'unparsed'})`,
      config: {
        connectionString: explicit,
        ssl: LOOKS_LOCAL.test(explicit) ? undefined : pinnedProxyTls() ?? { rejectUnauthorized: true },
      },
    };
  }
  return proxyTarget();
}

type Candidate = {
  application_id: string;
  job_id: string;
  monitored_job_id: string | null;
  apply_url: string | null;
  posting_url: string | null;
  external_id: string | null;
  ats_name: string | null;
  board_token: string | null;
  source_enabled: boolean | null;
};

async function main() {
  const resolved = await connectionConfig();
  if (!resolved) {
    console.error(
      'No database target. Set DATABASE_URL, or run inside `railway run --service Postgres` so the\n'
        + 'TCP proxy address and credentials are injected.',
    );
    process.exit(2);
    return;
  }
  console.log(`connecting via ${resolved.description}${apply ? '  (APPLY - this will write)' : '  (dry run)'}`);

  const client = new Client(resolved.config);
  await client.connect();
  try {
    const [{ current_database: db, host }] = (
      await client.query('select current_database(), inet_server_addr()::text as host')
    ).rows;
    console.log(`connected to ${db} (${host ?? 'local socket'})`);

    const looksLikeLocalhost = LOOKS_LOCAL.test(String(host ?? ''))
      || (resolved.config as { host?: string }).host === 'localhost'
      || ('connectionString' in resolved.config && LOOKS_LOCAL.test(String(resolved.config.connectionString)));
    // BACKFILL_ALLOW_LOCALHOST_APPLY is an explicit, narrowly-named test-only escape hatch (set by
    // this script's own .test.mts, nowhere else) so an ephemeral local Postgres in CI can exercise
    // the real write path. An operator would have to type this exact variable name on purpose;
    // nothing sets it by habit the way a stale .env does.
    if (apply && looksLikeLocalhost && process.env.BACKFILL_ALLOW_LOCALHOST_APPLY !== '1') {
      console.error('Refusing to --apply against what looks like localhost: that is not production.');
      process.exit(2);
      return;
    }

    await client.query("set statement_timeout = '5min'");

    const { rows: candidates } = await client.query<Candidate>(`
      select
        a.id as application_id,
        a.job_id as job_id,
        mj.id as monitored_job_id,
        mj.apply_url as apply_url,
        mj.posting_url as posting_url,
        mj.external_id as external_id,
        cps.ats_name as ats_name,
        cps.board_token as board_token,
        cps.enabled as source_enabled
      from applications a
      left join monitored_jobs mj on mj.id = a.job_id
      left join career_page_sources cps on cps.id = mj.source_id
      where a.legacy_generated_resume_id is not null
        and a.portal_url is null
        and a.job_id is not null
      order by a.id
    `);

    console.log(`${candidates.length} candidate row(s): legacy_generated_resume_id set, portal_url null, job_id set.`);

    let reconstructed = 0;
    let updated = 0;
    let jobGone = 0;
    let sourceDisabled = 0;
    let unsupported = 0;
    let raced = 0;

    for (const row of candidates) {
      if (!row.monitored_job_id) {
        jobGone += 1;
        console.log(`  ${row.application_id}: job ${row.job_id} no longer exists, skipping`);
        continue;
      }
      if (row.source_enabled === false) {
        /* canonicalMonitoredPortalUrl has no concept of "enabled" - it is a pure URL-shape
           function - so nothing stops it reconstructing a plausible-looking URL for a source that
           was disabled after this application was created (a policy issue, a broken adapter, a
           renamed board token). ownedHistoricalActionPostingRow, the app's own read path for
           re-establishing evidence about an EXISTING application against a posting that is no
           longer live, requires career_page_sources.enabled = true for exactly that reason,
           and this script - also reconstructing evidence for existing applications - holds itself
           to the same bar rather than trusting every family isMonitoredPortalFamily accepts. */
        sourceDisabled += 1;
        console.log(`  ${row.application_id}: job ${row.job_id}'s source is disabled, skipping`);
        continue;
      }
      const url = canonicalMonitoredPortalUrl(
        row.apply_url ?? undefined,
        row.ats_name,
        row.board_token,
        row.external_id,
        row.posting_url,
      );
      if (!url) {
        unsupported += 1;
        console.log(`  ${row.application_id}: job ${row.job_id} did not reconstruct a supported portal URL, skipping`);
        continue;
      }
      reconstructed += 1;
      console.log(`  ${row.application_id}: ${url}`);
      if (!apply) continue;

      /* The WHERE re-checks portal_url is null, matching backfill-coursework-shape.mjs's pattern:
         idempotent by construction, and safe if something else filled this row between the select
         above and this statement.

         updated_at is deliberately left alone. GET /applications and existingApplicationForJob
         (routes/applicationFromJob.ts) both order live rows by updated_at desc, and the latter has
         no removed_at filter - bumping it here would jump old, dormant applications to the top of
         a student's Tracker with a false "just now" timestamp, and could even change which row
         existingApplicationForJob treats as the one live application for a job id. Filling in a
         fact this row always should have carried is not something that happened just now. */
      const result = await client.query(
        `update applications
            set portal_url = $2
          where id = $1
            and portal_url is null`,
        [row.application_id, url],
      );
      if (result.rowCount === 1) updated += 1;
      else raced += 1;
    }

    console.log('');
    console.log(`${candidates.length} candidate(s): ${reconstructed} reconstructed a supported portal URL, `
      + `${jobGone} had no surviving job, ${sourceDisabled} had a disabled source, ${unsupported} did not reconstruct.`);
    if (!apply) {
      console.log('DRY RUN. Nothing was written. Re-run with --apply to write these URLs.');
    } else {
      console.log(`Updated ${updated} row(s).${raced ? ` ${raced} row(s) raced with a concurrent write and were left alone.` : ''}`);
    }
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
