import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applicantEmailNotice,
  applicantEmailRouteIsConfigured,
  planPacketApplicantEmail,
  type PacketApplicantEmailDeps,
} from './packetApplicantEmail';
import type { AliasDeliverability, AliasDeliverabilityReason } from './applicationEmailDeliverability';

const USER = '11111111-1111-4111-8111-111111111111';
const PACKET = '22222222-2222-4222-8222-222222222222';
const ALIAS = 'app-2222222222-abcdef012345@apply.litos.test';

function deliverability(reason: AliasDeliverabilityReason, deliverable: boolean): AliasDeliverability {
  return {
    deliverable,
    domain: 'apply.litos.test',
    reason,
    mx_hosts: [],
    mx_provider: 'resend',
    mx_provider_agrees: deliverable,
    resend_domain_status: 'verified',
    resend_receiving_status: 'enabled',
    inbound_route_configured: deliverable,
    checked_at: new Date().toISOString(),
  };
}

function deps(overrides: PacketApplicantEmailDeps = {}): PacketApplicantEmailDeps {
  return {
    deliverability: async () => deliverability('deliverable', true),
    forwardingAddress: async () => 'student@example.com',
    aliasFor: () => ALIAS,
    ...overrides,
  };
}

/* THE WHOLE POINT. A packet generated before its apply URL is known is an application whose link
 * has not been found yet, not a document that will never be submitted. It gets an alias. */
test('a packet with no portal link still gets a tracked alias', async () => {
  const plan = await planPacketApplicantEmail({
    userId: USER,
    applicationId: PACKET,
    contactEmail: 'student@example.com',
    accountEmail: 'student@example.com',
    contactFromRequest: true,
  }, deps());
  assert.equal(plan.identity?.alias, ALIAS);
  assert.equal(plan.identity?.forwards_to, 'student@example.com');
  assert.equal(plan.choice?.address, ALIAS);
  assert.equal(plan.choice?.source, 'litos_alias');
  assert.equal(plan.choice?.tracked, true);
  assert.equal(plan.choice?.reason, 'deliverable');
  assert.equal(plan.notice, null);
});

test('an unconfigured inbound route falls back to the real address and says why', async () => {
  const plan = await planPacketApplicantEmail({
    userId: USER,
    applicationId: PACKET,
    contactEmail: 'Student@Example.com',
    contactFromRequest: true,
  }, deps({ deliverability: async () => deliverability('inbound_disabled', false) }));
  assert.equal(plan.identity, null);
  assert.equal(plan.choice?.tracked, false);
  assert.equal(plan.choice?.reason, 'inbound_disabled');
  assert.equal(plan.choice?.source, 'contact_email');
  assert.equal(plan.choice?.address, 'Student@Example.com');
  assert.match(plan.notice ?? '', /inbound_disabled/);
  assert.match(plan.notice ?? '', /Student@Example\.com/);
});

/* A guest, or anyone who has not confirmed where employer mail should go, must still be able to
 * generate a resume. Refusing here would break every unconfigured account. */
test('no forwarding address is a recorded fallback, never a thrown error', async () => {
  const plan = await planPacketApplicantEmail({
    userId: USER,
    applicationId: PACKET,
    contactEmail: 'student@example.com',
    contactFromRequest: false,
  }, deps({ forwardingAddress: async () => null }));
  assert.equal(plan.identity, null);
  assert.equal(plan.choice?.reason, 'no_forwarding_address');
  assert.equal(plan.choice?.source, 'account_email');
  assert.equal(plan.choice?.tracked, false);
  assert.match(plan.notice ?? '', /no confirmed address/i);
});

test('a forwarding lookup that throws is a fallback, not a failed generation', async () => {
  const plan = await planPacketApplicantEmail({
    userId: USER,
    applicationId: PACKET,
    contactEmail: 'student@example.com',
    contactFromRequest: true,
  }, deps({ forwardingAddress: async () => { throw new Error('column does not exist'); } }));
  assert.equal(plan.choice?.reason, 'no_forwarding_address');
  assert.equal(plan.choice?.tracked, false);
});

/* Route mode unset: no mailbox and no domain, so applicationAliasFor cannot derive an address at
 * all. That is a configuration state, so it falls back with a reason rather than failing. */
test('an unset route mode falls back with alias_not_configured', async () => {
  const plan = await planPacketApplicantEmail({
    userId: USER,
    applicationId: PACKET,
    contactEmail: 'student@example.com',
    contactFromRequest: true,
  }, deps({ aliasFor: () => null }));
  assert.equal(plan.identity, null);
  assert.equal(plan.choice?.reason, 'alias_not_configured');
  assert.equal(plan.choice?.tracked, false);
  assert.match(plan.notice ?? '', /not switched on/i);
});

test('a deliverability probe that throws lands on check_unavailable, not on an exception', async () => {
  const plan = await planPacketApplicantEmail({
    userId: USER,
    applicationId: PACKET,
    contactEmail: 'student@example.com',
    contactFromRequest: true,
  }, deps({ deliverability: async () => { throw new Error('dns timeout'); } }));
  assert.equal(plan.choice?.reason, 'check_unavailable');
  assert.equal(plan.choice?.tracked, false);
});

test('a packet with no email at all decides nothing', async () => {
  const plan = await planPacketApplicantEmail({
    userId: USER,
    applicationId: PACKET,
    contactEmail: '   ',
    contactFromRequest: false,
  }, deps());
  assert.deepEqual(plan, { identity: null, choice: null, notice: null });
});

/* Every untracked packet carries a reason AND a sentence. A fallback with neither is the defect
 * this module exists to remove. */
test('no untracked decision is ever produced without a reason and a notice', async () => {
  const reasons: AliasDeliverabilityReason[] = [
    'alias_not_configured',
    'inbound_disabled',
    'no_mx_record',
    'mx_provider_mismatch',
    'domain_not_verified_in_resend',
    'receiving_not_enabled_in_resend',
    'managed_receiving_proof_missing',
    'managed_receiving_proof_mismatch',
    'inbound_route_missing',
    'forwarding_not_configured',
    'check_unavailable',
  ];
  for (const reason of reasons) {
    const plan = await planPacketApplicantEmail({
      userId: USER,
      applicationId: PACKET,
      contactEmail: 'student@example.com',
      contactFromRequest: true,
    }, deps({ deliverability: async () => deliverability(reason, false) }));
    assert.equal(plan.choice?.tracked, false, reason);
    assert.equal(plan.choice?.reason, reason);
    assert.ok((plan.notice ?? '').includes(reason), `notice for ${reason} must name the reason`);
    assert.ok((plan.notice ?? '').includes('student@example.com'), `notice for ${reason} must name the address`);
  }
});

test('a tracked decision carries no notice, so a caller can render it unconditionally', () => {
  assert.equal(applicantEmailNotice({
    address: ALIAS,
    source: 'litos_alias',
    reason: 'deliverable',
    tracked: true,
    decided_at: new Date().toISOString(),
  }), null);
});

/* The distinction that decides whether a missing alias is an error worth failing a generation
 * over. Configuration states are ordinary. Everything else means the route was working and the
 * write did not. */
test('configuration states are told apart from a configured route that failed', () => {
  assert.equal(applicantEmailRouteIsConfigured('alias_not_configured'), false);
  assert.equal(applicantEmailRouteIsConfigured('inbound_disabled'), false);
  assert.equal(applicantEmailRouteIsConfigured('inbound_route_missing'), false);
  assert.equal(applicantEmailRouteIsConfigured('forwarding_not_configured'), false);
  assert.equal(applicantEmailRouteIsConfigured('no_forwarding_address'), false);
  assert.equal(applicantEmailRouteIsConfigured('alias_write_failed'), true);
  assert.equal(applicantEmailRouteIsConfigured('no_mx_record'), true);
  assert.equal(applicantEmailRouteIsConfigured('check_unavailable'), true);
});

/* The alias is a pure function of (user, packet), so a repeat generation for the same packet id
 * asks for the same address. The database half of this, that a repeat writes no second row, is
 * proved against a real Postgres in e2e/packet-alias.e2e.mts. */
test('a repeat decision for the same packet asks for the same alias', async () => {
  const once = await planPacketApplicantEmail({
    userId: USER, applicationId: PACKET, contactEmail: 'student@example.com', contactFromRequest: true,
  }, deps());
  const twice = await planPacketApplicantEmail({
    userId: USER, applicationId: PACKET, contactEmail: 'student@example.com', contactFromRequest: true,
  }, deps());
  assert.equal(once.identity?.alias, twice.identity?.alias);
});
