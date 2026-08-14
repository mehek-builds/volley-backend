export type LitosPlanId = 'litos_plus_week' | 'litos_plus_month' | 'litos_plus_quarter';
export type BillingTerm = 'week' | 'month' | 'quarter';

export type BillingCatalogPlan = {
  id: LitosPlanId;
  product_code: 'litos_plus';
  term: BillingTerm;
  display_duration: '1 Week' | '1 Month' | '3 Months';
  amount_cents: 1999 | 3999 | 8999;
  currency: 'USD';
  interval: 'week' | 'month';
  interval_count: 1 | 3;
  days: 7 | 30 | 90;
  daily_equivalent_cents: 285 | 133 | 99;
  weekly_baseline_savings_percent: 0 | 53 | 65;
  price_env: 'STRIPE_PLUS_WEEKLY_PRICE_ID' | 'STRIPE_PLUS_MONTHLY_PRICE_ID' | 'STRIPE_PLUS_QUARTERLY_PRICE_ID';
};

const plans = [
  {
    id: 'litos_plus_week',
    product_code: 'litos_plus',
    term: 'week',
    display_duration: '1 Week',
    amount_cents: 1_999,
    currency: 'USD',
    interval: 'week',
    interval_count: 1,
    days: 7,
    daily_equivalent_cents: 285,
    weekly_baseline_savings_percent: 0,
    price_env: 'STRIPE_PLUS_WEEKLY_PRICE_ID',
  },
  {
    id: 'litos_plus_month',
    product_code: 'litos_plus',
    term: 'month',
    display_duration: '1 Month',
    amount_cents: 3_999,
    currency: 'USD',
    interval: 'month',
    interval_count: 1,
    days: 30,
    daily_equivalent_cents: 133,
    weekly_baseline_savings_percent: 53,
    price_env: 'STRIPE_PLUS_MONTHLY_PRICE_ID',
  },
  {
    id: 'litos_plus_quarter',
    product_code: 'litos_plus',
    term: 'quarter',
    display_duration: '3 Months',
    amount_cents: 8_999,
    currency: 'USD',
    interval: 'month',
    interval_count: 3,
    days: 90,
    daily_equivalent_cents: 99,
    weekly_baseline_savings_percent: 65,
    price_env: 'STRIPE_PLUS_QUARTERLY_PRICE_ID',
  },
] as const satisfies readonly BillingCatalogPlan[];

export const BILLING_CATALOG: readonly BillingCatalogPlan[] = plans;

export function billingPlan(planId: unknown): BillingCatalogPlan | null {
  if (typeof planId !== 'string') return null;
  return BILLING_CATALOG.find((plan) => plan.id === planId) ?? null;
}

export function billingPlanForTerm(term: unknown): BillingCatalogPlan | null {
  if (typeof term !== 'string') return null;
  return BILLING_CATALOG.find((plan) => plan.term === term) ?? null;
}

export function billingPlanForPriceId(priceId: unknown, env: NodeJS.ProcessEnv = process.env): BillingCatalogPlan | null {
  if (typeof priceId !== 'string' || !priceId) return null;
  return BILLING_CATALOG.find((plan) => env[plan.price_env]?.trim() === priceId) ?? null;
}

export function stripePriceIdForPlan(planId: LitosPlanId, env: NodeJS.ProcessEnv = process.env): string | null {
  const plan = billingPlan(planId);
  const priceId = plan ? env[plan.price_env]?.trim() : undefined;
  return priceId?.startsWith('price_') ? priceId : null;
}

export function billingCheckoutAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  if (env.LITOS_BILLING_ENABLED !== 'true') return false;
  if (!secretKey || !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/.test(secretKey)) return false;
  if (env.NODE_ENV === 'production' && !/^(?:sk|rk)_live_/.test(secretKey)) return false;
  return BILLING_CATALOG.every((plan) => stripePriceIdForPlan(plan.id, env));
}

export function stripeWebhookAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  const secretKey = env.STRIPE_SECRET_KEY?.trim();
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secretKey || !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/.test(secretKey)) return false;
  if (env.NODE_ENV === 'production' && !/^(?:sk|rk)_live_/.test(secretKey)) return false;
  return Boolean(webhookSecret?.startsWith('whsec_'));
}

export function publicBillingPlans(env: NodeJS.ProcessEnv = process.env) {
  return {
    schema_version: 1 as const,
    currency: 'USD' as const,
    checkout_available: billingCheckoutAvailable(env),
    feature_bundle: 'litos_plus' as const,
    plans: BILLING_CATALOG.map(({ price_env: _priceEnv, product_code, ...plan }) => ({
      ...plan,
      feature_bundle: product_code,
    })),
  };
}

export type StripePriceFact = {
  id: string;
  active: boolean;
  currency: string;
  unit_amount: number | null;
  recurring: null | { interval: string; interval_count: number };
};

export function validateStripePriceFact(plan: BillingCatalogPlan, fact: StripePriceFact): string[] {
  const issues: string[] = [];
  if (!fact.active) issues.push('price is inactive');
  if (fact.currency.toUpperCase() !== plan.currency) issues.push(`expected ${plan.currency} currency`);
  if (fact.unit_amount !== plan.amount_cents) issues.push(`expected ${plan.amount_cents} cents`);
  if (!fact.recurring) issues.push('price is not recurring');
  if (fact.recurring && fact.recurring.interval !== plan.interval) issues.push(`expected ${plan.interval} recurrence`);
  if (fact.recurring && fact.recurring.interval_count !== plan.interval_count) {
    issues.push(`expected interval count ${plan.interval_count}`);
  }
  return issues;
}
