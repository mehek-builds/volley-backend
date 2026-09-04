import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db';
import {
  application_artifacts,
  application_submission_attempt_events,
  application_submission_events,
  applications,
  artifacts,
  monitored_jobs,
} from '../db/schema';
import {
  atsPostingKey,
  freezePostingIdentity,
  type FrozenPostingIdentity,
  type SubmissionAttemptBinding,
} from './submissionAttemptLedger';
import { parseCanonicalFreeVersionedDocumentBinding } from './canonicalFreeDocumentBinding';
import { isGreenhouseLegacyHostRedirect } from './workableApplicationUrl';

export type CanonicalPacketBindingExecutor = Pick<typeof db, 'select'>;
/** Opening a new attempt may record the landed URL on a canonical row that never stored one. */
export type NewPacketAttemptExecutor = Pick<typeof db, 'select' | 'update'>;

const GREENHOUSE_LEGACY_ORIGIN = 'https://boards.greenhouse.io';
const GREENHOUSE_CURRENT_ORIGIN = 'https://job-boards.greenhouse.io';

/**
 * Greenhouse retired boards.greenhouse.io with a 301 onto job-boards.greenhouse.io that carries the
 * path and query across byte-for-byte (workableApplicationUrl.ts, measured 2026-09-04). Since #929
 * the runner is allowed to land there, so the identity frozen for an attempt names the CURRENT
 * origin while every canonical row written before the move, and every packet URL still built on
 * the legacy embed host, names the OLD one. Measured on Railway prod 2026-09-04: 45 of the last 30
 * days' packet-linked rows hold the legacy origin, and each of them failed the origin tier below
 * on its first landed run. The two origins are one employer boundary. The equivalence is applied
 * here, inside the one comparison every strict site funnels through (attempt-open, attempt
 * projection, canonical sync, and the authoritative projection's posting_mismatch), so no site
 * can accept what another refuses.
 */
function comparablePortalOrigin(origin: string | null): string | null {
  return origin === GREENHOUSE_LEGACY_ORIGIN ? GREENHOUSE_CURRENT_ORIGIN : origin;
}

export function sameApplicationPageOrigin(left: string | null, right: string | null): boolean {
  return comparablePortalOrigin(left) === comparablePortalOrigin(right);
}

/** Exact URL equality, or Greenhouse's measured legacy-host twin in either direction. */
export function sameApplicationPageUrl(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return isGreenhouseLegacyHostRedirect(left, right) || isGreenhouseLegacyHostRedirect(right, left);
}

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
  if (frozen.portalIdentity && !sameApplicationPageOrigin(candidate.portalIdentity, frozen.portalIdentity)) {
    return false;
  }
  if (frozen.postingKey) return candidate.postingKey === frozen.postingKey;
  if (frozen.jobId) return candidate.jobId === frozen.jobId;
  return Boolean(
    frozen.companyRole
    && candidate.companyRole === frozen.companyRole
    && frozen.portalUrl
    && sameApplicationPageUrl(candidate.portalUrl, frozen.portalUrl),
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
 * A canonical row created from a monitored job id alone stores no portal URL: routes/resume.ts
 * writes the reconstructed URL only when the request names an application, and the runner derives
 * the page it lands on from that same job id later. Measured on Railway prod 2026-09-04: 174 of
 * 646 packet-linked canonical rows, across 18 accounts, carry a null portal_url (Hudson River
 * Trading application f10ece44 among them). Once a run has landed, the frozen identity carries an
 * origin and a provider key the row never stored, so the strict match reads that absence as a
 * difference and the packet is refused at open with CANONICAL_PACKET_BINDING_MISSING.
 *
 * Relaxing the match instead would move the refusal to AFTER the press: attempt projection,
 * canonical sync and the authoritative projection all re-read the row strictly and would report
 * posting_mismatch once the employer already held the application. So the row is completed, not
 * the comparison: the landed URL is recorded on the row, once, at the moment it becomes known, and
 * every later strict read sees a URL-bearing row exactly as if creation had stored it.
 *
 * The write is bounded on every side. Only a row whose portal_url is null, whose immutable job id
 * equals the frozen one, and whose company and role agree may be completed; a row that holds any
 * URL is never touched, and job_id is never written. The landed URL must name the same posting
 * as the monitored job the row was created from: its ATS posting key (host-agnostic, so the
 * legacy and current Greenhouse hosts agree) must equal the key of that job's own apply or posting
 * URL. A review URL edited onto another posting fails that check and stays unbindable, as it does
 * for a row that stored a URL. No monitored job, no key, or no landed URL means no write. The
 * caller holds the submission-user transaction lock, so the update is serialized with every other
 * covered write for the account and the revision bump it triggers.
 */
async function recordLandedPortalOnUrlLessCanonicalRow(
  executor: NewPacketAttemptExecutor,
  candidates: Array<typeof applications.$inferSelect>,
  input: { userId: string; postingIdentity: FrozenPostingIdentity },
): Promise<typeof applications.$inferSelect | null> {
  const frozen = input.postingIdentity;
  if (!frozen.portalUrl || !frozen.postingKey || !frozen.jobId) return null;
  const urlLess = [...new Map(candidates
    .filter((candidate) => candidate.portal_url === null
      && typeof candidate.job_id === 'string'
      && candidate.job_id.trim().toLowerCase() === frozen.jobId
      && (!frozen.companyRole || freezePostingIdentity({
        company: candidate.company_name,
        role: candidate.role,
        job_id: candidate.job_id,
      }, null).companyRole === frozen.companyRole))
    .map((candidate) => [candidate.id, candidate])).values()];
  if (urlLess.length === 0) return null;
  if (urlLess.length !== 1) throw new CanonicalPacketBindingError('CANONICAL_PACKET_BINDING_AMBIGUOUS');
  const row = urlLess[0]!;
  const [job] = await executor.select({
    applyUrl: monitored_jobs.apply_url,
    postingUrl: monitored_jobs.posting_url,
  }).from(monitored_jobs).where(eq(monitored_jobs.id, row.job_id!)).limit(1);
  if (!job) return null;
  const jobKey = atsPostingKey(job.applyUrl) ?? atsPostingKey(job.postingUrl);
  if (!jobKey || jobKey !== frozen.postingKey) return null;
  const [recorded] = await executor.update(applications)
    .set({ portal_url: frozen.portalUrl, updated_at: new Date() })
    .where(and(
      eq(applications.id, row.id),
      eq(applications.user_id, input.userId),
      eq(applications.job_id, row.job_id!),
      isNull(applications.portal_url),
    ))
    .returning();
  if (!recorded) return null;
  return canonicalApplicationMatchesFrozenPosting(recorded, frozen) ? recorded : null;
}

/**
 * Resolve the canonical row before an attempt is opened. The caller must already hold the shared
 * submission-user transaction lock. A new employer boundary may open only for the packet currently
 * selected by the canonical row. Immutable artifact links recover historical receipts, but they
 * cannot revive a superseded packet or silently establish a missing mutable pointer. The strict
 * match decides first; only when it finds nothing may a URL-less row be completed with the landed
 * URL (see recordLandedPortalOnUrlLessCanonicalRow), after which it is returned as the exact row.
 */
export async function canonicalApplicationForNewPacketAttempt(
  executor: NewPacketAttemptExecutor,
  input: { userId: string; packetId: string; postingIdentity: FrozenPostingIdentity },
): Promise<typeof applications.$inferSelect> {
  const candidates = await currentPacketPointerCandidates(executor, input);
  try {
    return oneExactCandidate(candidates, input.postingIdentity);
  } catch (error) {
    if (!(error instanceof CanonicalPacketBindingError) || error.code !== 'CANONICAL_PACKET_BINDING_MISSING') {
      throw error;
    }
    const completed = await recordLandedPortalOnUrlLessCanonicalRow(executor, candidates, input);
    if (!completed) throw error;
    return completed;
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
