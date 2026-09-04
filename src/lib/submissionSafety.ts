import type { ApplicationReviewQuestion, ApplicationReviewState } from './applicationReview';
import { employerMayHoldApplication, submissionProvablyNotSent, type PreClickNoSendEvidence, type StoredSendEvidence } from './managedSubmitOutcome';

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
 * The answers LITOS WROTE AND SHE HAS NOT APPROVED, on a packet about to reach an employer.
 *
 * THE OWNER'S RULE, verbatim: for required essays Litos auto-generates from the resume and the job
 * description, "and then asks the user if they approve of the generated answer". This is the half of
 * that sentence a prompt cannot enforce. Before it existed, the essay drafter pushed a paragraph
 * with no provenance at all, and the send gate - which only ever asked whether a required answer was
 * blank - saw text and let it through. A machine paragraph in her name was therefore held to a
 * LOWER bar than a machine blank: the blank stopped the send, the paragraph did not.
 *
 * REQUIRED AND OPTIONAL ALIKE. An optional drafted essay is words composed in her name just as much
 * as a required one, and the Pinpoint "personal summary" is precisely that shape. undecidedOptional
 * cannot cover it - a draft has a non-blank answer and no answer_state, so that check reports it
 * decided - which is why this is its own list rather than a clause on either of the two above.
 *
 * WHAT CLEARS IT is not this function. It is mergeSubmittedApplicationReviewQuestions: an edit or an
 * explicit per-question confirmation REPLACES 'litos_draft' with 'applicant_review', and the answer
 * stops being here at all. There is no "approved draft" state to keep in sync.
 */
export function unapprovedLitosDraftQuestionLabels(
  questions: readonly Pick<ApplicationReviewQuestion, 'question' | 'answer' | 'answer_source'>[] | undefined,
): string[] {
  return (questions ?? [])
    .filter((question) => question.answer_source === 'litos_draft' && question.answer.trim().length > 0)
    .map((question) => question.question);
}

/**
 * Every required answer this packet still owes the applicant: the blanks AND the unapproved drafts.
 *
 * One function rather than a clause at each of the six send-facing call sites, and deliberately NOT
 * folded into blankRequiredQuestionLabels, whose own readers (questionMetadata, the reopened-choice
 * tests) mean "the box is empty" literally. The gate below and the two prepare decisions read this
 * one, so a draft nobody approved fails closed on the ATS API channel and the controlled-browser
 * path as well, which are the two that bypass the prepare decisions entirely.
 */
export function pendingRequiredQuestionLabels(
  questions: readonly ApplicationReviewQuestion[] | undefined,
): string[] {
  return [...new Set([
    ...blankRequiredQuestionLabels(questions),
    ...unapprovedLitosDraftQuestionLabels(questions),
  ])];
}

/** Optional questions need an explicit applicant decision before any employer capability opens. */
export function undecidedOptionalQuestionLabels(
  questions: readonly Pick<ApplicationReviewQuestion,
  'question' | 'answer' | 'required' | 'answer_state'>[] | undefined,
): string[] {
  return [...new Set((questions ?? []).flatMap((question) => {
    if (question.required || question.answer_state === 'skipped') return [];
    const undecidedState = question.answer_state === 'unanswered'
      || question.answer_state === 'litos_refused';
    return undecidedState || !question.answer.trim() ? [question.question.trim()] : [];
  }).filter(Boolean))];
}

export type SubmissionQuestionGate = {
  metadataBlockerCount: number;
  /** Blank required answers AND unapproved Litos drafts, required or optional. */
  requiredQuestionLabels: string[];
  /** The subset of the above that is a paragraph Litos wrote and she has not approved. */
  draftQuestionLabels: string[];
  optionalQuestionLabels: string[];
  clear: boolean;
};

/** One fail-closed question decision shared by every employer-facing send path. */
export function submissionQuestionGate(
  review: Pick<ApplicationReviewState, 'questions' | 'question_metadata_blockers'>,
): SubmissionQuestionGate {
  const metadataBlockerCount = review.question_metadata_blockers?.length ?? 0;
  const requiredQuestionLabels = pendingRequiredQuestionLabels(review.questions);
  const draftQuestionLabels = unapprovedLitosDraftQuestionLabels(review.questions);
  const optionalQuestionLabels = undecidedOptionalQuestionLabels(review.questions);
  return {
    metadataBlockerCount,
    requiredQuestionLabels,
    draftQuestionLabels,
    optionalQuestionLabels,
    clear: metadataBlockerCount === 0
      && requiredQuestionLabels.length === 0
      && optionalQuestionLabels.length === 0,
  };
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

/**
 * Whether this packet's handoff window has closed ON SOMETHING THAT WAS REALLY THERE.
 *
 * WHAT THE WINDOW IS. `handoff_expires_at` is written by every prepare path as now + 55 minutes,
 * and 55 minutes is the persistent browser session's own 3600s timeout minus a five minute margin
 * (see HANDOFF_WINDOW_MS). The original 409 said so in as many words: "The secure portal session
 * expired." It is a statement about a Browserbase/Stratus session that is still running and can
 * still be reconnected to, and it is CORRECT for the one path that reconnects: submit()'s
 * non-managed branch does `getBrowserSession(review.browser_session_id)` then `connectToSession`,
 * and that call cannot succeed against a session the provider has already reaped.
 *
 * WHAT IT IS NOT. The MANAGED provider keeps no session at all. prepareManaged explicitly writes
 * `browser_session_id: undefined`, and submit()'s managed branch re-navigates, rebuilds the packet
 * with buildPacket(row) and refills the form from scratch inside a fresh remote run. Nothing from
 * the fill run survives into the send except the stored review, which does not expire. Yet
 * prepareManaged writes the same 55 minute stamp, and the approve route read it with no reference
 * to whether a session existed. Measured against prod on 2026-08-08: all 11 packets sitting at
 * ready_for_final_approval had `browser_session_id` null, and 10 of the 11 were past their stamp.
 * Every one of those refusals was protecting a session that was never created, and the price of
 * each was a full re-run of a managed browser against the employer's form.
 *
 * So the window is asked for what it actually knows: a session id, and a deadline on it. No id, no
 * deadline. The remaining freshness worries - a screenshot from three hours ago, an employer who
 * edited the form since - are real but are NOT what this field measures, and a 55 minute cutoff is
 * not a control for either: the form can change in five minutes as easily as in fifty six, and the
 * managed submit re-reads the live page anyway. Duplicate sends are held by submission_claimed_at's
 * conditional update and by refuseDuplicateApplication, neither of which needs a clock.
 */
export function preparedRunHandoffExpired(
  review: Pick<ApplicationReviewState, 'handoff_expires_at' | 'browser_session_id'>,
  now: number = Date.now(),
): boolean {
  if (!review.browser_session_id) return false;
  if (!review.handoff_expires_at) return false;
  const expiresAt = Date.parse(review.handoff_expires_at);
  return Number.isFinite(expiresAt) && expiresAt < now;
}

export function submitRequestDisposition(
  status: ApplicationReviewState['status'],
  submissionWasClaimed = false,
  /* THE KEY TO THE ONE LOCK THAT HAD NONE.
   *
   * needs_attention AFTER a claim is refused below, and rightly: the run may have reached the
   * employer, so a second one could file a duplicate. Skydio packet 13bccb2d landed in exactly that
   * state, and its attention_reason told the applicant to check the portal "before trying again" -
   * an instruction this function would then refuse. A lock with no key is not a safety property, it
   * is a trap, and the packet had no way forward at all.
   *
   * The key is her own answer after looking, recorded on unverified_submission.resolution.
   * 'not_sent' means she checked and the employer does not have it, which is the only thing that
   * makes a second run safe, and it is the only thing that unlocks this. 'sent' does not unlock it;
   * that answer moves the packet to submitted through its own path. An unresolved record does not
   * unlock it either, because "we do not know" is precisely the state the lock exists for. */
  unverifiedResolution?: 'sent' | 'not_sent',
  /* THE SAME KEY, CUT FOR THE ROWS THAT WERE ALREADY LOCKED IN.
   *
   * The clause above needs the applicant to go and look, and that is the right price when the answer
   * is genuinely unknown. It is the wrong price when the row can already prove the answer. kos.ai,
   * production, 2026-08-11: the managed run stopped inside the atomic chooser, which throws before
   * submitHandle.click, and the packet kept no submission_attempted_at, no receipt, no
   * unverified_submission and no security_code. There is no employer-side application to go and look
   * for, and asking someone to check for one is asking them to confirm a thing that cannot exist.
   *
   * PR 494 fixed the writer: preClickNoSubmitReview now releases the claim, so a run stopping this
   * way today lands at needs_attention with no claim and is re-runnable. It could not fix the rows
   * already on disk, and those rows are the whole defect. This parameter is what makes the gate
   * self-healing rather than dependent on a one-time sweep: the row is re-read on every request, so
   * it recovers the first time anyone presses Try again and cannot be run twice or half-run.
   *
   * NOTHING IS RELAXED BY IT. What a stuck row gets here is exactly the disposition PR 494 already
   * gives a freshly written one, and strictly less: submissionProvablyNotSent demands a POSITIVE
   * pre-click stop on the row before it says yes, so a run killed mid-submit - which leaves the same
   * fields empty and is the case an employer may really hold - is refused as it was before. Optional
   * so every caller that has no row to hand keeps its current meaning. */
  noSendEvidence?: PreClickNoSendEvidence,
): 'start' | 'in_flight' | 'submitted' | 'reject' {
  if (status === 'submitted') return 'submitted';
  // A SECOND SUBMIT IS THE ONE THING THIS STATE MUST NOT ALLOW. The form has already been sent to
  // the employer once and is waiting on an emailed code; re-running the ordinary path would fill and
  // send it again, which issues a fresh code, invalidates the one the applicant is holding, and on
  // any board that caps re-applications spends one of her attempts. Some do: Deepgram's form says
  // candidates may not apply more than twice in any 60-day span.
  //
  // Written as an explicit branch rather than left to the `return 'reject'` at the bottom. The
  // fall-through would give the same answer today and says nothing about why, and the two lists
  // below are exactly the kind of thing a later change adds a status to without noticing what it
  // has just made re-runnable. Only the code-supplying endpoint may move this state forward.
  if (status === 'awaiting_security_code') return 'reject';
  if (status === 'submit_requested' && !submissionWasClaimed) return 'start';
  if (['submit_requested', 'preparing', 'filling', 'submitting'].includes(status)) return 'in_flight';
  // needs_attention covers two materially different states. Before the final click it is safe to
  // rerun preparation after the user supplies a missing answer or a selector fix ships. After the
  // click it represents an uncertain external side effect, so another run could create a duplicate
  // employer application and must stay blocked.
  if (status === 'needs_attention' && !submissionWasClaimed) return 'start';
  // The claimed half of needs_attention, opened only by the applicant's own "I looked and it is not
  // there". See the parameter's note: without this the state has no exit of any kind.
  if (status === 'needs_attention' && unverifiedResolution === 'not_sent') return 'start';
  /* The other half of the same claimed state: the row answers the question itself, so nobody has to
   * be sent to an employer page to confirm an application that provably was never filed. Deliberately
   * BELOW the awaiting_security_code refusal above and gated again on security_code inside the
   * predicate, because a standing code wall is an employer-side application at verification whatever
   * the current run did or did not press. */
  if (status === 'needs_attention' && noSendEvidence && submissionProvablyNotSent(noSendEvidence)) return 'start';
  if (['resume_ready', 'questions_ready', 'ready_to_submit', 'failed'].includes(status)) return 'start';
  return 'reject';
}

/**
 * Whether an ANSWER may be written to this packet. Not whether anything may be sent.
 *
 * DELIBERATELY NOT submitRequestDisposition, AND THAT IS THE WHOLE POINT OF IT EXISTING. That
 * predicate answers "may a browser run start against the employer", and its refusals are all about
 * one risk: a second application at a board that caps them. A save of answers books nothing, opens
 * nothing and reaches nobody. Every one of its refusals is therefore about a different question, so
 * borrowing it here would refuse for reasons that do not apply - and it did. A run that stops mid
 * fill lands at needs_attention still wearing its claim, which submitRequestDisposition answers
 * 'reject' for; that is exactly the packet whose whole remaining ask is "type the answer this form
 * needs", and the screen that asks for it is the one this route serves.
 *
 * WHAT IS REFUSED, and each for its own reason rather than by inheritance:
 *
 *   submitted, awaiting_security_code   The answers on the row are the record of what the employer
 *                                       was given. Rewriting them makes that record describe a form
 *                                       nobody filled.
 *   preparing, filling, submitting,     A run holds this row and writes the same `_review` blob when
 *   claimed submit_requested            it finishes. The conditional update below would lose the
 *                                       race; refusing says so instead of half-saving.
 *   ready_for_final_approval            The form is already filled and there is a preview screenshot
 *                                       of it on screen. New answers underneath it would leave the
 *                                       picture the applicant approves describing something else.
 *                                       Her way in is the resume edit, which resets the packet and
 *                                       refills it - see resumeEditDisposition.
 *   any status carrying send evidence   The row itself says a submit may have landed. See below.
 *
 * AND IT TAKES THE ROW, NOT THE STATUS, WHICH IS THE SECOND THING IT GETS WRONG BY ITSELF.
 *
 * The status list above reads as though needs_attention were one state. It is not: it is also what
 * unverifiedSubmissionPatch writes when a run may have pressed submit, which sets
 * submission_attempted_at, records an unresolved unverified_submission, and KEEPS the claim rather
 * than clearing it. Keyed on status alone, every one of those rows fell through to 'save' - and the
 * first refusal in this list, "the answers on a sent application are the record of what was sent",
 * is the same argument for a row that may have been sent. On 2026-08-13, 2 of the 286 live
 * needs_attention rows carried that evidence, one of them a standing security_code as well, and the
 * dashboard renders "Check the answers" for both.
 *
 * PUT /review was patched for this exact class and names it in its own comment. The evidence check
 * is employerMayHoldApplication, which is the same four facts submissionProvablyNotSent opens with,
 * asked here rather than restated - a second definition of "may have been sent" is how this recurs.
 * Deliberately not submissionProvablyNotSent whole: that demands a POSITIVE proof of a pre-click
 * stop, which the ordinary stopped run does not have, and refusing it would refuse the save this
 * route exists for.
 */
export function reviewAnswerSaveDisposition(
  review: Pick<ApplicationReviewState, 'status' | 'submission_claimed_at'> & StoredSendEvidence,
): 'save' | 'reject' {
  const status = review.status;
  if (status === 'submitted' || status === 'awaiting_security_code') return 'reject';
  if (['preparing', 'filling', 'submitting'].includes(status)) return 'reject';
  if (status === 'submit_requested' && Boolean(review.submission_claimed_at)) return 'reject';
  if (status === 'ready_for_final_approval') return 'reject';
  if (employerMayHoldApplication(review)) return 'reject';
  return 'save';
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

/**
 * Whether a packet's CONTACT HEADER - not its answers, not its content - may be refreshed against
 * the current profile (POST /applications/:id/resume/contact-refresh).
 *
 * NEITHER OF THE TWO EXISTING DISPOSITIONS ANSWERS THIS ON ITS OWN, and each is wrong for its own
 * reason. reviewAnswerSaveDisposition refuses ready_for_final_approval unconditionally - the right
 * call for an ANSWER save, since rewriting an answer underneath the preview she is looking at would
 * change what that preview means, but wrong here: a header refresh does not touch the preview's
 * answers, and the packet-audit path already voids her acknowledgement the moment the PDF's bytes
 * move (see the route's own comment on packet_stale). resumeEditDisposition opens exactly that
 * status for exactly that reason - it is the resume-edit route's own door back in from final
 * approval - but it does so by deferring to submitRequestDisposition for every OTHER status, which
 * answers 'start' for an unclaimed needs_attention row with no look at whether the row's own
 * evidence says an employer may already hold the application. That is precisely the shape
 * unverifiedSubmissionPatch writes (submission_attempted_at set, the claim released, no resolution
 * recorded), and reviewAnswerSaveDisposition already refuses it through employerMayHoldApplication.
 * A route that swapped in resumeEditDisposition wholesale would silently reopen that refusal for a
 * PDF write, not merely an in-memory disposition check - see resumeContactRefresh.test.ts's
 * 'refused when the row itself says an employer may already hold this packet', which pins the exact
 * row shape this would have let through.
 *
 * So this is reviewAnswerSaveDisposition's OWN rule, with its one unconditional refusal narrowed to
 * the one case resumeEditDisposition already proves safe: unclaimed, and no employer-may-hold
 * evidence on the row.
 */
export function resumeContactRefreshDisposition(
  review: Pick<ApplicationReviewState, 'status' | 'submission_claimed_at'> & StoredSendEvidence,
): 'save' | 'reject' {
  if (review.status === 'ready_for_final_approval') {
    return !review.submission_claimed_at && !employerMayHoldApplication(review) ? 'save' : 'reject';
  }
  return reviewAnswerSaveDisposition(review);
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
