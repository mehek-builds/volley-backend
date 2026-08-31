import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { breachesStrongFitSla, hoursSinceFound, STRONG_FIT_SLA_HOURS, VERY_STRONG_FIT_SCORE } from './strongMatchNotification';

const NOW = new Date('2026-08-20T12:00:00.000Z');
const SOURCE = readFileSync('src/lib/strongMatchNotification.ts', 'utf8');

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

test('the ranked-pool materialization rechecks the exact strict board conditions', () => {
  const secondRead = SOURCE.slice(
    SOURCE.indexOf('const pool = await db'),
    SOURCE.indexOf('const poolById = new Map'),
  );
  assert.match(
    secondRead,
    /\.innerJoin\(career_page_sources, eq\(monitored_jobs\.source_id, career_page_sources\.id\)\)/,
    'the second read needs the source row because the board predicate depends on it',
  );
  assert.match(
    secondRead,
    /\.where\(and\(\s*\.\.\.conditions,\s*inArray\(monitored_jobs\.id, poolIds\),\s*notInArray\(monitored_jobs\.id, announced\)/,
    'the second read must recheck the shared strict conditions and notification dedupe',
  );
  assert.match(
    SOURCE,
    /boardConditions\(\{ sponsorOnly, targeting: jobTargeting, requireVerifiedEvidence: true \}\)/,
    'alerts must never inherit a public evidence-gate bypass',
  );
});

/**
 * THE CADENCE-TO-SLA LINK, MADE CHECKABLE.
 *
 * STRONG_FIT_SLA_HOURS is a TypeScript constant; the cadence that has to satisfy it is a cron
 * string in a YAML file neither this file nor a compiler reads. A review caught that the two were
 * asserted as agreeing only in prose, in two separately-edited files, with nothing to catch drift
 * if one changed without the other. This test is the deeper fix that comment asked for: it reads
 * the actual workflow file and fails if the schedule it finds can no longer satisfy the SLA,
 * instead of relying on two humans reading each other's comments correctly forever.
 *
 * The check is deliberately narrow - it only understands the "every N hours" step form this
 * workflow actually uses (an asterisk, a slash, then a digit), not the full cron grammar - because
 * a hand-rolled cron parser that tried to be general would be a second, untested implementation of
 * something cron itself already validates.
 */
test('the GitHub Actions cadence for the strong-match sweep is frequent enough to satisfy STRONG_FIT_SLA_HOURS', () => {
  const workflow = readFileSync('.github/workflows/strong-match-notifications.yml', 'utf8');
  const cronLine = workflow.match(/^\s*-\s*cron:\s*'([^']+)'/m);
  assert.ok(cronLine, 'expected a cron schedule line in strong-match-notifications.yml');
  const [, cronExpression] = cronLine!;
  const hourField = cronExpression.split(/\s+/)[1];
  const stepMatch = hourField.match(/^\*\/(\d+)$/);
  assert.ok(
    stepMatch,
    `expected the cron's hour field to be a "*/N" step (got "${hourField}" from "${cronExpression}"); `
    + 'this test only understands that form and needs updating if the schedule shape changes',
  );
  const cadenceHours = Number(stepMatch![1]);
  assert.ok(
    cadenceHours <= STRONG_FIT_SLA_HOURS,
    `strong-match-notifications.yml runs every ${cadenceHours}h, which cannot satisfy a `
    + `${STRONG_FIT_SLA_HOURS}h SLA measured from the moment a posting is found - the sweep has to `
    + 'run at least as often as the promise it is making, or the barrier is unenforceable by design.',
  );
});
