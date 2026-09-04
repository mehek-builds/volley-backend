import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  application_artifacts,
  application_submission_attempt_events,
  application_submission_events,
  applications,
  artifacts,
} from '../db/schema';
import {
  freezePostingIdentity,
  type FrozenPostingIdentity,
  type SubmissionAttemptBinding,
} from './submissionAttemptLedger';
import { parseCanonicalFreeVersionedDocumentBinding } from './canonicalFreeDocumentBinding';

export type CanonicalPacketBindingExecutor = Pick<typeof db, 'select'>;

/** `canonicalApplicationForNewPacketAttempt` alone needs to heal a stale label, so it alone needs
 * write access. Every other function in this file stays read-only. */
export type CanonicalPacketBindingWriteExecutor = CanonicalPacketBindingExecutor & Pick<typeof db, 'update'>;

/* A job id lives on `applications.job_id`, a `uuid` column, so a healed value must have that exact
 * shape or Postgres refuses the whole update - which must never take the packet's send down with
 * it. Same layout `applicationPortalRepair.ts:jobContextJobId` already holds `job_context.job_id`
 * to, because both read the same `monitored_jobs.id`. */
const CANONICAL_JOB_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CanonicalPacketBindingError extends Error {
  constructor(readonly code:
    | 'CANONICAL_PACKET_BINDING_MISSING'
    | 'CANONICAL_PACKET_BINDING_AMBIGUOUS'
    | 'CANONICAL_PACKET_BINDING_FOREIGN_OWNER'
    | 'CANONICAL_PACKET_POSTING_MISMATCH') {
    super(code === 'CANONICAL_PACKET_BINDING_MISSING'
      ? 'The generated packet has no owned canonical application binding.'
      : code === 'CANONICAL_PACKET_BINDING_AMBIGUOUS'
        ? 'The generated packet has more than one owned canonical application binding.'
        : code === 'CANONICAL_PACKET_BINDING_FOREIGN_OWNER'
          ? 'The immutable attempt names a live canonical application owned by another account.'
        : 'The canonical application does not match the posting frozen for this attempt.');
    this.name = 'CanonicalPacketBindingError';
  }
}

export function canonicalApplicationMatchesFrozenPosting(
  application: Pick<typeof applications.$inferSelect,
  'company_name' | 'role' | 'job_id' | 'portal_url'>,
  frozen: FrozenPostingIdentity,
): boolean {
  const candidate = freezePostingIdentity({
    company: application.company_name,
    role: application.role,
    job_id: application.job_id,
  }, application.portal_url);
  return frozenPostingIdentitiesMatch(candidate, frozen);
}

export function frozenPostingIdentitiesMatch(
  candidate: FrozenPostingIdentity,
  frozen: FrozenPostingIdentity,
): boolean {
  if (frozen.companyRole && candidate.companyRole !== frozen.companyRole) return false;
  if (frozen.jobId && candidate.jobId !== frozen.jobId) return false;
  if (frozen.portalIdentity && candidate.portalIdentity !== frozen.portalIdentity) return false;
  if (frozen.postingKey) return candidate.postingKey === frozen.postingKey;
  if (frozen.jobId) return candidate.jobId === frozen.jobId;
  return Boolean(
    frozen.companyRole
    && candidate.companyRole === frozen.companyRole
    && frozen.portalUrl
    && candidate.portalUrl === frozen.portalUrl,
  );
}

async function immutablePacketLinkCandidates(
  executor: CanonicalPacketBindingExecutor,
  input: { userId: string; packetId: string },
): Promise<Array<typeof applications.$inferSelect>> {
  const rows = await executor.select({ application: applications })
    .from(application_artifacts)
    .innerJoin(artifacts, eq(application_artifacts.artifact_id, artifacts.id))
    .innerJoin(applications, eq(application_artifacts.application_id, applications.id))
    .where(and(
      eq(applications.user_id, input.userId),
      eq(artifacts.user_id, input.userId),
      eq(artifacts.legacy_generated_resume_id, input.packetId),
    ));
  return rows.map((row) => row.application);
}

/**
 * Resolve only through the immutable artifact graph. Pointer-move code uses this stricter form to
 * prove a legacy null-id opening will remain recoverable after the mutable pointer changes.
 */
export async function canonicalApplicationForImmutablePacketLink(
  executor: CanonicalPacketBindingExecutor,
  input: { userId: string; packetId: string; postingIdentity: FrozenPostingIdentity },
): Promise<typeof applications.$inferSelect> {
  return oneExactCandidate(
    await immutablePacketLinkCandidates(executor, input),
    input.postingIdentity,
  );
}

async function currentPacketPointerCandidates(
  executor: CanonicalPacketBindingExecutor,
  input: { userId: string; packetId: string },
): Promise<Array<typeof applications.$inferSelect>> {
  return executor.select().from(applications).where(and(
    eq(applications.user_id, input.userId),
    eq(applications.legacy_generated_resume_id, input.packetId),
  ));
}

function canonicalFreeBoundArtifactId(packetVersion: string | null | undefined): string | null {
  return parseCanonicalFreeVersionedDocumentBinding(packetVersion)?.artifactId ?? null;
}

async function canonicalFreeDocumentCandidates(
  executor: CanonicalPacketBindingExecutor,
  input: { userId: string; packetVersion?: string | null },
): Promise<Array<typeof applications.$inferSelect>> {
  const artifactId = canonicalFreeBoundArtifactId(input.packetVersion);
  if (!artifactId) return [];
  const rows = await executor.select({ application: applications })
    .from(application_artifacts)
    .innerJoin(artifacts, eq(application_artifacts.artifact_id, artifacts.id))
    .innerJoin(applications, eq(application_artifacts.application_id, applications.id))
    .where(and(
      eq(applications.user_id, input.userId),
      eq(artifacts.user_id, input.userId),
      eq(artifacts.id, artifactId),
    ));
  return rows.map((row) => row.application);
}

async function canonicalFreeConfirmedReceiptCandidate(
  executor: CanonicalPacketBindingExecutor,
  input: {
    userId: string;
    attemptId: string;
    postingIdentity: FrozenPostingIdentity;
  },
): Promise<typeof applications.$inferSelect | null> {
  const confirmations = await executor.select({
    observedAt: application_submission_attempt_events.observed_at,
  }).from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, input.userId),
    eq(application_submission_attempt_events.attempt_id, input.attemptId),
    eq(application_submission_attempt_events.event_kind, 'submission_confirmed'),
  ));
  const confirmationTimes = new Set(confirmations.map((row) => row.observedAt.toISOString()));
  if (confirmationTimes.size === 0) return null;
  const rows = await executor.select({
    application: applications,
    finalUrl: application_submission_events.final_url,
    observedAt: application_submission_events.observed_at,
  }).from(application_submission_events)
    .innerJoin(applications, eq(application_submission_events.application_id, applications.id))
    .where(and(
      eq(application_submission_events.user_id, input.userId),
      eq(application_submission_events.event_id, input.attemptId),
      eq(application_submission_events.outcome, 'confirmed'),
      eq(applications.user_id, input.userId),
    ));
  const exact = [...new Map(rows.flatMap((row) => {
    if (!confirmationTimes.has(row.observedAt.toISOString()) || !row.finalUrl) return [];
    const receiptPosting = freezePostingIdentity({
      company: row.application.company_name,
      role: row.application.role,
      job_id: row.application.job_id,
    }, row.finalUrl);
    return frozenPostingIdentitiesMatch(receiptPosting, input.postingIdentity)
      ? [[row.application.id, row.application] as const]
      : [];
  })).values()];
  if (exact.length === 0) return null;
  if (exact.length !== 1) {
    throw new CanonicalPacketBindingError('CANONICAL_PACKET_BINDING_AMBIGUOUS');
  }
  return exact[0]!;
}

function oneExactCandidate(
  candidates: Array<typeof applications.$inferSelect>,
  frozen: FrozenPostingIdentity,
): typeof applications.$inferSelect {
  const exact = [...new Map(candidates
    .filter((candidate) => canonicalApplicationMatchesFrozenPosting(candidate, frozen))
    .map((candidate) => [candidate.id, candidate])).values()];
  if (exact.length === 0) throw new CanonicalPacketBindingError('CANONICAL_PACKET_BINDING_MISSING');
  if (exact.length !== 1) throw new CanonicalPacketBindingError('CANONICAL_PACKET_BINDING_AMBIGUOUS');
  return exact[0]!;
}

/**
 * Heal a CURRENT pointer's stale posting-identity columns toward the packet's own live identity.
 *
 * `applications.company_name`/`role`/`job_id`/`portal_url` are a snapshot written once, at the
 * generating INSERT (src/routes/resume.ts) or at linkGeneratedPacketToCanonicalApplication, and
 * never refreshed afterward - no writer in canonicalApplicationSync.ts touches them again. But the
 * PACKET's own posting identity is not static: repairReviewPortalFromMonitoredJob restores
 * `_review.portal_url` from `monitored_jobs.apply_url` on every prepare (submissionRunner.ts
 * prepare(), and the submit-request route before it), because a job board's displayed URL and its
 * actual apply destination can carry different provider tokens for the same posting - measured on
 * Hudson River Trading itself, packet 4a79eec1, 2026-09-02 (see the comment on keepUsedPortal in
 * applicationPortalRepair.ts): the fill ran against job-boards.greenhouse.io/wehrtyou, a board
 * token neither the posting's public URL nor the canonical row's stored portal_url would guess.
 * atsPostingKey encodes that token, and frozenPostingIdentitiesMatch requires an EXACT postingKey
 * match once one is present on the frozen side - so a canonical row created before that repair
 * last ran, or before this exact pair of prepares, silently stops matching its own packet.
 *
 * This is the fix for the DATA, not the check: the pointer (legacy_generated_resume_id, unique per
 * packet, set once via an explicit link write) already proves this row is the one and only current
 * owner of this packet for this exact user. Once that is proven, the row's posting-identity columns
 * are a label describing what the pointer already established, and the packet - fresher by
 * construction, since every fill discovers the real destination - is the more current source for
 * that label. Ownership is untouched: this never runs unless `user_id` and the unique pointer
 * already matched, and it never widens which packet a canonical row may point at.
 *
 * Conservative in one more direction: a field is only overwritten when the packet's OWN frozen
 * identity holds a real value for it. A packet that does not know its own job id must not erase one
 * the canonical row already has, because frozenPostingIdentitiesMatch never required agreement on a
 * field the frozen side leaves unset either - erasing it here would fix nothing and destroy
 * evidence for a still-unrelated reason to refuse.
 */
async function reconcileCurrentPointerPostingIdentity(
  executor: CanonicalPacketBindingWriteExecutor,
  input: { userId: string; packetId: string },
  candidate: typeof applications.$inferSelect,
  frozen: FrozenPostingIdentity,
): Promise<typeof applications.$inferSelect | null> {
  const patch: Partial<typeof applications.$inferInsert> = {};
  if (frozen.companyRole && frozen.company && frozen.company !== candidate.company_name) {
    patch.company_name = frozen.company;
  }
  if (frozen.companyRole && frozen.role && frozen.role !== candidate.role) {
    patch.role = frozen.role;
  }
  if (frozen.portalUrl && frozen.portalUrl !== candidate.portal_url) {
    patch.portal_url = frozen.portalUrl;
  }
  if (frozen.jobId && CANONICAL_JOB_ID_UUID.test(frozen.jobId) && frozen.jobId !== candidate.job_id) {
    patch.job_id = frozen.jobId;
  }
  // Nothing on the packet's own identity disagrees with a value the row actually has, so there is
  // no label this function can honestly correct. Whatever refused the match is not a stale label.
  if (Object.keys(patch).length === 0) return null;
  const [healed] = await executor.update(applications).set({
    ...patch,
    updated_at: new Date(),
  }).where(and(
    eq(applications.id, candidate.id),
    eq(applications.user_id, input.userId),
    // The pointer itself must still name this exact packet at write time, not only at read time.
    eq(applications.legacy_generated_resume_id, input.packetId),
    // CAS against the exact row this decision was made from, so a concurrent writer - another
    // heal, a fresh tailor, a consolidation - is never silently overwritten by a stale read.
    sql`${applications.company_name} is not distinct from ${candidate.company_name}`,
    sql`${applications.role} is not distinct from ${candidate.role}`,
    sql`${applications.portal_url} is not distinct from ${candidate.portal_url}`,
    sql`${applications.job_id} is not distinct from ${candidate.job_id}`,
  )).returning();
  return healed ?? null;
}

/**
 * Resolve the canonical row before an attempt is opened. The caller must already hold the shared
 * submission-user transaction lock. A new employer boundary may open only for the packet currently
 * selected by the canonical row. Immutable artifact links recover historical receipts, but they
 * cannot revive a superseded packet or silently establish a missing mutable pointer.
 *
 * A CURRENT pointer that fails only the posting-identity check is healed once, in place, and
 * re-checked - see reconcileCurrentPointerPostingIdentity for why that is a data repair and not a
 * loosened check. Healing is attempted only when the pointer query returns EXACTLY one row: zero
 * rows is a genuinely missing pointer (nothing to heal), and `applications_legacy_resume_unique`
 * guarantees it can never be more than one.
 */
export async function canonicalApplicationForNewPacketAttempt(
  executor: CanonicalPacketBindingWriteExecutor,
  input: { userId: string; packetId: string; postingIdentity: FrozenPostingIdentity },
): Promise<typeof applications.$inferSelect> {
  const candidates = await currentPacketPointerCandidates(executor, input);
  try {
    return oneExactCandidate(candidates, input.postingIdentity);
  } catch (error) {
    if (!(error instanceof CanonicalPacketBindingError)
      || error.code !== 'CANONICAL_PACKET_BINDING_MISSING'
      || candidates.length !== 1) {
      throw error;
    }
    const healed = await reconcileCurrentPointerPostingIdentity(
      executor,
      input,
      candidates[0]!,
      input.postingIdentity,
    );
    if (healed && canonicalApplicationMatchesFrozenPosting(healed, input.postingIdentity)) {
      return healed;
    }
    // Either the mismatch was not repairable from the packet's own identity, or the CAS above lost
    // to a concurrent writer. Re-read once, fresh, and answer honestly - never fabricate a match a
    // freshly-read row does not actually have.
    return oneExactCandidate(
      await currentPacketPointerCandidates(executor, input),
      input.postingIdentity,
    );
  }
}

/**
 * Resolve the exact canonical projection target for immutable attempt evidence. A still-live frozen
 * application id dominates every mutable pointer. If alias consolidation removed that row, or an
 * old opening has a null id, only one owned immutable packet-artifact link may recover the target.
 */
export async function canonicalApplicationForAttemptProjection(
  executor: CanonicalPacketBindingExecutor,
  input: Pick<SubmissionAttemptBinding,
  'userId' | 'packetId' | 'applicationId' | 'postingIdentity' | 'packetVersion'>
  & Partial<Pick<SubmissionAttemptBinding, 'attemptId'>>,
): Promise<typeof applications.$inferSelect> {
  if (input.applicationId) {
    // A live immutable application id is authoritative even when it belongs to another account.
    // Query the id before applying the owner scope so a forged cross-account id cannot masquerade
    // as a deleted alias and recover through an owned packet or document link.
    const [live] = await executor.select().from(applications).where(
      eq(applications.id, input.applicationId),
    ).limit(1);
    if (live && live.user_id !== input.userId) {
      throw new CanonicalPacketBindingError('CANONICAL_PACKET_BINDING_FOREIGN_OWNER');
    }
    const exact = live;
    if (exact) {
      if (!canonicalApplicationMatchesFrozenPosting(exact, input.postingIdentity)) {
        throw new CanonicalPacketBindingError('CANONICAL_PACKET_POSTING_MISMATCH');
      }
      return exact;
    }
    // Canonical consolidation can delete the exact row after the immutable opening was written,
    // but posting identity alone cannot choose among same-posting aliases. Generated attempts must
    // retain one exact packet-artifact link. Canonical-only attempts must retain the exact v1
    // document capability link. No immutable document edge means no projection authority.
    if (input.packetId === input.applicationId && input.attemptId) {
      const receiptCandidate = await canonicalFreeConfirmedReceiptCandidate(executor, {
        userId: input.userId,
        attemptId: input.attemptId,
        postingIdentity: input.postingIdentity,
      });
      if (receiptCandidate) return receiptCandidate;
    }
    const immutableCandidates = input.packetId === input.applicationId
      ? await canonicalFreeDocumentCandidates(executor, input)
      : await immutablePacketLinkCandidates(executor, input);
    return oneExactCandidate(immutableCandidates, input.postingIdentity);
  }
  return oneExactCandidate([
    ...await immutablePacketLinkCandidates(executor, input),
    ...await currentPacketPointerCandidates(executor, input),
  ], input.postingIdentity);
}
