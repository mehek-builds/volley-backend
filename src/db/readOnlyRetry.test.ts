import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READ_ONLY_SQLSTATE,
  isPassThroughQueryCall,
  isReadOnlyTransactionError,
  withReadOnlyRetry,
} from './readOnlyRetry';

test('the ordinary awaited query shapes go through the retry wrapper', () => {
  assert.equal(isPassThroughQueryCall(['select 1']), false);
  assert.equal(isPassThroughQueryCall(['update profiles set x = $1', [1]]), false);
  assert.equal(isPassThroughQueryCall([{ text: 'select 1', values: [] }]), false,
    'a config OBJECT without submit is still an awaited query');
  assert.equal(isPassThroughQueryCall([]), false);
});

test('the callback form bypasses the wrapper', () => {
  assert.equal(isPassThroughQueryCall(['select 1', () => {}]), true);
  assert.equal(isPassThroughQueryCall(['select 1', [1], () => {}]), true);
});

/* pg returns a Submittable synchronously so the caller can stream rows off it. Promise-wrapping it
   hands back an object with no .on and breaks the stream far from the wrapper that did it. */
test('a Submittable bypasses the wrapper', () => {
  assert.equal(isPassThroughQueryCall([{ submit: () => {} }]), true);
  assert.equal(isPassThroughQueryCall([{ submit: 'not a function' }]), false);
  assert.equal(isPassThroughQueryCall([null]), false, 'null must not throw on a property read');
  assert.equal(isPassThroughQueryCall([undefined]), false);
});

/** A pg error carries the SQLSTATE on `code`, so that is what the guard reads. */
function pgError(code: string, message = 'boom') {
  return Object.assign(new Error(message), { code });
}

const noSleep = async () => {};

test('25006 is recognised and nothing else is', () => {
  assert.equal(isReadOnlyTransactionError(pgError(READ_ONLY_SQLSTATE)), true);
  assert.equal(isReadOnlyTransactionError(pgError('25P02')), false, 'aborted transaction');
  assert.equal(isReadOnlyTransactionError(pgError('57014')), false, 'query cancelled');
  assert.equal(isReadOnlyTransactionError(pgError('ECONNRESET')), false, 'connection dropped');
  assert.equal(isReadOnlyTransactionError(new Error('cannot execute UPDATE')), false,
    'the MESSAGE is not the signal; a wrapper could carry that text with any code');
  assert.equal(isReadOnlyTransactionError(null), false);
  assert.equal(isReadOnlyTransactionError('25006'), false, 'a bare string is not a pg error');
});

test('a write that fails read-only once succeeds on the retry', async () => {
  let calls = 0;
  const result = await withReadOnlyRetry(async () => {
    calls += 1;
    if (calls === 1) throw pgError(READ_ONLY_SQLSTATE);
    return 'written';
  }, { sleep: noSleep });
  assert.equal(result, 'written');
  assert.equal(calls, 2);
});

test('a successful write is not retried and not delayed', async () => {
  let calls = 0;
  let slept = false;
  const result = await withReadOnlyRetry(async () => { calls += 1; return 'ok'; },
    { sleep: async () => { slept = true; } });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
  assert.equal(slept, false);
});

/* The safety argument for retrying at all is that Postgres rejects a 25006 BEFORE executing, so
   nothing happened. That argument does not extend to any other failure: a timeout or a dropped
   connection may well have committed, and running the statement again would double it. */
test('errors that might have committed are never retried', async () => {
  for (const code of ['57014', 'ECONNRESET', '25P02', '23505']) {
    let calls = 0;
    await assert.rejects(
      withReadOnlyRetry(async () => { calls += 1; throw pgError(code); }, { sleep: noSleep }),
      (error: unknown) => (error as { code?: string }).code === code,
    );
    assert.equal(calls, 1, `${code} must not be retried`);
  }
});

/* A Neon project stopped for quota is read-only on EVERY backend, so retrying cannot help. It has
   to stop and surface the real error rather than hang. */
test('a persistently read-only database gives up and rethrows the original error', async () => {
  let calls = 0;
  await assert.rejects(
    withReadOnlyRetry(async () => {
      calls += 1;
      throw pgError(READ_ONLY_SQLSTATE, 'cannot execute UPDATE in a read-only transaction');
    }, { attempts: 3, sleep: noSleep }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, READ_ONLY_SQLSTATE);
      assert.match((error as Error).message, /read-only transaction/,
        'the operator needs the original postgres message, not a wrapper of ours');
      return true;
    },
  );
  assert.equal(calls, 3, 'three attempts, then stop');
});

test('a persistently read-only pooled write can fall back to a direct operation', async () => {
  let calls = 0;
  let fallbackCalls = 0;
  const result = await withReadOnlyRetry(async () => {
    calls += 1;
    throw pgError(READ_ONLY_SQLSTATE, 'cannot execute INSERT in a read-only transaction');
  }, {
    attempts: 3,
    sleep: noSleep,
    onExhausted: async () => {
      fallbackCalls += 1;
      return 'direct-write';
    },
  });

  assert.equal(result, 'direct-write');
  assert.equal(calls, 3);
  assert.equal(fallbackCalls, 1);
});

test('attempts are configurable and always run at least once', async () => {
  let calls = 0;
  await assert.rejects(withReadOnlyRetry(async () => {
    calls += 1; throw pgError(READ_ONLY_SQLSTATE);
  }, { attempts: 0, sleep: noSleep }));
  assert.equal(calls, 1, 'attempts: 0 still runs the operation once rather than silently skipping the write');
});

test('a retry waits between attempts so three tries do not land in one instant', async () => {
  const waits: number[] = [];
  let calls = 0;
  await withReadOnlyRetry(async () => {
    calls += 1;
    if (calls < 3) throw pgError(READ_ONLY_SQLSTATE);
    return 'ok';
  }, { delayMs: 150, sleep: async (ms) => { waits.push(ms); } });
  assert.deepEqual(waits, [150, 150]);
});

test('onRetry reports each swallowed failure so the incident is visible in logs', async () => {
  const seen: number[] = [];
  let calls = 0;
  await withReadOnlyRetry(async () => {
    calls += 1;
    if (calls < 3) throw pgError(READ_ONLY_SQLSTATE);
    return 'ok';
  }, { sleep: noSleep, onRetry: (attempt) => seen.push(attempt) });
  assert.deepEqual(seen, [1, 2], 'a silent retry would hide the very condition this was built for');
});
