import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { db } from '../db';
import { billingRoutes } from './billing';

const USER_ID = '6d58c1f5-e885-41f7-a16a-dac37f98ab17';
const SECRET = 'test-signing-secret-32-chars-minimum!!';
const PAY_SECRET = 'test-litos-pay-secret-at-least-32-chars';

const savedEnv = {
  vercel: process.env.VERCEL,
  log: process.env.LOG_LEVEL,
  database: process.env.DATABASE_URL,
  jwt: process.env.JWT_SIGNING_SECRET,
  encryption: process.env.ENCRYPTION_KEY,
  payEnabled: process.env.LITOS_PAY_PROCESSOR_ENABLED,
  trialEnabled: process.env.LITOS_PAY_TEST_TRIAL_ENABLED,
  paySecret: process.env.LITOS_PAY_SIGNING_SECRET,
  payBase: process.env.LITOS_PAY_CHECKOUT_BASE_URL,
  nodeEnv: process.env.NODE_ENV,
};

beforeEach(() => {
  process.env.VERCEL = '1';
  process.env.LOG_LEVEL = 'silent';
  process.env.DATABASE_URL = 'postgresql://postgres:password@localhost:5432/unused-in-these-tests';
  process.env.JWT_SIGNING_SECRET = SECRET;
  process.env.ENCRYPTION_KEY = 'test-encryption-key-at-least-32-chars-long';
  process.env.LITOS_PAY_PROCESSOR_ENABLED = 'true';
  process.env.LITOS_PAY_TEST_TRIAL_ENABLED = 'true';
  process.env.LITOS_PAY_SIGNING_SECRET = PAY_SECRET;
  process.env.LITOS_PAY_CHECKOUT_BASE_URL = 'http://localhost:8787';
  process.env.NODE_ENV = 'test';
});

afterEach(() => {
  mock.restoreAll();
  for (const [key, value] of Object.entries(savedEnv)) {
    const envKey = key === 'payEnabled'
      ? 'LITOS_PAY_PROCESSOR_ENABLED'
      : key === 'trialEnabled'
        ? 'LITOS_PAY_TEST_TRIAL_ENABLED'
        : key === 'paySecret'
          ? 'LITOS_PAY_SIGNING_SECRET'
          : key === 'payBase'
            ? 'LITOS_PAY_CHECKOUT_BASE_URL'
            : key === 'nodeEnv'
              ? 'NODE_ENV'
              : key === 'database'
                ? 'DATABASE_URL'
                : key === 'jwt'
                  ? 'JWT_SIGNING_SECRET'
                  : key === 'encryption'
                    ? 'ENCRYPTION_KEY'
                    : key === 'log'
                      ? 'LOG_LEVEL'
                      : 'VERCEL';
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

async function token() {
  return new SignJWT({
    userId: USER_ID,
    isGuest: false,
    authMethod: 'password',
    sessionVersion: 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(SECRET));
}

function selectUserMock() {
  return mock.method(db, 'select', (() => ({
    from: () => ({
      where: () => ({
        limit: async () => [{
          id: USER_ID,
          email: 'student@example.com',
          is_guest: false,
          guest_expires_at: null,
          session_valid_from: null,
          session_version: 0,
          plan: 'free',
          created_at: new Date('2026-08-01T00:00:00.000Z'),
          trial_ends_at: new Date('2026-08-01T00:00:00.000Z'),
        }],
      }),
    }),
  })) as unknown as typeof db.select);
}

describe('Litos Pay Core billing routes', () => {
  test('creates a Litos checkout intent and completes a paid test trial through the ledger path', async () => {
    selectUserMock();
    const createdOffers: unknown[] = [];
    const txInserts: unknown[] = [];
    const txUpdates: unknown[] = [];

    mock.method(db, 'insert', ((table: unknown) => ({
      values: async (values: unknown) => {
        createdOffers.push({ table, values });
      },
    })) as unknown as typeof db.insert);

    const seenEvents = new Set<string>();
    mock.method(db, 'transaction', (async (callback: (tx: any) => Promise<void>) => {
      const tx = {
        insert: (table: unknown) => ({
          values: (values: unknown) => {
            const row = values as { event_key?: string };
            return {
              onConflictDoNothing: () => {
                if (!row.event_key) txInserts.push({ table, values });
                return {
                  returning: async () => {
                    if (row.event_key) {
                      if (seenEvents.has(row.event_key)) return [];
                      seenEvents.add(row.event_key);
                    }
                    txInserts.push({ table, values });
                    return row.event_key ? [{ event_key: row.event_key }] : [];
                  },
                };
              },
              then: undefined,
            };
          },
        }),
        update: (table: unknown) => ({
          set: (values: unknown) => ({
            where: async () => {
              txUpdates.push({ table, values });
            },
          }),
        }),
      };
      await callback(tx);
    }) as unknown as typeof db.transaction);

    const app = Fastify({ logger: false });
    await app.register(billingRoutes);
    await app.ready();
    try {
      const auth = await token();
      const checkout = await app.inject({
        method: 'POST',
        url: '/billing/checkout',
        headers: { authorization: `Bearer ${auth}` },
        payload: { interval: 'annual' },
      });
      assert.equal(checkout.statusCode, 200);
      const checkoutBody = checkout.json();
      assert.equal(checkoutBody.provider, 'litos');
      assert.equal(checkoutBody.amount_cents, 47_988);
      assert.equal(createdOffers.length, 1);

      const checkoutUrl = new URL(checkoutBody.url);
      const trial = await app.inject({
        method: 'POST',
        url: '/billing/litos-pay/test-trial',
        payload: { token: checkoutUrl.searchParams.get('token') },
      });
      assert.equal(trial.statusCode, 200);
      assert.equal(trial.json().plan, 'pro');
      assert.equal(txInserts.length, 1);
      assert.equal(txUpdates.length, 2);
      assert.deepEqual(
        txUpdates.map((entry: any) => entry.values.plan).filter(Boolean),
        ['pro'],
      );

      const replay = await app.inject({
        method: 'POST',
        url: '/billing/litos-pay/test-trial',
        payload: { token: checkoutUrl.searchParams.get('token') },
      });
      assert.equal(replay.statusCode, 200);
      assert.equal(replay.json().processed, false);
      assert.equal(txInserts.length, 1, 'replay must not add another webhook event');
      assert.equal(txUpdates.length, 2, 'replay must not update offer or user state again');
    } finally {
      await app.close();
    }
  });

  test('the test trial completion route is unavailable outside the test runtime', async () => {
    process.env.NODE_ENV = 'production';
    const app = Fastify({ logger: false });
    await app.register(billingRoutes);
    await app.ready();
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/billing/litos-pay/test-trial',
        payload: { token: 'anything' },
      });
      assert.equal(res.statusCode, 404);
    } finally {
      await app.close();
    }
  });
});
