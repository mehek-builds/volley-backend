import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import {
  inboundSecretMatches,
  resendProofSignatureMatches,
  signedResendCanaryEvent,
  svixSignatureMatches,
} from './applicationEmail';

test('inbound application email route scans all recipient fields', async () => {
  const route = await readFile('src/routes/applicationEmail.ts', 'utf8');
  assert.match(route, /function allRecipients/);
  for (const field of ['value.to', 'value.recipients', 'value.cc', 'value.envelope_to', 'value.delivered_to', 'value.recipient']) {
    assert.match(route, new RegExp(field.replace('.', '\\.')));
  }
  assert.doesNotMatch(route, /firstRecipient/);
});

test('inbound application email route avoids raw provider payload storage and static string comparison', async () => {
  const route = await readFile('src/routes/applicationEmail.ts', 'utf8');
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /X-Litos-Webhook-Timestamp/i);
  assert.match(route, /X-Litos-Webhook-Signature/i);
  assert.match(route, /svix-signature/);
  assert.match(route, /svixSecretBytes/);
  assert.match(route, /createHmac\('sha256'/);
  assert.match(route, /WEBHOOK_MAX_SKEW_MS/);
  assert.match(route, /rawJson:\s*\{/);
  assert.doesNotMatch(route, /rawJson:\s*parsed\.data/);
  assert.doesNotMatch(route, /provided === configured/);
});

test('inbound application email route can accept envelope-only recipient payloads', async () => {
  const route = await readFile('src/routes/applicationEmail.ts', 'utf8');
  assert.match(route, /to:[\s\S]{0,180}\.optional\(\)/);
  assert.match(route, /\.refine\(\(value\) => allRecipients\(value\)\.length > 0/);
});

test('managed canary proof accepts only a fresh valid Resend Svix signature', () => {
  const body = Buffer.from(JSON.stringify({
    type: 'email.received',
    data: { email_id: 'signed-id', to: ['hidden@managed.resend.app'] },
  }));
  const secretBytes = Buffer.from('test-webhook-signing-secret');
  const secret = `whsec_${secretBytes.toString('base64')}`;
  const id = 'msg_signature_id';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', secretBytes)
    .update(`${id}.${timestamp}.${body.toString('utf8')}`)
    .digest('base64');
  const request = {
    body,
    headers: {
      'svix-id': id,
      'svix-timestamp': timestamp,
      'svix-signature': `v1,${signature}`,
    },
  } as unknown as FastifyRequest;
  assert.equal(svixSignatureMatches(request, secret), true);
  assert.equal(svixSignatureMatches({
    ...request,
    headers: { ...request.headers, 'svix-signature': 'v1,invalid' },
  } as FastifyRequest, secret), false);
  assert.equal(svixSignatureMatches({
    ...request,
    headers: { ...request.headers, 'svix-timestamp': String(Math.floor(Date.now() / 1000) - 601) },
  } as FastifyRequest, secret), false);
  assert.equal(svixSignatureMatches({ body, headers: {} } as unknown as FastifyRequest, secret), false);
});

test('signed Resend canary parsing uses only the signed envelope and rejects other event shapes', () => {
  const event = signedResendCanaryEvent(Buffer.from(JSON.stringify({
    type: 'email.received',
    data: {
      email_id: 'received-id',
      to: ['Exact@Managed.Resend.App'],
      body: 'must never be needed for proof',
      headers: { authorization: 'must never be stored' },
    },
  })));
  assert.deepEqual(event, { emailId: 'received-id', recipients: ['Exact@Managed.Resend.App'] });
  assert.equal(signedResendCanaryEvent({ type: 'email.sent', data: { email_id: 'x', to: ['a@b.com'] } }), null);
  assert.equal(signedResendCanaryEvent(Buffer.from('not-json')), null);
});

test('managed proof trusts only RESEND_WEBHOOK_SECRET while compatibility auth remains unchanged', () => {
  const names = [
    'RESEND_WEBHOOK_SECRET',
    'LITOS_INBOUND_EMAIL_WEBHOOK_SECRET',
    'LITOS_APPLICATION_EMAIL_WEBHOOK_SECRET',
  ] as const;
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const body = Buffer.from(JSON.stringify({
    type: 'email.received',
    data: { email_id: 'isolated-proof-id', to: ['hidden@managed.resend.app'] },
  }));
  const id = 'msg_trust_isolation';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const svixRequest = (signingBytes: Buffer) => {
    const signature = createHmac('sha256', signingBytes)
      .update(`${id}.${timestamp}.${body.toString('utf8')}`)
      .digest('base64');
    return {
      body,
      headers: {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${signature}`,
      },
    } as unknown as FastifyRequest;
  };
  try {
    for (const name of names) delete process.env[name];
    const legacy = 'legacy-compatibility-secret';
    process.env.LITOS_INBOUND_EMAIL_WEBHOOK_SECRET = legacy;

    // A valid Svix-shaped signature made with the legacy secret can still authenticate through
    // the compatibility chain, but it must never reach the managed proof trust boundary.
    const legacySvixRequest = svixRequest(Buffer.from(legacy, 'base64'));
    assert.equal(inboundSecretMatches(legacySvixRequest), true);
    assert.equal(resendProofSignatureMatches(legacySvixRequest), false);

    process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from('different-resend-secret').toString('base64')}`;
    // Existing compatibility auth gives the configured Resend secret precedence, so a wrong
    // nonempty Resend secret also fails ordinary auth rather than falling through silently.
    assert.equal(inboundSecretMatches(legacySvixRequest), false);
    assert.equal(resendProofSignatureMatches(legacySvixRequest), false);

    const resendBytes = 'exact-resend-secret';
    process.env.RESEND_WEBHOOK_SECRET = `whsec_${Buffer.from(resendBytes).toString('base64')}`;
    assert.equal(resendProofSignatureMatches(svixRequest(Buffer.from(resendBytes))), true);

    // The original X-Litos compatibility HMAC remains accepted for ordinary inbound routing.
    delete process.env.RESEND_WEBHOOK_SECRET;
    const legacyTimestamp = String(Date.now());
    const legacySignature = createHmac('sha256', legacy)
      .update(`${legacyTimestamp}.${body.toString('utf8')}`)
      .digest('hex');
    const compatibilityRequest = {
      body,
      headers: {
        'x-litos-webhook-timestamp': legacyTimestamp,
        'x-litos-webhook-signature': legacySignature,
      },
    } as unknown as FastifyRequest;
    assert.equal(inboundSecretMatches(compatibilityRequest), true);
    assert.equal(resendProofSignatureMatches(compatibilityRequest), false);
  } finally {
    for (const name of names) {
      const value = saved[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
