import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaptureBody,
  captureServerEvent,
  reportAccountCreated,
  serverAnalyticsEnabled,
} from './serverAnalytics';

const ORIGINAL_TOKEN = process.env.POSTHOG_PROJECT_TOKEN;

function withToken(value: string | undefined, run: () => void | Promise<void>) {
  if (value === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
  else process.env.POSTHOG_PROJECT_TOKEN = value;
  try {
    return run();
  } finally {
    if (ORIGINAL_TOKEN === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
    else process.env.POSTHOG_PROJECT_TOKEN = ORIGINAL_TOKEN;
  }
}

test('the body carries the user id as distinct_id, and no PII', () => {
  const body = buildCaptureBody('phc_test', 'account_created', 'user-uuid', {
    method: 'guest',
    is_guest: true,
  });
  assert.equal(body.event, 'account_created');
  assert.equal(body.distinct_id, 'user-uuid');
  const props = body.properties as Record<string, unknown>;
  assert.equal(props.method, 'guest');
  assert.equal(props.surface, 'backend');
  // The whole point of the server-side id is that it joins to the site's
  // identify call. An email here would leak PII to a third party AND break
  // the join, since the site identifies by uuid.
  assert.ok(!JSON.stringify(body).includes('@'));
});

test('is disabled, and silent, when the token is not configured', async () => {
  await withToken(undefined, async () => {
    assert.equal(serverAnalyticsEnabled(), false);
    // Must resolve without throwing and without attempting a request. If this
    // ever tried to fetch, it would hang the auth route it is called from.
    await captureServerEvent('account_created', 'user-uuid', { method: 'guest' });
  });
});

test('reads the token at call time, not at import time', () => {
  withToken('phc_live', () => assert.equal(serverAnalyticsEnabled(), true));
  withToken(undefined, () => assert.equal(serverAnalyticsEnabled(), false));
});

test('a dead analytics endpoint never surfaces as a failed sign-in', async () => {
  const warnings: string[] = [];
  await withToken('phc_test', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    try {
      // Resolving rather than rejecting IS the assertion: the auth route calls
      // this without awaiting, and an unhandled rejection would take the
      // process down on some Node configurations.
      await captureServerEvent(
        'account_created',
        'user-uuid',
        { method: 'guest' },
        { warn: (m) => warnings.push(m) },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /account_created/);
});

test('an HTTP error is logged, not thrown', async () => {
  const warnings: string[] = [];
  await withToken('phc_test', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('nope', { status: 503 })) as typeof fetch;
    try {
      await captureServerEvent('account_created', 'u', {}, { warn: (m) => warnings.push(m) });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /503/);
});

test('reportAccountCreated does not return a promise the caller must handle', () => {
  withToken(undefined, () => {
    const result = reportAccountCreated('user-uuid', 'guest');
    assert.equal(result, undefined);
  });
});

test('an empty user id sends nothing', async () => {
  await withToken('phc_test', async () => {
    let called = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    try {
      await captureServerEvent('account_created', '');
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(called, false);
  });
});
