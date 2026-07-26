import { createHmac, timingSafeEqual } from 'node:crypto';
import { BillingInterval, PricingOffer } from './regionalPricing';

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
  orderId: string;
  variantId: string;
  status: string;
  renewsAt: Date | null;
  endsAt: Date | null;
  portalUrl: string | null;
  updatedAt: Date;
  testMode: boolean;
  offerId?: string;
  pricingCountry?: string;
  pricingBand?: string;
  pricingPolicyVersion?: string;
  pricingExperimentId?: string;
  pricingExperimentVariant?: string;
  pricingAmountCents?: number;
};

export type CreatedLemonSqueezyCheckout = {
  id: string;
  url: string;
  expiresAt: Date | null;
};

type CreateCheckoutInput = {
  userId: string;
  email: string;
  offerId: string;
  offer: PricingOffer;
  accountToken: string;
  expiresAt: Date;
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

export function lemonSqueezyVariantId(interval: BillingInterval): string | undefined {
  const explicit = interval === 'yearly'
    ? process.env.LEMONSQUEEZY_VARIANT_ID_YEARLY?.trim()
    : process.env.LEMONSQUEEZY_VARIANT_ID_MONTHLY?.trim();
  if (explicit && /^\d+$/.test(explicit)) return explicit;
  const legacy = process.env.LEMONSQUEEZY_VARIANT_ID?.trim();
  return interval === 'monthly' && legacy && /^\d+$/.test(legacy) ? legacy : undefined;
}

export function lemonSqueezyApiReady(interval: BillingInterval = 'monthly'): boolean {
  return Boolean(
    process.env.LEMONSQUEEZY_API_KEY?.trim()
    && process.env.LEMONSQUEEZY_STORE_ID?.trim()
    && lemonSqueezyVariantId(interval)
    && process.env.LEMONSQUEEZY_WEBHOOK_SECRET?.trim(),
  );
}

export function isSafeLemonSqueezyCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (url.hostname !== 'lemonsqueezy.com' && !url.hostname.endsWith('.lemonsqueezy.com')) return false;
    return url.pathname.startsWith('/checkout/custom/') || url.pathname.startsWith('/checkout/buy/');
  } catch {
    return false;
  }
}

export async function createLemonSqueezyCheckout(
  input: CreateCheckoutInput,
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedLemonSqueezyCheckout> {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY?.trim();
  const storeId = process.env.LEMONSQUEEZY_STORE_ID?.trim();
  const variantId = lemonSqueezyVariantId(input.offer.interval);
  if (!apiKey || !storeId || !variantId) throw new Error('Lemon Squeezy API checkout is not configured.');

  const response = await fetchImpl('https://api.lemonsqueezy.com/v1/checkouts', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      data: {
        type: 'checkouts',
        attributes: {
          custom_price: input.offer.amountCents,
          product_options: {
            redirect_url: 'https://trylitos.com/dashboard/settings?billing=success',
            enabled_variants: [Number(variantId)],
          },
          checkout_options: {
            embed: false,
            discount: false,
            subscription_preview: true,
            button_color: '#6b84e8',
          },
          checkout_data: {
            email: input.email.trim().toLowerCase(),
            ...(input.offer.countryCode !== 'ZZ' ? { billing_address: { country: input.offer.countryCode } } : {}),
            custom: {
              user_id: input.userId,
              account_token: input.accountToken,
              offer_id: input.offerId,
              pricing_country: input.offer.countryCode,
              pricing_band: input.offer.band,
              pricing_policy_version: input.offer.policyVersion,
              pricing_experiment_id: input.offer.experimentId ?? 'none',
              pricing_experiment_variant: input.offer.experimentVariant,
              pricing_amount_cents: String(input.offer.amountCents),
              pricing_interval: input.offer.interval,
            },
          },
          expires_at: input.expiresAt.toISOString(),
          preview: true,
        },
        relationships: {
          store: { data: { type: 'stores', id: storeId } },
          variant: { data: { type: 'variants', id: variantId } },
        },
      },
    }),
    signal: AbortSignal.timeout(10_000),
  });
  const payload = await response.json().catch(() => null) as Record<string, any> | null;
  if (!response.ok) {
    const detail = payload?.errors?.[0]?.detail;
    throw new Error(typeof detail === 'string' ? `Lemon Squeezy checkout failed: ${detail}` : `Lemon Squeezy checkout failed (${response.status}).`);
  }
  const id = String(payload?.data?.id ?? '');
  const url = typeof payload?.data?.attributes?.url === 'string' ? payload.data.attributes.url : '';
  if (!id || !isSafeLemonSqueezyCheckoutUrl(url)) throw new Error('Lemon Squeezy returned an invalid checkout.');
  return { id, url, expiresAt: validDate(payload?.data?.attributes?.expires_at) };
}

export async function getLemonSqueezyCustomerCountry(
  customerId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  const apiKey = process.env.LEMONSQUEEZY_API_KEY?.trim();
  if (!apiKey || !/^\d+$/.test(customerId)) return null;
  const response = await fetchImpl(`https://api.lemonsqueezy.com/v1/customers/${customerId}`, {
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(7_500),
  });
  if (!response.ok) return null;
  const payload = await response.json().catch(() => null) as Record<string, any> | null;
  const country = payload?.data?.attributes?.country;
  return typeof country === 'string' && /^[A-Z]{2}$/i.test(country) ? country.toUpperCase() : null;
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
  const orderId = String(attributes?.order_id ?? '');
  const variantId = String(attributes?.variant_id ?? '');
  const status = typeof attributes?.status === 'string' ? attributes.status : '';
  const updatedAt = validDate(attributes?.updated_at);
  if (!subscriptionId || !customerId || !orderId || !variantId || !status || !updatedAt) return null;

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
  const custom = event.meta?.custom_data ?? {};
  const offerId = typeof custom.offer_id === 'string' && /^[0-9a-f-]{36}$/i.test(custom.offer_id)
    ? custom.offer_id
    : undefined;
  const pricingAmount = Number(custom.pricing_amount_cents);

  return {
    eventName,
    subscriptionId,
    ...(userId ? { userId } : {}),
    ...(accountToken ? { accountToken } : {}),
    ...(email ? { email } : {}),
    customerId,
    orderId,
    variantId,
    status,
    renewsAt: validDate(attributes?.renews_at),
    endsAt: validDate(attributes?.ends_at),
    portalUrl,
    updatedAt,
    testMode: attributes?.test_mode === true,
    ...(offerId ? { offerId } : {}),
    ...(typeof custom.pricing_country === 'string' ? { pricingCountry: custom.pricing_country } : {}),
    ...(typeof custom.pricing_band === 'string' ? { pricingBand: custom.pricing_band } : {}),
    ...(typeof custom.pricing_policy_version === 'string' ? { pricingPolicyVersion: custom.pricing_policy_version } : {}),
    ...(typeof custom.pricing_experiment_id === 'string' ? { pricingExperimentId: custom.pricing_experiment_id } : {}),
    ...(typeof custom.pricing_experiment_variant === 'string' ? { pricingExperimentVariant: custom.pricing_experiment_variant } : {}),
    ...(Number.isInteger(pricingAmount) && pricingAmount > 0 ? { pricingAmountCents: pricingAmount } : {}),
  };
}

export function planForLemonSqueezyStatus(status: string): 'pro' | 'free' | null {
  if (LEMON_SQUEEZY_ACTIVE_STATUSES.has(status)) return 'pro';
  if (status === 'expired') return 'free';
  return null;
}
