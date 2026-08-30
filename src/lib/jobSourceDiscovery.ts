import {
  POLLABLE_JOB_BOARDS,
  type JobSourceInput,
  type SupportedJobBoard,
} from './jobMonitor';
import { normalizeExecutableAtsBoardToken } from './atsBoardToken';

/**
 * Remote catalogs are used only to discover board identifiers.
 *
 * Their job records are never ingested. Every candidate is polled from its first-party ATS and
 * must still pass the description, autonomous-portal, freshness, and first-party branding gates
 * before any posting can enter the surfaced inventory.
 */
export const DEFAULT_JOB_SOURCE_CATALOG_URL =
  'https://raw.githubusercontent.com/elliottdehn/open-jobs/main/slugs.json';
export const OPEN_JOBS_REPOSITORY_URL = 'https://github.com/elliottdehn/open-jobs';
export const OPEN_JOBS_LICENSE_URL = 'https://github.com/elliottdehn/open-jobs/blob/main/LICENSE';
export const SOURCE_DISCOVERY_CANDIDATE_METHOD = 'cc0_board_identifier_candidate';

export const FREEHIRE_REPOSITORY_URL = 'https://github.com/strelov1/freehire';
export const FREEHIRE_LICENSE_URL = 'https://github.com/strelov1/freehire/blob/main/LICENSE';
export const FREEHIRE_SOURCE_DISCOVERY_CANDIDATE_METHOD = 'mit_freehire_board_candidate';

export const ATS_SCRAPERS_REPOSITORY_URL = 'https://github.com/kalil0321/ats-scrapers';
export const ATS_SCRAPERS_LICENSE_URL = 'https://github.com/kalil0321/ats-scrapers/blob/main/LICENSE';
export const ATS_SCRAPERS_SOURCE_DISCOVERY_CANDIDATE_METHOD =
  'mit_ats_scrapers_board_candidate';

export const FREEHIRE_ATS_FAMILIES = [
  'greenhouse', 'lever', 'ashby', 'workable', 'breezy', 'recruitee',
] as const satisfies readonly SupportedJobBoard[];
export type FreehireAtsFamily = typeof FREEHIRE_ATS_FAMILIES[number];

export const ATS_SCRAPERS_ATS_FAMILIES = [
  'greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'breezy', 'recruitee',
] as const satisfies readonly SupportedJobBoard[];
export type AtsScrapersAtsFamily = typeof ATS_SCRAPERS_ATS_FAMILIES[number];

export const FREEHIRE_SOURCE_CATALOG_URLS = Object.freeze(Object.fromEntries(
  FREEHIRE_ATS_FAMILIES.map((family) => [
    family,
    `https://raw.githubusercontent.com/strelov1/freehire/main/sources/${family}.yml`,
  ]),
) as Record<FreehireAtsFamily, string>);

export const ATS_SCRAPERS_SOURCE_CATALOG_URLS = Object.freeze(Object.fromEntries(
  ATS_SCRAPERS_ATS_FAMILIES.map((family) => [
    family,
    `https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/${family}.csv`,
  ]),
) as Record<AtsScrapersAtsFamily, string>);

export const OPEN_JOBS_REQUIRED_FAMILIES = [
  'greenhouse', 'lever', 'ashby', 'workable', 'rippling', 'breezy', 'recruitee', 'crelate',
] as const satisfies readonly SupportedJobBoard[];
export type OpenJobsRequiredFamily = typeof OPEN_JOBS_REQUIRED_FAMILIES[number];

/**
 * Intentionally well below the current catalogs, but high enough that a valid JSON prefix or a
 * publisher-side truncation cannot authorize mass retirement. These are unique, normalized board
 * counts, not raw array lengths.
 */
export const OPEN_JOBS_COMPLETENESS_MINIMUMS: Readonly<Record<OpenJobsRequiredFamily, number>> = {
  greenhouse: 4_000,
  lever: 1_500,
  ashby: 1_500,
  workable: 3_000,
  rippling: 0,
  breezy: 1_500,
  recruitee: 1_500,
  crelate: 200,
};

/**
 * A completeness floor catches truncation. These ceilings catch the opposite failure mode: a
 * publisher bug, schema change, or compromised snapshot suddenly claiming thousands of new board
 * identifiers. The values leave roughly 45 to 100 percent headroom over the 2026-08-30 snapshot,
 * while keeping activation bounded enough that an upstream spike cannot turn directly into
 * first-party verification traffic and persisted source rows.
 */
export const OPEN_JOBS_COMPLETENESS_MAXIMUMS: Readonly<Record<OpenJobsRequiredFamily, number>> = {
  greenhouse: 12_000,
  lever: 5_500,
  ashby: 6_000,
  workable: 10_000,
  rippling: 1_000,
  breezy: 6_500,
  recruitee: 5_000,
  crelate: 1_000,
};

/** The same fail-closed truncation guard for the six MIT Freehire source files. */
export const FREEHIRE_COMPLETENESS_MINIMUMS: Readonly<Record<FreehireAtsFamily, number>> = {
  greenhouse: 5_000,
  lever: 1_500,
  ashby: 3_000,
  workable: 1_200,
  breezy: 1_200,
  recruitee: 1_500,
};

export const FREEHIRE_COMPLETENESS_MAXIMUMS: Readonly<Record<FreehireAtsFamily, number>> = {
  greenhouse: 10_000,
  lever: 3_500,
  ashby: 6_000,
  workable: 3_000,
  breezy: 3_500,
  recruitee: 3_500,
};

/** Per-file bounds for the MIT ats-scrapers tenant lists, measured on 2026-08-31. */
export const ATS_SCRAPERS_COMPLETENESS_MINIMUMS: Readonly<Record<AtsScrapersAtsFamily, number>> = {
  greenhouse: 4_000,
  lever: 1_500,
  ashby: 2_000,
  workable: 3_000,
  rippling: 1_200,
  breezy: 800,
  recruitee: 700,
};

export const ATS_SCRAPERS_COMPLETENESS_MAXIMUMS: Readonly<Record<AtsScrapersAtsFamily, number>> = {
  greenhouse: 9_000,
  lever: 4_000,
  ashby: 6_000,
  workable: 8_000,
  rippling: 4_000,
  breezy: 3_000,
  recruitee: 3_000,
};

type CandidateMethod =
  | typeof SOURCE_DISCOVERY_CANDIDATE_METHOD
  | typeof FREEHIRE_SOURCE_DISCOVERY_CANDIDATE_METHOD
  | typeof ATS_SCRAPERS_SOURCE_DISCOVERY_CANDIDATE_METHOD;

export type DiscoveredJobSource = JobSourceInput & {
  logo_verification_status: 'unverified';
  logo_verification_method: CandidateMethod;
  logo_verified_at: null;
};

type SourceCounts = Partial<Record<SupportedJobBoard, number>>;

export type JobSourceCatalogStatus = {
  url: string;
  repositoryUrl: typeof OPEN_JOBS_REPOSITORY_URL;
  licenseUrl: typeof OPEN_JOBS_LICENSE_URL;
  license: 'CC0-1.0';
  fetched: boolean;
  complete: boolean;
  sourceCount: number;
  counts: SourceCounts;
  error: string | null;
};

export type FreehireCatalogFileStatus = {
  atsName: FreehireAtsFamily;
  url: string;
  fetched: boolean;
  complete: boolean;
  sourceCount: number;
  error: string | null;
};

export type AtsScrapersCatalogFileStatus = {
  atsName: AtsScrapersAtsFamily;
  url: string;
  fetched: boolean;
  complete: boolean;
  sourceCount: number;
  error: string | null;
};

export type JobSourceDiscoveryResult = {
  /** Every syntactically valid candidate observed, including an incomplete or anomalous snapshot. */
  candidateSources: DiscoveredJobSource[];
  /** Candidates authorized for additive activation from each independently trusted partition. */
  sources: DiscoveredJobSource[];
  /**
   * The only signal that may authorize additive activation of the observed candidate fleet. It is
   * true only when open-jobs, every Freehire file, and every ats-scrapers file pass their size
   * checks. A valid ats-scrapers family remains independently activatable when another family is
   * anomalous. Discovery never authorizes retirement of persisted sources.
   */
  trustedComplete: boolean;
  provenance: {
    openJobs: JobSourceCatalogStatus;
    freehire: {
      repositoryUrl: typeof FREEHIRE_REPOSITORY_URL;
      licenseUrl: typeof FREEHIRE_LICENSE_URL;
      license: 'MIT';
      complete: boolean;
      sourceCount: number;
      files: Record<FreehireAtsFamily, FreehireCatalogFileStatus>;
    };
    atsScrapers: {
      repositoryUrl: typeof ATS_SCRAPERS_REPOSITORY_URL;
      licenseUrl: typeof ATS_SCRAPERS_LICENSE_URL;
      license: 'MIT';
      complete: boolean;
      sourceCount: number;
      activatedSourceCount: number;
      files: Record<AtsScrapersAtsFamily, AtsScrapersCatalogFileStatus>;
    };
  };
};

export type JobSourceDiscoveryOptions = {
  openJobsMinimums?: Readonly<Record<OpenJobsRequiredFamily, number>>;
  openJobsMaximums?: Readonly<Record<OpenJobsRequiredFamily, number>>;
  freehireMinimums?: Readonly<Record<FreehireAtsFamily, number>>;
  freehireMaximums?: Readonly<Record<FreehireAtsFamily, number>>;
  freehireCatalogUrls?: Readonly<Record<FreehireAtsFamily, string>>;
  atsScrapersMinimums?: Readonly<Record<AtsScrapersAtsFamily, number>>;
  atsScrapersMaximums?: Readonly<Record<AtsScrapersAtsFamily, number>>;
  atsScrapersCatalogUrls?: Readonly<Record<AtsScrapersAtsFamily, string>>;
};

const DISCOVERY_CACHE_MS = 6 * 60 * 60 * 1000;
const INCOMPLETE_DISCOVERY_CACHE_MS = 5 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 20_000;
const OPEN_JOBS_MAX_BYTES = 5 * 1024 * 1024;
const FREEHIRE_FILE_MAX_BYTES = 1024 * 1024;
const ATS_SCRAPERS_FILE_MAX_BYTES = 1024 * 1024;
const MAX_CATALOG_ROWS_PER_FAMILY = 50_000;

type CatalogPayload = { ats?: Record<string, unknown> };

export function sourceCareerUrl(ats: SupportedJobBoard, token: string): string {
  const normalized = normalizeExecutableAtsBoardToken(ats, token);
  if (!normalized) throw new Error(`Invalid ${ats} board token`);
  const encoded = encodeURIComponent(normalized);
  switch (ats) {
    case 'greenhouse': return `https://boards.greenhouse.io/${encoded}`;
    case 'lever': return `https://jobs.lever.co/${encoded}`;
    case 'ashby': return `https://jobs.ashbyhq.com/${encoded}`;
    case 'workable': return `https://apply.workable.com/${encoded}`;
    case 'rippling': return `https://ats.rippling.com/${encoded}/jobs`;
    case 'breezy': return `https://${encoded}.breezy.hr`;
    case 'recruitee': return `https://${encoded}.recruitee.com`;
    case 'crelate': return `https://jobs.crelate.com/portal/${encoded}`;
    default: {
      const exhaustive: never = ats;
      throw new Error(`Unsupported discovery board: ${String(exhaustive)}`);
    }
  }
}

function candidateSource(
  atsName: SupportedJobBoard,
  token: string,
  companyName: string,
  method: CandidateMethod,
): DiscoveredJobSource {
  return {
    company_name: companyName,
    ats_name: atsName,
    board_token: token,
    career_url: sourceCareerUrl(atsName, token),
    enabled: true,
    logo_verification_status: 'unverified',
    logo_verification_method: method,
    logo_verified_at: null,
  };
}

function countSources(sources: readonly DiscoveredJobSource[]): SourceCounts {
  const counts: SourceCounts = {};
  for (const source of sources) counts[source.ats_name] = (counts[source.ats_name] ?? 0) + 1;
  return counts;
}

function meetsCompletenessBounds<T extends SupportedJobBoard>(
  counts: SourceCounts,
  families: readonly T[],
  minimums: Readonly<Record<T, number>>,
  maximums: Readonly<Record<T, number>>,
): boolean {
  const aggregateMinimum = families.reduce((sum, family) => sum + minimums[family], 0);
  const aggregateCount = families.reduce((sum, family) => sum + (counts[family] ?? 0), 0);
  return aggregateCount >= aggregateMinimum
    && families.every((family) => {
      const count = counts[family] ?? 0;
      return count >= minimums[family] && count <= maximums[family];
    });
}

function outsideBoundsReason<T extends SupportedJobBoard>(
  counts: SourceCounts,
  families: readonly T[],
  minimums: Readonly<Record<T, number>>,
  maximums: Readonly<Record<T, number>>,
): string | null {
  const violations = families.flatMap((family) => {
    const count = counts[family] ?? 0;
    return count < minimums[family] || count > maximums[family]
      ? [`${family}:${count} outside ${minimums[family]}-${maximums[family]}`]
      : [];
  });
  return violations.length > 0 ? `Catalog count outside trusted range (${violations.join(', ')})` : null;
}

function parseOpenJobsCatalog(payload: unknown): { sources: DiscoveredJobSource[]; counts: SourceCounts } {
  const ats = (payload as CatalogPayload | null)?.ats;
  if (!ats || typeof ats !== 'object' || Array.isArray(ats)) {
    throw new Error('Job source catalog has no ATS map');
  }

  const discovered: DiscoveredJobSource[] = [];
  const seen = new Set<string>();
  for (const family of POLLABLE_JOB_BOARDS) {
    const raw = ats[family];
    if (raw === undefined) continue;
    if (!Array.isArray(raw)) throw new Error(`Job source catalog ${family} entry is not an array`);
    if (raw.length > MAX_CATALOG_ROWS_PER_FAMILY) {
      throw new Error(`Job source catalog ${family} exceeds the row limit`);
    }
    for (const value of raw) {
      const token = normalizeExecutableAtsBoardToken(family, value);
      if (!token) continue;
      const key = `${family}/${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      discovered.push(candidateSource(
        family,
        token,
        token,
        SOURCE_DISCOVERY_CANDIDATE_METHOD,
      ));
    }
  }
  if (discovered.length === 0) throw new Error('Job source catalog contains no pollable boards');
  return { sources: discovered, counts: countSources(discovered) };
}

/** Parse and bound the untrusted CC0 catalog without treating it as identity or logo proof. */
export function parseDiscoveredJobSources(payload: unknown): DiscoveredJobSource[] {
  return parseOpenJobsCatalog(payload).sources;
}

function parseYamlScalar(raw: string, lineNumber: number, field: string): string {
  const value = raw.trim();
  if (!value) throw new Error(`Freehire ${field} is empty at line ${lineNumber}`);
  let parsed = value;
  if (value.startsWith('"')) {
    try {
      const decoded = JSON.parse(value) as unknown;
      if (typeof decoded !== 'string') throw new Error('not a string');
      parsed = decoded;
    } catch {
      throw new Error(`Invalid quoted Freehire ${field} at line ${lineNumber}`);
    }
  } else if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw new Error(`Invalid quoted Freehire ${field} at line ${lineNumber}`);
    }
    parsed = value.slice(1, -1).replace(/''/g, "'");
  }
  parsed = parsed.trim();
  if (!parsed || /[\u0000-\u001f\u007f]/.test(parsed)) {
    throw new Error(`Invalid Freehire ${field} at line ${lineNumber}`);
  }
  return parsed;
}

type PendingFreehireRow = {
  companyName: string;
  companyLine: number;
  boardToken: string | null;
  region: string | null;
};

function comparableCompanyName(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Parse the intentionally tiny Freehire YAML schema without enabling general YAML tags, aliases,
 * or object construction. Conflicting identities for one canonical board are omitted rather than
 * letting file order choose an employer. Region-qualified Lever rows are also omitted because the
 * current first-party poller supports the default Lever endpoint only.
 */
export function parseFreehireJobSources(
  atsName: FreehireAtsFamily,
  text: string,
): DiscoveredJobSource[] {
  if (!(FREEHIRE_ATS_FAMILIES as readonly string[]).includes(atsName)) {
    throw new Error(`Unsupported Freehire ATS family: ${String(atsName)}`);
  }
  if (Buffer.byteLength(text, 'utf8') > FREEHIRE_FILE_MAX_BYTES) {
    throw new Error(`Freehire ${atsName} catalog exceeds the byte limit`);
  }

  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length > MAX_CATALOG_ROWS_PER_FAMILY * 4) {
    throw new Error(`Freehire ${atsName} catalog exceeds the line limit`);
  }
  const sources = new Map<string, DiscoveredJobSource>();
  const ambiguous = new Set<string>();
  let pending: PendingFreehireRow | null = null;

  const finalize = () => {
    if (!pending) return;
    if (!pending.boardToken) {
      throw new Error(`Freehire company at line ${pending.companyLine} has no board`);
    }
    const companyName = pending.companyName;
    const token = normalizeExecutableAtsBoardToken(atsName, pending.boardToken);
    if (!token) {
      pending = null;
      return;
    }
    if (companyName.length > 200) {
      throw new Error(`Freehire company exceeds the length limit at line ${pending.companyLine}`);
    }
    // A region marks a provider endpoint that this poller does not yet support. Do not persist a
    // candidate that can only fail its first-party poll.
    if (pending.region) {
      pending = null;
      return;
    }
    const key = `${atsName}/${token}`;
    const existing = sources.get(key);
    if (ambiguous.has(key)) {
      pending = null;
      return;
    }
    if (existing) {
      if (comparableCompanyName(existing.company_name) !== comparableCompanyName(companyName)) {
        sources.delete(key);
        ambiguous.add(key);
      }
      pending = null;
      return;
    }
    sources.set(key, candidateSource(
      atsName,
      token,
      companyName,
      FREEHIRE_SOURCE_DISCOVERY_CANDIDATE_METHOD,
    ));
    pending = null;
  };

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#') || rawLine.trim() === '---') continue;
    if (rawLine.includes('\t')) throw new Error(`Tabs are not allowed in Freehire YAML at line ${lineNumber}`);
    if (rawLine.startsWith('- company: ')) {
      finalize();
      pending = {
        companyName: parseYamlScalar(rawLine.slice('- company: '.length), lineNumber, 'company'),
        companyLine: lineNumber,
        boardToken: null,
        region: null,
      };
      continue;
    }
    if (rawLine.startsWith('  board: ')) {
      if (!pending || pending.boardToken !== null) {
        throw new Error(`Unexpected Freehire board at line ${lineNumber}`);
      }
      pending.boardToken = parseYamlScalar(rawLine.slice('  board: '.length), lineNumber, 'board');
      continue;
    }
    if (rawLine.startsWith('  region: ')) {
      if (!pending || !pending.boardToken || pending.region !== null) {
        throw new Error(`Unexpected Freehire region at line ${lineNumber}`);
      }
      pending.region = parseYamlScalar(rawLine.slice('  region: '.length), lineNumber, 'region');
      if (pending.region.length > 20) throw new Error(`Freehire region is too long at line ${lineNumber}`);
      continue;
    }
    throw new Error(`Unsupported Freehire YAML at line ${lineNumber}`);
  }
  finalize();
  if (sources.size === 0) throw new Error(`Freehire ${atsName} catalog contains no usable boards`);
  return [...sources.values()];
}

function parseBoundedCsv(text: string, label: string): string[][] {
  if (Buffer.byteLength(text, 'utf8') > ATS_SCRAPERS_FILE_MAX_BYTES) {
    throw new Error(`${label} catalog exceeds the byte limit`);
  }
  const input = text.replace(/^\uFEFF/, '');
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let quoted = false;
  let closedQuote = false;

  const finishField = () => {
    record.push(field);
    field = '';
    closedQuote = false;
  };
  const finishRecord = () => {
    finishField();
    if (record.length !== 1 || record[0] !== '') records.push(record);
    record = [];
    if (records.length > MAX_CATALOG_ROWS_PER_FAMILY + 1) {
      throw new Error(`${label} catalog exceeds the row limit`);
    }
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          closedQuote = true;
        }
      } else {
        field += character;
      }
      continue;
    }
    if (closedQuote && character !== ',' && character !== '\r' && character !== '\n') {
      throw new Error(`${label} catalog has characters after a closing quote`);
    }
    if (character === '"') {
      if (field.length > 0 || closedQuote) throw new Error(`${label} catalog has an invalid quote`);
      quoted = true;
    } else if (character === ',') {
      finishField();
    } else if (character === '\n') {
      finishRecord();
    } else if (character === '\r') {
      if (input[index + 1] === '\n') index += 1;
      finishRecord();
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error(`${label} catalog has an unterminated quoted field`);
  if (field.length > 0 || record.length > 0 || closedQuote) finishRecord();
  return records;
}

function atsScrapersUrlToken(atsName: AtsScrapersAtsFamily, raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) {
      return null;
    }
    const host = url.hostname.toLowerCase();
    const parts = url.pathname.split('/').filter(Boolean);
    let token: string | null = null;
    switch (atsName) {
      case 'greenhouse':
        if (!['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(host) || parts.length !== 1) return null;
        [token] = parts;
        break;
      case 'lever':
        if (host !== 'jobs.lever.co' || parts.length !== 1) return null;
        [token] = parts;
        break;
      case 'ashby':
        if (host !== 'jobs.ashbyhq.com' || parts.length !== 1) return null;
        [token] = parts;
        break;
      case 'workable':
        if (host !== 'apply.workable.com' || parts.length !== 1) return null;
        [token] = parts;
        break;
      case 'rippling':
        if (host !== 'ats.rippling.com' || parts.length !== 2 || parts[1].toLowerCase() !== 'jobs') return null;
        [token] = parts;
        break;
      case 'breezy':
        if (!host.endsWith('.breezy.hr') || parts.length !== 0) return null;
        token = host.slice(0, -'.breezy.hr'.length);
        break;
      case 'recruitee':
        if (!host.endsWith('.recruitee.com') || parts.length !== 0) return null;
        token = host.slice(0, -'.recruitee.com'.length);
        break;
      default: {
        const exhaustive: never = atsName;
        return exhaustive;
      }
    }
    return normalizeExecutableAtsBoardToken(atsName, token);
  } catch {
    return null;
  }
}

/** Parse one MIT tenant CSV as provisional identities, never as job or logo evidence. */
export function parseAtsScrapersJobSources(
  atsName: AtsScrapersAtsFamily,
  text: string,
): DiscoveredJobSource[] {
  if (!(ATS_SCRAPERS_ATS_FAMILIES as readonly string[]).includes(atsName)) {
    throw new Error(`Unsupported ats-scrapers ATS family: ${String(atsName)}`);
  }
  const records = parseBoundedCsv(text, `ats-scrapers ${atsName}`);
  const header = records.shift();
  if (!header || header.length !== 3
    || header[0].trim().toLowerCase() !== 'name'
    || header[1].trim().toLowerCase() !== 'slug'
    || header[2].trim().toLowerCase() !== 'url') {
    throw new Error(`ats-scrapers ${atsName} catalog has an unsupported header`);
  }

  const sources = new Map<string, DiscoveredJobSource>();
  const ambiguous = new Set<string>();
  for (const row of records) {
    if (row.length !== 3) throw new Error(`ats-scrapers ${atsName} catalog has an invalid row shape`);
    const companyName = row[0].normalize('NFKC').trim().replace(/\s+/g, ' ');
    const token = normalizeExecutableAtsBoardToken(atsName, row[1]);
    const urlToken = atsScrapersUrlToken(atsName, row[2]);
    if (!companyName || companyName.length > 200 || /[\u0000-\u001f\u007f]/.test(companyName)
      || !token || token !== urlToken) continue;
    const key = `${atsName}/${token}`;
    if (ambiguous.has(key)) continue;
    const existing = sources.get(key);
    if (existing && comparableCompanyName(existing.company_name) !== comparableCompanyName(companyName)) {
      sources.delete(key);
      ambiguous.add(key);
      continue;
    }
    if (!existing) {
      sources.set(key, candidateSource(
        atsName,
        token,
        companyName,
        ATS_SCRAPERS_SOURCE_DISCOVERY_CANDIDATE_METHOD,
      ));
    }
  }
  if (sources.size === 0) throw new Error(`ats-scrapers ${atsName} catalog contains no usable boards`);
  return [...sources.values()];
}

async function readBoundedText(response: Response, maxBytes: number, label: string): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label} exceeds the byte limit`);
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error(`${label} exceeds the byte limit`);
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`${label} exceeds the byte limit`);
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

async function fetchCatalogText(
  fetcher: typeof fetch,
  url: string,
  accept: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const response = await fetcher(url, {
    headers: { Accept: accept, 'User-Agent': 'LitosSourceDiscovery/1.0' },
    redirect: 'error',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  return readBoundedText(response, maxBytes, label);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mergeRemoteSources(
  ...catalogs: readonly (readonly DiscoveredJobSource[])[]
): DiscoveredJobSource[] {
  const merged = new Map<string, DiscoveredJobSource>();
  /* Later catalogs carry provisional company labels, which are more useful to first-party
     branding than an opaque slug. Every label remains unverified and cannot satisfy the gate. */
  for (const catalog of catalogs) {
    for (const source of catalog) merged.set(`${source.ats_name}/${source.board_token}`, source);
  }
  const familyOrder = new Map(POLLABLE_JOB_BOARDS.map((family, index) => [family, index]));
  return [...merged.values()].sort((left, right) => {
    const byFamily = (familyOrder.get(left.ats_name) ?? 0) - (familyOrder.get(right.ats_name) ?? 0);
    if (byFamily !== 0) return byFamily;
    return left.board_token < right.board_token ? -1 : left.board_token > right.board_token ? 1 : 0;
  });
}

let cached: { key: string; expiresAt: number; result: JobSourceDiscoveryResult } | null = null;

/**
 * Fetch the remote discovery catalogs. The open-jobs and Freehire pair retain their all-files
 * trust contract. Each ats-scrapers family is an independent additive partition, so one truncated
 * family cannot suppress a valid family. Persisted sources are always preserved because discovery
 * never authorizes retirement.
 */
export async function discoverJobSources(
  fetcher: typeof fetch = fetch,
  catalogUrl = process.env.JOB_SOURCE_CATALOG_URL ?? DEFAULT_JOB_SOURCE_CATALOG_URL,
  now = Date.now(),
  options: JobSourceDiscoveryOptions = {},
): Promise<JobSourceDiscoveryResult> {
  const openMinimums = options.openJobsMinimums ?? OPEN_JOBS_COMPLETENESS_MINIMUMS;
  const openMaximums = options.openJobsMaximums ?? OPEN_JOBS_COMPLETENESS_MAXIMUMS;
  const freehireMinimums = options.freehireMinimums ?? FREEHIRE_COMPLETENESS_MINIMUMS;
  const freehireMaximums = options.freehireMaximums ?? FREEHIRE_COMPLETENESS_MAXIMUMS;
  const freehireUrls = options.freehireCatalogUrls ?? FREEHIRE_SOURCE_CATALOG_URLS;
  const atsScrapersMinimums = options.atsScrapersMinimums ?? ATS_SCRAPERS_COMPLETENESS_MINIMUMS;
  const atsScrapersMaximums = options.atsScrapersMaximums ?? ATS_SCRAPERS_COMPLETENESS_MAXIMUMS;
  const atsScrapersUrls = options.atsScrapersCatalogUrls ?? ATS_SCRAPERS_SOURCE_CATALOG_URLS;
  const cacheKey = JSON.stringify({
    catalogUrl,
    freehireUrls,
    atsScrapersUrls,
    openMinimums,
    openMaximums,
    freehireMinimums,
    freehireMaximums,
    atsScrapersMinimums,
    atsScrapersMaximums,
  });
  if (cached && cached.key === cacheKey && cached.expiresAt > now) return cached.result;

  let openJobsSources: DiscoveredJobSource[] = [];
  let openJobsCounts: SourceCounts = {};
  let openJobsError: string | null = null;
  try {
    const text = await fetchCatalogText(
      fetcher,
      catalogUrl,
      'application/json',
      OPEN_JOBS_MAX_BYTES,
      'open-jobs source catalog',
    );
    const parsed = parseOpenJobsCatalog(JSON.parse(text) as unknown);
    openJobsSources = parsed.sources;
    openJobsCounts = parsed.counts;
  } catch (error) {
    openJobsError = errorMessage(error);
  }
  const openBoundsError = openJobsError === null
    ? outsideBoundsReason(
      openJobsCounts,
      OPEN_JOBS_REQUIRED_FAMILIES,
      openMinimums,
      openMaximums,
    )
    : null;
  const openJobsComplete = openJobsError === null
    && openBoundsError === null
    && meetsCompletenessBounds(
      openJobsCounts,
      OPEN_JOBS_REQUIRED_FAMILIES,
      openMinimums,
      openMaximums,
    );

  const freehireFileEntries = await Promise.all(FREEHIRE_ATS_FAMILIES.map(async (atsName) => {
    const url = freehireUrls[atsName];
    try {
      const text = await fetchCatalogText(
        fetcher,
        url,
        'text/yaml, text/plain',
        FREEHIRE_FILE_MAX_BYTES,
        `Freehire ${atsName} source catalog`,
      );
      const sources = parseFreehireJobSources(atsName, text);
      const complete = sources.length >= freehireMinimums[atsName]
        && sources.length <= freehireMaximums[atsName];
      const boundsError = complete
        ? null
        : `Catalog count ${sources.length} outside trusted range `
          + `${freehireMinimums[atsName]}-${freehireMaximums[atsName]}`;
      return {
        atsName,
        sources,
        status: {
          atsName,
          url,
          fetched: true,
          complete,
          sourceCount: sources.length,
          error: boundsError,
        } satisfies FreehireCatalogFileStatus,
      };
    } catch (error) {
      return {
        atsName,
        sources: [] as DiscoveredJobSource[],
        status: {
          atsName,
          url,
          fetched: false,
          complete: false,
          sourceCount: 0,
          error: errorMessage(error),
        } satisfies FreehireCatalogFileStatus,
      };
    }
  }));

  const freehireFiles = Object.fromEntries(
    freehireFileEntries.map(({ atsName, status }) => [atsName, status]),
  ) as Record<FreehireAtsFamily, FreehireCatalogFileStatus>;
  const freehireSources = freehireFileEntries.flatMap(({ sources }) => sources);
  const freehireCounts = countSources(freehireSources);
  const allFreehireFilesComplete = FREEHIRE_ATS_FAMILIES.every(
    (family) => freehireFiles[family].complete,
  );
  const freehireComplete = allFreehireFilesComplete
    && meetsCompletenessBounds(
      freehireCounts,
      FREEHIRE_ATS_FAMILIES,
      freehireMinimums,
      freehireMaximums,
    );

  const atsScrapersFileEntries = await Promise.all(ATS_SCRAPERS_ATS_FAMILIES.map(async (atsName) => {
    const url = atsScrapersUrls[atsName];
    try {
      const text = await fetchCatalogText(
        fetcher,
        url,
        'text/csv, text/plain',
        ATS_SCRAPERS_FILE_MAX_BYTES,
        `ats-scrapers ${atsName} source catalog`,
      );
      const sources = parseAtsScrapersJobSources(atsName, text);
      const complete = sources.length >= atsScrapersMinimums[atsName]
        && sources.length <= atsScrapersMaximums[atsName];
      const boundsError = complete
        ? null
        : `Catalog count ${sources.length} outside trusted range `
          + `${atsScrapersMinimums[atsName]}-${atsScrapersMaximums[atsName]}`;
      return {
        atsName,
        sources,
        trustedSources: complete ? sources : [],
        status: {
          atsName,
          url,
          fetched: true,
          complete,
          sourceCount: sources.length,
          error: boundsError,
        } satisfies AtsScrapersCatalogFileStatus,
      };
    } catch (error) {
      return {
        atsName,
        sources: [] as DiscoveredJobSource[],
        trustedSources: [] as DiscoveredJobSource[],
        status: {
          atsName,
          url,
          fetched: false,
          complete: false,
          sourceCount: 0,
          error: errorMessage(error),
        } satisfies AtsScrapersCatalogFileStatus,
      };
    }
  }));
  const atsScrapersFiles = Object.fromEntries(
    atsScrapersFileEntries.map(({ atsName, status }) => [atsName, status]),
  ) as Record<AtsScrapersAtsFamily, AtsScrapersCatalogFileStatus>;
  const atsScrapersSources = atsScrapersFileEntries.flatMap(({ sources }) => sources);
  const trustedAtsScrapersSources = atsScrapersFileEntries.flatMap(({ trustedSources }) => trustedSources);
  const atsScrapersComplete = ATS_SCRAPERS_ATS_FAMILIES.every(
    (family) => atsScrapersFiles[family].complete,
  );
  const baseCatalogsComplete = openJobsComplete && freehireComplete;
  const trustedComplete = baseCatalogsComplete && atsScrapersComplete;
  const candidateSources = mergeRemoteSources(openJobsSources, freehireSources, atsScrapersSources);
  const sources = mergeRemoteSources(
    baseCatalogsComplete ? openJobsSources : [],
    baseCatalogsComplete ? freehireSources : [],
    trustedAtsScrapersSources,
  );
  const result: JobSourceDiscoveryResult = {
    candidateSources,
    sources,
    trustedComplete,
    provenance: {
      openJobs: {
        url: catalogUrl,
        repositoryUrl: OPEN_JOBS_REPOSITORY_URL,
        licenseUrl: OPEN_JOBS_LICENSE_URL,
        license: 'CC0-1.0',
        fetched: openJobsError === null,
        complete: openJobsComplete,
        sourceCount: openJobsSources.length,
        counts: openJobsCounts,
        error: openJobsError ?? openBoundsError,
      },
      freehire: {
        repositoryUrl: FREEHIRE_REPOSITORY_URL,
        licenseUrl: FREEHIRE_LICENSE_URL,
        license: 'MIT',
        complete: freehireComplete,
        sourceCount: freehireSources.length,
        files: freehireFiles,
      },
      atsScrapers: {
        repositoryUrl: ATS_SCRAPERS_REPOSITORY_URL,
        licenseUrl: ATS_SCRAPERS_LICENSE_URL,
        license: 'MIT',
        complete: atsScrapersComplete,
        sourceCount: atsScrapersSources.length,
        activatedSourceCount: trustedAtsScrapersSources.length,
        files: atsScrapersFiles,
      },
    },
  };
  cached = {
    key: cacheKey,
    expiresAt: now + (trustedComplete ? DISCOVERY_CACHE_MS : INCOMPLETE_DISCOVERY_CACHE_MS),
    result,
  };
  return result;
}

export function clearJobSourceDiscoveryCacheForTest(): void {
  cached = null;
}
