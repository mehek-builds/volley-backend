import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResumeSpec } from '../llm/resumeSpec';
import {
  canonicalPacketJson,
  createPacketAudit,
  createResumeEvidencePointer,
  packetAuditIsSubmissionReady,
  packetAuditSha256,
  PacketAuditValidationError,
  type CreatePacketAuditInput,
  type PacketAudit,
  type PacketAuditClauseInput,
  type PacketAuditTermInput,
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
    { ...degreeClause, verdict: 'covered', evidence: degreeEvidence },
    { ...typescriptClause, verdict: 'covered', evidence: typescriptEvidence },
    { ...editedClause, verdict: 'covered', evidence: editedEvidence },
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
    pdfObjectKey: input.pdfObjectKey,
    pdfBytes: input.pdfBytes,
    audit,
  };
}

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

test('creates a submission-ready v1 audit with exact PDF, clause, evidence, and term bindings', () => {
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

test('the current-packet verifier rejects stale JD, spec, job, answers, and PDF bindings', () => {
  const input = validInput();
  const audit = createPacketAudit(input);
  const base = currentInput(input, audit);
  const changedSpec = structuredClone(spec);
  changedSpec.experience[0].bullets[0] = 'Built Go services for operations teams and reduced response time by 30 percent';
  const cases = [
    { ...base, jdText: `${JD}\nAnother requirement.` },
    { ...base, spec: changedSpec },
    { ...base, jobContext: { company: 'Other Company', role: 'Software Engineer', job_id: 'job-1' } },
    { ...base, questions: [{ id: 'q1', question: 'Are you authorized to work?', answer: 'No', required: true }] },
    { ...base, pdfObjectKey: 'users/owner-1/resumes/another.pdf' },
    { ...base, pdfBytes: Buffer.from('%PDF-1.7 changed packet bytes') },
  ];
  for (const changed of cases) {
    const result = verifyCurrentPacketAudit(changed);
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'packet_stale');
    assert.notEqual(result.packetVersion, audit.packet_version);
  }
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
  expectInvalid((input) => { delete input.clauses[0].evidence; }, /missing saved ResumeSpec evidence/);
  expectInvalid((input) => {
    input.clauses[0].evidence = { ...input.clauses[0].evidence!, quote: 'A fabricated degree' };
  }, /quote does not match/);
  expectInvalid((input) => {
    input.clauses[0].evidence = { ...input.clauses[0].evidence!, sha256: '0'.repeat(64) };
  }, /sha256 does not match/);
  expectInvalid((input) => {
    input.clauses.find((clause) => clause.verdict === 'missing')!.evidence = createResumeEvidencePointer(spec, '/skills/0');
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
  }, /missing saved ResumeSpec evidence/);
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
  for (const malformed of [null, {}, { version: 'packet_audit_v1' }, {
    version: 'packet_audit_v1',
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
