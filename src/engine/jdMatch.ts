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
 *
 * WAS 6, LOWERED TO 4 on 2026-08-03 as the other half of preferStatedRequirements. That pass drops
 * `body` prose whenever the employer stated requirements of their own, and a posting that states
 * four is common: Databricks' PM intern names three requirements and one responsibility. At a floor
 * of 6 the drop could not fire on those postings, so the honest four-term denominator was padded
 * back up with the culture paragraph rather than being allowed to stand.
 *
 * Measured over 600 live postings and the six real base resumes on the system, against the same
 * board scored on-field vs off-field:
 *
 *   floor 6   separation 6.5 points (2.47x)   14 of 600 more postings refuse
 *   floor 4   separation 7.0 points (2.59x)
 *
 * Four terms is a smaller denominator than this file used to allow, and that is the point: a score
 * over four things the employer actually asked for says more than a score over twelve things where
 * eight came from the prose around them.
 */
export const MIN_SCORABLE_TERMS = 4;

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

/**
 * The subject of an "About ..." heading when that subject is the CANDIDATE rather than the employer.
 *
 * ONE STRING, INTERPOLATED INTO TWO PATTERNS, and that is the entire point of it existing. The noise
 * rule below excludes these forms and the `required` rule claims them, and a form that appears in
 * one list but not the other does NOT fall back to prose: it becomes an UNRECOGNISED heading, which
 * is strictly worse than either, because it fails to close the section above it and the requirements
 * inherit whatever weight that section had. Two hand-maintained copies drift; one constant cannot.
 *
 * The first version of this fix WAS two copies, and they drifted within the same commit. The noise
 * lookahead was written `\s+` and the required alternative was written with a literal space, so
 * "About You" classified but "About  You" (two spaces), "About\tYou" and "About You" - the
 * non-breaking space a scraped ATS page emits - matched neither and landed in exactly the
 * unrecognised gap described above. Zero live postings on the 2026-08-04 board spelled it that way,
 * so nothing was measurably broken, but that is the same latent shape as the U+2019 defect in
 * headingCore, which also looked impossible until a posting arrived spelling it that way.
 *
 * `\s+` everywhere, therefore, including INSIDE the multiword forms.
 */
const SECOND_PERSON_SUBJECT = String.raw`(you|yourself|the\s+ideal|our\s+ideal|the\s+candidate)`;

// Heading matchers, longest-intent first. Order matters: "preferred qualifications" must be tested
// before "qualifications", or every preferred block scores as required.
const HEADING_PATTERNS: Array<{ kind: SectionKind; re: RegExp }> = [
  // `^about\b` rather than the old `about (us|the company|our)`. A heading-shaped line opening with
  // "About" is USUALLY a company or team blurb, and the enumerated form missed every posting that
  // names itself: "About OpenAI", "About PhonePe Limited:", "About the Team". OpenAI's "Counsel,
  // Litigation" was the case that found it, and the cost was not the blurb but everything AFTER it,
  // because an unrecognised heading does not close the section it interrupts. See NOISE_BLOCK.
  //
  // "USUALLY", NOT "ALWAYS", AND THE EXCEPTION IS SECOND PERSON. The widened rule reads the subject
  // of the blurb off the word after "About", and when that word is the CANDIDATE rather than the
  // employer the heading is introducing requirements, not marketing: "About You", "About you:",
  // "About the candidate". Measured read-only against the prod board 2026-08-04, 1,304 of 20,931
  // active postings (6.2%) head a section this way, and every one of them was scoring at weight 0.
  //
  // StockX's "Software Development Engineer in Test" (job 6f39c23b) is the shape: "What you'll do"
  // opens responsibilities, "About You" opens the stated requirements, "Nice to have skills" opens
  // preferred. Zeroing the middle block did not merely drop it, it left the denominator to fill
  // from the responsibilities prose around it - `understand brds`, `prds`, `qa`, `regression` -
  // while "3+ years Web and Mobile Automation Testing", `JavaScript/TypeScript`, `Git` and `CI-CD`,
  // the things the employer actually asked for, sat at zero. See the fixture in jdMatch.test.ts.
  //
  // THE EXCLUSION HERE AND THE `required` ALTERNATIVE BELOW ARE ONE RULE, which is why both read
  // SECOND_PERSON_SUBJECT instead of spelling the forms out twice. See the note on that constant
  // for what a drift between the two costs.
  //
  // `you\b` and not `you`, so "About your role:" - cresta's spelling of "About the Role" - keeps
  // its noise classification. The possessive is the employer describing the job; the bare pronoun
  // is the employer describing the reader. The same `\b` keeps every employer whose name starts
  // with those letters out: "About Youth Programs", "About Yousign", all still noise.
  //
  // TWO SEPARATE DEFECTS LIVE IN THIS ONE PATTERN and were found a day apart, so the notes below
  // are kept whole rather than blended: the second-person exception above (who the blurb is ABOUT)
  // and the process-and-logistics footer below (what closes a section). They meet only here, in the
  // merged vocabulary, and they do not interact: "About the interview process" still opens noise,
  // because the lookahead declines only the four candidate-subject forms.
  // THE PROCESS-AND-LOGISTICS FOOTER, added 2026-08-04 for ISSUE-026. Same failure the `^about\b`
  // note above describes, one section later: psiquantum's "Intern, Quantum Architecture" ends its
  // requirements bullets and then writes the heading-shaped line "The interview process". That line
  // passes isHeadingLine and matched NOTHING here, so it did not CLOSE the required section, and
  // everything below it - the interview paragraph, the background-check paragraph, the hourly-rate
  // table and the EEO block - was read as REQUIRED at weight 1. Its twelve extracted requirements
  // were `C++, Computer Science, GitHub, Housing, HR, Math, Once, Physics, Police Check, Python,
  // Rate, ZX`: five of twelve unmatchable by any resume. The uncapped set was fifteen terms, seven
  // of them from this footer, so the junk did not merely sit in the denominator - it filled the cap
  // and evicted `FBQC`, the one term the responsibilities block names twice. Every score on this
  // posting was depressed by ~40 points of noise the dashboard tooltip called "requirements".
  //
  // AFTER all three ISSUE-026 changes the posting extracts eight terms, every one of them stated:
  // `C++, Computer Science, FBQC, GitHub, Math, Physics, Python, ZX`. Against the SWE base resume in
  // jdMatch.test.ts the score moves 17 -> 26 and the missing list stops naming Housing, HR, Once,
  // Police Check and Rate at a student. The BOARD-WIDE score barely moves (mean 4.9 -> 5.1 over 400
  // postings) and that is expected rather than disappointing: EMPHASIS_LIMIT refills the vacancy, so
  // removing junk mostly changes WHICH twelve, not how many. What it buys is that the twelve, and
  // the gap list built from them, are things a student can actually act on.
  //
  // `hourly rate|pay rate|stipend` are here as well as the process words because the pay table is
  // the part that survives when a posting has no process heading: "Hourly Rate" and
  // "Housing/Commuter Stipend" are each their own heading-shaped line in that table. `compensation`
  // and `salary` were already here and do not reach either spelling.
  //
  // SAFE FOR THE SAME REASON THE REST OF THIS LIST IS, and NOT for the reason NOISE_BLOCK is: every
  // pattern here is gated by isHeadingLine, so it can only fire on a line under 60 characters and 7
  // words that is not a bullet. "Ability to explain the interview process to candidates" is 9 words
  // and never reaches this test. NOISE_BLOCK has the wider 16-word budget and is where an addition
  // needs the measurement its comment demands; this list does not.
  //
  // MEASURED ANYWAY, 2026-08-04, over 400 live postings pulled full-text from the production board.
  // The four new patterns fire on 27 heading lines across that corpus and every one of them is a
  // benefits or hiring-process line: "Annual Benefits Stipend: $8,453", "Monthly wellness stipend",
  // "Commuter stipend", "INTERVIEW PROCESS", "Use of AI in Our Hiring Process", "WHAT DOES THE
  // HIRING PROCESS LOOK LIKE?". Zero requirement lines. They change the extracted set on 4 of the
  // 400, which is the honest size of this fix: it is narrow, and it is the layer that fixes the
  // posting it was written for. The other two ISSUE-026 changes measure 138 of 400 and 8 of 400.
  //
  // THE TWO CASES WORTH READING, because they look like losses and are not. These patterns are the
  // ONLY one of the three ISSUE-026 changes that drops anything touching SKILL_LEXICON, and both
  // drops are the same shape:
  //
  //   Block, "Regulatory Examination Manager" and "Lending Regulatory Counsel", drop `ai` (plus
  //   `afterpay` and `cash app`) from the footer under "Use of AI in Our Hiring Process" - "We may
  //   use automated AI tools to evaluate job applications". That is Block telling applicants how it
  //   screens them, not a requirement to know AI.
  //
  //   Monzo, "Lead Machine Learning Scientist", drops the bigram `ml modelling`, which reads like a
  //   requirement until you find it: "The interview process: ... 60 minute ML Modelling interview".
  //   It is the name of an interview STAGE. `ml`, `mlops`, `llms`, `rag`, `python` and `sql` all
  //   survive from the requirements block above it.
  //
  // A lexicon hit inside a hiring-process disclosure is still a hiring-process disclosure. This is
  // the only section-based route by which a lexicon skill leaves the denominator at all, and on
  // this corpus it has not once removed a stated requirement.
  { kind: 'noise', re: new RegExp(String.raw`^about\b(?!\s+${SECOND_PERSON_SUBJECT}\b)|\b(who we are|our (story|mission|values|culture)|benefits|perks|what we offer|compensation|salary|pay range|hourly rate|pay rate|stipend|equal opportunity|eeo|diversity|accommodation|privacy|how to apply|why join|interview process|hiring process|selection process|background check)\b`, 'i') },
  { kind: 'preferred', re: /\b(preferred|nice[- ]to[- ]have|bonus|plus(es)?|desired|good to have|additional qualifications)\b/i },
  // `what we('?re)? look(ing)? for` and `(your|the) impact`, not the tighter `what we're looking
  // for` / `your impact` they replaced. Databricks' "Product Management Intern (Summer 2027)"
  // heads its two real sections "What we look for:" and "The impact you will have:". Both pass
  // isHeadingLine; neither matched, so the whole posting stayed `body` at 0.4 and the denominator
  // filled from the culture paragraph instead: 8/100 built from `genie`, `unity catalog`,
  // `ai platform` and `streaming` - the sentence naming the TEAMS Databricks hires across - while
  // "first hand experience with SQL and/or Python" never reached weight 1. A near-miss on a
  // heading does not cost you the heading, it costs you every line under it.
  // `about SECOND_PERSON_SUBJECT` is the other half of the exclusion carved out of the noise rule
  // above, reading the same constant so the two cannot drift. It is reached only because noise
  // declines these forms first.
  { kind: 'required', re: new RegExp(String.raw`\b(requirements?|qualifications?|what you'?ll need|what we('?re)? look(ing)? for|must[- ]have|minimum|basic qualifications|skills?|you have|your background|about\s+${SECOND_PERSON_SUBJECT})\b`, 'i') },
  { kind: 'responsibilities', re: /\b(responsibilities|what you'?ll do|the role|(your|the) impact|day[- ]to[- ]day|in this role|duties)\b/i },
];

/**
 * A line is treated as a heading when it is short, not a sentence, and not a bullet. JD headings in
 * scraped text lose their markup, so shape is all we have: "Requirements" / "REQUIREMENTS" /
 * "What you'll do:" all survive this, while a 20-word sentence containing the word "requirements"
 * does not.
 */
/**
 * Strip the decoration a heading arrives wrapped in: "## Requirements", "**Requirements**".
 *
 * IT ALSO FOLDS TYPOGRAPHIC APOSTROPHES TO THE ASCII ONE, and that is not cosmetic. Every
 * apostrophe in HEADING_PATTERNS is written `'`, because a regex literal in this file is typed on a
 * keyboard. Real postings are not: a scraped ATS page carries U+2019 (and U+2018, and the modifier
 * letter U+02BC) because that is what a rich-text editor produces. So "What We're Looking For" and
 * "What You'll Do" matched, and the curly spellings of the same two headings did not.
 *
 * The cost of that near-miss is not the heading. It is EVERY LINE UNDER IT, for the reason set out
 * at NOISE_BLOCK: an unrecognised heading does not close the section above it. Measured on cresta's
 * "Software Engineer Intern" (job 6e584f84, 7867 characters, found on a real Pro account
 * 2026-08-04), the posting opens with "About the Role", which the noise pattern's `^about` rule
 * correctly zeroes. The next two headings are the curly spellings of "What You'll Do" and "What
 * We're Looking For", so neither closed it: the entire stated-requirements block sat at weight 0
 * and the only scorable text left was the four paragraphs of company marketing at the top. The
 * twelve "requirements we counted" were `AI, Born, CEO, Cox, Google, Greylock, Marriott, Ping,
 * Sequoia, Stanford AI, United Airlines, Vertex AI`, the student matched `AI` alone, and the review
 * screen printed 8/100 next to a resume Litos had itself tailored to that posting.
 *
 * The salvage pass in extractJdTerms did not catch it either, and could not have: it re-reads noise
 * sections only when zeroing leaves the posting UNSCORABLE, and twelve investor names clear
 * MIN_SCORABLE_TERMS comfortably. A confidently wrong number is exactly the failure it cannot see.
 *
 * normalizeTerm already folds these characters at the token layer. This is the same fold, at the
 * layer that decides what those tokens are worth.
 */
function headingCore(line: string): string {
  return line
    .trim()
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\*\*|\*\*$/g, '')
    .replace(/^__|__$/g, '')
    // U+2018 / U+2019 curly quotes and U+02BC modifier letter apostrophe, all written as `'` in
    // HEADING_PATTERNS. Folded before any pattern is tested, never after.
    .replace(/[‘’ʼ]/g, "'")
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
 * credentials (RN, NP, BLS), no teaching certifications, no newsroom systems.
 *
 * COMPLETING THAT PASS WAS ATTEMPTED, MEASURED, AND DEFERRED (2026-08-04). ISSUE-033 IS STILL OPEN.
 * ---------------------------------------------------------------------------------------------
 * An extension to 341 entries, covering finance, law, health, education, HR, operations and media,
 * was built and measured against 400 live postings and the three real base resumes. It was NOT
 * shipped, and the reason is a property of the DENOMINATOR rather than of the entries:
 *
 *   EMPHASIS_LIMIT caps the denominator at 12 and most postings sit at the cap, so admitting a new
 *   term does not add a slot, it EVICTS one. On `Marqeta / Corporate-Opex Finance Manager` four new
 *   finance entries took slots and pushed `modeling` out, and a resume listing "Excel financial
 *   modeling" lost the credit: that posting fell from rank 1 to rank 180 for the finance resume.
 *
 * A bigger lexicon is therefore not free and not monotonic. It needs to be staged per discipline and
 * measured per resume against the cap, which is a separate piece of work from writing the entries.
 *
 * WHAT WAS LEARNED IS KEPT HERE EVEN THOUGH THE ENTRIES WERE NOT, because the measurement cost more
 * than the list did. Every candidate was searched for in the SCORED sections of that corpus and the
 * surrounding sentences were READ; a candidate that occurs and reads as prose was rejected however
 * obviously it belongs to the discipline. That test rejected more than it admitted:
 *
 *   stakeholder   "align stakeholders", "business stakeholders" - generic corporate prose
 *   quality       "high standards of quality", "quality and reliability" - an adjective
 *   equity        "competitive equity grants", "eligible for equity" - COMPENSATION
 *   mentorship    "Mentorship: you'll build a relationship with a mentor" - a PERK
 *   portfolio     "a portfolio of fulfillment integrations" - never the finance sense
 *   assessment    "Video Assessment Challenge", "security assessments" - the hiring process
 *   motion        "motion systems", "motor starters" - machinery, never a legal motion
 *   ordinance     every hit was the "fair chance ordinances" line in the EEO footer
 *
 * AND FOUR NAME COLLISIONS THAT NO AMOUNT OF DOMAIN REASONING WOULD HAVE CAUGHT, which are the most
 * valuable thing the exercise produced:
 *
 *   epic          Epic the EHR vendor to a health resume; Epic Games on this board
 *   cpt           Curricular Practical Training, not Current Procedural Terminology
 *   cna           CVE Numbering Authority, not Certified Nursing Assistant
 *   greenhouse    the ATS RUNNING THE APPLICATION, in the hiring-process footer
 *
 * A term can be perfectly unambiguous inside its discipline and mean something else entirely on a
 * job board. Read the corpus; do not reason from the discipline.
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
 * PLURALS. inLexicon strips a trailing `s` for tokens over three characters, so THE ENTRY SHOULD
 * ALWAYS BE THE SINGULAR and it then covers both spellings. `sanctions` is deliberately plural-only,
 * because "sanction" alone is a common verb. `appropriations` used to be a silent second exception
 * and is now stored as `appropriation`.
 *
 * THE RULE IS STATED HERE AND ENFORCED NOWHERE, which is worth knowing before trusting it. An
 * earlier draft claimed the rule was "inferable from the data"; it is not. Many entries end in `-s`
 * without being plurals at all - `kubernetes`, `pandas`, `redis`, `analytics`, `statistics`,
 * `devops`, `saas` - so `sanctions` is visually indistinguishable from that group. A reader cannot
 * recover the convention by looking, and no test checks it. Follow it because it is written down.
 *
 * `sas` AND `sass` ARE NOT A SINGULAR/PLURAL PAIR and neither is redundant. They are two unrelated
 * products, the statistics package and the CSS preprocessor, that happen to differ by an s. A review
 * read them as a redundant pair; deleting either would lose a real skill.
 *
 * NO ENTRY HERE MAY ALSO BE IN BOILERPLATE OR GENERIC_STOPWORDS, because isDenied is consulted
 * BEFORE inLexicon in isSpecific, so a colliding entry is DEAD - it can never be admitted and the
 * list overstates its own coverage. Two were dead and had been since they were written: `next`
 * (BOILERPLATE carries it for "next level") and `recruiting` (for "we are recruiting"), which means
 * the HR line did not in fact cover the word recruiting. Both are removed rather than rescued: the
 * prose senses are frequent and BOILERPLATE is the load-bearing side. `next` is replaced by
 * `nextjs`, which is what normalizeTerm makes of "Next.js" and does not collide.
 *
 * jdMatch.test.ts asserts the collision set stays empty for the exact spelling AND for the entry's
 * singular, since isDenied tests singular(token) too. It does NOT assert the reverse: a deny-list
 * plural over a lexicon singular is not a collision, because isDenied singularises the token and
 * never the list. `excels`/`excel` is that case on purpose.
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
react angular vue svelte nextjs nuxt node deno express django flask rails spring laravel fastapi
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
policy zoning procurement grantmaking appropriation
aml kyc sanctions fincen finra sec hipaa ferpa osha eeoc nlrb sox pci
epidemiology biostatistics phlebotomy triage pharmacology immunology histology
pedagogy iep literacy tutoring
payroll ergonomics
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

/* THE BENEFIT-AND-LOGISTICS BLOCK (`stipend` through `screening`), added 2026-08-04 for ISSUE-026.
 * This is the SECOND line of defence on the psiquantum footer described at HEADING_PATTERNS, and it
 * is worth being exact about which line actually does the work, because the two are not equivalent:
 *
 *   heading fix only   8 terms, all 8 genuine requirements
 *   this list only    10 terms, still carrying `HR` and `Near`
 *   both              8 terms, all 8 genuine requirements
 *
 * So the heading fix carries this posting on its own and this list changes nothing on it. It is
 * here for the shape the heading fix cannot see: the same pay table written as bullets, or as one
 * run-on line, or under a heading nobody thought to enumerate. `housing`, `commuter` and `stipend`
 * are the terms that posting actually produced; the rest of the row is the same vocabulary at the
 * same specificity, which is the standard the `privacy` note above sets.
 *
 * Over 400 live postings pulled full-text from the production board on 2026-08-04 it changes the
 * extracted set on 8 of them, so its value is almost entirely insurance rather than measured yield.
 * That is stated because it is the kind of list that grows on intuition, and the number to beat
 * before adding to it is 8 in 400.
 *
 * `completion` AND `completed` WERE IN THIS LIST AND WERE REMOVED, and the reason is a general
 * caution about stop-lists rather than a fact about those two words. The pay table's degree column
 * reads "PhD: Near Completion", which extracts as the bigram `near completion`. Denying `completion`
 * does not delete that requirement, it UNMASKS `Near` as a unigram - a strictly worse term, since it
 * is a preposition rather than an identifiable piece of boilerplate. That is measured, not reasoned:
 * the vocab-only run above shows `Near` in the ten. A deny-list entry that breaks a junk bigram into
 * junk parts has moved the problem, so any addition here needs checking against what the SURVIVING
 * unigrams would be, not just against the term it targets.
 *
 * `rate` IS THE ARGUABLE ENTRY and it is taken deliberately. It costs the bigram `conversion rate`
 * on marketing postings, which is a real thing to have done. It is kept because "Hourly Rate",
 * "Rate", "Pay Rate" is the head of the compensation table on every posting that has one, `hourly`
 * was already denied here for exactly that reason, and `conversion` survives on its own as the term
 * a marketing resume is actually matched on.
 *
 * `hr` IS NOT HERE, though `HR` was one of the five junk terms on the psiquantum posting. It came in
 * through the ACRONYM rule out of "at least two interviews with the hiring team and HR", which is
 * the interview paragraph and is now noise. HR work is a real discipline this file already serves
 * (`recruiting`, `payroll` are in SKILL_LEXICON), so denying the acronym would delete a stated
 * requirement from every HR posting to fix one sentence in a physics one. Same trade
 * NON_REQUIREMENT_ACRONYMS refuses for `mba` and `phd`. */

/* THE MONTH NAMES ARE HERE BECAUSE A DATE IS NOT A REQUIREMENT, and they were expensive. Measured
 * 2026-08-04 over 400 live postings, in the FINAL capped denominator, they were the single largest
 * block of junk left: a start date or an application deadline occupying a slot on a substantial
 * share of the board. They arrive as proper nouns, which is the loose path, and they are not merely
 * dead weight: a student resume dates every entry, so "June 2025" on a resume MATCHED `june` in a
 * trading firm's denominator and paid the student a twelfth of a score for having graduated in the
 * right month. stripAcademicTerms removes a season followed by a year from the RESUME for exactly
 * this reason; this is the same bug on the JD side. `may` is not listed because GENERIC_STOPWORDS
 * already carries it as the modal verb.
 *
 * `whether`, `actual`, `additionally` and `expect` are the prose connectives left after the same
 * census, and `stem`, `gpa`, `opt` and `president` are the degree, work-authorization and job-title
 * vocabulary that belongs with the rest of the admin words above. `mba` and `phd` are deliberately
 * still absent, for the reason NON_REQUIREMENT_ACRONYMS gives.
 *
 * `person` is here for "US person" and "in-person", which are conditions of the job rather than
 * things to have done.
 *
 * `excels` IS THE VERB, and it is here because inLexicon strips a trailing s: "excels at turning
 * ambiguity into execution" was admitted as the spreadsheet and matched against a resume listing
 * Excel. The product is never written in the plural, so denying the plural costs nothing and the
 * singular `excel` is untouched. Blocking it here rather than in the lexicon is deliberate -
 * isDenied is checked BEFORE inLexicon, which is the only order in which a deny-list entry can
 * outrank the -s strip that admitted it.
 *
 * THE WEEKDAYS ARE HERE TOO, and the story of how they nearly were not is the reason to distrust a
 * frequency list. An earlier version of this comment claimed they "reach the final denominator on
 * ZERO of the 400 postings" and cited that as a reason to leave them out. That was FALSE, and it
 * was not a mis-measurement so much as a non-measurement: the check was a grep over a TRUNCATED
 * top-N term-frequency table, and a term appearing five times sits below the cutoff, so absence
 * from the list was read as absence from the board.
 *
 * Measured properly, per posting rather than by rank: 17 denominator slots across 5 of 400
 * postings, and 15 of those 17 are `required` at weight 1 - the TOP tier, not the prose tail.
 * Roblox's "Law Enforcement Liaison, Mississippi" spends five of its twelve required slots on
 * monday through friday.
 * SpaceX's "Piping Technician (Starlink)" and cresta's "Sales Development Manager" are the same
 * shape: an on-site schedule line inside a requirements block, which is a condition of the job and
 * not a thing to have done.
 *
 * Rarer than the months and more concentrated: where a month costs one slot on many postings, a
 * weekday costs several slots on a few, and on those few it is a large share of the score. */
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
proficiency proficient expertise fluency familiarity exposure comfort
please note kindly submit cv letter recruiter
employer employers applicant applicants candidacy offer offers
asylee refugee citizen citizenship resident residency immigration sponsorship visa
authorization authorized protected affirmative accommodation accommodations
fortune award recognized ranked ranking workplace workplaces
english fluent bilingual
january february march april june july august september october november december
monday tuesday wednesday thursday friday saturday sunday
whether expect actual additionally president stem gpa opt person excels
federal municipal county province
department departments
learn transparency hourly
stipend stipends housing commuter relocation lodging shuttle parking wage wages rate rates
allowance allowances reimbursement reimbursements
police background check checks screening`
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
 * ALL-CAPS tokens that are shaped exactly like a skill acronym and are never a thing to have done.
 *
 * Measured 2026-08-03 over 600 live postings: the acronym rule supplied 13.4% of every scored term,
 * and its most frequent products were `usd`(22), `cad`(16), `ms`(13), `bs`(12), `ba`(12), `pto`(10)
 * and `ote`(9). Those are the compensation and benefits block, not the requirements block, and they
 * are marked HARD SIGNAL, so they take the reserved slots in capToEmphasis ahead of real skills.
 *
 * An enumeration rather than a shape rule, for the same reason SKILL_LEXICON is: ITAR, GAAP and
 * SOC2 are the same shape and are real stated requirements. There is no property of the token that
 * separates them, only knowledge of what the word means.
 *
 * THE DEGREE ABBREVIATIONS ARE THE ARGUABLE ONES and they are here deliberately. "BS in Computer
 * Science" IS a requirement. It is not an EARNABLE one: resumes write the degree out ("Bachelor of
 * Science"), so `bs` scored as a miss against every one of the six real base resumes on the system.
 * A requirement no resume can match is denominator weight that only ever subtracts. `mba` and `phd`
 * are NOT here, because those two are written as the acronym on a resume as often as not.
 */
const NON_REQUIREMENT_ACRONYMS = new Set(
  `usd cad eur gbp aud inr chf jpy sgd aed
pto ote rsu esop hsa fsa hra cobra fmla pfl ltd std
ms bs ba bsc msc beng meng
eeo ada faq tbd asap eod eta`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * A dotted initialism: U.S., U.S.C., E.U., i.e.
 *
 * These reach the term set through TECH_MARKER, because a dot is the punctuation that says
 * "technical name" (node.js, ci/cd). `U.S.C` alone was admitted as a HARD SIGNAL requirement on 34
 * of 600 postings, every one of them out of the work-authorization paragraph: "(iii) Refugee under
 * 8 U.S.C. § 1157, or (iv) Asylee under 8 U.S.C. § 1158". The tokenizer trims the trailing dot, so
 * what arrives here is `U.S.C`, hence the optional final letter.
 *
 * Single letters separated by dots is a shape no technology name has: node.js, asp.net and
 * scikit.learn all carry a multi-letter part, so the rule needs no exception list.
 */
const DOTTED_INITIALISM = /^(?:[A-Za-z]\.)+[A-Za-z]?$/;

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
  /**
   * EVERY spelling of this one requirement, including this term's own. Covering any member covers
   * the requirement, which is what resumeSatisfies implements and what the scorer, gapEvidence and
   * interviewPrep all read.
   *
   * ONE WRITER TODAY: the VENDOR_SPELLINGS merge in extractFrom, which folds a vendor's own
   * spelling of a product into the bare product ("Microsoft Excel" and "Excel"). That IS a
   * judgement this file makes rather than one the employer stated, and the argument for making it
   * by enumeration rather than by rule is at VENDOR_SPELLINGS.
   *
   * IT DOES NOT BREACH THE MODULE HEADER'S FIRST RULE. Every member is still matched literally
   * against the resume; there is no hypernym or synonym step. What the field records is that two
   * strings name one product, never that a broader term satisfies a narrower one.
   */
  alternatives?: string[];
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
 * The deny-lists, checked in the plural too.
 *
 * inLexicon has always singularised and these two never did, so every entry in them was singular-
 * only and the plural walked straight past. `requirement` is in BOILERPLATE; `requirements` was the
 * single most common junk term left after the proper-noun rule was tightened, at 47 of 600 postings.
 * It arrives from HTML-stripped postings where the heading never gets its own line, so segmentJd
 * cannot strip it and it lands inline as "...readiness for launch. Requirements Demonstrated
 * experience with...", where it reads as the head of a Title Case run.
 *
 * SAFE BECAUSE THE DENY-LISTS ARE CHECKED BEFORE THE LEXICON: a word whose singular collides with
 * BOILERPLATE would now be lost, so the collision set is asserted empty in jdMatch.test.ts rather
 * than assumed. It is empty today, and the test is what keeps it that way when either list grows.
 */
function isDenied(t: string): boolean {
  // Exact match first: it is the common case (every stopword), and it lets the singular() call and
  // its four regexes be skipped entirely rather than paid on every token of every posting.
  if (GENERIC_STOPWORDS.has(t) || BOILERPLATE.has(t)) return true;
  const s = singular(t);
  return GENERIC_STOPWORDS.has(s) || BOILERPLATE.has(s);
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
  if (DOTTED_INITIALISM.test(token)) return false;
  if (NON_REQUIREMENT_ACRONYMS.has(t)) return false;
  return inLexicon(t) || ACRONYM.test(token) || TECH_MARKER.test(token);
}

/**
 * Every token this posting ever writes in lowercase.
 *
 * The evidence that separates a name from a capitalized common word, taken from the document itself
 * rather than from a list we would have to keep topping up. A product name is capitalized every
 * time it appears: a posting that says "Redux" never says "redux". A common noun that happens to
 * carry a capital once - opening a sentence, heading a fragment, or written for emphasis - is
 * written lowercase somewhere else in the same posting, because that is how the word is normally
 * spelled. "We use Data to drive decisions... strong data skills" is one word, and the lowercase
 * occurrence is the posting telling us so.
 *
 * This is what the deny-list could not do. The junk left after the vocabulary pass was `microsoft`,
 * `engineering`, `data`, `product`, `security`, `sales`, `finance`, `legal`, `account`,
 * `competitive` - a long tail of ordinary nouns, which is the open set this file already refused to
 * chase once with POSITIONAL_OPENERS.
 */
function lowercaseTokens(jdText: string): Set<string> {
  const out = new Set<string>();
  for (const m of jdText.matchAll(/[a-z][a-z0-9+#./_-]*/g)) {
    const t = normalizeTerm(m[0]);
    if (t) out.add(t);
  }
  return out;
}

function isSpecific(
  token: string,
  positionalCapital: boolean,
  nextIsCapitalized = false,
  alsoLowercased?: Set<string>,
): boolean {
  const t = normalizeTerm(token);
  // Single-character lexicon entries (R, C) are real languages, but only when written as a
  // standalone capital. Without this the length guard made them unreachable and a data-science
  // posting never surfaced R at all.
  if (t.length === 1) return /^[A-Z]$/.test(token) && SKILL_LEXICON.has(t);
  if (!t) return false;
  if (WEB_ADDRESS.test(token)) return false;
  if (DOTTED_INITIALISM.test(token)) return false;
  if (isDenied(t)) return false;
  if (NON_REQUIREMENT_ACRONYMS.has(t)) return false;
  if (inLexicon(t)) return true;
  if (ACRONYM.test(token)) return true;
  if (TECH_MARKER.test(token)) return true;
  // Proper-noun cased: product and vendor names we do not carry in the lexicon (a long tail we
  // will never finish enumerating).
  //
  // A LONE MID-SENTENCE CAPITAL IS STILL ADMITTED, and the attempt to change that is recorded here
  // because the reasoning for it was good and the measurement that killed it was better.
  //
  // This rule supplies 55.1% of every scored term (600 live postings, measured 2026-08-03), and
  // what it supplied was `please`(31), `english`(49), `employer`(27), `fortune`(25), `state`(23),
  // `asylee`(16), `refugee`(16). So the obvious fix was to require the Title Case run here that is
  // already required at line start: a real multi-word product name continues in Title Case and a
  // stray capital does not, which reads like a property of names rather than a position rule.
  //
  // IT DELETES REAL REQUIREMENTS. Under that rule the suite lost `Redux` (from "React/Redux", where
  // the slash split leaves a lone capital), `Streaming`, `Risk Management` and a framework named as
  // a bare word in a requirements bullet. Single-word product names are not a long tail that
  // SKILL_LEXICON can absorb; they are most of how requirements are actually written.
  //
  // So the junk is removed by VOCABULARY instead, in BOILERPLATE, where the EEO paragraph, the
  // work-authorization clause and the application-process copy are a closed and stable set. The
  // earlier failure this file records - "POSITIONAL_OPENERS alone was a deny-list against the open
  // set of English verbs, and it lost" - does not apply: verbs are open, boilerplate is not.
  //
  // SIX OF THE SEVEN ABOVE ARE NOW IN BOILERPLATE. `state` is deliberately NOT, even though it was
  // measured at 23: "state management" is a real requirement on front-end postings, and the same
  // word carries both senses. It is caught by the lowercase-occurrence rule below instead, on every
  // posting that also writes "state" in prose, which is most of them.
  if (/^[A-Z][a-zA-Z]{2,}$/.test(token)) {
    // The posting spells this word lowercase somewhere else, so the capital here is decoration.
    // Applies at every position: it is evidence about the word, not about where it sits.
    if (alsoLowercased?.has(t)) return false;
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
 *    THAT FIX REACHED THE BIGRAM PASS AND NOT THE `positional` FLAG, because the two read different
 *    ends of the token. Bigrams use the trimmed `a.end`, so they were fixed. `positional` reads
 *    `text.slice(prevEnd, start)`, and prevEnd was rebased from `m[0].length`, the UNTRIMMED match -
 *    so the sentence-final period was inside the previous token's span and the gap handed to the
 *    `[.!?:;]` test was a bare space. No word after a full stop was ever positional, which is to say
 *    the sentence half of this rule never ran at all. `Once` in "...what your goals are. Once
 *    interviews are complete" was admitted as a proper noun on the psiquantum posting (ISSUE-026)
 *    for that reason, and every other sentence-initial capital on the board with it. Rebasing off
 *    the trimmed length is the whole fix; the suite was green before and after it.
 *
 *    IT IS ALSO THE LARGEST OF THE THREE ISSUE-026 CHANGES BY A WIDE MARGIN. Measured 2026-08-04
 *    over 400 live postings pulled full-text from the production board: this line alone changes the
 *    extracted set on 138 of them and drops 265 terms, against 4 postings for the heading fix and 8
 *    for the BOILERPLATE additions. What it drops is the opening blurb, one sentence at a time:
 *    identify(8), today(5), develop(5), maintain(4), conduct(4), millions(3), establish(3),
 *    since(3), oversee(3), together(3), therefore(3), monitor(3), define(3). Not one of the 265 is
 *    a lexicon skill.
 *
 *    THE COST IS NOT OBSERVED ON THIS CORPUS BUT IT IS REAL, and it is the one isSpecific already
 *    names: a single-word product name written at a sentence start and followed by lowercase prose
 *    now needs the lexicon to survive, because the Title Case run is what separates a name from a
 *    verb and it is not there. "You will use Python daily. Redux is our state layer" loses `Redux`.
 *    Nothing of that shape shows up in the 265, so the bound here is "not measured to cost
 *    anything", not "cannot". It is the same trade isSpecific describes for line-initial capitals,
 *    applied to the position it was always meant to cover rather than to a new one.
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
/**
 * Phrases that are the VENDOR'S OWN SPELLING of a lexicon skill, and therefore the same requirement.
 *
 * The third residual named at EMPHASIS_LIMIT: a posting that writes "Microsoft Excel" also writes
 * "Excel", the subsumption pass below spares a lexicon part on purpose, and the one requirement took
 * two of twelve slots - credited once and charged once against the same resume.
 *
 * AN ENUMERATION, BECAUSE EVERY GENERAL RULE TRIED HERE LAUNDERS A NARROWER REQUIREMENT INTO A
 * BROADER ONE, which is the one thing the module header forbids outright. The general form - merge
 * any phrase into whichever of its words is a lexicon skill - was implemented and measured over 400
 * live postings before being rejected. It produced 89 distinct merges, and the majority were not
 * spellings at all but narrowings:
 *
 *   merchant compliance -> compliance     hr compliance -> compliance
 *   cost accounting -> accounting          financial accounting -> accounting
 *   stanford ai -> ai                      vertex ai -> ai
 *   github actions -> github               salesforce flows -> salesforce
 *   itar policies -> policy                regulatory affairs -> regulatory
 *
 * Under that rule a resume saying "compliance" was credited for "merchant compliance". Narrowing
 * the vendor half to an enumerated vendor list does not save it either: "Google Analytics" is a
 * vendor plus a lexicon skill and is emphatically NOT the same requirement as analytics.
 *
 * There is no property of the two words that separates "Microsoft Excel" from "Google Analytics" -
 * only knowledge of which pairs name one product. So the pairs are named, exactly as SLASH_FORMS
 * names the slash forms that are one skill.
 *
 * A PAIR ONLY FIRES IF ONE OF ITS WORDS IS IN SKILL_LEXICON, because the merge sits inside the
 * branch that spares a lexicon part. `microsoft powerpoint` was listed here and was DEAD for that
 * reason - `powerpoint` is not in the lexicon - so the phrase kept its own slot and no alternative
 * was ever written. That is the same defect this file removes `next` and `recruiting` for a few
 * hundred lines above, reintroduced by the fix for it. It is dropped rather than rescued: adding
 * `powerpoint` to the lexicon is a lexicon change, and lexicon changes belong with the deferred
 * work at SKILL_LEXICON, where they can be measured against the cap.
 *
 * So: adding a pair needs BOTH that one of its words is a lexicon entry, and that the pair
 * genuinely names one product rather than narrowing it. A test asserts the first mechanically. The
 * second is a judgement and cannot be.
 */
const VENDOR_SPELLINGS = new Set([
  'microsoft excel',
  'microsoft azure',
  'apache spark',
  'apache airflow',
  'apache kafka',
  'apache hadoop',
  'adobe photoshop',
  'adobe illustrator',
  'adobe indesign',
  'google bigquery',
]);

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
    prevEnd = start + m[0].length - trail.length;
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

  const lowercased = lowercaseTokens(jdText);
  const terms = preferStatedRequirements(strip(extractFrom(segmentJd(jdText), lowercased)));
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
      lowercased,
    ),
  );
  return capToEmphasis(salvaged.length > terms.length ? salvaged : terms);
}

/** The sections where an employer states what the job needs, as opposed to prose around them. */
const STATED_KINDS = new Set<SectionKind>(['required', 'preferred', 'responsibilities']);

/**
 * When a posting says what it wants, score against THAT, not against the paragraph beside it.
 *
 * This is the half of the denominator problem that filtering could never reach. EMPHASIS_LIMIT caps
 * the denominator at 12 and, measured 2026-08-03, 87.3% of live postings sit AT that cap. A capped
 * denominator refilled from a ranked pool means deleting a junk term does not remove it from the
 * score, it promotes the next junk term into the vacancy. Tightening the proper-noun rule on its own
 * moved junk share 58.2% -> 46.8% and left the score a student sees identical at p50 0 / p90 17,
 * because the twelve slots were always going to be filled.
 *
 * So the fix is not a better filter, it is refusing to pad. Databricks' PM intern posting states
 * three requirements and one responsibility. Scored against those four, a resume carrying Python
 * reads 27. Scored against those four PLUS eight terms lifted from the sentence naming which teams
 * are hiring, the same resume reads 8. The first number is about the job; the second is about how
 * much prose the employer wrote around it.
 *
 * `body` still carries the whole denominator when nothing was stated, which is the short unheaded
 * posting SECTION_WEIGHT.body exists for. This only fires when the employer gave us something
 * better, and only when what they gave us is enough to score honestly on its own.
 */
function preferStatedRequirements(list: JdTerm[]): JdTerm[] {
  const stated = list.filter((t) => STATED_KINDS.has(t.kind));
  // Never trade a score for a refusal. Dropping prose is an improvement to a number that still
  // gets shown; dropping it so hard that the posting stops being scorable just moves a student
  // from "here is what you match" to "we could not work this out", which is worse than the padded
  // number it replaced. Same principle as "the cap never turns a scorable posting into an
  // unscorable one", and measured over 600 live postings it is the difference between 16.7% of
  // resume/posting pairs refusing to score and 13.5%.
  return isScorable(stated) ? stated : list;
}

/**
 * The one definition of "enough to be honest about".
 *
 * Written twice before this: once here in the positive and once in scoreJdMatch in the negative.
 * The comment above ties preferStatedRequirements' correctness to matching scoreJdMatch's refusal
 * exactly, which is a property two hand-copied expressions cannot keep. A third condition added to
 * one of them would have diverged silently, and the symptom would be a posting this pass declares
 * safe to shrink that the scorer then refuses to score.
 */
function isScorable(terms: JdTerm[]): boolean {
  return (
    terms.length >= MIN_SCORABLE_TERMS &&
    terms.filter((t) => t.signal).length >= MIN_SIGNAL_TERMS
  );
}

/*
 * ONLY THE SIGNAL HALF OF isScorable IS OBSERVABLE THROUGH preferStatedRequirements, and it is
 * worth knowing which half is load-bearing before either is edited.
 *
 * Verified by mutation 2026-08-03: replacing `terms.filter(signal).length >= MIN_SIGNAL_TERMS`
 * with `true` fails the suite, and replacing `terms.length >= MIN_SCORABLE_TERMS` with `true`
 * does NOT. The count half is masked downstream. If the stated set comes back under
 * MIN_SCORABLE_TERMS, extractJdTerms' own `terms.length >= MIN_SCORABLE_TERMS` gate fails on the
 * next line, the salvage pass re-extracts WITHOUT preferStatedRequirements, and the larger
 * body-inclusive set wins the `salvaged.length > terms.length` comparison. The prose comes back
 * either way.
 *
 * The count half is kept because it states the intent at the point the decision is made rather
 * than relying on a downstream accident, and because the salvage pass exists for an unrelated
 * reason (zero-weight noise sections) and could be narrowed without anyone thinking about this.
 * But nobody should read it as the thing protecting the refusal path: that is the signal half.
 */

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
 *   - isHardSignal is `lexicon OR ACRONYM OR TECH_MARKER`, minus NON_REQUIREMENT_ACRONYMS and
 *     dotted initialisms, and ACRONYM is any 2-5 letter capital
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
 *
 *     ATTEMPTED AND WITHDRAWN 2026-08-04, recorded so the next attempt starts further along. The
 *     parsing itself worked: comma runs ending in `or`, and explicit `and/or` pairs, grouped
 *     correctly, and a bare two-item "X or Y" was refused because prose `or` is too common to act
 *     on. Two things sank it. It needed a guard against collapsing a posting under
 *     MIN_SCORABLE_TERMS, since removing terms can turn a score into a refusal. And measured per
 *     resume, it moved the finance resume's top-of-board precision DOWN: grouping shrinks the
 *     denominator, and a smaller denominator inflates postings where the student matches few but
 *     generic terms, so off-field rows with 6-term denominators outranked on-field rows with 12.
 *     Fixing OR-alternatives means fixing that denominator-size sensitivity first.
 *   - SUBSUMPTION. FIXED for the vendor-spelling case, 2026-08-04: `excel` and `microsoft excel`
 *     used to both survive, because the subsumption pass spares a part that is a lexicon skill in
 *     its own right. They are now merged into one slot carrying both spellings. See
 *     VENDOR_SPELLINGS, including why the general form of that merge was measured and rejected.
 *     The residual that REMAINS is the general one: `analytics` and `google analytics` are still
 *     two slots, and deliberately so, because they are two different requirements.
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

function extractFrom(sections: JdSection[], alsoLowercased?: Set<string>): JdTerm[] {
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
      if (!isSpecific(tok.text, tok.positional, tok.nextIsCapitalized, alsoLowercased)) continue;
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
        !isSpecific(a.text, a.positional, a.nextIsCapitalized, alsoLowercased) ||
        !isSpecific(b.text, b.positional, b.nextIsCapitalized, alsoLowercased)
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
  // A part that is a lexicon skill in its own right is NOT deleted: in "Salesforce administration",
  // "Salesforce" is a real, separately-matchable requirement and deleting it would lose the very
  // term the student most needs credit for. Only the part that means nothing alone is dropped.
  //
  // BUT SPARING IT MEANS KEEPING BOTH, which is the residual VENDOR_SPELLINGS exists for. Where the
  // phrase is the vendor's own spelling of that same skill, the two are merged into one requirement
  // carrying both spellings, so the slot is spent once and either spelling matches. The standalone
  // lexicon term is the representative because it is what a resume actually writes - "Excel", not
  // "Microsoft Excel" - and resumeCovers needs the phrase's two words adjacent. The merged entry
  // takes the HIGHER of the two weights, so the case the guard below protects (a weight-1 standalone
  // beside a weight-0.7 phrase) is preserved by construction rather than by declining to act.
  for (const [term, entry] of [...byTerm.entries()]) {
    if (!term.includes(' ')) continue;
    for (const part of term.split(' ')) {
      const existing = byTerm.get(part);
      if (!existing) continue;
      if (inLexicon(part)) {
        if (!VENDOR_SPELLINGS.has(term)) continue;
        if (!byTerm.has(term)) break; // already merged away through its other part
        if (entry.weight > existing.weight) {
          existing.weight = entry.weight;
          existing.kind = entry.kind;
        }
        existing.mentions = (existing.mentions ?? 1) + (entry.mentions ?? 1);
        existing.signal = existing.signal || entry.signal;
        existing.alternatives = [
          ...new Set([...(existing.alternatives ?? [existing.term]), ...(entry.alternatives ?? [term])]),
        ];
        byTerm.delete(term);
        break;
      }
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

/**
 * Does the resume satisfy this requirement, including where one product has two spellings?
 *
 * A term with `alternatives` stands for one requirement written several ways, so ANY member
 * satisfies it.
 *
 * IT IS CURRENTLY EQUIVALENT TO resumeCovers(term.term), AND THAT IS WORTH SAYING OUT LOUD rather
 * than leaving for someone to discover. The only writer of `alternatives` today is the
 * VENDOR_SPELLINGS merge, which always keeps the BARE PRODUCT as the representative and folds the
 * vendor-qualified phrase into it. Every alternative therefore CONTAINS its representative as a
 * whole word ("microsoft excel" contains "excel"), so a resume matching any alternative already
 * matches the representative. A test pins that containment invariant.
 *
 * SO WHY KEEP IT. Because the invariant is a property of one enumerated list, not of the field, and
 * the moment any writer produces an alternative that is NOT a superstring of the representative the
 * equivalence breaks silently. Grouping a disjunction the employer wrote ("React, Angular, Vue or
 * Scala" represented by `react`) is exactly that case, it was attempted, and it is recorded as a
 * live residual at EMPHASIS_LIMIT. When it lands, every holder of a JdTerm must call THIS rather
 * than resumeCovers - including gapEvidence.ts and interviewPrep.ts, which both claim in comments
 * to use "the same matcher the score uses" and would both quietly stop doing so. They are left on
 * resumeCovers today because today it is the same function.
 */
function resumeSatisfies(resumeText: string, term: JdTerm): boolean {
  if (term.alternatives) return term.alternatives.some((t) => resumeCovers(resumeText, t));
  return resumeCovers(resumeText, term.term);
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

  if (!isScorable(terms)) {
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
    if (resumeSatisfies(resumeText, t)) {
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
 * produces, not copied from Jobscan's 75-80% advice, which is calibrated to a completely different
 * denominator and would mislabel a good Litos resume as failing.
 *
 * THE SCORE AND THE CAPTION ARE NOT THE SAME ARITHMETIC, and a reader of this file needs to know
 * that before reasoning about the anchors below. scoreJdMatch accumulates got/total by SECTION
 * WEIGHT (1 required, 0.7 responsibilities, 0.6 preferred, 0.4 body), while MatchScore.tsx renders
 * an UNWEIGHTED "N of M". They coincide only when every kept term carries the same weight.
 *
 * So the anchors are stated for the equal-weight case, which is the one a reader can check. The
 * denominator is no longer always twelve (see preferStatedRequirements), so these are stated per
 * term rather than per twelfth:
 *
 *   40  is 2 of 5, or 5 of 12, when the terms are equally weighted. "You have a good part of it."
 *   22  is 1 of 5, or 3 of 12.                                     "You have some of it."
 *   10  is 1 of 10.                                                "There is a thread here."
 *
 * When the weights differ the same COUNT spans a range, and the spread is wide enough to matter.
 * On the SWE_JD fixture, which keeps 8 terms at weight 1 and 4 at 0.7 for a total of 10.8, "8 of
 * 12" is 74 if the eight are the weight-1 terms and 63 if they are not. Both are Strong match
 * today, but the same spread straddles the line lower down: "5 of 12" is 46 or 32, which is Strong
 * or Solid depending only on WHICH five. That is intended, because covering the Requirements block
 * is worth more than covering the same number of Responsibilities lines, which is the whole reason
 * for the weights. It does mean the caption cannot be used to predict the band, and neither number
 * is wrong.
 *
 * WHY THE BOTTOM BAND IS WORDED AS IT IS. "Weak match" was the only one of these labels that graded
 * the STUDENT rather than describing the pair, and on a board where most postings are in someone
 * else's field it is the one they read most. The number underneath it is honest and should not be
 * inflated to spare anyone: a first-year undergraduate really does not match a Staff Engineer role.
 * But the honest content of a low score is "this posting asks for things that are not on your
 * resume", not "you are weak", and the label is free to say the true thing in the words that are
 * actually about the job. The tone stays 'weak', so nothing about the styling changes.
 *
 * ---
 *
 * Thresholds recalibrated 2026-08-03, and the earlier measurement in this file (400 postings,
 * three resumes, "Strong match" fires on 2 of 1116 pairs) is the ISSUE-023 BASELINE, not a
 * current reading. It is superseded by the sweep below.
 *
 * ISSUE-023: the thresholds were 65 and 40, and 96.0% of ON-FIELD pairs read "Not much overlap".
 * "Strong match" was reached by 0.6%. A label with four values that returns one of them 24 times
 * out of 25 carries no information, and it is the label a student uses to choose where to apply.
 *
 * Measured over 600 live postings against the six real base resumes on the system, split by whether
 * the posting's title shares a word with a title the student has actually held:
 *
 *   ON-FIELD  (n=655)   p50 8   p75 17   p90 25   p95 33   p99 50   max 80
 *   OFF-FIELD (n=2459)  p50 0   p75  8   p90 16   p95 19   p99 33   max 57
 *
 * Candidates trialled against that distribution, as share of on-field pairs per band:
 *
 *   65/40/20   strong  0.6%   solid  3.4%   some 14.0%   none 82.0%
 *   45/25/12   strong  1.5%   solid 13.3%   some 18.8%   none 66.4%
 *   40/22/10   strong  4.0%   solid 12.1%   some 22.7%   none 61.2%   <- shipped
 *   30/18/ 8   strong  8.7%   solid 11.8%   some 37.4%   none 42.1%
 *
 * 40/22/10 is the point where every band is reachable and the top band still means something: it is
 * hit by 4.0% of on-field pairs and 0.4% of off-field ones, so "Strong match" is ten times more
 * likely on a posting in the student's own field than off it. 61% remains in the bottom band, which
 * is the honest answer for a board where most postings are in somebody else's discipline.
 *
 * THESE ARE NOT A CURVE, and the number is never restated. 40 means the resume covers 40% of what
 * the posting weighted, and the caption next to the band says "N of M requirements" so the student
 * can see the denominator the band was drawn on. What changed is where the lines sit, not what the
 * number counts.
 */
/** A requirements block more than half unmet caps the band, whatever the score. */
const REQUIRED_COVERAGE_GATE = 0.5;

const BAND_STRONG = 40;
const BAND_SOLID = 22;
const BAND_SOME = 10;

export function scoreBand(
  score: number,
  requiredCoverage: number | null = null,
): { label: string; tone: 'strong' | 'fair' | 'weak' } {
  // A resume can cover a long Responsibilities list while missing every hard requirement, because
  // the weights only differ 1 vs 0.7 and there are usually more responsibilities than requirements.
  // Measured: a posting requiring Kubernetes, Terraform and Kafka scored 61 with every weight-1
  // term missed. Calling that a strong match is the one thing this number must never do, so the
  // band is capped when the requirements block is more than half unmet.
  const gatedByRequirements = requiredCoverage !== null && requiredCoverage < REQUIRED_COVERAGE_GATE;
  if (score >= BAND_STRONG && !gatedByRequirements) return { label: 'Strong match', tone: 'strong' };
  if (gatedByRequirements && score >= BAND_SOLID) return { label: 'Missing key requirements', tone: 'fair' };
  if (score >= BAND_SOLID) return { label: 'Solid match', tone: 'fair' };
  if (score >= BAND_SOME) return { label: 'Some overlap', tone: 'fair' };
  return { label: 'Not much overlap', tone: 'weak' };
}
