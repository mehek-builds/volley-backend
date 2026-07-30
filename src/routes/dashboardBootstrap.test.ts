import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import {
  composeDashboardBootstrap,
  dashboardBootstrapRoutes,
  type DashboardBootstrapResource,
} from './dashboardBootstrap';
import { createRateLimitHook, type RateLimitConfig } from '../middleware/rateLimit';

type CapturedRequest = {
  path: string;
  authorization?: string;
  client?: string;
  version?: string;
  ip: string;
};

async function bootstrapTestApp(
  failures: Partial<Record<DashboardBootstrapResource, number>> = {},
  generalLimit?: number,
) {
  const app = Fastify({ trustProxy: true, logger: false });
  const captured: CapturedRequest[] = [];
  if (generalLimit !== undefined) {
    const rateLimit: RateLimitConfig = {
      general: { name: 'general', limit: generalLimit, windowMs: 60_000 },
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
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/bootstrap',
        remoteAddress: '203.0.113.25',
        headers: {
          authorization: 'Bearer test-token',
          'x-litos-client': 'web',
          'x-litos-version': '1.2.3',
        },
      });

      assert.equal(response.statusCode, 200);
      assert.equal(response.headers.vary, 'Authorization');
      assert.equal(response.headers['cache-control'], 'private, max-age=15, stale-while-revalidate=30');
      assert.equal(captured.length, 8);
      assert.ok(captured.every((request) => request.authorization === 'Bearer test-token'));
      assert.ok(captured.every((request) => request.client === 'web'));
      assert.ok(captured.every((request) => request.version === '1.2.3'));
      assert.ok(captured.every((request) => request.ip === '203.0.113.25'));
    } finally {
      await app.close();
    }
  });

  test('degrades an optional dependency but propagates a critical dependency status', async () => {
    const optional = await bootstrapTestApp({ profile: 503 });
    try {
      const response = await optional.app.inject({
        method: 'GET',
        url: '/dashboard/bootstrap',
        headers: { authorization: 'Bearer test-token' },
      });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json().profile, { skills: [], target_roles: [] });
      assert.deepEqual(response.json().warnings, ['profile']);
    } finally {
      await optional.app.close();
    }

    const critical = await bootstrapTestApp({ jobs: 502 });
    try {
      const response = await critical.app.inject({
        method: 'GET',
        url: '/dashboard/bootstrap',
        headers: { authorization: 'Bearer test-token' },
      });
      assert.equal(response.statusCode, 502);
      assert.equal(response.json().error, 'jobs unavailable');
    } finally {
      await critical.app.close();
    }
  });

  test('reserves scarce rate-limit capacity for critical resources before optional reads', async () => {
    const { app } = await bootstrapTestApp({}, 2);
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/dashboard/bootstrap',
        headers: { authorization: 'Bearer test-token' },
        remoteAddress: '203.0.113.50',
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().me.email, 'me@example.com');
      assert.equal(response.json().jobs.jobs[0].id, 'job-1');
      assert.deepEqual(response.json().warnings, [
        'targeting',
        'profile',
        'resume_history',
        'application_profile',
        'outreach',
        'onboarding',
      ]);
    } finally {
      await app.close();
    }
  });
});
