/**
 * Can this student actually hold this role, given when they graduate.
 *
 * SEPARATE FROM MATCHING, and the distinction is the whole point. A match score answers "how well
 * does this person fit"; this answers "is this person allowed". A 95% match on an internship that
 * requires enrollment through a term the student has already left is not a good recommendation
 * with a caveat, it is a role they cannot take.
 *
 * DETERMINISTIC, because it has to run over the whole board. The clause judge in clauseMatch.ts is
 * a model call per posting: right for the handful a student opens, impossible for the thousands
 * ranking touches on every request. Nothing here calls a model. The two layers answer different
 * questions and the judged one still wins where it applies, because an employer who WROTE a rule
 * knows their own rule better than arithmetic does.
 *
 * CONSERVATIVE BY CONSTRUCTION, because the product hard-filters on this verdict with no way for a
 * student to see what was hidden. A false INELIGIBLE is invisible and therefore unreportable: the
 * role simply never appears and nobody can tell it was wrong. So `ineligible` is only returned for
 * the case that admits no reading, and everything softer is `unknown`, which never gates. See
 * decide() for exactly where that line sits.
 */

/** Months since year 0. Month precision, because terms are months and years are too coarse. */
type Point = number;
const point = (year: number, month1to12: number): Point => year * 12 + (month1to12 - 1);
export const pointOf = (year: number, month: number) => point(year, month);

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** A term as the months it actually runs. Ends are inclusive. */
export interface Term { label: string; start: Point; end: Point }

/* Northern-hemisphere academic calendar, which is what the board is. These are deliberately WIDE:
   every month added to a term makes the gate harder to trip, and under a hard filter the failure
   we can afford is showing a role we should not, never hiding one we should. */
const SEASONS: Record<string, { startMonth: number; endMonth: number; endsNextYear?: boolean }> = {
  spring: { startMonth: 1, endMonth: 5 },
  summer: { startMonth: 5, endMonth: 9 },
  fall:   { startMonth: 8, endMonth: 12 },
  autumn: { startMonth: 8, endMonth: 12 },
  winter: { startMonth: 12, endMonth: 3, endsNextYear: true },
};

const SEASON_YEAR = new RegExp(
  `\\b(${Object.keys(SEASONS).join('|')})\\s*(?:of\\s*)?((?:19|20)\\d{2})\\b`,
  'i',
);

/**
 * The term a posting is FOR, read from its title first and its body only as a fallback.
 *
 * Title first because a title is about this posting and a description is about everything: job
 * bodies mention "since summer 2019", other programmes, and application deadlines, any of which
 * would otherwise be read as the term and, under a hard filter, hide a real role. A title says
 * "Software Engineer Intern, Summer 2027" and means it.
 */
export function parseTerm(title: string, description?: string | null): Term | null {
  for (const source of [title, description ?? '']) {
    const all = [...source.matchAll(new RegExp(SEASON_YEAR, 'gi'))];
    if (all.length === 0) continue;

    /* TWO TERMS IN ONE TITLE IS NOT A TERM, it is a question.
       Taking the first match is a coin flip on which one the posting is FOR:
       "Intern (Fall 2026 cohort, Summer 2027 start)" is a Summer 2027 role that reads as Fall 2026.
       Guessing wrong in one direction merely fails to block, which is survivable. Guessing wrong in
       the other - picking a term that starts LATER than the real one - blocks a student who is
       eligible, and this gate hides with nothing on screen to say so. Unknown is the only honest
       answer when the title names two, and it never blocks. */
    const distinct = new Set(all.map((m) => `${m[1].toLowerCase()} ${m[2]}`));
    if (distinct.size > 1) continue;

    const m = all[0];
    const season = m[1].toLowerCase();
    const year = Number(m[2]);
    const s = SEASONS[season];
    if (!s) continue;
    return {
      label: `${season[0].toUpperCase()}${season.slice(1)} ${year}`,
      start: point(year, s.startMonth),
      end: point(s.endsNextYear ? year + 1 : year, s.endMonth),
    };
  }
  return null;
}

/** The student's graduation, as a month. Accepts the formats the parser and the forms produce. */
export function parseGraduation(raw: string | null | undefined): Point | null {
  const s = (raw ?? '').trim();
  if (!s) return null;

  // "May 2027", "Dec. 2027"
  const named = s.match(new RegExp(`\\b(${Object.keys(MONTHS).join('|')})[a-z]*\\.?\\s*((?:19|20)\\d{2})\\b`, 'i'));
  if (named) return point(Number(named[2]), MONTHS[named[1].toLowerCase()]);

  // "2027-05", "05/2027", "5/2027"
  const iso = s.match(/\b((?:19|20)\d{2})[-/](\d{1,2})\b/);
  if (iso && Number(iso[2]) >= 1 && Number(iso[2]) <= 12) return point(Number(iso[1]), Number(iso[2]));
  const slash = s.match(/\b(\d{1,2})[-/]((?:19|20)\d{2})\b/);
  if (slash && Number(slash[1]) >= 1 && Number(slash[1]) <= 12) return point(Number(slash[2]), Number(slash[1]));

  /* A BARE YEAR IS ITS LAST MONTH, not its first.
     submissionEducationGuard builds grad_date from grad_year, so "2027" is a real stored value for
     real students. Read as January it would make every one of them look like they finished a term
     earlier than they did, and under a hard filter that hides spring internships from people who
     can do them. December is the reading that cannot over-hide. */
  const bare = s.match(/\b((?:19|20)\d{2})\b/);
  if (bare) return point(Number(bare[1]), 12);
  return null;
}

export type RoleClass = 'internship' | 'new-grad' | 'experienced' | 'unknown';

const INTERN = /(^|\W)(intern|internship|co-?op|trainee|placement year|industrial placement)(\W|$)/i;
const NEW_GRAD = /(^|\W)(new ?grad(uate)?|graduate (programme|program|scheme|analyst|developer|engineer)|campus hire|entry[- ]level|early career)(\W|$)/i;

/** What kind of role this is, from the title and the employer's own type field. */
export function classifyRole(title: string, employmentType?: string | null): RoleClass {
  const t = `${title} ${employmentType ?? ''}`;
  if (INTERN.test(t)) return 'internship';
  if (NEW_GRAD.test(t)) return 'new-grad';
  return 'unknown';
}

export type Verdict = 'eligible' | 'ineligible' | 'unknown';
export interface Eligibility { verdict: Verdict; reason: string }

const ok = (reason: string): Eligibility => ({ verdict: 'eligible', reason });
const no = (reason: string): Eligibility => ({ verdict: 'ineligible', reason });
const dunno = (reason: string): Eligibility => ({ verdict: 'unknown', reason });

/** How long after graduating a new-grad programme still wants you. */
export const NEW_GRAD_WINDOW_MONTHS = 18;

/**
 * The verdict.
 *
 * THE ONLY `ineligible` IS "ALREADY GRADUATED BEFORE IT STARTS", and that narrowness is deliberate.
 * An internship needs an enrolled student, so someone whose degree ended before the term opened
 * cannot hold it under any employer's reading - there is no policy, no exception and no phrasing
 * that makes a person un-graduate. That case is safe to hide silently.
 *
 * The tempting second rule, "graduates during the term, so they are not returning to school", is
 * NOT applied. It is the common employer preference, not a universal one: plenty of postings take
 * graduating seniors for their final summer, and some are written for exactly them. Hard-filtering
 * on a preference would delete a student's most relevant season - the summer before they graduate -
 * with no way for them to discover it. That case is `unknown` here and belongs to the clause judge,
 * which can read what this particular employer actually said.
 */
export function decide(
  role: { title: string; employment_type?: string | null; description?: string | null },
  gradDate: string | null | undefined,
): Eligibility {
  const grad = parseGraduation(gradDate);
  if (grad === null) return dunno('no graduation date on file');

  const kind = classifyRole(role.title, role.employment_type);
  if (kind === 'unknown') return dunno('not an internship or new-grad posting');

  const term = parseTerm(role.title, role.description);

  if (kind === 'internship') {
    if (!term) return dunno('the posting does not state a term');
    if (grad < term.start) {
      return no(`graduates before ${term.label} begins, so cannot be an enrolled student in it`);
    }
    if (grad <= term.end) return dunno(`graduates during ${term.label}`);
    return ok(`still enrolled through ${term.label}`);
  }

  // new-grad: the programme is for people finishing around now, not years ago.
  if (!term) return dunno('the posting does not state a start');
  if (grad > term.end) return dunno(`graduates after ${term.label} starts`);
  if (term.start - grad > NEW_GRAD_WINDOW_MONTHS) {
    return no(`graduated more than ${NEW_GRAD_WINDOW_MONTHS} months before ${term.label}`);
  }
  return ok(`graduates within the ${term.label} intake window`);
}

/** The gate the board and autopilot both use. Only a definite no is a no. */
export function isBlocked(e: Eligibility): boolean {
  return e.verdict === 'ineligible';
}
