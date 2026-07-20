import type { FastifyReply, FastifyRequest } from 'fastify';

const MINUTE_MS = 60_000;

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
  lastSeenAt: number;
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

  constructor(
    private readonly maxKeys: number,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.buckets.size;
  }

  consume(key: string, policy: RateLimitPolicy): RateLimitResult {
    const now = this.now();
    let bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      if (!bucket) this.makeRoom(now);
      bucket = { count: 0, resetAt: now + policy.windowMs, lastSeenAt: now };
      this.buckets.set(key, bucket);
    }

    bucket.count += 1;
    bucket.lastSeenAt = now;

    return {
      allowed: bucket.count <= policy.limit,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  private makeRoom(now: number): void {
    if (this.buckets.size < this.maxKeys) return;

    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
    if (this.buckets.size < this.maxKeys) return;

    let oldestKey: string | undefined;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.lastSeenAt < oldestSeenAt) {
        oldestKey = key;
        oldestSeenAt = bucket.lastSeenAt;
      }
    }
    if (oldestKey) this.buckets.delete(oldestKey);
  }
}

const UNMETERED_PATHS = new Set(['/health', '/v1/meta', '/install', '/privacy']);

export function policyForRequest(method: string, path: string, config: RateLimitConfig): RateLimitPolicy | null {
  if (method === 'OPTIONS' || UNMETERED_PATHS.has(path)) return null;
  if (path === '/auth/request-code' || path === '/auth/session') return config.authStart;
  if (path === '/auth/verify-code') return config.authVerify;
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
      error: 'Too many requests. Try again after the retry window.',
      code: 'rate_limited',
      scope: policy.name,
      retry_after_seconds: result.retryAfterSeconds,
    });
  };
}
