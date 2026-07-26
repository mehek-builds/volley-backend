import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { db } from '../db/index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { getEntitlements, getCount, monthPeriod, upgradeUrl } from '../middleware/quota';
import {
  buildLemonSqueezyCheckoutUrl,
  lemonSqueezyCheckoutReadyUrl,
  parseLemonSqueezySubscription,
  planForLemonSqueezyStatus,
  verifyLemonSqueezySignature,
  verifyLemonSqueezyAccountToken,
} from '../lib/lemonSqueezy';

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
    return reply.status(200).send({
      email: email ?? null,
      is_guest: isGuest,
      tier: ent.tier,
      trial_ends_at: user?.trial_ends_at ?? null,
      guest_expires_at: user?.guest_expires_at ?? null,
      billing_provider: 'lemonsqueezy',
      checkout_available: Boolean(lemonSqueezyCheckoutReadyUrl()),
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

  fastify.post('/billing/checkout', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId, email, isGuest } = request.jwtPayload!;
    if (isGuest || !email) {
      return reply.status(409).send({ error: 'Verify an email before starting checkout.', code: 'claim_required' });
    }
    const ent = await getEntitlements(userId);
    if (ent.tier === 'pro') {
      return reply.status(409).send({ error: 'This account already has Pro.', code: 'already_pro' });
    }
    const url = buildLemonSqueezyCheckoutUrl(userId, email);
    if (!url) {
      return reply.status(503).send({ error: 'Checkout is temporarily unavailable.', code: 'billing_not_configured' });
    }
    return reply.header('Cache-Control', 'private, no-store').status(200).send({ provider: 'lemonsqueezy', url });
  });

  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
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
