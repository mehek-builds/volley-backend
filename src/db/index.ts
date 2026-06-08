import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
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
