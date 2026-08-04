import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema';

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/student_outreach';

// Local Postgres needs no SSL; hosted serverless Postgres (Neon / Vercel Postgres) requires it.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

/**
 * Drop `sslmode` from a connection string before pg parses it.
 *
 * DEPLOY.md tells you to use a Neon pooled URL, and Neon's URLs carry `?sslmode=require`. On every
 * cold start pg-connection-string then writes a multi-line SECURITY WARNING to stderr about
 * `require` being an alias for `verify-full` today and adopting weaker libpq semantics in pg v9.
 * Vercel collects stderr, so it lands in the runtime error groups: measured 2026-08-04, 59
 * occurrences across 7 users since 2026-07-01, and it was the ONLY error group the project had.
 * A permanent false positive in the place you look during an incident is worth deleting.
 *
 * THIS CHANGES NO TLS BEHAVIOUR, and that is verified rather than assumed. The `ssl` option below
 * is passed explicitly, and an explicit `ssl` beats whatever the connection string says. Checked
 * against the pinned pg 8.21.0:
 *
 *   connectionString with `?sslmode=require` + ssl {rejectUnauthorized:false} -> {rejectUnauthorized:false}
 *   connectionString without sslmode        + ssl {rejectUnauthorized:false} -> {rejectUnauthorized:false}
 *
 * Identical. The warning fires in the first case and not the second, which is the whole difference.
 * The test in db/index.test.ts pins both halves so this cannot silently become a real change.
 *
 * SO THE WARNING IS SUPPRESSED, NOT ANSWERED, and the distinction matters. What it warns about is
 * real: `rejectUnauthorized: false` means the server certificate is NOT verified, so today's
 * connection is weaker than the `sslmode=require` in the URL suggests. That is pre-existing and is
 * NOT changed here, because turning verification on cannot be tested against the production
 * database from here and getting it wrong takes the API's database down. It is called out in
 * DEPLOY.md as a decision to make deliberately.
 */
export function withoutSslMode(value: string): string {
  if (!/[?&]sslmode=/i.test(value)) return value;
  const url = new URL(value);
  url.searchParams.delete('sslmode');
  return url.toString();
}

const pool = new Pool({
  connectionString: isLocal ? connectionString : withoutSslMode(connectionString),
  ssl: isLocal ? undefined : { rejectUnauthorized: false },
  // Keep the per-instance pool tiny on serverless (one container == one or few requests)
  // to avoid exhausting the database's connection limit across many warm lambdas.
  max: process.env.VERCEL ? 1 : 10,
});

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
    // handed to pg is stripped.
    connectionString: directIsLocal ? directConnectionString : withoutSslMode(directConnectionString),
    ssl: directIsLocal ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}
