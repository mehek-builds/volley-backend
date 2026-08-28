import assert from 'node:assert/strict';
import { describe, mock, test } from 'node:test';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { SignJWT } from 'jose';
import {
  composeDashboardBootstrap,
  dashboardBootstrapRoutes,
  type DashboardBootstrapResource,
} from './dashboardBootstrap';
import { createRateLimitHook, type RateLimitConfig } from '../middleware/rateLimit';
import { db } from '../db';

type CapturedRequest = {
  path: string;
  authorization?: string;
  client?: string;
  version?: string;
  ip: string;
};

/* THE OUTER ROUTE NOW CARRIES A REAL `preHandler: requireAuth` (added alongside THE CARD GATE fix,
 * see dashboardBootstrap.ts), so the app.inject tests below need a genuine signed JWT and a mocked
 * user row rather than the bare "Bearer test-token" this file used before that -- requireAuth
 * verifies the token and reads the row itself; it does not trust a route-local stub the way the
 * FAKE per-resource routes registered below still do. Those fake routes are untouched: they exist
 * to isolate the aggregation behaviour (fan-out, fail-soft degrade, rate-limit ordering) from the
 * real sub-resource handlers, and none of that changes here. */
const JWT_SECRET = 'test-signing-secret-32-chars-minimum!!';

function mockedUserRow(overrides: Record<string, unknown> = {}) {
  return {
    session_valid_from: null,
    session_version: 0,
    email: 'student@example.com',
    is_guest: false,
    guest_expires_at: null,
    billing_provider: null,
    billing_customer_id: null,
    // Well before any CARD_GATE_FROM this test env might carry, and CARD_GATE_FROM is unset in
    // tests anyway -- either way this account is never locked unless a test overrides it.
    created_at: new Date('2020-01-01T00:00:00.000Z'),
    onboarding_completed_at: null,
    ...overrides,
  };
}

function signTestToken(userId: string): Promise<string> {
  return new SignJWT({ userId, isGuest: false, authMethod: 'password', sessionVersion: 0 })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(JWT_SECRET));
}

/** Signs a token AND mocks the db.select requireAuth/resolveToken issues, restoring both after. */
async function withAuthedRequest<T>(
  userRow: Record<string, unknown>,
  fn: (token: string) => Promise<T>,
): Promise<T> {
  const previousSecret = process.env.JWT_SIGNING_SECRET;
  process.env.JWT_SIGNING_SECRET = JWT_SECRET;
  const select = mock.method(db, 'select', (() => ({
    from: () => ({
      where: () => ({
        limit: async () => [userRow],
      }),
    }),
  })) as unknown as typeof db.select);
  try {
    const token = await signTestToken('dashboard-bootstrap-test-user');
    return await fn(token);
  } finally {
    select.mock.restore();
    if (previousSecret === undefined) delete process.env.JWT_SIGNING_SECRET;
    else process.env.JWT_SIGNING_SECRET = previousSecret;
  }
}

async function bootstrapTestApp(
  failures: Partial<Record<DashboardBootstrapResource, number>> = {},
  generalLimit?: number,
) {
  const app = Fastify({ trustProxy: true, logger: false });
  const captured: CapturedRequest[] = [];
  if (generalLimit !== undefined) {
    const rateLimit: RateLimitConfig = {
      general: { name: 'general', limit: generalLimit, windowMs: 60_000 },
      board: { name: 'board', limit: 90, windowMs: 60_000 },
      authStart: { name: 'auth_start', limit: 20, windowMs: 60_000 },
      authVerify: { name: 'auth_verify', limit: 40, windowMs: 60_000 },
      download: { name: 'resume_download', limit: 60, windowMs: 60_000 },
      maxKeys: 100,
    };
    app.addHook('onRequest', createRateLimitHook(rateLimit, () => 1_000));
  }
  const registerResource = (path: string, resource: DashboardBootstrapResource, body: unknown) => {
    app.get(path, async (request: FastifyRequest, reply) => {
      captured.push({
        path: request.url,
        authorization: request.headers.authorization,
        client: request.headers['x-litos-client'] as string | undefined,
        version: request.headers['x-litos-version'] as string | undefined,
        ip: request.ip,
      });
      if (!request.headers.authorization?.startsWith('Bearer ')) {
        return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
      }
      if (failures[resource]) {
        return reply.status(failures[resource]!).send({ error: `${resource} unavailable` });
      }
      return reply.status(200).send(body);
    });
  };

  registerResource('/me', 'me', { email: 'me@example.com' });
  registerResource('/jobs', 'jobs', { jobs: [{ id: 'job-1' }] });
  registerResource('/profile/targeting', 'targeting', { categories: ['engineering'] });
  registerResource('/profile', 'profile', { full_name: 'Me' });
  registerResource('/resume/history', 'resume_history', { resumes: [] });
  registerResource('/profile/application', 'application_profile', { address_city: 'Dubai' });
  registerResource('/track/events', 'outreach', []);
  registerResource('/onboarding/state', 'onboarding', { automatic_submission_enabled: true });
  await app.register(dashboardBootstrapRoutes);
  await app.ready();
  return { app, captured };
}

describe('dashboard bootstrap projection', () => {
  test('returns all resources through one versioned contract', async () => {
    const values: Record<DashboardBootstrapResource, unknown> = {
      me: { email: 'me@example.com' },
      jobs: { jobs: [{ id: 'job-1' }] },
      targeting: { categories: ['software-engineering'] },
      profile: { full_name: 'Me' },
      resume_history: { resumes: [{ id: 'resume-1' }] },
      application_profile: { address_city: 'Dubai' },
      outreach: [{ id: 'outreach-1' }],
      onboarding: { automatic_submission_enabled: true },
    };

    const result = await composeDashboardBootstrap(async (resource) => values[resource]);

    assert.equal(result.schema_version, 1);
    assert.deepEqual(result.jobs, values.jobs);
    assert.deepEqual(result.resume_history, values.resume_history);
    assert.deepEqual(result.warnings, []);
  });

  test('fails soft for optional resources and records which projections degraded', async () => {
    const result = await composeDashboardBootstrap(async (resource) => {
      if (resource === 'profile' || resource === 'outreach') throw new Error('temporarily unavailable');
      return resource === 'me' ? { email: null } : resource === 'jobs' ? { jobs: [] } : {};
    });

    assert.deepEqual(result.profile, { skills: [], target_roles: [] });
    assert.deepEqual(result.outreach, []);
    assert.deepEqual(result.warnings.sort(), ['outreach', 'profile']);
  });

  test('does not hide a critical identity or jobs failure', async () => {
    await assert.rejects(
      composeDashboardBootstrap(async (resource) => {
        if (resource === 'jobs') throw new Error('jobs unavailable');
        return {};
      }),
      /jobs unavailable/,
    );
  });

  test('starts optional projections without waiting for critical projections', async () => {
    let releaseCritical!: () => void;
    const criticalPending = new Promise<void>((resolve) => {
      releaseCritical = resolve;
    });
    const started: DashboardBootstrapResource[] = [];

    const resultPromise = composeDashboardBootstrap(async (resource) => {
      started.push(resource);
      if (resource === 'me' || resource === 'jobs') await criticalPending;
      return resource === 'jobs' ? { jobs: [] } : {};
    });

    await Promise.resolve();
    assert.equal(started.length, 8);
    assert.deepEqual(started.slice(0, 2), ['me', 'jobs']);
    releaseCritical();
    await resultPromise;
  });

  test('requires authentication through the critical identity projection', async () => {
    const { app } = await bootstrapTestApp();
    try {
      const response = await app.inject({ method: 'GET', url: '/dashboard/bootstrap' });
      assert.equal(response.statusCode, 401);
      assert.equal(response.json().error, 'Missing or invalid Authorization header');
    } finally {
      await app.close();
    }
  });

  test('forwards caller identity, emits private cache headers, and preserves the caller IP', async () => {
    const { app, captured } = await bootstrapTestApp();
    try {
      await withAuthedRequest(mockedUserRow(), async (token) => {
        const response = await app.inject({
          method: 'GET',
          url: '/dashboard/bootstrap',
          remoteAddress: '203.0.113.25',
          headers: {
            authorization: `Bearer ${token}`,
            'x-litos-client': 'web',
            'x-litos-version': '1.2.3',
          },
        });

        assert.equal(response.statusCode, 200);
        assert.equal(response.headers.vary, 'Authorization');
        assert.equal(response.headers['cache-control'], 'private, max-age=15, stale-while-revalidate=30');
        assert.equal(captured.length, 8);
        assert.ok(captured.every((request) => request.authorization === `Bearer ${token}`));
        assert.ok(captured.every((request) => request.client === 'web'));
        assert.ok(captured.every((request) => request.version === '1.2.3'));
        assert.ok(captured.every((request) => request.ip === '203.0.113.25'));
      });
    } finally {
      await app.close();
    }
  });

  test('degrades an optional dependency but propagates a critical dependency status', async () => {
    const optional = await bootstrapTestApp({ profile: 503 });
    try {
      await withAuthedRequest(mockedUserRow(), async (token) => {
        const response = await optional.app.inject({
          method: 'GET',
          url: '/dashboard/bootstrap',
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.json().profile, { skills: [], target_roles: [] });
        assert.deepEqual(response.json().warnings, ['profile']);
      });
    } finally {
      await optional.app.close();
    }

    const critical = await bootstrapTestApp({ jobs: 502 });
    try {
      await withAuthedRequest(mockedUserRow(), async (token) => {
        const response = await critical.app.inject({
          method: 'GET',
          url: '/dashboard/bootstrap',
          headers: { authorization: `Bearer ${token}` },
        });
        assert.equal(response.statusCode, 502);
        assert.equal(response.json().error, 'jobs unavailable');
      });
    } finally {
      await critical.app.close();
    }
  });

  test('reserves scarce rate-limit capacity for critical resources before optional reads', async () => {
    const { app } = await bootstrapTestApp({}, 2);
    try {
      await withAuthedRequest(mockedUserRow(), async (token) => {
        const response = await app.inject({
          method: 'GET',
          url: '/dashboard/bootstrap',
          headers: { authorization: `Bearer ${token}` },
          remoteAddress: '203.0.113.50',
        });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().me.email, 'me@example.com');
        assert.equal(response.json().jobs.jobs[0].id, 'job-1');
        /* `targeting` used to appear at the head of this list and no longer does, which is a real
           behaviour change and not a fixture adjustment.
           The bootstrap fans out through fastify.inject preserving the caller's IP, so each inner
           read is metered individually. /jobs was charged to `general` alongside the seven profile
           reads, so with only 2 general slots the board consumed one of them. It now draws on the
           separate `board` policy (added for Neon transfer, see middleware/rateLimit.ts), which
           leaves that slot for the next resource in priority order. One MORE critical resource
           survives a capacity crunch than before, which is the direction this test wants. */
        assert.deepEqual(response.json().warnings, [
          'profile',
          'resume_history',
          'application_profile',
          'outreach',
          'onboarding',
        ]);
        assert.equal(
          response.json().targeting != null,
          true,
          'targeting must now survive, because the board no longer competes for general capacity',
        );
      });
    } finally {
      await app.close();
    }
  });

  /* FINDING 3, the specific regression a code review caught (2026-08-29): this aggregate route had
   * no preHandler of its own, so a locked account's session could always reach it at 200 even once
   * THE CARD GATE was enforced everywhere else -- 'me' is TIER A (always reachable) and 'jobs' was
   * either unenforced entirely (Finding 2, before that fix) or, after it, still reachable through
   * TIER B2 for as long as the account had not finished its one onboarding application. Hitting
   * this exact route (not just requireAuth in isolation) is the point of this test: it is the
   * aggregate endpoint a locked account would actually poll to browse the dashboard for free. */
  test('THE CARD GATE: a locked account is turned away from the aggregate route itself', async () => {
    const { app } = await bootstrapTestApp();
    try {
      await withAuthedRequest(
        mockedUserRow({
          created_at: new Date('2026-08-20T00:00:00.000Z'),
          onboarding_completed_at: new Date('2026-08-20T00:00:00.000Z'),
        }),
        async (token) => {
          const previousGate = process.env.CARD_GATE_FROM;
          process.env.CARD_GATE_FROM = '2026-08-19T00:00:00.000Z';
          try {
            const response = await app.inject({
              method: 'GET',
              url: '/dashboard/bootstrap',
              headers: { authorization: `Bearer ${token}` },
            });
            assert.equal(response.statusCode, 402);
            assert.equal(response.json().code, 'payment_method_required');
          } finally {
            if (previousGate === undefined) delete process.env.CARD_GATE_FROM;
            else process.env.CARD_GATE_FROM = previousGate;
          }
        },
      );
    } finally {
      await app.close();
    }
  });
});
