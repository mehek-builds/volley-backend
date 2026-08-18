import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { applications } from '../db/schema';
import { confirmedSubmissionLifecycle } from './canonicalApplicationLifecycle';

/* THE CANONICAL ROW IS A SECOND READER OF THE SAME FACT, and every packet writer owes it the news.
 *
 * The packet's _review predates the applications table: stamping it 'submitted' and its
 * pipeline_stage 'applied' used to BE the dashboard. Measured on 2026-08-18: four employer receipts
 * (DV Trading, Nuro, ForSight, Skydio) each resolved their packet to submitted/applied while the
 * applications row the tracker actually renders sat at submission_state 'ready_to_submit',
 * tracker_state 'saved' - a filed application the product kept offering to send again. The email
 * confirmation writer was fixed first; this module exists so the other seven writers that stamp a
 * packet submitted (the four runner submit paths, the extension outcome, the attended-handoff
 * family, the email fallback) advance the canonical row through the same statement instead of each
 * growing its own.
 *
 * The written states are manualSubmissionTransition's 'confirmed' outcome, taken from the shared
 * constant so the writers cannot drift. updated_at is now, never the receipt time: a reconciler
 * heal replays receipts that are weeks old, and the tracker lists rows by updated_at descending,
 * so backdating would bury a row at the exact moment its state changed. The WHERE re-checks the
 * state exactly the way savePacketReview does: two writers racing may both read 'not submitted',
 * and only one of them may write.
 */
export async function syncCanonicalApplicationRow(input: {
  packetId: string;
  userId: string;
}): Promise<void> {
  await db.update(applications).set({
    submission_state: confirmedSubmissionLifecycle.submissionState,
    tracker_state: confirmedSubmissionLifecycle.trackerState,
    updated_at: new Date(),
  }).where(and(
    eq(applications.legacy_generated_resume_id, input.packetId),
    eq(applications.user_id, input.userId),
    sql`${applications.submission_state} <> 'submitted'`,
  ));
}

export type CanonicalApplicationSyncDeps = {
  sync?: (input: { packetId: string; userId: string }) => Promise<void>;
};

/* Best-effort, by design, on every path that calls it. The packet write it follows is the one the
 * applicant's outcome depends on - a webhook delivery, a submit run holding a live browser, a
 * dashboard answer - and before this sync existed none of those could be failed by the applications
 * table having a bad day. The cost of the swallow is real and named: only a packet with a stored
 * employer confirmation email can be replayed (reconcileSubmissionConfirmations, itself run by
 * hand, not a scheduler), so for every other writer a failure here leaves the very split state
 * this module exists to close, until a retry of the same route or a receipt for the same packet
 * fires the advance again. The warn below is the only trace that this is happening; it must never
 * become a throw. */
export async function advanceCanonicalApplicationFromPacketSubmission(
  input: { packetId: string; userId: string },
  deps: CanonicalApplicationSyncDeps = {},
): Promise<void> {
  try {
    await (deps.sync ?? syncCanonicalApplicationRow)(input);
  } catch (error) {
    // The packet outcome must not depend on the canonical write.
    console.warn('[canonical-sync] failed to advance the application row', { packetId: input.packetId, error });
  }
}
