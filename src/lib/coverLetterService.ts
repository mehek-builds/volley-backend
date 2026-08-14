import { del, put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index';
import {
  application_artifacts,
  applications,
  artifact_versions,
  artifacts,
  generated_resumes,
  profiles,
} from '../db/schema';
import { readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import { readApplicationReview } from './applicationReview';
import { renderCoverLetterPdf } from './coverLetterPdf';
import { generateCoverLetter, validateCoverLetter } from '../llm/coverLetter';
import { contestedMetrics } from '../engine/grounding';
import { resolveBlobUrl } from './resumeAccess';
import { coverLetterFileNameForRole } from './resumeFileName';
import { immutableDocumentContentHash } from './immutableDocumentHash';
import { deleteCanonicalCoverLetters } from './canonicalCoverLetterService';

export type ApplicationRow = typeof generated_resumes.$inferSelect;
type StoredSpec = Record<string, unknown>;

export type CoverLetterArtifact = {
  body: string;
  word_count: number;
  warnings: string[];
  generated_at: string;
  approved_at?: string;
  object_key: string;
  file_name: string;
};

export function storedCoverLetter(row: ApplicationRow): CoverLetterArtifact | null {
  const value = (row.spec as StoredSpec)._cover_letter;
  if (!value || typeof value !== 'object') return null;
  const artifact = value as Partial<CoverLetterArtifact>;
  return typeof artifact.body === 'string'
    && typeof artifact.object_key === 'string'
    && typeof artifact.file_name === 'string'
    ? artifact as CoverLetterArtifact
    : null;
}

export function canGenerateCoverLetter(supported: boolean | undefined, capabilityConfirmed = false): boolean {
  return capabilityConfirmed || supported === true;
}

/* The drafter's source, plus the figures that source cannot attribute.
 *
 * contestedMetrics runs on the experience bank rather than on the serialized source, because the
 * question it answers is "which ORG does this number belong to" and the serialized blob has thrown
 * that structure away. The bank is also the right authority: selected_resume is derived from it, so
 * a figure duplicated in the bank is duplicated everywhere downstream, and de-duplicating at the
 * bank catches it once. See engine/grounding.ts for why the defect is in her data, not here.
 */
export type CoverLetterCandidateContext = Awaited<ReturnType<typeof coverLetterCandidateContext>>;

export async function coverLetterCandidateContext(row: ApplicationRow) {
  const [bank, profileRows] = await Promise.all([
    readExperienceBankOrSeedFromBaseResume(row.user_id),
    db.select().from(profiles).where(eq(profiles.user_id, row.user_id)).limit(1),
  ]);
  const stored = row.spec as StoredSpec;
  const source = JSON.stringify({
    education: profileRows[0]?.parsed_json ?? {},
    declared_skills: profileRows[0]?.skills ?? [],
    selected_resume: Object.fromEntries(Object.entries(stored).filter(([key]) => !key.startsWith('_'))),
    experience_bank: bank,
  });
  const contested = contestedMetrics(bank.map((entry) => ({
    org: entry.org,
    text: (entry.bullet_variants as string[] | null ?? []).join(' \n '),
  })));
  const declaredSkills = Array.isArray(profileRows[0]?.skills)
    ? profileRows[0].skills.filter((skill): skill is string => typeof skill === 'string' && skill.trim().length > 0)
    : [];
  return { source, contested, declaredSkills };
}

async function persistCoverLetter(
  row: ApplicationRow,
  body: string,
  warnings: string[],
  wordCount: number,
  approved: boolean,
) {
  const stored = row.spec as StoredSpec;
  const review = readApplicationReview(stored);
  const contact = (stored._contact ?? {}) as { full_name?: string; email?: string };
  const job = row.job_context as { company?: string; role?: string };
  if (!review?.jd_text || !job.company || !job.role || !contact.full_name) throw new Error('This application is missing something we need');
  const pdf = await renderCoverLetterPdf({ full_name: contact.full_name, email: contact.email }, job.company, body);
  const blob = await put(`users/${row.user_id}/resumes/${row.id}-cover-letter-${Date.now()}.pdf`, pdf, {
    access: 'public',
    contentType: 'application/pdf',
  });
  const generatedAt = new Date().toISOString();
  const artifact: CoverLetterArtifact = {
    body,
    word_count: wordCount,
    warnings,
    generated_at: generatedAt,
    approved_at: approved ? generatedAt : undefined,
    object_key: blob.pathname,
    file_name: coverLetterFileNameForRole(contact.full_name, job.role),
  };
  const previous = storedCoverLetter(row);
  let updated: Array<{ id: string }>;
  try {
    updated = await db.transaction(async (tx) => {
      const [canonicalApplication] = await tx.select({
        application_id: application_artifacts.application_id,
      }).from(application_artifacts).innerJoin(artifacts, eq(
        artifacts.id,
        application_artifacts.artifact_id,
      )).where(and(
        eq(artifacts.user_id, row.user_id),
        eq(artifacts.legacy_generated_resume_id, row.id),
        eq(application_artifacts.purpose, 'resume'),
      )).limit(1);
      if (!canonicalApplication) throw new Error('This application is missing its retained document record');

      const frozenContent = {
        body: artifact.body,
        full_name: contact.full_name,
        email: contact.email,
        company: job.company,
        generated_at: artifact.generated_at,
      };
      const coverArtifactId = randomUUID();
      const changed = await tx.update(generated_resumes).set({
        spec: sql`jsonb_set(${generated_resumes.spec}, '{_cover_letter}', ${JSON.stringify(artifact)}::jsonb, true)`,
      }).where(and(eq(generated_resumes.id, row.id), eq(generated_resumes.user_id, row.user_id)))
        .returning({ id: generated_resumes.id });
      if (!changed[0]) return changed;
      await tx.insert(artifacts).values({
        id: coverArtifactId,
        user_id: row.user_id,
        kind: 'cover_letter',
        structured_content: frozenContent,
        rendered_object_key: artifact.object_key,
        rendered_blob_url: blob.url,
        source: approved ? 'user_edited_cover_letter' : 'ai_cover_letter',
      });
      await tx.insert(artifact_versions).values({
        artifact_id: coverArtifactId,
        version_number: 1,
        generation_source: approved ? 'user_edited_cover_letter' : 'ai_cover_letter',
        job_context: row.job_context,
        content_hash: immutableDocumentContentHash(frozenContent),
        structured_content: frozenContent,
        rendered_object_key: artifact.object_key,
        rendered_blob_url: blob.url,
      });
      await tx.insert(application_artifacts).values({
        application_id: canonicalApplication.application_id,
        artifact_id: coverArtifactId,
        purpose: 'cover_letter',
        selected: true,
      });
      return changed;
    });
  } catch (error) {
    await del(blob.url).catch(() => undefined);
    throw error;
  }
  if (!updated[0]) {
    await del(blob.url).catch(() => undefined);
    throw new Error('Application changed before the cover letter could be saved');
  }
  if (previous?.object_key && previous.object_key !== artifact.object_key) {
    const previousUrl = await resolveBlobUrl(previous.object_key).catch(() => null);
    if (previousUrl) await del(previousUrl).catch(() => undefined);
  }
  return { cover_letter: artifact, blob_url: blob.url };
}

export async function generateStoredCoverLetter(row: ApplicationRow, force = false, capabilityConfirmed = false) {
  const stored = row.spec as StoredSpec;
  const review = readApplicationReview(stored);
  const job = row.job_context as { company?: string; role?: string };
  if (!review?.jd_text || !job.company || !job.role) throw new Error('This application is missing something we need');
  if (!canGenerateCoverLetter(review.cover_letter_supported, capabilityConfirmed)) {
    throw new Error('This company’s application page has nowhere to attach a cover letter');
  }
  const existing = storedCoverLetter(row);
  if (existing && !force) return { cover_letter: existing, blob_url: undefined };
  const { source, contested } = await coverLetterCandidateContext(row);
  let body = '';
  let validation = { issues: ['not generated'], warnings: [] as string[], word_count: 0, body: '' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    body = await generateCoverLetter({
      company: job.company,
      role: job.role,
      jd_text: review.jd_text,
      candidate_source: source,
      contested_metrics: contested.labels,
    }, validation.issues);
    validation = validateCoverLetter(body, job.company, job.role, source, contested);
    if (validation.issues.length === 0) break;
  }
  if (validation.issues.length > 0) {
    const error = new Error(
      'Some lines in the cover letter are not backed by your real work, or promise something only you can promise.',
    ) as Error & { issues?: string[] };
    error.issues = validation.issues;
    throw error;
  }
  return persistCoverLetter(row, validation.body, validation.warnings, validation.word_count, false);
}

/** Validate and persist a body produced by the compact packet call through the normal letter gate. */
export async function persistGeneratedCoverLetterBody(
  row: ApplicationRow,
  body: string,
  context?: CoverLetterCandidateContext,
) {
  const review = readApplicationReview(row.spec);
  const job = row.job_context as { company?: string; role?: string };
  if (!review?.jd_text || !job.company || !job.role) throw new Error('This application is missing something we need');
  const { source, contested } = context ?? await coverLetterCandidateContext(row);
  const validation = validateCoverLetter(body, job.company, job.role, source, contested);
  if (validation.issues.length > 0) {
    const error = new Error('The compact cover letter did not pass the normal quality gate') as Error & { issues?: string[] };
    error.issues = validation.issues;
    throw error;
  }
  return persistCoverLetter(row, validation.body, validation.warnings, validation.word_count, false);
}

/* The hand-edited letter is validated by exactly the same rules, on purpose.
 *
 * The argument for relaxing the commitment check here is real: a sentence Mehek typed is her promise
 * and not Litos inventing one. It is refused anyway, because the gate is about the ARTIFACT, not the
 * author. A cover letter is prose stapled to an application; nothing downstream can read a promise
 * out of it, reconcile it with the columns she actually maintains, or show it back to her when the
 * next employer asks the same thing. A structured question can do all three. So the answer to "I do
 * want to say I can be in Seattle" is to say it where it is checkable, not in a PDF. The refusal
 * comes back with the offending sentence in `issues`, so the fix is visible and one edit away, and
 * this matches how ungroundedNumbers has always treated this path.
 */
export async function saveStoredCoverLetter(row: ApplicationRow, body: string) {
  const review = readApplicationReview(row.spec);
  const job = row.job_context as { company?: string; role?: string };
  if (!job.company || !job.role || review?.cover_letter_supported !== true) {
    throw new Error('This company’s application page has nowhere to attach a cover letter');
  }
  const { source, contested } = await coverLetterCandidateContext(row);
  const validation = validateCoverLetter(body, job.company, job.role, source, contested);
  if (validation.issues.length > 0) {
    const error = new Error('Fix the cover letter before saving.') as Error & { issues?: string[] };
    error.issues = validation.issues;
    throw error;
  }
  return persistCoverLetter(row, validation.body, validation.warnings, validation.word_count, true);
}

export async function deleteStoredCoverLetter(row: ApplicationRow) {
  const existing = storedCoverLetter(row);
  const [canonical] = await db.select({ id: applications.id }).from(applications).where(and(
    eq(applications.user_id, row.user_id),
    eq(applications.legacy_generated_resume_id, row.id),
  )).limit(1);
  if (canonical) {
    await deleteCanonicalCoverLetters({
      userId: row.user_id,
      applicationId: canonical.id,
      legacyPacketId: row.id,
    });
    return;
  }
  await db.update(generated_resumes).set({
    spec: sql`${generated_resumes.spec} - '_cover_letter'`,
  }).where(and(eq(generated_resumes.id, row.id), eq(generated_resumes.user_id, row.user_id)));
  if (existing?.object_key) {
    const url = await resolveBlobUrl(existing.object_key).catch(() => null);
    if (url) await del(url).catch(() => undefined);
  }
}
