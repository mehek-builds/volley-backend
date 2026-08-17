import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MANAGED_RECEIVING_CANARY_REFRESH_LEAD_MS,
  managedReceivingCanaryHttpStatus,
  managedReceivingProofNeedsRefresh,
  sendManagedReceivingCanary,
} from './managedReceivingCanary';
import {
  MANAGED_RECEIVING_PROOF_MAX_AGE_MS,
  MANAGED_RECEIVING_PROOF_VERSION,
  managedReceivingProofRouteFingerprint,
  type ManagedReceivingProof,
  type ManagedReceivingProofStore,
} from './applicationEmailReceivingProof';

const DOMAIN = 'canary.resend.app';
const TOKEN = 'canary-token-that-is-long-enough-to-pass-0123456789';
const NOW = new Date('2026-08-17T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

class MemoryStore implements ManagedReceivingProofStore {
  constructor(readonly rows: ManagedReceivingProof[] = []) {}

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
    'RESEND_FROM',
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
    process.env.RESEND_API_KEY = 're_sending-account-key';
    process.env.RESEND_FROM = 'Litos <no-reply@trylitos.com>';
    return await run();
  } finally {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function proofAged(ms: number, fingerprint: string): ManagedReceivingProof {
  return {
    provider_message_hash: `hash-${ms}`,
    route_fingerprint: fingerprint,
    proof_version: MANAGED_RECEIVING_PROOF_VERSION,
    domain: DOMAIN,
    verified_at: new Date(NOW.getTime() - ms),
  };
}

/** The fingerprint the code under test builds from the fixture env. */
function currentFingerprint(): string {
  const fingerprint = managedReceivingProofRouteFingerprint();
  if (!fingerprint) throw new Error('fixture env does not produce a fingerprint');
  return fingerprint;
}

type SendCall = { url: string; body: { to: string; from: string; subject: string } };

function okFetch(calls: SendCall[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response('{"id":"sent"}', { status: 200 });
  }) as unknown as typeof fetch;
}

/* Both ages stated absolutely, deliberately.
 *
 * Deriving them from MAX_AGE - LEAD would make the assertion true for every lead including zero,
 * and a lead of zero is exactly the bug: it refreshes only after expiry, so production degrades on
 * every cycle. Six days is the load-bearing case - the proof is still VALID there, and a refresh
 * must already be asked for. */
test('asks for a refresh two days before expiry, while the proof is still valid', async () => {
  await withManagedProofEnv(async () => {
    const fingerprint = currentFingerprint();
    assert.equal(MANAGED_RECEIVING_PROOF_MAX_AGE_MS, 7 * DAY_MS);
    assert.equal(MANAGED_RECEIVING_CANARY_REFRESH_LEAD_MS, 2 * DAY_MS);

    // Six days old: inside the lead, not yet expired. Must ask for a refresh.
    assert.equal(await managedReceivingProofNeedsRefresh({
      store: new MemoryStore([proofAged(6 * DAY_MS, fingerprint)]),
      now: NOW,
    }), true);

    // Four days old: outside the lead. Must not.
    assert.equal(await managedReceivingProofNeedsRefresh({
      store: new MemoryStore([proofAged(4 * DAY_MS, fingerprint)]),
      now: NOW,
    }), false);
  });
});

/* The production failure, as a test.
 *
 * A proof older than MANAGED_RECEIVING_PROOF_MAX_AGE_MS is what /health reported as
 * managed_receiving_proof_mismatch on 2026-08-17, and what made every POST
 * /applications/:id/packet-audit refuse. An empty store is the same case on a new environment. */
test('sends when the proof has expired outright, and when there is none at all', async () => {
  await withManagedProofEnv(async () => {
    const fingerprint = currentFingerprint();
    const expired = new MemoryStore([proofAged(MANAGED_RECEIVING_PROOF_MAX_AGE_MS + 60_000, fingerprint)]);

    for (const store of [expired, new MemoryStore()]) {
      const calls: SendCall[] = [];
      const outcome = await sendManagedReceivingCanary({ store, now: NOW, fetchImpl: okFetch(calls) });
      assert.deepEqual(outcome, { sent: true, reason: 'sent' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://api.resend.com/emails');
    }
  });
});

test('does not send while the proof is fresh', async () => {
  await withManagedProofEnv(async () => {
    const fingerprint = currentFingerprint();
    const calls: SendCall[] = [];
    const outcome = await sendManagedReceivingCanary({
      store: new MemoryStore([proofAged(60 * 60 * 1000, fingerprint)]),
      now: NOW,
      fetchImpl: okFetch(calls),
    });
    assert.deepEqual(outcome, { sent: false, reason: 'proof_is_fresh' });
    assert.equal(calls.length, 0);
  });
});

test('addresses the canary recipient and never returns it', async () => {
  await withManagedProofEnv(async () => {
    const calls: SendCall[] = [];
    const outcome = await sendManagedReceivingCanary({
      store: new MemoryStore(),
      now: NOW,
      fetchImpl: okFetch(calls),
    });

    assert.equal(calls[0].body.to, `litos-proof-${TOKEN.toLowerCase()}@${DOMAIN}`);
    assert.equal(calls[0].body.from, 'Litos <no-reply@trylitos.com>');

    // The recipient carries the canary token, so it must not leak through the outcome.
    assert.equal(JSON.stringify(outcome).includes(TOKEN.toLowerCase()), false);
  });
});

test('reports a refusal from Resend rather than claiming a send', async () => {
  await withManagedProofEnv(async () => {
    const outcome = await sendManagedReceivingCanary({
      store: new MemoryStore(),
      now: NOW,
      fetchImpl: (async () => new Response('nope', { status: 422 })) as unknown as typeof fetch,
    });
    assert.equal(outcome.sent, false);
    assert.equal(outcome.reason, 'send_failed');
    assert.match(String(outcome.detail), /422/);
  });
});

test('says not_configured when the route cannot produce a canary at all', async () => {
  await withManagedProofEnv(async () => {
    delete process.env.LITOS_RESEND_MANAGED_RECEIVING_CANARY_TOKEN;
    const calls: SendCall[] = [];
    const outcome = await sendManagedReceivingCanary({
      store: new MemoryStore(),
      now: NOW,
      fetchImpl: okFetch(calls),
    });
    assert.deepEqual(outcome, { sent: false, reason: 'not_configured' });
    assert.equal(calls.length, 0);
  });
});

test('says sender_not_configured rather than sending with no sender', async () => {
  await withManagedProofEnv(async () => {
    delete process.env.RESEND_FROM;
    const calls: SendCall[] = [];
    const outcome = await sendManagedReceivingCanary({
      store: new MemoryStore(),
      now: NOW,
      fetchImpl: okFetch(calls),
    });
    assert.deepEqual(outcome, { sent: false, reason: 'sender_not_configured' });
    assert.equal(calls.length, 0);
  });
});

/* A failed send must fail the cron invocation, not return 200 with sent:false.
 *
 * The whole failure mode being fixed is a delay between the cause and the symptom: the proof still
 * carries the route for the refresh lead, so a 200 here means Vercel's cron history reads healthy
 * for two days and the operator learns about it from a refused packet audit instead. */
test('a failed send answers with a failing status, and a missing route does not', () => {
  assert.equal(managedReceivingCanaryHttpStatus('send_failed'), 502);
  assert.equal(managedReceivingCanaryHttpStatus('sender_not_configured'), 503);
  assert.equal(managedReceivingCanaryHttpStatus('sent'), 200);
  assert.equal(managedReceivingCanaryHttpStatus('proof_is_fresh'), 200);
  assert.equal(managedReceivingCanaryHttpStatus('not_configured'), 200);
});
