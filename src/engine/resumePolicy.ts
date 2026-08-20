import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { RESUME_CONTENT_LIMITS } from './resumeContentPolicy';
import { startsWithStrongVerb } from './resumeValidate';

export interface CandidateEducation {
  school: string;
  degree?: string;
  grad_date?: string;
  grad_year?: number;
  currently_enrolled?: boolean;
  coursework?: string[];
  /* application_profile FIRST, parsed_json only as the seed behind it. Populate these with
     educationFrom rather than by hand, so the precedence cannot be forgotten at a call site.
     (This comment previously said the opposite - "never from application_profile" - and the
     reasoning it gave was wrong on both halves. Recorded here because the claim was cited as
     evidence by later work.)

     WHY THIS WAY ROUND. application_profile is what the student typed, or what /profile/harvest
     watched her type into a real employer form: a first-hand claim by the person it is about.
     parsed_json is an LLM's reading of a PDF, seeded into the blanks of that row by
     academicSeedFrom and never allowed to overwrite it. Every other employer-facing surface
     already resolves the two that way - GET /profile (academicsOfRecord), the extension's grades
     adapter, the managed submission runner - and on 2026-08-03 the parse said "3.8" where
     application_profile said "3.89". Reading the parse here made the rendered PDF the ONLY
     surface still printing the truncated number, and the PDF is the copy an employer keeps.

     The old comment's decrypt argument does not hold either: nothing forces this path through
     decryptRow's throw. applicationRowForProfile already catches it and yields a blank academic
     record, which suppresses the number instead of failing the generation OR falling back to the
     parse - see the note there for why blank beats a contradicting grade.

     Seeding direction is not precedence. academicSeedFrom does copy parsed -> application_profile
     for most students, which is exactly why the two usually agree; it says nothing about which
     copy to believe on the day they disagree. */
  gpa?: string;
  gpa_scale?: string;
  school_location?: string;
}

/* "3.8/4.0", or "3.8" when the resume printed no denominator, or nothing at all.
 *
 * NOTHING IS INVENTED HERE, including the scale. A bare "3.8" is genuinely ambiguous - it is a
 * different claim on a 4.0 than on a 5.0 - and the parser's own rule is to record the denominator
 * only when the page states one. Defaulting the missing case to "/4.0" would be a fabricated
 * academic claim on an employment document, which is the one thing this codebase refuses to do
 * anywhere else either.
 *
 * Shape-guarded rather than trusted: parsed_json is jsonb and a hand-edited row can hold anything,
 * and "GPA: first class honours" printed in the education block would be a claim we never read off
 * the page. */
/* Up to THREE digits, because a two-digit cap silently deleted the denominator on every
   percentage-style record. "85/100" printed as "GPA: 85", which reads as an 85 on a 4.0-style
   scale - a materially different and much better claim than the page made. The /100 and
   percentage systems are standard across India and the UAE, so this was not an exotic edge case
   for this product's users. Four digits stays out: that is a year, not a grade. */
const GPA_VALUE = /^\d{1,3}(?:\.\d{1,3})?$/;

export function educationGpaLine(education: Pick<CandidateEducation, 'gpa' | 'gpa_scale'>): string {
  const value = education.gpa?.trim() ?? '';
  if (!GPA_VALUE.test(value)) return '';
  const scale = education.gpa_scale?.trim() ?? '';
  return GPA_VALUE.test(scale) ? `${value}/${scale}` : value;
}

/* The academic fields the RENDERED resume can state. gpa reaches the page through
 * educationGpaLine; gpa_scale reaches it as that line's denominator.
 *
 * major is deliberately absent, and this is not an oversight to be tidied later: ResumeSpec has no
 * major field and resumeRender draws none, so the education block prints school, degree, grad date,
 * GPA and coursework only. profile.ts overrides all THREE academic fields because GET /profile and
 * autofill do serve a major. Add it here the day the render does, and not before - a field carried
 * into a spec nothing prints is just another thing to keep in sync. */
export const RESUME_ACADEMIC_FIELDS = ['gpa', 'gpa_scale'] as const;

/* The academic record as the product will state it, or undefined when there is no record at all.
 *
 * Mirrors academicsOfRecord in routes/profile.ts, minus major (see above), and mirrors it including
 * the part that looks like a bug: a row that EXISTS but holds a blank gpa resolves to '', not to the
 * parse's number.
 *
 * THE BLANK CASE IS THE WHOLE POINT. Blank on application_profile means "not on record", and the
 * value autofill types into an employer's GPA box is nothing. Printing the parse's number there
 * would put a grade on the PDF that the same application's typed fields deny and that the student's
 * own dashboard does not show her - which is the exact contradiction this fix exists to remove,
 * just pointed the other way. Per-field fallback would have been the softer change and is the wrong
 * one: the alternative to a first-hand blank is silence, not an LLM's guess.
 *
 * No row at all is a different situation and returns undefined, leaving the parse in place. There is
 * no second value to contradict, the parse is the only copy anyone has, and a student who has not
 * reached the application-profile step yet is not making a claim we can override. */
export function academicsOfRecordForResume(
  applicationRow: Record<string, unknown> | undefined,
): Pick<CandidateEducation, 'gpa' | 'gpa_scale'> | undefined {
  if (!applicationRow) return undefined;
  const out: Pick<CandidateEducation, 'gpa' | 'gpa_scale'> = {};
  for (const field of RESUME_ACADEMIC_FIELDS) {
    const value = applicationRow[field];
    out[field] = typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
  }
  return out;
}

/**
 * `parsed_json.coursework` as the list every reader of it expects, from whatever is actually stored.
 *
 * THE CANONICAL SHAPE IS A LIST, and this is the one place that says so. llm/parse.ts emits
 * `string[]`, lib/submissionEducationGuard.ts compares entry by entry, and
 * engine/resumeValidate.ts courseworkIsUngrounded() walks the individual course titles to ground a
 * rendered line against them - none of which a single joined string can serve. The resume's one
 * line is produced by joining at the END of applyResumePolicy, not by storing it pre-joined.
 *
 * A stored string is accepted and split because the review screen edits this as one comma separated
 * input and, before ISSUE-044, wrote that string straight through. Returns undefined rather than []
 * for a missing field, because CandidateEducation distinguishes "no coursework on record" from "an
 * empty list", and academicsOfRecordForResume spreads over this result.
 *
 * Commas only. Course titles carry "&" ("Financial Analysis & Valuation") and "and" ("Data
 * Structures and Object-Oriented Design") inside a single title, so the comma is the only separator
 * that is not also ordinary content: splitting on "and" would cut that second title in half.
 */
export function courseworkFromParsed(value: unknown): string[] | undefined {
  const raw = typeof value === 'string'
    ? value.split(',')
    : Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
  if (raw === undefined) return undefined;
  const courses: string[] = [];
  for (const candidate of raw) {
    const course = candidate.trim();
    if (!course || courses.some((existing) => existing.toLowerCase() === course.toLowerCase())) continue;
    courses.push(course);
  }
  return courses;
}

/* profiles.parsed_json (+ the academic record that outranks it) -> the education block.
 *
 * ONE function for both generation paths on purpose. /resume/base/stream and /resume/generate build
 * the same education block from the same two rows, and they used to build it with two separate
 * pieces of code: the base path through this function, the tailored path inline. Every field one
 * side learned about and the other did not was a difference between the base resume the student
 * approves on /start and the tailored resume that goes to the employer - which is how the GPA came
 * to be read from the wrong column on both paths and fixable on only one.
 *
 * Shape-guarded throughout: parsed_json is jsonb and a hand-edited row can hold anything. */
export function educationFrom(
  parsed: unknown,
  applicationRow?: Record<string, unknown>,
): CandidateEducation {
  const p = (parsed ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const gradYear = typeof p.grad_year === 'number' && p.grad_year > 0 ? p.grad_year : undefined;
  return {
    school: str(p.school) ?? '',
    degree: str(p.degree),
    /* Falsy rather than nullish, which is the tailored path's rule and now both paths': a stored
       grad_date of '' is a missing date, and treating it as a present one printed an empty right
       column beside the degree on a profile that knows the year perfectly well. */
    grad_date: str(p.grad_date) || (gradYear ? String(gradYear) : undefined),
    grad_year: gradYear,
    currently_enrolled: typeof p.currently_enrolled === 'boolean' ? p.currently_enrolled : undefined,
    /* The base resume is built by the same applyResumePolicy pass the tailored path runs, and it is
       the document the student approves on /start. Omitting these here would have shown them a base
       resume with no GPA and then a tailored one with it, which reads as the product changing their
       education between screens. */
    gpa: str(p.gpa),
    gpa_scale: str(p.gpa_scale),
    school_location: str(p.school_location),
    /* Both shapes, PERMANENTLY, not just until the backfill runs (ISSUE-044).
     *
     * This line used to be a bare Array.isArray gate, and a stored string therefore read as
     * undefined and printed an empty "Relevant coursework" line on every generated resume - the
     * silent half of the write/read disagreement that PATCH /profile/parsed opened. The write side
     * is fixed and the corrupted rows are backfilled, so this tolerance has no rows to serve today.
     * It stays anyway for two reasons: parsed_json is jsonb that a hand-edited row can put anything
     * in, and the site and API deploy from SEPARATE repos on merge, so there is always a window
     * where one side is new and the other is not. Reading is the cheap side of that window to be
     * forgiving on; the strictness that matters is on the write. */
    coursework: courseworkFromParsed(p.coursework),
    /* LAST, so it wins. See academicsOfRecordForResume. */
    ...academicsOfRecordForResume(applicationRow),
  };
}

export interface CandidateContext {
  currently_enrolled: boolean;
  education_position: 'top' | 'after_experience';
}

export function resumeSafeTargetRole(role: string): string {
  return role.trim().replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ');
}

const STOP = new Set(
  'the and for with from that this into using used role team work your our their are was were have has'.split(' '),
);

function tokens(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z0-9+#.]{2,}/g) ?? []).filter((token) => !STOP.has(token)),
  );
}

function overlapScore(text: string, jdText: string): number {
  const source = tokens(text);
  const target = tokens(jdText);
  let overlap = 0;
  for (const token of source) if (target.has(token)) overlap += 1;
  return overlap;
}

function parseGraduationDate(value: string | undefined): Date | null {
  if (!value?.trim()) return null;
  const year = value.match(/\b(20\d{2})\b/)?.[1];
  if (!year) return null;
  const monthNames: Record<string, number> = {
    january: 0,
    february: 1,
    march: 2,
    april: 3,
    may: 4,
    june: 5,
    july: 6,
    august: 7,
    september: 8,
    october: 9,
    november: 10,
    december: 11,
  };
  const monthName = Object.keys(monthNames).find((name) => value.toLowerCase().includes(name));
  return new Date(Number(year), monthName ? monthNames[monthName] : 11, 31, 23, 59, 59);
}

/* How long after graduating education still leads the page. Two years covers the window in which
 * the degree is still the strongest single line on a resume and employers are still hiring against
 * it, which is exactly the "recently graduated" case. */
const RECENT_GRADUATE_YEARS = 2;

export function deriveCandidateContext(
  education: CandidateEducation,
  now = new Date(),
): CandidateContext {
  const graduation = parseGraduationDate(education.grad_date);
  const year = education.grad_year && education.grad_year >= 2000 ? education.grad_year : undefined;
  const futureDate = graduation ? graduation.getTime() >= now.getTime() : year ? year >= now.getFullYear() : false;
  const hasEducation = Boolean(education.school?.trim());
  const hasGraduationEvidence = Boolean(graduation || year);
  const currentlyEnrolled =
    education.currently_enrolled !== false &&
    hasEducation &&
    (hasGraduationEvidence ? futureDate : education.currently_enrolled === true);

  /* Education leads the page when the candidate is enrolled or RECENTLY graduated. Anything else,
   * including a resume that gives no graduation evidence at all, puts experience first.
   *
   * CHANGED 2026-07-27 on Mehek's ruling, and this reverses a decision made earlier the same day.
   * The unknown case used to resolve toward "student", on the reasoning that parse.ts sets
   * currently_enrolled true only for an explicit signal, so false means "the resume did not say"
   * rather than "this person graduated". That was measured and correct FOR A STUDENT PRODUCT:
   * three of five real sample resumes landed in the unknown bucket and had education wrongly
   * pushed down.
   *
   * The audience is now job seekers, not students. Under that framing the same silence points the
   * other way: most people who are not students have simply finished, and leading with a degree
   * they got years ago buries the work history an employer is reading for. A current student is
   * still protected, because a future graduation date already makes currentlyEnrolled true above,
   * and a genuine recent graduate is still protected by RECENT_GRADUATE_YEARS. What changes is
   * only the case where we have no evidence in either direction.
   */
  const graduationYear = graduation ? graduation.getFullYear() : year;
  const yearsSinceGraduation =
    graduationYear !== undefined ? now.getFullYear() - graduationYear : undefined;
  // `>= 0` matters: a FUTURE graduation year is not a recent graduation. Without it, someone who
  // graduates in 2028 scores -2 years and reads as "recent", which would let a future date
  // override an explicit currently_enrolled: false - the exact conflation this function exists to
  // prevent.
  const recentGraduate =
    yearsSinceGraduation !== undefined &&
    yearsSinceGraduation >= 0 &&
    yearsSinceGraduation <= RECENT_GRADUATE_YEARS;
  const educationLeads = hasEducation && (currentlyEnrolled || recentGraduate);

  return {
    currently_enrolled: currentlyEnrolled,
    education_position: educationLeads ? 'top' : 'after_experience',
  };
}

/* The bar for "this is the same employer", defined once. Two call sites depend on it - which bank
   row an entry inherits, and whether that row's city is printed - and a second hard-coded copy is a
   drift waiting to happen. */
export const SAME_EMPLOYER_SCORE = 0.8;

/* Words that carry no identity: connectors and the legal or generic wrapper a name is dressed in.
   Stripping them is what lets "Nike Inc." match "Nike" and "Bain & Company" match "Bain", and it
   is also what finally separates "Company 1" from "Company 2" - once the generic head is gone,
   all that is left is the digit, which is the only part that was ever doing any work. */
const ORG_NOISE = new Set([
  'of', 'the', 'and', 'for', 'at', 'a', 'an', 'de', 'to',
  'inc', 'llc', 'ltd', 'limited', 'corp', 'corporation', 'co', 'company', 'group', 'holdings',
  'plc', 'gmbh', 'ag', 'sa', 'nv', 'bv', 'pty', 'pte', 'pvt',
]);

/* Organisation names are tokenised for IDENTITY, which is a different job from tokens() above.
   tokens() drops anything shorter than two characters because a stray "a" adds nothing to a
   relevance score. In a company name the dropped character is routinely the only thing telling two
   employers apart, so "Company 1" and "Company 2" both collapsed to {company} and scored a PERFECT
   1.0 against each other. No threshold on that scale could separate them, which is why this exists
   rather than a tuned constant. */
function orgWords(value: string): string[] {
  /* Apostrophes are removed rather than treated as a break, so "St. Jude's" and "St Judes" are the
     same two tokens. Splitting on them instead leaves a stray "s" that counts as a whole identity
     word, which drags an otherwise perfect match down to 0.5 and below the bar. */
  return value.toLowerCase().replace(/['\u2019]/g, '').match(/[a-z0-9]+/g) ?? [];
}

/* STRIPPING NOISE MUST NOT STRIP THE WHOLE NAME. A company called "The Company", "Holdings" or
   "The Group" is made entirely of the words this list discards, so it reduced to an empty set and
   scored 0.00 against ITSELF - never matching its own bank row, and silently losing that row's
   bullets, its entry type and its city. Every one of those failures is invisible: the resume simply
   comes out thinner.
   When the filter would empty a name, the unfiltered words are the name. */
function orgTokens(value: string): Set<string> {
  const words = orgWords(value);
  const meaningful = words.filter((part) => !ORG_NOISE.has(part));
  return new Set(meaningful.length > 0 ? meaningful : words);
}

function orgNumbers(value: string): Set<string> {
  return new Set(value.match(/\d+/g) ?? []);
}

function sameNumbers(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return true; // one side is silent; the words decide.
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function orgScore(generated: string, source: string): number {
  /* A DIGIT DISAGREEMENT IS DISQUALIFYING, before anything else gets a vote. Numbers in a company
     name are almost never decoration - they are the discriminator ("Site 1", "17 Asset Management",
     "Studio 54"). Two names whose numbers conflict are two different places however much of the
     rest they share, and no amount of word overlap or acronym cleverness should be able to
     out-argue that. */
  if (!sameNumbers(orgNumbers(generated), orgNumbers(source))) return 0;

  const a = orgTokens(generated);
  const b = orgTokens(source);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  /* Containment, not Jaccard, and deliberately: the model writes "Traeco" for a bank row reading
     "Traeco - AI Agent Cost Infrastructure", and the shorter name being wholly inside the longer
     one is the normal healthy case. Jaccard scores that pair 0.2 and would break every abbreviated
     org on every resume. What containment cannot do alone is reject a HALF match, which is why the
     caller's threshold is 0.8 rather than 0.5: "Bank of America" and "Bank of the West" share
     exactly one of two identity words and must not be treated as one employer. */
  const overlap = intersection / Math.min(a.size, b.size);
  const initialism = (value: string) => [...orgTokens(value)].map((part) => part[0]).join('');
  const compactGenerated = generated.toLowerCase().replace(/[^a-z0-9]/g, '');
  const compactSource = source.toLowerCase().replace(/[^a-z0-9]/g, '');
  const acronymMatch =
    compactGenerated === initialism(source) || compactSource === initialism(generated);
  return acronymMatch ? Math.max(overlap, 1) : overlap;
}

/* Exported for the renderer's expand pass, which needs the same identity rule the floor uses: an
   added bullet must come from THIS entry's bank row and never from another job at the same
   employer. One matcher, one answer. */
export function matchingBankEntry(entry: ResumeSpec['experience'][number], bank: ExperienceBankEntry[]) {
  const generatedTitle = tokens(entry.title ?? '');
  const generatedYears = new Set((entry.date_range ?? '').match(/\b(?:19|20)\d{2}\b/g) ?? []);
  return bank
    .map((source) => {
      const organization = orgScore(entry.org, source.org);
      const sourceTitle = tokens(source.title ?? '');
      let titleOverlap = 0;
      for (const token of generatedTitle) if (sourceTitle.has(token)) titleOverlap += 1;
      const title = generatedTitle.size > 0 && sourceTitle.size > 0
        ? titleOverlap / Math.min(generatedTitle.size, sourceTitle.size)
        : 0;
      const sourceYears = (source.date_range ?? '').match(/\b(?:19|20)\d{2}\b/g) ?? [];
      const sharedYear = sourceYears.some((year) => generatedYears.has(year));
      return { source, organization, score: organization * 10 + title * 4 + Number(sharedYear) * 2 };
    })
    /* 0.8, not 0.5. Half a name is not a name: at 0.5 "Bank of America" matched "Bank of the
       West", and every two-word company shared a threshold with its nearest unrelated neighbour.
       Containment means a legitimately abbreviated org still scores 1.0, so raising this costs the
       honest cases nothing and only rejects the half-matches. */
    .filter(({ organization }) => organization >= SAME_EMPLOYER_SCORE)
    .sort((a, b) => b.score - a.score || b.source.org.length - a.source.org.length)[0]?.source;
}

/**
 * The student's own OPENING VERB, when the model swapped it and changed nothing else.
 *
 * WHAT THIS IS FOR. The verb whitelist used to reject openers the student had legitimately written,
 * and a rejected opener is not merely flagged - the bullet is regenerated until it passes. So the
 * gate silently rewrote their sentences, and measured across ten real generations it only ever lost
 * ground:
 *
 *   "Backtested a mean-reversion signal..."   ->  "Tested a mean-reversion signal..."
 *   "Resequenced a pick path with OR-Tools"   ->  "Optimized a pick path with OR-Tools"
 *
 * The first is on a QUANTITATIVE TRADING application, where "backtested" is the precise term a
 * screener looks for. Those verbs are admitted now (resumeValidate note 4), which is the real fix;
 * this is the backstop for the next one nobody has noticed yet.
 *
 * WHY IT IS THIS NARROW, and the first version was not. That one restored the student's sentence
 * whenever the generated bullet was a near-copy by content overlap, which reverted far more than
 * verbs. The prompt asks the model, deliberately, to "copy the JD's exact multi-word terminology
 * into the bullet" when the student's evidence supports the same idea - that is keyword alignment
 * the resume is supposed to do. Measured against the broad rule, all of these were thrown away:
 *
 *   "Kafka consumer"    -> "Kafka streaming pipeline"     reverted
 *   "query time 60%"    -> "query latency 60%"            reverted
 *   "React dashboard"   -> "React analytics dashboard"    reverted
 *
 * So the rule is now exactly the failure that was observed: the opening word differs and EVERY
 * OTHER WORD IS IDENTICAL. A bullet whose body the model changed is a bullet the model was doing
 * its job on, and it is left alone.
 */
export function keepStudentWording(
  bullet: string,
  sourceBullets: readonly string[],
  /* THE GATE THE RESTORED OPENER STILL HAS TO PASS. Leaving it out broke every build on the first
     production run of this: the model paraphrases weak openers precisely to satisfy the validator,
     so putting the student's verb back put a REJECTED verb back and the whole resume was refused
     with `resume_quality_hold`. A student whose opener is genuinely weak keeps the rewrite, because
     a bullet nobody can attach helps no one. */
  passesGate: (candidate: string) => boolean = () => true,
): string {
  const generated = bullet.trim().split(/\s+/);
  if (generated.length < 2) return bullet;
  const body = (words: string[]) => words.slice(1).join(' ').toLowerCase();
  const generatedBody = body(generated);

  for (const candidate of sourceBullets) {
    const source = candidate.trim().split(/\s+/);
    if (source.length !== generated.length) continue;
    if (body(source) !== generatedBody) continue;
    // Same sentence, different first word. Nothing else about the bullet is in question.
    if (source[0].toLowerCase() === generated[0].toLowerCase()) return bullet;
    return passesGate(candidate) ? candidate : bullet;
  }
  return bullet;
}

/** Deterministic backstop for the three-bullet contract. */
export function enforceExperienceBulletFloor(
  spec: ResumeSpec,
  bank: ExperienceBankEntry[],
  options: {
    priorityEntryId?: string | null;
    allowSparsePriority?: boolean;
    /* NAMES WHAT WAS LEFT OFF, and why, so a dropped job is told rather than silently gone.
     *
     * An entry below the floor used to disappear with nothing said about it. The student read a
     * resume showing one job when they had handed over two, and the only signal was its absence.
     * Whatever the floor is, the honest behaviour when something falls under it is to say so and
     * to say what would fix it, which is one more bullet on that entry. */
    onDropped?: (entry: { org: string; bullets: number }) => void;
  } = {},
): ResumeSpec {
  const experience = spec.experience.flatMap((entry) => {
    const source = matchingBankEntry(entry, bank);
    const variants = (Array.isArray(source?.bullet_variants) ? source.bullet_variants : [])
      .filter((bullet): bullet is string => typeof bullet === 'string' && bullet.trim().length > 0)
      .map((bullet) => bullet.trim());
    const bullets = [...entry.bullets];
    const normalized = new Set(bullets.map((bullet) => bullet.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()));
    for (const variant of variants) {
      if (bullets.length >= RESUME_CONTENT_LIMITS.minBulletsPerEntry) break;
      const key = variant.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || normalized.has(key)) continue;
      normalized.add(key);
      bullets.push(variant);
    }
    const sparsePriority = Boolean(
      options.allowSparsePriority && source?.id && source.id === options.priorityEntryId,
    );
    if (bullets.length < RESUME_CONTENT_LIMITS.minBulletsPerEntry && !sparsePriority) {
      options.onDropped?.({ org: entry.org, bullets: bullets.length });
      return [];
    }
    return [{ ...entry, bullets: bullets.slice(0, RESUME_CONTENT_LIMITS.maxBulletsPerEntry) }];
  });
  return { ...spec, experience };
}

function metricCount(text: string): number {
  return text.match(/(?:\$|%|\b\d+(?:\.\d+)?x?\b)/g)?.length ?? 0;
}

export function relevanceScore(text: string, jdText: string): number {
  return overlapScore(text, jdText) * 5 + Math.min(metricCount(text), 3) * 2 + Math.min(tokens(text).size, 20) / 20;
}

export function applyResumePolicy(
  rawSpec: ResumeSpec,
  education: CandidateEducation,
  bank: ExperienceBankEntry[],
  _jdText: string,
  options: { now?: Date; targetRole?: string } = {},
): { spec: ResumeSpec; context: CandidateContext } {
  const context = deriveCandidateContext(education, options.now ?? new Date());
  const sourceCoursework = (education.coursework ?? []).map((course) => course.trim()).filter(Boolean);

  /* The model receives the JD in its original order and selects evidence in that same priority
     order. Preserve that ordering here. Re-sorting against the whole JD can let a later,
     keyword-dense requirement displace evidence for the first stated responsibility.

     STILL TRUE, AND MEASURED RATHER THAN ASSUMED. Ranking the entries by token overlap against the
     posting was tried over 85 production packets before the leadAlignment work and it is worse than
     what the model does unaided: it led a Test Automation Engineer posting with a Program
     Management internship on the shared words "intern", "through" and "system". The fix for a lead
     entry chosen by habit is not arithmetic applied after the fact, it is making the model state
     and defend the choice - see engine/leadAlignment.ts. This function stays deferential on
     purpose. */
  const experience = rawSpec.experience
    .map((entry) => {
      const source = matchingBankEntry(entry, bank);
      /* The student's own phrasings for THIS entry, so a paraphrase can be put back. Scoped to the
         matched bank row rather than the whole bank: restoring one job's sentence onto another
         job's bullet would be a factual error, not a wording one. */
      const ownWording = (Array.isArray(source?.bullet_variants) ? source.bullet_variants : [])
        .filter((variant): variant is string => typeof variant === 'string' && variant.trim().length > 0)
        .map((variant) => variant.trim());
      const seen = new Set<string>();
      const bullets = entry.bullets
        .map((bullet) => bullet.trim())
        .map((bullet) =>
          ownWording.length > 0 ? keepStudentWording(bullet, ownWording, startsWithStrongVerb) : bullet,
        )
        .filter((bullet) => bullet.length > 0)
        .filter((bullet) => {
          const key = bullet.toLowerCase().replace(/\s+/g, ' ');
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .slice(0, RESUME_CONTENT_LIMITS.maxBulletsPerEntry);
      const type = (source?.type === 'project' || source?.type === 'leadership' ? source.type : 'job') as
        | 'job'
        | 'project'
        | 'leadership';
      return {
        ...entry,
        type,
        /* From the BANK, exactly like `type` above and for the same reason: the model is never the
           source of a fact about where the student worked. It selects and phrases evidence, it does
           not author the record.

           NO SEPARATE GATE ANY MORE, and that is the point of the change rather than a relaxation
           of the rule. This used to demand exact name equality, because orgScore could not be
           trusted with a factual claim - it scored "Company 1" against "Company 2" at a perfect
           1.0. Now that identity matching is real, matchingBankEntry has ALREADY refused anything
           below SAME_EMPLOYER_SCORE, so a `source` in hand is one that cleared the same bar this
           check would re-apply. Exact equality was costing the honest case instead: the model
           writes "Traeco" for a row reading "Traeco - AI Agent Cost Infrastructure", and the city
           silently vanished from a resume for a spelling difference. */
        location: source?.location ?? '',
        bullets,
      };
    })
    .slice(0, RESUME_CONTENT_LIMITS.maxEntries);

  return {
    context,
    spec: normalizeDashesForPrint({
      ...rawSpec,
      target_role: options.targetRole ? resumeSafeTargetRole(options.targetRole) : rawSpec.target_role,
      school: education.school?.trim() ?? '',
      degree: education.degree?.trim() ?? '',
      grad_date: education.grad_date?.trim() ?? '',
      /* Comes from the profile, exactly like school and degree, and never from the model. The
         education block is student-owned facts throughout: nothing in it is the LLM's to write. */
      gpa: educationGpaLine(education),
      school_location: education.school_location?.trim() ?? '',
      /* EVERY course on record, in the order the student recorded them. Whatever the model wrote
         for "coursework" is discarded here, exactly like school, degree and GPA above.
         DELIBERATELY NOT TAILORED, recorded because it looks like a bug when measured: across 85
         production packets for one applicant this line held exactly ONE value, while the skills
         line held 77. The difference is not an oversight in the coursework path, it is the
         education block being student-owned facts and the skills line being a selection.
         Note that the grounding rule would ALLOW a JD-relevant subset - courseworkIsUngrounded
         accepts any subset of the recorded courses and only rejects a course never recorded, and
         coursework.test.ts pins that. So selecting here would be safe if the product ever wants
         it. It is a product decision about whether the education block is a record or an argument,
         not a defect to be fixed in passing, and today it is a record. */
      coursework: sourceCoursework.join(', '),
      education_position: context.education_position,
      experience,
    }),
  };
}

/* The zero-em-dash rule, made true rather than merely checked.
 *
 * The spec-level check tests a `allText` join that never included `date_range`, so an em dash in
 * "Sept. 2019 — Present" passed every content check and reached the rendered PDF, where the
 * post-render ATS gate caught it and refused to save the resume. Found 2026-07-27 by running the
 * gate over a WVU criminal-justice resume: the build failed on a punctuation character in a date.
 *
 * Reporting was never the right instrument here. An em dash is not a judgement call the model
 * should get a second attempt at, it is a character we do not print, and the substitution is
 * mechanical. So it is DONE deterministically, in the one pass both the base and tailored paths
 * run, which is also the only place that can guarantee it for every field including the ones a
 * later validator forgets to look at.
 *
 * En dashes go too. They are the same typographic family, they arrive from the same place (a model
 * writing a date range), and PDF extraction treats them the same way.
 *
 * NAMED apart from grounding.ts's stripEmDashes on purpose. That one substitutes ", " and feeds the
 * cover-letter and application-answer paths; this one substitutes " - " because it is fixing date
 * ranges on a printed page. Two exports with one name and different output is a trap. */
export function normalizeDashesForPrint<T>(value: T): T {
  if (typeof value === 'string') return value.replace(/\s*[—–]\s*/g, ' - ') as unknown as T;
  if (Array.isArray(value)) return value.map((v) => normalizeDashesForPrint(v)) as unknown as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, normalizeDashesForPrint(v)]),
    ) as T;
  }
  return value;
}
