export const ROLE_TYPES = ['internship', 'co-op', 'new-grad', 'full-time'] as const;
export type RoleType = (typeof ROLE_TYPES)[number];

export type JobTargeting = {
  categories: string[];
  titles: string[];
  role_types: RoleType[];
  locations: string[];
  remote_only: boolean;
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

export function normalizeTargeting(row: Record<string, unknown> | null | undefined): JobTargeting {
  return {
    categories: strings(row?.categories),
    titles: strings(row?.titles),
    role_types: strings(row?.role_types).filter((value): value is RoleType => ROLE_TYPES.includes(value as RoleType)),
    locations: strings(row?.locations),
    remote_only: row?.remote_only === true,
  };
}

export function hasTargeting(targeting: JobTargeting): boolean {
  return targeting.categories.length > 0
    || targeting.titles.length > 0
    || targeting.role_types.length > 0
    || targeting.locations.length > 0
    || targeting.remote_only;
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

  const preferredLocation = targeting.locations.find((wanted) => location.includes(fold(wanted)));
  if (preferredLocation) {
    score += 5;
    reasons.push(preferredLocation);
  }
  if (targeting.remote_only && job.remote) {
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
