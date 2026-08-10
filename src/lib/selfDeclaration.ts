/**
 * SELF-DECLARATIONS: the questions Litos may relay an answer to and may never compose one for.
 *
 * A self-declaration is a question whose answer is a STATEMENT THE APPLICANT MAKES about herself:
 * her legal status, her record, her intentions, her level of skill, or her agreement to a term.
 * Nothing in a resume, a job description, or an adjacent profile column is evidence for one. The
 * only admissible source is the applicant saying it, either in onboarding or in the ask-at-Apply
 * step this module exists to serve.
 *
 * THE RULE, and it has one word in it that carries everything: Litos may RELAY a declaration she
 * has made and may never GENERATE one. Relaying is what application_profile.politically_exposed and
 * the saved-answer store do. Generating is what a catch-all classifier, a default value, or an
 * essay drafter does, and all three have shipped a false statement to an employer from this
 * codebase:
 *
 *   - a politically-exposed-person declaration answered "Dubai", because a residence rule matched
 *     the word "state" inside "state-owned bank";
 *   - a 600-word drafted essay opening "I have not applied to Akuna in the past", with nothing on
 *     file that said so;
 *   - an auto-"Yes" to "this role is my top preference and I will not be considered for other tech
 *     and/or quant roles at Akuna this season", a binding commitment over a whole recruiting
 *     season.
 *
 * Each of those was fixed where it happened. This module is the general form of the fix: one
 * predicate the drafter and the pre-script both consult, so a NEW self-declaration that no specific
 * rule in questionDiscovery.ts recognises still cannot be answered by a machine. It is deliberately
 * a superset of the labels resolveKnownAnswer already refuses; overlapping with them is the point,
 * because the harm is a question that falls through every specific rule.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not decide the answer, and it does not stop a STORED
 * declaration from being used - resolveKnownAnswer still owns that, unchanged. It answers exactly
 * one question: may a machine invent this answer? No, never.
 */

import {
  AGE_ATTESTATION_QUESTION,
  AI_INTERVIEW_POLICY_QUESTION,
  BARE_PRIVACY_ACKNOWLEDGEMENT,
  CODE_OF_CONDUCT_ACKNOWLEDGEMENT,
  EEO_QUESTION,
  EMPLOYER_RESTRICTION_AGREEMENT_QUESTION,
  EXPORT_CONTROL_QUESTION,
  FURTHER_EDUCATION_DEGREE_TYPE_QUESTION,
  FURTHER_EDUCATION_PLAN_QUESTION,
  HIGH_SCHOOL_DIPLOMA_CONFIRMATION_QUESTION,
  HIGH_SCHOOL_GRADUATION_QUESTION,
  LEGAL_CONSENT_QUESTION,
  MILITARY_SERVICE_QUESTION,
  OFFER_DEADLINE_QUESTION,
  POLITICALLY_EXPOSED_FAMILY_QUESTION,
  POLITICALLY_EXPOSED_PERSON_QUESTION,
  POTENTIAL_ADVANCED_GRADUATION_DATE_QUESTION,
  isPriorApplicationQuestion,
  PRONOUNS_QUESTION,
  RESUME_PDF_ACKNOWLEDGEMENT,
  ROUTINE_APPLICANT_CONSENT_QUESTION,
  TOP_ROLE_PREFERENCE_ACKNOWLEDGEMENT,
  TRUE_COMPLETE_ACCURATE_CERTIFICATION,
  UNRESTRICTED_WORK_AUTHORIZATION_QUESTION,
  WORK_AUTHORIZATION_DETAIL_QUESTION,
  WORK_ELIGIBILITY_QUESTION,
} from './questionDiscovery';

/**
 * "Please rate your skill level in C++" and its fifteen siblings on one DRW form.
 *
 * A self-rating is a declaration and not a lookup, however plainly the resume names the skill. A
 * resume that lists C++ says the applicant has used C++; it does not say she is an expert in it,
 * and the difference between "Beginner" and "Expert" on a trading firm's screening form is a claim
 * she is the only person entitled to make. Litos had no rule for these at all, so all sixteen fell
 * through to the essay drafter or to nothing.
 *
 * Deliberately does NOT match "years of experience", which a dated resume genuinely answers.
 */
export const SKILL_SELF_RATING_QUESTION =
  /\b(?:rate|rating)\b[^?]{0,80}\b(?:skill|proficien\w*|competen\w*|expertise|familiarity|ability|level)\b|\b(?:skill|proficiency|competency|expertise|familiarity)\s+level\b|\b(?:self[-\s]?(?:rate|rating|assess\w*))\b|\bhow\s+would\s+you\s+rate\s+your\b|\bon\s+a\s+scale\s+of\b[^?]{0,80}\b(?:rate|rank)\b/i;

/**
 * DRW's other shape: "In which settings have you used C++? Select all that apply", five times.
 *
 * Same class as the rating. The setting a skill was used in (coursework, personal project,
 * internship, production) is a claim about her own history whose option list is the employer's, and
 * a resume line naming the skill does not pick one of them.
 */
export const SKILL_USAGE_SETTING_QUESTION =
  /\b(?:in\s+)?(?:which|what)\s+(?:settings?|contexts?|environments?|capacit(?:y|ies))\b[^?]{0,120}\b(?:have\s+you\s+)?(?:used|worked\s+with|applied|written)\b|\b(?:used|worked\s+with|applied)\b[^?]{0,80}\b(?:in\s+)?(?:which|what)\s+(?:settings?|contexts?|environments?)\b/i;

/**
 * Criminal-record, background-check and drug-screening declarations.
 *
 * Not measured on the 25-packet run and included anyway, for the same reason the export-control
 * shape was added before anything was stored for it: this is the highest-consequence question an
 * employer form can ask, nothing on file could ever answer it, and there is no rule anywhere in
 * this codebase that recognises it today. A catch-all reaching one of these is the worst version of
 * the "Dubai" defect.
 */
export const BACKGROUND_DECLARATION_QUESTION =
  /\b(?:convicted|conviction|criminal\s+(?:record|history|offen[cs]e)|felony|misdemean\w*|plead(?:ed)?\s+guilty|background\s+(?:check|investigation|screening)|drug\s+(?:test|screen\w*)|security\s+clearance)\b/i;

/**
 * Every pattern whose answer is a statement the applicant makes about herself.
 *
 * Ordered by how badly a wrong answer lands rather than alphabetically, so the list reads as the
 * argument for its own existence.
 */
const SELF_DECLARATION_QUESTIONS: readonly RegExp[] = [
  // Statements to a government or a regulator.
  EXPORT_CONTROL_QUESTION,
  POLITICALLY_EXPOSED_PERSON_QUESTION,
  POLITICALLY_EXPOSED_FAMILY_QUESTION,
  BACKGROUND_DECLARATION_QUESTION,
  // Legal status and eligibility.
  WORK_ELIGIBILITY_QUESTION,
  WORK_AUTHORIZATION_DETAIL_QUESTION,
  UNRESTRICTED_WORK_AUTHORIZATION_QUESTION,
  MILITARY_SERVICE_QUESTION,
  // Agreements and consents, including the two Litos may tick from a stored consent. They stay on
  // this list: "may be relayed from a stored consent" and "may never be invented" are compatible,
  // and it is the second one this list enforces.
  TRUE_COMPLETE_ACCURATE_CERTIFICATION,
  TOP_ROLE_PREFERENCE_ACKNOWLEDGEMENT,
  RESUME_PDF_ACKNOWLEDGEMENT,
  CODE_OF_CONDUCT_ACKNOWLEDGEMENT,
  BARE_PRIVACY_ACKNOWLEDGEMENT,
  ROUTINE_APPLICANT_CONSENT_QUESTION,
  LEGAL_CONSENT_QUESTION,
  AGE_ATTESTATION_QUESTION,
  AI_INTERVIEW_POLICY_QUESTION,
  EMPLOYER_RESTRICTION_AGREEMENT_QUESTION,
  // The applicant's own record and intentions.
  OFFER_DEADLINE_QUESTION,
  FURTHER_EDUCATION_PLAN_QUESTION,
  FURTHER_EDUCATION_DEGREE_TYPE_QUESTION,
  POTENTIAL_ADVANCED_GRADUATION_DATE_QUESTION,
  HIGH_SCHOOL_GRADUATION_QUESTION,
  HIGH_SCHOOL_DIPLOMA_CONFIRMATION_QUESTION,
  // Identity and self-assessment.
  PRONOUNS_QUESTION,
  EEO_QUESTION,
  SKILL_SELF_RATING_QUESTION,
  SKILL_USAGE_SETTING_QUESTION,
];

/** True when the answer to this label would be a statement the applicant makes about herself. */
export function isSelfDeclarationQuestion(label: string): boolean {
  const value = (label ?? '').trim();
  if (!value) return false;
  if (isPriorApplicationQuestion(value)) return true;
  return SELF_DECLARATION_QUESTIONS.some((pattern) => pattern.test(value));
}

/**
 * The sentence a run gives the applicant when it declines to draft a self-declaration.
 *
 * Names the refusal rather than the failure. "We could not draft an answer" would be false: nothing
 * was attempted, on purpose, and telling her it was attempted invites her to retry it.
 */
export function selfDeclarationSkipReason(label: string): string {
  return `this one is a declaration about you, so Litos will not write it: "${label.slice(0, 60)}"`;
}
