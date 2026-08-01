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
 *   MIN_LOGO_COVERAGE=0.8 node scripts/...       # raise the floor
 *
 * WHEN IT FIRES, the fix is to regenerate the map, not to lower the number:
 *
 *   node scripts/resolve-company-domains.mjs && git diff src/lib/companyDomains.ts
 *
 * The floor is both a quality target and a drift alarm. At least 75% of live job rows must show a
 * verified employer logo. MIN_LOGO_COVERAGE may raise that bar for a stricter run, but can never
 * lower it below the product guarantee.
 */

import { companyDomainFor } from '../src/lib/companyDomains.ts';
import { logoCoverageFloor } from '../src/lib/logoCoverage.ts';

const API = process.env.JOBS_API ?? 'https://student-outreach-backend.vercel.app';
const FLOOR = logoCoverageFloor(process.env.MIN_LOGO_COVERAGE);
const PAGE_SIZE = 100;
const MAX_ROWS = 100_000;
const PAGE_CONCURRENCY = 12;
const FAVICON_CONCURRENCY = 12;
const FAVICON_ENDPOINT = 'https://www.google.com/s2/favicons';

async function readPage(offset) {
  const res = await fetch(`${API}/jobs?limit=${PAGE_SIZE}&offset=${offset}`);
  if (!res.ok) throw new Error(`GET /jobs answered ${res.status} at offset ${offset}`);
  const body = await res.json();
  if (!Array.isArray(body.jobs)) throw new Error(`GET /jobs returned invalid jobs at offset ${offset}`);
  return body;
}

async function readBoard() {
  const first = await readPage(0);
  const total = Number(first.total);
  if (!Number.isSafeInteger(total) || total < first.jobs.length) {
    throw new Error('GET /jobs did not return a valid total');
  }
  if (total > MAX_ROWS) throw new Error(`job board has ${total} rows, above the ${MAX_ROWS}-row limit`);

  const rows = [...first.jobs];
  const offsets = [];
  for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) offsets.push(offset);
  for (let i = 0; i < offsets.length; i += PAGE_CONCURRENCY) {
    const pages = await Promise.all(offsets.slice(i, i + PAGE_CONCURRENCY).map(readPage));
    for (const page of pages) rows.push(...page.jobs);
  }
  if (rows.length !== total) throw new Error(`expected ${total} rows but read ${rows.length}`);
  return rows;
}

async function faviconLoads(domain) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`${FAVICON_ENDPOINT}?domain=${encodeURIComponent(domain)}&sz=64`);
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`favicon answered ${response.status} for ${domain}`);
      if (!response.headers.get('content-type')?.startsWith('image/')) {
        throw new Error(`favicon returned non-image content for ${domain}`);
      }
      return true;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function workingLogoDomains(domains) {
  const working = new Set();
  for (let i = 0; i < domains.length; i += FAVICON_CONCURRENCY) {
    const batch = domains.slice(i, i + FAVICON_CONCURRENCY);
    const results = await Promise.all(batch.map(async (domain) => [domain, await faviconLoads(domain)]));
    for (const [domain, loads] of results) if (loads) working.add(domain);
  }
  return working;
}

let rows;
try {
  rows = await readBoard();
} catch (error) {
  console.error(`FAILED: could not verify the complete live board (${error.message}).`);
  console.error('Coverage cannot be guaranteed when the measurement is incomplete.');
  process.exit(1);
}

if (rows.length === 0) {
  console.error('FAILED: the live board returned no jobs, so coverage cannot be verified.');
  process.exit(1);
}

const companies = [...new Set(rows.map((row) => row.company_name).filter(Boolean))];
const unmapped = companies.filter((name) => !companyDomainFor(name));
const mappedDomains = [...new Set(companies.map(companyDomainFor).filter(Boolean))];
let logoDomains;
try {
  logoDomains = await workingLogoDomains(mappedDomains);
} catch (error) {
  console.error(`FAILED: could not verify rendered favicons (${error.message}).`);
  process.exit(1);
}
const brokenLogoDomains = mappedDomains.filter((domain) => !logoDomains.has(domain));
const rowsWithLogo = rows.filter((row) => {
  const domain = companyDomainFor(row.company_name);
  return domain !== null && logoDomains.has(domain);
}).length;
const coverage = rowsWithLogo / rows.length;

console.log(`Checked all ${rows.length} live rows across ${companies.length} companies.`);
console.log(`Rows that would show a logo: ${rowsWithLogo} (${(coverage * 100).toFixed(0)}%).`);
console.log(`Companies with no verified domain: ${unmapped.length}.`);
console.log(`Mapped domains with no favicon response: ${brokenLogoDomains.length}.`);

if (coverage < FLOOR) {
  console.error(`\nLOGO COVERAGE BELOW FLOOR: ${(coverage * 100).toFixed(0)}% < ${(FLOOR * 100).toFixed(0)}%.`);
  console.error('The board has outgrown src/lib/companyDomains.ts, so job rows are showing initials');
  console.error('where they should show logos. Regenerate the map:');
  console.error('\n  node scripts/resolve-company-domains.mjs && git diff src/lib/companyDomains.ts\n');
  console.error(`Unmapped companies on the board: ${unmapped.slice(0, 25).join(', ')}`);
  if (unmapped.length > 25) console.error(`...and ${unmapped.length - 25} more.`);
  if (brokenLogoDomains.length > 0) console.error(`Domains without a rendered favicon: ${brokenLogoDomains.join(', ')}`);
  console.error('\nMIN_LOGO_COVERAGE cannot lower the enforced 75% minimum.');
  process.exit(1);
}

console.log(`\nCoverage is above the ${(FLOOR * 100).toFixed(0)}% floor.`);
