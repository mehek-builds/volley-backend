/**
 * Ask the database whether it is actually answering, cheaply and without ever throwing.
 *
 * WHY THIS EXISTS
 * ---------------
 * On 2026-08-04 Neon refused every connection with "exceeded the data transfer quota". Every
 * database-backed route answered 500 and the public board was down for about 75 minutes. `/health`
 * answered 200 the whole time, because it read three environment variables and a clock and touched
 * nothing else. Any uptime monitor pointed at it reported all-clear through the entire incident,
 * and the first real signal was a CI job failing on an unrelated pull request.
 *
 * A health check that cannot fail is not a health check. It is a liveness ping for the process,
 * which is the least interesting thing that can be wrong with this service: the process is fine in
 * almost every real outage, and the database is what the board cannot work without.
 *
 * DESIGN NOTES, because each of these is a way this could make things worse rather than better:
 *
 *   NEVER THROWS. A probe that can throw turns a degraded database into a broken health endpoint,
 *   which is the one page you need working during an incident. Every failure resolves to
 *   `unreachable` with a reason.
 *
 *   ALWAYS TIMES OUT. A refused connection fails fast, but a saturated or hanging one does not, and
 *   a health check that hangs is indistinguishable from a service that is down. The timeout is
 *   deliberately shorter than any sensible monitor interval.
 *
 *   COSTS ALMOST NOTHING. `select 1` returns one row of one integer. This matters more than usual
 *   here: the incident being detected was a DATA TRANSFER exhaustion, so a probe that itself moved
 *   real bytes would be spending the resource it exists to watch.
 *
 *   REPORTS A CATEGORY, NOT THE DRIVER'S MESSAGE. `/health` is public. The raw error can name hosts,
 *   roles and internals, so the endpoint says `unreachable` and the caller reads the server log for
 *   the detail. See routes: the full error is logged there.
 */

import { modelFailureReason, type ModelFailureReason } from './llmFailure';

/** Short enough that a hanging database still returns a fast, honest answer. */
/**
 * Long enough to survive a Neon COLD START, short enough to beat any monitor's own timeout.
 *
 * This started at 2,000 ms and that was wrong. Measured against production on 2026-08-04:
 *
 *   first connection after idle   1,647 ms      (compute waking from autosuspend)
 *   every connection after that     205-209 ms
 *
 * The Neon compute autosuspends after 5 minutes, so on a board with quiet spells the FIRST probe of
 * any stretch pays that wake-up. At 2,000 ms the margin over a measured cold start was ~350 ms, so a
 * perfectly healthy database would have reported `unreachable` whenever it happened to be asleep and
 * a little slow. A health check that cries wolf gets muted, and a muted health check is the bug this
 * file exists to fix, reintroduced from the other side.
 */
export const DATABASE_PROBE_TIMEOUT_MS = 5_000;

export type DatabaseHealth =
  | { status: 'ok'; ms: number }
  | { status: 'unreachable'; ms: number; reason: DatabaseFailureReason };

/**
 * Coarse enough to be safe on a public endpoint, specific enough to shorten an investigation.
 *
 * `quota` earns its own value because it is the failure this file was written for, it is
 * indistinguishable from an ordinary connection error at the HTTP layer, and knowing it instantly
 * is the difference between reading a billing page and debugging a query.
 */
export type DatabaseFailureReason = 'timeout' | 'quota' | 'refused' | 'error';

/** Map a driver error to a category without leaking the message itself. */
export function classifyDatabaseError(error: unknown): DatabaseFailureReason {
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  if (message.includes('quota') || message.includes('exceeded')) return 'quota';
  if (message.includes('econnrefused') || message.includes('terminating connection')) return 'refused';
  if (message.includes('timeout') || message.includes('etimedout')) return 'timeout';
  return 'error';
}

/**
 * Run the cheapest possible query and report what happened.
 *
 * `run` is injected rather than imported so this is testable without a database, and so the caller
 * decides what "the cheapest possible query" means for its driver.
 */
export async function probeDatabase(
  run: () => Promise<unknown>,
  timeoutMs: number = DATABASE_PROBE_TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<DatabaseHealth> {
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('probe timeout')), timeoutMs);
    });
    await Promise.race([run(), timeout]);
    return { status: 'ok', ms: now() - started };
  } catch (error) {
    return { status: 'unreachable', ms: now() - started, reason: classifyDatabaseError(error) };
  } finally {
    // Serverless will not freeze the invocation while a stray timer is pending, so an uncleared
    // one keeps the function billable after the response has been sent.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/* ─── THE MODEL, for the same reason as the database ─────────────────────────────────────────────
 *
 * On 2026-08-15 the Anthropic balance ran out. Every model-backed flow failed (resume parsing, the
 * base resume, tailoring, cover letters, application answers) and /health answered 200 the whole
 * time, because it probed the database and the database was fine. The first signal was Mehek
 * trying to upload her own resume and being told the parse had failed, which reads on that screen
 * as a problem with the file.
 *
 * That is the 2026-08-04 lesson again with a different dependency: a health check only reports what
 * it measures, and what it did not measure was the one thing onboarding cannot start without.
 *
 * THE PROBE MUST NOT SPEND THE THING IT WATCHES. This is the same trap as `select 1` against a
 * TRANSFER quota, and it is sharper here because the resource is money. So the call is the smallest
 * one the API accepts (a single token in, a single token out, on the cheapest model), and the
 * caller is expected to cache the verdict rather than pay it on every monitor poll. When the
 * balance is actually empty the call is refused before any tokens are billed, so the failing case
 * is free, which is the case a monitor will be repeating.
 *
 * A REFUSAL IS NOT AN OUTAGE. Unlike the database, an empty balance does not mean "send no traffic
 * here": the job board, the dashboard and every saved application still work. So this reports
 * `degraded` through aggregateServiceHealthStatus and deliberately does NOT change the HTTP status
 * code, which the database still owns.
 */

/** Long enough for a cold model call, short enough to beat a monitor's own timeout. */
export const MODEL_PROBE_TIMEOUT_MS = 8_000;

export type ModelHealth =
  | { status: 'ok'; ms: number }
  | { status: 'unavailable'; ms: number; reason: ModelFailureReason }
  | { status: 'not_configured'; ms: number };

/**
 * Ask the model API whether it will serve us, cheaply and without ever throwing.
 *
 * `run` is injected for the same reason probeDatabase injects its query: this stays testable with
 * no network, and the caller decides what the smallest possible call is for its SDK.
 */
export async function probeModel(
  run: () => Promise<unknown>,
  options: { configured?: boolean; timeoutMs?: number; now?: () => number } = {},
): Promise<ModelHealth> {
  const { configured = true, timeoutMs = MODEL_PROBE_TIMEOUT_MS, now = Date.now } = options;
  const started = now();
  /* Not an error: a deployment with no key is a configuration state, and reporting it as a failure
     would make every preview environment look like an incident. */
  if (!configured) return { status: 'not_configured', ms: 0 };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('probe timeout')), timeoutMs);
    });
    await Promise.race([run(), timeout]);
    return { status: 'ok', ms: now() - started };
  } catch (error) {
    return { status: 'unavailable', ms: now() - started, reason: modelFailureReason(error) };
  } finally {
    // Same reason as probeDatabase: a stray timer keeps a serverless invocation billable after the
    // response has already been sent.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The HTTP status a health response should carry.
 *
 * 503 rather than 500: the service is up and correctly reporting that a dependency it cannot work
 * without is unavailable, which is what Service Unavailable means. Monitors and load balancers treat
 * it as "do not send traffic here", which is the truthful answer while the board cannot be read.
 */
export const healthStatusCode = (database: DatabaseHealth): number =>
  (database.status === 'ok' ? 200 : 503);
