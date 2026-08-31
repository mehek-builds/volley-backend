#!/usr/bin/env node

/**
 * Long-running Railway worker for the complete job and logo verification queues.
 *
 * One monitor request is intentionally bounded. This process keeps the same drain_started_at until
 * every enabled source has been attempted, drains the independent logo-proof queue, and then makes
 * a fresh monitor request for the final inventory recount. A structured HTTP 500 is expected while
 * either queue still has work, but it can never certify a completed drain. The long cycle sleep only
 * starts after a final HTTP 200 proves that polling is complete and every enforced inventory floor
 * is satisfied.
 */

import { pathToFileURL } from 'node:url';

const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_REQUEST_TIMEOUT_MS = 14 * 60_000;
const MINIMUM_REQUEST_TIMEOUT_MS = DEFAULT_REQUEST_TIMEOUT_MS;

export const INVENTORY_FLOOR_FIELDS = Object.freeze([
  Object.freeze({
    name: 'certified unique jobs',
    actual: 'certified_unique_jobs',
    minimum: 'minimum_certified_unique_jobs',
  }),
  Object.freeze({
    name: 'certified unique grouped roles',
    actual: 'certified_unique_grouped_roles',
    minimum: 'minimum_certified_unique_grouped_roles',
  }),
  Object.freeze({
    name: 'certified unique sponsor-only jobs',
    actual: 'certified_unique_sponsor_jobs',
    minimum: 'minimum_certified_unique_sponsor_jobs',
  }),
]);

function integerSetting(raw, fallback, { name, min = 1, max = Number.MAX_SAFE_INTEGER }) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function apiOrigin(raw) {
  if (!raw) throw new Error('LITOS_API_BASE is required');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LITOS_API_BASE must be a valid HTTP(S) origin');
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('LITOS_API_BASE must be the Railway web service HTTP(S) origin');
  }
  return url.origin;
}

function dateFromClock(now, name) {
  const value = now();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${name} must return a valid date`);
  return date;
}

function validatedDrainStartedAt(raw, now, name) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const value = String(raw).trim();
  if (!validDrainStartedAt(value)) throw new Error(`${name} must be a valid timestamp`);
  const parsed = new Date(value);
  if (parsed.getTime() > now.getTime()) throw new Error(`${name} cannot be in the future`);
  return parsed.toISOString();
}

export function loadConfig(environment = process.env, now = () => new Date()) {
  const secret = (environment.INTERNAL_CRON_SECRET ?? '').trim();
  if (!secret) throw new Error('INTERNAL_CRON_SECRET is required');

  const deployedSha = (environment.RAILWAY_GIT_COMMIT_SHA ?? '').trim()
    || (environment.GIT_SHA ?? '').trim()
    || null;
  const retryMs = integerSetting(environment.JOB_MONITOR_RETRY_MS, 30_000, {
    name: 'JOB_MONITOR_RETRY_MS',
    max: MAX_TIMER_MS - 1,
  });
  const defaultFloorBreachRetryMs = Math.min(
    MAX_TIMER_MS,
    Math.max(15 * 60 * 1000, retryMs * 10),
  );
  const floorBreachRetryMs = integerSetting(
    environment.JOB_MONITOR_FLOOR_BREACH_RETRY_MS,
    defaultFloorBreachRetryMs,
    {
      name: 'JOB_MONITOR_FLOOR_BREACH_RETRY_MS',
      min: retryMs + 1,
      max: MAX_TIMER_MS,
    },
  );

  return Object.freeze({
    apiBase: apiOrigin(environment.LITOS_API_BASE ?? ''),
    secret,
    deployedSha,
    retryMs,
    floorBreachRetryMs,
    cycleIntervalMs: integerSetting(
      environment.JOB_MONITOR_CYCLE_INTERVAL_MS,
      2 * 60 * 60 * 1000,
      { name: 'JOB_MONITOR_CYCLE_INTERVAL_MS', max: MAX_TIMER_MS },
    ),
    logoLimit: integerSetting(environment.JOB_MONITOR_LOGO_LIMIT, 200, {
      name: 'JOB_MONITOR_LOGO_LIMIT',
      max: 200,
    }),
    maxPasses: integerSetting(environment.JOB_MONITOR_MAX_PASSES, 10_000, {
      name: 'JOB_MONITOR_MAX_PASSES',
      max: 10_000,
    }),
    finalRecountMaxAttempts: integerSetting(
      environment.JOB_MONITOR_FINAL_RECOUNT_MAX_ATTEMPTS,
      20,
      { name: 'JOB_MONITOR_FINAL_RECOUNT_MAX_ATTEMPTS', max: 1_000 },
    ),
    metricsTimeoutMaxAttempts: integerSetting(
      environment.JOB_MONITOR_METRICS_TIMEOUT_MAX_ATTEMPTS,
      3,
      { name: 'JOB_MONITOR_METRICS_TIMEOUT_MAX_ATTEMPTS', max: 100 },
    ),
    requestTimeoutMs: integerSetting(
      environment.JOB_MONITOR_REQUEST_TIMEOUT_MS,
      DEFAULT_REQUEST_TIMEOUT_MS,
      {
        name: 'JOB_MONITOR_REQUEST_TIMEOUT_MS',
        min: MINIMUM_REQUEST_TIMEOUT_MS,
        max: MAX_TIMER_MS,
      },
    ),
    resumeDrainStartedAt: validatedDrainStartedAt(
      environment.JOB_MONITOR_DRAIN_STARTED_AT,
      dateFromClock(now, 'loadConfig clock'),
      'JOB_MONITOR_DRAIN_STARTED_AT',
    ),
  });
}

export function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function createJsonRequester(config, fetchImplementation = globalThis.fetch) {
  if (typeof fetchImplementation !== 'function') {
    throw new Error('This worker requires a runtime with fetch support');
  }
  let requestInFlight = false;
  return async function requestJson(path) {
    if (requestInFlight) {
      return {
        status: 0,
        body: null,
        error: 'A job monitor request is already in flight',
      };
    }
    requestInFlight = true;
    let response;
    try {
      response = await fetchImplementation(`${config.apiBase}${path}`, {
        headers: { 'x-internal-secret': config.secret, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
    } catch (error) {
      return { status: 0, body: null, error: error instanceof Error ? error.message : String(error) };
    } finally {
      requestInFlight = false;
    }
    let body = null;
    try { body = await response.json(); } catch { /* Invalid JSON is handled by the caller. */ }
    return { status: response.status, body, error: null };
  };
}

function validDrainStartedAt(value) {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(Date.parse(value));
}

export function structuredMonitor(result) {
  return result.body
    && typeof result.body === 'object'
    && typeof result.body.polling_complete === 'boolean'
    && validDrainStartedAt(result.body.drain_started_at)
    && Array.isArray(result.body.results);
}

function monitorMetricsTimedOut(result) {
  return structuredMonitor(result)
    && result.body.metrics_deferred === true
    && result.body.metrics_error === 'statement_timeout';
}

function nonnegativeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Return every hard inventory floor carried by the route's response. Internship inventory remains
 * informational unless the route explicitly marks that floor as enforced.
 */
export function inventoryFloorAssessment(body) {
  const definitions = [...INVENTORY_FLOOR_FIELDS];
  if (body?.internship_floor_enforced === true) {
    definitions.push({
      name: 'surfaced internships',
      actual: 'certified_unique_internships',
      minimum: 'minimum_surfaced_internships',
    });
  }

  const requirements = definitions.map((definition) => {
    const actual = body?.[definition.actual];
    const minimum = body?.[definition.minimum];
    const valid = nonnegativeCount(actual) && nonnegativeCount(minimum);
    return {
      ...definition,
      actual,
      minimum,
      valid,
      met: valid && actual >= minimum,
    };
  });
  return {
    valid: requirements.every((requirement) => requirement.valid),
    met: requirements.every((requirement) => requirement.met),
    requirements,
  };
}

function monitorPath(drainStartedAt) {
  return drainStartedAt
    ? `/internal/job-monitor?drain_started_at=${encodeURIComponent(drainStartedAt)}`
    : '/internal/job-monitor';
}

function sameDrain(body, drainStartedAt) {
  return !drainStartedAt || body.drain_started_at === drainStartedAt;
}

function logMonitorPass(logger, event, pass, monitor, drainStartedAt, extra = {}) {
  logger.log(JSON.stringify({
    event,
    pass,
    status: monitor.status,
    drain_started_at: drainStartedAt,
    polling_complete: monitor.body.polling_complete,
    selected_sources: monitor.body.selected_sources,
    deferred_sources: monitor.body.deferred_sources,
    failed_sources: monitor.body.failed,
    surfaced_postings: monitor.body.surfaced_postings,
    surfaced_grouped_roles: monitor.body.surfaced_grouped_roles,
    surfaced_sponsor_only_jobs: monitor.body.surfaced_sponsor_only_jobs,
    board_health: monitor.body.board_health,
    ...extra,
  }));
}

async function requestLogoStatus({ requestJson, config, logger, pass }) {
  const logos = await requestJson(`/internal/job-monitor/verify-logos?limit=${config.logoLimit}`);
  if (logos.status === 200
    && logos.body
    && typeof logos.body.verification_complete === 'boolean'
    && nonnegativeCount(logos.body.remaining_sources)
    && logos.body.verification_complete === (logos.body.remaining_sources === 0)) {
    const retryAfterMs = nonnegativeCount(logos.body.retry_after_ms)
      ? Math.min(MAX_TIMER_MS, logos.body.retry_after_ms)
      : 0;
    logger.log(JSON.stringify({
      event: 'logo_verification_pass',
      pass,
      verification_complete: logos.body.verification_complete,
      selected_sources: logos.body.selected_sources,
      verified_sources: logos.body.verified_sources,
      failed_sources: logos.body.failed_sources,
      transient_deferred_sources: logos.body.transient_deferred_sources,
      scheduled_transient_sources: logos.body.scheduled_transient_sources,
      remaining_sources: logos.body.remaining_sources,
      retry_after_ms: retryAfterMs,
    }));
    return { ok: true, complete: logos.body.verification_complete, retryAfterMs };
  }
  logger.error(JSON.stringify({
    event: 'logo_verification_failed',
    pass,
    status: logos.status,
    error: logos.error,
    body: logos.body,
  }));
  return { ok: false, complete: false, retryAfterMs: 0 };
}

/**
 * Drain both bounded queues and make a fresh monitor recount. A certified recount completes the
 * drain. A real floor breach returns a noncertified result so the outer worker can use its longer
 * recovery interval and start a new drain with a fresh polling watermark.
 */
export async function runCompleteDrain({
  config,
  requestJson,
  sleepFn = sleep,
  shouldStop = () => false,
  logger = console,
  drainStartedAt: requestedDrainStartedAt = null,
  now = () => new Date(),
}) {
  const startedAt = dateFromClock(now, 'runCompleteDrain clock');
  const drainStartedAt = validatedDrainStartedAt(
    requestedDrainStartedAt ?? startedAt.toISOString(),
    startedAt,
    'drain_started_at',
  );
  let pollingComplete = false;
  let logoComplete = false;
  let pass = 0;
  let finalRecountAttempts = 0;
  let metricsTimeoutAttempts = 0;

  while (!shouldStop()) {
    if (!pollingComplete || !logoComplete) {
      pass += 1;
      if (pass > config.maxPasses) {
        throw new Error(`Job monitor did not drain within ${config.maxPasses} passes`);
      }

      if (!pollingComplete) {
        const monitor = await requestJson(monitorPath(drainStartedAt));
        const metricsTimedOut = monitorMetricsTimedOut(monitor);
        if (monitor.status === 409) {
          logger.log(JSON.stringify({ event: 'monitor_locked', pass, retry_ms: config.retryMs }));
          await sleepFn(config.retryMs);
          continue;
        }
        if (!structuredMonitor(monitor)
          || !sameDrain(monitor.body, drainStartedAt)
          || (monitor.status !== 200 && monitor.status !== 500 && !metricsTimedOut)) {
          logger.error(JSON.stringify({
            event: 'monitor_request_failed',
            pass,
            status: monitor.status,
            error: monitor.error,
            expected_drain_started_at: drainStartedAt || null,
            body: monitor.body,
          }));
          await sleepFn(config.retryMs);
          continue;
        }
        pollingComplete = monitor.body.polling_complete;
        logMonitorPass(logger, 'monitor_pass', pass, monitor, drainStartedAt, {
          floor_breach_during_drain: monitor.status === 500,
          metrics_timed_out: metricsTimedOut,
        });
      }

      // Recheck even after an earlier complete response. A monitor pass can discover or upsert new
      // sources after that response and put fresh logo candidates onto the queue.
      const logos = await requestLogoStatus({ requestJson, config, logger, pass });
      logoComplete = logos.ok && logos.complete;
      if (!logos.ok) {
        await sleepFn(config.retryMs);
        continue;
      }
      if (pollingComplete && !logoComplete && logos.retryAfterMs > 0) {
        logger.log(JSON.stringify({
          event: 'logo_transient_retry_scheduled',
          pass,
          retry_ms: logos.retryAfterMs,
          drain_started_at: drainStartedAt,
        }));
        await sleepFn(logos.retryAfterMs);
      }

      // Both cached queue states are complete. Continue immediately into the final proof phase. In
      // particular, do not return based on a structured HTTP 500 from the polling phase.
      continue;
    }

    finalRecountAttempts += 1;
    if (finalRecountAttempts > config.finalRecountMaxAttempts) {
      throw new Error(
        `Job monitor final recount did not certify within ${config.finalRecountMaxAttempts} attempts`,
      );
    }

    // Final logo proof is intentionally fresh and immediately precedes the inventory recount.
    const finalLogos = await requestLogoStatus({
      requestJson,
      config,
      logger,
      pass: `final-${finalRecountAttempts}`,
    });
    if (!finalLogos.ok) {
      logoComplete = false;
      await sleepFn(config.retryMs);
      continue;
    }
    if (!finalLogos.complete) {
      logoComplete = false;
      if (finalLogos.retryAfterMs > 0) await sleepFn(finalLogos.retryAfterMs);
      continue;
    }

    const monitor = await requestJson(monitorPath(drainStartedAt));
    if (monitor.status === 409) {
      logger.log(JSON.stringify({
        event: 'final_monitor_locked',
        attempt: finalRecountAttempts,
        retry_ms: config.retryMs,
      }));
      await sleepFn(config.retryMs);
      continue;
    }
    const monitorIsStructured = structuredMonitor(monitor);
    const metricsTimedOut = monitorIsStructured && monitorMetricsTimedOut(monitor);
    if (monitorIsStructured && !metricsTimedOut) metricsTimeoutAttempts = 0;
    if (!monitorIsStructured || !sameDrain(monitor.body, drainStartedAt)) {
      logger.error(JSON.stringify({
        event: 'final_monitor_request_failed',
        attempt: finalRecountAttempts,
        status: monitor.status,
        error: monitor.error,
        expected_drain_started_at: drainStartedAt,
        body: monitor.body,
      }));
      await sleepFn(config.retryMs);
      continue;
    }
    if (metricsTimedOut) {
      metricsTimeoutAttempts += 1;
      const timeoutLimit = config.metricsTimeoutMaxAttempts ?? 3;
      logger.error(JSON.stringify({
        event: 'final_metrics_timeout',
        attempt: metricsTimeoutAttempts,
        final_recount_attempt: finalRecountAttempts,
        maximum_attempts: timeoutLimit,
        drain_started_at: drainStartedAt,
        metrics_stage: monitor.body.metrics_stage,
        metrics_timeout_ms: monitor.body.metrics_timeout_ms,
        retry_ms: config.retryMs,
      }));
      if (metricsTimeoutAttempts >= timeoutLimit) {
        return {
          certified: false,
          reason: 'metrics_timeout',
          drain_started_at: drainStartedAt,
          passes: pass,
          final_recount_attempts: finalRecountAttempts,
          metrics_timeout_attempts: metricsTimeoutAttempts,
          status: monitor.status,
          metrics_stage: monitor.body.metrics_stage,
          metrics_timeout_ms: monitor.body.metrics_timeout_ms,
        };
      }
      await sleepFn(config.retryMs);
      continue;
    }

    // A source enabled after the apparent drain can make the fresh recount incomplete. Resume both
    // queue checks without starting a new drain or entering the long cycle sleep.
    if (!monitor.body.polling_complete) {
      pollingComplete = false;
      logoComplete = false;
      logMonitorPass(logger, 'final_monitor_found_work', pass, monitor, drainStartedAt, {
        final_recount_attempt: finalRecountAttempts,
      });
      continue;
    }

    const floors = inventoryFloorAssessment(monitor.body);
    const metricsComplete = monitor.body.metrics_deferred !== true;
    const publicGateEnabled = monitor.body.public_verified_evidence_gate_enabled === true;
    const certified = monitor.status === 200
      && metricsComplete
      && floors.valid
      && floors.met
      && publicGateEnabled;
    logMonitorPass(logger, 'final_monitor_recount', pass, monitor, drainStartedAt, {
      final_recount_attempt: finalRecountAttempts,
      logo_verification_complete: true,
      metrics_complete: metricsComplete,
      inventory_floors_valid: floors.valid,
      inventory_floors_met: floors.met,
      inventory_floors: floors.requirements,
      public_verified_evidence_gate_enabled: publicGateEnabled,
      certified,
    });

    if (!certified) {
      const isFloorBreach = metricsComplete
        && (monitor.status === 500 || (floors.valid && !floors.met));
      logger.error(JSON.stringify({
        event: isFloorBreach ? 'final_inventory_floor_breach' : 'final_inventory_not_certified',
        attempt: finalRecountAttempts,
        status: monitor.status,
        drain_started_at: drainStartedAt,
        inventory_floors_valid: floors.valid,
        inventory_floors_met: floors.met,
        metrics_complete: metricsComplete,
        inventory_floors: floors.requirements,
        retry_ms: isFloorBreach ? config.floorBreachRetryMs : config.retryMs,
      }));

      if (isFloorBreach) {
        return {
          certified: false,
          reason: 'inventory_floor_breach',
          drain_started_at: drainStartedAt,
          passes: pass,
          final_recount_attempts: finalRecountAttempts,
          status: monitor.status,
          inventory_floors: floors.requirements,
          surfaced_postings: monitor.body.surfaced_postings,
          surfaced_grouped_roles: monitor.body.surfaced_grouped_roles,
          surfaced_sponsor_only_jobs: monitor.body.surfaced_sponsor_only_jobs,
          certified_unique_jobs: monitor.body.certified_unique_jobs,
          certified_unique_grouped_roles: monitor.body.certified_unique_grouped_roles,
          certified_unique_sponsor_jobs: monitor.body.certified_unique_sponsor_jobs,
        };
      }

      // A malformed HTTP 200 or an unrelated server response is not evidence of a floor breach.
      // Keep the same drain cursor and use the normal transient-error backoff until it is readable.
      await sleepFn(config.retryMs);
      continue;
    }

    return {
      certified: true,
      drain_started_at: drainStartedAt,
      passes: pass,
      final_recount_attempts: finalRecountAttempts,
      surfaced_postings: monitor.body.surfaced_postings,
      surfaced_grouped_roles: monitor.body.surfaced_grouped_roles,
      surfaced_sponsor_only_jobs: monitor.body.surfaced_sponsor_only_jobs,
      certified_unique_jobs: monitor.body.certified_unique_jobs,
      certified_unique_grouped_roles: monitor.body.certified_unique_grouped_roles,
      certified_unique_sponsor_jobs: monitor.body.certified_unique_sponsor_jobs,
    };
  }

  return null;
}

export async function runWorkerLoop({
  config,
  requestJson,
  sleepFn = sleep,
  shouldStop = () => false,
  logger = console,
  now = () => new Date(),
}) {
  let activeDrainStartedAt = config.resumeDrainStartedAt ?? null;
  while (!shouldStop()) {
    const startedAt = now();
    activeDrainStartedAt ??= dateFromClock(now, 'runWorkerLoop clock').toISOString();
    try {
      const result = await runCompleteDrain({
        config,
        requestJson,
        sleepFn,
        shouldStop,
        logger,
        drainStartedAt: activeDrainStartedAt,
        now,
      });
      if (!result) break;

      if (!result.certified) {
        if (result.reason === 'metrics_timeout') {
          logger.error(JSON.stringify({
            event: 'persistent_metrics_timeout_alert',
            ...result,
            alert: true,
            retry_ms: config.floorBreachRetryMs,
          }));
          if (!shouldStop()) await sleepFn(config.floorBreachRetryMs);
          continue;
        }
        logger.error(JSON.stringify({
          event: 'inventory_floor_repoll_scheduled',
          ...result,
          retry_ms: config.floorBreachRetryMs,
          next_drain_uses_fresh_cursor: true,
        }));
        if (!shouldStop()) await sleepFn(config.floorBreachRetryMs);
        activeDrainStartedAt = null;
        continue;
      }

      logger.log(JSON.stringify({
        event: 'complete_drain',
        ...result,
        deployed_sha: config.deployedSha ?? null,
        started_at: startedAt.toISOString(),
        completed_at: now().toISOString(),
        next_cycle_in_ms: config.cycleIntervalMs,
      }));
      activeDrainStartedAt = null;
    } catch (error) {
      logger.error(JSON.stringify({
        event: 'drain_failed',
        error: error instanceof Error ? error.message : String(error),
        retry_ms: config.retryMs,
      }));
      if (!shouldStop()) await sleepFn(config.retryMs);
      continue;
    }
    if (!shouldStop()) await sleepFn(config.cycleIntervalMs);
  }

  logger.log(JSON.stringify({ event: 'worker_stopped' }));
}

export async function main(environment = process.env) {
  const config = loadConfig(environment);
  const requestJson = createJsonRequester(config);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => { stopping = true; });
  }

  await runWorkerLoop({
    config,
    requestJson,
    shouldStop: () => stopping,
  });
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entrypoint === import.meta.url) {
  await main();
}
