import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFunnel, mondayOf, MIN_SUBMISSIONS_FOR_WEEKLY } from './funnel';

const d = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
const NOW = d('2026-07-27'); // a Monday

describe('mondayOf', () => {
  test('a Monday is its own week start', () => {
    assert.equal(mondayOf(d('2026-07-27')), '2026-07-27');
  });

  test('SUNDAY belongs to the week that started six days earlier, not the next one', () => {
    // getUTCDay() is 0 on Sunday, so the naive shift puts Sunday's work in next week's bucket and
    // a student who applies on Sunday sees an empty week.
    assert.equal(mondayOf(d('2026-08-02')), '2026-07-27');
  });

  test('a mid-week day maps back to its Monday', () => {
    assert.equal(mondayOf(d('2026-07-30')), '2026-07-27');
  });
});

describe('buildFunnel', () => {
  test('counts what happened, and nothing it cannot see', () => {
    const f = buildFunnel({
      tailoredAt: [d('2026-07-27'), d('2026-07-26')],
      submittedAt: [d('2026-07-27')],
      fieldsFilled: 42,
      now: NOW,
    });
    assert.equal(f.resumes_tailored, 2);
    assert.equal(f.applications_submitted, 1);
    assert.equal(f.fields_filled, 42);
    assert.ok(!('interview_rate' in f), 'Litos cannot see replies and must not report them');
    assert.ok(!('minutes_saved' in f), 'time saved would be a made-up constant times a real count');
  });

  test('this week counts the last seven days, not the calendar week', () => {
    const f = buildFunnel({
      tailoredAt: [],
      submittedAt: [d('2026-07-27'), d('2026-07-22'), d('2026-07-01')],
      fieldsFilled: 0,
      now: NOW,
    });
    assert.equal(f.submitted_this_week, 2);
  });

  test('weeks come back oldest first, so a chart reads left to right', () => {
    const f = buildFunnel({ tailoredAt: [], submittedAt: [], fieldsFilled: 0, now: NOW, weeks: 4 });
    assert.equal(f.weeks.length, 4);
    const sorted = [...f.weeks].sort((a, b) => a.week_start.localeCompare(b.week_start));
    assert.deepEqual(f.weeks, sorted);
  });

  test('activity older than the window is counted in the total but not bucketed', () => {
    const f = buildFunnel({
      tailoredAt: [],
      submittedAt: [d('2025-01-01')],
      fieldsFilled: 0,
      now: NOW,
      weeks: 4,
    });
    assert.equal(f.applications_submitted, 1);
    assert.equal(f.weeks.reduce((n, w) => n + w.submitted, 0), 0);
  });

  test('too few submissions is flagged, so a chart is not drawn from noise', () => {
    const few = buildFunnel({
      tailoredAt: [],
      submittedAt: [d('2026-07-27')],
      fieldsFilled: 0,
      now: NOW,
    });
    assert.equal(few.too_early, true);

    const enough = buildFunnel({
      tailoredAt: [],
      submittedAt: Array.from({ length: MIN_SUBMISSIONS_FOR_WEEKLY }, () => d('2026-07-27')),
      fieldsFilled: 0,
      now: NOW,
    });
    assert.equal(enough.too_early, false);
  });

  test('a brand new account is all zeros rather than a crash', () => {
    const f = buildFunnel({ tailoredAt: [], submittedAt: [], fieldsFilled: 0, now: NOW });
    assert.equal(f.applications_submitted, 0);
    assert.equal(f.too_early, true);
    assert.equal(f.weeks.every((w) => w.submitted === 0 && w.tailored === 0), true);
  });

  test('a submission and its resume land in the same week bucket', () => {
    const f = buildFunnel({
      tailoredAt: [d('2026-07-29')],
      submittedAt: [d('2026-07-30')],
      fieldsFilled: 0,
      now: NOW,
    });
    const week = f.weeks.find((w) => w.week_start === '2026-07-27');
    assert.deepEqual([week?.tailored, week?.submitted], [1, 1]);
  });
});

/** Regressions from the pre-merge review. */
describe('review regressions', () => {
  test('a Dubai student\'s Monday morning is in THEIR week, not the previous one', () => {
    // 2026-08-03 01:00 +04 is 2026-08-02T21:00Z, a Sunday in UTC, so UTC bucketing put it in the
    // week that had just ended.
    assert.equal(mondayOf(new Date('2026-08-02T21:00:00.000Z'), 4 * 60), '2026-08-03');
  });

  test('a Los Angeles student\'s Sunday evening is in THEIR week, not the next one', () => {
    // 2026-08-02 21:00 PDT is 2026-08-03T04:00Z, a Monday in UTC.
    assert.equal(mondayOf(new Date('2026-08-03T04:00:00.000Z'), -7 * 60), '2026-07-27');
  });

  test('too_early looks at the charted window, not all time', () => {
    // 40 submissions in February and one in July drew a confident chart of empty bars under a
    // headline of 41.
    const old = Array.from({ length: 40 }, () => d('2026-02-10'));
    const f = buildFunnel({
      tailoredAt: [],
      submittedAt: [...old, d('2026-07-27')],
      fieldsFilled: 0,
      now: NOW,
    });
    assert.equal(f.applications_submitted, 41);
    assert.equal(f.too_early, true, 'one submission in eight weeks is not a trend');
  });

  test('a future timestamp is counted where it can be seen, not only in the headline', () => {
    const f = buildFunnel({
      tailoredAt: [],
      submittedAt: [d('2027-01-01')],
      fieldsFilled: 0,
      now: NOW,
    });
    assert.equal(f.applications_submitted, 1);
    assert.equal(f.weeks.reduce((n, w) => n + w.submitted, 0), 1, 'clamped into the current week');
  });

  test('an omitted offset keeps the old UTC behaviour rather than guessing', () => {
    assert.equal(mondayOf(d('2026-07-30')), mondayOf(d('2026-07-30'), 0));
  });
});
