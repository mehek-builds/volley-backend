import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaptureBody,
  captureServerEvent,
  deleteAnalyticsProfile,
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

/* ---------------------------------------------------------------------------
 * Analytics profile deletion.
 *
 * The privacy policy promises that deleting a Litos account deletes the linked
 * PostHog profile, so these guard a live promise rather than a nice-to-have.
 *
 * The shape being pinned here was learned the hard way. Deleting by
 * `?distinct_id=` returns 403 "This action does not support personal API key
 * access" no matter what scopes the key carries, so the only route that works
 * is: look the person up, then delete by PostHog's own internal person id.
 * ------------------------------------------------------------------------ */

const ORIGINAL_PERSONAL = process.env.POSTHOG_PERSONAL_API_KEY;
const ORIGINAL_PROJECT = process.env.POSTHOG_PROJECT_ID;

async function withDeletionEnv(
  configured: boolean,
  handler: (url: string, init: RequestInit) => Promise<Response>,
  run: (sent: Sent[]) => Promise<void>,
): Promise<void> {
  const sent: Sent[] = [];
  if (configured) {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_test';
    process.env.POSTHOG_PROJECT_ID = '480194';
  } else {
    delete process.env.POSTHOG_PERSONAL_API_KEY;
    delete process.env.POSTHOG_PROJECT_ID;
  }
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url: String(url), init });
    return handler(String(url), init);
  }) as unknown as typeof fetch;
  try {
    await run(sent);
  } finally {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_PERSONAL === undefined) delete process.env.POSTHOG_PERSONAL_API_KEY;
    else process.env.POSTHOG_PERSONAL_API_KEY = ORIGINAL_PERSONAL;
    if (ORIGINAL_PROJECT === undefined) delete process.env.POSTHOG_PROJECT_ID;
    else process.env.POSTHOG_PROJECT_ID = ORIGINAL_PROJECT;
  }
}

const personFound = async (url: string) =>
  url.includes('distinct_id=')
    ? new Response(JSON.stringify({ results: [{ id: 'person-internal-id' }] }), { status: 200 })
    : new Response('', { status: 202 });

test('deletion looks the person up, then deletes by internal id', async () => {
  await withDeletionEnv(true, personFound, async (sent) => {
    const ok = await deleteAnalyticsProfile('user-uuid');
    assert.equal(ok, true);
    assert.equal(sent.length, 2, 'lookup then delete');

    // Step one reads by distinct_id.
    assert.match(sent[0].url, /\/persons\/\?distinct_id=user-uuid/);
    assert.notEqual(sent[0].init.method, 'DELETE');

    // Step two deletes by the id the lookup returned, and takes the events too.
    assert.equal(sent[1].init.method, 'DELETE');
    assert.match(sent[1].url, /\/persons\/person-internal-id\/\?delete_events=true/);
  });
});

test('deletion never uses the distinct_id DELETE variant, which PostHog refuses', async () => {
  // Regression guard for the exact 403 that shipped: a DELETE whose URL carries
  // distinct_id is the call PostHog rejects for personal API keys regardless of
  // scope, so no request may ever be both at once.
  await withDeletionEnv(true, personFound, async (sent) => {
    await deleteAnalyticsProfile('user-uuid');
    for (const req of sent) {
      const isDelete = req.init.method === 'DELETE';
      assert.ok(
        !(isDelete && req.url.includes('distinct_id=')),
        `DELETE with distinct_id= is the 403 path: ${req.url}`,
      );
    }
  });
});

test('a person with no profile counts as already deleted', async () => {
  await withDeletionEnv(
    true,
    async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    async (sent) => {
      // Anyone who only used the extension, or never signed in, has no profile.
      assert.equal(await deleteAnalyticsProfile('user-uuid'), true);
      assert.equal(sent.length, 1, 'nothing to delete, so no DELETE is sent');
    },
  );
});

test('202 is treated as success, because deletion is queued not immediate', async () => {
  await withDeletionEnv(true, personFound, async () => {
    assert.equal(await deleteAnalyticsProfile('user-uuid'), true);
  });
});

test('a rejected lookup reports failure rather than claiming deletion', async () => {
  const warnings: string[] = [];
  await withDeletionEnv(
    true,
    async () => new Response('nope', { status: 403 }),
    async () => {
      assert.equal(
        await deleteAnalyticsProfile('user-uuid', { warn: (m) => warnings.push(m) }),
        false,
      );
    },
  );
  assert.match(warnings[0], /lookup rejected with 403/);
});

test('a rejected delete reports failure', async () => {
  const warnings: string[] = [];
  await withDeletionEnv(
    true,
    async (url) =>
      url.includes('distinct_id=')
        ? new Response(JSON.stringify({ results: [{ id: 'pid' }] }), { status: 200 })
        : new Response('nope', { status: 500 }),
    async () => {
      assert.equal(
        await deleteAnalyticsProfile('user-uuid', { warn: (m) => warnings.push(m) }),
        false,
      );
    },
  );
  assert.match(warnings[0], /deletion rejected with 500/);
});

test('an unconfigured install says so loudly and does not pretend', async () => {
  const warnings: string[] = [];
  await withDeletionEnv(false, personFound, async (sent) => {
    assert.equal(
      await deleteAnalyticsProfile('user-uuid', { warn: (m) => warnings.push(m) }),
      false,
    );
    assert.equal(sent.length, 0);
  });
  assert.match(warnings[0], /privacy policy promises this deletion/);
});
