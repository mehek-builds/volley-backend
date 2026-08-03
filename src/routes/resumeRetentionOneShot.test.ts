import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import Fastify from 'fastify';
import {
  LEGACY_ORIGINAL_CLEANUP_OPERATION_ID,
  RETENTION_OPERATION_COUNTER_KEY,
  RETENTION_OPERATION_COUNTER_KIND,
  type ResumeRetentionDependencies,
  resumeRetentionRoutes,
} from './resumeRetention';

const secret = 'retention-one-shot-test-secret';
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

function dependencyHarness() {
  let claimed = false;
  const calls = {
    claim: 0,
    sweep: 0,
    clear: 0,
    tuple: null as [string, string, string, number] | null,
  };
  const dependencies: ResumeRetentionDependencies = {
    claimCounterSlot: async (key, period, kind, limit) => {
      calls.claim += 1;
      calls.tuple = [key, period, kind, limit];
      if (claimed) return null;
      claimed = true;
      return 1;
    },
    sweepExpiredResumeBlobs: async () => {
      calls.sweep += 1;
      return { scanned: 4, deleted: 2 };
    },
    clearLegacyPointers: async () => {
      calls.clear += 1;
    },
  };
  return { calls, dependencies };
}

async function buildTestApp(dependencies: ResumeRetentionDependencies) {
  const app = Fastify({ logger: false });
  await app.register(resumeRetentionRoutes, { dependencies });
  await app.ready();
  return app;
}

const operationUrl =
  `/internal/resume-retention-sweep?run=${LEGACY_ORIGINAL_CLEANUP_OPERATION_ID}`;
const authorizedHeaders = { 'x-internal-secret': secret };

test('two concurrent one-shot requests allow exactly one sweep and pointer clear', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: operationUrl, headers: authorizedHeaders }),
      app.inject({ method: 'GET', url: operationUrl, headers: authorizedHeaders }),
    ]);
    assert.deepEqual(responses.map((response) => response.statusCode), [200, 200]);
    assert.equal(responses.filter((response) => response.json().already_processed === true).length, 1);
    assert.equal(harness.calls.sweep, 1);
    assert.equal(harness.calls.clear, 1);
    assert.deepEqual(harness.calls.tuple, [
      RETENTION_OPERATION_COUNTER_KEY,
      LEGACY_ORIGINAL_CLEANUP_OPERATION_ID,
      RETENTION_OPERATION_COUNTER_KIND,
      1,
    ]);
  } finally {
    await app.close();
  }
});

test('a duplicate completed operation is a 200 no-op', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const first = await app.inject({ method: 'GET', url: operationUrl, headers: authorizedHeaders });
    const duplicate = await app.inject({ method: 'GET', url: operationUrl, headers: authorizedHeaders });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(duplicate.json(), { already_processed: true });
    assert.equal(harness.calls.sweep, 1);
    assert.equal(harness.calls.clear, 1);
  } finally {
    await app.close();
  }
});

test('an unknown nonempty operation is rejected before claim or mutation', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/resume-retention-sweep?run=not-approved',
      headers: authorizedHeaders,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(harness.calls.claim, 0);
    assert.equal(harness.calls.sweep, 0);
    assert.equal(harness.calls.clear, 0);
  } finally {
    await app.close();
  }
});

test('the approved operation still requires cron authentication', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const response = await app.inject({ method: 'GET', url: operationUrl });
    assert.equal(response.statusCode, 401);
    assert.equal(harness.calls.claim, 0);
    assert.equal(harness.calls.sweep, 0);
    assert.equal(harness.calls.clear, 0);
  } finally {
    await app.close();
  }
});

test('the normal daily path remains unclaimed and performs the same sweep', async () => {
  const harness = dependencyHarness();
  const app = await buildTestApp(harness.dependencies);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/internal/resume-retention-sweep',
      headers: authorizedHeaders,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { scanned: 4, deleted: 2, retention_days: 30 });
    assert.equal(harness.calls.claim, 0);
    assert.equal(harness.calls.sweep, 1);
    assert.equal(harness.calls.clear, 1);
  } finally {
    await app.close();
  }
});

test('only the retention cron entry is temporarily activated', () => {
  const config = require('../../vercel.json') as {
    crons: Array<{ path: string; schedule: string }>;
  };
  assert.deepEqual(config.crons, [
    { path: '/internal/adapter-health-check', schedule: '0 13 * * *' },
    { path: operationUrl, schedule: '15 12 3 8 *' },
    { path: '/internal/job-monitor', schedule: '0 6 * * *' },
    { path: '/internal/application-submission-runner', schedule: '15 4 * * *' },
  ]);
});
