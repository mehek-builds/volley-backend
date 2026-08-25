import { del, put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, withDedicatedDatabase } from '../db';
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
import { contestedMetrics } from '../engine/grounding';
import { generateCoverLetter, validateCoverLetter } from '../llm/coverLetter';
import { renderCoverLetterPdf } from './coverLetterPdf';
import { immutableDocumentContentHash } from './immutableDocumentHash';
import { resolveBlobUrl } from './resumeAccess';
import { coverLetterFileNameForRole } from './resumeFileName';
import { readApplicationReview, type ApplicationReviewState } from './applicationReview';
import { recoverOwnedGeneratedDocument } from './downloadDocumentRecovery';

export type CanonicalApplicationRow = typeof applications.$inferSelect;

export type CanonicalCoverLetter = {
  artifact_id: string;
  source: string;
  body: string | null;
  word_count: number;
  warnings: string[];
  generated_at: string;
  approved_at: string | null;
  object_key: string;
  file_name: string;
};

type StoredContent = {
  body?: unknown;
  word_count?: unknown;
  warnings?: unknown;
  generated_at?: unknown;
  approved_at?: unknown;
  file_name?: unknown;
};

type CanonicalTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type GeneratedResumeRow = typeof generated_resumes.$inferSelect;

export class CanonicalCoverLetterConflictError extends Error {
  constructor() {
    super('The application changed before the cover letter could be saved');
    this.name = 'CanonicalCoverLetterConflictError';
  }
}

export class CanonicalCoverLetterLockedError extends Error {
  constructor() {
    super('The cover letter can no longer be changed after submission starts');
    this.name = 'CanonicalCoverLetterLockedError';
  }
}

type LockedCanonicalApplication = {
  application: CanonicalApplicationRow;
  packet: GeneratedResumeRow | null;
};

export function canonicalCoverLetterMutationBlocked(
  application: Pick<CanonicalApplicationRow, 'submission_state' | 'tracker_state'>,
  packetSpec: unknown,
): boolean {
  const review = readApplicationReview(packetSpec);
  return application.submission_state === 'submitting'
    || application.submission_state === 'submission_claimed'
    || application.submission_state === 'submitted'
    || application.tracker_state === 'applied'
    || review?.status === 'submitting'
    || review?.status === 'submission_claimed'
    || review?.status === 'submitted'
    || Boolean(review?.submission_claimed_at)
    || Boolean(review?.submission_claim_id);
}

async function lockedApplication(
  tx: CanonicalTransaction,
  userId: string,
  applicationId: string,
): Promise<LockedCanonicalApplication> {
  // Prove this checkout is writable before an unlocked lookup can mistake replica lag for a
  // missing application. PostgreSQL rejects every SELECT FOR UPDATE in a read-only transaction,
  // even when the predicate returns no rows, so this has no row-lock side effect on the writer.
  await tx.select({ id: applications.id }).from(applications).where(sql`false`).for('update');
  const [candidate] = await tx.select().from(applications).where(and(
    eq(applications.id, applicationId),
    eq(applications.user_id, userId),
  )).limit(1);
  if (!candidate) throw new CanonicalCoverLetterConflictError();

  let packet: GeneratedResumeRow | null = null;
  if (candidate.legacy_generated_resume_id) {
    const [lockedPacket] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, candidate.legacy_generated_resume_id),
      eq(generated_resumes.user_id, userId),
    )).limit(1).for('update');
    if (!lockedPacket) throw new CanonicalCoverLetterConflictError();
    packet = lockedPacket;
  }

  const [application] = await tx.select().from(applications).where(and(
    eq(applications.id, applicationId),
    eq(applications.user_id, userId),
  )).limit(1).for('update');
  if (!application) throw new CanonicalCoverLetterConflictError();
  if (application.legacy_generated_resume_id !== candidate.legacy_generated_resume_id) {
    throw new CanonicalCoverLetterConflictError();
  }
  if (canonicalCoverLetterMutationBlocked(application, packet?.spec)) {
    throw new CanonicalCoverLetterLockedError();
  }
  return { application, packet };
}

function packetCoverLetterForArtifact(row: typeof artifacts.$inferSelect): Record<string, unknown> {
  const content = row.structured_content && typeof row.structured_content === 'object'
    ? row.structured_content as StoredContent & { uploaded?: unknown }
    : {};
  return {
    artifact_id: row.id,
    source: row.source,
    body: typeof content.body === 'string' ? content.body : '',
    word_count: typeof content.word_count === 'number' ? content.word_count : 0,
    warnings: Array.isArray(content.warnings)
      ? content.warnings.filter((warning): warning is string => typeof warning === 'string')
      : [],
    generated_at: typeof content.generated_at === 'string' ? content.generated_at : row.created_at.toISOString(),
    ...(typeof content.approved_at === 'string' ? { approved_at: content.approved_at } : {}),
    ...(content.uploaded === true ? { uploaded: true } : {}),
    object_key: row.rendered_object_key ?? '',
    file_name: typeof content.file_name === 'string' ? content.file_name : 'cover-letter.pdf',
  };
}

function reviewWithoutPacketApproval(review: ApplicationReviewState): ApplicationReviewState {
  const {
    packet_audit: _packetAudit,
    packet_audit_acknowledgement: _packetAuditAcknowledgement,
    employer_delivery_bindings: _employerDeliveryBindings,
    submission_authorization: _submissionAuthorization,
    ...retained
  } = review;
  return retained;
}

export function packetSpecWithCanonicalCoverLetter(
  specValue: unknown,
  artifact: typeof artifacts.$inferSelect | null,
): { changed: boolean; spec: Record<string, unknown> } {
  const current = specValue && typeof specValue === 'object' && !Array.isArray(specValue)
    ? specValue as Record<string, unknown>
    : {};
  const nextCoverLetter = artifact ? packetCoverLetterForArtifact(artifact) : undefined;
  if (isDeepStrictEqual(current._cover_letter, nextCoverLetter)) return { changed: false, spec: current };
  const review = readApplicationReview(current);
  const next = { ...current };
  if (nextCoverLetter) next._cover_letter = nextCoverLetter;
  else delete next._cover_letter;
  if (review) next._review = reviewWithoutPacketApproval(review);
  return { changed: true, spec: next };
}

async function mirrorCoverLetterToLegacyPacket(
  tx: CanonicalTransaction,
  locked: LockedCanonicalApplication,
  artifact: typeof artifacts.$inferSelect | null,
): Promise<GeneratedResumeRow | null> {
  const { application, packet } = locked;
  if (!application.legacy_generated_resume_id) return null;
  if (!packet) throw new CanonicalCoverLetterConflictError();
  const mirrored = packetSpecWithCanonicalCoverLetter(packet.spec, artifact);
  if (!mirrored.changed) return packet;
  const [updated] = await tx.update(generated_resumes).set({ spec: mirrored.spec }).where(and(
    eq(generated_resumes.id, packet.id),
    eq(generated_resumes.user_id, packet.user_id),
    sql`${generated_resumes.spec} = ${JSON.stringify(packet.spec)}::jsonb`,
  )).returning();
  if (!updated) throw new CanonicalCoverLetterConflictError();
  return updated;
}

async function applicationForPacket(row: GeneratedResumeRow) {
  const [application] = await db.select().from(applications).where(and(
    eq(applications.user_id, row.user_id),
    eq(applications.legacy_generated_resume_id, row.id),
  )).limit(1);
  return application ?? null;
}

async function selectedCoverLetterForApplication(application: CanonicalApplicationRow) {
  const [selected] = await db.select({ artifact: artifacts })
    .from(application_artifacts)
    .innerJoin(artifacts, and(
      eq(artifacts.id, application_artifacts.artifact_id),
      eq(artifacts.user_id, application.user_id),
      eq(artifacts.kind, 'cover_letter'),
      isNull(artifacts.deleted_at),
    ))
    .where(and(
      eq(application_artifacts.application_id, application.id),
      eq(application_artifacts.purpose, 'cover_letter'),
      eq(application_artifacts.selected, true),
    )).orderBy(desc(application_artifacts.created_at)).limit(1);
  return selected?.artifact ?? null;
}

async function selectedCoverLetterInTransaction(
  tx: CanonicalTransaction,
  application: CanonicalApplicationRow,
) {
  const [selected] = await tx.select({ artifact: artifacts })
    .from(application_artifacts)
    .innerJoin(artifacts, and(
      eq(artifacts.id, application_artifacts.artifact_id),
      eq(artifacts.user_id, application.user_id),
      eq(artifacts.kind, 'cover_letter'),
      isNull(artifacts.deleted_at),
    ))
    .where(and(
      eq(application_artifacts.application_id, application.id),
      eq(application_artifacts.purpose, 'cover_letter'),
      eq(application_artifacts.selected, true),
    )).orderBy(desc(application_artifacts.created_at)).limit(1);
  return selected?.artifact ?? null;
}

function sameArtifactPointer(
  left: typeof artifacts.$inferSelect | null,
  right: typeof artifacts.$inferSelect | null,
): boolean {
  return left?.id === right?.id && left?.rendered_object_key === right?.rendered_object_key;
}

export type CanonicalCoverLetterReconcileDependencies = {
  resolveObjectUrl: (objectKey: string) => Promise<string | null>;
  recoverDocument: typeof recoverOwnedGeneratedDocument;
  putObject: (objectKey: string, bytes: Buffer) => Promise<{ pathname: string; url: string }>;
  deleteObject: (url: string) => Promise<unknown>;
  beforeLock?: (attempt: number) => Promise<void>;
};

class CanonicalCoverLetterSelectionMovedError extends Error {}

/**
 * Makes the packet's attachment pointer match the canonical selected cover letter before audit.
 *
 * Canonical cover-letter routes and generated packet routes were introduced at different times.
 * Historical rows can therefore have one selected retained artifact while `_cover_letter` still
 * names an older generated blob. The audit must repair that divergence before it hashes or loads a
 * packet. A generated selected artifact whose retained blob aged out is recreated only from its
 * immutable version, then both stores move to the new exact pointer in one transaction.
 */
export async function reconcileCanonicalCoverLetterForPacket(
  row: GeneratedResumeRow,
  dependencies: CanonicalCoverLetterReconcileDependencies = {
    resolveObjectUrl: resolveBlobUrl,
    recoverDocument: recoverOwnedGeneratedDocument,
    putObject: (objectKey, bytes) => put(objectKey, bytes, { access: 'public', contentType: 'application/pdf' }),
    deleteObject: del,
  },
): Promise<GeneratedResumeRow> {
  return reconcileCanonicalCoverLetterAttempt(row, dependencies, 0);
}

async function reconcileCanonicalCoverLetterAttempt(
  row: GeneratedResumeRow,
  dependencies: CanonicalCoverLetterReconcileDependencies,
  attempt: number,
): Promise<GeneratedResumeRow> {
  const application = await applicationForPacket(row);
  if (!application) return row;
  const selected = await selectedCoverLetterForApplication(application);
  const selectedKey = selected?.rendered_object_key?.trim() ?? '';
  const selectedUrl = selectedKey ? await dependencies.resolveObjectUrl(selectedKey).catch(() => null) : null;
  let restoredBlob: { pathname: string; url: string } | null = null;

  if (!selectedUrl && selectedKey && selected?.retention_class === 'generated_spec') {
    const recovered = await dependencies.recoverDocument({
      userId: row.user_id,
      objectKey: selectedKey,
    });
    if (recovered.status === 'rendered' && recovered.kind === 'cover_letter') {
      const restoredKey = `users/${row.user_id}/resumes/${selected.id}-cover-letter-restored-${randomUUID()}.pdf`;
      restoredBlob = await dependencies.putObject(restoredKey, recovered.buffer);
    }
  }

  try {
    await dependencies.beforeLock?.(attempt);
    const runReconcileTransaction = (database: typeof db) => database.transaction(async (tx) => {
      const locked = await lockedApplication(tx, row.user_id, application.id);
      const current = await selectedCoverLetterInTransaction(tx, locked.application);
      if (!sameArtifactPointer(selected, current)) throw new CanonicalCoverLetterSelectionMovedError();
      if (!current) return locked.packet ?? row;

      let artifact = current;
      if (restoredBlob) {
        const [latest] = await tx.select().from(artifact_versions).where(and(
          eq(artifact_versions.artifact_id, current.id),
          eq(artifact_versions.rendered_object_key, selectedKey),
        )).orderBy(desc(artifact_versions.version_number)).limit(1);
        if (!latest) throw new CanonicalCoverLetterConflictError();
        const [restored] = await tx.update(artifacts).set({
          rendered_object_key: restoredBlob.pathname,
          rendered_blob_url: restoredBlob.url,
          updated_at: new Date(),
        }).where(and(
          eq(artifacts.id, current.id),
          eq(artifacts.user_id, row.user_id),
          eq(artifacts.rendered_object_key, selectedKey),
          isNull(artifacts.deleted_at),
        )).returning();
        if (!restored) throw new CanonicalCoverLetterConflictError();
        await tx.insert(artifact_versions).values({
          artifact_id: current.id,
          version_number: latest.version_number + 1,
          generation_source: latest.generation_source,
          job_context: latest.job_context,
          content_hash: latest.content_hash,
          structured_content: latest.structured_content,
          rendered_object_key: restoredBlob.pathname,
          rendered_blob_url: restoredBlob.url,
        });
        artifact = restored;
      }
      const mirrored = await mirrorCoverLetterToLegacyPacket(tx, locked, artifact);
      if (!mirrored) throw new CanonicalCoverLetterConflictError();
      return mirrored;
    });
    return await withReadOnlyRetry(
      () => runReconcileTransaction(db),
      {
        onRetry: (retryAttempt) => console.warn(
          `[cover-letter] reconcile transaction reached a read-only backend; retrying on a fresh pooled connection (attempt ${retryAttempt})`,
        ),
        onExhausted: () => withDedicatedDatabase((directDb) => {
          console.warn(
            '[cover-letter] pooled reconcile transactions stayed read-only; retrying on the direct database endpoint',
          );
          return runReconcileTransaction(directDb);
        }),
      },
    );
  } catch (error) {
    if (restoredBlob) await dependencies.deleteObject(restoredBlob.url).catch(() => undefined);
    if (error instanceof CanonicalCoverLetterSelectionMovedError && attempt < 1) {
      const [fresh] = await db.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, row.id),
        eq(generated_resumes.user_id, row.user_id),
      )).limit(1);
      if (!fresh) throw new CanonicalCoverLetterConflictError();
      return reconcileCanonicalCoverLetterAttempt(fresh, dependencies, attempt + 1);
    }
    if (error instanceof CanonicalCoverLetterSelectionMovedError) {
      throw new CanonicalCoverLetterConflictError();
    }
    throw error;
  }
}

function parsedIdentity(value: unknown): { full_name: string; email?: string } {
  const profile = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const fullName = typeof profile.full_name === 'string' && profile.full_name.trim()
    ? profile.full_name.trim()
    : [profile.first_name, profile.last_name].filter((part) => typeof part === 'string' && part.trim())
      .join(' ').trim() || 'Applicant';
  const email = typeof profile.resume_email === 'string' && profile.resume_email.trim()
    ? profile.resume_email.trim()
    : typeof profile.email === 'string' && profile.email.trim()
      ? profile.email.trim()
      : undefined;
  return { full_name: fullName, ...(email ? { email } : {}) };
}

function publicCoverLetter(row: typeof artifacts.$inferSelect): CanonicalCoverLetter {
  const content = row.structured_content && typeof row.structured_content === 'object'
    ? row.structured_content as StoredContent
    : {};
  return {
    artifact_id: row.id,
    source: row.source,
    body: typeof content.body === 'string' ? content.body : null,
    word_count: typeof content.word_count === 'number' ? content.word_count : 0,
    warnings: Array.isArray(content.warnings)
      ? content.warnings.filter((warning): warning is string => typeof warning === 'string')
      : [],
    generated_at: typeof content.generated_at === 'string' ? content.generated_at : row.created_at.toISOString(),
    approved_at: typeof content.approved_at === 'string' ? content.approved_at : null,
    object_key: row.rendered_object_key ?? '',
    file_name: typeof content.file_name === 'string' ? content.file_name : 'cover-letter.pdf',
  };
}

export async function canonicalStoredCoverLetter(userId: string, applicationId: string) {
  const [row] = await db.select({ artifact: artifacts }).from(application_artifacts)
    .innerJoin(artifacts, eq(artifacts.id, application_artifacts.artifact_id)).where(and(
      eq(application_artifacts.application_id, applicationId),
      eq(application_artifacts.purpose, 'cover_letter'),
      eq(application_artifacts.selected, true),
      eq(artifacts.user_id, userId),
      isNull(artifacts.deleted_at),
    )).orderBy(desc(application_artifacts.created_at)).limit(1);
  return row ? { row: row.artifact, cover_letter: publicCoverLetter(row.artifact) } : null;
}

export async function listCanonicalStoredCoverLetters(userId: string) {
  const rows = await db.select({
    artifact: artifacts,
    application: applications,
  }).from(application_artifacts)
    .innerJoin(artifacts, eq(artifacts.id, application_artifacts.artifact_id))
    .innerJoin(applications, eq(applications.id, application_artifacts.application_id))
    .where(and(
      eq(applications.user_id, userId),
      eq(application_artifacts.purpose, 'cover_letter'),
      eq(application_artifacts.selected, true),
      eq(artifacts.user_id, userId),
      isNull(artifacts.deleted_at),
    )).orderBy(desc(application_artifacts.created_at));
  return rows.map((row) => ({
    application: row.application,
    row: row.artifact,
    cover_letter: publicCoverLetter(row.artifact),
  }));
}

export async function reuseCanonicalCoverLetter(input: {
  userId: string;
  applicationId: string;
  artifactId: string;
}) {
  const runReuseTransaction = (database: typeof db) => database.transaction(async (tx) => {
    const locked = await lockedApplication(tx, input.userId, input.applicationId);
    const [owned] = await tx.select({ artifact: artifacts }).from(artifacts).where(and(
        eq(artifacts.id, input.artifactId),
        eq(artifacts.user_id, input.userId),
        eq(artifacts.kind, 'cover_letter'),
        isNull(artifacts.deleted_at),
      )).limit(1);
    if (!owned) return null;
    await tx.update(application_artifacts).set({ selected: false }).where(and(
      eq(application_artifacts.application_id, input.applicationId),
      eq(application_artifacts.purpose, 'cover_letter'),
    ));
    await tx.insert(application_artifacts).values({
      application_id: input.applicationId,
      artifact_id: input.artifactId,
      purpose: 'cover_letter',
      selected: true,
    }).onConflictDoUpdate({
      target: [
        application_artifacts.application_id,
        application_artifacts.artifact_id,
        application_artifacts.purpose,
      ],
      set: { selected: true },
    });
    await mirrorCoverLetterToLegacyPacket(tx, locked, owned.artifact);
    return { row: owned.artifact, cover_letter: publicCoverLetter(owned.artifact) };
  });
  return withReadOnlyRetry(
    () => runReuseTransaction(db),
    {
      onRetry: (retryAttempt) => console.warn(
        `[cover-letter] reuse transaction reached a read-only backend; retrying on a fresh pooled connection (attempt ${retryAttempt})`,
      ),
      onExhausted: () => withDedicatedDatabase((directDb) => {
        console.warn(
          '[cover-letter] pooled reuse transactions stayed read-only; retrying on the direct database endpoint',
        );
        return runReuseTransaction(directDb);
      }),
    },
  );
}

async function candidateContext(userId: string) {
  const [bank, profileRows] = await Promise.all([
    readExperienceBankOrSeedFromBaseResume(userId),
    db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1),
  ]);
  const source = JSON.stringify({
    profile: profileRows[0]?.parsed_json ?? {},
    declared_skills: profileRows[0]?.skills ?? [],
    experience_bank: bank,
  });
  const contested = contestedMetrics(bank.map((entry) => ({
    org: entry.org,
    text: (entry.bullet_variants as string[] | null ?? []).join(' \n '),
  })));
  return { source, contested, identity: parsedIdentity(profileRows[0]?.parsed_json) };
}

export type CanonicalCoverLetterStorageDependencies = {
  renderPdf: typeof renderCoverLetterPdf;
  putObject: (objectKey: string, bytes: Buffer, contentType: string) => Promise<{ pathname: string; url: string }>;
  deleteObject: (url: string) => Promise<unknown>;
};

const canonicalCoverLetterStorageDependencies: CanonicalCoverLetterStorageDependencies = {
  renderPdf: renderCoverLetterPdf,
  putObject: (objectKey, bytes, contentType) => put(objectKey, bytes, {
    access: 'public',
    contentType,
  }),
  deleteObject: del,
};

async function persistCanonicalBody(input: {
  application: CanonicalApplicationRow;
  body: string;
  warnings: string[];
  wordCount: number;
  source: 'ai_cover_letter' | 'user_edited_cover_letter';
}, dependencies: CanonicalCoverLetterStorageDependencies) {
  const profileRows = await db.select().from(profiles)
    .where(eq(profiles.user_id, input.application.user_id)).limit(1);
  const identity = parsedIdentity(profileRows[0]?.parsed_json);
  const generatedAt = new Date();
  const pdf = await dependencies.renderPdf(identity, input.application.company_name, input.body, generatedAt);
  const artifactId = randomUUID();
  const fileName = coverLetterFileNameForRole(identity.full_name, input.application.role);
  const content = {
    body: input.body,
    word_count: input.wordCount,
    warnings: input.warnings,
    generated_at: generatedAt.toISOString(),
    approved_at: input.source === 'user_edited_cover_letter' ? generatedAt.toISOString() : null,
    full_name: identity.full_name,
    email: identity.email,
    company: input.application.company_name,
    role: input.application.role,
    file_name: fileName,
  };
  const blobState: { current?: { pathname: string; url: string } } = {};
  let stored: typeof artifacts.$inferSelect;
  try {
    const runPersistTransaction = (database: typeof db) => database.transaction(async (tx) => {
      const locked = await lockedApplication(tx, input.application.user_id, input.application.id);
      const storedBlob = await dependencies.putObject(
        `users/${input.application.user_id}/resumes/${input.application.id}-cover-letter-${artifactId}.pdf`,
        pdf,
        'application/pdf',
      );
      blobState.current = storedBlob;
      await tx.update(application_artifacts).set({ selected: false }).where(and(
        eq(application_artifacts.application_id, input.application.id),
        eq(application_artifacts.purpose, 'cover_letter'),
      ));
      await tx.insert(artifacts).values({
        id: artifactId,
        user_id: input.application.user_id,
        kind: 'cover_letter',
        structured_content: content,
        rendered_object_key: storedBlob.pathname,
        rendered_blob_url: storedBlob.url,
        retention_class: 'generated_spec',
        source: input.source,
      });
      await tx.insert(artifact_versions).values({
        artifact_id: artifactId,
        version_number: 1,
        generation_source: input.source,
        job_context: {
          company: input.application.company_name,
          role: input.application.role,
          application_id: input.application.id,
        },
        content_hash: immutableDocumentContentHash(content),
        structured_content: content,
        rendered_object_key: storedBlob.pathname,
        rendered_blob_url: storedBlob.url,
      });
      await tx.insert(application_artifacts).values({
        application_id: input.application.id,
        artifact_id: artifactId,
        purpose: 'cover_letter',
        selected: true,
      });
      const [row] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
      if (!row) throw new Error('Cover letter persistence returned no artifact');
      await mirrorCoverLetterToLegacyPacket(tx, locked, row);
      return row;
    });
    stored = await withReadOnlyRetry(
      () => runPersistTransaction(db),
      {
        onRetry: (retryAttempt) => console.warn(
          `[cover-letter] persistence transaction reached a read-only backend; retrying on a fresh pooled connection (attempt ${retryAttempt})`,
        ),
        onExhausted: () => withDedicatedDatabase((directDb) => {
          console.warn(
            '[cover-letter] pooled persistence transactions stayed read-only; retrying on the direct database endpoint',
          );
          return runPersistTransaction(directDb);
        }),
      },
    );
  } catch (error) {
    if (blobState.current) await dependencies.deleteObject(blobState.current.url).catch(() => undefined);
    throw error;
  }
  if (!blobState.current) throw new Error('Cover letter persistence returned no blob');
  return { cover_letter: publicCoverLetter(stored), blob_url: blobState.current.url };
}

export async function generateCanonicalCoverLetter(input: {
  application: CanonicalApplicationRow;
  jdText: string;
}, dependencies: CanonicalCoverLetterStorageDependencies = canonicalCoverLetterStorageDependencies) {
  const { source, contested } = await candidateContext(input.application.user_id);
  let validation = { issues: ['not generated'], warnings: [] as string[], word_count: 0, body: '' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body = await generateCoverLetter({
      company: input.application.company_name,
      role: input.application.role,
      jd_text: input.jdText,
      candidate_source: source,
      contested_metrics: contested.labels,
    }, validation.issues);
    validation = validateCoverLetter(
      body,
      input.application.company_name,
      input.application.role,
      source,
      contested,
    );
    if (validation.issues.length === 0) break;
  }
  if (validation.issues.length > 0) {
    const error = new Error('Some cover letter lines are not backed by saved work.') as Error & { issues?: string[] };
    error.issues = validation.issues;
    throw error;
  }
  return persistCanonicalBody({
    application: input.application,
    body: validation.body,
    warnings: validation.warnings,
    wordCount: validation.word_count,
    source: 'ai_cover_letter',
  }, dependencies);
}

export async function saveCanonicalCoverLetter(
  application: CanonicalApplicationRow,
  body: string,
  dependencies: CanonicalCoverLetterStorageDependencies = canonicalCoverLetterStorageDependencies,
) {
  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
  return persistCanonicalBody({
    application,
    body,
    warnings: [],
    wordCount,
    source: 'user_edited_cover_letter',
  }, dependencies);
}

export async function uploadCanonicalCoverLetter(input: {
  application: CanonicalApplicationRow;
  bytes: Buffer;
  fileName: string;
  contentType: string;
}, dependencies: CanonicalCoverLetterStorageDependencies = canonicalCoverLetterStorageDependencies) {
  const artifactId = randomUUID();
  const safeName = input.fileName.replace(/[^a-z0-9._-]+/gi, '-').slice(-120) || 'cover-letter.pdf';
  const now = new Date();
  const content = {
    body: null,
    word_count: 0,
    warnings: [],
    generated_at: now.toISOString(),
    approved_at: now.toISOString(),
    company: input.application.company_name,
    role: input.application.role,
    file_name: safeName,
    uploaded: true,
  };
  const blobState: { current?: { pathname: string; url: string } } = {};
  let stored: typeof artifacts.$inferSelect;
  try {
    const runUploadTransaction = (database: typeof db) => database.transaction(async (tx) => {
      const locked = await lockedApplication(tx, input.application.user_id, input.application.id);
      const storedBlob = await dependencies.putObject(
        `users/${input.application.user_id}/documents/${artifactId}-${safeName}`,
        input.bytes,
        input.contentType,
      );
      blobState.current = storedBlob;
      await tx.update(application_artifacts).set({ selected: false }).where(and(
        eq(application_artifacts.application_id, input.application.id),
        eq(application_artifacts.purpose, 'cover_letter'),
      ));
      await tx.insert(artifacts).values({
        id: artifactId,
        user_id: input.application.user_id,
        kind: 'cover_letter',
        structured_content: content,
        rendered_object_key: storedBlob.pathname,
        rendered_blob_url: storedBlob.url,
        retention_class: 'user_document',
        source: 'user_uploaded_cover_letter',
      });
      await tx.insert(artifact_versions).values({
        artifact_id: artifactId,
        version_number: 1,
        generation_source: 'user_uploaded_cover_letter',
        job_context: { application_id: input.application.id, company: input.application.company_name, role: input.application.role },
        content_hash: immutableDocumentContentHash(content),
        structured_content: content,
        rendered_object_key: storedBlob.pathname,
        rendered_blob_url: storedBlob.url,
      });
      await tx.insert(application_artifacts).values({
        application_id: input.application.id,
        artifact_id: artifactId,
        purpose: 'cover_letter',
        selected: true,
      });
      const [row] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
      if (!row) throw new Error('Cover letter upload returned no artifact');
      await mirrorCoverLetterToLegacyPacket(tx, locked, row);
      return row;
    });
    stored = await withReadOnlyRetry(
      () => runUploadTransaction(db),
      {
        onRetry: (retryAttempt) => console.warn(
          `[cover-letter] upload transaction reached a read-only backend; retrying on a fresh pooled connection (attempt ${retryAttempt})`,
        ),
        onExhausted: () => withDedicatedDatabase((directDb) => {
          console.warn(
            '[cover-letter] pooled upload transactions stayed read-only; retrying on the direct database endpoint',
          );
          return runUploadTransaction(directDb);
        }),
      },
    );
  } catch (error) {
    if (blobState.current) await dependencies.deleteObject(blobState.current.url).catch(() => undefined);
    throw error;
  }
  if (!blobState.current) throw new Error('Cover letter upload returned no blob');
  return { cover_letter: publicCoverLetter(stored), blob_url: blobState.current.url };
}

export async function deleteCanonicalCoverLetters(input: {
  userId: string;
  applicationId: string;
  legacyPacketId?: string | null;
}) {
  const now = new Date();
  const runDeleteTransaction = (database: typeof db) => database.transaction(async (tx) => {
    const locked = await lockedApplication(tx, input.userId, input.applicationId);
    const { application } = locked;
    const rows = await tx.select({ artifact: artifacts }).from(application_artifacts)
      .innerJoin(artifacts, eq(artifacts.id, application_artifacts.artifact_id)).where(and(
        eq(application_artifacts.application_id, input.applicationId),
        eq(application_artifacts.purpose, 'cover_letter'),
        eq(artifacts.user_id, input.userId),
        isNull(artifacts.deleted_at),
      ));
    const deletedArtifactIds = new Set<string>();
    if (rows.length > 0) {
      await tx.delete(application_artifacts).where(and(
        eq(application_artifacts.application_id, input.applicationId),
        eq(application_artifacts.purpose, 'cover_letter'),
      ));
      for (const row of rows) {
        const [remaining] = await tx.select({ count: sql<number>`count(*)::int` })
          .from(application_artifacts).where(and(
            eq(application_artifacts.artifact_id, row.artifact.id),
            eq(application_artifacts.purpose, 'cover_letter'),
          ));
        if (Number(remaining?.count ?? 0) > 0) continue;
        await tx.update(artifacts).set({
          deleted_at: now,
          structured_content: null,
          rendered_object_key: null,
          rendered_blob_url: null,
          updated_at: now,
        }).where(and(eq(artifacts.id, row.artifact.id), eq(artifacts.user_id, input.userId)));
        await tx.delete(artifact_versions).where(eq(artifact_versions.artifact_id, row.artifact.id));
        deletedArtifactIds.add(row.artifact.id);
      }
    }
    if (input.legacyPacketId && application.legacy_generated_resume_id
      && input.legacyPacketId !== application.legacy_generated_resume_id) {
      throw new CanonicalCoverLetterConflictError();
    }
    await mirrorCoverLetterToLegacyPacket(tx, locked, null);
    return { rows, deletedArtifactIds };
  });
  const result = await withReadOnlyRetry(
    () => runDeleteTransaction(db),
    {
      onRetry: (retryAttempt) => console.warn(
        `[cover-letter] delete transaction reached a read-only backend; retrying on a fresh pooled connection (attempt ${retryAttempt})`,
      ),
      onExhausted: () => withDedicatedDatabase((directDb) => {
        console.warn(
          '[cover-letter] pooled delete transactions stayed read-only; retrying on the direct database endpoint',
        );
        return runDeleteTransaction(directDb);
      }),
    },
  );
  for (const row of result.rows) {
    if (!result.deletedArtifactIds.has(row.artifact.id)) continue;
    const url = row.artifact.rendered_blob_url
      ?? (row.artifact.rendered_object_key ? await resolveBlobUrl(row.artifact.rendered_object_key).catch(() => null) : null);
    if (url) await del(url).catch(() => undefined);
  }
}
