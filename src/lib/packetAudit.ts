import { createHash } from 'node:crypto';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import type { EmployerDeliveryBindings } from './employerDeliveryIdentity';

export const PACKET_AUDIT_VERSION = 'packet_audit_v2' as const;

export type PacketAuditEvidencePointer = {
  source: 'resume_spec' | 'applicant_snapshot';
  path: string;
  sha256: string;
  quote: string;
};

export type PacketAuditClauseVerdict = 'covered' | 'missing' | 'unscoreable';

export type PacketAuditClauseInput = {
  text: string;
  start: number;
  end: number;
  verdict: PacketAuditClauseVerdict;
  evidence?: PacketAuditEvidencePointer[];
};

export type PacketAuditTermInput = {
  start: number;
  end: number;
  evidence?: PacketAuditEvidencePointer;
};

export type PacketAuditTermsInput = {
  covered: PacketAuditTermInput[];
  missing: PacketAuditTermInput[];
  edited: PacketAuditTermInput[];
};

export type PacketAuditPdfBinding = {
  objectKey: string;
  sha256: string;
  sizeBytes: number;
};

export type PacketAuditBindings = {
  ownerSha256: string;
  applicationId: string;
  jdSha256: string;
  specSha256: string;
  jobContextSha256: string;
  questionsSha256: string;
  applicantSnapshotSha256: string;
  resumeContactEmailSha256: string;
  applicantEmailSha256: string;
  employerDelivery?: EmployerDeliveryBindings;
  pdf: PacketAuditPdfBinding;
};

export type PacketAuditTerm = {
  text: string;
  key: string;
  start: number;
  end: number;
  clauseIndex: number;
  evidence?: PacketAuditEvidencePointer;
};

export type PacketAuditHighlightTerm = PacketAuditTerm & {
  tone: 'covered' | 'missing' | 'edited';
};

export type PacketAuditClause = PacketAuditClauseInput & {
  evidence?: PacketAuditEvidencePointer[];
  highlight_terms: PacketAuditHighlightTerm[];
};

export type PacketAudit = {
  version: typeof PACKET_AUDIT_VERSION;
  status: 'passed';
  complete: true;
  degraded: false;
  rejectedCount: 0;
  bindings: PacketAuditBindings;
  packet_version: string;
  identities: {
    resume_email: string;
    applicant_email: string;
  };
  clauses: PacketAuditClause[];
  editedTerms: string[];
  terms: {
    covered: PacketAuditTerm[];
    missing: PacketAuditTerm[];
    edited: PacketAuditTerm[];
  };
  audit_digest: string;
};

type PacketBindingInput = {
  ownerId: string;
  applicationId: string;
  jdText: string;
  spec: unknown;
  jobContext: unknown;
  questions: unknown;
  applicantSnapshot: unknown;
  resumeEmail: string;
  applicantEmail: string;
  employerDelivery?: EmployerDeliveryBindings;
  pdfObjectKey: string;
  pdfBytes: Uint8Array;
};

export type CreatePacketAuditInput = PacketBindingInput & {
  editedTerms: readonly string[];
  clauses: readonly PacketAuditClauseInput[];
  rejected: readonly unknown[];
  degraded: boolean;
  terms: PacketAuditTermsInput;
};

export type VerifyCurrentPacketAuditInput = PacketBindingInput & {
  audit: PacketAudit;
};

export type PacketAuditVerification = {
  valid: boolean;
  reason: string;
  packetVersion?: string;
  /** Fixed binding names only. Hashes and applicant values never leave this module. */
  bindingMismatchKeys?: string[];
};

export class PacketAuditValidationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Packet audit is invalid: ${issues.join('; ')}`);
    this.name = 'PacketAuditValidationError';
    this.issues = issues;
  }
}

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalValue(value: unknown, path = '$', seen = new Set<object>()): CanonicalValue {
  if (value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined) throw new Error(`${path} contains undefined`);
  if (typeof value !== 'object') throw new Error(`${path} is not JSON data`);
  if (seen.has(value)) throw new Error(`${path} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error(`${path} is not a plain object`);
    const output: Record<string, CanonicalValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      output[key] = canonicalValue(entry, `${path}.${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalPacketJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function packetAuditSha256(value: unknown): string {
  return createHash('sha256').update(canonicalPacketJson(value)).digest('hex');
}

export function packetAuditTextSha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function byteSha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedHighlightKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizedTextContains(text: string, key: string): boolean {
  const haystack = normalizedHighlightKey(text);
  return Boolean(key) && (` ${haystack} `).includes(` ${key} `);
}

/** Whether exact saved evidence can support a displayed JD highlight under the audit validator. */
export function packetAuditEvidenceSupportsHighlight(evidenceText: string, jdHighlight: string): boolean {
  return normalizedTextContains(evidenceText, normalizedHighlightKey(jdHighlight));
}

function jsonPointerSegments(path: string): string[] | null {
  if (!path.startsWith('/') || path === '/') return null;
  const raw = path.slice(1).split('/');
  const decoded: string[] = [];
  for (const segment of raw) {
    if (/~(?![01])/u.test(segment)) return null;
    decoded.push(segment.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  return decoded;
}

function resolvePointerValue(root: unknown, path: string): unknown | null {
  const segments = jsonPointerSegments(path);
  if (!segments) return null;
  let current: unknown = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(segment)) return null;
      const index = Number(segment);
      if (index >= current.length) return null;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  return current ?? null;
}

function resolvePointer(root: unknown, path: string): string | null {
  const value = resolvePointerValue(root, path);
  return typeof value === 'string' ? value : null;
}

export function createResumeEvidencePointer(spec: unknown, path: string): PacketAuditEvidencePointer {
  const normalized = normalizeSpec(spec) as unknown as Record<string, unknown>;
  const quote = resolvePointer(normalized, path);
  if (quote === null || !quote.trim()) {
    throw new PacketAuditValidationError([`evidence path ${path} does not resolve to a saved nonempty ResumeSpec string`]);
  }
  return { source: 'resume_spec', path, quote, sha256: createHash('sha256').update(quote).digest('hex') };
}

export function createApplicantSnapshotEvidencePointer(snapshot: unknown, path: string): PacketAuditEvidencePointer {
  const value = resolvePointerValue(snapshot, path);
  if (value === null || !['string', 'boolean', 'number'].includes(typeof value)) {
    throw new PacketAuditValidationError([`evidence path ${path} does not resolve to a frozen applicant fact`]);
  }
  const quote = typeof value === 'string' ? value : JSON.stringify(value);
  if (!quote.trim()) {
    throw new PacketAuditValidationError([`evidence path ${path} resolves to an empty frozen applicant fact`]);
  }
  return { source: 'applicant_snapshot', path, quote, sha256: createHash('sha256').update(quote).digest('hex') };
}

function evidenceIssues(
  evidence: PacketAuditEvidencePointer | undefined,
  normalizedSpec: ResumeSpec,
  applicantSnapshot: unknown,
  label: string,
): string[] {
  if (!evidence) return [`${label} is missing frozen packet evidence`];
  const raw = evidence.source === 'resume_spec'
    ? resolvePointerValue(normalizedSpec, evidence.path)
    : evidence.source === 'applicant_snapshot'
      ? resolvePointerValue(applicantSnapshot, evidence.path)
      : null;
  if (raw === null || !['string', 'boolean', 'number'].includes(typeof raw)) {
    return [`${label} evidence path does not resolve to its declared frozen source`];
  }
  const quote = typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (!quote.trim()) return [`${label} evidence resolves to an empty saved ResumeSpec string`];
  if (quote !== evidence.quote) return [`${label} evidence quote does not match its frozen source value`];
  if (!/^[a-f0-9]{64}$/u.test(evidence.sha256)
    || createHash('sha256').update(quote).digest('hex') !== evidence.sha256) {
    return [`${label} evidence sha256 does not match the saved ResumeSpec value`];
  }
  return [];
}

function bindingIssues(input: PacketBindingInput): string[] {
  const issues: string[] = [];
  if (!input.ownerId.trim()) issues.push('ownerId is required');
  if (!input.applicationId.trim()) issues.push('applicationId is required');
  if (!input.jdText.trim()) issues.push('jdText is required');
  if (!input.pdfObjectKey.trim()) issues.push('pdfObjectKey is required');
  if (!input.resumeEmail.trim()) issues.push('resumeEmail is required');
  if (!input.applicantEmail.trim()) issues.push('applicantEmail is required');
  if (input.resumeEmail.trim().toLowerCase() === input.applicantEmail.trim().toLowerCase()) {
    issues.push('resumeEmail and applicantEmail must be separate identities');
  }
  if (!(input.pdfBytes instanceof Uint8Array) || input.pdfBytes.byteLength === 0) issues.push('pdfBytes must be nonempty');
  try {
    canonicalPacketJson(normalizeSpec(input.spec));
    canonicalPacketJson(input.jobContext);
    canonicalPacketJson(input.questions);
    canonicalPacketJson(input.applicantSnapshot);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'packet bindings are not canonical JSON');
  }
  return issues;
}

/* ---- what a question CONTRIBUTES TO PACKET IDENTITY, as against what it merely records ----
 *
 * packet_version is a hash over the packet and the acknowledgement pins it, so the question this
 * list answers is not "what is on the record" but "what would make this a DIFFERENT packet than the
 * one she approved". The employer receives a label, a value, and the control the value is typed
 * into. It never receives who typed the value or when she last looked at it.
 *
 * THIS IS THE FIX FOR A DEADLOCK, and the deadlock is what proves the distinction is real.
 * Application fc6eade3, 2026-08-12: she edited her answers, applyApplicationReviewEdit stamped
 * answer_source and answer_reviewed_at onto every one of them, the audit hashed those in, and she
 * acknowledged the result. The send gate then rebuilt the same questions through
 * refreshKnownQuestionAnswers, which dropped that provenance from the two EEO questions whose values
 * recomputed to exactly themselves - "Female" and "South Asian", byte for byte - and hashed what
 * came back. Two records differing by nothing the employer would ever see produced a different
 * packet_version, verifyCurrentPacketAudit answered packet_stale, and no re-audit could clear it:
 * the audit rebuilds WITH the provenance and the gate recomputes WITHOUT it, so the two converge on
 * different hashes by construction, forever.
 *
 * Narrowing does not weaken the gate. A change to `answer`, to the label above it, or to the control
 * it fills is a change to what the employer receives and still spends the acknowledgement, which is
 * the property the gate exists for. What stops spending it is a change nobody outside the database
 * can observe.
 *
 * IT LIVES IN packetBindings, NOT IN THE SERVICE THAT CALLS IT. createPacketAudit and
 * verifyCurrentPacketAudit both come through here, so the constructor and the verifier cannot
 * disagree about what a packet is. Narrowing one call site up in packetAuditService instead left the
 * constructor hashing whatever it was handed, which is the same class of drift as the bug: a
 * regression test could build an audit that bypassed the projection and pass while production
 * deadlocked.
 *
 * AN ALLOW-LIST, NEVER A DENY-LIST. A deny-list re-widens itself the day someone adds a field: the
 * new key is not denied, so it silently joins the hash and every stored acknowledgement dies with a
 * message nobody can act on. Here a new key is simply not let in, and the compile-time partition in
 * applicationReview.ts refuses to build until someone says which side it belongs on. */
export const PACKET_VISIBLE_QUESTION_FIELDS = [
  'id',
  'question',
  'answer',
  'kind',
  'required',
  'portal_selector',
  'portal_input_type',
  'ats_api_field',
] as const;

/**
 * The questions as the PACKET sees them: label, value, and the control each one fills.
 *
 * Anything that is not a list of plain objects is returned untouched, so malformed input still
 * reaches bindingIssues' canonical-JSON check and is rejected there rather than being quietly
 * reshaped into something that hashes.
 *
 * Absent optional keys are omitted rather than written as undefined, so a question that never had a
 * portal_selector and one whose selector is explicitly undefined are the same packet.
 */
export function packetVisibleQuestions(questions: unknown): unknown {
  if (!Array.isArray(questions)) return questions;
  return questions.map((question) => {
    if (!question || typeof question !== 'object' || Array.isArray(question)) return question;
    const source = question as Record<string, unknown>;
    const visible: Record<string, unknown> = {};
    for (const field of PACKET_VISIBLE_QUESTION_FIELDS) {
      if (source[field] !== undefined) visible[field] = source[field];
    }
    return visible;
  });
}

function packetBindings(input: PacketBindingInput): PacketAuditBindings {
  const normalizedSpec = normalizeSpec(input.spec);
  return {
    ownerSha256: createHash('sha256').update(input.ownerId).digest('hex'),
    applicationId: input.applicationId,
    jdSha256: packetAuditTextSha256(input.jdText),
    specSha256: packetAuditSha256(normalizedSpec),
    jobContextSha256: packetAuditSha256(input.jobContext),
    questionsSha256: packetAuditSha256(packetVisibleQuestions(input.questions)),
    applicantSnapshotSha256: packetAuditSha256(input.applicantSnapshot),
    resumeContactEmailSha256: packetAuditSha256(input.resumeEmail.trim().toLowerCase()),
    applicantEmailSha256: packetAuditSha256(input.applicantEmail.trim().toLowerCase()),
    ...(input.employerDelivery ? { employerDelivery: input.employerDelivery } : {}),
    pdf: {
      objectKey: input.pdfObjectKey,
      sha256: byteSha256(input.pdfBytes),
      sizeBytes: input.pdfBytes.byteLength,
    },
  };
}

function packetVersion(bindings: PacketAuditBindings): string {
  return packetAuditSha256({ version: PACKET_AUDIT_VERSION, bindings });
}

function compareOffsets(a: { start: number; end: number }, b: { start: number; end: number }): number {
  return a.start - b.start || a.end - b.end;
}

type PacketAuditTermTone = keyof PacketAuditTermsInput;

const TERM_TONE_PRIORITY: Record<PacketAuditTermTone, number> = {
  missing: 0,
  edited: 1,
  covered: 2,
};

function rangesOverlap(a: PacketAuditTermInput, b: PacketAuditTermInput): boolean {
  return a.start < b.end && b.start < a.end;
}

function compareCanonicalTerms(a: PacketAuditTermInput, b: PacketAuditTermInput): number {
  const aKey = canonicalPacketJson(a);
  const bKey = canonicalPacketJson(b);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

/**
 * Selects a deterministic non-overlapping subset of internally scored JD terms.
 * Every selected range is copied unchanged. The validator remains responsible for
 * rejecting malformed offsets and any raw overlapping input that bypasses this helper.
 */
export function canonicalizePacketAuditTerms(
  terms: PacketAuditTermsInput,
  jdTextLength: number,
): PacketAuditTermsInput {
  type Candidate = {
    tone: PacketAuditTermTone;
    term: PacketAuditTermInput;
    sourceIndex: number;
  };
  const output: PacketAuditTermsInput = { covered: [], missing: [], edited: [] };
  const candidates: Candidate[] = [];
  const invalid: Candidate[] = [];
  for (const tone of ['missing', 'edited', 'covered'] as const) {
    terms[tone].forEach((term, sourceIndex) => {
      const candidate = { tone, term, sourceIndex };
      if (!Number.isInteger(term.start) || !Number.isInteger(term.end)
        || term.start < 0 || term.end <= term.start || term.end > jdTextLength) {
        invalid.push(candidate);
      } else {
        candidates.push(candidate);
      }
    });
  }
  candidates.sort((a, b) => TERM_TONE_PRIORITY[a.tone] - TERM_TONE_PRIORITY[b.tone]
    || (b.term.end - b.term.start) - (a.term.end - a.term.start)
    || a.term.start - b.term.start
    || a.term.end - b.term.end
    || compareCanonicalTerms(a.term, b.term)
    || a.sourceIndex - b.sourceIndex);
  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    if (accepted.some((selected) => rangesOverlap(candidate.term, selected.term))) continue;
    accepted.push(candidate);
  }
  for (const candidate of accepted) output[candidate.tone].push(candidate.term);
  for (const candidate of invalid) output[candidate.tone].push(candidate.term);
  for (const tone of ['covered', 'missing', 'edited'] as const) output[tone].sort(compareOffsets);
  return output;
}

function buildClauses(
  input: CreatePacketAuditInput,
  normalizedSpec: ResumeSpec,
  issues: string[],
): PacketAuditClause[] {
  if (input.clauses.length === 0) issues.push('at least one exact JD clause is required');
  const clauses = input.clauses
    .map((clause) => ({ ...clause, highlight_terms: [] as PacketAuditHighlightTerm[] }))
    .sort(compareOffsets);
  for (let index = 0; index < clauses.length; index += 1) {
    const clause = clauses[index];
    const label = `clause ${index}`;
    if (!Number.isInteger(clause.start) || !Number.isInteger(clause.end)
      || clause.start < 0 || clause.end <= clause.start || clause.end > input.jdText.length) {
      issues.push(`${label} has invalid JD offsets`);
      continue;
    }
    if (input.jdText.slice(clause.start, clause.end) !== clause.text || !clause.text.trim()) {
      issues.push(`${label} text does not equal the exact JD slice`);
    }
    if (index > 0 && clause.start < clauses[index - 1].end) issues.push(`${label} overlaps another JD clause`);
    if (!['covered', 'missing', 'unscoreable'].includes(clause.verdict)) issues.push(`${label} has an invalid verdict`);
    if (clause.verdict === 'covered') {
      if (!Array.isArray(clause.evidence) || clause.evidence.length === 0) {
        issues.push(`${label} is missing frozen packet evidence`);
      } else {
        clause.evidence.forEach((evidence, evidenceIndex) => {
          issues.push(...evidenceIssues(evidence, normalizedSpec, input.applicantSnapshot, `${label} evidence ${evidenceIndex}`));
        });
      }
    } else if (clause.evidence !== undefined) {
      issues.push(`${label} ${clause.verdict} verdict must not carry resume evidence`);
    }
  }
  return clauses;
}

function containingClauseIndex(clauses: readonly PacketAuditClause[], start: number, end: number): number {
  return clauses.findIndex((clause) => start >= clause.start && end <= clause.end);
}

function buildTerms(
  input: CreatePacketAuditInput,
  clauses: readonly PacketAuditClause[],
  normalizedSpec: ResumeSpec,
  issues: string[],
): PacketAudit['terms'] {
  const editedKeys = new Set(input.editedTerms.map(normalizedHighlightKey).filter(Boolean));
  if (editedKeys.size !== input.editedTerms.length) issues.push('editedTerms contains empty or duplicate normalized terms');
  const seenRanges: Array<{ start: number; end: number; label: string }> = [];

  const build = (tone: keyof PacketAuditTermsInput): PacketAuditTerm[] => input.terms[tone]
    .map((term, sourceIndex) => {
      const label = `${tone} term ${sourceIndex}`;
      const validOffsets = Number.isInteger(term.start) && Number.isInteger(term.end)
        && term.start >= 0 && term.end > term.start && term.end <= input.jdText.length;
      if (!validOffsets) {
        issues.push(`${label} has invalid JD offsets`);
        return { text: '', key: '', start: term.start, end: term.end, clauseIndex: -1, ...(term.evidence ? { evidence: term.evidence } : {}) };
      }
      const text = input.jdText.slice(term.start, term.end);
      const key = normalizedHighlightKey(text);
      if (!text.trim() || !key) issues.push(`${label} does not identify a JD term`);
      const clauseIndex = containingClauseIndex(clauses, term.start, term.end);
      if (clauseIndex < 0) issues.push(`${label} is not contained in an exact JD clause`);
      const expectedVerdict = tone === 'missing' ? 'missing' : 'covered';
      if (clauseIndex >= 0 && clauses[clauseIndex].verdict !== expectedVerdict) {
        issues.push(`${label} is not backed by a ${expectedVerdict} JD clause`);
      }
      if (tone === 'missing') {
        if (term.evidence) issues.push(`${label} must not carry resume evidence`);
      } else {
        issues.push(...evidenceIssues(term.evidence, normalizedSpec, input.applicantSnapshot, label));
        if (term.evidence?.source !== 'resume_spec') issues.push(`${label} must use saved ResumeSpec evidence`);
        if (term.evidence && !normalizedTextContains(term.evidence.quote, key)) {
          issues.push(`${label} is absent from its exact saved ResumeSpec evidence`);
        }
      }
      if (tone === 'edited') {
        if (!editedKeys.has(key)) issues.push(`${label} is not declared in editedTerms`);
      }
      seenRanges.push({ start: term.start, end: term.end, label });
      return { text, key, start: term.start, end: term.end, clauseIndex, ...(term.evidence ? { evidence: term.evidence } : {}) };
    })
    .sort(compareOffsets);

  const terms = { covered: build('covered'), missing: build('missing'), edited: build('edited') };
  const sortedRanges = seenRanges.sort(compareOffsets);
  for (let index = 1; index < sortedRanges.length; index += 1) {
    if (sortedRanges[index].start < sortedRanges[index - 1].end) {
      issues.push(`${sortedRanges[index].label} overlaps ${sortedRanges[index - 1].label}`);
    }
  }
  return terms;
}

function auditDigest(audit: Omit<PacketAudit, 'audit_digest'>): string {
  return packetAuditSha256(audit);
}

export function createPacketAudit(input: CreatePacketAuditInput): PacketAudit {
  const issues = bindingIssues(input);
  if (input.degraded) issues.push('requirement audit is degraded');
  if (input.rejected.length > 0) issues.push('requirement audit contains rejected judgements');
  const normalizedSpec = normalizeSpec(input.spec);
  const clauses = buildClauses(input, normalizedSpec, issues);
  const terms = buildTerms(input, clauses, normalizedSpec, issues);
  for (const tone of ['covered', 'missing', 'edited'] as const) {
    for (const term of terms[tone]) {
      if (term.clauseIndex < 0 || !clauses[term.clauseIndex]) continue;
      clauses[term.clauseIndex].highlight_terms.push({ ...term, tone });
    }
  }
  for (const clause of clauses) clause.highlight_terms.sort(compareOffsets);
  if (issues.length > 0) throw new PacketAuditValidationError(issues);

  const bindings = packetBindings(input);
  const withoutDigest: Omit<PacketAudit, 'audit_digest'> = {
    version: PACKET_AUDIT_VERSION,
    status: 'passed',
    complete: true,
    degraded: false,
    rejectedCount: 0,
    bindings,
    packet_version: packetVersion(bindings),
    identities: {
      resume_email: input.resumeEmail.trim().toLowerCase(),
      applicant_email: input.applicantEmail.trim().toLowerCase(),
    },
    clauses,
    editedTerms: [...new Set(input.editedTerms.map(normalizedHighlightKey))].sort(),
    terms,
  };
  return { ...withoutDigest, audit_digest: auditDigest(withoutDigest) };
}

/**
 * The six fields an acknowledgement pins, as a structural type rather than an import.
 *
 * The record itself lives on ApplicationReviewState, which this module does not know about and must
 * not start knowing about: applicationReview.ts imports PacketAudit from here.
 */
export type PacketAuditAcknowledgementBinding = {
  ownerSha256: string;
  applicationId: string;
  audit_digest: string;
  packet_version: string;
  pdfSha256: string;
  pdfSizeBytes: number;
};

export type StoredPacketAuditAcknowledgementInput = {
  audit: unknown;
  ownerId: string;
  applicationId: string;
  client: {
    audit_digest: string;
    packet_version: string;
    pdf_sha256: string;
    size_bytes: number;
  };
};

export type StoredPacketAuditAcknowledgementVerification =
  | { valid: true; audit: PacketAudit }
  | { valid: false; reason: 'packet_audit_stale' | 'client_packet_mismatch' };

/**
 * Verifies only the immutable audit and the four values the applicant sends back from the packet
 * she saw. This deliberately accepts no profile loader, PDF loader, resolver, clock, or environment
 * input, so an acknowledgement cannot silently become a second packet-construction request.
 */
export function verifyStoredPacketAuditAcknowledgement(
  input: StoredPacketAuditAcknowledgementInput,
): StoredPacketAuditAcknowledgementVerification {
  if (!packetAuditIsSubmissionReady(input.audit)
    || input.audit.bindings.ownerSha256 !== createHash('sha256').update(input.ownerId).digest('hex')
    || input.audit.bindings.applicationId !== input.applicationId
    || input.audit.bindings.employerDelivery?.version !== 'employer_delivery_v1') {
    return { valid: false, reason: 'packet_audit_stale' };
  }
  const audit = input.audit;
  return input.client.audit_digest === audit.audit_digest
    && input.client.packet_version === audit.packet_version
    && input.client.pdf_sha256 === audit.bindings.pdf.sha256
    && input.client.size_bytes === audit.bindings.pdf.sizeBytes
    ? { valid: true, audit }
    : { valid: false, reason: 'client_packet_mismatch' };
}

/**
 * Whether an acknowledgement is an acknowledgement OF this audit.
 *
 * ONE COPY, because two would drift and the drift would be silent in the permissive direction. The
 * send gate (currentAcknowledgedPacketAudit) asks this question of the stored acknowledgement, and
 * the retention restore asks it of the acknowledgement it is deciding whether to carry forward. If
 * those two comparisons ever disagreed, the restore could re-issue an acknowledgement the gate
 * would not have accepted, which is a human approval invented out of a record that never matched.
 */
export function acknowledgementBindsAudit(
  acknowledgement: PacketAuditAcknowledgementBinding | undefined | null,
  audit: PacketAudit,
): boolean {
  return Boolean(acknowledgement)
    && acknowledgement!.ownerSha256 === audit.bindings.ownerSha256
    && acknowledgement!.applicationId === audit.bindings.applicationId
    && acknowledgement!.audit_digest === audit.audit_digest
    && acknowledgement!.packet_version === audit.packet_version
    && acknowledgement!.pdfSha256 === audit.bindings.pdf.sha256
    && acknowledgement!.pdfSizeBytes === audit.bindings.pdf.sizeBytes;
}

/**
 * Everything an audit says about a packet EXCEPT which file carries it.
 *
 * THE BYTES ARE NEVER IDENTICAL ACROSS A REBUILD, so a rule written on them would decide nothing.
 * renderResumePdf stamps a CreationDate, the restored file gets a new object key, and
 * packet_version and audit_digest are hashes over both - three fields that differ by construction
 * between a packet and the same packet rebuilt from the same frozen inputs.
 *
 * What CAN be identical is everything else: the owner, the application, the JD, the spec, the job
 * context, the questions, the applicant snapshot, both email identities, and every clause, term and
 * verdict the audit drew from them. That is what the applicant was shown and what she was agreeing
 * to. Comparing this identity is how the restore decides whether her earlier acknowledgement still
 * describes the packet, and it is not guaranteed to match: scoring reads the calendar (a "Present"
 * date range grows) and a cached judgement can move, so an audit that now says something different
 * about the packet correctly loses the old approval.
 */
export function packetAuditContentIdentity(audit: PacketAudit): string {
  const { audit_digest: _digest, packet_version: _version, bindings, ...rest } = audit;
  const { pdf: _pdf, ...contentBindings } = bindings;
  return packetAuditSha256({ ...rest, bindings: contentBindings });
}

/**
 * The same identity minus HOW THE PACKET IS DELIVERED, for exactly one caller: the runner deciding
 * whether the capabilities a discovery pass just measured (does the form take a cover letter, a
 * transcript) may re-issue the audit under the approval she already gave. Everything she looked at
 * and agreed to is still compared: the spec, the job description, the job context, the questions,
 * the applicant snapshot, both email identities, every clause, term and verdict. Only the employer
 * delivery hash is set aside, and only because the caller has separately proven that the ONE thing
 * moving that hash is a fact Litos learned by looking at the form after she approved.
 */
export function packetAuditContentIdentityWithoutDelivery(audit: PacketAudit): string {
  const { audit_digest: _digest, packet_version: _version, bindings, ...rest } = audit;
  const { pdf: _pdf, employerDelivery: _delivery, ...contentBindings } = bindings;
  return packetAuditSha256({ ...rest, bindings: contentBindings });
}

export function packetAuditIsSubmissionReady(audit: unknown): audit is PacketAudit {
  try {
    if (!audit || typeof audit !== 'object') return false;
    const candidate = audit as Partial<PacketAudit>;
    if (candidate.version !== PACKET_AUDIT_VERSION || candidate.status !== 'passed'
      || candidate.complete !== true || candidate.degraded !== false || candidate.rejectedCount !== 0
      || !Array.isArray(candidate.clauses) || candidate.clauses.length === 0
      || !candidate.bindings || typeof candidate.bindings !== 'object'
      || !candidate.identities || typeof candidate.identities !== 'object'
      || typeof candidate.identities.resume_email !== 'string'
      || typeof candidate.identities.applicant_email !== 'string') return false;
    const delivery = candidate.bindings.employerDelivery;
    if (!delivery || delivery.version !== 'employer_delivery_v1'
      || !(['full', 'browser', 'extension'] as const).includes(delivery.mode)
      || !/^[a-f0-9]{64}$/u.test(delivery.sha256)) return false;
    if (typeof candidate.packet_version !== 'string' || typeof candidate.audit_digest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(candidate.packet_version)
      || !/^[a-f0-9]{64}$/u.test(candidate.audit_digest)) return false;
    if (packetVersion(candidate.bindings) !== candidate.packet_version) return false;
    if (packetAuditSha256(candidate.identities.resume_email.trim().toLowerCase())
        !== candidate.bindings.resumeContactEmailSha256
      || packetAuditSha256(candidate.identities.applicant_email.trim().toLowerCase())
        !== candidate.bindings.applicantEmailSha256) return false;
    const { audit_digest: storedDigest, ...withoutDigest } = candidate as PacketAudit;
    return auditDigest(withoutDigest) === storedDigest;
  } catch {
    return false;
  }
}

export function verifyCurrentPacketAudit(input: VerifyCurrentPacketAuditInput): PacketAuditVerification {
  const issues = bindingIssues(input);
  if (issues.length > 0) return { valid: false, reason: issues.join('; ') };
  if (!packetAuditIsSubmissionReady(input.audit)) return { valid: false, reason: 'packet_audit_invalid' };
  const currentBindings = packetBindings(input);
  const currentVersion = packetVersion(currentBindings);
  if (input.audit.bindings.ownerSha256 !== createHash('sha256').update(input.ownerId).digest('hex')) {
    return { valid: false, reason: 'owner_mismatch', packetVersion: currentVersion };
  }
  if (input.audit.bindings.applicationId !== input.applicationId) {
    return { valid: false, reason: 'application_mismatch', packetVersion: currentVersion };
  }
  if (input.audit.packet_version !== currentVersion) {
    const stored = input.audit.bindings;
    const bindingMismatchKeys = [
      stored.ownerSha256 !== currentBindings.ownerSha256 ? 'owner' : '',
      stored.applicationId !== currentBindings.applicationId ? 'application' : '',
      stored.jdSha256 !== currentBindings.jdSha256 ? 'jd' : '',
      stored.specSha256 !== currentBindings.specSha256 ? 'spec' : '',
      stored.jobContextSha256 !== currentBindings.jobContextSha256 ? 'job_context' : '',
      stored.questionsSha256 !== currentBindings.questionsSha256 ? 'questions' : '',
      stored.applicantSnapshotSha256 !== currentBindings.applicantSnapshotSha256 ? 'applicant_snapshot' : '',
      stored.resumeContactEmailSha256 !== currentBindings.resumeContactEmailSha256 ? 'resume_email' : '',
      stored.applicantEmailSha256 !== currentBindings.applicantEmailSha256 ? 'applicant_email' : '',
      packetAuditSha256(stored.employerDelivery ?? null)
        !== packetAuditSha256(currentBindings.employerDelivery ?? null) ? 'employer_delivery' : '',
      stored.pdf.objectKey !== currentBindings.pdf.objectKey ? 'pdf_object' : '',
      stored.pdf.sha256 !== currentBindings.pdf.sha256 ? 'pdf_sha256' : '',
      stored.pdf.sizeBytes !== currentBindings.pdf.sizeBytes ? 'pdf_size' : '',
    ].filter(Boolean);
    return { valid: false, reason: 'packet_stale', packetVersion: currentVersion, bindingMismatchKeys };
  }
  return { valid: true, reason: 'valid', packetVersion: currentVersion };
}
