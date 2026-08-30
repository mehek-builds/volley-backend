import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { deleteObjects, putObject } from './objectStorage';
import { and, eq, sql } from 'drizzle-orm';
import { db, withDedicatedDatabase } from '../db/index';
import { withReadOnlyRetry } from '../db/readOnlyRetry';
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
import {
  canonicalCoverLetterMutationBlocked,
  CanonicalCoverLetterConflictError,
  CanonicalCoverLetterLockedError,
  deleteCanonicalCoverLetters,
  packetSpecWithCanonicalCoverLetter,
} from './canonicalCoverLetterService';

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

export type StoredCoverLetterReuseDisposition = {
  action: 'reuse' | 'regenerate' | 'reject';
  issues: string[];
};

/** Pure decision for a historical artifact under today's grounding rules. */
export function storedCoverLetterReuseDisposition(
  artifact: CoverLetterArtifact,
  company: string,
  role: string,
  context: Pick<CoverLetterCandidateContext, 'source' | 'contested'>,
): StoredCoverLetterReuseDisposition {
  const issues = validateCoverLetter(
    artifact.body,
    company,
    role,
    context.source,
    context.contested,
  ).issues;
  if (issues.length === 0) return { action: 'reuse', issues };
  return { action: artifact.approved_at ? 'reject' : 'regenerate', issues };
}

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
  const generatedAt = new Date().toISOString();
  const blobState: { current?: { pathname: string; url: string } } = {};
  try {
    const runPersistTransaction = (database: typeof db) => database.transaction(async (tx) => {
      const [currentPacket] = await tx.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, row.user_id),
      )).limit(1).for('update');
      if (!currentPacket || !isDeepStrictEqual(currentPacket.spec, row.spec)) {
        throw new CanonicalCoverLetterConflictError();
      }
      const [canonicalApplication] = await tx.select().from(applications).where(and(
        eq(applications.user_id, row.user_id),
        eq(applications.legacy_generated_resume_id, row.id),
      )).limit(1).for('update');
      if (!canonicalApplication) throw new Error('This application is missing its retained document record');
      if (canonicalCoverLetterMutationBlocked(canonicalApplication, currentPacket.spec)) {
        throw new CanonicalCoverLetterLockedError();
      }
      const storedBlob = await putObject(`users/${row.user_id}/resumes/${row.id}-cover-letter-${Date.now()}.pdf`, pdf, {
        contentType: 'application/pdf',
      });
      blobState.current = storedBlob;
      const artifact: CoverLetterArtifact = {
        body,
        word_count: wordCount,
        warnings,
        generated_at: generatedAt,
        approved_at: approved ? generatedAt : undefined,
        object_key: storedBlob.pathname,
        file_name: coverLetterFileNameForRole(contact.full_name, job.role),
      };

      const frozenContent = {
        body: artifact.body,
        word_count: artifact.word_count,
        warnings: artifact.warnings,
        full_name: contact.full_name,
        email: contact.email,
        company: job.company,
        role: job.role,
        generated_at: artifact.generated_at,
        approved_at: artifact.approved_at,
        file_name: artifact.file_name,
      };
      const coverArtifactId = randomUUID();
      const [storedArtifact] = await tx.insert(artifacts).values({
        id: coverArtifactId,
        user_id: row.user_id,
        kind: 'cover_letter',
        structured_content: frozenContent,
        rendered_object_key: artifact.object_key,
        rendered_blob_url: storedBlob.url,
        source: approved ? 'user_edited_cover_letter' : 'ai_cover_letter',
      }).returning();
      await tx.insert(artifact_versions).values({
        artifact_id: coverArtifactId,
        version_number: 1,
        generation_source: approved ? 'user_edited_cover_letter' : 'ai_cover_letter',
        job_context: row.job_context,
        content_hash: immutableDocumentContentHash(frozenContent),
        structured_content: frozenContent,
        rendered_object_key: artifact.object_key,
        rendered_blob_url: storedBlob.url,
      });
      await tx.update(application_artifacts).set({ selected: false }).where(and(
        eq(application_artifacts.application_id, canonicalApplication.id),
        eq(application_artifacts.purpose, 'cover_letter'),
      ));
      await tx.insert(application_artifacts).values({
        application_id: canonicalApplication.id,
        artifact_id: coverArtifactId,
        purpose: 'cover_letter',
        selected: true,
      });
      const mirrored = packetSpecWithCanonicalCoverLetter(currentPacket.spec, storedArtifact);
      const changed = await tx.update(generated_resumes).set({ spec: mirrored.spec }).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, row.user_id),
        sql`${generated_resumes.spec} = ${JSON.stringify(currentPacket.spec)}::jsonb`,
      )).returning({ id: generated_resumes.id });
      if (!changed[0]) throw new CanonicalCoverLetterConflictError();
      return artifact;
    });
    const persisted = await withReadOnlyRetry(
      () => runPersistTransaction(db),
      {
        onRetry: (retryAttempt) => console.warn(
          `[cover-letter] legacy persistence transaction reached a read-only backend; retrying on a fresh pooled connection (attempt ${retryAttempt})`,
        ),
        onExhausted: () => withDedicatedDatabase((directDb) => {
          console.warn(
            '[cover-letter] pooled legacy persistence transactions stayed read-only; retrying on the direct database endpoint',
          );
          return runPersistTransaction(directDb);
        }),
      },
    );
    if (!blobState.current) throw new Error('Cover letter persistence returned no blob');
    return { cover_letter: persisted, blob_url: blobState.current.url };
  } catch (error) {
    if (blobState.current) await deleteObjects(blobState.current.url).catch(() => undefined);
    throw error;
  }
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
  const { source, contested } = await coverLetterCandidateContext(row);
  /* STORED DOES NOT MEAN SAFE FOREVER.
   *
   * Every newly generated or edited letter passes validateCoverLetter, but artifacts written before
   * a grounding rule was added otherwise bypass that rule forever. Measured live on the Quandela
   * Workable packet on 2026-08-21: the saved letter called the applicant a Computer Science and
   * Business Administration student after the academic-program validator was deployed, because the
   * send path returned the old artifact before validation ran. Revalidate against today's frozen
   * candidate source before any caller can reuse it.
   *
   * An applicant-edited artifact is never silently replaced. If a later rule rejects it, the issues
   * return to the applicant through the normal cover-letter stop. An AI artifact can be regenerated
   * through the same two-attempt gate that created it, which repairs old packets without asking the
   * applicant to rewrite machine prose. */
  if (existing && !force) {
    const disposition = storedCoverLetterReuseDisposition(existing, job.company, job.role, { source, contested });
    if (disposition.action === 'reuse') {
      return { cover_letter: existing, blob_url: undefined };
    }
    if (disposition.action === 'reject') {
      const error = new Error('The saved cover letter no longer passes the current quality gate') as Error & { issues?: string[] };
      error.issues = disposition.issues;
      throw error;
    }
  }
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
  if (canonicalCoverLetterMutationBlocked({ submission_state: 'not_started', tracker_state: 'saved' }, row.spec)) {
    throw new CanonicalCoverLetterLockedError();
  }
  const next = packetSpecWithCanonicalCoverLetter(row.spec, null);
  const changed = await db.update(generated_resumes).set({ spec: next.spec }).where(and(
    eq(generated_resumes.id, row.id),
    eq(generated_resumes.user_id, row.user_id),
    sql`${generated_resumes.spec} = ${JSON.stringify(row.spec)}::jsonb`,
  )).returning({ id: generated_resumes.id });
  if (!changed[0]) throw new Error('Application changed before the cover letter could be removed');
  if (existing?.object_key) {
    const url = await resolveBlobUrl(existing.object_key).catch(() => null);
    if (url) await deleteObjects(url).catch(() => undefined);
  }
}
