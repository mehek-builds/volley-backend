import webpush from 'web-push';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { push_subscriptions } from '../db/schema';

/* NOTIFICATIONS ON THE LAPTOP, and the four things about Web Push that decide whether it works.
 *
 * 1. THE BROWSER HAS TO BE RUNNING. A push is delivered to a browser, not to an operating system.
 *    Chrome backgrounded is fine; Chrome quit, or the lid shut, means the notification waits at the
 *    push service until it next opens, and expires unshown if that takes longer than the TTL. This
 *    is not a limitation of this code and cannot be engineered around. It is why email remains the
 *    durable channel and this one is the immediate channel, and why anything a student MUST see
 *    should never be push-only.
 *
 * 2. PERMISSION IS ONE SHOT. `Notification.requestPermission()` can be asked once in any meaningful
 *    sense: a student who clicks Block cannot be asked again by any code we write, and has to go
 *    into site settings to undo it. That makes WHERE it is asked a product decision rather than a
 *    technical one, and it is why the browser prompt is fired from a deliberate click on screen 08
 *    rather than on page load.
 *
 * 3. SAFARI ON macOS NEEDS THE SITE ADDED TO THE DOCK. Safari 16+ supports Web Push only for sites
 *    installed as web apps. A Safari student who has not done that will never see one of these, and
 *    nothing in the API reports that state, so the subscribe call simply never happens.
 *
 * 4. A SUBSCRIPTION IS PER BROWSER PROFILE PER DEVICE. Saying yes on a laptop says nothing about a
 *    phone or a second browser. See the push_subscriptions table comment.
 *
 * THE PAYLOAD IS ENCRYPTED END TO END and the push service cannot read it, which is the reason to
 * use the library rather than hand-rolling: the ECDH plus HKDF plus AES-GCM construction in RFC
 * 8291 is exactly the kind of thing that appears to work while being wrong.
 */

export type PushConfiguration =
  | { ok: true; publicKey: string }
  | { ok: false; missing: 'vapid_keys' | 'vapid_subject' };

/**
 * Whether this deployment can sign a push at all.
 *
 * VAPID is an identity, not a secret shared with the browser: the PUBLIC key is handed to the page
 * so it can mint a subscription bound to us, and the private key signs each send. They are a pair
 * and a mismatched one fails at the push service rather than here, so both are read from one place.
 *
 * The subject is required by the spec and must be a mailto: or https: URL identifying the sender,
 * so a push service has somebody to contact about abuse. Refusing to send without it is deliberate:
 * an unattributed push is the kind that gets a sender blocked wholesale.
 */
export function pushConfiguration(): PushConfiguration {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey) return { ok: false, missing: 'vapid_keys' };
  if (!subject || !/^(mailto:|https:)/.test(subject)) return { ok: false, missing: 'vapid_subject' };
  return { ok: true, publicKey };
}

export function pushConfigured(): boolean {
  return pushConfiguration().ok;
}

/** The public key the browser needs to mint a subscription, or null when unconfigured. */
export function pushPublicKey(): string | null {
  const configuration = pushConfiguration();
  return configuration.ok ? configuration.publicKey : null;
}

export type StoredPushSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type PushPayload = {
  title: string;
  body: string;
  /** Where a click lands. Always a Litos URL; never anything a caller supplied verbatim. */
  url: string;
  /** Collapses an older unshown notification of the same kind rather than stacking two. */
  tag: string;
};

export type PushDeliveryResult = {
  delivered: number;
  /** Endpoints deleted because the push service said the subscription is gone for good. */
  reaped: number;
  /** Devices that failed transiently and were kept. */
  failed: number;
};

function isGoneForever(error: unknown): boolean {
  const status = (error as { statusCode?: unknown })?.statusCode;
  /* 404 and 410 are the push service saying this subscription will never work again. Every other
     status, including 429 and 5xx, is a bad moment rather than a dead device, and deleting on those
     would quietly unsubscribe people whenever a vendor had an outage. */
  return status === 404 || status === 410;
}

export async function subscriptionsFor(userId: string): Promise<StoredPushSubscription[]> {
  return db
    .select({
      id: push_subscriptions.id,
      endpoint: push_subscriptions.endpoint,
      p256dh: push_subscriptions.p256dh,
      auth: push_subscriptions.auth,
    })
    .from(push_subscriptions)
    .where(eq(push_subscriptions.user_id, userId));
}

/**
 * Push one payload to every device an account has registered.
 *
 * PARTIAL SUCCESS IS SUCCESS. A student with a laptop and a desktop where only the laptop is
 * reachable has been notified. The caller records one notification, not one per device, because
 * the ledger is about what the STUDENT was told rather than about how many sockets it took.
 *
 * Never throws for a delivery failure. A dead device is an expected steady state, not an error, and
 * a throw here would make the digest cron fail on the first student with a stale subscription.
 */
export async function pushToUser(
  userId: string,
  payload: PushPayload,
  deps: { send?: typeof webpush.sendNotification } = {},
): Promise<PushDeliveryResult> {
  const configuration = pushConfiguration();
  if (!configuration.ok) return { delivered: 0, reaped: 0, failed: 0 };
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT!.trim(),
    process.env.VAPID_PUBLIC_KEY!.trim(),
    process.env.VAPID_PRIVATE_KEY!.trim(),
  );

  const subscriptions = await subscriptionsFor(userId);
  const send = deps.send ?? webpush.sendNotification.bind(webpush);
  const result: PushDeliveryResult = { delivered: 0, reaped: 0, failed: 0 };

  for (const subscription of subscriptions) {
    try {
      await send(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
        /* Twelve hours. A digest about yesterday is worth showing to somebody who opens their
           laptop at lunch and worthless by the time tomorrow's is due, so it expires rather than
           stacking up behind a closed lid. */
        { TTL: 12 * 60 * 60 },
      );
      result.delivered += 1;
      await db.update(push_subscriptions)
        .set({ last_success_at: new Date(), failure_count: 0 })
        .where(eq(push_subscriptions.id, subscription.id));
    } catch (error) {
      if (isGoneForever(error)) {
        await db.delete(push_subscriptions).where(eq(push_subscriptions.id, subscription.id));
        result.reaped += 1;
      } else {
        result.failed += 1;
        await db.update(push_subscriptions)
          .set({ failure_count: sql`${push_subscriptions.failure_count} + 1` })
          .where(eq(push_subscriptions.id, subscription.id));
      }
    }
  }
  return result;
}

/**
 * Record a device, or refresh the one already there.
 *
 * UPSERT ON THE ENDPOINT, because a browser hands back the SAME endpoint when a page re-subscribes
 * with the same application key. Inserting blindly would write a row per page load and then push
 * the same notification to the same laptop a dozen times.
 *
 * The endpoint is also re-pointed at the current user on conflict, which matters on a shared
 * machine: if a second student signs in on the same browser profile, the device belongs to whoever
 * is signed in now, and the first student must stop receiving notifications on it immediately.
 */
export async function rememberPushSubscription(input: {
  userId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}): Promise<void> {
  await db.insert(push_subscriptions)
    .values({
      user_id: input.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      user_agent: input.userAgent?.slice(0, 400) ?? null,
    })
    .onConflictDoUpdate({
      target: push_subscriptions.endpoint,
      set: {
        user_id: input.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        user_agent: input.userAgent?.slice(0, 400) ?? null,
        failure_count: 0,
      },
    });
}

/** Forget one device. Scoped to the owner so an endpoint cannot be removed by whoever guesses it. */
export async function forgetPushSubscription(userId: string, endpoint: string): Promise<boolean> {
  const removed = await db.delete(push_subscriptions)
    .where(and(eq(push_subscriptions.user_id, userId), eq(push_subscriptions.endpoint, endpoint)))
    .returning({ id: push_subscriptions.id });
  return removed.length > 0;
}
