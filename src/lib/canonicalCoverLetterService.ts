import { del, put } from '@vercel/blob';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db';
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
  return db.transaction(async (tx) => {
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
    return { row: owned.artifact, cover_letter: publicCoverLetter(owned.artifact) };
  });
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

async function persistCanonicalBody(input: {
  application: CanonicalApplicationRow;
  body: string;
  warnings: string[];
  wordCount: number;
  source: 'ai_cover_letter' | 'user_edited_cover_letter';
}) {
  const profileRows = await db.select().from(profiles)
    .where(eq(profiles.user_id, input.application.user_id)).limit(1);
  const identity = parsedIdentity(profileRows[0]?.parsed_json);
  const generatedAt = new Date();
  const pdf = await renderCoverLetterPdf(identity, input.application.company_name, input.body, generatedAt);
  const artifactId = randomUUID();
  const blob = await put(
    `users/${input.application.user_id}/resumes/${input.application.id}-cover-letter-${artifactId}.pdf`,
    pdf,
    { access: 'public', contentType: 'application/pdf' },
  );
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
  const previous = await canonicalStoredCoverLetter(input.application.user_id, input.application.id);
  try {
    const stored = await db.transaction(async (tx) => {
      await tx.update(application_artifacts).set({ selected: false }).where(and(
        eq(application_artifacts.application_id, input.application.id),
        eq(application_artifacts.purpose, 'cover_letter'),
      ));
      await tx.insert(artifacts).values({
        id: artifactId,
        user_id: input.application.user_id,
        kind: 'cover_letter',
        structured_content: content,
        rendered_object_key: blob.pathname,
        rendered_blob_url: blob.url,
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
        rendered_object_key: blob.pathname,
        rendered_blob_url: blob.url,
      });
      await tx.insert(application_artifacts).values({
        application_id: input.application.id,
        artifact_id: artifactId,
        purpose: 'cover_letter',
        selected: true,
      });
      const [row] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
      return row;
    });
    if (!stored) throw new Error('Cover letter persistence returned no artifact');
    if (previous?.row.rendered_blob_url && previous.row.rendered_blob_url !== blob.url) {
      await del(previous.row.rendered_blob_url).catch(() => undefined);
    }
    return { cover_letter: publicCoverLetter(stored), blob_url: blob.url };
  } catch (error) {
    await del(blob.url).catch(() => undefined);
    throw error;
  }
}

export async function generateCanonicalCoverLetter(input: {
  application: CanonicalApplicationRow;
  jdText: string;
}) {
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
  });
}

export async function saveCanonicalCoverLetter(application: CanonicalApplicationRow, body: string) {
  const wordCount = body.trim().split(/\s+/).filter(Boolean).length;
  return persistCanonicalBody({
    application,
    body,
    warnings: [],
    wordCount,
    source: 'user_edited_cover_letter',
  });
}

export async function uploadCanonicalCoverLetter(input: {
  application: CanonicalApplicationRow;
  bytes: Buffer;
  fileName: string;
  contentType: string;
}) {
  const artifactId = randomUUID();
  const safeName = input.fileName.replace(/[^a-z0-9._-]+/gi, '-').slice(-120) || 'cover-letter.pdf';
  const blob = await put(`users/${input.application.user_id}/documents/${artifactId}-${safeName}`, input.bytes, {
    access: 'public',
    contentType: input.contentType,
  });
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
  const previous = await canonicalStoredCoverLetter(input.application.user_id, input.application.id);
  try {
    const stored = await db.transaction(async (tx) => {
      await tx.update(application_artifacts).set({ selected: false }).where(and(
        eq(application_artifacts.application_id, input.application.id),
        eq(application_artifacts.purpose, 'cover_letter'),
      ));
      await tx.insert(artifacts).values({
        id: artifactId,
        user_id: input.application.user_id,
        kind: 'cover_letter',
        structured_content: content,
        rendered_object_key: blob.pathname,
        rendered_blob_url: blob.url,
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
        rendered_object_key: blob.pathname,
        rendered_blob_url: blob.url,
      });
      await tx.insert(application_artifacts).values({
        application_id: input.application.id,
        artifact_id: artifactId,
        purpose: 'cover_letter',
        selected: true,
      });
      const [row] = await tx.select().from(artifacts).where(eq(artifacts.id, artifactId)).limit(1);
      return row;
    });
    if (!stored) throw new Error('Cover letter upload returned no artifact');
    if (previous?.row.rendered_blob_url && previous.row.rendered_blob_url !== blob.url) {
      await del(previous.row.rendered_blob_url).catch(() => undefined);
    }
    return { cover_letter: publicCoverLetter(stored), blob_url: blob.url };
  } catch (error) {
    await del(blob.url).catch(() => undefined);
    throw error;
  }
}

export async function deleteCanonicalCoverLetters(input: {
  userId: string;
  applicationId: string;
  legacyPacketId?: string | null;
}) {
  const rows = await db.select({ artifact: artifacts }).from(application_artifacts)
    .innerJoin(artifacts, eq(artifacts.id, application_artifacts.artifact_id)).where(and(
      eq(application_artifacts.application_id, input.applicationId),
      eq(application_artifacts.purpose, 'cover_letter'),
      eq(artifacts.user_id, input.userId),
      isNull(artifacts.deleted_at),
    ));
  const now = new Date();
  const deletedArtifactIds = new Set<string>();
  await db.transaction(async (tx) => {
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
    if (input.legacyPacketId) {
      const [packet] = await tx.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, input.legacyPacketId),
        eq(generated_resumes.user_id, input.userId),
      )).limit(1);
      if (packet) {
        const spec = packet.spec && typeof packet.spec === 'object' ? packet.spec as Record<string, unknown> : {};
        const { _cover_letter: _removed, ...next } = spec;
        await tx.update(generated_resumes).set({ spec: next }).where(eq(generated_resumes.id, packet.id));
      }
    }
  });
  for (const row of rows) {
    if (!deletedArtifactIds.has(row.artifact.id)) continue;
    const url = row.artifact.rendered_blob_url
      ?? (row.artifact.rendered_object_key ? await resolveBlobUrl(row.artifact.rendered_object_key).catch(() => null) : null);
    if (url) await del(url).catch(() => undefined);
  }
}
