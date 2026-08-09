import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import {
  assertDisposableDatabaseMarker,
  assertControlledManagedReceivingProofRow,
  assertRemoteManagedRunner,
  assertControlledSecurityCodeTarget,
  controlledEmailCaptureTarget,
  controlledDatabaseTarget,
  controlledManagedReceivingProof,
  controlledQaPacketSpec,
  controlledPortalBinding,
  managedApplicationAlias,
  securityCodeCase,
  securityCodeMailboxUrl,
  securityCodePortalUrl,
  signedInboundRequest,
} from './qa-guest-submissions-lib.mjs';
import { applicationLeadAlignmentIssues } from '../src/routes/applications.ts';

const marker = 'controlled_database_marker_123456';
const controlledTarget = {
  apiBase: 'http://127.0.0.1:3301',
  websiteBase: 'http://localhost:3300',
  portalPublicBase: 'https://qa-tunnel.example.test',
  databaseConfirmed: true,
  publicPortalConfirmed: true,
  databaseUrl: 'postgresql://qa:secret@127.0.0.1:5432/litos_qa_security_code',
  databaseMarker: marker,
  portalBindingSecret: '0123456789abcdef0123456789abcdef',
  configuredPortalOrigin: 'https://qa-tunnel.example.test',
};

test('security-code E2E refuses production targets and unconfirmed databases', () => {
  assert.throws(() => assertControlledSecurityCodeTarget({
    ...controlledTarget,
    apiBase: 'https://student-outreach-backend.vercel.app',
  }), /only runs against a local API and website/);
  assert.throws(() => assertControlledSecurityCodeTarget({
    ...controlledTarget,
    databaseConfirmed: false,
  }), /QA_CONTROLLED_DATABASE=1/);
  assert.doesNotThrow(() => assertControlledSecurityCodeTarget(controlledTarget));
  assert.throws(() => assertControlledSecurityCodeTarget({
    ...controlledTarget,
    publicPortalConfirmed: false,
  }), /confirmation/);
  assert.throws(() => assertControlledSecurityCodeTarget({
    ...controlledTarget,
    configuredPortalOrigin: 'https://different.example.test',
  }), /must match LITOS_TEST_PORTAL_PUBLIC_ORIGIN/);
  for (const productionOrigin of [
    'https://trylitos.com',
    'https://www.trylitos.com',
    'https://trylitos.com:444',
    'https://www.trylitos.com:444',
  ]) {
    assert.throws(() => assertControlledSecurityCodeTarget({
      ...controlledTarget,
      portalPublicBase: productionOrigin,
      configuredPortalOrigin: productionOrigin,
    }), /Known production Litos origins/);
  }
});

test('controlled email forwarding uses only an authenticated loopback capture adapter', () => {
  assert.equal(
    controlledEmailCaptureTarget('http://127.0.0.1:4317/emails', '0123456789abcdef0123456789abcdef').origin,
    'http://127.0.0.1:4317',
  );
  assert.throws(
    () => controlledEmailCaptureTarget('https://capture.example.test/emails', '0123456789abcdef0123456789abcdef'),
    /must be http:\/\/127\.0\.0\.1/,
  );
  assert.throws(
    () => controlledEmailCaptureTarget('http://127.0.0.1:4317/emails', ''),
    /Provisioning blocker/,
  );
});

test('database safety rejects remote, shared, and unmarked targets', () => {
  assert.deepEqual(controlledDatabaseTarget(controlledTarget.databaseUrl), {
    host: '127.0.0.1',
    port: '5432',
    database: 'litos_qa_security_code',
  });
  assert.throws(
    () => controlledDatabaseTarget('postgresql://qa:secret@prod.db.example/litos_qa_security_code'),
    /loopback PostgreSQL/,
  );
  assert.throws(
    () => controlledDatabaseTarget('postgresql://qa:secret@localhost/postgres'),
    /must start with litos_qa_/,
  );
  const now = new Date('2026-08-09T12:00:00.000Z');
  assert.doesNotThrow(() => assertDisposableDatabaseMarker({
    marker,
    expires_at: new Date('2026-08-09T13:00:00.000Z'),
  }, marker, now));
  assert.throws(() => assertDisposableDatabaseMarker({
    marker: 'another_controlled_marker_1234',
    expires_at: new Date('2026-08-09T13:00:00.000Z'),
  }, marker, now), /missing or does not match/);
  assert.throws(() => assertDisposableDatabaseMarker({
    marker,
    expires_at: new Date('2026-08-10T13:00:00.000Z'),
  }, marker, now), /within the next 24 hours/);
});

test('controlled managed receiving proof is fully bound to the disposable QA configuration', () => {
  const input = {
    routeMode: 'managed_resend',
    domain: 'litos-qa.resend.app',
    aliasSecret: 'controlled-alias-secret',
    canaryToken: '0123456789abcdef0123456789abcdef',
    webhookEndpoint: 'https://backend.example.test/webhooks/application-email/inbound',
    webhookSecret: 'whsec_controlled_test',
    databaseMarker: marker,
  };
  const proof = controlledManagedReceivingProof(input);
  assert.match(proof.route_fingerprint, /^[a-f0-9]{64}$/);
  assert.match(proof.provider_message_hash, /^[a-f0-9]{64}$/);
  assert.equal(proof.proof_version, 2);
  assert.equal(proof.domain, input.domain);
  assert.notEqual(
    proof.route_fingerprint,
    controlledManagedReceivingProof({ ...input, aliasSecret: 'rotated-controlled-alias-secret' }).route_fingerprint,
  );
  assert.notEqual(
    proof.provider_message_hash,
    controlledManagedReceivingProof({ ...input, databaseMarker: 'rotated_database_marker_1234' }).provider_message_hash,
  );
  assert.throws(() => controlledManagedReceivingProof({
    ...input,
    webhookEndpoint: 'http://localhost:3301/webhooks/application-email/inbound',
  }), /endpoint is invalid/);
});

test('security-code proof must exist before backend startup and match the exact fixture binding', () => {
  const expected = {
    provider_message_hash: 'a'.repeat(64),
    route_fingerprint: 'b'.repeat(64),
    proof_version: 2,
    domain: 'litos-qa.resend.app',
  };
  const now = new Date('2026-08-09T12:00:00.000Z');
  const valid = { ...expected, verified_at: now };
  assert.doesNotThrow(() => assertControlledManagedReceivingProofRow(valid, expected, now));
  assert.throws(
    () => assertControlledManagedReceivingProofRow(undefined, expected, now),
    /seeded before backend startup/,
  );
  assert.throws(
    () => assertControlledManagedReceivingProofRow({ ...valid, provider_message_hash: 'c'.repeat(64) }, expected, now),
    /seeded before backend startup/,
  );
  assert.throws(
    () => assertControlledManagedReceivingProofRow({
      ...valid,
      verified_at: new Date('2026-08-01T11:59:59.000Z'),
    }, expected, now),
    /not current/,
  );
});

test('the seeded QA packet carries exact evidence-bound lead alignment', () => {
  const spec = controlledQaPacketSpec({
    run: 1,
    email: 'guest@litos-qa.resend.app',
    portalUrl: 'http://localhost:3300/qa/portal-submission',
    alias: null,
    forwardTo: null,
    now: '2026-08-09T12:00:00.000Z',
  });
  assert.deepEqual(applicationLeadAlignmentIssues(spec), []);

  const missing = structuredClone(spec);
  delete missing.lead_alignment;
  assert.match(applicationLeadAlignmentIssues(missing)[0], /lead_alignment is missing/);

  const wrongHash = structuredClone(spec);
  wrongHash.lead_alignment.jd_hash = '0000000000000000';
  assert.match(applicationLeadAlignmentIssues(wrongHash)[0], /jd_hash does not match/);

  const wrongEvidence = structuredClone(spec);
  wrongEvidence.lead_alignment.evidence = 'Built a different workflow not present in the packet.';
  assert.match(applicationLeadAlignmentIssues(wrongEvidence)[0], /evidence is not one of the bullets/);
});

test('security-code mode requires the remote managed runner and records its auth mode', () => {
  const base = {
    provider: 'stratus-managed',
    baseUrl: 'https://stratus-browser-cloud.vercel.app',
    expectedOrigin: 'https://stratus-browser-cloud.vercel.app',
    credentialScope: 'dedicated-nonproduction',
  };
  assert.deepEqual(assertRemoteManagedRunner({ ...base, apiKey: 'qa-key' }), {
    origin: 'https://stratus-browser-cloud.vercel.app',
    authMode: 'api_key',
  });
  assert.deepEqual(assertRemoteManagedRunner({
    ...base,
    oidcToken: 'header.payload.signature',
  }), {
    origin: 'https://stratus-browser-cloud.vercel.app',
    authMode: 'vercel_oidc',
  });
  assert.throws(() => assertRemoteManagedRunner({ ...base, provider: 'stratus', apiKey: 'qa-key' }), /stratus-managed/);
  assert.throws(() => assertRemoteManagedRunner({
    ...base,
    credentialScope: undefined,
    oidcToken: 'header.payload.signature',
  }), /Provisioning blocker/);
  assert.throws(() => assertRemoteManagedRunner({
    ...base,
    baseUrl: 'http://localhost:3302',
    apiKey: 'qa-key',
  }), /HTTPS, non-loopback/);
  assert.throws(() => assertRemoteManagedRunner({
    ...base,
    expectedOrigin: 'https://different-runner.example',
    apiKey: 'qa-key',
  }), /match QA_EXPECTED_STRATUS_ORIGIN/);
  assert.throws(() => assertRemoteManagedRunner({
    ...base,
    baseUrl: 'https://stratus-browser-cloud.vercel.app/unscoped',
    apiKey: 'qa-key',
  }), /match QA_EXPECTED_STRATUS_ORIGIN/);
});

test('managed alias matches the production deterministic packet shape', () => {
  const alias = managedApplicationAlias({
    aliasSecret: 'qa-secret',
    domain: 'inbound.resend.app',
    userId: '11111111-1111-4111-8111-111111111111',
    applicationId: '22222222-2222-4222-8222-222222222222',
  });
  assert.match(alias, /^app-2222222222-[a-f0-9]{12}@inbound\.resend\.app$/);
});

test('signed inbound request signs the exact body sent to the webhook', () => {
  const timestamp = 1_786_223_456_789;
  const payload = { to: ['app@example.test'], text: 'security code ABC12345' };
  const request = signedInboundRequest(payload, 'webhook-secret', timestamp);
  assert.equal(request.headers['X-Litos-Webhook-Timestamp'], String(timestamp));
  assert.equal(
    request.headers['X-Litos-Webhook-Signature'],
    createHmac('sha256', 'webhook-secret').update(`${timestamp}.${request.body}`).digest('hex'),
  );
  assert.deepEqual(JSON.parse(request.body), payload);
});

test('each application attempt gets a distinct controlled portal and mailbox case', () => {
  const first = securityCodeCase('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 1);
  const second = securityCodeCase('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 2);
  assert.notEqual(first, second);
  const portal = new URL(securityCodePortalUrl('http://localhost:3300', first));
  assert.equal(portal.searchParams.get('shape'), 'security-code');
  assert.equal(portal.searchParams.get('case'), first);
  assert.equal(new URL(securityCodeMailboxUrl('http://localhost:3300', first)).searchParams.get('case'), first);
});

test('a public portal URL carries the exact backend-verifiable binding', () => {
  const previous = process.env.LITOS_TEST_PORTAL_BINDING_SECRET;
  process.env.LITOS_TEST_PORTAL_BINDING_SECRET = controlledTarget.portalBindingSecret;
  try {
    const portal = new URL(securityCodePortalUrl(controlledTarget.portalPublicBase, 'run-1'));
    const supplied = portal.searchParams.get('litos_qa_binding');
    assert.equal(supplied, controlledPortalBinding(portal.toString(), controlledTarget.portalBindingSecret));
    assert.equal(supplied, '886de6f6c7bfe467f993a20fffae9302d1c13ef1ee7f75add9a40119991973fc');
    portal.searchParams.set('case', 'run-2');
    assert.notEqual(
      supplied,
      controlledPortalBinding(portal.toString(), controlledTarget.portalBindingSecret),
    );
  } finally {
    if (previous === undefined) delete process.env.LITOS_TEST_PORTAL_BINDING_SECRET;
    else process.env.LITOS_TEST_PORTAL_BINDING_SECRET = previous;
  }
});
