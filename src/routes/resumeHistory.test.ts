import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  includeRequestedResumeInHistory,
  requestedResumeLookupId,
  submissionAuthorityEnvelopeForUnattemptedPacket,
} from './resume';

const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const LATEST_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OLDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const FOREIGN_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('includeRequestedResumeInHistory', () => {
  it('adds an older requested packet without dropping the latest history rows', () => {
    const latest = [
      { id: LATEST_ID, user_id: OWNER_ID },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', user_id: OWNER_ID },
    ];

    assert.deepEqual(includeRequestedResumeInHistory(
      latest,
      { id: OLDER_ID, user_id: OWNER_ID },
      OWNER_ID,
    ), [
      { id: OLDER_ID, user_id: OWNER_ID },
      ...latest,
    ]);
  });

  it('does not duplicate a requested packet already present in history', () => {
    const latest = [
      { id: LATEST_ID, user_id: OWNER_ID },
      { id: OLDER_ID, user_id: OWNER_ID },
    ];

    assert.deepEqual(includeRequestedResumeInHistory(latest, latest[1], OWNER_ID), latest);
  });

  it('returns an owned older packet but never returns another user packet', () => {
    const latest = [{ id: LATEST_ID, user_id: OWNER_ID }];
    const foreignPacket = { id: FOREIGN_ID, user_id: OTHER_USER_ID };
    const ownedOlderPacket = { id: OLDER_ID, user_id: OWNER_ID };

    assert.deepEqual(
      includeRequestedResumeInHistory(latest, foreignPacket, OWNER_ID),
      latest,
    );
    assert.deepEqual(
      includeRequestedResumeInHistory(latest, ownedOlderPacket, OWNER_ID),
      [ownedOlderPacket, ...latest],
    );
  });
});

describe('requestedResumeLookupId', () => {
  it('skips the direct lookup when the requested packet is already in the latest rows', () => {
    const latest = [{ id: LATEST_ID, user_id: OWNER_ID }];

    assert.equal(requestedResumeLookupId(latest, LATEST_ID), null);
    assert.equal(requestedResumeLookupId(latest, LATEST_ID.toUpperCase()), null);
  });

  it('looks up a valid older packet and ignores malformed IDs', () => {
    const latest = [{ id: LATEST_ID, user_id: OWNER_ID }];

    assert.equal(requestedResumeLookupId(latest, OLDER_ID), OLDER_ID);
    assert.equal(requestedResumeLookupId(latest, 'not-a-uuid'), null);
  });
});

describe('submissionAuthorityEnvelopeForUnattemptedPacket', () => {
  const PACKET = 'c2c6c00a-71e0-4923-bbc2-123322c6d014';

  it('emits the exact public envelope for a genuinely un-attempted packet', () => {
    assert.deepEqual(
      submissionAuthorityEnvelopeForUnattemptedPacket({
        packetId: PACKET,
        projectionState: 'none',
        retrySafety: { kind: 'no_evidence' },
        revision: '3',
      }),
      {
        schema_version: 'submission-authority-v1',
        revision: '3',
        state: 'none',
        application_id: PACKET,
        packet_id: PACKET,
        projection: { state: 'none' },
        retry_safety: { kind: 'no_evidence' },
      },
    );
  });

  it('emits no envelope for a packet with attempt history, so it stays fail-closed', () => {
    // A sent packet classifies repair_required / blocked_unverified.
    assert.equal(submissionAuthorityEnvelopeForUnattemptedPacket({
      packetId: PACKET,
      projectionState: 'repair_required',
      retrySafety: {
        kind: 'blocked_unverified',
        attemptId: 'a3578398-c4cc-414d-9a44-c7943d8effb9',
        at: '2026-08-28T08:00:00.000Z',
        reason: 'opened',
      },
      revision: '3',
    }), undefined);
    // A block beside a none projection is the two reads disagreeing, never an envelope.
    assert.equal(submissionAuthorityEnvelopeForUnattemptedPacket({
      packetId: PACKET,
      projectionState: 'none',
      retrySafety: {
        kind: 'blocked_unverified',
        attemptId: 'a3578398-c4cc-414d-9a44-c7943d8effb9',
        at: '2026-08-28T08:00:00.000Z',
        reason: 'opened',
      },
      revision: '3',
    }), undefined);
  });

  it('emits the envelope for an attempt the ledger proved never reached the employer', () => {
    /* This pin used to assert the OPPOSITE ("anything but no_evidence is not provably empty"), and
     * that was the defect: a `safe_not_sent` verdict is the ledger's typed proof that an opened
     * attempt never crossed the boundary - the state every phantom attempt released by PR #861
     * lands in - and refusing it here left /resume/history and /applications/:id/submission
     * without an envelope while the board published one for the same packet (The Maven Group,
     * crelate, 2026-09-02). The dashboard's send gate accepts safe_not_sent by name. */
    assert.deepEqual(
      submissionAuthorityEnvelopeForUnattemptedPacket({
        packetId: PACKET,
        projectionState: 'none',
        retrySafety: {
          kind: 'safe_not_sent',
          attemptId: 'a3578398-c4cc-414d-9a44-c7943d8effb9',
          proofKind: 'typed_pre_click_stop',
          resolvedAt: '2026-09-02T19:27:41.561Z',
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
          attemptId: 'a3578398-c4cc-414d-9a44-c7943d8effb9',
          proofKind: 'typed_pre_click_stop',
          resolvedAt: '2026-09-02T19:27:41.561Z',
        },
      },
    );
  });

  it('emits no envelope when the authority revision could not be read', () => {
    assert.equal(submissionAuthorityEnvelopeForUnattemptedPacket({
      packetId: PACKET,
      projectionState: 'none',
      retrySafety: { kind: 'no_evidence' },
      revision: undefined,
    }), undefined);
  });

  it('emits no envelope for a non-canonical revision the client would reject', () => {
    for (const revision of ['', 'abc', '01', '-1', '1.0', '99999999999999999999']) {
      assert.equal(submissionAuthorityEnvelopeForUnattemptedPacket({
        packetId: PACKET,
        projectionState: 'none',
        retrySafety: { kind: 'no_evidence' },
        revision,
      }), undefined, `revision ${JSON.stringify(revision)} must be rejected`);
    }
  });
});

describe('the removal filter and the exact lookup', () => {
  /**
   * THE TRAP THIS PINS. requestedResumeLookupId returns an id precisely when that id is NOT among
   * latestRows: its whole job is to fetch a packet the recent window missed. So the moment
   * /resume/history began filtering removed resumes out of latestRows, every removed id became
   * guaranteed to satisfy that test, and an unfiltered exact lookup would fetch exactly the rows
   * the filter had just excluded - then includeRequestedResumeInHistory PREPENDS the result, so the
   * removed packet returns at the TOP of the Tracker.
   *
   * The filter made the resurrection strictly more likely than no filter at all, and it is reached
   * by any stale `?application=` URL: a second tab, a bookmark, the back button, or a reload of the
   * page that was open when the row was removed.
   */
  const REMOVED_ID = '11111111-1111-4111-8111-111111111111';
  const KEPT_ID = '22222222-2222-4222-8222-222222222222';

  it('asks for a removed id exactly because the filter excluded it', () => {
    const latestAfterFilter = [{ id: KEPT_ID }];
    assert.equal(
      requestedResumeLookupId(latestAfterFilter, REMOVED_ID),
      REMOVED_ID,
      'the lookup is reached for removed ids, which is why the route must exclude them itself',
    );
  });

  it('the route guard drops the lookup for a removed id, case-insensitively', () => {
    /* The expression the route uses. Case matters: the helper compares lowercased, so a request
       carrying an upper-case UUID must not slip past a case-sensitive membership test. */
    const removedIds = [REMOVED_ID];
    const shouldLookUp = (requestedId: string) =>
      Boolean(requestedId) && !removedIds.some((id) => id.toLowerCase() === requestedId.toLowerCase());
    assert.equal(shouldLookUp(REMOVED_ID), false);
    assert.equal(shouldLookUp(REMOVED_ID.toUpperCase()), false, 'an upper-case id is the same id');
    assert.equal(shouldLookUp(KEPT_ID), true, 'a live packet is still fetchable by exact id');
  });
});
