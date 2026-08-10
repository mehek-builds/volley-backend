import { createHash } from 'node:crypto';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';

export const PACKET_AUDIT_VERSION = 'packet_audit_v1' as const;

export type PacketAuditEvidencePointer = {
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
  evidence?: PacketAuditEvidencePointer;
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
  evidence?: PacketAuditEvidencePointer;
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

function resolvePointer(root: unknown, path: string): string | null {
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
  return typeof current === 'string' ? current : null;
}

export function createResumeEvidencePointer(spec: unknown, path: string): PacketAuditEvidencePointer {
  const normalized = normalizeSpec(spec) as unknown as Record<string, unknown>;
  const quote = resolvePointer(normalized, path);
  if (quote === null || !quote.trim()) {
    throw new PacketAuditValidationError([`evidence path ${path} does not resolve to a saved nonempty ResumeSpec string`]);
  }
  return { path, quote, sha256: createHash('sha256').update(quote).digest('hex') };
}

function evidenceIssues(
  evidence: PacketAuditEvidencePointer | undefined,
  normalizedSpec: ResumeSpec,
  label: string,
): string[] {
  if (!evidence) return [`${label} is missing saved ResumeSpec evidence`];
  const quote = resolvePointer(normalizedSpec, evidence.path);
  if (quote === null) return [`${label} evidence path does not resolve to a saved ResumeSpec string`];
  if (!quote.trim()) return [`${label} evidence resolves to an empty saved ResumeSpec string`];
  if (quote !== evidence.quote) return [`${label} evidence quote does not match the saved ResumeSpec value`];
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
  if (!(input.pdfBytes instanceof Uint8Array) || input.pdfBytes.byteLength === 0) issues.push('pdfBytes must be nonempty');
  try {
    canonicalPacketJson(normalizeSpec(input.spec));
    canonicalPacketJson(input.jobContext);
    canonicalPacketJson(input.questions);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'packet bindings are not canonical JSON');
  }
  return issues;
}

function packetBindings(input: PacketBindingInput): PacketAuditBindings {
  const normalizedSpec = normalizeSpec(input.spec);
  return {
    ownerSha256: createHash('sha256').update(input.ownerId).digest('hex'),
    applicationId: input.applicationId,
    jdSha256: createHash('sha256').update(input.jdText).digest('hex'),
    specSha256: packetAuditSha256(normalizedSpec),
    jobContextSha256: packetAuditSha256(input.jobContext),
    questionsSha256: packetAuditSha256(input.questions),
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
      issues.push(...evidenceIssues(clause.evidence, normalizedSpec, label));
    } else if (clause.evidence) {
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
        issues.push(...evidenceIssues(term.evidence, normalizedSpec, label));
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
    clauses,
    editedTerms: [...new Set(input.editedTerms.map(normalizedHighlightKey))].sort(),
    terms,
  };
  return { ...withoutDigest, audit_digest: auditDigest(withoutDigest) };
}

export function packetAuditIsSubmissionReady(audit: unknown): audit is PacketAudit {
  try {
    if (!audit || typeof audit !== 'object') return false;
    const candidate = audit as Partial<PacketAudit>;
    if (candidate.version !== PACKET_AUDIT_VERSION || candidate.status !== 'passed'
      || candidate.complete !== true || candidate.degraded !== false || candidate.rejectedCount !== 0
      || !Array.isArray(candidate.clauses) || candidate.clauses.length === 0
      || !candidate.bindings || typeof candidate.bindings !== 'object') return false;
    if (typeof candidate.packet_version !== 'string' || typeof candidate.audit_digest !== 'string'
      || !/^[a-f0-9]{64}$/u.test(candidate.packet_version)
      || !/^[a-f0-9]{64}$/u.test(candidate.audit_digest)) return false;
    if (packetVersion(candidate.bindings) !== candidate.packet_version) return false;
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
    return { valid: false, reason: 'packet_stale', packetVersion: currentVersion };
  }
  return { valid: true, reason: 'valid', packetVersion: currentVersion };
}
