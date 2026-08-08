import { chromium, type Browser, type Page } from 'playwright-core';
import { getVercelOidcToken } from '@vercel/oidc';

export type BrowserProvider = 'browserbase' | 'stratus' | 'stratus-managed';

export type ManagedBrowserAction = {
  type: 'click' | 'fill' | 'fillByLabelText' | 'upload' | 'waitForSelector' | 'press' | 'select' | 'extract' | 'discover';
  selector?: string;
  value?: string;
  text?: string;
  label?: string;
  optional?: boolean;
  timeout?: number;
  attribute?: string;
  file?: { name: string; mimeType: string; base64: string };
  /* The emailed code that finishes a Greenhouse submit, carried on the submit click itself.
   *
   * On the click, and not as its own action, because the control it types into does not exist until
   * that click has happened - and because MANAGED_ACTION_LIMIT is 120, a real Greenhouse packet
   * already reconstructs to exactly 120, and an action added here would displace a field fill. The
   * runner does click, type, click and reports the outcome in securityCodeAttempt. */
  securityCode?: string;
};

// One entry per text-shaped custom question the 'discover' action found on the live page.
// Mirrors questionDiscovery.ts's DiscoveredQuestion so the managed and direct-Playwright paths
// hand the same shape to the same resolution code (see discoverAndResolveQuestions).
export type ManagedDiscoveredQuestion = {
  label: string;
  selector: string;
  inputType: string;
  maxLength: number | null;
  // The managed provider's `discover` action does not report option lists and, as of 2026-08-08,
  // shows no sign of learning to: it enumerates text-shaped inputs and returns four fields per
  // control. Waiting for it was measured as the reason PR #361's option snapping never fired in
  // production. So this is filled in by THIS repo instead, from the discovery pass's own option
  // extracts (portalSubmission.ts: pushManagedReactSelectOptionProbeActions,
  // managedResultFieldOptions, attachManagedFieldOptions). Still optional, because the direct
  // Playwright path reads options straight off the Page and an unprobed control has none.
  options?: string[] | null;
  // Optional for the same reason as options: the managed provider does not report required-ness
  // yet. Until it does, discoveredFieldIsRequired reads the employer's own required marker out of
  // the raw label, which this provider DOES report, so the managed path is not left waiting on a
  // change in another service. When stratus starts sending the flag it is believed with no further
  // change here.
  required?: boolean;
};

export type ManagedBrowserResult = {
  title: string;
  url: string;
  text: string;
  screenshot?: string | null;
  filledFields?: string[];
  blockers?: string[];
  skipped?: string[];
  discovered?: ManagedDiscoveredQuestion[];
  extracted?: Array<{ selector: string; label?: string; value: string | null }>;
  /* The human check the page is holding the application behind, read off the CONTROL by the runner
   * at zero action cost. Greenhouse emails an 8-character code and renders a code field, and files
   * nothing until that code is entered and the form is sent again. See lib/securityCode.ts.
   *
   * Absent on a runner deployed before this shipped, which is the ordinary case during a rollout,
   * and absent means "not observed" and never "not present" - so nothing downstream may read its
   * absence as proof a form has no challenge. */
  humanVerification?: { kind: 'security_code'; fieldCount: number; sentTo: string | null; label?: string | null } | null;
  /* What happened to a code this run was given, or null when it was given none. */
  securityCodeAttempt?: {
    supplied: boolean;
    entered: boolean;
    resubmitted?: boolean;
    outcome: 'accepted' | 'rejected' | 'no_control' | 'not_entered';
  } | null;
  /* How many form submissions the runner's guard stopped. Zero on a run that was allowed to submit,
   * because the guard is not installed there. NON-ZERO ON A FILL RUN IS A DEFECT REPORT: something
   * in the action list tried to send a real application to a real employer with no authorization
   * behind it, which is exactly what happened to three packets on 2026-08-08. */
  blockedSubmits?: number;
};

type ManagedBrowserError = string | { message?: string; code?: string };

function managedBrowserErrorMessage(
  error: ManagedBrowserError | undefined,
  status: number,
  actions: ManagedBrowserAction[] = [],
): string {
  const message = typeof error === 'string' && error.trim()
    ? error
    : error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()
      ? error.message
      : `Stratus managed browser request failed with status ${status}`;
  if (!/selector/i.test(message)) return message;
  return `${message}; action_audit=${managedActionAudit(actions)}`;
}

type SessionResponse = {
  id: string;
  connectUrl?: string;
  connect_url?: string;
};

const STRATUS_SELECTOR_MAX_LENGTH = 500;

function stratusAction(action: ManagedBrowserAction): ManagedBrowserAction {
  if (action.type === 'discover' && !action.selector?.trim()) {
    return { ...action, selector: 'body' };
  }
  if (action.type === 'fillByLabelText') {
    if (!action.text?.trim()) return action;
    return { ...action, selector: action.selector?.trim() || 'body' };
  }
  return action;
}

function invalidSelectorReason(action: ManagedBrowserAction): string | undefined {
  const selector = action.selector?.trim();
  if (!selector) return 'empty';
  if (selector.length > STRATUS_SELECTOR_MAX_LENGTH) return 'too_long';
  return undefined;
}

function normalizeStratusActions(actions: ManagedBrowserAction[]): ManagedBrowserAction[] {
  const outbound: ManagedBrowserAction[] = [];
  const invalidRequired: ManagedBrowserAction[] = [];
  for (const action of actions.map(stratusAction)) {
    const reason = invalidSelectorReason(action);
    if (!reason) {
      outbound.push(action);
      continue;
    }
    const audited = { ...action, label: action.label ? `${action.label}:${reason}` : reason };
    if (action.optional) continue;
    invalidRequired.push(audited);
  }
  if (invalidRequired.length > 0) {
    throw new Error(`Managed Stratus action has an invalid selector; action_audit=${managedActionAudit(invalidRequired)}`);
  }
  return outbound;
}

function preview(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed;
}

function managedActionAudit(actions: ManagedBrowserAction[]): string {
  const selectorless = actions
    .filter((action) => !action.selector?.trim())
    .slice(0, 5)
    .map((action) => ({ type: action.type, label: preview(action.label), text: preview(action.text) }));
  const tooLong = actions
    .filter((action) => (action.selector?.length ?? 0) > STRATUS_SELECTOR_MAX_LENGTH)
    .slice(0, 5)
    .map((action) => ({
      type: action.type,
      label: preview(action.label),
      length: action.selector?.length ?? 0,
      selector: preview(action.selector),
    }));
  const maxSelectors = actions
    .filter((action) => action.selector?.trim())
    .map((action) => ({
      type: action.type,
      label: preview(action.label),
      length: action.selector?.length ?? 0,
      selector: preview(action.selector),
    }))
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const typeCounts = actions.reduce<Record<string, number>>((counts, action) => {
    counts[action.type] = (counts[action.type] ?? 0) + 1;
    return counts;
  }, {});
  return JSON.stringify({
    count: actions.length,
    typeCounts,
    selectorless,
    tooLong,
    maxSelectors,
  });
}

function config() {
  const provider: BrowserProvider = process.env.BROWSER_PROVIDER === 'stratus-managed'
    ? 'stratus-managed'
    : process.env.BROWSER_PROVIDER === 'stratus' || Boolean(process.env.STRATUS_BASE_URL)
      ? 'stratus'
      : 'browserbase';
  const apiKey = process.env.BROWSER_API_KEY
    ?? (provider !== 'browserbase' ? process.env.STRATUS_API_KEY : process.env.BROWSERBASE_API_KEY);
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  const stratusBaseUrl = process.env.STRATUS_BASE_URL?.replace(/\/$/, '');
  const apiRoot = (process.env.BROWSER_API_ROOT
    ?? (provider === 'stratus' && stratusBaseUrl ? `${stratusBaseUrl}/v1` : 'https://api.browserbase.com/v1'))
    .replace(/\/$/, '');
  if (!apiKey) {
    throw new Error('Secure browser provider is not configured. Add BROWSER_API_KEY or the provider-specific API key.');
  }
  return { apiKey, projectId, provider, apiRoot };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiKey, apiRoot, provider } = config();
  const response = await fetch(`${apiRoot}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      [provider === 'stratus' ? 'X-Stratus-API-Key' : 'X-BB-API-Key']: apiKey,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Secure browser provider request failed with status ${response.status}`);
  return response.json() as Promise<T>;
}

export function isBrowserbaseConfigured(): boolean {
  const provider: BrowserProvider = process.env.BROWSER_PROVIDER === 'stratus-managed'
    ? 'stratus-managed'
    : process.env.BROWSER_PROVIDER === 'stratus' || Boolean(process.env.STRATUS_BASE_URL)
      ? 'stratus'
      : 'browserbase';
  if (provider === 'stratus-managed') {
    return Boolean(
      process.env.STRATUS_BASE_URL?.trim()
      && (process.env.STRATUS_API_KEY?.trim() || process.env.VERCEL_ENV === 'production'),
    );
  }
  return Boolean(process.env.BROWSER_API_KEY
    ?? (provider === 'stratus' ? process.env.STRATUS_API_KEY : process.env.BROWSERBASE_API_KEY));
}

export function isManagedStratusProvider(): boolean {
  return process.env.BROWSER_PROVIDER === 'stratus-managed';
}

// `screenshot` defaults to true because every existing caller wants the receipt image. The CAPTCHA
// probe does not: it reads one attribute and throws the result away, so a full-page PNG would be
// rendered, transferred and retained by the third-party runner for nothing.
export async function runManagedBrowser(
  portalUrl: string,
  actions: ManagedBrowserAction[],
  // `allowSubmit` defaults to false at the runner, and the default is the safety property: a run
  // that does not ask for it cannot submit a form, whatever its action list turns out to do on a
  // live page. Only the two authorized paths pass true. See the guard in stratus-browser-cloud's
  // SANDBOX_RUNNER, and the three packets of 2026-08-08 that a fill run submitted.
  options: { screenshot?: boolean; allowSubmit?: boolean } = {},
): Promise<ManagedBrowserResult> {
  const baseUrl = process.env.STRATUS_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.STRATUS_API_KEY?.trim();
  if (!baseUrl) throw new Error('Stratus managed browser is not configured');
  const authorization = !apiKey && process.env.VERCEL_ENV === 'production'
    ? `Bearer ${await getVercelOidcToken()}`
    : undefined;
  if (!apiKey && !authorization) throw new Error('Stratus managed browser is not configured');
  const outboundActions = normalizeStratusActions(actions);
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-Stratus-API-Key': apiKey } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({
      url: portalUrl,
      actions: outboundActions,
      screenshot: options.screenshot ?? true,
      allowSubmit: options.allowSubmit === true,
      fullPage: true,
      waitUntil: 'domcontentloaded',
    }),
  });
  const payload = await response.json().catch(() => ({})) as { run?: ManagedBrowserResult; error?: ManagedBrowserError };
  if (!response.ok || !payload.run) {
    throw new Error(managedBrowserErrorMessage(payload.error, response.status, outboundActions));
  }
  return payload.run;
}

export async function createBrowserContext(): Promise<string> {
  const result = await request<{ id: string }>('/contexts', { method: 'POST', body: '{}' });
  return result.id;
}

export function browserSessionBody(
  contextId: string,
  portalUrl: string,
  projectId?: string,
  provider: BrowserProvider = 'browserbase',
) {
  const hostname = new URL(portalUrl).hostname;
  if (provider === 'stratus') {
    return {
      keepAlive: true,
      timeout: 3600,
      contextId,
      browserSettings: {
        protectionPolicy: {
          allowedHosts: [hostname],
          minNavigationIntervalMs: 1000,
          challengeBehavior: 'pause',
          captureEvidence: true,
        },
      },
    };
  }
  return {
    ...(projectId ? { projectId } : {}),
    keepAlive: true,
    browserSettings: {
      context: { id: contextId, persist: true },
      allowedDomains: [hostname],
      solveCaptchas: false,
    },
  };
}

export async function createBrowserSession(contextId: string, portalUrl: string): Promise<SessionResponse> {
  const { projectId, provider } = config();
  if (provider === 'stratus-managed') throw new Error('Managed Stratus uses bounded runs instead of persistent sessions');
  return request<SessionResponse>('/sessions', {
    method: 'POST',
    body: JSON.stringify(browserSessionBody(contextId, portalUrl, projectId, provider)),
  });
}

export async function getBrowserSession(sessionId: string): Promise<SessionResponse> {
  return request<SessionResponse>(`/sessions/${encodeURIComponent(sessionId)}`);
}

export async function getLiveViewUrl(sessionId: string): Promise<string> {
  const result = await request<{ debuggerFullscreenUrl?: string; debuggerUrl?: string }>(
    `/sessions/${encodeURIComponent(sessionId)}/debug`,
  );
  const url = result.debuggerFullscreenUrl ?? result.debuggerUrl;
  if (!url) throw new Error('Secure browser provider did not return a live view URL');
  return url;
}

export async function connectToSession(session: SessionResponse): Promise<{ browser: Browser; page: Page }> {
  const connectUrl = session.connectUrl ?? session.connect_url;
  if (!connectUrl) throw new Error('Secure browser provider did not return a connection URL');
  const browser = await chromium.connectOverCDP(connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, page };
}
