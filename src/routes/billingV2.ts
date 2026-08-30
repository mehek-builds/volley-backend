import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, gt } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import {
  applications,
  monetization_events,
  monitored_jobs,
  pending_premium_actions,
  pricing_offers,
  user_contact_unlocks,
  users,
} from '../db/schema';
import { FEATURE_KEYS, getEntitlementSnapshot } from '../lib/entitlements';
import { publicBillingPlans, stripePriceIdForPlan } from '../lib/billingCatalog';
import { billingCheckoutTerms, type BillingCheckoutAccountFacts } from '../lib/billingCheckoutTerms';
import { addVary } from '../lib/boardCacheHeaders';
import { packetAuditSha256 } from '../lib/packetAudit';
import { optionalAuth, requireAuth } from '../middleware/auth';

const offerParams = z.object({ id: z.string().uuid() });
const actionParams = z.object({ nonce: z.string().min(20).max(200) });
const surfaces = ['website', 'dashboard', 'extension', 'api'] as const;
const clientEvents = ['paywall_impression', 'paywall_dismissed', 'upgrade_clicked', 'plan_selected', 'checkout_opened'] as const;
const eventSchema = z.object({
  event_key: z.string().uuid(),
  event_name: z.enum(clientEvents),
  surface: z.enum(surfaces),
  placement: z.string().trim().max(120).optional(),
  trigger: z.string().trim().max(120).optional(),
  feature_key: z.enum(FEATURE_KEYS).optional(),
  plan_id: z.enum(['litos_plus_week', 'litos_plus_month', 'litos_plus_quarter']).optional(),
  application_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  session_id: z.string().trim().max(120).optional(),
  occurred_at: z.string().datetime(),
  properties: z.record(z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).optional(),
});
const actionSchema = z.object({
  feature_key: z.enum(FEATURE_KEYS),
  application_id: z.string().uuid().optional(),
  job_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  return_route: z.string().trim().min(1).max(500),
  idempotency_key: z.string().uuid(),
});

function actionHash(nonce: string): string {
  return createHash('sha256').update(nonce).digest('hex');
}

function deterministicActionNonce(userId: string, idempotencyKey: string): string | null {
  const secret = process.env.JWT_SIGNING_SECRET;
  if (!secret) return null;
  const digest = createHmac('sha256', secret)
    .update('litos:pending-action:v1\0')
    .update(userId)
    .update('\0')
    .update(idempotencyKey)
    .digest('base64url');
  return `litos_action_v1_${digest}`;
}

function pendingActionMatchesContext(
  action: typeof pending_premium_actions.$inferSelect,
  input: {
    idempotencyKey: string;
    contextHash: string;
    featureKey: string;
    applicationId: string | null;
    jobId: string | null;
    contactId: string | null;
    returnRoute: string;
  },
): boolean {
  return action.idempotency_binding === input.idempotencyKey
    && action.idempotency_key === input.idempotencyKey
    && action.context_hash === input.contextHash
    && action.feature_key === input.featureKey
    && action.application_id === input.applicationId
    && action.job_id === input.jobId
    && action.contact_id === input.contactId
    && action.return_route === input.returnRoute;
}

function pendingActionResponse(
  action: typeof pending_premium_actions.$inferSelect,
  nonce: string,
  idempotent: boolean,
) {
  return {
    action_nonce: nonce,
    offer_id: action.offer_id,
    feature_key: action.feature_key,
    application_id: action.application_id,
    job_id: action.job_id,
    contact_id: action.contact_id,
    return_route: action.return_route,
    expires_at: action.expires_at,
    idempotent,
  };
}

export function safeReturnRoute(value: string): string | null {
  try {
    const url = new URL(value, 'https://trylitos.com');
    if (url.origin !== 'https://trylitos.com') return null;
    if (!/^\/(dashboard|billing)(?:\/|$)/.test(url.pathname)) return null;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

function publicOfferStatus(row: typeof pricing_offers.$inferSelect): 'creating' | 'checkout_created' | 'paid' | 'expired' | 'failed' {
  if (row.paid_at || row.status === 'paid') return 'paid';
  if (row.expires_at <= new Date() && row.status !== 'failed') return 'expired';
  if (row.status === 'failed') return 'failed';
  if (row.provider_checkout_id) return 'checkout_created';
  return 'creating';
}

export async function billingV2Routes(fastify: FastifyInstance) {
  fastify.get('/billing/plans', { preHandler: optionalAuth }, async (request, reply) => {
    const catalog = publicBillingPlans();
    const identity = request.jwtPayload;
    let account: BillingCheckoutAccountFacts = {
      authenticated: false,
      is_guest: false,
    };
    if (identity) {
      const [snapshot, accountRows] = await Promise.all([
        getEntitlementSnapshot(identity.userId),
        db.select({
          billing_provider: users.billing_provider,
          billing_customer_id: users.billing_customer_id,
          billing_status: users.billing_status,
          trial_started_at: users.trial_started_at,
          trial_ends_at: users.trial_ends_at,
        }).from(users).where(eq(users.id, identity.userId)).limit(1),
      ]);
      const row = accountRows[0];
      account = {
        authenticated: true,
        is_guest: identity.isGuest,
        access_class: snapshot.access_class,
        subscription_status: snapshot.subscription?.status ?? null,
        billing_provider: snapshot.subscription?.provider ?? row?.billing_provider ?? null,
        billing_customer_id: row?.billing_customer_id ?? null,
        billing_status: snapshot.subscription?.status ?? row?.billing_status ?? null,
        trial_started_at: row?.trial_started_at ?? null,
        trial_ends_at: row?.trial_ends_at ?? null,
      };
    }
    const personalized = Boolean(identity);
    /* CORS already varies by Origin. Append rather than replace it, because the anonymous response
       is public and must never be reused across either origin or authorization boundaries. */
    addVary(reply, 'Authorization');
    return reply
      .header('Cache-Control', personalized ? 'private, no-store' : 'public, max-age=300')
      .status(200)
      .send({
        ...catalog,
        plans: catalog.plans.map((plan) => ({
          ...plan,
          checkout_terms: billingCheckoutTerms({
            plan,
            provider_price_id: stripePriceIdForPlan(plan.id),
            account,
            checkout_available: catalog.checkout_available,
            automatic_tax_enabled: process.env.STRIPE_AUTOMATIC_TAX_ENABLED === 'true',
          }),
        })),
      });
  });

  fastify.get('/billing/state', { preHandler: requireAuth }, async (request: FastifyRequest, reply) => {
    const snapshot = await getEntitlementSnapshot(request.jwtPayload!.userId);
    const etag = `"${snapshot.revision}"`;
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization').header('ETag', etag);
    if (request.headers['if-none-match'] === etag || request.headers['if-none-match'] === snapshot.revision) {
      return reply.status(304).send();
    }
    return reply.status(200).send(snapshot);
  });

  fastify.get('/billing/offers/:id', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = offerParams.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid offer id' });
    const [offer] = await db.select().from(pricing_offers).where(and(
      eq(pricing_offers.id, parsed.data.id),
      eq(pricing_offers.user_id, request.jwtPayload!.userId),
    )).limit(1);
    if (!offer) return reply.status(404).send({ error: 'Offer not found' });
    return reply.header('Cache-Control', 'private, no-store').send({
      offer_id: offer.id,
      plan_id: offer.product_code === 'litos_plus' && offer.term_code
        ? `litos_plus_${offer.term_code === 'quarter' ? 'quarter' : offer.term_code}`
        : null,
      status: publicOfferStatus(offer),
      paid_at: offer.paid_at,
      completed_at: offer.completed_at,
      expires_at: offer.expires_at,
    });
  });

  fastify.post('/billing/events', { preHandler: requireAuth }, async (request, reply) => {
    const encoded = Buffer.byteLength(JSON.stringify(request.body ?? {}), 'utf8');
    if (encoded > 8 * 1024) return reply.status(413).send({ error: 'Event body is too large' });
    const parsed = eventSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid billing event', detail: parsed.error.issues });
    await db.insert(monetization_events).values({
      event_key: `client:${parsed.data.event_key}`,
      user_id: request.jwtPayload!.userId,
      event_name: parsed.data.event_name,
      surface: parsed.data.surface,
      placement: parsed.data.placement,
      trigger: parsed.data.trigger,
      feature_key: parsed.data.feature_key,
      plan_id: parsed.data.plan_id,
      application_id: parsed.data.application_id,
      job_id: parsed.data.job_id,
      session_id: parsed.data.session_id,
      occurred_at: new Date(parsed.data.occurred_at),
      properties: parsed.data.properties ?? {},
    }).onConflictDoNothing({ target: monetization_events.event_key });
    return reply.status(202).send({ accepted: true });
  });

  fastify.post('/billing/actions', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = actionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid pending action', detail: parsed.error.issues });
    const returnRoute = safeReturnRoute(parsed.data.return_route);
    if (!returnRoute) return reply.status(400).send({ error: 'Return route is not allowed' });
    const userId = request.jwtPayload!.userId;
    const idempotencyKey = parsed.data.idempotency_key.toLowerCase();
    const contextHash = packetAuditSha256({
      feature_key: parsed.data.feature_key,
      application_id: parsed.data.application_id ?? null,
      job_id: parsed.data.job_id ?? null,
      contact_id: parsed.data.contact_id ?? null,
      return_route: returnRoute,
    });
    const expectedContext = {
      idempotencyKey,
      contextHash,
      featureKey: parsed.data.feature_key,
      applicationId: parsed.data.application_id ?? null,
      jobId: parsed.data.job_id ?? null,
      contactId: parsed.data.contact_id ?? null,
      returnRoute,
    };
    const nonce = deterministicActionNonce(userId, idempotencyKey);
    if (!nonce) {
      return reply.status(503).send({ error: 'Pending actions are temporarily unavailable', code: 'action_nonce_unavailable' });
    }
    const [priorAction] = await db.select().from(pending_premium_actions).where(and(
      eq(pending_premium_actions.user_id, userId),
      eq(pending_premium_actions.idempotency_binding, idempotencyKey),
    )).limit(1);
    if (priorAction) {
      if (!pendingActionMatchesContext(priorAction, expectedContext)) {
        return reply.status(409).send({
          error: 'This idempotency key was used for another pending action',
          code: 'action_idempotency_conflict',
        });
      }
      if (priorAction.nonce_hash !== actionHash(nonce)) {
        return reply.status(503).send({ error: 'Pending action replay is unavailable', code: 'action_replay_unavailable' });
      }
      return reply.header('Cache-Control', 'private, no-store').status(201)
        .send(pendingActionResponse(priorAction, nonce, true));
    }
    const [applicationRows, jobRows, contactRows] = await Promise.all([
      parsed.data.application_id
        ? db.select({
          id: applications.id,
          job_id: applications.job_id,
          company_scope_key: applications.company_scope_key,
        }).from(applications).where(and(
          eq(applications.id, parsed.data.application_id),
          eq(applications.user_id, userId),
        )).limit(1)
        : Promise.resolve([]),
      parsed.data.job_id
        ? db.select({ id: monitored_jobs.id }).from(monitored_jobs)
          .where(eq(monitored_jobs.id, parsed.data.job_id)).limit(1)
        : Promise.resolve([]),
      parsed.data.contact_id
        ? db.select({
          contact_id: user_contact_unlocks.contact_id,
          company_scope_key: user_contact_unlocks.company_scope_key,
        }).from(user_contact_unlocks).where(and(
          eq(user_contact_unlocks.user_id, userId),
          eq(user_contact_unlocks.contact_id, parsed.data.contact_id),
        )).limit(1)
        : Promise.resolve([]),
    ]);
    if (parsed.data.application_id && !applicationRows[0]) {
      return reply.status(404).send({ error: 'Application not found', code: 'application_not_found' });
    }
    if (parsed.data.job_id && !jobRows[0]) {
      return reply.status(404).send({ error: 'Job not found', code: 'job_not_found' });
    }
    if (parsed.data.contact_id && !contactRows[0]) {
      return reply.status(404).send({ error: 'Contact not found', code: 'contact_not_found' });
    }
    if (
      parsed.data.job_id
      && applicationRows[0]?.job_id
      && applicationRows[0].job_id !== parsed.data.job_id
    ) {
      return reply.status(409).send({ error: 'Application and job context do not match', code: 'action_context_mismatch' });
    }
    if (
      applicationRows[0]
      && contactRows[0]
      && applicationRows[0].company_scope_key !== contactRows[0].company_scope_key
    ) {
      return reply.status(409).send({
        error: 'Application and contact company context do not match',
        code: 'action_context_mismatch',
      });
    }
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    const [insertedAction] = await db.insert(pending_premium_actions).values({
      nonce_hash: actionHash(nonce),
      user_id: userId,
      feature_key: parsed.data.feature_key,
      application_id: parsed.data.application_id,
      job_id: parsed.data.job_id,
      contact_id: parsed.data.contact_id,
      return_route: returnRoute,
      context_hash: contextHash,
      idempotency_key: idempotencyKey,
      idempotency_binding: idempotencyKey,
      expires_at: expiresAt,
    }).onConflictDoNothing().returning();
    if (insertedAction) {
      return reply.header('Cache-Control', 'private, no-store').status(201)
        .send(pendingActionResponse(insertedAction, nonce, false));
    }
    const [racedAction] = await db.select().from(pending_premium_actions).where(and(
      eq(pending_premium_actions.user_id, userId),
      eq(pending_premium_actions.idempotency_binding, idempotencyKey),
    )).limit(1);
    if (!racedAction) throw new Error('Pending action idempotency conflict did not return an action');
    if (!pendingActionMatchesContext(racedAction, expectedContext)) {
      return reply.status(409).send({
        error: 'This idempotency key was used for another pending action',
        code: 'action_idempotency_conflict',
      });
    }
    if (racedAction.nonce_hash !== actionHash(nonce)) {
      return reply.status(503).send({ error: 'Pending action replay is unavailable', code: 'action_replay_unavailable' });
    }
    return reply.header('Cache-Control', 'private, no-store').status(201)
      .send(pendingActionResponse(racedAction, nonce, true));
  });

  fastify.get('/billing/actions/:nonce', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = actionParams.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid action nonce' });
    const [action] = await db.select().from(pending_premium_actions).where(and(
      eq(pending_premium_actions.nonce_hash, actionHash(parsed.data.nonce)),
      eq(pending_premium_actions.user_id, request.jwtPayload!.userId),
    )).limit(1);
    if (!action) return reply.status(404).send({ error: 'Pending action not found' });
    if (action.expires_at <= new Date()) return reply.status(410).send({ error: 'Pending action expired', code: 'action_expired' });
    return reply.header('Cache-Control', 'private, no-store').send({
      offer_id: action.offer_id,
      feature_key: action.feature_key,
      application_id: action.application_id,
      job_id: action.job_id,
      contact_id: action.contact_id,
      return_route: action.return_route,
      state: action.state,
      expires_at: action.expires_at,
    });
  });

  fastify.post('/billing/actions/:nonce/consume', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = actionParams.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid action nonce' });
    const [action] = await db.select().from(pending_premium_actions).where(and(
      eq(pending_premium_actions.nonce_hash, actionHash(parsed.data.nonce)),
      eq(pending_premium_actions.user_id, request.jwtPayload!.userId),
    )).limit(1);
    if (!action) return reply.status(404).send({ error: 'Pending action not found' });
    if (action.expires_at <= new Date()) return reply.status(410).send({ error: 'Pending action expired', code: 'action_expired' });
    const entitlement = await getEntitlementSnapshot(request.jwtPayload!.userId);
    const feature = action.feature_key as keyof typeof entitlement.features;
    if (!entitlement.features[feature]) return reply.status(409).send({ error: 'Litos+ is not active', code: 'action_not_entitled' });
    if (action.state === 'consumed') {
      return reply.send({
        consumed: true,
        idempotent: true,
        offer_id: action.offer_id,
        return_route: action.return_route,
        feature_key: action.feature_key,
        application_id: action.application_id,
        job_id: action.job_id,
        contact_id: action.contact_id,
      });
    }
    const consumedAt = new Date();
    const [consumed] = await db.update(pending_premium_actions).set({ state: 'consumed', consumed_at: consumedAt })
      .where(and(
        eq(pending_premium_actions.id, action.id),
        eq(pending_premium_actions.state, 'pending'),
        gt(pending_premium_actions.expires_at, consumedAt),
      )).returning();
    if (!consumed) {
      const [current] = await db.select().from(pending_premium_actions)
        .where(eq(pending_premium_actions.id, action.id)).limit(1);
      if (!current) return reply.status(404).send({ error: 'Pending action not found' });
      if (current.expires_at <= consumedAt) {
        return reply.status(410).send({ error: 'Pending action expired', code: 'action_expired' });
      }
      if (current.state !== 'consumed') {
        return reply.status(409).send({ error: 'Pending action is unavailable', code: 'action_unavailable' });
      }
      return reply.send({
        consumed: true,
        idempotent: true,
        offer_id: current.offer_id,
        return_route: current.return_route,
        feature_key: current.feature_key,
        application_id: current.application_id,
        job_id: current.job_id,
        contact_id: current.contact_id,
      });
    }
    // Consuming restores context only. The client still asks before retrying the premium action.
    return reply.send({
      consumed: true,
      idempotent: false,
      offer_id: consumed.offer_id,
      return_route: consumed.return_route,
      feature_key: consumed.feature_key,
      application_id: consumed.application_id,
      job_id: consumed.job_id,
      contact_id: consumed.contact_id,
    });
  });
}
