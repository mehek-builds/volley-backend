import assert from 'node:assert/strict';
import test from 'node:test';
import { browserSessionBody, isBrowserbaseConfigured, runManagedBrowser } from './browserbase';

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
    waitUntil: 'networkidle2',
  });
  globalThis.fetch = previousFetch;
  if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
  else process.env.STRATUS_API_KEY = previousKey;
  if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
  else process.env.STRATUS_BASE_URL = previousUrl;
});
