import assert from 'node:assert/strict';
import test from 'node:test';
import {
  POLL_SEGMENT_SIZE,
  POLL_SOURCE_LIMIT,
  pollSourcesWithinBudget,
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
