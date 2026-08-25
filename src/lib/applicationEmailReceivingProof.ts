import { createHash } from 'crypto';
import { and, eq, gte, lte } from 'drizzle-orm';
import { db } from '../db';
import { application_email_receiving_proofs } from '../db/schema';
import {
  applicationEmailRouteSelection,
  normalizedApplicationEmailWebhookEndpoint,
} from './applicationEmailRoute';
import { assertResendReceivedEmailReadable, resendReceivingApiKey } from './resendReceiving';

export const MANAGED_RECEIVING_PROOF_VERSION = 3;
export const MANAGED_RECEIVING_PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const POSTGRES_SAFE_PROOF_UPPER_BOUND = new Date('9999-12-31T23:59:59.999Z');

export type ManagedReceivingProof = {
  provider_message_hash: string;
  route_fingerprint: string;
  proof_version: number;
  domain: string;
  verified_at: Date;
};

export type ManagedReceivingProofStore = {
  findByMessageHash(hash: string): Promise<ManagedReceivingProof | null>;
  findCurrent(routeFingerprint: string, domain: string, proofVersion: number, notBefore: Date, notAfter: Date): Promise<ManagedReceivingProof | null>;
  insert(proof: ManagedReceivingProof): Promise<boolean>;
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function aliasSecret(): string | null {
  return process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET?.trim()
    || process.env.LITOS_APPLICATION_EMAIL_SECRET?.trim()
    || process.env.JWT_SIGNING_SECRET?.trim()
    || null;
}

function canaryToken(): string | null {
  const token = process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN?.trim();
  return token && /^[A-Za-z0-9_-]{32,128}$/.test(token) ? token.toLowerCase() : null;
}

function resendWebhookSigningSecret(): string | null {
  return process.env.RESEND_WEBHOOK_SECRET?.trim() || null;
}

/** Exact dedicated recipient, deliberately never returned by health or error responses. */
export function configuredManagedReceivingCanaryRecipient(): string | null {
  const route = applicationEmailRouteSelection();
  const token = canaryToken();
  if (route.mode !== 'managed_resend' || !route.domain || !token) return null;
  return `litos-proof-${token}@${route.domain}`;
}

/**
 * Binding for durable proof. Changing mode, domain, alias secret, or canary token makes every old
 * row unusable without deleting it. Only this hash is persisted, never any input secret.
 */
export function managedReceivingProofRouteFingerprint(): string | null {
  const route = applicationEmailRouteSelection();
  const secret = aliasSecret();
  const token = canaryToken();
  const endpoint = normalizedApplicationEmailWebhookEndpoint();
  const signingSecret = resendWebhookSigningSecret();
  const receivingKey = resendReceivingApiKey();
  if (route.mode !== 'managed_resend' || !route.domain || !secret || !token || !endpoint || !signingSecret || !receivingKey) return null;
  return hash(`managed-receiving-proof-v${MANAGED_RECEIVING_PROOF_VERSION}:${route.mode}:${route.domain}:${secret}:${token}:${endpoint}:${signingSecret}:${receivingKey}`);
}

/** Version 1 omitted endpoint and signing-secret binding. It is never health evidence, and its
 * fingerprint forces token rotation before the same recipient can prove the stronger version. */
function legacyManagedReceivingProofRouteFingerprint(): string | null {
  const route = applicationEmailRouteSelection();
  const secret = aliasSecret();
  const token = canaryToken();
  if (route.mode !== 'managed_resend' || !route.domain || !secret || !token) return null;
  return hash(`managed-receiving-proof-v1:${route.mode}:${route.domain}:${secret}:${token}`);
}

/** Version 2 proved signed routing but did not prove that the configured provider key could read
 * received content. It is never health evidence and forces a canary-token rotation for version 3. */
function routeOnlyManagedReceivingProofRouteFingerprint(): string | null {
  const route = applicationEmailRouteSelection();
  const secret = aliasSecret();
  const token = canaryToken();
  const endpoint = normalizedApplicationEmailWebhookEndpoint();
  const signingSecret = resendWebhookSigningSecret();
  if (route.mode !== 'managed_resend' || !route.domain || !secret || !token || !endpoint || !signingSecret) return null;
  return hash(`managed-receiving-proof-v2:${route.mode}:${route.domain}:${secret}:${token}:${endpoint}:${signingSecret}`);
}

export function managedReceivingProviderMessageHash(providerMessageId: string): string {
  return hash(`resend-received-message-v1:${providerMessageId}`);
}

export const databaseManagedReceivingProofStore: ManagedReceivingProofStore = {
  async findByMessageHash(messageHash) {
    const rows = await db.select().from(application_email_receiving_proofs)
      .where(eq(application_email_receiving_proofs.provider_message_hash, messageHash))
      .limit(1);
    return rows[0] ?? null;
  },
  async findCurrent(routeFingerprint, domain, proofVersion, notBefore, notAfter) {
    const rows = await db.select().from(application_email_receiving_proofs).where(and(
      eq(application_email_receiving_proofs.route_fingerprint, routeFingerprint),
      eq(application_email_receiving_proofs.domain, domain),
      eq(application_email_receiving_proofs.proof_version, proofVersion),
      gte(application_email_receiving_proofs.verified_at, notBefore),
      lte(application_email_receiving_proofs.verified_at, notAfter),
    )).limit(1);
    return rows[0] ?? null;
  },
  async insert(proof) {
    const rows = await db.insert(application_email_receiving_proofs).values(proof)
      .onConflictDoNothing()
      .returning({ provider_message_hash: application_email_receiving_proofs.provider_message_hash });
    return rows.length === 1;
  },
};

export type SignedResendCanaryEvent = {
  emailId: string;
  recipients: string[];
  receivedAt?: Date;
};

export type ManagedCanaryAcceptance =
  | { kind: 'not_canary' }
  | { kind: 'accepted'; replay: boolean }
  | { kind: 'rejected' };

/** Called only after the route has cryptographically verified the Resend Svix signature. */
export async function acceptSignedManagedReceivingCanary(
  event: SignedResendCanaryEvent,
  options: {
    store?: ManagedReceivingProofStore;
    now?: Date;
    assertContentReadable?: (emailId: string) => Promise<void>;
  } = {},
): Promise<ManagedCanaryAcceptance> {
  const expectedRecipient = configuredManagedReceivingCanaryRecipient();
  const routeFingerprint = managedReceivingProofRouteFingerprint();
  const domain = applicationEmailRouteSelection().domain;
  if (!expectedRecipient || !routeFingerprint || !domain) return { kind: 'not_canary' };

  const recipients = event.recipients.map((recipient) => recipient.trim().toLowerCase()).filter(Boolean);
  if (!recipients.includes(expectedRecipient)) return { kind: 'not_canary' };
  // The exact canary must be the only recipient. A copied or foreign-recipient delivery does not
  // prove the configured route in isolation and is rejected without ordinary alias processing.
  if (recipients.length !== 1 || !event.emailId.trim()) return { kind: 'rejected' };

  // A signed delivery proves routing, but ordinary application processing also requires the
  // provider's Receiving read scope. Persist health evidence only after the same content lookup
  // used by real aliases succeeds. This prevents a sending-only or wrong-account key from making
  // /health report a route as deliverable.
  await (options.assertContentReadable ?? assertResendReceivedEmailReadable)(event.emailId.trim());

  const store = options.store ?? databaseManagedReceivingProofStore;
  const providerMessageHash = managedReceivingProviderMessageHash(event.emailId.trim());
  const existing = await store.findByMessageHash(providerMessageHash);
  if (existing) {
    const sameProof = existing.route_fingerprint === routeFingerprint
      && existing.domain === domain
      && existing.proof_version === MANAGED_RECEIVING_PROOF_VERSION;
    return sameProof ? { kind: 'accepted', replay: true } : { kind: 'rejected' };
  }


  const legacyFingerprint = legacyManagedReceivingProofRouteFingerprint();
  // JavaScript's maximum Date serializes with a signed six-digit year (`+275760...`). PostgreSQL's
  // timestamptz input rejects that ISO form before it can inspect the legacy row. A four-digit
  // sentinel remains far beyond every real proof while being portable through node-postgres.
  if (legacyFingerprint && await store.findCurrent(
    legacyFingerprint, domain, 1, new Date(0), POSTGRES_SAFE_PROOF_UPPER_BOUND,
  )) {
    return { kind: 'rejected' };
  }
  const routeOnlyFingerprint = routeOnlyManagedReceivingProofRouteFingerprint();
  if (routeOnlyFingerprint && await store.findCurrent(
    routeOnlyFingerprint, domain, 2, new Date(0), POSTGRES_SAFE_PROOF_UPPER_BOUND,
  )) {
    return { kind: 'rejected' };
  }

  const proof: ManagedReceivingProof = {
    provider_message_hash: providerMessageHash,
    route_fingerprint: routeFingerprint,
    proof_version: MANAGED_RECEIVING_PROOF_VERSION,
    domain,
    verified_at: options.now ?? event.receivedAt ?? new Date(),
  };
  const inserted = await store.insert(proof);
  if (inserted) return { kind: 'accepted', replay: false };

  // If a concurrent replay wins the insert race, accept only when durable
  // state now contains exactly the proof this signed event would have written.
  const raced = await store.findByMessageHash(providerMessageHash);
  const sameProof = raced?.route_fingerprint === routeFingerprint
    && raced.domain === domain
    && raced.proof_version === MANAGED_RECEIVING_PROOF_VERSION;
  return sameProof ? { kind: 'accepted', replay: true } : { kind: 'rejected' };
}

/* A real delivery to our own receiving domain proves the route, and the canary alone deadlocked it.
 *
 * The canary was the ONLY writer of proof, and it can only be sent by the daily cron: the recipient
 * embeds a secret token nobody can read back (Vercel marks it `sensitive`, which is write-only even
 * through the API with decrypt=true). So when the proof aged out on 2026-08-17, the system could not
 * recover on its own within the day, and the recovery it did attempt was circular - a fresh proof
 * needs an inbound delivery, submissions are what generate inbound deliveries, and submissions were
 * exactly what the stale proof was blocking.
 *
 * Meanwhile inbound receiving was demonstrably working the whole time. application_email_messages
 * holds real employer deliveries on 2026-08-11 and 2026-08-16 ("Security code for your application
 * to ..."), each one routed through the same MX, the same signed webhook and the same receiving key
 * the canary exercises. That evidence was being thrown away.
 *
 * So an ordinary signed delivery now writes proof too, under the same conditions the canary must
 * satisfy: a Svix-verified `email.received` (the caller checks this), arriving on the configured
 * endpoint (the caller checks this), addressed to our configured managed receiving domain, and whose
 * content the receiving key can actually read.
 *
 * WHAT IS GIVEN UP, precisely: the dedicated canary recipient is reusable, so the scheduled canary
 * can renew the proof it exists to maintain. Someone who learns an address can mail it, but cannot
 * make Resend sign a delivery to our endpoint. Stale replay is rejected by Svix's timestamp window.
 * Every provider hash is stored immutably, which makes all retries idempotent, while the provider's
 * signed receivedAt keeps delayed delivery from inventing a newer proof time. The recipient-domain
 * test keeps a delivery for some OTHER domain from vouching for this one.
 */
export async function recordManagedReceivingProofFromDelivery(
  event: SignedResendCanaryEvent,
  options: {
    store?: ManagedReceivingProofStore;
    now?: Date;
    assertContentReadable?: (emailId: string) => Promise<void>;
  } = {},
): Promise<boolean> {
  const route = applicationEmailRouteSelection();
  const routeFingerprint = managedReceivingProofRouteFingerprint();
  const domain = route.domain;
  if (route.mode !== 'managed_resend' || !domain || !routeFingerprint) return false;

  const emailId = event.emailId.trim();
  if (!emailId) return false;
  // At least one recipient on OUR receiving domain. A delivery addressed only elsewhere says nothing
  // about whether this domain receives.
  const onDomain = event.recipients
    .map((recipient) => recipient.trim().toLowerCase())
    .some((recipient) => recipient.endsWith(`@${domain}`));
  if (!onDomain) return false;

  await (options.assertContentReadable ?? assertResendReceivedEmailReadable)(emailId);

  const store = options.store ?? databaseManagedReceivingProofStore;
  const providerMessageHash = managedReceivingProviderMessageHash(emailId);
  const existing = await store.findByMessageHash(providerMessageHash);
  if (existing) {
    return existing.route_fingerprint === routeFingerprint
      && existing.domain === domain
      && existing.proof_version === MANAGED_RECEIVING_PROOF_VERSION;
  }

  /* Each signed provider delivery is an immutable proof event. The old unique route-fingerprint
   * index admitted the first event, then silently refused every later one and let health expire
   * after seven days. The provider-message primary key is the replay guard; multiple events for the
   * same route are the evidence history recentManagedReceivingProof is designed to search. */
  return store.insert({
    provider_message_hash: providerMessageHash,
    route_fingerprint: routeFingerprint,
    proof_version: MANAGED_RECEIVING_PROOF_VERSION,
    domain,
    verified_at: options.now ?? event.receivedAt ?? new Date(),
  });
}

export async function recentManagedReceivingProof(options: {
  store?: ManagedReceivingProofStore;
  now?: Date;
} = {}): Promise<boolean> {
  const route = applicationEmailRouteSelection();
  const routeFingerprint = managedReceivingProofRouteFingerprint();
  if (route.mode !== 'managed_resend' || !route.domain || !routeFingerprint) return false;
  const now = options.now ?? new Date();
  const notBefore = new Date(now.getTime() - MANAGED_RECEIVING_PROOF_MAX_AGE_MS);
  const proof = await (options.store ?? databaseManagedReceivingProofStore)
    .findCurrent(routeFingerprint, route.domain, MANAGED_RECEIVING_PROOF_VERSION, notBefore, now);
  return Boolean(proof
    && proof.route_fingerprint === routeFingerprint
    && proof.domain === route.domain
    && proof.proof_version === MANAGED_RECEIVING_PROOF_VERSION
    && proof.verified_at >= notBefore
    && proof.verified_at <= now);
}
