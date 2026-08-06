/**
 * Standing consent is an explicit account-level permission, not an earned unlock.
 *
 * Litos still writes versioned consent evidence and still refuses unsafe runs elsewhere: CAPTCHA,
 * sensitive questions, unsupported portals, eligibility blockers, incomplete filled-form evidence,
 * and daily caps remain separate gates. This module only answers whether the user may turn the
 * account-level automatic submission setting on.
 */

export const MIN_REVIEWED_SUBMITS = 0;

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
  void options.eligibility;
  return { allowed: true };
}
