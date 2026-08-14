import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  BILLING_CATALOG,
  billingCheckoutAvailable,
  billingPlan,
  publicBillingPlans,
  stripePriceIdForPlan,
  stripeWebhookAvailable,
  validateStripePriceFact,
} from './billingCatalog';

describe('Litos+ billing catalog', () => {
  test('publishes the exact three approved recurring terms', () => {
    assert.deepEqual(BILLING_CATALOG.map((plan) => ({
      id: plan.id,
      amount: plan.amount_cents,
      interval: plan.interval,
      count: plan.interval_count,
      daily: plan.daily_equivalent_cents,
      savings: plan.weekly_baseline_savings_percent,
    })), [
      { id: 'litos_plus_week', amount: 1_999, interval: 'week', count: 1, daily: 285, savings: 0 },
      { id: 'litos_plus_month', amount: 3_999, interval: 'month', count: 1, daily: 133, savings: 53 },
      { id: 'litos_plus_quarter', amount: 8_999, interval: 'month', count: 3, daily: 99, savings: 65 },
    ]);
    assert.equal(billingPlan('surprise'), null);
  });

  test('requires every price and the explicit billing flag', () => {
    const env = {
      NODE_ENV: 'test',
      LITOS_BILLING_ENABLED: 'true',
      STRIPE_SECRET_KEY: 'sk_test_catalog',
      STRIPE_PLUS_WEEKLY_PRICE_ID: 'price_week',
      STRIPE_PLUS_MONTHLY_PRICE_ID: 'price_month',
      STRIPE_PLUS_QUARTERLY_PRICE_ID: 'price_quarter',
    } as NodeJS.ProcessEnv;
    assert.equal(billingCheckoutAvailable(env), true);
    assert.equal(stripePriceIdForPlan('litos_plus_quarter', env), 'price_quarter');
    delete env.STRIPE_PLUS_QUARTERLY_PRICE_ID;
    assert.equal(billingCheckoutAvailable(env), false);
    assert.equal(publicBillingPlans(env).checkout_available, false);
  });

  test('keeps webhook lifecycle processing independent from sales availability', () => {
    const env = {
      NODE_ENV: 'test',
      LITOS_BILLING_ENABLED: 'false',
      STRIPE_SECRET_KEY: 'sk_test_catalog',
      STRIPE_WEBHOOK_SECRET: 'whsec_catalog',
      STRIPE_PLUS_WEEKLY_PRICE_ID: 'price_week',
      STRIPE_PLUS_MONTHLY_PRICE_ID: 'price_month',
    } as NodeJS.ProcessEnv;
    assert.equal(billingCheckoutAvailable(env), false);
    assert.equal(stripeWebhookAvailable(env), true);

    env.NODE_ENV = 'production';
    assert.equal(stripeWebhookAvailable(env), false);
    env.STRIPE_SECRET_KEY = 'sk_live_catalog';
    assert.equal(stripeWebhookAvailable(env), true);
  });

  test('validates live Stripe price facts against server amounts and recurrence', () => {
    const plan = billingPlan('litos_plus_quarter')!;
    assert.deepEqual(validateStripePriceFact(plan, {
      id: 'price_quarter',
      active: true,
      currency: 'usd',
      unit_amount: 8_999,
      recurring: { interval: 'month', interval_count: 3 },
    }), []);
    assert.deepEqual(validateStripePriceFact(plan, {
      id: 'price_bad',
      active: false,
      currency: 'aed',
      unit_amount: 3_999,
      recurring: { interval: 'month', interval_count: 1 },
    }), [
      'price is inactive',
      'expected USD currency',
      'expected 8999 cents',
      'expected interval count 3',
    ]);
  });
});
