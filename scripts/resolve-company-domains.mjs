#!/usr/bin/env node
/**
 * Regenerate src/lib/companyDomains.ts from the companies currently on the board.
 *
 * WHY THIS EXISTS
 * ---------------
 * A job row shows the employer's logo, which needs the employer's domain, and the domain is not
 * anywhere in the system: `career_page_sources.career_url` holds the JOB BOARD for every source we
 * poll. The first version of the map was hand-written for the 51 sources that existed on
 * 2026-07-28. The board reached 239 companies within hours, because sources are being added
 * continuously, so a hand-written list is the wrong shape: it was 21% covered the day it landed.
 *
 * This script is the maintainable form. It proposes a domain per company, PROVES it, and writes the
 * file. Run it when the board grows, read the diff, commit it. The output is reviewable data rather
 * than a runtime dependency on anything.
 *
 *   node scripts/resolve-company-domains.mjs            # rewrite the map
 *   node scripts/resolve-company-domains.mjs --dry-run  # print what would change
 *
 * WHY IT IS THIS PARANOID
 * -----------------------
 * A wrong logo is worse than no logo: it tells a job seeker the row is a different company than it
 * is. The obvious approach — try <name>.com, then other TLDs, accept whichever answers and mentions
 * the name — was implemented first and was WRONG on real data. It accepted:
 *
 *     chime.ai for Chime      sofi.io for SoFi
 *     gusto.ai for Gusto      linear.io for Linear
 *
 * because a lookalike site naturally contains the company word, and because the correct `.com`
 * happened to refuse an automated request, so the search fell through to a worse candidate.
 *
 * Two rules follow, and they are the whole design:
 *
 *   1. A LOWER-PRIORITY CANDIDATE IS ONLY CONSIDERED WHEN THE HIGHER ONES PROVABLY DO NOT EXIST.
 *      A timeout, a 403, or a bot wall is NOT evidence against `.com` — it is no evidence at all,
 *      and continuing past it is exactly how chime.ai got accepted. Only a DNS miss counts.
 *   2. ACCEPTANCE NEEDS THE HOST AND THE PAGE TO AGREE. The host label must match the company slug,
 *      AND the page must name the company in its <title> or og:site_name. Either alone is too weak.
 *
 * When nothing can be proven the company is simply left out. That is not a failure: an unmapped
 * company renders its initial, which is honest and legible.
 */

import { writeFileSync, readFileSync } from 'node:fs';
import { resolve4, resolve6 } from 'node:dns/promises';

const API = process.env.JOBS_API ?? 'https://student-outreach-backend.vercel.app';
const OUT = new URL('../src/lib/companyDomains.ts', import.meta.url).pathname;
const DRY = process.argv.includes('--dry-run');

/** Tried in this order. `.com` first because it is right far more often than everything else. */
const TLDS = ['com', 'ai', 'io', 'app', 'co', 'so', 'org', 'net', 'dev', 'tv'];

/**
 * Company names too generic to resolve by name alone, and the reason each one is here.
 *
 * A single common word is the one case this script cannot decide, because a DIFFERENT company
 * legitimately owns that word's `.com` and its page naturally contains it, so every signal agrees
 * and all of them are wrong. Each of these was checked by hand on 2026-07-28:
 *
 *   Depot        depot.com is a holding page; the employer is depot.dev
 *   Fireworks    fireworks.com is "America's #1 Fireworks Retailer"; the employer is fireworks.ai
 *   honor        honor.com is the handset maker; the employer is honorcare.com
 *   Old Mission  oldmission.org is a Methodist church; the employer is oldmissioncapital.com
 *   Pinecone     pinecone.com is a domain-for-sale page; the employer is pinecone.io
 *   Knock        knock.com is a mortgage company also called Knock; which one posts here is unclear
 *   opal         opal.com is Open Advisors Limited; which Opal posts here is unclear
 *   Column       column.com serves no title, so there is nothing to verify against
 *
 * They render an initial, which is correct. Adding one back means proving it, not guessing it.
 */
const TOO_GENERIC = new Set(['depot', 'fireworks', 'honor', 'oldmission', 'pinecone', 'knock', 'opal', 'column']);

/**
 * Official domains that the strict resolver cannot prove automatically because the company uses a
 * non-obvious hostname, redirects to a differently named brand, or blocks automated requests.
 * Each homepage was reviewed against the employer name on 2026-08-02. Keys use the same
 * punctuation-insensitive normalization as the runtime lookup, so board spelling changes do not
 * create aliases or duplicate domains.
 */
const CURATED_DOMAINS = new Map([
  ['abnormalai', 'abnormal.ai'],
  ['andurilindustries', 'anduril.com'],
  ['anydesk', 'anydesk.com'],
  ['astronomer', 'astronomer.io'],
  ['axios', 'axios.com'],
  ['block', 'block.xyz'],
  ['box', 'box.com'],
  ['braintrust', 'usebraintrust.com'],
  ['codeforamerica', 'codeforamerica.org'],
  ['commonapp', 'commonapp.org'],
  ['databricks', 'databricks.com'],
  ['dataiku', 'dataiku.com'],
  ['decagon', 'decagon.ai'],
  ['elastic', 'elastic.co'],
  ['elevenlabs', 'elevenlabs.io'],
  ['epicgames', 'epicgames.com'],
  ['fastly', 'fastly.com'],
  ['fireworks', 'fireworks.ai'],
  ['givedirectly', 'givedirectly.org'],
  ['hellofresh', 'hellofresh.com'],
  ['justworks', 'justworks.com'],
  ['n26', 'n26.com'],
  ['openai', 'openai.com'],
  ['oscarhealth', 'hioscar.com'],
  ['quintoandar', 'quintoandar.com.br'],
  ['rocketlab', 'rocketlabcorp.com'],
  ['salesloft', 'salesloft.com'],
  ['seatgeek', 'seatgeek.com'],
  ['sierra', 'sierra.ai'],
  ['sigma', 'sigmacomputing.com'],
  ['spotify', 'spotify.com'],
  ['thenewyorktimes', 'nytco.com'],
  ['toast', 'toasttab.com'],
  ['tripadvisor', 'tripadvisor.com'],
  ['udemy', 'udemy.com'],
  ['vardaspaceindustries', 'varda.com'],
  ['voxmediagroup', 'voxmedia.com'],
  ['wiz', 'wiz.io'],
]);

/** A parked or for-sale domain is not a company, however much its page repeats the name. */
const PARKED_MARKERS = [
  'is for sale', 'domain for sale', 'buy this domain', 'aftermarket.com', 'hugedomains',
  'godaddy.com/domainsearch', 'parked domain', 'this domain may be for sale',
];

/** Never a company, whatever the page says. */
const NOT_COMPANIES = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'myworkdaysite.com',
  'workday.com', 'workable.com', 'jazzhr.com', 'applytojob.com', 'paylocity.com', 'bamboohr.com',
  'smartrecruiters.com', 'icims.com', 'taleo.net', 'jobvite.com', 'recruitee.com', 'breezy.hr',
  'teamtailor.com', 'successfactors.com', 'avature.net', 'oraclecloud.com', 'rippling.com',
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'wellfound.com', 'ziprecruiter.com',
  'godaddy.com', 'sedo.com', 'hugedomains.com', 'afternic.com', 'dan.com',
];

const norm = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
const LEGAL = /\s+(inc|llc|ltd|limited|corp|corporation|co|plc|gmbh|ag|bv|sa|pte)\s*$/i;
const cleanName = (n) => n.replace(/[.,]/g, ' ').replace(LEGAL, '').replace(/\s+/g, ' ').trim();

/**
 * Candidate hostnames for a company, WITHOUT the first-word shortcut.
 *
 * "Epic Games" must never try `epic.com`, which belongs to Epic Systems; nor "Rocket Lab"
 * `rocket.com`, nor "Marshall Wace" `marshall.com` (an amplifier manufacturer), nor "Pure Storage"
 * `pure.com`. An earlier version generated exactly those and accepted all four, because each site
 * naturally contains its own first word. A multi-word company gets its full name or nothing.
 */
function candidateLabels(name) {
  const c = cleanName(name);
  const full = norm(c);
  // Trailing descriptors only: "Scale AI" may try `scale.com`, which is genuinely theirs. This is
  // a suffix removal, never a truncation to the first word.
  const noSuffix = full.replace(/(ai|hq|labs|technologies|group)$/, '');
  return [...new Set([full, noSuffix].filter((s) => s.length >= 3))];
}

async function exists(domain) {
  try { await resolve4(domain); return true; } catch {}
  try { await resolve6(domain); return true; } catch {}
  return false;
}

async function fetchHome(domain) {
  for (const url of [`https://${domain}/`, `https://www.${domain}/`]) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      const res = await fetch(url, {
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; LitosCompanyDomainResolver/1.0)' },
      });
      clearTimeout(timer);
      const html = (await res.text()).slice(0, 150_000);
      return { ok: res.ok, finalHost: new URL(res.url).hostname.toLowerCase().replace(/^www\./, ''), html };
    } catch { /* try the www form, then give up */ }
  }
  return null;
}

/** The host and the page must agree that this is the company. Either signal alone is too weak. */
function accepts(company, domain, page) {
  if (!page?.ok) return null;
  const host = page.finalHost;
  if (NOT_COMPANIES.some((b) => host === b || host.endsWith(`.${b}`))) return null;

  const title = (page.html.match(/<title[^>]*>([\s\S]{0,300}?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const og = page.html.match(/property=["']og:site_name["'][^>]*content=["']([^"']{0,120})["']/i)?.[1] ?? '';

  if (!title.trim()) return null; // nothing to verify against

  const lowerHtml = `${title} ${page.html.slice(0, 4000)}`.toLowerCase();
  if (PARKED_MARKERS.some((m) => lowerHtml.includes(m))) return null;

  const target = norm(cleanName(company));
  const hostLabel = norm(host.split('.')[0]);
  const hostAgrees = hostLabel === target || target.startsWith(hostLabel) || hostLabel.startsWith(target);

  /* The page must name the COMPANY, not merely echo the hostname. Allowing the host label to
     satisfy this was the bug that accepted `epic.com` for Epic Games: the site says "Epic", the
     host says "epic", the two agreed with each other and nothing ever checked them against
     "Epic Games". A redirect to the real site still passes, because purestorage.com's title does
     contain "Pure Storage". */
  const pageAgrees = norm(`${title} ${og}`).includes(target);

  if (!hostAgrees || !pageAgrees) return null;

  /* Sites geo-redirect, and the resolver runs from wherever it runs: bitgo.com answered as
     bitgo.ae from Dubai, and airbnb.com as airbnb.ae. Same label, different country TLD means the
     candidate is the canonical one and the redirect target is an accident of where this ran. A
     genuinely different label (pure.com -> purestorage.com) is a real correction and is kept. */
  const candidateLabel = norm(domain.split('.')[0]);
  const canonical = hostLabel === candidateLabel ? domain : host;
  return { domain: canonical, evidence: title.slice(0, 60) };
}

async function resolveCompany(name) {
  if (TOO_GENERIC.has(norm(cleanName(name)))) return null;
  for (const label of candidateLabels(name)) {
    for (const tld of TLDS) {
      const domain = `${label}.${tld}`;
      if (!(await exists(domain))) continue; // provably absent: safe to try the next TLD
      const page = await fetchHome(domain);
      const hit = accepts(name, domain, page);
      if (hit) return hit;
      /* It EXISTS but did not prove itself: a bot wall, a parked page, or a different company.
         Stop this label here. Walking on to a lower-priority TLD is precisely how `chime.ai` was
         accepted for Chime while `chime.com` sat behind a 403. Unproven beats wrong. */
      break;
    }
  }
  return null;
}

async function boardCompanies() {
  const names = new Set();
  for (let offset = 0; offset < 5000; offset += 100) {
    const res = await fetch(`${API}/jobs?limit=100&offset=${offset}`);
    if (!res.ok) break;
    const body = await res.json();
    for (const job of body.jobs ?? []) names.add(job.company_name);
    if (!body.has_more) break;
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function render(entries, header) {
  const rows = entries
    .map(([name, domain]) => `  ${JSON.stringify(name)}: ${JSON.stringify(domain)},`)
    .join('\n');
  return header.replace('__ENTRIES__', rows).replace('__COUNT__', String(entries.length));
}

const HEADER_MARK = '/** Company name exactly as the job board reports it, mapped to the employer\'s own domain. */';

(async () => {
  const existing = readFileSync(OUT, 'utf8');
  const head = existing.slice(0, existing.indexOf(HEADER_MARK) + HEADER_MARK.length);
  const tail = existing.slice(existing.indexOf('};'));

  const names = await boardCompanies();
  console.error(`companies on the board: ${names.length}`);

  const resolvedByNameKey = new Map();
  for (const m of existing.matchAll(/^\s{2}"([^"]+)":\s*"([^"]+)",/gm)) {
    const nameKey = norm(m[1]);
    if (!resolvedByNameKey.has(nameKey)) resolvedByNameKey.set(nameKey, [m[1], m[2]]);
  }

  for (const name of names) {
    const nameKey = norm(name);
    const curatedDomain = CURATED_DOMAINS.get(nameKey);
    if (curatedDomain) resolvedByNameKey.set(nameKey, [name, curatedDomain]);
  }

  let added = 0, failed = 0, i = 0;
  const queue = names.filter((n) => !resolvedByNameKey.has(norm(n)));
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < queue.length) {
      const name = queue[i++];
      const hit = await resolveCompany(name).catch(() => null);
      if (hit) {
        const nameKey = norm(name);
        if (!resolvedByNameKey.has(nameKey)) {
          resolvedByNameKey.set(nameKey, [name, hit.domain]);
          added++;
          console.error(`  + ${name} -> ${hit.domain}`);
        }
      }
      else { failed++; console.error(`  ? ${name} (unproven, will show an initial)`); }
    }
  }));

  const entries = [...resolvedByNameKey.values()].sort((a, b) => a[0].localeCompare(b[0]));
  console.error(`\nresolved ${added} new, ${failed} left unproven, ${entries.length} total`);
  if (DRY) return;
  writeFileSync(OUT, `${head}\nconst COMPANY_DOMAINS: Record<string, string> = {\n${entries.map(([n, d]) => `  ${JSON.stringify(n)}: ${JSON.stringify(d)},`).join('\n')}\n${tail}`);
  console.error(`wrote ${OUT}`);
})();
