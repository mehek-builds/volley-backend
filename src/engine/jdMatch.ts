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
 *     hyphen/space/dot spelling), plus explicitly enumerated same-capability pairs like
 *     TypeScript satisfying JavaScript. There is deliberately NO broad synonym or hypernym table
 *     here. The
 *     resumeSpec.ts skill_source note documents the model generalising "Hugging Face" to "Machine
 *     Learning" and why that is laundering rather than tailoring. A scorer that credits a broader
 *     term for a narrower one makes the same error silently.
 *   - IT REFUSES TO SCORE RATHER THAN GUESS. Under MIN_SCORABLE_TERMS real requirements, the JD
 *     did not give us enough to be honest about, and scorable=false. The dashboard shows nothing
 *     instead of a confident wrong number. See the discrimination tests in jdMatch.test.ts, which
 *     assert a matched/mismatched separation of at least MIN_SEPARATION points and fail the build
 *     if this model ever regresses to the ~2 points the old one managed.
 */

import { label as placeLabel, parsePlace, splitLocations, US_STATES } from '../lib/cities';

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
  //
  // THE PAY-AND-REWARDS FOOTER, 2026-08-04, third pass over this same rule. The "About You" fix
  // above left a residue it named but did not close: a requirements block that runs to the end of a
  // posting with nothing to close it keeps the pay and EEO footer at weight 1. Measured board-wide
  // rather than on the one subset, that residue is not small. Footer text sits inside a REQUIRED
  // section on 5,839 of 22,138 active postings (26.4%), and the reason is the reason it always is
  // here: a heading-shaped line that matches nothing does not close the section it interrupts.
  //
  // FOUR ADDITIONS, each one counted over the 205,581 heading-shaped lines on the board before it
  // was added, because this list has no shape guard beyond isHeadingLine and a word that reads as
  // boilerplate to a human can still be the noun of somebody's job:
  //
  //   total rewards           406 lines, 5 spellings. "Our Total Rewards Philosophy" (272), "Total
  //                           Rewards" (52), "Our Spread* of Total Rewards" (19). One of the five is
  //                           a JOB TITLE, "Internship - Total Rewards (Compensation & Benefits)",
  //                           and it is the known cost: that posting zeroes its own title line.
  //   pay transparency        672 lines, 8 spellings, every one a pay-disclosure banner. `pay range`
  //                           and `salary` were already here and reach none of them.
  //   what we('?ll)? offer    the contraction only. `what we offer` was already here and missed
  //                           "What we'll offer" (119 lines) for the same reason the curly
  //                           apostrophe defect existed: the regex is typed, the posting is not.
  //   employment verification  70 lines, 5 spellings, all hiring-process. `background check` from
  //                           ISSUE-026 reaches "Criminal background screening" but not this.
  //
  // `^disclosures:?$` IS ANCHORED, AND THAT IS THE WHOLE POINT. Bare `disclosures?` fires on 202
  // lines, and four of its ten spellings are real work: "Prepare tax related disclosures for
  // financial statements", "Manage subprocessor tracking and disclosures", "Experience negotiating
  // non-disclosure agreements", "Data leakage and sensitive information disclosure". A tax
  // accountant's requirement line is not a footer. The anchored form reaches only the 59 lines that
  // are the bare word standing alone as a banner.
  //
  // THIS RAISES REFUSALS, 1,583 to 1,606 over the 22,138 active postings, and the 24 that flip are
  // the point rather than a cost. Samsara's "Account Executive, Commercial - Mexico" scored on eight
  // terms before this, of which `Tofu`, `us-greenhouse-mail.io`, `mail3.guide.co` and `Commitment`
  // were four: take the footer away and what is left is under the floor, so the posting refuses
  // instead of printing a number built on a rewards paragraph and a mail domain. That is the trade
  // MIN_SCORABLE_TERMS exists to make. It is recorded here because it is user-visible - a student
  // sees "not scorable" on 24 more postings - and because a later change that moves this number
  // should have to notice it moved.
  //
  // TWO CANDIDATES MEASURED AND REJECTED, recorded so they are not re-proposed on the intuition
  // that put them here:
  //
  //   bare `disclosures?`     see above. Rejected on four real requirement lines.
  //   LinkedIn tracking tags  `#LI-Hybrid` and its 328 cousins are the single biggest unrecognised
  //                           heading on the board: 3,705 lines, and headingCore strips the `#` so
  //                           they arrive here looking like headings. Zeroing them is tempting and
  //                           WRONG AS WRITTEN: only 635 of the 3,705 sit in the last 5% of their
  //                           posting, while 1,867 sit before the 80% mark, so a rule that closes
  //                           the section at the tag would zero real content on a third of them.
  //                           They are harmless where they are (matching nothing, they close
  //                           nothing) and they need a rule about their SHAPE, not this list.
  { kind: 'noise', re: new RegExp(String.raw`^about\b(?!\s+${SECOND_PERSON_SUBJECT}\b)|^disclosures:?$|^the process:?$|^apply\??$|\b(who (we are|are we)|our (story|mission|values|culture)|benefits|perks|what else|what we('?ll)? offer|what we pay|compensation|salary|pay range|hourly rate|pay rate|stipend|total rewards|pay transparency|equal opportunity|eeo|diversity|accommodation|privacy|how to apply|why (join|us)|interview process|hiring process|selection process|background check|employment verification)\b`, 'i') },
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
  { kind: 'required', re: new RegExp(String.raw`\b(requirements?|qualifications?|what you'?ll need|what you should have|what we('?re)? look(ing)? for|what would make you a strong fit|must[- ]have|minimum|basic qualifications|skills?|you have|your background|about\s+${SECOND_PERSON_SUBJECT})\b`, 'i') },
  { kind: 'responsibilities', re: /\b(responsibilities|what you'?ll do|what you will do|the role|(your|the) impact|make an impact|day[- ]to[- ]day|in this role|duties)\b/i },
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
  if (/^[-*•·▪▫‣◦●○–—→⇒»›✓✔]/.test(t)) return false; // a bullet is content, never a heading
  const words = t.split(/\s+/).length;
  if (words > 7) return false;
  return t.endsWith(':') || /^[A-Z][^.!?]*$/.test(t) || t === t.toUpperCase();
}

/**
 * A heading that names WORK ABOUT the footer vocabulary, rather than the footer itself.
 *
 * The noise list above is matched as a substring, which is what lets it catch "Perks and Benefits"
 * as readily as "Benefits" and is why it reaches footer text inside a required section on 26.4% of
 * the board. The cost of a substring match is that it cannot tell a footer from a requirements
 * sub-heading that happens to contain the same words, and on that shape it does not merely add a
 * nuisance term - it DELETES the requirements underneath. Measured against the shipped matcher:
 *
 *   Requirements block, then a sub-heading, then "Administer Greenhouse and Workday"
 *   for a student who has NEITHER tool:
 *
 *     "Interview Process Design"            score 100, missing list EMPTY
 *     "Total Rewards Analysis"              score 100, missing list EMPTY
 *     "Employment Verification Workflows"   score 100, missing list EMPTY
 *     "Own the interview process"           score 100, missing list EMPTY
 *
 * A student told they are a perfect match, with nothing to act on, for a job naming two tools they
 * do not have. PLACE_SAFE_KINDS records why this direction is the worse one: a requirement the
 * student LACKS vanishing from the denominator inflates the score and vanishes from the list they
 * are supposed to act on.
 *
 * THIS GUARD ONLY EVER SUBTRACTS FROM THE NOISE CLASS, and that is deliberate. Narrowing the
 * vocabulary or anchoring the match would have cut the 26.4% coverage the substring form earns;
 * an earlier attempt at this fix did exactly that and was rejected in review. Nothing here can make
 * a heading noisy that was not already, so the footer coverage is untouched by construction.
 *
 * TWO SIGNALS, both enumerations rather than shape guesses, in the same spirit as
 * POSITIONAL_OPENERS:
 *
 *   - The heading OPENS with an action verb. "Own the interview process", "Conducting Background
 *     Checks", "Analyze Pay Rates". A footer heading names a thing; a requirements line asks you to
 *     do one. `hiring`, `interviewing` and `recruiting` are deliberately ABSENT, because they are
 *     the footer vocabulary itself: "Hiring Process" must stay noise.
 *   - The heading CLOSES with a work noun. "Interview Process Design", "Background Check
 *     Operations", "Pay Rate Administration". `process`, `benefits` and `rewards` are deliberately
 *     absent for the same reason - they are how the footer headings themselves end.
 */
const SUBHEADING_VERBS = new Set(
  `own owning manage managing run running conduct conducting analyze analyzing analyse analysing
administer administering model modeling modelling redesign redesigning design designing build
building improve improving automate automating audit auditing oversee overseeing coordinate
coordinating execute executing lead leading drive driving deliver delivering maintain maintaining
monitor monitoring review reviewing evaluate evaluating handle handling perform performing`
    .split(/\s+/)
    .filter(Boolean),
);

const SUBHEADING_WORK_NOUNS = new Set(
  `design operations operation administration workflow workflows analysis analytics management
automation strategy engineering reporting tooling`
    .split(/\s+/)
    .filter(Boolean),
);

function looksLikeStatedSubHeading(heading: string): boolean {
  const words = heading
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return false;
  return SUBHEADING_VERBS.has(words[0]) || SUBHEADING_WORK_NOUNS.has(words[words.length - 1]);
}

/**
 * A HEADING NAMES ITS SECTION BEFORE THE FIRST COMMA, and a line that only reaches the vocabulary
 * after one is a requirement bullet that lost its bullet marker in the scrape.
 *
 * Flow Traders' "Quantitative Trading Intern" (packet b43dbe37) is what this is for. Its bullets
 * arrive with the markers stripped, so each is a short capitalized line with no full stop, which is
 * every shape test isHeadingLine has, and two of them carry heading vocabulary:
 *
 *   Class of 2028, preferred
 *   Excellent mental math, quantitative and analytical skills
 *
 * Both classified - one `preferred`, one `required` - and each OPENED a section that ran to the end
 * of the document, over the salary paragraph, the office list and the unsolicited-resume notice.
 * All nine of that packet's requirements came from below them: `Amsterdam, APAC, Europe, Excel,
 * Hong Kong, Internet, Law, NYC, York`, and the student was shown 0% against an office directory.
 *
 * THE ONE-CONDITION VERSION - "a heading contains no comma" - WAS MEASURED AND IS WRONG. Over the
 * 85 production packets Deepgram writes "Minimum Skills, Knowledge & Capabilities:" and Cloudflare
 * writes "Desirable Skills, Knowledge and Experience", both genuine requirements headings. Refusing
 * them left those blocks unweighted and took Cloudflare's two packets from 22 and 23 to ZERO, with
 * `athenian` and `journalism` restored to the denominator. A comma is not the signal.
 *
 * WHERE the vocabulary sits relative to the comma is. A heading states what the section is and then
 * elaborates: `Minimum Skills`, `Desirable Skills`, `Qualifications`, all before the first comma. A
 * bullet is a sentence, and its heading-shaped word lands wherever the sentence puts it: `skills` is
 * the last word of "Excellent mental math, quantitative and analytical skills", and `preferred` is
 * a qualifier tacked onto the end of "Class of 2028". Testing the head of the line rather than the
 * whole of it is the smallest rule that separates the two, and it costs the four real headings in
 * the corpus nothing.
 *
 * A line with no comma is unaffected, which is nearly all of them.
 */
function headingSubject(line: string): string {
  const full = headingCore(line);
  return full.includes(',') ? full.slice(0, full.indexOf(',')) : full;
}

function classifyHeading(line: string): SectionKind | undefined {
  const t = headingSubject(line);
  for (const { kind, re } of HEADING_PATTERNS) {
    if (!re.test(t)) continue;
    // A footer heading names the footer. A requirements sub-heading names work about it, and
    // zeroing that block deletes the requirements under it. Fall through to the remaining patterns
    // rather than returning, so a line that is genuinely a requirements heading can still say so.
    // The `^about` branch is EXEMPT. A heading-shaped line opening with "About" is a company or
    // team blurb by construction, as that pattern's own note says, so the verb/work-noun heuristic
    // has no work to do there and gets it wrong: "About AQR Capital Management" ends in
    // `management`, a genuine work noun, and the guard was zeroing nothing while un-zeroing a real
    // company blurb. Found on the live board, not constructed.
    if (kind === 'noise' && !/^about\b/i.test(t) && looksLikeStatedSubHeading(t)) continue;
    return kind;
  }
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
  /\b(who (we are|are we)|what else|benefits|perks|equal opportunity|equal employment|eeo|e-verify|affirmative action|reasonable accommodation|fair chance|applicant privacy|privacy policy)\b/i;

function isNoiseBlockOpener(line: string): boolean {
  const t = headingCore(line);
  if (!t || t.length > 120) return false;
  if (/^[-*•·]/.test(t)) return false;
  if (/\.$/.test(t)) return false;
  if (t.split(/\s+/).length > 16) return false;
  // Same substring hazard as the noise heading list, and the same guard. This matcher has the
  // WIDER 16-word budget, so it is the more exposed of the two: "Benefits Administration" is a real
  // requirements sub-heading on an HR-operations posting, and zeroing it deletes everything under
  // it. See looksLikeStatedSubHeading, and the caution this comment block already carries about
  // additions needing to be checked against real requirement prose rather than reasoned about.
  if (looksLikeStatedSubHeading(t)) return false;
  return NOISE_BLOCK.test(t);
}

function isImpactFitBlockOpener(line: string): boolean {
  const t = headingCore(line);
  if (!t || t.length > 120) return false;
  if (/^[-*•·]/.test(t)) return false;
  if (/\.$/.test(t)) return false;
  if (t.split(/\s+/).length > 12) return false;
  return IMPACT_FIT_HEADING_PATTERN.test(t);
}

/**
 * A heading the employer wrote INLINE, as a label on the front of the paragraph it introduces.
 *
 * THE THIRD SPELLING OF THE SAME DEFECT, and the one the two existing matchers are shaped so they
 * can never reach. isHeadingLine caps a heading at 60 characters and 7 words; isNoiseBlockOpener
 * widens that to 120 characters and 16 words and additionally refuses any line ending in a full
 * stop. A footer heading written as `Label: <the whole paragraph>` is one line carrying both, so it
 * is too long for the first and both too long AND too punctuated for the second.
 *
 * Gemini's "Software Engineering Intern (Fall 2026)" (job 10c37ef7, live 2026-08-04) is the shape,
 * and it is worth stating exactly what it cost because the cost is not the paragraph:
 *
 *   Qualifications:
 *   <six real requirement bullets>
 *   Pay Rate: The hourly pay rate for this role is $50/hour in the State of New York, the State
 *   of California and the State of Washington. When determining a candidate's compensation...
 *
 * That line is 316 characters, so nothing closed the `Qualifications` block, and EVERYTHING below
 * it - the pay paragraph, the hybrid-work paragraph and the whole EEO paragraph - was read as
 * REQUIRED at weight 1. Its twelve extracted requirements were `API, Associate, California,
 * Computer Science, Law, NY, policy, rest, State, Washington, York, York City`. Nine of the twelve
 * are the pay table, the office address and "Equal Opportunity is the Law". The student was shown
 * `Associate, Law, policy, State, Washington, York, NY, York City` as "things your resume does not
 * mention", which is the gap-to-bullet input, so the product was one click from offering to write
 * a resume bullet about the State of Washington.
 *
 * This is the same failure class as the cresta apostrophe defect and the psiquantum interview-
 * process footer: an unrecognised heading does not merely fail to classify itself, it fails to
 * CLOSE the section above it. Both of those were fixed by widening what counts as a heading LINE.
 * This one cannot be, because the heading is not a line.
 *
 * WHY THE LABEL AND NOT THE PARAGRAPH. The rest of the line goes into the new section rather than
 * being discarded, because the paragraph genuinely belongs to the label: the pay sentence is what
 * "Pay Rate:" introduces. Discarding it would be a different and less defensible rule.
 *
 * THE GUARDS, and why each is the conservative choice:
 *
 *   - BULLETS ARE EXCLUDED ENTIRELY. `- Benefits: describe the benefits of our platform` is a real
 *     requirements bullet on a sales posting and this rule would zero it and everything under it.
 *     NOISE_BLOCK's comment already warns that the shape guards will not catch a footer word used
 *     in requirement prose; a bullet is the one shape where that is common, so it is refused
 *     outright rather than reasoned about.
 *   - THE LABEL IS HELD TO isHeadingLine's OWN BUDGET, 40 characters and 6 words, not to the wider
 *     one. A long run of words before a colon is a sentence with a colon in it, not a label.
 *   - CLASSIFICATION GOES THROUGH classifyHeading, so this adds NO vocabulary of its own and
 *     inherits looksLikeStatedSubHeading. "Interview Process Design: own the calendar" is spared
 *     here for exactly the reason it is spared there.
 *
 * IT IS NOT NOISE-ONLY, deliberately. `Requirements: 5+ years of Python` and `Skills: SQL, Excel`
 * are the same shape doing the opposite job, and a rule that only ever zeroed would find the
 * footers and miss the requirements blocks written the same way.
 *
 * THE LABEL SCOPES TO ITS OWN LINE. See the call site in segmentJd for the measurement that forced
 * that, which is the one regression this change introduced and then removed.
 */
function inlineLabel(line: string): { kind: SectionKind; rest: string } | undefined {
  const t = headingCore(line);
  if (!t || /^[-*•·]/.test(t)) return undefined;
  const at = t.indexOf(':');
  if (at < 1) return undefined;
  const label = t.slice(0, at).trim();
  if (!label || label.length > 40) return undefined;
  if (label.split(/\s+/).length > 6) return undefined;
  const kind = classifyHeading(label);
  if (!kind) return undefined;
  return { kind, rest: t.slice(at + 1) };
}

/**
 * EEO and legal boilerplate written as PROSE, with no heading of any kind in front of it.
 *
 * The last route by which the footer reaches a scored section. inlineLabel above closes the
 * Gemini posting at its `Pay Rate:` label and the EEO paragraph below it is then already inside a
 * noise section, so on that posting this rule changes nothing. It is here for the postings that
 * have no pay line at all, where a requirements block runs straight into
 *
 *   At <company>, we are committed to equal employment opportunity regardless of race, color,
 *   ancestry, religion, sex, national origin, sexual orientation, age, citizenship...
 *
 * with nothing between them. That paragraph is 300+ characters and ends in a full stop, so it
 * defeats isHeadingLine, isNoiseBlockOpener and inlineLabel alike, and everything it contains is
 * read at the weight of the block above it.
 *
 * THIS MATCHER HAS NO SHAPE GUARD AT ALL, which makes it the most exposed rule in this file, and
 * the vocabulary is chosen accordingly. NOISE_BLOCK's comment states the honest bound on the
 * existing lists: "it is safe for the vocabulary it currently lists, and ANY addition needs to be
 * checked against real requirement prose rather than reasoned about, because the shape guards will
 * not stop it." Here there are no shape guards to fall back on, so every entry is a WHOLE CLAUSE
 * that a requirement cannot contain, never a footer word:
 *
 *   `equal opportunity is the law`                 a poster title, verbatim
 *   `(without regard to|regardless of) race`       the anti-discrimination clause itself
 *   `equal (employment )?opportunity employer`     the self-description, not the subject
 *   `all qualified applicants will receive`        the standard consideration sentence
 *   `protected veteran status`
 *   `e-verify`
 *
 * BARE `equal employment opportunity` IS DELIBERATELY ABSENT and is the entry this rule most
 * obviously wants. NOISE_BLOCK's own comment names the counterexample: "Knowledge of EEO and
 * affirmative action reporting requirements" is a real requirement on an HR-compliance posting,
 * and an unguarded rule matching the bare phrase would read it as a footer and silently truncate
 * every requirement below it. `reasonable accommodation` is absent for the same reason - "provide
 * reasonable accommodations" is a real HR duty - and both are already carried by NOISE_BLOCK in
 * the heading-shaped form, where the shape is doing the work this rule cannot.
 *
 * MEASURED, as that comment demands, over 500 live postings: it fires on 214 lines across 189
 * postings, and every one is an EEO or work-authorization footer paragraph. It changes the
 * extracted set on 27 of the 500 - the postings where that footer was previously being scored.
 */
const FOOTER_PROSE =
  /\b(equal opportunity is the law|(without regard to|regardless of) race|equal (employment )?opportunity (employer|workplace)|all qualified applicants will receive|protected veteran status|e-verify)\b/i;

const LOGISTICS_PROSE =
  /\b(headquartered in|has offices in|office locations?|hub offices?|based out of (our|the) (hubs|offices)|(roles?|jobs?|positions?) ((can be|is|are) )?based (out of|in)|in office [0-9]|we (are|work|value)[^.]{0,80}in office|hybrid work approach|remote workforce)\b/i;

function isLogisticsProseLine(line: string): boolean {
  const t = headingCore(line);
  if (!t) return false;
  if (/^[-*•·]/.test(t)) return false;
  if (/\b(must|required|able|willing|authorized|authorization|relocat(e|ion)|commut(e|ing))\b/i.test(t)) return false;
  return LOGISTICS_PROSE.test(t);
}

const NON_RESUME_REQUIREMENT_LINE =
  /\b(located in|resid(e|ing) in|based in|time ?zones?|utc[+-]?\d|transparent salary|paid vacation|paid sick leave|parental leave|stock options|employment (&|and) contractor options|salary calculator|commission split|base salary|ote)\b/i;

/**
 * Lines that tell the student HOW TO APPLY or WHETHER THEY ARE ELIGIBLE, neither of which is a
 * thing a resume can be scored against.
 *
 * Akuna's Python posting (packet cc9d695d) contributed twelve requirements and five of them came
 * from three lines of this kind. Every one was `kind: 'required'` at weight 1, so they did not
 * merely appear in amber: they took slots under EMPHASIS_LIMIT ahead of real skills, they charged
 * the denominator, and they are the input to gap-to-bullet.
 *
 *   "**Resumes must be submitted in PDF format."           -> `resumes`, `pdf`
 *   "Major GPA of 3.5 or above"                            -> `major`
 *   "Legal authorization to work in the U.S. is required"  -> `legal`
 *
 * WHY THE LINE AND NOT THE WORD. Each of those four words was admitted by a different rule -
 * `resumes` by the proper-noun rule, `pdf` by ACRONYM, `major` by the Title Case run, `legal` by
 * SKILL_LEXICON - so removing them word by word means four separate weakenings of four rules that
 * are each right in general. What they share is not a property of the word, it is the sentence they
 * were standing in. The vocabulary is whole clauses for the reason FOOTER_PROSE gives: a real
 * requirement cannot contain "must be submitted in", and a GPA threshold or a work-authorization
 * clause states eligibility, which the application form asks about and the resume does not carry.
 *
 * The guard in isNonResumeRequirementLine still applies, so a line that also names experience,
 * skills or proficiency is kept whole and none of this fires on it.
 */
const APPLICATION_PROCESS_LINE =
  /\b((resumes?|cvs?|cover letters?|transcripts?|applications?|submissions?) (must|should|can|may|are to|need to) be (submitted|uploaded|sent|provided|attached|received)|please (submit|upload|attach|send|include) (your|a|an|all)|to apply,|submit(ted)? (your|a|an) (resume|cv|application) (in|via|through|to))\b/i;

/* THE THREE ADDITIONS ARE THE SAME CLAUSE FAMILY as the ones above and were found the same way,
 * on the 85 production packets. Astranis states eligibility as "U.S. Citizenship, Lawful Permanent
 * Residency, or Refugee/Asylee Status Required" and contributed `status` to two packets; Jump
 * Trading writes "INTERNATIONAL STUDENTS are encouraged to apply. We accept students eligible for
 * CPT/OPT and we sponsor work visas for full-time positions" and contributed `international` and
 * `cpt`. Neither sentence is a thing a resume can be scored against, and neither was reachable by
 * the existing vocabulary. `sponsorship` was here; "we sponsor work visas" is the verb form. */
const ELIGIBILITY_LINE =
  /\b((minimum|cumulative|overall|major|current|combined)? ?gpa|grade[- ]point average|authoriz(ed|ation) to work|work authoriz(ed|ation)|legally (authorized|entitled|permitted)|right to work|(visa|employment|work) sponsorship|require sponsorship|employment eligibility|(lawful )?permanent residen(cy|t)|refugee|asylee|sponsors? work visas?)\b/i;

/**
 * A LEGAL NOTICE OR A STATUTE CITATION, checked AHEAD of the experience guard below because that
 * guard is what these two sentences hide behind.
 *
 * The guard spares any line naming experience, skills, knowledge or ability, which is right in
 * general and exactly wrong here: a compensation disclosure explains itself in those words.
 *
 *   Akuna  "In accordance with the Illinois Equal Pay Act, the minimum annualized base salary
 *           starts at $145,000. Exact compensation offered may vary based on many factors
 *           including ... the candidate's experience, qualifications, and skill set."
 *   DRW    "California residents, please review the California Privacy Notice for information
 *           about certain legal rights at https://drw.com/california-privacy-notice."
 *
 * `base salary` is already in NON_RESUME_REQUIREMENT_LINE and never fired on the first, because
 * `experience` and `skill` are in the same sentence. The second reaches no pattern at all. Between
 * them they put `illinois`, `california` and `legal` into the denominators of five packets, and
 * `california` was scored as a MET requirement on four of them, matched against the school line
 * "University of Southern California" - geography credited as a satisfied requirement and painted
 * blue in the resume pane.
 *
 * EVERY ENTRY IS A WHOLE CLAUSE, on the standard FOOTER_PROSE sets for rules with no shape guard:
 * a requirement bullet cannot contain "privacy notice" or "in accordance with the ... Act". Footer
 * WORDS are not admissible here and none is listed.
 */
const LEGAL_NOTICE_LINE =
  /\b(privacy notice|equal pay act|(salary|pay) transparency (act|law)|in accordance with the [^.]{0,40}\b(act|law)s?\b|does not accept unsolicited)\b/i;

function isNonResumeRequirementLine(line: string): boolean {
  const t = headingCore(line);
  if (!t) return false;
  if (LEGAL_NOTICE_LINE.test(t)) return true;
  if (
    /\b(experience|skills?|proficiency|fluency|knowledge|background|ability|track record|familiarity)\b/i.test(t) &&
    !/\b(located in|resid(e|ing) in|time ?zones?|utc[+-]?\d)\b/i.test(t)
  ) {
    return false;
  }
  return NON_RESUME_REQUIREMENT_LINE.test(t) || APPLICATION_PROCESS_LINE.test(t) || ELIGIBILITY_LINE.test(t);
}

export interface JdSection {
  kind: SectionKind;
  weight: number;
  text: string;
  heading?: string;
  /**
   * This section was zeroed by FOOTER_PROSE, and the salvage pass in extractJdTerms must leave it
   * zeroed.
   *
   * THE SALVAGE PASS EXISTS BECAUSE A NOISE HEADING IS A GUESS ABOUT EXTENT. It runs until the next
   * recognised heading, so a posting that opens with a "Compensation" or "Pay range" banner - first
   * on the page by law in the pay-transparency states - can put its whole body inside a zero-weight
   * section. Re-reading noise as body when zeroing leaves the posting unscorable is the right trade
   * there, because the thing we were uncertain about was how much the heading swallowed.
   *
   * FOOTER_PROSE IS NOT THAT KIND OF GUESS. It does not match a heading and then claim everything
   * after it; it matches a clause that IS the boilerplate - "Equal Opportunity is the Law",
   * "regardless of race" - inside the line it opens. There is no over-reach to walk back, so
   * salvaging it only ever puts the EEO paragraph back into a denominator it was correctly removed
   * from. On Gemini's intern posting (job 10c37ef7) that is precisely what happened: the section
   * fixes took `Law` out at weight 1 and the salvage pass handed it straight back at 0.4, still on
   * the list of "things your resume does not mention".
   *
   * The pay-transparency banner the salvage pass was written for is untouched, because that banner
   * is opened by a heading or an inline label and never by this rule.
   */
  footer?: boolean;
}

/**
 * Split a JD into weighted sections. Text before any recognised heading is 'body': short postings
 * often have no headings at all, and dropping their content would leave nothing to score.
 */
/**
 * Employer-branded footer headings can end a scored section without looking like ordinary
 * headings. Cloudflare's production posting writes `What Makes Cloudflare Special?` directly
 * after its one-item Bonus Points section. The question mark makes isHeadingLine reject the line,
 * so the entire company-history footer inherited `preferred` weight and `Internet` became a
 * colored candidate requirement.
 *
 * This is exact posting context, not a vocabulary ban: the heading must name the company supplied
 * by the caller. `What Makes You Special?` is therefore untouched, and a real requirement that
 * names Internet protocols remains in its stated section.
 */
function isCompanySpecialFooterHeading(line: string, company: string | null | undefined): boolean {
  const companyName = normalizeTerm(company ?? '');
  if (!companyName) return false;
  const heading = normalizeTerm(headingCore(line).replace(/\?+$/, ''));
  return heading === `what makes ${companyName} special`;
}

export function segmentJd(jdText: string, context?: JdContext): JdSection[] {
  const lines = jdText.split(/\r?\n/);
  const sections: JdSection[] = [];
  let current: JdSection = { kind: 'body', weight: SECTION_WEIGHT.body, text: '' };

  for (const line of lines) {
    if (isCompanySpecialFooterHeading(line, context?.company)) {
      if (current.text.trim()) sections.push(current);
      current = {
        kind: 'noise',
        weight: SECTION_WEIGHT.noise,
        text: '',
        heading: headingCore(line),
        footer: true,
      };
      continue;
    }
    if (isHeadingLine(line)) {
      const kind = classifyHeading(line);
      if (kind) {
        if (current.text.trim()) sections.push(current);
        current = { kind, weight: SECTION_WEIGHT[kind], text: '', heading: headingCore(line) };
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
    if (isImpactFitBlockOpener(line)) {
      if (current.text.trim()) sections.push(current);
      current = { kind: 'responsibilities', weight: SECTION_WEIGHT.responsibilities, text: '', heading: headingCore(line) };
      continue;
    }
    // Third, so a line that is a heading in its own right never reaches the label rule. What is
    // left by here is a line too long or too punctuated to be a heading, which is the only place
    // an inline `Label: <paragraph>` can hide.
    const inline = inlineLabel(line);
    if (inline) {
      // HOW FAR THE LABEL REACHES DEPENDS ON WHAT IT IS, and getting this wrong in EITHER direction
      // was measured over 500 live postings before it was settled.
      //
      // A FOOTER LABEL IS TERMINAL, so it opens a running section exactly like every other noise
      // rule in this loop. `Pay Rate:` is not a label on one sentence, it is the point where the
      // employer stopped describing the job: on the Gemini posting the pay paragraph, the
      // hybrid-work paragraph and the EEO paragraph follow it in that order and nothing about any
      // of them is a requirement. Scoping it to its own line puts the two paragraphs under it back
      // inside `Qualifications` at weight 1, which is the bug.
      //
      // A SCORED LABEL IS LOCAL, and scopes to its own line with the enclosing section resuming
      // underneath. THE FIRST VERSION OF THIS RULE MADE THESE TERMINAL TOO AND IT WAS A REGRESSION,
      // caught by the corpus pass rather than by the suite. Scale AI's "SWE Fellow - Human Frontier
      // Collective" writes its requirements as `Skills: ...deep expertise in one or more of the
      // following programming languages...`, a correct `required` classification, and then
      // continues with `Professional Mindset:`, `Flexible Schedule:`, `Competitive Pay:`,
      // `Interview:` and `Join the Collective:`. Running to the next heading put all of those at
      // weight 1, so the perks and the hiring process outranked the work: the posting lost
      // `benchmark`, `propensitybench`, `scipredict` and `publications`, gained `competitive`,
      // `interview` and `mindset`, and the score fell 33 -> 25 against a real base resume.
      //
      // The asymmetry is not a fudge, it is the same asymmetry NOISE_BLOCK already documents: a
      // false positive in the noise class is cheap, because the salvage pass re-reads noise as body
      // when zeroing leaves the posting unscorable, while a false positive in a SCORED class
      // silently promotes whatever follows it. So the class that can over-reach safely is allowed
      // to, and the class that cannot, is not.
      const terminal = inline.kind === 'noise';
      const resume = { kind: current.kind, weight: current.weight, footer: current.footer, heading: current.heading };
      if (current.text.trim()) sections.push(current);
      if (terminal) {
        current = { kind: 'noise', weight: SECTION_WEIGHT.noise, text: inline.rest + '\n' };
        continue;
      }
      if (inline.rest.trim()) {
        sections.push({
          kind: inline.kind,
          weight: SECTION_WEIGHT[inline.kind],
          text: inline.rest + '\n',
          heading: headingCore(line).split(':', 1)[0],
        });
      }
      current = { ...resume, text: '' };
      continue;
    }
    // Last. A footer paragraph carries no heading at all, so this is the only rule that can see it,
    // and it is checked after every rule that has a shape guard to offer.
    if (FOOTER_PROSE.test(line)) {
      if (current.text.trim()) sections.push(current);
      current = { kind: 'noise', weight: SECTION_WEIGHT.noise, text: line + '\n', footer: true };
      continue;
    }
    if (isLogisticsProseLine(line)) {
      const resume = { kind: current.kind, weight: current.weight, footer: current.footer, heading: current.heading };
      if (current.text.trim()) sections.push(current);
      sections.push({ kind: 'noise', weight: SECTION_WEIGHT.noise, text: line + '\n' });
      current = { ...resume, text: '' };
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
 * `legal` AND `law` WERE THE TWO ENTRIES THE FIRST PASS MISSED, added 2026-08-04 after re-measuring.
 * ---------------------------------------------------------------------------------------------
 * The first pass took the law resume from 0 hard-signal matches to some, which is what the ledger
 * recorded, but it never admitted the two central nouns of the discipline. Before this change
 * `legal` reached 61 of 2500 live denominators and `law` 8, each with signal on EXACTLY ZERO of
 * them, because both were reachable only through the proper-noun rule. On the original frozen 400
 * the law resume covered `legal` on all 10 postings that carried it and earned nothing for any.
 *
 * THE OBVIOUS OBJECTION IS REAL AND WAS TESTED RATHER THAN ARGUED. Read in isolation both words
 * look like the prose this list rejects: `legal` reaches 61 of 2500 denominators and most of those
 * sentences are cross-functional department rosters ("Sales, Finance, Legal, and Product"), and 6
 * of the 8 `law` hits are degree-field enumerations ("degree in Law, Business Administration,
 * Finance, Compliance, or a related field"). By the reading test above, both should have been
 * rejected. The measurement says otherwise, and the measurement wins:
 *
 *   UW law resume, 2500 postings      on-field mean   off-field mean   separation
 *   before                                  7.2             3.0            4.2
 *   after `legal` + `law`                  13.2             4.1            9.2
 *
 * Off-field does rise, which is the department-roster cost being paid honestly. On-field rises five
 * times faster, so SEPARATION more than doubles, and that is the metric that decides this file. The
 * user-visible effect is the ranking: p@10 went 40% to 60% and p@20 25% to 40%, and the top of her
 * board became `IP Counsel`, `Employment Counsel` and `Lead Counsel, Commercial` instead of three
 * Customer Success Architect reqs. The degree-field hits are not even noise: an employer who says a
 * law degree qualifies is stating a real match.
 *
 * BOTH WORDS DO WIDEN THE DENOMINATOR, and that is the cost to check rather than the objection to
 * wave off. Admitting them to this list moves `legal` from 61 denominators to 216 and `law` from 8
 * to 139, because inLexicon reaches sections the proper-noun rule never did. The reason that is
 * paid for and not the ISSUE-023 mistake repeated is that the added slots are EARNED: the law
 * resume covers `legal` on 216 of 216 and `law` on 139 of 139. A term that arrives in the
 * denominator and is then matched every single time is the opposite of the proper-noun rule's 3.6%.
 *
 * THE COST TO THE OTHER TWO RESUMES WAS MEASURED, NOT ASSUMED, since a wider denominator can evict
 * someone else's requirement under EMPHASIS_LIMIT. On the same 2500-posting run USC CS separation
 * is 9.5 before and after and MIT econ 2.7 before and after, unmoved to the decimal.
 *
 * Note also that the company and the role are stripped from every section (selfReferenceTokens), so
 * a posting titled "Legal Intern" never carries `legal` as a term at all. The on-field gain below
 * is therefore made entirely by postings whose BODY says legal, never by their title, which means
 * it is not an artifact of the title-based on-field labelling used to measure it.
 *
 * `counsel` WAS MEASURED IN THE SAME PASS AND REJECTED. It reaches 2 of 2500 denominators, both the
 * same posting, and adding it moved separation 4.2 to 4.0 - slightly WORSE, since it buys no
 * on-field credit and still competes for a reserved slot. `attorney`, `statutory`, `clerkship`,
 * `pro bono`, `affidavit`, `pleading`, `jurisdiction`, `legal research` and `civil rights` were
 * also measured: every one of them reaches ZERO denominators across 2500 live postings. The
 * practice vocabulary of law is not what this board is written in, so adding it would be dead
 * weight that makes the list overstate its own coverage. Do not add them back on intuition.
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
hardware firmware embedded
accounting auditing bookkeeping valuation modeling forecasting budgeting reconciliation
econometrics statistics regression segmentation attribution
legal law litigation compliance regulatory governance contract paralegal deposition
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
copywriting analytics automation visualization prototyping wireframing benchmarking underwriting
roadmap metric dashboard experimentation prd frontend backend`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * MULTI-WORD REQUIREMENTS THAT NO SINGLE WORD OF IS A REQUIREMENT.
 *
 * This list is matched against the NORMALIZED section text, so it is the only extraction path in
 * this file that does not care how the posting cased the phrase. Everything else does, and that is
 * the defect the second block below was added for.
 *
 * WHY A SEPARATE LIST AT ALL, restated because the reason is easy to lose: a bigram forms only from
 * two tokens that are EACH independently specific (see the bigram pass in extractFrom, and the
 * GRANULARITY note at SKILL_LEXICON). `machine` is not a requirement, `learning` is not a
 * requirement, and neither is in SKILL_LEXICON - so "machine learning" can only be reached through
 * the proper-noun rule at isSpecific, which needs a Title Case run. A posting that writes
 * "Machine Learning" is extracted; a posting that writes "machine learning" is not.
 *
 * THAT IS A RULE ABOUT TYPOGRAPHY, NOT ABOUT THE JOB, and measured against production packets on
 * 2026-08-08 it was costing whole postings rather than single terms. Two of the twenty-five most
 * recent packets on the owner account refused to score with
 * "This posting does not list enough specific requirements to score against":
 *
 *   Deepgram, "Software Engineering- Internship", 4,624 chars. segmentJd finds both blocks
 *   correctly - "Minimum Skills, Knowledge & Capabilities:" as required, "Preferred Qualifications:"
 *   as preferred - and the required block yields `ai` and `automations`. The preferred block yields
 *   NOTHING, because every requirement in it is a sentence-case phrase: "a degree in computer
 *   science", "exposure to machine learning, real-time systems, or audio/speech processing",
 *   "self-study, open source, or your own projects". Two terms, floor is four, refuse.
 *
 *   Truveta, "Software Engineering Intern", 4,110 chars. Same shape. Its Preferred Qualifications
 *   block yields `java`, `python` and `c#` off the one comma-list bullet, and loses "computer
 *   science" out of "bachelors' or masters' in engineering, computer science or STEM related
 *   field". Three terms, floor is four, refuse.
 *
 * NEITHER WAS AN EXTRACTION FAILURE UPSTREAM and neither was caused by the requirement-narrowing in
 * isSpecific, which is the first thing to suspect and the wrong thing. Verified by mutation: forcing
 * the `afterVerbMarker` guard to never fire changes the extracted set on neither posting by a single
 * term, because the words it would have re-admitted are not in SKILL_LEXICON in the first place. The
 * narrowing is not loosened here and must not be: see the noise cases pinned in
 * packetQualityAudit.test.ts, which live in the same file as the recall cases for exactly that
 * reason.
 *
 * AN ENUMERATION, NOT A SHAPE RULE, on the same argument SKILL_LEXICON and VENDOR_SPELLINGS make. A
 * rule of the form "admit a bigram whose head noun is one of {science, learning, systems,
 * processing}" reaches "related field", "market conditions" and "changing conditions" on the same
 * postings. There is no property of the two words that separates "machine learning" from "market
 * conditions" - only knowledge of which pairs name one thing a resume can carry.
 *
 * WHAT MAY BE ADDED. An entry has to name ONE concept that (a) a resume writes as those exact words,
 * and (b) is meaningless as any one of its words alone. "computer science" qualifies; "software
 * engineering" is deliberately ABSENT because on a software posting it is the role's own name, and
 * roleReferenceTokens only strips role words from `body` and `responsibilities` sections, so under a
 * Requirements heading it would be a free slot every SWE resume matches. "time management",
 * "written communication" and their neighbours are absent for a different reason: BOILERPLATE
 * already refuses `communication`, `presentation` and `detail oriented` as unigrams, and admitting
 * the phrase would reintroduce as a bigram exactly what that list removes as a unigram.
 *
 * MEASURED over the 800 most recently seen active postings on the production board, 2026-08-08,
 * scored against a real CS base resume. Refusals 141 -> 131, mean terms per posting 9.27 -> 9.33,
 * extracted set changed on 150 of the 800. TEN POSTINGS FLIP FROM REFUSING TO SCORING AND NONE FLIP
 * THE OTHER WAY, which is the property that matters: this pass can only add terms, so it cannot
 * push a posting under the floor.
 *
 * WHAT IT COSTS, because the denominator is capped and a new term takes a slot from an old one.
 * `gcp` leaves the final twelve on 15 postings, `pytorch`, `tensorflow` and `kafka` on 4 each,
 * `python`, `sql` and `azure` on 3. Every one of those is a Databricks posting whose twelve are
 * already all real cloud and data skills, and what displaces them is `data engineering` or `data
 * science` off the same posting - a trade between two true statements about the job, which is what
 * EMPHASIS_LIMIT says this file is always making.
 *
 * THE OTHER MOVEMENT IS STRICTLY A GAIN and is worth reading as the shape of the fix. Samsara's
 * "Enterprise Core Sales Engineer" asks for a degree in Computer Science, Electrical Engineering or
 * Mechanical Engineering. Before, the Title Case run gave it `mechanical engineering` and a bare
 * `science`; now it names `computer science` and `electrical engineering`, and the orphan `science`
 * is gone - the subsumption pass deletes it once the phrase that contains it exists.
 */
const PHRASE_LEXICON = new Set(
  `product management
product manager
product strategy
product roadmap
roadmap planning
user research
customer research
customer discovery
customer interview
stakeholder interview
competitive analysis
product requirement
product requirements
product requirement document
product requirements document
ab testing
a b testing
conversion funnel
computer science
computer engineering
electrical engineering
data science
data engineering
data structures
machine learning
deep learning
reinforcement learning
neural network
neural networks
computer vision
natural language processing
speech recognition
speech processing
signal processing
information retrieval
distributed systems
operating systems
embedded systems
real time systems
object oriented programming
version control
unit testing
open source`
    .split(/\n/)
    .map((s) => normalizeTerm(s))
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

/* THE BENEFIT-AND-LOGISTICS ROW THAT USED TO BE HERE WAS REMOVED, and this note is what remains of
 * it, because the reasoning that added it is the reasoning most likely to add it back.
 *
 * ISSUE-026 added `stipend housing commuter relocation lodging shuttle parking wage rate allowance
 * reimbursement police background check screening` as a second line of defence on a pay table. It
 * was measured at the time as changing 8 of 400 postings, and shipped as "insurance". Retrospective
 * review found the insurance cost more than the risk:
 *
 *   "Run Sanctions Screening reviews"      loses `sanctions screening`, and INVENTS `run sanctions`
 *   "Process Wage Garnishment orders"      loses `wage garnishment`, leaves `garnishment`, `process`
 *   "a public Housing Authority program"   loses `housing authority`, UNMASKS bare `authority`
 *   "Draft Police Accountability rules"    loses `police accountability`, UNMASKS `draft`
 *   "the Rate Limiting Service"            loses `rate limiting`
 *
 * `payroll`, `aml`, `kyc`, `sanctions`, `zoning` and `eeoc` are all SKILL_LEXICON entries, so these
 * are the disciplines the lexicon pass exists to serve rather than hypotheticals. Every one is the
 * failure the `completion`/`Near` note above already describes: a deny-list entry that breaks a junk
 * bigram into junk parts has moved the problem, not fixed it. Removing the row was measured to leave
 * the psiquantum posting this all started from unchanged, because the heading fix carries it alone.
 *
 * THE COLLISION TEST DOES NOT PROTECT AGAINST THIS and should not be cited as though it does. It
 * intersects SKILL_LEXICON with BOILERPLATE, and none of `rate`, `wage`, `housing`, `police` or
 * `screening` is a lexicon entry, so it passed vacuously on every one of them. What catches this
 * class is asking what the SURVIVING unigrams are, which is a question only a real posting answers.
 */

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
 * weekday costs several slots on a few, and on those few it is a large share of the score.
 *
 * `associate` JOINS THE DEGREE ROW, and it is the one term on the Gemini posting (job 10c37ef7)
 * that no section rule could have reached, because it is inside a genuine Qualifications bullet:
 * "Currently pursuing a degree in Computer Science, Computer Engineering, or a related field
 * (Bachelor's, Associate's, or Master's)". `bachelor`, `bachelors`, `master` and `masters` were
 * already here and `associate` simply was not, so the one degree in that list of three survived
 * and was shown to a student as a requirement their resume "does not mention".
 *
 * It is the same argument NON_REQUIREMENT_ACRONYMS makes for `bs` and `ba`: the degree IS a
 * requirement and it is not an EARNABLE one, because a resume writes "Associate of Science" or the
 * school and the year rather than the bare word. A requirement no resume can match is denominator
 * weight that only ever subtracts.
 *
 * THE COST IS THE JOB-TITLE SENSE, and it is real but not ours to keep: "Associate Product
 * Manager" and "Sales Associate" are titles, and `position`, `role`, `roles`, `job` and `jobs` are
 * already in this list for exactly that reason. Measured over 500 live postings, `associate`
 * reaches the final capped denominator on 9 of them and not one is a skill. */
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
degree bachelor bachelors master masters phd university college school graduate undergraduate undergrad
associate
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
act acts statute ordinance pay total package cpt
`
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
/* THE SENTENCE CONNECTIVES ON THE LAST LINE are here for the same reason `etc`, `eg` and `ie` are,
 * one clause up: a word that joins two sentences is exactly as much of a requirement as an
 * abbreviation for "and so on" is.
 *
 * They reach the term set through the PROPER-NOUN rule rather than through TECH_MARKER, and the
 * route is worth stating because it is not the obvious one. A connective opens a sentence, so
 * tokenizeSection marks it `positional`, and the positional branch of isSpecific admits a
 * capitalized word whose NEXT token is also capitalized. Akuna's Python posting (packet cc9d695d)
 * writes "...leverage AI in their daily work. However, AI assistance is not permitted during
 * interviews", and `AI` is capitalized, so `However` cleared the Title Case run test and was shown
 * to a student in amber as a requirement their resume does not mention.
 *
 * Neither POSITIONAL_OPENERS nor a shape rule is the right home. POSITIONAL_OPENERS is scoped to
 * bullet-initial position and these words are wrong ANYWHERE, mid-sentence included; and no
 * property of the token separates "However" from "Redux" except knowing what the word means, which
 * is the argument SKILL_LEXICON and BOILERPLATE both make for enumerating. The set is closed and
 * tiny: English has a few dozen conjunctive adverbs and none of them is a technology. */
const GENERIC_STOPWORDS = new Set(
  `the and for with you your our are will from that this have their they who whom able use used
per via etc eg ie a an of to in on at by as is be we it its or if not but all any more most than then
what when where how why which while into out up down over under about after before during through
been was were has had do does did been being also may might could each both few own same so too
very just now here there these those them he she his her him us me my mine i
however furthermore moreover therefore nevertheless nonetheless meanwhile otherwise
likewise similarly consequently accordingly regardless besides instead thus hence`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Place names, which are never a thing to have done.
 *
 * WHY THIS EXISTS ALONGSIDE locationTokens AND addressSpans, both of which already remove geography.
 * Each of those is driven by evidence the posting supplied about ITSELF: locationTokens reads the
 * job row's location field, and addressSpans reads text WRITTEN as an address ("Bellevue, WA").
 * Neither can reach a place the posting merely mentions in prose, and prose is where most of the
 * geography on this board actually lives. Measured over the 85 production packets on 2026-08-09:
 *
 *   Flow Traders   "A similar program is offered in our Amsterdam and Hong Kong offices for
 *                  students studying or living in Europe and APAC"
 *   Five Rings     "With offices in New York, Boca Raton, London and Amsterdam"
 *   Junior AI      "a profitable bootstrapped company of about 28 people across London and New York"
 *   Akuna          "In accordance with the Illinois Equal Pay Act, the minimum annualized base
 *                  salary starts at $145,000"
 *   DRW            "California residents, please review the California Privacy Notice"
 *
 * The Flow Traders packet is the one that forced this. Its whole geography sits at `kind: required`,
 * because a requirements bullet that lost its bullet marker in scraping ("Excellent mental math,
 * quantitative and analytical skills") reads as a heading and opens a section that runs to the end
 * of the document. PLACE_SAFE_KINDS confines the location exclusion to `body` prose on purpose, so
 * the posting's OWN city was not removed either: the student was shown a 0% match whose entire gap
 * list was `Amsterdam, APAC, Europe, Excel, Hong Kong, Internet, Law, NYC, York`.
 *
 * AN ENUMERATION, NOT A SHAPE RULE, and the reason is the one PLACE_SAFE_KINDS states at length:
 * place names collide with real requirements constantly. Mobile, Reading, Split, Cork, Bath, Salem
 * and Phoenix are all real cities AND all real things a posting can require, and deleting one of
 * those is WORSE than leaving the geography in, because a requirement the student lacks vanishing
 * from the denominator inflates the score and vanishes from the list they are supposed to act on.
 * So this list carries only names with no skill, product or discipline sense, every collision above
 * is DELIBERATELY ABSENT, and it is consulted behind the same lexicon guard locationTokens,
 * companyBrandTokens and addressSpans all use.
 *
 * COMPONENT WORDS ARE LISTED SEPARATELY from the multi-word names ("hong", "kong", "san",
 * "francisco", "boca", "raton") because that is the layer this rule acts at. A bigram only forms
 * from two tokens that are EACH independently specific, so blocking the parts is what stops
 * `hong kong` and `san francisco` from ever being built; blocking only the joined form would leave
 * both halves in the denominator on their own.
 *
 * US STATE NAMES ARE DELIBERATELY ABSENT, and so is any city that jdMatch.test.ts already uses to
 * pin a property. The states are covered from the posting's own evidence three ways over -
 * locationTokens reads the job row, addressSpans reads "<Title Case>, <state>" out of the prose, and
 * cities.ts holds the code/name mapping - and the COLLISIONS table in that suite pins that a stated
 * requirement naming a state survives whatever the location column says. An enumeration here would
 * override that pin globally rather than adding to it. `California` on DRW's four packets and
 * `Illinois` on Akuna's, the only two state names this corpus produced, are removed at the line
 * layer instead, by LEGAL_NOTICE_LINE: both occur inside a statute citation or a privacy notice,
 * which is a sentence no requirement can be, and that is the narrower place to act.
 *
 * IT IS THE COMMON CASES, NOT AN EXHAUSTIVE GAZETTEER, for the reason WEB_ADDRESS gives about its
 * own suffix list. Everything missed is one nuisance term in one posting's denominator; anything
 * wrongly added would be a real requirement deleted from every posting that states it. Add a name
 * only after checking it against the corpus, never on the intuition that it "is obviously a city".
 */
const PLACE_NAMES = new Set(
  `apac emea latam europe european asia asian africa oceania scandinavia benelux
usa america american canada mexico brazil argentina chile colombia peru
britain england scotland wales ireland france germany spain portugal italy netherlands belgium
denmark sweden norway finland iceland poland czechia austria switzerland greece
india china japan korea taiwan singapore malaysia indonesia philippines vietnam thailand
australia zealand israel emirates arabia qatar kuwait bahrain egypt nigeria kenya
york nyc brooklyn manhattan queens bronx boston cambridge chicago evanston seattle redmond
sunnyvale cupertino mountainview palo alto mateo jose diego francisco angeles sacramento oakland
berkeley pasadena irvine anaheim denver boulder austin dallas houston antonio atlanta miami orlando
tampa boca raton city philadelphia pittsburgh baltimore charlotte raleigh durham nashville memphis louisville
minneapolis milwaukee detroit cleveland columbus cincinnati indianapolis omaha wichita tucson
toronto ottawa vancouver montreal calgary waterloo
london manchester edinburgh glasgow dublin belfast amsterdam rotterdam eindhoven brussels antwerp
paris lyon marseille berlin munich hamburg frankfurt stuttgart zurich geneva basel vienna prague
warsaw krakow budapest bucharest stockholm gothenburg copenhagen oslo helsinki tallinn vilnius riga
madrid barcelona valencia lisbon porto milan rome turin naples athens istanbul
tokyo osaka kyoto yokohama seoul busan beijing shanghai shenzhen guangzhou hangzhou taipei
hong kong singapore bangkok jakarta manila hanoi
bengaluru bangalore mumbai delhi noida gurgaon gurugram hyderabad chennai kolkata ahmedabad
sydney melbourne brisbane perth auckland wellington
aviv jerusalem haifa dubai abu dhabi riyadh doha cairo nairobi lagos accra johannesburg
sao paulo janeiro bogota santiago lima buenos aires
san las los saint`
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
eeo ada faq tbd asap eod eta hq
et pt ct mt est edt cst cdt mst mdt pst pdt gmt`
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
hands exposure ability willing willingness eager eagerness passion desire interest curious curiosity
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
   * On a MATCHED term only: the string on the resume that covered this requirement, when it is not
   * the requirement's own words.
   *
   * Written by scoreJdMatch, never by the extractor, because it is a fact about the pair rather
   * than about the posting. It exists so the review screen can anchor the mark: see resumeSatisfies.
   * It is never an input to scoring and never widens what counts as a match; it only reports which
   * of the already-permitted spellings did.
   */
  satisfied_by?: string;
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
/**
 * THE OTHER HALF OF THE SAME EVIDENCE, and the one that makes the verb rule safe.
 *
 * `everCapitalized` is every token the posting writes with a leading capital anywhere. A posting
 * that genuinely requires Python writes "Python" at least once; one that only ever writes the
 * letters in lowercase, in verb position, is not naming a technology. Without this second set the
 * verb rule would read "exposure to python" and "introduction to sql" as verbs and delete a real
 * requirement, which is the trade this file refuses everywhere else.
 */
interface JdCasing {
  /** Written in lowercase somewhere, so a capital elsewhere is decoration rather than a name. */
  alsoLowercased: Set<string>;
  /** Written with a leading capital somewhere, so the word is at least plausibly a name. */
  everCapitalized: Set<string>;
}

function documentCasing(jdText: string): JdCasing {
  const alsoLowercased = new Set<string>();
  for (const m of jdText.matchAll(/[a-z][a-z0-9+#./_-]*/g)) {
    const t = normalizeTerm(m[0]);
    if (t) alsoLowercased.add(t);
  }
  const everCapitalized = new Set<string>();
  for (const m of jdText.matchAll(/[A-Z][A-Za-z0-9+#./_-]*/g)) {
    const t = normalizeTerm(m[0]);
    if (t) everCapitalized.add(t);
  }
  return { alsoLowercased, everCapitalized };
}

function isSpecific(
  token: string,
  positionalCapital: boolean,
  nextIsCapitalized = false,
  casing?: JdCasing,
  afterVerbMarker = false,
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
  // A place is not a thing to have done. Behind the lexicon guard for the "Java, Indonesia" reason
  // locationTokens and addressSpans both give: a name that is also a real skill stays a real skill.
  if (PLACE_NAMES.has(t) && !inLexicon(t)) return false;
  if (inLexicon(t)) {
    // A LEXICON HIT USED TO END THE QUESTION HERE, and that is how "Ability to react quickly and
    // accurately to rapidly changing market conditions" put React on a student's gap list. The
    // lexicon says how a word CAN be spelled; it cannot say how this posting USED it.
    //
    // Three things have to be true at once before the posting's own usage outranks the lexicon, and
    // all three are evidence rather than vocabulary:
    //   - the word sits directly after an infinitive marker or a modal, so it is a verb here;
    //   - this occurrence is written entirely in lowercase;
    //   - the posting never writes the word with a capital ANYWHERE, so there is no occurrence
    //     that could be the product name. This is the guard that keeps "exposure to python" and
    //     "introduction to sql" - where the posting also writes Python or SQL properly - intact,
    //     and it is why the rule cannot quietly delete the requirement a posting is about.
    if (afterVerbMarker && token === token.toLowerCase() && !casing?.everCapitalized.has(t)) {
      return false;
    }
    return true;
  }
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
    if (casing?.alsoLowercased.has(t)) return false;
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
  /** The token sits directly after an infinitive marker or a modal, so a lowercase word here is
   *  being used as a verb. See VERB_MARKERS. */
  afterVerbMarker: boolean;
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

/**
 * A lowercase English word glued to a dotted product name by a scrape that lost a space.
 *
 * Akuna's "Software Engineer Intern - C# .NET Desktop" (packet 213674e2) reached us reading
 * "Understanding of.NET Framework and C# programming language". The token pattern admits '.' inside
 * a token so that node.js survives, so the whole run "of.NET" arrived as one token; normalizeTerm
 * DELETES dots, so the key was `ofnet`; and TECH_MARKER tests the RAW token, which still had its
 * dot, so an English preposition welded to a product name was promoted to HARD SIGNAL and shown to
 * the student in amber as the requirement "of.NET Framework". Worse than the invented requirement
 * was the one it hid: `.NET`, the only technology in the job's title, was never extracted at all,
 * so the requirement the posting is entirely about could not be scored, coloured, or answered.
 *
 * THE SHAPE IS CONCLUSIVE AND NEEDS NO WORD LIST. An all-lowercase run, a dot, then a capital is
 * not how any technology spells itself: node.js, asp.net, scikit.learn and socket.io all continue
 * in lowercase, and ASP.NET, U.S.C and Ph.D do not start lowercase. Only a lost space produces it.
 * The dot stays with the RIGHT-HAND piece, so ".NET" keeps the marker that says "technical name"
 * and displays to the student the way the employer meant to write it.
 *
 * Mirrored in role-quick-website's requirement-terms.ts. See tokenizerContract.ts.
 */
const GLUED_LOWERCASE_PREFIX = /^([a-z]+)(\.[A-Z][A-Za-z0-9+#./_-]*)$/;

/**
 * Words after which a lowercase lexicon word is a VERB rather than a technology.
 *
 * Akuna's Python posting (packet cc9d695d) says "Ability to react quickly and accurately to rapidly
 * changing market conditions". `react` is in SKILL_LEXICON, isSpecific consulted inLexicon before
 * any evidence about how the word was used, and the student was shown React in amber as a
 * requirement their resume does not mention. The posting spelling it lowercase is the signal
 * lowercaseTokens exists to read, but a lexicon hit short-circuited past it.
 *
 * THE POSITION IS THE EVIDENCE, NOT THE SPELLING ALONE, and that is deliberately narrower than
 * "reject any lowercase lexicon word". Postings write "experience with python" and "strong sql
 * skills" in lowercase constantly, and those are real requirements; what no posting does is name a
 * technology directly after an infinitive marker or a modal. "Ability to react", "expected to
 * scale", "must design" are grammar. "Proficiency in Go" and "familiarity with Rust" are not
 * touched, because `in` and `with` are not here.
 *
 * An intervening -ly adverb is allowed through ("ability to quickly react") because it modifies the
 * verb and is the only word class that routinely sits in that slot.
 */
const VERB_MARKERS = new Set([
  'to',
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'must',
  'may',
  'might',
  'cannot',
  // A DETERMINER MARKS THE SAME THING FROM THE OTHER SIDE: the word after it is being used as a
  // common noun, not named as a product. Databricks' "Product Management Intern (Summer 2027)"
  // (packets cd4d316d, 7030b54f, a82d860a) writes "Deeply understand customer problem space and
  // establish the rails for viable solution space", and `rails` is in SKILL_LEXICON, so the ONLY
  // amber on that whole packet was Ruby on Rails - a framework the posting never mentions - shown
  // to a student as the single thing standing between them and the job. `rails` occurs exactly once
  // in that document and it is the English idiom.
  //
  // This is the same defect as `react` from "Ability to react quickly", which this list was written
  // for, and it is guarded by the same three conditions rather than by the marker alone: the
  // occurrence must be entirely lowercase AND the posting must never write the word with a capital
  // anywhere. "Experience with the Python standard library" and "the AWS console" are untouched,
  // because a posting that requires either writes it capitalized. See isSpecific.
  'the',
  'a',
  'an',
]);


/**
 * The spans of a section that are an ADDRESS, found from the shape of the text rather than from
 * the location field.
 *
 * WHY THIS EXISTS ALONGSIDE locationTokens, WHICH ALREADY REMOVES PLACES. That exclusion is driven
 * by the posting's own location column and is deliberately confined to `body` sections, for the
 * reason PLACE_SAFE_KINDS sets out at length: a location field of "Mobile, AL" must not be allowed
 * to delete a Requirements bullet reading "Mobile development experience", and a posting in Java,
 * Indonesia must not delete `Java`. That argument is correct and this rule does not weaken it.
 *
 * It is also not enough, because an address is not only written in the location column. Gemini's
 * intern posting (job 10c37ef7) writes "in person 3 days a week at our New York City, NY office"
 * inside the block opened by "The Role:", which is `responsibilities`, so PLACE_SAFE_KINDS declines
 * to touch it and `NY` and `York City` take two of the twelve denominator slots. `NY` is a two
 * letter capital run, so it is ACRONYM, so it is HARD SIGNAL, so it is eligible for the reserved
 * slots in capToEmphasis ahead of a real skill. EMPHASIS_LIMIT lists exactly this under PLACE
 * ACRONYMS as a known residual; this is the rule for it.
 *
 * THE DISCRIMINATOR IS THE OCCURRENCE, NOT THE WORD, and that is what makes it safe where a wider
 * PLACE_SAFE_KINDS would not be. A span is dropped where the text is WRITTEN as an address:
 *
 *   <Title Case run>, <state code or state name>     "New York City, NY", "Bellevue, Washington"
 *   State of <Title Case run>                        "the State of Washington"
 *
 * So on a posting in Mobile, Alabama, the string "Mobile, AL" is a span and its tokens go, while
 * "Mobile development experience" three lines up is not a span and is extracted exactly as before.
 * The word is not banned; the address is. That is strictly better than the location-field rule,
 * which can only decide per-word and therefore has to be confined to prose to stay honest.
 *
 * A LEXICON SKILL INSIDE A SPAN IS STILL KEPT, the same guard locationTokens and companyBrandTokens
 * both use and for the same reason: "Java, Indonesia" and "Oracle, Arizona" are the shape, and
 * deleting a real requirement to remove a nuisance is the trade PLACE_SAFE_KINDS exists to refuse.
 *
 * US-ONLY, and stated as a limit rather than hidden. The state table is the one cities.ts already
 * carries, so "Bengaluru, Karnataka" and "London, UK" are not covered. They are a smaller problem
 * than they look, because a non-US address usually appears in the location field too and most
 * postings carrying one have no stated sections for PLACE_SAFE_KINDS to be confined out of.
 */
const STATE_CODES = US_STATES.map(([code]) => code).join('|');
const STATE_NAMES = US_STATES.map(([, name]) => name).join('|');
const ADDRESS_SPAN = new RegExp(
  String.raw`\b[A-Z][a-zA-Z]*(?:[ ][A-Z][a-zA-Z]*){0,3},[ ]*(?:${STATE_CODES}|${STATE_NAMES})\b` +
    String.raw`|\bStates?[ ]of[ ][A-Z][a-zA-Z]*(?:[ ][A-Z][a-zA-Z]*){0,2}`,
  'g',
);

function addressSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(ADDRESS_SPAN)) {
    const start = m.index ?? 0;
    out.push([start, start + m[0].length]);
  }
  return out;
}

function inAddress(spans: Array<[number, number]>, start: number, end: number): boolean {
  return spans.some(([a, b]) => start >= a && end <= b);
}

/** Does any token on this line reach the term set as a lexicon skill, an acronym or a marked
 *  technical name? The guard in front of every structural rule below. */
function carriesHardSignal(text: string): boolean {
  for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9+#./_-]*/g)) {
    // ALL-CAPS PROSE IS NOT AN ACRONYM, and without this line the guard defeats itself on exactly
    // the headings it is meant to catch. ACRONYM is "2-5 capital letters", so in Virtu's all-caps
    // heading "THE PROCESS" the word `THE` reads as hard signal, the line is spared, and `process`
    // goes into the denominator. A token the extractor would refuse anyway cannot be the evidence
    // that keeps a line, so the deny-lists are consulted here exactly as isSpecific consults them.
    if (isDenied(normalizeTerm(m[0]))) continue;
    if (isHardSignal(m[0])) return true;
  }
  return false;
}

/**
 * The spans of a section that are its own STRUCTURE: a heading nobody classified, or the label on
 * the front of a labelled paragraph.
 *
 * segmentJd already CONSUMES every heading it recognises, so "Requirements" and "What you'll do"
 * never reach the extractor at all. A heading it does NOT recognise is a different story: the line
 * falls through the whole classifier and is appended to the current section as content, and the
 * proper-noun rule then reads it exactly as it was meant to be read - a short capitalized phrase
 * that is nowhere else in the posting - and calls it a requirement. Measured over the 85 production
 * packets on 2026-08-09:
 *
 *   Point72   "Job Description" and "Desirable Candidates"   -> `description`, `desirable`
 *   Virtu     "THE PROCESS"                                  -> `process`
 *   Jump      "Also Helpful, but Not Required:"              -> `helpful`
 *
 * The LABELLED-PARAGRAPH half is the same defect wearing inlineLabel's shape. That function reads
 * `Label: <paragraph>` and re-weights the paragraph when the label classifies; when it does not, the
 * whole line including the label stays where it is, and the label is a capitalized word standing
 * alone in front of a colon, which is the strongest proper-noun shape there is. DRW's "Software
 * Developer Intern" carries its perks that way, one label per line:
 *
 *   Community: Throughout the summer, we host a variety of educational, social...
 *   Education: As technology continues to drive the trading industry forward...
 *   Housing: DRW provides fully furnished apartments located close to the office...
 *   Mentorship: You'll build a professional relationship with an experienced mentor...
 *
 * All four were `kind: required` at weight 1, on a student's gap list, four packets over. The
 * SKILL_LEXICON note already names `mentorship` - "Mentorship: you'll build a relationship with a
 * mentor" - as a PERK it refused to admit as a skill; this is the same sentence arriving by the
 * other door.
 *
 * THE GUARD IS HARD SIGNAL, AND IT IS WHAT KEEPS THIS FROM DELETING REQUIREMENTS. A scraped posting
 * whose bullet markers were lost writes its requirements as short capitalized lines, which is the
 * same shape as an unrecognised heading and cannot be told from one by position. So a line, or a
 * label, containing a lexicon skill, an acronym or a technical marker is left entirely alone:
 * "Python", "C++ / Java", "AWS and Terraform", "Embedded Software Engineering Intern" are all
 * untouched. What is dropped is the residue - a capitalized phrase with no technical content
 * whatsoever - which is what a section heading and a perk label both are.
 *
 * ONLY THE LABEL IS DROPPED, never the paragraph after it, for the reason inlineLabel gives about
 * the other direction: the paragraph genuinely belongs to the label and may say something real.
 *
 * THE COST IS NAMED RATHER THAN HIDDEN. A heading-shaped line that IS the only place a posting
 * writes a non-technical requirement - a bare "Machine Learning" heading on a posting that never
 * says ML again - loses that phrase. Nothing of that shape occurs in the 85-packet corpus, so the
 * honest bound is "not measured to cost anything", not "cannot".
 */
function structuralSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let at = 0;
  for (const line of text.split('\n')) {
    const start = at;
    at += line.length + 1;
    if (!line.trim()) continue;
    // A bullet is content. Both halves of this rule refuse them outright, the same way inlineLabel
    // does and for the reason it records: "- Benefits: describe the benefits of our platform" is a
    // real requirements bullet, and the shape guards would not save it.
    if (/^\s*[-*•·▪▫‣◦●○–—→⇒»›✓✔]/.test(line)) continue;

    if (isHeadingLine(line) && !classifyHeading(line) && !carriesHardSignal(line)) {
      out.push([start, start + line.length]);
      continue;
    }

    const colon = line.indexOf(':');
    if (colon < 1) continue;
    const label = line.slice(0, colon);
    // isHeadingLine's own budget, not the wider noise one, for the reason inlineLabel states: a long
    // run of words before a colon is a sentence with a colon in it, not a label.
    if (label.trim().length > 40 || label.trim().split(/\s+/).length > 6) continue;
    if (!/^\s*[A-Z]/.test(label)) continue;
    if (!line.slice(colon + 1).trim()) continue;
    if (classifyHeading(label) || carriesHardSignal(label)) continue;
    out.push([start, start + colon]);
  }
  return out;
}

/**
 * The span of a sentence that lists the EMPLOYER'S OWN ORG CHART.
 *
 * Roblox's "[Summer 2027] Software Engineer Intern" (packets 9f1138c0 and b1c2ad7f) is half noise
 * and all of it comes from two sentences:
 *
 *   "Engage in our team matching process, learning about teams across Roblox, including Infra,
 *    Engine, Search and Discovery, Foundational AI, and Economy..."
 *   "Partner closely with cross-functional teams, including Design, Product, Data, QA, and DevOps,
 *    to deliver cohesive products and features."
 *
 * `Infra`, `Engine`, `Search`, `Discovery`, `Design` and `Product` are the names of Roblox teams.
 * Not one is reachable by selfReferenceTokens, roleReferenceTokens, locationTokens or
 * companyBrandTokens, because none of them IS the company, the role or an office; they are ordinary
 * capitalized nouns, which is exactly what the proper-noun rule is built to admit. The employer is
 * telling the student who they would sit next to, and the student was charged for not having it.
 *
 * THE DISCRIMINATOR IS THE OCCURRENCE, NOT THE WORD, which is the same argument addressSpans makes
 * and the reason this is safe where a deny-list on `design` and `product` would be catastrophic.
 * Those two words ARE the requirement on a design or a product posting. What is dropped here is a
 * name written inside a roster: an org noun ("teams", "functions", "partners", "organizations"),
 * then an enumeration marker ("including", "across", "such as"), then a run of Title Case items
 * separated by commas and conjunctions. A Product Management posting that also writes "product
 * roadmap" or "product management" anywhere else keeps the term from THAT occurrence, because terms
 * are built per occurrence and a span only silences the occurrence inside it.
 *
 * THE ENUMERATION IS CONSUMED ITEM BY ITEM rather than run to the end of the clause. Ending the span
 * at the sentence would swallow whatever follows the list ("...and Economy, sharing your preferences
 * so we can help connect your career with your curiosity"), which on another posting could be a real
 * requirement. The run stops at the first thing that is not a Title Case item or a separator, so on
 * Brex's "cross-functional teams-including Engineering, Legal, Compliance, and Design-on key
 * decisions" it ends at `Design` and never reaches "key decisions".
 *
 * A LEXICON SKILL INSIDE THE ROSTER IS STILL KEPT, the same guard addressSpans, locationTokens and
 * companyBrandTokens all use and for the same reason: `QA` and `DevOps` are Roblox team names in
 * that sentence AND real requirements on half the board, and deleting a real requirement to remove
 * a nuisance is the trade PLACE_SAFE_KINDS exists to refuse.
 */
const ORG_ROSTER = new RegExp(
  // The gap between the org noun and the enumeration marker is GREEDY, so when a sentence carries
  // two markers the LAST one wins. Roblox writes "teams across Roblox, including Infra, Engine..."
  // and a lazy gap stopped at `across`, which put the company name itself at the head of the
  // enumeration and ended the run one item later at the dash before `including`.
  String.raw`\b(?:teams?|orgs?|organizations?|organisations?|departments?|functions?|groups?|pods?|disciplines?|partners?|business units?)\b[^.\n]{0,40}\b(?:including|includes?|across|such as|like|spanning)\b` +
    // TWO ITEMS MINIMUM, which is what makes a roster a roster and is also what disambiguates the
    // sentence above. "Engage in our team matching process, learning about teams across Roblox,
    // including Infra, Engine..." carries `team` 39 characters before `across`, so the greedy gap
    // reaches that pair first and enumerates the single item `Roblox`. Requiring two items rejects
    // it, and the engine backtracks onto the `teams ... including` pair that names the real roster.
    String.raw`(?:[\s,;&/]*(?:and|or)?[\s,;&/]*[A-Z][A-Za-z0-9&+]*(?:[ ][A-Z][A-Za-z0-9&+]*){0,3}){2,}`,
  'g',
);

function rosterSpans(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(ORG_ROSTER)) {
    const start = m.index ?? 0;
    out.push([start, start + m[0].length]);
  }
  return out;
}

/**
 * The span of a product or team the employer named AFTER ITS OWN NAME.
 *
 * companyBrandTokens already says why a phrase carrying the employer's name is that employer's
 * branding rather than a requirement, and drops "Databricks SQL" on that argument. It can only see
 * a phrase one of whose WORDS is the company name, so the commoner spelling walks past it: the
 * company name, then the product name in Title Case beside it. Point72's "Quantitative Developer
 * Intern" (packets 90062b81 and 908efd63) writes
 *
 *   "Point72 Internal Alpha Capture (IAC) is developing scalable quantitative equity trading
 *    signals..."
 *
 * and the extractor took `internal alpha`, `alpha capture` and `iac` out of it: one internal product,
 * counted three times, in the denominator of a student who could not possibly have used it, and
 * `IAC` marked hard signal by ACRONYM so it took a reserved slot ahead of a real skill.
 *
 * THE PARENTHETICAL ACRONYM IS PART OF THE SAME SPAN because it is part of the same act: writing
 * "(IAC)" directly after the run is the employer DEFINING their own abbreviation, so it can only
 * ever name the thing the run named.
 *
 * Bounded at four words, and lexicon skills inside are spared, both for the reason companyBrandTokens
 * gives: a company word that is also a real skill must not delete real requirements through every
 * phrase it appears in.
 */
function brandRunSpans(text: string, company: string | null | undefined): Array<[number, number]> {
  const name = (company ?? '').trim();
  if (name.length < 2) return [];
  const pattern = new RegExp(
    String.raw`\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, String.raw`\s+`)}(?:'s|’s)?` +
      String.raw`(?:[ ][A-Z][A-Za-z0-9&+]*){1,4}(?:[ ]?\([A-Z]{2,6}\))?`,
    'gi',
  );
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(pattern)) {
    const start = m.index ?? 0;
    out.push([start, start + m[0].length]);
  }
  return out;
}

function tokenizeSection(text: string): SectionToken[] {
  const raw = [...text.matchAll(/[A-Za-z][A-Za-z0-9+#./_-]*/g)];
  const out: SectionToken[] = [];
  let prevEnd = 0;

  for (const m of raw) {
    const start = m.index ?? 0;
    const gap = text.slice(prevEnd, start);
    // A newline followed only by bullet/number decoration, or the very start, or a sentence end.
    //
    // THE GLYPH CLASS IS WIDER THAN `-*•·`, and every character past those four was found in a real
    // posting rather than guessed at. Scale AI's "AI Builder Intern" (packet 31528fd9) writes its
    // requirements bullets with an arrow: "→ Comfortable with Python and/or JavaScript" and
    // "→ Currently enrolled in an undergraduate or graduate program". An arrow is not in the class,
    // so the first word of every bullet was NOT positional, so the proper-noun rule read a plain
    // mid-sentence capital and admitted it: `Comfortable` and `Currently` went into the denominator
    // as requirements, both of them words POSITIONAL_OPENERS already lists precisely so they cannot.
    //
    // The `positional` flag is a BACKEND-ONLY concept and does not touch the shared tokenizer
    // contract: the website's tokenizeForMatch produces token text and offsets, which this does not
    // change. tokenizerContract.ts stays green.
    const positional =
      out.length === 0 ||
      /[\n\r][\s]*[-*•·▪▫‣◦●○–—→⇒»›✓✔]?[\s]*(\d+[.)])?[\s]*$/.test(gap) ||
      /[.!?:;]["'’)\]]*\s*$/.test(gap);

    let body = m[0];
    const trail = body.match(/[./_-]+$/)?.[0] ?? '';
    if (trail) body = body.slice(0, -trail.length);
    if (!body) {
      prevEnd = start + m[0].length;
      continue;
    }

    const slashPieces =
      body.includes('/') && !SLASH_FORMS.has(normalizeTerm(body))
        ? body.split('/').filter(Boolean)
        : [body];

    // A lost space welds an English word onto a dotted product name. Applied after the slash split
    // so "of.NET/C#" reaches it one piece at a time, and only at the FIRST such dot, because the
    // rest of the run belongs to the product name (".NET.Core" is one thing, not two).
    const pieces = slashPieces.flatMap((piece) => {
      const glued = GLUED_LOWERCASE_PREFIX.exec(piece);
      return glued ? [glued[1], glued[2]] : [piece];
    });

    let offset = start;
    for (let p = 0; p < pieces.length; p++) {
      const piece = pieces[p];
      const at = text.indexOf(piece, offset);
      const pieceStart = at === -1 ? offset : at;
      out.push({
        text: piece,
        start: pieceStart,
        end: pieceStart + piece.length,
        // Only the first piece of a split inherits the positional flag.
        positional: positional && p === 0,
        nextIsCapitalized: false,
        afterVerbMarker: false,
      });
      offset = pieceStart + piece.length;
    }
    prevEnd = start + m[0].length - trail.length;
  }

  for (let i = 0; i < out.length; i++) {
    if (i < out.length - 1) out[i].nextIsCapitalized = /^[A-Z]/.test(out[i + 1].text);
    const prev = out[i - 1];
    const prev2 = out[i - 2];
    out[i].afterVerbMarker =
      isVerbMarker(prev) || (prev !== undefined && /ly$/i.test(prev.text) && isVerbMarker(prev2));
  }
  return out;
}

function isVerbMarker(token: SectionToken | undefined): boolean {
  return token !== undefined && VERB_MARKERS.has(token.text.toLowerCase());
}

/**
 * The tokenizer's output, as the SHARED CONTRACT the website has to match.
 *
 * role-quick-website's requirement-terms.ts has to cut a job description into the same pieces this
 * file does, or a term the scorer counted will fail to highlight and the two panes will contradict
 * the number beside them. That is not hypothetical: `normalizeTerm` and `singular` were kept
 * byte-identical across the two repos and the TOKENIZERS around them were not, so every
 * slash-joined requirement on the board - HTML/CSS, Python/Rust, AWS/GCP/Azure, Linux/Unix,
 * Computer Science/Engineering - was scored on this side and left colourless on that one, 22.7% of
 * every term-instance across 25 measured packets.
 *
 * The two repos deploy independently and cannot import from each other, so agreement is held by
 * tokenizerContract.ts: one corpus of cases, duplicated byte-for-byte in both repos, asserted by a
 * test on each side against its own tokenizer.
 */
export function tokenizeForMatch(text: string): Array<{ text: string; start: number; end: number }> {
  return tokenizeSection(text).map(({ text: value, start, end }) => ({ text: value, start, end }));
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
/* THE LEGAL-ENTITY SUFFIXES on the last line are the employer's own name whatever the employer is
 * called, so they belong here rather than in companyBrandTokens, which can only remove the words the
 * job row happens to spell. Akuna's Python posting (packet cc9d695d) writes "Akuna Capital LLC is an
 * Equal Opportunity Employer": the row says "Akuna", so `akuna` went and `llc` stayed, marked hard
 * signal by ACRONYM and shown to a student as a requirement. */
const SELF_REFERENCE = new Set(
  `summer spring fall winter autumn
united states usa canada remote hybrid onsite
intern internship co-op coop apprentice apprenticeship
candidate applicant university college student undergraduate
inc llc ltd llp lp plc gmbh corp corporation incorporated holdings`
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
const ROLE_SAFE_KINDS: ReadonlySet<SectionKind> = new Set<SectionKind>(['body', 'responsibilities']);

/**
 * The company and the role, which are excluded from EVERY section rather than only from prose.
 *
 * Deliberately unlike the location exclusion above. A posting genuinely cannot require experience
 * with its own name or its own job title, wherever that name appears, so there is no collision to
 * defend against and no reason to narrow it by section.
 */
function selfReferenceTokens(context?: JdContext): Set<string> {
  const tokens = new Set(SELF_REFERENCE);
  for (const value of [context?.company]) {
    if (!value) continue;
    const normalized = normalizeTerm(value);
    // The whole phrase AND each word: "Litos QA" must not survive as "Litos" or as "QA" either.
    tokens.add(normalized);
    for (const word of normalized.split(' ')) if (word.length > 1) tokens.add(word);
  }
  return tokens;
}

function roleReferenceTokens(role: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  const normalized = normalizeTerm(role ?? '');
  if (!normalized) return tokens;
  tokens.add(normalized);
  for (const word of normalized.split(' ')) if (word.length > 1) tokens.add(word);
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
  const roleSelf = roleReferenceTokens(context?.role);
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
      (t) =>
        !excluded(t, self) &&
        !(ROLE_SAFE_KINDS.has(t.kind) && excluded(t, roleSelf)) &&
        !branded(t) &&
        !(PLACE_SAFE_KINDS.has(t.kind) && excluded(t, places)),
    );

  const casing = documentCasing(jdText);
  const sections = segmentJd(jdText, context);
  const hasPrimaryFitSection =
    sections.some((s) => PRIMARY_STATED_KINDS.has(s.kind)) || hasPrimaryFitHeading(jdText);
  const rawTerms = strip(extractFrom(sections, casing, context?.company));
  if (hasPrimaryFitSection) {
    return capToEmphasis(strip(extractFrom(sections.filter(isPrimaryFitSection), casing, context?.company)));
  }
  const terms = preferStatedRequirements(rawTerms);
  if (terms.length >= MIN_SCORABLE_TERMS) return capToEmphasis(terms);

  // A noise heading runs until the next recognised heading, so a posting that OPENS with
  // "Compensation" or "Pay range" (mandatory first in pay-transparency states, and increasingly
  // common everywhere) can put the entire document inside a zero-weight section. The student was
  // then told the posting "does not list enough specific requirements" about a posting full of
  // them. When zeroing the noise leaves us unable to score, re-read those sections as ordinary
  // body prose rather than throwing the posting away.
  //
  // ONLY WHEN THE NOISE IS WHERE THE DOCUMENT ACTUALLY IS, added 2026-08-04. The sentence above
  // describes a posting whose BODY ended up inside a zero-weight section, and every word of the
  // justification depends on that. The gate in front of it did not: it fired whenever the scored
  // sections yielded fewer than MIN_SCORABLE_TERMS, which is also true of a posting that has real
  // headings, a correctly-zeroed footer, and simply does not state four concrete requirements.
  //
  // On those postings salvage is not rescuing a swallowed body, it is PADDING. Gemini's intern
  // posting (job 10c37ef7) states three: its Qualifications block is "Passionate about
  // blockchain", "Self-motivated and proactive", "Strong communication skills". After the section
  // fixes above it extracted `computer science`, `api` and `rest`, one short of the floor, and
  // salvage made up the difference out of the company blurb - `Cameron` and `Tyler Winklevoss`,
  // the founders' names, presented to a student as requirements their resume does not mention.
  // MIN_SIGNAL_TERMS names that exact shape ("Bob Smith", "Jane Doe") as the thing the floor
  // exists to prevent, and preferStatedRequirements names padding as the thing that made the
  // denominator dishonest in the first place.
  //
  // Comparing the two character totals is the smallest test that separates the two cases. The
  // pay-transparency banner puts most of the posting inside noise, so noise wins and it still
  // salvages. A posting with a normal footer has most of its text in scored sections, so it does
  // not, and it refuses instead - which is what MIN_SCORABLE_TERMS is for and what the module
  // header means by "IT REFUSES TO SCORE RATHER THAN GUESS".
  //
  // Footer sections are excluded from the noise side of the comparison as well as from the
  // re-reading, so a long EEO block cannot be what tips a posting into salvaging.
  const salvageable = sections.filter((s) => s.kind === 'noise' && !s.footer);
  const chars = (list: JdSection[]) => list.reduce((n, s) => n + s.text.length, 0);
  if (chars(salvageable) <= chars(sections.filter((s) => s.weight > 0))) return capToEmphasis(terms);

  const salvaged = strip(
    extractFrom(
      sections.map((section) =>
        section.kind === 'noise' && !section.footer
          ? { ...section, kind: 'body' as SectionKind, weight: SECTION_WEIGHT.body }
          : section,
      ),
      casing,
      context?.company,
    ),
  );
  return capToEmphasis(salvaged.length > terms.length ? salvaged : terms);
}

/** The sections where an employer states candidate fit directly, as opposed to work prose around it. */
const PRIMARY_STATED_KINDS = new Set<SectionKind>(['required', 'preferred']);
const STATED_KINDS = new Set<SectionKind>(['required', 'preferred', 'responsibilities']);
const PRIMARY_FIT_HEADING_PATTERN = new RegExp(
  String.raw`\b(preferred|nice[- ]to[- ]have|bonus|plus(es)?|desired|good to have|additional qualifications|requirements?|qualifications?|what you'?ll need|what we('?re)? look(ing)? for|what would make you a strong fit|must[- ]have|minimum|basic qualifications|skills?|you have|your background|about\s+${SECOND_PERSON_SUBJECT})\b`,
  'i',
);
const IMPACT_FIT_HEADING_PATTERN = /\b(examples? of how .+ impact|impact you will have|make an impact)\b/i;

function isPrimaryFitSection(section: JdSection): boolean {
  if (PRIMARY_STATED_KINDS.has(section.kind)) return true;
  return section.kind === 'responsibilities' && IMPACT_FIT_HEADING_PATTERN.test(section.heading ?? '');
}

function hasPrimaryFitHeading(jdText: string): boolean {
  for (const line of jdText.split(/\r?\n/)) {
    // headingSubject, not headingCore, for the reason classifyHeading gives: a heading names its
    // section before the first comma. Read the whole line here and Flow Traders' bullet "Class of
    // 2028, preferred" answers yes, which sends extractJdTerms down the primary-fit branch looking
    // for a section that classifyHeading has already, correctly, declined to open. The posting then
    // extracts NOTHING and refuses to score. The two tests have to read the same string.
    const core = headingSubject(line);
    if (isHeadingLine(line) && PRIMARY_FIT_HEADING_PATTERN.test(core)) return true;
    const inline = inlineLabel(line);
    if (inline && PRIMARY_STATED_KINDS.has(inline.kind)) return true;
  }
  return false;
}

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
 * posting SECTION_WEIGHT.body exists for. Once the employer gives us a primary fit section, even a
 * sparse one, the caller refuses instead of inventing missing requirements from surrounding prose.
 */
function preferStatedRequirements(list: JdTerm[]): JdTerm[] {
  const primary = list.filter((t) => PRIMARY_STATED_KINDS.has(t.kind));
  if (primary.length > 0) return primary;
  const stated = list.filter((t) => STATED_KINDS.has(t.kind));
  if (isScorable(stated)) return stated;
  // Responsibility-only postings still score when concrete enough; otherwise body prose is the
  // fallback only for postings that never stated candidate-fit requirements.
  return list;
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

function countNormalizedMentions(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(` ${needle} `);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(` ${needle} `, at + needle.length + 1);
  }
  return count;
}

/**
 * The posting's OWN spelling of a PHRASE_LEXICON hit, for display.
 *
 * The phrase pass matches on normalized text, so all it holds afterwards is the normalized key, and
 * before this it used that key as the display string. That was invisible while the list was
 * seventeen product-management phrases and became visible the moment it carried "computer science":
 * the overwhelming majority of postings write "Computer Science", and the review pane would have
 * started rendering their own requirement back at them in lowercase. The unigram and bigram passes
 * both display the token verbatim; this is that same rule for the one pass that could not.
 *
 * The separator is `[^A-Za-z0-9]{1,3}` rather than a space because normalizeTerm folds hyphens,
 * slashes and apostrophes into the gap: "real-time systems" and "audio/speech processing" both key
 * as spaces and both should display as written. It is length-bounded so the match cannot run across
 * a sentence boundary and return a span the posting never wrote as one phrase.
 *
 * Returns undefined when the phrase cannot be located in the raw text - the normalized form can
 * differ enough (a stripped apostrophe inside a word) that the reverse search misses - and the
 * caller keeps the normalized key. Display only; nothing downstream matches on it.
 */
function verbatimSpelling(sectionText: string, term: string): string | undefined {
  const pattern = term
    .split(' ')
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^A-Za-z0-9]{1,3}');
  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, 'i').exec(sectionText)?.[0];
}

function extractFrom(sections: JdSection[], casing?: JdCasing, company?: string): JdTerm[] {
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

    const sectionText = section.text
      .split(/\r?\n/)
      .filter((line) => !isNonResumeRequirementLine(line))
      .join('\n');
    const tokens = tokenizeSection(sectionText);
    // Computed once per section rather than per token: the scan is linear and the spans are
    // reused by both the unigram and the bigram pass below.
    // Four span rules, computed once per section and reused by the unigram and the bigram pass.
    // An address, the employer's own org roster and a product named after the employer's own name
    // all SPARE a lexicon skill, for the reason addressSpans states: deleting a real requirement to
    // remove a nuisance is the trade PLACE_SAFE_KINDS exists to refuse. A structural span does not
    // need the same guard because its own rule already declines any line carrying hard signal.
    const spans = [
      ...addressSpans(sectionText),
      ...rosterSpans(sectionText),
      ...brandRunSpans(sectionText, company),
    ];
    const structural = structuralSpans(sectionText);
    const isExcluded = (tok: SectionToken) =>
      inAddress(structural, tok.start, tok.end) ||
      (inAddress(spans, tok.start, tok.end) && !inLexicon(normalizeTerm(tok.text)));

    const normalizedSection = ` ${normalizeTerm(sectionText)} `;
    for (const term of PHRASE_LEXICON) {
      const mentionCount = countNormalizedMentions(normalizedSection, term);
      if (mentionCount === 0) continue;
      const existing = byTerm.get(term);
      const mentions = (existing?.mentions ?? 0) + mentionCount;
      if (!existing || section.weight > existing.weight) {
        byTerm.set(term, {
          term,
          display:
            term.toUpperCase() === 'PRD' ? 'PRD' : (verbatimSpelling(sectionText, term) ?? term),
          weight: section.weight,
          kind: section.kind,
          signal: true,
          mentions,
          order: existing?.order ?? sectionBase + Math.max(0, normalizedSection.indexOf(` ${term} `) - 1),
        });
      } else {
        existing.mentions = mentions;
      }
    }

    // Unigrams. Match on the original casing so isSpecific can see proper nouns.
    for (const tok of tokens) {
      if (isExcluded(tok)) continue;
      if (!isSpecific(tok.text, tok.positional, tok.nextIsCapitalized, casing, tok.afterVerbMarker))
        continue;
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
      const gap = sectionText.slice(a.end, b.start);
      if (!/^ +$/.test(gap)) continue;
      if (isExcluded(a) || isExcluded(b)) continue;
      if (
        !isSpecific(a.text, a.positional, a.nextIsCapitalized, casing, a.afterVerbMarker) ||
        !isSpecific(b.text, b.positional, b.nextIsCapitalized, casing, b.afterVerbMarker)
      ) {
        continue;
      }
      // Two lexicon skills sitting next to each other are two requirements, not a phrase:
      // "GraphQL APIs" and "Docker Kubernetes" must stay separate so each is matched and, when
      // missing, named on its own.
      if (inLexicon(normalizeTerm(a.text)) && inLexicon(normalizeTerm(b.text))) continue;
      const term = `${normalizeTerm(a.text)} ${normalizeTerm(b.text)}`;
      // THE PHRASE PASS ALREADY COUNTED THIS SECTION, so counting it again here is not a second
      // mention, it is the same mention read twice. The two passes overlap on exactly the phrases
      // the posting writes in Title Case: "Machine Learning" is a PHRASE_LEXICON hit AND a pair of
      // independently specific tokens, so it left this loop with mentions = 2 per occurrence.
      //
      // That is not cosmetic, because mentions is the emphasis tiebreak in capToEmphasis and the
      // denominator is capped at EMPHASIS_LIMIT. Measured over the 800 most recently seen active
      // postings, the doubled count evicted real stated skills to make room for the phrase that
      // outranked them on a number that was wrong: `gcp` off 19 postings, `pytorch`, `tensorflow`
      // and `kafka` off 4 each, `python`, `sql` and `azure` off 3. Deduplicating here takes all of
      // those back and keeps the phrase.
      //
      // Safe in one direction only, and this is the direction: the phrase pass runs FIRST and over
      // the SAME section, so if the term is in PHRASE_LEXICON the entry already exists at this
      // section's weight. There is nothing for this loop to add.
      if (PHRASE_LEXICON.has(term)) continue;
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

  // ONE REQUIREMENT SPELLED SINGULAR AND PLURAL IS ONE REQUIREMENT, not two slots.
  //
  // byTerm is keyed on the normalized string, and normalizeTerm does not singularise, so a posting
  // that writes both spellings gets two entries. Everything downstream then treats them as two
  // requirements: two of the twelve EMPHASIS_LIMIT slots, charged twice against the same resume,
  // and named twice on the gap list.
  //
  // `API` AND `APIs` ARE THE CASE THIS WAS FOUND FOR, and the reason they survived is worth
  // stating because it is not the obvious one. inLexicon already tolerates the plural through its
  // bare `-s` strip, so BOTH spellings are correctly admitted as the lexicon skill `api` - they
  // just arrive under different keys. singular() cannot fold them either, because it deliberately
  // leaves `-is` alone so that `analysis` and `basis` survive, and `apis` ends in `-is`. So the
  // one function that would have merged them is the one function that is required not to.
  //
  // THE FOLD KEY IS singular() PLUS THE LEXICON, in that order, and the lexicon half is what makes
  // it safe. Stripping a bare `-s` from anything ending in `-is` would fold `analysis` into
  // `analysi`; stripping it only when the result IS a curated skill uses the lexicon as the
  // evidence that the `-s` was a plural rather than part of the word. This is the same test
  // inLexicon already makes to admit the term, applied to its identity instead of its membership.
  //
  // NOTHING IS INVENTED. The survivor is always one of the two spellings the posting actually
  // wrote, never a third string synthesised from them, so the module header's first rule holds.
  // No `alternatives` are recorded and none are needed: resumeCovers already matches a term
  // against a resume that pluralises it and against one that does not, in both directions, so
  // whichever spelling survives matches exactly what the pair matched between them.
  const bySingular = new Map<string, string>();
  for (const [term, entry] of [...byTerm.entries()]) {
    const key = foldKey(term);
    const seen = bySingular.get(key);
    if (seen === undefined) {
      bySingular.set(key, term);
      continue;
    }
    const other = byTerm.get(seen);
    if (!other) continue;
    // Prefer the spelling that is already the folded form, so `api` represents `api`/`APIs` and a
    // pair with no singular member keeps whichever was seen first. Deterministic either way.
    const [keep, drop] = term === key ? [entry, other] : [other, entry];
    if (drop.weight > keep.weight) {
      keep.weight = drop.weight;
      keep.kind = drop.kind;
    }
    keep.mentions = (keep.mentions ?? 1) + (drop.mentions ?? 1);
    keep.signal = keep.signal || drop.signal;
    keep.order = Math.min(keep.order ?? 0, drop.order ?? 0);
    byTerm.delete(drop.term);
    bySingular.set(key, keep.term);
  }

  return [...byTerm.values()].sort((x, y) => y.weight - x.weight || x.term.localeCompare(y.term));
}

/**
 * The identity of a term once singular and plural spellings are folded together. See the fold pass
 * at the foot of extractFrom for why singular() alone cannot do this.
 */
function foldKey(term: string): string {
  return term
    .split(' ')
    .map((word) => {
      const s = singular(word);
      if (s !== word) return s;
      // `> 2`, NOT the `> 3` inLexicon uses, and the difference is a real defect rather than a
      // tidy-up. That guard was copied from inLexicon, where it is protecting a DIFFERENT test:
      // there the stripped form is looked up speculatively, so a short word must not be chopped on
      // the chance it lands on an entry. Here the strip only survives if the result IS a lexicon
      // entry, which is the evidence, so length is doing no safety work and is only excluding
      // three-letter plurals.
      //
      // `UIs` IS THE ONE IT EXCLUDED, found by driving a real posting through the running API
      // rather than by reading this code. Okta's "Staff Software Engineer" names both spellings and
      // its packet listed `UI` and `UIs` as two separate missing requirements, which is precisely
      // the duplicate this fold exists to remove. `ui` is three characters, so `uis` failed
      // `length > 3` and the two never met.
      //
      // Two is the floor because `word.slice(0, -1)` must leave something to look up: at length 2
      // the candidate is a single character, and the only single-character lexicon entries are `r`
      // and `c`, which isSpecific admits solely as standalone capitals and never as a plural.
      if (word.length > 2 && word.endsWith('s') && SKILL_LEXICON.has(word.slice(0, -1))) {
        return word.slice(0, -1);
      }
      return word;
    })
    .join(' ');
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

const SAME_CAPABILITY_TERMS = new Map<string, string[]>([
  ['javascript', ['typescript']],
  ['frontend', ['react', 'vue', 'angular', 'svelte']],
  ['backend', ['nodejs', 'express', 'django', 'flask', 'fastapi', 'rails', 'spring']],
  ['api', ['rest', 'graphql']],
  ['apis', ['rest', 'graphql']],
]);

/**
 * Does the resume satisfy this requirement, including where one product has two spellings?
 *
 * A term with `alternatives` stands for one requirement written several ways, so ANY member
 * satisfies it.
 *
 * This is intentionally wider than a raw resumeCovers(term.term) call. Vendor spellings,
 * lexicon-backed plurals, and the small SAME_CAPABILITY_TERMS table all name the same capability
 * rather than a broader field: TypeScript for JavaScript, React for frontend, REST for APIs. That
 * keeps the score from charging a student for wording differences while still refusing loose
 * hypernyms such as "machine learning" satisfying "PyTorch".
 */
/* IT RETURNS THE STRING THAT COVERED IT, not just a yes, because the review screen has to be able
 * to POINT at it. Blue means "asked for by this job, and on your resume", and when the credit comes
 * from an alternative the resume never writes the requirement's own words: a posting asking for
 * `frontend` is satisfied by a resume that says React, and the resume pane had nothing to mark.
 * Measured over the 85 production packets on 2026-08-09 that was 8 blue marks with no anchor, on 8
 * packets, and after the other anchoring fixes it was the ONLY remaining case. Naming the covering
 * string lets the pane mark React and keep the hover link pointing at the requirement `frontend`,
 * which is the question the student came to the screen with. */
function resumeSatisfies(resumeText: string, term: JdTerm): string | undefined {
  if (term.alternatives) return term.alternatives.find((t) => resumeCovers(resumeText, t));
  if (resumeCovers(resumeText, term.term)) return term.term;
  return (SAME_CAPABILITY_TERMS.get(normalizeTerm(term.term)) ?? []).find((t) => resumeCovers(resumeText, t));
}

export function resumeCovers(resumeText: string, term: string): boolean {
  const hay = resumeHaystack(resumeText);
  const needle = normalizeTerm(term);
  if (hay.includes(` ${needle} `)) return true;
  const foldedNeedle = foldKey(needle);
  if (foldedNeedle !== needle && hay.includes(` ${foldedNeedle} `)) return true;
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
    const covered = resumeSatisfies(resumeText, t);
    if (covered !== undefined) {
      got += t.weight;
      if (t.kind === 'required') requiredGot += 1;
      matched.push(covered === t.term ? t : { ...t, satisfied_by: covered });
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
