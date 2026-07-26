import { createHash, createHmac, randomUUID } from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index';
import {
  billing_webhook_events,
  pricing_experiment_assignments,
  pricing_offers,
  users,
} from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { getEntitlements, getCount, monthPeriod, upgradeUrl } from '../middleware/quota';
import {
  createLemonSqueezyCheckout,
  getLemonSqueezyCustomerCountry,
  lemonSqueezyApiReady,
  lemonSqueezyVariantId,
  parseLemonSqueezySubscription,
  planForLemonSqueezyStatus,
  verifyLemonSqueezySignature,
  verifyLemonSqueezyAccountToken,
} from '../lib/lemonSqueezy';
import {
  normalizeCountryCode,
  parsePricingExperiment,
  resolvePricingOffer,
  signPricingQuote,
  SUPPORTED_COUNTRY_CODES,
  verifyPricingQuote,
} from '../lib/regionalPricing';
import type { PricingOffer } from '../lib/regionalPricing';

const pricingQuerySchema = z.object({
  subject_id: z.string().uuid(),
  country_code: z.string().length(2).optional(),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
});

const checkoutBodySchema = z.object({
  subject_id: z.string().uuid().optional(),
  country_code: z.string().length(2).optional(),
  interval: z.enum(['monthly', 'yearly']).default('monthly'),
  quote_token: z.string().max(4096).optional(),
});

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function detectedCountryFromRequest(request: FastifyRequest): string | null {
  return normalizeCountryCode(
    firstHeader(request.headers['x-vercel-ip-country'])
      ?? firstHeader(request.headers['cf-ipcountry'])
      ?? firstHeader(request.headers['cloudfront-viewer-country']),
  );
}

function pricingSecret(): string | null {
  return process.env.PRICING_SIGNING_SECRET?.trim()
    || process.env.LEMONSQUEEZY_WEBHOOK_SECRET?.trim()
    || (process.env.NODE_ENV === 'production' ? null : 'local-pricing-secret');
}

function publicOffer(offer: PricingOffer, quoteToken: string | null) {
  return {
    policy_version: offer.policyVersion,
    country_code: offer.countryCode,
    detected_country_code: offer.detectedCountryCode,
    requested_country_code: offer.requestedCountryCode,
    country_mismatch: offer.countryMismatch,
    band: offer.band,
    interval: offer.interval,
    currency: offer.currency,
    base_amount_cents: offer.baseAmountCents,
    amount_cents: offer.amountCents,
    experiment_id: offer.experimentId,
    experiment_variant: offer.experimentVariant,
    quote_token: quoteToken,
  };
}

function idempotencyKey(userId: string, offer: PricingOffer, now: Date): string {
  const bucket = Math.floor(now.getTime() / (15 * 60 * 1000));
  return createHash('sha256').update([
    userId,
    offer.policyVersion,
    offer.countryCode,
    offer.band,
    offer.interval,
    offer.experimentId ?? 'none',
    offer.experimentVariant,
    String(offer.amountCents),
    String(bucket),
  ].join(':')).digest('hex');
}

async function stickyVariant(userId: string, experimentId: string | null): Promise<string | null> {
  if (!experimentId) return null;
  const rows = await db.select({ variant: pricing_experiment_assignments.variant })
    .from(pricing_experiment_assignments)
    .where(and(
      eq(pricing_experiment_assignments.user_id, userId),
      eq(pricing_experiment_assignments.experiment_id, experimentId),
    ))
    .limit(1);
  return rows[0]?.variant ?? null;
}

async function persistAssignment(userId: string, experimentId: string | null, variant: string): Promise<string> {
  if (!experimentId) return variant;
  await db.insert(pricing_experiment_assignments).values({
    user_id: userId,
    experiment_id: experimentId,
    variant,
  }).onConflictDoNothing();
  return await stickyVariant(userId, experimentId) ?? variant;
}

export async function billingRoutes(fastify: FastifyInstance) {
  fastify.get('/billing/pricing', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = pricingQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'A valid pricing subject, country, and interval are required.' });
    const secret = pricingSecret();
    if (!secret) return reply.status(503).send({ error: 'Regional pricing is temporarily unavailable.' });
    const offer = resolvePricingOffer({
      subjectId: parsed.data.subject_id,
      detectedCountryCode: detectedCountryFromRequest(request),
      requestedCountryCode: parsed.data.country_code,
      interval: parsed.data.interval,
      experiment: parsePricingExperiment(),
      experimentSecret: secret,
    });
    const quoteToken = signPricingQuote(offer, parsed.data.subject_id, new Date(), secret);
    return reply.header('Cache-Control', 'private, no-store').status(200).send({
      offer: publicOffer(offer, quoteToken),
      countries: SUPPORTED_COUNTRY_CODES,
    });
  });

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
    return reply.status(200).send({
      email: email ?? null,
      is_guest: isGuest,
      tier: ent.tier,
      trial_ends_at: user?.trial_ends_at ?? null,
      guest_expires_at: user?.guest_expires_at ?? null,
      billing_provider: 'lemonsqueezy',
      checkout_available: lemonSqueezyApiReady('monthly'),
      checkout_intervals: {
        monthly: lemonSqueezyApiReady('monthly'),
        yearly: lemonSqueezyApiReady('yearly'),
      },
      billing_status: user?.billing_status ?? null,
      billing_renews_at: user?.billing_renews_at ?? null,
      billing_ends_at: user?.billing_ends_at ?? null,
      billing_portal_url: user?.billing_portal_url ?? null,
      pricing: user?.pricing_country ? {
        country_code: user.pricing_country,
        band: user.pricing_band,
        policy_version: user.pricing_policy_version,
        experiment_id: user.pricing_experiment_id,
        experiment_variant: user.pricing_experiment_variant,
        interval: user.pricing_interval,
        currency: user.pricing_currency,
        amount_cents: user.pricing_amount_cents,
        verification_status: user.pricing_verification_status,
      } : null,
      usage: {
        contacts: { used: usedContacts, limit: ent.monthlyContacts },
        drafts: { used: usedDrafts, limit: ent.monthlyDrafts },
        resumes: { used: usedResumes, limit: ent.monthlyResumes },
      },
      ...(upgradeLink && ent.tier !== 'pro' ? { upgrade_url: upgradeLink } : {}),
    });
  });

  fastify.post('/billing/checkout', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId, email, isGuest } = request.jwtPayload!;
    if (isGuest || !email) {
      return reply.status(409).send({ error: 'Verify an email before starting checkout.', code: 'claim_required' });
    }
    const parsed = checkoutBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid checkout selection.', code: 'invalid_checkout' });
    if (!lemonSqueezyApiReady(parsed.data.interval)) {
      return reply.status(503).send({ error: 'Checkout is temporarily unavailable.', code: 'billing_not_configured' });
    }
    const ent = await getEntitlements(userId);
    if (ent.tier === 'pro') {
      return reply.status(409).send({ error: 'This account already has Pro.', code: 'already_pro' });
    }
    const secret = pricingSecret();
    if (!secret) return reply.status(503).send({ error: 'Checkout is temporarily unavailable.', code: 'pricing_not_configured' });

    const now = new Date();
    const quote = verifyPricingQuote(parsed.data.quote_token, now, secret);
    const subjectId = parsed.data.subject_id ?? userId;
    const experiment = parsePricingExperiment();
    const priorVariant = await stickyVariant(userId, experiment?.id ?? null);
    const quotedVariant = quote
      && quote.subjectId === subjectId
      && quote.interval === parsed.data.interval
      && quote.experimentId === (experiment?.id ?? null)
      ? quote.experimentVariant
      : null;
    let offer = resolvePricingOffer({
      subjectId: userId,
      detectedCountryCode: detectedCountryFromRequest(request),
      requestedCountryCode: parsed.data.country_code ?? quote?.requestedCountryCode ?? quote?.countryCode,
      interval: parsed.data.interval,
      experiment,
      experimentSecret: secret,
      forcedVariant: priorVariant ?? quotedVariant,
    });
    const persistedVariant = await persistAssignment(userId, offer.experimentId, offer.experimentVariant);
    if (persistedVariant !== offer.experimentVariant) {
      offer = resolvePricingOffer({
        subjectId: userId,
        detectedCountryCode: detectedCountryFromRequest(request),
        requestedCountryCode: parsed.data.country_code ?? quote?.countryCode,
        interval: parsed.data.interval,
        experiment,
        experimentSecret: secret,
        forcedVariant: persistedVariant,
      });
    }

    const key = idempotencyKey(userId, offer, now);
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);
    const offerId = randomUUID();
    const inserted = await db.insert(pricing_offers).values({
      id: offerId,
      user_id: userId,
      subject_id: subjectId,
      idempotency_key: key,
      quote_token_hash: parsed.data.quote_token ? createHash('sha256').update(parsed.data.quote_token).digest('hex') : null,
      policy_version: offer.policyVersion,
      country_code: offer.countryCode,
      detected_country_code: offer.detectedCountryCode,
      requested_country_code: offer.requestedCountryCode,
      country_mismatch: offer.countryMismatch,
      band: offer.band,
      experiment_id: offer.experimentId,
      experiment_variant: offer.experimentVariant,
      billing_interval: offer.interval,
      currency: offer.currency,
      base_amount_cents: offer.baseAmountCents,
      amount_cents: offer.amountCents,
      expires_at: expiresAt,
    }).onConflictDoNothing({ target: pricing_offers.idempotency_key }).returning();

    let activeOfferId: string = offerId;
    if (inserted.length === 0) {
      const existing = await db.select().from(pricing_offers)
        .where(eq(pricing_offers.idempotency_key, key)).limit(1);
      if (existing[0]?.provider_checkout_url && existing[0].expires_at > now) {
        return reply.header('Cache-Control', 'private, no-store').status(200).send({
          provider: 'lemonsqueezy',
          url: existing[0].provider_checkout_url,
          offer_id: existing[0].id,
          offer: publicOffer(offer, null),
          reused: true,
        });
      }
      if (existing[0]?.status === 'failed' && existing[0].expires_at > now) {
        const claimed = await db.update(pricing_offers).set({ status: 'creating', updated_at: now })
          .where(and(
            eq(pricing_offers.id, existing[0].id),
            eq(pricing_offers.status, 'failed'),
          )).returning({ id: pricing_offers.id });
        if (claimed[0]) activeOfferId = claimed[0].id;
        else {
          return reply.header('Retry-After', '2').status(409).send({
            error: 'Checkout is already being prepared. Try again in a moment.',
            code: 'checkout_in_progress',
          });
        }
      } else {
        return reply.header('Retry-After', '2').status(409).send({
          error: 'Checkout is already being prepared. Try again in a moment.',
          code: 'checkout_in_progress',
        });
      }
    }

    try {
      const accountToken = createHmac('sha256', process.env.LEMONSQUEEZY_WEBHOOK_SECRET!)
        .update(userId).digest('hex');
      const checkout = await createLemonSqueezyCheckout({
        userId,
        email,
        offerId: activeOfferId,
        offer,
        accountToken,
        expiresAt,
      });
      await db.update(pricing_offers).set({
        status: 'checkout_created',
        provider_checkout_id: checkout.id,
        provider_checkout_url: checkout.url,
        checkout_created_at: now,
        updated_at: now,
      }).where(eq(pricing_offers.id, activeOfferId));
      return reply.header('Cache-Control', 'private, no-store').status(200).send({
        provider: 'lemonsqueezy',
        url: checkout.url,
        offer_id: activeOfferId,
        offer: publicOffer(offer, null),
        reused: false,
      });
    } catch (error) {
      await db.update(pricing_offers).set({ status: 'failed', updated_at: new Date() })
        .where(eq(pricing_offers.id, activeOfferId));
      fastify.log.error({ err: error, userId, offerId: activeOfferId }, 'regional checkout creation failed');
      return reply.status(503).send({ error: 'Checkout is temporarily unavailable.', code: 'checkout_provider_failed' });
    }
  });

  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  fastify.post('/billing/lemonsqueezy-webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    const acceptedVariantIds = [lemonSqueezyVariantId('monthly'), lemonSqueezyVariantId('yearly')]
      .filter((value): value is string => Boolean(value));
    if (!secret || acceptedVariantIds.length === 0) return reply.status(503).send({ error: 'billing not configured' });

    const signature = request.headers['x-signature'];
    const raw = request.body as Buffer;
    if (typeof signature !== 'string' || !Buffer.isBuffer(raw)) return reply.status(400).send({ error: 'bad request' });
    if (!verifyLemonSqueezySignature(raw, signature, secret)) return reply.status(400).send({ error: 'bad signature' });

    const eventKey = createHash('sha256').update(raw).digest('hex');
    let payload: Record<string, any>;
    let parsed: ReturnType<typeof parseLemonSqueezySubscription>;
    try {
      payload = JSON.parse(raw.toString('utf8'));
      parsed = parseLemonSqueezySubscription(payload);
    } catch {
      return reply.status(400).send({ error: 'unparseable event' });
    }
    const eventName = typeof payload?.meta?.event_name === 'string' ? payload.meta.event_name : null;
    const insertedEvent = await db.insert(billing_webhook_events).values({
      event_key: eventKey,
      provider: 'lemonsqueezy',
      event_name: eventName,
    }).onConflictDoNothing().returning();
    if (insertedEvent.length === 0) {
      const existing = await db.select().from(billing_webhook_events)
        .where(eq(billing_webhook_events.event_key, eventKey)).limit(1);
      if (existing[0]?.processed_at) return reply.status(200).send({ received: true, duplicate: true });
      const receivedAt = existing[0]?.received_at;
      if (receivedAt && receivedAt.getTime() > Date.now() - 5 * 60 * 1000) {
        return reply.status(202).send({ received: true, duplicate: true, processing: true });
      }
    }

    const finishEvent = async (result: string) => {
      await db.update(billing_webhook_events).set({ result, processed_at: new Date() })
        .where(eq(billing_webhook_events.event_key, eventKey));
    };
    if (!parsed) {
      await finishEvent('ignored');
      return reply.status(200).send({ received: true, ignored: true });
    }
    if (parsed.testMode && process.env.LEMONSQUEEZY_ACCEPT_TEST_MODE !== 'true') {
      await finishEvent('ignored_test_mode');
      return reply.status(200).send({ received: true, ignored: true });
    }
    if (!acceptedVariantIds.includes(parsed.variantId)) {
      await finishEvent('ignored_variant');
      return reply.status(200).send({ received: true, ignored: true });
    }
    const plan = planForLemonSqueezyStatus(parsed.status);
    if (!plan) {
      await finishEvent('ignored_status');
      return reply.status(200).send({ received: true, ignored: true });
    }

    const trustedUserId = parsed.userId && verifyLemonSqueezyAccountToken(parsed.userId, parsed.accountToken, secret)
      ? parsed.userId
      : undefined;
    let matched = trustedUserId ? await db.select().from(users).where(eq(users.id, trustedUserId)).limit(1) : [];
    if (matched.length === 0) matched = await db.select().from(users).where(eq(users.billing_subscription_id, parsed.subscriptionId)).limit(1);
    if (matched.length === 0 && parsed.email) matched = await db.select().from(users).where(eq(users.email, parsed.email)).limit(1);
    const user = matched[0];
    if (!user) {
      await finishEvent('account_not_found');
      return reply.status(422).send({ error: 'account not found' });
    }
    if (user.billing_event_updated_at && parsed.updatedAt < user.billing_event_updated_at) {
      await finishEvent('stale_event');
      return reply.status(200).send({ received: true, ignored: true, reason: 'stale_event' });
    }

    const offerRows = parsed.offerId
      ? await db.select().from(pricing_offers).where(and(
        eq(pricing_offers.id, parsed.offerId),
        eq(pricing_offers.user_id, user.id),
      )).limit(1)
      : await db.select().from(pricing_offers).where(eq(pricing_offers.provider_subscription_id, parsed.subscriptionId))
        .orderBy(desc(pricing_offers.created_at)).limit(1);
    const offer = offerRows[0];
    if (parsed.offerId && !offer) {
      await finishEvent('offer_not_found');
      return reply.status(422).send({ error: 'pricing offer not found' });
    }
    if (offer && parsed.pricingAmountCents && parsed.pricingAmountCents !== offer.amount_cents) {
      await finishEvent('offer_amount_mismatch');
      fastify.log.error({ offerId: offer.id, webhookAmount: parsed.pricingAmountCents }, 'billing offer amount mismatch');
      return reply.status(422).send({ error: 'pricing offer mismatch' });
    }

    const billingCountry = await getLemonSqueezyCustomerCountry(parsed.customerId).catch(() => null);
    const countryMatches = !offer || !billingCountry || offer.country_code === 'ZZ' || billingCountry === offer.country_code;
    const verificationStatus = !offer
      ? 'legacy'
      : !billingCountry
        ? 'provider_unavailable'
        : countryMatches
          ? 'verified'
          : 'review_required';

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
      ...(offer ? {
        pricing_country: offer.country_code,
        pricing_band: offer.band,
        pricing_policy_version: offer.policy_version,
        pricing_experiment_id: offer.experiment_id,
        pricing_experiment_variant: offer.experiment_variant,
        pricing_interval: offer.billing_interval,
        pricing_currency: offer.currency,
        pricing_amount_cents: offer.amount_cents,
        pricing_verification_status: verificationStatus,
      } : {}),
    }).where(eq(users.id, user.id));

    if (offer) {
      await db.update(pricing_offers).set({
        status: plan === 'pro' ? 'paid' : 'expired',
        provider_customer_id: parsed.customerId,
        provider_subscription_id: parsed.subscriptionId,
        billing_country_code: billingCountry,
        country_mismatch: !countryMatches,
        paid_at: plan === 'pro' ? parsed.updatedAt : offer.paid_at,
        verified_at: billingCountry ? new Date() : offer.verified_at,
        updated_at: new Date(),
      }).where(eq(pricing_offers.id, offer.id));
    }
    if (verificationStatus === 'review_required') {
      fastify.log.warn({ userId: user.id, offerId: offer?.id, quotedCountry: offer?.country_code, billingCountry },
        'regional price country requires review');
    }
    await finishEvent(verificationStatus);
    fastify.log.info({ userId: user.id, status: parsed.status, plan, verificationStatus }, 'synced Lemon Squeezy subscription');
    return reply.status(200).send({ received: true });
  });
}
