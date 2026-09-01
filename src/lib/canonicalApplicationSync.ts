import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  application_artifacts,
  applications,
  artifacts,
  generated_resumes,
} from '../db/schema';
import { readApplicationReview } from './applicationReview';
import { confirmedSubmissionLifecycle } from './canonicalApplicationLifecycle';
import {
  canonicalApplicationForAttemptProjection,
  frozenPostingIdentitiesMatch,
} from './canonicalPacketBinding';
import { freezePostingIdentity, type FrozenPostingIdentity } from './submissionAttemptLedger';

export type CanonicalApplicationSyncInput = {
  attemptId?: string;
  packetId: string;
  userId: string;
  applicationId?: string | null;
  packetVersion?: string | null;
  postingIdentity?: FrozenPostingIdentity;
  canonicalDocumentTuple?: {
    selectedResumeArtifactId: string | null;
    resumeAttached: boolean;
    resumeSource: 'artifact' | 'base_resume' | 'none';
    resumeAttachedAt: Date | null;
  };
};

type CanonicalApplicationSyncExecutor = Pick<typeof db, 'select' | 'update'>;

const trackerLifecycleRank: Record<string, number> = {
  saved: 0,
  applying: 1,
  applied: 2,
  interview: 3,
  offer: 4,
  closed: 5,
};

export class CanonicalApplicationProjectionConflictError extends Error {
  readonly code = 'CANONICAL_APPLICATION_PROJECTION_CONFLICT';

  constructor() {
    super('The exact canonical application changed before its submission receipt was projected.');
    this.name = 'CanonicalApplicationProjectionConflictError';
  }
}

/* One exact immutable attempt binding selects the tracker row. The current packet pointer is not
 * consulted here: a user may tailor packet B after packet A crossed the employer boundary, and A's
 * receipt must still close the canonical row named by its opening fact. The caller owns the same
 * transaction and submission-user lock as the confirmation fact and packet projection. */
export async function syncCanonicalApplicationRow(
  input: CanonicalApplicationSyncInput,
  executor: CanonicalApplicationSyncExecutor = db,
): Promise<typeof applications.$inferSelect> {
  if (!input.postingIdentity) {
    const [current] = await executor.select().from(applications).where(and(
      eq(applications.legacy_generated_resume_id, input.packetId),
      eq(applications.user_id, input.userId),
    )).limit(1);
    if (!current) throw new CanonicalApplicationProjectionConflictError();
    const [updated] = await executor.update(applications).set({
      submission_state: confirmedSubmissionLifecycle.submissionState,
      tracker_state: confirmedSubmissionLifecycle.trackerState,
      // Same rule as the projection write below: a confirmed send is always visible.
      removed_at: null,
      updated_at: new Date(),
    }).where(and(
      eq(applications.id, current.id),
      eq(applications.user_id, input.userId),
    )).returning();
    if (!updated) throw new CanonicalApplicationProjectionConflictError();
    return updated;
  }
  const current = await canonicalApplicationForAttemptProjection(executor, {
    attemptId: input.attemptId,
    userId: input.userId,
    packetId: input.packetId,
    applicationId: input.applicationId,
    packetVersion: input.packetVersion,
    postingIdentity: input.postingIdentity,
  });
  const nextSubmissionState = confirmedSubmissionLifecycle.submissionState;
  const nextTrackerState = (trackerLifecycleRank[current.tracker_state] ?? 0)
    >= trackerLifecycleRank[confirmedSubmissionLifecycle.trackerState]!
    ? current.tracker_state
    : confirmedSubmissionLifecycle.trackerState;
  let receiptPacketId = current.legacy_generated_resume_id;
  let receiptArtifactId = current.selected_resume_artifact_id;
  let receiptResumeAttached = current.resume_attached;
  let receiptResumeSource = current.resume_source;
  let receiptResumeAttachedAt = current.resume_attached_at;
  const [packet] = await executor.select().from(generated_resumes).where(and(
    eq(generated_resumes.id, input.packetId),
    eq(generated_resumes.user_id, input.userId),
  )).limit(1);
  if (!packet) {
    // A canonical-only Free attempt identifies its application as the packet key. It has no
    // generated document, so terminal state must not inherit a mutable packet pointer or artifact
    // from an unrelated tailoring pass.
    if (input.packetId !== (input.applicationId ?? current.id)) {
      throw new CanonicalApplicationProjectionConflictError();
    }
    receiptPacketId = null;
    // Canonical-only Free submissions may attach an exact artifact without generating a packet.
    // The immutable opening freezes that document separately. Clearing it here both destroys the
    // receipt-to-document projection and violates the attachment-state constraint. Base-resume and
    // no-resume selections intentionally have no selected artifact id.
    const exactTuple = input.canonicalDocumentTuple;
    if (!exactTuple) {
      throw new CanonicalApplicationProjectionConflictError();
    }
    receiptArtifactId = exactTuple.selectedResumeArtifactId;
    receiptResumeAttached = exactTuple.resumeAttached;
    receiptResumeSource = exactTuple.resumeSource;
    receiptResumeAttachedAt = exactTuple.resumeAttachedAt;
    if ((receiptResumeSource === 'artifact') !== Boolean(receiptArtifactId)
      || receiptResumeAttached !== (receiptResumeSource !== 'none')) {
      throw new CanonicalApplicationProjectionConflictError();
    }
  } else {
    const packetReview = readApplicationReview(packet.spec);
    const packetPosting = freezePostingIdentity(packet.job_context, packetReview?.portal_url);
    if (!frozenPostingIdentitiesMatch(packetPosting, input.postingIdentity)) {
      throw new CanonicalApplicationProjectionConflictError();
    }
    const links = await executor.select({
      artifactId: artifacts.id,
      attachedAt: application_artifacts.attached_at,
    })
      .from(application_artifacts)
      .innerJoin(artifacts, eq(application_artifacts.artifact_id, artifacts.id))
      .where(and(
        eq(application_artifacts.application_id, current.id),
        eq(application_artifacts.purpose, 'resume'),
        eq(artifacts.user_id, input.userId),
        eq(artifacts.legacy_generated_resume_id, input.packetId),
      ));
    const exactArtifacts = [...new Set(links.map((link) => link.artifactId))];
    if (exactArtifacts.length !== 1) throw new CanonicalApplicationProjectionConflictError();
    receiptPacketId = input.packetId;
    receiptArtifactId = exactArtifacts[0]!;
    receiptResumeAttached = true;
    receiptResumeSource = 'artifact';
    receiptResumeAttachedAt = links[0]!.attachedAt;
  }
  const tupleChanged = receiptPacketId !== current.legacy_generated_resume_id
    || receiptArtifactId !== current.selected_resume_artifact_id
    || receiptResumeAttached !== current.resume_attached
    || receiptResumeSource !== current.resume_source
    || receiptResumeAttachedAt?.getTime() !== current.resume_attached_at?.getTime();
  const selectedResumeLinks = await executor.select({ artifactId: application_artifacts.artifact_id })
    .from(application_artifacts)
    .where(and(
      eq(application_artifacts.application_id, current.id),
      eq(application_artifacts.purpose, 'resume'),
      eq(application_artifacts.selected, true),
    ));
  const selectedTupleCoherent = receiptArtifactId
    ? selectedResumeLinks.length === 1 && selectedResumeLinks[0]!.artifactId === receiptArtifactId
    : selectedResumeLinks.length === 0;
  if (current.submission_state === nextSubmissionState
    && current.tracker_state === nextTrackerState
    && !tupleChanged
    && selectedTupleCoherent) return current;

  let updated = current;
  if (current.submission_state !== nextSubmissionState
    || current.tracker_state !== nextTrackerState
    || tupleChanged) {
    [updated] = await executor.update(applications).set({
      submission_state: nextSubmissionState,
      tracker_state: nextTrackerState,
      legacy_generated_resume_id: receiptPacketId,
      selected_resume_artifact_id: receiptArtifactId,
      resume_attached: receiptResumeAttached,
      resume_source: receiptResumeSource,
      resume_attached_at: receiptResumeAttachedAt,
      /* ANYTHING THAT REACHED AN EMPLOYER IS VISIBLE, WITHOUT EXCEPTION.
       *
       * Removal refuses an application that is being sent, but it cannot refuse one that is not
       * being sent YET: a client holding a cached application id - the extension is the obvious
       * one - can press Send after the row was taken off the Tracker. Without this, that send
       * succeeds and the row keeps its removed stamp, so a real submission to a real employer
       * exists that the student can never see on any surface. That is the precise outcome the
       * removal guard exists to prevent, arrived at from the other side.
       *
       * Clearing it here rather than refusing the send is deliberate. Refusing would break an
       * in-flight send over a bookkeeping flag, and the student's intent when they press Send is
       * not in doubt. It is the same rule as reviving on re-add: if it comes back, it comes back
       * visible. */
      removed_at: null,
      updated_at: new Date(),
    }).where(and(
      eq(applications.id, current.id),
      eq(applications.user_id, input.userId),
      sql`${applications.legacy_generated_resume_id} is not distinct from ${current.legacy_generated_resume_id}`,
      sql`${applications.selected_resume_artifact_id} is not distinct from ${current.selected_resume_artifact_id}`,
      eq(applications.resume_attached, current.resume_attached),
      eq(applications.resume_source, current.resume_source),
      sql`${applications.resume_attached_at} is not distinct from ${current.resume_attached_at}`,
      eq(applications.submission_state, current.submission_state),
      eq(applications.tracker_state, current.tracker_state),
    )).returning();
    if (!updated) throw new CanonicalApplicationProjectionConflictError();
  }
  if (tupleChanged || !selectedTupleCoherent) {
    await executor.update(application_artifacts).set({ selected: false }).where(and(
      eq(application_artifacts.application_id, current.id),
      eq(application_artifacts.purpose, 'resume'),
    ));
    if (receiptArtifactId) {
      const selected = await executor.update(application_artifacts).set({ selected: true }).where(and(
        eq(application_artifacts.application_id, current.id),
        eq(application_artifacts.artifact_id, receiptArtifactId),
        eq(application_artifacts.purpose, 'resume'),
      )).returning({ artifactId: application_artifacts.artifact_id });
      if (selected.length !== 1) throw new CanonicalApplicationProjectionConflictError();
    }
  }
  return updated;
}

export type CanonicalApplicationSyncDeps = {
  sync?: (input: CanonicalApplicationSyncInput) => Promise<unknown>;
};

/* Legacy review-only paths may still ask for a best-effort tracker heal after their packet write.
 * Exact receipt sinks never use this wrapper: they call syncCanonicalApplicationRow inside their
 * fact plus packet transaction so a missing row or CAS loss rolls the whole acknowledgement back. */
export async function advanceCanonicalApplicationFromPacketSubmission(
  input: CanonicalApplicationSyncInput,
  deps: CanonicalApplicationSyncDeps = {},
): Promise<void> {
  try {
    await (deps.sync ?? syncCanonicalApplicationRow)(input);
  } catch (error) {
    console.warn('[canonical-sync] failed to advance the application row', { packetId: input.packetId, error });
  }
}
