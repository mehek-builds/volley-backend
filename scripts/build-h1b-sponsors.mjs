#!/usr/bin/env node
/**
 * BUILD THE SPONSORING-EMPLOYER DATABASE FROM REAL H-1B FILINGS.
 *
 * TWO GOVERNMENT SOURCES, counted separately because they say different things.
 *
 *   1. USCIS H-1B Employer Data Hub (one CSV per fiscal year, FY2021-2023): employers whose H-1B
 *      petitions were APPROVED. The strongest employer-level evidence there is - somebody actually
 *      got a visa - and the most stale, because USCIS has published nothing past FY2023.
 *
 *   2. DOL LCA disclosure data (one .xlsx per quarter, FY2025): CERTIFIED labor condition
 *      applications. Before filing a petition an employer must name the role, the worksite and the
 *      wage and attest to paying it; DOL certifying that is the attestation on the record. Weaker
 *      than an approval, and two years more current, which is what makes it worth having: the whole
 *      class of companies founded since 2022 sponsors people and appears nowhere in the USCIS file.
 *      Added 2026-07-29 after 67 of 121 unconfirmed employers turned out to have nothing in USCIS
 *      and real filings here.
 *
 * Both count as confirmed. Which one confirmed each employer is recorded, because "an approved
 * petition" and "a certified application" are not the same claim and the product has to be able to
 * say which it has.
 *
 *   node scripts/build-h1b-sponsors.mjs              # download both sources and rebuild
 *   node scripts/build-h1b-sponsors.mjs --cache-dir DIR   # reuse files already downloaded there
 *   node scripts/build-h1b-sponsors.mjs --uscis-only  # skip the DOL half (no python3/openpyxl)
 *   node scripts/build-h1b-sponsors.mjs --check      # rebuild in memory, fail if the file is stale
 *
 * The DOL half needs python3 with openpyxl (scripts/lca-employers.py streams the spreadsheets, which
 * node cannot do without a new dependency). Without it, pass --uscis-only and accept the smaller
 * answer rather than silently shipping one.
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
 * MATCHING is exact on the normalised name, plus two rules that are safe enough to automate:
 * a d/b/a phrase ("FORMAGRID INC D/B/A AIRTABLE" is Airtable, and says so), and the alias list
 * below, where every entry is a human decision visible in a diff. Nothing fuzzier, because a false
 * match tells a job seeker their visa status is covered by a company that has never filed.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/* The most recent complete fiscal year DOL has published. Four quarters rather than one: a company
   that sponsors a handful of people a year files a handful of LCAs a year, and a single quarter
   misses most of them. FY2026 files do not exist yet. */
const LCA_QUARTERS = ['FY2025_Q1', 'FY2025_Q2', 'FY2025_Q3', 'FY2025_Q4'];
const LCA_URL = (quarter) =>
  `https://www.dol.gov/sites/dolgov/files/ETA/oflc/pdfs/LCA_Disclosure_Data_${quarter}.xlsx`;

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
/* BOARD COMPANIES THAT MUST NEVER BE CONFIRMED, whatever the name matching says.
 *
 * Every one of these was CONFIRMED by an earlier version of this file and is wrong. They are here
 * rather than merely un-aliased because for several of them the plain-name match fires on its own:
 * "CRISP INC" normalises to exactly the same key as the board token `crisp`, so deleting an alias
 * would change nothing.
 *
 * They were caught by scripts/verify-sponsor-matches.mjs, which asks each employer's own job board
 * who they are. The lesson is in the shape of the errors: a board TOKEN is not a company. Somebody
 * added 200 job sources by guessing tokens, and `sas`, `bcg`, `tcs`, `disney` and `latch` all
 * resolve to a different company than the display name claims.
 *
 * The reason string is printed nowhere. It exists so the next person does not spend an afternoon
 * re-deriving why an obvious match is missing, and then "fix" it. */
const REJECTED = {
  /* The four tokens that were a DIFFERENT COMPANY are no longer sources at all - they were removed
     from jobSources.ts on 2026-07-29, and src/lib/jobSourceIdentity.test.ts fails if they return.
     What remains here is the other shape of the problem: a source that IS the company we say it is,
     whose name collides with a different company's filings. */
  crisp: 'the ashby token `crisp` is the Dutch grocer, which really is called Crisp - the board is '
    + 'correctly labelled. A US "Crisp, Inc." files H-1B petitions and normalises to the same key, '
    + 'so this is a rejection of the FILING match, not of the source',
  LatchBio: 'LatchBio is correctly labelled (the source was renamed from "Latch" on 2026-07-29). '
    + 'LATCH SYSTEMS INC is the New York smart-lock company, a different business, and its '
    + 'petitions must not be credited here',
};

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
  /* Added 2026-07-28 when the board grew from 51 to 239 sources and the coverage test fired. Each
     one was read out of the FY2023 CSV, and the quant block matters most: those are the postings
     the finance-track job seeker comes for, and without these aliases every one of them vanished
     from the board of the people who need sponsorship most. */
  'Jane Street': ['JANE STREET GROUP LLC'],
  'Tower Research': ['TOWER RESEARCH CAPITAL LLC'],
  'Old Mission': ['OLD MISSION CAPITAL LLC'],
  'Marshall Wace': ['MARSHALL WACE NORTH AMERICA LP'],
  'Flow Traders': ['FLOW TRADERS US LLC'],
  AQR: ['AQR CAPITAL MANAGEMENT LLC'],
  /* VIRTU FINANCIAL, not "VIRTUAL FRAMEWORKS INC D/B/A VIRTUALHEALTH", which the loose match would
     otherwise have reached. */
  Virtu: ['VIRTU FINANCIAL OPERATING LLC'],
  SpaceX: ['SPACE EXPLORATION TECHNOLOGIES CORP'],
  Spotify: ['SPOTIFY USA INC'],
  Peloton: ['PELOTON INTERACTIVE INC'],
  Elastic: ['ELASTICSEARCH INC'],
  Cerebras: ['CEREBRAS SYSTEMS INC'],
  Mercury: ['MERCURY TECHNOLOGIES INC'],
  zoominfo: ['ZOOMINFO TECHNOLOGIES LLC'],
  'Take-Two': ['TAKE TWO INTERACTIVE SOFTWARE INC'],
  /* Added 2026-07-29, after Mehek pointed out that unconfirmed employers were far more likely to
     be name mismatches than genuine non-sponsors. She was right: 54 of the 121 had filings under a
     legal name or a d/b/a nothing mechanical would reach. Every one below was read out of the raw
     USCIS or DOL data, and each was checked against the BOARD TOKEN, not the display name - that
     is what caught the Lucid mistake in the line this comment replaced. */
  /* `lucidmotors` is the board token. Lucid IS the carmaker, and the previous version of this file
     rejected LUCID USA INC on the assumption it was the diagramming tool. 736 approvals and 141
     certified LCAs, wrongly discarded. */
  Lucid: ['LUCID USA INC', 'LUCID GROUP USA INC'],
  Airtable: ['FORMAGRID INC D/B/A AIRTABLE', 'FORMAGRID INC DBA AIRTABLE'],
  Abridge: ['ABRIDGE AI INC'],
  Akuna: ['AKUNA CAPITAL LLC'],
  Alloy: ['FIRST MILE GROUP INC DBA ALLOY'],
  aptoslabs: ['MATONEE INC D/B/A APTOS LABS'],
  bishopfox: ['STACH AND LIU LLC DBA BISHOP FOX'],
  Blend: ['BLEND LABS INC'],
  btgpactual: ['BTG PACTUAL US CAPITAL LLC'],
  cleo: ['CLEO AI INC'],
  cockroachlabs: ['COCKROACH LABS INC'],
  cresta: ['CRESTA INTELLIGENCE INC'],
  elationhealth: ['ELATION HEALTH INC'],
  freenome: ['FREENOME HOLDINGS INC'],
  Ginkgo: ['GINKGO BIOWORKS INC'],
  honor: ['HONOR TECHNOLOGY INC', 'HONOR TECH INC'],
  imply: ['IMPLY DATA INC'],
  komodohealth: ['KOMODO HEALTH INC'],
  /* The HR platform files as Degree Inc. NOT "LATTICE SEMICONDUCTOR CORPORATION", which is a chip
     company and outweighs it three to one in the data. */
  lattice: ['DEGREE INC D/B/A LATTICE'],
  Merge: ['MERGE API INC'],
  modernhealth: ['MODERN LIFE INC DBA MODERN HEALTH'],
  omadahealth: ['OMADA HEALTH INC'],
  onemedical: ['ONE MEDICAL GROUP INC'],
  phonepe: ['PHONEPE PRIVATE LTD'],
  Pinecone: ['PINECONE SYSTEMS INC'],
  ripple: ['RIPPLE LABS INC'],
  rutter: ['LANGAPI COMPANY D/B/A RUTTER', 'LANGAPI COMPANY D B A RUTTER'],
  science37: ['SCIENCE 37 INC'],
  starburst: ['STARBURST DATA INC'],
  suki: ['SUKI AI INC'],
  tebra: ['TEBRA TECHNOLOGIES INC'],
  tenstorrent: ['TENSTORRENT USA INC'],
  /* Only in the DOL data: these companies are too young to appear in USCIS FY2021-2023, which is
     the entire reason the second source was added. */
  decagon: ['DECAGON AI INC'],
  LangChain: ['LANGCHAIN INC'],
  ElevenLabs: ['ELEVEN LABS INC'],
  Perplexity: ['PERPLEXITY AI INC'],
  'Physical Intelligence': ['PHYSICAL INTELLIGENCE PI INC'],
  Poolside: ['POOLSIDE INC'],
  'Reflection AI': ['REFLECTION AI INC'],
  Quadrature: ['QUADRATURE US INC'],
  Suno: ['SUNO INC'],
  semgrep: ['SEMGREP INC'],
  doppel: ['DOPPEL INC'],
  /* Both entities: Harvey filed as Counsel AI Corporation before the rename and still does under
     it. Taking only the new name would have counted one certification instead of five. */
  Harvey: ['HARVEY AI CORPORATION', 'COUNSEL AI CORPORATION'],
  Braintrust: ['BRAINTRUST DATA INC'],
  Fireworks: ['FIREWORKS AI INC'],
  /* Found on a second pass through the full legal names, after the first sweep left them out:
     each files under a name that shares no token with the brand we display. */
  'Jump Trading': ['JUMP OPERATIONS LLC'],
  'Man Group': ['MAN INVESTMENTS USA HOLDINGS INC'],
  /* CircleCI is CIRCLE INTERNET SERVICES. NOT "CIRCLE INTERNET FINANCIAL", which is Circle the
     stablecoin company and files under a near-identical name - the closest call in this whole
     list, and the reason the automated matcher is not allowed to guess at prefixes. */
  circleci: ['CIRCLE INTERNET SERVICES INC'],

  /* DELIBERATELY NOT ALIASED. Each was looked up in both sources and REJECTED, and the note is here
     so nobody spends the afternoon re-deriving it:
       Linear      LINEAR LABS INC makes motors; MAXLINEAR is a chip company.
       Coder       CODER LOGICS INC is a Texas staffing firm, not coder.com.
       Column      COLUMN TECHNOLOGIES INC is an Illinois consultancy, not the bank.
       Depot       every match is Home Depot or Office Depot.
       Remote      REMOTE TIGER INC is a Maryland staffing firm, not remote.com.
       Unit        AMERICAN UNIT INC is unrelated; the rest are school districts.
       Railway     freight railroads.
       stone       our board's Stone is the Brazilian fintech; the matches are masonry and asset
                   management.
       found, incident, socket, opal, orca, gamma, Blacksmith, Namespace, GitLab, Monzo, Trustly,
                   groww, quintoandar, Rocket Lab and the rest of the still-unconfirmed list:
                   nothing in either source under any name we could tie to them.
     (Man Group and Jump Trading were in this list and are NOT rejections - both were found on the
     second pass and are aliased above. A rejection note that contradicts the code is worse than
     none, because it is the artefact the next person trusts instead of re-deriving.) */
  Betterment: ['BETTERMENT HOLDINGS INC'],
};

function parseArgs(argv) {
  const args = { check: false, cacheDir: null, uscisOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--check') args.check = true;
    else if (argv[i] === '--uscis-only') args.uscisOnly = true;
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

/* A d/b/a in the legal name IS the company naming itself.
 *
 * "FORMAGRID INC D/B/A AIRTABLE" is Airtable saying so on a federal form, and no normalisation
 * rule reaches it from the word "Airtable". This is the one fuzzy match safe enough to automate,
 * because the employer wrote the brand into the filing themselves. Everything looser stays in the
 * hand-written alias list.
 *
 * Anchored at the END of the name, so "MERCY CLINICS INC D/B/A MERCYONE MEDICAL GROUP CENTRAL
 * IOWA" does not match "One Medical": the trading name has to BE the brand, not merely contain it.
 */
function dbaMatches(normalizedLegalName, token) {
  /* D/B/A ONLY. F/K/A was in this pattern and is the opposite claim: a d/b/a is what the filer
     trades as NOW, an f/k/a is a name it has abandoned, usually after being acquired. Reading
     "NEWCO LLC F/K/A <BRAND>" as <BRAND> confirms a board from an entity that is no longer that
     business. The real data holds "AMOUNT SMALL BUSINESS LLC F/K/A LINEAR FINANCIAL TECHNOLOGIES
     LLC", which is exactly that trap. */
  const match = normalizedLegalName.match(/ (?:D B A|DBA) (.+)$/);
  return match ? match[1].trim() === token : false;
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

/**
 * Certified H-1B LCAs per employer, via python (see scripts/lca-employers.py for why).
 *
 * Returns an empty map under --uscis-only. It never returns an empty map SILENTLY on failure:
 * a missing second source shrinks the sponsor board, and shrinking it without saying so is the
 * failure this whole feature exists to avoid.
 */
async function readLcaFilings(cacheDir, uscisOnly) {
  if (uscisOnly) return new Map();
  const files = [];
  /* Hoisted out of the loop. Inside it, every quarter got its own fresh temp directory, so
     existsSync() could never be true and ~400MB was re-downloaded on every run and left behind. */
  const dir = cacheDir ?? mkdtempSync(join(tmpdir(), 'lca-'));
  for (const quarter of LCA_QUARTERS) {
    const path = join(dir, `LCA_Disclosure_Data_${quarter}.xlsx`);
    if (!existsSync(path)) {
      process.stderr.write(`Downloading ${quarter} (~100MB)...\n`);
      const response = await fetch(LCA_URL(quarter), { signal: AbortSignal.timeout(900_000) });
      if (!response.ok) throw new Error(`DOL ${quarter} returned HTTP ${response.status}`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    }
    files.push(path);
  }
  const result = spawnSync('python3', [join(HERE, 'lca-employers.py'), ...files], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) {
    throw new Error(
      'Reading the DOL LCA files failed. Install python3 + openpyxl (pip3 install openpyxl), '
      + 'or re-run with --uscis-only and accept the smaller answer.',
    );
  }
  const index = new Map();
  for (const [name, data] of Object.entries(JSON.parse(result.stdout))) {
    const key = normalizeEmployerName(name);
    if (!key) continue;
    const entry = index.get(key)
      ?? { legal_names: new Set(), certified: 0, states: new Set(), cities: new Set() };
    entry.legal_names.add(name.replace(/\s+/g, ' ').trim());
    entry.certified += data.certified;
    for (const city of data.cities ?? []) entry.cities.add(city);
    for (const state of data.states ?? []) entry.states.add(state);
    index.set(key, entry);
  }
  return index;
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
    const iState = col('state');
    const iCity = col('city');
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
      const entry = index.get(key) ?? { legal_names: new Set(), years: new Map(), states: new Set(), cities: new Set() };
      entry.legal_names.add(employer.replace(/\s+/g, ' ').trim());
      /* WHERE the petition was filed from. The only fact in this data that can tell two companies
         with the same name apart: a US filer in Delaware is not the Amsterdam grocer whose board
         we poll under the same word. */
      const state = (row[iState] ?? '').trim();
      const city = (row[iCity] ?? '').trim();
      if (state) entry.states.add(state);
      if (city) entry.cities.add(city);
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

/** Every filing entity that belongs to one board company, from one source. */
function collect(index, keys, token) {
  const hits = [];
  for (const key of keys) {
    const hit = index.get(key);
    if (hit) hits.push([key, hit]);
  }
  /* The d/b/a sweep, over the whole index because that is where "FORMAGRID INC D/B/A AIRTABLE"
     lives - under F, not under A.
     It runs ALWAYS, not only when nothing matched by name. Gating it on hits.length === 0 hid the
     second filing entity of every company that files under both its brand and a d/b/a, which
     undercounts a real sponsor. Deduped by key so an alias and the sweep cannot count one entity
     twice. */
  const seen = new Set(hits.map(([key]) => key));
  for (const [key, hit] of index) {
    if (!seen.has(key) && dbaMatches(key, token)) hits.push([key, hit]);
  }
  return hits;
}

function build(uscis, lca, companies) {
  const employers = [];
  for (const company of companies) {
    const token = normalizeEmployerName(company);
    /* The denylist is checked FIRST and short-circuits everything. It has to sit ahead of the
       plain-name match, not just the alias list, because several of these collide on the token
       itself. */
    if (REJECTED[company]) {
      employers.push({
        company,
        normalized: token,
        sponsors: false,
        evidence: null,
        rejected: REJECTED[company],
        matched_key: null,
        legal_names: [],
        approvals: 0,
        denials: 0,
        fiscal_years: [],
        lca_certifications: 0,
        filing_states: [],
        filing_cities: [],
      });
      continue;
    }
    const keys = [token, ...(ALIASES[company] ?? []).map(normalizeEmployerName)];

    /* Aliases can name several filing entities for one employer (IMC files as two). Merged rather
       than first-wins, or the count understates a company that split its petitions. */
    const legal_names = new Set();
    const years = new Map();
    const states = new Set();
    const cities = new Set();
    let matchedKey = null;
    for (const [key, hit] of collect(uscis, keys, token)) {
      matchedKey = matchedKey ?? key;
      for (const name of hit.legal_names) legal_names.add(name);
      for (const state of hit.states ?? []) states.add(state);
      for (const city of hit.cities ?? []) cities.add(city);
      for (const [year, value] of hit.years) {
        const current = years.get(year) ?? { approvals: 0, denials: 0 };
        years.set(year, {
          approvals: current.approvals + value.approvals,
          denials: current.denials + value.denials,
        });
      }
    }
    let certified = 0;
    for (const [key, hit] of collect(lca, keys, token)) {
      matchedKey = matchedKey ?? key;
      for (const name of hit.legal_names) legal_names.add(name);
      for (const state of hit.states ?? []) states.add(state);
      for (const city of hit.cities ?? []) cities.add(city);
      certified += hit.certified;
    }

    const ordered = [...years.entries()].sort((a, b) => a[0] - b[0]);
    const approvals = ordered.reduce((sum, [, v]) => sum + v.approvals, 0);
    /* THE BAR IS ONE FILING, from either source, and it is deliberately not a volume threshold.
       A company that sponsored one person has a sponsorship process; picking a number above one
       would be us inventing a policy the data does not contain. Denials never disqualify - a denied
       petition is still a company that files them. */
    const evidence = approvals > 0 && certified > 0 ? 'both'
      : approvals > 0 ? 'uscis_h1b'
        : certified > 0 ? 'dol_lca'
          : null;
    employers.push({
      company,
      normalized: token,
      sponsors: evidence !== null,
      evidence,
      /* Kept whenever ANY filing entity matched, not only when one confirmed. An employer matched
         to an entity with denials and no approvals is exactly the row where you want the name. */
      matched_key: matchedKey,
      legal_names: [...legal_names].sort(),
      approvals,
      denials: ordered.reduce((sum, [, v]) => sum + v.denials, 0),
      fiscal_years: ordered.filter(([, v]) => v.approvals > 0).map(([year]) => year),
      /* Certified H-1B labor condition applications across LCA_QUARTERS. An attestation, not an
         approval, which is why it is counted in its own column and named in its own evidence tier. */
      lca_certifications: certified,
      /* Corroboration, not evidence of sponsorship: where the filer said it was. Used by
         scripts/verify-sponsor-matches.mjs to tell a same-named company apart from ours. */
      filing_states: [...states].sort(),
      filing_cities: [...cities].sort().slice(0, 8),
    });
  }
  employers.sort((a, b) => a.company.localeCompare(b.company));
  return {
    source: 'USCIS H-1B Employer Data Hub',
    source_urls: FISCAL_YEARS.map(SOURCE_URL),
    fiscal_years: FISCAL_YEARS,
    lca_source: 'DOL H-1B Labor Condition Applications',
    lca_source_urls: LCA_QUARTERS.map(LCA_URL),
    lca_quarters: LCA_QUARTERS,
    employers,
  };
}

const args = parseArgs(process.argv.slice(2));
const filings = await readFilings(args.cacheDir);
const lcaFilings = await readLcaFilings(args.cacheDir, args.uscisOnly);
const built = build(filings, lcaFilings, boardCompanies());
const json = `/* GENERATED FILE - DO NOT EDIT BY HAND.
 *
 * Written by scripts/build-h1b-sponsors.mjs from two government sources: approved H-1B petitions
 * (USCIS Employer Data Hub) and certified H-1B labor condition applications (DOL). Every employer
 * Litos watches is listed, including the ones with no filings: an absent company would be
 * ambiguous between "never checked" and "checked, nothing found", and those need opposite
 * responses. \`npm run sponsors:check\` fails when this file no longer matches the source data or
 * the board.
 */
import type { H1bSponsorFile } from '../lib/sponsorEmployers';

export const H1B_SPONSOR_FILE: H1bSponsorFile = ${JSON.stringify(built, null, 2)};
`;

if (args.check && args.uscisOnly) {
  /* The hash covers the whole file, so a USCIS-only rebuild would differ from a two-source file in
     every lca_certifications and every `both` tier, and report "stale" when nothing is stale. The
     header tells maintainers without python3 to pass --uscis-only; it must not turn a documented
     fallback into a false failure. */
  console.error('--check cannot run with --uscis-only: it would compare a one-source rebuild against a two-source file.');
  process.exit(2);
}

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
  const byTier = (tier) => confirmed.filter((e) => e.evidence === tier).length;
  console.log(`${confirmed.length}/${built.employers.length} board employers confirmed.`);
  console.log(`  ${byTier('both')} in both sources, ${byTier('uscis_h1b')} USCIS approvals only (FY${FISCAL_YEARS[0]}-${FISCAL_YEARS.at(-1)}), ${byTier('dol_lca')} certified LCAs only (${LCA_QUARTERS[0]}-${LCA_QUARTERS.at(-1)}).`);
  const missing = built.employers.filter((e) => !e.sponsors).map((e) => e.company);
  if (missing.length) console.log(`No filings found for: ${missing.join(', ')}`);
}
