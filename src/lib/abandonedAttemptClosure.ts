/* THE ATTEMPT NOBODY IS RUNNING ANY MORE, AND THE EMPLOYER SEND IT BLOCKS FOREVER.
 *
 * MEASURED 2026-09-03. Databricks "Software Engineering Intern (2027 Start) - Winter", canonical
 * application 1d4c8113. The applicant is refused with:
 *
 *   "Not sent: Litos has an earlier attempt on ... and does not know whether this application went
 *    through ... Open that earlier attempt in your Tracker, check the employer's page, and tell
 *    Litos whether it is there."
 *
 * Three things are wrong with that, and only one of them is about the Tracker being gone.
 *
 * FIRST, THERE IS NOTHING TO CHECK. The earlier attempt carries `attempt_opened` and nothing else.
 * No `boundary_authorized`, no `press_observed`. The immutable ledger PROVES the run never crossed
 * the employer boundary, so there is no application on the employer's page for her to look for.
 * Sending her to look is asking her to confirm the absence of a thing that cannot exist.
 *
 * SECOND, THE BLOCK IS PERMANENT WITHOUT HER. An attempt folding to blocked_unverified/'opened' is
 * returned by blockingSubmissionAttemptsForUser forever. It blocks every further send on its own
 * packet AND, through duplicateApplicationVerdict, every other application to the same posting.
 * Nothing ages it out and nothing closes it.
 *
 * THIRD, THE EXISTING REPAIR CANNOT REACH IT. repairExpiredAttendedHandoffClaim closes exactly this
 * shape, but only while the attempt is still the packet's live claim: the parked needs_attention
 * wedge, or a stalled `submitting` row. An attempt whose row has since moved on and dropped that
 * claim is orphaned, and no code path looks at it again.
 *
 * THE RULE, and it needs no clock and no applicant.
 *
 *   A pre-boundary attempt may be closed when the ledger proves it never reached the employer AND
 *   the packet no longer holds it as its live claim.
 *
 * The second half is the liveness discriminator, and it is EVIDENCE rather than a timer.
 * claimSubmission writes `submission_claim_id` and appends `attempt_opened` in ONE transaction, so
 * an attempt that exists always had a claim. If the packet's claim is now absent, or names a
 * different attempt, the run that opened this one is over. That is why this module can be certain
 * where a live claim has to wait out a wall-clock bound (see PR #912): there, the attempt IS still the
 * live claim and only elapsed time separates a slow run from a dead one. The two are deliberately
 * disjoint, and the live-claim case is left entirely to whatever bounds it.
 *
 * WHAT IS NOT RELAXED. attemptNeverReachedEmployer is the whole proof and it is unchanged: one
 * `attempt_opened`, no `boundary_authorized`, no `press_observed`, no `submission_confirmed`, no
 * existing `not_sent_proven`. An attempt that authorized the boundary is durable employer risk and
 * is refused here however old it is, so a genuinely uncertain send still blocks, still keeps its
 * question, and is still the applicant's to answer.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { generated_resumes } from '../db/schema';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
import { employerMayHoldApplication, type StoredSendEvidence } from './managedSubmitOutcome';
import { STALLED_FILL_RUN_RELEASE_MS } from './stalledFillRunRelease';
import {
  appendSubmissionAttemptEvent,
  ATTEMPT_NEVER_REACHED_EMPLOYER_EVIDENCE,
  attemptNeverReachedEmployer,
  groupByAttempt,
  lockSubmissionAttemptUser,
  submissionAttemptBindingFromEvent,
  submissionAttemptEventId,
  submissionAttemptEventsForUser,
  submissionAttemptRetrySafety,
  type SubmissionAttemptEventRecord,
  type SubmissionAttemptLedgerExecutor,
} from './submissionAttemptLedger';

/** The packet-review facts this closure asks about employer contact: its own status, checked
 * against SUBMISSION_BOUNDARY_STATUSES below, plus the four StoredSendEvidence facts
 * employerMayHoldApplication already reads. See packetReviewProvesNoEmployerContact. */
export type AbandonedAttemptClosurePacketReview =
  Pick<ApplicationReviewState, 'status'> & StoredSendEvidence;

/** What this predicate could establish about the packet an attempt's opening names. `null` means
 * the row could not be read - missing, or its stored review would not parse - and that is a
 * REFUSAL, never a stand-in for "no claim". See the note on `packet` below. */
export type AbandonedAttemptClosurePacket = {
  /** The packet review's `submission_claim_id`, which IS the attempt id of the run holding it:
   * claimSubmission generates one value and uses it for both. `null` means the packet holds no
   * claim at all. */
  claimId: string | null;
  /** The rest of the row's own evidence about whether an employer may already hold something. */
  review: AbandonedAttemptClosurePacketReview;
};

/* REVIEW ROUND 2, 2026-09-04. STATUSES WHERE A MANAGED BROWSER MAY BE AT OR PAST THE BOUNDARY.
 *
 * The first cut of packetReviewProvesNoEmployerContact below borrowed reviewAnswerSaveDisposition
 * (submissionSafety.ts) for its status opinion, reasoning that "reject" already meant "do not trust
 * this row". It does not: that function refuses `ready_for_final_approval` UNCONDITIONALLY, for a
 * reason with nothing to do with employer contact - the packet has a filled-form preview on screen,
 * and a concurrent answer save would leave that picture describing a form it no longer matches.
 * Borrowed here, that one line meant a packet parked at ready_for_final_approval on a NEWER attempt
 * could never get an orphaned, provably-dead EARLIER attempt closed - which is exactly the
 * Databricks shape this module exists for (see the file header): she reaches final approval on
 * attempt B, and the block from abandoned attempt A never lifts, because the packet's OWN status -
 * not any evidence on the row - refused it forever.
 *
 * So this closure enumerates its own boundary statuses instead of borrowing anyone else's opinion
 * of the row. A live run's StoredSendEvidence fields (receipt, security_code, unverified_submission,
 * submission_attempted_at) are written by that run AS IT GOES, and this closure holds no lock on
 * whatever OTHER attempt currently owns the claim - so while the packet's status says a browser may
 * be at or past the boundary, those fields cannot be trusted as the complete picture, only as
 * whatever had been written the instant this query ran.
 *
 *   submitting              A claimed run is actively authorizing or pressing the employer
 *                           boundary right now.
 *   submission_claimed      A run has taken the claim and not yet released it - the other status a
 *                           live send holds before it authorizes the boundary; the identical pairing
 *                           guards attemptNeverReachedEmployerIsReleasable in
 *                           expiredHandoffClaimRelease.ts against the same poll-kills-the-send risk.
 *   submitted               A click is known to have landed.
 *   awaiting_security_code  The form was already sent once and the applicant is mid-verification -
 *                           see the status union in applicationReview.ts ("the form has already
 *                           been sent to the employer once").
 *
 * NOT boundary statuses, enumerated so a future status added to the union has to be sorted into one
 * list or the other rather than silently defaulting: ready_for_final_approval (filled and
 * previewed, never clicked - the exact packet this closure exists to unblock), needs_attention,
 * failed, filling, preparing and submit_requested (each a run that already stopped short of the
 * boundary, or has taken no claim yet), and resume_ready, questions_ready, ready_to_submit (too
 * early for any claim to exist at all).
 */
const SUBMISSION_BOUNDARY_STATUSES = new Set<ApplicationReviewState['status']>([
  'submitting',
  'submission_claimed',
  'submitted',
  'awaiting_security_code',
]);

/** The packet review's own answer to "may an employer already hold something", built for this
 * closure alone - see the SUBMISSION_BOUNDARY_STATUSES comment above for why it is no longer
 * borrowed from a gate that answers a different question.
 *
 * THIS IS THE SECOND PROOF a legacy_backfill opening needs. attemptNeverReachedEmployer is pure
 * arithmetic over event kinds, and a legacy_backfill attempt carries only `attempt_opened` because
 * the 2026-08-27T14:11:35.408Z migration that wrote it recorded nothing else about the run - not
 * because anyone observed this exact run stop before the boundary. The packet's CURRENT review is
 * the one place that can still say so.
 *
 * `submission_attempted_at` is checked again on its own, stricter than employerMayHoldApplication
 * alone: that predicate neutralises a stale attempted_at once the applicant has looked and said "it
 * is not there", because her own look is the release it is built to trust. Nothing here is her
 * looking - this is a machine closing an attempt she never saw - so a standing submission_attempted_at
 * is left as a refusal regardless of any resolution recorded against it. */
function packetReviewProvesNoEmployerContact(review: AbandonedAttemptClosurePacketReview): boolean {
  if (employerMayHoldApplication(review)) return false;
  if (review.submission_attempted_at) return false;
  if (SUBMISSION_BOUNDARY_STATUSES.has(review.status)) return false;
  return true;
}

/**
 * Whether this attempt is provably dead and provably pre-boundary, so closing it costs nothing.
 *
 * `packet` is what the caller could establish about the row an attempt's opening names, at the
 * moment it asked. UNKNOWN IS NOT "NO CLAIM". A packet row that has been deleted, or whose spec no
 * longer parses as a review, tells this predicate nothing about whether some other run still holds
 * it - so pass `null` for that, and it refuses, exactly like every other shape this predicate is
 * unsure of. Only a packet the caller actually read - `{ claimId }` - may answer the liveness
 * question below.
 *
 * `now` is epoch milliseconds and defaults to the real clock; a caller supplies its own only to
 * check both sides of the time margin below without waiting three hours for it.
 */
export function abandonedPreBoundaryAttemptIsClosable(input: {
  attemptEvents: readonly SubmissionAttemptEventRecord[];
  packet: AbandonedAttemptClosurePacket | null;
  now?: number;
}): boolean {
  const events = input.attemptEvents;
  if (events.length === 0) return false;
  /* THE PROOF. Everything else on this predicate is about whether anyone is still running the
   * attempt; this is the only line that says nothing reached the employer, and it is the one that
   * must never be relaxed. */
  if (!attemptNeverReachedEmployer(events)) return false;
  const attemptId = events[0]!.attempt_id;
  /* Redundant today and kept deliberately. Every event kind other than `attempt_opened` is one
   * attemptNeverReachedEmployer already refuses, and it also requires exactly one opening, so a
   * mixed-attempt group cannot reach this line. That is a property of the CLOSED event vocabulary,
   * not of this rule, and `attemptId` below decides a claim comparison. A mutation run confirms the
   * line is unreachable on its own; it is here so a future event kind cannot make it necessary
   * without anyone noticing. */
  if (events.some((event) => event.attempt_id !== attemptId)) return false;
  if (!input.packet) return false;
  /* THE LIVENESS DISCRIMINATOR. Still the packet's claim means a run may still be executing it, and
   * that case needs a wall-clock bound to reach the same certainty (see PR #912), rather than the
   * certainty this line gets for free. */
  if (input.packet.claimId === attemptId) return false;
  /* THE SECOND PROOF. See packetReviewProvesNoEmployerContact: the event vocabulary alone is not
   * enough for a legacy_backfill opening, which carries only `attempt_opened` by construction of
   * the migration that wrote it rather than by observation of this run stopping pre-boundary. */
  if (!packetReviewProvesNoEmployerContact(input.packet.review)) return false;
  /* THE TIME MARGIN. Dropping the claim only proves the run that opened THIS attempt is no longer
   * the packet's live claim - it says nothing about whether that run's browser has actually
   * finished exiting. Closing the instant the claim moves on would be the poll-kills-the-send
   * defect the liveness discriminator above exists to avoid, reached from the other direction. The
   * same bound stalledFillRunRelease.ts pays for a claim that is still live is paid here for a claim
   * that has already gone: the opening has to be older than STALLED_FILL_RUN_RELEASE_MS before its
   * age alone may stand in for "nothing is still running it". A legacy_backfill row is days old, so
   * this costs the class of attempt this module exists for nothing. Compared as a deadline against
   * `now`, matching stalledFillRunIsReleasable's own polarity, so the two cannot silently invert
   * relative to each other. */
  const opening = events.find((event) => event.event_kind === 'attempt_opened')!;
  const now = input.now ?? Date.now();
  if (!(opening.created_at.getTime() + STALLED_FILL_RUN_RELEASE_MS < now)) return false;
  return true;
}

/** This closure's own factKey for the shared ATTEMPT_NEVER_REACHED_EMPLOYER_EVIDENCE fact, so its
 * event id never collides with repairExpiredAttendedHandoffClaim's write of the same evidence. */
export const ABANDONED_ATTEMPT_CLOSURE_FACT_KEY = 'abandoned-pre-boundary-attempt';

/** A minimal structural logger, so this module does not have to import Fastify's types to accept
 * one. Every logger this codebase actually passes around - a Fastify request/instance `log` among
 * them - already calls `.warn(details, message)` and so already satisfies this. */
export type AbandonedAttemptClosureLog = {
  warn: (details: Record<string, unknown>, message: string) => void;
};

/**
 * Close every abandoned pre-boundary attempt this user still carries, and report which closed and
 * which could not.
 *
 * Idempotent and safe to call on any send. An attempt already carrying `not_sent_proven` fails
 * attemptNeverReachedEmployer, so a second call closes nothing and writes nothing for it.
 *
 * EACH CANDIDATE GETS ITS OWN SAVEPOINT. A first cut of this function ran every candidate's append
 * and post-write assertion straight against the caller's transaction, so one candidate's failure -
 * the assertion below, or any other error appending its fact - threw out of the whole function and
 * rolled back every OTHER candidate's close in the same db.transaction, on the one path that is
 * supposed to heal this. A user carrying two abandoned attempts, one of them malformed, would then
 * never get either closed: the malformed one fails forever and takes the healthy one down with it
 * on every future send. Wrapping each candidate in its own `input.executor.transaction` opens a
 * SAVEPOINT when the executor is already inside a transaction - which every real caller's is - so a
 * failed candidate rolls back only its own attempted write and the loop moves on to the next one.
 * Failures are reported, not swallowed: `failedAttemptIds` names every candidate that did not
 * close, and the caller's own logger records why.
 *
 * THE POST-WRITE ASSERTION IS STILL THE POINT, and it mirrors the one POST /submission/unverified
 * makes: the fact just appended, folded together with the events already read, must actually
 * resolve the attempt to `safe_not_sent`. A fact that did not move the fold would leave the packet
 * blocked while this function reported it healed, which is the failure the caller cannot see. It is
 * folded LOCALLY rather than re-read from the user's whole ledger: appendSubmissionAttemptEvent
 * already returns the exact row it wrote (or the exact existing row a replay found), and the user
 * advisory lock this function holds for its own whole call (see below) rules out a concurrent writer
 * changing the answer between the append and a re-read.
 *
 * The caller must supply its write transaction.
 *
 * THIS FUNCTION TAKES THE USER ADVISORY LOCK ITSELF, on `input.executor` directly, before any
 * candidate's own savepoint opens - REVIEW ROUND 2, 2026-09-04. appendSubmissionAttemptEvent also
 * takes it, but on whatever executor IT is given, which inside the loop below is a per-candidate
 * savepoint. A Postgres transaction-level advisory lock acquired for the FIRST time inside a
 * savepoint is released by ROLLBACK TO SAVEPOINT, same as an ordinary row lock taken there - so if
 * nothing had locked `input.executor` before the loop, the first candidate to fail would roll back
 * its savepoint AND silently drop this user's ledger serialization for every candidate still to
 * come in the same call, the one property this function's docs above promise. Locking here removes
 * that dependence on the caller: it always runs before the loop touches a single savepoint. Taking
 * it again inside a savepoint costs nothing - Postgres advisory xact locks are reentrant within one
 * session - so production's own caller (refuseDuplicateApplication's tryLockSubmissionAttemptUser)
 * pre-locking the same way stays exactly as harmless as it always was.
 */
export async function closeAbandonedPreBoundaryAttempts(input: {
  userId: string;
  executor: SubmissionAttemptLedgerExecutor;
  log?: AbandonedAttemptClosureLog;
}): Promise<{ closedAttemptIds: string[]; failedAttemptIds: string[] }> {
  await lockSubmissionAttemptUser(input.executor, input.userId);
  const events = await submissionAttemptEventsForUser(input.userId, { executor: input.executor });
  const grouped = groupByAttempt(events);
  /* Only an attempt the fold already treats as a block is worth reading a packet row for. Every
   * other kind is either safe, confirmed, or malformed, and none of them is this function's. */
  const candidates = [...grouped.entries()].filter(([, attemptEvents]) => {
    const safety = submissionAttemptRetrySafety(attemptEvents);
    return safety.kind === 'blocked_unverified' && safety.reason === 'opened';
  });
  if (candidates.length === 0) return { closedAttemptIds: [], failedAttemptIds: [] };

  const packetIds = [...new Set(candidates.map(([, attemptEvents]) => attemptEvents[0]!.packet_id))];
  const packets = await input.executor.select({
    id: generated_resumes.id,
    spec: generated_resumes.spec,
  }).from(generated_resumes).where(and(
    eq(generated_resumes.user_id, input.userId),
    inArray(generated_resumes.id, packetIds),
  ));
  /* A packet id this map has no entry for - row deleted, or never matched the query above - reads
   * as `null` at the lookup below via `?? null`, exactly like a row whose spec would not parse.
   * Both are "unknown", and unknown refuses; see abandonedPreBoundaryAttemptIsClosable. */
  const packetById = new Map<string, AbandonedAttemptClosurePacket | null>();
  for (const packet of packets) {
    const review = readApplicationReview(packet.spec);
    packetById.set(packet.id, review ? { claimId: review.submission_claim_id ?? null, review } : null);
  }

  const closedAttemptIds: string[] = [];
  const failedAttemptIds: string[] = [];
  for (const [attemptId, attemptEvents] of candidates) {
    const opening = attemptEvents.find((event) => event.event_kind === 'attempt_opened');
    if (!opening) continue;
    if (!abandonedPreBoundaryAttemptIsClosable({
      attemptEvents,
      packet: packetById.get(opening.packet_id) ?? null,
    })) continue;
    try {
      await input.executor.transaction(async (savepoint) => {
        const appended = await appendSubmissionAttemptEvent({
          ...submissionAttemptBindingFromEvent(opening),
          eventId: submissionAttemptEventId(
            attemptId,
            'not_sent_proven',
            ABANDONED_ATTEMPT_CLOSURE_FACT_KEY,
          ),
          eventKind: 'not_sent_proven',
          proofKind: 'typed_pre_click_stop',
          evidenceCode: ATTEMPT_NEVER_REACHED_EMPLOYER_EVIDENCE,
        }, { executor: savepoint });
        const resolved = submissionAttemptRetrySafety([...attemptEvents, appended.event]);
        if (resolved.kind !== 'safe_not_sent' || resolved.proofKind !== 'typed_pre_click_stop') {
          throw new Error('ABANDONED_ATTEMPT_CLOSURE_FACT_INCOMPLETE');
        }
      });
      closedAttemptIds.push(attemptId);
    } catch (error) {
      failedAttemptIds.push(attemptId);
      input.log?.warn(
        { attemptId, packetId: opening.packet_id, err: error },
        'Could not close an abandoned pre-boundary attempt; leaving it for the next heal',
      );
    }
  }
  return { closedAttemptIds, failedAttemptIds };
}
