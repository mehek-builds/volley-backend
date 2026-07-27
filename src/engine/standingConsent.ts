/**
 * Unattended submission has to be EARNED, not offered.
 *
 * Litos can already submit an application without stopping for the student: standing consent turns
 * `ready_for_final_approval` into `submitting` (see lib/submissionAuthorization.ts). That switch is
 * the single most dangerous control in the product, and the competitive evidence is unambiguous
 * about which way to point it.
 *
 * LazyApply sells exactly this, priced by daily application cap, and its Trustpilot distribution is
 * 44% five-star and 52% one-star. The one-star half is not people who disliked the UI: it is
 * relevance collapse and, repeatedly, LinkedIn accounts permanently restricted for what the
 * platform read as fraudulent activity. Jobscan, at the other end, keeps a mandatory human review
 * before every auto-apply submit and its reviewers name that as a reason to trust it.
 *
 * So: the gate is ON by default and the opt-out unlocks only after the student has personally
 * approved MIN_REVIEWED_SUBMITS real submissions. The number is small on purpose. This is not a
 * loyalty hurdle, it is the smallest sample in which a student can see what Litos actually fills in
 * on a real form before handing over the click. Someone who has watched three go out and land
 * correctly is making an informed choice; someone toggling it during onboarding, before they have
 * seen a single filled form, is not.
 *
 * Enforced SERVER-SIDE. Hiding the toggle in the UI is a presentation detail, and this control is
 * the one where a client that lies must not be believed.
 */

export const MIN_REVIEWED_SUBMITS = 3;

export interface ConsentEligibility {
  eligible: boolean;
  /** Submissions the student personally approved that actually reached the employer. */
  reviewed_submits: number;
  required: number;
  remaining: number;
}

export function standingConsentEligibility(reviewedSubmits: number): ConsentEligibility {
  const count = Number.isFinite(reviewedSubmits) && reviewedSubmits > 0 ? Math.floor(reviewedSubmits) : 0;
  return {
    eligible: count >= MIN_REVIEWED_SUBMITS,
    reviewed_submits: count,
    required: MIN_REVIEWED_SUBMITS,
    remaining: Math.max(0, MIN_REVIEWED_SUBMITS - count),
  };
}

/**
 * May this change to the automatic-submission setting be accepted?
 *
 * Turning it OFF is always allowed, from any state. A safety gate the student cannot re-arm is not
 * a safety gate, and someone reaching for the off switch is the one case where hesitating is
 * indefensible.
 */
export function mayChangeStandingConsent(options: {
  enabling: boolean;
  eligibility: ConsentEligibility;
}): { allowed: true } | { allowed: false; reason: string } {
  if (!options.enabling) return { allowed: true };
  if (options.eligibility.eligible) return { allowed: true };
  const { remaining, required } = options.eligibility;
  return {
    allowed: false,
    reason:
      `Litos submits with your approval until you have approved ${required} applications yourself. ` +
      `${remaining} to go. That way you have seen what it fills in on a real form before it sends one without you.`,
  };
}
