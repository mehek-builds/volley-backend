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
  return derivationIsCurrent(derivedFrom, currentProfileValue);
}

/**
 * Has the profile moved since this answer was chosen against it?
 *
 * The currency half of the rule above, on its own, because a SECOND kind of stored answer needs it
 * and must not be allowed to disagree with the first about what "still current" means. That one is
 * the applicant's own override of a machine-resolved answer: she edits the review screen, and the
 * record carries her claim plus the resolver value she was overriding.
 *
 * ITS CALLER STILL ASKS ABOUT SHAPE, JUST THE OTHER WAY ROUND, and reading this function as
 * shape-blind would be a mistake. Currency is all this decides; whether a shape is eligible at all is
 * the caller's question. storedOptionAnswerIsCurrent above requires a band, because shape is its proof
 * that the value could not have been computed by the resolver. The override branch in
 * refreshKnownQuestionAnswers requires NOT a band, because a reviewed range is already governed by
 * reviewedOptionBandCoversCurrentValue, which asks the stricter thing a matching derivation cannot -
 * does the range she picked still contain the profile value.
 *
 * ABSENT `derivedFrom` STILL MEANS NO, for the same reason and with the same cost. See
 * refreshKnownQuestionAnswers for the branch that reads this.
 */
export function derivationIsCurrent(
  derivedFrom: string | undefined | null,
  currentProfileValue: string | undefined | null,
): boolean {
  const source = derivedFrom?.trim();
  const current = currentProfileValue?.trim();
  if (!source || !current) return false;
  return source.toLowerCase() === current.toLowerCase();
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

function monthIndex(value: string): number | undefined {
  const normalized = value.trim().toLowerCase();
  const index = MONTHS.findIndex((month) => month === normalized
    || (normalized.length >= 3 && month.startsWith(normalized)));
  return index < 0 ? undefined : index + 1;
}

function monthYearValue(value: string): number | undefined {
  const match = /^([A-Za-z]{3,9})\s+((?:19|20)\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const month = monthIndex(match[1]);
  return month === undefined ? undefined : Number(match[2]) * 12 + month;
}

/**
 * Whether a reviewed employer range still contains the current exact profile value.
 *
 * This is intentionally narrower than optionBandAnswer. It accepts only numeric ranges and
 * month-year ranges whose endpoints and current value can all be parsed without guessing. It is
 * used only for an answer stamped as the applicant's current review, which lets an older packet
 * recover after losing its discovery provenance without making an arbitrary stale range sticky.
 */
export function reviewedOptionBandCoversCurrentValue(
  answer: string | undefined | null,
  currentProfileValue: string | undefined | null,
): boolean {
  return reviewedOptionBandVerdict(answer, currentProfileValue) === 'covers';
}

/* THE THIRD VERDICT, AND WHY TWO WERE NOT ENOUGH.
 *
 * Measured on the live jobs.lever.co Mytos form, 2026-08-20 (packet 16f1c744). The degree
 * classification control offers UK honours rows and GPA rows; the applicant reviewed and chose
 * "GPA 3.5-3.8" through PUT /review/answers, the route returned 200, and the row genuinely held
 * her value with her claim. The resolver's answer for that label is "Bachelor's Degree" - a value
 * that is not on the control's list at all - so the boolean rule above asked "does GPA 3.5-3.8
 * contain Bachelor's Degree", could not parse the question, said false, and the refresh replaced
 * her review with the resolver value on the very next read. Three fill runs then each reported
 * "no option matched Bachelor's Degree, left for you to choose" about a choice she had already
 * made: the supported edit path could not move this answer, ever, which is the same defect the
 * override branch below the band rule was built to close for non-band answers.
 *
 * The band rule's job is to let the profile CONTRADICT a reviewed range: a graduation window of
 * "August 2028 - December 2028" beside a stated May 2028 is her range against her own fact, and
 * it must lose. That verdict is only pronounceable when the two are in the same dimension. When
 * the resolver's value does not parse into the band's dimension at all, it is answering a
 * different question than the option list poses, and its value can neither confirm nor refute the
 * range - so the caller keeps the reviewed answer instead of replacing it with a string that was
 * never an option. 'incomparable' is that finding, said honestly instead of rounded to false.
 *
 * The endpoints are read by dimension, dates first: a month-year endpoint contains a year, so a
 * numeric read of "January 2028" would call a date band a number band. A bare year band
 * ("2027-2028") compares against the year inside a dated current value, because "May 2028" does
 * carry the fact a year range is about. A labelled numeric endpoint ("GPA 3.5") is its number. */
export type ReviewedBandVerdict = 'covers' | 'contradicts' | 'incomparable';

export function reviewedOptionBandVerdict(
  answer: string | undefined | null,
  currentProfileValue: string | undefined | null,
): ReviewedBandVerdict {
  const band = answer?.trim();
  const current = currentProfileValue?.trim();
  if (!band || !current) return 'incomparable';
  const separator = /\s*(?:[-\u2010-\u2015]|\bto\b|\bthrough\b)\s*/i;
  const parts = band.split(separator);
  if (parts.length !== 2) return 'incomparable';

  const within = (value: number, low: number, high: number): ReviewedBandVerdict => (
    value >= Math.min(low, high) && value <= Math.max(low, high) ? 'covers' : 'contradicts'
  );

  const lowDate = monthYearValue(parts[0]);
  const highDate = monthYearValue(parts[1]);
  if (lowDate !== undefined && highDate !== undefined) {
    const currentDate = monthYearValue(current);
    if (currentDate === undefined) return 'incomparable';
    return within(currentDate, lowDate, highDate);
  }

  const yearOf = (value: string): number | undefined => {
    const match = /^\s*((?:19|20)\d{2})\s*$/.exec(value);
    return match ? Number(match[1]) : undefined;
  };
  const lowYear = yearOf(parts[0]);
  const highYear = yearOf(parts[1]);
  if (lowYear !== undefined && highYear !== undefined) {
    const currentYear = yearOf(current)
      ?? (/\b((?:19|20)\d{2})\b/.exec(current) ? Number(/\b((?:19|20)\d{2})\b/.exec(current)![1]) : undefined);
    if (currentYear === undefined) return 'incomparable';
    return within(currentYear, lowYear, highYear);
  }

  const endpointNumber = (value: string): number => {
    const bare = Number(value);
    if (Number.isFinite(bare)) return bare;
    // A labelled endpoint ("GPA 3.5") is its number; anything with no number stays unparsed.
    const match = /(\d+(?:\.\d+)?)\s*$/.exec(value.trim());
    return match ? Number(match[1]) : Number.NaN;
  };
  const lowNumber = endpointNumber(parts[0]);
  const highNumber = endpointNumber(parts[1]);
  if (Number.isFinite(lowNumber) && Number.isFinite(highNumber)) {
    const currentNumber = Number(current);
    if (!Number.isFinite(currentNumber)) return 'incomparable';
    return within(currentNumber, lowNumber, highNumber);
  }
  return 'incomparable';
}
