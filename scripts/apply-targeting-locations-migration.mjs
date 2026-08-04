#!/usr/bin/env node
import 'dotenv/config';
import pg from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(2);
}

// Verification on, matching sslOptionForHost in src/db/index.ts. See DEPLOY.md's TLS section.
const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: true } });
try {
  await client.connect();
  await client.query('alter table targeting add column if not exists locations jsonb');
  await client.query('alter table targeting add column if not exists remote_only boolean not null default false');
  console.log('Targeting location columns are ready.');
} finally {
  await client.end();
}
