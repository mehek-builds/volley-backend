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
 * parse is quarantined, which blocks that packet's send.
 *
 * These builders are the only place the wire shape is written. They never emit anything the client
 * would reject; they refuse instead, and name why, so a divergence fails closed at the source with
 * a server-side signal rather than as a silently quarantined packet. The refusal is per packet: a
 * card the server cannot vouch for is one card that cannot be sent, and the caller publishes the
 * reason beside it (see PacketSubmissionAuthorityUnavailable) so a reader can tell an unverifiable
 * card apart from a server that does not speak this contract at all.
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
  retry_safety:
    | { kind: 'no_evidence' }
    | { kind: 'safe_not_sent'; attemptId: string; proofKind: string; resolvedAt: string };
};

/**
 * The envelope a `/resume/history` packet or a submission-state response must carry for the
 * dashboard to authorise a first employer send, and only for a packet whose immutable submission
 * history proves nothing reached an employer.
 *
 * Two retry verdicts prove that, and this returns the envelope for exactly those two under a
 * `none` projection:
 *   - `no_evidence`: the packet has no attempt-opened event at all, the plain un-attempted case;
 *   - `safe_not_sent`: an attempt WAS opened and the ledger then proved, with a typed not-sent
 *     fact, that it never crossed the employer boundary. That is the state every packet lands in
 *     after repairExpiredAttendedHandoffClaim releases a phantom attempt (PR #861), and it is
 *     STRONGER evidence of safety than no evidence, not weaker.
 * Admitting only the first was the defect measured live on The Maven Group (crelate) 2026-09-02:
 * the board card published `safe_not_sent`, this builder returned undefined for the same packet,
 * `/applications/:id/submission` therefore carried no envelope, and the dashboard's send gate -
 * whose submissionRetrySafetyAllowsRetry explicitly accepts `safe_not_sent` - fell back to the
 * packet's stored null and refused: "Litos cannot start another employer attempt until the exact
 * prior submission evidence is verified", on a packet the ledger had just proven never sent.
 *
 * The wire shape for `safe_not_sent` is the domain verdict passed through retrySafetyWire, the
 * same bytes the board publishes, so the two surfaces can never disagree about one packet. A
 * `safe_not_sent` whose resolvedAt is not a strict timestamp is refused rather than emitted with a
 * field the client validator rejects. A packet carries no embedded canonical row on these
 * surfaces, so the gate's identity for it is the packet id itself, which is what `application_id`
 * and `packet_id` name.
 *
 * Any packet whose history is a block or a confirmation classifies non-none (a sent one is
 * `repair_required`, a held one `unverified`) and gets `undefined` here, so it stays without an
 * envelope and as fail-closed at the gate as before: this frees a provably un-sent packet and can
 * never turn a sent or uncertain one sendable.
 */
export function submissionAuthorityEnvelopeForUnattemptedPacket(input: {
  packetId: string;
  projectionState: string | undefined;
  retrySafety: SubmissionAttemptRetrySafety | undefined;
  revision: string | undefined;
}): UnattemptedPacketSubmissionAuthorityEnvelope | undefined {
  // The client validator only accepts a canonical numeric revision (digits, <= int64). Requiring
  // the same here means a divergent revision shape returns undefined at the source instead of
  // being emitted and silently rejected downstream, which would strand the packet with no signal.
  if (input.projectionState !== 'none' || !canonicalSubmissionAuthorityRevision(input.revision)) {
    return undefined;
  }
  /* `safe_not_sent` is the ledger's proof, and it covers two shapes: an attempt that never crossed
   * the boundary (the #861 release, typed_pre_click_stop) and a pressed attempt the applicant
   * herself checked and attested was not there (applicant_checked_not_sent, admitted by the fold
   * only after the boundary lease expired). Both are the ledger's verdict, not this builder's; the
   * builder only refuses to emit a field the client validator would quarantine, hence the uuid
   * and strict-timestamp checks - the same promise the `unverified` branch keeps below. */
  const safety = input.retrySafety;
  const retrySafety = safety?.kind === 'no_evidence'
    ? { kind: 'no_evidence' as const }
    : safety?.kind === 'safe_not_sent'
      && strictTimestamp(safety.resolvedAt)
      && projectionUuid(safety.attemptId)
      ? retrySafetyWire(safety)
      : undefined;
  if (!retrySafety || (retrySafety.kind !== 'no_evidence' && retrySafety.kind !== 'safe_not_sent')) {
    return undefined;
  }
  return {
    schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION,
    revision: input.revision,
    state: 'none',
    application_id: input.packetId,
    packet_id: input.packetId,
    projection: { state: 'none' },
    retry_safety: retrySafety,
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
 * Why one card's authority could not be published, in machine-readable form.
 *
 * The board publishes one of these beside a card instead of publishing nothing, so a reader can
 * tell "this card is unverifiable" from "this server does not speak the contract". The vocabulary
 * is closed and each member names a distinct, reachable class:
 *
 *  - `projection_read_failed`: the authoritative projection or the ledger's retry fold could not be
 *    read for this packet, so the server has no opinion to publish. This is the only reason that
 *    can appear on every card at once, when the whole batched read failed.
 *  - `revision_not_canonical`: the collection's revision is not the client's canonical numeric
 *    shape, so no envelope on this payload could be bound to it.
 *  - `boundary_authorized`: an employer-boundary authorization is open with no press observed. Every
 *    managed submission occupies this state between authorizeFinalSubmissionBoundary and the press,
 *    and stays in it permanently if the runner dies inside that window. The client's confirmed and
 *    unverified vocabularies have no word for it: it is publishable only as the boundary envelope
 *    carrying the lease, activation id and capability digests, which no passive surface holds.
 *  - `unpublishable_receipt_source`: the packet is genuinely confirmed, but on a source or receipt
 *    source outside the client's vocabulary. Reachable two ways: the unsupported-portal EMAIL
 *    channel (attempt source `unsupported_email`, receipt source `email_fallback`), and an attended
 *    receipt retained on a managed or direct opening.
 *  - `inconsistent_retry_evidence`: the projection and the ledger's retry fold disagree in a way the
 *    client rejects, such as a `none` projection beside a block.
 *  - `unpublishable_projection`: any other shape the client's exact-shape parser would quarantine
 *    (a malformed identifier or timestamp, a projection bound to another packet, an oversize
 *    receipt text, a non-https final URL).
 */
export type SubmissionAuthorityUnavailableReason =
  | 'projection_read_failed'
  | 'revision_not_canonical'
  | 'boundary_authorized'
  | 'unpublishable_receipt_source'
  | 'inconsistent_retry_evidence'
  | 'unpublishable_projection';

/**
 * The per-card marker a passive collection carries in place of an envelope it cannot publish.
 *
 * Deliberately three stable keys with no optional members, so a reader never has to branch on which
 * fields arrived. It carries no revision: the collection's own `submission_authority_revision` is
 * the identity, and a marker that restated it would invite a reader to treat the card as bound to a
 * revision whose authority the server just said it could not establish.
 *
 * A marker is NOT authority to send. It says the opposite: this card's send state is unverifiable
 * from this payload, so the card is not sendable and belongs in review.
 */
export type PacketSubmissionAuthorityUnavailable = {
  schema_version: typeof SUBMISSION_AUTHORITY_SCHEMA_VERSION;
  packet_id: string;
  reason: SubmissionAuthorityUnavailableReason;
};

export type SubmissionAuthorityPublication =
  | { published: true; envelope: PacketSubmissionAuthorityEnvelope }
  | { published: false; reason: SubmissionAuthorityUnavailableReason };

/** The marker as it goes on the wire. */
export function submissionAuthorityUnavailableMarker(
  packetId: string,
  reason: SubmissionAuthorityUnavailableReason,
): PacketSubmissionAuthorityUnavailable {
  return { schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION, packet_id: packetId, reason };
}

/**
 * The full public envelope for one packet on a passive collection surface such as the board,
 * where the client binds both `application_id` and `packet_id` to the card id.
 *
 * Reuses the authoritative projection and the ledger's retry fold; it never re-classifies. The
 * retry verdict for a confirmed or held card is written from the projection's own attempt
 * (attempt id, observation, receipt capture), because the client demands they agree and the fold
 * may name an earlier attempt when a packet holds several.
 *
 * Returns `{ published: false }` with a reason, and so no envelope, in exactly the cases the client
 * would reject anyway:
 *  - a `none` projection whose retry evidence is a block (inconsistent inputs);
 *  - a held attempt whose reason is `boundary_authorized`: the client accepts that only as a
 *    `boundary_authorized` envelope carrying the lease, activation id and capability digests, facts
 *    the projection does not carry and that no route publishes; the review surface handles that
 *    attempt through its own handoff responses;
 *  - a confirmed projection outside the client's vocabulary (an `unsupported_email` attempt, an
 *    `email_fallback` receipt, an attended receipt retained on a managed opening, a receipt text
 *    over 2000 bytes, a non-https final URL, a projection bound to another packet);
 *  - a non-canonical revision, for the same reason as the unattempted builder.
 *
 * The caller publishes the reason as a per-card marker. Failing closed is right, but it is right
 * PER CARD: one unpublishable card is one card that cannot be sent, never a whole board the reader
 * has to refuse.
 */
export function submissionAuthorityPublicationForPacket(input: {
  packetId: string;
  projection: AuthoritativeSubmissionProjection | undefined;
  retrySafety: SubmissionAttemptRetrySafety | undefined;
  revision: string | undefined;
}): SubmissionAuthorityPublication {
  const { packetId, projection, retrySafety, revision } = input;
  const unavailable = (reason: SubmissionAuthorityUnavailableReason): SubmissionAuthorityPublication =>
    ({ published: false, reason });
  if (!projection || !retrySafety) return unavailable('projection_read_failed');
  // The client validator only accepts a canonical numeric revision (digits, <= int64). Requiring
  // the same here means a divergent revision shape is named at the source instead of being emitted
  // and silently rejected downstream, which would strand the packet with no signal.
  if (!canonicalSubmissionAuthorityRevision(revision)) return unavailable('revision_not_canonical');

  const published = (
    wireProjection: WireSubmissionProjection,
    wireRetrySafety: WireSubmissionRetrySafety | null,
  ): SubmissionAuthorityPublication => ({
    published: true,
    envelope: {
      schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION,
      revision,
      state: wireProjection.state,
      application_id: packetId,
      packet_id: packetId,
      projection: wireProjection,
      retry_safety: wireRetrySafety,
    },
  });

  if (projection.state === 'none') {
    /* BOTH provably-safe verdicts go through the one shared builder, so the board card and the
     * per-packet submission response emit byte-identical envelopes for one packet. A separate
     * safe_not_sent branch here is how the two surfaces came to disagree (Maven, 2026-09-02): the
     * board published it, the builder refused it. A `safe_not_sent` with a malformed resolvedAt
     * is the builder's undefined, named here as an unpublishable projection. */
    if (retrySafety.kind === 'no_evidence' || retrySafety.kind === 'safe_not_sent') {
      const envelope = submissionAuthorityEnvelopeForUnattemptedPacket({
        packetId,
        projectionState: projection.state,
        retrySafety,
        revision,
      });
      if (envelope) return { published: true, envelope };
      return unavailable(
        retrySafety.kind === 'safe_not_sent'
          && (!strictTimestamp(retrySafety.resolvedAt) || !projectionUuid(retrySafety.attemptId))
          ? 'unpublishable_projection'
          : 'revision_not_canonical',
      );
    }
    // A block beside an empty projection is the two reads disagreeing, not a state to render.
    return unavailable('inconsistent_retry_evidence');
  }

  if (projection.state === 'unverified') {
    if (projection.reason === 'boundary_authorized') return unavailable('boundary_authorized');
    if (!projectionUuid(projection.attemptId) || !strictTimestamp(projection.observedAt)) {
      return unavailable('unpublishable_projection');
    }
    return published(
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
    if (projection.reasons.length === 0) return unavailable('unpublishable_projection');
    // A repair projection bound to a different packet cannot be published under this card.
    if (typeof projection.packetId === 'string' && projection.packetId !== packetId) {
      return unavailable('unpublishable_projection');
    }
    if (projection.attemptId !== undefined && !projectionUuid(projection.attemptId)) {
      return unavailable('unpublishable_projection');
    }
    if (projection.canonicalApplicationId !== undefined
      && !projectionUuid(projection.canonicalApplicationId)) {
      return unavailable('unpublishable_projection');
    }
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
    return published(
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
  // Named apart from the shape checks below because it is the class a real, genuinely confirmed
  // submission lands in: the unsupported-portal email channel and a retained attended receipt both
  // produce a true send the client has no vocabulary for.
  if (!CONFIRMED_SOURCES.has(projection.source)
    || !receiptSourceIsPublishable(projection.source, receipt.source)) {
    return unavailable('unpublishable_receipt_source');
  }
  if (projection.packetId !== packetId
    || !projectionUuid(projection.attemptId)
    || !projectionUuid(projection.canonicalApplicationId)
    || !CONFIRMED_TRACKER_STAGES.has(projection.trackerStage)
    || !projectionTimestamp(projection.submittedAt)
    || !strictTimestamp(receipt.capturedAt)
    || Date.parse(projection.submittedAt) > Date.parse(receipt.capturedAt)
    || !receipt.confirmationText.trim()
    || Buffer.byteLength(receipt.confirmationText, 'utf8') > 2000
    || !safeHttpsUrl(receipt.finalUrl)) return unavailable('unpublishable_projection');
  return published(
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

/**
 * The envelope alone, for callers that only need "can this be published".
 * `undefined` means it cannot; `submissionAuthorityPublicationForPacket` says why.
 */
export function submissionAuthorityEnvelopeForPacket(input: {
  packetId: string;
  projection: AuthoritativeSubmissionProjection | undefined;
  retrySafety: SubmissionAttemptRetrySafety | undefined;
  revision: string | undefined;
}): PacketSubmissionAuthorityEnvelope | undefined {
  const publication = submissionAuthorityPublicationForPacket(input);
  return publication.published ? publication.envelope : undefined;
}
