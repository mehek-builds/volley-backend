import { createHmac, timingSafeEqual } from 'node:crypto';

export const LEMON_SQUEEZY_ACTIVE_STATUSES = new Set([
  'on_trial',
  'active',
  'paused',
  'past_due',
  'unpaid',
  'cancelled',
]);

export type LemonSqueezySubscription = {
  eventName: string;
  subscriptionId: string;
  userId?: string;
  accountToken?: string;
  email?: string;
  customerId: string;
  variantId: string;
  status: string;
  renewsAt: Date | null;
  endsAt: Date | null;
  portalUrl: string | null;
  updatedAt: Date;
  testMode: boolean;
};

function validDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function lemonSqueezyCheckoutBaseUrl(): string | undefined {
  const raw = process.env.LEMONSQUEEZY_CHECKOUT_URL?.trim();
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return undefined;
    if (url.hostname !== 'lemonsqueezy.com' && !url.hostname.endsWith('.lemonsqueezy.com')) return undefined;
    if (!url.pathname.startsWith('/checkout/buy/')) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export function lemonSqueezyCheckoutReadyUrl(): string | undefined {
  const base = lemonSqueezyCheckoutBaseUrl();
  if (!base || !process.env.LEMONSQUEEZY_WEBHOOK_SECRET || !process.env.LEMONSQUEEZY_VARIANT_ID?.trim()) {
    return undefined;
  }
  return base;
}

export function buildLemonSqueezyCheckoutUrl(userId: string, email: string): string | undefined {
  const base = lemonSqueezyCheckoutReadyUrl();
  const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (!base || !secret) return undefined;
  const url = new URL(base);
  url.searchParams.set('checkout[custom][user_id]', userId);
  url.searchParams.set('checkout[custom][account_token]', createHmac('sha256', secret).update(userId).digest('hex'));
  url.searchParams.set('checkout[email]', email.trim().toLowerCase());
  return url.toString();
}

export function verifyLemonSqueezyAccountToken(userId: string, token: string | undefined, secret: string): boolean {
  if (!token || !/^[a-f0-9]{64}$/i.test(token)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(userId).digest('hex'), 'hex');
  const given = Buffer.from(token, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function verifyLemonSqueezySignature(raw: Buffer, signature: string, secret: string): boolean {
  if (!/^[a-f0-9]{64}$/i.test(signature)) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(raw).digest('hex'), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function parseLemonSqueezySubscription(payload: unknown): LemonSqueezySubscription | null {
  if (!payload || typeof payload !== 'object') return null;
  const event = payload as Record<string, any>;
  const eventName = event.meta?.event_name;
  if (!['subscription_created', 'subscription_updated'].includes(eventName)) return null;
  if (event.data?.type !== 'subscriptions') return null;

  const attributes = event.data?.attributes;
  const subscriptionId = String(event.data?.id ?? '');
  const customerId = String(attributes?.customer_id ?? '');
  const variantId = String(attributes?.variant_id ?? '');
  const status = typeof attributes?.status === 'string' ? attributes.status : '';
  const updatedAt = validDate(attributes?.updated_at);
  if (!subscriptionId || !customerId || !variantId || !status || !updatedAt) return null;

  const portal = attributes?.urls?.customer_portal;
  let portalUrl: string | null = null;
  try {
    const url = new URL(typeof portal === 'string' ? portal : '');
    if (url.protocol === 'https:' && (url.hostname === 'lemonsqueezy.com' || url.hostname.endsWith('.lemonsqueezy.com'))) {
      portalUrl = url.toString();
    }
  } catch {
    portalUrl = null;
  }
  const candidateUserId = typeof event.meta?.custom_data?.user_id === 'string'
    ? event.meta.custom_data.user_id
    : event.meta?.custom_data?.user_id != null
      ? String(event.meta.custom_data.user_id)
      : undefined;
  const userId = candidateUserId && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidateUserId)
    ? candidateUserId
    : undefined;
  const accountToken = typeof event.meta?.custom_data?.account_token === 'string'
    ? event.meta.custom_data.account_token
    : undefined;
  const email = typeof attributes?.user_email === 'string' ? attributes.user_email.trim().toLowerCase() : undefined;

  return {
    eventName,
    subscriptionId,
    ...(userId ? { userId } : {}),
    ...(accountToken ? { accountToken } : {}),
    ...(email ? { email } : {}),
    customerId,
    variantId,
    status,
    renewsAt: validDate(attributes?.renews_at),
    endsAt: validDate(attributes?.ends_at),
    portalUrl,
    updatedAt,
    testMode: attributes?.test_mode === true,
  };
}

export function planForLemonSqueezyStatus(status: string): 'pro' | 'free' | null {
  if (LEMON_SQUEEZY_ACTIVE_STATUSES.has(status)) return 'pro';
  if (status === 'expired') return 'free';
  return null;
}
