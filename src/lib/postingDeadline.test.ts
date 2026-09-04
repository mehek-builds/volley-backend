import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import { derivePostingDeadlineStatus, parseStatedApplicationDeadline } from './postingDeadline';

// The measured case: Mercari's "Class of 2028 Software Engineer Internship" (Workable,
// apply.workable.com/mercari/j/EC5A1078C4) shows "READY" while its own jd_text says this sentence,
// and Workable's public API still answers `state: published` for it - a stated deadline, not a
// take-down. See litos-exa-send-attempt-2026-09-04 and the backend design doc for the full trace.
const MERCARI_SENTENCE = 'Application Deadline: August 31, 2026, 23:59 (JST)';
const MERCARI_JD = `We are looking for a Software Engineer Intern to join our team in Tokyo.

Responsibilities include building services and collaborating with product teams.

${MERCARI_SENTENCE}

We look forward to your application.`;

function review(overrides: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: MERCARI_JD,
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-09-01T00:00:00.000Z',
    portal_url: 'https://apply.workable.com/mercari/j/EC5A1078C4/apply',
    ats_name: 'workable',
    portal_supported: true,
    ...overrides,
  };
}

test('parses the exact Mercari sentence to the UTC instant its stated JST deadline names', () => {
  const parsed = parseStatedApplicationDeadline(MERCARI_SENTENCE);
  assert.ok(parsed);
  assert.equal(parsed.deadlineUtc.toISOString(), '2026-08-31T14:59:00.000Z');
  assert.equal(parsed.displayDate, 'August 31, 2026');
});

test('finds the same sentence embedded in a full job description', () => {
  const parsed = parseStatedApplicationDeadline(MERCARI_JD);
  assert.ok(parsed);
  assert.equal(parsed.deadlineUtc.toISOString(), '2026-08-31T14:59:00.000Z');
});

test('reads "Apply by <date>" with no time and defaults to end of day UTC', () => {
  const parsed = parseStatedApplicationDeadline('Apply by December 1, 2026.');
  assert.ok(parsed);
  assert.equal(parsed.deadlineUtc.toISOString(), '2026-12-01T23:59:59.000Z');
  assert.equal(parsed.displayDate, 'December 1, 2026');
});

test('reads "Applications close <date>" with no comma before the year', () => {
  const parsed = parseStatedApplicationDeadline('Applications close January 5 2027 for this role.');
  assert.ok(parsed);
  assert.equal(parsed.deadlineUtc.toISOString(), '2027-01-05T23:59:59.000Z');
});

test('reads a bare "Deadline:" label with an explicit time and no zone, assumed UTC', () => {
  const parsed = parseStatedApplicationDeadline('Deadline: March 3, 2026, 17:00');
  assert.ok(parsed);
  assert.equal(parsed.deadlineUtc.toISOString(), '2026-03-03T17:00:00.000Z');
});

test('rejects "deadline-driven environment" - a label with no date after it', () => {
  assert.equal(parseStatedApplicationDeadline('Litos looks for a deadline-driven environment.'), null);
});

test('rejects "Deadline: TBD" - a label with no parseable date', () => {
  assert.equal(parseStatedApplicationDeadline('Deadline: TBD, details to follow.'), null);
});

test('rejects "Apply by the end of the process" - no month-name date at all', () => {
  assert.equal(parseStatedApplicationDeadline('Apply by the end of the process.'), null);
});

test('rejects a numeric MM/DD/YYYY date as ambiguous', () => {
  assert.equal(parseStatedApplicationDeadline('Deadline: 08/31/2026'), null);
});

test('rejects a month and year with no day', () => {
  assert.equal(parseStatedApplicationDeadline('Deadline: August 2026'), null);
});

test('rejects an explicit but unrecognized timezone abbreviation rather than guessing', () => {
  assert.equal(parseStatedApplicationDeadline('Deadline: March 3, 2026, 17:00 (PKT)'), null);
});

test('rejects an impossible calendar date', () => {
  assert.equal(parseStatedApplicationDeadline('Deadline: February 31, 2026'), null);
});

test('returns null for empty or missing text', () => {
  assert.equal(parseStatedApplicationDeadline(''), null);
  assert.equal(parseStatedApplicationDeadline(undefined), null);
  assert.equal(parseStatedApplicationDeadline(null), null);
});

test('derivePostingDeadlineStatus flags deadline_passed when now is after the stated deadline', () => {
  const derived = derivePostingDeadlineStatus(review(), new Date('2026-09-05T00:00:00.000Z'));
  assert.equal(derived.posting_status?.state, 'deadline_passed');
  assert.equal(derived.posting_status?.reason, 'stated_deadline');
  assert.equal(derived.posting_status?.deadline, '2026-08-31T14:59:00.000Z');
  assert.equal(derived.portal_supported, false);
  assert.match(derived.attention_reason ?? '', /August 31, 2026/);
  assert.match(derived.attention_reason ?? '', /confirm the employer still accepts applications/);
  assert.deepEqual(derived.attention_categories, ['posting_closed']);
});

test('derivePostingDeadlineStatus leaves the review untouched when now is before the stated deadline', () => {
  const original = review();
  const derived = derivePostingDeadlineStatus(original, new Date('2026-08-01T00:00:00.000Z'));
  assert.equal(derived, original);
  assert.equal(derived.posting_status, undefined);
  assert.equal(derived.portal_supported, true);
});

test('derivePostingDeadlineStatus leaves a review with no stated deadline untouched', () => {
  const original = review({ jd_text: 'A perfectly ordinary job description with no deadline sentence.' });
  const derived = derivePostingDeadlineStatus(original, new Date('2026-09-05T00:00:00.000Z'));
  assert.equal(derived, original);
});

for (const midRunStatus of ['submitting', 'submission_claimed', 'awaiting_security_code', 'submitted'] as const) {
  test(`a "${midRunStatus}" row is left untouched even though its jd_text names a past deadline`, () => {
    // Regression: nearly every SUBMITTED packet with a deadline sentence at all has a deadline in
    // the past by the time it is read back, since sending necessarily happens before it. Before
    // this exclusion existed, every read of GET /resume/history overwrote a sent packet's own
    // attention_reason with the deadline-passed sentence and set portal_supported: false on it.
    const original = review({ status: midRunStatus });
    const derived = derivePostingDeadlineStatus(original, new Date('2026-09-05T00:00:00.000Z'));
    assert.equal(derived, original);
    assert.equal(derived.posting_status, undefined);
  });
}

test('a take-down outranks a stated deadline and is left exactly as repair wrote it', () => {
  const closed = review({
    posting_status: { state: 'closed', reason: 'monitor_inactive', observed_at: '2026-09-01T00:00:00.000Z' },
    attention_reason: 'closed sentence',
    attention_categories: ['posting_closed'],
    portal_supported: false,
  });
  const derived = derivePostingDeadlineStatus(closed, new Date('2026-09-05T00:00:00.000Z'));
  assert.equal(derived, closed);
});

test('a stale nested posting_status.confirmed_open_at never shadows the persisted field', () => {
  // Regression: an earlier draft trusted review.posting_status.confirmed_open_at ahead of the
  // persisted review.posting_confirmed_open_at, so a review that already carried a stale
  // 'deadline_passed' object with no confirmation could ignore a confirmation that landed since.
  const staleObject = review({
    posting_status: { state: 'deadline_passed', reason: 'stated_deadline', deadline: '2026-08-31T14:59:00.000Z' },
    posting_confirmed_open_at: '2026-09-02T00:00:00.000Z',
  });
  const derived = derivePostingDeadlineStatus(staleObject, new Date('2026-09-05T00:00:00.000Z'));
  assert.equal(derived.posting_status?.confirmed_open_at, '2026-09-02T00:00:00.000Z');
  assert.equal(derived.portal_supported, true);
  assert.equal(derived.attention_reason, undefined);
});

test('confirming open keeps posting_status but stops blocking the send', () => {
  const confirmed = review({ posting_confirmed_open_at: '2026-09-02T00:00:00.000Z' });
  const derived = derivePostingDeadlineStatus(confirmed, new Date('2026-09-05T00:00:00.000Z'));
  assert.equal(derived.posting_status?.state, 'deadline_passed');
  assert.equal(derived.posting_status?.confirmed_open_at, '2026-09-02T00:00:00.000Z');
  assert.equal(derived.portal_supported, true);
  assert.equal(derived.attention_reason, undefined);
});
