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

test('the global error boundary preserves client errors and hides server internals', async () => {
  const { toPublicError } = await import('./index');

  assert.deepEqual(toPublicError({ statusCode: 400, message: 'Invalid request' }), {
    statusCode: 400,
    message: 'Invalid request',
  });
  assert.deepEqual(toPublicError(new Error('DATABASE_URL=postgres://secret-host')), {
    statusCode: 500,
    message: 'Internal server error',
  });
  assert.deepEqual(toPublicError({ statusCode: 700, message: 'Unexpected internal state' }), {
    statusCode: 500,
    message: 'Internal server error',
  });
});

const ATS_ORIGIN = 'https://job-boards.greenhouse.io';
const EVIL_ORIGIN = 'https://evil.example.com';
const SITE_ORIGIN = 'https://trylitos.com';
const WWW_SITE_ORIGIN = 'https://www.trylitos.com';
const VERCEL_SITE_ORIGIN = 'https://role-quick-website.vercel.app';
const EXT_ORIGIN = 'chrome-extension://bdbedbmkjpfioknfpmhookefabipjaad';

test('/v1/meta publishes the cacheable Litos client contract', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/v1/meta' });
  assert.equal(res.statusCode, 200);
  assert.match(String(res.headers['cache-control']), /max-age=300/);
  const body = res.json();
  assert.equal(body.product.name, 'Litos');
  assert.equal(body.api.version, '1');
  assert.equal(body.api.compatibility.extension.minimum, '0.4.4');
});

test('/health identifies the deployable service and revision contract', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.service, 'litos-api');
  assert.equal(body.product, 'Litos');
  assert.equal(body.api_version, '1');
  assert.ok(Object.hasOwn(body, 'revision'));
  // `build` is what makes the DEPLOY.md check work on a CLI deploy, where VERCEL_GIT_COMMIT_SHA is
  // not set and `revision` is null. The key must always be present for the runbook to rely on it.
  assert.ok(Object.hasOwn(body, 'build'));
});

test('/health identifies the build even when no git SHA is exposed', async () => {
  // The exact production shape this exists for: a `vercel deploy --prod` sets VERCEL_DEPLOYMENT_ID
  // but not VERCEL_GIT_COMMIT_SHA, and on 2026-08-04 that made /health report `revision: null` for
  // a deployment that was live and correct. Confirming what shipped took three Vercel API calls.
  const saved = {
    sha: process.env.VERCEL_GIT_COMMIT_SHA,
    gitSha: process.env.GIT_SHA,
    id: process.env.VERCEL_DEPLOYMENT_ID,
    url: process.env.VERCEL_URL,
  };
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.GIT_SHA;
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test123';
  try {
    const { buildApp } = await import('./index');
    const app = await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    assert.equal(body.revision, null, 'this is the case where the SHA is genuinely unavailable');
    assert.equal(body.build, 'dpl_test123', 'and the build id is what identifies the deploy instead');
    await app.close();
  } finally {
    for (const [k, v] of [
      ['VERCEL_GIT_COMMIT_SHA', saved.sha],
      ['GIT_SHA', saved.gitSha],
      ['VERCEL_DEPLOYMENT_ID', saved.id],
      ['VERCEL_URL', saved.url],
    ] as Array<[string, string | undefined]>) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test('the deployment URL carries the identity when only the older variable is set', async () => {
  // VERCEL_URL predates VERCEL_DEPLOYMENT_ID and is set on every deployment, so it is the fallback
  // rather than an equal: it holds the same identity in a hostname.
  const saved = { id: process.env.VERCEL_DEPLOYMENT_ID, url: process.env.VERCEL_URL };
  delete process.env.VERCEL_DEPLOYMENT_ID;
  process.env.VERCEL_URL = 'litos-abc123-team.vercel.app';
  try {
    const { buildApp } = await import('./index');
    const app = await buildApp();
    assert.equal((await app.inject({ method: 'GET', url: '/health' })).json().build, 'litos-abc123-team.vercel.app');
    await app.close();
  } finally {
    if (saved.id === undefined) delete process.env.VERCEL_DEPLOYMENT_ID;
    else process.env.VERCEL_DEPLOYMENT_ID = saved.id;
    if (saved.url === undefined) delete process.env.VERCEL_URL;
    else process.env.VERCEL_URL = saved.url;
  }
});

test('front-door limiter isolates clients and emits standard retry metadata', async () => {
  const { buildApp } = await import('./index');
  const policy = { name: 'general', limit: 2, windowMs: 60_000 };
  const limitedApp = await buildApp({
    rateLimit: {
      general: policy,
      board: { name: 'board', limit: 2, windowMs: 60_000 },
      authStart: { name: 'auth_start', limit: 1, windowMs: 60_000 },
      authVerify: { name: 'auth_verify', limit: 1, windowMs: 60_000 },
      download: { name: 'resume_download', limit: 1, windowMs: 60_000 },
      maxKeys: 100,
    },
    now: () => 1_000,
  });
  await limitedApp.ready();

  try {
    const request = (ip: string) =>
      limitedApp.inject({ method: 'GET', url: '/missing', headers: { 'x-forwarded-for': ip } });

    assert.equal((await request('203.0.113.10')).statusCode, 404);
    const second = await request('203.0.113.10');
    assert.equal(second.statusCode, 404);
    assert.equal(second.headers['ratelimit-remaining'], '0');

    const blocked = await request('203.0.113.10');
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.headers['retry-after'], '60');
    assert.equal(blocked.headers['ratelimit-limit'], '2');
    assert.equal(blocked.json().code, 'rate_limited');

    assert.equal((await request('203.0.113.11')).statusCode, 404);
    assert.equal((await limitedApp.inject({ method: 'GET', url: '/health' })).statusCode, 200);
  } finally {
    await limitedApp.close();
  }
});

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

  const wwwSite = await app.inject({ method: 'GET', url: '/profile', headers: { origin: WWW_SITE_ORIGIN } });
  assert.equal(wwwSite.headers['access-control-allow-origin'], WWW_SITE_ORIGIN);

  const vercelSite = await app.inject({ method: 'GET', url: '/profile', headers: { origin: VERCEL_SITE_ORIGIN } });
  assert.equal(vercelSite.headers['access-control-allow-origin'], VERCEL_SITE_ORIGIN);

  const ext = await app.inject({
    method: 'OPTIONS',
    url: '/profile',
    headers: { origin: EXT_ORIGIN, 'access-control-request-method': 'GET' },
  });
  assert.equal(ext.statusCode, 204);
  assert.equal(ext.headers['access-control-allow-origin'], EXT_ORIGIN);
});

test('/privacy redirects to the canonical trylitos.com policy', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/privacy' });

  assert.equal(res.statusCode, 301);
  assert.equal(res.headers.location, 'https://trylitos.com/privacy');
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
