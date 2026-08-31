import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledgeManagedBrowserTerminalResult,
  browserSessionBody,
  browserDeliveryRuntimeIdentity,
  continueManagedBrowser,
  getManagedBrowserTerminalResult,
  isBrowserbaseConfigured,
  MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY,
  MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY,
  MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
  MANAGED_EXACT_PAGE_URL_CAPABILITY,
  MANAGED_SUBMIT_CHOOSER_POLICY,
  managedActionsWithExactPageUrl,
  managedApplicationSubmitOptions,
  managedContinuationFingerprint,
  managedDeterministicAssertionRefusal,
  ManagedBrowserAssertionFailureError,
  ManagedBrowserPreSubmitCrashError,
  runWithManagedPreSubmitCrashRetry,
  runManagedBrowser,
} from './browserbase';
import { observeManagedReceiptOnce } from './managedSubmitOutcome';
import {
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  MANAGED_WORKABLE_APPLICATION_SCOPE_SELECTOR,
} from './portalSubmission';

const MANAGED_SUBMISSION_ATTEMPT = Object.freeze({
  runId: '11111111-1111-4111-8111-111111111111',
  claimId: '22222222-2222-4222-8222-222222222222',
  executionId: '33333333-3333-4333-8333-333333333333',
});

const managedProviderDeadlineAt = () => new Date(Date.now() + 240_000).toISOString();

test('managed terminal retrieval and acknowledgement preserve the exact attempt correlation', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  try {
    globalThis.fetch = (async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      });
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({
          acknowledged: true,
          submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
          acknowledgedAt: '2026-08-31T10:00:01.000Z',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        state: 'completed',
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        completedAt: '2026-08-31T10:00:00.000Z',
        expiresAt: '2026-09-30T10:00:00.000Z',
        run: {
          title: 'Application submitted',
          url: 'https://portal.example/complete',
          text: 'Thank you',
          submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const terminal = await getManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT);
    assert.equal(terminal.state, 'completed');
    await acknowledgeManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT);
    assert.match(requests[0]!.url,
      /\/api\/run-results\?runId=11111111-1111-4111-8111-111111111111&claimId=22222222-2222-4222-8222-222222222222&executionId=33333333-3333-4333-8333-333333333333$/);
    assert.deepEqual(requests[1], {
      url: 'https://stratus.example/api/run-results/acknowledge',
      method: 'POST',
      body: { submissionAttempt: MANAGED_SUBMISSION_ATTEMPT },
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed terminal retrieval rejects a result bound to another execution', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      state: 'completed',
      submissionAttempt: {
        ...MANAGED_SUBMISSION_ATTEMPT,
        executionId: '44444444-4444-4444-8444-444444444444',
      },
      completedAt: '2026-08-31T10:00:00.000Z',
      expiresAt: '2026-09-30T10:00:00.000Z',
      run: { title: 'Complete', url: 'https://portal.example/complete', text: 'Thank you' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await assert.rejects(
      getManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT),
      /did not match its durable submission attempt/i,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed terminal retrieval preserves pending, missing, expired, and failed states without relaunching', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  const responses = [
    new Response(JSON.stringify({
      state: 'pending',
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      expiresAt: '2026-09-30T10:00:00.000Z',
    }), { status: 202, headers: { 'Content-Type': 'application/json' } }),
    new Response(null, { status: 404 }),
    new Response(null, { status: 410 }),
    new Response(JSON.stringify({
      state: 'failed',
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      completedAt: '2026-08-31T10:00:00.000Z',
      expiresAt: '2026-09-30T10:00:00.000Z',
      error: { code: 'SANDBOX_RUN_FAILED', message: 'Provider response stream reset' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ];
  let fetches = 0;
  try {
    globalThis.fetch = (async () => {
      fetches += 1;
      return responses.shift()!;
    }) as typeof fetch;
    assert.equal((await getManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT)).state, 'pending');
    assert.equal((await getManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT)).state, 'not_found');
    assert.equal((await getManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT)).state, 'gone');
    const failed = await getManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT);
    assert.equal(failed.state, 'failed');
    if (failed.state === 'failed') {
      assert.deepEqual(failed.error, {
        code: 'SANDBOX_RUN_FAILED',
        message: 'Provider response stream reset',
      });
    }
    assert.equal(fetches, 4);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

function assertStratusSafeActions(actions: Array<Record<string, unknown>>) {
  for (const action of actions) {
    if (action.type === 'requireCapability') {
      if (action.value === MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY) {
        assert.equal(action.applicationScopeSelector, MANAGED_WORKABLE_APPLICATION_SCOPE_SELECTOR);
      }
      continue;
    }
    assert.equal(typeof action.selector, 'string', JSON.stringify(action));
    assert.ok(String(action.selector).trim().length > 0, JSON.stringify(action));
    assert.ok(String(action.selector).length <= 500, JSON.stringify(action));
    assert.doesNotMatch(String(action.selector), /:right-of|:below|:is\(/);
  }
}

test('browser delivery runtime identity binds provider, endpoint, and Browserbase project', () => {
  assert.deepEqual(browserDeliveryRuntimeIdentity({
    BROWSER_PROVIDER: 'stratus-managed',
    STRATUS_BASE_URL: 'https://stratus.example/',
  }), {
    provider: 'stratus-managed',
    apiRoot: 'https://stratus.example',
    projectId: undefined,
  });
  assert.deepEqual(browserDeliveryRuntimeIdentity({
    BROWSERBASE_PROJECT_ID: 'project-1',
  }), {
    provider: 'browserbase',
    apiRoot: 'https://api.browserbase.com/v1',
    projectId: 'project-1',
  });
});

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

test('a proven pre-submit crash gets one authorized retry', async () => {
  const progress = {
    version: 1 as const,
    phase: 0 as const,
    stage: 'phase_started' as const,
    submitPressed: false,
    applicationSubmitPressed: false,
    verificationSubmitPressed: false,
    submitKind: 'application' as const,
    policyVersion: 4 as const,
  };
  let runs = 0;
  let authorizationReads = 0;
  const outcome = await runWithManagedPreSubmitCrashRetry(
    async () => {
      runs += 1;
      if (runs === 1) throw new ManagedBrowserPreSubmitCrashError('sandbox closed', progress);
      return 'receipt';
    },
    async () => {
      authorizationReads += 1;
      return true;
    },
  );

  assert.deepEqual(outcome, { kind: 'completed', result: 'receipt', retried: true });
  assert.equal(runs, 2);
  assert.equal(authorizationReads, 1);
});

test('a revoked authorization stops a proven pre-submit retry', async () => {
  const error = new ManagedBrowserPreSubmitCrashError('sandbox closed', {
    version: 1,
    phase: 0,
    stage: 'submit_blocked',
    submitPressed: false,
    applicationSubmitPressed: false,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
  });
  let runs = 0;
  const outcome = await runWithManagedPreSubmitCrashRetry(
    async () => {
      runs += 1;
      throw error;
    },
    async () => false,
  );

  assert.equal(outcome.kind, 'authorization_revoked');
  if (outcome.kind === 'authorization_revoked') assert.equal(outcome.error, error);
  assert.equal(runs, 1);
});

test('an uncertain provider failure is never retried', async () => {
  let runs = 0;
  let authorizationReads = 0;
  await assert.rejects(
    runWithManagedPreSubmitCrashRetry(
      async () => {
        runs += 1;
        throw new Error('sandbox stream was closed');
      },
      async () => {
        authorizationReads += 1;
        return true;
      },
    ),
    /sandbox stream was closed/,
  );
  assert.equal(runs, 1);
  assert.equal(authorizationReads, 0);
});

test('a second proven pre-submit crash escapes instead of looping', async () => {
  const error = new ManagedBrowserPreSubmitCrashError('sandbox closed again', {
    version: 1,
    phase: 0,
    stage: 'phase_started',
    submitPressed: false,
    applicationSubmitPressed: false,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
  });
  let runs = 0;
  await assert.rejects(
    runWithManagedPreSubmitCrashRetry(
      async () => {
        runs += 1;
        throw error;
      },
      async () => true,
    ),
    (thrown: unknown) => thrown === error,
  );
  assert.equal(runs, 2);
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
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push(body);
    return new Response(JSON.stringify({ run: {
      title: 'Complete',
      url: 'https://portal.example/complete',
      text: 'Thank you',
      submissionAttempt: body.submissionAttempt,
    } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await runManagedBrowser('https://portal.example/apply', [], {
    requestContinuation: true,
    continuationTtlSeconds: 500,
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
    providerDeadlineAt: managedProviderDeadlineAt(),
  });
  await continueManagedBrowser('a'.repeat(43), [{ type: 'click', selector: '#verify' }], {
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
    timeoutMs: 60_000,
  });

  assert.equal(requests[0].requestContinuation, true);
  assert.equal(requests[0].continuationTtlSeconds, 180);
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
            submissionAttempt: body.submissionAttempt,
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
          submissionAttempt: body.submissionAttempt,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    // The exact options a real managed application submit sends, not a hand-written approximation.
    const initial = await runManagedBrowser(applicationUrl, [], {
      ...managedApplicationSubmitOptions(120, MANAGED_SUBMISSION_ATTEMPT),
      providerDeadlineAt: managedProviderDeadlineAt(),
    });
    assert.equal(initial.humanVerification, null);
    assert.equal(initial.continuationOffered, true,
      'pressedUnknown alone offers the continuation, which is what the checkpoint flag was added for');
    assert.equal(initial.continuationExpiresAt, '2026-08-11T12:00:15.000Z',
      'and without the flag the held employer page keeps its deliberate 15 second observation cap');

    const observation = await observeManagedReceiptOnce({
      initial,
      expectedApplicationUrl: applicationUrl,
      nowMs: Date.parse('2026-08-11T12:00:05.000Z'),
      observe: (continuationToken) => continueManagedBrowser(continuationToken, [], {
        screenshot: true,
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        timeoutMs: 60_000,
      }),
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
  const sent = managedApplicationSubmitOptions(120, MANAGED_SUBMISSION_ATTEMPT) as Record<string, unknown>;
  assert.equal('continuationCheckpoint' in sent, false, 'the flag rested on a false premise');
  assert.deepEqual(sent, {
    allowSubmit: true,
    requestContinuation: true,
    continuationTtlSeconds: 120,
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
  });
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

test('managed Stratus types only durable chooser-v4 pre-submit crash progress as retryable', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const progress = {
    version: 1,
    phase: 0,
    stage: 'phase_started',
    submitPressed: false,
    applicationSubmitPressed: false,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
  };
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { code: 'SANDBOX_RUN_FAILED', message: 'Sandbox browser run failed', runProgress: progress },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', [], {
      allowSubmit: true,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      providerDeadlineAt: managedProviderDeadlineAt(),
    }),
    (error: unknown) => error instanceof ManagedBrowserPreSubmitCrashError
      && error.runProgress.stage === 'phase_started',
  );

  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: {
      code: 'SANDBOX_RUN_FAILED',
      message: 'Sandbox browser run failed',
      runProgress: { ...progress, stage: 'submit_activation_started' },
    },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', [], {
      allowSubmit: true,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      providerDeadlineAt: managedProviderDeadlineAt(),
    }),
    (error: unknown) => error instanceof Error
      && !(error instanceof ManagedBrowserPreSubmitCrashError),
  );

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('a deterministic assertion refusal under containment progress is typed, not called a crash', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const progress = {
    version: 1,
    phase: 0,
    stage: 'phase_started',
    submitPressed: false,
    applicationSubmitPressed: false,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
  };
  /* The exact live refusal, verbatim: Pony.ai application fdcf4ccb, 2026-08-28. Until this typing
   * existed it became ManagedBrowserPreSubmitCrashError, was retried once as a crash, and told the
   * applicant it was "a temporary secure-browser error". It is deterministic and none of that. */
  const refusal = 'filled_field:phone: expected exactly one match for .iti input[type="tel"], found 0';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { code: 'SANDBOX_RUN_FAILED', message: refusal, runProgress: progress },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', [], {
      allowSubmit: true,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      providerDeadlineAt: managedProviderDeadlineAt(),
    }),
    (error: unknown) => error instanceof ManagedBrowserAssertionFailureError
      && !(error instanceof ManagedBrowserPreSubmitCrashError)
      && error.assertionLabel === 'filled_field:phone'
      && error.runProgress.stage === 'phase_started',
  );

  /* The same refusal WITHOUT containment progress stays a plain error: the release rule downstream
   * leans on the durable proof, so the typing must never outrun it. */
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { code: 'SANDBOX_RUN_FAILED', message: refusal },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;
  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', [], {
      allowSubmit: true,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      providerDeadlineAt: managedProviderDeadlineAt(),
    }),
    (error: unknown) => error instanceof Error
      && !(error instanceof ManagedBrowserAssertionFailureError)
      && !(error instanceof ManagedBrowserPreSubmitCrashError),
  );

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('the crash retry helper never spends a second sandbox run on a deterministic refusal', async () => {
  const progress = {
    version: 1,
    phase: 0,
    stage: 'phase_started',
    submitPressed: false,
    applicationSubmitPressed: false,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
  } as const;
  let runs = 0;
  const refusal = new ManagedBrowserAssertionFailureError(
    'filled_field:phone: expected exactly one match for .iti input[type="tel"], found 0',
    { ...progress, submitKind: 'application', policyVersion: 4 },
    'filled_field:phone',
  );
  await assert.rejects(
    runWithManagedPreSubmitCrashRetry(
      async () => {
        runs += 1;
        throw refusal;
      },
      async () => true,
    ),
    (error: unknown) => error === refusal,
  );
  assert.equal(runs, 1, 'a deterministic refusal reproduces; retrying it only doubles the cost');
});

test('the assertion refusal detector holds the measured shapes and refuses the rest', () => {
  assert.deepEqual(
    managedDeterministicAssertionRefusal('filled_field:phone: expected exactly one match for .iti input[type="tel"], found 0'),
    { label: 'filled_field:phone' },
  );
  assert.deepEqual(
    managedDeterministicAssertionRefusal('expected exactly one match for input[name="phone"], found 0'),
    { label: null },
  );
  assert.deepEqual(
    managedDeterministicAssertionRefusal('filled_field:phone_country: expected exactly one match for .iti__selected-dial-code:visible, found 2'),
    { label: 'filled_field:phone_country' },
  );
  assert.equal(managedDeterministicAssertionRefusal('Sandbox browser run failed'), null);
  assert.equal(managedDeterministicAssertionRefusal('The sandbox stream was closed'), null);
  assert.equal(managedDeterministicAssertionRefusal('page.waitForSelector: Timeout 20000ms exceeded'), null);
});

test('attached evidence rides the refusal message into submission_error', () => {
  const refusal = new ManagedBrowserAssertionFailureError(
    'filled_field:phone: expected exactly one match for .iti input[type="tel"], found 0',
    {
      version: 1,
      phase: 0,
      stage: 'phase_started',
      submitPressed: false,
      applicationSubmitPressed: false,
      verificationSubmitPressed: false,
      submitKind: 'application',
      policyVersion: 4,
    },
    'filled_field:phone',
  );
  refusal.attachEvidence('workable_phone_readback_evidence={"observed":"fresh_page_load"}');
  assert.match(refusal.message, /found 0; workable_phone_readback_evidence=/);
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

test('managed Stratus selector audits include the v4 form boundary without applicant values', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const applicationUrl = 'https://apply.workable.com/example/j/ABC123/apply';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { message: 'Each selector must be a non-empty string no longer than 500 characters' },
  }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    const actions = buildManagedPortalActions('workable', {
      fullName: 'Private Applicant',
      email: 'private@example.com',
      resume: Buffer.from('private resume bytes'),
      resumeName: 'private-resume.pdf',
      questions: [],
    }, true, applicationUrl);
    await assert.rejects(
      runManagedBrowser(applicationUrl, actions, {
        allowSubmit: true,
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        providerDeadlineAt: managedProviderDeadlineAt(),
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /"applicationScopes":\[\{/);
        assert.match(error.message, /"capability":"atomic-submit-v4"/);
        assert.match(error.message, /form:has\(input\[name=\\"firstname\\"\]\)/);
        assert.doesNotMatch(error.message, /Private Applicant|private@example\.com|private resume bytes/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
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

test('managed Stratus proves the exact employer URL before actions and before a physical submit', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const expectedPageUrl = 'https://apply.workable.com/j/20e78cba92/apply?source=litos';
  const resolvedPageUrl = 'https://apply.workable.com/max-borges-agency/j/20E78CBA92/apply?source=litos';
  let proofMatches = true;
  let chooserReported = true;
  let advertiseAtomicCapability = true;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      actions: Array<Record<string, unknown>>;
      submissionAttempt?: unknown;
    };
    assert.deepEqual(body.actions.slice(0, 2), [
      {
        type: 'requireCapability',
        value: MANAGED_EXACT_PAGE_URL_CAPABILITY,
        optional: false,
        expectedPageUrl,
      },
      {
        type: 'requireCapability',
        value: MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY,
        optional: false,
        applicationScopeSelector: MANAGED_WORKABLE_APPLICATION_SCOPE_SELECTOR,
      },
    ]);
    assert.equal(body.actions.at(-1)?.expectedPageUrl, expectedPageUrl);
    assert.deepEqual(body.actions.at(-1)?.chooserPolicy, MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY);
    return new Response(JSON.stringify({
      run: {
        title: 'Submitted',
        url: 'https://jobs.example.com/receipt',
        text: 'Thank you',
        capabilities: [
          MANAGED_EXACT_PAGE_URL_CAPABILITY,
          ...(advertiseAtomicCapability ? [MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY] : []),
        ],
        exactPageUrlProof: {
          expected: expectedPageUrl,
          beforeActions: resolvedPageUrl,
          beforeApplicantData: resolvedPageUrl,
          beforeFinalChooser: resolvedPageUrl,
          beforeSubmit: proofMatches ? resolvedPageUrl : 'https://jobs.example.com/postings/other',
        },
        ...(chooserReported ? { finalSubmitChooser: {
          version: 1,
          policyName: 'litos-final-submit',
          policyVersion: 4,
          grammarHash: 'ee6697971965f0ab360f77da88d935a58b0b7af8ea412ad5d5b3813e9cc11263',
          submitKind: 'application',
          outcome: 'selected',
          candidateCount: 1,
          viableCandidateCount: 1,
          topScore: 1,
          topScoreCount: 1,
          addressedScopeCount: 1,
          bareSendCandidateCount: 0,
        } } : {}),
        submitOutcome: { pressed: true, state: 'confirmed' },
        submissionAttempt: body.submissionAttempt,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  const actions = buildManagedPortalActions('workable', packet, true, expectedPageUrl);
  const submitOptions = {
    allowSubmit: true,
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
    providerDeadlineAt: managedProviderDeadlineAt(),
  };
  await runManagedBrowser(expectedPageUrl, actions, submitOptions);
  proofMatches = false;
  await assert.rejects(
    runManagedBrowser(expectedPageUrl, actions, submitOptions),
    /did not prove the exact employer page URL boundaries/,
  );
  proofMatches = true;
  chooserReported = false;
  await assert.rejects(
    runManagedBrowser(expectedPageUrl, actions, submitOptions),
    /did not prove the final-submit chooser outcome/,
  );
  chooserReported = true;
  advertiseAtomicCapability = false;
  await assert.rejects(
    runManagedBrowser(expectedPageUrl, actions, submitOptions),
    /did not advertise required runner capability: atomic-submit-v4/,
  );

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

test('managed chooser v4 refuses to leave the process without both exact boundaries', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('network should be unreachable');
  }) as typeof fetch;
  try {
    const applicationUrl = 'https://apply.workable.com/example/j/ABC123/apply';
    const actions = buildManagedPortalActions('workable', {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      resume: Buffer.from('pdf'),
      resumeName: 'resume.pdf',
      questions: [],
    }, true, applicationUrl);
    const exactIndex = actions.findIndex((action) => action.type === 'requireCapability'
      && action.value === MANAGED_EXACT_PAGE_URL_CAPABILITY);
    const atomicIndex = actions.findIndex((action) => action.type === 'requireCapability'
      && action.value === MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY);
    assert.ok(exactIndex >= 0);
    assert.ok(atomicIndex >= 0);
    const invalidSubmitOptions = {
      allowSubmit: true,
      providerDeadlineAt: managedProviderDeadlineAt(),
    };
    const missingExact = actions.filter((_action, index) => index !== exactIndex);
    await assert.rejects(
      runManagedBrowser(applicationUrl, missingExact, invalidSubmitOptions),
      /policy v4 requires an exact employer page URL boundary/,
    );
    const mismatchedBoundary = actions.map((action, index) => index === exactIndex ? {
      ...action,
      expectedPageUrl: 'https://apply.workable.com/example/j/OTHER/',
    } : { ...action });
    await assert.rejects(
      runManagedBrowser(applicationUrl, mismatchedBoundary, invalidSubmitOptions),
      /policy v4 requires an exact employer page URL boundary/,
    );
    const optionalBoundary = actions.map((action, index) => index === exactIndex
      ? { ...action, optional: true }
      : { ...action });
    await assert.rejects(
      runManagedBrowser(applicationUrl, optionalBoundary, invalidSubmitOptions),
      /policy v4 requires an exact employer page URL boundary/,
    );
    const duplicateBoundary = actions.map((action) => ({ ...action }));
    duplicateBoundary.splice(exactIndex + 1, 0, { ...actions[exactIndex]! });
    await assert.rejects(
      runManagedBrowser(applicationUrl, duplicateBoundary, invalidSubmitOptions),
      /policy v4 requires an exact employer page URL boundary/,
    );
    const missingAtomic = actions.filter((_action, index) => index !== atomicIndex);
    await assert.rejects(
      runManagedBrowser(applicationUrl, missingAtomic, invalidSubmitOptions),
      /policy v4 requires one exact application form boundary/,
    );
    const optionalAtomic = actions.map((action, index) => index === atomicIndex
      ? { ...action, optional: true }
      : { ...action });
    await assert.rejects(
      runManagedBrowser(applicationUrl, optionalAtomic, invalidSubmitOptions),
      /policy v4 requires one exact application form boundary/,
    );
    const missingScope = actions.map((action, index) => index === atomicIndex
      ? { type: action.type, value: action.value, optional: action.optional }
      : { ...action });
    await assert.rejects(
      runManagedBrowser(applicationUrl, missingScope, invalidSubmitOptions),
      /policy v4 requires one exact application form boundary/,
    );
    const duplicateAtomic = actions.map((action) => ({ ...action }));
    duplicateAtomic.splice(atomicIndex + 1, 0, { ...actions[atomicIndex]! });
    await assert.rejects(
      runManagedBrowser(applicationUrl, duplicateAtomic, invalidSubmitOptions),
      /policy v4 requires one exact application form boundary/,
    );
    const wrongCapability = actions.map((action, index) => index === atomicIndex
      ? {
        ...action,
        value: MANAGED_EXACT_PAGE_URL_CAPABILITY,
        expectedPageUrl: applicationUrl,
      }
      : { ...action });
    await assert.rejects(
      runManagedBrowser(applicationUrl, wrongCapability, invalidSubmitOptions),
      /application scope selector requires the atomic submit v4 capability/,
    );
    const scopeOnFill = actions.map((action) => ({ ...action }));
    const fillIndex = scopeOnFill.findIndex((action) => action.type === 'fill');
    scopeOnFill[fillIndex] = {
      ...scopeOnFill[fillIndex]!,
      applicationScopeSelector: MANAGED_WORKABLE_APPLICATION_SCOPE_SELECTOR,
    };
    await assert.rejects(
      runManagedBrowser(applicationUrl, scopeOnFill, invalidSubmitOptions),
      /application scope selector requires the atomic submit v4 capability/,
    );
    const v3WithAtomicOnly = actions
      .filter((_action, index) => index === atomicIndex || _action.type !== 'confirmAndSubmit')
      .concat({
        ...actions.at(-1)!,
        chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY,
      });
    await assert.rejects(
      runManagedBrowser(applicationUrl, v3WithAtomicOnly, invalidSubmitOptions),
      /atomic submit v4 capability requires a chooser v4 submit/,
    );
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed prepare and continuation actions bind the exact page without consuming a browser action', () => {
  const expectedPageUrl = 'https://jobs.example.com/postings/cbs-123#apply';
  const actions = managedActionsWithExactPageUrl([
    { type: 'fill', selector: '#email', value: 'person@example.com' },
  ], expectedPageUrl);
  assert.deepEqual(actions, [
    {
      type: 'requireCapability',
      value: MANAGED_EXACT_PAGE_URL_CAPABILITY,
      optional: false,
      expectedPageUrl: 'https://jobs.example.com/postings/cbs-123',
    },
    { type: 'fill', selector: '#email', value: 'person@example.com' },
  ]);
});

test('managed Stratus Greenhouse builder payloads are selector-safe after normalization', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const applicationUrl = 'https://job-boards.greenhouse.io/embed/job_app?for=akunacapital&token=8018893';
  const capturedBodies: Array<{ actions?: Array<Record<string, unknown>> }> = [];
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { actions?: Array<Record<string, unknown>> };
    capturedBodies.push(body);
    const submits = body.actions?.some((action) => action.type === 'confirmAndSubmit') ?? false;
    return new Response(JSON.stringify({ run: {
      title: 'Complete',
      url: submits ? 'https://portal.example/complete' : applicationUrl,
      text: 'Thank you',
      ...(submits ? {
        capabilities: [MANAGED_EXACT_PAGE_URL_CAPABILITY],
        exactPageUrlProof: {
          expected: applicationUrl,
          beforeActions: applicationUrl,
          beforeApplicantData: applicationUrl,
          beforeFinalChooser: applicationUrl,
          beforeSubmit: applicationUrl,
        },
        finalSubmitChooser: {
          version: 1,
          policyName: 'litos-final-submit',
          policyVersion: 3,
          grammarHash: MANAGED_SUBMIT_CHOOSER_POLICY.grammarHash,
          submitKind: 'application',
          outcome: 'selected',
          candidateCount: 1,
          viableCandidateCount: 1,
          topScore: 1,
          topScoreCount: 1,
          addressedScopeCount: 1,
          bareSendCandidateCount: 0,
        },
        submitOutcome: { pressed: true, state: 'confirmed' },
      } : {}),
    } }), {
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

  await runManagedBrowser(applicationUrl, buildManagedDiscoveryActions('greenhouse', packet));
  await runManagedBrowser(applicationUrl, buildManagedPortalActions('greenhouse', packet, true, applicationUrl));

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
