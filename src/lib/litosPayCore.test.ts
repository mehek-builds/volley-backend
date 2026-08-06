import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import {
  buildLitosCheckoutIntent,
  eventFromPaidCheckout,
  litosAmountCents,
  litosProcessorConfigured,
  normalizeBillingInterval,
  parseLitosCheckoutToken,
} from './litosPayCore';

const savedEnv = {
  enabled: process.env.LITOS_PAY_PROCESSOR_ENABLED,
  trial: process.env.LITOS_PAY_TEST_TRIAL_ENABLED,
  secret: process.env.LITOS_PAY_SIGNING_SECRET,
  base: process.env.LITOS_PAY_CHECKOUT_BASE_URL,
  nodeEnv: process.env.NODE_ENV,
};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    const envKey = key === 'enabled'
      ? 'LITOS_PAY_PROCESSOR_ENABLED'
      : key === 'trial'
        ? 'LITOS_PAY_TEST_TRIAL_ENABLED'
        : key === 'secret'
          ? 'LITOS_PAY_SIGNING_SECRET'
          : key === 'base'
            ? 'LITOS_PAY_CHECKOUT_BASE_URL'
            : 'NODE_ENV';
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

describe('Litos Pay Core checkout intents', () => {
  test('is available only when explicitly enabled with a long signing secret', () => {
    process.env.LITOS_PAY_PROCESSOR_ENABLED = 'true';
    process.env.LITOS_PAY_SIGNING_SECRET = 'short';
    assert.equal(litosProcessorConfigured(), false);
    process.env.LITOS_PAY_SIGNING_SECRET = 'test-litos-pay-secret-at-least-32-chars';
    assert.equal(litosProcessorConfigured(), true);
  });

  test('normalizes supported intervals and prices the current Litos plans', () => {
    assert.equal(normalizeBillingInterval('annual'), 'annual');
    assert.equal(normalizeBillingInterval('surprise'), 'monthly');
    assert.equal(litosAmountCents('monthly'), 4_999);
    assert.equal(litosAmountCents('annual'), 47_988);
  });

  test('builds a signed checkout token that can produce a paid processor event', () => {
    process.env.NODE_ENV = 'test';
    process.env.LITOS_PAY_SIGNING_SECRET = 'test-litos-pay-secret-at-least-32-chars';
    process.env.LITOS_PAY_CHECKOUT_BASE_URL = 'http://localhost:8787';
    const now = new Date('2026-08-06T10:00:00.000Z');

    const intent = buildLitosCheckoutIntent({
      userId: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      email: 'Student@Example.com',
      interval: 'annual',
      now,
    });

    assert.ok(intent);
    assert.equal(intent.interval, 'annual');
    assert.equal(intent.amountCents, 47_988);
    assert.equal(new URL(intent.url).pathname, `/billing/litos-pay/checkout/${intent.intentId}`);

    const parsed = parseLitosCheckoutToken(intent.token, now);
    assert.equal(parsed?.userId, '6d58c1f5-e885-41f7-a16a-dac37f98ab17');
    assert.equal(parsed?.email, 'student@example.com');
    assert.equal(parsed?.amountCents, 47_988);

    const event = eventFromPaidCheckout(intent.token, now);
    assert.equal(event?.eventName, 'checkout.paid');
    assert.equal(event?.plan, 'pro');
    assert.equal(event?.eventKey, `litos:${intent.intentId}:checkout.paid`);
    assert.equal(event?.subscriptionId, `sub_litos_${intent.intentId}`);
  });

  test('rejects tampered and expired tokens', () => {
    process.env.LITOS_PAY_SIGNING_SECRET = 'test-litos-pay-secret-at-least-32-chars';
    const now = new Date('2026-08-06T10:00:00.000Z');
    const intent = buildLitosCheckoutIntent({
      userId: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      email: 'student@example.com',
      now,
    });
    assert.ok(intent);
    assert.equal(parseLitosCheckoutToken(`${intent.token}x`, now), null);
    assert.equal(parseLitosCheckoutToken(intent.token, new Date(now.getTime() + 31 * 60 * 1000)), null);
  });
});
