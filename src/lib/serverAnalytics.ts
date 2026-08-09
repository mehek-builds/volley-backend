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
 * So account creation is reported from here, where nothing can block it. This
 * is the standard split: the browser owns intent and interaction, the server
 * owns facts about accounts. Anything the business must be able to count
 * belongs on this side of the wire.
 *
 * DESIGN RULES, all of them load-bearing:
 *
 *  - Fire and forget. Analytics must never delay, fail, or alter an auth
 *    response. Every call is wrapped, every failure is swallowed after a log.
 *  - No PII. The distinct_id is the user's UUID, the same key the site now
 *    identifies with, so the two sides join. Emails never leave here.
 *  - Silent no-op when unconfigured. Without POSTHOG_PROJECT_TOKEN this does
 *    nothing at all, so deploying it before the env var exists is safe.
 *  - $process_person_profile stays true, unlike the extension's events: these
 *    events describe a real account and should build a person profile that the
 *    site's own identify call will merge with.
 */

const POSTHOG_HOST = process.env.POSTHOG_HOST ?? 'https://us.i.posthog.com';
const CAPTURE_TIMEOUT_MS = 3000;

export type ServerAuthEvent = 'account_created' | 'session_started';

export type AuthMethod = 'guest' | 'google' | 'password' | 'email_code' | 'email_verification';

type CaptureProperties = Record<string, string | number | boolean | null>;

function token(): string | undefined {
  // Read at call time, not at module load: the tests set and unset it, and a
  // module-level constant would freeze whatever the first import happened to see.
  return process.env.POSTHOG_PROJECT_TOKEN;
}

/** True when events will actually be sent. Exported so routes can skip work. */
export function serverAnalyticsEnabled(): boolean {
  return Boolean(token());
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
    },
  };
}

/** Send one event. Never throws, never blocks the caller's response. */
export async function captureServerEvent(
  event: ServerAuthEvent,
  distinctId: string,
  properties: CaptureProperties = {},
  log?: { warn: (msg: string) => void },
): Promise<void> {
  const apiKey = token();
  if (!apiKey || !distinctId) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTURE_TIMEOUT_MS);
  try {
    const res = await fetch(`${POSTHOG_HOST}/i/v0/e/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCaptureBody(apiKey, event, distinctId, properties)),
      signal: controller.signal,
    });
    if (!res.ok && log) {
      log.warn(`serverAnalytics: ${event} rejected with ${res.status}`);
    }
  } catch (error) {
    // A dead analytics endpoint must never surface as a failed sign-in.
    if (log) log.warn(`serverAnalytics: ${event} failed: ${(error as Error).name}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Report a new account, without making the caller wait for it. */
export function reportAccountCreated(
  userId: string,
  method: AuthMethod,
  log?: { warn: (msg: string) => void },
): void {
  void captureServerEvent('account_created', userId, { method, is_guest: method === 'guest' }, log);
}

/** Report a session handed to an existing account. */
export function reportSessionStarted(
  userId: string,
  method: AuthMethod,
  log?: { warn: (msg: string) => void },
): void {
  void captureServerEvent('session_started', userId, { method }, log);
}
