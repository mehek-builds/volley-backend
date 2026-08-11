import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import { generated_resumes, profiles } from '../db/schema';
import { scorePosting, splitClauses, type CandidateFacts, type RequirementClause } from '../engine/clauseMatch';
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
import { pdfGenerationBindingIsCurrent } from './pdfGenerationBinding';
import { PACKET_EXPIRED_REASON, restoreExpiredPacketResume } from './packetResumeRestore';
import { resolveFrozenApplicantEmail } from './applicationEmail';
import { resumeEmailOfRecord } from './resumeEmail';

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
  reason: string;
};

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

function hasCurrentGenerationBinding(row: ResumeRow, pdfBytes: Buffer): boolean {
  const quality = row.spec && typeof row.spec === 'object' && !Array.isArray(row.spec)
    ? (row.spec as Record<string, unknown>)._quality
    : null;
  const binding = quality && typeof quality === 'object' && !Array.isArray(quality)
    ? (quality as Record<string, unknown>).pdfGenerationBinding
    : null;
  const contact = row.spec && typeof row.spec === 'object' && !Array.isArray(row.spec)
    ? (row.spec as Record<string, unknown>)._contact
    : null;
  const resumeEmail = contact && typeof contact === 'object' && !Array.isArray(contact)
    ? String((contact as Record<string, unknown>).email ?? '').trim().toLowerCase()
    : '';
  return Boolean(resumeEmail)
    && pdfGenerationBindingIsCurrent(binding, row.spec, row.resume_object_key, pdfBytes, resumeEmail);
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

function exactUnscoreableFallbackClauses(jdText: string): RequirementClause[] {
  const split = splitClauses(jdText);
  const texts = split.length > 0 ? split : [jdText.trim()].filter(Boolean);
  return texts.map((text) => ({
    text,
    weight: 0,
    verdict: 'unscoreable',
    basis: 'none',
  }));
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
  const filteredClauses = scored.clauses.filter((clause) => !(clause.verdict === 'unscoreable' && clause.basis === 'none'));
  /* Keep the current filtered set whenever it exists. If filtering would make a recognized
     requirement set empty, retain those exact clauses as honest unscoreable statements. A posting
     whose language or headings produced no recognized requirement sections still needs a
     non-vacuous binding to the saved JD, so split its exact lines without making any fit claim. */
  const auditableClauses = filteredClauses.length > 0
    ? filteredClauses
    : scored.clauses.length > 0
      ? scored.clauses
      : exactUnscoreableFallbackClauses(review.jd_text);
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
    questions: normalizeApplicationReviewQuestions(review.questions),
    applicantSnapshot: review.applicant_snapshot ?? null,
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
     * Whether this call may REBUILD a packet whose file aged out of the 30-day window.
     *
     * Defaults to false, and the default is the safety property. Restoring writes: it puts a new
     * blob and re-issues the generation binding, the audit, and the acknowledgement. The
     * acknowledgement is what authorizes a send, so writing one on a read would let a packet the
     * applicant merely LOOKED at become sendable by the unattended runner under standing consent,
     * and would resurrect a deleted file for browsing, which the retention promise says does not
     * happen. Only callers that are actually authorizing a send pass true.
     *
     * Off-by-default is also the safe direction to be wrong in. A send path that forgets to opt in
     * keeps the pre-existing expired-packet refusal, which is a visible stop; a read path that
     * forgot to opt out would silently write.
     */
    restoreExpiredResume?: boolean;
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
    : { valid: false, code: 'PACKET_AUDIT_STALE', reason: verification.reason };
}

export async function currentAcknowledgedPacketAudit(
  row: ResumeRow,
  options: {
    questions?: readonly ApplicationReviewQuestion[];
    loadPdf?: PdfLoader;
    validateApplicantEmail?: (row: ResumeRow) => Promise<void>;
    /** Forwarded verbatim. See currentPacketAudit for why this is off by default. */
    restoreExpiredResume?: boolean;
  } = {},
): Promise<PacketAuditVerdict> {
  const verdict = await currentPacketAudit(row, options);
  if (!verdict.valid) return verdict;
  /* verdict.row, NOT the row passed in. A restored packet had its acknowledgement re-issued against
     the rebuilt file inside that call, and reading the caller's stale copy would compare the new
     audit against the acknowledgement of a file that no longer exists, failing every restored
     packet with ACK_REQUIRED. */
  const acknowledgement = readApplicationReview(verdict.row.spec)?.packet_audit_acknowledgement;
  const audit = verdict.audit;
  if (!acknowledgement
    || acknowledgement.ownerSha256 !== audit.bindings.ownerSha256
    || acknowledgement.applicationId !== audit.bindings.applicationId
    || acknowledgement.audit_digest !== audit.audit_digest
    || acknowledgement.packet_version !== audit.packet_version
    || acknowledgement.pdfSha256 !== audit.bindings.pdf.sha256
    || acknowledgement.pdfSizeBytes !== audit.bindings.pdf.sizeBytes) {
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
  options: { loadPdf?: PdfLoader; validateApplicantEmail?: (row: ResumeRow) => Promise<void> } = {},
): Promise<{ audit: PacketAudit; persisted: boolean; pdfBytes: Buffer }> {
  const review = readApplicationReview(row.spec);
  if (!review) throw new Error('Application review is not available for this resume');
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
