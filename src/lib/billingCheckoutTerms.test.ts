import assert from 'node:assert/strict';
import test from 'node:test';
import { billingPlan } from './billingCatalog';
import {
  billingCheckoutTerms,
  checkoutOfferPolicyVersion,
  type BillingCheckoutAccountFacts,
} from './billingCheckoutTerms';

const newAccount: BillingCheckoutAccountFacts = {
  authenticated: true,
  is_guest: false,
  access_class: 'free_new',
  subscription_status: null,
  billing_provider: null,
  billing_customer_id: null,
  billing_status: null,
  trial_started_at: null,
  trial_ends_at: null,
};

function terms(
  planId: 'litos_plus_week' | 'litos_plus_month' | 'litos_plus_quarter',
  account: BillingCheckoutAccountFacts = newAccount,
  checkoutAvailable = true,
) {
  const plan = billingPlan(planId);
  assert.ok(plan);
  return billingCheckoutTerms({
    plan,
    account,
    checkout_available: checkoutAvailable,
    automatic_tax_enabled: true,
  });
}

test('first-time accounts get exact zero due now and relative first-charge timing', () => {
  const result = terms('litos_plus_month');
  assert.deepEqual(result, {
    schema_version: 1,
    revision: result.revision,
    checkout_status: 'available',
    blocker_code: null,
    payment_method_required: true,
    trial_eligible: true,
    trial_days: 7,
    due_at_checkout: { amount_cents: 0, currency: 'USD', amount_kind: 'exact' },
    first_charge: {
      regular_subtotal_cents: 3_999,
      currency: 'USD',
      timing: { kind: 'days_after_checkout_completion', days: 7 },
    },
    renewal: {
      regular_subtotal_cents: 3_999,
      currency: 'USD',
      interval: 'month',
      interval_count: 1,
    },
    automatic_tax_enabled: true,
    promotion_codes_allowed: true,
    price_basis: 'catalog_before_tax_and_promotions',
  });
  assert.match(result.revision, /^checkout_terms_v1_[A-Za-z0-9_-]{43}$/);
});

test('an account that already spent its trial sees the catalog subtotal due at completion', () => {
  const result = terms('litos_plus_week', {
    ...newAccount,
    trial_started_at: '2026-08-01T00:00:00.000Z',
  });
  assert.equal(result.trial_eligible, false);
  assert.equal(result.trial_days, 0);
  assert.deepEqual(result.due_at_checkout, {
    amount_cents: 1_999,
    currency: 'USD',
    amount_kind: 'catalog_before_tax_and_promotions',
  });
  assert.deepEqual(result.first_charge.timing, { kind: 'at_checkout_completion' });
});

test('a returning Stripe customer cannot receive another trial even without legacy trial dates', () => {
  const result = terms('litos_plus_quarter', {
    ...newAccount,
    billing_provider: 'stripe',
    billing_customer_id: 'cus_returning',
  });
  assert.equal(result.trial_eligible, false);
  assert.equal(result.trial_days, 0);
  assert.equal(result.due_at_checkout.amount_cents, 8_999);
});

test('blocked and anonymous states name their blocker without asserting trial eligibility', () => {
  const anonymous = terms('litos_plus_month', { authenticated: false, is_guest: false });
  assert.equal(anonymous.checkout_status, 'claim_required');
  assert.equal(anonymous.blocker_code, 'claim_required');
  assert.equal(anonymous.trial_eligible, null);
  assert.equal(anonymous.trial_days, null);

  const recovery = terms('litos_plus_month', {
    ...newAccount,
    billing_provider: 'stripe',
    billing_status: 'past_due',
  });
  assert.equal(recovery.checkout_status, 'billing_recovery_required');

  const trialing = terms('litos_plus_month', {
    ...newAccount,
    access_class: 'trial_plus',
    subscription_status: null,
  });
  assert.equal(trialing.checkout_status, 'already_plus');

  const unavailable = terms('litos_plus_month', newAccount, false);
  assert.equal(unavailable.checkout_status, 'billing_not_configured');
});

test('revision is stable for the same facts and changes with user, plan, or tax terms', () => {
  const first = terms('litos_plus_month');
  const same = terms('litos_plus_month');
  const noTrial = terms('litos_plus_month', { ...newAccount, trial_ends_at: new Date() });
  const quarter = terms('litos_plus_quarter');
  const plan = billingPlan('litos_plus_month');
  assert.ok(plan);
  const noTax = billingCheckoutTerms({
    plan,
    account: newAccount,
    checkout_available: true,
    automatic_tax_enabled: false,
  });
  assert.equal(first.revision, same.revision);
  assert.notEqual(first.revision, noTrial.revision);
  assert.notEqual(first.revision, quarter.revision);
  assert.notEqual(first.revision, noTax.revision);
});

test('an offer policy binds entitlement policy to the exact accepted checkout revision', () => {
  const revision = terms('litos_plus_month').revision;
  assert.equal(
    checkoutOfferPolicyVersion('litos-entitlements-v2', revision),
    `litos-entitlements-v2:${revision}`,
  );
});
