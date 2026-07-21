import { chromium, type Browser, type Page } from 'playwright-core';

const API_ROOT = 'https://api.browserbase.com/v1';

type SessionResponse = {
  id: string;
  connectUrl?: string;
  connect_url?: string;
};

function config() {
  const apiKey = process.env.BROWSERBASE_API_KEY;
  const projectId = process.env.BROWSERBASE_PROJECT_ID;
  if (!apiKey || !projectId) {
    throw new Error('Browserbase is not configured. Add BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID.');
  }
  return { apiKey, projectId };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { apiKey } = config();
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-BB-API-Key': apiKey,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) throw new Error(`Browserbase request failed with status ${response.status}`);
  return response.json() as Promise<T>;
}

export function isBrowserbaseConfigured(): boolean {
  return Boolean(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID);
}

export async function createBrowserContext(): Promise<string> {
  const result = await request<{ id: string }>('/contexts', { method: 'POST', body: '{}' });
  return result.id;
}

export async function createBrowserSession(contextId: string): Promise<SessionResponse> {
  const { projectId } = config();
  return request<SessionResponse>('/sessions', {
    method: 'POST',
    body: JSON.stringify({
      projectId,
      keepAlive: true,
      browserSettings: { context: { id: contextId, persist: true } },
    }),
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
  if (!url) throw new Error('Browserbase did not return a live view URL');
  return url;
}

export async function connectToSession(session: SessionResponse): Promise<{ browser: Browser; page: Page }> {
  const connectUrl = session.connectUrl ?? session.connect_url;
  if (!connectUrl) throw new Error('Browserbase did not return a connection URL');
  const browser = await chromium.connectOverCDP(connectUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser, page };
}
