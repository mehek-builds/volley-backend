import { createHash } from 'node:crypto';
import type { BillingCatalogPlan } from './billingCatalog';
import { TRIAL_DAYS } from './entitlements';
import { subscriptionNeedsPortalRecovery } from './subscriptionState';

export type BillingCheckoutStatus =
  | 'available'
  | 'claim_required'
  | 'already_plus'
  | 'billing_recovery_required'
  | 'billing_not_configured';

export type BillingCheckoutTerms = {
  schema_version: 1;
  revision: string;
  checkout_status: BillingCheckoutStatus;
  blocker_code: Exclude<BillingCheckoutStatus, 'available'> | null;
  payment_method_required: true;
  trial_eligible: boolean | null;
  trial_days: number | null;
  due_at_checkout: {
    amount_cents: number;
    currency: 'USD';
    amount_kind: 'exact' | 'catalog_before_tax_and_promotions';
  };
  first_charge: {
    regular_subtotal_cents: number;
    currency: 'USD';
    timing: { kind: 'at_checkout_completion' }
      | { kind: 'days_after_checkout_completion'; days: number };
  };
  renewal: {
    regular_subtotal_cents: number;
    currency: 'USD';
    interval: 'week' | 'month';
    interval_count: 1 | 3;
  };
  automatic_tax_enabled: boolean;
  promotion_codes_allowed: true;
  price_basis: 'catalog_before_tax_and_promotions';
};

export type BillingCheckoutAccountFacts = {
  authenticated: boolean;
  is_guest: boolean;
  access_class?: string | null;
  subscription_status?: string | null;
  billing_provider?: string | null;
  billing_customer_id?: string | null;
  billing_status?: string | null;
  trial_started_at?: Date | string | null;
  trial_ends_at?: Date | string | null;
};

type CheckoutTermsInput = {
  plan: Pick<BillingCatalogPlan, 'amount_cents' | 'currency' | 'interval' | 'interval_count'>;
  provider_price_id: string | null;
  account: BillingCheckoutAccountFacts;
  checkout_available: boolean;
  automatic_tax_enabled: boolean;
};

function checkoutStatus(input: CheckoutTermsInput): BillingCheckoutStatus {
  const { account } = input;
  if (!account.authenticated || account.is_guest) return 'claim_required';
  if (account.billing_provider && subscriptionNeedsPortalRecovery(account.billing_status)) {
    return 'billing_recovery_required';
  }
  if (
    account.access_class === 'plus_paid'
    || account.access_class === 'legacy_paid'
    || account.access_class === 'trial_plus'
    || account.subscription_status === 'trialing'
  ) return 'already_plus';
  if (!input.checkout_available) return 'billing_not_configured';
  return 'available';
}

function trialDays(input: CheckoutTermsInput, status: BillingCheckoutStatus): number | null {
  if (status !== 'available') return null;
  const hadTrialBefore = Boolean(input.account.trial_started_at || input.account.trial_ends_at);
  const returningStripeCustomer = input.account.billing_provider === 'stripe'
    && Boolean(input.account.billing_customer_id);
  return hadTrialBefore || returningStripeCustomer ? 0 : TRIAL_DAYS;
}

function termsRevision(terms: Omit<BillingCheckoutTerms, 'revision'>, providerPriceId: string | null): string {
  /* The provider Price ID is intentionally not exposed in the public terms object, but it is part
     of the binding. Rotating an equivalent Stripe Price must invalidate an older Session because
     webhook ownership checks use the currently configured Price catalog. */
  const digest = createHash('sha256').update(JSON.stringify({
    terms,
    provider_price_id: providerPriceId,
  })).digest('base64url');
  return `checkout_terms_v1_${digest}`;
}

/**
 * The exact commercial facts Litos knows before Stripe Checkout opens.
 *
 * Stripe anchors a subscription when Checkout completes, so calendar timestamps are not facts at
 * this point. Relative timing stays exact without pretending the browser can know when Checkout
 * will finish. Taxes and promotions can change the final paid amount, so every nonzero amount is
 * explicitly the catalog subtotal before those adjustments.
 */
export function billingCheckoutTerms(input: CheckoutTermsInput): BillingCheckoutTerms {
  const status = checkoutStatus(input);
  const days = trialDays(input, status);
  const getsTrial = typeof days === 'number' && days > 0;
  const unsigned: Omit<BillingCheckoutTerms, 'revision'> = {
    schema_version: 1,
    checkout_status: status,
    blocker_code: status === 'available' ? null : status,
    payment_method_required: true,
    trial_eligible: days === null ? null : getsTrial,
    trial_days: days,
    due_at_checkout: {
      amount_cents: getsTrial ? 0 : input.plan.amount_cents,
      currency: input.plan.currency,
      amount_kind: getsTrial ? 'exact' : 'catalog_before_tax_and_promotions',
    },
    first_charge: {
      regular_subtotal_cents: input.plan.amount_cents,
      currency: input.plan.currency,
      timing: getsTrial
        ? { kind: 'days_after_checkout_completion', days: days ?? TRIAL_DAYS }
        : { kind: 'at_checkout_completion' },
    },
    renewal: {
      regular_subtotal_cents: input.plan.amount_cents,
      currency: input.plan.currency,
      interval: input.plan.interval,
      interval_count: input.plan.interval_count,
    },
    automatic_tax_enabled: input.automatic_tax_enabled,
    promotion_codes_allowed: true,
    price_basis: 'catalog_before_tax_and_promotions',
  };
  return { ...unsigned, revision: termsRevision(unsigned, input.provider_price_id) };
}

/**
 * Stored on the offer so an idempotent replay can prove its Stripe session was created from the
 * same commercial terms the client just accepted. The entitlement prefix keeps the existing audit
 * meaning of pricing_offers.policy_version while the checkout suffix binds the exact preview.
 */
export function checkoutOfferPolicyVersion(
  entitlementPolicyVersion: string,
  checkoutTermsRevision: string,
): string {
  return `${entitlementPolicyVersion}:${checkoutTermsRevision}`;
}
