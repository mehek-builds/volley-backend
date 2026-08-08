import type { ApplicationReviewQuestion, ApplicationReviewState } from './applicationReview';

/**
 * The required questions the employer will not accept blank, and Litos has no answer for.
 *
 * THIS IS A SEND GATE, NEVER A RUN GATE, and the distinction is the whole reason this function
 * exists in its own right rather than inline at one call site.
 *
 * A fill run is the thing that ANSWERS a discovered question: the run reaches the live form,
 * enumerates its controls, resolves what it can from the profile and the saved answers, and writes
 * the rest back as required-and-blank so the applicant can see them. Refusing to START that run
 * because a question is blank is a closed loop with no exit - the answer can only come from the run
 * that the missing answer forbids. Measured against prod on 2026-08-08: of 25 packets asked to
 * re-run, 15 were refused this way and never opened a browser, so their stored attention_reason
 * still described a build from hours earlier and a results table built from them measured the wrong
 * code twice in a row.
 *
 * So the check belongs on the transitions that actually reach the employer:
 *   - POST /applications/:id/submission/approve  (the applicant pressing send on a filled form)
 *   - the unsupported-portal email fallback in submit-request, which sends with no run in between
 *   - the runner's direct-send decision, which is the only path from a run straight to a click
 *   - clickFinalSubmit's own read of the live form, which is the last one and the real protection
 * and NOT on POST /applications/:id/submit-request, whose only job is to book a browser.
 */
export function blankRequiredQuestionLabels(
  questions: readonly ApplicationReviewQuestion[] | undefined,
): string[] {
  return (questions ?? [])
    .filter((question) => question.required && !question.answer.trim())
    .map((question) => question.question);
}

/**
 * Whether a packet that has already been filled may be thrown away and filled again.
 *
 * The mirror of resumeEditDisposition's extra clause, and it exists for the same reason. A packet
 * at ready_for_final_approval has a completed form and a preview screenshot, but has NOT been
 * claimed, which means nothing has reached the employer and nothing is in flight. Re-running it
 * risks nothing an already-permitted resume edit does not risk: that route resets the same packet to
 * ready_to_submit and the next run rebuilds the form from scratch.
 *
 * Without this, a packet frozen against an old build had exactly one way back - submit a full
 * resume edit through PATCH /applications/:id/resume, which re-renders the PDF and re-runs every
 * layout validation, to change nothing about the resume. R-066 makes applications write-once with no
 * delete, so "make a new one" is not an escape hatch either. A stale review with no way to refresh
 * it is a trap, and this is the door.
 *
 * Deliberately NOT folded into submitRequestDisposition. A second POST of the same body must keep
 * returning 409 rather than silently discarding a filled form the applicant is looking at, so
 * restarting is something the caller asks for by name.
 */
export function preparedRunCanRestart(
  status: ApplicationReviewState['status'],
  submissionWasClaimed = false,
): boolean {
  return status === 'ready_for_final_approval' && !submissionWasClaimed;
}

export function submitRequestDisposition(
  status: ApplicationReviewState['status'],
  submissionWasClaimed = false,
): 'start' | 'in_flight' | 'submitted' | 'reject' {
  if (status === 'submitted') return 'submitted';
  if (status === 'submit_requested' && !submissionWasClaimed) return 'start';
  if (['submit_requested', 'preparing', 'filling', 'submitting'].includes(status)) return 'in_flight';
  // needs_attention covers two materially different states. Before the final click it is safe to
  // rerun preparation after the user supplies a missing answer or a selector fix ships. After the
  // click it represents an uncertain external side effect, so another run could create a duplicate
  // employer application and must stay blocked.
  if (status === 'needs_attention' && !submissionWasClaimed) return 'start';
  if (['resume_ready', 'questions_ready', 'ready_to_submit', 'failed'].includes(status)) return 'start';
  return 'reject';
}

export function resumeEditDisposition(
  status: ApplicationReviewState['status'],
  submissionWasClaimed = false,
): 'start' | 'reject' {
  if (submitRequestDisposition(status, submissionWasClaimed) === 'start') return 'start';
  // A packet at final approval has filled the company form but has not been sent. If its frozen
  // resume no longer matches the profile, editing must be allowed so the next fill reruns with the
  // corrected PDF and a fresh preview. Once the company form has been claimed, the duplicate-send
  // risk wins and the packet stays locked.
  if (status === 'ready_for_final_approval' && !submissionWasClaimed) return 'start';
  return 'reject';
}

export function directPreparationIsSafe(options: {
  blockerCount: number;
  attentionCount: number;
  verificationStatus: 'not_needed' | 'searching' | 'completed' | 'handoff';
  /* Required questions the run finished without an answer for. This is the ONE path from a fill run
   * straight to a click - standing consent turns the prepared packet into 'submitting' inside the
   * same call - so the required-answer check that no longer sits in front of the run has to sit
   * here instead. Defaulted so every existing caller and test keeps its current meaning; a caller
   * that has the merged question list should pass it. */
  unansweredRequiredCount?: number;
}): boolean {
  return options.blockerCount === 0
    && options.attentionCount === 0
    && (options.unansweredRequiredCount ?? 0) === 0
    && options.verificationStatus !== 'handoff';
}
