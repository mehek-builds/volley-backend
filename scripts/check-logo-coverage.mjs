#!/usr/bin/env node
/**
 * Fail when the job board has outgrown the company-domain map.
 *
 * WHY THIS EXISTS
 * ---------------
 * The employer logo on a job row is the kind of feature that breaks without ever failing: no
 * exception, no console error, no red test, no wrong pixel — just a column of empty circles that
 * nobody notices because everything "works". It has already broken twice that way.
 *
 *   2026-07-28  The domain was derived from `career_url`, which holds the JOB BOARD on every source
 *               we poll. Every row resolved to null. 0 of 100 rows showed a logo, for weeks, and
 *               the entire test suite was green the whole time.
 *   2026-07-29  A hand-written map covered the 51 companies that existed when it was written. The
 *               board reached 239 within hours because sources are added continuously, so it was
 *               21% covered the day it landed and falling.
 *
 * The second one is the reason this file exists, because it is the one that comes back. Nothing in
 * the repo can tell that the map has decayed: it stays internally consistent, its own tests keep
 * passing, and coverage silently drops as the board grows. Only a measurement against the LIVE
 * board can see it, which is exactly the shape of check-schema-drift.mjs — the same idea, pointed
 * at a different kind of drift.
 *
 *   node scripts/check-logo-coverage.mjs         # exit 1 when coverage is below the floor
 *   MIN_LOGO_COVERAGE=0.6 node scripts/...       # override the floor
 *
 * WHEN IT FIRES, the fix is to regenerate the map, not to lower the number:
 *
 *   node scripts/resolve-company-domains.mjs && git diff src/lib/companyDomains.ts
 *
 * The floor is deliberately well below today's measurement. It is a smoke alarm for "the board grew
 * past the map again", not a quality target — a company the resolver cannot prove is CORRECTLY
 * absent, and its row shows an initial, so 100% is neither achievable nor desirable.
 */

import { companyDomainFor } from '../src/lib/companyDomains.ts';

const API = process.env.JOBS_API ?? 'https://student-outreach-backend.vercel.app';
const FLOOR = Number(process.env.MIN_LOGO_COVERAGE ?? 0.55);
const SAMPLE_PAGES = 5;

async function sampleBoard() {
  const rows = [];
  for (let page = 0; page < SAMPLE_PAGES; page++) {
    const res = await fetch(`${API}/jobs?limit=100&offset=${page * 100}`);
    if (!res.ok) throw new Error(`GET /jobs answered ${res.status}`);
    const body = await res.json();
    rows.push(...(body.jobs ?? []));
    if (!body.has_more) break;
  }
  return rows;
}

let rows;
try {
  rows = await sampleBoard();
} catch (error) {
  /* Skips rather than fails when the board is unreachable, and says so LOUDLY. A network blip must
     not turn a CI run red, but a silent skip would leave a green tick meaning "not checked", which
     is the failure mode this whole file is about. */
  console.error(`SKIPPED: could not read the board (${error.message}).`);
  console.error('This check did NOT run. It is not a pass.');
  process.exit(0);
}

if (rows.length === 0) {
  console.error('SKIPPED: the board returned no jobs, so there is nothing to measure.');
  process.exit(0);
}

const companies = [...new Set(rows.map((row) => row.company_name).filter(Boolean))];
const unmapped = companies.filter((name) => !companyDomainFor(name));
const rowsWithLogo = rows.filter((row) => companyDomainFor(row.company_name)).length;
const coverage = rowsWithLogo / rows.length;

console.log(`Sampled ${rows.length} rows across ${companies.length} companies.`);
console.log(`Rows that would show a logo: ${rowsWithLogo} (${(coverage * 100).toFixed(0)}%).`);
console.log(`Companies with no verified domain: ${unmapped.length}.`);

if (coverage < FLOOR) {
  console.error(`\nLOGO COVERAGE BELOW FLOOR: ${(coverage * 100).toFixed(0)}% < ${(FLOOR * 100).toFixed(0)}%.`);
  console.error('The board has outgrown src/lib/companyDomains.ts, so job rows are showing initials');
  console.error('where they should show logos. Regenerate the map:');
  console.error('\n  node scripts/resolve-company-domains.mjs && git diff src/lib/companyDomains.ts\n');
  console.error(`Unmapped companies in the sample: ${unmapped.slice(0, 25).join(', ')}`);
  if (unmapped.length > 25) console.error(`...and ${unmapped.length - 25} more.`);
  console.error('\nDo NOT fix this by lowering MIN_LOGO_COVERAGE.');
  process.exit(1);
}

console.log(`\nCoverage is above the ${(FLOOR * 100).toFixed(0)}% floor.`);
