import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import {
  type ResumeRetentionDependencies,
  resumeRetentionRoutes,
} from './resumeRetention';

const secret = 'retention-route-test-secret';
const previousInternalSecret = process.env.INTERNAL_CRON_SECRET;
const previousCronSecret = process.env.CRON_SECRET;
const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;

before(() => {
  process.env.INTERNAL_CRON_SECRET = secret;
  delete process.env.CRON_SECRET;
  process.env.BLOB_READ_WRITE_TOKEN = 'test-blob-token';
});

after(() => {
  if (previousInternalSecret === undefined) delete process.env.INTERNAL_CRON_SECRET;
  else process.env.INTERNAL_CRON_SECRET = previousInternalSecret;
  if (previousCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = previousCronSecret;
  if (previousBlobToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
});

// The before() hook above sets both env vars for the whole file, which is exactly why the two
// silent-refusal guards went untested: nothing here could ever observe them unset. Tests that
// need a refusal borrow the environment for their duration and hand it back.
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

const LEGACY_ORIGINAL = 'users/user-a/resume.pdf';
const EXPIRED_GENERATED = 'users/user-b/resumes/old-application.pdf';

function dependencyHarness(overrides: Partial<ResumeRetentionDependencies> = {}) {
  const calls = {
    sweep: 0,
    clear: 0,
    purgeUsage: 0,
    purgeNetworkPreviews: 0,
    clearedUserIds: null as string[] | null,
  };
  const dependencies: ResumeRetentionDependencies = {
    sweepExpiredResumeBlobs: async () => {
      calls.sweep += 1;
      return {
        scanned: 4,
        deleted: 2,
        deletedPathnames: [LEGACY_ORIGINAL, EXPIRED_GENERATED],
      };
    },
    clearLegacyPointers: async (userIds) => {
      calls.clear += 1;
      calls.clearedUserIds = userIds;
    },
    purgeExpiredUsageResults: async () => {
      calls.purgeUsage += 1;
      return 3;
    },
    purgeExpiredNetworkPreviews: async () => {
      calls.purgeNetworkPreviews += 1;
      return 2;
    },
    ...overrides,
  };
  return { calls, dependencies };
}

async function buildTestApp(dependencies: ResumeRetentionDependencies) {
  const app = Fastify({ logger: false });
  await app.register(resumeRetentionRoutes, { dependencies });
  await app.ready();
  return app;
}

async function withApp(
  dependencies: ResumeRetentionDependencies,
  run: (app: Awaited<ReturnType<typeof buildTestApp>>) => Promise<void>,
): Promise<void> {
  const app = await buildTestApp(dependencies);
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

const sweepUrl = '/internal/resume-retention-sweep';
const authorizedHeaders = { 'x-internal-secret': secret };

test('the daily sweep runs unconditionally and reports what it deleted', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: sweepUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    // Both windows are reported, because a sweep that silently stopped covering one category is
    // exactly the failure this route exists to make visible. deleted_by_category and unclassified
    // are absent here only because this harness's sweep double does not compute them.
    assert.deepEqual(response.json(), {
      scanned: 4,
      deleted: 2,
      retention_days: 30,
      preview_retention_days: 7,
      expired_usage_receipts: 3,
      expired_network_previews: 2,
    });
    assert.equal(harness.calls.sweep, 1);
    assert.equal(harness.calls.clear, 1);
    assert.equal(harness.calls.purgeUsage, 1);
    assert.equal(harness.calls.purgeNetworkPreviews, 1);
  });
});

// The response body must not leak the object keys the sweep deleted: they embed user ids, and this
// endpoint's whole reason for existing is that blob keys are a capability.
test('the response never discloses the deleted object keys', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: sweepUrl, headers: authorizedHeaders });
    assert.doesNotMatch(response.body, /users\//);
  });
});

// Regression guard for the incident this endpoint is still recovering from. `?run=<operation id>`
// used to claim a one-shot counter slot and, once spent, short-circuit to `{already_processed:true}`
// at HTTP 200 without sweeping - which is how the sweep stayed dead for eight days while looking
// healthy. The machinery is gone, so no query string can gate the sweep any more. This asserts the
// property rather than the absence of the old constant: whatever a caller appends, the sweep runs.
test('no query string can turn the sweep into a no-op', async () => {
  for (const query of [
    '?run=issue-007-approved-legacy-original-cleanup-2026-08-03',
    '?run=anything-else',
    '?run=',
    '?dry=1',
  ]) {
    const harness = dependencyHarness();
    await withApp(harness.dependencies, async (app) => {
      const response = await app.inject({
        method: 'GET',
        url: `${sweepUrl}${query}`,
        headers: authorizedHeaders,
      });
      assert.equal(response.statusCode, 200, query);
      assert.equal(harness.calls.sweep, 1, `${query} must still sweep`);
      assert.notDeepEqual(response.json(), { already_processed: true }, query);
    });
  }
});

// The only previous guard on this ordering was profileRetentionContract.test.ts comparing the
// source-text positions of the two await expressions, which would still pass if the sweep were
// wrapped in a catch that swallowed the error and cleared pointers anyway. This asserts the
// behaviour: a sweep that throws must not be reported as success, and must not let the database
// forget pointers to files that are still in the store.
test('a failing sweep is a 500 and leaves legacy pointers untouched', async () => {
  const harness = dependencyHarness({
    sweepExpiredResumeBlobs: async () => {
      throw new Error('Blob store unavailable');
    },
  });
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: sweepUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: 'sweep failed' });
    assert.equal(harness.calls.clear, 0, 'pointers must not be cleared when deletion failed');
  });
});

// Both refusals below return 503, and the reason they need a test at all is that turning either one
// into a 2xx produces the identical failure shape to the `{"already_processed": true}` 200 that hid
// the dead sweep for eight days: a scheduler seeing success while no file is ever deleted.
test('an unconfigured cron secret is a 503 refusal, never a success', async () => {
  const harness = dependencyHarness();
  await withEnv({ INTERNAL_CRON_SECRET: undefined, CRON_SECRET: undefined }, async () => {
    await withApp(harness.dependencies, async (app) => {
      const response = await app.inject({ method: 'GET', url: sweepUrl, headers: authorizedHeaders });
      assert.equal(response.statusCode, 503);
      assert.match(response.json().error, /not configured/);
      assert.equal(harness.calls.sweep, 0);
      assert.equal(harness.calls.clear, 0);
    });
  });
});

test('a missing Blob token is a 503 refusal, never a success', async () => {
  const harness = dependencyHarness();
  await withEnv({ BLOB_READ_WRITE_TOKEN: undefined }, async () => {
    await withApp(harness.dependencies, async (app) => {
      const response = await app.inject({ method: 'GET', url: sweepUrl, headers: authorizedHeaders });
      assert.equal(response.statusCode, 503);
      assert.deepEqual(response.json(), { error: 'BLOB_READ_WRITE_TOKEN not configured' });
      assert.equal(harness.calls.sweep, 0, 'a sweep without a token would delete nothing and report success');
      assert.equal(harness.calls.clear, 0);
    });
  });
});

// An authenticated caller must not be able to reach the sweep while the store token is missing,
// and an unauthenticated one must not learn which of the two refusals applies. Ordering matters:
// the configuration check precedes the auth check deliberately, so a misconfigured deployment
// shouts 503 at Vercel Cron rather than 401ing and looking like a secret mismatch.
test('the unconfigured refusal precedes authentication', async () => {
  const harness = dependencyHarness();
  await withEnv({ INTERNAL_CRON_SECRET: undefined, CRON_SECRET: undefined }, async () => {
    await withApp(harness.dependencies, async (app) => {
      const response = await app.inject({ method: 'GET', url: sweepUrl });
      assert.equal(response.statusCode, 503);
      assert.equal(harness.calls.sweep, 0);
    });
  });
});

// The pointer clear used to be an unscoped UPDATE over every profile row. These two assert the
// scoping instead: only owners whose legacy original actually went, and nobody at all on the
// zero-legacy-original nights that are now every night.
test('pointers are cleared only for owners whose legacy original was deleted', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    await app.inject({ method: 'GET', url: sweepUrl, headers: authorizedHeaders });
    assert.deepEqual(
      harness.calls.clearedUserIds,
      ['user-a'],
      'user-b lost only a generated file, which no profile pointer refers to',
    );
  });
});

test('a sweep that deletes no legacy original clears no pointers', async () => {
  const harness = dependencyHarness({
    sweepExpiredResumeBlobs: async () => ({
      scanned: 900,
      deleted: 11,
      deletedPathnames: Array.from({ length: 11 }, (_, i) => `users/user-${i}/resumes/app-${i}.pdf`),
    }),
  });
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'GET', url: sweepUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      scanned: 900,
      deleted: 11,
      retention_days: 30,
      preview_retention_days: 7,
      expired_usage_receipts: 3,
      expired_network_previews: 2,
    });
    assert.deepEqual(harness.calls.clearedUserIds, [], 'no profile pointer is implicated');
  });
});

test('POST behaves identically to the scheduled GET', async () => {
  const harness = dependencyHarness();
  await withApp(harness.dependencies, async (app) => {
    const response = await app.inject({ method: 'POST', url: sweepUrl, headers: authorizedHeaders });
    assert.equal(response.statusCode, 200);
    assert.equal(harness.calls.sweep, 1);
    assert.deepEqual(harness.calls.clearedUserIds, ['user-a']);
  });
});
