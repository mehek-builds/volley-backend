import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import {
  type AutopilotMatcherDependencies,
  autopilotMatcherRoutes,
} from './autopilotMatcher';

const secret = 'autopilot-matcher-route-test-secret';
const previousInternalSecret = process.env.INTERNAL_CRON_SECRET;
const previousCronSecret = process.env.CRON_SECRET;

before(() => {
  process.env.INTERNAL_CRON_SECRET = secret;
  delete process.env.CRON_SECRET;
});

after(() => {
  if (previousInternalSecret === undefined) delete process.env.INTERNAL_CRON_SECRET;
  else process.env.INTERNAL_CRON_SECRET = previousInternalSecret;
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
});

async function withEnv(
  overrides: Record<string, string | undefined>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function dependencyHarness(overrides: Partial<AutopilotMatcherDependencies> = {}) {
  const calls = {
    eligibleUserIds: 0,
    hasQueuedWork: [] as string[],
    matchablePackets: [] as string[],
    mintToken: [] as string[],
    rankedJobs: [] as string[],
    queueSend: [] as string[],
  };
  const readyPacket = {
    id: 'packet-1',
    created_at: '2026-08-01T00:00:00.000Z',
    job_context: { company: 'Acme', role: 'Software Engineer Intern', job_id: 'job-1' },
    review: { status: 'ready_to_submit' as const, portal_supported: true },
    reviewUpdatedAt: '2026-08-01T00:00:00.000Z',
  };
  const dependencies: AutopilotMatcherDependencies = {
    eligibleUserIds: async () => {
      calls.eligibleUserIds += 1;
      return ['user-1'];
    },
    hasQueuedWork: async (userId) => {
      calls.hasQueuedWork.push(userId);
      return false;
    },
    matchablePackets: async (userId) => {
      calls.matchablePackets.push(userId);
      return [readyPacket];
    },
    mintToken: async (userId) => {
      calls.mintToken.push(userId);
      return 'internal-token';
    },
    rankedJobs: async () => {
      calls.rankedJobs.push('called');
      return [{ id: 'job-1', company_name: 'Acme', title: 'Software Engineer Intern' }];
    },
    queueSend: async (_fastify, _token, packet) => {
      calls.queueSend.push(packet.id);
      return { queued: true, statusCode: 200 };
    },
    ...overrides,
  };
  return { calls, dependencies, readyPacket };
}

async function buildTestApp(dependencies: AutopilotMatcherDependencies) {
  const app = Fastify({ logger: false });
  await app.register(autopilotMatcherRoutes, { dependencies });
  await app.ready();
  return app;
}

async function withApp(
  dependencies: AutopilotMatcherDependencies,
  run: (app: Awaited<ReturnType<typeof buildTestApp>>) => Promise<void>,
): Promise<void> {
  const app = await buildTestApp(dependencies);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

const matcherUrl = '/internal/autopilot-matcher';
const authorizedHeaders = { 'x-internal-secret': secret };

test('an eligible account with a ready match gets it queued', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: matcherUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      checked: 1,
      queued: 1,
      skipped_already_queued: 0,
      skipped_no_match: 0,
      failed: 0,
    });
    assert.deepEqual(harness.calls.queueSend, ['packet-1']);
    assert.deepEqual(harness.calls.mintToken, ['user-1']);
  });
});

test('an account that already has something queued is skipped, never double-queued', async () => {
  const harness = dependencyHarness({ hasQueuedWork: async () => true });
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: matcherUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.skipped_already_queued, 1);
    assert.equal(body.queued, 0);
    assert.deepEqual(harness.calls.mintToken, [], 'must not mint a token, let alone queue, for an account already in flight');
  });
});

test('an account with no current match is counted, not treated as a failure', async () => {
  const harness = dependencyHarness({ rankedJobs: async () => [] });
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: matcherUrl, headers: authorizedHeaders });
    const body = response.json();
    assert.equal(body.skipped_no_match, 1);
    assert.equal(body.queued, 0);
    assert.equal(body.failed, 0);
  });
});

test('a submit-request refusal is counted as failed, not silently dropped', async () => {
  const harness = dependencyHarness({ queueSend: async () => ({ queued: false, statusCode: 409 }) });
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: matcherUrl, headers: authorizedHeaders });
    const body = response.json();
    assert.equal(body.failed, 1);
    assert.equal(body.queued, 0);
  });
});

test('one account throwing does not stop the pass for the rest', async () => {
  const harness = dependencyHarness({
    eligibleUserIds: async () => ['user-broken', 'user-fine'],
    hasQueuedWork: async (userId) => {
      if (userId === 'user-broken') throw new Error('boom');
      return false;
    },
  });
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: matcherUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.checked, 2);
    assert.equal(body.failed, 1);
    assert.equal(body.queued, 1, 'user-fine must still be processed after user-broken throws');
  });
});

test('a token mint failure is counted as failed rather than crashing the pass', async () => {
  const harness = dependencyHarness({
    mintToken: async () => { throw new Error('no such user'); },
  });
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: matcherUrl, headers: authorizedHeaders });
    const body = response.json();
    assert.equal(body.failed, 1);
    assert.deepEqual(harness.calls.queueSend, [], 'must never attempt to queue without a token');
  });
});

test('an unconfigured cron secret is a 503 refusal, never a success', async () => {
  const harness = dependencyHarness();
  await withEnv({ INTERNAL_CRON_SECRET: undefined, CRON_SECRET: undefined }, async () => {
    await withApp(harness.dependencies, async (app) => {
      const response = await app.inject({ method: 'GET', url: matcherUrl, headers: authorizedHeaders });
      assert.equal(response.statusCode, 503);
      assert.equal(harness.calls.eligibleUserIds, 0);
    });
  });
});

test('an unauthenticated caller is refused', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: matcherUrl });
    assert.equal(response.statusCode, 401);
    assert.equal(harness.calls.eligibleUserIds, 0);
  });
});

test('POST behaves identically to the scheduled GET', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'POST', url: matcherUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().queued, 1);
  });
});
