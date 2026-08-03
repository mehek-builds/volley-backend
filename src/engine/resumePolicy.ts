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
  /* Read from parsed_json, which is what the student's OWN resume printed, and never from
     application_profile. That column holds the same number encrypted, and a decrypt failure there
     is a deliberate hard error (see decryptRow) - correct for a route serving the profile, wrong
     for resume generation, where it would turn a key problem into "no student can generate a
     resume". The parse is also the origin for almost everyone: academicSeedFrom copies parsed ->
     application_profile, not the reverse. */
  gpa?: string;
  gpa_scale?: string;
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

function orgScore(generated: string, source: string): number {
  const a = tokens(generated);
  const b = tokens(source);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const overlap = intersection / Math.min(a.size, b.size);
  const connectors = new Set(['of', 'the', 'and', 'for', 'at', 'a', 'an', 'de', 'to']);
  const initialism = (value: string) =>
    (value.toLowerCase().match(/[a-z0-9]+/g) ?? [])
      .filter((part) => !connectors.has(part))
      .map((part) => part[0])
      .join('');
  const compactGenerated = generated.toLowerCase().replace(/[^a-z0-9]/g, '');
  const compactSource = source.toLowerCase().replace(/[^a-z0-9]/g, '');
  const acronymMatch =
    compactGenerated === initialism(source) || compactSource === initialism(generated);
  return acronymMatch ? Math.max(overlap, 1) : overlap;
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
    .filter(({ organization }) => organization >= 0.5)
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
