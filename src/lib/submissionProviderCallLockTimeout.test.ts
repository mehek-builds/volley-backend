/* lockSubmissionProviderCallUser's bounded form, tested against a fake executor rather than a real
 * Postgres connection.
 *
 * WHY A FAKE EXECUTOR RATHER THAN THE REAL DB.TEST.TS HARNESS. Proving `SET LOCAL lock_timeout`
 * actually makes a contended `pg_advisory_xact_lock` fail with 55P03 needs a real PostgreSQL server -
 * see submissionProviderCallFence.db.test.ts, which already covers that with two real, concurrently
 * held connections. What is NOT covered there, and is exactly what this file exists to pin, is the
 * mapping this function does around that behaviour: which statements it issues and in what order,
 * that a lock-timeout failure becomes SubmissionProviderCallLockTimeoutError and nothing else does,
 * and that the unbounded (no-`lockTimeoutMs`) call shape every existing caller uses - most
 * importantly account.ts's account-deletion drain, which must keep waiting out a real in-flight call
 * no matter how long it legitimately takes - is completely untouched by any of this. None of that
 * needs a live lock to be wrong or right; it needs the exact sequence of statements this function
 * sends, which a fake executor can pin without starting PostgreSQL.
 *
 * THE ERROR SHAPE THIS SIMULATES IS THE MEASURED REAL ONE. applicationFacts.ts's
 * isUndefinedColumnError comment records that a failed statement on this repo's Drizzle version
 * arrives as a DrizzleQueryError whose own `code` is undefined and whose `cause` is the pg error
 * carrying the real SQLSTATE - here `DrizzleQueryError` is imported and constructed for real rather
 * than hand-rolled, so this test fails if that wrapping ever changes shape.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SQL } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { db } from '../db';
import {
  lockSubmissionProviderCallUser,
  SubmissionProviderCallLockTimeoutError,
} from './submissionAttemptLedger';

const dialect = new PgDialect();

type RenderedQuery = { sql: string; params: unknown[] };

function render(query: SQL): RenderedQuery {
  const { sql, params } = dialect.sqlToQuery(query);
  return { sql, params };
}

/** A raw pg `DatabaseError`-shaped error: no `cause`, `code` set directly on the error itself. */
function pgError(code: string, message = 'simulated postgres error'): Error & { code: string } {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  error.name = 'error';
  return error;
}

/**
 * A `db`-shaped executor that records every statement `lockSubmissionProviderCallUser` issues, in
 * order, and answers call N with `behaviors[N]`. A call past the end of `behaviors`, or a behavior
 * never reached, fails the test loudly rather than hanging or silently succeeding.
 */
function fakeExecutor(behaviors: Array<(rendered: RenderedQuery) => unknown>) {
  const calls: RenderedQuery[] = [];
  const execute = async (query: SQL) => {
    const rendered = render(query);
    calls.push(rendered);
    if (calls.length > behaviors.length) {
      throw new Error(`fakeExecutor received an unexpected call #${calls.length}: ${rendered.sql}`);
    }
    const outcome = behaviors[calls.length - 1]!(rendered);
    if (outcome instanceof Error) throw outcome;
    return outcome ?? { rows: [] };
  };
  return { executor: { execute } as unknown as Pick<typeof db, 'execute'>, calls };
}

const USER_ID = 'a3578398-c4cc-4d4d-9a44-c7943d8effb9';

describe('lockSubmissionProviderCallUser: the unbounded call shape is unchanged', () => {
  it('issues exactly one statement - the bare advisory lock - with no options', async () => {
    const { executor, calls } = fakeExecutor([() => ({ rows: [] })]);
    await lockSubmissionProviderCallUser(executor, USER_ID);
    assert.equal(calls.length, 1, 'a caller that passes no options must never touch lock_timeout at all');
    assert.match(calls[0]!.sql, /pg_advisory_xact_lock/);
    assert.deepEqual(calls[0]!.params, [`submission-provider-call:${USER_ID}`]);
  });

  it('issues exactly one statement when options is an empty object', async () => {
    // account.ts's real call site passes no third argument at all; this pins the same behaviour for
    // a caller that explicitly passes `{}`, since both must mean "wait forever" identically.
    const { executor, calls } = fakeExecutor([() => ({ rows: [] })]);
    await lockSubmissionProviderCallUser(executor, USER_ID, {});
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.sql, /pg_advisory_xact_lock/);
  });
});

describe('lockSubmissionProviderCallUser: the bounded form', () => {
  it('on success: sets lock_timeout, acquires the lock, then resets, in that order', async () => {
    const { executor, calls } = fakeExecutor([
      () => ({ rows: [] }), // set_config
      () => ({ rows: [] }), // pg_advisory_xact_lock
      () => ({ rows: [] }), // reset
    ]);
    await lockSubmissionProviderCallUser(executor, USER_ID, { lockTimeoutMs: 240_000 });
    assert.equal(calls.length, 3);
    // Only the timeout value is a bind parameter - 'lock_timeout' and the is_local flag are literal
    // SQL text, since they never vary - so the query text itself is what proves this is SET LOCAL
    // (is_local: true), scoped to the current transaction only, not a session-wide SET.
    assert.match(calls[0]!.sql, /set_config\('lock_timeout', \$1, true\)/);
    assert.deepEqual(calls[0]!.params, ['240000ms']);
    assert.match(calls[1]!.sql, /pg_advisory_xact_lock/);
    assert.deepEqual(calls[1]!.params, [`submission-provider-call:${USER_ID}`]);
    assert.match(calls[2]!.sql, /reset lock_timeout/i);
  });

  it('on a lock_timeout expiry (55P03 wrapped in a DrizzleQueryError.cause), throws the typed error and never attempts a reset', async () => {
    const raw = pgError('55P03', 'canceling statement due to lock timeout');
    const wrapped = new DrizzleQueryError('select pg_advisory_xact_lock(...)', [], raw);
    const { executor, calls } = fakeExecutor([
      () => ({ rows: [] }), // set_config succeeds
      () => wrapped,        // the acquire itself times out
      // no third behavior: a reset attempted here fails the test via the "unexpected call" throw
    ]);
    await assert.rejects(
      lockSubmissionProviderCallUser(executor, USER_ID, { lockTimeoutMs: 5_000 }),
      (error: unknown) => {
        assert.ok(error instanceof SubmissionProviderCallLockTimeoutError);
        assert.equal(error.code, 'SUBMISSION_PROVIDER_CALL_LOCK_TIMEOUT');
        assert.match(error.message, /5000ms/);
        // The underlying pg/Drizzle error must survive as .cause: it is the only way to see what
        // Postgres actually said (detail, hint, the exact statement) if this classification is ever
        // wrong, or if the incident needs confirming without reproducing it.
        assert.equal(error.cause, wrapped);
        return true;
      },
    );
    assert.equal(calls.length, 2, 'a timed-out acquire aborts the transaction; nothing resets on this path');
  });

  it('recognizes a direct (unwrapped) 55P03 with no .cause, not only the wrapped shape', async () => {
    const { executor } = fakeExecutor([
      () => ({ rows: [] }),
      () => pgError('55P03'),
    ]);
    await assert.rejects(
      lockSubmissionProviderCallUser(executor, USER_ID, { lockTimeoutMs: 1_000 }),
      SubmissionProviderCallLockTimeoutError,
    );
  });

  it('recognizes 55P03 nested two levels deep in .cause', async () => {
    const raw = pgError('55P03');
    const middle = new Error('wrapped once');
    (middle as { cause?: unknown }).cause = raw;
    const outer = new DrizzleQueryError('select ...', [], middle);
    const { executor } = fakeExecutor([
      () => ({ rows: [] }),
      () => outer,
    ]);
    await assert.rejects(
      lockSubmissionProviderCallUser(executor, USER_ID, { lockTimeoutMs: 1_000 }),
      SubmissionProviderCallLockTimeoutError,
    );
  });

  it('a self-referential cause chain is walked to a bounded depth, not spun on forever', async () => {
    const a = new Error('a') as Error & { cause?: unknown };
    const b = new Error('b') as Error & { cause?: unknown };
    a.cause = b;
    b.cause = a; // cycle: neither carries 55P03, so this must terminate and rethrow `a` unchanged
    const { executor } = fakeExecutor([
      () => ({ rows: [] }),
      () => a,
    ]);
    await assert.rejects(
      lockSubmissionProviderCallUser(executor, USER_ID, { lockTimeoutMs: 1_000 }),
      (error: unknown) => error === a,
    );
  });

  it('a non-lock Postgres error is rethrown unchanged, never mistaken for a lock timeout', async () => {
    // 40001 is a serialization failure - a real, distinct SQLSTATE this codebase already handles
    // elsewhere (submissionAuthorityRevision.ts) - not the lock-wait timeout this function maps.
    const serializationFailure = pgError('40001', 'could not serialize access');
    const { executor } = fakeExecutor([
      () => ({ rows: [] }),
      () => serializationFailure,
    ]);
    await assert.rejects(
      lockSubmissionProviderCallUser(executor, USER_ID, { lockTimeoutMs: 1_000 }),
      (error: unknown) => error === serializationFailure,
    );
  });

  it('rejects a timeout past the sanity ceiling before ever touching the executor', async () => {
    // Guards specifically against a unit slip (milliseconds mistaken for micro- or nanoseconds)
    // overshooting into a value Postgres's own lock_timeout GUC would otherwise silently accept -
    // and then reject with an out-of-range error this file's 55P03 check would not recognize,
    // producing an unclassified failure instead of either a clean validation error or the intended
    // typed timeout.
    const reached = () => { throw new Error('REACHED_EXECUTOR'); };
    const executor = { execute: reached } as unknown as Pick<typeof db, 'execute'>;
    for (const tooLarge of [10 * 60 * 1000 + 1, 240_000_000, Number.MAX_SAFE_INTEGER]) {
      await assert.rejects(
        lockSubmissionProviderCallUser(executor, USER_ID, { lockTimeoutMs: tooLarge }),
        /positive integer/,
      );
    }
  });

  it('rejects a non-positive or non-integer timeout before ever touching the executor', async () => {
    const reached = () => { throw new Error('REACHED_EXECUTOR'); };
    const executor = { execute: reached } as unknown as Pick<typeof db, 'execute'>;
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await assert.rejects(
        lockSubmissionProviderCallUser(executor, USER_ID, { lockTimeoutMs: bad }),
        /positive integer/,
      );
    }
  });
});

describe('lockSubmissionProviderCallUser: the account-deletion call shape is untouched', () => {
  it('account.ts still calls the unbounded (no options) form', async () => {
    // A source-text pin, not a type check: TypeScript would already refuse a call that no longer
    // fits the signature, but it would happily accept account.ts passing a lockTimeoutMs too - and
    // that is exactly the change that would let account deletion give up on a real in-flight call
    // early, instead of waiting it out, which is the one invariant this fence exists to protect.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const source = readFileSync(join(__dirname, '../routes/account.ts'), 'utf8');
    const calls = [...source.matchAll(/lockSubmissionProviderCallUser\(([^)]*)\)/g)];
    assert.ok(calls.length > 0, 'expected account.ts to still call lockSubmissionProviderCallUser');
    for (const call of calls) {
      assert.match(call[1]!.trim(), /^tx,\s*userId$/,
        `account.ts's deletion drain must call lockSubmissionProviderCallUser with no options (an unbounded wait), found: lockSubmissionProviderCallUser(${call[1]})`);
    }
  });

  it('every OTHER real caller of lockSubmissionProviderCallUser resolves a real bound', async () => {
    /* The completeness check the account.ts pin alone cannot give: that test only proves account.ts
     * stayed unbounded, not that every OTHER caller is bounded - which is exactly how
     * browserProviderResourceCleanup.ts's createFencedBrowserSession shipped as a second, unbounded,
     * undocumented caller of this same key in the first place. This greps the whole src tree so a
     * FOURTH caller added later without a lockTimeoutMs fails here too, rather than silently
     * reintroducing the wedge this file exists to close. */
    const { readFileSync, readdirSync } = await import('node:fs');
    const { join, relative } = await import('node:path');
    const srcRoot = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules') continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(full);
      }
    };
    walk(srcRoot);
    const unboundedCalls: string[] = [];
    const boundedCalls: string[] = [];
    for (const file of files) {
      const relativePath = relative(srcRoot, file);
      if (relativePath === 'routes/account.ts') continue; // covered by its own test above
      const source = readFileSync(file, 'utf8');
      for (const call of source.matchAll(/lockSubmissionProviderCallUser\(([^)]*)\)/g)) {
        const args = call[1]!.trim();
        if (/^tx,\s*userId$/.test(args) || /^executor,\s*userId$/.test(args)) {
          unboundedCalls.push(`${relativePath}: lockSubmissionProviderCallUser(${args})`);
        } else if (/lockTimeoutMs\s*:/.test(args)) {
          boundedCalls.push(relativePath);
        }
        // A definition site (`executor: Pick<...>, userId: string, options...`) matches neither
        // regex and is silently ignored, which is correct - it is not a call.
      }
    }
    assert.deepEqual(unboundedCalls, [],
      'every caller of lockSubmissionProviderCallUser outside account.ts must resolve a real lockTimeoutMs');
    assert.ok(boundedCalls.includes('lib/submissionAccountFence.ts'));
    assert.ok(boundedCalls.includes('lib/browserProviderResourceCleanup.ts'));
  });
});
