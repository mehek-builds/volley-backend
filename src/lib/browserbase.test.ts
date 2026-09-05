import assert from 'node:assert/strict';
import { Agent } from 'undici';
import test from 'node:test';
import {
  acknowledgeManagedBrowserTerminalResult,
  assertManagedBrowserRequestBudgetAtClock,
  browserSessionBody,
  browserDeliveryRuntimeIdentity,
  browserSessionsForResourceReservation,
  continueManagedBrowser,
  getManagedBrowserTerminalResult,
  isBrowserbaseConfigured,
  MANAGED_PREPARE_FILL_DEADLINE_MS,
  MANAGED_PREPARE_FILL_OPTIONS,
  MANAGED_PREPARE_SCAN_OPTIONS,
  MANAGED_READ_ONLY_ACTION_TYPES,
  MANAGED_ATOMIC_SUBMIT_V4_CAPABILITY,
  MANAGED_APPLICATION_SUBMIT_CHOOSER_POLICY,
  MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
  MANAGED_EXACT_PAGE_URL_CAPABILITY,
  MANAGED_SUBMIT_CHOOSER_POLICY,
  managedActionsWithExactPageUrl,
  managedApplicationSubmitOptions,
  managedBrowserTerminalFailureError,
  managedContinuationFingerprint,
  managedDeterministicAssertionRefusal,
  ManagedBrowserAction,
  ManagedBrowserAssertionFailureError,
  ManagedBrowserPreSubmitCrashError,
  ManagedBrowserProviderProgressError,
  runWithManagedPreSubmitCrashRetry,
  runManagedBrowser,
  startManagedBrowserRequestBudget,
  MANAGED_RUN_HEADERS_TIMEOUT_MS,
  managedRunRequestInit,
} from './browserbase';
import { observeManagedReceiptOnce } from './managedSubmitOutcome';
import {
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  buildManagedPrescriptActions,
  MANAGED_WORKABLE_APPLICATION_SCOPE_SELECTOR,
} from './portalSubmission';

const MANAGED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const MANAGED_SUBMISSION_ATTEMPT = Object.freeze({
  runId: '11111111-1111-4111-8111-111111111111',
  claimId: '22222222-2222-4222-8222-222222222222',
  executionId: '33333333-3333-4333-8333-333333333333',
});
const MANAGED_TERMINAL_RESULT_ID = 'a'.repeat(64);
const OTHER_MANAGED_TERMINAL_RESULT_ID = 'b'.repeat(64);

const managedProviderDeadlineAt = () => new Date(Date.now() + 240_000).toISOString();

test('database-clock dispatch validation refuses a continuation without its full safe window', () => {
  const clockNow = Date.parse('2026-08-31T10:00:00.000Z');
  const providerDeadlineAt = '2026-08-31T10:01:10.000Z';
  const budget = startManagedBrowserRequestBudget(70_000);
  assert.doesNotThrow(() => assertManagedBrowserRequestBudgetAtClock(
    budget,
    providerDeadlineAt,
    60_000,
    clockNow,
  ));
  assert.throws(
    () => assertManagedBrowserRequestBudgetAtClock(
      budget,
      providerDeadlineAt,
      60_000,
      clockNow + 10_001,
    ),
    (error: unknown) => error instanceof DOMException
      && error.name === 'TimeoutError'
      && /safe provider dispatch window/i.test(error.message),
  );
  assert.throws(
    () => assertManagedBrowserRequestBudgetAtClock(
      budget,
      '2026-08-31 10:01:10Z',
      60_000,
      clockNow,
    ),
    /canonical timestamp/i,
  );
});

test('provider reservation lookup rejects malformed nonempty results and accepts only exact ids', async () => {
  const previousKey = process.env.BROWSERBASE_API_KEY;
  const previousRoot = process.env.BROWSERBASE_API_ROOT;
  const previousFetch = globalThis.fetch;
  process.env.BROWSERBASE_API_KEY = 'browserbase-query-validation-test-key';
  process.env.BROWSERBASE_API_ROOT = 'https://browserbase.example/v1';
  const payloads: unknown[] = [
    {},
    { sessions: null },
    [{}],
    [{ id: '' }],
    [{ id: ' session-with-padding ' }],
    [],
    { sessions: [{ id: 'exact-provider-session' }] },
  ];
  try {
    globalThis.fetch = (async (input) => {
      assert.match(String(input), /^https:\/\/browserbase\.example\/v1\/sessions\?q=/);
      return new Response(JSON.stringify(payloads.shift()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    for (let index = 0; index < 5; index += 1) {
      await assert.rejects(
        browserSessionsForResourceReservation('11111111-1111-4111-8111-111111111111', 'browserbase'),
        /invalid session|exact resource id/i,
      );
    }
    assert.deepEqual(
      await browserSessionsForResourceReservation('11111111-1111-4111-8111-111111111111', 'browserbase'),
      [],
    );
    assert.deepEqual(
      await browserSessionsForResourceReservation('11111111-1111-4111-8111-111111111111', 'browserbase'),
      [{ id: 'exact-provider-session' }],
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.BROWSERBASE_API_KEY;
    else process.env.BROWSERBASE_API_KEY = previousKey;
    if (previousRoot === undefined) delete process.env.BROWSERBASE_API_ROOT;
    else process.env.BROWSERBASE_API_ROOT = previousRoot;
  }
});

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
          resultId: MANAGED_TERMINAL_RESULT_ID,
          acknowledgedAt: '2026-08-31T10:00:01.000Z',
          cleanupState: 'completed',
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        state: 'completed',
        resultId: MANAGED_TERMINAL_RESULT_ID,
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
    if (terminal.state !== 'completed') assert.fail('Expected a completed terminal result');
    assert.equal(terminal.resultId, MANAGED_TERMINAL_RESULT_ID);
    await acknowledgeManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT, terminal.resultId);
    await acknowledgeManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT, terminal.resultId);
    assert.match(requests[0]!.url,
      /\/api\/run-results\?runId=11111111-1111-4111-8111-111111111111&claimId=22222222-2222-4222-8222-222222222222&executionId=33333333-3333-4333-8333-333333333333$/);
    assert.deepEqual(requests[1], {
      url: 'https://stratus.example/api/run-results/acknowledge',
      method: 'POST',
      body: {
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        resultId: MANAGED_TERMINAL_RESULT_ID,
      },
    });
    assert.deepEqual(requests[2], requests[1], 'an idempotent retry repeats the exact result ID');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed correlated synchronous responses require a durable terminal result ID', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  const responses = [
    { terminalResult: { resultId: MANAGED_TERMINAL_RESULT_ID } },
    {},
    { terminalResult: { resultId: MANAGED_TERMINAL_RESULT_ID.toUpperCase() } },
  ];
  try {
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { submissionAttempt?: unknown };
      const response = responses.shift()!;
      return new Response(JSON.stringify({
        run: {
          title: 'Application submitted',
          url: 'https://portal.example/complete',
          text: 'Thank you',
          submissionAttempt: body.submissionAttempt,
          ...response,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const options = {
      requestContinuation: true,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      providerDeadlineAt: managedProviderDeadlineAt(),
    };
    const run = await runManagedBrowser('https://portal.example/apply', [], options);
    assert.equal(run.terminalResult?.resultId, MANAGED_TERMINAL_RESULT_ID);
    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [], options),
      /missing its durable terminal result ID/i,
    );
    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [], options),
      /64 lowercase hexadecimal characters/i,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('a mutating read scan correlates its probe clicks yet requires no submit terminal result', async () => {
  // The bug: turning on stratus correlationRequired made a Greenhouse pre-scan 400 with
  // SUBMISSION_ATTEMPT_REQUIRED, because its option probes (click a listbox open, read it, Escape)
  // classify as mutations. scanCorrelation supplies a fresh ephemeral attempt and bounded deadline so
  // the probes are accepted, and the run mints no durable terminal result because it is not a submit.
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let sentBody: Record<string, unknown> | null = null;
  try {
    globalThis.fetch = (async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      // Stratus echoes the correlation for a read scan but, unlike a submit, mints no terminalResult.
      return new Response(JSON.stringify({
        run: {
          title: 'Application',
          url: 'https://portal.example/apply',
          text: '',
          discovered: [],
          submissionAttempt: sentBody.submissionAttempt,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const run = await runManagedBrowser(
      'https://portal.example/apply',
      buildManagedPrescriptActions('greenhouse'),
      { screenshot: false, scanCorrelation: true },
    );
    // The scan succeeded despite the response carrying no durable terminal result.
    assert.equal(run.title, 'Application');
    assert.equal(run.terminalResult, undefined);
    const body = sentBody as unknown as {
      allowSubmit?: unknown;
      requestContinuation?: unknown;
      submissionAttempt?: { runId: string; claimId: string; executionId: string };
      providerDeadlineAt?: string;
    };
    // Correlation was sent (fresh distinct v4 UUIDs), but never a submit release or a continuation.
    assert.equal(body.allowSubmit, false, 'a read scan must never release a submission');
    assert.equal(body.requestContinuation, undefined, 'a read scan must never request a continuation');
    assert.match(body.submissionAttempt!.runId, MANAGED_UUID);
    assert.match(body.submissionAttempt!.claimId, MANAGED_UUID);
    assert.match(body.submissionAttempt!.executionId, MANAGED_UUID);
    assert.equal(new Set(Object.values(body.submissionAttempt!)).size, 3, 'the three ids must be distinct');
    // The deadline leaves the bounded employer-action window stratus enforces: >12s and <=5min out.
    const remainingMs = Date.parse(body.providerDeadlineAt!) - Date.now();
    assert.equal(body.providerDeadlineAt, new Date(Date.parse(body.providerDeadlineAt!)).toISOString());
    assert.ok(remainingMs > 12_000 && remainingMs <= 300_000, `deadline out of bounds: ${remainingMs}ms`);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('the read scan waits for the application form to render before discovering it', () => {
  /* REGRESSION GUARD (2026-09-01). The scan navigates at waitUntil:'domcontentloaded', which fires
     before a React ATS (Ashby, and every other SPA board) has rendered its form. Measured live: the
     Ashby raw HTML carried 0 form controls while the rendered form had 28. Without a form-ready wait,
     discover walked an empty DOM and returned nothing -> discovery_status 'form_not_reached' -> the
     onboarding pre-scan read nothing on every SPA board (only server-rendered Greenhouse scanned ok).
     The wait must exist and must precede discover. */
  for (const portal of ['ashby', 'greenhouse', 'lever', 'workable'] as const) {
    const actions = buildManagedPrescriptActions(portal);
    const readyAt = actions.findIndex((a) =>
      a.type === 'waitForSelector' && (a as { label?: string }).label === 'prescript_application_form_ready');
    const discoverAt = actions.findIndex((a) => a.type === 'discover');
    assert.ok(readyAt !== -1, `${portal}: the scan must wait for the form to render`);
    assert.ok(discoverAt !== -1 && readyAt < discoverAt, `${portal}: the form-ready wait must precede discover`);
    const ready = actions[readyAt] as { optional?: boolean; selector?: string };
    assert.equal(ready.optional, true, `${portal}: the wait is optional so a form-less page still falls through`);
    assert.match(String(ready.selector), /input|textarea|combobox/, `${portal}: it waits for a real form control`);
  }
});

test('a read scan refuses to double as a submission and still verifies the correlation echo', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  try {
    // scanCorrelation and a submit release are mutually exclusive: a scan is not a submission.
    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [], { scanCorrelation: true, allowSubmit: true }),
      /cannot also release a submission or request a continuation/i,
    );
    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [], { scanCorrelation: true, requestContinuation: true }),
      /cannot also release a submission or request a continuation/i,
    );
    // The echo still binds the result to the exact correlation sent: a mismatch is refused.
    globalThis.fetch = (async () => new Response(JSON.stringify({
      run: {
        title: 'Application',
        url: 'https://portal.example/apply',
        text: '',
        submissionAttempt: {
          runId: '99999999-9999-4999-8999-999999999999',
          claimId: '88888888-8888-4888-8888-888888888888',
          executionId: '77777777-7777-4777-8777-777777777777',
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await assert.rejects(
      runManagedBrowser(
        'https://portal.example/apply',
        buildManagedPrescriptActions('greenhouse'),
        { screenshot: false, scanCorrelation: true },
      ),
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

test('an uncorrelated managed run that mutates the employer page is refused before any provider call', async () => {
  /* The first live post-cutover managed fill, application e4b0420c (OpenAI, Ashby, 2026-09-01):
   * the prepare-path fill launched with no correlation at all, stratus's correlation-required mode
   * (the DEFAULT) refused it with SUBMISSION_ATTEMPT_REQUIRED, and every managed fill in the
   * 25-board campaign failed fail-closed. Stratus classifies ANY mutating action as
   * boundary-capable, so the launch site can know it needs a correlation from its own action list.
   * This guard turns the next uncorrelated call site into a local failure that spends neither a
   * token nor a provider session. */
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let fetchCalls = 0;
  let sentBody: Record<string, unknown> | null = null;
  try {
    globalThis.fetch = (async (_input, init) => {
      fetchCalls += 1;
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        run: { title: 'Application', url: 'https://portal.example/apply', text: '' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [
        { type: 'fill', selector: '#first_name', text: 'Mehek' },
      ]),
      /requires a durable submission attempt or a scan correlation.*first mutating action: fill/i,
    );
    assert.equal(fetchCalls, 0, 'the refusal must happen before the provider is called');
    // Read-only runs (the jobExtract shape) stay legal without any correlation: stratus does not
    // require an attempt for them, and they must not start minting throwaway ones.
    const readOnly = await runManagedBrowser('https://portal.example/apply', [
      { type: 'waitForSelector', selector: '.litos-jd-extract-render-delay-noop', timeout: 5000, optional: true },
      { type: 'extract', selector: 'body' },
    ]);
    assert.equal(readOnly.title, 'Application');
    assert.equal(fetchCalls, 1);
    // ABSENCE ON THE WIRE, not merely a passing run. If a later refactor made the scan pair
    // unconditional, every jobExtract and probe read would start sending throwaway attempt UUIDs to
    // stratus, and a test that only checked the run succeeded would stay green through it.
    assert.equal('submissionAttempt' in sentBody!, false, 'a read must send no correlation');
    assert.equal('providerDeadlineAt' in sentBody!, false, 'a read must send no provider deadline');
    // A LOCAL CHANGE-DETECTOR, NOT A LOCKSTEP PROOF. The invariant that matters lives in
    // stratus-browser-cloud's READ_ONLY_ACTIONS; nothing here can see that repo, so this catches an
    // accidental edit to the set and cannot catch drift from stratus.
    assert.deepEqual(
      [...MANAGED_READ_ONLY_ACTION_TYPES].sort(),
      ['discover', 'extract', 'requireCapability', 'waitForSelector'],
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('a prepare-path fill widens its scan deadline to cover the provider run budget', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let sentBody: Record<string, unknown> | null = null;
  try {
    globalThis.fetch = (async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        run: {
          title: 'Application',
          url: 'https://portal.example/apply',
          text: '',
          submissionAttempt: sentBody.submissionAttempt,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const before = Date.now();
    await runManagedBrowser(
      'https://portal.example/apply',
      [{ type: 'fill', selector: '#first_name', text: 'Mehek' }],
      MANAGED_PREPARE_SCAN_OPTIONS,
    );
    const after = Date.now();
    const body = sentBody as unknown as { allowSubmit?: unknown; providerDeadlineAt?: string };
    assert.equal(body.allowSubmit, false, 'a prepare fill must never release a submission');
    /* THE TWO CLOCKS STRATUS DERIVES FROM THIS ONE VALUE, and why 280s is a ceiling rather than a
     * preference. The sandbox acts until deadline minus its 10s response margin; the host waits for
     * the result only min(270s, deadline minus 2s). A deadline above 280s puts the sandbox's window
     * past the host's wait, so a fill finishing in that band has already touched the employer form
     * and gets discarded as RUN_TIMED_OUT. At exactly 280s the sandbox window equals stratus's own
     * 270s run budget, which is the largest window that can actually produce a result. */
    /* MEASURED AGAINST BOTH ENDPOINTS, because the deadline's own clock reading happens inside the
     * call, at some t with before <= t <= after. Comparing it to `before` alone made the ceiling
     * hold only when those two readings landed in the same millisecond, so scheduling jitter alone
     * failed the run: CI 33733628538 reported `280001ms`, and a re-run with no code change passed.
     * Each half below is compared against the endpoint that can only absorb jitter, never manufacture
     * it, so neither can red on a slow runner. That leaves each half loose by the jitter rather than
     * exact -- a deviation of a millisecond or two is invisible here -- which is why the literal
     * `assert.equal` on the constant below stays: THAT is the exact pin on 280s, and these two prove
     * the value actually sent on the wire is the one derived from it. */
    const deadlineAtMs = Date.parse(body.providerDeadlineAt!);
    assert.ok(
      deadlineAtMs - after <= 420_000,
      `deadline above the 420s ceiling: ${deadlineAtMs - after}ms past the post-call clock`,
    );
    assert.ok(
      deadlineAtMs - before >= 420_000,
      `deadline short of the 420s budget: ${deadlineAtMs - before}ms past the pre-call clock`,
    );
    assert.equal(MANAGED_PREPARE_FILL_DEADLINE_MS, 420_000);
    /* The Railway local runner waits deadline + 5s, capped at its MAX_RUN_TIMEOUT_MS of 480s: the
       host must outlast the runner's own stop, or a run finishing inside its window is thrown away. */
    assert.ok(
      MANAGED_PREPARE_FILL_DEADLINE_MS + 5_000 <= 480_000,
      'the action window must not outlast the local runner host wait',
    );
    // A widened deadline without the scan correlation is a usage error, not a silent no-op.
    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [], { scanDeadlineMs: MANAGED_PREPARE_FILL_DEADLINE_MS }),
      /only meaningful on a scan-correlated run/i,
    );
    // A window computed down to zero (or past the provider maximum) is a configuration bug and must
    // say so, rather than minting an expired deadline that reads as a provider timeout downstream.
    for (const scanDeadlineMs of [0, -1, 12_000, 480_001, 1.5]) {
      await assert.rejects(
        runManagedBrowser(
          'https://portal.example/apply',
          [{ type: 'fill', selector: '#first_name', text: 'Mehek' }],
          { scanCorrelation: true, scanDeadlineMs },
        ),
        /more than 12 seconds and at most 8 minutes/i,
        `scanDeadlineMs ${scanDeadlineMs} must be refused`,
      );
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('a real submit still requires allowSubmit, correlation, and a durable terminal result', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let sentBody: Record<string, unknown> | null = null;
  const responses = [
    { terminalResult: { resultId: MANAGED_TERMINAL_RESULT_ID } },
    {},
  ];
  try {
    globalThis.fetch = (async (_input, init) => {
      sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const extra = responses.shift()!;
      return new Response(JSON.stringify({
        run: {
          title: 'Application submitted',
          url: 'https://portal.example/complete',
          text: 'Thank you',
          submissionAttempt: (sentBody as { submissionAttempt?: unknown }).submissionAttempt,
          ...extra,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    // A submit run that DOES carry a durable terminal result succeeds and sends allowSubmit true.
    const run = await runManagedBrowser('https://portal.example/apply', [], {
      allowSubmit: true,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      providerDeadlineAt: managedProviderDeadlineAt(),
    });
    assert.equal(run.terminalResult?.resultId, MANAGED_TERMINAL_RESULT_ID);
    assert.equal((sentBody as unknown as { allowSubmit?: unknown }).allowSubmit, true);
    // A submit run WITHOUT a terminal result is still refused: the invariant is untouched by the scan path.
    await assert.rejects(
      runManagedBrowser('https://portal.example/apply', [], {
        allowSubmit: true,
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        providerDeadlineAt: managedProviderDeadlineAt(),
      }),
      /missing its durable terminal result ID/i,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed terminal retrieval refuses terminal records without an exact result ID', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  const responses = [undefined, MANAGED_TERMINAL_RESULT_ID.toUpperCase()];
  try {
    globalThis.fetch = (async () => {
      const resultId = responses.shift();
      return new Response(JSON.stringify({
        state: 'failed',
        ...(resultId ? { resultId } : {}),
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        completedAt: '2026-08-31T10:00:00.000Z',
        expiresAt: '2026-09-30T10:00:00.000Z',
        error: { code: 'SANDBOX_RUN_FAILED', message: 'Provider response stream reset' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    await assert.rejects(
      getManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT),
      /terminal result ID must be 64 lowercase hexadecimal characters/i,
    );
    await assert.rejects(
      getManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT),
      /terminal result ID must be 64 lowercase hexadecimal characters/i,
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed terminal acknowledgement never sends a missing or mismatched result ID', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let fetches = 0;
  try {
    globalThis.fetch = (async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        acknowledged: true,
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
        resultId: OTHER_MANAGED_TERMINAL_RESULT_ID,
        acknowledgedAt: '2026-08-31T10:00:01.000Z',
        cleanupState: 'completed',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    await assert.rejects(
      acknowledgeManagedBrowserTerminalResult(
        MANAGED_SUBMISSION_ATTEMPT,
        undefined as unknown as string,
      ),
      /64 lowercase hexadecimal characters/i,
    );
    assert.equal(fetches, 0, 'an invalid result ID is refused before any network request');
    await assert.rejects(
      acknowledgeManagedBrowserTerminalResult(
        MANAGED_SUBMISSION_ATTEMPT,
        MANAGED_TERMINAL_RESULT_ID,
      ),
      /did not match its durable result ID/i,
    );
    assert.equal(fetches, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed terminal acknowledgement surfaces a provider wrong-result rejection', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      error: {
        code: 'TERMINAL_RESULT_ID_MISMATCH',
        message: 'The terminal result ID does not match the retained result',
      },
    }), { status: 409, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    await assert.rejects(
      acknowledgeManagedBrowserTerminalResult(
        MANAGED_SUBMISSION_ATTEMPT,
        MANAGED_TERMINAL_RESULT_ID,
      ),
      /does not match the retained result/i,
    );
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

test('managed terminal retrieval rejects progress bound to another execution', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      state: 'indeterminate',
      resultId: MANAGED_TERMINAL_RESULT_ID,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      completedAt: '2026-08-31T10:01:10.000Z',
      expiresAt: '2026-09-30T10:01:10.000Z',
      error: {
        code: 'SUBMISSION_EXECUTION_INDETERMINATE',
        message: 'Managed browser execution ended without a terminal employer result',
      },
      runProgress: {
        version: 1,
        phase: 0,
        stage: 'submit_released',
        submitPressed: true,
        applicationSubmitPressed: true,
        verificationSubmitPressed: false,
        submitKind: 'application',
        policyVersion: 3,
        submissionAttempt: {
          ...MANAGED_SUBMISSION_ATTEMPT,
          executionId: '44444444-4444-4444-8444-444444444444',
        },
      },
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

test('managed terminal retrieval preserves pending, missing, expired, failed, and indeterminate states without relaunching', async () => {
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
      resultId: MANAGED_TERMINAL_RESULT_ID,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      completedAt: '2026-08-31T10:00:00.000Z',
      expiresAt: '2026-09-30T10:00:00.000Z',
      error: { code: 'SANDBOX_RUN_FAILED', message: 'Provider response stream reset' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    new Response(JSON.stringify({
      state: 'indeterminate',
      resultId: OTHER_MANAGED_TERMINAL_RESULT_ID,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      completedAt: '2026-08-31T10:01:10.000Z',
      expiresAt: '2026-09-30T10:01:10.000Z',
      error: {
        code: 'SUBMISSION_EXECUTION_INDETERMINATE',
        message: 'Managed browser execution ended without a terminal employer result',
      },
      runProgress: {
        version: 1,
        phase: 1,
        stage: 'submit_released',
        submitPressed: true,
        applicationSubmitPressed: true,
        verificationSubmitPressed: true,
        submitKind: 'verification',
        policyVersion: 3,
        submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      },
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
      assert.equal(failed.resultId, MANAGED_TERMINAL_RESULT_ID);
      assert.deepEqual(failed.error, {
        code: 'SANDBOX_RUN_FAILED',
        message: 'Provider response stream reset',
      });
    }
    const indeterminate = await getManagedBrowserTerminalResult(MANAGED_SUBMISSION_ATTEMPT);
    assert.equal(indeterminate.state, 'indeterminate');
    if (indeterminate.state === 'indeterminate') {
      assert.equal(indeterminate.resultId, OTHER_MANAGED_TERMINAL_RESULT_ID);
      assert.equal(indeterminate.runProgress?.verificationSubmitPressed, true);
      const failure = managedBrowserTerminalFailureError(indeterminate);
      assert.ok(failure instanceof ManagedBrowserProviderProgressError);
      assert.equal(failure.code, 'SUBMISSION_EXECUTION_INDETERMINATE');
      assert.equal(failure.runProgress.submissionAttempt?.executionId,
        MANAGED_SUBMISSION_ATTEMPT.executionId);
    }
    assert.equal(fetches, 5);
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
      recordSession: false,
      logSession: false,
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
      recordSession: false,
      logSession: false,
    },
  });
});

test('a context-free session carries the durable creation reservation and disables provider recordings', () => {
  assert.deepEqual(
    browserSessionBody(
      undefined,
      'https://boards.greenhouse.io/acme/jobs/123',
      'project-1',
      'browserbase',
      '11111111-1111-4111-8111-111111111111',
    ),
    {
      projectId: 'project-1',
      keepAlive: true,
      userMetadata: {
        litos_resource_reservation_id: '11111111-1111-4111-8111-111111111111',
      },
      browserSettings: {
        allowedDomains: ['boards.greenhouse.io'],
        solveCaptchas: false,
        recordSession: false,
        logSession: false,
      },
    },
  );
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

test('the run request carries a dispatcher that outwaits the 420 s fill it is asked to wait for', async () => {
  // Node's fetch aborts at undici's 300 s headersTimeout regardless of the AbortSignal; the first
  // 420 s run (TWG Global, 2026-09-05 06:08:43Z) died with "fetch failed" at 301 s. The run
  // request has to say how long it will wait for the first response byte.
  assert.ok(MANAGED_RUN_HEADERS_TIMEOUT_MS > 300_000);
  assert.equal(MANAGED_RUN_HEADERS_TIMEOUT_MS, 8 * 60 * 1000 + 60_000);
  const init = managedRunRequestInit({ method: 'POST' }) as RequestInit & { dispatcher?: unknown };
  assert.ok(init.dispatcher instanceof Agent);
  assert.equal(init.method, 'POST');
  // One dispatcher, reused: a new Agent per request would leak a connection pool per run.
  const again = managedRunRequestInit({ method: 'POST' }) as RequestInit & { dispatcher?: unknown };
  assert.equal(again.dispatcher, init.dispatcher);

  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let capturedDispatcher: unknown = null;
  globalThis.fetch = (async (_input, init) => {
    capturedDispatcher = (init as { dispatcher?: unknown } | undefined)?.dispatcher ?? null;
    const body = JSON.parse(String(init?.body)) as { submissionAttempt?: unknown };
    return new Response(JSON.stringify({ run: {
      title: 'Complete',
      url: 'https://portal.example/complete',
      text: 'Thank you',
      submissionAttempt: body.submissionAttempt,
    } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    await runManagedBrowser(
      'https://portal.example/apply',
      [{ type: 'fill', selector: '#email', value: 'person@example.com' }],
      { scanCorrelation: true },
    );
    assert.equal(capturedDispatcher, init.dispatcher);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed Stratus posts bounded actions to the private production run endpoint', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  let captured: { url?: string; key?: string | null; body?: Record<string, unknown> } = {};
  globalThis.fetch = (async (input, init) => {
    captured = {
      url: String(input),
      key: new Headers(init?.headers).get('X-Stratus-API-Key'),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({ run: {
      title: 'Complete',
      url: 'https://portal.example/complete',
      text: 'Thank you',
      submissionAttempt: captured.body?.submissionAttempt,
    } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  // A fill mutates the employer page, so the launch must carry a correlation to be legal at all
  // (runManagedBrowser refuses it locally otherwise; stratus's required mode would refuse it at
  // the provider). The ephemeral scan pair is the non-submit correlation.
  const result = await runManagedBrowser(
    'https://portal.example/apply',
    [{ type: 'fill', selector: '#email', value: 'person@example.com' }],
    { scanCorrelation: true },
  );
  assert.equal(result.title, 'Complete');
  assert.equal(captured.url, 'https://stratus.example/api/run');
  assert.equal(captured.key, 'private-key');
  const body = { ...captured.body } as Record<string, unknown>;
  assert.match((body.submissionAttempt as { runId: string }).runId, MANAGED_UUID);
  assert.equal(typeof body.providerDeadlineAt, 'string');
  delete body.submissionAttempt;
  delete body.providerDeadlineAt;
  assert.deepEqual(body, {
    url: 'https://portal.example/apply',
    actions: [{ type: 'fill', selector: '#email', value: 'person@example.com' }],
    screenshot: true,
    // A caller that does not say allowSubmit gets a run that CANNOT submit, correlated or not.
    // Asserted on the wire, not on the option object, because the default has to survive the
    // serialization to be worth anything, and because this is the line that would have stopped a
    // fill run putting three real applications in front of three real employers on 2026-08-08.
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
      terminalResult: { resultId: MANAGED_TERMINAL_RESULT_ID },
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
            terminalResult: { resultId: MANAGED_TERMINAL_RESULT_ID },
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
          terminalResult: { resultId: OTHER_MANAGED_TERMINAL_RESULT_ID },
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
  let captured: { body?: { actions?: Array<Record<string, unknown>>; submissionAttempt?: unknown } } = {};
  globalThis.fetch = (async (_input, init) => {
    captured = { body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ run: {
      title: 'Complete',
      url: 'https://portal.example/complete',
      text: 'Thank you',
      submissionAttempt: captured.body?.submissionAttempt,
    } }), {
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
  }], { scanCorrelation: true });

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
      && error.provenBy === 'run_progress'
      && error.runProgress?.stage === 'phase_started',
  );

  /* The same refusal WITHOUT containment progress AND WITHOUT a plan to check position against
   * (outbound actions []) stays a plain error: there is no evidence of either kind, so nothing may
   * be guessed. See the next two tests for what changes once a real plan is in play. */
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

/* MEASURED 2026-09-05 12:33Z, Pony.ai fdcf4ccb-eca9-44dc-b0cb-d400805ebdeb SEND #2: the identical
 * deterministic refusal as the test above, but Stratus's response carried no `runProgress` at all -
 * so the progress-backed arm above never fired, the run fell through to a plain Error, and the row
 * was written needs_attention / unverified_submission telling the applicant to check the employer
 * portal for a click that never happened. This is the second, independent witness: the exact SEND
 * plan this repo built and sent. */
test('a deterministic assertion refusal with no progress record is typed from the plan\'s own ordering', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const refusal = 'filled_field:phone: expected exactly one match for .iti input[type="tel"], '
    + 'body:not(:has(.iti input[type="tel"])) div[data-ui="phone"] input[type="tel"], '
    + 'body:not(:has(.iti input[type="tel"])):not(:has(div[data-ui="phone"] input[type="tel"])) '
    + 'input[name="phone"], found 0';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { code: 'SANDBOX_RUN_FAILED', message: refusal },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  const actions: ManagedBrowserAction[] = [
    { type: 'fill', selector: 'input[name="firstname"]', value: 'A', label: 'first_name' },
    { type: 'extract', selector: '.iti input[type="tel"]', label: 'filled_field:phone', optional: true },
    { type: 'confirmAndSubmit', contractVersion: 2, submitKind: 'application', maxRetries: 1, chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY },
  ];
  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', actions, {
      allowSubmit: true,
      submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
      providerDeadlineAt: managedProviderDeadlineAt(),
    }),
    (error: unknown) => error instanceof ManagedBrowserAssertionFailureError
      && !(error instanceof ManagedBrowserPreSubmitCrashError)
      && error.assertionLabel === 'filled_field:phone'
      && error.provenBy === 'plan_position'
      && error.runProgress === null,
  );

  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});

/* THE AMBIGUOUS CASES STAY UNCHANGED. A refusal at or after confirmAndSubmit proves nothing about
 * whether the click happened - the run could have failed asserting something AFTER a real press -
 * so plan position must refuse rather than guess, exactly as the progress-backed arm already refuses
 * when Stratus's progress says the click might have landed. */
test('a refusal at or after confirmAndSubmit is not proven pre-click by plan position', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const refusal = 'filled_field:receipt: expected exactly one match for .receipt, found 0';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { code: 'SANDBOX_RUN_FAILED', message: refusal },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  const actions: ManagedBrowserAction[] = [
    { type: 'confirmAndSubmit', contractVersion: 2, submitKind: 'application', maxRetries: 1, chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY },
    { type: 'extract', selector: '.receipt', label: 'filled_field:receipt', optional: true },
  ];
  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', actions, {
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

test('a label that also appears at or after confirmAndSubmit is not proven pre-click by plan position', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  const refusal = 'filled_field:phone: expected exactly one match for input[name="phone"], found 0';
  globalThis.fetch = (async () => new Response(JSON.stringify({
    error: { code: 'SANDBOX_RUN_FAILED', message: refusal },
  }), {
    status: 502,
    headers: { 'Content-Type': 'application/json' },
  })) as typeof fetch;

  const actions: ManagedBrowserAction[] = [
    { type: 'extract', selector: 'input[name="phone"]', label: 'filled_field:phone', optional: false },
    { type: 'confirmAndSubmit', contractVersion: 2, submitKind: 'application', maxRetries: 1, chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY },
    { type: 'extract', selector: 'input[name="phone"]', label: 'filled_field:phone', optional: false },
  ];
  await assert.rejects(
    runManagedBrowser('https://portal.example/apply', actions, {
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
    ], { scanCorrelation: true }),
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
  let captured: { body?: { actions?: Array<Record<string, unknown>>; submissionAttempt?: unknown } } = {};
  globalThis.fetch = (async (_input, init) => {
    captured = { body: JSON.parse(String(init?.body)) };
    return new Response(JSON.stringify({ run: {
      title: 'Complete',
      url: 'https://portal.example/complete',
      text: 'Thank you',
      submissionAttempt: captured.body?.submissionAttempt,
    } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;

  await runManagedBrowser('https://portal.example/apply', [
    { type: 'fillByLabelText', text: '', value: 'Taylor', label: 'optional_empty_label', optional: true },
    { type: 'fill', selector: '#email', value: 'person@example.com', label: 'email' },
  ], { scanCorrelation: true });

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
        terminalResult: { resultId: MANAGED_TERMINAL_RESULT_ID },
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
    const body = JSON.parse(String(init?.body)) as {
      actions?: Array<Record<string, unknown>>;
      submissionAttempt?: unknown;
    };
    capturedBodies.push(body);
    const submits = body.actions?.some((action) => action.type === 'confirmAndSubmit') ?? false;
    return new Response(JSON.stringify({ run: {
      title: 'Complete',
      url: submits ? 'https://portal.example/complete' : applicationUrl,
      text: 'Thank you',
      submissionAttempt: body.submissionAttempt,
      ...(submits ? {
        terminalResult: { resultId: MANAGED_TERMINAL_RESULT_ID },
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

  // The discovery pass mutates (it fills fixed fields), so it carries the ephemeral scan pair; the
  // submit run carries the durable-attempt submit options, exactly as the runner launches them.
  await runManagedBrowser(applicationUrl, buildManagedDiscoveryActions('greenhouse', packet), { scanCorrelation: true });
  await runManagedBrowser(applicationUrl, buildManagedPortalActions('greenhouse', packet, true, applicationUrl), {
    allowSubmit: true,
    submissionAttempt: MANAGED_SUBMISSION_ATTEMPT,
    providerDeadlineAt: managedProviderDeadlineAt(),
  });

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

test('only the prepare fill run asks stratus to wait for its preview screenshot, and only as the literal true', async () => {
  /* stratus #137 honours `screenshotWait` only when it is exactly `true`, and litos-api's prepare
     fill is the one run whose missing screenshot is fatal (submissionRunner throws on it), so the
     fill options say the word and the shared scan options, which the discovery pass and every
     read scan use, do not. Pinned on the wire, because the runner side of this contract cannot
     see which caller forgot. */
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example/';
  const sentBodies: Record<string, unknown>[] = [];
  try {
    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      sentBodies.push(body);
      return new Response(JSON.stringify({
        run: {
          title: 'Application',
          url: 'https://portal.example/apply',
          text: '',
          discovered: [],
          submissionAttempt: body.submissionAttempt,
        },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    await runManagedBrowser('https://portal.example/apply', [], MANAGED_PREPARE_FILL_OPTIONS);
    await runManagedBrowser('https://portal.example/apply', [], MANAGED_PREPARE_SCAN_OPTIONS);
    await runManagedBrowser('https://portal.example/apply', [], { ...MANAGED_PREPARE_SCAN_OPTIONS, screenshotWait: false });
    assert.equal(sentBodies.length, 3);
    assert.equal(sentBodies[0].screenshotWait, true, 'the fill run asks for the wait');
    assert.equal(sentBodies[0].screenshot, true, 'and still wants the screenshot itself');
    assert.equal('screenshotWait' in sentBodies[1], false, 'the discovery pass and read scans do not');
    assert.equal('screenshotWait' in sentBodies[2], false, 'false is never sent, only the literal true');
    // The fill options are the scan options plus the flag: same correlation, same widened window.
    assert.equal(MANAGED_PREPARE_FILL_OPTIONS.scanCorrelation, true);
    assert.equal(MANAGED_PREPARE_FILL_OPTIONS.scanDeadlineMs, MANAGED_PREPARE_FILL_DEADLINE_MS);
    assert.equal(MANAGED_PREPARE_FILL_OPTIONS.scanDeadlineMs, MANAGED_PREPARE_SCAN_OPTIONS.scanDeadlineMs);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});
