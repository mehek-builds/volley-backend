import type { ResumeSpec } from '../llm/resumeSpec';
import { RESUME_CONTENT_LIMITS } from './resumeContentPolicy';
import type { ExperienceBankEntry } from '../db/schema';
import { wordSet, numberSignatures, ungroundedNumbers } from './grounding';
import { deriveCandidateContext, resumeSafeTargetRole, type CandidateEducation } from './resumePolicy';

// Deterministic QA gate for a generated resume, ported from the Dubai off-cycle resume
// engine's validate_resume.py + pressure_test.py (~/Documents/Internship Apps/_resume-engine/) -
// the same quality bar Mehek applies to her own resume builds, now applied to every student's
// Litos-generated resume too. Content checks operate on the spec (pre-render); layout checks
// (page count, extractable text) operate on the rendered PDF text.

// Same whitelist as the Dubai engine's STRONG_VERBS, exported so resumeSpec.ts's system prompt
// stays in sync with what the validator actually enforces (single source of truth).
/* The whitelist is a QUALITY gate, not a dictionary: a bullet opening with a verb that is not here
 * is reported so it can be rewritten. Two things follow from that, and both were wrong until a
 * five-resume run on 2026-07-27 exposed them.
 *
 * 1. IT WAS BIASED TOWARD ENGINEERING. The original list came from a software resume engine, so a
 *    marine-biology student writing "Taught two class sections" or a camp counsellor writing
 *    "Mediated disputes among campers" was told their bullet was not action-verb-first. Five of
 *    six such flags in that run came from the two non-engineering resumes. Litos serves every
 *    student, so the list has to cover teaching, research, care, service and operations work.
 *
 * 2. WEAK VERBS MUST STAY OUT. The same run flagged "Assisted with collection of fish samples" and
 *    "Answered visitor questions", and those flags are CORRECT - both bullets are genuinely weak
 *    and should be rewritten. The fix was to add the strong verbs that were missing, not to
 *    silence the gate by admitting every verb it rejected. assisted, answered, helped, supported,
 *    participated and worked are deliberately absent.
 *
 * 3. IT REJECTED SYNONYMS OF VERBS IT ALREADY ADMITTED. A 15-resume run on 2026-07-27 flagged
 *    "Performed column chromatography, PCR, DNA extraction" while conducted, executed, ran and
 *    administered - the same verb wearing different clothes - were all on the list. That is not a
 *    quality gate, it is a coin toss, and it is an expensive one: a single flagged bullet triggers
 *    a complete regeneration of the resume, so the student waits through a second model call and
 *    the retry then fails again on the same word.
 *
 *    So the additions below are strictly SYNONYMS OF ADMITTED VERBS, each one named against the
 *    verb it matches. Nothing is admitted because it appeared in a resume; only because rejecting
 *    it while accepting its twin was incoherent.
 *
 * 4. THE SAME COIN TOSS, FOUND AGAIN BY GENERATING TEN REAL RESUMES ON 2026-08-20, and this time
 *    the cost was measurable rather than theoretical. A rejected opener does not just get flagged:
 *    the model rewrites the bullet to satisfy the gate, so the gate SILENTLY EDITS the student's
 *    prose toward whatever it happens to admit. Observed:
 *
 *      "Backtested a mean-reversion signal..."  ->  "Tested a mean-reversion signal..."
 *      "Rewrote a Go payment reconciliation..." ->  "Rebuilt a Go payment reconciliation..."
 *      "Resequenced a pick path with OR-Tools"  ->  "Optimized a pick path with OR-Tools"
 *
 *    The first is on a QUANTITATIVE TRADING application, where "backtested" is the precise term a
 *    screener looks for and "tested" is not. The gate made the resume worse for the exact posting
 *    it was tailored to, because `tested` was admitted and `backtested` was not.
 *
 *    Added under the same discipline as the additions above, each named against its admitted twin:
 *      rewrote        <- rebuilt, refactored, redesigned (all admitted)
 *      backtested     <- tested, benchmarked, validated  (all admitted)
 *      resequenced    <- structured, consolidated        (admitted)
 *      reordered      <- structured, streamlined         (admitted)
 *      restructured   <- structured, overhauled          (admitted)
 *
 *    Weak verbs stay out, and none of these is weak: every one is a specific form of a verb the
 *    list already calls strong.
 *
 * 5. IT WAS REWRITING VERBS THE POSTING NEVER ASKED FOR, measured on ten generations 2026-08-20.
 *    Of seven openers the gate replaced, only two of the replacements appeared anywhere in the job
 *    description, and one of those was a spelling change. The worst case ran the other way: a
 *    student wrote "Mapped a 14-step assembly process", the posting itself says "map", and the gate
 *    replaced it with "Documented", which the posting does not say. The prompt is explicit that
 *    "action verbs are writing guidance, not candidate evidence", so these rewrites buy no keyword
 *    alignment at all - they only cost the applicant their own words.
 *
 *    NOT `found`, deliberately. A code review already ruled on it - "founded" is on the list
 *    because founding a company is a real act, and "Found and fixed 12 defects" is not that, so
 *    `found` must not ride in on the derivation. That judgment stands: identified, uncovered and
 *    diagnosed are the strong forms of the same idea, and rewriting "Found" to "Identified" is an
 *    upgrade rather than an arbitrary swap. It is the one of the seven that was worth making.
 *
 *    Added against their admitted twins, same discipline as every addition above:
 *      mapped     <- catalogued, surveyed, structured
 *      cleaned    <- refined, standardized
 *      annotated  <- catalogued, classified, documented
 *      defined    <- established, formalized, specified
 *      prioritized <- structured, sequenced, ranked the same work
 *
 *    The Commonwealth-spelling half of that finding is handled in pastTenseCandidates rather than
 *    here, because it is a rule about spelling and not a set of new verbs.
 *
 *    First batch, against the verb each one twins: performed/conducted, operated/ran,
 *    assessed/evaluated, simulated/modeled, prototyped/built, fabricated and machined against
 *    constructed and assembled, programmed and coded against developed, debugged/diagnosed,
 *    refactored/rebuilt, migrated/transformed, tested/validated.
 *
 *    Second batch, added after "Recorded field data using tablets" was flagged in the same run
 *    while documented, tracked and catalogued were all admitted. Rather than wait for each
 *    remaining resume to surface one more, the whole recording-and-reporting family was closed:
 *    recorded and logged against documented and tracked, compiled against catalogued, wrote
 *    against authored and drafted, installed against deployed, reviewed against audited, tuned
 *    against calibrated, estimated against forecasted, computed against quantified, soldered and
 *    welded against assembled, iterated against refined.
 *
 *    The line that decides an addition is whether an already-admitted verb means the same thing.
 *    "maintained" and "selected" were considered under this rule and left out: nothing on the list
 *    means what they mean, and both describe custody rather than an act.
 *
 * 6. ONE MORE SYNONYM, found on Mehek's own resume 2026-09-01 when the send gate refused an Exa
 *    packet at /start step 6: "Aggregated 350+ survey responses and POS analytics into a roadmap".
 *    compiled, consolidated, collected and synthesized are all admitted, and aggregating survey
 *    responses into a roadmap is precisely what those four words describe, so rejecting this one
 *    was the same coin toss finding 3 named. Added against those twins:
 *      aggregated <- compiled, consolidated, collected, synthesized
 *
 *    The other two bullets refused in that same run were NOT a vocabulary gap - "Driving" and
 *    "Facilitating" are the participles of verbs already on this list - and they are fixed by tense
 *    derivation instead. See participleStems below.
 */
export const STRONG_VERBS = new Set(
  `built shipped designed engineered developed led drove owned launched analyzed
delivered diagnosed ran secured founded co-founded managed presented translated instrumented deployed
architected automated optimized scaled quantified benchmarked researched synthesized negotiated
coordinated spearheaded established pioneered cut reduced improved increased grew won earned created added
implemented conducted partnered collaborated evaluated modeled sized identified uncovered cracked
recruited mentored trained structured forecasted tracked documented demoed integrated resolved isolated
refined applied profiled solved interviewed communicated prepared produced drafted executed
devised formulated advised championed briefed
taught tutored instructed facilitated supervised directed mediated counseled advocated
formalized standardized transformed streamlined overhauled redesigned rebuilt consolidated
surveyed sampled measured catalogued classified validated verified audited inspected
authored published edited curated illustrated exhibited
staffed scheduled onboarded fundraised campaigned organized administered processed
treated triaged screened rehabilitated cultivated consulted elected guided collected
constructed assembled purified sequenced cultured calibrated administered dissected determined reported
performed operated assessed simulated tested prototyped fabricated machined programmed coded
debugged refactored migrated
recorded logged compiled wrote installed reviewed tuned estimated computed soldered welded iterated
characterized
rewrote backtested resequenced reordered restructured
mapped cleaned annotated defined prioritized
aggregated`
    .split(/\s+/)
    .filter(Boolean),
);

/* THE HARD RULE: every bullet in this product opens with a strong action verb.
 *
 * One implementation, used by every path that writes, checks or edits a bullet - the two
 * generation prompts, the validator, the base build's retry, and the /start editor. It used to be
 * re-derived inline in the validator, which is how the base build ended up shipping bullets the
 * validator itself would reject: the check existed, but nothing acted on it there.
 *
 * Exported as a function rather than a bare Set so the "co-" rule and the punctuation stripping
 * cannot drift between callers.
 */
/* A short quotation of a bullet, for a message the STUDENT reads.
 *
 * These issue strings are rendered verbatim on /start's base-resume screen, so a hard 40-character
 * cut showed a chopped word: `"Maintained a caseload of 12-21 individua"` (measured 2026-07-27 on a
 * real federal resume). Breaking on the last space instead costs nothing and stops the note looking
 * like the resume itself is corrupted.
 */
export function excerpt(bullet: string, max = 40): string {
  const text = bullet.trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  // A single word longer than the budget has no boundary to find; cut it rather than print it whole.
  return `${lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut}…`;
}

export function firstWordOf(bullet: string): string {
  const token = bullet.trim().split(/\s+/)[0] ?? '';
  /* Preserve the token instead of deleting arbitrary characters from it. Deletion made malformed
   * openers such as "Ad,ded" and "Added123" collapse into the approved verb "added". Quotes,
   * brackets and sentence punctuation are valid at token boundaries; an internal hyphen remains
   * part of the token so the explicit co-author rule can handle it without admitting added-value. */
  const match = token.match(/^[('"“‘{\[]*([a-zA-Z]+(?:-[a-zA-Z]+)?)[,.;:!?\)'"”’}\]]*$/);
  return (match?.[1] ?? '').toLowerCase();
}

/* The whitelist is written in the past tense, because most resume bullets are. A CV written in the
 * PRESENT tense is not breaking the rule, it is describing a current role, and plenty of real ones
 * do. Measured 2026-07-27 on a WVU biochemistry CV: "Synthesize organic ligands", "Characterize
 * products with 1H NMR" and "Measure interactions of synthesized compounds" were all flagged, and
 * `synthesized` and `measured` were sitting on the list the whole time.
 *
 * Storing both tenses would be two lists to keep in step, and the second one would drift. Deriving
 * the past tense from the present is a handful of English spelling rules, and any word whose derived
 * form is not on the list is rejected exactly as before - so this widens the gate by tense only,
 * never by vocabulary. */
/* English will not be derived. These are the irregulars among verbs the whitelist ALREADY admits,
 * mapped from the present tense a CV writes to the past tense the list stores. Nothing here widens
 * the vocabulary: every value on the right is on the list above. */
const IRREGULAR_PAST: Record<string, string> = {
  build: 'built', rebuild: 'rebuilt', lead: 'led', drive: 'drove', run: 'ran', win: 'won',
  grow: 'grew', cut: 'cut', teach: 'taught', write: 'wrote', overhaul: 'overhauled',
};

/* Present-tense forms whose DERIVED past tense collides with an admitted verb, but which are weak
 * openers in their own right. Exactly one turned up when every common weak verb was run through the
 * derivation: "found" (the past tense of *find*) derives to "founded", which is on the list because
 * founding a company is a real act. "Found and fixed 12 defects" is not that, and without this it
 * would have sailed through the hard rule.
 *
 * Checked BEFORE derivation, so the collision can never be reached. Deliberately tiny: it exists to
 * stop derivation admitting what the vocabulary rules already reject, not to become a second
 * denylist with its own opinions. */
const DERIVATION_BLOCKED = new Set(['found']);

/* The past-tense forms of ONE present-tense stem. Split out of pastTenseCandidates so the present
 * participle below can reuse the identical spelling rules: "facilitating" has to reach `facilitated`
 * by exactly the route "facilitate" does, or the two tenses drift and the gate answers differently
 * depending on which one a student happened to write. */
function regularPastForms(word: string): string[] {
  const irregular = IRREGULAR_PAST[word];
  const out = irregular ? [word, irregular] : [word];
  if (word.endsWith('e')) out.push(`${word}d`); // measure -> measured, synthesize -> synthesized
  else if (/[^aeiou]y$/.test(word)) out.push(`${word.slice(0, -1)}ied`); // identify -> identified
  else out.push(`${word}ed`); // present -> presented
  /* A doubled final consonant: "ship" -> "shipped", "plan" -> "planned". The stem must END in
   * consonant-vowel-consonant, which is where the English rule actually applies.
   *
   * The bound is on the PREFIX, not the whole word. An earlier `{2,5}` sat in front of those three
   * characters and so demanded five letters minimum, which excluded every word the rule is for -
   * ship, plan, stop and map are four - leaving the branch dead while its own comment named "plan"
   * as the example. Verified: "Ship weekly releases" was rejected while `shipped` sat on the list. */
  if (/^[a-z]{0,4}[^aeiou][aeiou][^aeiouwxy]$/.test(word)) out.push(`${word}${word.slice(-1)}ed`);
  return out;
}

/* THE PRESENT PARTICIPLE, which is the tense a CURRENT role is written in.
 *
 * The comment on pastTenseCandidates already settled that a CV written in the present tense is not
 * breaking the hard rule, it is describing a job the student still holds - and then only handled the
 * present SIMPLE. The participle, which is the far more common way a resume writes a current role,
 * was never derived at all. Measured 2026-09-01 on Mehek's own resume at /start step 6, on an Exa
 * Software Engineer Intern packet, where the send gate refused three bullets at once:
 *
 *     "Driving full SDLC for iMessage add-on..."          <- `drive` -> `drove` is on the list
 *     "Facilitating cross-functional collaboration..."    <- `facilitated` is ON the list, verbatim
 *
 * Both openers are the participle of a verb the gate already calls strong, on the one entry dated
 * "September 2025 - Present". So was every other admitted verb in that tense: building, leading,
 * managing, designing and owning were all rejected while built, led, managed, designed and owned sat
 * on the list. The cost is the one this file keeps re-learning: a rejected opener is not merely
 * flagged, the model rewrites the bullet to satisfy the gate, so the gate was quietly re-tensing
 * every current role a student wrote - and when a build shipped anyway, the send gate refused the
 * finished packet with a note telling her to rewrite her own correct English.
 *
 * WIDENS BY TENSE ONLY, NEVER BY VOCABULARY, the same discipline as the derivation above: a stem is
 * only ever an extra candidate, and every candidate still has to land on STRONG_VERBS. Verified
 * against the weak verbs this file deliberately keeps out - assisting, answering, helping,
 * supporting, participating, attending, working, engaging, maintaining and selecting all still fail,
 * because assisted, answered, helped, supported, participated, attended, worked, engaged, maintained
 * and selected are all still absent from the list.
 *
 * DERIVATION_BLOCKED is deliberately NOT consulted here, and that is the one place the two tenses
 * legitimately differ. It exists to stop the bullet "Found and fixed 12 defects" riding in on
 * `founded`, because *found* is ambiguous: past of "find", present of "found a company". The
 * participle is not ambiguous. "Finding" derives to `finded`, which is on no list; only "Founding"
 * reaches `founded`, and founding a company is the real act the list admits it for.
 */
function participleStems(word: string): string[] {
  // Three characters of stem minimum: the shortest admitted verbs are three letters (add, cut, run,
  // win), so "adding" and "cutting" are the floor and nothing shorter can reach the list anyway.
  if (!word.endsWith('ing') || word.length < 6) return [];
  const stem = word.slice(0, -3);
  // building -> build, and facilitating -> facilitate: English drops the silent "e" before "-ing",
  // so both the bare stem and the stem with its "e" put back are candidates.
  const stems = [stem, `${stem}e`];
  // The mirror of the doubled-consonant rule above: shipping -> ship, running -> run, cutting -> cut.
  if (/([^aeiou])\1$/.test(stem)) stems.push(stem.slice(0, -1));
  return stems;
}

function pastTenseCandidates(word: string): string[] {
  if (DERIVATION_BLOCKED.has(word)) return [word];
  const out = regularPastForms(word);
  for (const stem of participleStems(word)) out.push(...regularPastForms(stem));

  /* COMMONWEALTH SPELLINGS OF THE SAME VERB, because this list is written in American English and
   * a student who writes British English is not writing a weak bullet.
   *
   * Measured 2026-08-20: `modeled` was admitted and `modelled` rejected; so were `analysed`,
   * `organised`, `standardised`, `formalised`, `optimised` and `synthesised`, every one of them a
   * spelling of a verb already on the list. A rejected opener is not merely flagged - the bullet is
   * regenerated until it passes - so the gate was rewriting the prose of every applicant outside
   * the US, which is most of the market Litos sells into.
   *
   * BRITISH SPELLING IS ALLOWED, FULL STOP, and it is not conditional on where the student is
   * applying. Mehek's call 2026-08-20. A student applying in London, Dublin, Sydney, Singapore or
   * Toronto is spelling it correctly for the employer reading it, and one applying to a US firm
   * from a British-schooled background is spelling their own history the way they always have.
   * Neither is a bullet that needs rewriting, so this gate accepts both spellings everywhere rather
   * than trying to guess a market from a posting's location. The generators are told the same thing
   * in words: see "KEEP THE APPLICANT'S OWN SPELLING" in llm/resumeSpec.ts and llm/baseResume.ts,
   * which stops the model normalising on its own even though this gate would accept the result.
   *
   * Generated rather than enumerated: a list of pairs drifts the moment a verb is added, and these
   * are only ever EXTRA candidates. `some()` decides the answer, so a variant that is not a word
   * simply never matches and nothing is admitted that was not already on the list. */
  /* Over every candidate rather than only the opening word, because the participle derivation now
   * produces candidates of its own and a Commonwealth participle has to reach the same twin its
   * past tense does: "modelling" -> stem "model" -> `modelled` -> `modeled`, and "analysing" ->
   * "analyse" -> `analysed` -> `analyzed`. Spelling the loop over `word` alone left those two on
   * the wrong side of a fix this file had already made for `modelled` and `analysed`. */
  for (const candidate of [...out]) {
    for (const variant of [
      candidate.replace(/ised$/, 'ized'),
      candidate.replace(/isation$/, 'ization'),
      candidate.replace(/ysed$/, 'yzed'),
      candidate.replace(/lled$/, 'led'),
      candidate.replace(/logued$/, 'loged'),
      candidate.replace(/lling$/, 'ling'),
    ]) {
      if (variant !== candidate) out.push(variant);
    }
  }
  return out;
}

/* Does this bullet OPEN with one of these verbs, in any tense or spelling this file admits?
 *
 * One implementation for both verb sets, because they were answering differently about the same
 * word. The hard gate ran the opener through the tense derivation; the ownership check below
 * compared the raw first word against a past-tense-only list, so once participles cleared the hard
 * gate, "Leading a design review each sprint" passed as a strong opener and was then warned for
 * having no ownership signal while "Led a design review each sprint" was not. Same verb, same
 * bullet, two verdicts, decided by a tense the applicant chose because the role is current.
 */
function opensWithVerbFrom(bullet: string, verbs: ReadonlySet<string>): boolean {
  const first = firstWordOf(bullet);
  if (!first) return false;
  // "co-" inherits the base verb's strength: co-authoring a paper is as real as authoring one.
  const base = first.startsWith('co-') ? first.slice(3) : first;
  if (!base) return false;
  return pastTenseCandidates(base).some((form) => verbs.has(form));
}

export function startsWithStrongVerb(bullet: string): boolean {
  return opensWithVerbFrom(bullet, STRONG_VERBS);
}

/** Bullets in a spec that break the rule, as "Org: verb" strings for prompt feedback. */
export function weakVerbBullets(spec: ResumeSpec): Array<{ org: string; bullet: string; verb: string }> {
  const out: Array<{ org: string; bullet: string; verb: string }> = [];
  for (const entry of spec.experience ?? []) {
    for (const bullet of entry.bullets ?? []) {
      if (!startsWithStrongVerb(bullet)) {
        out.push({ org: entry.org, bullet, verb: bullet.trim().split(/\s+/)[0] ?? '' });
      }
    }
  }
  return out;
}

const INITIATIVE_VERBS = new Set(
  `founded co-founded owned drove spearheaded launched built pioneered led initiated established
won secured shipped architected designed engineered scaled automated negotiated cracked recruited
refined structured`
    .split(/\s+/)
    .filter(Boolean),
);

export const BULLET_MAX_CHARS = 235; // beyond this, a ~2-line bullet wraps to a 3rd line
export const BULLET_MIN_WORDS = 8;
export const BULLET_MAX_WORDS = 30;

/**
 * Bullets that will fail the length gate, with how far over they are, for prompt feedback.
 *
 * Same walk as weakVerbBullets and the same walk validateResumeSpec does, so the repair loop and
 * the gate can never disagree about which bullets are too long. Length was the one hard rule the
 * generation prompt asked for politely and nothing ever corrected: an over-long bullet survived
 * every retry untouched and then failed the ATS gate, which fails closed, so nothing was saved and
 * the student's only move was to re-roll the model. Measured 2026-08-04 on a real build: 239 chars
 * against a 235 cap, four characters from being savable.
 */
export function overlongBullets(spec: ResumeSpec): Array<{ org: string; bullet: string; length: number }> {
  const out: Array<{ org: string; bullet: string; length: number }> = [];
  for (const entry of spec.experience ?? []) {
    for (const bullet of entry.bullets ?? []) {
      if (typeof bullet === 'string' && bullet.length > BULLET_MAX_CHARS) {
        out.push({ org: entry.org, bullet, length: bullet.length });
      }
    }
  }
  return out;
}

/**
 * Bullets outside the 8-30 word band, with their count, for prompt feedback.
 *
 * Same walk as the two above and the same split validateResumeSpec uses, so the repair loop and
 * the gate can never disagree about which bullets break the band. The word band was the one hard
 * bullet rule with NO repair path at all: measured 2026-08-29 on a live onboarding trial, a
 * 7-word bullet sailed through every pass untouched and killed the build at the fail-closed ATS
 * gate ("bullet has 7 words (min 8)"), leaving the student with nothing saved and a Try again
 * button, which is the exact stranding the repair loop exists to prevent.
 */
export function misWordedBullets(spec: ResumeSpec): Array<{ org: string; bullet: string; words: number }> {
  const out: Array<{ org: string; bullet: string; words: number }> = [];
  for (const entry of spec.experience ?? []) {
    for (const bullet of entry.bullets ?? []) {
      if (typeof bullet !== 'string') continue;
      const words = bullet.trim().split(/\s+/).filter(Boolean).length;
      if (words < BULLET_MIN_WORDS || words > BULLET_MAX_WORDS) {
        out.push({ org: entry.org, bullet, words });
      }
    }
  }
  return out;
}
const MIN_KEYWORD_COVERAGE = 18; // % of JD terms that must appear (ATS safety floor)
const METRIC_RE = /(\$|%|\d|\b0\.\d+\b|\b\d+x\b)/i;

const STOPWORDS = new Set(
  `the and for with you your our are will from that this have role team work within across into
their they our who whom able strong good using use used per via etc a an of to in on at by as is be we`
    .split(/\s+/)
    .filter(Boolean),
);

function jdKeywords(jdText: string): Set<string> {
  const words = (jdText.toLowerCase().match(/[a-z][a-z+/&-]{2,}/g) ?? []) as string[];
  return new Set(words.filter((w) => !STOPWORDS.has(w) && w.length > 3));
}

function contentWords(text: string): Set<string> {
  const words = (text.toLowerCase().match(/[a-z]{4,}/g) ?? []) as string[];
  return new Set(words.filter((w) => !STOPWORDS.has(w)));
}

export interface BulletFlag {
  entry: string;
  bullet: string;
  flags: string[];
}

export interface ValidationResult {
  issues: string[]; // hard problems - drive the retry loop
  warnings: BulletFlag[]; // pressure-test-style soft flags - surfaced, don't block
  ats_keyword_coverage_pct: number;
}

/** Style defects that normally drive a model rewrite but must not block grounded outage output. */
export function isProviderDependentResumeStyleIssue(issue: string): boolean {
  return issue.startsWith('bullet not action-verb-first')
    || issue.startsWith('bullet has ')
    || issue.startsWith(`bullet exceeds ${BULLET_MAX_CHARS} chars`)
    || /entry \d+, bullet \d+ renders as \d+ lines/.test(issue);
}

// ---- Grounding: every org/title/number in the output must trace back to the experience bank ----
// This is the deterministic backstop for the product's #1 promise ("never invents a job, a skill,
// or a number"). The generator prompt already forbids fabrication; this catches drift the prompt
// misses, by checking generated facts against the student's actual source data, not just its form.

export interface GroundingViolation {
  entry: string; // the generated entry's org (for context)
  kind: 'org' | 'title' | 'metric' | 'date' | 'claim';
  detail: string; // the offending token (org name, title, number, or year)
  bullet?: string; // present for metric violations
}

// The 4-digit years in a date string, e.g. "Jun 2023 - Aug 2024" -> ["2023","2024"].
function yearsIn(dateRange: string | null | undefined): string[] {
  return dateRange ? (dateRange.match(/\b(?:19|20)\d{2}\b/g) ?? []) : [];
}

// Years present in the generated date range that don't appear in the source entry's date range.
// Only enforced when the source HAS a date range - if the bank entry has no dates we can't verify,
// so we don't fabricate-flag (best-effort, consistent with the rest of grounding).
function ungroundedYears(genRange: string, srcRange: string | null | undefined): string[] {
  const srcYears = new Set(yearsIn(srcRange));
  if (srcYears.size === 0) return [];
  return yearsIn(genRange).filter((y) => !srcYears.has(y));
}

// Connector words dropped when forming an org's initialism ("Massachusetts Institute of
// Technology" -> "mit", not "miot").
const ORG_CONNECTORS = new Set(['of', 'the', 'and', 'for', 'at', 'a', 'an', 'de', 'to']);

function normalizeOrg(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()'"[\]–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// First letters of the significant words, e.g. "Massachusetts Institute of Technology" -> "mit",
// "University of California Los Angeles" -> "ucla", "National Aeronautics and Space
// Administration" -> "nasa".
function orgInitialism(s: string): string {
  return normalizeOrg(s)
    .split(' ')
    .filter((w) => w && !ORG_CONNECTORS.has(w))
    .map((w) => w[0])
    .join('');
}

// If `s` is a single-token acronym (2-6 letters like "MIT"/"USC"/"UCLA"/"IBM"), return it
// lowercased; otherwise null.
function acronymTokenOf(s: string): string | null {
  const tokens = normalizeOrg(s).split(' ').filter(Boolean);
  if (tokens.length === 1 && /^[a-z]{2,6}$/.test(tokens[0])) return tokens[0];
  return null;
}

// Match score between a generated org and a bank org: >0 means they're the same organization.
// H2 fix: an acronym vs its multi-word expansion shares ZERO tokens (bank "Massachusetts Institute
// of Technology" vs generated "MIT"), so token containment alone wrongly treats a real entry as
// invented and prunes it. We additionally match a single-token acronym on either side against the
// other side's initialism (also covers USC, IBM, UCLA, NASA, ...).
// Containment GATES the match; Jaccard RANKS it. The two jobs need different measures, and using
// containment for both is what caused R-022.
//
// Containment (inter / min(|gen|,|src|)) is the right gate: it tolerates a bank entry named more or
// less specifically than the spec's ("Lava Lab" vs "USC Lava Lab"). But it SATURATES at 1.0 the
// moment either side is a single shared token, so it cannot rank. With a bank holding both
// "Traeco" and "Traeco - AI Agent Cost Infrastructure", the spec's
// "Traeco - AI Agent Cost Infrastructure" scored 1/min(5,1) = 1.0 against the one-word "Traeco" and
// 5/min(5,5) = 1.0 against its real entry: a dead tie, resolved by whichever row the DB happened to
// return first. Wrong side of that coin and the pruner reset her real title "AI Engineer" to
// "Founder" and deleted a true bullet.
//
// Jaccard (inter / union) does not saturate: the one-word "Traeco" scores 1/5 = 0.2 while the full
// entry scores 5/5 = 1.0, so the specific entry wins on merit rather than on row order.
//
// The two kinds of evidence are TIERS, not one scale. A shared literal token is stronger evidence
// than an initialism inference, so every word match must outrank every acronym match: word matches
// occupy (1, 2] as 1 + Jaccard, acronyms sit at exactly 1. Ranking them on one scale is a bug that
// a first cut of this fix actually shipped - Jaccard put a literal match at 1/3 while the acronym
// branch still returned a flat 1, so a bank holding "MIT Media Lab" AND "Massachusetts Institute of
// Technology" resolved a spec's "MIT" to the university and then rewrote its title, which is the
// exact R-022 damage this function exists to prevent.
const ACRONYM_MATCH_SCORE = 1; // strictly below any word match, which is 1 + a positive Jaccard

function orgMatchScore(genOrg: string, bankOrg: string): number {
  const gen = wordSet(genOrg);
  const src = wordSet(bankOrg);
  if (gen.size > 0 && src.size > 0) {
    let inter = 0;
    for (const t of gen) if (src.has(t)) inter++;
    if (inter > 0) {
      const containment = inter / Math.min(gen.size, src.size);
      if (containment >= 0.5) return 1 + inter / (gen.size + src.size - inter);
    }
  }
  const genAcr = acronymTokenOf(genOrg);
  if (genAcr && genAcr === orgInitialism(bankOrg)) return ACRONYM_MATCH_SCORE;
  const srcAcr = acronymTokenOf(bankOrg);
  if (srcAcr && srcAcr === orgInitialism(genOrg)) return ACRONYM_MATCH_SCORE;
  return 0;
}

// The bank entry whose org best matches the generated org, or undefined if the generated org
// appears in no bank entry (i.e. it was invented). Matching is token-containment-gated,
// Jaccard-ranked, OR acronym/initialism-aware (see orgMatchScore).
//
// Ties are broken deterministically rather than by array order (R-022): the caller reads the bank
// straight out of Postgres, which promises no ordering without an ORDER BY, so "first one wins"
// meant the resume's contents could change between two identical requests. Prefer the more specific
// org (more tokens), then fall back to the org name itself so the choice is total and stable.
/* Match a GENERATED entry to the bank row it came from.
 *
 * Org name alone is not enough, and that gap produced a real defect. Two roles at one organisation
 * is an ordinary resume shape - a promotion, or two lab positions at the same university - and
 * both generated entries used to resolve to whichever single bank row won the org tie-break. The
 * second entry's bullets then failed grounding against the FIRST role's source, so they were all
 * dropped as "unsupported" and the entry rendered as a heading with nothing under it, carrying the
 * other role's dates. Measured 2026-07-27 on a real two-page resume with two Department of Biology
 * roles: three bullets stripped, one entry left with zero.
 *
 * So org score decides candidacy, then title and dates decide WHICH role, and `taken` stops two
 * generated entries binding to the same row while an unused alternative exists.
 */
function matchBankEntry(
  orgName: string,
  bank: ExperienceBankEntry[],
  opts: { title?: string | null; dateRange?: string | null; taken?: Set<string> } = {},
): ExperienceBankEntry | undefined {
  if (wordSet(orgName).size === 0 && !acronymTokenOf(orgName)) return undefined;

  const candidates = bank
    .map((e) => ({ e, score: orgMatchScore(orgName, e.org) }))
    .filter(({ score }) => score > 0);
  if (candidates.length === 0) return undefined;

  const norm = (v: string | null | undefined) => (v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const wantTitle = norm(opts.title);
  const wantYears = new Set(yearsIn(opts.dateRange));

  const rank = ({ e, score }: { e: ExperienceBankEntry; score: number }) => {
    let r = score;
    // Title is the strongest disambiguator between two roles at one organisation.
    const srcTitle = norm(e.title);
    if (wantTitle && srcTitle) {
      if (wantTitle === srcTitle) r += 3;
      else {
        const a = new Set(wantTitle.split(' ').filter(Boolean));
        const overlap = srcTitle.split(' ').filter((w) => w && a.has(w)).length;
        if (overlap > 0) r += Math.min(2, overlap * 0.5);
      }
    }
    // Then dates: a shared year is strong evidence it is the same stint.
    if (wantYears.size > 0) {
      const shared = yearsIn(e.date_range).filter((y) => wantYears.has(y)).length;
      if (shared > 0) r += Math.min(2, shared);
    }
    // Finally, prefer a row nothing else has claimed, so two entries cannot collapse onto one.
    if (opts.taken && !opts.taken.has(e.id)) r += 0.25;
    return r;
  };

  let best: { e: ExperienceBankEntry; score: number; rank: number } | undefined;
  for (const c of candidates) {
    const r = rank(c);
    if (!best || r > best.rank || (r === best.rank && breaksTie(c.e.org, best.e.org))) {
      best = { ...c, rank: r };
    }
  }
  return best?.e;
}

// Deterministic, order-independent tie-break: more specific org first, then lexicographic.
function breaksTie(candidateOrg: string, incumbentOrg: string): boolean {
  const c = wordSet(candidateOrg).size;
  const i = wordSet(incumbentOrg).size;
  if (c !== i) return c > i;
  return candidateOrg < incumbentOrg;
}

function bankEntryCorpus(e: ExperienceBankEntry): string {
  const variants = Array.isArray(e.bullet_variants) ? (e.bullet_variants as string[]) : [];
  const tags = Array.isArray(e.tags) ? (e.tags as string[]) : [];
  return [e.org, e.title ?? '', e.date_range ?? '', ...variants, ...tags].join(' ');
}

function bulletClaimIsGrounded(bullet: string, entry: ExperienceBankEntry): boolean {
  const generated = contentWords(bullet);
  if (generated.size === 0) return false;
  const variants = Array.isArray(entry.bullet_variants)
    ? (entry.bullet_variants as unknown[]).filter((value): value is string => typeof value === 'string')
    : [];
  return variants.some((variant) => {
    const source = contentWords(variant);
    if (source.size === 0) return false;
    let shared = 0;
    for (const word of generated) if (source.has(word)) shared += 1;
    return shared / Math.min(generated.size, source.size) >= 0.3;
  });
}

function titleIsSwapped(genTitle: string, srcTitle: string | null): boolean {
  if (!genTitle || !srcTitle) return false;
  const gt = wordSet(genTitle);
  const st = wordSet(srcTitle);
  if (gt.size === 0 || st.size === 0) return false;
  for (const t of gt) if (st.has(t)) return false; // any shared word = a legit light rewrite
  return true; // zero overlap = the title was swapped for a different one
}

// Every grounding violation in a spec against the student's bank. Org that isn't in the bank ->
// 'org'; a title with zero word-overlap with its source title -> 'title'; a bullet number whose
// value doesn't appear in that entry's source text -> 'metric'.
export function findGroundingViolations(spec: ResumeSpec, bank: ExperienceBankEntry[]): GroundingViolation[] {
  const violations: GroundingViolation[] = [];
  // Shared across the loop so two entries at one organisation resolve to different bank rows.
  const taken = new Set<string>();
  for (const entry of spec.experience) {
    const src = matchBankEntry(entry.org, bank, {
      title: entry.title,
      dateRange: entry.date_range,
      taken,
    });
    if (src) taken.add(src.id);
    if (!src) {
      // No source entry -> the org is invented. Its bullets' metrics are unsupported too, but the
      // org fix (drop the whole entry) subsumes them, so we don't double-report per bullet.
      violations.push({ entry: entry.org, kind: 'org', detail: entry.org });
      continue;
    }
    if (titleIsSwapped(entry.title, src.title)) {
      violations.push({ entry: entry.org, kind: 'title', detail: entry.title });
    }
    for (const yr of ungroundedYears(entry.date_range, src.date_range)) {
      violations.push({ entry: entry.org, kind: 'date', detail: yr });
    }
    const srcSigs = numberSignatures(bankEntryCorpus(src));
    for (const bullet of entry.bullets) {
      for (const n of ungroundedNumbers(bullet, srcSigs)) {
        violations.push({ entry: entry.org, kind: 'metric', detail: n, bullet });
      }
      if (!bulletClaimIsGrounded(bullet, src)) {
        violations.push({ entry: entry.org, kind: 'claim', detail: bullet, bullet });
      }
    }
  }
  return violations;
}

// Last-resort sanitizer: after the generate/retry loop, strip anything still ungrounded rather
// than ship a fabricated claim. Drops invented entries, replaces a swapped title with the real
// one, and drops bullets that carry an ungrounded number. Returns the cleaned spec + a human list
// of what was removed (for the quality report / audit).
export function pruneUngroundedContent(
  spec: ResumeSpec,
  bank: ExperienceBankEntry[],
  declaredSkills?: string[] | null,
): { spec: ResumeSpec; removed: string[] } {
  const removed: string[] = [];
  const experience: ResumeSpec['experience'] = [];
  // Shared across the loop so two entries at one organisation resolve to different bank rows.
  const taken = new Set<string>();
  for (const entry of spec.experience) {
    const src = matchBankEntry(entry.org, bank, {
      title: entry.title,
      dateRange: entry.date_range,
      taken,
    });
    if (!src) {
      removed.push(`dropped entry "${entry.org}" (not in experience bank)`);
      continue;
    }
    taken.add(src.id);
    let title = entry.title;
    if (titleIsSwapped(title, src.title)) {
      removed.push(`reset title "${title}" -> "${src.title}" for ${entry.org}`);
      title = src.title ?? title;
    }
    let date_range = entry.date_range;
    if (src.date_range && ungroundedYears(date_range, src.date_range).length > 0) {
      removed.push(`reset date "${date_range}" -> "${src.date_range}" for ${entry.org}`);
      date_range = src.date_range;
    }
    const srcSigs = numberSignatures(bankEntryCorpus(src));
    const bullets = entry.bullets.filter((b) => {
      const bad = ungroundedNumbers(b, srcSigs);
      if (bad.length > 0) {
        removed.push(`dropped bullet with ungrounded ${bad.join(', ')} in ${entry.org}`);
        return false;
      }
      if (!bulletClaimIsGrounded(b, src)) {
        removed.push(`dropped unsupported bullet in ${entry.org}`);
        return false;
      }
      return true;
    });
    /* An entry whose every bullet was pruned is a job heading with nothing under it. It renders as a
     * company name, a title and a date range floating above white space, which reads to a human like
     * a broken resume and to a parser like an employment record with no duties.
     *
     * Caught 2026-07-27 by putting a WVU federal-resume TEMPLATE through the flow: its placeholder
     * bullets ("Provide your description of duties...") were correctly dropped as ungrounded, and
     * the build then produced, saved and passed a resume containing two empty entries.
     *
     * Dropping the entry rather than failing the build is the right direction: the student still
     * gets a resume out of the entries that do have content, and the note says what went. */
    if (bullets.length === 0) {
      removed.push(`dropped "${entry.org}" entirely, nothing on it could be supported by your resume`);
      continue;
    }
    experience.push({ ...entry, title, date_range, bullets });
  }

  // Skills are pruned only in declared mode. Dropping on soft bank-grounding would strip skills the
  // student genuinely has but never wrote a bullet about, which is why that mode only warns.
  //
  // Unlike experience, an empty result needs no "never let this empty the resume" guard: a resume
  // with no SKILLS line is honest and readable, whereas one with no experience is a blank page. If
  // pruning empties it, the declared list is the thing to fix.
  let skills = spec.skills;
  if (declaredSkills?.length) {
    // spec.skill_source is deliberately NOT passed while renaming is disabled. The disable lives in
    // the prompt, and the whole reason it is off is that the model ignored the prompt's own rules on
    // the first live run; a prompt-level ban that the validator still honors is not a ban, it is an
    // invitation with a comment. Until the curated synonym whitelist exists, a rename the model emits
    // anyway is treated as any other ungrounded skill and pruned, which fails in the honest
    // direction: fewer skills listed, all of them verbatim hers. Re-enable both together.
    const ungrounded = new Set(findUngroundedSkills(spec.skills, bank, declaredSkills));
    if (ungrounded.size > 0) {
      skills = spec.skills.filter((s) => !ungrounded.has(s));
      removed.push(`dropped ungrounded skills: ${[...ungrounded].join(', ')}`);
    }
  }

  return { spec: { ...spec, experience, skills }, removed };
}

export function pruneUngroundedSkills(
  spec: ResumeSpec,
  bank: ExperienceBankEntry[],
  declaredSkills?: string[] | null,
): { spec: ResumeSpec; removed: string[] } {
  if (!declaredSkills?.length) return { spec, removed: [] };

  const ungrounded = new Set(findUngroundedSkills(spec.skills, bank, declaredSkills));
  if (ungrounded.size === 0) return { spec, removed: [] };

  const skills = spec.skills.filter((skill) => !ungrounded.has(skill));
  const next: ResumeSpec = { ...spec, skills };
  if (spec.skill_source) {
    const skill_source = Object.fromEntries(
      Object.entries(spec.skill_source).filter(([skill, source]) => !ungrounded.has(skill) && !ungrounded.has(source)),
    );
    next.skill_source = Object.keys(skill_source).length > 0 ? skill_source : undefined;
  }

  return {
    spec: next,
    removed: [`dropped ungrounded skills: ${[...ungrounded].join(', ')}`],
  };
}

// Skills the spec lists that the student cannot be said to have. Two modes, and which one applies
// depends entirely on whether the student ever told us their skills (profiles.skills, R-015).
//
// DECLARED MODE (`declared` non-empty) - the list is AUTHORITATIVE and anything outside it is
// ungrounded, full stop. Bank corpus is NOT consulted, deliberately: `experience_bank.tags` is
// seeded junk (the same gRPC/SDK-design array copy-pasted onto 6 of 7 rows, including a Product
// Management internship and a VP of Finance role), so grounding against it is how "gRPC" and "SDK
// design" reached essentially every resume Mehek has sent. A source that is itself unreliable
// cannot launder a claim. The student's own list can, which is the whole point of collecting it.
//
// FALLBACK MODE (no `declared`) - the pre-existing soft behaviour, unchanged: a skill is grounded
// if any of its content words appears in the bank corpus, and misses are WARNINGS rather than
// hard issues. The reasoning still holds when there is no declared list: the bank is an incomplete
// view of a student's real skills (they may genuinely know a tool they never wrote a bullet
// about), so hard-blocking on it alone would strip legitimate skills. The warning still flags
// likely JD-driven fabrication for human review without over-correcting.
//
// So collecting the list is what upgrades this check from advisory to enforceable. Without it,
// there is nothing a fabricated skill can be checked against - which is why the register's fix #1
// (add a real skills source) had to come before its fix #4 (validate against it).
export function findUngroundedSkills(
  skills: string[],
  bank: ExperienceBankEntry[],
  declared?: string[] | null,
  skillSource?: Record<string, string> | null,
): string[] {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const allowed = new Set((declared ?? []).map(norm).filter(Boolean));

  if (allowed.size > 0) {
    // A skill survives declared mode two ways, and only two:
    //   1. it is verbatim one of the student's declared skills, or
    //   2. spec.skill_source says it RENAMES one of them, for the JD's vocabulary.
    // Case 2 is why this map is trusted at all: the model may relabel "SQL" as the JD's "ETL", but
    // the label it claims to be renaming must itself be a real declared skill. So a rename can never
    // introduce a skill the student never claimed - the worst it can do is mislabel one they did,
    // which the prompt's negative examples target and which stays visible in skill_source rather than
    // vanishing into the resume. Without this, every rename would be silently dropped here (R-015).
    return skills.filter((s) => {
      const n = norm(s);
      if (!n) return false;
      if (allowed.has(n)) return false;
      const renames = skillSource?.[s];
      if (renames && allowed.has(norm(renames))) return false;
      return true;
    });
  }

  const corpus = wordSet(bank.map(bankEntryCorpus).join(' '));
  if (corpus.size === 0) return [];
  const out: string[] = [];
  for (const skill of skills) {
    const tokens = wordSet(skill);
    if (tokens.size === 0) continue; // pure punctuation/symbol - nothing to ground
    const grounded = [...tokens].some((t) => corpus.has(t));
    if (!grounded) out.push(skill);
  }
  return out;
}

// Spec-level checks: content rules a JD-tailored spec must satisfy before it's worth rendering.
// Mirrors validate_resume.py's content/structure checks + pressure_test.py's per-bullet scoring,
// adapted from the Dubai engine's fixed EDUCATION/EXPERIENCE/LEADERSHIP/SKILLS template to
// Litos's generalized per-student spec (no LEADERSHIP section, entries aren't hardcoded).
// When `bank` is provided, grounding violations are added as hard issues so the retry loop
// regenerates; pass [] to skip grounding (form-only validation).
/* Is the rendered coursework line claiming a course the uploaded resume never printed?
 *
 * The line is a comma-JOIN of course titles, and a course title can itself contain a comma. Real
 * example, measured on a University of Washington sample CV, 2026-07-27: "Race, Gender, and
 * Sexuality in the Media". Splitting the line on "," shattered that into "Race", "Gender" and "and
 * Sexuality in the Media", none of which are in the allowed set, so a resume whose coursework was
 * copied VERBATIM off the upload was reported as containing a fabricated course.
 *
 * That is worse than a cosmetic bug. This validator's whole job is to tell a student when we have
 * put something on their resume that is not theirs, and a check that cries wolf on correct output
 * teaches them to scroll past the one warning that matters.
 *
 * So the line is walked rather than split: at each position, take the LONGEST allowed course that
 * matches there. Longest-first is what makes it unambiguous when one title is a prefix of another
 * ("Data Structures" vs "Data Structures and Algorithms"). Anything left that no allowed course
 * matches is a genuinely ungrounded claim, which is exactly what we want to report.
 */
export function courseworkIsUngrounded(rendered: string, allowed: string[] | undefined): boolean {
  const line = (rendered ?? '').trim();
  if (line.length === 0) return false;
  const courses = (allowed ?? [])
    .map((course) => course.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (courses.length === 0) return true; // a coursework line with nothing to ground it against

  let at = 0;
  while (at < line.length) {
    // Separators between entries, and any stray whitespace the join left behind.
    if (line[at] === ',' || line[at] === ' ') {
      at += 1;
      continue;
    }
    const match = courses.find((course) => line.startsWith(course, at));
    if (!match) return true;
    at += match.length;
  }
  return false;
}

// Spec-level checks: content rules a JD-tailored spec must satisfy before it's worth rendering.
// Mirrors validate_resume.py's content/structure checks + pressure_test.py's per-bullet scoring,
// adapted from the Dubai engine's fixed EDUCATION/EXPERIENCE/LEADERSHIP/SKILLS template to
// Litos's generalized per-student spec (no LEADERSHIP section, entries aren't hardcoded).
// When `bank` is provided, grounding violations are added as hard issues so the retry loop
// regenerates; pass [] to skip grounding (form-only validation).
/**
 * Every word a resume spec puts on the page, joined into one string.
 *
 * Extracted so the validator and the JD match scorer read the SAME text. This join has been wrong
 * once already: date_range was the one field it omitted, so an em dash in "Sept. 2019 - Present"
 * passed every content check and reached the rendered PDF. A second copy of the list in jdMatch's
 * caller would be a second chance to make that mistake, and a scorer reading fewer fields than the
 * validator would quietly under-credit the student for work that is genuinely on their resume.
 */
export function resumeSpecText(spec: ResumeSpec): string {
  return [
    /* NO target_role. This is "every word a resume spec puts on the page", and since the header
       stopped printing the posting's job title, that title is no longer on the page. Leaving it in
       would credit the student's match score for text no employer will ever read, and the score is
       defined as their resume against the posting's requirements. It also scored a free hit every
       time: the string came FROM the posting, so it matched the posting by construction.

       Match scores drop slightly and correctly as a result. */
    spec.school,
    spec.degree,
    spec.grad_date,
    spec.gpa ?? '',
    spec.coursework,
    ...spec.experience.flatMap((e) => [e.org, e.title, e.date_range, ...e.bullets]),
    ...spec.skills,
  ].join(' ');
}

/**
 * The one place the education-position issue is worded, so callers can recognise it without
 * matching a string that lives somewhere else.
 *
 * Position is the one member of this set that is not a claim about the student. It is DERIVED from
 * the calendar: deriveCandidateContext does year arithmetic against RECENT_GRADUATE_YEARS, so a
 * May 2023 graduate renders education at the top through 2025 and after experience from 1 January
 * 2026. The flip lands at midnight on New Year of grad_year+3, which means a packet built on 31
 * December and sent on 2 January is stale after two days, and since nothing expires packets, the
 * exposure only widens. That packet's education did not change and telling its owner it did would
 * be a false statement from the guard, which is the same class of defect this guard exists to
 * prevent. Hence a separate code and separate copy: see educationDriftResponse.
 */
export const EDUCATION_POSITION_ISSUE_PREFIX = 'education must render';

/** True when an issue from educationDriftIssues is the calendar-derived layout one. */
export function isEducationLayoutIssue(issue: string): boolean {
  return issue.startsWith(EDUCATION_POSITION_ISSUE_PREFIX);
}

/**
 * The one implementation of "does this resume's education block still agree with the profile".
 *
 * Extracted from validateResumeSpec so the send-time guards on the unattended submission routes can
 * apply the SAME rule rather than a second copy of it. A packet freezes its rendered PDF at build
 * time, so nothing re-derives education when it is finally submitted; a second, drifting copy of
 * this comparison would be its own defect, and the whole point of the guard is that a packet that
 * PATCH /applications/:id/resume would still accept is a packet that can be sent unattended.
 *
 * DELIBERATELY NOT COMPARED: gpa, gpa_scale and major. GET /profile overrides those from
 * application_profile while a packet's GPA comes from parsed_json, and the two stores are allowed to
 * disagree from a packet's birth. Comparing them would refuse packets that never drifted.
 */
export function educationDriftIssues(spec: ResumeSpec, education: CandidateEducation): string[] {
  const issues: string[] = [];
  const exact = (value: string | undefined) => value?.trim() ?? '';
  if (spec.school !== exact(education.school)) issues.push('education school differs from uploaded resume');
  if (spec.degree !== exact(education.degree)) issues.push('education degree differs from uploaded resume');
  if (spec.grad_date !== exact(education.grad_date)) issues.push('education graduation date differs from uploaded resume');
  if (courseworkIsUngrounded(spec.coursework, education.coursework)) {
    issues.push('coursework contains a course not listed on the uploaded resume');
  }
  const expectedPosition = deriveCandidateContext(education).education_position;
  if (spec.education_position !== expectedPosition) {
    issues.push(`${EDUCATION_POSITION_ISSUE_PREFIX} ${expectedPosition === 'top' ? 'at the top for a currently enrolled student' : 'after experience for this candidate'}`);
  }
  return issues;
}

export function validateResumeSpec(
  spec: ResumeSpec,
  jdText: string,
  bank: ExperienceBankEntry[] = [],
  declaredSkills?: string[] | null,
  education?: CandidateEducation,
  targetRole?: string,
  options: {
    allowedSingleBulletEntries?: ExperienceBankEntry[];
    /* THE PACKET IS HER OWN MAIN RESUME, NOT A GENERATION. The skills-grounding hard issue below
     * exists to stop the generator importing JD vocabulary into the skills line ("never add a
     * skill because the JD asks for it"). On an untailored main-resume packet no generator ran:
     * the skills line is the document she uploaded, printed verbatim, and the declared list is a
     * second store of the same fact that nothing reconciles. Measured live 2026-09-01 (Hudson River
     * Trading, application 4a79eec1): the uploaded resume carried "wireframing", "mobile UX",
     * "feature documentation" and "behavioral data", the declared list did not, and the packet
     * that had just passed the audit was refused at approve for four skills she wrote herself.
     * Off-list skills on such a packet stay visible as warnings; they are never a refusal. Every
     * other rule here still applies unchanged, and a tailored packet is judged exactly as before. */
    untailored?: boolean;
  } = {},
): ValidationResult {
  const issues: string[] = [];
  const warnings: BulletFlag[] = [];

  const allText = resumeSpecText(spec);

  if (allText.includes('—')) issues.push('spec contains an em dash');
  if (targetRole !== undefined) {
    const expectedTargetRole = resumeSafeTargetRole(targetRole);
    if (!expectedTargetRole) issues.push('target role headline requires a non-empty job title');
    else if (spec.target_role !== expectedTargetRole) {
      issues.push('target role headline does not exactly match the resume-safe job title');
    }
  }
  if (spec.experience.length === 0) issues.push('no experience entries selected');
  if (spec.experience.length > RESUME_CONTENT_LIMITS.maxEntries) {
    issues.push(
      `${spec.experience.length} entries selected (max ${RESUME_CONTENT_LIMITS.maxEntries})`,
    );
  }

  if (education) issues.push(...educationDriftIssues(spec, education));

  const kw = jdKeywords(jdText);

  for (const entry of spec.experience) {
    /* THE EXPANDED CEILING, not the selection target, and the difference matters here.
     *
     * `maxBulletsPerEntry` is what the model is asked to SELECT - three, because the strongest three
     * lines are what a reader gets through. `expandedBulletsPerEntry` is what a legal resume may
     * PRINT, because a page that spacing cannot fill is topped up from the student's own unused
     * bank evidence (see planResumeLayout's expand pass).
     *
     * Validating against the selection target refused those resumes outright: measured on the first
     * production run after that pass shipped, "Stripe: 5 bullets (max 3)" - a hard quality hold on
     * a document whose only sin was being full. The selection discipline is kept by the prompt and
     * by the floor's own slice, not by this gate. */
    if (entry.bullets.length > RESUME_CONTENT_LIMITS.expandedBulletsPerEntry) {
      issues.push(
        `${entry.org}: ${entry.bullets.length} bullets (max ${RESUME_CONTENT_LIMITS.expandedBulletsPerEntry})`,
      );
    }
    if (entry.bullets.length === 0) {
      issues.push(`${entry.org}: no bullets selected`);
    } else if (entry.bullets.length < RESUME_CONTENT_LIMITS.minBulletsPerEntry) {
      const source = matchBankEntry(entry.org, bank, {
        title: entry.title,
        dateRange: entry.date_range,
      });
      const allowed = options.allowedSingleBulletEntries ?? [];
      const sourceIsAllowed = source && allowed.some((candidate) => candidate.id === source.id);
      const sourceBullets = Array.isArray(source?.bullet_variants)
        ? source.bullet_variants.filter((bullet): bullet is string => typeof bullet === 'string' && bullet.trim().length > 0)
        : [];
      const sourceIsSparse = sourceBullets.length < RESUME_CONTENT_LIMITS.minBulletsPerEntry;
      if (!sourceIsAllowed || !sourceIsSparse) {
        issues.push(
          `${entry.org}: ${entry.bullets.length} bullet selected (min ${RESUME_CONTENT_LIMITS.minBulletsPerEntry})`,
        );
      }
    }

    for (const bullet of entry.bullets) {
      const flags: string[] = [];
      if (bullet.includes('—')) issues.push(`em dash in bullet: "${excerpt(bullet)}"`);
      if (bullet.length > BULLET_MAX_CHARS) issues.push(`bullet exceeds ${BULLET_MAX_CHARS} chars: "${excerpt(bullet)}"`);

      const words = bullet.trim().split(/\s+/);
      const nWords = words.length;
      // The one shared implementation of the hard rule (see startsWithStrongVerb above), so the
      // validator, both generation prompts, the base build's retry and the /start editor can never
      // disagree about what counts as a strong opener.
      const isAction = startsWithStrongVerb(bullet);
      const isInitiative = opensWithVerbFrom(bullet, INITIATIVE_VERBS);
      const hasMetric = METRIC_RE.test(bullet);
      const andCount = (bullet.toLowerCase().match(/\band\b/g) ?? []).length;
      const hits = [...contentWords(bullet)].filter((w) => kw.has(w)).length;

      if (!isAction) issues.push(`bullet not action-verb-first ("${words[0]}"): "${excerpt(bullet)}"`);
      if (nWords < BULLET_MIN_WORDS) {
        issues.push(`bullet has ${nWords} words (min ${BULLET_MIN_WORDS}): "${excerpt(bullet)}"`);
      }
      if (nWords > BULLET_MAX_WORDS) {
        issues.push(`bullet has ${nWords} words (max ${BULLET_MAX_WORDS}): "${excerpt(bullet)}"`);
      }
      if (andCount > 2) flags.push(`run-on(${andCount} "and"s)`);
      if (!hasMetric && hits < 2) flags.push('thin(no-metric+low-fit)');
      if (!isInitiative && !hasMetric) flags.push('no-ownership-signal');

      if (flags.length > 0) warnings.push({ entry: entry.org, bullet, flags });
    }
  }

  /* Near-duplicate check (pressure_test.py's entry_overlaps): two bullets restating the same point
   * via high content-word overlap.
   *
   * ACROSS ENTRIES AS WELL AS WITHIN ONE, which it was not until 2026-09-01. The loop used to be
   * `for (const entry of spec.experience)` with an inner pair loop over that entry's own bullets,
   * so a pair sharing 30% of its words inside one entry was flagged while a pair sharing 100% of
   * its words across two entries passed in silence. A live resume printed the same three sentences
   * under EXPERIENCE and again under PROJECTS without raising anything here.
   *
   * The rule this check encodes - a resume does not say the same thing twice - was never about
   * entry boundaries; the scope was just an artefact of how it was written. Flattening the pair
   * loop over every bullet on the resume is the whole fix.
   *
   * REPORTING ONLY, deliberately, and it stays that way even for a 100% match. The deterministic
   * drop for an exact repeat lives in engine/resumePolicy.ts enforceExperienceBulletFloor, which
   * runs after this and can also see the bank top-up. Two mechanisms racing to remove the same
   * bullet would make it impossible to say from a packet which one acted, and this one runs early
   * enough that dropping here would hide the duplicate from the retry feedback the model needs. */
  /* `index` is the bullet's position WITHIN ITS OWN ENTRY, carried alongside because the flattened
     position means nothing to a reader looking at one heading on the page.

     `entryIndex` is the ENTRY's position, and it is what identifies an entry here - not the org.
     Using the org would have been wrong for exactly the resume this check was extended to catch:
     the two Tonee entries share an org and differ only by title and type, so an org comparison
     called them one entry and reported a cross-section repeat as "overlaps bullet 1", pointing the
     reader at a bullet that is not under that heading. */
  const allBullets = spec.experience.flatMap((entry, entryIndex) =>
    entry.bullets.map((bullet, index) => ({ org: entry.org, bullet, index, entryIndex })),
  );
  for (let i = 0; i < allBullets.length; i++) {
    for (let j = i + 1; j < allBullets.length; j++) {
      const a = contentWords(allBullets[i].bullet);
      const b = contentWords(allBullets[j].bullet);
      if (a.size === 0 || b.size === 0) continue;
      const intersection = [...a].filter((w) => b.has(w)).length;
      const union = new Set([...a, ...b]).size;
      const jaccard = intersection / union;
      if (jaccard >= 0.3) {
        /* Naming the other entry matters now that the pair can span two of them: "overlaps bullet
           2" is actionable when both are under one heading and meaningless when the other bullet is
           in a different section of the page. */
        const sameEntry = allBullets[i].entryIndex === allBullets[j].entryIndex;
        const where = sameEntry
          ? `bullet ${allBullets[j].index + 1}`
          : `a bullet under "${allBullets[j].org}"`;
        warnings.push({
          entry: allBullets[i].org,
          bullet: allBullets[i].bullet,
          flags: [`overlaps ${where} (${Math.round(jaccard * 100)}% shared words)`],
        });
      }
    }
  }

  // Reported, but NOT a hard issue: the floor is currently unreachable, so making it drive the
  // retry loop was pure harm (R-023).
  //
  // jdKeywords() returns every non-stopword word in the JD over 3 chars: 304 of them for a 4.8k
  // Cohere posting, including "toronto", "vacation", "benefits", "passionate", "obsess". Measured
  // 2026-07-17: Mehek's ENTIRE bank, all 7 entries and 409 words (nearly 3x what fits on one page),
  // covers 12-17% of that vocabulary. No resume she could physically write reaches 18%, so this
  // fired on 100% of generations and the retry could never clear it.
  //
  // That mattered for more than cost. The retry feeds these issues back to the model as "fix them
  // in this revision", so every generation was explicitly told "not tailored enough to this JD" and
  // responded the only way it could: by importing JD vocabulary into the skills line. This gate was
  // manufacturing the R-015 fabrication it was supposed to be unrelated to.
  //
  // Left as a warning rather than recalibrated because the number is not just mis-scaled, it barely
  // discriminates: measured against a matching JD vs a wholly mismatched one it separates them by
  // ~2 points, and the obvious alternatives (repeated terms, top-N by frequency) score the
  // MISMATCHED JD higher. A metric worth gating on needs a real keyword model, which is a design
  // decision, not a threshold tweak. Until then, do not restore this as an issue by lowering
  // MIN_KEYWORD_COVERAGE: that buys a green check without making the resume any more tailored.
  const present = [...kw].filter((w) => allText.toLowerCase().includes(w)).length;
  const coveragePct = kw.size > 0 ? Math.round((100 * present) / kw.size) : 100;
  if (coveragePct < MIN_KEYWORD_COVERAGE) {
    warnings.push({
      entry: 'ats',
      bullet: '',
      flags: [`low-keyword-coverage(${coveragePct}% < ${MIN_KEYWORD_COVERAGE}%)`],
    });
  }

  // Grounding: fail if the spec cites an org/title/number that isn't in the student's bank.
  if (bank.length > 0) {
    for (const v of findGroundingViolations(spec, bank)) {
      if (v.kind === 'org') {
        issues.push(`grounding: experience entry "${v.detail}" is not in the student's experience bank`);
      } else if (v.kind === 'title') {
        issues.push(`grounding: title "${v.detail}" for ${v.entry} is not supported by the experience bank`);
      } else if (v.kind === 'date') {
        issues.push(`grounding: date "${v.detail}" for ${v.entry} is not in the student's experience bank`);
      } else if (v.kind === 'claim') {
        issues.push(`grounding: a ${v.entry} bullet is not supported by any stored source bullet`);
      } else {
        issues.push(`grounding: metric "${v.detail}" in a ${v.entry} bullet is not in the experience bank ("${excerpt(v.bullet ?? '')}")`);
      }
    }
    // With a declared skills list the check is enforceable, so an off-list skill is a HARD issue
    // that drives the retry loop: the student said what they know, and the resume claiming more
    // than that is a false statement about them, not a quality nit. Without one there is nothing
    // authoritative to check against, so it stays a warning - see findUngroundedSkills.
    // skill_source deliberately not passed while renaming is disabled: see pruneUngroundedContent.
    // A rename the model emits against the prompt's ban must surface as a hard issue and drive the
    // retry, whose feedback line below already tells it the fix (use the list verbatim).
    const ungroundedSkills = findUngroundedSkills(spec.skills, bank, declaredSkills);
    if (declaredSkills?.length && !options.untailored) {
      for (const skill of ungroundedSkills) {
        issues.push(`grounding: skill "${skill}" is not in the student's skills list; never add a skill because the JD asks for it`);
      }
    } else {
      for (const skill of ungroundedSkills) {
        warnings.push({ entry: 'skills', bullet: skill, flags: ['ungrounded-skill'] });
      }
    }
  }

  return { issues, warnings, ats_keyword_coverage_pct: coveragePct };
}

// Post-render layout checks (validate_resume.py's PDF section): exactly 1 page, text
// extractable (ATS-readable - guaranteed by construction since resumeRender.ts writes real
// text, not a rasterized image, but checked anyway as the authoritative signal).
export interface PdfLayoutResult {
  issues: string[];
  page_count: number;
  extractable_chars: number;
}

export function validatePdfLayout(extractedText: string, pageCount: number): PdfLayoutResult {
  const issues: string[] = [];
  if (pageCount !== 1) issues.push(`PDF is ${pageCount} pages (want 1)`);
  if (extractedText.trim().length < 400) issues.push('PDF text not extractable (ATS-unreadable)');
  // The zero-em-dash rule (validate_resume.py enforces the same), checked on what actually
  // RENDERED rather than trusting the spec-level prompt. This check existed in spirit but could
  // never fire while the post-render parse threw on every resume (R-017); it is the seeded
  // violation the R-017 regression test drives end to end.
  if (extractedText.includes('\u2014')) issues.push('Rendered PDF contains an em dash (banned punctuation)');
  return { issues, page_count: pageCount, extractable_chars: extractedText.trim().length };
}
