/**
 * TOTAL PROFESSIONAL TENURE, from the dated roles on the applicant's own resume and from nothing
 * else, and the employer's own band for it.
 *
 * WHY THIS EXISTS. "Years of experience" is a select on Personio, Recruitee and Workable forms
 * (measured live 2026-09-02 on xolife, packet 29c73b37: "years of experience years_of_experience
 * field-years_of_experience", a select of bands). The profile holds no such number, and asking the
 * applicant for one is the wrong answer under the answering law: the resume already carries every
 * dated role, so the figure is ARITHMETIC on stored facts, the same class of answer as the age
 * attestation (see ageAttestationAnswer in questionDiscovery.ts), and it is refused in the same way
 * when the facts are missing.
 *
 * WHAT COUNTS. Entries from the parsed resume's `experience` array and the experience bank's `job`
 * rows - employment, including internships. Projects and leadership are not employment (the
 * experience-bank note in questionDiscovery.ts says so in as many words) and are never read here.
 *
 * HOW IT IS COUNTED, and every choice is the conservative one:
 *   - month granularity, because that is the precision a resume prints;
 *   - EXCLUSIVE month difference (Feb 2025 to May 2025 is 3 months, not 4), so a single-month role
 *     contributes nothing and a boundary never rounds the applicant UP into a higher band;
 *   - overlapping roles are merged before summing, so two concurrent jobs are one span of time
 *     rather than double the experience;
 *   - a dated entry whose date cannot be read makes the WHOLE total null. Skipping it would
 *     understate silently, and an understated figure is still a figure Litos put in her name; the
 *     honest reading of "there is a date here I could not parse" is "I do not know the total".
 *
 * THIS FILE HAS NO IMPORTS ON PURPOSE, for the reason optionBand.ts gives: questionDiscovery.ts
 * needs it, applicationProfileLike.ts needs it, and a leaf is the only module both can reach.
 */

/** One dated role, as the resume or the bank stored it. Either field may be missing or free text. */
export type ExperiencePeriod = {
  start?: string | null;
  end?: string | null;
  /** The bank's single "Feb 2026 - Present" column, read only when start/end are absent. */
  date_range?: string | null;
  /**
   * The role's own title, and the role's bullets or summary joined into one string.
   *
   * READ BY EXACTLY ONE THING, experienceEvidencing, and only to decide whether a dated role is
   * evidence for a NAMED SKILL. Neither field is a date and neither may ever reach the arithmetic:
   * totalExperienceMonths does not look at them, so adding them cannot move any total that exists
   * today. They are on this type rather than in a second parallel array because the skill and the
   * span have to travel together, and splitting them is how the two would drift out of alignment.
   */
  title?: string | null;
  description?: string | null;
};

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const PRESENT = /^\s*(?:present|current(?:ly)?|now|ongoing|today|to\s+date|till\s+date)\s*\.?\s*$/i;

function monthIndex(name: string): number | undefined {
  const normalized = name.trim().toLowerCase().replace(/\.$/, '');
  if (normalized.length < 3) return undefined;
  const index = MONTHS.findIndex((month) => month === normalized || month.startsWith(normalized));
  // "sept" is the one common abbreviation longer than the prefix rule needs.
  return index < 0 ? undefined : index;
}

/**
 * A month on the calendar as a single integer (year * 12 + month), or 'present', or undefined.
 *
 * Accepts the shapes resumes print and parsers emit: "Feb 2026", "February 2026", "Sept. 2024",
 * "02/2026", "2026-02", "2026-02-15", "2026". A bare year reads as January of that year for a
 * START and December for an END (see readPeriod), which is the reading that understates a span.
 */
export function readTenureMonth(raw: string | null | undefined): number | 'present' | { year: number } | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (PRESENT.test(value)) return 'present';
  let match = /^([A-Za-z]{3,9})\.?\s+((?:19|20)\d{2})$/.exec(value);
  if (match) {
    const month = monthIndex(match[1]);
    return month === undefined ? undefined : Number(match[2]) * 12 + month;
  }
  match = /^((?:19|20)\d{2})-(\d{1,2})(?:-\d{1,2})?$/.exec(value);
  if (match) {
    const month = Number(match[2]);
    return month >= 1 && month <= 12 ? Number(match[1]) * 12 + (month - 1) : undefined;
  }
  match = /^(\d{1,2})\/((?:19|20)\d{2})$/.exec(value);
  if (match) {
    const month = Number(match[1]);
    return month >= 1 && month <= 12 ? Number(match[2]) * 12 + (month - 1) : undefined;
  }
  match = /^((?:19|20)\d{2})$/.exec(value);
  if (match) return { year: Number(match[1]) };
  return undefined;
}

const RANGE_SEPARATOR = /\s*(?:[-‐-―]|\bto\b|\bthrough\b|\buntil\b)\s*/i;

type Span = { from: number; to: number };

/** The dated span of one entry, null when it is unreadable, undefined when it carries no date. */
function readPeriod(entry: ExperiencePeriod, asOfMonth: number): Span | null | undefined {
  let startText = entry.start?.trim() || undefined;
  let endText = entry.end?.trim() || undefined;
  if (!startText && !endText) {
    const range = entry.date_range?.trim();
    if (!range) return undefined;
    const parts = range.split(RANGE_SEPARATOR).map((part) => part.trim()).filter(Boolean);
    if (parts.length === 1) {
      // "Summer 2025" and other single tokens are not a span this file can read.
      startText = parts[0];
      endText = parts[0];
    } else if (parts.length === 2) {
      [startText, endText] = parts;
    } else {
      return null;
    }
  }
  if (!startText) return null;
  /* AN EMPTY END IS UNKNOWN, NOT "PRESENT". The local parser writes end: '' for a line with one
   * readable date and no "present" ("Feb 2025", "Feb 2025 - Spring 2025"), and reading that as
   * ongoing counted a one-month role as running to today (review of PR #879, B4). Only the word
   * decides: a role is present when the resume says so. */
  if (!endText) return null;
  const start = readTenureMonth(startText);
  const end = readTenureMonth(endText);
  if (start === undefined || end === undefined || start === 'present') return null;
  /* A BARE YEAR READS AS THE SHORTEST SPAN IT CAN MEAN. A start of "2025" is December 2025 and an
   * end of "2024" is January 2024, so a "2023 - 2024" role counts one month, never twenty-three:
   * the total may understate her tenure and may never overstate it (B3). */
  const from = typeof start === 'number' ? start : start.year * 12 + 11;
  let to = end === 'present'
    ? asOfMonth
    : typeof end === 'number' ? end : end.year * 12;
  /* Two bare years that read December-to-January of the same or adjacent years are a span the
   * resume states but this file cannot bound: it contributes nothing, and it does not poison the
   * total the way an unreadable date does. */
  if (typeof start !== 'number' && end !== 'present' && typeof end !== 'number' && to < from) to = from;
  if (to < from) return null;
  return { from, to };
}

/**
 * Total employment in whole months across every dated entry, merged so concurrent roles are not
 * counted twice. null when there is no dated entry at all, and null when any dated entry cannot be
 * read - both refuse downstream, on purpose.
 */
export function totalExperienceMonths(
  entries: readonly ExperiencePeriod[] | null | undefined,
  asOf: Date,
): number | null {
  if (!entries || entries.length === 0) return null;
  const asOfMonth = asOf.getUTCFullYear() * 12 + asOf.getUTCMonth();
  const spans: Span[] = [];
  for (const entry of entries) {
    const span = readPeriod(entry, asOfMonth);
    if (span === null) return null;
    if (span === undefined) continue;
    // A role that starts after today is a plan, not experience.
    if (span.from > asOfMonth) continue;
    spans.push({ from: span.from, to: Math.min(span.to, asOfMonth) });
  }
  if (spans.length === 0) return null;
  spans.sort((a, b) => a.from - b.from);
  let total = 0;
  let current = { ...spans[0] };
  for (const span of spans.slice(1)) {
    if (span.from <= current.to) {
      current.to = Math.max(current.to, span.to);
    } else {
      total += current.to - current.from;
      current = { ...span };
    }
  }
  total += current.to - current.from;
  return total;
}

/* ---- the same arithmetic, scoped to ONE NAMED SKILL ---- */

/*
 * WHY A SECOND ENTRY POINT RATHER THAN A WIDER FIRST ONE. "How many years of hands on experience
 * do you have with X" is not the question totalExperienceMonths answers, and answering it from the
 * total is the exact substitution this whole family exists to prevent: it hands an employer a
 * figure about her whole career in reply to a question about one tool. So the scoping is applied
 * by SELECTING ENTRIES, and the surviving subset then goes through totalExperienceMonths unchanged.
 * Every guarantee that function documents - month granularity, exclusive differences, merged
 * overlaps, and a single unreadable date poisoning the whole total - is therefore the same
 * guarantee here, because it is literally the same code. Nothing about the counting is re-decided.
 *
 * WHAT COUNTS AS EVIDENCE, and this is the one judgement in the file. A dated role evidences a
 * skill when the role's own title or its own bullets NAME that skill. That is the applicant's
 * writing about that role, so it is her claim that she worked with the thing during it, and it is
 * the same reading a human gives a resume. The alternative readings were both rejected:
 *   - the skills LIST alone is not evidence. It carries no dates, so it can place a skill on the
 *     profile and can never place it in time. A question about duration cannot be answered from it.
 *   - the whole tenure, filtered by nothing, is not evidence. See the paragraph above.
 * The residual risk is a bullet that names a skill in passing ("migrated a Python service to Go"),
 * which counts that role's whole span. It is accepted knowingly: the answer is a coarse band, every
 * step of the arithmetic underneath rounds down, and the alternative is refusing every question in
 * this family. It is written here so the next reader is deciding it again rather than discovering it.
 */

/** Regex-escape, local because this file has no imports on purpose (see the header). */
function escapeForPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Does `text` name `skill` as a whole term?
 *
 * The boundary is written as alphanumeric lookaround rather than `\b`, because the skills that
 * matter here are not all word characters: `\b` after the "+" of "C++" requires a word character
 * and so never matches, and `\b` around "Node.js" splits at the dot. Alphanumeric lookaround gets
 * both right, and it keeps the refusals that matter: "React" does not match inside "Reactive", and
 * "SQL" does not match inside "PostgreSQL" (a Postgres question is not answered from SQL evidence).
 * Internal whitespace is relaxed so a two-word skill ("AI agents") matches however the text spaces it.
 */
export function skillNamedIn(text: string | null | undefined, skill: string): boolean {
  const haystack = text?.trim();
  const needle = skill?.trim();
  /* TWO CHARACTERS MINIMUM. "C" and "R" are real languages and are also single letters that occur
   * all over ordinary prose and inside provider handles; a one-letter scope match would be noise
   * with the authority of a measurement. They are refused rather than guessed at. */
  if (!haystack || !needle || needle.length < 2) return false;
  const pattern = needle.split(/\s+/).map(escapeForPattern).join('\\s+');
  return new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, 'i').test(haystack);
}

/** The dated roles whose own title or bullets name this skill. */
export function experienceEvidencing(
  entries: readonly ExperiencePeriod[] | null | undefined,
  skill: string,
): ExperiencePeriod[] {
  if (!entries) return [];
  return entries.filter((entry) => skillNamedIn(entry.title, skill) || skillNamedIn(entry.description, skill));
}

/**
 * Whole months of dated employment that evidences one named skill, or null.
 *
 * null for every way this cannot be answered, and every one of them is a refusal downstream rather
 * than a zero: no dated roles on file at all, no dated role that names the skill, a matching role
 * whose date cannot be read (totalExperienceMonths' own poison rule), and a matching set that sums
 * to nothing readable. "No role mentions it" is emphatically NOT zero years of experience with the
 * thing - it is Litos having no dated evidence either way, and stating zero would be a claim about
 * her that her resume does not make.
 *
 * THE EMPTY-SUBSET CASE IS NOT GUARDED HERE, DELIBERATELY. An explicit `evidencing.length === 0`
 * check was written first and then removed: totalExperienceMonths already refuses an empty list on
 * its first line, so the check could not change any result, and a mutation run confirmed deleting
 * it moved nothing. A second copy of a rule that cannot be observed is not a safety net, it is the
 * seam two copies of the same rule drift apart along. "No role names this skill" therefore refuses
 * through exactly the same line as "no dated role on file", which is the point: they are the same
 * finding, and they cannot come to disagree.
 */
export function skillScopedExperienceMonths(
  entries: readonly ExperiencePeriod[] | null | undefined,
  skill: string,
  asOf: Date,
): number | null {
  return totalExperienceMonths(experienceEvidencing(entries, skill), asOf);
}

/**
 * The ONE skill from the applicant's own skills list that this label names.
 *
 * The scope is read by matching the label against HER vocabulary, never by parsing the sentence.
 * That inversion is the safety property: the function never has to understand "hands on experience
 * do you have with", it only has to answer "does this question name something she has listed". A
 * question about a skill she has not listed therefore returns null and is left for her, which is
 * the correct outcome and needs no extra rule.
 *
 * TWO DISTINCT SKILLS IS AMBIGUOUS, NOT AN ANSWER. "years of experience with Python and Kubernetes"
 * wants an intersection; "with Python or Java" wants a union; the two read the same to a matcher and
 * differ by years. Reported as `ambiguous` so the caller can hand it back with a reason instead of
 * silently answering one half of it. Overlapping matches are NOT two skills: "React Native" also
 * matches the listed skill "React", so matches whose spans touch are collapsed and the longest,
 * most specific one wins.
 */
export type NamedSkillScope = { skill: string } | { ambiguous: string[] } | null;

export function namedProfileSkill(
  label: string,
  skills: readonly string[] | null | undefined,
): NamedSkillScope {
  const text = label?.trim();
  if (!text || !skills) return null;
  type Hit = { skill: string; start: number; end: number };
  const hits: Hit[] = [];
  const seen = new Set<string>();
  for (const raw of skills) {
    const skill = typeof raw === 'string' ? raw.trim() : '';
    if (!skill || skill.length < 2) continue;
    const key = skill.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!skillNamedIn(text, skill)) continue;
    const pattern = skill.split(/\s+/).map(escapeForPattern).join('\\s+');
    const match = new RegExp(`(?<![A-Za-z0-9])${pattern}(?![A-Za-z0-9])`, 'i').exec(text);
    if (match) hits.push({ skill, start: match.index, end: match.index + match[0].length });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const groups: Hit[][] = [];
  for (const hit of hits) {
    const group = groups[groups.length - 1];
    if (group && hit.start < group[group.length - 1].end) group.push(hit);
    else groups.push([hit]);
  }
  if (groups.length > 1) return { ambiguous: groups.map((group) => group[0].skill) };
  return { skill: groups[0].reduce((best, hit) => (hit.end - hit.start > best.end - best.start ? hit : best)).skill };
}

/* ---- the employer's bands ---- */

const WORD_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20,
};

type Band = { option: string; minMonths: number; maxMonths: number; open: boolean };

function numberToken(raw: string): number | undefined {
  const value = raw.trim().toLowerCase();
  if (value in WORD_NUMBERS) return WORD_NUMBERS[value];
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

const NUMBER = String.raw`(\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty)`;
const UNIT = String.raw`\s*(years?|yrs?|months?|mos?)\b`;

function unitMonths(unit: string | undefined, value: number): number {
  return /^mo/i.test(unit ?? '') ? value : value * 12;
}

/**
 * The band one option describes, in months, or null for an option that is not a band.
 *
 * "less than 1 year" is [0, 12). "1-2 years" is [12, 36): the integer bucket "1 to 2" runs up to
 * the day the third year begins, exactly as an employer means it, and chooseExperienceBand trims
 * that top edge back to the next band's floor when the list is contiguous ("1-2", "2-5"). "5+
 * years", "more than 5 years" and "5 years or more" are [60, open). A bare "2 years" is the bucket
 * [24, 36). "None", "Student", "Entry level" and every other wording without a number are null and
 * are never chosen: an option with no figure is not a claim this arithmetic can support.
 */
export function readExperienceBand(option: string): Omit<Band, 'option'> | null {
  const text = option.trim().toLowerCase().replace(/[()]/g, ' ').replace(/\s+/g, ' ');
  let match: RegExpExecArray | null;

  // "less than 1 year", "under 2 years", "up to 6 months", "< 1 year", "fewer than one year"
  match = new RegExp(String.raw`^(?:less than|fewer than|under|below|up to|<)\s*${NUMBER}${UNIT}`, 'i').exec(text);
  if (match) {
    const value = numberToken(match[1]);
    if (value === undefined) return null;
    return { minMonths: 0, maxMonths: unitMonths(match[2], value), open: false };
  }
  // "1-2 years", "1 to 2 years", "between 1 and 2 years", "6 - 12 months"
  match = new RegExp(String.raw`^(?:between\s+)?${NUMBER}\s*(?:years?|yrs?|months?|mos?)?\s*(?:[-‐-―]|to|and)\s*${NUMBER}${UNIT}`, 'i').exec(text);
  if (match) {
    const low = numberToken(match[1]);
    const high = numberToken(match[2]);
    if (low === undefined || high === undefined || high < low) return null;
    const isMonths = /^mo/i.test(match[3]);
    // An integer-year bucket "1-2" includes the whole of year 2; a month bucket is exact.
    const top = isMonths ? high : (Number.isInteger(high) ? high + 1 : high);
    return { minMonths: unitMonths(match[3], low), maxMonths: unitMonths(match[3], top), open: false };
  }
  // "5+ years", "5 + years", "more than 5 years", "over 10 years", "at least 3 years", "3 years or more", "10 years and above"
  match = new RegExp(String.raw`^(?:more than|over|above|greater than|at least|minimum(?: of)?|>)\s*${NUMBER}${UNIT}`, 'i').exec(text)
    ?? new RegExp(String.raw`^${NUMBER}\s*\+${UNIT}`, 'i').exec(text)
    ?? new RegExp(String.raw`^${NUMBER}${UNIT}\s*(?:\+|or more|and (?:more|above|over)|plus)`, 'i').exec(text);
  if (match) {
    const value = numberToken(match[1]);
    if (value === undefined) return null;
    return { minMonths: unitMonths(match[2], value), maxMonths: Number.POSITIVE_INFINITY, open: true };
  }
  // "2 years", "1 year", "6 months": the bucket that begins at the figure.
  match = new RegExp(String.raw`^${NUMBER}${UNIT}\s*$`, 'i').exec(text);
  if (match) {
    const value = numberToken(match[1]);
    if (value === undefined) return null;
    const isMonths = /^mo/i.test(match[2]);
    return {
      minMonths: unitMonths(match[2], value),
      maxMonths: isMonths ? unitMonths(match[2], value) + 1 : unitMonths(match[2], value + 1),
      open: false,
    };
  }
  return null;
}

/**
 * The option whose band contains the applicant's total, verbatim, or null when none does.
 *
 * Bands are sorted by floor and each one's ceiling is trimmed to the next band's floor when that
 * floor sits inside it, so "1-2 years" beside "2-5 years" hands 2.5 years to the second and beside
 * "3-5 years" keeps it in the first. When two bands still both contain the total (a list with
 * genuine overlap), the LOWER one is chosen: it is the smaller claim.
 */
export function chooseExperienceBand(
  options: readonly string[] | null | undefined,
  totalMonths: number,
): string | null {
  if (!options) return null;
  const bands: Band[] = [];
  for (const raw of options) {
    if (typeof raw !== 'string') continue;
    const band = readExperienceBand(raw);
    if (band) bands.push({ option: raw, ...band });
  }
  if (bands.length === 0) return null;
  bands.sort((a, b) => a.minMonths - b.minMonths || a.maxMonths - b.maxMonths);
  for (let i = 0; i < bands.length; i += 1) {
    const band = bands[i];
    const next = bands[i + 1];
    const ceiling = next && next.minMonths > band.minMonths && next.minMonths < band.maxMonths
      ? next.minMonths
      : band.maxMonths;
    if (totalMonths >= band.minMonths && totalMonths < ceiling) return band.option;
  }
  return null;
}
