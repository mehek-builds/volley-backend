#!/usr/bin/env node

/* monitored_jobs.posting_deadline: the employer's own stated application deadline, when its
 * description names one. See src/lib/postingDeadline.ts for the parser and src/db/schema.ts for
 * the column's own reasoning.
 *
 * NULLABLE, ADDITIVE, NO BACKFILL - the same shape as apply-job-first-entry-migration.mjs and
 * apply-targeting-locations-migration.mjs. Nothing in the application read path depends on this
 * column being populated: derivePostingDeadlineStatus computes an existing packet's deadline
 * lazily from its own frozen jd_text, so a flag does not wait on this column, on a repoll, or on
 * this script having run at all. This migration exists so the ingest poll (src/routes/
 * jobMonitor.ts) has somewhere to persist what it already parses, for a future SQL-level filter -
 * not because today's feature reads it.
 */

import 'dotenv/config';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

// Verification on, matching sslOptionForHost in src/db/index.ts. See DEPLOY.md's TLS section.
const client = new pg.Client({
  connectionString,
  // Guarded like the other scripts and like src/db/index.ts: a LOCAL Postgres often has a
  // self-signed certificate, and forcing verification on it turns a working dev setup into a
  // connection error. `.env.example` points at localhost.
  ssl: /localhost|127\.0\.0\.1/.test(connectionString) ? undefined : { rejectUnauthorized: true },
});
try {
  await client.connect();
  await client.query('alter table monitored_jobs add column if not exists posting_deadline timestamptz');
  console.log('monitored_jobs.posting_deadline is ready.');
} finally {
  await client.end();
}
