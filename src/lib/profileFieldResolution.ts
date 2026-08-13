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

import type { JobCountry } from './jobLocation';
import {
  classifyField,
  consentAcknowledgementAnswer,
  EEO_QUESTION,
  isConsentAcceptingWording,
  isConsentRefusingWording,
  isConsentAcknowledgementQuestion,
  normalizeDiscoveredLabel,
  resolveKnownAnswer,
  type ApplicationProfileLike,
  type ProfileKey,
} from './questionDiscovery';
import {
  referralSourceForApplication,
  referralSourceOptionCandidates,
  employerOwnSiteOption,
  isCompanySiteReferralClaim,
} from './referralSource';
import {
  comparableOption,
  isDeclineToState,
  selfIdentificationDeclineWording,
} from './selfIdentification';

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

// comparableOption and isDeclineToState live in selfIdentification.ts, where questionDiscovery can
// reach them too. Re-exported here because this module's public surface is what callers import.
export { comparableOption, isDeclineToState, selfIdentificationDeclineWording };

function optionTokens(value: string): string[] {
  return comparableOption(value).split(' ').filter(Boolean);
}

/**
 * The "Select..." row every select carries, and nothing else.
 *
 * `none` and `n/a` were on this list and had to come off. They are not placeholders, they are
 * ANSWERS, and for a whole family of required questions they are the only true one: "How many
 * outstanding offers do you have?", "Have you previously applied here?", "Standardized test
 * scores". Stripping them made None unselectable, so a control whose correct answer was sitting in
 * the list came back as "required and is still empty" and the applicant was asked to finish by
 * hand. A truthful answer must never be filtered out of its own option list.
 */
const PLACEHOLDER_OPTION_RE =
  /^(?:|-+|–+|select(?:\.{3}|…)?|select one|select an option|please select|choose(?: one)?|pick one|--.*--)$/i;

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
// Dropped with the old optionCoversMonthYear, whose "does this option mention any month at all"
// test it was the only user of. Interval arithmetic answers that question by construction now.
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

/** Explicit month+year points mentioned by an option, as year*12+month ordinals. */
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
  return { points, years };
}

/**
 * A span of calendar months an option covers, as inclusive year*12+month ordinals. An unbounded
 * end is an infinity, which is also how "how specific is this option" gets answered below.
 */
export type CalendarInterval = { min: number; max: number };

/* A RUN OF SEASON WORDS SHARING ONE YEAR, as "Spring/Summer 2028" writes it.
 *
 * MEASURED, on the owner's two live Jump Trading applications (generated_resumes
 * f4f278d2-edb8-482e-ae3d-403b45c7bc10 and 928e0c9a-5a05-4aaf-8fe7-10dcb9a44950, 2026-08-13).
 * Both postings offer the same seventeen-entry graduation list, and the entry that states her
 * real graduation is "Spring/Summer 2028". The year used to be reached from a season word across
 * a gap of at most six non-digit characters, and "/Summer " is eight, so the Spring half of every
 * such label was dropped: the option read as June through August only, May 2028 looked uncovered,
 * and the one correct entry on the list could never be selected. Both packets then reported
 * `no option matched "May 2028"` and left a required field empty.
 *
 * Each season word in the run takes the year the run ends with. Only punctuation and "and"/"or"
 * may join two of them, so "Fall 2027 - Spring 2028" is still two runs with a year each: the digits
 * between them end the first run before the second begins.
 */
const SEASON_RUN_RE = new RegExp(
  `\\b((?:(?:${Object.keys(SEASON_MONTHS).join('|')})\\b(?:\\s*[/&+,]\\s*|\\s+(?:and|or)\\s+)?)+)[^0-9]{0,6}\\b((?:19|20)\\d{2})\\b`,
  'gi',
);

/**
 * The intervals a season names, as separate runs rather than one min-to-max span.
 *
 * Winter is the reason. Its months are December, January and February, so collapsing them to a
 * single min-to-max span reads "Winter 2028" as January through December 2028 and swallows every
 * other term in the year. Contiguous runs keep it to the two ranges a person means.
 */
function optionSeasonIntervals(option: string): CalendarInterval[] {
  const intervals: CalendarInterval[] = [];
  for (const match of option.matchAll(SEASON_RUN_RE)) {
    const year = Number(match[2]);
    const named = [...match[1].matchAll(new RegExp(`\\b(${Object.keys(SEASON_MONTHS).join('|')})\\b`, 'gi'))];
    for (const seasonMatch of named) {
      const months = SEASON_MONTHS[seasonMatch[1].toLowerCase()];
      if (!months) continue;
      const sorted = [...months].sort((a, b) => a - b);
      let run: CalendarInterval | null = null;
      for (const month of sorted) {
        const point = year * 12 + month;
        if (run && point === run.max + 1) run.max = point;
        else {
          run = { min: point, max: point };
          intervals.push(run);
        }
      }
    }
  }
  return intervals;
}

// The boundary qualifiers a graduation option uses to describe everything on ONE side of a date.
//
// Ignoring these is how "Before 2028" was reported as covering May 2028. parseNumericRange has
// read above/below/or-higher on GPA buckets since it was written; the calendar path read the year
// out of the option and threw the qualifier away, so all four of "Before 2028", "After 2028",
// "2028 or earlier" and "No later than 2028" answered the same question the same way, and two of
// those four are flatly false about a person graduating in May 2028.
//
// The INCLUSIVE forms are tested first because they are their own vocabulary rather than a variant
// spelling: "2028 or earlier" contains no "before", and "no later than 2028" contains no "after".
// Testing the strict forms first would let "on or before 2028" fall into the "before" branch and
// lose the year it is supposed to include.
const AT_OR_BEFORE_RE =
  /\b(?:or\s+(?:earlier|before|sooner|prior)|no[t]?\s+later\s+than|on\s+or\s+before|up\s+to(?:\s+and\s+including)?|through|by)\b/i;
const AT_OR_AFTER_RE =
  /\b(?:or\s+(?:later|after|beyond)|and\s+(?:later|after|beyond)|no[t]?\s+earlier\s+than|on\s+or\s+after|onwards?)\b|\d\s*\+/i;
const STRICTLY_BEFORE_RE = /\b(?:before|prior\s+to|earlier\s+than)\b/i;
const STRICTLY_AFTER_RE = /\b(?:after|later\s+than|beyond)\b/i;

/**
 * Which calendar months an option covers, or an empty list when it names no date at all.
 *
 * Handles a plain year ("2028"), a term ("Spring 2028"), an exact month ("May 2028"), a written
 * range ("January 2028 - June 2028", "2027 - 2029"), and the one-sided buckets a graduation select
 * puts at each end of its list ("Before 2028", "2028 or earlier", "2029 or later", "After 2029").
 *
 * A qualifier is only read against a ONE-ENDED base. "January 2028 - June 2028" already states both
 * of its ends, so a stray "from" or "through" in the label text must not reopen one of them.
 */
export function optionCalendarIntervals(option: string): CalendarInterval[] {
  // U+2013 and U+2014 are the en and em dashes real option text uses to write a range, written as
  // escapes so no such character appears literally in this repo.
  const text = option.replace(/[\u2013\u2014]/g, '-');
  const { points, years } = optionDatePoints(text);
  const seasons = optionSeasonIntervals(text);

  let base: CalendarInterval[];
  let bothEndsWritten = false;
  if (points.length >= 2) {
    base = [{ min: Math.min(...points), max: Math.max(...points) }];
    bothEndsWritten = true;
  } else if (points.length === 1) {
    base = [{ min: points[0], max: points[0] }];
  } else if (seasons.length > 0) {
    base = seasons;
  } else if (years.length >= 2) {
    base = [{ min: Math.min(...years) * 12 + 1, max: Math.max(...years) * 12 + 12 }];
    bothEndsWritten = true;
  } else if (years.length === 1) {
    base = [{ min: years[0] * 12 + 1, max: years[0] * 12 + 12 }];
  } else {
    return [];
  }

  if (bothEndsWritten || base.length !== 1) return base;
  const only = base[0];
  if (AT_OR_BEFORE_RE.test(text)) return [{ min: Number.NEGATIVE_INFINITY, max: only.max }];
  if (AT_OR_AFTER_RE.test(text)) return [{ min: only.min, max: Number.POSITIVE_INFINITY }];
  if (STRICTLY_BEFORE_RE.test(text)) return [{ min: Number.NEGATIVE_INFINITY, max: only.min - 1 }];
  if (STRICTLY_AFTER_RE.test(text)) return [{ min: only.max + 1, max: Number.POSITIVE_INFINITY }];
  return base;
}

/**
 * How many months wide the covering interval is, or null when the option does not cover the date.
 *
 * This is the specificity measure chooseClosestOption ranks on. A one-sided bucket is infinitely
 * wide, a bare year is twelve, a term is three and an exact month is one, so "January 2028 - June
 * 2028" beats "2028" beats "2028 or earlier" without any of them having to be enumerated.
 */
export function optionCalendarSpan(option: string, month: number, year: number): number | null {
  const target = year * 12 + month;
  let best: number | null = null;
  for (const interval of optionCalendarIntervals(option)) {
    if (target < interval.min || target > interval.max) continue;
    const span = interval.max - interval.min;
    if (best === null || span < best) best = span;
  }
  return best;
}

/**
 * Does an option cover a graduation date? Handles a plain year ("2028"), a term ("Spring 2028"),
 * an exact month ("May 2028"), a range ("January 2028 - June 2028", "2027 - 2028"), and the
 * one-sided buckets ("Before 2028", "2028 or earlier").
 */
export function optionCoversMonthYear(option: string, month: number, year: number): boolean {
  return optionCalendarSpan(option, month, year) !== null;
}

/**
 * The span of months an ANSWER covers when the answer is a term rather than a month.
 *
 * MEASURED. Six packets across IMC Trading and DV Trading reported
 * `no option matched "Spring 2028", left for you to choose` against lists whose entries read
 * "January 2028 - July 2028" and "August 2028 - December 2028". Spring 2028 is March, April and
 * May of 2028, all three of which are inside the first bucket and none of which is inside the
 * second, so which one is meant is a fact rather than a guess. The matcher simply had no way to
 * ask the question: monthYearOf wants an explicit month name and a term does not carry one, so
 * the calendar stage was skipped and the answer fell through to a string comparison it could
 * never win.
 *
 * Returns null for anything that is not exactly ONE contiguous run. Winter is the reason: its
 * months straddle a year boundary, so "Winter 2028" is two separate runs and there is no single
 * span that is honestly "the term she graduates in". A candidate that also names an explicit
 * month is left to the point stage, which is more precise than this and runs first.
 */
export function candidateTermInterval(candidate: string): CalendarInterval | null {
  if (optionDatePoints(candidate).points.length > 0) return null;
  const runs = optionSeasonIntervals(candidate);
  return runs.length === 1 ? runs[0] : null;
}

/**
 * The narrowest option that WHOLLY CONTAINS a term, or null.
 *
 * Containment, not overlap, and that is the whole safety of it. A term that only half fits an
 * option is a different claim about when she finishes, so it declines; a term entirely inside one
 * is the same claim written coarsely, which is exactly what these buckets are for. Ranked by width
 * for the same reason the point stage is: a list that opens with a catch-all must not win over the
 * precise bucket further down.
 */
function chooseTermBucket(
  entries: readonly ComparableEntry[],
  target: CalendarInterval,
): string | null {
  let best: { option: string; span: number } | null = null;
  for (const entry of entries) {
    for (const interval of optionCalendarIntervals(entry.option)) {
      if (target.min < interval.min || target.max > interval.max) continue;
      const span = interval.max - interval.min;
      if (!best || span < best.span) best = { option: entry.option, span };
    }
  }
  return best?.option ?? null;
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

type ComparableEntry = { option: string; key: string; tokens: string[] };

/**
 * Answers whose whole meaning is the word itself, so any option that adds words to them is making
 * a different statement rather than spelling the same one out.
 *
 * "Yes" against "Yes - I am authorized to work in the US for any employer" is the measured case:
 * the resolver's own answer was "I need sponsorship" and it selected the option asserting the
 * opposite, and reported matchedOption. There is no remainder a bare polarity token can absorb, so
 * these match exactly or not at all.
 */
const CLOSED_SET_ANSWER_RE =
  /^(?:yes|no|y|n|true|false|maybe|agree|disagree|accept|decline|other|none|n\/a|na|unknown|prefer not to say|decline to self identify|i agree|i decline)$/i;

/**
 * Words an option may add to an answer without changing what the answer claims: grammatical glue,
 * the noun for the thing being named, and the answer's own initialism in the parenthetical portals
 * like to append ("University of Southern California (USC)").
 *
 * Anything else is a distinguishing word. "University of California" plus "Los Angeles" names a
 * different university; "Yes" plus "with sponsorship" answers a different question.
 */
const NON_DISTINGUISHING_REMAINDER: ReadonlySet<string> = new Set([
  'of', 'the', 'and', 'or', 'a', 'an', 'in', 'at', 'for', 'to',
  'degree', 'degrees', 'program', 'programs', 'programme', 'programmes',
]);

/** Does the option state the answer and then keep going? */
function optionExtendsAnswer(entry: ComparableEntry, key: string, tokens: readonly string[]): boolean {
  if (entry.key === key) return false;
  if (entry.key.startsWith(`${key} `) || entry.key.endsWith(` ${key}`) || entry.key.includes(` ${key} `)) return true;
  return tokens.length > 0
    && entry.tokens.length > tokens.length
    && tokens.every((token) => entry.tokens.includes(token));
}

/** The words the option adds, and whether any of them changes the claim. */
function extensionKeepsTheClaim(entry: ComparableEntry, key: string, tokens: readonly string[]): boolean {
  if (CLOSED_SET_ANSWER_RE.test(key)) return false;
  const own = new Set(tokens);
  const initialism = tokens
    .filter((token) => !NON_DISTINGUISHING_REMAINDER.has(token))
    .map((token) => token[0])
    .join('');
  return entry.tokens
    .filter((token) => !own.has(token))
    .every((token) => NON_DISTINGUISHING_REMAINDER.has(token) || (initialism.length >= 2 && token === initialism));
}

/**
 * The one option that states this answer and adds nothing to it, or null.
 *
 * REFUSES on two counts, both of which put a false statement on a real application when they were
 * allowed through:
 *
 *   - SEVERAL options share the answer. Given the ladder form "University of California" and the
 *     options "University of California, Los Angeles" and "University of California, Davis", the
 *     old code took whichever was listed first and told two employers she went to UCLA.
 *   - the remainder CHANGES THE CLAIM. Given the answer "Yes" - meaning "yes, I need sponsorship" -
 *     and the sole yes-shaped option "Yes - I am authorized to work in the US for any employer",
 *     the old code selected the sentence that says the opposite of the answer it was given.
 *
 * The reverse direction, where the ANSWER is longer than the option, needs none of this: an option
 * contained inside the answer is the same claim with less detail, which is what the school ladder
 * exists to reach. That direction is handled by the caller before this one is consulted.
 */
function chooseExtendingOption(
  entries: readonly ComparableEntry[],
  key: string,
  tokens: readonly string[],
): { option: string | null; ambiguous: boolean } {
  const extending = entries.filter((entry) => optionExtendsAnswer(entry, key, tokens));
  if (extending.length === 0) return { option: null, ambiguous: false };
  if (extending.length > 1) return { option: null, ambiguous: true };
  const only = extending[0];
  return { option: extensionKeepsTheClaim(only, key, tokens) ? only.option : null, ambiguous: true };
}

/**
 * The option that best answers with one of `candidates`, or null.
 *
 * Deliberately conservative and ordered by evidence strength: an exact match beats a calendar
 * bucket beats a containment match beats a numeric bucket. A candidate shorter than three
 * characters never matches by containment, because "BS" would otherwise select "Business".
 *
 * The two inexact stages both rank on how much the option is allowed to differ from the answer,
 * because both of them used to take whatever was listed first and both put a false statement on a
 * real application when they did: the narrowest covering calendar bucket rather than the first, and
 * an option that states the answer and adds nothing rather than one that adds a claim to it.
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
  //
  // And among the buckets that DO cover the date, the narrowest one wins rather than the first in
  // DOM order. A graduation select routinely opens with a catch-all - "Before 2028", "2028 or
  // earlier" - and closes with another, so first-in-DOM-order handed the catch-all to an employer
  // whenever the precise bucket sat further down the list.
  for (const candidate of candidates) {
    const point = monthYearOf(candidate);
    if (!point) continue;
    let best: { option: string; span: number } | null = null;
    for (const entry of comparableOptions) {
      const span = optionCalendarSpan(entry.option, point.month, point.year);
      if (span === null) continue;
      if (!best || span < best.span) best = { option: entry.option, span };
    }
    if (best) return best.option;
  }

  // Then the same arithmetic for an answer that names a TERM instead of a month. Kept as its own
  // pass after the point stage rather than folded into it, so an answer that does state a month
  // is always settled by the more precise rule first. See candidateTermInterval.
  for (const candidate of candidates) {
    const term = candidateTermInterval(candidate);
    if (!term) continue;
    const bucket = chooseTermBucket(comparableOptions, term);
    if (bucket) return bucket;
  }

  for (const candidate of candidates) {
    const key = comparableOption(candidate);
    if (key.length < 3) continue;
    const tokens = optionTokens(candidate).filter((token) => token.length >= 3);
    // The safe direction first: an option contained INSIDE the answer is the same claim with less
    // detail, which is how "University of Southern California, Viterbi School of Engineering"
    // reaches the option "University of Southern California".
    const narrower = comparableOptions.find((entry) =>
      entry.key === key
      || key.startsWith(`${entry.key} `)
      || key.includes(` ${entry.key} `));
    if (narrower) return narrower.option;
    // Then the direction that adds words to the answer, which is only allowed when exactly one
    // option does it and the words it adds do not change what is being claimed. An ambiguous list
    // ends the search: a lower-ranked alias must not be used to slip past a refusal made here.
    const extending = chooseExtendingOption(comparableOptions, key, tokens);
    if (extending.option) return extending.option;
    if (extending.ambiguous) break;
  }

  /* THE NUMERIC STAGE IS FOR GPA BANDS, AND A CALENDAR OPTION IS NOT ONE.
   *
   * This is the stage that put "Winter 2028" on two live Jump Trading applications for an applicant
   * who graduates in May. The ladder for a graduation date ends with the bare year, parseNumericRange
   * reads "Winter 2028" as the one-point range 2028 to 2028, and 2028 is inside it, so the candidate
   * "2028" selected whichever season of 2028 the employer happened to list first. Winter is listed
   * before Spring/Summer on Greenhouse's standard term list, so the answer named a term six months
   * before she finishes. Nothing about that is a measurement: it is DOM order.
   *
   * A year is not a quantity to be bucketed, it is a date, and every honest way to place a date on
   * this list has already run and declined by the time control reaches here. So an option that names
   * any calendar span is skipped, and a graduation list made entirely of them yields null: the
   * question comes back to the applicant unanswered. That is the whole trade. An unanswered
   * graduation date costs her one selection she can make in a second from the list in front of her;
   * a guessed one is a false statement about her degree that she cannot retract once sent.
   *
   * Skipped per option rather than per list, so a genuinely numeric band on a list that also holds a
   * date - "0-2 years", "2020 or earlier" - still resolves through the branch it was written for. */
  for (const candidate of candidates) {
    const numeric = numericValueOf(candidate);
    if (numeric === null) continue;
    const bucket = comparableOptions.find((entry) => {
      if (optionCalendarIntervals(entry.option).length > 0) return false;
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

/** Does the stored referral source name the employer's own site? */
/**
 * Referral source lists are short and closed, and every entry on one is a factual claim about how
 * this applicant found this posting.
 *
 * "Job Board" used to sit on this ladder ahead of "Other", so a stored "Company website" against
 * ["LinkedIn", "Job Board", "Employee referral", "Other"] returned Job Board: a statement about
 * where she found the role that simply did not happen. It is gone. The synonyms that remain are
 * all sayings of the SAME fact, and they are only offered when the stored value is that fact;
 * for anything else the ladder uses only the student's exact source. A generic "Other" fallback
 * is deliberately absent: managed select retries can replace an earlier exact choice, and an
 * unsupported closed list must return for review instead of changing the acquisition channel.
 */
export function referralSourceLadder(
  stored: string | undefined,
  evidence?: ApplicationProfileLike['referral_source_evidence'],
): string[] {
  return referralSourceOptionCandidates(stored, evidence);
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

// ---- EEO self-identification ----
//
// WHY THIS SECTION EXISTS (measured on the owner's prod packets, 2026-08-09). Packet
// 13bccb2d-d726-4c47-80bc-e8090ae1463e (Skydio, Ashby) filled name, email, phone and resume and
// then reported, for four separate controls, "none of the options match your saved answer, so this
// one is left for you". Every one of those answers was already stored. So this is a matching
// failure, not an honesty one, and it is the ONE question family where that distinction is total:
// the fact is on the profile, the employer offers a closed list, and every such list carries an
// explicit opt-out, so a correct answer is always available and a blank is never the right outcome.
//
// Nothing here touches eeoAnswer. That function returning "Decline to self-identify" across the
// corpus's 50 EEO labels is the only approved constant in the resolver, on the grounds that a
// refusal to state is not a statement, and it is unchanged: the sweep at
// scripts/_sweep-untraceable.mts reports the same count before and after this section existed.
// What changes is only whether the answer it produces can be left on the control.

/**
 * The wordings to OFFER for a decline, for a fill layer that cannot see the option list. Ordered
 * plainest first. Only ever appended after the applicant's own answer, never in front of it.
 */
const DECLINE_WORDINGS = [
  'Decline to self-identify',
  'I decline to self-identify',
  'I do not wish to answer',
  'I do not want to answer',
  'I prefer not to say',
  'Prefer not to say',
  'I do not wish to disclose',
];

/** A race or ethnicity question, as opposed to the rest of the self-identification block. */
const EEO_RACE_QUESTION = /\brace\b|racial|ethnicit|ethnic\b/i;
/** Asked as its own yes/no on nearly every US form, and answered from its own stored preference. */
const EEO_HISPANIC_QUESTION = /hispanic|latin/i;

/**
 * THE MAPPING RULE, and it is deliberately the narrowest one that works.
 *
 * A stored race value is rewritten to a US federal category ONLY when that category WHOLLY CONTAINS
 * it: the stored value names a subgroup that the federal definition of the category already
 * includes, so the rewrite loses detail and changes no membership. "South Asian" to "Asian" is that
 * shape - the EEOC defines Asian as origins in the Far East, Southeast Asia, or the Indian
 * subcontinent, so a person who wrote South Asian is inside Asian by the employer's own definition,
 * and the employer's list has no finer word to offer.
 *
 * Race is the applicant's own self-identification, so anything that is not a clean containment
 * declines instead of guessing, and declining is always available and always honest. The cases this
 * table deliberately does NOT contain, each for a stated reason:
 *
 *   "Central Asian"          the federal definition of Asian names the Far East, Southeast Asia and
 *                            the Indian subcontinent, and not Central Asia. Not a containment.
 *   "Asian/Pacific Islander" spans TWO federal categories. Picking either one narrows her answer.
 *   "Middle Eastern",        the enum has no such category and files them under White. That is a
 *   "North African"          contested reassignment, not a coarser word for the same thing.
 *   "Native American"        read as American Indian or Alaska Native by most, but not by all, and
 *                            it overlaps Native Hawaiian. Ambiguous, so it declines.
 *   "Indian"                 ambiguous between Asian Indian and American Indian. Never mapped.
 *
 * A category is only ever WIDENED. The reverse - a stored "Asian" against a list offering "South
 * Asian" and "East Asian" - is a narrowing, it invents detail she did not give, and chooseClosestOption
 * already refuses it because the extra word distinguishes the claim.
 */
const EEO_FEDERAL_RACE_CATEGORIES: ReadonlyArray<{ category: string; subgroup: RegExp }> = [
  { category: 'Asian', subgroup: /^(?:south|east|southeast|south east) asian$|^asian american$/ },
  { category: 'Black or African American', subgroup: /^(?:black|african american)$/ },
  { category: 'Hispanic or Latino', subgroup: /^(?:hispanic|latino|latina|latinx|latino\/a|hispanic\/latino)$/ },
  { category: 'Native Hawaiian or Other Pacific Islander', subgroup: /^(?:native hawaiian|pacific islander)$/ },
  { category: 'American Indian or Alaska Native', subgroup: /^(?:american indian|alaskan? native)$/ },
  { category: 'White', subgroup: /^(?:white|caucasian)$/ },
  { category: 'Two or More Races', subgroup: /^(?:multiracial|multi racial|biracial|bi racial|mixed race|two or more races)$/ },
];

/**
 * The single federal category that wholly contains a stored race value, or undefined.
 *
 * Undefined when NO category claims it and, just as deliberately, when more than one does: two
 * claimants is the ambiguity the rule above exists to refuse, and it must fail closed if this table
 * is ever extended carelessly.
 */
export function eeoFederalRaceCategory(stored: string): string | undefined {
  const key = comparableOption(stored);
  if (!key) return undefined;
  const claimed = EEO_FEDERAL_RACE_CATEGORIES.filter((entry) => entry.subgroup.test(key));
  if (claimed.length !== 1) return undefined;
  // Already the category itself: nothing to widen, and the exact stage would have taken it anyway.
  return comparableOption(claimed[0].category) === key ? undefined : claimed[0].category;
}

/**
 * The ranked forms of one EEO answer, best first.
 *
 * Her own words stay at the head, so a free-text control still gets exactly what she wrote and a
 * list that carries her own wording matches it before anything coarser. The federal category comes
 * next, and the decline wordings come LAST, for the same reason "Other" is last on the referral
 * ladder: a truthful specific answer must never be displaced by a catch-all.
 */
export function eeoAnswerLadder(label: string, stored: string): string[] {
  const base = stored.trim();
  if (!base) return [];
  const coarser = EEO_RACE_QUESTION.test(label) && !EEO_HISPANIC_QUESTION.test(label)
    ? eeoFederalRaceCategory(base)
    : undefined;
  // When the answer is a refusal AND the control names its vocabulary, the vocabulary's own
  // spelling goes ahead of everything: it is the same refusal she gave, written the way the list
  // writes it, so it can only ever replace a decline with the same decline.
  const vocabulary = isDeclineToState(base) ? selfIdentificationDeclineWording(label) : undefined;
  return vocabulary
    ? ladder(vocabulary, base, coarser, ...DECLINE_WORDINGS)
    : ladder(base, coarser, ...DECLINE_WORDINGS);
}

/**
 * The option that carries an EEO answer, or null.
 *
 * Two stages. The ladder goes through the ordinary conservative matcher first, so an option that
 * states her answer wins whenever the list has one, and a list carrying two differently worded
 * refusals is settled there too, by DECLINE_WORDINGS order. Only if nothing on the list can hold
 * what she said does the intent matcher answer for it, and then only when EXACTLY ONE option reads
 * as a refusal, because at that point there is nothing left to rank two look-alikes by and picking
 * between them by DOM order is the guess this module exists to refuse.
 *
 * Substituting the opt-out is not putting words in her mouth. It is the answer the employer wrote
 * into its own list for precisely this case, it states nothing about her that is not true, and the
 * alternative is a required field left blank on a voluntary question, which blocks the whole
 * application over the one family where a correct answer is guaranteed to exist.
 */
/* ---- accepting a consent control ----
 *
 * A consent is usually a checkbox, but discovery reports it as a select or a radio pair often
 * enough that "assume checkbox" is not a plan: "I agree" / "I do not agree" is a real shape on real
 * forms, and so is a bare Yes/No.
 *
 * chooseClosestOption must not be used for this family. Its inexact stages rank on how much an
 * option adds to the answer, and against ["I agree", "I do not agree"] the answer "Yes" adds words
 * to both of them; the stage is written to refuse an ambiguous list, but "refuses today" is not the
 * guarantee this family needs. A verifier bug found in this repo on 2026-08-11 accepted the exact
 * opposite of what a control held, and the cost of that here is an application on which the
 * applicant appears to have REFUSED the employer's privacy notice, or agreed to something she did
 * not. So the accepting option is identified by its own closed vocabulary, or not at all.
 */

/* The two option wordings live in questionDiscovery.ts beside the rest of the consent grammar,
 * because refreshKnownQuestionAnswers needs them too and this module imports that one. */

/**
 * The one option on a consent control that ACCEPTS it, or null.
 *
 * Fails closed on every kind of doubt, and the third condition is the one that matters most: every
 * option must be recognised as either accepting or refusing. A list carrying an entry this file
 * cannot read is a list whose meaning is not established, and a required consent left empty is work
 * for the applicant, while a wrongly-selected one is a legal answer given in her name that she
 * never gave.
 *
 * An empty option list is not a failure. It is what a checkbox and a free-text control report, and
 * the caller fills those with the plain acceptance value.
 */
export function chooseConsentOption(rawOptions: readonly string[] | null | undefined): string | null {
  const options = usableOptions(rawOptions);
  if (options.length === 0) return null;
  const accepting: string[] = [];
  let refusing = 0;
  for (const option of options) {
    const key = comparableOption(option);
    // Tested for refusal FIRST. "I do not agree" contains "agree", so an accept-shaped read of it
    // is exactly the inversion this function exists to make impossible.
    if (isConsentRefusingWording(key)) {
      refusing += 1;
      continue;
    }
    if (isConsentAcceptingWording(key)) accepting.push(option);
  }
  if (accepting.length !== 1) return null;
  if (accepting.length + refusing !== options.length) return null;
  return accepting[0];
}

/**
 * What goes into a consent control, or null when Litos may not or cannot accept it.
 *
 * Null covers three different things and every one of them ends the same way, held: the applicant
 * has granted no standing permission, the label is not in the consent class, or the control's
 * accepting value could not be identified. The caller never has to tell them apart.
 */
export function consentAcceptanceValue(
  label: string,
  ap: ApplicationProfileLike,
  options: readonly string[] | null | undefined,
  employerContext?: string,
): string | null {
  // No normalization here on purpose: consentLabelSpelling inside the predicate is the one place
  // that decides how a label is spelled, so every caller may pass whatever form it holds.
  const accepted = consentAcknowledgementAnswer(label, ap, employerContext);
  if (!accepted) return null;
  if (usableOptions(options).length === 0) return accepted.value;
  return chooseConsentOption(options);
}

export function chooseEeoOption(
  label: string,
  stored: string,
  rawOptions: readonly string[] | null | undefined,
): string | null {
  const options = usableOptions(rawOptions);
  if (options.length === 0) return null;
  const stated = chooseClosestOption(eeoAnswerLadder(label, stored), options);
  if (stated) return stated;
  const declines = options.filter((option) => isDeclineToState(option));
  return declines.length === 1 ? declines[0] : null;
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
      /* The same ladder graduation_date gets, and for the reason resolveKnownAnswer's
       * graduationYearFieldAnswer now needs it: `base` is "May 2028" whenever the profile states a
       * month, because a date picker cannot be driven by a bare year. The ladder is what keeps that
       * from costing anything on a CLOSED list - graduationDateLadder ends with the bare year, and
       * chooseClosestOption runs its exact-match pass over every candidate before any inexact
       * stage, so a select offering "2028" still selects "2028" rather than falling through to a
       * calendar bucket. When the profile holds no month the ladder collapses to [year], which is
       * exactly what this case returned before.
       *
       * Only the ladder, never the head: `base` stays first, so a free-text control still gets the
       * resolver's own answer. */
      return ladder(base, ...graduationDateLadder(ap.grad_date ?? base, ap.grad_year));
    case 'graduation_date':
      return ladder(base, ...graduationDateLadder(ap.grad_date ?? base, ap.grad_year));
    case 'current_enrollment':
      return /^yes$/i.test(base)
        ? ladder(base, 'Yes, I am currently enrolled', 'Currently enrolled', 'Enrolled')
        : ladder(base, 'No, I am not currently enrolled', 'Not enrolled');
    case 'study_year':
      return ladder(base, ...studyYearLadder(base));
    case 'referral_source_default':
      return ladder(
        base,
        ...referralSourceLadder(
          referralSourceForApplication(ap.referral_source_default, ap.referral_source_evidence),
          ap.referral_source_evidence,
        ),
      );
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
  // Before the profile-backed keys, because classifyField returns null for every EEO label by
  // design (questionDiscovery short-circuits them), so the ladder would otherwise be [base] and the
  // second and third attempts this function exists to supply would not exist for the one family
  // whose stored wording is least likely to be the employer's.
  if (EEO_QUESTION.test(label)) return eeoAnswerLadder(label, base);
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
  /* Passed straight through to resolveKnownAnswer, which is the only thing that reads it. See the
     parameter's own note there: it is where the POSTING is, and omitting it only ever refuses. */
  postingCountry?: JobCountry,
  postingCountryCode?: string,
): ResolvedProfileField | null {
  const label = normalizeDiscoveredLabel(shape.label);
  if (!label) return null;
  /* The option list goes IN as well as being matched against on the way out, and only one rule
     reads it there. A declared absence of standardized test scores has no canonical spelling, so
     the resolver needs the form's own list to say it; everything else is decided from the label and
     the profile, and then snapped onto the list below exactly as before. */
  const known = resolveKnownAnswer(label, shape.inputType ?? 'text', ap, jdText, postingCountry, postingCountryCode, shape.options ?? undefined);
  if (!known || !('value' in known)) return null;
  const base = known.value.trim();
  if (!base) return null;
  const key = profileFieldIntent(label);
  // Self-identification has its own ladder and its own matcher: classifyField declines every EEO
  // label on purpose, so `key` is null here and the generic path would offer the stored wording and
  // nothing else. See the EEO section above for why the opt-out is a legitimate second choice on
  // this family and on no other.
  const eeo = EEO_QUESTION.test(label);
  /* A CONSENT CONTROL GETS ITS OWN MATCHER, for the reason chooseConsentOption's header gives: the
   * generic one ranks options by how much they add to the answer, and "I agree" and "I do not
   * agree" add the same words to "Yes".
   *
   * GATED ON THE PERMISSION, NOT ON THE GRAMMAR, and the difference is a real defect this branch
   * had. It previously tested `isConsentAcknowledgementQuestion(label)` alone, on the reasoning that
   * reaching here at all meant resolveKnownAnswer had produced a value and therefore the permission
   * was on the row. That does not follow: resolveKnownAnswer can answer a consent-shaped label from
   * some OTHER handler with no permission present, and this branch would then swap main's
   * chooseClosestOption for chooseConsentOption underneath it. That is a behaviour change with the
   * permission off, which is the one thing this feature promises never to do. So the gate is now
   * the same call the resolver and the pre-script make, and there is one gate rather than three. */
  if (consentAcknowledgementAnswer(label, ap, jdText)) {
    const chosen = chooseConsentOption(shape.options);
    return {
      key,
      // No option list is a checkbox or a free-text control: the plain acceptance value is right.
      // A list Litos could not read leaves the base value with matchedOption false, which is the
      // signal the runner turns into "left for you" rather than selecting something.
      value: chosen ?? base,
      candidates: [base],
      matchedOption: usableOptions(shape.options).length === 0 ? false : chosen !== null,
    };
  }
  const candidates = eeo ? eeoAnswerLadder(label, base) : profileFieldCandidates(key, ap, base);
  let matched = eeo ? chooseEeoOption(label, base, shape.options) : chooseClosestOption(candidates, shape.options);
  if (key === 'referral_source_default' && matched === null) {
    // The employer's own site, under the employer's own name for it. Only reached once the standard
    // wordings have all missed, and only when the evidenced source really is the career site; the
    // list has to say which entry that is, and say it unambiguously. See employerOwnSiteOption.
    const evidenced = referralSourceForApplication(ap.referral_source_default, ap.referral_source_evidence);
    if (isCompanySiteReferralClaim(evidenced)) {
      matched = employerOwnSiteOption(usableOptions(shape.options)) ?? null;
    }
  }
  if (key === 'referral_source_default' && usableOptions(shape.options).length > 0 && matched === null) {
    return null;
  }
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
  postingCountry?: JobCountry,
  postingCountryCode?: string,
): string[] {
  const out: string[] = [];
  for (const blocker of blockers) {
    const label = blocker.match(REQUIRED_BLOCKER_RE)?.[1];
    if (!label) continue;
    if (resolveProfileField({ label }, ap, jdText, postingCountry, postingCountryCode)) out.push(label);
  }
  return [...new Set(out)];
}
