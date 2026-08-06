import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  parseStripeCheckoutCompleted,
  stripeAcquiringConfigured,
  stripeWebhookSignature,
  verifyStripeWebhookSignature,
} from './stripeAcquiring';

const savedEnv = {
  enabled: process.env.LITOS_PAY_STRIPE_ENABLED,
  key: process.env.STRIPE_SECRET_KEY,
  webhook: process.env.STRIPE_WEBHOOK_SECRET,
  monthly: process.env.STRIPE_MONTHLY_PRICE_ID,
  annual: process.env.STRIPE_ANNUAL_PRICE_ID,
  nodeEnv: process.env.NODE_ENV,
};

beforeEach(() => {
  process.env.LITOS_PAY_STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_configured';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_configured';
  process.env.STRIPE_MONTHLY_PRICE_ID = 'price_monthly';
  process.env.STRIPE_ANNUAL_PRICE_ID = 'price_annual';
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    const envKey = key === 'enabled'
      ? 'LITOS_PAY_STRIPE_ENABLED'
      : key === 'webhook'
        ? 'STRIPE_WEBHOOK_SECRET'
        : key === 'monthly'
          ? 'STRIPE_MONTHLY_PRICE_ID'
          : key === 'annual'
            ? 'STRIPE_ANNUAL_PRICE_ID'
            : key === 'nodeEnv'
              ? 'NODE_ENV'
              : 'STRIPE_SECRET_KEY';
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

describe('Stripe acquiring adapter', () => {
  test('requires every live acquiring secret before enabling Stripe-backed Litos checkout', () => {
    assert.equal(stripeAcquiringConfigured(), true);
    delete process.env.STRIPE_WEBHOOK_SECRET;
    assert.equal(stripeAcquiringConfigured(), false);
  });

  test('refuses test-mode Stripe secrets in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.STRIPE_SECRET_KEY = 'sk_test_not_live_money';
    assert.equal(stripeAcquiringConfigured(), false);
    process.env.STRIPE_SECRET_KEY = 'sk_live_real_acquiring';
    assert.equal(stripeAcquiringConfigured(), true);
  });

  test('verifies signed Stripe webhook payloads with timestamp tolerance', () => {
    const payload = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed' }));
    const signature = stripeWebhookSignature(payload, 'whsec_test', 1_786_000_000);
    assert.equal(verifyStripeWebhookSignature({
      rawBody: payload,
      signatureHeader: signature,
      secret: 'whsec_test',
      now: new Date(1_786_000_000 * 1000),
    }), true);
    assert.equal(verifyStripeWebhookSignature({
      rawBody: Buffer.from(payload.toString('utf8').replace('evt_1', 'evt_2')),
      signatureHeader: signature,
      secret: 'whsec_test',
      now: new Date(1_786_000_000 * 1000),
    }), false);
  });

  test('normalizes paid Checkout Session events into Litos fulfillment events', () => {
    const parsed = parseStripeCheckoutCompleted({
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      created: 1_786_000_000,
      data: {
        object: {
          id: 'cs_live_session',
          object: 'checkout.session',
          status: 'complete',
          payment_status: 'paid',
          customer: 'cus_123',
          subscription: 'sub_123',
          customer_email: 'student@example.com',
          metadata: {
            litos_intent_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
            user_id: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
            interval: 'annual',
          },
        },
      },
      livemode: true,
    });
    assert.equal(parsed?.eventKey, 'stripe:evt_checkout');
    assert.equal(parsed?.eventName, 'checkout.session.completed');
    assert.equal(parsed?.sessionId, 'cs_live_session');
    assert.equal(parsed?.livemode, true);
    assert.equal(parsed?.interval, 'annual');
    assert.equal(parsed?.amountCents, 47_988);
    assert.equal(parsed?.plan, 'pro');
  });

  test('ignores signed Checkout Session events that cannot map to Litos UUIDs', () => {
    assert.equal(parseStripeCheckoutCompleted({
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_live_session',
          object: 'checkout.session',
          status: 'complete',
          payment_status: 'paid',
          customer: 'cus_123',
          subscription: 'sub_123',
          metadata: {
            litos_intent_id: 'not-a-litos-intent',
            user_id: 'not-a-user',
            interval: 'monthly',
          },
        },
      },
    }), null);
  });

  test('ignores complete Checkout Sessions that are not paid', () => {
    assert.equal(parseStripeCheckoutCompleted({
      id: 'evt_checkout',
      type: 'checkout.session.completed',
      livemode: true,
      data: {
        object: {
          id: 'cs_live_session',
          object: 'checkout.session',
          status: 'complete',
          payment_status: 'unpaid',
          customer: 'cus_123',
          subscription: 'sub_123',
          metadata: {
            litos_intent_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
            user_id: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
            interval: 'monthly',
          },
        },
      },
    }), null);
  });
});
