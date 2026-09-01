/* THE APPROVAL SHE GAVE BEFORE LITOS LOOKED AT THE FORM CARRIES ONTO WHAT LITOS LEARNED, and onto
 * nothing else. Measured 2026-09-01 on TixTrack and Cartesia: the acknowledged audit was built with
 * both capability facts unknown, discovery learned them, and the only way on was a second identical
 * approve. These drive the real decision function over real audits. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPacketAudit, packetAuditIsSubmissionReady, type PacketAudit } from './packetAudit';
import { relearnedCapabilitiesAcknowledgement } from './packetResumeRestore';
import {
  createEmployerDeliveryBindings,
  employerDeliveryEnvelope,
  type EmployerDeliveryEnvelope,
  type EmployerPacketDeliveryMode,
} from './employerDeliveryIdentity';
import type { SubmissionPacket } from './portalSubmission';

const RESUME = Buffer.from('%PDF-1.7\nthe exact packet she approved');
const JD = 'Build reliable systems for people who ship.';
const PACKET: SubmissionPacket = {
  fullName: 'Mehek Mandal',
  email: 'app-tixtrack@apply.trylitos.com',
  jdText: JD,
  resume: RESUME,
  resumeName: 'resume.pdf',
  questions: [],
};

function envelopeWith(caps: { coverLetterSupported?: boolean; transcriptSupported?: boolean }): EmployerDeliveryEnvelope {
  return employerDeliveryEnvelope({
    channel: 'browser:stratus-managed',
    destinationUrl: 'https://tixtrack.teamtailor.com/jobs/8287889/applications/new',
    portalFamily: 'teamtailor',
    ...caps,
  });
}

function auditFor(input: {
  envelope: EmployerDeliveryEnvelope;
  mode?: EmployerPacketDeliveryMode;
  jdText?: string;
  resume?: Buffer;
}): PacketAudit {
  const packet = { ...PACKET, jdText: input.jdText ?? JD, resume: input.resume ?? RESUME };
  return createPacketAudit({
    ownerId: 'owner-1',
    applicationId: 'application-1',
    jdText: packet.jdText ?? '',
    spec: { target_role: 'Engineer' },
    jobContext: { company: 'TixTrack', role: 'Engineer' },
    questions: [],
    applicantSnapshot: null,
    resumeEmail: 'student@example.com',
    applicantEmail: packet.email,
    employerDelivery: createEmployerDeliveryBindings(packet, {}, { mode: input.mode ?? 'browser', envelope: input.envelope }),
    pdfObjectKey: 'users/owner-1/resumes/application-1.pdf',
    pdfBytes: packet.resume,
    editedTerms: [],
    clauses: [{ text: packet.jdText ?? '', start: 0, end: (packet.jdText ?? '').length, verdict: 'unscoreable' }],
    rejected: [],
    degraded: false,
    terms: { covered: [], missing: [], edited: [] },
  });
}

const acknowledgementOf = (audit: PacketAudit) => ({
  ownerSha256: audit.bindings.ownerSha256,
  applicationId: audit.bindings.applicationId,
  audit_digest: audit.audit_digest,
  packet_version: audit.packet_version,
  pdfSha256: audit.bindings.pdf.sha256,
  pdfSizeBytes: audit.bindings.pdf.sizeBytes,
  acknowledged_at: '2026-09-01T22:00:00.000Z',
  source: 'applicant' as const,
});

const BEFORE_THE_PROBE = envelopeWith({});
const AFTER_THE_PROBE = envelopeWith({ coverLetterSupported: false, transcriptSupported: false });
const AT = '2026-09-01T22:18:32.000Z';

test('the fixtures are submission-ready audits whose delivery hashes differ only by the probe', () => {
  const prior = auditFor({ envelope: BEFORE_THE_PROBE });
  const reissued = auditFor({ envelope: AFTER_THE_PROBE });
  assert.equal(packetAuditIsSubmissionReady(prior), true);
  assert.equal(packetAuditIsSubmissionReady(reissued), true);
  assert.notEqual(prior.bindings.employerDelivery?.sha256, reissued.bindings.employerDelivery?.sha256);
  assert.notEqual(prior.audit_digest, reissued.audit_digest);
});

test('her approval carries onto the audit re-issued with the measured capabilities', () => {
  const prior = auditFor({ envelope: BEFORE_THE_PROBE });
  const reissued = auditFor({ envelope: AFTER_THE_PROBE });
  const carried = relearnedCapabilitiesAcknowledgement({
    priorAudit: prior,
    priorAcknowledgement: acknowledgementOf(prior),
    reissuedAudit: reissued,
    acknowledgedAt: AT,
  });
  assert.deepEqual(carried, {
    ...acknowledgementOf(reissued),
    acknowledged_at: AT,
    source: 'capabilities_measured',
  });
});

test('nothing is invented: no prior approval, or a stale one, carries nothing', () => {
  const prior = auditFor({ envelope: BEFORE_THE_PROBE });
  const reissued = auditFor({ envelope: AFTER_THE_PROBE });
  assert.equal(relearnedCapabilitiesAcknowledgement({
    priorAudit: prior, priorAcknowledgement: undefined, reissuedAudit: reissued, acknowledgedAt: AT,
  }), null);
  assert.equal(relearnedCapabilitiesAcknowledgement({
    priorAudit: undefined, priorAcknowledgement: acknowledgementOf(prior), reissuedAudit: reissued, acknowledgedAt: AT,
  }), null);
  // An acknowledgement of some OTHER audit is not approval of this packet.
  const other = auditFor({ envelope: BEFORE_THE_PROBE, jdText: 'A different posting entirely.' });
  assert.equal(relearnedCapabilitiesAcknowledgement({
    priorAudit: prior, priorAcknowledgement: acknowledgementOf(other), reissuedAudit: reissued, acknowledgedAt: AT,
  }), null);
});

test('anything she looked at moving refuses the carry: the posting, the file, the channel', () => {
  const prior = auditFor({ envelope: BEFORE_THE_PROBE });
  const acknowledgement = acknowledgementOf(prior);
  assert.equal(relearnedCapabilitiesAcknowledgement({
    priorAudit: prior,
    priorAcknowledgement: acknowledgement,
    reissuedAudit: auditFor({ envelope: AFTER_THE_PROBE, jdText: 'The posting was edited after she approved.' }),
    acknowledgedAt: AT,
  }), null, 'job description');
  assert.equal(relearnedCapabilitiesAcknowledgement({
    priorAudit: prior,
    priorAcknowledgement: acknowledgement,
    reissuedAudit: auditFor({ envelope: AFTER_THE_PROBE, resume: Buffer.from('%PDF-1.7\nrendered again') }),
    acknowledgedAt: AT,
  }), null, 'resume bytes');
  assert.equal(relearnedCapabilitiesAcknowledgement({
    priorAudit: prior,
    priorAcknowledgement: acknowledgement,
    reissuedAudit: auditFor({ envelope: AFTER_THE_PROBE, mode: 'full' }),
    acknowledgedAt: AT,
  }), null, 'delivery mode');
});
