import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

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
//
// These guards were the load-bearing part of the fix, and they live in their own file rather than
// beside the retention route tests because the file that used to host them
// (resumeRetentionOneShot.test.ts) was deleted with the one-shot machinery itself. They are about
// vercel.json, not about any one route, so they outlive whichever handler is scheduled.
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
  // The `?run=` machinery that made a query string able to turn this endpoint into a permanent
  // silent no-op has since been deleted, so a stray parameter today would be ignored rather than
  // fatal. The guard stays because the incident's shape was a query string on precisely this
  // endpoint: the scheduled path must be the bare sweep, so that reintroducing any conditional
  // entry point has to fail here first.
  assert.equal(
    entry.path,
    '/internal/resume-retention-sweep',
    'the scheduled path must be the bare sweep, with no operation or filter in a query string',
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
    '/internal/application-submission-runner',
  ]) {
    assert.ok(paths.has(path), `${path} is no longer scheduled`);
  }
});

test('the Railway worker is the only recurring job monitor owner', () => {
  const paths = new Set(scheduledCrons().map((cron) => cron.path));
  assert.equal(paths.has('/internal/job-monitor'), false, 'Vercel must not run a second job monitor');

  const workflow = readFileSync('.github/workflows/job-monitor.yml', 'utf8');
  assert.match(workflow, /^\s+workflow_dispatch:\s*$/m, 'the diagnostic workflow must remain manually callable');
  assert.doesNotMatch(workflow, /^\s+schedule:/m, 'the diagnostic workflow must not schedule a second monitor');

  const packageJson = require('../../package.json') as { scripts?: Record<string, string> };
  assert.equal(packageJson.scripts?.['worker:job-monitor'], 'node scripts/run-job-monitor-worker.mjs');
});
