#!/usr/bin/env node
/**
 * BUILD THE SPONSORING-EMPLOYER DATABASE FROM REAL H-1B FILINGS.
 *
 * Source: the USCIS H-1B Employer Data Hub, which publishes one CSV per fiscal year listing every
 * employer that filed an H-1B petition, with approvals and denials. It is the government's own
 * record of who has actually sponsored somebody, which is the only employer-level evidence Litos
 * accepts (see src/lib/sponsorship.ts for why, and for the posting-level evidence that outranks it).
 *
 *   node scripts/build-h1b-sponsors.mjs              # download the fiscal years and rebuild
 *   node scripts/build-h1b-sponsors.mjs --cache-dir DIR   # reuse CSVs already downloaded there
 *   node scripts/build-h1b-sponsors.mjs --check      # rebuild in memory, fail if the file is stale
 *
 * WHAT IT WRITES: src/data/h1bSponsors.json - one entry FOR EVERY COMPANY ON THE LITOS BOARD,
 * including the ones with no filings, which carry `sponsors: false` and are listed anyway.
 *
 * That last part is the design decision worth defending. It would be smaller to write only the
 * matches, but then a company missing from the file would be ambiguous: never checked, or checked
 * and found nothing? Those need opposite responses. Listing the whole board makes the file a
 * complete answer to "what do we know about each employer we surface", makes every addition and
 * removal visible in a pull request, and lets a test assert board ⊆ file so that adding a job source
 * without re-running this script fails loudly instead of quietly surfacing an unchecked employer.
 *
 * NOT USED: the DOL LCA disclosure data (dol.gov, one 140MB xlsx per quarter). It is more current -
 * an LCA is filed before the petition - and it is the obvious second source when this needs one.
 * It was left out because the marginal employer it would add is one that filed an LCA and has not
 * yet had a petition approved, which is exactly the case where "confirmed" would be overclaiming.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
/* A .ts module rather than a .json file, and the reason is the deploy rather than taste: `tsc -p
   tsconfig.build.json` emits JavaScript into dist/ and does not copy data files, so a JSON import
   type-checks locally and then throws MODULE_NOT_FOUND on Vercel at runtime. Generated TypeScript
   compiles like everything else and cannot go missing. */
const OUT_FILE = join(HERE, '..', 'src', 'data', 'h1bSponsors.ts');

/* THREE FISCAL YEARS, and the number is a judgement about staleness rather than a technical limit.
 * One year is too brittle: a company that sponsored twelve people in 2022 and none in 2023 still
 * sponsors, and a single-year window would drop them. Ten years is too generous in the other
 * direction: a 2014 petition says nothing about a company's policy today. Three is long enough to
 * absorb a quiet year and short enough that every row describes the current regime. */
const FISCAL_YEARS = [2021, 2022, 2023];
const SOURCE_URL = (year) =>
  `https://www.uscis.gov/sites/default/files/document/data/h1b_datahubexport-${year}.csv`;

/* Legal names that no mechanical rule reconciles with the brand on the job board, resolved by hand.
 * Every entry is a human decision and belongs in a diff, which is the entire reason this list is
 * here rather than inside normalizeEmployerName as another clever regex.
 *
 * The rule for adding one: the filer must be unmistakably the same company as the brand we surface,
 * which in practice means the legal name CONTAINS the brand ("CHIME FINANCIAL INC", "BETTERMENT
 * HOLDINGS INC") or the filing itself names it ("MAPLEBEAR INC D/B/A INSTACART"). A same-named
 * unrelated business never qualifies, and this is not a theoretical worry: the data holds "GEMINI
 * CONSULTING & SERVICES LLC" and "LINEAR LABS INC", neither of which is the company on our board.
 * When in doubt the company simply stays unconfirmed, which costs a job seeker some postings rather
 * than sending them at one that will not sponsor them.
 *
 * Every name below was read out of the USCIS CSVs on 2026-07-28, not guessed. An alias that matches
 * nothing is harmless and is kept when the identity is known to be right (Cursor files as Anysphere
 * but has no approved petition in the window yet), because it is the record of a search already
 * done. */
const ALIASES = {
  'Scale AI': ['SCALE AI INC'],
  'Match Group': ['MATCH GROUP LLC'],
  'Khan Academy': ['KHAN ACADEMY INC'],
  'Qube Research & Technologies': ['QUBE RESEARCH AND TECHNOLOGIES INC', 'QRT US LLC'],
  'IMC Trading': ['IMC AMERICAS INC', 'IMC MANAGER LLC', 'IMC CHICAGO LLC', 'IMC FINANCIAL MARKETS'],
  Point72: ['POINT72 ASSET MANAGEMENT LP', 'POINT72 ASSET MANAGEMENT L P'],
  Gemini: ['GEMINI TRUST COMPANY LLC'],
  Cursor: ['ANYSPHERE INC'],
  Replit: ['REPLIT INC'],
  SoFi: ['SOCIAL FINANCE INC', 'SOFI LENDING CORP'],
  Twitch: ['TWITCH INTERACTIVE INC'],
  Palantir: ['PALANTIR TECHNOLOGIES INC'],
  Robinhood: ['ROBINHOOD MARKETS INC'],
  Instacart: ['MAPLEBEAR INC D/B/A INSTACART', 'MAPLEBEAR INC DBA INSTACART'],
  Notion: ['NOTION LABS INC'],
  Chime: ['CHIME FINANCIAL INC'],
  Faire: ['FAIRE WHOLESALE INC'],
  /* Carta files under its pre-rename entity, and spells the d/b/a three different ways across the
     three years. All three are listed rather than normalised into one, so the file records what was
     actually in the data. */
  Carta: ['ESHARES INC D/B/A CARTA', 'ESHARES INC DBA CARTA', 'ESHARES INC DBA CARTA INC'],
  /* NOT "RAMPS INTERNATIONAL INC", which is a different company that files ten times as many
     petitions - the exact false match this list exists to prevent. */
  Ramp: ['RAMP BUSINESS CORPORATION'],
  Render: ['RENDER SERVICES INC'],
  Baseten: ['BASETEN LABS INC'],
  /* Deliberately NOT aliased to "LINEAR LABS INC", which is a motor manufacturer, not the issue
     tracker on our board. Linear has no petition in this window and stays unconfirmed. */
  Betterment: ['BETTERMENT HOLDINGS INC'],
};

function parseArgs(argv) {
  const args = { check: false, cacheDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--cache-dir') args.cacheDir = argv[++i];
  }
  return args;
}

/* A CSV reader, not A CSV LIBRARY. The USCIS export is machine-generated, comma-separated, quotes
   only where a field contains a comma, and doubles its quotes inside a quoted field. Employer names
   like "0965688 BC LTD, DBA PROCOGIA" are precisely why splitting on commas does not work. */
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { out.push(field); field = ''; }
    else field += ch;
  }
  out.push(field);
  return out;
}

// Kept in step with src/lib/sponsorship.ts#normalizeEmployerName by a test, because this script is
// plain .mjs and cannot import the TypeScript module.
function normalizeEmployerName(name) {
  const stripped = name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped
    .replace(/ (INC|INCORPORATED|LLC|L L C|LTD|LIMITED|CORP|CORPORATION|CO|LP|LLP|PLC|GMBH|PBC)$/, '')
    .trim();
}

async function loadYear(year, cacheDir) {
  const cached = cacheDir ? join(cacheDir, `h1b_datahubexport-${year}.csv`) : null;
  if (cached && existsSync(cached)) return readFileSync(cached, 'utf8');
  const response = await fetch(SOURCE_URL(year), { signal: AbortSignal.timeout(180_000) });
  if (!response.ok) throw new Error(`USCIS ${year} returned HTTP ${response.status}`);
  const text = await response.text();
  if (cached) {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cached, text);
  }
  return text;
}

/** normalized employer name -> { legal names seen, approvals and denials per fiscal year }. */
async function readFilings(cacheDir) {
  const index = new Map();
  for (const year of FISCAL_YEARS) {
    const csv = await loadYear(year, cacheDir);
    const lines = csv.split(/\r?\n/);
    const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
    const col = (name) => header.indexOf(name);
    const iEmployer = col('employer');
    const iInitialApproval = col('initial approval');
    const iContinuingApproval = col('continuing approval');
    const iInitialDenial = col('initial denial');
    const iContinuingDenial = col('continuing denial');
    if (iEmployer < 0 || iInitialApproval < 0) {
      throw new Error(`USCIS ${year} CSV header changed: ${header.join('|')}`);
    }
    for (let i = 1; i < lines.length; i += 1) {
      if (!lines[i]) continue;
      const row = parseCsvLine(lines[i]);
      const employer = (row[iEmployer] ?? '').trim();
      if (!employer) continue;
      const approvals =
        Number(row[iInitialApproval] || 0) + Number(row[iContinuingApproval] || 0);
      const denials = Number(row[iInitialDenial] || 0) + Number(row[iContinuingDenial] || 0);
      const key = normalizeEmployerName(employer);
      if (!key) continue;
      const entry = index.get(key) ?? { legal_names: new Set(), years: new Map() };
      entry.legal_names.add(employer.replace(/\s+/g, ' ').trim());
      const yearEntry = entry.years.get(year) ?? { approvals: 0, denials: 0 };
      yearEntry.approvals += approvals;
      yearEntry.denials += denials;
      entry.years.set(year, yearEntry);
      index.set(key, entry);
    }
  }
  return index;
}

/* The board, read from the one list that defines it. Parsed out of the TypeScript rather than
   imported, because this script runs on plain node with no build step - and a second hand-written
   copy of the company list is exactly the kind of drift the file it reads was created to end. */
function boardCompanies() {
  const source = readFileSync(join(HERE, '..', 'src', 'lib', 'jobSources.ts'), 'utf8');
  const entries = source.match(/\[\s*'([^']+)'\s*,\s*'(greenhouse|lever|ashby|workable)'\s*,\s*'([^']+)'\s*\]/g) ?? [];
  return entries.map((raw) => {
    const [, company] = raw.match(/\[\s*'([^']+)'/);
    return company;
  });
}

function build(filings, companies) {
  const employers = [];
  for (const company of companies) {
    const keys = [normalizeEmployerName(company), ...(ALIASES[company] ?? []).map(normalizeEmployerName)];
    let matched = null;
    let matchedKey = null;
    for (const key of keys) {
      const hit = filings.get(key);
      if (hit) {
        /* Aliases can name several filing entities for one employer (IMC files as two). Merge them
           rather than taking the first, or the approval count understates a company that split its
           petitions across entities. */
        if (!matched) { matched = { legal_names: new Set(), years: new Map() }; matchedKey = key; }
        for (const name of hit.legal_names) matched.legal_names.add(name);
        for (const [year, value] of hit.years) {
          const current = matched.years.get(year) ?? { approvals: 0, denials: 0 };
          matched.years.set(year, {
            approvals: current.approvals + value.approvals,
            denials: current.denials + value.denials,
          });
        }
      }
    }
    const years = matched ? [...matched.years.entries()].sort((a, b) => a[0] - b[0]) : [];
    const approvals = years.reduce((sum, [, v]) => sum + v.approvals, 0);
    employers.push({
      company,
      normalized: normalizeEmployerName(company),
      /* The bar is one approved petition across the window. Not a threshold on volume: a company
         that sponsored one person has a sponsorship process, and picking a number above one would
         be us inventing a policy the data does not contain. Denials are recorded but never
         disqualify - a denied petition is still a company that filed one. */
      sponsors: approvals > 0,
      matched_key: matched ? matchedKey : null,
      legal_names: matched ? [...matched.legal_names].sort() : [],
      approvals,
      denials: years.reduce((sum, [, v]) => sum + v.denials, 0),
      fiscal_years: years.filter(([, v]) => v.approvals > 0).map(([year]) => year),
    });
  }
  employers.sort((a, b) => a.company.localeCompare(b.company));
  return {
    source: 'USCIS H-1B Employer Data Hub',
    source_urls: FISCAL_YEARS.map(SOURCE_URL),
    fiscal_years: FISCAL_YEARS,
    employers,
  };
}

const args = parseArgs(process.argv.slice(2));
const filings = await readFilings(args.cacheDir);
const built = build(filings, boardCompanies());
const json = `/* GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Written by scripts/build-h1b-sponsors.mjs from the USCIS H-1B Employer Data Hub. Every employer
 * Litos watches is listed, including the ones with no filings: an absent company would be
 * ambiguous between "never checked" and "checked, nothing found", and those need opposite
 * responses. \`npm run sponsors:check\` fails when this file no longer matches the source data or
 * the board.
 */
import type { H1bSponsorFile } from '../lib/sponsorEmployers';

export const H1B_SPONSOR_FILE: H1bSponsorFile = ${JSON.stringify(built, null, 2)};
`;

if (args.check) {
  const existing = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, 'utf8') : '';
  const same = createHash('sha256').update(existing).digest('hex') === createHash('sha256').update(json).digest('hex');
  if (!same) {
    console.error('src/data/h1bSponsors.ts is stale. Re-run: node scripts/build-h1b-sponsors.mjs');
    process.exit(1);
  }
  console.log(`Up to date: ${built.employers.filter((e) => e.sponsors).length}/${built.employers.length} board employers confirmed.`);
} else {
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, json);
  const confirmed = built.employers.filter((e) => e.sponsors);
  console.log(`Wrote ${OUT_FILE}`);
  console.log(`${confirmed.length}/${built.employers.length} board employers have H-1B approvals in FY${FISCAL_YEARS[0]}-${FISCAL_YEARS.at(-1)}.`);
  const missing = built.employers.filter((e) => !e.sponsors).map((e) => e.company);
  if (missing.length) console.log(`No filings found for: ${missing.join(', ')}`);
}
