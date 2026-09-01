import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POLL_SEGMENT_SIZE,
  POLL_SOURCE_LIMIT,
  pollSourcesWithinBudget,
  PROVIDER_MAX_IN_FLIGHT,
  PROVIDER_START_INTERVALS_MS,
  retryTransient,
  WORKABLE_START_INTERVAL_MS,
} from './jobPollScheduler';

test('polling is segmented at 400 sources before the catalog exceeds that boundary', () => {
  assert.equal(POLL_SEGMENT_SIZE, 400);
  assert.equal(POLL_SOURCE_LIMIT, POLL_SEGMENT_SIZE);
});

test('polls ordinary sources up to the configured concurrency', async () => {
  const sources = Array.from({ length: 10 }, (_, index) => ({ ats_name: 'greenhouse', index }));
  let active = 0;
  let maximumActive = 0;
  const outcome = await pollSourcesWithinBudget(sources, async (source) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return source.index;
  }, { concurrency: 4 });

  assert.equal(maximumActive, 4);
  assert.equal(outcome.attempted, 10);
  assert.equal(outcome.deferred, 0);
  assert.equal(outcome.stopped_for_time_budget, false);
});

test('replenishes an ordinary polling slot without waiting for the whole active pool', async () => {
  const sources = Array.from({ length: 3 }, (_, index) => ({ ats_name: 'greenhouse', index }));
  const starts: number[] = [];
  const completions = new Map<number, () => void>();
  const outcomePromise = pollSourcesWithinBudget(sources, async (source) => {
    starts.push(source.index);
    await new Promise<void>((resolve) => { completions.set(source.index, resolve); });
    return source.index;
  }, { concurrency: 2 });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 1]);
  completions.get(0)!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 1, 2], 'a free slot must be replenished while source 1 is still active');

  completions.get(1)!();
  completions.get(2)!();
  const outcome = await outcomePromise;
  assert.equal(outcome.attempted, 3);
});

test('Recruitee and Crelate are paced, and multi-request Crelate is also completion-gated', () => {
  /* Both proved their shared platform limit empirically on 2026-09-01: one full-concurrency drain
     left 71 Recruitee and 19 Crelate sources on HTTP 429, and the 19 Crelate boards had NEVER
     completed a poll - chronic starvation, not a burst. Behavioral minimums only: the roster may
     grow and a provider that documents a real limit gets its own interval. */
  for (const family of ['workable', 'recruitee', 'crelate']) {
    assert.ok((PROVIDER_START_INTERVALS_MS[family] ?? 0) > 0, `${family} must have paced starts`);
  }
  /* Start spacing bounds only a poll's FIRST request. A Crelate poll then makes hundreds of
     detail requests to the same shared host, so it must also run one poll at a time. */
  assert.equal(PROVIDER_MAX_IN_FLIGHT.crelate, 1);
});

test('a second Crelate poll waits for the first to COMPLETE, not merely for the start interval', async () => {
  let clock = 0;
  const starts: number[] = [];
  const completions: Array<() => void> = [];
  const sources = Array.from({ length: 2 }, (_, index) => ({ ats_name: 'crelate', index }));
  const outcomePromise = pollSourcesWithinBudget(sources, async () => {
    starts.push(clock);
    await new Promise<void>((resolve) => { completions.push(resolve); });
    return starts.length;
  }, {
    concurrency: 4,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0], 'the interval alone must not admit an overlapping Crelate poll');
  assert.ok(clock >= WORKABLE_START_INTERVAL_MS, 'the scheduler reached and passed the barrier');
  completions[0]!();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(starts.length, 2, 'completion releases the family lane');
  completions[1]!();
  const outcome = await outcomePromise;
  assert.equal(outcome.attempted, 2);
});

test('spaces Recruitee and Crelate starts within each family while families stay independent', async () => {
  let clock = 0;
  const starts: Array<[string, number]> = [];
  const sources = [
    { ats_name: 'recruitee', index: 0 },
    { ats_name: 'crelate', index: 1 },
    { ats_name: 'recruitee', index: 2 },
    { ats_name: 'crelate', index: 3 },
    { ats_name: 'greenhouse', index: 4 },
  ];
  const outcome = await pollSourcesWithinBudget(sources, async (source) => {
    starts.push([source.ats_name, clock]);
    return source.index;
  }, {
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });

  assert.equal(outcome.attempted, 5);
  const startTimes = (family: string) => starts
    .filter(([name]) => name === family)
    .map(([, at]) => at);
  /* One start per family per interval - and Recruitee's cooldown must not delay Crelate's first
     start, or the pacing would serialize the whole paced portion of a segment. */
  assert.deepEqual(startTimes('recruitee'), [0, WORKABLE_START_INTERVAL_MS]);
  assert.deepEqual(startTimes('crelate'), [0, WORKABLE_START_INTERVAL_MS]);
  assert.deepEqual(startTimes('greenhouse'), [0], 'ordinary sources are never paced');
});

test('spaces Workable request starts beyond the shared provider limit', async () => {
  let clock = 0;
  const starts: number[] = [];
  const sources = Array.from({ length: 3 }, (_, index) => ({ ats_name: 'workable', index }));
  const outcome = await pollSourcesWithinBudget(sources, async (source) => {
    starts.push(clock);
    return source.index;
  }, {
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });

  assert.deepEqual(starts, [0, WORKABLE_START_INTERVAL_MS, WORKABLE_START_INTERVAL_MS * 2]);
  assert.equal(outcome.deferred, 0);
});

test('spaces Workable starts across consecutive scheduler invocations', async () => {
  let clock = 10_000;
  const starts: number[] = [];
  const now = () => clock;
  const sleep = async (milliseconds: number) => { clock += milliseconds; };
  const poll = async () => {
    starts.push(clock);
    return starts.length;
  };

  await pollSourcesWithinBudget([{ ats_name: 'workable' }], poll, { now, sleep });
  await pollSourcesWithinBudget([{ ats_name: 'workable' }], poll, { now, sleep });

  assert.deepEqual(starts, [10_000, 10_000 + WORKABLE_START_INTERVAL_MS]);
});

test('spaces concurrent Workable scheduler invocations that share a clock', async () => {
  let clock = 20_000;
  const starts: number[] = [];
  const now = () => clock;
  const sleep = async (milliseconds: number) => { clock += milliseconds; };
  const poll = async () => {
    starts.push(clock);
    return starts.length;
  };

  const first = pollSourcesWithinBudget([{ ats_name: 'workable' }], poll, { now, sleep });
  const second = pollSourcesWithinBudget([{ ats_name: 'workable' }], poll, { now, sleep });
  await Promise.all([first, second]);

  assert.deepEqual(starts, [20_000, 20_000 + WORKABLE_START_INTERVAL_MS]);
});

test('holds the final Workable cooldown before propagating a poll rejection', async () => {
  let clock = 30_000;
  const waits: number[] = [];

  await assert.rejects(
    pollSourcesWithinBudget([{ ats_name: 'workable' }], async () => {
      throw new Error('workable failed');
    }, {
      now: () => clock,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        clock += milliseconds;
      },
    }),
    /workable failed/,
  );

  assert.deepEqual(waits, [WORKABLE_START_INTERVAL_MS]);
  assert.equal(clock, 30_000 + WORKABLE_START_INTERVAL_MS);
});

test('starts paced Workable polls without waiting for an earlier Workable request to finish', async () => {
  let clock = 0;
  const starts: number[] = [];
  const completions: Array<() => void> = [];
  const sources = Array.from({ length: 2 }, (_, index) => ({ ats_name: 'workable', index }));
  const outcomePromise = pollSourcesWithinBudget(sources, async () => {
    starts.push(clock);
    await new Promise<void>((resolve) => { completions.push(resolve); });
    return starts.length;
  }, {
    concurrency: 2,
    now: () => clock,
    sleep: async (milliseconds) => { clock += milliseconds; },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, WORKABLE_START_INTERVAL_MS]);
  completions.forEach((resolve) => resolve());
  const outcome = await outcomePromise;
  assert.equal(outcome.attempted, 2);
});

test('waits for every started sibling before propagating a poll rejection', async () => {
  let settleSibling: (() => void) | undefined;
  let rejected = false;
  let outcomeError: unknown;
  const outcome = pollSourcesWithinBudget([
    { ats_name: 'greenhouse', index: 0 },
    { ats_name: 'lever', index: 1 },
  ], async (source) => {
    if (source.index === 0) throw new Error('source failed');
    await new Promise<void>((resolve) => { settleSibling = resolve; });
    return source.index;
  }, { concurrency: 2 }).catch((error) => {
    rejected = true;
    outcomeError = error;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(rejected, false, 'the scheduler must retain the caller lock while a sibling is active');
  assert.ok(settleSibling);
  settleSibling();
  await outcome;
  assert.equal(rejected, true);
  assert.match(String(outcomeError), /source failed/);
});

test('leaves unattempted sources for the next run at the time budget', async () => {
  let clock = 0;
  const sources = Array.from({ length: 5 }, (_, index) => ({ ats_name: 'greenhouse', index }));
  const outcome = await pollSourcesWithinBudget(sources, async (source) => {
    clock += 60;
    return source.index;
  }, {
    concurrency: 2,
    timeBudgetMs: 100,
    now: () => clock,
  });

  assert.equal(outcome.attempted, 2);
  assert.equal(outcome.deferred, 3);
  assert.equal(outcome.stopped_for_time_budget, true);
});

test('five time-bounded passes can drain 800 Workable sources safely', async () => {
  let remaining = Array.from({ length: 800 }, (_, index) => ({ ats_name: 'workable', index }));
  let passes = 0;
  while (remaining.length > 0 && passes < 5) {
    let clock = 0;
    const outcome = await pollSourcesWithinBudget(remaining, async (source) => source.index, {
      timeBudgetMs: 210_000,
      startReserveMs: 30_000,
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds; },
    });
    remaining = remaining.slice(outcome.attempted);
    passes += 1;
  }
  assert.equal(remaining.length, 0);
  assert.equal(passes, 5);
});

test('transient verification retries and still fails after the final attempt', async () => {
  let attempts = 0;
  const waits: number[] = [];
  const value = await retryTransient(async () => {
    attempts += 1;
    if (attempts < 3) throw new Error('temporary timeout');
    return 'ok';
  }, { attempts: 3, delayMs: 10, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);

  attempts = 0;
  await assert.rejects(
    retryTransient(async () => {
      attempts += 1;
      throw new Error('still dead');
    }, { attempts: 2, delayMs: 0, sleep: async () => {} }),
    /still dead/,
  );
  assert.equal(attempts, 2, 'a persistent board remains a failing gate');
});
