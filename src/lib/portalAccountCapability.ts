import type { PortalFamily } from './portalSubmission';

/**
 * WHETHER LITOS COULD OPEN AN ACCOUNT ON THIS PLATFORM AT ALL.
 *
 * The second half of the account-creation gate. `accountCreationGranted` answers "did she allow
 * it"; this answers "can it be done here without doing something Litos does not do". Both must say
 * yes, and they are deliberately separate values: a permission is about the applicant, a capability
 * is about the platform, and collapsing them is how a granted permission starts meaning "try
 * anyway" on a platform where trying means defeating a challenge.
 *
 * THE BAR, and all three clauses are required:
 *   1. the signup is reachable without a human-verification challenge;
 *   2. identity is proved by a ONE-TIME CODE sent to an email address, never a password;
 *   3. the code goes to an address Litos already owns for this application - the packet's routing
 *      alias - so no new mailbox and no forwarding rule is involved.
 *
 * WHY NO FAMILY IS ELIGIBLE ON A GUESS. Every entry below is either a live capture recorded in
 * litos-ats-dom-capture-2026-07-29.md or an explicit "not read yet". A family defaults to NOT
 * eligible, so adding one to PortalFamily cannot quietly grant it account creation; the exhaustive
 * record here is what a test asserts against.
 */
export type PortalAccountCapability = {
  /** True only when all three clauses of THE BAR hold. */
  eligible: boolean;
  /** Why, in the words the applicant would be shown if she asked. */
  reason: string;
};

const NOT_READ = 'Litos has not read this platform is signup, so it does not claim it can open an account there.';

const CAPABILITIES: Readonly<Record<string, PortalAccountCapability>> = {
  /* THE ONE CANDIDATE, and it is a candidate rather than a certainty until a live signup is walked.
   * Read 2026-07-29: the apply route lands on an "Authentication screen" that EMAILS a one-time
   * code, beside a legal "I agree with the terms and conditions" checkbox. Code-to-email with no
   * password is exactly the bar; the terms checkbox is a consent-acceptance question and is gated by
   * its own permission, not by this one. */
  oraclecloud: {
    eligible: true,
    reason: 'This platform emails a one-time code instead of asking for a password, so Litos can open an account using your Litos application address.',
  },
  /* A CHALLENGE IS A HARD NO, whatever else is true. Read 2026-07-29: the apply route redirects to
   * /login, which is an email field plus an h-captcha-response textarea. Litos does not attempt
   * challenges, so this family is out of reach with the permission granted exactly as without it -
   * which is the sentence the permission wording promises and this entry is what makes it true. */
  icims: {
    eligible: false,
    reason: 'This platform checks you are human before it will open an account, and Litos never answers that check.',
  },
  /* Read 2026-07-29: the board bootstraps through an AnonymousSessionCheck iframe and never rendered
   * its job content to an automated browser, so there is no signup to walk, let alone automate. */
  ultipro: {
    eligible: false,
    reason: 'This platform does not render its application to Litos at all, so there is nothing to open an account against.',
  },
  sap_successfactors: { eligible: false, reason: NOT_READ },
  oracle_taleo: { eligible: false, reason: NOT_READ },
  adp_recruiting: { eligible: false, reason: NOT_READ },
  avature: { eligible: false, reason: NOT_READ },
  jobvite: { eligible: false, reason: NOT_READ },
};

/**
 * A family Litos has no account-creation record for is NOT eligible, and says so plainly.
 *
 * Defaulting to ineligible rather than throwing is deliberate: this is read on the submission path,
 * and a new PortalFamily must degrade to "Litos will not open an account here" rather than break a
 * fill that was never about account creation in the first place.
 */
export function portalAccountCapability(family: PortalFamily | string): PortalAccountCapability {
  return CAPABILITIES[family] ?? { eligible: false, reason: NOT_READ };
}

/**
 * The whole gate, in one place, so no caller can check one half and forget the other.
 *
 * Order matters only for the sentence it hands back: a platform that cannot do it says so before a
 * permission question is raised, because "turn this on" is the wrong thing to tell someone about a
 * platform where turning it on changes nothing.
 */
export function mayOpenPortalAccount(
  family: PortalFamily | string,
  granted: boolean,
): { allowed: boolean; reason: string } {
  const capability = portalAccountCapability(family);
  if (!capability.eligible) return { allowed: false, reason: capability.reason };
  if (!granted) {
    return {
      allowed: false,
      reason: 'Litos can open an account for you here, but you have not turned that on yet.',
    };
  }
  return { allowed: true, reason: capability.reason };
}
