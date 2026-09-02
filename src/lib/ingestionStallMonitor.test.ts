import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IngestionStallMonitor,
  millisecondsFromEnv,
  DEFAULT_MONITOR_INTERVAL_MS,
  type BoardFreshness,
} from './ingestionStallMonitor';

const MINUTES = 60_000;
const SILENT = { log: () => {}, error: () => {} };
/* The real one: last_seen_at froze here while the worker sat in a logo retry loop reporting
   SUCCESS. Read at 18:00 that is 431 minutes of silence. */
const FROZEN_AT = '2026-09-01T10:48:37.000Z';

/** A clock the test drives, because every property here is about what happened between reads. */
function harness(options: {
  reads: Array<BoardFreshness | Error>;
  intervalMs?: number;
  retentionMs?: number;
  thresholdMs?: number;
  start?: string;
}) {
  let nowMs = new Date(options.start ?? '2026-09-01T10:00:00.000Z').getTime();
  let index = 0;
  const monitor = new IngestionStallMonitor({
    read: async () => {
      const next = options.reads[Math.min(index, options.reads.length - 1)];
      index += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    thresholdMs: options.thresholdMs ?? 180 * MINUTES,
    intervalMs: options.intervalMs ?? 10 * MINUTES,
    retentionMs: options.retentionMs ?? 24 * 60 * MINUTES,
    logger: SILENT,
    now: () => new Date(nowMs),
    setTimer: () => 'timer',
    clearTimer: () => {},
  });
  return { monitor, advance: (ms: number) => { nowMs += ms; } };
}

/** The board's newest last_seen_at, as an absolute instant - staleness is always read against the
    harness clock, which the test advances on purpose. */
function board(newestSeenAt: string): BoardFreshness {
  return { newest_seen_at: new Date(newestSeenAt), active_jobs: 1000 };
}

test('a monitor that was never started reads as not running, never as quiet', () => {
  const { monitor } = harness({ reads: [board('2026-09-01T09:50:00.000Z')] });
  assert.equal(monitor.snapshot().monitor_running, false);
  monitor.start();
  assert.equal(monitor.snapshot().monitor_running, true);
  monitor.stop();
  assert.equal(monitor.snapshot().monitor_running, false);
});

test('the 2026-09-01 stall is recorded, and survives the board recovering', async () => {
  /* THE WHOLE POINT OF REMEMBERING. Ingestion froze at 10:48 and ran unfed for seven and a half
     hours. Under GitHub's measured 3.5-to-5-hour delivery a reader can easily arrive only after
     the board is fresh again - and an instantaneous check would tell that reader everything is
     fine. The observation record is what makes the late reader still correct. */
  const h = harness({ reads: [board(FROZEN_AT)], start: '2026-09-01T18:00:00.000Z' });
  h.monitor.start();
  await h.monitor.check();

  const stalled = h.monitor.snapshot();
  assert.equal(stalled.currently_stalled, true);
  assert.equal(stalled.stall_observations, 1);
  assert.equal(stalled.worst_staleness_minutes, 431);

  // The worker recovers and the board goes fresh again.
  const recovered = harness({
    reads: [board(FROZEN_AT), board('2026-09-01T18:25:00.000Z')],
    start: '2026-09-01T18:00:00.000Z',
  });
  recovered.monitor.start();
  await recovered.monitor.check();
  recovered.advance(30 * MINUTES);
  await recovered.monitor.check();

  const after = recovered.monitor.snapshot();
  assert.equal(after.currently_stalled, false, 'the board really is fresh now');
  assert.equal(after.stall_observations, 1, 'but the stall that happened is still on the record');
  assert.equal(after.worst_staleness_minutes, 431);
  assert.ok(after.last_healthy_at, 'and a healthy sample was proven');
});

test('an observation expires on its own once the window passes', async () => {
  /* An alarm that stays red until a human acknowledges it is an alarm everyone learns to ignore,
     which is precisely how job-monitor.yml failed silently for days in August. */
  const h = harness({
    reads: [board(FROZEN_AT)],
    retentionMs: 12 * 60 * MINUTES,
    start: '2026-09-01T18:00:00.000Z',
  });
  h.monitor.start();
  await h.monitor.check();
  assert.equal(h.monitor.snapshot().stall_observations, 1);

  h.advance(11 * 60 * MINUTES);
  assert.equal(h.monitor.snapshot().stall_observations, 1, 'still inside the window');

  h.advance(2 * 60 * MINUTES);
  const expired = h.monitor.snapshot();
  assert.equal(expired.stall_observations, 0);
  assert.equal(expired.worst_staleness_minutes, null);
});

test('a read that throws is unknown, never healthy', async () => {
  /* The failure this whole mechanism exists for was silent because every signal defaulted to
     "fine" without evidence. An unreadable database is not evidence of a fed board, so it must
     not refresh last_healthy_at and must not be laundered into a stall either. */
  const h = harness({
    reads: [board('2026-09-01T09:55:00.000Z'), new Error('connection terminated')],
    start: '2026-09-01T10:00:00.000Z',
  });
  h.monitor.start();
  await h.monitor.check();
  const healthy = h.monitor.snapshot();
  assert.ok(healthy.last_healthy_at);

  h.advance(10 * MINUTES);
  await h.monitor.check();
  const failed = h.monitor.snapshot();
  assert.equal(failed.read_failures, 1);
  assert.equal(failed.stall_observations, 0, 'a database blip is not a stalled board');
  assert.equal(failed.last_healthy_at, healthy.last_healthy_at, 'and it proves nothing fresh');
  assert.equal(failed.checks, 1, 'a failed read is not a completed check');
  assert.equal(failed.last_observation_at, healthy.last_observation_at, 'nor a new observation');
  assert.equal(failed.minutes_since_last_observation, 10, 'the record is now visibly 10 minutes old');
  assert.notEqual(failed.last_attempt_at, failed.last_observation_at, 'but the attempt is recorded');
});

test('a monitor that has never completed a check is visibly empty, not visibly fine', async () => {
  /* THE FAIL-OPEN THIS CLOSES. stall_observations is 0 both when nothing went wrong and when
     nobody ever looked. Those must not be indistinguishable, or a monitor whose every read fails
     reports the same zero as a healthy board - which is the 2026-09-01 bug wearing a new hat.
     A reader decides with minutes_since_last_observation; it is null only when nothing was ever
     established, and minutes_since_started says whether that is alarming or merely early. */
  const h = harness({ reads: [new Error('timeout')] });
  h.monitor.start();
  await h.monitor.check();

  const empty = h.monitor.snapshot();
  assert.equal(empty.stall_observations, 0, 'the same zero a healthy board reports');
  assert.equal(empty.checks, 0);
  assert.equal(empty.read_failures, 1);
  assert.equal(empty.minutes_since_last_observation, null, 'but nothing was ever observed');
  assert.equal(empty.minutes_since_started, 0, 'and this is still within the boot grace');

  h.advance(60 * MINUTES);
  await h.monitor.check();
  const stillEmpty = h.monitor.snapshot();
  assert.equal(stillEmpty.minutes_since_last_observation, null);
  assert.equal(stillEmpty.minutes_since_started, 60, 'well past any grace: this reads as broken');
});

test('the retention window outlasts the worst measured GitHub delivery gap', async () => {
  /* An observation that expires before the run that would have reported it is an observation that
     was never taken. Measured worst gaps across this repository's last 100 scheduled runs are 808
     and 746 minutes, so a 12-hour window was too short. */
  const h = harness({ reads: [board(FROZEN_AT)], start: '2026-09-01T18:00:00.000Z' });
  h.monitor.start();
  await h.monitor.check();
  assert.equal(h.monitor.snapshot().stall_observations, 1);

  h.advance(808 * MINUTES);
  assert.equal(
    h.monitor.snapshot().stall_observations,
    1,
    'still reportable after the worst delivery gap ever measured here',
  );
});

test('a board that has never been polled is stalled', async () => {
  const h = harness({ reads: [{ newest_seen_at: null, active_jobs: 0 }] });
  h.monitor.start();
  await h.monitor.check();
  const snap = h.monitor.snapshot();
  assert.equal(snap.currently_stalled, true);
  assert.equal(snap.stall_observations, 1);
});

test('check never throws, so a timer tick can never kill the monitor', async () => {
  const h = harness({ reads: [new Error('boom')] });
  h.monitor.start();
  await assert.doesNotReject(() => h.monitor.check());
  assert.equal(h.monitor.running, true);
});

test('an overrunning read does not stack up behind itself', async () => {
  let started = 0;
  /* Typed through a holder so TypeScript does not narrow the assignment inside the promise
     executor away to `never` at the call site below. */
  const gate: { release: (() => void) | null } = { release: null };
  const monitor = new IngestionStallMonitor({
    read: async () => {
      started += 1;
      await new Promise<void>((resolve) => { gate.release = resolve; });
      return board(new Date().toISOString());
    },
    logger: SILENT,
    setTimer: () => 'timer',
    clearTimer: () => {},
  });
  const first = monitor.check();
  assert.equal(await monitor.check(), null, 'the second tick is skipped, not queued');
  assert.equal(started, 1);
  gate.release?.();
  await first;
});

test('a misconfigured interval falls back instead of refusing to run', () => {
  for (const bad of [undefined, '', 'ten minutes', '0', '-5', 'NaN']) {
    assert.equal(millisecondsFromEnv(bad, DEFAULT_MONITOR_INTERVAL_MS), DEFAULT_MONITOR_INTERVAL_MS, JSON.stringify(bad));
  }
  assert.equal(millisecondsFromEnv('300000', DEFAULT_MONITOR_INTERVAL_MS), 300_000);
  assert.equal(millisecondsFromEnv('1', DEFAULT_MONITOR_INTERVAL_MS), 60_000, 'floored, never a hot loop');
});

test('the worst staleness seen is kept, not the most recent', async () => {
  /* A reader arriving hours late needs the depth of the hole, not its edge. */
  const h = harness({
    // Read at 18:00 -> 200 minutes stale; at 18:10 -> 431; at 18:20 -> 190 once the drain lands.
    reads: [board('2026-09-01T14:40:00.000Z'), board('2026-09-01T10:59:00.000Z'), board('2026-09-01T15:10:00.000Z')],
    start: '2026-09-01T18:00:00.000Z',
  });
  h.monitor.start();
  await h.monitor.check();
  h.advance(10 * MINUTES);
  await h.monitor.check();
  h.advance(10 * MINUTES);
  await h.monitor.check();
  const snap = h.monitor.snapshot();
  assert.equal(snap.stall_observations, 3);
  assert.equal(snap.worst_staleness_minutes, 431);
});
