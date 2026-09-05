/**
 * The final-send lease is the budget of the run that fills the whole form again and presses submit,
 * so it must cover at least what the preview fill is given (MANAGED_PREPARE_FILL_DEADLINE_MS) and
 * stay under the stratus host's own ceiling on a provider deadline (eight minutes past its clock,
 * stratus #189). A lease shorter than the preview budget makes the send die on the same long forms
 * whose preview succeeded; TWG Global (Workable) measured this on 2026-09-05.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MANAGED_PREPARE_FILL_DEADLINE_MS } from './browserbase.js';
import {
  SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS,
  authorizeFinalSubmissionBoundary,
  type SubmissionAttemptLedgerExecutor,
} from './submissionAttemptLedger.js';

const STRATUS_MAX_PROVIDER_DEADLINE_MS = 8 * 60 * 1000;

test('the final-send lease covers the preview fill budget and leaves skew headroom under the stratus ceiling', () => {
  assert.equal(SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS, 7 * 60 * 1000);
  assert.ok(SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS >= MANAGED_PREPARE_FILL_DEADLINE_MS);
  assert.ok(STRATUS_MAX_PROVIDER_DEADLINE_MS - SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS >= 60 * 1000);
});

test('a lease longer than the stratus ceiling is refused before the ledger is read', async () => {
  const executor = new Proxy({}, {
    get(_target, property) {
      throw new Error(`ledger touched through ${String(property)} before the TTL was validated`);
    },
  }) as unknown as SubmissionAttemptLedgerExecutor;
  const binding = {
    userId: '00000000-0000-4000-8000-000000000001',
    applicationId: '00000000-0000-4000-8000-000000000002',
    attemptId: '00000000-0000-4000-8000-000000000003',
    packetId: '00000000-0000-4000-8000-000000000002',
  };
  await assert.rejects(
    authorizeFinalSubmissionBoundary(binding as never, {
      executor,
      factKey: 'ttl-pin',
      ttlMs: STRATUS_MAX_PROVIDER_DEADLINE_MS + 1,
    }),
    /between 1 ms and 8 minutes/,
  );
});
