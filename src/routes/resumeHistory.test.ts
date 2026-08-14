import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  includeRequestedResumeInHistory,
  requestedResumeLookupId,
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
