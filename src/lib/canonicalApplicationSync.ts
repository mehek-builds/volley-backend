import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { applications, generated_resumes } from '../db/schema';
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
}): Promise<boolean> {
  const advanced = await db.update(applications).set({
    submission_state: confirmedSubmissionLifecycle.submissionState,
    tracker_state: confirmedSubmissionLifecycle.trackerState,
    updated_at: new Date(),
  }).where(and(
    eq(applications.legacy_generated_resume_id, input.packetId),
    eq(applications.user_id, input.userId),
    sql`${applications.submission_state} <> 'submitted'`,
  )).returning({ id: applications.id });
  // Whether a row was actually moved. The packet writers ignore this - their job was done the
  // moment the statement ran - but the reconciler's healed counter is this answer, and the guard
  // in the WHERE means false is "nothing was wrong or someone else already fixed it", not an error.
  return advanced.length > 0;
}

export type CanonicalApplicationSyncDeps = {
  sync?: (input: { packetId: string; userId: string }) => Promise<void>;
};

/* Best-effort, by design, on every path that calls it. The packet write it follows is the one the
 * applicant's outcome depends on - a webhook delivery, a submit run holding a live browser, a
 * dashboard answer - and before this sync existed none of those could be failed by the applications
 * table having a bad day. The cost of the swallow is bounded rather than gone:
 * a failure here leaves the split state this module exists to close until a retry of the same
 * route, a receipt for the same packet, or a pass of reconcileCanonicalApplicationRows below -
 * which replays this exact statement for every packet the swallow left behind, whatever route
 * dropped it. The warn below is the only trace of the individual failure; it must never become a
 * throw. */
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

export type CanonicalSplitPacket = { packetId: string; userId: string };

export type CanonicalReconcileOutcome = {
  scanned: number;
  healed: number;
  unchanged: number;
  failed: number;
};

/* THE READER-SIDE HEAL, for the two ways the writer-side sync above can be missed.
 *
 * Every writer that stamps a packet submitted is supposed to advance the canonical row through
 * this module, but two gaps were accepted when that wiring landed and both are closed here from
 * the reading side instead. First, the advance swallows its own failures by contract, and until
 * now only a packet with a stored employer confirmation email could ever be replayed
 * (reconcileSubmissionConfirmations); a swallowed failure on any other path was permanent unless
 * the same route happened to be retried. Second, applications.ts has no way to force a future
 * route through the writer-side sync, so a new packet writer can silently skip it and recreate
 * the split this module exists to close.
 *
 * The sweep does not care which of the two happened. It reads the split state itself - a packet
 * whose review says 'submitted' beside a canonical row that still offers to send it - and replays
 * the one shared statement, syncCanonicalApplicationRow, for each. Per packet rather than as one
 * bulk UPDATE, deliberately: the statement IS the contract every writer shares, and a second copy
 * of it phrased as a join would be the drift this module was built to prevent. The volume is
 * bounded by the limit, and a healed row leaves the candidate set, so repeated passes converge.
 *
 * NOT WIRED TO A SCHEDULER, for the same reason as reconcileSubmissionConfirmations and stated
 * the same way: adding a cron entry is a separate decision with its own blast radius. It is
 * hosted by an authorized route (see routes/canonicalApplicationHeal.ts), a script, or a one-off.
 */
export async function reconcileCanonicalApplicationRows(
  input: { userId?: string; limit?: number } = {},
  deps: {
    listSplitPackets?: (query: { userId?: string; limit: number }) => Promise<CanonicalSplitPacket[]>;
    sync?: (input: CanonicalSplitPacket) => Promise<boolean>;
  } = {},
): Promise<CanonicalReconcileOutcome> {
  const limit = Math.max(1, Math.min(input.limit ?? 200, 1000));
  const sync = deps.sync ?? syncCanonicalApplicationRow;
  const rows = await (deps.listSplitPackets ?? listCanonicalSplitPackets)({ userId: input.userId, limit });
  let healed = 0;
  let unchanged = 0;
  let failed = 0;
  for (const row of rows) {
    // One failing packet must not abort the pass: the rows come back in a stable order, so an
    // uncaught throw would deterministically kill every future pass at the same row.
    try {
      if (await sync(row)) {
        healed += 1;
      } else {
        // The guarded WHERE found nothing left to fix: a writer or a concurrent pass got there
        // between the list and this statement. That is the guard working, not a failure.
        unchanged += 1;
      }
    } catch (error) {
      failed += 1;
      console.warn('[canonical-sync] reconcile could not heal an application row', { packetId: row.packetId, error });
    }
  }
  return { scanned: rows.length, healed, unchanged, failed };
}

/* The split state, read exactly the way the writers describe it: the packet's _review says
 * 'submitted' and the canonical row keyed by that packet and its owner does not. The join carries
 * user_id as well as the packet id so a row can only ever be paired with its own owner's packet,
 * the same two keys the guarded UPDATE writes by.
 *
 * Ordered oldest packet first, and the ORDER BY is load-bearing rather than cosmetic. Without it
 * the limit selects a planner-dependent subset, so two passes over a backlog bigger than the
 * limit can keep re-reading the same rows while never reaching the rest, and the counters stop
 * being comparable between runs. Oldest first because the oldest split is the one that has been
 * lying to its owner the longest. */
async function listCanonicalSplitPackets(query: { userId?: string; limit: number }): Promise<CanonicalSplitPacket[]> {
  return db
    .select({ packetId: generated_resumes.id, userId: generated_resumes.user_id })
    .from(generated_resumes)
    .innerJoin(applications, and(
      eq(applications.legacy_generated_resume_id, generated_resumes.id),
      eq(applications.user_id, generated_resumes.user_id),
    ))
    .where(and(
      sql`${generated_resumes.spec}->'_review'->>'status' = 'submitted'`,
      sql`${applications.submission_state} <> 'submitted'`,
      ...(query.userId ? [eq(generated_resumes.user_id, query.userId)] : []),
    ))
    .orderBy(generated_resumes.created_at, generated_resumes.id)
    .limit(query.limit);
}
