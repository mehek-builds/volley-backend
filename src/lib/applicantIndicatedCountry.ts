import {
  postingCountryCodeFromJobContext,
  postingCountryFromJobContext,
} from './jobLocation';

/* THE COUNTRY SHE HERSELF NAMED FOR THIS APPLICATION, read off her own answers on this same form.
 *
 * WHAT THIS EXISTS TO UNBLOCK, measured on Hudson River Trading packet 4a79eec1 (greenhouse,
 * ready_for_final_approval, 27 of 27 questions answered). Every press of Send returned 422:
 *
 *   "Sensitive question requires your attention: will you now, or in the future, require visa
 *    sponsorship to legally work in the country specified for this position?"
 *
 * HRT publishes that posting for Austin, Chicago, New York, London and Singapore. So "the country
 * specified for this position" names THREE countries, postingCountryCodeFromJobContext correctly
 * refuses to pick one, workEligibilityAnswer refuses the label, and the gate refuses the send. That
 * refusal is right on its own terms and is not narrowed here: R-004 is the logged incident where a
 * machine picked one country out of several and a false legal declaration reached an employer.
 *
 * THE POINT IS THAT ON THIS FORM THE AMBIGUITY IS NOT REAL, AND SHE IS THE ONE WHO SETTLED IT. The
 * same HRT form asks her which office she wants, and she answered it twice:
 *
 *   "please select your top preferred hrt office location..."              ->  "New York"
 *   "if you equally prefer two office locations..."                        ->  "Chicago"
 *
 * Both are US cities. Her indicated set is unanimously one country, so the country for THIS
 * application is determinate FROM HER OWN ANSWERS and no machine guess is required. That is the
 * whole of what this module computes.
 *
 * THREE PROPERTIES, all load-bearing, none of them negotiable:
 *
 *   1. THE EVIDENCE IS HERS. Only an answered question counts. A blank one indicates nothing, and
 *      no posting field, job description, profile default or model output can reach this function.
 *
 *   2. UNANIMITY, NEVER A FIRST CHOICE AND NEVER A MAJORITY. Every location she indicated must
 *      resolve to the SAME country. New York and Chicago agree, so the set resolves. New York and
 *      London do not, so the set refuses and the send keeps refusing - which is correct, because
 *      her position genuinely differs between those two.
 *
 *   3. FAIL-CLOSED EVERYWHERE ELSE, in the same style as postingCountryCodeFromJobContext, whose
 *      undefined already means "refuse". No answered location question, an answer that is not a
 *      place, or a place this codebase cannot pin to a country all return undefined, and undefined
 *      is read by the caller as a refusal rather than as permission to fall back to anything.
 */

/* WHY THE RESOLUTION IS THE POSTING'S OWN CLASSIFIER AND NOT A CITY TABLE OF MY OWN.
 *
 * "New York" and "Chicago" are cities, not countries, so something has to map them. Writing a
 * second table here would mean two places in this repo deciding what country a place name is in,
 * drifting apart, and a US-defaulting one would be exactly the flattening that produces a wrong
 * legal answer. jobLocation.ts already owns that judgement for LEGAL scope - it is fail-closed by
 * construction, it refuses a set that spans two countries, and it deliberately leaves genuinely
 * ambiguous names such as Melbourne unknown rather than guessing.
 *
 * Her indicated locations are handed to it as `locations`, the packet's structured-location shape,
 * because that is the field whose parse rules are written for a list of places. Measured:
 *
 *   ["New York", "Chicago"]              ->  us / US        (this packet)
 *   ["New York", "London"]               ->  unknown / -    (refuses, and must)
 *   ["London"]                           ->  non_us / GB    (a country she has no record for)
 *   ["Singapore"], ["Melbourne"]         ->  unknown / -    (not pinnable, so refused)
 *
 * NOT jobCountry() and NOT the raw string. jobCountry("New York / Dublin") answers 'us' on purpose,
 * because for a BOARD FILTER a role offered in New York is a role she could hold. Reading a legal
 * declaration off that tie-break is the R-004 mistake with extra steps.
 */
function countryOfOneIndicatedLocation(location: string): string | undefined {
  const locations = { locations: [location] };
  const code = postingCountryCodeFromJobContext(locations);
  if (code) return code;
  // Parity with selectedEligibilityCountry's own bridge: the legal-scope classifier can prove US
  // exactly, while 'non_us' cannot say WHICH country and is therefore never enough to answer with.
  return postingCountryFromJobContext(locations) === 'us' ? 'US' : undefined;
}

/* "No" IS NOT NORWAY, AND THAT IS NOT A HYPOTHETICAL.
 *
 * Hudson River Trading, 2026-09-01: "No" was typed into a location preference on this employer's
 * form, and questionDiscovery.test.ts already pins that measurement. Handed to the classifier bare,
 * "No" is the ISO 3166 code for Norway and resolves to NO - a country she has never worked in, on
 * the strength of a two-letter coincidence.
 *
 * It happens not to reach an employer today, because the caller then finds no Norway record in
 * work_eligibility_by_country and refuses. THAT IS LUCK, NOT A RULE. The safety of a legal
 * declaration must not rest on which countries happen to be absent from her profile, so the
 * coincidence is closed here, where it is visible, rather than left to be caught downstream.
 *
 * Bare two-letter answers are refused wholesale for the same reason: "IN" is Indiana or India, "IL"
 * is Illinois or Israel, and a form on which she typed two characters has told us nothing worth
 * making a legal declaration from. She types "New York", not "US".
 */
const NOT_A_PLACE_ANSWER =
  /^(?:yes|no|n\/?a|none|nil|other|tbd|any|anywhere|unsure|not\s+sure|no\s+preference|i\s+have\s+no\s+preference|maybe|true|false|-+)$/i;
const BARE_TWO_LETTER_ANSWER = /^[a-z]{2}$/i;

function isPlaceShapedAnswer(answer: string): boolean {
  return !NOT_A_PLACE_ANSWER.test(answer) && !BARE_TWO_LETTER_ANSWER.test(answer);
}

/* WHICH QUESTIONS COUNT AS HER SAYING WHERE THIS APPLICATION IS FOR.
 *
 * THE RECALL DIRECTION IS THE DANGEROUS ONE, and that is why this is not the existing
 * LOCATION_PREFERENCE_QUESTION. Missing a location question she answered is how a set that really
 * spans two countries looks unanimous: if she picked New York here and London there and only the
 * first label matched, this module would report US and a false declaration would follow. Matching
 * one question too many can only ADD a member to the set, which can only make unanimity harder and
 * the refusal more likely. So the matcher is deliberately wider than the one questionDiscovery uses
 * to HOLD these questions, and the narrowing is done by the unanimity rule instead.
 *
 * Measured against the two real HRT labels, which the canonical predicate does NOT both catch:
 *
 *   "please select your top preferred hrt office location..."   LOCATION_PREFERENCE_QUESTION: yes
 *   "if you equally prefer two office locations, ..."           LOCATION_PREFERENCE_QUESTION: NO
 *
 * The second is the one that says Chicago. It is a SECOND CHOICE, which is exactly the answer that
 * has to be seen for the set to be tested for unanimity at all, and the canonical predicate misses
 * it because its preference vocabulary lists "preferred" and "preference" but not "prefer".
 *
 * WIDER IS STILL NOT UNBOUNDED. Two exclusions are required rather than incidental:
 *
 *   HER OWN ADDRESS IS NOT A ROLE LOCATION. "Where are you currently based" is answered from where
 *   she LIVES, and reading Dubai or New York off it would let a question about her flat decide a
 *   legal declaration about a job. This is the one over-match that is genuinely unsafe, because it
 *   can CREATE an indicated set where she indicated nothing, rather than adding to one.
 *
 *   A NAME IS NOT A PLACE. "preferred first name preferred first name preferred_name" is a real
 *   control on this very packet and a naive /prefer/ matcher takes it. It carries "Mehek", which is
 *   not a country, so the fail-closed rule above would refuse the whole packet rather than answer
 *   it wrongly - but refusing the packet she is trying to send is still a defect, so it is excluded
 *   by name here and pinned by a test.
 */
const WORK_LOCATION_NOUN =
  /\boffices?\b|\bwork(?:place|site)?\s+locations?\b|\bjob\s+locations?\b|\b(?:role|position)\s+locations?\b|\bcampus(?:es)?\b|\blocations?\b/i;
const INDICATION_VERB =
  /\bprefer(?:s|red|ring|ence|ences)?\b|\bchoice\b|\bchoos(?:e|ing)\b|\bchose\b|\bselect(?:s|ed|ing|ion)?\b|\bpick\b|\brank(?:s|ed|ing)?\b|\binterested\b|\bdesired?\b|\bwould you like\b|\bwant\b|\bwhich\b|\bapply(?:ing)?\b|\btop\b|\bfirst\b|\bsecond\b|\bthird\b/i;
/* WHERE SHE HAS WORKED IS NOT WHERE SHE WANTS TO WORK.
 *
 * "In which locations have you previously worked" matches a work-location noun and an indication
 * verb and is not a preference at all. It belongs with the residence exclusion below rather than
 * with the office questions, and for the same reason: an employment-history answer would CREATE an
 * indicated set out of a question she was never asked about this role, which is the one over-match
 * shape that can produce a wrong answer instead of an extra refusal. */
const EMPLOYMENT_HISTORY_QUESTION =
  /\b(?:previous(?:ly)?|prior|past|former(?:ly)?)\b|\b(?:have|has|had)\s+(?:you\s+)?(?:ever\s+)?(?:work|worked|been)\b|\bwork(?:ed)?\s+(?:at|for)\b|\bemployment\s+history\b/i;
/* Her residence, not the role's. Kept as its own list so the exclusion is readable at the call
 * site and testable on its own: every one of these is a question about where SHE is. */
const APPLICANT_RESIDENCE_QUESTION =
  /\b(?:currently|presently)\s+(?:based|located|living|residing|reside)\b|\bwhere\s+(?:are|do)\s+you\b|\byour\s+(?:current|home|permanent|present)\s+(?:location|address|city|residence)\b|\b(?:current|home|permanent)\s+address\b|\bcountry\s+of\s+residence\b|\bresiden(?:ce|t|tial)\b|\bhome\s+location\b|\bmailing\b|\bshipping\b/i;
/* An identity control that merely shares the word "preferred". Not a place question at all. */
const IDENTITY_CONTROL_QUESTION =
  /\bnames?\b|\bpronouns?\b|\bgender\b|\be-?mail\b|\bphone\b|\bpronunciation\b/i;

export function isApplicantWorkLocationIndicationQuestion(label: string): boolean {
  if (!label) return false;
  if (APPLICANT_RESIDENCE_QUESTION.test(label)) return false;
  if (EMPLOYMENT_HISTORY_QUESTION.test(label)) return false;
  if (IDENTITY_CONTROL_QUESTION.test(label)) return false;
  return WORK_LOCATION_NOUN.test(label) && INDICATION_VERB.test(label);
}

/** One packet question as this module needs to read it: its label and whatever answer it holds. */
export type IndicatedLocationQuestion = { question: string; answer?: string };

/** What she indicated, kept beside the country so a caller can say WHY it resolved. */
export type ApplicantIndicatedCountry = {
  /** The exact ISO country code every indicated location agreed on. */
  code: string;
  /** Her own answers that were read to reach it, in packet order. */
  locations: readonly string[];
};

/**
 * THE ONE COUNTRY EVERY WORK-LOCATION ANSWER ON THIS FORM AGREES ON, or undefined.
 *
 * Undefined is a refusal and is returned for every case this rule does not cover: she answered no
 * work-location question, an answer is not a place, a place cannot be pinned to a country, or two
 * answers name two countries. The caller must treat undefined exactly as it treats an undefined
 * posting country, which is to hold the question for her.
 *
 * NOTHING HERE READS THE PROFILE. This function answers "which country is this application for",
 * never "what is she allowed to do there"; those are separate questions on purpose, and the second
 * one is answered only from work_eligibility_by_country by the caller.
 */
export function applicantIndicatedWorkCountry(
  questions: readonly IndicatedLocationQuestion[] | undefined,
): ApplicantIndicatedCountry | undefined {
  if (!questions?.length) return undefined;
  const locations: string[] = [];
  const codes = new Set<string>();
  for (const question of questions) {
    if (!isApplicantWorkLocationIndicationQuestion(question?.question ?? '')) continue;
    const answer = question.answer?.trim() ?? '';
    // A blank question indicates nothing at all, so it neither resolves nor refuses.
    if (!answer) continue;
    if (!isPlaceShapedAnswer(answer)) return undefined;
    const code = countryOfOneIndicatedLocation(answer);
    if (!code) return undefined;
    locations.push(answer);
    codes.add(code);
  }
  // Unanimity, never a first choice and never a majority.
  if (codes.size !== 1) return undefined;
  return { code: [...codes][0], locations };
}
