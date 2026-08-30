#!/usr/bin/env node
/**
 * Prove that every surfaced posting has a verified company logo.
 *
 * The backend supplies a row-weighted list of company and ATS board pairs. The website logo
 * service resolves each pair from a human-approved asset, an ATS-hosted mark, or an employer
 * domain established from that exact board. `miss=404` prevents the service from substituting a
 * monogram, so a passing run means every counted row renders a real mark.
 */

import { logoCoverageFloor, tallyCoverage } from '../src/lib/logoCoverage.ts';

const API = (process.env.JOBS_API ?? 'https://api.trylitos.com').replace(/\/+$/, '');
const WEBSITE = (process.env.JOBS_WEBSITE ?? 'https://trylitos.com').replace(/\/+$/, '');
const FLOOR = logoCoverageFloor(process.env.MIN_LOGO_COVERAGE);
const CONCURRENCY = 12;

async function logoWorks(source) {
  const query = new URLSearchParams({
    c: source.company_name,
    board: source.career_url,
    miss: '404',
  });
  const response = await fetch(`${WEBSITE}/api/company-logo?${query}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`logo service answered ${response.status} for ${source.company_name}`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) {
    throw new Error(`logo service returned ${type || 'no content type'} for ${source.company_name}`);
  }
  return true;
}

const response = await fetch(`${API}/jobs/facets?counts=true`, {
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`GET /jobs/facets?counts=true answered ${response.status}`);
const body = await response.json();
if (!Array.isArray(body.company_logo_sources) || body.company_logo_sources.length === 0) {
  throw new Error('GET /jobs/facets?counts=true returned no company_logo_sources');
}

const sources = body.company_logo_sources;
for (const source of sources) {
  if (typeof source.company_name !== 'string' || !source.company_name.trim()) {
    throw new Error('company_logo_sources contains a blank company name');
  }
  if (typeof source.career_url !== 'string' || !source.career_url.startsWith('https://')) {
    throw new Error(`company_logo_sources contains an invalid board URL for ${source.company_name}`);
  }
}
const working = new Set();
for (let index = 0; index < sources.length; index += CONCURRENCY) {
  const batch = sources.slice(index, index + CONCURRENCY);
  const results = await Promise.all(batch.map(async (source) => [source, await logoWorks(source)]));
  for (const [source, ok] of results) {
    if (ok) working.add(`${source.company_name}\n${source.career_url}`);
  }
}

const tally = tallyCoverage(
  sources.map((source) => ({
    company_name: `${source.company_name}\n${source.career_url}`,
    rows: Number(source.rows),
  })),
  (key) => working.has(key),
);

console.log(`Checked ${tally.totalRows} live postings across ${sources.length} company-board sources.`);
console.log(`Postings with a verified logo: ${tally.rowsWithLogo} (${(tally.coverage * 100).toFixed(2)}%).`);

if (tally.coverage < FLOOR) {
  const missing = tally.withoutLogo.map((key) => key.split('\n')[0]);
  console.error(`LOGO COVERAGE BELOW FLOOR: ${(tally.coverage * 100).toFixed(2)}% < ${(FLOOR * 100).toFixed(0)}%.`);
  console.error(`Sources without a verified logo: ${missing.slice(0, 50).join(', ')}`);
  if (missing.length > 50) console.error(`...and ${missing.length - 50} more.`);
  process.exit(1);
}

console.log('Every surfaced posting has a verified company logo.');
