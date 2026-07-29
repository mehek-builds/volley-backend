/**
 * The sponsoring-employer database, as the rest of the backend sees it.
 *
 * The data itself is generated (src/data/h1bSponsors.ts, written by scripts/build-h1b-sponsors.mjs
 * from the USCIS H-1B Employer Data Hub). This module is the reading half: it turns that file into
 * a lookup by normalised company name and answers one question - has this employer actually had an
 * H-1B petition approved?
 *
 * WHY IT IS A FILE AND NOT ONLY A TABLE. Both, in fact: `sponsor_employers` in Postgres is what the
 * board query joins against, because a filter has to run in SQL to keep the count, the pages and
 * the tiles describing the same set. This file is what SEEDS that table, and it is the reviewable
 * copy - a change to who Litos claims will sponsor a visa shows up in a pull request as a diff with
 * approval counts and legal entity names beside it, rather than as a row somebody wrote into
 * production one evening.
 */

import { H1B_SPONSOR_FILE } from '../data/h1bSponsors';
import { normalizeEmployerName } from './sponsorship';

/**
 * WHICH GOVERNMENT RECORD CONFIRMED THIS EMPLOYER.
 *
 *   uscis_h1b  an H-1B petition was APPROVED (USCIS Employer Data Hub, FY2021-2023)
 *   dol_lca    a labor condition application was CERTIFIED (DOL, FY2025). The employer named the
 *              role, the worksite and the wage and attested to paying it. Not an approval, and two
 *              years more current, which is what makes it worth having: a company founded in 2023
 *              can sponsor people and appear nowhere in the USCIS file.
 *   both       both records exist.
 *
 * Kept apart rather than collapsed to a boolean because they are different claims, and any surface
 * that tells somebody why a job is on their board has to be able to make the weaker one honestly.
 */
export type SponsorEvidenceSource = 'uscis_h1b' | 'dol_lca' | 'both';

export type H1bSponsorEmployer = {
  /** The company as the Litos board names it, matching career_page_sources.company_name. */
  company: string;
  normalized: string;
  /** True when EITHER record exists. See the ingest script for why the bar is one filing. */
  sponsors: boolean;
  /** Null exactly when `sponsors` is false. */
  evidence: SponsorEvidenceSource | null;
  /**
   * Why this employer is refused a match outright, or absent.
   *
   * A handful of board tokens resolve to a DIFFERENT company than their display name claims - the
   * greenhouse token `sas` is Superior Alarm Systems, `tcs` is Thornbury Community Services - and
   * each was confirmed by an earlier version of this data against the famous company's filings.
   * The refusal is recorded rather than merely applied, so nobody restores it as an obvious fix.
   */
  rejected?: string;
  /** Which normalised key matched, or null. Kept so a wrong match is diagnosable from the data. */
  matched_key: string | null;
  /**
   * The employer's legal names exactly as filed, from BOTH sources, which is why the same company
   * often appears twice in different capitalisation ("MATONEE INC D/B/A APTOS LABS" from USCIS,
   * "Matonee Inc. d/b/a Aptos Labs" from DOL). This is the audit trail: it is what a human reads
   * when asking whether a match is real.
   */
  legal_names: string[];
  approvals: number;
  denials: number;
  /** Fiscal years with at least one approval. Empty when nothing matched. */
  fiscal_years: number[];
  /** Certified H-1B labor condition applications across the DOL quarters. */
  lca_certifications: number;
  /**
   * Where the petitions were filed from. NOT evidence of sponsorship, and never read by the board:
   * it exists so scripts/verify-sponsor-matches.mjs can tell a same-named company apart from ours.
   * A US filer in Delaware is not the Amsterdam grocer whose board we poll under the same word.
   */
  filing_states: string[];
  filing_cities: string[];
};

export type H1bSponsorFile = {
  source: string;
  source_urls: string[];
  fiscal_years: number[];
  lca_source: string;
  lca_source_urls: string[];
  lca_quarters: string[];
  employers: H1bSponsorEmployer[];
};

export const H1B_SOURCE = H1B_SPONSOR_FILE.source;
export const H1B_FISCAL_YEARS = H1B_SPONSOR_FILE.fiscal_years;
export const LCA_SOURCE = H1B_SPONSOR_FILE.lca_source;
export const LCA_QUARTERS = H1B_SPONSOR_FILE.lca_quarters;

/** Every employer we have checked, sponsoring or not. Includes the misses on purpose. */
export const H1B_EMPLOYERS: readonly H1bSponsorEmployer[] = H1B_SPONSOR_FILE.employers;

const BY_NORMALIZED = new Map(H1B_EMPLOYERS.map((employer) => [employer.normalized, employer]));

/**
 * What we know about one company's H-1B history.
 *
 * Null means NOT CHECKED - a company that is not on the board list at all - and the caller must
 * treat that exactly as it treats a checked company with no filings: not confirmed. The two are
 * distinguished here rather than collapsed because only one of them is a bug worth fixing (a job
 * source added without re-running the ingest), and a bare `false` would hide it.
 */
export function h1bEmployer(companyName: string): H1bSponsorEmployer | null {
  return BY_NORMALIZED.get(normalizeEmployerName(companyName)) ?? null;
}

/** The one-bit answer the board filter needs. Unknown and unconfirmed both mean false. */
export function employerFilesH1b(companyName: string): boolean {
  return h1bEmployer(companyName)?.sponsors === true;
}
