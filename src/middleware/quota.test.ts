import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { quotaExceededPayload, upgradeUrl, LIMITS } from './quota';
import type { Entitlements } from './quota';

// Regression coverage for R-043 (prod, 2026-07-18): the /resume/generate 402 upsell linked a
// Stripe TEST-mode checkout (buy.stripe.com/test_...), so a real quota'd student landed on a
// fake checkout that takes no money and grants nothing - and the copy still said "Volley
// Premium" months after the Litos rename (R-037's lesson: stale product names in
// user-facing surfaces have already cost a store rejection). These pin the three parts of the
// fix: test-mode links are refused at runtime, an unconfigured link omits the Upgrade sentence
// while keeping the quota info readable, and the product name is Litos everywhere. The
// JSON shape (error/code/used/limit/tier, optional upgrade_url) is the extension's contract:
// throwApiError surfaces `error` verbatim, so it must stay a plain human sentence.

const LIVE_LINK = 'https://buy.stripe.com/9AQ14t2gy0kO51K288';
const TEST_LINK = 'https://buy.stripe.com/test_14kaGvfqB2sW7dS4gg';

function withUpgradeEnv<T>(vars: { UPGRADE_URL?: string; STRIPE_PAYMENT_LINK?: string }, fn: () => T): T {
  const prev = { UPGRADE_URL: process.env.UPGRADE_URL, STRIPE_PAYMENT_LINK: process.env.STRIPE_PAYMENT_LINK };
  for (const key of ['UPGRADE_URL', 'STRIPE_PAYMENT_LINK'] as const) {
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of ['UPGRADE_URL', 'STRIPE_PAYMENT_LINK'] as const) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

function ent(tier: Entitlements['tier']): Entitlements {
  return { tier, ...(tier === 'free' ? LIMITS.free : LIMITS.pro) };
}

describe('upgradeUrl (R-043)', () => {
  test('unset means no link', () => {
    withUpgradeEnv({}, () => {
      assert.equal(upgradeUrl(), undefined);
    });
  });

  test('a live payment link passes through from either variable, UPGRADE_URL winning', () => {
    withUpgradeEnv({ STRIPE_PAYMENT_LINK: LIVE_LINK }, () => {
      assert.equal(upgradeUrl(), LIVE_LINK);
    });
    withUpgradeEnv({ UPGRADE_URL: 'https://trylitos.com/upgrade', STRIPE_PAYMENT_LINK: LIVE_LINK }, () => {
      assert.equal(upgradeUrl(), 'https://trylitos.com/upgrade');
    });
  });

  test('a Stripe TEST-mode payment link is refused (the exact prod misconfiguration)', () => {
    withUpgradeEnv({ STRIPE_PAYMENT_LINK: TEST_LINK }, () => {
      assert.equal(upgradeUrl(), undefined);
    });
    withUpgradeEnv({ UPGRADE_URL: TEST_LINK }, () => {
      assert.equal(upgradeUrl(), undefined);
    });
  });

  test('a test-mode checkout session URL is refused too', () => {
    withUpgradeEnv({ UPGRADE_URL: 'https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4' }, () => {
      assert.equal(upgradeUrl(), undefined);
    });
  });
});

describe('402 quota payload (R-043)', () => {
  test('resumes, free tier, live link configured: Litos Premium copy plus the Upgrade sentence', () => {
    withUpgradeEnv({ UPGRADE_URL: LIVE_LINK }, () => {
      const payload = quotaExceededPayload(ent('free'), 20, 'resumes');
      assert.equal(
        payload.error,
        `You've used your ${LIMITS.free.monthlyResumes} free resume generations this month. Litos Premium ($49.99/mo) unlocks unlimited resume generation + autofill. Resets on the 1st. Upgrade: ${LIVE_LINK}`
      );
      assert.equal(payload.code, 'quota_exceeded');
      assert.equal(payload.used, 20);
      assert.equal(payload.limit, LIMITS.free.monthlyResumes);
      assert.equal(payload.tier, 'free');
      assert.equal(payload.upgrade_url, LIVE_LINK);
    });
  });

  test('resumes, free tier, nothing configured: the Upgrade sentence is omitted and the message still reads cleanly', () => {
    withUpgradeEnv({}, () => {
      const payload = quotaExceededPayload(ent('free'), 20, 'resumes');
      assert.equal(
        payload.error,
        `You've used your ${LIMITS.free.monthlyResumes} free resume generations this month. Litos Premium ($49.99/mo) unlocks unlimited resume generation + autofill. Resets on the 1st.`
      );
      assert.equal('upgrade_url' in payload, false);
      // The contract fields the extension parses stay put regardless of link configuration.
      assert.equal(payload.code, 'quota_exceeded');
      assert.equal(payload.tier, 'free');
    });
  });

  test('resumes, free tier, test-mode link configured: behaves exactly as unconfigured, never surfacing the fake checkout', () => {
    withUpgradeEnv({ STRIPE_PAYMENT_LINK: TEST_LINK }, () => {
      const payload = quotaExceededPayload(ent('free'), 23, 'resumes');
      assert.doesNotMatch(payload.error, /test_/);
      assert.doesNotMatch(payload.error, /Upgrade:/);
      assert.match(payload.error, /Resets on the 1st\.$/);
      assert.equal('upgrade_url' in payload, false);
    });
  });

  test('no payload variant says Volley, and no variant leaks a test-mode URL', () => {
    const kinds = ['resumes', 'contacts', 'drafts'] as const;
    const tiers = ['free', 'trial', 'pro'] as const;
    for (const envVars of [{}, { UPGRADE_URL: LIVE_LINK }, { STRIPE_PAYMENT_LINK: TEST_LINK }]) {
      withUpgradeEnv(envVars, () => {
        for (const kind of kinds) {
          for (const tier of tiers) {
            const payload = quotaExceededPayload(ent(tier), 999, kind);
            assert.doesNotMatch(payload.error, /Volley/, `${kind}/${tier} still says Volley`);
            assert.doesNotMatch(payload.error, /test_/, `${kind}/${tier} leaks a test-mode URL`);
            assert.equal(payload.upgrade_url?.includes('test_') ?? false, false, `${kind}/${tier} upgrade_url is test-mode`);
          }
        }
      });
    }
  });

  test('contacts and drafts say Litos Pro', () => {
    withUpgradeEnv({}, () => {
      assert.match(quotaExceededPayload(ent('free'), 30, 'contacts').error, /Litos Pro/);
      assert.match(quotaExceededPayload(ent('free'), 60, 'drafts').error, /Litos Pro/);
    });
  });

  test('pro tier never gets an upsell link, even with a live link configured', () => {
    withUpgradeEnv({ UPGRADE_URL: LIVE_LINK }, () => {
      for (const kind of ['resumes', 'contacts', 'drafts'] as const) {
        const payload = quotaExceededPayload(ent('pro'), 100000, kind);
        assert.doesNotMatch(payload.error, /Upgrade:/);
        assert.equal('upgrade_url' in payload, false);
      }
    });
  });
});
