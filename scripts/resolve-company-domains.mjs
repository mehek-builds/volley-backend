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
 *   npm run logo:resolve                       # rewrite the map
 *   npm run logo:resolve -- --dry-run          # print what would change
 *
 * Runs under tsx because it shares the live-board reader with check-logo-coverage.mjs.
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
import { scanBoard } from '../src/lib/boardScan.ts';

const API = process.env.JOBS_API ?? 'https://student-outreach-backend.vercel.app';
const OUT = new URL('../src/lib/companyDomains.ts', import.meta.url).pathname;
const DRY = process.argv.includes('--dry-run');
const PAGE_SIZE = 100;
const MAX_ROWS = 100_000;
const PAGE_CONCURRENCY = 12;

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
 * They render an initial unless CURATED_DOMAINS below records a separately verified exception.
 * Adding one back means proving it, not guessing it.
 *
 * Five of them now have one, established on 2026-08-04 from the employer's own ATS board rather
 * than from the name: honor (honorcare.com), Old Mission (oldmissioncapital.com) and Pinecone
 * (pinecone.io) confirm what the notes above already suspected, and the two open questions are
 * answered. The Opal that posts here is Opal Security at opal.dev. column.com still serves no
 * <title>, but it now serves og:site_name=Column, which is the verification this note lacked.
 * They stay listed here because the name alone is still undecidable; only the curated entry saves
 * them, so removing one from CURATED_DOMAINS correctly drops them back to an initial.
 */
const TOO_GENERIC = new Set(['depot', 'fireworks', 'honor', 'oldmission', 'pinecone', 'knock', 'opal', 'column']);

/**
 * Official domains that the strict resolver cannot prove automatically because the company uses a
 * non-obvious hostname, redirects to a differently named brand, or blocks automated requests.
 * Keys use the same punctuation-insensitive normalization as the runtime lookup, so board spelling
 * changes do not create aliases or duplicate domains.
 *
 * NOTHING HERE IS RE-VERIFIED AT RUNTIME. A curated entry skips the validation queue entirely and
 * overrides TOO_GENERIC, so each one is a standing human assertion and has to be earned.
 *
 * The 2026-08-02 set was reviewed by hand. The 2026-08-04 set came from a sweep of every unmapped
 * company on the board, accepted only on the same three standards the header describes: a backlink
 * from the employer's OWN ATS board to the domain, a homepage whose <title> or og:site_name names
 * the company, or DNS plus a real favicon where the site refuses automated requests. Most needed
 * two of the three.
 *
 * That sweep is also why several entries look nothing like their company name. The guessable
 * candidate was WRONG for these, and the ATS slug is what exposed it:
 *
 *   Lucid            lucid.com is Lucid Software (Lucidchart); the employer posts as `lucidmotors`
 *   Mozilla          mozilla.com redirects to firefox.com, so the logo would have been Firefox's
 *   Shield AI        shieldai.com is unrelated, and shieldai.io is parked for sale
 *   Engineers Gate   trades as eglp.com, which no name-based candidate would ever reach
 *   Squarepoint      squarepoint-capital.com is hyphenated
 *   Epirus           epirusinc.com, because epirus.com is someone else
 *   Ginkgo           ginkgobioworks.com now redirects to ginkgo.bio
 *   Quadrature       quadraturecapital.com now redirects to quadrature.ai
 *   Skylight         skylightframe.com now redirects to myskylight.com
 *
 * Pure Storage is deliberately ABSENT. Its board still asserts purestorage.com, but that domain
 * 301s to everpuredata.com ("The Data Platform | Everpure"), so the company reads as mid-rebrand
 * and a row labelled Pure Storage would render an Everpure logo. Unproven beats confusing.
 *
 * Two more were verified and then REJECTED, because each one breaks a guard in
 * companyDomains.test.ts that is worth more than the rows it would win:
 *
 *   Ashby   ashbyhq.com is provably theirs, but the map forbids any ATS host as a value. Ashby is
 *           both an employer here and the vendor behind jobs.ashbyhq.com, and the test cannot tell
 *           a correct self-reference from the bug it exists to catch, where a board host paints one
 *           ATS logo across every row from that board. 7 rows.
 *   groww   groww.in is genuinely their domain, not a redirect, but the map forbids country TLDs
 *           because this resolver runs from Dubai, where airbnb.com answers as airbnb.ae and
 *           bitgo.com as bitgo.ae. A real .in and a geo-accident are indistinguishable there. 1 row.
 *
 * Both render an initial instead. Weakening either guard to win 8 rows is a bad trade.
 */
const CURATED_DOMAINS = new Map([
  ['abnormalai', 'abnormal.ai'],
  ['accessbank', 'accessbankplc.com'],
  ['affirm', 'affirm.com'],
  ['airtable', 'airtable.com'],
  ['akuna', 'akunacapital.com'],
  ['amwell', 'amwell.com'],
  ['andurilindustries', 'anduril.com'],
  ['anydesk', 'anydesk.com'],
  ['astronomer', 'astronomer.io'],
  ['axios', 'axios.com'],
  ['blacksmith', 'blacksmith.sh'],
  ['block', 'block.xyz'],
  ['box', 'box.com'],
  ['braintrust', 'usebraintrust.com'],
  ['carta', 'carta.com'],
  ['checkly', 'checklyhq.com'],
  ['chime', 'chime.com'],
  ['cockroachlabs', 'cockroachlabs.com'],
  ['codat', 'codat.io'],
  ['codeforamerica', 'codeforamerica.org'],
  ['coinbase', 'coinbase.com'],
  ['column', 'column.com'],
  ['commonapp', 'commonapp.org'],
  ['crunchyroll', 'crunchyroll.com'],
  ['databricks', 'databricks.com'],
  ['dataiku', 'dataiku.com'],
  ['decagon', 'decagon.ai'],
  ['doximity', 'doximity.com'],
  ['drw', 'drw.com'],
  ['elastic', 'elastic.co'],
  ['elevenlabs', 'elevenlabs.io'],
  ['engineersgate', 'eglp.com'],
  ['epicgames', 'epicgames.com'],
  ['epirus', 'epirusinc.com'],
  ['fanduel', 'fanduel.com'],
  ['fastly', 'fastly.com'],
  ['fireworks', 'fireworks.ai'],
  ['flexport', 'flexport.com'],
  ['gamma', 'gamma.app'],
  ['getyourguide', 'getyourguide.com'],
  ['ginkgo', 'ginkgo.bio'],
  ['gitlab', 'gitlab.com'],
  ['givedirectly', 'givedirectly.org'],
  ['gsacapital', 'gsacapital.com'],
  ['gusto', 'gusto.com'],
  ['hellofresh', 'hellofresh.com'],
  ['helpscout', 'helpscout.com'],
  ['honor', 'honorcare.com'],
  ['incident', 'incident.io'],
  ['instabase', 'instabase.com'],
  ['justworks', 'justworks.com'],
  ['llamaindex', 'llamaindex.ai'],
  ['lucid', 'lucidmotors.com'],
  ['matchgroup', 'mtch.com'],
  ['merge', 'merge.dev'],
  ['mozilla', 'mozilla.org'],
  ['n26', 'n26.com'],
  ['nuro', 'nuro.com'],
  ['oldmission', 'oldmissioncapital.com'],
  ['opal', 'opal.dev'],
  ['openai', 'openai.com'],
  ['oscarhealth', 'hioscar.com'],
  ['perplexity', 'perplexity.ai'],
  ['pinecone', 'pinecone.io'],
  ['poolside', 'poolside.ai'],
  ['prefect', 'prefect.io'],
  ['quadrature', 'quadrature.ai'],
  ['quberesearchtechnologies', 'qube-rt.com'],
  ['quintoandar', 'quintoandar.com.br'],
  ['ramp', 'ramp.com'],
  ['reflectionai', 'reflection.ai'],
  ['rocketlab', 'rocketlabcorp.com'],
  ['rondoenergy', 'rondo.com'],
  ['salesloft', 'salesloft.com'],
  ['seatgeek', 'seatgeek.com'],
  ['shieldai', 'shield.ai'],
  ['sierra', 'sierra.ai'],
  ['sigma', 'sigmacomputing.com'],
  ['singlestore', 'singlestore.com'],
  ['skylight', 'myskylight.com'],
  ['socket', 'socket.dev'],
  ['sofi', 'sofi.com'],
  ['spotify', 'spotify.com'],
  ['squarepointcapital', 'squarepoint-capital.com'],
  ['stockx', 'stockx.com'],
  ['taketwo', 'take2games.com'],
  ['tala', 'tala.co'],
  ['thenewyorktimes', 'nytco.com'],
  ['toast', 'toasttab.com'],
  ['togetherai', 'together.ai'],
  ['tripadvisor', 'tripadvisor.com'],
  ['udemy', 'udemy.com'],
  ['unstructured', 'unstructured.io'],
  ['validio', 'validio.io'],
  ['vannevarlabs', 'vannevarlabs.com'],
  ['vardaspaceindustries', 'varda.com'],
  ['voxmediagroup', 'voxmedia.com'],
  ['wiz', 'wiz.io'],
  ['zocdoc', 'zocdoc.com'],
  ['zscaler', 'zscaler.com'],
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
const nameKey = (name) => norm(cleanName(name));

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

/**
 * Every company on the live board.
 *
 * Reads through lib/boardScan.ts rather than paging offsets directly. The board is newest-first, so
 * an upsert mid-scan prepends and shifts every later offset: the old loop here re-read rows it
 * already had and stopped short of the end, silently dropping whichever companies got displaced
 * past the last offset. It never failed, it just quietly returned a short list, which is the worst
 * shape for THIS script — a company missing from the scan is a company missing from the map, and
 * the map is the thing being regenerated to close that exact gap. check-logo-coverage.mjs hit the
 * same race loudly (it asserted an exact row count) and that is what boardScan.ts was written for.
 */
async function boardCompanies() {
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

  const { rows } = await scanBoard({
    readPage,
    idOf: (row) => row.id,
    pageSize: PAGE_SIZE,
    pageConcurrency: PAGE_CONCURRENCY,
    onRetry: (reason) => console.error(`Retrying the board scan: ${reason}.`),
  });

  const names = new Set(rows.map((row) => row.company_name).filter(Boolean));
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

  const knownByNameKey = new Map();
  for (const m of existing.matchAll(/^\s{2}"([^"]+)":\s*"([^"]+)",/gm)) {
    const key = nameKey(m[1]);
    if (!knownByNameKey.has(key)) knownByNameKey.set(key, [m[1], m[2]]);
  }

  const resolvedByNameKey = new Map();
  for (const name of names) {
    const key = nameKey(name);
    const curatedDomain = CURATED_DOMAINS.get(key);
    if (curatedDomain) resolvedByNameKey.set(key, [name, curatedDomain]);
  }

  let revalidated = 0, invalidated = 0, validationIndex = 0;
  const existingQueue = names.filter((name) => {
    const key = nameKey(name);
    return !CURATED_DOMAINS.has(key) && knownByNameKey.has(key);
  });
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (validationIndex < existingQueue.length) {
      const name = existingQueue[validationIndex++];
      const key = nameKey(name);
      const domain = knownByNameKey.get(key)?.[1];
      const page = domain ? await fetchHome(domain) : null;
      const hit = domain ? accepts(name, domain, page) : null;
      if (hit) {
        resolvedByNameKey.set(key, [name, hit.domain]);
        revalidated++;
      } else {
        invalidated++;
        console.error(`  ! ${name} -> ${domain ?? 'missing'} (existing mapping no longer proved)`);
      }
    }
  }));

  let added = 0, failed = 0, i = 0;
  const queue = names.filter((n) => !resolvedByNameKey.has(nameKey(n)));
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < queue.length) {
      const name = queue[i++];
      const hit = await resolveCompany(name).catch(() => null);
      if (hit) {
        const key = nameKey(name);
        if (!resolvedByNameKey.has(key)) {
          resolvedByNameKey.set(key, [name, hit.domain]);
          added++;
          console.error(`  + ${name} -> ${hit.domain}`);
        }
      }
      else { failed++; console.error(`  ? ${name} (unproven, will show an initial)`); }
    }
  }));

  const entries = [...resolvedByNameKey.values()].sort((a, b) => a[0].localeCompare(b[0]));
  console.error(`\nrevalidated ${revalidated}, invalidated ${invalidated}, resolved ${added}, ${failed} left unproven, ${entries.length} total`);
  if (DRY) return;
  writeFileSync(OUT, `${head}\nconst COMPANY_DOMAINS: Record<string, string> = {\n${entries.map(([n, d]) => `  ${JSON.stringify(n)}: ${JSON.stringify(d)},`).join('\n')}\n${tail}`);
  console.error(`wrote ${OUT}`);
})();
