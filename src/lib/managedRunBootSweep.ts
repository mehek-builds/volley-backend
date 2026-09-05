/* THE BACKSTOP FOR WHEN THE GRACEFUL HANDLER NEVER RAN.
 *
 * index.ts's SIGTERM/SIGINT handler (installed in start(), the Railway path only) releases every
 * pre-boundary run this process's OWN registry knows about before it exits - but only when it gets
 * the chance. Railway sends SIGTERM, waits a grace period, then SIGKILLs; a handler that is still
 * mid-write when the grace period expires, or a bare crash that never delivered SIGTERM at all,
 * leaves a row exactly where the process left it, with no different behaviour than before this
 * feature existed.
 *
 * This sweep is what still recovers that row, on the VERY NEXT boot, without waiting out
 * stalledFillRunRelease.ts's three-hour silence bound. Run once, after the database is reachable
 * and before this process starts serving (see start() in index.ts) - so a request that lands the
 * instant this instance comes up never reads a row this sweep would have fixed a moment later.
 *
 * THE PROOF THIS SWEEP RELIES ON, spelled out because it is the one thing a reader has to trust
 * before believing a foreign run_owner may be treated as urgently as this process's own SIGTERM
 * would treat one of its own runs.
 *
 *   This is a SINGLE-INSTANCE Railway service: railway.json declares no numReplicas and no
 *   healthcheckPath, restartPolicyType is ALWAYS, and the whole premise of the defect this feature
 *   fixes is that a redeploy REPLACES the one running process rather than adding a second one
 *   beside it. So a row's stored run_owner naming a value that is not RUN_OWNER_ID (this process's
 *   own identity, see managedRunLifecycle.ts) can only mean one of two things, and both mean the
 *   owning process cannot still be running it:
 *
 *     - it ran the SIGTERM handler to completion and released every pre-boundary run it owned
 *       before exiting - in which case this sweep will not even find the row, because the release
 *       already moved it out of preparing/filling/submitting; or
 *     - it did not - a grace-period SIGKILL, or a crash that delivered no signal at all - in which
 *       case the process is unconditionally gone. SIGKILL admits no cleanup and a crashed process
 *       cannot be running anything.
 *
 *   There is no third case where the old process is merely SLOW to notice SIGTERM and still
 *   actively filling a form while a NEW process has already booted and started this sweep: on a
 *   single instance, nothing starts a new process before the old one has stopped occupying the
 *   deployment slot Railway is replacing it in.
 *
 * Rows with no run_owner at all - every row written before this shipped, and any row a future
 * change writes without stamping one - are deliberately left untouched here, for the honest reason
 * that an absent identity proves nothing about which process, if any, is still running it. Those
 * still fall back to the pre-existing three-hour bound, exactly as they did before this file
 * existed.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { generated_resumes } from '../db/schema';
import { RUN_OWNER_ID } from './managedRunLifecycle';
import { releaseOrphanedManagedRun, type ManagedRunRestartReleaseLog } from './managedRunRestartRelease';

/**
 * Bounds one sweep's candidate count, so a large backlog of foreign-owned rows - which should never
 * happen more than once per instance under normal operation, but "should never happen" is not a
 * bound - cannot make boot itself slow. Chosen far above any plausible single-instance backlog: one
 * process can only ever have been mid-run on a small number of packets at the moment it stopped
 * (one per user with an active managed run), so 200 is generous headroom, not a tight ceiling
 * measured against a real distribution.
 */
export const MANAGED_RUN_BOOT_SWEEP_MAX_CANDIDATES = 200;

export interface ManagedRunBootSweepCandidate {
  id: string;
  user_id: string;
}

/**
 * One query: every row in preparing/filling/submitting whose stored run_owner is set and names a
 * process that is not this one.
 *
 * `submitting` candidates ARE fetched here (matching the shape of the defect this whole feature
 * fixes, which can strand a row in any of the three statuses) but releaseOrphanedManagedRun will
 * find every one of them inadmissible: restartReleaseIsAdmissible defers to
 * stalledFillRunReleaseIsAdmissible, whose RELEASABLE_IN_FLIGHT_STATUSES allowlist is
 * preparing/filling only - by design, so the existing #912 stalled-submitting arm keeps sole
 * ownership of any row that may be at or past the employer boundary. They are still selected, and
 * still attempted, so this sweep's own log line is honest about what it saw rather than silently
 * filtering a status it is not the one that gets to decide is safe.
 */
export async function findOrphanedManagedRunCandidates(
  currentRunOwner: string = RUN_OWNER_ID,
  limit: number = MANAGED_RUN_BOOT_SWEEP_MAX_CANDIDATES,
): Promise<ManagedRunBootSweepCandidate[]> {
  const rows = await db.select({
    id: generated_resumes.id,
    user_id: generated_resumes.user_id,
  }).from(generated_resumes).where(and(
    sql`${generated_resumes.spec}->'_review'->>'status' in ('preparing', 'filling', 'submitting')`,
    sql`${generated_resumes.spec}->'_review'->>'run_owner' is not null`,
    sql`${generated_resumes.spec}->'_review'->>'run_owner' <> ${currentRunOwner}`,
  )).limit(limit);
  return rows;
}

/**
 * Run the whole sweep once. Idempotent: a candidate this call cannot release (lock contended, not
 * admissible, lost a race) is simply left for the next boot or the existing three-hour bound - this
 * never retries within one call, and calling it again immediately re-reads the same, now-smaller,
 * candidate set.
 *
 * BEST EFFORT AND NEVER FATAL TO BOOT. A database that is not yet reachable, or any other failure
 * reading candidates, is the caller's problem (see start() in index.ts, which logs and proceeds to
 * serve regardless) - this sweep is a recovery for a known failure mode, not a precondition for the
 * server to run at all, and every row it would have fixed still has the three-hour bound behind it.
 */
export async function runManagedRunBootSweep(
  log: ManagedRunRestartReleaseLog,
): Promise<{ scanned: number; released: number }> {
  const candidates = await findOrphanedManagedRunCandidates();
  let released = 0;
  for (const candidate of candidates) {
    const result = await releaseOrphanedManagedRun({
      packetId: candidate.id,
      userId: candidate.user_id,
      log,
    });
    if (result.outcome === 'released') released += 1;
  }
  if (candidates.length > 0) {
    log.info(
      { scanned: candidates.length, released },
      'Boot-time managed run orphan sweep finished',
    );
  }
  return { scanned: candidates.length, released };
}
