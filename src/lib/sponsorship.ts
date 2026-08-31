/**
 * WHO WILL SPONSOR A VISA, AND HOW WE KNOW.
 *
 * A job seeker who needs sponsorship is not helped by a bigger board. Every posting they cannot
 * legally take is a wasted evening, and the ones that waste it are indistinguishable from the ones
 * that will not until they reach the last page of the form. So Litos answers the question BEFORE
 * the board is drawn: a job seeker who says at onboarding that they need sponsorship sees only
 * postings where sponsorship is CONFIRMED on our side.
 *
 * "Confirmed" is a deliberately narrow word here, and this file is where it is defined. There are
 * exactly two kinds of evidence, and they are not equal:
 *
 *   1. THE POSTING SAYS SO. The employer wrote "visa sponsorship available" (or "we sponsor H-1B")
 *      in this specific job description. Strongest evidence there is: it is about THIS role, it is
 *      current, and the employer published it.
 *
 *   2. THE EMPLOYER FILES H-1B PETITIONS. The company appears in the USCIS H-1B Employer Data Hub
 *      with approvals in a recent fiscal year. Weaker: it is about the company, not this role, and
 *      it is historical. It is still a fact, filed with the government, and it is the difference
 *      between a company that has actually sponsored people and one that never has.
 *
 * And one veto, which outranks both:
 *
 *   3. THE POSTING SAYS NO. "We are unable to sponsor visas for this position" appears on plenty of
 *      postings AT COMPANIES THAT SPONSOR HEAVILY - a US-government contract, a role in a country
 *      the company has no entity in, a team with a headcount rule. When a posting says no, the
 *      posting is right and the employer-level record is irrelevant. This is why H-1B history alone
 *      can never surface a posting that refuses.
 *
 * WHAT THIS IS NOT: legal advice, and not a promise. An employer's filing history is not an offer
 * to sponsor anyone, so every surface that shows this has to say WHICH evidence it had. That is why
 * the verdict carries `evidence` rather than a bare boolean - the UI is required to be able to
 * print the reason, and a boolean would let it claim more than we know.
 */

/** The two kinds of evidence, in the order they outrank each other. */
export type SponsorshipEvidence = 'posting_offers' | 'employer_h1b_filings';

/** What a job posting's own text says about sponsorship. `unstated` is by far the most common. */
export type PostingSponsorship = 'offers' | 'refuses' | 'unstated';

/**
 * Which jurisdiction an affirmative posting clause actually covers.
 *
 * `job_country` is the ordinary case: the posting says that visa sponsorship is available, so the
 * offer belongs to the country where that posting is located. `us_h1b` is deliberately separate.
 * H-1B is a United States visa, and a global boilerplate H-1B sentence on a Berlin posting is not
 * evidence that the employer will sponsor a German work permit.
 */
export type PostingSponsorshipScope = 'job_country' | 'us_h1b';

export type PostingSponsorshipAssessment = {
  status: PostingSponsorship;
  scope: PostingSponsorshipScope | null;
};

/**
 * A company's legal name reduced to something two datasets can agree on.
 *
 * USCIS files entity names as they appear on the petition ("AIRBNB INC", "STRIPE INC.", "MONGODB,
 * INC"), and a job board carries the brand ("Airbnb", "Stripe", "MongoDB"). Case, punctuation and
 * the entity suffix are the whole difference for most of the board, so they are what this strips.
 *
 * IT DELIBERATELY STOPS THERE. Every further "helpful" rule - dropping USA/US, collapsing
 * TECHNOLOGIES, stemming - buys a handful of extra matches and pays for them in false ones, and a
 * false match here tells someone their visa status is covered by a company that has never filed a
 * petition. Names this cannot reconcile are handled by an explicit alias in the ingest script,
 * where the human decision is visible in a diff. Ambiguity resolves to "not confirmed", which costs
 * a job seeker a posting they could have taken; the opposite costs them an application they
 * cannot.
 */
export function normalizeEmployerName(name: string): string {
  const stripped = name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  /* Only ONE trailing suffix comes off. "X HOLDINGS LLC" -> "X HOLDINGS", not "X": a holdings
     company and its operating company are different filers, and flattening them is how a match
     gets made against an entity that files nothing. */
  return stripped.replace(/ (INC|INCORPORATED|LLC|L L C|LTD|LIMITED|CORP|CORPORATION|CO|LP|LLP|PLC|GMBH|PBC)$/, '').trim();
}

/* WHAT AN EMPLOYER WRITES WHEN THEY WILL NOT SPONSOR.
 *
 * Read first, and it wins. The phrasings below were taken from live postings on the Litos board
 * (Greenhouse, Lever and Ashby, 2026-07-28) rather than invented, because the failure mode of an
 * invented pattern is silent: it matches nothing and the posting is surfaced anyway.
 *
 * The negations are written to survive the two forms every one of these appears in - "we are unable
 * to sponsor" and "we do not offer sponsorship" - and to tolerate the qualifier employers insert in
 * the middle ("unable to provide visa sponsorship for this role"). */
const REFUSES_PATTERNS: RegExp[] = [
  /\b(?:not|unable|cannot|can\s?not|won'?t|will\s+not|do(?:es)?\s+not|are\s+not)\b[^.!?\n]{0,60}\bsponsor/i,
  /\bno\b[^.!?\n]{0,30}\b(?:visa\s+)?sponsorship\b/i,
  /\bsponsorship\b[^.!?\n]{0,40}\b(?:is\s+)?(?:not\s+available|not\s+offered|not\s+provided)\b/i,
  /\bwithout\s+(?:the\s+need\s+for\s+)?(?:current\s+or\s+future\s+)?(?:visa\s+)?sponsorship\b/i,
  /\b(?:must|require[sd]?)\b[^.!?\n]{0,60}\bwithout\s+sponsorship\b/i,
];

/* WHAT AN EMPLOYER WRITES WHEN THEY WILL.
 *
 * Narrower than the refusals on purpose. A posting that merely contains the word "sponsorship" says
 * nothing - most of the time it is the sentence refusing it, which is why the refusal list runs
 * first and returns before these are ever tested. These require an affirmative verb or the explicit
 * "sponsorship available" shape. */
const OFFERS_PATTERNS: RegExp[] = [
  /\b(?:visa|h-?1-?b|immigration|work\s+authorization)\s+sponsorship\s+(?:is\s+)?(?:available|offered|provided|supported)\b/i,
  /\bwe\s+(?:do\s+)?(?:offer|provide|support|sponsor)\b[^.!?\n]{0,40}\b(?:visa|h-?1-?b|sponsorship|work\s+authorization)\b/i,
  /\b(?:willing|happy|able)\s+to\s+sponsor\b/i,
  /\bsponsorship\s+(?:is\s+)?available\b/i,
  /\bwe\s+sponsor\s+(?:visas?|h-?1-?bs?)\b/i,
  /\b(?:visa|relocation\s+and\s+visa)\s+sponsorship\s+for\s+(?:this|the)\s+role\b/i,
];

/* This is intentionally tested only on the affirmative clause that matched OFFERS_PATTERNS. A
 * posting may mention H-1B elsewhere while making a generic sponsorship offer for this role, and
 * that unrelated mention must not turn a German or Canadian offer into a US-only one. */
const H1B_VISA = /\bh\s*-?\s*1\s*-?\s*b(?:s)?\b/i;

/**
 * A person who needs employment sponsorship cannot satisfy a posting restricted to U.S. Persons.
 * Keep this source compatible with both JavaScript RegExp and PostgreSQL's case-insensitive regex
 * operator: the parser classifies new polls, while sponsorOnlyPredicate protects existing rows.
 */
export const SPONSORSHIP_BLOCKING_STATUS_PATTERN = [
  'u\\.?s\\.?\\s+person(\\s+status)?\\s+(is\\s+)?required',
  'must\\s+be\\s+(an?\\s+)?u\\.?s\\.?\\s+citizen',
  'only\\s+u\\.?s\\.?\\s+citizens?\\s+(are\\s+)?eligible',
].join('|');

const SPONSORSHIP_BLOCKING_STATUS = new RegExp(SPONSORSHIP_BLOCKING_STATUS_PATTERN, 'i');

/* "SPONSOR" IS NOT ALWAYS ABOUT A VISA, and reading it as though it were hid a company's entire
 * board.
 *
 * Measured, not imagined: run against all 7,115 live postings on 2026-07-28, the first version of
 * this file marked every single one of Cloudflare's 275 openings as refusing sponsorship. The
 * sentence responsible was about EXPORT CONTROL - "...export laws without sponsorship for an export
 * license" - and it tripped the "without sponsorship" refusal. Two more senses are everywhere in
 * job descriptions and would do the same damage given a matching verb: an executive sponsor of an
 * account, and state-sponsored threat actors in every security posting.
 *
 * So a sentence carrying one of these senses is not read at all. Dropping the sentence rather than
 * the whole posting matters: a security role at a company that also states a real visa policy still
 * gets that policy read. */
const NON_IMMIGRATION_SENSE =
  /\b(?:export\s+(?:licen[cs]e|control|laws?)|executive\s+sponsor|state[-\s]sponsored|nation[-\s]state|sponsored\s+(?:advanced\s+persistent|content|ads?|posts?|research|links?)|event\s+sponsorship|sponsor\s+(?:a\s+)?(?:table|booth|conference|event))\b/i;

/**
 * What THIS posting says about sponsorship.
 *
 * Read SENTENCE BY SENTENCE, for two independent reasons. It is what lets a sentence in the wrong
 * sense be skipped without discarding the posting (see NON_IMMIGRATION_SENSE), and it stops a
 * refusal pattern from spanning a full stop - "We cannot guarantee a start date. Sponsorship is
 * available." is two statements, and matching across them inverts the second one.
 *
 * Refusal is read first and wins outright. That order is the whole safety property: postings
 * routinely contain both sentences ("Sponsorship is available for most roles. We are unable to
 * sponsor for this one"), and reading the positive first would surface exactly the posting the
 * negative sentence exists to keep away. It is deliberately conservative at the margin: Anthropic's
 * "We do sponsor visas! However, we aren't able to successfully sponsor visas for every role"
 * reads as a refusal here, which costs six postings out of four hundred and is the right way round
 * to be wrong.
 */
export function readPostingSponsorshipAssessment(
  description: string | null | undefined,
): PostingSponsorshipAssessment {
  if (!description) return { status: 'unstated', scope: null };
  /* Postings are unbounded text and these are backtracking regexes. Capped for the same reason
     scoring is (SCORING_CHARS in routes/jobMonitor.ts): the statement, when it exists, is in the
     requirements or the legal block, never past 20k characters of one posting. */
  const text = description.slice(0, 20_000);
  /* Check before sentence splitting because the full stop in "U.S." is punctuation, not the end
     of the requirement. Splitting first would separate "U.S." from "Person status is required". */
  if (SPONSORSHIP_BLOCKING_STATUS.test(text)) return { status: 'refuses', scope: null };
  /* Only sentences that mention sponsorship at all are worth splitting hairs over, and the split is
     on sentence enders plus newlines - postings are half prose and half bullet list, and a bullet
     ends with a line break far more often than a full stop. */
  const sentences = text
    .split(/(?<=[.!?])\s+|[\n\r]+|(?:<\/(?:p|li|div|h[1-6])>)/i)
    .filter((sentence) => /sponsor/i.test(sentence) && !NON_IMMIGRATION_SENSE.test(sentence));
  if (sentences.length === 0) return { status: 'unstated', scope: null };
  if (sentences.some((sentence) => REFUSES_PATTERNS.some((pattern) => pattern.test(sentence)))) {
    return { status: 'refuses', scope: null };
  }
  const offerSentences = sentences.filter(
    (sentence) => OFFERS_PATTERNS.some((pattern) => pattern.test(sentence)),
  );
  if (offerSentences.length === 0) return { status: 'unstated', scope: null };

  /* A generic affirmative clause applies to the posting's country. Only an offer made exclusively
     in H-1B terms is US-only. This preserves a separate generic offer if a description also has an
     H-1B-specific clause. */
  const scope: PostingSponsorshipScope = offerSentences.every((sentence) => H1B_VISA.test(sentence))
    ? 'us_h1b'
    : 'job_country';
  return { status: 'offers', scope };
}

/** Backward-compatible status-only view used by callers that do not persist evidence details. */
export function readPostingSponsorship(description: string | null | undefined): PostingSponsorship {
  return readPostingSponsorshipAssessment(description).status;
}

/**
 * May this posting be shown to someone who needs sponsorship, and on what grounds?
 *
 * The whole rule, in one place, so the board query and the tests cannot drift from each other:
 *   refuses            -> never, whatever the employer's filing history says
 *   offers             -> yes, on the posting's own words
 *   employer files H-1B-> yes, on the filing record
 *   otherwise          -> no. Silence is not consent, and an unstated posting at a company with no
 *                         filings is precisely the wasted evening this feature exists to prevent.
 */
export function sponsorshipVerdict(input: {
  posting: PostingSponsorship;
  employerFilesH1b: boolean;
  postingScope?: PostingSponsorshipScope | null;
  jobCountry?: 'us' | 'non_us' | 'unknown' | null;
}): { surfaced: boolean; evidence: SponsorshipEvidence | null } {
  if (input.posting === 'refuses') return { surfaced: false, evidence: null };
  if (input.posting === 'offers') {
    /* A persisted H-1B clause is evidence for US roles only. Unknown remains eligible because the
       posting may be remote in the US; a location positively identified as foreign does not. */
    if (input.postingScope === 'us_h1b' && input.jobCountry === 'non_us') {
      return { surfaced: false, evidence: null };
    }
    return { surfaced: true, evidence: 'posting_offers' };
  }
  if (input.employerFilesH1b) return { surfaced: true, evidence: 'employer_h1b_filings' };
  return { surfaced: false, evidence: null };
}

/**
 * Is this account's board restricted to employers who sponsor?
 *
 * ONE-WAY BY DESIGN, and this is the rule Mehek set (2026-07-28): a declaration made during
 * onboarding is permanent. If someone said at the start that they need sponsorship - now or in the
 * future - their board stays filtered whether or not they ever say it again, and the settings
 * toggle cannot turn it off. It can only ever turn it ON for someone who did not declare then.
 *
 * The reason it is not a plain editable preference: the cost of the two mistakes is wildly
 * asymmetric. A filter left on too long shows someone fewer jobs than they could take. A filter
 * turned off by a stray click - or by a "clear all preferences" they clicked for another reason -
 * puts them back in front of postings that will reject them at the last question, and they will not
 * know why. Someone whose status genuinely changes has a way out that leaves a record: support, or
 * a new account. A checkbox is not that.
 */
export function sponsorOnlyBoardRequired(account: {
  declaredAtOnboarding: boolean | null | undefined;
  settingEnabled: boolean | null | undefined;
}): boolean {
  return account.declaredAtOnboarding === true || account.settingEnabled === true;
}

/**
 * The onboarding answer, reduced to the one bit the board needs.
 *
 * Three of the four answers mean "filter the board", and lumping them together is the point:
 * "I need sponsorship now", "I will need it later" (an F-1 student on OPT, whose need is a
 * certainty with a date on it) and "I am not authorized to work here yet" all end at the same
 * place, a posting that will not sponsor is a dead end. Only an unambiguous "no" leaves the board
 * whole.
 */
export type SponsorshipAnswer = 'needs_now' | 'needs_future' | 'not_authorized' | 'no';

export function answerRequiresSponsorship(answer: SponsorshipAnswer): boolean {
  return answer !== 'no';
}
