import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaptureBody,
  captureServerEvent,
  reportAccountCreated,
  serverAnalyticsEnabled,
} from './serverAnalytics';

/* These tests were rewritten after a review mutation-tested the first version:
 * deleting the entire body of reportAccountCreated, pointing the capture at
 * /TOTALLY-WRONG-ENDPOINT, and flipping POST to GET each left 7/7 passing. The
 * originals asserted things that were true by TypeScript construction
 * (`assert.equal(result, undefined)` on a `: void` function) or true of data the
 * test itself had just written (a no-"@" check on a body built from literals).
 *
 * Every test below now patches fetch and asserts on what was actually sent, so
 * a mutation to the request has somewhere to fail. */

const ORIGINAL_TOKEN = process.env.POSTHOG_PROJECT_TOKEN;
const ORIGINAL_FETCH = globalThis.fetch;

type Sent = { url: string; init: RequestInit };

/** Capture outgoing requests. Always restores fetch, even if the body throws. */
async function withCapturedFetch(
  token: string | undefined,
  respond: () => Promise<Response>,
  run: (sent: Sent[]) => Promise<void>,
): Promise<void> {
  const sent: Sent[] = [];
  if (token === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
  else process.env.POSTHOG_PROJECT_TOKEN = token;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url: String(url), init });
    return respond();
  }) as unknown as typeof fetch;
  try {
    // Awaited inside the try so the restore below cannot run early. The previous
    // helper returned a promise from a sync function, so its `finally` fired at
    // the first suspension point and put the env back before the code under
    // test had read it.
    await run(sent);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_TOKEN === undefined) delete process.env.POSTHOG_PROJECT_TOKEN;
    else process.env.POSTHOG_PROJECT_TOKEN = ORIGINAL_TOKEN;
  }
}

const ok = async () => new Response('{"status":1}', { status: 200 });

test('reportAccountCreated POSTs the event to the capture endpoint', async () => {
  await withCapturedFetch('phc_test', ok, async (sent) => {
    await reportAccountCreated('user-uuid', 'guest');

    assert.equal(sent.length, 1, 'exactly one request should be sent');
    // Mutating the URL or the verb must fail here.
    assert.match(sent[0].url, /\/i\/v0\/e\/$/);
    assert.equal(sent[0].init.method, 'POST');

    const body = JSON.parse(String(sent[0].init.body));
    assert.equal(body.event, 'account_created');
    assert.equal(body.distinct_id, 'user-uuid');
    assert.equal(body.api_key, 'phc_test');
    assert.equal(body.properties.method, 'guest');
    assert.equal(body.properties.is_guest, true);
  });
});

test('the request carries no PII, and suppresses datacenter geolocation', async () => {
  await withCapturedFetch('phc_test', ok, async (sent) => {
    await reportAccountCreated('user-uuid', 'guest');
    const raw = String(sent[0].init.body);
    // The id is opaque by construction, but assert on the wire bytes rather
    // than on a locally built object, so a future property addition that
    // smuggles an address in is caught here.
    assert.ok(!raw.includes('@'), `an address reached the wire: ${raw}`);
    const body = JSON.parse(raw);
    assert.equal(body.properties.$ip, null, '$ip must be null or PostHog geolocates the lambda');
    assert.equal(body.properties.$process_person_profile, true);
  });
});

test('sends nothing at all when the token is not configured', async () => {
  await withCapturedFetch(undefined, ok, async (sent) => {
    assert.equal(serverAnalyticsEnabled(), false);
    await reportAccountCreated('user-uuid', 'guest');
    assert.equal(sent.length, 0, 'an unconfigured install must not call out');
  });
});

test('sends nothing when the user id is empty', async () => {
  await withCapturedFetch('phc_test', ok, async (sent) => {
    await captureServerEvent('account_created', '');
    assert.equal(sent.length, 0);
  });
});

test('a non-Error rejection is swallowed, not rethrown', async () => {
  // The regression that mattered: `(error as Error).name` on a null rejection
  // threw inside the catch. With no unhandledRejection listener in this service
  // that kills the process and every concurrent request on the instance.
  const warnings: string[] = [];
  await withCapturedFetch('phc_test', async () => {
    throw null;
  }, async () => {
    await reportAccountCreated('user-uuid', 'guest', { warn: (m) => warnings.push(m) });
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /account_created failed/);
});

test('a logger that itself throws cannot take the request down', async () => {
  await withCapturedFetch('phc_test', async () => {
    throw new Error('network down');
  }, async () => {
    await reportAccountCreated('user-uuid', 'guest', {
      warn: () => {
        throw new Error('stdout closed');
      },
    });
  });
});

test('an HTTP error is logged, not thrown', async () => {
  const warnings: string[] = [];
  await withCapturedFetch('phc_test', async () => new Response('nope', { status: 503 }), async () => {
    await reportAccountCreated('user-uuid', 'guest', { warn: (m) => warnings.push(m) });
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /503/);
});

test('the call is awaitable and resolves, so a route can block on it safely', async () => {
  await withCapturedFetch('phc_test', ok, async () => {
    const result = reportAccountCreated('user-uuid', 'guest');
    assert.ok(result instanceof Promise, 'routes must be able to await delivery');
    await result;
  });
});

test('reads the token at call time, not at import time', async () => {
  await withCapturedFetch('phc_live', ok, async () => {
    assert.equal(serverAnalyticsEnabled(), true);
  });
  await withCapturedFetch(undefined, ok, async () => {
    assert.equal(serverAnalyticsEnabled(), false);
  });
});

test('an unserialisable property is reported, not thrown', async () => {
  const warnings: string[] = [];
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  await withCapturedFetch('phc_test', ok, async (sent) => {
    await captureServerEvent(
      'account_created',
      'user-uuid',
      circular as never,
      { warn: (m) => warnings.push(m) },
    );
    assert.equal(sent.length, 0);
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /serialised/);
});

test('buildCaptureBody shape stays stable', () => {
  const body = buildCaptureBody('phc_test', 'account_created', 'u', { method: 'guest' });
  assert.equal(body.event, 'account_created');
  assert.equal(body.distinct_id, 'u');
  const props = body.properties as Record<string, unknown>;
  assert.equal(props.surface, 'backend');
  assert.equal(props.$lib, 'litos-backend');
});
