/**
 * A stored answer that can only have come from a CONTROL'S OWN OPTION LIST, recognised by shape.
 *
 * "January 2028 - July 2028". "3.81 - 3.9". "2027-2028". A band spans two endpoints, and nothing on
 * the applicant's profile and nothing any fill path computes is ever written that way: a profile
 * holds "May 2028" and "3.89", the Greenhouse graduation bucket emits "Spring 2028", the GPA bucket
 * emits "3.6 or above (out of 4.0)". So an answer in band form is evidence that discovery read a
 * control's options and resolveProfileField snapped onto one of them.
 *
 * WHY A SHAPE TEST RATHER THAN A PROVENANCE FLAG. ResolvedProfileField.matchedOption says this
 * outright and does not survive into the stored question record, and packet.fieldOptions is not
 * persisted with the packet, so at fill time it is absent on every real run and any rule keyed on it
 * is inert. The shape is what is left. It is deliberately narrow: anything it does not recognise
 * keeps the behaviour that shipped, so the cost of a miss is the status quo rather than a new wrong
 * answer.
 *
 * WHAT IT DOES NOT SAY, and this is the whole reason answer_option_source exists beside it. A band
 * proves the answer came off a list. It proves NOTHING about whether that list still matches the
 * applicant. A record written when the profile said "May 2027" holds "January 2027 - July 2027"
 * forever, and it is still band-shaped after she corrects her graduation to May 2028. Shape is the
 * test for "could this have been computed here"; the recorded derivation is the test for "is it
 * still current". Both are required before a stored answer outranks a freshly computed one.
 *
 * THIS FILE HAS NO IMPORTS ON PURPOSE. questionDiscovery.ts needs it and cannot import
 * portalSubmission.ts, which imports questionDiscovery.ts; profileFieldResolution.ts imports
 * questionDiscovery.ts too. A leaf module is the only home that all three can reach, which is the
 * same reason comparableOption lives in selfIdentification.ts.
 *
 * Returns the trimmed answer so callers can use it directly, and undefined when there is no band.
 */

// "January 2028 - July 2028", "2027-2028", "July 2027 to December 2027", "Sept 2024 through May 2028".
const DATE_BAND =
  /\b(?:[A-Za-z]{3,9}\s+)?(?:19|20)\d{2}\s*(?:[-\u2010-\u2015]|\bto\b|\bthrough\b)\s*(?:[A-Za-z]{3,9}\s+)?(?:19|20)\d{2}\b/;
// "3.81 - 3.9", "3.5-3.9".
const NUMBER_BAND = /\b\d(?:\.\d+)?\s*(?:[-\u2010-\u2015]|\bto\b)\s*\d(?:\.\d+)?\b/;

export function optionBandAnswer(answer: string | undefined | null): string | undefined {
  const value = answer?.trim();
  if (!value) return undefined;
  return DATE_BAND.test(value) || NUMBER_BAND.test(value) ? value : undefined;
}

/**
 * May a stored answer outrank a freshly computed one for this control?
 *
 * Only when it is a band AND the profile value it was snapped from is still the profile value
 * today. `derivedFrom` is the question record's answer_option_source, written at resolution time;
 * `currentProfileValue` is what the resolver answers for that same label now.
 *
 * ABSENT `derivedFrom` MEANS NO. A record written before this field existed, a record from a path
 * that does not snap, and a hand-built fixture all land there, and for all three the honest reading
 * is "cannot prove this is current", which is exactly the reading that keeps the stale band from
 * being sent. The cost of that default is one recomputation; the cost of the other default is
 * submitting a graduation window a year early.
 */
export function storedOptionAnswerIsCurrent(
  answer: string | undefined | null,
  derivedFrom: string | undefined | null,
  currentProfileValue: string | undefined | null,
): boolean {
  if (!optionBandAnswer(answer)) return false;
  const source = derivedFrom?.trim();
  const current = currentProfileValue?.trim();
  if (!source || !current) return false;
  return source.toLowerCase() === current.toLowerCase();
}
