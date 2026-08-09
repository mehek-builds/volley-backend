import { companyDomainFor } from './companyDomains';
import { JOB_SOURCES } from './jobSources';

/**
 * Greenhouse boards served from the employer's OWN domain.
 *
 * WHAT WAS BROKEN
 * ---------------
 * Portal detection keys on the URL host, so a Greenhouse board embedded in a company page was
 * classified as an unsupported company site and fell through to the email fallback. Measured on
 * production 2026-08-09, three packets on this account:
 *
 *   https://www.jumptrading.com/hr/job?gh_jid=8052351
 *   https://www.jumptrading.com/hr/job?gh_jid=8052338
 *   https://www.oldmissioncapital.com/careers/?gh_jid=7796180003
 *
 * All three are Greenhouse, the ATS Litos supports best (41 of this account's 52 distinct
 * postings), and all three were unreachable purely because the host was not greenhouse.io.
 *
 * HOW A BOARD TOKEN IS ESTABLISHED, because a guessed token is the one failure that matters
 * -----------------------------------------------------------------------------------------
 * Nothing here is derived from the company page itself. The token comes from the intersection of
 * two lists this repo already maintains and already proves:
 *
 *   lib/jobSources     the company -> Greenhouse board token registry. Every token was probed
 *                      against the live board API, and `npm run sources:verify` re-asks each board
 *                      who it is via Greenhouse's own `company_name`, which is what caught the
 *                      `sas` token landing on Superior Alarm Systems.
 *   lib/companyDomains the company -> own web domain map, where every entry was proven by board
 *                      backlink, homepage identity or favicon+DNS, and anything unprovable was
 *                      omitted rather than guessed.
 *
 * A domain therefore only resolves to a token when the SAME company appears in both lists, and a
 * domain claimed by two different Greenhouse tokens resolves to nothing at all. Both lists refuse
 * to guess, so this map inherits that refusal: 222 employer domains resolve, and every other
 * company page with a `gh_jid` on it stays unsupported and keeps the email fallback.
 */

/**
 * Greenhouse job ids are a single global counter and have been seven digits for years. Every one
 * observed anywhere in this repo or in production sits in this range: 4512345, 6883068002,
 * 7351061, 7796180003, 7875125, 8018893, 8052338, 8052351, 4829785101.
 *
 * The floor is what separates a real board embed from a page that merely carries a `gh_jid`
 * shaped query parameter, and it is deliberately the conservative half of the trade: refusing a
 * genuine posting only costs the applicant the email fallback they already had, while accepting a
 * page that is not a board would point a real application at a dead Greenhouse URL.
 */
const GREENHOUSE_JOB_ID = /^[1-9]\d{6,11}$/;

/**
 * Hosts that already have a dedicated, tighter wrapper rule in portalSubmission, which pins the
 * company's careers path as well as the job id. They are excluded here so the general rule cannot
 * quietly widen a shape that was verified narrowly.
 */
const DEDICATED_WRAPPER_DOMAINS = new Set(['databricks.com']);

function greenhouseBoardTokensByDomain(): Map<string, string> {
  const claims = new Map<string, Set<string>>();
  for (const source of JOB_SOURCES) {
    if (source.ats_name !== 'greenhouse' || !source.enabled) continue;
    const domain = companyDomainFor(source.company_name)?.toLowerCase();
    const token = source.board_token?.trim();
    if (!domain || !token || DEDICATED_WRAPPER_DOMAINS.has(domain)) continue;
    const tokens = claims.get(domain) ?? new Set<string>();
    tokens.add(token);
    claims.set(domain, tokens);
  }
  const resolved = new Map<string, string>();
  for (const [domain, tokens] of claims) {
    // Two companies claiming one domain means we cannot say which board a job id belongs to, and
    // the wrong board is exactly the outcome the email fallback is better than.
    if (tokens.size !== 1) continue;
    resolved.set(domain, [...tokens][0]);
  }
  return resolved;
}

const BOARD_TOKEN_BY_DOMAIN = greenhouseBoardTokensByDomain();

/** Exported for the test that keeps the derivation honest. */
export function greenhouseBoardTokenForHost(hostname: string | undefined): string | undefined {
  const host = hostname?.trim().toLowerCase().replace(/\.$/, '');
  if (!host) return undefined;
  const direct = BOARD_TOKEN_BY_DOMAIN.get(host);
  if (direct) return direct;
  // www. and careers. style labels under the employer's own verified domain, and nothing else. A
  // suffix match is safe here only because the right-hand side is a full registrable domain that
  // was proven to belong to this employer.
  for (const [domain, token] of BOARD_TOKEN_BY_DOMAIN) {
    if (host.endsWith(`.${domain}`)) return token;
  }
  return undefined;
}

/**
 * The Greenhouse job id this company page is embedding, or undefined when the page is not a board
 * we can name a token for.
 */
export function embeddedGreenhouseJobId(url: URL): string | undefined {
  if (url.protocol !== 'https:') return undefined;
  const jobIds = url.searchParams.getAll('gh_jid');
  // More than one gh_jid is not a posting page, it is a page we do not understand.
  if (jobIds.length !== 1 || !GREENHOUSE_JOB_ID.test(jobIds[0])) return undefined;
  return greenhouseBoardTokenForHost(url.hostname) ? jobIds[0] : undefined;
}

/**
 * The canonical Greenhouse application URL for an embedded board.
 *
 * Same shape canonicalMonitoredPortalUrl already produces for monitored Greenhouse jobs, which is
 * how every supported Greenhouse packet in this account is stored:
 * `https://job-boards.greenhouse.io/embed/job_app?for={board}&token={jobId}`.
 */
export function embeddedGreenhouseApplicationUrl(url: URL): string | undefined {
  const jobId = embeddedGreenhouseJobId(url);
  if (!jobId) return undefined;
  const token = greenhouseBoardTokenForHost(url.hostname);
  if (!token) return undefined;
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${jobId}`;
}
