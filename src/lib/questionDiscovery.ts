import type { Page } from 'playwright-core';
import { isSameCompany } from './companyIdentity';
import { isOpaqueIdentifier, tidyLabel } from './fieldLabel';
import { jobCountry, type JobCountry } from './jobLocation';
import { officeMetrosNamed } from './officeMetros';
import {
  derivationIsCurrent,
  optionBandAnswer,
  reviewedOptionBandCoversCurrentValue,
  storedOptionAnswerIsCurrent,
} from './optionBand';
import type { SupportedPortal } from './portalSubmission';
import {
  resolveSalary,
  storedSalaryOf,
  type StoredSalaryProfile,
} from './salary';
import {
  referralSourceForApplication,
  isJobBoardReferralClaim,
  REFERRAL_OTHER_DETAIL,
  type ReferralSourceEvidence,
} from './referralSource';
import { usStateScopeSkipReason } from './residenceScope';
import { comparableOption, declineWordingForControl } from './selfIdentification';
import {
  availabilityWindowForPosting,
  formatWindowDate,
  formatWindowRange,
  readCycle,
  type AvailabilityWindowFacts,
} from './availabilityWindow';
import type { CountryWorkEligibility } from './workEligibility';
import { eligibilityForCountry, namedCountryCodes } from './workEligibility';

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
  /**
   * The ADDRESS OF RECORD: what lib/resumeEmail.ts prints on the resume and what gets frozen into a
   * packet's `_contact.email`. Read by exactly one rule, academicEmailAnswer.
   *
   * NOT the address the form's identity field gets. That one is the tracked Litos alias produced by
   * resolveFrozenApplicantEmail, which lib/packetAudit.ts refuses to let equal this value - the two
   * are separate identities on purpose and this field does not go near that fill.
   */
  contact_email?: string;
  phone?: string;
  address_city?: string;
  address_state?: string;
  address_zip?: string;
  address_country?: string;
  linkedin_url?: string;
  github_url?: string;
  portfolio_url?: string;
  citizenship?: string;
  work_authorized?: boolean;
  needs_sponsorship?: boolean;
  /** The only authoritative work eligibility answers for new writes. One exact ISO country each. */
  work_eligibility_by_country?: CountryWorkEligibility[];
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
  /* LITOS' OWN HISTORY, not a declaration she made: every employer this user already has an
   * application at, from `job_context.company` on the rows lib/duplicateApplication.ts counts as
   * having reached an employer. Loaded by lib/applicationProfileLike.ts.
   *
   * IT IS NOT AN ANSWER TO "have you applied to us before?", in either direction. `[]` is "Litos
   * looked and has never sent anything for you", which says nothing about the applications she made
   * herself, made before Litos existed, or made through another channel, and `undefined` is
   * "nobody looked". Absence here is not evidence of absence, so neither value may produce a "No";
   * see previouslyAppliedAnswer, where a named employer only ever WITHDRAWS an answer. */
  submitted_application_companies?: string[];
  has_outstanding_offers?: boolean;
  outstanding_offer_details?: string;
  military_service?: string;
  /* Standardized tests, measured at 8 distinct blocked packets each (2 postings at one employer,
   * retried four times; see db/schema.ts for why the count alone is not the argument). Three fields
   * because the forms ask three questions: which test, and then the score of each. undefined is
   * "never asked" on all three and the resolver refuses, because a test score is a checkable claim
   * about an academic record and there is no safe default for one. */
  standardized_test_type?: 'SAT' | 'ACT' | 'Both' | 'None';
  sat_score?: string;
  act_score?: string;
  politically_exposed?: string;
  politically_exposed_family?: string;
  restrictive_agreements?: string;
  advanced_study_plan?: 'no' | 'considering' | 'committed';
  attest_truthful_information?: boolean;
  accept_privacy_notices?: boolean;

  /* STANDING PERMISSION TO ACCEPT EMPLOYER CONSENT ACKNOWLEDGEMENTS, from users.* rather than from
   * application_profile - the only field in this shape that is not an application fact, and named
   * so that is obvious at every use.
   *
   * PRESENCE IS THE GRANT. The loader sets it only after consentAcceptanceGranted has checked both
   * the boolean and the consent version, so undefined covers all three of "never asked", "revoked"
   * and "agreed to a different version of the words", and every one of those holds. The two fields
   * are carried rather than a bare boolean because the runner writes them onto the question it
   * ticks: the packet audit has to be able to say WHEN she gave this permission, not just that
   * something was ticked on her behalf. */
  consent_acknowledgement_permission?: { granted_at?: string; version: string };
  /* THE SECOND PERMISSION, and it is separate on purpose rather than for tidiness. A code of
   * conduct binds how she behaves in a live interview; a privacy notice is the routine condition of
   * applying at all. CODE_OF_CONDUCT_ACKNOWLEDGEMENT was written because the first was once ticked
   * with nothing behind it, so licensing it off the privacy grant would be that reversion by a
   * tidier route. Granted, revoked and versioned independently. */
  conduct_acknowledgement_permission?: { granted_at?: string; version: string };

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
const CURRENT_SPONSORSHIP_QUESTION = /\b(?:currently|now|right now|at present|before (?:you|the applicant) start|to (?:begin|start) work(?:ing)?)\b/i;
const FUTURE_SPONSORSHIP_QUESTION = /\b(?:in the future|future sponsorship|later|will you (?:need|require))\b/i;
/* "What is your visa status?" is a request for a value. "Will you require sponsorship for
 * employment visa status?" is a yes/no question that happens to contain the same two words, and it
 * is the commonest US sponsorship wording there is: 31 of the owner's stored questions carry it.
 * A bare `visa status` alternative here read every one of them as a request for her authorization
 * type, found none stored, and held a question two consented columns answer. So the phrase now
 * only counts when something in front of it actually asks for the status.
 *
 * DATED IN PRODUCTION, because the regression is younger than the family it broke and a future
 * reader will want to know which side of the line a packet fell on. One employer, one label
 * ("will you now, or in the future, require sponsorship for employment visa status to work in the
 * united states?"), three packets:
 *
 *   60df0c83  2026-08-09 13:30  answer "Yes"
 *   8b5f3dd9  2026-08-09 19:40  answer "Yes"
 *   df44f30   2026-08-10 14:42  PR 456 merges, adding the bare `visa status` alternative
 *   cbebbfaa  2026-08-11 02:23  answer ""      <- 28 fields filled, one field short of submitting
 *
 * The blanking is not this function's doing on its own: refreshKnownQuestionAnswers below
 * overwrites any stored answer with '' once the resolver refuses, so a refusal here erases an
 * answer the applicant supplied by hand. Measured across every distinct label Litos has stored
 * (509 on 2026-08-11), the narrowing moves exactly 5 label families from held to answered, all of
 * them yes/no sponsorship questions, and moves nothing in the other direction. */
const AUTHORIZATION_TYPE_QUESTION =
  /\b(?:current immigration status|work permit type|authorization type|basis of (?:your )?(?:current )?work authorization)\b|\b(?:what\s+is|please\s+(?:provide|specify|state|indicate|describe|list|explain)|which)\b[^?]{0,40}\b(?:visa|immigration|work\s+permit|work\s+authorization)\s+status\b/i;
const AUTHORIZATION_EXPIRY_QUESTION =
  /\b(?:when (?:does|will) (?:your )?(?:visa|work permit|work authorization|authorization) expire|(?:visa|work permit|work authorization|authorization) exp(?:iry|iration)(?: date)?)\b/i;

function selectedEligibilityCountry(
  label: string,
  postingCountry: JobCountry | undefined,
  postingCountryCode: string | undefined,
): string | undefined {
  const named = namedCountryCodes(label);
  if (named.length === 1) return named[0];
  if (named.length > 1) return undefined;
  if (US_WORK_SCOPE.test(label) || US_ABBREVIATION_SCOPE.test(label) || US_ABBREVIATION_SCOPE_CASE_FOLDED.test(label)) {
    return 'US';
  }
  if (postingCountryCode) return postingCountryCode;
  // Compatibility for callers already carrying the legal-scope classifier. It can prove US
  // exactly, but `non_us` cannot say which country and is therefore never enough.
  if (postingCountry === 'us') return 'US';
  return undefined;
}

function workEligibilityAnswer(
  label: string,
  ap: ApplicationProfileLike,
  postingCountry: JobCountry | undefined,
  postingCountryCode?: string,
): { value: string } | { skipReason: string } | null {
  const asksAuthorization = WORK_AUTHORIZATION_QUESTION.test(label);
  const asksSponsorship = SPONSORSHIP_QUESTION.test(label);
  const asksDetail = WORK_AUTHORIZATION_DETAIL_QUESTION.test(label);
  const asksCurrentSponsorship = CURRENT_SPONSORSHIP_QUESTION.test(label);
  // "Will you need sponsorship now?" is present tense despite its auxiliary verb. A current marker
  // wins unless the label independently says future or later.
  const namesFutureTime = /\b(?:in the future|future sponsorship|later)\b/i.test(label);
  const asksFutureSponsorship = FUTURE_SPONSORSHIP_QUESTION.test(label)
    && (!asksCurrentSponsorship || namesFutureTime);
  if (!asksAuthorization && !asksSponsorship && !asksDetail) return null;
  if (RESIDENCE_CLAUSE_JOINED_TO_ELIGIBILITY.test(label)) {
    return { skipReason: workEligibilitySkipReason(label) };
  }

  const countryCode = selectedEligibilityCountry(label, postingCountry, postingCountryCode);
  if (!countryCode) return { skipReason: workEligibilitySkipReason(label) };

  /* The scoped list is the authority. When it is absent, each legacy scalar may answer only the
   * exact US yes/no claim it actually stored. A true combined sponsorship bit cannot be split into
   * present versus future need. This bridge never answers another country or an unscoped role. */
  const scoped = eligibilityForCountry(ap.work_eligibility_by_country, countryCode);
  if (!scoped && ap.work_eligibility_by_country === undefined && countryCode === 'US') {
    if (asksDetail) return { skipReason: workEligibilitySkipReason(label) };
    if (ap.work_authorized === false && ap.needs_sponsorship === false) {
      return { skipReason: workEligibilitySkipReason(label) };
    }
    if (asksAuthorization && asksSponsorship) {
      if (!SPONSORSHIP_WORK_AUTHORIZATION_SUPPORT_QUESTION.test(label)
        || typeof ap.needs_sponsorship !== 'boolean') {
        return { skipReason: workEligibilitySkipReason(label) };
      }
      return { value: ap.needs_sponsorship ? 'Yes' : 'No' };
    }
    if (asksAuthorization) {
      if (typeof ap.work_authorized !== 'boolean'
        || (UNRESTRICTED_WORK_AUTHORIZATION_QUESTION.test(label) && ap.needs_sponsorship === true)) {
        return { skipReason: workEligibilitySkipReason(label) };
      }
      return { value: ap.work_authorized ? 'Yes' : 'No' };
    }
    if (typeof ap.needs_sponsorship !== 'boolean') return { skipReason: workEligibilitySkipReason(label) };
    if (ap.needs_sponsorship && asksCurrentSponsorship !== asksFutureSponsorship) {
      return { skipReason: workEligibilitySkipReason(label) };
    }
    if (SPONSORSHIP_EXEMPTION_QUESTION.test(label)) {
      return { value: ap.needs_sponsorship ? 'No' : 'Yes' };
    }
    return { value: ap.needs_sponsorship ? 'Yes' : 'No' };
  }
  const record = scoped;
  if (!record) return { skipReason: workEligibilitySkipReason(label) };

  if (AUTHORIZATION_TYPE_QUESTION.test(label)) {
    return record.authorization_type
      ? { value: record.authorization_type }
      : { skipReason: workEligibilitySkipReason(label) };
  }
  if (AUTHORIZATION_EXPIRY_QUESTION.test(label)) {
    return record.authorization_expiry
      ? { value: record.authorization_expiry }
      : { skipReason: workEligibilitySkipReason(label) };
  }
  if (asksDetail) return { skipReason: workEligibilitySkipReason(label) };

  if (!record.authorized_now && !record.needs_sponsorship_now) {
    return { skipReason: workEligibilitySkipReason(label) };
  }
  if (asksAuthorization && asksSponsorship && !SPONSORSHIP_WORK_AUTHORIZATION_SUPPORT_QUESTION.test(label)) {
    return { skipReason: workEligibilitySkipReason(label) };
  }
  if (asksAuthorization && asksSponsorship) {
    return { value: (record.needs_sponsorship_now || record.needs_sponsorship_future) ? 'Yes' : 'No' };
  }
  if (asksAuthorization) {
    if (UNRESTRICTED_WORK_AUTHORIZATION_QUESTION.test(label)
      && (record.needs_sponsorship_now || record.needs_sponsorship_future)) {
      return { skipReason: workEligibilitySkipReason(label) };
    }
    return { value: record.authorized_now ? 'Yes' : 'No' };
  }
  if (SPONSORSHIP_EXEMPTION_QUESTION.test(label)) {
    return { value: (record.needs_sponsorship_now || record.needs_sponsorship_future) ? 'No' : 'Yes' };
  }
  const needsSponsorship = asksCurrentSponsorship && !asksFutureSponsorship
    ? record.needs_sponsorship_now
    : asksFutureSponsorship && !asksCurrentSponsorship
      ? record.needs_sponsorship_future
      : record.needs_sponsorship_now || record.needs_sponsorship_future;
  return { value: needsSponsorship ? 'Yes' : 'No' };
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

/* ---------------------------------------------------------------------------------------------
 * STANDARDIZED TEST SCORES. 8 distinct blocked packets each for the type, the SAT and the ACT,
 * counted over the 158-packet corpus on 2026-08-11. Those 8 packets are 2 postings at ONE employer,
 * retried four times each; see the note on the columns in db/schema.ts, which states the bar
 * honestly rather than inflating a packet count into a posting count.
 *
 * THE LABELS ARE MEASURED, NOT IMAGINED. The first version of this rule required the word "score"
 * beside the test name, because "What is your SAT score?" is what the question sounds like. That
 * label appears in the corpus zero times. The complete real set, all required, all text, all blank:
 *
 *   provide your best result on sat             8 packets
 *   provide your best result on act             8 packets
 *   select your standardized test score type    8 packets
 *
 * The employer says RESULT. A pattern keyed on "score" answers one of three.
 *
 * THE ORDER OF THE THREE PATTERNS IS LOAD-BEARING. The type label contains the word "score" and the
 * score labels name a test, so the TYPE pattern is tested LAST: a label naming a specific test wants
 * that test's number, and only a label naming no test is asking which test. Backwards, this types
 * "Both" into a field expecting "1520", a malformed answer on a required field rather than a blank.
 *
 * NOTHING HERE IS DERIVED FROM ANOTHER FIELD. A stored SAT score is not evidence for the type
 * ("Both" and "SAT" both fit it), and a type of "SAT" is not evidence of any particular number.
 */

/* Words that mean the field wants a FIGURE, or name the part of the test it wants one for. The
 * section names are here because the commonest real ATS shape is a bare section label - "SAT Math",
 * "ACT English", "SAT Total (Evidence-Based Reading and Writing + Math)" - which asks for a number
 * without ever saying "score". A gate demanding a value word returned null on all of those, and null
 * is the worst of the three outcomes: it falls through to the essay drafter instead of producing a
 * skipReason that leaves the question for the student.
 *
 * `section` IS DELIBERATELY ABSENT, and it was here once. It is the single token by which every
 * statute is cited - "Rehabilitation Act, Section 503" is the literal citation on the OFCCP
 * disability self-identification form - so including it made a legal citation look exactly like a
 * test subscore and put "34" into a disability question. No corpus label needs it. */
const TEST_CONTEXT_WORD =
  /^(?:results?|scores?|marks?|grades?|composite|superscored?|percentile|maths?|mathematics|reading|writing|english|science|verbal|subscores?|total|exam|test)$/i;

/* WHAT MAY STAND IMMEDIATELY BEFORE A TEST NAME. An ALLOWLIST, and the inversion is the point.
 *
 * This replaced two denylists: one of prepositions that may follow "sat" (the verb, as in "sat FOR
 * the exam") and one of nouns that may precede "act" (the statute, as in "Equality Act"). Both
 * leaked, and they leaked in the way denylists always do - by omission rather than by error:
 *
 *   "Rehabilitation Act, Section 503"      not in the statute list -> filled "34"
 *   "Investment Advisers Act score"        not in the statute list -> filled "34"
 *   "Fair Credit Reporting Act - total"    not in the statute list -> filled "34"
 *   "ADA Amendments Act score"             `amendment` was listed, `amendments` was not
 *   "Date you sat the exam"                the verb here is FOLLOWED by "the", not a preposition
 *   "Have you ever sat this exam?"         same, and the corpus already has a UK-English employer
 *
 * A list of every statute that could appear on an employer form cannot be completed, and neither
 * can a list of every way English can phrase sitting an exam. The set of words that may introduce a
 * TEST NAME, though, is tiny and closed: a determiner, a preposition, a qualifier, or nothing at
 * all when the label opens with the test. Everything above is preceded by a noun or a pronoun and
 * so is refused by default, which is the failure direction this belongs on. All three corpus labels
 * pass, each preceded by "on". */
const TEST_NAME_PRECEDER =
  /^(?:your|the|a|an|on|in|best|highest|composite|superscored|total|and|or)$/i;

function tokens(label: string): string[] {
  return label.toLowerCase().split(/[^a-z0-9+#]+/i).filter(Boolean);
}

/* ADJACENCY, NOT LENGTH. An earlier gate capped the label at eight words, which refused
 * "Please provide your ACT composite score if you have taken the exam" (13 words, unmistakably an
 * ACT field) while still admitting any short sentence that happened to contain both "act" and
 * "score". Requiring the context word to sit WITHIN TWO TOKENS of the test name is what actually
 * separates the two: a form names the test right where it asks for the number, and a sentence that
 * merely contains both words does not. */
const TEST_CONTEXT_MAX_DISTANCE = 2;

function namesTestValue(label: string, test: 'sat' | 'act'): boolean {
  const parts = tokens(label);
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i] !== test && parts[i] !== `${test}s`) continue;
    // Start of label is allowed: "SAT Math" is a field name. Anything else must be a determiner.
    if (i > 0 && !TEST_NAME_PRECEDER.test(parts[i - 1])) continue;
    for (let j = Math.max(0, i - TEST_CONTEXT_MAX_DISTANCE); j <= Math.min(parts.length - 1, i + TEST_CONTEXT_MAX_DISTANCE); j += 1) {
      if (j !== i && TEST_CONTEXT_WORD.test(parts[j])) return true;
    }
  }
  return false;
}

export function isSatScoreQuestion(label: string): boolean {
  return namesTestValue(label, 'sat');
}

export function isActScoreQuestion(label: string): boolean {
  return namesTestValue(label, 'act');
}

/* THE TYPE QUESTION NEEDS A TYPE CUE, not merely a mention of a standardized test.
 *
 * A bare `\bstandardi[sz]ed\s+tests?\b` alternative used to be the first branch here, on the theory
 * that the phrase is unambiguous. It is not. TESTING-ACCOMMODATION questions are disability
 * questions that name a standardized test without ever containing the string `disab`, so they slip
 * EEO_QUESTION as well, and this pattern then typed "Both" into a yes/no control:
 *
 *   Did you receive an accommodation on a standardized test?
 *   Do you require accommodations for a standardized test?
 *
 * So the pattern now requires wording that asks WHICH test or names the field as a TYPE. The one
 * corpus label, "select your standardized test score type", matches on `test score type`. */
export const STANDARDIZED_TEST_TYPE_QUESTION =
  /\btests?\s+scores?\s+type\b|\bstandardi[sz]ed\s+tests?\s+(?:scores?\s+)?type\b|\b(?:which|what)\s+standardi[sz]ed\s+tests?\b|\b(?:which|what)\s+tests?\s+did\s+you\s+take\b/i;

/* An accommodation question is a DISABILITY question wearing a test's vocabulary, and a request for
 * accommodations is never a request for a score or a test name. Kept separate from EEO_QUESTION
 * because it is exactly the family EEO_QUESTION misses: the word `disab` need never appear. */
const TESTING_ACCOMMODATION_QUESTION = /\baccommodat/i;

/* ---------------------------------------------------------------------------------------------
 * A DECLARED ABSENCE IS A FACT, AND IT IS NOT THE SAME FACT AS AN UNSET COLUMN.
 *
 * `standardized_test_type` already carries three distinguishable states, and only two of them were
 * ever read here:
 *
 *   'SAT' | 'ACT' | 'Both'   she took a test, and the score columns say which numbers
 *   'None'                   SHE TOOK NEITHER. Her own declaration, made on the gaps screen.
 *   undefined / null         never asked
 *
 * Before this, 'None' and undefined resolved identically on the two SCORE questions: both fell to
 * `leaveIt`, so a student who had answered the question was held exactly as if she never had. That
 * is the wrong failure for the one state where Litos does know the answer. "I have no SAT score" is
 * a complete, true answer to "Provide your best result on SAT" whenever the control offers a way to
 * say it.
 *
 * WHAT IT MAY DO WITH THAT FACT IS DELIBERATELY NARROW, and the narrowness is the whole design:
 *
 *   The control offers a way to say "none"     -> choose that option, in the employer's spelling.
 *   The control offers options and none says   -> HOLD. Picking a score band she is not in is a
 *   it                                            false claim, and "closest" is not a thing a
 *                                                 score band has.
 *   The control offers nothing (a free text    -> HOLD. This is the corpus's own shape: all three
 *   or numeric box)                               real labels are required TEXT inputs. Typing
 *                                                 "N/A" into a box the employer will read as a
 *                                                 number is a guess about what that employer will
 *                                                 accept, and the cost of guessing wrong on an
 *                                                 academic record is not recoverable. Inventing a
 *                                                 number is worse and is never on the table.
 *
 * So this UNBLOCKS the option-shaped controls and leaves the free-text ones blocked, on purpose,
 * with a skipReason that says which of the two reasons it is. The held message names the declared
 * absence rather than reusing "left for you", because those are different things to tell a student:
 * one of them is a question she has not answered, and the other is a question she HAS answered that
 * this particular employer gives her no room to answer.
 */

/* THE OPTION IS MATCHED WHOLE, AGAINST A CLOSED LITERAL SET. Anchored equality after normalization,
 * with no substring rung anywhere, and that is what makes it capable of refusing: a list reading
 * ["1400-1600", "1200-1399", "Below 1200"] matches nothing here and holds, where any containment
 * rule would eventually find a word it liked. Every member is a phrase that means the applicant has
 * no score to report and nothing else. "No" alone is deliberately absent: it is the answer to a
 * different question, and a bare "No" on a list is far likelier to belong to one. */
const NO_SCORE_OPTION_CLAIMS: ReadonlySet<string> = new Set([
  'n a',
  'na',
  'none',
  'neither',
  'none of the above',
  'none of these',
  'not applicable',
  'no score',
  'no scores',
  'no test score',
  'no test scores',
  'no standardized test scores',
  'not taken',
  'did not take',
  'have not taken',
  'i did not take',
  'i have not taken',
  'i have not taken a standardized test',
  'i have no scores',
  'i do not have a score',
  'i do not have scores',
]);

/* WHAT IS NOT IN THAT SET, AND WHY IT IS THE MOST IMPORTANT PART OF IT.
 *
 * "Prefer not to say", "Decline to answer" and every neighbour of theirs are absent, and they were
 * in the first draft. They are a DIFFERENT CLAIM. "I have no standardized test scores" says what is
 * true of her record; "I prefer not to say" says she has something she is withholding, which is a
 * statement about her intent that she never made and that an employer reads as exactly that.
 *
 * It is not academic. Option lists are iterated in the employer's order, so a control offering
 * ["Prefer not to answer", "SAT", "ACT", "None"] would have answered a declared absence with a
 * refusal she did not give, purely because the refusal was listed first. The two live in different
 * sets so that a declared absence can only ever be spoken as an absence. */
const OPTION_IS_A_REFUSAL_NOT_AN_ABSENCE: ReadonlySet<string> = new Set([
  'prefer not to say',
  'prefer not to answer',
  'prefer not to disclose',
  'decline to answer',
  'decline to state',
  'decline to respond',
  'decline to self identify',
  'i do not wish to answer',
  'i do not wish to disclose',
]);

/* RENAMED FROM `comparableOption`, which is what it was called and which was a name collision.
 * lib/selfIdentification.ts:13 exports a DIFFERENTLY BEHAVING function of that name: it strips
 * apostrophes and keeps `/`, so "N/A" reads "n/a" there and "n a" here. Two functions with one name
 * and two normalizations is how the wrong one gets imported, so this one is named for the family it
 * serves. Apostrophes are dropped rather than spaced, which is what makes "I don't have SAT score"
 * reduce to a phrase at all. */
export function comparableTestOption(option: string): string {
  return option
    .toLowerCase()
    .replace(/[‘’ʼ']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* THE TOKENS THAT ONLY NAME THE FIELD, not the answer. Removing them is what lets one closed set
 * cover "I don't have SAT score", "I don't have ACT score" and "No test taken" without a member per
 * employer. `a` and `an` are deliberately NOT here: "N/A" tokenizes to `n a` and stripping the `a`
 * would leave a bare `n`, so a trailing article is trimmed separately below where it cannot do
 * that. */
const TEST_FIELD_NOUN =
  /^(?:sat|act|gre|gmat|lsat|mcat|standardi[sz]ed|test|tests|exam|exams|score|scores|result|results|the|my|any)$/;

/** The option with the field's own nouns removed, and whether removing them changed anything. */
function reducedOptionClaim(option: string): { bare: string; stripped: boolean } {
  const parts = comparableTestOption(option).split(' ').filter(Boolean);
  let kept = parts.filter((part) => !TEST_FIELD_NOUN.test(part));
  if (kept.length > 1 && /^(?:a|an)$/.test(kept[kept.length - 1])) kept = kept.slice(0, -1);
  return { bare: kept.join(' '), stripped: kept.length !== parts.length };
}

/* Options that are already the whole claim, matched before anything is removed. */
const NO_SCORE_OPTION_LITERALS: ReadonlySet<string> = new Set([
  'n a',
  'na',
  'none',
  'neither',
  'not applicable',
  'none of the above',
  'none of these',
  'nothing',
  'not tested',
]);

/* THE BARE CLAIM THAT SURVIVES once the field's own nouns are gone. "I don't have SAT score" and
 * "I don't have ACT score", both verbatim from the live IMC Trading Greenhouse posting, reduce to
 * `i dont have`. */
const NO_SCORE_REDUCED_CLAIMS: ReadonlySet<string> = new Set([
  'not taken',
  /* `'taken'` WAS HERE AND IT ASSERTED THE OPPOSITE OF WHAT IT MEANT.
   *
   * TEST_FIELD_NOUN strips `test`, `exam`, `sat`, `act` and `score`, so the reducer turned the
   * affirmative into the same string as the negative and this set then read it as an absence:
   *
   *   "Test not taken"  -> not taken  -> absence   correct
   *   "Test taken"      -> taken      -> absence   WRONG
   *   "Taken"           -> taken      -> absence   WRONG
   *   "SAT taken"       -> taken      -> absence   WRONG
   *
   * noScoreOptionFor returns the FIRST match, so on a control offering both directions it chose
   * the one claiming she sat the exam:
   *
   *   ["Test taken", "Test not taken"]  ->  "Test taken"
   *
   * For a student who sat no standardized test that is a false statement submitted on a job
   * application under her name, which is the precise failure this whole feature exists to prevent.
   * The refresh made it worse rather than catching it: a stored "Test taken" against a declared
   * absence was KEPT, because the stored answer is offered back as its own candidate list, while
   * every other wrong value on that path is correctly wiped.
   *
   * It was load-bearing for nothing. The 24 tests here passed identically with and without it, and
   * 'not taken', 'no taken' and 'none taken' below already cover every legitimate reduction.
   * No corpus evidence says such a list is live on a form today, so this was latent rather than
   * firing, and it is deleted anyway: the cost of it firing is unrecoverable and the fix is free. */
  'no taken',
  'none taken',
  'did not take',
  'i did not take',
  'have not taken',
  'i have not taken',
  'dont have',
  'i dont have',
  'do not have',
  'i do not have',
  'have no',
  'i have no',
  'never took',
  'i never took',
  'not tested',
]);

/* "NO" AND "NOT" COUNT ONLY IF SOMETHING WAS REMOVED, which is the whole safety of this rule.
 * "No SAT score" reduces to `no` and is an absence. A bare option reading "No" reduces to `no` with
 * nothing removed, and is the answer to a different question entirely. The `stripped` flag is what
 * separates them, and without it this set would answer every Yes/No control in the corpus. */
const NO_SCORE_ONLY_WHEN_STRIPPED: ReadonlySet<string> = new Set(['no', 'not']);

/** Exported so a test can assert the sets are disjoint. See the note above the refusal set. */
export const NO_SCORE_OPTION_TEXTS = NO_SCORE_OPTION_CLAIMS;
export const REFUSAL_OPTION_TEXTS = OPTION_IS_A_REFUSAL_NOT_AN_ABSENCE;

/** Whether one option text states that the applicant has no score to report. */
export function optionStatesNoScore(option: string): boolean {
  const literal = comparableTestOption(option);
  if (OPTION_IS_A_REFUSAL_NOT_AN_ABSENCE.has(literal)) return false;
  if (NO_SCORE_OPTION_LITERALS.has(literal) || NO_SCORE_OPTION_CLAIMS.has(literal)) return true;
  const { bare, stripped } = reducedOptionClaim(option);
  if (NO_SCORE_REDUCED_CLAIMS.has(bare)) return true;
  return stripped && NO_SCORE_ONLY_WHEN_STRIPPED.has(bare);
}

/**
 * The employer's OWN wording for "I have none", or null when this control offers no such wording.
 *
 * Returns the option text verbatim rather than a normalized form, because the value is typed into
 * the employer's control and has to be the string that control actually carries.
 *
 * A refusal option is stepped over rather than merely unmatched, so that a list carrying both a
 * refusal and an absence answers with the absence whatever order they arrive in.
 *
 * "OTHER" IS NOT AN ABSENCE AND IS DELIBERATELY ABSENT FROM EVERY SET ABOVE. It appears on the live
 * type control as ["SAT", "ACT", "Other"], and it was proposed as the way to unblock that row. It
 * means a DIFFERENT test: the IB, A-levels, a national exam. Selecting it for a student who sat no
 * standardized test would assert she took one and declined to name it, which is a false statement
 * of exactly the kind this whole feature exists to refuse. That control therefore stays blocked for
 * a declared absence, and that is the correct outcome rather than a gap.
 */
export function noScoreOptionFor(options: readonly string[] | undefined): string | null {
  if (!options) return null;
  for (const option of options) {
    if (optionStatesNoScore(option)) return option;
  }
  return null;
}

/* THE PHRASE THAT IDENTIFIES THE THIRD STATE'S REFUSAL, shared by the message and the predicate
 * that reads it back, so the two cannot drift into a silent string-match failure. The Apply screen
 * needs to tell a declared absence apart from an unanswered question, and a skipReason is the only
 * channel the resolver has for saying which it is. */
export const DECLARED_ABSENCE_REFUSAL = 'you declared no standardized test scores';

/** Whether a refusal is the declared-absence one rather than a never-asked one. */
export function isDeclaredAbsenceRefusal(skipReason: string): boolean {
  return skipReason.includes(DECLARED_ABSENCE_REFUSAL);
}

function standardizedTestAnswer(
  label: string,
  ap: ApplicationProfileLike,
  options?: readonly string[],
): { value: string } | { skipReason: string } | null {
  const leaveIt = (what: string) => ({ skipReason: `${what} left for you: "${label.slice(0, 60)}"` });
  /* THE THIRD STATE'S OWN MESSAGE. Distinct from `leaveIt` in wording as well as in cause, so that
   * a blocked row reports which of the two it is, and so that a test can tell them apart without
   * reading the profile that produced them. */
  const declaredNone = (what: string) => ({
    skipReason: `${what}: ${DECLARED_ABSENCE_REFUSAL} and this field offers no way to say so: "${label.slice(0, 60)}"`,
  });
  /* WHICH TEST SHE HAS NO SCORE FOR, which is more than just the 'None' answer.
   *
   * A student who declared 'SAT' has told Litos, in the same breath, that she did not take the ACT.
   * That is the same first-class negative fact as 'None', arrived at from the other side, and
   * reading only 'None' left her held on every ACT field that offered "I don't have ACT score".
   * Derived from the TYPE, never from an empty score column: a blank sat_score under a type of
   * 'SAT' means the number is missing, not that the exam was never sat, and those are different
   * things to tell an employer. */
  const declaredType = ap.standardized_test_type;
  const hasNoScoreFor = (test: 'sat' | 'act'): boolean => {
    if (declaredType === 'None') return true;
    if (test === 'sat') return declaredType === 'ACT';
    return declaredType === 'SAT';
  };

  /* A SELF-IDENTIFICATION QUESTION IS NEVER A TEST SCORE, and this refusal is absolute.
   *
   * This function is called before the EEO_QUESTION branch in resolveKnownAnswer, deliberately, so
   * that a plain required test field is not swallowed by a "Decline to self-identify". The cost of
   * that ordering is that any label matching BOTH reaches here first, and EEO_QUESTION folds
   * disability, veteran and race into one alternation containing `disab`. "Section 503 Disability
   * Act score" matches both, and end to end it filled "34" - verbatim the failure the comment above
   * these matchers says must never happen.
   *
   * The preceder allowlist refuses that particular label a second time, and no real EEO label in
   * the corpus reaches this branch. Both facts are reasons to keep the guard, not to skip it: an
   * absolute claim needs a check that does not depend on a word list staying complete. Returning
   * null hands the label to the EEO branch, which is the rule that should own it.
   *
   * The accommodation check is the same refusal for the family EEO_QUESTION cannot see. "Do you
   * require accommodations for the ACT exam?" contains a test name, a context word beside it and a
   * determiner in front of it, so every gate above passes it; it is still a disability question and
   * the answer to it is never a score. */
  if (EEO_QUESTION.test(label) || TESTING_ACCOMMODATION_QUESTION.test(label)) return null;

  // A specific test named in the label wants that test's number, so these are matched before the
  // "which test" pattern, which also matches many of the same labels.
  //
  // A STORED SCORE STILL WINS OVER THE DECLARED ABSENCE, and the order says so rather than assuming
  // the two can never both be present: routes/applicationProfile.ts refuses to store that
  // combination, but this function is also reached with a row written before that check existed.
  // Reporting the number she earned is the honest reading of a row that carries one.
  if (isSatScoreQuestion(label)) {
    if (ap.sat_score) return { value: ap.sat_score };
    if (!hasNoScoreFor('sat')) return leaveIt('SAT score');
    const none = noScoreOptionFor(options);
    return none ? { value: none } : declaredNone('SAT result');
  }
  if (isActScoreQuestion(label)) {
    if (ap.act_score) return { value: ap.act_score };
    if (!hasNoScoreFor('act')) return leaveIt('ACT score');
    const none = noScoreOptionFor(options);
    return none ? { value: none } : declaredNone('ACT result');
  }
  if (STANDARDIZED_TEST_TYPE_QUESTION.test(label)) {
    if (!ap.standardized_test_type) return leaveIt('standardized test question');
    /* THE EMPLOYER'S SPELLING OF "NONE", and only for 'None'.
     *
     * The stored word is Litos's, not the form's: a list reading ["SAT", "ACT", "Neither"] carries
     * her answer under a name the enum does not use, and the closed-list matcher downstream would
     * find nothing for the literal "None" and leave the control blank. Respelling is confined to
     * this one value because it is the only one whose meaning survives translation: 'SAT' must
     * never be re-spelled as anything, since every neighbouring option on such a list is a
     * different claim about which exam she sat. Same shape as declineWordingForControl, which
     * respells a refusal she already gave and never invents one. */
    if (ap.standardized_test_type === 'None') {
      const none = noScoreOptionFor(options);
      if (none) return { value: none };
    }
    return { value: ap.standardized_test_type };
  }
  return null;
}

function highSchoolGraduationAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  /* THE SAME VETO THE SUBJECT RULE HAS, and this function needs it just as badly. It runs before
   * every other rule in resolveKnownAnswer and its own matcher has a 200-character window, so a
   * UNIVERSITY graduation control that names the high school in order to exclude it was answered
   * with the high-school date: "expected graduation date (not highschool)" and "university
   * graduation year (high-school year not required)" both went from the correct "May 2028" to
   * "May 2023". Applying the veto here restores the property the veto exists for - a label naming
   * another institution is left exactly as it was - and it holds for the spaced spelling too,
   * which main was already getting wrong. */
  if (!HIGH_SCHOOL_GRADUATION_QUESTION.test(label)) return null;
  /* ORDER IS THE MEANING HERE TOO, and getting it wrong put the university's NAME into a
   * high-school control - the branch's own headline defect, reintroduced on a new label family.
   * The negation goes first: a high school named as its object means the university owns the box.
   * Failing that, a high school sitting ON the graduation word owns it, however many institutions
   * the label names - "In what year did you graduate from high school? Please also enter the school
   * name" is a high-school control, and standing down there answered it "University of Southern
   * California". Only a label that does neither falls through to the classifier. */
  if (HIGH_SCHOOL_NAMED_TO_EXCLUDE_IT.test(label)) return null;
  if (!HIGH_SCHOOL_OWNS_THE_GRADUATION.test(label)
      && (CURRENT_PROGRAMME_NAMED.test(label) || labelNamesAnotherInstitution(label))) {
    /* A REFUSAL, not a null, and this is the structural half of the fix rather than a wider verb
     * list. HIGH_SCHOOL_GRADUATION_QUESTION has already matched by this point, so the label names a
     * high school; letting it fall through hands it to the classifier, which holds the university.
     * That is how "please also enter the school name" got answered with the university's full name,
     * and how two labels reached the essay drafter. Only the exclusion test above may return null,
     * because there the university genuinely owns the control. */
    return { skipReason: `high school question left for you: "${label.slice(0, 60)}"` };
  }
  /* One control asking for the school's NAME as well as the year cannot be satisfied by the year.
   * Palantir's card is "High School Name & Graduation Year", and typing "May 2023" into it answers
   * half the question while reading as an answer to all of it. Same rule as educationStartAnswer's
   * "a single control asking for the whole range needs both ends".
   *
   * REFUSES HERE rather than returning null. Null was the first draft and it opened a hole: the
   * label fell past this function to the classifier, which read "graduation year" and answered
   * "May 2028" - the UNIVERSITY year, on a high-school control, a wrong answer this branch did not
   * have before. A refusal cannot fall through to anything. */
  if (HIGH_SCHOOL_NAME_REQUEST.test(label)) {
    return { skipReason: `high school question left for you: "${label.slice(0, 60)}"` };
  }
  const stored = ap.high_school_grad_date;
  if (!stored) {
    return { skipReason: `high school graduation question left for you: "${label.slice(0, 60)}"` };
  }
  // Akuna asks for the month and year; a bare "did you earn one" is a Yes that the stored date is
  // the evidence for. Without a date on file neither is answerable, which is the branch above.
  const asksWhen = /\bmonth\b|\byear\b|\bwhen\b|\bdate\b/i.test(label);
  return { value: asksWhen ? stored : 'Yes' };
}

/**
 * Everything a form asks about high school that is not the graduation date.
 *
 * Checked immediately after highSchoolGraduationAnswer, so the one stored high-school fact still
 * answers its own questions and this catches the rest. It never returns a value because there is
 * nothing to return: the profile carries `high_school_grad_date` and no other high-school column -
 * no name, no city, no GPA, no diploma title. See questionIsScopedToHighSchool for the four values
 * the university profile was handing these labels instead.
 *
 * A skipReason rather than null on purpose. Null falls through to the essay drafter, and a drafted
 * high school name is the same wrong answer arriving by a different route.
 */
function highSchoolRecordRefusal(label: string): { skipReason: string } | null {
  if (!questionIsScopedToHighSchool(label)) return null;
  /* The diploma confirmation has its own handler further down this function, answering "Yes" from
   * the stored graduation date. This one sits above it and would otherwise shadow it whenever the
   * label uses a spelling the narrow graduation matcher does not reach: "have you obtained a
   * secondary school diploma or GED?" was blocked where main answered "Yes". */
  if (HIGH_SCHOOL_DIPLOMA_CONFIRMATION_QUESTION.test(label)) return null;
  /* Two more families that own their labels, for the same reason. Self-identification has its own
   * ladder and its own stored preference; an open-ended prompt is the essay drafter's, and
   * "describe your leadership experience in high school" is a question she can answer at length
   * rather than a fact the profile was asked for. Both were being shadowed by this refusal because
   * neither classifies to a profile key, and the stand-down below only reads the key. */
  if (EEO_QUESTION.test(label)) return null;
  /* GATED ON THE SAME KEY SET AS classifyField's WRAPPER, and for the same reason: a label can name
   * her high school while asking for something that is not an education fact at all. "What city do
   * you live in? (not the city of your high school)" is an address question, and refusing it hands
   * back exactly the blank the gloss was written to prevent. Reading the intent keeps both sides of
   * this rule - the classifier's and the resolver's - answering to one definition instead of two
   * that can drift.
   *
   * Only a key that is NOT an education fact stands the refusal down. A label that classifies as
   * nothing at all still refuses, and has to: "What high school did you go to?" matches no arm in
   * this file, so leaving it null would drop it to the essay drafter, and a drafted high school
   * name is the same wrong answer arriving by a different route. */
  const intent = classifyFieldIntent(label);
  if (intent && !CURRENT_PROGRAMME_KEYS.has(intent)) return null;
  /* An open-ended prompt is the drafter's - but only when the label is not ALSO a fact request. A
   * label that classifies as school, GPA or degree is asking for a fact however long it is, and
   * standing down on length alone is how "What is the name of the high school you attended most
   * recently?" reached the drafter to have a high school invented for it. */
  if (!intent && isOpenEndedQuestion(label)) return null;
  return { skipReason: `high school question left for you: "${label.slice(0, 60)}"` };
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

/**
 * Whether Litos' own history already shows an application at the employer THIS packet is for.
 *
 * Three answers, not two, and only `true` does anything. `undefined` is "the history was not read"
 * and `false` is "Litos has sent nothing there", and NEITHER licenses an answer: the send log
 * cannot see an application she made herself, made before Litos existed, or made anywhere else, so
 * its silence is not a fact about her history. `true` withdraws an answer she would otherwise get,
 * which is the one direction a partial record can be read in.
 *
 * The comparison is lib/companyIdentity.ts's, which is the duplicate guard's own rule for whether
 * two packets are for the same employer, on the two strings it already compares: the packet's
 * `job_context.company` on each side. Exact on the folded identity, so a submitted "IMC Trading"
 * application does not stand down the answer for a posting at "IMC", and "Imcorp" stands down
 * nothing at all.
 */
function applicationAlreadyAtPacketEmployer(
  ap: ApplicationProfileLike,
  jdText?: string,
): boolean | undefined {
  const history = ap.submitted_application_companies;
  if (!history) return undefined;
  const packetEmployer = frozenJobEmployerFromContext(jdText);
  if (!packetEmployer) return undefined;
  return history.some((company) => isSameCompany(company, packetEmployer));
}

/**
 * "Have you applied to us before?", and why only SHE can answer No.
 *
 * A "No" here is a statement about the applicant's whole history, and Litos holds no record that
 * covers it. `submitted_application_companies` is Litos' own send log: it knows nothing about
 * applications she made herself, applications she made before Litos existed, or applications made
 * through any other channel. An empty send log is therefore an absence of evidence and never
 * evidence of absence, and answering "No" from it states a fact to an employer that nobody
 * established. The measured IMC label makes the cost concrete: it says an applicant not selected
 * this season may only reapply in 2027, so a wrong "No" both misstates her history and pushes
 * through the exact duplicate the question exists to catch, with no attention flag on it.
 *
 * So "No" comes from a POSITIVE DECLARATION and nothing else - `prior_application_employers`
 * recorded as `[]`, which is her saying she has not applied anywhere, or a declared list that does
 * not name this employer. `undefined` on that column is "never asked" and holds the question,
 * exactly as main did before the send log was wired in here.
 *
 * The send log still has one job, and it is the opposite one: it WITHDRAWS an answer, never grants
 * it. An employer named in it is handed back rather than answered "Yes", because those rows carry
 * no window ("within the last 12-18 months"), no role scope, and include unverified sends that may
 * never have reached the employer at all (see submittedApplicationCompanies in
 * lib/duplicateApplication.ts). A wrong Yes costs the applicant exactly what a wrong No costs her.
 *
 * The order below is the argument:
 *   1. A declared employer is a statement she made herself, and it answers Yes. No history read can
 *      contradict a Yes, so it is settled first.
 *   2. Global history ("have you applied anywhere before?") is answered only from her declaration.
 *   3. A company Litos' own send log already shows an application at is handed back, even against
 *      her declaration: the declaration was made at onboarding and the send came after it.
 *   4. A declared list that does not name this employer answers No.
 *   5. Nothing declared holds, whatever the send log says.
 *
 * AND ONE MORE, WHICH RUNS BEFORE ALL FIVE. Where a trailing help-text sentence was removed from
 * the label, the question's true scope is unknown, and this file will not guess at it: see
 * withoutTrailingHelpText for why two rounds of trying to read the sentence were deleted rather
 * than extended. A removed sentence may have narrowed the question ("only internship applications"),
 * widened it ("applications to any IMC group entity also count", "our subsidiaries"), moved its
 * window, or done nothing at all, and nothing here can tell those apart.
 *
 * So under a removed sentence the rule is about the RECORDS, not the words:
 *   - never Yes, from any record. A Yes rests on an application whose membership in the restated
 *     scope cannot be established.
 *   - No only from her own declared `[]`, which is true under every restriction, every widening,
 *     every time window and every group-entity rewording, because there is nothing for a
 *     restatement to bring into scope. A declared list with anything in it holds, and so does an
 *     unread column: an empty send log cannot stand in for that declaration here for the same
 *     reason it cannot stand in for it anywhere else in this function.
 *   - and the send log withdraws it on THIS EMPLOYER, exactly as it does below.
 *   - otherwise hold.
 *
 * THAT LAST POINT IS A CORRECTION, and it is the whole of the 2026-08-12 defect. This branch used to
 * withdraw the answer on a positive record at ANY employer, on the argument that a widening tail is
 * where an application elsewhere is the one that counts. The cost was measured on the owner account:
 * she had declared `[]`, Litos' send log held Cresta and kos.ai and nothing at IMC, and IMC's live
 * label was handed back - so two applications to unrelated companies took away an answer that both
 * records agree on. It is also strictly stricter than the very same label WITHOUT the reminder
 * sentence, which answers No off that declaration through the ordinary rules below; one employer
 * appending help text should not change what her records say. The scope that matters to a
 * prior-application question is the employer it names, and that is the scope this reads.
 *
 * THE COST, STATED. An account that never filled the onboarding column gets this question handed
 * back, which is one question she answers herself instead of a sentence Litos wrote for her out of
 * a record that could not see it. applicationFacts.test.ts pins it.
 */
function previouslyAppliedAnswer(
  label: string,
  ap: ApplicationProfileLike,
  jdText?: string,
): { value: string } | { skipReason: string } | null {
  const parsed = parsePriorApplicationQuestion(label, jdText);
  if (!parsed) return null;
  const held = { skipReason: `prior application question left for you: "${label.slice(0, 60)}"` };
  if (!parsed.valid || (!parsed.target && !parsed.globalPriorApplicationHistory)) return held;

  const declared = ap.prior_application_employers;

  /* A REMOVED SENTENCE RESTATED THE SCOPE, AND ONLY HER OWN EMPTY DECLARATION SURVIVES THAT.
   *
   * Her declared `[]` is the statement that the set of applications is empty, and an empty set has
   * nothing for a narrowing, a widening, a time window or a group-entity rewording to act on. That
   * is why it is the only declaration this branch will answer from: a list with anything in it, and
   * an unread column, both hold. An empty SEND LOG is not that statement either - it is Litos
   * reporting on itself, and a widening tail is precisely where the applications it cannot see would
   * count - so it cannot license the answer here any more than it can below. */
  if (withoutTrailingHelpText(label).stripped) {
    if (declared?.length !== 0) return held;
    /* AND THE SEND LOG STILL WITHDRAWS IT, ON THIS EMPLOYER, which is the same job it has below and
     * on the same test. A packet already sent to the employer the question names means the
     * declaration was made before the send and is out of date. A packet sent to some OTHER employer
     * says nothing about this question and no longer takes the answer away: see the correction in
     * the block comment above for what that cost when it did. */
    return applicationAlreadyAtPacketEmployer(ap, jdText) === true ? held : { value: 'No' };
  }

  if (declared && declared.length > 0) {
    // Her own statement, and no history read can contradict it.
    if (parsed.globalPriorApplicationHistory) return { value: 'Yes' };
    if (declared.some((employer) =>
      employerMatchesTarget(canonicalSiblingEmployerIdentity(employer), parsed.target!))) {
      return { value: 'Yes' };
    }
  }
  // undefined is "never asked". An empty array is the student saying she has not applied anywhere
  // before, which answers No for every employer - the two must not be collapsed.
  if (parsed.globalPriorApplicationHistory) return declared ? { value: 'No' } : held;

  /* The send log is consulted for ONE purpose: to withdraw an answer she would otherwise get. A
     packet already sent to this employer means her onboarding declaration is out of date, so even a
     declared list that does not name this employer stops answering. It never adds an answer of its
     own - not "Yes", which its rows cannot support, and not "No", which is the defect this ordering
     exists to close. */
  if (applicationAlreadyAtPacketEmployer(ap, jdText) === true) return held;
  // Her declaration, or nothing. An unread column and an unnamed employer are not the same fact.
  return declared ? { value: 'No' } : held;
}

/* THE ONE LABEL SHAPE THAT ASKS FOR AN ACADEMIC ADDRESS, and the noun has to be beside `email`.
 *
 * Windowed and unable to cross a `?`, so "What university do you attend? Email us your transcript"
 * is two questions and matches neither arm. */
const ACADEMIC_EMAIL_QUESTION = new RegExp(
  String.raw`\b(?:universit(?:y|ies)|college|school|campus|academic|student|institution(?:al)?)\b[^?]{0,30}\be-?mail\b`
  + String.raw`|\be-?mail\b[^?]{0,30}\b(?:universit(?:y|ies)|college|school|campus|academic|student|institution(?:al)?)\b`,
  'i',
);

/* An antecedent this file cannot evaluate makes the whole label the applicant's. Kept beside the
 * pattern it vetoes rather than borrowed from the school-leaver rule, which is about a different
 * antecedent. */
const ACADEMIC_EMAIL_CONDITIONAL = /\bif\s+(?:you|your|applicable|not)\b|\bwhere\s+applicable\b|\bonly\s+if\b/i;

/**
 * Is a stored address one an institution issued, rather than a consumer mailbox?
 *
 * `usc.edu`, `ox.ac.uk`, `iitb.ac.in`, `unam.edu.mx`. Not `gmail.com`, and that is the whole point:
 * this is the test that decides whether the address ON FILE can honestly be offered as a university
 * one, and it is applied to the value rather than to the question.
 */
function isAcademicEmailDomain(address: string): boolean {
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at + 1);
  return /(?:^|\.)edu$/.test(domain) || /(?:^|\.)(?:edu|ac)\.[a-z]{2,}$/.test(domain);
}

/**
 * "Please provide your university email address." answered from the address of record, or held.
 *
 * IT IS ITS OWN ARM, and that is a correction of a specific past failure rather than tidiness. This
 * exact label was once answered with the university's NAME, because the bare-keyword fallback at the
 * bottom of classifyField saw `university` in a six-word label and returned the `school` key (see
 * the block comment above FIELD_NAME_LABEL_MAX_WORDS, which is what closed that hole). So this rule
 * is deliberately not a keyword match on `university`: it requires the academic noun to sit beside
 * `email`, and the value it returns comes from ONE place, `contact_email` - the address
 * lib/resumeEmail.ts already prints on the resume and freezes into the packet's `_contact`. There is
 * no path from here to `ap.school`, `ap.degree` or `ap.major`, so the old wrong answer is not
 * reachable however the label is phrased.
 *
 * GROUNDED ON THE VALUE, NOT ON THE QUESTION, which is the second half of the same discipline. The
 * employer is asking for a university address because it is going to check one. An address of record
 * that is a consumer mailbox is not a university address, and answering with it would be a confident
 * wrong answer of exactly the kind a blank is preferable to - so the domain has to say so, or this
 * holds and the applicant fills it in. Nothing is invented in either branch: the value is either an
 * address already on file that reads as institutional, or it is not offered at all.
 *
 * A POLAR QUESTION IS NOT THIS QUESTION. "Do you have a university email address?" wants a yes or a
 * no; typing the address into a yes/no control fills nothing and reports the field empty. It is
 * refused here and left to the rules that already handle it.
 *
 * NEITHER IS A CONDITIONAL ONE. IMC's own other phrasing is "if you applied using your personal
 * email address, please provide your university email address", and Akuna's "if you selected
 * 'other', please list your university" is in this account's history as a conditional that was
 * answered unconditionally. Whether the antecedent holds is not something on file, so the whole
 * label is hers.
 */
function academicEmailAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | { skipReason: string } | null {
  if (!ACADEMIC_EMAIL_QUESTION.test(label)) return null;
  if (isPolarQuestion(label)) return null;
  if (ACADEMIC_EMAIL_CONDITIONAL.test(label)) return null;
  const held = { skipReason: `university email address left for you: "${label.slice(0, 60)}"` };
  const stored = ap.contact_email?.trim().toLowerCase();
  if (!stored || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(stored)) return held;
  return isAcademicEmailDomain(stored) ? { value: stored } : held;
}

/* THE BOX BESIDE THE REFERRAL QUESTION, WHICH IS A DIFFERENT QUESTION.
 *
 * Greenhouse renders "How did you hear about us?" with a sibling free-text control, labelled
 * "Additional information (for source)" on the boards read so far. It is not the referral question
 * and referralAnswer must not match it: one is a closed choice, the other is prose about the choice.
 *
 * Her declaration is that this box says Litos, and it is also simply true - Litos is the job board
 * the application came through - so it is stated rather than held. It does not depend on which
 * option the choice control resolved to, which is deliberate: there is no mechanism for one
 * resolved answer to condition another control's fill, and inventing one to make "only when Other"
 * work would be a cross-control dependency for no gain. "Litos" is the honest answer beside a
 * job-board choice and beside an Other choice alike.
 *
 * SCOPED HARD to labels that name the source. A bare "please specify" or "if other, please
 * describe" sits beside gender, ethnicity and disability controls too, and answering those is
 * exactly the EEO self-identification Litos is forbidden to speak for. The label must say source,
 * referral, or how she heard.
 */
/* A BARE "source" IS NOT THIS QUESTION, and reading it as one shipped a wrong answer.
 *
 * The first version matched the word `source` anywhere after a "please describe"-shaped opener.
 * "Please describe your open source contributions" satisfied that, and resolveKnownAnswer returned
 * {value: 'Litos'} for it - into an employer's box asking about her open-source work. Confirmed the
 * same way for "Please specify your open source experience" and "Tell us about your open source
 * work - additional details".
 *
 * parseReferralQuestion has guarded exactly this hazard from the start with an explicit
 * `\bsource code\b` exclusion. This predicate runs EARLIER in resolveKnownAnswer and had no such
 * guard, so it claimed the label before the careful code could refuse it.
 *
 * So the source word now has to be QUALIFIED - a referral source, the source of an application, the
 * "(for source)" parenthetical Greenhouse writes - rather than merely present. `open source`,
 * `source code` and `sources` as a plural noun are excluded outright, because no phrasing of this
 * question needs them and every phrasing of a software question does.
 */
// `sources` as a bare plural is deliberately NOT excluded: it would reject "Referral sources -
// additional details", a real phrasing, and it carries no software signal of its own.
const OPEN_SOURCE_SUBJECT = /\b(?:open[\s-]?source|source\s+code)\b/i;
const QUALIFIED_SOURCE =
  String.raw`(?:(?:referral|application|recruiting)\s+source|source\s+of\s+(?:your\s+|the\s+)?application|\(\s*for\s+source\s*\)|for\s+source\b|referrer|how\s+you\s+(?:heard|found))`;
const REFERRAL_SOURCE_DETAIL_QUESTION = new RegExp(
  `(?:additional\\s+(?:information|details?|context)|please\\s+(?:specify|describe|provide|tell\\s+us)|if\\s+other|more\\s+detail)[^.?]*${QUALIFIED_SOURCE}`
  + `|${QUALIFIED_SOURCE}[^.?]*(?:additional\\s+(?:information|details?)|please\\s+specify|details?)`,
  'i',
);

function referralSourceDetailAnswer(
  label: string,
  ap: ApplicationProfileLike,
): { value: string } | null {
  // The subject exclusion first, so no qualified-source phrasing can drag an open-source question
  // back in. Same guard parseReferralQuestion has always had, applied at the earlier gate.
  if (OPEN_SOURCE_SUBJECT.test(label)) return null;
  if (!REFERRAL_SOURCE_DETAIL_QUESTION.test(label)) return null;
  // Only alongside a job-board default. An applicant whose stored source is something else has not
  // declared this, and a constant here would be exactly the generated claim selfDeclaration forbids.
  const source = referralSourceForApplication(ap.referral_source_default, ap.referral_source_evidence);
  return isJobBoardReferralClaim(source) ? { value: REFERRAL_OTHER_DETAIL } : null;
}

function referralAnswer(
  label: string,
  ap: ApplicationProfileLike,
  jdText?: string,
): { value: string } | { skipReason: string } | null {
  // The detail box is answered by referralSourceDetailAnswer, and must not be treated as the
  // referral choice itself.
  if (REFERRAL_SOURCE_DETAIL_QUESTION.test(label)) return null;
  const parsed = parseReferralQuestion(label, jdText);
  if (!parsed) return null;
  if (!parsed.valid) {
    return { skipReason: `how you heard about this role is yours to answer: "${label.slice(0, 60)}"` };
  }
  const source = referralSourceForApplication(ap.referral_source_default, ap.referral_source_evidence);
  return source
    ? { value: source }
    : { skipReason: `how you heard about this role is yours to answer: "${label.slice(0, 60)}"` };
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

  const relocation = parseRelocationQuestion(label, jdText);
  if (relocation) {
    if (!relocation.valid) return held;
    const willing = ap.relocation_willingness;
    if (willing === 'yes') return { value: 'Yes' };
    if (willing === 'no') return { value: 'No' };
    return held;
  }

  if (LOCATION_QUESTION_WANTS_A_VALUE.test(label)) return held;

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
  return parseRelocationQuestion(label, jdText) || isLocationCommitmentQuestion(label)
    ? onsiteCommitmentAnswer(label, ap, jdText)
    : null;
}

const FROZEN_JOB_LOCATION_PREFIX = '[LITOS FROZEN JOB LOCATION] ';
const FROZEN_JOB_EMPLOYER_PREFIX = '[LITOS FROZEN JOB EMPLOYER] ';
const FROZEN_JOB_RELOCATION_LOCATION_PREFIX = '[LITOS FROZEN JOB RELOCATION LOCATION] ';

/** Encode the exact packet employer for question-family routing. This is identity evidence only,
 * never an answer by itself. */
export function frozenJobEmployerContext(employer: string): string {
  const value = employer.trim();
  return value ? `${FROZEN_JOB_EMPLOYER_PREFIX}${value}` : '';
}

/** Encode every exact structured role location for relocation questions. Kept separate from the
 * US-only onsite marker because foreign and mixed postings are still valid relocation targets. */
export function frozenJobRelocationLocationContext(locations: readonly string[]): string {
  return locations
    .map((location) => location.trim())
    .filter(Boolean)
    .map((location) => `${FROZEN_JOB_RELOCATION_LOCATION_PREFIX}${location}`)
    .join('\n');
}

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

function frozenJobEmployerFromContext(context: string | undefined): string | undefined {
  if (!context) return undefined;
  const employers = context
    .split(/\r?\n/)
    .filter((line) => line.startsWith(FROZEN_JOB_EMPLOYER_PREFIX))
    .map((line) => line.slice(FROZEN_JOB_EMPLOYER_PREFIX.length).trim())
    .filter(Boolean);
  return employers.length === 1 ? employers[0] : undefined;
}

function frozenJobRelocationLocationsFromContext(context: string | undefined): string[] {
  if (!context) return [];
  return context
    .split(/\r?\n/)
    .filter((line) => line.startsWith(FROZEN_JOB_RELOCATION_LOCATION_PREFIX))
    .map((line) => line.slice(FROZEN_JOB_RELOCATION_LOCATION_PREFIX.length).trim())
    .filter(Boolean);
}

/** Duplicated in miniature from routes/submissionRunner.ts's jobContextCompany rather than
 *  imported, so this function's only job_context dependency is the loose shape below and it
 *  cannot pull a route module into this lib. Kept in exact lockstep by
 *  applicationContextForQuestionResolution.test-style coverage in submissionRunner.test.ts,
 *  which calls this function by name and would catch the two drifting. */
function frozenJobEmployerName(jobContext: unknown): string {
  const context = (jobContext && typeof jobContext === 'object' ? jobContext : {}) as Record<string, unknown>;
  const company = context.company;
  return typeof company === 'string' ? company.trim() : '';
}

/**
 * THE ONE CONTEXT STRING EVERY LIVE RESOLUTION OF "WHAT DOES THIS QUESTION ANSWER" IS BUILT
 * AGAINST - discoverAndResolveQuestions and buildPacket in routes/submissionRunner.ts both call
 * this rather than passing review.jd_text on its own, and every other caller of
 * refreshKnownQuestionAnswers / resolveKnownAnswer / knownAnswerLookup that is deciding what the
 * packet's questions currently say MUST call this too - not review.jd_text bare.
 *
 * THE BUG THIS FUNCTION'S EXISTENCE CREATED WHEN ONLY TWO CALLERS USED IT, measured on production
 * 2026-08-20 as a false-positive packet_stale with no edit and no elapsed time. resolveKnownAnswer
 * gates several branches - a bare "Source" or "Application Referral" label, and several relocation
 * and prior-application labels - on frozenJobEmployerFromContext(jdText) / on the frozen location
 * lines this function writes below. Those markers exist ONLY inside this function's output; a real
 * job description's prose is never going to contain the literal string
 * "[LITOS FROZEN JOB EMPLOYER] ". So a resolver gated on the marker is DETERMINISTICALLY false
 * (skipReason, answer withheld) when fed review.jd_text bare, and DETERMINISTICALLY true (a real
 * computed answer) when fed this function's output - for the exact same stored question, on the
 * exact same packet, seconds apart, with nothing the applicant would call a change. That is not a
 * flaky edge case: any posting with a "Source" field or a "have you applied here before" question
 * hit it on every run, which is why it reproduced twice in one day on two unrelated employers.
 *
 * The two audit call sites (POST /applications/:id/packet-audit and every place that recomputes
 * "the packet's questions" for currentAcknowledgedPacketAudit's `questions` override) used to pass
 * jd_text bare, so the audit an applicant acknowledged was hashed from the skipReason-blank
 * resolution, and the ACTUAL fill a moment later - which always goes through
 * discoverAndResolveQuestions or buildPacket, both already on this function - resolved the same
 * label to a real value. Two genuinely different literal answers for a question nothing else
 * touched, hashed into two different packet_version values, and no re-audit could ever converge
 * because one side kept computing on the poorer context. See packetAudit.ts's
 * verifyCurrentPacketAudit and packetAuditService.ts's audit/send call sites, which all now build
 * their `questions` argument through this function instead of jd_text alone. */
export function applicationContextForQuestionResolution(
  row: { job_context: unknown },
  current: { role?: string; jd_text: string },
): string {
  const context = (row.job_context && typeof row.job_context === 'object' ? row.job_context : {}) as Record<string, unknown>;
  /* SPLIT ON THE SEMICOLON BEFORE CLASSIFYING, because a multi-office posting writes its offices
   * into ONE string: Anduril's 2027 intern posting stores `job_context.location` as
   * "Atlanta, Georgia, United States; Boston, Massachusetts, United States; ..." and five more.
   *
   * Classifying the composite is wrong in both directions. It reached jobCountry as a single value
   * and passed the every-one-is-US test on the strength of the American cities in it, so a posting
   * mixing Chicago with London would have frozen as safe; and it was then frozen as ONE location,
   * which is the shape the resolver could not read at all. One city per entry makes the every-one
   * test mean what it says and gives the resolver something it can check. */
  const locationValues = [
    typeof context.location === 'string' ? context.location : '',
    ...(Array.isArray(context.locations) ? context.locations.filter((value): value is string => typeof value === 'string') : []),
  ].flatMap((value) => value.split(';')).map((value) => value.trim()).filter(Boolean);
  const classifiedLocations = [...new Set(locationValues)].map((value) => ({ value, country: jobCountry(value) }));
  const safeLocations = classifiedLocations.length > 0 && classifiedLocations.every((item) => item.country === 'us')
    ? frozenJobLocationContext(classifiedLocations.map((item) => item.value))
    : '';
  const packetEmployer = frozenJobEmployerContext(frozenJobEmployerName(row.job_context));
  const relocationLocations = frozenJobRelocationLocationContext(locationValues);
  return [current.role, current.jd_text, packetEmployer, relocationLocations, safeLocations]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n');
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
  postingCountryCode?: string,
): boolean {
  if (!isRefusedQuestion(label)) return false;
  if (NEVER_FILL_PATTERNS.some((re) => re.test(label))) return true;
  const known = resolveKnownAnswer(label, inputType, ap, jdText, postingCountry, postingCountryCode);
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

/**
 * WHAT THE RESOLVER ANSWERS FOR A QUESTION, for callers that have to reason about their own output.
 *
 * refreshKnownQuestionAnswers replaces a known question's answer with this value, so it is the value
 * the applicant is SHOWN, and two decisions in mergeSubmittedApplicationReviewQuestions turn on it:
 *
 *   1. Did this request change anything. A save posts back what the screen displayed, and the screen
 *      displayed the refreshed value - GET /applications/:id/submission refreshes on read and does not
 *      persist. So a submitted answer equal to this one is a round trip of a value nobody typed, and
 *      minting an applicant claim for it is the 802-answer laundering with extra steps.
 *   2. What an override was made against. Currency is decided by comparing the recorded value with
 *      what the resolver says later, so the recorded value has to be the resolver's own, not the
 *      stored answer - a band record holds "January 2028 - July 2028" while the resolver says
 *      "May 2028", and recording the band makes every such override unprovable and therefore lost.
 *
 * Built here rather than at each call site so the lookup, the refresh and the merge cannot disagree
 * about what the resolver says. Returns undefined whenever the resolver declines to answer, which is
 * every held question and every essay, and undefined is read by both callers as "no resolver opinion".
 */
export function knownAnswerLookup(
  ap: ApplicationProfileLike,
  jdText: string | undefined,
  postingCountry?: JobCountry,
  postingCountryCode?: string,
): (question: { question: string; answer?: string }) => string | undefined {
  return (question) => {
    const label = normalizeReviewQuestionLabel(question.question ?? '');
    if (!label) return undefined;
    /* EVERY ARGUMENT BELOW MATCHES THE REFRESH'S OWN CALL, and that is the entire contract of this
     * function rather than a detail of it. The point is to answer "what will the refresh serve", so a
     * lookup that resolves with different inputs is worse than no lookup: it reports a value the
     * refresh will not produce, and the merge then either refuses a real edit or claims a fake one.
     *
     * 'text' IS HARDCODED THERE, so it is hardcoded here. Passing the control's own portal_input_type
     * looked more faithful and measured differently on the first run of these tests - a 'select' degree
     * control resolved to something the refresh never returns, which is precisely the disagreement this
     * comment exists to prevent. The stored answer is offered back as a one-element candidate list for
     * the same reason; see the storedAsCandidate comment in refreshKnownQuestionAnswers. */
    const storedAsCandidate = question.answer?.trim() ? [question.answer.trim()] : undefined;
    const known = resolveKnownAnswer(
      label,
      'text',
      ap,
      jdText,
      postingCountry,
      postingCountryCode,
      storedAsCandidate,
    );
    return known && 'value' in known ? known.value : undefined;
  };
}

export function refreshKnownQuestionAnswers<T extends { question: string; answer: string }>(
  questions: readonly T[],
  ap: ApplicationProfileLike,
  jdText: string | undefined,
  questionsReviewedAt?: string,
  postingCountry?: JobCountry,
  postingCountryCode?: string,
): T[] {
  return questions.map((question) => {
    const label = normalizeReviewQuestionLabel(question.question);
    /* THE STORED ANSWER IS OFFERED BACK AS THE CANDIDATE LIST, and that is not a trick.
     *
     * THE DEFECT THIS CLOSES, measured on the real two-step production sequence:
     *
     *   STEP 1  discovery and fill, WITH the control's options   ->  stored answer "N/A"
     *   STEP 2  packet build refresh, with no options at all     ->  answer ""
     *   RESULT  the fill is undone, and the row stays blocked
     *
     * A declared absence is answerable only in the employer's OWN wording, so the resolver needs a
     * list to say it. This path has none: ApplicationReviewQuestion carries portal_input_type and
     * no options, so the refresh could not see what the control offered, produced the
     * declared-absence skipReason, and blanked the very answer step 1 had just chosen. Three live
     * consequences: blankRequiredQuestionLabels is `required && !answer.trim()`, so the row stays
     * blocked, which is the symptom this feature exists to clear; buildPacket ships the empty
     * string from twelve call sites; and applications.ts compares refreshed against stored, so
     * "N/A" against "" reads as `changed` and aborts the attended handoff.
     *
     * PERSISTING OPTIONS ON THE REVIEW QUESTION WAS THE OTHER OPTION AND IS WORSE HERE. It widens a
     * stored type that twelve call sites and every historical packet already share, to carry a
     * snapshot of a control's list that is stale the moment the employer edits the form, purely so
     * this one rule can re-derive an answer it already has.
     *
     * WHAT THIS ASKS INSTEAD IS THE QUESTION THE REFRESH IS ACTUALLY FOR: is the answer already
     * stored still supported by the profile as it stands now? The stored answer IS the option the
     * control offered, so handing it back as a one-element list is the exact candidate under test.
     * It cannot invent anything: noScoreOptionFor returns a member of that list or null, so the
     * only string it can produce is the one already in the packet, and only when that string is in
     * the closed absence set. Anything else falls through to the identical behaviour as before.
     *
     * Read by standardizedTestAnswer and nothing else, so no other rule changes.
     */
    const storedAsCandidate = question.answer.trim() ? [question.answer.trim()] : undefined;
    const known = label
      ? resolveKnownAnswer(label, 'text', ap, jdText, postingCountry, postingCountryCode, storedAsCandidate)
      : null;
    const withProvenance = question as T & {
      answer_source?: unknown;
      answer_reviewed_at?: unknown;
      answer_option_source?: unknown;
      answer_override_of?: unknown;
      consent_permission_version?: unknown;
      consent_permission_granted_at?: unknown;
    };
    const applicantReviewedCurrentAnswer = Boolean(
      question.answer.trim()
      && withProvenance.answer_source === 'applicant_review'
      && typeof withProvenance.answer_reviewed_at === 'string'
      && withProvenance.answer_reviewed_at === questionsReviewedAt,
    );
    /* answer_option_source goes with the answer it describes, and only ever with that answer.
     *
     * Every branch below that CHANGES the answer drops it, because a derivation left beside a value
     * it was not derived from is a lie the next reader has no way to detect: a record reading
     * answer "May 2028" with answer_option_source "May 2027" claims a snap that never happened. The
     * one branch that keeps the answer keeps it, which is the whole point of recording it. */
    /* answer_option_source goes with the answer it describes, and only ever with that answer.
     *
     * Every branch below that CHANGES the answer drops it, because a derivation left beside a value
     * it was not derived from is a lie the next reader has no way to detect. The consent grant is
     * the same kind of claim and drops on the same rule. */
    const withoutProvenance = (): T => {
      const {
        answer_source: _answerSource,
        answer_reviewed_at: _answerReviewedAt,
        answer_option_source: _answerOptionSource,
        answer_override_of: _answerOverrideOf,
        consent_permission_version: _consentPermissionVersion,
        consent_permission_granted_at: _consentPermissionGrantedAt,
        ...rest
      } = withProvenance;
      return rest as T;
    };
    /* AN ANSWER THIS FUNCTION CANNOT RECOMPUTE, AND CAN STILL PROVE IS CURRENT.
     *
     * The line below is right about almost everything and was silently wrong about one class of
     * answer, in the one place it costs the most. It is what makes the profile the source of truth:
     * a question record written on an earlier run must not replay a graduation date the applicant
     * has since corrected, so a freshly resolved value overwrites the stored one.
     *
     * But the value it computes comes only from the profile. It cannot produce
     * "January 2028 - July 2028", because that string does not exist anywhere except the option list
     * of one employer's control, which this function has never seen and cannot see: field options
     * are not persisted. So when discovery HAD read that list and resolveProfileField had snapped
     * onto it, this line overwrote the employer's own wording with "May 2028" and the evidence was
     * gone by the time the fill ran.
     *
     * Measured end to end on 2026-08-11, before this branch existed: the prepare run's packet
     * carried "January 2028 - July 2028" and "3.81 - 3.9", and the SUBMIT run's packet, which is the
     * one that actually fills and sends, carried "May 2028" and "3.89" for all nine graduation and
     * GPA label shapes. That divergence is worse than no fix at all: the preview the applicant
     * approves would show the resolved option while the employer receives the bucket.
     *
     * BOTH HALVES ARE REQUIRED. Band shape says the stored answer could not have been computed here.
     * answer_option_source says the profile has not moved underneath it since it was chosen. A band
     * whose derivation no longer matches the profile is exactly the stale record this function
     * exists to overwrite, and it is overwritten. See storedOptionAnswerIsCurrent. */
    if (known && 'value' in known) {
      /* A CONSENT IS CURRENT WHILE THE PERMISSION IS GRANTED, and that is a different question from
       * the one the band mechanism answers.
       *
       * The branch below needs a date or number band, because that is the shape of an answer this
       * function provably could not have computed. "I agree" is neither, so for the consent family
       * the keep-branch was unreachable and every refresh replaced the employer's own option text
       * with "Yes" - a value that is not on the control's list at all. That is exactly the
       * prepare-versus-submit divergence measured on 2026-08-11 and quoted above, reintroduced for
       * a different family: the applicant approves "I agree" and the employer receives "Yes".
       *
       * So currency is keyed on the thing that actually makes a consent current. The profile value
       * behind it is a constant, so "has the profile moved" can never be the question; "does she
       * still permit this" always is. Revocation is unaffected and still does the work: once the
       * permission is withdrawn resolveKnownAnswer stops returning a value for this label, control
       * never reaches here, and the currentResolverRefuses branch below blanks the answer and strips
       * its provenance.
       *
       * Deliberately NOT keyed on the stored provenance, tempting as that is. mergeReviewedQuestions
       * strips answer_source whenever a stored question has no counterpart in a submitted review, so
       * a record can lose its consent marker while remaining a perfectly good accepted consent, and
       * keying on the marker would resurrect the divergence on exactly those records. */
      if (label && question.answer.trim() && consentAcknowledgementLicence(label, ap, jdText)) {
        /* AN EXPLICIT REFUSAL IS NEVER RE-ACCEPTED. She edited this control to "I do not agree",
         * and the resolver would otherwise overwrite it with the acceptance value, turning her own
         * refusal into a machine acceptance on a live application. Held exactly as she left it. */
        if (isConsentRefusingWording(question.answer)) return question;
        /* A GRANTED PERMISSION IS NECESSARY AND NOT SUFFICIENT, and getting that wrong made this
         * branch worse than the bug it fixed.
         *
         * The dashboard "Review answers" round trip stores the RESOLVED value rather than the
         * displayed one, so a consent showing "I agree" comes back as "Yes" after an unedited Save.
         * Keying currency on the permission alone then PRESERVED that "Yes" - locking in a value
         * that matches nothing on the control, where before it was at least recomputed each run.
         * A recoverable divergence became a permanent one.
         *
         * So the answer must also still look like an option a control offered: an accepting wording
         * that is not simply the constant this resolver produces. "I agree" qualifies and is kept,
         * which is the whole point of the branch. A bare "Yes" does not, and falls through to be
         * recomputed - to "Yes" again, harmlessly, and without freezing it.
         *
         * The round trip itself is fixed on fix/review-screen-shows-resolved-answer. This branch
         * must land after it; see the PR body. */
        if (isConsentAcceptingWording(question.answer)
          && comparableOption(question.answer) !== comparableOption(known.value)) return question;
      }
      const derivedFrom = typeof withProvenance.answer_option_source === 'string'
        ? withProvenance.answer_option_source
        : undefined;
      if (storedOptionAnswerIsCurrent(question.answer, derivedFrom, known.value)) return question;
      if (applicantReviewedCurrentAnswer
        && reviewedOptionBandCoversCurrentValue(question.answer, known.value)) return question;
      /* HER OWN CORRECTION OF A RESOLVED ANSWER, WHICH BEFORE THIS COULD NOT BE MADE AT ALL.
       *
       * THE DEFECT THIS CLOSES, measured on the live Lever degree control. resolveProfileField has
       * no options to snap onto, so it answers with the raw profile degree, "Bachelor of Science in
       * Computer Science", against a four-option list offering "Bachelor Degree". The applicant
       * rewrites it to "Bachelor's Degree" through PUT /applications/:id/review/answers; the route
       * returns 200 and the row genuinely holds her value. Then this function ran, no branch above
       * recognised it, and the line below the band checks replaced it with the profile value again -
       * on every read, on the audit, and on the fill that reaches the employer. So the supported
       * edit path could not move a single machine-resolved answer, anywhere in the product, and a
       * save that had really happened looked to the applicant like one that had not.
       *
       * BOTH HALVES ARE REQUIRED, exactly as they are for the band above, and for the same reason
       * rather than by analogy. `applicantReviewedCurrentAnswer` says a human put this string here
       * in the review round the row itself carries, which is the thing no computed answer can claim.
       * `derivedFrom` says WHICH resolver value she was overriding, so this cannot become a sticky
       * answer that outlives the fact it was chosen against: correct the profile degree to a
       * master's and the derivation stops matching, this branch stops firing, and the answer is
       * recomputed like any other stale record. That is the property that keeps the profile the
       * source of truth while still letting her disagree with one resolution of it.
       *
       * A BAND IS NOT THIS BRANCH'S BUSINESS, and excluding it is not a technicality - it is the one
       * case where an override must NOT win. reviewedOptionBandCoversCurrentValue above already rules
       * on a reviewed range, and it asks a question this branch cannot: does the range she chose still
       * CONTAIN the profile value. "August 2028 - December 2028" beside a graduation of May 2028 is a
       * range that contradicts her own stated fact, and the rule above refuses it for that reason.
       * Letting a claim plus a matching derivation carry it anyway would put a graduation window on a
       * live application that her own profile says is wrong, and would silently reverse a decision
       * pinned by 'a genuine edit on the review screen still wins'. Ranges keep their rule; everything
       * else - the degree ladder, an employer's plain option text, a corrected city - gets this one.
       *
       * NOT OTHERWISE KEYED ON SHAPE. Shape exists in the band rule to prove a string could not have
       * been computed here. An explicit applicant claim proves more than that and proves it directly,
       * so demanding a recognised shape as well would refuse every override anyone would type. */
      const overrodeResolverValue = typeof withProvenance.answer_override_of === 'string'
        ? withProvenance.answer_override_of
        : undefined;
      if (applicantReviewedCurrentAnswer
        && !optionBandAnswer(question.answer)
        && derivationIsCurrent(overrodeResolverValue, known.value)) return question;
      /* NOTHING IS BEING REPLACED, so the applicant-claim survives. See APPLICANT_CLAIM_FIELDS.
       *
       * Every strip in this file is licensed by one sentence: a record left beside a value it was
       * not written for is a lie the next reader cannot detect. That sentence is about a value that
       * CHANGED. When the resolver recomputes the answer already on the record, byte for byte, "she
       * read this exact text and let it stand" is as true as it was a moment ago, and returning a
       * stripped copy asserts a change that did not happen.
       *
       * It also cost a send. answer_source and answer_reviewed_at were inside packet_version, so
       * stripping them from two EEO questions whose answers recomputed to themselves moved the hash
       * and the send gate answered packet_stale on a packet nothing had touched. The hash is
       * separately narrowed so provenance can no longer move it, and THAT is the load-bearing fix
       * (see PACKET_VISIBLE_QUESTION_FIELDS); this one stops the record lying about itself, which is
       * worth having on its own.
       *
       * THE ANSWER-CLAIMS STILL DROP, and that asymmetry is not a compromise with the tests. A
       * consent that round-trips through the review screen comes back as the RESOLVED constant
       * "Yes" rather than the "I agree" she was shown, and a grant record beside "Yes" claims an
       * acceptance of a value no control ever offered. Dropping it is how that record recovers on
       * the next pass; keying currency on the permission alone is what made a recoverable
       * divergence permanent once before. Same for answer_option_source, whose whole job is to say
       * what a band was snapped from. Only the applicant-claim is safe to carry here, so only the
       * applicant-claim is carried.
       *
       * STRICT EQUALITY, deliberately. A case or spacing difference is a different string on the
       * employer's form: "Decline To Self Identify" is not the option "Decline to self-identify",
       * and one of them is what gets typed. Those keep falling through to be replaced. */
      if (known.value === question.answer) {
        const {
          answer_option_source: _optionSource,
          /* The resolver now answers exactly what is on the record, so there is nothing left for an
           * override to be an override OF. Dropping it on the same rule as the other answer-claims
           * keeps the record from saying she disagreed with a value it now agrees with. */
          answer_override_of: _overrideOf,
          consent_permission_granted_at: _grantedAt,
          consent_permission_version: _grantVersion,
          ...withApplicantClaim
        } = withProvenance;
        return withApplicantClaim as T;
      }
      return { ...withoutProvenance(), answer: known.value };
    }
    const currentResolverRefuses = Boolean(known && 'skipReason' in known)
      || Boolean(label && isRefusedQuestion(label));
    if (currentResolverRefuses && !applicantReviewedCurrentAnswer) {
      return { ...withoutProvenance(), answer: '' };
    }
    return question;
  });
}

/* The bare \bcountry\b alternative carries a lookahead because "country code" is telephony, not
 * residence. Teamtailor's captured phone label embeds its placeholder ("phone number with country
 * code +1 201-555-0123"), and before the lookahead this rule claimed that label and answered a tel
 * control with "United Arab Emirates" - the packet_stale deadlock measured on 2026-08-20 and
 * documented at the phone rule in classifyFieldIntent. A standalone "Country code" select is a
 * dial-code picker and is refused for the same reason: the value it wants is not a country name. */
const RESIDENCE_QUESTION =
  /country of residence|which country|country you.{0,20}(based|resid|work from|located)|where are you based|based in which country|current country|country.{0,20}(residing|residence)|\bcountry\b(?!\s*(?:calling\s+|dial(?:l?ing)?\s+)?code\b)/i;
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
/* Moving house is a different promise from sitting in an office and has its own column. The
 * canonical relocation parser below is shared with answer reuse, so resolution and replay cannot
 * disagree about which family owns the label. */
const STORED_ONSITE_COMMITMENT_QUESTION =
  /\b(?:able|willing|available|prepared|can|could|would)\b[^?]{0,80}\b(?:office|in[\s-]?office|on[\s-]?site|onsite|in[\s-]?person|hybrid)\b|\b(?:office|in[\s-]?office|on[\s-]?site|onsite|in[\s-]?person|hybrid)\b[^?]{0,80}\b(?:able|willing|available|prepared|can|could|would)\b/i;
const ONSITE_DAY_COUNT_QUESTION = /\b(?:three|four|five|3|4|5)\s+days?\b/i;
const LOCATION_PREFERENCE_QUESTION =
  /\b(?:single|top|preferred|preference|most interested)\b[^?]{0,120}\blocation\b|\blocation\b[^?]{0,120}\b(?:single|top|preferred|preference|most interested)\b/i;
const LOCATION_CHOICE_QUESTION =
  /\b(?:choose|select|pick)\b[^?]{0,120}\b(?:single|top|preferred|preference|most interested|location|office)\b|\b(?:single|top|most interested)\b[^?]{0,120}\blocation\b|\blocation\b[^?]{0,120}\b(?:single|top|most interested)\b/i;

function isRelocationSkillOrBenefitSubject(label: string): boolean {
  return /\brelocation (?:assistance|benefits?|package|reimbursement|software|systems?|policy|logistics|research|experience|skills?)\b/i.test(label)
    || /\b(?:move|moving|relocating) (?:data|files?|objects?|services?|software|systems?|experience|skills?)\b/i.test(label)
    || (/\brelocat(?:e|ed|ing|ion)\b/i.test(label)
      && /\b(?:experience|skills?|expertise|knowledge|projects?|research|logistics|software|systems?)\b/i.test(label));
}

export function isLocationCommitmentQuestion(label: string): boolean {
  return !isRelocationSkillOrBenefitSubject(label)
    && LOCATION_COMMITMENT_STEM.test(label)
    && LOCATION_COMMITMENT_VOCAB.test(label);
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
/* THE OTHER SHAPE THIS QUESTION TAKES: "which of these are you proficient in", never a preference.
 * Kept as its own pattern rather than folded into PROGRAMMING_LANGUAGE_QUESTION above because the
 * two need different answers - one language chosen for an interview, every language she actually
 * knows for a skills checklist - and a single shared regex would give programmingLanguageAnswer no
 * way to tell which one it is looking at. Anchored on "programming languages" together, not just
 * "languages": the bare word collides with LANGUAGE_QUESTION's spoken-language phrasing
 * ("languages ... proficient"), and "programming languages ... proficient in" (IMC Trading, measured
 * live 2026-08-20) would otherwise answer with English/Hindi instead of Python/SQL/Swift. */
const PROGRAMMING_LANGUAGE_PROFICIENCY_QUESTION =
  /\bprogramming\s+languages?\b[^?]{0,120}\b(?:proficient|familiar|experience[d]?|skilled|comfortable)\b|\b(?:proficient|familiar|experience[d]?|skilled|comfortable)\b[^?]{0,120}\bprogramming\s+languages?\b/i;
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
  return /\bemploy\s+you\b|\byour\s+(?:(?:former|past|current|ex)\s+)?employer\b|\b(?:former|formerly|past|ex)\b[^?]{0,80}\b(?:employee|employer|employment|employed|work|worked|job)\b|\b(?:employee|employer|employment|employed|work|worked|job)\b[^?]{0,80}\b(?:former|formerly|past|ex)\b|\bno\s+longer\b[^?]{0,80}\b(?:employee|employer|employed|work|working)\b|\b(?:employee|employer|employed|work|working)\b[^?]{0,80}\bno\s+longer\b|\bjob\s+(?:at|with|for)\b|\b(?:service|work|employment|job|career|professional|occupational)\s+(?:history|record|background|experience)\b|\bexperience\b[^?]{0,50}\b(?:working|worked|at|with|for)\b|\b(?:working|worked)\s+(?:at|with|for)\b|\brelationship\s+to\b/.test(identity);
}

/** Complete question shapes owned by resolvers that run after government-employment handling.
 * Keywords alone are not enough: an employment-history question may describe application support,
 * a referral system, or relocation software without asking about applying, hearing, or moving. */
function normalizedSiblingQuestionLabel(label: string): string {
  return normalizedGovernmentEmploymentLabel(label);
}

type SiblingQuestionFamily = 'prior_application' | 'referral' | 'relocation';
type ParsedSiblingQuestion = {
  family: SiblingQuestionFamily;
  valid: boolean;
  target?: string;
  globalPriorApplicationHistory?: boolean;
};

const DEFINITE_APPLICATION_DETERMINER = String.raw`(?:the|this|that|these|those|your|our|current)`;
const DEFINITE_APPLICATION_SAFE_MODIFIER = /^(?:current|completed|complete|online|job|employment|final|official|external|fully)$/;
const DEFINITE_APPLICATION_ANY_PHRASE = String.raw`${DEFINITE_APPLICATION_DETERMINER} (?:[a-z0-9]+ )*applications?(?: forms?)?`;
const DEFINITE_APPLICATION_HISTORY_SUFFIX = String.raw`(?:before|previously|already|yet|ever|earlier|so far|to date|in the past)`;
const SUBMISSION_DOMAIN_NOUN = /\b(?:visa|immigration|work authorization|permits?|mobile|software|web|app store|schools?|universit(?:y|ies)|colleges?|loans?|grants?|patents?|benefits?|tax|housing|insurance|scholarships?)\b/;
const SUBMISSION_NEGATION = /\b(?:not|never|no|without|neither|nor|didn t|hasn t|haven t|hadn t|unsuccessfully|hardly|scarcely)\b/;

function isSingleSubmissionTemporal(value: string): boolean {
  return /^(?:[a-z]+ly|already|just|recently|finally|successfully|ever)$/.test(value);
}

function isSubmissionSuffixTemporal(value: string): boolean {
  return isSingleSubmissionTemporal(value)
    || /^(?:before|yet|earlier|so far|to date|in (?:the )?past)$/.test(value);
}

function isSubmissionTemporalSequence(value: string, suffix: boolean): boolean {
  let remaining = value.trim();
  while (remaining) {
    const phrase = suffix && remaining.match(/^(?:so far|to date|in (?:the )?past)(?:\s+|$)/)?.[0]?.trim();
    if (phrase) {
      remaining = remaining.slice(phrase.length).trim();
      continue;
    }
    const word = remaining.match(/^[a-z]+/)?.[0] ?? '';
    if (!word || !(suffix ? isSubmissionSuffixTemporal(word) : isSingleSubmissionTemporal(word))) return false;
    remaining = remaining.slice(word.length).trim();
  }
  return true;
}

function classifyDefiniteApplicationSubmission(value: string): 'owned' | 'unrelated' | null {
  const match = value.match(/^(?:(?:have|had) you ((?:[a-z]+ )*)submitted|did you ((?:[a-z]+ )*)submit|((?:[a-z]+ )*)submitted) (.+)$/);
  if (!match) return null;
  const prefixTemporal = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  const rawObject = match[4] ?? '';
  const jobObjectMatch = rawObject.match(new RegExp(
    `^${DEFINITE_APPLICATION_DETERMINER} ((?:[a-z0-9]+ )*)(?:job|employment|candidate) applications?(?: forms?)?(?: (.+))?$`,
  ));
  const genericObjectMatch = rawObject.match(new RegExp(
    `^${DEFINITE_APPLICATION_DETERMINER} ((?:[a-z0-9]+ )*)applications?(?: forms?)?(?: (.+))?$`,
  ));
  const objectMatch = jobObjectMatch ?? genericObjectMatch;
  if (!objectMatch) return null;
  const modifiers = (objectMatch[1] ?? '').trim().split(/\s+/).filter(Boolean);
  const suffixTemporal = objectMatch[2]?.trim() ?? '';
  if (SUBMISSION_NEGATION.test(value) || SUBMISSION_DOMAIN_NOUN.test(rawObject)) return 'unrelated';
  if (jobObjectMatch) {
    if (modifiers.length > 6) return 'unrelated';
  } else if (modifiers.some((modifier) => !DEFINITE_APPLICATION_SAFE_MODIFIER.test(modifier))) {
    return 'unrelated';
  }
  if (prefixTemporal && !isSubmissionTemporalSequence(prefixTemporal, false)) return 'unrelated';
  if (suffixTemporal && !isSubmissionTemporalSequence(suffixTemporal, true)) return 'unrelated';
  return 'owned';
}

function siblingTailSignalsQuestionOrInstruction(label: string, tail: string): boolean {
  return /\?\s*$/.test(label.trim())
    || /(?:^|\s)(?:please|explain|describe|provide|specify|identify|why|how|who|and)\b/i.test(tail.trim());
}

function exactKnownTarget(raw: string, candidates: readonly string[]): string | null {
  const identity = normalizeIdentity(raw);
  if (!identity) return null;
  const matches = candidates
    .map((candidate) => ({ raw: candidate.trim(), identity: normalizeIdentity(candidate) }))
    .filter((candidate) => candidate.raw && candidate.identity === identity)
    .sort((left, right) => right.identity.length - left.identity.length);
  return matches[0]?.raw ?? null;
}

function startsWithKnownTarget(raw: string, candidates: readonly string[]): boolean {
  const identity = normalizeIdentity(raw);
  return candidates.some((candidate) => {
    const target = normalizeIdentity(candidate);
    return target.length > 0 && (identity === target || identity.startsWith(`${target} `));
  });
}

function startsWithVettedGovernmentEmployer(raw: string): boolean {
  const identity = normalizeIdentity(raw).replace(/^(?:at|for|to|with)\s+/, '');
  return startsWithKnownTarget(identity, [...VETTED_GOVERNMENT_EMPLOYERS.keys()]);
}

function canonicalSiblingEmployerIdentity(value: string): string {
  const government = VETTED_GOVERNMENT_EMPLOYERS.get(normalizeIdentity(value));
  return government?.canonical ?? normalizeEmployerName(value);
}

function siblingEmployerAliases(packetEmployer: string): string[] {
  const packetGovernment = VETTED_GOVERNMENT_EMPLOYERS.get(normalizeIdentity(packetEmployer));
  if (packetGovernment) {
    return [...VETTED_GOVERNMENT_EMPLOYERS.entries()]
      .filter(([, employer]) => employer.canonical === packetGovernment.canonical)
      .map(([alias]) => alias)
      .sort((left, right) => right.length - left.length);
  }
  const tokens = normalizeEmployerName(packetEmployer).split(' ').filter(Boolean);
  return tokens.map((_, index) => tokens.slice(0, tokens.length - index).join(' '));
}

function validatedSiblingEmployerTarget(raw: string, packetEmployer: string | undefined): string | null {
  if (!packetEmployer) return null;
  const matched = exactKnownTarget(raw, siblingEmployerAliases(packetEmployer));
  return matched ? canonicalSiblingEmployerIdentity(packetEmployer) : null;
}

/* THE SENTENCE AFTER THE QUESTION MARK THAT IS NOT A SECOND QUESTION.
 *
 * IMC's live label reads "...within the last 12-18 months? As a reminder, if you have already
 * applied for this position during the current recruitment season and were not selected, you may
 * reapply when the next recruitment season begins in 2027." The trailing sentence is the employer
 * telling the applicant what happens next. It asks her nothing. Read as part of the question it
 * makes the label compound, and on 2026-08-10 that is exactly why the resolver handed it back with
 * "because this is a compound application question" while the question itself was answerable.
 *
 * CLOSED ON THREE POINTS rather than a keyword strip, because the compound refusal is a real guard
 * and this must not become a hole in it:
 *   - the tail must begin after a question mark, so only text the employer put outside the question
 *     is eligible;
 *   - it must open with one of a fixed set of help-text markers;
 *   - it must be exactly ONE sentence, and contain no question mark of its own.
 * "Have you applied to this role...? As a reminder, ...reconsidered. Please explain why." keeps
 * every word and stays compound, because the instruction is a second sentence. So does
 * "...applied here? If yes, please explain.", because "if yes" is not a help-text marker.
 */
const QUESTION_HELP_TEXT_OPENER = /^(?:as a reminder|reminder|please note|note)\b/i;

/* THERE IS NO VOCABULARY HERE, AND THAT IS THE POINT.
 *
 * An earlier version of this branch tried to sort tails into inert and scoping with five closed
 * word classes - restrictive, exceptive, deontic, additive, set-membership. It failed twice on
 * review and both failures were the same failure. It read `only` and `must` and held, and then
 * answered "Yes" off a declared employer for "we disregard applications made before 2024", "we
 * ignore internship applications", "for the purposes of this question, internships are separate".
 * A list over surface forms cannot decide a semantic property: it fails closed on false positives
 * and OPEN on false negatives, and the open direction is the one that makes a false statement to an
 * employer. Lengthening the alternation makes it right about a seventh phrasing and wrong about an
 * eighth.
 *
 * So nothing below reads the tail. `stripped` says only THAT a sentence was removed, and
 * previouslyAppliedAnswer treats a removed sentence as an unknown restatement of scope: it never
 * answers Yes, and it answers No only from the applicant's own declared `[]`. An empty declared set
 * has nothing for any restatement to bring into or out of scope, so "No" is true under every
 * restriction, every widening, every time window and every group-entity rewording. That is a
 * property of the record, established without any judgement about what the words mean.
 */
type QuestionWithoutHelpText = {
  /** The label with the trailing sentence removed, for the shape grammar to read. */
  questionText: string;
  /** Whether a trailing sentence was removed at all. Nothing reads what it said. */
  stripped: boolean;
};

function withoutTrailingHelpText(label: string): QuestionWithoutHelpText {
  const trimmed = label.trim();
  const mark = trimmed.indexOf('?');
  const unchanged = { questionText: label, stripped: false };
  if (mark < 0) return unchanged;
  const tail = trimmed.slice(mark + 1).trim();
  if (!tail || tail.includes('?')) return unchanged;
  if (!QUESTION_HELP_TEXT_OPENER.test(tail)) return unchanged;
  if (/[.!]/.test(tail.replace(/[.!]+$/, ''))) return unchanged;
  /* THE STRIP STILL HAPPENS, and only the ANSWER is restricted. Refusing to strip would put the
   * label back in the compound refusal for every profile, which narrows the default-No path to fix
   * a problem it does not have: where nothing has been sent and nothing is declared there is no
   * application for any restatement to qualify, so the removed sentence cannot change the answer. */
  return { questionText: trimmed.slice(0, mark + 1), stripped: true };
}

function parsePriorApplicationQuestion(
  label: string,
  jdText?: string,
): ParsedSiblingQuestion | null {
  const { questionText } = withoutTrailingHelpText(label);
  const value = normalizedSiblingQuestionLabel(questionText);
  if (/\bapplication (?:support|systems?|software|development|engineering|programming|security)\b/i.test(value)
    || (/\b(?:previous|prior) (?:applicant|application)\b/i.test(value)
      && /\b(?:experience|skills?|expertise|knowledge|architecture|analytics|tracking|systems?|software)\b/i.test(value))) {
    return null;
  }
  const packetEmployer = frozenJobEmployerFromContext(jdText);
  if (/^any former applications$/i.test(value)) {
    return { family: 'prior_application', valid: false };
  }
  const priorWindow = String.raw`(?:(?:within|in|over) (?:the )?(?:last|past)|(?:last|past)) (?:\d+(?: \d+)? )?(?:days?|weeks?|months?|years?)`;
  const priorTime = String.raw`(?:before|previously|in the past|ever|${priorWindow})`;
  const applicationCategoryHead = String.raw`\b(?:internships?|fellowships?|apprenticeships?|co ops?|cooperative|roles?|jobs?|positions?|programs?|opportunit(?:y|ies)|schemes?|schools?|residenc(?:y|ies)|openings?|vacanc(?:y|ies)|placements?|traineeships?|externships?|posts?|appointments?|contracts?)`;
  const organizationalUnitApplication = (raw: string): 'organizational' | 'unrelated' | null => {
    const match = raw.match(
      /^(.*\b(teams?|departments?|groups?|units?|divisions?|branch(?:es)?|affiliates?|entit(?:y|ies)|locations?|offices?|functions?|practices?|subsidiar(?:y|ies)))(?: (in|at|based in|based at|located in|located at|within|for) (.+))?$/,
    );
    if (!match) return null;
    const fullUnit = match[1];
    const head = match[2];
    const preposition = match[3];
    const complement = match[4]?.trim();
    const unitPrefix = fullUnit.slice(0, -head.length).trim();
    if (/^(?:functions?|practices?)$/.test(head)) {
      const technicalModifier = /\b(?:activation|loss|objective|mathematical|statistical|coding|secure coding|programming|api|database|algorithmic)\b/.test(unitPrefix);
      if (technicalModifier) return 'unrelated';
      let semanticModifier = unitPrefix.replace(/^(?:a|an|the|another|any)\s+/, '');
      const contextualOwner = semanticModifier.match(/^(?:our|this|current)\s+(.+)$/);
      if (contextualOwner) {
        semanticModifier = contextualOwner[1];
      } else {
        const alias = packetEmployer
          ? siblingEmployerAliases(packetEmployer).find((candidate) => semanticModifier.startsWith(`${candidate} `))
          : undefined;
        if (alias) semanticModifier = semanticModifier.slice(alias.length).trim();
      }
      const organizationalModifier = /^(?:consulting|products?|business development|corporate(?: finance| development)?|organizational|client services?|advisory|finance|legal|tax|audit|strateg(?:y|ies)|risks?|compliance|operations?|human resources?|hr|people|talent|recruiting|sales|marketing|customer (?:success|support)|supply chains?|procurement|accounting|treasur(?:y|ies)|investor relations?|communications?|public relations?|security governance|quality assurance|program management|project management|it|information technology|commercial|regulatory affairs?|research and development|r and d|partnerships?|business operations|revenue operations|go to market|strategy and operations|clinical operations|data privacy|medical affairs?|esg|environmental(?: and)? social(?: and)? governance)$/.test(semanticModifier);
      if (!organizationalModifier) return 'unrelated';
    }
    if (!preposition) return 'organizational';
    const locationTargets = frozenJobRelocationLocationsFromContext(jdText).flatMap((location) => {
      const city = location.split(',')[0]?.trim();
      return city && normalizeIdentity(city) !== normalizeIdentity(location) ? [location, city] : [location];
    });
    const exactLocation = Boolean(complement && exactKnownTarget(complement, locationTargets));
    const exactEmployer = Boolean(
      complement && packetEmployer && exactKnownTarget(complement, siblingEmployerAliases(packetEmployer)),
    );
    const validComplement = /^(?:located in|located at)$/.test(preposition)
      ? exactLocation
      : /^for$/.test(preposition)
        ? exactEmployer
        : exactLocation || exactEmployer;
    return validComplement ? 'organizational' : 'unrelated';
  };
  const applicationObjectKind = (remainder: string): 'global' | 'packet' | 'typed' | null => {
    const withoutTemporal = remainder.replace(new RegExp(`\\s+${priorTime}$`), '');
    const objectMatch = withoutTemporal.match(/^(?:at|for|to|with)\s+(.+)$/);
    if (!objectMatch) return null;
    const object = objectMatch[1].trim();
    const category = object.match(new RegExp(
      `^(.*?)(${applicationCategoryHead})(?:\\s+(?:at|for|to|with)\\s+(.+))?$`,
    ));
    if (!category) return null;
    const descriptor = category[1].trim().replace(/^(?:an?|any|the)\s+/, '');
    const noun = category[2];
    const employerTail = category[3]?.trim();
    const inherentlyTyped = !/^(?:roles?|jobs?)$/.test(noun);
    if (inherentlyTyped || descriptor) return 'typed';
    if (employerTail) {
      return validatedSiblingEmployerTarget(employerTail, packetEmployer) ? 'packet' : 'typed';
    }
    return 'global';
  };
  const isSkillOrWorkApplicationObject = (remainder: string): boolean => {
    const object = remainder
      .replace(/^(?:at|for|to|with)\s+/, '')
      .replace(new RegExp(`\\s+(?:${priorTime}|already|yet)$`), '');
    return /\b(?:source code|app stores?|problems?|methods?|practices?|techniques?|algorithms?|frameworks?|projects?|tasks?|concepts?|technolog(?:y|ies)|codebases?|vulnerabilit(?:y|ies)|issues?|datasets?|data|models?|systems?|architectures?|research|schoolwork|coursework|knowledge|experience|science|learning)\b/.test(object);
  };
  const previousApplicant = value.match(/^previous applicant\b(.*)$/i);
  if (previousApplicant) {
    const tail = previousApplicant[1]?.trim() ?? '';
    if (tail && !siblingTailSignalsQuestionOrInstruction(questionText, tail)) return null;
    return {
      family: 'prior_application',
      valid: !previousApplicant[1]?.trim() && Boolean(packetEmployer),
      ...(packetEmployer ? { target: canonicalSiblingEmployerIdentity(packetEmployer) } : {}),
    };
  }
  const definiteSubmission = classifyDefiniteApplicationSubmission(normalizeIdentity(value));
  if (definiteSubmission === 'owned') return { family: 'prior_application', valid: false };
  if (definiteSubmission === 'unrelated') return null;
  const submissionStem = value.match(/^(?:(?:have|had)\s+you\s+(?:(?:ever|previously)\s+)?submitted|did\s+you\s+(?:(?:ever|previously)\s+)?submit|(?:(?:ever|previously)\s+)?submitted)\s+(?:(an?|any|the|this|that|your|current)\s+)?(applications?)\b(.*)$/i);
  if (submissionStem) {
    const determiner = submissionStem[1]?.toLowerCase();
    const noun = submissionStem[2]?.toLowerCase();
    const tail = submissionStem[3]?.trim() ?? '';
    const tailIdentity = normalizeIdentity(tail);
    if (/^(?:the|this|that|your|current)$/.test(determiner ?? '')
      && /^(?:before|previously|already|yet|ever|earlier|so far|to date|in the past)?$/.test(tailIdentity)) {
      return { family: 'prior_application', valid: false };
    }
    if (/^(?:the|this|that|your|current)$/.test(determiner ?? '')) return null;
    const packetObject = String.raw`(?:(?:the|this|our) (?:application|role|position|job)|(?:the|our|this|current|the current) (?:company|employer|organization|organisation|firm|business|institution|agency))`;
    const globalObject = String.raw`(?:(?:an?|any) )?(?:application|role|job|company|employer)`;
    const completePacket = new RegExp(`^(?:(?:here|with us|to us|for us)(?: ${priorTime})?|(?:at|for|to|with) ${packetObject}(?: ${priorTime})?)$`).test(tailIdentity);
    const completeGlobal = new RegExp(`^(?:at|for|to|with) ${globalObject}(?: before| previously)?$`).test(tailIdentity);
    const aliases = packetEmployer ? siblingEmployerAliases(packetEmployer) : [];
    const exactPacketObject = aliases.some((alias) => new RegExp(`^(?:at|for|to|with) ${regexpEscape(alias)}(?: before| previously)?$`).test(tailIdentity));
    const objectKind = applicationObjectKind(tailIdentity);
    if (/^(?:before|previously)?$/.test(tailIdentity) || completeGlobal || objectKind === 'global') {
      return { family: 'prior_application', valid: true, globalPriorApplicationHistory: true };
    }
    if (objectKind === 'typed') return { family: 'prior_application', valid: false };
    if (isSkillOrWorkApplicationObject(tailIdentity)) return null;
    const complete = completePacket || exactPacketObject;
    const recognizedObjectPrefix = new RegExp(String.raw`^(?:here|with us|to us|for us|(?:at|for|to|with) (?:${packetObject}|${globalObject}))\b`).test(tailIdentity)
      || aliases.some((alias) => new RegExp(String.raw`^(?:at|for|to|with) ${regexpEscape(alias)}\b`).test(tailIdentity));
    const instructionTail = /(?:^|\s)(?:please|explain|describe|provide|specify|identify|why|how|who|and)\b/i.test(tail);
    if (!complete && !recognizedObjectPrefix && !instructionTail) return null;
    return {
      family: 'prior_application',
      valid: (complete || objectKind === 'packet') && Boolean(packetEmployer),
      ...(packetEmployer ? { target: canonicalSiblingEmployerIdentity(packetEmployer) } : {}),
    };
  }
  const stem = value.match(/^(?:have|had)\s+you\s+(?:(?:ever|previously)\s+)?applied\b\s*(.*)$/i)
    ?? value.match(/^did\s+you\s+(?:(?:ever|previously)\s+)?apply\b\s*(.*)$/i)
    ?? value.match(/^(?:(?:ever|previously)\s+)?applied\b\s*(.*)$/i);
  if (!stem) return null;
  const remainder = normalizeIdentity(stem[1]?.trim() ?? '');
  const temporal = priorTime;
  const targetFreeTemporal = /^(?:(?:have|had) you (?:ever|previously) applied|did you (?:ever|previously) apply|(?:ever|previously) applied)$/.test(normalizeIdentity(value));
  const packetObject = String.raw`(?:(?:the|this|our) (?:application|role|position|job)|(?:the|our|this|current|the current) (?:company|employer|organization|organisation|firm|business|institution|agency))`;
  const globalObject = String.raw`(?:(?:an?|any) )?(?:application|role|job|company|employer)`;
  const targetFreeRemainder = new RegExp(`^(?:${priorTime}|(?:here|with us|to us|for us)(?: ${priorTime})?|(?:at|for|to|with) ${packetObject}(?: ${priorTime})?)$`).test(remainder);
  const definiteApplicationObject = new RegExp(
    String.raw`^(?:at|for|to|with) ${DEFINITE_APPLICATION_ANY_PHRASE}(?: ${DEFINITE_APPLICATION_HISTORY_SUFFIX})?$`,
  ).test(remainder);
  if (definiteApplicationObject) return { family: 'prior_application', valid: false };
  const definiteApplicationWithTail = new RegExp(
    String.raw`^(?:at|for|to|with) ${DEFINITE_APPLICATION_ANY_PHRASE}\s+\S`,
  ).test(remainder);
  if (definiteApplicationWithTail) return null;
  const globalRemainder = new RegExp(`^(?:at|for|to|with) ${globalObject}(?: before| previously)?$`).test(remainder);
  if (
    packetEmployer
    && (
      targetFreeRemainder
      || targetFreeTemporal
    )
  ) {
    return {
      family: 'prior_application',
      valid: true,
      target: canonicalSiblingEmployerIdentity(packetEmployer),
    };
  }
  for (const alias of packetEmployer ? siblingEmployerAliases(packetEmployer) : []) {
    const escaped = regexpEscape(alias);
    const shapes = [
      new RegExp(`^(?:at|for|to|with) ${escaped}(?: ${temporal})?$`),
      new RegExp(`^to work (?:at|for) ${escaped}(?: ${temporal})?$`),
      new RegExp(`^(?:to|for) (?:(?:a|an|the|this|any) )?(?:role|position|job) (?:at|with|for) ${escaped}(?: ${temporal})?$`),
      /* "this role or another role at <employer>" is fully covered by company-scoped evidence:
         both halves of the disjunction are roles AT this employer, so the answer does not depend on
         which one. The time window is not covered, and does not need to be - the default answer is
         No, and "no application at all" is No in every window. Where the history does hold one, the
         question is handed back precisely because the window cannot be settled.
         The window itself is the shared priorTime grammar rather than a months-only literal, and the
         employer's reminder sentence is removed by withoutTrailingHelpText before this runs, so the
         one measured tail no longer has to be spelled out inside the shape. */
      new RegExp(`^to (?:this|the) (?:role|position|job) or another (?:role|position|job) (?:(?:at|with|for) )?${escaped}(?: ${temporal})?$`),
    ];
    if (shapes.some((shape) => shape.test(remainder))) {
      return { family: 'prior_application', valid: true, target: canonicalSiblingEmployerIdentity(packetEmployer!) };
    }
  }
  const employmentObject = remainder.match(/^for\s+(.+)$/)?.[1]?.trim();
  const employmentWithoutTemporal = employmentObject
    ?.replace(new RegExp(` ${temporal}$`), '')
    .trim();
  if (/^(?:employment|work)$/.test(employmentWithoutTemporal ?? '')) {
    return { family: 'prior_application', valid: true, globalPriorApplicationHistory: true };
  }
  const packetEmploymentReference = (scope: string): boolean => (
    /^(?:here|with us|at us|for us|(?:at|with|for) (?:(?:our|this|current|the current) (?:company|employer|organization|organisation|firm|business|institution|agency)))$/.test(scope)
    || (packetEmployer
      ? siblingEmployerAliases(packetEmployer).some((alias) => new RegExp(`^(?:at|with|for) ${regexpEscape(alias)}$`).test(scope))
      : false)
  );
  const typedEmployment = employmentWithoutTemporal?.match(/^(.+)\s+(?:employment|work)(?:\s+(.+))?$/);
  if (typedEmployment) {
    const descriptor = typedEmployment[1]?.trim() ?? '';
    const scope = typedEmployment[2]?.trim();
    if (descriptor.split(/\s+/).length <= 6 && (!scope || packetEmploymentReference(scope))) {
      return { family: 'prior_application', valid: false };
    }
    return null;
  }
  const employmentScope = employmentWithoutTemporal?.match(/^(?:employment|work)\s+(.+)$/)?.[1]?.trim();
  if (employmentScope) {
    const packetReference = packetEmploymentReference(employmentScope);
    if (packetReference) {
      return {
        family: 'prior_application',
        valid: Boolean(packetEmployer),
        ...(packetEmployer ? { target: canonicalSiblingEmployerIdentity(packetEmployer) } : {}),
      };
    }
    if (/^(?:here|with us|at us|for us|(?:at|with|for)\s+\S(?:.*\S)?)$/.test(employmentScope)) {
      return { family: 'prior_application', valid: false };
    }
    return null;
  }
  const nestedUnitRemainder = remainder
    .replace(new RegExp(`\\s+${priorTime}$`), '')
    .match(new RegExp(
      `^(?:to|for) (?:(?:a|an|the|this|that|any) )?(?:[a-z0-9]+ ){0,4}${applicationCategoryHead} (?:within|in|at) (.+)$`,
    ))?.[1];
  if (nestedUnitRemainder) {
    const classification = organizationalUnitApplication(nestedUnitRemainder);
    if (classification === 'organizational') return { family: 'prior_application', valid: false };
    if (classification === 'unrelated') return null;
  }
  const objectKind = applicationObjectKind(remainder);
  if (globalRemainder || objectKind === 'global') {
    return { family: 'prior_application', valid: true, globalPriorApplicationHistory: true };
  }
  if (objectKind === 'typed') return { family: 'prior_application', valid: false };
  if (objectKind === 'packet' && packetEmployer) {
    return {
      family: 'prior_application',
      valid: true,
      target: canonicalSiblingEmployerIdentity(packetEmployer),
    };
  }
  const toObject = remainder.match(/^to\s+(.+)$/);
  const boundedToObject = toObject?.[1]
    .replace(new RegExp(`\\s+(?:${priorTime}|already|yet|earlier|so far|to date)$`), '')
    .trim();
  if (boundedToObject) {
    const classification = organizationalUnitApplication(boundedToObject);
    if (classification === 'organizational') return { family: 'prior_application', valid: false };
    if (classification === 'unrelated') return null;
  }
  if (isSkillOrWorkApplicationObject(remainder)) return null;
  const aliases = packetEmployer ? siblingEmployerAliases(packetEmployer) : [];
  const recognizedObjectPrefix = new RegExp(String.raw`^(?:before|previously|here|with us|to us|for us|to work (?:at|for)|(?:at|for|to|with) (?:${packetObject}|${globalObject}))\b`).test(remainder)
    || aliases.some((alias) => new RegExp(String.raw`^(?:at|for|to|with) ${regexpEscape(alias)}\b`).test(remainder))
    || startsWithVettedGovernmentEmployer(remainder);
  const instructionTail = /(?:^|\s)(?:please|explain|describe|provide|specify|identify|why|how|who|and)\b/.test(remainder);
  if (!targetFreeRemainder && !targetFreeTemporal && !recognizedObjectPrefix && !instructionTail) return null;
  return { family: 'prior_application', valid: false };
}

/* THE THING THE QUESTION IS ASKING ABOUT, WHEN IT IS THIS POSTING AND NOBODY ELSE.
 *
 * Every arm of parseReferralQuestion has to decide whether the target names the packet's own
 * posting - which she can answer - or somebody else, which she cannot. They each spelled that as
 * `(?:this|the|our|current)\s+(?:role|job|...)` with room for exactly ONE noun after the
 * determiner, and employers do not write like that.
 *
 * MEASURED, live, on Palantir's Lever form 2026-08-16: "HOW DID YOU HEAR ABOUT THIS INTERNSHIP
 * OPPORTUNITY?" produced target "this internship opportunity", two nouns, matched nothing, fell
 * through to the employer check, failed it, and came back "how you heard about this role is yours
 * to answer" - on the one question the applicant has a standing answer for. "How did you hear about
 * us?" on Greenhouse resolved fine in the same run, which is what made the shape obvious.
 *
 * So: one determiner, then one or more GENERIC posting nouns and nothing else. The list stays
 * closed on purpose. A target with any word outside it - "this role at Palantir", "this posting on
 * LinkedIn" - does not match here and still goes to validatedSiblingEmployerTarget, so widening
 * this cannot start answering a question scoped to somebody else.
 */
const GENERIC_POSTING_NOUN = '(?:role|job|position|opportunity|vacancy|opening|internship|posting|listing|program|company|employer|organisation|organization)';
const GENERIC_POSTING_TARGET = new RegExp(`^(?:this|the|our|current)\\s+${GENERIC_POSTING_NOUN}(?:\\s+${GENERIC_POSTING_NOUN})*$`, 'i');
const GENERIC_POSTING_TARGET_PREFIX = new RegExp(`^(?:this|the|our|current)\\s+${GENERIC_POSTING_NOUN}\\b`, 'i');

function parseReferralQuestion(label: string, jdText?: string): ParsedSiblingQuestion | null {
  const value = normalizedSiblingQuestionLabel(label);
  if (/\bsource code\b/i.test(value)
    || (/\b(?:referral|recruiting source|source of application)\b/i.test(value)
      && /\b(?:experience|skills?|expertise|knowledge|analytics|program|systems?|software|code)\b/i.test(value))) {
    return null;
  }
  const discovery = value.match(/^(?:how|where)\s+did\s+you\s+(?:first\s+)?(?:become\s+aware\s+of|come\s+across)\b\s*(.*)$/i)
    ?? value.match(/^how\s+were\s+you\s+made\s+aware\s+of\b\s*(.*)$/i);
  if (discovery) {
    const target = discovery[1]?.trim() ?? '';
    const packetEmployer = frozenJobEmployerFromContext(jdText);
    const genericTarget = GENERIC_POSTING_TARGET.test(target)
      || (/^us$/i.test(target) && Boolean(packetEmployer));
    const employerTarget = validatedSiblingEmployerTarget(target, packetEmployer);
    const recognizedTargetPrefix = GENERIC_POSTING_TARGET_PREFIX.test(target)
      || /^us\b/i.test(target)
      || startsWithKnownTarget(target, packetEmployer ? siblingEmployerAliases(packetEmployer) : []);
    if (!genericTarget && !employerTarget && !recognizedTargetPrefix) return null;
    return {
      family: 'referral',
      valid: genericTarget || Boolean(employerTarget),
    };
  }
  const find = value.match(/^(?:how|where)\s+did\s+you\s+(?:first\s+)?(?:find(?:\s+out\s+about)?|discover)\b\s*(.*)$/i);
  if (find) {
    const target = find[1]?.trim() ?? '';
    const packetEmployer = frozenJobEmployerFromContext(jdText);
    const genericTarget = GENERIC_POSTING_TARGET.test(target)
      || (/^us$/i.test(target) && Boolean(packetEmployer));
    const employerTarget = validatedSiblingEmployerTarget(target, packetEmployer);
    const recognizedTargetPrefix = GENERIC_POSTING_TARGET_PREFIX.test(target)
      || /^us\b/i.test(target)
      || startsWithKnownTarget(target, packetEmployer ? siblingEmployerAliases(packetEmployer) : []);
    if (!genericTarget && !employerTarget && !recognizedTargetPrefix) return null;
    return {
      family: 'referral',
      valid: genericTarget || Boolean(employerTarget),
    };
  }
  const bareSourceStem = /^(?:(?:your|the) )?(?:referral|application) source\b|^source of (?:(?:your|the) )?application\b/i;
  if (bareSourceStem.test(value)) {
    const complete = /^(?:(?:your|the) )?(?:referral|application) source$|^source of (?:(?:your|the) )?application$/i.test(value);
    if (!complete && !siblingTailSignalsQuestionOrInstruction(label, value.replace(bareSourceStem, ''))) return null;
    return { family: 'referral', valid: complete };
  }
  if (/^source$/i.test(value)) {
    return { family: 'referral', valid: Boolean(frozenJobEmployerFromContext(jdText)) };
  }
  const packetBoundBare = value.match(/^(application referral)\b(.*)$/i);
  if (packetBoundBare) {
    const tail = packetBoundBare[2]?.trim() ?? '';
    if (tail && !siblingTailSignalsQuestionOrInstruction(label, tail)) return null;
    return {
      family: 'referral',
      valid: !packetBoundBare[2]?.trim() && Boolean(frozenJobEmployerFromContext(jdText)),
    };
  }
  if (/^referral\b/i.test(value)) {
    const tail = value.replace(/^referral\b/i, '').trim();
    if (tail && !siblingTailSignalsQuestionOrInstruction(label, tail)) return null;
    return {
      family: 'referral',
      valid: /^referral$/i.test(value) && Boolean(frozenJobEmployerFromContext(jdText)),
    };
  }
  const direct = value.match(/^(?:how|where)\s+did\s+you\s+(?:first\s+)?hear\s+(?:about|of)\b\s*(.*)$/i)
    ?? value.match(/^(?:how\s+did|where\s+(?:did|have))\s+you\s+(?:first\s+)?learn(?:ed)?\s+(?:about|of)\b\s*(.*)$/i);
  const source = value.match(/^what\s+(?:is|was)\s+(?:(?:your|the)\s+)?referral\s+source\b\s*(.*)$/i);
  if (!direct && !source) return null;
  let rawTarget = (direct?.[1] ?? source?.[1] ?? '').trim();
  if (source) rawTarget = rawTarget.replace(/^(?:for|regarding)\s+/i, '');
  if (/^this employer$/i.test(rawTarget)) {
    return { family: 'referral', valid: Boolean(frozenJobEmployerFromContext(jdText)) };
  }
  if (GENERIC_POSTING_TARGET.test(rawTarget) || /^us$/i.test(rawTarget)) {
    return { family: 'referral', valid: true };
  }
  if (!rawTarget) return { family: 'referral', valid: true };
  const packetEmployer = frozenJobEmployerFromContext(jdText);
  const target = validatedSiblingEmployerTarget(rawTarget, packetEmployer);
  return target
    ? { family: 'referral', valid: true, target: normalizeEmployerName(target) }
    : { family: 'referral', valid: false };
}

function parseRelocationQuestion(label: string, jdText?: string): ParsedSiblingQuestion | null {
  const value = normalizedSiblingQuestionLabel(label);
  if (isRelocationSkillOrBenefitSubject(value)) return null;
  if (/^relocation$/i.test(value)) {
    return { family: 'relocation', valid: false };
  }
  if (/^relocation flexibility$/i.test(value)) {
    return { family: 'relocation', valid: false };
  }
  if (/^are you willing to move if required$/i.test(value)) {
    return { family: 'relocation', valid: true };
  }
  if (/^relocation\s+(?:please|explain|describe|why|how|and)\b/i.test(value)) {
    return { family: 'relocation', valid: false };
  }
  if (/^(?:(?:can|could)\s+you\s+(?:move|relocat\w*)|(?:are|would|can|could)\s+you\s+(?:be\s+)?able\s+to\s+(?:move|relocat\w*)|able\s+to\s+(?:move|relocat\w*))\b/i.test(value)) {
    return { family: 'relocation', valid: false };
  }
  const regular = value.match(/^(?:(?:(?:are|would|will|can|could)\s+you\s+(?:be\s+)?(?:willing|prepared|open)\s+to|(?:would|will)\s+you)\s+relocat\w*|(?:are|would|will|can|could)\s+you\s+(?:be\s+)?(?:willing|prepared|open)\s+to\s+mov(?:e|ing)|(?:would|will)\s+you\s+move|(?:open|willing|prepared)\s+to\s+mov(?:e|ing)|(?:would|could)\s+you\s+consider\s+(?:relocat\w*|moving|a\s+move)|(?:are|would)\s+you\s+(?:be\s+)?open\s+to\s+a\s+move|are\s+you\s+comfortable\s+(?:with\s+)?relocat\w*|do\s+you\s+agree\s+to\s+relocate|do\s+you\s+(?:plan|intend|expect)\s+to\s+(?:relocate|move)|open\s+to\s+(?:relocation|mobility)|willingness\s+to\s+relocate|willing\s+to\s+relocate|relocation\s+willingness)\b\s*(.*)$/i);
  const gerund = value.match(/^would\s+(?:relocating|moving)\b\s*(.*)$/i);
  if (!regular && !gerund) return null;
  let detail = (regular?.[1] ?? gerund?.[1] ?? '').trim();
  detail = detail.replace(/(?:^|\s+)if\s+(?:required|necessary|needed)$/i, '').trim();
  if (gerund) {
    const acceptable = detail.match(/^(?:(.*?)\s+)?be\s+(?:acceptable|comfortable|possible)(?:\s+for\s+you|\s+to\s+you)?$/i);
    if (!acceptable) return { family: 'relocation', valid: false };
    detail = (acceptable[1] ?? '').trim();
  }
  if (!detail) return { family: 'relocation', valid: true };
  if (/^(?:for|to)\s+(?:this|the|our)\s+(?:role|job|position|opportunity|internship)$/i.test(detail)) {
    return { family: 'relocation', valid: true };
  }
  const scoped = detail.match(/^(?:for|to\s+work\s+(?:at|for)|to\s+join|to)\s+(.+)$/i);
  const locations = frozenJobRelocationLocationsFromContext(jdText);
  const locationTargets = locations.flatMap((location) => {
    const city = location.split(',')[0]?.trim();
    return city && normalizeIdentity(city) !== normalizeIdentity(location) ? [location, city] : [location];
  });
  const target = scoped ? exactKnownTarget(scoped[1], locationTargets) : null;
  if (target) return { family: 'relocation', valid: true, target: normalizeIdentity(target) };
  const recognizedLocationPrefix = scoped
    ? startsWithKnownTarget(scoped[1], locationTargets)
    : false;
  const recognizedRolePrefix = /^(?:for|to)\s+(?:this|the|our)\s+(?:role|job|position|opportunity|internship)\b/i.test(detail);
  const compoundTail = /^(?:and|please|explain|describe|provide|specify|identify|why|who|travel|work|start)\b/i.test(detail);
  return recognizedLocationPrefix || recognizedRolePrefix || Boolean(scoped) || compoundTail
    ? { family: 'relocation', valid: false }
    : null;
}

function parseSiblingQuestion(
  label: string,
  jdText?: string,
): ParsedSiblingQuestion | null {
  return parsePriorApplicationQuestion(label, jdText)
    ?? parseReferralQuestion(label, jdText)
    ?? parseRelocationQuestion(label, jdText)
    ?? classifyUnrecognizedSiblingIntent(label, jdText);
}

/** Fail closed only for labels whose complete leading grammar establishes a sibling intent.
 * Incidental words inside employment subjects, source-code fields, or relocation benefits remain
 * outside these families, while a newly worded application-history question cannot retain stale
 * data merely because its exact safe grammar has not been added yet. */
function classifyUnrecognizedSiblingIntent(
  label: string,
  jdText?: string,
): ParsedSiblingQuestion | null {
  const value = normalizeIdentity(normalizedSiblingQuestionLabel(label));
  if (classifyDefiniteApplicationSubmission(value) === 'unrelated') return null;
  const questionShaped = /\?\s*$/.test(label.trim())
    || /^(?:have|has|had|did|do|does|are|is|was|were|would|will|can|could|should|how|where|what|who|when|why)\b/.test(value)
    || /\b(?:please|explain|describe|provide|specify|identify|and who|and why|who referred)\b/.test(value);
  if (value === 'past applications' || value === 'any past applications' || value === 'application history') {
    return { family: 'prior_application', valid: false };
  }
  if (value === 'mobility willingness' || value === 'geographic mobility') {
    return { family: 'relocation', valid: false };
  }
  if (!questionShaped) return null;
  const ordinarySkillSubject = /\b(?:experience|skills?|expertise|knowledge|architecture|analytics|tracking|systems?|software|marketing|projects?|research|engineering|programming)\b/.test(value);
  const applicationVerbWithUnownedObject = /^(?:(?:have|had) you (?:(?:ever|previously) )?applied|did you (?:(?:ever|previously) )?apply|(?:(?:ever|previously) )?applied|(?:(?:have|had) you (?:(?:ever|previously) )?submitted|did you (?:(?:ever|previously) )?submit|(?:(?:ever|previously) )?submitted) an application)\b/.test(value);
  const unrelatedApplicationSubject = /\bapplication (?:support|systems?|software|development|engineering|programming|security)\b/.test(value)
    || applicationVerbWithUnownedObject
    || (ordinarySkillSubject && /\b(?:previous|prior) (?:applicant|application)\b/.test(value));
  if (!unrelatedApplicationSubject && (
    /\b(?:previous|prior) (?:applicant|application)\b|\b(?:any )?earlier applications\b|\b(?:applicant|application)\b.{0,80}\b(?:previous|prior)\b|\b(?:ever|previously)\b.{0,80}\b(?:apply|applied|applicant|application|submit|submitted)\b/.test(value)
  )) {
    return { family: 'prior_application', valid: false };
  }
  const unrelatedReferralSubject = /\b(?:source code|referral (?:program|systems?)|recruiting source (?:code|system|software))\b/.test(value)
    || (ordinarySkillSubject && /\b(?:refer|referred|referral|recruiting source|source of (?:the |your )?application)\b/.test(value));
  if (!unrelatedReferralSubject && (
    /\b(?:refer|referred|referral|recruiting source)\b|\bsource of (?:the |your )?application\b|^source (?:please|explain|describe|why|how|who|and)\b/.test(value)
  )) {
    return { family: 'referral', valid: false };
  }
  const unrelatedRelocationSubject = /\brelocation (?:assistance|benefits?|package|reimbursement|software|systems?|policy|logistics|research|experience|skills?)\b/.test(value)
    || /\b(?:move|moving|relocating) (?:data|files?|objects?|services?|software|systems?|experience|skills?)\b/.test(value)
    || (ordinarySkillSubject && /\brelocat(?:e|ed|ing|ion)\b/.test(value));
  const exactLocations = frozenJobRelocationLocationsFromContext(jdText).flatMap((location) => {
    const city = location.split(',')[0]?.trim();
    return city && normalizeIdentity(city) !== normalizeIdentity(location) ? [location, city] : [location];
  });
  const movesToExactPacketLocation = exactLocations.some((location) => {
    const target = normalizeIdentity(location);
    return value.includes(` move to ${target}`)
      || value.startsWith(`move to ${target}`)
      || value.includes(` moving to ${target}`)
      || value.startsWith(`moving to ${target}`);
  });
  if ((!unrelatedRelocationSubject && /\brelocat(?:e|ed|ing|ion)\b/.test(value)) || movesToExactPacketLocation) {
    return { family: 'relocation', valid: false };
  }
  return null;
}

export function isPriorApplicationQuestion(label: string): boolean {
  return parsePriorApplicationQuestion(label) !== null;
}

export function isRelocationQuestion(label: string): boolean {
  return parseRelocationQuestion(label) !== null;
}

function siblingQuestionRefusal(
  label: string,
  jdText?: string,
): { skipReason: string } | null {
  const parsed = parseSiblingQuestion(label, jdText);
  if (!parsed || parsed.valid) return null;
  if (parsed.family === 'prior_application') {
    return {
      skipReason: `prior application question left for you, because this is a compound application question: "${label.slice(0, 60)}"`,
    };
  }
  if (parsed.family === 'referral') {
    return { skipReason: `how you heard about this role is yours to answer: "${label.slice(0, 60)}"` };
  }
  if (parsed.family === 'relocation') {
    return { skipReason: onsiteCommitmentSkipReason(label) };
  }
  return { skipReason: `compound application question left for you: "${label.slice(0, 60)}"` };
}

function belongsToNonEmploymentQuestionFamily(
  label: string,
  jdText?: string,
): boolean {
  return Boolean(parseSiblingQuestion(label, jdText)?.valid);
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
  jdText?: string,
): { value: string } | { skipReason: string } | null {
  if (belongsToNonEmploymentQuestionFamily(label, jdText)) return null;
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
/* THE HIGH SCHOOL, IN THE SPELLINGS FORMS ACTUALLY USE FOR IT.
 *
 * One definition, shared by the graduation matcher below and by the subject rule under it, so a
 * spelling recognised for answering is recognised for refusing. Before this was shared, the two
 * disagreed and the gap was a wrong answer: `\bhigh\s+school\b` does not match "Highschool", so
 * "Highschool Graduation Year" missed HIGH_SCHOOL_GRADUATION_QUESTION, fell through to the
 * classifier's `graduation_year`, and came back "May 2028" - the UNIVERSITY year. Measured
 * 2026-08-11, along with "HS GPA" -> "3.89" and "12th Grade School Name" -> the university.
 */
const HIGH_SCHOOL_WORD = String.raw`(?:high[\s-]?schools?|(?:sr\.?|senior)\s+secondary(?:\s+school)?|(?<!post[\s‐-―-])secondary\s+schools?|(?:12th|twelfth)\s+grade\s+school|grade\s+12\s+school|prep(?:aratory)?\s+schools?)`;
/* "Secondary education" is deliberately NOT here, though it names the same institution. It is also
 * the name of a MAJOR, and a field-of-study control that lists it as an example - "Major / field of
 * study (e.g. Nursing, Secondary Education, Engineering)" - was refused where main answered
 * "Computer Science". The lookbehind on `secondary school` is a related trap: POST-secondary is the
 * university in North American usage, so "Name of post-secondary institution" must still answer
 * with it. */
/* "HS" is kept OUT of the list above and given its own rule, because two letters are not enough on
 * their own. Even with both word boundaries, `\bhs\b` is the customs tariff "HS code", and without
 * the trailing one it was also HSA, HSBC, HSE, HSTS and HSpice - all of which this branch refused
 * as high-school questions before, one of them displacing a correct prior-employer blocker. The
 * abbreviation counts only with an education fact beside it, which is how a form writes it: "HS
 * GPA", "HS Diploma", "GPA (HS)". */
const HS_FACT = String.raw`(?:gpa|names?|diplomas?|graduat\w*|schools?|transcripts?|cit(?:y|ies)|grades?|years?)`;
/* "Grade 12" gets the same treatment as "HS" and for the same reason: it is a federal pay grade as
 * well as a school year, so "Highest federal grade held (e.g., Grade 12)" and "Grade 12 pay band"
 * were manufactured into high-school blockers. Bare, it means nothing here; with an education fact
 * beside it, it is unambiguous. `<n>th grade school` stays in the noun list above, where the word
 * school already disambiguates it. */
const GRADE_TWELVE = String.raw`(?:(?:12th|twelfth)\s+grade|grade\s+12)`;
const HIGH_SCHOOL_ABBREVIATED = new RegExp(
  String.raw`\bh\.?\s?s\.?\s+${HS_FACT}\b|\b${HS_FACT}\s+h\.?\s?s\.?(?!\w)`
  + String.raw`|\b${GRADE_TWELVE}\s+${HS_FACT}\b|\b${HS_FACT}\s+(?:of\s+|in\s+|at\s+)?${GRADE_TWELVE}\b`,
  'i',
);
/* The lookbehind is not decoration. In North American usage POST-secondary education is the
 * university, so `\bsecondary\s+education\b` matches inside "post-secondary education" and would
 * refuse the current-programme question it names. "Name of post-secondary institution" is a real
 * label shape, and it must still answer with the university. */

/* THE GRADUATION MATCHER KEEPS THE NARROW LITERAL. BOTH ARMS.
 *
 * Both arms pair the noun with a graduation word across a wide window - 200 characters one way,
 * 120 the other - and a window that wide is only safe while the noun cannot mean anything but the
 * applicant's own school. "High school" cannot. "Grade 12", "secondary education" and "prep
 * school" can: they are also the subject matter of a teaching job. Widening this matcher to the
 * full spelling list answered ordinary education-sector employment and credential questions with
 * her own graduation date, where main had answered nothing:
 *
 *   "grade 12 teaching - when did you stop?"               -> "May 2023"
 *   "secondary education teaching - when did you start?"   -> "May 2023"
 *   "do you have a secondary education teaching diploma?"  -> "Yes"
 *
 * A blank is recoverable; a date typed into an employment-history box is not. The wide spelling
 * list serves the refusal side only, where the cost of being wrong is a blocker rather than an
 * answer. The literal still covers "highschool" and "high-school", which is the spelling gap that
 * made sharing a noun worth doing in the first place. */
const HIGH_SCHOOL_LITERAL = String.raw`high\s+school`;
/* MAIN'S EXACT LITERAL, and it stays that way. Widening it to `high[\s-]?schools?` was worth one
 * label ("Highschool Graduation Year", which had been answering with the UNIVERSITY year) and cost
 * three, because this matcher runs before every other rule and reaches 120-200 characters:
 *
 *   "expected graduation date (not highschool)"      May 2028 -> May 2023
 *   "our high-school internship - when can you start?"  a refusal -> May 2023, in an availability box
 *   "in what year did you last work with high schools?" blank -> May 2023
 *
 * The one label it bought is not lost, only downgraded: "Highschool Graduation Year" now reaches
 * the refusal instead, which is a blocker rather than the university's May 2028. Better than main,
 * without touching anything main got right. */

export const HIGH_SCHOOL_GRADUATION_QUESTION = new RegExp(
  String.raw`\b${HIGH_SCHOOL_LITERAL}\b[\s\S]{0,200}\b(?:graduat\w*|diploma|ged|month\s+and\s+year|when)\b`
  + String.raw`|\b(?:graduat\w*|when|month|year)\b[\s\S]{0,120}\b${HIGH_SCHOOL_LITERAL}\b`,
  'i',
);

/* A HIGH SCHOOL IS NOT THE SCHOOL THE PROFILE HOLDS.
 *
 * FUTURE_OR_OTHER_PROGRAMME_QUESTION already states the rule pointing forward in time: school,
 * degree, major, gpa and every graduation key describe the programme the applicant is in NOW, so a
 * question scoped to a different one is not answered by them. High school is that same defect
 * pointing backward, and it was reachable on four separate paths. Measured against the owner's real
 * stored profile on 2026-08-11:
 *
 *   "High School Name"              -> "University of Southern California, Viterbi School of
 *                                       Engineering"   (the `school name` arm of classifyField)
 *   "High School GPA"               -> "3.89"          (the university GPA)
 *   "High School Degree"            -> "Bachelor of Science in Computer Science"
 *   "High School Graduation Year"   -> resolveKnownAnswer said "May 2023", correctly, and then
 *                                      profileFieldCandidates rebuilt the ladder from grad_year and
 *                                      chooseClosestOption picked "2028" off the option list - the
 *                                      UNIVERSITY year, selected as an exact match, on a
 *                                      high-school control.
 *
 * That last one is why this is a rule in classifyField and not only in resolveKnownAnswer: the
 * resolver was already right about it, and the wrong value came from the classifier's key being
 * handed to the alias ladder in profileFieldResolution. The same key also drives
 * portalSubmission's combobox chain. One label, three callers, one classification to fix.
 *
 * The one high-school fact on file is application_profile.high_school_grad_date, and
 * highSchoolGraduationAnswer answers from it at the top of resolveKnownAnswer, before this
 * function is ever consulted. Nothing on the profile holds a high school's NAME, city, GPA or
 * degree - there is no column for any of them - so those are refused rather than answered from the
 * university's.
 *
 * PRESENCE, AND THE CURRENT PROGRAMME IS AN ABSOLUTE VETO. The rule is two lines, and both were
 * arrived at by deleting cleverer ones that measured worse.
 *
 * Not adjacency. Requiring the fact word to sit next to the noun missed every phrasing that
 * separates them with punctuation, which is most of them: "GPA (high school)" -> "3.89", "High
 * School: Name" -> the university, "High school, city, state" -> the university. Chasing
 * separators is unbounded; presence is not.
 *
 * And not negation-attachment either, which is the harder lesson. Employers name a high school
 * most often in order to EXCLUDE it - "which university do you attend? do not list your high
 * school" - and refusing that gloss hands back the blank it was written to prevent. Three separate
 * attempts were made to read WHICH institution a negation governs, by proximity and then by
 * attachment, and every one of them shipped a fresh regression in the opposite direction:
 *
 *   proximity  -> "University GPA (do not enter high school GPA)" read the COLLEGE as excluded and
 *                 refused a control main answered "3.89"
 *   attachment -> "if you did not attend college, enter your high school" read the same way, and
 *                 blanked School, education-level and GPA controls across a whole ATS section
 *
 * Natural-language negation scope is not a thing a regex decides reliably, and each attempt bought
 * a handful of exotic labels at the price of a common one. So the veto is unconditional: if the
 * label names the current programme AT ALL, this rule stands down and behaviour is exactly what it
 * was before this change. That gives up "High School GPA (not college GPA)", which still answers
 * "3.89" as it always has - not a regression, just not a fix - and buys a property worth far more
 * than that label: the ONLY labels whose behaviour changes are those that name a high school and
 * name no current programme anywhere, and for those the university profile was never the answer.
 *
 * One more case needs no rule at all. "What city do you live in? (not the city of your high
 * school)" is not an education question, and classifyField's wrapper gates this on the KEY, so
 * address_city, phone, languages and availability_date are out of reach by construction.
 */
const CURRENT_PROGRAMME_WORD = String.raw`(?:universit(?:y|ies)|colleges?|undergrad\w*|bachelors?)`;
// Both boundaries. See HIGH_SCHOOL_ABBREVIATED for what an open-ended one cost.
const HIGH_SCHOOL_SPELLED_OUT = new RegExp(String.raw`\b${HIGH_SCHOOL_WORD}\b`, 'i');
function highSchoolPresent(label: string): boolean {
  return HIGH_SCHOOL_SPELLED_OUT.test(label) || HIGH_SCHOOL_ABBREVIATED.test(label);
}
const CURRENT_PROGRAMME_NAMED = new RegExp(String.raw`\b${CURRENT_PROGRAMME_WORD}\b`, 'i');

/* The veto is any OTHER institution noun, not only a college word, because the same glosses get
 * written with the generic one: "School name: please do not type your high school here", "Which
 * institution? Do not select your high school", "School attended (leave out your high school)".
 * All three are the university's control and main answers them correctly.
 *
 * The noun has to survive with the high-school phrase removed, or "high school" would veto itself.
 * The cost is the parenthetical clarifier - "School name (high school)" keeps answering with the
 * university, as it does on main - and that is the trade this whole rule is built on: a label that
 * names two institutions is one a regex should not adjudicate, and leaving it exactly as it was is
 * the only move that cannot make things worse. */
const ANOTHER_INSTITUTION_NOUN = /\b(?:schools?|institutions?|alma\s+mater)\b/i;
/* ANCHORED, like every other use of the noun. Unanchored, the strip ate "secondary school" out of
 * the MIDDLE of "postsecondary school" and destroyed the only institution noun in the label, so
 * "high school and postsecondary school names" lost its veto and was refused. */
const HIGH_SCHOOL_WORD_GLOBAL = new RegExp(String.raw`\b${HIGH_SCHOOL_WORD}\b`, 'gi');
function labelNamesAnotherInstitution(label: string): boolean {
  return ANOTHER_INSTITUTION_NOUN.test(label.replace(HIGH_SCHOOL_WORD_GLOBAL, ' '));
}

/* A condition that is not hers. "High school GPA if you are a freshman" asks a freshman for a
 * high-school GPA and everyone else for the university one, and she is not a freshman. Deliberately
 * narrow: a bare "if you" also opens "if you attended more than one high school, list the most
 * recent", which IS a high-school question. */
/* THE ONE EXCLUSION TEST THAT SURVIVED, and it survived because it never misfired. It reads only
 * the tight forward shape - a negation, an optional instruction verb, an optional article, then the
 * high-school noun - so it recognises "(not high school)" and "do not list your high school" while
 * leaving "do not ABBREVIATE your high school name" alone, that verb not being on the list. The
 * rules that had to go were the ones that widened this into a proximity window or mirrored it onto
 * the college side; nothing was ever wrong with reading a negation's immediate object. */
const HIGH_SCHOOL_NAMED_TO_EXCLUDE_IT = new RegExp(
  String.raw`(?:\b(?:not|no|never|exclud\w*|other\s+than|rather\s+than|instead\s+of|omit|leave\s+(?:out|off)|ignor\w*|skip|avoid|without|cannot|except|apart\s+from|aside\s+from)\b|\w{1,12}n['’]t)\s*`
  + String.raw`(?:(?:list|enter|include|use|report|give|provide|write|put|name|state|specify|submit|mention|type|select|choose|repeat|fill|accept|count|consider|qualif|permit)\w*\s+)?`
  + String.raw`(?:your\s+|the\s+|a\s+|an\s+|any\s+)?${HIGH_SCHOOL_WORD}\b`
  /* "Degree AFTER high school", "Education BEYOND high school". Not a negation, and it scopes the
   * question to the current programme just as plainly as one: the high school is the thing being
   * measured from, not the thing being asked for. Correct degree, major and GPA answers were
   * blocked without it. */
  + String.raw`|\b(?:after|since|beyond|post|following)\s+(?:your\s+|the\s+)?${HIGH_SCHOOL_WORD}\b`
  /* One passive form, kept deliberately narrow to a closed verb list rather than reopened into a
   * window: "high-school dates are not accepted" reads the exclusion backwards from every other
   * phrasing, and without it a university graduation control came back blank. */
  + String.raw`|${HIGH_SCHOOL_WORD}\b[^.?!]{0,30}?(?:\b(?:is|are|will\s+be|would\s+be|do|does|did)\s+not\b|\w{1,12}n['’]t|\bnot\b)\s*(?:be\s+)?`
  + String.raw`(?:accept\w*|requir\w*|need\w*|used|consider\w*|count\w*|qualif\w*|applicab\w*|permit\w*|relevant)`,
  'i',
);

/* The veto above is right about a label that MENTIONS a high school somewhere near a graduation
 * word, and wrong about one where the high school owns the graduation outright: "High school
 * graduation date (university date not needed)" is a high-school control however many institutions
 * it names, and standing down there returned a blank where main returned the stored date. Adjacency
 * decides it, and only here - the noun sitting directly on the graduation word, not merely in the
 * same sentence. */
/* Forms say "finish", "complete" and "leave" as readily as "graduate", and reading only the last
 * of those left the others vetoed: "In what year did you finish high school? Please also enter the
 * school name" fell through to the classifier and was answered with the UNIVERSITY'S NAME, while
 * the "graduate" spelling of the same sentence answered correctly. */
const SCHOOL_LEAVING_WORD = String.raw`graduat\w*|diploma|ged|finish\w*|complet\w*|left|leav\w*`;
const HIGH_SCHOOL_OWNS_THE_GRADUATION = new RegExp(
  String.raw`\b${HIGH_SCHOOL_LITERAL}\b[^.?!]{0,20}?(?:${SCHOOL_LEAVING_WORD})`
  + String.raw`|(?:${SCHOOL_LEAVING_WORD})[^.?!]{0,20}?\b${HIGH_SCHOOL_LITERAL}\b`,
  'i',
);

const CONDITIONAL_ON_BEING_A_SCHOOL_LEAVER =
  /\bif\s+you\s+(?:are|were)\b[^.?!]{0,40}?\b(?:freshman|first[\s-]year|high[\s-]?school\s+student|still\s+in\s+high[\s-]?school)\b|\bdoes\s+not\s+count\b|\bonly\s+if\s+you\s+(?:are|were)\b/i;

const EDUCATION_LEVEL_QUESTION =
  /\beducation\s+level\b|\blevel\s+of\s+education\b|\bhighest\s+(?:level|degree|qualification|education)\b/i;

/** Whether the label's subject is the applicant's HIGH SCHOOL rather than her current programme. */
export function questionIsScopedToHighSchool(label: string): boolean {
  const l = label ?? '';
  if (!highSchoolPresent(l)) return false;
  // The veto. Whatever the label is doing with the other institution - asking for it, excluding it,
  // listing it as an option - this rule does not touch it.
  if (CURRENT_PROGRAMME_NAMED.test(l) || labelNamesAnotherInstitution(l)) return false;
  // ...and the high school named as the negation's immediate object: "(not high school)".
  if (HIGH_SCHOOL_NAMED_TO_EXCLUDE_IT.test(l)) return false;
  if (CONDITIONAL_ON_BEING_A_SCHOOL_LEAVER.test(l)) return false;
  /* An education-LEVEL control names a high school as one option in a list, and the answer is the
   * current degree. This used to make an exception when a FACT looked attached to the noun, which
   * bought "level of education: high school GPA" and sold the commonest dropdown in ATS: the fact
   * test could not tell a level word ("high school diploma") or an incidental one ("if you attended
   * high school outside the U.S.") from a real one, and a Workday "Highest Level of Education"
   * became a blocker where main selected the right degree. The exception is gone; those labels are
   * left exactly as main had them, which is this rule's whole discipline. */
  return !EDUCATION_LEVEL_QUESTION.test(l);
}

/* Does the label ask for the high school's NAME? Distinct from the subject rule because the
 * graduation handler needs exactly this question and no wider one: a control asking for the name
 * as well as the year cannot be satisfied by the year. The first draft tested the bare word
 * `name`, which matched "please enter the NAME of the month and the year" - the Akuna wording the
 * graduation rule exists for - and refused a date that was on file. */
const HIGH_SCHOOL_NAME_REQUEST = new RegExp(
  String.raw`\b${HIGH_SCHOOL_WORD}(?:['’]s)?\s+names?\b|\bnames?\s+of\s+(?:your\s+|the\s+|my\s+)?${HIGH_SCHOOL_WORD}\b`,
  'i',
);

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
 * CORRECTED. This header used to read:
 *
 *   "Two categories, and only two, may ever be ticked by an automated submission, and each only
 *    from an explicit stored consent (application_profile.attest_truthful_information and
 *    accept_privacy_notices)."
 *
 * That stopped being true on 2026-08-09 and the header was not updated. be1bccf ("Harden reviewed
 * application answer safety", 10:06:38 +0400) deleted the `ap` parameter from
 * applicationConsentAnswer, narrowed its return type so it was structurally incapable of returning
 * a value, and removed privacyNoticesAccepted() with it. The function it describes lives 2,500
 * lines below this comment, so the two sat contradicting each other for three days and cost a
 * reviewer a full wrong diagnosis: reading this header, the live IMC refusal looks like a bug in
 * the plumbing, when it was main passing its own suite (questionDiscovery.test.ts pins the hold
 * with accept_privacy_notices set true).
 *
 * WHAT IS TRUE NOW. Nothing is ticked from those two application_profile booleans; they remain
 * readable for migration compatibility only, exactly as be1bccf left them. What may be ticked is
 * the CONSENT AND ACKNOWLEDGEMENT CLASS, from a standing permission on the users row
 * (automatic_consent_acceptance_*), which is a deliberate product reversal of be1bccf for that one
 * class and is argued where it is implemented, at isConsentAcknowledgementQuestion below.
 *
 * Everything else in this section is still named so it can be REFUSED by name rather than swept up
 * by a general consent rule, and that has not changed: a truthfulness certification, an exclusivity
 * commitment, a resume-format acknowledgement and every factual declaration are refused whatever
 * any permission says.
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

/* ---- the consent and acknowledgement class ----
 *
 * The one class of employer agreement Litos may accept in the applicant's name, and only under the
 * standing permission she grants once at onboarding (users.automatic_consent_acceptance_*). With no
 * permission on the row, every label below is held exactly as it is above, which is main's
 * behaviour and is the default for every account.
 *
 * WHAT THE LINE IS, and it is the whole of this feature. A CONSENT is the applicant granting
 * permission or agreeing to terms the employer wrote: its truth value does not depend on any fact
 * about her, so accepting one cannot make her say something false. A DECLARATION is a claim about
 * her - her right to work, her age, her degree, her record, her health, her service - and an
 * automatic "Yes" to one of those is R-004 again: a false legal statement sent to an employer under
 * her name. The two look alike on a form (both are usually a required checkbox worded as "I
 * confirm..."), which is why the separation here is structural rather than a list of phrases.
 *
 * THE GRAMMAR IS CLOSED, in the same shape as the sensitive-answer parsers above it, and it is
 * closed in BOTH directions:
 *
 *   1. HELD_DECLARATION_VOCABULARY runs first and vetoes unconditionally. Nothing after it can
 *      re-open a label it rejects, so no widening of the consent grammar can ever reach the held
 *      class - that is a property of the order, not of how carefully the alternatives below are
 *      written. It is deliberately over-broad: a consent it wrongly vetoes is held, which is what
 *      main does anyway, and holding is the failure this codebase is allowed to have.
 *   2. The consent side matches only a closed vocabulary of DOCUMENTS (privacy notice, data
 *      protection notice, applicant terms, code of conduct) and of DATA-HANDLING acts (processing,
 *      storing, transferring personal data; GDPR; retention for recruitment purposes). A label
 *      naming no such document and no such act is not a consent, whatever verb it uses. That is why
 *      "Do you consent to relocate?" is not merely vetoed, it never matches in the first place.
 *
 * Deliberately NOT here, and each is a decision rather than an omission:
 *   - background-check, drug-test and reference-contact authorizations. They grant permission, so
 *     they read like consents, but each licenses an act with factual and legal weight well past
 *     data handling. Held, and `authori[sz]e` is vetoed outright to keep the whole family out.
 *   - truth attestations ("I certify the information is true and complete"). Agreeing to a document
 *     is not swearing to a fact.
 *   - EEO and demographic self-identification, which has its own resolver and its own opt-out
 *     wording and is not touched by anything in this block.
 */

/* The employer's qualifier on a document name: "Candidate Privacy Notice", "Interview Code of
 * Conduct", "Job Applicant Privacy Policy". Closed, because the qualifier is the part a bare label
 * varies and the document noun is the part that must not vary. */
const CONSENT_DOCUMENT_QUALIFIER =
  String.raw`(?:job\s+)?(?:applicant|candidate|recruit(?:ment|ing)|interview|employee|employment|data|website|site|user|company|global|general|our|your|the|this)`;
/* The documents. A privacy or data-protection notice, in the spellings employers actually ship. */
/* LONGEST SPELLING FIRST, and this ordering is load-bearing rather than cosmetic. Alternation
 * returns the FIRST matching alternative, not the longest, and classifiedDocumentSpans matches
 * sticky from each position - so with the bare `privacy` alternative first, "Privacy and Cookies
 * Policy" matched only "privacy", left "Policy" uncovered, and held a spelling this pattern exists
 * to support. Any alternative that is a prefix of another must come after it. */
const PRIVACY_DOCUMENT =
  String.raw`privacy\s+and\s+cookies?\s+(?:policy|notice)|data\s+protection(?:\s+(?:policy|statement|notice))?|data\s+privacy(?:\s+(?:policy|statement|notice))?|notice\s+at\s+collection|privacy(?:\s+(?:policy|statement|notice|terms))?`;
const TERMS_DOCUMENT =
  String.raw`terms\s+(?:and|&)\s+conditions|terms\s+of\s+(?:use|service|application)|applicant\s+terms`;
const CONDUCT_DOCUMENT =
  String.raw`code\s+of\s+conduct|code\s+of\s+ethics|acceptable\s+use\s+policy|conduct\s+(?:agreement|policy|guidelines)`;
/* THE NOUN THE EMPLOYER USES FOR HER DATA, one spelling class for every data-handling alternative.
 *
 * "details" is here because of Teamtailor's PLATFORM-DEFAULT consent sentence, measured live on
 * 2026-08-20 on two unrelated tenants (Fully, Uproar by Moburst): "...confirm that <Company> store
 * my personal details to be able to process my job application." The vocabulary knew only personal
 * data and personal information, so a tenant wording that names no document at all classified as
 * nothing and every Teamtailor send parked one step from completion. The word is only ever read
 * inside the two-word phrase, so this widens no alternative beyond the exact spelling employers
 * ship, and the veto above it still runs first. */
const PERSONAL_DATA_NOUN = String.raw`personal\s+(?:data|information|details)`;
/* The acts, for the consents that name no document: what the employer proposes to do with her
 * personal data, and the legal regime it names while doing it. */
const DATA_HANDLING_SUBJECT = String.raw`process(?:ing)?\s+of\s+(?:my\s+|your\s+|the\s+)?${PERSONAL_DATA_NOUN}`
  + String.raw`|${PERSONAL_DATA_NOUN}\s+process(?:ing|ed)?`
  + String.raw`|(?:collect\w*|stor\w*|retain\w*|retention|transfer\w*|shar\w*|process\w*|us(?:e|ing))[\s\S]{0,80}\b${PERSONAL_DATA_NOUN}\b`
  + String.raw`|\b${PERSONAL_DATA_NOUN}\b[\s\S]{0,80}(?:collect\w*|stor\w*|retain\w*|retention|transfer\w*|shar\w*|process\w*)`
  + String.raw`|gdpr|general\s+data\s+protection\s+regulation`
  + String.raw`|recruit(?:ment|ing)\s+purposes`;
const CONSENT_SUBJECT = `${PRIVACY_DOCUMENT}|${TERMS_DOCUMENT}|${CONDUCT_DOCUMENT}|${DATA_HANDLING_SUBJECT}`;
/* THE SAME DOCUMENTS, MINUS THE TWO WIDE ALTERNATIVES, for coverage accounting only.
 *
 * DATA_HANDLING_SUBJECT's third and fourth alternatives put [\s\S]{0,80} between a handling verb and
 * "personal data", and eighty characters is room for a whole conduct document name. As a CLASSIFIER
 * that is right: the label really is a data-processing consent. As COVERAGE it is a hole, because
 * blanking the matched span also blanks whatever was smuggled inside it, which is exactly how
 * "consent to storing under the code of business conduct my personal data" survived three previous
 * rules. Every word those alternatives are built from - collecting, storing, personal, data - is
 * structural filler in its own right, so dropping them here costs nothing and closes the hole. */
const DOCUMENT_SPAN_SUBJECT = [
  PRIVACY_DOCUMENT,
  TERMS_DOCUMENT,
  CONDUCT_DOCUMENT,
  String.raw`process(?:ing)?\s+of\s+(?:my\s+|your\s+|the\s+)?${PERSONAL_DATA_NOUN}`,
  String.raw`${PERSONAL_DATA_NOUN}\s+process(?:ing|ed)?`,
  String.raw`gdpr|general\s+data\s+protection\s+regulation`,
  String.raw`recruit(?:ment|ing)\s+purposes`,
].join('|');
const DOCUMENT_SPAN_RE = new RegExp(DOCUMENT_SPAN_SUBJECT, 'i');
/* The act of accepting, closed. "authorize" is NOT on this list and never will be: see the block
 * header. Nor is any verb that asserts something ("declare", "certify", "warrant"). */
const CONSENT_ACT = String.raw`agree(?:s|d|ing)?|consent(?:s|ed|ing)?|accept(?:s|ed|ing)?|acknowledg\w*`
  + String.raw`|confirm(?:s|ed|ing)?|(?:have\s+)?read|understood|understand|review(?:s|ed|ing)?`
  + String.raw`|(?:tick|check)(?:ing)?\s+this\s+box|by\s+submitting`;

/* WHY THE DOCUMENT IS WORTH READING. Consent scaffolding, in the same sense as CONSENT_ACT above,
 * and accounted for in exactly the same place and for exactly the same reason.
 *
 * An employer may write the control as an INSTRUCTION rather than as an assertion, and then say
 * what the reader will find in the document. Jump Trading ships, verbatim and lowercased by the
 * resolver:
 *
 *   "review our notice at collection to learn how we will process your personal data."
 *
 * MEASURED on main at 89e9f17, on that exact string. The accepting verb is NOT what refuses it, and
 * the first diagnosis of this bug said it was: `review(?:s|ed|ing)?` is already in CONSENT_ACT,
 * CONSENT_ACKNOWLEDGEMENT_SENTENCE returns true, HELD_DECLARATION_VOCABULARY does not fire, and
 * "notice at collection" is already in PRIVACY_DOCUMENT. What refuses it is COVERAGE: once the
 * document span and its qualifier are blanked, `learn` and `how` are left over, neither is
 * structural filler, and one unexplained token is enough to hold. Truncate the label after
 * "collection" and it is accepted; the purpose clause alone is the difference.
 *
 * ACCOUNTED FOR AS A SPAN, NOT AS TWO MORE FILLER WORDS, and that is the whole of the safety
 * argument. `learn` and `how` are only scaffolding inside this construction - a comprehension verb
 * governed by `to`/`for`, optionally leading into a wh-word. Added to CONSENT_STRUCTURAL_FILLER they
 * would be absorbed anywhere in any label; matched here they are absorbed only where the label is
 * explaining why to read the document it just named. A missing phrasing costs a HOLD, which is the
 * direction this feature is allowed to fail in.
 *
 * IT CANNOT ABSORB A DOCUMENT. Every alternative is a closed-class function word or a comprehension
 * verb; no conduct-family head noun, and no document head noun, can appear inside a match. A
 * document name written after the clause survives as its own span and is still counted, so the
 * two-grant split at consentAcknowledgementLicence is untouched. Nothing here is added to the
 * classifying grammar: this string is used ONLY by consentLabelIsFullyAccountedFor, so it can widen
 * no label into a consent that was not already one, and the veto still runs first regardless. */
const CONSENT_PURPOSE_CLAUSE =
  String.raw`(?:to|for)\s+(?:learn|understand|see|find\s+out|read|review)(?:\s+more)?(?:\s+about)?`
  + String.raw`(?:\s+(?:how|what|why|when|whether|which))?`;

/* WHY THE DATA IS HANDLED, the second scaffolding construction, and the same safety argument as
 * CONSENT_PURPOSE_CLAUSE above word for word.
 *
 * Teamtailor's PLATFORM-DEFAULT consent sentence, measured live on 2026-08-20 on two unrelated
 * tenants (Fully, Uproar by Moburst), ends "...store my personal details to be able to process my
 * job application." Every word of that clause is already structural filler except one: "able".
 * Not a document name, not a fact about her, just the capability idiom English wraps a purpose in,
 * and one unexplained token is enough to hold, so the platform's own default wording parked every
 * Teamtailor send one step from completion.
 *
 * ACCOUNTED FOR AS A SPAN, NOT AS ONE MORE FILLER WORD. Added to CONSENT_STRUCTURAL_FILLER, "able"
 * would be absorbed anywhere in any label; matched here it is absorbed only inside the literal
 * three-word idiom. The span is a fixed phrase of closed-class words with no wildcard in it, so it
 * deliberately stays out of the wide [\s\S]{0,80} shape the DOCUMENT_SPAN_SUBJECT comment forbids:
 * nothing can be smuggled through a match that admits no variable content. Used ONLY by
 * consentLabelIsFullyAccountedFor, so it can widen no label into a consent that was not already
 * one, and the veto still runs first regardless. */
const CONSENT_CAPABILITY_CLAUSE = String.raw`be(?:ing)?\s+able\s+to`;

/* HOW THE HANDLING RELATES TO THE APPLICATION, the third scaffolding construction, and the same
 * safety argument as the two above word for word.
 *
 * Breezy's PLATFORM-DEFAULT consent sentence, measured live on 2026-08-20 on Transparent Hiring
 * (<tenant>.breezy.hr, the stock gdprAgreement checkbox), reads "...consent the processing of my
 * data as part of my job application." Bisected against the grammar: every word of that tail is
 * already structural filler except one, "part" - not a document name, not a fact about her, just
 * the idiom English uses to attach the handling to the application it serves - and one unexplained
 * token is enough to hold, so the platform's own default wording parked every consent-bearing
 * Breezy send one step from completion.
 *
 * ACCOUNTED FOR AS A SPAN, NOT AS ONE MORE FILLER WORD. Added to CONSENT_STRUCTURAL_FILLER, "part"
 * would be absorbed anywhere in any label ("part-time", "as part of the interview panel"); matched
 * here it is absorbed only inside the literal three-word idiom. The span is a fixed phrase of
 * closed-class words with no wildcard in it, so nothing can be smuggled through a match that
 * admits no variable content. Used ONLY by consentLabelIsFullyAccountedFor, so it can widen no
 * label into a consent that was not already one, and the veto still runs first regardless. */
const CONSENT_PART_OF_CLAUSE = String.raw`as\s+part\s+of`;

/**
 * A label that IS a consent document and nothing else: "Privacy Statement", "Interview Code of
 * Conduct", "Privacy Policy Acknowledgement", "Processing of Personal Data".
 *
 * Anchored at both ends on purpose. These are the labels the prose rule cannot see (no verb, no
 * sentence), and anchoring is what stops the same document noun inside a longer sentence from being
 * read as a bare acknowledgement when that sentence is asking something else entirely.
 */
export const BARE_CONSENT_ACKNOWLEDGEMENT = new RegExp(
  String.raw`^\s*(?:i\s+)?(?:${CONSENT_DOCUMENT_QUALIFIER}\s+){0,3}(?:${CONSENT_SUBJECT})`
  + String.raw`(?:\s+(?:acknowledgement|acknowledgment|consent|agreement|acceptance))?\s*[*:.]?\s*$`,
  'i',
);

/** A sentence whose act is one of the accepting verbs and whose object is one of the documents. */
export const CONSENT_ACKNOWLEDGEMENT_SENTENCE = new RegExp(
  String.raw`\b(?:${CONSENT_ACT})\b[\s\S]{0,200}\b(?:${CONSENT_SUBJECT})\b`
  + String.raw`|\b(?:${CONSENT_SUBJECT})\b[\s\S]{0,200}\b(?:${CONSENT_ACT})\b`,
  'i',
);

/**
 * THE VETO. Every vocabulary whose presence makes a label a claim about the applicant rather than
 * an agreement to a document, plus the families that are answered by their own resolver and must
 * not be disturbed.
 *
 * Runs before the consent grammar and cannot be overridden by it. Grouped by the harm rather than
 * alphabetically, and each group is here because answering it wrongly is a specific, named failure
 * this repo has already had or has already written a rule to prevent.
 */
const HELD_DECLARATION_VOCABULARY = new RegExp([
  // Legal status and the right to work. R-004's exact family.
  String.raw`\b(?:visa|immigration|sponsor\w*|work\s+permit|citizen(?:ship)?|nationality|passport|green\s+card|residency|authori[sz]ed\s+to\s+work|right\s+to\s+work|work\s+authori[sz]ation|employment\s+eligibility)\b`,
  /* ANY grant of authority. Litos accepts terms; it does not authorise an act. This is what holds
   * background-check, drug-test, credit-check and reference-contact authorizations as a family
   * rather than one phrasing at a time, and it is deliberately blunt: a data-processing consent
   * that happens to be worded "I authorize the processing of my personal data" is held too. */
  String.raw`\bauthori[sz](?:e|es|ed|ing|ation)\b`,
  // Age, including the 18+ attestation that has its own inverted-polarity resolver.
  String.raw`\b(?:18|eighteen|minor|date\s+of\s+birth|dob|age|how\s+old)\b`,
  // Education, completion and timing.
  String.raw`\b(?:degree|graduat\w*|enroll\w*|diploma|gpa|transcript|university|college|school|coursework|academic)\b`,
  // Criminal record and background screening.
  String.raw`\b(?:convict\w*|criminal|felony|misdemean\w*|guilty|arrest\w*|offen[cs]e|background|drug|screening|clearance|polygraph)\b|\bcredit\s+check\b`,
  // References, and verification of anything she has claimed.
  String.raw`\breferences?\b|\bverif(?:y|ies|ied|ication)\b|\bemployment\s+history\b`,
  // Health, disability, accommodation.
  String.raw`\b(?:health|medical|disab\w*|accommodat\w*|pregnan\w*|illness|injur\w*|vaccin\w*)\b`,
  // Military and veteran status.
  String.raw`\b(?:veteran|military|armed\s+forces|national\s+guard|reserv(?:e|ist))\b`,
  // EEO and demographic self-identification, which has its own resolver and its own opt-out.
  String.raw`\b(?:race|racial|ethnic\w*|hispanic|latino|gender|transgender|sexual\s+orientation|lgbtq\w*|sex|demographic|self[-\s]?identif\w*|religio\w*|marital|national\s+origin|genetic|caste|pronoun)\b`,
  // Truth attestations. Agreeing to a document is not swearing to a fact.
  String.raw`\b(?:certif\w*|attest\w*|swear|sworn|perjury|declare|declaration|warrant|true|truthful)\b|\bbest\s+of\s+my\s+knowledge\b`,
  // Restrictive covenants and obligations owed to another employer.
  String.raw`\bnon[-\s]?compet\w*|\bnon[-\s]?solicit\w*|\brestrictive\s+covenant|\bgarden\s+leave\b|\bconfidentiality\s+(?:agreement|obligation)`,
  // Statements to a government or a regulator.
  String.raw`\bexport\s+control\w*|\bitar\b|\bear99\b|\bsanction\w*|\bpolitically\s+exposed\b`,
  /* A FACT WEARING CONSENT WORDING. "Do you consent to relocate?" is the shape this group exists
   * for: an accepting verb over a subject that is a plan, a commitment or a preference. */
  String.raw`\brelocat\w*|\bwilling\s+to\b|\bcommit\s+to\b|\btop\s+preference\b|\bstart\s+date\b|\bsalary\b|\bcompensation\b|\bnotice\s+period\b|\bavailab\w*|\btravel\b|\bovertime\b|\bshift\b|\bon[-\s]?call\b`,
  // Never filled at all, here as well as in NEVER_FILL_PATTERNS.
  String.raw`\bsocial\s+security\b|\bssn\b|\bdriver'?s?\s*licen[sc]e\b|\bcaptcha\b|\brecord(?:ing|ed)\b`,
].join('|'), 'i');

/**
 * ONE SPELLING OF THE LABEL, decided here and nowhere else.
 *
 * The three callers hold the label in three different states: the pre-script has the stored
 * question text, resolveProfileField has already run normalizeDiscoveredLabel over it, and the
 * submission runner's consent trail has the raw discovered blob with the employer's `*` marker and
 * Greenhouse's `--0` handles still attached. Three spellings reaching one predicate is how a
 * control gets accepted on one path and held on another for no reason anybody can see.
 *
 * normalizeDiscoveredLabel is idempotent, so normalizing here is free for the caller that already
 * did it, and the fallback keeps a label that normalizes to nothing testable as its trimmed self.
 */
function consentLabelSpelling(label: string): string {
  return normalizeDiscoveredLabel(label ?? '') || (label ?? '').trim();
}

/** True when a label is a held factual declaration, whatever else it also looks like. */
export function isHeldDeclarationLabel(label: string): boolean {
  return HELD_DECLARATION_VOCABULARY.test(consentLabelSpelling(label));
}

/**
 * ONE TICK, TWO STATEMENTS: a label that welds an employer document to a claim about the applicant.
 *
 * MEASURED, on main, with no permission granted at all:
 *
 *   "I acknowledge the Privacy Statement and confirm I am legally authorized to work in the
 *    United States."                                 ->  "Yes"
 *
 * and the same from an option list reading ["I agree", "I do not agree"].
 *
 * The consent classifier is not what went wrong. HELD_DECLARATION_VOCABULARY vetoes this label
 * exactly as designed, so isConsentAcknowledgementQuestion refuses it and no consent permission is
 * ever consulted. The answer comes from the WORK-ELIGIBILITY branch, which sees a work-authorization
 * question it can answer truthfully from her stored declaration, answers it, and in doing so ticks a
 * control whose text also accepts the employer's Privacy Statement.
 *
 * So the veto held the consent path and the declaration path walked around it. Every rule in this
 * file that decides whether a document may be accepted is downstream of a branch that never asks the
 * question, which is why this cannot be fixed inside the consent grammar.
 *
 * THE HARM IS NOT THE VALUE. "Yes" is the true answer to the work-authorization half. It is the
 * other half that nobody decided: an acceptance of a named document, made in her name, produced by a
 * rule that was reasoning about her visa status. A standing permission she has not granted, or has
 * granted and is being held, is bypassed entirely.
 *
 * REFUSED WHOLE, and refused for BOTH halves, because there is one control and one tick. There is no
 * way to answer the work-authorization question here without also accepting the document, so the
 * only honest outcome is to hand the label back. It is a genuinely rare shape and the cost is one
 * question left for the applicant; the alternative is a document accepted by accident.
 *
 * NOT GATED on any permission, deliberately. This is answered today with nothing granted, so it is a
 * pre-existing hole rather than something the standing permission opened, and closing it only when a
 * permission exists would leave the ungranted case answering.
 */
export function weldsConsentToHeldDeclaration(label: string): boolean {
  const value = consentLabelSpelling(label);
  // Both halves required. A pure consent has no held vocabulary and is decided by the consent
  // grammar; a pure declaration has no document span and is decided by its own resolver. Neither
  // reaches here, which is what keeps this from becoming a second, blunter veto.
  if (!HELD_DECLARATION_VOCABULARY.test(value)) return false;
  return BARE_CONSENT_ACKNOWLEDGEMENT.test(value) || CONSENT_ACKNOWLEDGEMENT_SENTENCE.test(value);
}

/* WHICH DOCUMENT A CONSENT LABEL IS ABOUT, because the two are not one permission.
 *
 * A behavioural policy is not a privacy notice. CODE_OF_CONDUCT_ACKNOWLEDGEMENT's own comment says
 * why in the voice of the incident that produced it: IMC's "Interview Code of Conduct" was once
 * auto-answered "Yes" with nothing stored behind it, and that was judged wrong and corrected. A
 * privacy notice is the routine condition of applying at all; a code of conduct binds how she
 * behaves in a live interview. Licensing the second off a grant she gave for the first would be
 * that same reversion arriving by a tidier route, so they are separate permissions, separately
 * granted, separately revocable, and a label naming BOTH documents needs BOTH. */
const CONDUCT_DOCUMENT_RE = new RegExp(CONDUCT_DOCUMENT, 'i');
const PRIVACY_OR_TERMS_DOCUMENT_RE =
  new RegExp(`${PRIVACY_DOCUMENT}|${TERMS_DOCUMENT}|${DATA_HANDLING_SUBJECT}`, 'i');

export type ConsentAcknowledgementClass = 'privacy_and_terms' | 'conduct';

/* ---- COVERAGE COMPLETENESS: account for the whole label, or hold it ----
 *
 * THREE FRAMINGS FAILED BEFORE THIS ONE, all the same way. A head-noun list missed "expectations".
 * A coordination rule missed prepositional attachment ("in accordance with the conduct
 * expectations"), reversed order ("the conduct expectations and the privacy policy"), an intervening
 * word ("the privacy policy itself and the conduct expectations"), and a possessive determiner
 * heading the second document ("and my conduct expectations"), which walked straight through the
 * clause test. Every one of them tried to RECOGNISE the stray document, so every one of them was a
 * list of things to look for, and the next employer wording walked past it. A closed word class
 * guarantees the list will not need extending; it does not guarantee its members only appear in the
 * construction you had in mind.
 *
 * SO THIS DOES NOT LOOK FOR ANYTHING. It removes what the label has ACCOUNTED FOR - the document
 * spans the classifiers matched, any URL path they placed, the consent verbs, the qualifiers those
 * documents take - and asks whether any substantive token is left. If one is, the label is talking
 * about something this module cannot place, and it holds. It never has to know that "expectations",
 * "guidelines", "handbook" or "standards" are documents, because it never asks what the leftovers
 * are. Only whether there are any. That is fail-closed by construction rather than by enumeration:
 * a new employer wording cannot slip past a check that has nothing to slip past.
 *
 * IT ALSO CLOSES THE BARE-LABEL SMUGGLERS, which two previous rules missed for a subtle reason.
 * DATA_HANDLING_SUBJECT carries two [\s\S]{0,80} alternatives, so a single matched span can cover a
 * conduct document name sitting between "storing" and "personal data". Every span-based rule that
 * asked a question ABOUT the span therefore skipped them. This one blanks the span and reads what is
 * left, so a document name inside a match is not hidden by the match.
 *
 * THE COST IS THE OPPOSITE RISK, AND IT WAS MEASURED RATHER THAN ARGUED. Too much filler and the
 * check accounts for a stray document; too little and it holds ordinary consents. The corpus run and
 * its two numbers are in the PR body, where they will not go stale.
 *
 * THE FILLER IS CLOSED-CLASS PLUS CONSENT SCAFFOLDING, and the second half is the honest weak point.
 * Function words are closed by definition. The scaffolding is not: it is the vocabulary of consent
 * SENTENCES ("by submitting this application", "the information i have provided"), and a missing
 * entry costs a HOLD rather than an acceptance, which is the direction this feature is allowed to
 * fail in.
 *
 * WHAT KEEPS A STRAY DOCUMENT FROM BEING ABSORBED, stated exactly, because the obvious version of
 * this sentence is FALSE and was in this comment until review caught it. It is NOT true that no
 * filler entry is a document name: `notice`, `policy`, `statement`, `terms`, `conditions`,
 * `agreement`, `consent`, `receipt`, `copy` and `form` are all here, and every one of them names a
 * document in isolation, so "the privacy policy and the notice" is absorbed. Believing the false
 * version is how a maintainer talks themselves into adding one more head noun.
 *
 * The property that actually holds the boundary is narrower and is about ONE family:
 *
 *     NO CONDUCT-FAMILY HEAD NOUN IS IN THIS SET.
 *
 * code, codes, conduct, ethics, guidelines, handbook, standards, principles, expectations, rules,
 * charter, protocol, covenant, pledge, undertaking, declaration, manual, directive - none of them is
 * filler, so every conduct-shaped stray survives to be counted and holds the label. That is what
 * makes the two-grant split safe, and it is the only thing that does. Absorbing a PRIVACY-family
 * head is harmless by comparison: privacy and terms share one grant, so a stray absorbed there
 * cannot cross a permission boundary.
 *
 * consentBoundary.test.ts asserts that disjointness directly. Adding `handbook` or `guidelines` here
 * as scaffolding would open the conduct boundary silently, and that test is what stops it.
 */
/** Exported ONLY so consentBoundary.test.ts can assert the conduct-family disjointness above. */
export const CONSENT_STRUCTURAL_FILLER: ReadonlySet<string> = new Set([
  // Determiners and quantifiers.
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'my', 'your', 'our', 'its', 'their', 'his',
  'her', 'no', 'any', 'all', 'each', 'both', 'such', 'same', 'other', 'another', 'some',
  // Prepositions and conjunctions.
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'under', 'per', 'via', 'about', 'into',
  'upon', 'within', 'during', 'as', 'through', 'across', 'between', 'after', 'before', 'against',
  'and', 'or', 'plus', 'nor', 'but', 'if', 'when', 'while', 'so',
  // Pronouns and wh-words.
  'i', 'you', 'we', 'they', 'it', 'me', 'us', 'them', 'who', 'whom', 'whose', 'which', 'what',
  // Auxiliaries and copulas.
  'do', 'does', 'did', 'have', 'has', 'had', 'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  // Politeness and discourse scaffolding.
  'please', 'hereby', 'herein', 'hereto', 'below', 'above', 'following', 'further', 'also', 'then',
  'thereby', 'accordance', 'accordingly', 'here', 'yes',
  /* The vocabulary of APPLYING and of the data itself. Not document names: every one of these
   * describes the act the applicant is performing or the material she is handing over, which is
   * what a consent sentence is made of once its document name has been removed. */
  'application', 'applications', 'apply', 'applying', 'submitting', 'submission', 'submit',
  'box', 'checkbox', 'checking', 'ticking', 'selecting', 'clicking', 'signing', 'form',
  'information', 'info', 'data', 'details', 'personal', 'provided', 'provide', 'give', 'given',
  'processed', 'processing', 'process', 'stored', 'storing', 'store', 'storage', 'retained',
  'retaining', 'retention', 'collected', 'collecting', 'collection', 'used', 'using', 'use',
  'shared', 'sharing', 'share', 'transferred', 'transfer', 'held', 'keep', 'kept',
  'purposes', 'purpose', 'recruitment', 'recruiting', 'hiring', 'role', 'position',
  'job', 'jobs', 'vacancy', 'vacancies', 'opportunity', 'opportunities', 'company', 'employer',
  'candidate', 'candidates', 'applicant', 'applicants', 'receipt', 'copy', 'terms', 'conditions',
  'law', 'laws', 'legal', 'rights', 'notice', 'notices', 'policy', 'policies',
  /* DOCUMENT HEAD NOUNS, and putting them here is safe for a reason worth stating: a stray document
   * is identified by its MODIFIER, never by its head. "the insider trading policy" leaves "insider"
   * and "trading"; "the conduct expectations" leaves "conduct" and "expectations"; "the employee
   * handbook" leaves "handbook". Accounting for the head noun costs nothing and stops
   * "privacy policy agreement" from being held on its own suffix, which the bare grammar
   * explicitly supports. */
  'agreement', 'agreements', 'acknowledgement', 'acknowledgment', 'acknowledgements',
  'acknowledgments', 'acceptance', 'consent', 'consents', 'statement', 'statements',
  // The rest of the vocabulary of applying, added because real corpus labels needed it.
  'assessing', 'assess', 'candidacy', 'consideration', 'considered', 'evaluate', 'evaluating',
  'residents', 'resident', 'purposes',
]);
/* A token that carries meaning. Two letters or fewer cannot be a document name, and a bare number is
 * a year or a clause reference. Everything else has to be accounted for by something above. */
const SUBSTANTIVE_TOKEN = /^[a-z]{3,}$/;

/**
 * Every character range one of the classifying document patterns claims.
 *
 * STICKY, POSITION BY POSITION, rather than a global scan, because document names OVERLAP and a
 * global scan consumes the overlap. "the applicant terms and conditions" contains two matches of one
 * pattern that share the word "terms": a global scan matched `applicant terms`, resumed after it,
 * and could no longer match `terms and conditions`, leaving "conditions" unaccounted for and holding
 * a label that is a plain terms acknowledgement. Measured: it broke the terms positive on the first
 * run of this rule.
 *
 * Trying every start index yields the overlapping spans too. Labels are one sentence, so the cost
 * does not matter and the correctness does.
 */
function classifiedDocumentSpans(value: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const source of [DOCUMENT_SPAN_RE]) {
    const sticky = new RegExp(source.source, 'iy');
    for (let index = 0; index < value.length; index += 1) {
      sticky.lastIndex = index;
      const match = sticky.exec(value);
      if (match && match[0].length > 0) spans.push([index, index + match[0].length]);
    }
  }
  return spans;
}

/**
 * True when every substantive token in the label is accounted for.
 *
 * `spans` are the document ranges the classifiers matched, plus any URL path they placed. Those are
 * blanked out along with the consent verbs and the qualifiers a document name takes; what is left is
 * checked token by token against the structural filler. One unexplained token is enough to hold.
 */
function consentLabelIsFullyAccountedFor(
  value: string,
  spans: readonly [number, number][],
  employerContext: string | undefined,
): boolean {
  const chars = [...value.toLowerCase()];
  for (const [from, to] of spans) {
    for (let index = Math.max(0, from); index < to && index < chars.length; index += 1) chars[index] = ' ';
  }
  /* THE MODIFIER A DOCUMENT NAME CARRIES, absorbed one token to the LEFT of each span.
   *
   * Employers qualify their documents: "the BUSINESS conduct guidelines", "the CALIFORNIA privacy
   * notice", "the ACME privacy policy". The classifier matches the head of the name and leaves the
   * modifier stranded, so coverage held documents it had actually placed. English puts modifiers
   * before heads, which is why this is one token to the left and not to the right: absorbing to the
   * right would swallow "expectations" in "the code of conduct expectations", a document nobody
   * placed. Measured: this alone accounted for two of the three remaining false holds. */
  for (const [from] of spans) {
    const before = chars.slice(0, from).join('');
    const modifier = before.match(/([a-z][a-z-]*)\s*$/i);
    if (!modifier || typeof modifier.index !== 'number') continue;
    for (let index = modifier.index; index < modifier.index + modifier[1].length; index += 1) chars[index] = ' ';
  }
  let residue = chars.join('');
  /* The verbs that make it a consent, the clause saying why to read the document, and the qualifiers
   * a document name carries, are accounted for by the same grammar that matched the document.
   * Removed as spans rather than as words, so a multi-word act ("by submitting", "checking this
   * box") goes in one piece.
   *
   * CONSENT_PURPOSE_CLAUSE MUST COME BEFORE CONSENT_ACT, and the order is load-bearing rather than
   * cosmetic. The clause's own verb list contains `read` and `review`, which CONSENT_ACT also
   * matches; letting CONSENT_ACT run first would blank the verb out of "to read more about how" and
   * leave the clause unmatchable, stranding `how` exactly as before. */
  for (const source of [CONSENT_PURPOSE_CLAUSE, CONSENT_CAPABILITY_CLAUSE, CONSENT_PART_OF_CLAUSE, CONSENT_ACT, CONSENT_DOCUMENT_QUALIFIER]) {
    residue = residue.replace(new RegExp(String.raw`\b(?:${source})\b`, 'gi'), ' ');
  }
  /* A genitive is a determiner wearing a noun's clothes: "cloudflare's candidate privacy policy"
   * names the employer, not a second document. */
  residue = residue.replace(/\b[\w-]+['’]s\b/gi, ' ');
  /* THE EMPLOYER'S OWN NAME, which was the single largest cause of false holds when this rule was
   * measured: "i consent to acme collecting...", "do you consent to brex processing...", "faire
   * candidate privacy policy acknowledgment". A company name is an arbitrary proper noun, and the
   * labels arrive lowercased, so nothing in the text distinguishes "brex" from "expectations".
   *
   * It does not have to. The packet already knows who the employer is and already hands it to this
   * resolver, on the frozen `[LITOS FROZEN JOB EMPLOYER]` line that jobs like the prior-application
   * rule read for the same reason. Accounting for exactly that name is not a guess and not a list:
   * it is the one proper noun the caller can prove belongs here. When the caller passes no context,
   * nothing is accounted for and the label holds, which is the safe direction. */
  const employer = frozenJobEmployerFromContext(employerContext);
  if (employer) {
    for (const part of employer.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3)) {
      residue = residue.replace(new RegExp(String.raw`\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\b`, 'gi'), ' ');
    }
  }
  for (const token of residue.split(/[^a-z]+/i)) {
    const word = token.toLowerCase();
    if (!word || !SUBSTANTIVE_TOKEN.test(word)) continue;
    if (!CONSENT_STRUCTURAL_FILLER.has(word)) return false;
  }
  return true;
}

/* ---- the URL in a consent label ----
 *
 * A URL is USUALLY a pointer to the document the sentence already names, and blanking it is right:
 * "cloudflare.com/candidate-privacy-policy" is the Candidate Privacy Policy, and its hyphens stop
 * the privacy pattern from covering the "policy" inside it, so leaving it in place made a Cloudflare
 * positive look like a second, unplaceable document.
 *
 * BUT THAT IS A PREMISE, AND IT WAS NEVER CHECKED. A URL can name a DIFFERENT document from the
 * sentence, and blanking made it invisible: "I agree to the Privacy Policy at acme.com/code-of-conduct"
 * accepted on the privacy grant alone, with the conduct document erased before anything looked at it.
 *
 * So the path is READ rather than discarded. Its separators become spaces in place, preserving every
 * offset, and the scheme and host become spaces because they name no document. What is left is the
 * path as words, and the ordinary machinery then sees it: "candidate privacy policy" classifies as
 * privacy and changes nothing; "code of conduct" classifies as conduct and the label needs both
 * grants; "code of business conduct" classifies as nothing and holds.
 *
 * A path carrying digits or a query string is not a document name - "/apply?src=123" is routing, not
 * a policy - so those are blanked whole, which is what the old rule did to everything.
 */
/* Neither arm may swallow a closing parenthesis or trailing sentence punctuation. A label writes the
 * link in brackets - "(cloudflare.com/candidate-privacy-policy)" - and with `\S+` the captured URL
 * ended in ")", which fails the document-name shape test, so the path was blanked whole and the
 * premise check below never saw it. */
const CONSENT_LABEL_URL = /\bhttps?:\/\/[^\s,;)\]]+|\b[\w-]+\.(?:com|org|net|io|co|ai|gov|edu)\b[^\s,;)\]]*/gi;
const URL_PATH_IS_A_DOCUMENT_NAME = /^[a-z][a-z-]*(?:[/_-][a-z-]+)+$/i;

/**
 * The same string, same length, with URLs replaced by the words of their path (or by spaces), plus
 * the spans of the paths that were read.
 *
 * The spans are what makes the premise checkable. A linked document is not joined to the sentence by
 * a coordinator - "the Privacy Policy at acme.com/code-of-business-conduct" hangs off a preposition -
 * so the coordination rule cannot see it. Asking directly whether each path the label points at was
 * placed by some classifier can.
 */
function readableUrlPaths(value: string): { scanned: string; pathSpans: Array<[number, number]> } {
  const pathSpans: Array<[number, number]> = [];
  const scanned = value.replace(CONSENT_LABEL_URL, (match, offset: number) => {
    const blank = ' '.repeat(match.length);
    const slash = match.indexOf('/', match.startsWith('http') ? match.indexOf('//') + 2 : 0);
    if (slash === -1) return blank;
    const path = match.slice(slash + 1).replace(/\.(?:pdf|html?|aspx)$/i, '');
    if (!path || !URL_PATH_IS_A_DOCUMENT_NAME.test(path)) return blank;
    const words = path.replace(/[/_-]+/g, ' ');
    pathSpans.push([offset + slash + 1, offset + slash + 1 + words.length]);
    // Same length: the host becomes spaces, the path keeps its characters with separators spaced.
    return ' '.repeat(slash + 1) + words + ' '.repeat(match.length - slash - 1 - words.length);
  });
  return { scanned, pathSpans };
}

/**
 * The consent classes a label belongs to, or an empty list when it is not a consent at all.
 *
 * PURE GRAMMAR. It does not read any permission and does not decide whether anything is filled;
 * consentAcknowledgementLicence does that. Split so the boundary can be tested as the boundary,
 * independently of any account's settings.
 */
export function consentAcknowledgementClasses(
  label: string,
  /* The frozen job context the resolver is already handed. Only the employer line is read from it;
     omitting it accounts for no company name, which holds rather than accepts. */
  employerContext?: string,
): ConsentAcknowledgementClass[] {
  const value = consentLabelSpelling(label);
  if (!value) return [];
  if (HELD_DECLARATION_VOCABULARY.test(value)) return [];
  if (!BARE_CONSENT_ACKNOWLEDGEMENT.test(value) && !CONSENT_ACKNOWLEDGEMENT_SENTENCE.test(value)) return [];
  /* NO BARE-LABEL EXEMPTION, and the one that used to be here rested on a property the grammar does
   * not have. It claimed a BARE_CONSENT_ACKNOWLEDGEMENT label is "anchored end to end, so a second
   * document cannot fit inside it" - but DATA_HANDLING_SUBJECT carries two [\s\S]{0,80} alternatives,
   * and eighty characters comfortably holds a conduct document name inside a match that still
   * reaches both anchors. The English is awkward and the reachability is low, and a structural
   * argument resting on a false premise is exactly the kind of thing the next reader leans on. The
   * coordination rule needs no exemption: a bare document name contains no coordinator joining two
   * documents, so it simply does not fire. */
  const { scanned, pathSpans } = readableUrlPaths(value);
  const spans = classifiedDocumentSpans(scanned);
  if (!consentLabelIsFullyAccountedFor(scanned, spans, employerContext)) return [];
  /* A document-shaped link nothing could place. Same rule as the coordination one and a different
   * syntax: "the Privacy Policy at acme.com/code-of-business-conduct" names a second document
   * through a preposition, where no coordinator joins it to anything. */
  const placed = (from: number, to: number) => spans.some(([start, end]) => start < to && end > from);
  if (pathSpans.some(([from, to]) => !placed(from, to))) return [];
  const classes: ConsentAcknowledgementClass[] = [];
  if (PRIVACY_OR_TERMS_DOCUMENT_RE.test(scanned)) classes.push('privacy_and_terms');
  if (CONDUCT_DOCUMENT_RE.test(scanned)) classes.push('conduct');
  /* Reachable: a label whose only document name sat inside a routing URL matches the grammar and
   * classifies as nothing. No permission covers a consent with no class, so returning nothing
   * holds it. */
  return classes;
}

/** True when a label is a consent or acknowledgement, in either class. */
export function isConsentAcknowledgementQuestion(label: string, employerContext?: string): boolean {
  return consentAcknowledgementClasses(label, employerContext).length > 0;
}

/* ---- what an option WORDING means ----
 *
 * Used twice, and the second use is why they live here rather than beside chooseConsentOption:
 * picking the accepting option off a control's list, and deciding whether an answer already in a
 * packet is still an acceptance. Tested against comparableOption output, so apostrophes are gone
 * ("don't" reads "dont") and punctuation is spaces.
 */
/** An option that means "no". Tested FIRST everywhere, because "I do not agree" contains "agree". */
const CONSENT_REFUSING_OPTION =
  /\b(?:no|not|dont|doesnt|cant|cannot|wont|never|decline|declined|declining|disagree|disagreed|refuse|refused|deny|denied|reject|rejected|withhold|opt\s*out|unwilling|prefer\s+not)\b/;

/** An option that means "yes", as a WHOLE option and not as a word inside a longer sentence. */
const CONSENT_ACCEPTING_OPTION = new RegExp(
  String.raw`^(?:yes|y|true|on|checked`
  + String.raw`|(?:i\s+)?(?:agree|agreed|accept|accepted|consent|acknowledge|acknowledged|confirm|confirmed)`
  + String.raw`|(?:i\s+)?(?:have\s+)?read\s+and\s+(?:agree|agreed|accept|accepted|understood|understand|acknowledge|acknowledged)`
  + String.raw`|yes\s+i\s+(?:agree|accept|consent|acknowledge|confirm)`
  + String.raw`|(?:i\s+)?(?:agree|accept|consent|acknowledge|confirm)\s+to\s+(?:the\s+)?(?:above|terms|policy|notice|statement|conditions)`
  + String.raw`)$`,
);

/* WHAT JOINS TWO VERBS INTO ONE OPTION LABEL. A slash, an ampersand, a plus, a comma, or the two
 * coordinators English writes them out with.
 *
 * The slash is the reason this list exists at all and the reason it is applied HERE rather than in
 * comparableOption. comparableOption deliberately keeps '/' (its character class is
 * [^a-z0-9.+/]), and that is load-bearing well outside consent: Greenhouse's standard graduation
 * term list offers "Spring/Summer 2028", and optionCoversMonthYear reaches that entry's year
 * across the slash. Splitting on it globally would take the season run apart. Splitting on it only
 * while asking "is this option nothing but accepting verbs" costs nothing anywhere else.
 *
 * '&' AND ',' ARE IN THIS CLASS AND CANNOT FIRE, which is worth writing down rather than leaving
 * for the next reader to discover. comparableOption runs first and turns every character outside
 * [a-z0-9.+/] into a space, so "Acknowledge & Confirm" arrives here as "acknowledge confirm" with
 * no joiner left in it and is handed back to the applicant. They are kept because they say what
 * this rule means, and because a future comparableOption that preserves them would then be right
 * by default rather than silently unhandled. Splitting on whitespace as well was rejected:
 * CONSENT_ACCEPTING_OPTION admits an optional "i " prefix, so "i acknowledge i confirm" would
 * split into a bare "i", and the rule would be no more complete while being far easier to widen by
 * accident.
 */
const CONSENT_COMPOUND_JOINER = /[/&+,]|\band\b|\bor\b/;

/**
 * AN OPTION THAT IS TWO ACCEPTING VERBS IS STILL ONE ACCEPTANCE.
 *
 * CONSENT_ACCEPTING_OPTION is anchored end to end over SINGLE verbs, which is the property that
 * stops "I do not agree" and "please read and agree before continuing" from reading as
 * acceptances. Greenhouse renders consent checkboxes whose only option label is the compound
 * "Acknowledge/Confirm", and that matches neither alternative: it is not "acknowledge" and it is
 * not "confirm". Measured through the call the resolver makes,
 * chooseConsentOption(["Acknowledge/Confirm"]) returned null, so resolveProfileField reported
 * matchedOption: false and routes/submissionRunner.ts announced a consent Litos had every
 * permission to accept as one handed back to the applicant to finish by hand.
 *
 * So an option also accepts when it is composed ENTIRELY of accepting verbs joined by punctuation
 * or a coordinator. Every part must satisfy the same single-verb vocabulary, which is what keeps
 * this from being a loosening: "Accept and Continue" still fails, because "continue" is not an
 * accepting verb, and anything carrying a refusing token fails before it is ever split, because
 * isConsentAcceptingWording tests CONSENT_REFUSING_OPTION over the whole key first and this tests
 * it again over every part.
 *
 * TWO PARTS MINIMUM, so a key with no joiner in it cannot get a second, differently spelled attempt
 * at the same regex it has already failed.
 */
function consentAcceptingCompound(key: string): boolean {
  const parts = key.split(CONSENT_COMPOUND_JOINER).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  return parts.every((part) => !CONSENT_REFUSING_OPTION.test(part) && CONSENT_ACCEPTING_OPTION.test(part));
}

export function isConsentRefusingWording(value: string): boolean {
  return CONSENT_REFUSING_OPTION.test(comparableOption(value ?? ''));
}

export function isConsentAcceptingWording(value: string): boolean {
  const key = comparableOption(value ?? '');
  if (!key || CONSENT_REFUSING_OPTION.test(key)) return false;
  /* THE WHOLE KEY IS ASKED FIRST, and the order is not cosmetic. "read and agree" is a single
   * accepting phrase that CONSENT_ACCEPTING_OPTION already spells out, and splitting it on "and"
   * yields "read", which is not an accepting verb on its own. Asking the compound rule first would
   * therefore stop recognising a wording this vocabulary has always recognised. */
  if (CONSENT_ACCEPTING_OPTION.test(key)) return true;
  return consentAcceptingCompound(key);
}

/** What Litos puts in a consent control when it accepts. Snapped onto the control's own option list
 *  by chooseConsentOption (lib/profileFieldResolution.ts) whenever the control has one. */
export const CONSENT_ACCEPTANCE_VALUE = 'Yes';

/** The grant, or grants, that licensed one acceptance. What the packet records. */
export type ConsentAcknowledgementLicence = { granted_at?: string; version: string };

/**
 * The permission covering every class this label belongs to, or null.
 *
 * ALL classes, not any: a label naming both a privacy notice and a code of conduct is licensed only
 * by an applicant who granted both, and is held by one who granted either alone. The combined
 * record is what the packet stores, so `granted_at` is the LATER of the grants, which is the moment
 * the acceptance actually became licensed, and `version` names every set of words she was shown.
 *
 * Null for everything else - no permission, wrong class, vetoed label - so the caller falls through
 * to the refusals that are already there and nothing about main's behaviour changes for an account
 * that has not granted this.
 */
export function consentAcknowledgementLicence(
  label: string,
  ap: ApplicationProfileLike,
  employerContext?: string,
): ConsentAcknowledgementLicence | null {
  const classes = consentAcknowledgementClasses(label, employerContext);
  if (classes.length === 0) return null;
  const grants = classes.map((klass) => (klass === 'conduct'
    ? ap.conduct_acknowledgement_permission
    : ap.consent_acknowledgement_permission));
  if (grants.some((grant) => !grant)) return null;
  const held = grants as ConsentAcknowledgementLicence[];
  /* NAMED BY CLASS, NOT BY VERSION STRING ALONE. Both permissions currently carry the same date, so
   * deduping on the version collapsed a two-grant acceptance to one indistinguishable string and the
   * packet could not say which permissions were used. Pairing each version with the class it belongs
   * to keeps both visible whether or not their wordings ever diverge. */
  const versions = classes.map((klass, index) => `${klass}@${held[index].version}`);
  const dates = held.map((grant) => grant.granted_at).filter((at): at is string => !!at);
  return {
    version: versions.join(' + '),
    // Undefined only when no grant carried a timestamp, which the loader does not produce for a
    // granted permission. Left optional rather than invented.
    ...(dates.length === held.length && dates.length > 0
      ? { granted_at: dates.reduce((latest, at) => (at > latest ? at : latest)) }
      : {}),
  };
}

/** The consent answer, or null. One gate, shared by the resolver, the option matcher and the
 *  pre-script, so the three cannot disagree about whether a control may be accepted. */
export function consentAcknowledgementAnswer(
  label: string,
  ap: ApplicationProfileLike,
  employerContext?: string,
): { value: string } | null {
  return consentAcknowledgementLicence(label, ap, employerContext) ? { value: CONSENT_ACCEPTANCE_VALUE } : null;
}

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
/* The attributes of a school that KEYWORD_SUBJECT_QUALIFIER does not name.
 *
 * That list was written for the bare-keyword path and covers email, address, dates, scores and
 * grades. It has no word for the two that the "select your ... school" phrasing actually collides
 * with, both caught in review: "select your college MAJOR" and "select your current school
 * LOCATION" were classified as school, which fills a major dropdown and a location field with the
 * university's name. Kept separate from KEYWORD_SUBJECT_QUALIFIER rather than appended to it,
 * because widening the shared list changes every bare-keyword decision in this file and these two
 * words are only ambiguous next to a school noun. */
const SCHOOL_ATTRIBUTE_QUALIFIER =
  /\bmajors?\b|\bminors?\b|\bdisciplines?\b|\bfields?\s+of\s+study\b|\bdegrees?\b|\bprograms?\b|\blocations?\b|\bcit(?:y|ies)\b|\bstates?\b|\bcountr(?:y|ies)\b/i;
const PHONE_NOUN = /\b(phone|mobile)\b/i;
/* A label that ASKS FOR a phone number, however much captured junk surrounds the ask. No word
 * budget on purpose: the label this exists for is teamtailor's, which welds the placeholder and
 * the control's name attributes into the captured text ("phone phone number with country code
 * +1 201-555-0123 candidate[phone] candidate_phone"), and a budget refuses exactly the labels that
 * need this rule most. The guards that make a bare keyword safe live at the one call site. */
const PHONE_NUMBER_FIELD_QUESTION =
  /\b(?:phone|mobile|cell(?:ular)?|telephone)\b[^?]{0,30}\bnumbers?\b|\bnumbers?\b[^?]{0,15}\b(?:phone|mobile|cell(?:ular)?|telephone)\b/i;
/* A sentence that MENTIONS the number without asking for it. "I agree to receive SMS text
 * messages at the phone number provided" is a consent, and typing her phone into it accepts a
 * subscription she never chose. */
const PHONE_NUMBER_CONSENT_MENTION =
  /\b(?:agree|consent|authoriz\w*|permission|opt[\s-]?in|receive|subscribe|notif\w*|alerts?|messages?|sms|texts?)\b/i;
/* Someone else's number is never answered with hers. */
const SOMEONE_ELSES_PHONE_NUMBER =
  /\bemergency\b|\breferences?\b|\brecruiters?\b|\bsupervisors?\b|\bmanagers?\b|\bemployers?\b|\bcontact\s+person\b|\bnext\s+of\s+kin\b/i;
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
  const key = classifyFieldIntent(label, type);
  /* THE CURRENT PROGRAMME CANNOT ANSWER A QUESTION ABOUT THE HIGH SCHOOL.
   *
   * Gated on the KEY, not on where the rule sits in the chain below. The first draft was an early
   * `return null` partway down that chain, and it silently took the arms underneath it with it:
   * "What city do you live in? (not the city of your high school)" stopped classifying as
   * address_city, and languages, phone and availability_date sat below it too. Reading the key
   * makes the blast radius exactly the education facts and nothing else, by construction rather
   * than by placement - the same shape as the CURRENT_PROGRAMME_KEYS gate resolveKnownAnswer
   * already applies to a FUTURE programme. See questionIsScopedToHighSchool for the measured wrong
   * answers on both sides of this. */
  if (key && CURRENT_PROGRAMME_KEYS.has(key) && questionIsScopedToHighSchool(label ?? '')) return null;
  return key;
}

function classifyFieldIntent(label: string, type?: string): ProfileKey | null {
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
  /* A LABEL THAT ASKS FOR A PHONE NUMBER IS THE PHONE FIELD, whatever type the caller knows about.
   *
   * The escape above only fires for callers that saw the live control. refreshKnownQuestionAnswers
   * and knownAnswerLookup hardcode 'text' - their contract is "answer what the refresh will
   * serve" - so a phone label that a broad rule can claim gets resolved DIFFERENTLY by the packet
   * audit's constructor and by the run. That divergence is not merely a wrong answer, it is a
   * packet_stale deadlock: the audit acknowledges one value, the fill persists the other, and the
   * send gate compares across the flip forever, with no re-audit able to clear it because each
   * side keeps recomputing its own value. Measured live on 2026-08-20 (Fully 6ba8fe3a, Moburst
   * 0e42235f): teamtailor's captured label embeds the placeholder "phone number with country code
   * +1 201-555-0123", RESIDENCE_QUESTION's bare \bcountry\b matched inside "country code", and
   * every teamtailor send was refused packet_stale while greenhouse, whose labels carry no
   * placeholder text, sailed through the identical audit-acknowledge-send sequence.
   *
   * Three guards keep this off labels that only MENTION a number: a consent sentence is not
   * asking for it, a polar question asks about the phone rather than for it, and someone else's
   * number - an emergency contact, a reference - must never be answered with hers. */
  if (
    PHONE_NUMBER_FIELD_QUESTION.test(l)
    && !isPolarQuestion(l)
    && !PHONE_NUMBER_CONSENT_MENTION.test(l)
    && !SOMEONE_ELSES_PHONE_NUMBER.test(l)
  ) return 'phone';

  const locationCommitment = isLocationCommitmentQuestion(l);
  const locationChoice = isLocationChoiceQuestion(l);

  if (CITIZENSHIP_QUESTION.test(l)) return 'citizenship';
  if (!locationCommitment && !locationChoice && RESIDENCE_QUESTION.test(l)) return 'address_country';

  const referral = parseReferralQuestion(l);
  if (referral?.valid) return 'referral_source_default';
  if (referral) return null;
  if (parseRelocationQuestion(l)) return null;
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
  /* "please select your current school from the list below" (Jump Trading, 2 postings, 2026-08-13).
   *
   * Nine words, so the bare-keyword path at the bottom of this function refuses it on the
   * six-word field-name budget, and it says "select ... school" rather than any of the phrasings
   * above, so nothing claimed it and the school never reached the form. The value was on the
   * profile the whole time.
   *
   * Tight on purpose: the SELECT VERB has to sit beside the school noun. That is what keeps it off
   * "which of these schools have you heard of", off ANOTHER_INSTITUTION_NOUN's transfer questions,
   * and off anything asking the applicant to choose between schools rather than to name her own.
   * "your" and "current" are optional because the corpus writes both "select your current school"
   * and the bare "select school". */
  if (/\bselect\s+(?:your\s+)?(?:current\s+)?(?:school|university|college|institution)\b/i.test(l)
    /* THE QUALIFIER GUARD, and this pattern is NOT allowed to skip it.
     *
     * The first version of this rule returned here unconditionally and regressed five labels in
     * review, every one of them asking for something ABOUT the school rather than for the school:
     *
     *   "please select your university email address"   -> school   (an email field)
     *   "select your current school location"           -> school   (a location field)
     *   "select your college major"                     -> school   (a major field)
     *   "select your university start date"             -> school   (a date field)
     *
     * That is the harm the FIELD_NAME_LABEL_MAX_WORDS note already records verbatim: "please
     * provide your university email address" was once answered with the university's NAME.
     * KEYWORD_SUBJECT_QUALIFIER exists to stop it and labelNamesProfileField applies it, but an
     * explicit pattern that returns early never reaches that code. So it is applied here, the same
     * way and against the same list, with the school noun removed first so the noun cannot mask a
     * qualifier sitting beside it. */
    && !KEYWORD_SUBJECT_QUALIFIER.test(l.replace(SCHOOL_NOUN, ' '))
    && !SCHOOL_ATTRIBUTE_QUALIFIER.test(l.replace(SCHOOL_NOUN, ' '))) return 'school';
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

/* A text control whose label IS the cover letter, not a sentence that happens to mention one.
 *
 * Measured live on Quandela (Workable, 2026-08-20): a required textarea labelled "Cover letter"
 * parked the run with '"Cover letter" is required and is still empty' while the SAME product's
 * attachment path writes and attaches a letter even when the control is optional. This matcher is
 * what lets the resolution loop hand that textarea the letter Litos already has.
 *
 * Deliberately exact-match after stripping decoration, never a substring test. "Cover the cost of
 * relocation", "letter grade", "recommendation letter" and "why is a cover letter important to
 * you?" must never match: the first two would type a whole letter into an unrelated field, and the
 * last is a real essay prompt that belongs to the drafter. The whole label, minus asterisks,
 * punctuation and an (optional)/(required) marker, has to BE one of the known cover-letter names.
 * JazzHR ("resumator-coverletter-value") and Breezy also take the letter as TEXT, so this is the
 * shared-discovery-path fix for those families too, not a Workable special case. */
const COVER_LETTER_TEXT_LABEL =
  /^(?:cover\s+letter|motivation\s+letter|letter\s+of\s+motivation|anschreiben)$/i;

export function isCoverLetterTextQuestion(label: string): boolean {
  const stripped = (label ?? '')
    .replace(/\((?:optional|required)\)/gi, ' ')
    .replace(/[*:;,.!?"'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return COVER_LETTER_TEXT_LABEL.test(stripped);
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
const GRADUATION_ISO_MONTH_RE = /\b((?:19|20)\d{2})-(\d{2})(?:-(\d{2}))?\b/g;
const GRADUATION_MONTH_DAY_YEAR_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[^0-9]{0,4}(\d{1,2})(?:st|nd|rd|th)?[^0-9]{0,4}\b((?:19|20)\d{2})\b/gi;
const GRADUATION_MONTH_YEAR_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b[^0-9]{0,20}\b((?:19|20)\d{2})\b/gi;

function canonicalGraduationDay(year: string, month: string, day = '01'): string | null {
  const paddedMonth = month.padStart(2, '0');
  const paddedDay = day.padStart(2, '0');
  const candidate = `${year}-${paddedMonth}-${paddedDay}`;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.getUTCFullYear() === Number(year)
    && parsed.getUTCMonth() + 1 === Number(paddedMonth)
    && parsed.getUTCDate() === Number(paddedDay)
    ? candidate
    : null;
}

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
  if (iso) return canonicalGraduationDay(iso[1], iso[2], iso[3] ?? '01');
  const exactMatches = [...text.matchAll(GRADUATION_MONTH_DAY_YEAR_RE)];
  const exact = exactMatches.find((match) => match[3] === preferredYear) ?? exactMatches.at(-1);
  if (exact) {
    const month = MONTH_TO_NUMBER[exact[1].toLowerCase()];
    if (month) return canonicalGraduationDay(exact[3], month, exact[2]);
  }
  const monthYearMatches = [...text.matchAll(GRADUATION_MONTH_YEAR_RE)];
  const monthYear = monthYearMatches.find((match) => match[2] === preferredYear) ?? monthYearMatches.at(-1);
  if (monthYear) return canonicalGraduationDay(monthYear[2], MONTH_TO_NUMBER[monthYear[1].toLowerCase()]);
  const year = preferredYear ?? text.match(/\b(?:19|20)\d{2}\b/g)?.at(-1) ?? '';
  if (!year) return null;
  const monthToken = text.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i)?.[0].toLowerCase();
  const month = monthToken ? MONTH_TO_NUMBER[monthToken] : '05';
  return canonicalGraduationDay(year, month);
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
  { value: 'SQL', patterns: [/\bsql\b/i] },
];

function normalizedStoredSkills(ap: ApplicationProfileLike): string[] {
  return (Array.isArray(ap.skills) ? ap.skills : [])
    .map((skill) => skill.trim())
    .filter(Boolean);
}

/* EVERY ALIAS HER STORED SKILLS MATCH, in table order, comma-joined per profileFieldResolution's
 * own contract for a checkbox multi-select ("the comma-joined sequence of ... texts to check").
 * Table order rather than stored-skill order so the same profile always answers identically
 * regardless of how she ordered her own skills list. */
function programmingLanguageProficiencyAnswer(ap: ApplicationProfileLike): { value: string } | null {
  const stored = normalizedStoredSkills(ap);
  if (stored.length === 0) return null;
  const joined = stored.join(' ');
  const matched = PROGRAMMING_LANGUAGE_ALIASES
    .filter((item) => item.patterns.some((pattern) => pattern.test(joined)))
    .map((item) => item.value);
  return matched.length > 0 ? { value: matched.join(', ') } : null;
}

function programmingLanguageAnswer(label: string, ap: ApplicationProfileLike): { value: string } | null {
  // Checked first: "programming languages ... proficient in" would also satisfy the interview-
  // preference pattern below on some phrasings, and a skills checklist must never collapse to the
  // single language an interview-preference question would have chosen.
  if (PROGRAMMING_LANGUAGE_PROFICIENCY_QUESTION.test(label)) {
    return programmingLanguageProficiencyAnswer(ap);
  }
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
  /**
   * The ARIA role when the DOM control's HTML input type is not its interaction type.
   * Greenhouse React-selects are the important case: they are text inputs with role="combobox".
   * Keeping both prevents a visible typed value from being mistaken for a committed selection.
   */
  role?: string | null;
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

/* The subjects that make an email control a DIFFERENT address from the one on the packet. Read only
 * by isCoreIdentityField below; see the rationale there. Deliberately institutions and third parties
 * rather than a general modifier test: "personal email" and "contact email" are still hers, still
 * filled by the fixed-field pass, and must stay out of the applicant's question list. */
const NON_APPLICANT_EMAIL_SUBJECT =
  /\b(?:universit(?:y|ies)|college|school|campus|academic|student|institution(?:al)?|faculty|professor|advisor|adviser|supervisor|manager|employer|company|work|business|reference|referee|recommender|parent|guardian|emergency|spouse|colleague|friend)\b/i;

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
 *
 * AND SO IS AN EMAIL THAT IS NOT THAT ONE. The claim above is about a SINGLE control - the address
 * the packet carries, typed by a hardcoded per-portal selector (lib/portalSubmission.ts) - and the
 * bare `email` test claimed every email control on the form instead. IMC asks "Please provide your
 * university email address." as a required field. It matched, so postingQuestionsFromDiscovered
 * dropped it from the stored inventory before anything could ask about it
 * (lib/postingQuestions.ts), and the runner's `discoveredFieldIsRequired(field) &&
 * !isCoreIdentityField(label)` forced it non-required so no question record was manufactured either
 * (routes/submissionRunner.ts) - while no fixed-field selector fills anything but the identity
 * control. On 2026-08-12 that was measured end to end: zero email-labelled rows in the whole
 * posting_questions table, the portal refusing the form, and the packet reporting "1 required field
 * has no question you can answer in Litos". The predicate suppressed a question on the strength of a
 * fill that structurally could not happen.
 *
 * A SUBJECT beside the noun is what says the address belongs to someone or something other than the
 * applicant-as-account-holder. "Email", "Email address", "Confirm email address" carry none and are
 * still core identity, which is the whole point of the predicate and is unchanged.
 */
export function isCoreIdentityField(label: string): boolean {
  const l = (label ?? '').toLowerCase();
  if (!l) return false;
  if (/\b(?:legal|preferred|maiden|previous|former|nick)\b/.test(l)) return false;
  if (/\b(?:first|last|given|family|sur|full)\s*name\b|^name\b|\bname\s*\*/.test(l)) return true;
  return /\be-?mail\b/.test(l) && !NON_APPLICANT_EMAIL_SUBJECT.test(l);
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
/* Lever's custom-question handle: name="cards[<uuid>][field0]". Same family as the Greenhouse
 * section handles above, same damage. Discovery concatenates `name` onto the visible label, the
 * uuid strip turns the middle bracket into "[ ]" and EMPTY_BRACKET_HANDLE_RE clears it, and what
 * survives into the stored question is "cards [field0]". Measured on the owner's 11 Palantir
 * packets of 2026-08-11, which stored questions literally titled "cards [field0]",
 * "yes cards [field0]" and "english (eng) cards [field0]".
 *
 * Stripping it does two things. A question that had real label text keeps only that text, so the
 * `label:has-text(...)` scope can match the employer's own label. A row that had NO label text
 * beyond the handle normalizes to the empty string and is dropped by the callers that already drop
 * empty labels, which is right: "cards [field0]" names a field, tells the applicant nothing, and
 * cannot be answered by anyone. */
const LEVER_CARD_HANDLE_RE = /\bcards\s*\[\s*field\d+\s*\]/gi;
const TRAILING_ANSWER_PLACEHOLDER_RE = /\s+(?:type|enter|write)\s+(?:your\s+)?(?:answer\s+)?here(?:\.{3}|…)?\s*$/i;

/* EVERY POSITIVELY IDENTIFIED PROVIDER HANDLE, in one list and in strip order.
 *
 * The list is the definition of "this string is a machine handle, not a question", and it is now
 * read in two places: normalizeDiscoveredLabel below, and the page script's own handle test (see
 * PROVIDER_HANDLE_ONLY_SCRIPT). Those two have to agree exactly - the whole safety argument for the
 * page script's fall-through is that a string it calls handle-only is a string this module would
 * have normalized to '' and dropped - so there is one array rather than two copies of six regexes.
 *
 * Order is load-bearing: INLINE_UUID_RE has to run before EMPTY_BRACKET_HANDLE_RE, because clearing
 * the uuid out of `cards[<uuid>][field0]` is what leaves the bare `[ ]` for it to remove. */
const PROVIDER_HANDLE_STRIPPERS: readonly RegExp[] = [
  INLINE_UUID_RE,
  GREENHOUSE_QUESTION_HANDLE_RE,
  GREENHOUSE_SECTION_HANDLE_RE,
  EMPTY_BRACKET_HANDLE_RE,
  LEVER_CARD_HANDLE_RE,
  GREENHOUSE_TRAILING_NUMERIC_HANDLE_RE,
];

function stripProviderHandles(raw: string): string {
  return PROVIDER_HANDLE_STRIPPERS.reduce((value, handle) => value.replace(handle, ' '), raw ?? '');
}

/**
 * NOTHING BUT A PROVIDER HANDLE: every letter in this string belongs to a handle this module can
 * name, so removing them all leaves no word a person wrote.
 *
 * The one test the page script's questionLabel is allowed to fall through on, and deliberately the
 * same test as "normalizeDiscoveredLabel would return '' for this": a string with no letters left
 * after the strip is empty or punctuation, tidyLabel cannot rescue it, and isOpaqueIdentifier
 * rejects anything with no `\p{L}` outright. So a field this returns true for is a field whose
 * label is discarded today, and recovering it can only add a question, never rename one.
 *
 * `\p{L}` and not `[a-z]`: a Japanese or Arabic label is a label. Empty is handle-only by the same
 * reading (there is nothing a person wrote), and every caller guards for empty separately.
 */
export function isProviderHandleOnly(value: string): boolean {
  return !/\p{L}/u.test(stripProviderHandles(value ?? ''));
}

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
  const withoutHandles = stripProviderHandles(raw)
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

/* ---------------------------------------------------------------------------------------------
 * WHEN A DISCOVERED FIELD IS NOT A QUESTION.
 *
 * The DOM walk sweeps `input[type="radio"], input[type="checkbox"]` as individual fields. For a
 * radio with no fieldset/legend and no role=group[aria-label], questionLabel falls through to
 * `el.labels[0]`, and for a radio that element is the OPTION's own label. So a stored row reads
 * `{label: 'Yes', options: ['Yes', 'No']}` - the question is gone and one of its answers is
 * standing where the question should be.
 *
 * Nothing downstream can recover from that. The Apply screen prints "Yes" as a question and asks
 * her to answer it; the fill pass scopes `label:has-text("yes")`, which matches the first "Yes" on
 * the page and may belong to a different control entirely. Measured on the owner's 158 packets on
 * 2026-08-11: 11 Palantir packets each carried "Yes", "Yes, I consent" and "English (ENG)" as
 * required questions, and the four questions the form actually asked - University, Year of
 * Graduation, Major, "How did you hear about this internship opportunity?" - had no record at all.
 *
 * Three tests, in strength order. Each is narrow on purpose: a rejected required field becomes a
 * blocker the applicant has to finish by hand, which is better than a wrong answer typed onto an
 * employer's form and worse than a correct question. Recovery is tried first (see
 * recoveredGroupQuestionLabel); rejection is what is left when there is nothing to recover.
 *
 * WHAT MUST SURVIVE ALL THREE. "Privacy" (8 packets) and "Privacy statement" (7) are Point72's and
 * IMC's real bare labels for a consent checkbox. They are answered by BARE_PRIVACY_ACKNOWLEDGEMENT
 * against the accept_privacy_notices column and she has a saved answer for both. They are short and
 * they are not sentences, so any rule shaped like "reject short labels" or "reject labels that are
 * not questions" deletes an answer Litos already has. There is no minimum length here for that
 * reason, and postingQuestions.test.ts fails if either is ever dropped.
 * --------------------------------------------------------------------------------------------- */

/** Compare the way a human reads a control: case, punctuation and spacing carry no meaning here. */
function comparableAnswerToken(value: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * THE EXACT TEST: the label is a member of its own option list.
 *
 * A question is never one of its own answers. When the provider reports options this needs no
 * vocabulary, no length rule and no judgement, and it cannot be fooled by an employer whose
 * question happens to be short.
 */
export function discoveredLabelIsOwnOption(label: string, options: readonly string[] | null | undefined): boolean {
  const key = comparableAnswerToken(label);
  if (!key || !options || options.length < 2) return false;
  return options.some((option) => comparableAnswerToken(option) === key);
}

/**
 * THE CLOSED VOCABULARY, for the managed path where `options` is undefined.
 *
 * stratus-browser-cloud reports no option list, so the exact test above has nothing to compare
 * against and every radio option arrives looking like a question. This is the fallback and it is
 * deliberately a CLOSED list of answer tokens rather than a shape rule: everything here is a thing
 * an applicant says back to a form, and none of it is a thing an employer asks.
 *
 * Kept short on purpose. Every entry added here is a required field that may stop being asked, so
 * the bar is "no employer would ever label a control this" - which is why "other", "none" and
 * "please specify" are absent even though they are common option texts: they are also plausible
 * bare labels for a free-text follow-up.
 */
const ANSWER_TOKEN_LABELS: ReadonlySet<string> = new Set([
  'yes', 'no', 'yes i consent', 'no i do not consent', 'i consent', 'i do not consent',
  'i agree', 'i do not agree', 'i accept', 'i decline', 'i acknowledge', 'i confirm',
  'agree', 'disagree', 'accept', 'decline', 'acknowledge', 'confirm',
  'true', 'false', 'n a', 'not applicable',
  'prefer not to say', 'prefer not to answer', 'decline to self identify',
  'i do not wish to answer', 'i do not want to answer', 'i don t wish to answer',
]);

/* A language checkbox's own option, "English (ENG)" / "Español (SPA)": a name followed by its
 * ISO-639 code in brackets and nothing else. Observed on all 11 Palantir packets. An employer
 * asking about languages writes a sentence ("Which languages do you speak?"), never this. */
const LANGUAGE_OPTION_SHAPE = /^[\p{L}][\p{L}\s'’-]{1,30}\(\s*[A-Za-z]{2,3}\s*\)$/u;

export function discoveredLabelIsAnswerToken(label: string): boolean {
  const key = comparableAnswerToken(label);
  if (!key) return false;
  if (ANSWER_TOKEN_LABELS.has(key)) return true;
  return LANGUAGE_OPTION_SHAPE.test((label ?? '').trim());
}

/**
 * THE WIDGET-NOISE TEST: the label is a composite control's whole rendered subtree.
 *
 * questionLabel used to read `textContent`, not `innerText`, so a `<label>` wrapping a composite
 * widget returned every text node under it - including the ones the user cannot see - concatenated
 * with no separators. The DOM script now prefers innerText, which stops NEW captures having this
 * shape; this test is what handles the captures that already exist and any port still on
 * textContent (the extension and stratus-browser-cloud each hold their own copy of the walk).
 *
 * Matched on markers rather than on length or on fused case, because both of those catch real
 * questions: employers write 200-character questions, and "LinkedIn" and "JavaScript" have a fused
 * case boundary in the middle of an ordinary word.
 *
 * WHAT IS MEASURED AND WHAT IS REASONED, because the difference matters to whoever edits this next.
 *
 *   MEASURED. Over the owner's 158 packets and 1757 stored question rows on 2026-08-11, exactly one
 *   marker fires: the typeahead empty state, on
 *       "Current location ✱No location found. Try entering a different locationLoading location
 *        location-input"
 *   which is the heading, the required glyph, the empty state and the loading node fused. It is the
 *   Palantir location blocker, on 11 packets, and it is the only row in the corpus any marker
 *   rejects. The whole gate rejects 47 rows and every one of them is a Palantir option or handle.
 *
 *   REASONED, not observed firing anywhere. The four react-select markers below. They exist because
 *   the same corpus holds a label that IS this shape and that none of them catch:
 *       "Disability statusSelect ...Yes, I have a disability...I do not want to answer
 *        eeo[disability] disabilitySelectElement"
 *   The fusion is what defeats them: "statusSelect" leaves no word boundary before "select", so
 *   \bselect never matches. That row is deliberately left alone rather than chased with a looser
 *   pattern. It is an EEO question Litos already answers correctly from the profile, so rejecting it
 *   would delete a working answer to tidy up a label, and dropping the \b to catch it would put
 *   every question containing the word "select" at risk. The markers are kept for the spaced form
 *   the innerText change now produces, where the boundary exists and the match is unambiguous.
 *
 * The general rule for this family is the option-swallowing test below, which needs no vocabulary
 * at all. These markers are only what covers the managed path, where no options are reported.
 */
const WIDGET_SUBTREE_MARKERS: readonly RegExp[] = [
  // Measured: the only marker the 2026-08-11 corpus exercises.
  /\bno\s+\w[\w\s]{0,24}\s+found\b[\s\S]{0,60}\btry\s+(?:entering|again|a\s+different)\b/i,
  // Reasoned: react-select's placeholder and DOM residue, in the spaced form innerText produces.
  /\bselect\s*\.{3}/i,
  /\bselect\s*…/,
  /\bselect\s*element\b/i,
  /\btype\s+to\s+search\b[\s\S]{0,40}\bloading\b/i,
];

export function discoveredLabelIsWidgetNoise(
  label: string,
  options?: readonly string[] | null,
): boolean {
  const raw = (label ?? '').trim();
  if (!raw) return false;
  if (WIDGET_SUBTREE_MARKERS.some((marker) => marker.test(raw))) return true;
  /* The label has swallowed its own answers. Two is the threshold rather than one, because a
   * legitimate question can quote a single option ("Select Other if not listed"). */
  if (!options || options.length < 2) return false;
  const key = comparableAnswerToken(raw);
  const swallowed = options.filter((option) => {
    const token = comparableAnswerToken(option);
    return token.length >= 4 && key.includes(token);
  });
  return swallowed.length >= 2;
}

/**
 * The one decision the ingest points share: is this row a question at all?
 *
 * Both callers - postingQuestionsFromDiscovered for the pre-script, and the submission runner's
 * discoverAndResolveQuestions for the packet - ask this, so the Apply screen and the fill pass can
 * never disagree about what the form asked.
 */
export function discoveredFieldIsNotAQuestion(
  field: Pick<DiscoveredQuestion, 'label' | 'options'>,
): boolean {
  const label = field?.label ?? '';
  if (!label.trim()) return false;
  if (discoveredLabelIsWidgetNoise(label, field.options)) return true;
  if (discoveredLabelIsOwnOption(label, field.options)) return true;
  return discoveredLabelIsAnswerToken(label);
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
  if (portal === 'workable' || portal === 'controlled_workable') {
    const builtIn = label.trim().replace(/^\s*\*+\s*/u, '').replace(/\s*\(optional\)\s*$/i, '').trim();
    return /^address(?:\s+address){0,2}$/i.test(builtIn)
      || /^phone(?:\s+\+\d{1,4})?(?:\s+phone)?$/i.test(builtIn);
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
      /* The two records are one control rendered twice, and the blank earlier duplicate may be the
       * only one carrying the form's required marker; the budget trim reads that flag to decide
       * which questions may be sacrificed first. Requiredness merges as OR across duplicates, the
       * same way normalizeApplicationReviewQuestions merges it. */
      const replaced = normalized[existingIndex] as T & { required?: boolean };
      normalized[existingIndex] = replaced.required === true && (next as T & { required?: boolean }).required !== true
        ? { ...next, required: true }
        : next;
    }
  }
  return normalized;
}

/* isProviderHandleOnly, compiled for the page.
 *
 * The page script cannot import from this module, and a second hand-written copy of six regexes is
 * exactly the drift that would break the safety argument, so the ONE list above is serialised into
 * the script instead. The test itself is the same three lines as the TypeScript twin, and
 * questionDiscovery.test.ts asserts the twin agrees with normalizeDiscoveredLabel on every shape
 * this file knows about. */
export const PROVIDER_HANDLE_ONLY_SCRIPT = `function isProviderHandleOnly(value) {
    var strippers = ${JSON.stringify(PROVIDER_HANDLE_STRIPPERS.map((handle) => [handle.source, handle.flags]))};
    var rest = value == null ? '' : String(value);
    for (var s = 0; s < strippers.length; s += 1) {
      rest = rest.replace(new RegExp(strippers[s][0], strippers[s][1]), ' ');
    }
    return !/\\p{L}/u.test(rest);
  }`;

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
export const DISCOVER_QUESTIONS_SCRIPT = String.raw`(() => {
  function clean(s) {
    return (s == null ? '' : s).replace(/[​‌‍﻿ ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function renderedText(node) {
    if (!node) return '';
    if (typeof node.innerText === 'string') return clean(node.innerText);
    return clean(node.textContent || '');
  }
  function labelledByText(node) {
    var ids = node && node.getAttribute ? (node.getAttribute('aria-labelledby') || '') : '';
    if (!ids) return '';
    var out = [];
    var list = ids.split(/\s+/);
    for (var i = 0; i < list.length; i += 1) {
      if (!list[i]) continue;
      var text = renderedText(document.getElementById(list[i]));
      if (text) out.push(text);
    }
    return clean(out.join(' '));
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
  /* THE QUESTION A CHOICE CONTROL BELONGS TO, when the DOM never said so in a standard way.
   *
   * For a radio or a checkbox, el.labels[0] is the OPTION's label - "Yes", "English (ENG)" - and
   * returning it stores an answer where the question should be. The two standard sources are tried
   * first by questionLabel (fieldset/legend, role=group[aria-label]); these are what is left when a
   * board renders a group as plain divs, which Lever's custom-question cards do.
   *
   *   1. aria-labelledby on the control or on its group. An explicit pointer to the question, and
   *      the only one of these three that the page author wrote on purpose.
   *   2. The heading of the block the control sits in. Bounded to the nearest ancestor that holds
   *      MORE THAN ONE choice control - that is what makes it a group rather than a single field -
   *      and read from a heading element or the block's first label, never from the whole subtree.
   *
   * Returns '' when it finds nothing, and the caller falls through to its existing behaviour. This
   * only ever adds a question that was previously lost; it cannot rename one that was already right,
   * because questionLabel reaches it only after legend and aria-label have both come back empty. */
  function recoveredGroupLabel(el) {
    var group = el.closest(
      '[role="group"][aria-labelledby], [role="group"][aria-label],'
      + ' [role="radiogroup"][aria-labelledby], [role="radiogroup"][aria-label]'
    );
    var viaGroup = group ? labelledByText(group) : '';
    if (!viaGroup && group) viaGroup = clean(group.getAttribute('aria-label') || '');
    if (viaGroup) return viaGroup;
    var node = el.parentElement;
    for (var depth = 0; node && depth < 6; depth += 1) {
      var controls = node.querySelectorAll('input[type="radio"], input[type="checkbox"]');
      if (controls.length > 1) {
        var semanticOwners = new Set();
        var names = new Set();
        for (var controlIndex = 0; controlIndex < controls.length; controlIndex += 1) {
          var owner = controls[controlIndex].closest(
            '[role="group"][aria-labelledby], [role="group"][aria-label],'
            + ' [role="radiogroup"][aria-labelledby], [role="radiogroup"][aria-label]'
          );
          if (owner) semanticOwners.add(owner);
          if (controls[controlIndex].name) names.add(controls[controlIndex].name);
        }
        var ownsOneQuestion = semanticOwners.size === 1 || (semanticOwners.size === 0 && names.size <= 1);
        if (!ownsOneQuestion) return '';
        var heading = node.querySelector('h1, h2, h3, h4, h5, h6, legend, .application-label, .application-question');
        var headingText = renderedText(heading);
        if (headingText) return headingText;
        return '';
      }
      node = node.parentElement;
    }
    return '';
  }
  ${PROVIDER_HANDLE_ONLY_SCRIPT}
  /* Control text that names the CONTROL and not the question: an Ashby datepicker's own label
   * reads "Pick date...". Verbatim from the submit-readiness gate's genericControlText in
   * portalSubmission.ts, and kept identical on purpose - the two walks must not disagree about
   * which strings are questions. */
  function genericControlText(value) {
    return /^(pick|select|choose)\s+(date|option)|^(type|enter|write)\s+(your\s+)?(answer\s+)?here/i.test(clean(value));
  }
  /* THE QUESTION A CONTROL SITS UNDER, when the control itself is labelled with nothing but a
   * provider handle. A verbatim port of nearestQuestionText from READ_SUBMIT_READINESS_SCRIPT in
   * portalSubmission.ts, which is the walk that already names these very fields in the blocker
   * text the applicant sees - so recovering the question here makes the Apply screen and the
   * blocker line say the same words about the same field.
   *
   * A BLOCK HOLDING MORE THAN ONE CONTROL ENDS THE WALK, and that bound is the whole safety of it.
   * The first label inside a block with two controls belongs to one of them in particular, and
   * borrowing it names the other field wrongly. Measured on the live Palantir Lever form on
   * 2026-08-11: the "High School Name & Graduation Year" card holds two controls, so the walk stops
   * and both stay honest "no label Litos can read" blockers, while the seven single-control cards
   * recover their own headings. A wrong question is worse than a missing one - the resolver answers
   * "High School Name" out of the education profile and would type her UNIVERSITY into it.
   *
   * Returns '' when it finds nothing, and the caller keeps whatever it had. */
  function nearestQuestionText(el) {
    var node = el.parentElement;
    for (var depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
      if (!node.matches || !node.matches('div, section, li, fieldset')) continue;
      if (node.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"]').length > 1) return '';
      var candidate = node.querySelector('label, legend, .question, h3, h4');
      /* textContent, NOT innerText, and this one is measured rather than inherited. Lever paints
       * its card headings with text-transform:uppercase, and innerText reports the transformed
       * glyphs: the same heading read as "UNIVERSITY", "YEAR OF GRADUATION", "UNIVERSITY MAJOR".
       * That is the employer's styling, not the employer's words, and storing it would show the
       * applicant a shouted question and disagree with the blocker line about the same field.
       * textContent reads the markup, which is what the submit-readiness gate reads. */
      var text = clean((candidate && candidate.textContent) || '');
      if (text && !genericControlText(text)) return text;
    }
    return '';
  }
  function questionLabel(el) {
    var type = (el.getAttribute('type') || '').toLowerCase();
    var choice = type === 'radio' || type === 'checkbox';
    var semanticGroup = choice ? el.closest(
      '[role="group"][aria-labelledby], [role="group"][aria-label],'
      + ' [role="radiogroup"][aria-labelledby], [role="radiogroup"][aria-label]'
    ) : null;
    var semanticGroupLabel = semanticGroup
      ? (labelledByText(semanticGroup) || clean(semanticGroup.getAttribute('aria-label') || ''))
      : '';
    if (semanticGroupLabel) return semanticGroupLabel;
    var fieldset = el.closest('fieldset');
    var fieldsetChoices = fieldset && choice
      ? Array.prototype.slice.call(fieldset.querySelectorAll('input[type="radio"], input[type="checkbox"]'))
      : [];
    var referencedText = labelledByText(el);
    var referenceIds = clean(el.getAttribute('aria-labelledby') || '');
    var sameNamePeers = choice && el.name
      ? (
        fieldsetChoices.length > 0
          ? fieldsetChoices
          : Array.prototype.slice.call((el.form || document).querySelectorAll(
            'input[type="radio"][name="' + quoteAttr(el.name) + '"], input[type="checkbox"][name="' + quoteAttr(el.name) + '"]'
          ))
      ).filter(function (input) { return input.name === el.name; })
      : [el];
    var sharedChoiceReference = !choice || (referenceIds && sameNamePeers.length > 0
      && sameNamePeers.every(function (input) {
        return clean(input.getAttribute('aria-labelledby') || '') === referenceIds;
      }));
    if (referencedText && sharedChoiceReference) return referencedText;
    var fieldsetNames = new Set(fieldsetChoices.map(function (input) { return input.name; }).filter(Boolean));
    var fieldsetOwnsChoice = !choice || fieldsetNames.size <= 1;
    var legend = fieldsetOwnsChoice && fieldset ? fieldset.querySelector('legend') : null;
    var legendText = renderedText(legend);
    if (legendText) return legendText;
    if (choice) {
      var recovered = recoveredGroupLabel(el);
      if (recovered) return recovered;
    }
    if (referencedText && !choice) return referencedText;
    var labelEl = (el.labels && el.labels[0]) || (el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null);
    /* innerText, not textContent, with textContent kept as the fallback for a label that is not
     * rendered. A <label> wrapping a composite widget contains every text node under it, including
     * the hidden ones, and textContent concatenates them with no separators: the Palantir location
     * field stored "Current location ✱No location found. Try entering a different locationLoading",
     * which is the heading, the required glyph, a typeahead empty state and a loading node fused
     * into one string. innerText reports what a person can actually see. */
    var labelText = renderedText(labelEl);
    if (labelText) return labelText;
    var ariaLabelText = clean(el.getAttribute('aria-label') || '');
    if (ariaLabelText) return ariaLabelText;
    var written = clean([
      el.getAttribute('placeholder') || '',
    ].join(' '));
    var parts = [
      el.getAttribute('placeholder') || '',
      el.getAttribute('name') || '',
      el.id || '',
    ];
    var own = clean(parts.join(' '));
    /* THE HANDLE THAT IS NOT A LABEL.
     *
     * own is the visible label, the aria-label and the placeholder concatenated with the control's
     * name and id, and returning it whenever it is merely non-empty means a field with NOTHING but
     * a name returns that name. Lever's custom questions are built that way - the question text
     * sits in a sibling div.application-label, never in a label element, and the control carries
     * only name="cards[<uuid>][field0]". Measured against the live Palantir posting on 2026-08-11:
     * nine controls came back as a bare cards handle, normalizeDiscoveredLabel dropped all nine as
     * handle-only, and the form came back with "University" is required and is still empty, the
     * same for "Year of Graduation" and "University Major", while the packet held USC Viterbi, 2028
     * and Computer Science.
     *
     * BOTH CONDITIONS, and both are needed:
     *   - nothing a person wrote (no label text, no aria-label, no placeholder), so a field that has
     *     any human text keeps it and this branch cannot touch it; and
     *   - what is left is nothing but handles this module can name (isProviderHandleOnly), so a
     *     meaningful name or id - firstName, school, gpa - is still a label and is kept.
     *
     * That pair is exactly the set of fields whose label is thrown away today, which is why this
     * cannot rename a question that already reads correctly: it only ever runs where the stored
     * label would have been the empty string. And when the walk finds nothing either, own is
     * returned unchanged and the field is dropped as before - no heading is invented for a field
     * that has none. */
    if (own && !written && isProviderHandleOnly(own)) {
      var underHeading = nearestQuestionText(el);
      if (underHeading) return underHeading;
    }
    if (own) return own;
    var block = el.closest('div, section, li');
    var fallback = block ? block.querySelector('label, legend, .question, h3, h4') : null;
    return renderedText(fallback);
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
    var workableWidget = el.closest('[data-input-type]');
    if (workableWidget && workableWidget.querySelector('input[required], textarea[required], select[required], [aria-required="true"]')) return true;
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
      renderedText(labelEl)
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
      var semanticGroup = el.closest(
        '[role="group"][aria-labelledby], [role="group"][aria-label],'
        + ' [role="radiogroup"][aria-labelledby], [role="radiogroup"][aria-label]'
      );
      var semanticControls = semanticGroup
        ? semanticGroup.querySelectorAll('input[type="radio"], input[type="checkbox"]')
        : [];
      var fieldset = el.closest('fieldset');
      var fieldsetControls = fieldset
        ? fieldset.querySelectorAll('input[type="radio"], input[type="checkbox"]')
        : [];
      var fieldsetNames = new Set(Array.prototype.map.call(fieldsetControls, function (input) { return input.name; }).filter(Boolean));
      var fieldsetOwnsChoice = fieldsetControls.length > 0 && fieldsetNames.size <= 1;
      var name = el.getAttribute('name');
      if (!semanticControls.length && !fieldsetOwnsChoice && !name) {
        var own = optionLabel(el);
        return own ? [own] : [];
      }
      var group = semanticControls.length
        ? semanticControls
        : (fieldsetOwnsChoice && fieldsetControls.length
          ? fieldsetControls
          : document.querySelectorAll('input[name="' + quoteAttr(name) + '"]'));
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
  function choiceQuestionKey(el) {
    var semanticGroup = el.closest(
      '[role="group"][aria-labelledby], [role="group"][aria-label],'
      + ' [role="radiogroup"][aria-labelledby], [role="radiogroup"][aria-label]'
    );
    return semanticGroup || el.name || el;
  }

  var els = Array.prototype.slice
    .call(
      document.querySelectorAll(
        'input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], input:not([type]), textarea, select, input[type="radio"], input[type="checkbox"]',
      ),
    )
    .filter(function (el) {
      var readonlyChoiceOpener = el.readOnly
        && (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox');
      return !el.closest('[id*="litos"]') && !el.disabled && (!el.readOnly || readonlyChoiceOpener)
        && isVisible(el) && !isHoneypot(el);
    });

  var out = [];
  var seenChoiceQuestions = new Set();
  var counter = 0;
  for (var i = 0; i < els.length; i += 1) {
    var el = els[i];
    if (el.type === 'radio' || el.type === 'checkbox') {
      var choiceKey = choiceQuestionKey(el);
      if (seenChoiceQuestions.has(choiceKey)) continue;
      seenChoiceQuestions.add(choiceKey);
    }
    var label = clean(questionLabel(el));
    if (!label) continue;
    counter += 1;
    var marker = 'data-litos-discovered-' + counter;
    el.setAttribute(marker, '1');
    var selector = stableSelector(el, marker);
    out.push({
      label: label,
      selector: selector,
      durableSelector: selector.indexOf('[data-litos-discovered-') === 0 ? null : selector,
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
  /** Exact ISO country from the ATS country/location fields. Undefined is fail-closed. */
  postingCountryCode?: string,
  /* THE CONTROL'S OWN OPTION LIST, as discovery reported it, and undefined is fail-closed here too.
   *
   * Read by exactly one rule, standardizedTestAnswer, and only to find the employer's own wording
   * for "I have no scores" when the applicant has declared that she has none. It is NOT a general
   * licence for this function to consult the option list: every other rule here decides its answer
   * from the label and the stored profile, and lib/profileFieldResolution.ts owns the separate job
   * of snapping a decided answer onto a real control. Threading a list in here is a narrow
   * exception because a declared absence has no canonical spelling of its own: "None", "N/A" and
   * "I have not taken it" are the same fact, and only the form knows which one it accepts.
   *
   * Callers that do not have a list omit it, and every one of them then behaves exactly as before:
   * a declared absence with no list HOLDS. */
  options?: readonly string[],
): { value: string } | { skipReason: string } | null {
  /* THE SELF-DECLARATIONS COME FIRST, before every classifier in this file.
   *
   * Not a style choice. Each of these is a question a broad rule further down has already answered
   * wrongly on a live application - the PEP question got the applicant's home city because
   * `\bstate\b` matched inside "state-owned", and the master's-graduation-date question got her
   * undergraduate date. Recognising them up here means no later rule can reach them, and each one
   * returns a skipReason rather than null when nothing is stored, so the fall-through to the essay
   * drafter cannot invent an answer either. */

  /* AND THIS ONE COMES FIRST OF ALL, because what it refuses is a label another branch would answer.
   *
   * A control whose text welds an employer document to a claim about the applicant is one tick
   * carrying two statements, and the declaration half is answerable. Measured on main with nothing
   * granted: "I acknowledge the Privacy Statement and confirm I am legally authorized to work in the
   * United States." resolves to "Yes" off the work-eligibility branch, accepting a named document
   * that no permission was ever consulted about. Placed above every rule rather than beside the
   * consent grammar because the consent grammar already refuses it correctly; it is the OTHER
   * branches that have to be stopped. See weldsConsentToHeldDeclaration. */
  if (weldsConsentToHeldDeclaration(label)) {
    return {
      skipReason: `this asks you to accept a document and state a fact in one tick, so it is left for you: "${label.slice(0, 60)}"`,
    };
  }

  const exportControl = exportControlAnswer(label);
  if (exportControl) return exportControl;

  const politicallyExposed = politicallyExposedAnswer(label, ap);
  if (politicallyExposed) return politicallyExposed;

  const siblingRefusal = siblingQuestionRefusal(label, jdText);
  if (siblingRefusal) return siblingRefusal;

  /* Up here for the same reason as the two above it, and AFTER them on purpose: the PEP question
   * and Astranis's export-control paragraph both contain the word "government", and both are
   * already answered by their own rule, so they must reach it first. What is up here is the other
   * direction. Skydio's gloss reads "...worked for the US government (e.g. congressional staffer,
   * member of military, state, or federal agencies)?", and before this arm existed the bare word
   * "military" in that gloss put it through EEO_QUESTION, which answered an employment-history
   * question with "Decline to self-identify". Verified against the real resolver on 2026-08-09,
   * and it is what makes the placement a safety property rather than a preference. */
  const governmentEmployment = governmentEmploymentAnswer(label, ap, jdText);
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

  /* Directly after it, so the graduation date answers its own questions and nothing else about
   * high school is answered from the university programme. Up here with the self-declarations for
   * the reason the block header gives: this is a label a broad rule has already answered wrongly on
   * a live form, and being up here is what stops any later rule reaching it. */
  const highSchoolRecord = highSchoolRecordRefusal(label);
  if (highSchoolRecord) return highSchoolRecord;

  /* Up here with the self-declarations for the reason the block header gives, and this one has the
   * receipt: "please provide your university email address" is a label a broad rule ALREADY answered
   * wrongly on a live form, with the university's name. Being above every classifier is what stops
   * any later rule reaching it again. See academicEmailAnswer. */
  const academicEmail = academicEmailAnswer(label, ap);
  if (academicEmail) return academicEmail;

  const previouslyApplied = previouslyAppliedAnswer(label, ap, jdText);
  if (previouslyApplied) return previouslyApplied;

  // Ahead of referralAnswer, which declines this label anyway; the order makes that explicit.
  const referralDetail = referralSourceDetailAnswer(label, ap);
  if (referralDetail) return referralDetail;

  const referral = referralAnswer(label, ap, jdText);
  if (referral) return referral;

  const outstandingOffer = outstandingOfferAnswer(label, inputType, ap);
  if (outstandingOffer) return outstandingOffer;

  /* THE CONSENT CLASS, accepted under the applicant's standing permission and not otherwise.
   *
   * Placed immediately before the refusals it supersedes, so that with no permission on the row
   * every label below reaches exactly the handler it reaches on main. It is ABOVE
   * applicationConsentAnswer because that one holds "privacy statement" and "interview code of
   * conduct" by name, which are the two labels this exists to accept.
   *
   * It is therefore also above workEligibilityAnswer, the EEO branch and isRefusedQuestion, and
   * that is the reason isConsentAcknowledgementQuestion vetoes on its own held vocabulary before it
   * matches anything: being early means it cannot rely on a later rule to catch a declaration for
   * it. Every one of those families is in HELD_DECLARATION_VOCABULARY, and consentBoundary tests
   * assert it against the same labels those handlers own. */
  const consentAcknowledgement = consentAcknowledgementAnswer(label, ap, jdText);
  if (consentAcknowledgement) return consentAcknowledgement;

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
    /* RELAYED, never generated. A stored declaration answers it; an unset column still holds.
     * See application_profile.restrictive_agreements for why this is a column and not the "No"
     * that used to sit here. */
    if (ap.restrictive_agreements) return { value: ap.restrictive_agreements };
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

  const earlyWorkEligibility = workEligibilityAnswer(label, ap, postingCountry, postingCountryCode);
  if (earlyWorkEligibility) return earlyWorkEligibility;

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

  /* Before the EEO branch for the same reason militaryService is: a test-score field is a plain
   * required input, and letting it fall through to the generic branches below is what left it
   * empty on 8 packets. Answers only from the three stored columns, and returns a skipReason
   * rather than null when they are unset, so an unanswered test question is reported as left for
   * the student instead of silently reaching a keyword fallback that might type something else.
   *
   * Standing in front of EEO_QUESTION is only safe because standardizedTestAnswer refuses every
   * EEO label outright as its first act. Without that refusal this ordering fills a test score into
   * a disability question, which is measured and written up at the top of that function. Do not
   * move this line below the EEO branch and do not remove the refusal inside it: the two together
   * are what make both questions answerable. */
  const standardizedTest = standardizedTestAnswer(label, ap, options);
  if (standardizedTest) return standardizedTest;

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
