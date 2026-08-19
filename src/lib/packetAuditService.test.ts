import assert from 'node:assert/strict';
import test from 'node:test';
import { createPacketAudit } from './packetAudit';
import {
  currentAcknowledgedPacketAudit,
  monthsOfExperienceFromSpec,
  packetAuditClientError,
  scoreAuditEvidence,
  tokenisedPacketAuditFailure,
  verifyCurrentPacketEmailIdentities,
  validStoredPdf,
} from './packetAuditService';
import { createPdfGenerationBinding, pdfGenerationBindingIsCurrent } from './pdfGenerationBinding';
import { mergeSubmittedApplicationReviewQuestions } from './applicationReview';

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

test('packet scoring keeps met, unmet, and unparseable experience-year requirements explicit without blocking the packet', async () => {
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
  assert.equal(unknown.clauses[0]?.verdict, 'unscoreable');
  assert.equal(unknown.degraded, false);
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

test('a low-detail open internship gets one exact unscoreable clause instead of a broken audit', async () => {
  const jdText = [
    'Internship',
    'Join us for your internship and get hands-on experience in real projects within games, web, design, and platforms.',
    'Happy to hear from you!',
  ].join('\n');
  const spec = {
    target_role: 'Intern', school: '', degree: '', grad_date: '', gpa: '', school_location: '', coursework: '', skills: [],
    experience: [],
    _review: {},
  };
  const scored = await scoreAuditEvidence(
    { spec, job_context: { company: 'Fully', role: 'Internship' } } as never,
    { jd_text: jdText, questions: [], edited_terms: [], status: 'ready_to_submit' } as never,
  );

  assert.equal(scored.clauses.length, 1);
  assert.deepEqual(scored.clauses[0], {
    text: 'Internship',
    start: 0,
    end: 'Internship'.length,
    verdict: 'unscoreable',
  });
  assert.equal(scored.degraded, false);
  assert.doesNotThrow(() => createPacketAudit({
    ownerId: 'owner-fully',
    applicationId: 'application-fully',
    jdText,
    spec,
    jobContext: { company: 'Fully', role: 'Internship' },
    questions: [],
    applicantSnapshot: null,
    resumeEmail: 'student@example.edu',
    applicantEmail: 'app-fully@apply.trylitos.com',
    pdfObjectKey: 'users/owner-fully/resumes/application-fully.pdf',
    pdfBytes: Buffer.from('%PDF-1.7\nFully packet'),
    editedTerms: scored.editedTerms,
    clauses: scored.clauses,
    rejected: scored.rejected,
    degraded: scored.degraded,
    terms: scored.terms,
  }));
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
  const unknownEnrollment = await score('Bachelor of Science', undefined, "Currently enrolled in a bachelor's degree program");
  assert.equal(unknownEnrollment.clauses[0]?.verdict, 'unscoreable');
  assert.equal(unknownEnrollment.degraded, false);
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
  };
  const scored = await scoreAuditEvidence({ spec, job_context: { role: 'Engineer' } } as never, review as never);
  assert.equal(scored.clauses[0]?.verdict, 'covered');
  assert.deepEqual(scored.clauses[0]?.evidence?.map((pointer) => pointer.path), [
    '/experience/0/date_range',
    '/experience/1/date_range',
  ]);
});

test('packet scoring canonicalizes nested compound terms before audit validation', async () => {
  const jdText = [
    'Qualifications',
    '- Experience with Salesforce administration.',
    '- Experience with merchant compliance.',
    '- Experience with cost accounting.',
    '- Experience with GitHub Actions.',
    '- Experience with regulatory policy.',
  ].join('\n');
  const spec = {
    target_role: 'Engineer', school: '', degree: '', grad_date: '', gpa: '', school_location: '', coursework: '',
    experience: [], skills: [], _review: {},
  };
  const scored = await scoreAuditEvidence(
    { spec, job_context: { role: 'Engineer' } } as never,
    { jd_text: jdText, questions: [], edited_terms: [], status: 'ready_to_submit' } as never,
  );
  const githubClause = scored.clauses.find((clause) => clause.text === 'Experience with GitHub Actions.');
  assert.deepEqual(githubClause, {
    text: 'Experience with GitHub Actions.',
    start: 136,
    end: 167,
    verdict: 'missing',
  });
  assert.deepEqual(scored.terms.missing.filter((term) => term.start >= 136 && term.end <= 167), [
    { start: 152, end: 166 },
  ]);
  const ranges = Object.values(scored.terms).flat();
  for (const [index, range] of ranges.entries()) {
    for (const other of ranges.slice(index + 1)) {
      assert.equal(range.start < other.end && other.start < range.end, false);
    }
  }
});

test('packet scoring returns only canonical edited metadata after nested term selection', async () => {
  const jdText = [
    'Qualifications',
    '- Experience with Salesforce administration.',
    '- Experience with merchant compliance.',
    '- Experience with cost accounting.',
    '- Experience with GitHub Actions in production.',
    '- Experience with regulatory policy.',
  ].join('\n');
  const spec = {
    target_role: 'Engineer', school: '', degree: '', grad_date: '', gpa: '', school_location: '', coursework: '', skills: [],
    experience: [{
      type: 'project' as const,
      org: 'Automation Project',
      title: 'Engineer',
      location: '',
      date_range: 'Jan 2025 - Dec 2025',
      bullets: ['Used GitHub Actions in production'],
    }],
    _review: {},
  };
  const scored = await scoreAuditEvidence(
    { spec, job_context: { role: 'Engineer' } } as never,
    { jd_text: jdText, questions: [], edited_terms: ['github', 'github actions'], status: 'ready_to_submit' } as never,
  );
  assert.deepEqual(scored.terms.edited.map((term) => jdText.slice(term.start, term.end)), ['GitHub Actions']);
  assert.deepEqual(scored.editedTerms, ['github actions']);
});

test('Mercari multilingual clause keeps generic API evidence separate from language alternatives', async () => {
  const jdText = [
    'Qualifications',
    '- Possessing one of the following 5 BOLD characteristics:',
    '- Co-creation with AI: Those who can maximize output using technology as a weapon.',
    'Required Experience / Skills',
    '- Experience in delivering results through projects utilizing the latest AI technologies and tools',
    '- Basic knowledge of RDBMS and SQL',
    '- Practical or research-level development experience in at least one of the following:',
    '- Backend: API development experience using languages such as Go, PHP, or Java.',
    '- Frontend: Development experience using JavaScript, React, etc.',
    '- Mobile (iOS or Android): Development experience using Swift or Kotlin.',
    '- Machine Learning: Practical experience in ML modeling or development experience in ML systems.',
    '- Platform Engineering: Development experience using Go and Kubernetes.',
    '- Site Reliability Engineering: Development experience using Go, Kubernetes, and Terraform.',
    '- Data Engineer: Experience in data aggregation, analysis, or visualization using Python, SQL, etc.',
    '- Security Engineer: Development experience using programming languages such as Go, Python, PHP, or JavaScript.',
    '',
    '求める経験・スキル',
    '- Backend：Go、PHP、Javaなど言語を用いたAPIの開発経験',
  ].join('\n');
  const spec = {
    target_role: 'Software Engineer Internship',
    school: 'USC',
    degree: 'Bachelor of Science',
    grad_date: 'May 2027',
    gpa: '',
    school_location: '',
    coursework: '',
    skills: ['API'],
    experience: [{
      type: 'project' as const,
      org: 'Student Product',
      title: 'Engineer',
      location: '',
      date_range: 'Jan 2025 - Dec 2025',
      bullets: ['Built and documented an API for a student product'],
    }],
    _review: {},
  };
  const scored = await scoreAuditEvidence(
    { spec, job_context: { company: 'Mercari', role: 'Class of 2028 Software Engineer Internship' } } as never,
    { jd_text: jdText, questions: [], edited_terms: [], status: 'ready_to_submit' } as never,
  );
  const clauseText = 'Practical or research-level development experience in at least one of the following:';
  const clause = scored.clauses.find((candidate) => candidate.text === clauseText);
  assert.deepEqual(clause, {
    text: clauseText,
    start: jdText.indexOf(clauseText),
    end: jdText.indexOf(clauseText) + clauseText.length,
    verdict: 'unscoreable',
  });
  assert.equal(clause?.evidence, undefined);
  assert.equal(scored.degraded, false);
  assert.doesNotThrow(() => createPacketAudit({
    ownerId: 'owner-mercari',
    applicationId: 'application-mercari',
    jdText,
    spec,
    jobContext: { company: 'Mercari', role: 'Class of 2028 Software Engineer Internship' },
    questions: [],
    applicantSnapshot: null,
    resumeEmail: 'student@example.edu',
    applicantEmail: 'app-mercari@apply.trylitos.com',
    pdfObjectKey: 'users/owner-mercari/resumes/application-mercari.pdf',
    pdfBytes: Buffer.from('%PDF-1.7\nMercari packet'),
    editedTerms: scored.editedTerms,
    clauses: scored.clauses,
    rejected: scored.rejected,
    degraded: scored.degraded,
    terms: scored.terms,
  }));
  assert.equal(scored.clauses.some((candidate) => candidate.text.startsWith('Backend:')), false);
  assert.equal(scored.clauses.some((candidate) => candidate.text.startsWith('Security Engineer:')), false);

  const frontendSpec = {
    ...spec,
    skills: ['Frontend', 'JavaScript', 'React'],
    experience: [{
      type: 'project' as const,
      org: 'Student Product',
      title: 'Frontend Engineer',
      location: '',
      date_range: 'Jan 2025 - Dec 2025',
      bullets: [
        'Built Frontend JavaScript interfaces with React for a student product',
        'Developed Frontend React components and JavaScript tests',
      ],
    }],
  };
  const frontend = await scoreAuditEvidence(
    { spec: frontendSpec, job_context: { company: 'Mercari', role: 'Class of 2028 Software Engineer Internship' } } as never,
    { jd_text: jdText, questions: [], edited_terms: [], status: 'ready_to_submit' } as never,
  );
  const branchClauses = frontend.clauses.filter((candidate) => /^(?:Backend|Frontend|Mobile|Machine Learning|Platform Engineering|Site Reliability Engineering|Data Engineer|Security Engineer):/u.test(candidate.text));
  assert.equal(branchClauses.length, 1);
  assert.equal(branchClauses[0].text.startsWith('Frontend:'), true);
  assert.equal(branchClauses[0].verdict, 'covered');
  assert.ok(branchClauses[0].evidence?.length);
  assert.equal(frontend.clauses.some((candidate) => candidate.text.startsWith('Security Engineer:')), false);
});

test('kos.ai Ashby bare You section emits exact auditable requirements with frozen evidence', async () => {
  const jdText = "What you'll do: Build and ship a bounded project in one of: eval infrastructure, ERP integration stubs, internal ops dashboards, or the agent training pipeline Partner with the founding team. They're your reviewer and your mentor. Learn how an AI-native product works under the hood. The agent loop, the eval harness, the production plumbing. Not the marketing version. Contribute to code reviews, design discussions, and the culture of the team You Current CS or ML undergrad or Master's student with a hands-on project or internship track record Fluent in one of Python, TypeScript, or Go. You pick up whatever else the project needs. You've played with LLMs, agents, or computer-use workflows. You've built something, not just read about it. You're hungry to ship code into production, not complete a rotational checklist You'd rather ship one thing a customer touches than polish ten projects that live on a demo-day slide You're comfortable working in-person at our SF office for the whole internship Comp and Benefits Relocation benefits Visa sponsorship for eligible candidates";
  const spec = {
    target_role: 'Software Engineer Intern',
    school: 'USC',
    degree: 'Bachelor of Science in Computer Science',
    grad_date: 'May 2027',
    gpa: '',
    school_location: '',
    coursework: '',
    skills: ['Python'],
    experience: [{
      type: 'project' as const,
      org: 'AI Project',
      title: 'Engineer',
      location: '',
      date_range: 'Jan 2025 - Dec 2025',
      bullets: ['Built LLM agent workflows in Python and shipped them to users'],
    }],
    _review: {},
  };
  const review = {
    jd_text: jdText,
    questions: [],
    edited_terms: [],
    status: 'ready_to_submit',
    applicant_snapshot: {
      profile: { currently_enrolled: true },
      application_profile: {
        onsite_commitment: 'listed_locations',
        onsite_locations: ['San Francisco'],
      },
    },
  };
  const scored = await scoreAuditEvidence(
    { spec, job_context: { company: 'kos.ai', role: 'Software Engineer Intern' } } as never,
    review as never,
  );
  assert.ok(scored.clauses.length > 0);
  const academicClause = scored.clauses.find((clause) => clause.text.startsWith('Current CS or ML'));
  assert.equal(academicClause?.verdict, 'covered');
  assert.deepEqual(academicClause?.evidence?.map((pointer) => pointer.path), [
    '/degree',
    '/profile/currently_enrolled',
    '/experience/0/bullets/0',
  ]);
  const pythonClause = scored.clauses.find((clause) => clause.text.startsWith('Fluent in one of Python'));
  assert.ok(pythonClause);
  assert.equal(pythonClause.verdict, 'covered');
  assert.equal(pythonClause.text, jdText.slice(pythonClause.start, pythonClause.end));
  assert.ok(pythonClause.evidence?.some((pointer) => pointer.source === 'resume_spec' && /Python/.test(pointer.quote)));
  const handsOnClause = scored.clauses.find((clause) => clause.text.startsWith("You've played with LLMs"));
  assert.equal(handsOnClause?.verdict, 'covered', JSON.stringify(handsOnClause));
  assert.ok(handsOnClause?.evidence?.some((pointer) => pointer.path === '/experience/0/bullets/0'));
  const onsiteClause = scored.clauses.find((clause) => clause.text.startsWith("You're comfortable working in-person"));
  assert.equal(onsiteClause?.verdict, 'covered');
  assert.deepEqual(onsiteClause?.evidence?.map((pointer) => pointer.path), [
    '/application_profile/onsite_commitment',
    '/application_profile/onsite_locations/0',
  ]);
  assert.equal(scored.degraded, false);
  assert.deepEqual(scored.rejected, []);
  assert.deepEqual(scored.terms.covered.map((term) => jdText.slice(term.start, term.end)), ['Python']);
  assert.doesNotThrow(() => createPacketAudit({
    ownerId: 'owner-kos',
    applicationId: 'application-kos',
    jdText,
    spec,
    jobContext: { company: 'kos.ai', role: 'Software Engineer Intern' },
    questions: [],
    applicantSnapshot: review.applicant_snapshot,
    resumeEmail: 'student@example.edu',
    applicantEmail: 'app-kos@apply.trylitos.com',
    pdfObjectKey: 'users/owner-kos/resumes/application-kos.pdf',
    pdfBytes: Buffer.from('%PDF-1.7\nkos packet'),
    editedTerms: scored.editedTerms,
    clauses: scored.clauses,
    rejected: scored.rejected,
    degraded: scored.degraded,
    terms: scored.terms,
  }));
  for (const clause of scored.clauses) {
    assert.equal(clause.text, jdText.slice(clause.start, clause.end));
    assert.doesNotMatch(clause.text, /Comp and Benefits|Relocation benefits/);
  }

  const falseEnrollment = await scoreAuditEvidence(
    { spec, job_context: { company: 'kos.ai', role: 'Software Engineer Intern' } } as never,
    { ...review, applicant_snapshot: { profile: { currently_enrolled: false }, application_profile: {} } } as never,
  );
  assert.equal(falseEnrollment.clauses.find((clause) => clause.text.startsWith('Current CS or ML'))?.verdict, 'missing');
  const unknownEnrollment = await scoreAuditEvidence(
    { spec, job_context: { company: 'kos.ai', role: 'Software Engineer Intern' } } as never,
    { ...review, applicant_snapshot: { profile: {}, application_profile: {} } } as never,
  );
  assert.equal(unknownEnrollment.clauses.find((clause) => clause.text.startsWith('Current CS or ML'))?.verdict, 'unscoreable');
  assert.equal(unknownEnrollment.degraded, false);

  const resumeLocationCannotAuthorizeOnsite = await scoreAuditEvidence(
    {
      spec: {
        ...spec,
        experience: [{ ...spec.experience[0], location: 'San Francisco, CA' }],
        skills: [...spec.skills, 'SF'],
      },
      job_context: { company: 'kos.ai', role: 'Software Engineer Intern', location: 'San Francisco' },
    } as never,
    {
      ...review,
      applicant_snapshot: {
        profile: { currently_enrolled: true },
        application_profile: {},
      },
    } as never,
  );
  assert.equal(
    resumeLocationCannotAuthorizeOnsite.clauses.find((clause) => clause.text.startsWith("You're comfortable working in-person"))?.verdict,
    'unscoreable',
  );
  assert.equal(resumeLocationCannotAuthorizeOnsite.degraded, false);

  const wrongOnsiteCity = await scoreAuditEvidence(
    { spec, job_context: { company: 'kos.ai', role: 'Software Engineer Intern', location: 'San Francisco' } } as never,
    {
      ...review,
      applicant_snapshot: {
        profile: { currently_enrolled: true },
        application_profile: { onsite_commitment: 'listed_locations', onsite_locations: ['Los Angeles'] },
      },
    } as never,
  );
  assert.equal(
    wrongOnsiteCity.clauses.find((clause) => clause.text.startsWith("You're comfortable working in-person"))?.verdict,
    'missing',
  );

  const skillOnly = await scoreAuditEvidence(
    { spec: { ...spec, skills: ['LLMs'], experience: [] }, job_context: { company: 'kos.ai', role: 'Software Engineer Intern' } } as never,
    review as never,
  );
  assert.notEqual(skillOnly.clauses.find((clause) => clause.text.startsWith("You've played with LLMs"))?.verdict, 'covered');
});

test('a met clause without one exact frozen evidence pointer is unscoreable but does not degrade packet integrity', async () => {
  const jdText = 'Requirements\nExperience with Machine Learning.';
  const spec = {
    target_role: '', school: '', degree: '', grad_date: '', gpa: '', school_location: '', coursework: '',
    experience: [], skills: ['Machine', 'Learning'], _review: {},
  };
  const scored = await scoreAuditEvidence(
    { spec, job_context: { role: 'Engineer' } } as never,
    { jd_text: jdText, questions: [], edited_terms: [], status: 'ready_to_submit' } as never,
  );
  assert.equal(scored.clauses[0]?.verdict, 'unscoreable');
  assert.equal(scored.clauses[0]?.evidence, undefined);
  assert.equal(scored.degraded, false);
  assert.doesNotThrow(() => createPacketAudit({
    ownerId: 'owner-ungrounded-fit',
    applicationId: 'application-ungrounded-fit',
    jdText,
    spec,
    jobContext: { company: 'Example', role: 'Engineer' },
    questions: [],
    applicantSnapshot: null,
    resumeEmail: 'student@example.edu',
    applicantEmail: 'app-ungrounded@apply.trylitos.com',
    pdfObjectKey: 'users/owner-ungrounded-fit/resumes/application.pdf',
    pdfBytes: Buffer.from('%PDF-1.7\nungrounded fit packet'),
    editedTerms: scored.editedTerms,
    clauses: scored.clauses,
    rejected: scored.rejected,
    degraded: scored.degraded,
    terms: scored.terms,
  }));
});

test('Remote Recruitment negated degree and AI term gaps stay visible without blocking exact packet audit', async () => {
  const noDegree = 'You do not need a perfect CV or a university degree. Attitude, work ethic, commercial awareness, coachability, and resilience are more important than traditional qualifications.';
  const aiFeedback = 'The successful candidate will receive regular performance feedback and coaching, with AI technology used to analyse calls and support ongoing development.';
  const jdText = ['Requirements', noDegree, aiFeedback].join('\n');
  const spec = {
    target_role: 'Sales Setter / Executive',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    grad_date: 'May 2028',
    gpa: '3.89/4.0',
    school_location: 'Los Angeles, CA',
    coursework: 'Data Structures & Algorithms',
    skills: [],
    experience: [{
      type: 'job' as const,
      org: 'Tonee - AI Texting Tone Detector',
      title: 'Founder',
      location: 'Remote',
      date_range: 'September 2025 - Present',
      bullets: ['Shipped a consumer mobile app and improved product performance from user feedback.'],
    }],
    _review: {},
  };
  const scored = await scoreAuditEvidence(
    { spec, job_context: { company: 'Remote Recruitment', role: 'Sales Setter / Executive' } } as never,
    { jd_text: jdText, questions: [], edited_terms: [], status: 'ready_to_submit' } as never,
  );

  assert.deepEqual(scored.clauses.map((clause) => ({ text: clause.text, verdict: clause.verdict })), [
    { text: noDegree, verdict: 'unscoreable' },
    { text: aiFeedback, verdict: 'unscoreable' },
  ]);
  assert.equal(scored.clauses.every((clause) => clause.evidence === undefined), true);
  assert.equal(scored.degraded, false);
  assert.deepEqual(scored.judgementWarnings, []);
  assert.doesNotThrow(() => createPacketAudit({
    ownerId: 'owner-remote-recruitment',
    applicationId: 'application-remote-recruitment',
    jdText,
    spec,
    jobContext: { company: 'Remote Recruitment', role: 'Sales Setter / Executive' },
    questions: [],
    applicantSnapshot: null,
    resumeEmail: 'student@example.edu',
    applicantEmail: 'app-remote-recruitment@apply.trylitos.com',
    pdfObjectKey: 'users/owner-remote-recruitment/resumes/application.pdf',
    pdfBytes: Buffer.from('%PDF-1.7\nRemote Recruitment packet'),
    editedTerms: scored.editedTerms,
    clauses: scored.clauses,
    rejected: scored.rejected,
    degraded: scored.degraded,
    terms: scored.terms,
  }));
});

test('CTGT Summer 2027 duration remains exact and unscoreable without scoped availability facts', async () => {
  const jdText = [
    'Requirements',
    'Full-time, in person in San Francisco',
    '10 to 12 weeks between May/June and August/September 2027',
    'We sponsor US visas',
  ].join('\n');
  const spec = {
    target_role: 'Software Engineer Intern',
    school: 'USC',
    degree: 'Bachelor of Science in Computer Science',
    grad_date: 'May 2028',
    gpa: '', school_location: '', coursework: '', skills: ['Python'], experience: [], _review: {},
  };
  const scored = await scoreAuditEvidence(
    {
      spec,
      job_context: { company: 'CTGT', role: 'Software Engineer Intern', location: 'San Francisco' },
    } as never,
    {
      jd_text: jdText,
      questions: [], edited_terms: [], status: 'ready_to_submit',
      applicant_snapshot: {
        profile: { currently_enrolled: true },
        application_profile: { onsite_commitment: 'anywhere' },
      },
    } as never,
  );
  const availability = scored.clauses.find((clause) => clause.text.startsWith('10 to 12 weeks'));
  const onsite = scored.clauses.find((clause) => clause.text.startsWith('Full-time, in person'));
  assert.equal(onsite?.verdict, 'unscoreable');
  assert.equal(onsite?.text, jdText.slice(onsite.start, onsite.end));
  assert.equal(availability?.verdict, 'unscoreable');
  assert.equal(availability?.text, jdText.slice(availability.start, availability.end));
  assert.equal(scored.degraded, false);
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

/* ---- packet_version binds what the employer receives, not who typed it ----
 *
 * THE LIVE DEADLOCK, application fc6eade3 on 2026-08-12, reproduced.
 *
 * She edited her answers on the review screen. applyApplicationReviewEdit stamps answer_source and
 * answer_reviewed_at onto every answered question, the audit hashed them into packet_version, and
 * she acknowledged that version. Then the send gate rebuilt the same questions through
 * refreshKnownQuestionAnswers, which dropped that provenance from the two EEO questions whose values
 * recomputed to exactly themselves - "Female" and "South Asian", byte for byte - and hashed the
 * result. Two records that differed by nothing the employer would ever see produced a different
 * packet_version, verifyCurrentPacketAudit answered packet_stale, and the dashboard printed it.
 *
 * The audit could not clear it. That route rebuilds from the stored questions WITH provenance while
 * the send gate recomputes WITHOUT it, so re-auditing converged on the audit's own hash, forever.
 * Audit, reload, re-audit, fill: same refusal every time, on a packet nothing had touched.
 */
const provenanceRow = (questions: unknown[], packetAudit: unknown, acknowledgement?: unknown) => {
  const pdfBytes = Buffer.from('%PDF-1.7\npacket');
  const spec = {
    target_role: 'Engineer',
    school: '', degree: '', grad_date: '', gpa: '', school_location: '', coursework: '',
    experience: [], skills: [],
    _contact: { email: 'student@example.com' },
    _applicant_email: {
      address: 'app-owner@apply.trylitos.com', source: 'litos_alias', reason: 'deliverable', tracked: true,
      decided_at: '2026-08-11T00:00:00.000Z',
    },
    _application_email: {
      alias: 'app-owner@apply.trylitos.com', forwards_to: 'student@example.com', mode: 'litos_application_alias',
    },
    _review: {
      jd_text: 'Build reliable systems.',
      questions,
      questions_reviewed_at: '2026-08-12T13:45:27.969Z',
      status: 'questions_ready',
      applicant_email: {
        address: 'app-owner@apply.trylitos.com', source: 'litos_alias', reason: 'deliverable', tracked: true,
        decided_at: '2026-08-11T00:00:00.000Z',
      },
      applicant_snapshot: {
        profile: { email: 'app-owner@apply.trylitos.com', experience: [], skills: [], school: '', grad_year: 0 },
        application_profile: {},
      },
      packet_audit: packetAudit,
      ...(acknowledgement ? { packet_audit_acknowledgement: acknowledgement } : {}),
    },
  };
  return {
    id: 'application-1',
    user_id: 'owner-1',
    resume_object_key: 'users/owner-1/resumes/application-1.pdf',
    job_context: { company: 'Acme', role: 'Engineer' },
    spec: {
      ...spec,
      _quality: {
        pdfGenerationBinding: createPdfGenerationBinding(
          spec, 'users/owner-1/resumes/application-1.pdf', pdfBytes, 'student@example.com',
        ),
      },
    },
  };
};

/** The answers exactly as the applicant left them, carrying the record of her having left them. */
const reviewedQuestions = [
  {
    id: 'q-gender',
    question: 'what is your gender/gender identity?',
    answer: 'Female',
    kind: 'required' as const,
    required: false,
    portal_selector: '#gender',
    answer_source: 'applicant_review' as const,
    answer_reviewed_at: '2026-08-12T13:45:27.969Z',
  },
  {
    id: 'q-race',
    question: 'what is your race/ethnicity?',
    answer: 'South Asian',
    kind: 'required' as const,
    required: false,
    portal_selector: '#race',
    answer_source: 'applicant_review' as const,
    answer_reviewed_at: '2026-08-12T13:45:27.969Z',
  },
];

/** The same answers as the send gate rebuilds them: identical values, provenance dropped. */
const sendGateQuestions = reviewedQuestions.map(
  ({ answer_source: _source, answer_reviewed_at: _reviewedAt, ...rest }) => rest,
);

const packetPdfBytes = Buffer.from('%PDF-1.7\npacket');
const loadPacketPdf = async () => ({ bytes: packetPdfBytes, contentType: 'application/pdf' });
const skipEmailCheck = async () => {};

const auditOverQuestions = (questions: unknown[]) => {
  const row = provenanceRow(questions, undefined);
  return createPacketAudit({
    ownerId: row.user_id,
    applicationId: row.id,
    jdText: 'Build reliable systems.',
    spec: row.spec,
    jobContext: row.job_context,
    questions,
    applicantSnapshot: row.spec._review.applicant_snapshot,
    resumeEmail: 'student@example.com',
    applicantEmail: 'app-owner@apply.trylitos.com',
    pdfObjectKey: row.resume_object_key,
    pdfBytes: packetPdfBytes,
    editedTerms: [],
    rejected: [],
    degraded: false,
    clauses: [{ text: 'Build reliable systems.', start: 0, end: 23, verdict: 'missing' as const }],
    terms: { covered: [], missing: [], edited: [] },
  });
};

const acknowledgementOf = (audit: ReturnType<typeof createPacketAudit>) => ({
  ownerSha256: audit.bindings.ownerSha256,
  applicationId: audit.bindings.applicationId,
  audit_digest: audit.audit_digest,
  packet_version: audit.packet_version,
  pdfSha256: audit.bindings.pdf.sha256,
  pdfSizeBytes: audit.bindings.pdf.sizeBytes,
  acknowledged_at: '2026-08-12T13:45:59.101Z',
});

test('a packet she reviewed still sends after the gate rebuilds its questions without provenance', async () => {
  // Built from the questions AS STORED, provenance and all, exactly as createAndPersistPacketAudit
  // builds it from review.questions. packetBindings is what narrows them.
  const audit = auditOverQuestions(reviewedQuestions);
  const row = provenanceRow(reviewedQuestions, audit, acknowledgementOf(audit));

  const auditSide = await currentAcknowledgedPacketAudit(row as never, {
    loadPdf: loadPacketPdf, validateApplicantEmail: skipEmailCheck,
  });
  assert.equal(
    auditSide.valid ? 'valid' : auditSide.reason,
    'valid',
    'the audit route must find the packet she acknowledged current',
  );

  // The send gate substitutes its own rebuilt list, exactly as POST /submit-request does.
  const sendSide = await currentAcknowledgedPacketAudit(row as never, {
    questions: sendGateQuestions as never,
    loadPdf: loadPacketPdf, validateApplicantEmail: skipEmailCheck,
  });
  assert.equal(
    sendSide.valid ? 'valid' : sendSide.reason,
    'valid',
    'the send gate must agree: dropping answer_source changes nothing the employer receives',
  );
  assert.equal(
    auditSide.valid && sendSide.valid && auditSide.audit.packet_version === sendSide.audit.packet_version,
    true,
    'both sides must resolve the same packet_version',
  );
});

test('the send gate still refuses when an answer itself changed', async () => {
  const audit = auditOverQuestions(reviewedQuestions);
  const row = provenanceRow(reviewedQuestions, audit, acknowledgementOf(audit));

  const edited = sendGateQuestions.map((question) => (question.id === 'q-gender'
    ? { ...question, answer: 'Decline to self-identify' }
    : question));
  const verdict = await currentAcknowledgedPacketAudit(row as never, {
    questions: edited as never,
    loadPdf: loadPacketPdf, validateApplicantEmail: skipEmailCheck,
  });

  assert.equal(verdict.valid, false, 'a different value reaches the employer, so the approval is spent');
  assert.deepEqual(verdict.valid ? null : verdict.code, 'PACKET_AUDIT_STALE');
  assert.deepEqual(verdict.valid ? null : verdict.reason, 'packet_stale');
});

test('the acknowledgement is still spent by a question appearing, disappearing or being relabelled', async () => {
  const audit = auditOverQuestions(reviewedQuestions);
  const row = provenanceRow(reviewedQuestions, audit, acknowledgementOf(audit));
  const run = async (questions: unknown[]) => currentAcknowledgedPacketAudit(row as never, {
    questions: questions as never, loadPdf: loadPacketPdf, validateApplicantEmail: skipEmailCheck,
  });

  const added = await run([...sendGateQuestions, {
    id: 'q-veteran', question: 'veteran status', answer: 'Decline', kind: 'required' as const, required: false,
  }]);
  assert.equal(added.valid, false, 'a question the employer asks that she never saw invalidates');

  const removed = await run([sendGateQuestions[0]]);
  assert.equal(removed.valid, false, 'a question dropped from the packet invalidates');

  const relabelled = await run(sendGateQuestions.map((question) => (question.id === 'q-race'
    ? { ...question, question: 'what is your ethnicity?' }
    : question)));
  assert.equal(relabelled.valid, false, 'the label the answer sits under is part of what she approved');

  const rerouted = await run(sendGateQuestions.map((question) => (question.id === 'q-race'
    ? { ...question, portal_selector: '#ethnicity' }
    : question)));
  assert.equal(rerouted.valid, false, 'the control an answer is typed into is part of the packet');
});

/* THE SECOND DOOR, and the reason the narrowed hash had to be the load-bearing fix.
 *
 * mergeSubmittedApplicationReviewQuestions strips answer_source and answer_reviewed_at whenever the
 * submitted record is not identical to the stored one - including the no-match branch, which fires
 * for any stored question the review screen did not post back. The review screen is separately known
 * to serve raw values where the packet holds resolved ones, so this door opens without
 * refreshKnownQuestionAnswers being involved at all. Keeping provenance out of packet_version closes
 * it too, rather than closing one door and leaving the other for the next session to rediscover. */
test('provenance stripped by the submitted-answer merge does not spend the acknowledgement', async () => {
  const audit = auditOverQuestions(reviewedQuestions);
  const row = provenanceRow(reviewedQuestions, audit, acknowledgementOf(audit));

  const merged = mergeSubmittedApplicationReviewQuestions(
    reviewedQuestions,
    // Posted back under a re-issued id, so the exact-reviewed-identity test fails and provenance is
    // dropped even though every answer is unchanged.
    sendGateQuestions.map((question) => ({ ...question, id: `${question.id}-reissued` })),
    '2026-08-12T13:45:27.969Z',
  );
  assert.equal(merged.some((question) => question.answer_source !== undefined), false,
    'the merge did strip the provenance, which is the precondition this test exists for');

  const verdict = await currentAcknowledgedPacketAudit(row as never, {
    questions: merged as never, loadPdf: loadPacketPdf, validateApplicantEmail: skipEmailCheck,
  });
  assert.equal(
    verdict.valid ? 'valid' : verdict.reason,
    'valid',
    'the merge door produces the same packet, so it must not produce packet_stale either',
  );
});

/* On 2026-08-19 the dashboard printed the bare word `packet_stale` in a red banner to a student
   watching the autopilot row, because the route replied `{ error: verdict.reason }` and that reason
   is a developer token. These pin the boundary, not the wording. */
test('a failed verdict never replies with a developer token', () => {
  for (const reason of ['packet_stale', 'owner_mismatch', 'application_mismatch', 'packet_audit_invalid']) {
    const { error, code } = packetAuditClientError(tokenisedPacketAuditFailure('PACKET_AUDIT_STALE', reason));
    assert.equal(code, 'PACKET_AUDIT_STALE', 'the machine-readable half stays machine-readable');
    assert.ok(!error.includes(reason), `${reason} reached the applicant verbatim`);
    assert.ok(/^[A-Z].*\.$/u.test(error), `${reason} produced something that is not a sentence: ${error}`);
  }
});

test('a reason bindingIssues wrote is not passed through either', () => {
  // "jdText is required" has spaces and reads like English, which is exactly why the boundary
  // cannot decide by looking at the string.
  const { error } = packetAuditClientError(tokenisedPacketAuditFailure('PACKET_AUDIT_STALE', 'jdText is required'));
  assert.ok(!error.includes('jdText'), 'an internal field name reached the applicant');
  assert.ok(/^[A-Z].*\.$/u.test(error));
});

test('prose this file authored on purpose is kept, because it names the recovery', () => {
  const authored = 'Audit this exact packet before submitting.';
  const { error } = packetAuditClientError({ valid: false, code: 'PACKET_AUDIT_REQUIRED', reason: authored });
  assert.equal(error, authored);
});

test('the token survives for the logs even though it is never replied', () => {
  const failure = tokenisedPacketAuditFailure('PACKET_AUDIT_STALE', 'packet_stale');
  assert.equal(failure.reason, 'packet_stale', 'the suite above pins this token and it must not move');
});
