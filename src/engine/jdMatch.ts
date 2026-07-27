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

/**
 * ...and at least this many of them must be HARD SIGNAL: a curated lexicon skill, an acronym, or a
 * token carrying a technical marker.
 *
 * A count alone is not evidence a posting stated requirements. The proper-noun rule admits company
 * names, city names and people's names, so a JD that says nothing but "Join Acme Corp in Toronto.
 * Contact Jane Doe or Bob Smith." cleared a floor of 6 and produced a confident 0% "Weak match"
 * with `Bob Smith`, `Jane Doe` and `Toronto` on the missing list. That list is not just displayed:
 * it is the input to the gap-to-bullet feature, which would have offered to write the student a
 * resume bullet about Bob Smith.
 */
export const MIN_SIGNAL_TERMS = 3;

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
/** Strip the decoration a heading arrives wrapped in: "## Requirements", "**Requirements**". */
function headingCore(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/^__|__$/g, '')
    .trim();
}

function isHeadingLine(line: string): boolean {
  const t = headingCore(line);
  if (!t || t.length > 60) return false;
  if (/^[-*•·]/.test(t)) return false; // a bullet is content, never a heading
  const words = t.split(/\s+/).length;
  if (words > 7) return false;
  return t.endsWith(':') || /^[A-Z][^.!?]*$/.test(t) || t === t.toUpperCase();
}

function classifyHeading(line: string): SectionKind | undefined {
  const t = headingCore(line);
  for (const { kind, re } of HEADING_PATTERNS) if (re.test(t)) return kind;
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
plus bonus nice have having make making take taking build building
proficiency proficient expertise fluency familiarity exposure comfort`
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
  /** A lexicon skill, an acronym, or a technical marker, as opposed to a bare proper noun. Only
   *  these count toward whether the posting is scorable at all. */
  signal?: boolean;
  /** As it appeared in the JD, for display. */
  display: string;
  weight: number;
  kind: SectionKind;
}

/** Normalize spelling variants that are the SAME term: node.js/nodejs/node js, ci-cd/ci/cd. */
export function normalizeTerm(raw: string): string {
  return (
    raw
      .toLowerCase()
      // Dots vanish rather than separate, so node.js and nodejs key the same.
      .replace(/[.’']/g, '')
      // EVERYTHING else that is not a letter, digit, + or # becomes a separator. This used to be
      // just [-_/], which left commas, semicolons, parens and pipes glued to the word: a resume
      // bullet reading "Used Docker, Kubernetes and Terraform" normalized to "docker, kubernetes"
      // and the whole-word test ` docker ` failed on two of the three. The score silently
      // undercounted terms the student plainly had, and the resume pane showed no mark for them
      // while the gap list claimed they were missing.
      .replace(/[^a-z0-9+#]+/g, ' ')
      .trim()
  );
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
/** True for the subset of specific tokens that are evidence of a stated requirement, rather than
 *  merely a capitalized word that might be a product name or might be a person. */
function isHardSignal(token: string): boolean {
  const t = normalizeTerm(token);
  if (!t) return false;
  if (t.length === 1) return /^[A-Z]$/.test(token) && SKILL_LEXICON.has(t);
  return inLexicon(t) || ACRONYM.test(token) || TECH_MARKER.test(token);
}

function isSpecific(token: string, positionalCapital: boolean, nextIsCapitalized = false): boolean {
  const t = normalizeTerm(token);
  // Single-character lexicon entries (R, C) are real languages, but only when written as a
  // standalone capital. Without this the length guard made them unreachable and a data-science
  // posting never surfaced R at all.
  if (t.length === 1) return /^[A-Z]$/.test(token) && SKILL_LEXICON.has(t);
  if (!t) return false;
  if (GENERIC_STOPWORDS.has(t) || BOILERPLATE.has(t)) return false;
  if (inLexicon(t)) return true;
  if (ACRONYM.test(token)) return true;
  if (TECH_MARKER.test(token)) return true;
  // Proper-noun cased: product and vendor names we do not carry in the lexicon (a long tail we
  // will never finish enumerating).
  if (/^[A-Z][a-zA-Z]{2,}$/.test(token)) {
    if (!positionalCapital) return true;
    // From a bullet-initial position the capital is grammar, so it needs more than case to count.
    // POSITIONAL_OPENERS alone was a deny-list against the open set of English verbs, and it lost:
    // "Troubleshoot production incidents" and "Mentor junior engineers" both landed on the missing
    // list as requirements. A real multi-word product name ("Machine Learning", "Google Cloud")
    // continues in Title Case, while a verb is followed by lowercase prose, so requiring the run
    // is a property of names rather than another list to keep topping up.
    return !POSITIONAL_OPENERS.has(t) && nextIsCapitalized;
  }
  return false;
}

/**
 * Extract weighted requirement terms from a JD. A term appearing in several sections keeps its
 * HIGHEST weight: a skill named under both "Requirements" and "Nice to have" is required.
 */
interface SectionToken {
  text: string;
  start: number;
  end: number;
  /** The token opens a line, a bullet or a sentence, so a leading capital is grammar not a name. */
  positional: boolean;
  /** The next token is also capitalized, i.e. this is the head of a Title Case run. */
  nextIsCapitalized: boolean;
}

/**
 * Tokenize a section, with three corrections the naive regex got wrong:
 *
 *  - TRAILING PUNCTUATION IS TRIMMED OFF THE TOKEN. '.' is inside the token class so that
 *    "node.js" survives, but that also swallowed a sentence-final period, which made the gap to
 *    the next sentence's first word a plain space and let bigrams form across sentence boundaries
 *    ("You will use Python daily. Kubernetes helps" produced the requirements "python daily" and
 *    "daily kubernetes"). The gap test is only meaningful once the token stops at the word.
 *
 *  - SLASH-JOINED PAIRS ARE SPLIT. "Docker/Kubernetes", "React/Redux" and "HTML/CSS" are two
 *    requirements written compactly. Left whole they normalize to "docker kubernetes", which no
 *    resume can match, AND the subsumption pass then deletes the two real terms it was built from:
 *    the same both-directions failure the comma rule exists to prevent. A slash form that is
 *    itself a known skill (ci/cd, a/b) is kept whole.
 *
 *  - `positional` IS COMPUTED IN ONE FORWARD PASS. It used to slice the whole prefix of the
 *    section per token, three times per token, which is O(n^2) on a JD with few newlines. A 60k
 *    single-line posting, exactly the HTML-stripped paste the 60k cap was sized for, spent ~594ms
 *    of synchronous event-loop time in this function.
 */
/** Slash forms that are ONE skill, not two. Checked against the normalized (space-joined) key,
 *  because normalizeTerm turns "CI/CD" into "ci cd" and the lexicon carries ci and cd separately. */
const SLASH_FORMS = new Set(['ci cd', 'a b', 'r d']);

function tokenizeSection(text: string): SectionToken[] {
  const raw = [...text.matchAll(/[A-Za-z][A-Za-z0-9+#./_-]*/g)];
  const out: SectionToken[] = [];
  let prevEnd = 0;

  for (const m of raw) {
    const start = m.index ?? 0;
    const gap = text.slice(prevEnd, start);
    // A newline followed only by bullet/number decoration, or the very start, or a sentence end.
    const positional =
      out.length === 0 ||
      /[\n\r][\s]*[-*•·]?[\s]*(\d+[.)])?[\s]*$/.test(gap) ||
      /[.!?:;]["'’)\]]*\s*$/.test(gap);

    let body = m[0];
    const trail = body.match(/[./_-]+$/)?.[0] ?? '';
    if (trail) body = body.slice(0, -trail.length);
    if (!body) {
      prevEnd = start + m[0].length;
      continue;
    }

    const pieces =
      body.includes('/') && !SLASH_FORMS.has(normalizeTerm(body))
        ? body.split('/').filter(Boolean)
        : [body];

    let offset = start;
    for (const piece of pieces) {
      const at = text.indexOf(piece, offset);
      const pieceStart = at === -1 ? offset : at;
      out.push({
        text: piece,
        start: pieceStart,
        end: pieceStart + piece.length,
        // Only the first piece of a split inherits the positional flag.
        positional: positional && piece === pieces[0],
        nextIsCapitalized: false,
      });
      offset = pieceStart + piece.length;
    }
    prevEnd = start + m[0].length;
  }

  for (let i = 0; i < out.length - 1; i++) {
    out[i].nextIsCapitalized = /^[A-Z]/.test(out[i + 1].text);
  }
  return out;
}

export function extractJdTerms(jdText: string): JdTerm[] {
  const terms = extractFrom(segmentJd(jdText));
  if (terms.length >= MIN_SCORABLE_TERMS) return terms;

  // A noise heading runs until the next recognised heading, so a posting that OPENS with
  // "Compensation" or "Pay range" (mandatory first in pay-transparency states, and increasingly
  // common everywhere) can put the entire document inside a zero-weight section. The student was
  // then told the posting "does not list enough specific requirements" about a posting full of
  // them. When zeroing the noise leaves us unable to score, re-read those sections as ordinary
  // body prose rather than throwing the posting away.
  const salvaged = extractFrom(
    segmentJd(jdText).map((section) =>
      section.kind === 'noise'
        ? { ...section, kind: 'body' as SectionKind, weight: SECTION_WEIGHT.body }
        : section,
    ),
  );
  return salvaged.length > terms.length ? salvaged : terms;
}

function extractFrom(sections: JdSection[]): JdTerm[] {
  const byTerm = new Map<string, JdTerm>();

  for (const section of sections) {
    if (section.weight === 0) continue;

    const tokens = tokenizeSection(section.text);

    // Unigrams. Match on the original casing so isSpecific can see proper nouns.
    for (const tok of tokens) {
      if (!isSpecific(tok.text, tok.positional, tok.nextIsCapitalized)) continue;
      const term = normalizeTerm(tok.text);
      const existing = byTerm.get(term);
      if (!existing || section.weight > existing.weight) {
        byTerm.set(term, {
          term,
          display: tok.text,
          weight: section.weight,
          kind: section.kind,
          signal: isHardSignal(tok.text),
        });
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
      if (
        !isSpecific(a.text, a.positional, a.nextIsCapitalized) ||
        !isSpecific(b.text, b.positional, b.nextIsCapitalized)
      ) {
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
          signal: isHardSignal(a.text) || isHardSignal(b.text),
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
  for (const [term, entry] of [...byTerm.entries()]) {
    if (!term.includes(' ')) continue;
    for (const part of term.split(' ')) {
      const existing = byTerm.get(part);
      if (!existing || inLexicon(part)) continue;
      // A part that was admitted in its own right at a HIGHER weight is a separate, more important
      // requirement that merely happens to also appear inside a phrase. Deleting it lost the term
      // entirely: a JD requiring "Databricks" under Requirements and mentioning "Databricks Delta"
      // under Responsibilities kept only the 0.7 phrase, so the weight-1 requirement vanished and
      // the only way to match was to write the exact two words.
      if (existing.weight > entry.weight) continue;
      byTerm.delete(part);
    }
  }

  return [...byTerm.values()].sort((x, y) => y.weight - x.weight || x.term.localeCompare(y.term));
}

/**
 * Does the resume text contain this term? Literal, plus the morphology defended above. There is no
 * synonym step here on purpose: see the module header.
 */
/**
 * Litos resumes are student resumes, and every student resume is full of academic terms. "Spring
 * 2026" made a Java posting's Spring requirement match automatically, "Fall 2025" did the same for
 * nothing useful, and the student was credited for a framework they had never touched. The season
 * word is only removed where a year follows it, so a genuine "Spring Boot" line is untouched.
 */
function stripAcademicTerms(text: string): string {
  return text.replace(/\b(spring|summer|fall|autumn|winter)\s+(19|20)\d{2}\b/gi, ' ');
}

export function resumeCovers(resumeText: string, term: string): boolean {
  const hay = ` ${normalizeTerm(stripAcademicTerms(resumeText))} `;
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
  /** Share of the terms listed under Requirements that the resume covers. null if the posting had
   *  no requirements section. The band reads this so a long Responsibilities list cannot outvote
   *  the block that actually gates the application. */
  required_coverage: number | null;
}

/**
 * Score a resume against a JD.
 *
 * @param resumeText  the full rendered text of the resume being scored
 * @param jdText      the raw job description
 */
export function scoreJdMatch(resumeText: string, jdText: string): JdMatchResult {
  const terms = extractJdTerms(jdText);

  const signalCount = terms.filter((t) => t.signal).length;
  if (terms.length < MIN_SCORABLE_TERMS || signalCount < MIN_SIGNAL_TERMS) {
    return {
      score: null,
      scorable: false,
      required_coverage: null,
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
  let requiredGot = 0;
  let requiredTotal = 0;

  for (const t of terms) {
    total += t.weight;
    if (t.kind === 'required') requiredTotal += 1;
    if (resumeCovers(resumeText, t.term)) {
      got += t.weight;
      if (t.kind === 'required') requiredGot += 1;
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
    required_coverage: requiredTotal > 0 ? requiredGot / requiredTotal : null,
  };
}

/**
 * The band label shown next to the number. Thresholds are set against what this scorer actually
 * produces (see jdMatch.test.ts), not copied from Jobscan's 75-80% advice, which is calibrated to a
 * completely different denominator and would mislabel a good Litos resume as failing.
 */
export function scoreBand(
  score: number,
  requiredCoverage: number | null = null,
): { label: string; tone: 'strong' | 'fair' | 'weak' } {
  // A resume can cover a long Responsibilities list while missing every hard requirement, because
  // the weights only differ 1 vs 0.7 and there are usually more responsibilities than requirements.
  // Measured: a posting requiring Kubernetes, Terraform and Kafka scored 61 with every weight-1
  // term missed. Calling that a strong match is the one thing this number must never do, so the
  // band is capped when the requirements block is more than half unmet.
  const gatedByRequirements = requiredCoverage !== null && requiredCoverage < 0.5;
  if (score >= 65 && !gatedByRequirements) return { label: 'Strong match', tone: 'strong' };
  if (gatedByRequirements && score >= 40) return { label: 'Missing key requirements', tone: 'fair' };
  if (score >= 40) return { label: 'Partial match', tone: 'fair' };
  return { label: 'Weak match', tone: 'weak' };
}
