/* Additive indexes for the POST /jobs/extract monitored-inventory lookup.
 *
 * WHY: findMonitoredJobDescription (src/routes/jobExtract.ts) resolves a pasted posting URL against
 * this table before paying for a managed-browser render. Without these it is a sequential scan of
 * the whole board on EVERY extract request, hit or miss - 214,925 live postings across 10,944
 * sources when this was written. The route is correct without them; this is purely the cost.
 *
 * TWO SINGLE-COLUMN INDEXES, NOT ONE COMPOSITE. The lookup is
 * `apply_url = any($1) OR posting_url = any($2)`. An OR across two different columns cannot be
 * served by one composite index; Postgres combines two separate ones with a BitmapOr.
 *
 * PARTIAL, on the same predicate as monitored_jobs_cursor_idx and monitored_jobs_group_member_idx.
 * That predicate is exactly what the lookup carries (is_active and ingest_eligible), so the index
 * stays small and a closed or unvalidated row is neither indexed nor eligible to short-circuit a
 * live read.
 *
 * A SCRIPT, NOT `db:push`, for the reason apply-employment-type-index.mjs states: push reconciles
 * BOTH directions and would drop any live column schema.ts does not declare, which has cost this
 * repo real columns twice. CREATE INDEX IF NOT EXISTS cannot drop anything.
 *
 * CONCURRENTLY so the board stays readable and the job monitor keeps writing while these build.
 * That forbids a transaction, which is why this runs outside one and is safe to re-run: a failed
 * CONCURRENTLY build leaves an INVALID index, and the DROP below clears it before retrying.
 *
 * CHECK THE TARGET BEFORE RUNNING. The DATABASE_URL in .env is a LOCAL Postgres that makes
 * migrations report success while touching nothing real, and the one in .env.local is stale Neon;
 * production is Railway Postgres, reachable only through the TCP proxy URL constructed inside
 * `railway run --service Postgres` (there is no DATABASE_PUBLIC_URL). This prints the database and
 * server address it connected to before it changes anything, for exactly that reason.
 */
import 'dotenv/config';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const INDEXES = [
  ['monitored_jobs_apply_url_lookup_idx', 'apply_url'],
  ['monitored_jobs_posting_url_lookup_idx', 'posting_url'],
];

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* Railway's private root, pinned. Prefer the deploy secret when it is present (GitHub Actions sets
   it); fall back to the copy committed at the repo root, which is the same material and is what
   makes an operator run work without provisioning anything. */
function pinnedRailwayRoot() {
  const fromEnv = process.env.SCHEMA_CHECK_DATABASE_SSL_ROOT_CERT?.trim();
  if (fromEnv) return `${fromEnv.replace(/\\n/g, '\n')}\n`;
  const bundled = path.join(REPO_ROOT, 'railway-root-ca.pem');
  return fs.existsSync(bundled) ? fs.readFileSync(bundled, 'utf8') : undefined;
}

/* TLS matching scripts/check-schema-drift.mjs and apply-submission-authority-revision-schema.mjs:
   off-container we reach Railway through its public TCP proxy, whose PostgreSQL presents a
   certificate from Railway's PRIVATE root (CN=root-ca), so without the pinned root the connect dies
   with "self-signed certificate in certificate chain" before a single statement runs. The SAN is
   [localhost, postgres.railway.internal], so the identity check names the internal host: a real
   check only Railway's own instance can pass, not a bypass. */
function pinnedProxyTls() {
  const ca = pinnedRailwayRoot();
  if (!ca) return undefined;
  return {
    rejectUnauthorized: true,
    ca,
    checkServerIdentity: (_host, cert) => tls.checkServerIdentity('postgres.railway.internal', cert),
  };
}

/* TWO WAYS IN, and the second is why this script does not simply demand a DATABASE_URL.
 *
 * Production is Railway Postgres on `postgres.railway.internal`, which does not resolve off the
 * private network, so an operator run reaches it through the public TCP proxy. Railway injects the
 * credentials and the proxy address into `railway run --service Postgres`, so the connection is
 * assembled HERE from those variables rather than pasted into a shell as a URL: a password on a
 * command line lands in shell history and process listings, and that is a bad way to move a
 * production credential. This is the documented prod path, made runnable instead of manual.
 *
 * An explicit DATABASE_URL still wins when set, which is what CI and the in-container run use. */
function proxyTarget() {
  const host = process.env.RAILWAY_TCP_PROXY_DOMAIN;
  const port = process.env.RAILWAY_TCP_PROXY_PORT;
  const user = process.env.PGUSER;
  const password = process.env.PGPASSWORD;
  const database = process.env.PGDATABASE;
  if (!host || !port || !user || !password || !database) return undefined;
  return {
    description: `Railway TCP proxy ${host}:${port}`,
    // Discrete fields, never an assembled URL string, so the password is not formatted into
    // anything that could be logged or echoed.
    config: { host, port: Number(port), user, password, database, ssl: pinnedProxyTls() },
  };
}

/* An internal Railway host is only reachable from inside the private network. `railway run` runs
   LOCALLY, so the DATABASE_URL it injects for the Postgres service names
   `postgres.railway.internal` and dies with ENOTFOUND out here. Resolve before trusting it rather
   than guessing from the environment: in-container the name resolves and the URL is correct, and
   off-container it does not and the proxy is the only way in. */
async function internalHostResolves(hostname) {
  try {
    await dns.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

async function connectionConfig() {
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
        ssl: /localhost|127\.0\.0\.1/.test(explicit) ? undefined : pinnedProxyTls() ?? { rejectUnauthorized: true },
      },
    };
  }

  return proxyTarget();
}

const resolved = await connectionConfig();
if (!resolved) {
  console.error(
    'No database target. Set DATABASE_URL, or run inside `railway run --service Postgres` so the\n'
      + 'TCP proxy address and credentials are injected.',
  );
  process.exit(2);
}
console.log(`connecting via ${resolved.description}`);

const client = new Client(resolved.config);
await client.connect();

const [{ current_database: db, host }] = (
  await client.query('select current_database(), inet_server_addr()::text as host')
).rows;
console.log(`connected to ${db} (${host ?? 'local socket'})`);

/* Reported before the build so the operator can see what it is about to scan, and afterwards can
   tell a real speed-up from an index that was never going to be used. Counts only; no row data. */
const [rowCounts] = (
  await client.query(`
    select count(*)::int as total,
      count(*) filter (where is_active and ingest_eligible)::int as indexed
    from monitored_jobs
  `)
).rows;
console.log(`monitored_jobs holds ${rowCounts.total} rows; ${rowCounts.indexed} match the partial predicate.`);

// CONCURRENTLY can take minutes on a table this size and must not be cut short by a default cap.
await client.query("set statement_timeout = '30min'");

for (const [name, column] of INDEXES) {
  const [invalid] = (
    await client.query(
      `select 1 from pg_class c
         join pg_index i on i.indexrelid = c.oid
        where c.relname = $1 and not i.indisvalid`,
      [name],
    )
  ).rows;
  if (invalid) {
    console.log(`dropping a previous INVALID build of ${name}`);
    await client.query(`drop index concurrently if exists ${name}`);
  }

  console.log(`creating ${name} on (${column}) (concurrently)...`);
  await client.query(`
    create index concurrently if not exists ${name}
      on monitored_jobs (${column})
      where is_active = true and ingest_eligible = true
  `);
}

/* Present AND valid, both checked. A CONCURRENTLY build that fails partway leaves the index in
   pg_class, so counting names alone would report success over an index the planner will not use. */
const { rows: live } = await client.query(
  `select c.relname, i.indisvalid, pg_size_pretty(pg_relation_size(c.oid)) as size
     from pg_class c
     join pg_index i on i.indexrelid = c.oid
    where c.relname = any($1)`,
  [INDEXES.map(([name]) => name)],
);
for (const row of live) {
  console.log(`${row.relname}: valid=${row.indisvalid} size=${row.size}`);
}

const ready = live.length === INDEXES.length && live.every((row) => row.indisvalid);
console.log(ready ? 'ready: both indexes present and valid' : 'FAILED: an index is missing or INVALID');
await client.end();
process.exit(ready ? 0 : 1);
