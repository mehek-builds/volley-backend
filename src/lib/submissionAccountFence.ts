/* THE ONE CRITICAL SECTION A PROVIDER CALL NEEDS, AND NOTHING MORE.
 *
 * A managed provider call is an outbound POST to stratus that can legitimately run for
 * MANAGED_PREPARE_FILL_DEADLINE_MS (420s, as of #974). It has to be fenced against account deletion:
 * a drain that commits while a fill is in flight would delete the account out from under an employer
 * form that is already half filled, and a provider call started after a drain committed would keep
 * touching an employer on behalf of an account that no longer exists.
 *
 * That is the WHOLE invariant. Until 2026-09-02 the fence bought it with the ledger key
 * `submission-attempt:<userId>`, which every ledger reader and the submission-authority revision
 * trigger also take, so the price of one fill was: /resume/history blocked for the length of the
 * call, /applications/:id/submission blocked on every 2.5s dashboard poll, the pool drained by the
 * blocked readers, and every single-statement write to that user's generated_resumes, applications
 * or artifacts raising 40001 -> 503 "This account changed at the same time."
 *
 * `submission-provider-call:<userId>` buys the same fence and nothing else. See
 * lockSubmissionProviderCallUser for the lock-order rule shared with account deletion.
 *
 * BOUNDED SINCE 2026-09-05. The acquire below is otherwise unbounded: a holder that never releases
 * the key - a stratus hang that somehow outlives its own deadline, a connection left half-dead so its
 * transaction's rollback-on-error never runs - queued out every later provider call for that account
 * FOREVER, with no timeout, no error, and no distinction between "another call is legitimately busy"
 * and "the account is wedged". Production runs on Railway now (DEPLOY.md), a persistent listener with
 * no per-request platform kill, so the waiting request does not even get the mercy of being killed:
 * it hangs until something external intervenes, with no catch block ever running - zero heartbeat,
 * zero terminal result - and the next retry, or a completely unrelated posting for the same account,
 * repeats the exact same silent hang against the same wedged key. (On Vercel, DEPLOY.md's documented
 * rollback target, the platform's own 300s maxDuration would at least kill the request; that is worse
 * for observability but was never the actual defect - the missing bound was.) See
 * PROVIDER_CALL_LOCK_TIMEOUT_MS.
 */
import { db } from '../db/index';
import { databaseNow } from './browserProviderResourceCleanup';
import {
  assertSubmissionAccountNotDraining,
  lockSubmissionProviderCallUser,
  PROVIDER_CALL_LOCK_TIMEOUT_MS,
} from './submissionAttemptLedger';

export type ProviderCallFenceContext = {
  /* The database clock read INSIDE the fence, so a budget that starts here is never charged for
   * the lock wait. Lazy: a fence whose caller does not need the clock pays no extra round trip. */
  fenceDatabaseNow: () => Promise<Date>;
};

export { PROVIDER_CALL_LOCK_TIMEOUT_MS };

/**
 * Run one provider call with this user's provider-call key held for its whole duration, after
 * proving in the same transaction that no account-deletion drain has committed.
 *
 * Do NOT write to a submission-authority-owned table inside `call`: those writes fire the revision
 * trigger, which try-locks the ledger key, and the point of this fence is that it does not hold it.
 *
 * Can reject with SubmissionProviderCallLockTimeoutError before `call` ever runs, if an earlier call
 * for this account is still holding the key past `options.lockTimeoutMs` (default
 * PROVIDER_CALL_LOCK_TIMEOUT_MS) after this one started waiting. That is always a stop strictly
 * before this call's own provider request begins - see lockSubmissionProviderCallUser -
 * so submissionRunner.ts's submissionFailureReview can treat it as pre-click once the ledger
 * confirms the boundary was never reached for this exact attempt (see SubmissionProviderCallLockTimeoutError's
 * own comment for why that check, unlike SubmissionAccountDeletionDrainError's, cannot be skipped).
 *
 * `options.lockTimeoutMs` exists for tests that need to prove the timeout fires against a real
 * contended lock without waiting the real four minutes out - see submissionProviderCallFence.db.test.ts
 * - mirroring authorizeFinalSubmissionBoundary's own `options.ttlMs`. No production call site passes
 * it; both existing callers leave it at the default.
 */
export async function withProviderCallFence<T>(
  userId: string,
  call: (context: ProviderCallFenceContext) => Promise<T>,
  options: { lockTimeoutMs?: number } = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockSubmissionProviderCallUser(tx, userId, {
      lockTimeoutMs: options.lockTimeoutMs ?? PROVIDER_CALL_LOCK_TIMEOUT_MS,
    });
    await assertSubmissionAccountNotDraining(tx, userId);
    return call({ fenceDatabaseNow: () => databaseNow(tx) });
  });
}
