import { createHash } from 'node:crypto';
import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  application_posting_distinctions,
  applications,
  generated_resumes,
} from '../db/schema';
import { canonicalPublicPostingUrl } from './atsSubmissionChannels';
import {
  atsPostingKey,
  blockingSubmissionAttemptsForUser,
  freezePostingIdentity,
  lockSubmissionAttemptUser,
  type FrozenPostingIdentity,
  type PostingIdentityBasis,
  type SubmissionAttemptLedgerExecutor,
} from './submissionAttemptLedger';

export const POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION = 'posting-distinction-candidate-v1' as const;
export const POSTING_DISTINCTION_PROOF_KIND = 'applicant_confirmed_distinct_posting_pair' as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TERMINAL_APPLICATION_STEPS = new Set([
  'apply',
  'application',
  'application-form',
  'application_form',
  'applicationform',
  'apply-form',
  'apply-now',
  'applynow',
  'form',
  'job-application',
]);
const GENERIC_PATH_ENDS = new Set([
  'apply',
  'career',
  'careers',
  'job',
  'jobs',
  'opening',
  'openings',
  'list',
  'listing',
  'listings',
  'open-positions',
  'opportunities',
  'opportunity',
  'position',
  'positions',
  'results',
  'search',
  'search-results',
]);

type CandidateIdentitySnapshot = {
  version: typeof POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION;
  posting_key: string | null;
  job_id: string | null;
  company_role: string | null;
  portal_url: string;
};

export type PostingDistinctionCandidateIdentity = {
  version: typeof POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION;
  digest: string;
  postingKey: string | null;
  jobId: string | null;
  companyRole: string | null;
  portalUrl: string;
};

export type PostingDistinctionCandidate = {
  applicationId: string;
  packetId: string;
  jobContext: unknown;
  portalUrl: string;
  identity: PostingDistinctionCandidateIdentity;
};

export type PostingDistinctionRecord = typeof application_posting_distinctions.$inferSelect;

export type PostingDistinctionErrorCode =
  | 'invalid_identifier'
  | 'candidate_not_found'
  | 'candidate_binding_mismatch'
  | 'candidate_identity_not_exact'
  | 'stale_candidate'
  | 'prior_attempt_not_blocking'
  | 'prior_identity_not_exact'
  | 'same_posting'
  | 'idempotency_conflict';

export class PostingDistinctionError extends Error {
  constructor(
    public readonly code: PostingDistinctionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PostingDistinctionError';
  }
}

export type PostingDistinctionExecutor = SubmissionAttemptLedgerExecutor;

export type AppendPostingDistinctionInput = {
  userId: string;
  relationId: string;
  priorAttemptId: string;
  candidateApplicationId: string;
  candidatePacketId: string;
  expectedCandidateIdentityVersion: typeof POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION;
  expectedCandidateIdentityDigest: string;
};

export type AppendPostingDistinctionResult = {
  distinction: PostingDistinctionRecord;
  replay: boolean;
  candidate: PostingDistinctionCandidate;
};

/**
 * Canonical public posting URL used by both the relation digest and duplicate comparison.
 *
 * Query-only and aggregate pages are deliberately rejected. Provider-native URLs may retain a
 * query only when the provider parser can recover an employer-owned posting key from it.
 */
export function canonicalExactPostingUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let canonical: string | null;
  try {
    canonical = canonicalPublicPostingUrl(value);
  } catch {
    return null;
  }
  if (!canonical) return null;
  let url: URL;
  try {
    url = new URL(canonical);
  } catch {
    return null;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
  url.protocol = 'https:';
  url.hostname = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (url.port === '80' || url.port === '443') url.port = '';
  url.hash = '';

  const segments = url.pathname.split('/').filter(Boolean);
  while (segments.length > 0 && TERMINAL_APPLICATION_STEPS.has(segments.at(-1)!.toLowerCase())) {
    segments.pop();
  }
  url.pathname = segments.length > 0 ? `/${segments.join('/')}` : '/';

  const normalized = url.toString();
  if (atsPostingKey(normalized)) return normalized;
  if (url.search) return null;
  if (segments.length < 2 || GENERIC_PATH_ENDS.has(segments.at(-1)!.toLowerCase())) return null;
  return normalized;
}

function candidateIdentitySnapshot(identity: Omit<PostingDistinctionCandidateIdentity, 'digest'>): CandidateIdentitySnapshot {
  return {
    version: identity.version,
    posting_key: identity.postingKey,
    job_id: identity.jobId,
    company_role: identity.companyRole,
    portal_url: identity.portalUrl,
  };
}

/** The versioned digest is always computed from server-normalized fields, never accepted raw. */
export function postingDistinctionCandidateIdentity(
  jobContext: unknown,
  portalUrl: string | undefined | null,
): PostingDistinctionCandidateIdentity | null {
  const exactPortalUrl = canonicalExactPostingUrl(portalUrl);
  if (!exactPortalUrl) return null;
  const frozen = freezePostingIdentity(jobContext, exactPortalUrl);
  const withoutDigest = {
    version: POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION,
    postingKey: frozen.postingKey,
    jobId: frozen.jobId,
    companyRole: frozen.companyRole,
    portalUrl: exactPortalUrl,
  } as const;
  const digest = createHash('sha256')
    .update(JSON.stringify(candidateIdentitySnapshot(withoutDigest)), 'utf8')
    .digest('hex');
  return { ...withoutDigest, digest };
}

/** Immutable evidence of sameness always wins over a human distinction relation. */
export function strongPostingSameness(
  left: Pick<FrozenPostingIdentity, 'postingKey' | 'jobId' | 'portalUrl'>,
  right: Pick<FrozenPostingIdentity, 'postingKey' | 'jobId' | 'portalUrl'>,
): Exclude<PostingIdentityBasis, 'company_role' | 'same_packet'> | null {
  if (left.postingKey && right.postingKey && left.postingKey === right.postingKey) return 'ats_posting';
  if (left.jobId && right.jobId && left.jobId === right.jobId) return 'job_id';
  const leftUrl = canonicalExactPostingUrl(left.portalUrl);
  const rightUrl = canonicalExactPostingUrl(right.portalUrl);
  return leftUrl && rightUrl && leftUrl === rightUrl ? 'portal_url' : null;
}

function assertUuid(label: string, value: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new PostingDistinctionError('invalid_identifier', `${label} must be a UUID`);
  }
}

/**
 * Resolve and freeze the exact current application plus packet pair from server-owned rows.
 * A packet already linked to a canonical application cannot be addressed through its legacy id.
 */
export async function loadPostingDistinctionCandidate(
  userId: string,
  candidateApplicationId: string,
  candidatePacketId: string,
  executor: Pick<PostingDistinctionExecutor, 'select'> = db,
): Promise<PostingDistinctionCandidate> {
  assertUuid('User id', userId);
  assertUuid('Candidate application id', candidateApplicationId);
  assertUuid('Candidate packet id', candidatePacketId);

  const [directCanonical] = await executor.select({
    id: applications.id,
    legacyPacketId: applications.legacy_generated_resume_id,
    jobId: applications.job_id,
    company: applications.company_name,
    role: applications.role,
    portalUrl: applications.portal_url,
  }).from(applications).where(and(
    eq(applications.user_id, userId),
    eq(applications.id, candidateApplicationId),
  )).limit(1);
  const [packetCanonical] = await executor.select({
    id: applications.id,
    legacyPacketId: applications.legacy_generated_resume_id,
    jobId: applications.job_id,
    company: applications.company_name,
    role: applications.role,
    portalUrl: applications.portal_url,
  }).from(applications).where(and(
    eq(applications.user_id, userId),
    eq(applications.legacy_generated_resume_id, candidatePacketId),
  )).limit(1);

  if (directCanonical && packetCanonical && directCanonical.id !== packetCanonical.id) {
    throw new PostingDistinctionError(
      'candidate_binding_mismatch',
      'Candidate application and packet are linked to different canonical records',
    );
  }
  const canonical = directCanonical ?? packetCanonical;
  if (canonical) {
    const currentPacketId = canonical.legacyPacketId ?? canonical.id;
    if (canonical.id !== candidateApplicationId || currentPacketId !== candidatePacketId) {
      throw new PostingDistinctionError(
        'candidate_binding_mismatch',
        'Candidate application and packet no longer form the acknowledged pair',
      );
    }
    const jobContext = {
      company: canonical.company,
      role: canonical.role,
      ...(canonical.jobId ? { job_id: canonical.jobId } : {}),
    };
    const identity = postingDistinctionCandidateIdentity(jobContext, canonical.portalUrl);
    if (!identity) {
      throw new PostingDistinctionError(
        'candidate_identity_not_exact',
        'Candidate application does not have an exact public posting URL',
      );
    }
    return {
      applicationId: canonical.id,
      packetId: currentPacketId,
      jobContext,
      portalUrl: identity.portalUrl,
      identity,
    };
  }

  if (candidateApplicationId !== candidatePacketId) {
    throw new PostingDistinctionError(
      'candidate_binding_mismatch',
      'An unlinked legacy packet must use its packet id as its application id',
    );
  }
  const [packet] = await executor.select({
    id: generated_resumes.id,
    jobContext: generated_resumes.job_context,
    portalUrl: sql<string | null>`${generated_resumes.spec}->'_review'->>'portal_url'`,
  }).from(generated_resumes).where(and(
    eq(generated_resumes.user_id, userId),
    eq(generated_resumes.id, candidatePacketId),
  )).limit(1);
  if (!packet) {
    throw new PostingDistinctionError('candidate_not_found', 'Candidate application was not found');
  }
  const identity = postingDistinctionCandidateIdentity(packet.jobContext, packet.portalUrl);
  if (!identity) {
    throw new PostingDistinctionError(
      'candidate_identity_not_exact',
      'Candidate application does not have an exact public posting URL',
    );
  }
  return {
    applicationId: packet.id,
    packetId: packet.id,
    jobContext: packet.jobContext,
    portalUrl: identity.portalUrl,
    identity,
  };
}

/** Resolve the canonical application plus packet pair from either public record key. */
export async function loadPostingDistinctionCandidateByKey(
  userId: string,
  candidateKey: string,
  executor: Pick<PostingDistinctionExecutor, 'select'> = db,
): Promise<PostingDistinctionCandidate> {
  assertUuid('User id', userId);
  assertUuid('Candidate key', candidateKey);
  const [canonical] = await executor.select({
    id: applications.id,
    packetId: applications.legacy_generated_resume_id,
  }).from(applications).where(and(
    eq(applications.user_id, userId),
    or(
      eq(applications.id, candidateKey),
      eq(applications.legacy_generated_resume_id, candidateKey),
    ),
  )).limit(1);
  if (canonical) {
    return loadPostingDistinctionCandidate(
      userId,
      canonical.id,
      canonical.packetId ?? canonical.id,
      executor,
    );
  }
  return loadPostingDistinctionCandidate(userId, candidateKey, candidateKey, executor);
}

function storedSnapshotMatches(
  raw: unknown,
  identity: PostingDistinctionCandidateIdentity,
): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const record = raw as Record<string, unknown>;
  const expected = candidateIdentitySnapshot(identity);
  const expectedKeys = Object.keys(expected).sort();
  const actualKeys = Object.keys(record).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every((key) => record[key] === expected[key as keyof CandidateIdentitySnapshot]);
}

function candidateFromStoredDistinction(stored: PostingDistinctionRecord): PostingDistinctionCandidate | null {
  if (stored.candidate_identity_version !== POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION
    || !SHA256_PATTERN.test(stored.candidate_identity_digest)
    || stored.proof_kind !== POSTING_DISTINCTION_PROOF_KIND) return null;
  const identity: PostingDistinctionCandidateIdentity = {
    version: POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION,
    digest: stored.candidate_identity_digest,
    postingKey: stored.candidate_posting_key,
    jobId: stored.candidate_job_id,
    companyRole: stored.candidate_company_role,
    portalUrl: stored.candidate_portal_url,
  };
  if (!storedSnapshotMatches(stored.candidate_identity_snapshot, identity)) return null;

  let company = '';
  let role = '';
  if (identity.companyRole) {
    const separator = identity.companyRole.indexOf('|');
    if (separator <= 0 || separator === identity.companyRole.length - 1) return null;
    company = identity.companyRole.slice(0, separator);
    role = identity.companyRole.slice(separator + 1);
  }
  const jobContext = {
    company,
    role,
    ...(identity.jobId ? { job_id: identity.jobId } : {}),
  };
  const recomputed = postingDistinctionCandidateIdentity(jobContext, identity.portalUrl);
  if (!recomputed
    || recomputed.digest !== identity.digest
    || recomputed.postingKey !== identity.postingKey
    || recomputed.jobId !== identity.jobId
    || recomputed.companyRole !== identity.companyRole
    || recomputed.portalUrl !== identity.portalUrl) return null;
  return {
    applicationId: stored.candidate_application_id,
    packetId: stored.candidate_packet_id,
    jobContext,
    portalUrl: identity.portalUrl,
    identity,
  };
}

function sameStoredRequest(stored: PostingDistinctionRecord, input: AppendPostingDistinctionInput): boolean {
  return stored.user_id === input.userId
    && stored.relation_id === input.relationId
    && stored.prior_attempt_id === input.priorAttemptId
    && stored.candidate_application_id === input.candidateApplicationId
    && stored.candidate_packet_id === input.candidatePacketId
    && stored.candidate_identity_version === input.expectedCandidateIdentityVersion
    && stored.candidate_identity_digest === input.expectedCandidateIdentityDigest;
}

function sameStoredDistinction(
  stored: PostingDistinctionRecord,
  input: AppendPostingDistinctionInput,
  candidate: PostingDistinctionCandidate,
): boolean {
  return stored.user_id === input.userId
    && stored.prior_attempt_id === input.priorAttemptId
    && stored.candidate_application_id === candidate.applicationId
    && stored.candidate_packet_id === candidate.packetId
    && stored.candidate_identity_version === candidate.identity.version
    && stored.candidate_identity_digest === candidate.identity.digest
    && stored.candidate_posting_key === candidate.identity.postingKey
    && stored.candidate_job_id === candidate.identity.jobId
    && stored.candidate_company_role === candidate.identity.companyRole
    && stored.candidate_portal_url === candidate.identity.portalUrl
    && storedSnapshotMatches(stored.candidate_identity_snapshot, candidate.identity)
    && stored.proof_kind === POSTING_DISTINCTION_PROOF_KIND;
}

async function appendPostingDistinctionWithExecutor(
  input: AppendPostingDistinctionInput,
  executor: PostingDistinctionExecutor,
): Promise<AppendPostingDistinctionResult> {
  assertUuid('User id', input.userId);
  assertUuid('Relation id', input.relationId);
  assertUuid('Prior attempt id', input.priorAttemptId);
  assertUuid('Candidate application id', input.candidateApplicationId);
  assertUuid('Candidate packet id', input.candidatePacketId);
  if (input.expectedCandidateIdentityVersion !== POSTING_DISTINCTION_CANDIDATE_IDENTITY_VERSION
    || !SHA256_PATTERN.test(input.expectedCandidateIdentityDigest)) {
    throw new PostingDistinctionError('stale_candidate', 'Candidate identity acknowledgment is invalid or obsolete');
  }

  await lockSubmissionAttemptUser(executor, input.userId);
  const [existingRequest] = await executor.select().from(application_posting_distinctions).where(and(
    eq(application_posting_distinctions.user_id, input.userId),
    eq(application_posting_distinctions.relation_id, input.relationId),
  )).limit(1);
  if (existingRequest) {
    const storedCandidate = sameStoredRequest(existingRequest, input)
      ? candidateFromStoredDistinction(existingRequest)
      : null;
    if (storedCandidate) {
      /* Idempotency answers whether this exact immutable write committed. The returned candidate
         is deliberately reloaded, not reconstructed from that old write: the route immediately
         reruns the duplicate guard, and a changed digest must leave the relation inactive. */
      const currentCandidate = await loadPostingDistinctionCandidate(
        input.userId,
        input.candidateApplicationId,
        input.candidatePacketId,
        executor,
      );
      return { distinction: existingRequest, replay: true, candidate: currentCandidate };
    }
    throw new PostingDistinctionError(
      'idempotency_conflict',
      'Relation id is already bound to a different or malformed posting distinction',
    );
  }
  const candidate = await loadPostingDistinctionCandidate(
    input.userId,
    input.candidateApplicationId,
    input.candidatePacketId,
    executor,
  );
  if (candidate.identity.version !== input.expectedCandidateIdentityVersion
    || candidate.identity.digest !== input.expectedCandidateIdentityDigest) {
    throw new PostingDistinctionError(
      'stale_candidate',
      'Candidate application changed after the posting comparison was acknowledged',
    );
  }

  const prior = (await blockingSubmissionAttemptsForUser(input.userId, { executor }))
    .find((attempt) => attempt.attemptId === input.priorAttemptId);
  if (!prior) {
    throw new PostingDistinctionError(
      'prior_attempt_not_blocking',
      'The prior attempt is absent or no longer requires duplicate-risk repair',
    );
  }
  if (!canonicalExactPostingUrl(prior.postingIdentity.portalUrl)) {
    throw new PostingDistinctionError(
      'prior_identity_not_exact',
      'The prior attempt needs exact posting attribution before two postings can be compared',
    );
  }
  if (candidate.packetId === prior.packetId
    || (prior.applicationId && candidate.applicationId === prior.applicationId)
    || strongPostingSameness(
      freezePostingIdentity(candidate.jobContext, candidate.portalUrl),
      prior.postingIdentity,
    )) {
    throw new PostingDistinctionError(
      'same_posting',
      'Strong posting identity evidence says the prior attempt and candidate are the same posting',
    );
  }

  const snapshot = candidateIdentitySnapshot(candidate.identity);
  const values: typeof application_posting_distinctions.$inferInsert = {
    user_id: input.userId,
    relation_id: input.relationId,
    prior_attempt_id: input.priorAttemptId,
    candidate_application_id: candidate.applicationId,
    candidate_packet_id: candidate.packetId,
    candidate_identity_version: candidate.identity.version,
    candidate_identity_digest: candidate.identity.digest,
    candidate_identity_snapshot: snapshot,
    candidate_posting_key: candidate.identity.postingKey,
    candidate_job_id: candidate.identity.jobId,
    candidate_company_role: candidate.identity.companyRole,
    candidate_portal_url: candidate.identity.portalUrl,
    proof_kind: POSTING_DISTINCTION_PROOF_KIND,
  };
  const inserted = await executor.insert(application_posting_distinctions)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return { distinction: inserted[0], replay: false, candidate };

  const [byRelationId] = await executor.select().from(application_posting_distinctions).where(and(
    eq(application_posting_distinctions.user_id, input.userId),
    eq(application_posting_distinctions.relation_id, input.relationId),
  )).limit(1);
  if (byRelationId) {
    if (sameStoredDistinction(byRelationId, input, candidate)) {
      return { distinction: byRelationId, replay: true, candidate };
    }
    throw new PostingDistinctionError(
      'idempotency_conflict',
      'Relation id is already bound to a different posting distinction',
    );
  }

  const [byPair] = await executor.select().from(application_posting_distinctions).where(and(
    eq(application_posting_distinctions.user_id, input.userId),
    eq(application_posting_distinctions.prior_attempt_id, input.priorAttemptId),
    eq(application_posting_distinctions.candidate_application_id, candidate.applicationId),
    eq(application_posting_distinctions.candidate_packet_id, candidate.packetId),
    eq(application_posting_distinctions.candidate_identity_version, candidate.identity.version),
    eq(application_posting_distinctions.candidate_identity_digest, candidate.identity.digest),
  )).limit(1);
  if (byPair && sameStoredDistinction(byPair, input, candidate)) {
    return { distinction: byPair, replay: true, candidate };
  }
  throw new PostingDistinctionError(
    'idempotency_conflict',
    'Posting distinction conflicts with existing immutable evidence',
  );
}

/**
 * Append one pair-specific repair. Without an executor this owns the transaction and user lock.
 * A supplied executor must be the caller's active transaction.
 */
export async function appendPostingDistinction(
  input: AppendPostingDistinctionInput,
  options: { executor?: PostingDistinctionExecutor } = {},
): Promise<AppendPostingDistinctionResult> {
  if (options.executor) return appendPostingDistinctionWithExecutor(input, options.executor);
  return db.transaction((transaction) => appendPostingDistinctionWithExecutor(input, transaction));
}

/** Read only relations bound to the exact current candidate record pair and digest. */
export async function postingDistinctionsForCurrentCandidate(
  userId: string,
  candidateKey: string,
  jobContext: unknown,
  portalUrl: string | undefined | null,
  executor: Pick<PostingDistinctionExecutor, 'select'> = db,
): Promise<PostingDistinctionRecord[]> {
  const identity = postingDistinctionCandidateIdentity(jobContext, portalUrl);
  if (!identity || !UUID_PATTERN.test(userId) || !UUID_PATTERN.test(candidateKey)) return [];
  const possible = await executor.select().from(application_posting_distinctions).where(and(
    eq(application_posting_distinctions.user_id, userId),
    eq(application_posting_distinctions.candidate_identity_version, identity.version),
    eq(application_posting_distinctions.candidate_identity_digest, identity.digest),
    or(
      eq(application_posting_distinctions.candidate_application_id, candidateKey),
      eq(application_posting_distinctions.candidate_packet_id, candidateKey),
    ),
  ));
  if (possible.length === 0) return [];

  const verified: PostingDistinctionRecord[] = [];
  for (const relation of possible) {
    let candidate: PostingDistinctionCandidate;
    try {
      candidate = await loadPostingDistinctionCandidate(
        userId,
        relation.candidate_application_id,
        relation.candidate_packet_id,
        executor,
      );
    } catch (error) {
      if (error instanceof PostingDistinctionError) continue;
      throw error;
    }
    if (candidate.identity.digest !== identity.digest
      || candidate.identity.version !== identity.version
      || !sameStoredDistinction(relation, {
        userId,
        relationId: relation.relation_id,
        priorAttemptId: relation.prior_attempt_id,
        candidateApplicationId: relation.candidate_application_id,
        candidatePacketId: relation.candidate_packet_id,
        expectedCandidateIdentityVersion: identity.version,
        expectedCandidateIdentityDigest: identity.digest,
      }, candidate)) continue;
    verified.push(relation);
  }
  return verified;
}

/** Pure final gate used after all strong same-posting checks have run. */
export function postingDistinctionApplies(input: {
  relation: PostingDistinctionRecord;
  priorAttemptId: string | undefined;
  candidateApplicationId: string;
  candidatePacketId: string;
  candidateIdentity: PostingDistinctionCandidateIdentity;
  priorIdentity: FrozenPostingIdentity;
}): boolean {
  const { relation, candidateIdentity } = input;
  if (!input.priorAttemptId || relation.prior_attempt_id !== input.priorAttemptId) return false;
  if (relation.candidate_application_id !== input.candidateApplicationId
    || relation.candidate_packet_id !== input.candidatePacketId) return false;
  if (relation.candidate_identity_version !== candidateIdentity.version
    || relation.candidate_identity_digest !== candidateIdentity.digest
    || relation.candidate_posting_key !== candidateIdentity.postingKey
    || relation.candidate_job_id !== candidateIdentity.jobId
    || relation.candidate_company_role !== candidateIdentity.companyRole
    || relation.candidate_portal_url !== candidateIdentity.portalUrl
    || relation.proof_kind !== POSTING_DISTINCTION_PROOF_KIND
    || !storedSnapshotMatches(relation.candidate_identity_snapshot, candidateIdentity)) return false;
  if (!canonicalExactPostingUrl(input.priorIdentity.portalUrl)) return false;
  return strongPostingSameness({
    postingKey: candidateIdentity.postingKey,
    jobId: candidateIdentity.jobId,
    portalUrl: candidateIdentity.portalUrl,
  }, input.priorIdentity) === null;
}
