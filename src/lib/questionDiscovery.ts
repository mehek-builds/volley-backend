import type { Page } from 'playwright-core';
import { isOpaqueIdentifier, tidyLabel } from './fieldLabel';
import type { SupportedPortal } from './portalSubmission';
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
// Scope: the discovery pass still surfaces text-shaped controls
// (input[text|email|tel|url|number|date], textarea). Once a stored or reviewed answer exists, the
// managed runner may apply it to the live control it finds, including scoped select/radio/checkbox
// controls. Values that are not stored here still stay blank, and SSN/driver-license fields remain
// hard-blocked.

export type ApplicationProfileLike = StoredSalaryProfile & {
  phone?: string;
  address_city?: string;
  address_state?: string;
  address_country?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
  citizenship?: string;
  work_authorized?: boolean;
  needs_sponsorship?: boolean;
  date_of_birth?: string;
  availability_date?: string;
  availability_term?: string;
  school?: string;
  degree?: string;
  grad_date?: string;
  grad_year?: number;
  currently_enrolled?: boolean;
  gpa?: string;
  gpa_scale?: string;
  major?: string;
  eeo_prefs?: Record<string, string> | null;
  referral_source_default?: string;
};

const NEVER_FILL_PATTERNS = [/social security/i, /\bssn\b/i, /driver'?s?\s*licen[sc]e/i];

// See WORK_ELIGIBILITY_QUESTION in the extension's generic.ts: work authorization and sponsorship
// used to be globally refused after a false legal declaration shipped once (R-004). They are now
// answered only from explicit stored booleans, with ambiguous mixed wording still left to the user.
export const WORK_ELIGIBILITY_QUESTION =
  /(?:eligible|eligibility)\s+to\s+work|authori[sz](?:ed|ation)\s+to\s+work|legally\s+authori[sz]ed|right\s+to\s+work|work\s+authori[sz]|(?:requir\w*|need\w*|visa|immigration|without|employment)\s+(?:\w+\s+){0,3}sponsor|sponsor\w*\s+(?:\w+\s+){0,3}(?:requir\w*|need\w*)/i;
const WORK_AUTHORIZATION_QUESTION =
  /(?:eligible|eligibility)\s+to\s+work|authori[sz](?:ed|ation)\s+to\s+work|legally\s+authori[sz]ed|right\s+to\s+work|work\s+authori[sz]/i;
const SPONSORSHIP_QUESTION =
  /(?:requir\w*|need\w*|visa|immigration|without|employment)\s+(?:\w+\s+){0,3}sponsor|sponsor\w*\s+(?:\w+\s+){0,3}(?:requir\w*|need\w*)/i;
const SPONSORSHIP_WORK_AUTHORIZATION_SUPPORT_QUESTION =
  /\b(?:do|will|would|can|could)?\s*(?:you\s+)?(?:now\s+or\s+in\s+the\s+future\s+)?(?:requir\w*|need\w*)\b[^?]{0,80}\b(?:sponsor\w*|visa)\b[^?]{0,50}\bwork\s+authori[sz]ation\b/i;
const NON_US_WORK_SCOPE =
  /\b(canada|canadian|united kingdom|uk|britain|british|england|european union|eu|australia|australian|india|indian|united arab emirates|uae|dubai|singapore|germany|france|ireland|netherlands|japan|korea|china)\b/i;
const JOB_LOCATION_SCOPE = /country\s+(?:where|in which)\s+the\s+job\s+is\s+located|country\s+where\s+the\s+role\s+is\s+located|where\s+the\s+job\s+is\s+located/i;
const JD_US_SCOPE =
  /\b(united states|u\.s\.|usa|remote\s*\(us\)|san francisco|san mateo|mountain view|california|new york|austin|texas|washington|seattle|boston|massachusetts|chicago|illinois)\b/i;

export const EEO_QUESTION =
  /transgender|\bgender\b|what is your sex\b|race|racial|ethnicit|ethnic\b|hispanic|latino|veteran|military|disab|sexual orientation|communities|identify with|current age|what is your age|age range|how old are you|\bage group\b/i;
const LEGAL_CONSENT_QUESTION =
  /candidate privacy policy|information (?:i|you) have provided.*process|by selecting ["']?i agree|demographic data survey|collecting,\s*storing,\s*and processing/i;

export function workEligibilitySkipReason(label: string): string {
  return `work-eligibility question left for you: "${label.slice(0, 60)}"`;
}

function workEligibilityAnswer(
  label: string,
  ap: ApplicationProfileLike,
  jdText: string | undefined,
): { value: string } | { skipReason: string } | null {
  const asksAuthorization = WORK_AUTHORIZATION_QUESTION.test(label);
  const asksSponsorship = SPONSORSHIP_QUESTION.test(label);
  if (asksAuthorization && asksSponsorship && SPONSORSHIP_WORK_AUTHORIZATION_SUPPORT_QUESTION.test(label)) {
    if ((NON_US_WORK_SCOPE.test(label) || (JOB_LOCATION_SCOPE.test(label) && !JD_US_SCOPE.test(jdText ?? '')))) {
      return { skipReason: workEligibilitySkipReason(label) };
    }
    if (typeof ap.needs_sponsorship === 'boolean') {
      return { value: ap.needs_sponsorship ? 'Yes' : 'No' };
    }
    return { skipReason: workEligibilitySkipReason(label) };
  }
  if (!asksAuthorization && !asksSponsorship) return null;
  if (asksAuthorization && asksSponsorship) return { skipReason: workEligibilitySkipReason(label) };
  if ((asksAuthorization || asksSponsorship) && (NON_US_WORK_SCOPE.test(label) || (JOB_LOCATION_SCOPE.test(label) && !JD_US_SCOPE.test(jdText ?? '')))) {
    return { skipReason: workEligibilitySkipReason(label) };
  }
  if (asksAuthorization && typeof ap.work_authorized === 'boolean') {
    return { value: ap.work_authorized ? 'Yes' : 'No' };
  }
  if (asksSponsorship && typeof ap.needs_sponsorship === 'boolean') {
    return { value: ap.needs_sponsorship ? 'Yes' : 'No' };
  }
  return { skipReason: workEligibilitySkipReason(label) };
}

export function isRefusedQuestion(label: string): boolean {
  const l = label ?? '';
  return NEVER_FILL_PATTERNS.some((re) => re.test(l)) || WORK_ELIGIBILITY_QUESTION.test(l) || EEO_QUESTION.test(l);
}

function comparableAnswer(value: string): string {
  return value.trim().toLowerCase();
}

export function sensitiveQuestionRequiresAttention(
  label: string,
  answer: string,
  inputType: string,
  ap: ApplicationProfileLike,
  jdText: string | undefined,
): boolean {
  if (!isRefusedQuestion(label)) return false;
  if (NEVER_FILL_PATTERNS.some((re) => re.test(label))) return true;
  const known = resolveKnownAnswer(label, inputType, ap, jdText);
  return !(known && 'value' in known && comparableAnswer(known.value) === comparableAnswer(answer));
}

export function questionRequiresHumanAttention(question: { question: string; answer?: string }): boolean {
  const label = question.question ?? '';
  const answer = question.answer?.trim() ?? '';
  if (NEVER_FILL_PATTERNS.some((re) => re.test(label))) return true;
  if (WORK_ELIGIBILITY_QUESTION.test(label)) return !/^(yes|no)$/i.test(answer);
  if (EEO_QUESTION.test(label)) return answer.length === 0;
  return false;
}

export function refreshKnownQuestionAnswers<T extends { question: string; answer: string }>(
  questions: readonly T[],
  ap: ApplicationProfileLike,
  jdText: string | undefined,
): T[] {
  return questions.map((question) => {
    const label = normalizeReviewQuestionLabel(question.question);
    const known = label ? resolveKnownAnswer(label, 'text', ap, jdText) : null;
    return known && 'value' in known ? { ...question, answer: known.value } : question;
  });
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
export const GRADUATION_DATE_QUESTION =
  /\b(?:expected\s+)?graduat(?:ion|e)\s+(?:date|year)\b|\b(?:date|year)\s+(?:of\s+)?(?:expected\s+)?graduat(?:ion|e)\b|\bexpected\s+grad(?:uation)?\b|\bclass\s+of\b/i;
const MIXED_ENROLLMENT_GRADUATION_QUESTION = /\bcurrently\s+enrolled\b|\bdegree\s+program\b/i;
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
  | 'availability_date' | 'availability_term' | 'school' | 'degree' | 'graduation_date' | 'desired_salary'
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
  if (GRADUATION_DATE_QUESTION.test(l)) return 'graduation_date';
  if (START_DATE_QUESTION.test(l)) return 'availability_date';

  if (/linkedin/i.test(l)) return 'linkedin_url';
  if (/github/i.test(l)) return 'github_url';
  if (/portfolio|personal\s*(web)?site|\bwebsite\b/i.test(l)) return 'portfolio_url';

  if (/\bgpa\b|grade average|grade point/i.test(l)) return 'gpa';
  if (/gpa scale|out of.*(4\.0|100)|grading scale/i.test(l)) return 'gpa_scale';
  if (/\b(school|university|college|institution)\b/i.test(l)) return 'school';
  if (/\bdegree\b(?!\s+(?:program|subject))|education level|level of education/i.test(l)) return 'degree';
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

function eeoPreferenceForLabel(label: string, prefs: Record<string, string> | null | undefined): string | undefined {
  if (!prefs) return undefined;
  const l = label.toLowerCase();
  if (/transgender/.test(l)) return prefs.transgender_status ?? prefs.transgender;
  if (/gender|sex\b/.test(l)) return prefs.gender ?? prefs.sex;
  if (/hispanic|latino/.test(l)) return prefs.hispanic_ethnicity ?? prefs.hispanic ?? prefs.ethnicity;
  if (/race|racial|ethnicit|ethnic\b/.test(l)) return prefs.race ?? prefs.ethnicity;
  if (/veteran|military/.test(l)) return prefs.veteran_status ?? prefs.veteran;
  if (/disab/.test(l)) return prefs.disability_status ?? prefs.disability;
  if (/sexual orientation/.test(l)) return prefs.sexual_orientation;
  return undefined;
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

const MONTH_TO_NUMBER: Record<string, string> = {
  jan: '01', january: '01',
  feb: '02', february: '02',
  mar: '03', march: '03',
  apr: '04', april: '04',
  may: '05',
  jun: '06', june: '06',
  jul: '07', july: '07',
  aug: '08', august: '08',
  sep: '09', sept: '09', september: '09',
  oct: '10', october: '10',
  nov: '11', november: '11',
  dec: '12', december: '12',
};

export function graduationDateAnswer(
  gradDate: string | undefined,
  gradYear: number | undefined,
  inputType: string | undefined,
): string | null {
  const text = gradDate?.trim() || (gradYear ? String(gradYear) : '');
  if (!text) return null;
  if (inputType !== 'date') return text;
  const preferredYear = gradYear && gradYear > 0 ? String(gradYear) : undefined;
  const isoMatches = [...text.matchAll(/\b((?:19|20)\d{2})-(\d{2})(?:-\d{2})?\b/g)];
  const iso = isoMatches.find((match) => match[1] === preferredYear) ?? isoMatches.at(-1);
  if (iso) return `${iso[1]}-${iso[2]}-01`;
  const monthYearMatches = [...text.matchAll(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[^0-9]{0,20}\b((?:19|20)\d{2})\b/gi)];
  const monthYear = monthYearMatches.find((match) => match[2] === preferredYear) ?? monthYearMatches.at(-1);
  if (monthYear) return `${monthYear[2]}-${MONTH_TO_NUMBER[monthYear[1].toLowerCase()]}-01`;
  const year = preferredYear ?? text.match(/\b(?:19|20)\d{2}\b/g)?.at(-1) ?? '';
  if (!year) return null;
  const monthToken = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i)?.[0].toLowerCase();
  const month = monthToken ? MONTH_TO_NUMBER[monthToken] : '05';
  return `${year}-${month}-01`;
}

function graduationEvidenceIsFuture(gradDate: string | undefined, gradYear: number | undefined): boolean {
  const answer = graduationDateAnswer(gradDate, gradYear, 'date');
  if (!answer) return false;
  const time = Date.parse(answer);
  if (!Number.isFinite(time)) return false;
  return time >= Date.now();
}

function enrollmentConfirmedForGraduationDate(ap: ApplicationProfileLike): boolean {
  if (ap.currently_enrolled === true) return true;
  if (ap.currently_enrolled === false) return false;
  return graduationEvidenceIsFuture(ap.grad_date, ap.grad_year);
}

export type DiscoveredQuestion = {
  label: string;
  selector: string;
  inputType: string;
  maxLength: number | null;
};

export const REVIEW_QUESTION_TEXT_MAX_LENGTH = 500;

const INLINE_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const GREENHOUSE_QUESTION_HANDLE_RE = /\bquestion_\d+\b/gi;
const TRAILING_ANSWER_PLACEHOLDER_RE = /\s+(?:type|enter|write)\s+(?:your\s+)?(?:answer\s+)?here(?:\.{3}|…)?\s*$/i;

function collapseRepeatedLabel(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length % 2 !== 0) return value;
  const half = words.length / 2;
  const left = words.slice(0, half).join(' ').toLowerCase();
  const right = words.slice(half).join(' ').toLowerCase();
  return left === right ? words.slice(0, half).join(' ') : value;
}

/**
 * Managed Ashby discovery may concatenate visible label text, placeholder text, name, and id into
 * one string. Strip only positively identified provider handles and generic answer placeholders,
 * leaving the employer's full question intact for both display and label-based filling.
 */
export function normalizeDiscoveredLabel(raw: string): string {
  const withoutHandles = raw
    .replace(INLINE_UUID_RE, ' ')
    .replace(GREENHOUSE_QUESTION_HANDLE_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const withoutPlaceholder = withoutHandles.replace(TRAILING_ANSWER_PLACEHOLDER_RE, '').trim();
  const label = tidyLabel(collapseRepeatedLabel(withoutPlaceholder));
  return label && !isOpaqueIdentifier(label) ? label : '';
}

function truncateReviewQuestionLabel(label: string): string {
  if (label.length <= REVIEW_QUESTION_TEXT_MAX_LENGTH) return label;
  const clipped = label.slice(0, REVIEW_QUESTION_TEXT_MAX_LENGTH);
  const wholeWords = clipped.replace(/\s+\S*$/u, '').replace(/[.,;:!?]+$/u, '').trim();
  return wholeWords || clipped.trim();
}

export function normalizeReviewQuestionLabel(raw: string): string {
  const label = normalizeDiscoveredLabel(raw);
  return label ? truncateReviewQuestionLabel(label) : '';
}

function isFixedPortalProfileField(portal: SupportedPortal, label: string): boolean {
  const key = classifyField(label);
  if (portal === 'ashby') {
    return key === 'phone' || key === 'address_city' || key === 'linkedin_url'
      || key === 'github_url' || key === 'portfolio_url';
  }
  if (portal === 'lever') {
    return key === 'phone' || key === 'linkedin_url' || key === 'github_url' || key === 'portfolio_url';
  }
  if (portal === 'greenhouse' || portal === 'controlled_test') {
    return key === 'phone' || key === 'address_city';
  }
  if (portal === 'smartrecruiters') {
    return key === 'phone' || key === 'linkedin_url' || key === 'portfolio_url';
  }
  // Added 2026-07-29 with the three new fillable families. Each entry lists only the fields that
  // family's fixed selectors ALREADY fill - anything else the employer asks stays a real question for
  // the reviewed-answer path. Getting this wrong in the generous direction is the harmful one: a
  // field listed here but not actually filled is silently dropped from the question list and then
  // never answered by anyone.
  if (portal === 'rippling' || portal === 'controlled_rippling') {
    return key === 'phone';
  }
  if (portal === 'breezy' || portal === 'controlled_breezy') {
    return key === 'phone' || key === 'address_city';
  }
  if (portal === 'bamboohr' || portal === 'controlled_bamboohr') {
    return key === 'phone' || key === 'address_city' || key === 'linkedin_url' || key === 'portfolio_url';
  }
  return false;
}

/** Normalize legacy provider labels and remove controls already owned by fixed portal selectors. */
export function normalizeStoredPortalQuestions<T extends { question: string; answer: string }>(
  questions: readonly T[],
  portal: SupportedPortal,
): T[] {
  const normalized: T[] = [];
  const indexByLabel = new Map<string, number>();
  for (const question of questions) {
    const label = normalizeDiscoveredLabel(question.question);
    if (!label || isFixedPortalProfileField(portal, label)) continue;
    const reviewLabel = normalizeReviewQuestionLabel(label);
    if (!reviewLabel) continue;
    const key = reviewLabel.toLowerCase();
    const next = { ...question, question: reviewLabel };
    const existingIndex = indexByLabel.get(key);
    if (existingIndex === undefined) {
      indexByLabel.set(key, normalized.length);
      normalized.push(next);
    } else if (!normalized[existingIndex].answer.trim() && next.answer.trim()) {
      normalized[existingIndex] = next;
    }
  }
  return normalized;
}

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
  const workEligibility = workEligibilityAnswer(label, ap, jdText);
  if (workEligibility) return workEligibility;

  if (EEO_QUESTION.test(label)) {
    return { value: eeoAnswer(eeoPreferenceForLabel(label, ap.eeo_prefs)) };
  }

  if (LEGAL_CONSENT_QUESTION.test(label)) {
    return { value: /i agree/i.test(label) ? 'I agree' : 'Yes' };
  }

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
    case 'school':
      return ap.school ? { value: ap.school } : null;
    case 'degree':
      return ap.degree ? { value: ap.degree } : null;
    case 'graduation_date': {
      if (MIXED_ENROLLMENT_GRADUATION_QUESTION.test(label) && !enrollmentConfirmedForGraduationDate(ap)) {
        return { skipReason: `enrollment/graduation date question left for you: "${label.slice(0, 60)}"` };
      }
      const value = graduationDateAnswer(ap.grad_date, ap.grad_year, inputType);
      return value ? { value } : null;
    }
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
