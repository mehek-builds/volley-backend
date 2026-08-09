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
  /**
   * When the applicant STARTED the degree, taken from the parsed education history. Deliberately
   * separate from availability_date: an employer's education block asks for this, and answering it
   * from job availability puts a job start date into an education field (see
   * EDUCATION_ATTENDANCE_DATE_QUESTION).
   */
  education_start_date?: string;
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

  /* Legacy location preferences. These are deliberately not sufficient authority for answering an
   * employer commitment. The stored model has no cadence, duration, office, employer or posting
   * scope, so even `anywhere` cannot truthfully answer "five days a week for twelve weeks". They
   * remain in the read shape for compatibility, but the resolver holds every commitment until a
   * future exact, scoped record contains both location and cadence. */
  onsite_commitment?: 'anywhere' | 'listed_locations' | 'no';
  onsite_locations?: string[];
  relocation_willingness?: 'yes' | 'no';
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
/* One question that mentions both halves, asked in the order that fixes its polarity: the applicant
 * is asked whether she REQUIRES something, so "Yes" is a disclosure and never a claim of
 * eligibility. That ordering is why this family escapes the blanket refusal that other mixed labels
 * get.
 *
 * Widened on 2026-08-09 to "authorization to work" and to a longer gap before it, both measured on
 * Virtu's live label: "do you now, or will you in the future, need sponsorship from an employer in
 * order to obtain, extend or renew your authorization to work in the United States?" is this exact
 * shape, spells the country out, and was refused three times in one run for saying "authorization
 * to work" where the pattern only read "work authorization". The employer clause between the two
 * halves is 55 characters there, past the old 50-character gap.
 */
const SPONSORSHIP_WORK_AUTHORIZATION_SUPPORT_QUESTION =
  /\b(?:do|will|would|can|could)?\s*(?:you\s+)?(?:now\s+or\s+in\s+the\s+future\s+)?(?:requir\w*|need\w*)\b[^?]{0,80}\b(?:sponsor\w*|visa)\b[^?]{0,80}\b(?:work\s+authori[sz]ation|authori[sz]ation\s+to\s+work)\b/i;
const NON_US_WORK_SCOPE =
  /\b(canada|canadian|united kingdom|uk|britain|british|england|european union|eu|australia|australian|india|indian|united arab emirates|uae|dubai|singapore|germany|france|ireland|netherlands|hungary|hungarian|japan|korea|china)\b/i;
const US_WORK_SCOPE = /\b(?:united states|usa|america(?:n)?)\b|\bu\.s\.(?=\s|$|[?,;:)])/i;
/* THE ABBREVIATION, MATCHED WITHOUT REGARD TO CASE, BECAUSE PRODUCTION NEVER SEES THE CAPITALS.
 *
 * Measured on the owner's live packets on 2026-08-09: all 519 stored question labels are
 * all-lowercase by the time they reach this file, and refreshKnownQuestionAnswers (below) re-runs
 * resolveKnownAnswer over that stored text on every send. A case-SENSITIVE \bUS\b therefore could
 * not fire on a real application at all, so truveta's "...require visa sponsorship to continue
 * working in the us?" and Roblox's "...authorized to work in the us?" were both read as naming no
 * country, and refused for saying nothing about scope while saying "us" twice.
 *
 * The capitals were doing real work, though: they were the only thing keeping the English pronoun
 * out of a country test ("tell us whether...", "are you able to work with us?"). Case is replaced
 * by SHAPE, which survives lowercasing. The pronoun is not preceded by "the", and it is not
 * followed by an eligibility noun, so every alternative below is closed to it. The
 * questionDiscovery tests pin both pronoun spellings.
 */
const US_ABBREVIATION_SCOPE =
  /\b(?:in|within|throughout|across)\s+(?:the\s+)?us\b|\bthe\s+us\s*[?.,;:)]|\bus\s+(?:work|employment|visa|immigration|authori[sz]ation)\b/i;
/* The employer defers the country to the posting instead of naming it.
 *
 * Broadened on 2026-08-09, measured: the three fixed phrasings it held missed Deepgram's "the
 * country where THIS ROLE is located", DV Trading's "work authorization in THIS COUNTRY" and Scale
 * AI's "the country where the job is located" variants. That went unnoticed while an unscoped label
 * was refused anyway; once a stored "yes I need sponsorship" may answer an unscoped label, this is
 * the rule that has to hold the line, so it now recognises the family rather than three sentences.
 * The posting's own location deliberately does not count as scope evidence: reading a legal
 * declaration off the JD is the inference be1bccf removed.
 */
const JOB_LOCATION_SCOPE =
  /\bcountry\s+(?:where|which|in\s+which|to\s+which|for\s+which)\b|\bwhere\s+(?:the|this)\s+(?:job|role|position)\s+is\s+(?:located|based|situated)\b|\bin\s+this\s+country\b|\bcountry\s+of\s+(?:the\s+)?(?:job|role|position|employment)\b/i;
export const ROUTINE_APPLICANT_CONSENT_QUESTION =
  /\b(?:consent|agree|acknowledg\w*|approve|confirm)\b[\s\S]{0,180}\b(?:process(?:ing)?|use|using|collect(?:ion)?|retain|store|privacy\s+policy|privacy\s+notice|notice\s+at\s+collection)\b[\s\S]{0,180}\b(?:personal\s+information|personal\s+data|application|applicant|candidacy|candidate|privacy\s+policy|privacy\s+notice|notice\s+at\s+collection|infrastructure|platform|data)\b|\bplease\s+review\s+and\s+acknowledg\w*\b[\s\S]{0,120}\b(?:candidate|applicant)\s+privacy\s+(?:policy|notice)\b|\byes,\s*i\s+consent\b/i;

export const EEO_QUESTION =
  /transgender|\bgender\b|what is your sex\b|race|racial|ethnicit|ethnic\b|hispanic|latino|veteran|military|disab|sexual orientation|lgbtq|lgbtqia|communities|which categories describe you|identify with|current age|what is your age|age range|how old are you|\bage group\b/i;
/* THE 18+ ATTESTATION, both framings.
 *
 * Widened from the four shapes it was written against, measured on every distinct label Litos has
 * stored: the corpus itself only carries "At the time of application, are you 18+ years of age?",
 * but "18 years or older" and "18 or older" are the two common phrasings the old pattern missed
 * entirely - they were not even recognised as age questions, so they would have fallen through to
 * classifyField instead of stopping.
 *
 * Deliberately still 18-specific and still requiring an age word next to the number. The nearest
 * miss in the corpus is IMC's "applied ... within the last 12-18 months", and none of these
 * alternatives can reach it.
 */
export const AGE_ATTESTATION_QUESTION =
  /(?:\b18\+\s*(?:years?)?|\beighteen\b|\bat\s+least\s+18\b|\b18\s+years?\s+of\s+age\b|\bage\s+of\s+18\b|\b18\s+(?:years?\s+)?or\s+older\b|\b(?:over|older\s+than)\s+(?:the\s+age\s+of\s+)?18\b|\bunder\s+18\b|\byounger\s+than\s+18\b)/i;
/* The MINOR framing of that same attestation, which takes the OPPOSITE answer.
 *
 * "Yes" to "are you 18 or older" and "Yes" to "are you under 18" are contradictory statements
 * about the same person. A handler that could not tell them apart would declare a twenty-year-old
 * a minor on a form she never read, so the inversion is recognised explicitly rather than assumed
 * away. Note that the old AGE_ATTESTATION_QUESTION already matched "are you under 18 years of
 * age?" through its `18 years of age` alternative, which is precisely why answering the family
 * without this split would have been unsafe.
 */
const BELOW_AGE_18_QUESTION =
  /\b(?:under|below|younger\s+than|less\s+than)\s+(?:the\s+age\s+of\s+)?(?:18|eighteen)\b|\bare\s+you\s+a\s+minor\b/i;
/* THE NUMBER 18 USED FOR SOMETHING THAT IS NOT AN AGE.
 *
 * Carried over from the extension's own copy of this rule
 * (student-outreach-extension/src/lib/adapters/generic.ts, desiredAnswer), where it is not
 * hypothetical: "do you have 18+ months of experience?" and "at least 18 years of experience"
 * both satisfy the alternatives above, and Litos answered Yes, claiming experience the student
 * never stated. That cost nothing while the age family was blanket-refused here. It costs a false
 * declaration the moment the family becomes answerable, which is what this change does.
 */
const AGE_18_USED_AS_A_DURATION =
  /\bexperience\b|\bmonths?\b|\btenure\b|\bcredits?\b|\bunits?\b|\bhours?\b|\bemployment\b/i;
export const LEGAL_CONSENT_QUESTION =
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

/* A sponsorship question phrased so that "Yes" would CLAIM eligibility instead of disclosing a
 * need, which inverts the whole rule below.
 *
 * UNRESTRICTED_WORK_AUTHORIZATION_QUESTION already carries the four framings the corpus contains
 * ("all employers", "any employer", "without sponsorship", "without restriction"). "Exempt from
 * sponsorship" is not in the corpus and is named here anyway, precautionary: it is the one other
 * common way to ask this question backwards, and reading it forwards would answer "Yes, I am
 * exempt" for an applicant who needs sponsorship. That is R-004's false legal declaration again,
 * so the cheap guard is worth more than the label it may never meet.
 */
const SPONSORSHIP_EXEMPTION_QUESTION = /\bexempt\b[^?]{0,40}\bsponsor/i;

function workEligibilityAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  const explicitlyUsScoped = US_WORK_SCOPE.test(label) || US_ABBREVIATION_SCOPE.test(label);
  if (WORK_AUTHORIZATION_DETAIL_QUESTION.test(label)) {
    return { skipReason: workEligibilitySkipReason(label) };
  }
  const asksAuthorization = WORK_AUTHORIZATION_QUESTION.test(label);
  const asksSponsorship = SPONSORSHIP_QUESTION.test(label);
  const namesAnotherCountry = NON_US_WORK_SCOPE.test(label) || JOB_LOCATION_SCOPE.test(label);
  /* THE COUNTRY GATE IS NOT SYMMETRIC, AND THE ASYMMETRY IS THE ENTIRE RULE.
   *
   * The gate above it exists because the legacy booleans were collected without a country, so an
   * unscoped question cannot be answered from them. That is true of the answers that CLAIM
   * something - "yes I am authorized", "no I need no sponsorship" - because a claim of eligibility
   * in a country nobody named is a false legal declaration waiting to happen, and it is the defect
   * R-004 was opened for.
   *
   * It is not true of "yes, I need sponsorship". That answer discloses a limitation rather than
   * asserting a permission: it can only ever narrow what an employer will offer, never obtain
   * something under false pretenses, and it is what needs_sponsorship literally records. Requiring
   * the employer to spell "United States" before Litos will repeat a stored "yes" cost fourteen of
   * twenty-five packets in the 2026-08-08 run their sponsorship answer, including Cloudflare
   * ("...to work at Cloudflare?"), Redwood Materials (which lists only US visa categories),
   * IMC, Five Rings, Point72, Anduril and DRW. Not one of those employers named a country, and
   * every one of them was told nothing instead of being told the truth.
   *
   * The two exceptions stay exceptions. A label that NAMES another country, or that defers to "the
   * country where the job is located", is refused even in this direction: "yes I need sponsorship"
   * is wrong AND costly for a role in the one country where she may not, and the posting's own
   * location is a JD inference, which is exactly what be1bccf removed. And a label phrased
   * backwards is refused, because "yes" there is a claim again, not a disclosure.
   */
  const disclosesSponsorshipNeed = ap.needs_sponsorship === true
    && !UNRESTRICTED_WORK_AUTHORIZATION_QUESTION.test(label)
    && !SPONSORSHIP_EXEMPTION_QUESTION.test(label);
  if (asksAuthorization && asksSponsorship && SPONSORSHIP_WORK_AUTHORIZATION_SUPPORT_QUESTION.test(label)) {
    if (namesAnotherCountry) return { skipReason: workEligibilitySkipReason(label) };
    if (disclosesSponsorshipNeed) return { value: 'Yes' };
    if (!explicitlyUsScoped) return { skipReason: workEligibilitySkipReason(label) };
    if (typeof ap.needs_sponsorship === 'boolean') {
      return { value: ap.needs_sponsorship ? 'Yes' : 'No' };
    }
    return { skipReason: workEligibilitySkipReason(label) };
  }
  if (!asksAuthorization && !asksSponsorship) return null;
  if (asksAuthorization && asksSponsorship) return { skipReason: workEligibilitySkipReason(label) };
  if (namesAnotherCountry) return { skipReason: workEligibilitySkipReason(label) };
  if (asksSponsorship && disclosesSponsorshipNeed) return { value: 'Yes' };
  // The legacy booleans were collected without a country. Every answer left below this line asserts
  // eligibility, so it is usable only when the employer's own question explicitly says United
  // States. A JD mentioning a US office, benefit, customer or legal notice is not scope evidence,
  // and an unscoped question is not implicitly American.
  if (!explicitlyUsScoped) {
    return { skipReason: workEligibilitySkipReason(label) };
  }
  if (asksAuthorization && UNRESTRICTED_WORK_AUTHORIZATION_QUESTION.test(label) && ap.needs_sponsorship === true) {
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

/** Every employer agreement is scoped to the exact application and exact text shown there.
 *
 * The legacy profile has standing booleans for truthfulness and privacy notices. Neither proves
 * that the applicant saw this employer's current notice or reviewed this exact packet, so neither
 * is consulted here. The booleans remain readable for migration compatibility only.
 */
function applicationConsentAnswer(label: string): { skipReason: string } | null {
  if (TRUE_COMPLETE_ACCURATE_CERTIFICATION.test(label)) {
    return { skipReason: attestationSkipReason(label, 'certification that your information is true') };
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
    return { skipReason: attestationSkipReason(label, 'privacy notice') };
  }
  return null;
}

function routineConsentAnswer(label: string): { skipReason: string } | null {
  const hold = (): { skipReason: string } => ({ skipReason: attestationSkipReason(label, 'privacy notice') });
  if (/^\s*processing\s+of\s+personal\s+data\s*$/i.test(label)) return hold();
  if (/demographic data survey/i.test(label)) return null;
  if (/^\s*yes,\s*i\s+consent\s*$/i.test(label)) return hold();
  if (
    /\b(?:candidate|applicant)\s+privacy\s+(?:policy|notice)\b/i.test(label)
    && /\b(?:agree|consent|acknowledg\w*|processed?|processing)\b/i.test(label)
  ) {
    return hold();
  }
  if (/\bjob application\b/i.test(label) && /\bprocess(?:ed|ing)?\b/i.test(label) && /\b(?:information|data)\b/i.test(label)) {
    return hold();
  }
  return ROUTINE_APPLICANT_CONSENT_QUESTION.test(label) ? hold() : null;
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
  // Same sentence integrate/submission-flow's refusal used, deliberately: this replaced that rule
  // rather than sitting beside it, and two wordings for one refusal is two things to keep in step.
  return {
    skipReason: `politically-exposed-person declaration left for you: "${label.slice(0, 60)}"`,
  };
}

/**
 * A U.S. export-control eligibility question (EAR, ITAR, "U.S. person" status).
 *
 * Measured on the Anduril packet of 2026-08-08: 'EXPORT CONTROLS - This position requires access to
 * information and technology that is subject to U.S. export controls...' came back required and
 * still empty, because nothing in this file recognised it: it fell past every rule to
 * "not a known field, not an essay: leave it alone" and no one was ever told it was waiting.
 *
 * It is answered from an explicit stored declaration or not at all. There is deliberately no
 * inference here, and the profile fields that LOOK like they answer it are exactly the ones that
 * must not: citizenship, work_authorized and needs_sponsorship each describe a different legal
 * status, and "U.S. person" under the EAR covers permanent residents and certain protected
 * individuals while excluding some visa holders who are fully authorized to work. Getting it wrong
 * is a false statement to the U.S. government made in the applicant's name, so this refuses,
 * by name, every time. Nothing is stored for it yet (it is one posting, below the two-posting bar
 * for an onboarding question), so today this always refuses; the shape is here so that adding the
 * stored answer later is the only change needed.
 */
export const EXPORT_CONTROL_QUESTION =
  /\bexport\s+control(?:s|led)?\b|\bexport\s+administration\s+regulations?\b|\bexport\s+(?:regulations?|laws?|licens\w*|compliance)\b|\bitar\b|\bear\s?99\b|\bdeemed\s+export\b|\bu\.?\s?s\.?\s+person\s+(?:status|as\s+defined|under)\b/i;

/**
 * Databricks' sanctions checklist, which mentions export controls and is NOT this question.
 *
 * "Please confirm whether any of the below applies to you. Select all that apply. Note: this
 * information will only be used to ensure compliance with U.S. sanctions and export controls." is a
 * checkbox LIST whose true answer is "None of the above", which the applicant answers herself and
 * portalSubmission already knows how to tick. Refusing it here would take that stored answer back
 * out of the packet, so it keeps the path it has and only the eligibility self-declaration is
 * refused.
 */
const SANCTIONS_CHECKLIST_QUESTION =
  /\bsanctions\b[^?]{0,120}\bexport\s+controls?\b|\bselect\s+all\s+that\s+apply\b/i;

export function exportControlSkipReason(label: string): string {
  return `export-control declaration left for you: "${label.slice(0, 60)}"`;
}

function exportControlAnswer(label: string): { skipReason: string } | null {
  if (!EXPORT_CONTROL_QUESTION.test(label)) return null;
  if (SANCTIONS_CHECKLIST_QUESTION.test(label)) return null;
  return { skipReason: exportControlSkipReason(label) };
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

export function onsiteCommitmentSkipReason(label: string): string {
  return `where you will work from is yours to answer: "${label.slice(0, 60)}"`;
}

/** The legacy profile records a broad location preference but no cadence or posting scope.
 * Consequently every office, onsite, commute and relocation commitment is held. A future resolver
 * may relay an answer only from an exact record that matches the employer, location, cadence and
 * duration in this label. */
function onsiteCommitmentAnswer(label: string): { skipReason: string } {
  return { skipReason: onsiteCommitmentSkipReason(label) };
}

function routineLocationCommitmentAnswer(
  label: string,
): { value: string } | { skipReason: string } | null {
  return isLocationCommitmentQuestion(label) ? onsiteCommitmentAnswer(label) : null;
}

/* AGE_ATTESTATION_QUESTION is no longer in this list, and that is the whole of the second half of
 * this change. It sat here beside SSN and CAPTCHA, so "are you 18+ years of age?" was refused
 * before anything looked at whether the answer was known - and it is knowable. An age computed
 * from a stored date of birth is a FACT, not a self-declaration: the applicant told Litos when she
 * was born, and arithmetic on that is not Litos making a claim on her behalf.
 *
 * The refusal did not disappear, it moved and got a condition. ageAttestationAnswer runs at the
 * top of resolveKnownAnswer and returns a skipReason whenever date_of_birth is absent or
 * unreadable, so a profile with nothing stored stops exactly as it does today. It stays in
 * selfDeclaration.ts's list too, which is the belt to this brace: no drafter may ever invent it.
 */
export function isRefusedQuestion(label: string): boolean {
  const l = label ?? '';
  return NEVER_FILL_PATTERNS.some((re) => re.test(l)) || WORK_ELIGIBILITY_QUESTION.test(l) || EEO_QUESTION.test(l);
}

/**
 * The applicant's whole legal name, composed rather than looked up.
 *
 * There is no legal-surname column. There is a stored legal FIRST name and a parsed full name, so
 * the honest composition is the stored legal first name followed by everything after the first
 * token of the parsed name, and the parsed name unchanged when no legal first name was ever given.
 *
 * The stored legal first name WINS, always. That is the distinction the legal-first-name arm below
 * exists to protect and it survives here: the person this question is asked of is the one whose
 * legal first name is not the name on her resume, and composing "Legal Name" from the resume's
 * first token would hand the employer the exact name she came here to correct. Nothing is invented
 * either - with an empty profile this returns undefined and the question is left alone.
 */
function composedLegalName(ap: ApplicationProfileLike): string | undefined {
  const fullName = ap.full_name?.trim().replace(/\s+/g, ' ');
  const legalFirst = ap.legal_first_name?.trim().replace(/\s+/g, ' ');
  if (!legalFirst) return fullName || undefined;
  if (!fullName) return legalFirst;
  const surname = fullName.split(' ').slice(1);
  return surname.length ? [legalFirst, ...surname].join(' ') : legalFirst;
}

export function ageAttestationSkipReason(label: string): string {
  // Worded to carry the phrase "sensitive question", which is what attentionCategoriesForReasons
  // matches to file this under sensitive_attestation. Avoids the word "file" on purpose: that
  // function's required_document arm matches a bare /file/, and "not on file" would have routed an
  // age question to the missing-transcript bucket.
  return `sensitive question left for you, because your date of birth is not saved: "${label.slice(0, 60)}"`;
}

/**
 * Completed years between a stored date of birth and `now`, or undefined when the stored text is
 * not a date this can read.
 *
 * Only ever called with application_profile.date_of_birth. Nothing else in the profile is an
 * acceptable input: a graduation year, a resume, or a document in the vault would all give a
 * number, and every one of them would be a guess presented to an employer as an attestation.
 * An unparseable string is treated exactly like an absent one.
 */
function ageInCompletedYears(dateOfBirth: string | undefined, now: Date): number | undefined {
  const raw = dateOfBirth?.trim();
  if (!raw) return undefined;
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00Z` : raw);
  const time = parsed.getTime();
  if (!Number.isFinite(time)) return undefined;
  // A birth date in the future, or before anyone alive, is corrupt rather than informative.
  const years = (now.getTime() - time) / (365.2425 * 24 * 60 * 60 * 1000);
  if (years < 0 || years > 130) return undefined;
  let age = now.getUTCFullYear() - parsed.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - parsed.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < parsed.getUTCDate())) age -= 1;
  return age;
}

/**
 * "At the time of application, are you 18+ years of age?" answered from the stored date of birth.
 *
 * Returns null for every label that is not an age attestation, a skipReason when nothing is
 * stored, and Yes/No otherwise - with the answer inverted for the "are you under 18" framing.
 */
function ageAttestationAnswer(
  label: string,
  ap: ApplicationProfileLike,
  now: Date = new Date(),
): { value: string } | { skipReason: string } | null {
  if (!AGE_ATTESTATION_QUESTION.test(label)) return null;
  // "18 months of experience" is not an age. Falls through to the rules that were handling it
  // before, which is nothing plus selfDeclaration's refusal, exactly as today.
  if (AGE_18_USED_AS_A_DURATION.test(label)) return null;
  // "What is your age?", "age range", "how old are you" are EEO self-identification, answered by
  // the EEO branch from the applicant's own preference. A label that asks for the age ITSELF is
  // not an attestation, even when it happens to mention 18.
  if (EEO_QUESTION.test(label)) return null;
  const age = ageInCompletedYears(ap.date_of_birth, now);
  if (age === undefined) return { skipReason: ageAttestationSkipReason(label) };
  const isAdult = age >= 18;
  return { value: (BELOW_AGE_18_QUESTION.test(label) ? !isAdult : isAdult) ? 'Yes' : 'No' };
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
  questionsReviewedAt?: string,
): T[] {
  return questions.map((question) => {
    const label = normalizeReviewQuestionLabel(question.question);
    const known = label ? resolveKnownAnswer(label, 'text', ap, jdText) : null;
    const withProvenance = question as T & {
      answer_source?: unknown;
      answer_reviewed_at?: unknown;
    };
    const applicantReviewedCurrentAnswer = Boolean(
      question.answer.trim()
      && withProvenance.answer_source === 'applicant_review'
      && typeof withProvenance.answer_reviewed_at === 'string'
      && withProvenance.answer_reviewed_at === questionsReviewedAt,
    );
    const withoutProvenance = (): T => {
      const {
        answer_source: _answerSource,
        answer_reviewed_at: _answerReviewedAt,
        ...rest
      } = withProvenance;
      return rest as T;
    };
    if (known && 'value' in known) return { ...withoutProvenance(), answer: known.value };
    const currentResolverRefuses = Boolean(known && 'skipReason' in known)
      || Boolean(label && isRefusedQuestion(label));
    if (currentResolverRefuses && !applicantReviewedCurrentAnswer) {
      return { ...withoutProvenance(), answer: '' };
    }
    return question;
  });
}

const RESIDENCE_QUESTION =
  /country of residence|which country|country you.{0,20}(based|resid|work from|located)|where are you based|based in which country|current country|country.{0,20}(residing|residence)|\bcountry\b/i;
const LOCATION_COMMITMENT_STEM = /\b(?:are|can|could|do|did|will|would|should|may|might|have)\s+you\b/i;
// "in person" belongs on this list and its absence was measured, not theorised. Anduril asks
// "Are you willing to work in-person for 12 weeks during the internship?" and, with only the
// office/onsite/hybrid words here, that fell past every rule to the ESSAY DRAFTER: a react-select
// with a fixed Yes/No list was handed a paragraph, so the required field stayed empty, and the
// paragraph the model wrote mentioned Los Angeles, which is where the false grounding warning on
// that same packet came from. Four distinct postings ask this in the owner's history (Anduril,
// Postman, Fluency, Brex), all of them asking the same routine question the office wording already
// answers Yes to.
const LOCATION_COMMITMENT_VOCAB = /\boffice\b|in[\s-]?office|on[\s-]?site|\bonsite\b|in[\s-]?person|\bhybrid\b|\bremote(?:ly|[\s-]?only)?\b|work\s+from\s+home|relocat|commut/i;
const STORED_ONSITE_COMMITMENT_QUESTION =
  /\b(?:able|willing|available|prepared|can|could|would)\b[^?]{0,80}\b(?:office|in[\s-]?office|on[\s-]?site|onsite|in[\s-]?person|hybrid)\b|\b(?:office|in[\s-]?office|on[\s-]?site|onsite|in[\s-]?person|hybrid)\b[^?]{0,80}\b(?:able|willing|available|prepared|can|could|would)\b/i;
const ONSITE_DAY_COUNT_QUESTION = /\b(?:three|four|five|3|4|5)\s+days?\b/i;
const LOCATION_PREFERENCE_QUESTION =
  /\b(?:single|top|preferred|preference|most interested)\b[^?]{0,120}\blocation\b|\blocation\b[^?]{0,120}\b(?:single|top|preferred|preference|most interested)\b/i;
const LOCATION_CHOICE_QUESTION =
  /\b(?:choose|select|pick)\b[^?]{0,120}\b(?:single|top|preferred|preference|most interested|location|office)\b|\b(?:single|top|most interested)\b[^?]{0,120}\blocation\b|\blocation\b[^?]{0,120}\b(?:single|top|most interested)\b/i;

export function isLocationCommitmentQuestion(label: string): boolean {
  return LOCATION_COMMITMENT_STEM.test(label) && LOCATION_COMMITMENT_VOCAB.test(label);
}

/** A list of acceptable metros is not an answer to this employer's ranking or preference question.
 * The offered options, ordering and role context are posting-specific, so this always holds. */
function locationPreferenceAnswer(label: string): { skipReason: string } | null {
  if (!LOCATION_PREFERENCE_QUESTION.test(label) && !isLocationChoiceQuestion(label)) return null;
  return { skipReason: `location choice left for you: "${label.slice(0, 60)}"` };
}

export function isLocationChoiceQuestion(label: string): boolean {
  return LOCATION_CHOICE_QUESTION.test(label);
}

export const REFERRAL_QUESTION = /how did you .*hear|how did you hear|first hear|referral source|hear about (this|us|the)|where have you learned about|source of/i;
export const START_DATE_QUESTION = /availab|start(ing)?\s+date|date.*you.*start|when can you start|earliest.*start/i;
// Greenhouse renders its education block as one row per school: "School", "Degree", "Discipline",
// "Start date month", "Start date year", "End date month", "End date year" (handles school--0,
// degree--0, discipline--0, start-month--0, ...). Those start/end dates are when the APPLICANT
// ATTENDED, not when they can start the job - but "start date month" also matches
// START_DATE_QUESTION, so availability_date won and Five Rings, IMC and Tower were all sent
// "August 6, 2026" as an education start month. This must be recognised before START_DATE_QUESTION.
export const EDUCATION_ATTENDANCE_DATE_QUESTION =
  /\b(?:start|end)\s*date\s*(?:month|year)\b|\b(?:start|end)[\s-]*(?:month|year)--\d+\b|\b(?:start|end)\s*(?:month|year)\b[^?]{0,80}\b(?:school|university|college|institution|program|degree|stud(?:y|ies))\b|\b(?:school|university|college|institution|program|degree|stud(?:y|ies))\b[^?]{0,80}\b(?:start|end)\s*(?:month|year)\b|\bdates?\s+attended\b|\battendance\s+dates?\b/i;
const EDUCATION_ATTENDANCE_START_MARKER = /\bstart\b/i;
const EDUCATION_ATTENDANCE_END_MARKER = /\bend\b|\bgraduat/i;
const EDUCATION_ATTENDANCE_MONTH_MARKER = /\bmonth\b/i;
const EDUCATION_ATTENDANCE_YEAR_MARKER = /\byear\b/i;
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
export const EMPLOYER_RESTRICTION_AGREEMENT_QUESTION =
  /\bbound\b[^?]{0,120}\bagreements?\b[^?]{0,180}\b(?:restrict|limit)\b[^?]{0,120}\b(?:ability\s+to\s+work|employment|duties)\b|\b(?:non-compete|non-solicitation|confidentiality|non-disclosure)\b[^?]{0,180}\b(?:restrict|limit|bound)\b/i;
const CURRENT_EMPLOYER_QUESTION =
  /\bcurrent\s+employer\b|\bwhere\s+do\s+you\s+(?:currently\s+)?work\b|\bwhere\s+are\s+you\s+currently\s+(?:employed|working)\b/i;
const MOST_RECENT_EMPLOYER_QUESTION =
  /\bwhere\s+have\s+you\s+most\s+recently\s+worked\b|\bmost\s+recent\s+employer\b/i;
const PRIOR_EMPLOYER_OR_PROGRAM_QUESTION =
  /\bhave\s+you\s+(?:ever\s+|previously\s+)?(?:worked|been\s+employed)\s+(?:for|by|at)\b|\bhave\s+you\s+been\s+enrolled\s+in\b[^?]{0,120}\bin\s+the\s+past\s+\d+\s+months\b/i;
const STEM_MAJOR_QUESTION =
  /\bmajoring\s+in\s+STEM\b|\bSTEM\b[^?]{0,160}\b(?:Computer Science|Electrical Engineering|Data Science|Mathematics|Machine Learning)\b/i;
export const AI_INTERVIEW_POLICY_QUESTION =
  /\bAI\s+Policy\s+for\s+Interviewers\b|\bdo\s+not\s+use\s+any\s+AI\s+tools\b[^?]{0,160}\binterview\b/i;
const INTERNSHIP_AVAILABILITY_QUESTION =
  /\b(?:are|will)\s+you\s+available\b[^?]{0,160}\b(?:internship|full-time|40\s*hours|weeks?)\b|\b(?:internship|full-time|40\s*hours|weeks?)\b[^?]{0,160}\b(?:are|will)\s+you\s+available\b|\b(?:can|could|will|would)\s+you\s+commit\b[^?]{0,160}\b(?:hours?|weeks?|months?|schedule|season)\b/i;
const INTERNSHIP_SEASON_QUESTION =
  /\bconfirm\b[^?]{0,100}\bseason\b[^?]{0,100}\bapplying\b|\bseason\b[^?]{0,100}\bapplying\b/i;
const INTERNSHIP_JOIN_QUESTION =
  /\bwhen\b[^?]{0,120}\b(?:able|available|start|join)\b[^?]{0,120}\bintern\b|\bintern\b[^?]{0,120}\b(?:able|available|start|join)\b/i;
const SOFTWARE_ENGINEERING_AREA_QUESTION =
  /\b(?:area|track|team)\s+of\s+interest\b[^?]{0,120}\bsoftware\s+engineering\b|\bsoftware\s+engineering\b[^?]{0,120}\b(?:area|track|team)\s+of\s+interest\b/i;
export const HIGH_SCHOOL_DIPLOMA_CONFIRMATION_QUESTION =
  /\b(?:earned|have|hold|received|obtained)\b[^?]{0,120}\b(?:high\s+school\s+diploma|equivalent\s+degree|ged)\b|\b(?:high\s+school\s+diploma|equivalent\s+degree|ged)\b[^?]{0,120}\b(?:confirm|acknowledge|certify|required|must\s+have)\b/i;
export const OFFER_DEADLINE_QUESTION =
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
/* Roblox's "Legal Name", and the Workday shape "Full Legal Name" - the WHOLE name in one control.
 *
 * LEGAL_FIRST_NAME_QUESTION cannot match either, correctly: "legal first name" and "legal name"
 * are different questions and answering one with the other's answer is wrong in both directions.
 * So the label matched nothing at all, and a live Roblox run stopped on `"Legal Name" is required
 * and is still empty` with the name sitting in the profile the whole time.
 *
 * Kept deliberately narrow: it requires "legal" IMMEDIATELY followed by "name". Measured against
 * every distinct stored label, the only two it reaches are "legal name" and "full legal name",
 * and none of the six legal-first-name or legal-last-name labels satisfies it. */
const LEGAL_FULL_NAME_QUESTION =
  /\b(?:full\s+)?legal\s+name\b|\blegal\s+full\s+name\b/i;
export const TOP_ROLE_PREFERENCE_ACKNOWLEDGEMENT =
  /\banswering\s+[“"]?yes[”"]?\s+below\b[^?]{0,220}\btop\s+preference\b|\btop\s+preference\b[^?]{0,220}\banswering\s+[“"]?yes[”"]?\s+below\b/i;
export const RESUME_PDF_ACKNOWLEDGEMENT =
  /\bresume\b[^?]{0,120}\bPDF\s+format\b|\bPDF\s+format\b[^?]{0,120}\bresume\b/i;
export const TRUE_COMPLETE_ACCURATE_CERTIFICATION =
  /\bcertif(?:y|ication)\b[^?]{0,220}\b(?:information|application)\b[^?]{0,180}\btrue\b[^?]{0,120}\bcomplete\b(?:[^?]{0,120}\b(?:accurate|correct)\b)?|\bcertify\b[^?]{0,220}\btrue\b[^?]{0,120}\bcomplete\b[^?]{0,120}\baccurate\b/i;
const NY_CA_RESIDENCE_QUESTION =
  /\b(?:live|reside|located)\b[^?]{0,80}\bnew\s+york\b[^?]{0,80}\bcalifornia\b|\bnew\s+york\b[^?]{0,80}\bcalifornia\b[^?]{0,80}\b(?:live|reside|located)\b/i;
// Politically-exposed-person declarations (Tower asks two). These are regulated legal statements
// about public office held by the applicant or an immediate family member. Nothing in the profile
// answers them, and a drafted paragraph would be an invented declaration. One already went out
// answered "Dubai", because the label mentions a "state-owned bank" and the address_state fallback
// took the word "state"; the other was answered with drafted prose.
//
// `state-owned` is a POSITIVE match here precisely because it is the phrase that caused the harm:
// naming it means the question is recognised for what it is and short-circuited before any
// residence rule can see the word "state" inside it.
export const POLITICALLY_EXPOSED_PERSON_QUESTION =
  /\bpolitically\s+exposed\b|\bentrusted\s+with\s+a\s+(?:prominent\s+)?(?:public\s+)?(?:position|function)\b|\bstate[-\s](?:owned|controlled|run)\b(?:[^?]{0,160}\b(?:bank|brokerage|enterprise)\b)?|\bsenior\s+(?:political|government)\s+figure\b|\bimmediate\s+family\s+member\s+of\s+someone\s+holding\s+such\s+a\s+position\b/i;
// "Authorized to work for ALL employers", "without sponsorship", "without restriction": a narrower
// claim than work_authorized records. Someone who needs sponsorship is authorized to work, but not
// for every employer without one, so answering these "Yes" off work_authorized is a false legal
// declaration - the exact failure R-004 was opened for.
export const UNRESTRICTED_WORK_AUTHORIZATION_QUESTION =
  /\ball\s+employers?\b|\bany\s+employer\b|\bwithout\s+(?:the\s+need\s+for\s+)?(?:visa\s+)?sponsorship\b|\bwithout\s+restriction\b|\bwithout\s+(?:any\s+)?(?:current\s+or\s+future\s+)?need\s+for\s+sponsorship\b/i;
const OPTIONS_MARKET_MAKING_EXPERIENCE_QUESTION =
  /\b(?:options\s+market\s+making|market\s+making\s+trading|trading\s+firm)\b/i;
export const WORK_AUTHORIZATION_DETAIL_QUESTION =
  /\b(?:current\s+immigration\s+status|basis\s+of\s+your\s+current\s+work\s+authorization|when\s+does\s+it\s+expire|extension\s+options?|additional\s+detail\s+about\s+your\s+sponsorship\s+need)\b/i;
// school/degree/grad_date describe the programme the applicant is in NOW. A question scoped to a
// DIFFERENT or LATER programme is not answered by them, however closely the wording matches. Two
// shipped wrong: Akuna was sent the bachelor's date as a "potential master's graduation date", and
// Five Rings was sent the current bachelor's as the degree she "plans to pursue" - directly after
// she had answered that she was not planning further study.
const FUTURE_OR_OTHER_PROGRAMME_QUESTION =
  /\b(?:plan(?:ning)?\s+to\s+pursue|intend(?:ing)?\s+to\s+pursue|following\s+graduation|after\s+(?:you\s+)?(?:graduat\w+|completing)|further\s+education|additional\s+degree|next\s+degree|potential\s+(?:master|masters|ph\.?d|doctorate))\b/i;
const CURRENT_PROGRAMME_KEYS = new Set<ProfileKey>([
  'school', 'degree', 'major', 'graduation_date', 'graduation_month', 'graduation_year',
  'education_start_date', 'education_end_date', 'study_year', 'gpa', 'gpa_scale',
]);
// "Please confirm the month and year of your high school graduation" is a DATE request wearing a
// confirmation's clothes. Answering the diploma confirmation's "Yes" there is not an answer.
const HIGH_SCHOOL_GRADUATION_DATE_REQUEST =
  /\b(?:month|year|date)\b[^?]{0,80}\b(?:high\s+school|equivalent)\b|\b(?:high\s+school|equivalent)\b[^?]{0,80}\b(?:month|year|date)\b/i;

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
export const PRONOUNS_QUESTION = /\bpronouns?\b/i;

/* POLITICALLY EXPOSED PERSON, the family half.
 *
 * The person half is POLITICALLY_EXPOSED_PERSON_QUESTION above, which arrived on
 * integrate/submission-flow as a refusal and is extended there rather than redeclared here. Tower
 * asks two questions and they take two answers, so the family variant needs its own pattern: it is
 * matched FIRST in politicallyExposedAnswer, because the person pattern also covers its wording. */
export const POLITICALLY_EXPOSED_FAMILY_QUESTION =
  /\bimmediate\s+family\s+member\b[\s\S]{0,200}\b(?:holding\s+such|such\s+a\s+position|politically\s+exposed)\b|\b(?:close\s+associate|family\s+member)\b[\s\S]{0,160}\bpolitically\s+exposed\b/i;

// Point72's "Have you served in the military?" - a required Yes/No that is not part of an EEO
// block, and so cannot be answered with "Decline to self-identify".
export const MILITARY_SERVICE_QUESTION =
  /\bmilitary\b|\barmed\s+forces\b|\bveteran\b/i;

// "Do you have a preferred name, other than the name indicated above?"
const PREFERRED_NAME_QUESTION =
  /\bpreferred\s+(?:first\s+)?name\b|\bname\s+you\s+(?:go\s+by|prefer\s+to\s+be\s+called)\b/i;

// Akuna's "please confirm the month and year" diploma question and IMC's "When did you graduate
// from High School?". Distinct from every other graduation rule in this file, and checked before
// them, so the UNIVERSITY graduation date can never be replayed as a high-school one.
export const HIGH_SCHOOL_GRADUATION_QUESTION =
  /\bhigh\s+school\b[\s\S]{0,200}\b(?:graduat\w*|diploma|ged|month\s+and\s+year|when)\b|\b(?:graduat\w*|when|month|year)\b[\s\S]{0,120}\bhigh\s+school\b/i;

// "Have you previously applied to work at Point72?" / "...with Akuna in the past?" / "...another
// role @IMC within the last 12-18 months?". About APPLICATIONS, not employment, which is why it is
// separate from PRIOR_EMPLOYER_OR_PROGRAM_QUESTION above.
export const PREVIOUSLY_APPLIED_QUESTION =
  /\b(?:have|had)\s+you\s+(?:ever\s+|previously\s+)?applied\b|\bpreviously\s+applied\b|\bapplied\s+(?:to|for|with)\b[\s\S]{0,160}\b(?:previously|before|in\s+the\s+past|within\s+the\s+last)\b/i;

// Further education AFTER the current degree. Checked before every graduation-date rule so that
// "when is your potential master's graduation date?" cannot be handed the undergraduate date -
// which is exactly what a live Akuna packet carried, answered "May 2028".
const ADVANCED_DEGREE_WORD = String.raw`master(?:['’]s)?|masters|m\.?s\.?|mba|ph\.?\s?d|doctorate|graduate\s+(?:school|studies|degree)`;
export const POTENTIAL_ADVANCED_GRADUATION_DATE_QUESTION = new RegExp(
  String.raw`\b(?:${ADVANCED_DEGREE_WORD})\b[\s\S]{0,120}\bgraduation\s+date\b|\b(?:potential|expected|anticipated)\b[\s\S]{0,80}\b(?:${ADVANCED_DEGREE_WORD})\b[\s\S]{0,80}\bgraduat\w*`,
  'i',
);
export const FURTHER_EDUCATION_PLAN_QUESTION = new RegExp(
  String.raw`\b(?:considering|committed|plan(?:ning)?|intend\w*|pursuing)\b[\s\S]{0,160}\b(?:further\s+education|additional\s+degree|${ADVANCED_DEGREE_WORD})\b|\bfurther\s+education\b[\s\S]{0,160}\b(?:after|following|immediately)\b`,
  'i',
);
export const FURTHER_EDUCATION_DEGREE_TYPE_QUESTION =
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
export const BARE_PRIVACY_ACKNOWLEDGEMENT =
  /^\s*(?:candidate\s+|applicant\s+)?privacy(?:\s+(?:policy|statement|notice))?(?:\s+acknowledg\w*|\s+consent)?\s*$/i;
// A behavioural policy is not a privacy notice and not a statement of truth. IMC's "Interview Code
// of Conduct" was previously auto-answered "Yes" with nothing stored behind it.
export const CODE_OF_CONDUCT_ACKNOWLEDGEMENT =
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
  | 'education_start_date' | 'education_end_date'
  | 'languages' | 'onsite_commitment' | 'referral_source_default';

// The bare-keyword fallbacks at the bottom of classifyField exist for field-name labels a portal
// renders with no sentence around them: "School", "Current university", "State", "Phone". They are
// the only place where a single word anywhere in the label decides the answer, and that is exactly
// how "please provide your university email address" was answered with the university's name and
// how a politically-exposed-person question mentioning a "state-owned bank" was answered "Dubai".
// Three independent gates before a bare keyword is allowed to decide anything:
//   1. the label must be SHORT - field-name length, not sentence length;
//   2. it must not be a YES/NO question, which asks about the noun rather than for it; and
//   3. it must not be asking for a different kind of value about that noun.
// Anything richer than a field name has to be matched by an explicit pattern higher up, or go
// unanswered. A blank field stalls the run; a confident wrong answer gets submitted.
//
// Gate 2 replaces a blunter one, "the label must not contain a question mark at all", which was
// over-broad and cost six ordinary shapes, every one of which came back null and left a required
// field empty - the exact harm this whole effort is undoing:
//   "What is your phone number?"            "What university do you attend?"
//   "What state do you live in?"            "Which city do you live in?"
//   "In which state do you currently reside?"   "What is your current city of residence?"
// A question mark does not mean a label is not naming a field; it means the portal wrote the field
// name as a sentence. What actually distinguishes the one label the old gate was earning its keep
// on, "may we contact you by phone?", is that it is POLAR: it opens with an auxiliary and wants a
// yes or a no, so the phone number is not an answer to it. A wh-question opening with what, which
// or where wants the value itself. That is the distinction gate 2 draws, and it is the whole
// difference between refusing a consent checkbox and refusing every phone field on the internet.
//
// Verified by execution before narrowing it, on both defects the old gate was added for:
//   "please provide your university email address" is six words with no question mark at all, and
//   is refused by the qualifier on `email` and `address`;
//   the politically-exposed-person label is 17 words, refused by the word count, with `owned` in
//   the qualifier list as well, and refused a second time by POLITICALLY_EXPOSED_PERSON_QUESTION
//   in resolveKnownAnswer before classification is ever consulted.
// Phone is the one that matters most: it is required on most application forms, and on the managed
// path the `type === 'tel'` escape at the top of classifyField never fires, because the runner
// reports every inputType as `text`.
const FIELD_NAME_LABEL_MAX_WORDS = 6;
const POLAR_QUESTION_STEM =
  /^(?:do|does|did|are|is|was|were|am|be|been|have|has|had|can|could|may|might|will|would|shall|should|must)\b/i;
const KEYWORD_SUBJECT_QUALIFIER =
  /\be-?mails?\b|\baddress(?:es)?\b|\bdates?\b|\bmonths?\b|\byears?\b|\bwhen\b|\bwebsite\b|\burl\b|\blink\b|\bdepartment\b|\bfaculty\b|\badvisor\b|\bprofessor\b|\breferences?\b|\brank(?:ing)?\b|\bscores?\b|\bgpa\b|\bgrades?\b|\bscale\b|\blevel\b|\bowned\b|\bcontrolled\b|\brun\b/i;

/**
 * A yes/no question: opens with an auxiliary and is punctuated as a question.
 *
 * Both halves are required. The auxiliary alone would refuse a field named "Is" or a label opening
 * with a month ("May graduation"), and the question mark alone is the over-broad gate this
 * replaced. Exported so the explicit residence phrasings can be held to the same rule as the bare
 * keyword: "are you based in a state that taxes remote work?" must not be answered "California"
 * however plainly it names the noun.
 */
export function isPolarQuestion(label: string): boolean {
  const core = (label ?? '').replace(/[*:•]/g, ' ').replace(/\s+/g, ' ').trim();
  return core.includes('?') && POLAR_QUESTION_STEM.test(core);
}

export function labelNamesProfileField(label: string, noun: RegExp): boolean {
  if (!noun.test(label)) return false;
  const core = (label ?? '').replace(/[*:•]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!core) return false;
  if (core.split(' ').length > FIELD_NAME_LABEL_MAX_WORDS) return false;
  if (isPolarQuestion(core)) return false;
  return !KEYWORD_SUBJECT_QUALIFIER.test(core.replace(noun, ' '));
}

const SCHOOL_NOUN = /\b(school|university|college|institution)\b/i;
const PHONE_NOUN = /\b(phone|mobile)\b/i;
const STATE_NOUN = /\b(state|province|prefecture)\b(?!\s+(?:your|the|you|it|why|how|what|when|where))|state\s*\/\s*province/i;
const CITY_NOUN = /\b(city|town)\b|\blocation\b/i;
// Two of the six recovered shapes run to seven words - "In which state do you currently reside?"
// and "What is your current city of residence?" - so dropping the question-mark gate alone does not
// reach them; the word budget still refuses them, and raising that budget would loosen the bare
// keyword everywhere to buy back two labels. These say plainly which value they want, so they are
// matched explicitly instead, the same way the school and graduation phrasings above are. Nothing
// here fires without a personal-residence verb beside the noun, which is what keeps a state-owned
// bank out: "state-owned" has no "do you live" after it, and the pattern cannot cross a `?`.
const PERSONAL_RESIDENCE_VERB = String.raw`(?:do|are)\s+you\b[^?]{0,40}\b(?:live|living|reside|residing|located|based)`;
const EXPLICIT_STATE_QUESTION = new RegExp(
  String.raw`\b(?:state|province|prefecture)\b[^?]{0,40}\b${PERSONAL_RESIDENCE_VERB}\b`
  + String.raw`|\b(?:state|province|prefecture)\s+of\s+(?:residence|residency)\b`,
  'i',
);
const EXPLICIT_CITY_RESIDENCE_QUESTION = new RegExp(
  String.raw`\b(?:city|town)\b[^?]{0,40}\b${PERSONAL_RESIDENCE_VERB}\b`
  + String.raw`|\b(?:city|town)\s+of\s+(?:residence|residency)\b`,
  'i',
);
const EXPLICIT_CITY_QUESTION =
  /where are you (currently )?(located|living|based)|current location|where do you live/i;

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
  /* Same shape again, and newly load-bearing: the age attestation used to be unreachable here
   * because isRefusedQuestion above returned early on it. It is answered now, by
   * ageAttestationAnswer at the top of resolveKnownAnswer, so this function is the only way a
   * broad rule could still reach the label - and "are you 18+ years of age?" must never be
   * classified as a date of birth, an availability date or anything else. */
  if (AGE_ATTESTATION_QUESTION.test(l)) return null;
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
  // Explicit phrasings that unambiguously ask for the institution's NAME. Everything else has to
  // clear labelNamesProfileField further down: the bare keyword is not enough on its own.
  if (/\bwhich\s+(?:school|university|college|institution)\b|\b(?:school|university|college|institution)\s+(?:name|(?:you\s+|are\s+you\s+)?(?:currently\s+)?(?:attend(?:ing|ed)?|enrolled(?:\s+in)?))\b|\bname\s+of\s+(?:your\s+)?(?:school|university|college|institution)\b|^university\s*\/\s*institution\b/i.test(l)) return 'school';
  if (MAJOR_QUESTION.test(l)) return 'major';
  if (CURRENT_ENROLLMENT_QUESTION.test(l) && !GRADUATION_DATE_QUESTION.test(l)) return 'current_enrollment';
  if (EDUCATION_ATTENDANCE_DATE_QUESTION.test(l)) {
    // One control asking for BOTH ends of the range cannot be satisfied by the end alone.
    if (EDUCATION_ATTENDANCE_START_MARKER.test(l)) return 'education_start_date';
    return 'education_end_date';
  }
  if (START_DATE_QUESTION.test(l)) return 'availability_date';
  if (LOCATION_PREFERENCE_QUESTION.test(l)) return null;

  if (/\bgpa\b|grade average|grade point|academic performance/i.test(l)) return 'gpa';
  if (/gpa scale|out of.*(4\.0|100)|grading scale/i.test(l)) return 'gpa_scale';
  if (/\bhigh school\b/i.test(l) && /graduat|when|date|year/i.test(l)) return null;
  if (LANGUAGE_QUESTION.test(l)) return 'languages';
  if (/\bdegree\b(?!\s+(?:program|subject))|education level|level of education/i.test(l)) return 'degree';
  if (labelNamesProfileField(l, SCHOOL_NOUN)) return 'school';
  if (MAJOR_QUESTION.test(l)) return 'major';

  if (labelNamesProfileField(l, PHONE_NOUN)) return 'phone';
  // The explicit residence phrasings are held to the polar rule too. "Do you live in New York or
  // California?" names the noun as plainly as "In which state do you currently reside?" and wants
  // a yes or a no, not an address.
  const polar = isPolarQuestion(l);
  if (
    !locationCommitment &&
    !locationChoice &&
    ((!polar && EXPLICIT_STATE_QUESTION.test(l)) || labelNamesProfileField(l, STATE_NOUN))
  ) {
    return 'address_state';
  }
  if (
    !locationCommitment &&
    !locationChoice &&
    ((!polar && (EXPLICIT_CITY_QUESTION.test(l) || EXPLICIT_CITY_RESIDENCE_QUESTION.test(l)))
      || labelNamesProfileField(l, CITY_NOUN))
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

/**
 * An education start month/year comes from the education history and from nowhere else. When the
 * history has no start date the honest output is nothing: the applicant fills it in. It is never
 * availability_date, and never the graduation date.
 */
function educationStartAnswer(label: string, ap: ApplicationProfileLike): string | null {
  // A single control asking for the whole range ("start month/year of university and end
  // month/year of university") needs both ends; without a start there is no partial answer.
  const stored = ap.education_start_date?.trim();
  if (!stored) return null;
  if (EDUCATION_ATTENDANCE_END_MARKER.test(label)) {
    const end = educationEndAnswer(label, ap);
    return end ? `${stored} to ${end}` : null;
  }
  return narrowDatePart(label, stored);
}

function educationEndAnswer(label: string, ap: ApplicationProfileLike): string | null {
  const stored = ap.grad_date?.trim() || (ap.grad_year ? String(ap.grad_year) : '');
  return stored ? narrowDatePart(label, stored) : null;
}

/** "Start date month" wants "May", "Start date year" wants "2028"; anything else gets the whole date. */
function narrowDatePart(label: string, date: string): string | null {
  const iso = graduationDateAnswer(date, undefined, 'date');
  const monthOnly = EDUCATION_ATTENDANCE_MONTH_MARKER.test(label) && !EDUCATION_ATTENDANCE_YEAR_MARKER.test(label);
  const yearOnly = EDUCATION_ATTENDANCE_YEAR_MARKER.test(label) && !EDUCATION_ATTENDANCE_MONTH_MARKER.test(label);
  if (monthOnly) {
    const month = iso?.match(/^\d{4}-(\d{2})-/)?.[1];
    return month ? NUMBER_TO_MONTH[month] ?? null : null;
  }
  if (yearOnly) return iso?.match(/^(\d{4})-/)?.[1] ?? date.match(/\b(?:19|20)\d{2}\b/)?.[0] ?? null;
  return date;
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

function internshipJoinAnswer(label: string): { skipReason: string } | null {
  if (!INTERNSHIP_JOIN_QUESTION.test(label)) return null;
  // availability_date has no expiry or posting scope. Even an exact stored date may have described
  // a past recruiting cycle, so it is reference data rather than authority for a new commitment.
  return { skipReason: `internship availability question left for you: "${label.slice(0, 60)}"` };
}

function internshipAvailabilityAnswer(label: string): { skipReason: string } {
  // The legacy term is free text without a verified effective window, expiry, employer, season or
  // cadence scope. Matching words cannot prove the commitment is still current for this posting.
  return { skipReason: `internship availability question left for you: "${label.slice(0, 60)}"` };
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

/**
 * "1st choice: area of interest in software engineering" - refused, not computed.
 *
 * WHAT WAS HERE. Three keyword counts over the EMPLOYER'S OWN job description, and whichever
 * vocabulary the employer used most became her declared area of interest. That is not a reading of
 * a fact about her; it is a machine telling the employer what the employer wants to hear, and it
 * ranked "2nd choice" identically to "1st choice" because the JD is the same text both times.
 * Her area of interest is a self-assessment, in the same family as the skill self-ratings
 * selfDeclaration.ts refuses, and nothing on file records it.
 */
function softwareEngineeringAreaAnswer(label: string): { skipReason: string } | null {
  if (!SOFTWARE_ENGINEERING_AREA_QUESTION.test(label)) return null;
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

/* Where she LIVES, which is a stored fact, kept strictly apart from where she will WORK, which is
 * onsiteCommitmentAnswer's business. Every branch here now requires the address column it reasons
 * from: an empty column used to produce "Not in the US" and "No", which are answers, not silence.
 */
function locationStatusAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  if (US_STATE_RESIDENCE_SELECT_QUESTION.test(label)) {
    const country = ap.address_country?.trim();
    if (!country) return { skipReason: `state of residence left for you: "${label.slice(0, 60)}"` };
    if (!/\b(?:united states|usa|us|u\.s\.)\b/i.test(country)) return { value: 'Not in the US' };
    return null;
  }
  if (NY_CA_RESIDENCE_QUESTION.test(label)) {
    const state = `${ap.address_state ?? ''} ${ap.address_city ?? ''}`.trim();
    if (!state) return null;
    return /\b(?:ny|new\s+york|ca|california)\b/i.test(state) ? { value: 'Yes' } : { value: 'No' };
  }
  if (SAN_FRANCISCO_RESIDENCE_QUESTION.test(label)) {
    // Was an unconditional Yes/No off `ap.address_city ?? ''`, so a profile with no city on file
    // declared that she does not live in San Francisco. Absence of a fact is not the fact's negation.
    const city = ap.address_city?.trim();
    if (!city) return { skipReason: `city of residence left for you: "${label.slice(0, 60)}"` };
    return { value: /\bsan\s+francisco\b/i.test(city) ? 'Yes' : 'No' };
  }
  const cityMatch = label.match(CONFIRMED_PLANS_CITY_RE);
  const city = cityMatch?.[1] ?? cityMatch?.[2];
  if (!city) return null;
  if (ap.address_city && new RegExp(`\\b${city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(ap.address_city)) {
    return { value: 'Yes' };
  }
  // A mismatch proves only that the residence half is false. It says nothing about future plans,
  // so a mixed "reside OR confirmed plans" question must remain unanswered.
  return onsiteCommitmentAnswer(label);
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
  /**
   * A selector that still resolves on a LATER page load, when the discovery marker no longer does.
   *
   * `selector` above is `[data-litos-discovered-N]`, an attribute discovery writes into the page it
   * is looking at. The managed fill run is a SECOND, stateless browser call against a freshly loaded
   * form where that attribute has never existed, so durablePortalSelector refuses it - correctly -
   * and every managed-discovered question is actually filled by matching the employer's label text.
   * See profileFieldResolution.ts, point 2, which names that fallback as the thing that makes the
   * label problems fatal rather than cosmetic.
   *
   * This is the element's own identity instead - its id, its name attribute, or the ATS's per-field
   * handle (Ashby's `data-field-path`) - read at discovery time and still true at fill time. Where it
   * is present the fill is one action against one control rather than a fan-out of speculative
   * label-scoped selectors, so it SPENDS LESS of the action budget rather than more: measured on the
   * Deepgram packet, the managed prepare list falls from 76 actions to 20.
   *
   * Optional: a control with no id, no name and no ATS handle has no durable identity to report, and
   * the label fallback remains for it.
   */
  durableSelector?: string | null;
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
  /**
   * Whether the employer marks this field as required.
   *
   * R-095/R-096: nothing used to carry this. The fill pass decided required-ness from the live DOM
   * (`input[required], textarea[required], select[required]` in fillPortal) while discovery decided
   * only "can Litos answer this", so the two passes could never agree about the same field: the fill
   * said '"Discipline" is required and is still empty' and discovery had already thrown the field
   * away without writing a question for it. One missing signal, two defects.
   *
   * Optional because the managed provider runs its own port of the discovery script and does not
   * report this yet. That is covered rather than waited on: `discoveredFieldIsRequired` falls back
   * to the employer's own required marker in the RAW label, which both providers do report.
   */
  required?: boolean;
};

export const REVIEW_QUESTION_TEXT_MAX_LENGTH = 500;

/**
 * The employer's own required marker, read off the RAW discovered label.
 *
 * Read the RAW label, never the normalized one: normalizeDiscoveredLabel exists to produce the
 * employer's clean question text and strips the marker along with the handles, so by the time a
 * label is fit to store, the evidence is gone. Same reason managedGreenhouseEducationCombobox in
 * submissionRunner.ts reads the raw label for its `--0` handles.
 *
 * Greenhouse renders a required field as `<label>Discipline<span aria-hidden="true">*</span></label>`
 * and discovery concatenates the label text with the control's name and id, so the raw label really
 * reads "Discipline* discipline--0" for a required field and "Gender gender" for an optional one.
 * Both providers report that string, which is what makes this the one required-ness signal that
 * works on the managed path today.
 *
 * Deliberately narrow. The asterisk has to stand at a word boundary, so a marker ("Name*",
 * "internship? *", "*First Name") counts and an asterisk inside a token does not.
 */
export function labelMarksRequired(rawLabel: string): boolean {
  const label = rawLabel ?? '';
  if (!label) return false;
  // A legend rather than a marker: some boards print "* indicates a required field" into a label
  // block, and reading that as "this field is required" would mark the whole form required.
  if (/\*\s*(?:indicates|denotes|means|=)\b/i.test(label)) return false;
  return /\*(?:\s|$)/.test(label) || /(?:^|\s)\*/.test(label);
}

/**
 * One answer to "does the employer require this field", from whichever evidence the provider gave.
 *
 * The DOM flag is the stronger signal and the only one the direct-Playwright path needs; the label
 * marker is what keeps the managed path honest until stratus-browser-cloud reports the flag too.
 */
export function discoveredFieldIsRequired(field: Pick<DiscoveredQuestion, 'label' | 'required'>): boolean {
  return field.required === true || labelMarksRequired(field.label);
}

/**
 * The applicant's name and email, which every family's fixed-field pass fills from the packet
 * before discovery ever runs.
 *
 * These are required on essentially every form, so R-096 would otherwise turn all three into
 * "required answer missing" rows and block a submission on data Litos has already typed into the
 * page. isFixedPortalProfileField cannot be widened to cover them, because it DROPS a label from
 * the question list outright and its own comment warns that listing a field there which is not
 * really filled is the harmful direction. This is the narrower claim: not "never a question", only
 * "never manufactured as work for the applicant".
 *
 * "Legal first name" and "Preferred first name" are excluded deliberately. They are separate
 * questions an employer asks precisely because the answer may differ from the name on the resume,
 * and if one is required and unanswerable it is genuinely the applicant's to answer.
 */
export function isCoreIdentityField(label: string): boolean {
  const l = (label ?? '').toLowerCase();
  if (!l) return false;
  if (/\b(?:legal|preferred|maiden|previous|former|nick)\b/.test(l)) return false;
  if (/\b(?:first|last|given|family|sur|full)\s*name\b|^name\b|\bname\s*\*/.test(l)) return true;
  return /\be-?mail\b/.test(l);
}

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
  // Does the employer require this control? Three shapes, because one of them alone misses the
  // react-select comboboxes that carry Greenhouse's hardest questions.
  //
  //  1. the plain HTML flag, which is what fillPortal's blocker locator looks for;
  //  2. aria-required, which the same boards set on the visible combobox input;
  //  3. Greenhouse's hidden proxy: a react-select renders no required control of its own, so the
  //     board drops an <input required aria-hidden="true" tabindex="-1"> beside it purely to make
  //     native validation fire. That input is the ONLY DOM-level required evidence for a
  //     "Discipline" or an "EXPORT CONTROLS" select, and it is not the element we discovered.
  //
  // The ancestor walk STOPS at the field's own wrapper, and that bound is the whole difference
  // between this working and this being harmful. Measured against the live Anduril form: an
  // unbounded six-level walk reported the optional "Website", "LinkedIn Profile" and "Phone" as
  // required, because six levels up is a section holding several fields and it borrowed the
  // required proxy belonging to a neighbour. Marking an optional field required blocks a
  // submission that should have gone out, so the walk climbs only while the ancestor still
  // describes ONE control, which it stops doing the moment a second <label> comes into view.
  function isRequiredField(el) {
    if (el.required === true) return true;
    if ((el.getAttribute('aria-required') || '').toLowerCase() === 'true') return true;
    var node = el.parentElement;
    for (var depth = 0; node && depth < 6; depth += 1) {
      if (node.querySelectorAll('label').length > 1) return false;
      var proxy = node.querySelector('input[required][aria-hidden="true"][tabindex="-1"]');
      if (proxy && proxy !== el) return true;
      node = node.parentElement;
    }
    return false;
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
      required: isRequiredField(el),
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
  const exportControl = exportControlAnswer(label);
  if (exportControl) return exportControl;

  const politicallyExposed = politicallyExposedAnswer(label, ap);
  if (politicallyExposed) return politicallyExposed;

  const pronouns = pronounsAnswer(label, ap);
  if (pronouns) return pronouns;

  /* Up here with the self-declarations, and for the same reason they are: this label must not
   * reach a broad rule. It is the one member of this group that is answered from ARITHMETIC on a
   * stored fact rather than from a stored answer, and it refuses in exactly the same way when the
   * fact is missing. */
  const ageAttestation = ageAttestationAnswer(label, ap);
  if (ageAttestation) return ageAttestation;

  const furtherEducation = furtherEducationAnswer(label, ap);
  if (furtherEducation) return furtherEducation;

  const highSchool = highSchoolGraduationAnswer(label, ap);
  if (highSchool) return highSchool;

  const previouslyApplied = previouslyAppliedAnswer(label, ap);
  if (previouslyApplied) return previouslyApplied;

  const outstandingOffer = outstandingOfferAnswer(label, inputType, ap);
  if (outstandingOffer) return outstandingOffer;

  const applicationConsent = applicationConsentAnswer(label);
  if (applicationConsent) return applicationConsent;

  if (LEGAL_FIRST_NAME_QUESTION.test(label)) {
    // The stored legal name wins over the resume's. That is the entire reason the form asks the
    // question twice: for the person whose legal first name is not the name on their resume, the
    // parsed full name is the WRONG answer, and it is the one we would otherwise give.
    const firstName = ap.legal_first_name ?? ap.full_name?.trim().split(/\s+/)[0];
    return firstName ? { value: firstName } : null;
  }

  // Checked AFTER the legal-first-name arm, though neither pattern can reach the other's labels.
  // The order is the safety statement: if a future edit ever widens this one, the narrower and
  // more specific question still gets first refusal on its own labels.
  if (LEGAL_FULL_NAME_QUESTION.test(label)) {
    const legalName = composedLegalName(ap);
    return legalName ? { value: legalName } : null;
  }

  if (PREFERRED_NAME_QUESTION.test(label)) {
    // Answered only from an explicit declaration. Null falls through unchanged, because "I have no
    // preferred name" and "never asked" are not distinguishable from an empty column, and stating
    // the first when we only know the second is a claim we cannot back.
    if (ap.preferred_first_name) return { value: ap.preferred_first_name };
  }

  const preferredLocation = locationPreferenceAnswer(label);
  if (preferredLocation) return preferredLocation;

  const locationStatus = locationStatusAnswer(label, ap);
  if (locationStatus) return locationStatus;

  if (ADVANCED_DEGREE_ENROLLMENT_QUESTION.test(label)) {
    const advancedDegree = advancedDegreeEnrollmentAnswer(ap);
    if (advancedDegree) return advancedDegree;
  }

  if (EMPLOYER_RESTRICTION_AGREEMENT_QUESTION.test(label)) {
    /* CHANGED. This returned a hardcoded "No" - a legal declaration that she is under no
     * non-compete, non-solicitation or confidentiality obligation to any past employer, made by a
     * machine with no column consulted and nothing on file that could ever have supported it. It
     * is a statement to an employer about her contractual obligations to a different employer, and
     * it is already named in selfDeclaration.ts's list; the constant here simply ran first and
     * short-circuited it. One label, one company in the corpus, which is below the two-posting bar
     * for an onboarding question, so it becomes an ask at Apply instead. */
    return { skipReason: attestationSkipReason(label, 'declaration about agreements with a past employer') };
  }

  // The politically-exposed-person refusal that landed on integrate/submission-flow now sits at the
  // TOP of this function as politicallyExposedAnswer, which keeps the refusal and adds the half it
  // was missing: a stored declaration the applicant made herself. Unreachable here, and removed
  // rather than left as a second rule that could drift from the first.

  if (OPTIONS_MARKET_MAKING_EXPERIENCE_QUESTION.test(label)) {
    return { skipReason: `options market making experience question left for you: "${label.slice(0, 60)}"` };
  }

  if (HIGH_SCHOOL_DIPLOMA_CONFIRMATION_QUESTION.test(label)) {
    /* Supersedes the refusal that landed on integrate/submission-flow, and keeps its rule.
     * That branch's point was right: Akuna's version ends "please confirm the month and year", and
     * "Yes" is not a month and a year. It refused because "the profile does not hold" that date.
     * The profile holds it now, so highSchoolGraduationAnswer at the top of this function answers
     * every label that says "high school" from application_profile.high_school_grad_date, and
     * refuses with the same effect when nothing is stored.
     * This branch is what is left: the "equivalent degree" and "GED" phrasings that never say the
     * words "high school". A confirmation that a qualification was earned is still a claim about
     * the student's record, so it still needs the record. */
    if (HIGH_SCHOOL_GRADUATION_DATE_REQUEST.test(label) && !ap.high_school_grad_date) {
      return { skipReason: `high school graduation date left for you: "${label.slice(0, 60)}"` };
    }
    return ap.high_school_grad_date
      ? { value: HIGH_SCHOOL_GRADUATION_DATE_REQUEST.test(label) ? ap.high_school_grad_date : 'Yes' }
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
    /* CHANGED. This returned a hardcoded "Yes" to "AI Policy for Interviewers" / "do not use any
     * AI tools during the interview", with nothing stored. It is acceptance of a behavioural
     * policy that binds her conduct in a live interview, which is the same thing IMC's "Interview
     * Code of Conduct" is, and applicationConsentAnswer already refuses that one by name with the
     * reasoning quoted in its header: "A behavioural policy is not a privacy notice and not a
     * statement of truth." Two wordings of one policy cannot have two answers. */
    return { skipReason: attestationSkipReason(label, 'agreement to an interview conduct policy') };
  }

  const stemMajor = stemMajorAnswer(label, ap);
  if (stemMajor) return stemMajor;

  const internshipSeason = postingSeasonAnswer(label, jdText);
  if (internshipSeason) return internshipSeason;

  const internshipJoin = internshipJoinAnswer(label);
  if (internshipJoin) return internshipJoin;

  if (INTERNSHIP_AVAILABILITY_QUESTION.test(label)) {
    return internshipAvailabilityAnswer(label);
  }

  const softwareEngineeringArea = softwareEngineeringAreaAnswer(label);
  if (softwareEngineeringArea) return softwareEngineeringArea;

  const programmingLanguage = programmingLanguageAnswer(label, ap);
  if (programmingLanguage) return programmingLanguage;

  const routineConsent = routineConsentAnswer(label);
  if (routineConsent) return routineConsent;

  const routineLocationCommitment = routineLocationCommitmentAnswer(label);
  if (routineLocationCommitment) return routineLocationCommitment;

  const workEligibility = workEligibilityAnswer(label, ap);
  if (workEligibility) return workEligibility;

  /* The blanket `if (AGE_ATTESTATION_QUESTION.test(label)) return null;` that stood here is gone.
   * It is unreachable now: ageAttestationAnswer runs at the top of this function and returns a
   * value or a skipReason for every label this pattern matches, never null. Removed rather than
   * left as dead code, because a second age rule in a second place is how the two copies of these
   * regexes drifted the last time. */

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
  // Last gate before the profile answers it: the stored education facts are about the current
  // programme, so a question scoped to a later or different one gets nothing from them.
  if (key && CURRENT_PROGRAMME_KEYS.has(key) && FUTURE_OR_OTHER_PROGRAMME_QUESTION.test(label)) {
    return { skipReason: `question about a future or different programme left for you: "${label.slice(0, 60)}"` };
  }
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
      /* CHANGED. The fallback was `{ value: 'Company website' }` for an account that had stored
       * nothing, described in profileFieldResolution.test.ts as "a deliberate product behaviour
       * rather than stored data". It is deliberate and it is still a statement of fact about how
       * she found the posting, made to the employer in her name, and it is usually false: Litos
       * finds these jobs on a monitored board, not on the company's website. It is also the single
       * most-asked question in the whole corpus - 25 distinct labels across 20 employers - which by
       * the two-posting rule makes it an ONBOARDING question, not a constant. The column already
       * exists; only the invented default is gone. */
      return ap.referral_source_default
        ? { value: ap.referral_source_default }
        : { skipReason: `how you heard about this role is yours to answer: "${label.slice(0, 60)}"` };
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
      return { skipReason: `availability duration left for you: "${label.slice(0, 60)}"` };
    case 'availability_date':
      return { skipReason: `availability date left for you: "${label.slice(0, 60)}"` };
    case 'current_employer':
      return ap.current_employer ? { value: ap.current_employer } : null;
    case 'most_recent_employer':
      return ap.most_recent_employer ? { value: ap.most_recent_employer } : null;
    case 'onsite_commitment':
      return onsiteCommitmentAnswer(label);
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
    case 'education_start_date': {
      const value = educationStartAnswer(label, ap);
      return value
        ? { value }
        : { skipReason: `education start date left for you: "${label.slice(0, 60)}"` };
    }
    case 'education_end_date': {
      // The end of the current programme IS the graduation date, so this one is answerable.
      const value = educationEndAnswer(label, ap);
      return value
        ? { value }
        : { skipReason: `education end date left for you: "${label.slice(0, 60)}"` };
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
