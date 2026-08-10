import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes } from '../db/schema';
import { scorePosting, type CandidateFacts } from '../engine/clauseMatch';
import { scoreJdMatch, segmentJd, type JdContext, type JdTerm } from '../engine/jdMatch';
import { resumeSpecText } from '../engine/resumeValidate';
import { judgeCompetenciesCached } from '../llm/competencyCache';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import {
  normalizeApplicationReviewQuestions,
  readApplicationReview,
  type ApplicationReviewQuestion,
  type ApplicationReviewState,
} from './applicationReview';
import {
  createPacketAudit,
  createResumeEvidencePointer,
  packetAuditIsSubmissionReady,
  verifyCurrentPacketAudit,
  type PacketAudit,
} from './packetAudit';
import { resolveBlobUrl } from './resumeAccess';

type ResumeRow = typeof generated_resumes.$inferSelect;

export type PacketAuditFailure = {
  valid: false;
  code: 'PACKET_AUDIT_REQUIRED' | 'PACKET_AUDIT_STALE' | 'PACKET_PDF_INVALID';
  reason: string;
};

export type PacketAuditSuccess = {
  valid: true;
  audit: PacketAudit;
  pdfBytes: Buffer;
};

export type PacketAuditVerdict = PacketAuditFailure | PacketAuditSuccess;

type PdfLoader = (objectKey: string) => Promise<{ bytes: Buffer; contentType?: string }>;

const defaultPdfLoader: PdfLoader = async (objectKey) => {
  const url = await resolveBlobUrl(objectKey);
  if (!url) throw new Error('The stored resume PDF is unavailable');
  const response = await fetch(url);
  if (!response.ok) throw new Error('The stored resume PDF could not be downloaded');
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? undefined,
  };
};

export function validStoredPdf(input: { bytes: Buffer; contentType?: string }): boolean {
  if (input.bytes.length < 5 || input.bytes.subarray(0, 5).toString('ascii') !== '%PDF-') return false;
  if (input.contentType && !/^application\/pdf(?:\s*;|$)/i.test(input.contentType.trim())) return false;
  return true;
}

function editableSpec(value: unknown): ResumeSpec {
  return normalizeSpec(value);
}

type EvidencePointer = { path: string; quote: string; sha256: string };

function specStrings(spec: ResumeSpec): EvidencePointer[] {
  const values: Array<{ path: string; quote: string }> = [];
  const add = (path: string, value: unknown) => {
    if (typeof value === 'string' && value.trim()) values.push({ path, quote: value });
  };
  add('/target_role', spec.target_role);
  add('/school', spec.school);
  add('/degree', spec.degree);
  add('/grad_date', spec.grad_date);
  add('/gpa', spec.gpa);
  add('/school_location', spec.school_location);
  add('/coursework', spec.coursework);
  spec.experience.forEach((entry, experienceIndex) => {
    add(`/experience/${experienceIndex}/org`, entry.org);
    add(`/experience/${experienceIndex}/title`, entry.title);
    add(`/experience/${experienceIndex}/location`, entry.location);
    add(`/experience/${experienceIndex}/date_range`, entry.date_range);
    entry.bullets.forEach((bullet, bulletIndex) => {
      add(`/experience/${experienceIndex}/bullets/${bulletIndex}`, bullet);
    });
  });
  spec.skills.forEach((skill, skillIndex) => add(`/skills/${skillIndex}`, skill));
  return values.map((value) => createResumeEvidencePointer(spec, value.path));
}

function normalized(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#./-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function evidenceForTerm(
  term: JdTerm,
  spec: ResumeSpec,
  jdText: string,
  context: JdContext,
): EvidencePointer | undefined {
  for (const value of specStrings(spec)) {
    const fieldMatch = scoreJdMatch(value.quote, jdText, context).matched
      .some((candidate) => candidate.term === term.term);
    if (fieldMatch) return value;
  }
  return undefined;
}

function evidenceForClause(text: string, basis: string, spec: ResumeSpec): EvidencePointer | undefined {
  if (basis === 'degree') return spec.degree ? createResumeEvidencePointer(spec, '/degree') : undefined;
  if (basis === 'graduation') return spec.grad_date ? createResumeEvidencePointer(spec, '/grad_date') : undefined;
  if (basis === 'experience-years') {
    const index = spec.experience.findIndex((entry) => entry.date_range.trim());
    return index >= 0
      ? createResumeEvidencePointer(spec, `/experience/${index}/date_range`)
      : undefined;
  }
  const quoted = text.trim().replace(/^"|"$/g, '');
  return specStrings(spec).find((value) => value.quote === quoted)
    ?? specStrings(spec).find((value) => normalized(value.quote).includes(normalized(quoted)));
}

function exactOccurrence(jdText: string, display: string, preferred?: number): { start: number; end: number } | null {
  if (typeof preferred === 'number' && preferred >= 0) {
    const exact = jdText.slice(preferred, preferred + display.length);
    if (normalized(exact) === normalized(display)) return { start: preferred, end: preferred + display.length };
  }
  const at = jdText.toLowerCase().indexOf(display.toLowerCase());
  return at >= 0 ? { start: at, end: at + display.length } : null;
}

function exactClauseOccurrences(jdText: string, clauses: readonly { text: string }[]): Array<{ start: number; end: number }> {
  const offsets: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const clause of clauses) {
    let start = jdText.indexOf(clause.text, cursor);
    if (start < 0) start = jdText.indexOf(clause.text);
    offsets.push({ start, end: start < 0 ? -1 : start + clause.text.length });
    if (start >= 0) cursor = start + clause.text.length;
  }
  return offsets;
}

function jobContext(value: unknown): JdContext {
  const context = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    company: typeof context.company === 'string' ? context.company : undefined,
    role: typeof context.role === 'string' ? context.role : undefined,
    location: typeof context.location === 'string' ? context.location : null,
  };
}

async function scoreAuditEvidence(row: ResumeRow, review: ApplicationReviewState) {
  const spec = editableSpec(row.spec);
  const context = jobContext(row.job_context);
  const facts: CandidateFacts = {
    degree: spec.degree,
    school: spec.school,
    gradDate: spec.grad_date,
    resumeText: resumeSpecText(spec),
    bullets: spec.experience.flatMap((entry) => entry.bullets),
  };
  const scored = await scorePosting(
    review.jd_text,
    facts,
    context,
    segmentJd,
    async (bullets, questions, profile) => {
      const judged = await judgeCompetenciesCached(bullets, questions, profile);
      return { verdicts: judged.verdicts, rejected: judged.rejected };
    },
  );
  const auditableClauses = scored.clauses.filter((clause) => !(clause.verdict === 'unscoreable' && clause.basis === 'none'));
  const offsets = exactClauseOccurrences(review.jd_text, auditableClauses);
  const match = scoreJdMatch(resumeSpecText(spec), review.jd_text, context);
  const termEvidence = new Map<string, EvidencePointer>();
  for (const term of match.matched) {
    const evidence = evidenceForTerm(term, spec, review.jd_text, context);
    if (evidence) termEvidence.set(term.term, evidence);
  }
  const clauses = auditableClauses.map((clause, index) => {
    const offset = offsets[index]!;
    let rawEvidence = clause.verdict === 'met' && clause.evidence
      ? evidenceForClause(clause.evidence, clause.basis, spec)
      : undefined;
    if (clause.verdict === 'met' && !rawEvidence && offset.start >= 0) {
      rawEvidence = match.matched
        .filter((term) => {
          const occurrence = exactOccurrence(review.jd_text.slice(offset.start, offset.end), term.display);
          return occurrence !== null;
        })
        .map((term) => termEvidence.get(term.term))
        .find((value): value is EvidencePointer => Boolean(value));
    }
    return {
      text: clause.text,
      start: offset.start,
      end: offset.end,
      verdict: clause.verdict === 'met'
        ? 'covered' as const
        : clause.verdict === 'unmet'
          ? 'missing' as const
          : 'unscoreable' as const,
      ...(rawEvidence ? { evidence: rawEvidence } : {}),
    };
  });
  const edited = new Set(review.edited_terms.map(normalized));
  const terms: {
    covered: Array<{ start: number; end: number; evidence: EvidencePointer }>;
    missing: Array<{ start: number; end: number }>;
    edited: Array<{ start: number; end: number; evidence: EvidencePointer }>;
  } = { covered: [], missing: [], edited: [] };
  const clauseFor = (occurrence: { start: number; end: number }, verdict: 'covered' | 'missing') => clauses
    .find((clause) => occurrence.start >= clause.start && occurrence.end <= clause.end && clause.verdict === verdict);
  const occurrenceInsideClause = (term: JdTerm, verdict: 'covered' | 'missing') => {
    for (const clause of clauses) {
      if (clause.verdict !== verdict || clause.start < 0) continue;
      const local = exactOccurrence(review.jd_text.slice(clause.start, clause.end), term.display);
      if (local) return { start: clause.start + local.start, end: clause.start + local.end };
    }
    return null;
  };
  const auditedEditedTerms = new Set<string>();
  for (const term of match.matched) {
    const occurrence = occurrenceInsideClause(term, 'covered');
    const evidence = termEvidence.get(term.term);
    if (!occurrence || !evidence) continue;
    if (!clauseFor(occurrence, 'covered')) continue;
    const isEdited = edited.has(normalized(term.term)) || edited.has(normalized(term.display));
    const target = isEdited ? terms.edited : terms.covered;
    target.push({ ...occurrence, evidence });
    if (isEdited) auditedEditedTerms.add(normalized(review.jd_text.slice(occurrence.start, occurrence.end)));
  }
  for (const term of match.missing) {
    const occurrence = occurrenceInsideClause(term, 'missing');
    if (occurrence && clauseFor(occurrence, 'missing')) terms.missing.push(occurrence);
  }
  const degraded = scored.clauses.some((clause) => clause.verdict === 'pending'
    || (clause.verdict === 'unscoreable' && clause.basis !== 'none'));
  return {
    spec,
    clauses,
    terms,
    editedTerms: [...auditedEditedTerms],
    rejected: scored.rejected,
    degraded,
  };
}

function auditInput(row: ResumeRow, review: ApplicationReviewState, pdfBytes: Buffer) {
  return {
    ownerId: row.user_id,
    applicationId: row.id,
    jdText: review.jd_text,
    spec: editableSpec(row.spec),
    jobContext: row.job_context,
    questions: normalizeApplicationReviewQuestions(review.questions),
    pdfObjectKey: row.resume_object_key,
    pdfBytes,
  };
}

export async function currentPacketAudit(
  row: ResumeRow,
  options: { questions?: readonly ApplicationReviewQuestion[]; loadPdf?: PdfLoader } = {},
): Promise<PacketAuditVerdict> {
  const review = readApplicationReview(row.spec);
  if (!review?.packet_audit || !packetAuditIsSubmissionReady(review.packet_audit)) {
    return { valid: false, code: 'PACKET_AUDIT_REQUIRED', reason: 'Audit this exact packet before submitting.' };
  }
  let loaded: { bytes: Buffer; contentType?: string };
  try {
    loaded = await (options.loadPdf ?? defaultPdfLoader)(row.resume_object_key);
  } catch (error) {
    return {
      valid: false,
      code: 'PACKET_PDF_INVALID',
      reason: error instanceof Error ? error.message : 'The stored resume PDF is unavailable',
    };
  }
  if (!validStoredPdf(loaded)) {
    return { valid: false, code: 'PACKET_PDF_INVALID', reason: 'The stored resume is not a verified PDF.' };
  }
  const input = auditInput(row, {
    ...review,
    questions: options.questions
      ? normalizeApplicationReviewQuestions([...options.questions])
      : review.questions,
  }, loaded.bytes);
  const verification = verifyCurrentPacketAudit({ ...input, audit: review.packet_audit });
  return verification.valid
    ? { valid: true, audit: review.packet_audit, pdfBytes: loaded.bytes }
    : { valid: false, code: 'PACKET_AUDIT_STALE', reason: verification.reason };
}

export async function createAndPersistPacketAudit(
  row: ResumeRow,
  options: { loadPdf?: PdfLoader } = {},
): Promise<{ audit: PacketAudit; persisted: boolean; pdfBytes: Buffer }> {
  const review = readApplicationReview(row.spec);
  if (!review) throw new Error('Application review is not available for this resume');
  const loaded = await (options.loadPdf ?? defaultPdfLoader)(row.resume_object_key);
  if (!validStoredPdf(loaded)) throw new Error('The stored resume is not a verified PDF');
  const scored = await scoreAuditEvidence(row, review);
  const audit = createPacketAudit({
    ...auditInput(row, review, loaded.bytes),
    editedTerms: scored.editedTerms,
    clauses: scored.clauses,
    rejected: scored.rejected,
    degraded: scored.degraded,
    terms: scored.terms,
  });
  const next: ApplicationReviewState = { ...review, packet_audit: audit };
  const updated = await db.update(generated_resumes).set({
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(next)}::jsonb, true)`,
  }).where(and(
    eq(generated_resumes.id, row.id),
    eq(generated_resumes.user_id, row.user_id),
    sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
    sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
  )).returning({ id: generated_resumes.id });
  return { audit, persisted: updated.length === 1, pdfBytes: loaded.bytes };
}
