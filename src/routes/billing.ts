import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index';
import {
  billing_subscriptions,
  billing_account_deletion_tombstones,
  billing_webhook_events,
  monetization_events,
  pending_premium_actions,
  pricing_offers,
  users,
} from '../db/schema';
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
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
import { billingCheckoutAvailable, billingPlan, stripeWebhookAvailable } from '../lib/billingCatalog';
import { ENTITLEMENT_POLICY_VERSION, TRIAL_DAYS, getEntitlementSnapshot } from '../lib/entitlements';
import {
  cancelStripeSubscriptionOrThrow,
  createStripeCheckoutSessionV2,
  parseStripeBillingEvent,
  retrieveStripeBillingAuthority,
  retrieveStripeChargeBillingContext,
  secureLegacyBillingPortalUrl,
} from '../lib/stripeBilling';
import {
  chooseCanonicalAccountSubscription,
  shouldApplySubscriptionEvent,
  statusAfterDisputeClosed,
  subscriptionEventAccessBoundary,
  subscriptionGrantsPlus,
  subscriptionNeedsPortalRecovery,
} from '../lib/subscriptionState';
import { z } from 'zod';
import { billingSubscriptionTombstoneHash } from '../lib/accountDeletionBilling';

type CheckoutBody = {
  interval?: 'weekly' | 'monthly' | 'annual';
  plan_id?: 'litos_plus_week' | 'litos_plus_month' | 'litos_plus_quarter';
  idempotency_key?: string;
  surface?: 'website' | 'dashboard' | 'extension';
  placement?: string;
  trigger?: string;
  action_nonce?: string;
};

const checkoutBodySchema = z.object({
  interval: z.enum(['weekly', 'monthly', 'annual']).optional(),
  plan_id: z.enum(['litos_plus_week', 'litos_plus_month', 'litos_plus_quarter']).optional(),
  idempotency_key: z.string().uuid().optional(),
  surface: z.enum(['website', 'dashboard', 'extension', 'api']).optional(),
  placement: z.string().trim().max(120).optional(),
  trigger: z.string().trim().max(120).optional(),
  action_nonce: z.string().min(20).max(200).optional(),
}).strict();

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

async function repairCheckoutActionBinding(
  offer: typeof pricing_offers.$inferSelect,
  pendingActionId: string | undefined,
): Promise<boolean> {
  if (!pendingActionId) return offer.pending_action_id === null;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`checkout-action:${pendingActionId}`}, 0::bigint))`);
    const [currentOffer] = await tx.select().from(pricing_offers).where(and(
      eq(pricing_offers.id, offer.id),
      eq(pricing_offers.user_id, offer.user_id),
    )).limit(1);
    const [action] = await tx.select().from(pending_premium_actions).where(and(
      eq(pending_premium_actions.id, pendingActionId),
      eq(pending_premium_actions.user_id, offer.user_id),
    )).limit(1);
    if (!currentOffer || currentOffer.pending_action_id !== pendingActionId
      || !action || action.state !== 'pending' || action.expires_at <= new Date()) return false;
    if (action.offer_id === currentOffer.id) return true;
    if (action.offer_id) {
      const [linkedOffer] = await tx.select().from(pricing_offers)
        .where(eq(pricing_offers.id, action.offer_id)).limit(1);
      if (linkedOffer && ['creating', 'checkout_created', 'paid'].includes(linkedOffer.status)) return false;
    }
    const [linked] = await tx.update(pending_premium_actions).set({ offer_id: currentOffer.id }).where(and(
      eq(pending_premium_actions.id, pendingActionId),
      eq(pending_premium_actions.user_id, offer.user_id),
      eq(pending_premium_actions.state, 'pending'),
    )).returning({ id: pending_premium_actions.id });
    return Boolean(linked);
  });
}

async function persistStripeCheckoutSession(input: {
  offer: typeof pricing_offers.$inferSelect;
  pendingActionId?: string;
  session: NonNullable<Awaited<ReturnType<typeof createStripeCheckoutSessionV2>>>;
}): Promise<typeof pricing_offers.$inferSelect | null> {
  return db.transaction(async (tx) => {
    if (input.pendingActionId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`checkout-action:${input.pendingActionId}`}, 0::bigint))`);
    }
    const [currentOffer] = await tx.select().from(pricing_offers).where(and(
      eq(pricing_offers.id, input.offer.id),
      eq(pricing_offers.user_id, input.offer.user_id),
    )).limit(1);
    if (!currentOffer || currentOffer.pending_action_id !== (input.pendingActionId ?? null)) return null;

    let action: typeof pending_premium_actions.$inferSelect | undefined;
    if (input.pendingActionId) {
      [action] = await tx.select().from(pending_premium_actions).where(and(
        eq(pending_premium_actions.id, input.pendingActionId),
        eq(pending_premium_actions.user_id, input.offer.user_id),
      )).limit(1);
      if (!action || action.state !== 'pending' || action.expires_at <= new Date()) return null;
      if (action.offer_id && action.offer_id !== currentOffer.id) {
        const [linkedOffer] = await tx.select().from(pricing_offers)
          .where(eq(pricing_offers.id, action.offer_id)).limit(1);
        if (linkedOffer && ['creating', 'checkout_created', 'paid'].includes(linkedOffer.status)) return null;
      }
    }

    let persistedOffer = currentOffer;
    if (currentOffer.status === 'creating' || currentOffer.status === 'checkout_created') {
      const now = new Date();
      [persistedOffer] = await tx.update(pricing_offers).set({
        status: 'checkout_created',
        provider_checkout_id: input.session.id,
        provider_checkout_url: input.session.url,
        provider_customer_id: input.session.customerId,
        provider_subscription_id: input.session.subscriptionId,
        expires_at: input.session.expiresAt,
        checkout_created_at: currentOffer.checkout_created_at ?? now,
        updated_at: now,
      }).where(and(
        eq(pricing_offers.id, currentOffer.id),
        inArray(pricing_offers.status, ['creating', 'checkout_created']),
      )).returning();
      if (!persistedOffer) return null;
    }
    if (action) {
      const [linked] = await tx.update(pending_premium_actions).set({
        offer_id: persistedOffer.id,
        expires_at: input.session.expiresAt,
      }).where(and(
        eq(pending_premium_actions.id, action.id),
        eq(pending_premium_actions.user_id, persistedOffer.user_id),
        eq(pending_premium_actions.state, 'pending'),
      )).returning({ id: pending_premium_actions.id });
      if (!linked) throw new Error('Checkout action binding changed during persistence');
    }
    return persistedOffer;
  });
}

async function replayCheckoutOffer(
  reply: FastifyReply,
  prior: typeof pricing_offers.$inferSelect,
  expected: {
    term: string;
    trigger: string;
    surface: string;
    placement?: string;
    pendingActionId?: string;
  },
  conflict: 'idempotency_conflict' | 'checkout_in_progress' = 'idempotency_conflict',
  repairCreating?: () => Promise<typeof pricing_offers.$inferSelect | null>,
) {
  if (
    prior.term_code !== expected.term
    || prior.trigger !== expected.trigger
    || prior.surface !== expected.surface
    || (prior.placement ?? undefined) !== expected.placement
    || (prior.pending_action_id ?? undefined) !== expected.pendingActionId
  ) {
    return reply.status(409).send({
      error: conflict === 'idempotency_conflict'
        ? 'This idempotency key was used for another checkout.'
        : 'Another checkout is already in progress for this account.',
      code: conflict,
    });
  }
  let replayed = prior;
  if (replayed.status === 'creating' && replayed.expires_at > new Date() && repairCreating) {
    const repaired = await repairCreating();
    if (!repaired) {
      return reply.status(503).send({ error: 'Checkout is temporarily unavailable.', code: 'checkout_failed' });
    }
    replayed = repaired;
  }
  if (!(await repairCheckoutActionBinding(replayed, expected.pendingActionId))) {
    return reply.status(409).send({
      error: 'The checkout and pending action no longer match.',
      code: 'action_binding_conflict',
    });
  }
  if (replayed.status === 'paid') {
    return reply.status(409).send({
      error: 'This account already has Litos+.',
      code: 'already_plus',
      portal_url: '/billing/portal',
    });
  }
  const priorUrl = secureStripeCheckoutUrl(replayed.provider_checkout_url);
  if (
    priorUrl
    && replayed.provider_checkout_id
    && replayed.expires_at > new Date()
    && (replayed.status === 'creating' || replayed.status === 'checkout_created')
  ) {
    return reply.header('Cache-Control', 'private, no-store').send({
      provider: 'stripe',
      offer_id: replayed.id,
      checkout_session_id: replayed.provider_checkout_id,
      checkout_url: priorUrl,
      expires_at: replayed.expires_at.toISOString(),
      status_url: `/billing/offers/${replayed.id}`,
    });
  }
  if (replayed.status === 'creating' && replayed.expires_at > new Date()) {
    return reply.header('Cache-Control', 'private, no-store').status(202).send({
      provider: 'stripe',
      offer_id: replayed.id,
      status: 'creating',
      code: 'checkout_creating',
      expires_at: replayed.expires_at.toISOString(),
      status_url: `/billing/offers/${replayed.id}`,
    });
  }
  return reply.status(409).send({
    error: 'This checkout attempt can no longer be reused.',
    code: 'checkout_expired',
  });
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
    const [ent, snapshot] = await Promise.all([getEntitlements(userId), getEntitlementSnapshot(userId)]);
    const period = monthPeriod();
    const [usedContacts, usedDrafts, usedResumes] = await Promise.all([
      getCount(userId, period, 'verified_contacts'),
      getCount(userId, period, 'drafts'),
      getCount(userId, period, 'resumes'),
    ]);
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    const upgradeLink = upgradeUrl();
    const stripeReady = billingCheckoutAvailable();
    return reply.status(200).send({
      email: email ?? null,
      is_guest: isGuest,
      tier: ent.tier,
      trial_ends_at: user?.trial_ends_at ?? null,
      guest_expires_at: user?.guest_expires_at ?? null,
      billing_provider: user?.billing_provider ?? null,
      checkout_available: stripeReady,
      billing_portal_available: user?.billing_provider === 'stripe'
        && Boolean(user.billing_customer_id)
        && (billingCheckoutAvailable() || stripeAcquiringConfigured()),
      billing_status: user?.billing_status ?? null,
      billing_renews_at: user?.billing_renews_at ?? null,
      billing_ends_at: user?.billing_ends_at ?? null,
      billing_portal_url: user?.billing_portal_url ?? null,
      usage: {
        contacts: { used: usedContacts, limit: ent.monthlyContacts },
        drafts: { used: usedDrafts, limit: ent.monthlyDrafts },
        resumes: { used: usedResumes, limit: ent.monthlyResumes },
      },
      entitlements: snapshot,
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
      productCode: pricing_offers.product_code,
      termCode: pricing_offers.term_code,
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
    const canonicalCadence = offer?.termCode === 'week'
      || offer?.termCode === 'month'
      || offer?.termCode === 'quarter'
      ? offer.termCode
      : offer?.interval === 'week' || offer?.interval === 'month' || offer?.interval === 'quarter'
        ? offer.interval
        : offer?.productCode === 'litos_plus' && offer.interval === 'weekly'
          ? 'week'
          : offer?.productCode === 'litos_plus' && offer.interval === 'monthly'
            ? 'month'
            : null;
    const legacyInterval = offer?.interval === 'weekly' || offer?.interval === 'monthly'
      ? offer.interval
      : null;
    const receiptInterval = canonicalCadence ?? legacyInterval;
    if (!offer || !receiptInterval) {
      return reply.status(404).send({ error: 'No paid subscription receipt is available.', code: 'billing_receipt_missing' });
    }
    return reply.header('Cache-Control', 'private, no-store').status(200).send({
      provider: user.billing_provider === 'stripe' ? 'stripe' : 'litos',
      plan: canonicalCadence !== null || offer.productCode === 'litos_plus' ? 'litos_plus' : 'pro',
      interval: receiptInterval,
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
    const parsedBody = checkoutBodySchema.safeParse(jsonBody<CheckoutBody>(request.body));
    if (!parsedBody.success) {
      return reply.status(400).send({ error: 'Invalid checkout request.', code: 'invalid_checkout', detail: parsedBody.error.issues });
    }
    const body = parsedBody.data;
    if (body.interval === 'annual') {
      return reply.status(410).send({ error: 'Annual checkout is retired.', code: 'plan_retired', plans_url: '/billing/plans' });
    }
    const compatibilityPlan = body.interval === 'weekly'
      ? 'litos_plus_week'
      : body.interval === 'monthly'
        ? 'litos_plus_month'
        : undefined;
    const plan = billingPlan(body.plan_id ?? compatibilityPlan);
    if (!plan) return reply.status(400).send({ error: 'Unknown plan.', code: 'invalid_plan', plans_url: '/billing/plans' });

    // A deployment that has not enabled the v2 catalog may continue its already configured v1
    // acquiring path during rollout. Once LITOS_BILLING_ENABLED is true, incomplete v2 Stripe
    // configuration fails closed and can never silently route a new sale through the legacy path.
    if (
      process.env.LITOS_BILLING_ENABLED !== 'true'
      && litosProcessorConfigured()
      && (stripeAcquiringConfigured() || litosProcessorTrialConfigured())
    ) {
      const [legacyAccount] = await db.select({
        plan: users.plan,
        billing_provider: users.billing_provider,
        billing_status: users.billing_status,
      }).from(users).where(eq(users.id, userId)).limit(1);
      if (legacyAccount?.billing_provider && subscriptionNeedsPortalRecovery(legacyAccount.billing_status)) {
        return reply.status(409).send({
          error: 'Resolve the existing billing account before starting another subscription.',
          code: 'billing_recovery_required',
          portal_url: '/billing/portal',
        });
      }
      if (legacyAccount?.plan === 'pro') {
        return reply.status(409).send({ error: 'This account already has Litos+.', code: 'already_plus', portal_url: '/billing/portal' });
      }
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

    const [snapshot, accountRows] = await Promise.all([
      getEntitlementSnapshot(userId),
      db.select({
        billing_provider: users.billing_provider,
        billing_customer_id: users.billing_customer_id,
        billing_status: users.billing_status,
        trial_started_at: users.trial_started_at,
        trial_ends_at: users.trial_ends_at,
      }).from(users).where(eq(users.id, userId)).limit(1),
    ]);
    const account = accountRows[0];
    /* The trial is once per account, and this is the only place that decides it.
       Signup no longer grants one (routes/auth.ts), so the trial days now ride on
       the Stripe subscription -- which means the question "has this account
       already had its trial?" has to be answered HERE, before checkout is
       created, or a student could spend a trial, cancel, and open a second free
       week from the same pricing page.
       The two gates cover the two eras, and neither covers both. The trial
       columns catch accounts created BEFORE the card requirement, which is the
       only thing that ever wrote them; nothing writes them now. Everyone who
       starts a trial from here on is caught by `billing_customer_id` instead,
       which the subscription webhook stamps on the first lifecycle event
       (routes/billing.ts, the canonical-projection update) and never clears --
       so cancelling a trial does not restore eligibility for another one. */
    const hadTrialBefore = Boolean(account?.trial_started_at || account?.trial_ends_at);
    const returningCustomer = account?.billing_provider === 'stripe' && Boolean(account?.billing_customer_id);
    const trialDays = hadTrialBefore || returningCustomer ? 0 : TRIAL_DAYS;
    const billingProvider = snapshot.subscription?.provider ?? account?.billing_provider;
    const billingStatus = snapshot.subscription?.status ?? account?.billing_status;
    if (billingProvider && subscriptionNeedsPortalRecovery(billingStatus)) {
      return reply.status(409).send({
        error: 'Resolve the existing billing account before starting another subscription.',
        code: 'billing_recovery_required',
        portal_url: '/billing/portal',
      });
    }
    if (snapshot.access_class === 'plus_paid' || snapshot.access_class === 'legacy_paid') {
      return reply.status(409).send({ error: 'This account already has Litos+.', code: 'already_plus', portal_url: '/billing/portal' });
    }
    if (!billingCheckoutAvailable()) {
      return reply.status(503).send({ error: 'Checkout is temporarily unavailable.', code: 'billing_not_configured' });
    }
    const idempotencyKey = typeof request.headers['idempotency-key'] === 'string'
      ? request.headers['idempotency-key']
      : body.idempotency_key;
    if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return reply.status(400).send({ error: 'Idempotency-Key must be a UUID.', code: 'idempotency_key_required' });
    }
    let action: typeof pending_premium_actions.$inferSelect | undefined;
    if (body.action_nonce) {
      const { createHash } = await import('node:crypto');
      [action] = await db.select().from(pending_premium_actions).where(and(
        eq(pending_premium_actions.user_id, userId),
        eq(pending_premium_actions.nonce_hash, createHash('sha256').update(body.action_nonce).digest('hex')),
      )).limit(1);
      if (!action || action.expires_at <= new Date() || action.state !== 'pending') {
        return reply.status(409).send({ error: 'Pending action is invalid or expired.', code: 'action_invalid' });
      }
    }
    const expectedOffer = {
      term: plan.term,
      trigger: body.trigger ?? 'account_upgrade',
      surface: body.surface ?? 'dashboard',
      placement: body.placement,
      pendingActionId: action?.id,
    };
    const repairCreatingOffer = async (offer: typeof pricing_offers.$inferSelect) => {
      const session = await createStripeCheckoutSessionV2({
        offerId: offer.id,
        userId,
        email,
        planId: plan.id,
        idempotencyKey,
        actionId: action?.id,
        actionNonce: body.action_nonce,
        surface: expectedOffer.surface,
        existingCustomerId: account?.billing_provider === 'stripe' ? account.billing_customer_id : null,
        expiresAt: offer.expires_at,
        trialDays,
      });
      if (!session) return null;
      return persistStripeCheckoutSession({ offer, pendingActionId: action?.id, session });
    };
    const checkoutNow = new Date();
    const liveOfferStatuses = ['creating', 'checkout_created'];
    await db.update(pricing_offers).set({ status: 'expired', updated_at: checkoutNow }).where(and(
      eq(pricing_offers.user_id, userId),
      eq(pricing_offers.product_code, 'litos_plus'),
      inArray(pricing_offers.status, liveOfferStatuses),
      lte(pricing_offers.expires_at, checkoutNow),
    ));
    const existing = await db.select().from(pricing_offers).where(and(
      eq(pricing_offers.user_id, userId),
      eq(pricing_offers.client_idempotency_key, idempotencyKey),
    )).limit(1);
    if (existing[0]) {
      return replayCheckoutOffer(reply, existing[0], expectedOffer, 'idempotency_conflict', () => repairCreatingOffer(existing[0]));
    }
    const [liveOffer] = await db.select().from(pricing_offers).where(and(
      eq(pricing_offers.user_id, userId),
      eq(pricing_offers.product_code, 'litos_plus'),
      inArray(pricing_offers.status, liveOfferStatuses),
      gt(pricing_offers.expires_at, checkoutNow),
    )).limit(1);
    if (liveOffer) {
      const repair = liveOffer.client_idempotency_key === idempotencyKey
        ? () => repairCreatingOffer(liveOffer)
        : undefined;
      return replayCheckoutOffer(reply, liveOffer, expectedOffer, 'checkout_in_progress', repair);
    }
    const offerId = randomUUID();
    // Stripe requires expires_at to be at least 30 minutes after Session creation. The extra
    // minute covers the live Price verification that happens before the Session POST while
    // preserving one deterministic expiry across retries, the offer, and the pending action.
    const expiresAt = new Date(Date.now() + 31 * 60 * 1000);
    const [insertedOffer] = await db.insert(pricing_offers).values({
      id: offerId,
      user_id: userId,
      subject_id: email.trim().toLowerCase(),
      idempotency_key: `v2:${idempotencyKey}`,
      policy_version: ENTITLEMENT_POLICY_VERSION,
      country_code: 'US',
      band: 'standard',
      experiment_variant: 'control',
      billing_interval: plan.term,
      currency: plan.currency,
      base_amount_cents: plan.amount_cents,
      amount_cents: plan.amount_cents,
      status: 'creating',
      expires_at: expiresAt,
      product_code: plan.product_code,
      term_code: plan.term,
      provider_price_id: process.env[plan.price_env]?.trim(),
      surface: expectedOffer.surface,
      placement: body.placement,
      trigger: expectedOffer.trigger,
      client_idempotency_key: idempotencyKey,
      pending_action_id: action?.id,
    }).onConflictDoNothing().returning();
    if (!insertedOffer) {
      const [racedOffer] = await db.select().from(pricing_offers).where(and(
        eq(pricing_offers.user_id, userId),
        eq(pricing_offers.product_code, 'litos_plus'),
        inArray(pricing_offers.status, liveOfferStatuses),
      )).limit(1);
      if (!racedOffer) throw new Error('Checkout idempotency conflict did not return an offer');
      return replayCheckoutOffer(
        reply,
        racedOffer,
        expectedOffer,
        racedOffer.client_idempotency_key === idempotencyKey ? 'idempotency_conflict' : 'checkout_in_progress',
        racedOffer.client_idempotency_key === idempotencyKey ? () => repairCreatingOffer(racedOffer) : undefined,
      );
    }
    return replayCheckoutOffer(reply, insertedOffer, expectedOffer, 'idempotency_conflict', () => repairCreatingOffer(insertedOffer));
  });

  fastify.post('/billing/portal', { preHandler: requireAuth }, async (request, reply) => {
    const { userId, isGuest } = request.jwtPayload!;
    if (isGuest) {
      return reply.status(409).send({ error: 'Verify an email before managing billing.', code: 'claim_required' });
    }
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const user = rows[0];
    if (!user) return reply.status(404).send({ error: 'Account not found' });
    if (user.billing_provider === 'lemonsqueezy') {
      const legacyUrl = secureLegacyBillingPortalUrl(user.billing_portal_url);
      if (!legacyUrl) return reply.status(409).send({ error: 'No billing account is linked.', code: 'no_billing_account' });
      return reply.header('Cache-Control', 'private, no-store').send({ provider: 'lemonsqueezy', url: legacyUrl });
    }
    if (user.billing_provider !== 'stripe' || !user.billing_customer_id) {
      return reply.status(409).send({ error: 'No Stripe billing account is linked.', code: 'no_billing_account' });
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
    if (!secret || !stripeWebhookAvailable()) {
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
    const parsedEvent = parseStripeBillingEvent(payload, raw);
    if (!parsedEvent) return reply.status(200).send({ received: true, ignored: true });
    let event = parsedEvent;
    if (stripeRequiresLivemode() && !event.livemode) {
      fastify.log.warn({ event: event.eventName }, 'ignored Stripe test-mode billing event in production');
      return reply.status(200).send({ received: true, ignored: true, reason: 'test_mode_event' });
    }
    if (event.eventName.startsWith('invoice.') && (!event.subscriptionId || !event.invoiceId)) {
      fastify.log.error({ event: event.eventName }, 'Stripe invoice event omitted its exact subscription');
      return reply.status(500).send({ error: 'billing event processing failed' });
    }
    if ((event.eventName.startsWith('charge.dispute.') || event.eventName === 'charge.refunded')
      && event.chargeId && !event.subscriptionId) {
      try {
        const context = await retrieveStripeChargeBillingContext({ chargeId: event.chargeId });
        if (!context?.subscriptionId || !context.customerId || !context.invoiceId) {
          return reply.status(500).send({ error: 'billing event processing failed' });
        }
        event = {
          ...event,
          customerId: context.customerId,
          subscriptionId: context.subscriptionId,
          invoiceId: context.invoiceId,
          paymentIntentId: event.paymentIntentId ?? context.paymentIntentId,
        };
      } catch (error) {
        fastify.log.error({ error, chargeId: event.chargeId }, 'Stripe charge context lookup failed');
        return reply.status(500).send({ error: 'billing event processing failed' });
      }
    }
    const priorLedger = await db.select().from(billing_webhook_events)
      .where(eq(billing_webhook_events.event_key, event.eventKey)).limit(1);
    if (priorLedger[0]?.result === 'processed' || priorLedger[0]?.result === 'operator_review') {
      return reply.status(200).send({ received: true, provider: 'stripe', processed: false, duplicate: true });
    }
    if (!priorLedger[0]) {
      const claimed = await db.insert(billing_webhook_events).values({
        event_key: event.eventKey,
        provider: 'stripe',
        event_name: event.eventName,
        provider_object_id: event.providerObjectId,
        provider_event_created_at: event.createdAt,
        payload_sha256: event.payloadSha256,
        livemode: event.livemode,
        processing_attempts: 1,
        result: 'processing',
      }).onConflictDoNothing().returning({ event_key: billing_webhook_events.event_key });
      if (claimed.length === 0) {
        const [racedLedger] = await db.select().from(billing_webhook_events)
          .where(eq(billing_webhook_events.event_key, event.eventKey)).limit(1);
        if (racedLedger?.result === 'processed' || racedLedger?.result === 'operator_review') {
          return reply.status(200).send({ received: true, provider: 'stripe', processed: false, duplicate: true });
        }
        if (racedLedger) {
          await db.update(billing_webhook_events).set({
            processing_attempts: racedLedger.processing_attempts + 1,
            last_error: null,
          }).where(eq(billing_webhook_events.event_key, event.eventKey));
        }
      }
    } else {
      await db.update(billing_webhook_events).set({
        result: 'processing',
        last_error: null,
        processing_attempts: priorLedger[0].processing_attempts + 1,
      }).where(eq(billing_webhook_events.event_key, event.eventKey));
    }

    let cancelAfterRefund: string | null = null;
    let providerSubscriptionStatus: string | null = null;
    try {
      const result = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stripe-event:${event.eventKey}`}, 0::bigint))`);
        const [lockedLedger] = await tx.select().from(billing_webhook_events)
          .where(eq(billing_webhook_events.event_key, event.eventKey)).limit(1);
        if (lockedLedger?.result === 'processed' || lockedLedger?.result === 'operator_review') {
          return { ignored: true, userId: null, state: 'duplicate' };
        }
        const billingObjectLock = event.subscriptionId ?? event.customerId ?? event.userId ?? event.offerId;
        if (billingObjectLock) {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`stripe-billing:${billingObjectLock}`}, 0::bigint))`);
        }
        const isCheckout = event.eventName.startsWith('checkout.session.');
        const isSubscription = event.eventName.startsWith('customer.subscription.');
        const isInvoice = event.eventName.startsWith('invoice.');
        const isRefund = event.eventName === 'charge.refunded';
        const isDispute = event.eventName.startsWith('charge.dispute.');
        const requiresProviderAuthority = isSubscription || isInvoice || isRefund || isDispute
          || (isCheckout && event.eventName !== 'checkout.session.async_payment_failed');
        if (requiresProviderAuthority) {
          const authority = await retrieveStripeBillingAuthority({ event });
          if (!authority) throw new Error('Stripe current billing state could not be verified');
          providerSubscriptionStatus = authority.subscription.status;
          event = {
            ...event,
            userId: event.userId ?? authority.subscription.userId,
            offerId: event.offerId ?? authority.subscription.offerId,
            customerId: authority.subscription.customerId,
            subscriptionId: authority.subscription.subscriptionId,
            priceId: authority.subscription.priceId,
            plan: authority.subscription.plan,
            status: isRefund || isDispute ? event.status : authority.subscription.status,
            cancelAtPeriodEnd: authority.subscription.cancelAtPeriodEnd,
            currentPeriodStart: authority.subscription.currentPeriodStart,
            currentPeriodEnd: authority.subscription.currentPeriodEnd,
            accessEndsAt: authority.subscription.accessEndsAt,
            invoiceId: authority.invoiceId,
            paymentIntentId: authority.paymentIntentId,
            chargeId: authority.chargeId,
            amount: authority.amount,
            amountRefunded: authority.amountRefunded,
            disputeOutcome: authority.disputeOutcome,
          };
        }
        const offer = event.offerId
          ? (await tx.select().from(pricing_offers).where(eq(pricing_offers.id, event.offerId)).limit(1))[0]
          : undefined;
        let subscription = event.subscriptionId
          ? (await tx.select().from(billing_subscriptions)
            .where(eq(billing_subscriptions.provider_subscription_id, event.subscriptionId)).limit(1))[0]
          : undefined;
        const customerSubscription = event.customerId
          ? (await tx.select().from(billing_subscriptions)
            .where(eq(billing_subscriptions.provider_customer_id, event.customerId))
            .orderBy(sql`${billing_subscriptions.updated_at} desc`).limit(1))[0]
          : undefined;
        // Customer identity may locate the account, but it is never a subscription mutation
        // target. An invoice, refund, or dispute without an exact subscription id must wait for
        // provider context instead of projecting state onto whichever subscription was updated
        // most recently for that customer.
        let user = event.userId
          ? (await tx.select().from(users).where(eq(users.id, event.userId)).limit(1))[0]
          : undefined;
        if (!user && offer) user = (await tx.select().from(users).where(eq(users.id, offer.user_id)).limit(1))[0];
        if (!user && (subscription ?? customerSubscription)) {
          user = (await tx.select().from(users).where(eq(
            users.id,
            (subscription ?? customerSubscription)!.user_id,
          )).limit(1))[0];
        }
        if (!user && event.customerId) {
          user = (await tx.select().from(users).where(eq(users.billing_customer_id, event.customerId)).limit(1))[0];
        }

        if (isCheckout && event.eventName === 'checkout.session.async_payment_failed') {
          if (offer) await tx.update(pricing_offers).set({ status: 'failed', updated_at: event.createdAt })
            .where(eq(pricing_offers.id, offer.id));
          await tx.update(billing_webhook_events).set({ result: 'processed', processed_at: new Date() })
            .where(eq(billing_webhook_events.event_key, event.eventKey));
          return { ignored: false, userId: offer?.user_id ?? null, state: 'checkout_failed' };
        }
        if (!user && isSubscription && event.eventName === 'customer.subscription.deleted' && event.subscriptionId) {
          const subscriptionHash = billingSubscriptionTombstoneHash('stripe', event.subscriptionId);
          const [deletionTombstone] = await tx.select().from(billing_account_deletion_tombstones).where(and(
            eq(billing_account_deletion_tombstones.provider, 'stripe'),
            eq(billing_account_deletion_tombstones.provider_subscription_hash, subscriptionHash),
            gt(billing_account_deletion_tombstones.expires_at, new Date()),
          )).limit(1);
          if (deletionTombstone?.cancellation_confirmed_at && deletionTombstone.account_deleted_at) {
            await tx.update(billing_webhook_events).set({
              result: 'processed',
              processed_at: new Date(),
              provider_object_id: null,
            }).where(eq(billing_webhook_events.event_key, event.eventKey));
            return { ignored: true, userId: null, state: 'deleted_account_cancellation_confirmed' };
          }
        }
        if (!user) throw new Error('Stripe billing event did not map to a Litos account');

        const checkoutPaid = isCheckout && (
          event.eventName === 'checkout.session.async_payment_succeeded'
          || event.paymentStatus === 'paid'
          || event.paymentStatus === 'no_payment_required'
        );
        const incomingStatus = event.status
          ?? (checkoutPaid ? 'active' : null)
          ?? (event.eventName === 'charge.dispute.closed' && subscription
            ? statusAfterDisputeClosed(event.disputeOutcome, subscription.dispute_previous_status)
            : null);
        const applySubscriptionState = requiresProviderAuthority || !subscription || shouldApplySubscriptionEvent({
          storedCreatedAt: subscription.provider_event_created_at,
          storedStatus: subscription.status,
          incomingCreatedAt: event.createdAt,
          incomingStatus,
          eventName: event.eventName,
        });
        if (subscription && !applySubscriptionState && !isCheckout) {
          await tx.update(billing_webhook_events).set({ result: 'processed', processed_at: new Date() })
            .where(eq(billing_webhook_events.event_key, event.eventKey));
          return { ignored: true, userId: user.id, state: 'stale_event' };
        }

        if (isCheckout) {
          if (!offer || offer.user_id !== user.id || !event.subscriptionId || !event.customerId) {
            throw new Error('Stripe checkout did not match an owned offer and subscription');
          }
          const paid = checkoutPaid;
          if (!paid) {
            await tx.update(billing_webhook_events).set({ result: 'processed', processed_at: new Date() })
              .where(eq(billing_webhook_events.event_key, event.eventKey));
            return { ignored: true, userId: user.id, state: 'awaiting_payment' };
          }
          const plan = billingPlan(`litos_plus_${offer.term_code === 'quarter' ? 'quarter' : offer.term_code}`);
          if (!plan
            || offer.provider_price_id !== process.env[plan.price_env]?.trim()
            || event.priceId !== offer.provider_price_id
            || event.plan?.term !== plan.term) {
            throw new Error('Stripe checkout offer price is not in the live Litos+ catalog');
          }
          if (applySubscriptionState) {
            const checkoutStatus = event.status ?? 'incomplete';
            const checkoutAccessEndsAt = subscriptionEventAccessBoundary({
              incomingStatus: checkoutStatus,
              incomingCreatedAt: event.createdAt,
              incomingAccessEndsAt: event.accessEndsAt,
              storedStatus: subscription?.status,
              storedAccessEndsAt: subscription?.access_ends_at,
            });
            [subscription] = await tx.insert(billing_subscriptions).values({
              user_id: user.id,
              provider: 'stripe',
              provider_customer_id: event.customerId,
              provider_subscription_id: event.subscriptionId,
              provider_price_id: event.priceId!,
              product_code: 'litos_plus',
              term_code: event.plan!.term,
              status: checkoutStatus,
              cancel_at_period_end: event.cancelAtPeriodEnd,
              current_period_start: event.currentPeriodStart,
              current_period_end: event.currentPeriodEnd,
              access_ends_at: checkoutAccessEndsAt,
              ended_at: checkoutStatus === 'canceled' ? event.accessEndsAt ?? event.createdAt : null,
              provider_event_created_at: event.createdAt,
            }).onConflictDoUpdate({
              target: billing_subscriptions.provider_subscription_id,
              set: {
                provider_customer_id: event.customerId,
                provider_price_id: event.priceId!,
                term_code: event.plan!.term,
                status: checkoutStatus,
                cancel_at_period_end: event.cancelAtPeriodEnd,
                current_period_start: event.currentPeriodStart,
                current_period_end: event.currentPeriodEnd,
                access_ends_at: checkoutAccessEndsAt,
                ended_at: checkoutStatus === 'canceled' ? event.accessEndsAt ?? event.createdAt : null,
                provider_event_created_at: event.createdAt,
                updated_at: event.createdAt,
              },
            }).returning();
          }
          await tx.update(pricing_offers).set({
            status: 'paid',
            provider_customer_id: event.customerId,
            provider_subscription_id: event.subscriptionId,
            paid_at: event.createdAt,
            completed_at: event.createdAt,
            verified_at: event.createdAt,
            updated_at: event.createdAt,
          }).where(eq(pricing_offers.id, offer.id));
        } else if (isSubscription) {
          if (!event.subscriptionId || !event.customerId || !event.plan || !event.priceId || !event.status) {
            throw new Error('Stripe subscription event is missing catalog state');
          }
          const accessEndsAt = subscriptionEventAccessBoundary({
            incomingStatus: event.status,
            incomingCreatedAt: event.createdAt,
            incomingAccessEndsAt: event.accessEndsAt,
            storedStatus: subscription?.status,
            storedAccessEndsAt: subscription?.access_ends_at,
          });
          [subscription] = await tx.insert(billing_subscriptions).values({
            user_id: user.id,
            provider: 'stripe',
            provider_customer_id: event.customerId,
            provider_subscription_id: event.subscriptionId,
            provider_price_id: event.priceId,
            product_code: 'litos_plus',
            term_code: event.plan.term,
            status: event.status,
            cancel_at_period_end: event.cancelAtPeriodEnd,
            current_period_start: event.currentPeriodStart,
            current_period_end: event.currentPeriodEnd,
            access_ends_at: accessEndsAt,
            ended_at: event.status === 'canceled' ? event.accessEndsAt ?? event.createdAt : null,
            provider_event_created_at: event.createdAt,
            updated_at: event.createdAt,
          }).onConflictDoUpdate({
            target: billing_subscriptions.provider_subscription_id,
            set: {
              provider_customer_id: event.customerId,
              provider_price_id: event.priceId,
              term_code: event.plan.term,
              status: event.status,
              cancel_at_period_end: event.cancelAtPeriodEnd,
              current_period_start: event.currentPeriodStart,
              current_period_end: event.currentPeriodEnd,
              access_ends_at: accessEndsAt,
              ended_at: event.status === 'canceled' ? event.accessEndsAt ?? event.createdAt : null,
              provider_event_created_at: event.createdAt,
              updated_at: event.createdAt,
            },
          }).returning();
        } else if (isInvoice) {
          const nextStatus = event.status;
          if (!nextStatus) throw new Error('Stripe invoice current subscription status is unavailable');
          const invoiceAccessEndsAt = subscriptionEventAccessBoundary({
            incomingStatus: nextStatus,
            incomingCreatedAt: event.createdAt,
            incomingAccessEndsAt: nextStatus === 'past_due' ? event.createdAt : event.accessEndsAt,
            storedStatus: subscription?.status,
            storedAccessEndsAt: subscription?.access_ends_at,
          });
          if (!subscription) {
            if (!event.subscriptionId || !event.customerId || !event.plan || !event.priceId) {
              // Keep the ledger retryable. A subscription or checkout event will establish the
              // exact row, after which Stripe can safely redeliver this invoice.
              throw new Error('Stripe invoice exact subscription state is not available yet');
            }
            [subscription] = await tx.insert(billing_subscriptions).values({
              user_id: user.id,
              provider: 'stripe',
              provider_customer_id: event.customerId,
              provider_subscription_id: event.subscriptionId,
              provider_price_id: event.priceId,
              product_code: 'litos_plus',
              term_code: event.plan.term,
              status: nextStatus,
              current_period_start: event.currentPeriodStart,
              current_period_end: event.currentPeriodEnd,
              access_ends_at: invoiceAccessEndsAt,
              cancel_at_period_end: event.cancelAtPeriodEnd,
              ended_at: nextStatus === 'canceled' ? event.accessEndsAt ?? event.createdAt : null,
              latest_invoice_id: event.invoiceId,
              latest_payment_intent_id: event.paymentIntentId,
              provider_event_created_at: event.createdAt,
              updated_at: event.createdAt,
            }).onConflictDoUpdate({
              target: billing_subscriptions.provider_subscription_id,
              set: {
                provider_customer_id: event.customerId,
                provider_price_id: event.priceId,
                term_code: event.plan.term,
                status: nextStatus,
                latest_invoice_id: event.invoiceId,
                latest_payment_intent_id: event.paymentIntentId,
                current_period_start: event.currentPeriodStart,
                current_period_end: event.currentPeriodEnd,
                access_ends_at: invoiceAccessEndsAt,
                cancel_at_period_end: event.cancelAtPeriodEnd,
                ended_at: nextStatus === 'canceled' ? event.accessEndsAt ?? event.createdAt : null,
                provider_event_created_at: event.createdAt,
                updated_at: event.createdAt,
              },
            }).returning();
          } else {
            [subscription] = await tx.update(billing_subscriptions).set({
              provider_customer_id: event.customerId!,
              provider_price_id: event.priceId!,
              term_code: event.plan!.term,
              status: nextStatus,
              latest_invoice_id: event.invoiceId,
              latest_payment_intent_id: event.paymentIntentId,
              current_period_start: event.currentPeriodStart ?? subscription.current_period_start,
              current_period_end: event.currentPeriodEnd ?? subscription.current_period_end,
              access_ends_at: invoiceAccessEndsAt,
              cancel_at_period_end: event.cancelAtPeriodEnd,
              ended_at: nextStatus === 'canceled' ? event.accessEndsAt ?? event.createdAt : null,
              provider_event_created_at: event.createdAt,
              updated_at: event.createdAt,
            }).where(eq(billing_subscriptions.id, subscription.id)).returning();
          }
        } else if (isRefund) {
          if (!subscription) throw new Error('Stripe refund did not map to a subscription');
          const fullRefund = event.amount !== null && event.amountRefunded !== null && event.amountRefunded >= event.amount;
          if (fullRefund) {
            cancelAfterRefund = subscription.provider_subscription_id;
            [subscription] = await tx.update(billing_subscriptions).set({
              status: 'refunded',
              access_ends_at: event.createdAt,
              ended_at: event.createdAt,
              provider_event_created_at: event.createdAt,
              updated_at: event.createdAt,
            }).where(eq(billing_subscriptions.id, subscription.id)).returning();
          } else {
            await tx.update(billing_webhook_events).set({ result: 'operator_review', processed_at: new Date() })
              .where(eq(billing_webhook_events.event_key, event.eventKey));
            return { ignored: false, userId: user.id, state: 'partial_refund_review' };
          }
        } else if (isDispute) {
          if (!subscription) throw new Error('Stripe dispute did not map to a subscription');
          const disputeIsClosed = event.disputeOutcome === 'won'
            || event.disputeOutcome === 'lost'
            || event.disputeOutcome === 'warning_closed';
          if (!disputeIsClosed) {
            [subscription] = await tx.update(billing_subscriptions).set({
              dispute_previous_status: subscription.status,
              status: 'disputed',
              access_ends_at: event.createdAt,
              provider_event_created_at: event.createdAt,
              updated_at: event.createdAt,
            }).where(eq(billing_subscriptions.id, subscription.id)).returning();
          } else {
            const restoresProviderState = event.disputeOutcome === 'won' || event.disputeOutcome === 'warning_closed';
            const nextStatus = restoresProviderState
              ? providerSubscriptionStatus ?? statusAfterDisputeClosed(event.disputeOutcome, subscription.dispute_previous_status)
              : statusAfterDisputeClosed(event.disputeOutcome, subscription.dispute_previous_status);
            const restoredAccessEndsAt = restoresProviderState
              ? nextStatus === 'active' || nextStatus === 'trialing'
                ? event.cancelAtPeriodEnd ? event.accessEndsAt ?? event.currentPeriodEnd : null
                : event.accessEndsAt ?? event.createdAt
              : event.createdAt;
            const terminalStatus = nextStatus === 'canceled'
              || nextStatus === 'expired'
              || nextStatus === 'incomplete_expired';
            [subscription] = await tx.update(billing_subscriptions).set({
              provider_customer_id: event.customerId ?? subscription.provider_customer_id,
              provider_price_id: event.priceId ?? subscription.provider_price_id,
              term_code: event.plan?.term ?? subscription.term_code,
              status: nextStatus,
              cancel_at_period_end: restoresProviderState
                ? event.cancelAtPeriodEnd
                : subscription.cancel_at_period_end,
              current_period_start: restoresProviderState
                ? event.currentPeriodStart
                : subscription.current_period_start,
              current_period_end: restoresProviderState
                ? event.currentPeriodEnd
                : subscription.current_period_end,
              access_ends_at: restoredAccessEndsAt,
              ended_at: terminalStatus ? restoredAccessEndsAt ?? event.createdAt : null,
              dispute_previous_status: null,
              provider_event_created_at: event.createdAt,
              updated_at: event.createdAt,
            }).where(eq(billing_subscriptions.id, subscription.id)).returning();
          }
        }

        if (subscription) {
          const ownedSubscriptions = await tx.select().from(billing_subscriptions)
            .where(eq(billing_subscriptions.user_id, user.id));
          const projectedSubscription = chooseCanonicalAccountSubscription(ownedSubscriptions);
          if (!projectedSubscription) throw new Error('Stripe lifecycle left no owned subscription projection');
          const paid = subscriptionGrantsPlus(projectedSubscription);
          await tx.update(users).set({
            plan: paid ? 'pro' : 'free',
            billing_provider: 'stripe',
            billing_customer_id: projectedSubscription.provider_customer_id,
            billing_subscription_id: projectedSubscription.provider_subscription_id,
            billing_variant_id: projectedSubscription.term_code,
            billing_status: projectedSubscription.status,
            billing_renews_at: projectedSubscription.cancel_at_period_end ? null : projectedSubscription.current_period_end,
            billing_ends_at: projectedSubscription.access_ends_at,
            billing_portal_url: null,
            billing_event_updated_at: event.createdAt,
            entitlement_revision: randomUUID(),
          }).where(eq(users.id, user.id));
        }
        const analyticsName = event.eventName === 'invoice.paid'
          ? 'subscription_renewed'
          : event.eventName === 'invoice.payment_failed' || event.eventName === 'invoice.payment_action_required'
            ? 'payment_failed'
            : event.eventName === 'charge.refunded'
              ? 'refund_completed'
              : event.eventName === 'charge.dispute.created'
                ? 'dispute_opened'
                : event.eventName === 'charge.dispute.closed'
                  ? 'dispute_closed'
                  : isCheckout
                    ? 'checkout_completed'
                    : 'subscription_started';
        await tx.insert(monetization_events).values({
          event_key: `server:${event.eventKey}`,
          user_id: user.id,
          event_name: analyticsName,
          surface: 'api',
          plan_id: event.plan?.id ?? null,
          offer_id: offer?.id ?? null,
          properties: { stripe_event: event.eventName },
          occurred_at: event.createdAt,
        }).onConflictDoNothing({ target: monetization_events.event_key });
        if (!cancelAfterRefund) {
          await tx.update(billing_webhook_events).set({ result: 'processed', processed_at: new Date() })
            .where(eq(billing_webhook_events.event_key, event.eventKey));
        }
        return { ignored: false, userId: user.id, state: subscription?.status ?? 'processed' };
      });
      if (cancelAfterRefund) {
        await cancelStripeSubscriptionOrThrow({
          subscriptionId: cancelAfterRefund,
          idempotencyKey: event.eventKey,
        });
        await db.update(billing_webhook_events).set({ result: 'processed', processed_at: new Date(), last_error: null })
          .where(eq(billing_webhook_events.event_key, event.eventKey));
      }
      fastify.log.info({ event: event.eventName, userId: result.userId, state: result.state }, 'processed Stripe billing lifecycle event');
      return reply.status(200).send({ received: true, provider: 'stripe', processed: !result.ignored, state: result.state });
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : 'unknown billing processing error';
      await db.update(billing_webhook_events).set({ result: 'failed', last_error: message })
        .where(eq(billing_webhook_events.event_key, event.eventKey));
      fastify.log.error({ error, event: event.eventName }, 'Stripe billing event failed transactionally');
      return reply.status(500).send({ error: 'billing event processing failed' });
    }
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
