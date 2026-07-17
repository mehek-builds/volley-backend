import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isBillingOrAuthFailure, isTransientOverload, LLM_BILLING_PAYLOAD } from './resume';

// Regression coverage for R-012 (live, 2026-07-17): Anthropic credit exhaustion surfaced as the
// same generic "Failed to generate resume spec" as a transient 529, so a permanent product-down
// state looked like a flaky JD and the student's only move was re-clicking forever. The
// classifier's job is a three-way fork: transient (503 llm_overloaded, client retries),
// billing/auth (503 llm_billing, permanent, owner acts), everything else (500). Both wrong
// directions cost: calling billing "transient" hammers a dead account, calling a malformed
// request "billing" hides our own bug behind a not-your-fault banner.

// The exact live error shape from the incident: the SDK throws APIError with a numeric status
// and the API's message text.
function apiError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

const CREDIT_MESSAGE =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';

describe('billing/auth classification (R-012)', () => {
  test('credit exhaustion (the live incident: 400 invalid_request_error naming the balance) is billing', () => {
    assert.equal(isBillingOrAuthFailure(apiError(400, CREDIT_MESSAGE)), true);
  });

  test('401 is auth: a revoked or wrong key is an owner problem, not a student one', () => {
    assert.equal(isBillingOrAuthFailure(apiError(401, '401 authentication_error: invalid x-api-key')), true);
    assert.equal(isBillingOrAuthFailure({ status: 401 }), true);
  });

  test('403 is auth as well', () => {
    assert.equal(isBillingOrAuthFailure(apiError(403, '403 permission_error')), true);
  });

  test('a 400 WITHOUT billing language is OUR bad request and stays out of the billing path', () => {
    assert.equal(isBillingOrAuthFailure(apiError(400, '400 invalid_request_error: max_tokens must be positive')), false);
    assert.equal(isBillingOrAuthFailure(apiError(400, '400 invalid_request_error: messages: at least one message is required')), false);
  });

  test('transient shapes are NOT billing: they keep their own retry path', () => {
    assert.equal(isBillingOrAuthFailure({ status: 529 }), false);
    assert.equal(isBillingOrAuthFailure({ status: 429 }), false);
    assert.equal(isBillingOrAuthFailure({ status: 500 }), false);
    assert.equal(isBillingOrAuthFailure(new Error('Connection error.')), false);
  });

  test('non-errors do not crash the classifier', () => {
    assert.equal(isBillingOrAuthFailure(null), false);
    assert.equal(isBillingOrAuthFailure(undefined), false);
    assert.equal(isBillingOrAuthFailure({}), false);
    assert.equal(isBillingOrAuthFailure('credit balance'), false);
  });

  test('the two classifiers never overlap: billing is not transient, so it can never be retried', () => {
    const billing = [apiError(400, CREDIT_MESSAGE), apiError(401, 'bad key'), apiError(403, 'forbidden')];
    for (const err of billing) {
      assert.equal(isBillingOrAuthFailure(err), true);
      assert.equal(isTransientOverload(err), false, `a billing/auth failure must never take the retry path: ${err.message}`);
    }
  });

  test('the payload carries the distinct code and a permanent, not-your-fault message', () => {
    assert.equal(LLM_BILLING_PAYLOAD.code, 'llm_billing');
    assert.match(LLM_BILLING_PAYLOAD.error, /not something you did/);
    assert.match(LLM_BILLING_PAYLOAD.error, /retrying will not fix it/);
    // No retry_after_ms on purpose: the client must not hammer a dead account.
    assert.equal('retry_after_ms' in LLM_BILLING_PAYLOAD, false);
  });
});
