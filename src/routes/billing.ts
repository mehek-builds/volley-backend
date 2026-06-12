import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db } from '../db/index';
import { users } from '../db/schema';
import { eq } from 'drizzle-orm';
import { requireAuth } from '../middleware/auth';
import { getEntitlements, getCount, monthPeriod } from '../middleware/quota';

export async function billingRoutes(fastify: FastifyInstance) {
  // Plan + usage for the signed-in user. The extension can show "12 of 30 used".
  fastify.get('/me', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { userId, email } = request.jwtPayload!;
    const ent = await getEntitlements(userId);
    const period = monthPeriod();
    const [usedContacts, usedDrafts] = await Promise.all([
      getCount(userId, period, 'verified_contacts'),
      getCount(userId, period, 'drafts'),
    ]);
    const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    return reply.status(200).send({
      email,
      tier: ent.tier,
      trial_ends_at: rows[0]?.trial_ends_at ?? null,
      usage: {
        contacts: { used: usedContacts, limit: ent.monthlyContacts },
        drafts: { used: usedDrafts, limit: ent.monthlyDrafts },
      },
      ...(process.env.STRIPE_PAYMENT_LINK && ent.tier !== 'pro'
        ? { upgrade_url: process.env.STRIPE_PAYMENT_LINK }
        : {}),
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
}
