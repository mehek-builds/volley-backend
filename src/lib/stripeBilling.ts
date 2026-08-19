import { createHash } from 'node:crypto';
import {
  type BillingCatalogPlan,
  type LitosPlanId,
  billingPlan,
  billingPlanForPriceId,
  stripePriceIdForPlan,
  validateStripePriceFact,
} from './billingCatalog';
import { secureStripeCheckoutUrl, secureStripePortalUrl } from './stripeAcquiring';

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function returnUrl(kind: 'success' | 'cancel', input: {
  surface: string;
  offerId: string;
  actionNonce?: string | null;
}): string {
  const configured = env(kind === 'success' ? 'LITOS_BILLING_SUCCESS_URL' : 'LITOS_BILLING_CANCEL_URL')
    ?? env(kind === 'success' ? 'LITOS_PAY_SUCCESS_URL' : 'LITOS_PAY_CANCEL_URL');
  const base = configured ?? (kind === 'success'
    ? 'https://trylitos.com/billing/return?session_id={CHECKOUT_SESSION_ID}'
    : 'https://trylitos.com/billing/return?status=cancelled');
  const url = new URL(base);
  url.searchParams.set('surface', input.surface);
  url.searchParams.set('context', input.offerId);
  url.searchParams.set('status', kind === 'success' ? 'success' : 'cancelled');
  if (input.actionNonce) url.searchParams.set('action_nonce', input.actionNonce);
  else url.searchParams.delete('action_nonce');
  if (kind === 'success' && !url.searchParams.has('session_id') && !url.toString().includes('{CHECKOUT_SESSION_ID}')) {
    url.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  }
  return url.toString().replaceAll('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}');
}

export type StripeCheckoutV2 = {
  id: string;
  url: string;
  customerId: string | null;
  subscriptionId: string | null;
  expiresAt: Date;
};

export async function createStripeCheckoutSessionV2(input: {
  offerId: string;
  userId: string;
  email: string;
  planId: LitosPlanId;
  idempotencyKey: string;
  actionId?: string | null;
  actionNonce?: string | null;
  surface?: 'website' | 'dashboard' | 'extension' | 'api';
  existingCustomerId?: string | null;
  expiresAt: Date;
  /** Days of Stripe trial to attach. Omit or pass 0 to charge immediately. */
  trialDays?: number | null;
  fetchImpl?: typeof fetch;
}): Promise<StripeCheckoutV2 | null> {
  const secretKey = env('STRIPE_SECRET_KEY');
  const priceId = stripePriceIdForPlan(input.planId);
  const plan = billingPlan(input.planId);
  if (!secretKey || !priceId || !plan) return null;
  const stripeFetch = input.fetchImpl ?? fetch;
  // An environment variable is only an identifier. Read the live Stripe Price before every new
  // checkout so a dashboard mistake cannot silently sell the wrong amount or recurrence.
  const priceResponse = await stripeFetch(`https://api.stripe.com/v1/prices/${encodeURIComponent(priceId)}`, {
    headers: { authorization: `Bearer ${secretKey}` },
  });
  if (!priceResponse.ok) return null;
  const price = await priceResponse.json() as Record<string, any>;
  const priceIssues = validateStripePriceFact(plan, {
    id: scalar(price.id) ?? '',
    active: price.active === true,
    currency: scalar(price.currency) ?? '',
    unit_amount: typeof price.unit_amount === 'number' ? price.unit_amount : null,
    recurring: price.recurring && typeof price.recurring === 'object'
      ? {
        interval: scalar(price.recurring.interval) ?? '',
        interval_count: typeof price.recurring.interval_count === 'number' ? price.recurring.interval_count : 0,
      }
      : null,
  });
  if (price.id !== priceId || priceIssues.length > 0) return null;
  const expiresAtSeconds = Math.floor(input.expiresAt.getTime() / 1000);
  const nowSeconds = Math.floor(Date.now() / 1000);
  // The route creates this boundary 31 minutes ahead so the first POST meets Stripe's 30-minute
  // minimum. A crash retry must send the identical timestamp even when less than 30 minutes
  // remain, allowing Stripe's idempotency cache to return the already-created Session.
  if (!Number.isFinite(expiresAtSeconds)
    || expiresAtSeconds <= nowSeconds
    || expiresAtSeconds > nowSeconds + 24 * 60 * 60) return null;
  const body = new URLSearchParams();
  body.set('mode', 'subscription');
  body.set('client_reference_id', input.offerId);
  if (input.existingCustomerId?.startsWith('cus_')) body.set('customer', input.existingCustomerId);
  else body.set('customer_email', input.email.trim().toLowerCase());
  body.set('line_items[0][price]', priceId);
  body.set('line_items[0][quantity]', '1');
  body.set('expires_at', String(expiresAtSeconds));
  const returnContext = {
    surface: input.surface ?? 'dashboard',
    offerId: input.offerId,
    actionNonce: input.actionNonce,
  };
  body.set('success_url', returnUrl('success', returnContext));
  body.set('cancel_url', returnUrl('cancel', returnContext));
  const metadata: Record<string, string> = {
    litos_user_id: input.userId,
    litos_offer_id: input.offerId,
    litos_product_code: 'litos_plus',
    litos_term_code: plan.term,
    litos_plan_id: plan.id,
    litos_policy_version: 'litos-entitlements-v2',
    ...(input.actionId ? { litos_action_id: input.actionId } : {}),
  };
  for (const [key, value] of Object.entries(metadata)) {
    body.set(`metadata[${key}]`, value);
    body.set(`subscription_data[metadata][${key}]`, value);
  }
  body.set('allow_promotion_codes', 'true');
  /* The trial moved here from signup. It used to be seven days written onto the
     user row by whichever route created the account, which granted Litos+
     against no payment method; it is now a Stripe trial on a real subscription,
     so the card is collected before the trial starts and the subscription
     converts on its own when the trial ends.
     `payment_method_collection=always` is the half that does the actual work:
     without it Stripe SKIPS card collection whenever a trial makes the first
     invoice $0, which would put us straight back to a card-free trial through a
     different door. A first-time buyer only gets the trial days; someone who
     already spent a trial is charged immediately, which is what the
     once-per-account gate in routes/billing.ts decides before calling this. */
  if (input.trialDays && input.trialDays > 0) {
    body.set('subscription_data[trial_period_days]', String(Math.floor(input.trialDays)));
  }
  body.set('payment_method_collection', 'always');
  if (env('STRIPE_AUTOMATIC_TAX_ENABLED') === 'true') body.set('automatic_tax[enabled]', 'true');
  const response = await stripeFetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
      'idempotency-key': `litos-checkout:${input.userId}:${input.idempotencyKey}`,
    },
    body,
  });
  if (!response.ok) return null;
  const session = await response.json() as Record<string, unknown>;
  const id = typeof session.id === 'string' ? session.id : null;
  const url = secureStripeCheckoutUrl(session.url);
  const expires = unixDate(session.expires_at);
  if (!id || !url || !expires || expires.getTime() !== expiresAtSeconds * 1000) return null;
  return {
    id,
    url,
    customerId: typeof session.customer === 'string' ? session.customer : null,
    subscriptionId: typeof session.subscription === 'string' ? session.subscription : null,
    expiresAt: expires,
  };
}

export async function cancelStripeSubscription(input: {
  subscriptionId: string;
  idempotencyKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const secretKey = env('STRIPE_SECRET_KEY');
  if (!secretKey || !input.subscriptionId.startsWith('sub_')) return false;
  const response = await (input.fetchImpl ?? fetch)(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(input.subscriptionId)}`, {
    method: 'DELETE',
    headers: {
      authorization: `Bearer ${secretKey}`,
      ...(input.idempotencyKey ? { 'idempotency-key': input.idempotencyKey } : {}),
    },
  });
  return response.ok;
}

export async function cancelStripeSubscriptionOrThrow(input: {
  subscriptionId: string;
  idempotencyKey: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!(await cancelStripeSubscription(input))) {
    throw new Error('Stripe subscription cancellation failed');
  }
}

function scalar(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function unixDate(value: unknown): Date | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

function metadata(object: any): Record<string, unknown> {
  return object?.metadata && typeof object.metadata === 'object' ? object.metadata : {};
}

function subscriptionIdFrom(object: any): string | null {
  const parentSubscription = object?.parent?.type === 'subscription_details'
    ? scalar(object?.parent?.subscription_details?.subscription?.id)
      || scalar(object?.parent?.subscription_details?.subscription)
    : null;
  return scalar(object?.subscription?.id) || scalar(object?.subscription)
    || parentSubscription
    || scalar(object?.invoice?.subscription?.id) || scalar(object?.invoice?.subscription);
}

function firstPrice(object: any): { id: string | null; plan: BillingCatalogPlan | null } {
  const item = Array.isArray(object?.items?.data)
    ? object.items.data[0]
    : Array.isArray(object?.lines?.data)
      ? object.lines.data[0]
      : null;
  // Stripe invoice line shapes vary by API version. Accept only a concrete Price identifier, then
  // bind it back to the server catalog below. No amount or interval from the event is trusted.
  const id = scalar(item?.price?.id)
    || scalar(item?.price)
    || scalar(item?.pricing?.price_details?.price?.id)
    || scalar(item?.pricing?.price_details?.price);
  return { id, plan: billingPlanForPriceId(id) };
}

export type StripeBillingEvent = {
  eventKey: string;
  eventId: string;
  eventName: string;
  livemode: boolean;
  createdAt: Date;
  payloadSha256: string;
  providerObjectId: string | null;
  userId: string | null;
  offerId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  priceId: string | null;
  plan: BillingCatalogPlan | null;
  status: string | null;
  paymentStatus: string | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  accessEndsAt: Date | null;
  invoiceId: string | null;
  paymentIntentId: string | null;
  chargeId: string | null;
  amount: number | null;
  amountRefunded: number | null;
  disputeOutcome: string | null;
};

export function parseStripeBillingEvent(payload: unknown, rawBody?: Buffer): StripeBillingEvent | null {
  if (!payload || typeof payload !== 'object') return null;
  const envelope = payload as Record<string, any>;
  const eventId = scalar(envelope.id);
  const eventName = scalar(envelope.type);
  const object = envelope.data?.object;
  const createdAt = unixDate(envelope.created);
  if (!eventId || !eventName || !object || !createdAt) return null;
  const supported = new Set([
    'checkout.session.completed',
    'checkout.session.async_payment_succeeded',
    'checkout.session.async_payment_failed',
    'customer.subscription.created',
    'customer.subscription.updated',
    'customer.subscription.deleted',
    'invoice.paid',
    'invoice.payment_failed',
    'invoice.payment_action_required',
    'charge.refunded',
    'charge.dispute.created',
    'charge.dispute.closed',
  ]);
  if (!supported.has(eventName)) return null;

  const isSubscription = eventName.startsWith('customer.subscription.');
  const isCheckout = eventName.startsWith('checkout.session.');
  const isInvoice = eventName.startsWith('invoice.');
  const isRefund = eventName === 'charge.refunded';
  const isDispute = eventName.startsWith('charge.dispute.');
  const subscription = isSubscription ? object : null;
  const objectMetadata = metadata(object);
  const price = firstPrice(isSubscription || isInvoice ? object : null);
  const planId = scalar(objectMetadata.litos_plan_id);
  const plan = price.plan ?? billingPlan(planId);
  const status = isSubscription
    ? scalar(object.status)
    : isInvoice
      ? eventName === 'invoice.paid' ? 'active' : 'past_due'
      : isRefund
        ? (object.refunded === true ? 'refunded' : null)
        : isDispute
          ? eventName === 'charge.dispute.created' ? 'disputed' : null
          : null;
  const periodEnd = unixDate(subscription?.current_period_end)
    ?? (Array.isArray(subscription?.items?.data) ? unixDate(subscription.items.data[0]?.current_period_end) : null)
    ?? (isInvoice && Array.isArray(object?.lines?.data) ? unixDate(object.lines.data[0]?.period?.end) : null);
  const periodStart = unixDate(subscription?.current_period_start)
    ?? (Array.isArray(subscription?.items?.data) ? unixDate(subscription.items.data[0]?.current_period_start) : null)
    ?? (isInvoice && Array.isArray(object?.lines?.data) ? unixDate(object.lines.data[0]?.period?.start) : null);
  const cancelAt = unixDate(subscription?.cancel_at);
  const endedAt = unixDate(subscription?.ended_at);
  const invoiceFailureBoundary = isInvoice && eventName !== 'invoice.paid' ? createdAt : null;
  const charge = isDispute ? object?.charge : object;
  const subscriptionId = isSubscription ? scalar(object.id) : subscriptionIdFrom(object);
  return {
    eventKey: `stripe:${eventId}`,
    eventId,
    eventName,
    livemode: envelope.livemode === true,
    createdAt,
    payloadSha256: createHash('sha256').update(rawBody ?? Buffer.from(JSON.stringify(payload))).digest('hex'),
    providerObjectId: scalar(object.id),
    userId: scalar(objectMetadata.litos_user_id) || scalar(objectMetadata.user_id),
    offerId: scalar(objectMetadata.litos_offer_id) || scalar(objectMetadata.litos_intent_id) || scalar(object.client_reference_id),
    customerId: scalar(object.customer?.id) || scalar(object.customer),
    subscriptionId,
    priceId: price.id,
    plan,
    status,
    paymentStatus: scalar(object.payment_status),
    cancelAtPeriodEnd: subscription?.cancel_at_period_end === true,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    accessEndsAt: invoiceFailureBoundary
      ?? (subscription?.cancel_at_period_end === true ? cancelAt ?? periodEnd : endedAt),
    invoiceId: isInvoice ? scalar(object.id) : scalar(object.invoice),
    paymentIntentId: isInvoice
      ? invoicePaymentIntentId(object)
      : scalar(object.payment_intent?.id) || scalar(object.payment_intent),
    chargeId: isDispute ? scalar(object.charge?.id) || scalar(object.charge) : scalar(charge?.id),
    amount: typeof charge?.amount === 'number' ? charge.amount : null,
    amountRefunded: typeof charge?.amount_refunded === 'number' ? charge.amount_refunded : null,
    disputeOutcome: scalar(object.status),
  };
}

export type StripeChargeBillingContext = {
  customerId: string | null;
  subscriptionId: string | null;
  invoiceId: string | null;
  paymentIntentId: string | null;
};

export type StripeSubscriptionAuthority = {
  userId: string | null;
  offerId: string | null;
  customerId: string;
  subscriptionId: string;
  priceId: string;
  plan: BillingCatalogPlan;
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  accessEndsAt: Date | null;
};

export type StripeBillingAuthority = {
  subscription: StripeSubscriptionAuthority;
  invoiceId: string | null;
  paymentIntentId: string | null;
  chargeId: string | null;
  amount: number | null;
  amountRefunded: number | null;
  disputeOutcome: string | null;
};

function firstSubscriptionItem(object: any): any | null {
  return Array.isArray(object?.items?.data) ? object.items.data[0] ?? null : null;
}

function providerSubscription(object: any): StripeSubscriptionAuthority | null {
  const subscriptionId = scalar(object?.id);
  const customerId = scalar(object?.customer?.id) || scalar(object?.customer);
  const status = scalar(object?.status);
  const item = firstSubscriptionItem(object);
  const priceId = scalar(item?.price?.id) || scalar(item?.price);
  const plan = billingPlanForPriceId(priceId);
  const subscriptionMetadata = metadata(object);
  const supportedStatuses = new Set([
    'trialing', 'active', 'past_due', 'paused', 'unpaid', 'canceled',
    'incomplete', 'incomplete_expired',
  ]);
  if (!subscriptionId?.startsWith('sub_') || !customerId?.startsWith('cus_') || !status || !priceId || !plan) {
    return null;
  }
  if (!supportedStatuses.has(status)) return null;
  if (Array.isArray(object?.items?.data) && object.items.data.length !== 1) return null;
  if (typeof item?.quantity === 'number' && item.quantity !== 1) return null;
  const currentPeriodStart = unixDate(object?.current_period_start) ?? unixDate(item?.current_period_start);
  const currentPeriodEnd = unixDate(object?.current_period_end) ?? unixDate(item?.current_period_end);
  if (['trialing', 'active', 'past_due', 'paused'].includes(status) && !currentPeriodEnd) return null;
  const cancelAt = unixDate(object?.cancel_at);
  const canceledAt = unixDate(object?.canceled_at);
  const endedAt = unixDate(object?.ended_at);
  const cancelAtPeriodEnd = object?.cancel_at_period_end === true;
  const accessEndsAt = status === 'canceled' || status === 'expired' || status === 'incomplete_expired'
    ? endedAt ?? canceledAt ?? currentPeriodEnd
    : cancelAtPeriodEnd || status === 'paused'
      ? cancelAt ?? currentPeriodEnd
      : null;
  return {
    userId: scalar(subscriptionMetadata.litos_user_id) || scalar(subscriptionMetadata.user_id),
    offerId: scalar(subscriptionMetadata.litos_offer_id) || scalar(subscriptionMetadata.litos_intent_id),
    customerId,
    subscriptionId,
    priceId,
    plan,
    status,
    cancelAtPeriodEnd,
    currentPeriodStart,
    currentPeriodEnd,
    accessEndsAt,
  };
}

function invoiceLinePriceIds(object: any): string[] {
  if (!Array.isArray(object?.lines?.data)) return [];
  return object.lines.data.flatMap((item: any) => {
    const priceId = scalar(item?.price?.id)
      || scalar(item?.price)
      || scalar(item?.pricing?.price_details?.price?.id)
      || scalar(item?.pricing?.price_details?.price);
    return priceId ? [priceId] : [];
  });
}

function invoicePaymentIntentId(object: any): string | null {
  const direct = scalar(object?.payment_intent?.id) || scalar(object?.payment_intent);
  if (direct) return direct;
  if (!Array.isArray(object?.payments?.data)) return null;
  for (const payment of object.payments.data) {
    const paymentIntentId = scalar(payment?.payment?.payment_intent?.id)
      || scalar(payment?.payment?.payment_intent);
    if (paymentIntentId) return paymentIntentId;
  }
  return null;
}

async function stripeRetrieveObject(input: {
  kind: 'subscriptions' | 'invoices' | 'charges' | 'disputes' | 'checkout/sessions';
  id: string;
  fetchImpl: typeof fetch;
  secretKey: string;
}): Promise<Record<string, any> | null> {
  const response = await input.fetchImpl(
    `https://api.stripe.com/v1/${input.kind}/${encodeURIComponent(input.id)}`,  // kind is a fixed literal, never user input
    { headers: { authorization: `Bearer ${input.secretKey}` } },
  );
  if (!response.ok) return null;
  const value = await response.json();
  return value && typeof value === 'object' ? value as Record<string, any> : null;
}

/**
 * The authoritative read behind checkout reconciliation.
 *
 * WHY THIS EXISTS AT ALL. Everything that records a purchase used to arrive by
 * webhook, and a webhook is best effort: it can lag the browser redirect by
 * seconds, it can be retried for minutes after a 5xx, and if its signing secret
 * is wrong it never lands at all. Meanwhile the student is already back on the
 * site, having just handed over a card, being asked to buy the thing they just
 * bought. So the return path stops waiting to be told and asks Stripe directly.
 *
 * The session is retrieved rather than trusted from the URL: `session_id` comes
 * back through the browser, so it is attacker-supplied until Stripe confirms it.
 * The caller still has to bind it to an account -- this returns the raw pair and
 * refuses to guess whose they are.
 *
 * Null means "nothing to reconcile", not "error": an abandoned or expired
 * session is the ordinary case and must not read as a failure.
 */
export async function retrieveStripeCheckoutForReconcile(input: {
  sessionId: string;
  fetchImpl?: typeof fetch;
}): Promise<{ session: Record<string, any>; subscription: Record<string, any> } | null> {
  const secretKey = env('STRIPE_SECRET_KEY');
  if (!secretKey || !input.sessionId.startsWith('cs_')) return null;
  const stripeFetch = input.fetchImpl ?? fetch;
  const session = await stripeRetrieveObject({
    kind: 'checkout/sessions', id: input.sessionId, fetchImpl: stripeFetch, secretKey,
  });
  if (!session || scalar(session.id) !== input.sessionId) return null;
  // Only a finished session may move an account. `open` is still in progress and
  // `expired` never completed.
  if (scalar(session.status) !== 'complete') return null;
  const subscriptionId = scalar(session.subscription?.id) || scalar(session.subscription);
  if (!subscriptionId?.startsWith('sub_')) return null;
  const subscription = await stripeRetrieveObject({
    kind: 'subscriptions', id: subscriptionId, fetchImpl: stripeFetch, secretKey,
  });
  if (!subscription || scalar(subscription.id) !== subscriptionId) return null;
  return { session, subscription };
}

export async function retrieveStripeBillingAuthority(input: {
  event: StripeBillingEvent;
  fetchImpl?: typeof fetch;
}): Promise<StripeBillingAuthority | null> {
  const secretKey = env('STRIPE_SECRET_KEY');
  if (!secretKey) return null;
  const stripeFetch = input.fetchImpl ?? fetch;
  const event = input.event;
  const isInvoice = event.eventName.startsWith('invoice.');
  const isDispute = event.eventName.startsWith('charge.dispute.');
  const isCharge = event.eventName === 'charge.refunded' || isDispute;
  let subscriptionId = event.subscriptionId;
  let invoiceId = event.invoiceId;
  let paymentIntentId = event.paymentIntentId;
  let chargeId = event.chargeId;
  let invoice: Record<string, any> | null = null;
  let charge: Record<string, any> | null = null;
  let dispute: Record<string, any> | null = null;

  // An invoice event must identify its subscription in the signed event. This prevents a
  // customer-only fallback from ever projecting the invoice onto an unrelated replacement.
  if (isInvoice && (!subscriptionId?.startsWith('sub_') || !invoiceId?.startsWith('in_'))) return null;

  if (isDispute) {
    const disputeId = event.providerObjectId;
    if (!disputeId?.startsWith('dp_')) return null;
    dispute = await stripeRetrieveObject({ kind: 'disputes', id: disputeId, fetchImpl: stripeFetch, secretKey });
    if (!dispute || scalar(dispute.id) !== disputeId || !scalar(dispute.status)) return null;
    const disputeChargeId = scalar(dispute.charge?.id) || scalar(dispute.charge);
    if (!disputeChargeId?.startsWith('ch_')) return null;
    if (chargeId && chargeId !== disputeChargeId) return null;
    chargeId = disputeChargeId;
  }

  if (isCharge) {
    if (!chargeId?.startsWith('ch_')) return null;
    charge = await stripeRetrieveObject({ kind: 'charges', id: chargeId, fetchImpl: stripeFetch, secretKey });
    if (!charge || scalar(charge.id) !== chargeId) return null;
    const chargeInvoiceId = scalar(charge.invoice?.id) || scalar(charge.invoice);
    if (!chargeInvoiceId?.startsWith('in_')) return null;
    if (invoiceId && invoiceId !== chargeInvoiceId) return null;
    invoiceId = chargeInvoiceId;
    paymentIntentId = scalar(charge.payment_intent?.id) || scalar(charge.payment_intent) || paymentIntentId;
  }

  if (isInvoice || isCharge) {
    if (!invoiceId?.startsWith('in_')) return null;
    invoice = await stripeRetrieveObject({ kind: 'invoices', id: invoiceId, fetchImpl: stripeFetch, secretKey });
    if (!invoice || scalar(invoice.id) !== invoiceId) return null;
    const invoiceSubscriptionId = subscriptionIdFrom(invoice);
    if (!invoiceSubscriptionId?.startsWith('sub_')) return null;
    if (subscriptionId && subscriptionId !== invoiceSubscriptionId) return null;
    subscriptionId = invoiceSubscriptionId;
    paymentIntentId = invoicePaymentIntentId(invoice) ?? paymentIntentId;
  }

  if (!subscriptionId?.startsWith('sub_')) return null;
  const subscriptionObject = await stripeRetrieveObject({
    kind: 'subscriptions',
    id: subscriptionId,
    fetchImpl: stripeFetch,
    secretKey,
  });
  const subscription = subscriptionObject ? providerSubscription(subscriptionObject) : null;
  if (!subscription || subscription.subscriptionId !== subscriptionId) return null;
  if (event.customerId && event.customerId !== subscription.customerId) return null;
  if (event.userId && subscription.userId && event.userId !== subscription.userId) return null;
  if (event.offerId && subscription.offerId && event.offerId !== subscription.offerId) return null;

  if (invoice) {
    const invoiceCustomerId = scalar(invoice.customer?.id) || scalar(invoice.customer);
    if (!invoiceCustomerId || invoiceCustomerId !== subscription.customerId) return null;
    const invoicePrices = invoiceLinePriceIds(invoice);
    if (invoicePrices.length > 0 && !invoicePrices.includes(subscription.priceId)) return null;
  }
  if (charge) {
    const chargeCustomerId = scalar(charge.customer?.id) || scalar(charge.customer);
    if (!chargeCustomerId || chargeCustomerId !== subscription.customerId) return null;
  }

  return {
    subscription,
    invoiceId,
    paymentIntentId,
    chargeId,
    amount: charge && typeof charge.amount === 'number' ? charge.amount : event.amount,
    amountRefunded: charge && typeof charge.amount_refunded === 'number'
      ? charge.amount_refunded
      : event.amountRefunded,
    disputeOutcome: dispute ? scalar(dispute.status) : event.disputeOutcome,
  };
}

export async function retrieveStripeChargeBillingContext(input: {
  chargeId: string;
  fetchImpl?: typeof fetch;
}): Promise<StripeChargeBillingContext | null> {
  const secretKey = env('STRIPE_SECRET_KEY');
  if (!secretKey || !input.chargeId.startsWith('ch_')) return null;
  const stripeFetch = input.fetchImpl ?? fetch;
  const headers = { authorization: `Bearer ${secretKey}` };
  const chargeResponse = await stripeFetch(
    `https://api.stripe.com/v1/charges/${encodeURIComponent(input.chargeId)}`,
    { headers },
  );
  if (!chargeResponse.ok) return null;
  const charge = await chargeResponse.json() as Record<string, any>;
  const invoiceId = scalar(charge.invoice?.id) || scalar(charge.invoice);
  let subscriptionId = subscriptionIdFrom(charge);
  if (!subscriptionId && invoiceId?.startsWith('in_')) {
    const invoiceResponse = await stripeFetch(
      `https://api.stripe.com/v1/invoices/${encodeURIComponent(invoiceId)}`,
      { headers },
    );
    if (invoiceResponse.ok) {
      const invoice = await invoiceResponse.json() as Record<string, any>;
      subscriptionId = subscriptionIdFrom(invoice);
    }
  }
  return {
    customerId: scalar(charge.customer?.id) || scalar(charge.customer),
    subscriptionId,
    invoiceId,
    paymentIntentId: scalar(charge.payment_intent?.id) || scalar(charge.payment_intent),
  };
}

export function secureLegacyBillingPortalUrl(value: unknown): string | null {
  const stripe = secureStripePortalUrl(value);
  if (stripe) return stripe;
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return null;
    if (url.port && url.port !== '443') return null;
    if (url.hostname === 'app.lemonsqueezy.com' || url.hostname === 'store.lemonsqueezy.com') {
      return url.toString();
    }
    const providerSubdomain = url.hostname === 'lemonsqueezy.com' || url.hostname.endsWith('.lemonsqueezy.com');
    const safeStorePath = url.pathname === '/billing' || url.pathname.startsWith('/billing/');
    if (!providerSubdomain || !safeStorePath) return null;
    return url.toString();
  } catch {
    return null;
  }
}
