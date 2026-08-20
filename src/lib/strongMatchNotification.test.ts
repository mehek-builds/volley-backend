import assert from 'node:assert/strict';
import test from 'node:test';
import { breachesStrongFitSla, hoursSinceFound, STRONG_FIT_SLA_HOURS, VERY_STRONG_FIT_SCORE } from './strongMatchNotification';

const NOW = new Date('2026-08-20T12:00:00.000Z');

test('hoursSinceFound is the plain elapsed time, not floored or coarsened', () => {
  assert.equal(hoursSinceFound(new Date('2026-08-20T09:00:00.000Z'), NOW), 3);
  assert.equal(hoursSinceFound(new Date('2026-08-20T10:30:00.000Z'), NOW), 1.5);
  assert.equal(hoursSinceFound(NOW, NOW), 0);
});

test('the SLA only ever applies to a very strong fit, never to an ordinary match', () => {
  // Ten hours late, but the score never clears the bar the barrier is written against.
  const ordinary = { score: VERY_STRONG_FIT_SCORE - 1, first_seen_at: new Date('2026-08-20T00:00:00.000Z') };
  assert.equal(breachesStrongFitSla(ordinary, NOW), false);
});

test('a very strong fit inside the window is not a breach', () => {
  const justFound = {
    score: VERY_STRONG_FIT_SCORE,
    first_seen_at: new Date(NOW.getTime() - (STRONG_FIT_SLA_HOURS - 0.1) * 60 * 60 * 1000),
  };
  assert.equal(breachesStrongFitSla(justFound, NOW), false);
});

test('a very strong fit past the window is the breach the barrier exists to catch', () => {
  const late = {
    score: VERY_STRONG_FIT_SCORE,
    first_seen_at: new Date(NOW.getTime() - (STRONG_FIT_SLA_HOURS + 0.1) * 60 * 60 * 1000),
  };
  assert.equal(breachesStrongFitSla(late, NOW), true);
});

test('exactly on the boundary is not yet a breach', () => {
  // Strictly greater than, not greater-or-equal: a send at exactly the deadline kept the promise.
  const onTheLine = {
    score: VERY_STRONG_FIT_SCORE,
    first_seen_at: new Date(NOW.getTime() - STRONG_FIT_SLA_HOURS * 60 * 60 * 1000),
  };
  assert.equal(breachesStrongFitSla(onTheLine, NOW), false);
});
