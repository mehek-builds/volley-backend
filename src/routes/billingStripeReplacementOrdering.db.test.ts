import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { SignJWT } from 'jose';
import * as schema from '../db/schema';
import { stripeWebhookSignature } from '../lib/stripeAcquiring';

const WEBHOOK_SECRET = ['whsec', 'test', 'fixture'].join('_');
const socketDir = mkdtempSync(join(tmpdir(), 'litos-billing-replacement-'));
let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let getEntitlementSnapshot: typeof import('../lib/entitlements').getEntitlementSnapshot;
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
let providerSubscriptionUnavailable = true;
let providerCheckoutExpirationUnavailable = false;
let providerCheckoutExpirationCompleted = false;
let providerCheckoutCreationCount = 0;
let blockedCheckoutCreation: {
  sessionId: string;
  started: () => void;
  release: Promise<void>;
} | null = null;
const expiredProviderSessions: string[] = [];
let blockedSubscriptionRead: {
  subscriptionId: string;
  started: () => void;
  release: Promise<void>;
} | null = null;
const completedCheckoutFixtures = new Map<string, {
  offerId: string;
  userId: string;
  subscriptionId: string;
  paymentStatus?: 'paid' | 'no_payment_required' | 'unpaid';
}>();

function providerSubscriptionFixture(subscriptionId: string) {
  const fixtures: Record<string, {
    customerId: string;
    status: string;
    periodEnd: number;
    endedAt?: number;
    cancelAtPeriodEnd?: boolean;
    cancelAt?: number;
    priceId?: string;
  }> = {
    sub_new_paid: { customerId: 'cus_replacement_paid', status: 'active', periodEnd: 1_788_592_100 },
    sub_old_paid: { customerId: 'cus_replacement_paid', status: 'canceled', periodEnd: 1_786_000_200, endedAt: 1_786_000_200 },
    sub_new_failed: { customerId: 'cus_replacement_failed', status: 'past_due', periodEnd: 1_793_876_100 },
    sub_late_canceled: { customerId: 'cus_late_canceled', status: 'canceled', periodEnd: 1_786_300_000, endedAt: 1_786_300_000 },
    sub_provider_unavailable: { customerId: 'cus_provider_unavailable', status: 'active', periodEnd: 1_789_000_000 },
    sub_dispute_scheduled: {
      customerId: 'cus_dispute_scheduled',
      status: 'active',
      periodEnd: 1_789_000_000,
      cancelAtPeriodEnd: true,
      cancelAt: 1_789_000_000,
    },
    sub_checkout_completed: {
      customerId: 'cus_checkout_completed',
      status: 'trialing',
      periodEnd: 1_793_876_100,
      priceId: 'price_month_previous',
    },
    sub_checkout_incomplete: {
      customerId: 'cus_checkout_incomplete',
      status: 'incomplete',
      periodEnd: 1_793_876_100,
      priceId: 'price_month',
    },
    sub_checkout_incomplete_expired: {
      customerId: 'cus_checkout_incomplete_expired',
      status: 'incomplete_expired',
      periodEnd: 1_793_876_100,
      priceId: 'price_month',
    },
    sub_checkout_interleaved: {
      customerId: 'cus_checkout_interleaved',
      status: 'incomplete_expired',
      periodEnd: 1_793_876_100,
      priceId: 'price_month',
    },
    sub_checkout_external_gap: {
      customerId: 'cus_checkout_external_gap',
      status: 'active',
      periodEnd: 1_793_876_100,
      priceId: 'price_month',
    },
    sub_rotated_checkout: {
      customerId: 'cus_rotated_checkout',
      status: 'active',
      periodEnd: 1_793_876_100,
      priceId: 'price_month_previous',
    },
  };
  return fixtures[subscriptionId] ?? null;
}

function subscriptionIdForInvoice(invoiceId: string): string | null {
  if (invoiceId === 'in_evt_replacement_invoice_paid') return 'sub_new_paid';
  if (invoiceId === 'in_evt_replacement_invoice_failed') return 'sub_new_failed';
  if (invoiceId === 'in_evt_late_paid_after_cancel') return 'sub_late_canceled';
  if (invoiceId === 'in_evt_provider_unavailable') return 'sub_provider_unavailable';
  if (invoiceId === 'in_dispute_scheduled') return 'sub_dispute_scheduled';
  return null;
}

async function postStripeEvent(payload: Record<string, unknown>) {
  const raw = Buffer.from(JSON.stringify(payload));
  return app.inject({
    method: 'POST',
    url: '/billing/stripe-webhook',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': stripeWebhookSignature(raw, WEBHOOK_SECRET),
    },
    payload: raw,
  });
}

async function authToken(userId: string) {
  return new SignJWT({ userId, isGuest: false, authMethod: 'password', sessionVersion: 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(process.env.JWT_SIGNING_SECRET!));
}

type CheckoutPlanId = 'litos_plus_week' | 'litos_plus_month' | 'litos_plus_quarter';

async function checkoutTermsRevision(token: string, planId: CheckoutPlanId): Promise<string> {
  const response = await app.inject({
    method: 'GET',
    url: '/billing/plans',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.statusCode, 200, response.body);
  const plan = response.json().plans.find((candidate: { id: string }) => candidate.id === planId);
  assert.equal(plan.checkout_terms.checkout_status, 'available');
  return plan.checkout_terms.revision;
}

function subscriptionPayload(input: {
  eventId: string;
  created: number;
  userId: string;
  customerId: string;
  subscriptionId: string;
  status: 'active' | 'past_due';
  periodEnd: number;
}) {
  return {
    id: input.eventId,
    type: 'customer.subscription.updated',
    created: input.created,
    livemode: false,
    data: { object: {
      id: input.subscriptionId,
      customer: input.customerId,
      status: input.status,
      current_period_start: input.created,
      current_period_end: input.periodEnd,
      cancel_at_period_end: false,
      metadata: { litos_user_id: input.userId, litos_plan_id: 'litos_plus_month' },
      items: { data: [{ price: { id: 'price_month' } }] },
    } },
  };
}

function invoicePayload(input: {
  eventId: string;
  type: 'invoice.paid' | 'invoice.payment_failed';
  created: number;
  customerId: string;
  subscriptionId?: string;
  periodEnd: number;
}) {
  return {
    id: input.eventId,
    type: input.type,
    created: input.created,
    livemode: false,
    data: { object: {
      id: `in_${input.eventId}`,
      customer: input.customerId,
      ...(input.subscriptionId ? { subscription: input.subscriptionId } : {}),
      payment_intent: `pi_${input.eventId}`,
      lines: { data: [{
        price: { id: 'price_month' },
        period: { start: input.created, end: input.periodEnd },
      }] },
    } },
  };
}

test('invoice events without an exact subscription id never mutate a customer-matched row', async () => {
  const cases = [
    { type: 'invoice.paid' as const, suffix: 'paid', initialStatus: 'past_due' },
    { type: 'invoice.payment_failed' as const, suffix: 'failed', initialStatus: 'active' },
  ];
  for (const [index, scenario] of cases.entries()) {
    const userId = index === 0
      ? '7cafcafb-d99d-4fb0-a17f-ed6dcdb9feea'
      : '728428a6-9e3d-489d-8c7f-0c5706195daf';
    const customerId = `cus_invoice_without_subscription_${scenario.suffix}`;
    const subscriptionId = `sub_existing_${scenario.suffix}`;
    await database.exec(`
      insert into "users" ("id", "email", "plan", "billing_customer_id")
      values ('${userId}', 'invoice-${scenario.suffix}@example.test', 'pro', '${customerId}');
      insert into "billing_subscriptions" (
        "user_id", "provider", "provider_customer_id", "provider_subscription_id", "provider_price_id",
        "product_code", "term_code", "status", "latest_invoice_id", "provider_event_created_at", "updated_at"
      ) values (
        '${userId}', 'stripe', '${customerId}', '${subscriptionId}', 'price_month',
        'litos_plus', 'month', '${scenario.initialStatus}', 'in_before_${scenario.suffix}',
        '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
      );
    `);

    const response = await postStripeEvent(invoicePayload({
      eventId: `evt_invoice_without_subscription_${scenario.suffix}`,
      type: scenario.type,
      created: 1_786_200_000 + index,
      customerId,
      periodEnd: 1_788_792_000 + index,
    }));
    assert.equal(response.statusCode, 500, response.body);

    const rows = await database.query<{
      provider_subscription_id: string;
      status: string;
      latest_invoice_id: string | null;
      provider_event_created_at: Date;
    }>(`select "provider_subscription_id", "status", "latest_invoice_id", "provider_event_created_at"
        from "billing_subscriptions" where "user_id" = '${userId}'`);
    assert.equal(rows.rows.length, 1);
    assert.deepEqual({
      provider_subscription_id: rows.rows[0].provider_subscription_id,
      status: rows.rows[0].status,
      latest_invoice_id: rows.rows[0].latest_invoice_id,
      provider_event_created_at: new Date(rows.rows[0].provider_event_created_at).toISOString(),
    }, {
      provider_subscription_id: subscriptionId,
      status: scenario.initialStatus,
      latest_invoice_id: `in_before_${scenario.suffix}`,
      provider_event_created_at: '2026-08-01T00:00:00.000Z',
    });
  }
});

before(async () => {
  database = await PGlite.create();
  const initial = await generateMigration(
    generateDrizzleJson({}),
    generateDrizzleJson(schema as unknown as Record<string, unknown>),
  );
  for (const statement of initial) await database.exec(statement);
  server = new PGLiteSocketServer({
    db: database,
    path: join(socketDir, '.s.PGSQL.5432'),
    maxConnections: 10,
  });
  await server.start();
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost/postgres?host=${socketDir}`;
  process.env.STRIPE_SECRET_KEY = ['sk', 'live', 'test'.repeat(8)].join('_');
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PLUS_WEEKLY_PRICE_ID = 'price_week';
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = 'price_month';
  process.env.STRIPE_PLUS_QUARTERLY_PRICE_ID = 'price_quarter';
  process.env.LITOS_BILLING_ENABLED = 'true';
  process.env.JWT_SIGNING_SECRET = 'replacement-ordering-secret-at-least-32-chars';
  globalThis.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    const id = decodeURIComponent(parsed.pathname.split('/').pop() ?? '');
    if (parsed.pathname.includes('/v1/prices/')) {
      const price = id === 'price_week'
        ? { unitAmount: 1999, interval: 'week', intervalCount: 1 }
        : id === 'price_quarter'
          ? { unitAmount: 8999, interval: 'month', intervalCount: 3 }
          : { unitAmount: 3999, interval: 'month', intervalCount: 1 };
      return new Response(JSON.stringify({
        id,
        active: true,
        currency: 'usd',
        unit_amount: price.unitAmount,
        recurring: { interval: price.interval, interval_count: price.intervalCount },
      }), { status: 200 });
    }
    if (parsed.pathname === '/v1/checkout/sessions') {
      providerCheckoutCreationCount += 1;
      const body = new URLSearchParams(String(init?.body));
      const blocked = blockedCheckoutCreation;
      if (blocked) {
        blocked.started();
        await blocked.release;
      }
      const sessionId = blocked?.sessionId ?? 'cs_recovered_external';
      return new Response(JSON.stringify({
        id: sessionId,
        url: `https://checkout.stripe.com/c/pay/${sessionId}`,
        customer: 'cus_recovered_external',
        subscription: 'sub_recovered_external',
        expires_at: Number(body.get('expires_at')),
      }), { status: 200 });
    }
    if (parsed.pathname.startsWith('/v1/checkout/sessions/') && parsed.pathname.endsWith('/expire')) {
      if (providerCheckoutExpirationUnavailable) return new Response('{}', { status: 503 });
      const parts = parsed.pathname.split('/');
      const sessionId = decodeURIComponent(parts[parts.length - 2] ?? '');
      expiredProviderSessions.push(sessionId);
      return new Response(JSON.stringify({
        id: sessionId,
        object: 'checkout.session',
        status: providerCheckoutExpirationCompleted ? 'complete' : 'expired',
      }), { status: 200 });
    }
    if (parsed.pathname.startsWith('/v1/checkout/sessions/')) {
      const fixture = completedCheckoutFixtures.get(id);
      if (!fixture) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        id,
        object: 'checkout.session',
        status: 'complete',
        payment_status: fixture.paymentStatus ?? 'no_payment_required',
        client_reference_id: fixture.offerId,
        metadata: { litos_user_id: fixture.userId, litos_offer_id: fixture.offerId },
        subscription: fixture.subscriptionId,
      }), { status: 200 });
    }
    if (parsed.pathname.includes('/v1/disputes/')) {
      if (id !== 'dp_dispute_scheduled') return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        id,
        charge: 'ch_dispute_scheduled',
        status: 'won',
      }), { status: 200 });
    }
    if (parsed.pathname.includes('/v1/charges/')) {
      if (id !== 'ch_dispute_scheduled') return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        id,
        customer: 'cus_dispute_scheduled',
        invoice: 'in_dispute_scheduled',
        amount: 3999,
        amount_refunded: 0,
      }), { status: 200 });
    }
    if (parsed.pathname.includes('/v1/invoices/')) {
      const subscriptionId = subscriptionIdForInvoice(id);
      const fixture = subscriptionId ? providerSubscriptionFixture(subscriptionId) : null;
      if (!subscriptionId || !fixture) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        id,
        customer: fixture.customerId,
        status: id.includes('failed') ? 'open' : 'paid',
        parent: { type: 'subscription_details', subscription_details: { subscription: subscriptionId } },
        lines: { data: [{ pricing: { price_details: { price: 'price_month' } } }] },
      }), { status: 200 });
    }
    if (parsed.pathname.includes('/v1/subscriptions/')) {
      if (blockedSubscriptionRead?.subscriptionId === id) {
        blockedSubscriptionRead.started();
        await blockedSubscriptionRead.release;
      }
      if (id === 'sub_provider_unavailable' && providerSubscriptionUnavailable) {
        return new Response('{}', { status: 503 });
      }
      const fixture = providerSubscriptionFixture(id);
      if (!fixture) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        id,
        object: 'subscription',
        customer: fixture.customerId,
        status: fixture.status,
        cancel_at_period_end: fixture.cancelAtPeriodEnd ?? false,
        ...(fixture.cancelAt ? { cancel_at: fixture.cancelAt } : {}),
        ...(fixture.endedAt ? { ended_at: fixture.endedAt } : {}),
        metadata: { litos_product_code: 'litos_plus' },
        items: { data: [{
          quantity: 1,
          price: { id: fixture.priceId ?? 'price_month' },
          current_period_start: 1_786_000_000,
          current_period_end: fixture.periodEnd,
        }] },
      }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };
  ({ pool: backendPool } = await import('../db'));
  ({ getEntitlementSnapshot } = await import('../lib/entitlements'));
  const { billingRoutes } = await import('./billing');
  const { billingV2Routes } = await import('./billingV2');
  app = Fastify({ logger: false });
  await app.register(billingRoutes);
  await app.register(billingV2Routes);
  await app.ready();
});

after(async () => {
  await app?.close();
  await backendPool?.end();
  await server?.stop();
  await database.close();
  rmSync(socketDir, { recursive: true, force: true });
  globalThis.fetch = savedFetch;
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
});

test('a paid replacement invoice creates and mutates only the exact new subscription row', async () => {
  const userId = '6d58c1f5-e885-41f7-a16a-dac37f98ab17';
  const customerId = 'cus_replacement_paid';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "billing_customer_id")
    values ('${userId}', 'replacement-paid@example.test', 'free', '${customerId}');
    insert into "billing_subscriptions" (
      "user_id", "provider", "provider_customer_id", "provider_subscription_id", "provider_price_id",
      "product_code", "term_code", "status", "provider_event_created_at", "updated_at"
    ) values (
      '${userId}', 'stripe', '${customerId}', 'sub_old_paid', 'price_month',
      'litos_plus', 'month', 'canceled', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
  `);

  const invoice = await postStripeEvent(invoicePayload({
    eventId: 'evt_replacement_invoice_paid',
    type: 'invoice.paid',
    created: 1_786_000_000,
    customerId,
    subscriptionId: 'sub_new_paid',
    periodEnd: 1_788_592_000,
  }));
  assert.equal(invoice.statusCode, 200, invoice.body);

  let rows = await database.query<{
    provider_subscription_id: string;
    status: string;
    latest_invoice_id: string | null;
  }>(`select "provider_subscription_id", "status", "latest_invoice_id"
      from "billing_subscriptions" where "user_id" = '${userId}' order by "provider_subscription_id"`);
  assert.deepEqual(rows.rows, [
    { provider_subscription_id: 'sub_new_paid', status: 'active', latest_invoice_id: 'in_evt_replacement_invoice_paid' },
    { provider_subscription_id: 'sub_old_paid', status: 'canceled', latest_invoice_id: null },
  ]);

  const subscription = await postStripeEvent(subscriptionPayload({
    eventId: 'evt_replacement_subscription_paid',
    created: 1_786_000_100,
    userId,
    customerId,
    subscriptionId: 'sub_new_paid',
    status: 'active',
    periodEnd: 1_788_592_100,
  }));
  assert.equal(subscription.statusCode, 200, subscription.body);

  const oldDeletion = await postStripeEvent({
    id: 'evt_old_subscription_deleted_after_replacement',
    type: 'customer.subscription.deleted',
    created: 1_786_000_200,
    livemode: false,
    data: { object: {
      id: 'sub_old_paid',
      customer: customerId,
      status: 'canceled',
      ended_at: 1_786_000_200,
      cancel_at_period_end: false,
      metadata: { litos_user_id: userId, litos_plan_id: 'litos_plus_month' },
      items: { data: [{ price: { id: 'price_month' } }] },
    } },
  });
  assert.equal(oldDeletion.statusCode, 200, oldDeletion.body);
  rows = await database.query(`select "provider_subscription_id", "status", "latest_invoice_id"
    from "billing_subscriptions" where "user_id" = '${userId}' order by "provider_subscription_id"`);
  assert.deepEqual(rows.rows, [
    { provider_subscription_id: 'sub_new_paid', status: 'active', latest_invoice_id: 'in_evt_replacement_invoice_paid' },
    { provider_subscription_id: 'sub_old_paid', status: 'canceled', latest_invoice_id: null },
  ]);
  const account = await database.query<{ plan: string; billing_subscription_id: string }>(`
    select "plan", "billing_subscription_id" from "users" where "id" = '${userId}'
  `);
  assert.deepEqual(account.rows[0], { plan: 'pro', billing_subscription_id: 'sub_new_paid' });
  const entitlement = await getEntitlementSnapshot(userId, new Date('2026-08-14T12:00:00.000Z'));
  assert.equal(entitlement.access_class, 'plus_paid');
  assert.equal(entitlement.subscription?.status, 'active');
});

test('a failed replacement invoice anchors grace on failure and never mutates the prior row', async () => {
  const userId = '9610648e-7750-4931-9a74-8aef5ebf00c0';
  const customerId = 'cus_replacement_failed';
  const failureCreated = 1_786_100_000;
  await database.exec(`
    insert into "users" ("id", "email", "plan", "billing_customer_id")
    values ('${userId}', 'replacement-failed@example.test', 'free', '${customerId}');
    insert into "billing_subscriptions" (
      "user_id", "provider", "provider_customer_id", "provider_subscription_id", "provider_price_id",
      "product_code", "term_code", "status", "access_ends_at", "provider_event_created_at", "updated_at"
    ) values (
      '${userId}', 'stripe', '${customerId}', 'sub_old_failed', 'price_month',
      'litos_plus', 'month', 'unpaid', '2026-08-01T00:00:00.000Z',
      '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
  `);

  const invoice = await postStripeEvent(invoicePayload({
    eventId: 'evt_replacement_invoice_failed',
    type: 'invoice.payment_failed',
    created: failureCreated,
    customerId,
    subscriptionId: 'sub_new_failed',
    periodEnd: failureCreated + 90 * 86_400,
  }));
  assert.equal(invoice.statusCode, 200, invoice.body);

  const subscription = await postStripeEvent(subscriptionPayload({
    eventId: 'evt_replacement_subscription_failed',
    created: failureCreated + 100,
    userId,
    customerId,
    subscriptionId: 'sub_new_failed',
    status: 'past_due',
    periodEnd: failureCreated + 90 * 86_400 + 100,
  }));
  assert.equal(subscription.statusCode, 200, subscription.body);

  const rows = await database.query<{
    provider_subscription_id: string;
    status: string;
    latest_invoice_id: string | null;
    access_ends_at: Date | null;
  }>(`select "provider_subscription_id", "status", "latest_invoice_id", "access_ends_at"
      from "billing_subscriptions" where "user_id" = '${userId}' order by "provider_subscription_id"`);
  assert.equal(rows.rows.length, 2);
  assert.deepEqual({
    provider_subscription_id: rows.rows[0].provider_subscription_id,
    status: rows.rows[0].status,
    latest_invoice_id: rows.rows[0].latest_invoice_id,
    access_ends_at: new Date(rows.rows[0].access_ends_at!).toISOString(),
  }, {
    provider_subscription_id: 'sub_new_failed',
    status: 'past_due',
    latest_invoice_id: 'in_evt_replacement_invoice_failed',
    access_ends_at: new Date(failureCreated * 1000).toISOString(),
  });
  assert.deepEqual({
    provider_subscription_id: rows.rows[1].provider_subscription_id,
    status: rows.rows[1].status,
    latest_invoice_id: rows.rows[1].latest_invoice_id,
    access_ends_at: new Date(rows.rows[1].access_ends_at!).toISOString(),
  }, {
    provider_subscription_id: 'sub_old_failed',
    status: 'unpaid',
    latest_invoice_id: null,
    access_ends_at: '2026-08-01T00:00:00.000Z',
  });
});

test('a late paid invoice cannot reactivate a provider-canceled subscription', async () => {
  const userId = 'f1fd1399-3221-439a-88a8-5fb2bfd69b10';
  const customerId = 'cus_late_canceled';
  await database.exec(`
    insert into "users" (
      "id", "email", "plan", "billing_provider", "billing_customer_id", "billing_subscription_id", "billing_status"
    ) values (
      '${userId}', 'late-canceled@example.test', 'pro', 'stripe', '${customerId}', 'sub_late_canceled', 'active'
    );
    insert into "billing_subscriptions" (
      "user_id", "provider", "provider_customer_id", "provider_subscription_id", "provider_price_id",
      "product_code", "term_code", "status", "provider_event_created_at", "updated_at"
    ) values (
      '${userId}', 'stripe', '${customerId}', 'sub_late_canceled', 'price_month',
      'litos_plus', 'month', 'active', '2026-08-14T06:00:00.000Z', '2026-08-14T06:00:00.000Z'
    );
  `);

  const response = await postStripeEvent(invoicePayload({
    eventId: 'evt_late_paid_after_cancel',
    type: 'invoice.paid',
    created: 1_786_200_000,
    customerId,
    subscriptionId: 'sub_late_canceled',
    periodEnd: 1_788_792_000,
  }));
  assert.equal(response.statusCode, 200, response.body);

  const subscription = await database.query<{ status: string; ended_at: Date | null }>(`
    select "status", "ended_at" from "billing_subscriptions"
    where "provider_subscription_id" = 'sub_late_canceled'
  `);
  assert.equal(subscription.rows[0].status, 'canceled');
  assert.equal(new Date(subscription.rows[0].ended_at!).toISOString(), new Date(1_786_300_000_000).toISOString());
  const account = await database.query<{ plan: string; billing_status: string }>(`
    select "plan", "billing_status" from "users" where "id" = '${userId}'
  `);
  assert.deepEqual(account.rows[0], { plan: 'free', billing_status: 'canceled' });
});

test('provider retrieval failure leaves subscription and account access unchanged', async () => {
  const userId = '6e2f3129-b8e2-40db-893d-a34650a60fb8';
  const customerId = 'cus_provider_unavailable';
  await database.exec(`
    insert into "users" (
      "id", "email", "plan", "billing_provider", "billing_customer_id", "billing_subscription_id", "billing_status"
    ) values (
      '${userId}', 'provider-unavailable@example.test', 'pro', 'stripe', '${customerId}',
      'sub_provider_unavailable', 'active'
    );
    insert into "billing_subscriptions" (
      "user_id", "provider", "provider_customer_id", "provider_subscription_id", "provider_price_id",
      "product_code", "term_code", "status", "latest_invoice_id", "provider_event_created_at", "updated_at"
    ) values (
      '${userId}', 'stripe', '${customerId}', 'sub_provider_unavailable', 'price_month',
      'litos_plus', 'month', 'active', 'in_before_unavailable',
      '2026-08-14T06:00:00.000Z', '2026-08-14T06:00:00.000Z'
    );
  `);

  const response = await postStripeEvent(invoicePayload({
    eventId: 'evt_provider_unavailable',
    type: 'invoice.payment_failed',
    created: 1_786_400_000,
    customerId,
    subscriptionId: 'sub_provider_unavailable',
    periodEnd: 1_789_000_000,
  }));
  assert.equal(response.statusCode, 500, response.body);

  const subscription = await database.query<{ status: string; latest_invoice_id: string }>(`
    select "status", "latest_invoice_id" from "billing_subscriptions"
    where "provider_subscription_id" = 'sub_provider_unavailable'
  `);
  assert.deepEqual(subscription.rows[0], { status: 'active', latest_invoice_id: 'in_before_unavailable' });
  const account = await database.query<{ plan: string; billing_status: string }>(`
    select "plan", "billing_status" from "users" where "id" = '${userId}'
  `);
  assert.deepEqual(account.rows[0], { plan: 'pro', billing_status: 'active' });

  const failedLedger = await database.query<{ result: string; processing_attempts: number }>(`
    select "result", "processing_attempts" from "billing_webhook_events"
    where "event_key" = 'stripe:evt_provider_unavailable'
  `);
  assert.deepEqual(failedLedger.rows[0], { result: 'failed', processing_attempts: 1 });

  providerSubscriptionUnavailable = false;
  const retried = await postStripeEvent(invoicePayload({
    eventId: 'evt_provider_unavailable',
    type: 'invoice.payment_failed',
    created: 1_786_400_000,
    customerId,
    subscriptionId: 'sub_provider_unavailable',
    periodEnd: 1_789_000_000,
  }));
  assert.equal(retried.statusCode, 200, retried.body);
  const processedLedger = await database.query<{ result: string; processing_attempts: number }>(`
    select "result", "processing_attempts" from "billing_webhook_events"
    where "event_key" = 'stripe:evt_provider_unavailable'
  `);
  assert.deepEqual(processedLedger.rows[0], { result: 'processed', processing_attempts: 2 });
});

test('a won dispute restores the provider scheduled-cancel boundary instead of indefinite access', async () => {
  const userId = '80e4ba50-b061-4e24-a003-64ed46dc44c8';
  const customerId = 'cus_dispute_scheduled';
  const periodEnd = 1_789_000_000;
  await database.exec(`
    insert into "users" (
      "id", "email", "plan", "billing_provider", "billing_customer_id", "billing_subscription_id", "billing_status"
    ) values (
      '${userId}', 'dispute-scheduled@example.test', 'free', 'stripe', '${customerId}',
      'sub_dispute_scheduled', 'disputed'
    );
    insert into "billing_subscriptions" (
      "user_id", "provider", "provider_customer_id", "provider_subscription_id", "provider_price_id",
      "product_code", "term_code", "status", "cancel_at_period_end", "current_period_end",
      "access_ends_at", "dispute_previous_status", "provider_event_created_at", "updated_at"
    ) values (
      '${userId}', 'stripe', '${customerId}', 'sub_dispute_scheduled', 'price_month',
      'litos_plus', 'month', 'disputed', false, '2026-08-20T00:00:00.000Z',
      '2026-08-10T22:13:20.000Z', 'active', '2026-08-10T22:13:20.000Z', '2026-08-10T22:13:20.000Z'
    );
  `);

  const response = await postStripeEvent({
    id: 'evt_dispute_scheduled_won',
    type: 'charge.dispute.closed',
    created: 1_786_400_100,
    livemode: false,
    data: { object: {
      id: 'dp_dispute_scheduled',
      charge: 'ch_dispute_scheduled',
      status: 'won',
    } },
  });
  assert.equal(response.statusCode, 200, response.body);

  const subscription = await database.query<{
    status: string;
    cancel_at_period_end: boolean;
    current_period_end: Date | null;
    access_ends_at: Date | null;
  }>(`
    select "status", "cancel_at_period_end", "current_period_end", "access_ends_at"
    from "billing_subscriptions" where "provider_subscription_id" = 'sub_dispute_scheduled'
  `);
  assert.deepEqual({
    status: subscription.rows[0].status,
    cancel_at_period_end: subscription.rows[0].cancel_at_period_end,
    current_period_end: new Date(subscription.rows[0].current_period_end!).toISOString(),
    access_ends_at: new Date(subscription.rows[0].access_ends_at!).toISOString(),
  }, {
    status: 'active',
    cancel_at_period_end: true,
    current_period_end: new Date(periodEnd * 1000).toISOString(),
    access_ends_at: new Date(periodEnd * 1000).toISOString(),
  });
  const beforeEnd = await getEntitlementSnapshot(userId, new Date(periodEnd * 1000 - 1));
  const atEnd = await getEntitlementSnapshot(userId, new Date(periodEnd * 1000));
  assert.equal(beforeEnd.access_class, 'plus_paid');
  assert.equal(atEnd.access_class, 'free_new');
});

test('catalog checkout accepts a missing rollout revision but rejects a supplied stale revision', async () => {
  const userId = 'a1bc08b1-c487-499a-a453-21906a6426a3';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'checkout-terms@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
  `);
  const token = await authToken(userId);
  const currentRevision = await checkoutTermsRevision(token, 'litos_plus_month');
  const legacyIdempotencyKey = '25988f92-d117-40c3-98c7-44037d56e41c';
  const legacyResponse = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': legacyIdempotencyKey,
    },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'website',
      placement: 'onboarding',
      trigger: 'start_plan',
    },
  });
  assert.equal(legacyResponse.statusCode, 200, legacyResponse.body);
  assert.equal(legacyResponse.json().checkout_terms.revision, currentRevision);

  const exactResponse = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': legacyIdempotencyKey,
    },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'website',
      placement: 'onboarding',
      trigger: 'start_plan',
      checkout_terms_revision: currentRevision,
    },
  });
  assert.equal(exactResponse.statusCode, 200, exactResponse.body);
  assert.equal(exactResponse.json().checkout_terms.revision, currentRevision);

  const previousStrictSetting = process.env.LITOS_CHECKOUT_TERMS_REVISION_REQUIRED;
  process.env.LITOS_CHECKOUT_TERMS_REVISION_REQUIRED = 'true';
  const strictResponse = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': '1a967250-e843-4821-8a2b-39c5c96731c8',
      },
      payload: {
        plan_id: 'litos_plus_month',
        surface: 'website',
        placement: 'onboarding',
        trigger: 'start_plan',
      },
    }).finally(() => {
    if (previousStrictSetting === undefined) delete process.env.LITOS_CHECKOUT_TERMS_REVISION_REQUIRED;
    else process.env.LITOS_CHECKOUT_TERMS_REVISION_REQUIRED = previousStrictSetting;
    });
  assert.equal(strictResponse.statusCode, 409, strictResponse.body);
  assert.equal(strictResponse.json().code, 'checkout_terms_revision_required');

  for (const [label, payload] of [
    ['dashboard', {
      plan_id: 'litos_plus_month',
      surface: 'dashboard',
      placement: 'resume_limit',
      trigger: 'resume_limit',
    }],
    ['public pricing', {
      plan_id: 'litos_plus_month',
      surface: 'website',
      placement: 'public_pricing',
      trigger: 'pricing_plan',
    }],
  ] as const) {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': label === 'dashboard'
          ? '09f26943-2208-4b98-b7e4-9ed2875eae70'
          : '8aab9f9c-33fc-4971-93bb-67c3442f134c',
      },
      payload,
    });
    assert.equal(response.statusCode, 409, `${label}: ${response.body}`);
    assert.equal(response.json().code, 'checkout_terms_revision_required');
  }

  const staleResponse = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': '6ea6d272-a54c-4089-bbc9-4255f2985d54',
    },
    payload: {
      plan_id: 'litos_plus_month',
      checkout_terms_revision: 'checkout_terms_v1_stale_revision_value',
    },
  });
  assert.equal(staleResponse.statusCode, 409, staleResponse.body);
  assert.equal(staleResponse.json().code, 'checkout_terms_changed');
  assert.equal(staleResponse.json().checkout_terms.revision, currentRevision);

  const intervalWithRevision = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': '4f7d354b-ac3e-480e-9f28-e71a73b0dd56',
    },
    payload: {
      interval: 'weekly',
      checkout_terms_revision: 'checkout_terms_v1_stale_revision_value',
    },
  });
  assert.equal(intervalWithRevision.statusCode, 409, intervalWithRevision.body);
  assert.equal(intervalWithRevision.json().code, 'checkout_terms_changed');

  const creationCountBeforeLegacyInterval = providerCheckoutCreationCount;
  const intervalWithoutRevision = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'a8e7de1e-282b-4140-81db-49a1d4661f83',
    },
    payload: { interval: 'monthly' },
  });
  assert.equal(intervalWithoutRevision.statusCode, 409, intervalWithoutRevision.body);
  assert.equal(intervalWithoutRevision.json().code, 'checkout_terms_revision_required');
  assert.equal(providerCheckoutCreationCount, creationCountBeforeLegacyInterval);

  const offers = await database.query<{ count: string; policy_version: string }>(`
    select count(*)::text as "count", max("policy_version") as "policy_version"
    from "pricing_offers" where "user_id" = '${userId}'
  `);
  assert.equal(offers.rows[0].count, '1');
  assert.equal(offers.rows[0].policy_version, `litos-entitlements-v2:${currentRevision}`);

  await database.exec(`
    update "users" set "trial_started_at" = '2026-08-01T00:00:00.000Z' where "id" = '${userId}'
  `);
  const unsafeLegacyResponse = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': '850c873b-a535-4343-936c-d4fb5f0f4c71',
    },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'website',
      placement: 'onboarding',
      trigger: 'start_plan',
    },
  });
  assert.equal(unsafeLegacyResponse.statusCode, 409, unsafeLegacyResponse.body);
  assert.equal(unsafeLegacyResponse.json().code, 'checkout_terms_revision_required');
  assert.equal(unsafeLegacyResponse.json().checkout_terms.trial_eligible, false);
});

test('idempotent checkout replay repairs the action link after the persistence crash window', async () => {
  const userId = '0565cc78-12ef-45f1-a00e-ab272e6fc390';
  const actionId = 'da35bd0f-ecaf-4b43-bef3-771f76c7fe8c';
  const offerId = 'a845617d-41f4-43e5-a042-45e4c034766f';
  const idempotencyKey = 'dc3f3e12-46a5-4f05-a6dc-d86d6a4819e1';
  const actionNonce = 'checkout-crash-window-action-nonce';
  const nonceHash = createHash('sha256').update(actionNonce).digest('hex');
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'checkout-repair@example.test', 'free', '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pending_premium_actions" (
      "id", "nonce_hash", "user_id", "feature_key", "return_route", "context_hash",
      "idempotency_key", "state", "offer_id", "expires_at"
    ) values (
      '${actionId}', '${nonceHash}', '${userId}', 'ai_resume_tailoring', '/dashboard/applications',
      'checkout-repair-context', 'checkout-repair-operation', 'pending', null, '2099-01-01T00:00:00.000Z'
    );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "provider_checkout_id", "provider_checkout_url", "expires_at", "product_code", "term_code",
      "provider_price_id", "surface", "trigger", "client_idempotency_key", "pending_action_id"
    ) values (
      '${offerId}', '${userId}', 'checkout-repair@example.test', 'v2:${idempotencyKey}',
      'litos-entitlements-v2', 'US', 'standard', 'control', 'quarter', 'USD', 8999, 8999,
      'checkout_created', 'cs_checkout_repair', 'https://checkout.stripe.com/c/pay/cs_checkout_repair',
      '2099-01-01T00:00:00.000Z', 'litos_plus', 'quarter', 'price_quarter', 'dashboard',
      'account_upgrade', '${idempotencyKey}', '${actionId}'
    );
  `);

  const token = await authToken(userId);
  const checkoutTerms = await checkoutTermsRevision(token, 'litos_plus_quarter');
  await database.exec(`
    update "pricing_offers"
    set "policy_version" = 'litos-entitlements-v2:${checkoutTerms}'
    where "id" = '${offerId}'
  `);
  const response = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_quarter',
      surface: 'dashboard',
      trigger: 'account_upgrade',
      action_nonce: actionNonce,
      checkout_terms_revision: checkoutTerms,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().offer_id, offerId);
  assert.equal(response.json().checkout_session_id, 'cs_checkout_repair');
  const action = await database.query<{ offer_id: string | null }>(`
    select "offer_id" from "pending_premium_actions" where "id" = '${actionId}'
  `);
  assert.equal(action.rows[0].offer_id, offerId);

  /* A replay can only return the existing Stripe URL while its stored policy still binds the
     exact preview accepted above. The local lock remains until Stripe confirms expiration. */
  await database.exec(`
    update "pricing_offers" set "policy_version" = 'litos-entitlements-v2:stale' where "id" = '${offerId}'
  `);
  providerCheckoutExpirationUnavailable = true;
  const blockedReplay = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_quarter',
      surface: 'dashboard',
      trigger: 'account_upgrade',
      action_nonce: actionNonce,
      checkout_terms_revision: checkoutTerms,
    },
  });
  providerCheckoutExpirationUnavailable = false;
  assert.equal(blockedReplay.statusCode, 409, blockedReplay.body);
  assert.equal(blockedReplay.json().code, 'checkout_in_progress');
  const lockedOffer = await database.query<{ status: string }>(`
    select "status" from "pricing_offers" where "id" = '${offerId}'
  `);
  assert.equal(lockedOffer.rows[0].status, 'checkout_created');

  const staleReplay = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_quarter',
      surface: 'dashboard',
      trigger: 'account_upgrade',
      action_nonce: actionNonce,
      checkout_terms_revision: checkoutTerms,
    },
  });
  assert.equal(staleReplay.statusCode, 409, staleReplay.body);
  assert.equal(staleReplay.json().code, 'checkout_terms_changed');
  const staleOffer = await database.query<{ status: string }>(`
    select "status" from "pricing_offers" where "id" = '${offerId}'
  `);
  assert.equal(staleOffer.rows[0].status, 'expired');

  const freshIdempotencyKey = '03d58f94-f4d3-401a-9844-3df159f05bbd';
  const freshResponse = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': freshIdempotencyKey },
    payload: {
      plan_id: 'litos_plus_quarter',
      surface: 'dashboard',
      trigger: 'account_upgrade',
      action_nonce: actionNonce,
      checkout_terms_revision: checkoutTerms,
    },
  });
  assert.equal(freshResponse.statusCode, 200, freshResponse.body);
  assert.notEqual(freshResponse.json().offer_id, offerId);
  const offers = await database.query<{ status: string }>(`
    select "status" from "pricing_offers" where "user_id" = '${userId}' order by "created_at"
  `);
  assert.deepEqual(offers.rows.map((row) => row.status).sort(), ['checkout_created', 'expired']);
});

test('idempotent checkout retry recovers a Stripe session created before local persistence', async () => {
  const userId = 'bb607a06-4dfa-48b9-8624-b9123c423cb3';
  const actionId = '5a2a8fd5-61c7-47df-8dbd-67aaad994082';
  const offerId = '7ed8b477-3b49-4159-9ef1-b1b60946a6c5';
  const idempotencyKey = '1f0735cb-08de-49f4-95ce-fb7f7314b56e';
  const actionNonce = 'checkout-external-session-crash-nonce';
  const nonceHash = createHash('sha256').update(actionNonce).digest('hex');
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'checkout-session-repair@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pending_premium_actions" (
      "id", "nonce_hash", "user_id", "feature_key", "return_route", "context_hash",
      "idempotency_key", "state", "offer_id", "expires_at"
    ) values (
      '${actionId}', '${nonceHash}', '${userId}', 'ai_resume_tailoring', '/dashboard/applications',
      'checkout-session-repair-context', 'checkout-session-repair-operation', 'pending', null,
      '2099-01-01T00:00:00.000Z'
    );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "expires_at", "product_code", "term_code", "provider_price_id", "surface", "trigger",
      "client_idempotency_key", "pending_action_id"
    ) values (
      '${offerId}', '${userId}', 'checkout-session-repair@example.test', 'v2:${idempotencyKey}',
      'litos-entitlements-v2', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
      'creating', now() + interval '15 minutes', 'litos_plus', 'month', 'price_month', 'extension',
      'resume_limit', '${idempotencyKey}', '${actionId}'
    );
  `);

  const token = await authToken(userId);
  const checkoutTerms = await checkoutTermsRevision(token, 'litos_plus_month');
  await database.exec(`
    update "pricing_offers"
    set "policy_version" = 'litos-entitlements-v2:${checkoutTerms}'
    where "id" = '${offerId}'
  `);
  const response = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'extension',
      trigger: 'resume_limit',
      action_nonce: actionNonce,
      checkout_terms_revision: checkoutTerms,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().offer_id, offerId);
  assert.equal(response.json().checkout_session_id, 'cs_recovered_external');
  const offer = await database.query<{
    status: string;
    provider_checkout_id: string | null;
    provider_subscription_id: string | null;
  }>(`
    select "status", "provider_checkout_id", "provider_subscription_id"
    from "pricing_offers" where "id" = '${offerId}'
  `);
  assert.deepEqual(offer.rows[0], {
    status: 'checkout_created',
    provider_checkout_id: 'cs_recovered_external',
    provider_subscription_id: 'sub_recovered_external',
  });
  const action = await database.query<{ offer_id: string | null }>(`
    select "offer_id" from "pending_premium_actions" where "id" = '${actionId}'
  `);
  assert.equal(action.rows[0].offer_id, offerId);
});

test('a stale creating offer never replays Stripe with current commercial inputs', async () => {
  const userId = '2bcce512-a295-40be-8215-e97518119b10';
  const offerId = 'd7bc2da8-d142-43bf-b7b9-5813607e1c76';
  const idempotencyKey = '2a830f2e-f4c2-494c-a4f7-14a9b70c3c33';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'stale-creating@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "expires_at", "product_code", "term_code", "provider_price_id", "surface", "trigger",
      "client_idempotency_key"
    ) values (
      '${offerId}', '${userId}', 'stale-creating@example.test', 'v2:${idempotencyKey}',
      'litos-entitlements-v2:stale', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
      'creating', now() + interval '15 minutes', 'litos_plus', 'month', 'price_month', 'dashboard',
      'account_upgrade', '${idempotencyKey}'
    );
  `);
  const token = await authToken(userId);
  const monthTerms = await checkoutTermsRevision(token, 'litos_plus_month');
  const creationCount = providerCheckoutCreationCount;

  const staleRetry = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'dashboard',
      trigger: 'account_upgrade',
      checkout_terms_revision: monthTerms,
    },
  });
  assert.equal(staleRetry.statusCode, 409, staleRetry.body);
  assert.equal(staleRetry.json().code, 'checkout_in_progress');

  const quarterTerms = await checkoutTermsRevision(token, 'litos_plus_quarter');
  const reusedKey = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_quarter',
      surface: 'dashboard',
      trigger: 'account_upgrade',
      checkout_terms_revision: quarterTerms,
    },
  });
  assert.equal(reusedKey.statusCode, 409, reusedKey.body);
  assert.equal(reusedKey.json().code, 'idempotency_conflict');

  const differentRequest = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': 'f033d70f-de4e-47f7-a5bd-b167a1204e08',
    },
    payload: {
      plan_id: 'litos_plus_quarter',
      surface: 'dashboard',
      trigger: 'account_upgrade',
      checkout_terms_revision: quarterTerms,
    },
  });
  assert.equal(differentRequest.statusCode, 409, differentRequest.body);
  assert.equal(differentRequest.json().code, 'checkout_in_progress');
  assert.equal(providerCheckoutCreationCount, creationCount);

  const offer = await database.query<{ status: string; provider_checkout_id: string | null }>(`
    select "status", "provider_checkout_id" from "pricing_offers" where "id" = '${offerId}'
  `);
  assert.deepEqual(offer.rows[0], { status: 'creating', provider_checkout_id: null });
});

test('a completed provider Session is reconciled before an expired local lock can be released', async () => {
  const userId = 'e2b91d9a-a7a4-4746-afc4-168454776b0c';
  const offerId = '0a619542-8e4a-49a8-af10-03ed35886183';
  const sessionId = 'cs_completed_before_expiry';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'completed-checkout@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "provider_checkout_id", "provider_checkout_url", "expires_at", "product_code", "term_code",
      "provider_price_id", "surface", "trigger", "client_idempotency_key"
    ) values (
      '${offerId}', '${userId}', 'completed-checkout@example.test', 'v2:completed-before-expiry',
      'litos-entitlements-v2:historical', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
      'checkout_created', '${sessionId}', 'https://checkout.stripe.com/c/pay/${sessionId}',
      '2026-08-01T00:00:00.000Z', 'litos_plus', 'month', 'price_month_previous', 'website',
      'start_plan', 'completed-before-expiry'
    );
  `);
  const token = await authToken(userId);
  const currentRevision = await checkoutTermsRevision(token, 'litos_plus_month');
  const creationCount = providerCheckoutCreationCount;
  completedCheckoutFixtures.set(sessionId, {
    offerId,
    userId,
    subscriptionId: 'sub_checkout_completed',
  });
  providerCheckoutExpirationCompleted = true;
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': '9856196e-b0cf-4350-a027-242b239e5271',
      },
      payload: {
        plan_id: 'litos_plus_month',
        surface: 'website',
        placement: 'onboarding',
        trigger: 'start_plan',
        checkout_terms_revision: currentRevision,
      },
    });
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'already_plus');
  } finally {
    providerCheckoutExpirationCompleted = false;
    completedCheckoutFixtures.delete(sessionId);
  }

  const [offer, user, subscription, entitlement] = await Promise.all([
    database.query<{ status: string; provider_subscription_id: string | null }>(`
      select "status", "provider_subscription_id" from "pricing_offers" where "id" = '${offerId}'
    `),
    database.query<{ plan: string; billing_subscription_id: string | null }>(`
      select "plan", "billing_subscription_id" from "users" where "id" = '${userId}'
    `),
    database.query<{ provider_price_id: string; term_code: string; status: string }>(`
      select "provider_price_id", "term_code", "status" from "billing_subscriptions"
      where "provider_subscription_id" = 'sub_checkout_completed'
    `),
    getEntitlementSnapshot(userId),
  ]);
  assert.deepEqual(offer.rows[0], {
    status: 'paid',
    provider_subscription_id: 'sub_checkout_completed',
  });
  assert.equal(user.rows[0].plan, 'pro');
  assert.equal(user.rows[0].billing_subscription_id, 'sub_checkout_completed');
  assert.deepEqual(subscription.rows[0], {
    provider_price_id: 'price_month_previous',
    term_code: 'month',
    status: 'trialing',
  });
  assert.equal(entitlement.access_class, 'trial_plus');
  assert.equal(providerCheckoutCreationCount, creationCount);
});

test('a completed unpaid recoverable subscription keeps the sole-live lock and routes to Portal', async () => {
  const userId = '87bca68a-38b3-4b5a-b9d7-9d44dce075f0';
  const offerId = 'ef967db9-e009-4a63-9812-c1d5a0ec4970';
  const sessionId = 'cs_completed_unpaid_incomplete';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'recoverable-checkout@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "provider_checkout_id", "provider_checkout_url", "expires_at", "product_code", "term_code",
      "provider_price_id", "surface", "trigger", "client_idempotency_key"
    ) values (
      '${offerId}', '${userId}', 'recoverable-checkout@example.test', 'v2:recoverable-checkout',
      'litos-entitlements-v2:historical', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
      'checkout_created', '${sessionId}', 'https://checkout.stripe.com/c/pay/${sessionId}',
      '2026-08-01T00:00:00.000Z', 'litos_plus', 'month', 'price_month', 'website',
      'start_plan', 'recoverable-checkout'
    );
  `);
  const token = await authToken(userId);
  const currentRevision = await checkoutTermsRevision(token, 'litos_plus_month');
  const creationCount = providerCheckoutCreationCount;
  completedCheckoutFixtures.set(sessionId, {
    offerId,
    userId,
    subscriptionId: 'sub_checkout_incomplete',
    paymentStatus: 'unpaid',
  });
  providerCheckoutExpirationCompleted = true;
  let response;
  try {
    response = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': '8aef7dda-74c5-4aae-a4c8-6be62e919b7e',
      },
      payload: {
        plan_id: 'litos_plus_month',
        surface: 'website',
        placement: 'onboarding',
        trigger: 'start_plan',
        checkout_terms_revision: currentRevision,
      },
    });
  } finally {
    providerCheckoutExpirationCompleted = false;
    completedCheckoutFixtures.delete(sessionId);
  }
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'billing_recovery_required');
  assert.equal(response.json().portal_url, '/billing/portal');
  assert.equal(providerCheckoutCreationCount, creationCount);

  const [offer, subscription, user] = await Promise.all([
    database.query<{ status: string }>(`select "status" from "pricing_offers" where "id" = '${offerId}'`),
    database.query<{ status: string }>(`
      select "status" from "billing_subscriptions"
      where "provider_subscription_id" = 'sub_checkout_incomplete'
    `),
    database.query<{ plan: string; billing_status: string | null }>(`
      select "plan", "billing_status" from "users" where "id" = '${userId}'
    `),
  ]);
  assert.equal(offer.rows[0].status, 'checkout_created');
  assert.equal(subscription.rows[0].status, 'incomplete');
  assert.deepEqual(user.rows[0], { plan: 'free', billing_status: 'incomplete' });
});

test('a completed unpaid terminal subscription requires fresh terms before a replacement checkout', async () => {
  const userId = '7985975a-2648-4d9d-9b07-02f81b1f1399';
  const offerId = '54019651-a768-46af-b902-d5689b4c52d7';
  const sessionId = 'cs_completed_unpaid_terminal';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'terminal-checkout@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "provider_checkout_id", "provider_checkout_url", "expires_at", "product_code", "term_code",
      "provider_price_id", "surface", "trigger", "client_idempotency_key"
    ) values (
      '${offerId}', '${userId}', 'terminal-checkout@example.test', 'v2:terminal-checkout',
      'litos-entitlements-v2:historical', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
      'checkout_created', '${sessionId}', 'https://checkout.stripe.com/c/pay/${sessionId}',
      '2026-08-01T00:00:00.000Z', 'litos_plus', 'month', 'price_month', 'website',
      'start_plan', 'terminal-checkout'
    );
  `);
  const token = await authToken(userId);
  const currentRevision = await checkoutTermsRevision(token, 'litos_plus_month');
  const creationCount = providerCheckoutCreationCount;
  completedCheckoutFixtures.set(sessionId, {
    offerId,
    userId,
    subscriptionId: 'sub_checkout_incomplete_expired',
    paymentStatus: 'unpaid',
  });
  providerCheckoutExpirationCompleted = true;
  let response;
  try {
    response = await app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': '81a24823-188a-4c69-9252-a0fa5eaa67d7',
      },
      payload: {
        plan_id: 'litos_plus_month',
        surface: 'website',
        placement: 'onboarding',
        trigger: 'start_plan',
        checkout_terms_revision: currentRevision,
      },
    });
  } finally {
    providerCheckoutExpirationCompleted = false;
    completedCheckoutFixtures.delete(sessionId);
  }
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().code, 'checkout_terms_changed');
  assert.equal(providerCheckoutCreationCount, creationCount);

  const [oldOffer, subscription, liveOffers] = await Promise.all([
    database.query<{ status: string; paid_at: Date | null }>(`
      select "status", "paid_at" from "pricing_offers" where "id" = '${offerId}'
    `),
    database.query<{ status: string }>(`
      select "status" from "billing_subscriptions"
      where "provider_subscription_id" = 'sub_checkout_incomplete_expired'
    `),
    database.query<{ count: string }>(`
      select count(*)::text as "count" from "pricing_offers"
      where "user_id" = '${userId}' and "status" in ('creating', 'checkout_created')
    `),
  ]);
  assert.deepEqual(oldOffer.rows[0], { status: 'failed', paid_at: null });
  assert.equal(subscription.rows[0].status, 'incomplete_expired');
  assert.equal(liveOffers.rows[0].count, '0');

  const refreshedRevision = await checkoutTermsRevision(token, 'litos_plus_month');
  assert.notEqual(refreshedRevision, currentRevision);
  const replacement = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': '9b01bef8-f2eb-4f5e-aef0-e4f2a5267d76',
    },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'website',
      placement: 'onboarding',
      trigger: 'start_plan',
      checkout_terms_revision: refreshedRevision,
    },
  });
  assert.equal(replacement.statusCode, 200, replacement.body);
  assert.equal(replacement.json().checkout_terms.trial_eligible, false);
  assert.equal(providerCheckoutCreationCount, creationCount + 1);
});

test('checkout cannot reserve stale trial terms while reconciliation changes the account', async () => {
  const userId = '804de13f-41cc-4e61-b4df-f2e126551f90';
  const offerId = '2ce9bdeb-81aa-425c-8e0a-ec22cae54420';
  const sessionId = 'cs_checkout_interleaved';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'interleaved-checkout@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "provider_checkout_id", "provider_checkout_url", "expires_at", "product_code", "term_code",
      "provider_price_id", "surface", "trigger", "client_idempotency_key"
    ) values (
      '${offerId}', '${userId}', 'interleaved-checkout@example.test', 'v2:interleaved-checkout',
      'litos-entitlements-v2:historical', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
      'failed', '${sessionId}', 'https://checkout.stripe.com/c/pay/${sessionId}',
      '2026-08-01T00:00:00.000Z', 'litos_plus', 'month', 'price_month', 'website',
      'start_plan', 'interleaved-checkout'
    );
  `);
  const token = await authToken(userId);
  const acceptedRevision = await checkoutTermsRevision(token, 'litos_plus_month');
  const creationCount = providerCheckoutCreationCount;
  completedCheckoutFixtures.set(sessionId, {
    offerId,
    userId,
    subscriptionId: 'sub_checkout_interleaved',
    paymentStatus: 'unpaid',
  });

  let signalProviderRead!: () => void;
  let releaseProviderRead!: () => void;
  const providerReadStarted = new Promise<void>((resolve) => { signalProviderRead = resolve; });
  const providerReadRelease = new Promise<void>((resolve) => { releaseProviderRead = resolve; });
  blockedSubscriptionRead = {
    subscriptionId: 'sub_checkout_interleaved',
    started: signalProviderRead,
    release: providerReadRelease,
  };

  try {
    const reconciliation = app.inject({
      method: 'POST',
      url: '/billing/reconcile',
      headers: { authorization: `Bearer ${token}` },
      payload: { offer_id: offerId },
    });
    await providerReadStarted;

    /* Reconciliation owns the account lock while its provider read is paused. Checkout is now a
       real concurrent request, but it cannot snapshot the old trial eligibility behind that read. */
    const checkout = app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': '13d786b4-4594-41a8-84fc-655f016b448b',
      },
      payload: {
        plan_id: 'litos_plus_month',
        surface: 'website',
        placement: 'onboarding',
        trigger: 'start_plan',
        checkout_terms_revision: acceptedRevision,
      },
    });
    releaseProviderRead();
    const [reconcileResponse, checkoutResponse] = await Promise.all([reconciliation, checkout]);

    assert.equal(reconcileResponse.statusCode, 200, reconcileResponse.body);
    assert.equal(reconcileResponse.json().reconciled, true);
    assert.equal(checkoutResponse.statusCode, 409, checkoutResponse.body);
    assert.equal(checkoutResponse.json().code, 'checkout_terms_changed');
    assert.equal(providerCheckoutCreationCount, creationCount, 'a second Stripe Session escaped the account lock');
    const liveOffers = await database.query<{ count: string }>(`
      select count(*)::text as "count" from "pricing_offers"
      where "user_id" = '${userId}' and "status" in ('creating', 'checkout_created')
    `);
    assert.equal(liveOffers.rows[0].count, '0');
  } finally {
    releaseProviderRead();
    blockedSubscriptionRead = null;
    completedCheckoutFixtures.delete(sessionId);
  }
});

test('a Stripe Session created across a concurrent entitlement change is expired before any URL escapes', async () => {
  const userId = '469326ad-6e8a-40f0-a267-a7a59c609703';
  const historicalOfferId = '651fc91b-b351-4a16-b3c7-98a287390235';
  const historicalSessionId = 'cs_checkout_external_gap_history';
  const newSessionId = 'cs_checkout_external_gap_new';
  const newIdempotencyKey = '817a1ec7-2e67-4bac-ab5f-5917695659c9';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'external-gap@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "provider_checkout_id", "provider_checkout_url", "expires_at", "product_code", "term_code",
      "provider_price_id", "surface", "trigger", "client_idempotency_key"
    ) values (
      '${historicalOfferId}', '${userId}', 'external-gap@example.test', 'v2:external-gap-history',
      'litos-entitlements-v2:historical', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
      'failed', '${historicalSessionId}', 'https://checkout.stripe.com/c/pay/${historicalSessionId}',
      '2026-08-01T00:00:00.000Z', 'litos_plus', 'month', 'price_month', 'website',
      'start_plan', 'external-gap-history'
    );
  `);
  const token = await authToken(userId);
  const acceptedRevision = await checkoutTermsRevision(token, 'litos_plus_month');
  const creationCount = providerCheckoutCreationCount;
  const expirationCount = expiredProviderSessions.length;
  completedCheckoutFixtures.set(historicalSessionId, {
    offerId: historicalOfferId,
    userId,
    subscriptionId: 'sub_checkout_external_gap',
    paymentStatus: 'paid',
  });

  let signalCheckoutCreation!: () => void;
  let releaseCheckoutCreation!: () => void;
  const checkoutCreationStarted = new Promise<void>((resolve) => { signalCheckoutCreation = resolve; });
  const checkoutCreationRelease = new Promise<void>((resolve) => { releaseCheckoutCreation = resolve; });
  blockedCheckoutCreation = {
    sessionId: newSessionId,
    started: signalCheckoutCreation,
    release: checkoutCreationRelease,
  };

  try {
    const checkout = app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': newIdempotencyKey,
      },
      payload: {
        plan_id: 'litos_plus_month',
        surface: 'website',
        placement: 'onboarding',
        trigger: 'start_plan',
        checkout_terms_revision: acceptedRevision,
      },
    });
    await checkoutCreationStarted;

    /* The new offer is reserved, but Stripe has not returned its Session yet. A historical paid
       checkout now changes the canonical entitlement before the new Session can be persisted. */
    const reconcileResponse = await app.inject({
      method: 'POST',
      url: '/billing/reconcile',
      headers: { authorization: `Bearer ${token}` },
      payload: { offer_id: historicalOfferId },
    });
    assert.equal(reconcileResponse.statusCode, 200, reconcileResponse.body);
    assert.equal(reconcileResponse.json().access_class, 'plus_paid');

    releaseCheckoutCreation();
    const checkoutResponse = await checkout;
    assert.equal(checkoutResponse.statusCode, 409, checkoutResponse.body);
    assert.equal(checkoutResponse.json().code, 'already_plus');
    assert.equal('checkout_url' in checkoutResponse.json(), false);
    assert.equal(providerCheckoutCreationCount, creationCount + 1);
    assert.deepEqual(expiredProviderSessions.slice(expirationCount), [newSessionId]);

    const [offers, subscriptions, userRows] = await Promise.all([
      database.query<{ client_idempotency_key: string; provider_checkout_id: string; status: string }>(`
        select "client_idempotency_key", "provider_checkout_id", "status"
        from "pricing_offers" where "user_id" = '${userId}' order by "created_at"
      `),
      database.query<{ status: string }>(`
        select "status" from "billing_subscriptions" where "user_id" = '${userId}'
      `),
      database.query<{ plan: string; billing_subscription_id: string }>(`
        select "plan", "billing_subscription_id" from "users" where "id" = '${userId}'
      `),
    ]);
    const historical = offers.rows.find((row) => row.client_idempotency_key === 'external-gap-history');
    const replacement = offers.rows.find((row) => row.client_idempotency_key === newIdempotencyKey);
    assert.deepEqual(historical, {
      client_idempotency_key: 'external-gap-history',
      provider_checkout_id: historicalSessionId,
      status: 'paid',
    });
    assert.deepEqual(replacement, {
      client_idempotency_key: newIdempotencyKey,
      provider_checkout_id: newSessionId,
      status: 'expired',
    });
    assert.deepEqual(subscriptions.rows, [{ status: 'active' }]);
    assert.deepEqual(userRows.rows, [{ plan: 'pro', billing_subscription_id: 'sub_checkout_external_gap' }]);
  } finally {
    releaseCheckoutCreation();
    blockedCheckoutCreation = null;
    completedCheckoutFixtures.delete(historicalSessionId);
  }
});

test('a Stripe Session is tracked and expired when its pending action changes during creation', async () => {
  const userId = '14908a6b-48fe-4ccd-91e0-e3448c41bbc0';
  const actionId = '360b89ac-8b0a-4e22-99b7-c1df47d2f2da';
  const actionNonce = 'action-consumed-during-checkout-creation';
  const nonceHash = createHash('sha256').update(actionNonce).digest('hex');
  const idempotencyKey = '8584a1d7-6ee9-43ca-a4fd-c3d7c105f045';
  const sessionId = 'cs_action_changed_during_creation';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'action-gap@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pending_premium_actions" (
      "id", "nonce_hash", "user_id", "feature_key", "return_route", "context_hash",
      "idempotency_key", "state", "offer_id", "expires_at"
    ) values (
      '${actionId}', '${nonceHash}', '${userId}', 'ai_resume_tailoring', '/dashboard/applications',
      'action-gap-context', 'action-gap-operation', 'pending', null, '2099-01-01T00:00:00.000Z'
    );
  `);
  const token = await authToken(userId);
  const acceptedRevision = await checkoutTermsRevision(token, 'litos_plus_month');
  const expirationCount = expiredProviderSessions.length;

  let signalCheckoutCreation!: () => void;
  let releaseCheckoutCreation!: () => void;
  const checkoutCreationStarted = new Promise<void>((resolve) => { signalCheckoutCreation = resolve; });
  const checkoutCreationRelease = new Promise<void>((resolve) => { releaseCheckoutCreation = resolve; });
  blockedCheckoutCreation = {
    sessionId,
    started: signalCheckoutCreation,
    release: checkoutCreationRelease,
  };

  try {
    const checkout = app.inject({
      method: 'POST',
      url: '/billing/checkout',
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': idempotencyKey,
      },
      payload: {
        plan_id: 'litos_plus_month',
        surface: 'dashboard',
        placement: 'resume_limit',
        trigger: 'resume_limit',
        action_nonce: actionNonce,
        checkout_terms_revision: acceptedRevision,
      },
    });
    await checkoutCreationStarted;
    await database.exec(`
      update "pending_premium_actions" set "state" = 'consumed' where "id" = '${actionId}'
    `);
    releaseCheckoutCreation();

    const response = await checkout;
    assert.equal(response.statusCode, 409, response.body);
    assert.equal(response.json().code, 'action_binding_conflict');
    assert.equal('checkout_url' in response.json(), false);
    assert.deepEqual(expiredProviderSessions.slice(expirationCount), [sessionId]);

    const [offers, actions] = await Promise.all([
      database.query<{ status: string; provider_checkout_id: string | null }>(`
        select "status", "provider_checkout_id" from "pricing_offers"
        where "user_id" = '${userId}' and "client_idempotency_key" = '${idempotencyKey}'
      `),
      database.query<{ state: string; offer_id: string | null }>(`
        select "state", "offer_id" from "pending_premium_actions" where "id" = '${actionId}'
      `),
    ]);
    assert.deepEqual(offers.rows, [{ status: 'expired', provider_checkout_id: sessionId }]);
    assert.deepEqual(actions.rows, [{ state: 'consumed', offer_id: null }]);
  } finally {
    releaseCheckoutCreation();
    blockedCheckoutCreation = null;
  }
});

test('a checkout opened before a Stripe Price rotation completes from its immutable offer binding', async () => {
  const userId = '01b33b22-d660-4e02-a526-32ffbbf1f3a2';
  const offerId = 'eff62753-b815-4cc5-84f3-4124498c752b';
  const sessionId = 'cs_rotated_checkout';
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'rotated-checkout@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "provider_checkout_id", "provider_checkout_url", "expires_at", "product_code", "term_code",
      "provider_price_id", "surface", "trigger", "client_idempotency_key"
    ) values (
      '${offerId}', '${userId}', 'rotated-checkout@example.test', 'v2:rotated-checkout',
      'litos-entitlements-v2:historical', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
      'checkout_created', '${sessionId}', 'https://checkout.stripe.com/c/pay/${sessionId}',
      now() + interval '15 minutes', 'litos_plus', 'month', 'price_month_previous', 'website',
      'start_plan', 'rotated-checkout'
    );
  `);
  const previousPrice = process.env.STRIPE_PLUS_MONTHLY_PRICE_ID;
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = 'price_month_rotated';
  try {
    const response = await postStripeEvent({
      id: 'evt_rotated_checkout',
      type: 'checkout.session.completed',
      created: 1_786_500_000,
      livemode: false,
      data: { object: {
        id: sessionId,
        object: 'checkout.session',
        customer: 'cus_rotated_checkout',
        subscription: 'sub_rotated_checkout',
        client_reference_id: offerId,
        payment_status: 'paid',
        metadata: { litos_user_id: userId, litos_offer_id: offerId },
      } },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().processed, true);
  } finally {
    if (previousPrice === undefined) delete process.env.STRIPE_PLUS_MONTHLY_PRICE_ID;
    else process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = previousPrice;
  }

  const [offer, subscription, user] = await Promise.all([
    database.query<{ status: string; provider_subscription_id: string | null }>(`
      select "status", "provider_subscription_id" from "pricing_offers" where "id" = '${offerId}'
    `),
    database.query<{ provider_price_id: string; term_code: string; status: string }>(`
      select "provider_price_id", "term_code", "status" from "billing_subscriptions"
      where "provider_subscription_id" = 'sub_rotated_checkout'
    `),
    database.query<{ plan: string }>(`select "plan" from "users" where "id" = '${userId}'`),
  ]);
  assert.deepEqual(offer.rows[0], {
    status: 'paid',
    provider_subscription_id: 'sub_rotated_checkout',
  });
  assert.deepEqual(subscription.rows[0], {
    provider_price_id: 'price_month_previous',
    term_code: 'month',
    status: 'active',
  });
  assert.equal(user.rows[0].plan, 'pro');
});

test('an abandoned checkout releases the sole-live slot and aligns the next offer, action, and Stripe expiry', async () => {
  const userId = '04f69c62-c795-469c-b3bf-dc77feaf63b2';
  const oldActionId = '66087296-eb30-420a-9729-a7508c1efe03';
  const oldOfferId = '5c08738b-9631-4587-b44a-80880d907196';
  const newActionId = 'd4951957-3669-49a9-b7db-9e139954dc1e';
  const idempotencyKey = 'ff7da1c1-7c3d-41eb-81c9-70b2ca3a8743';
  const newActionNonce = 'new-action-after-abandoned-checkout';
  const oldNonceHash = createHash('sha256').update('old-abandoned-action').digest('hex');
  const newNonceHash = createHash('sha256').update(newActionNonce).digest('hex');
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'checkout-abandoned@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pending_premium_actions" (
      "id", "nonce_hash", "user_id", "feature_key", "return_route", "context_hash",
      "idempotency_key", "state", "offer_id", "expires_at"
    ) values
      (
        '${oldActionId}', '${oldNonceHash}', '${userId}', 'ai_resume_tailoring', '/dashboard/applications',
        'old-abandoned-context', 'old-abandoned-operation', 'pending', '${oldOfferId}',
        '2026-08-01T00:00:00.000Z'
      ),
      (
        '${newActionId}', '${newNonceHash}', '${userId}', 'ai_resume_tailoring', '/dashboard/applications',
        'new-checkout-context', 'new-checkout-operation', 'pending', null,
        now() + interval '31 minutes'
      );
    insert into "pricing_offers" (
      "id", "user_id", "subject_id", "idempotency_key", "policy_version", "country_code", "band",
      "experiment_variant", "billing_interval", "currency", "base_amount_cents", "amount_cents", "status",
      "provider_checkout_id", "provider_checkout_url", "expires_at", "product_code", "term_code",
      "provider_price_id", "surface", "trigger", "client_idempotency_key", "pending_action_id"
    ) values (
      '${oldOfferId}', '${userId}', 'checkout-abandoned@example.test', 'v2:old-abandoned-key',
      'litos-entitlements-v2', 'US', 'standard', 'control', 'month', 'USD', 3999, 3999,
      'checkout_created', 'cs_old_abandoned', 'https://checkout.stripe.com/c/pay/cs_old_abandoned',
      '2026-08-01T00:00:00.000Z', 'litos_plus', 'month', 'price_month', 'dashboard',
      'resume_limit', 'old-abandoned-key', '${oldActionId}'
    );
  `);

  const token = await authToken(userId);
  const checkoutTerms = await checkoutTermsRevision(token, 'litos_plus_month');
  const response = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'dashboard',
      trigger: 'resume_limit',
      action_nonce: newActionNonce,
      checkout_terms_revision: checkoutTerms,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const checkoutResponse = response.json() as { expires_at: string };

  const oldOffer = await database.query<{ status: string }>(`
    select "status" from "pricing_offers" where "id" = '${oldOfferId}'
  `);
  assert.equal(oldOffer.rows[0].status, 'expired');
  const next = await database.query<{
    id: string;
    status: string;
    provider_checkout_id: string | null;
    pending_action_id: string | null;
    expires_at: Date;
    action_offer_id: string | null;
    action_expires_at: Date;
  }>(`
    select
      o."id", o."status", o."provider_checkout_id", o."pending_action_id", o."expires_at",
      a."offer_id" as "action_offer_id", a."expires_at" as "action_expires_at"
    from "pricing_offers" o
    join "pending_premium_actions" a on a."id" = o."pending_action_id"
    where o."user_id" = '${userId}' and o."client_idempotency_key" = '${idempotencyKey}'
  `);
  assert.equal(next.rows[0].status, 'checkout_created');
  assert.equal(next.rows[0].provider_checkout_id, 'cs_recovered_external');
  assert.equal(next.rows[0].pending_action_id, newActionId);
  assert.equal(next.rows[0].action_offer_id, next.rows[0].id);
  assert.equal(
    new Date(next.rows[0].action_expires_at).toISOString(),
    new Date(next.rows[0].expires_at).toISOString(),
  );
  assert.equal(
    checkoutResponse.expires_at,
    new Date(next.rows[0].expires_at).toISOString(),
  );
  const remainingMs = new Date(next.rows[0].expires_at).getTime() - Date.now();
  assert.ok(remainingMs >= 30 * 60 * 1000);
  assert.ok(remainingMs <= 31 * 60 * 1000);
});

test('checkout returns the aligned expiry and keeps a pending action resumable after its original boundary', async (t) => {
  const userId = 'f7d9ed8a-b9f3-4779-895e-ae02e8562597';
  const actionId = '1b199613-b56f-4333-ae4f-064fc3ab9b84';
  const idempotencyKey = '0609b043-69f8-49f3-9074-b6d648600ef3';
  const actionNonce = 'checkout-expiry-propagation-action';
  const nonceHash = createHash('sha256').update(actionNonce).digest('hex');
  const originalActionExpiry = new Date(Date.now() + 5 * 60 * 1000);
  await database.exec(`
    insert into "users" ("id", "email", "plan", "created_at", "entitlement_policy_version")
    values (
      '${userId}', 'checkout-expiry-propagation@example.test', 'free',
      '2026-08-14T00:00:00.000Z', 'litos-entitlements-v2'
    );
    insert into "pending_premium_actions" (
      "id", "nonce_hash", "user_id", "feature_key", "return_route", "context_hash",
      "idempotency_key", "state", "offer_id", "expires_at"
    ) values (
      '${actionId}', '${nonceHash}', '${userId}', 'ai_resume_tailoring', '/dashboard/applications',
      'checkout-expiry-propagation-context', 'checkout-expiry-propagation-operation', 'pending', null,
      '${originalActionExpiry.toISOString()}'
    );
  `);

  const token = await authToken(userId);
  const checkoutTerms = await checkoutTermsRevision(token, 'litos_plus_month');
  const response = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'dashboard',
      trigger: 'resume_limit',
      action_nonce: actionNonce,
      checkout_terms_revision: checkoutTerms,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  const checkout = response.json() as { offer_id: string; expires_at: string };
  const aligned = await database.query<{
    offer_id: string;
    offer_expires_at: Date;
    action_expires_at: Date;
  }>(`
    select
      o."id" as "offer_id",
      o."expires_at" as "offer_expires_at",
      a."expires_at" as "action_expires_at"
    from "pricing_offers" o
    join "pending_premium_actions" a on a."id" = o."pending_action_id"
    where o."user_id" = '${userId}' and o."client_idempotency_key" = '${idempotencyKey}'
  `);
  assert.equal(aligned.rows.length, 1);
  const offerExpiry = new Date(aligned.rows[0].offer_expires_at).toISOString();
  const actionExpiry = new Date(aligned.rows[0].action_expires_at).toISOString();
  assert.equal(checkout.offer_id, aligned.rows[0].offer_id);
  assert.equal(checkout.expires_at, offerExpiry);
  assert.equal(checkout.expires_at, actionExpiry);
  assert.ok(new Date(checkout.expires_at).getTime() > originalActionExpiry.getTime());

  t.mock.timers.enable({
    apis: ['Date'],
    now: originalActionExpiry.getTime() + 1_000,
  });
  const lateReturn = await app.inject({
    method: 'GET',
    url: `/billing/actions/${encodeURIComponent(actionNonce)}`,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(lateReturn.statusCode, 200, lateReturn.body);
  assert.equal(lateReturn.json().offer_id, checkout.offer_id);
  assert.equal(new Date(lateReturn.json().expires_at).toISOString(), checkout.expires_at);
});
