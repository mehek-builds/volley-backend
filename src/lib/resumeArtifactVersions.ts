import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  application_artifacts,
  applications,
  artifact_versions,
  artifacts,
} from '../db/schema';
import { immutableDocumentContentHash } from './immutableDocumentHash';

type ArtifactVersionTransaction = Pick<typeof db, 'select' | 'insert' | 'update'>;

/**
 * Return the immutable blob URL stored beside the exact generated-resume object key.
 *
 * The generated packet table intentionally keeps only an object key. Resolving that key through
 * Vercel Blob list() is an eventually consistent lookup, while both the canonical artifact and its
 * immutable versions keep the strong URL returned by put(). Submission should use that strong
 * pointer when it exists, but it must be scoped to the packet owner and legacy packet id so an
 * arbitrary object key can never become a cross-account read capability.
 */
export async function storedGeneratedResumeBlobUrl(
  input: { userId: string; generatedResumeId: string; objectKey: string },
  database: Pick<typeof db, 'select'> = db,
): Promise<string | null> {
  const [version] = await database.select({ blobUrl: artifact_versions.rendered_blob_url })
    .from(artifact_versions)
    .innerJoin(artifacts, eq(artifact_versions.artifact_id, artifacts.id))
    .where(and(
      eq(artifacts.user_id, input.userId),
      eq(artifacts.legacy_generated_resume_id, input.generatedResumeId),
      eq(artifact_versions.rendered_object_key, input.objectKey),
    ))
    .limit(1);
  const versionUrl = version?.blobUrl?.trim();
  if (versionUrl) return versionUrl;

  const [artifact] = await database.select({ blobUrl: artifacts.rendered_blob_url })
    .from(artifacts)
    .where(and(
      eq(artifacts.user_id, input.userId),
      eq(artifacts.legacy_generated_resume_id, input.generatedResumeId),
      eq(artifacts.rendered_object_key, input.objectKey),
    ))
    .limit(1);
  return artifact?.blobUrl?.trim() || null;
}

export async function linkGeneratedPacketToCanonicalApplication(
  tx: ArtifactVersionTransaction,
  input: {
    userId: string;
    applicationId: string;
    generatedResumeId: string;
    artifactId: string;
  },
) {
  const terminalLifecycle = sql`${applications.submission_state} = 'submitted' or ${applications.tracker_state} = 'applied'`;
  const [linked] = await tx.update(applications).set({
    legacy_generated_resume_id: input.generatedResumeId,
    selected_resume_artifact_id: input.artifactId,
    // Tailoring an already submitted application replaces its document pointer, not its history.
    tracker_state: sql`case when ${terminalLifecycle} then 'applied' else 'applying' end`,
    review_state: sql`case when ${terminalLifecycle} then ${applications.review_state} else 'ready' end`,
    updated_at: new Date(),
  }).where(and(
    eq(applications.id, input.applicationId),
    eq(applications.user_id, input.userId),
  )).returning();
  if (!linked) throw new Error('Canonical application changed before its generated packet was linked');
  await tx.update(application_artifacts).set({ selected: false }).where(and(
    eq(application_artifacts.application_id, input.applicationId),
    eq(application_artifacts.purpose, 'resume'),
  ));
  await tx.update(application_artifacts).set({ selected: true }).where(and(
    eq(application_artifacts.application_id, input.applicationId),
    eq(application_artifacts.artifact_id, input.artifactId),
    eq(application_artifacts.purpose, 'resume'),
  ));
  return linked;
}

export async function appendEditedResumeArtifactVersion(
  tx: ArtifactVersionTransaction,
  input: {
    userId: string;
    legacyGeneratedResumeId: string;
    structuredContent: unknown;
    jobContext: unknown;
    renderedObjectKey: string;
    renderedBlobUrl: string;
  },
): Promise<{ artifactId: string; versionNumber: number }> {
  let [artifact] = await tx.select().from(artifacts).where(and(
    eq(artifacts.user_id, input.userId),
    eq(artifacts.legacy_generated_resume_id, input.legacyGeneratedResumeId),
  )).limit(1);

  if (!artifact) {
    const artifactId = randomUUID();
    [artifact] = await tx.insert(artifacts).values({
      id: artifactId,
      user_id: input.userId,
      legacy_generated_resume_id: input.legacyGeneratedResumeId,
      kind: 'tailored_resume',
      structured_content: input.structuredContent,
      rendered_object_key: input.renderedObjectKey,
      rendered_blob_url: input.renderedBlobUrl,
      source: 'user_edited_resume',
    }).returning();
    const [application] = await tx.select({ id: applications.id }).from(applications).where(and(
      eq(applications.user_id, input.userId),
      eq(applications.legacy_generated_resume_id, input.legacyGeneratedResumeId),
    )).limit(1);
    if (application) {
      await tx.insert(application_artifacts).values({
        application_id: application.id,
        artifact_id: artifact.id,
        purpose: 'resume',
        selected: true,
      }).onConflictDoNothing();
      await tx.update(applications).set({
        selected_resume_artifact_id: artifact.id,
        updated_at: new Date(),
      }).where(and(eq(applications.id, application.id), eq(applications.user_id, input.userId)));
    }
  } else {
    [artifact] = await tx.update(artifacts).set({
      kind: artifact.kind === 'resume' ? 'resume' : 'tailored_resume',
      structured_content: input.structuredContent,
      rendered_object_key: input.renderedObjectKey,
      rendered_blob_url: input.renderedBlobUrl,
      source: 'user_edited_resume',
      updated_at: new Date(),
    }).where(and(eq(artifacts.id, artifact.id), eq(artifacts.user_id, input.userId))).returning();
  }

  const [latest] = await tx.select({
    version_number: sql<number>`coalesce(max(${artifact_versions.version_number}), 0)`,
  }).from(artifact_versions).where(eq(artifact_versions.artifact_id, artifact.id));
  const versionNumber = Number(latest?.version_number ?? 0) + 1;
  await tx.insert(artifact_versions).values({
    artifact_id: artifact.id,
    version_number: versionNumber,
    generation_source: 'user_edited_resume',
    job_context: input.jobContext,
    content_hash: immutableDocumentContentHash(input.structuredContent),
    structured_content: input.structuredContent,
    rendered_object_key: input.renderedObjectKey,
    rendered_blob_url: input.renderedBlobUrl,
  });
  return { artifactId: artifact.id, versionNumber };
}
