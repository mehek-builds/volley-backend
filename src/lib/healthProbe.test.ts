import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  DATABASE_PROBE_TIMEOUT_MS,
  classifyDatabaseError,
  healthStatusCode,
  probeDatabase,
  probeModel,
} from './healthProbe';

/**
 * THE SIGNAL THE 2026-08-04 OUTAGE DID NOT HAVE.
 *
 * Neon refused every connection for ~75 minutes and the public board was down. `/health` answered
 * 200 the entire time because it read environment variables and a clock. Any monitor pointed at it
 * saw a healthy service; the first real signal was a CI job failing on an unrelated pull request.
 *
 * These tests pin the properties that make the probe useful DURING an incident rather than only
 * after one, and each corresponds to a way the fix could make things worse than the bug.
 */

describe('probeDatabase', () => {
  test('a working database is ok', async () => {
    const health = await probeDatabase(async () => [{ '?column?': 1 }]);
    assert.equal(health.status, 'ok');
  });

  test('a refused connection is reported, never thrown', async () => {
    // The whole point. If the probe threw, a degraded database would break the one endpoint you
    // need answering during an incident.
    const health = await probeDatabase(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.1:5432');
    });
    assert.equal(health.status, 'unreachable');
    if (health.status === 'unreachable') assert.equal(health.reason, 'refused');
  });

  test('the exact Neon quota error is recognised as quota, not a generic error', async () => {
    // Verbatim from the incident. At the HTTP layer this is indistinguishable from any other
    // connection failure, and knowing it instantly is the difference between reading a billing page
    // and debugging a query.
    const health = await probeDatabase(async () => {
      throw new Error('Your project has exceeded the data transfer quota. Upgrade your plan to increase limits.');
    });
    assert.equal(health.status, 'unreachable');
    if (health.status === 'unreachable') assert.equal(health.reason, 'quota');
  });

  test('a hanging database times out rather than hanging the health check', async () => {
    // A refused connection fails fast; a saturated one does not. A health check that hangs looks
    // exactly like a service that is down, and takes a monitor's timeout to say nothing useful.
    const started = Date.now();
    const health = await probeDatabase(() => new Promise(() => {}), 40);
    assert.equal(health.status, 'unreachable');
    if (health.status === 'unreachable') assert.equal(health.reason, 'timeout');
    assert.ok(Date.now() - started < 1_000, 'must return promptly, not wait on the hung query');
  });

  test('a rejection that is not an Error is still handled', async () => {
    // Drivers and wrappers throw strings, objects and undefined. Any of those must not escape.
    for (const thrown of ['boom', { code: 42 }, undefined, null]) {
      const health = await probeDatabase(async () => {
        throw thrown;
      });
      assert.equal(health.status, 'unreachable', `threw ${String(thrown)}`);
    }
  });

  test('the timeout clears a cold start but still beats a monitor', () => {
    // Both ends matter, and the lower one is the bug that was actually shipped for a few minutes.
    // Measured against production 2026-08-04: a Neon compute waking from its 5-minute autosuspend
    // answered in 1,647 ms, warm connections in ~205 ms. At the original 2,000 ms the margin over a
    // real cold start was ~350 ms, so a healthy-but-asleep database would have reported unreachable.
    // A health check that cries wolf gets muted, which is the original bug from the other side.
    assert.ok(DATABASE_PROBE_TIMEOUT_MS >= 4_000, 'must clear a ~1.6s cold start with real margin');
    assert.ok(DATABASE_PROBE_TIMEOUT_MS <= 10_000, 'must still answer before a monitor gives up');
  });

  test('a slow but successful query is still ok', async () => {
    const health = await probeDatabase(
      () => new Promise((resolve) => setTimeout(() => resolve([1]), 5)),
      500,
    );
    assert.equal(health.status, 'ok');
  });
});

describe('classifyDatabaseError', () => {
  test('categories are coarse on purpose, so nothing internal reaches a public endpoint', () => {
    assert.equal(classifyDatabaseError(new Error('exceeded the data transfer quota')), 'quota');
    assert.equal(classifyDatabaseError(new Error('connect ECONNREFUSED')), 'refused');
    assert.equal(classifyDatabaseError(new Error('terminating connection due to administrator command')), 'refused');
    assert.equal(classifyDatabaseError(new Error('query timeout exceeded')), 'quota'); // "exceeded" wins, still not 'ok'
    assert.equal(classifyDatabaseError(new Error('something nobody predicted')), 'error');
    assert.equal(classifyDatabaseError(undefined), 'error');
  });

  test('a hostname or role never becomes the category', () => {
    // The reason field is public. It must be one of four fixed strings, never the driver's text.
    const reason = classifyDatabaseError(
      new Error('password authentication failed for user "neondb_owner" at ep-royal-butterfly.aws.neon.tech'),
    );
    assert.ok(['timeout', 'quota', 'refused', 'error'].includes(reason));
    assert.equal(reason, 'error');
  });
});

describe('healthStatusCode', () => {
  test('unreachable is 503, so a monitor and a load balancer both read it correctly', () => {
    assert.equal(healthStatusCode({ status: 'ok', ms: 3 }), 200);
    assert.equal(healthStatusCode({ status: 'unreachable', ms: 3, reason: 'quota' }), 503);
  });
});

/* THE MODEL PROBE, added after the 2026-08-15 credit exhaustion. /health answered 200 through an
 * incident in which no student could get past the first screen of onboarding, because the only
 * dependency it measured was the database and the database was fine. */
describe('probeModel', () => {
  const apiError = (status: number, message: string) => Object.assign(new Error(message), { status });

  test('a served call is ok', async () => {
    const health = await probeModel(async () => undefined);
    assert.equal(health.status, 'ok');
  });

  test('the incident: an exhausted balance reports credit, not a generic error', async () => {
    const health = await probeModel(async () => {
      throw apiError(400, '400 {"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}');
    });
    assert.equal(health.status, 'unavailable');
    assert.equal(health.status === 'unavailable' && health.reason, 'credit');
  });

  test('a revoked key and a capacity incident are told apart', async () => {
    const auth = await probeModel(async () => { throw apiError(401, 'authentication_error'); });
    const busy = await probeModel(async () => { throw apiError(529, 'overloaded_error'); });
    assert.equal(auth.status === 'unavailable' && auth.reason, 'auth');
    assert.equal(busy.status === 'unavailable' && busy.reason, 'overloaded');
  });

  test('a missing key is configuration, not an incident', async () => {
    let called = false;
    const health = await probeModel(async () => { called = true; }, { configured: false });
    assert.equal(health.status, 'not_configured');
    assert.equal(called, false, 'a probe with no key must not attempt a call');
  });

  test('a hanging provider times out rather than hanging the health endpoint', async () => {
    const health = await probeModel(() => new Promise(() => {}), { timeoutMs: 10 });
    assert.equal(health.status, 'unavailable');
    assert.equal(health.status === 'unavailable' && health.reason, 'timeout');
  });

  test('the probe never throws, whatever comes out of the call', async () => {
    for (const thrown of ['a string', null, undefined, { weird: true }]) {
      const health = await probeModel(async () => { throw thrown; });
      assert.equal(health.status, 'unavailable', 'a probe that throws breaks the page you need in an incident');
    }
  });
});
