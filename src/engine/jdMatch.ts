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
 *      roughly 20-50, and EMPHASIS_LIMIT then takes it to at most 12. See below: 20-50 was still
 *      not reachable, and finding that out took production data.
 *
 * WHAT 20-50 ACTUALLY MEASURED, AND THE CORRECTION (ISSUE-023, 2026-08-03)
 * -----------------------------------------------------------------------
 * Point 3 above was written from fixtures and it was wrong. Measured against the 400 newest active
 * postings scored against three real production base resumes, 1200 pairs: p50 = 3, p90 = 11,
 * max = 57, and 1105 of the 1107 scorable pairs read "Weak match". "Strong match" at 65 was not
 * merely hard to reach, it was unreached on the whole board. Nobody could see it.
 *
 * The cause was not the threshold. A denominator of "every term the posting mentions" measures how
 * much the employer WROTE, not how well the student FITS: a 6.5k Reddit posting listing 12 real
 * requirements also contributed `chicago`, `every`, `los angeles`, `moderators`, `san francisco`,
 * `york city` and its own web address, seven of its twenty-one terms, all from prose. Two shipped
 * fixes had already removed two whole categories of that junk (PLACE_SAFE_KINDS for the office list,
 * company branding for "Databricks SQL") and neither moved the distribution, because the supply of
 * categories is endless and the real problem was that the denominator had no ceiling.
 *
 * EMPHASIS_LIMIT is the ceiling: the score is now coverage of the at most 12 requirements the
 * posting emphasises most, so it asks a question a one-page resume can answer well and asks the
 * same-sized question of a 1.5k posting and a 6k one. The full argument, the ranking, and the sweep
 * that picked 12 are at EMPHASIS_LIMIT.
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

import { label as placeLabel, parsePlace, splitLocations } from '../lib/cities';

/**
 * What the caller already knows about the posting, and therefore must not be asked to have on a
 * resume. Every field here is an EXACT exclusion taken from the job row, never a guess made from
 * the prose. See SELF_REFERENCE and locationTokens for what each one costs us if it is missing.
 */
export interface JdContext {
  company?: string;
  role?: string;
  /** The posting's location field, verbatim. Multi-site strings are fine; cities.ts splits them. */
  location?: string | null;
}

/**
 * Below this many extracted requirement terms, we decline to show a score at all.
 *
 * ALSO READ capToEmphasis AND EMPHASIS_LIMIT BEFORE CHANGING THIS. The set this floor is tested
 * against is the CAPPED set, so the invariant that has to hold is
 *
 *   MIN_SIGNAL_TERMS < MIN_SCORABLE_TERMS <= EMPHASIS_LIMIT
 *
 * Raising this above EMPHASIS_LIMIT would make every posting unscorable, because the cap can never
 * hand back more terms than that.
 */
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
 *
 * THIS CONSTANT IS NO LONGER ONLY A REFUSAL FLOOR. capToEmphasis RESERVES this many of the
 * EMPHASIS_LIMIT denominator slots for hard-signal terms on EVERY posting, not just on marginal
 * ones, so raising it from 3 to 5 would not merely tighten the refusal: it would spend 5 of 12
 * slots before section weight is consulted at all, which is how the first version of the cap filled
 * compliance postings with acronyms. Read capToEmphasis before touching this.
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
  // `^about\b` rather than the old `about (us|the company|our)`. A heading-shaped line opening with
  // "About" is always a company or team blurb, and the enumerated form missed every posting that
  // names itself: "About OpenAI", "About PhonePe Limited:", "About the Team". OpenAI's "Counsel,
  // Litigation" was the case that found it, and the cost was not the blurb but everything AFTER it,
  // because an unrecognised heading does not close the section it interrupts. See NOISE_BLOCK.
  { kind: 'noise', re: /^about\b|\b(who we are|our (story|mission|values|culture)|benefits|perks|what we offer|compensation|salary|pay range|equal opportunity|eeo|diversity|accommodation|privacy|how to apply|why join)\b/i },
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

/**
 * A boilerplate block that opens with a line too wordy to pass isHeadingLine.
 *
 * An UNRECOGNISED heading does not merely fail to classify itself: it fails to CLOSE the section
 * above it, so everything under it inherits that section's weight. phonepe's "Senior Executive,
 * Compliance" ends its Requirements block with the line
 *
 *   PhonePe Full Time Employee Benefits (Not applicable for Intern or Contract Roles)
 *
 * which is 80 characters and 12 words, so isHeadingLine rejects it, and the whole benefits table
 * below it was read as REQUIRED at weight 1. The extracted requirements for that posting were
 * `adoption assistance`, `assistance program`, `benefit program`, `car lease`, `pf contribution`
 * and `accidental`, while `merchant compliance`, `risk management` and `change management` were
 * pushed out. The old ~30-term denominator diluted this; a 12-term denominator concentrates it,
 * which is why it had to be fixed alongside EMPHASIS_LIMIT rather than after it.
 *
 * WHY THIS IS NOT JUST A BIGGER isHeadingLine BUDGET. Raising the shared limit would let long
 * sentences classify as required and responsibilities headings too, which is the failure the
 * 7-word rule exists to prevent. Only the NOISE class gets the wider budget, and it is the one
 * class where a false positive is cheap: mistaking a line for boilerplate drops a section, and the
 * salvage pass in extractJdTerms already re-reads every noise section as body prose whenever
 * zeroing them leaves the posting unscorable.
 *
 * THE THREE GUARDS, and what each one actually covers:
 *   - not a bullet, which excludes any requirement written with a leading marker;
 *   - does not end in a full stop, which excludes any requirement written as a full sentence;
 *   - matches a STRONG marker. `benefits`, `perks` and the EEO vocabulary head a footer;
 *     `compensation` and `salary` are deliberately absent even though the heading list carries
 *     them, because "Experience with compensation benchmarking" is a real requirement.
 *
 * AN EARLIER VERSION OF THIS COMMENT CLAIMED "each of which a real requirements line trips". That
 * is false and it was never measured. Of 6440 lines inside required, preferred and responsibilities
 * sections on the 400-posting corpus, 3127 of them (48.6%) carry NO leading bullet AND NO terminal
 * full stop, so on nearly half the corpus the first two guards do not apply at all and the marker
 * vocabulary is carrying the rule alone.
 *
 * THE SAFETY IS THE NARROWNESS OF THE VOCABULARY, NOT THE GUARDS. The live false-positive rate on
 * this corpus is zero, but that is because real postings do not happen to write these words in this
 * shape, not because the shape rules would catch it if they did. Constructed counterexamples fail
 * immediately: "Ability to explain the benefits of our platform to prospective customers" and
 * "Knowledge of EEO and affirmative action reporting requirements", both unbulleted and unpunctuated
 * as half the corpus is, are read as noise and silently truncate every requirement below them.
 *
 * So the honest bound on this rule is: it is safe for the vocabulary it currently lists, and ANY
 * addition to NOISE_BLOCK needs to be checked against real requirement prose rather than reasoned
 * about, because the shape guards will not stop it. See the guard test in jdMatch.test.ts.
 */
const NOISE_BLOCK =
  /\b(benefits|perks|equal opportunity|equal employment|eeo|e-verify|affirmative action|reasonable accommodation|fair chance|applicant privacy|privacy policy)\b/i;

function isNoiseBlockOpener(line: string): boolean {
  const t = headingCore(line);
  if (!t || t.length > 120) return false;
  if (/^[-*•·]/.test(t)) return false;
  if (/\.$/.test(t)) return false;
  if (t.split(/\s+/).length > 16) return false;
  return NOISE_BLOCK.test(t);
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
    // Checked second, so a line that is a perfectly good short heading is still classified by the
    // full pattern list first and only the wordy boilerplate banners fall through to here.
    if (isNoiseBlockOpener(line)) {
      if (current.text.trim()) sections.push(current);
      current = { kind: 'noise', weight: SECTION_WEIGHT.noise, text: '' };
      continue;
    }
    current.text += line + '\n';
  }
  if (current.text.trim()) sections.push(current);
  return sections;
}

/**
 * Curated skill lexicon. This is an INCLUSION list for "does this token look like a requirement",
 * NOT a synonym table: nothing here ever makes one term satisfy a different term.
 *
 * THIS COMMENT USED TO CLAIM the list was "kept deliberately broad across disciplines because Litos
 * targets students applying well outside software". Measured 2026-08-03 against the 400 newest
 * active postings, that was false, and it was the single largest defect this file had:
 *
 *   resume                     terms matched over 400 postings    of which hard signal
 *   USC CS student                            388                        307
 *   MIT economics / PE                        235                         85
 *   UW law and policy                          40                          0
 *
 * ZERO. A real law-and-policy base resume did not match one lexicon entry on the entire board,
 * because before this change the list carried no `litigation`, no `compliance`, no `regulatory`,
 * no `policy`, no `contracts`, no `governance`. Everything that student ever matched came from the
 * proper-noun rule, which is the loose path this file distrusts everywhere else.
 *
 * Two consequences, both of which had been invisible in aggregate measurements. Her score carried
 * no fit signal at all: own-field postings out-scored the rest of the board by 0.2 points, so the
 * ordering GET /jobs gave her was noise with variance rather than a ranking. And no denominator
 * work could have helped her, because the reserved hard-signal slots in capToEmphasis reserve
 * nothing when the student can match no hard signal.
 *
 * The additions below are the disciplines Litos actually serves. They follow the same rule as the
 * rest of the list: concrete named methods, instruments and bodies of practice, never the generic
 * corporate vocabulary that lives in BOILERPLATE.
 *
 * COVERAGE IS INTENTIONALLY UNEVEN, so that a gap reads as a decision rather than an oversight.
 * Law, policy and compliance are the deepest because that is the resume this list was measured
 * against and found empty for. Health (7), education (5), HR (4) and media (6) are a first pass
 * sized to clear MIN_SIGNAL_TERMS on a typical posting in each, not to be complete: no clinical
 * credentials (RN, NP, BLS), no teaching certifications, no newsroom systems. Adding those is
 * ordinary maintenance and needs no argument, only the same measurement.
 *
 * TWO ENTRIES OVERLAP THE NOISE VOCABULARY ON PURPOSE, and this is the known cost. `contract` and
 * `policy` are hard signal here, which makes them eligible for the reserved slots in capToEmphasis,
 * and they are also footer words: "Not applicable for Intern or Contract Roles", "Travel Policy",
 * "Salary Advance Policy". NOISE_BLOCK zeroes those blocks, but it only fires on a heading-shaped
 * opener, so a footer line that is a bullet, ends in a full stop, or runs past 16 words falls
 * through and contributes them. They are kept anyway because contract work and policy work are the
 * substance of the two disciplines this pass exists to serve, and dropping them would restore the
 * exact hole that measured zero. `privacy` was dropped instead, and blocked outright in BOILERPLATE
 * (see the note there): it is the same footer vocabulary as "Applicant Privacy Policy" and it
 * reached 57 of 400 denominators.
 *
 * WHAT ACTUALLY CARRIES A PRIVACY POSTING is `compliance` and `regulatory`, NOT `gdpr` and `ccpa`.
 * An earlier version of this comment claimed the two named instruments were the safety net; checked
 * against the one real privacy-engineering posting on the board (Asana, Senior Privacy Engineer),
 * neither survives into its final twelve. The practice vocabulary around the role is what keeps it
 * scorable. The instruments are worth carrying anyway, but they are not the argument.
 *
 * PLURALS. inLexicon strips a trailing `s` for tokens over three characters, so the SINGULAR is the
 * entry that covers both and a plural-only entry covers only the plural. `sanctions` is deliberately
 * plural-only, because "sanction" alone is a common verb.
 *
 * ENTRIES REMOVED AFTER MEASUREMENT, recorded so nobody adds them back on the same intuition that
 * put them here. Each was a real discipline term with a commoner prose sense that dominated on this
 * board: `grants` ("competitive equity grants are included"), `curriculum` ("year-long firmwide
 * educational curriculum", a perk), `editing` ("improve the daily editing experience, including
 * IDE"), `onboarding` (24 postings, "lead customer onboarding"), `logistics` (11, half of them
 * company blurbs), `discovery` (18, "leading discovery calls") and `diligence`. `policy` was KEPT
 * despite 17 prose hits ("in-office policy 4 days/week") because it is the central noun of the
 * policy discipline and removing it would reopen the hole this whole pass exists to close.
 *
 * GRANULARITY. The software half of this list is whole product names; the operations entries are
 * single words (`lean`, `sigma`, `kaizen`) rather than "lean six sigma". That is forced rather than
 * chosen: a bigram only forms from two tokens that are each independently specific, and "six" never
 * is, so "six sigma" could never be reached as an entry. Unigrams are what the extractor can
 * actually key on here.
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
litigation compliance regulatory governance contract paralegal deposition
subpoena arbitration mediation trademark copyright patent licensing antitrust gdpr ccpa
redlining docketing westlaw lexisnexis clio ediscovery relativity
legislation legislative advocacy lobbying rulemaking testimony casework constituent redistricting
policy zoning procurement grantmaking appropriations
aml kyc sanctions fincen finra sec hipaa ferpa osha eeoc nlrb sox pci
epidemiology biostatistics phlebotomy triage pharmacology immunology histology
pedagogy iep literacy tutoring
recruiting payroll ergonomics
inventory dispatch warehousing kaizen sigma lean
journalism proofreading transcription translation interpreting
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
/* `privacy` and `notice` are in this list because of the applicant-privacy footer, which is on a
 * seventh of the board as "Global Data Privacy Notice for Job Candidates and Applicants". That line
 * defeats both noise filters: 9 words exceeds isHeadingLine's 7-word budget, and NOISE_BLOCK lists
 * `applicant privacy` and `privacy policy` but not `privacy notice`. Widening NOISE_BLOCK does not
 * help either, because those postings usually have no recognised headings at all, so the salvage
 * pass in extractJdTerms re-reads every noise section as body and re-admits the footer.
 *
 * Measured 2026-08-03: `privacy` reached the final 12-term denominator on 57 of 400 postings, 41 of
 * them classified required or preferred. Flexport's Sales Manager scored a resume against
 * `china, eu, japan, southeast asia, air, am, kansai, kobe, kyoto, osaka, privacy, today`.
 *
 * Blocking it HERE rather than dropping it from SKILL_LEXICON is what also kills the BIGRAM. A
 * bigram forms only from two independently specific tokens, so blocking `notice` removes
 * `privacy notice`, which the proper-noun rule admits whatever the lexicon says.
 *
 * THE COST, taken deliberately: on ~21 postings the privacy footer was supplying the third signal
 * term, so they become unscorable. That is the honest answer for a posting whose only specific
 * vocabulary is its legal boilerplate, and it is what the refusal path exists to say.
 *
 * A GENUINE PRIVACY POSTING IS UNHARMED, and the reason is its PRACTICE vocabulary rather than the
 * named instruments. Checked against Asana's Senior Privacy Engineer, the only real one on the
 * board: it keeps `compliance`, `data protection`, `regulatory` and `security`, while `gdpr` and
 * `ccpa` do not survive into its final twelve at all. Both tests are in jdMatch.test.ts: one pins
 * the footer out of the denominator, the other pins that a real privacy role stays scorable. */
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
privacy notice
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

/* `eg` and `ie` are the normalized forms of "e.g." and "i.e.", and they are in this list because a
 * prose connective is exactly as much of a requirement as "etc" is, which was already here.
 *
 * They were reaching the term set through TECH_MARKER rather than through the lexicon. normalizeTerm
 * deletes dots so that node.js and nodejs key the same, and the tokenizer trims the trailing dot, so
 * "(e.g. AWS)" arrives as the token "e.g" - which contains a '.', which is the punctuation that says
 * "technical name" - and left as `eg` in the denominator, marked signal, on the missing list. Every
 * JD that names examples has one. Fixing it in the stopword list rather than in TECH_MARKER is the
 * narrow move: the marker rule is what admits node.js, C# and CI/CD, and weakening it to spot Latin
 * abbreviations would cost far more than this enumeration of the two that actually occur. */
const GENERIC_STOPWORDS = new Set(
  `the and for with you your our are will from that this have their they who whom able use used
per via etc eg ie a an of to in on at by as is be we it its or if not but all any more most than then
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
 * A web address, which is a place to read about the job and never a thing to have done.
 *
 * These reach the term set through TECH_MARKER, because a domain contains dots and dots are the
 * punctuation that says "technical name" (node.js, ci/cd). Measured 2026-08-03 over the 400 newest
 * active postings: 130 of them, a third of the board, carried at least one, and they are marked
 * HARD SIGNAL, so under the EMPHASIS_LIMIT ranking they sort to the very TOP of the denominator.
 * SpaceX's "Financial Analyst" scored a finance resume against `spacexcom` as a weight-1
 * requirement. `wwwbitgocom` and `wwwredditinccom` did the same on two more.
 *
 * Same family as the company-name and branding exclusions above, and cheaper: it needs no context
 * at all, because the shape alone is conclusive. It also catches THIRD-PARTY addresses that no
 * company field could ever cover: e-verify.gov, ashbyhq.com, careers.toasttab.com.
 *
 * `.net` IS DELIBERATELY ABSENT from the suffix list. ASP.NET and C#.NET are on this board as real
 * stated requirements, and a rule that deleted them to catch a domain would be trading a
 * requirement for a nuisance, which is the trade PLACE_SAFE_KINDS exists to refuse.
 *
 * THE REST OF THE LIST IS THE COMMON CASES, NOT AN EXHAUSTIVE ONE, and the omissions are the same
 * trade rather than oversights. `.io`, `.ai` and `.co` are uncovered because socket.io, vercel.ai
 * and similar are real technology names, and the leading `www.` alternative already catches those
 * addresses when they are written in full. The `$` anchor also means an address carrying a path
 * survives, though the tokenizer splits on `/` so what reaches here is usually just the host.
 * Everything missed is a single nuisance term in one posting's denominator; everything wrongly
 * matched would be a real requirement deleted from every posting that states it.
 */
const WEB_ADDRESS = /^www\.|\.(com|org|gov|edu)$/i;

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
  /** How many times the posting names this term. Emphasis, in the employer's own hand: see
   *  EMPHASIS_LIMIT. Only used for ranking, never for scoring. */
  mentions?: number;
  /**
   * First appearance in the document among SCORED sections, as an offset. The last emphasis
   * tiebreak in capToEmphasis; ranking only, never scoring.
   *
   * "First appearance" means first ANYWHERE, not first within the section the term ended up in. A
   * term named in Responsibilities and later restated under Requirements is promoted to weight 1
   * but keeps its earlier, lower-weight offset. On the SWE_JD fixture `react` carries order 37
   * from the Responsibilities block while `python`, the opening term of the Requirements block,
   * carries 204, and both are weight 1. Since weight is compared first, that only decides ties
   * WITHIN a weight tier, where it reads as "the employer raised this earlier".
   */
  order?: number;
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
  if (WEB_ADDRESS.test(token)) return false;
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

/**
 * Words the posting uses to describe ITSELF, which are never things to put on a resume.
 *
 * Found by looking at a real posting in production rather than a fixture. The gap list read:
 * automation, Engineering Intern, Litos QA, Node.js, PostgreSQL, QA, React, Software Engineering,
 * Summer, TypeScript, United States. Five of those eleven are the posting's own company name, its
 * own job title, its season and its country. Litos was telling a student their resume "does not
 * mention" the name of the company they were applying to.
 *
 * The company and the role come from job_context, which the caller already has, so this is an
 * exact exclusion rather than a guess. The rest is a short list of the categories that recur:
 * seasons (from "Summer 2027"), and country and work-authorization phrasing.
 */
const SELF_REFERENCE = new Set(
  `summer spring fall winter autumn
united states usa canada remote hybrid onsite
intern internship co-op coop apprentice apprenticeship
candidate applicant university college student undergraduate`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * The posting's own places, which are requirements of the commute and never of the resume.
 *
 * Same class of bug as the company name, found the same way. Databricks' "Product Management Intern
 * (Summer 2027)" extracted 19 terms, of which `bellevue`, `wa`, `mountain view`, `ca` and
 * `san francisco` were five: the office list, harvested by the proper-noun rule, sitting in the
 * denominator and on the missing list. That list is not only displayed. It is the input to
 * gap-to-bullet, so the product was one click from offering to write a student a resume bullet
 * about Bellevue.
 *
 * MIN_SIGNAL_TERMS names city names as a known contaminant and defends against a term set that is
 * NOTHING but proper nouns. It cannot help here, because the same posting also mentions Python and
 * SQL in passing, so the signal floor clears while the denominator stays full of geography.
 *
 * The location comes from the row the caller already holds, so this is an exact exclusion like the
 * company and the role rather than a guess at which capitalized words are places. Both the raw
 * field and the canonical parse are folded in: the field says "Bellevue, Washington" while the
 * posting body says "Bellevue, WA", and only cities.ts knows those are one place.
 *
 * WHY THIS IS NOT SAFE ON ITS OWN, and what actually makes it safe: see PLACE_SAFE_KINDS below.
 * Place names collide with real requirements constantly. "Mobile, AL" and "Reading, UK" and "Split,
 * Croatia" and "Cork" and "Bath" are all real cities on real boards, and mobile, reading and split
 * are all terms a posting can genuinely require. Deleting one of those is WORSE than leaving the
 * geography in: a requirement the student lacks vanishes from the denominator, which INFLATES the
 * score, and vanishes from the missing list the student is supposed to act on.
 *
 * The curated lexicon catches some of the collisions (java, angular, oracle) and it is applied to
 * the whole normalized string as well as to each word, because a location field of exactly "Java"
 * normalizes to one token and would otherwise skip the per-word guard entirely. But the lexicon is
 * ~250 words and the collision set is open-ended: mobile, reading, split, cork, bath, salem,
 * sandwich, boring, chad and georgia are all outside it. A longer list is not the fix.
 */
function locationTokens(location: string | null | undefined): string[] {
  if (!location?.trim()) return [];
  const spellings = [location];
  for (const part of splitLocations(location)) {
    spellings.push(part);
    for (const place of parsePlace(part)) spellings.push(placeLabel(place));
  }
  const out: string[] = [];
  const admit = (value: string) => {
    // Guards the WHOLE string as well as each word. A bare-city field ("Java", "Oracle", "Angular")
    // produces a single token, so a guard that only ran inside the per-word loop never saw it.
    if (value.length > 1 && !inLexicon(value)) out.push(value);
  };
  for (const spelling of spellings) {
    const normalized = normalizeTerm(spelling);
    if (!normalized) continue;
    admit(normalized);
    for (const word of normalized.split(' ')) admit(word);
  }
  return out;
}

/**
 * The sections a place name may be deleted from, and the reason the location exclusion is safe.
 *
 * An employer states requirements in a Requirements or Preferred block and states its address in
 * prose. So a term that arrived from a STATED section is a requirement the employer wrote down on
 * purpose, and no location field may overrule it. "Mobile, AL" cannot delete a Requirements bullet
 * reading "Mobile development experience"; a posting in Java, Indonesia cannot delete "Java".
 *
 * The Databricks posting that opened ISSUE-014 has no requirements block at all: its 19 terms are
 * every one of them `body`, harvested from prose, which is exactly where an office list lives and
 * exactly where the exclusion still needs to fire. That is why the discriminator is the section
 * rather than the signal flag, which does not separate these at all: `ca` and `wa` are hard signal
 * (two-letter acronyms) while `mobile` and `reading` are not, so a signal-based guard would keep
 * the geography and delete the requirements, precisely backwards.
 *
 * THE RESIDUAL CASE, stated rather than hidden: on a posting with no stated sections, a genuine
 * body-prose requirement that is spelled the same as the posting's own city is still dropped. On
 * that evidence the two readings are indistinguishable and the location field is the only thing
 * either of them said out loud, so it wins.
 */
const PLACE_SAFE_KINDS: ReadonlySet<SectionKind> = new Set<SectionKind>(['body']);

/**
 * The company and the role, which are excluded from EVERY section rather than only from prose.
 *
 * Deliberately unlike the location exclusion above. A posting genuinely cannot require experience
 * with its own name or its own job title, wherever that name appears, so there is no collision to
 * defend against and no reason to narrow it by section.
 */
function selfReferenceTokens(context?: JdContext): Set<string> {
  const tokens = new Set(SELF_REFERENCE);
  for (const value of [context?.company, context?.role]) {
    if (!value) continue;
    const normalized = normalizeTerm(value);
    // The whole phrase AND each word: "Litos QA" must not survive as "Litos" or as "QA" either.
    tokens.add(normalized);
    for (const word of normalized.split(' ')) if (word.length > 1) tokens.add(word);
  }
  return tokens;
}

/**
 * The company's own name as it appears INSIDE a longer phrase, which is that company's branding.
 *
 * selfReferenceTokens excludes a term only when the whole term, or every word of it, is the
 * posting's own name. That leaves the half-stripped case: the Databricks posting from ISSUE-014
 * names "Databricks SQL", and because `sql` is not a self-reference word the bigram
 * `databricks sql` survived the strip and sat in the denominator as a requirement no resume can
 * match. A phrase carrying the employer's own name is that employer's product or team, and the
 * employer cannot require experience with its own branding any more than with its own name.
 *
 * WHY THE LEXICON GUARD, which is the same guard locationTokens uses and for the same reason. A
 * one-word company name that is also a real skill would otherwise delete real requirements through
 * every phrase it appears in: at a posting from Spring Health, `spring boot` is the requirement and
 * `spring` is the employer. So a company word that is itself a lexicon skill is not treated as
 * branding here. It stays excluded as a bare unigram, exactly as before; only the phrase rule
 * declines to act on it.
 *
 * Dropping the whole bigram never costs a real skill, because unigrams are extracted independently:
 * `databricks sql` goes and `sql` remains, on its own weight, matched and displayed on its own.
 */
function companyBrandTokens(company: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  const normalized = normalizeTerm(company ?? '');
  if (!normalized) return tokens;
  for (const word of normalized.split(' ')) {
    if (word.length > 1 && !inLexicon(word)) tokens.add(word);
  }
  return tokens;
}

export function extractJdTerms(jdText: string, context?: JdContext): JdTerm[] {
  const self = selfReferenceTokens(context);
  const places = new Set(locationTokens(context?.location));
  const brand = companyBrandTokens(context?.company);
  const excluded = (t: JdTerm, words: Set<string>) =>
    words.has(t.term) || t.term.split(' ').every((w) => words.has(w));
  // Only multi-word terms. A unigram equal to a brand word is already gone via `self`, and the
  // `some` test on a unigram would just be that same equality with none of the phrase reasoning.
  const branded = (t: JdTerm) =>
    t.term.includes(' ') && t.term.split(' ').some((w) => brand.has(w));
  const strip = (list: JdTerm[]) =>
    list.filter(
      (t) => !excluded(t, self) && !branded(t) && !(PLACE_SAFE_KINDS.has(t.kind) && excluded(t, places)),
    );

  const terms = strip(extractFrom(segmentJd(jdText)));
  if (terms.length >= MIN_SCORABLE_TERMS) return capToEmphasis(terms);

  // A noise heading runs until the next recognised heading, so a posting that OPENS with
  // "Compensation" or "Pay range" (mandatory first in pay-transparency states, and increasingly
  // common everywhere) can put the entire document inside a zero-weight section. The student was
  // then told the posting "does not list enough specific requirements" about a posting full of
  // them. When zeroing the noise leaves us unable to score, re-read those sections as ordinary
  // body prose rather than throwing the posting away.
  const salvaged = strip(
    extractFrom(
      segmentJd(jdText).map((section) =>
        section.kind === 'noise'
          ? { ...section, kind: 'body' as SectionKind, weight: SECTION_WEIGHT.body }
          : section,
      ),
    ),
  );
  return capToEmphasis(salvaged.length > terms.length ? salvaged : terms);
}

/**
 * How many requirements the score is computed over, however long the posting is.
 *
 * THIS IS THE FIX FOR ISSUE-023, and it is the denominator, not the thresholds. Measured
 * 2026-08-03 against the 400 newest active postings scored against three real production base
 * resumes: p50 = 3, p90 = 11, max = 57, and 1105 of 1107 scorable pairs read "Weak match". The
 * "Strong match" threshold of 65 was not merely hard to reach, it was unreached on the entire
 * board. A number that says the same word about every job tells a student nothing about which job
 * to spend an application on, which is the only thing they open this screen to find out.
 *
 * WHY THE THRESHOLDS WERE THE WRONG PLACE TO FIX IT. Lowering "Strong" to 25 makes the label
 * reachable and makes it a lie: it would sit next to a ring drawn one quarter full and a caption
 * reading "5 of 31 requirements", and a student can read all three at once. The label has to agree
 * with the count beside it, and the count was the part that was wrong.
 *
 * WHAT WAS ACTUALLY WRONG WITH THE COUNT. The old denominator was every term the posting mentions,
 * so it measured how much the employer WROTE rather than how well the student FITS. The same
 * student against the same kind of role scored 57 at bitgo (19 terms) and 37 at Reddit (21 terms)
 * while a Reddit posting listing 12 requirements padded its denominator with `chicago`, `every`,
 * `los angeles`, `moderators`, `san francisco`, `york city` and the company's own URL - seven of
 * twenty-one, all harvested from prose, none of them anything a resume could carry. Verbosity was
 * the dominant term in the score.
 *
 * WHAT THE NUMBER MEANS NOW: of the (at most) EMPHASIS_LIMIT things this posting emphasises most,
 * how many are on your resume. That is a question a one-page resume can answer well, it is stated
 * out loud in the caption the dashboard already renders ("N of M requirements"), and it is stable
 * across a 1.5k posting and a 6k one, so two postings' scores are finally comparable.
 *
 * WHY 12. Swept over the same 1200 pairs at 8/10/12/15/20 (see the sweep in the report on this
 * change). Below 10 the denominator gets small enough that one lucky term moves the score 12+
 * points and short postings start out-scoring good matches on noise. Above 15 the prose tail comes
 * back and the distribution flattens toward the old one. 12 also lands close to how many
 * requirements employers actually enumerate under a Requirements heading, so on the postings that
 * HAVE such a block the cap mostly does not bind and the score is simply that block's coverage.
 *
 * WHAT THE RANKING IS. Every input is already computed and already defended elsewhere in this file:
 *
 *   1. SECTION WEIGHT, which decides the ranking. The employer's own structure: a Requirements
 *      bullet outranks a line of culture prose because the employer put it under Requirements.
 *   2. MENTION COUNT, which breaks ties. Naming a thing four times is emphasis. This is what
 *      carries the 47% of postings with no requirements section at all: there every term is body
 *      prose at one weight, and repetition is the only thing left that the employer said on
 *      purpose. The alternative was alphabetical order, which is not a statement about the job.
 *   3. HARD SIGNAL, which does NOT enter the ranking, and reserves MIN_SIGNAL_TERMS slots instead.
 *      See below: this is the correction to the first version of this cap, and the reason it is
 *      structured so oddly is that both of the simpler orderings are measurably wrong.
 *
 * WHY HARD SIGNAL RESERVES SLOTS RATHER THAN SORTING FIRST. The first version of this cap sorted
 * hard signal above section weight, on the theory that the proper-noun rule is the loose one and so
 * should be what gets cut. Measured per resume rather than in aggregate, that was wrong, and badly:
 *
 *   - isHardSignal is `lexicon OR ACRONYM OR TECH_MARKER`, and ACRONYM is any 2-5 letter capital
 *     run. Acronyms are DENSE in exactly the prose this cap exists to remove: benefits tables,
 *     regulator names, country codes, requisition ids. Sorting on signal promoted all of it.
 *   - On non-technical postings the lexicon has almost nothing to say, so signal-first ranking had
 *     nothing left to promote but the acronyms. phonepe's Senior Executive Compliance kept `ca`,
 *     `cs`, `kyc`, `mba`, `npci`, `nps`, `rbi` and dropped `merchant compliance`, `risk
 *     management`, `change management` and `finance`. Bitpanda's Senior Specialist Compliance kept
 *     `austria`, `enjoy`, `europe`, `german`, `vienna` and dropped `compliance framework`,
 *     `governance management`, `oversight`, `policy`, `ethics`, `law` and `risk management`.
 *   - The cost is not cosmetic. Against a real UW law-and-policy base resume, signal-first ranking
 *     took the scores that were nonzero from 117 of 369 postings to 13, and the distinct values
 *     from 12 to 5. rankByFit sorts GET /jobs on this number, so her board lost nearly all of its
 *     fit signal and fell back to recency. The cap improved one of three real resumes and degraded
 *     the other two.
 *
 * Signal cannot simply be dropped from the ranking either, because a pure weight ordering CAN
 * manufacture a refusal: 12 proper nouns under a Requirements heading would evict every lexicon hit
 * from the set and push a genuinely scorable posting under MIN_SIGNAL_TERMS. Reserving exactly
 * MIN_SIGNAL_TERMS slots for hard signal satisfies both constraints at once. It is the smallest
 * guarantee that keeps the refusal path unreachable, and it costs 3 of 12 slots rather than all 12.
 *
 * THE BITPANDA CASE ABOVE IS NOT FIXED, and it is named here so the paragraph is not read as a
 * before-and-after. Its final twelve are `access, austria, enjoy, eric demuth, europe, founded,
 * german, governance, policies, policy, regulatory, vienna`, so it still drops `compliance
 * framework`, `oversight`, `ethics`, `law` and `risk management`. The reason is structural and
 * shared with 107 of the 398 scorable postings (27%): the posting is ONE undifferentiated section,
 * so every term ties on weight, and the document-order tiebreak then systematically prefers the
 * company blurb at the TOP of the posting over the requirements at the bottom. On a posting with
 * real section headings that ordering is a statement about the job; on this shape it is a statement
 * about layout. The phonepe case IS fixed, because it has a Requirements heading for weight to act
 * on. Fixing the Bitpanda shape needs better section detection, not a better tiebreak.
 *
 * WHAT THE CAP DROPS, stated accurately. It drops the lowest-weight, least-repeated terms, subject
 * to the three reserved slots. That is NOT the same as dropping only junk, and an earlier draft of
 * this comment claimed it was. On a posting with no requirements section every term is body prose
 * at one weight, so the cut there is made almost entirely on mention count and is only as good as
 * that signal. What the cap guarantees is a stable denominator and the employer's own section
 * structure deciding what is in it; it does not and cannot repair extraction. The three residuals
 * that the smaller denominator makes MORE expensive, rather than less, are listed at the foot of
 * this comment block.
 *
 * A dropped term leaves both the score AND the gap list, which is the honest pairing: the product
 * does not show a student a requirement it has declined to count, and gap-to-bullet is no longer
 * offered 30 chips of which two thirds are prose.
 *
 * THREE KNOWN RESIDUALS THIS CAP AMPLIFIES, because a slot is worth ~8 points instead of ~3:
 *
 *   - OR-ALTERNATIVES. "React, Angular, Vue or Scala" is one requirement written four ways, and it
 *     is extracted as four terms. It used to consume 4 of ~30 slots and now consumes 4 of 12, so a
 *     React student is charged three times for a requirement they meet. This is the largest single
 *     source of understatement left in the model and it needs "one of X, Y, Z" parsing.
 *   - SUBSUMPTION. `excel` and `microsoft excel` both survive, because the subsumption pass spares
 *     a part that is a lexicon skill in its own right. One requirement, 2 of 12 slots.
 *   - PLACE ACRONYMS. `ca` and `wa` are ACRONYM, therefore hard signal, therefore eligible for the
 *     reserved slots, and PLACE_SAFE_KINDS deliberately declines to remove a place name from a
 *     stated section. Reserved slots are filled in weight-then-mentions order, which no longer
 *     puts them at the top, but it does not exclude them.
 */
export const EMPHASIS_LIMIT = 12;

/**
 * Keep the EMPHASIS_LIMIT most-emphasised terms, then restore display order.
 *
 * Membership is decided in two passes, for the reason set out at EMPHASIS_LIMIT: MIN_SIGNAL_TERMS
 * slots are reserved for hard signal so the cap can never push a scorable posting under the signal
 * floor, and every remaining slot is filled by the employer's own section structure so acronym
 * boilerplate cannot evict a stated requirement.
 *
 * The RETURNED order is unchanged from before this cap existed (weight descending, then
 * alphabetical): `missing` is rendered in that order and "highest-weight unmet requirement first"
 * is still what a student wants at the front of the gap list. Emphasis decides membership only.
 */
function capToEmphasis(terms: JdTerm[]): JdTerm[] {
  if (terms.length <= EMPHASIS_LIMIT) return terms;
  // The one ordering both passes use: the employer's structure, then how often they said it, then
  // where they said it first.
  //
  // DOCUMENT ORDER IS THE LAST TIEBREAK, NOT ALPHABETICAL ORDER, and on a compliance or legal
  // posting that is the difference between a denominator of requirements and a denominator of
  // acronyms. A requirements block is usually ONE section at ONE weight with most terms named ONCE,
  // so weight and mentions both tie across nearly the whole block and the last tiebreak decides
  // membership on its own. Alphabetical order handed those slots to `aml`, `ca`, `cs`, `kyc` and
  // `mba` and cut `risk management` and `regulatory reporting`, purely because of how the words are
  // spelled. Where the employer raised something is at least a statement about the job; how it is
  // spelled is not.
  //
  // WHAT `order` ACTUALLY IS, because the tiebreak is only as good as its definition: first
  // appearance in the document among SCORED sections, NOT first appearance within the section the
  // term was finally filed under. A term promoted from Responsibilities to Requirements keeps its
  // earlier offset (see JdTerm.order). Because weight is compared first, this only ever decides
  // ties inside one weight tier, which is the case it was built for.
  const byEmphasis = (a: JdTerm, b: JdTerm) =>
    b.weight - a.weight ||
    (b.mentions ?? 1) - (a.mentions ?? 1) ||
    (a.order ?? 0) - (b.order ?? 0) ||
    a.term.localeCompare(b.term);

  const ranked = [...terms].sort(byEmphasis);
  // Keyed on `term`, which is the identity the rest of this module already dedupes on (byTerm in
  // extractFrom is keyed the same way). Keying on the object would have made membership depend on
  // whether the strip pass in extractJdTerms happened to hand back the same JdTerm instances, which
  // is a coupling nothing states and nothing tests.
  const kept = new Map<string, JdTerm>();
  // Pass 1: the reservation. Taken in emphasis order too, so the hard-signal terms this keeps are
  // the ones the employer stated most prominently rather than whichever acronym sorts first.
  for (const t of ranked) {
    if (kept.size >= MIN_SIGNAL_TERMS) break;
    if (t.signal) kept.set(t.term, t);
  }
  // Pass 2: everything else, purely by emphasis. Any reserved term that would have been picked here
  // anyway simply costs nothing, which is the common case on a posting with a requirements block.
  for (const t of ranked) {
    if (kept.size >= EMPHASIS_LIMIT) break;
    if (!kept.has(t.term)) kept.set(t.term, t);
  }
  return [...kept.values()].sort((x, y) => y.weight - x.weight || x.term.localeCompare(y.term));
}

function extractFrom(sections: JdSection[]): JdTerm[] {
  const byTerm = new Map<string, JdTerm>();
  // A character offset, not a counter over the extraction passes.
  //
  // A counter would have ordered every unigram in a section ahead of every bigram in it, because
  // the bigram pass runs second. On a compliance posting that put `aml`, `ca`, `kyc` and `mba`
  // ahead of `risk management` and `regulatory reporting` for no reason but the shape of the loop,
  // which is precisely the arbitrary tiebreak document order exists to replace. Offsets are taken
  // within a section and rebased onto a running total so sections stay in order.
  //
  // PRECISELY: an offset into the concatenation of the SCORED sections, not into the raw posting.
  // The `continue` below skips zero-weight sections before the rebase at the foot of the loop, so
  // noise never advances the base and a term after a long EEO footer sorts as though the footer
  // were not there. Ordering stays monotone in document order, which is all the tiebreak needs.
  //
  // One consequence worth naming: the salvage pass in extractJdTerms re-reads noise sections as
  // body, so those sections DO advance the base on that pass. The same term can therefore carry a
  // different `order` between the two passes. Harmless, because only one pass's output is ever
  // returned and the ordering within each is self-consistent, but it means `order` is not a stable
  // identifier for a term across calls and must not be used as one.
  let sectionBase = 0;

  for (const section of sections) {
    if (section.weight === 0) continue;

    const tokens = tokenizeSection(section.text);

    // Unigrams. Match on the original casing so isSpecific can see proper nouns.
    for (const tok of tokens) {
      if (!isSpecific(tok.text, tok.positional, tok.nextIsCapitalized)) continue;
      const term = normalizeTerm(tok.text);
      const existing = byTerm.get(term);
      // The count survives the weight upgrade below: a term named three times in prose and once
      // under Requirements was named four times, and it is the total that measures emphasis.
      const mentions = (existing?.mentions ?? 0) + 1;
      if (!existing || section.weight > existing.weight) {
        byTerm.set(term, {
          term,
          display: tok.text,
          weight: section.weight,
          kind: section.kind,
          signal: isHardSignal(tok.text),
          mentions,
          order: existing?.order ?? sectionBase + tok.start,
        });
      } else {
        existing.mentions = mentions;
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
      const mentions = (existing?.mentions ?? 0) + 1;
      if (!existing || section.weight > existing.weight) {
        byTerm.set(term, {
          term,
          display: `${a.text} ${b.text}`,
          weight: section.weight,
          kind: section.kind,
          signal: isHardSignal(a.text) || isHardSignal(b.text),
          mentions,
          order: existing?.order ?? sectionBase + a.start,
        });
      } else {
        existing.mentions = mentions;
      }
    }

    sectionBase += section.text.length;
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

/**
 * Last-resume memo for the haystack `resumeCovers` searches.
 *
 * The resume is loop-invariant and the term is not: scoreJdMatch calls resumeCovers once PER TERM,
 * so a posting with 40 requirements re-derived the same normalized resume 40 times, and GET /jobs
 * ranking a pool of postings against one resume did that for every posting in the pool — thousands
 * of identical normalizations of an unchanging string per request.
 *
 * One entry is the right size. Every caller works through a single resume at a time (one posting's
 * terms, or one pool ranked against one resume), so a single slot hits on everything after the
 * first call and a larger cache would only add eviction policy to a problem that does not have one.
 * Keyed on the exact string, so a changed resume simply misses and refills; there is no staleness
 * window and nothing to invalidate.
 */
let lastResumeInput: string | null = null;
let lastResumeHaystack = '';

function resumeHaystack(resumeText: string): string {
  if (resumeText !== lastResumeInput) {
    lastResumeHaystack = ` ${normalizeTerm(stripAcademicTerms(resumeText))} `;
    lastResumeInput = resumeText;
  }
  return lastResumeHaystack;
}

export function resumeCovers(resumeText: string, term: string): boolean {
  const hay = resumeHaystack(resumeText);
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
export function scoreJdMatch(
  resumeText: string,
  jdText: string,
  context?: JdContext,
): JdMatchResult {
  const terms = extractJdTerms(jdText, context);

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
 *
 * THE THRESHOLDS DID NOT MOVE FOR ISSUE-023, and that is the point of fixing the denominator
 * instead. They now sit against a bounded set rather than an unbounded one, because the cap holds
 * the requirement count at EMPHASIS_LIMIT or fewer.
 *
 * THE SCORE AND THE CAPTION ARE NOT THE SAME ARITHMETIC, and a reader of this file needs to know
 * that before reasoning about the anchors below. scoreJdMatch accumulates got/total by SECTION
 * WEIGHT (1 required, 0.7 responsibilities, 0.6 preferred, 0.4 body), while MatchScore.tsx renders
 * an UNWEIGHTED "N of M". They coincide only when every kept term carries the same weight.
 *
 * So the anchors are stated for the equal-weight case, which is the one a reader can check:
 *
 *   65  is 8 of 12 when the twelve are equally weighted. "You have most of what they emphasise."
 *   40  is 5 of 12 when the twelve are equally weighted. "You have some of it."
 *
 * When the weights differ the same COUNT spans a range, and the spread is wide enough to matter.
 * On the SWE_JD fixture, which keeps 8 terms at weight 1 and 4 at 0.7 for a total of 10.8, "8 of
 * 12" is 74 if the eight are the weight-1 terms and 63 if they are not, so it straddles the
 * "Strong match" line. That is intended: covering the Requirements block is worth more than
 * covering the same number of Responsibilities lines, which is the whole reason for the weights.
 * It does mean the caption cannot be used to predict the band, and neither number is wrong.
 *
 * Measured after the fix, over the 400 newest active postings against three real base resumes:
 * "Strong match" fires on 2 of 1116 scorable pairs, and both are the right ones. Both belong to the
 * USC CS student carrying React/TypeScript/Node/Postgres/Docker: bitgo's Backend Engineer E2 at 68
 * (8 of 12) and OpenAI's Software Engineer, API Multimodal at 70 (4 of 6).
 *
 * The second one is worth reading twice, because it is the weighting and the caption coming apart
 * exactly as described above: 4 of 6 scores HIGHER than 8 of 12. That posting states six
 * requirements and the student has four of the heaviest, which is a better fit than eight of twelve
 * and is what the number is supposed to say.
 *
 * Narrowed to that student's own field, 75 software-titled postings run p50=23, p75=33, p90=42,
 * max=68, a real spread rather than the flat line the old denominator produced. Reachable, and
 * still meaning what it says.
 *
 * WHY THE BOTTOM BAND WAS RENAMED. "Weak match" is the only one of these four labels that grades
 * the STUDENT rather than describing the pair, and on a board where most postings are in someone
 * else's field it is the one they read most. The number underneath it is honest and should not be
 * inflated to spare anyone: a first-year undergraduate really does not match a Staff Engineer role.
 * But the honest content of a low score is "this posting asks for things that are not on your
 * resume", not "you are weak", and the label is free to say the true thing in the words that are
 * actually about the job. The tone stays 'weak', so nothing about the styling changes.
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
  return { label: 'Not much overlap', tone: 'weak' };
}
