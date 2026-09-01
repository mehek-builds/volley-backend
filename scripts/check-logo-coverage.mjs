#!/usr/bin/env node
/**
 * Prove that every surfaced posting has a verified company logo.
 *
 * The backend supplies a row-weighted list of company and ATS board pairs, and since 2026-09-01
 * each pair carries the verifier's own evidence: the first-party logo URL the source was surfaced
 * on. The check probes THAT, once per distinct asset, and only walks a source through the
 * website's live resolver when its evidence alone cannot prove a rendered mark.
 *
 * WHY THE EVIDENCE AND NOT THE RESOLVER. The first per-source version of this check drove
 * trylitos.com/api/company-logo once per source, 64 in flight, and the measurement broke the
 * thing it measured: every probe made the website query the backend and fetch an upstream asset,
 * one container absorbed all of it, and a rotating ~14% of lookups blew their internal budgets.
 * Measured 2026-09-01 across two consecutive full runs: 83.20% then 86.33%, with ZERO overlap
 * between the two runs' first-50 miss lists, while every named miss resolved instantly when
 * probed serially. A floor of 100% cannot be certified by a measurement whose failures are its
 * own load. The asset URL is the fact the gate exists to prove, and the CDNs serving them take
 * this concurrency without blinking.
 *
 * The resolver is still consulted, twice, deliberately:
 *   - sources whose evidence fails the probe get a SERIAL pass through the website route, because
 *     the route has more moves than one URL (verified-domain icon scans, board-hosted marks) and
 *     what finally matters is what a job seeker's tile renders;
 *   - until the backend that sends the evidence fields is deployed, the script falls back to the
 *     old full resolver scan rather than failing on the missing fields, and says so.
 *
 * `miss=404` on resolver probes prevents the service from substituting a monogram, so a passing
 * run still means every counted row renders a real mark.
 */

import { logoCoverageFloor, tallyCoverage } from '../src/lib/logoCoverage.ts';
import { evidenceDefect, servableImageType } from '../src/lib/logoEvidenceProbe.ts';

const API = (process.env.JOBS_API ?? 'https://api.trylitos.com').replace(/\/+$/, '');
const WEBSITE = (process.env.JOBS_WEBSITE ?? 'https://trylitos.com').replace(/\/+$/, '');
const FLOOR = logoCoverageFloor(process.env.MIN_LOGO_COVERAGE);
/* Evidence probes hit ATS CDNs and our own storage, which sustain this happily; it is the
   resolver that cannot (see the header), which is why resolver fallbacks below run near-serial. */
const CONCURRENCY = Math.max(1, Number(process.env.LOGO_CHECK_CONCURRENCY) || 64);
/* The backend verifier caps assets at 1MB; anything larger than double that is not a logo and is
   not worth downloading to prove it. */
const MAX_PROBE_BYTES = 2 * 1024 * 1024;

const key = (source) => `${source.company_name}\n${source.career_url}`;

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
  // half-read bodies holding sockets open.
  await response.body?.cancel();
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`logo service answered ${response.status} for ${source.company_name}`);
  const type = response.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) {
    throw new Error(`logo service returned ${type || 'no content type'} for ${source.company_name}`);
  }
  return true;
}

// One retry, because across thousands of requests a single transient 502 or reset would otherwise
// decide the job. A second consecutive failure is treated as real.
async function withRetry(probe) {
  try {
    return await probe();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    return probe();
  }
}

async function probeEvidenceUrl(url) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: { Accept: '*/*' },
  });
  if (!response.ok) {
    await response.body?.cancel();
    return false;
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_PROBE_BYTES) {
    await response.body?.cancel();
    return false;
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_PROBE_BYTES) return false;
  return servableImageType(response.headers.get('content-type'), bytes) !== null;
}

/* A sliding pool, not fixed batches: a Promise.all barrier every CONCURRENCY items makes each
   round as slow as its slowest miss. Every finished probe immediately frees its slot. */
async function drain(items, worker, concurrency, label) {
  const startedAt = Date.now();
  let cursor = 0;
  let done = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor];
      cursor += 1;
      await worker(item);
      done += 1;
      // The only other output comes at the end. Without a heartbeat a wedged run is silent
      // minutes and then a kill, indistinguishable from a hang in the first fetch.
      if (done % 1000 === 0 || done === items.length) {
        const seconds = Math.round((Date.now() - startedAt) / 1000);
        console.log(`${label}: ${done}/${items.length} in ${seconds}s.`);
      }
    }
  }));
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
const evidenceMode = sources.some((source) => 'company_logo_url' in source);

if (evidenceMode) {
  /* Sources the evidence cannot vouch for, by named class: a surfaced source without verified
     evidence means the surfacing GATE broke, which is a different incident than a dead asset. */
  const defects = new Map();
  const urlOf = new Map();
  for (const source of sources) {
    const defect = evidenceDefect(source);
    if (defect) defects.set(key(source), defect);
    else urlOf.set(key(source), source.company_logo_url.trim());
  }
  if (defects.size) {
    const classes = new Map();
    for (const reason of defects.values()) classes.set(reason, (classes.get(reason) ?? 0) + 1);
    for (const [reason, count] of classes) {
      console.error(`GATE BREACH: ${count} surfaced source(s) with ${reason}.`);
    }
  }

  /* One probe per distinct asset, not per source: same-org sources share a mark. */
  const urls = [...new Set(urlOf.values())];
  const urlServes = new Map();
  console.log(`Probing ${urls.length} distinct evidence assets for ${sources.length} sources.`);
  await drain(urls, async (url) => {
    urlServes.set(url, await withRetry(() => probeEvidenceUrl(url)).catch(() => false));
  }, CONCURRENCY, 'Evidence assets probed');

  for (const source of sources) {
    if (urlServes.get(urlOf.get(key(source)))) working.add(key(source));
  }

  /* The residue gets the authoritative answer: what does the tile actually render? Near-serial
     on purpose, because hammering the resolver is the measurement error this rewrite removes. */
  /* A gate breach gets NO resolver rescue. The resolver's last resort is a name guess, and a
     name guess can dress a source whose verification is broken (measured in rehearsal: a
     fabricated unverified source came back name-guess:pending.com). Letting that count would
     hide a broken backend invariant behind the exact mechanism the verifier exists to replace,
     so a surfaced-but-unverified source stays a miss until the backend re-verifies it. */
  const residue = sources.filter(
    (source) => !working.has(key(source)) && !defects.has(key(source)),
  );
  if (residue.length) {
    console.log(`Evidence could not vouch for ${residue.length} source(s); asking the live resolver, gently.`);
    await drain(residue, async (source) => {
      if (await withRetry(() => probeLogo(source)).catch(() => false)) working.add(key(source));
    }, 4, 'Resolver fallbacks probed');
  }
} else {
  /* The deployed backend predates the evidence fields: fall back to the full resolver scan so
     the gate keeps meaning something, and say so, loudly, because this mode is the one whose
     failures are partly its own load. */
  console.log('NOTE: /jobs/facets sent no evidence fields; falling back to the full resolver scan.');
  await drain(sources, async (source) => {
    if (await withRetry(() => probeLogo(source)).catch(() => false)) working.add(key(source));
  }, CONCURRENCY, 'Sources probed');
}

const tally = tallyCoverage(
  sources.map((source) => ({
    company_name: key(source),
    rows: Number(source.rows),
  })),
  (k) => working.has(k),
);

console.log(`Checked ${tally.totalRows} live postings across ${sources.length} company-board sources.`);
console.log(`Postings with a verified logo: ${tally.rowsWithLogo} (${(tally.coverage * 100).toFixed(2)}%).`);

if (tally.coverage < FLOOR) {
  const missing = tally.withoutLogo.map((k) => k.split('\n')[0]);
  console.error(`LOGO COVERAGE BELOW FLOOR: ${(tally.coverage * 100).toFixed(2)}% < ${(FLOOR * 100).toFixed(0)}%.`);
  console.error(`Sources without a verified logo: ${missing.slice(0, 50).join(', ')}`);
  if (missing.length > 50) console.error(`...and ${missing.length - 50} more.`);
  process.exit(1);
}

console.log('Every surfaced posting has a verified company logo.');
