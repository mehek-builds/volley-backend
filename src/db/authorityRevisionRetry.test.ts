import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  conditionalWriteRows,
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

/* THE CONDITIONAL WRITE'S OWN READING OF THE SAME RAISE.
 *
 * An exact-CAS review write has exactly two honest outcomes for its caller: the rows it changed, or
 * nothing. The guard's 40001 belongs in the second, because it raises from a BEFORE trigger and
 * therefore aborts before touching the row - the identical proof withAuthorityRevisionRetry uses to
 * justify retrying at all. Left to propagate out of a route whose zero-row branch already says "a
 * run wrote to this packet, nothing of yours landed", it became a 500 carrying the statement
 * instead. Measured live 2026-09-04 on PUT /applications/:id/review/answers, packet 73768339.
 *
 * The retry is unchanged and still first: the common case is a poll holding the lock for
 * milliseconds, and that must cost the applicant nothing at all. */
describe('conditionalWriteRows', () => {
  it('answers the rows the statement changed when the guard lets go', async () => {
    let calls = 0;
    const rows = await conditionalWriteRows(async () => {
      calls += 1;
      if (calls < 2) throw guardRaise();
      return [{ id: 'row-1' }];
    }, { sleep: async () => {} });
    assert.deepEqual(rows, [{ id: 'row-1' }]);
    assert.equal(calls, 2, 'the transient refusal is retried, not reported');
  });

  it('answers no rows - never throws - when the guard holds for the whole window', async () => {
    let calls = 0;
    let lost = 0;
    const rows = await conditionalWriteRows(async () => {
      calls += 1;
      throw guardRaise();
    }, { attempts: 3, sleep: async () => {}, onLostToGuard: () => { lost += 1; } });
    assert.deepEqual(rows, [], 'nothing was written, which is what a lost compare-and-swap means');
    assert.equal(calls, 3);
    assert.equal(lost, 1, 'and the loss is announced once, for the log an incident is read from');
  });

  it('still throws everything that is not the guard, so a real fault stays a fault', async () => {
    await assert.rejects(
      conditionalWriteRows(async () => { throw new Error('unique violation'); }, { sleep: async () => {} }),
      /unique violation/,
    );
    await assert.rejects(
      conditionalWriteRows(async () => {
        throw Object.assign(new Error('read only'), { code: '25006' });
      }, { sleep: async () => {} }),
      /read only/,
    );
  });
});
