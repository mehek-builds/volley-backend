import { normalizeReviewQuestionLabel } from './questionDiscovery';
import type { CountryWorkEligibility } from './workEligibility';

/**
 * Turning what an employer asked, and what the applicant answered, into a work-eligibility record.
 *
 * WHY THIS EXISTS. The work-visa screen asks four radio buttons every student, and measured across
 * 318 real packets ~40% of first applications already ask both halves of the same question in the
 * employer's own words. Asking a second time is a screen nobody needs. This module is what lets
 * the flow skip it: when the posting asked, the answer becomes the account's declaration for that
 * posting's country, and the screen never appears.
 *
 * THE RULE THAT KEEPS IT SAFE, and it is the whole reason this is narrow rather than clever.
 * A stored record needs three booleans - authorized_now, needs_sponsorship_now,
 * needs_sponsorship_future - and one sponsorship question answers at most two of them. Guessing
 * the rest writes a FALSE LEGAL DECLARATION on the applicant's behalf, which is the exact class of
 * harm lib/selfDeclaration.ts documents three times over: a residence rule that answered a
 * politically-exposed-person question "Dubai", a drafted essay claiming she had not applied
 * somewhere, an auto-Yes to a binding season-long commitment.
 *
 * So this returns a record ONLY when the posting asked BOTH the authorization question and the
 * sponsorship question, and both answers read cleanly as yes or no. Anything less returns null and
 * the student is asked directly. Measured: that is ~40% skipped and ~60% still asked, which is the
 * honest split rather than the flattering one.
 */

/* The same two patterns questionDiscovery.ts classifies with. Imported by copy rather than by
   reference because that module's are not exported, and duplicated deliberately with this comment
   so a change there is a visible mismatch here rather than a silent divergence. */
const WORK_AUTHORIZATION_QUESTION =
  /(?:eligible|eligibility)\s+(?:to\s+)?(?:legally\s+)?work|authori[sz](?:ed|ation)\s+to\s+work|legally\s+authori[sz]ed|right\s+to\s+work|work\s+authori[sz]/i;
const SPONSORSHIP_QUESTION =
  /(?:requir\w*|need\w*|visa|immigration|without|employment)\s+(?:\w+\s+){0,3}sponsor|sponsor\w*\s+(?:\w+\s+){0,3}(?:requir\w*|need\w*)/i;

/** "now" versus "in the future", which decides which of the two sponsorship booleans an answer sets. */
const FUTURE_ONLY = /\bin the future\b|\bfuture sponsorship\b/i;
const NOW_ONLY = /\b(?:currently|now|at present|before (?:you|the applicant) start|to (?:begin|start) work)\b/i;

export type EmployerAnswer = { question: string; answer: string };

/** A clean yes or no, or null when the answer is anything else. Null is a refusal to interpret. */
export function yesNo(answer: string): boolean | null {
  const value = (answer ?? '').trim().toLowerCase();
  if (!value) return null;
  if (/^(yes|y|true)\b/.test(value)) return true;
  if (/^(no|n|false)\b/.test(value)) return false;
  /* Deliberately NOT matching "decline to answer", "prefer not to say" or a free-text sentence.
     A declaration inferred from a refusal to declare is the worst possible version of this. */
  return null;
}

export function isAuthorizationQuestion(question: string): boolean {
  return WORK_AUTHORIZATION_QUESTION.test(normalizeReviewQuestionLabel(question ?? '') || question || '');
}

export function isSponsorshipQuestion(question: string): boolean {
  return SPONSORSHIP_QUESTION.test(normalizeReviewQuestionLabel(question ?? '') || question || '');
}

/**
 * The record to store for `countryCode`, or null when the answers do not support one.
 *
 * Null is the common and correct outcome. Callers must treat it as "ask the student", never as
 * "assume nothing is needed": an absent declaration and a declaration of no-need are different,
 * and only the first is true here.
 */
export function declarationFromEmployerAnswers(
  answers: readonly EmployerAnswer[],
  countryCode: string | null | undefined,
): CountryWorkEligibility | null {
  const country = (countryCode ?? '').trim().toUpperCase();
  /* No country means no record. work_eligibility_by_country is keyed by country precisely because
     being allowed to work in one says nothing about another, so a record filed under a guess is
     worse than no record. Postings carry 'unknown' when the ingest could not resolve one. */
  if (!/^[A-Z]{2}$/.test(country)) return null;

  const authorization = answers.find((item) => isAuthorizationQuestion(item.question));
  const sponsorship = answers.find((item) => isSponsorshipQuestion(item.question));
  if (!authorization || !sponsorship) return null;

  const authorized = yesNo(authorization.answer);
  const needsSponsorship = yesNo(sponsorship.answer);
  if (authorized === null || needsSponsorship === null) return null;

  /* WHICH sponsorship boolean this answer sets, read off the employer's own wording.
     A question naming only the future leaves the now-answer unstated, and an unstated answer is
     derived from the authorization one rather than invented: somebody authorized now does not need
     sponsorship now, by definition of being authorized. Somebody NOT authorized now and not
     needing sponsorship now is a combination the schema rejects outright, which is the schema
     catching an incoherent pair rather than this module papering over one. */
  const label = sponsorship.question;
  const futureOnly = FUTURE_ONLY.test(label) && !NOW_ONLY.test(label);
  const nowOnly = NOW_ONLY.test(label) && !FUTURE_ONLY.test(label);

  /* UNSTATED IS NOT FALSE, and this is where the first draft of this module was wrong.
     It derived needs_sponsorship_now from a FUTURE-only question by assuming an unauthorized
     applicant must need sponsorship now, which invents a declaration out of a question that never
     asked it. The rule is simply: a half the employer did not ask is a half this cannot answer.

     authorized_now settles the now-half by itself when it is true - somebody authorized to work
     now does not need sponsorship to work now, definitionally - so only the unauthorized case
     depends on the employer having asked. */
  const asksNow = !futureOnly;
  const asksFuture = !nowOnly;

  const needsNow = authorized ? false : (asksNow ? needsSponsorship : null);
  const needsFuture = asksFuture ? needsSponsorship : null;
  if (needsNow === null || needsFuture === null) return null;

  /* The schema's own invariant, checked here so an incoherent pair returns null and reaches the
     student rather than throwing inside a write. */
  if (!authorized && !needsNow) return null;

  return {
    country_code: country,
    authorized_now: authorized,
    needs_sponsorship_now: needsNow,
    needs_sponsorship_future: needsFuture,
    authorization_type: null,
    authorization_expiry: null,
  } as CountryWorkEligibility;
}

/**
 * The account-level answer the declaration implies, for `sponsorship_required_at_onboarding`.
 *
 * That column is what turns the sponsor-only board filter on, and it is a single account-wide
 * boolean while eligibility is per country. Needing sponsorship ANYWHERE is what the filter cares
 * about, so either half being true answers it.
 */
export function accountSponsorshipAnswer(record: CountryWorkEligibility): 'yes' | 'no' {
  return record.needs_sponsorship_now || record.needs_sponsorship_future ? 'yes' : 'no';
}
