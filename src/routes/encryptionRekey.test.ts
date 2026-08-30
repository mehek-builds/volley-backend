import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { decryptField, encryptField, FieldDecryptError } from '../lib/fieldCrypto';
import {
  encryptionRekeyRoutes,
  rekeyApplicationProfileRow,
  type EncryptionRekeyDependencies,
} from './encryptionRekey';

const ENV_KEYS = ['ENCRYPTION_KEY', 'ENCRYPTION_KEY_NEXT', 'INTERNAL_CRON_SECRET', 'CRON_SECRET'] as const;
const savedEnvironment = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const saved = savedEnvironment.get(key);
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

function encryptUnder(key: string, plaintext: string): string {
  const previous = process.env.ENCRYPTION_KEY;
  const previousNext = process.env.ENCRYPTION_KEY_NEXT;
  process.env.ENCRYPTION_KEY = key;
  delete process.env.ENCRYPTION_KEY_NEXT;
  try {
    return encryptField(plaintext);
  } finally {
    if (previous === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = previous;
    if (previousNext === undefined) delete process.env.ENCRYPTION_KEY_NEXT;
    else process.env.ENCRYPTION_KEY_NEXT = previousNext;
  }
}

test('rewrites only authenticated profile envelopes and leaves legacy plaintext untouched', () => {
  const oldPhone = encryptUnder('old-key', '+971 50 123 4567');
  const oldEligibility = encryptUnder('old-key', '[{"country":"AE"}]');
  process.env.ENCRYPTION_KEY = 'old-key';
  process.env.ENCRYPTION_KEY_NEXT = 'next-key';

  const result = rekeyApplicationProfileRow({
    user_id: 'user-1',
    phone: oldPhone,
    work_eligibility_by_country: oldEligibility,
    address_city: 'Dubai',
    citizenship: null,
  });

  assert.equal(result.envelopes, 2);
  assert.deepEqual(Object.keys(result.updates).sort(), ['phone', 'work_eligibility_by_country']);

  process.env.ENCRYPTION_KEY = 'next-key';
  delete process.env.ENCRYPTION_KEY_NEXT;
  assert.equal(decryptField(result.updates.phone), '+971 50 123 4567');
  assert.equal(decryptField(result.updates.work_eligibility_by_country), '[{"country":"AE"}]');

  process.env.ENCRYPTION_KEY = 'old-key';
  assert.throws(() => decryptField(result.updates.phone), FieldDecryptError);
});

async function withApp(
  dependencies: EncryptionRekeyDependencies,
  run: (app: FastifyInstance) => Promise<void>,
) {
  const app = Fastify({ logger: false });
  await app.register(encryptionRekeyRoutes, { dependencies });
  await app.ready();
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

test('the route refuses to exist as an unauthenticated key-rotation primitive', async () => {
  process.env.ENCRYPTION_KEY = 'old-key';
  process.env.ENCRYPTION_KEY_NEXT = 'next-key';
  process.env.INTERNAL_CRON_SECRET = 'internal-secret';
  const dependencies = {
    rekeyProfiles: async () => ({
      profiles_scanned: 49,
      profiles_updated: 32,
      envelopes_reencrypted: 120,
    }),
  };

  await withApp(dependencies, async (app) => {
    const response = await app.inject({ method: 'POST', url: '/internal/encryption-rekey' });
    assert.equal(response.statusCode, 401);
  });
});

test('the route refuses to run until the next key is explicitly configured', async () => {
  process.env.ENCRYPTION_KEY = 'old-key';
  delete process.env.ENCRYPTION_KEY_NEXT;
  process.env.INTERNAL_CRON_SECRET = 'internal-secret';

  await withApp({
    rekeyProfiles: async () => ({
      profiles_scanned: 0,
      profiles_updated: 0,
      envelopes_reencrypted: 0,
    }),
  }, async (app) => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/encryption-rekey',
      headers: { 'x-internal-secret': 'internal-secret' },
    });
    assert.equal(response.statusCode, 503);
    assert.match(response.body, /ENCRYPTION_KEY_NEXT/);
  });
});

test('the authorized route reports counts and never returns protected values', async () => {
  process.env.ENCRYPTION_KEY = 'old-key';
  process.env.ENCRYPTION_KEY_NEXT = 'next-key';
  process.env.INTERNAL_CRON_SECRET = 'internal-secret';
  const dependencies = {
    rekeyProfiles: async () => ({
      profiles_scanned: 49,
      profiles_updated: 32,
      envelopes_reencrypted: 120,
    }),
  };

  await withApp(dependencies, async (app) => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/encryption-rekey',
      headers: { 'x-internal-secret': 'internal-secret' },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      profiles_scanned: 49,
      profiles_updated: 32,
      envelopes_reencrypted: 120,
      verified_with_next_key: true,
    });
  });
});
