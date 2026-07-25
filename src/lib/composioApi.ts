const DEFAULT_COMPOSIO_API_BASE = 'https://backend.composio.dev';

function apiBase(): string {
  return (process.env.COMPOSIO_API_BASE ?? DEFAULT_COMPOSIO_API_BASE).replace(/\/$/, '');
}

function apiKey(): string {
  const key = process.env.COMPOSIO_API_KEY?.trim();
  if (!key) throw new Error('Composio is not configured');
  return key;
}

export async function composioRequest<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'x-api-key': apiKey(),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: options.signal ?? AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Composio request failed with status ${response.status}`);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export function composioQuery(params: Record<string, string | number | string[] | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    query.set(key, Array.isArray(value) ? value.join(',') : String(value));
  }
  const serialized = query.toString();
  return serialized ? `?${serialized}` : '';
}
