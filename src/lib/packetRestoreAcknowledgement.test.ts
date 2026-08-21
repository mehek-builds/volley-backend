/* A REBUILD MUST NOT MANUFACTURE THE HUMAN STEP.
 *
 * The packet gate is two records, not one. `packet_audit` is what Litos proved about the packet;
 * `packet_audit_acknowledgement` is the applicant saying she looked at those exact bytes, and it is
 * the one every send path reads. The retention restore re-issues the audit against a rebuilt file,
 * and it used to write a full acknowledgement beside it with no check that one had ever existed.
 * POST /applications/:id/packet-audit opted into that restore, and that route RENDERS the packet
 * for her to look at - so opening a packet could produce the record that authorizes sending it, for
 * every downstream caller including the unattended runner under standing consent.
 *
 * The rule now: changed PDF bytes require a fresh audit and acknowledgement because the exact
 * employer-delivery binding includes those bytes. Carry is limited to an authorizing caller whose
 * new object key still holds byte-identical content under the same current delivery binding.
 *
 * BEHAVIOURAL, DRIVING THE REAL FUNCTIONS. The decision function is the one the restore calls, and
 * the verdicts below come from the real send gate, currentAcknowledgedPacketAudit, over rows shaped
 * the way a restore leaves them. packetRestoreAcknowledgement.db.test.ts drives the restore itself
 * against a real database, because a correct decision that is not wired to the write is exactly the
 * bug this file exists about.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createPacketAudit, type PacketAudit } from './packetAudit';
import { currentAcknowledgedPacketAudit } from './packetAuditService';
import { restoredPacketAcknowledgement } from './packetResumeRestore';
import { createPdfGenerationBinding } from './pdfGenerationBinding';
import {
  createEmployerDeliveryBindings,
  employerDeliveryEnvelope,
  transportBoundEmployerPacket,
  type EmployerDeliveryBindings,
} from './employerDeliveryIdentity';
import type { SubmissionPacket } from './portalSubmission';

const JD_TEXT = 'Build reliable systems.';
const OWNER = 'owner-restore-1';
const APPLICATION = 'application-restore-1';
const RESUME_EMAIL = 'student@example.com';
const APPLICANT_EMAIL = 'app-owner@apply.trylitos.com';
const ACKNOWLEDGED_AT = '2026-08-12T09:00:00.000Z';
const EMPLOYER_DELIVERY_BINDING = {
  version: 'employer_delivery_v1',
  mode: 'browser',
  sha256: 'b'.repeat(64),
} as const;

type Question = { question: string; answer: string };

function specFor(
  questions: Question[],
  employerDelivery: EmployerDeliveryBindings | undefined = EMPLOYER_DELIVERY_BINDING,
) {
  return {
    target_role: 'Engineer',
    school: '',
    degree: '',
    grad_date: '',
    gpa: '',
    school_location: '',
    coursework: '',
    experience: [],
    skills: [],
    _contact: { email: RESUME_EMAIL },
    _applicant_email: {
      address: APPLICANT_EMAIL, source: 'litos_alias', reason: 'deliverable', tracked: true,
      decided_at: '2026-08-11T00:00:00.000Z',
    },
    _application_email: {
      alias: APPLICANT_EMAIL, forwards_to: RESUME_EMAIL, mode: 'litos_application_alias',
    },
    _review: {
      jd_text: JD_TEXT,
      questions,
      status: 'ready_for_final_approval',
      applicant_email: {
        address: APPLICANT_EMAIL, source: 'litos_alias', reason: 'deliverable', tracked: true,
        decided_at: '2026-08-11T00:00:00.000Z',
      },
      applicant_snapshot: {
        profile: { email: APPLICANT_EMAIL, experience: [], skills: [], school: '', grad_year: 0 },
        application_profile: {},
      },
      ...(employerDelivery ? { employer_delivery_bindings: employerDelivery } : {}),
    },
  };
}

/** A real audit over a real spec, so the digests below are the ones production computes. */
function auditFor(options: {
  objectKey: string;
  pdfBytes: Buffer;
  questions?: Question[];
  employerDelivery?: EmployerDeliveryBindings | null;
}): PacketAudit {
  const questions = options.questions ?? [];
  const employerDelivery = options.employerDelivery === null
    ? undefined
    : options.employerDelivery ?? EMPLOYER_DELIVERY_BINDING;
  const spec = specFor(questions, employerDelivery);
  return createPacketAudit({
    ownerId: OWNER,
    applicationId: APPLICATION,
    jdText: JD_TEXT,
    spec,
    jobContext: { company: 'Acme', role: 'Engineer' },
    questions,
    applicantSnapshot: spec._review.applicant_snapshot,
    ...(employerDelivery ? { employerDelivery } : {}),
    resumeEmail: RESUME_EMAIL,
    applicantEmail: APPLICANT_EMAIL,
    pdfObjectKey: options.objectKey,
    pdfBytes: options.pdfBytes,
    editedTerms: [],
    rejected: [],
    degraded: false,
    clauses: [{ text: JD_TEXT, start: 0, end: JD_TEXT.length, verdict: 'missing' }],
    terms: { covered: [], missing: [], edited: [] },
  });
}

/** The row as a caller would see it, with whatever acknowledgement the restore left on it. */
function rowFor(options: {
  objectKey: string;
  pdfBytes: Buffer;
  audit: PacketAudit;
  acknowledgement?: unknown;
  questions?: Question[];
}) {
  const spec = specFor(options.questions ?? [], options.audit.bindings.employerDelivery);
  return {
    id: APPLICATION,
    user_id: OWNER,
    resume_object_key: options.objectKey,
    job_context: { company: 'Acme', role: 'Engineer' },
    spec: {
      ...spec,
      _review: {
        ...spec._review,
        packet_audit: options.audit,
        ...(options.acknowledgement ? { packet_audit_acknowledgement: options.acknowledgement } : {}),
      },
      _quality: {
        pdfGenerationBinding: createPdfGenerationBinding(spec, options.objectKey, options.pdfBytes, RESUME_EMAIL),
      },
    },
  };
}

/** The exact record the acknowledge route writes when the applicant presses approve. */
function applicantAcknowledgementOf(audit: PacketAudit) {
  return {
    ownerSha256: audit.bindings.ownerSha256,
    applicationId: audit.bindings.applicationId,
    audit_digest: audit.audit_digest,
    packet_version: audit.packet_version,
    pdfSha256: audit.bindings.pdf.sha256,
    pdfSizeBytes: audit.bindings.pdf.sizeBytes,
    acknowledged_at: '2026-07-20T09:00:00.000Z',
  };
}

/** The send gate every submit path funnels through, over the row a restore left behind. */
async function sendGate(row: ReturnType<typeof rowFor>, pdfBytes: Buffer) {
  return currentAcknowledgedPacketAudit(row as never, {
    loadPdf: async () => ({ bytes: pdfBytes, contentType: 'application/pdf' }),
    validateApplicantEmail: async () => {},
  });
}

const OLD_KEY = `users/${OWNER}/resumes/${APPLICATION}.pdf`;
const NEW_KEY = `users/${OWNER}/resumes/${APPLICATION}-restored-1111.pdf`;
/* Different bytes model the normal case: pdfkit stamps a CreationDate, so renders at different
   times ordinarily have different hashes. Byte-identical output remains possible and is tested
   separately because only that exceptional case may preserve the delivery binding. */
const OLD_BYTES = Buffer.from('%PDF-1.7\npacket rendered on the day it was built');
const NEW_BYTES = Buffer.from('%PDF-1.7\npacket rendered again thirty-one days later');
const DELIVERY_ENVELOPE = employerDeliveryEnvelope({
  channel: 'controlled_browser',
  destinationUrl: 'https://example.com/jobs/restore-1',
  portalFamily: 'controlled_test',
  coverLetterSupported: false,
  transcriptSupported: false,
});

function deliveryPacket(resume: Buffer): SubmissionPacket {
  return {
    fullName: 'Restore Student',
    email: APPLICANT_EMAIL,
    jdText: JD_TEXT,
    resume,
    resumeName: 'restore-student-resume.pdf',
    questions: [],
  };
}

test('a rebuild with no acknowledgement to carry leaves a packet nothing can send', async () => {
  const before = auditFor({ objectKey: OLD_KEY, pdfBytes: OLD_BYTES });
  const restored = auditFor({ objectKey: NEW_KEY, pdfBytes: NEW_BYTES });

  // Neither authority may invent the record. A send path cannot conjure her approval either.
  for (const authority of ['authorizing_send', 'review_only'] as const) {
    assert.equal(
      restoredPacketAcknowledgement({
        authority,
        priorAudit: before,
        priorAcknowledgement: undefined,
        restoredAudit: restored,
        acknowledgedAt: ACKNOWLEDGED_AT,
      }),
      null,
      authority,
    );
  }

  // And the packet that comes out of that rebuild is refused by the gate every send path reads.
  const verdict = await sendGate(rowFor({ objectKey: NEW_KEY, pdfBytes: NEW_BYTES, audit: restored }), NEW_BYTES);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.valid ? null : verdict.code, 'PACKET_AUDIT_ACK_REQUIRED');
});

test('changed rerendered bytes require a fresh audit and acknowledgement before transport', async () => {
  const approvedPacket = deliveryPacket(OLD_BYTES);
  const rebuiltPacket = deliveryPacket(NEW_BYTES);
  const approvedDelivery = createEmployerDeliveryBindings(approvedPacket, {}, {
    mode: 'browser',
    envelope: DELIVERY_ENVELOPE,
  });
  const before = auditFor({ objectKey: OLD_KEY, pdfBytes: OLD_BYTES, employerDelivery: approvedDelivery });
  const restored = auditFor({ objectKey: NEW_KEY, pdfBytes: NEW_BYTES, employerDelivery: approvedDelivery });
  const hers = applicantAcknowledgementOf(before);

  const carried = restoredPacketAcknowledgement({
    authority: 'authorizing_send',
    priorAudit: before,
    priorAcknowledgement: hers,
    restoredAudit: restored,
    acknowledgedAt: ACKNOWLEDGED_AT,
  });
  assert.equal(carried, null, 'approval of the deleted PDF cannot authorize different rebuilt bytes');

  let transports = 0;
  await assert.rejects(
    () => transportBoundEmployerPacket(
      rebuiltPacket,
      restored.bindings.employerDelivery,
      'browser',
      DELIVERY_ENVELOPE,
      async () => { transports += 1; },
    ),
    /employer-delivery payload changed after packet approval/,
  );
  assert.equal(transports, 0, 'the stale delivery binding must stop before employer transport');

  const rebuiltDelivery = createEmployerDeliveryBindings(rebuiltPacket, {}, {
    mode: 'browser',
    envelope: DELIVERY_ENVELOPE,
  });
  const delivered = await transportBoundEmployerPacket(
    rebuiltPacket,
    rebuiltDelivery,
    'browser',
    DELIVERY_ENVELOPE,
    async (exactPacket) => exactPacket,
  );
  assert.strictEqual(delivered, rebuiltPacket, 'a fresh binding sends the exact packet it verified');

  /* THE REVIEW ROUTE, WHICH IS WHERE THE DEFECT LIVED. It may rebuild the file she asked to see,
     and it carries nothing: the packet comes back with the acknowledgement that named the deleted
     file, which is stale by construction, so the send gate asks her again. */
  assert.equal(
    restoredPacketAcknowledgement({
      authority: 'review_only',
      priorAudit: before,
      priorAcknowledgement: hers,
      restoredAudit: restored,
      acknowledgedAt: ACKNOWLEDGED_AT,
    }),
    null,
  );
  const afterLooking = await sendGate(
    rowFor({ objectKey: NEW_KEY, pdfBytes: NEW_BYTES, audit: restored, acknowledgement: hers }),
    NEW_BYTES,
  );
  assert.equal(afterLooking.valid ? null : afterLooking.code, 'PACKET_AUDIT_ACK_REQUIRED');
});

test('legacy audits without the exhaustive employer delivery binding never carry approval', () => {
  const legacy = auditFor({ objectKey: OLD_KEY, pdfBytes: OLD_BYTES, employerDelivery: null });
  const restoredLegacy = auditFor({ objectKey: NEW_KEY, pdfBytes: OLD_BYTES, employerDelivery: null });
  assert.equal(
    restoredPacketAcknowledgement({
      authority: 'authorizing_send',
      priorAudit: legacy,
      priorAcknowledgement: applicantAcknowledgementOf(legacy),
      restoredAudit: restoredLegacy,
      acknowledgedAt: ACKNOWLEDGED_AT,
    }),
    null,
  );
});

test('an acknowledgement that did not match the packet she approved is not laundered into one that does', () => {
  const before = auditFor({ objectKey: OLD_KEY, pdfBytes: OLD_BYTES });
  const restored = auditFor({ objectKey: NEW_KEY, pdfBytes: NEW_BYTES });
  const hers = applicantAcknowledgementOf(before);

  /* Each of these was already refused by the send gate before the file expired, so none of them is
     approval of anything. Re-binding one to the rebuilt file would turn a record the gate rejects
     into a record it accepts, which is worse than writing a fresh one. */
  const broken = [
    { ...hers, pdfSizeBytes: hers.pdfSizeBytes + 1 },
    { ...hers, pdfSha256: `${hers.pdfSha256.slice(0, -1)}0` },
    { ...hers, audit_digest: `${hers.audit_digest.slice(0, -1)}0` },
    { ...hers, packet_version: `${hers.packet_version.slice(0, -1)}0` },
    { ...hers, applicationId: 'another-application' },
    { ...hers, ownerSha256: `${hers.ownerSha256.slice(0, -1)}0` },
  ];
  for (const [index, acknowledgement] of broken.entries()) {
    assert.equal(
      restoredPacketAcknowledgement({
        authority: 'authorizing_send',
        priorAudit: before,
        priorAcknowledgement: acknowledgement,
        restoredAudit: restored,
        acknowledgedAt: ACKNOWLEDGED_AT,
      }),
      null,
      `broken[${index}]`,
    );
  }

  // A packet with no audit before the rebuild has nothing for an acknowledgement to have been of.
  assert.equal(
    restoredPacketAcknowledgement({
      authority: 'authorizing_send',
      priorAudit: undefined,
      priorAcknowledgement: hers,
      restoredAudit: restored,
      acknowledgedAt: ACKNOWLEDGED_AT,
    }),
    null,
  );
});

test('an audit that now says something different about the packet is not covered by the old approval', () => {
  const questions = [{ question: 'Have you applied to us before?', answer: 'No' }];
  const before = auditFor({ objectKey: OLD_KEY, pdfBytes: OLD_BYTES });
  const restored = auditFor({ objectKey: NEW_KEY, pdfBytes: NEW_BYTES, questions });

  /* The rebuild is meant to change ONE thing: which file carries the packet. Anything else - an
     answer, the spec, the JD, a clause verdict that moved because scoring reads the calendar - is
     something she has not seen, and her approval does not stretch to cover it. */
  assert.equal(
    restoredPacketAcknowledgement({
      authority: 'authorizing_send',
      priorAudit: before,
      priorAcknowledgement: applicantAcknowledgementOf(before),
      restoredAudit: restored,
      acknowledgedAt: ACKNOWLEDGED_AT,
    }),
    null,
  );

  // A new object key over byte-identical content can carry because the exhaustive delivery binding
  // still describes the exact employer payload. Normal PDF rerenders do not meet this condition.
  const sameContent = auditFor({ objectKey: NEW_KEY, pdfBytes: OLD_BYTES });
  assert.ok(restoredPacketAcknowledgement({
    authority: 'authorizing_send',
    priorAudit: before,
    priorAcknowledgement: applicantAcknowledgementOf(before),
    restoredAudit: sameContent,
    acknowledgedAt: ACKNOWLEDGED_AT,
  }));
});
