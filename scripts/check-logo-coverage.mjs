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
 *
 * MEASURED AGAINST A TABLE THAT IS BEING WRITTEN TO. The job-poll cron upserts into monitored_jobs
 * and then purges from it, so the board moves underneath the scan and there is no instant at which
 * a paged read is a snapshot. Demanding an exact row count against that moving target is what made
 * this check flaky, failing PRs whose CI merely overlapped a poll. lib/boardScan.ts does the read
 * and tolerates the churn; coverage below is a ratio over the rows it actually returned.
 *
 * The tolerance must never buy a weaker verdict. The floor is still enforced over a full board's
 * worth of distinct rows, and a read that is genuinely incomplete still fails.
 */

import { companyDomainFor } from '../src/lib/companyDomains.ts';
import { logoCoverageFloor } from '../src/lib/logoCoverage.ts';
import { scanBoard } from '../src/lib/boardScan.ts';
import { createHash } from 'node:crypto';

const API = process.env.JOBS_API ?? 'https://student-outreach-backend.vercel.app';
const FLOOR = logoCoverageFloor(process.env.MIN_LOGO_COVERAGE);
const PAGE_SIZE = 100;
const MAX_ROWS = 100_000;
const FAVICON_CONCURRENCY = 12;
const FAVICON_ENDPOINT = 'https://www.google.com/s2/favicons';

async function readPage(offset, limit = PAGE_SIZE) {
  const res = await fetch(`${API}/jobs?limit=${limit}&offset=${offset}`);
  if (!res.ok) throw new Error(`GET /jobs answered ${res.status} at offset ${offset}`);
  const body = await res.json();
  if (!Array.isArray(body.jobs)) throw new Error(`GET /jobs returned invalid jobs at offset ${offset}`);
  const total = Number(body.total);
  if (!Number.isSafeInteger(total) || total < body.jobs.length) {
    throw new Error('GET /jobs did not return a valid total');
  }
  if (total > MAX_ROWS) throw new Error(`job board has ${total} rows, above the ${MAX_ROWS}-row limit`);
  return { jobs: body.jobs, total };
}

const readBoard = () => scanBoard({
  readPage,
  idOf: (row) => row.id,
  pageSize: PAGE_SIZE,
  onRetry: (reason) => console.log(`Retrying the scan: ${reason}.`),
});

const fingerprint = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function faviconResponse(domain) {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await fetch(`${FAVICON_ENDPOINT}?domain=${encodeURIComponent(domain)}&sz=64`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if (response.status !== 404 && !response.ok) throw new Error(`favicon answered ${response.status} for ${domain}`);
      if (!response.headers.get('content-type')?.startsWith('image/')) {
        throw new Error(`favicon returned non-image content for ${domain}`);
      }
      return { status: response.status, fingerprint: fingerprint(bytes) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function workingLogoDomains(domains) {
  const fallback = await faviconResponse('litos-guaranteed-missing-favicon.invalid');
  const working = new Set();
  for (let i = 0; i < domains.length; i += FAVICON_CONCURRENCY) {
    const batch = domains.slice(i, i + FAVICON_CONCURRENCY);
    const results = await Promise.all(batch.map(async (domain) => [domain, await faviconResponse(domain)]));
    for (const [domain, response] of results) {
      if (response.status === 200 && response.fingerprint !== fallback.fingerprint) working.add(domain);
    }
  }
  return working;
}

let rows;
let lowest;
let highest;
try {
  ({ rows, lowest, highest } = await readBoard());
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

console.log(`Checked ${rows.length} distinct live rows across ${companies.length} companies.`);
if (highest !== lowest) {
  console.log(`The board moved from ${lowest} to ${highest} rows mid-scan; coverage is measured over what was read.`);
}
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
