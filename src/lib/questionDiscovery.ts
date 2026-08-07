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
  full_name?: string;
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
  current_employer?: string;
  most_recent_employer?: string;
  employer_history?: string[];
  school?: string;
  degree?: string;
  grad_date?: string;
  grad_year?: number;
  currently_enrolled?: boolean;
  gpa?: string;
  gpa_scale?: string;
  major?: string;
  languages?: string[] | null;
  skills?: string[] | null;
  eeo_prefs?: Record<string, string> | null;
  referral_source_default?: string;

  /* ---- application facts asked once in onboarding ----
   *
   * See db/schema.ts for the measured counts behind each one. The rule for every field here is the
   * same and is not negotiable: `undefined` means NEVER ASKED, and a question with nothing stored
   * is left for the applicant rather than answered from something adjacent. These are
   * self-declarations and consents; a default value for any of them is Litos making a statement to
   * an employer on the student's behalf that she never made.
   */
  pronouns?: string;
  legal_first_name?: string;
  preferred_first_name?: string;
  high_school_grad_date?: string;
  // [] is a real answer meaning "I have not applied anywhere before". undefined is "never asked".
  prior_application_employers?: string[];
  has_outstanding_offers?: boolean;
  outstanding_offer_details?: string;
  military_service?: string;
  politically_exposed?: string;
  politically_exposed_family?: string;
  advanced_study_plan?: 'no' | 'considering' | 'committed';
  attest_truthful_information?: boolean;
  accept_privacy_notices?: boolean;
};

const NEVER_FILL_PATTERNS = [
  /social security/i,
  /\bssn\b/i,
  /driver'?s?\s*licen[sc]e/i,
  /\bcaptcha\b|recaptcha|hcaptcha|human verification/i,
  /\brecord(?:ing|ed)?\s+consent\b|\bconsent\b[^?]{0,80}\b(?:record|recording|recorded)\b|\b(?:record|recording|recorded)\b[^?]{0,80}\bconsent\b/i,
];

// See WORK_ELIGIBILITY_QUESTION in the extension's generic.ts: work authorization and sponsorship
// used to be globally refused after a false legal declaration shipped once (R-004). They are now
// answered only from explicit stored booleans, with ambiguous mixed wording still left to the user.
export const WORK_ELIGIBILITY_QUESTION =
  /(?:eligible|eligibility)\s+(?:to\s+)?(?:legally\s+)?work|authori[sz](?:ed|ation)\s+to\s+work|legally\s+authori[sz]ed|right\s+to\s+work|work\s+authori[sz]|(?:requir\w*|need\w*|visa|immigration|without|employment)\s+(?:\w+\s+){0,3}sponsor|sponsor\w*\s+(?:\w+\s+){0,3}(?:requir\w*|need\w*)/i;
const WORK_AUTHORIZATION_QUESTION =
  /(?:eligible|eligibility)\s+(?:to\s+)?(?:legally\s+)?work|authori[sz](?:ed|ation)\s+to\s+work|legally\s+authori[sz]ed|right\s+to\s+work|work\s+authori[sz]/i;
const SPONSORSHIP_QUESTION =
  /(?:requir\w*|need\w*|visa|immigration|without|employment)\s+(?:\w+\s+){0,3}sponsor|sponsor\w*\s+(?:\w+\s+){0,3}(?:requir\w*|need\w*)/i;
const SPONSORSHIP_WORK_AUTHORIZATION_SUPPORT_QUESTION =
  /\b(?:do|will|would|can|could)?\s*(?:you\s+)?(?:now\s+or\s+in\s+the\s+future\s+)?(?:requir\w*|need\w*)\b[^?]{0,80}\b(?:sponsor\w*|visa)\b[^?]{0,50}\bwork\s+authori[sz]ation\b/i;
const NON_US_WORK_SCOPE =
  /\b(canada|canadian|united kingdom|uk|britain|british|england|european union|eu|australia|australian|india|indian|united arab emirates|uae|dubai|singapore|germany|france|ireland|netherlands|hungary|hungarian|japan|korea|china)\b/i;
const JOB_LOCATION_SCOPE = /country\s+(?:where|in which)\s+the\s+job\s+is\s+located|country\s+where\s+the\s+role\s+is\s+located|where\s+the\s+job\s+is\s+located/i;
const JD_US_SCOPE =
  /\b(united states|u\.s\.|usa|remote\s*\(us\)|san francisco|san mateo|mountain view|california|new york|austin|texas|washington|seattle|boston|massachusetts|chicago|illinois)\b/i;
const ROUTINE_APPLICANT_CONSENT_QUESTION =
  /\b(?:consent|agree|acknowledg\w*|approve|confirm)\b[\s\S]{0,180}\b(?:process(?:ing)?|use|using|collect(?:ion)?|retain|store|privacy\s+policy|privacy\s+notice|notice\s+at\s+collection)\b[\s\S]{0,180}\b(?:personal\s+information|personal\s+data|application|applicant|candidacy|candidate|privacy\s+policy|privacy\s+notice|notice\s+at\s+collection|infrastructure|platform|data)\b|\bplease\s+review\s+and\s+acknowledg\w*\b[\s\S]{0,120}\b(?:candidate|applicant)\s+privacy\s+(?:policy|notice)\b|\byes,\s*i\s+consent\b/i;

export const EEO_QUESTION =
  /transgender|\bgender\b|what is your sex\b|race|racial|ethnicit|ethnic\b|hispanic|latino|veteran|military|disab|sexual orientation|lgbtq|lgbtqia|communities|which categories describe you|identify with|current age|what is your age|age range|how old are you|\bage group\b/i;
const AGE_ATTESTATION_QUESTION =
  /(?:\b18\+\s*(?:years?)?|\beighteen\b|\bat\s+least\s+18\b|\b18\s+years?\s+of\s+age\b|\bage\s+of\s+18\b)/i;
const LEGAL_CONSENT_QUESTION =
  /candidate privacy policy|candidate-privacy-notice|privacy notice|notice at collection|review and acknowledge|information (?:i|you) have provided.*process|by selecting ["']?i agree|demographic data survey|collecting,\s*storing,\s*and processing/i;

export function isLegalConsentQuestion(label: string): boolean {
  return LEGAL_CONSENT_QUESTION.test(label);
}

export function workEligibilitySkipReason(label: string): string {
  return `work-eligibility question left for you: "${label.slice(0, 60)}"`;
}

export function legalConsentSkipReason(label: string): string {
  return `consent question left for you: "${label.slice(0, 60)}"`;
}

function workEligibilityAnswer(
  label: string,
  ap: ApplicationProfileLike,
  jdText: string | undefined,
): { value: string } | { skipReason: string } | null {
  if (WORK_AUTHORIZATION_DETAIL_QUESTION.test(label)) {
    return { skipReason: workEligibilitySkipReason(label) };
  }
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

export function attestationSkipReason(label: string, what: string): string {
  return `${what} left for you to agree to yourself: "${label.slice(0, 60)}"`;
}

/**
 * Every checkbox-shaped agreement on an employer form, resolved against the two consents the
 * student may grant once in onboarding - and refused by name otherwise.
 *
 * THE RULE, which the rest of this function is only an implementation of: Litos may affirm exactly
 * two things on somebody's behalf. That the information supplied is truthful, which restates what
 * she already did by approving the packet. And that a candidate privacy notice is accepted, which
 * is the routine condition of applying at all. Both require an explicit stored `true`; neither is
 * ever inferred from the fact that she pressed submit.
 *
 * Everything else is refused, INCLUDING things that sit right next to those two on the same form:
 *   - "I acknowledge that this role is my top preference and I will not be considered for other
 *     tech and/or quant roles at Akuna this season" is a binding exclusivity commitment over the
 *     rest of her recruiting season. It was being auto-answered "Yes".
 *   - "I acknowledge that my resume must be submitted in PDF format" is a process term. Harmless
 *     to agree to and still not ours to agree to; it was also being auto-answered "Yes".
 *   - "Interview Code of Conduct" is acceptance of a behavioural policy.
 * Each of those returns a skipReason naming what is being agreed to, so the student is asked for a
 * tick rather than discovering afterwards that a machine ticked it.
 */
function applicationConsentAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  if (TRUE_COMPLETE_ACCURATE_CERTIFICATION.test(label)) {
    return ap.attest_truthful_information === true
      ? { value: 'Yes' }
      : { skipReason: attestationSkipReason(label, 'certification that your information is true') };
  }
  if (TOP_ROLE_PREFERENCE_ACKNOWLEDGEMENT.test(label)) {
    return { skipReason: attestationSkipReason(label, 'commitment about which roles you will be considered for') };
  }
  if (RESUME_PDF_ACKNOWLEDGEMENT.test(label)) {
    return { skipReason: attestationSkipReason(label, 'acknowledgement about how your resume is submitted') };
  }
  if (CODE_OF_CONDUCT_ACKNOWLEDGEMENT.test(label)) {
    return { skipReason: attestationSkipReason(label, 'agreement to a code of conduct') };
  }
  if (BARE_PRIVACY_ACKNOWLEDGEMENT.test(label)) {
    return ap.accept_privacy_notices === true
      ? { value: 'Yes' }
      : { skipReason: attestationSkipReason(label, 'privacy notice') };
  }
  return null;
}

/** True when the student granted the standing privacy-notice consent in onboarding. */
function privacyNoticesAccepted(ap: ApplicationProfileLike): boolean {
  return ap.accept_privacy_notices === true;
}

function routineConsentAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  // Every branch below is an acceptance of a data-processing or privacy term, so every branch now
  // needs the same stored consent. They used to return "Yes" unconditionally, which is the thing
  // the rule above forbids: Litos was agreeing on her behalf to notices she had never seen.
  const consented = privacyNoticesAccepted(ap);
  const gate = (value: string): { value: string } | { skipReason: string } =>
    (consented ? { value } : { skipReason: attestationSkipReason(label, 'privacy notice') });

  if (/^\s*processing\s+of\s+personal\s+data\s*$/i.test(label)) return gate('Acknowledge/Confirm');
  if (/demographic data survey/i.test(label)) return null;
  if (/^\s*yes,\s*i\s+consent\s*$/i.test(label)) return gate('Yes, I consent');
  if (
    /\b(?:candidate|applicant)\s+privacy\s+(?:policy|notice)\b/i.test(label)
    && /\b(?:agree|consent|acknowledg\w*|processed?|processing)\b/i.test(label)
  ) {
    return gate('Yes');
  }
  if (/\bjob application\b/i.test(label) && /\bprocess(?:ed|ing)?\b/i.test(label) && /\b(?:information|data)\b/i.test(label)) {
    return gate('Yes');
  }
  return ROUTINE_APPLICANT_CONSENT_QUESTION.test(label) ? gate('Yes') : null;
}

/* ---- the self-declarations ----
 *
 * All four of these return a skipReason rather than null when nothing is stored. That is the
 * difference that matters: null falls through to classifyField and then to the essay drafter, and
 * both of those have already answered one of these questions wrongly on a live application. A
 * skipReason stops the fall and tells the applicant which question is waiting for her.
 */

function politicallyExposedAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  const isFamily = POLITICALLY_EXPOSED_FAMILY_QUESTION.test(label);
  if (!isFamily && !POLITICALLY_EXPOSED_PERSON_QUESTION.test(label)) return null;
  const stored = isFamily ? ap.politically_exposed_family : ap.politically_exposed;
  if (stored) return { value: stored };
  return {
    skipReason: `politically exposed person question left for you (we never guess this): "${label.slice(0, 60)}"`,
  };
}

function pronounsAnswer(label: string, ap: ApplicationProfileLike): { value: string } | { skipReason: string } | null {
  if (!PRONOUNS_QUESTION.test(label)) return null;
  if (ap.pronouns) return { value: ap.pronouns };
  return { skipReason: `pronouns question left for you: "${label.slice(0, 60)}"` };
}

function militaryServiceAnswer(label: string, ap: ApplicationProfileLike): { value: string } | null {
  if (!MILITARY_SERVICE_QUESTION.test(label)) return null;
  // Inside a voluntary self-identification block, the student's own EEO wording wins: it was
  // written against that block's option list, and eeoAnswer already handles the decline case.
  if (EEO_QUESTION.test(label)) {
    const pref = ap.eeo_prefs?.veteran_status ?? ap.eeo_prefs?.veteran;
    if (pref && pref.trim()) return null;
  }
  return ap.military_service ? { value: ap.military_service } : null;
}

function highSchoolGraduationAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  if (!HIGH_SCHOOL_GRADUATION_QUESTION.test(label)) return null;
  const stored = ap.high_school_grad_date;
  if (!stored) {
    return { skipReason: `high school graduation question left for you: "${label.slice(0, 60)}"` };
  }
  // Akuna asks for the month and year; a bare "did you earn one" is a Yes that the stored date is
  // the evidence for. Without a date on file neither is answerable, which is the branch above.
  const asksWhen = /\bmonth\b|\byear\b|\bwhen\b|\bdate\b/i.test(label);
  return { value: asksWhen ? stored : 'Yes' };
}

/** The employer a "have you applied here before?" question is actually asking about. */
function employerNamedInApplicationQuestion(label: string): string | undefined {
  const match = label.match(/(?:\bwith\b|\bat\b|\bto\s+work\s+(?:at|for)\b|@)\s*([a-z0-9][a-z0-9 .&'’-]{1,40})/i);
  const raw = match?.[1]
    ?.replace(/\b(?:before|previously|in\s+the\s+past|within\s+the\s+last|or\s+another\s+role|as\s+an?)\b[\s\S]*$/i, '')
    .replace(/[.,;:?]+$/g, '')
    .trim();
  if (!raw) return undefined;
  if (/^(?:any|a|an|the|this|our|your|company|organization|organisation|employer|role|position|firm)$/i.test(raw)) {
    return undefined;
  }
  const normalized = normalizeEmployerName(raw);
  return normalized.length >= 3 ? normalized : undefined;
}

/**
 * Whether a declared employer and the employer named in the question are the same company.
 *
 * Token-prefix, not string equality. Forms print the short trading name ("Akuna", "@IMC") while a
 * student types the legal one ("Akuna Capital"), and requiring an exact match would answer "No" to
 * "have you applied to Akuna before?" from a list whose first entry is Akuna Capital - a wrong
 * answer given confidently, which is worse than the blank it replaced. Prefix rather than
 * substring: "Tone" must not match "Tonee", the near-miss the prior-employer rule already guards.
 */
function employerMatchesTarget(declared: string, target: string): boolean {
  if (!declared || !target) return false;
  const a = declared.split(' ').filter(Boolean);
  const b = target.split(' ').filter(Boolean);
  const shared = Math.min(a.length, b.length);
  if (shared === 0) return false;
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function previouslyAppliedAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  if (!PREVIOUSLY_APPLIED_QUESTION.test(label)) return null;
  const declared = ap.prior_application_employers;
  // undefined is "never asked". An empty array is the student saying she has not applied anywhere
  // before, which answers No for every employer - the two must not be collapsed.
  if (!declared) {
    return { skipReason: `prior application question left for you: "${label.slice(0, 60)}"` };
  }
  if (declared.length === 0) return { value: 'No' };
  const target = employerNamedInApplicationQuestion(label);
  if (!target) {
    return { skipReason: `prior application question left for you: "${label.slice(0, 60)}"` };
  }
  const matched = declared.some((employer) => employerMatchesTarget(normalizeEmployerName(employer), target));
  return { value: matched ? 'Yes' : 'No' };
}

function outstandingOfferAnswer(
  label: string,
  inputType: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  /* Two shapes, and the second one is why this is not a single regex. "Do you have any offers?" is
   * the question; "If you answered Yes above, please provide details about your offer deadlines" is
   * its follow-up box, which reads as a generic conditional and would otherwise be swept up by
   * OPTIONAL_FOLLOWUP_AFTER_NO_QUESTION's blanket "N/A" even when there ARE offers to describe. */
  const isFollowUp = OPTIONAL_FOLLOWUP_AFTER_NO_QUESTION.test(label) && /\boffers?\b|\bdeadlines?\b/i.test(label);
  if (!isFollowUp && !OFFER_DEADLINE_QUESTION.test(label)) return null;
  // "N/A" is the honest answer to a detail box when the answer above was no; "No" is the honest
  // answer to the question itself.
  if (ap.has_outstanding_offers === false) return { value: isFollowUp ? 'N/A' : 'No' };
  if (ap.has_outstanding_offers === true) {
    const details = ap.outstanding_offer_details;
    const asksDetail = isFollowUp
      || inputType === 'textarea'
      || /\bdeadline|\bwhen\b|\bwhich\b|\bwhat\b|\bdetails?\b|\bspecify\b|\bplease\s+(?:list|share|provide|describe)\b/i.test(label);
    if (asksDetail && details) return { value: details };
    // "Yes" with no detail stored, on a box that wants the detail, would be an answer the employer
    // cannot use. Say so rather than half-answer it.
    if (asksDetail) return { skipReason: `offer question left for you: "${label.slice(0, 60)}"` };
    return { value: 'Yes' };
  }
  return { skipReason: `offer question left for you: "${label.slice(0, 60)}"` };
}

function furtherEducationAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  const plan = ap.advanced_study_plan;
  // Checked FIRST, and never answered from grad_date. A packet in production carried "May 2028" -
  // the undergraduate graduation date - as the answer to Akuna's "when is your potential master's
  // graduation date?", which states that she is doing a master's.
  if (POTENTIAL_ADVANCED_GRADUATION_DATE_QUESTION.test(label)) {
    if (plan === 'no') return { value: 'N/A' };
    return { skipReason: `further-education question left for you: "${label.slice(0, 60)}"` };
  }
  if (FURTHER_EDUCATION_DEGREE_TYPE_QUESTION.test(label)) {
    if (plan === 'no') return { value: 'N/A' };
    return { skipReason: `further-education question left for you: "${label.slice(0, 60)}"` };
  }
  if (!FURTHER_EDUCATION_PLAN_QUESTION.test(label)) return null;
  if (plan === 'no') return { value: 'No' };
  if (plan === 'considering' || plan === 'committed') return { value: 'Yes' };
  return { skipReason: `further-education question left for you: "${label.slice(0, 60)}"` };
}

function routineLocationCommitmentAnswer(label: string): { value: string } | null {
  return isLocationCommitmentQuestion(label) ? { value: 'Yes' } : null;
}

export function isRefusedQuestion(label: string): boolean {
  const l = label ?? '';
  return NEVER_FILL_PATTERNS.some((re) => re.test(l)) || AGE_ATTESTATION_QUESTION.test(l) || WORK_ELIGIBILITY_QUESTION.test(l) || EEO_QUESTION.test(l);
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
const STORED_ONSITE_COMMITMENT_QUESTION =
  /\b(?:able|willing|available|prepared|can|could|would)\b[^?]{0,80}\b(?:office|in[\s-]?office|on[\s-]?site|onsite|hybrid)\b|\b(?:office|in[\s-]?office|on[\s-]?site|onsite|hybrid)\b[^?]{0,80}\b(?:able|willing|available|prepared|can|could|would)\b/i;
const ONSITE_DAY_COUNT_QUESTION = /\b(?:three|four|five|3|4|5)\s+days?\b/i;
const LOCATION_PREFERENCE_QUESTION =
  /\b(?:single|top|preferred|preference|most interested)\b[^?]{0,120}\blocation\b|\blocation\b[^?]{0,120}\b(?:single|top|preferred|preference|most interested)\b/i;
const LOCATION_CHOICE_QUESTION =
  /\b(?:choose|select|pick)\b[^?]{0,120}\b(?:single|top|preferred|preference|most interested|location|office)\b|\b(?:single|top|most interested)\b[^?]{0,120}\blocation\b|\blocation\b[^?]{0,120}\b(?:single|top|most interested)\b/i;
const SAFE_US_LOCATION_LINE =
  /^(?:remote(?:,\s*)?(?:us|u\.s\.|usa|united states)?|[A-Z][A-Za-z .'-]+,\s*(?:[A-Z]{2}|Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming)(?:,\s*(?:United States|USA|US|U\.S\.))?)$/i;

export function isLocationCommitmentQuestion(label: string): boolean {
  return LOCATION_COMMITMENT_STEM.test(label) && LOCATION_COMMITMENT_VOCAB.test(label);
}

function locationPreferenceAnswer(label: string, jdText: string | undefined): { value: string } | null {
  if (!LOCATION_PREFERENCE_QUESTION.test(label)) return null;
  for (const line of (jdText ?? '').split(/\n+/).map((value) => value.trim()).filter(Boolean).reverse()) {
    if (line.length <= 120 && SAFE_US_LOCATION_LINE.test(line)) return { value: line };
  }
  return null;
}

export function isLocationChoiceQuestion(label: string): boolean {
  return LOCATION_CHOICE_QUESTION.test(label);
}

export const REFERRAL_QUESTION = /how did you .*hear|how did you hear|first hear|referral source|hear about (this|us|the)|where have you learned about|source of/i;
export const START_DATE_QUESTION = /availab|start(ing)?\s+date|date.*you.*start|when can you start|earliest.*start/i;
export const GRADUATION_DATE_QUESTION =
  /\b(?:expected\s+)?graduat(?:ion|e)\s+(?:date|year|semester|term|time\s*frame|timeframe|window)\b|\b(?:date|year|semester|term|time\s*frame|timeframe|window)\s+(?:of\s+)?(?:expected\s+)?graduat(?:ion|e)\b|\bexpected\s+grad(?:uation)?\b|\bexpect(?:ing)?\s+to\s+graduat(?:e|ion)\b|\bgraduate\s+or\s+complete\s+your\s+program\b|\bclass\s+of\b/i;
const GRADUATION_MONTH_QUESTION = /\bgraduat(?:ion|e)\s+month\b|\bmonth\s+(?:of\s+)?(?:expected\s+)?graduat(?:ion|e)\b/i;
const GRADUATION_YEAR_QUESTION = /\b(?:expected\s+)?graduat(?:ion|e)\s+year\b|\byear\s+(?:of\s+)?(?:expected\s+)?graduat(?:ion|e)\b|\bclass\s+year\b/i;
const MIXED_ENROLLMENT_GRADUATION_QUESTION = /\bcurrently\s+enrolled\b|\bdegree\s+program\b/i;
const CURRENT_ENROLLMENT_QUESTION =
  /\bcurrently\s+enrolled\b|\bcurrent\s+student\b|\benrolled\s+in\s+(?:a\s+)?(?:degree\s+)?program\b|\breturn(?:ing)?\s+to\s+(?:a\s+)?(?:degree\s+)?program\b|\breturn(?:ing)?\s+to\s+(?:school|college|university)\b/i;
const MAJOR_QUESTION =
  /\bmajor\b|field of study|course of study|degree subject|\bdiscipline\b|\bcourse\b[^?]{0,80}\benrolled\b|\benrolled\b[^?]{0,80}\bcourse\b/i;
const LANGUAGE_QUESTION =
  /\bspoken\s+languages?\b|\blanguages?\s+(?:do\s+you\s+|are\s+you\s+)?(?:speak|know|fluent|proficient)|\b(?:speak|fluent|proficient)\b[^?]{0,40}\blanguages?\b|\b(?:speak|fluent|proficient)\b[^?]{0,40}\b(?:english|hindi|arabic|spanish|french|german|portuguese|mandarin|chinese|cantonese|tamil|punjabi|urdu)\b/i;
const PROGRAMMING_LANGUAGE_QUESTION =
  /\bpreferred\s+coding\s+language\b|\bcoding\s+language\b[^?]{0,160}\b(?:preference|preferred|interview)\b|\binterview\b[^?]{0,160}\bcoding\s+language\b|\bpreferred\s+programming\s+language\b/i;
const TERM_QUESTION =
  /(length|duration|term)\b.*\bavailab|availab.*\b(length|duration|term)\b|how long.*(available|intern|stay|commit)|(weeks|months).*\b(available|internship|commit)|\bterm\s*\/?\s*length/i;
const SALARY_QUESTION = /salary|compensat|desired pay|expected pay|pay expectation/i;
const DOB_QUESTION = /date of birth|birth\s*date|\bdob\b/i;
const CITIZENSHIP_QUESTION = /citizen|nationalit/i;
const ADVANCED_DEGREE_ENROLLMENT_QUESTION = /\bcurrently\s+enrolled\b[^?]{0,80}\b(?:masters?|master's|ph\.?d|doctorate)\b|\b(?:masters?|master's|ph\.?d|doctorate)\b[^?]{0,80}\bcurrently\s+enrolled\b/i;
const EMPLOYER_RESTRICTION_AGREEMENT_QUESTION =
  /\bbound\b[^?]{0,120}\bagreements?\b[^?]{0,180}\b(?:restrict|limit)\b[^?]{0,120}\b(?:ability\s+to\s+work|employment|duties)\b|\b(?:non-compete|non-solicitation|confidentiality|non-disclosure)\b[^?]{0,180}\b(?:restrict|limit|bound)\b/i;
const CURRENT_EMPLOYER_QUESTION =
  /\bcurrent\s+employer\b|\bwhere\s+do\s+you\s+(?:currently\s+)?work\b|\bwhere\s+are\s+you\s+currently\s+(?:employed|working)\b/i;
const MOST_RECENT_EMPLOYER_QUESTION =
  /\bwhere\s+have\s+you\s+most\s+recently\s+worked\b|\bmost\s+recent\s+employer\b/i;
const PRIOR_EMPLOYER_OR_PROGRAM_QUESTION =
  /\bhave\s+you\s+(?:ever\s+|previously\s+)?(?:worked|been\s+employed)\s+(?:for|by|at)\b|\bhave\s+you\s+been\s+enrolled\s+in\b[^?]{0,120}\bin\s+the\s+past\s+\d+\s+months\b/i;
const STEM_MAJOR_QUESTION =
  /\bmajoring\s+in\s+STEM\b|\bSTEM\b[^?]{0,160}\b(?:Computer Science|Electrical Engineering|Data Science|Mathematics|Machine Learning)\b/i;
const AI_INTERVIEW_POLICY_QUESTION =
  /\bAI\s+Policy\s+for\s+Interviewers\b|\bdo\s+not\s+use\s+any\s+AI\s+tools\b[^?]{0,160}\binterview\b/i;
const INTERNSHIP_AVAILABILITY_QUESTION =
  /\b(?:are|will)\s+you\s+available\b[^?]{0,160}\b(?:internship|full-time|40\s*hours|weeks?)\b|\b(?:internship|full-time|40\s*hours|weeks?)\b[^?]{0,160}\b(?:are|will)\s+you\s+available\b/i;
const INTERNSHIP_SEASON_QUESTION =
  /\bconfirm\b[^?]{0,100}\bseason\b[^?]{0,100}\bapplying\b|\bseason\b[^?]{0,100}\bapplying\b/i;
const INTERNSHIP_JOIN_QUESTION =
  /\bwhen\b[^?]{0,120}\b(?:able|available|start|join)\b[^?]{0,120}\bintern\b|\bintern\b[^?]{0,120}\b(?:able|available|start|join)\b/i;
const SOFTWARE_ENGINEERING_AREA_QUESTION =
  /\b(?:area|track|team)\s+of\s+interest\b[^?]{0,120}\bsoftware\s+engineering\b|\bsoftware\s+engineering\b[^?]{0,120}\b(?:area|track|team)\s+of\s+interest\b/i;
const HIGH_SCHOOL_DIPLOMA_CONFIRMATION_QUESTION =
  /\b(?:earned|have|hold|received|obtained)\b[^?]{0,120}\b(?:high\s+school\s+diploma|equivalent\s+degree|ged)\b|\b(?:high\s+school\s+diploma|equivalent\s+degree|ged)\b[^?]{0,120}\b(?:confirm|acknowledge|certify|required|must\s+have)\b/i;
const OFFER_DEADLINE_QUESTION =
  // The third alternative was added for Five Rings' "Are you holding any outstanding offers?",
  // which has no "do you have" stem and so matched neither of the first two.
  /\b(?:offers?|offer\s+deadlines?|outstanding\s+offers?|deadlines?)\b[^?]{0,120}\b(?:aware|currently|have|should\s+we\s+know|tell\s+us|provide|share)\b|\b(?:do\s+you\s+have|currently\s+have)\b[^?]{0,120}\b(?:offers?|deadlines?)\b|\b(?:are\s+you\s+)?hold(?:ing)?\b[^?]{0,60}\b(?:outstanding\s+)?offers?\b/i;
const OPTIONAL_FOLLOWUP_AFTER_NO_QUESTION =
  /\bif\s+you\s+(?:answered|said|selected)\s+["'“”]?\s*yes\b[^?]{0,180}\b(?:provide|respond|explain|list|tell|details?|additional)\b|\bif\s+applicable\b[^?]{0,120}\b(?:provide|list|explain|details?|extension)\b/i;
const US_STATE_RESIDENCE_SELECT_QUESTION = /\bstate\s+of\s+residence\b[^?]{0,160}\bnot\s+in\s+the\s+us\b/i;
const SAN_FRANCISCO_RESIDENCE_QUESTION = /\bcurrently\s+reside\b[^?]{0,80}\bsan\s+francisco\b|\bsan\s+francisco\b[^?]{0,80}\bcurrently\s+reside\b/i;
const CONFIRMED_PLANS_CITY_RE = /\b(?:currently\s+residing|confirmed\s+plans)\b[^?]{0,80}\b(?:greater\s+)?([a-z][a-z .'-]+?)\s+area\b|\bconfirmed\s+plans\b[^?]{0,80}\bin\s+([a-z][a-z .'-]+)\b/i;
const LEGAL_FIRST_NAME_QUESTION =
  /\blegal\s+first\s+name\b|\bfirst\s+name\b[^?]{0,120}\blegal\b/i;
const TOP_ROLE_PREFERENCE_ACKNOWLEDGEMENT =
  /\banswering\s+[“"]?yes[”"]?\s+below\b[^?]{0,220}\btop\s+preference\b|\btop\s+preference\b[^?]{0,220}\banswering\s+[“"]?yes[”"]?\s+below\b/i;
const RESUME_PDF_ACKNOWLEDGEMENT =
  /\bresume\b[^?]{0,120}\bPDF\s+format\b|\bPDF\s+format\b[^?]{0,120}\bresume\b/i;
const TRUE_COMPLETE_ACCURATE_CERTIFICATION =
  /\bcertify\b[^?]{0,220}\btrue\b[^?]{0,120}\bcomplete\b[^?]{0,120}\baccurate\b/i;
const NY_CA_RESIDENCE_QUESTION =
  /\b(?:live|reside|located)\b[^?]{0,80}\bnew\s+york\b[^?]{0,80}\bcalifornia\b|\bnew\s+york\b[^?]{0,80}\bcalifornia\b[^?]{0,80}\b(?:live|reside|located)\b/i;
const OPTIONS_MARKET_MAKING_EXPERIENCE_QUESTION =
  /\b(?:options\s+market\s+making|market\s+making\s+trading|trading\s+firm)\b/i;
const WORK_AUTHORIZATION_DETAIL_QUESTION =
  /\b(?:current\s+immigration\s+status|basis\s+of\s+your\s+current\s+work\s+authorization|when\s+does\s+it\s+expire|extension\s+options?|additional\s+detail\s+about\s+your\s+sponsorship\s+need)\b/i;

/* ---- the questions employers keep asking that nothing on file could answer ----
 *
 * Each pattern below was written against the exact labels measured on the 25 most recent
 * production packets, and each has a handler in resolveKnownAnswer that answers ONLY from an
 * explicit stored declaration. Every one of them runs BEFORE classifyField, which is the point:
 * these are the labels a catch-all gets wrong, and the whole class of bug is a broad rule reaching
 * a question that was never its business.
 */

// "We care about addressing everyone correctly. Add your personal pronouns below to share with the
// hiring team." Also the self-describe follow-up, which asks for the same fact in a second box.
const PRONOUNS_QUESTION = /\bpronouns?\b/i;

/* POLITICALLY EXPOSED PERSON. The narrowest patterns in this file, on purpose.
 *
 * `state-owned enterprise` is in here as a POSITIVE match precisely because it is the phrase that
 * caused the harm: classifyField's residence rule reads `\b(state|province)\b`, the word "state"
 * appears inside "state-owned", and on 2026-08-06 Tower Research's PEP question was answered with
 * the applicant's home city, "Dubai". Naming the phrase here means the question is recognised for
 * what it is and short-circuited before any residence rule can see it. */
const POLITICALLY_EXPOSED_PERSON_QUESTION =
  /\bpolitically\s+exposed\b|\bentrusted\s+with\s+a\s+(?:prominent\s+)?(?:public\s+)?(?:position|function)\b|\bstate[-\s]owned\s+enterprise\b|\bsenior\s+(?:political|government)\s+figure\b/i;
const POLITICALLY_EXPOSED_FAMILY_QUESTION =
  /\bimmediate\s+family\s+member\b[\s\S]{0,200}\b(?:holding\s+such|such\s+a\s+position|politically\s+exposed)\b|\b(?:close\s+associate|family\s+member)\b[\s\S]{0,160}\bpolitically\s+exposed\b/i;

// Point72's "Have you served in the military?" - a required Yes/No that is not part of an EEO
// block, and so cannot be answered with "Decline to self-identify".
const MILITARY_SERVICE_QUESTION =
  /\bmilitary\b|\barmed\s+forces\b|\bveteran\b/i;

// "Do you have a preferred name, other than the name indicated above?"
const PREFERRED_NAME_QUESTION =
  /\bpreferred\s+(?:first\s+)?name\b|\bname\s+you\s+(?:go\s+by|prefer\s+to\s+be\s+called)\b/i;

// Akuna's "please confirm the month and year" diploma question and IMC's "When did you graduate
// from High School?". Distinct from every other graduation rule in this file, and checked before
// them, so the UNIVERSITY graduation date can never be replayed as a high-school one.
const HIGH_SCHOOL_GRADUATION_QUESTION =
  /\bhigh\s+school\b[\s\S]{0,200}\b(?:graduat\w*|diploma|ged|month\s+and\s+year|when)\b|\b(?:graduat\w*|when|month|year)\b[\s\S]{0,120}\bhigh\s+school\b/i;

// "Have you previously applied to work at Point72?" / "...with Akuna in the past?" / "...another
// role @IMC within the last 12-18 months?". About APPLICATIONS, not employment, which is why it is
// separate from PRIOR_EMPLOYER_OR_PROGRAM_QUESTION above.
const PREVIOUSLY_APPLIED_QUESTION =
  /\b(?:have|had)\s+you\s+(?:ever\s+|previously\s+)?applied\b|\bpreviously\s+applied\b|\bapplied\s+(?:to|for|with)\b[\s\S]{0,160}\b(?:previously|before|in\s+the\s+past|within\s+the\s+last)\b/i;

// Further education AFTER the current degree. Checked before every graduation-date rule so that
// "when is your potential master's graduation date?" cannot be handed the undergraduate date -
// which is exactly what a live Akuna packet carried, answered "May 2028".
const ADVANCED_DEGREE_WORD = String.raw`master(?:['’]s)?|masters|m\.?s\.?|mba|ph\.?\s?d|doctorate|graduate\s+(?:school|studies|degree)`;
const POTENTIAL_ADVANCED_GRADUATION_DATE_QUESTION = new RegExp(
  String.raw`\b(?:${ADVANCED_DEGREE_WORD})\b[\s\S]{0,120}\bgraduation\s+date\b|\b(?:potential|expected|anticipated)\b[\s\S]{0,80}\b(?:${ADVANCED_DEGREE_WORD})\b[\s\S]{0,80}\bgraduat\w*`,
  'i',
);
const FURTHER_EDUCATION_PLAN_QUESTION = new RegExp(
  String.raw`\b(?:considering|committed|plan(?:ning)?|intend\w*|pursuing)\b[\s\S]{0,160}\b(?:further\s+education|additional\s+degree|${ADVANCED_DEGREE_WORD})\b|\bfurther\s+education\b[\s\S]{0,160}\b(?:after|following|immediately)\b`,
  'i',
);
const FURTHER_EDUCATION_DEGREE_TYPE_QUESTION =
  /\btype\s+of\s+degree\s+you\s+(?:plan|intend|would\s+like)\s+to\s+pursue\b|\bif\s+so\b[\s\S]{0,80}\btype\s+of\s+degree\b/i;

/* ---- attestations ----
 *
 * Two categories, and only two, may ever be ticked by an automated submission, and each only from
 * an explicit stored consent (application_profile.attest_truthful_information and
 * accept_privacy_notices). Everything else here is named so it can be REFUSED by name rather than
 * swept up by a general consent rule.
 */
// Bare-label privacy acknowledgements. Five Rings ships "Privacy Policy Acknowledgement", IMC
// "Privacy Statement", Point72 just "Privacy": no verb, no sentence, nothing for the prose-shaped
// ROUTINE_APPLICANT_CONSENT_QUESTION to match, which is why all three sat empty.
const BARE_PRIVACY_ACKNOWLEDGEMENT =
  /^\s*(?:candidate\s+|applicant\s+)?privacy(?:\s+(?:policy|statement|notice))?(?:\s+acknowledg\w*|\s+consent)?\s*$/i;
// A behavioural policy is not a privacy notice and not a statement of truth. IMC's "Interview Code
// of Conduct" was previously auto-answered "Yes" with nothing stored behind it.
const CODE_OF_CONDUCT_ACKNOWLEDGEMENT =
  /\bcode\s+of\s+conduct\b|\bcode\s+of\s+ethics\b|\bacceptable\s+use\s+policy\b/i;

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
  | 'availability_date' | 'availability_term' | 'current_employer' | 'most_recent_employer' | 'school' | 'degree' | 'graduation_date' | 'desired_salary'
  | 'graduation_month' | 'graduation_year' | 'current_enrollment' | 'study_year' | 'gpa' | 'gpa_scale' | 'major'
  | 'languages' | 'onsite_commitment' | 'referral_source_default';

// Ported verbatim from generic.ts's classifyField (see that file for the full rationale on
// ordering - refusals first, citizenship before residence, term before start date, state before
// city). `label` must already be lowercased by the caller.
export function classifyField(label: string, type?: string): ProfileKey | null {
  const l = label ?? '';
  if (isRefusedQuestion(l)) return null;
  /* Belt and braces on the "Dubai" defect. resolveKnownAnswer already short-circuits these labels,
   * but classifyField has two other callers (portalSubmission's questionFillShouldPressEnter and
   * profileFieldResolution's profileFieldIntent), and the bug was never in the resolver's ordering
   * - it was that `\b(state|province)\b` matched "state" inside "state-owned enterprise" and
   * handed a politically-exposed-person question to the residence rule. A question about a
   * government position has no profile field, in this function or anywhere else. */
  if (POLITICALLY_EXPOSED_PERSON_QUESTION.test(l) || POLITICALLY_EXPOSED_FAMILY_QUESTION.test(l)) return null;
  // Same shape of hazard: "personal pronouns" carries no residence, name or degree word that a
  // rule below could latch onto today, and this makes sure none added later can.
  if (PRONOUNS_QUESTION.test(l)) return null;
  if (type === 'tel') return 'phone';

  const locationCommitment = isLocationCommitmentQuestion(l);
  const locationChoice = isLocationChoiceQuestion(l);

  if (CITIZENSHIP_QUESTION.test(l)) return 'citizenship';
  if (!locationCommitment && !locationChoice && RESIDENCE_QUESTION.test(l)) return 'address_country';

  if (REFERRAL_QUESTION.test(l)) return 'referral_source_default';
  if (SALARY_QUESTION.test(l)) return 'desired_salary';
  if (DOB_QUESTION.test(l)) return 'date_of_birth';
  if (/linkedin/i.test(l)) return 'linkedin_url';
  if (/github/i.test(l)) return 'github_url';
  if (/portfolio|personal\s*(web)?site|\bwebsite\b/i.test(l)) return 'portfolio_url';
  if (CURRENT_EMPLOYER_QUESTION.test(l)) return 'current_employer';
  if (MOST_RECENT_EMPLOYER_QUESTION.test(l)) return 'most_recent_employer';
  if (TERM_QUESTION.test(l)) return 'availability_term';
  if (STORED_ONSITE_COMMITMENT_QUESTION.test(l) && (ONSITE_DAY_COUNT_QUESTION.test(l) || !/relocat/i.test(l))) {
    return 'onsite_commitment';
  }
  if (/\bcurrent\s+year\s+of\s+(?:your\s+)?stud(?:y|ies)\b|\byear\s+of\s+(?:your\s+)?stud(?:y|ies)\b|\bacademic\s+year\b/i.test(l)) return 'study_year';
  if (GRADUATION_MONTH_QUESTION.test(l)) return 'graduation_month';
  if (GRADUATION_YEAR_QUESTION.test(l)) return 'graduation_year';
  if (GRADUATION_DATE_QUESTION.test(l)) return 'graduation_date';
  if (/\bwhich\s+(?:school|university|college|institution)\b|\b(?:school|university|college|institution)\s+(?:name|are\s+you\s+currently\s+attending|are\s+you\s+currently\s+enrolled|currently\s+attend|currently\s+enrolled\s+in)\b|^university\s*\/\s*institution\b/i.test(l)) return 'school';
  if (MAJOR_QUESTION.test(l)) return 'major';
  if (CURRENT_ENROLLMENT_QUESTION.test(l) && !GRADUATION_DATE_QUESTION.test(l)) return 'current_enrollment';
  if (START_DATE_QUESTION.test(l)) return 'availability_date';
  if (LOCATION_PREFERENCE_QUESTION.test(l)) return null;

  if (/\bgpa\b|grade average|grade point|academic performance/i.test(l)) return 'gpa';
  if (/gpa scale|out of.*(4\.0|100)|grading scale/i.test(l)) return 'gpa_scale';
  if (/\bhigh school\b/i.test(l) && /graduat|when|date|year/i.test(l)) return null;
  if (LANGUAGE_QUESTION.test(l)) return 'languages';
  if (/\bdegree\b(?!\s+(?:program|subject))|education level|level of education/i.test(l)) return 'degree';
  if (/\b(school|university|college|institution)\b/i.test(l)) return 'school';
  if (MAJOR_QUESTION.test(l)) return 'major';

  if (/phone|mobile/i.test(l)) return 'phone';
  if (
    !locationCommitment &&
    !locationChoice &&
    /\b(state|province|prefecture)\b(?!\s+(?:your|the|you|it|why|how|what|when|where))|state\s*\/\s*province/i.test(l)
  )
    return 'address_state';
  if (
    !locationCommitment &&
    !locationChoice &&
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
  if (isLocationChoiceQuestion(l)) return false;
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
const NUMBER_TO_MONTH: Record<string, string> = {
  '01': 'January',
  '02': 'February',
  '03': 'March',
  '04': 'April',
  '05': 'May',
  '06': 'June',
  '07': 'July',
  '08': 'August',
  '09': 'September',
  '10': 'October',
  '11': 'November',
  '12': 'December',
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

function graduationMonthAnswer(gradDate: string | undefined, gradYear: number | undefined): string | null {
  const iso = graduationDateAnswer(gradDate, gradYear, 'date');
  const month = iso?.match(/^\d{4}-(\d{2})-/)?.[1];
  if (!month) return null;
  return NUMBER_TO_MONTH[month] ?? null;
}

function graduationYearAnswer(gradDate: string | undefined, gradYear: number | undefined): string | null {
  if (gradYear && gradYear > 0) return String(gradYear);
  return graduationDateAnswer(gradDate, gradYear, 'date')?.match(/^(\d{4})-/)?.[1] ?? null;
}

function graduationSemesterAnswer(gradDate: string | undefined, gradYear: number | undefined): string | null {
  const iso = graduationDateAnswer(gradDate, gradYear, 'date');
  const match = iso?.match(/^(\d{4})-(\d{2})-/);
  if (!match) return null;
  const month = Number(match[2]);
  if (!Number.isFinite(month)) return null;
  const semester = month <= 5 ? 'Spring' : month <= 8 ? 'Summer' : 'Fall';
  return `${semester} ${match[1]}`;
}

function currentEnrollmentAnswer(ap: ApplicationProfileLike): { value: string } | { skipReason: string } | null {
  if (ap.currently_enrolled === true || graduationEvidenceIsFuture(ap.grad_date, ap.grad_year)) return { value: 'Yes' };
  if (ap.currently_enrolled === false) return { value: 'No' };
  return { skipReason: 'current enrollment question left for you' };
}

function studyYearAnswer(ap: ApplicationProfileLike): string | null {
  if (!/\b(?:bachelor|b\.?s\.?|b\.?a\.?)\b/i.test(ap.degree ?? '')) return null;
  const gradYear = ap.grad_year && ap.grad_year > 0 ? ap.grad_year : Number(graduationYearAnswer(ap.grad_date, ap.grad_year));
  if (!gradYear || !enrollmentConfirmedForGraduationDate(ap)) return null;
  const now = new Date();
  const academicStartYear = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const yearsUntilGraduation = gradYear - academicStartYear;
  const undergradYear = 4 - yearsUntilGraduation + 1;
  if (undergradYear <= 0 || undergradYear > 4) return null;
  return ['First year', 'Second year', 'Third year', 'Fourth year'][undergradYear - 1] ?? null;
}

function postingSeasonAnswer(label: string, jdText: string | undefined): { value: string } | null {
  if (!INTERNSHIP_SEASON_QUESTION.test(label)) return null;
  const match = (jdText ?? '').match(/\b(spring|summer|fall|winter)\s+((?:20)\d{2})\b/i);
  if (!match) return null;
  const season = match[1].toLowerCase().replace(/^\w/u, (letter) => letter.toUpperCase());
  return { value: `${season} ${match[2]}` };
}

function internshipJoinAnswer(label: string, ap: ApplicationProfileLike, jdText: string | undefined): { value: string } | { skipReason: string } | null {
  if (!INTERNSHIP_JOIN_QUESTION.test(label)) return null;
  const storedDate = ap.availability_date?.trim();
  if (storedDate) return { value: storedDate };
  const season = (jdText ?? '').match(/\b(spring|summer|fall|winter)\s+((?:20)\d{2})\b/i);
  if (season) {
    const value = season[1].toLowerCase().replace(/^\w/u, (letter) => letter.toUpperCase());
    return { value: `${value} ${season[2]}` };
  }
  return { skipReason: `internship availability question left for you: "${label.slice(0, 60)}"` };
}

function internshipAvailabilityAnswer(label: string, ap: ApplicationProfileLike): { value: string } | { skipReason: string } {
  const stored = [ap.availability_term, ap.availability_date].filter(Boolean).join(' ').trim();
  if (!stored) return { skipReason: `internship availability question left for you: "${label.slice(0, 60)}"` };
  const asksFullTime = /\bfull-time\b|\b40\s*hours\b/i.test(label);
  const asksTwelveWeeks = /\b12\s*weeks?\b|\btwelve\s+weeks?\b/i.test(label);
  const asksDateWindow = /\b(?:between|from)\b[^?]{0,120}\b(?:20\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i.test(label);
  const confirmsFullTime = !asksFullTime || /\bfull-time\b|\b40\s*hours\b/i.test(stored);
  const confirmsTwelveWeeks = !asksTwelveWeeks || /\b12\s*weeks?\b|\btwelve\s+weeks?\b|\b3\s*months?\b|\bthree\s+months?\b/i.test(stored);
  const confirmsDateWindow = !asksDateWindow || labelDateTokens(label).every((token) => stored.toLowerCase().includes(token));
  if (confirmsFullTime && confirmsTwelveWeeks && confirmsDateWindow) return { value: 'Yes' };
  return { skipReason: `internship availability question left for you: "${label.slice(0, 60)}"` };
}

function labelDateTokens(label: string): string[] {
  const tokens = label.toLowerCase().match(/\b(?:20\d{2}|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/g) ?? [];
  return [...new Set(tokens)];
}

function majorAnswer(ap: ApplicationProfileLike): string | null {
  const major = ap.major?.trim();
  if (major) return major;
  const degree = ap.degree?.trim();
  if (!degree) return null;
  const cleaned = degree
    .replace(/\b(?:b\.?s\.?|b\.?a\.?|m\.?s\.?|m\.?a\.?|m\.?b\.?a\.?)\b/gi, ' ')
    .replace(/\b(?:bachelor|bachelor's|bachelors|master|master's|masters|doctor|doctorate|ph\.?d)\s+(?:of\s+)?(?:science|arts|business\s+administration)?\s+(?:degree\s+)?(?:in\s+)?/gi, ' ')
    .replace(/\b(?:degree\s+in|with\s+a\s+degree\s+in|in)\b/gi, ' ')
    .replace(/(?:,\s*)?[^,;&()]{0,40}\b(?:emphasis|concentration|minor)\b.*$/i, '')
    .replace(/[(),]/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || degree;
}

function softwareEngineeringAreaAnswer(label: string, jdText: string | undefined): { value: string } | { skipReason: string } | null {
  if (!SOFTWARE_ENGINEERING_AREA_QUESTION.test(label)) return null;
  const text = jdText ?? '';
  const backendSignals = (text.match(/\b(?:backend|back-end|systems?|infrastructure|platform|network|distributed|api|apis|service|services|security|rust|go|c\+\+|python)\b/gi) ?? []).length;
  const frontendSignals = (text.match(/\b(?:frontend|front-end|ui|ux|react|web\s+app|interface|client-side)\b/gi) ?? []).length;
  const fullStackSignals = (text.match(/\b(?:full-stack|fullstack|end-to-end)\b/gi) ?? []).length;
  if (backendSignals > Math.max(frontendSignals, fullStackSignals)) return { value: 'Backend/Systems' };
  if (fullStackSignals > Math.max(backendSignals, frontendSignals)) return { value: 'Full-stack' };
  if (frontendSignals > Math.max(backendSignals, fullStackSignals)) return { value: 'Frontend' };
  return { skipReason: `area of interest left for you: "${label.slice(0, 60)}"` };
}

function advancedDegreeEnrollmentAnswer(ap: ApplicationProfileLike): { value: string } | null {
  const degree = ap.degree?.trim();
  if (!degree) return null;
  if (/\b(master|m\.?s\.?|m\.?a\.?|mba|m\.?b\.?a\.?|ph\.?d|doctorate|doctor of philosophy)\b/i.test(degree)) {
    return { value: 'Yes' };
  }
  return { value: 'No' };
}

function stemMajorAnswer(label: string, ap: ApplicationProfileLike): { value: string } | null {
  if (!STEM_MAJOR_QUESTION.test(label)) return null;
  const evidence = [ap.major, ap.degree].filter(Boolean).join(' ');
  if (/\b(computer science|electrical engineering|data science|cog(?:nitive)?\s+sci|information management|information systems|mathematics|machine learning|software engineering)\b/i.test(evidence)) {
    return { value: 'Yes' };
  }
  return null;
}

function normalizeEmployerName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:inc|incorporated|llc|ltd|limited|corp|corporation|company|co)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isSinglePlainEmployerTarget(value: string): boolean {
  return !/\b(?:or|and|affiliates?|subsidiar(?:y|ies)|parents?|partner(?:s|ships?)?|group|division|business\s+unit|portfolio\s+compan(?:y|ies))\b/i.test(value);
}

function priorEmployerAnswer(label: string, ap: ApplicationProfileLike): { value: string } | null {
  const history = ap.employer_history?.map(normalizeEmployerName).filter(Boolean);
  if (!history?.length) return null;
  const match = label.match(/\bworked\s+(?:for|by|at)\s+([^?]+)/i);
  const rawPhrase = match?.[1]?.trim();
  if (!rawPhrase || !isSinglePlainEmployerTarget(rawPhrase)) return null;
  const rawTarget = rawPhrase
    ?.replace(/\b(?:before|previously|in\s+the\s+past|as\s+a|as\s+an)\b[\s\S]*$/i, '')
    .replace(/[.,;:]+$/g, '')
    .trim();
  if (!rawTarget || /\b(?:any|a|an|the|company|organization|employer|program)\b/i.test(rawTarget)) return null;
  const target = normalizeEmployerName(rawTarget);
  if (!target || target.length < 5) return null;
  const knownMatch = history.some((employer) => employer === target);
  return { value: knownMatch ? 'Yes' : 'No' };
}

function locationStatusAnswer(label: string, ap: ApplicationProfileLike): { value: string } | null {
  if (US_STATE_RESIDENCE_SELECT_QUESTION.test(label) && !/\b(?:united states|usa|us|u\.s\.)\b/i.test(ap.address_country ?? '')) {
    return { value: 'Not in the US' };
  }
  if (NY_CA_RESIDENCE_QUESTION.test(label)) {
    const state = `${ap.address_state ?? ''} ${ap.address_city ?? ''}`.trim();
    if (!state) return null;
    return /\b(?:ny|new\s+york|ca|california)\b/i.test(state) ? { value: 'Yes' } : { value: 'No' };
  }
  if (SAN_FRANCISCO_RESIDENCE_QUESTION.test(label)) {
    return { value: /\bsan\s+francisco\b/i.test(ap.address_city ?? '') ? 'Yes' : 'No' };
  }
  const cityMatch = label.match(CONFIRMED_PLANS_CITY_RE);
  const city = cityMatch?.[1] ?? cityMatch?.[2];
  if (!city) return null;
  if (ap.address_city && new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(ap.address_city)) {
    return { value: 'Yes' };
  }
  return { value: 'Yes' };
}

function degreeAnswer(label: string, inputType: string | undefined, degree: string | undefined): string | null {
  const trimmed = degree?.trim();
  if (!trimmed) return null;
  // A bare "Degree" label is the education section's level picker on every ATS that has one, and
  // it is a closed list. It used to be recognised only by its Greenhouse handle (`degree--0`),
  // which normalizeDiscoveredLabel now strips as noise, so the rule is stated on the label the
  // employer actually shows instead of on a provider's internal id.
  const needsLevel = /most recent degree|highest degree|degree (?:you )?(?:obtained|earned)|education level|level of education/i.test(label)
    || /^\s*degree\s*$/i.test(label)
    || /\bdegree--\d+\b/i.test(label)
    || /select|radio|combobox/i.test(inputType ?? '');
  if (!needsLevel) return trimmed;
  if (/\bph\.?d\b|doctor of philosophy|doctorate/i.test(trimmed)) return 'Doctor of Philosophy (Ph.D.)';
  if (/\bmaster|m\.?s\.?|m\.?a\.?\b|mba|m\.?b\.?a\.?/i.test(trimmed)) return 'Master\'s Degree';
  if (/\bbachelor|b\.?s\.?|b\.?a\.?\b/i.test(trimmed)) return 'Bachelor\'s Degree';
  if (/\bassociate/i.test(trimmed)) return 'Associate\'s Degree';
  if (/\bhigh school/i.test(trimmed)) return 'High School';
  return trimmed;
}

const SPOKEN_LANGUAGE_ALIASES: Record<string, string> = {
  english: 'English',
  hindi: 'Hindi',
  arabic: 'Arabic',
  spanish: 'Spanish',
  french: 'French',
  german: 'German',
  portuguese: 'Portuguese',
  mandarin: 'Mandarin',
  chinese: 'Chinese',
  cantonese: 'Cantonese',
  tamil: 'Tamil',
  punjabi: 'Punjabi',
  urdu: 'Urdu',
};

function normalizedStoredLanguages(ap: ApplicationProfileLike): string[] {
  return (Array.isArray(ap.languages) ? ap.languages : [])
    .map((language) => language.trim())
    .filter(Boolean);
}

function languageAnswer(label: string, ap: ApplicationProfileLike): { value: string } | null {
  const stored = normalizedStoredLanguages(ap);
  if (stored.length === 0) return null;
  const specific = Object.entries(SPOKEN_LANGUAGE_ALIASES).find(([token]) =>
    new RegExp(`\\b${token}\\b`, 'i').test(label));
  if (specific) {
    return { value: stored.some((language) => language.toLowerCase() === specific[1].toLowerCase()) ? 'Yes' : 'No' };
  }
  return { value: stored.join(', ') };
}

const PROGRAMMING_LANGUAGE_ALIASES: Array<{ value: string; patterns: RegExp[] }> = [
  { value: 'Python', patterns: [/\bpython(?:\s*3)?\b/i] },
  { value: 'TypeScript', patterns: [/\btypescript\b|\bts\b/i] },
  { value: 'JavaScript', patterns: [/\bjavascript\b|\bjs\b/i] },
  { value: 'Java', patterns: [/\bjava\b/i] },
  { value: 'C++', patterns: [/(?<!\w)c\+\+(?!\w)|\bcpp\b/i] },
  { value: 'C#', patterns: [/(?<!\w)c#(?!\w)|\bc-sharp\b/i] },
  { value: 'Go', patterns: [/\bgolang\b|\bgo\b/i] },
  { value: 'Ruby', patterns: [/\bruby\b/i] },
  { value: 'Swift', patterns: [/\bswift\b/i] },
  { value: 'Lua', patterns: [/\blua\b/i] },
];

function normalizedStoredSkills(ap: ApplicationProfileLike): string[] {
  return (Array.isArray(ap.skills) ? ap.skills : [])
    .map((skill) => skill.trim())
    .filter(Boolean);
}

function programmingLanguageAnswer(label: string, ap: ApplicationProfileLike): { value: string } | null {
  if (!PROGRAMMING_LANGUAGE_QUESTION.test(label)) return null;
  const stored = normalizedStoredSkills(ap);
  if (stored.length === 0) return null;
  const joined = stored.join(' ');
  const match = PROGRAMMING_LANGUAGE_ALIASES.find((item) => item.patterns.some((pattern) => pattern.test(joined)));
  return match ? { value: match.value } : null;
}

export type DiscoveredQuestion = {
  label: string;
  selector: string;
  inputType: string;
  maxLength: number | null;
  /**
   * The control's real option texts, when it has a closed list (a select, a radio or checkbox
   * group, or a datalist). Nothing in this codebase used to capture these, which is why a closed
   * list was fed the profile's own phrasing: the stored school is "University of Southern
   * California, Viterbi School of Engineering" and the option reads "University of Southern
   * California", so nothing was ever selected and the field came back required-and-empty.
   * Optional because a provider that does not report options must still work; the resolver falls
   * back to a ranked alias ladder in that case.
   */
  options?: string[] | null;
};

export const REVIEW_QUESTION_TEXT_MAX_LENGTH = 500;

const INLINE_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const GREENHOUSE_QUESTION_HANDLE_RE = /\bquestion_\d+\b/gi;
const GREENHOUSE_TRAILING_NUMERIC_HANDLE_RE = /\s*\*?\s+\d{2,5}\s*$/u;
// Greenhouse's repeated-section handles: degree--0, school--0, discipline--0, start-month--0,
// end-year--1. Discovery concatenates the control's `name` and `id` onto the visible label, so
// these land INSIDE the question text: prod packets stored questions literally titled
// "degree* degree--0" and "discipline* discipline--0". Every managed fill for such a question is
// scoped with `label:has-text("<the stored text>")`, which can never match a page whose label
// reads "Degree", so the control was left untouched and came back as
// '"Discipline" is required and is still empty' with the answer already resolved in the packet.
// Stripping the handle restores the employer's own label, which is what the scope needs.
const GREENHOUSE_SECTION_HANDLE_RE = /\b[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*--\d+\b/gi;
// What is left of an array-shaped question name (question_37536799002[]) once the handle above is
// removed. A bare "[]" is not part of anyone's question.
const EMPTY_BRACKET_HANDLE_RE = /\[\s*\]/g;
const TRAILING_ANSWER_PLACEHOLDER_RE = /\s+(?:type|enter|write)\s+(?:your\s+)?(?:answer\s+)?here(?:\.{3}|…)?\s*$/i;

function collapseRepeatedLabel(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length % 2 !== 0) return value;
  const half = words.length / 2;
  const left = words.slice(0, half).join(' ');
  const right = words.slice(half).join(' ');
  const comparable = (part: string) => part.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return comparable(left) === comparable(right) ? left.replace(/[\s*.,;:!?]+$/u, '').trim() : value;
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
    .replace(GREENHOUSE_SECTION_HANDLE_RE, ' ')
    .replace(EMPTY_BRACKET_HANDLE_RE, ' ')
    .replace(GREENHOUSE_TRAILING_NUMERIC_HANDLE_RE, ' ')
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
// with one backend-specific addition: selects, radios, and checkboxes are discovered for stored
// answer resolution, then filled later by label-scoped actions rather than direct selector typing.
// Keep this in sync with the extension source by hand, the same as any other ported function in
// this file.
const DISCOVER_QUESTIONS_SCRIPT = String.raw`(() => {
  function clean(s) {
    return (s == null ? '' : s).replace(/[​‌‍﻿ ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function quoteAttr(s) {
    return String(s).replace(/["\\]/g, '\\$&');
  }
  function stableSelector(el, marker) {
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (el.id) return tag + '[id="' + quoteAttr(el.id) + '"]';
    var name = el.getAttribute('name');
    if (name) return tag + '[name="' + quoteAttr(name) + '"]';
    return '[' + marker + ']';
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
    if (legendText) return legendText;
    var group = el.closest('[role="group"], [role="radiogroup"]');
    var groupLabel = group ? group.getAttribute('aria-label') : null;
    if (groupLabel) return groupLabel;
    var labelEl = (el.labels && el.labels[0]) || (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
    var labelText = labelEl && labelEl.textContent ? labelEl.textContent : '';
    var parts = [
      labelText || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('name') || '',
      el.id || '',
    ];
    var own = clean(parts.join(' '));
    if (own) return own;
    var block = el.closest('div, section, li');
    var fallback = block ? block.querySelector('label, legend, .question, h3, h4') : null;
    return ((fallback && fallback.textContent) || '').trim();
  }
  function optionLabel(input) {
    var labelEl = (input.labels && input.labels[0])
      || (input.id ? document.querySelector('label[for="' + CSS.escape(input.id) + '"]') : null);
    return clean(
      (labelEl && labelEl.textContent)
      || input.getAttribute('aria-label')
      || input.getAttribute('data-qa')
      || input.value
      || '',
    );
  }
  // The control's REAL option texts, so the resolver can snap the profile's phrasing onto one of
  // them instead of typing a value the list does not contain. A react-select is not covered here
  // (its options only exist once the menu opens), which is exactly why the resolver still returns
  // a ranked alias ladder when this comes back empty.
  function optionTexts(el) {
    var out = [];
    var i;
    if (el.tagName === 'SELECT') {
      for (i = 0; i < el.options.length; i += 1) {
        var text = clean(el.options[i].label || el.options[i].textContent || '');
        if (text) out.push(text);
      }
      return out;
    }
    if (el.type === 'radio' || el.type === 'checkbox') {
      var name = el.getAttribute('name');
      if (!name) {
        var own = optionLabel(el);
        return own ? [own] : [];
      }
      var group = document.querySelectorAll('input[name="' + quoteAttr(name) + '"]');
      for (i = 0; i < group.length; i += 1) {
        var groupText = optionLabel(group[i]);
        if (groupText) out.push(groupText);
      }
      return out;
    }
    var listId = el.getAttribute('list');
    var list = listId ? document.getElementById(listId) : null;
    if (list) {
      var listOptions = list.querySelectorAll('option');
      for (i = 0; i < listOptions.length; i += 1) {
        var listText = clean(listOptions[i].getAttribute('value') || listOptions[i].textContent || '');
        if (listText) out.push(listText);
      }
    }
    return out;
  }

  var els = Array.prototype.slice
    .call(
      document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input:not([type]), textarea, select, input[type="radio"], input[type="checkbox"]',
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
      selector: stableSelector(el, marker),
      inputType: el.tagName === 'TEXTAREA'
        ? 'textarea'
        : (el.tagName === 'SELECT' ? 'select' : (el.getAttribute('role') === 'combobox' ? 'combobox' : (el.type || 'text'))),
      maxLength: el.maxLength > 0 ? el.maxLength : null,
      options: optionTexts(el),
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
  /* THE SELF-DECLARATIONS COME FIRST, before every classifier in this file.
   *
   * Not a style choice. Each of these is a question a broad rule further down has already answered
   * wrongly on a live application - the PEP question got the applicant's home city because
   * `\bstate\b` matched inside "state-owned", and the master's-graduation-date question got her
   * undergraduate date. Recognising them up here means no later rule can reach them, and each one
   * returns a skipReason rather than null when nothing is stored, so the fall-through to the essay
   * drafter cannot invent an answer either. */
  const politicallyExposed = politicallyExposedAnswer(label, ap);
  if (politicallyExposed) return politicallyExposed;

  const pronouns = pronounsAnswer(label, ap);
  if (pronouns) return pronouns;

  const furtherEducation = furtherEducationAnswer(label, ap);
  if (furtherEducation) return furtherEducation;

  const highSchool = highSchoolGraduationAnswer(label, ap);
  if (highSchool) return highSchool;

  const previouslyApplied = previouslyAppliedAnswer(label, ap);
  if (previouslyApplied) return previouslyApplied;

  const outstandingOffer = outstandingOfferAnswer(label, inputType, ap);
  if (outstandingOffer) return outstandingOffer;

  const applicationConsent = applicationConsentAnswer(label, ap);
  if (applicationConsent) return applicationConsent;

  if (LEGAL_FIRST_NAME_QUESTION.test(label)) {
    // The stored legal name wins over the resume's. That is the entire reason the form asks the
    // question twice: for the person whose legal first name is not the name on their resume, the
    // parsed full name is the WRONG answer, and it is the one we would otherwise give.
    const firstName = ap.legal_first_name ?? ap.full_name?.trim().split(/\s+/)[0];
    return firstName ? { value: firstName } : null;
  }

  if (PREFERRED_NAME_QUESTION.test(label)) {
    // Answered only from an explicit declaration. Null falls through unchanged, because "I have no
    // preferred name" and "never asked" are not distinguishable from an empty column, and stating
    // the first when we only know the second is a claim we cannot back.
    if (ap.preferred_first_name) return { value: ap.preferred_first_name };
  }

  const preferredLocation = locationPreferenceAnswer(label, jdText);
  if (preferredLocation) return preferredLocation;
  if (isLocationChoiceQuestion(label)) {
    return { skipReason: `location choice left for you: "${label.slice(0, 60)}"` };
  }

  const locationStatus = locationStatusAnswer(label, ap);
  if (locationStatus) return locationStatus;

  if (ADVANCED_DEGREE_ENROLLMENT_QUESTION.test(label)) {
    const advancedDegree = advancedDegreeEnrollmentAnswer(ap);
    if (advancedDegree) return advancedDegree;
  }

  if (EMPLOYER_RESTRICTION_AGREEMENT_QUESTION.test(label)) {
    return { value: 'No' };
  }

  if (OPTIONS_MARKET_MAKING_EXPERIENCE_QUESTION.test(label)) {
    return { skipReason: `options market making experience question left for you: "${label.slice(0, 60)}"` };
  }

  if (HIGH_SCHOOL_DIPLOMA_CONFIRMATION_QUESTION.test(label)) {
    // Was an unconditional "Yes". A confirmation that a qualification was earned is a claim about
    // the student's record, so it now needs the record: highSchoolGraduationAnswer above handles
    // every label that says "high school", and this one covers the "equivalent degree"/"GED"
    // phrasings that do not.
    return ap.high_school_grad_date
      ? { value: 'Yes' }
      : { skipReason: `high school graduation question left for you: "${label.slice(0, 60)}"` };
  }

  // Offers are handled by outstandingOfferAnswer at the top of this function, from the stored
  // declaration. The unconditional "No" that used to sit here was a statement about the student's
  // live job search that nothing on file supported.

  if (WORK_AUTHORIZATION_DETAIL_QUESTION.test(label)) {
    return { skipReason: workEligibilitySkipReason(label) };
  }

  if (OPTIONAL_FOLLOWUP_AFTER_NO_QUESTION.test(label)) {
    return { value: 'N/A' };
  }

  if (PRIOR_EMPLOYER_OR_PROGRAM_QUESTION.test(label)) {
    const priorEmployer = priorEmployerAnswer(label, ap);
    if (priorEmployer) return priorEmployer;
    return { skipReason: `prior employer or program question left for you: "${label.slice(0, 60)}"` };
  }

  if (AI_INTERVIEW_POLICY_QUESTION.test(label)) {
    return { value: 'Yes' };
  }

  const stemMajor = stemMajorAnswer(label, ap);
  if (stemMajor) return stemMajor;

  const internshipSeason = postingSeasonAnswer(label, jdText);
  if (internshipSeason) return internshipSeason;

  const internshipJoin = internshipJoinAnswer(label, ap, jdText);
  if (internshipJoin) return internshipJoin;

  if (INTERNSHIP_AVAILABILITY_QUESTION.test(label)) {
    return internshipAvailabilityAnswer(label, ap);
  }

  const softwareEngineeringArea = softwareEngineeringAreaAnswer(label, jdText);
  if (softwareEngineeringArea) return softwareEngineeringArea;

  const programmingLanguage = programmingLanguageAnswer(label, ap);
  if (programmingLanguage) return programmingLanguage;

  const routineConsent = routineConsentAnswer(label, ap);
  if (routineConsent) return routineConsent;

  const routineLocationCommitment = routineLocationCommitmentAnswer(label);
  if (routineLocationCommitment) return routineLocationCommitment;

  const workEligibility = workEligibilityAnswer(label, ap, jdText);
  if (workEligibility) return workEligibility;

  if (AGE_ATTESTATION_QUESTION.test(label)) return null;

  // Before the EEO branch: Point72's "Have you served in the military?" is a required Yes/No with
  // no decline option, and eeoAnswer's "Decline to self-identify" fits none of its choices, so the
  // field stayed empty. Falls through untouched when the question really is an EEO self-ID block.
  const militaryService = militaryServiceAnswer(label, ap);
  if (militaryService) return militaryService;

  if (EEO_QUESTION.test(label)) {
    return { value: eeoAnswer(eeoPreferenceForLabel(label, ap.eeo_prefs)) };
  }

  if (isLegalConsentQuestion(label)) {
    return { skipReason: legalConsentSkipReason(label) };
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
      resolveSalary(
        { label, field: inputType === 'number' ? 'numeric' : 'freetext', jdText },
        storedSalaryOf(ap),
      );
      return { skipReason: `salary question left for you: "${label.slice(0, 60)}"` };
    }
    case 'date_of_birth':
      return ap.date_of_birth ? { value: ap.date_of_birth } : null;
    case 'availability_term':
      return ap.availability_term ? { value: ap.availability_term } : null;
    case 'availability_date':
      return ap.availability_date ? { value: ap.availability_date } : null;
    case 'current_employer':
      return ap.current_employer ? { value: ap.current_employer } : null;
    case 'most_recent_employer':
      return ap.most_recent_employer ? { value: ap.most_recent_employer } : null;
    case 'onsite_commitment':
      return { value: 'Yes' };
    case 'current_enrollment':
      return currentEnrollmentAnswer(ap);
    case 'study_year': {
      const value = studyYearAnswer(ap);
      return value ? { value } : null;
    }
    case 'school':
      return ap.school ? { value: ap.school } : null;
    case 'degree':
      {
        const value = degreeAnswer(label, inputType, ap.degree);
        return value ? { value } : null;
      }
    case 'graduation_date': {
      if (MIXED_ENROLLMENT_GRADUATION_QUESTION.test(label) && !enrollmentConfirmedForGraduationDate(ap)) {
        return { skipReason: `enrollment/graduation date question left for you: "${label.slice(0, 60)}"` };
      }
      if (/\bgraduat(?:ion|e)\s+(?:semester|term)\b|\b(?:expected\s+)?graduat(?:ion|e)\s+semester\b/i.test(label)) {
        const value = graduationSemesterAnswer(ap.grad_date, ap.grad_year);
        return value ? { value } : null;
      }
      const value = graduationDateAnswer(ap.grad_date, ap.grad_year, inputType);
      return value ? { value } : null;
    }
    case 'graduation_month': {
      const value = graduationMonthAnswer(ap.grad_date, ap.grad_year);
      return value ? { value } : null;
    }
    case 'graduation_year': {
      const value = graduationYearAnswer(ap.grad_date, ap.grad_year);
      return value ? { value } : null;
    }
    case 'gpa':
      return ap.gpa ? { value: ap.gpa } : null;
    case 'gpa_scale':
      return ap.gpa_scale ? { value: ap.gpa_scale } : null;
    case 'major':
      {
        const value = majorAnswer(ap);
        return value ? { value } : null;
      }
    case 'languages':
      return languageAnswer(label, ap);
    default:
      return null;
  }
}
