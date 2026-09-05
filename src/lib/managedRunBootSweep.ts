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
 * stalledFillRunRelease.ts's three-hour silence bound. Run once, after the database is reachable, a
 * short delay AFTER this process starts serving (see start() in index.ts,
 * MANAGED_RUN_BOOT_SWEEP_DELAY_MS below) rather than before it - see "WHY AFTER listen(), NOT
 * BEFORE IT" further down for why that moved.
 *
 * THE PROOF THIS SWEEP RELIES ON, spelled out because it is the one thing a reader has to trust
 * before believing a foreign run_owner may be treated as urgently as this process's own SIGTERM
 * would treat one of its own runs.
 *
 *   This is a SINGLE-INSTANCE Railway service: railway.json declares no numReplicas and no
 *   healthcheckPath, restartPolicyType is ALWAYS, and the ordinary case this feature fixes is a
 *   redeploy that REPLACES the one running process rather than adding a second one beside it. So a
 *   row's stored run_owner naming a value that is not RUN_OWNER_ID (this process's own identity,
 *   see managedRunLifecycle.ts) MOST OFTEN means one of two things, and both mean the owning
 *   process cannot still be running it:
 *
 *     - it ran the SIGTERM handler to completion and released every pre-boundary run it owned
 *       before exiting - in which case this sweep will not even find the row, because the release
 *       already moved it out of preparing/filling/submitting; or
 *     - it did not - a grace-period SIGKILL, or a crash that delivered no signal at all - in which
 *       case the process is unconditionally gone. SIGKILL admits no cleanup and a crashed process
 *       cannot be running anything.
 *
 * WHY AFTER listen(), NOT BEFORE IT, AND WHY THAT ALONE IS NOT ENOUGH. Railway's own deploy is not
 * guaranteed to be the hard cutover the single-instance argument above assumes: a zero-downtime
 * rollout can keep the OLD process serving traffic (and therefore still actively running a fill)
 * for a brief overlap while the NEW process boots and binds its port. Running this sweep BEFORE
 * listen() does not close that window - it makes it worse, because "before serving" says nothing
 * about whether the OLD instance has actually stopped, only that this new one has not yet started.
 * So the sweep now runs a short delay after listen() resolves, to give Railway's own traffic
 * handoff a moment to finish draining the old instance before this process forms an opinion about
 * rows it does not own - and it is now paired with the age floor below, which is the actual defence
 * against the residual overlap a delay alone cannot bound with certainty.
 *
 * THE AGE FLOOR. A candidate is only released if its last recorded activity
 * (stalledFillRunLastActivityAt's `updated_at`/`progress_updated_at` maximum, imported from
 * stalledFillRunRelease.ts) is older than MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS - see that constant's
 * own doc for the derivation. A row a genuinely still-running OLD process is actively filling keeps
 * advancing its own progress stamp, so a row this sweep finds with a RECENT stamp is exactly the
 * shape a live overlap would produce, and is left alone; a row idle for longer than the floor is not
 * something any live fill (this codebase's own citable call-deadline cadence, cited below) could
 * produce, whichever process owns it.
 *
 * There is no remaining case of a row that is BOTH foreign-owned AND older than the floor but still
 * actively running: no live fill goes that long between progress writes under this service's normal
 * operation, so aging past the floor is itself evidence the owning run is not merely slow - it is
 * gone, exactly as the single-instance argument above already established for the ordinary
 * hard-cutover case, now doubly guarded against the zero-downtime overlap this file used to assume
 * away.
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
import { MANAGED_PREPARE_FILL_DEADLINE_MS } from './browserbase';
import { RUN_OWNER_ID } from './managedRunLifecycle';
import { releaseOrphanedManagedRun, type ManagedRunRestartReleaseLog } from './managedRunRestartRelease';
import { stalledFillRunLastActivityAt } from './stalledFillRunRelease';

/**
 * How long a foreign-owned candidate must have gone without a progress write before this sweep will
 * treat it as safe to release, on top of (never instead of) the single-instance/foreign-run_owner
 * proof in the file header.
 *
 * THE DERIVATION. MANAGED_PREPARE_FILL_DEADLINE_MS (browserbase.ts, 420_000ms / 7 minutes) is the
 * longest a single prepare-path provider call is allowed to run before it must return - the
 * tightest citable bound this codebase has on how long a LIVE, healthy run can go without doing
 * something that could advance `progress_updated_at`. A Railway zero-downtime overlap - the risk
 * this floor exists for - is measured in seconds, not minutes: the old instance is draining, not
 * starting new work, so its remaining lifetime is bounded by however long its own in-flight
 * requests take to finish, not by a fresh 7-minute call budget. Adding a flat one-minute margin on
 * top of the citable call deadline (480_000ms / 8 minutes total) leaves that overlap window no room
 * to reach this floor while still being far short of STALLED_FILL_RUN_RELEASE_MS's three hours - so
 * a row this sweep is right to recover is not made to wait anywhere near that long.
 *
 * NOT CLAIMING THIS BOUNDS EVERY GAP A LIVE RUN CAN EVER PRODUCE - stalledFillRunRelease.ts's own
 * doc cites a citable 25-minute gap for the option-probe discovery phase, which is why THAT file's
 * bound is three hours, not eight minutes. This floor is not standing in for that one: it exists
 * only to distinguish "a deploy overlap, seconds long" from "a dead process", and it is allowed to
 * occasionally wait behind a live run's own longer internal gap before releasing - the cost of
 * firing late here is an applicant waiting a few extra minutes for a sweep that runs once per boot;
 * the cost of firing early is the false "try again" a boot sweep would otherwise risk on a row the
 * old instance is still actively holding.
 */
export const MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS = MANAGED_PREPARE_FILL_DEADLINE_MS + 60_000;

/**
 * How long this process waits, after app.listen() resolves, before running the boot sweep - see the
 * file header's "WHY AFTER listen(), NOT BEFORE IT". Short enough that a genuinely orphaned row is
 * still recovered promptly on this boot rather than idling for a full three hours; long enough to
 * give Railway's own traffic handoff a moment to finish draining whatever the old instance was still
 * serving before this process forms an opinion about rows it does not own. Not itself a safety
 * mechanism - the age floor above is - just a courtesy that keeps the ordinary case (a hard cutover,
 * no overlap at all) from firing before the old process has even had a chance to exit.
 */
export const MANAGED_RUN_BOOT_SWEEP_DELAY_MS = 5_000;

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
  /** The stored run_owner THIS SELECT observed - carried forward so releaseOrphanedManagedRun can
   * re-confirm it under its own FOR UPDATE lock rather than trusting this plain, unlocked read.
   * See that function's own doc on expectedRunOwner for the race this closes: a row can be claimed
   * anew, or already released by another actor, in the window between this query and that lock. */
  run_owner: string;
  /** The two stamps stalledFillRunLastActivityAt takes the later of - carried out of this plain
   * SELECT (rather than re-read under a lock, the way run_owner is re-confirmed) because the age
   * floor is a courtesy against a brief deploy overlap, not the release's own safety proof; a stamp
   * that moved between this read and releaseOrphanedManagedRun's own lock only ever means a live
   * run just wrote to the row, which that function's fresh, locked read and CAS already handle
   * correctly on their own. */
  updated_at: string | null;
  progress_updated_at: string | null;
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
    run_owner: sql<string>`${generated_resumes.spec}->'_review'->>'run_owner'`,
    updated_at: sql<string | null>`${generated_resumes.spec}->'_review'->>'updated_at'`,
    progress_updated_at: sql<string | null>`${generated_resumes.spec}->'_review'->>'progress_updated_at'`,
  }).from(generated_resumes).where(and(
    sql`${generated_resumes.spec}->'_review'->>'status' in ('preparing', 'filling', 'submitting')`,
    sql`${generated_resumes.spec}->'_review'->>'run_owner' is not null`,
    sql`${generated_resumes.spec}->'_review'->>'run_owner' <> ${currentRunOwner}`,
  )).limit(limit);
  return rows;
}

/**
 * The age-floor half of admissibility: is this candidate's own last-recorded activity old enough
 * that a live, healthy run could not still be producing it? See MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS
 * for the derivation.
 *
 * A candidate with NEITHER stamp readable (stalledFillRunLastActivityAt returns null) is refused
 * here rather than treated as "infinitely old" - the same fail-closed discipline every other
 * absent-evidence check in this feature follows: an unreadable stamp proves nothing about how long
 * the row has been idle, so it is left for the pre-existing three-hour bound rather than released on
 * a guess.
 */
export function orphanedManagedRunCandidateIsOldEnough(
  candidate: Pick<ManagedRunBootSweepCandidate, 'updated_at' | 'progress_updated_at'>,
  nowMs: number,
  floorMs: number = MANAGED_RUN_BOOT_SWEEP_AGE_FLOOR_MS,
): boolean {
  const lastActivityAt = stalledFillRunLastActivityAt({
    // '' rather than undefined for updated_at: ApplicationReviewState types it as a required
    // string, and Date.parse('') is NaN either way, so stalledFillRunLastActivityAt's own
    // Number.isFinite filter already treats a missing value exactly like an unparseable one.
    updated_at: candidate.updated_at ?? '',
    progress_updated_at: candidate.progress_updated_at ?? undefined,
  });
  if (lastActivityAt === null) return false;
  return lastActivityAt + floorMs < nowMs;
}

/**
 * Run the whole sweep once. Idempotent: a candidate this call cannot release (lock contended, not
 * admissible, lost a race, or too recently active) is simply left for the next boot or the existing
 * three-hour bound - this never retries within one call, and calling it again immediately re-reads
 * the same, now-smaller, candidate set.
 *
 * BEST EFFORT AND NEVER FATAL TO BOOT. A database that is not yet reachable, or any other failure
 * reading candidates, is the caller's problem (see start() in index.ts, which logs and proceeds to
 * serve regardless) - this sweep is a recovery for a known failure mode, not a precondition for the
 * server to run at all, and every row it would have fixed still has the three-hour bound behind it.
 */
export async function runManagedRunBootSweep(
  log: ManagedRunRestartReleaseLog,
  now: () => number = Date.now,
): Promise<{ scanned: number; released: number; tooRecent: number }> {
  const candidates = await findOrphanedManagedRunCandidates();
  let released = 0;
  let tooRecent = 0;
  for (const candidate of candidates) {
    if (!orphanedManagedRunCandidateIsOldEnough(candidate, now())) {
      tooRecent += 1;
      continue;
    }
    const result = await releaseOrphanedManagedRun({
      packetId: candidate.id,
      userId: candidate.user_id,
      expectedRunOwner: candidate.run_owner,
      log,
    });
    if (result.outcome === 'released') released += 1;
  }
  if (candidates.length > 0) {
    log.info(
      { scanned: candidates.length, released, tooRecent },
      'Boot-time managed run orphan sweep finished',
    );
  }
  return { scanned: candidates.length, released, tooRecent };
}
