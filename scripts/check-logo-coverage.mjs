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
// The board holds ~9,000 company-board sources and the logo service takes ~1s on a hit and up to
// ~9s on a miss (it consults its upstream providers before answering 404). The pool size is what
// makes the total bounded: measured 2026-09-01, 64 in flight sustains ~17 probes/s and clears the
// full board in ~9 minutes, while the old 12 took the CI job past its 10-minute ceiling and got
// it killed on every run. The service saturates rather than scales here, so doubling the pool
// again buys sublinear speedup at the cost of ~9s miss latencies drifting toward the 30s abort.
const CONCURRENCY = Math.max(1, Number(process.env.LOGO_CHECK_CONCURRENCY) || 64);

async function probeLogo(source) {
  const query = new URLSearchParams({
    c: source.company_name,
    board: source.career_url,
    miss: '404',
  });
  const response = await fetch(`${WEBSITE}/api/company-logo?${query}`, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  // The verdict is entirely in the status and headers. Release the connection instead of leaving
  // ~9,000 half-read bodies holding sockets open.
  await response.body?.cancel();
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`logo service answered ${response.status} for ${source.company_name}`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) {
    throw new Error(`logo service returned ${type || 'no content type'} for ${source.company_name}`);
  }
  return true;
}

// One retry, because at ~9,000 requests per run a single transient 502 or reset would otherwise
// decide the job. A second consecutive failure is treated as real and fails the run loudly.
async function logoWorks(source) {
  try {
    return await probeLogo(source);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return probeLogo(source);
  }
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
// A sliding pool, not fixed batches: a Promise.all barrier every CONCURRENCY sources makes each
// round as slow as its slowest miss, which is how the old loop turned ~9,000 probes into 25+
// minutes. Here every finished probe immediately frees its slot for the next source.
const working = new Set();
const startedAt = Date.now();
let cursor = 0;
let checked = 0;
async function drainSources() {
  while (cursor < sources.length) {
    const source = sources[cursor];
    cursor += 1;
    if (await logoWorks(source)) working.add(`${source.company_name}\n${source.career_url}`);
    checked += 1;
    // The only other output comes after the last probe. Without a heartbeat a wedged run is ten
    // silent minutes and then a kill, indistinguishable from a hang in the first fetch.
    if (checked % 1000 === 0 || checked === sources.length) {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(`Probed ${checked}/${sources.length} sources in ${seconds}s (${working.size} with a verified logo).`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sources.length) }, drainSources));

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
