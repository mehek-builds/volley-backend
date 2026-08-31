import { and, eq } from 'drizzle-orm';
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
 * Resolve the canonical row before an attempt is opened. The caller must already hold the shared
 * submission-user transaction lock. A new employer boundary may open only for the packet currently
 * selected by the canonical row. Immutable artifact links recover historical receipts, but they
 * cannot revive a superseded packet or silently establish a missing mutable pointer.
 */
export async function canonicalApplicationForNewPacketAttempt(
  executor: CanonicalPacketBindingExecutor,
  input: { userId: string; packetId: string; postingIdentity: FrozenPostingIdentity },
): Promise<typeof applications.$inferSelect> {
  return oneExactCandidate(
    await currentPacketPointerCandidates(executor, input),
    input.postingIdentity,
  );
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
