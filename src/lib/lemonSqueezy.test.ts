import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import {
  buildLemonSqueezyCheckoutUrl,
  parseLemonSqueezySubscription,
  planForLemonSqueezyStatus,
  verifyLemonSqueezyAccountToken,
  verifyLemonSqueezySignature,
} from './lemonSqueezy';

const previousCheckout = process.env.LEMONSQUEEZY_CHECKOUT_URL;
const previousSecret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
const previousVariant = process.env.LEMONSQUEEZY_VARIANT_ID;
afterEach(() => {
  if (previousCheckout === undefined) delete process.env.LEMONSQUEEZY_CHECKOUT_URL;
  else process.env.LEMONSQUEEZY_CHECKOUT_URL = previousCheckout;
  if (previousSecret === undefined) delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  else process.env.LEMONSQUEEZY_WEBHOOK_SECRET = previousSecret;
  if (previousVariant === undefined) delete process.env.LEMONSQUEEZY_VARIANT_ID;
  else process.env.LEMONSQUEEZY_VARIANT_ID = previousVariant;
});

describe('Lemon Squeezy checkout', () => {
  test('adds the stable Litos user id and verified email to a reusable buy link', () => {
    process.env.LEMONSQUEEZY_CHECKOUT_URL = 'https://litos.lemonsqueezy.com/checkout/buy/variant?discount=LAUNCH';
    process.env.LEMONSQUEEZY_WEBHOOK_SECRET = 'checkout-secret';
    process.env.LEMONSQUEEZY_VARIANT_ID = '34';
    const result = buildLemonSqueezyCheckoutUrl('6d58c1f5-e885-41f7-a16a-dac37f98ab17', 'Student@Example.com');
    assert.ok(result);
    const url = new URL(result);
    assert.equal(url.searchParams.get('discount'), 'LAUNCH');
    assert.equal(url.searchParams.get('checkout[custom][user_id]'), '6d58c1f5-e885-41f7-a16a-dac37f98ab17');
    assert.equal(url.searchParams.get('checkout[email]'), 'student@example.com');
    assert.equal(verifyLemonSqueezyAccountToken(
      '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      url.searchParams.get('checkout[custom][account_token]') ?? undefined,
      'checkout-secret',
    ), true);
  });

  test('refuses non-Lemon Squeezy, insecure, and single-use cart URLs', () => {
    for (const value of [
      'https://evil.example/checkout/buy/variant',
      'http://litos.lemonsqueezy.com/checkout/buy/variant',
      'https://litos.lemonsqueezy.com/checkout/?cart=single-use',
    ]) {
      process.env.LEMONSQUEEZY_CHECKOUT_URL = value;
      process.env.LEMONSQUEEZY_WEBHOOK_SECRET = 'checkout-secret';
      process.env.LEMONSQUEEZY_VARIANT_ID = '34';
      assert.equal(buildLemonSqueezyCheckoutUrl('user', 'student@example.com'), undefined);
    }
  });

  test('does not expose checkout until the fulfillment secret and paid variant are both configured', () => {
    process.env.LEMONSQUEEZY_CHECKOUT_URL = 'https://litos.lemonsqueezy.com/checkout/buy/variant';
    delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    delete process.env.LEMONSQUEEZY_VARIANT_ID;
    assert.equal(buildLemonSqueezyCheckoutUrl('6d58c1f5-e885-41f7-a16a-dac37f98ab17', 'student@example.com'), undefined);
  });
});

describe('Lemon Squeezy webhooks', () => {
  test('verifies the documented HMAC SHA-256 signature', () => {
    const raw = Buffer.from('{"hello":"billing"}');
    const secret = 'secret';
    const signature = createHmac('sha256', secret).update(raw).digest('hex');
    assert.equal(verifyLemonSqueezySignature(raw, signature, secret), true);
    assert.equal(verifyLemonSqueezySignature(raw, '0'.repeat(64), secret), false);
    assert.equal(verifyLemonSqueezySignature(raw, 'not-hex', secret), false);
  });

  test('parses account linkage and subscription state from subscription_updated', () => {
    const result = parseLemonSqueezySubscription({
      meta: { event_name: 'subscription_updated', custom_data: { user_id: '6d58c1f5-e885-41f7-a16a-dac37f98ab17' } },
      data: {
        type: 'subscriptions',
        id: 'sub-456',
        attributes: {
          customer_id: 12,
          variant_id: 34,
          status: 'cancelled',
          user_email: 'Student@Example.com',
          renews_at: '2026-08-26T00:00:00.000Z',
          ends_at: '2026-08-26T00:00:00.000Z',
          updated_at: '2026-07-26T12:00:00.000Z',
          test_mode: false,
          urls: { customer_portal: 'https://litos.lemonsqueezy.com/billing?signature=signed' },
        },
      },
    });
    assert.equal(result?.userId, '6d58c1f5-e885-41f7-a16a-dac37f98ab17');
    assert.equal(result?.email, 'student@example.com');
    assert.equal(result?.subscriptionId, 'sub-456');
    assert.equal(result?.status, 'cancelled');
    assert.equal(result?.portalUrl, 'https://litos.lemonsqueezy.com/billing?signature=signed');
  });

  test('keeps paid access through cancellation and dunning, then removes it only at expiry', () => {
    for (const status of ['on_trial', 'active', 'paused', 'past_due', 'unpaid', 'cancelled']) {
      assert.equal(planForLemonSqueezyStatus(status), 'pro', status);
    }
    assert.equal(planForLemonSqueezyStatus('expired'), 'free');
    assert.equal(planForLemonSqueezyStatus('made_up'), null);
  });
});
