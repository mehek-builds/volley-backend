/* Surviving a pooled connection that lands on a read-only backend.
 *
 * THE FAILURE THIS EXISTS FOR, observed in production on 2026-08-03. Writes through the pooled
 * Neon endpoint began failing with `cannot execute UPDATE in a read-only transaction` while the
 * direct (non-pooler) endpoint stayed writable the whole time, and while READS through the same
 * pooled host kept working. Sampling `show default_transaction_read_only` over ten fresh
 * connections to one hostname returned a MIX of on and off, so the pooler was spreading checkouts
 * across a writable primary and a read-only backend and a given connection got whichever it got.
 *
 * That shape is the dangerous one. It is not an outage: reads succeed, the app looks healthy, and
 * only writes fail, intermittently, as an unexplained 500. Saving a base resume took six attempts
 * and five of them failed. A student would read that as "Litos is broken" and an operator would
 * find nothing wrong, because the next connection they open by hand is writable.
 *
 * WHY A RETRY IS SAFE HERE, which is the whole argument for doing this rather than surfacing it.
 * Postgres refuses a write on a read-only backend BEFORE the statement executes (the check that
 * raises 25006 runs ahead of execution), so a 25006 is proof that nothing happened: no rows
 * touched, no sequence advanced, no trigger fired. That makes the statement safe to run again in a
 * way an ordinary failure is not. This retries ONLY 25006 for exactly that reason - a timeout or a
 * connection drop is NOT retried here, because either could have committed.
 *
 * A retry gets a fresh checkout, which is the point: the pool hands out a different backend, so an
 * attempt that failed on the replica can land on the primary. Three attempts is not a magic
 * number, it is the point where a persistent read-only project (a Neon quota stop, where EVERY
 * backend is read-only) stops looking like a transient one and should surface as an error rather
 * than being retried into a long hang.
 */

/** Postgres SQLSTATE for `read_only_sql_transaction`. */
export const READ_ONLY_SQLSTATE = '25006';

/** True when a rejected write can be safely retried on a fresh connection. */
export function isReadOnlyTransactionError(error: unknown): boolean {
  let current = error;
  const seen = new Set<unknown>();

  while (current && typeof current === 'object' && !seen.has(current)) {
    if ((current as { code?: unknown }).code === READ_ONLY_SQLSTATE) return true;
    seen.add(current);
    current = (current as { cause?: unknown }).cause;
  }

  return false;
}

/**
 * True when a `pool.query(...)` call must bypass the retry wrapper entirely.
 *
 * Two of pg's call shapes do not return an awaitable result, so there is nothing for a retry to
 * hold on to, and wrapping either one changes what the caller receives:
 *
 *   - CALLBACK FORM, `query(text, values, cb)`. pg returns void and calls back instead.
 *   - SUBMITTABLE, `query(new QueryStream(...))`. pg detects it by a `submit` method and hands the
 *     OBJECT ITSELF back synchronously so the caller can stream rows off it. Promise-wrapping that
 *     returns something with no `.on`, breaking the stream at the call site, far from the wrapper
 *     that caused it.
 *
 * Neither shape needs a retry: the incident this all exists for was ordinary awaited writes. This
 * is a predicate rather than an inline check so it can be tested without a live pool - the wrapper
 * itself binds pg's method at module load and cannot be intercepted afterwards.
 */
export function isPassThroughQueryCall(args: readonly unknown[]): boolean {
  if (args.length === 0) return false;
  if (typeof args[args.length - 1] === 'function') return true;
  const first = args[0] as { submit?: unknown } | null | undefined;
  return typeof first === 'object' && first !== null && typeof first.submit === 'function';
}

export interface ReadOnlyRetryOptions {
  /** Total attempts including the first. */
  attempts?: number;
  /** Pause between attempts. A different backend is assigned per checkout, so this is only here to
   *  stop three attempts landing inside the same instant of a failover. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Called once per swallowed failure, for logs. */
  onRetry?: (attempt: number) => void;
  /** Last resort after the normal attempts all hit a read-only backend. */
  onExhausted?: () => Promise<unknown>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation`, retrying ONLY when the backend rejected it as read-only.
 *
 * Every other error propagates on the first throw, unchanged and un-delayed. The last attempt's
 * error is rethrown as-is so a persistent read-only project still fails loudly, with the original
 * Postgres error the operator needs, rather than being masked by a wrapper of ours.
 */
export async function withReadOnlyRetry<T>(
  operation: () => Promise<T>,
  options: ReadOnlyRetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = options.delayMs ?? 150;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isReadOnlyTransactionError(error)) throw error;
      if (attempt >= attempts) {
        if (options.onExhausted) return await options.onExhausted() as T;
        throw error;
      }
      options.onRetry?.(attempt);
      if (delayMs > 0) await sleep(delayMs);
    }
  }
}
