import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  application_artifacts,
  applications,
  artifact_versions,
  artifacts,
} from '../db/schema';
import {
  preparedSendLifecycle,
  unpreparedSendLifecycle,
} from './canonicalApplicationLifecycle';
import { immutableDocumentContentHash } from './immutableDocumentHash';
import { resumeLinkageColumns } from './resumeLinkage';

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
    /* LINKING A PACKET IS ATTACHING ITS RESUME, and until 2026-09-03 this wrote the pointer and
       none of the three columns that say so. This is the path every tailor takes, so the row it
       left behind read "a resume artifact is selected and no resume is attached" for any
       application whose dashboard fill had not separately sent the pair. Six of Mehek's ten boards
       were in that state on 2026-09-03, each with a PASSED packet audit binding an exact PDF.
       preserveAttachedAt because a re-tailor repoints an application at a new document; it is not
       the moment this application first got a resume. */
    ...resumeLinkageColumns({ kind: 'artifact', artifactId: input.artifactId }, { preserveAttachedAt: true }),
    // Tailoring an already submitted application replaces its document pointer, not its history.
    tracker_state: sql`case when ${terminalLifecycle} then 'applied' else 'applying' end`,
    review_state: sql`case when ${terminalLifecycle} then ${applications.review_state} else 'ready' end`,
    /* A fresh tailor repoints this row at a new packet, so any prepared hold it was advertising
       belonged to the old one and is now gone. Releasing it here keeps the stored pair and the
       read heal saying the same thing, instead of leaving the row claiming a filled employer form
       that no packet holds. It cannot move a receipt backwards: the terminal arm wins first. */
    submission_state: sql`case
      when ${terminalLifecycle} then ${applications.submission_state}
      when ${applications.submission_state} = ${preparedSendLifecycle.submissionState} then ${unpreparedSendLifecycle.submissionState}
      else ${applications.submission_state}
    end`,
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
  /* THE LINK CARRIES THE CLOCK THE APPLICATION CARRIES. The authoritative projection proves a
     managed receipt's document tuple only when the selected resume link's attached_at equals the
     application's resume_attached_at (lib/authoritativeSubmissionProjection.ts,
     generatedDocumentChecks). Until now nothing on this path wrote the link's stamp at all: the
     application got its four linkage columns above, the link got `selected`, and attached_at stayed
     NULL on every link this function ever selected. The 2026-09-04 migration stamped the links that
     existed then; Bear Robotics b822b998 was re-tailored an hour later, pressed Send the next day,
     captured Breezy's receipt, and parked with `link.attached_at=null` as the whole reason. Coalesce,
     for the same reason resume_attached_at coalesces: a re-tailor is not a re-attach. */
  await tx.update(application_artifacts).set({
    selected: true,
    attached_at: sql`coalesce(${application_artifacts.attached_at}, ${linked.resume_attached_at ?? new Date()})`,
  }).where(and(
    eq(application_artifacts.application_id, input.applicationId),
    eq(application_artifacts.artifact_id, input.artifactId),
    eq(application_artifacts.purpose, 'resume'),
  ));
  return linked;
}

/**
 * THE LINKAGE A SELECTED ARTIFACT IMPLIES, completed where it is absent.
 *
 * Two shapes this module's own earlier writes left behind, both fatal to a managed receipt's
 * document tuple (lib/authoritativeSubmissionProjection.ts, generatedDocumentChecks):
 *
 *   - the selected resume link's attached_at is NULL beside an application that knows when its
 *     resume was attached (Bear Robotics b822b998, 2026-09-05: `link.attached_at=null`);
 *   - the application points at a selected artifact and still says (resume_attached false,
 *     resume_source 'none', resume_attached_at null) - the pre-2026-09-03 tailor shape the
 *     2026-09-04 migration completed for the rows that existed then, and which this account's
 *     Deepgram row 8c6485c4 still wore at 04:48Z today: `application.resume_attached=false`,
 *     `application.resume_source=none`, `application.resume_attached_at=null`, `link.attached_at=null`.
 *
 * The plan is pure (resumeLinkageCompletionPlan) so it can be tested against those exact rows; this
 * applies it. It completes ONLY absent values, on ONE clock: the application's resume_attached_at
 * where it exists, else the link's, else now. Nothing that already carries a value is overwritten,
 * an artifact that is not this packet's own is never linked, and an application that names some
 * OTHER source (base_resume) beside a selected artifact is left disagreeing for the projection to
 * refuse. Returns whether anything was written.
 */
export type ResumeLinkageCompletionPlan = {
  applicationPatch: { resume_attached: true; resume_source: 'artifact'; resume_attached_at: Date } | null;
  link: 'insert' | 'stamp' | null;
  clock: Date;
};

export function resumeLinkageCompletionPlan(input: {
  application: {
    selected_resume_artifact_id: string | null;
    resume_attached: boolean;
    resume_source: string;
    resume_attached_at: Date | null;
  };
  /** The selected artifact, when it exists, is not deleted, and belongs to the packet being repaired. */
  artifactBelongsToPacket: boolean;
  link: { attached_at: Date | null } | null;
  now: Date;
}): ResumeLinkageCompletionPlan | null {
  const { application, link } = input;
  if (!application.selected_resume_artifact_id || !input.artifactBelongsToPacket) return null;
  if (application.resume_source !== 'artifact' && application.resume_source !== 'none') return null;
  if (application.resume_source === 'none' && application.resume_attached) return null;
  const clock = application.resume_attached_at ?? link?.attached_at ?? input.now;
  const applicationComplete = application.resume_attached
    && application.resume_source === 'artifact'
    && application.resume_attached_at !== null;
  const applicationPatch = applicationComplete
    ? null
    : { resume_attached: true as const, resume_source: 'artifact' as const, resume_attached_at: clock };
  const linkAction: 'insert' | 'stamp' | null = link === null
    ? 'insert'
    : link.attached_at === null ? 'stamp' : null;
  if (!applicationPatch && !linkAction) return null;
  return { applicationPatch, link: linkAction, clock };
}

export async function completeSelectedResumeLinkage(
  tx: ArtifactVersionTransaction,
  input: { userId: string; applicationId: string; packetId: string; now?: Date },
): Promise<boolean> {
  const [application] = await tx.select({
    selected_resume_artifact_id: applications.selected_resume_artifact_id,
    resume_attached: applications.resume_attached,
    resume_attached_at: applications.resume_attached_at,
    resume_source: applications.resume_source,
  }).from(applications).where(and(
    eq(applications.id, input.applicationId),
    eq(applications.user_id, input.userId),
  )).limit(1);
  if (!application?.selected_resume_artifact_id) return false;
  const [artifact] = await tx.select({ id: artifacts.id }).from(artifacts).where(and(
    eq(artifacts.id, application.selected_resume_artifact_id),
    eq(artifacts.user_id, input.userId),
    eq(artifacts.legacy_generated_resume_id, input.packetId),
    sql`${artifacts.deleted_at} is null`,
  )).limit(1);
  const [link] = await tx.select({ attached_at: application_artifacts.attached_at }).from(application_artifacts).where(and(
    eq(application_artifacts.application_id, input.applicationId),
    eq(application_artifacts.artifact_id, application.selected_resume_artifact_id),
    eq(application_artifacts.purpose, 'resume'),
  )).limit(1);
  const plan = resumeLinkageCompletionPlan({
    application: {
      selected_resume_artifact_id: application.selected_resume_artifact_id,
      resume_attached: application.resume_attached,
      resume_source: application.resume_source,
      resume_attached_at: application.resume_attached_at,
    },
    artifactBelongsToPacket: Boolean(artifact),
    link: link ? { attached_at: link.attached_at } : null,
    now: input.now ?? new Date(),
  });
  if (!plan) return false;
  if (plan.applicationPatch) {
    await tx.update(applications).set({
      ...plan.applicationPatch,
      updated_at: new Date(),
    }).where(and(
      eq(applications.id, input.applicationId),
      eq(applications.user_id, input.userId),
    ));
  }
  if (plan.link === 'insert') {
    await tx.insert(application_artifacts).values({
      application_id: input.applicationId,
      artifact_id: application.selected_resume_artifact_id,
      purpose: 'resume',
      selected: true,
      attached_at: plan.clock,
    }).onConflictDoNothing();
  } else if (plan.link === 'stamp') {
    await tx.update(application_artifacts).set({ attached_at: plan.clock }).where(and(
      eq(application_artifacts.application_id, input.applicationId),
      eq(application_artifacts.artifact_id, application.selected_resume_artifact_id),
      eq(application_artifacts.purpose, 'resume'),
      sql`${application_artifacts.attached_at} is null`,
    ));
  }
  return true;
}

/** The narrow predecessor of completeSelectedResumeLinkage, kept for its callers: stamp only. */
export async function stampSelectedResumeLinkAttachedAt(
  tx: ArtifactVersionTransaction,
  input: { userId: string; applicationId: string },
): Promise<boolean> {
  const [application] = await tx.select({
    selected_resume_artifact_id: applications.selected_resume_artifact_id,
    resume_attached_at: applications.resume_attached_at,
    resume_source: applications.resume_source,
  }).from(applications).where(and(
    eq(applications.id, input.applicationId),
    eq(applications.user_id, input.userId),
  )).limit(1);
  if (!application?.selected_resume_artifact_id
    || !application.resume_attached_at
    || application.resume_source !== 'artifact') return false;
  const stamped = await tx.update(application_artifacts).set({
    attached_at: application.resume_attached_at,
  }).where(and(
    eq(application_artifacts.application_id, input.applicationId),
    eq(application_artifacts.artifact_id, application.selected_resume_artifact_id),
    eq(application_artifacts.purpose, 'resume'),
    sql`${application_artifacts.attached_at} is null`,
  )).returning({ artifact_id: application_artifacts.artifact_id });
  return stamped.length > 0;
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
        // Same fact, same single spelling of it: a first user edit that mints the canonical
        // artifact is also the write that binds it to this application.
        ...resumeLinkageColumns({ kind: 'artifact', artifactId: artifact.id }, { preserveAttachedAt: true }),
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
