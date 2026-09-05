import { createHash } from 'node:crypto';
import { eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  application_artifacts,
  application_email_messages,
  application_submission_attempt_events,
  application_submission_events,
  applications,
  artifact_versions,
  artifacts,
  generated_resumes,
} from '../db/schema';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
import {
  buildCanonicalFreeVersionedDocumentBinding,
  CANONICAL_FREE_BASE_RESUME_BINDING_PREFIX,
  CANONICAL_FREE_DOCUMENT_BINDING_PREFIX,
  CANONICAL_FREE_NONE_BINDING,
  parseCanonicalFreeVersionedDocumentBinding,
} from './canonicalFreeDocumentBinding';
import { immutableDocumentContentHash } from './immutableDocumentHash';
import { packetAuditIsSubmissionReady } from './packetAudit';
import { bindingPdfIdentity } from './pdfGenerationBinding';
import {
  CONTROLLED_RECEIPT_TEXT,
  exactControlledTestReceiptRoute,
} from './controlledTestPortal';
import {
  genericKnownPosting,
  greenhousePostingFromUrl,
} from './atsSubmissionChannels';
import {
  canonicalApplicationMatchesFrozenPosting,
  frozenPostingIdentitiesMatch,
} from './canonicalPacketBinding';
import {
  confirmedOrphanAttributionForParent,
  confirmedWeakPostingIdentityOpening,
  freezePostingIdentity,
  frozenPostingIdentityFromEvent,
  lockSubmissionAttemptUser,
  submissionAttemptRetrySafety,
  submissionAttemptRetrySafetyForPacketEvents,
  type SubmissionAttemptRetrySafety,
  type SubmissionAttemptEventRecord,
  type SubmissionAttemptSource,
} from './submissionAttemptLedger';
import {
  readSubmissionAuthorityRevision,
  SUBMISSION_AUTHORITY_SCHEMA_VERSION,
  type SubmissionAuthorityLockMode,
  type SubmissionAuthorityRevision,
} from './submissionAuthorityRevision';
import { unsupportedEmailConfirmationEvidenceMatches } from './unsupportedEmailReceipt';

export const AUTHORITATIVE_SUBMISSION_REPAIR_REASONS = [
  'ambiguous_confirmation',
  'canonical_projection_incomplete',
  'document_tuple_incomplete',
  'invalid_attempt_sequence',
  'mutable_sent_without_confirmation',
  'packet_missing',
  'packet_projection_incomplete',
  'posting_mismatch',
  'receipt_binding_mismatch',
  'receipt_incomplete',
  'receipt_missing',
  'selected_flags_incoherent',
] as const;

export type AuthoritativeSubmissionRepairReason =
  typeof AUTHORITATIVE_SUBMISSION_REPAIR_REASONS[number];

export type AuthoritativeSubmissionReceipt = {
  confirmationText: string;
  finalUrl: string;
  capturedAt: string;
  source?: string;
};

export type AuthoritativeSubmissionProjection =
  | {
    state: 'confirmed';
    attemptId: string;
    canonicalApplicationId: string;
    packetId: string | null;
    submittedAt: string;
    receipt: AuthoritativeSubmissionReceipt;
    source: string;
    trackerStage: string;
  }
  | {
    state: 'unverified';
    attemptId: string;
    observedAt: string;
    reason: 'opened' | 'boundary_authorized' | 'pressed' | 'invalid_sequence';
  }
  | {
    state: 'repair_required';
    attemptId?: string;
    canonicalApplicationId?: string;
    packetId?: string | null;
    reasons: AuthoritativeSubmissionRepairReason[];
  }
  | { state: 'none' };

export type AuthoritativeSubmissionProjectionResult = {
  schemaVersion: typeof SUBMISSION_AUTHORITY_SCHEMA_VERSION;
  revision: SubmissionAuthorityRevision;
  byPacketId: Map<string, AuthoritativeSubmissionProjection>;
  byApplicationId: Map<string, AuthoritativeSubmissionProjection>;
  retrySafetyByPacketId: Map<string, SubmissionAttemptRetrySafety>;
  retrySafetyByApplicationId: Map<string, SubmissionAttemptRetrySafety>;
  /** Only when the caller asked to explain: each document-tuple check that failed, as
   * `<attemptId>:<check>`. The reasons above stay exactly as they were. */
  explanations?: string[];
};

export function authoritativeConfirmedProjectionMatches(
  projection: AuthoritativeSubmissionProjection | undefined,
  binding: {
    attemptId: string;
    canonicalApplicationId: string;
    packetId: string | null;
  },
): projection is Extract<AuthoritativeSubmissionProjection, { state: 'confirmed' }> {
  return projection?.state === 'confirmed'
    && projection.attemptId === binding.attemptId
    && projection.canonicalApplicationId === binding.canonicalApplicationId
    && projection.packetId === binding.packetId;
}

type ProjectionExecutor = Pick<typeof db, 'execute' | 'select'>;
type ApplicationRow = typeof applications.$inferSelect;
type PacketRow = typeof generated_resumes.$inferSelect;
type ArtifactRow = typeof artifacts.$inferSelect;
type ArtifactVersionRow = typeof artifact_versions.$inferSelect;
type LinkRow = typeof application_artifacts.$inferSelect;
type CanonicalReceiptRow = typeof application_submission_events.$inferSelect;
type EmployerEmailMessageRow = typeof application_email_messages.$inferSelect;

export type AuthoritativeSubmissionProjectionSnapshot = {
  applications: ApplicationRow[];
  /** Live ids referenced by this user's openings but owned by another account. */
  foreignLiveApplicationIds?: string[];
  packets: PacketRow[];
  attempts: SubmissionAttemptEventRecord[];
  canonicalReceipts: CanonicalReceiptRow[];
  /** Employer messages are needed only to verify content-bound email confirmation facts. */
  emailMessages?: EmployerEmailMessageRow[];
  artifacts: ArtifactRow[];
  artifactVersions: ArtifactVersionRow[];
  links: LinkRow[];
};

type AttemptProjection = {
  attemptId: string;
  events: SubmissionAttemptEventRecord[];
  openings: SubmissionAttemptEventRecord[];
  confirmations: SubmissionAttemptEventRecord[];
  opening: SubmissionAttemptEventRecord | null;
  confirmation: SubmissionAttemptEventRecord | null;
  application: ApplicationRow | null;
  applicationAmbiguous: boolean;
  applicationCandidateIds: string[];
  packet: PacketRow | null;
};

type ClassifierContext = {
  snapshot: AuthoritativeSubmissionProjectionSnapshot;
  applicationsById: Map<string, ApplicationRow>;
  foreignLiveApplicationIds: Set<string>;
  packetsById: Map<string, PacketRow>;
  artifactsById: Map<string, ArtifactRow>;
  artifactVersionsByArtifactId: Map<string, ArtifactVersionRow[]>;
  linksByApplicationId: Map<string, LinkRow[]>;
  attempts: AttemptProjection[];
  /** Present only when a caller asked the classifier to explain itself; checks that fail are
   * appended here as `<attemptId>:<check>`. Never read by any classification. */
  explain?: string[];
};

const TERMINAL_TRACKER_STAGES = new Set(['applied', 'interview', 'offer', 'closed']);
const TERMINAL_PACKET_PIPELINE_STAGES = new Set(['applied', 'interview', 'offer', 'closed']);
const APPLICANT_CONFIRMED_RECEIPT_TEXT =
  'Applicant confirmed the application in the employer portal.';
const ORPHAN_APPLICANT_CONFIRMED_RECEIPT_TEXT =
  'Confirmed by you: this application appears in the employer portal or confirmation email.';
const APPLICANT_FOUND_PACKET_RECEIPT_AFTER_PRESS_TEXT =
  'Confirmed by you: you found this application in the employer’s portal after Litos pressed Send and lost the answer.';
const APPLICANT_FOUND_PACKET_RECEIPT_WITHOUT_PRESS_TEXT =
  'Confirmed by you: you found this application in the employer’s portal after its submission attempt stopped without a durable result.';
const APPLICANT_FOUND_PACKET_RECEIPT_TEXTS = new Set([
  APPLICANT_FOUND_PACKET_RECEIPT_AFTER_PRESS_TEXT,
  APPLICANT_FOUND_PACKET_RECEIPT_WITHOUT_PRESS_TEXT,
]);

export function applicantFoundSubmissionReceiptText(hasPress: boolean): string {
  return hasPress
    ? APPLICANT_FOUND_PACKET_RECEIPT_AFTER_PRESS_TEXT
    : APPLICANT_FOUND_PACKET_RECEIPT_WITHOUT_PRESS_TEXT;
}
const SELF_SUBMITTED_RECEIPT_TEXT =
  'Confirmed by you: this employer asked for a document Litos could not attach, so you sent this application yourself.';

export function selfSubmittedSubmissionReceiptText(): string {
  return SELF_SUBMITTED_RECEIPT_TEXT;
}
const EXACT_WORKABLE_RECEIPT_TEXT = 'Your application has been submitted successfully.';
/* Breezy's own success view, as the managed runner reads it off the page: the "Application Submitted"
 * heading over "Your application has been submitted successfully. Good luck!" (both strings are
 * Breezy's, from its portal translate bundle). Measured on Bear Robotics b822b998, 2026-09-05T01:50:46Z. */
const EXACT_BREEZY_RECEIPT_TEXT = 'Application Submitted Your application has been submitted successfully. Good luck!';
const CANONICAL_FREE_ARTIFACT_PREFIX = `${CANONICAL_FREE_DOCUMENT_BINDING_PREFIX}artifact:`;
const EMPLOYER_EMAIL_CONFIRMATION_EVIDENCE_PREFIX = 'employer_email_confirmation_v1:';

export type EmployerEmailConfirmationEvidenceInput = {
  attemptId: string;
  userId: string;
  packetId: string;
  messageId: string;
  alias: string;
  confirmationText: string;
  finalUrl: string;
  receivedAt: Date | string;
};

/** Bind one immutable confirmation fact to the exact stored employer message and receipt. */
export function employerEmailConfirmationEvidenceCode(
  input: EmployerEmailConfirmationEvidenceInput,
): string {
  const receivedAt = input.receivedAt instanceof Date
    ? input.receivedAt.toISOString()
    : new Date(input.receivedAt).toISOString();
  const sha256 = createHash('sha256').update(JSON.stringify([
    input.attemptId,
    input.userId,
    input.packetId,
    input.messageId,
    input.alias.trim().toLowerCase(),
    input.confirmationText,
    input.finalUrl,
    receivedAt,
  ])).digest('hex');
  return `${EMPLOYER_EMAIL_CONFIRMATION_EVIDENCE_PREFIX}${sha256}`;
}

function isEmployerEmailConfirmationEvidenceCode(value: string | null): boolean {
  return typeof value === 'string'
    && /^employer_email_confirmation_v1:[a-f0-9]{64}$/u.test(value);
}

const RECEIPT_SOURCES_BY_ATTEMPT_SOURCE: Partial<Record<SubmissionAttemptSource, readonly string[]>> = {
  managed_browser: ['managed_browser'],
  direct_browser: ['managed_browser'],
  chrome_extension: ['chrome_extension'],
  unsupported_email: ['email_fallback'],
  ats_api: ['ats_api'],
  attended_handoff: ['attended_handoff'],
  legacy_backfill: [
    'managed_browser',
    'chrome_extension',
    'ats_api',
    'attended_handoff',
  ],
};

function uniqueStrings(values: readonly string[] | undefined): string[] {
  return [...new Set(values ?? [])];
}

export function sortedAuthoritativeSubmissionRepairReasons(
  reasons: Iterable<AuthoritativeSubmissionRepairReason>,
): AuthoritativeSubmissionRepairReason[] {
  return [...new Set(reasons)].sort();
}

function safeHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password;
  } catch {
    return false;
  }
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function eventBindingSignature(event: SubmissionAttemptEventRecord): string {
  return JSON.stringify([
    event.user_id,
    event.attempt_id,
    event.application_id,
    event.packet_id,
    event.parent_attempt_id,
    event.source,
    event.operation,
    event.submission_run_id,
    event.submission_claim_id,
    event.packet_version,
    event.posting_key,
    event.job_id,
    event.company_role,
    event.company_name,
    event.role,
    event.portal_url,
    event.portal_identity,
  ]);
}

function eventOrder(left: SubmissionAttemptEventRecord, right: SubmissionAttemptEventRecord): number {
  return left.created_at.getTime() - right.created_at.getTime()
    || left.observed_at.getTime() - right.observed_at.getTime()
    || left.id.localeCompare(right.id);
}

function exactOrphanAttributionSequence(
  attempt: AttemptProjection,
  allEvents: readonly SubmissionAttemptEventRecord[],
): boolean {
  const opening = attempt.opening;
  if (!opening?.parent_attempt_id
    || attempt.openings.length !== 1
    || attempt.confirmations.length < 1
    || attempt.events.length !== 1 + attempt.confirmations.length
    || opening.source !== 'attended_handoff'
    || opening.operation !== 'initial_submission'
    || opening.evidence_code !== 'applicant_attributed_orphan_opening'
    || attempt.confirmation?.evidence_code !== 'applicant_attributed_orphan_confirmation'
    || attempt.events.some((event) => eventBindingSignature(event) !== eventBindingSignature(opening)
      || event.proof_kind !== null
      || event.boundary_activation_id !== null
      || event.boundary_expires_at !== null)
    || attempt.confirmations.some((event) =>
      event.evidence_code !== 'applicant_attributed_orphan_confirmation'
      || event.created_at.getTime() < opening.created_at.getTime()
      || event.observed_at.getTime() < opening.observed_at.getTime())) return false;

  const parentEvents = allEvents.filter((event) => event.attempt_id === opening.parent_attempt_id);
  if (!confirmedWeakPostingIdentityOpening(parentEvents)) return false;

  // The ledger helper deliberately admits exactly one child confirmation. Repeated delivery of the
  // same coherent child fact is also safe, so reduce only those duplicate confirmations to the
  // deterministic earliest event before asking the shared helper to validate the full lineage.
  const chosen = [...attempt.confirmations].sort((left, right) =>
    left.observed_at.getTime() - right.observed_at.getTime()
      || left.created_at.getTime() - right.created_at.getTime()
      || left.id.localeCompare(right.id))[0]!;
  const attribution = confirmedOrphanAttributionForParent([
    ...allEvents.filter((event) => event.attempt_id !== opening.attempt_id),
    opening,
    chosen,
  ], opening.parent_attempt_id);
  return attribution?.attemptId === opening.attempt_id;
}

const EXTENSION_OVERRIDDEN_NOT_SENT_EVIDENCE = new Set([
  'applicant_checked_not_sent',
  'authorization_changed_before_external_boundary',
  'new_duplicate_evidence_before_external_boundary',
  'extension_cancelled_before_press',
]);

function attendedHandoffCapabilityKind(
  opening: SubmissionAttemptEventRecord,
): 'manual_handoff' | 'self_submit' | null {
  if (opening.source !== 'attended_handoff' || opening.operation !== 'manual_submission') return null;
  if (opening.evidence_code === 'manual_employer_boundary_reserved_before_exposure') {
    return 'manual_handoff';
  }
  const match = opening.evidence_code?.match(
    /^attended_handoff_capability_v1:(manual_handoff|self_submit):[a-f0-9]{64}:[a-f0-9]{64}$/u,
  );
  return match?.[1] === 'manual_handoff' || match?.[1] === 'self_submit' ? match[1] : null;
}

function ordinaryOpeningEvidenceIsExact(opening: SubmissionAttemptEventRecord): boolean {
  if (opening.source === 'managed_browser' || opening.source === 'direct_browser') {
    return opening.evidence_code === (opening.operation === 'security_code_continuation'
      ? 'atomic_security_code_claim_reserved'
      : 'atomic_claim_reserved');
  }
  if (opening.source === 'chrome_extension') {
    return opening.operation === 'initial_submission'
      ? opening.evidence_code === 'atomic_extension_claim_reserved'
      : opening.operation === 'manual_submission'
        && opening.evidence_code === 'canonical_manual_submit_reserved';
  }
  if (opening.source === 'attended_handoff') {
    return attendedHandoffCapabilityKind(opening) !== null;
  }
  if (opening.source === 'unsupported_email') {
    return opening.operation === 'initial_submission'
      && opening.evidence_code === 'atomic_email_claim_reserved';
  }
  return false;
}

function ordinaryBoundaryEvidenceIsExact(
  opening: SubmissionAttemptEventRecord,
  boundary: SubmissionAttemptEventRecord,
): boolean {
  const expected = opening.operation === 'manual_submission' && opening.source === 'chrome_extension'
    ? 'canonical_manual_boundary_authorized'
    : `${opening.source}_employer_boundary_authorized`;
  return boundary.evidence_code === expected
    && Boolean(boundary.boundary_activation_id)
    && Boolean(boundary.boundary_expires_at)
    && boundary.proof_kind === null;
}

function ordinaryPressEvidenceIsExact(
  opening: SubmissionAttemptEventRecord,
  press: SubmissionAttemptEventRecord,
): boolean {
  if (opening.source === 'managed_browser') {
    return opening.operation === 'security_code_continuation'
      ? press.evidence_code === 'stratus_verification_press_echoed'
        || press.evidence_code === 'stratus_verification_press_progress'
      : press.evidence_code === 'stratus_application_press_echoed'
        || press.evidence_code === 'stratus_application_press_progress'
        || press.evidence_code === 'stratus_verification_press_echoed'
        || press.evidence_code === 'stratus_verification_press_progress';
  }
  if (opening.source === 'direct_browser') {
    return press.evidence_code === 'direct_submit_returned'
      || press.evidence_code === 'controlled_submit_returned';
  }
  if (opening.source === 'chrome_extension') {
    return opening.operation === 'manual_submission'
      ? press.evidence_code === 'canonical_manual_submit_pressed'
      : press.evidence_code === 'extension_submit_may_have_been_pressed';
  }
  if (opening.source === 'unsupported_email') {
    return opening.operation === 'initial_submission'
      && press.evidence_code === 'unsupported_email_dispatch_started';
  }
  return opening.source === 'attended_handoff'
    && press.evidence_code === 'applicant_attended_submission';
}

function directBrowserPressReceiptPairIsExact(
  presses: readonly SubmissionAttemptEventRecord[],
  providerConfirmationCodes: ReadonlySet<string | null>,
): boolean {
  if (providerConfirmationCodes.size !== 1) return false;
  const confirmationCode = [...providerConfirmationCodes][0];
  const expectedPressCode = confirmationCode === 'controlled_receipt_verified'
    ? 'controlled_submit_returned'
    : confirmationCode === 'managed_application_receipt'
      ? 'direct_submit_returned'
      : null;
  return expectedPressCode !== null
    && presses.length > 0
    && presses.every((event) => event.evidence_code === expectedPressCode);
}

function extensionOverriddenNotSentIsExact(
  opening: SubmissionAttemptEventRecord,
  notSent: readonly SubmissionAttemptEventRecord[],
  boundaryAt: number,
): boolean {
  if (opening.source !== 'chrome_extension'
    || opening.operation !== 'initial_submission'
    || notSent.length !== 1) return false;
  const negative = notSent[0]!;
  const exactProof = negative.proof_kind === 'applicant_checked_not_sent'
    ? negative.evidence_code === 'applicant_checked_not_sent'
    : negative.proof_kind === 'typed_pre_click_stop'
      ? EXTENSION_OVERRIDDEN_NOT_SENT_EVIDENCE.has(negative.evidence_code ?? '')
      : negative.proof_kind === 'extension_cancelled_before_press'
        && negative.evidence_code === 'extension_cancelled_before_press';
  return exactProof
    && negative.observed_at.getTime() >= opening.observed_at.getTime()
    && negative.observed_at.getTime() <= boundaryAt;
}

function applicantAttestationEvidenceIsExact(event: SubmissionAttemptEventRecord): boolean {
  return event.evidence_code === 'applicant_found_submission'
    || event.evidence_code === 'applicant_found_orphan_autofill_submission';
}

function isApplicantAttestationEvidenceCode(code: string | null): boolean {
  return code === 'applicant_found_submission'
    || code === 'applicant_found_orphan_autofill_submission';
}

function applicantRepairOpeningEvidenceIsExact(opening: SubmissionAttemptEventRecord): boolean {
  if (opening.source === 'legacy_backfill') {
    return opening.evidence_code === 'legacy_unverified_resolution_bridge'
      || opening.evidence_code === 'legacy_autofill_auto_submit_report'
      || opening.evidence_code === 'legacy_current_unresolved_risk'
      || opening.evidence_code === 'legacy_current_confirmation'
      || opening.evidence_code === 'legacy_current_submitted'
      || opening.evidence_code === 'legacy_current_receipt';
  }
  if (opening.source === 'chrome_extension'
    && opening.evidence_code === 'autofill_auto_submit_report') return true;
  return ordinaryOpeningEvidenceIsExact(opening);
}

function exactApplicantAttestationSequence(attempt: AttemptProjection): boolean {
  const opening = attempt.opening;
  if (!opening
    || opening.parent_attempt_id !== null
    || attempt.openings.length !== 1
    || attempt.confirmations.length === 0
    || attempt.confirmations.some((event) => !applicantAttestationEvidenceIsExact(event))
    || attempt.events.some((event) => ![
      'attempt_opened',
      'boundary_authorized',
      'press_observed',
      'submission_confirmed',
      'not_sent_proven',
    ].includes(event.event_kind))) return false;
  const canonicalManual = opening.packet_id === opening.application_id
    && opening.application_id !== null
    && opening.operation === 'manual_submission'
    && (opening.source === 'chrome_extension' || opening.source === 'legacy_backfill');
  const generatedRepair = opening.packet_id !== opening.application_id
    && (opening.operation === 'initial_submission'
      || (opening.operation === 'security_code_continuation'
        && (opening.source === 'managed_browser' || opening.source === 'direct_browser')))
    && [
      'managed_browser',
      'direct_browser',
      'chrome_extension',
      'attended_handoff',
      'legacy_backfill',
      'unsupported_email',
    ].includes(opening.source);
  if ((!canonicalManual && !generatedRepair) || !applicantRepairOpeningEvidenceIsExact(opening)) {
    return false;
  }
  const boundaries = attempt.events.filter((event) => event.event_kind === 'boundary_authorized');
  const presses = attempt.events.filter((event) => event.event_kind === 'press_observed');
  const notSent = attempt.events.filter((event) => event.event_kind === 'not_sent_proven');
  if (boundaries.length > 1
    || notSent.length > 1
    || attempt.events.some((event) => event.event_kind === 'boundary_authorized'
      ? !event.boundary_activation_id || !event.boundary_expires_at || event.proof_kind !== null
      : event.boundary_activation_id !== null || event.boundary_expires_at !== null)
    || attempt.events.some((event) => event.event_kind === 'not_sent_proven'
      ? !event.proof_kind || !event.evidence_code
      : event.proof_kind !== null)
    || (opening.source === 'legacy_backfill'
      ? boundaries.length > 0
        || presses.some((event) => !/^legacy_.*(?:press|click|evidence)$/u.test(event.evidence_code ?? ''))
      : boundaries.some((event) => !ordinaryBoundaryEvidenceIsExact(opening, event))
        || presses.some((event) => !ordinaryPressEvidenceIsExact(opening, event)))
    || notSent.some((event) => event.proof_kind === 'applicant_checked_not_sent'
      ? event.evidence_code !== 'applicant_checked_not_sent'
      : event.proof_kind === 'typed_pre_click_stop'
        ? !EXTENSION_OVERRIDDEN_NOT_SENT_EVIDENCE.has(event.evidence_code ?? '')
        : event.proof_kind !== 'extension_cancelled_before_press'
          || event.evidence_code !== 'extension_cancelled_before_press')) return false;
  if (opening.source === 'unsupported_email'
    && (boundaries.length !== 1 || presses.length !== 1 || notSent.length !== 0)) return false;
  if (opening.operation === 'security_code_continuation'
    && (boundaries.length !== 1 || presses.length === 0)) return false;
  if (opening.source === 'attended_handoff'
    && opening.evidence_code?.startsWith('attended_handoff_capability_v1:') === true
    && boundaries.length !== 1) return false;
  const confirmationAt = Math.min(...attempt.confirmations.map((event) =>
    event.observed_at.getTime()));
  return attempt.events
    .filter((event) => event.event_kind !== 'submission_confirmed')
    .every((event) => event.observed_at.getTime() <= confirmationAt);
}

function exactAttemptSequence(
  attempt: AttemptProjection,
  allEvents: readonly SubmissionAttemptEventRecord[],
): boolean {
  const opening = attempt.opening;
  if (!opening || attempt.openings.length !== 1 || attempt.confirmations.length === 0) return false;
  if (opening.parent_attempt_id !== null) {
    return exactOrphanAttributionSequence(attempt, allEvents);
  }
  const signature = eventBindingSignature(opening);
  const structurallyExact = attempt.events.every((event) => eventBindingSignature(event) === signature)
    && attempt.events.every((event) => event.created_at.getTime() >= opening.created_at.getTime())
    && attempt.confirmations.every((event) => event.observed_at.getTime() >= opening.observed_at.getTime());
  if (!structurallyExact) return false;
  const confirmationCodes = new Set(attempt.confirmations.map((event) => event.evidence_code));
  if (confirmationCodes.size === 1
    && [...confirmationCodes].every((code) => code !== null
      && isApplicantAttestationEvidenceCode(code))) {
    return exactApplicantAttestationSequence(attempt);
  }
  const hasApplicantUpgrade = confirmationCodes.has('applicant_found_submission');
  const providerConfirmationCodes = new Set([...confirmationCodes]
    .filter((code) => !isApplicantAttestationEvidenceCode(code)));
  if (confirmationCodes.has('applicant_found_orphan_autofill_submission')
    || providerConfirmationCodes.size !== 1) return false;
  const firstProviderConfirmationAt = Math.min(...attempt.confirmations
    .filter((event) => !isApplicantAttestationEvidenceCode(event.evidence_code))
    .map((event) => event.observed_at.getTime()));
  if (hasApplicantUpgrade && attempt.confirmations.some((event) =>
    event.evidence_code === 'applicant_found_submission'
    && event.observed_at.getTime() > firstProviderConfirmationAt)) return false;
  const boundaries = attempt.events.filter((event) => event.event_kind === 'boundary_authorized');
  const presses = attempt.events.filter((event) => event.event_kind === 'press_observed');
  const notSent = attempt.events.filter((event) => event.event_kind === 'not_sent_proven');
  if (boundaries.length > 1
    || attempt.events.some((event) => ![
      'attempt_opened',
      'boundary_authorized',
      'press_observed',
      'submission_confirmed',
      'not_sent_proven',
    ].includes(event.event_kind))
    || attempt.events.some((event) => event.event_kind === 'boundary_authorized'
      ? !event.boundary_activation_id || !event.boundary_expires_at
      : event.boundary_activation_id !== null || event.boundary_expires_at !== null)
    || attempt.events.some((event) => event.event_kind === 'not_sent_proven'
      ? !event.proof_kind
      : event.proof_kind !== null)) return false;
  const hasBoundary = boundaries.length === 1;
  const hasPress = presses.length > 0;
  if (opening.source === 'legacy_backfill') {
    const allowedLegacyEvents = attempt.events.every((event) => [
      'attempt_opened',
      'press_observed',
      'submission_confirmed',
    ].includes(event.event_kind));
    const orderedLegacy = attempt.events
      .filter((event) => event.event_kind !== 'attempt_opened')
      .every((event) => event.observed_at.getTime() >= opening.observed_at.getTime())
      && (!hasPress || attempt.confirmations.every((confirmation) =>
        confirmation.observed_at.getTime() >= Math.max(...presses.map((event) =>
          event.observed_at.getTime()))));
    return notSent.length === 0
      && allowedLegacyEvents
      && orderedLegacy
      && (opening.operation === 'initial_submission' || opening.operation === 'manual_submission')
      && /^legacy_/u.test(opening.evidence_code ?? '')
      && presses.every((event) => /^legacy_.*(?:press|click|evidence)$/u.test(event.evidence_code ?? ''))
      && !hasApplicantUpgrade
      && [...providerConfirmationCodes].every((code) => typeof code === 'string'
        && /^legacy_.*(?:confirmation|confirmed|receipt)$/i.test(code));
  }
  const exactEmployerEmail = attempt.confirmations.length === 1
    && isEmployerEmailConfirmationEvidenceCode(attempt.confirmations[0]!.evidence_code);
  if (exactEmployerEmail) {
    if (!ordinaryOpeningEvidenceIsExact(opening)
      || !hasBoundary
      || boundaries.some((event) => !ordinaryBoundaryEvidenceIsExact(opening, event))
      || presses.some((event) => !ordinaryPressEvidenceIsExact(opening, event))
      || notSent.length > 0) return false;
    const openingAt = opening.observed_at.getTime();
    const boundaryAt = boundaries[0]!.observed_at.getTime();
    const confirmationAt = attempt.confirmations[0]!.observed_at.getTime();
    return boundaryAt >= openingAt
      && confirmationAt >= boundaryAt
      && presses.every((event) => event.observed_at.getTime() >= boundaryAt
        && event.observed_at.getTime() <= confirmationAt);
  }
  const exactRetainedAttendedReceipt = attempt.confirmations.length === 1
    && attempt.confirmations[0]!.evidence_code === 'attended_receipt_confirmed'
    && (opening.source === 'managed_browser' || opening.source === 'direct_browser');
  if (exactRetainedAttendedReceipt) {
    if (!ordinaryOpeningEvidenceIsExact(opening)
      || opening.operation !== 'initial_submission'
      || !hasBoundary
      || boundaries.some((event) => !ordinaryBoundaryEvidenceIsExact(opening, event))
      || presses.some((event) => !ordinaryPressEvidenceIsExact(opening, event))
      || notSent.length > 0) return false;
    const openingAt = opening.observed_at.getTime();
    const boundaryAt = boundaries[0]!.observed_at.getTime();
    const confirmationAt = attempt.confirmations[0]!.observed_at.getTime();
    return boundaryAt >= openingAt
      && confirmationAt >= boundaryAt
      && presses.every((event) => event.observed_at.getTime() >= boundaryAt
        && event.observed_at.getTime() <= confirmationAt);
  }
  if (confirmationCodes.has('applicant_attributed_orphan_confirmation')) return false;
  if (!ordinaryOpeningEvidenceIsExact(opening)) return false;
  const capabilityKind = attendedHandoffCapabilityKind(opening);
  const boundaryRequired = opening.source !== 'attended_handoff'
    || opening.evidence_code?.startsWith('attended_handoff_capability_v1:') === true;
  if ((boundaryRequired && !hasBoundary)
    || boundaries.some((event) => !ordinaryBoundaryEvidenceIsExact(opening, event))
    || !hasPress
    || presses.some((event) => !ordinaryPressEvidenceIsExact(opening, event))) return false;
  const openingAt = opening.observed_at.getTime();
  const boundaryAt = hasBoundary ? boundaries[0]!.observed_at.getTime() : openingAt;
  const firstPressAt = Math.min(...presses.map((event) => event.observed_at.getTime()));
  const lastPressAt = Math.max(...presses.map((event) => event.observed_at.getTime()));
  const firstConfirmationAt = Math.min(...attempt.confirmations.map((event) =>
    event.observed_at.getTime()));
  if (boundaryAt < openingAt
    || firstPressAt < boundaryAt
    || firstConfirmationAt < lastPressAt
    || (notSent.length > 0
      && !extensionOverriddenNotSentIsExact(opening, notSent, boundaryAt))) return false;
  if (opening.source === 'managed_browser' || opening.source === 'direct_browser') {
    return notSent.length === 0
      && (opening.operation === 'initial_submission'
        || opening.operation === 'security_code_continuation')
      && [...providerConfirmationCodes].every((code) => opening.source === 'direct_browser'
        ? code === 'managed_application_receipt'
          || (opening.operation === 'initial_submission' && code === 'controlled_receipt_verified')
        : opening.operation === 'security_code_continuation'
          ? code === 'managed_security_code_receipt'
          : code === 'managed_application_receipt' || code === 'managed_security_code_receipt')
      && (opening.source !== 'direct_browser'
        || directBrowserPressReceiptPairIsExact(presses, providerConfirmationCodes))
      && (opening.source !== 'managed_browser'
        || opening.operation !== 'initial_submission'
        || !confirmationCodes.has('managed_security_code_receipt')
        || (presses.some((event) => event.evidence_code === 'stratus_application_press_echoed'
          || event.evidence_code === 'stratus_application_press_progress')
          && presses.some((event) => event.evidence_code === 'stratus_verification_press_echoed'
            || event.evidence_code === 'stratus_verification_press_progress')));
  }
  if (opening.source === 'chrome_extension') {
    return ((opening.operation === 'initial_submission'
        && [...providerConfirmationCodes].every((code) => code === 'extension_receipt_verified'))
        || (opening.operation === 'manual_submission'
          && notSent.length === 0
          && [...providerConfirmationCodes].every((code) => code === 'canonical_manual_receipt_confirmed')));
  }
  if (opening.source === 'attended_handoff') {
    return notSent.length === 0
      && capabilityKind !== null
      && [...providerConfirmationCodes].every((code) => code === 'attended_receipt_confirmed');
  }
  if (opening.source === 'unsupported_email') {
    return notSent.length === 0
      && opening.operation === 'initial_submission'
      && [...providerConfirmationCodes].every((code) =>
        typeof code === 'string' && code.startsWith('unsupported_email_provider_accepted:'));
  }
  return false;
}

function linksForApplication(context: ClassifierContext, applicationId: string): LinkRow[] {
  return context.linksByApplicationId.get(applicationId) ?? [];
}

function selectedResumeLinks(context: ClassifierContext, applicationId: string): LinkRow[] {
  return linksForApplication(context, applicationId)
    .filter((link) => link.purpose === 'resume' && link.selected);
}

function immutableApplicationsForPacket(
  context: ClassifierContext,
  packetId: string,
  opening: SubmissionAttemptEventRecord,
): ApplicationRow[] {
  const candidateIds = new Set<string>();
  for (const artifact of context.snapshot.artifacts) {
    if (artifact.user_id !== opening.user_id
      || artifact.deleted_at
      || artifact.legacy_generated_resume_id !== packetId) continue;
    for (const link of context.snapshot.links) {
      if (link.artifact_id === artifact.id && link.purpose === 'resume') {
        candidateIds.add(link.application_id);
      }
    }
  }
  return [...candidateIds]
    .map((id) => context.applicationsById.get(id))
    .filter((candidate): candidate is ApplicationRow => Boolean(candidate))
    .filter((candidate) => canonicalApplicationMatchesFrozenPosting(
      candidate,
      frozenPostingIdentityFromEvent(opening),
    ));
}

function applicationForOpening(
  context: ClassifierContext,
  opening: SubmissionAttemptEventRecord,
): { application: ApplicationRow | null; ambiguous: boolean; candidateIds: string[] } {
  if (opening.application_id) {
    if (context.foreignLiveApplicationIds.has(opening.application_id)) {
      return {
        application: null,
        ambiguous: false,
        candidateIds: [opening.application_id],
      };
    }
    const direct = context.applicationsById.get(opening.application_id);
    if (direct) return { application: direct, ambiguous: false, candidateIds: [direct.id] };
    if (opening.packet_id === opening.application_id) {
      const frozen = frozenPostingIdentityFromEvent(opening);
      const canonicalOnlySurvivors = context.snapshot.applications.filter((candidate) =>
        canonicalApplicationMatchesFrozenPosting(candidate, frozen)
        && canonicalOnlyDocumentReasons(context, opening, candidate).length === 0);
      if (canonicalOnlySurvivors.length === 1) {
        return {
          application: canonicalOnlySurvivors[0]!,
          ambiguous: false,
          candidateIds: [canonicalOnlySurvivors[0]!.id],
        };
      }
      if (canonicalOnlySurvivors.length > 1) {
        return {
          application: null,
          ambiguous: true,
          candidateIds: canonicalOnlySurvivors.map((candidate) => candidate.id),
        };
      }
    }
    const survivors = immutableApplicationsForPacket(context, opening.packet_id, opening);
    return survivors.length === 1
      ? { application: survivors[0]!, ambiguous: false, candidateIds: [survivors[0]!.id] }
      : {
        application: null,
        ambiguous: survivors.length > 1,
        candidateIds: survivors.map((candidate) => candidate.id),
      };
  }
  const candidates = immutableApplicationsForPacket(context, opening.packet_id, opening);
  return candidates.length === 1
    ? { application: candidates[0]!, ambiguous: false, candidateIds: [candidates[0]!.id] }
    : {
      application: null,
      ambiguous: candidates.length > 1,
      candidateIds: candidates.map((candidate) => candidate.id),
    };
}

function makeContext(snapshot: AuthoritativeSubmissionProjectionSnapshot, explain?: string[]): ClassifierContext {
  const applicationsById = new Map(snapshot.applications.map((row) => [row.id, row]));
  const foreignLiveApplicationIds = new Set(snapshot.foreignLiveApplicationIds ?? []);
  const packetsById = new Map(snapshot.packets.map((row) => [row.id, row]));
  const artifactsById = new Map(snapshot.artifacts.map((row) => [row.id, row]));
  const artifactVersionsByArtifactId = new Map<string, ArtifactVersionRow[]>();
  for (const version of snapshot.artifactVersions) {
    const current = artifactVersionsByArtifactId.get(version.artifact_id) ?? [];
    current.push(version);
    artifactVersionsByArtifactId.set(version.artifact_id, current);
  }
  const linksByApplicationId = new Map<string, LinkRow[]>();
  for (const link of snapshot.links) {
    const current = linksByApplicationId.get(link.application_id) ?? [];
    current.push(link);
    linksByApplicationId.set(link.application_id, current);
  }
  const grouped = new Map<string, SubmissionAttemptEventRecord[]>();
  for (const event of snapshot.attempts) {
    const current = grouped.get(event.attempt_id) ?? [];
    current.push(event);
    grouped.set(event.attempt_id, current);
  }
  const base = {
    snapshot,
    applicationsById,
    foreignLiveApplicationIds,
    packetsById,
    artifactsById,
    artifactVersionsByArtifactId,
    linksByApplicationId,
    ...(explain ? { explain } : {}),
  };
  const attempts: AttemptProjection[] = [];
  for (const [attemptId, unsorted] of grouped) {
    const events = [...unsorted].sort(eventOrder);
    const openings = events.filter((event) => event.event_kind === 'attempt_opened');
    const confirmations = events
      .filter((event) => event.event_kind === 'submission_confirmed')
      .sort((left, right) => left.observed_at.getTime() - right.observed_at.getTime()
        || left.event_id.localeCompare(right.event_id));
    const opening = openings[0] ?? null;
    const target = opening
      ? applicationForOpening({ ...base, attempts: [] }, opening)
      : { application: null, ambiguous: false, candidateIds: [] };
    attempts.push({
      attemptId,
      events,
      openings,
      confirmations,
      opening,
      confirmation: confirmations.find((event) => !isApplicantAttestationEvidenceCode(event.evidence_code))
        ?? confirmations[0]
        ?? null,
      application: target.application,
      applicationAmbiguous: target.ambiguous,
      applicationCandidateIds: target.candidateIds,
      packet: opening ? packetsById.get(opening.packet_id) ?? null : null,
    });
  }
  return { ...base, attempts };
}

function attemptMatchesPacket(attempt: AttemptProjection, packetId: string): boolean {
  return attempt.events.some((event) => event.packet_id === packetId);
}

function attemptMatchesApplication(attempt: AttemptProjection, applicationId: string): boolean {
  return attempt.application?.id === applicationId
    || attempt.applicationCandidateIds.includes(applicationId)
    || attempt.events.some((event) => event.application_id === applicationId);
}

function generatedReceiptSourceIsCompatible(
  attemptSource: string,
  receiptSource: string | undefined,
): boolean {
  if (attemptSource === 'legacy_backfill' && !receiptSource) return true;
  if (!receiptSource) return false;
  return (RECEIPT_SOURCES_BY_ATTEMPT_SOURCE[attemptSource as SubmissionAttemptSource] ?? [])
    .includes(receiptSource);
}

function reviewProvesAcceptedInitialSecurityCode(
  opening: SubmissionAttemptEventRecord,
  confirmation: SubmissionAttemptEventRecord,
  review: ApplicationReviewState | null,
): boolean {
  if (opening.source !== 'managed_browser'
    || opening.operation !== 'initial_submission'
    || confirmation.evidence_code !== 'managed_security_code_receipt') return true;
  const securityCode = review?.security_code;
  return Boolean(securityCode?.submit_was_authorized
    && validIso(securityCode.requested_at)
    && Date.parse(securityCode.requested_at) <= confirmation.observed_at.getTime()
    && securityCode.attempts?.some((attempt) => attempt.outcome === 'accepted'
      && validIso(attempt.at)
      && attempt.at === confirmation.observed_at.toISOString()));
}

function receiptUrlMatchesFrozenOpening(
  opening: SubmissionAttemptEventRecord,
  finalUrl: string,
): boolean {
  if (!safeHttpUrl(finalUrl)) return false;
  const frozen = frozenPostingIdentityFromEvent(opening);
  const final = freezePostingIdentity({
    company: opening.company_name,
    role: opening.role,
    job_id: opening.job_id,
  }, finalUrl);
  if (frozen.portalIdentity && final.portalIdentity !== frozen.portalIdentity) return false;
  if (frozen.postingKey && final.postingKey !== frozen.postingKey) return false;
  return true;
}

function exactControlledReceiptMatchesOpening(
  opening: SubmissionAttemptEventRecord,
  confirmation: SubmissionAttemptEventRecord,
  finalUrl: string,
  confirmationText: string,
): boolean {
  return opening.source === 'direct_browser'
    && opening.operation === 'initial_submission'
    && confirmation.evidence_code === 'controlled_receipt_verified'
    && confirmationText === CONTROLLED_RECEIPT_TEXT
    && typeof opening.portal_url === 'string'
    && exactControlledTestReceiptRoute(opening.portal_url, finalUrl);
}

function receiptUrlIsAllowedForConfirmation(
  opening: SubmissionAttemptEventRecord,
  confirmation: SubmissionAttemptEventRecord,
  finalUrl: string,
): boolean {
  return safeHttpUrl(finalUrl)
    || (confirmation.evidence_code === 'controlled_receipt_verified'
      && typeof opening.portal_url === 'string'
      && exactControlledTestReceiptRoute(opening.portal_url, finalUrl));
}

function exactEmployerEmailReceiptMatches(
  context: ClassifierContext,
  attempt: AttemptProjection,
  receipt: NonNullable<ApplicationReviewState['receipt']>,
): boolean {
  const opening = attempt.opening;
  const confirmation = attempt.confirmation;
  if (!opening
    || !confirmation
    || !isEmployerEmailConfirmationEvidenceCode(confirmation.evidence_code)
    || receipt.source !== 'email_fallback'
    || receipt.captured_at !== confirmation.observed_at.toISOString()
    || !receiptUrlMatchesFrozenOpening(opening, receipt.final_url)) return false;
  const matching = (context.snapshot.emailMessages ?? []).filter((message) => {
    const receivedAt = message.received_at ?? message.created_at;
    const confirmationText = message.subject?.trim()
      || `Application confirmation received at ${message.alias}`;
    return message.user_id === opening.user_id
      && message.generated_resume_id === opening.packet_id
      && message.classification === 'submission_confirmation'
      && message.direction !== 'outbound'
      && receivedAt.toISOString() === confirmation.observed_at.toISOString()
      && confirmationText === receipt.confirmation_text
      && confirmation.evidence_code === employerEmailConfirmationEvidenceCode({
        attemptId: opening.attempt_id,
        userId: opening.user_id,
        packetId: opening.packet_id,
        messageId: message.id,
        alias: message.alias,
        confirmationText,
        finalUrl: receipt.final_url,
        receivedAt,
      });
  });
  return matching.length === 1;
}

export function measuredPersistedReceiptMatchesOpening(
  opening: SubmissionAttemptEventRecord,
  confirmation: SubmissionAttemptEventRecord,
  finalUrl: string,
  confirmationText: string,
  referenceId?: string,
): boolean {
  if (confirmation.evidence_code === 'controlled_receipt_verified') {
    return exactControlledReceiptMatchesOpening(opening, confirmation, finalUrl, confirmationText);
  }
  if (!receiptUrlMatchesFrozenOpening(opening, finalUrl)) return false;
  if (opening.source === 'attended_handoff'
    && attendedHandoffCapabilityKind(opening) !== 'manual_handoff') return false;
  const frozenUrl = opening.portal_url;
  if (!frozenUrl) return false;
  if (opening.source === 'unsupported_email') {
    let exactUrl = false;
    try {
      const frozen = new URL(frozenUrl);
      const final = new URL(finalUrl);
      frozen.hash = '';
      final.hash = '';
      exactUrl = frozen.toString() === final.toString();
    } catch {
      exactUrl = false;
    }
    return exactUrl && unsupportedEmailConfirmationEvidenceMatches({
      evidenceCode: confirmation.evidence_code,
      confirmationText,
      referenceId,
    });
  }
  const frozenGreenhouse = greenhousePostingFromUrl(frozenUrl);
  const finalGreenhouse = greenhousePostingFromUrl(finalUrl);
  if (frozenGreenhouse) {
    if (!finalGreenhouse
      || finalGreenhouse.boardToken.toLowerCase() !== frozenGreenhouse.boardToken.toLowerCase()
      || finalGreenhouse.jobId !== frozenGreenhouse.jobId) return false;
    const final = new URL(finalUrl);
    return /\/(?:application_)?confirmation\/?$/i.test(final.pathname);
  }
  /* BREEZY, ON ITS TENANT HOST. Every real Breezy posting lives at <tenant>.breezy.hr/p/<id>-<slug>
   * (the runner's own host rule in lib/portalSubmission.ts), and Breezy answers a submitted form by
   * navigating to .../apply/submitted and rendering its fixed success view. genericKnownPosting
   * below knows only the jobs.breezy.hr aggregate, so a tenant-host receipt fell through this
   * function to false: Bear Robotics b822b998 (2026-09-05T01:50:46Z) had the employer's receipt in
   * hand, its confirmation in the ledger, and a row parked at "projection needs repair" because no
   * rule here could bind the two. Same tenant, same whole posting segment, the submitted route, and
   * Breezy's exact text - the frozen URL may be the bare posting or its /apply form. */
  const frozenBreezy = breezyPostingFromUrl(frozenUrl);
  if (frozenBreezy) {
    const finalBreezy = breezyPostingFromUrl(finalUrl);
    return finalBreezy !== null
      && finalBreezy.tenant === frozenBreezy.tenant
      && finalBreezy.posting === frozenBreezy.posting
      && finalBreezy.route === 'submitted'
      && confirmationText.replace(/\s+/g, ' ').trim() === EXACT_BREEZY_RECEIPT_TEXT;
  }
  // Ashby's generic /application route and mutable success text do not bind a provider result.
  // A future repair may admit Ashby only after its immutable result or content-bound receipt is
  // stored in the attempt event. Until then this function deliberately falls through to false.
  const frozenKnown = genericKnownPosting(frozenUrl);
  const finalKnown = genericKnownPosting(finalUrl);
  if (frozenKnown?.provider === 'workable') {
    const final = new URL(finalUrl);
    return finalKnown?.provider === 'workable'
      && finalKnown.tenant.toLowerCase() === frozenKnown.tenant.toLowerCase()
      && finalKnown.jobId.toLowerCase() === frozenKnown.jobId.toLowerCase()
      && final.search === '?success'
      && confirmationText.replace(/\s+/g, ' ').trim() === EXACT_WORKABLE_RECEIPT_TEXT;
  }
  return false;
}

/**
 * <tenant>.breezy.hr/p/<id>-<slug>[/apply[/submitted]]. The posting is the WHOLE `/p/` segment, so an
 * id is never matched against another slug's id; the route is the only part that moves between the
 * frozen posting URL and its receipt. The bare breezy.hr marketing site and the jobs.breezy.hr
 * aggregate (a different path shape, read by genericKnownPosting) are not tenant postings.
 */
export function breezyPostingFromUrl(
  rawUrl: string,
): { tenant: string; posting: string; route: 'posting' | 'apply' | 'submitted' } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  const suffix = '.breezy.hr';
  if (!host.endsWith(suffix)) return null;
  const tenant = host.slice(0, -suffix.length);
  if (!tenant || tenant.includes('.') || tenant === 'jobs' || tenant === 'www') return null;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0]?.toLowerCase() !== 'p' || !segments[1]) return null;
  const posting = segments[1];
  if (segments.length === 2) return { tenant, posting, route: 'posting' };
  if (segments[2]?.toLowerCase() !== 'apply') return null;
  if (segments.length === 3) return { tenant, posting, route: 'apply' };
  if (segments.length === 4 && segments[3]?.toLowerCase() === 'submitted') return { tenant, posting, route: 'submitted' };
  return null;
}

function exactLegacyAutofillReceiptMatchesOpening(
  opening: SubmissionAttemptEventRecord,
  confirmation: SubmissionAttemptEventRecord,
  finalUrl: string,
): boolean {
  return opening.source === 'legacy_backfill'
    && opening.operation === 'initial_submission'
    && opening.evidence_code === 'legacy_autofill_auto_submit_report'
    && confirmation.evidence_code === 'legacy_autofill_auto_submit_confirmation'
    && receiptUrlMatchesFrozenOpening(opening, finalUrl);
}

function applicantAttestationReceiptMatches(
  opening: SubmissionAttemptEventRecord,
  confirmation: SubmissionAttemptEventRecord,
  confirmationText: string,
  finalUrl: string,
): boolean {
  if (confirmation.evidence_code === 'applicant_found_submission') {
    return (confirmationText === APPLICANT_CONFIRMED_RECEIPT_TEXT
      || APPLICANT_FOUND_PACKET_RECEIPT_TEXTS.has(confirmationText))
      && receiptUrlMatchesFrozenOpening(confirmation, finalUrl);
  }
  if (confirmation.evidence_code === 'applicant_attributed_orphan_confirmation') {
    return confirmationText === ORPHAN_APPLICANT_CONFIRMED_RECEIPT_TEXT
      && receiptUrlMatchesFrozenOpening(confirmation, finalUrl);
  }
  if (confirmation.evidence_code === 'applicant_found_orphan_autofill_submission') {
    return confirmationText === ORPHAN_APPLICANT_CONFIRMED_RECEIPT_TEXT
      && receiptUrlMatchesFrozenOpening(confirmation, finalUrl);
  }
  if (confirmation.evidence_code === 'attended_receipt_confirmed') {
    return confirmationText === SELF_SUBMITTED_RECEIPT_TEXT
      && attendedHandoffCapabilityKind(opening) === 'self_submit'
      && receiptUrlMatchesFrozenOpening(confirmation, finalUrl);
  }
  return false;
}

function applicantFoundPacketReceiptTextMatchesAttempt(
  attempt: AttemptProjection,
  confirmationText: string,
  allowCanonicalText: boolean,
): boolean {
  if (confirmationText === APPLICANT_CONFIRMED_RECEIPT_TEXT) return allowCanonicalText;
  if (!APPLICANT_FOUND_PACKET_RECEIPT_TEXTS.has(confirmationText)) return false;
  const hasPress = attempt.events.some((event) => event.event_kind === 'press_observed');
  return confirmationText === (hasPress
    ? APPLICANT_FOUND_PACKET_RECEIPT_AFTER_PRESS_TEXT
    : APPLICANT_FOUND_PACKET_RECEIPT_WITHOUT_PRESS_TEXT);
}

function canonicalPostingMatches(
  opening: SubmissionAttemptEventRecord,
  application: ApplicationRow,
): boolean {
  return canonicalApplicationMatchesFrozenPosting(application, frozenPostingIdentityFromEvent(opening));
}

function packetPostingMatches(
  opening: SubmissionAttemptEventRecord,
  packet: PacketRow,
  review: ApplicationReviewState | null,
): boolean {
  const packetPosting = freezePostingIdentity(packet.job_context, review?.portal_url);
  return frozenPostingIdentitiesMatch(packetPosting, frozenPostingIdentityFromEvent(opening));
}

function mutablePacketClaimsSent(packet: PacketRow | null): boolean {
  if (!packet) return false;
  const review = readApplicationReview(packet.spec);
  return review?.status === 'submitted'
    || Boolean(review?.submitted_at)
    || Boolean(review?.receipt)
    || review?.unverified_submission?.resolution === 'sent'
    || TERMINAL_PACKET_PIPELINE_STAGES.has(packet.pipeline_stage ?? '');
}

function mutableApplicationClaimsSent(application: ApplicationRow | null): boolean {
  return application?.submission_state === 'submitted'
    || TERMINAL_TRACKER_STAGES.has(application?.tracker_state ?? '');
}

function repairProjection(
  reasons: Iterable<AuthoritativeSubmissionRepairReason>,
  attempt?: AttemptProjection,
  packetId?: string | null,
  applicationId?: string,
): AuthoritativeSubmissionProjection {
  const projection: Extract<AuthoritativeSubmissionProjection, { state: 'repair_required' }> = {
    state: 'repair_required',
    reasons: sortedAuthoritativeSubmissionRepairReasons(reasons),
  };
  if (attempt) projection.attemptId = attempt.attemptId;
  if (applicationId ?? attempt?.application?.id) {
    projection.canonicalApplicationId = applicationId ?? attempt!.application!.id;
  }
  if (packetId !== undefined) projection.packetId = packetId;
  else if (attempt?.opening) projection.packetId = attempt.packet ? attempt.opening.packet_id : null;
  return projection;
}

function selectedFlagsAreCoherent(
  context: ClassifierContext,
  application: ApplicationRow,
  artifactId: string | null,
): boolean {
  const selected = selectedResumeLinks(context, application.id);
  if (!artifactId) return selected.length === 0;
  return selected.length === 1 && selected[0]!.artifact_id === artifactId;
}

function frozenDocumentBindingMatches(
  context: ClassifierContext,
  binding: string,
  mode: 'artifact' | 'base_resume',
  application: ApplicationRow,
): { artifact: ArtifactRow; version: ArtifactVersionRow } | null {
  const parsed = parseCanonicalFreeVersionedDocumentBinding(binding);
  if (!parsed || parsed.mode !== mode) return null;
  const artifact = context.artifactsById.get(parsed.artifactId);
  if (!artifact || artifact.deleted_at || (artifact.kind !== 'resume' && artifact.kind !== 'tailored_resume')) {
    return null;
  }
  const versions = (context.artifactVersionsByArtifactId.get(artifact.id) ?? [])
    .filter((version) => version.version_number === parsed.versionNumber);
  if (versions.length !== 1) return null;
  const version = versions[0]!;
  if (!version.rendered_object_key
    || version.content_hash !== immutableDocumentContentHash(version.structured_content)) return null;
  const purpose = mode === 'artifact' ? 'resume' : 'submission_resume_snapshot';
  const exactLinks = linksForApplication(context, application.id).filter((link) =>
    link.artifact_id === artifact.id && link.purpose === purpose);
  if (exactLinks.length !== 1
    || !exactLinks[0]!.attached_at
    || !application.resume_attached_at
    || exactLinks[0]!.attached_at!.getTime() !== application.resume_attached_at.getTime()) return null;
  const structured = version.structured_content
    && typeof version.structured_content === 'object'
    && !Array.isArray(version.structured_content)
    ? version.structured_content as Record<string, unknown>
    : null;
  const basePdfSha256 = mode === 'base_resume'
    && typeof structured?.pdf_sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(structured.pdf_sha256)
    ? structured.pdf_sha256
    : null;
  const quality = structured?._quality
    && typeof structured._quality === 'object'
    && !Array.isArray(structured._quality)
    ? structured._quality as { pdfGenerationBinding?: unknown }
    : null;
  const artifactPdf = bindingPdfIdentity(
    quality?.pdfGenerationBinding,
    version.rendered_object_key,
  );
  const pdfSha256 = mode === 'base_resume' ? basePdfSha256 : artifactPdf?.sha256 ?? null;
  if (!pdfSha256) return null;
  const expected = buildCanonicalFreeVersionedDocumentBinding(mode, {
    artifactId: artifact.id,
    versionId: version.id,
    versionNumber: version.version_number,
    contentHash: version.content_hash,
    objectKey: version.rendered_object_key,
    blobUrl: version.rendered_blob_url,
    attachedAt: exactLinks[0]!.attached_at!.toISOString(),
    pdfSha256,
  });
  return expected === binding ? { artifact, version } : null;
}

/* THE DOCUMENT TUPLE, CHECK BY CHECK.
 *
 * generatedDocumentReasons below reports one label, document_tuple_incomplete, for some twenty
 * conditions over the canonical application row, its resume link, the artifact, its rendered
 * version, the packet audit and the opening. Bear Robotics b822b998 (2026-09-05) sat parked with
 * the employer's receipt in hand and that one label as the whole explanation, and the operator's
 * only recourse was to guess which of the twenty it was. This names them. The reasons the
 * classifier publishes do not change: the label is still one label, and every caller that
 * reads it reads exactly what it read before. Only a caller that asks to explain sees the names
 * (ClassifierContext.explain), and only for the tuple it asked about. */
export function generatedDocumentChecks(
  context: Pick<ClassifierContext, 'artifactsById' | 'artifactVersionsByArtifactId' | 'linksByApplicationId'>,
  application: ApplicationRow,
  packet: PacketRow,
  opening: SubmissionAttemptEventRecord,
): { linkage: string[]; audit: string[] } {
  const linkedArtifacts = (context.linksByApplicationId.get(application.id) ?? [])
    .filter((link) => link.purpose === 'resume')
    .map((link) => ({ link, artifact: context.artifactsById.get(link.artifact_id) }))
    .filter((value): value is { link: LinkRow; artifact: ArtifactRow } => Boolean(value.artifact))
    .filter(({ artifact }) => !artifact.deleted_at && artifact.legacy_generated_resume_id === packet.id);
  const uniqueArtifactIds = uniqueStrings(linkedArtifacts.map(({ artifact }) => artifact.id));
  const exactArtifact = uniqueArtifactIds.length === 1
    ? context.artifactsById.get(uniqueArtifactIds[0]!) ?? null
    : null;
  const allVersions = exactArtifact ? (context.artifactVersionsByArtifactId.get(exactArtifact.id) ?? []) : [];
  const exactVersions = allVersions.filter((version) =>
    version.rendered_object_key === packet.resume_object_key
    && version.content_hash === immutableDocumentContentHash(version.structured_content));
  const review = readApplicationReview(packet.spec);
  const audit = review?.packet_audit;
  const auditReady = packetAuditIsSubmissionReady(audit);
  const exactVersion = exactVersions.length === 1 ? exactVersions[0]! : null;
  const quality = exactVersion?.structured_content
    && typeof exactVersion.structured_content === 'object'
    && !Array.isArray(exactVersion.structured_content)
    ? (exactVersion.structured_content as { _quality?: { pdfGenerationBinding?: unknown } })._quality
    : undefined;
  const exactPdf = exactVersion?.rendered_object_key
    ? bindingPdfIdentity(quality?.pdfGenerationBinding, exactVersion.rendered_object_key)
    : null;
  const exactLinks = exactArtifact
    ? linkedArtifacts.filter(({ artifact }) => artifact.id === exactArtifact.id)
    : [];
  const linkage: string[] = [];
  if (uniqueArtifactIds.length !== 1) linkage.push(`linked_resume_artifacts=${uniqueArtifactIds.length}`);
  if (exactLinks.length !== 1) linkage.push(`links_to_exact_artifact=${exactLinks.length}`);
  if (application.legacy_generated_resume_id !== packet.id) linkage.push('application.legacy_generated_resume_id!=packet');
  if (application.selected_resume_artifact_id !== uniqueArtifactIds[0]) linkage.push('application.selected_resume_artifact_id!=linked_artifact');
  if (!application.resume_attached) linkage.push('application.resume_attached=false');
  if (application.resume_source !== 'artifact') linkage.push(`application.resume_source=${application.resume_source ?? 'null'}`);
  if (!application.resume_attached_at) linkage.push('application.resume_attached_at=null');
  if (!exactLinks[0]?.link.attached_at) linkage.push('link.attached_at=null');
  else if (application.resume_attached_at
    && exactLinks[0].link.attached_at.getTime() !== application.resume_attached_at.getTime()) {
    linkage.push(`link.attached_at!=application.resume_attached_at(${exactLinks[0].link.attached_at.toISOString()}!=${application.resume_attached_at.toISOString()})`);
  }
  if (exactArtifact?.rendered_object_key !== packet.resume_object_key) linkage.push('artifact.rendered_object_key!=packet.resume_object_key');
  if (exactVersions.length !== 1) linkage.push(`exact_rendered_versions=${exactVersions.length}(of ${allVersions.length})`);
  const auditChecks: string[] = [];
  if (!auditReady) auditChecks.push('packet_audit:not_submission_ready');
  if (!opening.packet_version) auditChecks.push('opening.packet_version=null');
  else if (opening.packet_version !== audit?.packet_version) auditChecks.push('opening.packet_version!=packet_audit.packet_version');
  if (audit && audit.bindings.ownerSha256 !== createHash('sha256').update(opening.user_id).digest('hex')) auditChecks.push('packet_audit.ownerSha256!=opening.user');
  if (audit && audit.bindings.applicationId !== packet.id) auditChecks.push('packet_audit.applicationId!=packet');
  if (audit && audit.bindings.pdf.objectKey !== packet.resume_object_key) auditChecks.push('packet_audit.pdf.objectKey!=packet.resume_object_key');
  if (!exactPdf) auditChecks.push('exact_version.pdfGenerationBinding=missing');
  else if (audit) {
    if (exactPdf.sha256 !== audit.bindings.pdf.sha256) auditChecks.push('exact_version.pdf.sha256!=packet_audit.pdf.sha256');
    if (exactPdf.sizeBytes !== audit.bindings.pdf.sizeBytes) auditChecks.push('exact_version.pdf.sizeBytes!=packet_audit.pdf.sizeBytes');
  }
  return { linkage, audit: auditChecks };
}

function generatedDocumentReasons(
  context: ClassifierContext,
  application: ApplicationRow,
  packet: PacketRow,
  opening: SubmissionAttemptEventRecord,
): AuthoritativeSubmissionRepairReason[] {
  const reasons: AuthoritativeSubmissionRepairReason[] = [];
  const linkedArtifacts = linksForApplication(context, application.id)
    .filter((link) => link.purpose === 'resume')
    .map((link) => ({ link, artifact: context.artifactsById.get(link.artifact_id) }))
    .filter((value): value is { link: LinkRow; artifact: ArtifactRow } => Boolean(value.artifact))
    .filter(({ artifact }) => !artifact.deleted_at && artifact.legacy_generated_resume_id === packet.id);
  const uniqueArtifactIds = uniqueStrings(linkedArtifacts.map(({ artifact }) => artifact.id));
  const exactArtifact = uniqueArtifactIds.length === 1
    ? context.artifactsById.get(uniqueArtifactIds[0]!) ?? null
    : null;
  const exactVersions = exactArtifact
    ? (context.artifactVersionsByArtifactId.get(exactArtifact.id) ?? []).filter((version) =>
      version.rendered_object_key === packet.resume_object_key
      && version.content_hash === immutableDocumentContentHash(version.structured_content))
    : [];
  const review = readApplicationReview(packet.spec);
  const audit = review?.packet_audit;
  const auditReady = packetAuditIsSubmissionReady(audit);
  const exactVersion = exactVersions.length === 1 ? exactVersions[0]! : null;
  const quality = exactVersion?.structured_content
    && typeof exactVersion.structured_content === 'object'
    && !Array.isArray(exactVersion.structured_content)
    ? (exactVersion.structured_content as { _quality?: { pdfGenerationBinding?: unknown } })._quality
    : undefined;
  const exactPdf = exactVersion?.rendered_object_key
    ? bindingPdfIdentity(quality?.pdfGenerationBinding, exactVersion.rendered_object_key)
    : null;
  const exactLinks = exactArtifact
    ? linkedArtifacts.filter(({ artifact }) => artifact.id === exactArtifact.id)
    : [];
  if (uniqueArtifactIds.length !== 1
    || exactLinks.length !== 1
    || application.legacy_generated_resume_id !== packet.id
    || application.selected_resume_artifact_id !== uniqueArtifactIds[0]
    || !application.resume_attached
    || application.resume_source !== 'artifact'
    || !application.resume_attached_at
    || !exactLinks[0]?.link.attached_at
    || exactLinks[0]!.link.attached_at!.getTime() !== application.resume_attached_at.getTime()
    || exactArtifact?.rendered_object_key !== packet.resume_object_key
    || exactVersions.length !== 1) {
    reasons.push('document_tuple_incomplete');
  }
  if (!auditReady
    || !opening.packet_version
    || opening.packet_version !== audit?.packet_version
    || audit.bindings.ownerSha256 !== createHash('sha256').update(opening.user_id).digest('hex')
    || audit.bindings.applicationId !== packet.id
    || audit.bindings.pdf.objectKey !== packet.resume_object_key
    || !exactPdf
    || exactPdf.sha256 !== audit.bindings.pdf.sha256
    || exactPdf.sizeBytes !== audit.bindings.pdf.sizeBytes) {
    reasons.push('document_tuple_incomplete');
  }
  if (context.explain && reasons.includes('document_tuple_incomplete')) {
    const checks = generatedDocumentChecks(context, application, packet, opening);
    for (const check of [...checks.linkage, ...checks.audit]) context.explain.push(`${opening.attempt_id}:${check}`);
  }
  if (!selectedFlagsAreCoherent(context, application, uniqueArtifactIds[0] ?? null)) {
    reasons.push('selected_flags_incoherent');
  }
  return reasons;
}

function legacyApplicantRepairDocumentReasons(
  context: ClassifierContext,
  application: ApplicationRow,
  packet: PacketRow,
): AuthoritativeSubmissionRepairReason[] {
  const reasons: AuthoritativeSubmissionRepairReason[] = [];
  const exactLinks = linksForApplication(context, application.id).filter((link) => link.purpose === 'resume');
  const exactArtifacts = exactLinks
    .map((link) => ({ link, artifact: context.artifactsById.get(link.artifact_id) }))
    .filter((entry): entry is { link: LinkRow; artifact: ArtifactRow } => Boolean(entry.artifact))
    .filter(({ artifact }) => !artifact.deleted_at && artifact.legacy_generated_resume_id === packet.id);
  const artifactIds = uniqueStrings(exactArtifacts.map(({ artifact }) => artifact.id));
  const artifact = artifactIds.length === 1 ? exactArtifacts[0]?.artifact ?? null : null;
  const versions = artifact
    ? (context.artifactVersionsByArtifactId.get(artifact.id) ?? []).filter((version) =>
      version.rendered_object_key === packet.resume_object_key
      && version.content_hash === immutableDocumentContentHash(version.structured_content))
    : [];
  if (artifactIds.length !== 1
    || exactArtifacts.length !== 1
    || versions.length !== 1
    || application.legacy_generated_resume_id !== packet.id
    || application.selected_resume_artifact_id !== artifact?.id
    || !application.resume_attached
    || application.resume_source !== 'artifact'
    || !application.resume_attached_at
    || !exactArtifacts[0]?.link.attached_at
    || exactArtifacts[0]!.link.attached_at!.getTime() !== application.resume_attached_at.getTime()
    || artifact?.rendered_object_key !== packet.resume_object_key) {
    reasons.push('document_tuple_incomplete');
  }
  if (!selectedFlagsAreCoherent(context, application, artifact?.id ?? null)) {
    reasons.push('selected_flags_incoherent');
  }
  return reasons;
}

function canonicalOnlyDocumentReasons(
  context: ClassifierContext,
  opening: SubmissionAttemptEventRecord,
  application: ApplicationRow,
  options: { allowLinkedPacket?: boolean } = {},
): AuthoritativeSubmissionRepairReason[] {
  const reasons: AuthoritativeSubmissionRepairReason[] = [];
  const selected = selectedResumeLinks(context, application.id);
  const binding = opening.packet_version;
  if (!options.allowLinkedPacket && application.legacy_generated_resume_id !== null) {
    reasons.push('document_tuple_incomplete');
  }
  if (binding === CANONICAL_FREE_NONE_BINDING) {
    if (application.selected_resume_artifact_id !== null
      || application.resume_attached
      || application.resume_source !== 'none'
      || application.resume_attached_at !== null) reasons.push('document_tuple_incomplete');
    if (selected.length !== 0) reasons.push('selected_flags_incoherent');
    return reasons;
  }
  if (binding?.startsWith(CANONICAL_FREE_BASE_RESUME_BINDING_PREFIX)) {
    const frozenDocument = frozenDocumentBindingMatches(context, binding, 'base_resume', application);
    const linked = frozenDocument && linksForApplication(context, application.id).some((link) =>
      link.purpose === 'submission_resume_snapshot'
      && link.artifact_id === frozenDocument.artifact.id);
    if (application.selected_resume_artifact_id !== null
      || !application.resume_attached
      || application.resume_source !== 'base_resume'
      || !application.resume_attached_at
      || !frozenDocument
      || !linked) reasons.push('document_tuple_incomplete');
    if (selected.length !== 0) reasons.push('selected_flags_incoherent');
    return reasons;
  }
  if (binding?.startsWith(CANONICAL_FREE_ARTIFACT_PREFIX)) {
    const frozenDocument = frozenDocumentBindingMatches(context, binding, 'artifact', application);
    const artifactId = frozenDocument?.artifact.id ?? '';
    const artifact = frozenDocument?.artifact;
    const linked = linksForApplication(context, application.id).some((link) =>
      link.purpose === 'resume' && link.artifact_id === artifactId);
    if (!artifact
      || artifact.deleted_at
      || !linked
      || application.selected_resume_artifact_id !== artifactId
      || !application.resume_attached
      || application.resume_source !== 'artifact'
      || !application.resume_attached_at) reasons.push('document_tuple_incomplete');
    if (!selectedFlagsAreCoherent(context, application, artifactId || null)) {
      reasons.push('selected_flags_incoherent');
    }
    return reasons;
  }
  reasons.push('document_tuple_incomplete');
  if (selected.length > 1) reasons.push('selected_flags_incoherent');
  return reasons;
}

function canonicalManualHybridReceiptReasons(
  context: ClassifierContext,
  attempt: AttemptProjection,
  application: ApplicationRow,
  receipt: NonNullable<ApplicationReviewState['receipt']> | undefined,
): AuthoritativeSubmissionRepairReason[] {
  const confirmation = attempt.confirmation!;
  if (confirmation.evidence_code === 'applicant_found_submission') return [];
  const rows = context.snapshot.canonicalReceipts.filter((event) =>
    event.event_id === attempt.attemptId
    && event.outcome === 'confirmed');
  if (rows.length !== 1) return [rows.length > 1 ? 'ambiguous_confirmation' : 'receipt_missing'];
  const row = rows[0]!;
  return receipt
    && row.user_id === attempt.opening!.user_id
    && row.application_id === application.id
    && row.observed_at.toISOString() === confirmation.observed_at.toISOString()
    && row.applied_submission_state === 'submitted'
    && row.final_url === receipt.final_url
    && (row.confirmation_text ?? '') === receipt.confirmation_text
    && row.observed_at.toISOString() === receipt.captured_at
    ? []
    : ['receipt_binding_mismatch'];
}

function classifyGeneratedConfirmation(
  context: ClassifierContext,
  attempt: AttemptProjection,
  targetPacketId?: string,
  targetApplicationId?: string,
): AuthoritativeSubmissionProjection {
  const reasons: AuthoritativeSubmissionRepairReason[] = [];
  const opening = attempt.opening!;
  const confirmation = attempt.confirmation!;
  const packet = attempt.packet;
  const application = attempt.application;
  const canonicalFreeHybrid = opening.source === 'chrome_extension'
    && opening.operation === 'manual_submission'
    && opening.application_id !== null
    && opening.packet_id !== opening.application_id;
  const legacyApplicantHybrid = opening.source === 'legacy_backfill'
    && opening.operation === 'initial_submission'
    && confirmation.evidence_code === 'applicant_found_submission'
    && opening.packet_id !== application?.id;
  const legacyStructuralProjection = opening.source === 'legacy_backfill'
    && opening.packet_version === null;
  const orphanApplicantRepair = confirmation.evidence_code === 'applicant_found_orphan_autofill_submission';
  const orphanParentOpening = opening.parent_attempt_id
    ? context.attempts.find((candidate) => candidate.attemptId === opening.parent_attempt_id)?.opening ?? null
    : null;
  if (!exactAttemptSequence(attempt, context.snapshot.attempts)) reasons.push('invalid_attempt_sequence');
  if (attempt.applicationAmbiguous) reasons.push('ambiguous_confirmation');
  if (!packet) reasons.push('packet_missing');
  if (!application) reasons.push('canonical_projection_incomplete');
  if (targetPacketId && opening.packet_id !== targetPacketId) reasons.push('receipt_binding_mismatch');
  if (targetApplicationId && application?.id !== targetApplicationId) reasons.push('receipt_binding_mismatch');
  if (application && !canonicalPostingMatches(opening, application)) reasons.push('posting_mismatch');
  const review = packet ? readApplicationReview(packet.spec) : null;
  if (packet && !packetPostingMatches(opening, packet, review)) reasons.push('posting_mismatch');
  if (!reviewProvesAcceptedInitialSecurityCode(opening, confirmation, review)) {
    reasons.push('invalid_attempt_sequence');
  }
  const receipt = review?.receipt;
  if (!receipt) reasons.push('receipt_missing');
  const completeReceipt = Boolean(receipt
    && typeof receipt.confirmation_text === 'string'
    && receipt.confirmation_text.trim()
    && receiptUrlIsAllowedForConfirmation(opening, confirmation, receipt.final_url)
    && validIso(receipt.captured_at));
  let applicantAttestationAuthority = false;
  if (receipt && !completeReceipt) reasons.push('receipt_incomplete');
  if (completeReceipt && receipt) {
    const employerEmailReceipt = exactEmployerEmailReceiptMatches(context, attempt, receipt);
    const retainedAttendedReceipt = confirmation.evidence_code === 'attended_receipt_confirmed'
      && (opening.source === 'managed_browser' || opening.source === 'direct_browser')
      && receipt.source === 'attended_handoff'
      && measuredPersistedReceiptMatchesOpening(
        opening,
        confirmation,
        receipt.final_url,
        receipt.confirmation_text,
        receipt.reference_id,
      );
    const applicantAttestation = applicantAttestationReceiptMatches(
        opening,
        confirmation,
        receipt.confirmation_text,
        receipt.final_url,
      );
    applicantAttestationAuthority = applicantAttestation;
    const legacyAutofillReceipt = exactLegacyAutofillReceiptMatchesOpening(
      opening,
      confirmation,
      receipt.final_url,
    );
    if (receipt.captured_at !== confirmation.observed_at.toISOString()
      || !(applicantAttestation || legacyAutofillReceipt || employerEmailReceipt || retainedAttendedReceipt
        || measuredPersistedReceiptMatchesOpening(
        opening,
        confirmation,
        receipt.final_url,
        receipt.confirmation_text,
        receipt.reference_id,
      ))
      || (applicantAttestation
        && confirmation.evidence_code === 'applicant_found_submission'
        && !applicantFoundPacketReceiptTextMatchesAttempt(
          attempt,
          receipt.confirmation_text,
          canonicalFreeHybrid || legacyApplicantHybrid,
        ))
      || (applicantAttestation
        ? receipt.source !== 'attended_handoff'
        : employerEmailReceipt
          ? receipt.source !== 'email_fallback'
          : retainedAttendedReceipt
            ? receipt.source !== 'attended_handoff'
          : !generatedReceiptSourceIsCompatible(opening.source, receipt.source))
      || (!applicantAttestation && opening.source !== 'legacy_backfill'
        ? canonicalFreeHybrid
          ? review?.submission_claim_id !== opening.attempt_id
          : !opening.submission_claim_id
            || !review?.submission_claim_id
            || review.submission_claim_id !== opening.submission_claim_id
        : Boolean(review?.submission_claim_id && opening.submission_claim_id
          && review.submission_claim_id !== opening.submission_claim_id))) {
      reasons.push('receipt_binding_mismatch');
    }
  }
  if (packet && application) {
    if (canonicalFreeHybrid) {
      reasons.push(...canonicalOnlyDocumentReasons(context, opening, application, {
        allowLinkedPacket: true,
      }));
      reasons.push(...canonicalManualHybridReceiptReasons(context, attempt, application, receipt));
    } else if (legacyApplicantHybrid || legacyStructuralProjection || orphanApplicantRepair) {
      reasons.push(...legacyApplicantRepairDocumentReasons(context, application, packet));
    } else if (orphanParentOpening) {
      reasons.push(...legacyApplicantRepairDocumentReasons(context, application, packet));
    } else {
      reasons.push(...generatedDocumentReasons(context, application, packet, opening));
    }
  }
  if (packet) {
    const submittedAt = review?.submitted_at;
    const packetProjectionComplete = review?.status === 'submitted'
      && validIso(submittedAt)
      && completeReceipt
      && receipt
      && Date.parse(submittedAt) <= Date.parse(receipt.captured_at)
      && TERMINAL_PACKET_PIPELINE_STAGES.has(packet.pipeline_stage ?? '')
      && (packet.pipeline_stage !== 'applied' || Boolean(packet.pipeline_stage_at));
    if (!packetProjectionComplete) reasons.push('packet_projection_incomplete');
  }
  if (application && (application.submission_state !== 'submitted'
    || !TERMINAL_TRACKER_STAGES.has(application.tracker_state))) {
    reasons.push('canonical_projection_incomplete');
  }
  if (reasons.length || !packet || !application || !receipt || !review?.submitted_at) {
    return repairProjection(reasons, attempt, packet ? packet.id : null, application?.id);
  }
  return {
    state: 'confirmed',
    attemptId: attempt.attemptId,
    canonicalApplicationId: application.id,
    packetId: packet.id,
    submittedAt: review.submitted_at,
    receipt: {
      confirmationText: receipt.confirmation_text,
      finalUrl: receipt.final_url,
      capturedAt: receipt.captured_at,
      ...(receipt.source ? { source: receipt.source } : {}),
    },
    source: applicantAttestationAuthority ? 'attended_handoff' : opening.source,
    trackerStage: application.tracker_state,
  };
}

function classifyCanonicalOnlyConfirmation(
  context: ClassifierContext,
  attempt: AttemptProjection,
  targetApplicationId?: string,
): AuthoritativeSubmissionProjection {
  const reasons: AuthoritativeSubmissionRepairReason[] = [];
  const opening = attempt.opening!;
  const confirmation = attempt.confirmation!;
  const application = attempt.application;
  if (!exactAttemptSequence(attempt, context.snapshot.attempts)) reasons.push('invalid_attempt_sequence');
  if (attempt.applicationAmbiguous) reasons.push('ambiguous_confirmation');
  if (!application) reasons.push('canonical_projection_incomplete');
  if (targetApplicationId && application?.id !== targetApplicationId) reasons.push('receipt_binding_mismatch');
  if (opening.packet_id !== opening.application_id) reasons.push('packet_missing');
  if (application && !canonicalPostingMatches(opening, application)) reasons.push('posting_mismatch');
  const directReceiptRows = context.snapshot.canonicalReceipts.filter((event) =>
    event.event_id === attempt.attemptId && event.outcome === 'confirmed');
  const migratedReceiptRows = directReceiptRows.length === 0
    && opening.source === 'legacy_backfill'
    && opening.operation === 'manual_submission'
    && application
    ? context.snapshot.canonicalReceipts.filter((event) =>
      event.outcome === 'confirmed'
      && event.user_id === opening.user_id
      && event.application_id === application.id
      && event.observed_at.toISOString() === confirmation.observed_at.toISOString())
    : [];
  const receiptRows = directReceiptRows.length > 0 ? directReceiptRows : migratedReceiptRows;
  if (receiptRows.length > 1) reasons.push('ambiguous_confirmation');
  const storedReceipt = receiptRows[0];
  const applicantFound = confirmation.evidence_code === 'applicant_found_submission';
  const derivedApplicantFinalUrl = applicantFound
    ? confirmation.portal_url ?? opening.portal_url
    : null;
  const derivedReceipt = applicantFound
    && derivedApplicantFinalUrl
    && safeHttpUrl(derivedApplicantFinalUrl)
    && receiptUrlMatchesFrozenOpening(opening, derivedApplicantFinalUrl)
    ? {
      application_id: application?.id ?? opening.application_id,
      user_id: opening.user_id,
      final_url: derivedApplicantFinalUrl,
      confirmation_text: APPLICANT_CONFIRMED_RECEIPT_TEXT,
      applied_submission_state: 'submitted',
      observed_at: confirmation.observed_at,
    }
    : null;
  if (!storedReceipt && !derivedReceipt) reasons.push('receipt_missing');
  const receipt = storedReceipt ?? derivedReceipt;
  if (receipt) {
    if (!receipt.confirmation_text?.trim()
      || !safeHttpUrl(receipt.final_url)
      || !Number.isFinite(receipt.observed_at.getTime())) reasons.push('receipt_incomplete');
    if (!application
      || receipt.application_id !== application.id
      || receipt.user_id !== opening.user_id
      || receipt.observed_at.toISOString() !== confirmation.observed_at.toISOString()
      || receipt.applied_submission_state !== 'submitted'
      || (storedReceipt
        ? !measuredPersistedReceiptMatchesOpening(
          opening,
          confirmation,
          receipt.final_url,
          receipt.confirmation_text ?? '',
        )
        : !receiptUrlMatchesFrozenOpening(opening, receipt.final_url))) {
      reasons.push('receipt_binding_mismatch');
    }
  }
  if (application) {
    reasons.push(...canonicalOnlyDocumentReasons(context, opening, application));
    if (application.submission_state !== 'submitted'
      || !TERMINAL_TRACKER_STAGES.has(application.tracker_state)) {
      reasons.push('canonical_projection_incomplete');
    }
  }
  if (reasons.length || !application || !receipt || !receipt.confirmation_text) {
    return repairProjection(reasons, attempt, null, application?.id);
  }
  return {
    state: 'confirmed',
    attemptId: attempt.attemptId,
    canonicalApplicationId: application.id,
    packetId: null,
    submittedAt: receipt.observed_at.toISOString(),
    receipt: {
      confirmationText: receipt.confirmation_text,
      finalUrl: receipt.final_url,
      capturedAt: receipt.observed_at.toISOString(),
    },
    source: derivedReceipt ? 'attended_handoff' : opening.source,
    trackerStage: application.tracker_state,
  };
}

function unresolvedProjection(attempts: AttemptProjection[]): AuthoritativeSubmissionProjection | null {
  const blocked = attempts.map((attempt) => ({
    attempt,
    safety: submissionAttemptRetrySafety(attempt.events),
  })).filter((candidate) => candidate.safety.kind === 'blocked_unverified') as Array<{
    attempt: AttemptProjection;
    safety: Extract<ReturnType<typeof submissionAttemptRetrySafety>, { kind: 'blocked_unverified' }>;
  }>;
  blocked.sort((left, right) => Date.parse(right.safety.at) - Date.parse(left.safety.at)
    || right.attempt.attemptId.localeCompare(left.attempt.attemptId));
  const exact = blocked[0];
  return exact ? {
    state: 'unverified',
    attemptId: exact.safety.attemptId,
    observedAt: exact.safety.at,
    reason: exact.safety.reason,
  } : null;
}

function collapseExactOrphanParentAttempts(
  context: ClassifierContext,
  confirmed: readonly AttemptProjection[],
): AttemptProjection[] {
  const attributedParentIds = new Set<string>();
  for (const child of confirmed) {
    const parentAttemptId = child.opening?.parent_attempt_id;
    if (!parentAttemptId
      || !exactOrphanAttributionSequence(child, context.snapshot.attempts)
      || !confirmed.some((candidate) => candidate.attemptId === parentAttemptId)) continue;
    attributedParentIds.add(parentAttemptId);
  }
  return confirmed.filter((attempt) => !attributedParentIds.has(attempt.attemptId));
}

function classifyTarget(
  context: ClassifierContext,
  target: { packetId?: string; applicationId?: string },
): AuthoritativeSubmissionProjection {
  const attempts = context.attempts.filter((attempt) => target.packetId
    ? attemptMatchesPacket(attempt, target.packetId)
    : attemptMatchesApplication(attempt, target.applicationId!));
  const confirmed = collapseExactOrphanParentAttempts(
    context,
    attempts.filter((attempt) => attempt.confirmations.length > 0),
  );
  const packet = target.packetId ? context.packetsById.get(target.packetId) ?? null : null;
  const application = target.applicationId
    ? context.applicationsById.get(target.applicationId) ?? null
    : packet
      ? context.snapshot.applications.find((row) => row.legacy_generated_resume_id === packet.id) ?? null
      : null;
  const mutableSent = mutablePacketClaimsSent(packet) || mutableApplicationClaimsSent(application);
  const matchingCanonicalReceipt = context.snapshot.canonicalReceipts.some((receipt) =>
    receipt.outcome === 'confirmed'
    && (target.applicationId
      ? receipt.application_id === target.applicationId
      : confirmed.some((attempt) => attempt.attemptId === receipt.event_id)));
  if (confirmed.length > 1) {
    return repairProjection(
      ['ambiguous_confirmation'],
      confirmed[0],
      target.packetId ?? confirmed[0]!.packet?.id ?? null,
      target.applicationId ?? confirmed[0]!.application?.id,
    );
  }
  if (confirmed.length === 1) {
    const exact = confirmed[0]!;
    const canonicalOnly = !exact.packet
      && exact.opening?.application_id !== null
      && exact.opening?.packet_id === exact.opening?.application_id;
    return canonicalOnly
      ? classifyCanonicalOnlyConfirmation(context, exact, target.applicationId)
      : classifyGeneratedConfirmation(context, exact, target.packetId, target.applicationId);
  }
  if (mutableSent || matchingCanonicalReceipt) {
    const reasons: AuthoritativeSubmissionRepairReason[] = ['mutable_sent_without_confirmation'];
    if (matchingCanonicalReceipt) reasons.push('receipt_binding_mismatch');
    return repairProjection(reasons, undefined, target.packetId ?? null, target.applicationId);
  }
  return unresolvedProjection(attempts) ?? { state: 'none' };
}

function retrySafetyForTarget(
  context: ClassifierContext,
  target: { packetId?: string; applicationId?: string },
): SubmissionAttemptRetrySafety {
  const events = context.attempts
    .filter((attempt) => target.packetId
      ? attemptMatchesPacket(attempt, target.packetId)
      : attemptMatchesApplication(attempt, target.applicationId!))
    .flatMap((attempt) => attempt.events);
  return submissionAttemptRetrySafetyForPacketEvents(events);
}

export function authoritativeSubmissionProjectionFromSnapshot(input: {
  packetIds?: readonly string[];
  applicationIds?: readonly string[];
  snapshot: AuthoritativeSubmissionProjectionSnapshot;
  /** Name each document-tuple check that fails, in `explanations`. Classification is unchanged. */
  explain?: boolean;
}): Omit<AuthoritativeSubmissionProjectionResult, 'schemaVersion' | 'revision'> {
  const explanations: string[] | undefined = input.explain ? [] : undefined;
  const context = makeContext(input.snapshot, explanations);
  const byPacketId = new Map<string, AuthoritativeSubmissionProjection>();
  const byApplicationId = new Map<string, AuthoritativeSubmissionProjection>();
  const retrySafetyByPacketId = new Map<string, SubmissionAttemptRetrySafety>();
  const retrySafetyByApplicationId = new Map<string, SubmissionAttemptRetrySafety>();
  for (const packetId of uniqueStrings(input.packetIds)) {
    byPacketId.set(packetId, classifyTarget(context, { packetId }));
    retrySafetyByPacketId.set(packetId, retrySafetyForTarget(context, { packetId }));
  }
  for (const applicationId of uniqueStrings(input.applicationIds)) {
    byApplicationId.set(applicationId, classifyTarget(context, { applicationId }));
    retrySafetyByApplicationId.set(applicationId, retrySafetyForTarget(context, { applicationId }));
  }
  return {
    byPacketId,
    byApplicationId,
    retrySafetyByPacketId,
    retrySafetyByApplicationId,
    ...(explanations ? { explanations: uniqueStrings(explanations) } : {}),
  };
}

async function projectionSnapshot(
  userId: string,
  executor: ProjectionExecutor,
): Promise<AuthoritativeSubmissionProjectionSnapshot> {
  // This helper also runs inside packet confirmation transactions. node-postgres permits only one
  // query at a time on a transaction client, and concurrent selects here can wait on one another
  // while the caller holds the submission user and packet row locks. Keep this deliberately
  // sequential so the exact post-write authority check cannot deadlock a confirmed receipt commit.
  const ownedApplications = await executor.select().from(applications)
    .where(eq(applications.user_id, userId));
  const packets = await executor.select().from(generated_resumes)
    .where(eq(generated_resumes.user_id, userId));
  const attempts = await executor.select().from(application_submission_attempt_events)
    .where(eq(application_submission_attempt_events.user_id, userId));
  const referencedApplicationIds = uniqueStrings(attempts
    .map((attempt) => attempt.application_id)
    .filter((applicationId): applicationId is string => Boolean(applicationId)));
  const referencedApplications = referencedApplicationIds.length
    ? await executor.select({ id: applications.id, userId: applications.user_id })
      .from(applications)
      .where(inArray(applications.id, referencedApplicationIds))
    : [];
  const canonicalReceipts = await executor.select().from(application_submission_events)
    .where(eq(application_submission_events.user_id, userId));
  const emailMessages = await executor.select().from(application_email_messages)
    .where(eq(application_email_messages.user_id, userId));
  const ownedArtifacts = await executor.select().from(artifacts)
    .where(eq(artifacts.user_id, userId));
  const applicationIds = ownedApplications.map((application) => application.id);
  const artifactIds = ownedArtifacts.map((artifact) => artifact.id);
  const links = applicationIds.length
    ? await executor.select().from(application_artifacts)
      .where(inArray(application_artifacts.application_id, applicationIds))
    : [];
  const ownedArtifactVersions = artifactIds.length
    ? await executor.select().from(artifact_versions)
      .where(inArray(artifact_versions.artifact_id, artifactIds))
    : [];
  return {
    applications: ownedApplications,
    foreignLiveApplicationIds: referencedApplications
      .filter((application) => application.userId !== userId)
      .map((application) => application.id),
    packets,
    attempts,
    canonicalReceipts,
    emailMessages,
    artifacts: ownedArtifacts,
    artifactVersions: ownedArtifactVersions,
    links,
  };
}

export async function authoritativeSubmissionProjection(input: {
  userId: string;
  packetIds?: readonly string[];
  applicationIds?: readonly string[];
  executor?: ProjectionExecutor;
  /** A revision read after acquiring this user's lock in this exact transaction. */
  lockedRevision?: SubmissionAuthorityRevision;
  /* How this call holds the account key. Never set it from outside: the passive branch below is
   * the only thing that may choose one, and it chooses `snapshot` - no lock at all. A caller that
   * hands us its own executor is inside a critical section and keeps the exclusive default. */
  lockMode?: SubmissionAuthorityLockMode;
  /** Name each document-tuple check that fails, in `explanations`. Classification is unchanged. */
  explain?: boolean;
}): Promise<AuthoritativeSubmissionProjectionResult> {
  if (!input.executor) {
    if (input.lockedRevision !== undefined) {
      throw new Error('A locked submission authority revision requires its transaction executor');
    }
    /* THE PASSIVE READER PATH ONLY, and only here: a caller that hands us its own executor is
     * inside a critical section whose lock waits are its own to bound.
     *
     * THIS READ TAKES NO ACCOUNT LOCK, and that is the 2026-09-04 read-only-dashboard fix.
     *
     * It used to take `submission-attempt:<userId>` EXCLUSIVELY for the whole of
     * projectionSnapshot, which loads the entire account - every application, every packet (201
     * rows on the measured account), every attempt event, every canonical receipt, every email
     * message, every artifact and version. The packet page issues this read on a 2.5-SECOND POLL.
     * Once one pass outran the poll interval the passes overlapped and, being mutually exclusive,
     * QUEUED: the key was then held without interruption, the revision trigger's try failed every
     * single-statement write on the account, and POST /applications/:id/packet-audit answered 503
     * "This account changed at the same time" for minutes on end. Opening the packet page is what
     * sustained it.
     *
     * Merely making the reader SHARED is not sufficient, and it is worth being precise about why:
     * shared readers stop queueing behind each other, but a read that outlasts the poll interval
     * still produces UNBROKEN shared coverage - poll N+1 starts before poll N finishes - and
     * shared still blocks the exclusive lock the guard needs. The account would stay read-only.
     *
     * So the reader stops participating in the lock entirely. What it actually needs is a
     * consistent (revision, snapshot) pair, and REPEATABLE READ gives it a strictly better one:
     * every statement in this transaction reads one instant, so the revision and the rows it
     * describes cannot disagree, with no lock and therefore no writer ever waiting on a reader.
     * MVCC shows only data committed as of that instant, which is exactly the guarantee the lock
     * was bought for. Readers can no longer make any write on the account fail, at any duration.
     *
     * lock_timeout stays as a floor: nothing here takes a lock now, and if that ever changes a
     * 55P03 out of this transaction is caught by the caller, which degrades to no envelopes - the
     * direction resume.ts already declares safe, since a packet without an envelope stays
     * fail-closed at the send gate. */
    return db.transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout = '5000ms'`);
      return authoritativeSubmissionProjection({ ...input, executor: tx, lockMode: 'snapshot' });
    }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
  }
  const lockMode: SubmissionAuthorityLockMode = input.lockMode ?? 'exclusive';
  if (lockMode === 'exclusive') await lockSubmissionAttemptUser(input.executor, input.userId);
  const revision = input.lockedRevision
    ?? await readSubmissionAuthorityRevision(input.userId, input.executor, { lockMode });
  const packetIds = uniqueStrings(input.packetIds);
  const applicationIds = uniqueStrings(input.applicationIds);
  if (packetIds.length === 0 && applicationIds.length === 0) {
    return {
      schemaVersion: SUBMISSION_AUTHORITY_SCHEMA_VERSION,
      revision,
      byPacketId: new Map(),
      byApplicationId: new Map(),
      retrySafetyByPacketId: new Map(),
      retrySafetyByApplicationId: new Map(),
    };
  }
  const snapshot = await projectionSnapshot(input.userId, input.executor);
  return {
    schemaVersion: SUBMISSION_AUTHORITY_SCHEMA_VERSION,
    revision,
    ...authoritativeSubmissionProjectionFromSnapshot({
      packetIds,
      applicationIds,
      snapshot,
      ...(input.explain ? { explain: true } : {}),
    }),
  };
}
