import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acquireManagedStratusOidcAuthorization,
  browserSessionBody,
  browserDeliveryRuntimeIdentity,
  continueManagedBrowser,
  isBrowserbaseConfigured,
  MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY,
  MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY,
  MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
  MANAGED_EXACT_PAGE_URL_CAPABILITY,
  MANAGED_SUBMIT_CHOOSER_POLICY,
  managedActionsWithExactPageUrl,
  managedApplicationSubmitOptions,
  managedContinuationFingerprint,
  ManagedBrowserPreSubmitCrashError,
  ManagedBrowserProviderProgressError,
  runWithManagedPreSubmitCrashRetry,
  runManagedBrowser,
  startManagedBrowserRequestBudget,
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

const managedProviderDeadlineAt = (offsetMs = 240_000) => new Date(Date.now() + offsetMs).toISOString();

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

test('the retry helper revalidates typed progress instead of trusting its error class', async () => {
  let runs = 0;
  let authorizationReads = 0;
  const error = new ManagedBrowserPreSubmitCrashError('sandbox closed', {
    version: 1,
    phase: 0,
    stage: 'submit_blocked',
    submitPressed: false,
    applicationSubmitPressed: false,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
    employerOutcome: {
      kind: 'confirmed',
      state: 'confirmed',
      source: 'ats_state',
      evidence: '.application-success',
      message: 'Application received',
      formStillPresent: false,
    },
    requiredFieldConfirmationStatus: 'confirmed',
  });

  await assert.rejects(
    runWithManagedPreSubmitCrashRetry(
      async () => {
        runs += 1;
        throw error;
      },
      async () => {
        authorizationReads += 1;
        return true;
      },
    ),
    (thrown: unknown) => thrown instanceof Error
      && !(thrown instanceof ManagedBrowserPreSubmitCrashError),
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

test('an initial managed Stratus run has one validated local HTTP timeout', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let fetches = 0;
  let pendingFetchGuard: ReturnType<typeof setTimeout> | undefined;

  try {
    globalThis.fetch = (async (_input, init) => {
      fetches += 1;
      const signal = init?.signal;
      assert.ok(signal, 'the initial provider request must carry its duration fence');
      return new Promise<Response>((_resolve, reject) => {
        // AbortSignal.timeout uses an unreferenced timer. This guard models a live socket and keeps
        // the event loop alive long enough to observe that the provider request is actually cut off.
        pendingFetchGuard = setTimeout(() => reject(new Error('provider request was not bounded')), 1_000);
        const rejectForAbort = () => {
          if (pendingFetchGuard) clearTimeout(pendingFetchGuard);
          pendingFetchGuard = undefined;
          reject(signal.reason);
        };
        if (signal.aborted) rejectForAbort();
        else signal.addEventListener('abort', rejectForAbort, { once: true });
      });
    }) as typeof fetch;

    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [], {
        allowSubmit: true,
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        providerDeadlineAt: managedProviderDeadlineAt(),
        timeoutMs: 10,
      }),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
    );
    assert.equal(fetches, 1);

    for (const timeoutMs of [0, 300_001, 1.5]) {
      await assert.rejects(
        runManagedBrowser('https://portal.example/apply', [], {
          allowSubmit: true,
          submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
          timeoutMs,
        }),
        /timeout must be between 1 ms and 5 minutes/i,
      );
    }
    assert.equal(fetches, 1, 'invalid timeout values must fail before provider dispatch');
  } finally {
    if (pendingFetchGuard) clearTimeout(pendingFetchGuard);
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('the managed request timeout includes delayed OIDC credential acquisition', async () => {
  let credentialResolved = false;
  const signal = AbortSignal.timeout(10);
  const delayedCredential = () => new Promise<string>((resolve) => {
    setTimeout(() => {
      credentialResolved = true;
      resolve('late-oidc-token');
    }, 50);
  });

  await assert.rejects(
    acquireManagedStratusOidcAuthorization(signal, delayedCredential),
    (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
  );
  assert.equal(credentialResolved, false, 'an expired callback must return before the credential does');
});

test('a retained continuation reuses its pre-gate budget and refuses a late provider dispatch', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let fetches = 0;
  let expectedSignal: AbortSignal | undefined;

  try {
    globalThis.fetch = (async (_input, init) => {
      fetches += 1;
      assert.equal(init?.signal, expectedSignal, 'the provider fetch must reuse the signal started before the gate');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        run: {
          title: 'Complete',
          url: 'https://portal.example/complete',
          text: 'Thank you',
          submissionAttempt: body.submissionAttempt,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const acceptedBudget = startManagedBrowserRequestBudget(1_000);
    expectedSignal = acceptedBudget.signal;
    await continueManagedBrowser('a'.repeat(43), [{ type: 'click', selector: '#verify' }], {
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      requestBudget: acceptedBudget,
      providerDeadlineAt: new Date(Date.now() + 2_000).toISOString(),
      minimumDispatchBudgetMs: 20,
    });
    assert.equal(fetches, 1);

    const delayedBudget = startManagedBrowserRequestBudget(30);
    await new Promise<void>((resolve) => setTimeout(resolve, 15));
    await assert.rejects(
      continueManagedBrowser('b'.repeat(43), [{ type: 'click', selector: '#verify' }], {
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        requestBudget: delayedBudget,
        providerDeadlineAt: new Date(Date.now() + 1_000).toISOString(),
        minimumDispatchBudgetMs: 20,
      }),
      (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError',
    );
    assert.equal(fetches, 1, 'a worker that spent its dispatch margin must not call the provider');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed Stratus refuses unbound sends and mismatched result correlation', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({
      run: {
        title: 'Complete',
        url: 'https://portal.example/complete',
        text: 'Thank you',
        submissionAttempt: { ...MANAGED_SUBMISSION_ATTEMPT, executionId: '44444444-4444-4444-8444-444444444444' },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', [], {
      allowSubmit: true,
      providerDeadlineAt: managedProviderDeadlineAt(),
    }),
    /submission attempt correlation is required/i,
  );
  assert.equal(fetches, 0);
  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', [], {
      allowSubmit: true,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      providerDeadlineAt: managedProviderDeadlineAt(),
    }),
    /did not match its durable submission attempt/i,
  );
  assert.equal(fetches, 1);

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
    const initial = await runManagedBrowser(
      applicationUrl,
      [],
      {
        ...managedApplicationSubmitOptions(120, MANAGED_SUBMISSION_ATTEMPT),
        providerDeadlineAt: managedProviderDeadlineAt(),
      },
    );
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
    applicantAnswer: 'must not cross the provider boundary',
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
      && error.runProgress.stage === 'phase_started'
      && !('applicantAnswer' in error.runProgress),
  );

  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: {
      code: 'SANDBOX_RUN_FAILED',
      message: 'Sandbox browser run failed',
      runProgress: {
        ...progress,
        submissionAttempt: {
          ...MANAGED_SUBMISSION_ATTEMPT,
          executionId: '44444444-4444-4444-8444-444444444444',
        },
      },
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

test('managed Stratus retries only an absent or exact not-attempted employer outcome', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  let fetches = 0;
  let authorizationReads = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    if (fetches === 1) {
      return new Response(JSON.stringify({
        error: {
          code: 'SANDBOX_RUN_FAILED',
          message: 'Sandbox browser run failed',
          runProgress: {
            version: 1,
            phase: 0,
            stage: 'submit_blocked',
            submitPressed: false,
            applicationSubmitPressed: false,
            verificationSubmitPressed: false,
            submitKind: 'application',
            policyVersion: 4,
            employerOutcome: {
              kind: 'not_attempted',
              state: 'not_attempted',
              source: null,
              evidence: null,
              message: null,
              formStillPresent: null,
            },
            submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
          },
        },
      }), { status: 502, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({
      run: {
        title: 'Application',
        url: 'https://portal.example/apply',
        text: 'Ready',
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    const outcome = await runWithManagedPreSubmitCrashRetry(
      () => runManagedBrowser('https://portal.example/apply', [], {
        allowSubmit: true,
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        providerDeadlineAt: managedProviderDeadlineAt(),
      }),
      async () => {
        authorizationReads += 1;
        return true;
      },
    );
    assert.equal(outcome.kind, 'completed');
    assert.equal(outcome.retried, true);
    assert.equal(fetches, 2);
    assert.equal(authorizationReads, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed Stratus rejects contradictory provider progress without retrying', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  let currentProgress: Record<string, unknown>;
  let fetches = 0;
  let authorizationReads = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response(JSON.stringify({
      error: {
        code: 'SANDBOX_RUN_FAILED',
        message: 'Sandbox browser run failed',
        runProgress: currentProgress,
      },
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  const exactNotAttempted = {
    kind: 'not_attempted',
    state: 'not_attempted',
    source: null,
    evidence: null,
    message: null,
    formStillPresent: null,
  };
  const confirmed = {
    kind: 'confirmed',
    state: 'confirmed',
    source: 'ats_state',
    evidence: '.application-success',
    message: 'Application received',
    formStillPresent: false,
  };
  const pressedUnknown = {
    kind: 'pressed',
    state: 'unknown',
    source: null,
    evidence: null,
    message: null,
    formStillPresent: true,
  };
  const base = {
    version: 1,
    phase: 0,
    stage: 'submit_blocked',
    submitPressed: false,
    applicationSubmitPressed: false,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
  };
  const cases: Array<{ name: string; progress: Record<string, unknown> }> = [
    {
      name: 'confirmation paired with a blocked no-press checkpoint',
      progress: { ...base, employerOutcome: confirmed, requiredFieldConfirmationStatus: 'confirmed' },
    },
    {
      name: 'pressed outcome paired with no aggregate or per-kind press',
      progress: { ...base, employerOutcome: pressedUnknown },
    },
    {
      name: 'aggregate no-press paired with an application press',
      progress: {
        ...base,
        stage: 'submit_released',
        applicationSubmitPressed: true,
        employerOutcome: pressedUnknown,
      },
    },
    {
      name: 'released stage paired with no current-kind press',
      progress: { ...base, stage: 'submit_released', employerOutcome: exactNotAttempted },
    },
    {
      name: 'phase zero paired with a verification submit',
      progress: { ...base, submitKind: 'verification', employerOutcome: exactNotAttempted },
    },
    {
      name: 'accepted security code paired with no verification press',
      progress: {
        ...base,
        phase: 1,
        stage: 'result_ready',
        submitPressed: true,
        applicationSubmitPressed: true,
        submitKind: 'verification',
        employerOutcome: pressedUnknown,
        securityCodeOutcome: 'accepted',
      },
    },
    {
      name: 'no-control security code paired with a verification press',
      progress: {
        ...base,
        phase: 1,
        stage: 'result_ready',
        submitPressed: true,
        verificationSubmitPressed: true,
        submitKind: 'verification',
        employerOutcome: pressedUnknown,
        securityCodeOutcome: 'no_control',
      },
    },
    {
      name: 'not-attempted outcome carrying employer evidence',
      progress: {
        ...base,
        employerOutcome: { ...exactNotAttempted, source: 'page_text', evidence: 'Not sent' },
      },
    },
  ];

  try {
    for (const entry of cases) {
      currentProgress = entry.progress;
      fetches = 0;
      authorizationReads = 0;
      await assert.rejects(
        runWithManagedPreSubmitCrashRetry(
          () => runManagedBrowser('https://portal.example/apply', [], {
            allowSubmit: true,
            submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
            providerDeadlineAt: managedProviderDeadlineAt(),
          }),
          async () => {
            authorizationReads += 1;
            return true;
          },
        ),
        (error: unknown) => {
          assert.ok(error instanceof Error, entry.name);
          assert.equal(error instanceof ManagedBrowserPreSubmitCrashError, false, entry.name);
          assert.equal(error instanceof ManagedBrowserProviderProgressError, false, entry.name);
          return true;
        },
      );
      assert.equal(fetches, 1, entry.name);
      assert.equal(authorizationReads, 0, entry.name);
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed Stratus preserves correlated press and confirmation progress on response loss', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const progress = {
    version: 1,
    phase: 0,
    stage: 'result_ready',
    submitPressed: true,
    applicationSubmitPressed: true,
    verificationSubmitPressed: false,
    submitKind: 'application',
    policyVersion: 4,
    employerOutcome: {
      kind: 'confirmed',
      state: 'confirmed',
      source: 'ats_state',
      evidence: '.application-success',
      message: 'Application received',
      formStillPresent: false,
    },
    requiredFieldConfirmationStatus: 'confirmed',
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
  } as const;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: {
      code: 'SANDBOX_RESULT_MISSING',
      message: 'Provider response stream reset',
      runProgress: progress,
    },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [], {
        allowSubmit: true,
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        providerDeadlineAt: managedProviderDeadlineAt(),
      }),
      (error: unknown) => {
        assert.ok(error instanceof ManagedBrowserProviderProgressError);
        assert.equal(error.code, 'SANDBOX_RESULT_MISSING');
        assert.deepEqual(error.runProgress, progress);
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

test('managed Stratus preserves one consistent verification confirmation checkpoint', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const progress = {
    version: 1,
    phase: 1,
    stage: 'result_ready',
    submitPressed: true,
    applicationSubmitPressed: true,
    verificationSubmitPressed: true,
    submitKind: 'verification',
    policyVersion: 4,
    employerOutcome: {
      kind: 'confirmed',
      state: 'confirmed',
      source: 'ats_route',
      evidence: '/complete',
      message: 'Application received',
      formStillPresent: false,
    },
    requiredFieldConfirmationStatus: 'confirmed',
    securityCodeOutcome: 'accepted',
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
  } as const;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: {
      code: 'SANDBOX_RESULT_MISSING',
      message: 'Provider response stream reset',
      runProgress: progress,
    },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  try {
    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [], {
        allowSubmit: true,
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        providerDeadlineAt: managedProviderDeadlineAt(),
      }),
      (error: unknown) => error instanceof ManagedBrowserProviderProgressError
        && error.runProgress.securityCodeOutcome === 'accepted'
        && error.runProgress.verificationSubmitPressed === true,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
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
