/* THE FILL RUN THAT DIED WITHOUT WRITING A TERMINAL STATE, AND THE ROW NOTHING COULD EVER MOVE.
 *
 * MEASURED LIVE 2026-09-04, account mehekmandal05@gmail.com. Palantir (lever), packet
 * f1cfb841-7a59-4314-9ef1-84581ccb373a, created that morning and never sent. A managed fill run
 * started and then stopped:
 *
 *   status                  'filling'   frozen, updated_at stuck at 2026-09-04T06:53:50.899Z
 *   submission_run_id       cd12b343-a0af-4ea4-b43a-232a55faa58e
 *   submission_claimed_at   null
 *   submission_claim_id     null
 *   submission_attempted_at null
 *   submission_authority    { state: 'none', projection: { state: 'none' },
 *                             retry_safety: { kind: 'no_evidence' } }
 *
 * EVERY EXIT WAS CLOSED AT ONCE, and each one is individually correct:
 *
 *   - THE CRON NEVER SEES IT. The runner's selector (submissionRunner.ts, the
 *     `/internal/application-submission-runner` query) matches `submit_requested` and `submitting`
 *     only. `preparing` and `filling` appear nowhere in it, so no sweep ever looks at this row.
 *   - THE RUNNER'S OWN STEP FALLS THROUGH. runSubmissionForApplication claims preparation only from
 *     `submit_requested` and submits only from `submitting`. A row already at `filling` matches
 *     neither and the function returns having done nothing.
 *   - EVERY RE-RUN IS 409. submitRequestDisposition (submissionSafety.ts) answers `in_flight` for
 *     `filling` unconditionally, so POST /submit-request is refused however long the row has sat.
 *   - preparedRunCanRestart COVERS ready_for_final_approval ONLY.
 *   - reviewAnswerSaveDisposition REFUSES `filling`, so she cannot even edit her way out.
 *   - AND THE EXISTING REPAIR NEVER OPENS ITS TRANSACTION. repairExpiredAttendedHandoffClaim runs
 *     on every 2.5s dashboard poll, but its precondition expiredHandoffClaimRepairIsPossible
 *     returns false as its FIRST line when the row has neither submission_claim_id nor
 *     submission_claimed_at - which is exactly this row, because claimPreparation writes
 *     `submission_claimed_at: undefined, submission_claim_id: undefined` when it moves
 *     `submit_requested` to `preparing`. A managed prepare holds NO claim at any point.
 *
 * That last line is also why this rule is not part of either open PR on the neighbouring shape.
 * #912 adds a stalled-`submitting` arm INSIDE repairExpiredAttendedHandoffClaim, behind that same
 * claim precondition, so it cannot reach a claimless row. #913 closes an abandoned ledger ATTEMPT,
 * and this packet has no attempt at all - `no_evidence` is the ledger saying so. The three are
 * disjoint by construction: a live claim (#912), a dead attempt whose claim has moved on (#913),
 * and here, a run that stopped before it ever opened an attempt.
 *
 * WHAT PROVES THIS IS SAFE, AND IT IS NOT THE CLOCK. The employer boundary is crossed only through
 * claimSubmission, which writes `submission_claim_id` and appends `attempt_opened` in ONE
 * transaction, and then through authorizeFinalSubmissionBoundary, which appends
 * `boundary_authorized`. Both are immutable ledger facts. So the ledger's own packet projection,
 * submissionAttemptRetrySafetyForPacketEvents, is the existing answer to "did anything reach an
 * employer": `no_evidence` (no attempt was ever opened) and `safe_not_sent` (an attempt was opened
 * and a typed not-sent proof closed it) are the two verdicts submissionAuthorityEnvelopeForUnattemptedPacket
 * already treats as proof that nothing reached an employer, and they are the two this admits. Every
 * blocked verdict - blocked_unverified at any age, blocked_confirmed - is refused here exactly as it
 * is refused there. That distinction is reused, not re-derived.
 *
 * WHY A CLOCK IS STILL NEEDED, AND WHAT IT IS ALLOWED TO GET WRONG. A LIVE managed fill carries
 * byte-for-byte the same evidence as this dead one: same status, same absent claim, same empty
 * ledger, for the whole of buildPacket, discovery, the option probes and the fill. Nothing but
 * elapsed time separates them, so elapsed time is what this measures - the same conclusion #912
 * reached for its own shape.
 *
 * The difference is the PRICE OF BEING WRONG, and it is the reason this bound can exist where
 * #912's could not. #912's release wrote `not_sent_proven` into the ledger, and a live run's own
 * late fold is refused by recordManagedAuthorizedAttemptUnverified once that fact exists - so
 * firing early there did not merely disturb a send, it killed it and destroyed the record. THIS
 * RELEASE WRITES NOTHING TO THE LEDGER. There is no attempt to write a fact against. It moves one
 * row's status and clears the run's transient fields, so a fill that is merely slow simply
 * overwrites it on its next progress write and carries on; and if it goes on to send, it does so
 * through claimSubmission, whose atomic conditional update, lockSubmissionAttemptUser and
 * duplicateApplicationVerdict are untouched by anything in this file. A second employer attempt
 * still has to get past all three, and the ledger still refuses it.
 *
 * WHAT IS NOT RELAXED. No duplicate-send guard is weakened, widened or bypassed. This file cannot
 * make a packet sendable that the ledger blocks: the release lands the row at `needs_attention`
 * with no claim, which is a state submitRequestDisposition ALREADY treats as re-runnable, and every
 * gate downstream still asks the ledger the same questions it asked before.
 */

import type { ApplicationReviewState } from './applicationReview';
import { attentionCategoriesForReasons } from './submissionTerminalCause';
import type { SubmissionAttemptRetrySafety } from './submissionAttemptLedger';

/**
 * How long a `preparing` or `filling` row may go without its run saying anything before the row is
 * treated as abandoned.
 *
 * THE NUMBER IS A CEILING ON ONE STAGE GAP, NOT ON A RUN. This is the correction #912 paid for:
 * its 20 minutes came from reading MANAGED_PREPARE_FILL_DEADLINE_MS as if it capped a whole send,
 * and a production measurement then found a LIVE run at 110 minutes. What is measured here is
 * different and much smaller. prepareManaged advances `progress_updated_at` three times - "Opening
 * the company form", "Reading the company questions", "Filling your answers" - so the quantity
 * being compared is the gap between two consecutive stage writes, never the length of the run.
 *
 * THE LARGEST CITABLE GAP is the middle one, and it is dominated by the discovered-option probe:
 * MANAGED_OPTION_PROBE_MAX_CONTROLS is 80 and MANAGED_OPTION_PROBE_ACTIONS_PER_CONTROL is 7, which
 * is 560 actions batched under the provider's 120-action ceiling, so up to 5 batches, each a read
 * scan bounded by MANAGED_READ_SCAN_DEADLINE_MS at 240s. That is 20 minutes of provider calls in
 * one gap, plus two 10s public-schema fetches, plus the cover-letter and per-question drafting
 * calls, which have no single citable bound of their own. Call the citable part 25 minutes.
 *
 * THREE HOURS IS DELIBERATELY FAR ABOVE THAT: about 7x the citable ceiling for one gap, and above
 * the 110 minute live run that is the longest anything in this system has ever been measured
 * running. The bound is not trying to be tight. It is trying to be a bound at all, because today
 * there is none and the row is stuck forever; and the cost of firing late is that an applicant
 * waits, while the cost of firing early is only that a live run overwrites this on its next write.
 * If a real distribution of `filling` lifetimes is ever collected, tighten it against that and not
 * against another argument from one call's deadline.
 */
export const STALLED_FILL_RUN_RELEASE_MS = 3 * 60 * 60 * 1000;

/**
 * The sentence the applicant reads, and it is written to be true of THIS state specifically.
 *
 * It has to contain "could not finish this application" because that clause is what
 * attentionCategoriesForReasons matches to reach `run_failed`, which is the "Litos broke, you can
 * try it again" bucket. Every other bucket would be wrong: nothing reached the employer, so this is
 * not `unverified_submission`; the form was reached, so it is not `form_not_reached`; and no
 * employer control is waiting on her, so it is none of captcha, account_login or privacy_consent.
 */
export const STALLED_FILL_RUN_ATTENTION_REASON =
  'Litos could not finish this application. The run that was filling the company form stopped part '
  + 'way through and never came back, and it stopped before anything was sent. Nothing has gone to '
  + 'the employer. You can try this one again from your dashboard.';

/**
 * The exact `progress_stage` prepareManaged writes before it ever calls stratus for the first time
 * (submissionRunner.ts). Shared here so the writer and this reader cannot drift on the literal - the
 * bound below is meaningless if a rename on one side silently stops matching the other.
 */
export const MANAGED_FILL_PAGE_OPEN_STAGE = 'Opening the company form';

/**
 * How long a `filling` row may sit at the PAGE-OPEN stage specifically before its run is treated as
 * abandoned - far tighter than STALLED_FILL_RUN_RELEASE_MS, and deliberately so.
 *
 * THIS ONE STAGE HAS A KNOWN, NARROW CEILING, unlike the run as a whole. prepareManaged writes
 * `progress_stage: 'Opening the company form'` and then makes exactly ONE stratus call - the
 * discovery pass - before its next progress write (`'Reading the company questions'`). That call
 * carries MANAGED_PREPARE_SCAN_OPTIONS, whose scanDeadlineMs is MANAGED_PREPARE_FILL_DEADLINE_MS,
 * 280 seconds (browserbase.ts). A run cannot legitimately sit at this exact stage past one 280s
 * provider call plus one plausible queued sibling call behind the same per-user provider-call fence
 * (withProviderCallFence / lockSubmissionProviderCallUser, submissionAccountFence.ts) - at most
 * roughly 2x280s. 15 minutes is better than 3x that, so a single slow-but-live call, even queued
 * behind one other, is never mistaken for a stall; it is also less than a sixth of the general
 * three-hour bound below, which exists for the later stages this one is not.
 *
 * MEASURED LIVE 2026-09-04, account mehekmandal05@gmail.com. Celerant Technologies, Paylocity,
 * packet 4b66641d-d12c-4b56-b9c1-850fd1e20a1d: fill run d471dcf1 approved 22:21:47Z, `status:
 * "filling"`, `progress_stage: "Opening the company form"`, no `submission_error`, no
 * `submission_stop`, and still byte-for-byte identical at 22:30:53Z - 9 minutes with zero heartbeat,
 * and nothing on record says it ever moved again. The dashboard's own poll read "STARTING - Opening
 * the company form / Still working" for the entire window. Under STALLED_FILL_RUN_RELEASE_MS this
 * packet had almost three more hours to wait for a sentence that says so; under this bound it gets
 * one at the 15-minute mark, still five minutes past the worst legitimate case reasoned above.
 *
 * NOT applied to `preparing`, and not applied to `filling` at any later stage: this bound is keyed
 * to the exact stage string via stalledFillRunReleaseBoundMs, which falls back to
 * STALLED_FILL_RUN_RELEASE_MS everywhere else, including a `filling` row whose progress_stage is
 * undefined (a shape this bound has no measurement for).
 */
export const STALLED_FILL_RUN_PAGE_OPEN_RELEASE_MS = 15 * 60 * 1000;

/**
 * The sentence for a run that never got past opening the employer's own page, written to be true of
 * THIS narrower state and no other.
 *
 * It has to contain "never reached the application form" because that clause is what
 * attentionCategoriesForReasons matches to reach `form_not_reached` - the one category that says
 * plainly that no employer page was ever opened, which is exactly and only what this bound proves.
 * `run_failed` (STALLED_FILL_RUN_ATTENTION_REASON's own bucket) would be wrong here: that sentence's
 * own comment states the form WAS reached, which is false at this stage by construction.
 */
const STALLED_FILL_RUN_PAGE_OPEN_RELEASE_MINUTES = STALLED_FILL_RUN_PAGE_OPEN_RELEASE_MS / 60_000;
export const STALLED_FILL_RUN_PAGE_OPEN_ATTENTION_REASON =
  `Litos could not open the company's form within ${STALLED_FILL_RUN_PAGE_OPEN_RELEASE_MINUTES} `
  + 'minutes, so the run never reached the application form. Nothing has been sent. You can try '
  + 'this one again from your dashboard.';

/** The two in-flight statuses a managed prepare can die in and never be moved out of again. */
const RELEASABLE_IN_FLIGHT_STATUSES: ReadonlySet<ApplicationReviewState['status']> = new Set([
  'preparing',
  'filling',
]);

/**
 * The last moment this run demonstrably existed, in epoch milliseconds, or null when the row cannot
 * say.
 *
 * THE LATER OF THE TWO STAMPS, which is the direction that can only ever make this wait longer.
 * `progress_updated_at` is the one the fill loop advances as it works and is the honest signal, but
 * it is absent on a row that died in `preparing` (claimPreparation writes no progress stamp) and on
 * the attended account-gate write, so `updated_at` is the floor. #912 argues against `updated_at`
 * because unrelated writes refresh it and would measure our own activity rather than the run's -
 * that argument is about a stamp used INSTEAD of the run's own, and taking the maximum inverts its
 * polarity: an unrelated write can only hold the row artificially fresh and delay a release, never
 * cause one. It is also nearly moot for this shape, because `preparing` and `filling` are refused
 * by reviewAnswerSaveDisposition, by resumeEditDisposition and by submitRequestDisposition, so
 * essentially nothing but the run itself can write this row.
 */
export function stalledFillRunLastActivityAt(
  review: Pick<ApplicationReviewState, 'updated_at' | 'progress_updated_at'>,
): number | null {
  const updatedAt = Date.parse(review.updated_at ?? '');
  const progressAt = Date.parse(review.progress_updated_at ?? '');
  const stamps = [updatedAt, progressAt].filter((value) => Number.isFinite(value));
  return stamps.length > 0 ? Math.max(...stamps) : null;
}

/**
 * The ROW half: is this a claimless managed in-flight row whose run has stopped saying anything?
 *
 * Proves nothing about the employer boundary and does not try to. The caller pairs it with
 * stalledFillRunLedgerProvesNoEmployerContact over the packet's immutable events, and both are
 * required.
 *
 * `now` has no default ON PURPOSE, for the reason #912 gives for its sibling: the caller must pass
 * a clock read AFTER it has taken the lock and read the row, inside the same transaction, so the
 * comparison cannot be made against a stamp captured before the work that might have moved the row.
 */
export function stalledFillRunIsReleasable(
  review: Pick<
    ApplicationReviewState,
    'status' | 'updated_at' | 'progress_updated_at' | 'submission_claim_id' | 'submission_claimed_at'
    | 'browser_session_id' | 'submitted_at' | 'submission_attempted_at' | 'receipt' | 'security_code'
    | 'unverified_submission'
  >,
  now: number,
  boundMs: number = STALLED_FILL_RUN_RELEASE_MS,
): boolean {
  if (!RELEASABLE_IN_FLIGHT_STATUSES.has(review.status)) return false;
  /* A CLAIM MEANS THIS IS SOMEBODY ELSE'S PROBLEM, and refusing it here is what keeps the three
   * rules disjoint. A claimed row is a send, not a prepare: it belongs to
   * repairExpiredAttendedHandoffClaim and to whatever bounds a stalled `submitting` claim, both of
   * which pay for their certainty differently. Two rules releasing one row is how a guard gets
   * routed around without anyone editing it. */
  if (review.submission_claim_id || review.submission_claimed_at) return false;
  /* A PROVIDER SESSION IS A LIVE RESOURCE SOMEBODY ELSE OWNS. prepareManaged writes
   * `browser_session_id: undefined`; only the direct/attended path stores one, and that path has
   * its own instrument in preparedRunHandoffExpired plus a real session the provider can still be
   * asked about. Clearing a session id out from under browserProviderResourceCleanup would orphan
   * the resource it is holding, so this rule stays off that shape entirely. */
  if (review.browser_session_id) return false;
  /* STORED SEND EVIDENCE VETOES, and it is asked here rather than through
   * employerMayHoldApplication because a `filling` row has no business carrying ANY of these: each
   * one is written by a path that runs after a claim, so its presence means the row is not the
   * shape this rule was measured on and the honest answer is to leave it alone. */
  if (review.submitted_at
    || review.submission_attempted_at
    || review.receipt
    || review.security_code
    || review.unverified_submission) return false;
  const lastActivityAt = stalledFillRunLastActivityAt(review);
  if (lastActivityAt === null) return false;
  /* Written as a deadline compared to now rather than as an elapsed-time subtraction, so it reads
   * the same way round as expiredAttendedHandoffClaimIsReleasable and its siblings and a later edit
   * cannot quietly invert one of them. */
  return lastActivityAt + boundMs < now;
}

/**
 * The LEDGER half: does the packet's own immutable history prove nothing reached an employer?
 *
 * DELIBERATELY THE PACKET PROJECTION AND NOT A NEW PREDICATE. submissionAttemptRetrySafetyForPacketEvents
 * already folds every attempt on the packet with cross-attempt precedence - one safe retry never
 * excuses another risk - and submissionAuthorityEnvelopeForUnattemptedPacket already treats exactly
 * `no_evidence` and `safe_not_sent` as the two verdicts under which a first employer send may be
 * authorised. Admitting the same two here means this rule can never free a packet that the send
 * gate would refuse, and a change to what counts as proof lands in one place rather than two.
 *
 * `no_evidence` is the measured Palantir case: not one attempt_opened exists, so nothing ever
 * claimed, nothing ever authorized a boundary and nothing was ever pressed. `safe_not_sent` is
 * strictly stronger - an attempt was opened and a typed not-sent fact closed it - and is admitted
 * for the same reason the envelope builder admits it.
 */
export function stalledFillRunLedgerProvesNoEmployerContact(
  retrySafety: SubmissionAttemptRetrySafety,
): boolean {
  return retrySafety.kind === 'no_evidence' || retrySafety.kind === 'safe_not_sent';
}

/**
 * WHICH BOUND APPLIES TO THIS ROW, tight at the page-open stage and loose everywhere else this rule
 * covers.
 *
 * A `filling` row parked at exactly MANAGED_FILL_PAGE_OPEN_STAGE has made, at most, one bounded
 * provider call since its last progress write (see STALLED_FILL_RUN_PAGE_OPEN_RELEASE_MS for the
 * arithmetic); every other shape this rule admits - `preparing`, or `filling` at a later stage - can
 * legitimately be mid-option-probe or mid-draft for much longer, so it keeps the general bound. A
 * `filling` row with no progress_stage at all is not the measured page-open shape either and falls
 * through to the general bound, which is the direction that can only ever make a release wait
 * longer.
 */
export function stalledFillRunReleaseBoundMs(
  review: Pick<ApplicationReviewState, 'status' | 'progress_stage'>,
): number {
  return review.status === 'filling' && review.progress_stage === MANAGED_FILL_PAGE_OPEN_STAGE
    ? STALLED_FILL_RUN_PAGE_OPEN_RELEASE_MS
    : STALLED_FILL_RUN_RELEASE_MS;
}

/**
 * THE WHOLE GATE, in one place that can be asserted directly rather than mirrored by a test.
 *
 * Composed here and not inline at the call site for the reason #912's extraction gives: a gate
 * written inside a transaction can only be MIRRORED by a test, and a mirror keeps passing after the
 * real one has been changed.
 *
 * Both halves are required and neither implies the other. The ledger says nothing about whether a
 * run is still executing; the clock says nothing about whether an employer holds an application.
 */
export function stalledFillRunReleaseIsAdmissible(
  review: Parameters<typeof stalledFillRunIsReleasable>[0],
  retrySafety: SubmissionAttemptRetrySafety,
  nowMs: number,
  boundMs: number = STALLED_FILL_RUN_RELEASE_MS,
): boolean {
  if (!stalledFillRunLedgerProvesNoEmployerContact(retrySafety)) return false;
  return stalledFillRunIsReleasable(review, nowMs, boundMs);
}

/**
 * The released review for a fill run that stopped without saying so.
 *
 * `needs_attention` rather than `failed`, for the reason submissionFailureOutcome states when it
 * routes preClickProvenByLedger the same way: the point of the release is that the packet becomes
 * re-runnable, and an unclaimed `needs_attention` row is the state submitRequestDisposition already
 * answers `start` for. It is also a member of FIRST_SEND_REVIEW_STATUSES, which is what makes
 * /applications/:id/submission attach the submission-authority envelope again - and without that
 * envelope the dashboard quarantines the packet and refuses every send with a sentence about
 * evidence this packet does not have.
 *
 * The run's transient fields go with it. submission_run_id, the progress stage and its screenshot
 * all describe a run that is over; leaving them would show a live-looking progress line under a
 * packet that is waiting to be restarted. `questions`, `filled_fields`, the packet audit and every
 * other piece of work the dead run actually completed are untouched, so a restart does not
 * re-derive what is already known.
 *
 * submission_authorization GOES TOO, and it costs nothing to drop. Every path that reaches
 * `submitting` writes a fresh one in the same patch that sets the status - the approve route, the
 * extension route and the standing-consent route all do - so a restart cannot be short of one.
 * Keeping the dead run's copy would leave a `per_application_approval` standing on a packet whose
 * approval was spent on a send that never happened, and authorizationValidAtClick honours that
 * source without re-asking. Same reasoning, and the same field, as
 * releaseAttemptThatNeverReachedEmployer.
 *
 * THE REASON IS CHOSEN BY THE SAME STAGE CHECK stalledFillRunReleaseBoundMs uses, not by which bound
 * the caller happened to pass: the two must never disagree about which shape a row is, or a row
 * released under the tight page-open bound could still be told the generic `run_failed` sentence
 * that spends a whole paragraph on a form this row never reached.
 */
export function releaseStalledFillRun(
  review: ApplicationReviewState,
  nowIso: string = new Date().toISOString(),
): ApplicationReviewState {
  const neverOpenedTheForm = review.status === 'filling'
    && review.progress_stage === MANAGED_FILL_PAGE_OPEN_STAGE;
  const attentionReason = neverOpenedTheForm
    ? STALLED_FILL_RUN_PAGE_OPEN_ATTENTION_REASON
    : STALLED_FILL_RUN_ATTENTION_REASON;
  return {
    ...review,
    status: 'needs_attention',
    submission_run_id: undefined,
    submission_error: undefined,
    progress_stage: undefined,
    progress_screenshot_url: undefined,
    progress_updated_at: undefined,
    handoff_expires_at: undefined,
    browser_context_id: undefined,
    submission_authorization: undefined,
    attention_reason: attentionReason,
    attention_categories: attentionCategoriesForReasons([attentionReason]),
    updated_at: nowIso,
  };
}
