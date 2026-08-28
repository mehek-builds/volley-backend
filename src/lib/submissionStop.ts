/* WHERE A RUN STOPPED, AS A TYPED FACT RATHER THAN AS A SENTENCE ABOUT IT.
 *
 * THE DEFECT THIS EXISTS FOR. fail() releases the submission claim for exactly two families -
 * regenerationRequired/packetDocumentExpired, and the noSubmitControl early return. Everything else
 * that throws after the claim is taken lands at needs_attention WEARING the claim and with no
 * unverified_submission record, which closes every exit at once: submitRequestDisposition refuses a
 * claimed needs_attention row, resumeEditDisposition delegates to it, the security-code route wants
 * a different status, and the unverified-resolution route wants a record that was never written.
 * ManagedActionBudgetError, CaptchaUnresolvedError, a provider session failure and any generic
 * post-claim throw all land there. Those rows are still being created today.
 *
 * WHY A FIELD AND NOT ANOTHER STRING MATCH. The only positive proof of a pre-click stop available
 * to a row read back out of the database is isManagedNoSubmitControl(submission_error) - a regex
 * over prose the runner happened to store. That layer works and it is also the reason a second
 * defect can hide behind a reworded error message. Writing the classification at the moment the
 * runner knows it, on the row, means the read side can eventually ask the FIELD and the string
 * matching can be retired rather than have a second copy of itself built beside it.
 *
 * WHAT before_click MEANS, AND WHAT IT DOES NOT. It is true only where the stop site is structurally
 * ahead of the final click within this run: the builder threw while assembling the action list, the
 * chooser found no control, the probe saw a challenge before anything was pressed. It is emphatically
 * NOT on its own a licence to release the claim. A CAPTCHA can be standing on a page BECAUSE an
 * earlier attempt already submitted, so the release decision asks this field AND the row's own
 * evidence, through submissionProvablyNotSent. See submissionFailureReview.
 */

export type SubmissionStopReason =
  /** clickFinalSubmit, or the managed chooser, found nothing to press. Never dispatched. */
  | 'no_submit_control'
  /** The pre-browser probe saw a live challenge, so the form was never even filled. */
  | 'captcha_before_fill'
  /** The probe inside clickFinalSubmit saw a challenge after the fill and before the press. */
  | 'captcha_at_submit'
  /** buildManagedPortalActions stopped while assembling the list, recording submitActionAppended false. */
  | 'action_budget'
  /** buildPacket threw: the stored resume is past its retention window, so no packet was assembled. */
  | 'packet_document_expired'
  /** The packet's frozen Litos address no longer matches the live inbound route. */
  | 'applicant_email_regeneration'
  /** No secure browser provider is configured, so no browser was ever opened. */
  | 'provider_unconfigured'
  /** The run returned, but its required-field confirmation proof was malformed or absent, so
   * whether the final click happened is unknown. This is the cross-repo contract break: the runner
   * spoke a shape this service refused, AFTER the remote actions had already executed. Never
   * pre-click: on 2026-08-11 the runner's own code pressed Submit and this arm was recorded as
   * "nothing has been sent". */
  | 'confirmation_unproven'
  /** The sandbox stream closed or stopped accepting commands. Where in the run is unknown. */
  | 'provider_session_failure'
  /** Chooser v4 durably reported that transport containment still held when the sandbox crashed. */
  | 'provider_session_failure_before_submit'
  /** A required filled-field proof failed its deterministic runner assertion, under the same
   * durable chooser-v4 containment progress as the crash reason above. The runner stopped the
   * action list at the failed proof, so confirmAndSubmit was never reached. Its own error type
   * (ManagedBrowserAssertionFailureError) is constructed only under that proof. */
  | 'field_proof_failed_before_submit'
  /** The managed run was cut off before it reported anything. Where in the run is unknown. */
  | 'run_timed_out'
  /** Anything else. Deliberately not guessed at, and never treated as pre-click. */
  | 'unclassified';

export type SubmissionStopRecord = {
  reason: SubmissionStopReason;
  /**
   * Whether the stop is PROVABLY ahead of the final click in this run.
   *
   * False is the honest answer for every reason whose stop site is unknown, and false is what an
   * absent field must be read as too: rows written before this existed carry no record, and "no
   * record" can never mean "nothing was sent".
   */
  before_click: boolean;
  at: string;
  /**
   * The run that stopped. A stop record is evidence about ONE attempt, and a later attempt starting
   * clears it (see claimSubmission), so this is here to make a stale record legible rather than
   * silently authoritative.
   */
  submission_run_id?: string;
};

/* The reasons whose stop site is ahead of the click by construction, each one a throw that happens
 * before any submit control is pressed. Nothing is added here on the strength of a sentence saying
 * nothing was sent: the test is where in the code the throw is, not what the copy claims.
 *
 * EVERY MEMBER IS BACKED BY AN ERROR TYPE, and that is the membership rule rather than an accident
 * of the current list. NoSubmitControlError, CaptchaUnresolvedError, ManagedActionBudgetError,
 * PacketDocumentExpiredError and ApplicantEmailRegenerationRequiredError are `instanceof` checks.
 * Managed no-control prose never reaches this set on a current run.
 *
 * 'provider_unconfigured' IS DELIBERATELY ABSENT, and it was here until review caught it. It is
 * derived from a loose alternation that includes the bare word `browserbase`, and the text it runs
 * against is `payload.error`, which arrives VERBATIM from the Stratus service. A provider message
 * merely containing that word, thrown after a click, would have classified as a pre-click stop and
 * released the claim. The regex is left exactly as it is for the requeue decision it was written
 * for; what changes is that it is no longer load-bearing for a release. Such a row keeps its claim
 * and takes the unverified exit, which is the failure direction that cannot cost an application. */
const PRECEDES_CLICK: ReadonlySet<SubmissionStopReason> = new Set<SubmissionStopReason>([
  'no_submit_control',
  'captcha_before_fill',
  'captcha_at_submit',
  'action_budget',
  'packet_document_expired',
  'applicant_email_regeneration',
  'provider_session_failure_before_submit',
  'field_proof_failed_before_submit',
]);

export function stopReasonPrecedesClick(reason: SubmissionStopReason): boolean {
  return PRECEDES_CLICK.has(reason);
}

/**
 * Which stop this was, from the same signals fail() already derives for the applicant's sentence.
 *
 * THE PRECEDENCE MIRRORS submissionFailureOutcome's, deliberately. Two orderings over the same
 * inputs would disagree eventually, and the disagreement would be a row whose prose says one thing
 * and whose typed record says another - which is worse than having neither.
 */
export function classifySubmissionStop(input: {
  captchaStop: 'before_fill' | 'at_submit' | null;
  noSubmitControl: boolean;
  regenerationRequired: boolean;
  packetDocumentExpired: boolean;
  actionBudget: boolean;
  fieldProofFailedBeforeSubmit: boolean;
  confirmationUnproven: boolean;
  providerSessionFailureBeforeSubmit: boolean;
  providerSessionFailure: boolean;
  runTimedOut: boolean;
  providerUnconfigured: boolean;
}): SubmissionStopReason {
  if (input.runTimedOut) return 'run_timed_out';
  if (input.captchaStop === 'at_submit') return 'captcha_at_submit';
  if (input.captchaStop === 'before_fill') return 'captcha_before_fill';
  if (input.regenerationRequired) return 'applicant_email_regeneration';
  if (input.packetDocumentExpired) return 'packet_document_expired';
  if (input.actionBudget) return 'action_budget';
  if (input.fieldProofFailedBeforeSubmit) return 'field_proof_failed_before_submit';
  if (input.noSubmitControl) return 'no_submit_control';
  if (input.confirmationUnproven) return 'confirmation_unproven';
  if (input.providerSessionFailureBeforeSubmit) return 'provider_session_failure_before_submit';
  if (input.providerSessionFailure) return 'provider_session_failure';
  if (input.providerUnconfigured) return 'provider_unconfigured';
  return 'unclassified';
}

export function submissionStopRecord(
  reason: SubmissionStopReason,
  at: string,
  submissionRunId?: string,
): SubmissionStopRecord {
  return {
    reason,
    before_click: stopReasonPrecedesClick(reason),
    at,
    ...(submissionRunId ? { submission_run_id: submissionRunId } : {}),
  };
}

/* TAKING THE CLAIM AND CLEARING THE LAST RUN'S STOP ARE ONE WRITE, NOT TWO.
 *
 * THE HOLE THIS CLOSES, WHICH WAS INTRODUCED BY THE FIRST VERSION OF THIS FIELD. Clearing was done
 * inline at the claim sites, under a comment asserting that the claim was "the single line every
 * send run passes through". There were four claim sites, not three:
 * POST /applications/:id/submission/extension-start takes the claim over a `...current` spread and
 * was missed. The resulting chain is worse than anything this PR set out to fix:
 *
 *   1. A managed run stops pre-click on a multi-step first page, which the runner itself calls the
 *      routine outcome rather than an edge case. The claim is released and before_click:true is left
 *      on the row, correctly.
 *   2. The applicant retries through the extension. The claim is taken and the STALE stop survives.
 *   3. She presses Submit in her own browser. The employer now has the application.
 *   4. The confirmation cannot be read, so extensionOutcomePatch('unknown') writes needs_attention,
 *      keeps the claim, and writes no receipt, no submission_attempted_at, no unverified record and
 *      no submission_error.
 *   5. Nothing on that row contradicts the stale stop, so submissionProvablyNotSent says true and
 *      the packet is runnable again - while its own attention_reason reads "Litos clicked Submit but
 *      could not verify the employer confirmation".
 *
 * So the two writes are welded together here and every claim site spreads this. A fifth claim site
 * gets the clear for free; one that hand-rolls the fields instead is caught by the enumeration test
 * in submissionClaimStopClear.test.ts, which is the only thing that can prove this list is complete.
 */
export function submissionClaimPatch(at: string, claimId: string): {
  submission_claimed_at: string;
  submission_claim_id: string;
  submission_stop: undefined;
} {
  return {
    submission_claimed_at: at,
    submission_claim_id: claimId,
    /* A stop record describes ONE attempt, and this is the next one. Carrying before_click:true into
     * a run that is about to press Send leaves the row able to prove something about a click that
     * has not happened yet, which is the one direction this field must never be wrong in. */
    submission_stop: undefined,
  };
}
