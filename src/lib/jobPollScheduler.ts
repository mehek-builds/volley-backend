/**
 * One monitor invocation selects at most one segment.
 *
 * The catalog is intentionally segmented at 400 sources before it grows past that boundary. The
 * scheduler drains subsequent oldest-first segments under one timestamp. Keeping this separate
 * from the time budget makes growth predictable: adding source 401 changes the response to
 * polling_complete=false instead of silently expanding one invocation.
 */
export const POLL_SEGMENT_SIZE = 400;
/** Deprecated response-field alias. Its value remains the actual per-invocation selection cap. */
export const POLL_SOURCE_LIMIT = POLL_SEGMENT_SIZE;
export const POLL_CONCURRENCY = 12;
/**
 * Railway cron services have no platform execution cutoff, so this is an application-owned bound.
 * Nine minutes is long enough to drain a 400-source segment, including Workable's shared rate
 * limit, while leaving five minutes for active polls, metrics, and a clean response within the
 * fourteen-minute response target. The client adds its own timeout margin beyond that target.
 */
export const POLL_TIME_BUDGET_MS = 9 * 60_000;
export const POLL_START_RESERVE_MS = 60_000;
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
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? POLL_CONCURRENCY));
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
  const resultSlots: Array<{ settled: boolean; value?: TResult }> = [];
  const active = new Set<Promise<void>>();
  const allStarted: Promise<void>[] = [];
  const startedAt = now();
  const startDeadline = startedAt + Math.max(0, timeBudgetMs - startReserveMs);
  let nextWorkableStart = startedAt;
  const noError = Symbol('no poll error');
  let firstError: unknown = noError;

  const startPoll = (source: TSource) => {
    const slot = { settled: false } as { settled: boolean; value?: TResult };
    resultSlots.push(slot);
    let operation: Promise<TResult>;
    try {
      operation = Promise.resolve(poll(source));
    } catch (error) {
      operation = Promise.reject(error);
    }
    let task: Promise<void>;
    task = operation.then(
      (value) => {
        slot.value = value;
        slot.settled = true;
      },
      (error) => {
        if (firstError === noError) firstError = error;
      },
    ).finally(() => {
      active.delete(task);
    });
    active.add(task);
    allStarted.push(task);
  };

  while ((ordinary.length > 0 || workable.length > 0) && firstError === noError) {
    while (active.size < concurrency && now() < startDeadline && firstError === noError) {
      const currentTime = now();
      if (workable.length > 0 && currentTime >= nextWorkableStart) {
        const source = workable.shift()!;
        nextWorkableStart = currentTime + workableStartIntervalMs;
        startPoll(source);
        continue;
      }
      const source = ordinary.shift();
      if (!source) break;
      startPoll(source);
    }

    if (firstError !== noError || now() >= startDeadline) break;
    if (ordinary.length === 0 && workable.length === 0) break;

    if (active.size >= concurrency) {
      await Promise.race(active);
      continue;
    }

    if (ordinary.length === 0 && workable.length > 0) {
      const wait = Math.min(nextWorkableStart - now(), startDeadline - now());
      if (wait <= 0) continue;
      await sleep(wait);
      continue;
    }

    if (active.size > 0) await Promise.race(active);
  }

  // A caller can release its distributed lock as soon as this function settles. Wait for every
  // started request, including siblings of a rejected request, before returning or rethrowing.
  await Promise.allSettled(allStarted);
  if (firstError !== noError) throw firstError;

  const results = resultSlots.map((slot) => {
    if (!slot.settled) throw new Error('Poll result did not settle');
    return slot.value as TResult;
  });

  return {
    results,
    attempted: resultSlots.length,
    deferred: sources.length - resultSlots.length,
    stopped_for_time_budget: resultSlots.length < sources.length,
    elapsed_ms: Math.max(0, now() - startedAt),
  };
}
