import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildFunnel, localDay, MIN_SUBMISSIONS_FOR_DAILY } from './funnel';

const d = (iso: string) => new Date(`${iso}T12:00:00.000Z`);
const NOW = d('2026-07-27');

describe('localDay', () => {
  test('a timestamp maps to its own calendar day', () => {
    assert.equal(localDay(d('2026-07-27')), '2026-07-27');
  });

  test('an evening timestamp does not roll into the next day', () => {
    assert.equal(localDay(new Date('2026-07-27T23:59:00.000Z')), '2026-07-27');
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

  test('days come back oldest first, so a chart reads left to right', () => {
    const f = buildFunnel({ tailoredAt: [], submittedAt: [], fieldsFilled: 0, now: NOW, days: 7 });
    assert.equal(f.days.length, 7);
    const sorted = [...f.days].sort((a, b) => a.day.localeCompare(b.day));
    assert.deepEqual(f.days, sorted);
    assert.equal(f.days.at(-1)?.day, '2026-07-27', 'the window ends today');
    assert.equal(f.days[0]?.day, '2026-07-21');
  });

  test('activity older than the window is counted in the total but not bucketed', () => {
    const f = buildFunnel({
      tailoredAt: [],
      submittedAt: [d('2025-01-01')],
      fieldsFilled: 0,
      now: NOW,
      days: 7,
    });
    assert.equal(f.applications_submitted, 1);
    assert.equal(f.days.reduce((n, w) => n + w.submitted, 0), 0);
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
      submittedAt: Array.from({ length: MIN_SUBMISSIONS_FOR_DAILY }, () => d('2026-07-27')),
      fieldsFilled: 0,
      now: NOW,
    });
    assert.equal(enough.too_early, false);
  });

  test('a brand new account is all zeros rather than a crash', () => {
    const f = buildFunnel({ tailoredAt: [], submittedAt: [], fieldsFilled: 0, now: NOW });
    assert.equal(f.applications_submitted, 0);
    assert.equal(f.too_early, true);
    assert.equal(f.days.every((w) => w.submitted === 0 && w.tailored === 0), true);
  });

  test('a submission and its resume land in the same day bucket', () => {
    const f = buildFunnel({
      tailoredAt: [d('2026-07-26')],
      submittedAt: [d('2026-07-26')],
      fieldsFilled: 0,
      now: NOW,
    });
    const day = f.days.find((w) => w.day === '2026-07-26');
    assert.deepEqual([day?.tailored, day?.submitted], [1, 1]);
  });

  test('two submissions on different days do not share a bar', () => {
    // The whole point of the daily chart: a weekly bucket collapsed these into one.
    const f = buildFunnel({
      tailoredAt: [],
      submittedAt: [d('2026-07-26'), d('2026-07-27')],
      fieldsFilled: 0,
      now: NOW,
    });
    assert.equal(f.days.find((w) => w.day === '2026-07-26')?.submitted, 1);
    assert.equal(f.days.find((w) => w.day === '2026-07-27')?.submitted, 1);
  });
});

/** Regressions from the pre-merge review. */
describe('review regressions', () => {
  test("a Dubai student's early morning is on THEIR day, not the previous one", () => {
    // 2026-08-03 01:00 +04 is 2026-08-02T21:00Z, so UTC bucketing put it on the day before.
    assert.equal(localDay(new Date('2026-08-02T21:00:00.000Z'), 4 * 60), '2026-08-03');
  });

  test("a Los Angeles student's evening is on THEIR day, not the next one", () => {
    // 2026-08-02 21:00 PDT is 2026-08-03T04:00Z.
    assert.equal(localDay(new Date('2026-08-03T04:00:00.000Z'), -7 * 60), '2026-08-02');
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
    assert.equal(f.too_early, true, 'one submission in two weeks is not a trend');
  });

  test('a future timestamp is counted where it can be seen, not only in the headline', () => {
    const f = buildFunnel({
      tailoredAt: [],
      submittedAt: [d('2027-01-01')],
      fieldsFilled: 0,
      now: NOW,
    });
    assert.equal(f.applications_submitted, 1);
    assert.equal(f.days.reduce((n, w) => n + w.submitted, 0), 1, 'clamped onto today');
  });

  test('an omitted offset keeps UTC rather than guessing', () => {
    assert.equal(localDay(d('2026-07-30')), localDay(d('2026-07-30'), 0));
  });
});
