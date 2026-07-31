import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool } from 'pg';
import * as schema from './schema';

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/student_outreach';

// Local Postgres needs no SSL; hosted serverless Postgres (Neon / Vercel Postgres) requires it.
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
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
    connectionString: directConnectionString,
    ssl: directIsLocal ? undefined : { rejectUnauthorized: false },
  });
  await client.connect();
  return client;
}
