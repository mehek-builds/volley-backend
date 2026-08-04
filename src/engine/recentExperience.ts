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

/**
 * The identity of a bullet for dedupe purposes: lowercased, with every run of non-alphanumerics
 * folded to a single space and the ends trimmed. Character for character the expression that used
 * to sit inline in the PUT handler, extracted rather than rewritten, so nothing about which
 * bullets count as the same bullet has changed.
 *
 * Two properties carry weight and are pinned by tests in both directions. Case and punctuation
 * must NOT distinguish bullets, or a re-typed bullet enters the bank twice over a comma. Word
 * boundaries MUST distinguish them: the runs collapse to a space rather than to nothing, so
 * "Led a review" and "Leda review" stay different bullets.
 *
 * Exported only so those properties can be tested directly. Nothing outside this module calls it.
 */
export function bulletKey(bullet: string): string {
  return bullet.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export type ImpactAnswerSet = Partial<Record<ImpactComponent, string>>;

export type ImpactAnswerResult =
  | { error: 'verb'; bullet: string }
  | { error: 'unreadable'; bullet: string }
  | { additions: string[]; bullets: string[] };

/**
 * What the /start impact step's answers do to an entry's bullet bank: compose, drop what the bank
 * already holds, then decide about what is left.
 *
 * THE ORDER IS THE POINT, and it is the opposite of the one this used to run inline in the PUT
 * handler. There the strong-verb gate ran over every composed bullet before the dedupe, which
 * meant it could reject a bullet the student never wrote. `composeImpactBullet` returns
 * `current.trim()` when all four fields of an answer set are empty, and index 0 is composed
 * against the entry's existing first bullet, so a blank set at index 0 composes to that bullet
 * verbatim. That text came out of the resume parse and is under no obligation to open with a
 * whitelisted verb: a student whose first bullet reads "Responsible for ..." got a 400 for leaving
 * the first fieldset empty and filling a later one. "responsible" is not in STRONG_VERBS, which is
 * what makes that case real rather than theoretical.
 *
 * Recognising echoes first makes the gate mean what its error message says. An echo of a bank
 * bullet is not an addition, so it is dropped and never judged. Anything that survives is by
 * construction absent from the bank, so it is new, and every new bullet is still judged - the
 * rules are not relaxed, only pointed at the right bullets.
 *
 * An echo is matched on the key OR on the exact TRIMMED text. The exact-text arm exists for
 * bullets whose key is empty (see below): for those the key carries no identity at all, and
 * without this arm a bank whose first bullet is written in a non-Latin script would hit the very
 * bug this function was written to fix. Both sides of that comparison are trimmed, because the
 * route filters `existing` on `value.trim().length > 0` without ever trimming the value, so a
 * bullet carrying stray padding out of the parse or a JSONB round-trip is a real bank state.
 * Trimming only the composed side reinstates the same bug for that bank.
 *
 * THREE OUTCOMES FOR A NEW BULLET, and they are three different facts about it:
 *   - empty key, meaning not one letter or digit survives the fold. `firstWordOf` matches
 *     `[a-zA-Z]+`, so such a bullet can never satisfy `startsWithStrongVerb` and can never be
 *     accepted by any path. It is 'unreadable': the student wrote something, and this pipeline
 *     cannot read it as a resume bullet. It is REJECTED and reported as its own error rather than
 *     dropped, because dropping it loses text the student typed with no signal at all.
 *   - a readable opener that is not a strong verb: 'verb', the long-standing rule.
 *   - otherwise accepted.
 *
 * WHAT 'unreadable' ACTUALLY KEYS ON IS SCRIPT, NOT LANGUAGE, and the difference matters because
 * it is the limit of this change. The trigger is "no Latin letters and no digits survive the
 * fold", so it catches an answer typed in Chinese, Arabic or Devanagari. It does NOT catch an
 * answer in a Latin-script language: "Dirigi el equipo" keys fine, reaches the verb rule, and
 * comes back with the old misleading "must start with a strong action verb". That gap is
 * deliberately untouched here. Closing it properly means deciding what language this product
 * writes resumes in and what it does with an answer in another one, which is a product question,
 * not a dedupe detail. STRONG_VERBS is an ASCII English whitelist embedded in both generation
 * prompts, so the answer is bigger than this function.
 *
 * ONE PLACE THE "never lose typed text in silence" PRINCIPLE IS NOT APPLIED: an answer that folds
 * to the same key as a bank bullet is dropped as an echo even though the student typed it, and a
 * fold-away answer at index 0 such as `{ metric_or_scope: '管理' }` composes to exactly the bank
 * bullet and takes that path. It is left alone on purpose. Making echoes speak up is a change to
 * the dedupe's meaning for every student, not a fix to this bug.
 *
 * Positions are preserved on the way in, never compacted: a blank at index 0 must stay a blank at
 * index 0, or an answer the student wrote about their second bullet composes onto their first.
 */
export function applyImpactAnswers(existing: string[], answers: ImpactAnswerSet[]): ImpactAnswerResult {
  const composed = answers
    .map((answer, index) => composeImpactBullet(index === 0 ? existing[0] ?? '' : '', answer))
    .filter((bullet) => bullet.length > 0);
  const bankKeys = new Set(existing.map(bulletKey).filter(Boolean));
  const bankText = new Set(existing.map((bullet) => bullet.trim()));
  const seen = new Set(bankKeys);
  const additions: string[] = [];
  for (const bullet of composed) {
    const key = bulletKey(bullet);
    if (bankText.has(bullet.trim())) continue;
    if (!key) return { error: 'unreadable', bullet };
    if (seen.has(key)) continue;
    if (!startsWithStrongVerb(bullet)) return { error: 'verb', bullet };
    seen.add(key);
    additions.push(bullet);
  }
  return { additions, bullets: [...existing, ...additions] };
}
