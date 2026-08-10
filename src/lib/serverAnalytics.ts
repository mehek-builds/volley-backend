/* Server-side analytics, for the events the browser cannot be trusted to send.
 *
 * WHY THIS EXISTS, measured 2026-08-09 against production:
 *
 * The site fires track("authentication_completed", { method: "guest" }) right
 * after a guest session is created, and that code is correct. It has never once
 * arrived. Eighteen guest accounts have been created since PostHog was wired on
 * 31 July and PostHog has recorded zero guest sign-ins.
 *
 * The reason is not the event. Sampling seven guest-creation timestamps from the
 * database, FIVE had no PostHog activity at all within three minutes either
 * side, not even a pageview. Those browsers are not reporting to PostHog: an ad
 * blocker, a privacy extension, a locked-down corporate profile or an automated
 * client. A client-side fix cannot reach them by definition, because the client
 * is the thing that is missing.
 *
 * So account creation is reported from here, where nothing can block it.
 *
 * WHY THIS IS AWAITED RATHER THAN FIRE-AND-FORGET. The first version of this
 * file used `void captureServerEvent(...)`, which on this deployment is close to
 * a guarantee of losing the event. `api/index.ts` resolves the Vercel handler
 * the moment the response flushes, and `src/lib/serverlessRespond.ts` documents
 * what the platform does next, observed in production on 2026-08-04: "The
 * platform is entitled to freeze or tear down the container once that promise
 * resolves." Un-awaited work started just before the reply is exactly the work
 * that gets frozen. Shipping a fix for "the event never arrives" that itself
 * never arrives would have been an expensive joke.
 *
 * The cost of awaiting is bounded and it is paid on a rare path: account
 * creation happened 18 times in ten days. CAPTURE_TIMEOUT_MS caps the delay, so
 * the worst case a student can experience is that much added to a single guest
 * sign-in, and a dead analytics host cannot hold the request open.
 *
 * Session-start reporting was deliberately NOT added. It would sit on the
 * early-return path of /auth/guest, which returns BEFORE the per-IP guard, so
 * replaying one idempotency key would have turned an unauthenticated endpoint
 * into an unmetered generator of billable person-profile writes.
 *
 * OTHER RULES, all load-bearing:
 *
 *  - Never throw. Analytics must not fail an auth request. The catch block is
 *    itself written not to throw: `(error as Error).name` on a non-Error
 *    rejection raises inside the handler, and with no unhandledRejection
 *    listener anywhere in src/ that kills the process and every concurrent
 *    request on the instance. Reproduced: exit code 9.
 *  - No PII. distinct_id is the user's UUID, the same key the site identifies
 *    with, so the two sides join. Emails never leave this process.
 *  - No server geography. Without $ip, PostHog geolocates the event to the
 *    caller, which here is a Vercel datacenter, and would overwrite the real
 *    $geoip_* properties on the person the site's own identify call builds.
 *  - Silent no-op when unconfigured, so deploying before the env var exists is
 *    safe.
 */

const POSTHOG_HOST = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';

/* Bounded because this is awaited inside a request. Long enough for a healthy
 * round trip, short enough that a hung analytics host is invisible to the user. */
const CAPTURE_TIMEOUT_MS = 600;

/* Deletion runs after the account row is already gone, so it is not racing the
 * user's response in the same way; give it room to actually land. */
const DELETE_TIMEOUT_MS = 3000;

export type ServerAuthEvent = 'account_created';

export type AuthMethod = 'guest' | 'google' | 'password' | 'email_code' | 'email_verification';

type CaptureProperties = Record<string, string | number | boolean | null>;

type Warner = { warn: (msg: string) => void };

function token(): string | undefined {
  // Read at call time, not at module load: the tests set and unset it, and a
  // module-level constant would freeze whatever the first import happened to see.
  return process.env.POSTHOG_PROJECT_TOKEN;
}

/** True when events will actually be sent. Exported so routes can skip work. */
export function serverAnalyticsEnabled(): boolean {
  return Boolean(token());
}

/** Never let a logger, or a non-Error rejection, escape as a new exception. */
function safeWarn(log: Warner | undefined, msg: string): void {
  if (!log) return;
  try {
    log.warn(msg);
  } catch {
    /* A logger that throws must not become the failure. */
  }
}

function errorName(error: unknown): string {
  // NOT `(error as Error).name`. A rejection can carry null, a string, or any
  // object; reading .name off null throws inside the catch, where nothing is
  // left to catch it.
  if (error instanceof Error) return error.name;
  if (typeof error === 'string') return error.slice(0, 40);
  return typeof error;
}

export function buildCaptureBody(
  apiKey: string,
  event: ServerAuthEvent,
  distinctId: string,
  properties: CaptureProperties = {},
): Record<string, unknown> {
  return {
    api_key: apiKey,
    event,
    distinct_id: distinctId,
    properties: {
      ...properties,
      surface: 'backend',
      $lib: 'litos-backend',
      // Suppress datacenter geolocation, see the header note.
      $ip: null,
      // Build a person profile on purpose: these events are meant to merge with
      // the profile the site's identify call creates for the same UUID.
      $process_person_profile: true,
    },
  };
}

/**
 * Send one event and wait for it, with a hard timeout.
 *
 * Resolves either way. Callers may await it directly; it cannot reject, and it
 * cannot outlive CAPTURE_TIMEOUT_MS.
 */
export async function captureServerEvent(
  event: ServerAuthEvent,
  distinctId: string,
  properties: CaptureProperties = {},
  log?: Warner,
): Promise<void> {
  const apiKey = token();
  if (!apiKey || !distinctId) return;

  let body: string;
  try {
    body = JSON.stringify(buildCaptureBody(apiKey, event, distinctId, properties));
  } catch (error) {
    // Serialisation is not expected to fail, but a circular property would take
    // the request down with it if this were not caught.
    safeWarn(log, `serverAnalytics: ${event} could not be serialised: ${errorName(error)}`);
    return;
  }

  try {
    const res = await fetch(`${POSTHOG_HOST}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // AbortSignal.timeout owns its own timer, so there is no handle left
      // running after this resolves. The hand-rolled setTimeout it replaces kept
      // the process alive for the full timeout on every call.
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS),
    });
    if (!res.ok) {
      safeWarn(log, `serverAnalytics: ${event} rejected with ${res.status}`);
    }
  } catch (error) {
    safeWarn(log, `serverAnalytics: ${event} failed: ${errorName(error)}`);
  }
}

/**
 * Delete a person and their events from PostHog, for account deletion.
 *
 * The privacy policy states that deleting a Litos account deletes the linked
 * analytics profile, so this is what makes that sentence true rather than
 * aspirational.
 *
 * It needs a PERSONAL api key (phx_), not the public ingestion token: deletion
 * is a management operation and the ingestion token cannot perform it. Without
 * POSTHOG_PERSONAL_API_KEY and POSTHOG_PROJECT_ID this returns false and logs,
 * which is the honest signal that the promise is not currently being kept.
 *
 * Returns true only if PostHog confirmed the deletion.
 */
export async function deleteAnalyticsProfile(
  userId: string,
  log?: Warner,
): Promise<boolean> {
  const personalKey = process.env.POSTHOG_PERSONAL_API_KEY;
  const projectId = process.env.POSTHOG_PROJECT_ID;
  if (!personalKey || !projectId) {
    safeWarn(
      log,
      'serverAnalytics: cannot delete the analytics profile, POSTHOG_PERSONAL_API_KEY or ' +
        'POSTHOG_PROJECT_ID is unset. The privacy policy promises this deletion.',
    );
    return false;
  }
  if (!userId) return false;

  // PostHog's management API lives on the app host, not the ingestion host.
  const apiHost = (process.env.POSTHOG_API_HOST ?? 'https://us.posthog.com').replace(/\/$/, '');
  try {
    // delete_events=true removes the events as well as the person row; without
    // it the profile disappears but its history stays queryable.
    const url =
      `${apiHost}/api/projects/${encodeURIComponent(projectId)}/persons/` +
      `?distinct_id=${encodeURIComponent(userId)}&delete_events=true`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${personalKey}` },
      signal: AbortSignal.timeout(DELETE_TIMEOUT_MS),
    });
    // 404 means there was no profile to delete, which satisfies the promise.
    if (res.ok || res.status === 404) return true;
    safeWarn(log, `serverAnalytics: profile deletion rejected with ${res.status}`);
    return false;
  } catch (error) {
    safeWarn(log, `serverAnalytics: profile deletion failed: ${errorName(error)}`);
    return false;
  }
}

/**
 * Report a new account.
 *
 * AWAIT THIS, and only after everything that can fail has succeeded. Reporting
 * before the session token is signed would count accounts that then 500, which
 * over-reports on exactly the failures the number exists to expose.
 */
export function reportAccountCreated(
  userId: string,
  method: AuthMethod,
  log?: Warner,
): Promise<void> {
  return captureServerEvent('account_created', userId, { method, is_guest: method === 'guest' }, log);
}
