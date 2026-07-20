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

test('route policy protects auth and download routes without charging probes or preflights', () => {
  assert.equal(policyForRequest('GET', '/health', CONFIG), null);
  assert.equal(policyForRequest('OPTIONS', '/auth/request-code', CONFIG), null);
  assert.equal(policyForRequest('POST', '/auth/request-code', CONFIG)?.name, 'auth_start');
  assert.equal(policyForRequest('POST', '/auth/verify-code', CONFIG)?.name, 'auth_verify');
  assert.equal(policyForRequest('GET', '/resume/download', CONFIG)?.name, 'resume_download');
  assert.equal(policyForRequest('GET', '/profile', CONFIG)?.name, 'general');
});
