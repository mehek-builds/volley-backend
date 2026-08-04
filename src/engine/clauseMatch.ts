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

import { extractJdTerms, resumeCovers, type JdContext } from './jdMatch';

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
}

export type ClauseVerdict = 'met' | 'unmet' | 'unscoreable';

export interface RequirementClause {
  /** The employer's sentence, verbatim, trimmed of bullet decoration. */
  text: string;
  /** required 1, preferred 0.6, responsibilities 0.7 - the section weights jdMatch already uses. */
  weight: number;
  verdict: ClauseVerdict;
  /** Which rule decided it, so the student can be shown why. */
  basis: 'terms' | 'degree' | 'graduation' | 'experience-years' | 'competency' | 'none';
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
];

/* ---------- 2. structured facts ---------- */

const DEGREE_CLAUSE = /\b(bachelor|bachelors|ba|bs|b\.s|master|masters|ms|m\.s|phd|doctorate|degree|undergraduate|enrolled|pursuing|currently studying)\b/i;

/** Fields named often enough to be worth checking literally. Never inferred from one another. */
const FIELD_SYNONYMS: Record<string, RegExp> = {
  'computer science': /\b(computer science|cs)\b/i,
  engineering: /\bengineering\b/i,
  business: /\b(business|business administration|commerce)\b/i,
  economics: /\beconomics\b/i,
  mathematics: /\b(mathematics|math|statistics)\b/i,
  finance: /\bfinance\b/i,
  design: /\b(design|hci)\b/i,
  law: /\b(law|juris)\b/i,
};

const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';

/** A point in academic time, comparable by ordering. Spring/H1 sorts before Fall/H2. */
type GradPoint = { year: number; half: 1 | 2 };

const SEASONAL = new RegExp(`\\b(fall|autumn|winter|spring|summer)\\s+(20\\d\\d)\\b`, 'gi');
const MONTHLY = new RegExp(`\\b(${MONTHS})[a-z]*\\s+(20\\d\\d)\\b`, 'gi');
/* Numeric month-and-year, which a NAMED-month pattern cannot see. "2027-05", "05/2027" and
   "5/2027" all mean May 2027, and reading them as a bare year let them span it: the same
   May-2027 candidate the window excludes came back met purely by writing the date differently.
   grad_date is free-typed and the resume parser preserves the most precise date printed. */
const NUMERIC_YM = /\b(20\d\d)[-/.](0?[1-9]|1[0-2])\b/g;
const NUMERIC_MY = /\b(0?[1-9]|1[0-2])[-/.](20\d\d)\b/g;
/** A bare year only counts as a graduation date when the clause is actually about graduating. */
const GRADUATION_CUE = /\b(graduat|class of|degree conferred|expected|completion)/i;

function pointsIn(text: string, requireCue = true): { points: GradPoint[]; bare: boolean } {
  const out: GradPoint[] = [];
  for (const m of text.matchAll(SEASONAL)) {
    const season = m[1].toLowerCase();
    out.push({ year: Number(m[2]), half: season === 'spring' || season === 'summer' ? 1 : 2 });
  }
  for (const m of text.matchAll(MONTHLY)) {
    const late = ['jul', 'aug', 'sep', 'oct', 'nov', 'dec'].includes(m[1].toLowerCase());
    out.push({ year: Number(m[2]), half: late ? 2 : 1 });
  }
  for (const m of text.matchAll(NUMERIC_YM)) {
    out.push({ year: Number(m[1]), half: Number(m[2]) >= 7 ? 2 : 1 });
  }
  for (const m of text.matchAll(NUMERIC_MY)) {
    out.push({ year: Number(m[2]), half: Number(m[1]) >= 7 ? 2 : 1 });
  }
  if (out.length > 0) return { points: out, bare: false };
  if (!requireCue || GRADUATION_CUE.test(text)) {
    for (const m of text.matchAll(/\b(20\d\d)\b/g)) out.push({ year: Number(m[1]), half: 1 });
    return { points: out, bare: true };
  }
  return { points: out, bare: false };
}

const ordinal = (p: GradPoint) => p.year * 2 + p.half;

/**
 * EVERY graduation point a clause names, as a closed range, not just the first one.
 *
 * "graduating in Fall 2027 or Spring 2028" is a WINDOW, and reading only the first match turned it
 * into a floor: `ownGrad.year > wantedGrad.year` then scored a May 2030 graduate as MEETING an
 * internship requirement they plainly miss. That is not hypothetical. It is the unexplained
 * "six of six met, score 100" on Databricks' PM intern posting on 2026-08-04, where the candidate
 * graduates May 2027 and is outside the window at the OTHER end. The bug hid because the clause
 * reported met and the reader had no reason to look at a passing row.
 *
 * A single stated point stays a single point, so "graduating in 2026" is still exact rather than
 * silently becoming an open interval.
 *
 * THE BARE-YEAR FALLBACK NOW NEEDS A CUE. It used to fire on any four-digit year in a degree
 * clause, so "Bachelor's degree; our 2019 Series B team" invented a graduation requirement and
 * scored a real candidate unmet against a window the employer never stated.
 */
function parseGraduationWindow(text: string): { from: GradPoint; to: GradPoint } | null {
  const { points } = pointsIn(text);
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => ordinal(a) - ordinal(b));
  return { from: sorted[0], to: sorted[sorted.length - 1] };
}

const YEARS_CLAUSE = /(\d+)\s*\+?\s*(?:or more\s*)?years?\b/i;

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
): RequirementClause {
  const base = { text, weight };

  // 4. Dispositions leave the denominator, in either direction.
  if (UNSCOREABLE.some((re) => re.test(text)) && !DEGREE_CLAUSE.test(text)) {
    return { ...base, verdict: 'unscoreable', basis: 'none' };
  }

  // 1. Named technologies, when the clause names any. Most literal, so it goes first.
  const terms = extractJdTerms(text, context).filter((t) => t.signal);
  if (terms.length > 0) {
    const covered = terms.filter((t) => resumeCovers(facts.resumeText, t.term));
    // "SQL and/or Python" and "Java or Kotlin" are satisfied by one. An unqualified list is not.
    const anySuffices = /\b(and\/or|or)\b/i.test(text);
    const met = anySuffices ? covered.length > 0 : covered.length === terms.length;
    return {
      ...base,
      verdict: met ? 'met' : 'unmet',
      basis: 'terms',
      evidence: covered.length ? `resume has ${covered.map((t) => t.display).join(', ')}` : undefined,
      missingTerms: terms.filter((t) => !covered.includes(t)).map((t) => t.display),
    };
  }

  // 2a. Years of experience, against dated entries rather than against prose.
  const years = YEARS_CLAUSE.exec(text);
  if (years && facts.monthsOfExperience != null) {
    const wanted = Number(years[1]) * 12;
    const met = facts.monthsOfExperience >= wanted;
    return {
      ...base,
      verdict: met ? 'met' : 'unmet',
      basis: 'experience-years',
      evidence: `${Math.round(facts.monthsOfExperience / 12 * 10) / 10} years on the resume vs ${years[1]} asked`,
    };
  }

  // 2b. Degree level and field, and the graduation window when the clause states one.
  if (DEGREE_CLAUSE.test(text)) {
    const degree = facts.degree ?? '';
    const school = facts.school ?? '';
    if (!degree && !school) return { ...base, verdict: 'unscoreable', basis: 'degree' };

    const fieldsAsked = Object.entries(FIELD_SYNONYMS).filter(([, re]) => re.test(text));
    const fieldMet =
      fieldsAsked.length === 0 || fieldsAsked.some(([, re]) => re.test(degree) || re.test(school));

    const wantedGrad = parseGraduationWindow(text);
    // The candidate's own date is a POINT, so the first parse of it is the whole answer. Only the
    // employer's clause can name a range.
    /* NO CUE REQUIRED for the candidate's own date: the field IS the graduation date, so a bare
       "2027" is a graduation year by definition. Running it through the employer-text gate meant
       pointsIn returned nothing, ownGrad was null, and every window silently passed - which is
       this module's headline bug surviving inside its own fix, for every profile whose grad_date
       came from grad_year (see submissionEducationGuard). */
    const own = pointsIn(facts.gradDate ?? '', false);
    const ownGrad = own.points.length > 0 ? own.points[0] : null;
    /* A BARE YEAR IS A YEAR, not the first half of one. "2027" with no term names a whole academic
       year, and pinning it to Spring made a 2027 graduate miss a "Fall 2027 or Spring 2028" window
       they plainly sit inside. Only the candidate's own field gets this: an employer writing a bare
       year in a range already has the range read from both endpoints. */
    /* SPANS ITS YEAR ONLY IF THE PARSE FELL THROUGH TO THE BARE-YEAR BRANCH.
       This tested the STRING for letters, which read "2027-05", "05/2027" and "5/2027" as bare
       years and re-admitted the exact May-2027 candidate the window exists to exclude. grad_date is
       a free-typed field and the resume parser is told to preserve the most precise date printed,
       so numeric formats reach here. The parse already knows whether it saw a month; ask it. */
    const ownSpansYear = own.bare && own.points.length === 1;
    /* INSIDE the stated window, at BOTH ends, with NO slack.
       Graduating before it and graduating after it are the same kind of miss, and only the first
       was caught. A season of slack was tried and removed: an employer writing "Fall 2027 or
       Spring 2028" for a summer internship is screening out people who will have already
       graduated, so admitting the term either side re-breaks the exact case this was written for.
       A candidate finishing May 2027 is out of a Fall 2027 to Spring 2028 window, and saying so is
       the useful answer. */
    const gradMet = !wantedGrad || !ownGrad
      ? true
      : ownSpansYear
        // Any term of the stated year landing inside the window is enough.
        ? [1, 2].some((half) => {
            const o = ordinal({ year: ownGrad.year, half: half as 1 | 2 });
            return o >= ordinal(wantedGrad.from) && o <= ordinal(wantedGrad.to);
          })
        : ordinal(ownGrad) >= ordinal(wantedGrad.from) && ordinal(ownGrad) <= ordinal(wantedGrad.to);

    const met = fieldMet && gradMet;
    const why = [
      fieldsAsked.length ? (fieldMet ? `field matches (${degree})` : `field asked: ${fieldsAsked.map(([n]) => n).join('/')}`) : null,
      wantedGrad && ownGrad
        ? gradMet
          ? `graduates ${facts.gradDate}`
          : `graduates ${facts.gradDate}, outside the window this posting states`
        : null,
    ].filter(Boolean).join('; ');
    return { ...base, verdict: met ? 'met' : 'unmet', basis: wantedGrad ? 'graduation' : 'degree', evidence: why || undefined };
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

/* ---------- the two-phase scorer ---------- */

import type { CompetencyQuestion, CompetencyRejection, CompetencyVerdict } from '../llm/competencyJudge';

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
  judge: (bullets: string[], qs: CompetencyQuestion[]) => Promise<{ verdicts: CompetencyVerdict[]; rejected: CompetencyRejection[] }>,
): Promise<ScoredPosting> {
  const clauses: RequirementClause[] = [];
  for (const sec of segment(jdText)) {
    if (!CANDIDATE_KINDS.has(sec.kind)) continue;
    for (const text of splitClauses(sec.text)) clauses.push(matchClause(text, sec.weight, facts, context));
  }

  const pending = clauses.map((c, i) => ({ c, i })).filter(({ c }) => c.basis === 'competency');
  let rejected: CompetencyRejection[] = [];
  if (pending.length > 0) {
    const questions: CompetencyQuestion[] = pending.map(({ i }) => ({ id: `c${i}`, clause: clauses[i].text }));
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
      result = await judge(facts.bullets ?? [], questions);
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
      if (!v) continue;
      clauses[i] = {
        ...clauses[i],
        verdict: v.met ? 'met' : 'unmet',
        evidence: v.met ? `"${v.quote}"` : v.why ?? clauses[i].evidence,
      };
    }
  }

  return { score: aggregate(clauses), clauses, rejected };
}

/** Weighted coverage over the clauses that could be decided. Unscoreable ones leave entirely. */
function aggregate(clauses: RequirementClause[]): number | null {
  let got = 0;
  let total = 0;
  for (const c of clauses) {
    if (c.verdict === 'unscoreable') continue;
    total += c.weight;
    if (c.verdict === 'met') got += c.weight;
  }
  return total > 0 ? Math.round((100 * got) / total) : null;
}
