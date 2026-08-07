// One profile-to-question resolution layer, shared by every submission path.
//
// WHY THIS FILE EXISTS (measured on prod packets for the owner account, 2026-08-08).
// Twenty-five packets reached `needs_attention` with blockers of the shape
//   "Discipline" is required and is still empty
//   "What is your GPA?" is required and is still empty
//   "Which University do/did you attend?" is required and is still empty
//   "What education level are you currently pursuing?" is required and is still empty
//   "Graduation Month" / "Graduation Year" is required and is still empty
//   "How did you hear about this job?" is required and is still empty
// while the stored profile held every one of those values, and, crucially, while
// `spec._review.questions` in the same row already carried the RESOLVED ANSWER
// ("3.89", "Bachelor's Degree", "Computer Science", "Company website", ...).
//
// So the resolver was never the problem. The value was resolved and then failed to reach the
// control, for four reasons, all of which this module addresses generically rather than with
// another per-employer selector list:
//
//   1. The discovered label is a CONCATENATED BLOB, not the employer's visible label.
//      Discovery joins label text + aria-label + placeholder + name + id, so Greenhouse
//      education fields arrive as "degree* degree--0" and "discipline* discipline--0", and a
//      Greenhouse array-named question arrives as "how did you first hear about five rings?* []".
//      Every managed fill for those is scoped with `label:has-text("<that blob>")`, which cannot
//      match a page whose label reads "Degree". normalizeDiscoveredLabel now strips those
//      handles (see questionDiscovery.ts), which is the single highest-value part of this fix.
//
//   2. The discovered selector is a PER-SESSION MARKER. Discovery stamps
//      `data-litos-discovered-N` on the element; the managed fill run is a second, stateless
//      browser call against a freshly loaded page where that attribute does not exist.
//      durablePortalSelector correctly refuses it, so label matching is the only path left,
//      which makes (1) fatal rather than cosmetic.
//
//   3. inputType is reported as "text" for EVERY managed-discovered control, including react
//      selects. Every branch keyed on `select`/`combobox` is therefore dead on that path.
//      Nothing here may depend on inputType being accurate.
//
//   4. Nothing ever captured the field's REAL OPTION LIST, so a closed-list control was fed a
//      free-text value that is not one of its options: the stored school is
//      "University of Southern California, Viterbi School of Engineering" while the option
//      reads "University of Southern California". This module takes the option list when the
//      caller has one and snaps the answer onto an option; when it has none, it returns a
//      ranked ladder of alias forms so the fill layer can try more than one guess.
//
// Design rules, so this does not decay back into per-employer patches:
//   - Nothing in this file may reference an employer, a job board tenant, or a posting.
//   - Every ladder is derived from the STORED VALUE plus a standard vocabulary
//     (education levels, month names, discipline families, referral sources).
//   - chooseClosestOption never returns an option on weak evidence. Leaving a field empty is
//     recoverable; selecting the wrong legal answer on a real application is not.

import {
  classifyField,
  normalizeDiscoveredLabel,
  resolveKnownAnswer,
  type ApplicationProfileLike,
  type ProfileKey,
} from './questionDiscovery';

export type ProfileFieldShape = {
  label: string;
  inputType?: string;
  /** The control's real option texts, when the caller could read them from the DOM. */
  options?: readonly string[] | null;
};

export type ResolvedProfileField = {
  /** The question intent, or null when the label resolved through a non-classified rule. */
  key: ProfileKey | null;
  /** The value to type or select. Equals one of `options` exactly when `matchedOption`. */
  value: string;
  /** Ranked alias forms, best first, for a fill layer that cannot see the option list. */
  candidates: string[];
  /** True when `value` was chosen from the option list the caller supplied. */
  matchedOption: boolean;
};

/**
 * Intents whose answer is a fact already stored on the profile. A blocker naming one of these
 * is by definition a Litos defect rather than missing user data, which is what
 * profileBackedBlockerLabels reports on.
 */
export const PROFILE_BACKED_KEYS: ReadonlySet<ProfileKey> = new Set<ProfileKey>([
  'school',
  'degree',
  'major',
  'gpa',
  'gpa_scale',
  'graduation_date',
  'graduation_month',
  'graduation_year',
  'current_enrollment',
  'study_year',
  'referral_source_default',
]);

export function isProfileBackedKey(key: ProfileKey | null | undefined): boolean {
  return !!key && PROFILE_BACKED_KEYS.has(key);
}

// ---- option comparison ----

/**
 * Comparison form for option matching. Apostrophes are DELETED rather than spaced so that
 * "Bachelor's Degree" and "Bachelors Degree" collapse to one string: portals spell that enum
 * both ways and they are the same answer.
 */
export function comparableOption(value: string): string {
  return value
    .replace(/[‘’‛ʼ']/g, '')
    .replace(/[“”]/g, '"')
    .toLowerCase()
    .replace(/[^a-z0-9.+/]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function optionTokens(value: string): string[] {
  return comparableOption(value).split(' ').filter(Boolean);
}

const PLACEHOLDER_OPTION_RE =
  /^(?:|-+|–+|select(?:\.{3}|…)?|select one|select an option|please select|choose(?: one)?|pick one|none|n\/a|--.*--)$/i;

/** Drop the "Select..." style first entry every select carries, and de-duplicate. */
export function usableOptions(options: readonly string[] | null | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of options ?? []) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || PLACEHOLDER_OPTION_RE.test(trimmed)) continue;
    const key = comparableOption(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

type NumericRange = { min: number; max: number };

/**
 * A GPA or score bucket expressed as an option. Handles "3.5 - 4.0", "3.50 to 3.74", "3.5+",
 * "Above 3.5", "3.0 or higher", "Below 3.0", and a bare "4.0".
 */
export function parseNumericRange(option: string): NumericRange | null {
  // U+2013 and U+2014 are the en and em dashes real option text uses to write a range, written as
  // escapes so no such character appears literally in this repo.
  const text = option.replace(/[\u2013\u2014]/g, '-').toLowerCase();
  const numbers = [...text.matchAll(/\b(\d+(?:\.\d+)?)\b/g)].map((match) => Number(match[1]));
  if (numbers.length === 0 || numbers.some((value) => !Number.isFinite(value))) return null;
  if (numbers.length >= 2) {
    const [first, second] = numbers;
    return { min: Math.min(first, second), max: Math.max(first, second) };
  }
  const only = numbers[0];
  if (/\+\s*$|\bor\s+(?:higher|above|greater|more)\b|\b(?:above|over|greater\s+than|at\s+least|minimum)\b/.test(text)) {
    return { min: only, max: Number.POSITIVE_INFINITY };
  }
  if (/\bor\s+(?:lower|below|less)\b|\b(?:below|under|less\s+than|at\s+most|up\s+to)\b/.test(text)) {
    return { min: Number.NEGATIVE_INFINITY, max: only };
  }
  return { min: only, max: only };
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const MONTH_TOKEN_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi;
const SEASON_MONTHS: Record<string, number[]> = {
  winter: [12, 1, 2],
  spring: [3, 4, 5],
  summer: [6, 7, 8],
  fall: [9, 10, 11],
  autumn: [9, 10, 11],
};

function monthNumber(token: string): number | null {
  const index = MONTH_NAMES.findIndex((name) => name.toLowerCase().startsWith(token.slice(0, 3).toLowerCase()));
  return index >= 0 ? index + 1 : null;
}

/** Calendar points mentioned by an option, as year*12+month ordinals. */
function optionDatePoints(option: string): { points: number[]; years: number[] } {
  const years = [...option.matchAll(/\b((?:19|20)\d{2})\b/g)].map((match) => Number(match[1]));
  const points: number[] = [];
  const monthYear = [
    ...option.matchAll(
      /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[^0-9a-z]{0,6}\b((?:19|20)\d{2})\b/gi,
    ),
  ];
  for (const match of monthYear) {
    const month = monthNumber(match[1]);
    if (month) points.push(Number(match[2]) * 12 + month);
  }
  for (const [season, months] of Object.entries(SEASON_MONTHS)) {
    const seasonal = [...option.matchAll(new RegExp(`\\b${season}\\b[^0-9]{0,6}\\b((?:19|20)\\d{2})\\b`, 'gi'))];
    for (const match of seasonal) {
      const year = Number(match[1]);
      for (const month of months) points.push(year * 12 + month);
    }
  }
  return { points, years };
}

/**
 * Does an option cover a graduation date? Handles a plain year ("2028"), a term ("Spring 2028"),
 * an exact month ("May 2028"), and a range ("January 2028 - June 2028", "2027 - 2028").
 */
export function optionCoversMonthYear(option: string, month: number, year: number): boolean {
  const target = year * 12 + month;
  const { points, years } = optionDatePoints(option);
  if (points.length >= 2) {
    const min = Math.min(...points);
    const max = Math.max(...points);
    if (target >= min && target <= max) return true;
  }
  if (points.length === 1 && points[0] === target) return true;
  const hasMonthToken = new RegExp(MONTH_TOKEN_RE.source, 'i').test(option)
    || Object.keys(SEASON_MONTHS).some((season) => new RegExp(`\\b${season}\\b`, 'i').test(option));
  if (!hasMonthToken && years.length > 0) {
    if (years.length >= 2) {
      const min = Math.min(...years);
      const max = Math.max(...years);
      return year >= min && year <= max;
    }
    return years[0] === year;
  }
  return false;
}

function numericValueOf(candidate: string): number | null {
  const match = candidate.match(/^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*\d+(?:\.\d+)?)?\s*$/);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function monthYearOf(candidate: string): { month: number; year: number } | null {
  const match = candidate.match(
    /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[^0-9a-z]{0,6}\b((?:19|20)\d{2})\b/i,
  );
  if (match) {
    const month = monthNumber(match[1]);
    if (month) return { month, year: Number(match[2]) };
  }
  const iso = candidate.match(/\b((?:19|20)\d{2})-(\d{2})\b/);
  if (iso) return { month: Number(iso[2]), year: Number(iso[1]) };
  return null;
}

/**
 * The option that best answers with one of `candidates`, or null.
 *
 * Deliberately conservative and ordered by evidence strength: an exact match beats a containment
 * match beats a token-subset match beats a numeric or calendar bucket. A candidate shorter than
 * three characters never matches by containment, because "BS" would otherwise select "Business".
 */
export function chooseClosestOption(
  candidates: readonly string[],
  rawOptions: readonly string[] | null | undefined,
): string | null {
  const options = usableOptions(rawOptions);
  if (options.length === 0) return null;
  const comparableOptions = options.map((option) => ({ option, key: comparableOption(option), tokens: optionTokens(option) }));

  for (const candidate of candidates) {
    const key = comparableOption(candidate);
    if (!key) continue;
    const exact = comparableOptions.find((entry) => entry.key === key);
    if (exact) return exact.option;
  }

  // Calendar buckets are checked BEFORE generic containment, because containment on a bare year
  // gets them wrong: given "May 2028" and the options "July 2028 - December 2028" and
  // "January 2028 - June 2028", a substring match on "2028" picks whichever bucket is listed
  // first, which is a 50/50 guess about the applicant's graduation. Range arithmetic is not.
  for (const candidate of candidates) {
    const point = monthYearOf(candidate);
    if (!point) continue;
    const bucket = comparableOptions.find((entry) => optionCoversMonthYear(entry.option, point.month, point.year));
    if (bucket) return bucket.option;
  }

  for (const candidate of candidates) {
    const key = comparableOption(candidate);
    if (key.length < 3) continue;
    const contained = comparableOptions.find((entry) =>
      entry.key === key
      || entry.key.startsWith(`${key} `)
      || entry.key.endsWith(` ${key}`)
      || entry.key.includes(` ${key} `)
      || key.startsWith(`${entry.key} `)
      || key.includes(` ${entry.key} `));
    if (contained) return contained.option;
  }

  for (const candidate of candidates) {
    const tokens = optionTokens(candidate).filter((token) => token.length >= 3);
    if (tokens.length === 0) continue;
    const subset = comparableOptions.find((entry) => tokens.every((token) => entry.tokens.includes(token)));
    if (subset) return subset.option;
  }

  for (const candidate of candidates) {
    const numeric = numericValueOf(candidate);
    if (numeric === null) continue;
    const bucket = comparableOptions.find((entry) => {
      const range = parseNumericRange(entry.option);
      return !!range && numeric >= range.min && numeric <= range.max;
    });
    if (bucket) return bucket.option;
  }

  return null;
}

// ---- alias ladders, derived from the stored value and a standard vocabulary ----

function pushUnique(out: string[], seen: Set<string>, ...values: Array<string | undefined | null>) {
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed) continue;
    const key = comparableOption(trimmed);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
}

function ladder(...values: Array<string | undefined | null>): string[] {
  const out: string[] = [];
  pushUnique(out, new Set<string>(), ...values);
  return out;
}

/**
 * "University of Southern California, Viterbi School of Engineering" is the resume's phrasing.
 * The option list carries the institution alone, so trailing school/college/campus clauses are
 * dropped, and an initialism is offered last for the portals that list "USC".
 */
export function schoolAliasLadder(school: string | undefined): string[] {
  const trimmed = school?.trim();
  if (!trimmed) return [];
  const institution = trimmed
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .find((part) => !/\b(?:school|college|campus|institute|department|division|faculty)\s+of\b/i.test(part)
      && !/^\s*(?:school|college|campus|faculty)\b/i.test(part));
  const words = (institution ?? trimmed).split(/\s+/).filter((word) => word.length > 2 && /^[A-Za-z]/.test(word));
  const initialism = words.length >= 3
    ? words
      .filter((word) => !/^(?:of|the|and|at|for|in)$/i.test(word))
      .map((word) => word[0].toUpperCase())
      .join('')
    : undefined;
  return ladder(trimmed, institution, initialism && initialism.length >= 3 ? initialism : undefined);
}

/** The standard education-level enum a closed-list "Degree" or "Education level" field offers. */
export function educationLevelLadder(degree: string | undefined): string[] {
  const trimmed = degree?.trim();
  if (!trimmed) return [];
  if (/\bph\.?d\b|doctor of philosophy|doctorate|\bdoctoral\b/i.test(trimmed)) {
    return ladder('Doctor of Philosophy (Ph.D.)', "Doctorate Degree", 'Doctorate', 'PhD', 'Ph.D.', trimmed);
  }
  if (/\bm\.?b\.?a\b/i.test(trimmed)) {
    return ladder('MBA', "Master's Degree", 'Masters Degree', "Master's", 'Graduate Degree', trimmed);
  }
  if (/\bmaster|\bm\.?s\.?\b|\bm\.?a\.?\b|\bm\.?eng\b/i.test(trimmed)) {
    return ladder("Master's Degree", 'Masters Degree', "Master's", 'Masters', 'Graduate Degree', 'Graduate', trimmed);
  }
  if (/\bbachelor|\bb\.?s\.?\b|\bb\.?a\.?\b|\bb\.?eng\b|\bundergrad/i.test(trimmed)) {
    const science = /\b(?:science|b\.?s\.?|b\.?eng\b|engineering)\b/i.test(trimmed);
    return ladder(
      "Bachelor's Degree",
      'Bachelors Degree',
      "Bachelor's",
      'Bachelors',
      science ? 'Bachelor of Science' : 'Bachelor of Arts',
      'Undergraduate Degree',
      'Undergraduate',
      trimmed,
    );
  }
  if (/\bassociate/i.test(trimmed)) {
    return ladder("Associate's Degree", 'Associates Degree', "Associate's", 'Associates', trimmed);
  }
  if (/\bhigh school|\bged\b|\bsecondary\b/i.test(trimmed)) {
    return ladder('High School', 'High School Diploma', 'High School or equivalent', trimmed);
  }
  return ladder(trimmed);
}

const DISCIPLINE_FAMILIES: Array<{ match: RegExp; family: string[] }> = [
  {
    match: /\bcomputer\s+science\b|\bcompsci\b|\bcs\b/i,
    family: ['Computer Science', 'Computer and Information Sciences', 'Computer Science and Engineering', 'Computer Engineering', 'Engineering'],
  },
  { match: /\bsoftware\s+engineering\b/i, family: ['Software Engineering', 'Computer Science', 'Engineering'] },
  { match: /\bdata\s+science\b/i, family: ['Data Science', 'Statistics', 'Computer Science'] },
  { match: /\belectrical\s+engineering\b/i, family: ['Electrical Engineering', 'Engineering'] },
  { match: /\bmechanical\s+engineering\b/i, family: ['Mechanical Engineering', 'Engineering'] },
  { match: /\b(?:mathematics|applied\s+math|maths?)\b/i, family: ['Mathematics', 'Mathematics and Statistics'] },
  { match: /\bstatistics\b/i, family: ['Statistics', 'Mathematics and Statistics'] },
  { match: /\bphysics\b/i, family: ['Physics', 'Physical Sciences'] },
  { match: /\bfinance\b/i, family: ['Finance', 'Business Administration', 'Business'] },
  { match: /\beconomics\b/i, family: ['Economics', 'Social Sciences'] },
  { match: /\bbusiness\s+administration\b/i, family: ['Business Administration', 'Business'] },
];

/**
 * Discipline fields carry a fixed taxonomy, while the resume stores a sentence
 * ("Computer Science & Business Administration, Finance Emphasis"). Split it into its declared
 * subjects, drop the emphasis/concentration clause, then offer the standard family names.
 */
export function disciplineLadder(major: string | undefined, degree?: string | undefined): string[] {
  const source = [major, degree].map((value) => value?.trim()).find(Boolean);
  if (!source) return [];
  const subjects = source
    .replace(/\b(?:bachelor|bachelors?|master|masters?|doctor|doctorate|ph\.?d)\b(?:'s)?\s+(?:of\s+)?(?:science|arts|engineering|business\s+administration)?\s*(?:degree\s*)?(?:in\s+)?/gi, ' ')
    .split(/\s*(?:&|,|;|\/| and )\s*/i)
    .map((part) => part.replace(/\b(?:emphasis|concentration|minor|track|specialization|focus)\b.*$/i, '').trim())
    .filter((part) => part.length >= 3 && /[a-z]/i.test(part));
  const families: string[] = [];
  for (const subject of subjects) {
    const family = DISCIPLINE_FAMILIES.find((entry) => entry.match.test(subject));
    if (family) families.push(...family.family);
  }
  if (families.length === 0) {
    const family = DISCIPLINE_FAMILIES.find((entry) => entry.match.test(source));
    if (family) families.push(...family.family);
  }
  return ladder(...subjects, ...families, source);
}

export function gpaLadder(gpa: string | undefined, gpaScale?: string | undefined): string[] {
  const trimmed = gpa?.trim();
  if (!trimmed) return [];
  const value = numericValueOf(trimmed);
  const scale = gpaScale?.trim();
  return ladder(
    trimmed,
    value !== null ? value.toFixed(2) : undefined,
    value !== null ? String(Math.round(value * 10) / 10) : undefined,
    value !== null && scale ? `${trimmed}/${scale}` : undefined,
    value !== null && scale ? `${trimmed} / ${scale}` : undefined,
  );
}

export function graduationMonthLadder(monthName: string | undefined): string[] {
  const trimmed = monthName?.trim();
  if (!trimmed) return [];
  const index = MONTH_NAMES.findIndex((name) => name.toLowerCase() === trimmed.toLowerCase());
  if (index < 0) return ladder(trimmed);
  const number = index + 1;
  return ladder(
    MONTH_NAMES[index],
    MONTH_NAMES[index].slice(0, 3),
    String(number).padStart(2, '0'),
    String(number),
  );
}

export function graduationDateLadder(gradDate: string | undefined, gradYear: number | undefined): string[] {
  const point = monthYearOf(gradDate ?? '') ?? (gradYear ? { month: 0, year: gradYear } : null);
  if (!point) return ladder(gradDate);
  const year = String(point.year);
  if (!point.month) return ladder(gradDate, year);
  const name = MONTH_NAMES[point.month - 1];
  const season = point.month <= 5 ? 'Spring' : point.month <= 8 ? 'Summer' : 'Fall';
  return ladder(
    gradDate,
    `${name} ${year}`,
    `${season} ${year}`,
    `${String(point.month).padStart(2, '0')}/${year}`,
    `${year}-${String(point.month).padStart(2, '0')}`,
    year,
  );
}

/**
 * Referral source lists are short and closed. "Other" is offered LAST and only ever reached when
 * no truthful option matched, so it can never displace a real answer.
 */
export function referralSourceLadder(stored: string | undefined): string[] {
  const trimmed = stored?.trim();
  return ladder(
    trimmed,
    'Company Website',
    'Company website',
    'Company Careers Site',
    'Careers Page',
    'Career Site',
    'Careers Website',
    'Job Board',
    'Other',
  );
}

export function studyYearLadder(value: string | undefined): string[] {
  const trimmed = value?.trim();
  if (!trimmed) return [];
  const ordinals: Record<string, string[]> = {
    'first year': ['First year', '1st year', 'Year 1', 'Freshman'],
    'second year': ['Second year', '2nd year', 'Year 2', 'Sophomore'],
    'third year': ['Third year', '3rd year', 'Year 3', 'Junior'],
    'fourth year': ['Fourth year', '4th year', 'Year 4', 'Senior'],
  };
  return ladder(trimmed, ...(ordinals[trimmed.toLowerCase()] ?? []));
}

// ---- intent and resolution ----

/** The question intent for a raw discovered label, after handle stripping. */
export function profileFieldIntent(label: string): ProfileKey | null {
  const normalized = normalizeDiscoveredLabel(label) || label.trim();
  if (!normalized) return null;
  return classifyField(normalized);
}

/**
 * The ranked alias ladder for one intent, built from the stored profile.
 *
 * `base` is the value resolveKnownAnswer already produced; it stays at the head, because for a
 * free-text control the profile's own phrasing is the truest answer. Everything after it exists
 * for closed-list controls.
 */
export function profileFieldCandidates(
  key: ProfileKey | null,
  ap: ApplicationProfileLike,
  base: string,
): string[] {
  switch (key) {
    case 'school':
      return ladder(base, ...schoolAliasLadder(ap.school ?? base));
    case 'degree':
      return ladder(base, ...educationLevelLadder(ap.degree ?? base));
    case 'major':
      return ladder(base, ...disciplineLadder(ap.major ?? base, ap.degree));
    case 'gpa':
      return ladder(base, ...gpaLadder(ap.gpa ?? base, ap.gpa_scale));
    case 'gpa_scale':
      return ladder(base, base.replace(/\.0+$/, ''));
    case 'graduation_month':
      return ladder(base, ...graduationMonthLadder(base));
    case 'graduation_year':
      return ladder(base);
    case 'graduation_date':
      return ladder(base, ...graduationDateLadder(ap.grad_date ?? base, ap.grad_year));
    case 'current_enrollment':
      return /^yes$/i.test(base)
        ? ladder(base, 'Yes, I am currently enrolled', 'Currently enrolled', 'Enrolled')
        : ladder(base, 'No, I am not currently enrolled', 'Not enrolled');
    case 'study_year':
      return ladder(base, ...studyYearLadder(base));
    case 'referral_source_default':
      return ladder(base, ...referralSourceLadder(ap.referral_source_default ?? base));
    default:
      return ladder(base);
  }
}

/**
 * The alias ladder for a label plus an already-resolved answer, for callers that hold the answer
 * but not the profile (the managed action builders). Same vocabulary, same ordering.
 */
export function profileAnswerAliases(label: string, answer: string): string[] {
  const base = answer.trim();
  if (!base) return [];
  const key = profileFieldIntent(label);
  if (!isProfileBackedKey(key)) return [base];
  const synthetic: ApplicationProfileLike = {};
  switch (key) {
    case 'school': synthetic.school = base; break;
    case 'degree': synthetic.degree = base; break;
    case 'major': synthetic.major = base; break;
    case 'gpa': synthetic.gpa = base; break;
    case 'graduation_date': synthetic.grad_date = base; break;
    case 'referral_source_default': synthetic.referral_source_default = base; break;
    default: break;
  }
  return profileFieldCandidates(key, synthetic, base);
}

/**
 * Resolve one discovered control against the stored profile.
 *
 * Returns null when the profile cannot answer it, so callers keep their existing fall-through to
 * the essay drafter or to the human. Never returns a skipReason: sensitive and consent questions
 * stay entirely with resolveKnownAnswer, which this delegates to first.
 */
export function resolveProfileField(
  shape: ProfileFieldShape,
  ap: ApplicationProfileLike,
  jdText?: string,
): ResolvedProfileField | null {
  const label = normalizeDiscoveredLabel(shape.label);
  if (!label) return null;
  const known = resolveKnownAnswer(label, shape.inputType ?? 'text', ap, jdText);
  if (!known || !('value' in known)) return null;
  const base = known.value.trim();
  if (!base) return null;
  const key = profileFieldIntent(label);
  const candidates = profileFieldCandidates(key, ap, base);
  const matched = chooseClosestOption(candidates, shape.options);
  return {
    key,
    value: matched ?? candidates[0] ?? base,
    candidates,
    matchedOption: matched !== null,
  };
}

const REQUIRED_BLOCKER_RE = /^"(.+)" is required and is still empty$/;

/**
 * The blockers naming a field the resolver already has an answer for.
 *
 * This is the standing guard for the whole class of defect this module exists for: a value the
 * resolver can produce must never come back as "required and is still empty". When it does, the
 * answer existed and simply failed to reach the control, which is a Litos bug and not work for
 * the applicant, and it needs to be visible as such instead of disappearing into an attention
 * card that reads like a gap in her profile.
 *
 * Deliberately not filtered to PROFILE_BACKED_KEYS. A sponsorship answer comes from a stored
 * boolean rather than a classified ProfileKey, and it appeared in this same failure list on
 * eight measured packets; the honest test is "did the resolver have something to say", not
 * "which internal key did it route through".
 */
export function profileBackedBlockerLabels(
  blockers: readonly string[],
  ap: ApplicationProfileLike,
  jdText?: string,
): string[] {
  const out: string[] = [];
  for (const blocker of blockers) {
    const label = blocker.match(REQUIRED_BLOCKER_RE)?.[1];
    if (!label) continue;
    if (resolveProfileField({ label }, ap, jdText)) out.push(label);
  }
  return [...new Set(out)];
}
