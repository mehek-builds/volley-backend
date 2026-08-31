import assert from 'node:assert/strict';
import test from 'node:test';
import {
  managedTerminalCleanupBatchWindow,
  drainManagedTerminalCleanupEntries,
  managedTerminalCleanupRetrievalDisposition,
  retryManagedTerminalCleanupDelivery,
  specWithManagedTerminalCleanupEntries,
  specWithManagedTerminalCleanupQuarantines,
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

test('account cleanup keeps pending executions durable and completes only provider-confirmed gone', async () => {
  const completed: ManagedTerminalCleanupMarker[] = [];
  const pending = { ...marker, resultId: null };
  const first = await drainManagedTerminalCleanupEntries([pending], {
    retrieve: async () => ({ state: 'pending' }),
    bind: async () => { throw new Error('pending results cannot bind'); },
    acknowledge: async () => { throw new Error('pending results cannot acknowledge'); },
    complete: async (entry) => { completed.push(entry); },
  });
  assert.deepEqual(first, { attempted: 1, completed: 0, pending: 1 });
  assert.equal(completed.length, 0);

  const gone = await drainManagedTerminalCleanupEntries([pending], {
    retrieve: async () => ({ state: 'gone' }),
    bind: async () => { throw new Error('gone results cannot bind'); },
    acknowledge: async () => { throw new Error('gone results cannot acknowledge'); },
    complete: async (entry) => { completed.push(entry); },
  });
  assert.deepEqual(gone, { attempted: 1, completed: 1, pending: 0 });
  assert.deepEqual(completed, [pending]);
});

test('provider failure preserves cleanup and a retry binds then acknowledges the exact result', async () => {
  const pending = { ...marker, resultId: null };
  let providerAvailable = false;
  const acknowledged: BoundManagedTerminalCleanupMarker[] = [];
  const completed: ManagedTerminalCleanupMarker[] = [];
  const dependencies = {
    retrieve: async () => {
      if (!providerAvailable) throw new Error('provider unavailable');
      return { state: 'completed' as const, resultId: marker.resultId };
    },
    bind: async (_entry: ManagedTerminalCleanupMarker, resultId: string) => ({
      ...pending,
      resultId,
    }) as BoundManagedTerminalCleanupMarker,
    acknowledge: async (entry: BoundManagedTerminalCleanupMarker) => { acknowledged.push(entry); },
    complete: async (entry: ManagedTerminalCleanupMarker) => { completed.push(entry); },
  };
  assert.deepEqual(
    await drainManagedTerminalCleanupEntries([pending], dependencies),
    { attempted: 1, completed: 0, pending: 1 },
  );
  providerAvailable = true;
  assert.deepEqual(
    await drainManagedTerminalCleanupEntries([pending], dependencies),
    { attempted: 1, completed: 1, pending: 0 },
  );
  assert.deepEqual(acknowledged, [marker]);
  assert.deepEqual(completed, [marker]);
});

test('initial and continuation cleanup drain independently without dropping a failed sibling', async () => {
  const failedExecutionId = marker.submissionAttempt.executionId;
  const completed: string[] = [];
  const result = await drainManagedTerminalCleanupEntries([marker, continuationMarker], {
    retrieve: async () => { throw new Error('bound entries do not retrieve'); },
    bind: async () => { throw new Error('bound entries do not bind'); },
    acknowledge: async (entry) => {
      if (entry.submissionAttempt.executionId === failedExecutionId) {
        throw new Error('controlled provider failure');
      }
    },
    complete: async (entry) => { completed.push(entry.submissionAttempt.executionId); },
  });
  assert.deepEqual(result, { attempted: 2, completed: 1, pending: 1 });
  assert.deepEqual(completed, [continuationMarker.submissionAttempt.executionId]);
});

test('an unreconstructible continuation cleanup is durably quarantined', () => {
  const quarantine = {
    version: 'managed-terminal-cleanup-quarantine-v1' as const,
    attemptId: marker.attemptId,
    reason: 'binding_mismatch' as const,
    continuationExecutionFingerprint: null,
  };
  const spec = specWithManagedTerminalCleanupQuarantines({ packet: 'kept' }, [quarantine]);
  assert.deepEqual(spec, {
    packet: 'kept',
    _managed_terminal_cleanup_quarantine: {
      version: 'managed-terminal-cleanup-quarantine-v1',
      entries: {
        [`${marker.attemptId}:binding_mismatch:unreconstructible`]: quarantine,
      },
    },
  });
});
