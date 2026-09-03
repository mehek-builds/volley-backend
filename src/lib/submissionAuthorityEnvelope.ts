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
/* The client's identifier contract, split into the parts a refusal can name separately. Layout,
 * version nibble and variant nibble together are equivalent, character for character, to the one
 * regex each replaces, and submissionAuthorityEnvelope.test.ts pins that equivalence over a table
 * of shapes, so the classification below can never come to disagree with the predicate that does
 * the refusing.
 *
 * THERE ARE TWO CONTRACTS, NOT ONE, AND THIS FILE ENFORCED ONLY THE NARROWER, 2026-09-03. The note
 * that stood here said the version nibble was where "this repo disagrees with itself" - the ledger's
 * own UUID_PATTERN (lib/submissionAttemptLedger.ts:169), duplicateApplication.ts:469,
 * postingIdentityDistinction.ts:23 and canonicalFreeDocumentBinding.ts:33 all accept 1-8, while the
 * client this file serialises was believed to accept 1-5 everywhere - and it recorded that whether
 * any live identifier sits in that gap was not established. Both halves of that note are now
 * answered, and the second answer is the one that mattered.
 *
 * The deployed dashboard was read on 2026-09-03 (rq-counter, the sibling worktree whose readers
 * `/health.revision` 9c7aee2 is serving against). It carries THREE identifier regexes, not one, and
 * they do not agree:
 *   - features/applications/domain/submission-projection.ts:12  UUID_PATTERN  versions 1-5
 *     applied to `projection.attempt_id`, `projection.canonical_application_id`,
 *     `projection.packet_id`;
 *   - features/applications/domain/submission-state.ts:74       SUBMISSION_UUID versions 1-8
 *     applied to `retry_safety.attemptId` and `retry_safety.leaseId`;
 *   - features/applications/domain/submission-authority-envelope.ts:16  UUID  versions 1-8
 *     applied to `application_id`, `packet_id` and the boundary envelope's own ids.
 * So a retry-safety identifier whose version nibble is 6, 7 or 8 is accepted by the deployed client
 * and was refused here, for a rule that belongs to a different field. That is this file being
 * narrower than the contract it exists to mirror, which is the one direction a shape check is not
 * allowed to fail in: it costs a packet its envelope for nothing.
 *
 * AND THAT IS THE DEPLOYED BUNDLE, not a worktree that might not be it. trylitos.com/dashboard
 * serves both regexes, verbatim, from one chunk, and each sits beside exactly the vocabulary it
 * governs: the `[1-5]` one within a kilobyte of `attempt_id`, `canonical_application_id` and
 * `repair_required`, and five kilobytes from `safe_not_sent`; the `[1-8]` one within a kilobyte of
 * `safe_not_sent`, `proofKind`, `blocked_unverified` and `leaseId`, and four kilobytes from
 * `attempt_id`. The dashboard's chunks are public static assets, so this is re-checkable without a
 * token: fetch /dashboard, take the /_next/static/chunks URLs, and search them.
 *
 * AND THE LIVE IDENTIFIERS REALLY DO SIT IN THAT GAP. `GET /applications/board?limit=500` on
 * mehekmandal05@gmail.com, 2026-09-03, revision 1624: of the 37 cards that published an envelope, 9
 * carry an identifier, and their version nibbles are 1, 1, 1, 3, 4, 4, 4, 4, 5 with variants
 * 8, 8, 9, a, a, b, b, b, b. A generator that minted RFC-4122 identifiers could not produce that:
 * randomUUID() stamps 4 and uuidv5 stamps 5, and neither ever stamps 1 or 3. The ledger's
 * `attempt_id` is a Postgres `uuid` column, which accepts any 128 bits, and appendSubmissionAttemptEvent
 * never version-checks it (assertAppendInput only requires it to be non-empty). So an attempt id
 * here is an OPAQUE 128-bit value whose version and variant nibbles are uniformly distributed, and
 * enforcing an RFC version on it accepts 5/16 of the identifiers the system actually mints.
 *
 * That is measured, not modelled: on the same read, 162 of the 163 refused cards were refused for
 * `projection.attempt_id` alone - 115 `uuid_version_unsupported` and 47 `uuid_variant_unsupported`,
 * against 9 that passed. The projection rule below is NOT widened to match, because it is the
 * client's own rule for those fields and publishing past it is far worse than refusing: one card
 * whose envelope fails to parse makes boardSubmissionAuthorityCollectionIsComplete
 * (domain/board-submission-authority.ts:56) reject the WHOLE payload, while a card with no envelope
 * is merely absent. Only the retry-safety rule moves, and it moves exactly onto the client's. */
const UUID_LAYOUT = /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{12}$/i;
/** `submission-projection.ts:12`: the rule for every identifier inside a published projection. */
const UUID_VERSION = /^[1-5]$/;
/** `submission-state.ts:74`: the rule for every identifier inside a published retry verdict. */
const RETRY_SAFETY_UUID_VERSION = /^[1-8]$/;
/** Shared by both client regexes, so a refusal on the variant nibble is correct on either field. */
const UUID_VARIANT = /^[89ab]$/i;

/**
 * WHY ONE FIELD WAS REFUSED, as a class rather than as its value.
 *
 * The builders below deliberately withhold an envelope carrying a field the client would
 * quarantine. That is the right failure direction, and it also means the offending value never
 * reaches the wire and never reaches a log - so from every client surface the refusal is
 * unfalsifiable. Measured live 2026-09-03 on mehekmandal05@gmail.com: `GET /applications/board`
 * returned 200 cards, 35 with an envelope (`no_evidence` 27, `blocked_unverified` 7,
 * `blocked_confirmed` 1) and 165 with a marker, of which 163 said `unpublishable_projection` and 2
 * said `boundary_authorized`. SEVEN separate checks across FOUR projection branches in this file
 * return that one word, so the census does not say which check fired, on which branch, or against
 * which field - and 163 cards collapsed onto one string is a count, not a cause.
 *
 * That the reason is genuinely overloaded rather than one repeated defect is measured, not assumed.
 * At 11:55Z the same day, resolving one packet's unverified record through the dashboard (DSI
 * Innovations, packet a34e5ce2) produced a `safe_not_sent` verdict that published END TO END: a
 * `none` projection, attempt id 37e4ca1b (version nibble 4, variant 8) and a resolvedAt with
 * exactly three fractional digits, both accepted. So `safe_not_sent` is not structurally
 * unpublishable and the attempt-id minting path is not globally broken; whatever refuses the 163 is
 * something else, and the census alone cannot say what.
 *
 * THE CENSUS THEN SAID WHAT, and the answer was not what the sampling above implied. Read the same
 * day through GET /applications/board/authority-rejections (PR #901, deployed at 9c7aee2), 200
 * packets classified, 163 refused, grouped by (branch, field, shape):
 *
 *   unverified       projection.attempt_id  uuid_version_unsupported  104
 *   unverified       projection.attempt_id  uuid_variant_unsupported   46
 *   repair_required  projection.attempt_id  uuid_version_unsupported   10
 *   confirmed        projection.attempt_id  uuid_version_unsupported    1
 *   repair_required  projection.attempt_id  uuid_variant_unsupported    1
 *   boundary_authorized  (no field)                                     1
 *
 * ONE field, on three branches. Not one timestamp, not one receipt, not one non-https URL, not one
 * cross-packet binding - the four classes the residual reason was mostly written for have zero
 * members on this account. The `none` branch, which the whole census was first read as, has zero
 * too: a resolved packet publishes, exactly as the DSI packet did. The refusal is real and stays,
 * for the reason under UUID_LAYOUT, and it now has a word of its own so it stops being counted as
 * the residual: `unpublishable_attempt_identity`.
 *
 * These classes are what closed that gap. Each names the shape a value failed to have, never the
 * value: `uuid_version_unsupported` says the identifier had the canonical 8-4-4-4-12 layout and a
 * version nibble outside its field's accepted range, and says nothing else about it. An attempt id
 * is an internal identifier and stays one.
 */
export type SubmissionAuthorityRejectedShape =
  | 'absent'
  | 'not_a_string'
  | 'blank'
  | 'uuid_malformed'
  | 'uuid_version_unsupported'
  | 'uuid_variant_unsupported'
  | 'timestamp_unparseable'
  | 'timestamp_not_strict_iso'
  | 'timestamp_not_iso'
  | 'empty_list'
  | 'bound_to_other_packet'
  | 'outside_client_vocabulary'
  | 'not_https_url'
  | 'oversize'
  | 'out_of_order';

/** A shape check's answer: the class it failed, or `ok`. */
type FieldShape = SubmissionAuthorityRejectedShape | 'ok';

/**
 * EVERY FIELD NAME A REFUSAL MAY NAME, closed, 2026-09-03.
 *
 * `field` was `string` while the rejection lived only in a log line, and that was survivable there.
 * It is not survivable now that the rejection travels to an authenticated caller: `string` is a slot
 * an author can interpolate a value into, and the ONE promise this diagnosis makes is that the value
 * that failed never leaves the server. A closed union makes that promise a compile error rather than
 * a review convention, and `submissionAuthorityRefusalForWire` re-checks membership at run time for
 * the case the compiler cannot see (a cast, a JSON round trip, a future caller).
 *
 * Fourteen names, in the order the branches evaluate them. Twelve of the fourteen belong to the
 * seven `unpublishable_projection` sites (eighteen clauses); `projection.source` and
 * `receipt.source` belong to `unpublishable_receipt_source`, which is a different repair and so
 * keeps its own reason.
 */
export const SUBMISSION_AUTHORITY_REJECTED_FIELDS = [
  'retry_safety.attemptId',
  'retry_safety.resolvedAt',
  'projection.attempt_id',
  'projection.observed_at',
  'projection.reasons',
  'projection.packet_id',
  'projection.canonical_application_id',
  'projection.source',
  'projection.tracker_stage',
  'projection.submitted_at',
  'receipt.source',
  'receipt.captured_at',
  'receipt.confirmation_text',
  'receipt.final_url',
] as const;

export type SubmissionAuthorityRejectedField = typeof SUBMISSION_AUTHORITY_REJECTED_FIELDS[number];

const REJECTED_FIELDS: ReadonlySet<string> = new Set(SUBMISSION_AUTHORITY_REJECTED_FIELDS);

const REJECTION_BRANCHES: ReadonlySet<string> = new Set(['none', 'unverified', 'repair_required', 'confirmed']);

const REJECTED_SHAPES: ReadonlySet<string> = new Set<SubmissionAuthorityRejectedShape>([
  'absent',
  'not_a_string',
  'blank',
  'uuid_malformed',
  'uuid_version_unsupported',
  'uuid_variant_unsupported',
  'timestamp_unparseable',
  'timestamp_not_strict_iso',
  'timestamp_not_iso',
  'empty_list',
  'bound_to_other_packet',
  'outside_client_vocabulary',
  'not_https_url',
  'oversize',
  'out_of_order',
]);

/**
 * The one refusal a reader needs to act on: which branch classified the packet, which field of the
 * shape that branch would have emitted failed, and how.
 *
 * Three stable keys, like the wire marker, and for the same reason. All three are drawn from closed
 * vocabularies and none of them is derived from a value, which is what lets this record travel to an
 * authenticated caller (see submissionAuthorityRefusalForWire) while the identifier or timestamp
 * that failed stays on the server.
 *
 * It still does not travel on `submission_authority_unavailable`. That marker is still exactly
 * {schema_version, packet_id, reason}, so no client parser sees a KEY it does not already know; the
 * diagnosis reaches its reader through a route of its own instead. The reason itself did gain a
 * member on 2026-09-03 (`unpublishable_attempt_identity`), which is a different kind of change: it
 * moves 162 of one account's 163 markers from a word that describes six unrelated classes to one
 * that describes the class they are actually in, on a field no client in this product reads today
 * and that no client can reach a WORSE conclusion from - a marker is never authority to send, in
 * any spelling.
 */
export type SubmissionAuthorityRejection = {
  branch: 'none' | 'unverified' | 'repair_required' | 'confirmed';
  field: SubmissionAuthorityRejectedField;
  shape: SubmissionAuthorityRejectedShape;
};

/**
 * How this value fails the client's PROJECTION identifier contract, or `ok`.
 *
 * `ok` is true exactly when `projectionUuid` accepts the value, because that predicate is defined
 * in terms of this function. This is the narrower of the client's two rules (versions 1-5) and
 * belongs only to identifiers published INSIDE a projection: `attempt_id`,
 * `canonical_application_id`, `packet_id`. A retry verdict's identifiers are held to
 * `submissionAuthorityRetrySafetyUuidShape` instead.
 */
export function submissionAuthorityUuidShape(value: unknown): FieldShape {
  return uuidShape(value, UUID_VERSION);
}

/**
 * How this value fails the client's RETRY-SAFETY identifier contract, or `ok`.
 *
 * Identical to `submissionAuthorityUuidShape` except on the version nibble, where the deployed
 * client accepts 1-8 rather than 1-5 (submission-state.ts:74 against submission-projection.ts:12).
 * Two functions rather than one parameterised export because the CALLER has to choose, per field,
 * which of the client's two rules that field is actually held to - and a caller that has to name
 * the rule cannot silently inherit the wrong one, which is exactly how `retry_safety.attemptId`
 * came to be judged by the projection's rule.
 *
 * The gap is not theoretical. The identifiers this system mints are opaque 128 bits with uniformly
 * distributed version nibbles (see UUID_LAYOUT above for the live histogram), so versions 6, 7 and
 * 8 are 3/16 of every attempt id - and `safe_not_sent` is the ONLY verdict that can authorise a
 * first employer send, so every one of those refused a resolved packet its envelope for a rule the
 * client does not apply to that field.
 */
export function submissionAuthorityRetrySafetyUuidShape(value: unknown): FieldShape {
  return uuidShape(value, RETRY_SAFETY_UUID_VERSION);
}

function uuidShape(value: unknown, version: RegExp): FieldShape {
  if (value === undefined || value === null) return 'absent';
  if (typeof value !== 'string') return 'not_a_string';
  if (!value.trim()) return 'blank';
  const layout = UUID_LAYOUT.exec(value);
  if (!layout) return 'uuid_malformed';
  if (!version.test(layout[1]!)) return 'uuid_version_unsupported';
  if (!UUID_VARIANT.test(layout[2]!)) return 'uuid_variant_unsupported';
  return 'ok';
}

/**
 * How this value fails the client's strict retry-safety timestamp contract, or `ok`.
 *
 * `timestamp_not_strict_iso` is the one worth reading closely: the value IS a date the client can
 * parse, it simply is not `Date#toISOString()` output (a different fractional precision, a
 * `+00:00` offset instead of `Z`, a space instead of the `T`). Every server-side producer of these
 * strings goes through `Date#toISOString()`, so this class firing would mean a string reached the
 * fold from somewhere that does not - which is a fact, not a guess, once it appears in a log.
 */
export function submissionAuthorityStrictTimestampShape(value: unknown): FieldShape {
  if (value === undefined || value === null) return 'absent';
  if (typeof value !== 'string') return 'not_a_string';
  if (!value.trim()) return 'blank';
  if (!Number.isFinite(Date.parse(value))) return 'timestamp_unparseable';
  if (!STRICT_TIMESTAMP.test(value)) return 'timestamp_not_strict_iso';
  return 'ok';
}

/** How this value fails the looser projection-timestamp contract, or `ok`. */
export function submissionAuthorityProjectionTimestampShape(value: unknown): FieldShape {
  if (value === undefined || value === null) return 'absent';
  if (typeof value !== 'string') return 'not_a_string';
  if (!value.trim()) return 'blank';
  if (!Number.isFinite(Date.parse(value))) return 'timestamp_unparseable';
  if (!PROJECTION_TIMESTAMP.test(value)) return 'timestamp_not_iso';
  return 'ok';
}

/**
 * The first field of `fields` that is not `ok`, named for the branch that was being serialised.
 *
 * The caller lists the fields in the exact order its own refusal predicate evaluates them, so the
 * named field is the one that predicate short-circuited on. Every classifier above is pure over
 * its argument, so evaluating the whole list eagerly cannot differ from the `||` chain it mirrors.
 */
function firstRejection(
  branch: SubmissionAuthorityRejection['branch'],
  fields: ReadonlyArray<readonly [SubmissionAuthorityRejectedField, FieldShape]>,
): SubmissionAuthorityRejection | undefined {
  for (const [field, shape] of fields) {
    if (shape !== 'ok') return { branch, field, shape };
  }
  return undefined;
}

function strictTimestamp(value: unknown): value is string {
  return typeof value === 'string' && submissionAuthorityStrictTimestampShape(value) === 'ok';
}

function projectionTimestamp(value: unknown): value is string {
  return typeof value === 'string' && submissionAuthorityProjectionTimestampShape(value) === 'ok';
}

function projectionUuid(value: unknown): value is string {
  return typeof value === 'string' && submissionAuthorityUuidShape(value) === 'ok';
}

/** The same predicate for an identifier the client reads off a RETRY VERDICT, not a projection. */
function retrySafetyUuid(value: unknown): value is string {
  return typeof value === 'string' && submissionAuthorityRetrySafetyUuidShape(value) === 'ok';
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
  /* `retrySafetyUuid`, not `projectionUuid`. A `none` envelope publishes `projection: {state:'none'}`
   * and nothing else, so this attempt id is read by exactly one client parser -
   * submissionRetrySafetyFromUnknown (submission-state.ts:105), whose SUBMISSION_UUID accepts
   * versions 1-8. Judging it by the PROJECTION rule refused 3/16 of every resolved packet for a
   * nibble no reader of this envelope ever looks at, on the one path that can authorise a first
   * employer send. Measured 2026-09-03: the ledger's identifiers are opaque 128-bit values with
   * uniformly distributed version nibbles, so that fraction is real and not a corner case. */
  const retrySafety = safety?.kind === 'no_evidence'
    ? { kind: 'no_evidence' as const }
    : safety?.kind === 'safe_not_sent'
      && strictTimestamp(safety.resolvedAt)
      && retrySafetyUuid(safety.attemptId)
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
 *  - `unpublishable_attempt_identity`: the packet's own ATTEMPT IDENTIFIER is not a shape the
 *    dashboard's identifier vocabulary can bind. Split out of the residual below on 2026-09-03 for
 *    the reason given under UUID_LAYOUT: the ledger's `attempt_id` is an opaque 128-bit value in a
 *    Postgres `uuid` column, the dashboard reads it as an RFC-4122 identifier, and 162 of this one
 *    account's 163 refusals - every single `unpublishable_projection` on the board - were that one
 *    mismatch on `projection.attempt_id`. It is a REAL refusal and stays one: publishing past the
 *    client's own rule would fail the whole board's collection check rather than one card. But it
 *    has exactly one repair and it is not a repair on the packet, so a reader that cannot tell it
 *    apart from an oversize receipt text has been told a count instead of a cause.
 *  - `unpublishable_projection`: any other shape the client's exact-shape parser would quarantine
 *    (a malformed non-identifier field, a projection bound to another packet, an oversize receipt
 *    text, a non-https final URL).
 *
 * That last member is still a RESIDUAL class. On 2026-09-03 it was carrying 163 of one account's
 * 200 cards - seven checks across four branches, all reported as one word, which is a count and not
 * a cause - and the census that finally read those cards per branch and per field
 * (GET /applications/board/authority-rejections, PR #901) is what let one class be lifted out of it
 * here with a measurement rather than a guess. The vocabulary stays closed because it is a contract;
 * an added member is additive on the wire, and `submission_authority_unavailable` is read by no
 * client in this product today (grepped across rq-counter, role-quick-website and app-repo,
 * 2026-09-03), so a reader that does not know this word cannot be broken by it.
 */
export const SUBMISSION_AUTHORITY_UNAVAILABLE_REASONS = [
  'projection_read_failed',
  'revision_not_canonical',
  'boundary_authorized',
  'unpublishable_receipt_source',
  'inconsistent_retry_evidence',
  'unpublishable_attempt_identity',
  'unpublishable_projection',
] as const;

/**
 * The vocabulary as a value, so "closed" is something a test and a census can both count.
 *
 * Written as the array with the union derived from it rather than the other way round: the union
 * was a bare type for three revisions and the only way to ask how many members it had was to read
 * it, which is how a test named "six reasons" came to assert nothing about the number. A member
 * added here is a member every enumeration sees.
 */
export type SubmissionAuthorityUnavailableReason = typeof SUBMISSION_AUTHORITY_UNAVAILABLE_REASONS[number];

/**
 * The fields whose refusal is a refusal ABOUT THE ATTEMPT'S IDENTITY.
 *
 * Both name the same immutable attempt - the client requires `retry_safety.attemptId` and
 * `projection.attempt_id` to be the same string - so a refusal on either is one fact: this packet's
 * attempt cannot be named to the dashboard. Everything else in the closed field vocabulary is a
 * property of the packet's evidence (a timestamp, a receipt, a binding) and keeps the residual
 * reason, because those are repairable per packet and this is not.
 */
const ATTEMPT_IDENTITY_FIELDS: ReadonlySet<SubmissionAuthorityRejectedField> = new Set([
  'retry_safety.attemptId',
  'projection.attempt_id',
]);

/**
 * Which refusal word a shape rejection belongs under.
 *
 * Deliberately derived from the rejection rather than written at each return site: the seven
 * `unpublishable_projection` sites reach eighteen clauses over twelve fields, and a per-site literal
 * is how a residual class silently reabsorbs a member somebody has just finished separating out.
 */
function reasonForRejection(
  rejected: SubmissionAuthorityRejection,
): SubmissionAuthorityUnavailableReason {
  return ATTEMPT_IDENTITY_FIELDS.has(rejected.field)
    ? 'unpublishable_attempt_identity'
    : 'unpublishable_projection';
}

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

/**
 * A refusal, and - when a field shape is what caused it - which field and which shape.
 *
 * `reason` is unchanged and stays the ONLY thing the board's own marker carries. `rejected` is
 * present exactly when a shape check refused the card, and absent when the reason is already the
 * whole story (`projection_read_failed`, `revision_not_canonical`, `boundary_authorized`,
 * `inconsistent_retry_evidence`). An optional member is right here where it is wrong on the wire
 * marker: a diagnostic reader branching on "did a field fail" is reading the answer, while a client
 * branching on which keys arrived is guessing at authority.
 *
 * WHY THIS IS STILL NOT A NEW REASON, AND STILL NOT A KEY ON THE MARKER. #894 declined to widen the
 * wire because the role-quick-website checkout on this machine carried no reader for
 * `submission_authority` at all. That was the right call on better evidence than it knew: the
 * checkout is a shallow clone whose main tree is effectively its 2026-08-26 clone state, and its
 * BoardCard type (features/applications/infrastructure/applications-api.ts:177) does not even name
 * `run_revision`, a field this backend has been sending for weeks. The readers are on this machine,
 * in a sibling worktree of the same repo, and they were read on 2026-09-03 (rq-counter, branch
 * fix/home-sent-count-survives-a-failed-inventory, 2026-09-02):
 *
 *   - `exactKeys` is applied to the ENVELOPE, its projection and its receipt
 *     (domain/submission-authority-envelope.ts:174) and to nothing else. Neither the card nor the
 *     response root is key-checked, and infrastructure/response-shape.ts:184 spreads unknown
 *     top-level keys straight through;
 *   - a card with no envelope is ABSENT rather than corrupt, and the collection check skips it
 *     (domain/board-submission-authority.ts:29 and :58), so one unpublishable card no longer takes
 *     the whole board down;
 *   - `submission_authority_unavailable` appears ZERO times in that tree. The marker below is read
 *     by nothing.
 *
 * So an additive key on the marker would very likely have been inert too. "Very likely", against a
 * worktree that may not be the deployed commit, is not the standard this contract is held to, and a
 * quarantined card cannot be sent, which is the exact failure being diagnosed.
 *
 * So the rejection reaches its reader by a route that publishes no card at all - see
 * `submissionAuthorityRefusalForWire` and GET /applications/board/authority-rejections. A surface
 * that publishes no card cannot quarantine one, whatever the deployed reader turns out to do.
 */
export type SubmissionAuthorityPublication =
  | { published: true; envelope: PacketSubmissionAuthorityEnvelope }
  | {
    published: false;
    reason: SubmissionAuthorityUnavailableReason;
    rejected?: SubmissionAuthorityRejection;
  };

/** The marker as it goes on the wire. */
export function submissionAuthorityUnavailableMarker(
  packetId: string,
  reason: SubmissionAuthorityUnavailableReason,
): PacketSubmissionAuthorityUnavailable {
  return { schema_version: SUBMISSION_AUTHORITY_SCHEMA_VERSION, packet_id: packetId, reason };
}

/**
 * ONE REFUSED PACKET, as the diagnostic route publishes it.
 *
 * Deliberately NOT part of any card, any envelope or any marker. #894 put the branch, the field and
 * the shape in two server log lines, which was the right first move and turned out to be an
 * unreadable one: Litos runs on Railway, and the person debugging this has no log reader, so the
 * largest send blocker on the account (163 of 200 packets on 2026-09-03) stayed unfalsifiable from
 * every surface she can actually reach. This type is that same record on a surface she can read.
 *
 * A CLASSIFICATION, NEVER A VALUE. `reason`, `branch` and `shape` are closed unions; `field` is
 * closed as of 2026-09-03 (SUBMISSION_AUTHORITY_REJECTED_FIELDS). The identifier, timestamp, URL or
 * receipt text that failed is not carried, not hashed and not truncated into any of them: an
 * attempt id is an internal identifier and stays one, and `uuid_version_unsupported` is the whole of
 * what a reader is told about it. `packet_id` is the caller's own row id, which the caller supplied
 * to get here.
 */
export type SubmissionAuthorityRefusal = {
  packet_id: string;
  reason: SubmissionAuthorityUnavailableReason;
  rejected?: SubmissionAuthorityRejection;
};

/**
 * The refusal for one packet, or `undefined` when the packet published.
 *
 * THE MEMBERSHIP RE-CHECK IS THE POINT. `field` and `shape` are closed unions, so the compiler
 * already refuses an interpolated value at every site in this file. This function refuses one again
 * at run time, because the compiler cannot see a cast, a structuredClone or a caller that builds a
 * rejection from parsed JSON, and a leaked identifier is not a bug you get to fix after it has been
 * served. An unrecognised branch, field or shape drops the whole `rejected` record and keeps the
 * reason, which degrades this route to exactly what #894 already published.
 */
export function submissionAuthorityRefusalForWire(
  packetId: string,
  publication: SubmissionAuthorityPublication,
): SubmissionAuthorityRefusal | undefined {
  if (publication.published) return undefined;
  const rejected = publication.rejected;
  /* Rebuilt key by key rather than spread, for the same reason the dashboard's own seed builder
   * projects a document mark field by field: a spread copies whatever the record happens to hold,
   * and this is the one function standing between an internal identifier and a response body. */
  const classified = rejected !== undefined
    && REJECTION_BRANCHES.has(rejected.branch)
    && REJECTED_FIELDS.has(rejected.field)
    && REJECTED_SHAPES.has(rejected.shape)
    ? { branch: rejected.branch, field: rejected.field, shape: rejected.shape }
    : undefined;
  return {
    packet_id: packetId,
    reason: publication.reason,
    ...(classified ? { rejected: classified } : {}),
  };
}

/** One (reason, branch, field, shape) cell of the refusal census, with the packets it covers. */
export type SubmissionAuthorityRefusalTally = {
  reason: SubmissionAuthorityUnavailableReason;
  branch?: SubmissionAuthorityRejection['branch'];
  field?: SubmissionAuthorityRejectedField;
  shape?: SubmissionAuthorityRejectedShape;
  packets: number;
};

/**
 * The refusals grouped, largest class first.
 *
 * THIS IS THE ANSWER THE COUNT COULD NOT GIVE. "163 packets say `unpublishable_projection`" is a
 * count over seven return sites and eighteen clauses; a ranked (branch, field, shape) table is a
 * list of repairs. It was run for the first time on 2026-09-03 against mehekmandal05@gmail.com and
 * it answered in one request what four sessions of sampling had not: 150 (unverified,
 * projection.attempt_id), 11 (repair_required, projection.attempt_id), 1 (confirmed,
 * projection.attempt_id), 1 boundary_authorized - one field, and none of the classes the residual
 * word was mostly written for. Ordered by packet count and then by the key itself, so two runs over
 * the same data print the same table and a diff between two days is a diff about the packets rather
 * than about map iteration order.
 */
export function submissionAuthorityRefusalTallies(
  refusals: readonly SubmissionAuthorityRefusal[],
): SubmissionAuthorityRefusalTally[] {
  const byKey = new Map<string, SubmissionAuthorityRefusalTally>();
  for (const refusal of refusals) {
    const cell: SubmissionAuthorityRefusalTally = {
      reason: refusal.reason,
      ...(refusal.rejected
        ? { branch: refusal.rejected.branch, field: refusal.rejected.field, shape: refusal.rejected.shape }
        : {}),
      packets: 0,
    };
    const key = [cell.reason, cell.branch ?? '', cell.field ?? '', cell.shape ?? ''].join('|');
    const existing = byKey.get(key);
    if (existing) existing.packets += 1;
    else byKey.set(key, { ...cell, packets: 1 });
  }
  return [...byKey.entries()]
    .sort(([leftKey, left], [rightKey, right]) => (
      right.packets - left.packets || (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)
    ))
    .map(([, tally]) => tally);
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
 *  - an attempt whose IDENTIFIER the client's identifier vocabulary cannot bind - see
 *    `unpublishable_attempt_identity`, which is 162 of the 163 refusals measured on one account on
 *    2026-09-03 and every one of them on `projection.attempt_id`;
 *  - a non-canonical revision, for the same reason as the unattempted builder.
 *
 * The caller publishes the reason as a per-card marker. Failing closed is right, but it is right
 * PER CARD: one unpublishable card is one card that cannot be sent, never a whole board the reader
 * has to refuse. And it is right in this DIRECTION: an envelope the client cannot parse is not a
 * worse card, it is a worse BOARD, because boardSubmissionAuthorityCollectionIsComplete rejects the
 * whole payload for one unparseable envelope while skipping every card that carries none. So no
 * check here is ever widened past the client's own rule to unblock a packet - only onto it, where
 * this file had been narrower than the client for a field (see RETRY_SAFETY_UUID_VERSION).
 */
export function submissionAuthorityPublicationForPacket(input: {
  packetId: string;
  projection: AuthoritativeSubmissionProjection | undefined;
  retrySafety: SubmissionAttemptRetrySafety | undefined;
  revision: string | undefined;
}): SubmissionAuthorityPublication {
  const { packetId, projection, retrySafety, revision } = input;
  /* The refusal, and beside it the shape check that caused it where there was one. Every shape
   * refusal below passes a rejection, because the reason word alone is a residual class - "any
   * other shape the client's exact-shape parser would quarantine" - and a residual class with 163
   * members on one account (2026-09-03) is exactly the case where the word cannot be acted on. The
   * word for a shape refusal is now DERIVED from that rejection by `reasonForRejection` rather than
   * written per site, so the one class the census actually found (`projection.attempt_id`, 162 of
   * the 163) reports as itself wherever it fires and cannot drift back into the residual at a site
   * somebody adds later. The rejection never reaches the wire; see SubmissionAuthorityPublication. */
  const unavailable = (
    reason: SubmissionAuthorityUnavailableReason,
    rejected?: SubmissionAuthorityRejection,
  ): SubmissionAuthorityPublication => ({ published: false, reason, ...(rejected ? { rejected } : {}) });
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
      /* Identical predicate to the one it replaces - a rejection exists exactly when the verdict is
       * `safe_not_sent` and one of its two fields is malformed - only now it says WHICH. This is
       * the branch the 2026-09-03 census was first read as, and it is measurably not the whole
       * story: a `safe_not_sent` resolved through the dashboard the same morning published here
       * without complaint (DSI Innovations, packet a34e5ce2). */
      const rejected = retrySafety.kind === 'safe_not_sent'
        ? firstRejection('none', [
          ['retry_safety.attemptId', submissionAuthorityRetrySafetyUuidShape(retrySafety.attemptId)],
          ['retry_safety.resolvedAt', submissionAuthorityStrictTimestampShape(retrySafety.resolvedAt)],
        ])
        : undefined;
      return rejected
        ? unavailable(reasonForRejection(rejected), rejected)
        : unavailable('revision_not_canonical');
    }
    // A block beside an empty projection is the two reads disagreeing, not a state to render.
    return unavailable('inconsistent_retry_evidence');
  }

  if (projection.state === 'unverified') {
    if (projection.reason === 'boundary_authorized') return unavailable('boundary_authorized');
    const rejected = firstRejection('unverified', [
      ['projection.attempt_id', submissionAuthorityUuidShape(projection.attemptId)],
      ['projection.observed_at', submissionAuthorityStrictTimestampShape(projection.observedAt)],
    ]);
    /* THE LIVE CAUSE, 2026-09-03. 150 of this account's 163 refusals land on this exact line, all of
     * them on `projection.attempt_id` (104 version, 46 variant) - a held attempt whose identifier
     * the dashboard cannot name. The refusal is correct: the envelope would publish that identifier
     * into `projection.attempt_id` AND `retry_safety.attemptId`, and the projection parser holds it
     * to versions 1-5, so an envelope emitted past this line would fail to parse and take the whole
     * board's collection check down with it. What was wrong was the WORD: it reported as the same
     * residual class as an oversize receipt text, so a card whose only defect is an unnameable
     * internal id showed the applicant a red "verify the exact prior submission evidence" banner
     * with no control that could ever clear it, and the census could not tell the two apart. */
    if (rejected) return unavailable(reasonForRejection(rejected), rejected);
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
    if (projection.reasons.length === 0) {
      return unavailable('unpublishable_projection', {
        branch: 'repair_required',
        field: 'projection.reasons',
        shape: 'empty_list',
      });
    }
    // A repair projection bound to a different packet cannot be published under this card.
    if (typeof projection.packetId === 'string' && projection.packetId !== packetId) {
      return unavailable('unpublishable_projection', {
        branch: 'repair_required',
        field: 'projection.packet_id',
        shape: 'bound_to_other_packet',
      });
    }
    /* Both ids are optional on a repair projection, so an absent one is not a defect and only a
     * PRESENT malformed one refuses the card. Hence the undefined guard outside firstRejection
     * rather than an `absent` class inside it. */
    const rejectedIds = firstRejection('repair_required', [
      ...(projection.attemptId !== undefined
        ? [['projection.attempt_id', submissionAuthorityUuidShape(projection.attemptId)] as const]
        : []),
      ...(projection.canonicalApplicationId !== undefined
        ? [[
          'projection.canonical_application_id',
          submissionAuthorityUuidShape(projection.canonicalApplicationId),
        ] as const]
        : []),
    ]);
    if (rejectedIds) return unavailable(reasonForRejection(rejectedIds), rejectedIds);
    // The client rejects `no_evidence` and `safe_not_sent` beside a repair projection, and a block
    // that names a different attempt than the projection. `null` is the honest verdict there: the
    // projection alone already routes the card to review.
    /* Retry-safety identifiers again, so a version-6-to-8 attempt id or lease id no longer silently
     * downgrades this card's retry verdict to `null`. The cost here was information rather than
     * publication - a repair projection publishes either way - but it is the same divergence, and a
     * reader who cannot see the block cannot see WHY the card is in repair. When the projection
     * carries its own attempt id the equality above still binds the two, so the projection's own
     * (narrower) rule has already been applied to that identifier by the caller below. */
    const consistentBlock = (retrySafety.kind === 'blocked_unverified' || retrySafety.kind === 'blocked_confirmed')
      && (projection.attemptId === undefined || retrySafety.attemptId === projection.attemptId)
      && retrySafetyUuid(retrySafety.attemptId)
      && (retrySafety.kind === 'blocked_unverified'
        ? strictTimestamp(retrySafety.at) && (retrySafety.reason !== 'boundary_authorized'
          || (retrySafetyUuid(retrySafety.leaseId) && strictTimestamp(retrySafety.expiresAt)))
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
    // Which of the two it was, since a genuine send refused for its ATTEMPT source is a different
    // repair from one refused for its RECEIPT source, and the reason word covers both.
    return unavailable('unpublishable_receipt_source', firstRejection('confirmed', [
      ['projection.source', CONFIRMED_SOURCES.has(projection.source) ? 'ok' : 'outside_client_vocabulary'],
      ['receipt.source', 'outside_client_vocabulary'],
    ]));
  }
  /* The packet binding stays its own statement rather than joining the list below, because the
   * equality is also what narrows `projection.packetId` from `string | null` to the `string` the
   * published projection needs. A check inside an array literal proves the same thing to a reader
   * and nothing to the compiler. */
  if (projection.packetId !== packetId) {
    return unavailable('unpublishable_projection', {
      branch: 'confirmed',
      field: 'projection.packet_id',
      shape: 'bound_to_other_packet',
    });
  }
  /* The remaining nine clauses the `||` chain used to run as one anonymous verdict, in the same
   * order, each now able to name itself. Every classifier is pure over its argument, so listing
   * them eagerly answers exactly what short-circuiting them answered: `submitted_at` after
   * `captured_at` still cannot fire on an unparseable `submitted_at`, because Date.parse gives NaN
   * there and NaN is greater than nothing. */
  const rejectedConfirmed = firstRejection('confirmed', [
    ['projection.attempt_id', submissionAuthorityUuidShape(projection.attemptId)],
    ['projection.canonical_application_id', submissionAuthorityUuidShape(projection.canonicalApplicationId)],
    [
      'projection.tracker_stage',
      CONFIRMED_TRACKER_STAGES.has(projection.trackerStage) ? 'ok' : 'outside_client_vocabulary',
    ],
    ['projection.submitted_at', submissionAuthorityProjectionTimestampShape(projection.submittedAt)],
    ['receipt.captured_at', submissionAuthorityStrictTimestampShape(receipt.capturedAt)],
    [
      'projection.submitted_at',
      Date.parse(projection.submittedAt) > Date.parse(receipt.capturedAt) ? 'out_of_order' : 'ok',
    ],
    ['receipt.confirmation_text', receipt.confirmationText.trim() ? 'ok' : 'blank'],
    [
      'receipt.confirmation_text',
      Buffer.byteLength(receipt.confirmationText, 'utf8') > 2000 ? 'oversize' : 'ok',
    ],
    ['receipt.final_url', safeHttpsUrl(receipt.finalUrl) ? 'ok' : 'not_https_url'],
  ]);
  if (rejectedConfirmed) return unavailable(reasonForRejection(rejectedConfirmed), rejectedConfirmed);
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
