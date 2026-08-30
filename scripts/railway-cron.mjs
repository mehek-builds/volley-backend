import { pathToFileURL } from 'node:url';

function positiveNumber(value, fallback, name) {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
}

export async function runRailwayCron(
  env = process.env,
  { fetcher = fetch, now = Date.now, logger = console } = {},
) {
  const baseUrl = (env.INTERNAL_API_BASE || env.PUBLIC_API_BASE)?.trim()?.replace(/\/+$/, '');
  const path = env.CRON_PATH?.trim();
  const secret = env.INTERNAL_CRON_SECRET?.trim() || env.CRON_SECRET?.trim();
  const drainJobMonitor = env.CRON_DRAIN_UNTIL_COMPLETE === '1';
  const requestTimeoutMs = Math.max(
    60_000,
    positiveNumber(env.CRON_REQUEST_TIMEOUT_MS, 14 * 60_000, 'CRON_REQUEST_TIMEOUT_MS'),
  );
  const totalTimeoutMs = Math.max(
    requestTimeoutMs,
    positiveNumber(env.CRON_TOTAL_TIMEOUT_MS, 45 * 60_000, 'CRON_TOTAL_TIMEOUT_MS'),
  );
  const maxSegments = Math.max(
    1,
    Math.floor(positiveNumber(env.CRON_MAX_SEGMENTS, 5, 'CRON_MAX_SEGMENTS')),
  );

  if (!baseUrl || !path || !path.startsWith('/') || !secret) {
    throw new Error('Cron requires INTERNAL_API_BASE or PUBLIC_API_BASE, CRON_PATH, and INTERNAL_CRON_SECRET or CRON_SECRET');
  }

  const url = new URL(path, `${baseUrl}/`);
  if (url.origin !== new URL(baseUrl).origin) {
    throw new Error('CRON_PATH must stay on the configured API origin');
  }
  if (drainJobMonitor && path !== '/internal/job-monitor') {
    throw new Error('CRON_DRAIN_UNTIL_COMPLETE is only valid for /internal/job-monitor');
  }

  const drainStartedAt = new Date(now()).toISOString();
  const startedAt = now();
  for (let segment = 1; segment <= (drainJobMonitor ? maxSegments : 1); segment += 1) {
    if (drainJobMonitor) url.searchParams.set('drain_started_at', drainStartedAt);
    const remainingMs = totalTimeoutMs - (now() - startedAt);
    if (remainingMs <= 0) throw new Error(`Cron ${path} exceeded its ${totalTimeoutMs}ms total deadline`);

    const response = await fetcher(url, {
      method: env.CRON_METHOD?.trim() || (path === '/internal/job-monitor' ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(Math.min(requestTimeoutMs, remainingMs)),
    });
    const detail = await response.text();
    let payload = null;
    try { payload = JSON.parse(detail); } catch {}

    const hasDrainState = payload && typeof payload.polling_complete === 'boolean';
    if (drainJobMonitor && hasDrainState) {
      logger.log(`Cron ${path} segment ${segment}: status=${response.status} complete=${payload.polling_complete} attempted=${payload.sources ?? 'unknown'} deferred=${payload.deferred_sources ?? 'unknown'}`);
      if (!payload.polling_complete) continue;
    }
    if (!response.ok) {
      throw new Error(`Cron ${path} failed with ${response.status}: ${detail.slice(0, 1000)}`);
    }
    logger.log(`Cron ${path} completed with ${response.status}: ${detail.slice(0, 1000)}`);
    return { segments: segment, drainStartedAt: drainJobMonitor ? drainStartedAt : null, payload };
  }

  throw new Error(`Cron ${path} did not finish within ${maxSegments} segments`);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint === import.meta.url) {
  runRailwayCron().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
