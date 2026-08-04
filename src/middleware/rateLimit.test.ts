import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InMemoryRateLimitStore,
  policyForRequest,
  type RateLimitConfig,
  type RateLimitPolicy,
} from './rateLimit';

const POLICY: RateLimitPolicy = { name: 'test', limit: 2, windowMs: 1_000 };

const CONFIG: RateLimitConfig = {
  general: { name: 'general', limit: 180, windowMs: 60_000 },
  board: { name: 'board', limit: 90, windowMs: 60_000 },
  authStart: { name: 'auth_start', limit: 20, windowMs: 900_000 },
  authVerify: { name: 'auth_verify', limit: 40, windowMs: 900_000 },
  download: { name: 'resume_download', limit: 60, windowMs: 60_000 },
  maxKeys: 10,
};

test('store blocks over-limit requests and reports the reset window', () => {
  let now = 10_000;
  const store = new InMemoryRateLimitStore(10, () => now);

  assert.deepEqual(store.consume('test:ip', POLICY), {
    allowed: true,
    limit: 2,
    remaining: 1,
    resetAt: 11_000,
    retryAfterSeconds: 1,
  });
  assert.equal(store.consume('test:ip', POLICY).allowed, true);
  const blocked = store.consume('test:ip', POLICY);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);

  now = 11_000;
  const reset = store.consume('test:ip', POLICY);
  assert.equal(reset.allowed, true);
  assert.equal(reset.remaining, 1);
});

test('store remains memory bounded under high-cardinality traffic', () => {
  const store = new InMemoryRateLimitStore(2, () => 10_000);
  store.consume('test:one', POLICY);
  store.consume('test:two', POLICY);
  store.consume('test:three', POLICY);
  assert.equal(store.size, 2);
});

test('capacity eviction keeps recently used buckets', () => {
  const store = new InMemoryRateLimitStore(2, () => 10_000);
  store.consume('test:one', POLICY);
  store.consume('test:two', POLICY);
  store.consume('test:one', POLICY);
  store.consume('test:three', POLICY);

  assert.equal(store.consume('test:one', POLICY).allowed, false);
  assert.equal(store.consume('test:two', POLICY).remaining, 1);
});

test('resetting an expired bucket at capacity preserves other live buckets', () => {
  let now = 10_000;
  const store = new InMemoryRateLimitStore(2, () => now);
  const longWindowPolicy: RateLimitPolicy = { ...POLICY, windowMs: 10_000 };

  store.consume('test:expiring', POLICY);
  store.consume('test:live', longWindowPolicy);
  now = 11_000;

  assert.equal(store.consume('test:expiring', POLICY).remaining, 1);
  assert.equal(store.consume('test:live', longWindowPolicy).remaining, 0);
  assert.equal(store.size, 2);
});

test('mixed windows reclaim expired buckets before live authentication buckets', () => {
  let now = 10_000;
  const store = new InMemoryRateLimitStore(2, () => now);
  const authPolicy: RateLimitPolicy = { ...POLICY, windowMs: 15 * 60_000 };

  store.consume('auth:live', authPolicy);
  store.consume('general:expired', POLICY);
  now = 11_000;
  store.consume('general:new', POLICY);

  assert.equal(store.consume('auth:live', authPolicy).remaining, 0);
  assert.equal(store.size, 2);
});

test('clock rollback cannot make expiry queues non-monotonic', () => {
  let now = 10_000;
  const store = new InMemoryRateLimitStore(2, () => now);

  assert.equal(store.consume('test:first', POLICY).resetAt, 11_000);
  now = 9_000;
  assert.equal(store.consume('test:second', POLICY).resetAt, 11_000);
});

test('distinct policy windows remain constant-bounded', () => {
  const store = new InMemoryRateLimitStore(10, () => 10_000);
  for (let windowMs = 1; windowMs <= 4; windowMs += 1) {
    store.consume(`test:${windowMs}`, { ...POLICY, windowMs });
  }
  assert.throws(
    () => store.consume('test:fifth', { ...POLICY, windowMs: 5 }),
    /at most 4 distinct windows/,
  );
});

test('route policy protects auth and download routes without charging probes or preflights', () => {
  assert.equal(policyForRequest('GET', '/health', CONFIG), null);
  assert.equal(policyForRequest('GET', '/dashboard/bootstrap', CONFIG), null);
  assert.equal(policyForRequest('OPTIONS', '/auth/request-code', CONFIG), null);
  assert.equal(policyForRequest('POST', '/auth/request-code', CONFIG)?.name, 'auth_start');
  assert.equal(policyForRequest('POST', '/auth/password/login', CONFIG)?.name, 'auth_start');
  assert.equal(policyForRequest('POST', '/auth/verify-code', CONFIG)?.name, 'auth_verify');
  assert.equal(policyForRequest('POST', '/auth/google', CONFIG)?.name, 'auth_verify');
  assert.equal(policyForRequest('PUT', '/auth/password', CONFIG)?.name, 'auth_verify');
  assert.equal(policyForRequest('GET', '/resume/download', CONFIG)?.name, 'resume_download');
  assert.equal(policyForRequest('GET', '/profile', CONFIG)?.name, 'general');
});

/* The board routes are the ones that spend Neon transfer, which is the resource that ran out and
   suspended the database on 2026-08-04. Under `general` they sat at 180/minute per IP. */
test('every board read is metered under the board policy, not the general one', () => {
  for (const path of ['/jobs', '/jobs/grouped', '/jobs/facets', '/jobs/some-uuid']) {
    assert.equal(policyForRequest('GET', path, CONFIG)?.name, 'board', path);
  }
});

test('the board limit is tighter than the general one, which is the entire point', () => {
  const board = policyForRequest('GET', '/jobs', CONFIG)!;
  const general = policyForRequest('GET', '/profile', CONFIG)!;
  assert.ok(
    board.limit < general.limit,
    `board allows ${board.limit}/window and general allows ${general.limit}. A board policy that ` +
      'is not tighter than general is dead configuration.',
  );
});

/* Keyed by IP, and this product's users are students, so a university NAT puts a whole campus
   behind one address. A limit tuned to a single human locks out a lecture hall. */
test('the board limit leaves room for many people behind one shared address', () => {
  const board = policyForRequest('GET', '/jobs', CONFIG)!;
  assert.ok(
    board.limit >= 60,
    `${board.limit}/minute is too tight for a shared campus IP, which is the common case here`,
  );
});

/* A route added under /jobs later must inherit the board policy rather than silently falling back
   to general, which is why the match is a prefix and not a list of exact paths. */
test('a future /jobs route inherits the board policy without being listed', () => {
  assert.equal(policyForRequest('GET', '/jobs/anything/new', CONFIG)?.name, 'board');
});

test('a path that merely starts with the same letters is not a board route', () => {
  assert.equal(policyForRequest('GET', '/jobsearch', CONFIG)?.name, 'general');
});
