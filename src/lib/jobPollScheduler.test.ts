import assert from 'node:assert/strict';
import test from 'node:test';
import { pollSourcesWithinBudget, WORKABLE_START_INTERVAL_MS } from './jobPollScheduler';

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
