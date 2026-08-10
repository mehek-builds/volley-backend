import type { Page } from 'playwright-core';
import { isOpaqueIdentifier, tidyLabel } from './fieldLabel';
import { jobCountry, type JobCountry } from './jobLocation';
import { officeMetrosNamed } from './officeMetros';
import type { SupportedPortal } from './portalSubmission';
import {
  resolveSalary,
  storedSalaryOf,
  type StoredSalaryProfile,
} from './salary';
import { referralSourceForApplication, type ReferralSourceEvidence } from './referralSource';
import { usStateScopeSkipReason } from './residenceScope';
import { declineWordingForControl } from './selfIdentification';
import {
  availabilityWindowForPosting,
  formatWindowDate,
  formatWindowRange,
  readCycle,
  type AvailabilityWindowFacts,
} from './availabilityWindow';

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

export type ApplicationProfileLike = StoredSalaryProfile & AvailabilityWindowFacts & {
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
  /* LEGACY, AND NOT AUTHORITY FOR ANYTHING. Kept in the read shape as reference data. The scoped
   * replacement is AvailabilityWindowFacts above (see lib/availabilityWindow.ts); these two carry no
   * cycle and no expiry, so no branch in this file may answer a commitment from them. */
  availability_date?: string;
  availability_term?: string;
  current_employer?: string;
  most_recent_employer?: string;
  employer_history?: string[];
  /**
   * The applicant's experience bank: every organisation and title she has told Litos about, in the
   * record she authored herself. Distinct from `employer_history`, which is scraped out of
   * `parsed_json.experience` and is a strict subset - measured on the owner account on 2026-08-09,
   * the parse held 4 organisations and the bank held 9.
   *
   * The entry type is provenance. A government-named project or leadership role is not employment.
   * The bank can prove a positive job match, but it has no completeness attestation and therefore
   * cannot prove a negative from absence.
   */
  experience_bank?: { type?: 'job' | 'project' | 'leadership'; org: string; title?: string }[];
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
  referral_source_evidence?: ReferralSourceEvidence;

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
/* THE COUNTRY ABBREVIATION, SPELLED THE WAY IT ACTUALLY ARRIVES.
 *
 * This pattern is case-SENSITIVE on purpose: "us" is also the commonest pronoun on a job form
 * ("how did you hear about us?", "tell us about a project", "why are you interested in us?"), and
 * reading one of those as a country would put a US work-authorization answer on a form that never
 * mentioned the United States. The capital letters were the whole distinction.
 *
 * MEASURED, on 2026-08-09, against every question label Litos has ever stored: 504 distinct
 * labels, 491 of them entirely lowercase, and this pattern matches ZERO of them. It cannot match
 * one. The extension lowercases every label it captures before it is sent
 * (student-outreach-extension/src/lib/adapters/generic.ts: `clean(parts.join(' ')).toLowerCase()`
 * on every label path), so the resolver is never handed a capital letter to distinguish on. The
 * guard exists, it is tested, and the tests pass only because they are written with the employer's
 * original casing - which is the one input the pipeline never produces.
 *
 * The consequence is not theoretical. "are you legally authorized to work in the united states?"
 * is answered from work_authorized twelve times over in the corpus; "are you legally authorized to
 * work in the us?" - the SAME question, Roblox's wording - is refused, and it was one of the two
 * stops on the 2026-08-09 Roblox run. Refusing one spelling of the United States while answering
 * the other is not a safety property, it is a dead regex.
 *
 * So the case-folded arm below is added rather than the flag being flipped, because the pronoun
 * problem is real and the two arms need different shapes to survive it:
 *   - the preposition arm REQUIRES the article. "in the us" cannot be a pronoun; "in us" can
 *     ("why are you interested in us?"), which is why the case-folded arm does not accept it.
 *   - the noun arm requires an immigration noun immediately after. "us work authorization" is the
 *     country; "tell us whether ..." is not, and the existing pronoun test covers it.
 * Measured over the same 504 labels the case-folded arm matches 6, none of them a pronoun, and of
 * those 6 only 4 are work-eligibility questions at all - the other two are a state-of-residence
 * select and a veteran-status question, neither of which ever consults a country scope.
 */
const US_ABBREVIATION_SCOPE =
  /\b(?:in|within|throughout|across)\s+(?:the\s+)?US\b|\bUS\s+(?:work|employment|visa|immigration|authori[sz]ation)\b/;
const US_ABBREVIATION_SCOPE_CASE_FOLDED =
  /\b(?:in|within|throughout|across)\s+the\s+us\b|\bus\s+(?:work|employment|visa|immigration|authori[sz]ation)\b/i;
/* The employer defers the country to the posting instead of naming it.
 *
 * Broadened on 2026-08-09, measured: the three fixed phrasings it held missed Deepgram's "the
 * country where THIS ROLE is located", DV Trading's "work authorization in THIS COUNTRY" and Scale
 * AI's "the country where the job is located" variants. That went unnoticed while an unscoped label
 * was refused anyway; once a stored "yes I need sponsorship" may answer an unscoped label, this is
 * the rule that has to hold the line, so it now recognises the family rather than three sentences.
 *
 * THIS FAMILY IS A POINTER, NOT A COUNTRY, and that is what makes it different from every other
 * scope pattern in this file. "The country where this role is located" does not say which country;
 * it says "look it up". Until 2026-08-09 that pointer was never followed and the whole family was
 * refused, which is why the Deepgram packet could not be sent: two required questions, both
 * answerable from two consented columns, both blank. It is followed now, and ONLY from the
 * posting's structured location as the portal published it (`postingCountryFromJobContext`), which
 * resolves to 'us' only when every place the posting names is American.
 *
 * That is not the inference be1bccf removed, and the distinction is the whole safety argument.
 * be1bccf deleted JD_US_SCOPE, a regex that swept the job description's PROSE for "california",
 * "new york", "remote (us)" - so a London role whose description mentioned a San Francisco
 * headquarters, a US customer or a US legal notice read as American and got a US work-eligibility
 * answer. That was reading a legal declaration out of marketing copy. Resolving a pointer the
 * employer's own question created, against the one field the employer filled in to say where the
 * job is, is a different act: the question asks which country, and the posting is the authority on
 * that and nothing else. Prose is still not consulted, here or anywhere below.
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

/* A COMPOUND QUESTION WHOSE OTHER HALF IS NOT ON FILE.
 *
 * "Are you currently located in the US, or do you have US work authorization?" is one form field
 * asking two different things joined by OR, and only the second one has a column behind it. That
 * asymmetry is the problem: "Yes" happens to be true whenever work_authorized is true, but "No"
 * would also deny that she lives in the country, which nothing stored records. A rule that is
 * sound in one direction and a false statement in the other is not a rule, so the question goes
 * back to her.
 *
 * Written against the ONE label in the corpus with this shape, not against "or" in general.
 * "Are you authorized to work in the US (e.g. you are a citizen, a permanent resident, or hold a
 * visa)?" is a parenthetical gloss on a single question, not two questions, and must keep
 * answering; requiring a residence clause immediately before the "or" is what separates them.
 */
const RESIDENCE_CLAUSE_JOINED_TO_ELIGIBILITY =
  /\b(?:currently\s+)?(?:located|residing|living)\s+in\b[^?]{0,60}\bor\b/i;

/* THE ONE STORED PAIR THAT DESCRIBES NOBODY.
 *
 * work_authorized and needs_sponsorship are two independent selects in Settings, so nothing stops
 * a half-finished profile holding a combination no person is in. Three of the four are real:
 * authorized with no sponsorship needed (citizen or permanent resident), authorized WITH
 * sponsorship needed later (a student on CPT/OPT, which is this account), and not authorized and
 * needing sponsorship. The fourth - not authorized AND needing no sponsorship - is not a person.
 *
 * It matters because the pair is answered by two DIFFERENT branches below, one column each, and
 * neither can see what the other is about to say. On that fourth combination the two branches put
 * "No, I am not allowed to work here" and "No, I need nothing from you" on the same page, and an
 * employer reading them together concludes something false whichever one they believe. The whole
 * family is held until the profile says something coherent.
 */
function storedEligibilityIsSelfContradictory(ap: ApplicationProfileLike): boolean {
  return ap.work_authorized === false && ap.needs_sponsorship === false;
}

function workEligibilityAnswer(
  label: string,
  ap: ApplicationProfileLike,
  postingCountry: JobCountry | undefined,
): { value: string } | { skipReason: string } | null {
  /* THE POINTER, FOLLOWED - ONCE, AND ONLY WHEN IT LANDS ON THE UNITED STATES.
   *
   * A JOB_LOCATION_SCOPE label ("the country where this role is located") names no country, so on
   * its own it is unanswerable from two US-scoped booleans. It becomes answerable exactly when the
   * posting's own structured location says every place this role exists is American, because then
   * the country the employer pointed at IS the United States and the stored facts are about that
   * country. Anything else - a foreign posting, a two-country posting, a bare "Remote", a packet
   * with no location on it at all, or a caller that did not pass one - leaves `postingCountry`
   * something other than 'us' and the whole family stays refused, exactly as before.
   *
   * The parameter is optional for a reason worth stating: every call site that has not been taught
   * to supply a posting therefore behaves like the old code, refusing. Forgetting to thread it
   * costs a handoff and can never cost a false answer. */
  const deferredCountryIsUs = JOB_LOCATION_SCOPE.test(label) && postingCountry === 'us';
  const explicitlyUsScoped = US_WORK_SCOPE.test(label)
    || US_ABBREVIATION_SCOPE.test(label)
    || US_ABBREVIATION_SCOPE_CASE_FOLDED.test(label)
    || deferredCountryIsUs;
  if (WORK_AUTHORIZATION_DETAIL_QUESTION.test(label)) {
    return { skipReason: workEligibilitySkipReason(label) };
  }
  const asksAuthorization = WORK_AUTHORIZATION_QUESTION.test(label);
  const asksSponsorship = SPONSORSHIP_QUESTION.test(label);
  if (
    (asksAuthorization || asksSponsorship)
    && (storedEligibilityIsSelfContradictory(ap) || RESIDENCE_CLAUSE_JOINED_TO_ELIGIBILITY.test(label))
  ) {
    return { skipReason: workEligibilitySkipReason(label) };
  }
  const namesAnotherCountry = NON_US_WORK_SCOPE.test(label)
    || (JOB_LOCATION_SCOPE.test(label) && !deferredCountryIsUs);
  /* THE COUNTRY GATE IS NOT SYMMETRIC, AND THE ASYMMETRY IS THE ENTIRE RULE.
   *
   * The positive US-scope requirement below exists because the legacy booleans were collected
   * without a country, so an unscoped question cannot be answered from them. That is true of the
   * answers that CLAIM something - "yes I am authorized", "no I need no sponsorship" - because a
   * claim of eligibility in a country nobody named is a false legal declaration waiting to happen,
   * and it is the defect R-004 was opened for.
   *
   * It is not true of "yes, I need sponsorship". That answer discloses a limitation rather than
   * asserting a permission: it can only ever narrow what an employer will offer, never obtain
   * something under false pretenses, and it is what needs_sponsorship literally records. Getting it
   * wrong in that direction costs a handoff; getting it wrong in the other direction is a false
   * statement about work eligibility on a real application, and only one of those is worth a gate.
   *
   * Measured on 2026-08-09 against the production corpus, replaying all 297 distinct stored labels
   * with the real profile: requiring the employer to spell the country out before Litos will repeat
   * a stored "yes" refused 13 sponsorship labels it is the answer to, including Cloudflare ("...to
   * work at Cloudflare?"), Reddit, Redwood Materials (whose list is nothing but US visa categories),
   * IMC, Five Rings, Point72, Anduril, DRW and Virtu. Not one of those employers named a country,
   * and every one of them was told nothing instead of being told the truth.
   *
   * The exceptions stay exceptions, and there are now four. A label that NAMES another country is
   * refused even in this direction: "yes I need sponsorship" is wrong AND costly for a role in the
   * one country where she may not. A label that DEFERS to the posting's own country is refused in
   * this direction too, unless the posting's structured location resolves that deferral to the
   * United States, in which case the label is US-scoped in fact and is treated as such by
   * `deferredCountryIsUs` above; a posting that is foreign, two-country, remote-with-no-country or
   * simply not supplied still refuses both directions. A label phrased backwards is refused,
   * because "yes" there is a claim again. And the two guards above this line,
   * from 97207e2, run first and are untouched by any of it: a compound label whose other half has no
   * column, and the stored pair that describes nobody, are held whichever direction the answer runs.
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
  const directSingleName = label.match(/\bapplied\s+to\s+([a-z0-9&.'’-]+)\s*(?:before|previously|in\s+the\s+past)?\s*[?.!]*$/i);
  const match = label.match(/(?:\bwith\b|\bat\b|\bto\s+work\s+(?:at|for)\b|@)\s*([a-z0-9][a-z0-9 .&'’-]{1,40})/i);
  const raw = (directSingleName?.[1] ?? match?.[1])
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

/* WHERE SHE WILL WORK FROM, RELAYED FROM THE COLUMN SHE ANSWERED IT INTO.
 *
 * This function returned a bare refusal for every office, onsite, commute and relocation question,
 * with a comment saying a future resolver could answer one from an exact record. The columns that
 * record arrived in on 2026-08-09 (application_profile.onsite_commitment, onsite_locations,
 * relocation_willingness), and the refusal stayed, so the four packets that named an office on the
 * 2026-08-08 run - Redwood Materials, Together AI, Anduril, Faire - were all held on a question the
 * profile could already answer. That is the R-076 shape: computed correctly, never reaches the
 * control, except here it was never computed at all.
 *
 * THE RULE, and the whole of it is that 'anywhere' is a MAXIMAL commitment.
 *
 * "I am willing to work in person anywhere in the US" entails every lesser promise inside the US:
 * any city, any cadence, any number of days, any stretch of weeks. So it answers Yes to a label
 * naming San Francisco, to one naming four days a week, and to one naming twelve weeks and no place
 * at all, without any of those dimensions having to be stored. Nothing is composed: one stored
 * declaration is being read out, and the reading is the same one a person would give it.
 *
 * The refusals that stay, each because the stored value genuinely does not cover the question:
 *
 *   NOTHING STORED. Unchanged. null and 'never asked' are the same thing and neither is a Yes.
 *
 *   A NON-US OFFICE. The declaration is scoped to the United States, and IMC, Optiver and Jane
 *     Street all ask about Amsterdam, London, Hong Kong and Sydney. "Anywhere in the US" says
 *     nothing about Amsterdam, so a label naming one is held.
 *
 *   'listed_locations' WITH NO PLACE IN THE LABEL. She named the offices she will sit in; a
 *     question that names none cannot be checked against that list, because the office it means is
 *     whichever one this posting is at, and the posting is not this function's input.
 *
 *   A REMOTE QUESTION. "Are you comfortable with this remote-only schedule?" is the inverse
 *     question and shares the vocabulary. Willingness to be in an office is not an answer to it.
 *
 * Relocation is answered from its own column, because agreeing to sit in an office is not agreeing
 * to move house. That column is a plain yes/no by design, so it settles "will you relocate?" and
 * "will you relocate to Austin?" identically.
 *
 * SEPARATE FROM ANSWER REUSE, and the two must not be confused. answerReuse.ts decides whether an
 * answer SHE TYPED on one employer's form may be replayed on another's, and it deliberately holds a
 * placeless onsite answer back so a promise about Costa Mesa is never replayed at Postman. That
 * restriction is untouched and still right: it governs carrying an answer between employers.
 * Resolving from a standing preference is not carrying anything between employers - it reads the
 * profile the applicant maintains - so it is allowed to answer a placeless question that a replay
 * may not.
 */
const REMOTE_WORK_QUESTION = /\bremote(?:ly|[\s-]?only|[\s-]?first)?\b|\bwork\s+from\s+home\b|\bwfh\b/i;
const ONSITE_PRESENCE_WORD = /\boffice\b|in[\s-]?office|on[\s-]?site|\bonsite\b|in[\s-]?person|\bhybrid\b|commut/i;

/** A question about working remotely, rather than about being in an office. */
function isRemoteWorkQuestion(label: string): boolean {
  return REMOTE_WORK_QUESTION.test(label) && !ONSITE_PRESENCE_WORD.test(label);
}

function uniqueLocationCaptures(label: string, patterns: readonly RegExp[]): string[] {
  const captures: string[] = [];
  for (const pattern of patterns) {
    for (const match of label.matchAll(pattern)) {
      const value = match[1]
        ?.trim()
        .replace(/^(?:our|the|an?)\s+/i, '')
        .replace(/\s+(?:for|five|four|three|two|one|\d+)\s+(?:days?|weeks?|months?|years?)\b.*$/i, '')
        .trim();
      if (!value || /^(?:our|the|an?|office|site|workplace|headquarters|hq|(?:one|any|either|all|some)\s+of(?:\s+(?:our|the))?)$/i.test(value)) continue;
      if (!captures.some((entry) => entry.toLowerCase() === value.toLowerCase())) captures.push(value);
    }
  }
  return captures;
}

const LOCATION_NOUN = /\b(?:offices?|sites?|workplaces?|headquarters|hq)\b/i;

type VettedWorkplaceCountry = 'US' | 'other';

function normalizeIdentity(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VETTED_WORKPLACE_LOCATIONS = new Map<string, VettedWorkplaceCountry>();

function registerWorkplace(country: VettedWorkplaceCountry, aliases: readonly string[]): void {
  for (const alias of aliases) VETTED_WORKPLACE_LOCATIONS.set(normalizeIdentity(alias), country);
}

registerWorkplace('US', ['United States', 'United States of America', 'US', 'U.S.', 'USA', 'U.S.A.']);
registerWorkplace('US', ['San Francisco', 'San Francisco, CA', 'SF', 'San Fran']);
registerWorkplace('US', ['New York', 'New York, NY', 'New York City', 'NYC', 'Manhattan']);
registerWorkplace('US', ['Chicago', 'Chicago, IL']);
registerWorkplace('US', ['Los Angeles', 'Los Angeles, CA', 'Culver City', 'Santa Monica']);
registerWorkplace('US', ['Austin', 'Austin, TX']);
registerWorkplace('US', ['Seattle', 'Seattle, WA', 'Bellevue', 'Bellevue, WA']);
registerWorkplace('US', ['Boston', 'Boston, MA', 'Cambridge, MA']);
registerWorkplace('US', ['Mountain View', 'Mountain View, CA']);
registerWorkplace('US', ['Palo Alto', 'Palo Alto, CA']);
registerWorkplace('US', ['San Mateo', 'San Mateo, CA']);
registerWorkplace('US', ['Greenwich', 'Greenwich, CT']);
registerWorkplace('US', ['Houston', 'Houston, TX']);
registerWorkplace('US', ['Denver', 'Denver, CO']);
registerWorkplace('US', ['Atlanta', 'Atlanta, GA']);
registerWorkplace('US', ['Costa Mesa', 'Costa Mesa, CA', 'Irvine', 'Irvine, CA']);
registerWorkplace('US', ['Washington DC', 'Washington, DC', 'Arlington, VA']);
registerWorkplace('other', ['Paris', 'Paris, France']);
registerWorkplace('other', ['London', 'London, UK', 'London, United Kingdom']);
registerWorkplace('other', ['Amsterdam', 'Amsterdam, Netherlands']);
registerWorkplace('other', ['Hong Kong']);
registerWorkplace('other', ['Sydney', 'Sydney, Australia']);
registerWorkplace('other', ['Toronto', 'Toronto, Canada']);
registerWorkplace('other', ['Dubai', 'Dubai, UAE', 'Dubai, United Arab Emirates']);
registerWorkplace('other', ['Singapore']);
registerWorkplace('other', ['Bengaluru', 'Bangalore', 'Bengaluru, India']);
registerWorkplace('other', ['Mumbai', 'Mumbai, India']);
registerWorkplace('other', ['Zug', 'Zurich', 'Zurich, Switzerland']);

type WorkplaceLocationParse = {
  sawExplicitSyntax: boolean;
  countries: VettedWorkplaceCountry[];
  invalid: boolean;
};

/**
 * Resolve workplace strings only through the closed registry above.
 *
 * The same rule applies to question prose and frozen posting fields. A country token, state code,
 * or city-shaped string is not enough on its own: unknown places hold the question. This keeps
 * customer, compliance, and market prose from becoming a workplace, and it keeps additions to a
 * broad country classifier from silently widening a legal commitment.
 */
function parseCapturedWorkplaceLocations(captures: readonly string[]): WorkplaceLocationParse {
  const countries: VettedWorkplaceCountry[] = [];
  let invalid = false;
  for (const capture of captures) {
    /* A posting may join several workplaces in one field. Splitting preserves the multiplicity so
     * the single-workplace gate below can hold it instead of treating the joined value as one. */
    const parts = capture.split(/\s*(?:;|\bor\b|\band\b|&|\/|\|)\s*/i).filter(Boolean);
    for (const part of parts) {
      const cleaned = part
        .replace(/^(?:either\s+)?(?:our|the|an?)\s+/i, '')
        .replace(/\s+(?:offices?|sites?|workplaces?|headquarters|hq)$/i, '')
        .trim();
      if (!cleaned || /^(?:(?:one|any|either|all|some)\s+of(?:\s+(?:our|the))?)$/i.test(cleaned)) continue;
      const country = VETTED_WORKPLACE_LOCATIONS.get(normalizeIdentity(cleaned));
      if (country) countries.push(country);
      else invalid = true;
    }
  }
  return { sawExplicitSyntax: captures.length > 0, countries, invalid };
}

/** A location must be attached to the work or office syntax in the question. A country word in
 * customer, travel, or compliance prose is not a work location. Office-specific syntax wins over
 * the broader fallback so "from our office in Chicago" is one place, not two captures. */
function explicitWorkLocations(label: string): WorkplaceLocationParse {
  const officeLocations = uniqueLocationCaptures(label, [
    /\b(?:offices?|sites?|workplaces?|headquarters|hq)\s+(?:is\s+|are\s+)?(?:located\s+|based\s+)?(?:in|at|near)\s+([^?;.]{1,80})/gi,
    /(?:[,:&/|]|\b(?:from|in|at|near|or|and|between)\b)\s*(?:(?:our|the|an?)\s+)?([^?;.]{1,80}?)\s+(?:offices?|sites?|workplaces?|headquarters|hq)\b/gi,
  ]);
  const fallbackCaptures = uniqueLocationCaptures(label, [
    /\b(?:onsite|on[\s-]?site|in[\s-]?person)\s+(?:in|at|from|near)\s+([^?;.]{1,80})/gi,
    /\b(?:work|working|based|located)\s+(?:onsite\s+|on[\s-]?site\s+)?(?:in|at|from|near)\s+([^?;.]{1,80})/gi,
  ]);
  const fallbackLocations = fallbackCaptures.filter((value) => !LOCATION_NOUN.test(value));
  return parseCapturedWorkplaceLocations([...officeLocations, ...fallbackLocations]);
}

function isSingleVettedUsLocation(parsed: WorkplaceLocationParse): boolean {
  return parsed.sawExplicitSyntax && !parsed.invalid
    && parsed.countries.length === 1 && parsed.countries[0] === 'US';
}

function frozenWorkplaceLocationParse(locations: readonly string[]): WorkplaceLocationParse {
  return parseCapturedWorkplaceLocations(locations);
}

/* A location question that wants a NUMBER, A DATE OR A LIST rather than a yes or a no.
 *
 * isLocationCommitmentQuestion only asks whether the label has a "can you ... office" shape, and
 * "How many days per week can you work on-site in SF, and from what date?" has exactly that shape
 * while wanting two values. Answering it "Yes" would put a non-answer in a required field, which is
 * the same defect as leaving it empty and harder to spot. isPolarQuestion cannot be used for this:
 * it requires the label to OPEN with the auxiliary, and Faire's real label opens "This role will be
 * in-office on a hybrid schedule, can you commit ...", so it would refuse the one this fix exists
 * for. The honest test is what the question asks for, not where its verb sits.
 *
 * AN INTERROGATIVE ONLY COUNTS WHERE A QUESTION STARTS. A bare `\bwhere\b` was tried first and it
 * refused Faire's real label, which ends "... at the location WHERE this position is posted?" - a
 * relative clause naming the office, not a request for one. So the wh-words are read at the start of
 * the label or of a sentence inside it, and the quantity and date phrases are read anywhere, because
 * "and from what date?" is a second question tacked on after a comma.
 */
const LOCATION_QUESTION_WANTS_A_VALUE =
  /^\s*(?:what|which|when|where|how)\b|[.?!]\s+(?:what|which|when|where|how)\b|\bhow\s+(?:many|much|often|long|frequently)\b|\b(?:from|by|on|starting)\s+what\s+(?:date|day|month|time)\b|\bplease\s+(?:provide|specify|describe|explain|list|rank|indicate|state|share|tell|enter)\b/i;

function onsiteCommitmentAnswer(
  label: string,
  ap: ApplicationProfileLike,
  jdText?: string,
): { value: string } | { skipReason: string } {
  const held = { skipReason: onsiteCommitmentSkipReason(label) };

  if (LOCATION_QUESTION_WANTS_A_VALUE.test(label)) return held;

  if (RELOCATION_COMMITMENT_QUESTION.test(label)) {
    const willing = ap.relocation_willingness;
    if (willing === 'yes') return { value: 'Yes' };
    if (willing === 'no') return { value: 'No' };
    return held;
  }

  if (isRemoteWorkQuestion(label)) return held;

  const commitment = ap.onsite_commitment;
  if (!commitment) return held;
  if (commitment === 'no') return { value: 'No' };

  const named = officeMetrosNamed(label);
  if (commitment === 'anywhere') {
    /* `anywhere` records the US-scoped standing declaration. It is not permission to treat an
     * unknown place as American. The old rule returned Yes whenever the finite metro table found
     * no foreign city, so Paris and every city absent from that table became US-safe by omission.
     *
     * Evidence can come from the question itself, or from the structured job locations frozen
     * into the resolution context by applicationContextForQuestionResolution. Arbitrary prose in
     * the JD does not count: a description can mention customers, offices, or travel worldwide. */
    const labelLocations = explicitWorkLocations(label);
    if (labelLocations.sawExplicitSyntax) {
      return isSingleVettedUsLocation(labelLocations) ? { value: 'Yes' } : held;
    }
    const frozenLocations = frozenJobLocationsFromContext(jdText);
    if (isSingleVettedUsLocation(frozenWorkplaceLocationParse(frozenLocations))) {
      return { value: 'Yes' };
    }
    return held;
  }

  // 'listed_locations': only a label that names a place can be checked against the list.
  if (named.length === 0) return held;
  const listed = ap.onsite_locations ?? [];
  if (listed.length === 0) return held;
  const covered = named.every((entry) => listed.some((location) => entry.pattern.test(location)));
  return { value: covered ? 'Yes' : 'No' };
}

function routineLocationCommitmentAnswer(
  label: string,
  ap: ApplicationProfileLike,
  jdText?: string,
): { value: string } | { skipReason: string } | null {
  return isLocationCommitmentQuestion(label) ? onsiteCommitmentAnswer(label, ap, jdText) : null;
}

const FROZEN_JOB_LOCATION_PREFIX = '[LITOS FROZEN JOB LOCATION] ';

/** Encode structured job locations for question resolution without making arbitrary JD prose
 * location evidence. Kept here so the producer and consumer share the exact marker. */
export function frozenJobLocationContext(locations: readonly string[]): string {
  return locations
    .map((location) => location.trim())
    .filter(Boolean)
    .map((location) => `${FROZEN_JOB_LOCATION_PREFIX}${location}`)
    .join('\n');
}

function frozenJobLocationsFromContext(context: string | undefined): string[] {
  if (!context) return [];
  return context
    .split(/\r?\n/)
    .filter((line) => line.startsWith(FROZEN_JOB_LOCATION_PREFIX))
    .map((line) => line.slice(FROZEN_JOB_LOCATION_PREFIX.length).trim())
    .filter(Boolean);
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
/**
 * Her surname, taken from the stored full name.
 *
 * SPLITTING A STORED NAME IS NOT AN INFERENCE. composedLegalName already relies on exactly this
 * reading, and has since it shipped: it keeps "everything after the first token" of the parsed full
 * name as the surname and puts the stored legal first name in front of it. This returns that same
 * remainder on its own, so "Legal First Name" and "Legal Last Name" on one form cannot disagree
 * about which part of "Mehek Mandal" is which.
 *
 * Undefined on a single-token name. A person with one recorded name has no surname to hand over,
 * and repeating the given name into a surname field would be a statement about her that nothing on
 * file supports.
 */
function legalSurname(ap: ApplicationProfileLike): string | undefined {
  const fullName = ap.full_name?.trim().replace(/\s+/g, ' ');
  if (!fullName) return undefined;
  const parts = fullName.split(' ');
  return parts.length > 1 ? parts.slice(1).join(' ') : undefined;
}

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

/* THE DATE OF BIRTH IS PARSED BY HAND, and that is deliberate rather than fussy.
 *
 * `new Date(raw)` was here, and it is lenient in exactly the two directions that end in a false
 * legal declaration:
 *   - it ROLLS OVER an impossible calendar day. `new Date('2008-02-30T00:00:00Z')` is 1 March 2008,
 *     not an error, so a corrupt day silently becomes a real date and then an age.
 *   - it INVENTS a date out of prose. `new Date('sometime in 2005')` is 1 January 2005, which
 *     becomes an age, which becomes a Yes on an attestation the applicant never made.
 *
 * So only the two shapes Litos actually STORES are matched, and everything else is refused:
 *   - strict ISO `YYYY-MM-DD`, which is what the extension's setup screen writes and what the one
 *     stored date of birth in production is (measured 2026-08-09: 10 plaintext bytes).
 *   - the day / month-name / year text /profile/harvest can lift off an employer's form
 *     ("25 Sep 2005"), and its month-first mirror ("Sep 25, 2005").
 *
 * ALL-NUMERIC AMBIGUOUS FORMS ARE REFUSED ON PURPOSE. "09/08/2005" is 8 September to half the
 * world and 9 August to the other half, and there is nothing in the string that says which. A
 * refusal costs one question; a guess puts a false date of birth on an application.
 *
 * Kept in step with the extension's copy, storedBirthDate in
 * student-outreach-extension/src/lib/adapters/generic.ts. Two readers of one rule that disagree is
 * the defect this pair keeps re-learning.
 */
const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function monthNumberFromName(name: string): number | undefined {
  const n = name.toLowerCase();
  const index = MONTH_NAMES.findIndex((month) => month === n || (n.length >= 3 && month.startsWith(n)));
  return index === -1 ? undefined : index + 1;
}

/** The date that was WRITTEN, or undefined when the calendar has no such day (30 February). */
function validCalendarDate(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } | undefined {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    ? { year, month, day }
    : undefined;
}

function storedBirthDate(value: string | undefined): { year: number; month: number; day: number } | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return validCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  // "25 Sep 2005", "25 September, 2005"
  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)?[\s.,-]+([a-z]{3,9})\.?[\s.,-]+(\d{4})$/i.exec(raw);
  if (dayFirst) {
    const month = monthNumberFromName(dayFirst[2]);
    return month === undefined ? undefined : validCalendarDate(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }
  // "Sep 25, 2005", "September 25 2005"
  const monthFirst = /^([a-z]{3,9})\.?[\s.,-]+(\d{1,2})(?:st|nd|rd|th)?[\s.,-]+(\d{4})$/i.exec(raw);
  if (monthFirst) {
    const month = monthNumberFromName(monthFirst[1]);
    return month === undefined ? undefined : validCalendarDate(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }
  return undefined;
}

/**
 * Completed years between a stored date of birth and `now`, or undefined when the stored text is
 * not a date this can read.
 *
 * Only ever called with application_profile.date_of_birth. Nothing else in the profile is an
 * acceptable input: a graduation year, a resume, or a document in the vault would all give a
 * number, and every one of them would be a guess presented to an employer as an attestation.
 * An unparseable string is treated exactly like an absent one, and the caller turns both into the
 * same stated refusal.
 */
function ageInCompletedYears(dateOfBirth: string | undefined, now: Date): number | undefined {
  const dob = storedBirthDate(dateOfBirth);
  if (!dob || Number.isNaN(now.getTime())) return undefined;
  let age = now.getUTCFullYear() - dob.year;
  const monthDelta = now.getUTCMonth() + 1 - dob.month;
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < dob.day)) age -= 1;
  // A birth date in the future, or before anyone alive, is corrupt rather than informative.
  return age < 0 || age > 130 ? undefined : age;
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
  postingCountry?: JobCountry,
): boolean {
  if (!isRefusedQuestion(label)) return false;
  if (NEVER_FILL_PATTERNS.some((re) => re.test(label))) return true;
  const known = resolveKnownAnswer(label, inputType, ap, jdText, postingCountry);
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
  postingCountry?: JobCountry,
): T[] {
  return questions.map((question) => {
    const label = normalizeReviewQuestionLabel(question.question);
    const known = label ? resolveKnownAnswer(label, 'text', ap, jdText, postingCountry) : null;
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
const LOCATION_COMMITMENT_VOCAB = /\boffices?\b|in[\s-]?office|on[\s-]?site|\bonsite\b|in[\s-]?person|\bhybrid\b|\bremote(?:ly|[\s-]?only)?\b|work\s+from\s+home|relocat|commut/i;
/* Moving house, which is a different promise from sitting in an office and has its own column.
 * Kept in step with answerReuse.ts's RELOCATION_QUESTION, which decides the same split for replay. */
const RELOCATION_COMMITMENT_QUESTION = /\brelocat\w*\b|\bwilling\s+to\s+move\b|\bplan\s+to\s+move\b/i;
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
/* ---- the three availability questions the scoped window is allowed to answer ----
 *
 * Each was counted across the owner's 112 stored packets. They are separated from
 * INTERNSHIP_AVAILABILITY_QUESTION below, which stays refused, because these ask for DATES and that
 * one asks for a CADENCE. A window of "1 June to 20 August" is a true answer to "what dates are you
 * available"; it is not an answer to "can you commit to 40 hours a week", because nothing in the
 * window records hours. Two questions, two different facts, and only one of them is on file.
 */
// "what dates are you available for an internship" - the truveta label blocking packet fbc1d407.
const AVAILABILITY_WINDOW_QUESTION =
  /\bwhat\s+dates?\b[^?]{0,100}\bavailab\w*\b|\bavailab\w*\b[^?]{0,100}\bwhat\s+dates?\b|\bdates?\s+(?:of|for)\s+(?:your\s+)?availabilit\w*\b|\bavailabilit\w*\s+dates?\b|\bdate\s+range\b[^?]{0,80}\bavailab\w*\b/i;
// "when do you plan on ending your internship", asked by 6 postings. Before this it matched nothing
// at all and fell through to the essay drafter, which is the worst of the three outcomes.
const INTERNSHIP_END_QUESTION =
  /\b(?:when|what\s+date)\b[^?]{0,100}\b(?:end|ending|finish|finishing|conclude|concluding|last\s+day)\b[^?]{0,100}\bintern(?:ship)?\b|\bintern(?:ship)?\b[^?]{0,80}\b(?:end\s+date|last\s+day)\b|\bend\s+date\s+of\s+(?:the\s+|your\s+)?intern(?:ship)?\b/i;
/* THE DISQUALIFIER. Any label that also asks about hours, days per week or a full/part-time
 * schedule is asking for something the window does not hold, so it is handed straight back to the
 * cadence refusal. This is what keeps Anduril's "willing to work in-person for 12 weeks" and
 * Faire's "commit to being in-office three days per week" out of the branch below. */
const AVAILABILITY_CADENCE_VOCAB =
  /\bfull[\s-]?time\b|\bpart[\s-]?time\b|\bhours?\s+(?:per|a)\s+week\b|\b\d+\s*hours?\b|\bdays?\s+(?:per|a)\s+week\b|\bcommit\w*\b|\bin[\s-]?person\b|\bon[\s-]?site\b|\bin[\s-]?office\b/i;
/* "please confirm when you will complete your university studies" - 7 postings.
 *
 * NOT an availability question and deliberately NOT answered from the window. The end of her degree
 * is her graduation date, which is already on file and is already what education_end_date answers
 * from. Routing it anywhere near the availability model would put a job date into an education
 * field, which is the exact defect education_start_date was added to stop. */
const STUDIES_COMPLETION_QUESTION =
  /\b(?:complete|completing|completion|finish|finishing|conclude)\b[^?]{0,60}\b(?:university|college|undergraduate|academic|degree)\b[^?]{0,40}\b(?:stud(?:y|ies)|programme|program|course|education|degree)\b|\b(?:university|college|undergraduate|academic)\s+stud(?:y|ies)\b[^?]{0,60}\b(?:complete|completion|finish|end)\b/i;
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
/* The other half of DRW's pair, and the comment above named it three weeks before it was written.
 *
 * "none of the six legal-first-name or legal-last-name labels satisfies it" was recorded as proof
 * that LEGAL_FULL_NAME_QUESTION stayed narrow. It was also true of every other pattern in this
 * file: `classifyField('legal last name')` was null and resolveKnownAnswer returned null, so DRW's
 * `"Legal Last Name"` got no answer and no action at all while "Legal First Name" beside it filled.
 *
 * Requires the word "legal". A bare "Last Name" is the fixed identity control every portal adapter
 * already types into, and claiming it here would put a custom question in front of a field that is
 * not one. */
const LEGAL_LAST_NAME_QUESTION =
  /\blegal\s+(?:last|family|sur)\s*name\b|\b(?:last|family|sur)\s*name\b[^?]{0,120}\blegal\b/i;
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

/* ---------------------------------------------------------------------------------------------
 * "Prior US Government Employment?" - Skydio, on Ashby, and the one blocker between that packet
 * and the first end-to-end submission.
 *
 * MEASURED before the pattern was written, with scripts/_corpus-labels.mts over the 507 distinct
 * labels Litos has stored (2026-08-09). Four of them name a government and exactly one asks
 * whether the APPLICANT was employed by one:
 *
 *   [1x] prior us government employment?                                        <- this family
 *   [4x] astranis complies with u.s. government space technology export regulations, therefore
 *        will you state which of the following applies to you                   <- export control
 *   [1x] are you or have you been entrusted with a position or function in any government,
 *        international organization ...                                         <- PEP
 *   [3x] do you have any close friends or relatives who are public officers? ... their government
 *        agency                                                                 <- someone else
 *
 * The other three already have rules of their own, and each is excluded below by the words that
 * make it somebody else's question rather than by its position in this file, so a reordering
 * cannot silently hand them to this arm.
 *
 * THE CLEARANCE FAMILY IS NOT THIS FAMILY and is deliberately untouched. The corpus holds two
 * clearance labels - "if you have held a u.s. security clearance in the past, what clearance level
 * have you held?" and Astranis's "u.s. person status and/or u.s. clearance eligibility ... are you
 * eligible to meet this requirement?". Neither says "government", the first is not an employment
 * fact and the second is a self-declaration about eligibility, so neither is answerable from a
 * list of employers. Both stay refused, and "clearance", "eligib" and "authori[sz]" are excluded
 * below so that a future widening of the scope pattern cannot reach them either.
 */
const GOVERNMENT_EMPLOYER_SCOPE =
  /\bgovernment(?:al)?\b|\bpublic[-\s]sector\b|\bcivil\s+service\b|\bcongressional\s+staffer\b|\b(?:state|federal)\s+(?:or\s+\w+\s+)?agenc(?:y|ies)\b/i;

/** The label must state the relationship between the applicant and a government employer. */
const GOVERNMENT_EMPLOYMENT_RELATIONSHIP =
  /\b(?:prior|previous|past|current)\b[^?]{0,40}\bgovernment(?:al)?\s+employment\b|\bemploy(?:ed|ment)\b[^?]{0,60}\b(?:by|with)\b|\bwork(?:ed|ing|s)?\b[^?]{0,60}\bfor\b|\bwork(?:ed|ing|s)?\b[^?]{0,40}\bin\b[^?]{0,30}\b(?:public[-\s]sector|civil\s+service)\b|\b(?:are|were)\s+you\b[^?]{0,80}\bemployee\b|\bhave\s+you\b[^?]{0,40}\bbeen\b[^?]{0,40}\bemployee\b/i;

/* These words make the government reference the subject matter of work, not the employer. A
 * vetted government job elsewhere in the bank cannot answer any of them. */
const GOVERNMENT_WORK_SUBJECT =
  /\bprojects?\b|\bcontracts?\b|\bcontractors?\b|\bfunctions?\b|\bdisciplines?\b|\bgovernment\s+relations\b|\bapplication\s+(?:support|systems?)\b|\breferral\s+(?:programs?|systems?)\b|\brelocation\s+software\b/i;

/* Labels that name a government and are still not "were you employed by one". Everything here is
 * either a real corpus label (relatives, PEP, export control) or a shape whose answer is a legal
 * status rather than a history (authorization, eligibility, sponsorship, clearance, citizenship).
 * A status question answered from an employer list would be a false legal declaration, which is
 * the exact failure R-004 shipped once already. */
const NOT_HER_GOVERNMENT_EMPLOYMENT =
  /\b(?:friends?|relatives?|family|spouse|parents?)\b|\bentrusted\s+with\b|\bpolitically\s+exposed\b|\bexport[-\s]control\w*\b|\bexport\s+regulations?\b|\bclearance\b|\bcomplies\s+with\b|\bauthori[sz]\w*\b|\beligib\w*\b|\bsponsor\w*\b|\bcitizen\w*\b/i;

/** Whether this label asks whether the applicant has been employed by a government. */
export function isGovernmentEmploymentQuestion(label: string): boolean {
  const value = label ?? '';
  if (!GOVERNMENT_EMPLOYMENT_RELATIONSHIP.test(value)) return false;
  if (GOVERNMENT_WORK_SUBJECT.test(value)) return false;
  if (NOT_HER_GOVERNMENT_EMPLOYMENT.test(value)) return false;
  const target = governmentEmploymentTarget(value);
  if (!target) return false;
  if (GOVERNMENT_EMPLOYER_SCOPE.test(value)) return true;
  return target.kind === 'named' && VETTED_GOVERNMENT_EMPLOYERS.has(target.identity);
}

type GovernmentLevel = 'federal' | 'state' | 'local';
type VettedGovernmentEmployer = { canonical: string; level: GovernmentLevel };

/* Closed registry of identities whose employer status and level have been vetted. Aliases share a
 * canonical identity so a named question must match the same employer, not merely another entry at
 * the same level. A plausible-looking organisation stays held until it is registered here. */
const VETTED_GOVERNMENT_EMPLOYERS = new Map<string, VettedGovernmentEmployer>();

function registerGovernmentEmployer(
  canonical: string,
  level: GovernmentLevel,
  aliases: readonly string[],
): void {
  const employer = { canonical: normalizeIdentity(canonical), level };
  for (const alias of [canonical, ...aliases]) {
    VETTED_GOVERNMENT_EMPLOYERS.set(normalizeIdentity(alias), employer);
  }
}

registerGovernmentEmployer('Department of Energy', 'federal', [
  'DOE',
  'US DOE',
  'U.S. DOE',
  'United States DOE',
  'US Department of Energy',
  'U.S. Department of Energy',
  'United States Department of Energy',
]);
registerGovernmentEmployer('Department of Justice', 'federal', [
  'DOJ',
  'US DOJ',
  'U.S. DOJ',
  'United States DOJ',
  'US Department of Justice',
  'U.S. Department of Justice',
  'United States Department of Justice',
]);
registerGovernmentEmployer('Government Accountability Office', 'federal', []);
registerGovernmentEmployer('City of Los Angeles', 'local', []);
registerGovernmentEmployer('Office of Congressman Ted Lieu', 'federal', []);
registerGovernmentEmployer('United States Senate', 'federal', ['US Senate', 'U.S. Senate']);
registerGovernmentEmployer('Federal Aviation Administration', 'federal', ['FAA']);
registerGovernmentEmployer('National Aeronautics and Space Administration', 'federal', ['NASA']);

type GovernmentEmploymentTarget =
  | { kind: 'any' }
  | { kind: 'level'; level: GovernmentLevel }
  | { kind: 'named'; identity: string };

/* The complete grammar of government scopes that an employer record may answer. This is a parser
 * table, not a keyword ranking: the whole normalized scope must match one row. Consequently broad
 * "government" is answerable only when it is unqualified, while an exclusion, a jurisdiction we
 * do not model, or any other extra word makes the parse fail closed. */
const GOVERNMENT_SCOPE_PARSERS: readonly {
  pattern: RegExp;
  target: GovernmentEmploymentTarget;
}[] = [
  {
    pattern: /^(?:(?:u s|us|united states)(?: federal)?|federal) government$/,
    target: { kind: 'level', level: 'federal' },
  },
  {
    pattern: /^(?:(?:u s|us|united states) )?federal (?:agency|agencies)$/,
    target: { kind: 'level', level: 'federal' },
  },
  {
    pattern: /^(?:(?:u s|us|united states) )?federal governmental (?:agency|agencies)$/,
    target: { kind: 'level', level: 'federal' },
  },
  {
    pattern: /^(?:(?:u s|us|united states)(?: federal)?|federal) government (?:agency|agencies)$/,
    target: { kind: 'level', level: 'federal' },
  },
  {
    pattern: /^(?:u s|us|united states)(?: federal)? governmental (?:agency|agencies)$/,
    target: { kind: 'level', level: 'federal' },
  },
  {
    pattern: /^state (?:government(?: (?:agency|agencies))?|governmental (?:agency|agencies)|agency|agencies)$/,
    target: { kind: 'level', level: 'state' },
  },
  {
    pattern: /^(?:local|municipal|city|county) (?:government(?: (?:agency|agencies))?|governmental (?:agency|agencies))$/,
    target: { kind: 'level', level: 'local' },
  },
  {
    pattern: /^(?:government(?:al)?|government(?:al)? (?:agency|agencies)|public sector|civil service)$/,
    target: { kind: 'any' },
  },
];

function parsedGovernmentScope(identity: string): GovernmentEmploymentTarget | null {
  for (const parser of GOVERNMENT_SCOPE_PARSERS) {
    if (parser.pattern.test(identity)) return parser.target;
  }
  const named = VETTED_GOVERNMENT_EMPLOYERS.get(identity);
  return named ? { kind: 'named', identity } : null;
}

function targetFromBareGovernmentPhrase(raw: string): GovernmentEmploymentTarget | null {
  const phrase = raw.trim().replace(/[.,;:]+$/g, '').replace(/^(?:a|an|any|the)\s+/i, '');
  const identity = normalizeIdentity(phrase);
  if (/^[a-z0-9]{2,4}$/.test(identity) && phrase !== identity.toUpperCase()) return null;
  return parsedGovernmentScope(identity);
}

function governmentTargetsAreCompatible(
  primary: GovernmentEmploymentTarget,
  example: GovernmentEmploymentTarget,
): boolean {
  if (primary.kind === 'any') return true;
  if (primary.kind === 'level') {
    if (example.kind === 'level') return example.level === primary.level;
    if (example.kind === 'named') {
      return VETTED_GOVERNMENT_EMPLOYERS.get(example.identity)?.level === primary.level;
    }
    return false;
  }
  if (example.kind !== 'named') return false;
  const primaryEmployer = VETTED_GOVERNMENT_EMPLOYERS.get(primary.identity);
  const exampleEmployer = VETTED_GOVERNMENT_EMPLOYERS.get(example.identity);
  return Boolean(primaryEmployer && exampleEmployer && primaryEmployer.canonical === exampleEmployer.canonical);
}

function regexpEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function maskedGovernmentEmployerExamples(illustration: string): {
  value: string;
  targets: Map<string, GovernmentEmploymentTarget>;
} {
  let value = illustration;
  const targets = new Map<string, GovernmentEmploymentTarget>();
  const aliases = [...VETTED_GOVERNMENT_EMPLOYERS.entries()]
    .sort(([left], [right]) => right.length - left.length);
  for (const [alias] of aliases) {
    const tokens = alias.split(' ').map(regexpEscape);
    const aliasPattern = new RegExp(`\\b${tokens.join('[\\s.\\-/]+')}\\b`, 'gi');
    if (!aliasPattern.test(value)) continue;
    aliasPattern.lastIndex = 0;
    const placeholder = `GOVERNMENTEMPLOYERALIAS${targets.size}`;
    value = value.replace(aliasPattern, placeholder);
    targets.set(placeholder.toLowerCase(), { kind: 'named', identity: alias });
  }
  return { value, targets };
}

function parseGovernmentExampleTargets(illustration: string): GovernmentEmploymentTarget[] | null {
  const wholeTarget = targetFromBareGovernmentPhrase(illustration);
  if (wholeTarget) return [wholeTarget];
  const masked = maskedGovernmentEmployerExamples(illustration);
  const pieces = masked.value.split(/\s*(?:,|;|\/|\band\b|\bor\b)\s*/i).filter(Boolean);
  if (!pieces.length) return null;
  const targets: GovernmentEmploymentTarget[] = [];
  for (const piece of pieces) {
    const shorthand = normalizeIdentity(piece.replace(/^(?:a|an|any|the)\s+/i, ''));
    const maskedTarget = masked.targets.get(shorthand);
    if (maskedTarget) targets.push(maskedTarget);
    else if (/^federal$/.test(shorthand)) targets.push({ kind: 'level', level: 'federal' });
    else if (/^state$/.test(shorthand)) targets.push({ kind: 'level', level: 'state' });
    else if (/^(?:local|municipal|city|county)$/.test(shorthand)) targets.push({ kind: 'level', level: 'local' });
    else {
      const target = targetFromBareGovernmentPhrase(piece);
      if (!target) return null;
      targets.push(target);
    }
  }
  return targets;
}

function targetFromGovernmentPhrase(raw: string): GovernmentEmploymentTarget | null {
  let phrase = raw.trim().replace(/[.,;:]+$/g, '');
  const parenthetical = phrase.match(/^(.+?)\s*\(([^()]*)\)\s*$/);
  if (parenthetical) {
    const primary = parenthetical[1].trim();
    const detail = parenthetical[2].trim();
    const primaryTarget = targetFromBareGovernmentPhrase(primary);
    if (!primaryTarget) return null;
    if (/^(?:e\.?\s*g\.?|for\s+example|including|such\s+as)(?:[\s,:-]|$)/i.test(detail)) {
      const illustration = detail.replace(/^(?:e\.?\s*g\.?|for\s+example|including|such\s+as)[\s,:-]*/i, '');
      const examples = parseGovernmentExampleTargets(illustration);
      if (!examples?.length || examples.some((example) => !governmentTargetsAreCompatible(primaryTarget, example))) return null;
      return primaryTarget;
    } else {
      const detailedTarget = targetFromBareGovernmentPhrase(detail);
      if (!detailedTarget || !governmentTargetsAreCompatible(primaryTarget, detailedTarget)) return null;
      return primaryTarget;
    }
  }
  return targetFromBareGovernmentPhrase(phrase);
}

function governmentRelationPhrase(label: string): string | null {
  const relation = label.match(/\bwork(?:ed|ing|s)?\b[^?]{0,60}\bfor\s+(?:the\s+)?([^?\n]{1,160})/i)
    ?? label.match(/\bemploy(?:ed|ment)\b[^?]{0,60}\b(?:by|with)\s+(?:the\s+)?([^?\n]{1,160})/i);
  return relation?.[1]?.trim() ?? null;
}

/* Each row owns the entire normalized label. No search-style parser is used here: instructions or
 * qualifications on either side of a valid-looking question make every row miss and therefore
 * hold the answer. Present-tense/current-status forms are deliberately absent because the resume
 * bank records employers, not whether the employment is current. */
const GOVERNMENT_EMPLOYMENT_LABEL_PARSERS: readonly {
  pattern: RegExp;
  scopeGroup: number;
}[] = [
  { pattern: /^(?:prior|previous|past)\s+(.+?)\s+employment$/i, scopeGroup: 1 },
  {
    pattern: /^have\s+you\s+(?:(?:ever|previously)\s+)?worked\s+for\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^did\s+you\s+(?:(?:ever|previously)\s+)?work\s+for\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^have\s+you\s+(?:(?:ever|previously)\s+)?been\s+employed\s+(?:by|with)\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^were\s+you\s+(?:(?:ever|previously)\s+)?employed\s+(?:by|with)\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^were\s+you\s+(?:(?:ever|previously)\s+)?(?:an?\s+)?(.+?)\s+employee$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^have\s+you\s+(?:(?:ever|previously)\s+)?been\s+(?:an?\s+)?(.+?)\s+employee$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^were\s+you\s+(?:(?:ever|previously)\s+)?(?:an?\s+)?employee\s+(?:of|for|with)\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^have\s+you\s+(?:(?:ever|previously)\s+)?been\s+(?:an?\s+)?employee\s+(?:of|for|with)\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^have\s+you\s+(?:(?:ever|previously)\s+)?worked\s+in\s+(the\s+)?(public[-\s]sector|civil\s+service)$/i,
    scopeGroup: 2,
  },
];

const CURRENT_GOVERNMENT_EMPLOYMENT_LABEL_PARSERS: readonly {
  pattern: RegExp;
  scopeGroup: number;
}[] = [
  { pattern: /^current\s+(.+?)\s+employment$/i, scopeGroup: 1 },
  {
    pattern: /^are\s+you\s+currently\s+employed\s+(?:by|with)\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^do\s+you\s+currently\s+work\s+for\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^are\s+you\s+currently\s+(?:an?\s+)?(.+?)\s+employee$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^are\s+you\s+currently\s+(?:an?\s+)?employee\s+(?:of|for|with)\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^are\s+you\s+(?:an?\s+)?current\s+(.+?)\s+employee$/i,
    scopeGroup: 1,
  },
  {
    pattern: /^are\s+you\s+(?:an?\s+)?current\s+employee\s+(?:of|for|with)\s+(?:the\s+)?(.+)$/i,
    scopeGroup: 1,
  },
];

function normalizedGovernmentEmploymentLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').replace(/[?.!]+$/g, '').trim();
}

function labelNamesKnownGovernmentEmployer(label: string): boolean {
  const identity = ` ${normalizeIdentity(label)} `;
  for (const alias of [...VETTED_GOVERNMENT_EMPLOYERS.keys()].sort((left, right) => right.length - left.length)) {
    if (/^[a-z0-9]{2,4}$/.test(alias)) {
      if (new RegExp(`\\b${regexpEscape(alias.toUpperCase())}\\b`).test(label)) return true;
      continue;
    }
    if (identity.includes(` ${alias} `)) return true;
  }
  return false;
}

function labelHasApplicantEmploymentStatusRelationship(label: string): boolean {
  if (GOVERNMENT_EMPLOYMENT_RELATIONSHIP.test(label)) return true;
  const identity = normalizeIdentity(label);
  return /\bemploy\s+you\b|\byour\s+(?:(?:former|past|current|ex)\s+)?employer\b|\b(?:former|formerly|past|ex)\b[^?]{0,80}\b(?:employee|employer|employment|employed|work|worked|job)\b|\b(?:employee|employer|employment|employed|work|worked|job)\b[^?]{0,80}\b(?:former|formerly|past|ex)\b|\bno\s+longer\b[^?]{0,80}\b(?:employee|employer|employed|work|working)\b|\b(?:employee|employer|employed|work|working)\b[^?]{0,80}\bno\s+longer\b|\bjob\s+(?:at|with|for)\b|\b(?:service|work)\s+history\b|\brelationship\s+to\b/.test(identity);
}

/** Complete question shapes owned by resolvers that run after government-employment handling.
 * Keywords alone are not enough: an employment-history question may describe application support,
 * a referral system, or relocation software without asking about applying, hearing, or moving. */
function isCompletePriorApplicationQuestion(label: string): boolean {
  const value = normalizedGovernmentEmploymentLabel(label);
  return /^(?:have|had)\s+you\s+(?:(?:ever|previously)\s+)?applied\s+(?:to|for|with)\s+.+$/i.test(value)
    || /^have\s+you\s+applied\s+.+\s+(?:previously|before|in\s+the\s+past)$/i.test(value);
}

function isCompleteReferralQuestion(label: string): boolean {
  const value = normalizedGovernmentEmploymentLabel(label);
  return /^(?:how\s+did\s+you\s+(?:first\s+)?hear\s+about|where\s+(?:did|have)\s+you\s+learn(?:ed)?\s+about|what\s+(?:is|was)\s+(?:your\s+)?referral\s+source\b)/i.test(value);
}

function isCompleteRelocationQuestion(label: string): boolean {
  const value = normalizedGovernmentEmploymentLabel(label);
  return /^(?:are|would|will|can|could)\s+you\s+(?:(?:willing|able|prepared|open)\s+to\s+)?relocat\w*\b/i.test(value)
    || /^do\s+you\s+(?:plan|intend|expect)\s+to\s+(?:relocate|move)\b/i.test(value);
}

function belongsToNonEmploymentQuestionFamily(label: string): boolean {
  return isCompletePriorApplicationQuestion(label)
    || isCompleteReferralQuestion(label)
    || isCompleteRelocationQuestion(label);
}

function labelHasUnprovenNoncurrentGovernmentStatus(label: string): boolean {
  const identity = normalizeIdentity(label);
  if (!/\b(?:former|formerly|past|ex)\b|\bno longer\b/.test(identity)) return false;
  return labelNamesKnownGovernmentEmployer(label) && labelHasApplicantEmploymentStatusRelationship(label);
}

function currentGovernmentEmploymentTarget(label: string): GovernmentEmploymentTarget | null {
  const value = normalizedGovernmentEmploymentLabel(label);
  for (const parser of CURRENT_GOVERNMENT_EMPLOYMENT_LABEL_PARSERS) {
    const match = value.match(parser.pattern);
    if (match) return targetFromGovernmentPhrase(match[parser.scopeGroup]);
  }
  return null;
}

/** What employer or government level the question itself names. */
function governmentEmploymentTarget(label: string): GovernmentEmploymentTarget | null {
  const current = currentGovernmentEmploymentTarget(label);
  if (current) return current;
  const value = normalizedGovernmentEmploymentLabel(label);
  for (const parser of GOVERNMENT_EMPLOYMENT_LABEL_PARSERS) {
    const match = value.match(parser.pattern);
    if (match) return targetFromGovernmentPhrase(match[parser.scopeGroup]);
  }
  return null;
}

function governmentLabelNamesKnownEmployer(label: string): boolean {
  const phrase = governmentRelationPhrase(label);
  if (!phrase) return false;
  const primary = phrase.replace(/\s*\([^()]*\)\s*$/, '').trim();
  return targetFromBareGovernmentPhrase(primary)?.kind === 'named';
}

function governmentEmployerMatchesTarget(
  employer: VettedGovernmentEmployer,
  target: GovernmentEmploymentTarget,
): boolean {
  if (target.kind === 'any') return true;
  if (target.kind === 'level') return employer.level === target.level;
  const named = VETTED_GOVERNMENT_EMPLOYERS.get(target.identity);
  return Boolean(named && named.canonical === employer.canonical);
}

/**
 * Whether a stored military-service answer says she served.
 *
 * Anything that is not a recognisable negative counts as affirmative, because this is used only to
 * HOLD an answer, never to produce one, and the safe direction of a misread is silence.
 */
function militaryServiceIsAffirmative(stored: string | undefined): boolean {
  const value = stored?.trim().toLowerCase();
  if (!value) return false;
  if (/^(?:no\b|none\b|n\/a\b)/.test(value)) return false;
  if (/\bnot\s+a\s+(?:protected\s+)?veteran\b|\b(?:have\s+not|never)\s+served\b|\bno,\s|\bdecline\b|\bdo\s+not\s+wish\b/.test(value)) return false;
  return true;
}

export function governmentEmploymentSkipReason(label: string, because: string): string {
  return `prior government employment left for you, because ${because}: "${label.slice(0, 60)}"`;
}

/**
 * "Prior US Government Employment?" answered by READING the experience bank.
 *
 * A typed job entry naming a government employer proves Yes. Project and leadership entries prove
 * nothing about employment, and absence proves nothing because the bank is resume-derived rather
 * than an attested complete employment history. Every other case is held for review.
 */
function governmentEmploymentAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  if (belongsToNonEmploymentQuestionFamily(label)) return null;
  if (labelHasUnprovenNoncurrentGovernmentStatus(label)) {
    return {
      skipReason: governmentEmploymentSkipReason(
        label,
        'the profile has no chronology proving that employment ended',
      ),
    };
  }
  if (!isGovernmentEmploymentQuestion(label)) {
    if ((GOVERNMENT_EMPLOYER_SCOPE.test(label)
      || governmentLabelNamesKnownEmployer(label)
      || (labelNamesKnownGovernmentEmployer(label) && labelHasApplicantEmploymentStatusRelationship(label)))
      && !NOT_HER_GOVERNMENT_EMPLOYMENT.test(label)) {
      return {
        skipReason: governmentEmploymentSkipReason(
          label,
          'the question does not explicitly ask whether you were employed by or worked for a government employer',
        ),
      };
    }
    return null;
  }

  const currentTarget = currentGovernmentEmploymentTarget(label);
  if (currentTarget) {
    const currentEmployer = ap.current_employer
      ? VETTED_GOVERNMENT_EMPLOYERS.get(normalizeIdentity(ap.current_employer))
      : undefined;
    if (currentEmployer && governmentEmployerMatchesTarget(currentEmployer, currentTarget)) return { value: 'Yes' };
    return {
      skipReason: governmentEmploymentSkipReason(
        label,
        'your exact current government employer is not on file or does not match this question',
      ),
    };
  }

  const recorded = ap.experience_bank?.filter((entry) => entry?.org?.trim());
  /* An empty bank is "she never told us", not "she never worked anywhere". Nothing is derivable
   * from a record that does not exist, so this refuses rather than reporting the negative - which
   * is also what keeps the empty-profile sweep at the number it was. */
  if (!recorded?.length) {
    return { skipReason: governmentEmploymentSkipReason(label, 'your experience is not on file') };
  }
  const bank = recorded.filter((entry) => entry.type === 'job');
  if (!bank.length) {
    return { skipReason: governmentEmploymentSkipReason(label, 'your record has no typed employment entries') };
  }

  /* A stored military record outranks the bank in one direction only. The armed forces are
   * government service and a resume rarely lists them beside internships, so an affirmative here
   * makes "No" false; but the column does not record WHOSE armed forces, so it cannot make "Yes"
   * true either. Hold it and say so. */
  if (militaryServiceIsAffirmative(ap.military_service)) {
    return { skipReason: governmentEmploymentSkipReason(label, 'your military service is on file and this question does not fit it') };
  }

  const target = governmentEmploymentTarget(label);
  if (!target) {
    return { skipReason: governmentEmploymentSkipReason(label, 'the employer named by the question is unclear') };
  }
  const employers = bank
    .map((entry) => VETTED_GOVERNMENT_EMPLOYERS.get(normalizeIdentity(entry.org)))
    .filter((entry): entry is VettedGovernmentEmployer => Boolean(entry));
  if (employers.some((employer) => governmentEmployerMatchesTarget(employer, target))) return { value: 'Yes' };
  return { skipReason: governmentEmploymentSkipReason(label, 'your employment record does not prove a complete history') };
}

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
  /* "please confirm when you will complete your university studies", 7 postings. It matched nothing
   * in this function and nothing in resolveKnownAnswer, so it fell all the way to the essay drafter.
   * The end of her degree is the graduation date, which education_end_date already answers from -
   * this is not an availability question and must never be answered from the availability window. */
  if (STUDIES_COMPLETION_QUESTION.test(l)) return 'education_end_date';
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
/** An explicit invitation to write prose, which turns a yes/no stem into a real essay prompt. */
const ELABORATION_REQUEST =
  /\b(?:explain|describe|elaborat\w+|tell\s+(?:us|me)|why\b|in\s+your\s+own\s+words|provide\s+(?:detail|context)|share\s+(?:more|any))/i;

export function isOpenEndedQuestion(label: string): boolean {
  const l = (label ?? '').trim().toLowerCase();
  if (!l) return false;
  if (isLocationChoiceQuestion(l)) return false;
  if (
    /\b(why\b|describ\w+|explain\w*|tell (?:us|me)\b|share\b|elaborat\w+|discuss\b|sentences?\b|paragraphs?\b|in your own words|what interest\w*|what excit\w*|what motivat\w*|what makes\b|how (?:did|do|would|have) you|brief note\b|note on\b|you (?:most )?enjoy\b)/.test(l)
  )
    return true;
  /* A YES/NO QUESTION IS NOT AN ESSAY PROMPT, however long it runs.
   *
   * This guard sits in front of the length catch-all below and nowhere else, so every label the
   * cue list above already recognised as prose keeps its answer, including "can you commit to a 12
   * week internship? please explain any constraints".
   *
   * Virtu, both 2026-08-09 packets: "Will you be ready for full-time employment in 2028?" is 49
   * characters and carries a question mark, so it reached the drafter, which answered a yes/no
   * question with 186 and 374 characters of prose about her graduation year. Both were typed at a
   * closed control and came back "no option matched". A wrong-shaped answer landing on a real
   * employer's form is worse than a blank one: a blank is visibly unfinished, and this is not. */
  if (isPolarQuestion(l) && !ELABORATION_REQUEST.test(l)) return false;
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

/* The two shapes in which a stored graduation date STATES a month. Module constants so the reader
 * that needs the month on its own (statedGraduationMonth) and the one that needs a whole ISO day
 * (graduationDateAnswer) cannot drift apart. Only ever used through matchAll, which clones the
 * regex, so the /g flag carries no lastIndex from one call to the next. */
const GRADUATION_ISO_MONTH_RE = /\b((?:19|20)\d{2})-(\d{2})(?:-\d{2})?\b/g;
const GRADUATION_MONTH_YEAR_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[^0-9]{0,20}\b((?:19|20)\d{2})\b/gi;

export function graduationDateAnswer(
  gradDate: string | undefined,
  gradYear: number | undefined,
  inputType: string | undefined,
): string | null {
  const text = gradDate?.trim() || (gradYear ? String(gradYear) : '');
  if (!text) return null;
  if (inputType !== 'date') return text;
  const preferredYear = gradYear && gradYear > 0 ? String(gradYear) : undefined;
  const isoMatches = [...text.matchAll(GRADUATION_ISO_MONTH_RE)];
  const iso = isoMatches.find((match) => match[1] === preferredYear) ?? isoMatches.at(-1);
  if (iso) return `${iso[1]}-${iso[2]}-01`;
  const monthYearMatches = [...text.matchAll(GRADUATION_MONTH_YEAR_RE)];
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
 * The month the stored graduation date actually STATES, with the year it states it against, or null.
 *
 * Deliberately NOT read off graduationDateAnswer. That function ends with
 * `const month = monthToken ? MONTH_TO_NUMBER[monthToken] : '05'`, so a stored "2028" comes back as
 * 2028-05-01: a May that nobody put on file. That default is fine where it lives - a native date
 * input has to be handed a complete day or it takes nothing - but it must never become part of an
 * ANSWER, because an answer is a claim. When only a year is stored, the year is the whole truth and
 * this returns null.
 */
function statedGraduationMonth(
  gradDate: string | undefined,
  gradYear: number | undefined,
): { month: string; year: string } | null {
  const text = gradDate?.trim();
  if (!text) return null;
  const preferredYear = gradYear && gradYear > 0 ? String(gradYear) : undefined;
  const isoMatches = [...text.matchAll(GRADUATION_ISO_MONTH_RE)];
  const iso = isoMatches.find((match) => match[1] === preferredYear) ?? isoMatches.at(-1);
  if (iso) return NUMBER_TO_MONTH[iso[2]] ? { month: iso[2], year: iso[1] } : null;
  const monthYearMatches = [...text.matchAll(GRADUATION_MONTH_YEAR_RE)];
  const monthYear = monthYearMatches.find((match) => match[2] === preferredYear) ?? monthYearMatches.at(-1);
  if (!monthYear) return null;
  const month = MONTH_TO_NUMBER[monthYear[1].toLowerCase()];
  return month ? { month, year: monthYear[2] } : null;
}

/**
 * What goes into a control that asks for a graduation YEAR.
 *
 * WHY THIS IS NOT JUST THE YEAR (measured on prod packet 59fb48ae, Deepgram on Ashby, 2026-08-09).
 * "Expected Graduation Year" there is a react-datepicker at DAY precision. Handed a bare "2028" the
 * runner deliberately fills nothing, because tabbing off a typed year commits 01/01/2028 - four
 * months before a May graduation, and a date an employer reads as fact. Handed "May 2028" the same
 * control commits 05/01/2028 and the required-and-empty blocker clears. The answer string is the
 * only channel the backend has to that control: the managed provider reports inputType "text" for
 * every discovered control (see the header of profileFieldResolution.ts), so there is no shape here
 * to branch on and no honest way to send one string to a datepicker and another to a text box.
 *
 * The extra precision is truthful everywhere else it lands. "May 2028" answers "what year do you
 * graduate" correctly, with a month the profile really holds; it is never a guess, because
 * statedGraduationMonth refuses to invent one. And a closed list is unaffected: profileFieldCandidates
 * keeps the bare year on the graduation_year ladder, and chooseClosestOption's exact-match pass runs
 * over every candidate before any inexact stage, so a select offering "2028" still selects "2028".
 *
 * The one narrowing is a control that cannot physically hold a month name. It fires only where the
 * input type is REAL - the direct Playwright fill reads it off the element - and never on the
 * managed path, where every type is reported as "text" and this rule would be a lie either way.
 */
export function graduationYearFieldAnswer(
  gradDate: string | undefined,
  gradYear: number | undefined,
  inputType: string | undefined,
): string | null {
  const year = graduationYearAnswer(gradDate, gradYear);
  if (!year) return null;
  if (/^(?:number|tel)$/i.test(inputType ?? '')) return year;
  const stated = statedGraduationMonth(gradDate, gradYear);
  // A stored date that names a DIFFERENT year than grad_year is two facts disagreeing, and the
  // month belongs to the one this answer is not reporting. The year alone is what both agree on.
  if (!stated || stated.year !== year) return year;
  const month = NUMBER_TO_MONTH[stated.month];
  return month ? `${month} ${year}` : year;
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
  // readCycle is the one place this codebase decides what cycle a posting is for, so the season it
  // reports here and the season the availability window is checked against cannot drift apart.
  const cycle = readCycle(jdText);
  return cycle ? { value: cycle } : null;
}

/**
 * The scoped window, or nothing.
 *
 * Every caller below funnels through this so there is ONE place that decides whether a stored
 * declaration may speak for this posting. It returns null when nothing is stored, when the record is
 * incomplete, when it has lapsed, when the posting does not name its cycle, and when the cycle it
 * names is not the one she declared for. See lib/availabilityWindow.ts for why each of those is a
 * refusal rather than a best guess.
 */
function scopedAvailabilityWindow(ap: ApplicationProfileLike, jdText: string | undefined) {
  return availabilityWindowForPosting(ap, jdText, new Date());
}

function internshipJoinAnswer(
  label: string,
  inputType: string,
  ap: ApplicationProfileLike,
  jdText: string | undefined,
): { value: string } | { skipReason: string } | null {
  if (!INTERNSHIP_JOIN_QUESTION.test(label)) return null;
  /* "When are you able to join us as an intern?" is answered by the START of a window that is
   * provably about this posting's cycle, and by nothing else. availability_date still cannot answer
   * it: it has no expiry and no posting scope, so an exact stored date may describe a recruiting
   * cycle that ended, and replaying it would commit her to a season she never applied for. */
  const scoped = scopedAvailabilityWindow(ap, jdText);
  if (scoped) return { value: formatWindowDate(scoped.start, inputType) };
  return { skipReason: `internship availability question left for you: "${label.slice(0, 60)}"` };
}

/**
 * The dates an internship could run, from the scoped window and from nothing else.
 *
 * Returns null - NOT a refusal - for a label that also asks about hours or a schedule, so the
 * cadence branch downstream keeps ownership of those. A refusal here would be the same answer, but
 * it would take the question away from the rule whose reasoning actually fits it.
 */
function availabilityWindowAnswer(
  label: string,
  inputType: string,
  ap: ApplicationProfileLike,
  jdText: string | undefined,
): { value: string } | { skipReason: string } | null {
  const asksRange = AVAILABILITY_WINDOW_QUESTION.test(label);
  const asksEnd = INTERNSHIP_END_QUESTION.test(label);
  if (!asksRange && !asksEnd) return null;
  if (AVAILABILITY_CADENCE_VOCAB.test(label)) return null;
  const scoped = scopedAvailabilityWindow(ap, jdText);
  if (!scoped) {
    return { skipReason: `internship availability dates left for you: "${label.slice(0, 60)}"` };
  }
  // A question that asks only when it ENDS gets the end. A question that asks for the dates gets
  // both, because both are what it asked for.
  const value = asksRange
    ? formatWindowRange(scoped, inputType)
    : formatWindowDate(scoped.end, inputType);
  return { value };
}

function internshipAvailabilityAnswer(label: string): { skipReason: string } {
  // UNCHANGED, and staying that way. This branch owns the CADENCE questions - "available full-time
  // for Summer 2027", "commit to 40 hours per week for 12 weeks". A window records two dates and no
  // hours, so it cannot answer any of them, and the legacy free-text term never could either.
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

/**
 * Every employer the applicant has positively declared, from both records that hold one.
 *
 * `employer_history` alone was the sibling of the bug this branch is about. It is scraped out of
 * `parsed_json.experience`, and on the owner's production profile on 2026-08-09 it held 4 of her 9
 * organisations - Traeco, Spark SC and Venture Capital Academy were in the experience bank and not
 * in the parse. "Have you ever worked for Traeco?" therefore answered "No" from a record that was
 * missing the entry that made it Yes, which is the same failure as a hardcoded negative wearing a
 * lookup as a disguise. Typed job rows are unioned in for positive matches. Projects and
 * leadership are excluded, and a non-match is held because neither record is proven exhaustive.
 */
function declaredEmployers(ap: ApplicationProfileLike): string[] {
  const declared = [
    ...(ap.employer_history ?? []),
    ...(ap.experience_bank ?? []).filter((entry) => entry.type === 'job').map((entry) => entry.org),
  ];
  return declared.map(normalizeEmployerName).filter(Boolean);
}

function priorEmployerAnswer(label: string, ap: ApplicationProfileLike): { value: string } | null {
  const history = declaredEmployers(ap);
  if (!history.length) return null;
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
  /* Token-prefix, via the helper the sibling question already uses, rather than string equality.
   * Equality was the other half of the same false negative: a bank entry reads "Traeco - AI Agent
   * Cost Infrastructure" while the form says "Traeco", and an exact match answers "No" to an
   * employer she is currently at. employerMatchesTarget is anchored at the first token precisely
   * so that "Tone" still cannot match "Tonee". */
  /* STILL "Yes" OR SILENCE, NEVER "No", and this was re-tested on 2026-08-09 rather than assumed.
   *
   * Redwood Materials' "Have you ever worked for Redwood Materials?" is refused while the profile
   * holds an employment record that plainly does not contain Redwood, and returning "No" from that
   * record was tried here and reverted. The record is NOT EXHAUSTIVE and was measured not to be:
   * `employer_history` is scraped out of parsed_json.experience and held 4 of the owner's 9
   * organisations, so the same reasoning that produces "No" about Redwood produces "No" about a
   * company she works at today. governmentEmployment.test.ts pins all three cases.
   *
   * `prior_application_employers` does not rescue it either. That column is a list of employers she
   * has APPLIED to, which she maintains and where `[]` does mean none. This question is about
   * having been EMPLOYED, and answering one from the other would be a statement about her work
   * history built out of her application history. */
  const knownMatch = history.some((employer) => employerMatchesTarget(employer, target));
  return knownMatch ? { value: 'Yes' } : null;
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
  // so a mixed "reside OR confirmed plans" question must remain unanswered. Stated here rather than
  // delegated to onsiteCommitmentAnswer, which now answers from the stored standing preference: a
  // promise to work in an office is not a statement about where she will be LIVING.
  return { skipReason: `where you will be living is yours to answer: "${label.slice(0, 60)}"` };
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
  /* WHERE THE POSTING IS, as the portal published it - NOT as the job description describes it.
   *
   * Consulted by exactly one rule in this file, workEligibilityAnswer, and only to resolve a
   * question that points at the posting instead of naming a country ("...in the country where this
   * role is located"). Callers build it with `postingCountryFromJobContext`, which reads the
   * packet's structured location fields and nothing else. Omitting it is always safe: every rule
   * that reads it refuses when it is undefined. */
  postingCountry?: JobCountry,
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

  /* Up here for the same reason as the two above it, and AFTER them on purpose: the PEP question
   * and Astranis's export-control paragraph both contain the word "government", and both are
   * already answered by their own rule, so they must reach it first. What is up here is the other
   * direction. Skydio's gloss reads "...worked for the US government (e.g. congressional staffer,
   * member of military, state, or federal agencies)?", and before this arm existed the bare word
   * "military" in that gloss put it through EEO_QUESTION, which answered an employment-history
   * question with "Decline to self-identify". Verified against the real resolver on 2026-08-09,
   * and it is what makes the placement a safety property rather than a preference. */
  const governmentEmployment = governmentEmploymentAnswer(label, ap);
  if (governmentEmployment) return governmentEmployment;

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

  if (LEGAL_LAST_NAME_QUESTION.test(label)) {
    const surname = legalSurname(ap);
    return surname ? { value: surname } : null;
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

  const internshipJoin = internshipJoinAnswer(label, inputType, ap, jdText);
  if (internshipJoin) return internshipJoin;

  /* MOVED ABOVE THE INTERNSHIP-AVAILABILITY BRANCH, and the move is the whole of the Faire fix.
   *
   * "This role will be in-office on a hybrid schedule, can you commit to being in-office three days
   * per week at the location listed?" is a location commitment by every test in this file -
   * classifyField returns onsite_commitment for it - but INTERNSHIP_AVAILABILITY_QUESTION also
   * matches it, on "can you commit ... schedule", and that branch ran first and refused. So the one
   * of the four onsite blockers whose wording mentions a schedule was held for a different reason
   * than the other three, and fixing the onsite resolver alone would have left it held.
   *
   * The ordering is right this way round rather than merely convenient: the availability branch
   * refuses because a stored free-text term cannot be checked against a posting's season and hours,
   * and that argument does not apply to a question whose subject is where she sits. A label that is
   * genuinely about hours and names no office still reaches the branch below untouched, because
   * isLocationCommitmentQuestion requires an office/onsite/commute word. */
  const routineLocationCommitment = routineLocationCommitmentAnswer(label, ap, jdText);
  if (routineLocationCommitment) return routineLocationCommitment;

  /* THE DATE QUESTIONS, AND ONLY THEM, AND ONLY FROM A WINDOW THAT COVERS THIS POSTING.
   *
   * Placed here rather than higher for the same reason routineLocationCommitmentAnswer is placed
   * above the cadence branch: the label has to have survived every location rule first, so a
   * question about where she sits can never be answered with a date. Placed ABOVE the cadence
   * branch because that one refuses on wording these labels share ("available ... internship"), and
   * it would otherwise refuse a question the record can honestly answer. */
  const availabilityWindow = availabilityWindowAnswer(label, inputType, ap, jdText);
  if (availabilityWindow) return availabilityWindow;

  if (INTERNSHIP_AVAILABILITY_QUESTION.test(label)) {
    return internshipAvailabilityAnswer(label);
  }

  const softwareEngineeringArea = softwareEngineeringAreaAnswer(label);
  if (softwareEngineeringArea) return softwareEngineeringArea;

  const programmingLanguage = programmingLanguageAnswer(label, ap);
  if (programmingLanguage) return programmingLanguage;

  const routineConsent = routineConsentAnswer(label);
  if (routineConsent) return routineConsent;

  const workEligibility = workEligibilityAnswer(label, ap, postingCountry);
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
    /* The refusal is written in the CONTROL'S spelling when the control names its vocabulary.
     *
     * Measured: twenty prod packets across eight employers reported
     * `no option matched "Decline to self-identify"` on the control discovered as
     * "are you hispanic/latino? hispanic_ethnicity", whose list reads
     * ["Yes", "No", "Decline To Self Identify"]. Same refusal, one hyphen apart, and nothing
     * downstream could recover it: that control takes a single fill of this exact string.
     *
     * Done here rather than in a fill builder because this is where the answer is made, so every
     * path - the managed fill, the combobox ladder, the direct-Playwright option snap and the
     * card Mehek reads - all say the same thing. declineWordingForControl never touches a stated
     * answer and never invents a refusal; it only respells one she already gave. */
    const answer = eeoAnswer(eeoPreferenceForLabel(label, ap.eeo_prefs));
    return { value: declineWordingForControl(label, answer) };
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
    case 'address_state': {
      if (!ap.address_state) return null;
      // A question scoped to the United States is a closed set she may simply not be in. See
      // residenceScope.ts: "Dubai" reached a fifty-state dropdown on a real application and only
      // the strictness of the matcher kept a false residence off it.
      const outOfScope = usStateScopeSkipReason(label, ap.address_state);
      return outOfScope ? { skipReason: outOfScope } : { value: ap.address_state };
    }
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
    case 'referral_source_default': {
      /* CHANGED. The fallback was `{ value: 'Company website' }` for an account that had stored
       * nothing, described in profileFieldResolution.test.ts as "a deliberate product behaviour
       * rather than stored data". It is deliberate and it is still a statement of fact about how
       * she found the posting, made to the employer in her name, and it is usually false: Litos
       * finds these jobs on a monitored board, not on the company's website. It is also the single
       * most-asked question in the whole corpus - 25 distinct labels across 20 employers - which by
       * the two-posting rule makes it an ONBOARDING question, not a constant. The column already
       * exists; only the invented default is gone. */
      const source = referralSourceForApplication(ap.referral_source_default, ap.referral_source_evidence);
      return source
        ? { value: source }
        : { skipReason: `how you heard about this role is yours to answer: "${label.slice(0, 60)}"` };
    }
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
      /* DELIBERATELY STILL REFUSED, with a window stored or without one.
       *
       * "Length or term of availability (10-14 weeks)" asks for a length of engagement. The window
       * records the OUTER BOUNDS she is free between, and subtracting one date from the other to
       * produce "11 weeks" would turn "I am free from June to August" into "I will work eleven
       * weeks", which is a longer promise than she made and the arithmetic is ours, not hers. */
      return { skipReason: `availability duration left for you: "${label.slice(0, 60)}"` };
    case 'availability_date': {
      /* "When can you start?", "Earliest start date". Answered from the START of a window that is
       * provably about this posting's cycle, and from nothing else - never from availability_date,
       * which is what this case used to have to refuse in full. */
      const scoped = scopedAvailabilityWindow(ap, jdText);
      if (scoped) return { value: formatWindowDate(scoped.start, inputType) };
      return { skipReason: `availability date left for you: "${label.slice(0, 60)}"` };
    }
    case 'current_employer':
      return ap.current_employer ? { value: ap.current_employer } : null;
    case 'most_recent_employer':
      return ap.most_recent_employer ? { value: ap.most_recent_employer } : null;
    case 'onsite_commitment':
      return onsiteCommitmentAnswer(label, ap, jdText);
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
      const value = graduationYearFieldAnswer(ap.grad_date, ap.grad_year, inputType);
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
