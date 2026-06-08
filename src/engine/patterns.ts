export type PatternTemplate = string;

export const ALL_PATTERNS: PatternTemplate[] = [
  '{first}',
  '{first}.{last}',
  '{f}{last}',
  '{first}{last}',
  '{f}.{last}',
  '{first}_{last}',
  '{last}.{first}',
  '{first}{l}',
];

// Ordered by statistical likelihood for each size bucket
export const SIZE_PATTERNS: Record<string, PatternTemplate[]> = {
  small: [
    '{first}',
    '{first}.{last}',
    '{f}{last}',
    '{first}{last}',
    '{f}.{last}',
    '{first}_{last}',
    '{last}.{first}',
    '{first}{l}',
  ],
  mid: [
    '{first}.{last}',
    '{f}{last}',
    '{first}',
    '{f}.{last}',
    '{first}{last}',
    '{first}_{last}',
    '{last}.{first}',
    '{first}{l}',
  ],
  large: [
    '{first}.{last}',
    '{f}{last}',
    '{f}.{last}',
    '{first}',
    '{first}{last}',
    '{first}_{last}',
    '{last}.{first}',
    '{first}{l}',
  ],
};

export interface ContactName {
  first: string;
  last: string;
}

export function renderPattern(template: PatternTemplate, name: ContactName, domain: string): string {
  const first = name.first.toLowerCase().replace(/[^a-z]/g, '');
  const last = name.last.toLowerCase().replace(/[^a-z]/g, '');
  const f = first[0] || '';
  const l = last[0] || '';

  const localPart = template
    .replace('{first}', first)
    .replace('{last}', last)
    .replace('{f}', f)
    .replace('{l}', l);

  return `${localPart}@${domain}`;
}

export function orderedPatterns(sizeBucket: string | null | undefined): PatternTemplate[] {
  const bucket = sizeBucket && SIZE_PATTERNS[sizeBucket] ? sizeBucket : 'mid';
  return SIZE_PATTERNS[bucket];
}

export function renderTopCandidates(
  name: ContactName,
  domain: string,
  sizeBucket: string | null | undefined,
  topN = 6
): string[] {
  const patterns = orderedPatterns(sizeBucket).slice(0, topN);
  return patterns.map((p) => renderPattern(p, name, domain));
}
