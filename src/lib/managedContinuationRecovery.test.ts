import assert from 'node:assert/strict';
import test from 'node:test';
import {
  managedContinuationAttemptFingerprint,
  managedContinuationTerminalDecision,
  managedRecoveryReviewFoldIsDurable,
  planManagedContinuationRecovery,
} from './managedContinuationRecovery';

const submissionAttempt = {
  runId: '11111111-1111-4111-8111-111111111111',
  claimId: '22222222-2222-4222-8222-222222222222',
  executionId: '33333333-3333-4333-8333-333333333333',
};
const deadline = '2026-08-31T10:01:10.000Z';

function state(overrides: Record<string, unknown> = {}) {
  return {
    runner: 'stratus-managed',
    status: 'verification_pending',
    continuationResumed: true,
    continuationExecutionFingerprint: managedContinuationAttemptFingerprint(submissionAttempt),
    continuationCallDeadlineAt: deadline,
    ...overrides,
  };
}

test('a crashed continuation reconstructs the exact GET-only tuple from durable state', () => {
  assert.deepEqual(planManagedContinuationRecovery({
    state: state(),
    bindingMatches: true,
    submissionAttempt,
    nowMs: Date.parse('2026-08-31T10:00:30.000Z'),
  }), {
    kind: 'poll',
    submissionAttempt,
    providerDeadlineAt: deadline,
  });
});

test('a wrong execution tuple is refused before terminal retrieval', () => {
  const wrongSubmissionAttempt = {
    ...submissionAttempt,
    executionId: '44444444-4444-4444-8444-444444444444',
  };
  assert.deepEqual(planManagedContinuationRecovery({
    state: state(),
    bindingMatches: true,
    submissionAttempt: wrongSubmissionAttempt,
    nowMs: Date.parse('2026-08-31T10:00:30.000Z'),
  }), { kind: 'invalid', reason: 'execution_mismatch', submissionAttempt: wrongSubmissionAttempt });
});

test('a wrong immutable application binding is refused before terminal retrieval', () => {
  assert.deepEqual(planManagedContinuationRecovery({
    state: state(),
    bindingMatches: false,
    submissionAttempt,
    nowMs: Date.parse('2026-08-31T10:00:30.000Z'),
  }), { kind: 'invalid', reason: 'binding_mismatch', submissionAttempt });
});

test('a malformed durable deadline is refused before terminal retrieval', () => {
  assert.deepEqual(planManagedContinuationRecovery({
    state: state({ continuationCallDeadlineAt: 'not-a-time' }),
    bindingMatches: true,
    submissionAttempt,
    nowMs: Date.parse('2026-08-31T10:00:30.000Z'),
  }), { kind: 'invalid', reason: 'deadline_invalid', submissionAttempt });
});

test('a search persisted before dispatch does not pretend a continuation was consumed', () => {
  assert.deepEqual(planManagedContinuationRecovery({
    state: state({ status: 'searching', continuationResumed: false }),
    bindingMatches: true,
    submissionAttempt,
    nowMs: Date.parse('2026-08-31T10:00:30.000Z'),
  }), { kind: 'none' });
});

test('repeated pending reads remain pending and eventual completion folds once', () => {
  const reads = ['pending', 'pending', 'completed'] as const;
  assert.deepEqual(reads.map((read, index) => managedContinuationTerminalDecision(
    read,
    deadline,
    Date.parse(`2026-08-31T10:00:${30 + index}.000Z`),
  )), ['pending', 'pending', 'completed']);
});

test('an attempt-bound indeterminate result is terminal and never becomes a redispatch', () => {
  assert.equal(managedContinuationTerminalDecision(
    'indeterminate',
    deadline,
    Date.parse('2026-08-31T10:01:10.000Z'),
  ), 'indeterminate');
});

test('pending and missing reads become a handoff only at the provider deadline', () => {
  assert.equal(managedContinuationTerminalDecision(
    'pending',
    deadline,
    Date.parse('2026-08-31T10:01:09.999Z'),
  ), 'pending');
  assert.equal(managedContinuationTerminalDecision(
    'not_found',
    deadline,
    Date.parse(deadline),
  ), 'deadline_expired');
  assert.equal(planManagedContinuationRecovery({
    state: state(),
    bindingMatches: true,
    submissionAttempt,
    nowMs: Date.parse(deadline),
  }).kind, 'expired');
});

test('initial acknowledgement rejects a search marker and accepts the exact durable continuation handoff', () => {
  const expectedExecutionFingerprint = managedContinuationAttemptFingerprint(submissionAttempt);
  assert.equal(managedRecoveryReviewFoldIsDurable({
    kind: 'initial',
    hasUnverifiedResult: true,
    state: state({ status: 'searching', continuationResumed: false }),
    expectedExecutionFingerprint,
  }), false);
  assert.equal(managedRecoveryReviewFoldIsDurable({
    kind: 'initial',
    hasUnverifiedResult: true,
    state: state(),
    expectedExecutionFingerprint,
  }), true);
});

test('continuation acknowledgement requires an exact terminal handoff', () => {
  const expectedExecutionFingerprint = managedContinuationAttemptFingerprint(submissionAttempt);
  assert.equal(managedRecoveryReviewFoldIsDurable({
    kind: 'continuation',
    hasUnverifiedResult: true,
    state: state(),
    expectedExecutionFingerprint,
  }), false);
  assert.equal(managedRecoveryReviewFoldIsDurable({
    kind: 'continuation',
    hasUnverifiedResult: true,
    state: state({ status: 'handoff' }),
    expectedExecutionFingerprint,
  }), true);
  assert.equal(managedRecoveryReviewFoldIsDurable({
    kind: 'continuation',
    hasUnverifiedResult: true,
    state: state({ status: 'handoff', continuationExecutionFingerprint: 'wrong' }),
    expectedExecutionFingerprint,
  }), false);
});
