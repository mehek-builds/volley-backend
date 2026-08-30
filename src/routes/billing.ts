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
import { and, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { allowHourly, getEntitlements, getCount, monthPeriod, rateLimitedReply, upgradeUrl } from '../middleware/quota';
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
import {
  billingCheckoutAvailable,
  billingPlan,
  billingPlanForTerm,
  stripePriceIdForPlan,
  stripeWebhookAvailable,
} from '../lib/billingCatalog';
import {
  billingCheckoutTerms,
  checkoutOfferPolicyVersion,
  type BillingCheckoutTerms,
} from '../lib/billingCheckoutTerms';
import { ENTITLEMENT_POLICY_VERSION, getEntitlementSnapshot } from '../lib/entitlements';
import {
  cancelStripeSubscriptionOrThrow,
  createStripeCheckoutSessionV2,
  expireStripeCheckoutSession,
  parseStripeBillingEvent,
  retrieveStripeBillingAuthority,
  retrieveStripeCheckoutForReconcile,
  retrieveStripeChargeBillingContext,
  secureLegacyBillingPortalUrl,
  stripeSubscriptionAuthority,
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
import { withBillingAccountLock } from '../lib/billingAccountLock';

type CheckoutBody = {
  interval?: 'weekly' | 'monthly' | 'annual';
  plan_id?: 'litos_plus_week' | 'litos_plus_month' | 'litos_plus_quarter';
  idempotency_key?: string;
  surface?: 'website' | 'dashboard' | 'extension';
  placement?: string;
  trigger?: string;
  action_nonce?: string;
  checkout_terms_revision?: string;
};

const checkoutBodySchema = z.object({
  interval: z.enum(['weekly', 'monthly', 'annual']).optional(),
  plan_id: z.enum(['litos_plus_week', 'litos_plus_month', 'litos_plus_quarter']).optional(),
  idempotency_key: z.string().uuid().optional(),
  surface: z.enum(['website', 'dashboard', 'extension', 'api']).optional(),
  placement: z.string().trim().max(120).optional(),
  trigger: z.string().trim().max(120).optional(),
  action_nonce: z.string().min(20).max(200).optional(),
  checkout_terms_revision: z.string().trim().min(20).max(200).optional(),
}).strict();

type CatalogBillingPlan = NonNullable<ReturnType<typeof billingPlan>>;

async function checkoutTermsForUser(input: {
  userId: string;
  isGuest: boolean;
  plan: CatalogBillingPlan;
}, database: typeof db = db) {
  const evaluatedAt = new Date();
  const readSnapshot = () => getEntitlementSnapshot(input.userId, evaluatedAt, database);
  const readAccount = () => database.select({
      billing_provider: users.billing_provider,
      billing_customer_id: users.billing_customer_id,
      billing_status: users.billing_status,
      trial_started_at: users.trial_started_at,
      trial_ends_at: users.trial_ends_at,
    }).from(users).where(eq(users.id, input.userId)).limit(1);
  const [snapshot, accountRows] = database === db
    ? await Promise.all([readSnapshot(), readAccount()])
    : [await readSnapshot(), await readAccount()];
  const account = accountRows[0];
  return {
    account,
    checkoutTerms: billingCheckoutTerms({
      plan: input.plan,
      provider_price_id: stripePriceIdForPlan(input.plan.id),
      account: {
        authenticated: true,
        is_guest: input.isGuest,
        access_class: snapshot.access_class,
        subscription_status: snapshot.subscription?.status ?? null,
        billing_provider: snapshot.subscription?.provider ?? account?.billing_provider ?? null,
        billing_customer_id: account?.billing_customer_id ?? null,
        billing_status: snapshot.subscription?.status ?? account?.billing_status ?? null,
        trial_started_at: account?.trial_started_at ?? null,
        trial_ends_at: account?.trial_ends_at ?? null,
      },
      checkout_available: billingCheckoutAvailable(),
      automatic_tax_enabled: process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true',
    }),
  };
}

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

type StripeCheckoutPersistenceResult =
  | { kind: 'persisted'; offer: typeof pricing_offers.$inferSelect; actionBindingValid: boolean }
  | { kind: 'offer_missing' }
  | { kind: 'provider_conflict'; offer: typeof pricing_offers.$inferSelect };

async function persistStripeCheckoutSession(input: {
  offer: typeof pricing_offers.$inferSelect;
  pendingActionId?: string;
  session: NonNullable<Awaited<ReturnType<typeof createStripeCheckoutSessionV2>>>;
}, database: typeof db = db): Promise<StripeCheckoutPersistenceResult> {
  return database.transaction(async (tx) => {
    if (input.pendingActionId) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`checkout-action:${input.pendingActionId}`}, 0::bigint))`);
    }
    const [currentOffer] = await tx.select().from(pricing_offers).where(and(
      eq(pricing_offers.id, input.offer.id),
      eq(pricing_offers.user_id, input.offer.user_id),
    )).limit(1);
    if (!currentOffer) return { kind: 'offer_missing' as const };
    if (currentOffer.provider_checkout_id && currentOffer.provider_checkout_id !== input.session.id) {
      return { kind: 'provider_conflict' as const, offer: currentOffer };
    }

    let action: typeof pending_premium_actions.$inferSelect | undefined;
    let actionBindingValid = currentOffer.pending_action_id === (input.pendingActionId ?? null)
      && (currentOffer.status === 'creating' || currentOffer.status === 'checkout_created');
    if (input.pendingActionId && actionBindingValid) {
      [action] = await tx.select().from(pending_premium_actions).where(and(
        eq(pending_premium_actions.id, input.pendingActionId),
        eq(pending_premium_actions.user_id, input.offer.user_id),
      )).limit(1);
      if (!action || action.state !== 'pending' || action.expires_at <= new Date()) actionBindingValid = false;
      if (action.offer_id && action.offer_id !== currentOffer.id) {
        const [linkedOffer] = await tx.select().from(pricing_offers)
          .where(eq(pricing_offers.id, action.offer_id)).limit(1);
        if (linkedOffer && ['creating', 'checkout_created', 'paid'].includes(linkedOffer.status)) {
          actionBindingValid = false;
        }
      }
    }

    const now = new Date();
    const liveOffer = currentOffer.status === 'creating' || currentOffer.status === 'checkout_created';
    const [persistedOffer] = await tx.update(pricing_offers).set({
      ...(liveOffer ? { status: 'checkout_created' } : {}),
      provider_checkout_id: input.session.id,
      provider_checkout_url: input.session.url,
      provider_customer_id: input.session.customerId,
      provider_subscription_id: input.session.subscriptionId,
      expires_at: input.session.expiresAt,
      checkout_created_at: currentOffer.checkout_created_at ?? now,
      updated_at: now,
    }).where(and(
      eq(pricing_offers.id, currentOffer.id),
      eq(pricing_offers.user_id, input.offer.user_id),
      or(
        isNull(pricing_offers.provider_checkout_id),
        eq(pricing_offers.provider_checkout_id, input.session.id),
      ),
    )).returning();
    if (!persistedOffer) return { kind: 'provider_conflict' as const, offer: currentOffer };

    if (action && actionBindingValid) {
      const [linked] = await tx.update(pending_premium_actions).set({
        offer_id: persistedOffer.id,
        expires_at: input.session.expiresAt,
      }).where(and(
        eq(pending_premium_actions.id, action.id),
        eq(pending_premium_actions.user_id, persistedOffer.user_id),
        eq(pending_premium_actions.state, 'pending'),
      )).returning({ id: pending_premium_actions.id });
      if (!linked) actionBindingValid = false;
    }
    return { kind: 'persisted' as const, offer: persistedOffer, actionBindingValid };
  });
}

type StripeCheckoutRepairResult =
  | { kind: 'ready'; offer: typeof pricing_offers.$inferSelect }
  | { kind: 'terms_changed'; checkoutTerms: BillingCheckoutTerms }
  | { kind: 'already_plus' }
  | { kind: 'recovery_required' }
  | { kind: 'action_binding_conflict' }
  | { kind: 'checkout_expired' }
  | { kind: 'in_progress' };

async function replayCheckoutOffer(
  reply: FastifyReply,
  prior: typeof pricing_offers.$inferSelect,
  expected: {
    term: string;
    trigger: string;
    surface: string;
    placement?: string;
    pendingActionId?: string;
    checkoutTerms: BillingCheckoutTerms;
  },
  conflict: 'idempotency_conflict' | 'checkout_in_progress' = 'idempotency_conflict',
  repairCreating?: () => Promise<StripeCheckoutRepairResult | null>,
) {
  const acceptedPolicyVersion = checkoutOfferPolicyVersion(
    ENTITLEMENT_POLICY_VERSION,
    expected.checkoutTerms.revision,
  );
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
  if (prior.status === 'paid') {
    return reply.status(409).send({
      error: 'This account already has Litos+.',
      code: 'already_plus',
      portal_url: '/billing/portal',
    });
  }
  if (prior.policy_version !== acceptedPolicyVersion) {
    /* Never put current terms beside an older Stripe Session. The provider Session must become
       unusable before the local row releases the account's one-live checkout slot. If Stripe
       cannot confirm expiration, keep the lock so two usable subscription Sessions cannot exist. */
    const isLive = (prior.status === 'creating' || prior.status === 'checkout_created')
      && prior.expires_at > new Date();
    if (isLive) {
      /* A stale creating row cannot be repaired safely. The retry closure uses current plan and
         trial inputs, while Stripe may already hold an older request under the same key. */
      const providerState = prior.provider_checkout_id
        ? await expireStripeCheckoutSession({ offerId: prior.id, sessionId: prior.provider_checkout_id })
        : 'unknown';
      if (providerState === 'completed') {
        const reconciled = await reconcileStripeCheckoutOffer(prior).catch(() => 'unverified' as const);
        if (reconciled === 'grants_plus') {
          return reply.status(409).send({
            error: 'This account already has Litos+.',
            code: 'already_plus',
            portal_url: '/billing/portal',
          });
        }
        if (reconciled === 'recovery_required') {
          return reply.status(409).send({
            error: 'Resolve the existing billing account before starting another subscription.',
            code: 'billing_recovery_required',
            portal_url: '/billing/portal',
          });
        }
        if (reconciled === 'terminal_without_plus') {
          return reply.status(409).send({
            error: 'Checkout terms changed. Review the current terms before continuing.',
            code: 'checkout_terms_changed',
            checkout_terms: expected.checkoutTerms,
          });
        }
      }
      if (providerState !== 'expired') {
        return reply.status(409).send({
          error: 'Another checkout is already in progress for this account.',
          code: 'checkout_in_progress',
        });
      }
      await db.update(pricing_offers).set({ status: 'expired', updated_at: new Date() }).where(and(
        eq(pricing_offers.id, prior.id),
        eq(pricing_offers.user_id, prior.user_id),
        eq(pricing_offers.provider_checkout_id, prior.provider_checkout_id!),
        inArray(pricing_offers.status, ['creating', 'checkout_created']),
      ));
    }
    return reply.status(409).send({
      error: 'Checkout terms changed. Review the current terms before continuing.',
      code: 'checkout_terms_changed',
      checkout_terms: expected.checkoutTerms,
    });
  }
  let replayed = prior;
  if (replayed.status === 'creating' && replayed.expires_at > new Date() && repairCreating) {
    const repaired = await repairCreating();
    if (!repaired) {
      return reply.status(503).send({ error: 'Checkout is temporarily unavailable.', code: 'checkout_failed' });
    }
    if (repaired.kind === 'already_plus') {
      return reply.status(409).send({
        error: 'This account already has Litos+.',
        code: 'already_plus',
        portal_url: '/billing/portal',
      });
    }
    if (repaired.kind === 'recovery_required') {
      return reply.status(409).send({
        error: 'Resolve the existing billing account before starting another subscription.',
        code: 'billing_recovery_required',
        portal_url: '/billing/portal',
      });
    }
    if (repaired.kind === 'action_binding_conflict') {
      return reply.status(409).send({
        error: 'The checkout and pending action no longer match.',
        code: 'action_binding_conflict',
      });
    }
    if (repaired.kind === 'checkout_expired') {
      return reply.status(409).send({
        error: 'This checkout attempt can no longer be reused.',
        code: 'checkout_expired',
      });
    }
    if (repaired.kind === 'terms_changed') {
      return reply.status(409).send({
        error: 'Checkout terms changed. Review the current terms before continuing.',
        code: 'checkout_terms_changed',
        checkout_terms: repaired.checkoutTerms,
      });
    }
    if (repaired.kind === 'in_progress') {
      return reply.status(409).send({
        error: 'Another checkout is already in progress for this account.',
        code: 'checkout_in_progress',
      });
    }
    replayed = repaired.offer;
  }
  if (replayed.status === 'paid') {
    return reply.status(409).send({
      error: 'This account already has Litos+.',
      code: 'already_plus',
      portal_url: '/billing/portal',
    });
  }
  if (!(await repairCheckoutActionBinding(replayed, expected.pendingActionId))) {
    return reply.status(409).send({
      error: 'The checkout and pending action no longer match.',
      code: 'action_binding_conflict',
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
      checkout_terms: expected.checkoutTerms,
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
      checkout_terms: expected.checkoutTerms,
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

/**
 * Project a provider-confirmed completed Session before any local expiry can release its lock.
 * Session and account ownership are proved against the immutable offer before the user or offer
 * rows move. A false result means the caller must retain the live lock.
 */
async function reconcileStripeCheckoutOfferUnlocked(
  offer: typeof pricing_offers.$inferSelect,
  database: typeof db,
): Promise<'grants_plus' | 'terminal_without_plus' | 'recovery_required' | 'unverified'> {
  const providerCheckoutId = offer.provider_checkout_id;
  if (!providerCheckoutId) return 'unverified';
  const pair = await retrieveStripeCheckoutForReconcile({ sessionId: providerCheckoutId });
  if (!pair) return 'unverified';
  const sessionOfferId = typeof pair.session.client_reference_id === 'string'
    ? pair.session.client_reference_id
    : null;
  const sessionUserId = typeof pair.session.metadata?.litos_user_id === 'string'
    ? pair.session.metadata.litos_user_id
    : null;
  if (sessionOfferId !== offer.id || sessionUserId !== offer.user_id) return 'unverified';
  const offerPlan = billingPlanForTerm(offer.term_code);
  if (!offerPlan || !offer.provider_price_id) return 'unverified';
  const authority = stripeSubscriptionAuthority(pair.subscription, {
    priceId: offer.provider_price_id,
    plan: offerPlan,
  });
  if (!authority) return 'unverified';
  const sessionCustomerId = typeof pair.session.customer?.id === 'string'
    ? pair.session.customer.id
    : typeof pair.session.customer === 'string'
      ? pair.session.customer
      : null;
  if (sessionCustomerId && sessionCustomerId !== authority.customerId) return 'unverified';
  if (authority.userId && authority.userId !== offer.user_id) return 'unverified';
  if (authority.offerId && authority.offerId !== offer.id) return 'unverified';

  const reconciledAt = new Date();
  const terminal = authority.status === 'canceled'
    || authority.status === 'incomplete_expired';
  const recoveryRequired = subscriptionNeedsPortalRecovery(authority.status);
  const paymentConfirmed = pair.paymentStatus === 'paid' || pair.paymentStatus === 'no_payment_required';
  /* Do not let an unpaid Session project an access-granting provider state. Stripe normally pairs
     unpaid with incomplete, but an unexpected active shape must retain its lock until a webhook or
     later provider read resolves the contradiction. */
  if (!paymentConfirmed && subscriptionGrantsPlus(authority, reconciledAt) && !recoveryRequired) {
    return 'unverified';
  }
  if (!terminal && !recoveryRequired && !(paymentConfirmed && subscriptionGrantsPlus(authority, reconciledAt))) {
    return 'unverified';
  }
  const outcome = await database.transaction(async (tx) => {
    await tx.insert(billing_subscriptions).values({
      user_id: offer.user_id,
      provider: 'stripe',
      provider_customer_id: authority.customerId,
      provider_subscription_id: authority.subscriptionId,
      provider_price_id: authority.priceId,
      product_code: 'litos_plus',
      term_code: authority.plan.term,
      status: authority.status,
      cancel_at_period_end: authority.cancelAtPeriodEnd,
      current_period_start: authority.currentPeriodStart,
      current_period_end: authority.currentPeriodEnd,
      access_ends_at: authority.accessEndsAt,
      ended_at: terminal ? authority.accessEndsAt ?? reconciledAt : null,
      provider_event_created_at: reconciledAt,
      updated_at: reconciledAt,
    }).onConflictDoUpdate({
      target: billing_subscriptions.provider_subscription_id,
      set: {
        provider_customer_id: authority.customerId,
        provider_price_id: authority.priceId,
        term_code: authority.plan.term,
        status: authority.status,
        cancel_at_period_end: authority.cancelAtPeriodEnd,
        current_period_start: authority.currentPeriodStart,
        current_period_end: authority.currentPeriodEnd,
        access_ends_at: authority.accessEndsAt,
        ended_at: terminal ? authority.accessEndsAt ?? reconciledAt : null,
        provider_event_created_at: reconciledAt,
        updated_at: reconciledAt,
      },
    });
    const ownedSubscriptions = await tx.select().from(billing_subscriptions)
      .where(eq(billing_subscriptions.user_id, offer.user_id));
    const projectedSubscription = chooseCanonicalAccountSubscription(ownedSubscriptions, reconciledAt);
    if (!projectedSubscription) throw new Error('Stripe reconciliation left no subscription projection');
    const projectedGrantsPlus = subscriptionGrantsPlus(projectedSubscription, reconciledAt);
    const result = recoveryRequired
      ? 'recovery_required' as const
      : projectedGrantsPlus
        ? 'grants_plus' as const
        : terminal && !projectedGrantsPlus
          ? 'terminal_without_plus' as const
          : 'unverified' as const;
    const offerStatus = terminal
      ? pair.paymentStatus === 'unpaid' ? 'failed' : 'paid'
      : result === 'grants_plus' ? 'paid' : offer.status;
    await tx.update(pricing_offers).set({
      status: offerStatus,
      provider_customer_id: authority.customerId,
      provider_subscription_id: authority.subscriptionId,
      paid_at: pair.paymentStatus === 'unpaid' ? offer.paid_at : offer.paid_at ?? reconciledAt,
      completed_at: reconciledAt,
      verified_at: reconciledAt,
      updated_at: reconciledAt,
    }).where(and(
      eq(pricing_offers.id, offer.id),
      eq(pricing_offers.user_id, offer.user_id),
      eq(pricing_offers.provider_checkout_id, providerCheckoutId),
    ));
    await tx.update(users).set({
      plan: projectedGrantsPlus ? 'pro' : 'free',
      billing_provider: 'stripe',
      billing_customer_id: projectedSubscription.provider_customer_id,
      billing_subscription_id: projectedSubscription.provider_subscription_id,
      billing_variant_id: projectedSubscription.term_code,
      billing_status: projectedSubscription.status,
      billing_renews_at: projectedSubscription.cancel_at_period_end
        ? null
        : projectedSubscription.current_period_end,
      billing_ends_at: projectedSubscription.access_ends_at,
      billing_portal_url: null,
      billing_event_updated_at: reconciledAt,
      entitlement_revision: randomUUID(),
    }).where(eq(users.id, offer.user_id));
    return result;
  });
  return outcome;
}

async function reconcileStripeCheckoutOffer(
  offer: typeof pricing_offers.$inferSelect,
): Promise<'grants_plus' | 'terminal_without_plus' | 'recovery_required' | 'unverified'> {
  return withBillingAccountLock(
    offer.user_id,
    (lockedDb) => reconcileStripeCheckoutOfferUnlocked(offer, lockedDb),
  );
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

  /**
   * Reconcile a finished Stripe checkout without waiting to be told about it.
   *
   * THE STUCK LOOP THIS ENDS. Paid state was written only by the webhook, so the
   * browser could easily beat it home: Stripe redirects the moment the card is
   * accepted, the return page reads an account that still says Free, and the
   * student who has just subscribed is shown the plan screen again. With no free
   * escape on that screen (by design) there is no way out of the loop, and if the
   * webhook is misconfigured rather than merely slow it never resolves at all.
   * That is not hypothetical: production answered 503 to every Stripe event on
   * 2026-08-19 because STRIPE_WEBHOOK_SECRET was not a whsec_ value, and nothing
   * in the product could tell.
   *
   * A webhook is best effort by nature. The return path now asks Stripe what
   * happened instead of hoping it was told, which makes the webhook a backstop
   * rather than the only writer.
   *
   * IT WRITES THE CANONICAL SUBSCRIPTION FIRST. The reconciliation helper uses the
   * same billing_subscriptions projection and account-selection policy as the
   * webhook. A trial therefore stays trial_plus instead of falling through the
   * legacy users row as unmetered paid access.
   *
   * Ownership is proved, not assumed. The offer is looked up scoped to the caller,
   * and the session must carry that offer as its client_reference_id and the
   * caller as litos_user_id. A session id arriving through the browser is
   * attacker-supplied until Stripe and our own row agree on whose it is.
   */
  fastify.post('/billing/reconcile', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId, isGuest } = request.jwtPayload!;
    if (isGuest) {
      return reply.status(409).send({ error: 'Verify an email before starting checkout.', code: 'claim_required' });
    }
    // This calls Stripe, so it is metered. Generous enough for a real return
    // (which reconciles once) and tight enough that it is not a free proxy.
    if (!await allowHourly(`user:${userId}`, 'billing-reconcile', 30)) return rateLimitedReply(reply);

    const body = jsonBody<{ offer_id?: unknown }>(request.body) ?? {};
    const requestedOfferId = typeof body.offer_id === 'string' ? body.offer_id : null;

    const offers = await db.select().from(pricing_offers).where(and(
      eq(pricing_offers.user_id, userId),
      ...(requestedOfferId ? [eq(pricing_offers.id, requestedOfferId)] : []),
    )).orderBy(desc(pricing_offers.created_at)).limit(requestedOfferId ? 1 : 5);

    const offer = offers.find((row) => typeof row.provider_checkout_id === 'string' && row.provider_checkout_id);
    if (!offer?.provider_checkout_id) {
      return reply.status(200).send({ reconciled: false, reason: 'no_checkout' });
    }

    const result = await reconcileStripeCheckoutOffer(offer).catch((error) => {
      fastify.log.error({ error, offerId: offer.id }, 'live Stripe checkout reconciliation failed');
      return 'unverified' as const;
    });
    // An abandoned, pending-payment, or still-open Session is ordinary here. It must not move
    // access and must not be reported as a successful reconciliation.
    if (result === 'unverified') {
      return reply.status(200).send({ reconciled: false, reason: 'not_complete' });
    }
    if (result === 'recovery_required') {
      return reply.status(409).send({
        error: 'Resolve the existing billing account before starting another subscription.',
        code: 'billing_recovery_required',
        portal_url: '/billing/portal',
      });
    }
    const snapshot = await getEntitlementSnapshot(userId);
    return reply.header('Cache-Control', 'private, no-store').status(200).send({
      reconciled: true,
      access_class: snapshot.access_class,
      entitlements: snapshot,
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
      !body.plan_id
      && !body.checkout_terms_revision
      && process.env.LITOS_BILLING_ENABLED !== 'true'
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

    const legacyOnboardingDisclosure = Boolean(body.plan_id)
      && body.surface === 'website'
      && body.placement === 'onboarding'
      && body.trigger === 'start_plan'
      && !body.action_nonce;
    const checkoutTermsFailure = (checkoutTerms: BillingCheckoutTerms, logMissingRevision: boolean) => {
      if (checkoutTerms.checkout_status === 'billing_recovery_required') {
        return {
          status: 409,
          payload: {
            error: 'Resolve the existing billing account before starting another subscription.',
            code: 'billing_recovery_required',
            portal_url: '/billing/portal',
          },
        };
      }
      if (checkoutTerms.checkout_status === 'already_plus') {
        return {
          status: 409,
          payload: { error: 'This account already has Litos+.', code: 'already_plus', portal_url: '/billing/portal' },
        };
      }
      if (checkoutTerms.checkout_status === 'billing_not_configured') {
        return {
          status: 503,
          payload: { error: 'Checkout is temporarily unavailable.', code: 'billing_not_configured' },
        };
      }
      if (body.checkout_terms_revision && body.checkout_terms_revision !== checkoutTerms.revision) {
        return {
          status: 409,
          payload: {
            error: 'Checkout terms changed. Review the current terms before continuing.',
            code: 'checkout_terms_changed',
            checkout_terms: checkoutTerms,
          },
        };
      }
      if (!body.checkout_terms_revision) {
        /* Compatibility exists only for the older onboarding client whose exact seven-day-trial
           disclosure remains true for this account. The locked reservation repeats this check so
           an entitlement transition cannot spend a stale compatibility exception. */
        if (logMissingRevision) {
          request.log.warn({
            userId,
            planId: plan.id,
            legacyOnboardingDisclosure,
            strict: process.env.LITOS_CHECKOUT_TERMS_REVISION_REQUIRED === 'true',
          }, 'checkout request omitted the terms revision');
        }
        if (
          process.env.LITOS_CHECKOUT_TERMS_REVISION_REQUIRED === 'true'
          || !legacyOnboardingDisclosure
          || checkoutTerms.trial_eligible !== true
        ) {
          return {
            status: 409,
            payload: {
              error: 'Review the current checkout terms in the latest Litos client before continuing.',
              code: 'checkout_terms_revision_required',
              checkout_terms: checkoutTerms,
            },
          };
        }
      }
      return null;
    };

    /* Fast preflight. The same checks run again while the account reservation lock is held, so this
       early answer saves work but never authorizes a Session or a reusable URL. */
    const initialTerms = await checkoutTermsForUser({ userId, isGuest, plan });
    const initialTermsFailure = checkoutTermsFailure(initialTerms.checkoutTerms, true);
    if (initialTermsFailure) {
      return reply.status(initialTermsFailure.status).send(initialTermsFailure.payload);
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
    const checkoutNow = new Date();
    const liveOfferStatuses = ['creating', 'checkout_created'];
    const expiredCandidates = await db.select().from(pricing_offers).where(and(
      eq(pricing_offers.user_id, userId),
      eq(pricing_offers.product_code, 'litos_plus'),
      inArray(pricing_offers.status, liveOfferStatuses),
      lte(pricing_offers.expires_at, checkoutNow),
    ));
    for (const candidate of expiredCandidates) {
      if (candidate.provider_checkout_id) {
        const providerState = await expireStripeCheckoutSession({
          offerId: candidate.id,
          sessionId: candidate.provider_checkout_id,
        });
        if (providerState === 'completed') {
          const reconciled = await reconcileStripeCheckoutOffer(candidate).catch((error) => {
            request.log.error({ error, offerId: candidate.id }, 'completed checkout reconciliation failed');
            return 'unverified' as const;
          });
          if (reconciled === 'grants_plus') {
            return reply.status(409).send({
              error: 'This account already has Litos+.',
              code: 'already_plus',
              portal_url: '/billing/portal',
            });
          }
          if (reconciled === 'recovery_required') {
            return reply.status(409).send({
              error: 'Resolve the existing billing account before starting another subscription.',
              code: 'billing_recovery_required',
              portal_url: '/billing/portal',
            });
          }
          if (reconciled === 'terminal_without_plus') {
            /* Reconciliation just changed customer ownership and trial eligibility. This request's
               preview was computed before that provider state was known, so it cannot safely create
               a replacement Session. Make the client fetch and accept a fresh revision first. */
            return reply.status(409).send({
              error: 'Billing state changed. Review the current checkout terms before continuing.',
              code: 'checkout_terms_changed',
            });
          }
        }
        if (providerState !== 'expired') {
          return reply.status(409).send({
            error: 'Another checkout is already in progress for this account.',
            code: 'checkout_in_progress',
          });
        }
      }
      await db.update(pricing_offers).set({ status: 'expired', updated_at: checkoutNow }).where(and(
        eq(pricing_offers.id, candidate.id),
        eq(pricing_offers.user_id, userId),
        inArray(pricing_offers.status, liveOfferStatuses),
        lte(pricing_offers.expires_at, checkoutNow),
      ));
    }
    /* This is the actual reservation decision. All checkout requests and billing projections share
       the same entitlement lock, so terms, idempotency, the live slot, and the inserted policy are
       one serial account snapshot. The lock is released before Stripe I/O. */
    const reservation = await withBillingAccountLock(userId, async (lockedDb) => {
      const fresh = await checkoutTermsForUser({ userId, isGuest, plan }, lockedDb);
      const termsFailure = checkoutTermsFailure(fresh.checkoutTerms, false);
      if (termsFailure) return { kind: 'response' as const, ...termsFailure };
      const expectedOffer = {
        term: plan.term,
        trigger: body.trigger ?? 'account_upgrade',
        surface: body.surface ?? 'dashboard',
        placement: body.placement,
        pendingActionId: action?.id,
        checkoutTerms: fresh.checkoutTerms,
      };
      const existing = await lockedDb.select().from(pricing_offers).where(and(
        eq(pricing_offers.user_id, userId),
        eq(pricing_offers.client_idempotency_key, idempotencyKey),
      )).limit(1);
      if (existing[0]) {
        return {
          kind: 'offer' as const,
          offer: existing[0],
          conflict: 'idempotency_conflict' as const,
          repairAllowed: true,
          expectedOffer,
          account: fresh.account,
        };
      }
      const [liveOffer] = await lockedDb.select().from(pricing_offers).where(and(
        eq(pricing_offers.user_id, userId),
        eq(pricing_offers.product_code, 'litos_plus'),
        inArray(pricing_offers.status, liveOfferStatuses),
        gt(pricing_offers.expires_at, new Date()),
      )).limit(1);
      if (liveOffer) {
        return {
          kind: 'offer' as const,
          offer: liveOffer,
          conflict: 'checkout_in_progress' as const,
          repairAllowed: liveOffer.client_idempotency_key === idempotencyKey,
          expectedOffer,
          account: fresh.account,
        };
      }
      const offerId = randomUUID();
      // Stripe requires at least 30 minutes. The extra minute covers live Price verification.
      const expiresAt = new Date(Date.now() + 31 * 60 * 1000);
      const [insertedOffer] = await lockedDb.insert(pricing_offers).values({
        id: offerId,
        user_id: userId,
        subject_id: email.trim().toLowerCase(),
        idempotency_key: `v2:${idempotencyKey}`,
        policy_version: checkoutOfferPolicyVersion(ENTITLEMENT_POLICY_VERSION, fresh.checkoutTerms.revision),
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
        provider_price_id: stripePriceIdForPlan(plan.id),
        surface: expectedOffer.surface,
        placement: body.placement,
        trigger: expectedOffer.trigger,
        client_idempotency_key: idempotencyKey,
        pending_action_id: action?.id,
      }).onConflictDoNothing().returning();
      if (insertedOffer) {
        return {
          kind: 'offer' as const,
          offer: insertedOffer,
          conflict: 'idempotency_conflict' as const,
          repairAllowed: true,
          expectedOffer,
          account: fresh.account,
        };
      }
      const [racedOffer] = await lockedDb.select().from(pricing_offers).where(and(
        eq(pricing_offers.user_id, userId),
        eq(pricing_offers.product_code, 'litos_plus'),
        inArray(pricing_offers.status, liveOfferStatuses),
      )).limit(1);
      if (!racedOffer) throw new Error('Checkout idempotency conflict did not return an offer');
      return {
        kind: 'offer' as const,
        offer: racedOffer,
        conflict: racedOffer.client_idempotency_key === idempotencyKey
          ? 'idempotency_conflict' as const
          : 'checkout_in_progress' as const,
        repairAllowed: racedOffer.client_idempotency_key === idempotencyKey,
        expectedOffer,
        account: fresh.account,
      };
    });
    if (reservation.kind === 'response') {
      return reply.status(reservation.status).send(reservation.payload);
    }

    const repairCreatingOffer = async (
      offer: typeof pricing_offers.$inferSelect,
    ): Promise<StripeCheckoutRepairResult | null> => {
      const session = await createStripeCheckoutSessionV2({
        offerId: offer.id,
        userId,
        email,
        planId: plan.id,
        idempotencyKey,
        actionId: action?.id,
        actionNonce: body.action_nonce,
        surface: reservation.expectedOffer.surface,
        existingCustomerId: reservation.account?.billing_provider === 'stripe'
          ? reservation.account.billing_customer_id
          : null,
        expiresAt: offer.expires_at,
        trialDays: reservation.expectedOffer.checkoutTerms.trial_days ?? 0,
      });
      if (!session) return null;

      /* Stripe I/O deliberately happens outside the account lock. When it returns, attach the
         provider identity while holding that lock, then compare the current account policy with
         the immutable reservation before any URL can leave this process. */
      let checked: {
        persistence: StripeCheckoutPersistenceResult;
        checkoutTerms: BillingCheckoutTerms;
        policyMatches: boolean;
      } | null = null;
      try {
        checked = await withBillingAccountLock(userId, async (lockedDb) => {
          const current = await checkoutTermsForUser({ userId, isGuest, plan }, lockedDb);
          const persistence = await persistStripeCheckoutSession(
            { offer, pendingActionId: action?.id, session },
            lockedDb,
          );
          return {
            persistence,
            checkoutTerms: current.checkoutTerms,
            policyMatches: persistence.kind === 'persisted'
              && persistence.actionBindingValid
              && (persistence.offer.status === 'creating' || persistence.offer.status === 'checkout_created')
              && offer.policy_version === checkoutOfferPolicyVersion(
                ENTITLEMENT_POLICY_VERSION,
                current.checkoutTerms.revision,
              ),
          };
        });
      } catch (error) {
        request.log.error({ error, offerId: offer.id }, 'Stripe checkout Session persistence failed');
      }
      if (checked?.policyMatches && checked.persistence.kind === 'persisted') {
        return { kind: 'ready', offer: checked.persistence.offer };
      }

      /* A known provider Session is now bound to the local offer but cannot be shown under stale
         terms. Make it unusable at Stripe before releasing the live local slot. */
      const providerState = await expireStripeCheckoutSession({
        offerId: offer.id,
        sessionId: session.id,
      });
      if (providerState === 'completed') {
        const trackedOffer = checked?.persistence.kind === 'persisted'
          ? checked.persistence.offer
          : { ...offer, provider_checkout_id: session.id, provider_checkout_url: session.url };
        const reconciled = await reconcileStripeCheckoutOffer(trackedOffer).catch((error) => {
          request.log.error({ error, offerId: offer.id }, 'stale checkout reconciliation failed');
          return 'unverified' as const;
        });
        if (reconciled === 'grants_plus') return { kind: 'already_plus' };
        if (reconciled === 'recovery_required') return { kind: 'recovery_required' };
        if (reconciled === 'terminal_without_plus') {
          const current = await checkoutTermsForUser({ userId, isGuest, plan });
          return { kind: 'terms_changed', checkoutTerms: current.checkoutTerms };
        }
        return { kind: 'in_progress' };
      }
      if (providerState !== 'expired') return { kind: 'in_progress' };
      if (checked?.persistence.kind === 'provider_conflict') return { kind: 'in_progress' };
      let current: Awaited<ReturnType<typeof checkoutTermsForUser>>;
      try {
        current = await withBillingAccountLock(userId, async (lockedDb) => {
          const [released] = await lockedDb.update(pricing_offers).set({
            status: 'expired',
            provider_checkout_id: session.id,
            provider_checkout_url: session.url,
            provider_customer_id: session.customerId,
            provider_subscription_id: session.subscriptionId,
            updated_at: new Date(),
          }).where(and(
            eq(pricing_offers.id, offer.id),
            eq(pricing_offers.user_id, userId),
            inArray(pricing_offers.status, liveOfferStatuses),
            or(
              isNull(pricing_offers.provider_checkout_id),
              eq(pricing_offers.provider_checkout_id, session.id),
            ),
          )).returning({ id: pricing_offers.id });
          if (!released && checked?.persistence.kind !== 'persisted') {
            throw new Error('Expired Stripe Session could not be attached to its local offer');
          }
          return checkoutTermsForUser({ userId, isGuest, plan }, lockedDb);
        });
      } catch (error) {
        request.log.error({ error, offerId: offer.id }, 'expired Stripe Session persistence failed');
        return { kind: 'in_progress' };
      }
      if (current.checkoutTerms.checkout_status === 'already_plus') return { kind: 'already_plus' };
      if (current.checkoutTerms.checkout_status === 'billing_recovery_required') return { kind: 'recovery_required' };
      if (checked?.persistence.kind === 'persisted' && !checked.persistence.actionBindingValid) {
        return { kind: 'action_binding_conflict' };
      }
      const currentPolicy = checkoutOfferPolicyVersion(
        ENTITLEMENT_POLICY_VERSION,
        current.checkoutTerms.revision,
      );
      if (offer.policy_version !== currentPolicy) {
        return { kind: 'terms_changed', checkoutTerms: current.checkoutTerms };
      }
      return { kind: 'checkout_expired' };
    };

    return replayCheckoutOffer(
      reply,
      reservation.offer,
      reservation.expectedOffer,
      reservation.conflict,
      reservation.repairAllowed ? () => repairCreatingOffer(reservation.offer) : undefined,
    );
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
        let offer = event.offerId
          ? (await tx.select().from(pricing_offers).where(eq(pricing_offers.id, event.offerId)).limit(1))[0]
          : undefined;
        let subscription = event.subscriptionId
          ? (await tx.select().from(billing_subscriptions)
            .where(eq(billing_subscriptions.provider_subscription_id, event.subscriptionId)).limit(1))[0]
          : undefined;
        if (requiresProviderAuthority) {
          const immutablePlan = billingPlanForTerm(offer?.term_code ?? subscription?.term_code);
          const immutablePriceId = offer?.provider_price_id ?? subscription?.provider_price_id;
          const acceptedPrice = immutablePlan && immutablePriceId
            ? { priceId: immutablePriceId, plan: immutablePlan }
            : undefined;
          const authority = await retrieveStripeBillingAuthority({ event, acceptedPrice });
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
          if (!offer && event.offerId) {
            offer = (await tx.select().from(pricing_offers)
              .where(eq(pricing_offers.id, event.offerId)).limit(1))[0];
          }
          if (!subscription && event.subscriptionId) {
            subscription = (await tx.select().from(billing_subscriptions)
              .where(eq(billing_subscriptions.provider_subscription_id, event.subscriptionId)).limit(1))[0];
          }
        }
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
        if (user) {
          /* Checkout uses this same account lock for both its reservation and post-Stripe policy
             check. Billing projection waits here before mutating any offer, subscription, or user. */
          await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`entitlement:${user.id}`}, 0::bigint))`);
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
          const plan = billingPlanForTerm(offer.term_code);
          if (!plan
            || !offer.provider_price_id
            || event.priceId !== offer.provider_price_id
            || event.plan?.term !== plan.term) {
            throw new Error('Stripe checkout price does not match the immutable offer');
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
    const projection = await withBillingAccountLock(user.id, async (lockedDb) => {
      const [current] = await lockedDb.select().from(users).where(eq(users.id, user.id)).limit(1);
      if (!current) return 'missing' as const;
      if (current.billing_event_updated_at && parsed.updatedAt < current.billing_event_updated_at) {
        return 'stale' as const;
      }
      await lockedDb.update(users).set({
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
        entitlement_revision: randomUUID(),
      }).where(eq(users.id, user.id));
      return 'applied' as const;
    });
    if (projection === 'missing') {
      return reply.status(422).send({ error: 'account not found' });
    }
    if (projection === 'stale') {
      return reply.status(200).send({ received: true, ignored: true, reason: 'stale_event' });
    }

    fastify.log.info({ userId: user.id, status: parsed.status, plan }, 'synced Lemon Squeezy subscription');
    return reply.status(200).send({ received: true });
  });
}
