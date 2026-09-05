/* THE RELEASE ITSELF: WRITE AN HONEST TERMINAL STATE FOR A RUN THIS CALLER KNOWS IS OVER.
 *
 * The sibling of stalledFillRunRelease.ts, not a replacement for it. That file's whole premise is
 * UNCERTAINTY: nothing but elapsed time (STALLED_FILL_RUN_RELEASE_MS, three hours) separates a fill
 * that is merely slow from one that died, so it waits out a bound calibrated against the longest
 * citable gap between two progress writes before it will call a silent row dead.
 *
 * This file exists for the two callers who do NOT have to guess:
 *
 *   - index.ts's SIGTERM/SIGINT handler, over its own in-process registry
 *     (lib/managedRunLifecycle.ts). Registry membership already means "this process is executing
 *     this run", so a process that is itself about to exit knows with certainty that every run it
 *     still owns is ending right now, not slowing down.
 *   - managedRunBootSweep.ts, over rows whose stored `run_owner` names a process that is not this
 *     one. On this single-instance Railway service (restartPolicyType ALWAYS, one process), a
 *     foreign run_owner still sitting on an in-flight row at boot means that process is gone -
 *     either it ran this exact handler on its own way out and already released the row (so this
 *     sweep would not find it again), or it was SIGKILLed (Railway's grace-period backstop, or a
 *     hard crash) and cannot possibly still be running it. See that module's own doc for the
 *     overlap question this reasoning depends on.
 *
 * So both callers reuse stalledFillRunReleaseIsAdmissible UNCHANGED, passing a zero elapsed-time
 * bound instead of three hours - every other check it makes (status, no claim, no browser session,
 * no stored send evidence, the ledger proving no employer contact) applies exactly as it does for
 * the slow-stall case. This file adds urgency. It does not relax a single safety check.
 */

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { generated_resumes } from '../db/schema';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
import { settleStall } from './applicationStall';
import { attentionCategoriesForReasons } from './submissionTerminalCause';
import { stalledFillRunReleaseIsAdmissible } from './stalledFillRunRelease';
import {
  submissionAttemptEventsForPacket,
  submissionAttemptRetrySafetyForPacketEvents,
  tryLockSubmissionAttemptUser,
  type SubmissionAttemptRetrySafety,
} from './submissionAttemptLedger';
import { closeAbandonedPreBoundaryAttempts, type AbandonedAttemptClosureLog } from './abandonedAttemptClosure';

/**
 * The sentence the applicant reads. It has to contain "could not finish this application" - the
 * exact clause submissionTerminalCause.ts's attentionCategoriesForReasons matches to reach
 * `run_failed`, the "Litos broke, you can try it again" bucket - because every other bucket is
 * wrong for this state: nothing reached the employer (not `unverified_submission`), the run may
 * have opened the form (so this is not, in general, `form_not_reached`), and no employer control is
 * waiting on the applicant (none of captcha, account_login, privacy_consent). See the regex chain
 * in that file before ever changing this wording - a sentence that stops matching there falls
 * through to the generic `unknown` bucket, which offers no retry.
 *
 * Deliberately its own sentence rather than a reuse of STALLED_FILL_RUN_ATTENTION_REASON
 * (stalledFillRunRelease.ts). Both land the row in the same place and the same category, but they
 * are different facts: that one tells the applicant a run went silent and nobody knows why; this
 * one tells her Litos restarted, which is both more honest (we know exactly what happened) and less
 * alarming (a restart is routine; a silent run sounds like something broke inside her application).
 */
export const MANAGED_RUN_RESTART_ATTENTION_REASON =
  'Litos restarted while it was filling this form, so it could not finish this application. This '
  + 'attempt stopped before anything was sent, and nothing has gone to the employer. Try again.';

/**
 * The row-and-ledger gate, urgent instead of patient.
 *
 * Reuses stalledFillRunReleaseIsAdmissible with boundMs pinned to 0 instead of its
 * STALLED_FILL_RUN_RELEASE_MS default, so `lastActivityAt + 0 < now` is satisfied by any row whose
 * last write is strictly in the past - which every row reaching this function has, since it must
 * already have been written at least once to exist in `preparing` or `filling`. Every OTHER check
 * inside that function - the status allowlist, the no-claim/no-session/no-send-evidence refusals,
 * and the ledger's own no-employer-contact proof - is untouched, because this file's only claim is
 * "the run is over now", never "the row was always safe to release".
 */
export function restartReleaseIsAdmissible(
  review: Parameters<typeof stalledFillRunReleaseIsAdmissible>[0],
  retrySafety: SubmissionAttemptRetrySafety,
  nowMs: number,
): boolean {
  return stalledFillRunReleaseIsAdmissible(review, retrySafety, nowMs, 0);
}

/**
 * The released review. Byte-for-byte releaseStalledFillRun's own field list (stalledFillRunRelease.ts)
 * plus one addition: run_owner is cleared alongside submission_run_id, for the same reason that
 * field is cleared - a run that is over must not go on describing itself as belonging to anyone,
 * least of all to a process identity a later boot would otherwise read as still live. See
 * run_owner's own doc in lib/applicationReview.ts.
 */
export function releaseManagedRunForRestart(
  review: ApplicationReviewState,
  nowIso: string = new Date().toISOString(),
): ApplicationReviewState {
  return {
    ...review,
    status: 'needs_attention',
    submission_run_id: undefined,
    run_owner: undefined,
    submission_error: undefined,
    progress_stage: undefined,
    progress_screenshot_url: undefined,
    progress_updated_at: undefined,
    handoff_expires_at: undefined,
    browser_context_id: undefined,
    submission_authorization: undefined,
    attention_reason: MANAGED_RUN_RESTART_ATTENTION_REASON,
    attention_categories: attentionCategoriesForReasons([MANAGED_RUN_RESTART_ATTENTION_REASON]),
    updated_at: nowIso,
  };
}

export type ManagedRunRestartReleaseLog = AbandonedAttemptClosureLog & {
  info: (details: Record<string, unknown>, message: string) => void;
};

export type ManagedRunRestartReleaseOutcome =
  | { outcome: 'released' }
  | {
    outcome: 'left_in_place';
    reason: 'row_missing' | 'lock_contended' | 'not_admissible' | 'cas_lost';
  };

/**
 * Release ONE packet's row for a run this caller already knows is over - see the file header for
 * the two callers and why each is certain. Shared by both, so the release rule is written and
 * tested exactly once.
 *
 * NOT SCOPED TO ONE REQUEST'S ALREADY-LOADED ROW, unlike routes/applications.ts's
 * repairStalledFillRun which this otherwise mirrors closely: a shutdown or a boot sweep crosses
 * every user this process happens to be holding a run for, so this takes packet and user ids and
 * does its own fresh read. Same lock discipline throughout (try, never wait - see
 * tryLockSubmissionAttemptUser's own doc for the incident a blocking lock on a similar path caused),
 * same database-clock read so the elapsed-time comparison cannot be made against a stamp captured
 * before this transaction started, same whole-spec-JSON CAS on the write so a concurrent writer -
 * the run's own still-executing promise, most plausibly - always wins if it gets there first.
 *
 * BEST EFFORT AND SAFE TO SKIP. Every failure branch below leaves the row exactly as it was: a
 * contended lock, a row that moved out of preparing/filling since it was registered, or a lost CAS
 * all mean some other actor already has an opinion about this row, and the existing gates (the
 * three-hour stall bound, chief among them) still apply to it afterwards exactly as if this
 * function had never been called.
 */
export async function releaseOrphanedManagedRun(input: {
  packetId: string;
  userId: string;
  log: ManagedRunRestartReleaseLog;
}): Promise<ManagedRunRestartReleaseOutcome> {
  const result = await db.transaction(async (tx) => {
    if (!(await tryLockSubmissionAttemptUser(tx, input.userId))) {
      return { outcome: 'left_in_place', reason: 'lock_contended' } as const;
    }
    const [locked] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, input.packetId),
      eq(generated_resumes.user_id, input.userId),
    )).limit(1).for('update');
    const current = locked ? readApplicationReview(locked.spec) : null;
    if (!locked || !current) return { outcome: 'left_in_place', reason: 'row_missing' } as const;
    const clockResult = await tx.execute(sql`select clock_timestamp() as now`);
    const clockValue = (clockResult.rows[0] as { now?: Date | string } | undefined)?.now;
    const databaseNow = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
    const nowMs = Number.isNaN(databaseNow.getTime()) ? Date.now() : databaseNow.getTime();
    const events = await submissionAttemptEventsForPacket(input.userId, locked.id, { executor: tx });
    const retrySafety = submissionAttemptRetrySafetyForPacketEvents(events);
    if (!restartReleaseIsAdmissible(current, retrySafety, nowMs)) {
      return { outcome: 'left_in_place', reason: 'not_admissible' } as const;
    }
    const released = settleStall(releaseManagedRunForRestart(current, new Date(nowMs).toISOString()));
    const [updated] = await tx.update(generated_resumes)
      .set({ spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(released)}::jsonb, true)` })
      .where(and(
        eq(generated_resumes.id, locked.id),
        eq(generated_resumes.user_id, input.userId),
        sql`${generated_resumes.spec} = ${JSON.stringify(locked.spec)}::jsonb`,
      ))
      .returning({ id: generated_resumes.id });
    if (!updated) return { outcome: 'left_in_place', reason: 'cas_lost' } as const;
    return { outcome: 'released' } as const;
  });

  if (result.outcome !== 'released') {
    if (result.reason === 'lock_contended') {
      input.log.warn(
        { applicationId: input.packetId },
        'Restart release skipped: another actor on this account holds the submission attempt lock',
      );
    }
    return result;
  }

  input.log.info(
    { applicationId: input.packetId },
    'Released a managed run this process could not finish before restarting',
  );

  /* BEST EFFORT, SAME PACKET ONLY, AND ALMOST ALWAYS A NO-OP HERE. A preparing/filling row - this
   * release's entire domain - holds no claim by construction (stalledFillRunIsReleasable refuses
   * any row that does), so there is normally no ledger attempt on it to close. This still runs
   * because a packet can carry an EARLIER, unrelated abandoned attempt from a previous run that
   * this restart happens to be a convenient moment to also try healing - see
   * closeAbandonedPreBoundaryAttempts's own doc. Failure here does not undo the release above: the
   * row is already honestly parked at needs_attention regardless of whether an old ledger attempt
   * also closes. */
  try {
    await db.transaction((tx) => closeAbandonedPreBoundaryAttempts({
      userId: input.userId,
      executor: tx,
      log: input.log,
      packetIds: [input.packetId],
    }));
  } catch (error) {
    input.log.warn(
      { applicationId: input.packetId, err: error },
      'Could not close an abandoned pre-boundary attempt after a restart release',
    );
  }

  return result;
}
