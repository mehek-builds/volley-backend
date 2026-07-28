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

export type H1bSponsorEmployer = {
  /** The company as the Litos board names it, matching career_page_sources.company_name. */
  company: string;
  normalized: string;
  /** True only when an H-1B petition was APPROVED in the window. See the script for the bar. */
  sponsors: boolean;
  /** Which normalised key matched, or null. Kept so a wrong match is diagnosable from the data. */
  matched_key: string | null;
  /** The employer's legal names exactly as USCIS filed them. This is the audit trail. */
  legal_names: string[];
  approvals: number;
  denials: number;
  /** Fiscal years with at least one approval. Empty when nothing matched. */
  fiscal_years: number[];
};

export type H1bSponsorFile = {
  source: string;
  source_urls: string[];
  fiscal_years: number[];
  employers: H1bSponsorEmployer[];
};

export const H1B_SOURCE = H1B_SPONSOR_FILE.source;
export const H1B_FISCAL_YEARS = H1B_SPONSOR_FILE.fiscal_years;

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
