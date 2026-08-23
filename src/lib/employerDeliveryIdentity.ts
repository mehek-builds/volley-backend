import { createHash } from 'node:crypto';
import type { ApplicationReviewState } from './applicationReview';
import type { SubmissionPacket } from './portalSubmission';
import { packetAuditSha256 } from './packetAudit';

export const EMPLOYER_DELIVERY_BINDING_VERSION = 'employer_delivery_v1' as const;

export type EmployerPacketDeliveryMode = 'full' | 'browser';
export type EmployerDeliveryMode = EmployerPacketDeliveryMode | 'extension';

export type EmployerDeliveryBindings = {
  version: typeof EMPLOYER_DELIVERY_BINDING_VERSION;
  mode: EmployerDeliveryMode;
  sha256: string;
};

export type EmployerDeliveryChannel =
  | 'unsupported_email'
  | 'controlled_browser'
  | 'extension'
  | 'browser:browserbase'
  | 'browser:stratus'
  | 'browser:stratus-managed';

export type EmployerDeliveryEnvelope = {
  channel: EmployerDeliveryChannel;
  destinationUrl: string;
  portalFamily: string;
  capabilityPolicy: {
    coverLetterSupported?: boolean;
    transcriptSupported?: boolean;
  };
  runtime?: unknown;
  email?: unknown;
};

export function browserEmployerDeliveryChannel(
  provider: 'browserbase' | 'stratus' | 'stratus-managed',
): EmployerDeliveryChannel {
  switch (provider) {
    case 'browserbase': return 'browser:browserbase';
    case 'stratus': return 'browser:stratus';
    case 'stratus-managed': return 'browser:stratus-managed';
  }
}

export function employerDeliveryEnvelope(input: {
  channel: EmployerDeliveryChannel;
  destinationUrl: string;
  portalFamily: string;
  coverLetterSupported?: boolean;
  transcriptSupported?: boolean;
  runtime?: unknown;
  email?: unknown;
}): EmployerDeliveryEnvelope {
  return {
    channel: input.channel,
    destinationUrl: input.destinationUrl,
    portalFamily: input.portalFamily,
    capabilityPolicy: {
      coverLetterSupported: input.coverLetterSupported,
      transcriptSupported: input.transcriptSupported,
    },
    ...(input.runtime !== undefined ? { runtime: input.runtime } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
  };
}

type PacketFieldClass = 'json' | 'file';

/**
 * Every SubmissionPacket key must be classified here. A new fill-behavior field cannot silently
 * escape the delivery binding because TypeScript refuses this table until the author classifies it.
 */
export const EMPLOYER_DELIVERY_PACKET_FIELDS = {
  fullName: 'json',
  email: 'json',
  applicantEmail: 'json',
  phone: 'json',
  city: 'json',
  country: 'json',
  linkedinUrl: 'json',
  githubUrl: 'json',
  portfolioUrl: 'json',
  school: 'json',
  degree: 'json',
  graduationDate: 'json',
  graduationMonth: 'json',
  graduationYear: 'json',
  currentlyEnrolled: 'json',
  gpa: 'json',
  major: 'json',
  roleLocation: 'json',
  roleLocations: 'json',
  roleCountry: 'json',
  roleCountryCode: 'json',
  referralSourceDefault: 'json',
  referralSourceEvidence: 'json',
  fieldOptions: 'json',
  failedFields: 'json',
  applicationProfile: 'json',
  applicantSnapshot: 'json',
  employerName: 'json',
  jdText: 'json',
  resume: 'file',
  resumeName: 'json',
  coverLetter: 'file',
  coverLetterName: 'json',
  transcript: 'file',
  transcriptName: 'json',
  transcriptUnavailableReason: 'json',
  eeoPrefs: 'json',
  mostRecentRole: 'json',
  questions: 'json',
} as const satisfies Record<keyof SubmissionPacket, PacketFieldClass>;

function fileProjection(value: Buffer): { sha256: string; sizeBytes: number } {
  return {
    sha256: createHash('sha256').update(value).digest('hex'),
    sizeBytes: value.byteLength,
  };
}

export function employerDeliveryProjection(packet: SubmissionPacket): Record<string, unknown> {
  const projection: Record<string, unknown> = {};
  for (const key of Object.keys(EMPLOYER_DELIVERY_PACKET_FIELDS) as Array<keyof SubmissionPacket>) {
    const value = packet[key];
    if (value === undefined) continue;
    // A managed discovery pass reports an explicit empty inventory after an audit built before the
    // page was probed. Empty and absent both mean there is no behavior-bearing form evidence, so
    // one canonical omission prevents a false packet drift while nonempty evidence stays bound.
    if (key === 'fieldOptions'
      && value !== null
      && typeof value === 'object'
      && !Array.isArray(value)
      && Object.keys(value as Record<string, unknown>).length === 0) continue;
    if (key === 'failedFields' && Array.isArray(value) && value.length === 0) continue;
    projection[key] = EMPLOYER_DELIVERY_PACKET_FIELDS[key] === 'file'
      ? fileProjection(value as Buffer)
      : value;
  }
  return projection;
}

export function employerDeliverySha256(
  packet: SubmissionPacket,
  envelope: EmployerDeliveryEnvelope,
): string {
  return packetAuditSha256({
    version: EMPLOYER_DELIVERY_BINDING_VERSION,
    packet: employerDeliveryProjection(packet),
    envelope,
  });
}

export function packetForEmployerDelivery(
  packet: SubmissionPacket,
  review: Pick<ApplicationReviewState, 'cover_letter_supported' | 'transcript_supported'>,
  mode: EmployerPacketDeliveryMode,
): SubmissionPacket {
  if (mode === 'full') return packet;
  const keepCoverLetter = review.cover_letter_supported === true;
  const withCoverLetter = keepCoverLetter
    ? packet
    : { ...packet, coverLetter: undefined, coverLetterName: undefined };
  return review.transcript_supported === true
    ? withCoverLetter
    : {
      ...withCoverLetter,
      transcript: undefined,
      transcriptName: undefined,
      transcriptUnavailableReason: undefined,
    };
}

export function createEmployerDeliveryBindings(
  packet: SubmissionPacket,
  review: Pick<ApplicationReviewState, 'cover_letter_supported' | 'transcript_supported'>,
  selection: {
    mode: EmployerPacketDeliveryMode;
    envelope: EmployerDeliveryEnvelope;
  } | {
    mode: 'extension';
    envelope: EmployerDeliveryEnvelope;
    extensionProjection: Record<string, unknown>;
  },
): EmployerDeliveryBindings {
  const sha256 = selection.mode === 'extension'
    ? packetAuditSha256({
      version: EMPLOYER_DELIVERY_BINDING_VERSION,
      extension: selection.extensionProjection,
      envelope: selection.envelope,
    })
    : employerDeliverySha256(
      packetForEmployerDelivery(packet, review, selection.mode),
      selection.envelope,
    );
  return {
    version: EMPLOYER_DELIVERY_BINDING_VERSION,
    mode: selection.mode,
    sha256,
  };
}

export function employerDeliveryBindingIssue(
  packet: SubmissionPacket,
  bindings: EmployerDeliveryBindings | undefined,
  mode: EmployerPacketDeliveryMode,
  envelope: EmployerDeliveryEnvelope,
): string | null {
  if (!bindings || bindings.version !== EMPLOYER_DELIVERY_BINDING_VERSION) {
    return 'the approved packet has no current employer-delivery binding';
  }
  if (bindings.mode !== mode) return `the approved ${bindings.mode} channel cannot authorize ${mode}`;
  return employerDeliverySha256(packet, envelope) === bindings.sha256
    ? null
    : `${mode} employer-delivery payload changed after packet approval`;
}

export async function transportBoundEmployerPacket<T>(
  packet: SubmissionPacket,
  bindings: EmployerDeliveryBindings | undefined,
  mode: EmployerPacketDeliveryMode,
  envelope: EmployerDeliveryEnvelope,
  transport: (exactPacket: SubmissionPacket) => Promise<T>,
): Promise<T> {
  const issue = employerDeliveryBindingIssue(packet, bindings, mode, envelope);
  if (issue) throw new Error(issue);
  return transport(packet);
}

export function extensionEmployerDeliveryProjection(input: {
  resume: Buffer;
  fileName: string;
  spec: unknown;
  applicationSpec: unknown;
  applicantSnapshot: unknown;
}): Record<string, unknown> {
  return {
    resume: fileProjection(input.resume),
    fileName: input.fileName,
    spec: input.spec,
    applicationSpec: input.applicationSpec,
    applicantSnapshot: input.applicantSnapshot,
  };
}

export function extensionBoundApplicationSpec(spec: unknown): unknown {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const source = spec as Record<string, unknown>;
  const rawReview = source._review;
  if (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview)) return spec;
  const {
    packet_audit: _packetAudit,
    packet_audit_acknowledgement: _packetAuditAcknowledgement,
    employer_delivery_bindings: _employerDeliveryBindings,
    managed_form_snapshot: _managedFormSnapshot,
    ...review
  } = rawReview as Record<string, unknown>;
  return { ...source, _review: review };
}

export function extensionEmployerDeliveryBindingIssue(
  projection: Record<string, unknown>,
  bindings: EmployerDeliveryBindings | undefined,
  envelope: EmployerDeliveryEnvelope,
): string | null {
  if (!bindings || bindings.version !== EMPLOYER_DELIVERY_BINDING_VERSION) {
    return 'the approved packet has no current employer-delivery binding';
  }
  if (bindings.mode !== 'extension') return `the approved ${bindings.mode} channel cannot authorize extension`;
  const current = packetAuditSha256({
    version: EMPLOYER_DELIVERY_BINDING_VERSION,
    extension: projection,
    envelope,
  });
  return current === bindings.sha256
    ? null
    : 'extension employer-delivery payload changed after packet approval';
}
