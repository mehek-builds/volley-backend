import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createBrowserContext,
  createBrowserSession,
} from './browserbase';
import {
  AUTOMATIC_CAPTCHA_CONSENT_VERSION,
  automationConsentValues,
} from './automationConsent';
import { captchaSnapshotRequiresAttention } from './portalSubmission';
import { preparedSubmissionStatus } from './submissionAuthorization';

test('controlled consent records human resume permission while the server remains fail-closed', async () => {
  const portalUrl = 'https://qa.trylitos.com/app/qa/portal-submission?captcha=1';
  const previous = {
    provider: process.env.BROWSER_PROVIDER,
    key: process.env.BROWSERBASE_API_KEY,
    root: process.env.BROWSERBASE_API_ROOT,
    fetch: globalThis.fetch,
  };
  process.env.BROWSER_PROVIDER = 'browserbase';
  process.env.BROWSERBASE_API_KEY = 'controlled-provider-key';
  process.env.BROWSERBASE_API_ROOT = 'https://provider.test/v1';

  const providerRequests: Array<{ url: string; body: Record<string, unknown>; key: string | null }> = [];
  globalThis.fetch = (async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    providerRequests.push({
      url: String(input),
      body,
      key: new Headers(init?.headers).get('X-BB-API-Key'),
    });
    if (String(input).endsWith('/contexts')) {
      return new Response(JSON.stringify({ id: 'controlled-context' }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'controlled-session', connectUrl: 'ws://controlled.test' }), { status: 200 });
  }) as typeof fetch;

  try {
    const now = new Date('2026-07-26T12:00:00.000Z');
    const consent = automationConsentValues({
      automatic_submission_enabled: true,
      automatic_verification_enabled: false,
      automatic_captcha_enabled: true,
    }, now);
    assert.equal(consent.automatic_captcha_consent_version, AUTOMATIC_CAPTCHA_CONSENT_VERSION);
    const contextId = await createBrowserContext('browserbase');
    await createBrowserSession(contextId, portalUrl, 'browserbase');
    const sessionBody = providerRequests[1]?.body as {
      browserSettings?: { solveCaptchas?: boolean; allowedDomains?: string[] };
    };
    assert.equal(providerRequests[1]?.key, 'controlled-provider-key');
    assert.equal(sessionBody.browserSettings?.solveCaptchas, false);
    assert.deepEqual(sessionBody.browserSettings?.allowedDomains, ['qa.trylitos.com']);

    const unresolvedChallenge = captchaSnapshotRequiresAttention([''], 1);
    assert.equal(unresolvedChallenge, true);
    const status = preparedSubmissionStatus({ safe: !unresolvedChallenge, standingConsentEnabled: true });
    assert.equal(status, 'needs_attention');

    const revoked = automationConsentValues({
      automatic_submission_enabled: true,
      automatic_verification_enabled: false,
      automatic_captcha_enabled: false,
    }, new Date('2026-07-26T12:01:00.000Z'));
    assert.equal(revoked.automatic_captcha_consented_at, null);
    assert.equal(revoked.automatic_captcha_consent_version, null);
    assert.equal(revoked.automatic_captcha_enabled, false);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [
      ['BROWSER_PROVIDER', previous.provider],
      ['BROWSERBASE_API_KEY', previous.key],
      ['BROWSERBASE_API_ROOT', previous.root],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
