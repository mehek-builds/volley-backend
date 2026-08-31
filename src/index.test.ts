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

/* THE MODEL PROBE IS STUBBED IN EVERY TEST APP, and it is not optional politeness.
 *
 * src/index.ts imports dotenv/config, so a developer's .env puts a real ANTHROPIC_API_KEY into
 * this process, and /health calls the model. Left alone, every assertion below would make a live,
 * billed call to Anthropic: measured at 419ms of real network per run. It is free today only
 * because the balance this change is about is empty, so the bill arrives the moment it is topped
 * up. A test suite must not spend money, and must not need a network to pass. */
const HEALTH_TEST_OPTIONS = { modelPing: async () => undefined };

let appPromise: Promise<App> | null = null;
async function getApp(): Promise<App> {
  if (!appPromise) {
    appPromise = (async () => {
      const { buildApp } = await import('./index');
      const app = await buildApp(HEALTH_TEST_OPTIONS);
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
  /* 200 or 503, and the identity contract holds on BOTH. /health probes the database now, so it
     answers 503 when it cannot reach one, which a unit test cannot. That is the point rather than an
     inconvenience: DEPLOY.md reads `revision` from this response to confirm what shipped, and the
     moment you most need that is an incident, when the status will be 503. Asserting 200 here would
     pin the opposite of the property the runbook depends on. */
  assert.ok([200, 503].includes(res.statusCode), `unexpected status ${res.statusCode}`);
  const body = res.json();

  // The database contract, which is why this endpoint stopped being a liveness ping. Before
  // 2026-08-04 it touched nothing and answered 200 through a 75-minute outage in which every other
  // route returned 500.
  assert.ok(['ok', 'unreachable'].includes(body.database), `unexpected database ${body.database}`);
  assert.equal(
    res.statusCode,
    body.database === 'ok' && body.submission_authority.ready ? 200 : 503,
    'status code must fail closed when the database or submission authority schema is unavailable',
  );
  /* The aggregate follows EVERY dependency, not the database alone. This asserted
     `database === 'ok' ? 'ok' : 'degraded'` and passed only because the test DATABASE_URL is
     unreachable, so both sides read 'degraded' by coincidence. A degraded application email
     already broke that equivalence, and the model probe added a second way, so it would have
     failed the first time this ran anywhere with a reachable database. */
  const anyDependencyDown = body.database !== 'ok'
    || body.model === 'unavailable'
    || body.application_email?.status === 'degraded';
  assert.equal(body.status, anyDependencyDown ? 'degraded' : 'ok');
  if (body.database !== 'ok') {
    // Coarse on purpose: /health is public, so the driver's message never reaches it.
    assert.ok(['timeout', 'quota', 'refused', 'error'].includes(body.database_reason));
  }

  assert.equal(body.service, 'litos-api');
  assert.equal(body.product, 'Litos');
  assert.equal(body.api_version, '1');
  assert.ok(Object.hasOwn(body, 'revision'));
  // `build` is what makes the DEPLOY.md check work on a CLI deploy, where VERCEL_GIT_COMMIT_SHA is
  // not set and `revision` is null. The key must always be present for the runbook to rely on it.
  assert.ok(Object.hasOwn(body, 'build'));
  // `revision_source` is what makes a null revision DIAGNOSABLE. DEPLOY.md's table keys off these
  // three values, so the set is part of the contract and not an implementation detail.
  assert.ok(Object.hasOwn(body, 'revision_source'));
  assert.equal(typeof body.submission_authority.ready, 'boolean');
  assert.equal(typeof body.submission_authority.attempt_ledger.ready, 'boolean');
  assert.equal(typeof body.submission_authority.attempt_ledger.reason, 'string');
  assert.equal(typeof body.submission_authority.revision.ready, 'boolean');
  assert.equal(typeof body.submission_authority.revision.reason, 'string');
  assert.ok(
    ['vercel-git', 'git-sha', 'none'].includes(body.revision_source),
    `unexpected revision_source ${JSON.stringify(body.revision_source)}`,
  );
  // The two fields cannot disagree: a source of 'none' with a SHA, or a SHA with no source, would
  // each send a reader of the runbook down the wrong path.
  assert.equal(
    body.revision === null,
    body.revision_source === 'none',
    'revision and revision_source must agree about whether the commit is known',
  );
});

test('submission cutover runs before auth and publishes only its effective configuration', async () => {
  const saved = process.env.SUBMISSION_CUTOVER_MODE;
  const opened: App[] = [];
  const { buildApp } = await import('./index');
  const appFor = async (mode: string) => {
    process.env.SUBMISSION_CUTOVER_MODE = mode;
    const app = await buildApp(HEALTH_TEST_OPTIONS);
    await app.ready();
    opened.push(app);
    return app;
  };
  const applicationId = '11111111-2222-4333-8444-555555555555';

  try {
    const off = await appFor('off');
    const ordinaryUnauthorized = await off.inject({
      method: 'POST',
      url: `/applications/${applicationId}/submit-request`,
    });
    assert.equal(ordinaryUnauthorized.statusCode, 401, 'off mode preserves the route auth boundary');

    const drain = await appFor('drain');
    const fenced = await drain.inject({
      method: 'POST',
      url: `/applications/${applicationId}/submit-request/?source=cutover-test`,
      headers: { origin: SITE_ORIGIN },
    });
    assert.equal(fenced.statusCode, 503, 'the cutover response wins over the missing-auth response');
    assert.equal(fenced.json().code, 'SUBMISSION_CUTOVER_DRAINING');
    assert.equal(fenced.headers['cache-control'], 'no-store');
    assert.match(String(fenced.headers['retry-after']), /^\d+$/);
    assert.equal(typeof fenced.json().retry_after_seconds, 'number');
    assert.equal(fenced.headers['ratelimit-limit'], undefined, 'the cutover hook runs before rate limiting');
    assert.equal(fenced.headers['access-control-allow-origin'], SITE_ORIGIN, 'browser clients can read the fence');

    const prospectiveIssuer = await drain.inject({
      method: 'POST',
      url: `/applications/${applicationId}/manual-submission-start`,
    });
    assert.equal(prospectiveIssuer.statusCode, 503, 'future issuers are fenced before route registration');
    assert.equal(prospectiveIssuer.json().code, 'SUBMISSION_CUTOVER_DRAINING');

    for (const request of [
      { method: 'POST' as const, url: `/applications/${applicationId}/future-issuer` },
      { method: 'POST' as const, url: `/applications/${applicationId}/packet-audit` },
      { method: 'POST' as const, url: '/resume/generate' },
      { method: 'GET' as const, url: '/resume/history' },
      { method: 'GET' as const, url: '/dashboard/bootstrap' },
      { method: 'POST' as const, url: '/internal/future-submission-worker' },
    ]) {
      const response = await drain.inject(request);
      assert.equal(response.statusCode, 503, `${request.method} ${request.url}`);
      assert.equal(response.json().code, 'SUBMISSION_CUTOVER_DRAINING');
    }

    const evidenceSink = await drain.inject({
      method: 'POST',
      url: `/applications/${applicationId}/submission/extension-outcome`,
    });
    assert.equal(evidenceSink.statusCode, 401, 'drain leaves the existing-attempt evidence sink open');

    const legacyAutofillEvidence = await drain.inject({
      method: 'POST',
      url: '/autofill/event',
    });
    assert.equal(legacyAutofillEvidence.statusCode, 401, 'drain leaves legacy submit telemetry open');

    const preflight = await drain.inject({
      method: 'OPTIONS',
      url: `/applications/${applicationId}/submit-request`,
      headers: {
        origin: SITE_ORIGIN,
        'access-control-request-method': 'POST',
      },
    });
    assert.notEqual(preflight.statusCode, 503, 'OPTIONS must never be fenced');

    const drainHealth = await drain.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(drainHealth.json().submission_cutover, { mode: 'drain', config_valid: true });

    const invalidValue = 'invalid-value-must-not-be-echoed';
    const invalid = await appFor(invalidValue);
    const invalidHealth = await invalid.inject({ method: 'GET', url: '/health' });
    assert.deepEqual(invalidHealth.json().submission_cutover, { mode: 'freeze', config_valid: false });
    assert.ok(!invalidHealth.body.includes(invalidValue), 'the public health response must not echo config input');

    const frozenSink = await invalid.inject({
      method: 'POST',
      url: `/applications/${applicationId}/submission/extension-outcome`,
    });
    assert.equal(frozenSink.statusCode, 503);
    assert.equal(frozenSink.json().code, 'SUBMISSION_CUTOVER_FROZEN');

    const frozenLegacyAutofill = await invalid.inject({
      method: 'POST',
      url: '/autofill/event',
    });
    assert.equal(frozenLegacyAutofill.statusCode, 503);
    assert.equal(frozenLegacyAutofill.json().code, 'SUBMISSION_CUTOVER_FROZEN');
  } finally {
    await Promise.all(opened.map((app) => app.close()));
    if (saved === undefined) delete process.env.SUBMISSION_CUTOVER_MODE;
    else process.env.SUBMISSION_CUTOVER_MODE = saved;
  }
});

/* The whole reason /health carries this field: L2 is enabled purely by two environment variables,
   and with them unset rankingCache.ts is a correct, silent no-op that re-reads the ranking pool out
   of Neon on every cold start. That read exhausted Neon's transfer allowance on 2026-08-04. Whether
   the vars actually took effect has to be answerable from outside the process. */
test('/health reports which ranking-cache tiers are running', async () => {
  const saved = {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  };
  try {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    {
      const { buildApp } = await import('./index');
      const app = await buildApp(HEALTH_TEST_OPTIONS);
      const body = (await app.inject({ method: 'GET', url: '/health' })).json();
      assert.equal(body.ranking_cache, 'local', 'unset vars means L1 only, and it must say so');
      await app.close();
    }

    process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token-value';
    {
      const { buildApp } = await import('./index');
      const app = await buildApp(HEALTH_TEST_OPTIONS);
      const res = await app.inject({ method: 'GET', url: '/health' });
      const body = res.json();
      assert.equal(body.ranking_cache, 'shared', 'both vars set means the L2 tier is live');

      /* /health is UNAUTHENTICATED. It publishes whether a capability is on, never its
         credentials, so the token must not reach the payload by any route. */
      const raw = res.body;
      assert.ok(!raw.includes('test-token-value'), 'the Upstash token must never appear in /health');
      assert.ok(!raw.includes('example.upstash.io'), 'nor the Upstash URL');
    }

    /* One var alone is not a working configuration, and reporting 'shared' for it would send
       someone hunting for a Redis problem that is really a missing variable. */
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    {
      const { buildApp } = await import('./index');
      const app = await buildApp(HEALTH_TEST_OPTIONS);
      const body = (await app.inject({ method: 'GET', url: '/health' })).json();
      assert.equal(body.ranking_cache, 'local', 'a half-configured pair is not shared');
      await app.close();
    }
  } finally {
    if (saved.url === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = saved.url;
    if (saved.token === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = saved.token;
  }
});

test('/health reports ATS API submission capability without exposing secrets', async () => {
  const saved = {
    enabled: process.env.LITOS_ATS_API_SUBMISSION_ENABLED,
    channels: process.env.LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON,
    key: process.env.GH_HEALTH_TEST_KEY,
  };
  try {
    process.env.LITOS_ATS_API_SUBMISSION_ENABLED = 'true';
    process.env.LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON = JSON.stringify([
      { ats: 'greenhouse', board_token: 'healthco', api_key_env: 'GH_HEALTH_TEST_KEY' },
    ]);
    process.env.GH_HEALTH_TEST_KEY = 'secret-health-key';

    const { buildApp } = await import('./index');
    const app = await buildApp(HEALTH_TEST_OPTIONS);
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();

    assert.deepEqual(body.ats_api_submission, {
      enabled: true,
      channel_config_present: true,
      configured_channels: 1,
    });
    assert.ok(!res.body.includes('secret-health-key'));
    assert.ok(!res.body.includes('GH_HEALTH_TEST_KEY'));
    await app.close();
  } finally {
    if (saved.enabled === undefined) delete process.env.LITOS_ATS_API_SUBMISSION_ENABLED;
    else process.env.LITOS_ATS_API_SUBMISSION_ENABLED = saved.enabled;
    if (saved.channels === undefined) delete process.env.LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON;
    else process.env.LITOS_EMPLOYER_API_SUBMISSION_CHANNELS_JSON = saved.channels;
    if (saved.key === undefined) delete process.env.GH_HEALTH_TEST_KEY;
    else process.env.GH_HEALTH_TEST_KEY = saved.key;
  }
});

test('/health reports application email routing capability without exposing secrets', async () => {
  const saved = {
    domain: process.env.LITOS_APPLICATION_EMAIL_DOMAIN,
    mailbox: process.env.LITOS_APPLICATION_EMAIL_MAILBOX,
    managedDomain: process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN,
    managedCanary: process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN,
    routeMode: process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE,
    aliasSecret: process.env.LITOS_APPLICATION_EMAIL_SECRET,
    inboundSecret: process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET,
    resendKey: process.env.RESEND_API_KEY,
    resendFrom: process.env.RESEND_FROM,
  };
  try {
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'managed_resend';
    process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'litos-inbound.resend.app';
    process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN = 'secretcanarytoken0123456789abcdef012345';
    process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'legacy-domain.example';
    process.env.LITOS_APPLICATION_EMAIL_MAILBOX = 'legacy-mailbox@example.com';
    process.env.LITOS_APPLICATION_EMAIL_SECRET = 'secret-alias-key';
    process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET = 'secret-webhook-key';
    process.env.RESEND_API_KEY = 'secret-resend-key';
    process.env.RESEND_FROM = 'ops@trylitos.com';
    /* Kill switch on, so the probe answers without touching DNS or Resend and this test stays
     * hermetic. The measured branches are unit-tested with injected probes in
     * lib/applicationEmailDeliverability.test.ts; what matters here is that /health can no longer
     * answer "healthy" from environment variables alone. */
    process.env.LITOS_APPLICATION_EMAIL_INBOUND_ENABLED = 'false';
    const { resetApplicationAliasDeliverabilityCache } = await import('./lib/applicationEmailDeliverability');
    resetApplicationAliasDeliverabilityCache();

    const { buildApp } = await import('./index');
    const app = await buildApp(HEALTH_TEST_OPTIONS);
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();

    // The three config booleans survive under their old names for existing monitors, but they no
    // longer decide the verdict: every variable above is set and the inbox is still not working.
    assert.equal(body.application_email.domain_configured, true);
    assert.equal(body.application_email.inbound_webhook_configured, true);
    assert.equal(body.application_email.forwarding_configured, true);
    assert.equal(body.application_email.route_mode, 'managed_resend');
    assert.equal(body.application_email.route_mode_explicit, true);
    assert.equal(body.application_email.invalid_route_mode_present, false);
    assert.equal(body.application_email.ignored_legacy_domain_present, true);
    assert.equal(body.application_email.ignored_legacy_mailbox_present, true);
    assert.equal(body.application_email.domain, 'litos-inbound.resend.app');
    assert.equal(body.application_email.deliverable, false);
    assert.notEqual(body.application_email.status, 'ok');
    assert.ok(!res.body.includes('secret-alias-key'));
    assert.ok(!res.body.includes('secret-webhook-key'));
    assert.ok(!res.body.includes('secret-resend-key'));
    assert.ok(!res.body.includes('secretcanarytoken0123456789abcdef012345'));
    assert.ok(!res.body.includes('legacy-domain.example'));
    assert.ok(!res.body.includes('legacy-mailbox@example.com'));
    await app.close();
    resetApplicationAliasDeliverabilityCache();
  } finally {
    delete process.env.LITOS_APPLICATION_EMAIL_INBOUND_ENABLED;
    if (saved.domain === undefined) delete process.env.LITOS_APPLICATION_EMAIL_DOMAIN;
    else process.env.LITOS_APPLICATION_EMAIL_DOMAIN = saved.domain;
    if (saved.mailbox === undefined) delete process.env.LITOS_APPLICATION_EMAIL_MAILBOX;
    else process.env.LITOS_APPLICATION_EMAIL_MAILBOX = saved.mailbox;
    if (saved.managedDomain === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = saved.managedDomain;
    if (saved.managedCanary === undefined) delete process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN;
    else process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN = saved.managedCanary;
    if (saved.routeMode === undefined) delete process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE;
    else process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = saved.routeMode;
    if (saved.aliasSecret === undefined) delete process.env.LITOS_APPLICATION_EMAIL_SECRET;
    else process.env.LITOS_APPLICATION_EMAIL_SECRET = saved.aliasSecret;
    if (saved.inboundSecret === undefined) delete process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET;
    else process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET = saved.inboundSecret;
    if (saved.resendKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = saved.resendKey;
    if (saved.resendFrom === undefined) delete process.env.RESEND_FROM;
    else process.env.RESEND_FROM = saved.resendFrom;
  }
});

test('/health identifies the build even when no git SHA is exposed', async () => {
  // The exact production shape this exists for: a bare `vercel --prod` sets VERCEL_DEPLOYMENT_ID
  // but not VERCEL_GIT_COMMIT_SHA, and on 2026-08-04 that made /health report `revision: null` for
  // a deployment that was live and correct. Confirming what shipped took a Vercel API call and two
  // git commands.
  //
  // WHY THAT HAPPENS IS NOW ESTABLISHED, and is no longer described here as unexplained: Vercel
  // fills VERCEL_GIT_* from the GitHub integration's metadata, so a CLI deploy leaves them unset.
  // `npm run deploy:prod` passes GIT_SHA instead, which is the case pinned in the test below.
  const saved = {
    sha: process.env.VERCEL_GIT_COMMIT_SHA,
    gitSha: process.env.GIT_SHA,
    id: process.env.VERCEL_DEPLOYMENT_ID,
    url: process.env.VERCEL_URL,
  };
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  delete process.env.GIT_SHA;
  // VERCEL_URL is deleted too, or this passes for the wrong reason. It is unset on a dev box and
  // in CI, so leaving it alone made `build` resolve to the same value through EITHER operand, and
  // reversing the order in index.ts kept the whole suite green. The order is the one non-obvious
  // decision in that line, so it is the one thing that has to be pinned.
  delete process.env.VERCEL_URL;
  process.env.VERCEL_DEPLOYMENT_ID = 'dpl_test123';
  process.env.VERCEL_URL = 'litos-should-not-win-team.vercel.app';
  try {
    const { buildApp } = await import('./index');
    const app = await buildApp(HEALTH_TEST_OPTIONS);
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    assert.equal(body.revision, null, 'this is the case where the SHA is genuinely unavailable');
    assert.equal(
      body.revision_source,
      'none',
      'a null revision must say WHY, or the reader cannot tell it from a broken field',
    );
    assert.equal(
      body.build,
      'dpl_test123',
      'the deployment id wins over VERCEL_URL: reversing the operands must fail here',
    );
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

test('a CLI deploy that passed GIT_SHA is as identifiable as a GitHub one', async () => {
  /* THE CASE THE FIX ADDS, end to end through the real app rather than through the resolver alone.
   *
   * `npm run deploy:prod` passes `-e GIT_SHA=$(git rev-parse HEAD)` precisely so a hand deploy
   * answers the DEPLOY.md question. Before that, `revision` was null on every CLI deploy and the
   * GIT_SHA fallback in the handler had never once fired, because nothing set the variable.
   *
   * The two branches are pinned together here because it is the DIFFERENCE that the runbook reads:
   * the same null-revision deployment must report 'none', and the same deployment with a SHA passed
   * in must report 'git-sha'. Asserting only one of them would let the source field freeze at a
   * constant and still pass. */
  const saved = { sha: process.env.VERCEL_GIT_COMMIT_SHA, gitSha: process.env.GIT_SHA };
  delete process.env.VERCEL_GIT_COMMIT_SHA;
  process.env.GIT_SHA = 'cf071b61ce6f6b48850b5564bad3d6e0d4cf86a0';
  try {
    const { buildApp } = await import('./index');
    const app = await buildApp(HEALTH_TEST_OPTIONS);
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    assert.equal(body.revision, 'cf071b61ce6f6b48850b5564bad3d6e0d4cf86a0');
    assert.equal(body.revision_source, 'git-sha', 'a hand deploy is distinguishable from an automatic one');
    await app.close();
  } finally {
    if (saved.sha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = saved.sha;
    if (saved.gitSha === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = saved.gitSha;
  }
});

test('the GitHub integration outranks a stale GIT_SHA', async () => {
  // GIT_SHA is written by a shell script from whatever checkout it ran in. The platform's own value
  // cannot have gone stale, so where both exist the platform wins and says so.
  const saved = { sha: process.env.VERCEL_GIT_COMMIT_SHA, gitSha: process.env.GIT_SHA };
  process.env.VERCEL_GIT_COMMIT_SHA = 'from-the-integration';
  process.env.GIT_SHA = 'stale-from-a-laptop';
  try {
    const { buildApp } = await import('./index');
    const app = await buildApp(HEALTH_TEST_OPTIONS);
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    assert.equal(body.revision, 'from-the-integration');
    assert.equal(body.revision_source, 'vercel-git');
    await app.close();
  } finally {
    if (saved.sha === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
    else process.env.VERCEL_GIT_COMMIT_SHA = saved.sha;
    if (saved.gitSha === undefined) delete process.env.GIT_SHA;
    else process.env.GIT_SHA = saved.gitSha;
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
    const app = await buildApp(HEALTH_TEST_OPTIONS);
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
    /* /health is EXEMPT from the limiter, which is what this asserts. Deliberately not `=== 200`:
       /health probes the database, and with no DATABASE_URL configured in a unit test it correctly
       answers 503. Pinning 200 here would be pinning "the test environment has a database", which
       is not what this test is about, and it would fail for a reason unrelated to rate limiting. */
    assert.notEqual((await limitedApp.inject({ method: 'GET', url: '/health' })).statusCode, 429);
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

test('the website checkout preflight permits the Idempotency-Key header', async () => {
  const app = await getApp();
  const res = await app.inject({
    method: 'OPTIONS',
    url: '/billing/checkout',
    headers: {
      origin: SITE_ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,idempotency-key',
    },
  });

  assert.equal(res.statusCode, 204);
  assert.equal(res.headers['access-control-allow-origin'], SITE_ORIGIN);
  assert.match(String(res.headers['access-control-allow-headers']), /(?:^|,\s*)Idempotency-Key(?:,|$)/i);
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

test('/health probes the model through an injectable call, once per burst', async () => {
  /* Two properties, both cost control, both easy to lose in a refactor.
   *
   * INJECTABLE, so the suite never makes a live billed call. If this stops being honoured the
   * calls counter below stays 0 while a real request goes out, so assert the stub actually ran.
   *
   * ONCE PER BURST, because /health is public and sits in UNMETERED_PATHS: anyone can hit it as
   * fast as they like, and without the in-flight guard every concurrent request on a cold
   * instance starts its own paid call. */
  const { buildApp } = await import('./index');
  let calls = 0;
  const app = await buildApp({
    modelPing: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
    },
  });
  await app.ready();
  try {
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/health' })),
    );
    assert.equal(calls, 1, 'five concurrent health checks must not buy five model calls');
    for (const res of responses) {
      assert.equal(res.json().model, 'ok');
    }
    // And the cached verdict serves later requests without paying again.
    await app.inject({ method: 'GET', url: '/health' });
    assert.equal(calls, 1, 'a cached verdict must not be re-bought');
  } finally {
    await app.close();
  }
});
