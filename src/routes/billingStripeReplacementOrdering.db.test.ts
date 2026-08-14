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

const WEBHOOK_SECRET = 'whsec_replacement_ordering';
const socketDir = mkdtempSync(join(tmpdir(), 'litos-billing-replacement-'));
let database: PGlite;
let server: PGLiteSocketServer;
let app: FastifyInstance;
let backendPool: { end(): Promise<void> };
let getEntitlementSnapshot: typeof import('../lib/entitlements').getEntitlementSnapshot;
const savedEnv = { ...process.env };
const savedFetch = globalThis.fetch;
let providerSubscriptionUnavailable = true;

function providerSubscriptionFixture(subscriptionId: string) {
  const fixtures: Record<string, {
    customerId: string;
    status: string;
    periodEnd: number;
    endedAt?: number;
    cancelAtPeriodEnd?: boolean;
    cancelAt?: number;
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
  process.env.STRIPE_SECRET_KEY = 'sk_test_replacement_ordering';
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
      const body = new URLSearchParams(String(init?.body));
      return new Response(JSON.stringify({
        id: 'cs_recovered_external',
        url: 'https://checkout.stripe.com/c/pay/cs_recovered_external',
        customer: 'cus_recovered_external',
        subscription: 'sub_recovered_external',
        expires_at: Number(body.get('expires_at')),
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
      if (id === 'sub_provider_unavailable' && providerSubscriptionUnavailable) {
        return new Response('{}', { status: 503 });
      }
      const fixture = providerSubscriptionFixture(id);
      if (!fixture) return new Response('{}', { status: 404 });
      return new Response(JSON.stringify({
        id,
        customer: fixture.customerId,
        status: fixture.status,
        cancel_at_period_end: fixture.cancelAtPeriodEnd ?? false,
        ...(fixture.cancelAt ? { cancel_at: fixture.cancelAt } : {}),
        ...(fixture.endedAt ? { ended_at: fixture.endedAt } : {}),
        metadata: { litos_product_code: 'litos_plus' },
        items: { data: [{
          quantity: 1,
          price: { id: 'price_month' },
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
  const response = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_quarter',
      surface: 'dashboard',
      trigger: 'account_upgrade',
      action_nonce: actionNonce,
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().offer_id, offerId);
  assert.equal(response.json().checkout_session_id, 'cs_checkout_repair');
  const action = await database.query<{ offer_id: string | null }>(`
    select "offer_id" from "pending_premium_actions" where "id" = '${actionId}'
  `);
  assert.equal(action.rows[0].offer_id, offerId);
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
  const response = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'extension',
      trigger: 'resume_limit',
      action_nonce: actionNonce,
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
  const response = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'dashboard',
      trigger: 'resume_limit',
      action_nonce: newActionNonce,
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
  const response = await app.inject({
    method: 'POST',
    url: '/billing/checkout',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': idempotencyKey },
    payload: {
      plan_id: 'litos_plus_month',
      surface: 'dashboard',
      trigger: 'resume_limit',
      action_nonce: actionNonce,
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
