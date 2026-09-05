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

/* THE BOARD BY NAME, WHEN THE LIST OFFERS NEITHER A GENERIC BOARD NOR "OTHER".
 *
 * Reached only after genericJobBoardOption and otherReferralOption have BOTH missed, which is a
 * narrower place than it sounds. genericJobBoardOption refuses a qualified board on purpose - a
 * "University job board" is a different claim - and "Other" is the escape hatch that refusal
 * assumes exists. On lists that offer no escape hatch the refusal had nowhere to fall, so the
 * question came back "left for you" and held an otherwise complete application.
 *
 * MEASURED, Databricks Greenhouse, 2026-08-26. The seven options are "LinkedIn Job Posting",
 * "Recruiter Reach Out", "BrickFest", "School Career Fair and/or Event", "Referral from Employee",
 * "Referral from Intern", "I am a previous Databricks intern". There is no generic board entry and
 * no "Other", so the ladder returned null and a filled, audited packet parked on one radio button.
 * Six of those seven are claims she cannot make; the seventh states the fact.
 *
 * Her rule, stated 2026-08-26: when the list has no "Other", the fallback is always the job board.
 * This RELAYS that declaration rather than generating one, which is the same footing the stored
 * "Job board" default already stands on.
 *
 * THE EXCLUSIONS ARE THE SAFETY. A referral routes the application to a named employee and can pay
 * that employee a bonus; a recruiter reach-out says someone contacted her; a career fair, a school
 * and a prior internship each assert a relationship that did not happen. None of those is a board
 * she read a posting on, so none is reachable here whatever else the entry says - including when
 * the board's own name sits in the same string ("LinkedIn Recruiter reached out").
 *
 * Handshake and university boards are deliberately absent from the board list: both assert she came
 * through USC's careers channel. Ambiguity abstains - two boards named, or none, returns undefined
 * and the question goes back to her, which is the honest outcome.
 */
const NAMES_A_PUBLIC_BOARD =
  /\b(?:linkedin|indeed|glassdoor|ziprecruiter|monster|dice|built\s*in|wellfound|angellist|simplify|otta|jobright|hiring\s*cafe)\b/i;
const NOT_A_BOARD_CHANNEL =
  /\b(?:referr\w*|employee|intern\b|interned|recruit\w*|reach(?:ed)?\s*out|contacted|sourced|fair|conference|event|meetup|hackathon|school|college|universit\w*|campus|alumni|student|professor|faculty|advisor|friend|family|colleague|word\s+of\s+mouth|previous|former|current)\b/i;

/**
 * The one option naming a public job board, or undefined.
 *
 * Only consulted once the generic wording and "Other" are both absent from the employer's list.
 */
export function namedJobBoardOption(options: readonly string[]): string | undefined {
  const named = options
    .map((option) => option.trim())
    .filter((option) => option && NAMES_A_PUBLIC_BOARD.test(option) && !NOT_A_BOARD_CHANNEL.test(option));
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
 * The label shape this whole family answers to - "how did you hear about X", "how did you FIRST
 * hear about X", "how did you find this posting", "where did you hear of this opportunity", "where
 * have you learned about X", "referral source", "source of your application" - with no need to
 * validate an employer's name against a job description.
 *
 * CANONICAL AND SHARED ON PURPOSE. Before this, portalSubmission.ts's own isReferralSourceQuestion
 * and submissionRunner.ts's REFERRAL_SOURCE_CHOICE_QUESTION were two hand-maintained copies of the
 * same idea, and they had already drifted from each other: the submissionRunner copy had no
 * `hear\s+about` alternative, so "How did you FIRST hear about Five Rings?" - the exact prefix
 * GREENHOUSE_REFERRAL_LABEL_PREFIXES already treats as a referral field at fill time - matched the
 * fill-time alias pass and missed the closed-choice "Other" fallback that is supposed to run before
 * it. Measured 2026-09-05, account mehekmandal05@gmail.com, Five Rings packet 2231fc73: her standing
 * "Job board" default sat unmatched forever on a control offering Coffee Chat / Conference / GitHub /
 * Handshake / LinkedIn / Student Organization Newsletter or Event / University Career Fair /
 * Networking Event / Word of Mouth / Information Session / Other, and the fill reported
 * `no option matched "Job board"` on a required control even though "Other" was right there.
 *
 * This first consolidation itself dropped coverage the submissionRunner copy had carried: bare
 * "how did you find this job posting?" and bare "where did you hear of this opportunity?" (no
 * "about"), both of which the old REFERRAL_SOURCE_CHOICE_QUESTION regex matched and the merged
 * predicate did not. HEAR_FRAME below is the union of every phrasing either retired regex carried,
 * so the three pipelines cannot silently narrow again.
 *
 * The bare `hear\s+about` and bare `source` alternatives that consolidation carried forward were
 * themselves too wide: `hear\s+about` alone matches 'how did you hear about our privacy policy?',
 * and bare `source` alone matches 'what is the source of your funding?' - neither is a referral
 * question, and this predicate now also gates snapStoredAnswersToProfileFieldOptions
 * (questionMetadata.ts), which runs on every dashboard poll, so a false positive here is not free.
 * HEAR_FRAME requires a how/where/what-led/who-told frame around "hear"/"find"/"learn" instead of a
 * bare substring, NOT_REFERRAL_HEAR_TOPIC excludes the small set of non-referral topics that still
 * complete that frame (a privacy policy, terms, funding), and SOURCE_PHRASE narrows the bare
 * "source" alternative to "referral source", "source of (this/the/your) application/referral/lead",
 * and "how did you ... source" - not a standalone word that also means "the origin of your
 * paycheck" or "your revenue".
 *
 * Deliberately NOT the employer-name-validated test questionDiscovery.ts's parseReferralQuestion
 * performs (via classifyField / profileFieldIntent). That check exists to stop an unrelated label
 * from being answered as a referral question at all, and it needs a job description to validate
 * against - a resource a caller judging one already-classified, already-stored row rarely has. This
 * predicate answers a narrower, safer question that needs no such resource: "does this label have
 * the SHAPE of a referral-source question", which is exactly what a caller holding a stored answer
 * and a real option list - and nothing else - can honestly ask.
 */
const HEAR_FRAME =
  /\b(?:how\s+(?:did|do)\s+you\s+(?:first\s+)?(?:hear|find)|where\s+(?:did|have)\s+you\s+(?:first\s+)?(?:heard|hear|learn(?:ed)?)|what\s+led\s+you\s+to\s+(?:hear|learn|find)|who\s+told\s+you\s+(?:that\s+)?you)\b/i;
const NOT_REFERRAL_HEAR_TOPIC =
  /\babout\s+(?:our\s+|the\s+|this\s+|your\s+)?(?:privacy\s+polic(?:y|ies)|terms(?:\s+(?:of\s+service|and\s+conditions))?|cookie\s+polic(?:y|ies)|refund\s+polic(?:y|ies)|return\s+polic(?:y|ies)|funding)\b/i;
const SOURCE_PHRASE =
  /\breferral\s+source\b|\bsource\s+of\s+(?:this\s+|the\s+|your\s+)?(?:application|referral|lead)\b|\bhow\s+did\s+you\b[^?]{0,40}\bsource\b/i;

export function isReferralSourceQuestionLabel(label: string): boolean {
  if (NOT_REFERRAL_HEAR_TOPIC.test(label)) return false;
  return HEAR_FRAME.test(label) || SOURCE_PHRASE.test(label);
}

/**
 * The one closed-list option that answers a job-board referral claim, once the ordinary alias
 * wordings have already missed against the control's REAL options.
 *
 * Order is deliberate and shared verbatim by every caller that owns a real option list -
 * resolveProfileField (profileFieldResolution.ts) at discovery and refresh, truthfulOtherChoice
 * (submissionRunner.ts) in the fill-time fallback, and snapStoredAnswersToProfileFieldOptions
 * (questionMetadata.ts) on every later audit read - so the three pipelines cannot silently diverge
 * on what "Job board" resolves to once the plain wordings run out. A generic board entry says the
 * most (genericJobBoardOption) and wins when the list actually offers one; "Other" is the truthful
 * fallback (otherReferralOption) once it does not; a named public board is the last resort on a list
 * that offers neither (namedJobBoardOption). Undefined when the claim itself is not job-board-shaped,
 * or when none of the three rungs finds anything - which leaves the question exactly where it was,
 * for her.
 *
 * Scoped to the job-board claim only, never the company-site one: employerOwnSiteOption is only
 * safe to reach once real per-application EVIDENCE has been checked (see referralSourceForApplication
 * and resolveProfileField's own guard), which a caller holding just a label, an answer and an option
 * list cannot verify. Every caller of this function judges exactly that narrower shape, so widening
 * it to the company-site rung here would apply that ladder without the evidence check it depends on.
 */
export function jobBoardClosedListOption(
  claim: string | undefined,
  options: readonly string[],
): string | undefined {
  if (!isJobBoardReferralClaim(claim)) return undefined;
  return genericJobBoardOption(options) ?? otherReferralOption(options) ?? namedJobBoardOption(options);
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
