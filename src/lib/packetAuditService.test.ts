import assert from 'node:assert/strict';
import test from 'node:test';
import { createPacketAudit } from './packetAudit';
import {
  currentAcknowledgedPacketAudit,
  monthsOfExperienceFromSpec,
  scoreAuditEvidence,
  verifyCurrentPacketEmailIdentities,
  validStoredPdf,
} from './packetAuditService';
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
      _contact: { email: 'student@example.com' },
      _applicant_email: {
        address: 'app-owner@apply.trylitos.com', source: 'litos_alias', reason: 'deliverable', tracked: true,
        decided_at: '2026-08-11T00:00:00.000Z',
      },
      _application_email: {
        alias: 'app-owner@apply.trylitos.com', forwards_to: 'student@example.com', mode: 'litos_application_alias',
      },
      _review: {
        jd_text: jdText,
        questions: [],
        status: 'ready_for_final_approval',
        applicant_email: {
          address: 'app-owner@apply.trylitos.com', source: 'litos_alias', reason: 'deliverable', tracked: true,
          decided_at: '2026-08-11T00:00:00.000Z',
        },
        applicant_snapshot: {
          profile: { email: 'app-owner@apply.trylitos.com', experience: [], skills: [], school: '', grad_year: 0 },
          application_profile: {},
        },
      },
    },
  };
  const audit = createPacketAudit({
    ownerId: baseRow.user_id,
    applicationId: baseRow.id,
    jdText,
    spec: baseRow.spec,
    jobContext: baseRow.job_context,
    questions: [],
    applicantSnapshot: baseRow.spec._review.applicant_snapshot,
    resumeEmail: 'student@example.com',
    applicantEmail: 'app-owner@apply.trylitos.com',
    pdfObjectKey: baseRow.resume_object_key,
    pdfBytes,
    editedTerms: [],
    rejected: [],
    degraded: false,
    clauses: [{ text: jdText, start: 0, end: jdText.length, verdict: 'missing' }],
    terms: { covered: [], missing: [], edited: [] },
  });
  const loadPdf = async () => ({ bytes: pdfBytes, contentType: 'application/pdf' });
  const validateApplicantEmail = async () => {};
  const withoutAck = {
    ...baseRow,
    spec: {
      ...baseRow.spec,
      _review: { ...baseRow.spec._review, packet_audit: audit },
      _quality: {
        pdfGenerationBinding: createPdfGenerationBinding(baseRow.spec, baseRow.resume_object_key, pdfBytes, 'student@example.com'),
      },
    },
  };
  const missing = await currentAcknowledgedPacketAudit(withoutAck as never, { loadPdf, validateApplicantEmail });
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
  assert.equal((await currentAcknowledgedPacketAudit(acknowledged as never, { loadPdf, validateApplicantEmail })).valid, true);
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
  const staleVerdict = await currentAcknowledgedPacketAudit(stale as never, { loadPdf, validateApplicantEmail });
  assert.deepEqual(staleVerdict.valid ? null : staleVerdict.code, 'PACKET_AUDIT_ACK_REQUIRED');
});

test('generation binding rejects stale keys and valid but unrelated same-size PDF bytes', () => {
  const spec = { target_role: 'Engineer', experience: [], skills: [] };
  const objectKey = 'users/owner/resume.pdf';
  const expected = Buffer.from('%PDF-1.7\nNAME A');
  const unrelated = Buffer.from('%PDF-1.7\nNAME B');
  assert.equal(expected.length, unrelated.length);
  const binding = createPdfGenerationBinding(spec, objectKey, expected, 'student@example.com');
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, objectKey, expected, 'student@example.com'), true);
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, 'users/owner/other.pdf', expected, 'student@example.com'), false);
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, objectKey, unrelated, 'student@example.com'), false);
  assert.equal(pdfGenerationBindingIsCurrent(binding, { ...spec, target_role: 'Analyst' }, objectKey, expected, 'student@example.com'), false);
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, objectKey, expected, 'routing@apply.trylitos.com'), false);
  assert.equal(pdfGenerationBindingIsCurrent(null, spec, objectKey, expected, 'student@example.com'), false);
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
  const binding = createPdfGenerationBinding(spec, key, exact, 'student@example.com');
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, key, missingHeader, 'student@example.com'), false);
  assert.equal(pdfGenerationBindingIsCurrent(binding, spec, key, reordered, 'student@example.com'), false);
});

test('saved experience dates compute exact month floors and fail closed when unparseable', () => {
  const base = { target_role: 'Engineer', school: '', degree: '', grad_date: '', gpa: '', school_location: '', coursework: '', skills: [] };
  const entry = (date_range: string) => ({ org: 'Acme', title: 'Engineer', location: '', date_range, bullets: ['Built systems'] });
  const now = new Date('2026-08-10T00:00:00Z');
  assert.equal(monthsOfExperienceFromSpec({ ...base, experience: [entry('Jun 2018 - Jun 2024')] }, now), 72);
  assert.equal(monthsOfExperienceFromSpec({ ...base, experience: [entry('2020 - 2024')] }, now), 60);
  assert.equal(monthsOfExperienceFromSpec({
    ...base,
    experience: [entry('Jan 2020 - Jan 2024'), entry('Jan 2022 - Jan 2024')],
  }, now), 48);
  assert.equal(monthsOfExperienceFromSpec({
    ...base,
    experience: [
      { ...entry('Jan 2020 - Jan 2024'), type: 'job' as const },
      { ...entry('Jan 2022 - Jan 2024'), type: 'project' as const },
    ],
  }, now, true), 48);
  assert.equal(monthsOfExperienceFromSpec({ ...base, experience: [entry('Jan 2020 - Jan 2024')] }, now, true), null);
  assert.equal(monthsOfExperienceFromSpec({ ...base, experience: [entry('Summer 2024 - Present')] }, now), null);
});

test('packet scoring keeps met, unmet, and unparseable experience-year requirements fail closed', async () => {
  const score = async (
    date_range: string,
    requirement = '5+ years of experience building software systems',
    type: 'job' | 'project' | 'leadership' = 'job',
  ) => {
    const spec = {
      target_role: 'Engineer', school: '', degree: '', grad_date: '', gpa: '', school_location: '', coursework: '', skills: [],
      experience: [{ type, org: 'Acme', title: 'Engineer', location: '', date_range, bullets: ['Built production systems'] }],
      _review: {},
    };
    const review = { jd_text: `Requirements\n${requirement}`, questions: [], edited_terms: [], status: 'ready_to_submit' } as never;
    return scoreAuditEvidence({ spec, job_context: { role: 'Engineer' } } as never, review);
  };
  const met = await score('Jun 2018 - Jun 2024');
  assert.equal(met.degraded, false);
  assert.equal(met.clauses[0]?.verdict, 'covered');
  const unmet = await score('Jun 2024 - Present');
  assert.equal(unmet.degraded, false);
  assert.equal(unmet.clauses[0]?.verdict, 'missing');
  const unknown = await score('Summer 2024 - Present');
  assert.equal(unknown.degraded, true);
  const projectOnly = await score('Jun 2018 - Jun 2024', '5+ years of professional experience building software', 'project');
  assert.equal(projectOnly.degraded, false);
  assert.equal(projectOnly.clauses[0]?.verdict, 'missing');

  const skillWithShortDates = await score('Jun 2024 - Present', '5+ years of experience with production systems');
  assert.equal(skillWithShortDates.clauses[0]?.verdict, 'missing');
  const missingSkillWithLongDates = await score('Jun 2018 - Jun 2024', '5+ years of experience with Kubernetes');
  assert.equal(missingSkillWithLongDates.clauses[0]?.verdict, 'missing');
  const skillAndDatesMet = await score('Jun 2018 - Jun 2024', '5+ years of experience with production systems');
  assert.equal(skillAndDatesMet.clauses[0]?.verdict, 'covered');
});

test('packet scoring requires frozen enrollment truth and an exact requested degree level', async () => {
  const score = async (degree: string, currently_enrolled: boolean | undefined, requirement: string) => {
    const spec = {
      target_role: 'Analyst', school: 'USC', degree, grad_date: 'May 2027', gpa: '', school_location: '', coursework: '', skills: [],
      experience: [], _review: {},
    };
    const review = {
      jd_text: `Requirements\n${requirement}`,
      questions: [], edited_terms: [], status: 'ready_to_submit',
      applicant_snapshot: { profile: { currently_enrolled }, application_profile: {} },
    } as never;
    return scoreAuditEvidence({ spec, job_context: { role: 'Analyst' } } as never, review);
  };
  const enrolled = await score('Bachelor of Science', true, "Currently enrolled in a bachelor's degree program");
  assert.equal(enrolled.clauses[0]?.verdict, 'covered');
  assert.deepEqual(enrolled.clauses[0]?.evidence?.map((pointer) => [pointer.source, pointer.path]), [
    ['resume_spec', '/degree'],
    ['applicant_snapshot', '/profile/currently_enrolled'],
  ]);
  assert.equal((await score('Associate of Arts', true, "Currently enrolled in a bachelor's degree program")).clauses[0]?.verdict, 'missing');
  assert.equal((await score('Bachelor of Science', false, "Currently enrolled in a bachelor's degree program")).clauses[0]?.verdict, 'missing');
  assert.equal((await score('Master of Science', true, "Currently enrolled in a bachelor's degree program")).clauses[0]?.verdict, 'missing');
  assert.equal((await score('Associate of Arts', true, "Bachelor's degree in any field is required")).clauses[0]?.verdict, 'missing');
  assert.equal((await score('Master of Science', true, "Bachelor's degree in any field is required")).clauses[0]?.verdict, 'covered');
  assert.equal((await score('Doctorate in Engineering', true, "Bachelor's degree in any field is required")).clauses[0]?.verdict, 'covered');
  assert.equal((await score('Bachelor of Science', undefined, "Currently enrolled in a bachelor's degree program")).degraded, true);
});

test('covered duration clauses retain every contributing saved date range', async () => {
  const spec = {
    target_role: 'Engineer', school: '', degree: '', grad_date: '', gpa: '', school_location: '', coursework: '', skills: [],
    experience: [
      { type: 'job' as const, org: 'First', title: 'Engineer', location: '', date_range: 'Jan 2018 - Jan 2021', bullets: ['Built systems'] },
      { type: 'job' as const, org: 'Second', title: 'Engineer', location: '', date_range: 'Jan 2021 - Jan 2024', bullets: ['Operated systems'] },
    ],
    _review: {},
  };
  const review = {
    jd_text: 'Requirements\n5+ years of professional experience building software systems',
    questions: [], edited_terms: [], status: 'ready_to_submit',
  } as never;
  const scored = await scoreAuditEvidence({ spec, job_context: { role: 'Engineer' } } as never, review);
  assert.equal(scored.clauses[0]?.verdict, 'covered');
  assert.deepEqual(scored.clauses[0]?.evidence?.map((pointer) => pointer.path), [
    '/experience/0/date_range',
    '/experience/1/date_range',
  ]);
});

test('current packet identities require the explicit profile resume email and active exact alias', async () => {
  const alias = 'app-2222222222-abcdef012345@apply.trylitos.com';
  const row = {
    id: '22222222-2222-4222-8222-222222222222',
    user_id: '11111111-1111-4111-8111-111111111111',
    spec: {
      _contact: { email: 'mehekman@usc.edu' },
      _applicant_email: {
        address: alias, source: 'litos_alias', reason: 'deliverable', tracked: true,
        decided_at: '2026-08-11T00:00:00.000Z',
      },
      _review: {
        jd_text: 'Requirements', status: 'ready_to_submit', questions: [],
        applicant_email: {
          address: alias, source: 'litos_alias', reason: 'deliverable', tracked: true,
          decided_at: '2026-08-11T00:00:00.000Z',
        },
      },
    },
  } as never;
  const choice = {
    address: alias, source: 'litos_alias' as const, reason: 'deliverable' as const, tracked: true,
    decided_at: '2026-08-11T00:00:00.000Z',
  };
  await verifyCurrentPacketEmailIdentities(row, {
    loadCurrentResumeEmail: async () => 'mehekman@usc.edu',
    resolveCurrentApplicantEmail: async () => choice,
  });
  await assert.rejects(verifyCurrentPacketEmailIdentities(row, {
    loadCurrentResumeEmail: async () => 'old-login@gmail.com',
    resolveCurrentApplicantEmail: async () => choice,
  }), /personal resume email changed/i);
  await assert.rejects(verifyCurrentPacketEmailIdentities(row, {
    loadCurrentResumeEmail: async () => undefined,
    resolveCurrentApplicantEmail: async () => choice,
  }), /missing/i);
  await assert.rejects(verifyCurrentPacketEmailIdentities(row, {
    loadCurrentResumeEmail: async () => 'mehekman@usc.edu',
    resolveCurrentApplicantEmail: async () => { throw new Error('alias is not active for this packet'); },
  }), /not active/i);
  await assert.rejects(verifyCurrentPacketEmailIdentities(row, {
    loadCurrentResumeEmail: async () => 'mehekman@usc.edu',
    resolveCurrentApplicantEmail: async () => ({ ...choice, address: 'app-other@apply.trylitos.com' }),
  }), /does not match/i);
});
