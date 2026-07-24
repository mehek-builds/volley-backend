import type { Page } from 'playwright-core';
import {
  resolveSalary,
  storedSalaryOf,
  type StoredSalaryProfile,
} from './salary';

// R-055 fix: the dashboard-driven submission flow used to never discover a posting's custom
// questions (GPA, sponsorship, GitHub, essays, ...) - only the Chrome extension did, client-side.
// This module ports the extension's PURE (DOM-free) classification logic from
// student-outreach-extension/src/lib/adapters/generic.ts so the two paths answer a question
// identically instead of drifting. Two copies of these regexes have burned this codebase before
// (see the comments below, which are carried over verbatim from the source) - keep the two files
// in sync by hand until they can share a package.
//
// Scope, deliberately narrower than the extension: this only discovers and answers TEXT-shaped
// controls (input[text|email|tel|url|number|date], textarea), matching the extension's own
// candidateInputs() scope and this backend's existing fillReviewedQuestions(), which already never
// clicks a select/radio/checkbox. Select/radio/checkbox questions stay exactly where they already
// were: unanswered, surfaced as a blocker for the human. Guessing the wrong option on a live form
// is a harm the student cannot undo; an unanswered field she resolves in seconds is not (same
// doctrine as buildManagedPortalActions' "Deliberately NOT attempted" comment on choice controls).

export type ApplicationProfileLike = StoredSalaryProfile & {
  phone?: string;
  address_city?: string;
  address_state?: string;
  address_country?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
  citizenship?: string;
  date_of_birth?: string;
  availability_date?: string;
  availability_term?: string;
  gpa?: string;
  gpa_scale?: string;
  major?: string;
  referral_source_default?: string;
};

const NEVER_FILL_PATTERNS = [/social security/i, /\bssn\b/i, /driver'?s?\s*licen[sc]e/i];

// See WORK_ELIGIBILITY_QUESTION in the extension's generic.ts: work authorization AND sponsorship
// are location-scoped questions the profile cannot answer with a single global flag (R-004, a
// false legal declaration shipped on a live application). Litos never answers either, here or
// client-side - this question is always left for the human.
export const WORK_ELIGIBILITY_QUESTION =
  /authori[sz](?:ed|ation)\s+to\s+work|legally\s+authori[sz]ed|right\s+to\s+work|work\s+authori[sz]|(?:requir\w*|need\w*|visa|immigration|without|employment)\s+(?:\w+\s+){0,3}sponsor|sponsor\w*\s+(?:\w+\s+){0,3}(?:requir\w*|need\w*)/i;

export const EEO_QUESTION =
  /\bgender\b|what is your sex\b|race|ethnicit|hispanic|latino|veteran|military|disab|sexual orientation|communities|identify with|current age|what is your age|age range|how old are you|\bage group\b/i;

export function workEligibilitySkipReason(label: string): string {
  return `work-eligibility question left for you: "${label.slice(0, 60)}"`;
}

export function isRefusedQuestion(label: string): boolean {
  const l = label ?? '';
  return NEVER_FILL_PATTERNS.some((re) => re.test(l)) || WORK_ELIGIBILITY_QUESTION.test(l) || EEO_QUESTION.test(l);
}

const RESIDENCE_QUESTION =
  /country of residence|which country|country you.{0,20}(based|resid|work from|located)|where are you based|based in which country|current country|country.{0,20}(residing|residence)|\bcountry\b/i;
const LOCATION_COMMITMENT_STEM = /\b(?:are|can|could|do|did|will|would|should|may|might|have)\s+you\b/i;
const LOCATION_COMMITMENT_VOCAB = /\boffice\b|in[\s-]?office|on[\s-]?site|\bonsite\b|\bhybrid\b|relocat|commut/i;

export function isLocationCommitmentQuestion(label: string): boolean {
  return LOCATION_COMMITMENT_STEM.test(label) && LOCATION_COMMITMENT_VOCAB.test(label);
}

export const REFERRAL_QUESTION = /how did you hear|referral source|hear about (this|us|the)|source of/i;
export const START_DATE_QUESTION = /availab|start(ing)?\s+date|date.*you.*start|when can you start|earliest.*start/i;
const TERM_QUESTION =
  /(length|duration|term)\b.*\bavailab|availab.*\b(length|duration|term)\b|how long.*(available|intern|stay|commit)|(weeks|months).*\b(available|internship|commit)|\bterm\s*\/?\s*length/i;
const SALARY_QUESTION = /salary|compensat|desired pay|expected pay|pay expectation/i;
const DOB_QUESTION = /date of birth|birth\s*date|\bdob\b/i;
const CITIZENSHIP_QUESTION = /citizen|nationalit/i;

const NATIONALITY_TO_COUNTRY: Record<string, string> = {
  indian: 'India', american: 'United States', emirati: 'United Arab Emirates',
  british: 'United Kingdom', canadian: 'Canada', chinese: 'China', pakistani: 'Pakistan',
  filipino: 'Philippines', nigerian: 'Nigeria', german: 'Germany', french: 'France',
  singaporean: 'Singapore', australian: 'Australia', mexican: 'Mexico', brazilian: 'Brazil',
  japanese: 'Japan', korean: 'South Korea', irish: 'Ireland', spanish: 'Spain', italian: 'Italy',
};

export type ProfileKey =
  | 'phone' | 'address_city' | 'address_state' | 'address_country'
  | 'linkedin_url' | 'github_url' | 'portfolio_url' | 'citizenship' | 'date_of_birth'
  | 'availability_date' | 'availability_term' | 'desired_salary'
  | 'gpa' | 'gpa_scale' | 'major' | 'referral_source_default';

// Ported verbatim from generic.ts's classifyField (see that file for the full rationale on
// ordering - refusals first, citizenship before residence, term before start date, state before
// city). `label` must already be lowercased by the caller.
export function classifyField(label: string, type?: string): ProfileKey | null {
  const l = label ?? '';
  if (isRefusedQuestion(l)) return null;
  if (type === 'tel') return 'phone';

  const locationCommitment = isLocationCommitmentQuestion(l);

  if (CITIZENSHIP_QUESTION.test(l)) return 'citizenship';
  if (!locationCommitment && RESIDENCE_QUESTION.test(l)) return 'address_country';

  if (REFERRAL_QUESTION.test(l)) return 'referral_source_default';
  if (SALARY_QUESTION.test(l)) return 'desired_salary';
  if (DOB_QUESTION.test(l)) return 'date_of_birth';
  if (TERM_QUESTION.test(l)) return 'availability_term';
  if (START_DATE_QUESTION.test(l)) return 'availability_date';

  if (/linkedin/i.test(l)) return 'linkedin_url';
  if (/github/i.test(l)) return 'github_url';
  if (/portfolio|personal\s*(web)?site|\bwebsite\b/i.test(l)) return 'portfolio_url';

  if (/\bgpa\b|grade average|grade point/i.test(l)) return 'gpa';
  if (/gpa scale|out of.*(4\.0|100)|grading scale/i.test(l)) return 'gpa_scale';
  if (/\bmajor\b|field of study|course of study|degree subject/i.test(l)) return 'major';

  if (/phone|mobile/i.test(l)) return 'phone';
  if (
    !locationCommitment &&
    /\b(state|province|prefecture)\b(?!\s+(?:your|the|you|it|why|how|what|when|where))|state\s*\/\s*province/i.test(l)
  )
    return 'address_state';
  if (
    !locationCommitment &&
    /\b(city|town)\b|\blocation\b|where are you (currently )?(located|living|based)|current location|where do you live/i.test(l)
  )
    return 'address_city';

  return null;
}

// EEO / demographics: exact-match-only (Mehek's 2026-07-17 ruling, R-018). Ported verbatim.
export function eeoAnswer(pref: string | undefined): string {
  return pref && pref.trim() ? pref.trim() : 'Decline to self-identify';
}

// Ported from isOpenEndedQuestion (R-033): does the label read like a prompt for prose, not a
// field being named? Callers must ALSO check classifyField/isRefusedQuestion before drafting.
export function isOpenEndedQuestion(label: string): boolean {
  const l = (label ?? '').trim().toLowerCase();
  if (!l) return false;
  if (
    /\b(why\b|describ\w+|explain\w*|tell (?:us|me)\b|share\b|elaborat\w+|discuss\b|sentences?\b|paragraphs?\b|in your own words|what interest\w*|what excit\w*|what motivat\w*|what makes\b|how (?:did|do|would|have) you|brief note\b|note on\b|you (?:most )?enjoy\b)/.test(l)
  )
    return true;
  return l.includes('?') && l.length >= 40;
}

// The largest whole-sentence prefix of `text` that fits `maxLen`, or null when no real sentence
// does (never clip mid-word/mid-clause - ported from fitToBudget, R-029).
export function fitToBudget(text: string, maxLen: number): string | null {
  const t = text.trim();
  if (maxLen <= 0 || t.length <= maxLen) return t || null;
  const slice = t.slice(0, maxLen);
  let lastEnd = -1;
  const re = /[.!?](?=\s|$)/g;
  for (let m = re.exec(slice); m; m = re.exec(slice)) lastEnd = m.index;
  if (lastEnd < 40) return null;
  return slice.slice(0, lastEnd + 1).trim();
}

export type DiscoveredQuestion = {
  label: string;
  selector: string;
  inputType: string;
  maxLength: number | null;
};

// Passed to page.evaluate() as a source STRING rather than a typed function: this backend's
// tsconfig has no "dom" lib (it is a Node project), so a typed function here would need
// document/HTMLElement/getComputedStyle typed against a lib this project deliberately doesn't
// pull in project-wide. Playwright evaluates a string in the live page exactly like a function -
// the real browser DOM Playwright is driving has the same APIs the extension's own
// candidateInputs()/questionLabel() rely on, so this is a straight port of that discovery logic,
// not new logic. Deliberately excludes select/radio/checkbox (see module header). Keep this in
// sync with the extension source by hand, the same as any other ported function in this file.
const DISCOVER_QUESTIONS_SCRIPT = String.raw`(() => {
  function clean(s) {
    return (s == null ? '' : s).replace(/[​‌‍﻿ ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function isVisible(el) {
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    var style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }
  function isHoneypot(el) {
    var name = (el.getAttribute('name') || '').toLowerCase();
    var id = (el.id || '').toLowerCase();
    if (/\b(honeypot|hp_|bot[-_]?field|hidden[-_]?field)\b/.test(name + ' ' + id)) return true;
    var style = getComputedStyle(el);
    var rect = el.getBoundingClientRect();
    return style.opacity === '0' || (rect.width <= 1 && rect.height <= 1);
  }
  function questionLabel(el) {
    var fieldset = el.closest('fieldset');
    var legend = fieldset ? fieldset.querySelector('legend') : null;
    var legendText = legend && legend.textContent ? legend.textContent.trim() : '';
    if (legendText) return legendText.toLowerCase();
    var group = el.closest('[role="group"], [role="radiogroup"]');
    var groupLabel = group ? group.getAttribute('aria-label') : null;
    if (groupLabel) return groupLabel.toLowerCase();
    var labelEl = (el.labels && el.labels[0]) || (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
    var labelText = labelEl && labelEl.textContent ? labelEl.textContent : '';
    var parts = [
      labelText || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('name') || '',
      el.id || '',
    ];
    var own = clean(parts.join(' ')).toLowerCase();
    if (own) return own;
    var block = el.closest('div, section, li');
    var fallback = block ? block.querySelector('label, legend, .question, h3, h4') : null;
    return ((fallback && fallback.textContent) || '').toLowerCase().trim();
  }

  var els = Array.prototype.slice
    .call(
      document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input:not([type]), textarea',
      ),
    )
    .filter(function (el) {
      return !el.closest('[id*="litos"]') && !el.disabled && !el.readOnly && isVisible(el) && !isHoneypot(el);
    });

  var out = [];
  var counter = 0;
  for (var i = 0; i < els.length; i += 1) {
    var el = els[i];
    var label = clean(questionLabel(el));
    if (!label) continue;
    counter += 1;
    var marker = 'data-litos-discovered-' + counter;
    el.setAttribute(marker, '1');
    out.push({
      label: label,
      selector: '[' + marker + ']',
      inputType: el.tagName === 'TEXTAREA' ? 'textarea' : (el.type || 'text'),
      maxLength: el.maxLength > 0 ? el.maxLength : null,
    });
  }
  return out;
})()`;

export async function discoverPageQuestions(page: Page): Promise<DiscoveredQuestion[]> {
  return page.evaluate(DISCOVER_QUESTIONS_SCRIPT);
}

// Resolves a discovered question's answer from the stored profile, without touching the LLM.
// Returns null for anything that isn't a confidently-known field (including every refused
// question), so the caller can fall through to the essay drafter or leave it for the human.
export function resolveKnownAnswer(
  label: string,
  inputType: string,
  ap: ApplicationProfileLike,
  jdText: string | undefined,
): { value: string } | { skipReason: string } | null {
  if (isRefusedQuestion(label)) {
    return WORK_ELIGIBILITY_QUESTION.test(label) ? { skipReason: workEligibilitySkipReason(label) } : null;
  }

  const key = classifyField(label, inputType === 'tel' ? 'tel' : undefined);
  switch (key) {
    case 'citizenship': {
      if (!ap.citizenship) return null;
      const country = NATIONALITY_TO_COUNTRY[ap.citizenship.trim().toLowerCase()];
      return { value: country ?? ap.citizenship };
    }
    case 'address_country':
      return ap.address_country ? { value: ap.address_country } : null;
    case 'address_state':
      return ap.address_state ? { value: ap.address_state } : null;
    case 'address_city':
      return ap.address_city ? { value: ap.address_city } : null;
    case 'phone':
      return ap.phone ? { value: ap.phone } : null;
    case 'linkedin_url':
      return ap.linkedin_url ? { value: ap.linkedin_url } : null;
    case 'github_url':
      return ap.github_url ? { value: ap.github_url } : null;
    case 'portfolio_url':
      return ap.portfolio_url ? { value: ap.portfolio_url } : null;
    case 'referral_source_default':
      return ap.referral_source_default ? { value: ap.referral_source_default } : { value: 'Company website' };
    case 'desired_salary': {
      const salary = resolveSalary(
        { label, field: inputType === 'number' ? 'numeric' : 'freetext', jdText },
        storedSalaryOf(ap),
      );
      return salary.action === 'fill' ? { value: salary.value } : { skipReason: salary.reason };
    }
    case 'date_of_birth':
      return ap.date_of_birth ? { value: ap.date_of_birth } : null;
    case 'availability_term':
      return ap.availability_term ? { value: ap.availability_term } : null;
    case 'availability_date':
      return ap.availability_date ? { value: ap.availability_date } : null;
    case 'gpa':
      return ap.gpa ? { value: ap.gpa } : null;
    case 'gpa_scale':
      return ap.gpa_scale ? { value: ap.gpa_scale } : null;
    case 'major':
      return ap.major ? { value: ap.major } : null;
    default:
      return null;
  }
}
