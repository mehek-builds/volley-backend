import assert from 'node:assert/strict';
import test from 'node:test';
import {
  browserSessionBody,
  continueManagedBrowser,
  isBrowserbaseConfigured,
  MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
  managedApplicationSubmitOptions,
  managedContinuationFingerprint,
  runManagedBrowser,
} from './browserbase';
import { observeManagedReceiptOnce } from './managedSubmitOutcome';
import { buildManagedDiscoveryActions, buildManagedPortalActions } from './portalSubmission';

function assertStratusSafeActions(actions: Array<Record<string, unknown>>) {
  for (const action of actions) {
    assert.equal(typeof action.selector, 'string', JSON.stringify(action));
    assert.ok(String(action.selector).trim().length > 0, JSON.stringify(action));
    assert.ok(String(action.selector).length <= 500, JSON.stringify(action));
    assert.doesNotMatch(String(action.selector), /:right-of|:below|:is\(/);
  }
}

test('Browserbase configuration requires only the current API key', () => {
  const previousKey = process.env.BROWSERBASE_API_KEY;
  const previousProject = process.env.BROWSERBASE_PROJECT_ID;
  delete process.env.BROWSERBASE_API_KEY;
  process.env.BROWSERBASE_PROJECT_ID = 'legacy-project';
  assert.equal(isBrowserbaseConfigured(), false);
  process.env.BROWSERBASE_API_KEY = 'test-key';
  delete process.env.BROWSERBASE_PROJECT_ID;
  assert.equal(isBrowserbaseConfigured(), true);
  if (previousKey === undefined) delete process.env.BROWSERBASE_API_KEY;
  else process.env.BROWSERBASE_API_KEY = previousKey;
  if (previousProject === undefined) delete process.env.BROWSERBASE_PROJECT_ID;
  else process.env.BROWSERBASE_PROJECT_ID = previousProject;
});

test('managed continuation evidence is stable, bounded, and rejects invalid tokens', () => {
  const token = 'A'.repeat(43);
  assert.match(managedContinuationFingerprint(token), /^[a-f0-9]{24}$/);
  assert.equal(managedContinuationFingerprint(token), managedContinuationFingerprint(token));
  assert.notEqual(managedContinuationFingerprint(token), managedContinuationFingerprint('B'.repeat(43)));
  assert.throws(() => managedContinuationFingerprint('too-short'), /continuation token is invalid/);
});

test('session body disables CAPTCHA solving and restricts navigation to the portal host', () => {
  assert.deepEqual(browserSessionBody('context-1', 'https://boards.greenhouse.io/acme/jobs/123'), {
    keepAlive: true,
    browserSettings: {
      context: { id: 'context-1', persist: true },
      allowedDomains: ['boards.greenhouse.io'],
      solveCaptchas: false,
    },
  });
});

test('legacy project ID remains optional and compatible', () => {
  assert.deepEqual(browserSessionBody('context-1', 'https://jobs.lever.co/acme/123', 'project-1'), {
    projectId: 'project-1',
    keepAlive: true,
    browserSettings: {
      context: { id: 'context-1', persist: true },
      allowedDomains: ['jobs.lever.co'],
      solveCaptchas: false,
    },
  });
});

test('Stratus session body preserves the browser identity and pauses on protection challenges', () => {
  assert.deepEqual(
    browserSessionBody('context-1', 'https://jobs.ashbyhq.com/acme/123', undefined, 'stratus'),
    {
      keepAlive: true,
      timeout: 3600,
      contextId: 'context-1',
      browserSettings: {
        protectionPolicy: {
          allowedHosts: ['jobs.ashbyhq.com'],
          minNavigationIntervalMs: 1000,
          challengeBehavior: 'pause',
          captureEvidence: true,
        },
      },
    },
  );
});

test('Stratus configuration accepts its provider-specific API key', () => {
  const previousProvider = process.env.BROWSER_PROVIDER;
  const previousStratusKey = process.env.STRATUS_API_KEY;
  const previousBrowserKey = process.env.BROWSER_API_KEY;
  process.env.BROWSER_PROVIDER = 'stratus';
  process.env.STRATUS_API_KEY = 'test-stratus-key';
  delete process.env.BROWSER_API_KEY;
  assert.equal(isBrowserbaseConfigured(), true);
  if (previousProvider === undefined) delete process.env.BROWSER_PROVIDER;
  else process.env.BROWSER_PROVIDER = previousProvider;
  if (previousStratusKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousStratusKey;
  if (previousBrowserKey === undefined) delete process.env.BROWSER_API_KEY;
  else process.env.BROWSER_API_KEY = previousBrowserKey;
});

test('managed Stratus accepts a short-lived OIDC token without production environment secrets', () => {
  const previousProvider = process.env.BROWSER_PROVIDER;
  const previousStratusKey = process.env.STRATUS_API_KEY;
  const previousStratusUrl = process.env.STRATUS_BASE_URL;
  const previousVercelEnv = process.env.VERCEL_ENV;
  const previousOidcToken = process.env.VERCEL_OIDC_TOKEN;
  process.env.BROWSER_PROVIDER = 'stratus-managed';
  delete process.env.STRATUS_API_KEY;
  process.env.STRATUS_BASE_URL = 'https://stratus-browser-cloud.vercel.app';
  delete process.env.VERCEL_OIDC_TOKEN;
  assert.equal(isBrowserbaseConfigured(), false);
  process.env.VERCEL_OIDC_TOKEN = 'header.payload.signature';
  assert.equal(isBrowserbaseConfigured(), true);
  delete process.env.VERCEL_OIDC_TOKEN;
  process.env.VERCEL_ENV = 'production';
  assert.equal(isBrowserbaseConfigured(), true);
  delete process.env.VERCEL_ENV;
  process.env.STRATUS_API_KEY = 'private-key';
  assert.equal(isBrowserbaseConfigured(), true);
  if (previousProvider === undefined) delete process.env.BROWSER_PROVIDER;
  else process.env.BROWSER_PROVIDER = previousProvider;
  if (previousStratusKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousStratusKey;
  if (previousStratusUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousStratusUrl;
  if (previousVercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = previousVercelEnv;
  if (previousOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
  else process.env.VERCEL_OIDC_TOKEN = previousOidcToken;
});

test('managed Stratus posts bounded actions to the private production run endpoint', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let captured: { url?: string; key?: string | null; body?: unknown } = {};
  globalThis.fetch = (async (input, init) => {
    captured = {
      url: String(input),
      key: new Headers(init?.headers).get('X-Stratus-API-Key'),
      body: JSON.parse(String(init?.body)),
    };
    return new Response(JSON.stringify({ run: { title: 'Complete', url: 'https://portal.example/complete', text: 'Thank you' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  const result = await runManagedBrowser('https://portal.example/apply', [{ type: 'fill', selector: '#email', value: 'person@example.com' }]);
  assert.equal(result.title, 'Complete');
  assert.equal(captured.url, 'https://stratus.example/api/run');
  assert.equal(captured.key, 'private-key');
  assert.deepEqual(captured.body, {
    url: 'https://portal.example/apply',
    actions: [{ type: 'fill', selector: '#email', value: 'person@example.com' }],
    screenshot: true,
    // A caller that says nothing gets a run that CANNOT submit. Asserted on the wire, not on the
    // option object, because the default has to survive the serialization to be worth anything, and
    // because this is the line that would have stopped a fill run putting three real applications in
    // front of three real employers on 2026-08-08.
    allowSubmit: false,
    fullPage: true,
    waitUntil: 'domcontentloaded',
  });
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('managed Stratus continuation sends an opaque token and actions without reopening a URL', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ run: { title: 'Complete', url: 'https://portal.example/complete', text: 'Thank you' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await runManagedBrowser('https://portal.example/apply', [], {
    requestContinuation: true,
    continuationTtlSeconds: 500,
  });
  await continueManagedBrowser('a'.repeat(43), [{ type: 'click', selector: '#verify' }]);

  assert.equal(requests[0].requestContinuation, true);
  assert.equal(requests[0].continuationTtlSeconds, 120);
  assert.equal(requests[1].continuationToken, 'a'.repeat(43));
  assert.equal('url' in requests[1], false);
  assert.equal('requestContinuation' in requests[1], false);

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

/* THE RUNNER'S OWN RULE, COPIED RATHER THAN INVENTED.
 *
 * The fake server this test used to carry offered a continuation only when continuationCheckpoint
 * was true, so it encoded the caller's assumption as the fixture and could never have contradicted
 * it. These three lines are transcribed from merged Stratus, stratus-browser-cloud@48ea9b5
 * src/managed-browser.js:3414-3443, and they are what makes the assertions below mean anything.
 */
function stratusContinuation(body: Record<string, unknown>, submitOutcome: { pressed: boolean; state: string }) {
  const humanVerification = null;
  const pressedUnknown = submitOutcome.pressed === true && submitOutcome.state === 'unknown';
  const receiptObservationOnly = pressedUnknown && !humanVerification && body.continuationCheckpoint !== true;
  const continuationOffered = body.requestContinuation === true
    && (Boolean(humanVerification) || body.continuationCheckpoint === true || pressedUnknown);
  const windowSeconds = receiptObservationOnly
    ? 15
    : Math.max(Number(body.continuationTtlSeconds) || 0, 15);
  return { continuationOffered, windowSeconds };
}

test('a pressed-unknown receipt reaches its one read-only observer with no checkpoint flag', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  const applicationUrl = 'https://jobs.ashbyhq.com/kos/software-engineer-intern/application';
  const token = 'receipt_checkpoint_token_abcdefghijklmnopqrstuvwxyz';
  const startedAt = Date.parse('2026-08-11T12:00:00.000Z');
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];

  try {
    globalThis.fetch = (async (input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), body });
      if (!('continuationToken' in body)) {
        const submitOutcome = {
          pressed: true,
          state: 'unknown' as const,
          source: null,
          evidence: null,
          message: null,
          formStillPresent: true,
        };
        const { continuationOffered, windowSeconds } = stratusContinuation(body, submitOutcome);
        return new Response(JSON.stringify({
          run: {
            title: 'Application',
            url: applicationUrl,
            text: 'Submit Application',
            screenshot: 'initial-image',
            continuationOffered,
            ...(continuationOffered
              ? {
                continuationToken: token,
                continuationExpiresAt: new Date(startedAt + windowSeconds * 1000).toISOString(),
              }
              : {}),
            humanVerification: null,
            submitOutcome,
          },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        run: {
          title: 'Application submitted',
          url: applicationUrl,
          text: 'Thank you for submitting your application.',
          screenshot: 'observed-image',
          humanVerification: null,
          submitOutcome: {
            pressed: true,
            state: 'confirmed',
            source: 'ats_state',
            evidence: '.ashby-application-form-success-container',
            message: 'Thank you for submitting your application.',
            formStillPresent: false,
          },
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    // The exact options a real managed application submit sends, not a hand-written approximation.
    const initial = await runManagedBrowser(applicationUrl, [], managedApplicationSubmitOptions(120));
    assert.equal(initial.humanVerification, null);
    assert.equal(initial.continuationOffered, true,
      'pressedUnknown alone offers the continuation, which is what the checkpoint flag was added for');
    assert.equal(initial.continuationExpiresAt, '2026-08-11T12:00:15.000Z',
      'and without the flag the held employer page keeps its deliberate 15 second observation cap');

    const observation = await observeManagedReceiptOnce({
      initial,
      expectedApplicationUrl: applicationUrl,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: (continuationToken) => continueManagedBrowser(continuationToken, [], { screenshot: true }),
    });

    assert.equal(observation.attempted, true);
    assert.equal(observation.receiptResult.submitOutcome?.state, 'confirmed');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body.requestContinuation, true);
    assert.equal(requests[0].body.continuationCheckpoint, false);
    assert.equal(requests[1].body.continuationToken, token);
    assert.deepEqual(requests[1].body.actions, []);
    assert.equal('url' in requests[1].body, false);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

/* THE SANDBOX LEAK, STATED AS THE RULE IT BREAKS.
 *
 * continuationEligible returns continuationOffered verbatim, and an eligible result sets keepAlive,
 * which skips sandbox.stop() in the finally. So a checkpoint on every managed submit meant a held
 * sandbox after every CONFIRMED, REJECTED and NOT_ATTEMPTED one too, each idling out a continuation
 * that was never going to be spent. Nothing about those outcomes needs a second look.
 */
test('a terminal managed submit outcome offers no continuation once the checkpoint flag is gone', () => {
  const sent = managedApplicationSubmitOptions(120) as Record<string, unknown>;
  assert.equal('continuationCheckpoint' in sent, false, 'the flag rested on a false premise');
  assert.deepEqual(sent, { allowSubmit: true, requestContinuation: true, continuationTtlSeconds: 120 });
  for (const state of ['confirmed', 'rejected', 'not_attempted'] as const) {
    const pressed = state !== 'not_attempted';
    const withoutFlag = stratusContinuation(sent, { pressed, state });
    assert.equal(withoutFlag.continuationOffered, false, `${state} must let the sandbox stop`);
    const withFlag = stratusContinuation(
      { requestContinuation: true, continuationCheckpoint: true, continuationTtlSeconds: 120 },
      { pressed, state },
    );
    assert.equal(withFlag.continuationOffered, true,
      `${state} held a sandbox open for the full TTL while the flag was set`);
  }
});

test('managed Stratus converts label fills into selector-backed fill actions', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let captured: { body?: { actions?: Array<Record<string, unknown>> } } = {};
  globalThis.fetch = (async (_input, init) => {
    captured = { body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ run: { title: 'Complete', url: 'https://portal.example/complete', text: 'Thank you' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await runManagedBrowser('https://portal.example/apply', [{
    type: 'fillByLabelText',
    text: 'First Name',
    value: 'Taylor',
    label: 'first_name_label',
    optional: true,
    timeout: 10000,
  }]);

  assert.deepEqual(captured.body?.actions?.map((action) => action.type), ['fillByLabelText']);
  const action = captured.body?.actions?.[0];
  assert.equal(action?.text, 'First Name');
  assert.equal(action?.value, 'Taylor');
  assert.equal(action?.selector, 'body');

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('managed Stratus sends discovery with a selector for strict runners', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let captured: { body?: { actions?: Array<Record<string, unknown>> } } = {};
  globalThis.fetch = (async (_input, init) => {
    captured = { body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ run: { title: 'Complete', url: 'https://portal.example/complete', text: 'Thank you' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await runManagedBrowser('https://portal.example/apply', [{
    type: 'discover',
    label: 'discover_questions',
    optional: true,
    timeout: 10000,
  }]);

  assert.deepEqual(captured.body?.actions, [{
    type: 'discover',
    selector: 'body',
    label: 'discover_questions',
    optional: true,
    timeout: 10000,
  }]);

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('managed Stratus surfaces structured provider errors as readable messages', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { code: 'SANDBOX_RUN_FAILED', message: 'Portal field selector timed out' },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', []),
    /Portal field selector timed out/,
  );

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('managed Stratus selector errors include a sanitized outbound action audit', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { message: 'Each selector must be a non-empty string no longer than 500 characters' },
  }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', [
      { type: 'fill', selector: '#email', value: 'private@example.com', label: 'email' },
      { type: 'discover', label: 'discover_questions' },
    ]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Each selector must be a non-empty string/);
      assert.match(error.message, /action_audit=/);
      assert.match(error.message, /"count":2/);
      assert.match(error.message, /"discover":1/);
      assert.doesNotMatch(error.message, /private@example\.com/);
      assert.doesNotMatch(error.message, /"selectorless":\[\{/);
      return true;
    },
  );

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('managed Stratus drops optional invalid selectors and rejects required invalid selectors locally', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  let captured: { body?: { actions?: Array<Record<string, unknown>> } } = {};
  globalThis.fetch = (async (_input, init) => {
    captured = { body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ run: { title: 'Complete', url: 'https://portal.example/complete', text: 'Thank you' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await runManagedBrowser('https://portal.example/apply', [
    { type: 'fillByLabelText', text: '', value: 'Taylor', label: 'optional_empty_label', optional: true },
    { type: 'fill', selector: '#email', value: 'person@example.com', label: 'email' },
  ]);

  assert.deepEqual(captured.body?.actions, [
    { type: 'fill', selector: '#email', value: 'person@example.com', label: 'email' },
  ]);

  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', [
      { type: 'fillByLabelText', text: '', value: 'Taylor', label: 'required_empty_label' },
    ]),
    /Managed Stratus action has an invalid selector; action_audit=/,
  );

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('managed Stratus serializes the required extract assertion capability and exact digit proof', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  let capturedActions: Array<Record<string, unknown>> = [];
  let advertiseCapability = true;
  globalThis.fetch = (async (_input, init) => {
    capturedActions = (JSON.parse(String(init?.body)) as { actions: Array<Record<string, unknown>> }).actions;
    return new Response(JSON.stringify({
      run: {
        title: 'Apply',
        url: 'https://apply.workable.com/example/apply',
        text: 'Apply',
        ...(advertiseCapability ? { capabilities: [MANAGED_EXTRACT_ASSERTIONS_CAPABILITY] } : {}),
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const actions = [
    {
      type: 'requireCapability',
      value: MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
      label: 'phone',
      optional: false,
    },
    {
      type: 'extract',
      selector: 'input[name="phone"][type="tel"]:visible',
      attribute: 'value',
      label: 'filled_field:phone',
      optional: false,
      requireUnique: true,
      requireNonEmpty: true,
      expectedValueDigits: '0567417451',
      stabilityWindowMs: 1_200,
    },
  ] as const;
  await runManagedBrowser('https://apply.workable.com/example/apply', [...actions]);

  assert.deepEqual(capturedActions, [
    {
      type: 'requireCapability',
      value: MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
      label: 'phone',
      optional: false,
    },
    {
      type: 'extract',
      selector: 'input[name="phone"][type="tel"]:visible',
      attribute: 'value',
      label: 'filled_field:phone',
      optional: false,
      requireUnique: true,
      requireNonEmpty: true,
      expectedValueDigits: '0567417451',
      stabilityWindowMs: 1_200,
    },
  ]);
  advertiseCapability = false;
  await assert.rejects(
    runManagedBrowser('https://apply.workable.com/example/apply', [...actions]),
    /did not advertise required runner capability: extract-assertions-v1/,
  );
  await assert.rejects(
    runManagedBrowser('https://apply.workable.com/example/apply', [
      { type: 'requireCapability', value: 'extract-assertions-v2', optional: false },
    ]),
    /runner capability requirement is invalid/,
  );

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('managed Stratus Greenhouse builder payloads are selector-safe after normalization', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const capturedBodies: Array<{ actions?: Array<Record<string, unknown>> }> = [];
  globalThis.fetch = (async (_input, init) => {
    capturedBodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ run: { title: 'Complete', url: 'https://portal.example/complete', text: 'Thank you' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+1 555 123 4567',
    country: 'United States',
    city: 'Los Angeles',
    school: 'University of Southern California',
    graduationDate: 'May 2027',
    graduationMonth: 'May',
    graduationYear: '2027',
    degree: 'Bachelor of Science',
    major: 'Computer Science',
    gpa: '3.8',
    linkedinUrl: 'https://www.linkedin.com/in/taylor-example',
    githubUrl: 'https://github.com/taylor-example',
    portfolioUrl: 'https://taylor.example',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: 'Why this role?', answer: 'I enjoy full stack engineering.' }],
  };

  await runManagedBrowser('https://job-boards.greenhouse.io/embed/job_app?for=akunacapital&token=8018893', buildManagedDiscoveryActions('greenhouse', packet));
  await runManagedBrowser('https://job-boards.greenhouse.io/embed/job_app?for=akunacapital&token=8018893', buildManagedPortalActions('greenhouse', packet, true));

  assert.equal(capturedBodies.length, 2);
  for (const body of capturedBodies) {
    assert.ok(Array.isArray(body.actions));
    assertStratusSafeActions(body.actions);
  }
  assert.ok(capturedBodies[1]?.actions?.some((action) =>
    action.type === 'fillByLabelText'
    && action.text === 'Why this role?'
    && action.selector === 'body'
  ));

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});
