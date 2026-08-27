/* QUESTIONS LITOS ALREADY HOLDS THE ANSWER TO.
 *
 * MEASURED, Mercari's Workable form (Class of 2028 Software Engineer Internship), 2026-08-26. The
 * form asks fifteen questions and Litos parked on the first four, every one of which it could
 * already answer from the stored profile or from the question's own text:
 *
 *   1. "...if your application is not a referral, please enter na."   <- the form states the answer
 *   2. "Do you have an employment history with mercari group?"        <- her history is on file
 *   3. "Please inform the name of your attending or graduated school" <- her school is on file
 *   4. "Are you a student graduating in or after april 2027?"         <- her grad date is on file
 *
 * The owner's instruction, 2026-08-26: infer prior employment from the resume, the referral answer
 * is always no, and stop asking for a school and a graduation date that Litos already stores. Every
 * rule here RELAYS a fact she has given Litos or a token the employer itself supplied; none invents
 * one, and each abstains rather than guessing when the fact is missing.
 */

/* ---------------------------------------------------------------------------------------------
 * 1. THE REFERRAL QUESTION, WHICH IS ALWAYS NO.
 *
 * Her standing declaration: she is not referred. Litos relays that rather than holding the form.
 *
 * THE NOT-APPLICABLE TOKEN IS THE EMPLOYER'S, NOT OURS, whenever the employer names one. Mercari
 * writes "please enter na" in the label itself; answering "N/A" there would be a different string
 * from the one the form asked for. So the label is read for its own token first, the control's
 * option list second, and only then does a plain "N/A" apply.
 *
 * THIS RULE NEVER TOUCHES "how did you hear about us". That question asks the acquisition CHANNEL
 * and is owned by referralSource.ts against her stored default; a referral is only one of its
 * possible answers. Confusing the two would answer a channel question with "N/A" and throw away a
 * true answer she has on file.
 * ------------------------------------------------------------------------------------------- */
/* ANY acquisition-channel wording, not just "how did you hear".
 * Widened after the sibling corpus caught it: "Where did you first hear about NASA and who referred
 * you?" is a COMPOUND of a channel question and a referrer question, and a rule that reads only the
 * referrer half would answer half a control. Every one of those labels says hear / learn about /
 * find out, and a pure referrer field never does. */
const HOW_YOU_HEARD =
  /\bhear(?:d)?\b|\blearn(?:ed|t)?\s+(?:about|of)\b|\bfind\s+out\b|\bfound\s+out\b|\bsource\s+of\s+(?:application|referral)\b|\breferral\s+source\b/i;
const ASKS_ABOUT_A_REFERRAL = /\brefer(?:ral|red|rer|ring)\b/i;
const ASKS_FOR_THE_REFERRER = /\b(?:name|who|employee'?s?\s+name|full\s+name)\b/i;
/** "please enter na", "please type N/A", "enter 'none'" - the token the form asked for, verbatim. */
const EMPLOYER_SUPPLIED_TOKEN =
  /\b(?:enter|type|write|input|put|state|fill\s+in)\s+(?:in\s+)?["'“”‘’]?(n\/?a|none|no|not\s+applicable)["'“”‘’]?/i;
const NOT_APPLICABLE_OPTION = /^(?:n\/?a|none|no|not\s+applicable|none\s+of\s+the\s+above)$/i;

export function referralAnswer(
  label: string,
  options?: readonly string[],
): { value: string } | null {
  if (HOW_YOU_HEARD.test(label)) return null;
  if (!ASKS_ABOUT_A_REFERRAL.test(label)) return null;

  const usable = (options ?? []).map((option) => option.trim()).filter(Boolean);
  if (usable.length > 0) {
    /* A closed control: say no in the employer's own wording. A list with no negative entry is not
     * a referral yes/no question at all, so it abstains rather than forcing one. */
    const negative = usable.find((option) => NOT_APPLICABLE_OPTION.test(option));
    return negative ? { value: negative } : null;
  }

  /* FREE TEXT, AND ONLY WHEN THE FORM ITSELF SAYS WHAT TO WRITE.
   *
   * A bare "Name of referring employee" is NOT answered here even though her standing answer is that
   * there is none, and that restraint is measured rather than cautious. The sibling corpus holds
   * labels like "Referral who referred you" that a name-shaped rule would answer, and those parse as
   * incomplete questions whose target is unresolved - a hold is the correct outcome and this rule
   * must not preempt it. What is left is the shape that carries its own instruction: the employer
   * writes "if your application is not a referral, please enter na", so the not-applicable token is
   * the form's own word and answering with it is transcription, not judgement. */
  if (!ASKS_FOR_THE_REFERRER.test(label)) return null;
  const supplied = EMPLOYER_SUPPLIED_TOKEN.exec(label);
  return supplied ? { value: supplied[1] } : null;
}

/* ---------------------------------------------------------------------------------------------
 * 2. "ARE YOU GRADUATING IN OR AFTER <DATE>?", ANSWERED FROM THE DATE ON FILE.
 *
 * An eligibility gate, so the polarity is the whole risk: answering "yes" to a window she falls
 * outside claims an eligibility she does not have. Every part of it is therefore explicit, and
 * anything it cannot read exactly - an unparseable date on either side, a comparison word it does
 * not know, two dates in one label - abstains and goes back to her.
 *
 * Inclusivity is read from the words, not assumed: "in or after" and "on or after" include the
 * named month, a bare "after" does not, and "by"/"before"/"prior to" run the other way.
 * ------------------------------------------------------------------------------------------- */
const MONTHS = ['january','february','march','april','may','june','july','august','september','october','november','december'];

/** Months since year 0, or null. Day precision is never needed by these questions. */
export function monthOrdinal(value: string): number | null {
  const text = value.trim().toLowerCase();
  const withMonth = /(?:^|\b)([a-z]{3,9})\.?[\s,\/-]+(\d{4})(?:$|\b)/.exec(text)
    ?? /(?:^|\b)(\d{4})[\s,\/-]+([a-z]{3,9})(?:$|\b)/.exec(text);
  if (withMonth) {
    const [a, b] = [withMonth[1], withMonth[2]];
    const monthToken = /^\d{4}$/.test(a) ? b : a;
    const yearToken = /^\d{4}$/.test(a) ? a : b;
    const index = MONTHS.findIndex((m) => m.startsWith(monthToken.slice(0, 3)));
    if (index < 0) return null;
    return Number(yearToken) * 12 + index;
  }
  const numeric = /(?:^|\b)(\d{1,2})[\/-](\d{4})(?:$|\b)/.exec(text);
  if (numeric) {
    const month = Number(numeric[1]);
    if (month < 1 || month > 12) return null;
    return Number(numeric[2]) * 12 + (month - 1);
  }
  const yearOnly = /(?:^|\b)(\d{4})(?:$|\b)/.exec(text);
  if (yearOnly) return Number(yearOnly[1]) * 12;
  return null;
}

const COMPARISON_WORD =
  String.raw`(in\s+or\s+after|on\s+or\s+after|or\s+later|after|from|on\s+or\s+before|before|by|prior\s+to)`;
const DATED = String.raw`((?:[a-z]{3,9}\.?\s+)?\d{4})`;
const GRADUATION_WINDOW = new RegExp(String.raw`\bgraduat\w*\b[\s\S]{0,40}?\b${COMPARISON_WORD}\s+${DATED}`, 'i');
/* A SECOND WINDOW ANYWHERE AFTER THE FIRST MAKES THE LABEL COMPOUND, and this deliberately does NOT
 * require "graduat" to repeat. "graduating after 2026 and before 2028" states one range in two
 * halves, and a guard that looked for the whole first pattern again missed the second half entirely
 * - measured by this module's own test before it shipped. A compound range is a question this rule
 * does not answer, so it abstains rather than reporting the first half's verdict as the whole. */
const ANOTHER_WINDOW = new RegExp(String.raw`\b${COMPARISON_WORD}\s+${DATED}`, 'i');

export function graduationWindowAnswer(
  label: string,
  graduationDate: string | undefined,
  options?: readonly string[],
): { value: string } | null {
  if (!graduationDate) return null;
  const match = GRADUATION_WINDOW.exec(label);
  if (!match) return null;
  // Two windows in one label is a compound question, not this rule's.
  if (ANOTHER_WINDOW.test(label.slice(match.index + match[0].length))) return null;

  const hers = monthOrdinal(graduationDate);
  const threshold = monthOrdinal(match[2]);
  if (hers === null || threshold === null) return null;

  const word = match[1].toLowerCase().replace(/\s+/g, ' ');
  const bareYear = !/[a-z]{3,9}\.?\s+\d{4}/i.test(match[2]);
  let yes: boolean;
  if (word === 'in or after' || word === 'on or after' || word === 'or later' || word === 'from') {
    yes = hers >= threshold;
  } else if (word === 'after') {
    // Exclusive. A bare year means "after 2027" = 2028 onward.
    yes = hers >= (bareYear ? threshold + 12 : threshold + 1);
  } else if (word === 'before' || word === 'prior to') {
    // Exclusive both ways: "before April 2027" and "before 2027" each exclude the named point.
    yes = hers < threshold;
  } else if (word === 'on or before' || word === 'by') {
    // Inclusive. A bare year includes all twelve of its months.
    yes = hers <= (bareYear ? threshold + 11 : threshold);
  } else {
    return null;
  }

  const usable = (options ?? []).map((option) => option.trim()).filter(Boolean);
  if (usable.length > 0) {
    const wanted = usable.find((option) => (yes ? /^(?:yes|y)$/i : /^(?:no|n)$/i).test(option));
    return wanted ? { value: wanted } : null;
  }
  return { value: yes ? 'Yes' : 'No' };
}
