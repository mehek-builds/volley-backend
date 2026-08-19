import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import {
  cancelStripeSubscriptionOrThrow,
  createStripeCheckoutSessionV2,
  parseStripeBillingEvent,
  retrieveStripeBillingAuthority,
  retrieveStripeChargeBillingContext,
  secureLegacyBillingPortalUrl,
} from './stripeBilling';

const saved = { ...process.env };

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_litos';
  process.env.STRIPE_PLUS_WEEKLY_PRICE_ID = 'price_week';
  process.env.STRIPE_PLUS_MONTHLY_PRICE_ID = 'price_month';
  process.env.STRIPE_PLUS_QUARTERLY_PRICE_ID = 'price_quarter';
  process.env.LITOS_BILLING_SUCCESS_URL = 'https://trylitos.com/billing/return';
  process.env.LITOS_BILLING_CANCEL_URL = 'https://trylitos.com/billing/return';
});

afterEach(() => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  Object.assign(process.env, saved);
});

describe('Stripe Litos+ adapter', () => {
  test('a first-time trial rides on the subscription, and Stripe is forbidden to skip the card', async () => {
    /* The two lines that make the trial card-required. trial_period_days is the
       trial itself; payment_method_collection=always is what stops Stripe from
       helpfully skipping card entry because a trialling subscription's first
       invoice is $0. Losing the second one silently restores the card-free trial
       this whole change exists to remove, and nothing user-visible would look
       wrong, so it is pinned here on the request body. */
    const expiresAt = new Date(Date.now() + 31 * 60 * 1000);
    let checkoutBody: URLSearchParams | null = null;
    const result = await createStripeCheckoutSessionV2({
      offerId: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      userId: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
      email: 'student@example.com',
      planId: 'litos_plus_month',
      idempotencyKey: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      expiresAt,
      trialDays: 7,
      fetchImpl: async (url, init) => {
        if (String(url).includes('/v1/prices/')) {
          return new Response(JSON.stringify({
            id: 'price_month',
            active: true,
            currency: 'usd',
            unit_amount: 3999,
            recurring: { interval: 'month', interval_count: 1 },
          }), { status: 200 });
        }
        checkoutBody = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify({
          id: 'cs_test_trial',
          url: 'https://checkout.stripe.com/c/pay/cs_test_trial',
          customer: 'cus_new',
          subscription: null,
          expires_at: Math.floor(expiresAt.getTime() / 1000),
        }), { status: 200 });
      },
    });
    assert.ok(result);
    assert.equal(checkoutBody!.get('subscription_data[trial_period_days]'), '7');
    assert.equal(checkoutBody!.get('payment_method_collection'), 'always');
  });

  test('a second trial is refused: no trial days, still card-required', async () => {
    /* trialDays 0 is what the route sends once an account has spent its trial.
       The absence of trial_period_days is the assertion that matters: present
       with any value would be a second free week for someone who already had
       one, which is the exact hole the once-per-account gate closes. */
    const expiresAt = new Date(Date.now() + 31 * 60 * 1000);
    let checkoutBody: URLSearchParams | null = null;
    const result = await createStripeCheckoutSessionV2({
      offerId: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      userId: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
      email: 'student@example.com',
      planId: 'litos_plus_week',
      idempotencyKey: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      expiresAt,
      trialDays: 0,
      fetchImpl: async (url, init) => {
        if (String(url).includes('/v1/prices/')) {
          return new Response(JSON.stringify({
            id: 'price_week',
            active: true,
            currency: 'usd',
            unit_amount: 1999,
            recurring: { interval: 'week', interval_count: 1 },
          }), { status: 200 });
        }
        checkoutBody = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify({
          id: 'cs_test_no_trial',
          url: 'https://checkout.stripe.com/c/pay/cs_test_no_trial',
          customer: 'cus_new',
          subscription: null,
          expires_at: Math.floor(expiresAt.getTime() / 1000),
        }), { status: 200 });
      },
    });
    assert.ok(result);
    assert.equal(checkoutBody!.get('subscription_data[trial_period_days]'), null);
    assert.equal(checkoutBody!.get('payment_method_collection'), 'always');
  });

  test('creates quarterly Checkout with server-owned price and complete metadata', async () => {
    const expiresAt = new Date(Date.now() + 31 * 60 * 1000);
    const result = await createStripeCheckoutSessionV2({
      offerId: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      userId: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
      email: 'student@example.com',
      planId: 'litos_plus_quarter',
      idempotencyKey: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      surface: 'extension',
      existingCustomerId: 'cus_existing',
      actionId: 'd31fa5dc-791f-49f2-a97a-0efb09c54e99',
      actionNonce: 'pending-action-nonce-1234567890',
      expiresAt,
      fetchImpl: async (url, init) => {
        if (String(url).includes('/v1/prices/')) {
          return new Response(JSON.stringify({
            id: 'price_quarter',
            active: true,
            currency: 'usd',
            unit_amount: 8999,
            recurring: { interval: 'month', interval_count: 3 },
          }), { status: 200 });
        }
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('line_items[0][price]'), 'price_quarter');
        assert.equal(body.get('customer'), 'cus_existing');
        assert.equal(body.get('customer_email'), null);
        assert.equal(body.get('metadata[litos_term_code]'), 'quarter');
        assert.equal(body.get('subscription_data[metadata][litos_policy_version]'), 'litos-entitlements-v2');
        assert.equal(body.get('expires_at'), String(Math.floor(expiresAt.getTime() / 1000)));
        const successUrl = new URL(body.get('success_url')!);
        assert.equal(successUrl.searchParams.get('surface'), 'extension');
        assert.equal(successUrl.searchParams.get('context'), '6d58c1f5-e885-41f7-a16a-dac37f98ab17');
        assert.equal(successUrl.searchParams.get('status'), 'success');
        assert.equal(successUrl.searchParams.get('session_id'), '{CHECKOUT_SESSION_ID}');
        assert.equal(successUrl.searchParams.get('action_nonce'), 'pending-action-nonce-1234567890');
        const cancelUrl = new URL(body.get('cancel_url')!);
        assert.equal(cancelUrl.searchParams.get('surface'), 'extension');
        assert.equal(cancelUrl.searchParams.get('context'), '6d58c1f5-e885-41f7-a16a-dac37f98ab17');
        assert.equal(cancelUrl.searchParams.get('status'), 'cancelled');
        assert.equal(cancelUrl.searchParams.get('action_nonce'), 'pending-action-nonce-1234567890');
        assert.equal((init?.headers as Record<string, string>)['idempotency-key'], 'litos-checkout:7e8de6fb-236b-4e9b-863a-7b4f2952e1a7:a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11');
        return new Response(JSON.stringify({
          id: 'cs_test_1',
          url: 'https://checkout.stripe.com/c/pay/cs_test_1',
          expires_at: Number(body.get('expires_at')),
        }), { status: 200 });
      },
    });
    assert.equal(result?.id, 'cs_test_1');
    assert.equal(result?.expiresAt.toISOString(), new Date(Math.floor(expiresAt.getTime() / 1000) * 1000).toISOString());
  });

  test('keeps website checkout returns website-owned and uses email without a customer', async () => {
    const expiresAt = new Date(Date.now() + 31 * 60 * 1000);
    const result = await createStripeCheckoutSessionV2({
      offerId: '57ce74ec-1103-46fb-992d-a618e71bc355',
      userId: '9610648e-7750-4931-9a74-8aef5ebf00c0',
      email: ' Website@Example.com ',
      planId: 'litos_plus_week',
      idempotencyKey: 'b33463ae-a8c8-45b5-9ef4-eaf34408d1c2',
      surface: 'website',
      expiresAt,
      fetchImpl: async (url, init) => {
        if (String(url).includes('/v1/prices/')) {
          return new Response(JSON.stringify({
            id: 'price_week', active: true, currency: 'usd', unit_amount: 1999,
            recurring: { interval: 'week', interval_count: 1 },
          }), { status: 200 });
        }
        const body = new URLSearchParams(String(init?.body));
        assert.equal(body.get('customer'), null);
        assert.equal(body.get('customer_email'), 'website@example.com');
        assert.equal(new URL(body.get('success_url')!).searchParams.get('surface'), 'website');
        assert.equal(new URL(body.get('cancel_url')!).searchParams.get('surface'), 'website');
        return new Response(JSON.stringify({
          id: 'cs_test_website',
          url: 'https://checkout.stripe.com/c/pay/cs_test_website',
          expires_at: Number(body.get('expires_at')),
        }), { status: 200 });
      },
    });
    assert.equal(result?.id, 'cs_test_website');
  });

  test('refuses checkout when the live Stripe Price does not match the catalog', async () => {
    let checkoutCalled = false;
    const result = await createStripeCheckoutSessionV2({
      offerId: '6d58c1f5-e885-41f7-a16a-dac37f98ab17',
      userId: '7e8de6fb-236b-4e9b-863a-7b4f2952e1a7',
      email: 'student@example.com',
      planId: 'litos_plus_month',
      idempotencyKey: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      expiresAt: new Date(Date.now() + 31 * 60 * 1000),
      fetchImpl: async (url) => {
        if (String(url).includes('/v1/checkout/')) checkoutCalled = true;
        return new Response(JSON.stringify({
          id: 'price_month', active: true, currency: 'usd', unit_amount: 999,
          recurring: { interval: 'month', interval_count: 1 },
        }), { status: 200 });
      },
    });
    assert.equal(result, null);
    assert.equal(checkoutCalled, false);
  });

  test('refuses a Stripe response whose provider expiry outlives the requested boundary', async () => {
    const expiresAt = new Date(Date.now() + 31 * 60 * 1000);
    const result = await createStripeCheckoutSessionV2({
      offerId: '69672fd1-bca8-4fad-ad5d-37e136cffb32',
      userId: '026e24a5-1c35-47d0-a4a2-501acfb96b48',
      email: 'expiry@example.com',
      planId: 'litos_plus_month',
      idempotencyKey: '491692d0-b09a-41f7-a491-da1533707458',
      expiresAt,
      fetchImpl: async (url) => String(url).includes('/v1/prices/')
        ? new Response(JSON.stringify({
          id: 'price_month', active: true, currency: 'usd', unit_amount: 3999,
          recurring: { interval: 'month', interval_count: 1 },
        }), { status: 200 })
        : new Response(JSON.stringify({
          id: 'cs_default_expiry',
          url: 'https://checkout.stripe.com/c/pay/cs_default_expiry',
          expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        }), { status: 200 }),
    });
    assert.equal(result, null);
  });

  test('parses subscription, invoice, refund, and dispute families', () => {
    const subscription = parseStripeBillingEvent({
      id: 'evt_sub', type: 'customer.subscription.updated', created: 1_786_000_000, livemode: true,
      data: { object: {
        id: 'sub_1', object: 'subscription', customer: 'cus_1', status: 'active',
        current_period_start: 1_786_000_000, current_period_end: 1_793_776_000,
        metadata: { litos_user_id: 'user-1', litos_term_code: 'quarter' },
        items: { data: [{ price: { id: 'price_quarter' } }] },
      } },
    });
    assert.equal(subscription?.plan?.id, 'litos_plus_quarter');
    assert.equal(subscription?.subscriptionId, 'sub_1');

    const refund = parseStripeBillingEvent({
      id: 'evt_refund', type: 'charge.refunded', created: 1_786_000_000, livemode: true,
      data: { object: { id: 'ch_1', customer: 'cus_1', invoice: 'in_1', amount: 3999, amount_refunded: 3999, refunded: true } },
    });
    assert.equal(refund?.status, 'refunded');
    assert.equal(refund?.amountRefunded, 3999);

    const invoice = parseStripeBillingEvent({
      id: 'evt_invoice', type: 'invoice.paid', created: 1_786_000_000, livemode: true,
      data: { object: {
        id: 'in_1', customer: 'cus_1', subscription: 'sub_1', payment_intent: 'pi_1',
        lines: { data: [{ price: { id: 'price_month' }, period: { start: 1_786_000_000, end: 1_788_592_000 } }] },
      } },
    });
    assert.equal(invoice?.subscriptionId, 'sub_1');
    assert.equal(invoice?.priceId, 'price_month');
    assert.equal(invoice?.plan?.id, 'litos_plus_month');
    assert.equal(invoice?.currentPeriodEnd?.toISOString(), new Date(1_788_592_000_000).toISOString());

    const failedInvoice = parseStripeBillingEvent({
      id: 'evt_invoice_failed', type: 'invoice.payment_failed', created: 1_786_000_000, livemode: true,
      data: { object: {
        id: 'in_failed', customer: 'cus_1', subscription: 'sub_1', payment_intent: 'pi_failed',
        lines: { data: [{ price: { id: 'price_month' }, period: { start: 1_786_000_000, end: 1_793_776_000 } }] },
      } },
    });
    assert.equal(failedInvoice?.currentPeriodEnd?.toISOString(), new Date(1_793_776_000_000).toISOString());
    assert.equal(failedInvoice?.accessEndsAt?.toISOString(), new Date(1_786_000_000_000).toISOString());

    const dispute = parseStripeBillingEvent({
      id: 'evt_dispute', type: 'charge.dispute.created', created: 1_786_000_000, livemode: true,
      data: { object: { id: 'dp_1', charge: 'ch_1', status: 'needs_response' } },
    });
    assert.equal(dispute?.status, 'disputed');
  });

  test('parses the Basil invoice parent subscription and pricing shape', () => {
    const invoice = parseStripeBillingEvent({
      id: 'evt_invoice_basil', type: 'invoice.paid', created: 1_786_000_000, livemode: true,
      data: { object: {
        id: 'in_basil', customer: 'cus_1',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_basil' } },
        payments: { data: [{ payment: { payment_intent: 'pi_basil' } }] },
        lines: { data: [{
          pricing: { price_details: { price: 'price_month' } },
          period: { start: 1_786_000_000, end: 1_788_592_000 },
        }] },
      } },
    });
    assert.equal(invoice?.subscriptionId, 'sub_basil');
    assert.equal(invoice?.priceId, 'price_month');
    assert.equal(invoice?.plan?.id, 'litos_plus_month');
    assert.equal(invoice?.paymentIntentId, 'pi_basil');

    const unrelatedParent = parseStripeBillingEvent({
      id: 'evt_invoice_unrelated_parent', type: 'invoice.paid', created: 1_786_000_000, livemode: true,
      data: { object: {
        id: 'in_unrelated_parent', customer: 'cus_1',
        parent: { type: 'quote_details', subscription_details: { subscription: 'sub_wrong' } },
        lines: { data: [{ pricing: { price_details: { price: 'price_month' } } }] },
      } },
    });
    assert.equal(unrelatedParent?.subscriptionId, null);

    const subscription = parseStripeBillingEvent({
      id: 'evt_subscription_basil', type: 'customer.subscription.updated', created: 1_786_000_000, livemode: true,
      data: { object: {
        id: 'sub_basil', customer: 'cus_1', status: 'active', cancel_at_period_end: true,
        items: { data: [{
          price: { id: 'price_month' },
          current_period_start: 1_786_000_000,
          current_period_end: 1_788_592_000,
        }] },
      } },
    });
    assert.equal(subscription?.currentPeriodStart?.toISOString(), new Date(1_786_000_000_000).toISOString());
    assert.equal(subscription?.currentPeriodEnd?.toISOString(), new Date(1_788_592_000_000).toISOString());
    assert.equal(subscription?.accessEndsAt?.toISOString(), new Date(1_788_592_000_000).toISOString());
  });

  test('hydrates a late paid invoice from the current canceled provider subscription', async () => {
    const parsed = parseStripeBillingEvent({
      id: 'evt_invoice_late', type: 'invoice.paid', created: 1_786_000_000, livemode: true,
      data: { object: {
        id: 'in_late', customer: 'cus_1',
        parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_late' } },
        lines: { data: [{ pricing: { price_details: { price: 'price_month' } } }] },
      } },
    });
    assert.ok(parsed);
    const authority = await retrieveStripeBillingAuthority({
      event: parsed,
      fetchImpl: async (url) => {
        if (String(url).includes('/invoices/')) {
          return new Response(JSON.stringify({
            id: 'in_late', customer: 'cus_1',
            parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_late' } },
            lines: { data: [{ pricing: { price_details: { price: 'price_month' } } }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          id: 'sub_late', customer: 'cus_1', status: 'canceled', ended_at: 1_786_100_000,
          items: { data: [{
            quantity: 1, price: { id: 'price_month' },
            current_period_start: 1_783_408_000, current_period_end: 1_786_100_000,
          }] },
        }), { status: 200 });
      },
    });
    assert.equal(authority?.subscription.status, 'canceled');
    assert.equal(authority?.subscription.plan.id, 'litos_plus_month');
    assert.equal(authority?.subscription.currentPeriodStart?.toISOString(), new Date(1_783_408_000_000).toISOString());
    assert.equal(authority?.subscription.accessEndsAt?.toISOString(), new Date(1_786_100_000_000).toISOString());
  });

  test('rejects authoritative billing state when provider ownership does not match the signed event', async () => {
    const parsed = parseStripeBillingEvent({
      id: 'evt_invoice_customer_mismatch', type: 'invoice.paid', created: 1_786_000_000, livemode: true,
      data: { object: {
        id: 'in_customer_mismatch', customer: 'cus_expected', subscription: 'sub_customer_mismatch',
        lines: { data: [{ price: { id: 'price_month' } }] },
      } },
    });
    assert.ok(parsed);
    const authority = await retrieveStripeBillingAuthority({
      event: parsed,
      fetchImpl: async (url) => String(url).includes('/invoices/')
        ? new Response(JSON.stringify({
          id: 'in_customer_mismatch', customer: 'cus_other', subscription: 'sub_customer_mismatch',
          lines: { data: [{ price: { id: 'price_month' } }] },
        }), { status: 200 })
        : new Response(JSON.stringify({
          id: 'sub_customer_mismatch', customer: 'cus_other', status: 'active',
          items: { data: [{
            quantity: 1,
            price: { id: 'price_month' },
            current_period_end: 1_788_592_000,
          }] },
        }), { status: 200 }),
    });
    assert.equal(authority, null);
  });

  test('rejects a current provider subscription outside the Litos+ price catalog', async () => {
    const parsed = parseStripeBillingEvent({
      id: 'evt_subscription_unknown_price', type: 'customer.subscription.updated', created: 1_786_000_000, livemode: true,
      data: { object: {
        id: 'sub_unknown_price', customer: 'cus_1', status: 'active',
        items: { data: [{ price: { id: 'price_unknown' }, current_period_end: 1_788_592_000 }] },
      } },
    });
    assert.ok(parsed);
    const authority = await retrieveStripeBillingAuthority({
      event: parsed,
      fetchImpl: async () => new Response(JSON.stringify({
        id: 'sub_unknown_price', customer: 'cus_1', status: 'active',
        items: { data: [{
          quantity: 1,
          price: { id: 'price_unknown' },
          current_period_end: 1_788_592_000,
        }] },
      }), { status: 200 }),
    });
    assert.equal(authority, null);
  });

  test('retrieves the current dispute, charge, invoice, and subscription before resolving access', async () => {
    const parsed = parseStripeBillingEvent({
      id: 'evt_dispute_late', type: 'charge.dispute.created', created: 1_786_000_000, livemode: true,
      data: { object: { id: 'dp_late', charge: 'ch_late', status: 'needs_response' } },
    });
    assert.ok(parsed);
    const requested: string[] = [];
    const authority = await retrieveStripeBillingAuthority({
      event: parsed,
      fetchImpl: async (url) => {
        requested.push(String(url));
        if (String(url).includes('/disputes/')) {
          return new Response(JSON.stringify({ id: 'dp_late', charge: 'ch_late', status: 'won' }), { status: 200 });
        }
        if (String(url).includes('/charges/')) {
          return new Response(JSON.stringify({
            id: 'ch_late', customer: 'cus_1', invoice: 'in_late_dispute', amount: 3999, amount_refunded: 0,
          }), { status: 200 });
        }
        if (String(url).includes('/invoices/')) {
          return new Response(JSON.stringify({
            id: 'in_late_dispute', customer: 'cus_1',
            parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_late_dispute' } },
            lines: { data: [{ pricing: { price_details: { price: 'price_month' } } }] },
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          id: 'sub_late_dispute', customer: 'cus_1', status: 'active',
          items: { data: [{
            quantity: 1, price: { id: 'price_month' },
            current_period_start: 1_786_000_000, current_period_end: 1_788_592_000,
          }] },
        }), { status: 200 });
      },
    });
    assert.equal(authority?.disputeOutcome, 'won');
    assert.equal(authority?.subscription.status, 'active');
    assert.deepEqual(requested.map((url) => new URL(url).pathname), [
      '/v1/disputes/dp_late',
      '/v1/charges/ch_late',
      '/v1/invoices/in_late_dispute',
      '/v1/subscriptions/sub_late_dispute',
    ]);
  });

  test('resolves a dispute charge through its invoice to the subscription', async () => {
    const context = await retrieveStripeChargeBillingContext({
      chargeId: 'ch_1',
      fetchImpl: async (url) => {
        if (String(url).includes('/charges/')) {
          return new Response(JSON.stringify({
            id: 'ch_1', customer: 'cus_1', invoice: 'in_1', payment_intent: 'pi_1',
          }), { status: 200 });
        }
        return new Response(JSON.stringify({ id: 'in_1', subscription: 'sub_1' }), { status: 200 });
      },
    });
    assert.deepEqual(context, {
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
      invoiceId: 'in_1',
      paymentIntentId: 'pi_1',
    });
  });

  test('fails a refunded-subscription operation when Stripe cancellation does not succeed', async () => {
    await assert.rejects(cancelStripeSubscriptionOrThrow({
      subscriptionId: 'sub_refunded',
      idempotencyKey: 'stripe:evt_refund',
      fetchImpl: async (_url, init) => {
        assert.equal((init?.headers as Record<string, string>)['idempotency-key'], 'stripe:evt_refund');
        return new Response(JSON.stringify({ error: { message: 'temporary failure' } }), { status: 500 });
      },
    }), /cancellation failed/);
  });

  test('accepts safe legacy Lemon Squeezy portals and rejects unrelated provider paths', () => {
    assert.equal(
      secureLegacyBillingPortalUrl('https://litos.lemonsqueezy.com/billing'),
      'https://litos.lemonsqueezy.com/billing',
    );
    assert.equal(
      secureLegacyBillingPortalUrl('https://app.lemonsqueezy.com/my-orders/abc'),
      'https://app.lemonsqueezy.com/my-orders/abc',
    );
    assert.equal(secureLegacyBillingPortalUrl('https://litos.lemonsqueezy.com/checkout'), null);
    assert.equal(secureLegacyBillingPortalUrl('https://lemonsqueezy.example/billing'), null);
  });
});
