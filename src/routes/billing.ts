import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/index';
import { billing_webhook_events, pricing_offers, users } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { getEntitlements, getCount, monthPeriod, upgradeUrl } from '../middleware/quota';
import {
  buildLitosCheckoutIntent,
  eventFromPaidCheckout,
  litosProcessorConfigured,
  litosProcessorTrialConfigured,
  parseLitosCheckoutToken,
} from '../lib/litosPayCore';
import {
  createStripePortalSession,
  createStripeCheckoutSession,
  parseStripeCheckoutCompleted,
  parseStripeSubscriptionChanged,
  secureStripeCheckoutUrl,
  stripeAcquiringConfigured,
  stripePriceIdForInterval,
  stripeRequiresLivemode,
  verifyStripeWebhookSignature,
} from '../lib/stripeAcquiring';
import {
  buildLemonSqueezyCheckoutUrl,
  lemonSqueezyCheckoutReadyUrl,
  parseLemonSqueezySubscription,
  planForLemonSqueezyStatus,
  verifyLemonSqueezySignature,
  verifyLemonSqueezyAccountToken,
} from '../lib/lemonSqueezy';

type CheckoutBody = {
  interval?: 'weekly' | 'monthly';
};

type LitosTrialBody = {
  token?: string;
};

type LitosCheckoutParams = {
  intentId: string;
};

type LitosCheckoutQuery = {
  token?: string;
};

function jsonBody<T extends Record<string, unknown>>(body: unknown): Partial<T> {
  if (!Buffer.isBuffer(body)) return body && typeof body === 'object' ? body as Partial<T> : {};
  try {
    const parsed = JSON.parse(body.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed as Partial<T> : {};
  } catch {
    return {};
  }
}

async function createLitosCheckoutOffer(input: {
  userId: string;
  email: string;
  interval: unknown;
}) {
  const intent = buildLitosCheckoutIntent(input);
  if (!intent) return null;
  const stripeSession = stripeAcquiringConfigured()
    ? await createStripeCheckoutSession({
      intentId: intent.intentId,
      userId: input.userId,
      email: input.email,
      interval: intent.interval,
    })
    : null;
  if (stripeAcquiringConfigured() && !stripeSession) return null;
  await db.insert(pricing_offers).values({
    id: intent.intentId,
    user_id: input.userId,
    subject_id: input.email.trim().toLowerCase(),
    idempotency_key: `litos:${intent.intentId}`,
    policy_version: 'litos-pay-core-v1',
    country_code: 'US',
    band: 'standard',
    experiment_variant: 'control',
    billing_interval: intent.interval,
    currency: intent.currency,
    base_amount_cents: intent.amountCents,
    amount_cents: intent.amountCents,
    status: stripeSession ? 'stripe_checkout_created' : 'checkout_created',
    provider_checkout_id: stripeSession?.id ?? intent.intentId,
    provider_checkout_url: stripeSession?.url ?? intent.url,
    provider_customer_id: stripeSession?.customerId ?? undefined,
    provider_subscription_id: stripeSession?.subscriptionId ?? undefined,
    expires_at: intent.expiresAt,
    checkout_created_at: new Date(),
  });
  return intent;
}

async function applyLitosPaidCheckout(token: string) {
  const event = eventFromPaidCheckout(token);
  if (!event) return null;
  let processed = false;
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(billing_webhook_events).values({
      event_key: event.eventKey,
      provider: 'litos',
      event_name: event.eventName,
      result: 'processed',
      processed_at: event.happenedAt,
    }).onConflictDoNothing().returning({ event_key: billing_webhook_events.event_key });
    if (inserted.length === 0) return;
    processed = true;
    await tx.update(pricing_offers).set({
      status: 'paid',
      provider_customer_id: event.customerId,
      provider_subscription_id: event.subscriptionId,
      paid_at: event.happenedAt,
      verified_at: event.happenedAt,
      updated_at: event.happenedAt,
    }).where(eq(pricing_offers.id, event.eventKey.split(':')[1]));
    await tx.update(users).set({
      plan: event.plan,
      billing_provider: 'litos',
      billing_customer_id: event.customerId,
      billing_subscription_id: event.subscriptionId,
      billing_variant_id: event.interval,
      billing_status: event.status,
      billing_renews_at: event.renewsAt,
      billing_ends_at: event.endsAt,
      billing_portal_url: null,
      billing_event_updated_at: event.happenedAt,
    }).where(eq(users.id, event.userId));
  });
  return { ...event, processed };
}

async function applyStripePaidCheckout(event: NonNullable<ReturnType<typeof parseStripeCheckoutCompleted>>) {
  let processed = false;
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(billing_webhook_events).values({
      event_key: event.eventKey,
      provider: 'stripe',
      event_name: event.eventName,
      result: 'processed',
      processed_at: event.happenedAt,
    }).onConflictDoNothing().returning({ event_key: billing_webhook_events.event_key });
    if (inserted.length === 0) return;
    processed = true;
    await tx.update(pricing_offers).set({
      status: 'paid',
      provider_customer_id: event.customerId,
      provider_subscription_id: event.subscriptionId,
      paid_at: event.happenedAt,
      verified_at: event.happenedAt,
      updated_at: event.happenedAt,
    }).where(eq(pricing_offers.id, event.intentId));
    await tx.update(users).set({
      plan: event.plan,
      billing_provider: 'stripe',
      billing_customer_id: event.customerId,
      billing_subscription_id: event.subscriptionId,
      billing_variant_id: event.interval,
      billing_status: event.status,
      billing_renews_at: event.renewsAt,
      billing_ends_at: event.endsAt,
      billing_portal_url: null,
      billing_event_updated_at: event.happenedAt,
    }).where(eq(users.id, event.userId));
  });
  return { ...event, processed };
}

async function applyStripeSubscriptionChange(
  event: NonNullable<ReturnType<typeof parseStripeSubscriptionChanged>>,
  userId: string,
) {
  let processed = false;
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(billing_webhook_events).values({
      event_key: event.eventKey,
      provider: 'stripe',
      event_name: event.eventName,
      result: 'processed',
      processed_at: event.happenedAt,
    }).onConflictDoNothing().returning({ event_key: billing_webhook_events.event_key });
    if (inserted.length === 0) return;
    processed = true;
    await tx.update(users).set({
      plan: event.plan!,
      billing_provider: 'stripe',
      billing_customer_id: event.customerId,
      billing_subscription_id: event.subscriptionId,
      billing_variant_id: event.priceId,
      billing_status: event.status,
      billing_renews_at: event.renewsAt,
      billing_ends_at: event.endsAt,
      billing_portal_url: null,
      billing_event_updated_at: event.happenedAt,
    }).where(eq(users.id, userId));
  });
  return processed;
}

export async function billingRoutes(fastify: FastifyInstance) {
  fastify.get('/me', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId, email, isGuest } = request.jwtPayload!;
    const ent = await getEntitlements(userId);
    const period = monthPeriod();
    const [usedContacts, usedDrafts, usedResumes] = await Promise.all([
      getCount(userId, period, 'verified_contacts'),
      getCount(userId, period, 'drafts'),
      getCount(userId, period, 'resumes'),
    ]);
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    const upgradeLink = upgradeUrl();
    const stripeReady = litosProcessorConfigured()
      && (stripeAcquiringConfigured() || litosProcessorTrialConfigured());
    return reply.status(200).send({
      email: email ?? null,
      is_guest: isGuest,
      tier: ent.tier,
      trial_ends_at: user?.trial_ends_at ?? null,
      guest_expires_at: user?.guest_expires_at ?? null,
      billing_provider: user?.billing_provider ?? (stripeReady ? 'stripe' : 'lemonsqueezy'),
      checkout_available: stripeReady || Boolean(lemonSqueezyCheckoutReadyUrl()),
      billing_portal_available: user?.billing_provider === 'stripe'
        && Boolean(user.billing_customer_id)
        && stripeAcquiringConfigured(),
      billing_status: user?.billing_status ?? null,
      billing_renews_at: user?.billing_renews_at ?? null,
      billing_ends_at: user?.billing_ends_at ?? null,
      billing_portal_url: user?.billing_portal_url ?? null,
      usage: {
        contacts: { used: usedContacts, limit: ent.monthlyContacts },
        drafts: { used: usedDrafts, limit: ent.monthlyDrafts },
        resumes: { used: usedResumes, limit: ent.monthlyResumes },
      },
      ...(upgradeLink && ent.tier !== 'pro' ? { upgrade_url: upgradeLink } : {}),
    });
  });

  fastify.get('/billing/receipt', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId, isGuest } = request.jwtPayload!;
    if (isGuest) {
      return reply.status(409).send({ error: 'Verify an email before viewing billing receipts.', code: 'claim_required' });
    }
    const userRows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = userRows[0];
    if (!user?.billing_subscription_id) {
      return reply.status(404).send({ error: 'No paid subscription receipt is available.', code: 'billing_receipt_missing' });
    }
    const offerRows = await db.select({
      interval: pricing_offers.billing_interval,
      amountCents: pricing_offers.amount_cents,
      currency: pricing_offers.currency,
      paidAt: pricing_offers.paid_at,
      reference: pricing_offers.provider_checkout_id,
    }).from(pricing_offers).where(and(
      eq(pricing_offers.user_id, userId),
      eq(pricing_offers.provider_subscription_id, user.billing_subscription_id),
      eq(pricing_offers.status, 'paid'),
    )).limit(1);
    const offer = offerRows[0];
    if (!offer || (offer.interval !== 'weekly' && offer.interval !== 'monthly')) {
      return reply.status(404).send({ error: 'No paid subscription receipt is available.', code: 'billing_receipt_missing' });
    }
    return reply.header('Cache-Control', 'private, no-store').status(200).send({
      provider: user.billing_provider === 'stripe' ? 'stripe' : 'litos',
      plan: 'pro',
      interval: offer.interval,
      amount_cents: offer.amountCents,
      currency: offer.currency.toUpperCase(),
      paid_at: offer.paidAt,
      renews_at: user.billing_renews_at ?? null,
      reference: offer.reference ? offer.reference.slice(-12) : null,
    });
  });

  fastify.post<{ Body: CheckoutBody }>('/billing/checkout', { preHandler: requireAuth }, async (request, reply) => {
    const { userId, email, isGuest } = request.jwtPayload!;
    if (isGuest || !email) {
      return reply.status(409).send({ error: 'Verify an email before starting checkout.', code: 'claim_required' });
    }
    const ent = await getEntitlements(userId);
    if (ent.tier === 'pro') {
      return reply.status(409).send({ error: 'This account already has Pro.', code: 'already_pro' });
    }
    if (litosProcessorConfigured() && (stripeAcquiringConfigured() || litosProcessorTrialConfigured())) {
      const body = jsonBody<CheckoutBody>(request.body);
      const intent = await createLitosCheckoutOffer({ userId, email, interval: body.interval });
      if (!intent) {
        return reply.status(503).send({ error: 'Checkout is temporarily unavailable.', code: 'billing_not_configured' });
      }
      return reply.header('Cache-Control', 'private, no-store').status(200).send({
        provider: 'litos',
        url: intent.url,
        checkout_intent_id: intent.intentId,
        interval: intent.interval,
        amount_cents: intent.amountCents,
        currency: intent.currency,
      });
    }
    const url = buildLemonSqueezyCheckoutUrl(userId, email);
    if (!url) {
      return reply.status(503).send({ error: 'Checkout is temporarily unavailable.', code: 'billing_not_configured' });
    }
    return reply.header('Cache-Control', 'private, no-store').status(200).send({ provider: 'lemonsqueezy', url });
  });

  fastify.post('/billing/portal', { preHandler: requireAuth }, async (request, reply) => {
    const { userId, isGuest } = request.jwtPayload!;
    if (isGuest) {
      return reply.status(409).send({ error: 'Verify an email before managing billing.', code: 'claim_required' });
    }
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user || user.billing_provider !== 'stripe' || !user.billing_customer_id) {
      return reply.status(409).send({ error: 'No Stripe subscription is linked to this account.', code: 'billing_account_missing' });
    }
    const url = await createStripePortalSession({ customerId: user.billing_customer_id });
    if (!url) {
      return reply.status(503).send({ error: 'Billing portal is temporarily unavailable.', code: 'billing_portal_unavailable' });
    }
    return reply.header('Cache-Control', 'private, no-store').status(200).send({ provider: 'stripe', url });
  });

  fastify.post<{ Body: LitosTrialBody }>('/billing/litos-pay/test-trial', async (request, reply) => {
    if (process.env.NODE_ENV !== 'test' || !litosProcessorTrialConfigured()) {
      return reply.status(404).send({ error: 'not found' });
    }
    const body = jsonBody<LitosTrialBody>(request.body);
    const token = body.token;
    if (typeof token !== 'string') {
      return reply.status(400).send({ error: 'Missing checkout token.', code: 'missing_token' });
    }
    const event = await applyLitosPaidCheckout(token);
    if (!event) {
      return reply.status(400).send({ error: 'Invalid or expired checkout token.', code: 'invalid_checkout_token' });
    }
    return reply.header('Cache-Control', 'private, no-store').status(200).send({
      received: true,
      provider: 'litos',
      event: event.eventName,
      processed: event.processed,
      plan: event.plan,
      subscription_id: event.subscriptionId,
      renews_at: event.renewsAt,
    });
  });

  fastify.get<{ Params: LitosCheckoutParams; Querystring: LitosCheckoutQuery }>(
    '/billing/litos-pay/checkout/:intentId',
    async (request, reply) => {
      const token = typeof request.query.token === 'string' ? request.query.token : '';
      const intent = parseLitosCheckoutToken(token);
      if (!intent || intent.intentId !== request.params.intentId) {
        return reply.status(400).send({ error: 'Invalid or expired checkout token.', code: 'invalid_checkout_token' });
      }
      const offers = await db.select().from(pricing_offers).where(eq(pricing_offers.id, intent.intentId)).limit(1);
      const offer = offers[0];
      if (!offer || offer.user_id !== intent.userId || offer.subject_id !== intent.email) {
        return reply.status(404).send({ error: 'Checkout intent not found.', code: 'checkout_not_found' });
      }
      if (offer.paid_at || offer.status === 'paid') {
        return reply.status(409).send({ error: 'Checkout already completed.', code: 'checkout_completed' });
      }
      if (offer.expires_at && offer.expires_at <= new Date()) {
        return reply.status(410).send({ error: 'Checkout expired.', code: 'checkout_expired' });
      }
      const stripeUrl = secureStripeCheckoutUrl(offer.provider_checkout_url);
      if (!stripeUrl || !offer.provider_checkout_id?.startsWith('cs_')) {
        return reply.status(503).send({ error: 'Live card acquiring is not configured.', code: 'card_acquiring_not_configured' });
      }
      return reply.redirect(stripeUrl, 303);
    },
  );

  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  fastify.post('/billing/stripe-webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
    if (!secret || !stripeAcquiringConfigured()) {
      return reply.status(503).send({ error: 'billing not configured' });
    }

    const signature = request.headers['stripe-signature'];
    const raw = request.body as Buffer;
    if (typeof signature !== 'string' || !Buffer.isBuffer(raw)) {
      return reply.status(400).send({ error: 'bad request' });
    }
    if (!verifyStripeWebhookSignature({ rawBody: raw, signatureHeader: signature, secret })) {
      return reply.status(400).send({ error: 'bad signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return reply.status(400).send({ error: 'unparseable event' });
    }
    const checkout = parseStripeCheckoutCompleted(payload);
    const subscription = parseStripeSubscriptionChanged(payload);
    if (!checkout && !subscription) return reply.status(200).send({ received: true, ignored: true });
    const event = checkout ?? subscription!;
    if (stripeRequiresLivemode() && !event.livemode) {
      fastify.log.warn({ event: event.eventName }, 'ignored Stripe test-mode billing event in production');
      return reply.status(200).send({ received: true, ignored: true, reason: 'test_mode_event' });
    }
    if (subscription) {
      const knownPrices = new Set([
        stripePriceIdForInterval('weekly'),
        stripePriceIdForInterval('monthly'),
      ].filter(Boolean));
      if (!knownPrices.has(subscription.priceId)) {
        fastify.log.warn({ priceId: subscription.priceId }, 'ignored Stripe event for another price');
        return reply.status(200).send({ received: true, ignored: true, reason: 'unknown_price' });
      }
      if (!subscription.plan) {
        return reply.status(200).send({ received: true, ignored: true, reason: 'non_entitling_status' });
      }
      let matched = subscription.userId
        ? await db.select().from(users).where(eq(users.id, subscription.userId)).limit(1)
        : [];
      if (matched.length === 0) {
        matched = await db.select().from(users)
          .where(eq(users.billing_subscription_id, subscription.subscriptionId))
          .limit(1);
      }
      const user = matched[0];
      if (!user) {
        fastify.log.error({ subscriptionId: subscription.subscriptionId }, 'Stripe subscription did not match a Litos account');
        return reply.status(422).send({ error: 'account not found' });
      }
      if (user.billing_event_updated_at && subscription.happenedAt < user.billing_event_updated_at) {
        return reply.status(200).send({ received: true, ignored: true, reason: 'stale_event' });
      }
      const processed = await applyStripeSubscriptionChange(subscription, user.id);
      fastify.log.info({ userId: user.id, status: subscription.status }, 'synced Stripe subscription');
      return reply.status(200).send({ received: true, provider: 'stripe', processed });
    }

    const parsed = checkout!;
    const matched = await db.select().from(users).where(eq(users.id, parsed.userId)).limit(1);
    const user = matched[0];
    if (!user) {
      fastify.log.error({ checkoutIntentId: parsed.intentId }, 'Stripe checkout did not match a Litos account');
      return reply.status(422).send({ error: 'account not found' });
    }
    const offers = await db.select().from(pricing_offers).where(eq(pricing_offers.id, parsed.intentId)).limit(1);
    const offer = offers[0];
    if (
      !offer ||
      offer.user_id !== parsed.userId ||
      offer.provider_checkout_id !== parsed.sessionId ||
      !['stripe_checkout_created', 'paid'].includes(offer.status)
    ) {
      fastify.log.error({ checkoutIntentId: parsed.intentId }, 'Stripe checkout did not match a Litos offer');
      return reply.status(422).send({ error: 'checkout not found' });
    }
    if (user.billing_event_updated_at && parsed.happenedAt < user.billing_event_updated_at) {
      return reply.status(200).send({ received: true, ignored: true, reason: 'stale_event' });
    }

    const result = await applyStripePaidCheckout(parsed);
    fastify.log.info({ userId: parsed.userId, checkoutIntentId: parsed.intentId }, 'synced Stripe checkout');
    return reply.status(200).send({ received: true, provider: 'stripe', processed: result.processed });
  });

  fastify.post('/billing/lemonsqueezy-webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    const expectedVariantId = process.env.LEMONSQUEEZY_VARIANT_ID?.trim();
    if (!secret || !expectedVariantId) {
      return reply.status(503).send({ error: 'billing not configured' });
    }

    const signature = request.headers['x-signature'];
    const raw = request.body as Buffer;
    if (typeof signature !== 'string' || !Buffer.isBuffer(raw)) {
      return reply.status(400).send({ error: 'bad request' });
    }
    if (!verifyLemonSqueezySignature(raw, signature, secret)) {
      return reply.status(400).send({ error: 'bad signature' });
    }

    let parsed: ReturnType<typeof parseLemonSqueezySubscription>;
    try {
      parsed = parseLemonSqueezySubscription(JSON.parse(raw.toString('utf8')));
    } catch {
      return reply.status(400).send({ error: 'unparseable event' });
    }
    if (!parsed) return reply.status(200).send({ received: true, ignored: true });
    if (parsed.testMode && process.env.LEMONSQUEEZY_ACCEPT_TEST_MODE !== 'true') {
      fastify.log.warn({ subscriptionId: parsed.subscriptionId }, 'ignored Lemon Squeezy test-mode event');
      return reply.status(200).send({ received: true, ignored: true });
    }
    if (parsed.variantId !== expectedVariantId) {
      fastify.log.warn({ variantId: parsed.variantId }, 'ignored Lemon Squeezy event for another variant');
      return reply.status(200).send({ received: true, ignored: true });
    }

    const plan = planForLemonSqueezyStatus(parsed.status);
    if (!plan) {
      fastify.log.warn({ status: parsed.status }, 'ignored Lemon Squeezy event with unknown subscription status');
      return reply.status(200).send({ received: true, ignored: true });
    }

    const trustedUserId = parsed.userId && verifyLemonSqueezyAccountToken(parsed.userId, parsed.accountToken, secret)
      ? parsed.userId
      : undefined;
    let matched = trustedUserId
      ? await db.select().from(users).where(eq(users.id, trustedUserId)).limit(1)
      : [];
    if (matched.length === 0) {
      matched = await db.select().from(users).where(eq(users.billing_subscription_id, parsed.subscriptionId)).limit(1);
    }
    if (matched.length === 0 && parsed.email) {
      matched = await db.select().from(users).where(eq(users.email, parsed.email)).limit(1);
    }
    const user = matched[0];
    if (!user) {
      fastify.log.error({ subscriptionId: parsed.subscriptionId }, 'Lemon Squeezy subscription did not match a Litos account');
      return reply.status(422).send({ error: 'account not found' });
    }
    if (user.billing_event_updated_at && parsed.updatedAt < user.billing_event_updated_at) {
      return reply.status(200).send({ received: true, ignored: true, reason: 'stale_event' });
    }

    await db.update(users).set({
      plan,
      billing_provider: 'lemonsqueezy',
      billing_customer_id: parsed.customerId,
      billing_subscription_id: parsed.subscriptionId,
      billing_variant_id: parsed.variantId,
      billing_status: parsed.status,
      billing_renews_at: parsed.renewsAt,
      billing_ends_at: parsed.endsAt,
      billing_portal_url: parsed.portalUrl,
      billing_event_updated_at: parsed.updatedAt,
    }).where(eq(users.id, user.id));

    fastify.log.info({ userId: user.id, status: parsed.status, plan }, 'synced Lemon Squeezy subscription');
    return reply.status(200).send({ received: true });
  });
}
