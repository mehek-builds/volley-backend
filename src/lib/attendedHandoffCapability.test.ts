import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attendedHandoffCapabilitiesMatch,
  attendedHandoffCapabilityEvidenceCode,
  attendedHandoffCapabilityFromEvidenceCode,
  attendedHandoffDashboardBindingSha256,
  createAttendedHandoffCapability,
} from './attendedHandoffCapability';

const OWNER_ID = 'ec47a530-4810-490c-90a2-7a285cf4e3b6';
const APPLICATION_ID = '1d162e24-af05-4ea8-bbbd-47b11fc63d51';
const URL = 'https://apply.workable.com/example/j/CAPABILITY1/';
const DASHBOARD_BINDING = attendedHandoffDashboardBindingSha256({
  packet_version: 'packet-v1',
  dashboard_handoff: 'binding-v1',
});

function capability(kind: 'manual_handoff' | 'self_submit' = 'manual_handoff') {
  return createAttendedHandoffCapability({
    userId: OWNER_ID,
    applicationId: APPLICATION_ID,
    kind,
    canonicalUrl: URL,
    dashboardBindingSha256: DASHBOARD_BINDING,
  });
}

test('the attended capability is deterministic, typed, and contains no employer URL', () => {
  const first = capability();
  const second = capability();
  assert.deepEqual(first, second);
  assert.deepEqual(Object.keys(first).sort(), [
    'capability_sha256',
    'kind',
    'url_sha256',
    'version',
  ]);
  assert.match(first.capability_sha256, /^[a-f0-9]{64}$/);
  assert.match(first.url_sha256, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(first), /apply\.workable\.com/);
});

test('owner, application, route kind, URL, and dashboard binding each change capability identity', () => {
  const original = capability();
  const variants = [
    createAttendedHandoffCapability({
      userId: '27cc06a2-8da0-4975-b599-36035647054b', applicationId: APPLICATION_ID,
      kind: 'manual_handoff', canonicalUrl: URL, dashboardBindingSha256: DASHBOARD_BINDING,
    }),
    createAttendedHandoffCapability({
      userId: OWNER_ID, applicationId: '1b7f0bd8-54f2-4f30-848c-88028192fa50',
      kind: 'manual_handoff', canonicalUrl: URL, dashboardBindingSha256: DASHBOARD_BINDING,
    }),
    capability('self_submit'),
    createAttendedHandoffCapability({
      userId: OWNER_ID, applicationId: APPLICATION_ID, kind: 'manual_handoff',
      canonicalUrl: `${URL}?step=2`, dashboardBindingSha256: DASHBOARD_BINDING,
    }),
    createAttendedHandoffCapability({
      userId: OWNER_ID, applicationId: APPLICATION_ID, kind: 'manual_handoff',
      canonicalUrl: URL,
      dashboardBindingSha256: attendedHandoffDashboardBindingSha256({
        packet_version: 'packet-v2',
        dashboard_handoff: 'binding-v1',
      }),
    }),
  ];
  for (const variant of variants) {
    assert.notEqual(variant.capability_sha256, original.capability_sha256);
  }
  assert.notEqual(variants[3]!.url_sha256, original.url_sha256);
});

test('the immutable evidence representation round trips exact metadata and rejects malformed values', () => {
  const original = capability();
  const evidence = attendedHandoffCapabilityEvidenceCode(original);
  const restored = attendedHandoffCapabilityFromEvidenceCode(evidence);
  assert.deepEqual(restored, original);
  assert.equal(attendedHandoffCapabilitiesMatch(restored, original), true);
  for (const malformed of [
    null,
    '',
    `${evidence}:extra`,
    evidence.replace('manual_handoff', 'browser'),
    evidence.replace(original.url_sha256, '0'.repeat(63)),
  ]) {
    assert.equal(attendedHandoffCapabilityFromEvidenceCode(malformed), null);
  }
});

test('attended capability URLs fail closed on credentials, fragments, and non-HTTPS schemes', () => {
  const dashboardBindingSha256 = attendedHandoffDashboardBindingSha256({ packet_version: 'packet-v1' });
  for (const canonicalUrl of [
    'http://apply.workable.com/example/j/CAPABILITY1/',
    'https://user:secret@apply.workable.com/example/j/CAPABILITY1/',
    'https://apply.workable.com/example/j/CAPABILITY1/#submit',
  ]) {
    assert.throws(() => createAttendedHandoffCapability({
      userId: OWNER_ID,
      applicationId: APPLICATION_ID,
      kind: 'manual_handoff',
      canonicalUrl,
      dashboardBindingSha256,
    }));
  }
});
