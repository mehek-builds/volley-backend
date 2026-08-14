import { createHmac, timingSafeEqual } from 'node:crypto';
import { LitosBillingInterval, litosAmountCents, normalizeBillingInterval } from './litosPayCore';

export type StripeCheckoutSession = {
  id: string;
  url: string;
  customerId: string | null;
  subscriptionId: string | null;
};

export type StripeCheckoutCompleted = {
  eventKey: string;
  eventName: 'checkout.session.completed';
  sessionId: string;
  livemode: boolean;
  intentId: string;
  userId: string;
  email: string | null;
  interval: LitosBillingInterval;
  amountCents: number;
  currency: 'USD';
  customerId: string;
  subscriptionId: string;
  status: 'active';
  plan: 'pro';
  renewsAt: Date | null;
  endsAt: Date | null;
  happenedAt: Date;
};

export type StripeSubscriptionChanged = {
  eventKey: string;
  eventName:
    | 'customer.subscription.created'
    | 'customer.subscription.updated'
    | 'customer.subscription.deleted';
  livemode: boolean;
  subscriptionId: string;
  customerId: string;
  userId: string | null;
  priceId: string;
  interval: LitosBillingInterval;
  status: string;
  plan: 'free' | 'pro' | null;
  renewsAt: Date | null;
  endsAt: Date | null;
  happenedAt: Date;
};

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

export function stripeAcquiringConfigured(): boolean {
  const secretKey = env('STRIPE_SECRET_KEY');
  const webhookSecret = env('STRIPE_WEBHOOK_SECRET');
  const weeklyPriceId = env('STRIPE_WEEKLY_PRICE_ID');
  const monthlyPriceId = env('STRIPE_MONTHLY_PRICE_ID');
  if (!secretKey || !/^(?:sk|rk)_(?:test|live)_[A-Za-z0-9_]+$/.test(secretKey)) return false;
  if (!webhookSecret?.startsWith('whsec_')) return false;
  if (!weeklyPriceId?.startsWith('price_') || !monthlyPriceId?.startsWith('price_')) return false;
  if (process.env.NODE_ENV === 'production') {
    if (!/^(?:sk|rk)_live_/.test(secretKey)) return false;
  }
  return Boolean(
    env('LITOS_PAY_STRIPE_ENABLED') === 'true' &&
      webhookSecret &&
      weeklyPriceId &&
      monthlyPriceId,
  );
}

export function stripeRequiresLivemode(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function stripePriceIdForInterval(interval: LitosBillingInterval): string | undefined {
  return interval === 'weekly' ? env('STRIPE_WEEKLY_PRICE_ID') : env('STRIPE_MONTHLY_PRICE_ID');
}

export function stripePlanForStatus(status: string): 'free' | 'pro' | null {
  if (status === 'active' || status === 'trialing' || status === 'past_due') return 'pro';
  if (status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired' || status === 'paused') return 'free';
  return null;
}

function checkoutReturnUrl(name: 'LITOS_PAY_SUCCESS_URL' | 'LITOS_PAY_CANCEL_URL', fallbackPath: string): string {
  const configured = env(name);
  if (configured) return configured;
  const base = env('PUBLIC_WEB_URL') || env('LITOS_WEB_URL') || 'https://trylitos.com';
  try {
    return new URL(fallbackPath, base).toString();
  } catch {
    return `https://trylitos.com${fallbackPath}`;
  }
}

function portalReturnUrl(): string {
  const configured = env('STRIPE_PORTAL_RETURN_URL');
  if (configured) return configured;
  const base = env('PUBLIC_WEB_URL') || env('LITOS_WEB_URL') || 'https://trylitos.com';
  try {
    return new URL('/dashboard/settings#plan', base).toString();
  } catch {
    return 'https://trylitos.com/dashboard/settings#plan';
  }
}

export function secureStripeCheckoutUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.hostname !== 'checkout.stripe.com' && !url.hostname.endsWith('.checkout.stripe.com')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function secureStripePortalUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'billing.stripe.com') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function scalar(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function uuid(value: string | null): string | null {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

export async function createStripeCheckoutSession(input: {
  intentId: string;
  userId: string;
  email: string;
  interval: LitosBillingInterval;
  fetchImpl?: typeof fetch;
}): Promise<StripeCheckoutSession | null> {
  const secretKey = env('STRIPE_SECRET_KEY');
  const priceId = stripePriceIdForInterval(input.interval);
  if (!secretKey || !priceId) return null;

  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('client_reference_id', input.intentId);
  body.set('customer_email', input.email.trim().toLowerCase());
  body.set('line_items[0][price]', priceId);
  body.set('line_items[0][quantity]', '1');
  body.set('success_url', checkoutReturnUrl('LITOS_PAY_SUCCESS_URL', '/billing/return'));
  body.set('cancel_url', checkoutReturnUrl('LITOS_PAY_CANCEL_URL', '/billing/return?status=cancelled'));
  body.set('metadata[litos_intent_id]', input.intentId);
  body.set('metadata[user_id]', input.userId);
  body.set('metadata[interval]', input.interval);
  body.set('subscription_data[metadata][litos_intent_id]', input.intentId);
  body.set('subscription_data[metadata][user_id]', input.userId);
  body.set('subscription_data[metadata][interval]', input.interval);
  body.set('allow_promotion_codes', 'true');
  if (env('STRIPE_AUTOMATIC_TAX_ENABLED') === 'true') body.set('automatic_tax[enabled]', 'true');

  const fetcher = input.fetchImpl ?? fetch;
  const response = await fetcher('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `litos-checkout-${input.intentId}`,
    },
    body,
  });
  if (!response.ok) return null;
  const session = await response.json() as Record<string, unknown>;
  const id = scalar(session.id);
  const url = secureStripeCheckoutUrl(session.url);
  if (!id || !url) return null;
  return {
    id,
    url,
    customerId: scalar(session.customer),
    subscriptionId: scalar(session.subscription),
  };
}

export async function createStripePortalSession(input: {
  customerId: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const secretKey = env('STRIPE_SECRET_KEY');
  if (!secretKey || !input.customerId.startsWith('cus_')) return null;

  const body = new URLSearchParams();
  body.set('customer', input.customerId);
  body.set('return_url', portalReturnUrl());
  const fetcher = input.fetchImpl ?? fetch;
  const response = await fetcher('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!response.ok) return null;
  const session = await response.json() as Record<string, unknown>;
  return secureStripePortalUrl(session.url);
}

function safeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function stripeWebhookSignature(rawBody: Buffer, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const signature = createHmac('sha256', secret).update(signedPayload).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

export function verifyStripeWebhookSignature(input: {
  rawBody: Buffer;
  signatureHeader: string;
  secret: string;
  now?: Date;
  toleranceSeconds?: number;
}): boolean {
  const parts = input.signatureHeader.split(',').map((part) => part.trim());
  const timestampValue = parts.find((part) => part.startsWith('t='))?.slice(2);
  const signatures = parts.filter((part) => part.startsWith('v1=')).map((part) => part.slice(3));
  const timestamp = timestampValue ? Number(timestampValue) : NaN;
  if (!Number.isFinite(timestamp) || signatures.length === 0) return false;
  const tolerance = input.toleranceSeconds ?? 300;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (tolerance > 0 && Math.abs(nowSeconds - timestamp) > tolerance) return false;

  const signedPayload = `${timestamp}.${input.rawBody.toString('utf8')}`;
  const expected = createHmac('sha256', input.secret).update(signedPayload).digest('hex');
  return signatures.some((signature) => safeEqualHex(signature, expected));
}

export function parseStripeCheckoutCompleted(event: unknown): StripeCheckoutCompleted | null {
  if (!event || typeof event !== 'object') return null;
  const envelope = event as Record<string, unknown>;
  if (envelope.type !== 'checkout.session.completed') return null;
  const eventId = scalar(envelope.id);
  if (!eventId) return null;
  const created = typeof envelope.created === 'number' ? envelope.created : Math.floor(Date.now() / 1000);
  const data = envelope.data && typeof envelope.data === 'object' ? envelope.data as Record<string, unknown> : null;
  const object = data?.object && typeof data.object === 'object' ? data.object as Record<string, unknown> : null;
  if (!object || object.object !== 'checkout.session') return null;
  if (object.payment_status !== 'paid') return null;

  const sessionId = scalar(object.id);
  const metadata = object.metadata && typeof object.metadata === 'object'
    ? object.metadata as Record<string, unknown>
    : {};
  const intentId = uuid(scalar(metadata.litos_intent_id) || scalar(object.client_reference_id));
  const userId = uuid(scalar(metadata.user_id));
  const interval = normalizeBillingInterval(metadata.interval);
  const customerId = scalar(object.customer);
  const subscriptionId = scalar(object.subscription);
  if (!sessionId || !intentId || !userId || !customerId || !subscriptionId) return null;

  return {
    eventKey: `stripe:${eventId}`,
    eventName: 'checkout.session.completed',
    sessionId,
    livemode: envelope.livemode === true,
    intentId,
    userId,
    email: scalar(object.customer_email),
    interval,
    amountCents: litosAmountCents(interval),
    currency: 'USD',
    customerId,
    subscriptionId,
    status: 'active',
    plan: 'pro',
    renewsAt: null,
    endsAt: null,
    happenedAt: new Date(created * 1000),
  };
}

function unixDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function subscriptionPeriodEnd(subscription: Record<string, any>): Date | null {
  const direct = unixDate(subscription.current_period_end);
  if (direct) return direct;
  const ends = Array.isArray(subscription.items?.data)
    ? subscription.items.data.map((item: any) => unixDate(item?.current_period_end)).filter(Boolean) as Date[]
    : [];
  return ends.length > 0 ? new Date(Math.max(...ends.map((date) => date.getTime()))) : null;
}

export function parseStripeSubscriptionChanged(event: unknown): StripeSubscriptionChanged | null {
  if (!event || typeof event !== 'object') return null;
  const envelope = event as Record<string, any>;
  const eventName = envelope.type;
  if (![
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
  ].includes(eventName)) return null;
  const eventId = scalar(envelope.id);
  const subscription = envelope.data?.object;
  if (!eventId || !subscription || subscription.object !== 'subscription') return null;

  const subscriptionId = scalar(subscription.id);
  const customerId = scalar(subscription.customer?.id) || scalar(subscription.customer);
  const status = scalar(subscription.status);
  const item = Array.isArray(subscription.items?.data) ? subscription.items.data[0] : null;
  const priceId = scalar(item?.price?.id);
  const intervalValue = scalar(subscription.metadata?.interval) || scalar(item?.price?.recurring?.interval);
  const interval = intervalValue === 'weekly' || intervalValue === 'week' ? 'weekly' : 'monthly';
  const candidateUserId = uuid(scalar(subscription.metadata?.user_id));
  const happenedAt = unixDate(envelope.created);
  if (!subscriptionId || !customerId || !status || !priceId || !happenedAt) return null;

  const periodEnd = subscriptionPeriodEnd(subscription);
  const cancelAt = unixDate(subscription.cancel_at);
  const endedAt = unixDate(subscription.ended_at);
  const willEnd = subscription.cancel_at_period_end === true;
  return {
    eventKey: `stripe:${eventId}`,
    eventName,
    livemode: envelope.livemode === true,
    subscriptionId,
    customerId,
    userId: candidateUserId,
    priceId,
    interval,
    status,
    plan: stripePlanForStatus(status),
    renewsAt: willEnd || stripePlanForStatus(status) === 'free' ? null : periodEnd,
    endsAt: willEnd ? (cancelAt || periodEnd) : endedAt,
    happenedAt,
  };
}
