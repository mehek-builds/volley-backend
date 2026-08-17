import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  acceptSignedManagedReceivingCanary,
  configuredManagedReceivingCanaryRecipient,
  managedReceivingProofRouteFingerprint,
  recentManagedReceivingProof,
  recordManagedReceivingProofFromDelivery,
  type ManagedReceivingProof,
  type ManagedReceivingProofStore,
} from './applicationEmailReceivingProof';

const DOMAIN = 'litos-inbound.resend.app';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789abcdef';
const RECIPIENT = `litos-proof-${TOKEN}@${DOMAIN}`;

class MemoryProofStore implements ManagedReceivingProofStore {
  rows: ManagedReceivingProof[] = [];

  async findByMessageHash(hash: string) {
    return this.rows.find((row) => row.provider_message_hash === hash) ?? null;
  }

  async findCurrent(routeFingerprint: string, domain: string, proofVersion: number, notBefore: Date) {
    return this.rows.find((row) => row.route_fingerprint === routeFingerprint
      && row.domain === domain
      && row.proof_version === proofVersion
      && row.verified_at >= notBefore) ?? null;
  }

  async insert(proof: ManagedReceivingProof) {
    if (this.rows.some((row) => row.provider_message_hash === proof.provider_message_hash
      || row.route_fingerprint === proof.route_fingerprint)) return false;
    this.rows.push(proof);
    return true;
  }
}

async function withManagedProofEnv<T>(run: () => Promise<T>): Promise<T> {
  const names = [
    'LITOS_APPLICATION_EMAIL_ROUTE_MODE',
    'LITOS_RESEND_MANAGED_RECEIVING_DOMAIN',
    'LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN',
    'LITOS_APPLICATION_EMAIL_ALIAS_SECRET',
    'LITOS_APPLICATION_EMAIL_SECRET',
    'JWT_SIGNING_SECRET',
    'LITOS_APPLICATION_EMAIL_DOMAIN',
    'LITOS_APPLICATION_EMAIL_MAILBOX',
    'LITOS_APPLICATION_EMAIL_WEBHOOK_URL',
    'RESEND_WEBHOOK_SECRET',
    'RESEND_RECEIVING_API_KEY',
    'RESEND_API_KEY',
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'managed_resend';
    process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = DOMAIN;
    process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN = TOKEN;
    process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'proof-alias-secret';
    process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_URL = 'https://student-outreach-backend.vercel.app/webhooks/application-email/inbound';
    process.env.RESEND_WEBHOOK_SECRET = 'whsec_current-resend-signing-secret';
    process.env.RESEND_RECEIVING_API_KEY = 're_receiving-account-key';
    return await run();
  } finally {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function acceptReadableCanary(
  event: Parameters<typeof acceptSignedManagedReceivingCanary>[0],
  options: Parameters<typeof acceptSignedManagedReceivingCanary>[1] = {},
) {
  return acceptSignedManagedReceivingCanary(event, {
    assertContentReadable: async () => {},
    ...options,
  });
}

test('derives one exact hidden canary recipient only from valid managed configuration', async () => {
  await withManagedProofEnv(async () => {
    assert.equal(configuredManagedReceivingCanaryRecipient(), RECIPIENT);
    process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN = 'too-short';
    assert.equal(configuredManagedReceivingCanaryRecipient(), null);
    assert.equal(managedReceivingProofRouteFingerprint(), null);
    process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN = TOKEN;
    delete process.env.RESEND_WEBHOOK_SECRET;
    assert.equal(managedReceivingProofRouteFingerprint(), null);
  });
});

test('accepts, minimally stores, and idempotently replays the exact signed canary event', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    const now = new Date('2026-08-09T03:00:00.000Z');
    const event = { emailId: 'provider-message-one', recipients: [RECIPIENT] };
    assert.deepEqual(await acceptReadableCanary(event, { store, now }), {
      kind: 'accepted', replay: false,
    });
    assert.equal(store.rows.length, 1);
    assert.deepEqual(Object.keys(store.rows[0]!).sort(), [
      'domain', 'proof_version', 'provider_message_hash', 'route_fingerprint', 'verified_at',
    ]);
    const serialized = JSON.stringify(store.rows[0]);
    assert.ok(!serialized.includes(RECIPIENT));
    assert.ok(!serialized.includes('provider-message-one'));
    assert.ok(!serialized.includes('proof-alias-secret'));
    assert.deepEqual(await acceptReadableCanary(event, { store, now }), {
      kind: 'accepted', replay: true,
    });
    assert.equal(store.rows[0]!.verified_at.toISOString(), now.toISOString());
  });
});

test('never persists proof when the provider cannot read the signed canary content', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    let readEmailId: string | null = null;
    await assert.rejects(
      acceptSignedManagedReceivingCanary(
        { emailId: 'unreadable-provider-message', recipients: [RECIPIENT] },
        {
          store,
          assertContentReadable: async (emailId) => {
            readEmailId = emailId;
            throw new Error('Resend received email lookup failed with 401');
          },
        },
      ),
      /lookup failed with 401/,
    );
    assert.equal(readEmailId, 'unreadable-provider-message');
    assert.equal(store.rows.length, 0);
    assert.equal(await recentManagedReceivingProof({ store }), false);
  });
});

test('rejects copied, foreign, old, and second-use canary deliveries', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    assert.deepEqual(await acceptReadableCanary({
      emailId: 'foreign', recipients: ['other@foreign.resend.app'],
    }, { store }), { kind: 'not_canary' });
    assert.deepEqual(await acceptReadableCanary({
      emailId: 'old', recipients: [`litos-proof-${'z'.repeat(43)}@${DOMAIN}`],
    }, { store }), { kind: 'not_canary' });
    assert.deepEqual(await acceptReadableCanary({
      emailId: 'copied', recipients: [RECIPIENT, 'copy@example.com'],
    }, { store }), { kind: 'rejected' });
    assert.equal((await acceptReadableCanary({
      emailId: 'first', recipients: [RECIPIENT],
    }, { store })).kind, 'accepted');
    assert.deepEqual(await acceptReadableCanary({
      emailId: 'second', recipients: [RECIPIENT],
    }, { store }), { kind: 'rejected' });
  });
});

test('mode, domain, alias-secret, endpoint, signing-secret, receiving-key, and canary rotation invalidate old proof', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    const event = { emailId: 'bound-message', recipients: [RECIPIENT] };
    assert.equal((await acceptReadableCanary(event, { store })).kind, 'accepted');

    process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'rotated-alias-secret';
    assert.deepEqual(await acceptReadableCanary(event, { store }), { kind: 'rejected' });
    assert.equal(await recentManagedReceivingProof({ store }), false);

    process.env.LITOS_APPLICATION_EMAIL_ALIAS_SECRET = 'proof-alias-secret';
    process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_URL = 'https://alternate.example/webhooks/application-email/inbound';
    assert.equal(await recentManagedReceivingProof({ store }), false);

    process.env.LITOS_APPLICATION_EMAIL_WEBHOOK_URL = 'https://student-outreach-backend.vercel.app/webhooks/application-email/inbound/';
    assert.equal(await recentManagedReceivingProof({ store }), true);

    process.env.RESEND_WEBHOOK_SECRET = 'whsec_rotated-resend-signing-secret';
    assert.equal(await recentManagedReceivingProof({ store }), false);

    process.env.RESEND_WEBHOOK_SECRET = 'whsec_current-resend-signing-secret';
    process.env.RESEND_RECEIVING_API_KEY = 're_rotated-receiving-account-key';
    assert.equal(await recentManagedReceivingProof({ store }), false);

    process.env.RESEND_RECEIVING_API_KEY = 're_receiving-account-key';
    process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = 'other-inbound.resend.app';
    assert.equal(await recentManagedReceivingProof({ store }), false);

    process.env.LITOS_RESEND_MANAGED_RECEIVING_DOMAIN = DOMAIN;
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'custom_domain';
    process.env.LITOS_APPLICATION_EMAIL_DOMAIN = 'custom.example.com';
    assert.equal(await recentManagedReceivingProof({ store }), false);
  });
});

test('version-one proof is never health evidence and cannot reuse its one-time recipient', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    const legacyFingerprint = createHash('sha256')
      .update(`managed-receiving-proof-v1:managed_resend:${DOMAIN}:proof-alias-secret:${TOKEN}`)
      .digest('hex');
    store.rows.push({
      provider_message_hash: 'legacy-message-hash',
      route_fingerprint: legacyFingerprint,
      proof_version: 1,
      domain: DOMAIN,
      verified_at: new Date('2026-08-09T03:00:00.000Z'),
    });
    assert.equal(await recentManagedReceivingProof({
      store,
      now: new Date('2026-08-09T03:01:00.000Z'),
    }), false);
    assert.deepEqual(await acceptReadableCanary({
      emailId: 'new-message-same-recipient', recipients: [RECIPIENT],
    }, { store, now: new Date('2026-08-09T03:01:00.000Z') }), { kind: 'rejected' });
    assert.equal(store.rows.length, 1);
  });
});

test('route-only version-two proof is never health evidence and forces a new canary token', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    const routeOnlyFingerprint = createHash('sha256')
      .update(`managed-receiving-proof-v2:managed_resend:${DOMAIN}:proof-alias-secret:${TOKEN}:https://student-outreach-backend.vercel.app/webhooks/application-email/inbound:whsec_current-resend-signing-secret`)
      .digest('hex');
    store.rows.push({
      provider_message_hash: 'route-only-message-hash',
      route_fingerprint: routeOnlyFingerprint,
      proof_version: 2,
      domain: DOMAIN,
      verified_at: new Date('2026-08-09T03:00:00.000Z'),
    });
    assert.equal(await recentManagedReceivingProof({ store }), false);
    assert.deepEqual(await acceptReadableCanary({
      emailId: 'new-message-same-version-two-recipient', recipients: [RECIPIENT],
    }, { store }), { kind: 'rejected' });
    assert.equal(store.rows.length, 1);
  });
});

test('health proof requires a current, nonfuture proof inside the freshness window', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    const now = new Date('2026-08-09T03:00:00.000Z');
    await acceptReadableCanary({ emailId: 'fresh', recipients: [RECIPIENT] }, { store, now });
    assert.equal(await recentManagedReceivingProof({ store, now }), true);
    assert.equal(await recentManagedReceivingProof({
      store,
      now: new Date('2026-08-17T03:00:00.000Z'),
    }), false);
    assert.deepEqual(await acceptReadableCanary({
      emailId: 'fresh', recipients: [RECIPIENT],
    }, { store, now: new Date('2026-08-17T03:00:00.000Z') }), { kind: 'accepted', replay: true });
    assert.equal(await recentManagedReceivingProof({
      store,
      now: new Date('2026-08-17T03:00:00.000Z'),
    }), false);
    assert.equal(await recentManagedReceivingProof({
      store,
      now: new Date('2026-08-09T02:59:59.000Z'),
    }), false);
  });
});

test('migration and setup keep proof minimal and canary material out of output and argv', () => {
  const migration = readFileSync('scripts/apply-application-email-receiving-proof-schema.mjs', 'utf8');
  for (const column of ['provider_message_hash', 'route_fingerprint', 'proof_version', 'domain', 'verified_at']) {
    assert.match(migration, new RegExp(column));
  }
  assert.doesNotMatch(migration, /\b(subject|body|headers|recipient|raw_json|secret)\b/i);

  const setup = readFileSync('scripts/configure-resend-receiving-canary.mjs', 'utf8');
  assert.match(setup, /randomBytes\(32\)/);
  assert.match(setup, /input: `\$\{token\}\\n`/);
  assert.doesNotMatch(setup, /console\.(?:log|error)\([^\n]*(?:token|recipient)\s*[,)}]/i);
  assert.doesNotMatch(setup, /'--value'/);
});

/* Real inbound mail proves the route too, which is what broke the 2026-08-17 deadlock.
 *
 * The canary was the only writer of proof and only the daily cron can send it, because the recipient
 * embeds a token Vercel stores as `sensitive` - write-only, unreadable even through the API with
 * decrypt=true. When the proof aged out, recovery was circular: a fresh proof needed an inbound
 * delivery, submissions generate inbound deliveries, and the stale proof was blocking submissions.
 * Real employer mail was arriving on the same path the whole time and was being discarded. */
test('an accepted delivery to the managed domain records proof', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    const recorded = await recordManagedReceivingProofFromDelivery(
      { emailId: 'resend-inbound-1', recipients: [`app-abc123@${DOMAIN}`] },
      { store, assertContentReadable: async () => {}, now: new Date('2026-08-17T16:00:00.000Z') },
    );
    assert.equal(recorded, true);
    assert.equal(store.rows.length, 1);
    assert.equal(store.rows[0].domain, DOMAIN);
    assert.equal(store.rows[0].proof_version, 3);
    assert.equal(store.rows[0].route_fingerprint, managedReceivingProofRouteFingerprint());

    // And it is immediately usable as health evidence, which is the whole point.
    assert.equal(await recentManagedReceivingProof({
      store,
      now: new Date('2026-08-17T16:00:01.000Z'),
    }), true);
  });
});

test('a delivery addressed only to another domain proves nothing', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    const recorded = await recordManagedReceivingProofFromDelivery(
      { emailId: 'resend-inbound-2', recipients: ['someone@other-domain.example'] },
      { store, assertContentReadable: async () => {} },
    );
    assert.equal(recorded, false);
    assert.equal(store.rows.length, 0);
  });
});

test('a delivery whose content the receiving key cannot read records nothing', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    await assert.rejects(() => recordManagedReceivingProofFromDelivery(
      { emailId: 'resend-inbound-3', recipients: [`app-abc123@${DOMAIN}`] },
      {
        store,
        assertContentReadable: async () => { throw new Error('receiving read scope missing'); },
      },
    ), /receiving read scope missing/);
    assert.equal(store.rows.length, 0);
  });
});

test('the same provider message is idempotent rather than a second proof row', async () => {
  await withManagedProofEnv(async () => {
    const store = new MemoryProofStore();
    const args = {
      emailId: 'resend-inbound-4',
      recipients: [`app-abc123@${DOMAIN}`],
    };
    const opts = { store, assertContentReadable: async () => {} };
    assert.equal(await recordManagedReceivingProofFromDelivery(args, opts), true);
    assert.equal(await recordManagedReceivingProofFromDelivery(args, opts), true);
    assert.equal(store.rows.length, 1);
  });
});

test('a delivery records nothing when the route is not managed Resend', async () => {
  await withManagedProofEnv(async () => {
    process.env.LITOS_APPLICATION_EMAIL_ROUTE_MODE = 'custom_domain';
    const store = new MemoryProofStore();
    assert.equal(await recordManagedReceivingProofFromDelivery(
      { emailId: 'resend-inbound-5', recipients: [`app-abc123@${DOMAIN}`] },
      { store, assertContentReadable: async () => {} },
    ), false);
    assert.equal(store.rows.length, 0);
  });
});
