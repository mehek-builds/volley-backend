export type ReferralSourceEvidence = {
  kind: 'litos_job_board' | 'employer_career_site';
  value: 'Job board' | 'Company website';
  jobId: string;
  sourceId: string;
  sourceUrl: string;
  observedAt: string;
};

const COMPANY_SITE_CLAIM = /^(?:company\s+)?(?:careers?(?:\s+(?:page|site|website))?|web\s*site|website)$/i;
const JOB_BOARD_CLAIM = /^(?:online\s+)?job\s*board$/i;

export function isCompanySiteReferralClaim(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && COMPANY_SITE_CLAIM.test(trimmed));
}

export function isJobBoardReferralClaim(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return Boolean(trimmed && JOB_BOARD_CLAIM.test(trimmed));
}

/**
 * Closed-list values that state the same acquisition fact as this packet's evidenced source.
 * No generic fallback is included because managed select actions are replayed in order and a
 * later fallback can replace an earlier truthful choice.
 */
export function referralSourceOptionCandidates(
  value: string | null | undefined,
  evidence?: ReferralSourceEvidence,
): string[] {
  const resolved = referralSourceForApplication(value, evidence);
  if (!resolved) return [];
  if (isJobBoardReferralClaim(resolved)) {
    if (evidence?.kind !== 'litos_job_board' || evidence.value !== 'Job board') return [];
    /* THE SPELLINGS EMPLOYERS ACTUALLY USE, and nothing that changes the claim.
     *
     * MEASURED. "Job board" came back `no option matched` on Old Mission's form on 2026-08-13 with
     * the stored answer sitting right there, because three spellings is not a ladder. Every entry
     * below states the SAME acquisition fact - she found the posting on a job board - in the
     * wording a different employer happens to print.
     *
     * WHAT IS DELIBERATELY ABSENT, and it is the more important half: no named third party.
     * "LinkedIn", "Indeed", "Handshake", "Glassdoor" and "University career fair" are all sitting
     * on these same option lists and would all clear a required field, and every one of them is a
     * DIFFERENT statement about where she found the role. Naming a site she did not use is not a
     * spelling variant of the truth, it is a new claim, and the note further down this file about
     * third-party entries applies to this list exactly as it does to that one.
     *
     * Nothing here says "website" or "career" either, and that is enforced by an existing test:
     * those words belong to the employer's-own-site claim, which is the neighbouring branch and a
     * different fact. A bare "Online" is out for the same reason - it is not a spelling of "job
     * board", it is a vaguer claim that happens to be easier to satisfy. */
    return [
      'Job board',
      'Job Board',
      'Job boards',
      'Job Boards',
      'Online job board',
      'Online Job Board',
      'Online job boards',
      'Internet job board',
      'Job site',
      'Job Site',
      'Job posting',
      'Job Posting',
      'Online job posting',
      'Online job search',
    ];
  }
  if (isCompanySiteReferralClaim(resolved)) {
    if (evidence?.kind !== 'employer_career_site' || evidence.value !== 'Company website') return [];
    return [
      'Company website',
      'Company Website',
      'Company Careers Site',
      'Careers Page',
      'Career Site',
      'Careers Website',
    ];
  }
  return [resolved];
}

/* THE EMPLOYER'S OWN SITE, UNDER THE EMPLOYER'S OWN NAME FOR IT.
 *
 * MEASURED. "Company website" came back as `no option matched` on fourteen prod packets across six
 * employers on 2026-08-09, and it is the second most repeated failure in the corpus. Read off the
 * live forms, the option that states exactly that fact is on most of those lists and simply is not
 * spelled "Company website":
 *
 *   Anduril      "Anduril Website"          Virtu     "Virtu Careers Site"
 *   DV Trading   "DV Website"               DRW       "DRW Careers Page"
 *   Roblox       "Roblox Careers Site"      Faire     "Faire's website"
 *
 * The ladder above cannot reach any of them, because every one is written with the employer's own
 * name in it and this module is forbidden to know an employer's name. It does not need to. The
 * list itself says which entry is the employer's own site: it is the one naming a site, a website
 * or a careers page while naming nobody else.
 *
 * The exclusions are the whole safety of it, and one of them is measured rather than imagined.
 * Cloudflare's list carries "College/University Career Fair or Career Website", which is a website
 * and is emphatically not Cloudflare's; picking it would tell an employer she came through her
 * university when she did not. So an entry that names a third party - a school, a job board, a
 * social network, a person, an event - is not the employer's own site whatever else it says. When
 * that leaves nothing, or leaves more than one, this returns undefined and the question goes back
 * to her: Cloudflare and Five Rings genuinely have no company-website entry, and a blank there is
 * the honest outcome.
 */
const NAMES_A_SITE =
  /\bweb\s*sites?\b|\bcareers?\s+(?:site|page|portal|website)\b|\b(?:site|page|portal)\s+(?:of|for)\b/i;
const NAMES_SOMEONE_ELSE =
  /\b(?:college|university|universities|school|campus|alumni|student|career\s+fair|job\s+fair|fair|conference|event|newsletter|blog|podcast|news|social\s+media|advertis\w*|referr\w*|employee|intern\b|friend|family|colleague|recruiter|recruitment\s+agency|agency|word\s+of\s+mouth|linkedin|indeed|glassdoor|handshake|monster|ziprecruiter|builtin|simplify|fairygodboss|piazza|google|bing|facebook|instagram|twitter|youtube|tiktok|reddit|github|job\s*board|job\s+posting|job\s+search|other)\b/i;

/**
 * The one option that states "I found this on the employer's own website", or undefined.
 *
 * Only ever consulted for an application whose evidenced source IS the employer's career site, so
 * this identifies a fact already established rather than choosing one.
 */
export function employerOwnSiteOption(options: readonly string[]): string | undefined {
  const named = options
    .map((option) => option.trim())
    .filter((option) => option && NAMES_A_SITE.test(option) && !NAMES_SOMEONE_ELSE.test(option));
  return named.length === 1 ? named[0] : undefined;
}

/** Resolve a durable default against evidence for this one application. */
export function referralSourceForApplication(
  stored: string | null | undefined,
  evidence?: ReferralSourceEvidence,
): string | undefined {
  if (evidence) {
    if (evidence.kind === 'litos_job_board' && evidence.value === 'Job board') return evidence.value;
    if (evidence.kind === 'employer_career_site' && evidence.value === 'Company website') return evidence.value;
    return undefined;
  }
  const trimmed = stored?.trim();
  if (!trimmed || isCompanySiteReferralClaim(trimmed)) return undefined;
  return trimmed;
}
