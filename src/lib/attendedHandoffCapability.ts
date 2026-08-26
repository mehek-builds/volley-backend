import { createHash } from 'node:crypto';
import { canonicalPacketJson, packetAuditSha256 } from './packetAudit';

export const ATTENDED_HANDOFF_CAPABILITY_VERSION = 'attended_handoff_v1' as const;

export type AttendedHandoffCapabilityKind = 'manual_handoff' | 'self_submit';

export type AttendedHandoffCapability = {
  version: typeof ATTENDED_HANDOFF_CAPABILITY_VERSION;
  kind: AttendedHandoffCapabilityKind;
  capability_sha256: string;
  url_sha256: string;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const EVIDENCE_PREFIX = 'attended_handoff_capability_v1';

function sha256Text(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function canonicalAttendedUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('An attended capability requires an exact credential-free HTTPS URL');
  }
  return parsed.toString();
}

/** Hash a server-owned packet or handoff projection before it enters the capability identity. */
export function attendedHandoffDashboardBindingSha256(value: unknown): string {
  return packetAuditSha256(value);
}

/** Build the URL-free public identity for one exact attended employer capability. */
export function createAttendedHandoffCapability(input: {
  userId: string;
  applicationId: string;
  kind: AttendedHandoffCapabilityKind;
  canonicalUrl: string;
  dashboardBindingSha256: string;
}): AttendedHandoffCapability {
  if (!input.userId || !input.applicationId || !SHA256_PATTERN.test(input.dashboardBindingSha256)) {
    throw new Error('An attended capability requires an exact owner, application, and dashboard binding');
  }
  const canonicalUrl = canonicalAttendedUrl(input.canonicalUrl);
  const urlSha256 = sha256Text(canonicalUrl);
  const capabilitySha256 = sha256Text(canonicalPacketJson({
    version: ATTENDED_HANDOFF_CAPABILITY_VERSION,
    user_id: input.userId,
    application_id: input.applicationId,
    kind: input.kind,
    canonical_url: canonicalUrl,
    dashboard_binding_sha256: input.dashboardBindingSha256,
  }));
  return {
    version: ATTENDED_HANDOFF_CAPABILITY_VERSION,
    kind: input.kind,
    capability_sha256: capabilitySha256,
    url_sha256: urlSha256,
  };
}

/** Compact immutable-ledger representation. It contains hashes and routing type, never a URL. */
export function attendedHandoffCapabilityEvidenceCode(capability: AttendedHandoffCapability): string {
  return [
    EVIDENCE_PREFIX,
    capability.kind,
    capability.capability_sha256,
    capability.url_sha256,
  ].join(':');
}

export function attendedHandoffCapabilityFromEvidenceCode(
  value: string | null | undefined,
): AttendedHandoffCapability | null {
  if (!value) return null;
  const [prefix, kind, capabilitySha256, urlSha256, extra] = value.split(':');
  if (extra !== undefined
    || prefix !== EVIDENCE_PREFIX
    || (kind !== 'manual_handoff' && kind !== 'self_submit')
    || !SHA256_PATTERN.test(capabilitySha256 ?? '')
    || !SHA256_PATTERN.test(urlSha256 ?? '')) return null;
  return {
    version: ATTENDED_HANDOFF_CAPABILITY_VERSION,
    kind,
    capability_sha256: capabilitySha256!,
    url_sha256: urlSha256!,
  };
}

export function attendedHandoffCapabilitiesMatch(
  left: AttendedHandoffCapability | null | undefined,
  right: AttendedHandoffCapability | null | undefined,
): boolean {
  return Boolean(left && right)
    && left!.version === right!.version
    && left!.kind === right!.kind
    && left!.capability_sha256 === right!.capability_sha256
    && left!.url_sha256 === right!.url_sha256;
}
