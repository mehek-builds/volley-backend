import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResumeSpec } from '../llm/resumeSpec';
import {
  canonicalizePacketAuditTerms,
  canonicalPacketJson,
  createPacketAudit,
  createResumeEvidencePointer,
  packetAuditIsSubmissionReady,
  packetAuditSha256,
  applicantSnapshotSha256,
  applicantSnapshotBindingValue,
  PacketAuditValidationError,
  type CreatePacketAuditInput,
  type PacketAudit,
  type PacketAuditClauseInput,
  type PacketAuditTermInput,
  verifyStoredPacketAuditAcknowledgement,
  verifyCurrentPacketAudit,
} from './packetAudit';

const JD = [
  'Requirements:',
  'Bachelor of Science in Computer Science.',
  'Build TypeScript services for operations teams.',
  'Improve the deployment pipeline and release checks.',
  'Experience with Rust in production.',
  'Stay curious and support the team.',
].join('\n');

const spec: ResumeSpec = {
  target_role: 'Software Engineer',
  school: 'Example University',
  degree: 'Bachelor of Science in Computer Science',
  grad_date: '2026',
  coursework: 'Distributed Systems',
  education_position: 'top',
  experience: [{
    type: 'job',
    org: 'Northwind Labs',
    title: 'Software Engineer',
    date_range: '2024 - Present',
    bullets: [
      'Built TypeScript services for operations teams and reduced response time by 30 percent',
      'Improved the deployment pipeline and release checks across three environments',
    ],
  }],
  skills: ['TypeScript', 'PostgreSQL'],
};

function exactRange(text: string): { text: string; start: number; end: number } {
  const start = JD.indexOf(text);
  assert.notEqual(start, -1, `missing JD fixture text: ${text}`);
  return { text, start, end: start + text.length };
}

const degreeClause = exactRange('Bachelor of Science in Computer Science.');
const typescriptClause = exactRange('Build TypeScript services for operations teams.');
const editedClause = exactRange('Improve the deployment pipeline and release checks.');
const missingClause = exactRange('Experience with Rust in production.');
const unscoreableClause = exactRange('Stay curious and support the team.');

function term(text: string, evidence?: ReturnType<typeof createResumeEvidencePointer>): PacketAuditTermInput {
  const range = exactRange(text);
  return { start: range.start, end: range.end, ...(evidence ? { evidence } : {}) };
}

function validInput(): CreatePacketAuditInput {
  const degreeEvidence = createResumeEvidencePointer(spec, '/degree');
  const typescriptEvidence = createResumeEvidencePointer(spec, '/experience/0/bullets/0');
  const editedEvidence = createResumeEvidencePointer(spec, '/experience/0/bullets/1');
  const clauses: PacketAuditClauseInput[] = [
    { ...degreeClause, verdict: 'covered', evidence: [degreeEvidence] },
    { ...typescriptClause, verdict: 'covered', evidence: [typescriptEvidence] },
    { ...editedClause, verdict: 'covered', evidence: [editedEvidence] },
    { ...missingClause, verdict: 'missing' },
    { ...unscoreableClause, verdict: 'unscoreable' },
  ];
  return {
    ownerId: 'owner-1',
    applicationId: 'application-1',
    jdText: JD,
    spec: structuredClone(spec),
    jobContext: { company: 'Northwind Labs', role: 'Software Engineer', job_id: 'job-1' },
    questions: [
      { id: 'q1', question: 'Are you authorized to work?', answer: 'Yes', required: true },
    ],
    applicantSnapshot: {
      profile: { currently_enrolled: true, email: 'app-application-1@apply.trylitos.com' },
    },
    resumeEmail: 'student@usc.edu',
    applicantEmail: 'app-application-1@apply.trylitos.com',
    employerDelivery: {
      version: 'employer_delivery_v1',
      mode: 'browser',
      sha256: '1'.repeat(64),
    },
    pdfObjectKey: 'users/owner-1/resumes/application-1.pdf',
    pdfBytes: Buffer.from('%PDF-1.7 exact packet bytes'),
    editedTerms: ['deployment pipeline'],
    clauses,
    rejected: [],
    degraded: false,
    terms: {
      covered: [term('TypeScript', typescriptEvidence)],
      missing: [term('Rust')],
      edited: [term('deployment pipeline', editedEvidence)],
    },
  };
}

function currentInput(input: CreatePacketAuditInput, audit: PacketAudit) {
  return {
    ownerId: input.ownerId,
    applicationId: input.applicationId,
    jdText: input.jdText,
    spec: input.spec,
    jobContext: input.jobContext,
    questions: input.questions,
    applicantSnapshot: input.applicantSnapshot,
    resumeEmail: input.resumeEmail,
    applicantEmail: input.applicantEmail,
    employerDelivery: input.employerDelivery,
    pdfObjectKey: input.pdfObjectKey,
    pdfBytes: input.pdfBytes,
    audit,
  };
}

test('stored acknowledgement is a pure four-digest check and refuses every identity mismatch', () => {
  const input = validInput();
  const audit = createPacketAudit(input);
  const client = {
    audit_digest: audit.audit_digest,
    packet_version: audit.packet_version,
    pdf_sha256: audit.bindings.pdf.sha256,
    size_bytes: audit.bindings.pdf.sizeBytes,
  };
  const verify = (overrides: Partial<Parameters<typeof verifyStoredPacketAuditAcknowledgement>[0]> = {}) => (
    verifyStoredPacketAuditAcknowledgement({
      audit,
      ownerId: input.ownerId,
      applicationId: input.applicationId,
      client,
      ...overrides,
    })
  );

  assert.deepEqual(verify(), { valid: true, audit });
  assert.deepEqual(verify({ ownerId: 'other-owner' }), { valid: false, reason: 'packet_audit_stale' });
  assert.deepEqual(verify({ applicationId: 'other-application' }), { valid: false, reason: 'packet_audit_stale' });
  const missingDelivery = structuredClone(audit);
  delete missingDelivery.bindings.employerDelivery;
  const { packet_version: _packetVersion, audit_digest: _auditDigest, ...unsignedMissingDelivery } = missingDelivery;
  missingDelivery.packet_version = packetAuditSha256({
    version: missingDelivery.version,
    bindings: missingDelivery.bindings,
  });
  missingDelivery.audit_digest = packetAuditSha256({ ...unsignedMissingDelivery, packet_version: missingDelivery.packet_version });
  assert.deepEqual(verify({ audit: missingDelivery }), { valid: false, reason: 'packet_audit_stale' });

  for (const key of Object.keys(client) as Array<keyof typeof client>) {
    const changed = { ...client, [key]: key === 'size_bytes' ? client.size_bytes + 1 : '0'.repeat(64) };
    assert.deepEqual(
      verify({ client: changed }),
      { valid: false, reason: 'client_packet_mismatch' },
      key,
    );
  }
});

function expectInvalid(mutator: (input: CreatePacketAuditInput) => void, pattern: RegExp): void {
  const input = validInput();
  mutator(input);
  assert.throws(
    () => createPacketAudit(input),
    (error: unknown) => error instanceof PacketAuditValidationError && pattern.test(error.message),
  );
}

test('canonical JSON sorts object keys recursively and produces a stable SHA-256', () => {
  assert.equal(
    canonicalPacketJson({ z: 1, a: { y: 2, x: [3, { b: true, a: null }] } }),
    '{"a":{"x":[3,{"a":null,"b":true}],"y":2},"z":1}',
  );
  assert.equal(packetAuditSha256({ b: 2, a: 1 }), packetAuditSha256({ a: 1, b: 2 }));
  assert.throws(() => canonicalPacketJson({ bad: Number.NaN }), /non-finite number/);
});

test('creates a submission-ready v2 audit with exact PDF, clause, evidence, and term bindings', () => {
  const input = validInput();
  const audit = createPacketAudit(input);
  assert.equal(packetAuditIsSubmissionReady(audit), true);
  assert.match(audit.packet_version, /^[a-f0-9]{64}$/);
  assert.match(audit.audit_digest, /^[a-f0-9]{64}$/);
  assert.equal(audit.bindings.pdf.objectKey, input.pdfObjectKey);
  assert.equal(audit.bindings.pdf.sizeBytes, input.pdfBytes.byteLength);
  assert.equal(audit.bindings.pdf.sha256, 'f427991ed38bbafc94161f8669af085c87796ec9bf2f139187cf3c35b11dd72d');
  assert.equal(audit.clauses[0].text, degreeClause.text);
  assert.equal(audit.terms.covered[0].text, 'TypeScript');
  assert.equal(audit.terms.missing[0].text, 'Rust');
  assert.equal(audit.terms.edited[0].key, 'deployment pipeline');
  assert.deepEqual(
    audit.clauses.flatMap((clause) => clause.highlight_terms.map((highlight) => highlight.tone)),
    ['covered', 'edited', 'missing'],
  );
  assert.equal(audit.clauses.find((clause) => clause.text === editedClause.text)?.highlight_terms[0].text, 'deployment pipeline');
  assert.equal(Object.prototype.hasOwnProperty.call(audit.bindings, 'ownerId'), false);
  assert.equal(audit.bindings.ownerSha256, '391887cbcf922e19d672df700739c4a3c74e35ee3d57e7ad97506cd331cd953c');
  assert.deepEqual(verifyCurrentPacketAudit(currentInput(input, audit)), {
    valid: true,
    reason: 'valid',
    packetVersion: audit.packet_version,
  });
});

test('an explicit unmet gap and an inherent unscoreable clause are complete, not degraded', () => {
  const audit = createPacketAudit(validInput());
  assert.equal(audit.clauses.find((clause) => clause.verdict === 'missing')?.evidence, undefined);
  assert.equal(audit.clauses.find((clause) => clause.verdict === 'unscoreable')?.evidence, undefined);
  assert.equal(packetAuditIsSubmissionReady(audit), true);
});

test('complete clause evidence can be ready with no token highlights', () => {
  const input = validInput();
  input.editedTerms = [];
  input.terms = { covered: [], missing: [], edited: [] };
  const audit = createPacketAudit(input);
  assert.deepEqual(audit.terms, { covered: [], missing: [], edited: [] });
  assert.equal(packetAuditIsSubmissionReady(audit), true);
});

test('canonical highlight selection resolves duplicate, nested, and partial overlaps without changing offsets', () => {
  const evidence = createResumeEvidencePointer(spec, '/experience/0/bullets/0');
  const input = {
    missing: [
      { start: 20, end: 30 },
      { start: 20, end: 30 },
      { start: 22, end: 28 },
      { start: 40, end: 48 },
      { start: 44, end: 52 },
    ],
    covered: [
      { start: 60, end: 72, evidence },
      { start: 62, end: 70, evidence },
      { start: 80, end: 88, evidence },
    ],
    edited: [
      { start: 80, end: 88, evidence },
      { start: 100, end: 108, evidence },
    ],
  };
  const selected = canonicalizePacketAuditTerms(input, 200);
  assert.deepEqual(selected.missing, [
    { start: 20, end: 30 },
    { start: 40, end: 48 },
  ]);
  assert.deepEqual(selected.covered, [{ start: 60, end: 72, evidence }]);
  assert.deepEqual(selected.edited, [
    { start: 80, end: 88, evidence },
    { start: 100, end: 108, evidence },
  ]);
  const selectedRanges = Object.values(selected).flat();
  for (const [index, range] of selectedRanges.entries()) {
    assert.equal(input.missing.includes(range as { start: number; end: number })
      || input.covered.includes(range as { start: number; end: number; evidence: typeof evidence })
      || input.edited.includes(range as { start: number; end: number; evidence: typeof evidence }), true);
    for (const other of selectedRanges.slice(index + 1)) {
      assert.equal(range.start < other.end && other.start < range.end, false);
    }
  }
});

test('canonical highlight selection prefers conservative and edited tones while retaining exact evidence', () => {
  const coveredEvidence = createResumeEvidencePointer(spec, '/experience/0/bullets/0');
  const editedEvidence = createResumeEvidencePointer(spec, '/experience/0/bullets/1');
  const selected = canonicalizePacketAuditTerms({
    missing: [{ start: 10, end: 24 }],
    covered: [
      { start: 12, end: 20, evidence: coveredEvidence },
      { start: 40, end: 50, evidence: coveredEvidence },
    ],
    edited: [{ start: 40, end: 50, evidence: editedEvidence }],
  }, 100);
  assert.deepEqual(selected.missing, [{ start: 10, end: 24 }]);
  assert.deepEqual(selected.covered, []);
  assert.deepEqual(selected.edited, [{ start: 40, end: 50, evidence: editedEvidence }]);
});

test('canonical highlight selection preserves malformed offsets for fail-closed validation', () => {
  const invalid = { start: -1, end: 4 };
  assert.deepEqual(canonicalizePacketAuditTerms({
    covered: [],
    missing: [invalid],
    edited: [],
  }, JD.length).missing, [invalid]);
});

test('canonical highlight selection resolves the production-shaped Law overlap and preserves adjacent terms', () => {
  const forward = {
    covered: [],
    missing: [
      { start: 4023, end: 4026 },
      { start: 4023, end: 4038 },
      { start: 4038, end: 4045 },
      { start: 4040, end: 4047 },
    ],
    edited: [],
  };
  const reversed = { ...forward, missing: [...forward.missing].reverse() };
  const selected = canonicalizePacketAuditTerms(forward, 5000);
  const selectedFromReversed = canonicalizePacketAuditTerms(reversed, 5000);
  assert.deepEqual(selected.missing, [
    { start: 4023, end: 4038 },
    { start: 4038, end: 4045 },
  ]);
  assert.deepEqual(selectedFromReversed, selected);
  assert.equal(packetAuditSha256(selectedFromReversed), packetAuditSha256(selected));
});

test('canonical duplicate evidence selection is stable across input permutations', () => {
  const firstEvidence = createResumeEvidencePointer(spec, '/experience/0/bullets/0');
  const secondEvidence = createResumeEvidencePointer(spec, '/experience/0/bullets/1');
  const forward = {
    covered: [
      { start: 60, end: 70, evidence: firstEvidence },
      { start: 60, end: 70, evidence: secondEvidence },
    ],
    missing: [],
    edited: [],
  };
  const reversed = { ...forward, covered: [...forward.covered].reverse() };
  const selected = canonicalizePacketAuditTerms(forward, 100);
  const selectedFromReversed = canonicalizePacketAuditTerms(reversed, 100);
  assert.equal(selected.covered.length, 1);
  assert.deepEqual(selectedFromReversed, selected);
  assert.equal(packetAuditSha256(selectedFromReversed), packetAuditSha256(selected));
});

test('canonical duplicate selection is locale-independent for non-ASCII evidence', () => {
  const first = {
    start: 60,
    end: 70,
    evidence: { source: 'resume_spec' as const, path: '/first', quote: 'Évidence', sha256: '1'.repeat(64) },
  };
  const second = {
    start: 60,
    end: 70,
    evidence: { source: 'resume_spec' as const, path: '/second', quote: 'Åvidence', sha256: '2'.repeat(64) },
  };
  const selected = canonicalizePacketAuditTerms({ covered: [first, second], missing: [], edited: [] }, 100);
  const reversed = canonicalizePacketAuditTerms({ covered: [second, first], missing: [], edited: [] }, 100);
  assert.deepEqual(reversed, selected);
  assert.equal(packetAuditSha256(reversed), packetAuditSha256(selected));
});

test('raw overlapping highlights remain invalid while canonical service input is accepted', () => {
  const input = validInput();
  const rust = exactRange('Rust');
  input.terms.missing = [
    { start: rust.start, end: rust.end },
    { start: rust.start, end: rust.end },
  ];
  assert.throws(
    () => createPacketAudit(input),
    (error: unknown) => error instanceof PacketAuditValidationError && /overlaps/u.test(error.message),
  );
  input.terms = canonicalizePacketAuditTerms(input.terms, input.jdText.length);
  const audit = createPacketAudit(input);
  assert.deepEqual(audit.terms.missing.map(({ start, end }) => ({ start, end })), [
    { start: rust.start, end: rust.end },
  ]);
  assert.equal(audit.clauses.length, input.clauses.length);
  assert.equal(audit.clauses.find((clause) => clause.text === missingClause.text)?.verdict, 'missing');
});

test('attaching the audit under spec._review does not invalidate its own canonical spec binding', () => {
  const input = validInput();
  const audit = createPacketAudit(input);
  const persistedSpec = {
    ...(input.spec as Record<string, unknown>),
    _review: {
      packet_audit: audit,
      status: 'ready_for_final_approval',
      updated_at: '2026-08-10T18:00:00.000Z',
      submission_claimed_at: '2026-08-10T18:01:00.000Z',
    },
  };
  const verified = verifyCurrentPacketAudit({ ...currentInput(input, audit), spec: persistedSpec });
  assert.equal(verified.valid, true);
  assert.equal(verified.packetVersion, audit.packet_version);
});

test('the current-packet verifier rejects stale owner and application identity', () => {
  const input = validInput();
  const audit = createPacketAudit(input);
  assert.equal(verifyCurrentPacketAudit({ ...currentInput(input, audit), ownerId: 'owner-2' }).reason, 'owner_mismatch');
  assert.equal(verifyCurrentPacketAudit({ ...currentInput(input, audit), applicationId: 'application-2' }).reason, 'application_mismatch');
});

test('the current-packet verifier rejects stale JD, spec, job, answers, applicant facts, and PDF bindings', () => {
  const input = validInput();
  const audit = createPacketAudit(input);
  const base = currentInput(input, audit);
  const changedSpec = structuredClone(spec);
  changedSpec.experience[0].bullets[0] = 'Built Go services for operations teams and reduced response time by 30 percent';
  const cases = [
    { expected: 'jd', input: { ...base, jdText: `${JD}\nAnother requirement.` } },
    { expected: 'spec', input: { ...base, spec: changedSpec } },
    { expected: 'job_context', input: { ...base, jobContext: { company: 'Other Company', role: 'Software Engineer', job_id: 'job-1' } } },
    { expected: 'questions', input: { ...base, questions: [{ id: 'q1', question: 'Are you authorized to work?', answer: 'No', required: true }] } },
    { expected: 'applicant_snapshot', input: { ...base, applicantSnapshot: { profile: { currently_enrolled: false } } } },
    { expected: 'resume_email', input: { ...base, resumeEmail: 'changed@usc.edu' } },
    { expected: 'applicant_email', input: { ...base, applicantEmail: 'app-changed@apply.trylitos.com' } },
    { expected: 'employer_delivery', input: {
      ...base,
      employerDelivery: { ...base.employerDelivery!, sha256: '9'.repeat(64) },
    } },
    { expected: 'pdf_object', input: { ...base, pdfObjectKey: 'users/owner-1/resumes/another.pdf' } },
    { expected: 'pdf_sha256', input: { ...base, pdfBytes: Buffer.from('%PDF-1.7 changed packet bytes') } },
  ];
  for (const changed of cases) {
    const result = verifyCurrentPacketAudit(changed.input);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'packet_stale');
    assert.notEqual(result.packetVersion, audit.packet_version);
    assert.ok(result.bindingMismatchKeys?.includes(changed.expected));
  }
});

test('packet identities are separate, immutable, and covered by packet version', () => {
  const input = validInput();
  const audit = createPacketAudit(input);
  assert.deepEqual(audit.identities, {
    resume_email: 'student@usc.edu',
    applicant_email: 'app-application-1@apply.trylitos.com',
  });
  assert.match(audit.bindings.resumeContactEmailSha256, /^[a-f0-9]{64}$/u);
  assert.match(audit.bindings.applicantEmailSha256, /^[a-f0-9]{64}$/u);
  expectInvalid((changed) => { changed.applicantEmail = changed.resumeEmail; }, /must be separate identities/);

  const missingIdentity = structuredClone(audit) as unknown as Record<string, unknown>;
  delete missingIdentity.identities;
  assert.equal(packetAuditIsSubmissionReady(missingIdentity), false);
  const missingHash = structuredClone(audit) as unknown as { bindings: Record<string, unknown> };
  delete missingHash.bindings.resumeContactEmailSha256;
  assert.equal(packetAuditIsSubmissionReady(missingHash), false);
});

test('degraded and rejected requirement results cannot create an audit', () => {
  expectInvalid((input) => { input.degraded = true; }, /requirement audit is degraded/);
  expectInvalid((input) => { input.rejected = [{ clause: 'unavailable' }]; }, /rejected judgements/);
});

test('empty or inexact clause sets cannot claim completeness', () => {
  expectInvalid((input) => { input.clauses = []; }, /at least one exact JD clause/);
  expectInvalid((input) => {
    input.clauses = input.clauses.map((clause, index) => index === 0 ? { ...clause, text: 'Different text' } : clause);
  }, /exact JD slice/);
  expectInvalid((input) => {
    input.clauses = input.clauses.map((clause, index) => index === 0 ? { ...clause, start: -1 } : clause);
  }, /invalid JD offsets/);
});

test('covered clauses require exact saved-spec evidence and gaps cannot borrow it', () => {
  expectInvalid((input) => { delete input.clauses[0].evidence; }, /missing frozen packet evidence/);
  expectInvalid((input) => {
    input.clauses[0].evidence = [{ ...input.clauses[0].evidence![0], quote: 'A fabricated degree' }];
  }, /quote does not match/);
  expectInvalid((input) => {
    input.clauses[0].evidence = [{ ...input.clauses[0].evidence![0], sha256: '0'.repeat(64) }];
  }, /sha256 does not match/);
  expectInvalid((input) => {
    input.clauses.find((clause) => clause.verdict === 'missing')!.evidence = [createResumeEvidencePointer(spec, '/skills/0')];
  }, /missing verdict must not carry/);
});

test('a highlight outside an exact JD clause is rejected', () => {
  expectInvalid((input) => {
    const heading = exactRange('Requirements:');
    input.terms.missing = [{ start: heading.start, end: heading.end }];
  }, /not contained in an exact JD clause/);
});

test('edited color requires both exact JD support and exact saved-spec evidence', () => {
  expectInvalid((input) => {
    input.editedTerms = ['Kubernetes'];
  }, /not declared in editedTerms/);
  expectInvalid((input) => {
    delete input.terms.edited[0].evidence;
  }, /missing frozen packet evidence/);
  expectInvalid((input) => {
    input.terms.edited[0].evidence = createResumeEvidencePointer(spec, '/experience/0/bullets/0');
  }, /absent from its exact saved ResumeSpec evidence/);
});

test('covered and edited terms cannot use a missing clause, and missing terms cannot use a covered clause', () => {
  expectInvalid((input) => {
    const rustEvidence = createResumeEvidencePointer({ ...spec, skills: [...spec.skills, 'Rust'] }, '/skills/2');
    input.terms.covered = [term('Rust', rustEvidence)];
  }, /not backed by a covered JD clause/);
  expectInvalid((input) => {
    input.terms.missing = [term('TypeScript')];
  }, /not backed by a missing JD clause/);
});

test('tampering with persisted audit evidence or bindings invalidates the audit digest', () => {
  const input = validInput();
  const audit = createPacketAudit(input);
  const tamperedEvidence = structuredClone(audit);
  tamperedEvidence.clauses[0].text = 'Tampered';
  assert.equal(packetAuditIsSubmissionReady(tamperedEvidence), false);
  assert.equal(verifyCurrentPacketAudit({ ...currentInput(input, tamperedEvidence) }).reason, 'packet_audit_invalid');

  const tamperedPdf = structuredClone(audit);
  tamperedPdf.bindings.pdf.sizeBytes += 1;
  assert.equal(packetAuditIsSubmissionReady(tamperedPdf), false);
});

test('malformed persisted JSON fails closed instead of throwing in a submission route', () => {
  for (const malformed of [null, {}, { version: 'packet_audit_v2' }, {
    version: 'packet_audit_v2',
    status: 'passed',
    complete: true,
    degraded: false,
    rejectedCount: 0,
    clauses: [{}],
    bindings: null,
    packet_version: '0'.repeat(64),
    audit_digest: '0'.repeat(64),
  }]) {
    assert.doesNotThrow(() => packetAuditIsSubmissionReady(malformed));
    assert.equal(packetAuditIsSubmissionReady(malformed), false);
  }
});

/* THE SEND LOG IS GLOBAL, AND IT USED TO INVALIDATE EVERY PACKET IN THE ACCOUNT.
 *
 * Measured 2026-09-02: a 69-name `submitted_application_companies` list rode inside
 * applicantSnapshot into applicantSnapshotSha256. One application landing anywhere added a name, and
 * from then on every OTHER approved packet refused to send with "applicant snapshot changed after
 * packet approval" - on packets nobody had touched. */
test('Litos own send log moving does not change the applicant-snapshot binding', () => {
  const snapshotWithLog = (companies: string[]) => ({
    profile: { full_name: 'Mehek Mandal', email: 'mehek@example.com', experience: [], skills: [] },
    application_profile: { phone: '+1 213 574 6270', submitted_application_companies: companies },
  });
  const before = applicantSnapshotSha256(snapshotWithLog(['Akuna', 'Databricks']));
  const after = applicantSnapshotSha256(snapshotWithLog(['Akuna', 'Databricks', 'The Maven Group']));
  assert.equal(before, after, 'an unrelated employer joining the send log must not park this packet');
});

test('every other applicant-snapshot byte still moves the binding', () => {
  const base = {
    profile: { full_name: 'Mehek Mandal', email: 'mehek@example.com', experience: [], skills: [] },
    application_profile: { phone: '+1 213 574 6270', submitted_application_companies: ['Akuna'] },
  };
  const movedPhone = {
    ...base,
    application_profile: { ...base.application_profile, phone: '+1 000 000 0000' },
  };
  const movedName = { ...base, profile: { ...base.profile, full_name: 'Someone Else' } };
  assert.notEqual(applicantSnapshotSha256(base), applicantSnapshotSha256(movedPhone));
  assert.notEqual(applicantSnapshotSha256(base), applicantSnapshotSha256(movedName));
});

test('the projection is shape-safe on snapshots that carry no send log at all', () => {
  for (const snapshot of [null, 'text', 42, [], { profile: {} }, { application_profile: null }]) {
    assert.equal(applicantSnapshotSha256(snapshot), packetAuditSha256(applicantSnapshotBindingValue(snapshot)));
  }
  // `undefined` was never hashable and still is not: the projection must not quietly make it one.
  assert.throws(() => applicantSnapshotSha256(undefined), /contains undefined/);
  // No send log key means nothing to strip, so the binding is the plain snapshot hash.
  const plain = { profile: { full_name: 'A' }, application_profile: { phone: '1' } };
  assert.equal(applicantSnapshotSha256(plain), packetAuditSha256(plain));
});

test('stripping the send log does not mutate the caller snapshot', () => {
  const snapshot = { application_profile: { phone: '1', submitted_application_companies: ['Akuna'] } };
  applicantSnapshotSha256(snapshot);
  assert.deepEqual(snapshot.application_profile.submitted_application_companies, ['Akuna'],
    'the fill reads this object after the binding is taken');
});
