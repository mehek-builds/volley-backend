/* A CLAIM RELEASED BY THE ROW'S OWN EVIDENCE, WHEN THE HANDOFF THAT WOULD HAVE USED IT IS OVER.
 *
 * Fully (teamtailor), account mehekmandal05@gmail.com, measured live 2026-08-20. A managed run
 * claimed the send (submission_claimed_at 2026-08-19T22:34:30.915Z), filled the whole form, and
 * PARKED at the attended consent handoff without pressing send: status needs_attention,
 * attention_reason naming the applicant privacy terms it left to her, submitted_at null,
 * submission_attempted_at null, unverified_submission null, receipt null. The run completed and
 * reported honestly that nothing was sent.
 *
 * Every exit was then closed at once. POST /applications/:id/packet-audit refuses any row with
 * submission_claimed_at. submitRequestDisposition refuses claimed needs_attention, and its only
 * key, unverified_submission.resolution 'not_sent', exists only for runs whose press outcome was
 * UNKNOWN - a run that parked BEFORE pressing has no unverified record at all, so there is no
 * question for the applicant to answer and no route that accepts an answer. The attended path
 * that was supposed to finish it needs extension >= 0.5.10 and the store still serves 0.5.9. The
 * panel itself said "NO LIVE BROWSER TO REOPEN": handoff_expires_at (the prepare paths' now + 55
 * minute stamp) was long past, and managed runs write browser_session_id undefined. A permanently
 * un-auditable, un-runnable row whose own record says nothing ever reached the employer.
 *
 * THE RULE, AT THE ALTITUDE THE FILE'S OWN PHILOSOPHY SETS. Nothing here is decided by guessing on
 * the applicant's behalf, and the claim exists to prevent duplicate sends. So a claim may be
 * released without any human answer exactly when the row itself proves no send can have happened
 * AND no attended finish is still possible:
 *
 *   - status is the parked one (needs_attention), and
 *   - submitted_at is absent and employerMayHoldApplication answers false, which is the four
 *     stored facts (submission_attempted_at, receipt, unverified_submission, security_code) read
 *     through the ONE shared definition rather than a second copy of it, and
 *   - the attended window is over: handoff_expires_at is present and in the past. Deliberately NOT
 *     preparedRunHandoffExpired, whose browser_session_id guard answers a different question -
 *     "is there a live session worth reconnecting to" - and would answer false forever on managed
 *     runs, which write browser_session_id undefined. Here an absent session is part of the proof
 *     that nothing can finish this handoff, not a reason to keep waiting for it, and
 *   - no extension submission outcome event exists for this application, so an attended finish
 *     that DID happen in her own Chrome can never be erased by this release.
 *
 * WHAT IS NOT RELAXED. A row carrying an unverified_submission keeps its claim and its resolution
 * key untouched: "we do not know" is precisely the state the claim exists for, and her answer
 * remains the only thing that moves it. A row whose handoff has not expired keeps its claim, since
 * the attended finish it is protecting may still be in flight. A recorded attempt, a receipt, a
 * standing code wall and a submitted row are all refused through the shared evidence predicate.
 * And the release keeps status and attention exactly as they are: the choice the run honestly left
 * to the applicant is still hers, only the lock that made acting on it impossible is lifted.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index';
import { application_submission_events, applications } from '../db/schema';
import type { ApplicationReviewState } from './applicationReview';
import { employerMayHoldApplication } from './managedSubmitOutcome';
import { attentionCategoriesForReasons } from './submissionTerminalCause';

/** The machine-readable trace the release leaves behind. See ApplicationReviewState.claim_released. */
export type ExpiredHandoffClaimReleaseRecord = NonNullable<ApplicationReviewState['claim_released']>;

/**
 * Whether this row proves, on its own, that its claim guards a send that never happened and an
 * attended finish that can no longer happen. Pure; the extension-outcome check is the caller's
 * separate question because it lives in another table.
 */
export function expiredAttendedHandoffClaimIsReleasable(
  review: Pick<
    ApplicationReviewState,
    'status' | 'submission_claimed_at' | 'submitted_at' | 'handoff_expires_at'
    | 'submission_attempted_at' | 'receipt' | 'unverified_submission' | 'security_code'
  >,
  now: number = Date.now(),
): boolean {
  // No claim, nothing to release. This line is also what makes a double release idempotent.
  if (!review.submission_claimed_at) return false;
  if (review.status !== 'needs_attention') return false;
  if (review.submitted_at) return false;
  // The four stored facts that each mean something may already be at the employer, asked through
  // the one shared definition. A second definition of "may have been sent" is how this class of
  // bug recurs - see employerMayHoldApplication's own comment.
  if (employerMayHoldApplication(review)) return false;
  if (!review.handoff_expires_at) return false;
  const expiresAt = Date.parse(review.handoff_expires_at);
  return Number.isFinite(expiresAt) && expiresAt < now;
}

/**
 * The released review. Clears the claim and everything that rode with it - the handoff window it
 * was taken for, the browser fields of the run that parked, the authorization and reserved packet
 * version of the send that never happened - and records what was lifted and why, so the audit
 * trail says so in a form a query can read. Status, attention_reason and attention_categories are
 * deliberately untouched: the run's honest account of what it left to the applicant stays hers.
 */
export function releaseExpiredAttendedHandoffClaim(
  review: ApplicationReviewState,
  nowIso: string = new Date().toISOString(),
): ApplicationReviewState {
  return {
    ...review,
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    handoff_expires_at: undefined,
    browser_session_id: undefined,
    browser_context_id: undefined,
    claim_released: {
      cause: 'attended_handoff_expired',
      ...(review.submission_claim_id ? { claim_id: review.submission_claim_id } : {}),
      released_at: nowIso,
    },
    updated_at: nowIso,
  };
}

/* THE SECOND RELEASE, AND IT IS DECIDED BY THE LEDGER RATHER THAN BY THE CLOCK.
 *
 * The release above answers a row that parked at an attended handoff and whose window has closed.
 * This one answers a different wedge, measured 2026-09-02 on The Maven Group "Cyber Test Engineer"
 * (crelate), attempt 22b9663a: a send opened a ledger attempt, the first live provider call failed
 * 456 ms later, and the run wrote an unverified_submission asserting a press and kept the claim.
 * The attempt carried `attempt_opened` alone.
 *
 * Every exit was closed at once, and by its own fabrication. POST /applications/:id/packet-audit
 * refuses any row with submission_claimed_at. submitRequestDisposition refuses a claimed
 * needs_attention row. releasedExpiredAttendedHandoffReview above cannot help, because
 * employerMayHoldApplication answers true on the unverified record the failed send had just
 * invented. And the "It is not there" answer needs a boundary authorization that was never written.
 * The only control the product accepted was "I found it there", which would have recorded a
 * confirmed submission for an application that was never sent.
 *
 * THE RULE. A claim may be released, and the invented record erased, exactly when the immutable
 * ledger proves this attempt never crossed the employer boundary AND the row carries no evidence
 * that anything OTHER than this attempt reached an employer:
 *
 *   - attemptNeverReachedEmployer over the exact attempt's events: one attempt_opened, no
 *     boundary_authorized, no press_observed, no submission_confirmed, no not_sent_proven. This is
 *     the ledger's own admissibility rule for a machine-authored not-sent proof, read the only way
 *     it can be read before the boundary exists, and
 *   - no receipt, no submitted_at and no security_code. Those three are evidence an employer holds
 *     something, they are read here rather than through employerMayHoldApplication BECAUSE the two
 *     facts that predicate also reads - unverified_submission and submission_attempted_at - are
 *     precisely what this release is erasing. Asking the shared predicate would make the fabricated
 *     record veto its own repair, which is exactly the trap the row was in, and
 *   - the unverified record, if present, belongs to THIS attempt's run. A record left by an earlier
 *     run describes a different press and is not this attempt's to erase.
 *
 * WHAT IS NOT RELAXED. The record is erased only where the ledger proves it was never true. A
 * genuinely pressed and unconfirmed attempt carries boundary_authorized, so attemptNeverReachedEmployer
 * answers false, and every gate that blocks a second send keeps blocking. The caller must append
 * the not_sent_proven fact in the SAME transaction as this write; a released row whose ledger still
 * folds to blocked_unverified/'opened' would be unblocked at the packet and still blocked at the
 * duplicate gate.
 */
export function attemptNeverReachedEmployerIsReleasable(
  review: Pick<
    ApplicationReviewState,
    'submission_claim_id' | 'submission_claimed_at' | 'submitted_at' | 'receipt'
    | 'security_code' | 'unverified_submission' | 'submission_run_id'
  >,
): boolean {
  if (!review.submission_claimed_at || !review.submission_claim_id) return false;
  if (review.submitted_at || review.receipt || review.security_code) return false;
  const unverified = review.unverified_submission;
  if (unverified) {
    if (unverified.resolution) return false;
    /* An unverified record with no run id cannot be shown to belong to this attempt, and one
     * naming a different run belongs to an earlier press. Neither is this release's to erase. */
    if (!unverified.submission_run_id || !review.submission_run_id) return false;
    if (unverified.submission_run_id !== review.submission_run_id) return false;
  }
  return true;
}

/**
 * The released review for an attempt the ledger proves never reached the employer.
 *
 * Clears the claim, and clears the two facts a pre-boundary failure had no business writing: the
 * unverified_submission record and the submission_attempted_at that rode with it. Status becomes
 * needs_attention with the honest sentence, because submitRequestDisposition treats an unclaimed
 * needs_attention row as re-runnable and that is the whole point of the release: the packet is
 * sendable again from a fresh fill.
 */
export function releaseAttemptThatNeverReachedEmployer(
  review: ApplicationReviewState,
  attentionReason: string,
  nowIso: string = new Date().toISOString(),
): ApplicationReviewState {
  return {
    ...review,
    status: 'needs_attention',
    submission_claimed_at: undefined,
    submission_claim_id: undefined,
    submission_packet_version: undefined,
    submission_authorization: undefined,
    handoff_expires_at: undefined,
    browser_session_id: undefined,
    browser_context_id: undefined,
    submission_attempted_at: undefined,
    unverified_submission: undefined,
    attention_reason: attentionReason,
    attention_categories: attentionCategoriesForReasons([attentionReason]),
    claim_released: {
      cause: 'attempt_never_reached_employer',
      ...(review.submission_claim_id ? { claim_id: review.submission_claim_id } : {}),
      released_at: nowIso,
    },
    updated_at: nowIso,
  };
}

/**
 * Whether any extension submission outcome event was ever recorded for this packet's canonical
 * application. Any event at all refuses the release: an event means a browser the server does not
 * control observed a submission outcome here, and this module must never out-argue an observation.
 */
export async function packetHasExtensionSubmissionOutcomeEvent(
  packetId: string,
  userId: string,
): Promise<boolean> {
  const [event] = await db.select({ id: application_submission_events.id })
    .from(application_submission_events)
    .innerJoin(applications, eq(application_submission_events.application_id, applications.id))
    .where(and(
      eq(application_submission_events.user_id, userId),
      eq(applications.user_id, userId),
      eq(applications.legacy_generated_resume_id, packetId),
    ))
    .limit(1);
  return Boolean(event);
}

/**
 * The whole decision, for a caller holding the row: the pure evidence check, then the
 * extension-event check, then the released review. Null means "leave the row exactly as it is",
 * which is also the answer for a row that has already been released.
 */
export async function releasedExpiredAttendedHandoffReview(
  packetId: string,
  userId: string,
  review: ApplicationReviewState,
  now: number = Date.now(),
): Promise<ApplicationReviewState | null> {
  if (!expiredAttendedHandoffClaimIsReleasable(review, now)) return null;
  if (await packetHasExtensionSubmissionOutcomeEvent(packetId, userId)) return null;
  return releaseExpiredAttendedHandoffClaim(review, new Date(now).toISOString());
}
