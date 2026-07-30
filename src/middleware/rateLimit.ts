import type { FastifyReply, FastifyRequest } from 'fastify';

const MINUTE_MS = 60_000;
const MAX_POLICY_WINDOWS = 4;

export interface RateLimitPolicy {
  name: string;
  limit: number;
  windowMs: number;
}

export interface RateLimitConfig {
  general: RateLimitPolicy;
  authStart: RateLimitPolicy;
  authVerify: RateLimitPolicy;
  download: RateLimitPolicy;
  maxKeys: number;
}

interface Bucket {
  count: number;
  resetAt: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultRateLimitConfig(): RateLimitConfig {
  return {
    general: {
      name: 'general',
      limit: positiveInteger(process.env.RATE_LIMIT_GENERAL_PER_MINUTE, 180),
      windowMs: MINUTE_MS,
    },
    authStart: {
      name: 'auth_start',
      limit: positiveInteger(process.env.RATE_LIMIT_AUTH_PER_15_MINUTES, 20),
      windowMs: 15 * MINUTE_MS,
    },
    authVerify: {
      name: 'auth_verify',
      limit: positiveInteger(process.env.RATE_LIMIT_VERIFY_PER_15_MINUTES, 40),
      windowMs: 15 * MINUTE_MS,
    },
    download: {
      name: 'resume_download',
      limit: positiveInteger(process.env.RATE_LIMIT_DOWNLOAD_PER_MINUTE, 60),
      windowMs: MINUTE_MS,
    },
    maxKeys: positiveInteger(process.env.RATE_LIMIT_MAX_KEYS, 10_000),
  };
}

export class InMemoryRateLimitStore {
  private readonly buckets = new Map<string, Bucket>();
  private readonly expiryQueues = new Map<number, Map<string, Bucket>>();
  private lastNow = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly maxKeys: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  consume(key: string, policy: RateLimitPolicy): RateLimitResult {
    // Wall clocks can step backward after NTP or VM corrections. Clamp them so
    // insertion order remains expiration order within each policy window.
    const now = Math.max(this.lastNow, this.now());
    this.lastNow = now;
    let bucket = this.buckets.get(key);
    let created = false;

    if (!bucket || bucket.resetAt <= now) {
      if (bucket) this.removeBucket(key, bucket);
      this.purgeExpired(now);
      if (!this.expiryQueues.has(policy.windowMs) && this.expiryQueues.size >= MAX_POLICY_WINDOWS) {
        throw new RangeError(`Rate-limit store supports at most ${MAX_POLICY_WINDOWS} distinct windows`);
      }
      this.makeRoom();
      bucket = { count: 0, resetAt: now + policy.windowMs, windowMs: policy.windowMs };
      created = true;
    }

    bucket.count += 1;
    // Map insertion order is the LRU queue. Moving a hot bucket to the tail
    // keeps capacity eviction constant-time during high-cardinality churn.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    if (created) {
      let queue = this.expiryQueues.get(bucket.windowMs);
      if (!queue) {
        queue = new Map();
        this.expiryQueues.set(bucket.windowMs, queue);
      }
      queue.set(key, bucket);
    }

    return {
      allowed: bucket.count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  private removeBucket(key: string, bucket: Bucket): void {
    this.buckets.delete(key);
    const queue = this.expiryQueues.get(bucket.windowMs);
    queue?.delete(key);
    if (queue?.size === 0) this.expiryQueues.delete(bucket.windowMs);
  }

  private purgeExpired(now: number): void {
    // Each policy window has an insertion-ordered expiry queue. Within a
    // window, reset times are monotonic, so expired cleanup touches only the
    // queue heads instead of scanning every live client bucket.
    for (const [windowMs, queue] of this.expiryQueues) {
      while (queue.size > 0) {
        const oldestKey = queue.keys().next().value as string | undefined;
        if (oldestKey === undefined) break;
        const oldest = queue.get(oldestKey);
        if (!oldest || oldest.resetAt > now) break;
        this.removeBucket(oldestKey, oldest);
      }
      if (queue.size === 0) this.expiryQueues.delete(windowMs);
    }
  }

  private makeRoom(): void {
    if (this.buckets.size < this.maxKeys) return;
    const oldestKey = this.buckets.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    const oldest = this.buckets.get(oldestKey);
    if (oldest) this.removeBucket(oldestKey, oldest);
  }
}

// The bootstrap request fans into the same eight protected resource routes the dashboard used to
// call directly. Those internal requests remain metered, so charging the wrapper too would make a
// page load consume nine general requests instead of eight.
const UNMETERED_PATHS = new Set(['/health', '/v1/meta', '/install', '/privacy', '/dashboard/bootstrap']);

export function policyForRequest(method: string, path: string, config: RateLimitConfig): RateLimitPolicy | null {
  if (method === 'OPTIONS' || UNMETERED_PATHS.has(path)) return null;
  if (path === '/auth/request-code' || path === '/auth/session' || path === '/auth/password/login') {
    return config.authStart;
  }
  if (path === '/auth/verify-code' || path === '/auth/google' || path === '/auth/password') {
    return config.authVerify;
  }
  if (path === '/resume/download') return config.download;
  return config.general;
}

export function createRateLimitHook(
  config: RateLimitConfig = defaultRateLimitConfig(),
  now: () => number = Date.now,
) {
  const store = new InMemoryRateLimitStore(config.maxKeys, now);

  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const path = request.raw.url?.split('?')[0] || '/';
    const policy = policyForRequest(request.method, path, config);
    if (!policy) return;

    const result = store.consume(`${policy.name}:${request.ip}`, policy);
    const windowSeconds = Math.ceil(policy.windowMs / 1000);
    reply.header('RateLimit-Policy', `${result.limit};w=${windowSeconds}`);
    reply.header('RateLimit-Limit', String(result.limit));
    reply.header('RateLimit-Remaining', String(result.remaining));
    reply.header('RateLimit-Reset', String(result.retryAfterSeconds));

    if (result.allowed) return;

    reply.header('Retry-After', String(result.retryAfterSeconds));
    reply.header('Cache-Control', 'private, no-store');
    await reply.status(429).send({
      error: 'Too many tries. Wait a few minutes, then try again.',
      code: 'rate_limited',
      scope: policy.name,
      retry_after_seconds: result.retryAfterSeconds,
    });
  };
}
