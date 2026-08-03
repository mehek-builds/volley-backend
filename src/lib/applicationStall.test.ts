import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import { beginStall, orderByStalledAt, withStallInvariant } from './applicationStall';

function review(patch: Partial<ApplicationReviewState> = {}): ApplicationReviewState {
  return {
    jd_text: '',
    status: 'needs_attention',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-04T00:00:00.000Z',
    ...patch,
  };
}

const STALL = {
  kind: 'human_verification',
  stalled_at: '2026-08-04T09:00:00.000Z',
  surface: 'server_run',
  provider: 'recaptcha_v2',
  stage: 'at_submit',
} as const;

// ---- beginStall ----

test('a new stall records when it began', () => {
  const { stall } = beginStall({}, {
    surface: 'server_run',
    provider: 'hcaptcha',
    stage: 'before_fill',
  }, () => '2026-08-04T10:00:00.000Z');
  assert.deepEqual(stall, {
    kind: 'human_verification',
    stalled_at: '2026-08-04T10:00:00.000Z',
    surface: 'server_run',
    provider: 'hcaptcha',
    stage: 'before_fill',
  });
});

// The queue is ordered oldest-first, and the application nobody has dealt with is precisely the one
// that keeps getting re-polled. Refreshing stalled_at on every re-observation would send it to the
// back of its own queue every day, so the worst case would be the one thing never surfaced.
test('re-observing the same stall does not restart its clock', () => {
  const { stall } = beginStall({ stall: STALL }, {
    surface: 'server_run',
    provider: 'recaptcha_v2',
    stage: 'at_submit',
  }, () => '2026-08-04T23:00:00.000Z');
  assert.equal(stall?.stalled_at, '2026-08-04T09:00:00.000Z');
});

test('a stall that reaches a new stage updates the stage but keeps the clock', () => {
  const before = beginStall({}, {
    surface: 'server_run',
    provider: 'turnstile',
    stage: 'before_fill',
  }, () => '2026-08-04T09:00:00.000Z');
  const after = beginStall(before, {
    surface: 'server_run',
    provider: 'turnstile',
    stage: 'at_submit',
  }, () => '2026-08-04T09:30:00.000Z');
  assert.equal(after.stall?.stage, 'at_submit');
  assert.equal(after.stall?.stalled_at, '2026-08-04T09:00:00.000Z');
});

// ---- the invariant ----

test('a stall survives while the application is still waiting on a human', () => {
  const kept = withStallInvariant(review({ status: 'needs_attention', stall: STALL }));
  assert.deepEqual(kept.stall, STALL);
});

// The bug this exists to prevent: an application stalls on a challenge, is submitted on a later
// run, and keeps its stall record forever. The queue then shows someone a job they already
// finished, and they trust it less every time it happens.
test('submitting an application clears its stall', () => {
  const cleared = withStallInvariant(review({ status: 'submitted', stall: STALL }));
  assert.equal('stall' in cleared, false);
});

for (const status of ['submitting', 'filling', 'preparing', 'failed', 'ready_to_submit'] as const) {
  test(`leaving needs_attention for ${status} clears the stall`, () => {
    assert.equal('stall' in withStallInvariant(review({ status, stall: STALL })), false);
  });
}

test('the invariant leaves an unstalled review untouched', () => {
  const input = review({ status: 'submitted' });
  assert.equal(withStallInvariant(input), input);
});

// ---- ordering ----

test('the queue puts the longest wait first', () => {
  const ordered = orderByStalledAt([
    { id: 'newest', stall: { stalled_at: '2026-08-04T12:00:00.000Z' } },
    { id: 'oldest', stall: { stalled_at: '2026-08-01T08:00:00.000Z' } },
    { id: 'middle', stall: { stalled_at: '2026-08-03T10:00:00.000Z' } },
  ]);
  assert.deepEqual(ordered.map((row) => row.id), ['oldest', 'middle', 'newest']);
});

test('ordering does not mutate the caller’s array', () => {
  const rows = [
    { id: 'b', stall: { stalled_at: '2026-08-04T12:00:00.000Z' } },
    { id: 'a', stall: { stalled_at: '2026-08-01T12:00:00.000Z' } },
  ];
  orderByStalledAt(rows);
  assert.deepEqual(rows.map((row) => row.id), ['b', 'a']);
});
