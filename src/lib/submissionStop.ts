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
  /** The sandbox stream closed or stopped accepting commands. Where in the run is unknown. */
  | 'provider_session_failure'
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
 * nothing was sent: the test is where in the code the throw is, not what the copy claims. */
const PRECEDES_CLICK: ReadonlySet<SubmissionStopReason> = new Set<SubmissionStopReason>([
  'no_submit_control',
  'captcha_before_fill',
  'captcha_at_submit',
  'action_budget',
  'packet_document_expired',
  'applicant_email_regeneration',
  'provider_unconfigured',
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
  if (input.noSubmitControl) return 'no_submit_control';
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
