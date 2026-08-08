import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewState } from './applicationReview';
import {
  applyReviewPatch,
  beginStall,
  isWaitingOnHuman,
  orderByStalledAt,
  settleStall,
} from './applicationStall';

// Compiler-checked exhaustive list. `satisfies` makes a new member of the status union a BUILD
// failure here rather than a silently uncovered case: the previous version of this file listed five
// statuses by hand and missed 'submit_requested' and 'submission_claimed', both of which this
// feature's own code paths write.
const ALL_STATUSES = [
  'resume_ready',
  'questions_ready',
  'ready_to_submit',
  'submit_requested',
  'preparing',
  'filling',
  'needs_attention',
  'ready_for_final_approval',
  'awaiting_security_code',
  'submitting',
  'submission_claimed',
  'submitted',
  'failed',
] as const satisfies readonly ApplicationReviewState['status'][];

type Status = ApplicationReviewState['status'];
const _exhaustive: Status extends (typeof ALL_STATUSES)[number] ? true : never = true;
void _exhaustive;

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
  source: 'observed',
} as const;

const AT = (iso: string) => () => iso;

// ---- beginStall ----

test('a new stall records when it began', () => {
  const { stall } = beginStall({}, {
    surface: 'server_run',
    provider: 'hcaptcha',
    stage: 'before_fill',
    source: 'observed',
  }, AT('2026-08-04T10:00:00.000Z'));
  assert.deepEqual(stall, {
    kind: 'human_verification',
    stalled_at: '2026-08-04T10:00:00.000Z',
    surface: 'server_run',
    provider: 'hcaptcha',
    stage: 'before_fill',
    source: 'observed',
  });
});

test('re-observing an open stall does not restart its clock', () => {
  const { stall } = beginStall({ stall: STALL }, {
    surface: 'server_run',
    provider: 'recaptcha_v2',
    stage: 'at_submit',
    source: 'observed',
  }, AT('2026-08-04T23:00:00.000Z'));
  assert.equal(stall?.stalled_at, '2026-08-04T09:00:00.000Z');
});

test('a stall that reaches a new stage updates the stage but keeps the clock', () => {
  const before = beginStall({}, {
    surface: 'server_run',
    provider: 'turnstile',
    stage: 'before_fill',
    source: 'observed',
  }, AT('2026-08-04T09:00:00.000Z'));
  const after = beginStall(before, {
    surface: 'server_run',
    provider: 'turnstile',
    stage: 'at_submit',
    source: 'observed',
  }, AT('2026-08-04T09:30:00.000Z'));
  assert.equal(after.stall?.stage, 'at_submit');
  assert.equal(after.stall?.stalled_at, '2026-08-04T09:00:00.000Z');
});

// A resolved stall is finished business. Something stopping the application again is a NEW wait and
// gets a new clock, otherwise the queue would age it from a challenge the applicant already cleared.
test('a stall that follows a resolved one starts a fresh clock', () => {
  const { stall } = beginStall(
    { stall: { ...STALL, resolved_at: '2026-08-04T09:05:00.000Z' } },
    { surface: 'server_run', provider: 'turnstile', stage: 'at_submit', source: 'observed' },
    AT('2026-08-05T11:00:00.000Z'),
  );
  assert.equal(stall?.stalled_at, '2026-08-05T11:00:00.000Z');
  assert.equal(stall?.resolved_at, undefined);
});

// ---- settleStall ----

test('a stall stays open while the application is still waiting on a human', () => {
  assert.deepEqual(settleStall(review({ status: 'needs_attention', stall: STALL })).stall, STALL);
});

// In-flight statuses are the pipeline moving the row, NOT the applicant acting, so the wait is
// still running and the stall stays open. Closing here is what reset the clock twice.
const STILL_WAITING = new Set<ApplicationReviewState['status']>([
  'needs_attention',
  'submit_requested',
  'preparing',
  'filling',
  'submitting',
  'submission_claimed',
]);

for (const status of ALL_STATUSES) {
  test(`status ${status}: the stall closes only when the wait is genuinely over`, () => {
    const settled = settleStall(review({ status, stall: STALL }), AT('2026-08-04T12:00:00.000Z'));
    assert.equal(
      settled.stall?.resolved_at,
      STILL_WAITING.has(status) ? undefined : '2026-08-04T12:00:00.000Z',
    );
    // Closed, never deleted: resolved_at minus stalled_at is the time-to-resolution measurement.
    assert.equal(settled.stall?.stalled_at, STALL.stalled_at);
  });
}

// The end-to-end regression. An automated re-run walks a stalled application through
// submit_requested -> preparing -> filling before it stalls again. Two earlier versions of this
// module broke here: the first deleted the stall on those transitions, the second closed it, and
// both made the next beginStall mint a new clock. The queue would then send the longest-waiting
// application to the back of its own queue on every poll, burying the one case it exists to raise.
test('a full automated re-run does not restart the clock or fake a resolution', () => {
  let state = applyReviewPatch(review({ status: 'submitting' }), {
    status: 'needs_attention',
    ...beginStall({}, { surface: 'server_run', provider: 'recaptcha_v2', stage: 'at_submit', source: 'observed' }, AT('2026-08-01T00:00:00.000Z')),
  }, AT('2026-08-01T00:00:00.000Z'));

  for (const [status, at] of [
    ['submit_requested', '2026-08-01T00:05:00.000Z'],
    ['preparing', '2026-08-01T00:06:00.000Z'],
    ['filling', '2026-08-01T00:06:30.000Z'],
  ] as const) {
    state = applyReviewPatch(state, { status }, AT(at));
    assert.equal(state.stall?.resolved_at, undefined, `${status} must not fake a resolution`);
  }

  state = applyReviewPatch(state, {
    status: 'needs_attention',
    ...beginStall(state, { surface: 'server_run', provider: 'recaptcha_v2', stage: 'at_submit', source: 'observed' }, AT('2026-08-01T00:07:00.000Z')),
  }, AT('2026-08-01T00:07:00.000Z'));

  assert.equal(state.stall?.stalled_at, '2026-08-01T00:00:00.000Z');
  assert.equal(isWaitingOnHuman(state), true);
});

test('settling twice does not move the resolution time', () => {
  const once = settleStall(review({ status: 'submitted', stall: STALL }), AT('2026-08-04T12:00:00.000Z'));
  const twice = settleStall(once, AT('2026-08-04T18:00:00.000Z'));
  assert.equal(twice.stall?.resolved_at, '2026-08-04T12:00:00.000Z');
});

test('settling a review with no stall leaves it untouched', () => {
  const input = review({ status: 'submitted' });
  assert.equal(settleStall(input), input);
});

// ---- the queue predicate ----

test('only an open stall in needs_attention is waiting on a human', () => {
  assert.equal(isWaitingOnHuman({ status: 'needs_attention', stall: STALL }), true);
  assert.equal(isWaitingOnHuman({ status: 'submitted', stall: STALL }), false);
  assert.equal(
    isWaitingOnHuman({ status: 'needs_attention', stall: { ...STALL, resolved_at: '2026-08-04T10:00:00.000Z' } }),
    false,
  );
  // needs_attention for some other reason (a missing field, an attestation) is not this queue's job.
  assert.equal(isWaitingOnHuman({ status: 'needs_attention' }), false);
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

// An empty sort key compares BEFORE every ISO timestamp, so the naive `?? ''` put rows that never
// stalled at the head of a queue that promises the longest wait is on top.
test('a row that never stalled does not jump the queue', () => {
  const ordered = orderByStalledAt([
    { id: 'never-stalled' },
    { id: 'waiting-since-august', stall: { stalled_at: '2026-08-01T08:00:00.000Z' } },
  ]);
  assert.deepEqual(ordered.map((row) => row.id), ['waiting-since-august', 'never-stalled']);
});

test('ordering does not mutate the caller’s array', () => {
  const rows = [
    { id: 'b', stall: { stalled_at: '2026-08-04T12:00:00.000Z' } },
    { id: 'a', stall: { stalled_at: '2026-08-01T12:00:00.000Z' } },
  ];
  orderByStalledAt(rows);
  assert.deepEqual(rows.map((row) => row.id), ['b', 'a']);
});

// ---- the merge every writer passes through ----

test('a patch that stalls an application keeps the stall open', () => {
  const merged = applyReviewPatch(
    review({ status: 'submitting' }),
    { status: 'needs_attention', ...beginStall({}, { surface: 'server_run', provider: 'hcaptcha', stage: 'at_submit', source: 'observed' }, AT('2026-08-04T09:00:00.000Z')) },
    AT('2026-08-04T09:00:00.000Z'),
  );
  assert.equal(isWaitingOnHuman(merged), true);
});

// The interaction that the runner's fail() depends on: a stall spread into a patch whose status is
// NOT needs_attention is closed on the way in, so a non-CAPTCHA failure cannot leave an open stall.
test('a patch that ends in a genuinely finished status closes the stall it carries', () => {
  const merged = applyReviewPatch(
    review({ status: 'needs_attention', stall: STALL }),
    { status: 'failed' },
    AT('2026-08-04T12:00:00.000Z'),
  );
  assert.equal(merged.stall?.resolved_at, '2026-08-04T12:00:00.000Z');
  assert.equal(isWaitingOnHuman(merged), false);
});

test('an application that submits after stalling leaves the queue but keeps its history', () => {
  const stalled = applyReviewPatch(review({ status: 'submitting' }), {
    status: 'needs_attention',
    ...beginStall({}, { surface: 'server_run', provider: 'recaptcha_v2', stage: 'at_submit', source: 'observed' }, AT('2026-08-04T09:00:00.000Z')),
  }, AT('2026-08-04T09:00:00.000Z'));
  const submitted = applyReviewPatch(stalled, { status: 'submitted' }, AT('2026-08-04T09:04:00.000Z'));
  assert.equal(isWaitingOnHuman(submitted), false);
  assert.equal(submitted.stall?.stalled_at, '2026-08-04T09:00:00.000Z');
  assert.equal(submitted.stall?.resolved_at, '2026-08-04T09:04:00.000Z');
});
