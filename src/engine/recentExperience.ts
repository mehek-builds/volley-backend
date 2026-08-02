import { startsWithStrongVerb } from './resumeValidate';

export type ImpactComponent = 'action' | 'noun' | 'metric_or_scope' | 'outcome';

export interface RecentExperienceEntry {
  id: string;
  type: string;
  org: string;
  title: string | null;
  date_range: string | null;
  bullet_variants: unknown;
}

export interface ImpactAssessment {
  draft: string;
  score: number;
  components: Record<ImpactComponent, { present: boolean; evidence: string | null }>;
}

export interface RecentExperienceReview {
  status: 'ready' | 'choose_entry' | 'optional_enrichment' | 'needs_input' | 'continued';
  selected_entry_id: string | null;
  user_selected: boolean;
  impact_candidate: ImpactAssessment | null;
  grounded_bullet_count: number;
  missing_bullets: number;
  completed: boolean;
  continue_with_found: boolean;
}

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9,
  sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12,
  december: 12,
};

export function comparableEndDate(dateRange: string | null): number | null {
  const value = (dateRange ?? '').trim().toLowerCase();
  if (!value) return null;
  if (/\b(?:present|current|now)\b/.test(value)) return Number.MAX_SAFE_INTEGER;
  const years = [...value.matchAll(/\b(?:19|20)\d{2}\b/g)];
  if (years.length === 0) return null;
  const yearMatch = years[years.length - 1];
  const year = Number(yearMatch[0]);
  const before = value.slice(Math.max(0, (yearMatch.index ?? 0) - 12), yearMatch.index);
  const monthName = Object.keys(MONTHS).find((name) => new RegExp(`\\b${name}\\b`).test(before));
  return year * 100 + (monthName ? MONTHS[monthName] : 12);
}

export function selectRecentExperience(entries: RecentExperienceEntry[]): {
  selected: RecentExperienceEntry | null;
  ambiguous: boolean;
} {
  if (entries.length === 0) return { selected: null, ambiguous: false };
  const dated = entries.map((entry) => ({ entry, date: comparableEndDate(entry.date_range) }));
  if (dated.some((item) => item.date === null)) return { selected: null, ambiguous: true };
  const ordered = [...dated].sort((a, b) => (b.date as number) - (a.date as number));
  if (ordered.length > 1 && ordered[0].date === ordered[1].date) return { selected: null, ambiguous: true };
  return { selected: ordered[0].entry, ambiguous: false };
}

const METRIC_OR_SCOPE = /(?:\$|%|\b\d+(?:\.\d+)?x?\b|\bacross\b|\bused by\b|\bserv(?:ed|ing)\b|\bcompanywide\b|\bteam(?:s)?\b|\bclients?\b|\busers?\b)/i;
const RESULT_OUTCOME = /\b(?:increas(?:ed|ing)|reduc(?:ed|ing)|improv(?:ed|ing)|sav(?:ed|ing)|grew|growth|accelerat(?:ed|ing)|raised|lowered|cut|won)\b/i;
const CAUSAL_OUTCOME = /\b(?:enabled|result(?:ed|ing)|leading to|so that|delivered|launched|adopted)\b/i;

function words(value: string): string[] {
  return value.toLowerCase().match(/[a-z][a-z0-9+-]*/g) ?? [];
}

function nounEvidence(bullet: string): string | null {
  const rest = bullet.trim().replace(/^[A-Za-z]+\s+/, '').replace(/[.;].*$/, '').trim();
  return words(rest).length > 0 ? rest.split(/\s+/).slice(0, 8).join(' ') : null;
}

function outcomeEvidence(bullet: string): string | null {
  const result = bullet.match(RESULT_OUTCOME);
  if (result) return result[0];
  const causal = bullet.match(CAUSAL_OUTCOME);
  const firstWordEnd = bullet.trim().search(/\s/);
  // "Launched a dashboard" is an action and object, not a separate outcome. Causal verbs count
  // only when they appear after the opener, such as "Built a dashboard, enabling faster review."
  return causal && (causal.index ?? 0) > Math.max(0, firstWordEnd) ? causal[0] : null;
}

export function assessImpactBullet(bullets: string[]): ImpactAssessment {
  const clean = bullets.map((bullet) => bullet.trim()).filter(Boolean);
  const ranked = clean
    .map((bullet) => {
      const action = startsWithStrongVerb(bullet);
      const noun = nounEvidence(bullet);
      const metric = bullet.match(METRIC_OR_SCOPE)?.[0] ?? null;
      const outcome = outcomeEvidence(bullet);
      const score = Number(action) + Number(!!noun) + Number(!!metric) + Number(!!outcome);
      return { bullet, action, noun, metric, outcome, score };
    })
    .sort((a, b) => b.score - a.score || b.bullet.length - a.bullet.length);
  const best = ranked[0] ?? { bullet: '', action: false, noun: null, metric: null, outcome: null, score: 0 };

  // A result in another source bullet may strengthen the candidate only when both bullets share
  // at least two content words. This is the deterministic cause-and-effect floor: unrelated work
  // from the same role is never stitched into one claim.
  const bestWords = new Set(words(best.bullet).filter((word) => word.length > 3));
  const related = ranked.find((candidate) => {
    if (candidate.bullet === best.bullet) return false;
    const overlap = words(candidate.bullet).filter((word) => word.length > 3 && bestWords.has(word)).length;
    return overlap >= 2 && (!!candidate.metric || !!candidate.outcome);
  });
  const metric = best.metric ?? related?.metric ?? null;
  const outcome = best.outcome ?? related?.outcome ?? null;
  const score = Number(best.action) + Number(!!best.noun) + Number(!!metric) + Number(!!outcome);
  return {
    draft: best.bullet,
    score,
    components: {
      action: { present: best.action, evidence: best.action ? best.bullet.split(/\s+/)[0] : null },
      noun: { present: !!best.noun, evidence: best.noun },
      metric_or_scope: { present: !!metric, evidence: metric },
      outcome: { present: !!outcome, evidence: outcome },
    },
  };
}

function bulletStrings(entry: RecentExperienceEntry): string[] {
  return (Array.isArray(entry.bullet_variants) ? entry.bullet_variants : [])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

export function buildRecentExperienceReview(entries: RecentExperienceEntry[]): RecentExperienceReview {
  const selection = selectRecentExperience(entries);
  if (!selection.selected) {
    return {
      status: 'choose_entry', selected_entry_id: null, user_selected: false, impact_candidate: null,
      grounded_bullet_count: 0, missing_bullets: 3, completed: false, continue_with_found: false,
    };
  }
  const bullets = bulletStrings(selection.selected);
  const assessment = assessImpactBullet(bullets);
  return {
    status: assessment.score < 2 || bullets.length < 3 ? 'needs_input' : assessment.score < 4 ? 'optional_enrichment' : 'ready',
    selected_entry_id: selection.selected.id,
    user_selected: false,
    impact_candidate: assessment,
    grounded_bullet_count: bullets.length,
    missing_bullets: Math.max(0, 3 - bullets.length),
    completed: assessment.score === 4 && bullets.length >= 3,
    continue_with_found: false,
  };
}

export function composeImpactBullet(
  current: string,
  answers: Partial<Record<ImpactComponent, string>>,
): string {
  const supplied = Object.fromEntries(
    Object.entries(answers).map(([key, value]) => [key, typeof value === 'string' ? value.trim() : '']),
  ) as Record<ImpactComponent, string>;
  const action = supplied.action;
  const noun = supplied.noun;
  const metric = supplied.metric_or_scope;
  const outcome = supplied.outcome;
  if (!action && !noun && !metric && !outcome) return current.trim();
  const base = [action, noun].filter(Boolean).join(' ') || current.replace(/[.]$/, '').trim();
  const scope = metric ? ` ${metric}` : '';
  const result = outcome ? `, ${outcome}` : '';
  return `${base}${scope}${result}`.replace(/\s+/g, ' ').replace(/[.]*$/, '.');
}
