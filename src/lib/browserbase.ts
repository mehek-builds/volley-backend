import { chromium, type Browser, type Page } from 'playwright-core';

export type BrowserProvider = 'browserbase' | 'stratus';

type SessionResponse = {
  id: string;
  connectUrl?: string;
  connect_url?: string;
};

function config() {
  const provider: BrowserProvider = process.env.BROWSER_PROVIDER === 'stratus' || Boolean(process.env.STRATUS_BASE_URL)
    ? 'stratus'
    : 'browserbase';
  const apiKey = process.env.BROWSER_API_KEY
    ?? (provider === 'stratus' ? process.env.STRATUS_API_KEY : process.env.BROWSERBASE_API_KEY);
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
  const provider: BrowserProvider = process.env.BROWSER_PROVIDER === 'stratus' || Boolean(process.env.STRATUS_BASE_URL)
    ? 'stratus'
    : 'browserbase';
  return Boolean(process.env.BROWSER_API_KEY
    ?? (provider === 'stratus' ? process.env.STRATUS_API_KEY : process.env.BROWSERBASE_API_KEY));
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
