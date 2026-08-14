import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { db } from '../db';
import { billing_webhook_events, pricing_offers, users } from '../db/schema';
import { stripeWebhookSignature } from '../lib/stripeAcquiring';
import { billingRoutes } from './billing';

const USER_ID = '6d58c1f5-e885-41f7-a16a-dac37f98ab17';
const SECRET = 'test-signing-secret-32-chars-minimum!!';
const PAY_SECRET = 'test-litos-pay-secret-at-least-32-chars';

const savedEnv = {
  vercel: process.env.VERCEL,
  log: process.env.LOG_LEVEL,
  database: process.env.DATABASE_URL,
  jwt: process.env.JWT_SIGNING_SECRET,
  encryption: process.env.ENCRYPTION_KEY,
  payEnabled: process.env.LITOS_PAY_PROCESSOR_ENABLED,
  trialEnabled: process.env.LITOS_PAY_TEST_TRIAL_ENABLED,
  paySecret: process.env.LITOS_PAY_SIGNING_SECRET,
  payBase: process.env.LITOS_PAY_CHECKOUT_BASE_URL,
  stripeEnabled: process.env.LITOS_PAY_STRIPE_ENABLED,
  stripeKey: process.env.STRIPE_SECRET_KEY,
  stripeWebhook: process.env.STRIPE_WEBHOOK_SECRET,
  stripeWeekly: process.env.STRIPE_WEEKLY_PRICE_ID,
  stripeMonthly: process.env.STRIPE_MONTHLY_PRICE_ID,
  nodeEnv: process.env.NODE_ENV,
};

beforeEach(() => {
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5432/unused-in-these-tests';
  process.env.JWT_SIGNING_SECRET = SECRET;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32-chars-long';
  process.env.LITOS_PAY_PROCESSOR_ENABLED = 'true';
  process.env.LITOS_PAY_TEST_TRIAL_ENABLED = 'true';
  process.env.LITOS_PAY_SIGNING_SECRET = PAY_SECRET;
  process.env.LITOS_PAY_CHECKOUT_BASE_URL = 'http://localhost:8787';
  delete process.env.LITOS_PAY_STRIPE_ENABLED;
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEEKLY_PRICE_ID;
  delete process.env.STRIPE_MONTHLY_PRICE_ID;
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(savedEnv)) {
    const envKey = key === 'payEnabled'
      ? 'LITOS_PAY_PROCESSOR_ENABLED'
      : key === 'trialEnabled'
        ? 'LITOS_PAY_TEST_TRIAL_ENABLED'
        : key === 'paySecret'
          ? 'LITOS_PAY_SIGNING_SECRET'
          : key === 'payBase'
            ? 'LITOS_PAY_CHECKOUT_BASE_URL'
            : key === 'stripeEnabled'
              ? 'LITOS_PAY_STRIPE_ENABLED'
              : key === 'stripeKey'
                ? 'STRIPE_SECRET_KEY'
                : key === 'stripeWebhook'
                  ? 'STRIPE_WEBHOOK_SECRET'
                  : key === 'stripeWeekly'
                    ? 'STRIPE_WEEKLY_PRICE_ID'
                    : key === 'stripeMonthly'
                      ? 'STRIPE_MONTHLY_PRICE_ID'
                      : key === 'nodeEnv'
                        ? 'NODE_ENV'
                        : key === 'database'
                          ? 'DATABASE_URL'
                          : key === 'jwt'
                            ? 'JWT_SIGNING_SECRET'
                            : key === 'encryption'
                              ? 'ENCRYPTION_KEY'
                              : key === 'log'
                                ? 'LOG_LEVEL'
                                : 'VERCEL';
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

async function token() {
  return new SignJWT({
    userId: USER_ID,
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(SECRET));
}

function selectUserMock() {
  return mock.method(db, 'select', (() => ({
    from: () => ({
      where: () => ({
        limit: async () => [{
          id: USER_ID,
          email: 'student@example.com',
          is_guest: false,
          guest_expires_at: null,
          session_valid_from: null,
          session_version: 0,
          plan: 'free',
          created_at: new Date('2026-08-01T00:00:00.000Z'),
          trial_ends_at: new Date('2026-08-01T00:00:00.000Z'),
        }],
      }),
    }),
  })) as unknown as typeof db.select);
}

describe('Litos Pay Core billing routes', () => {
  test('creates a Litos checkout intent and completes a paid test trial through the ledger path', async () => {
    selectUserMock();
    const createdOffers: unknown[] = [];
    const txInserts: unknown[] = [];
    const txUpdates: unknown[] = [];

    mock.method(db, 'insert', ((table: unknown) => ({
      values: async (values: unknown) => {
        createdOffers.push({ table, values });
      },
    })) as unknown as typeof db.insert);

    const seenEvents = new Set<string>();
    mock.method(db, 'transaction', (async (callback: (tx: any) => Promise<void>) => {
      const tx = {
        insert: (table: unknown) => ({
          values: (values: unknown) => {
            const row = values as { event_key?: string };
            return {
              onConflictDoNothing: () => {
                if (!row.event_key) txInserts.push({ table, values });
                return {
                  returning: async () => {
                    if (row.event_key) {
                      if (seenEvents.has(row.event_key)) return [];
                      seenEvents.add(row.event_key);
                    }
                    txInserts.push({ table, values });
                    return row.event_key ? [{ event_key: row.event_key }] : [];
                  },
                };
              },
              then: undefined,
            };
          },
        }),
        update: (table: unknown) => ({
          set: (values: unknown) => ({
            where: async () => {
              txUpdates.push({ table, values });
            },
          }),
        }),
      };
      await callback(tx);
    }) as unknown as typeof db.transaction);

    const app = Fastify({ logger: false });
    await app.register(billingRoutes);
    await app.ready();
    try {
      const auth = await token();
      const checkout = await app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${auth}` },
        payload: { interval: 'weekly' },
      });
      assert.equal(checkout.statusCode, 200);
      const checkoutBody = checkout.json();
      assert.equal(checkoutBody.provider, 'litos');
      assert.equal(checkoutBody.amount_cents, 1_999);
      assert.equal(createdOffers.length, 1);

      const checkoutUrl = new URL(checkoutBody.url);
      const trial = await app.inject({
        method: 'POST',
        url: '/billing/litos-pay/test-trial',
        payload: { token: checkoutUrl.searchParams.get('token') },
      });
      assert.equal(trial.statusCode, 200);
      assert.equal(trial.json().plan, 'pro');
      assert.equal(txInserts.length, 1);
      assert.equal(txUpdates.length, 2);
      assert.deepEqual(
        txUpdates.map((entry: any) => entry.values.plan).filter(Boolean),
        ['pro'],
      );

      const replay = await app.inject({
        method: 'POST',
        url: '/billing/litos-pay/test-trial',
        payload: { token: checkoutUrl.searchParams.get('token') },
      });
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().processed, false);
      assert.equal(txInserts.length, 1, 'replay must not add another webhook event');
      assert.equal(txUpdates.length, 2, 'replay must not update offer or user state again');

    } finally {
      await app.close();
    }
  });

  test('the test trial completion route is unavailable outside the test runtime', async () => {
    process.env.NODE_ENV = 'production';
    const app = Fastify({ logger: false });
    await app.register(billingRoutes);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/litos-pay/test-trial',
        payload: { token: 'anything' },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });

  test('Stripe webhook stays disabled in production when Stripe is configured with test-mode keys', async () => {
    process.env.NODE_ENV = 'production';
    process.env.LITOS_PAY_STRIPE_ENABLED = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_not_live_money';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live_card_acquiring';
    process.env.STRIPE_WEEKLY_PRICE_ID = 'price_weekly';
    process.env.STRIPE_MONTHLY_PRICE_ID = 'price_monthly';

    const payload = Buffer.from(JSON.stringify({
      id: 'evt_test_mode',
      object: 'event',
      type: 'checkout.session.completed',
      livemode: false,
    }));
    const app = Fastify({ logger: false });
    await app.register(billingRoutes);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/stripe-webhook',
        headers: {
          'stripe-signature': stripeWebhookSignature(payload, process.env.STRIPE_WEBHOOK_SECRET!),
          'content-type': 'application/json',
        },
        payload,
      });
      assert.equal(res.statusCode, 503);
    } finally {
      await app.close();
    }
  });

  test('creates a live-card acquiring checkout, redirects through Litos, and fulfills from Stripe webhook', async () => {
    process.env.LITOS_PAY_STRIPE_ENABLED = 'true';
    process.env.STRIPE_SECRET_KEY = 'sk_test_live_card_acquiring';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live_card_acquiring';
    process.env.STRIPE_WEEKLY_PRICE_ID = 'price_weekly';
    process.env.STRIPE_MONTHLY_PRICE_ID = 'price_monthly';

    const createdOffers: any[] = [];
    const txInserts: unknown[] = [];
    const txUpdates: unknown[] = [];
    const seenEvents = new Set<string>();
    mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      assert.equal(body.get('mode'), 'subscription');
      assert.equal(body.get('line_items[0][price]'), 'price_monthly');
      assert.equal(body.get('metadata[user_id]'), USER_ID);
      return new Response(JSON.stringify({
        id: 'cs_test_litos_live_card',
        object: 'checkout.session',
        url: 'https://checkout.stripe.com/c/pay/cs_test_litos_live_card',
        customer: null,
        subscription: null,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    mock.method(db, 'select', (() => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === pricing_offers) return createdOffers.map((entry) => entry.values);
            if (table === billing_webhook_events) return [...seenEvents].map((event_key) => ({ event_key }));
            if (table === users) return [{
              id: USER_ID,
              email: 'student@example.com',
              is_guest: false,
              guest_expires_at: null,
              session_valid_from: null,
              session_version: 0,
              plan: 'free',
              billing_event_updated_at: null,
              created_at: new Date('2026-08-01T00:00:00.000Z'),
              trial_ends_at: new Date('2026-08-01T00:00:00.000Z'),
            }];
            return [];
          },
        }),
      }),
    })) as unknown as typeof db.select);

    mock.method(db, 'insert', ((table: unknown) => ({
      values: async (values: unknown) => {
        createdOffers.push({ table, values });
      },
    })) as unknown as typeof db.insert);

    mock.method(db, 'transaction', (async (callback: (tx: any) => Promise<void>) => {
      const tx = {
        insert: (table: unknown) => ({
          values: (values: unknown) => ({
            onConflictDoNothing: () => ({
              returning: async () => {
                const row = values as { event_key?: string };
                if (row.event_key) {
                  if (seenEvents.has(row.event_key)) return [];
                  seenEvents.add(row.event_key);
                }
                txInserts.push({ table, values });
                return row.event_key ? [{ event_key: row.event_key }] : [];
              },
            }),
          }),
        }),
        update: (table: unknown) => ({
          set: (values: unknown) => ({
            where: async () => {
              if (table === pricing_offers) Object.assign(createdOffers[0].values, values);
              txUpdates.push({ table, values });
            },
          }),
        }),
      };
      await callback(tx);
    }) as unknown as typeof db.transaction);

    const app = Fastify({ logger: false });
    await app.register(billingRoutes);
    await app.ready();
    try {
      const auth = await token();
      const checkout = await app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${auth}` },
        payload: { interval: 'monthly' },
      });
      assert.equal(checkout.statusCode, 200);
      const checkoutBody = checkout.json();
      assert.equal(checkoutBody.provider, 'litos');
      assert.match(checkoutBody.url, /^http:\/\/localhost:8787\/billing\/litos-pay\/checkout\//);
      assert.equal(createdOffers.length, 1);
      assert.equal(createdOffers[0].values.provider_checkout_id, 'cs_test_litos_live_card');
      assert.equal(createdOffers[0].values.provider_checkout_url, 'https://checkout.stripe.com/c/pay/cs_test_litos_live_card');

      const checkoutUrl = new URL(checkoutBody.url);
      const redirect = await app.inject({
        method: 'GET',
        url: `${checkoutUrl.pathname}${checkoutUrl.search}`,
      });
      assert.equal(redirect.statusCode, 303);
      assert.equal(redirect.headers.location, 'https://checkout.stripe.com/c/pay/cs_test_litos_live_card');

      const payload = Buffer.from(JSON.stringify({
        id: 'evt_litos_checkout_completed',
        object: 'event',
        type: 'checkout.session.completed',
        created: 1_786_000_000,
        data: {
          object: {
            id: 'cs_test_litos_live_card',
            object: 'checkout.session',
            status: 'complete',
            payment_status: 'paid',
            client_reference_id: checkoutBody.checkout_intent_id,
            customer: 'cus_live_card',
            customer_email: 'student@example.com',
            subscription: 'sub_live_card',
            metadata: {
              litos_intent_id: checkoutBody.checkout_intent_id,
              user_id: USER_ID,
              interval: 'monthly',
            },
          },
        },
        livemode: true,
      }));
      const signature = stripeWebhookSignature(payload, process.env.STRIPE_WEBHOOK_SECRET!);
      const wrongSessionPayload = Buffer.from(payload.toString('utf8').replace('cs_test_litos_live_card', 'cs_test_wrong_session'));
      const wrongSession = await app.inject({
        method: 'POST',
        url: '/billing/stripe-webhook',
        headers: {
          'stripe-signature': stripeWebhookSignature(wrongSessionPayload, process.env.STRIPE_WEBHOOK_SECRET!),
          'content-type': 'application/json',
        },
        payload: wrongSessionPayload,
      });
      assert.equal(wrongSession.statusCode, 422);
      assert.equal(txInserts.length, 0);
      assert.equal(txUpdates.length, 0);

      const webhook = await app.inject({
        method: 'POST',
        url: '/billing/stripe-webhook',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload,
      });
      assert.equal(webhook.statusCode, 200);
      assert.equal(webhook.json().processed, true);
      assert.equal(createdOffers[0].values.status, 'paid');
      assert.equal(txInserts.length, 1);
      assert.equal(txUpdates.length, 2);
      assert.deepEqual(
        txUpdates.map((entry: any) => entry.values.billing_provider).filter(Boolean),
        ['stripe'],
      );

      const replay = await app.inject({
        method: 'POST',
        url: '/billing/stripe-webhook',
        headers: { 'stripe-signature': signature, 'content-type': 'application/json' },
        payload,
      });
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().processed, false);
      assert.equal(txInserts.length, 1, 'replay must not add another webhook event');
      assert.equal(txUpdates.length, 2, 'replay must not update offer or user state again');

      const subscriptionPayload = Buffer.from(JSON.stringify({
        id: 'evt_litos_subscription_updated',
        object: 'event',
        type: 'customer.subscription.updated',
        created: 1_786_000_100,
        livemode: true,
        data: {
          object: {
            id: 'sub_live_card',
            object: 'subscription',
            customer: 'cus_live_card',
            status: 'active',
            current_period_end: 1_788_592_100,
            cancel_at_period_end: false,
            metadata: { user_id: USER_ID, interval: 'monthly' },
            items: { data: [{ price: { id: 'price_monthly', recurring: { interval: 'month' } } }] },
          },
        },
      }));
      const subscriptionWebhook = await app.inject({
        method: 'POST',
        url: '/billing/stripe-webhook',
        headers: {
          'stripe-signature': stripeWebhookSignature(subscriptionPayload, process.env.STRIPE_WEBHOOK_SECRET!),
          'content-type': 'application/json',
        },
        payload: subscriptionPayload,
      });
      assert.equal(subscriptionWebhook.statusCode, 200);
      assert.equal(subscriptionWebhook.json().processed, true);
      assert.equal(txInserts.length, 2);
      assert.equal(txUpdates.length, 3);
      assert.equal((txUpdates[2] as any).values.billing_status, 'active');
      assert.equal((txUpdates[2] as any).values.billing_variant_id, 'price_monthly');
    } finally {
      await app.close();
    }
  });

  test('returns the authenticated account\'s paid Stripe receipt with its stored amount', async () => {
    const paidAt = new Date('2026-08-14T12:34:00.000Z');
    const renewsAt = new Date('2026-09-14T12:34:00.000Z');
    mock.method(db, 'select', ((fields?: unknown) => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (table === users) return [{
              id: USER_ID,
              email: 'student@example.com',
              is_guest: false,
              guest_expires_at: null,
              session_valid_from: null,
              session_version: 0,
              billing_provider: 'stripe',
              billing_subscription_id: 'sub_paid_monthly',
              billing_renews_at: renewsAt,
            }];
            if (table === pricing_offers && fields) return [{
              interval: 'monthly',
              amountCents: 3_999,
              currency: 'usd',
              paidAt,
              reference: 'cs_live_receipt_123456789012',
            }];
            return [];
          },
        }),
      }),
    })) as unknown as typeof db.select);

    const app = Fastify({ logger: false });
    await app.register(billingRoutes);
    await app.ready();
    try {
      const auth = await token();
      const receipt = await app.inject({
        method: 'GET',
        url: '/billing/receipt',
        headers: { authorization: `Bearer ${auth}` },
      });
      assert.equal(receipt.statusCode, 200);
      assert.deepEqual(receipt.json(), {
        provider: 'stripe',
        plan: 'pro',
        interval: 'monthly',
        amount_cents: 3_999,
        currency: 'USD',
        paid_at: paidAt.toISOString(),
        renews_at: renewsAt.toISOString(),
        reference: '123456789012',
      });
      assert.equal(receipt.headers['cache-control'], 'private, no-store');
    } finally {
      await app.close();
    }
  });
});
