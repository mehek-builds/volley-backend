/**
 * WHETHER AN ANSWER LITOS OWES TO A STANDING PERMISSION MAY BE PUT ON AN EMPLOYER'S CONTROL.
 *
 * Not whether the permission exists, and not what the answer is. Both of those are decided
 * elsewhere and are unchanged. This is the separate question of whether the runner can be trusted
 * to put that answer on THE CONTROL IT WAS ASKED ABOUT, and today it cannot.
 *
 * THE MEASUREMENT, taken in real Chromium against the shipped runner in stratus-browser-cloud.
 * `clickMatchingOption`'s literal-exact tier queries page-wide, because `menuRoot()` falls back to
 * `page`, and it is the only tier with no ambiguity guard; `clickIfPresent` then takes `.first()`.
 * So when two questions on one page offer a row with the same text, filling one can click the
 * other's:
 *
 *   Q1  an always-rendered role="listbox" background-check CONSENT, rows Yes / No
 *   Q2  a button combobox for sponsorship, rows Yes / No
 *   ask fill Q2 with "No"
 *
 *   Q1 afterwards : "No"      <- a question nobody asked about was answered
 *   Q2 afterwards : ""        <- the question that WAS asked stayed blank
 *   reported      : filled ["q2"], skipped []
 *
 * READ THAT AGAIN BEFORE FLIPPING THIS. The wrong control was ticked, the right one was left empty,
 * and the run reported success. There is no signal downstream that can recover it: portalSubmission
 * verifies presence, never identity, so a control holding the wrong option reads as satisfied.
 *
 * WHY THE CONSENT CLASS SPECIFICALLY IS HELD BEHIND IT. Every other misfill is a wrong answer that
 * an employer reads as a wrong answer. A consent, a code of conduct, a background-check
 * authorization or a sponsorship declaration is a legally operative statement made in the
 * applicant's name, and the harm is not that the value is wrong. The value is usually the one she
 * would have chosen. The harm is that it landed on a DIFFERENT DECLARATION than the one Litos was
 * reasoning about, so the thing she is recorded as having agreed to is not the thing anybody
 * decided she agreed to. That cannot be withdrawn by re-running the form.
 *
 * IF YOU ASSUMED TICKING A CONSENT IS LOW-RISK BECAUSE THE ANSWER IS ALWAYS "YES", DROP IT. The
 * risk here is not the value. It is the target.
 *
 * ONE PREDICATE FOR BOTH CLASSES, deliberately, rather than a flag per feature. The consent and
 * code-of-conduct grants and the work-authorization and sponsorship declarations are held on the
 * same evidence, they become safe on the same day, and two switches is how one of them gets left
 * closed or opened alone. See the note on the second export below for the half that is declared
 * here and not yet called.
 *
 * HOW TO OPEN IT. stratus-browser-cloud PR 50, "One question, one answer, whatever control it is
 * served as", is under independent review and is NOT merged. When it is merged AND deployed, change
 * the single `false` below to `true`, record the deploy date in this comment the way
 * canFillReviewedQuestions in lib/portalSubmission.ts records PR 6's, and run the suite: the tests
 * in grantedAnswerReplay.test.ts assert both sides of this switch, so nothing needs rewriting to
 * flip it.
 *
 * KEPT AS A FUNCTION rather than inlined or deleted on the day it opens, following
 * canFillReviewedQuestions: it is the switch to reach for if the runner regresses, and the history
 * above is the reason it exists.
 */
export function exactControlTargetingDeployed(): boolean {
  return false;
}

/**
 * Whether a consent or code-of-conduct acceptance owed to a standing permission may be produced.
 *
 * Called from lib/applicationProfileLike.ts, at the ONE place where a granted column becomes a
 * licence the resolver can see. Holding it there rather than at the fill site is deliberate and it
 * is the only version of this that is actually safe: the resolver, the Apply screen's pre-script,
 * the packet audit and the consent trail all read the same derived permission, so suppressing it
 * once means no surface can produce an acceptance the others do not know about. A gate applied at
 * the fill site would leave the review screen showing an answer the runner would never put down.
 *
 * WHAT THIS DOES NOT DO: it does not revoke, clear, or fail to record the grant. The columns keep
 * the applicant's decision, its date and its version exactly as she made them, /onboarding/state
 * keeps reporting the grant she gave, and the day the switch above flips, every account that
 * granted the permission has it, with the original date intact. Collecting the permission and
 * acting on it are separate, and only the second one is held.
 *
 * With this closed, a consent label resolves EXACTLY as it did before PR 502: the licence is
 * absent, consentAcknowledgementAnswer returns null, and applicationConsentAnswer's named refusal
 * hands the control back to the applicant.
 */
export function consentAcceptanceMayReachControls(): boolean {
  return exactControlTargetingDeployed();
}

/** The six columns scripts/apply-consent-acceptance-schema.mjs adds, as the derivation reads them. */
export type AcknowledgementPermissionRow = {
  automatic_consent_acceptance_enabled?: boolean | null;
  automatic_consent_acceptance_consented_at?: Date | null;
  automatic_consent_acceptance_consent_version?: string | null;
  automatic_conduct_acceptance_enabled?: boolean | null;
  automatic_conduct_acceptance_consented_at?: Date | null;
  automatic_conduct_acceptance_consent_version?: string | null;
};

export type AcknowledgementPermissions = {
  consent_acknowledgement_permission?: { granted_at?: string; version: string };
  conduct_acknowledgement_permission?: { granted_at?: string; version: string };
};

/**
 * The two licences the resolver sees, from the columns and the gate together.
 *
 * PULLED OUT OF loadApplicationProfileLike SO IT CAN BE DRIVEN BY A TEST. That function reads five
 * tables and cannot be called without a database, so while this decision lived inside it the only
 * way to check the gate was to read the source and believe it. A rule that only a source-grep can
 * reach is a rule nothing is actually holding: the whole point of this module is that the hold is
 * measurable, so `mayReach` is a parameter and both sides of it are asserted.
 *
 * The default is the real gate, so production has exactly one answer and no caller can pass its
 * own opinion by accident.
 */
export function acknowledgementPermissionsFor(
  row: AcknowledgementPermissionRow | null | undefined,
  granted: {
    consent: (row: AcknowledgementPermissionRow | null | undefined) => boolean;
    conduct: (row: AcknowledgementPermissionRow | null | undefined) => boolean;
    consentVersion: string;
    conductVersion: string;
  },
  mayReach: boolean = consentAcceptanceMayReachControls(),
): AcknowledgementPermissions {
  return {
    consent_acknowledgement_permission: granted.consent(row) && mayReach
      ? { granted_at: row?.automatic_consent_acceptance_consented_at?.toISOString(), version: granted.consentVersion }
      : undefined,
    conduct_acknowledgement_permission: granted.conduct(row) && mayReach
      ? { granted_at: row?.automatic_conduct_acceptance_consented_at?.toISOString(), version: granted.conductVersion }
      : undefined,
  };
}

/**
 * The same gate for the work-authorization and sponsorship class. DECLARED, NOT YET CALLED.
 *
 * It is written here rather than left for later because the whole point of one predicate is that
 * both classes flip together, and a second author adding a second switch later is the failure this
 * file is shaped to prevent. It is not yet wired because wiring it correctly is not a one-line
 * change and pretending otherwise would produce a gate that looks closed and is not:
 *
 *   The class must be held only where the defect reaches it, which is an OPTION-SHAPED control.
 *     A work-authorization question served as a text input has no row for the runner to mis-click,
 *     and holding those as well would take away answers that work today, on the commonest shape.
 *   workEligibilityAnswer does not receive the control's option list. resolveKnownAnswer has no
 *     `options` parameter on this branch, so the resolver cannot currently tell the two shapes
 *     apart, and adding that parameter is a change to five call sites that belongs with the
 *     per-jurisdiction work-eligibility collection rather than being bolted onto a safety hold.
 *   The legacy US scalars answer through a different branch from the scoped records, so a gate
 *     placed carelessly would hold one and not the other.
 *
 * Wire it at the same time as the per-jurisdiction declaration work, and delete this paragraph
 * then. Until it is called, the work-authorization class behaves exactly as it does on main today,
 * which is the pre-existing behaviour and not a regression introduced here.
 */
export function workEligibilityReplayMayReachControls(): boolean {
  return exactControlTargetingDeployed();
}
