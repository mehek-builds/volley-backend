/* THE ONE CRITICAL SECTION A PROVIDER CALL NEEDS, AND NOTHING MORE.
 *
 * A managed provider call is an outbound POST to stratus that can legitimately run for
 * MANAGED_PREPARE_FILL_DEADLINE_MS (280s). It has to be fenced against account deletion: a drain
 * that commits while a fill is in flight would delete the account out from under an employer form
 * that is already half filled, and a provider call started after a drain committed would keep
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
 * Run one provider call with this user's provider-call key held for its whole duration, after
 * proving in the same transaction that no account-deletion drain has committed.
 *
 * Do NOT write to a submission-authority-owned table inside `call`: those writes fire the revision
 * trigger, which try-locks the ledger key, and the point of this fence is that it does not hold it.
 */
export async function withProviderCallFence<T>(
  userId: string,
  call: (context: ProviderCallFenceContext) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await lockSubmissionProviderCallUser(tx, userId);
    await assertSubmissionAccountNotDraining(tx, userId);
    return call({ fenceDatabaseNow: () => databaseNow(tx) });
  });
}
