import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { getEntitlements, getCount, monthPeriod, FREE_LIFETIME_RESUME_LIMIT, LIFETIME_PERIOD } from '../middleware/quota';

export async function billingRoutes(fastify: FastifyInstance) {
  // Plan + usage for the signed-in user. The extension can show "12 of 30 used".
  fastify.get('/me', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId, email } = request.jwtPayload!;
    const ent = await getEntitlements(userId);
    const period = monthPeriod();
    // Resumes count against a lifetime bucket on free, a monthly one on pro/trial
    // (see quota.ts / resume.ts - same split drives the /resume/generate gate).
    const resumeQuotaPeriod = ent.tier === 'free' ? LIFETIME_PERIOD : period;
    const resumeQuotaLimit = ent.tier === 'free' ? FREE_LIFETIME_RESUME_LIMIT : ent.monthlyResumes;
    const [usedContacts, usedDrafts, usedResumes] = await Promise.all([
      getCount(userId, period, 'verified_contacts'),
      getCount(userId, period, 'drafts'),
      getCount(userId, resumeQuotaPeriod, 'resumes'),
    ]);
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const upgradeUrl = process.env.UPGRADE_URL || process.env.STRIPE_PAYMENT_LINK;
    return reply.status(200).send({
      email,
      tier: ent.tier,
      trial_ends_at: rows[0]?.trial_ends_at ?? null,
      usage: {
        contacts: { used: usedContacts, limit: ent.monthlyContacts },
        drafts: { used: usedDrafts, limit: ent.monthlyDrafts },
        resumes: { used: usedResumes, limit: resumeQuotaLimit },
      },
      ...(upgradeUrl && ent.tier !== 'pro' ? { upgrade_url: upgradeUrl } : {}),
    });
  });

  // Stripe webhook: a completed Payment Link checkout upgrades the matching email
  // to Pro. Signature verification needs the raw body, so this plugin re-parses
  // application/json as a buffer (Fastify encapsulation keeps this scoped here).
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  fastify.post('/billing/stripe-webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      return reply.status(503).send({ error: 'billing not configured' });
    }

    const sigHeader = request.headers['stripe-signature'];
    const raw = request.body as Buffer;
    if (typeof sigHeader !== 'string' || !Buffer.isBuffer(raw)) {
      return reply.status(400).send({ error: 'bad request' });
    }

    // Stripe-Signature: t=<ts>,v1=<hmac>, HMAC-SHA256 over `${t}.${rawBody}`.
    const parts = Object.fromEntries(sigHeader.split(',').map((kv) => kv.split('=') as [string, string]));
    const expected = createHmac('sha256', secret).update(`${parts.t}.${raw.toString('utf8')}`).digest('hex');
    const given = Buffer.from(parts.v1 || '', 'hex');
    const want = Buffer.from(expected, 'hex');
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      return reply.status(400).send({ error: 'bad signature' });
    }
    const ageSec = Math.abs(Date.now() / 1000 - Number(parts.t));
    if (!Number.isFinite(ageSec) || ageSec > 300) {
      return reply.status(400).send({ error: 'stale signature' });
    }

    try {
      const event = JSON.parse(raw.toString('utf8'));
      if (event.type === 'checkout.session.completed') {
        const email: string | undefined = event.data?.object?.customer_details?.email;
        // Single paid tier now ($49.99/mo, unlocks everything - no separate Plus add-on).
        if (email) {
          await db.update(users).set({ plan: 'pro' }).where(eq(users.email, email.toLowerCase()));
          fastify.log.info({ email }, 'upgraded to pro via stripe checkout');
        }
      }
      // Future: handle customer.subscription.deleted to downgrade on cancellation.
      return reply.status(200).send({ received: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(400).send({ error: 'unparseable event' });
    }
  });

  // Lemon Squeezy webhook: signature is HMAC-SHA256 (hex) of the raw body in
  // X-Signature. subscription_created/resumed/unpaused -> Pro; expired -> free.
  // Customer matching is by email, same convention as the Stripe webhook.
  fastify.post('/billing/lemonsqueezy-webhook', async (request: FastifyRequest, reply: FastifyReply) => {
    const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    if (!secret) {
      return reply.status(503).send({ error: 'billing not configured' });
    }

    const sigHeader = request.headers['x-signature'];
    const raw = request.body as Buffer;
    if (typeof sigHeader !== 'string' || !Buffer.isBuffer(raw)) {
      return reply.status(400).send({ error: 'bad request' });
    }

    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    const given = Buffer.from(sigHeader, 'hex');
    const want = Buffer.from(expected, 'hex');
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      return reply.status(400).send({ error: 'bad signature' });
    }

    try {
      const event = JSON.parse(raw.toString('utf8'));
      const name: string = event.meta?.event_name || '';
      const email: string | undefined = event.data?.attributes?.user_email;
      if (email && ['subscription_created', 'subscription_resumed', 'subscription_unpaused'].includes(name)) {
        await db.update(users).set({ plan: 'pro' }).where(eq(users.email, email.toLowerCase()));
        fastify.log.info({ email, name }, 'upgraded to pro via lemon squeezy');
      } else if (email && ['subscription_expired'].includes(name)) {
        await db.update(users).set({ plan: 'free' }).where(eq(users.email, email.toLowerCase()));
        fastify.log.info({ email, name }, 'downgraded to free via lemon squeezy');
      }
      return reply.status(200).send({ received: true });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(400).send({ error: 'unparseable event' });
    }
  });
}
