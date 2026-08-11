/**
 * Requirement CLAUSES, not requirement tokens.
 *
 * WHY THIS EXISTS. jdMatch.ts scores a resume against extracted TERMS: named technologies,
 * acronyms, product names. Measured 2026-08-04 over 600 live postings, that model cannot see
 * 65.4% of the requirement clauses employers actually state - 5,113 of 7,819. The invisible ones
 * are not noise. They are:
 *
 *   "5+ years with network security products, 4+ years specifically with Fortinet"
 *   "You have served as the technical lead for a team of engineers"
 *   "Strong written and verbal communication skills"
 *   "Must be authorized to work in the United States"
 *   "Comfort working in a regulated, high-stakes financial environment"
 *
 * THE BIAS RUNS ONE WAY, which is what makes it worse than noise. A student's named-technology
 * gaps are token-shaped and therefore visible; the requirements they MEET - a degree in the right
 * field, analysis, communication, leading a team - are prose-shaped and therefore invisible. So the
 * denominator systematically keeps the misses and drops the hits.
 *
 * Databricks' "Product Management Intern (Summer 2027)" states eight requirements. The term model
 * reduces them to three tokens (`ai`, `python`, `sql`), scores 1 of 4 with a metaphor (`rails`)
 * making up the fourth, and returns 27. A reader of the posting would count the degree requirement,
 * the analytical requirement and the communication requirement as met, and land near twice that.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not guess. Every clause resolves to MET, UNMET or
 * UNSCOREABLE, and UNSCOREABLE clauses leave the denominator entirely rather than counting against
 * anyone. "You stay curious and keep learning" is not a test a resume can pass or fail, and a
 * scorer that quietly counted it as a miss would be manufacturing a gap.
 *
 * Three ways a clause can be MET, in descending order of how literal the evidence is:
 *
 *   1. TERMS. The clause names technologies and the resume contains them. Delegates to the existing
 *      literal matcher. "and/or" is honoured: "SQL and/or Python" is met by either.
 *   2. STRUCTURED FACTS. The clause states a degree level, a field, a graduation window, an
 *      enrollment status or a years-of-experience floor, and the candidate's PARSED PROFILE answers
 *      it. This is the class the term model could never reach, because the answer was never in the
 *      resume's prose - it is in a field.
 *   3. COMPETENCY CUES. The clause asks for communication, analysis, leadership, collaboration or
 *      ownership, and the resume shows the student DOING that thing. Enumerated cues, never a
 *      synonym table over skills: the cue list is about verbs a resume bullet uses, and every match
 *      names the bullet it came from so a student can see why it counted.
 */

import { extractJdTerms, resumeCovers, type JdContext, type JdTerm } from './jdMatch';

/** What we know about the candidate as FACTS rather than as prose. */
export interface CandidateFacts {
  /** Verbatim, e.g. "Bachelor of Science in Computer Science and Business Administration". */
  degree?: string | null;
  school?: string | null;
  /** Verbatim, e.g. "May 2027". */
  gradDate?: string | null;
  /** Every word the resume puts on the page, same text the term matcher scores. */
  resumeText: string;
  /**
   * The experience bullets on their own.
   *
   * Competency cues are read from HERE and not from resumeText, because resumeText carries the
   * education header too and "Viterbi School of Engineering" then answers "work with engineers".
   * A competency is a thing the student DID, so the evidence has to come from the part of the
   * document where they say what they did.
   */
  bullets?: string[];
  /** Total months across dated experience entries, when they can be parsed. */
  monthsOfExperience?: number | null;
  /** Total months across entries explicitly typed as jobs. */
  monthsOfProfessionalExperience?: number | null;
  /** Frozen structured enrollment fact. Undefined means it was not captured. */
  currentlyEnrolled?: boolean | null;
  /** Exact saved bullet proving a project or internship track record, when one exists. */
  projectOrInternshipEvidence?: string | null;
  /** Frozen applicant declaration for routine office-attendance questions. */
  onsiteCommitment?: 'anywhere' | 'listed_locations' | 'no' | null;
  /** Exact frozen locations that bound a listed-locations declaration. */
  onsiteLocations?: string[] | null;
}

export type ClauseVerdict = 'met' | 'unmet' | 'unscoreable' | 'pending';

export interface RequirementClause {
  /** The employer's sentence, verbatim, trimmed of bullet decoration. */
  text: string;
  /** required 1, preferred 0.6, responsibilities 0.7 - the section weights jdMatch already uses. */
  weight: number;
  verdict: ClauseVerdict;
  /** Which rule decided it, so the student can be shown why. */
  basis: 'terms' | 'degree' | 'graduation' | 'experience-years' | 'project-evidence' | 'onsite-commitment' | 'availability' | 'competency' | 'none';
  /** Plain-English evidence, quoting the candidate's own words wherever possible. */
  evidence?: string;
  /** For a terms clause, what is still missing. */
  missingTerms?: string[];
}

/* ---------- clause splitting ---------- */

/**
 * A clause is one stated line. Employers write requirements as bullets or as one-per-line prose,
 * and both survive HTML stripping as lines; sentences INSIDE a line are not split, because
 * "You can make complex topics simple and communicate nuance to partners (engineers, customers,
 * field) in both written and verbal form" is one requirement containing three commas and a
 * parenthetical, and splitting it would triple-count a single ask.
 */
export function splitClauses(sectionText: string): string[] {
  return sectionText
    .split('\n')
    .map((line) => line.trim().replace(/^[-*•·]\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
    // Four words is the floor for a requirement rather than a fragment or a stray heading word.
    .filter((line) => line.split(/\s+/).filter(Boolean).length >= 4);
}

/* ---------- 4. unscoreable ---------- */

/**
 * Clauses no resume can answer, dropped from the denominator entirely.
 *
 * These are dispositions, not qualifications. A student cannot evidence "stays curious" and an
 * employer cannot check it from a PDF; it is written to describe a culture, not to filter. Counting
 * it as a miss invents a gap, and counting it as met would credit everyone equally, which is the
 * same as not counting it. So it leaves.
 */
const UNSCOREABLE = [
  /\b(curious|curiosity|passion(ate)?|enthusias|excited|motivated|self[- ]starter|growth mindset)\b/i,
  /\b(thrive|comfortable with ambiguity|fast[- ]paced|bias for action|scrappy|humble|low ego)\b/i,
  /\b(team player|culture|values|fun|energy)\b/i,
  /\bhungry to ship code into production\b/i,
  /\brather ship one thing a customer touches than polish\b/i,
];

/* ---------- 2. structured facts ---------- */

const DEGREE_CLAUSE = /\b(bachelor|bachelors|ba|bs|b\.s|master|masters|ms|m\.s|phd|doctorate|degree|undergrad|undergraduate|enrolled|pursuing|currently studying)\b/i;

/** Fields named often enough to be worth checking literally. Never inferred from one another. */
const FIELD_SYNONYMS: Record<string, RegExp> = {
  'computer science': /\b(computer science|cs)\b/i,
  'data science': /\bdata science\b/i,
  engineering: /\bengineering\b/i,
  business: /\b(business|business administration|commerce)\b/i,
  economics: /\beconomics\b/i,
  mathematics: /\b(mathematics|math|statistics)\b/i,
  finance: /\bfinance\b/i,
  design: /\b(design|hci)\b/i,
  law: /\b(law|juris)\b/i,
};

/**
 * The same fields as above, spelled the way extractJdTerms KEYS them, for the routing exclusion in
 * matchClause step 1. See the long note there for why this exists at all.
 *
 * TWO LISTS AND NOT ONE, because the two answer different questions. FIELD_SYNONYMS is matched
 * against the CLAUSE and is deliberately loose - `/\bengineering\b/` has to reach "electrical
 * engineering", "a degree in engineering" and "engineering or a related field" alike. This is
 * matched against a single extracted TERM and has to be exact, or the loose form would also drop
 * `data engineering` and `signal processing` out of a clause that meant them as skills.
 *
 * Every entry here is a PHRASE_LEXICON entry that names a course of study. `statistics` and
 * `mathematics` are NOT here: `statistics` is a SKILL_LEXICON unigram and has always been signal, so
 * "Bachelor's in statistics" has always routed to the terms branch, and changing that today would be
 * an unrelated behaviour change smuggled in under a fix.
 */
const DEGREE_FIELDS = new Set([
  'computer science',
  'cs',
  'computer engineering',
  'electrical engineering',
  'data science',
  'data engineering',
]);

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';

/** A point in academic time. Spring/H1 sorts before Fall/H2, so ordering is comparison. */
type GradPoint = { year: number; half: 1 | 2 };
/** A closed span. A stated term is a span of one; a bare year is a span of two. */
type GradSpan = { from: GradPoint; to: GradPoint };

const ordinal = (p: GradPoint) => p.year * 2 + p.half;
/* GRADUATION IS JUDGED, NOT PARSED.
 *
 * Six review rounds killed five regex designs here, and the sixth found seven independent leaks in
 * the fifth: a disqualifier only checked on one side of the date, a cue reaching across a sentence
 * boundary, propagation chaining through commas into unrelated years, two separate requirements
 * collapsing into one hull window, and no handling of polarity at all - "not graduating before
 * 2027" read as a closed range and inverted.
 *
 * That is not a parser with bugs in it. A graduation requirement carries direction ("by", "no
 * later than", "or later"), alternatives in one breath ("Fall 2027 or Spring 2028"), scope (which
 * cue governs which of three years), and disqualifying context in both directions (a requisition
 * number, a funding round, a cohort year). Deciding which number in a sentence is the graduation
 * date, and which way the requirement points, is reading comprehension.
 *
 * So it goes to the judge, under the same contract every competency clause has: the model may
 * select and reason, never invent, and a "met" verdict is discarded unless it quotes the fact it
 * relied on verbatim. The difference is the corpus. A competency grounds in the resume BULLETS; an
 * eligibility clause grounds in the student's structured FACTS, because that is the only place the
 * answer lives and no bullet can carry it. See llm/competencyJudge.ts. */
const GRADUATION_CUE = /\b(graduat|class of|degree conferred|conferral|completing|expected to complete|anticipated)/i;
const YEAR = /\b(19|20)\d{2}\b/;
/* YEAR STANDING IS TIMING, and it was escaping because it names no year and no graduation.
   "Rising senior", "current sophomore" and "final-year students only" are eligibility windows
   stated in the other unit, and every one of them was being decided locally as MET: the clause hit
   DEGREE_CLAUSE, found no field to disagree with, and passed. A sophomore matched a senior-only
   posting. */
const YEAR_STANDING = /\b(freshman|sophomore|junior|senior|rising|penultimate|final[- ]year|first[- ]year|second[- ]year|third[- ]year|fourth[- ]year|underclass|upperclass)\b/i;
/* Relative timing carries no digit either. "Must graduate next spring" and "within the next twelve
   months" are windows; resolving them needs today's date and the student's, which is reading. */
const RELATIVE_TIMING = /\b(next (spring|fall|autumn|summer|winter|year|term|semester)|this (spring|fall|autumn|summer|winter|year)|within the next|by the (start|end) of|before (the )?(start|end)|upcoming)\b/i;

/** Does this degree clause turn on WHEN, not just WHAT. Those are the ones the judge must read. */
export function statesTiming(clause: string): boolean {
  return (
    GRADUATION_CUE.test(clause) ||
    YEAR.test(clause) ||
    YEAR_STANDING.test(clause) ||
    RELATIVE_TIMING.test(clause)
  );
}

const YEARS_CLAUSE = /(\d+)\s*\+?\s*(?:or more\s*)?years?\b/i;

type TermCoverageDecision = {
  decidable: boolean;
  met: boolean;
  covered: JdTerm[];
  missing: JdTerm[];
};

const ALTERNATIVE_LANGUAGE = /\b(?:Go|PHP|Java|Python|TypeScript|JavaScript|Rust|Kotlin|Swift)\b|C\+\+|C#/g;

function addValidatedAlternativeLanguageTerms(text: string, terms: JdTerm[], weight: number): void {
  if (!/\b(?:languages?|programming|fluent|proficien|experience|development|using|with)\b/i.test(text)) return;
  const languages = [...text.matchAll(ALTERNATIVE_LANGUAGE)].map((match) => ({
    display: match[0],
    start: match.index,
    end: match.index + match[0].length,
  }));
  const connectors: Array<{ left: number; right: number }> = [];
  for (let index = 0; index < languages.length - 1; index += 1) {
    if (/^\s*,?\s*(?:and\/or|or)\s*$/i.test(text.slice(languages[index].end, languages[index + 1].start))) {
      connectors.push({ left: index, right: index + 1 });
    }
  }
  if (connectors.length !== 1) return;
  let first = connectors[0].left;
  while (first > 0 && /^\s*,\s*$/u.test(text.slice(languages[first - 1].end, languages[first].start))) first -= 1;
  const group = languages.slice(first, connectors[0].right + 1);
  const go = group.find((language) => language.display === 'Go');
  if (!go || terms.some((term) => term.term === 'go')) return;
  terms.push({
    term: 'go',
    display: 'Go',
    weight,
    kind: 'body',
    signal: true,
    mentions: 1,
    order: go.start,
  });
}

function termCoverageDecision(text: string, terms: JdTerm[], resumeText: string): TermCoverageDecision {
  const covered = terms.filter((term) => resumeCovers(resumeText, term.term));
  const allRequired = (): TermCoverageDecision => ({
    decidable: true,
    met: covered.length === terms.length,
    covered,
    missing: terms.filter((term) => !covered.includes(term)),
  });
  if (terms.length === 0 || !/\b(?:and\/or|or)\b/i.test(text)) return allRequired();

  const occurrences = terms.map((term) => {
    const start = typeof term.order === 'number' ? term.order : -1;
    const exact = Number.isInteger(start) && start >= 0
      && text.slice(start, start + term.display.length).toLowerCase() === term.display.toLowerCase();
    return { term, start, end: start + term.display.length, exact };
  });
  if (occurrences.some((occurrence) => !occurrence.exact)) {
    return { decidable: false, met: false, covered, missing: [] };
  }

  const connectors = [...text.matchAll(/\b(?:and\/or|or)\b/gi)]
    .map((match) => ({ start: match.index, end: match.index + match[0].length }))
    .filter((connector) => occurrences.some((occurrence) => occurrence.end <= connector.start)
      && occurrences.some((occurrence) => occurrence.start >= connector.end));
  if (connectors.length === 0) return allRequired();
  if (connectors.length !== 1) return { decidable: false, met: false, covered, missing: [] };
  const connector = connectors[0];

  const ordered = [...occurrences].sort((a, b) => a.start - b.start || a.end - b.end);
  let leftIndex = -1;
  for (let index = 0; index < ordered.length; index += 1) {
    if (ordered[index].end <= connector.start) leftIndex = index;
  }
  const rightIndex = ordered.findIndex((occurrence) => occurrence.start >= connector.end);
  if (leftIndex < 0 || rightIndex !== leftIndex + 1
    || !/^\s*,?\s*(?:and\/or|or)\s*$/i.test(text.slice(ordered[leftIndex].end, ordered[rightIndex].start))) {
    return { decidable: false, met: false, covered, missing: [] };
  }
  let firstAlternative = leftIndex;
  while (firstAlternative > 0
    && /^\s*,\s*$/u.test(text.slice(ordered[firstAlternative - 1].end, ordered[firstAlternative].start))) {
    firstAlternative -= 1;
  }
  const alternatives = ordered.slice(firstAlternative, rightIndex + 1);
  const alternativeTerms = new Set(alternatives.map((occurrence) => occurrence.term));
  const mandatory = ordered.map((occurrence) => occurrence.term)
    .filter((term) => !alternativeTerms.has(term));
  const missingMandatory = mandatory.filter((term) => !covered.includes(term));
  const coveredAlternative = alternatives.map((occurrence) => occurrence.term)
    .find((term) => covered.includes(term));
  const missing = [
    ...missingMandatory,
    ...(coveredAlternative ? [] : alternatives.map((occurrence) => occurrence.term)),
  ];
  return {
    decidable: true,
    met: missing.length === 0,
    covered,
    missing,
  };
}

/* ---------- 3. competency cues ---------- */

/**
 * What a resume looks like when it DOES the thing a competency clause asks for.
 *
 * An enumeration, like SKILL_LEXICON, and for the same reason: the alternative is a shape guess.
 * The cues are the verbs and artefacts a resume bullet actually uses, so a match can always be
 * shown to the student as the sentence it came from. This is the one class here that is an
 * inference rather than a literal match, which is why every hit carries its evidence sentence.
 */
const COMPETENCIES: Array<{ name: string; asks: RegExp; cues: RegExp }> = [
  /* Cue stems are open at the END on purpose: `\bpresentation\b` does not match "presentations",
     which is how v1 scored Mehek's communication at one bullet when her resume shows three
     ("12 insightful presentations", "a 50-page proposal", "presenting findings to the investment
     committee"). Resumes are written in the past tense and the plural; a cue list anchored on both
     sides tests spelling rather than evidence. Anchored at the START, so "reported" matches and
     "underreported" does not. */
  {
    name: 'communication',
    asks: /\b(communicat|written and verbal|verbal and written|presentation|articulat|storytell|influenc|stakeholder)/i,
    cues: /\b(present|pitch|proposal|report|brief|wrote|writing|authored|publish|communicat|deck|memo)/i,
  },
  {
    name: 'analysis',
    asks: /\b(analytic|analysis|data[- ]driven|quantitativ|metrics|insight|research)/i,
    cues: /\b(analy[sz]|research|survey|segment|model|forecast|evaluat|measur|studied|insight|diligence|valuation)/i,
  },
  {
    name: 'leadership',
    asks: /\b(lead|leader|leadership|mentor|manage a team|own(ing)? the|ownership)/i,
    cues: /\b(led|lead|manag|direct|owned|founded|head of|mentor|coordinat|oversaw|supervis)/i,
  },
  {
    name: 'collaboration',
    asks: /\b(collaborat|cross[- ]functional|partner with|work with (engineers|designers|teams)|team of)/i,
    cues: /\b(collaborat|cross[- ]functional|partner|team|liais|coordinat|stakeholder)/i,
  },
  {
    name: 'customer focus',
    asks: /\b(customer|client|user (needs|research|problems)|go[- ]to[- ]market|sales)/i,
    cues: /\b(customer|client|user|outreach|retailer|account|onboard|engagement)/i,
  },
  {
    name: 'building',
    asks: /\b(hands[- ]on|build|prototype|ship|iterate|implement|develop)/i,
    cues: /\b(built|build|design|develop|implement|prototyp|ship|launch|creat|produc|craft)/i,
  },
];

/**
 * How many DISTINCT bullets evidence a competency, and the strongest one to show.
 *
 * The count is the guard v1 lacked. With a single cue hit anywhere in the document, "Produced a
 * 50-page proposal" satisfied "Build with scale, quality, and security in mind from day one",
 * which is not what that sentence asks and is the same over-crediting the term model was being
 * fixed for, pointed the other way. Two independent bullets is the floor for calling a competency
 * evidenced, and the bullet is quoted so the student can disagree with it.
 */
function competencyEvidence(bullets: string[], cue: RegExp): { hits: number; quote?: string } {
  const matching = bullets.filter((b) => cue.test(b));
  return { hits: matching.length, quote: matching.sort((a, b) => b.length - a.length)[0]?.slice(0, 150) };
}

/** Minimum independent bullets before a competency counts as shown. */
export const MIN_COMPETENCY_BULLETS = 2;

/* ---------- the matcher ---------- */


export function matchClause(
  text: string,
  weight: number,
  facts: CandidateFacts,
  context?: JdContext,
  requiredCategory?: string,
): RequirementClause {
  const base = { text, weight };

  // 4. Dispositions leave the denominator, in either direction.
  if (UNSCOREABLE.some((re) => re.test(text)) && !DEGREE_CLAUSE.test(text)) {
    return { ...base, verdict: 'unscoreable', basis: 'none' };
  }

  const handsOnAiBuild = /\bplayed with\b[^.]*\b(llms?|agents?|computer[- ]use)\b[^.]*\.\s*you(?:'ve| have) built something\b/i.test(text);
  if (handsOnAiBuild) {
    const evidence = (facts.bullets ?? []).find((bullet) =>
      /\b(build|built|create|created|develop|developed|implement|implemented|play|played|ship|shipped)\b/i.test(bullet)
      && /\b(llms?|agents?|computer[- ]use)\b/i.test(bullet));
    return {
      ...base,
      verdict: evidence ? 'met' : 'unmet',
      basis: 'project-evidence',
      evidence,
    };
  }

  const exactCtgtFullTimeOnsite = /\bFull-time,\s+in person in San Francisco\b/i.test(text);
  if (exactCtgtFullTimeOnsite) {
    return { ...base, verdict: 'unscoreable', basis: 'onsite-commitment' };
  }

  const exactSfOnsiteCommitment = /\bcomfortable working in-person at our SF office for the whole internship\b/i.test(text);
  if (exactSfOnsiteCommitment) {
    if (facts.onsiteCommitment === 'anywhere') {
      return {
        ...base,
        verdict: 'met',
        basis: 'onsite-commitment',
        evidence: 'frozen onsite commitment applies to any listed US office',
      };
    }
    if (facts.onsiteCommitment === 'no') {
      return {
        ...base,
        verdict: 'unmet',
        basis: 'onsite-commitment',
        evidence: 'candidate declined onsite work',
      };
    }
    if (facts.onsiteCommitment === 'listed_locations') {
      const locations = facts.onsiteLocations ?? [];
      if (locations.length === 0) return { ...base, verdict: 'unscoreable', basis: 'onsite-commitment' };
      const sfCovered = locations.some((location) => /\b(?:san francisco|san fran|sf)\b/i.test(location));
      return {
        ...base,
        verdict: sfCovered ? 'met' : 'unmet',
        basis: 'onsite-commitment',
        evidence: sfCovered ? 'frozen onsite locations include San Francisco' : 'frozen onsite locations exclude San Francisco',
      };
    }
    return { ...base, verdict: 'unscoreable', basis: 'onsite-commitment' };
  }

  const exactCtgtInternshipWindow = /\b10\s*(?:to|-)\s*12\s+weeks?\s+between\s+May\/June\s+and\s+August\/September\s+2027\b/i.test(text);
  if (exactCtgtInternshipWindow) {
    return { ...base, verdict: 'unscoreable', basis: 'availability' };
  }

  // 1. Named technologies, when the clause names any. Most literal, so it goes first.
  //
  // A DEGREE FIELD IS NOT A NAMED TECHNOLOGY, and the exclusion is here rather than in the ordering
  // because the ordering is right: a clause that genuinely names a tool should be answered by the
  // tool, whatever else it says.
  //
  // This branch never used to see a field, and it did so by accident rather than by rule. "Computer
  // Science" reached extractJdTerms as an ordinary Title Case bigram, and a bigram's `signal` is
  // `isHardSignal(a) || isHardSignal(b)` - neither `computer` nor `science` is a lexicon skill, an
  // acronym or a technical marker - so the `.signal` filter above dropped it before it could route
  // anything. On 2026-08-08 the same phrases became curated PHRASE_LEXICON entries (see the note
  // there: postings that write their requirements in sentence case were refusing to score at all),
  // and PHRASE_LEXICON entries are signal by construction. That is correct for the scorer and wrong
  // here: it sent "Pursuing a bachelor's in computer science graduating in Fall 2027 or Spring 2028"
  // down the terms branch, so the graduation window stopped being deferred to the judge and started
  // being answered by whether the resume contains the words "computer science".
  //
  // ONLY INSIDE A DEGREE CLAUSE. "Strong fundamentals in computer science" names no degree and is a
  // requirement this branch should answer; "a BS in computer science" is a field, and 2b already has
  // FIELD_SYNONYMS for reading it against the student's parsed degree and school.
  //
  // ONLY WHEN NOTHING ELSE IS NAMED, so the exclusion cannot swallow a real tool: "Bachelor's in
  // computer science with strong Python" keeps `python`, stays here, and is answered literally.
  const termText = text.replace(/^(?:Requirements?|Preferred|Technical skills):\s*/iu, '');
  const signalTerms = extractJdTerms(termText, context).filter((t) => t.signal);
  addValidatedAlternativeLanguageTerms(termText, signalTerms, weight);
  if (requiredCategory) {
    const display = requiredCategory.trim();
    const key = display.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
    if (key && !signalTerms.some((term) => term.term === key)) {
      signalTerms.push({
        term: key,
        display,
        weight,
        kind: 'body',
        signal: true,
        mentions: 1,
        order: termText.indexOf(display),
      });
    }
  }
  const terms = DEGREE_CLAUSE.test(text)
    ? signalTerms.filter((t) => !DEGREE_FIELDS.has(t.term))
    : signalTerms;
  const enrollmentAsked = /\b(current\s+(?:cs|ml)\b|currently\s+enrolled|enrolled|pursuing|currently\s+studying|\b(?:undergrad|master'?s)\s+student\b)/i.test(text);

  // A named technology must never hide a structured duration floor. For a clause such as
  // "5+ years with Python", both the dated experience and Python evidence are mandatory.
  const years = YEARS_CLAUSE.exec(text);
  const asksProfessionalExperience = /\b(professional|work|industry|full[- ]time)\s+experience\b/i.test(text);
  const experienceMonths = asksProfessionalExperience
    ? facts.monthsOfProfessionalExperience
    : facts.monthsOfExperience;
  if (years) {
    if (experienceMonths == null) {
      return { ...base, verdict: 'unscoreable', basis: 'experience-years' };
    }
    const wanted = Number(years[1]) * 12;
    const termCoverage = termCoverageDecision(termText, terms, facts.resumeText);
    if (!termCoverage.decidable) {
      return { ...base, verdict: 'unscoreable', basis: 'experience-years' };
    }
    const termsMet = termCoverage.met;
    const durationMet = experienceMonths >= wanted;
    return {
      ...base,
      verdict: durationMet && termsMet ? 'met' : 'unmet',
      basis: 'experience-years',
      evidence: `${Math.round(experienceMonths / 12 * 10) / 10} years on the resume vs ${years[1]} asked`,
      missingTerms: termCoverage.missing.map((term) => term.display),
    };
  }

  if (terms.length > 0 && !enrollmentAsked) {
    const termCoverage = termCoverageDecision(termText, terms, facts.resumeText);
    if (!termCoverage.decidable) return { ...base, verdict: 'unscoreable', basis: 'terms' };
    return {
      ...base,
      verdict: termCoverage.met ? 'met' : 'unmet',
      basis: 'terms',
      evidence: termCoverage.covered.length
        ? `resume has ${termCoverage.covered.map((term) => term.display).join(', ')}`
        : undefined,
      missingTerms: termCoverage.missing.map((term) => term.display),
    };
  }

  // 2b. Degree level and field. Timing, when the clause states any, is deferred to the judge.
  if (DEGREE_CLAUSE.test(text)) {
    const degree = facts.degree ?? '';
    const school = facts.school ?? '';
    if (!degree && !school) return { ...base, verdict: 'unscoreable', basis: 'degree' };

    /* A clause that says WHEN goes to the judge whole, rather than being split into a field half
       we decide and a date half we guess at. Splitting it was how "BS graduating 2027; MS
       graduating 2029" came back met for a 2028 graduate: both halves passed something. */
    if (statesTiming(text)) {
      /* No graduation date on file. Unscoreable is right for the CLAUSE, but on its own it is not
         enough: an unscoreable clause leaves the denominator, the remaining clauses publish a
         number by themselves, and a student who has never entered a graduation date scored 100 on
         a posting whose graduation requirement nobody could check. scorePosting treats this the
         same as a question the judge never answered, and suppresses the headline. */
      if (!facts.gradDate) return { ...base, verdict: 'unscoreable', basis: 'graduation' };
      return { ...base, verdict: 'pending', basis: 'graduation' };
    }

    if (enrollmentAsked && facts.currentlyEnrolled == null) {
      return { ...base, verdict: 'unscoreable', basis: 'degree' };
    }
    if (enrollmentAsked && facts.currentlyEnrolled === false) {
      return { ...base, verdict: 'unmet', basis: 'degree', evidence: 'candidate is not currently enrolled' };
    }

    const degreeLevels = [
      { rank: 1, pattern: /\b(bachelor|bachelors|bachelor's|undergrad|undergraduate|b\.?s\.?|b\.?a\.?)\b/i },
      { rank: 2, pattern: /\b(master|masters|master's|m\.?s\.?|m\.?a\.?|mba)\b/i },
      { rank: 3, pattern: /\b(ph\.?d\.?|doctorate|doctoral)\b/i },
    ];
    const levelsAsked = degreeLevels.filter((level) => level.pattern.test(text));
    const levelHeld = [...degreeLevels].reverse().find((level) => level.pattern.test(degree));
    const levelMet = levelsAsked.length === 0 || (levelHeld != null && (enrollmentAsked
      ? levelsAsked.some((level) => level.rank === levelHeld.rank)
      : levelHeld.rank >= Math.min(...levelsAsked.map((level) => level.rank))));
    const kosEnrollmentFieldAlternative = /\bcurrent\s+cs\s+or\s+ml\s+(?:undergrad|undergraduate|student)\b/i.test(text);
    const fieldsAsked = Object.entries(FIELD_SYNONYMS).filter(([, re]) => re.test(text));
    const fieldMet = kosEnrollmentFieldAlternative
      ? /\b(?:computer science|cs|machine learning|ml)\b/i.test(degree)
      : fieldsAsked.length === 0 || fieldsAsked.some(([, re]) => re.test(degree));
    const why = fieldsAsked.length
      ? fieldMet
        ? `field matches (${degree})`
        : `field asked: ${fieldsAsked.map(([n]) => n).join('/')}`
      : kosEnrollmentFieldAlternative
        ? fieldMet ? `field matches (${degree})` : 'field asked: computer science/machine learning'
        : '';
    const trackRecordAsked = /\b(?:project(?:\s+or\s+internship)?|internship)\s+track record\b/i.test(text);
    const trackRecordMet = !trackRecordAsked || Boolean(facts.projectOrInternshipEvidence);
    const met = fieldMet && levelMet && trackRecordMet;
    const evidence = [
      enrollmentAsked ? 'candidate is currently enrolled' : '',
      levelsAsked.length ? (levelMet ? `degree level matches (${degree})` : `degree level does not match (${degree})`) : '',
      why,
      trackRecordAsked && facts.projectOrInternshipEvidence ? facts.projectOrInternshipEvidence : '',
    ].filter(Boolean).join('; ');
    return { ...base, verdict: met ? 'met' : 'unmet', basis: 'degree', evidence: evidence || undefined };
  }

  // 3. Competencies, evidenced by what the resume shows the student DOING, in their own bullets.
  const bullets = facts.bullets ?? [];
  for (const c of COMPETENCIES) {
    if (!c.asks.test(text)) continue;
    if (bullets.length === 0) return { ...base, verdict: 'unscoreable', basis: 'competency' };
    const { hits, quote } = competencyEvidence(bullets, c.cues);
    const met = hits >= MIN_COMPETENCY_BULLETS;
    return {
      ...base,
      verdict: met ? 'met' : 'unmet',
      basis: 'competency',
      evidence: met
        ? `${hits} bullets show ${c.name}, e.g. "${quote}"`
        : `${hits} of ${MIN_COMPETENCY_BULLETS} bullets show ${c.name}`,
    };
  }

  // Nothing in this clause is checkable. It leaves rather than counting as a miss.
  return { ...base, verdict: 'unscoreable', basis: 'none' };
}

/**
 * A one-of child must be visibly labelled as one of the captured engineering disciplines. This is
 * deliberately narrower than "anything before a colon": headings such as "Requirements" and
 * "Technical skills" are not candidate facts, and making them mandatory would invent gaps. The
 * bounded list mirrors the measured Mercari role-family group. Unknown shapes stay outside the
 * group and are scored normally, or leave the parent unscoreable when no measured child follows.
 */
function oneOfBranchCategory(text: string): string | null {
  const match = text.match(/^([^:\n]{1,48}):\s+\S/u);
  if (!match) return null;
  const label = match[1].trim();
  return /^(?:Backend|Frontend|Mobile(?:\s*\([^)]*\))?|Machine Learning|Platform Engineering|Site Reliability Engineering|Data Engineer|Security Engineer)$/u.test(label)
    ? label
    : null;
}

/* ---------- the two-phase scorer ---------- */

import type { CandidateProfile, CompetencyQuestion, CompetencyRejection, CompetencyVerdict } from '../llm/competencyJudge';

export interface ScoredPosting {
  score: number | null;
  clauses: RequirementClause[];
  /** Verdicts the judge returned ungrounded, so a bad run is visible rather than silently generous. */
  rejected: CompetencyRejection[];
}

/** Sections that state what the CANDIDATE must have. `responsibilities` describes the job instead,
 *  and scoring a student against what they will do rather than what they need is how the prototype
 *  credited "ship features on the Databricks platform" to someone who has never worked there. */
const CANDIDATE_KINDS = new Set<string>(['required', 'preferred']);

/**
 * Score a posting clause by clause, sending ONLY the competency clauses for judgement.
 *
 * Two phases on purpose. Everything decidable without judgement is decided first and locally, so a
 * model outage, a rate limit or a bad response can never change whether Python is on a resume or
 * whether a graduation date falls inside a stated window. The judge is injected rather than
 * imported so the deterministic half stays testable without a network.
 */
export async function scorePosting(
  jdText: string,
  facts: CandidateFacts,
  context: JdContext | undefined,
  segment: (jd: string) => Array<{ kind: string; weight: number; text: string }>,
  judge: (
    bullets: string[],
    qs: CompetencyQuestion[],
    profile?: CandidateProfile,
  ) => Promise<{ verdicts: CompetencyVerdict[]; rejected: CompetencyRejection[] }>,
): Promise<ScoredPosting> {
  const clauses: RequirementClause[] = [];
  for (const sec of segment(jdText)) {
    if (!CANDIDATE_KINDS.has(sec.kind)) continue;
    const texts = splitClauses(sec.text);
    let index = 0;
    while (index < texts.length) {
      const text = texts[index];
      if (!/\b(?:at least\s+)?one of the following\b/i.test(text)) {
        clauses.push(matchClause(text, sec.weight, facts, context));
        index += 1;
        continue;
      }

      const parent = matchClause(text, sec.weight, facts, context);
      const alternatives: RequirementClause[] = [];
      let next = index + 1;
      while (next < texts.length) {
        const category = oneOfBranchCategory(texts[next]);
        if (!category) break;
        alternatives.push(matchClause(texts[next], sec.weight, facts, context, category));
        next += 1;
      }

      if (alternatives.length === 0 || !alternatives.every((clause) => clause.basis === 'terms')) {
        clauses.push({ ...parent, verdict: 'unscoreable', basis: 'terms', evidence: undefined, missingTerms: [] });
        index += 1;
        continue;
      }
      const covered = alternatives.filter((clause) => clause.verdict === 'met');
      if (covered.length > 0) {
        clauses.push(covered[0]);
      } else if (alternatives.every((clause) => clause.verdict === 'unmet')) {
        clauses.push({ ...parent, verdict: 'unmet', basis: 'terms', evidence: undefined, missingTerms: [] });
      } else {
        clauses.push({ ...parent, verdict: 'unscoreable', basis: 'terms', evidence: undefined, missingTerms: [] });
      }
      index = next;
    }
  }

  /* Both classes are asked in ONE call. They are the same request with different corpora, and
     splitting them would double the latency and the cost for no gain. */
  /* An eligibility requirement the posting states and we hold no fact for. Counted with the
     unanswered ones: both mean "this requirement was not checked", and neither may be rounded off
     into a percentage that implies it was. */
  const uncheckable = clauses.filter(
    (c) => c.basis === 'graduation' && c.verdict === 'unscoreable',
  ).length;

  const pending = clauses
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.basis === 'competency' || (c.basis === 'graduation' && c.verdict === 'pending'));
  let rejected: CompetencyRejection[] = [];
  /* Clauses we sent and got nothing back for. Scoped to the whole function because it decides
     whether a headline number may be published at the end, not just inside the judge branch. */
  let unanswered = 0;
  if (pending.length > 0) {
    const questions: CompetencyQuestion[] = pending.map(({ i }) => ({
      id: `c${i}`,
      clause: clauses[i].text,
      kind: clauses[i].basis === 'graduation' ? 'eligibility' : 'competency',
    }));
    /* A judge failure leaves the deterministic verdicts EXACTLY where they were.
     *
     * This call was unguarded, and judgeCompetencies throws on any Anthropic error and on a
     * response it cannot parse. The route awaited scorePosting with no try/catch, so a rate limit
     * turned into a 500 and every locally-decided clause - Python on the resume, a graduation date
     * inside the window - was thrown away with it. The header of this module promises the opposite
     * in as many words: "a model outage, a rate limit or a bad response can never change whether
     * Python is on a resume". It could, and it did. */
    let result: { verdicts: CompetencyVerdict[]; rejected: CompetencyRejection[] };
    try {
      result = await judge(facts.bullets ?? [], questions, {
        degree: facts.degree,
        school: facts.school,
        gradDate: facts.gradDate,
      });
    } catch (err) {
      // The competency clauses stay UNSCOREABLE rather than unmet: we did not ask and got no
      // answer, which is not the same as asking and being told no.
      for (const { i } of pending) clauses[i] = { ...clauses[i], verdict: 'unscoreable' };
      /* NO SCORE, not a recomputed one. Dropping every competency clause from the denominator
         leaves only the deterministic ones, so a run where the model was never reached could
         report a HIGHER number than a successful one - up to 100 when the survivors all pass. The
         clause list is still returned, because "here is what we could check" is useful; a headline
         percentage built on a question we never got to ask is not. */
      return {
        score: null,
        clauses,
        rejected: [{ reason: `judge unavailable: ${err instanceof Error ? err.message : 'unknown error'}` }],
      };
    }
    rejected = result.rejected;
    const byId = new Map(result.verdicts.map((v) => [v.id, v]));
    for (const { i } of pending) {
      const v = byId.get(`c${i}`);
      /* No answer, so it stays a question we never got an answer to. A clause left PENDING would
         leak an internal state to the caller, and worse, aggregate() would have to guess what it
         meant. Unscoreable is the honest reading and the one the outage path already uses. */
      if (!v) {
        clauses[i] = { ...clauses[i], verdict: 'unscoreable' };
        unanswered++;
        continue;
      }
      clauses[i] = {
        ...clauses[i],
        verdict: v.met ? 'met' : 'unmet',
        evidence: v.met ? `"${v.quote}"` : v.why ?? clauses[i].evidence,
      };
    }
  }

  /* THE SAME RULE AS THE OUTAGE PATH, reached a different way. A judge that returns an EMPTY
     verdict list has not thrown, so the catch above never runs, and dropping its clauses from the
     denominator left the deterministic survivors to publish a number on their own - 100, on a
     posting where nothing about the candidate was actually checked. A question we did not get an
     answer to suppresses the headline exactly like a question we could not ask. */
  if (unanswered > 0 || uncheckable > 0) return { score: null, clauses, rejected };
  return { score: aggregate(clauses), clauses, rejected };
}

/** Weighted coverage over the clauses that could be decided. Unscoreable ones leave entirely. */
function aggregate(clauses: RequirementClause[]): number | null {
  let got = 0;
  let total = 0;
  for (const c of clauses) {
    /* PENDING counts as unscoreable, not as unmet. It only reaches here if a caller drove
       matchClause directly without a judge; scoring it against the student would charge them for a
       question nobody asked. */
    if (c.verdict === 'unscoreable' || c.verdict === 'pending') continue;
    total += c.weight;
    if (c.verdict === 'met') got += c.weight;
  }
  return total > 0 ? Math.round((100 * got) / total) : null;
}
