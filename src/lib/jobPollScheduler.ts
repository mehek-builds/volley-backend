/**
 * One monitor invocation selects at most one segment.
 *
 * The catalog is intentionally segmented at 400 sources before it grows past that boundary. The
 * GitHub workflow drains subsequent oldest-first segments, while the daily Vercel invocation still
 * covers today's 355 reviewed sources in one pass. Keeping this separate from the time budget makes
 * growth predictable: adding source 401 changes the response to polling_complete=false instead of
 * silently expanding one serverless invocation.
 */
export const POLL_SEGMENT_SIZE = 400;
/** Deprecated response-field alias. Its value remains the actual per-invocation selection cap. */
export const POLL_SOURCE_LIMIT = POLL_SEGMENT_SIZE;
export const POLL_CONCURRENCY = 12;
export const POLL_TIME_BUDGET_MS = 210_000;
export const POLL_START_RESERVE_MS = 30_000;
export const WORKABLE_START_INTERVAL_MS = 1_100;

type PollSource = { ats_name: string };

type PollQueueOptions = {
  concurrency?: number;
  timeBudgetMs?: number;
  workableStartIntervalMs?: number;
  startReserveMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type RetryOptions = {
  attempts?: number;
  delayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

/** Retry a live verification operation without converting a persistent failure into a pass. */
export async function retryTransient<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delayMs = Math.max(0, options.delayMs ?? 250);
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw lastError;
}

/**
 * Poll a mixed provider queue without letting one invocation consume the full function lifetime.
 *
 * Ordinary sources run concurrently because each request goes to a different employer board.
 * Workable is different: all account requests share one public API limit, documented as 10 calls
 * per 10 seconds. Only one Workable request is started every 1.1 seconds, leaving a small margin.
 * Sources left when the time budget expires keep their old last_polled_at and therefore remain at
 * the front of the next oldest-first database selection.
 */
export async function pollSourcesWithinBudget<TSource extends PollSource, TResult>(
  sources: readonly TSource[],
  poll: (source: TSource) => Promise<TResult>,
  options: PollQueueOptions = {},
) {
  const concurrency = options.concurrency ?? POLL_CONCURRENCY;
  const timeBudgetMs = options.timeBudgetMs ?? POLL_TIME_BUDGET_MS;
  const workableStartIntervalMs = options.workableStartIntervalMs ?? WORKABLE_START_INTERVAL_MS;
  const startReserveMs = options.startReserveMs
    ?? Math.min(POLL_START_RESERVE_MS, Math.max(0, timeBudgetMs / 4));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const ordinary = sources.filter((source) => source.ats_name !== 'workable');
  const workable = sources.filter((source) => source.ats_name === 'workable');
  const results: TResult[] = [];
  const startedAt = now();
  let nextWorkableStart = startedAt;

  while (ordinary.length > 0 || workable.length > 0) {
    const elapsed = now() - startedAt;
    if (elapsed >= timeBudgetMs - startReserveMs) break;

    const batch: TSource[] = [];
    if (workable.length > 0 && now() >= nextWorkableStart) {
      batch.push(workable.shift()!);
      nextWorkableStart = now() + workableStartIntervalMs;
    }
    batch.push(...ordinary.splice(0, Math.max(0, concurrency - batch.length)));

    if (batch.length === 0) {
      const remainingBudget = timeBudgetMs - (now() - startedAt);
      const wait = Math.min(nextWorkableStart - now(), remainingBudget);
      if (wait <= 0) break;
      await sleep(wait);
      continue;
    }

    results.push(...await Promise.all(batch.map(poll)));
  }

  return {
    results,
    attempted: results.length,
    deferred: sources.length - results.length,
    stopped_for_time_budget: results.length < sources.length,
    elapsed_ms: Math.max(0, now() - startedAt),
  };
}
