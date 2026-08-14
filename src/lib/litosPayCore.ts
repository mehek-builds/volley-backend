import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type LitosBillingInterval = 'weekly' | 'monthly';
export type LitosProcessorEventName =
  | 'checkout.paid'
  | 'invoice.payment_failed'
  | 'refund.created'
  | 'dispute.opened'
  | 'subscription.canceled';

export type LitosCheckoutIntent = {
  intentId: string;
  token: string;
  url: string;
  interval: LitosBillingInterval;
  amountCents: number;
  currency: 'USD';
  expiresAt: Date;
};

export type LitosProcessorEvent = {
  eventKey: string;
  eventName: LitosProcessorEventName;
  userId: string;
  email: string;
  interval: LitosBillingInterval;
  amountCents: number;
  currency: 'USD';
  customerId: string;
  subscriptionId: string;
  status: string;
  plan: 'free' | 'pro';
  renewsAt: Date | null;
  endsAt: Date | null;
  riskStatus: 'low' | 'medium' | 'high';
  happenedAt: Date;
};

const CHECKOUT_TTL_MS = 30 * 60 * 1000;
const WEEKLY_AMOUNT_CENTS = 1_999;
const MONTHLY_AMOUNT_CENTS = 3_999;

function signingSecret(): string | undefined {
  const value = process.env.LITOS_PAY_SIGNING_SECRET?.trim();
  return value && value.length >= 32 ? value : undefined;
}

export function litosProcessorConfigured(): boolean {
  return process.env.LITOS_PAY_PROCESSOR_ENABLED === 'true' && Boolean(signingSecret());
}

export function litosProcessorTrialConfigured(): boolean {
  return process.env.LITOS_PAY_TEST_TRIAL_ENABLED === 'true' && Boolean(signingSecret());
}

export function normalizeBillingInterval(value: unknown): LitosBillingInterval {
  return value === 'weekly' || value === 'week' ? 'weekly' : 'monthly';
}

export function litosAmountCents(interval: LitosBillingInterval): number {
  return interval === 'weekly' ? WEEKLY_AMOUNT_CENTS : MONTHLY_AMOUNT_CENTS;
}

function base64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function checkoutBaseUrl(): string {
  const raw = process.env.LITOS_PAY_CHECKOUT_BASE_URL?.trim() || process.env.PUBLIC_API_URL?.trim() || 'https://api.trylitos.com';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && process.env.NODE_ENV !== 'test') return 'https://api.trylitos.com';
    return url.toString().replace(/\/$/, '');
  } catch {
    return 'https://api.trylitos.com';
  }
}

export function buildLitosCheckoutIntent(input: {
  userId: string;
  email: string;
  interval?: unknown;
  now?: Date;
}): LitosCheckoutIntent | null {
  const secret = signingSecret();
  if (!secret) return null;
  const now = input.now ?? new Date();
  const interval = normalizeBillingInterval(input.interval);
  const intentId = randomUUID();
  const expiresAt = new Date(now.getTime() + CHECKOUT_TTL_MS);
  const payload = base64urlJson({
    typ: 'litos_checkout_intent',
    intentId,
    userId: input.userId,
    email: input.email.trim().toLowerCase(),
    interval,
    amountCents: litosAmountCents(interval),
    currency: 'USD',
    exp: expiresAt.toISOString(),
  });
  const token = `${payload}.${signPayload(payload, secret)}`;
  const url = new URL(`${checkoutBaseUrl()}/billing/litos-pay/checkout/${intentId}`);
  url.searchParams.set('token', token);
  return {
    intentId,
    token,
    url: url.toString(),
    interval,
    amountCents: litosAmountCents(interval),
    currency: 'USD',
    expiresAt,
  };
}

export function parseLitosCheckoutToken(token: string, now = new Date()): null | {
  intentId: string;
  userId: string;
  email: string;
  interval: LitosBillingInterval;
  amountCents: number;
  currency: 'USD';
  expiresAt: Date;
} {
  const secret = signingSecret();
  if (!secret) return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  if (!safeEqual(signature, signPayload(payload, secret))) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const expiresAt = typeof parsed.exp === 'string' ? new Date(parsed.exp) : null;
  if (!expiresAt || Number.isNaN(expiresAt.getTime()) || expiresAt <= now) return null;
  const interval = normalizeBillingInterval(parsed.interval);
  const amountCents = litosAmountCents(interval);
  if (
    parsed.typ !== 'litos_checkout_intent' ||
    typeof parsed.intentId !== 'string' ||
    typeof parsed.userId !== 'string' ||
    typeof parsed.email !== 'string' ||
    parsed.amountCents !== amountCents ||
    parsed.currency !== 'USD'
  ) {
    return null;
  }
  return {
    intentId: parsed.intentId,
    userId: parsed.userId,
    email: parsed.email.trim().toLowerCase(),
    interval,
    amountCents,
    currency: 'USD',
    expiresAt,
  };
}

export function eventFromPaidCheckout(token: string, now = new Date()): LitosProcessorEvent | null {
  const intent = parseLitosCheckoutToken(token, now);
  if (!intent) return null;
  const periodMs = intent.interval === 'weekly' ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  return {
    eventKey: `litos:${intent.intentId}:checkout.paid`,
    eventName: 'checkout.paid',
    userId: intent.userId,
    email: intent.email,
    interval: intent.interval,
    amountCents: intent.amountCents,
    currency: 'USD',
    customerId: `cus_litos_${intent.userId}`,
    subscriptionId: `sub_litos_${intent.intentId}`,
    status: 'active',
    plan: 'pro',
    renewsAt: new Date(now.getTime() + periodMs),
    endsAt: null,
    riskStatus: 'low',
    happenedAt: now,
  };
}
