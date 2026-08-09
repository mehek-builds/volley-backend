#!/usr/bin/env tsx
/* MEASUREMENT, not a code read: print every distinct question label Litos has ever stored whose
 * text matches a regex given on the command line, with how many times it was stored.
 *
 * Companion to _sweep-untraceable.mts. That one asks "what does the resolver answer with nothing
 * stored"; this one asks "what wording do employers actually use", which is the question you have
 * to answer before writing a pattern. Written for the 18+ attestation and the legal-name work: the
 * corpus turned out to carry exactly one age-attestation wording and two full-legal-name labels,
 * and the nearest miss to both was IMC's "within the last 12-18 months".
 *
 *   npx tsx scripts/_corpus-labels.mts 'legal\s+name'
 *
 * Read-only. SELECT only.
 */
import pg from 'pg';
import fs from 'node:fs';

const pattern = process.argv[2];
if (!pattern) {
  console.error('usage: tsx scripts/_corpus-labels.mts <regex>');
  process.exit(1);
}
const re = new RegExp(pattern, 'i');

const envPath = '/Users/Mehek1/Documents/student-outreach-backend/.env.local';
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const labels: string[] = [];
const packets = await client.query(`
  select q->>'question' as label
    from generated_resumes, lateral jsonb_array_elements(spec->'_review'->'questions') q
   where jsonb_typeof(spec->'_review'->'questions') = 'array'`);
const posting = await client.query(`
  select q->>'label' as label
    from posting_questions, lateral jsonb_array_elements(questions) q
   where jsonb_typeof(questions) = 'array'`);
const saved = await client.query(`select question as label from saved_application_answers`);
await client.end();
for (const set of [packets.rows, posting.rows, saved.rows]) {
  for (const r of set) if (r.label) labels.push(r.label.trim());
}

const counts = new Map<string, number>();
for (const label of labels) if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
const hits = [...counts].filter(([label]) => re.test(label)).sort((a, b) => b[1] - a[1]);
console.log(`${labels.length} stored questions, ${counts.size} distinct labels, ${hits.length} matching /${pattern}/i\n`);
for (const [label, count] of hits) console.log(`[${String(count).padStart(3)}x] ${label.replace(/\s+/g, ' ').slice(0, 200)}`);
