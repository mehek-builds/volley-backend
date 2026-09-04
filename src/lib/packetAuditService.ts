import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes, profiles } from '../db/schema';
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
  acknowledgementBindsAudit,
  canonicalizePacketAuditTerms,
  createPacketAudit,
  createApplicantSnapshotEvidencePointer,
  createResumeEvidencePointer,
  packetAuditEvidenceSupportsHighlight,
  packetAuditIsSubmissionReady,
  verifyCurrentPacketAudit,
  type PacketAudit,
  type PacketAuditEvidencePointer,
} from './packetAudit';
import { resolveBlobUrl } from './resumeAccess';
import { bindingPdfIdentity, pdfGenerationBindingIsCurrent } from './pdfGenerationBinding';
import { loadPacketPdf, type StoredPdfIdentity } from './packetPdfCache';
import {
  PACKET_EXPIRED_REASON,
  restoreExpiredPacketResume,
  type PacketRestoreAuthority,
} from './packetResumeRestore';
import { resolveFrozenApplicantEmail } from './applicationEmail';
import { resumeEmailOfRecord } from './resumeEmail';
import { withAuthorityRevisionRetry } from '../db/authorityRevisionRetry';

type ResumeRow = typeof generated_resumes.$inferSelect;

type PacketEmailIdentityDeps = {
  loadCurrentResumeEmail?: (userId: string) => Promise<string | undefined>;
  resolveCurrentApplicantEmail?: typeof resolveFrozenApplicantEmail;
};

export async function verifyCurrentPacketEmailIdentities(
  row: ResumeRow,
  deps: PacketEmailIdentityDeps = {},
): Promise<void> {
  let currentResumeEmail: string | undefined;
  if (deps.loadCurrentResumeEmail) {
    currentResumeEmail = await deps.loadCurrentResumeEmail(row.user_id);
  } else {
    const [profile] = await db.select({ parsed_json: profiles.parsed_json })
      .from(profiles)
      .where(eq(profiles.user_id, row.user_id))
      .limit(1);
    currentResumeEmail = resumeEmailOfRecord(profile?.parsed_json);
  }
  const stored = row.spec && typeof row.spec === 'object' && !Array.isArray(row.spec)
    ? row.spec as Record<string, unknown>
    : {};
  const contact = stored._contact && typeof stored._contact === 'object' && !Array.isArray(stored._contact)
    ? stored._contact as Record<string, unknown>
    : {};
  const storedResumeEmail = String(contact.email ?? '').trim().toLowerCase();
  if (!currentResumeEmail || currentResumeEmail !== storedResumeEmail) {
    throw new Error('The personal resume email changed or is missing. Regenerate this packet before applying.');
  }
  const resolved = await (deps.resolveCurrentApplicantEmail ?? resolveFrozenApplicantEmail)({
    userId: row.user_id,
    applicationId: row.id,
    spec: row.spec,
  });
  const review = readApplicationReview(row.spec);
  if (!review || resolved.address !== review.applicant_email?.address) {
    throw new Error('The current tracked Litos routing email does not match this packet.');
  }
}

export type PacketAuditFailure = {
  valid: false;
  code: 'PACKET_AUDIT_REQUIRED' | 'PACKET_AUDIT_STALE' | 'PACKET_AUDIT_ACK_REQUIRED' | 'PACKET_PDF_INVALID'
    /* The file aged out of its 30-day window AND could not be rebuilt from the frozen spec. Its own
       code rather than PACKET_PDF_INVALID because the two owe different sentences and different
       recoveries: an invalid PDF is a defect to look at, this is the retention policy working, and
       only a regenerate clears it. */
    | 'PACKET_RESUME_EXPIRED';
  /** The machine token. Pinned by this suite's tests and worth reading in logs; never replied. */
  reason: string;
  /** Set ONLY by tokenisedPacketAuditFailure, and the sentence an applicant is allowed to read. */
  message?: string;
  /** Privacy-safe fixed binding names for production diagnosis. */
  bindingMismatchKeys?: string[];
};

/* WHAT A FAILED VERDICT IS ALLOWED TO SAY TO AN APPLICANT.
 *
 * `reason` is not uniformly a sentence. Most of the failures in this file carry one, but the ones
 * that come back through verifyCurrentPacketAudit are DEVELOPER TOKENS - `packet_stale`,
 * `owner_mismatch`, `application_mismatch`, `packet_audit_invalid` - and bindingIssues adds strings
 * like "jdText is required". Routes used to reply `{ error: verdict.reason }` verbatim, so on
 * 2026-08-19 the dashboard printed the bare word **packet_stale** in a red banner to a student on
 * the autopilot row, with nothing on screen naming what to do about it.
 *
 * Translate at the HTTP boundary and nowhere earlier. The token is what the tests in this suite
 * pin and what the logs are worth reading, so the verdict keeps it; only the reply is rewritten.
 * An unrecognised reason resolves to the generic sentence rather than being passed through, because
 * the whole point is that this route cannot leak a string it did not choose. */
const PACKET_AUDIT_SENTENCES: Readonly<Record<string, string>> = {
  packet_stale: 'This application changed after you approved the exact packet Litos prepared, so it was not sent. Open it to review the current one and send from there.',
  owner_mismatch: 'This packet was prepared for a different account, so it was not sent. Open it to review and send from there.',
  application_mismatch: 'This packet was prepared for a different application, so it was not sent. Open it to review and send from there.',
  packet_audit_invalid: 'Litos could not confirm the packet it prepared for this application, so it was not sent. Open it to review and send from there.',
};
const PACKET_AUDIT_GENERIC = 'Litos could not confirm this packet still matches the application you approved, so it was not sent. Open it to review and send from there.';

export function packetAuditClientError(verdict: PacketAuditFailure): { error: string; code: PacketAuditFailure['code'] } {
  /* `message` when the verdict carries one, and NOT a guess about which strings look like prose.
     Whether a reason is a token is knowledge the site that built it has and a regex does not:
     "jdText is required" has a space and reads like English, and shipping it to an applicant is
     the same defect as shipping `packet_stale`. Only tokenisedFailure sets `message`, so every
     reason without one is prose this file authored on purpose. */
  return { error: verdict.message ?? verdict.reason, code: verdict.code };
}

/* The one place a verifyCurrentPacketAudit reason becomes a verdict, so the one place that has to
   attach the sentence. Kept next to the table it reads from. */
export function tokenisedPacketAuditFailure(
  code: PacketAuditFailure['code'],
  reason: string,
  bindingMismatchKeys?: string[],
): PacketAuditFailure {
  return {
    valid: false,
    code,
    reason,
    message: PACKET_AUDIT_SENTENCES[reason] ?? PACKET_AUDIT_GENERIC,
    ...(bindingMismatchKeys?.length ? { bindingMismatchKeys } : {}),
  };
}

export type PacketAuditSuccess = {
  valid: true;
  audit: PacketAudit;
  pdfBytes: Buffer;
  /* The row as it stands AFTER any retention restore. Callers must use this rather than the row
     they passed in: a restored packet has a new resume_object_key, and a caller that keeps its own
     copy would mint download tokens for, and assemble packets from, the deleted key. */
  row: ResumeRow;
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

function storedGenerationBinding(spec: unknown): unknown {
  const quality = spec && typeof spec === 'object' && !Array.isArray(spec)
    ? (spec as Record<string, unknown>)._quality
    : null;
  return quality && typeof quality === 'object' && !Array.isArray(quality)
    ? (quality as Record<string, unknown>).pdfGenerationBinding
    : null;
}

function hasCurrentGenerationBinding(row: ResumeRow, pdfBytes: Buffer): boolean {
  const binding = storedGenerationBinding(row.spec);
  const contact = row.spec && typeof row.spec === 'object' && !Array.isArray(row.spec)
    ? (row.spec as Record<string, unknown>)._contact
    : null;
  const resumeEmail = contact && typeof contact === 'object' && !Array.isArray(contact)
    ? String((contact as Record<string, unknown>).email ?? '').trim().toLowerCase()
    : '';
  return Boolean(resumeEmail)
    && pdfGenerationBindingIsCurrent(binding, row.spec, row.resume_object_key, pdfBytes, resumeEmail);
}

/**
 * What the row records about the file at its current key, or null when it records nothing checkable.
 *
 * Null is the honest answer for a packet with no generation binding, and it is also the safe one:
 * hasCurrentGenerationBinding refuses such a packet no matter what bytes arrive, so there is nothing
 * to be gained by caching them and nothing they could be proven against.
 */
function storedPdfIdentity(row: ResumeRow): StoredPdfIdentity | null {
  return bindingPdfIdentity(storedGenerationBinding(row.spec), row.resume_object_key);
}

function editableSpec(value: unknown): ResumeSpec {
  return normalizeSpec(value);
}

type EvidencePointer = PacketAuditEvidencePointer;

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

function fallbackUnscoreableClause(jdText: string) {
  const firstLine = /[^\s\r\n](?:[^\r\n]*[^\s\r\n])?/u.exec(jdText);
  if (!firstLine || firstLine.index == null) return null;
  const text = firstLine[0].slice(0, 400);
  return {
    text,
    start: firstLine.index,
    end: firstLine.index + text.length,
    verdict: 'unscoreable' as const,
  };
}

function evidenceForTerm(
  term: JdTerm,
  spec: ResumeSpec,
  jdText: string,
  context: JdContext,
): EvidencePointer | undefined {
  /* THE POINTER MUST NAME THE BRANCH THAT ACTUALLY COVERED IT, not merely the requirement.
     A stated choice is one term carrying several branches, so matching on `term` alone returned the
     first resume field that satisfied ANY branch. On "Fluent in Python, Ruby, or PHP" against a
     resume carrying PHP, the frozen evidence for a requirement met by PHP could be pinned to the
     line that mentions Python. `satisfied_by` is written by scoreJdMatch and is the covering string
     itself, so comparing it holds the pointer to the same words the match was made on. */
  const covering = term.satisfied_by ?? term.term;
  for (const value of specStrings(spec)) {
    const fieldMatch = scoreJdMatch(value.quote, jdText, context).matched
      .some((candidate) => candidate.term === term.term && (candidate.satisfied_by ?? candidate.term) === covering);
    if (fieldMatch) return value;
  }
  return undefined;
}

function evidenceForClause(
  clause: { text: string; evidence?: string; basis: string },
  spec: ResumeSpec,
  review: ApplicationReviewState,
): EvidencePointer[] | undefined {
  if (clause.basis === 'degree') {
    const evidence = spec.degree ? [createResumeEvidencePointer(spec, '/degree')] : [];
    if (/\b(current\s+(?:cs|ml)\b|currently\s+enrolled|enrolled|pursuing|currently\s+studying|\b(?:undergrad|master'?s)\s+student\b)/i.test(clause.text)) {
      const profileValue = review.applicant_snapshot?.profile.currently_enrolled;
      const path = typeof profileValue === 'boolean'
        ? '/profile/currently_enrolled'
        : '/application_profile/currently_enrolled';
      evidence.push(createApplicantSnapshotEvidencePointer(review.applicant_snapshot, path));
    }
    if (/\b(?:project(?:\s+or\s+internship)?|internship)\s+track record\b/i.test(clause.text)) {
      const entryIndex = spec.experience.findIndex((entry) => entry.bullets.length > 0
        && (entry.type === 'project' || /\bintern(?:ship)?\b/i.test(`${entry.title} ${entry.org}`)));
      if (entryIndex >= 0) evidence.push(createResumeEvidencePointer(spec, `/experience/${entryIndex}/bullets/0`));
    }
    return evidence.length > 0 ? evidence : undefined;
  }
  if (clause.basis === 'graduation') {
    return spec.grad_date ? [createResumeEvidencePointer(spec, '/grad_date')] : undefined;
  }
  if (clause.basis === 'experience-years') {
    const professionalOnly = /\b(professional|work|industry|full[- ]time)\s+experience\b/i.test(clause.text);
    const evidence = spec.experience
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.date_range.trim() && (!professionalOnly || entry.type === 'job'))
      .map(({ index }) => createResumeEvidencePointer(spec, `/experience/${index}/date_range`));
    return evidence.length > 0 ? evidence : undefined;
  }
  if (clause.basis === 'onsite-commitment') {
    const profile = review.applicant_snapshot?.application_profile;
    if (!profile?.onsite_commitment) return undefined;
    const evidence = [createApplicantSnapshotEvidencePointer(
      review.applicant_snapshot,
      '/application_profile/onsite_commitment',
    )];
    if (profile.onsite_commitment === 'listed_locations') {
      const locationIndex = (profile.onsite_locations ?? [])
        .findIndex((location) => /\b(?:san francisco|san fran|sf)\b/i.test(location));
      if (locationIndex < 0) return undefined;
      evidence.push(createApplicantSnapshotEvidencePointer(
        review.applicant_snapshot,
        `/application_profile/onsite_locations/${locationIndex}`,
      ));
    }
    return evidence;
  }
  const quoted = (clause.evidence ?? '').trim().replace(/^"|"$/g, '');
  const evidence = specStrings(spec).find((value) => value.quote === quoted)
    ?? specStrings(spec).find((value) => normalized(value.quote).includes(normalized(quoted)));
  return evidence ? [evidence] : undefined;
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

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8,
  sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

function datePoint(value: string, end: boolean, now: Date): number | null {
  const clean = value.trim().replace(/\./g, '');
  if (/^(?:present|current|now)$/i.test(clean)) return now.getUTCFullYear() * 12 + now.getUTCMonth();
  const monthYear = clean.match(/^([A-Za-z]+)\s+((?:19|20)\d{2})$/);
  if (monthYear) {
    const month = MONTHS[monthYear[1].toLowerCase()];
    return month == null ? null : Number(monthYear[2]) * 12 + month;
  }
  const year = clean.match(/^((?:19|20)\d{2})$/);
  if (year) return (Number(year[1]) + (end ? 1 : 0)) * 12;
  return null;
}

export function monthsOfExperienceFromSpec(
  spec: ResumeSpec,
  now = new Date(),
  professionalOnly = false,
): number | null {
  if (professionalOnly && spec.experience.some((entry) => entry.type == null)) return null;
  const experience = professionalOnly
    ? spec.experience.filter((entry) => entry.type === 'job')
    : spec.experience;
  if (experience.length === 0) return 0;
  const intervals: Array<{ start: number; end: number }> = [];
  for (const entry of experience) {
    const parts = entry.date_range.replace(/[\u2013\u2014]/g, '-').split(/\s+(?:-|to)\s+/i);
    if (parts.length !== 2) return null;
    const start = datePoint(parts[0], false, now);
    const end = datePoint(parts[1], true, now);
    if (start == null || end == null || end < start) return null;
    intervals.push({ start, end });
  }
  intervals.sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0;
  let current = intervals[0];
  for (const interval of intervals.slice(1)) {
    if (interval.start <= current.end) {
      current.end = Math.max(current.end, interval.end);
    } else {
      total += current.end - current.start;
      current = interval;
    }
  }
  total += current.end - current.start;
  return total;
}

export async function scoreAuditEvidence(row: ResumeRow, review: ApplicationReviewState) {
  const spec = editableSpec(row.spec);
  const context = jobContext(row.job_context);
  const facts: CandidateFacts = {
    degree: spec.degree,
    school: spec.school,
    gradDate: spec.grad_date,
    resumeText: resumeSpecText(spec),
    bullets: spec.experience.flatMap((entry) => entry.bullets),
    monthsOfExperience: monthsOfExperienceFromSpec(spec),
    monthsOfProfessionalExperience: monthsOfExperienceFromSpec(spec, new Date(), true),
    currentlyEnrolled: review.applicant_snapshot?.profile.currently_enrolled
      ?? review.applicant_snapshot?.application_profile.currently_enrolled
      ?? null,
    projectOrInternshipEvidence: spec.experience.find((entry) => entry.bullets.length > 0
      && (entry.type === 'project' || /\bintern(?:ship)?\b/i.test(`${entry.title} ${entry.org}`)))?.bullets[0] ?? null,
    onsiteCommitment: review.applicant_snapshot?.application_profile.onsite_commitment ?? null,
    onsiteLocations: review.applicant_snapshot?.application_profile.onsite_locations ?? null,
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
      ? evidenceForClause(clause, spec, review)
      : undefined;
    if (clause.verdict === 'met' && !rawEvidence && offset.start >= 0) {
      const fallbackEvidence = match.matched
        .filter((term) => {
          const occurrence = exactOccurrence(review.jd_text.slice(offset.start, offset.end), term.display);
          return occurrence !== null;
        })
        .map((term) => termEvidence.get(term.term))
        .find((value): value is EvidencePointer => Boolean(value));
      rawEvidence = fallbackEvidence ? [fallbackEvidence] : undefined;
    }
    const groundedCovered = clause.verdict === 'met' && Boolean(rawEvidence?.length);
    return {
      text: clause.text,
      start: offset.start,
      end: offset.end,
      verdict: groundedCovered
        ? 'covered' as const
        : clause.verdict === 'unmet'
          ? 'missing' as const
          : 'unscoreable' as const,
      ...(groundedCovered ? { evidence: rawEvidence } : {}),
    };
  });
  /* A low-detail posting can legitimately contain no requirement clause. The audit still needs one
     exact JD slice so the applicant can see what was frozen and the audit stays bound to the saved
     description. Marking the first visible line unscoreable makes no fit claim and keeps the packet
     integrity gate usable for open applications such as a general internship intake. */
  if (clauses.length === 0) {
    const fallback = fallbackUnscoreableClause(review.jd_text);
    if (fallback) clauses.push(fallback);
  }
  const edited = new Set(review.edited_terms.map(normalized));
  const terms: {
    covered: Array<{ start: number; end: number; evidence: EvidencePointer }>;
    missing: Array<{ start: number; end: number }>;
    edited: Array<{ start: number; end: number; evidence: EvidencePointer }>;
  } = { covered: [], missing: [], edited: [] };
  const clauseFor = (occurrence: { start: number; end: number }, verdict: 'covered' | 'missing') => clauses
    .find((clause) => occurrence.start >= clause.start && occurrence.end <= clause.end && clause.verdict === verdict);
  /* A COVERED MARK GOES ON THE BRANCH THAT COVERED IT, not on the whole choice.
     `display` for a stated choice is the employer's whole span, "Python, TypeScript", and painting
     that from evidence quoting only "Python" claims more than the evidence supports: the highlight
     validator rejected it and the mark was dropped entirely. A MISSING choice keeps the whole span,
     because the requirement that is unmet is the choice itself. */
  const highlightSpelling = (term: JdTerm, verdict: 'covered' | 'missing') =>
    (verdict === 'covered' && term.alternatives ? (term.satisfied_by ?? term.term) : term.display);
  const occurrenceInsideClause = (term: JdTerm, verdict: 'covered' | 'missing') => {
    for (const clause of clauses) {
      if (clause.verdict !== verdict || clause.start < 0) continue;
      const local = exactOccurrence(review.jd_text.slice(clause.start, clause.end), highlightSpelling(term, verdict));
      if (local) return { start: clause.start + local.start, end: clause.start + local.end };
    }
    return null;
  };
  for (const term of match.matched) {
    const occurrence = occurrenceInsideClause(term, 'covered');
    const evidence = termEvidence.get(term.term);
    if (!occurrence || !evidence) continue;
    if (!packetAuditEvidenceSupportsHighlight(
      evidence.quote,
      review.jd_text.slice(occurrence.start, occurrence.end),
    )) continue;
    if (!clauseFor(occurrence, 'covered')) continue;
    const isEdited = edited.has(normalized(term.term)) || edited.has(normalized(term.display));
    const target = isEdited ? terms.edited : terms.covered;
    target.push({ ...occurrence, evidence });
  }
  for (const term of match.missing) {
    const occurrence = occurrenceInsideClause(term, 'missing');
    if (occurrence && clauseFor(occurrence, 'missing')) terms.missing.push(occurrence);
  }
  /* Requirement fit is evidence, not packet integrity. A raw met verdict without one exact frozen
     pointer has already been downgraded to `unscoreable` above, so the audit makes no unsupported
     coverage claim. Remembering the discarded verdict here would turn that honest downgrade into
     a submission outage. Keep failing closed on internal pending state. Missing and unscoreable job
     requirements remain visible but do not invalidate an otherwise exact resume, PDF, identity,
     answer set, or employer form. Judgement warnings remain available to diagnostics below. */
  const degraded = scored.clauses.some((clause) => clause.verdict === 'pending');
  const canonicalTerms = canonicalizePacketAuditTerms(terms, review.jd_text.length);
  return {
    spec,
    clauses,
    terms: canonicalTerms,
    editedTerms: canonicalTerms.edited.map((term) => normalized(review.jd_text.slice(term.start, term.end))),
    /* The judgement validator never admits a rejected model verdict. Its clause is downgraded to
       unscoreable, so there is no claim for the packet audit to trust. Preserve the warnings for
       diagnostics while giving the audit constructor only the admitted, grounded evidence. */
    rejected: [],
    judgementWarnings: scored.rejected,
    degraded,
  };
}

function auditInput(row: ResumeRow, review: ApplicationReviewState, pdfBytes: Buffer) {
  const stored = row.spec && typeof row.spec === 'object' && !Array.isArray(row.spec)
    ? row.spec as Record<string, unknown>
    : {};
  const contact = stored._contact && typeof stored._contact === 'object' && !Array.isArray(stored._contact)
    ? stored._contact as Record<string, unknown>
    : {};
  return {
    ownerId: row.user_id,
    applicationId: row.id,
    jdText: review.jd_text,
    spec: editableSpec(row.spec),
    jobContext: row.job_context,
    /* Passed whole. packetBindings projects these to the fields that make up packet identity, so
       the audit and the send gate are narrowed at the same line and cannot disagree about what a
       packet is. See PACKET_VISIBLE_QUESTION_FIELDS. */
    questions: normalizeApplicationReviewQuestions(review.questions),
    applicantSnapshot: review.applicant_snapshot ?? null,
    employerDelivery: review.employer_delivery_bindings,
    resumeEmail: String(contact.email ?? '').trim().toLowerCase(),
    applicantEmail: String(review.applicant_email?.address ?? '').trim().toLowerCase(),
    pdfObjectKey: row.resume_object_key,
    pdfBytes,
  };
}

function packetEmailIdentityIssue(row: ResumeRow, review: ApplicationReviewState): string | null {
  const stored = row.spec && typeof row.spec === 'object' && !Array.isArray(row.spec)
    ? row.spec as Record<string, unknown>
    : {};
  const contact = stored._contact && typeof stored._contact === 'object' && !Array.isArray(stored._contact)
    ? stored._contact as Record<string, unknown>
    : {};
  const resumeEmail = String(contact.email ?? '').trim().toLowerCase();
  const applicantEmail = String(review.applicant_email?.address ?? '').trim().toLowerCase();
  if (!resumeEmail) return 'The packet has no personal resume email. Regenerate it from the current profile.';
  if (!applicantEmail || review.applicant_email?.source !== 'litos_alias' || review.applicant_email.tracked !== true) {
    return 'The packet has no verified Litos routing email. Regenerate it before applying.';
  }
  if (resumeEmail === applicantEmail) return 'The resume email and portal routing email must be separate.';
  const pinned = stored._applicant_email && typeof stored._applicant_email === 'object' && !Array.isArray(stored._applicant_email)
    ? stored._applicant_email as Record<string, unknown>
    : {};
  if (String(pinned.address ?? '').trim().toLowerCase() !== applicantEmail
    || pinned.source !== 'litos_alias' || pinned.tracked !== true) {
    return 'The stored applicant email does not match the tracked Litos routing identity.';
  }
  const applicationIdentity = stored._application_email
    && typeof stored._application_email === 'object' && !Array.isArray(stored._application_email)
    ? stored._application_email as Record<string, unknown>
    : {};
  if (String(applicationIdentity.alias ?? '').trim().toLowerCase() !== applicantEmail
    || applicationIdentity.mode !== 'litos_application_alias') {
    return 'The application email route is not bound to this packet.';
  }
  const snapshotEmail = review.applicant_snapshot?.profile.email?.trim().toLowerCase();
  if (snapshotEmail !== applicantEmail) {
    return 'The frozen portal applicant email does not match the Litos routing email.';
  }
  return null;
}

export async function currentPacketAudit(
  // eslint-disable-next-line prefer-const -- reassigned by the retention restore below
  row: ResumeRow,
  options: {
    questions?: readonly ApplicationReviewQuestion[];
    loadPdf?: PdfLoader;
    validateApplicantEmail?: (row: ResumeRow) => Promise<void>;
    /**
     * Whether this call may REBUILD a packet whose file aged out of the 30-day window, and on whose
     * authority.
     *
     * Absent means no rebuild, and that default is the safety property: restoring writes a new blob
     * and re-issues the generation binding and the audit, and a caller that forgets to opt in keeps
     * the pre-existing expired-packet refusal, which is a visible stop.
     *
     * The VALUE is the second half of the rule, and it is a named authority rather than `true`
     * because the first version of this was really keyed on the HTTP verb and got the packet-audit
     * route wrong: that route is a POST that renders a packet for the applicant to look at. Only
     * 'authorizing_send' may carry an acknowledgement she already gave onto the rebuilt file, and
     * nothing may create one. See PacketRestoreAuthority and restoredPacketAcknowledgement.
     */
    restoreExpiredResume?: PacketRestoreAuthority;
  } = {},
): Promise<PacketAuditVerdict> {
  /* FIRST, BEFORE ANY OTHER CHECK, because every check below reads either the stored PDF or a
     record bound to it, and a packet past its retention window has neither until it is rebuilt.
     This is the choke point every send path shares: prepare(), submit(), and all thirteen audit
     call sites in routes/applications.ts funnel through here, which is why the restore lives at
     this line instead of at each of them. Idempotent: when the file is present it resolves and
     returns immediately, which is every call but the rare one. */
  const restore = options.restoreExpiredResume
    ? await restoreExpiredPacketResume(row, {
    authority: options.restoreExpiredResume,
    persistAudit: createAndPersistPacketAudit,
    /* THE RESTORE MUST AGREE WITH THIS CALL'S OWN LOADER about whether the file exists. A caller
       that injects loadPdf (every test here, and any path that already holds the bytes) would
       otherwise have the presence check fall through to resolveBlobUrl and hit the network, decide
       the file was missing, and rebuild a packet the injected loader can serve perfectly well.
       Derived from loadPdf rather than given its own option so the two can never disagree. */
    resolveObjectUrl: options.loadPdf
      ? async (key) => (await options.loadPdf!(key).then(() => 'present').catch(() => null))
      : undefined,
    })
    : { restored: false as const, row };
  if ('unrecoverable' in restore) {
    return { valid: false, code: 'PACKET_RESUME_EXPIRED', reason: PACKET_EXPIRED_REASON };
  }
  row = restore.row;
  const review = readApplicationReview(row.spec);
  if (!review?.packet_audit || !packetAuditIsSubmissionReady(review.packet_audit)) {
    return { valid: false, code: 'PACKET_AUDIT_REQUIRED', reason: 'Audit this exact packet before submitting.' };
  }
  const emailIssue = packetEmailIdentityIssue(row, review);
  if (emailIssue) return { valid: false, code: 'PACKET_AUDIT_STALE', reason: emailIssue };
  try {
    await (options.validateApplicantEmail ?? verifyCurrentPacketEmailIdentities)(row);
  } catch (error) {
    return {
      valid: false,
      code: 'PACKET_AUDIT_STALE',
      reason: error instanceof Error ? error.message : 'The tracked Litos routing email is no longer current.',
    };
  }
  let loaded: { bytes: Buffer; contentType?: string };
  try {
    /* THROUGH THE PROCESS CACHE, which is the whole of the cost fix. This route is polled every 2.5
       seconds while a packet is open - measured 1,440 calls an hour per open packet against a rate
       limit that is only charged on the INVALID path, so the hot path was entirely unmetered - and
       every one of those calls downloaded the same immutable 31.7 KB file.

       NOTHING BELOW THIS LINE CHANGES. validStoredPdf and hasCurrentGenerationBinding run on
       whatever bytes come back, cached or not, and auditInput receives those same bytes, so a
       cached copy is re-proven against the row's recorded sha256 on every single request rather
       than being taken on the cache's word. See packetPdfCache for why the entry could not have
       been the wrong file in the first place, and what happens when a row's record moves. */
    loaded = await loadPacketPdf({
      objectKey: row.resume_object_key,
      identity: storedPdfIdentity(row),
      load: options.loadPdf ?? defaultPdfLoader,
    });
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
  if (!hasCurrentGenerationBinding(row, loaded.bytes)) {
    return {
      valid: false,
      code: 'PACKET_PDF_INVALID',
      reason: 'The stored resume PDF is not bound to this exact saved resume. Generate it again.',
    };
  }
  const input = auditInput(row, {
    ...review,
    questions: options.questions
      ? normalizeApplicationReviewQuestions([...options.questions])
      : review.questions,
  }, loaded.bytes);
  const verification = verifyCurrentPacketAudit({ ...input, audit: review.packet_audit });
  return verification.valid
    ? { valid: true, audit: review.packet_audit, pdfBytes: loaded.bytes, row }
    : tokenisedPacketAuditFailure('PACKET_AUDIT_STALE', verification.reason, verification.bindingMismatchKeys);
}

export async function currentAcknowledgedPacketAudit(
  row: ResumeRow,
  options: {
    questions?: readonly ApplicationReviewQuestion[];
    loadPdf?: PdfLoader;
    validateApplicantEmail?: (row: ResumeRow) => Promise<void>;
    /** Forwarded verbatim. See currentPacketAudit for why this is off by default, and why the
        value names the caller's authority rather than saying `true`. */
    restoreExpiredResume?: PacketRestoreAuthority;
  } = {},
): Promise<PacketAuditVerdict> {
  const verdict = await currentPacketAudit(row, options);
  if (!verdict.valid) return verdict;
  /* verdict.row, NOT the row passed in. A restored packet may have had an acknowledgement she
     already gave carried onto the rebuilt file inside that call, and reading the caller's stale
     copy would compare the new audit against the acknowledgement of a file that no longer exists,
     failing that packet with ACK_REQUIRED. A packet that had no acknowledgement to carry has none
     here either, and fails exactly as it should. */
  const acknowledgement = readApplicationReview(verdict.row.spec)?.packet_audit_acknowledgement;
  const audit = verdict.audit;
  // The same comparison the restore makes before it carries one forward, so the two cannot drift.
  if (!acknowledgementBindsAudit(acknowledgement, audit)) {
    return {
      valid: false,
      code: 'PACKET_AUDIT_ACK_REQUIRED',
      reason: 'Review the exact resume PDF and requirement evidence before submitting.',
    };
  }
  return verdict;
}

export async function createAndPersistPacketAudit(
  row: ResumeRow,
  options: {
    loadPdf?: PdfLoader;
    validateApplicantEmail?: (row: ResumeRow) => Promise<void>;
    /* The question set to audit, when the caller has one that differs from the stored review.
     *
     * Mirrors currentPacketAudit's option of the same name and exists for the same reason: the
     * constructor and the verifier have to be looking at ONE packet. The send gate verifies
     * against refreshKnownQuestionAnswers output, so a route that builds an audit for the
     * applicant to acknowledge has to build it over that same set, or the acknowledgement it
     * produces is spent on a packet_version the gate will never compute. */
    questions?: readonly ApplicationReviewQuestion[];
    /** Exact review snapshot whose applicant and delivery bindings were built for this audit. */
    review?: ApplicationReviewState;
  } = {},
): Promise<{ audit: PacketAudit; persisted: boolean; pdfBytes: Buffer }> {
  const stored = readApplicationReview(row.spec);
  if (!stored) throw new Error('Application review is not available for this resume');
  const review = options.review
    ?? (options.questions ? { ...stored, questions: [...options.questions] } : stored);
  const emailIssue = packetEmailIdentityIssue(row, review);
  if (emailIssue) throw new Error(emailIssue);
  await (options.validateApplicantEmail ?? verifyCurrentPacketEmailIdentities)(row);
  const loaded = await (options.loadPdf ?? defaultPdfLoader)(row.resume_object_key);
  if (!validStoredPdf(loaded)) throw new Error('The stored resume is not a verified PDF');
  if (!hasCurrentGenerationBinding(row, loaded.bytes)) {
    throw new Error('The stored resume PDF is not bound to this exact saved resume. Generate it again.');
  }
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
  /* RETRIED, BUT DELIBERATELY NOT COLLAPSED INTO `persisted: false`, and the difference matters more
   * here than anywhere else this guard is handled.
   *
   * The retry is the same one every other exact-CAS review write now gets: the submission-authority
   * revision trigger takes the per-user advisory lock with pg_try_advisory_xact_lock and RAISES
   * 40001 rather than waiting, so a dashboard poll's projection read - which is milliseconds, and
   * which the audit screen is issuing every 2.5 seconds while this runs - was enough to fail the
   * write. Re-running this statement unchanged keeps the exact-spec CAS, so a retry can only land on
   * the row this audit was built from.
   *
   * WHAT MUST NOT HAPPEN ON EXHAUSTION. `persisted: false` means one specific thing to this
   * function's caller: POST /applications/:id/packet-audit answers 409 PACKET_AUDIT_STALE, and the
   * dashboard treats that code as NOT transient - features/applications/domain/audit-refusal.ts
   * lists it under both AUTOPILOT_CANNOT_CLEAR and REVIEW_RECOVERY_REQUIRED, so the autopilot stops
   * retrying the packet and the applicant is sent back to re-review a PDF that never changed.
   * Spending that on a lock someone held for four milliseconds would be a worse lie than the 500.
   * So the conflict propagates, and the route answers 503 with Retry-After: 1 and "This account
   * changed at the same time. Try the request again." - the contract toPublicError already carries
   * for this SQLSTATE. Nothing was written either way; only one of the two answers is true. */
  const updated = await withAuthorityRevisionRetry(() => db.update(generated_resumes).set({
    spec: sql`jsonb_set(coalesce(${generated_resumes.spec}, '{}'::jsonb), '{_review}', ${JSON.stringify(next)}::jsonb, true)`,
  }).where(and(
    eq(generated_resumes.id, row.id),
    eq(generated_resumes.user_id, row.user_id),
    sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
    sql`${generated_resumes.resume_object_key} = ${row.resume_object_key}`,
  )).returning({ id: generated_resumes.id }));
  return { audit, persisted: updated.length === 1, pdfBytes: loaded.bytes };
}
