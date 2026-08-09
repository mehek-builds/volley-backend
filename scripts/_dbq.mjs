#!/usr/bin/env node
// Read-only production query helper. Usage: node dbq.mjs "select ..."
import pg from 'pg';
import fs from 'node:fs';

const envPath = '/Users/Mehek1/Documents/student-outreach-backend/.env.local';
const raw = fs.readFileSync(envPath, 'utf8');
for (const line of raw.split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const sql = process.argv.slice(2).join(' ');
if (!sql) { console.error('usage: dbq.mjs "<sql>"'); process.exit(2); }

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  const res = await client.query(sql);
  if (Array.isArray(res)) {
    for (const r of res) console.log(JSON.stringify(r.rows, null, 2));
  } else {
    console.log(JSON.stringify(res.rows, null, 2));
  }
} finally {
  await client.end();
}
