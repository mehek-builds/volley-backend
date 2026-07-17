import { test, after } from 'node:test';
import assert from 'node:assert/strict';

// src/index.ts calls start() on import unless VERCEL is set, so this must be set before the
// dynamic import below or the test process hangs on a live listener. Static imports hoist,
// which is why buildApp is pulled in lazily inside getApp() rather than at the top.
process.env.VERCEL = '1';
process.env.LOG_LEVEL = 'silent';
process.env.DATABASE_URL ??= 'postgresql://postgres:password@localhost:5432/unused-in-these-tests';
process.env.JWT_SIGNING_SECRET ??= 'test-signing-secret-32-chars-minimum!!';
process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

type App = Awaited<ReturnType<typeof import('./index')['buildApp']>>;

let appPromise: Promise<App> | null = null;
async function getApp(): Promise<App> {
  if (!appPromise) {
    appPromise = (async () => {
      const { buildApp } = await import('./index');
      const app = await buildApp();
      await app.ready();
      return app;
    })();
  }
  return appPromise;
}

after(async () => {
  if (appPromise) await (await appPromise).close();
});

const ATS_ORIGIN = 'https://job-boards.greenhouse.io';
const EVIL_ORIGIN = 'https://evil.example.com';
const SITE_ORIGIN = 'https://role-quick-website.vercel.app';
const EXT_ORIGIN = 'chrome-extension://bdbedbmkjpfioknfpmhookefabipjaad';

// These four cover the CORS carve-out that /resume/download depends on. Getting any of them
// wrong fails silently in exactly the way that hurts: the fill still "works", the resume file
// just never attaches, and nothing logs an error.

test('/resume/download is readable from an ATS page origin', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/resume/download?t=x', headers: { origin: ATS_ORIGIN } });
  // The content script fetches this from whatever job board the student is on, so the response
  // must be readable there. Without this header the fetch throws and the resume silently never
  // attaches to the application.
  assert.equal(res.headers['access-control-allow-origin'], ATS_ORIGIN);
  // Ambient credentials must never be attachable to a route whose auth is a URL token.
  assert.equal(res.headers['access-control-allow-credentials'], undefined);
});

test('/resume/download refuses a missing or unusable token', async () => {
  const app = await getApp();
  const missing = await app.inject({ method: 'GET', url: '/resume/download' });
  assert.equal(missing.statusCode, 400);

  const garbage = await app.inject({ method: 'GET', url: '/resume/download?t=garbage' });
  assert.equal(garbage.statusCode, 403);

  const { mintDownloadToken, resumePrefix } = await import('./lib/resumeAccess');
  const user = '11111111-1111-4111-8111-111111111111';
  const stale = mintDownloadToken(user, `${resumePrefix(user)}x.pdf`, { now: Date.now() - 60 * 60 * 1000 });
  const expired = await app.inject({ method: 'GET', url: `/resume/download?t=${stale}` });
  assert.equal(expired.statusCode, 403);
});

test('the download carve-out does not open up any other route', async () => {
  const app = await getApp();
  // An arbitrary site must not be able to read an authed response, which is the whole point of
  // the allowlist the delegator has to keep intact.
  const evil = await app.inject({ method: 'GET', url: '/profile', headers: { origin: EVIL_ORIGIN } });
  assert.equal(evil.headers['access-control-allow-origin'], undefined);

  const evilPreflight = await app.inject({
    method: 'OPTIONS',
    url: '/profile',
    headers: { origin: EVIL_ORIGIN, 'access-control-request-method': 'GET' },
  });
  assert.equal(evilPreflight.headers['access-control-allow-origin'], undefined);
});

test('the website and the extension keep their allowlisted access', async () => {
  const app = await getApp();
  const site = await app.inject({ method: 'GET', url: '/profile', headers: { origin: SITE_ORIGIN } });
  assert.equal(site.headers['access-control-allow-origin'], SITE_ORIGIN);
  assert.equal(site.headers['access-control-allow-credentials'], 'true');

  const ext = await app.inject({
    method: 'OPTIONS',
    url: '/profile',
    headers: { origin: EXT_ORIGIN, 'access-control-request-method': 'GET' },
  });
  assert.equal(ext.statusCode, 204);
  assert.equal(ext.headers['access-control-allow-origin'], EXT_ORIGIN);
});

test('account export and deletion require auth', async () => {
  const app = await getApp();
  assert.equal((await app.inject({ method: 'GET', url: '/account/export' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'DELETE', url: '/account' })).statusCode, 401);
});

test('the retention sweep is not runnable by an anonymous caller', async () => {
  const app = await getApp();
  const internal = process.env.INTERNAL_CRON_SECRET;
  const cron = process.env.CRON_SECRET;
  process.env.INTERNAL_CRON_SECRET = 'test-internal-secret';
  delete process.env.CRON_SECRET;
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/internal/resume-retention-sweep' })).statusCode, 401);
    const wrong = await app.inject({
      method: 'GET',
      url: '/internal/resume-retention-sweep',
      headers: { 'x-internal-secret': 'wrong' },
    });
    assert.equal(wrong.statusCode, 401);
  } finally {
    if (internal === undefined) delete process.env.INTERNAL_CRON_SECRET;
    else process.env.INTERNAL_CRON_SECRET = internal;
    if (cron !== undefined) process.env.CRON_SECRET = cron;
  }
});
