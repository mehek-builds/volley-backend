import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModelUnavailable, isUpstreamApiError, ModelTimeoutError, modelFailureReason } from './llmFailure';

/** What the Anthropic SDK throws: an Error carrying a numeric HTTP status. */
function apiError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

test('the incident itself: an exhausted balance is our problem, not the upload', () => {
  // Verbatim from the production log, 2026-08-15, POST /profile.
  const error = apiError(
    400,
    '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
  );
  assert.equal(isUpstreamApiError(error), true);
  assert.equal(isModelUnavailable(error), true);
});

test('account-level refusals are all unavailability', () => {
  assert.equal(isModelUnavailable(apiError(401, 'authentication_error')), true);
  assert.equal(isModelUnavailable(apiError(402, 'payment required')), true);
  assert.equal(isModelUnavailable(apiError(403, 'forbidden')), true);
  assert.equal(isModelUnavailable(apiError(429, 'rate_limit_error')), true);
  assert.equal(isModelUnavailable(apiError(500, 'api_error')), true);
  assert.equal(isModelUnavailable(apiError(529, 'overloaded_error')), true);
});

test('an ordinary 400 stays a bug rather than being smoothed into "try later"', () => {
  // A prompt that is too long is our request being wrong, and it must keep failing loudly.
  const tooLong = apiError(400, 'prompt is too long: 250000 tokens > 200000 maximum');
  assert.equal(isUpstreamApiError(tooLong), true, 'it did come from the API');
  assert.equal(isModelUnavailable(tooLong), false, 'but it is not an availability problem');
});

test('our own parse failures are not upstream errors', () => {
  // These are built in llm/parse.ts and carry no status. Before 2026-08-15 the wrapper around them
  // swallowed API errors too, which is exactly what this boundary now prevents.
  const ours = new Error('Claude returned invalid JSON for resume parsing: Unexpected token }');
  assert.equal(isUpstreamApiError(ours), false);
  assert.equal(isModelUnavailable(ours), false);
});

test('a non-Error throw does not crash the classifier', () => {
  assert.equal(isModelUnavailable('boom'), false);
  assert.equal(isModelUnavailable(null), false);
  assert.equal(isModelUnavailable(undefined), false);
  assert.equal(isUpstreamApiError({ status: '429' }), false, 'a string status is not a status');
});

test('an application timeout is unavailable without pretending to be an upstream HTTP error', () => {
  const timeout = new ModelTimeoutError();
  assert.equal(isUpstreamApiError(timeout), false);
  assert.equal(isModelUnavailable(timeout), true);
  assert.equal(modelFailureReason(timeout), 'timeout');
});
