import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isAuthorityRevisionConflictError,
  withAuthorityRevisionRetry,
} from './authorityRevisionRetry';

function guardRaise(): Error & { code: string } {
  return Object.assign(
    new Error('submission authority changed concurrently; retry the request'),
    { code: '40001' },
  );
}

describe('isAuthorityRevisionConflictError', () => {
  it('matches the guard raise directly and anywhere in a cause chain', () => {
    assert.equal(isAuthorityRevisionConflictError(guardRaise()), true);
    const wrapped = new Error('Failed query: update ...');
    (wrapped as { cause?: unknown }).cause = guardRaise();
    assert.equal(isAuthorityRevisionConflictError(wrapped), true);
  });

  it('refuses everything else, including other Postgres codes and cause cycles', () => {
    assert.equal(isAuthorityRevisionConflictError(new Error('plain')), false);
    assert.equal(isAuthorityRevisionConflictError(Object.assign(new Error('ro'), { code: '25006' })), false);
    const a = new Error('a');
    const b = new Error('b');
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    assert.equal(isAuthorityRevisionConflictError(a), false);
    assert.equal(isAuthorityRevisionConflictError(null), false);
  });
});

describe('withAuthorityRevisionRetry', () => {
  it('retries the guard raise and returns the later success', async () => {
    let calls = 0;
    const retried: number[] = [];
    const result = await withAuthorityRevisionRetry(async () => {
      calls += 1;
      if (calls < 3) throw guardRaise();
      return 'claimed';
    }, { sleep: async () => {}, onRetry: (attempt) => retried.push(attempt) });
    assert.equal(result, 'claimed');
    assert.equal(calls, 3);
    assert.deepEqual(retried, [1, 2]);
  });

  it('rethrows the original error once attempts are exhausted', async () => {
    let calls = 0;
    await assert.rejects(
      withAuthorityRevisionRetry(async () => {
        calls += 1;
        throw guardRaise();
      }, { attempts: 2, sleep: async () => {} }),
      /retry the request/,
    );
    assert.equal(calls, 2);
  });

  it('does not retry non-guard errors', async () => {
    let calls = 0;
    await assert.rejects(
      withAuthorityRevisionRetry(async () => {
        calls += 1;
        throw new Error('unique violation');
      }, { sleep: async () => {} }),
      /unique violation/,
    );
    assert.equal(calls, 1);
  });
});
