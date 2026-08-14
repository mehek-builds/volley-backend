import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  createStripePortalSession,
  parseStripeCheckoutCompleted,
  parseStripeSubscriptionChanged,
  secureStripePortalUrl,
  stripeAcquiringConfigured,
  stripePlanForStatus,
  stripeWebhookSignature,
  verifyStripeWebhookSignature,
} from './stripeAcquiring';

const savedEnv = {
  enabled: process.env.LITOS_PAY_STRIPE_ENABLED,
  key: process.env.STRIPE_SECRET_KEY,
  webhook: process.env.STRIPE_WEBHOOK_SECRET,
  weekly: process.env.STRIPE_WEEKLY_PRICE_ID,
  monthly: process.env.STRIPE_MONTHLY_PRICE_ID,
  nodeEnv: process.env.NODE_ENV,
};

beforeEach(() => {
  process.env.LITOS_PAY_STRIPE_ENABLED = 'true';
  process.env.STRIPE_SECRET_KEY = 'sk_test_configured';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_configured';
  process.env.STRIPE_WEEKLY_PRICE_ID = 'price_weekly';
  process.env.STRIPE_MONTHLY_PRICE_ID = 'price_monthly';
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    const envKey = key === 'enabled'
      ? 'LITOS_PAY_STRIPE_ENABLED'
      : key === 'webhook'
        ? 'STRIPE_WEBHOOK_SECRET'
        : key === 'weekly'
          ? 'STRIPE_WEEKLY_PRICE_ID'
          : key === 'monthly'
            ? 'STRIPE_MONTHLY_PRICE_ID'
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

  test('refuses malformed Stripe configuration', () => {
    process.env.STRIPE_WEBHOOK_SECRET = 'not-a-signing-secret';
    assert.equal(stripeAcquiringConfigured(), false);
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_configured';
    process.env.STRIPE_MONTHLY_PRICE_ID = 'prod_monthly';
    assert.equal(stripeAcquiringConfigured(), false);
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
            interval: 'weekly',
          },
        },
      },
      livemode: true,
    });
    assert.equal(parsed?.eventKey, 'stripe:evt_checkout');
    assert.equal(parsed?.eventName, 'checkout.session.completed');
    assert.equal(parsed?.sessionId, 'cs_live_session');
    assert.equal(parsed?.livemode, true);
    assert.equal(parsed?.interval, 'weekly');
    assert.equal(parsed?.amountCents, 2_000);
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

  test('maps Stripe subscription lifecycle events to Litos access', () => {
    const base = {
      id: 'evt_subscription',
      type: 'customer.subscription.updated',
      created: 1_786_000_000,
      livemode: true,
      data: {
        object: {
          id: 'sub_123',
          object: 'subscription',
          customer: 'cus_123',
          status: 'active',
          current_period_end: 1_788_592_000,
          cancel_at_period_end: false,
          metadata: {
            user_id: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
            interval: 'weekly',
          },
          items: { data: [{ price: { id: 'price_weekly', recurring: { interval: 'week' } } }] },
        },
      },
    };
    const active = parseStripeSubscriptionChanged(base);
    assert.equal(active?.eventKey, 'stripe:evt_subscription');
    assert.equal(active?.plan, 'pro');
    assert.equal(active?.interval, 'weekly');
    assert.equal(active?.renewsAt?.toISOString(), '2026-09-05T07:06:40.000Z');

    const ending = parseStripeSubscriptionChanged({
      ...base,
      data: {
        object: {
          ...base.data.object,
          cancel_at_period_end: true,
          canceled_at: 1_786_000_100,
        },
      },
    });
    assert.equal(ending?.plan, 'pro');
    assert.equal(ending?.renewsAt, null);
    assert.equal(ending?.endsAt?.toISOString(), '2026-09-05T07:06:40.000Z');

    const canceled = parseStripeSubscriptionChanged({
      ...base,
      type: 'customer.subscription.deleted',
      data: { object: { ...base.data.object, status: 'canceled', ended_at: 1_786_000_100 } },
    });
    assert.equal(canceled?.plan, 'free');
    assert.equal(canceled?.renewsAt, null);
    assert.equal(canceled?.endsAt?.toISOString(), '2026-08-06T07:08:20.000Z');
  });

  test('keeps access during Stripe retries but revokes after the subscription is unpaid', () => {
    assert.equal(stripePlanForStatus('past_due'), 'pro');
    assert.equal(stripePlanForStatus('unpaid'), 'free');
    assert.equal(stripePlanForStatus('incomplete'), null);
  });

  test('creates short-lived customer portal sessions and accepts only Stripe portal URLs', async () => {
    const url = await createStripePortalSession({
      customerId: 'cus_123',
      fetchImpl: async (_url, init) => {
        assert.equal(new URLSearchParams(String(init?.body)).get('customer'), 'cus_123');
        return new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/session/test_123' }), { status: 200 });
      },
    });
    assert.equal(url, 'https://billing.stripe.com/p/session/test_123');
    assert.equal(secureStripePortalUrl('https://billing.stripe.com.evil.example/p/session/test'), null);
    assert.equal(secureStripePortalUrl('http://billing.stripe.com/p/session/test'), null);
  });
});
