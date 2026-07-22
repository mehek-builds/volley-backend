import { chromium, type Browser, type Page } from 'playwright-core';
import { getVercelOidcToken } from '@vercel/oidc';

export type BrowserProvider = 'browserbase' | 'stratus' | 'stratus-managed';

export type ManagedBrowserAction = {
  type: 'click' | 'fill' | 'fillByLabelText' | 'upload' | 'waitForSelector' | 'press' | 'select' | 'extract';
  selector?: string;
  value?: string;
  text?: string;
  label?: string;
  optional?: boolean;
  timeout?: number;
  attribute?: string;
  file?: { name: string; mimeType: string; base64: string };
};

export type ManagedBrowserResult = {
  title: string;
  url: string;
  text: string;
  screenshot?: string | null;
  filledFields?: string[];
  blockers?: string[];
};

type ManagedBrowserError = string | { message?: string; code?: string };

function managedBrowserErrorMessage(error: ManagedBrowserError | undefined, status: number): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) return error.message;
  return `Stratus managed browser request failed with status ${status}`;
}

type SessionResponse = {
  id: string;
  connectUrl?: string;
  connect_url?: string;
};

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

export async function runManagedBrowser(
  portalUrl: string,
  actions: ManagedBrowserAction[],
): Promise<ManagedBrowserResult> {
  const baseUrl = process.env.STRATUS_BASE_URL?.replace(/\/$/, '');
  const apiKey = process.env.STRATUS_API_KEY?.trim();
  if (!baseUrl) throw new Error('Stratus managed browser is not configured');
  const authorization = !apiKey && process.env.VERCEL_ENV === 'production'
    ? `Bearer ${await getVercelOidcToken()}`
    : undefined;
  if (!apiKey && !authorization) throw new Error('Stratus managed browser is not configured');
  const response = await fetch(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'X-Stratus-API-Key': apiKey } : {}),
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({ url: portalUrl, actions, screenshot: true, fullPage: true, waitUntil: 'domcontentloaded' }),
  });
  const payload = await response.json().catch(() => ({})) as { run?: ManagedBrowserResult; error?: ManagedBrowserError };
  if (!response.ok || !payload.run) {
    throw new Error(managedBrowserErrorMessage(payload.error, response.status));
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
