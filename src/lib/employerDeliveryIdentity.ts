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
    //
    // Nonempty inventories bind by OPTION CONTENT, not by map key. The keys are live-page
    // addressing: on Ashby the name-attribute prefix embeds a per-page-load instance UUID
    // (run 1 "name:03af8549-...._a05e892e...", run 2 "name:36604d41-...._a05e892e..." for the
    // same control; built by controlNameOptionKeyFromDiscoveredSelector), so binding the keys
    // makes every prepare of such a packet read as "how Litos reaches this employer changed",
    // forever. The employer content is the option lists themselves, so the hash binds a
    // deterministic multiset of them: each list kept in its original order (option order is
    // employer content), the collection sorted by serialized form, duplicates preserved. Any
    // change to a list's content or to the number of controls still changes the hash; the same
    // lists under renamed keys do not. The snapshot keeps the full map; only the hash
    // projection narrows.
    if (key === 'fieldOptions' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const optionLists = Object.values(value as Record<string, string[]>);
      if (optionLists.length === 0) continue;
      projection[key] = optionLists
        .map((options) => ({ options, sortKey: JSON.stringify(options) }))
        .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0))
        .map((entry) => entry.options);
      continue;
    }
    // failedFields entries carry live-page composition detail alongside the durable control id:
    // selector is a per-page-load [data-litos-discovered-N] marker that renumbers on every load,
    // inputType flaps between text and combobox while a react-select mounts, and label is composed
    // from the live DOM. Binding those bytes makes every prepare of a packet with a nonempty
    // failed-fields set read as "how Litos reaches this employer changed", forever. Only the SET of
    // failed controls is employer-delivery behavior, so the hash binds the sorted, deduplicated
    // controlId list (empty stays omitted, matching the absent case above). The snapshot itself
    // keeps the full entries; only the hash projection narrows.
    if (key === 'failedFields' && Array.isArray(value)) {
      if (value.length === 0) continue;
      projection[key] = [...new Set(
        (value as NonNullable<SubmissionPacket['failedFields']>).map((field) => field.controlId),
      )].sort();
      continue;
    }
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
