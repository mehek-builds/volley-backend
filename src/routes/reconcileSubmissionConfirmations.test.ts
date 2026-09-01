import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import {
  type ReconcileSubmissionConfirmationsDependencies,
  reconcileSubmissionConfirmationsRoutes,
} from './reconcileSubmissionConfirmations';

const secret = 'reconcile-confirmations-route-test-secret';
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

const counts = { scanned: 3, resolved: 2, unchanged: 1, reasons: { already_submitted: 1 } };

function harness(overrides: Partial<ReconcileSubmissionConfirmationsDependencies> = {}) {
  const calls: Array<{ userId?: string; limit?: number } | undefined> = [];
  const dependencies: ReconcileSubmissionConfirmationsDependencies = {
    reconcile: async (input) => {
      calls.push(input);
      return counts;
    },
    ...overrides,
  };
  return { calls, dependencies };
}

async function withApp(
  dependencies: ReconcileSubmissionConfirmationsDependencies,
  run: (app: Awaited<ReturnType<typeof Fastify>>) => Promise<void>,
): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(reconcileSubmissionConfirmationsRoutes, { dependencies });
  await app.ready();
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

const url = '/internal/reconcile-submission-confirmations';
const authorizedHeaders = { 'x-internal-secret': secret };

test('an authorized call runs the reconciler and returns its counts', async () => {
  const h = harness();
  await withApp(h.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), counts);
    // No limit given, so the reconciler is left to its own default rather than a forged one.
    assert.deepEqual(h.calls, [{}]);
  });
});

test('a positive integer limit is forwarded; anything else is ignored', async () => {
  for (const [query, expected] of [
    ['?limit=25', { limit: 25 }],
    ['?limit=0', {}],
    ['?limit=-4', {}],
    ['?limit=abc', {}],
    ['?limit=25abc', {}],
    ['?limit=3.9', {}],
    ['', {}],
  ] as const) {
    const h = harness();
    await withApp(h.dependencies, async (app) => {
      const response = await app.inject({ method: 'GET', url: `${url}${query}`, headers: authorizedHeaders });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(h.calls, [expected], `limit query "${query}"`);
    });
  }
});

test('an unauthorized call never reaches the reconciler', async () => {
  const h = harness();
  await withApp(h.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(h.calls, []);
  });
});

test('with no cron secret configured the endpoint refuses rather than running unauthenticated', async () => {
  const h = harness();
  await withEnv({ INTERNAL_CRON_SECRET: undefined, CRON_SECRET: undefined }, async () => {
    await withApp(h.dependencies, async (app) => {
      const response = await app.inject({ method: 'GET', url, headers: authorizedHeaders });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(h.calls, []);
    });
  });
});

test('POST is accepted for manual triggers, same guard and behaviour as GET', async () => {
  const h = harness();
  await withApp(h.dependencies, async (app) => {
    const response = await app.inject({ method: 'POST', url, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), counts);
    assert.deepEqual(h.calls, [{}]);
  });
});
