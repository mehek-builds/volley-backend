import assert from 'node:assert/strict';
import test from 'node:test';
import {
  managedTerminalCleanupBatchWindow,
  managedTerminalCleanupRetrievalDisposition,
  retryManagedTerminalCleanupDelivery,
  specWithManagedTerminalCleanupEntries,
  specWithManagedTerminalFold,
  type BoundManagedTerminalCleanupMarker,
  type ManagedTerminalCleanupMarker,
} from './submissionRunner';

const marker: BoundManagedTerminalCleanupMarker = {
  version: 'managed-terminal-cleanup-entry-v2',
  attemptId: '11111111-1111-4111-8111-111111111111',
  submissionAttempt: {
    runId: '22222222-2222-4222-8222-222222222222',
    claimId: '11111111-1111-4111-8111-111111111111',
    executionId: '33333333-3333-4333-8333-333333333333',
  },
  resultId: 'a'.repeat(64),
};

const continuationMarker: BoundManagedTerminalCleanupMarker = {
  ...marker,
  submissionAttempt: {
    ...marker.submissionAttempt,
    executionId: '44444444-4444-4444-8444-444444444444',
  },
  resultId: 'b'.repeat(64),
};

test('not_found remains retryable while only gone proves cleanup is already complete', () => {
  assert.equal(managedTerminalCleanupRetrievalDisposition('pending'), 'retry');
  assert.equal(managedTerminalCleanupRetrievalDisposition('not_found'), 'retry');
  assert.equal(managedTerminalCleanupRetrievalDisposition('gone'), 'complete');
  for (const state of ['completed', 'failed', 'indeterminate'] as const) {
    assert.equal(managedTerminalCleanupRetrievalDisposition(state), 'acknowledge');
  }
});

test('cleanup batches rotate deterministically so unresolved oldest rows cannot starve later rows', () => {
  const totalRows = 29;
  const batchSize = 12;
  const eligible = new Set<number>();
  const windows = [];
  for (let minute = 0; minute < totalRows; minute += 1) {
    const window = managedTerminalCleanupBatchWindow(totalRows, batchSize, minute * 60_000);
    windows.push(window);
    for (let index = 0; index < window.firstLimit; index += 1) {
      eligible.add(window.firstOffset + index);
    }
    for (let index = 0; index < window.wrapLimit; index += 1) eligible.add(index);
  }

  assert.deepEqual(windows.slice(0, 3), [
    { firstOffset: 0, firstLimit: 12, wrapLimit: 0 },
    { firstOffset: 12, firstLimit: 12, wrapLimit: 0 },
    { firstOffset: 24, firstLimit: 5, wrapLimit: 7 },
  ]);
  assert.equal(eligible.size, totalRows);
  assert.ok(eligible.has(totalRows - 1));
});

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

test('concurrent initial and continuation cleanup entries remain independently addressable', () => {
  const initial = specWithManagedTerminalCleanupEntries({ packet: 'kept' }, [marker]);
  const concurrent = specWithManagedTerminalCleanupEntries(initial, [continuationMarker]);

  assert.deepEqual(concurrent, {
    packet: 'kept',
    _managed_terminal_cleanup_outbox: {
      version: 'managed-terminal-cleanup-outbox-v2',
      entries: {
        [`${marker.submissionAttempt.executionId}:${marker.resultId}`]: marker,
        [`${continuationMarker.submissionAttempt.executionId}:${continuationMarker.resultId}`]:
          continuationMarker,
      },
    },
  });
  assert.deepEqual(
    specWithManagedTerminalCleanupEntries(concurrent, [marker, continuationMarker]),
    concurrent,
  );
});

test('a terminal review and all cleanup entries are constructed as one crash-safe packet value', () => {
  const review = { status: 'needs_attention' } as Parameters<
    typeof specWithManagedTerminalFold
  >[1];
  const folded = specWithManagedTerminalFold(
    { packet: 'kept', _review: { status: 'submitting' } },
    review,
    [marker, continuationMarker],
  );

  assert.equal(folded.packet, 'kept');
  assert.equal(folded._review, review);
  const outbox = folded._managed_terminal_cleanup_outbox as {
    entries: Record<string, ManagedTerminalCleanupMarker>;
  };
  assert.deepEqual(Object.values(outbox.entries), [marker, continuationMarker]);
});

test('a pending cleanup execution binds once to its exact result and rejects a different result', () => {
  const pending: ManagedTerminalCleanupMarker = {
    ...continuationMarker,
    resultId: null,
  };
  const pendingSpec = specWithManagedTerminalCleanupEntries({}, [pending]);
  const boundSpec = specWithManagedTerminalCleanupEntries(pendingSpec, [continuationMarker]);
  const outbox = boundSpec._managed_terminal_cleanup_outbox as {
    entries: Record<string, ManagedTerminalCleanupMarker>;
  };

  assert.equal(
    outbox.entries[`${pending.submissionAttempt.executionId}:pending`],
    undefined,
  );
  assert.deepEqual(
    outbox.entries[
      `${continuationMarker.submissionAttempt.executionId}:${continuationMarker.resultId}`
    ],
    continuationMarker,
  );
  assert.throws(
    () => specWithManagedTerminalCleanupEntries(boundSpec, [{
      ...continuationMarker,
      resultId: 'c'.repeat(64),
    }]),
    /already bound to another result/,
  );
});
