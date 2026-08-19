export const ROLE_TYPES = ['internship', 'co-op', 'new-grad', 'full-time'] as const;
export type RoleType = (typeof ROLE_TYPES)[number];

/* The one recruiting period that is not a season and year: "I can start now."
 *
 * Stored in primary_period/backup_period like any other slug, and routes/targeting.ts builds its
 * validator from this constant. It is NOT the same as null. Null means the question was never
 * answered, and the gate below stays off for it because we know nothing. This means the student
 * answered, and what they answered is that no cycle constrains them - so the gate stays off for
 * this too, but deliberately, and it is a saved answer the profile can show back to them.
 */
export const IMMEDIATE_PERIOD = 'immediately';

export type JobTargeting = {
  categories: string[];
  titles: string[];
  role_types: RoleType[];
  locations: string[];
  remote_only: boolean;
  primary_period: string | null;
  backup_period: string | null;
};

export type PreferenceJob = {
  title: string;
  location?: string | null;
  employment_type?: string | null;
  remote?: boolean | null;
};

const CATEGORY_TERMS: Record<string, string[]> = {
  'software-engineering': ['software', 'developer', 'frontend', 'backend', 'full stack', 'mobile engineer', 'mobile developer', 'ios engineer', 'android engineer', 'devops', 'site reliability', 'platform engineer'],
  'data-ml': ['data', 'machine learning', 'ml ', 'ai ', 'artificial intelligence', 'analytics', 'scientist'],
  product: ['product manager', 'product management', 'product analyst', 'product operations'],
  design: ['designer', 'design', 'ux', 'ui ', 'user experience'],
  'quant-trading': ['quant', 'trading', 'trader', 'investment', 'markets', 'research analyst'],
  hardware: ['hardware', 'electrical', 'embedded', 'firmware', 'robotics', 'mechanical'],
  research: ['research', 'researcher', 'scientist', 'fellow'],
  other: [],
};

/**
 * "Remote" is a place a student can pick, not only the standing checkbox.
 *
 * The checkbox is all-or-nothing: it hides every on-site job. A student who would take a job in
 * London, in Dubai, or anywhere remote had no way to say so, because remote was not one of the
 * options in the list of places. It is now, and the job side honours it against the `remote` flag
 * rather than against the location text, since an employer who marks a posting remote often still
 * writes a city in the location field.
 */
export const REMOTE_LOCATION = 'Remote';

export function isRemoteLocation(value: string): boolean {
  const folded = fold(value);
  return folded === 'remote' || folded.startsWith('remote ') || folded === 'anywhere' || folded === 'work from home' || folded === 'wfh';
}

export function normalizeTargeting(row: Record<string, unknown> | null | undefined): JobTargeting {
  return {
    categories: strings(row?.categories),
    titles: strings(row?.titles),
    role_types: strings(row?.role_types).filter((value): value is RoleType => ROLE_TYPES.includes(value as RoleType)),
    locations: strings(row?.locations),
    remote_only: row?.remote_only === true,
    primary_period: period(row?.primary_period),
    backup_period: period(row?.backup_period),
  };
}

export function hasTargeting(targeting: JobTargeting): boolean {
  return targeting.categories.length > 0
    || targeting.titles.length > 0
    || targeting.role_types.length > 0
    || targeting.locations.length > 0
    || targeting.remote_only
    || targeting.primary_period !== null
    || targeting.backup_period !== null;
}

type ExplicitTitleCategory = 'quant-trading' | 'hardware' | 'design' | 'research';

/**
 * A narrow hard gate for facts the title states explicitly.
 *
 * Targeting is not only a sort preference. If someone selected Summer 2027, a title that says
 * Fall 2026 is about a different recruiting cycle. Likewise, "Quantitative Developer" is a quant
 * role even though the generic word "developer" also appears in the software category, and a PhD
 * internship is not suitable for a candidate whose current degree is a bachelor's.
 *
 * Unknown stays eligible. This function rejects only contradictions visible in the title, because
 * a hidden false negative is harder for a job seeker to detect than an extra card.
 */
export function recommendationTargetingEligible(
  job: Pick<PreferenceJob, 'title'>,
  targeting: JobTargeting,
  candidateDegree?: string | null,
): boolean {
  /* "Immediately" on either field turns the period gate OFF rather than adding a term to the
   * allowed set, and the asymmetry is the point. A student who says they can start now is
   * telling us the cycle is not a constraint; keeping the other selection as a hard filter would
   * then hide every posting outside it, which is the opposite of what they said. The gate exists
   * to drop contradictions, and against "any time" nothing in a title contradicts. */
  const chosenPeriods = [targeting.primary_period, targeting.backup_period].filter((value): value is string => Boolean(value));
  const startsImmediately = chosenPeriods.includes(IMMEDIATE_PERIOD);
  const allowedPeriods = unique(chosenPeriods.filter((value) => value !== IMMEDIATE_PERIOD));
  const postingPeriod = explicitPeriod(job.title);
  if (!startsImmediately && allowedPeriods.length > 0 && postingPeriod && !allowedPeriods.includes(postingPeriod)) return false;

  const specialist = explicitTitleCategory(job.title);
  if (targeting.categories.length > 0 && specialist && !targeting.categories.includes(specialist)) return false;

  const requiredDegree = minimumDegreeRank(job.title);
  const heldDegree = degreeRank(candidateDegree ?? '');
  if (requiredDegree !== null && heldDegree !== null && heldDegree < requiredDegree) return false;

  return true;
}

function explicitPeriod(title: string): string | null {
  const matches = [...title.matchAll(/\b(spring|summer|fall|autumn|winter)\s*(?:of\s*)?((?:19|20)\d{2})\b/gi)]
    .map((match) => `${match[1].toLowerCase() === 'autumn' ? 'fall' : match[1].toLowerCase()}-${match[2]}`);
  const distinct = unique(matches);
  return distinct.length === 1 ? distinct[0] : null;
}

function explicitTitleCategory(title: string): ExplicitTitleCategory | null {
  const value = fold(title);
  if (/\b(?:quant|quantitative|trader|trading)\b/.test(value)) return 'quant-trading';
  if (/\b(?:embedded|firmware|hardware|electrical|robotics|mechanical)\b/.test(value)) return 'hardware';
  if (/\b(?:product |ux |ui |user experience )?designer\b/.test(value)) return 'design';
  if (/\b(?:research|researcher|research scientist|research engineer|fellow)\b/.test(value)) return 'research';
  return null;
}

function minimumDegreeRank(title: string): number | null {
  const ranks = [
    { rank: 1, pattern: /\b(?:bachelor(?:'s|s)?|undergrad(?:uate)?|b\.?s\.?|b\.?a\.?)\b/i },
    { rank: 2, pattern: /\b(?:master(?:'s|s)?|m\.?s\.?|m\.?a\.?|mba)\b/i },
    { rank: 3, pattern: /\b(?:ph\.?\s?d\.?|doctorate|doctoral)\b/i },
  ].filter(({ pattern }) => pattern.test(title)).map(({ rank }) => rank);
  return ranks.length > 0 ? Math.min(...ranks) : null;
}

function degreeRank(degree: string): number | null {
  if (/\b(?:ph\.?\s?d\.?|doctorate|doctoral)\b/i.test(degree)) return 3;
  if (/\b(?:master(?:'s|s)?|m\.?s\.?|m\.?a\.?|mba)\b/i.test(degree)) return 2;
  if (/\b(?:bachelor(?:'s|s)?|undergrad(?:uate)?|b\.?s\.?|b\.?a\.?)\b/i.test(degree)) return 1;
  return null;
}

function period(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === IMMEDIATE_PERIOD) return normalized;
  return /^(spring|summer|fall|winter)-20\d{2}$/.test(normalized) ? normalized : null;
}

export function targetTitleTerms(targeting: JobTargeting): string[] {
  const terms = [
    ...targeting.titles.flatMap(titlePhrases),
    ...targeting.categories.flatMap((category) => CATEGORY_TERMS[category] ?? []),
  ];
  return unique(terms.map(fold).filter((term) => term.length >= 2));
}

function titlePhrases(title: string): string[] {
  const words = tokens(title);
  const pairs = words.slice(0, -1).map((word, index) => `${word} ${words[index + 1]}`);
  return [title, ...pairs];
}

export function roleTypePattern(roleTypes: readonly RoleType[]): string | null {
  const patterns = roleTypes.flatMap((roleType) => {
    if (roleType === 'internship') return ['intern', 'internship', 'trainee'];
    if (roleType === 'co-op') return ['co-op', 'co op', 'coop'];
    if (roleType === 'new-grad') return ['new grad', 'new graduate', 'graduate', 'entry level', 'early career', 'university grad'];
    return [];
  });
  return patterns.length ? `(^|[^a-z])(${patterns.map(regexEscape).join('|')})([^a-z]|$)` : null;
}

export function preferenceFit(job: PreferenceJob, targeting: JobTargeting): { score: number; reasons: string[] } {
  const title = fold(job.title);
  const location = fold(job.location ?? '');
  const reasons: string[] = [];
  let score = 0;

  const exactTitle = targeting.titles.find((wanted) => title.includes(fold(wanted)));
  if (exactTitle) {
    score += 60;
    reasons.push(exactTitle);
  } else {
    const wantedTokens = unique(targeting.titles.flatMap(tokens));
    const overlap = wantedTokens.filter((token) => tokens(title).includes(token));
    score += Math.min(45, overlap.length * 15);
    if (overlap.length) reasons.push(`${overlap.slice(0, 2).join(' and ')} roles`);
  }

  const category = targeting.categories.find((slug) =>
    (CATEGORY_TERMS[slug] ?? []).some((term) => title.includes(fold(term))),
  );
  if (category) {
    score += 25;
    reasons.push(category.replaceAll('-', ' '));
  }

  // Location and remote score independently: main made them additive, and a remote-flagged job in
  // a city the student named is a better fit than either on its own.
  const preferredLocation = targeting.locations
    .filter((wanted) => !isRemoteLocation(wanted))
    .find((wanted) => location.includes(fold(wanted)));
  if (preferredLocation) {
    score += 5;
    reasons.push(preferredLocation);
  }
  // "Remote" picked as a place counts the same as the standing checkbox, and against the flag
  // rather than the location text: a remote posting is often still labelled with a city.
  const wantsRemote = targeting.remote_only || targeting.locations.some(isRemoteLocation);
  if (wantsRemote && job.remote) {
    score += 5;
    reasons.push('remote preference');
  }

  const roleType = matchingRoleType(job, targeting.role_types);
  if (roleType) {
    score += 10;
    reasons.push(roleType.replace('-', ' '));
  }

  return { score: Math.min(100, score), reasons: unique(reasons).slice(0, 3) };
}

export function matchingRoleType(job: PreferenceJob, roleTypes: readonly RoleType[]): RoleType | null {
  const title = fold(job.title);
  const employment = fold(job.employment_type ?? '');
  const isInternship = /(^|\W)(intern|internship|trainee)(\W|$)/i.test(title);
  const isCoop = /(^|\W)(co-op|co op|coop)(\W|$)/i.test(title);
  const isNewGrad = /(^|\W)(new grad|new graduate|graduate|entry level|early career|university grad)(\W|$)/i.test(title);
  const isNonFullTime = /(^|\W)(part.?time|contract|temporary|freelance)(\W|$)/i.test(title)
    || /part.?time|contract|temporary|freelance/i.test(employment);

  for (const roleType of roleTypes) {
    if (roleType === 'internship' && isInternship) return roleType;
    if (roleType === 'co-op' && isCoop) return roleType;
    if (roleType === 'new-grad' && isNewGrad) return roleType;
    if (roleType === 'full-time' && !isInternship && !isCoop && !isNonFullTime && (/full.?time/i.test(employment) || !employment)) return roleType;
  }
  return null;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return unique(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean));
}

function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#]+/g, ' ').trim();
}

function tokens(value: string): string[] {
  return fold(value).split(' ').filter((token) => token.length > 1 && !TITLE_STOP_WORDS.has(token));
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TITLE_STOP_WORDS = new Set(['and', 'the', 'for', 'with', 'intern', 'internship', 'new', 'grad', 'full', 'time']);
