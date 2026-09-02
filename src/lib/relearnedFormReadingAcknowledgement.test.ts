/* THE APPROVAL SHE GAVE BEFORE LITOS LOOKED AT THE FORM CARRIES ONTO WHAT LITOS LEARNED, and onto
 * nothing else. Measured 2026-09-01 on TixTrack and Cartesia: the acknowledged audit was built with
 * both capability facts unknown, discovery learned them, and the only way on was a second identical
 * approve. These drive the real decision function over real audits. */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ApplicationReviewQuestion } from './applicationReview';
import { createPacketAudit, packetAuditIsSubmissionReady, type PacketAudit } from './packetAudit';
import { relearnedFormReadingAcknowledgement } from './packetResumeRestore';
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
  const carried = relearnedFormReadingAcknowledgement({
    priorAudit: prior,
    priorAcknowledgement: acknowledgementOf(prior),
    reissuedAudit: reissued,
    acknowledgedAt: AT,
  });
  assert.deepEqual(carried, {
    ...acknowledgementOf(reissued),
    acknowledged_at: AT,
    source: 'form_reading_measured',
  });
});

test('nothing is invented: no prior approval, or a stale one, carries nothing', () => {
  const prior = auditFor({ envelope: BEFORE_THE_PROBE });
  const reissued = auditFor({ envelope: AFTER_THE_PROBE });
  assert.equal(relearnedFormReadingAcknowledgement({
    priorAudit: prior, priorAcknowledgement: undefined, reissuedAudit: reissued, acknowledgedAt: AT,
  }), null);
  assert.equal(relearnedFormReadingAcknowledgement({
    priorAudit: undefined, priorAcknowledgement: acknowledgementOf(prior), reissuedAudit: reissued, acknowledgedAt: AT,
  }), null);
  // An acknowledgement of some OTHER audit is not approval of this packet.
  const other = auditFor({ envelope: BEFORE_THE_PROBE, jdText: 'A different posting entirely.' });
  assert.equal(relearnedFormReadingAcknowledgement({
    priorAudit: prior, priorAcknowledgement: acknowledgementOf(other), reissuedAudit: reissued, acknowledgedAt: AT,
  }), null);
});

test('anything she looked at moving refuses the carry: the posting, the file, the channel', () => {
  const prior = auditFor({ envelope: BEFORE_THE_PROBE });
  const acknowledgement = acknowledgementOf(prior);
  assert.equal(relearnedFormReadingAcknowledgement({
    priorAudit: prior,
    priorAcknowledgement: acknowledgement,
    reissuedAudit: auditFor({ envelope: AFTER_THE_PROBE, jdText: 'The posting was edited after she approved.' }),
    acknowledgedAt: AT,
  }), null, 'job description');
  assert.equal(relearnedFormReadingAcknowledgement({
    priorAudit: prior,
    priorAcknowledgement: acknowledgement,
    reissuedAudit: auditFor({ envelope: AFTER_THE_PROBE, resume: Buffer.from('%PDF-1.7\nrendered again') }),
    acknowledgedAt: AT,
  }), null, 'resume bytes');
  assert.equal(relearnedFormReadingAcknowledgement({
    priorAudit: prior,
    priorAcknowledgement: acknowledgement,
    reissuedAudit: auditFor({ envelope: AFTER_THE_PROBE, mode: 'full' }),
    acknowledgedAt: AT,
  }), null, 'delivery mode');
});

/* ---- the four proofs that keep a LEARNED row from becoming APPROVED content ---------------
 *
 * Widening the carry to cover the rows a discovery pass learned puts a new question set inside the
 * re-issued audit, so the identity comparison can no longer be the whole audit's questions binding.
 * It becomes a RESTRICTION of it: the hash of the reissued set's opening prefix, which must be the
 * rows the approval covered, byte for byte. These drive that restriction directly, because a caller
 * that got any of it wrong would mint a human approval out of a record that never matched.
 */
const APPROVED_ROWS: ApplicationReviewQuestion[] = [
  {
    id: 'q-1',
    question: 'Are you legally authorized to work in the United States?',
    answer: 'Yes',
    kind: 'required',
    required: true,
    answer_source: 'applicant_review',
    answer_reviewed_at: '2026-09-01T20:11:00.000Z',
  },
];
const LEARNED_ROW: ApplicationReviewQuestion = {
  id: '245',
  question: 'What is your gender?',
  answer: '',
  kind: 'required',
  required: true,
  portal_input_type: 'combobox',
};

function auditOver(questions: readonly ApplicationReviewQuestion[], envelope: EmployerDeliveryEnvelope): PacketAudit {
  const packet = { ...PACKET, questions: [] };
  return createPacketAudit({
    ownerId: 'owner-1',
    applicationId: 'application-1',
    jdText: JD,
    spec: { target_role: 'Engineer' },
    jobContext: { company: 'TixTrack', role: 'Engineer' },
    questions: [...questions],
    applicantSnapshot: null,
    resumeEmail: 'student@example.com',
    applicantEmail: packet.email,
    employerDelivery: createEmployerDeliveryBindings(packet, {}, { mode: 'browser', envelope }),
    pdfObjectKey: 'users/owner-1/resumes/application-1.pdf',
    pdfBytes: RESUME,
    editedTerms: [],
    clauses: [{ text: JD, start: 0, end: JD.length, verdict: 'unscoreable' }],
    rejected: [],
    degraded: false,
    terms: { covered: [], missing: [], edited: [] },
  });
}

const carryLearned = (over: {
  acknowledged?: ApplicationReviewQuestion[];
  reissued?: ApplicationReviewQuestion[];
  auditQuestions?: ApplicationReviewQuestion[];
} = {}) => {
  const prior = auditOver(APPROVED_ROWS, BEFORE_THE_PROBE);
  const reissued = auditOver(over.auditQuestions ?? [...APPROVED_ROWS, LEARNED_ROW], AFTER_THE_PROBE);
  return relearnedFormReadingAcknowledgement({
    priorAudit: prior,
    priorAcknowledgement: acknowledgementOf(prior),
    reissuedAudit: reissued,
    acknowledgedAt: AT,
    learnedQuestions: {
      acknowledged: over.acknowledged ?? APPROVED_ROWS,
      reissued: over.reissued ?? [...APPROVED_ROWS, LEARNED_ROW],
    },
  });
};

test('the approval carries onto an audit re-issued over a row the form taught Litos it asks', () => {
  const carried = carryLearned();
  assert.ok(carried);
  assert.equal(carried!.source, 'form_reading_measured');
  assert.equal(
    carried!.packet_version,
    auditOver([...APPROVED_ROWS, LEARNED_ROW], AFTER_THE_PROBE).packet_version,
  );
});

test('a learned row with an answer on it is content she has not seen, and carries nothing', () => {
  assert.equal(carryLearned({
    reissued: [...APPROVED_ROWS, { ...LEARNED_ROW, answer: 'Female' }],
    auditQuestions: [...APPROVED_ROWS, { ...LEARNED_ROW, answer: 'Female' }],
  }), null, 'a machine answer');
  assert.equal(carryLearned({
    reissued: [...APPROVED_ROWS, { ...LEARNED_ROW, answer_source: 'applicant_review' }],
    auditQuestions: [...APPROVED_ROWS, { ...LEARNED_ROW, answer_source: 'applicant_review' }],
  }), null, 'a claim of hers the approval never held');
});

test('a row she approved that moved inside the re-issued set carries nothing', () => {
  const rewritten = [{ ...APPROVED_ROWS[0], answer: 'No' }];
  assert.equal(carryLearned({
    reissued: [...rewritten, LEARNED_ROW],
    auditQuestions: [...rewritten, LEARNED_ROW],
  }), null);
});

test('a set that does not OPEN with her rows carries nothing, however it hashes', () => {
  // Same rows, learned one first: the prefix is no longer what she approved, so the restriction
  // in the identity comparison would not be a restriction of anything.
  assert.equal(carryLearned({
    reissued: [LEARNED_ROW, ...APPROVED_ROWS],
    auditQuestions: [LEARNED_ROW, ...APPROVED_ROWS],
  }), null);
  // An "acknowledged" set the prior audit never bound is refused before anything else is read.
  assert.equal(carryLearned({ acknowledged: [] }), null);
  // A reissued set the reissued audit never bound is refused too.
  assert.equal(carryLearned({ reissued: APPROVED_ROWS }), null);
});
