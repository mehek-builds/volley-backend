import assert from 'node:assert/strict';
import test from 'node:test';
import {
  retryManagedTerminalCleanupDelivery,
  type BoundManagedTerminalCleanupMarker,
} from './submissionRunner';

const marker: BoundManagedTerminalCleanupMarker = {
  version: 'managed-terminal-cleanup-v1',
  attemptId: '11111111-1111-4111-8111-111111111111',
  submissionAttempt: {
    runId: '22222222-2222-4222-8222-222222222222',
    claimId: '11111111-1111-4111-8111-111111111111',
    executionId: '33333333-3333-4333-8333-333333333333',
  },
  resultId: 'a'.repeat(64),
};

test('a cleanup-pending response retries the exact durable acknowledgement without another fold or submit', async () => {
  const acknowledgements: Array<{ submissionAttempt: unknown; resultId: string }> = [];
  const completions: BoundManagedTerminalCleanupMarker[] = [];
  let calls = 0;
  const dependencies = {
    acknowledge: async (submissionAttempt: typeof marker.submissionAttempt, resultId: string) => {
      calls += 1;
      acknowledgements.push({ submissionAttempt, resultId });
      if (calls === 1) throw new Error('503 cleanup-pending');
      return { acknowledged: true };
    },
    complete: async (completed: BoundManagedTerminalCleanupMarker) => {
      completions.push(completed);
    },
  };

  assert.equal(await retryManagedTerminalCleanupDelivery(marker, dependencies), false);
  assert.equal(completions.length, 0);
  assert.equal(await retryManagedTerminalCleanupDelivery(marker, dependencies), true);
  assert.deepEqual(acknowledgements, [
    { submissionAttempt: marker.submissionAttempt, resultId: marker.resultId },
    { submissionAttempt: marker.submissionAttempt, resultId: marker.resultId },
  ]);
  assert.deepEqual(completions, [marker]);
});
