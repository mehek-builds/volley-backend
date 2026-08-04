import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import { RESUME_CONTENT_LIMITS } from './resumeContentPolicy';

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
const GPA_VALUE = /^\d{1,2}(?:\.\d{1,3})?$/;

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
    coursework: Array.isArray(p.coursework) ? p.coursework.filter((c): c is string => typeof c === 'string') : undefined,
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
function orgTokens(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((part) => !ORG_NOISE.has(part)));
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
  const initialism = (value: string) =>
    (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((part) => !ORG_NOISE.has(part))
      .map((part) => part[0])
      .join('');
  const compactGenerated = generated.toLowerCase().replace(/[^a-z0-9]/g, '');
  const compactSource = source.toLowerCase().replace(/[^a-z0-9]/g, '');
  const acronymMatch =
    compactGenerated === initialism(source) || compactSource === initialism(generated);
  return acronymMatch ? Math.max(overlap, 1) : overlap;
}

/* Is this the SAME employer, not merely a close one. Punctuation, spacing and case are noise ("St.
   Jude's" vs "St Judes"); everything else has to agree, including the digits and initials orgScore
   discards. Used only to gate a printed location, where a near-miss is a false factual claim rather
   than a slightly worse bullet. */
export function sameOrganization(a: string, b: string): boolean {
  const compact = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const left = compact(a);
  return left.length > 0 && left === compact(b);
}

function matchingBankEntry(entry: ResumeSpec['experience'][number], bank: ExperienceBankEntry[]) {
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
    .filter(({ organization }) => organization >= 0.8)
    .sort((a, b) => b.score - a.score || b.source.org.length - a.source.org.length)[0]?.source;
}

/** Deterministic backstop for the three-bullet contract. */
export function enforceExperienceBulletFloor(
  spec: ResumeSpec,
  bank: ExperienceBankEntry[],
  options: { priorityEntryId?: string | null; allowSparsePriority?: boolean } = {},
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
    if (bullets.length < RESUME_CONTENT_LIMITS.minBulletsPerEntry && !sparsePriority) return [];
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

  // The model receives the JD in its original order and selects evidence in that same priority
  // order. Preserve that ordering here. Re-sorting against the whole JD can let a later,
  // keyword-dense requirement displace evidence for the first stated responsibility.
  const experience = rawSpec.experience
    .map((entry) => {
      const source = matchingBankEntry(entry, bank);
      const seen = new Set<string>();
      const bullets = entry.bullets
        .map((bullet) => bullet.trim())
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

           HELD TO A HIGHER BAR THAN THE REST OF THE MATCH, deliberately. matchingBankEntry accepts
           an organisation overlap of 0.5, which is right for pulling bullets - half a name plus a
           title and a shared year is ample evidence it is the same job. It is not ample evidence
           about a CITY. "Company 1" and "Company 2" score exactly 0.5 against each other, as would
           "Bank of America" and "Bank of the West", and the cost of that near-miss is different in
           kind here: a wrong bullet is the student's own text on the wrong row, while a wrong city
           is a false statement about where they worked, printed in the one column an employer scans
           to check it. Below the bar the line simply prints no place, which is what the resume
           looked like yesterday and is never wrong.

           THE BAR IS IDENTITY, not a high score, and orgScore is the reason. tokens() drops
           single characters, so "Company 1" and "Company 2" both reduce to {company} and score a
           PERFECT 1.0 against each other - no threshold on that scale can separate them. The same
           holds for "Site 1"/"Site 2" and any pair differing only by a number or initial. Matching
           on the normalised name itself is the only test that actually answers "is this the same
           employer", which is the question a printed city depends on. */
        location: sameOrganization(entry.org, source?.org ?? '') ? source?.location ?? '' : '',
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
