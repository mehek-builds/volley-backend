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
 * and "the account is wedged". On Vercel the waiting request itself is simply killed by the platform
 * at api/index.ts's 300s maxDuration, with no catch block ever running: zero heartbeat, zero terminal
 * result, and the next retry - or a completely unrelated posting for the same account - repeats the
 * exact same silent hang against the same wedged key. See PROVIDER_CALL_LOCK_TIMEOUT_MS.
 */
import { db } from '../db/index';
import { databaseNow } from './browserProviderResourceCleanup';
import {
  assertSubmissionAccountNotDraining,
  lockSubmissionProviderCallUser,
} from './submissionAttemptLedger';

export type ProviderCallFenceContext = {
  /* The database clock read INSIDE the fence, so a budget that starts here is never charged for
   * the lock wait. Lazy: a fence whose caller does not need the clock pays no extra round trip. */
  fenceDatabaseNow: () => Promise<Date>;
};

/**
 * How long withProviderCallFence will wait for an earlier provider call on the same account before
 * giving up with a SubmissionProviderCallLockTimeoutError.
 *
 * THIS IS BOUNDED BY VOLLEY-BACKEND'S OWN REQUEST LIFETIME, NOT BY STRATUS'S. As of #974, stratus can
 * legitimately take up to MANAGED_PREPARE_FILL_DEADLINE_MS (420s) to fill a long form, because
 * stratus's OWN execution host - its Railway-hosted local runner - can wait that long
 * (MAX_RUN_TIMEOUT_MS 480s, validated against MAX_PROVIDER_DEADLINE_MS 8min; see browserbase.ts's
 * comment on that constant). That budget belongs to stratus's infrastructure, not this backend's.
 * volley-backend itself is still a single Vercel function: vercel.json's `api/index.ts` maxDuration
 * is 300s and untouched by #974, so the request making this outbound call - the one this fence's lock
 * wait and the provider call it guards both run inside - is killed by the PLATFORM at 300s regardless
 * of what stratus itself would still be willing to do. Nothing this fence wraps, and no wait for it,
 * can usefully exceed that 300s ceiling: a second call queued behind a first one already running long
 * would have too little of its OWN 300s budget left to dispatch anything by the time it got the lock -
 * exactly the gap assertManagedBrowserRequestBudgetAtClock's minimumDispatchBudgetMs already refuses
 * to dispatch into - so it was never going to complete in the same request either way. The only
 * question this constant answers is how quickly a WEDGED holder gets reported instead of hanging
 * silently until Vercel kills the request with no trace, which is what happens today with no bound at
 * all.
 *
 * 240s (4 minutes) sits comfortably above what a typical call needs - 420-480s describe stratus's OWN
 * worst-case ceiling, which this backend's own 300s platform limit already makes largely unreachable
 * from in here regardless - while still leaving a full 60s of this request's own 300s budget for the
 * timeout error to surface, for recordSubmissionRunnerFailure to close the ledger attempt, and for a
 * response to reach the caller: strictly better than the platform silently killing the request with
 * nothing written, which is what happens today once a wait runs that long.
 *
 * If Vercel's maxDuration ever rises to actually accommodate stratus's current ceilings, or if
 * MANAGED_PREPARE_FILL_DEADLINE_MS or SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS move again, this needs
 * re-deriving against the new numbers, not just left alone.
 */
export const PROVIDER_CALL_LOCK_TIMEOUT_MS = 240_000;

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
 * before this call's own provider request begins - see lockSubmissionProviderCallUser - and
 * submissionRunner.ts's submissionFailureReview treats it that way, the same as
 * SubmissionAccountDeletionDrainError.
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
