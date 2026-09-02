import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canonicalSubmissionAuthorityRevision,
  submissionAuthorityEnvelopeForPacket,
  submissionAuthorityEnvelopeForUnattemptedPacket,
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
      retrySafetyKind: 'no_evidence',
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
