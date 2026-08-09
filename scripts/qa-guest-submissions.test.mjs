import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
import {
  assertControlledSecurityCodeTarget,
  managedApplicationAlias,
  securityCodeCase,
  securityCodeMailboxUrl,
  securityCodePortalUrl,
  signedInboundRequest,
} from './qa-guest-submissions-lib.mjs';

test('security-code E2E refuses production targets and unconfirmed databases', () => {
  assert.throws(() => assertControlledSecurityCodeTarget({
    apiBase: 'https://student-outreach-backend.vercel.app',
    websiteBase: 'http://localhost:3300',
    portalPublicBase: 'http://localhost:3300',
    databaseConfirmed: true,
    publicPortalConfirmed: false,
  }), /only runs against a local API and website/);
  assert.throws(() => assertControlledSecurityCodeTarget({
    apiBase: 'http://localhost:3301',
    websiteBase: 'http://localhost:3300',
    portalPublicBase: 'http://localhost:3300',
    databaseConfirmed: false,
    publicPortalConfirmed: false,
  }), /QA_CONTROLLED_DATABASE=1/);
  assert.doesNotThrow(() => assertControlledSecurityCodeTarget({
    apiBase: 'http://127.0.0.1:3301',
    websiteBase: 'http://localhost:3300',
    portalPublicBase: 'https://controlled-portal.example.test',
    databaseConfirmed: true,
    publicPortalConfirmed: true,
  }));
  assert.throws(() => assertControlledSecurityCodeTarget({
    apiBase: 'http://127.0.0.1:3301',
    websiteBase: 'http://localhost:3300',
    portalPublicBase: 'https://controlled-portal.example.test',
    databaseConfirmed: true,
    publicPortalConfirmed: false,
  }), /QA_CONTROLLED_PORTAL_PUBLIC=1/);
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
