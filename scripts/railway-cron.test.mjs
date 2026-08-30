import assert from 'node:assert/strict';
import test from 'node:test';
import { runRailwayCron } from './railway-cron.mjs';

function response(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
  };
}

test('job monitor drains three 400-source segments under one timestamp', async () => {
  const calls = [];
  const replies = [
    response(500, { polling_complete: false, sources: 400, deferred_sources: 649 }),
    response(500, { polling_complete: false, sources: 400, deferred_sources: 249 }),
    response(200, { polling_complete: true, sources: 249, deferred_sources: 0 }),
  ];
  const logs = [];
  const result = await runRailwayCron({
    INTERNAL_API_BASE: 'http://api.railway.internal:3001',
    CRON_PATH: '/internal/job-monitor',
    INTERNAL_CRON_SECRET: 'cron-secret',
    CRON_DRAIN_UNTIL_COMPLETE: '1',
  }, {
    now: () => Date.parse('2026-08-30T16:00:00.000Z'),
    logger: { log: (line) => logs.push(line) },
    fetcher: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return replies.shift();
    },
  });

  assert.equal(result.segments, 3);
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((call) => call.url.searchParams.get('drain_started_at')),
    Array(3).fill('2026-08-30T16:00:00.000Z'),
  );
  assert.deepEqual(calls.map((call) => call.options.method), ['GET', 'GET', 'GET']);
  assert.deepEqual(
    calls.map((call) => call.options.headers.Authorization),
    Array(3).fill('Bearer cron-secret'),
  );
  assert.equal(logs.filter((line) => line.includes('segment ')).length, 3);
});

test('the default Railway drain clears five thousand sources under one timestamp', async () => {
  const calls = [];
  const segmentCount = 13;
  const replies = Array.from({ length: segmentCount }, (_, index) => {
    const finalSegment = index === segmentCount - 1;
    return response(finalSegment ? 200 : 500, {
      polling_complete: finalSegment,
      sources: finalSegment ? 200 : 400,
      deferred_sources: finalSegment ? 0 : 5_000 - ((index + 1) * 400),
    });
  });

  const result = await runRailwayCron({
    INTERNAL_API_BASE: 'http://api.railway.internal:3001',
    CRON_PATH: '/internal/job-monitor',
    INTERNAL_CRON_SECRET: 'cron-secret',
    CRON_DRAIN_UNTIL_COMPLETE: '1',
  }, {
    now: () => Date.parse('2026-08-30T16:00:00.000Z'),
    logger: { log: () => {} },
    fetcher: async (url) => {
      calls.push(new URL(url));
      return replies.shift();
    },
  });

  assert.equal(result.segments, segmentCount);
  assert.equal(calls.length, segmentCount);
  assert.deepEqual(
    calls.map((url) => url.searchParams.get('drain_started_at')),
    Array(segmentCount).fill('2026-08-30T16:00:00.000Z'),
  );
});

test('a completed drain still fails when the final inventory response is unhealthy', async () => {
  await assert.rejects(
    runRailwayCron({
      INTERNAL_API_BASE: 'http://api.railway.internal:3001',
      CRON_PATH: '/internal/job-monitor',
      INTERNAL_CRON_SECRET: 'cron-secret',
      CRON_DRAIN_UNTIL_COMPLETE: '1',
    }, {
      logger: { log: () => {} },
      fetcher: async () => response(500, {
        polling_complete: true,
        sources: 249,
        deferred_sources: 0,
        error: 'inventory below floor',
      }),
    }),
    /inventory below floor/,
  );
});
