import test from 'node:test';
import assert from 'node:assert/strict';
import { ingestionHealth } from './ingestionHealth';

const NOW = new Date('2026-09-01T18:00:00.000Z');
const MINUTES = 60_000;

test('a board polled inside the threshold is healthy', () => {
  const seen = new Date(NOW.getTime() - 90 * MINUTES);
  const health = ingestionHealth(seen, 180 * MINUTES, NOW);
  assert.equal(health.stalled, false);
  assert.equal(health.staleness_minutes, 90);
});

test('the 2026-09-01 stall would have fired this alarm', () => {
  /* The real numbers: last_seen_at froze at 10:48:37Z while the worker sat in a logo retry loop
     reporting SUCCESS. By 18:00 the board had been unfed for seven and a half hours. */
  const health = ingestionHealth('2026-09-01T10:48:37.010Z', 180 * MINUTES, NOW);
  assert.equal(health.stalled, true);
  assert.equal(health.staleness_minutes, 431);
});

test('the alarm stays silent through an ordinary late cycle', () => {
  /* A drain is bounded by the two-hour cycle, and a late one still writes last_seen_at across the
     catalogue when it lands. Anything under the threshold must not page anyone, or the alarm gets
     ignored and stops being an alarm - which is what happened to job-monitor.yml in August. */
  for (const minutes of [1, 60, 120, 179, 180]) {
    const seen = new Date(NOW.getTime() - minutes * MINUTES);
    assert.equal(ingestionHealth(seen, 180 * MINUTES, NOW).stalled, false, `${minutes} minutes`);
  }
  assert.equal(ingestionHealth(new Date(NOW.getTime() - 181 * MINUTES), 180 * MINUTES, NOW).stalled, true);
});

test('missing evidence is stalled, never healthy', () => {
  /* THE WHOLE POINT. The failure this exists to catch was silent for seven and a half hours because
     every signal defaulted to "fine" without evidence. A board that has never been polled, or whose
     timestamp will not parse, is the most stalled a board can be. */
  for (const value of [null, undefined, 'not-a-date', '']) {
    const health = ingestionHealth(value as never, 180 * MINUTES, NOW);
    assert.equal(health.stalled, true, JSON.stringify(value));
    assert.equal(health.newest_seen_at, null);
    assert.equal(health.staleness_ms, null);
  }
});

test('clock skew cannot manufacture freshness, and is not an error either', () => {
  /* The database may sit slightly ahead of this process. Negative staleness clamps to zero rather
     than reading as a healthy negative number, but a few seconds of skew is ordinary and must not
     be treated as a fault. */
  const ahead = new Date(NOW.getTime() + 30_000);
  const health = ingestionHealth(ahead, 180 * MINUTES, NOW);
  assert.equal(health.staleness_ms, 0);
  assert.equal(health.stalled, false);
});

test('a nonsense threshold fails closed rather than disabling the alarm', () => {
  /* A zero, negative or NaN threshold must not become "never stalled". An alarm that can be
     silenced by a bad setting is the same silence this replaced. */
  const seen = new Date(NOW.getTime() - 5 * MINUTES);
  for (const threshold of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(ingestionHealth(seen, threshold, NOW).stalled, true, String(threshold));
  }
});
