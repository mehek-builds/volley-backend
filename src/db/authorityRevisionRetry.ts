/* Surviving the submission-authority revision guard's own "retry the request".
 *
 * THE FAILURE THIS EXISTS FOR, observed in production on 2026-09-01. POST
 * /applications/:id/submit-request failed 500 with `submission authority changed concurrently;
 * retry the request` while the dashboard was polling GET /applications/:id/submission. The guard
 * function `lock_submission_authority_revision_user` takes the per-user advisory lock with
 * pg_try_advisory_xact_lock and RAISES (errcode 40001) rather than waiting, so any review write
 * that fires the revision bump fails the moment a reader - the authority projection behind a poll,
 * a history load, or a concurrent run - holds the same user's lock for even a few milliseconds.
 * The error text instructs the caller to retry; nothing did, so the applicant saw a failed run.
 *
 * WHY A RETRY IS SAFE HERE. The guard raises inside the trigger, which aborts the whole statement's
 * transaction: no row was touched, no revision was bumped, nothing committed. A 40001 from this
 * guard is proof that nothing happened, the same argument withReadOnlyRetry makes for 25006. This
 * helper is for SINGLE-STATEMENT writes only: a 40001 inside an explicit multi-statement
 * transaction aborts that whole transaction, and retrying one statement inside it cannot succeed -
 * such callers must retry their whole transaction themselves.
 */

/** Postgres SQLSTATE for `serialization_failure`, used by the authority revision guard. */
export const AUTHORITY_REVISION_CONFLICT_SQLSTATE = '40001';

/** True when an error (or anything in its cause chain) is the authority guard's retryable raise. */
export function isAuthorityRevisionConflictError(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    if ((current as { code?: unknown }).code === AUTHORITY_REVISION_CONFLICT_SQLSTATE) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface AuthorityRevisionRetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Pause between attempts, long enough for a projection read holding the lock to finish. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once per swallowed conflict, for logs. */
  onRetry?: (attempt: number) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying ONLY on the authority revision guard's 40001.
 *
 * Every other error propagates on the first throw. The last attempt's error is rethrown as-is so a
 * genuinely stuck lock still fails loudly with the original Postgres error.
 */
export async function withAuthorityRevisionRetry<T>(
  operation: () => Promise<T>,
  options: AuthorityRevisionRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = options.delayMs ?? 120;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isAuthorityRevisionConflictError(error) || attempt >= attempts) throw error;
      options.onRetry?.(attempt);
      await sleep(delayMs);
    }
  }
}
