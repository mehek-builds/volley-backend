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

  /* Education leads the page when the candidate is enrolled, RECENTLY graduated, or when we
   * genuinely cannot tell. Only a clearly-finished, not-recent degree drops below experience.
   *
   * The unknown case is the one that matters and it used to fall the wrong way. parse.ts sets
   * currently_enrolled true "only when the resume explicitly says expected graduation, candidate,
   * current student", so false means "no explicit evidence", NOT "this person has graduated" -
   * and the old rule read that silence as graduated. Measured on five real sample resumes
   * (2026-07-27), four were current students and three of them had education pushed below
   * experience, because their resumes print a placeholder or bare graduation date with no
   * "Expected". For a product whose users are students and new grads, silence should resolve
   * toward student: being wrong that way costs a slightly unusual ordering, being wrong the other
   * way buries the single most relevant fact about the candidate.
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
  const educationLeads =
    hasEducation && (currentlyEnrolled || recentGraduate || !hasGraduationEvidence);

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
  return bank
    .map((source) => ({ source, score: orgScore(entry.org, source.org) }))
    .filter(({ score }) => score >= 0.5)
    .sort((a, b) => b.score - a.score || b.source.org.length - a.source.org.length)[0]?.source;
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
