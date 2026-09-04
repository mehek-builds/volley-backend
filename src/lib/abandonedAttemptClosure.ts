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
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import { readApplicationReview } from './applicationReview';
import {
  appendSubmissionAttemptEvent,
  ATTEMPT_NEVER_REACHED_EMPLOYER_EVIDENCE,
  attemptNeverReachedEmployer,
  groupByAttempt,
  submissionAttemptBindingFromEvent,
  submissionAttemptEventId,
  submissionAttemptEventsForUser,
  submissionAttemptRetrySafety,
  type SubmissionAttemptEventRecord,
  type SubmissionAttemptLedgerExecutor,
} from './submissionAttemptLedger';

/**
 * Whether this attempt is provably dead and provably pre-boundary, so closing it costs nothing.
 *
 * `packetClaimId` is the packet review's `submission_claim_id`, which IS the attempt id of the run
 * holding it: claimSubmission generates one value and uses it for both. Pass null when the packet
 * holds no claim.
 */
export function abandonedPreBoundaryAttemptIsClosable(input: {
  attemptEvents: readonly SubmissionAttemptEventRecord[];
  packetClaimId: string | null | undefined;
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
  /* THE LIVENESS DISCRIMINATOR. Still the packet's claim means a run may still be executing it, and
   * that case needs a wall-clock bound to reach the same certainty (see PR #912), rather than the
   * certainty this line gets for free. */
  if (input.packetClaimId && input.packetClaimId === attemptId) return false;
  return true;
}

/** This closure's own factKey for the shared ATTEMPT_NEVER_REACHED_EMPLOYER_EVIDENCE fact, so its
 * event id never collides with repairExpiredAttendedHandoffClaim's write of the same evidence. */
export const ABANDONED_ATTEMPT_CLOSURE_FACT_KEY = 'abandoned-pre-boundary-attempt';


/**
 * Close every abandoned pre-boundary attempt this user still carries, and report which.
 *
 * Idempotent and safe to call on any send. An attempt already carrying `not_sent_proven` fails
 * attemptNeverReachedEmployer, so a second call closes nothing and writes nothing.
 *
 * THE POST-WRITE ASSERTION IS THE POINT, and it mirrors the one POST /submission/unverified makes:
 * the ledger is re-read after the append and the attempt must actually fold to `safe_not_sent`. A
 * fact that did not move the fold would leave the packet blocked while this function reported it
 * healed, which is the failure the caller cannot see.
 *
 * The caller must supply its write transaction. appendSubmissionAttemptEvent takes the user
 * advisory lock, which is reentrant when the caller already holds it.
 */
export async function closeAbandonedPreBoundaryAttempts(input: {
  userId: string;
  executor: SubmissionAttemptLedgerExecutor;
}): Promise<{ closedAttemptIds: string[] }> {
  const events = await submissionAttemptEventsForUser(input.userId, { executor: input.executor });
  const grouped = groupByAttempt(events);
  /* Only an attempt the fold already treats as a block is worth reading a packet row for. Every
   * other kind is either safe, confirmed, or malformed, and none of them is this function's. */
  const candidates = [...grouped.entries()].filter(([, attemptEvents]) => {
    const safety = submissionAttemptRetrySafety(attemptEvents);
    return safety.kind === 'blocked_unverified' && safety.reason === 'opened';
  });
  if (candidates.length === 0) return { closedAttemptIds: [] };

  const packetIds = [...new Set(candidates.map(([, attemptEvents]) => attemptEvents[0]!.packet_id))];
  const packets = await input.executor.select({
    id: generated_resumes.id,
    spec: generated_resumes.spec,
  }).from(generated_resumes).where(and(
    eq(generated_resumes.user_id, input.userId),
    inArray(generated_resumes.id, packetIds),
  ));
  const claimByPacketId = new Map<string, string | null>();
  for (const packet of packets) {
    claimByPacketId.set(packet.id, readApplicationReview(packet.spec)?.submission_claim_id ?? null);
  }

  const closedAttemptIds: string[] = [];
  for (const [attemptId, attemptEvents] of candidates) {
    const opening = attemptEvents.find((event) => event.event_kind === 'attempt_opened');
    if (!opening) continue;
    if (!abandonedPreBoundaryAttemptIsClosable({
      attemptEvents,
      packetClaimId: claimByPacketId.get(opening.packet_id) ?? null,
    })) continue;
    await appendSubmissionAttemptEvent({
      ...submissionAttemptBindingFromEvent(opening),
      eventId: submissionAttemptEventId(
        attemptId,
        'not_sent_proven',
        ABANDONED_ATTEMPT_CLOSURE_FACT_KEY,
      ),
      eventKind: 'not_sent_proven',
      proofKind: 'typed_pre_click_stop',
      evidenceCode: ATTEMPT_NEVER_REACHED_EMPLOYER_EVIDENCE,
    }, { executor: input.executor });
    const reread = (await submissionAttemptEventsForUser(input.userId, { executor: input.executor }))
      .filter((event) => event.attempt_id === attemptId);
    const resolved = submissionAttemptRetrySafety(reread);
    if (resolved.kind !== 'safe_not_sent' || resolved.proofKind !== 'typed_pre_click_stop') {
      throw new Error('ABANDONED_ATTEMPT_CLOSURE_FACT_INCOMPLETE');
    }
    closedAttemptIds.push(attemptId);
  }
  return { closedAttemptIds };
}
