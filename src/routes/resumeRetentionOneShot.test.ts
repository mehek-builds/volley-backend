import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import {
  LEGACY_ORIGINAL_CLEANUP_OPERATION_ID,
  RETENTION_OPERATION_COUNTER_KEY,
  RETENTION_OPERATION_COUNTER_KIND,
  type ResumeRetentionDependencies,
  resumeRetentionRoutes,
} from './resumeRetention';

const secret = 'retention-one-shot-test-secret';
const previousInternalSecret = process.env.INTERNAL_CRON_SECRET;
const previousCronSecret = process.env.CRON_SECRET;
const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;

before(() => {
  process.env.INTERNAL_CRON_SECRET = secret;
  delete process.env.CRON_SECRET;
  process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';
});

after(() => {
  if (previousInternalSecret === undefined) delete process.env.INTERNAL_CRON_SECRET;
  else process.env.INTERNAL_CRON_SECRET = previousInternalSecret;
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
  if (previousBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
});

function dependencyHarness() {
  let claimed = false;
  const calls = {
    claim: 0,
    sweep: 0,
    clear: 0,
    tuple: null as [string, string, string, number] | null,
  };
  const dependencies: ResumeRetentionDependencies = {
    claimCounterSlot: async (key, period, kind, limit) => {
      calls.claim += 1;
      calls.tuple = [key, period, kind, limit];
      if (claimed) return null;
      claimed = true;
      return 1;
    },
    sweepExpiredResumeBlobs: async () => {
      calls.sweep += 1;
      return { scanned: 4, deleted: 2 };
    },
    clearLegacyPointers: async () => {
      calls.clear += 1;
    },
  };
  return { calls, dependencies };
}

async function buildTestApp(dependencies: ResumeRetentionDependencies) {
  const app = Fastify({ logger: false });
  await app.register(resumeRetentionRoutes, { dependencies });
  await app.ready();
  return app;
}

const operationUrl =
  `/internal/resume-retention-sweep?run=${LEGACY_ORIGINAL_CLEANUP_OPERATION_ID}`;
const authorizedHeaders = { 'x-internal-secret': secret };

test('two concurrent one-shot requests allow exactly one sweep and pointer clear', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: operationUrl, headers: authorizedHeaders }),
      app.inject({ method: 'GET', url: operationUrl, headers: authorizedHeaders }),
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    assert.equal(responses.filter((response) => response.json().already_processed === true).length, 1);
    assert.equal(harness.calls.sweep, 1);
    assert.equal(harness.calls.clear, 1);
    assert.deepEqual(harness.calls.tuple, [
      RETENTION_OPERATION_COUNTER_KEY,
      LEGACY_ORIGINAL_CLEANUP_OPERATION_ID,
      RETENTION_OPERATION_COUNTER_KIND,
      1,
    ]);
  } finally {
    await app.close();
  }
});

test('a duplicate completed operation is a 200 no-op', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const first = await app.inject({ method: 'GET', url: operationUrl, headers: authorizedHeaders });
    const duplicate = await app.inject({ method: 'GET', url: operationUrl, headers: authorizedHeaders });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(duplicate.json(), { already_processed: true });
    assert.equal(harness.calls.sweep, 1);
    assert.equal(harness.calls.clear, 1);
  } finally {
    await app.close();
  }
});

test('an unknown nonempty operation is rejected before claim or mutation', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/resume-retention-sweep?run=not-approved',
      headers: authorizedHeaders,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(harness.calls.claim, 0);
    assert.equal(harness.calls.sweep, 0);
    assert.equal(harness.calls.clear, 0);
  } finally {
    await app.close();
  }
});

test('the approved operation still requires cron authentication', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const response = await app.inject({ method: 'GET', url: operationUrl });
    assert.equal(response.statusCode, 401);
    assert.equal(harness.calls.claim, 0);
    assert.equal(harness.calls.sweep, 0);
    assert.equal(harness.calls.clear, 0);
  } finally {
    await app.close();
  }
});

test('the normal daily path remains unclaimed and performs the same sweep', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/resume-retention-sweep',
      headers: authorizedHeaders,
    });
    assert.equal(response.statusCode, 200);
    // Both windows are reported, because a sweep that silently stopped covering one category is
    // exactly the failure this route exists to make visible. deleted_by_category and unclassified
    // are absent here only because this harness's sweep double does not compute them.
    assert.deepEqual(response.json(), {
      scanned: 4,
      deleted: 2,
      retention_days: 30,
      preview_retention_days: 7,
    });
    assert.equal(harness.calls.claim, 0);
    assert.equal(harness.calls.sweep, 1);
    assert.equal(harness.calls.clear, 1);
  } finally {
    await app.close();
  }
});

// The privacy page states the 30-day window as fact, and vercel.json is the only place that
// decides whether the sweep ever runs. Between 2026-08-03 and 2026-08-11 it did not: the daily
// entry was narrowed to `?run=<one-shot>` on `15 12 3 8 *` to perform the approved legacy-original
// cleanup, and the revert never came. Both halves were independently fatal - the schedule fired
// once a year, and the one-shot slot was spent on the first run, so every later call short-circuits
// to `{ already_processed: true }` at 200 without sweeping. Measured on 2026-08-11: 11 generated
// files past the promised window, the oldest 7.9 days overdue.
//
// The previous version of this test asserted that broken state via deepEqual, so it locked the bug
// in rather than catching it. These assertions are written against the PROPERTY the promise needs -
// runs every day, sweeps unconditionally - so a future temporary narrowing has to delete a test
// that says why, instead of quietly updating a snapshot.
function scheduledCrons(): Array<{ path: string; schedule: string }> {
  return (require('../../vercel.json') as { crons: Array<{ path: string; schedule: string }> }).crons;
}

// minute hour day-of-month month day-of-week. Pinning day-of-month or month (as `15 12 3 8 *` did)
// turns a daily promise into an annual one. Vercel Hobby also rejects sub-daily schedules at DEPLOY
// time, and that failure blocks every production deploy of this repo, not just the offending entry,
// so minute and hour must stay literal rather than `*` or a `*/n` step.
function assertRunsEveryDay(entry: { path: string; schedule: string }) {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = entry.schedule.split(' ');
  assert.deepEqual(
    [dayOfMonth, month, dayOfWeek],
    ['*', '*', '*'],
    `${entry.path} schedule '${entry.schedule}' does not run every day`,
  );
  assert.match(minute, /^\d+$/, `${entry.path} minute must be a fixed value, not a wildcard or step`);
  assert.match(hour, /^\d+$/, `${entry.path} hour must be fixed: Hobby rejects sub-daily crons at deploy time`);
}

test('the retention sweep is scheduled daily and unconditional', () => {
  const retention = scheduledCrons().filter((cron) =>
    cron.path.startsWith('/internal/resume-retention-sweep'));
  assert.equal(retention.length, 1, 'exactly one retention cron entry must exist');

  const [entry] = retention;
  // `?run=<the approved operation id>` claims a usage_counters slot that is already spent, so a
  // scheduled path carrying it returns 200 `{ already_processed: true }` forever without sweeping.
  // Any other nonempty value is a 400 and never sweeps either. Both are reasons the scheduled path
  // must carry no query string at all.
  assert.equal(
    entry.path,
    '/internal/resume-retention-sweep',
    'the scheduled path must carry no ?run= operation, or the sweep no-ops once its slot is claimed',
  );
  assertRunsEveryDay(entry);
});

// The Hobby daily-only constraint binds every entry, and a single sub-daily schedule anywhere in
// this list blocks production deploys for the whole repo. Asserted as a property over all crons
// rather than as a snapshot, so adding a legitimate new one (captchaStalls.ts notes an unscheduled
// /internal/captcha-stall-nudge) fails on a named rule if it is wrong, and passes silently if right.
test('every scheduled cron runs daily, as Hobby requires at deploy time', () => {
  const crons = scheduledCrons();
  assert.ok(crons.length > 0, 'vercel.json must schedule at least the retention sweep');
  for (const entry of crons) assertRunsEveryDay(entry);
});

test('the other scheduled jobs are still scheduled', () => {
  const paths = new Set(scheduledCrons().map((cron) => cron.path));
  for (const path of [
    '/internal/adapter-health-check',
    '/internal/job-monitor',
    '/internal/application-submission-runner',
  ]) {
    assert.ok(paths.has(path), `${path} is no longer scheduled`);
  }
});
