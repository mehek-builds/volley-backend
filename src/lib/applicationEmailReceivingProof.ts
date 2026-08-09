import { createHash } from 'crypto';
import { and, eq, gte } from 'drizzle-orm';
import { db } from '../db';
import { application_email_receiving_proofs } from '../db/schema';
import {
  applicationEmailRouteSelection,
  normalizedApplicationEmailWebhookEndpoint,
} from './applicationEmailRoute';

export const MANAGED_RECEIVING_PROOF_VERSION = 2;
export const MANAGED_RECEIVING_PROOF_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type ManagedReceivingProof = {
  provider_message_hash: string;
  route_fingerprint: string;
  proof_version: number;
  domain: string;
  verified_at: Date;
};

export type ManagedReceivingProofStore = {
  findByMessageHash(hash: string): Promise<ManagedReceivingProof | null>;
  findCurrent(routeFingerprint: string, domain: string, proofVersion: number, notBefore: Date): Promise<ManagedReceivingProof | null>;
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

/** Exact one-time recipient, deliberately never returned by health or error responses. */
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
  if (route.mode !== 'managed_resend' || !route.domain || !secret || !token || !endpoint || !signingSecret) return null;
  return hash(`managed-receiving-proof-v${MANAGED_RECEIVING_PROOF_VERSION}:${route.mode}:${route.domain}:${secret}:${token}:${endpoint}:${signingSecret}`);
}

/** Version 1 omitted endpoint and signing-secret binding. It is never health evidence, but checking
 * its fingerprint prevents reusing an already-consumed one-time recipient during this upgrade. */
function legacyManagedReceivingProofRouteFingerprint(): string | null {
  const route = applicationEmailRouteSelection();
  const secret = aliasSecret();
  const token = canaryToken();
  if (route.mode !== 'managed_resend' || !route.domain || !secret || !token) return null;
  return hash(`managed-receiving-proof-v1:${route.mode}:${route.domain}:${secret}:${token}`);
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
  async findCurrent(routeFingerprint, domain, proofVersion, notBefore) {
    const rows = await db.select().from(application_email_receiving_proofs).where(and(
      eq(application_email_receiving_proofs.route_fingerprint, routeFingerprint),
      eq(application_email_receiving_proofs.domain, domain),
      eq(application_email_receiving_proofs.proof_version, proofVersion),
      gte(application_email_receiving_proofs.verified_at, notBefore),
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
};

export type ManagedCanaryAcceptance =
  | { kind: 'not_canary' }
  | { kind: 'accepted'; replay: boolean }
  | { kind: 'rejected' };

/** Called only after the route has cryptographically verified the Resend Svix signature. */
export async function acceptSignedManagedReceivingCanary(
  event: SignedResendCanaryEvent,
  options: { store?: ManagedReceivingProofStore; now?: Date } = {},
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
  if (legacyFingerprint && await store.findCurrent(legacyFingerprint, domain, 1, new Date(0))) {
    return { kind: 'rejected' };
  }

  const proof: ManagedReceivingProof = {
    provider_message_hash: providerMessageHash,
    route_fingerprint: routeFingerprint,
    proof_version: MANAGED_RECEIVING_PROOF_VERSION,
    domain,
    verified_at: options.now ?? new Date(),
  };
  const inserted = await store.insert(proof);
  if (inserted) return { kind: 'accepted', replay: false };

  // A concurrent replay can lose the insert race. It is idempotent only when the durable row is
  // exactly the proof this signed event would have written.
  const raced = await store.findByMessageHash(providerMessageHash);
  const sameProof = raced?.route_fingerprint === routeFingerprint
    && raced.domain === domain
    && raced.proof_version === MANAGED_RECEIVING_PROOF_VERSION;
  return sameProof ? { kind: 'accepted', replay: true } : { kind: 'rejected' };
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
    .findCurrent(routeFingerprint, route.domain, MANAGED_RECEIVING_PROOF_VERSION, notBefore);
  return Boolean(proof
    && proof.route_fingerprint === routeFingerprint
    && proof.domain === route.domain
    && proof.proof_version === MANAGED_RECEIVING_PROOF_VERSION
    && proof.verified_at >= notBefore
    && proof.verified_at <= now);
}
