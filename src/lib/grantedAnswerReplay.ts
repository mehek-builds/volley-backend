/**
 * WHETHER AN ANSWER LITOS OWES TO A STANDING PERMISSION MAY BE PUT ON AN EMPLOYER'S CONTROL.
 *
 * Not whether the permission exists, and not what the answer is. Both of those are decided
 * elsewhere and are unchanged. This is the separate question of whether the runner can be trusted
 * to put that answer on THE CONTROL IT WAS ASKED ABOUT. It could not when 69a1e74 closed this on
 * 2026-08-12. It can as of 2026-08-13, and the switch below is open. Everything from here to "WHAT
 * OPENED IT" is the state of the world that closed it, kept because it is the reason this function
 * still exists. The hold lasted one day, which is the argument FOR having written it rather than
 * against: the acceptances it withheld in that window were withheld on evidence, and the day the
 * evidence changed the switch moved.
 *
 * THE MEASUREMENT THAT CLOSED IT, taken in real Chromium against the runner shipped in
 * stratus-browser-cloud at the time. `clickMatchingOption`'s literal-exact tier queried page-wide,
 * because `menuRoot()` fell back to `page`, and it was the only tier with no ambiguity guard;
 * `clickIfPresent` then took `.first()`. So when two questions on one page offered a row with the
 * same text, filling one could click the other's:
 *
 *   Q1  an always-rendered role="listbox" background-check CONSENT, rows Yes / No
 *   Q2  a button combobox for sponsorship, rows Yes / No
 *   ask fill Q2 with "No"
 *
 *   Q1 afterwards : "No"      <- a question nobody asked about was answered
 *   Q2 afterwards : ""        <- the question that WAS asked stayed blank
 *   reported      : filled ["q2"], skipped []
 *
 * READ THAT AGAIN BEFORE CLOSING THIS SWITCH AGAIN, OR BEFORE TRUSTING THAT IT IS SAFE TO LEAVE
 * OPEN. The wrong control was ticked, the right one was left empty, and the run reported success.
 * There was no signal downstream that could recover it: portalSubmission verifies presence, never
 * identity, so a control holding the wrong option reads as satisfied. That downstream fact is
 * UNCHANGED by the repair. Nothing on this side of the wire detects a mis-targeted click today
 * either. The reason it is safe now is that the runner no longer makes one, and if that ever stops
 * being true this backend will not notice, which is exactly why the switch below still exists.
 *
 * WHY THE CONSENT CLASS SPECIFICALLY WAS HELD BEHIND IT. Every other misfill is a wrong answer that
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
 * code-of-conduct grants and the work-authorization and sponsorship declarations were held on the
 * same evidence, they became safe on the same day, and two switches is how one of them gets left
 * closed or opened alone. That is still the shape: see the note on the second export below for the
 * half that is declared here and still not called.
 *
 * WHAT OPENED IT. stratus-browser-cloud PR 50, "One question, one answer, whatever control it is
 * served as", merged to main as 0572a94ccc79a196ea6f9a37c51597ff62a81c35 and deployed to Production
 * on 2026-08-13. Recorded here the way canFillReviewedQuestions in lib/portalSubmission.ts records
 * PR 6's. Three changes in that PR are what this switch was waiting on, and they are named because
 * the next person to doubt this switch should check these and not take the date on trust:
 *
 *   The page-wide exact tier is gone. `menuRoot()` returns `scopedMenu ?? declaredMenu`, never
 *     `page`, and the literal-exact tier looks in the question's OWN block first (`widenRoot()`),
 *     reaching the wider root only when the block offers nothing AND the control named its own
 *     menu. Q1's rows are no longer reachable from Q2 by any query, which is the property the
 *     measurement above says was missing. Both arms count offered rows before clicking, so the
 *     tier that had no ambiguity guard now has one on both sides.
 *   The withdrawal is scoped to the widget shell. The old deny-list of neighbour names pressed
 *     controls that were not clears, including "Remove education", which destroyed a Greenhouse
 *     education row and reported one line about a choice not persisting. A clear now has to live
 *     inside the choice control, and a node outside the widget is not a candidate however it is
 *     named.
 *   A refused near miss is put back and blocks the submit. A refusal ends the whole control rather
 *     than the tier that made it, the answer that was there on arrival is restored, and the mark
 *     `data-litos-unverified-choice` plus the pre-submit gate mean the form is not sent while it
 *     carries one. The run reports the refusal as a sentence in `skipped` instead of reporting a
 *     fill it did not make.
 *
 * WHAT IT DOES NOT MEAN. The repair is in the runner, and this file cannot see the runner. Opening
 * this switch is a decision to trust a deploy, not a proof taken here, and no test in this repo can
 * make it one: the tests below drive the gate as a parameter, which is right for asserting both
 * sides and is not evidence about Chromium. The evidence lives in that repo, as
 * test/choice-parity-replay.mjs, which PR 50 added and which replays the Q1/Q2 sequence above in a
 * real browser. `npm run verify` there is what runs it. If you are auditing this switch, that file
 * is the thing to read, not this comment.
 *
 * KEPT AS A FUNCTION rather than inlined or deleted on the day it opened, following
 * canFillReviewedQuestions: it is the switch to reach for if the runner regresses, and the history
 * above is the reason it exists. To close it again, change the single `true` below back to `false`
 * and change the one assertion in grantedAnswerReplay.test.ts that names the state of the world.
 * Both classes close together, which is the point of there being one of these.
 */
export function exactControlTargetingDeployed(): boolean {
  return true;
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
 * WHAT THE HOLD DID NOT DO, WHICH IS WHY THE DAY IT OPENED COST NOBODY ANYTHING: it never revoked,
 * cleared, or failed to record the grant. The columns kept the applicant's decision, its date and
 * its version exactly as she made them, /onboarding/state kept reporting the grant she gave, and on
 * 2026-08-13 every account that had granted the permission simply had it, with the original date
 * intact. Nobody was asked to consent twice. Collecting the permission and acting on it are
 * separate, and only the second one was ever held. Keep that property in any future close: a gate
 * that clears the columns is a different and much worse thing than this one.
 *
 * SO WHAT IS LIVE NOW. A granted, current, unrevoked permission becomes a licence, and the consent
 * and code-of-conduct labels that PR 502 unblocked resolve to an acceptance again. The account
 * owner granted both on 2026-08-12, so hers are live. This produces and displays the acceptance; it
 * does not send anything. `automatic_submission_enabled` is a separate decision and is false, so
 * every one of these still waits on an explicit press.
 *
 * IF THIS IS CLOSED AGAIN, a consent label resolves EXACTLY as it did before PR 502: the licence is
 * absent, consentAcknowledgementAnswer returns null, and applicationConsentAnswer's named refusal
 * hands the control back to the applicant. That path is still tested, on purpose, because it is the
 * one the regression switch buys.
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
 * The same gate for the work-authorization and sponsorship class. DECLARED, NOT CALLED.
 *
 * SO THE CLASS IS NOT HELD, AND OPENING THE SWITCH DID NOT CHANGE THAT. Say it plainly, because a
 * predicate that exists and is never invoked reads like a safeguard and is not one: work
 * authorization and sponsorship answers reach option-shaped controls exactly as they always have,
 * and flipping the shared gate to `true` moved nothing here, because nothing here reads it.
 * Measured, on both sides of the switch, with the owner's stored declaration on file:
 *
 *   "Are you legally authorized to work in the United States?"   ->  "Yes"
 *   "Will you now, or in the future, require sponsorship..."      ->  "Yes"
 *
 * both on a select. There is a test asserting exactly that, in a describe block named KNOWN OPEN. It
 * was re-measured on the day the switch opened, and it still reports the same two answers, which is
 * the evidence that this half stayed unwired rather than being silently switched on with the other
 * one.
 *
 * THAT BLOCK'S TRIPWIRE IS ARMED ONLY WHILE THE GATE IS CLOSED, and opening the gate is what
 * disarmed it. It used to be true without qualification that the block "will fail the day someone
 * wires this". Measured, by wiring the predicate into workEligibilityAnswer and running the file:
 * gate closed gives 5 failures, two of them in that block; gate open gives 0. Wiring a predicate
 * that returns `true` is a behavioural no-op, so there is nothing to detect and nothing is harmed.
 * The harm exists only when the switch is closed, because then a wired predicate would hold work
 * authorization too, and that is exactly when the block fires. Do not read the block as a guarantee
 * that nobody has wired this; read it as a guarantee that nobody can wire it and then close the gate
 * without the suite saying so.
 *
 * WHAT CLOSED THE REPRO THIS GATE WAS WRITTEN FROM, AND IT WAS NEVER THIS GATE. In that measurement
 * the TRIGGER was filling the sponsorship combobox and the VICTIM was the consent listbox. Holding
 * the consent answer stopped Litos PRODUCING an acceptance; it never stopped the sponsorship fill,
 * so that exact sequence ran unchanged for as long as the hold was closed. What actually ended it is
 * PR 50 in the runner: with `menuRoot()` no longer falling back to `page` and the exact tier bounded
 * to the question's own block, filling Q2 cannot reach Q1's rows at all, whatever this backend
 * decides to produce. That ordering is the honest one and it matters for the next reader: the repair
 * is upstream, the switch here is downstream permission to use it, and the switch was never itself a
 * fix for the defect. What the hold bought, for the day it was closed, was narrower and still worth
 * having: Litos stopped deliberately putting acceptances of named legal documents onto option-shaped
 * controls while the runner could not be trusted to hit the one it was asked about.
 *
 * WHY IT WAS NOT WIRED. Not an oversight, and not laziness about a one-line call:
 *
 *   The class had to be held only where the defect reached it, which is an OPTION-SHAPED control.
 *     A work-authorization question served as a text input has no row for the runner to mis-click,
 *     and holding those as well would take away answers that work today, on the commonest shape.
 *   workEligibilityAnswer does not receive the control's option list. resolveKnownAnswer has no
 *     `options` parameter on this branch, so the resolver cannot currently tell the two shapes
 *     apart, and adding that parameter is a change to five call sites that belongs with the
 *     per-jurisdiction work-eligibility collection rather than being bolted onto a safety hold.
 *   The legacy US scalars answer through a different branch from the scoped records, so a gate
 *     placed carelessly would hold one and not the other.
 *
 * ALL THREE ARE STILL TRUE, AND THE FIRST ONE NOW ARGUES AGAINST WIRING IT AT ALL. The reason to
 * hold this class was the targeting defect, and the targeting defect is repaired. Wiring the
 * predicate today would hold answers that are correct, on a defect that no longer exists, which is
 * the "false hold" class 5fc9a2a pinned. So do not wire this as tidying-up. If it is ever wired it
 * should be for a NEW reason, measured, and written down here the way the old one was.
 *
 * IT STAYS DECLARED, not deleted, for the same reason exactControlTargetingDeployed stays a
 * function. If the runner regresses, both classes have to close together, and a second author
 * inventing a second switch on that day is the failure this file is shaped to prevent. Having the
 * predicate already here, already reading the shared gate, is what makes closing it one edit.
 */
export function workEligibilityReplayMayReachControls(): boolean {
  return exactControlTargetingDeployed();
}
