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
    /* THE STORED DEFAULT IS ITSELF THE DECLARATION, and requiring per-packet evidence on top of it
     * is what made it unusable.
     *
     * This used to return [] unless the packet carried `litos_job_board` evidence. Almost no packet
     * does, so an applicant with `referral_source_default: "Job board"` on file had that answer
     * discarded before any option was compared, and the question came back as "left for you" on
     * form after form. Measured 2026-08-16: "how did you hear about us" was the single largest
     * blocker on the owner's queue.
     *
     * She has since declared the rule outright - this question is answered "Job board" every time -
     * and a stored default is exactly the shape selfDeclaration.ts permits: Litos RELAYS a
     * declaration she has made and never GENERATES one. The evidence gate stays meaningful in the
     * other direction, because referralSourceForApplication still lets evidence override the stored
     * value; what it no longer does is veto her own standing answer.
     *
     * The aliases are the spellings employers actually use, read off live boards. They stay narrow
     * and GENERIC on purpose: a qualified board like "University job board" is a different claim,
     * and genericJobBoardOption below is what refuses it. */
    return [
      'Job board',
      'Job Board',
      'Job boards',
      'Online job board',
      'Online Job Board',
      'Job site',
      'Job search site',
      'Job posting site',
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

/* THE JOB BOARD ENTRY, UNDER THE BOARD'S OWN WORDING, AND THE ONE THAT MUST NOT BE PICKED.
 *
 * Same shape as employerOwnSiteOption above and for the same reason: the ladder cannot enumerate
 * every spelling, but the list itself says which entry states the fact.
 *
 * MEASURED, live and read-only, on Jane Street 2026-08-16. Its 128-entry list has no plain
 * "Job board" at all. The nearest entry is "University job board", and picking that would tell an
 * employer she came through USC's careers board when she did not. That is the whole reason this is
 * a predicate with exclusions rather than a fuzzy match: a QUALIFIED board is a different claim
 * about how she found the role, and the qualifier is usually the only word that distinguishes them.
 *
 * So an entry naming a specific board, a school, a person, an event or a social network is not the
 * generic job-board entry whatever else it says. When that leaves nothing, or leaves more than one,
 * this returns undefined and the caller falls through to "Other", which is honest and answerable.
 */
const NAMES_A_JOB_BOARD = /\bjob\s*(?:board|site|posting\s+site|search\s+site)s?\b/i;
const NAMES_A_PARTICULAR_BOARD =
  /\b(?:college|university|universities|school|campus|alumni|student|career\s+fair|job\s+fair|fair|conference|event|newsletter|blog|podcast|professor|faculty|advisor|friend|family|colleague|employee|recruiter|agency|word\s+of\s+mouth|linkedin|indeed|glassdoor|handshake|monster|ziprecruiter|builtin|wellfound|angellist|dice|simplify|fairygodboss|piazza|google|bing|facebook|instagram|twitter|youtube|tiktok|reddit|github|company|our)\b/i;

/** The one option that states "a job board", generically, or undefined. */
export function genericJobBoardOption(options: readonly string[]): string | undefined {
  const named = options
    .map((option) => option.trim())
    .filter((option) => option && NAMES_A_JOB_BOARD.test(option) && !NAMES_A_PARTICULAR_BOARD.test(option));
  return named.length === 1 ? named[0] : undefined;
}

/* "OTHER", AND WHY IT IS A TRUTHFUL LAST RESORT RATHER THAN A SHRUG.
 *
 * Reached only once the list has been searched for her actual answer and does not offer it. On a
 * list like Jane Street's, "Other" is the only entry that does not misstate how she found the role,
 * and leaving the question blank holds a complete application over a question she HAS answered.
 *
 * It is deliberately last. An entry that says "job board" is always preferred, because it says more.
 */
const IS_OTHER_OPTION = /^(?:other|other\s*[:(-].*|others|other\s+\(please\s+specify\)|none\s+of\s+the\s+above)$/i;

export function otherReferralOption(options: readonly string[]): string | undefined {
  return options.map((option) => option.trim()).find((option) => option && IS_OTHER_OPTION.test(option));
}

/**
 * What goes in the free-text box that an "Other" choice reveals, when the form has one.
 *
 * Her declaration, in her words: choose Other, then say Litos. It is also simply true - Litos is
 * the job board this application came through - which is why it is safe to state rather than hold.
 */
export const REFERRAL_OTHER_DETAIL = 'Litos';

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
