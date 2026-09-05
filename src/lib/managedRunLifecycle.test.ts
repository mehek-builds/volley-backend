/* Registry register/unregister and boundary exclusion, the run_owner identity, the shutdown signal,
 * the accepting-new-work flag, and the acceptance-gate decision function - the bookkeeping half of
 * "a restart does not strand a fill". The actual database release is managedRunRestartRelease.test.ts;
 * this file never touches a database.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  attachManagedRunBoundaryCompletion,
  computeRunOwnerId,
  createManagedRunAcceptanceGateHook,
  getManagedRunShutdownSignal,
  isManagedRunBoundaryReached,
  listInFlightManagedRunBoundaryCompletions,
  listPreBoundaryManagedRuns,
  managedRunAcceptanceDecision,
  managedRunRegistrySize,
  managedRunsAcceptingNewWork,
  markManagedRunBoundaryReached,
  registerManagedRun,
  resetManagedRunRegistryForTests,
  resetManagedRunShutdownSignalForTests,
  triggerManagedRunShutdown,
  unregisterManagedRun,
} from './managedRunLifecycle';

afterEach(() => {
  resetManagedRunRegistryForTests();
  resetManagedRunShutdownSignalForTests();
});

describe('RUN_OWNER_ID / computeRunOwnerId', () => {
  test('is a fresh random identity when Railway supplies no deployment metadata', () => {
    const id = computeRunOwnerId({});
    assert.match(id, /^[0-9a-f-]{36}$/, 'bare env falls back to a lone UUID');
  });

  test('carries the deployment id and replica id ahead of the random component, colon-joined', () => {
    const id = computeRunOwnerId({ RAILWAY_DEPLOYMENT_ID: 'deploy-123', RAILWAY_REPLICA_ID: 'replica-7' });
    assert.match(id, /^deploy-123:replica-7:[0-9a-f-]{36}$/);
  });

  test('tolerates a deployment id with no replica id', () => {
    const id = computeRunOwnerId({ RAILWAY_DEPLOYMENT_ID: 'deploy-only' });
    assert.match(id, /^deploy-only:[0-9a-f-]{36}$/);
  });

  test('two calls never collide, even with identical Railway metadata', () => {
    const env = { RAILWAY_DEPLOYMENT_ID: 'same-deploy' };
    assert.notEqual(computeRunOwnerId(env), computeRunOwnerId(env));
  });

  test('blank Railway values are treated as absent, not as empty segments', () => {
    const id = computeRunOwnerId({ RAILWAY_DEPLOYMENT_ID: '  ', RAILWAY_REPLICA_ID: '' });
    assert.match(id, /^[0-9a-f-]{36}$/);
  });
});

describe('the registry', () => {
  test('starts empty', () => {
    assert.equal(managedRunRegistrySize(), 0);
    assert.deepEqual(listPreBoundaryManagedRuns(), []);
  });

  test('register then unregister leaves no trace', () => {
    const token = registerManagedRun({ packetId: 'packet-1', userId: 'user-1' });
    assert.equal(managedRunRegistrySize(), 1);
    unregisterManagedRun('packet-1', token);
    assert.equal(managedRunRegistrySize(), 0);
    assert.deepEqual(listPreBoundaryManagedRuns(), []);
  });

  test('unregistering a packet that was never registered is a harmless no-op', () => {
    assert.doesNotThrow(() => unregisterManagedRun('never-registered', 'some-token'));
    assert.equal(managedRunRegistrySize(), 0);
  });

  test('unregistering with a stale token - a second registration for the same packet already overwrote it - is a harmless no-op', () => {
    /* THE RACE ITEM 3 CLOSES. Two concurrent invocations for one packet used to clobber each other:
     * whichever unregistered FIRST deleted by packetId alone, regardless of which registration it
     * actually belonged to, so the SURVIVING run's own later unregister found nothing to do to
     * (already deleted) - or worse, the second registration itself could be deleted out from under
     * a run that was still executing. Requiring the caller's own token to still match closes that:
     * a stale token can never delete a live, later registration. */
    const staleToken = registerManagedRun({ packetId: 'packet-1', userId: 'user-1' });
    const liveToken = registerManagedRun({ packetId: 'packet-1', userId: 'user-1' });
    assert.notEqual(staleToken, liveToken, 'two registrations for the same packet must never share a token');
    unregisterManagedRun('packet-1', staleToken);
    assert.equal(managedRunRegistrySize(), 1, 'the live registration must survive an unregister carrying a stale token');
    unregisterManagedRun('packet-1', liveToken);
    assert.equal(managedRunRegistrySize(), 0, 'the live registration is removable by its own token');
  });

  test('re-registering the same packet replaces the earlier entry rather than duplicating it', () => {
    registerManagedRun({ packetId: 'packet-1', userId: 'user-1', runId: 'run-a' });
    registerManagedRun({ packetId: 'packet-1', userId: 'user-1', runId: 'run-b' });
    assert.equal(managedRunRegistrySize(), 1);
    assert.equal(listPreBoundaryManagedRuns()[0]!.runId, 'run-b', 'the later registration wins');
  });

  test('a run starts pre-boundary and appears in listPreBoundaryManagedRuns', () => {
    registerManagedRun({ packetId: 'packet-1', userId: 'user-1', runId: 'run-1' });
    const listed = listPreBoundaryManagedRuns();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.packetId, 'packet-1');
    assert.equal(listed[0]!.userId, 'user-1');
    assert.equal(listed[0]!.runId, 'run-1');
    assert.equal(listed[0]!.boundaryReached, false);
  });

  test('markManagedRunBoundaryReached excludes a run from the pre-boundary worklist without removing it from the registry', () => {
    registerManagedRun({ packetId: 'packet-1', userId: 'user-1' });
    markManagedRunBoundaryReached('packet-1');
    assert.equal(managedRunRegistrySize(), 1, 'still tracked - just not a release candidate');
    assert.deepEqual(listPreBoundaryManagedRuns(), []);
  });

  test('marking boundary reached on an unregistered packet is a harmless no-op', () => {
    assert.doesNotThrow(() => markManagedRunBoundaryReached('never-registered'));
  });

  test('listPreBoundaryManagedRuns mixes correctly: only the pre-boundary entries come back', () => {
    registerManagedRun({ packetId: 'packet-1', userId: 'user-1' });
    registerManagedRun({ packetId: 'packet-2', userId: 'user-1' });
    registerManagedRun({ packetId: 'packet-3', userId: 'user-2' });
    markManagedRunBoundaryReached('packet-3');
    const listed = listPreBoundaryManagedRuns().map((entry) => entry.packetId).sort();
    assert.deepEqual(listed, ['packet-1', 'packet-2']);
  });

  test('isManagedRunBoundaryReached is false for a fresh registration, true once marked, and false for an absent packet', () => {
    registerManagedRun({ packetId: 'packet-1', userId: 'user-1' });
    assert.equal(isManagedRunBoundaryReached('packet-1'), false);
    markManagedRunBoundaryReached('packet-1');
    assert.equal(isManagedRunBoundaryReached('packet-1'), true);
    assert.equal(isManagedRunBoundaryReached('never-registered'), false,
      'an absent registration defaults to "not yet at the boundary", never the reverse');
  });

  test('attachManagedRunBoundaryCompletion is a no-op before the boundary is marked reached', () => {
    registerManagedRun({ packetId: 'packet-1', userId: 'user-1' });
    attachManagedRunBoundaryCompletion('packet-1', Promise.resolve('never should be tracked'));
    assert.deepEqual(listInFlightManagedRunBoundaryCompletions(), [],
      'nothing before the employer boundary is ever worth blocking a shutdown for');
  });

  test('attachManagedRunBoundaryCompletion is a no-op for a packet the registry has no entry for', () => {
    assert.doesNotThrow(() => attachManagedRunBoundaryCompletion('never-registered', Promise.resolve()));
    assert.deepEqual(listInFlightManagedRunBoundaryCompletions(), []);
  });

  test('listInFlightManagedRunBoundaryCompletions surfaces exactly the boundary-reached runs with an attached completion', async () => {
    registerManagedRun({ packetId: 'packet-1', userId: 'user-1' });
    registerManagedRun({ packetId: 'packet-2', userId: 'user-2' });
    registerManagedRun({ packetId: 'packet-3', userId: 'user-3' });
    markManagedRunBoundaryReached('packet-2');
    markManagedRunBoundaryReached('packet-3');
    // packet-2 is boundary-reached but has no attached completion yet (e.g. submit() has been
    // marked but its own promise has not been created) - it must not appear.
    const completion = Promise.resolve('reconciled');
    attachManagedRunBoundaryCompletion('packet-3', completion);
    const waits = listInFlightManagedRunBoundaryCompletions();
    assert.equal(waits.length, 1);
    assert.equal(waits[0]!.packetId, 'packet-3');
    assert.equal(waits[0]!.userId, 'user-3');
    assert.equal(await waits[0]!.promise, 'reconciled');
  });
});

describe('the shutdown signal', () => {
  test('starts un-aborted', () => {
    assert.equal(getManagedRunShutdownSignal().aborted, false);
  });

  test('triggerManagedRunShutdown aborts the signal every later caller reads', () => {
    const signal = getManagedRunShutdownSignal();
    assert.equal(signal.aborted, false);
    triggerManagedRunShutdown();
    assert.equal(signal.aborted, true);
    // The SAME signal object aborts - a caller that read it before shutdown still observes it.
    assert.equal(getManagedRunShutdownSignal(), signal);
  });

  test('is idempotent: a second trigger does not throw', () => {
    triggerManagedRunShutdown();
    assert.doesNotThrow(() => triggerManagedRunShutdown());
    assert.equal(getManagedRunShutdownSignal().aborted, true);
  });
});

describe('accepting new work', () => {
  test('starts true', () => {
    assert.equal(managedRunsAcceptingNewWork(), true);
  });

  test('derives from the shutdown signal: triggering shutdown flips it, permanently for the process lifetime', () => {
    /* Item 4: there is no separate accepting-flag any more - managedRunsAcceptingNewWork() reads
     * getManagedRunShutdownSignal().aborted directly, so the only way to flip it is the same call
     * that aborts every in-flight stratus fetch. */
    triggerManagedRunShutdown();
    assert.equal(managedRunsAcceptingNewWork(), false);
  });
});

describe('managedRunAcceptanceDecision', () => {
  test('never refuses anything while accepting new work', () => {
    assert.equal(managedRunAcceptanceDecision(true, 'POST', '/applications/managed-prepare'), null);
    assert.equal(managedRunAcceptanceDecision(true, 'POST', '/applications/abc-123/submit-request'), null);
  });

  test('refuses POST /applications/managed-prepare once shutting down', () => {
    const decision = managedRunAcceptanceDecision(false, 'POST', '/applications/managed-prepare');
    assert.deepEqual(decision, { code: 'MANAGED_RUN_SHUTDOWN', retry_after_seconds: 5 });
  });

  test('refuses POST /applications/:id/submit-request for any id shape, once shutting down', () => {
    for (const id of ['abc-123', '11111111-1111-4111-8111-111111111111']) {
      const decision = managedRunAcceptanceDecision(false, 'POST', `/applications/${id}/submit-request`);
      assert.deepEqual(decision, { code: 'MANAGED_RUN_SHUTDOWN', retry_after_seconds: 5 });
    }
  });

  test('leaves every other application route alone while shutting down', () => {
    assert.equal(managedRunAcceptanceDecision(false, 'GET', '/applications/board'), null);
    assert.equal(managedRunAcceptanceDecision(false, 'GET', '/applications/abc-123/submission'), null);
    assert.equal(managedRunAcceptanceDecision(false, 'PUT', '/applications/abc-123/review/answers'), null);
    assert.equal(managedRunAcceptanceDecision(false, 'POST', '/applications/abc-123/submission/approve'), null);
  });

  test('leaves GET on the two protected paths alone - only POST starts a new run', () => {
    assert.equal(managedRunAcceptanceDecision(false, 'GET', '/applications/managed-prepare'), null);
    assert.equal(managedRunAcceptanceDecision(false, 'GET', '/applications/abc-123/submit-request'), null);
  });

  test('is case-insensitive on method and normalizes a trailing query string', () => {
    const decision = managedRunAcceptanceDecision(false, 'post', '/applications/managed-prepare?x=1');
    assert.deepEqual(decision, { code: 'MANAGED_RUN_SHUTDOWN', retry_after_seconds: 5 });
  });

  test('never matches an unrelated route that merely contains the same suffix', () => {
    assert.equal(managedRunAcceptanceDecision(false, 'POST', '/other/submit-request'), null);
    assert.equal(managedRunAcceptanceDecision(false, 'POST', '/applications/managed-prepare/extra'), null);
  });
});

describe('createManagedRunAcceptanceGateHook', () => {
  /* A plain mutable record, read back by reference AFTER the hook runs - never destructured with a
   * `...rest` spread, which would copy today's value out of the getters this used to have instead
   * of tracking the mutation the hook makes through `reply`. */
  interface FakeReplyResult {
    statusCode?: number;
    headers: Record<string, string>;
    body?: unknown;
  }

  function fakeReply(): { reply: unknown; result: FakeReplyResult } {
    const result: FakeReplyResult = { headers: {} };
    const reply = {
      header(name: string, value: string) { result.headers[name] = value; return reply; },
      status(code: number) { result.statusCode = code; return reply; },
      send(payload: unknown) { result.body = payload; return reply; },
    };
    return { reply, result };
  }

  test('sends a typed 503 for a refused request', async () => {
    triggerManagedRunShutdown();
    const hook = createManagedRunAcceptanceGateHook();
    const { reply, result } = fakeReply();
    await hook(
      { raw: { url: '/applications/managed-prepare' }, method: 'POST' } as any,
      reply as any,
    );
    assert.equal(result.statusCode, 503);
    assert.equal(result.headers['Retry-After'], '5');
    assert.equal(result.headers['Cache-Control'], 'no-store');
    assert.deepEqual(result.body, {
      error: 'Litos is restarting and cannot start a new managed run right now. Try again in a few seconds.',
      code: 'MANAGED_RUN_SHUTDOWN',
      retry_after_seconds: 5,
    });
  });

  test('does nothing at all for an unrelated request', async () => {
    triggerManagedRunShutdown();
    const hook = createManagedRunAcceptanceGateHook();
    const { reply, result } = fakeReply();
    await hook(
      { raw: { url: '/health' }, method: 'GET' } as any,
      reply as any,
    );
    assert.equal(result.statusCode, undefined);
    assert.equal(result.body, undefined);
  });

  test('does nothing while still accepting new work', async () => {
    const hook = createManagedRunAcceptanceGateHook();
    const { reply, result } = fakeReply();
    await hook(
      { raw: { url: '/applications/managed-prepare' }, method: 'POST' } as any,
      reply as any,
    );
    assert.equal(result.statusCode, undefined);
  });
});
