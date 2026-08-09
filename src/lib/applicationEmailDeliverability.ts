import { promises as dnsPromises } from 'dns';
import {
  DEFAULT_INBOUND_WEBHOOK_URL,
  applicationEmailWebhookEndpoint,
  applicationEmailRouteSelection,
  configuredResendManagedReceivingDomain,
} from './applicationEmailRoute';
import {
  configuredManagedReceivingCanaryRecipient,
  managedReceivingProofRouteFingerprint,
  recentManagedReceivingProof,
} from './applicationEmailReceivingProof';
import { controlledQaEmailCapture } from './email';

/* CAN THE ALIAS DOMAIN ACTUALLY RECEIVE MAIL, measured rather than assumed.
 *
 * Litos writes a generated alias (app-<id>-<token>@apply.trylitos.com) onto real employer
 * application forms, and on 2026-08-08 that domain had NO MX RECORD. Every application submitted
 * carried an applicant address that cannot receive mail: employer confirmations and recruiter
 * replies bounce and the applicant is simply unreachable, on an application she cannot resend.
 * `application_email_messages` had zero rows, so nothing had ever arrived, and nothing said so.
 *
 * The old test for "is the application inbox working" was `LITOS_APPLICATION_EMAIL_DOMAIN is a
 * non-empty string`, which is a test of a deploy config and not of the world. This module tests the
 * world:
 *   1. the alias domain resolves at least one MX host, so a sending mail server has somewhere to go
 *   2. the domain is registered AND verified in Resend, so Resend will accept mail for it
 *   3. an inbound route (`email.received` webhook) at Resend points at our own endpoint, so a
 *      message that arrives is handed to us rather than parked in Resend forever
 *
 * All three are required, because the applicant's question is not "was a record published" but
 * "will a reply reach me". Any one of them missing means it will not.
 *
 * FAIL SAFE. Every unknown resolves to NOT deliverable. Losing alias tracking on an application
 * costs a nice-to-have; putting an unreachable address in front of an employer costs the
 * application. There is no configuration that forces the alias on without the measurement passing.
 *
 * NOT IN THE HOT PATH. The result is cached per domain with a TTL and concurrent callers share one
 * in-flight probe, so a burst of submissions performs one DNS lookup and two API calls between
 * them, not one set each. The undeliverable TTL is deliberately short: the day the MX record is
 * published at Porkbun the alias must switch itself back on without a deploy or a human. */

export type AliasDeliverabilityReason =
  | 'deliverable'
  | 'alias_not_configured'
  | 'inbound_disabled'
  | 'no_mx_record'
  | 'mx_provider_mismatch'
  | 'domain_not_verified_in_resend'
  | 'receiving_not_enabled_in_resend'
  | 'managed_receiving_proof_missing'
  | 'managed_receiving_proof_mismatch'
  | 'inbound_route_missing'
  | 'forwarding_not_configured'
  | 'check_unavailable';

export type AliasMxProvider = 'resend' | 'google_workspace' | 'mixed' | 'other' | 'unknown';

export type AliasDeliverability = {
  deliverable: boolean;
  domain: string | null;
  reason: AliasDeliverabilityReason;
  detail?: string;
  mx_hosts: string[];
  mx_provider: AliasMxProvider;
  mx_provider_agrees: boolean;
  resend_domain_status: string | null;
  resend_receiving_status: string | null;
  inbound_route_configured: boolean;
  checked_at: string;
};

export type ResendDomainRecord = {
  name?: string;
  status?: string;
  capabilities?: { receiving?: string; sending?: string };
};
export type ResendWebhookRecord = { endpoint?: string; events?: string[]; status?: string };

export type DeliverabilityProbes = {
  resolveMx?: (domain: string) => Promise<Array<{ exchange: string; priority: number }>>;
  resendDomains?: () => Promise<ResendDomainRecord[]>;
  resendWebhooks?: () => Promise<ResendWebhookRecord[]>;
  managedReceivingProof?: () => Promise<boolean>;
  now?: () => number;
};

export class ResendApiHttpError extends Error {
  constructor(readonly path: string, readonly status: number) {
    super(`Resend ${path} answered ${status}`);
    this.name = 'ResendApiHttpError';
  }
}

// One hour on a good result, five minutes on a bad one. The asymmetry is the point: a working
// inbox does not stop working every few minutes, but a broken one is expected to be repaired, and
// the repair is a DNS record published by hand at a registrar nobody here has credentials for.
// Five minutes is how long after that publication Litos starts trusting the alias again.
const DELIVERABLE_TTL_MS = 60 * 60 * 1000;
const UNDELIVERABLE_TTL_MS = 5 * 60 * 1000;
const DNS_TIMEOUT_MS = 3_000;
const RESEND_TIMEOUT_MS = 5_000;

export { DEFAULT_INBOUND_WEBHOOK_URL } from './applicationEmailRoute';

type CacheEntry = { domain: string | null; configSignature: string; expiresAt: number; value: AliasDeliverability };

let cached: CacheEntry | null = null;
let inFlight: Promise<AliasDeliverability> | null = null;

export function resetApplicationAliasDeliverabilityCache(): void {
  cached = null;
  inFlight = null;
}

/** The domain employers would actually send to, whichever alias shape is configured. */
export function aliasDomain(): string | null {
  return applicationEmailRouteSelection().domain;
}

/* The explicit configuration signal, and it can only ever say NO.
 *
 * Setting LITOS_APPLICATION_EMAIL_INBOUND_ENABLED to false/0/off is an operator kill switch: use
 * it while the inbox is being migrated, so aliases stop appearing on forms immediately without
 * waiting for DNS to reflect anything. There is deliberately no value that forces the alias ON,
 * because the whole failure being fixed here is a boolean in an environment being believed over
 * the mail system. */
export function inboundAliasDisabled(): boolean {
  const raw = process.env.LITOS_APPLICATION_EMAIL_INBOUND_ENABLED?.trim().toLowerCase();
  return raw === 'false' || raw === '0' || raw === 'off' || raw === 'no';
}

export function applicationEmailForwardingConfigured(): boolean {
  if (controlledQaEmailCapture()) return true;
  const key = process.env.RESEND_API_KEY?.trim();
  const sender = process.env.RESEND_FROM?.trim();
  if (!key || !sender) return false;
  const bracketed = sender.match(/^[^<>]*<([^<>]+)>$/)?.[1];
  const address = bracketed ?? sender;
  return /^[^<>@\s]+@[^<>@\s]+$/.test(address);
}

export function inboundWebhookEndpoint(): string {
  return applicationEmailWebhookEndpoint();
}

function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

// NXDOMAIN and ENODATA are answers: the resolver reached the authority and it has no MX. Anything
// else (SERVFAIL, a timeout, no network from the function) is an absence of information, and the
// two are reported apart so /health can distinguish "the record is missing" from "we could not
// look". Both are undeliverable; only one of them is the registrar's job to fix.
function dnsErrorIsAnswer(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN';
}

async function resendGet<T>(path: string): Promise<T[]> {
  const key = process.env.RESEND_API_KEY?.trim();
  if (!key) throw new Error('RESEND_API_KEY is not set');
  const response = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
  });
  if (!response.ok) throw new ResendApiHttpError(path, response.status);
  const body = await response.json() as { data?: T[] } | T[];
  if (Array.isArray(body)) return body;
  return Array.isArray(body?.data) ? body.data : [];
}

export function listResendDomains(): Promise<ResendDomainRecord[]> {
  return resendGet<ResendDomainRecord>('/domains');
}

export function listResendWebhooks(): Promise<ResendWebhookRecord[]> {
  return resendGet<ResendWebhookRecord>('/webhooks');
}

export function resendDomainStatus(domains: readonly ResendDomainRecord[], domain: string): string | null {
  const match = domains.find((row) => row.name?.trim().toLowerCase() === domain);
  return match ? (match.status?.trim().toLowerCase() || 'unknown') : null;
}

/* Exact name match, never a parent-domain match.
 *
 * trylitos.com being verified in Resend says nothing about apply.trylitos.com: they are separate
 * records with separate MX, and inbound is configured per receiving domain. Accepting a suffix
 * match would let a domain verified for SENDING vouch for a subdomain that cannot RECEIVE, which
 * is precisely the mistake this module exists to stop. */
export function resendDomainIsVerified(domains: readonly ResendDomainRecord[], domain: string): boolean {
  return resendDomainStatus(domains, domain) === 'verified';
}

export function resendReceivingStatus(domains: readonly ResendDomainRecord[], domain: string): string | null {
  const match = domains.find((row) => row.name?.trim().toLowerCase() === domain);
  return match?.capabilities?.receiving?.trim().toLowerCase() || null;
}

const RESEND_INBOUND_MX = /^inbound-smtp\.[a-z0-9-]+\.amazonaws\.com\.?$/i;
const GOOGLE_WORKSPACE_MX = /(?:^|\.)google(?:mail)?\.com\.?$/i;

export function classifyAliasMxProvider(
  records: readonly { exchange: string; priority: number }[],
): AliasMxProvider {
  const hosts = records.map((record) => record.exchange.trim().toLowerCase()).filter(Boolean);
  if (hosts.length === 0) return 'unknown';
  const hasResend = hosts.some((host) => RESEND_INBOUND_MX.test(host));
  const hasGoogle = hosts.some((host) => GOOGLE_WORKSPACE_MX.test(host));
  if (hasResend && hosts.some((host) => !RESEND_INBOUND_MX.test(host))) return 'mixed';
  if (hasResend) return 'resend';
  if (hasGoogle) return 'google_workspace';
  return 'other';
}

/**
 * Resend receives mail only when its inbound MX has the best, lowest numeric priority. Merely
 * publishing the host beside Google Workspace is not enough and can make delivery nondeterministic.
 */
export function mxRoutesToResend(
  records: readonly { exchange: string; priority: number }[],
): boolean {
  if (records.length === 0) return false;
  const bestPriority = Math.min(...records.map((record) => record.priority));
  const best = records.filter((record) => record.priority === bestPriority);
  return best.length > 0 && best.every((record) => RESEND_INBOUND_MX.test(record.exchange.trim()));
}

export function inboundRouteConfigured(
  webhooks: readonly ResendWebhookRecord[],
  endpoint: string,
): boolean {
  const wanted = endpoint.trim().toLowerCase().replace(/\/+$/, '');
  return webhooks.some((hook) => {
    const configured = hook.endpoint?.trim().toLowerCase().replace(/\/+$/, '');
    if (configured !== wanted) return false;
    if (!Array.isArray(hook.events) || !hook.events.includes('email.received')) return false;
    const status = hook.status?.trim().toLowerCase();
    return status === undefined || status === '' || status === 'enabled' || status === 'active';
  });
}

async function probe(probes: DeliverabilityProbes): Promise<AliasDeliverability> {
  const checkedAt = new Date(probes.now?.() ?? Date.now()).toISOString();
  const domain = aliasDomain();
  const base: AliasDeliverability = {
    deliverable: false,
    domain,
    reason: 'check_unavailable',
    mx_hosts: [],
    mx_provider: 'unknown',
    mx_provider_agrees: false,
    resend_domain_status: null,
    resend_receiving_status: null,
    inbound_route_configured: false,
    checked_at: checkedAt,
  };
  if (!domain) return { ...base, reason: 'alias_not_configured' };
  if (inboundAliasDisabled()) return { ...base, reason: 'inbound_disabled' };
  if (!applicationEmailForwardingConfigured()) return { ...base, reason: 'forwarding_not_configured' };

  if (configuredResendManagedReceivingDomain() === domain) {
    const canaryRecipient = configuredManagedReceivingCanaryRecipient();
    const proofFingerprint = managedReceivingProofRouteFingerprint();
    if (!canaryRecipient || !proofFingerprint) return { ...base, reason: 'managed_receiving_proof_missing' };
    try {
      const proved = await (probes.managedReceivingProof
        ?? (() => recentManagedReceivingProof({ now: new Date(probes.now?.() ?? Date.now()) })))();
      if (!proved) return { ...base, reason: 'managed_receiving_proof_mismatch' };
    } catch (error) {
      return { ...base, reason: 'check_unavailable', detail: describeManagedProofError(error) };
    }

    if (controlledQaEmailCapture()) {
      return {
        ...base,
        deliverable: true,
        reason: 'deliverable',
        inbound_route_configured: true,
        detail: 'Controlled local QA adapter with fresh signed route evidence',
      };
    }

    try {
      const webhooks = await (probes.resendWebhooks ?? listResendWebhooks)();
      const routed = inboundRouteConfigured(webhooks, inboundWebhookEndpoint());
      if (!routed) return { ...base, reason: 'inbound_route_missing' };
      return { ...base, deliverable: true, reason: 'deliverable', inbound_route_configured: true };
    } catch (error) {
      // A 401/403 says only that this sending key cannot inspect webhook administration. The fresh
      // durable proof already establishes that Resend delivered `email.received` to the exact URL
      // using the exact signing secret. Other failures remain unknown and therefore fail closed.
      if (error instanceof ResendApiHttpError
        && error.path === '/webhooks'
        && (error.status === 401 || error.status === 403)) {
        return {
          ...base,
          deliverable: true,
          reason: 'deliverable',
          inbound_route_configured: true,
          detail: 'Webhook listing is unauthorized; using fresh signed route evidence',
        };
      }
      return { ...base, reason: 'check_unavailable', detail: describeManagedProofError(error) };
    }
  }

  let mxRecords: Array<{ exchange: string; priority: number }>;
  let mxHosts: string[];
  try {
    const resolver = probes.resolveMx ?? ((name: string) => dnsPromises.resolveMx(name));
    mxRecords = await withTimeout(resolver(domain), DNS_TIMEOUT_MS, 'MX lookup');
    mxHosts = mxRecords
      .map((record) => record.exchange?.trim().toLowerCase())
      .filter((host): host is string => Boolean(host));
    if (mxHosts.length === 0) return { ...base, reason: 'no_mx_record' };
  } catch (error) {
    return {
      ...base,
      reason: dnsErrorIsAnswer(error) ? 'no_mx_record' : 'check_unavailable',
      detail: describe(error),
    };
  }

  const mxProvider = classifyAliasMxProvider(mxRecords);
  if (!mxRoutesToResend(mxRecords)) {
    return {
      ...base,
      mx_hosts: mxHosts,
      mx_provider: mxProvider,
      reason: 'mx_provider_mismatch',
      detail: mxProvider === 'google_workspace'
        ? `MX for ${domain} routes to Google Workspace, but inbound processing is configured for Resend. Configure a dedicated Resend receiving subdomain and keep the root Google MX unchanged.`
        : `MX for ${domain} does not route exclusively to Resend at the best priority. Configure the Resend inbound MX on a dedicated receiving subdomain.`,
    };
  }

  let domainStatus: string | null;
  let receivingStatus: string | null;
  try {
    const domains = await (probes.resendDomains ?? listResendDomains)();
    domainStatus = resendDomainStatus(domains, domain);
    if (domainStatus !== 'verified') {
      return {
        ...base,
        mx_hosts: mxHosts,
        mx_provider: mxProvider,
        mx_provider_agrees: true,
        resend_domain_status: domainStatus,
        reason: 'domain_not_verified_in_resend',
      };
    }
    receivingStatus = resendReceivingStatus(domains, domain);
    if (receivingStatus !== 'enabled') {
      return {
        ...base,
        mx_hosts: mxHosts,
        mx_provider: mxProvider,
        mx_provider_agrees: true,
        resend_domain_status: domainStatus,
        resend_receiving_status: receivingStatus,
        reason: 'receiving_not_enabled_in_resend',
      };
    }
  } catch (error) {
    return {
      ...base,
      mx_hosts: mxHosts,
      mx_provider: mxProvider,
      mx_provider_agrees: true,
      reason: 'check_unavailable',
      detail: describe(error),
    };
  }

  try {
    const webhooks = await (probes.resendWebhooks ?? listResendWebhooks)();
    const routed = inboundRouteConfigured(webhooks, inboundWebhookEndpoint());
    if (!routed) {
      return {
        ...base,
        mx_hosts: mxHosts,
        mx_provider: mxProvider,
        mx_provider_agrees: true,
        resend_domain_status: domainStatus,
        resend_receiving_status: receivingStatus,
        reason: 'inbound_route_missing',
      };
    }
    return {
      deliverable: true,
      domain,
      reason: 'deliverable',
      mx_hosts: mxHosts,
      mx_provider: mxProvider,
      mx_provider_agrees: true,
      resend_domain_status: domainStatus,
      resend_receiving_status: receivingStatus,
      inbound_route_configured: true,
      checked_at: checkedAt,
    };
  } catch (error) {
    return {
      ...base,
      mx_hosts: mxHosts,
      mx_provider: mxProvider,
      mx_provider_agrees: true,
      resend_domain_status: domainStatus,
      resend_receiving_status: receivingStatus,
      reason: 'check_unavailable',
      detail: describe(error),
    };
  }
}

function describe(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 200);
}

function describeManagedProofError(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error);
  const secrets = [
    process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN?.trim(),
    process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_ID?.trim(),
    configuredManagedReceivingCanaryRecipient(),
  ].filter((value): value is string => Boolean(value)).sort((left, right) => right.length - left.length);
  return secrets.reduce(
    (value, secret) => value.replaceAll(secret, '[redacted]').replaceAll(encodeURIComponent(secret), '[redacted]'),
    raw,
  ).slice(0, 200);
}

/**
 * Cached, de-duplicated, and it never throws. A caller that cannot reach DNS or Resend gets
 * `deliverable: false` with a reason, which is the same answer it would get from a domain that
 * genuinely cannot receive mail, and leads to the same safe fallback.
 */
export async function applicationAliasDeliverability(
  probes: DeliverabilityProbes = {},
): Promise<AliasDeliverability> {
  const now = probes.now?.() ?? Date.now();
  const domain = aliasDomain();
  const configSignature = `${domain ?? ''}|${inboundAliasDisabled()}|${applicationEmailForwardingConfigured()}`
    + `|${process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE?.trim().toLowerCase() ?? ''}`
    + `|${process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN?.trim().toLowerCase() ?? ''}`
    + `|${managedReceivingProofRouteFingerprint() ?? ''}`;
  if (cached && cached.domain === domain && cached.configSignature === configSignature && cached.expiresAt > now) return cached.value;
  if (inFlight) return inFlight;
  inFlight = probe(probes)
    .catch((error): AliasDeliverability => ({
      deliverable: false,
      domain,
      reason: 'check_unavailable',
      detail: configuredResendManagedReceivingDomain() ? describeManagedProofError(error) : describe(error),
      mx_hosts: [],
      mx_provider: 'unknown',
      mx_provider_agrees: false,
      resend_domain_status: null,
      resend_receiving_status: null,
      inbound_route_configured: false,
      checked_at: new Date(now).toISOString(),
    }))
    .then((value) => {
      cached = {
        domain,
        configSignature,
        expiresAt: now + (value.deliverable ? DELIVERABLE_TTL_MS : UNDELIVERABLE_TTL_MS),
        value,
      };
      inFlight = null;
      return value;
    });
  return inFlight;
}

/**
 * Fire-and-forget warm at boot so the first real submission of a cold instance does not pay for
 * the lookup. Swallows everything: a warm that fails simply leaves the cache empty.
 */
export function warmApplicationAliasDeliverability(): void {
  void applicationAliasDeliverability().catch(() => undefined);
}
