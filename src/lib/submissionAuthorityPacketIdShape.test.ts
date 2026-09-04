import assert from 'node:assert/strict';
import test from 'node:test';

import { submissionAuthorityPublicationForPacket } from './submissionAuthorityEnvelope';
import type { AuthoritativeSubmissionProjection } from './authoritativeSubmissionProjection';

/* THE IDENTIFIER THAT BINDS THE CARD HAD NO SHAPE CHECK, AND IT DISCARDS THE WHOLE BOARD.
 *
 * Every other identifier on a published projection - attempt_id, canonical_application_id - is run
 * through submissionAuthorityUuidShape against the deployed client's rule. packet_id was proved only
 * by the equality `projection.packetId !== packetId`, which shows the id names THIS packet and says
 * nothing about whether the client can parse it.
 *
 * The client holds projection.packet_id to UUID versions 1-5 (submission-projection.ts uuidString),
 * while this file's own UUID and the board context check both accept 1-8. So a version-6-to-8 packet
 * id cleared every gate here and was refused only on the client - and a projection the client cannot
 * parse makes boardSubmissionAuthorityCollectionIsComplete return false for the ENTIRE payload, so
 * every card on the board is discarded rather than this one.
 *
 * That is precisely the blast radius that justifies this file refusing rather than widening the
 * projection rule, and it was left open on the one identifier the argument had skipped. Measured on
 * this branch before the check existed: both branches returned published: true.
 */

const PACKET_V7 = 'a3578398-c4cc-714d-9a44-c7943d8effb9';
const ATTEMPT = 'a3578398-c4cc-414d-9a44-c7943d8effb9';
const CANONICAL = 'c9ea060c-ec99-469a-8d19-4eabac66bd89';
const CAPTURED_AT = '2026-08-28T08:02:00.000Z';

const confirmedWithV7Packet: AuthoritativeSubmissionProjection = {
  state: 'confirmed',
  attemptId: ATTEMPT,
  canonicalApplicationId: CANONICAL,
  packetId: PACKET_V7,
  source: 'managed_browser',
  trackerStage: 'applied',
  submittedAt: '2026-08-28T08:00:00.000Z',
  receipt: {
    confirmationText: 'Thank you for applying.',
    finalUrl: 'https://job-boards.greenhouse.io/example/jobs/1/application_confirmation',
    capturedAt: CAPTURED_AT,
    source: 'managed_browser',
  },
} as unknown as AuthoritativeSubmissionProjection;

test('a confirmed projection whose packet_id the client cannot parse refuses instead of publishing', () => {
  const publication = submissionAuthorityPublicationForPacket({
    packetId: PACKET_V7,
    projection: confirmedWithV7Packet,
    retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
    revision: '7',
  } as Parameters<typeof submissionAuthorityPublicationForPacket>[0]);

  assert.equal(
    publication.published,
    false,
    'publishing this envelope would make the client discard every card on the board',
  );
  assert.equal(publication.rejected?.field, 'projection.packet_id');
  // The equality passed - the id really does name this packet - so the refusal must be about SHAPE.
  assert.notEqual(
    publication.rejected?.shape,
    'bound_to_other_packet',
    'the binding is correct here; what fails is that the client cannot parse the identifier',
  );
});

test('a repair projection whose packet_id the client cannot parse refuses too', () => {
  const repairWithV7Packet = {
    state: 'repair_required',
    attemptId: ATTEMPT,
    canonicalApplicationId: CANONICAL,
    packetId: PACKET_V7,
    reasons: ['receipt_missing'],
  } as unknown as AuthoritativeSubmissionProjection;

  const publication = submissionAuthorityPublicationForPacket({
    packetId: PACKET_V7,
    projection: repairWithV7Packet,
    retrySafety: { kind: 'no_evidence' },
    revision: '7',
  } as Parameters<typeof submissionAuthorityPublicationForPacket>[0]);

  assert.equal(publication.published, false);
  assert.equal(publication.rejected?.field, 'projection.packet_id');
});

test('a packet_id inside the client rule still publishes, so the check is a shape gate and not a block', () => {
  const PACKET_V4 = 'c2c6c00a-71e0-4923-bbc2-123322c6d014';
  const publication = submissionAuthorityPublicationForPacket({
    packetId: PACKET_V4,
    projection: { ...confirmedWithV7Packet, packetId: PACKET_V4 } as AuthoritativeSubmissionProjection,
    retrySafety: { kind: 'blocked_confirmed', attemptId: ATTEMPT, confirmedAt: CAPTURED_AT },
    revision: '7',
  } as Parameters<typeof submissionAuthorityPublicationForPacket>[0]);

  assert.equal(publication.published, true, 'a well-shaped packet id must still publish');
});
