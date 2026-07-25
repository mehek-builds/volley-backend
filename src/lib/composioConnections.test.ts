import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createEmailConnectionLink,
  disconnectEmailProvider,
  emailConnectionCallbackUrl,
  getEmailConnectionStates,
  isTrustedComposioConnectUrl,
  type ComposioLike,
} from './composioConnections';

function account(id: string, provider: 'gmail' | 'outlook', status: 'ACTIVE' | 'EXPIRED', updatedAt: string) {
  return {
    id,
    status,
    toolkit: { slug: provider },
    createdAt: '2026-07-25T10:00:00.000Z',
    updatedAt,
  } as const;
}

test('uses the stable settings callback and rejects lookalike connect hosts', () => {
  assert.equal(emailConnectionCallbackUrl('gmail'), 'https://trylitos.com/dashboard/settings?connection=gmail');
  assert.equal(isTrustedComposioConnectUrl('https://connect.composio.dev/link/ln_123'), true);
  assert.equal(isTrustedComposioConnectUrl('https://connect.composio.dev.example/link/ln_123'), false);
  assert.equal(isTrustedComposioConnectUrl('http://connect.composio.dev/link/ln_123'), false);
});

test('connection status prefers an active account over a newer expired attempt', async () => {
  const client = {
    connectedAccounts: {
      list: async () => ({ items: [
        account('expired', 'gmail', 'EXPIRED', '2026-07-25T12:00:00.000Z'),
        account('active', 'gmail', 'ACTIVE', '2026-07-25T11:00:00.000Z'),
      ] }),
      delete: async () => undefined,
    },
    create: async () => { throw new Error('not used'); },
  } as unknown as ComposioLike;
  assert.deepEqual(await getEmailConnectionStates('user-123', client), [
    {
      provider: 'gmail',
      connected: true,
      status: 'ACTIVE',
      connected_at: '2026-07-25T10:00:00.000Z',
    },
    { provider: 'outlook', connected: false, status: 'NOT_CONNECTED', connected_at: undefined },
  ]);
});

test('creates a hosted connection link for exactly one provider and user', async () => {
  const calls: unknown[] = [];
  const client = {
    connectedAccounts: { list: async () => ({ items: [] }), delete: async () => undefined },
    create: async (userId: string, config: unknown) => {
      calls.push({ userId, config });
      return {
        authorize: async (toolkit: string, options: unknown) => {
          calls.push({ toolkit, options });
          return { redirectUrl: 'https://connect.composio.dev/link/ln_123' };
        },
      };
    },
  } as unknown as ComposioLike;
  const redirect = await createEmailConnectionLink('user-123', 'outlook', client);
  assert.equal(redirect, 'https://connect.composio.dev/link/ln_123');
  assert.deepEqual(calls, [
    {
      userId: 'user-123',
      config: {
        toolkits: ['outlook'],
        manageConnections: false,
        sandbox: { enable: false },
      },
    },
    {
      toolkit: 'outlook',
      options: {
        callbackUrl: 'https://trylitos.com/dashboard/settings?connection=outlook',
        alias: 'litos-outlook',
      },
    },
  ]);
});

test('disconnect revokes active upstream tokens before deleting every provider account', async () => {
  const events: string[] = [];
  const client = {
    connectedAccounts: {
      list: async () => ({ items: [
        account('active', 'gmail', 'ACTIVE', '2026-07-25T11:00:00.000Z'),
        account('expired', 'gmail', 'EXPIRED', '2026-07-25T10:00:00.000Z'),
      ] }),
      delete: async (id: string) => { events.push(`delete:${id}`); },
    },
    create: async () => { throw new Error('not used'); },
  } as unknown as ComposioLike;
  const removed = await disconnectEmailProvider('user-123', 'gmail', {
    client,
    revoke: async (id) => { events.push(`revoke:${id}`); },
  });
  assert.equal(removed, 2);
  assert.deepEqual(events, ['revoke:active', 'delete:active', 'delete:expired']);
});
