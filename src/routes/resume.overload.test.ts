import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransientOverload, overloadBackoffMs, shouldRetryResumeSpec } from './resume';
import type { ResumeSpec } from '../llm/resumeSpec';

const RETRY_SPEC = {
  school: 'USC', degree: 'B.S.', grad_date: '2027', coursework: '', experience: [], skills: [],
} as ResumeSpec;

test('grounded local resume output never spends a second provider attempt on style feedback', () => {
  assert.equal(shouldRetryResumeSpec({ ...RETRY_SPEC, generation_method: 'local_fallback' }, ['weak bullet'], 1), false);
  assert.equal(shouldRetryResumeSpec(RETRY_SPEC, ['weak bullet'], 1), true);
  assert.equal(shouldRetryResumeSpec(RETRY_SPEC, [], 1), false);
  assert.equal(shouldRetryResumeSpec(RETRY_SPEC, ['weak bullet'], 2), false);
});

// Regression coverage for R-003 (live QA 2026-07-16): a real Anthropic `overloaded_error` incident
// killed a whole fill. /resume/generate returned a generic 500 "Failed to generate resume spec",
// which is indistinguishable from a bad JD, so the extension could only hard-fail and the student's
// only recovery was re-clicking "Yes, fill it" (6+ times on Global Relay, never succeeding while the
// incident lasted). isTransientOverload is the fork that decides between "come back, we'll retry"
// (503 + llm_overloaded, which the client retries across requests) and "this genuinely failed"
// (500). Getting it wrong in either direction is costly: too narrow and we hard-fail a recoverable
// blip again, too wide and we retry a permanently bad request until the budget dies.

// ── Retryable: transient capacity ────────────────────────────────────────────

test('529 overloaded_error is transient (the exact status from the live incident)', () => {
  assert.equal(isTransientOverload({ status: 529 }), true);
});

test('429 rate limit is transient', () => {
  assert.equal(isTransientOverload({ status: 429 }), true);
});

test('5xx upstream failures are transient', () => {
  assert.equal(isTransientOverload({ status: 500 }), true);
  assert.equal(isTransientOverload({ status: 502 }), true);
  assert.equal(isTransientOverload({ status: 503 }), true);
});

test('connection blips with no status are transient', () => {
  assert.equal(isTransientOverload(new Error('Connection error.')), true);
  assert.equal(isTransientOverload(new Error('fetch failed')), true);
  assert.equal(isTransientOverload(new Error('read ECONNRESET')), true);
});

// ── Not retryable ────────────────────────────────────────────────────────────

test('an abort is NOT transient: it is our own deadline firing, and retrying burns budget we already ran out of', () => {
  // The live Wealthsimple occurrence surfaced an internal APIUserAbortError on an SDK retry. That
  // error carries status undefined and names an abort; treating it as retryable would spin against
  // a budget that has already expired instead of returning cleanly.
  const abort = new Error('Request was aborted.');
  abort.name = 'APIUserAbortError';
  assert.equal(isTransientOverload(abort), false);
  assert.equal(isTransientOverload(new Error('The operation was aborted due to timeout')), false);
});

test('4xx client errors are NOT transient: a bad request stays bad', () => {
  assert.equal(isTransientOverload({ status: 400 }), false);
  assert.equal(isTransientOverload({ status: 401 }), false);
  assert.equal(isTransientOverload({ status: 404 }), false);
  assert.equal(isTransientOverload({ status: 422 }), false);
});

test('a malformed-JSON model response is NOT transient, so it takes the quality-retry path not the capacity one', () => {
  // resumeSpec.ts throws this as a plain Error when Claude returns unparseable JSON. It must reach
  // the feedback retry / 500, never the 503 "we'll retry" path: retrying identical input against a
  // healthy API just reproduces it.
  assert.equal(isTransientOverload(new Error('Claude returned invalid JSON for resume spec')), false);
  assert.equal(isTransientOverload(new Error('Resume spec truncated at max_tokens (4096 chars)')), false);
});

test('a parse error whose embedded model output mentions "network" is still NOT transient', () => {
  // The REAL error shape appends up to 200 chars of model output to the message. A student whose
  // resume (or a JD) is about networking puts the word "network" in that snippet, and the
  // connection-blip regex would otherwise reclassify a deterministic parse failure as a capacity
  // blip - an infinite client retry against a request that fails identically every time.
  assert.equal(
    isTransientOverload(
      new Error('Claude returned invalid JSON for resume spec (stop_reason=end_turn): {"summary": "Built a network monitoring tool for socket-level traffic'),
    ),
    false,
  );
  assert.equal(
    isTransientOverload(new Error('Resume spec truncated at max_tokens (4096 chars) - raise the cap. Tail: "...network engineering internship"')),
    false,
  );
});

test('non-errors do not crash the classifier', () => {
  assert.equal(isTransientOverload(null), false);
  assert.equal(isTransientOverload(undefined), false);
  assert.equal(isTransientOverload('overloaded'), false);
  assert.equal(isTransientOverload({}), false);
});

// ── Backoff ──────────────────────────────────────────────────────────────────

test('honors a Retry-After header when the API sends one', () => {
  const err = { status: 529, headers: { get: (k: string) => (k === 'retry-after' ? '3' : null) } };
  assert.equal(overloadBackoffMs(err, 1), 3000);
});

test('clamps a long Retry-After to the max backoff, so one header cannot eat the function budget', () => {
  // Vercel kills the function at 60s. Obeying a 120s Retry-After literally would guarantee a 504.
  const err = { status: 529, headers: { get: () => '120' } };
  assert.equal(overloadBackoffMs(err, 1), 6000);
});

test('falls back to exponential backoff with jitter when there is no Retry-After', () => {
  const err = { status: 529 };
  // Each is expo(attempt) + up to 250ms jitter: 1s, 2s, 4s, then clamped at 6s.
  const first = overloadBackoffMs(err, 1);
  assert.ok(first >= 1000 && first < 1250, `expected ~1s, got ${first}`);
  const second = overloadBackoffMs(err, 2);
  assert.ok(second >= 2000 && second < 2250, `expected ~2s, got ${second}`);
  const third = overloadBackoffMs(err, 3);
  assert.ok(third >= 4000 && third < 4250, `expected ~4s, got ${third}`);
  const fourth = overloadBackoffMs(err, 4);
  assert.ok(fourth >= 6000 && fourth <= 6250, `expected clamped ~6s, got ${fourth}`);
});

test('jitter actually varies, so a fleet of clients cannot synchronize into a thundering herd', () => {
  // Every Litos client retrying a SHARED incident is the failure mode here: identical schedules
  // would hammer an API that is already shedding load.
  const err = { status: 529 };
  const samples = new Set(Array.from({ length: 40 }, () => overloadBackoffMs(err, 1)));
  assert.ok(samples.size > 1, 'expected jittered backoff to vary across calls');
});

test('a malformed Retry-After falls back to backoff instead of NaN', () => {
  const err = { status: 529, headers: { get: () => 'Wed, 21 Oct 2026 07:28:00 GMT' } };
  const ms = overloadBackoffMs(err, 1);
  assert.ok(Number.isFinite(ms) && ms >= 1000, `expected a finite fallback, got ${ms}`);
});
