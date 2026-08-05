import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema';
import { isPassThroughQueryCall, withReadOnlyRetry } from './readOnlyRetry';

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/student_outreach';

// Local Postgres needs no SSL; hosted serverless Postgres (Neon / Vercel Postgres) requires it.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

/** The modes pg warns about, all of which it currently treats as aliases for `verify-full`. */
const ALIASED_SSL_MODES = new Set(['require', 'prefer', 'verify-ca']);

/**
 * Make the connection string say `sslmode=verify-full`, so TLS verification is stated rather than
 * inherited, and hand pg a string that decides its own TLS.
 *
 * TWO THINGS THIS DOES, and they were separate fixes a few hours apart.
 *
 * `uselibpqcompat=true` is left entirely alone, and `sslmode=disable` is honoured. Both are
 * deliberate choices where they appear, and a database config that ignores what it was told is
 * worse than one that is loose.
 *
 * FIRST, IT REWRITES THE ALIASES. DEPLOY.md tells you to use a Neon pooled URL and those carry
 * `?sslmode=require`, so on every cold start pg-connection-string wrote a multi-line SECURITY
 * WARNING to stderr saying `require` is an alias for `verify-full` today and adopts weaker libpq
 * semantics in pg v9. Vercel collects stderr, so it became a runtime error group: 59 occurrences
 * across 7 users since 2026-07-01, and the ONLY error group the project had. This is the fix the
 * warning itself names.
 *
 * AN EARLIER VERSION DELETED `sslmode` INSTEAD, AND THAT WAS A SECURITY BUG, kept here because the
 * reasoning that produced it is the reasoning most likely to produce it again. It shipped claiming
 * the explicit `ssl` option below beats the connection string. The opposite is true. pg 8.21.0,
 * connection-parameters.js:58:
 *
 *   if (config.connectionString) {
 *     config = Object.assign({}, config, parse(config.connectionString))
 *   }
 *
 * The parsed string is the LAST argument, so it overwrites the explicit option.
 *
 * SECOND, IT DECLARES A MODE WHEN THE URL HAS NONE, which is what closes the hole the alias fix
 * left behind. Resolved `ssl` as it actually reaches tls.connect:
 *
 *                            before                          after
 *   ?sslmode=require         {}                     verified  {}                     verified
 *   ?sslmode=verify-full     {}                     verified  {}                     verified
 *   no sslmode               {rejectUnauthorized:false}   NOT  {}                     verified
 *   ?sslmode=disable         false                  no TLS    false                  no TLS
 *
 * Production was already on the first row - confirmed by reading the live environment on
 * 2026-08-04, `DATABASE_URL` carries `sslmode=require`, no `uselibpqcompat`, and
 * `DATABASE_DIRECT_URL` is unset - so this changes nothing about how it connects today.
 * What it removes is the third row: verification was on by ACCIDENT of Neon putting `sslmode` in
 * the URL, and dropping that one parameter from the environment would have silently turned
 * certificate checking off with no error, no log line, and no test failing. Now the code states the
 * intent and the environment cannot quietly override it downward.
 *
 * `sslmode=disable` is deliberately still honoured. It means something, it is a choice someone made
 * on purpose, and a database config that ignores what it was told is worse than one that is loose.
 *
 * THE `ssl` OPTION BELOW IS NOW `{ rejectUnauthorized: true }` AND IS STILL MOSTLY DEAD, which is
 * the point. The string wins wherever pg can read a mode out of it, so the option decides only in
 * the corners - a `SSLMODE` in the wrong case, or `uselibpqcompat` with no mode - and in every one
 * of them it now fails SAFE. It used to fail open.
 *
 * IT DOES NOT DECIDE FOR AN UNPARSEABLE STRING, which an earlier version of this comment claimed.
 * pg parses with `new URL` as well, so a multi-host string or a password with an unencoded `/`
 * throws inside pg's own ConnectionParameters before `ssl` is resolved at all. Handing the value
 * back untouched keeps that error where it belongs instead of moving it to module load; it does not
 * hand the fallback a decision.
 *
 * THE MISTAKE THAT HID THE ORIGINAL BUG was the test, not the code. It asserted on
 * `pool.options.ssl`, which is the object handed to the constructor returned by identity, so it
 * passed under every possible precedence rule including the broken one. db/index.test.ts asserts on
 * `ConnectionParameters`, what pg actually derives, which is the only assertion with power here.
 */
export function withVerifiedSslMode(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    // This runs at module load, inside the `new Pool` below. `new Pool` itself does NOT parse
    // eagerly, so a connection string this cannot parse (a multi-host string, or a password with an
    // unencoded `/`) used to surface as a legible pg error on the first query. Throwing here would
    // instead take the whole app down at import, including /health, which is the probe DEPLOY.md
    // tells you to use to confirm a deploy shipped. Hand it back untouched: pg throws on the same
    // string from its own parser, which is where the error belongs. The `ssl` option below still
    // applies on that path, and it now fails SAFE rather than open.
    return value;
  }
  // `uselibpqcompat=true` is the one place the alias rewrite is NOT neutral. Under it pg gives
  // `require` real libpq semantics - `{rejectUnauthorized:false}` - while `verify-full` still means
  // verify, so rewriting would silently TIGHTEN a connection someone deliberately loosened. The
  // direction is safe and the claim "this changes nothing about how it connects" would stop being
  // true, which is worse: honour it, exactly as `sslmode=disable` is honoured below.
  if (/[?&]uselibpqcompat=(true|1|yes|on)\b/i.test(value)) return value;
  // NORMALIZE TO WHAT pg ACTUALLY READS, which is not the same as what the URL appears to say.
  // pg-connection-string looks the key up case-SENSITIVELY and takes the last value, so:
  //
  //   ?SSLMODE=require                  pg sees NO mode. Verified: it resolves to the `ssl` option,
  //                                     not to {}. An earlier version of this function treated the
  //                                     uppercase key as a declaration, skipped adding a lowercase
  //                                     one, and rewrote a parameter pg ignores entirely.
  //   ?sslmode=require&sslmode=disable  pg sees `disable`. The earlier version rewrote the FIRST
  //                                     key, and `searchParams.set` drops the duplicate, so it
  //                                     silently discarded `disable` and turned TLS on - exactly the
  //                                     "deliberate choices are honoured" promise below, broken.
  //   ?sslmode=                         pg sees an empty mode, which is no mode.
  //
  // So the effective value is read the way pg reads it, duplicates are collapsed to the single value
  // pg would have used, and the result is one lowercase key. That changes the bytes without ever
  // changing pg's interpretation.
  const declared = (url.searchParams.getAll('sslmode').at(-1) ?? '').toLowerCase();
  if (url.searchParams.getAll('sslmode').length > 1) {
    url.searchParams.delete('sslmode');
    url.searchParams.set('sslmode', declared);
  }
  // Only the warned aliases are rewritten, and an undeclared mode becomes verify-full. `disable`,
  // `allow` and `no-verify` mean something different, are a deliberate choice where they appear, and
  // are left exactly as configured.
  if (!declared || ALIASED_SSL_MODES.has(declared)) url.searchParams.set('sslmode', 'verify-full');
  return url.toString();
}

/**
 * The `ssl` option handed to pg for a hosted database.
 *
 * Exported so the test can assert on the value the code actually passes. An earlier version of the
 * suite declared its own `{ rejectUnauthorized: true }` constant and asserted against that, which
 * meant flipping the real one back to `false` left every test green - the same shape of hole as the
 * `pool.options.ssl` tautology this file already records. A constant a test defines for itself
 * proves nothing about the code.
 *
 * Mostly dead by design: withVerifiedSslMode makes the connection string declare a mode, and the
 * string beats this option wherever it parses. It decides only for a string `new URL` cannot read,
 * and there it must fail SAFE.
 */
export function sslOptionForHost(local: boolean): undefined | { rejectUnauthorized: true } {
  return local ? undefined : { rejectUnauthorized: true };
}

const pool = new Pool({
  connectionString: isLocal ? connectionString : withVerifiedSslMode(connectionString),
  ssl: sslOptionForHost(isLocal),
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
 * TWO CALL SHAPES ARE PASSED STRAIGHT THROUGH, because neither returns a promise this could await:
 *
 *   - The callback form, `query(text, values, cb)`. pg returns void and calls back instead.
 *   - A Submittable, `query(new QueryStream(...))`. pg detects it by a `submit` method and returns
 *     THE OBJECT ITSELF, synchronously, so the caller can stream rows off it. Wrapping that in a
 *     promise would hand back something with no `.on`, breaking the stream at the call site rather
 *     than here. Nothing in this repo streams today; the wrapper should not be the reason it never
 *     can, and a silent break of a future pg-query-stream would be very hard to trace back here.
 *
 * Neither shape can carry a read-only retry, and neither needs one: the incident was ordinary
 * awaited writes.
 */
const poolQuery = pool.query.bind(pool);
pool.query = ((...args: unknown[]) => {
  if (isPassThroughQueryCall(args)) {
    return (poolQuery as (...a: unknown[]) => unknown)(...args);
  }
  return withReadOnlyRetry(
    () => (poolQuery as (...a: unknown[]) => Promise<unknown>)(...args),
    {
      onRetry: (attempt) =>
        console.warn(
          `[db] write rejected by a read-only backend, retrying on a fresh connection (attempt ${attempt})`,
        ),
      onExhausted: async () => {
        console.warn('[db] pooled endpoint stayed read-only; retrying once on the direct database endpoint');
        const client = await connectDedicatedDatabaseClient();
        try {
          return await (client.query as (...a: unknown[]) => Promise<unknown>)(...args);
        } finally {
          await client.end().catch(() => undefined);
        }
      },
    },
  );
}) as typeof pool.query;

export const db = drizzle(pool, { schema });
export { pool };

export async function withDedicatedDatabase<T>(operation: (directDb: typeof db) => Promise<T>): Promise<T> {
  const client = await connectDedicatedDatabaseClient();
  try {
    const directDb = drizzle(client, { schema }) as unknown as typeof db;
    return await operation(directDb);
  } finally {
    await client.end().catch(() => undefined);
  }
}

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
    connectionString: directIsLocal ? directConnectionString : withVerifiedSslMode(directConnectionString),
    ssl: sslOptionForHost(directIsLocal),
  });
  await client.connect();
  return client;
}
