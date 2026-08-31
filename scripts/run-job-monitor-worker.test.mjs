import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createJsonRequester,
  inventoryFloorAssessment,
  loadConfig,
  runCompleteDrain,
  runWorkerLoop,
} from './run-job-monitor-worker.mjs';

const DRAIN_STARTED_AT = '2026-08-30T10:15:00.000Z';

function initializedDrainPath(drainStartedAt = DRAIN_STARTED_AT) {
  return `/internal/job-monitor?drain_started_at=${encodeURIComponent(drainStartedAt)}&initialize_drain=true`;
}

function monitor(status, {
  drainStartedAt = DRAIN_STARTED_AT,
  pollingComplete,
  surfacedPostings = 500_000,
  surfacedGroupedRoles = 50_000,
  surfacedSponsorOnlyJobs = 5_000,
  certifiedUniqueJobs = surfacedPostings,
  certifiedUniqueGroupedRoles = surfacedGroupedRoles,
  certifiedUniqueSponsorJobs = surfacedSponsorOnlyJobs,
  gateEnabled = true,
  includeSponsorFloor = true,
  metricsDeferred,
  metricsError,
  metricsStage,
  metricsTimeoutMs,
} = {}) {
  const body = {
    polling_complete: pollingComplete,
    drain_started_at: drainStartedAt,
    results: [],
    selected_sources: pollingComplete ? 0 : 400,
    deferred_sources: pollingComplete ? 0 : 1,
    failed: 0,
    surfaced_postings: surfacedPostings,
    surfaced_grouped_roles: surfacedGroupedRoles,
    surfaced_sponsor_only_jobs: surfacedSponsorOnlyJobs,
    certified_unique_jobs: certifiedUniqueJobs,
    certified_unique_grouped_roles: certifiedUniqueGroupedRoles,
    certified_unique_sponsor_jobs: certifiedUniqueSponsorJobs,
    certified_unique_internships: 1,
    minimum_surfaced_jobs: 500_000,
    minimum_surfaced_grouped_roles: 50_000,
    minimum_certified_unique_jobs: 500_000,
    minimum_certified_unique_grouped_roles: 50_000,
    public_verified_evidence_gate_enabled: gateEnabled,
    board_health: status === 200 ? 'low' : 'breached',
  };
  if (includeSponsorFloor) {
    body.minimum_sponsor_surfaced_jobs = 5_000;
    body.minimum_certified_unique_sponsor_jobs = 5_000;
  }
  if (metricsDeferred !== undefined) body.metrics_deferred = metricsDeferred;
  if (metricsError !== undefined) body.metrics_error = metricsError;
  if (metricsStage !== undefined) body.metrics_stage = metricsStage;
  if (metricsTimeoutMs !== undefined) body.metrics_timeout_ms = metricsTimeoutMs;
  return { status, body, error: null };
}

function logos(verificationComplete, { retryAfterMs = 0, scheduledTransientSources = 0 } = {}) {
  return {
    status: 200,
    body: {
      verification_complete: verificationComplete,
      selected_sources: verificationComplete ? 0 : 100,
      verified_sources: verificationComplete ? 0 : 100,
      failed_sources: 0,
      remaining_sources: verificationComplete ? 0 : 1,
      scheduled_transient_sources: scheduledTransientSources,
      retry_after_ms: retryAfterMs,
    },
    error: null,
  };
}

function testConfig(overrides = {}) {
  return {
    apiBase: 'https://litos.example',
    secret: 'test-secret',
    deployedSha: 'railway-deployed-sha',
    retryMs: 37,
    floorBreachRetryMs: 370,
    cycleIntervalMs: 999,
    logoLimit: 100,
    maxPasses: 10,
    finalRecountMaxAttempts: 10,
    metricsTimeoutMaxAttempts: 3,
    requestTimeoutMs: 1_000,
    ...overrides,
  };
}

function sequenceRequester(sequence) {
  const calls = [];
  const requestJson = async (path) => {
    calls.push(path);
    const next = sequence.shift();
    assert.ok(next, `unexpected request for ${path}`);
    assert.equal(path, next.path);
    return next.response;
  };
  return { requestJson, calls };
}

function silentLogger() {
  const messages = { log: [], error: [] };
  return {
    messages,
    logger: {
      log(value) { messages.log.push(JSON.parse(value)); },
      error(value) { messages.error.push(JSON.parse(value)); },
    },
  };
}

test('timeout and malformed initialization retries keep the same client-owned cursor and flag', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const sequence = [
    { path: initializedDrainPath(), response: { status: 0, body: null, error: 'request timed out' } },
    { path: initializedDrainPath(), response: { status: 200, body: null, error: null } },
    { path: initializedDrainPath(), response: monitor(200, { pollingComplete: true }) },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true }) },
  ];
  let activeRequests = 0;
  let maximumActiveRequests = 0;
  const calls = [];
  const requestJson = async (path) => {
    activeRequests += 1;
    maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests);
    calls.push(path);
    const next = sequence.shift();
    assert.ok(next, `unexpected request for ${path}`);
    assert.equal(path, next.path);
    await Promise.resolve();
    activeRequests -= 1;
    return next.response;
  };
  const sleeps = [];

  const result = await runCompleteDrain({
    config: testConfig(),
    requestJson,
    sleepFn: async (milliseconds) => { sleeps.push(milliseconds); },
    logger: silentLogger().logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });

  assert.equal(result.certified, true);
  assert.equal(result.drain_started_at, DRAIN_STARTED_AT);
  assert.equal(maximumActiveRequests, 1);
  assert.deepEqual(sleeps, [37, 37]);
  assert.equal(calls.includes('/internal/job-monitor'), false);
  assert.equal(calls.filter((path) => path === initializedDrainPath()).length, 3);
  assert.equal(calls.filter((path) => path === drainPath).length, 1);
  assert.equal(sequence.length, 0);
});

test('the JSON requester rejects an overlapping local request', async () => {
  let releaseFetch;
  const pendingResponse = new Promise((resolve) => {
    releaseFetch = () => resolve({
      status: 200,
      json: async () => ({ ok: true }),
    });
  });
  const requestJson = createJsonRequester(
    testConfig(),
    async () => pendingResponse,
  );

  const first = requestJson('/first');
  await Promise.resolve();
  const overlapping = await requestJson('/second');
  assert.deepEqual(overlapping, {
    status: 0,
    body: null,
    error: 'A job monitor request is already in flight',
  });
  releaseFetch();
  assert.deepEqual(await first, {
    status: 200,
    body: { ok: true },
    error: null,
  });
});

test('the outer worker keeps its cursor when a bounded drain attempt throws', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const sequence = [
    { path: initializedDrainPath(), response: { status: 0, body: null, error: 'request timed out' } },
    { path: initializedDrainPath(), response: monitor(200, { pollingComplete: true }) },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true }) },
  ];
  const requester = sequenceRequester(sequence);
  const sleeps = [];
  let stopping = false;

  await runWorkerLoop({
    config: testConfig({ maxPasses: 1, resumeDrainStartedAt: DRAIN_STARTED_AT }),
    requestJson: requester.requestJson,
    sleepFn: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (milliseconds === 999) stopping = true;
    },
    shouldStop: () => stopping,
    logger: silentLogger().logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });

  assert.equal(sequence.length, 0);
  assert.deepEqual(sleeps, [37, 37, 999]);
  assert.equal(requester.calls.includes('/internal/job-monitor'), false);
  assert.equal(requester.calls.filter((path) => path === initializedDrainPath()).length, 2);
  assert.equal(requester.calls.filter((path) => path === drainPath).length, 1);
});

test('a completed queue always gets a fresh HTTP 200 final recount before completion', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const sequence = [
    { path: initializedDrainPath(), response: monitor(500, { pollingComplete: false, surfacedPostings: 2 }) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(500, { pollingComplete: true, surfacedPostings: 3 }) },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true }) },
  ];
  const requester = sequenceRequester(sequence);
  const sleeps = [];
  const { logger, messages } = silentLogger();

  const result = await runCompleteDrain({
    config: testConfig(),
    requestJson: requester.requestJson,
    sleepFn: async (milliseconds) => { sleeps.push(milliseconds); },
    logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });

  assert.deepEqual(result, {
    certified: true,
    drain_started_at: DRAIN_STARTED_AT,
    passes: 2,
    final_recount_attempts: 1,
    surfaced_postings: 500_000,
    surfaced_grouped_roles: 50_000,
    surfaced_sponsor_only_jobs: 5_000,
    certified_unique_jobs: 500_000,
    certified_unique_grouped_roles: 50_000,
    certified_unique_sponsor_jobs: 5_000,
  });
  assert.equal(sequence.length, 0);
  assert.deepEqual(sleeps, [], 'successful queue completion must go straight to the final recount');
  assert.equal(messages.log.at(-1).event, 'final_monitor_recount');
  assert.equal(messages.log.at(-1).certified, true);
});

test('a final structured HTTP 500 returns a noncertified result and never proves completion', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const sequence = [
    { path: initializedDrainPath(), response: monitor(500, { pollingComplete: true, surfacedPostings: 499_999 }) },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(500, { pollingComplete: true, surfacedPostings: 499_999 }) },
  ];
  const requester = sequenceRequester(sequence);
  const sleeps = [];
  const { logger, messages } = silentLogger();

  const result = await runCompleteDrain({
    config: testConfig({ maxPasses: 1 }),
    requestJson: requester.requestJson,
    sleepFn: async (milliseconds) => { sleeps.push(milliseconds); },
    logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });

  assert.equal(result.certified, false);
  assert.equal(result.reason, 'inventory_floor_breach');
  assert.equal(result.final_recount_attempts, 1);
  assert.equal(result.drain_started_at, DRAIN_STARTED_AT);
  assert.deepEqual(sleeps, [], 'the outer worker owns the longer floor-breach interval');
  assert.equal(messages.error.some((entry) => entry.event === 'final_inventory_floor_breach'), true);
  assert.equal(messages.log.filter((entry) => entry.event === 'final_monitor_recount').length, 1);
});

test('HTTP 200 without complete floor evidence is not accepted as final proof', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const sequence = [
    { path: initializedDrainPath(), response: monitor(200, { pollingComplete: true }) },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true, includeSponsorFloor: false }) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true, metricsDeferred: true }) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true }) },
  ];
  const requester = sequenceRequester(sequence);
  const sleeps = [];
  const { logger, messages } = silentLogger();

  const result = await runCompleteDrain({
    config: testConfig(),
    requestJson: requester.requestJson,
    sleepFn: async (milliseconds) => { sleeps.push(milliseconds); },
    logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });

  assert.equal(result.final_recount_attempts, 3);
  assert.deepEqual(sleeps, [37, 37]);
  assert.equal(messages.error[0].event, 'final_inventory_not_certified');
  assert.equal(messages.error[0].inventory_floors_valid, false);
  assert.equal(messages.error[1].metrics_complete, false);
});

test('the final logo check can reopen its queue without changing drain_started_at', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const sequence = [
    { path: initializedDrainPath(), response: monitor(200, { pollingComplete: true }) },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(false) },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true }) },
  ];
  const requester = sequenceRequester(sequence);
  const sleeps = [];

  const result = await runCompleteDrain({
    config: testConfig(),
    requestJson: requester.requestJson,
    sleepFn: async (milliseconds) => { sleeps.push(milliseconds); },
    logger: silentLogger().logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });

  assert.equal(result.drain_started_at, DRAIN_STARTED_AT);
  assert.equal(result.certified, true);
  assert.equal(result.passes, 2);
  assert.deepEqual(sleeps, []);
  assert.equal(requester.calls.filter((path) => path === '/internal/job-monitor').length, 0);
  assert.equal(requester.calls.filter((path) => path === initializedDrainPath()).length, 1);
  assert.equal(requester.calls.filter((path) => path === drainPath).length, 1);
});

test('a deferred transient logo retry sleeps without resetting the drain cursor', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const sequence = [
    { path: initializedDrainPath(), response: monitor(200, { pollingComplete: true }) },
    {
      path: logoPath,
      response: logos(false, { retryAfterMs: 123, scheduledTransientSources: 1 }),
    },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true }) },
  ];
  const requester = sequenceRequester(sequence);
  const sleeps = [];
  const { logger, messages } = silentLogger();

  const result = await runCompleteDrain({
    config: testConfig(),
    requestJson: requester.requestJson,
    sleepFn: async (milliseconds) => { sleeps.push(milliseconds); },
    logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });

  assert.equal(result.certified, true);
  assert.equal(result.drain_started_at, DRAIN_STARTED_AT);
  assert.deepEqual(sleeps, [123]);
  assert.equal(messages.log.some((entry) => entry.event === 'logo_transient_retry_scheduled'), true);
  assert.equal(requester.calls.filter((path) => path === '/internal/job-monitor').length, 0);
});

test('floor assessment enforces only configured hard floors', () => {
  const healthy = monitor(200, { pollingComplete: true }).body;
  healthy.certified_unique_internships = 1;
  healthy.minimum_surfaced_internships = 2_000;
  healthy.internship_floor_enforced = false;
  assert.deepEqual(
    { valid: inventoryFloorAssessment(healthy).valid, met: inventoryFloorAssessment(healthy).met },
    { valid: true, met: true },
  );

  healthy.internship_floor_enforced = true;
  assert.deepEqual(
    { valid: inventoryFloorAssessment(healthy).valid, met: inventoryFloorAssessment(healthy).met },
    { valid: true, met: false },
  );
});

test('raw aliases cannot satisfy a certified unique floor', () => {
  const aliased = monitor(200, {
    pollingComplete: true,
    surfacedPostings: 600_000,
    certifiedUniqueJobs: 499_999,
  }).body;
  assert.equal(inventoryFloorAssessment(aliased).valid, true);
  assert.equal(inventoryFloorAssessment(aliased).met, false);

  delete aliased.certified_unique_jobs;
  assert.equal(inventoryFloorAssessment(aliased).valid, false,
    'missing unique evidence must fail closed');
});

test('the worker waits for the public evidence gate before certifying', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const sequence = [
    { path: initializedDrainPath(), response: monitor(200, { pollingComplete: true }) },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true, gateEnabled: false }) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true, gateEnabled: true }) },
  ];
  const requester = sequenceRequester(sequence);
  const sleeps = [];
  const { logger, messages } = silentLogger();
  const result = await runCompleteDrain({
    config: testConfig(),
    requestJson: requester.requestJson,
    sleepFn: async (milliseconds) => { sleeps.push(milliseconds); },
    logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });
  assert.equal(result.certified, true);
  assert.deepEqual(sleeps, [37]);
  assert.equal(messages.log.filter((entry) => entry.event === 'final_monitor_recount')[0].certified, false);
});

test('worker configuration validates origins, secrets, and safe integer bounds', () => {
  const defaults = loadConfig({
    LITOS_API_BASE: 'https://litos.example',
    INTERNAL_CRON_SECRET: 'secret',
    RAILWAY_GIT_COMMIT_SHA: 'railway-sha',
    GIT_SHA: 'fallback-sha',
  });
  assert.equal(defaults.logoLimit, 200);
  assert.equal(defaults.maxPasses, 10_000,
    'the default must cover a full 35,000-source logo and polling drain without resetting proof');
  assert.equal(defaults.cycleIntervalMs, 2 * 60 * 60 * 1000,
    'the Railway worker replaces the prior sub-daily discovery cadence');
  assert.equal(defaults.deployedSha, 'railway-sha');
  assert.equal(defaults.requestTimeoutMs, 14 * 60_000,
    'the client must outlive the bounded nine-minute poll and post-poll metrics');
  assert.equal(defaults.resumeDrainStartedAt, null);

  const fallbackRevision = loadConfig({
    LITOS_API_BASE: 'https://litos.example',
    INTERNAL_CRON_SECRET: 'secret',
    GIT_SHA: 'fallback-sha',
  });
  assert.equal(fallbackRevision.deployedSha, 'fallback-sha');

  const config = loadConfig({
    LITOS_API_BASE: 'https://litos.example/',
    INTERNAL_CRON_SECRET: '  secret  ',
    JOB_MONITOR_RETRY_MS: '1000',
    JOB_MONITOR_CYCLE_INTERVAL_MS: '2000',
    JOB_MONITOR_LOGO_LIMIT: '200',
    JOB_MONITOR_MAX_PASSES: '10000',
    JOB_MONITOR_FINAL_RECOUNT_MAX_ATTEMPTS: '25',
    JOB_MONITOR_REQUEST_TIMEOUT_MS: '900000',
    JOB_MONITOR_DRAIN_STARTED_AT: DRAIN_STARTED_AT,
  }, () => new Date('2026-08-30T10:16:00.000Z'));
  assert.equal(config.apiBase, 'https://litos.example');
  assert.equal(config.secret, 'secret');
  assert.equal(config.logoLimit, 200);
  assert.equal(config.maxPasses, 10_000);
  assert.equal(config.finalRecountMaxAttempts, 25);
  assert.equal(config.requestTimeoutMs, 900_000);
  assert.equal(config.resumeDrainStartedAt, DRAIN_STARTED_AT);
  assert.ok(config.floorBreachRetryMs > config.retryMs);

  assert.throws(
    () => loadConfig({ LITOS_API_BASE: 'https://litos.example/path', INTERNAL_CRON_SECRET: 'secret' }),
    /HTTP\(S\) origin/,
  );
  assert.throws(
    () => loadConfig({ LITOS_API_BASE: 'https://litos.example', INTERNAL_CRON_SECRET: '   ' }),
    /INTERNAL_CRON_SECRET/,
  );
  assert.throws(
    () => loadConfig({
      LITOS_API_BASE: 'https://litos.example',
      INTERNAL_CRON_SECRET: 'secret',
      JOB_MONITOR_LOGO_LIMIT: '201',
    }),
    /JOB_MONITOR_LOGO_LIMIT/,
  );
  assert.throws(
    () => loadConfig({
      LITOS_API_BASE: 'https://litos.example',
      INTERNAL_CRON_SECRET: 'secret',
      JOB_MONITOR_RETRY_MS: '9007199254740992',
    }),
    /JOB_MONITOR_RETRY_MS/,
  );
  assert.throws(
    () => loadConfig({
      LITOS_API_BASE: 'https://litos.example',
      INTERNAL_CRON_SECRET: 'secret',
      JOB_MONITOR_RETRY_MS: '1000',
      JOB_MONITOR_FLOOR_BREACH_RETRY_MS: '1000',
    }),
    /JOB_MONITOR_FLOOR_BREACH_RETRY_MS/,
  );
  assert.throws(
    () => loadConfig({
      LITOS_API_BASE: 'https://litos.example',
      INTERNAL_CRON_SECRET: 'secret',
      JOB_MONITOR_REQUEST_TIMEOUT_MS: '839999',
    }),
    /JOB_MONITOR_REQUEST_TIMEOUT_MS/,
  );
  assert.throws(
    () => loadConfig({
      LITOS_API_BASE: 'https://litos.example',
      INTERNAL_CRON_SECRET: 'secret',
      JOB_MONITOR_DRAIN_STARTED_AT: 'not-a-date',
    }),
    /JOB_MONITOR_DRAIN_STARTED_AT must be a valid timestamp/,
  );
  assert.throws(
    () => loadConfig({
      LITOS_API_BASE: 'https://litos.example',
      INTERNAL_CRON_SECRET: 'secret',
      JOB_MONITOR_DRAIN_STARTED_AT: '2026-08-30T10:16:00.001Z',
    }, () => new Date('2026-08-30T10:16:00.000Z')),
    /JOB_MONITOR_DRAIN_STARTED_AT cannot be in the future/,
  );
});

test('every transient final-recount failure class is bounded', async (t) => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const cases = {
    locked: { status: 409, body: null, error: null },
    network: { status: 0, body: null, error: 'network failed' },
    malformed_json: { status: 200, body: null, error: null },
    wrong_cursor: monitor(200, {
      pollingComplete: true,
      drainStartedAt: '2026-08-30T10:16:00.000Z',
    }),
    incomplete_http_200: monitor(200, {
      pollingComplete: true,
      includeSponsorFloor: false,
    }),
  };

  for (const [name, failure] of Object.entries(cases)) {
    await t.test(name, async () => {
      const sequence = [
        { path: initializedDrainPath(), response: monitor(200, { pollingComplete: true }) },
        { path: '/internal/job-monitor/verify-logos?limit=100', response: logos(true) },
        { path: '/internal/job-monitor/verify-logos?limit=100', response: logos(true) },
        { path: drainPath, response: failure },
        { path: '/internal/job-monitor/verify-logos?limit=100', response: logos(true) },
        { path: drainPath, response: failure },
      ];
      const requester = sequenceRequester(sequence);
      await assert.rejects(
        () => runCompleteDrain({
          config: testConfig({ finalRecountMaxAttempts: 2 }),
          requestJson: requester.requestJson,
          sleepFn: async () => undefined,
          logger: silentLogger().logger,
          now: () => new Date(DRAIN_STARTED_AT),
        }),
        /final recount did not certify within 2 attempts/,
      );
      assert.equal(sequence.length, 0);
    });
  }
});

test('the worker uses a longer floor backoff and starts the next drain with a fresh client cursor', async () => {
  const secondDrainStartedAt = '2026-08-30T11:15:00.000Z';
  const firstDrainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const secondDrainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(secondDrainStartedAt)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const sequence = [
    {
      path: initializedDrainPath(DRAIN_STARTED_AT),
      response: monitor(500, { pollingComplete: true, surfacedPostings: 499_999 }),
    },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: firstDrainPath, response: monitor(500, { pollingComplete: true, surfacedPostings: 499_999 }) },
    {
      path: initializedDrainPath(secondDrainStartedAt),
      response: monitor(200, { drainStartedAt: secondDrainStartedAt, pollingComplete: true }),
    },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    {
      path: secondDrainPath,
      response: monitor(200, { drainStartedAt: secondDrainStartedAt, pollingComplete: true }),
    },
  ];
  const requester = sequenceRequester(sequence);
  const sleeps = [];
  const { logger, messages } = silentLogger();
  let stopping = false;

  await runWorkerLoop({
    config: testConfig({ resumeDrainStartedAt: DRAIN_STARTED_AT }),
    requestJson: requester.requestJson,
    sleepFn: async (milliseconds) => {
      sleeps.push(milliseconds);
      if (milliseconds === 999) stopping = true;
    },
    shouldStop: () => stopping,
    logger,
    now: () => new Date(secondDrainStartedAt),
  });

  assert.equal(sequence.length, 0);
  assert.deepEqual(sleeps, [370, 999]);
  assert.equal(requester.calls.filter((path) => path === '/internal/job-monitor').length, 0);
  assert.equal(requester.calls.filter((path) => path === initializedDrainPath(DRAIN_STARTED_AT)).length, 1);
  assert.equal(requester.calls.filter((path) => path === firstDrainPath).length, 1);
  assert.equal(requester.calls.filter((path) => path === initializedDrainPath(secondDrainStartedAt)).length, 1);
  assert.equal(requester.calls.filter((path) => path === secondDrainPath).length, 1);
  const scheduled = messages.error.find((entry) => entry.event === 'inventory_floor_repoll_scheduled');
  assert.equal(scheduled.retry_ms, 370);
  assert.equal(scheduled.next_drain_uses_fresh_cursor, true);
  const completeDrains = messages.log.filter((entry) => entry.event === 'complete_drain');
  assert.equal(completeDrains.length, 1);
  const [completeDrain] = completeDrains;
  assert.ok(completeDrain);
  assert.equal(completeDrain.deployed_sha, 'railway-deployed-sha');
});

test('persistent projection timeout emits a distinct alert and never completes the drain', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const timedOut = () => monitor(503, {
    pollingComplete: true,
    metricsDeferred: true,
    metricsError: 'statement_timeout',
    metricsStage: 'group_projection_refresh',
    metricsTimeoutMs: 120_000,
  });
  const sequence = [
    { path: initializedDrainPath(), response: timedOut() },
    { path: '/internal/job-monitor/verify-logos?limit=100', response: logos(true) },
    { path: '/internal/job-monitor/verify-logos?limit=100', response: logos(true) },
    { path: drainPath, response: timedOut() },
    { path: '/internal/job-monitor/verify-logos?limit=100', response: logos(true) },
    { path: drainPath, response: timedOut() },
  ];
  const requester = sequenceRequester(sequence);
  const { logger, messages } = silentLogger();
  let stopping = false;

  await runWorkerLoop({
    config: testConfig({ metricsTimeoutMaxAttempts: 2 }),
    requestJson: requester.requestJson,
    sleepFn: async (milliseconds) => {
      if (milliseconds === 370) stopping = true;
    },
    shouldStop: () => stopping,
    logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });

  assert.equal(sequence.length, 0);
  assert.equal(messages.error.filter((entry) => entry.event === 'final_metrics_timeout').length, 2);
  const alert = messages.error.find((entry) => entry.event === 'persistent_metrics_timeout_alert');
  assert.ok(alert);
  assert.equal(alert.alert, true);
  assert.equal(alert.metrics_stage, 'group_projection_refresh');
  assert.equal(messages.log.filter((entry) => entry.event === 'complete_drain').length, 0);
});

test('only consecutive metrics timeouts trigger the persistent timeout result', async () => {
  const drainPath = `/internal/job-monitor?drain_started_at=${encodeURIComponent(DRAIN_STARTED_AT)}`;
  const logoPath = '/internal/job-monitor/verify-logos?limit=100';
  const timedOut = () => monitor(503, {
    pollingComplete: true,
    metricsDeferred: true,
    metricsError: 'statement_timeout',
    metricsStage: 'group_projection_refresh',
    metricsTimeoutMs: 120_000,
  });
  const sequence = [
    { path: initializedDrainPath(), response: monitor(200, { pollingComplete: true }) },
    { path: logoPath, response: logos(true) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: { status: 409, body: null, error: null } },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: timedOut() },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: monitor(200, { pollingComplete: true, includeSponsorFloor: false }) },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: timedOut() },
    { path: logoPath, response: logos(true) },
    { path: drainPath, response: timedOut() },
  ];
  const requester = sequenceRequester(sequence);
  const { logger, messages } = silentLogger();

  const result = await runCompleteDrain({
    config: testConfig({ metricsTimeoutMaxAttempts: 2 }),
    requestJson: requester.requestJson,
    sleepFn: async () => undefined,
    logger,
    now: () => new Date(DRAIN_STARTED_AT),
  });

  assert.equal(sequence.length, 0);
  assert.equal(result.certified, false);
  assert.equal(result.reason, 'metrics_timeout');
  assert.equal(result.final_recount_attempts, 5);
  assert.equal(result.metrics_timeout_attempts, 2);
  assert.deepEqual(
    messages.error
      .filter((entry) => entry.event === 'final_metrics_timeout')
      .map((entry) => [entry.attempt, entry.final_recount_attempt]),
    [[1, 2], [1, 4], [2, 5]],
  );
});
