import { PRODUCT_LINKS } from './product';
import { composioQuery, composioRequest } from './composioApi';

export const EMAIL_PROVIDERS = ['gmail', 'outlook'] as const;
export type EmailProvider = typeof EMAIL_PROVIDERS[number];

type ConnectionStatus = 'INITIALIZING' | 'INITIATED' | 'ACTIVE' | 'FAILED' | 'EXPIRED' | 'INACTIVE' | 'REVOKED';

type ConnectedAccount = {
  id: string;
  status: ConnectionStatus;
  toolkit: { slug: string };
  createdAt: string;
  updatedAt: string;
};

export type ComposioLike = {
  connectedAccounts: {
    list(query: {
      userIds: string[];
      toolkitSlugs: string[];
      statuses?: ConnectionStatus[];
      limit?: number;
      orderBy?: 'created_at' | 'updated_at';
    }): Promise<{ items: ConnectedAccount[] }>;
    delete(id: string): Promise<unknown>;
  };
  create(userId: string, config: {
    toolkits: string[];
    authConfigs?: Record<string, string>;
    manageConnections: false;
    sandbox: { enable: false };
  }): Promise<{
    authorize(toolkit: string, options: { callbackUrl: string; alias: string }): Promise<{
      redirectUrl: string;
    }>;
  }>;
};

export type EmailConnectionState = {
  provider: EmailProvider;
  connected: boolean;
  status: ConnectionStatus | 'NOT_CONNECTED';
  connected_at?: string;
};

export function isComposioConfigured(): boolean {
  return Boolean(process.env.COMPOSIO_API_KEY?.trim());
}

async function composioClient(): Promise<ComposioLike> {
  return {
    connectedAccounts: {
      async list(query) {
        const raw = await composioRequest<{
          items: Array<{
            id: string;
            status: ConnectionStatus;
            toolkit: { slug: string };
            created_at: string;
            updated_at: string;
          }>;
        }>(`/api/v3.1/connected_accounts${composioQuery({
          user_ids: query.userIds,
          toolkit_slugs: query.toolkitSlugs,
          statuses: query.statuses,
          limit: query.limit,
          order_by: query.orderBy,
        })}`);
        return {
          items: raw.items.map((account) => ({
            id: account.id,
            status: account.status,
            toolkit: account.toolkit,
            createdAt: account.created_at,
            updatedAt: account.updated_at,
          })),
        };
      },
      async delete(id) {
        return composioRequest(`/api/v3.1/connected_accounts/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
      },
    },
    async create(userId, config) {
      const created = await composioRequest<{ session_id: string }>('/api/v3.1/tool_router/session', {
        method: 'POST',
        body: {
          user_id: userId,
          toolkits: { enable: config.toolkits },
          ...(config.authConfigs ? { auth_configs: config.authConfigs } : {}),
          manage_connections: { enable: config.manageConnections },
          workbench: config.sandbox,
        },
      });
      return {
        async authorize(toolkit, options) {
          const linked = await composioRequest<{ redirect_url: string }>(
            `/api/v3.1/tool_router/session/${encodeURIComponent(created.session_id)}/link`,
            {
              method: 'POST',
              body: {
                toolkit,
                callback_url: options.callbackUrl,
                alias: options.alias,
              },
            },
          );
          return { redirectUrl: linked.redirect_url };
        },
      };
    },
  };
}

function authConfigId(provider: EmailProvider): string | undefined {
  const key = provider === 'gmail'
    ? process.env.COMPOSIO_AUTH_CONFIG_GMAIL
    : process.env.COMPOSIO_AUTH_CONFIG_OUTLOOK;
  return key?.trim() || undefined;
}

export function emailConnectionCallbackUrl(provider: EmailProvider): string {
  const callback = new URL('/dashboard/settings', PRODUCT_LINKS.website);
  callback.searchParams.set('connection', provider);
  return callback.toString();
}

export function isTrustedComposioConnectUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && (url.hostname === 'connect.composio.dev' || url.hostname.endsWith('.connect.composio.dev'));
  } catch {
    return false;
  }
}

export async function getEmailConnectionStates(
  userId: string,
  client?: ComposioLike,
): Promise<EmailConnectionState[]> {
  const resolvedClient = client ?? await composioClient();
  const result = await resolvedClient.connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: [...EMAIL_PROVIDERS],
    limit: 20,
    orderBy: 'updated_at',
  });

  return EMAIL_PROVIDERS.map((provider) => {
    const accounts = result.items
      .filter((account) => account.toolkit.slug.toLowerCase() === provider)
      .sort((left, right) => {
        if (left.status === 'ACTIVE' && right.status !== 'ACTIVE') return -1;
        if (right.status === 'ACTIVE' && left.status !== 'ACTIVE') return 1;
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      });
    const account = accounts[0];
    return {
      provider,
      connected: account?.status === 'ACTIVE',
      status: account?.status ?? 'NOT_CONNECTED',
      connected_at: account?.status === 'ACTIVE' ? account.createdAt : undefined,
    };
  });
}

export async function createEmailConnectionLink(
  userId: string,
  provider: EmailProvider,
  client?: ComposioLike,
): Promise<string> {
  const resolvedClient = client ?? await composioClient();
  const configuredAuth = authConfigId(provider);
  const session = await resolvedClient.create(userId, {
    toolkits: [provider],
    ...(configuredAuth ? { authConfigs: { [provider]: configuredAuth } } : {}),
    manageConnections: false,
    sandbox: { enable: false },
  });
  const request = await session.authorize(provider, {
    callbackUrl: emailConnectionCallbackUrl(provider),
    alias: `litos-${provider}`,
  });
  if (!isTrustedComposioConnectUrl(request.redirectUrl)) {
    throw new Error('Composio returned an invalid connection URL');
  }
  return request.redirectUrl;
}

async function revokeUpstream(id: string): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) throw new Error('Composio is not configured');
  const apiBase = (process.env.COMPOSIO_API_BASE ?? 'https://backend.composio.dev').replace(/\/$/, '');
  const response = await fetch(`${apiBase}/api/v3.1/connected_accounts/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey },
    signal: AbortSignal.timeout(10_000),
  });
  // Some providers do not support upstream revocation. A missing or already-revoked account is
  // also safe to remove from Composio. Every other error stops deletion so access is not falsely
  // reported as disconnected while a live token remains.
  if (!response.ok && ![400, 404, 409].includes(response.status)) {
    throw new Error(`Composio token revocation failed with status ${response.status}`);
  }
}

export async function disconnectEmailProvider(
  userId: string,
  provider: EmailProvider,
  options: { client?: ComposioLike; revoke?: (id: string) => Promise<void> } = {},
): Promise<number> {
  const client = options.client ?? await composioClient();
  const result = await client.connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: [provider],
    limit: 20,
    orderBy: 'updated_at',
  });
  const revoke = options.revoke ?? revokeUpstream;
  for (const account of result.items) {
    if (account.status === 'ACTIVE') await revoke(account.id);
    await client.connectedAccounts.delete(account.id);
  }
  return result.items.length;
}
