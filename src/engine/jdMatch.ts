/**
 * JD match score: the single 0-100 number the dashboard shows against a job description.
 *
 * WHY THIS IS A NEW MODULE AND NOT A REUSE OF ats_keyword_coverage_pct
 * -------------------------------------------------------------------
 * resumeValidate.ts:785 documents, at length, why the existing coverage number was demoted from a
 * gate to a warning and must not be dressed back up:
 *
 *   - jdKeywords() keeps EVERY non-stopword over 3 chars, so a 4.8k Cohere posting yields 304
 *     "keywords" including "toronto", "vacation", "benefits", "passionate", "obsess".
 *   - Measured 2026-07-17, Mehek's entire 409-word bank (3x what fits on a page) covers 12-17% of
 *     that vocabulary. No resume a human could write scores well.
 *   - It separates a MATCHING JD from a WHOLLY MISMATCHED one by ~2 points. A number that cannot
 *     tell those apart is not a match score, whatever we label it.
 *
 * That comment closes by naming the fix: "A metric worth gating on needs a real keyword model,
 * which is a design decision, not a threshold tweak." This module is that design decision.
 *
 * The three things that make this discriminate where raw coverage did not:
 *
 *   1. SECTION WEIGHTING. A JD is not uniform prose. Terms inside "Requirements" and "What you'll
 *      do" carry the signal; terms inside "Benefits", "About us" and the EEO paragraph carry none.
 *      Noise sections score 0, so "vacation" and "passionate" stop being keywords at all.
 *   2. SPECIFICITY FILTERING. Within a scored section we keep only terms that look like an actual
 *      requirement: a curated skill lexicon hit, a token carrying a technical marker (c++, ci/cd,
 *      node.js), or a proper-noun-cased phrase in the source text. Generic corporate vocabulary is
 *      dropped by construction, not by threshold.
 *   3. A DENOMINATOR A HUMAN CAN REACH. The two filters above take a 4.8k JD from 304 terms to
 *      roughly 20-50. Covering 70% of 30 real requirements is something a one-page resume can
 *      actually do, so the number lands in a believable band instead of pinned at 15%.
 *
 * TWO RULES THIS MODULE HOLDS, both inherited from R-015:
 *
 *   - IT NEVER INVENTS A MATCH. Matching is literal, plus morphology we can defend (plural,
 *     hyphen/space/dot spelling). There is deliberately NO synonym or hypernym table here. The
 *     resumeSpec.ts skill_source note documents the model generalising "Hugging Face" to "Machine
 *     Learning" and why that is laundering rather than tailoring. A scorer that credits a broader
 *     term for a narrower one makes the same error silently.
 *   - IT REFUSES TO SCORE RATHER THAN GUESS. Under MIN_SCORABLE_TERMS real requirements, the JD
 *     did not give us enough to be honest about, and scorable=false. The dashboard shows nothing
 *     instead of a confident wrong number. See the discrimination tests in jdMatch.test.ts, which
 *     assert a matched/mismatched separation of at least MIN_SEPARATION points and fail the build
 *     if this model ever regresses to the ~2 points the old one managed.
 */

/** Below this many extracted requirement terms, we decline to show a score at all. */
export const MIN_SCORABLE_TERMS = 6;

/** Section classes, in descending signal. */
type SectionKind = 'required' | 'preferred' | 'responsibilities' | 'body' | 'noise';

const SECTION_WEIGHT: Record<SectionKind, number> = {
  required: 1,
  preferred: 0.6,
  responsibilities: 0.7,
  // Unlabelled prose. Real requirements do show up here in short postings that never use headings,
  // so it cannot be zero, but it is discounted because it is also where the culture copy lives.
  body: 0.4,
  noise: 0,
};

// Heading matchers, longest-intent first. Order matters: "preferred qualifications" must be tested
// before "qualifications", or every preferred block scores as required.
const HEADING_PATTERNS: Array<{ kind: SectionKind; re: RegExp }> = [
  { kind: 'noise', re: /\b(about (us|the company|our)|who we are|our (story|mission|values|culture)|benefits|perks|what we offer|compensation|salary|pay range|equal opportunity|eeo|diversity|accommodation|privacy|how to apply|why join)\b/i },
  { kind: 'preferred', re: /\b(preferred|nice[- ]to[- ]have|bonus|plus(es)?|desired|good to have|additional qualifications)\b/i },
  { kind: 'required', re: /\b(requirements?|qualifications?|what you'?ll need|what we'?re looking for|must[- ]have|minimum|basic qualifications|skills?|you have|your background)\b/i },
  { kind: 'responsibilities', re: /\b(responsibilities|what you'?ll do|the role|your impact|day[- ]to[- ]day|in this role|duties)\b/i },
];

/**
 * A line is treated as a heading when it is short, not a sentence, and not a bullet. JD headings in
 * scraped text lose their markup, so shape is all we have: "Requirements" / "REQUIREMENTS" /
 * "What you'll do:" all survive this, while a 20-word sentence containing the word "requirements"
 * does not.
 */
function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > 60) return false;
  if (/^[-*•·]/.test(t)) return false; // a bullet is content, never a heading
  const words = t.split(/\s+/).length;
  if (words > 7) return false;
  return t.endsWith(':') || /^[A-Z][^.!?]*$/.test(t) || t === t.toUpperCase();
}

function classifyHeading(line: string): SectionKind | undefined {
  for (const { kind, re } of HEADING_PATTERNS) if (re.test(line)) return kind;
  return undefined;
}

export interface JdSection {
  kind: SectionKind;
  weight: number;
  text: string;
}

/**
 * Split a JD into weighted sections. Text before any recognised heading is 'body': short postings
 * often have no headings at all, and dropping their content would leave nothing to score.
 */
export function segmentJd(jdText: string): JdSection[] {
  const lines = jdText.split(/\r?\n/);
  const sections: JdSection[] = [];
  let current: JdSection = { kind: 'body', weight: SECTION_WEIGHT.body, text: '' };

  for (const line of lines) {
    if (isHeadingLine(line)) {
      const kind = classifyHeading(line);
      if (kind) {
        if (current.text.trim()) sections.push(current);
        current = { kind, weight: SECTION_WEIGHT[kind], text: '' };
        continue;
      }
    }
    current.text += line + '\n';
  }
  if (current.text.trim()) sections.push(current);
  return sections;
}

/**
 * Curated skill lexicon. This is an INCLUSION list for "does this token look like a requirement",
 * NOT a synonym table: nothing here ever makes one term satisfy a different term. Kept deliberately
 * broad across disciplines because Litos targets students applying well outside software.
 */
const SKILL_LEXICON = new Set(
  `python java javascript typescript golang rust ruby scala kotlin swift php perl haskell matlab
react angular vue svelte next nuxt node deno express django flask rails spring laravel fastapi
sql nosql postgres postgresql mysql sqlite mongodb redis dynamodb snowflake bigquery redshift
aws azure gcp kubernetes docker terraform ansible jenkins circleci github gitlab bitbucket
pandas numpy scipy pytorch tensorflow keras sklearn huggingface langchain spark hadoop kafka airflow
tableau powerbi looker excel vba sas spss stata r
figma sketch photoshop illustrator indesign aftereffects premiere canva webflow
salesforce hubspot marketo zendesk jira confluence asana notion slack workday netsuite quickbooks
sap oracle peoplesoft bloomberg factset capitaliq pitchbook
html css sass tailwind bootstrap graphql rest grpc websocket oauth saml
git linux unix bash powershell agile scrum kanban devops mlops
accounting auditing bookkeeping valuation modeling forecasting budgeting reconciliation
econometrics statistics regression segmentation attribution
seo sem ppc crm cms erp roi kpi saas b2b b2c ux ui qa etl elt ci cd api sdk llm nlp ml ai
copywriting analytics automation visualization prototyping wireframing benchmarking underwriting`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Corporate vocabulary that survives the stopword list but carries no requirement signal. These are
 * the exact words the old scorer counted as keywords ("passionate", "obsess") and the reason its
 * denominator was unreachable.
 */
const BOILERPLATE = new Set(
  `passionate passion obsess obsessed driven motivated enthusiastic energetic dynamic exciting
opportunity opportunities candidate candidates applicant applicants position role roles job jobs
company companies organization organizations business businesses industry industries
team teams player culture cultural environment environments workplace world class leading
excellent excellence strong solid great good better best proven track record demonstrated ability
skills skill experience experienced years year knowledge understanding familiarity familiar
communication interpersonal collaborative collaboration verbal written presentation
detail oriented organized organization multitask fast paced deadline deadlines pressure
responsibilities responsible duties tasks including include includes such
required require requires requirement preferred prefer desired must should would will can
looking seeking join joining hire hiring recruit recruiting apply application
benefits vacation holiday holidays insurance dental vision medical retirement salary compensation
equal employment discrimination veteran disability gender race religion sexual orientation
remote hybrid onsite office location locations travel percent full time part
degree bachelor bachelors master masters phd university college school graduate undergraduate
work working works help helps helping support supporting supports ensure ensuring provide providing
new next high level levels across within using various multiple related relevant similar other
plus bonus nice have having make making take taking build building`
    .split(/\s+/)
    .filter(Boolean),
);

const GENERIC_STOPWORDS = new Set(
  `the and for with you your our are will from that this have their they who whom able use used
per via etc a an of to in on at by as is be we it its or if not but all any more most than then
what when where how why which while into out up down over under about after before during through
been was were has had do does did been being also may might could each both few own same so too
very just now here there these those them he she his her him us me my mine i`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Punctuation that only appears inside technical names: c++, c#, node.js, ci/cd. A token carrying
 * one is requirement-shaped regardless of the lexicon.
 *
 * This deliberately does NOT include a short-token rule. An earlier version treated any 2-4 letter
 * lowercase token as an acronym, which admitted "ship", "end", "own" and "team" as requirements and
 * put them on the missing list, where F2 would have tried to write a resume bullet about "ship".
 * Genuine short acronyms (aws, sql, ci, cd, ux, etl, api) are carried in SKILL_LEXICON instead,
 * which is an enumerated list rather than a shape guess.
 */
const TECH_MARKER = /[+#./]/;

/** ALL-CAPS 2-5 letter tokens are acronyms (REST, SAML, GDPR) that the lexicon will never finish. */
const ACRONYM = /^[A-Z]{2,5}$/;

/**
 * Words that open a JD bullet as grammar rather than as the requirement itself.
 *
 * A bullet's first word is capitalized either way, so position alone cannot separate "Design REST
 * APIs" (the requirement is REST, not Design) from "Machine Learning experience" (the requirement
 * IS Machine Learning). Rejecting every positional capital loses the second case; accepting every
 * one admits the first. This list resolves it by enumeration, the same way SKILL_LEXICON does,
 * because the set of verbs and adjectives that open a requirements bullet is small and stable.
 *
 * These are only consulted for the proper-noun rule. A token that is a lexicon skill or an acronym
 * is still admitted from bullet-initial position.
 */
const POSITIONAL_OPENERS = new Set(
  `design designing build building ship shipping own owning drive driving lead leading manage
managing develop developing create creating maintain maintaining partner partnering collaborate
collaborating deliver delivering support supporting improve improving optimize optimizing scale
scaling write writing test testing deploy deploying monitor monitoring analyze analyzing report
reporting present presenting coordinate coordinating execute executing implement implementing
comfortable familiar proficient fluent skilled versed competent capable
strong deep advanced basic solid prior proven demonstrated extensive significant substantial
hands exposure ability willingness eagerness passion desire interest curiosity
excellent outstanding exceptional thorough working practical relevant
bachelor bachelors master masters degree currently pursuing enrolled rising
must should able eager self highly well very`
    .split(/\s+/)
    .filter(Boolean),
);

export interface JdTerm {
  /** Lowercased, normalized. This is the match key. */
  term: string;
  /** As it appeared in the JD, for display. */
  display: string;
  weight: number;
  kind: SectionKind;
}

/** Normalize spelling variants that are the SAME term: node.js/nodejs/node js, ci-cd/ci/cd. */
export function normalizeTerm(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.’']/g, '')
    .replace(/[-_/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Crude, defensible singularisation. Deliberately does not touch -ss, -us, -is. */
function singular(word: string): string {
  if (/(ss|us|is)$/.test(word)) return word;
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/es$/.test(word) && /(ch|sh|x|s)es$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word)) return word.slice(0, -1);
  return word;
}

function inLexicon(t: string): boolean {
  // The bare -s strip is here as well as singular() because singular() deliberately leaves -is
  // alone (analysis, basis) and that guard also swallows real tech plurals like "APIs" -> "api".
  return (
    SKILL_LEXICON.has(t) ||
    SKILL_LEXICON.has(singular(t)) ||
    (t.length > 3 && SKILL_LEXICON.has(t.replace(/s$/, '')))
  );
}

/**
 * Is this token a real requirement?
 *
 * @param token             the token as it appeared, casing intact
 * @param positionalCapital true when the token sits at the start of a line, bullet or sentence, so
 *                          its capital letter is grammar rather than a proper noun. Without this,
 *                          every bullet's first word ("Comfortable with Git", "Design REST APIs")
 *                          reads as a product name and lands on the missing list.
 */
function isSpecific(token: string, positionalCapital: boolean): boolean {
  const t = normalizeTerm(token);
  if (!t || t.length < 2) return false;
  if (GENERIC_STOPWORDS.has(t) || BOILERPLATE.has(t)) return false;
  if (inLexicon(t)) return true;
  if (ACRONYM.test(token)) return true;
  if (TECH_MARKER.test(token)) return true;
  // Proper-noun cased: product and vendor names we do not carry in the lexicon (a long tail we will
  // never finish enumerating). From a bullet-initial position the capital is grammar, so the token
  // has to clear POSITIONAL_OPENERS before we read it as a name.
  if (/^[A-Z][a-zA-Z]{2,}$/.test(token)) {
    if (!positionalCapital) return true;
    return !POSITIONAL_OPENERS.has(t);
  }
  return false;
}

/**
 * Extract weighted requirement terms from a JD. A term appearing in several sections keeps its
 * HIGHEST weight: a skill named under both "Requirements" and "Nice to have" is required.
 */
export function extractJdTerms(jdText: string): JdTerm[] {
  const byTerm = new Map<string, JdTerm>();

  for (const section of segmentJd(jdText)) {
    if (section.weight === 0) continue;

    // Tokenize with positions, so bigram building can see what separated two tokens.
    const tokens = [...section.text.matchAll(/[A-Za-z][A-Za-z+#./_-]*/g)].map((m) => ({
      text: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    }));

    // True when everything before this token on its line is whitespace or a bullet marker, or the
    // token directly follows sentence-ending punctuation: its capital is positional.
    const positional = (start: number): boolean => {
      const before = section.text.slice(0, start);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      if (/^[\s\-*•·\d.)]*$/.test(line)) return true;
      return /[.!?:;]\s*$/.test(line);
    };

    // Unigrams. Match on the original casing so isSpecific can see proper nouns.
    for (const tok of tokens) {
      if (!isSpecific(tok.text, positional(tok.start))) continue;
      const term = normalizeTerm(tok.text);
      const existing = byTerm.get(term);
      if (!existing || section.weight > existing.weight) {
        byTerm.set(term, { term, display: tok.text, weight: section.weight, kind: section.kind });
      }
    }

    // Bigrams built only from adjacent specific tokens ("machine learning", "financial modeling").
    // These are the terms a student most wants to see named, and the ones a unigram model splits.
    //
    // The two tokens must be separated by SPACES ONLY. A comma, newline or bullet between them
    // means they are two list items, not a phrase: "React, PostgreSQL, and Docker" is three
    // requirements, and pairing them invents a "react postgresql" requirement that no resume can
    // ever match, while the subsumption pass below then deletes the two real terms it was built
    // from. That is a scoring bug in both directions at once.
    for (let i = 0; i < tokens.length - 1; i++) {
      const a = tokens[i];
      const b = tokens[i + 1];
      const gap = section.text.slice(a.end, b.start);
      if (!/^ +$/.test(gap)) continue;
      if (!isSpecific(a.text, positional(a.start)) || !isSpecific(b.text, positional(b.start))) {
        continue;
      }
      // Two lexicon skills sitting next to each other are two requirements, not a phrase:
      // "GraphQL APIs" and "Docker Kubernetes" must stay separate so each is matched and, when
      // missing, named on its own.
      if (inLexicon(normalizeTerm(a.text)) && inLexicon(normalizeTerm(b.text))) continue;
      const term = `${normalizeTerm(a.text)} ${normalizeTerm(b.text)}`;
      const existing = byTerm.get(term);
      if (!existing || section.weight > existing.weight) {
        byTerm.set(term, {
          term,
          display: `${a.text} ${b.text}`,
          weight: section.weight,
          kind: section.kind,
        });
      }
    }
  }

  // A bigram subsumes its parts. Keeping "machine", "learning" AND "machine learning"
  // triple-counts one requirement and lets a resume that says neither look two-thirds covered by
  // accident.
  //
  // But a part that is a lexicon skill in its own right survives: in "Salesforce administration",
  // "Salesforce" is a real, separately-matchable requirement and deleting it would lose the very
  // term the student most needs credit for. Only the part that means nothing alone is dropped.
  for (const term of [...byTerm.keys()]) {
    if (!term.includes(' ')) continue;
    for (const part of term.split(' ')) {
      if (!inLexicon(part)) byTerm.delete(part);
    }
  }

  return [...byTerm.values()].sort((x, y) => y.weight - x.weight || x.term.localeCompare(y.term));
}

/**
 * Does the resume text contain this term? Literal, plus the morphology defended above. There is no
 * synonym step here on purpose: see the module header.
 */
export function resumeCovers(resumeText: string, term: string): boolean {
  const hay = ` ${normalizeTerm(resumeText)} `;
  const needle = normalizeTerm(term);
  if (hay.includes(` ${needle} `)) return true;
  const singularNeedle = needle.split(' ').map(singular).join(' ');
  if (hay.includes(` ${singularNeedle} `)) return true;
  // The resume may pluralise where the JD did not.
  const words = ` ${hay} `;
  return words.includes(` ${needle}s `) || words.includes(` ${needle}es `);
}

export interface JdMatchResult {
  /** 0-100 weighted coverage, or null when the JD was not scorable. */
  score: number | null;
  scorable: boolean;
  /** Present when scorable is false: why, in words the UI can show verbatim. */
  reason?: string;
  matched: JdTerm[];
  /** Highest-weight unmet requirements first. This list is what F2 turns into bullets. */
  missing: JdTerm[];
  term_count: number;
}

/**
 * Score a resume against a JD.
 *
 * @param resumeText  the full rendered text of the resume being scored
 * @param jdText      the raw job description
 */
export function scoreJdMatch(resumeText: string, jdText: string): JdMatchResult {
  const terms = extractJdTerms(jdText);

  if (terms.length < MIN_SCORABLE_TERMS) {
    return {
      score: null,
      scorable: false,
      reason:
        'This posting does not list enough specific requirements to score against. Nothing is wrong with your resume.',
      matched: [],
      missing: [],
      term_count: terms.length,
    };
  }

  const matched: JdTerm[] = [];
  const missing: JdTerm[] = [];
  let got = 0;
  let total = 0;

  for (const t of terms) {
    total += t.weight;
    if (resumeCovers(resumeText, t.term)) {
      got += t.weight;
      matched.push(t);
    } else {
      missing.push(t);
    }
  }

  return {
    score: total > 0 ? Math.round((100 * got) / total) : null,
    scorable: total > 0,
    matched,
    missing,
    term_count: terms.length,
  };
}

/**
 * The band label shown next to the number. Thresholds are set against what this scorer actually
 * produces (see jdMatch.test.ts), not copied from Jobscan's 75-80% advice, which is calibrated to a
 * completely different denominator and would mislabel a good Litos resume as failing.
 */
export function scoreBand(score: number): { label: string; tone: 'strong' | 'fair' | 'weak' } {
  if (score >= 65) return { label: 'Strong match', tone: 'strong' };
  if (score >= 40) return { label: 'Partial match', tone: 'fair' };
  return { label: 'Weak match', tone: 'weak' };
}
