import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import {
  type SubmissionConfirmationReconcilerDependencies,
  submissionConfirmationReconcilerRoutes,
} from './submissionConfirmationReconciler';

const secret = 'reconciler-route-test-secret';
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

function dependencyHarness(overrides: Partial<SubmissionConfirmationReconcilerDependencies> = {}) {
  const calls = { reconcile: 0 };
  const dependencies: SubmissionConfirmationReconcilerDependencies = {
    reconcile: async () => {
      calls.reconcile += 1;
      return { scanned: 5, resolved: 2, unchanged: 3, reasons: { already_submitted: 3 } };
    },
    ...overrides,
  };
  return { calls, dependencies };
}

async function buildTestApp(dependencies: SubmissionConfirmationReconcilerDependencies) {
  const app = Fastify({ logger: false });
  await app.register(submissionConfirmationReconcilerRoutes, { dependencies });
  await app.ready();
  return app;
}

async function withApp(
  dependencies: SubmissionConfirmationReconcilerDependencies,
  run: (app: Awaited<ReturnType<typeof buildTestApp>>) => Promise<void>,
): Promise<void> {
  const app = await buildTestApp(dependencies);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

const reconcilerUrl = '/internal/submission-confirmation-reconciler';
const authorizedHeaders = { 'x-internal-secret': secret };

test('an authorized pass runs the reconciler and reports its counters', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: reconcilerUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.scanned, 5);
    assert.equal(body.resolved, 2);
    assert.equal(body.unchanged, 3);
    assert.deepEqual(body.reasons, { already_submitted: 3 });
    assert.equal(typeof body.checked_at, 'string');
    assert.equal(harness.calls.reconcile, 1);
  });
});

test('POST behaves identically to the scheduled GET', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'POST', url: reconcilerUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    assert.equal(harness.calls.reconcile, 1);
  });
});

// Same shape as resumeRetention.test.ts's guard: turning either refusal into a 2xx produces the
// identical failure this route exists to avoid - a scheduler seeing success while nothing was
// reconciled, hiding the fact that stuck submissions are piling up unresolved.
test('an unconfigured cron secret is a 503 refusal, never a success', async () => {
  const harness = dependencyHarness();
  await withEnv({ INTERNAL_CRON_SECRET: undefined, CRON_SECRET: undefined }, async () => {
    await withApp(harness.dependencies, async (app) => {
      const response = await app.inject({ method: 'GET', url: reconcilerUrl, headers: authorizedHeaders });
      assert.equal(response.statusCode, 503);
      assert.match(response.json().error, /not configured/);
      assert.equal(harness.calls.reconcile, 0);
    });
  });
});

test('an unauthenticated caller is refused', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: reconcilerUrl });
    assert.equal(response.statusCode, 401);
    assert.equal(harness.calls.reconcile, 0);
  });
});

test('a failing reconcile pass is a 500, not a silently swallowed success', async () => {
  const harness = dependencyHarness({
    reconcile: async () => {
      throw new Error('database unavailable');
    },
  });
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: reconcilerUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: 'reconciliation failed' });
  });
});
