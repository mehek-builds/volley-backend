import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalSubmissionAuthorityRevision,
  submissionAuthorityEnvelopeForPacket,
  submissionAuthorityEnvelopeForUnattemptedPacket,
  submissionAuthorityProjectionTimestampShape,
  submissionAuthorityPublicationForPacket,
  submissionAuthorityRetrySafetyUuidShape,
  submissionAuthorityStrictTimestampShape,
  submissionAuthorityUnavailableMarker,
  submissionAuthorityUuidShape,
} from './submissionAuthorityEnvelope';
import type { AuthoritativeSubmissionProjection } from './authoritativeSubmissionProjection';

const PACKET = 'c2c6c00a-71e0-4923-bbc2-123322c6d014';
const OTHER_PACKET = '0cf0dcee-b030-4dd8-aaf4-84df811da7c3';
const ATTEMPT = 'a3578398-c4cc-414d-9a44-c7943d8effb9';
const OTHER_ATTEMPT = '5e377281-7991-4c40-b4c7-10a85cc591ef';
const CANONICAL = 'c9ea060c-ec99-469a-8d19-4eabac66bd89';
const CAPTURED_AT = '2026-08-28T08:02:00.000Z';

const confirmedProjection: AuthoritativeSubmissionProjection = {
  state: 'confirmed',
  attemptId: ATTEMPT,
  canonicalApplicationId: CANONICAL,
  packetId: PACKET,
  submittedAt: '2026-08-28T08:00:00.000Z',
  receipt: {
    confirmationText: 'Thank you for applying.',
    finalUrl: 'https://job-boards.greenhouse.io/example/jobs/1/application_confirmation',
    capturedAt: CAPTURED_AT,
    source: 'managed_browser',
  },
  source: 'managed_browser',
  trackerStage: 'applied',
};

describe('canonicalSubmissionAuthorityRevision', () => {
  it('accepts exactly what the dashboard accepts', () => {
    for (const ok of ['0', '1', '42', '9223372036854775807']) {
      assert.equal(canonicalSubmissionAuthorityRevision(ok), true, ok);
    }
    for (const bad of ['', '00', '01', '+1', '1.0', ' 1', '-1', 'abc', '9223372036854775808', '10000000000000000000', 1, undefined]) {
      assert.equal(canonicalSubmissionAuthorityRevision(bad), false, JSON.stringify(bad));
    }
  });
});

describe('submissionAuthorityEnvelopeForPacket', () => {
  it('emits the unattempted builder envelope, byte for byte, for none + no_evidence', () => {
    const expected = submissionAuthorityEnvelopeForUnattemptedPacket({
      packetId: PACKET,
      projectionState: 'none',
      retrySafety: { kind: 'no_evidence' },
      revision: '3',
    });
    assert.ok(expected);
    assert.deepEqual(
      submissionAuthorityEnvelopeForPacket({
        packetId: PACKET,
        projection: { state: 'none' },
        retrySafety: { kind: 'no_evidence' },
        revision: '3',
      }),
      expected,
    );
  });

  it('emits the unattempted builder envelope, byte for byte, for none + safe_not_sent too', () => {
    /* The board and the per-packet submission response must publish ONE shape for a packet whose
     * attempt was proven never to reach the employer. They did not: the board published
     * safe_not_sent while the builder refused it, so /applications/:id/submission carried no
     * envelope and the dashboard's send gate refused a packet the ledger had just proven un-sent
     * (The Maven Group, crelate, 2026-09-02, the first packet healed by PR #861). */
    const safety = {
      kind: 'safe_not_sent' as const,
      attemptId: ATTEMPT,
      proofKind: 'typed_pre_click_stop' as const,
      resolvedAt: '2026-08-28T08:00:00.000Z',
    };
    const expected = submissionAuthorityEnvelopeForUnattemptedPacket({
      packetId: PACKET,
      projectionState: 'none',
      retrySafety: safety,
      revision: '3',
    });
    assert.ok(expected, 'a proven not-sent attempt is provably safe and gets the first-send envelope');
    assert.deepEqual(expected.retry_safety, safety);
    assert.deepEqual(
      submissionAuthorityEnvelopeForPacket({
        packetId: PACKET,
        projection: { state: 'none' },
        retrySafety: safety,
        revision: '3',
      }),
      expected,
    );
    // A malformed resolvedAt is refused at the builder rather than emitted for the client to reject.
    assert.equal(
      submissionAuthorityEnvelopeForUnattemptedPacket({
        packetId: PACKET,
        projectionState: 'none',
        retrySafety: { ...safety, resolvedAt: 'yesterday' },
        revision: '3',
      }),
      undefined,
    );
  });

  it('publishes a proven not-sent attempt under a none projection', () => {
    assert.deepEqual(
      submissionAuthorityEnvelopeForPacket({
        packetId: PACKET,
        projection: { state: 'none' },
        retrySafety: {
          kind: 'safe_not_sent',
          attemptId: ATTEMPT,
          proofKind: 'typed_pre_click_stop',
          resolvedAt: '2026-08-28T08:00:00.000Z',
        },
        revision: '3',
      }),
      {
        schema_version: 'submission-authority-v1',
        revision: '3',
        state: 'none',
        application_id: PACKET,
        packet_id: PACKET,
        projection: { state: 'none' },
        retry_safety: {
          kind: 'safe_not_sent',
          attemptId: ATTEMPT,
          proofKind: 'typed_pre_click_stop',
          resolvedAt: '2026-08-28T08:00:00.000Z',
        },
      },
    );
  });

  it('refuses a none projection beside blocking retry evidence', () => {
    assert.equal(submissionAuthorityEnvelopeForPacket({
      packetId: PACKET,
      projection: { state: 'none' },
      retrySafety: { kind: 'blocked_unverified', attemptId: ATTEMPT, at: CAPTURED_AT, reason: 'pressed' },
      revision: '3',
    }), undefined);
  });

  it('serialises a confirmed projection to the exact snake_case wire shape', () => {
    assert.deepEqual(
      submissionAuthorityEnvelopeForPacket({
        packetId: PACKET,
        projection: confirmedProjection,
        retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
        revision: '7',
      }),
      {
        schema_version: 'submission-authority-v1',
        revision: '7',
        state: 'confirmed',
        application_id: PACKET,
        packet_id: PACKET,
        projection: {
          state: 'confirmed',
          attempt_id: ATTEMPT,
          canonical_application_id: CANONICAL,
          packet_id: PACKET,
          submitted_at: '2026-08-28T08:00:00.000Z',
          receipt: {
            confirmation_text: 'Thank you for applying.',
            final_url: 'https://job-boards.greenhouse.io/example/jobs/1/application_confirmation',
            captured_at: CAPTURED_AT,
            source: 'managed_browser',
          },
          source: 'managed_browser',
          tracker_stage: 'applied',
        },
        retry_safety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      },
    );
  });

  it('writes the confirmed retry verdict from the projection, not from an earlier attempt', () => {
    // The packet fold names the EARLIEST confirmed attempt; the classifier may settle on another.
    // The client rejects the pair unless they agree, so the envelope follows the projection.
    const envelope = submissionAuthorityEnvelopeForPacket({
      packetId: PACKET,
      projection: confirmedProjection,
      retrySafety: { kind: 'blocked_confirmed', attemptId: OTHER_ATTEMPT, confirmedAt: '2026-08-27T08:02:00.000Z' },
      revision: '7',
    });
    assert.deepEqual(envelope?.retry_safety, {
      kind: 'blocked_confirmed',
      attemptId: ATTEMPT,
      confirmedAt: CAPTURED_AT,
    });
  });

  it('refuses confirmed projections the dashboard vocabulary cannot carry', () => {
    const cases: Array<[string, AuthoritativeSubmissionProjection]> = [
      ['unsupported_email source', { ...confirmedProjection, source: 'unsupported_email' }],
      ['email_fallback receipt', {
        ...confirmedProjection,
        receipt: { ...confirmedProjection.receipt, source: 'email_fallback' },
      }],
      ['attended receipt retained on a managed opening', {
        ...confirmedProjection,
        receipt: { ...confirmedProjection.receipt, source: 'attended_handoff' },
      }],
      ['bound to another packet', { ...confirmedProjection, packetId: OTHER_PACKET }],
      ['bound to no packet', { ...confirmedProjection, packetId: null }],
      ['http final url', {
        ...confirmedProjection,
        receipt: { ...confirmedProjection.receipt, finalUrl: 'http://example.test/done' },
      }],
      ['receipt text over 2000 bytes', {
        ...confirmedProjection,
        receipt: { ...confirmedProjection.receipt, confirmationText: 'x'.repeat(2001) },
      }],
      ['submitted after capture', { ...confirmedProjection, submittedAt: '2026-08-28T09:00:00.000Z' }],
      ['non-millisecond capture', {
        ...confirmedProjection,
        receipt: { ...confirmedProjection.receipt, capturedAt: '2026-08-28T08:02:00Z' },
      }],
      ['unknown tracker stage', { ...confirmedProjection, trackerStage: 'saved' }],
    ];
    for (const [label, projection] of cases) {
      assert.equal(submissionAuthorityEnvelopeForPacket({
        packetId: PACKET,
        projection,
        retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
        revision: '7',
      }), undefined, label);
    }
  });

  it('allows a legacy backfill confirmation without a receipt source', () => {
    const envelope = submissionAuthorityEnvelopeForPacket({
      packetId: PACKET,
      projection: {
        ...confirmedProjection,
        source: 'legacy_backfill',
        receipt: { ...confirmedProjection.receipt, source: undefined },
      },
      retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      revision: '7',
    });
    assert.equal(envelope?.state, 'confirmed');
    assert.equal(envelope && 'source' in envelope.projection && 'receipt' in envelope.projection
      ? 'source' in envelope.projection.receipt
      : null, false);
  });

  it('serialises a held attempt with the retry verdict written from its own observation', () => {
    assert.deepEqual(
      submissionAuthorityEnvelopeForPacket({
        packetId: PACKET,
        projection: { state: 'unverified', attemptId: ATTEMPT, observedAt: CAPTURED_AT, reason: 'pressed' },
        // The fold names an earlier open attempt on the same packet; the client requires the
        // verdict to describe the projection's attempt.
        retrySafety: { kind: 'blocked_unverified', attemptId: OTHER_ATTEMPT, at: '2026-08-27T08:02:00.000Z', reason: 'opened' },
        revision: '3',
      }),
      {
        schema_version: 'submission-authority-v1',
        revision: '3',
        state: 'unverified',
        application_id: PACKET,
        packet_id: PACKET,
        projection: { state: 'unverified', attempt_id: ATTEMPT, observed_at: CAPTURED_AT, reason: 'pressed' },
        retry_safety: { kind: 'blocked_unverified', attemptId: ATTEMPT, at: CAPTURED_AT, reason: 'pressed' },
      },
    );
  });

  it('emits nothing for a boundary-authorized hold, which only the handoff envelope can carry', () => {
    assert.equal(submissionAuthorityEnvelopeForPacket({
      packetId: PACKET,
      projection: { state: 'unverified', attemptId: ATTEMPT, observedAt: CAPTURED_AT, reason: 'boundary_authorized' },
      retrySafety: {
        kind: 'blocked_unverified',
        attemptId: ATTEMPT,
        at: CAPTURED_AT,
        reason: 'boundary_authorized',
        leaseId: OTHER_ATTEMPT,
        expiresAt: '2026-08-28T09:02:00.000Z',
      },
      revision: '3',
    }), undefined);
  });

  it('serialises a legacy sent packet as repair_required with a null retry verdict', () => {
    // A packet marked submitted with no ledger event: the fold says no_evidence, which the client
    // refuses beside a repair projection, so the verdict is null.
    assert.deepEqual(
      submissionAuthorityEnvelopeForPacket({
        packetId: PACKET,
        projection: { state: 'repair_required', packetId: PACKET, reasons: ['mutable_sent_without_confirmation'] },
        retrySafety: { kind: 'no_evidence' },
        revision: '3',
      }),
      {
        schema_version: 'submission-authority-v1',
        revision: '3',
        state: 'repair_required',
        application_id: PACKET,
        packet_id: PACKET,
        projection: { state: 'repair_required', reasons: ['mutable_sent_without_confirmation'], packet_id: PACKET },
        retry_safety: null,
      },
    );
  });

  it('keeps a consistent block beside a repair projection and drops an inconsistent one', () => {
    const consistent = submissionAuthorityEnvelopeForPacket({
      packetId: PACKET,
      projection: {
        state: 'repair_required',
        attemptId: ATTEMPT,
        canonicalApplicationId: CANONICAL,
        packetId: PACKET,
        reasons: ['receipt_incomplete'],
      },
      retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      revision: '3',
    });
    assert.deepEqual(consistent?.projection, {
      state: 'repair_required',
      reasons: ['receipt_incomplete'],
      attempt_id: ATTEMPT,
      canonical_application_id: CANONICAL,
      packet_id: PACKET,
    });
    assert.deepEqual(consistent?.retry_safety, { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT });

    const inconsistent = submissionAuthorityEnvelopeForPacket({
      packetId: PACKET,
      projection: { state: 'repair_required', attemptId: ATTEMPT, packetId: PACKET, reasons: ['receipt_incomplete'] },
      retrySafety: { kind: 'blocked_confirmed', attemptId: OTHER_ATTEMPT, confirmedAt: CAPTURED_AT },
      revision: '3',
    });
    assert.equal(inconsistent?.retry_safety, null);
  });

  it('omits a null packet binding on a repair projection and refuses a foreign one', () => {
    const unbound = submissionAuthorityEnvelopeForPacket({
      packetId: PACKET,
      projection: { state: 'repair_required', packetId: null, reasons: ['packet_missing'] },
      retrySafety: { kind: 'no_evidence' },
      revision: '3',
    });
    assert.deepEqual(unbound?.projection, { state: 'repair_required', reasons: ['packet_missing'] });
    assert.equal(submissionAuthorityEnvelopeForPacket({
      packetId: PACKET,
      projection: { state: 'repair_required', packetId: OTHER_PACKET, reasons: ['packet_missing'] },
      retrySafety: { kind: 'no_evidence' },
      revision: '3',
    }), undefined);
  });

  it('emits nothing without a projection, a retry verdict, or a canonical revision', () => {
    assert.equal(submissionAuthorityEnvelopeForPacket({
      packetId: PACKET, projection: undefined, retrySafety: { kind: 'no_evidence' }, revision: '3',
    }), undefined);
    assert.equal(submissionAuthorityEnvelopeForPacket({
      packetId: PACKET, projection: { state: 'none' }, retrySafety: undefined, revision: '3',
    }), undefined);
    for (const revision of [undefined, '', '01', 'abc', '99999999999999999999']) {
      assert.equal(submissionAuthorityEnvelopeForPacket({
        packetId: PACKET, projection: confirmedProjection,
        retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
        revision,
      }), undefined, JSON.stringify(revision));
    }
  });
});

describe('submissionAuthorityPublicationForPacket', () => {
  function reason(input: Parameters<typeof submissionAuthorityPublicationForPacket>[0]) {
    const publication = submissionAuthorityPublicationForPacket(input);
    return publication.published ? null : publication.reason;
  }

  it('names why a packet is unpublishable instead of only refusing', () => {
    // The mainline managed hold: authorized, not yet pressed. The client can only carry this as a
    // boundary envelope with the lease and capability digests, which no passive surface holds.
    assert.equal(reason({
      packetId: PACKET,
      projection: { state: 'unverified', attemptId: ATTEMPT, observedAt: CAPTURED_AT, reason: 'boundary_authorized' },
      retrySafety: {
        kind: 'blocked_unverified',
        attemptId: ATTEMPT,
        at: CAPTURED_AT,
        reason: 'boundary_authorized',
        leaseId: OTHER_ATTEMPT,
        expiresAt: CAPTURED_AT,
      },
      revision: '3',
    }), 'boundary_authorized');

    // The unsupported-portal email channel: a real send in a vocabulary the client does not have.
    assert.equal(reason({
      packetId: PACKET,
      projection: {
        ...confirmedProjection,
        source: 'unsupported_email',
        receipt: { ...confirmedProjection.receipt, source: 'email_fallback' },
      } as AuthoritativeSubmissionProjection,
      retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      revision: '3',
    }), 'unpublishable_receipt_source');

    // An attended receipt retained on a managed opening.
    assert.equal(reason({
      packetId: PACKET,
      projection: {
        ...confirmedProjection,
        receipt: { ...confirmedProjection.receipt, source: 'attended_handoff' },
      } as AuthoritativeSubmissionProjection,
      retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      revision: '3',
    }), 'unpublishable_receipt_source');

    assert.equal(reason({
      packetId: PACKET,
      projection: undefined,
      retrySafety: { kind: 'no_evidence' },
      revision: '3',
    }), 'projection_read_failed');
    assert.equal(reason({
      packetId: PACKET,
      projection: { state: 'none' },
      retrySafety: { kind: 'no_evidence' },
      revision: '03',
    }), 'revision_not_canonical');
    assert.equal(reason({
      packetId: PACKET,
      projection: { state: 'none' },
      retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      revision: '3',
    }), 'inconsistent_retry_evidence');
    assert.equal(reason({
      packetId: PACKET,
      projection: { state: 'repair_required', packetId: OTHER_PACKET, reasons: ['packet_missing'] },
      retrySafety: { kind: 'no_evidence' },
      revision: '3',
    }), 'unpublishable_projection');
    assert.equal(reason({
      packetId: PACKET,
      projection: {
        ...confirmedProjection,
        receipt: { ...confirmedProjection.receipt, finalUrl: 'http://example.com/receipt' },
      } as AuthoritativeSubmissionProjection,
      retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      revision: '3',
    }), 'unpublishable_projection');
  });

  it('publishes the same envelope the envelope-only builder returns', () => {
    const input = {
      packetId: PACKET,
      projection: confirmedProjection,
      retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT } as const,
      revision: '3',
    };
    const publication = submissionAuthorityPublicationForPacket(input);
    assert.equal(publication.published, true);
    assert.deepEqual(
      publication.published ? publication.envelope : null,
      submissionAuthorityEnvelopeForPacket(input),
    );
  });

  it('marks a card with three stable keys and no invented revision', () => {
    assert.deepEqual(submissionAuthorityUnavailableMarker(PACKET, 'boundary_authorized'), {
      schema_version: 'submission-authority-v1',
      packet_id: PACKET,
      reason: 'boundary_authorized',
    });
  });
});

/* THE SHAPE CLASSIFIERS, AND THE PREDICATES THEY DEFINE.
 *
 * The builders refuse a field the client would quarantine and never say which field or why: the
 * value is withheld from the wire on purpose, so a refusal is unfalsifiable from any client call.
 * Measured 2026-09-03 on mehekmandal05@gmail.com, `GET /applications/board?limit=500` returned 163
 * of 200 cards as `unpublishable_projection`, a reason SEVEN checks across FOUR branches can
 * produce. These classifiers are what lets a refusal name itself, so the tests below pin two
 * things: the classification of each failing shape, and that `ok` still means exactly what the
 * client's own regexes accept - a classifier that drifted from the predicate would put a field the
 * client rejects back on the wire, which is the failure this whole file exists to prevent. */
const CLIENT_PROJECTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_STRICT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CLIENT_PROJECTION_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
/* The client's OTHER identifier regex, the one this file did not know it had until 2026-09-03:
 * features/applications/domain/submission-state.ts:74 holds every retry-verdict identifier to
 * versions 1-8, while submission-projection.ts:12 holds every projection identifier to 1-5. Both
 * share the variant nibble. Two constants because the two rules disagree on exactly one character,
 * and a test that used one shape for both fields could not have caught this file using one rule for
 * both fields. */
const CLIENT_RETRY_SAFETY_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const V7_ATTEMPT = 'a3578398-c4cc-714d-9a44-c7943d8effb9';
const BAD_VARIANT_ATTEMPT = 'a3578398-c4cc-414d-ca44-c7943d8effb9';

describe('submissionAuthorityUuidShape', () => {
  it('classifies each way an identifier can fail the client contract', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [ATTEMPT, 'ok'],
      ['A3578398-C4CC-414D-9A44-C7943D8EFFB9', 'ok'],
      [undefined, 'absent'],
      [null, 'absent'],
      [42, 'not_a_string'],
      ['', 'blank'],
      ['   ', 'blank'],
      ['not-a-uuid', 'uuid_malformed'],
      ['a3578398c4cc414d9a44c7943d8effb9', 'uuid_malformed'],
      ['a3578398-c4cc-414d-9a44-c7943d8effb', 'uuid_malformed'],
      ['a3578398-c4cc-414d-9a44-c7943d8effb9 ', 'uuid_malformed'],
      /* The version nibble, which is where this repo already disagrees with itself: the ledger's
       * own UUID_PATTERN (lib/submissionAttemptLedger.ts:169), duplicateApplication.ts:469,
       * postingIdentityDistinction.ts:23 and canonicalFreeDocumentBinding.ts:33 all accept 1-8,
       * while the client contract serialised here accepts 1-5. Whether any live identifier sits in
       * that gap is NOT established - this class is how one deploy answers it. */
      ['a3578398-c4cc-014d-9a44-c7943d8effb9', 'uuid_version_unsupported'],
      ['a3578398-c4cc-614d-9a44-c7943d8effb9', 'uuid_version_unsupported'],
      [V7_ATTEMPT, 'uuid_version_unsupported'],
      ['a3578398-c4cc-814d-9a44-c7943d8effb9', 'uuid_version_unsupported'],
      ['a3578398-c4cc-f14d-9a44-c7943d8effb9', 'uuid_version_unsupported'],
      ['a3578398-c4cc-414d-1a44-c7943d8effb9', 'uuid_variant_unsupported'],
      ['a3578398-c4cc-414d-ca44-c7943d8effb9', 'uuid_variant_unsupported'],
    ];
    for (const [value, expected] of cases) {
      assert.equal(submissionAuthorityUuidShape(value), expected, JSON.stringify(value));
    }
  });

  it('answers ok for exactly the strings the client regex accepts', () => {
    const values = [
      ATTEMPT, OTHER_ATTEMPT, PACKET, CANONICAL, V7_ATTEMPT,
      'A3578398-C4CC-414D-9A44-C7943D8EFFB9',
      'a3578398-c4cc-114d-8a44-c7943d8effb9',
      'a3578398-c4cc-514d-ba44-c7943d8effb9',
      'a3578398-c4cc-014d-9a44-c7943d8effb9',
      'a3578398-c4cc-814d-9a44-c7943d8effb9',
      'a3578398-c4cc-414d-1a44-c7943d8effb9',
      'a3578398c4cc414d9a44c7943d8effb9',
      'not-a-uuid', '', '   ',
    ];
    for (const value of values) {
      assert.equal(
        submissionAuthorityUuidShape(value) === 'ok',
        CLIENT_PROJECTION_UUID.test(value),
        value,
      );
    }
  });
});

describe('submissionAuthorityRetrySafetyUuidShape', () => {
  /* THE DEFECT THIS FILE ENFORCED FOR THREE REVISIONS, 2026-09-03.
   *
   * The deployed dashboard has two identifier rules, not one, and they differ on the version nibble
   * alone: submission-projection.ts:12 accepts 1-5 for `projection.attempt_id`,
   * `projection.canonical_application_id` and `projection.packet_id`; submission-state.ts:74 accepts
   * 1-8 for `retry_safety.attemptId` and `retry_safety.leaseId`. This file applied the projection's
   * rule to both, so a retry verdict naming an attempt whose version nibble is 6, 7 or 8 was refused
   * here and would have been accepted there.
   *
   * That is not a corner: the ledger's `attempt_id` is a Postgres `uuid` column holding an opaque
   * 128 bits, appendSubmissionAttemptEvent never version-checks it, and the nine identifiers that
   * published on mehekmandal05@gmail.com on 2026-09-03 carry version nibbles 1, 1, 1, 3, 4, 4, 4, 4
   * and 5 - a distribution no RFC-4122 generator produces. So versions 6-8 are ~3/16 of every
   * attempt id, and `safe_not_sent` is the only verdict that can authorise a first employer send. */
  it('accepts exactly the identifiers the client accepts on a retry verdict', () => {
    const values = [
      ATTEMPT, OTHER_ATTEMPT, PACKET, CANONICAL, V7_ATTEMPT, BAD_VARIANT_ATTEMPT,
      'A3578398-C4CC-414D-9A44-C7943D8EFFB9',
      'a3578398-c4cc-114d-8a44-c7943d8effb9',
      'a3578398-c4cc-514d-ba44-c7943d8effb9',
      'a3578398-c4cc-614d-9a44-c7943d8effb9',
      'a3578398-c4cc-814d-9a44-c7943d8effb9',
      'a3578398-c4cc-014d-9a44-c7943d8effb9',
      'a3578398-c4cc-914d-9a44-c7943d8effb9',
      'a3578398-c4cc-f14d-9a44-c7943d8effb9',
      'a3578398c4cc414d9a44c7943d8effb9',
      'not-a-uuid', '', '   ',
    ];
    for (const value of values) {
      assert.equal(
        submissionAuthorityRetrySafetyUuidShape(value) === 'ok',
        CLIENT_RETRY_SAFETY_UUID.test(value),
        value,
      );
    }
  });

  it('differs from the projection rule on the version nibble and nowhere else', () => {
    /* The two rules are one character apart, and the test says so exhaustively rather than by
     * example: every version nibble against every variant nibble, over both classifiers. A future
     * edit that widens the projection rule "to match" - the repair this file explicitly must NOT
     * make, because publishing past submission-projection.ts fails the board's whole collection
     * check rather than one card - fails here. */
    for (const version of '0123456789abcdef') {
      for (const variant of '0123456789abcdef') {
        const value = `a3578398-c4cc-${version}14d-${variant}a44-c7943d8effb9`;
        const projection = submissionAuthorityUuidShape(value);
        const retry = submissionAuthorityRetrySafetyUuidShape(value);
        assert.equal(projection === 'ok', /[1-5]/.test(version) && /[89ab]/.test(variant), value);
        assert.equal(retry === 'ok', /[1-8]/.test(version) && /[89ab]/.test(variant), value);
        // Same classification everywhere the two agree, so only the one nibble ever diverges.
        if (!'678'.includes(version)) assert.equal(projection, retry, value);
      }
    }
    // And the divergence is exactly versions 6, 7 and 8, which is 3/16 of a uniform identifier.
    for (const version of '678') {
      const value = `a3578398-c4cc-${version}14d-9a44-c7943d8effb9`;
      assert.equal(submissionAuthorityUuidShape(value), 'uuid_version_unsupported', value);
      assert.equal(submissionAuthorityRetrySafetyUuidShape(value), 'ok', value);
    }
  });

  it('still refuses everything the layout and variant rules refuse', () => {
    // Widening the version nibble widened nothing else. These are the classes both rules share.
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [undefined, 'absent'],
      [null, 'absent'],
      [42, 'not_a_string'],
      ['', 'blank'],
      ['   ', 'blank'],
      ['not-a-uuid', 'uuid_malformed'],
      ['a3578398c4cc414d9a44c7943d8effb9', 'uuid_malformed'],
      ['a3578398-c4cc-714d-9a44-c7943d8effb9 ', 'uuid_malformed'],
      ['a3578398-c4cc-014d-9a44-c7943d8effb9', 'uuid_version_unsupported'],
      ['a3578398-c4cc-914d-9a44-c7943d8effb9', 'uuid_version_unsupported'],
      ['a3578398-c4cc-f14d-9a44-c7943d8effb9', 'uuid_version_unsupported'],
      [BAD_VARIANT_ATTEMPT, 'uuid_variant_unsupported'],
      ['a3578398-c4cc-714d-0a44-c7943d8effb9', 'uuid_variant_unsupported'],
    ];
    for (const [value, expected] of cases) {
      assert.equal(submissionAuthorityRetrySafetyUuidShape(value), expected, JSON.stringify(value));
    }
  });
});

describe('submissionAuthorityStrictTimestampShape', () => {
  it('classifies each way a retry-safety timestamp can fail the client contract', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [CAPTURED_AT, 'ok'],
      [undefined, 'absent'],
      [null, 'absent'],
      [1756368120000, 'not_a_string'],
      ['', 'blank'],
      ['yesterday', 'timestamp_unparseable'],
      // Regex-shaped but not a real instant: the predicate rejected it before this class existed.
      ['2026-13-45T99:99:99.999Z', 'timestamp_unparseable'],
      /* Parseable, just not `Date#toISOString()` output. Every server-side producer of these
       * strings goes through toISOString(), so this class firing in a log would prove a string
       * reached the fold from somewhere that does not. */
      ['2026-08-28T08:02:00Z', 'timestamp_not_strict_iso'],
      ['2026-08-28T08:02:00.123456Z', 'timestamp_not_strict_iso'],
      ['2026-08-28T08:02:00.000+00:00', 'timestamp_not_strict_iso'],
      ['2026-08-28 08:02:00Z', 'timestamp_not_strict_iso'],
    ];
    for (const [value, expected] of cases) {
      assert.equal(submissionAuthorityStrictTimestampShape(value), expected, JSON.stringify(value));
    }
  });

  it('answers ok for exactly the strings the client regexes accept', () => {
    const values = [
      CAPTURED_AT, '2026-08-28T08:02:00.000Z', '2026-08-28T08:02:00Z',
      '2026-08-28T08:02:00.123456Z', '2026-08-28T08:02:00.000+00:00',
      '2026-08-28T08:02:00+05:30', '2026-08-28T08:02:00.123456789Z',
      '2026-08-28 08:02:00Z', '2026-13-45T99:99:99.999Z', 'yesterday', '',
    ];
    for (const value of values) {
      assert.equal(
        submissionAuthorityStrictTimestampShape(value) === 'ok',
        CLIENT_STRICT_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)),
        `strict ${value}`,
      );
      assert.equal(
        submissionAuthorityProjectionTimestampShape(value) === 'ok',
        CLIENT_PROJECTION_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value)),
        `projection ${value}`,
      );
    }
  });

  it('separates a looser projection timestamp from a strict retry one', () => {
    // The client accepts an offset and up to nine fractional digits on a projection timestamp and
    // neither on a retry timestamp, so the two classifiers must disagree here and only here.
    for (const value of ['2026-08-28T08:02:00Z', '2026-08-28T08:02:00+05:30', '2026-08-28T08:02:00.123456789Z']) {
      assert.equal(submissionAuthorityStrictTimestampShape(value), 'timestamp_not_strict_iso', value);
      assert.equal(submissionAuthorityProjectionTimestampShape(value), 'ok', value);
    }
    assert.equal(submissionAuthorityProjectionTimestampShape('2026-08-28 08:02:00Z'), 'timestamp_not_iso');
  });
});

describe('submissionAuthorityPublicationForPacket rejection detail', () => {
  function rejection(input: Parameters<typeof submissionAuthorityPublicationForPacket>[0]) {
    const publication = submissionAuthorityPublicationForPacket(input);
    return publication.published ? null : publication.rejected ?? null;
  }
  const LOOSE_AT = '2026-08-28T08:02:00Z';

  it('names the branch, the field and the shape for a malformed safe_not_sent', () => {
    /* This is the branch the 2026-09-03 census was first read as, and the reading was wrong: a
     * `safe_not_sent` resolved through the dashboard that same morning (DSI Innovations, packet
     * a34e5ce2, attempt 37e4ca1b, resolvedAt 2026-09-03T11:54:58.700Z) published end to end. So the
     * point of these assertions is not that this branch IS the live cause - it is that a log line
     * can now say so, or rule it out, per packet, without another guess. */
    assert.deepEqual(rejection({
      packetId: PACKET,
      projection: { state: 'none' },
      retrySafety: {
        kind: 'safe_not_sent',
        attemptId: BAD_VARIANT_ATTEMPT,
        proofKind: 'typed_pre_click_stop',
        resolvedAt: CAPTURED_AT,
      },
      revision: '3',
    }), { branch: 'none', field: 'retry_safety.attemptId', shape: 'uuid_variant_unsupported' });
    assert.deepEqual(rejection({
      packetId: PACKET,
      projection: { state: 'none' },
      retrySafety: {
        kind: 'safe_not_sent',
        attemptId: ATTEMPT,
        proofKind: 'typed_pre_click_stop',
        resolvedAt: LOOSE_AT,
      },
      revision: '3',
    }), { branch: 'none', field: 'retry_safety.resolvedAt', shape: 'timestamp_not_strict_iso' });
    // A well-shaped verdict publishes, so there is nothing to name. This is the DSI shape.
    assert.equal(rejection({
      packetId: PACKET,
      projection: { state: 'none' },
      retrySafety: {
        kind: 'safe_not_sent',
        attemptId: ATTEMPT,
        proofKind: 'applicant_checked_not_sent',
        resolvedAt: CAPTURED_AT,
      },
      revision: '3',
    }), null);
  });

  it('names the field for a malformed unverified projection', () => {
    assert.deepEqual(rejection({
      packetId: PACKET,
      projection: { state: 'unverified', attemptId: 'not-a-uuid', observedAt: CAPTURED_AT, reason: 'pressed' },
      retrySafety: { kind: 'blocked_unverified', attemptId: ATTEMPT, at: CAPTURED_AT, reason: 'pressed' },
      revision: '3',
    }), { branch: 'unverified', field: 'projection.attempt_id', shape: 'uuid_malformed' });
    assert.deepEqual(rejection({
      packetId: PACKET,
      projection: { state: 'unverified', attemptId: ATTEMPT, observedAt: 'yesterday', reason: 'opened' },
      retrySafety: { kind: 'blocked_unverified', attemptId: ATTEMPT, at: CAPTURED_AT, reason: 'opened' },
      revision: '3',
    }), { branch: 'unverified', field: 'projection.observed_at', shape: 'timestamp_unparseable' });
  });

  it('names each of the four ways a repair projection is refused', () => {
    const retrySafety = { kind: 'no_evidence' } as const;
    assert.deepEqual(rejection({
      packetId: PACKET,
      projection: { state: 'repair_required', reasons: [] },
      retrySafety,
      revision: '3',
    }), { branch: 'repair_required', field: 'projection.reasons', shape: 'empty_list' });
    assert.deepEqual(rejection({
      packetId: PACKET,
      projection: { state: 'repair_required', packetId: OTHER_PACKET, reasons: ['packet_missing'] },
      retrySafety,
      revision: '3',
    }), { branch: 'repair_required', field: 'projection.packet_id', shape: 'bound_to_other_packet' });
    assert.deepEqual(rejection({
      packetId: PACKET,
      projection: { state: 'repair_required', attemptId: V7_ATTEMPT, reasons: ['receipt_missing'] },
      retrySafety,
      revision: '3',
    }), { branch: 'repair_required', field: 'projection.attempt_id', shape: 'uuid_version_unsupported' });
    assert.deepEqual(rejection({
      packetId: PACKET,
      projection: {
        state: 'repair_required',
        attemptId: ATTEMPT,
        canonicalApplicationId: 'not-a-uuid',
        reasons: ['receipt_missing'],
      },
      retrySafety,
      revision: '3',
    }), { branch: 'repair_required', field: 'projection.canonical_application_id', shape: 'uuid_malformed' });
    // A repair projection carrying neither id is publishable, so neither is named absent.
    assert.equal(rejection({
      packetId: PACKET,
      projection: { state: 'repair_required', reasons: ['packet_missing'] },
      retrySafety,
      revision: '3',
    }), null);
  });

  it('names each confirmed clause, in the order the builder evaluates them', () => {
    const retrySafety = { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT } as const;
    const confirmed = (patch: Partial<typeof confirmedProjection>) => rejection({
      packetId: PACKET,
      projection: { ...confirmedProjection, ...patch } as AuthoritativeSubmissionProjection,
      retrySafety,
      revision: '3',
    });
    assert.deepEqual(confirmed({ packetId: OTHER_PACKET }), {
      branch: 'confirmed', field: 'projection.packet_id', shape: 'bound_to_other_packet',
    });
    assert.deepEqual(confirmed({ attemptId: V7_ATTEMPT }), {
      branch: 'confirmed', field: 'projection.attempt_id', shape: 'uuid_version_unsupported',
    });
    assert.deepEqual(confirmed({ canonicalApplicationId: 'not-a-uuid' }), {
      branch: 'confirmed', field: 'projection.canonical_application_id', shape: 'uuid_malformed',
    });
    assert.deepEqual(confirmed({ trackerStage: 'saved' }), {
      branch: 'confirmed', field: 'projection.tracker_stage', shape: 'outside_client_vocabulary',
    });
    assert.deepEqual(confirmed({ submittedAt: 'yesterday' }), {
      branch: 'confirmed', field: 'projection.submitted_at', shape: 'timestamp_unparseable',
    });
    assert.deepEqual(
      confirmed({ receipt: { ...confirmedProjection.receipt, capturedAt: LOOSE_AT } }),
      { branch: 'confirmed', field: 'receipt.captured_at', shape: 'timestamp_not_strict_iso' },
    );
    // Sent after the receipt was captured: both timestamps are well shaped, the pair is not.
    assert.deepEqual(confirmed({ submittedAt: '2026-08-28T09:00:00.000Z' }), {
      branch: 'confirmed', field: 'projection.submitted_at', shape: 'out_of_order',
    });
    assert.deepEqual(
      confirmed({ receipt: { ...confirmedProjection.receipt, confirmationText: '   ' } }),
      { branch: 'confirmed', field: 'receipt.confirmation_text', shape: 'blank' },
    );
    assert.deepEqual(
      confirmed({ receipt: { ...confirmedProjection.receipt, confirmationText: 'x'.repeat(2001) } }),
      { branch: 'confirmed', field: 'receipt.confirmation_text', shape: 'oversize' },
    );
    assert.deepEqual(
      confirmed({ receipt: { ...confirmedProjection.receipt, finalUrl: 'http://example.com/receipt' } }),
      { branch: 'confirmed', field: 'receipt.final_url', shape: 'not_https_url' },
    );
    // The two vocabularies the client has no word for, told apart.
    assert.deepEqual(confirmed({ source: 'unsupported_email' }), {
      branch: 'confirmed', field: 'projection.source', shape: 'outside_client_vocabulary',
    });
    assert.deepEqual(
      confirmed({ receipt: { ...confirmedProjection.receipt, source: 'email_fallback' } }),
      { branch: 'confirmed', field: 'receipt.source', shape: 'outside_client_vocabulary' },
    );
  });

  it('leaves the refusals that are already their own explanation unnamed', () => {
    // These four reasons describe a state, not a malformed field, so there is nothing to classify.
    assert.equal(rejection({
      packetId: PACKET, projection: undefined, retrySafety: { kind: 'no_evidence' }, revision: '3',
    }), null);
    assert.equal(rejection({
      packetId: PACKET, projection: { state: 'none' }, retrySafety: { kind: 'no_evidence' }, revision: '03',
    }), null);
    assert.equal(rejection({
      packetId: PACKET,
      projection: {
        state: 'unverified',
        attemptId: ATTEMPT,
        observedAt: CAPTURED_AT,
        reason: 'boundary_authorized',
      },
      retrySafety: {
        kind: 'blocked_unverified',
        attemptId: ATTEMPT,
        at: CAPTURED_AT,
        reason: 'boundary_authorized',
        leaseId: OTHER_ATTEMPT,
        expiresAt: CAPTURED_AT,
      },
      revision: '3',
    }), null);
    assert.equal(rejection({
      packetId: PACKET,
      projection: { state: 'none' },
      retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
      revision: '3',
    }), null);
  });

  it('keeps the diagnosis off the wire', () => {
    /* The whole point of putting this in a log line rather than in the marker. The dashboard parses
     * `reason` from a closed vocabulary; the checkout of role-quick-website on this machine carries
     * no reader for the contract at all, which says that clone is behind the dashboard that shipped
     * the check (role-quick-website #466, 2026-08-31), not that the vocabulary is free. So the
     * marker keeps its three keys, and branch/field/shape stay server-side.
     *
     * The malformed identifier now reports as `unpublishable_attempt_identity`, which is the class
     * the 2026-09-03 census found 162 of on one account - still one word from a closed vocabulary,
     * still three keys, and still nothing about the value. */
    const publication = submissionAuthorityPublicationForPacket({
      packetId: PACKET,
      projection: { state: 'unverified', attemptId: 'not-a-uuid', observedAt: CAPTURED_AT, reason: 'pressed' },
      retrySafety: { kind: 'blocked_unverified', attemptId: ATTEMPT, at: CAPTURED_AT, reason: 'pressed' },
      revision: '3',
    });
    assert.equal(publication.published, false);
    assert.ok(!publication.published && publication.rejected);
    assert.deepEqual(
      submissionAuthorityUnavailableMarker(
        PACKET,
        publication.published ? 'boundary_authorized' : publication.reason,
      ),
      { schema_version: 'submission-authority-v1', packet_id: PACKET, reason: 'unpublishable_attempt_identity' },
    );
    // And the identifier itself is nowhere in what the marker publishes.
    assert.equal(JSON.stringify(submissionAuthorityUnavailableMarker(PACKET, publication.reason)).includes('not-a-uuid'), false);
  });
});

/**
 * THE TWO REPAIRS THE 2026-09-03 CENSUS ASKED FOR, AND THE LINE BETWEEN THEM.
 *
 * `GET /applications/board/authority-rejections` on mehekmandal05@gmail.com, revision 1624: 200
 * packets classified, 163 refused, and the (branch, field, shape) table came back
 *   unverified/projection.attempt_id/uuid_version_unsupported      104
 *   unverified/projection.attempt_id/uuid_variant_unsupported       46
 *   repair_required/projection.attempt_id/uuid_version_unsupported  10
 *   confirmed/projection.attempt_id/uuid_version_unsupported         1
 *   repair_required/projection.attempt_id/uuid_variant_unsupported   1
 *   boundary_authorized                                              1
 * - one field, on three branches, and zero members of every other class the residual word covered.
 *
 * Two different things follow from that, and conflating them is how this gate would get broken:
 *
 *  - On a RETRY VERDICT the identifier is read by submission-state.ts:74, which accepts versions
 *    1-8. This file was applying the projection's 1-5 rule there, so it refused envelopes the
 *    deployed client would have accepted. That is a defect and it is fixed: those publish now.
 *  - On a PROJECTION the identifier is read by submission-projection.ts:12, which accepts 1-5. The
 *    refusal is the client's own, and publishing past it would not produce a better card - it would
 *    make boardSubmissionAuthorityCollectionIsComplete reject the entire board payload, because one
 *    unparseable envelope discredits the snapshot while a card with no envelope is merely absent.
 *    So it stays refused, and only its NAME changes, from a residual shared with five other classes
 *    to the one class 162 of the 163 packets are actually in.
 */
describe('the identifier contract the client actually applies, per field', () => {
  const V7_SAFE_NOT_SENT = {
    kind: 'safe_not_sent',
    attemptId: V7_ATTEMPT,
    proofKind: 'applicant_checked_not_sent',
    resolvedAt: CAPTURED_AT,
  } as const;

  it('publishes a resolved packet whose attempt id is version 6, 7 or 8', () => {
    /* The send-authorising path. `safe_not_sent` is the ledger's proof that an opened attempt never
     * crossed the employer boundary, and it is the ONLY verdict on a `none` projection that can
     * authorise a first employer send - it is what a packet lands in after the applicant resolves
     * its unverified record through the dashboard (DSI Innovations, packet a34e5ce2, 2026-09-03).
     * A `none` envelope publishes `projection: {state:'none'}` and nothing else, so this identifier
     * is read by exactly one client parser and that parser accepts versions 1-8. Refusing it here
     * cost a resolved packet its envelope for a nibble no reader of this envelope looks at. */
    for (const version of '678') {
      const attemptId = `a3578398-c4cc-${version}14d-9a44-c7943d8effb9`;
      const publication = submissionAuthorityPublicationForPacket({
        packetId: PACKET,
        projection: { state: 'none' },
        retrySafety: { ...V7_SAFE_NOT_SENT, attemptId },
        revision: '3',
      });
      assert.equal(publication.published, true, `version ${version} publishes`);
      assert.ok(publication.published);
      assert.deepEqual(publication.envelope.retry_safety, {
        kind: 'safe_not_sent',
        attemptId,
        proofKind: 'applicant_checked_not_sent',
        resolvedAt: CAPTURED_AT,
      });
      assert.deepEqual(publication.envelope.projection, { state: 'none' });
    }
  });

  it('publishes the same bytes from the unattempted builder and the packet publication', () => {
    /* The Maven regression, re-run on the widened rule. These two surfaces diverged once before
     * (2026-09-02: the board published `safe_not_sent`, the builder refused the same packet, and
     * the dashboard fell back to a stored null and refused a packet the ledger had just proven
     * un-sent), so any change to one predicate has to be a change to both. */
    const envelope = submissionAuthorityEnvelopeForUnattemptedPacket({
      packetId: PACKET,
      projectionState: 'none',
      retrySafety: V7_SAFE_NOT_SENT,
      revision: '3',
    });
    const publication = submissionAuthorityPublicationForPacket({
      packetId: PACKET,
      projection: { state: 'none' },
      retrySafety: V7_SAFE_NOT_SENT,
      revision: '3',
    });
    assert.ok(envelope);
    assert.ok(publication.published);
    assert.deepEqual(publication.envelope, envelope);
  });

  it('keeps the block on a repair card whose retry identifier is version 6, 7 or 8', () => {
    /* Same rule, the other retry-verdict site. A repair projection publishes either way, so the
     * cost here was information rather than publication: the card lost its `retry_safety` to a
     * `null` and a reader could no longer see WHY it was in repair. `leaseId` moves with it. */
    const publication = submissionAuthorityPublicationForPacket({
      packetId: PACKET,
      projection: { state: 'repair_required', reasons: ['receipt_missing'] },
      retrySafety: { kind: 'blocked_unverified', attemptId: V7_ATTEMPT, at: CAPTURED_AT, reason: 'pressed' },
      revision: '3',
    });
    assert.ok(publication.published);
    assert.deepEqual(publication.envelope.retry_safety, {
      kind: 'blocked_unverified',
      attemptId: V7_ATTEMPT,
      at: CAPTURED_AT,
      reason: 'pressed',
    });
  });

  it('still refuses a version 6, 7 or 8 identifier inside a published PROJECTION', () => {
    /* THE LINE. Widening the retry rule must not widen this one: the deployed client holds
     * `projection.attempt_id` to versions 1-5, and an envelope carrying one it rejects fails the
     * board's collection check for every card on the page, not just this one. Refusing is the only
     * safe answer, and it is the answer on all three branches that publish an attempt id. */
    const confirmedV7: AuthoritativeSubmissionProjection = { ...confirmedProjection, attemptId: V7_ATTEMPT };
    const branches: ReadonlyArray<readonly [string, Parameters<typeof submissionAuthorityPublicationForPacket>[0]]> = [
      ['unverified', {
        packetId: PACKET,
        projection: { state: 'unverified', attemptId: V7_ATTEMPT, observedAt: CAPTURED_AT, reason: 'pressed' },
        retrySafety: { kind: 'blocked_unverified', attemptId: V7_ATTEMPT, at: CAPTURED_AT, reason: 'pressed' },
        revision: '3',
      }],
      ['repair_required', {
        packetId: PACKET,
        projection: { state: 'repair_required', attemptId: V7_ATTEMPT, reasons: ['receipt_missing'] },
        retrySafety: { kind: 'no_evidence' },
        revision: '3',
      }],
      ['confirmed', {
        packetId: PACKET,
        projection: confirmedV7,
        retrySafety: { kind: 'blocked_confirmed', attemptId: V7_ATTEMPT, confirmedAt: CAPTURED_AT },
        revision: '3',
      }],
    ];
    for (const [branch, input] of branches) {
      const publication = submissionAuthorityPublicationForPacket(input);
      assert.equal(publication.published, false, `${branch} still refuses`);
      assert.ok(!publication.published);
      assert.equal(publication.reason, 'unpublishable_attempt_identity', branch);
      assert.deepEqual(publication.rejected, {
        branch,
        field: 'projection.attempt_id',
        shape: 'uuid_version_unsupported',
      });
      assert.equal(submissionAuthorityEnvelopeForPacket(input), undefined, branch);
    }
  });

  it('names the attempt identity apart from every other residual class', () => {
    /* The whole reason the word was split. A card refused for its receipt URL has a repair on that
     * packet; a card refused for its attempt id does not, and on 2026-09-03 the second was 162 of
     * one account's 163 refusals while the first was zero of them. One word for both is a count. */
    const residual: ReadonlyArray<readonly [string, Parameters<typeof submissionAuthorityPublicationForPacket>[0]]> = [
      ['projection.observed_at', {
        packetId: PACKET,
        projection: { state: 'unverified', attemptId: ATTEMPT, observedAt: '2026-08-28T08:02:00Z', reason: 'pressed' },
        retrySafety: { kind: 'blocked_unverified', attemptId: ATTEMPT, at: CAPTURED_AT, reason: 'pressed' },
        revision: '3',
      }],
      ['projection.reasons', {
        packetId: PACKET,
        projection: { state: 'repair_required', reasons: [] },
        retrySafety: { kind: 'no_evidence' },
        revision: '3',
      }],
      ['projection.canonical_application_id', {
        packetId: PACKET,
        projection: { state: 'repair_required', canonicalApplicationId: V7_ATTEMPT, reasons: ['receipt_missing'] },
        retrySafety: { kind: 'no_evidence' },
        revision: '3',
      }],
      ['receipt.final_url', {
        packetId: PACKET,
        projection: {
          ...confirmedProjection,
          receipt: { ...confirmedProjection.receipt, finalUrl: 'http://example.invalid/receipt' },
        },
        retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
        revision: '3',
      }],
    ];
    for (const [field, input] of residual) {
      const publication = submissionAuthorityPublicationForPacket(input);
      assert.ok(!publication.published, field);
      assert.equal(publication.reason, 'unpublishable_projection', field);
      assert.equal(publication.rejected?.field, field);
    }
  });
});
