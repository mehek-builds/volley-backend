import type { AuthoritativeSubmissionProjection } from './authoritativeSubmissionProjection';
import type { SubmissionAttemptRetrySafety } from './submissionAttemptLedger';
import { SUBMISSION_AUTHORITY_SCHEMA_VERSION } from './submissionAuthorityRevision';

/**
 * The public submission-authority envelope, as the dashboard parses it.
 *
 * The dashboard derives a packet's send authority and a board card's display state from
 * `submission_authority` alone, with an exact-shape parser: exact key sets, snake_case projection
 * fields, camelCase retry-safety fields, millisecond-precision UTC timestamps, and a retry verdict
 * that must describe the same immutable attempt as its sibling projection. Anything that does not
 * parse is quarantined. On the review screen that blocks one send; on the board one unparsable
 * card fails the WHOLE collection and the board renders "Could not load your board".
 *
 * These builders are the only place the wire shape is written. They return `undefined` instead of
 * emitting anything the client would reject, so a divergence fails closed at the source with a
 * server-side signal, never as a silently quarantined packet.
 */

/** Exactly what the client's canonicalRevision accepts: a nonnegative decimal within int64. */
export function canonicalSubmissionAuthorityRevision(revision: unknown): revision is string {
  return typeof revision === 'string'
    && revision.length <= 19
    && /^(?:0|[1-9][0-9]*)$/.test(revision)
    && (revision.length < 19 || revision <= '9223372036854775807');
}

/** The client's strict retry-safety timestamp: exactly `Date#toISOString()` output. */
const STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The client's looser projection timestamp: ISO 8601 with a Z or offset, parseable. */
const PROJECTION_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const PROJECTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function strictTimestamp(value: unknown): value is string {
  return typeof value === 'string' && STRICT_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function projectionTimestamp(value: unknown): value is string {
  return typeof value === 'string' && PROJECTION_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

function projectionUuid(value: unknown): value is string {
  return typeof value === 'string' && PROJECTION_UUID.test(value);
}

export type UnattemptedPacketSubmissionAuthorityEnvelope = {
  schema_version: typeof SUBMISSION_AUTHORITY_SCHEMA_VERSION;
  revision: string;
  state: 'none';
  application_id: string;
  packet_id: string;
  projection: { state: 'none' };
  retry_safety: { kind: 'no_evidence' };
};

/**
 * The envelope a `/resume/history` packet or a submission-state response must carry for the
 * dashboard to authorise a first employer send, and only for a packet whose immutable submission
 * history is genuinely empty.
 *
 * This returns that envelope ONLY when the authoritative projection is `none` and retry safety is
 * `no_evidence`, which hold together exactly when the packet has no attempt-opened event: the one
 * state that may become sendable, whose wire projection is the irreducible `{ state: 'none' }`. A
 * packet carries no embedded canonical row on those surfaces, so the gate's identity for it is the
 * packet id itself, which is what `application_id` and `packet_id` name.
 *
 * Any packet with attempt history classifies non-none (a sent one is `repair_required`) and gets
 * `undefined` here, so it stays without an envelope and as fail-closed at the gate as before: this
 * can free a genuinely un-attempted packet but can never turn a sent one sendable.
 */
export function submissionAuthorityEnvelopeForUnattemptedPacket(input: {
  packetId: string;
  projectionState: string | undefined;
  retrySafetyKind: string | undefined;
  revision: string | undefined;
}): UnattemptedPacketSubmissionAuthorityEnvelope | undefined {
  // The client validator only accepts a canonical numeric revision (digits, <= int64). Requiring
  // the same here means a divergent revision shape returns undefined at the source instead of
  // being emitted and silently rejected downstream, which would strand the packet with no signal.
  if (input.projectionState !== 'none'
    || input.retrySafetyKind !== 'no_evidence'
    || !canonicalSubmissionAuthorityRevision(input.revision)) return undefined;
  return {
    schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION,
    revision: input.revision,
    state: 'none',
    application_id: input.packetId,
    packet_id: input.packetId,
    projection: { state: 'none' },
    retry_safety: { kind: 'no_evidence' },
  };
}

export type WireSubmissionProjection =
  | { state: 'none' }
  | {
    state: 'unverified';
    attempt_id: string;
    observed_at: string;
    reason: 'opened' | 'pressed' | 'invalid_sequence';
  }
  | {
    state: 'repair_required';
    reasons: string[];
    attempt_id?: string;
    canonical_application_id?: string;
    packet_id?: string;
  }
  | {
    state: 'confirmed';
    attempt_id: string;
    canonical_application_id: string;
    packet_id: string;
    submitted_at: string;
    receipt: {
      confirmation_text: string;
      final_url: string;
      captured_at: string;
      source?: string;
    };
    source: string;
    tracker_stage: string;
  };

export type WireSubmissionRetrySafety =
  | { kind: 'no_evidence' }
  | { kind: 'safe_not_sent'; attemptId: string; proofKind: string; resolvedAt: string }
  | {
    kind: 'blocked_unverified';
    attemptId: string;
    at: string;
    reason: 'opened' | 'boundary_authorized' | 'pressed' | 'invalid_sequence';
    leaseId?: string;
    expiresAt?: string;
  }
  | { kind: 'blocked_confirmed'; attemptId: string; confirmedAt: string };

export type PacketSubmissionAuthorityEnvelope = {
  schema_version: typeof SUBMISSION_AUTHORITY_SCHEMA_VERSION;
  revision: string;
  state: WireSubmissionProjection['state'];
  application_id: string;
  packet_id: string;
  projection: WireSubmissionProjection;
  retry_safety: WireSubmissionRetrySafety | null;
};

/* The client's confirmed-source and receipt-source vocabularies. The backend ledger also knows
 * `unsupported_email` (attempt source) and `email_fallback` (receipt source); the client accepts
 * neither, so a confirmed projection carrying one cannot be published and fails closed below. */
const CONFIRMED_SOURCES = new Set([
  'managed_browser',
  'direct_browser',
  'chrome_extension',
  'ats_api',
  'attended_handoff',
  'legacy_backfill',
]);
const CONFIRMED_TRACKER_STAGES = new Set(['applied', 'interview', 'offer', 'closed']);

function receiptSourceIsPublishable(source: string, receiptSource: string | undefined): boolean {
  // On a packet-bound projection `packet_id` is never null, so an absent receipt source is only
  // acceptable for a legacy backfill.
  if (receiptSource === undefined) return source === 'legacy_backfill';
  if (source === 'managed_browser' || source === 'direct_browser') return receiptSource === 'managed_browser';
  if (source === 'chrome_extension' || source === 'ats_api' || source === 'attended_handoff') {
    return receiptSource === source;
  }
  return source === 'legacy_backfill'
    && ['managed_browser', 'chrome_extension', 'ats_api', 'attended_handoff'].includes(receiptSource);
}

function safeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function retrySafetyWire(safety: SubmissionAttemptRetrySafety): WireSubmissionRetrySafety {
  // The client's retry key sets are exact: a plain hold carries exactly {kind, attemptId, at,
  // reason} and only a boundary-authorized hold adds {leaseId, expiresAt}. Undefined optional keys
  // would be dropped by JSON anyway, but tests compare the object the route builds.
  if (safety.kind === 'blocked_unverified') {
    return {
      kind: 'blocked_unverified',
      attemptId: safety.attemptId,
      at: safety.at,
      reason: safety.reason,
      ...(safety.reason === 'boundary_authorized'
        ? { leaseId: safety.leaseId, expiresAt: safety.expiresAt }
        : {}),
    };
  }
  return safety;
}

/**
 * The full public envelope for one packet on a passive collection surface such as the board,
 * where the client requires an envelope on EVERY card and binds both `application_id` and
 * `packet_id` to the card id.
 *
 * Reuses the authoritative projection and the ledger's retry fold; it never re-classifies. The
 * retry verdict for a confirmed or held card is written from the projection's own attempt
 * (attempt id, observation, receipt capture), because the client demands they agree and the fold
 * may name an earlier attempt when a packet holds several.
 *
 * Returns `undefined`, and so no envelope, in exactly the cases the client would reject anyway:
 *  - a `none` projection whose retry evidence is a block (inconsistent inputs);
 *  - a held attempt whose reason is `boundary_authorized`: the client accepts that only as a
 *    `boundary_authorized` envelope carrying the lease, activation id and capability digests, facts
 *    the projection does not carry and that no route publishes; the review surface handles that
 *    attempt through its own handoff responses;
 *  - a confirmed projection outside the client's vocabulary (an `unsupported_email` attempt, an
 *    `email_fallback` receipt, an attended receipt retained on a managed opening, a receipt text
 *    over 2000 bytes, a non-https final URL, a projection bound to another packet);
 *  - a non-canonical revision, for the same reason as the unattempted builder.
 */
export function submissionAuthorityEnvelopeForPacket(input: {
  packetId: string;
  projection: AuthoritativeSubmissionProjection | undefined;
  retrySafety: SubmissionAttemptRetrySafety | undefined;
  revision: string | undefined;
}): PacketSubmissionAuthorityEnvelope | undefined {
  const { packetId, projection, retrySafety, revision } = input;
  if (!projection || !retrySafety || !canonicalSubmissionAuthorityRevision(revision)) return undefined;

  const envelope = (
    wireProjection: WireSubmissionProjection,
    wireRetrySafety: WireSubmissionRetrySafety | null,
  ): PacketSubmissionAuthorityEnvelope => ({
    schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION,
    revision,
    state: wireProjection.state,
    application_id: packetId,
    packet_id: packetId,
    projection: wireProjection,
    retry_safety: wireRetrySafety,
  });

  if (projection.state === 'none') {
    if (retrySafety.kind === 'no_evidence') {
      return submissionAuthorityEnvelopeForUnattemptedPacket({
        packetId,
        projectionState: projection.state,
        retrySafetyKind: retrySafety.kind,
        revision,
      });
    }
    if (retrySafety.kind === 'safe_not_sent' && strictTimestamp(retrySafety.resolvedAt)) {
      return envelope({ state: 'none' }, retrySafetyWire(retrySafety));
    }
    return undefined;
  }

  if (projection.state === 'unverified') {
    if (projection.reason === 'boundary_authorized'
      || !projectionUuid(projection.attemptId)
      || !strictTimestamp(projection.observedAt)) return undefined;
    return envelope(
      {
        state: 'unverified',
        attempt_id: projection.attemptId,
        observed_at: projection.observedAt,
        reason: projection.reason,
      },
      {
        kind: 'blocked_unverified',
        attemptId: projection.attemptId,
        at: projection.observedAt,
        reason: projection.reason,
      },
    );
  }

  if (projection.state === 'repair_required') {
    if (projection.reasons.length === 0) return undefined;
    // A repair projection bound to a different packet cannot be published under this card.
    if (typeof projection.packetId === 'string' && projection.packetId !== packetId) return undefined;
    if (projection.attemptId !== undefined && !projectionUuid(projection.attemptId)) return undefined;
    if (projection.canonicalApplicationId !== undefined
      && !projectionUuid(projection.canonicalApplicationId)) return undefined;
    // The client rejects `no_evidence` and `safe_not_sent` beside a repair projection, and a block
    // that names a different attempt than the projection. `null` is the honest verdict there: the
    // projection alone already routes the card to review.
    const consistentBlock = (retrySafety.kind === 'blocked_unverified' || retrySafety.kind === 'blocked_confirmed')
      && (projection.attemptId === undefined || retrySafety.attemptId === projection.attemptId)
      && projectionUuid(retrySafety.attemptId)
      && (retrySafety.kind === 'blocked_unverified'
        ? strictTimestamp(retrySafety.at) && (retrySafety.reason !== 'boundary_authorized'
          || (projectionUuid(retrySafety.leaseId) && strictTimestamp(retrySafety.expiresAt)))
        : strictTimestamp(retrySafety.confirmedAt));
    return envelope(
      {
        state: 'repair_required',
        reasons: [...projection.reasons],
        ...(projection.attemptId !== undefined ? { attempt_id: projection.attemptId } : {}),
        ...(projection.canonicalApplicationId !== undefined
          ? { canonical_application_id: projection.canonicalApplicationId }
          : {}),
        // Null (no packet bound) is omitted: the client rejects `packet_id: null` on a card.
        ...(typeof projection.packetId === 'string' ? { packet_id: projection.packetId } : {}),
      },
      consistentBlock ? retrySafetyWire(retrySafety) : null,
    );
  }

  // confirmed
  const receipt = projection.receipt;
  if (projection.packetId !== packetId
    || !projectionUuid(projection.attemptId)
    || !projectionUuid(projection.canonicalApplicationId)
    || !CONFIRMED_SOURCES.has(projection.source)
    || !CONFIRMED_TRACKER_STAGES.has(projection.trackerStage)
    || !projectionTimestamp(projection.submittedAt)
    || !strictTimestamp(receipt.capturedAt)
    || Date.parse(projection.submittedAt) > Date.parse(receipt.capturedAt)
    || !receipt.confirmationText.trim()
    || Buffer.byteLength(receipt.confirmationText, 'utf8') > 2000
    || !safeHttpsUrl(receipt.finalUrl)
    || !receiptSourceIsPublishable(projection.source, receipt.source)) return undefined;
  return envelope(
    {
      state: 'confirmed',
      attempt_id: projection.attemptId,
      canonical_application_id: projection.canonicalApplicationId,
      packet_id: projection.packetId,
      submitted_at: projection.submittedAt,
      receipt: {
        confirmation_text: receipt.confirmationText,
        final_url: receipt.finalUrl,
        captured_at: receipt.capturedAt,
        ...(receipt.source !== undefined ? { source: receipt.source } : {}),
      },
      source: projection.source,
      tracker_stage: projection.trackerStage,
    },
    { kind: 'blocked_confirmed', attemptId: projection.attemptId, confirmedAt: receipt.capturedAt },
  );
}
