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

/**
 * PROVIDERS WHOSE PUBLIC API SHARES ONE PLATFORM-WIDE LIMIT ACROSS EVERY TENANT.
 *
 * Workable documents its limit (10 calls per 10 seconds). Recruitee and Crelate do not document
 * one, but both serve every tenant from shared platform infrastructure and both proved the limit
 * empirically on 2026-09-01: one 400-source drain at full concurrency left 71 Recruitee and 19
 * Crelate sources on HTTP 429, and the 19 Crelate boards had NEVER completed a poll since crelate
 * support shipped - a chronic starvation, not a transient burst. All three reuse Workable's
 * measured interval; a provider that later documents a real limit gets its own entry.
 */
export const PROVIDER_START_INTERVALS_MS: Readonly<Record<string, number>> = {
  workable: WORKABLE_START_INTERVAL_MS,
  recruitee: WORKABLE_START_INTERVAL_MS,
  crelate: WORKABLE_START_INTERVAL_MS,
};

/**
 * Start spacing bounds only the FIRST request of a poll. That is the whole poll for Workable and
 * Recruitee (one list request each), but a Crelate poll makes two metadata requests and then up to
 * 600 per-posting detail requests at 8-way concurrency against the same shared host, so spaced
 * starts alone still overlap into exactly the burst that 429d every Crelate source. Multi-request
 * paced families therefore also cap how many of their polls run at once.
 */
export const PROVIDER_MAX_IN_FLIGHT: Readonly<Record<string, number>> = {
  crelate: 1,
};

/**
 * A paced provider applies its limit across requests, not across one scheduler invocation. Key the
 * process-wide barriers by the clock function so production calls share Date.now while tests can
 * use isolated deterministic clocks. Every start re-reads this map, which also coordinates
 * overlapping invocations in the same worker process. One barrier per provider family: Workable's
 * cooldown must not delay a Recruitee start.
 */
const nextPacedStartByClock = new WeakMap<() => number, Map<string, number>>();

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
 * The paced providers (see PROVIDER_START_INTERVALS_MS) are different: every tenant's requests
 * share one platform-wide public API limit, so only one request per family is started each
 * interval, with each family pacing independently. Sources left when the time budget expires keep
 * their old last_polled_at and therefore remain at the front of the next oldest-first selection.
 */
export async function pollSourcesWithinBudget<TSource extends PollSource, TResult>(
  sources: readonly TSource[],
  poll: (source: TSource) => Promise<TResult>,
  options: PollQueueOptions = {},
) {
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? POLL_CONCURRENCY));
  const timeBudgetMs = options.timeBudgetMs ?? POLL_TIME_BUDGET_MS;
  const providerIntervals: Record<string, number> = {
    ...PROVIDER_START_INTERVALS_MS,
    ...(options.workableStartIntervalMs !== undefined
      ? { workable: options.workableStartIntervalMs }
      : {}),
  };
  const startReserveMs = options.startReserveMs
    ?? Math.min(POLL_START_RESERVE_MS, Math.max(0, timeBudgetMs / 4));
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const ordinary = sources.filter((source) => providerIntervals[source.ats_name] === undefined);
  const paced = new Map<string, TSource[]>();
  for (const source of sources) {
    if (providerIntervals[source.ats_name] === undefined) continue;
    const queue = paced.get(source.ats_name);
    if (queue) queue.push(source);
    else paced.set(source.ats_name, [source]);
  }
  const pacedRemaining = () => {
    for (const queue of paced.values()) if (queue.length > 0) return true;
    return false;
  };
  /* Resolved once: the clock is fixed for the whole invocation, and sharing the Map is exactly
     what coordinates overlapping invocations on the same clock. */
  const barriers = nextPacedStartByClock.get(now) ?? new Map<string, number>();
  nextPacedStartByClock.set(now, barriers);
  const inFlightByFamily = new Map<string, number>();
  const startedPacedFamilies = new Set<string>();
  const resultSlots: Array<{ settled: boolean; value?: TResult }> = [];
  const active = new Set<Promise<void>>();
  const allStarted: Promise<void>[] = [];
  const startedAt = now();
  const startDeadline = startedAt + Math.max(0, timeBudgetMs - startReserveMs);
  const noError = Symbol('no poll error');
  let firstError: unknown = noError;

  const startPoll = (source: TSource) => {
    const slot = { settled: false } as { settled: boolean; value?: TResult };
    resultSlots.push(slot);
    const family = source.ats_name;
    const paceThisFamily = providerIntervals[family] !== undefined;
    if (paceThisFamily) {
      startedPacedFamilies.add(family);
      inFlightByFamily.set(family, (inFlightByFamily.get(family) ?? 0) + 1);
    }
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
      if (paceThisFamily) inFlightByFamily.set(family, (inFlightByFamily.get(family) ?? 1) - 1);
    });
    active.add(task);
    allStarted.push(task);
  };

  const waitForOwnPacedCooldowns = async () => {
    /* SNAPSHOT, then wait. Only the families THIS invocation started need their final cooldown
       held under the caller's lock, and the target is captured once - re-reading the live barrier
       would let an overlapping invocation string this one along for its whole paced drain. */
    let holdUntil = -Infinity;
    for (const family of startedPacedFamilies) {
      holdUntil = Math.max(holdUntil, barriers.get(family) ?? -Infinity);
    }
    while (now() < holdUntil) await sleep(holdUntil - now());
  };

  while ((ordinary.length > 0 || pacedRemaining()) && firstError === noError) {
    while (active.size < concurrency && now() < startDeadline && firstError === noError) {
      const currentTime = now();
      let startedPaced = false;
      for (const [family, queue] of paced) {
        if (queue.length === 0) continue;
        if (currentTime < (barriers.get(family) ?? currentTime)) continue;
        if ((inFlightByFamily.get(family) ?? 0) >= (PROVIDER_MAX_IN_FLIGHT[family] ?? Infinity)) {
          continue;
        }
        barriers.set(family, currentTime + providerIntervals[family]);
        startPoll(queue.shift()!);
        startedPaced = true;
        break;
      }
      if (startedPaced) continue;
      const source = ordinary.shift();
      if (!source) break;
      startPoll(source);
    }

    if (firstError !== noError || now() >= startDeadline) break;
    if (ordinary.length === 0 && !pacedRemaining()) break;

    if (active.size >= concurrency) {
      await Promise.race(active);
      continue;
    }

    if (ordinary.length === 0 && pacedRemaining()) {
      let soonestStart = Infinity;
      for (const [family, queue] of paced) {
        if (queue.length === 0) continue;
        soonestStart = Math.min(soonestStart, barriers.get(family) ?? now());
      }
      const wait = Math.min(soonestStart - now(), startDeadline - now());
      if (wait <= 0) {
        /* Barrier already passed, so the family is blocked by its in-flight cap, not by time.
           Sleeping cannot release it; only a completing poll can. */
        if (active.size > 0) await Promise.race(active);
        continue;
      }
      await sleep(wait);
      continue;
    }

    if (active.size > 0) await Promise.race(active);
  }

  // A caller can release its distributed lock as soon as this function settles. Wait for every
  // started request, including siblings of a rejected request, before returning or rethrowing.
  await Promise.allSettled(allStarted);
  // Hold that lock through the final cooldown of every family this invocation started. This keeps
  // the boundary safe even if the next invocation lands in a fresh process that cannot see the
  // in-memory barriers.
  await waitForOwnPacedCooldowns();
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
