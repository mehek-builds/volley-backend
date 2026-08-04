import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema';
import { withReadOnlyRetry } from './readOnlyRetry';

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/student_outreach';

// Local Postgres needs no SSL; hosted serverless Postgres (Neon / Vercel Postgres) requires it.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

/** The modes pg warns about, all of which it currently treats as aliases for `verify-full`. */
const ALIASED_SSL_MODES = new Set(['require', 'prefer', 'verify-ca']);

/**
 * Rewrite `sslmode=require` to `sslmode=verify-full`, which is what pg already does internally.
 *
 * DEPLOY.md tells you to use a Neon pooled URL, and Neon's URLs carry `?sslmode=require`. On every
 * cold start pg-connection-string then writes a multi-line SECURITY WARNING to stderr saying that
 * `require` is an alias for `verify-full` today and will adopt weaker libpq semantics in pg v9.
 * Vercel collects stderr, so it lands in the runtime error groups: measured 2026-08-04, 59
 * occurrences across 7 users since 2026-07-01, and it was the ONLY error group the project had.
 * This is the fix the warning itself names: "If you want the current behavior, explicitly use
 * 'sslmode=verify-full'".
 *
 * THE FIRST VERSION OF THIS FUNCTION DELETED `sslmode` INSTEAD, AND THAT WAS A SECURITY BUG. It
 * shipped with a comment claiming the explicit `ssl` option below wins over the connection string.
 * The opposite is true. pg 8.21.0, connection-parameters.js:58:
 *
 *   if (config.connectionString) {
 *     config = Object.assign({}, config, parse(config.connectionString))
 *   }
 *
 * The parsed string is the LAST argument, so it overwrites the explicit option. Resolved `ssl` as
 * it actually reaches tls.connect, with `ssl: {rejectUnauthorized:false}` passed alongside:
 *
 *   ?sslmode=require       -> {}                          cert IS verified (Node defaults to true)
 *   ?sslmode=verify-full   -> {}                          identical
 *   no sslmode             -> {rejectUnauthorized:false}  cert is NOT verified
 *
 * So production has been verifying Neon's certificate all along, and deleting the parameter would
 * have been the change that silently stopped it. Rewriting the value keeps the resolved config
 * byte-identical to today while removing the warning.
 *
 * THE MISTAKE THAT HID THIS was the test, not the code. It asserted on `pool.options.ssl`, which is
 * just the object handed to the constructor returned by identity, so it passed under every possible
 * precedence rule including the broken one. db/index.test.ts now asserts on `ConnectionParameters`,
 * the thing pg actually derives, which is the only assertion with any power here.
 *
 * `ssl: { rejectUnauthorized: false }` below is therefore DEAD for any URL carrying an sslmode, and
 * is left in place because it is not dead for one without: removing it there would drop TLS
 * entirely rather than merely stop verifying it. That asymmetry is the real wart, and DEPLOY.md
 * carries it as a deliberate follow-up rather than a change to make blind from a laptop.
 */
export function normalizeSslMode(value: string): string {
  if (!/[?&]sslmode=/i.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // This runs at module load, inside the `new Pool` below. `new Pool` itself does NOT parse
    // eagerly, so a connection string this cannot parse (a multi-host string, or a password with an
    // unencoded `/`) used to surface as a legible pg error on the first query. Throwing here would
    // instead take the whole app down at import, including /health, which is the probe DEPLOY.md
    // tells you to use to confirm a deploy shipped. Hand it back untouched and let pg decide.
    return value;
  }
  // Case-insensitive on BOTH halves: the guard above matches `?SSLMODE=` while `searchParams` is
  // case-sensitive, so an uppercase key would otherwise pass the guard and change nothing.
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() !== 'sslmode') continue;
    const mode = (url.searchParams.get(key) ?? '').toLowerCase();
    // Only the warned aliases are rewritten. `disable`, `allow` and `no-verify` mean something
    // different and are left exactly as configured.
    if (ALIASED_SSL_MODES.has(mode)) url.searchParams.set(key, 'verify-full');
  }
  return url.toString();
}

const pool = new Pool({
  connectionString: isLocal ? connectionString : normalizeSslMode(connectionString),
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  // Keep the per-instance pool tiny on serverless (one container == one or few requests)
  // to avoid exhausting the database's connection limit across many warm lambdas.
  max: process.env.VERCEL ? 1 : 10,
});

/* Retry a write the pooler sent to a read-only backend. See db/readOnlyRetry.ts for the incident
 * and for why a 25006 specifically is safe to run again.
 *
 * Wrapping `pool.query` covers every statement drizzle issues OUTSIDE an explicit transaction,
 * which is nearly all of them: the profile and resume writes that failed in the incident all go
 * through this path.
 *
 * TRANSACTIONS ARE DELIBERATELY NOT COVERED, and this is the honest limit of the fix. `db.transaction`
 * checks a client out of the pool and issues its statements on THAT client, so they never reach
 * here. Retrying an individual statement inside a transaction the failure already aborted would
 * only earn a 25P02, and retrying the whole callback would re-run whatever side effects it had
 * performed before the write. Either is worse than the loud failure a transaction gets today. The
 * routes that matter for the incident are single statements; `PUT /profile/recent-experience` is a
 * transaction and will still fail on a read-only backend, which is the known gap.
 *
 * The callback form of `query` is passed straight through. It is not promise-based, so there is no
 * result to await and nothing to retry; pg's own overloads still resolve because the wrapper keeps
 * the original signature. Nothing in this codebase uses it, but a dependency may.
 */
const poolQuery = pool.query.bind(pool);
pool.query = ((...args: unknown[]) => {
  if (typeof args[args.length - 1] === 'function') {
    return (poolQuery as (...a: unknown[]) => unknown)(...args);
  }
  return withReadOnlyRetry(
    () => (poolQuery as (...a: unknown[]) => Promise<unknown>)(...args),
    {
      onRetry: (attempt) =>
        console.warn(
          `[db] write rejected by a read-only backend, retrying on a fresh connection (attempt ${attempt})`,
        ),
    },
  );
}) as typeof pool.query;

export const db = drizzle(pool, { schema });
export { pool };

export function dedicatedDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DATABASE_DIRECT_URL || env.DATABASE_URL || connectionString;
  const url = new URL(configured);
  if (url.hostname.includes('-pooler.')) {
    url.hostname = url.hostname.replace('-pooler.', '.');
  }
  if (/pooler|pgbouncer/i.test(url.hostname) || url.searchParams.get('pgbouncer') === 'true') {
    throw new Error('DATABASE_DIRECT_URL must use a session-pinned PostgreSQL endpoint');
  }
  return url.toString();
}

/** A dedicated session for features such as PostgreSQL advisory locks that must stay connection-bound. */
export async function connectDedicatedDatabaseClient() {
  const directConnectionString = dedicatedDatabaseUrl();
  const directIsLocal = /localhost|127\.0\.0\.1/.test(directConnectionString);
  const client = new Client({
    // Same reason as the pool above. dedicatedDatabaseUrl's own contract is unchanged: it still
    // returns the URL with every parameter the caller gave it, because DEPLOY.md documents it as
    // the direct endpoint and a caller reading it should see what they configured. Only what is
    // handed to pg is normalized.
    connectionString: directIsLocal ? directConnectionString : normalizeSslMode(directConnectionString),
    ssl: directIsLocal ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}
