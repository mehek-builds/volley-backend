import assert from 'node:assert/strict';
import test from 'node:test';
import { browserSessionBody, isBrowserbaseConfigured, runManagedBrowser } from './browserbase';
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

test('managed Stratus requires its production URL and private API key', () => {
  const previousProvider = process.env.BROWSER_PROVIDER;
  const previousStratusKey = process.env.STRATUS_API_KEY;
  const previousStratusUrl = process.env.STRATUS_BASE_URL;
  const previousVercelEnv = process.env.VERCEL_ENV;
  process.env.BROWSER_PROVIDER = 'stratus-managed';
  delete process.env.STRATUS_API_KEY;
  process.env.STRATUS_BASE_URL = 'https://stratus-browser-cloud.vercel.app';
  assert.equal(isBrowserbaseConfigured(), false);
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
    fullPage: true,
    waitUntil: 'domcontentloaded',
  });
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
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
