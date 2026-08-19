import { createHmac, timingSafeEqual } from 'node:crypto';
import { isNotificationKind, type NotificationKind } from './notificationPreferences';

/* UNSUBSCRIBE THAT WORKS WITHOUT LOGGING IN, which is the whole requirement and the reason this is
 * a signed token rather than a session.
 *
 * Somebody who wants Litos mail to stop is, very often, somebody who cannot or will not sign in:
 * they forgot the password, the account was made months ago, or the address was forwarded to them
 * and they never had one. An unsubscribe link that lands on a login wall is not an unsubscribe
 * link. It is a retention gate wearing the word, and it is also the single fastest way to turn a
 * "stop emailing me" into a spam complaint against the sending domain, which costs every other
 * student's application mail its deliverability.
 *
 * SIGNED, NOT STORED. The alternative is a random token column on users, and it buys nothing here:
 * revocation already exists (the toggle goes off, and the link then finds nothing to turn off),
 * and a stored token is one more secret at rest and one more thing to migrate. The HMAC's message
 * is domain-separated by a fixed prefix so a token minted for unsubscribe can never be replayed
 * against any other HMAC this codebase computes over a user id, of which there is at least one
 * already (lemonSqueezy.ts signs a bare userId with its own secret).
 *
 * THE TOKEN IS NOT A CREDENTIAL AND MUST NEVER BECOME ONE. It authorises exactly one act, turning
 * notifications off, which is the one act that is safe for a stranger holding a forwarded email to
 * perform: the worst an attacker with a leaked link can do is stop mail the recipient did not have
 * to receive. It can never turn a notification ON, read anything, or authenticate a request. That
 * asymmetry is why it needs no expiry: a five year old link that still stops mail is correct
 * behaviour, and an expired unsubscribe link is a broken one.
 */

const TOKEN_VERSION = 'v1';
const HMAC_DOMAIN = 'litos.notification.unsubscribe.v1';

/**
 * The signing key, or null when the deployment has none.
 *
 * FALLS BACK TO THE JWT SECRET DELIBERATELY. A dedicated variable is preferred and is what an
 * operator should set, but the fallback is what makes the feature correct on the deploy that ships
 * it rather than on whichever later day somebody remembers to add an env var. JWT_SIGNING_SECRET is
 * present in every environment that can serve a signed-in request at all, and the domain prefix
 * above means a token signed with it cannot be confused with a session token: the two sign
 * different messages under different constructions (jose JWS versus a raw HMAC over a prefixed
 * string), so neither can be presented to the other's verifier.
 *
 * Null is a real answer and the send path treats it as fatal. See unsubscribeConfigured.
 */
function signingSecret(): string | null {
  return process.env.LITOS_NOTIFICATION_UNSUBSCRIBE_SECRET?.trim()
    || process.env.JWT_SIGNING_SECRET?.trim()
    || null;
}

export function unsubscribeConfigured(): boolean {
  return signingSecret() !== null;
}

function sign(secret: string, message: string): string {
  return createHmac('sha256', secret).update(`${HMAC_DOMAIN}:${message}`).digest('base64url');
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The token that goes in one notification's unsubscribe link.
 *
 * IT CARRIES THE KIND, so the link stops the stream that actually mailed her rather than every
 * stream at once. Somebody who is tired of match alerts has said nothing about wanting to miss an
 * employer's reply, and a single collapse-everything link makes the cheaper action unavailable and
 * pushes her to the expensive one. The confirmation page offers "all of it" as a second button, so
 * the blunt instrument is still one click away for anyone who wants it.
 *
 * Throws rather than returning null when there is no secret. A caller that treated an unsigned
 * token as good enough would mint a link that cannot be verified, which is a notification with a
 * dead unsubscribe: the one shape of this email that must never be sent.
 */
export function mintUnsubscribeToken(userId: string, kind: NotificationKind): string {
  const secret = signingSecret();
  if (!secret) throw new Error('No signing secret is configured for notification unsubscribe links');
  const payload = `${TOKEN_VERSION}.${kind}.${Buffer.from(userId).toString('base64url')}`;
  return `${payload}.${sign(secret, payload)}`;
}

export type UnsubscribeClaim = { userId: string; kind: NotificationKind };

/** The token's claim, or null for anything this deployment did not sign. */
export function readUnsubscribeToken(token: string): UnsubscribeClaim | null {
  const secret = signingSecret();
  if (!secret) return null;
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, kind, encodedUserId, signature] = parts;
  if (version !== TOKEN_VERSION || !isNotificationKind(kind)) return null;
  if (!equal(signature, sign(secret, `${version}.${kind}.${encodedUserId}`))) return null;
  /* Decoded only after the signature holds, so a forged token never reaches the round-trip check
     below and can never be probed for which user ids decode cleanly. */
  const userId = Buffer.from(encodedUserId, 'base64url').toString();
  /* base64url decoding accepts input the encoder would never produce, so the only safe test that
     the id survived the trip is re-encoding it and comparing. Without this a token whose payload
     differs from a valid one only in padding would verify against the same signature and then be
     used as a different string than the one that was signed. */
  if (Buffer.from(userId).toString('base64url') !== encodedUserId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return null;
  return { userId, kind };
}

/**
 * The absolute URL the link points at.
 *
 * PUBLIC_API_BASE is the only source, because this runs on a cron with no inbound request to read
 * a host from, and a relative link in an email is not a link. Null when it is unset, and the send
 * path treats that the same way it treats a missing secret: no unsubscribe means no send.
 */
export function unsubscribeUrl(token: string): string | null {
  const base = process.env.PUBLIC_API_BASE?.trim().replace(/\/+$/, '');
  if (!base) return null;
  try {
    const url = new URL('/notifications/unsubscribe', base);
    url.searchParams.set('token', token);
    return url.toString();
  } catch {
    return null;
  }
}
