import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOB_BOARD_CURSOR_TTL_MS,
  JobBoardCursorError,
  decodeJobBoardCursor,
  encodeJobBoardCursor,
  jobBoardCursorFilterHash,
  jobBoardCursorSigningSecret,
} from './jobBoardCursor';

const SECRET = 'cursor-test-secret-with-enough-entropy';
const NOW = Date.parse('2026-08-31T00:00:00.000Z');

test('signed cursor round-trips its route, snapshot, filters, and seek key', () => {
  const filterHash = jobBoardCursorFilterHash({ q: 'engineer', sponsor_only: true });
  const token = encodeJobBoardCursor({
    route: 'jobs',
    asOf: new Date(NOW),
    filterHash,
    total: 500_123,
    key: {
      q_rank: 0,
      title_rank: 1,
      posted_at: null,
      first_seen_at: '2026-08-30T12:00:00.000Z',
      id: '10000000-0000-4000-8000-000000000001',
    },
  }, SECRET);

  assert.deepEqual(decodeJobBoardCursor(token, { route: 'jobs', filterHash }, SECRET, NOW), {
    route: 'jobs',
    asOf: new Date(NOW),
    filterHash,
    total: 500_123,
    key: {
      q_rank: 0,
      title_rank: 1,
      posted_at: null,
      first_seen_at: '2026-08-30T12:00:00.000Z',
      id: '10000000-0000-4000-8000-000000000001',
    },
  });
});

test('cursor rejects tampering, route reuse, changed filters, and expiry', () => {
  const filterHash = jobBoardCursorFilterHash({ company: 'Acme' });
  const token = encodeJobBoardCursor({
    route: 'grouped',
    asOf: new Date(NOW),
    filterHash,
    total: 60_123,
    postingsTotal: 500_123,
    key: {
      q_rank: 0,
      title_rank: 0,
      posted_at: '2026-08-30T10:00:00.000Z',
      first_seen_at: '2026-08-29T10:00:00.000Z',
      tie_id: '20000000-0000-4000-8000-000000000001',
    },
  }, SECRET);
  const [payload, signature] = token.split('.');
  const tampered = `${payload.slice(0, -1)}${payload.endsWith('A') ? 'B' : 'A'}.${signature}`;

  assert.throws(
    () => decodeJobBoardCursor(tampered, { route: 'grouped', filterHash }, SECRET, NOW),
    (error: unknown) => error instanceof JobBoardCursorError && error.code === 'invalid',
  );
  assert.throws(
    () => decodeJobBoardCursor(token, { route: 'jobs', filterHash }, SECRET, NOW),
    (error: unknown) => error instanceof JobBoardCursorError && error.code === 'mismatch',
  );
  assert.throws(
    () => decodeJobBoardCursor(token, {
      route: 'grouped',
      filterHash: jobBoardCursorFilterHash({ company: 'Other' }),
    }, SECRET, NOW),
    (error: unknown) => error instanceof JobBoardCursorError && error.code === 'mismatch',
  );
  assert.throws(
    () => decodeJobBoardCursor(
      token,
      { route: 'grouped', filterHash },
      SECRET,
      NOW + JOB_BOARD_CURSOR_TTL_MS + 1,
    ),
    (error: unknown) => error instanceof JobBoardCursorError && error.code === 'expired',
  );
});

test('filter hashing is stable across object key order and sensitive to values', () => {
  assert.equal(
    jobBoardCursorFilterHash({ filters: { title: 'Engineer', remote: true }, roles: ['a', 'b'] }),
    jobBoardCursorFilterHash({ roles: ['a', 'b'], filters: { remote: true, title: 'Engineer' } }),
  );
  assert.notEqual(
    jobBoardCursorFilterHash({ sponsor_only: false }),
    jobBoardCursorFilterHash({ sponsor_only: true }),
  );
});

test('cursor signing secret prefers the dedicated Railway setting and falls back to JWT', () => {
  assert.equal(jobBoardCursorSigningSecret({
    JOB_BOARD_CURSOR_SECRET: ' cursor ',
    JWT_SIGNING_SECRET: 'jwt',
  }), 'cursor');
  assert.equal(jobBoardCursorSigningSecret({ JWT_SIGNING_SECRET: ' jwt ' }), 'jwt');
  assert.equal(jobBoardCursorSigningSecret({}), null);
});
