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
  assert.equal(policyForRequest('OPTIONS', '/auth/request-code', CONFIG), null);
  assert.equal(policyForRequest('POST', '/auth/request-code', CONFIG)?.name, 'auth_start');
  assert.equal(policyForRequest('POST', '/auth/verify-code', CONFIG)?.name, 'auth_verify');
  assert.equal(policyForRequest('POST', '/auth/google', CONFIG)?.name, 'auth_verify');
  assert.equal(policyForRequest('GET', '/resume/download', CONFIG)?.name, 'resume_download');
  assert.equal(policyForRequest('GET', '/profile', CONFIG)?.name, 'general');
});
