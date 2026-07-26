import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issuedBeforeEpoch, sessionVersionIsStale } from './auth';

test('no epoch set: every token passes', () => {
  assert.equal(issuedBeforeEpoch(1_700_000_000, null), false);
  assert.equal(issuedBeforeEpoch(undefined, null), false);
});

test('token minted in an earlier second than the epoch is rejected', () => {
  const epoch = new Date(1_700_000_010_500); // 10.5s
  assert.equal(issuedBeforeEpoch(1_700_000_009, epoch), true);
  assert.equal(issuedBeforeEpoch(1_700_000_010 - 3600, epoch), true);
});

test('token minted in the same second as the epoch survives', () => {
  // verify-code sets session_valid_from then signs the fresh token within the
  // same second; JWT iat is floored to seconds so both floor to :10.
  const epoch = new Date(1_700_000_010_999);
  assert.equal(issuedBeforeEpoch(1_700_000_010, epoch), false);
});

test('token minted after the epoch survives', () => {
  const epoch = new Date(1_700_000_010_000);
  assert.equal(issuedBeforeEpoch(1_700_000_011, epoch), false);
});

test('token with no iat is treated as stale when an epoch exists', () => {
  assert.equal(issuedBeforeEpoch(undefined, new Date(1_700_000_010_000)), true);
});

test('legacy tokens without a version remain valid until an account rotation', () => {
  assert.equal(sessionVersionIsStale(undefined, 0), false);
  assert.equal(sessionVersionIsStale(undefined, 1), true);
});

test('session versions provide exact immediate revocation', () => {
  assert.equal(sessionVersionIsStale(4, 4), false);
  assert.equal(sessionVersionIsStale(3, 4), true);
  assert.equal(sessionVersionIsStale(5, 4), true);
});
