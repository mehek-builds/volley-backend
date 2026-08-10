import assert from 'node:assert/strict';
import test from 'node:test';
import { createPacketAudit } from './packetAudit';
import { currentAcknowledgedPacketAudit, validStoredPdf } from './packetAuditService';
import { createPdfGenerationBinding, pdfGenerationBindingIsCurrent } from './pdfGenerationBinding';

test('stored packet PDF requires an exact PDF signature', () => {
  assert.equal(validStoredPdf({ bytes: Buffer.from('%PDF-1.7\npacket') }), true);
  assert.equal(validStoredPdf({ bytes: Buffer.from(' %PDF-1.7\npacket') }), false);
  assert.equal(validStoredPdf({ bytes: Buffer.from('<html>not a resume</html>') }), false);
  assert.equal(validStoredPdf({ bytes: Buffer.alloc(0) }), false);
});

test('stored packet PDF rejects conflicting metadata but permits absent metadata', () => {
  const bytes = Buffer.from('%PDF-1.7\npacket');
  assert.equal(validStoredPdf({ bytes, contentType: 'application/pdf' }), true);
  assert.equal(validStoredPdf({ bytes, contentType: 'application/pdf; charset=binary' }), true);
  assert.equal(validStoredPdf({ bytes }), true);
  assert.equal(validStoredPdf({ bytes, contentType: 'application/octet-stream' }), false);
  assert.equal(validStoredPdf({ bytes, contentType: 'text/html' }), false);
});

test('a current audit does not authorize until the exact rendered packet is acknowledged', async () => {
  const pdfBytes = Buffer.from('%PDF-1.7\npacket');
  const jdText = 'Build reliable systems.';
  const baseRow = {
    id: 'application-1',
    user_id: 'owner-1',
    resume_object_key: 'users/owner-1/resumes/application-1.pdf',
    job_context: { company: 'Acme', role: 'Engineer' },
    spec: {
      target_role: 'Engineer',
      school: '',
      degree: '',
      grad_date: '',
      gpa: '',
      school_location: '',
      coursework: '',
      experience: [],
      skills: [],
      _review: { jd_text: jdText, questions: [], status: 'ready_for_final_approval' },
    },
  };
  const audit = createPacketAudit({
    ownerId: baseRow.user_id,
    applicationId: baseRow.id,
    jdText,
    spec: baseRow.spec,
    jobContext: baseRow.job_context,
    questions: [],
    pdfObjectKey: baseRow.resume_object_key,
    pdfBytes,
    editedTerms: [],
    rejected: [],
    degraded: false,
    clauses: [{ text: jdText, start: 0, end: jdText.length, verdict: 'missing' }],
    terms: { covered: [], missing: [], edited: [] },
  });
  const loadPdf = async () => ({ bytes: pdfBytes, contentType: 'application/pdf' });
  const withoutAck = {
    ...baseRow,
    spec: {
      ...baseRow.spec,
      _review: { ...baseRow.spec._review, packet_audit: audit },
      _quality: {
        pdfGenerationBinding: createPdfGenerationBinding(baseRow.spec, baseRow.resume_object_key, pdfBytes),
      },
    },
  };
  const missing = await currentAcknowledgedPacketAudit(withoutAck as never, { loadPdf });
  assert.deepEqual(missing.valid ? null : missing.code, 'PACKET_AUDIT_ACK_REQUIRED');

  const acknowledgement = {
    ownerSha256: audit.bindings.ownerSha256,
    applicationId: audit.bindings.applicationId,
    audit_digest: audit.audit_digest,
    packet_version: audit.packet_version,
    pdfSha256: audit.bindings.pdf.sha256,
    pdfSizeBytes: audit.bindings.pdf.sizeBytes,
    acknowledged_at: new Date().toISOString(),
  };
  const acknowledged = {
    ...withoutAck,
    spec: { ...withoutAck.spec, _review: { ...withoutAck.spec._review, packet_audit_acknowledgement: acknowledgement } },
  };
  assert.equal((await currentAcknowledgedPacketAudit(acknowledged as never, { loadPdf })).valid, true);
  const stale = {
    ...acknowledged,
    spec: {
      ...acknowledged.spec,
      _review: {
        ...acknowledged.spec._review,
        packet_audit_acknowledgement: { ...acknowledgement, pdfSizeBytes: acknowledgement.pdfSizeBytes + 1 },
      },
    },
  };
  const staleVerdict = await currentAcknowledgedPacketAudit(stale as never, { loadPdf });
  assert.deepEqual(staleVerdict.valid ? null : staleVerdict.code, 'PACKET_AUDIT_ACK_REQUIRED');
});

test('generation binding rejects stale keys and valid but unrelated same-size PDF bytes', () => {
  const spec = { target_role: 'Engineer', experience: [], skills: [] };
  const objectKey = 'users/owner/resume.pdf';
  const expected = Buffer.from('%PDF-1.7\nNAME A');
  const unrelated = Buffer.from('%PDF-1.7\nNAME B');
  assert.equal(expected.length, unrelated.length);
  const binding = createPdfGenerationBinding(spec, objectKey, expected);
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, objectKey, expected), true);
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, 'users/owner/other.pdf', expected), false);
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, objectKey, unrelated), false);
  assert.equal(pdfGenerationBindingIsCurrent(binding, { ...spec, target_role: 'Analyst' }, objectKey, expected), false);
  assert.equal(pdfGenerationBindingIsCurrent(null, spec, objectKey, expected), false);
});

test('missing header or reordered top-experience PDFs cannot reuse the saved generation proof', () => {
  const spec = {
    target_role: 'Engineer',
    experience: [
      { org: 'Aligned Role', title: 'Engineer', location: '', date_range: '2025', bullets: ['Built systems'] },
      { org: 'Older Role', title: 'Analyst', location: '', date_range: '2024', bullets: ['Analyzed systems'] },
    ],
    skills: ['TypeScript'],
  };
  const key = 'users/owner/aligned.pdf';
  const exact = Buffer.from('%PDF-1.7\nMehek Mandal\nBasic Information\nAligned Role\nOlder Role');
  const missingHeader = Buffer.from('%PDF-1.7\nAligned Role\nOlder Role');
  const reordered = Buffer.from('%PDF-1.7\nMehek Mandal\nBasic Information\nOlder Role\nAligned Role');
  const binding = createPdfGenerationBinding(spec, key, exact);
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, key, missingHeader), false);
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, key, reordered), false);
});
