import rawCatalog from '../data/jobSourceBrands500k.json';
import { POLLABLE_JOB_BOARDS, type JobSourceInput, type SupportedJobBoard } from './jobMonitor';
import { sourceCareerUrl } from './jobSourceDiscovery';
import { normalizeExecutableAtsBoardToken } from './atsBoardToken';

/** Candidate only. Runtime proof must promote it before any posting can be surfaced or counted. */
export const CATALOG_DOMAIN_CANDIDATE_METHOD = 'catalog_company_domain_candidate';

export type CatalogBrandedJobSource = JobSourceInput & {
  company_domain: string;
  logo_verification_status: 'unverified';
  logo_verification_method: typeof CATALOG_DOMAIN_CANDIDATE_METHOD;
  logo_verified_at: null;
};

type CatalogRow = {
  ats_name?: unknown;
  board_token?: unknown;
  company_name?: unknown;
  company_domain?: unknown;
};

const BARE_DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;
const pollable = new Set<string>(POLLABLE_JOB_BOARDS);

/**
 * Turn the generated CC0 enrichment snapshot into provisional source identities.
 *
 * The snapshot is discovery input, not verification evidence. A domain and company name survive
 * only strict structural validation here, then enter persistence as unverified. The independent
 * first-party branding verifier must prove the identity and image before the logo gate admits any
 * job from the source.
 */
export function parseCatalogBrandedJobSources(rows: unknown): CatalogBrandedJobSource[] {
  if (!Array.isArray(rows)) throw new Error('Job source brand catalog must be an array');
  const out = new Map<string, CatalogBrandedJobSource>();
  for (const candidate of rows as CatalogRow[]) {
    const ats = typeof candidate?.ats_name === 'string' ? candidate.ats_name.trim().toLowerCase() : '';
    const rawToken = typeof candidate?.board_token === 'string' ? candidate.board_token : '';
    const companyName = typeof candidate?.company_name === 'string' ? candidate.company_name.trim() : '';
    const domain = typeof candidate?.company_domain === 'string'
      ? candidate.company_domain.trim().toLowerCase().replace(/^www\./, '')
      : '';
    const supportedAts = pollable.has(ats) ? ats as SupportedJobBoard : null;
    const token = supportedAts
      ? normalizeExecutableAtsBoardToken(supportedAts, rawToken)
      : null;
    if (!supportedAts || !token
      || !companyName || companyName.length > 200
      || !BARE_DOMAIN_RE.test(domain) || domain.length > 253) {
      throw new Error(`Invalid job source brand catalog row for ${ats || 'unknown'}/${rawToken || 'unknown'}`);
    }
    const source: CatalogBrandedJobSource = {
      ats_name: supportedAts,
      board_token: token,
      company_name: companyName,
      company_domain: domain,
      career_url: sourceCareerUrl(supportedAts, token),
      enabled: true,
      logo_verification_status: 'unverified',
      logo_verification_method: CATALOG_DOMAIN_CANDIDATE_METHOD,
      logo_verified_at: null,
    };
    const key = `${ats}/${token.toLowerCase()}`;
    if (out.has(key)) throw new Error(`Duplicate job source brand catalog row for ${key}`);
    out.set(key, source);
  }
  if (out.size === 0) throw new Error('Job source brand catalog is empty');
  return [...out.values()];
}

let parsedCatalog: CatalogBrandedJobSource[] | null = null;

export function catalogBrandedJobSources(): readonly CatalogBrandedJobSource[] {
  parsedCatalog ??= parseCatalogBrandedJobSources(rawCatalog);
  return parsedCatalog;
}
