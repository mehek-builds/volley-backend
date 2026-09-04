import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  submissionAuthorityEnvelopeForUnattemptedPacket,
  submissionAuthorityLedgerIdShape,
  submissionAuthorityPublicationForPacket,
  submissionAuthorityUuidShape,
} from './submissionAuthorityEnvelope';

/* A BLOCK THAT CITES EVIDENCE NOBODY HAS.
 *
 * The applicant-facing half of this is in the dashboard: a packet that publishes no envelope is
 * quarantined by the client, applicationPacketAuthorityState answers `uncertain`, and the review
 * screen refuses "Litos cannot start another employer attempt until the exact prior submission
 * evidence is verified" - with no control that can clear it, because there is no evidence to
 * verify. This file is the half that decides whether an envelope is published at all.
 *
 * The identifiers below are the shape the ledger actually mints. `attempt_id` is a Postgres `uuid`
 * column and appendSubmissionAttemptEvent never version-checks it, so its version and variant
 * nibbles are uniformly distributed. The census this file already records (2026-09-03, 200 packets)
 * refused 162 of 163 cards on `projection.attempt_id` alone: 115 on the version nibble, 47 on the
 * variant. That is PR #918's `unpublishable_attempt_identity`.
 */
const PACKET = '4a586b1c-14b3-4dd4-ac59-0cdaf27fb197';
/** version nibble 7 - refused by the old projection rule. */
const V7_ATTEMPT = 'a3578398-c4cc-714d-9a44-c7943d8effb9';
/** variant nibble 4 - refused by the old variant rule on either field. */
const VARIANT4_ATTEMPT = 'a3578398-c4cc-414d-4a44-c7943d8effb9';
const OBSERVED_AT = '2026-08-28T08:02:00.000Z';
const REVISION = '1624';

test('a ledger identifier is judged by layout, not by RFC nibbles', () => {
  assert.equal(submissionAuthorityLedgerIdShape(V7_ATTEMPT), 'ok');
  assert.equal(submissionAuthorityLedgerIdShape(VARIANT4_ATTEMPT), 'ok');
  // Still a real check.
  assert.equal(submissionAuthorityLedgerIdShape('not-a-uuid'), 'uuid_malformed');
  assert.equal(submissionAuthorityLedgerIdShape('a3578398c4cc414d4a44c7943d8effb9'), 'uuid_malformed');
  assert.equal(submissionAuthorityLedgerIdShape(''), 'blank');
  assert.equal(submissionAuthorityLedgerIdShape(undefined), 'absent');
  assert.equal(submissionAuthorityLedgerIdShape(42), 'not_a_string');
});

test('a ROW identifier keeps the strict rule the client still applies to it', () => {
  assert.equal(submissionAuthorityUuidShape(V7_ATTEMPT), 'uuid_version_unsupported');
  assert.equal(submissionAuthorityUuidShape(VARIANT4_ATTEMPT), 'uuid_variant_unsupported');
  assert.equal(submissionAuthorityUuidShape('c9ea060c-ec99-469a-8d19-4eabac66bd89'), 'ok');
});

/* THE DEFECT: a held attempt whose ONLY defect was its identifier's nibbles published no envelope,
 * so the card carried a marker instead and the applicant got the unclearable banner. It must now
 * publish - and what it publishes must still say `unverified`, which still refuses the send. */
test('an unverified projection with a ledger-shaped attempt id publishes', () => {
  const publication = submissionAuthorityPublicationForPacket({
    packetId: PACKET,
    projection: {
      state: 'unverified',
      attemptId: V7_ATTEMPT,
      observedAt: OBSERVED_AT,
      reason: 'pressed',
    },
    retrySafety: {
      kind: 'blocked_unverified',
      attemptId: V7_ATTEMPT,
      at: OBSERVED_AT,
      reason: 'pressed',
    },
    revision: REVISION,
  });
  assert.equal(publication.published, true);
  assert.equal(publication.published && publication.envelope.state, 'unverified');
});

test('the variant nibble no longer refuses a held attempt either', () => {
  const publication = submissionAuthorityPublicationForPacket({
    packetId: PACKET,
    projection: {
      state: 'unverified',
      attemptId: VARIANT4_ATTEMPT,
      observedAt: OBSERVED_AT,
      reason: 'pressed',
    },
    retrySafety: {
      kind: 'blocked_unverified',
      attemptId: VARIANT4_ATTEMPT,
      at: OBSERVED_AT,
      reason: 'pressed',
    },
    revision: REVISION,
  });
  assert.equal(publication.published, true);
});

/* The verdict that PROVES nothing reached an employer, carrying a ledger-shaped id. This is the
 * shape a packet lands in after repairExpiredAttendedHandoffClaim releases a phantom attempt, and
 * it is the only kind of evidence that may authorise a first send. */
test('a safe_not_sent proof with a ledger-shaped id builds an envelope', () => {
  const envelope = submissionAuthorityEnvelopeForUnattemptedPacket({
    packetId: PACKET,
    projectionState: 'none',
    retrySafety: {
      kind: 'safe_not_sent',
      attemptId: VARIANT4_ATTEMPT,
      proofKind: 'typed_pre_click_stop',
      resolvedAt: OBSERVED_AT,
    },
    revision: REVISION,
  });
  assert.notEqual(envelope, undefined);
  assert.equal(envelope?.state, 'none');
  assert.equal(envelope?.retry_safety.kind, 'safe_not_sent');
});

/* SAFETY. Widening an identifier alphabet must not make anything sendable that was not. A packet
 * with a block beside a `none` projection is still an inconsistency, and a malformed identifier is
 * still refused - the envelope is withheld exactly as before. */
test('a malformed attempt id is still refused publication', () => {
  const publication = submissionAuthorityPublicationForPacket({
    packetId: PACKET,
    projection: {
      state: 'unverified',
      attemptId: 'not-a-uuid',
      observedAt: OBSERVED_AT,
      reason: 'pressed',
    },
    retrySafety: {
      kind: 'blocked_unverified',
      attemptId: 'not-a-uuid',
      at: OBSERVED_AT,
      reason: 'pressed',
    },
    revision: REVISION,
  });
  assert.equal(publication.published, false);
  assert.equal(
    publication.published === false && publication.rejected?.field,
    'projection.attempt_id',
  );
  assert.equal(publication.published === false && publication.rejected?.shape, 'uuid_malformed');
});

test('a block beside an empty projection is still refused', () => {
  const publication = submissionAuthorityPublicationForPacket({
    packetId: PACKET,
    projection: { state: 'none' },
    retrySafety: {
      kind: 'blocked_unverified',
      attemptId: V7_ATTEMPT,
      at: OBSERVED_AT,
      reason: 'pressed',
    },
    revision: REVISION,
  });
  assert.equal(publication.published, false);
  assert.equal(
    publication.published === false && publication.reason,
    'inconsistent_retry_evidence',
  );
});

test('a non-canonical revision is still refused', () => {
  const publication = submissionAuthorityPublicationForPacket({
    packetId: PACKET,
    projection: { state: 'none' },
    retrySafety: { kind: 'no_evidence' },
    revision: 'not-a-number',
  });
  assert.equal(publication.published, false);
  assert.equal(publication.published === false && publication.reason, 'revision_not_canonical');
});
