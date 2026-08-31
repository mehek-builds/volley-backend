import { and, asc, countDistinct, eq, gte, inArray, sql } from 'drizzle-orm';
import { v5 as uuidv5 } from 'uuid';
import { db } from '../db';
import {
  application_submission_attempt_events,
  application_submission_attempt_ledger_cutovers,
} from '../db/schema';
import {
  ashbyPostingFromUrl,
  canonicalPublicPostingUrl,
  genericKnownPosting,
  greenhousePostingFromUrl,
  leverPostingFromUrl,
} from './atsSubmissionChannels';
import { companyIdentity } from './companyIdentity';
import { DATABASE_PROBE_TIMEOUT_MS } from './healthProbe';

export const SUBMISSION_ATTEMPT_EVENT_KINDS = [
  'attempt_opened',
  'boundary_authorized',
  'press_observed',
  'submission_confirmed',
  'not_sent_proven',
] as const;

export type SubmissionAttemptEventKind = typeof SUBMISSION_ATTEMPT_EVENT_KINDS[number];

export const SUBMISSION_ATTEMPT_SOURCES = [
  'managed_browser',
  'direct_browser',
  'chrome_extension',
  'unsupported_email',
  'ats_api',
  'attended_handoff',
  'legacy_backfill',
] as const;

export type SubmissionAttemptSource = typeof SUBMISSION_ATTEMPT_SOURCES[number];

export const SUBMISSION_ATTEMPT_OPERATIONS = [
  'initial_submission',
  'security_code_continuation',
  'manual_submission',
] as const;

export type SubmissionAttemptOperation = typeof SUBMISSION_ATTEMPT_OPERATIONS[number];

export const SUBMISSION_NOT_SENT_PROOF_KINDS = [
  'typed_pre_click_stop',
  'applicant_checked_not_sent',
  'applicant_checked_all_possible_destinations_not_sent',
  'employer_rejected_not_filed',
  'employer_verification_pending_not_filed',
  'provider_definitive_rejection',
  'extension_cancelled_before_press',
] as const;

export type SubmissionNotSentProofKind = typeof SUBMISSION_NOT_SENT_PROOF_KINDS[number];

export type PostingIdentityBasis = 'ats_posting' | 'job_id' | 'portal_url' | 'company_role' | 'same_packet';

export type PostingIdentity = {
  postingKey: string | null;
  jobId: string | null;
  companyRole: string | null;
};

export type FrozenPostingIdentity = PostingIdentity & {
  company: string;
  role: string;
  portalUrl: string | null;
  portalIdentity: string | null;
};

export type SubmissionAttemptBinding = {
  attemptId: string;
  userId: string;
  packetId: string;
  applicationId?: string | null;
  parentAttemptId?: string | null;
  source: SubmissionAttemptSource;
  operation: SubmissionAttemptOperation;
  postingIdentity: FrozenPostingIdentity;
  submissionRunId?: string | null;
  submissionClaimId?: string | null;
  packetVersion?: string | null;
};

export type AppendSubmissionAttemptEventInput = SubmissionAttemptBinding & {
  eventId: string;
  eventKind: SubmissionAttemptEventKind;
  proofKind?: SubmissionNotSentProofKind | null;
  observedAt?: Date;
  createdAt?: Date;
  evidenceCode?: string | null;
  boundaryActivationId?: string | null;
  boundaryExpiresAt?: Date | null;
};

export type SubmissionAttemptEventRecord = typeof application_submission_attempt_events.$inferSelect;

export type SubmissionAttemptLedgerExecutor = Pick<typeof db, 'execute' | 'insert' | 'select'>;

export type SubmissionAttemptRetrySafety =
  | { kind: 'no_evidence' }
  | {
    kind: 'safe_not_sent';
    attemptId: string;
    proofKind: SubmissionNotSentProofKind;
    resolvedAt: string;
  }
  | {
    kind: 'blocked_unverified';
    attemptId: string;
    at: string;
    reason: 'opened' | 'boundary_authorized' | 'pressed' | 'invalid_sequence';
    leaseId?: string;
    expiresAt?: string;
  }
  | {
    kind: 'blocked_confirmed';
    attemptId: string;
    confirmedAt: string;
  };

export type SubmissionBoundaryAuthorization = {
  leaseId: string;
  attemptId: string;
  activationId: string;
  authorizedAt: string;
  expiresAt: string;
  serverNow: string;
  active: boolean;
};

export type FinalSubmissionBoundaryAuthorization =
  | {
    kind: 'fresh' | 'existing';
    authorization: SubmissionBoundaryAuthorization;
    retrySafety: SubmissionAttemptRetrySafety;
  }
  | {
    kind: 'activation_conflict' | 'blocked';
    retrySafety: SubmissionAttemptRetrySafety;
  };

export type BlockingSubmissionAttempt = {
  attemptId: string;
  parentAttemptId: string | null;
  userId: string;
  packetId: string;
  applicationId: string | null;
  source: SubmissionAttemptSource;
  operation: SubmissionAttemptOperation;
  postingIdentity: FrozenPostingIdentity;
  retrySafety: Extract<SubmissionAttemptRetrySafety, { kind: 'blocked_unverified' | 'blocked_confirmed' }>;
};

const EVENT_ID_NAMESPACE = '25133a66-9e15-5e36-ae22-0ed3c49371ce';
const EVENT_KIND_SET = new Set<string>(SUBMISSION_ATTEMPT_EVENT_KINDS);
const SOURCE_SET = new Set<string>(SUBMISSION_ATTEMPT_SOURCES);
const OPERATION_SET = new Set<string>(SUBMISSION_ATTEMPT_OPERATIONS);
const PROOF_KIND_SET = new Set<string>(SUBMISSION_NOT_SENT_PROOF_KINDS);
const PRE_CLICK_ONLY_PROOFS = new Set<SubmissionNotSentProofKind>([
  'typed_pre_click_stop',
  'extension_cancelled_before_press',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS = 3 * 60 * 1000;
export const ORPHAN_ATTRIBUTION_OPENING_EVIDENCE = 'applicant_attributed_orphan_opening';
export const ORPHAN_ATTRIBUTION_CONFIRMATION_EVIDENCE = 'applicant_attributed_orphan_confirmation';

/** Stable idempotency id for one immutable fact about one attempt. */
export function submissionAttemptEventId(
  attemptId: string,
  eventKind: SubmissionAttemptEventKind,
  factKey = 'primary',
): string {
  return uuidv5(`${attemptId}:${eventKind}:${factKey}`, EVENT_ID_NAMESPACE);
}

/** Employer-owned posting id parsed from the portal URL, when this ATS exposes one. */
export function atsPostingKey(portalUrl: string | undefined | null): string | null {
  const url = portalUrl?.trim();
  if (!url) return null;
  const greenhouse = greenhousePostingFromUrl(url);
  if (greenhouse) return `greenhouse:${greenhouse.boardToken.toLowerCase()}:${greenhouse.jobId}`;
  const ashby = ashbyPostingFromUrl(url);
  if (ashby) return `ashby:${ashby.organization.toLowerCase()}:${ashby.jobPostingId.toLowerCase()}`;
  const lever = leverPostingFromUrl(url);
  if (lever) return `lever:${lever.site.toLowerCase()}:${lever.postingId.toLowerCase()}`;
  const generic = genericKnownPosting(url);
  if (generic) return `${generic.provider}:${generic.tenant.toLowerCase()}:${generic.jobId.toLowerCase()}`;
  return null;
}

function normalizedPortalUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString();
  } catch {
    return value;
  }
}

function portalIdentity(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

/** Freeze every comparison tier and the names used in a refusal before external work starts. */
export function freezePostingIdentity(
  jobContext: unknown,
  portalUrl: string | undefined | null,
): FrozenPostingIdentity {
  const context = (jobContext && typeof jobContext === 'object' ? jobContext : {}) as Record<string, unknown>;
  const rawJobId = context.job_id;
  const jobId = typeof rawJobId === 'string' && rawJobId.trim() ? rawJobId.trim().toLowerCase() : null;
  const company = typeof context.company === 'string' ? context.company.trim() : '';
  const role = typeof context.role === 'string' ? context.role.trim() : '';
  const normalizedCompany = companyIdentity(company);
  const normalizedRole = companyIdentity(role);
  const frozenPortalUrl = normalizedPortalUrl(portalUrl);
  return {
    postingKey: atsPostingKey(portalUrl),
    jobId,
    companyRole: normalizedCompany && normalizedRole ? `${normalizedCompany}|${normalizedRole}` : null,
    company,
    role,
    portalUrl: frozenPortalUrl,
    portalIdentity: portalIdentity(frozenPortalUrl),
  };
}

/** Company and title are labels, not posting identifiers. A historical orphan may be narrowed
 * only by a provider key, an immutable job id, or a clean job-specific public URL. */
export function frozenPostingIdentityHasExactScope(identity: FrozenPostingIdentity): boolean {
  if (identity.postingKey || identity.jobId) return true;
  if (!identity.portalUrl) return false;
  const canonical = canonicalPublicPostingUrl(identity.portalUrl);
  if (!canonical || canonical !== identity.portalUrl) return false;
  let url: URL;
  try {
    url = new URL(canonical);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash || url.search) return false;
  const terminalSteps = new Set([
    'apply', 'application', 'application-form', 'application_form', 'applicationform',
    'apply-form', 'apply-now', 'applynow', 'form', 'job-application',
  ]);
  const pathSegments = url.pathname.split('/').filter(Boolean);
  while (pathSegments.length > 0 && terminalSteps.has(pathSegments.at(-1)!.toLowerCase())) {
    pathSegments.pop();
  }
  if (pathSegments.length < 2) return false;
  const genericPathEnd = new Set([
    'apply', 'career', 'careers', 'job', 'jobs', 'opening', 'openings',
    'list', 'listing', 'listings', 'open-positions', 'opportunities', 'opportunity',
    'position', 'positions', 'results', 'search', 'search-results',
  ]);
  return !genericPathEnd.has(pathSegments.at(-1)!.toLowerCase());
}

/** Compatibility name for callers that need only the three comparison tiers. */
export function postingIdentity(jobContext: unknown, portalUrl: string | undefined | null): PostingIdentity {
  const frozen = freezePostingIdentity(jobContext, portalUrl);
  return { postingKey: frozen.postingKey, jobId: frozen.jobId, companyRole: frozen.companyRole };
}

/** Provider-scoped requisitions may prove difference. Other keys and labels prove sameness only. */
export function comparePostings(a: PostingIdentity, b: PostingIdentity):
  | { same: true; basis: Exclude<PostingIdentityBasis, 'same_packet'> }
  | { same: false; basis: Exclude<PostingIdentityBasis, 'same_packet'> }
  | { same: false; basis: null } {
  if (a.postingKey && b.postingKey) {
    if (a.postingKey === b.postingKey) return { same: true, basis: 'ats_posting' } as const;
    const namespace = (value: string) => value.split(':').slice(0, 2).join(':');
    return namespace(a.postingKey) === namespace(b.postingKey)
      ? { same: false, basis: 'ats_posting' } as const
      : { same: false, basis: null } as const;
  }
  if (a.jobId && b.jobId) {
    return a.jobId === b.jobId
      ? { same: true, basis: 'job_id' } as const
      : { same: false, basis: null } as const;
  }
  if (a.companyRole && b.companyRole && a.companyRole === b.companyRole) {
    return { same: true, basis: 'company_role' } as const;
  }
  return { same: false, basis: null };
}

function assertAppendInput(input: AppendSubmissionAttemptEventInput) {
  if (!EVENT_KIND_SET.has(input.eventKind)) throw new Error(`Unsupported submission attempt event: ${input.eventKind}`);
  if (!SOURCE_SET.has(input.source)) throw new Error(`Unsupported submission attempt source: ${input.source}`);
  if (!OPERATION_SET.has(input.operation)) throw new Error(`Unsupported submission attempt operation: ${input.operation}`);
  if (!input.userId || !input.packetId || !input.attemptId || !input.eventId) {
    throw new Error('Submission attempt events require user, packet, attempt, and event ids');
  }
  if (input.parentAttemptId && input.parentAttemptId === input.attemptId) {
    throw new Error('A submission attempt cannot be its own parent');
  }
  if (input.eventKind === 'not_sent_proven') {
    if (!input.proofKind || !PROOF_KIND_SET.has(input.proofKind)) {
      throw new Error('A not-sent event requires an allowlisted proof kind');
    }
  } else if (input.proofKind) {
    throw new Error('Only a not-sent event may carry a proof kind');
  }
  if (input.eventKind === 'boundary_authorized') {
    if (
      !input.boundaryActivationId
      || !UUID_PATTERN.test(input.boundaryActivationId)
      || !input.observedAt
      || !input.createdAt
      || !input.boundaryExpiresAt
      || input.boundaryExpiresAt.getTime() <= input.observedAt.getTime()
    ) throw new Error('A boundary authorization requires exact DB-timed activation and expiry evidence');
  } else if (input.boundaryActivationId || input.boundaryExpiresAt) {
    throw new Error('Only a boundary authorization may carry activation or expiry evidence');
  }
}

function eventValues(input: AppendSubmissionAttemptEventInput) {
  return {
    user_id: input.userId,
    application_id: input.applicationId ?? null,
    packet_id: input.packetId,
    event_id: input.eventId,
    attempt_id: input.attemptId,
    parent_attempt_id: input.parentAttemptId ?? null,
    event_kind: input.eventKind,
    source: input.source,
    operation: input.operation,
    submission_run_id: input.submissionRunId ?? null,
    submission_claim_id: input.submissionClaimId ?? null,
    packet_version: input.packetVersion ?? null,
    posting_key: input.postingIdentity.postingKey,
    job_id: input.postingIdentity.jobId,
    company_role: input.postingIdentity.companyRole,
    company_name: input.postingIdentity.company,
    role: input.postingIdentity.role,
    portal_url: input.postingIdentity.portalUrl,
    portal_identity: input.postingIdentity.portalIdentity,
    proof_kind: input.proofKind ?? null,
    evidence_code: input.evidenceCode ?? null,
    boundary_activation_id: input.boundaryActivationId ?? null,
    boundary_expires_at: input.boundaryExpiresAt ?? null,
    ...(input.observedAt ? { observed_at: input.observedAt } : {}),
    ...(input.createdAt ? { created_at: input.createdAt } : {}),
  };
}

function sameStoredFact(existing: SubmissionAttemptEventRecord, input: AppendSubmissionAttemptEventInput): boolean {
  const expected = eventValues(input);
  return existing.user_id === expected.user_id
    && existing.application_id === expected.application_id
    && existing.packet_id === expected.packet_id
    && existing.event_id === expected.event_id
    && existing.attempt_id === expected.attempt_id
    && existing.parent_attempt_id === expected.parent_attempt_id
    && existing.event_kind === expected.event_kind
    && existing.source === expected.source
    && existing.operation === expected.operation
    && existing.submission_run_id === expected.submission_run_id
    && existing.submission_claim_id === expected.submission_claim_id
    && existing.packet_version === expected.packet_version
    && existing.posting_key === expected.posting_key
    && existing.job_id === expected.job_id
    && existing.company_role === expected.company_role
    && existing.company_name === expected.company_name
    && existing.role === expected.role
    && existing.portal_url === expected.portal_url
    && existing.portal_identity === expected.portal_identity
    && existing.proof_kind === expected.proof_kind
    && existing.evidence_code === expected.evidence_code
    && existing.boundary_activation_id === expected.boundary_activation_id
    && existing.boundary_expires_at?.getTime() === expected.boundary_expires_at?.getTime()
    && (!input.observedAt || existing.observed_at.getTime() === input.observedAt.getTime());
}

function sameAttemptBinding(existing: SubmissionAttemptEventRecord, input: AppendSubmissionAttemptEventInput): boolean {
  const expected = eventValues(input);
  return existing.user_id === expected.user_id
    && existing.packet_id === expected.packet_id
    && existing.application_id === expected.application_id
    && existing.parent_attempt_id === expected.parent_attempt_id
    && existing.source === expected.source
    && existing.operation === expected.operation
    && existing.submission_run_id === expected.submission_run_id
    && existing.submission_claim_id === expected.submission_claim_id
    && existing.packet_version === expected.packet_version
    && existing.posting_key === expected.posting_key
    && existing.job_id === expected.job_id
    && existing.company_role === expected.company_role
    && existing.company_name === expected.company_name
    && existing.role === expected.role
    && existing.portal_url === expected.portal_url
    && existing.portal_identity === expected.portal_identity;
}

export class SubmissionAttemptEventConflictError extends Error {
  readonly code = 'SUBMISSION_ATTEMPT_EVENT_CONFLICT';

  constructor(eventId: string) {
    super(`Submission attempt event ${eventId} was already bound to different evidence`);
    this.name = 'SubmissionAttemptEventConflictError';
  }
}

export class SubmissionAttemptBindingConflictError extends Error {
  readonly code = 'SUBMISSION_ATTEMPT_BINDING_CONFLICT';

  constructor(attemptId: string) {
    super(`Submission attempt ${attemptId} was already bound to different application evidence`);
    this.name = 'SubmissionAttemptBindingConflictError';
  }
}

/** Insert one fact, or return the identical fact when an idempotent request is replayed. */
export async function appendSubmissionAttemptEvent(
  input: AppendSubmissionAttemptEventInput,
  options: { executor?: SubmissionAttemptLedgerExecutor } = {},
): Promise<{ event: SubmissionAttemptEventRecord; replay: boolean }> {
  assertAppendInput(input);
  if (!options.executor) {
    return db.transaction((tx) => appendSubmissionAttemptEvent(input, { executor: tx }));
  }
  const executor = options.executor;
  // Every authority fact shares the user advisory transaction lock. Callers supplying an executor
  // must supply their active write transaction; the lock is reentrant when the sink already owns it.
  await lockSubmissionAttemptUser(executor, input.userId);
  const existingAttempt = await executor.select().from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, input.userId),
    eq(application_submission_attempt_events.attempt_id, input.attemptId),
  )).limit(1);
  if (existingAttempt[0] && !sameAttemptBinding(existingAttempt[0], input)) {
    throw new SubmissionAttemptBindingConflictError(input.attemptId);
  }

  let inserted: SubmissionAttemptEventRecord[];
  try {
    inserted = await executor.insert(application_submission_attempt_events)
      .values(eventValues(input))
      .onConflictDoNothing({
        target: [application_submission_attempt_events.user_id, application_submission_attempt_events.event_id],
      })
      .returning();
  } catch (error) {
    if (/submission attempt binding conflict/i.test(String((error as Error)?.message ?? error))) {
      throw new SubmissionAttemptBindingConflictError(input.attemptId);
    }
    throw error;
  }
  if (inserted[0]) return { event: inserted[0], replay: false };

  const existing = await executor.select().from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, input.userId),
    eq(application_submission_attempt_events.event_id, input.eventId),
  )).limit(1);
  if (existing[0] && sameStoredFact(existing[0], input)) return { event: existing[0], replay: true };
  throw new SubmissionAttemptEventConflictError(input.eventId);
}

/** Serialize all submission reservations for one user before opening another one. */
export async function lockSubmissionAttemptUser(
  executor: Pick<typeof db, 'execute'>,
  userId: string,
): Promise<void> {
  await executor.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`submission-attempt:${userId}`}, 0::bigint))`);
}

/** Read the one immutable employer-boundary authorization for an exact attempt. */
export async function submissionBoundaryAuthorization(
  userId: string,
  attemptId: string,
  options: { executor?: Pick<SubmissionAttemptLedgerExecutor, 'select'> } = {},
): Promise<SubmissionBoundaryAuthorization | null> {
  const executor = options.executor ?? db;
  const [authorization] = await executor.select({
    eventId: application_submission_attempt_events.event_id,
    attemptId: application_submission_attempt_events.attempt_id,
    activationId: application_submission_attempt_events.boundary_activation_id,
    authorizedAt: application_submission_attempt_events.observed_at,
    expiresAt: application_submission_attempt_events.boundary_expires_at,
    serverNow: sql<Date>`clock_timestamp()`,
  }).from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, userId),
    eq(application_submission_attempt_events.attempt_id, attemptId),
    eq(application_submission_attempt_events.event_kind, 'boundary_authorized'),
  )).limit(1);
  if (!authorization?.activationId || !authorization.expiresAt) return null;
  const serverNow = new Date(authorization.serverNow);
  return {
    leaseId: authorization.eventId,
    attemptId: authorization.attemptId,
    activationId: authorization.activationId,
    authorizedAt: authorization.authorizedAt.toISOString(),
    expiresAt: authorization.expiresAt.toISOString(),
    serverNow: serverNow.toISOString(),
    active: authorization.expiresAt.getTime() > serverNow.getTime(),
  };
}

/**
 * Linearize one employer capability after the caller has taken the user advisory lock and
 * completed every mutable-state and duplicate check. The deterministic fact id makes concurrent
 * retries converge on one row. Only a `fresh` result authorizes a new automatic boundary or a new
 * attended capability. An explicit attended resume may re-deliver `existing` only while its caller
 * verifies the exact active lease, attempt, activation, current packet, and unresolved ledger fold.
 */
export async function authorizeFinalSubmissionBoundary(
  binding: SubmissionAttemptBinding,
  options: {
    executor: SubmissionAttemptLedgerExecutor;
    factKey: string;
    activationId?: string;
    evidenceCode?: string;
    ttlMs?: number;
  },
): Promise<FinalSubmissionBoundaryAuthorization> {
  const ttlMs = options.ttlMs ?? SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 5 * 60 * 1000) {
    throw new Error('Submission boundary authorization TTL must be between 1 ms and 5 minutes');
  }
  const events = await options.executor.select().from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, binding.userId),
    eq(application_submission_attempt_events.attempt_id, binding.attemptId),
  )).orderBy(asc(application_submission_attempt_events.created_at), asc(application_submission_attempt_events.id));
  const retrySafety = submissionAttemptRetrySafety(events);
  const existing = await submissionBoundaryAuthorization(binding.userId, binding.attemptId, {
    executor: options.executor,
  });
  if (existing) {
    if (retrySafety.kind !== 'blocked_unverified' || retrySafety.reason !== 'boundary_authorized') {
      return { kind: 'blocked', retrySafety };
    }
    if (options.activationId && options.activationId !== existing.activationId) {
      return { kind: 'activation_conflict', retrySafety };
    }
    return { kind: 'existing', authorization: existing, retrySafety };
  }
  if (retrySafety.kind !== 'blocked_unverified' || retrySafety.reason !== 'opened') {
    return { kind: 'blocked', retrySafety };
  }

  const clockResult = await options.executor.execute(sql`select clock_timestamp() as authorized_at`);
  const clockValue = (clockResult.rows[0] as { authorized_at?: Date | string } | undefined)?.authorized_at;
  const authorizedAt = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
  if (Number.isNaN(authorizedAt.getTime())) throw new Error('Database authorization clock was unavailable');
  const activationId = options.activationId ?? submissionAttemptEventId(
    binding.attemptId,
    'boundary_authorized',
    'final-boundary-activation',
  );
  const expiresAt = new Date(authorizedAt.getTime() + ttlMs);
  try {
    await appendSubmissionAttemptEvent({
      ...binding,
      eventId: submissionAttemptEventId(binding.attemptId, 'boundary_authorized', 'final-boundary'),
      eventKind: 'boundary_authorized',
      evidenceCode: options.evidenceCode ?? options.factKey,
      boundaryActivationId: activationId,
      boundaryExpiresAt: expiresAt,
      observedAt: authorizedAt,
      createdAt: authorizedAt,
    }, { executor: options.executor });
  } catch (error) {
    if (!(error instanceof SubmissionAttemptEventConflictError)) throw error;
  }
  const authorization = await submissionBoundaryAuthorization(binding.userId, binding.attemptId, {
    executor: options.executor,
  });
  if (!authorization) return { kind: 'blocked', retrySafety };
  const updatedEvents = await options.executor.select().from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, binding.userId),
    eq(application_submission_attempt_events.attempt_id, binding.attemptId),
  )).orderBy(asc(application_submission_attempt_events.created_at), asc(application_submission_attempt_events.id));
  const updatedSafety = submissionAttemptRetrySafety(updatedEvents);
  if (authorization.activationId !== activationId) {
    return { kind: 'activation_conflict', retrySafety: updatedSafety };
  }
  if (updatedSafety.kind !== 'blocked_unverified'
    || updatedSafety.reason !== 'boundary_authorized'
    || updatedSafety.attemptId !== binding.attemptId
    || updatedSafety.leaseId !== authorization.leaseId
    || updatedSafety.expiresAt !== authorization.expiresAt) {
    return { kind: 'blocked', retrySafety: updatedSafety };
  }
  return { kind: 'fresh', authorization, retrySafety: updatedSafety };
}

function iso(value: Date): string {
  return value.toISOString();
}

function bindingSignature(event: SubmissionAttemptEventRecord): string {
  return JSON.stringify([
    event.user_id,
    event.packet_id,
    event.application_id,
    event.parent_attempt_id,
    event.source,
    event.operation,
    event.submission_run_id,
    event.submission_claim_id,
    event.packet_version,
    event.posting_key,
    event.job_id,
    event.company_role,
    event.company_name,
    event.role,
    event.portal_url,
    event.portal_identity,
  ]);
}

function attemptBindingIsConsistent(events: readonly SubmissionAttemptEventRecord[]): boolean {
  if (events.length === 0) return true;
  const attemptId = events[0]!.attempt_id;
  const signature = bindingSignature(events[0]!);
  return events.every((event) => event.attempt_id === attemptId && bindingSignature(event) === signature);
}

/** Fold immutable facts for exactly one attempt into the one answer a retry gate needs. */
export function submissionAttemptRetrySafety(
  unsorted: readonly SubmissionAttemptEventRecord[],
): SubmissionAttemptRetrySafety {
  if (unsorted.length === 0) return { kind: 'no_evidence' };
  const events = [...unsorted].sort((left, right) => {
    const byCreated = left.created_at.getTime() - right.created_at.getTime();
    if (byCreated !== 0) return byCreated;
    return left.id.localeCompare(right.id);
  });
  const attemptId = events[0]!.attempt_id;
  const invalidBinding = !attemptBindingIsConsistent(events);
  const invalidVocabulary = events.some((event) => !EVENT_KIND_SET.has(event.event_kind)
    || !SOURCE_SET.has(event.source)
    || !OPERATION_SET.has(event.operation)
    || (event.event_kind === 'not_sent_proven'
      ? !event.proof_kind || !PROOF_KIND_SET.has(event.proof_kind)
      : event.proof_kind !== null)
    || (event.event_kind === 'boundary_authorized'
      ? !event.boundary_activation_id
        || !event.boundary_expires_at
        || event.boundary_expires_at <= event.observed_at
      : event.boundary_activation_id !== null || event.boundary_expires_at !== null));
  if (invalidBinding || invalidVocabulary) {
    const anchor = events.find((event) => event.event_kind === 'press_observed') ?? events[0]!;
    return {
      kind: 'blocked_unverified',
      attemptId,
      at: iso(anchor.observed_at),
      reason: 'invalid_sequence',
    };
  }
  const confirmed = events.find((event) => event.event_kind === 'submission_confirmed');
  if (confirmed) {
    return { kind: 'blocked_confirmed', attemptId, confirmedAt: iso(confirmed.observed_at) };
  }

  const opened = events.filter((event) => event.event_kind === 'attempt_opened');
  const authorized = events.filter((event) => event.event_kind === 'boundary_authorized');
  const pressed = events.filter((event) => event.event_kind === 'press_observed');
  const notSent = events.filter((event) => event.event_kind === 'not_sent_proven');
  /* Authorization is durable boundary risk, but it is not evidence that a press happened. Once
   * it exists, no machine-authored not-sent proof may close the attempt. Only the applicant's exact
   * post-expiry check is admissible, and the route enforces that timing before writing the fact. */
  const lastRisk = [...opened, ...authorized, ...pressed]
    .sort((left, right) => left.created_at.getTime() - right.created_at.getTime()).at(-1);
  const resolution = notSent.at(-1);
  const resolutionProof = resolution?.proof_kind as SubmissionNotSentProofKind | null | undefined;
  const pressContradictsProof = pressed.length > 0
    && Boolean(resolutionProof && PRE_CLICK_ONLY_PROOFS.has(resolutionProof));
  const authorizationContradictsProof = authorized.length > 0
    && resolutionProof !== 'applicant_checked_not_sent'
    && resolutionProof !== 'applicant_checked_all_possible_destinations_not_sent';
  const riskAfterResolution = Boolean(lastRisk && resolution && lastRisk.created_at > resolution.created_at);
  const invalidSequence = invalidBinding
    || invalidVocabulary
    || opened.length !== 1
    || authorized.length > 1
    || authorized.some((event) => event.created_at < opened[0]!.created_at)
    || pressed.some((event) => event.created_at < opened[0]!.created_at)
    || notSent.length > 1
    || (notSent.length > 0 && (
      !resolutionProof
      || pressContradictsProof
      || authorizationContradictsProof
      || riskAfterResolution
    ));

  if (!invalidSequence && resolution && resolutionProof) {
    return {
      kind: 'safe_not_sent',
      attemptId,
      proofKind: resolutionProof,
      resolvedAt: iso(resolution.observed_at),
    };
  }

  const anchor = pressed.at(-1) ?? authorized.at(-1) ?? opened[0] ?? events[0]!;
  if (!invalidSequence && pressed.length === 0 && authorized.length === 1) {
    const authorization = authorized[0]!;
    return {
      kind: 'blocked_unverified',
      attemptId,
      at: iso(authorization.observed_at),
      reason: 'boundary_authorized',
      leaseId: authorization.event_id,
      expiresAt: authorization.boundary_expires_at!.toISOString(),
    };
  }
  return {
    kind: 'blocked_unverified',
    attemptId,
    at: iso(anchor.observed_at),
    reason: invalidSequence ? 'invalid_sequence' : pressed.length > 0 ? 'pressed' : 'opened',
  };
}

export function frozenPostingIdentityFromEvent(event: SubmissionAttemptEventRecord): FrozenPostingIdentity {
  return {
    // Legacy cutover facts freeze the normalized portal URL but predate the stored ATS key.
    // Derive only from that immutable URL so an old surrogate job id or renamed company and role
    // cannot outrank the employer's posting id and let the same posting through again.
    postingKey: event.posting_key ?? atsPostingKey(event.portal_url),
    jobId: event.job_id,
    companyRole: event.company_role,
    company: event.company_name,
    role: event.role,
    portalUrl: event.portal_url,
    portalIdentity: event.portal_identity,
  };
}

function storedPostingIdentityFromEvent(event: SubmissionAttemptEventRecord): FrozenPostingIdentity {
  return {
    postingKey: event.posting_key,
    jobId: event.job_id,
    companyRole: event.company_role,
    company: event.company_name,
    role: event.role,
    portalUrl: event.portal_url,
    portalIdentity: event.portal_identity,
  };
}

export function submissionAttemptBindingFromEvent(event: SubmissionAttemptEventRecord): SubmissionAttemptBinding {
  return {
    attemptId: event.attempt_id,
    userId: event.user_id,
    packetId: event.packet_id,
    applicationId: event.application_id,
    parentAttemptId: event.parent_attempt_id,
    source: event.source as SubmissionAttemptSource,
    operation: event.operation as SubmissionAttemptOperation,
    // Re-appended facts must preserve the exact immutable columns stored on the opening fact.
    // Legacy openings can have a null posting_key even when their frozen URL now lets duplicate
    // checks derive an ATS key. Using that derived key here would turn a safe resolution into a
    // binding conflict instead of appending a fact to the original attempt.
    postingIdentity: storedPostingIdentityFromEvent(event),
    submissionRunId: event.submission_run_id,
    submissionClaimId: event.submission_claim_id,
    packetVersion: event.packet_version,
  };
}

function groupByAttempt(events: readonly SubmissionAttemptEventRecord[]) {
  const grouped = new Map<string, SubmissionAttemptEventRecord[]>();
  for (const event of events) {
    const existing = grouped.get(event.attempt_id) ?? [];
    existing.push(event);
    grouped.set(event.attempt_id, existing);
  }
  return grouped;
}

/** The immutable root that may be narrowed by an applicant-supplied exact posting.
 *
 * This is deliberately stricter than `submissionAttemptRetrySafety`: confirmed evidence always
 * wins that fold, even when duplicate structural facts are present. Suppressing a user-wide parent
 * needs one coherent binding, one opening, confirmed evidence, and no child identity of its own.
 * More than one press or confirmation is still coherent: managed verification can require an
 * initial application press plus a code-form press, and an employer email can independently
 * confirm an attempt whose receipt was already recorded.
 */
export function confirmedWeakPostingIdentityOpening(
  events: readonly SubmissionAttemptEventRecord[],
): SubmissionAttemptEventRecord | null {
  if (events.length === 0 || !attemptBindingIsConsistent(events)) return null;
  const opening = events.find((event) => event.event_kind === 'attempt_opened');
  if (!opening
    || opening.parent_attempt_id !== null
    || events.some((event) => event.attempt_id !== opening.attempt_id)
    || events.filter((event) => event.event_kind === 'attempt_opened').length !== 1
    || events.filter((event) => event.event_kind === 'submission_confirmed').length < 1
    || events.filter((event) => event.event_kind === 'not_sent_proven').length > 1
    || events.filter((event) => event.event_kind === 'boundary_authorized').length > 1
    || events.some((event) => event.created_at < opening.created_at)
    || frozenPostingIdentityHasExactScope(frozenPostingIdentityFromEvent(opening))
    || submissionAttemptRetrySafety(events).kind !== 'blocked_confirmed') return null;
  return opening;
}

export type ConfirmedOrphanAttribution = {
  parentAttemptId: string;
  attemptId: string;
  postingIdentity: FrozenPostingIdentity;
  retrySafety: Extract<SubmissionAttemptRetrySafety, { kind: 'blocked_confirmed' }>;
};

/** Return the one exact append-only attribution that narrows a confirmed weak-identity hold.
 *
 * The first cut of this repair covered only identity-less extension orphans. Legacy imports can
 * also contain a real confirmed application whose packet preserved company and role labels but no
 * immutable posting identifier. Those rows otherwise block every future application forever.
 * The parent stays immutable and confirmed; an exact applicant-attributed child supplies the one
 * posting identity the historical fact was missing.
 */
export function confirmedOrphanAttributionForParent(
  events: readonly SubmissionAttemptEventRecord[],
  parentAttemptId: string,
): ConfirmedOrphanAttribution | null {
  const grouped = groupByAttempt(events);
  const parentEvents = grouped.get(parentAttemptId) ?? [];
  const parentOpening = confirmedWeakPostingIdentityOpening(parentEvents);
  if (!parentOpening) return null;

  const directChildren = [...grouped.entries()].filter(([, exactEvents]) =>
    exactEvents.some((event) => event.parent_attempt_id === parentAttemptId));
  if (directChildren.length !== 1) return null;
  const [attemptId, exactEvents] = directChildren[0]!;
  if (attemptId === parentAttemptId
    || events.some((event) => event.parent_attempt_id === attemptId)) return null;

  {
    const opening = exactEvents.find((event) => event.event_kind === 'attempt_opened');
    const confirmations = exactEvents.filter((event) => event.event_kind === 'submission_confirmed');
    if (!opening
      || confirmations.length < 1
      || exactEvents.length !== 1 + confirmations.length
      || exactEvents.filter((event) => event.event_kind === 'attempt_opened').length !== 1
      || !attemptBindingIsConsistent(exactEvents)
      || opening.parent_attempt_id !== parentAttemptId
      || opening.user_id !== parentOpening.user_id
      || opening.packet_id !== parentOpening.packet_id
      || opening.application_id !== parentOpening.application_id
      || opening.source !== 'attended_handoff'
      || opening.operation !== 'initial_submission'
      || opening.evidence_code !== ORPHAN_ATTRIBUTION_OPENING_EVIDENCE
      || confirmations.some((confirmation) =>
        confirmation.evidence_code !== ORPHAN_ATTRIBUTION_CONFIRMATION_EVIDENCE
        || confirmation.created_at < opening.created_at)
      || !opening.company_name.trim()
      || !opening.role.trim()
      || !opening.portal_url) return null;
    let parsedPortal: URL;
    try {
      parsedPortal = new URL(opening.portal_url);
    } catch {
      return null;
    }
    if ((parsedPortal.protocol !== 'https:' && parsedPortal.protocol !== 'http:')
      || parsedPortal.username
      || parsedPortal.password
      || parsedPortal.hash
      || canonicalPublicPostingUrl(opening.portal_url) !== opening.portal_url) return null;
    const postingIdentity = frozenPostingIdentityFromEvent(opening);
    const normalized = freezePostingIdentity({
      company: opening.company_name,
      role: opening.role,
      ...(opening.job_id ? { job_id: opening.job_id } : {}),
    }, opening.portal_url);
    if (!postingIdentity.companyRole
      || !frozenPostingIdentityHasExactScope(postingIdentity)
      || postingIdentity.postingKey !== normalized.postingKey
      || postingIdentity.jobId !== normalized.jobId
      || postingIdentity.companyRole !== normalized.companyRole
      || postingIdentity.portalUrl !== normalized.portalUrl
      || postingIdentity.portalIdentity !== normalized.portalIdentity) return null;
    const retrySafety = submissionAttemptRetrySafety(exactEvents);
    if (retrySafety.kind !== 'blocked_confirmed') return null;
    return { parentAttemptId, attemptId, postingIdentity, retrySafety };
  }
}

export function blockingSubmissionAttemptsFromEvents(
  events: readonly SubmissionAttemptEventRecord[],
): BlockingSubmissionAttempt[] {
  const grouped = groupByAttempt(events);
  const blocked: BlockingSubmissionAttempt[] = [];
  for (const [attemptId, attemptEvents] of grouped) {
    const retrySafety = submissionAttemptRetrySafety(attemptEvents);
    if (retrySafety.kind !== 'blocked_confirmed' && retrySafety.kind !== 'blocked_unverified') continue;
    const opening = attemptEvents.find((event) => event.event_kind === 'attempt_opened');
    const first = opening ?? attemptEvents[0]!;
    const postingIdentity = attemptBindingIsConsistent(attemptEvents)
      ? frozenPostingIdentityFromEvent(first)
      : {
        postingKey: null,
        jobId: null,
        companyRole: null,
        company: '',
        role: '',
        portalUrl: null,
        portalIdentity: null,
      };
    const isUnscopedRoot = first.parent_attempt_id === null
      && !frozenPostingIdentityHasExactScope(postingIdentity);
    // The parent remains immutable and confirmed. Once an exact confirmed child supplies a posting
    // identity, the child is the durable duplicate block and the blank parent no longer blocks all
    // unrelated postings.
    if (isUnscopedRoot
      && retrySafety.kind === 'blocked_confirmed'
      && confirmedOrphanAttributionForParent(events, attemptId)) continue;
    blocked.push({
      attemptId,
      parentAttemptId: first.parent_attempt_id,
      userId: first.user_id,
      packetId: first.packet_id,
      applicationId: first.application_id,
      source: first.source as SubmissionAttemptSource,
      operation: first.operation as SubmissionAttemptOperation,
      postingIdentity,
      retrySafety,
    });
  }
  return blocked.sort((left, right) => {
    if (left.retrySafety.kind !== right.retrySafety.kind) {
      return left.retrySafety.kind === 'blocked_confirmed' ? -1 : 1;
    }
    const leftAt = left.retrySafety.kind === 'blocked_confirmed'
      ? left.retrySafety.confirmedAt : left.retrySafety.at;
    const rightAt = right.retrySafety.kind === 'blocked_confirmed'
      ? right.retrySafety.confirmedAt : right.retrySafety.at;
    return leftAt.localeCompare(rightAt);
  });
}

/** Packet projection with cross-attempt precedence. One safe retry never excuses another risk. */
export function submissionAttemptRetrySafetyForPacketEvents(
  events: readonly SubmissionAttemptEventRecord[],
): SubmissionAttemptRetrySafety {
  const folded = [...groupByAttempt(events).values()].map(submissionAttemptRetrySafety);
  const confirmed = folded
    .filter((result): result is Extract<SubmissionAttemptRetrySafety, { kind: 'blocked_confirmed' }> =>
      result.kind === 'blocked_confirmed')
    .sort((left, right) => left.confirmedAt.localeCompare(right.confirmedAt))[0];
  if (confirmed) return confirmed;
  const unverified = folded
    .filter((result): result is Extract<SubmissionAttemptRetrySafety, { kind: 'blocked_unverified' }> =>
      result.kind === 'blocked_unverified')
    .sort((left, right) => left.at.localeCompare(right.at))[0];
  if (unverified) return unverified;
  const safe = folded
    .filter((result): result is Extract<SubmissionAttemptRetrySafety, { kind: 'safe_not_sent' }> =>
      result.kind === 'safe_not_sent')
    .sort((left, right) => right.resolvedAt.localeCompare(left.resolvedAt))[0];
  return safe ?? { kind: 'no_evidence' };
}

export async function submissionAttemptEventsForUser(
  userId: string,
  options: { executor?: Pick<typeof db, 'select'> } = {},
): Promise<SubmissionAttemptEventRecord[]> {
  const executor = options.executor ?? db;
  return executor.select().from(application_submission_attempt_events)
    .where(eq(application_submission_attempt_events.user_id, userId))
    .orderBy(asc(application_submission_attempt_events.created_at), asc(application_submission_attempt_events.id));
}

function utcDayStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Count durable automatic-submission reservations for the current UTC day.
 *
 * `observed_at` is the reservation time. Using `created_at` would incorrectly charge today's cap
 * for historical facts inserted by a later backfill. The source and operation allowlists count
 * only real automatic reservations. Manual outcomes, migration rows, and delayed email evidence
 * bridges do not consume this cap.
 */
export async function submissionAttemptsOpenedToday(
  userId: string,
  options: { executor?: Pick<typeof db, 'select'>; since?: Date } = {},
): Promise<number> {
  const executor = options.executor ?? db;
  const since = options.since ?? utcDayStart();
  if (Number.isNaN(since.getTime())) throw new Error('Submission attempt cap cutoff must be a valid date');
  const rows = await executor.select({
    total: countDistinct(application_submission_attempt_events.attempt_id),
  }).from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, userId),
    eq(application_submission_attempt_events.event_kind, 'attempt_opened'),
    inArray(application_submission_attempt_events.source, [
      'managed_browser',
      'direct_browser',
      'chrome_extension',
      'unsupported_email',
      'ats_api',
    ]),
    inArray(application_submission_attempt_events.operation, [
      'initial_submission',
      'security_code_continuation',
    ]),
    gte(application_submission_attempt_events.observed_at, since),
  ));
  return Number(rows[0]?.total ?? 0);
}

export async function submissionAttemptEventsForPacket(
  userId: string,
  packetId: string,
  options: { executor?: Pick<typeof db, 'select'> } = {},
): Promise<SubmissionAttemptEventRecord[]> {
  const executor = options.executor ?? db;
  return executor.select().from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, userId),
    eq(application_submission_attempt_events.packet_id, packetId),
  )).orderBy(asc(application_submission_attempt_events.created_at), asc(application_submission_attempt_events.id));
}

export async function blockingSubmissionAttemptsForUser(
  userId: string,
  options: { executor?: Pick<typeof db, 'select'> } = {},
): Promise<BlockingSubmissionAttempt[]> {
  return blockingSubmissionAttemptsFromEvents(await submissionAttemptEventsForUser(userId, options));
}

export async function blockingSubmissionAttemptsForPacket(
  userId: string,
  packetId: string,
  options: { executor?: Pick<typeof db, 'select'> } = {},
): Promise<BlockingSubmissionAttempt[]> {
  return blockingSubmissionAttemptsFromEvents(await submissionAttemptEventsForPacket(userId, packetId, options));
}

export async function submissionAttemptRetrySafetyForPacket(
  userId: string,
  packetId: string,
  options: { executor?: Pick<typeof db, 'select'> } = {},
): Promise<SubmissionAttemptRetrySafety> {
  return submissionAttemptRetrySafetyForPacketEvents(
    await submissionAttemptEventsForPacket(userId, packetId, options),
  );
}

/* THE LEDGER CAN ARRIVE BEFORE THE TABLES IT READS.
 *
 * These four tables are created by a separately dispatched migration, not by anything that runs on
 * deploy: there is no postinstall or vercel-build hook, and src/db/migrate.ts points at a drizzle
 * directory this repo does not have. Merging ships the code; the migration does not follow it. The
 * cutover fence does not cover that gap either, because its default is off and the dashboard list
 * is deliberately readable even while submissions are paused.
 *
 * So the gap has to be VISIBLE. The migration's own completion marker is the honest signal, and an
 * absent one means "not migrated yet", not "broken". Reported at /health so a runtime that landed
 * ahead of its migration is caught by the same revision-and-state check every other release step
 * already makes, instead of first showing up as 500s on somebody's board.
 *
 * This never throws, and it ALWAYS TIMES OUT, for the reason healthProbe.ts gives and for one more
 * specific to this runtime: on Vercel the pool is a single client with no connectionTimeoutMillis,
 * so this read queues on pool.connect() behind any open transaction. Unbounded, it would put the
 * very pool-exhaustion hang this release removed from the submission path onto /health, which is
 * the one page an incident needs working. It borrows the database probe's own tuned budget rather
 * than inventing a second number, because it is waiting on the same pool for the same reasons.
 */
export async function submissionLedgerReadiness(
  executor: Pick<typeof db, 'select'> = db,
  timeoutMs: number = DATABASE_PROBE_TIMEOUT_MS,
): Promise<{ ready: boolean; reason: 'cutover_recorded' | 'not_migrated' | 'unreadable' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('probe timeout')), timeoutMs);
    });
    const rows = await Promise.race([
      executor
        .select({ cutover_key: application_submission_attempt_ledger_cutovers.cutover_key })
        .from(application_submission_attempt_ledger_cutovers)
        .limit(1),
      timeout,
    ]);
    return rows.length > 0
      ? { ready: true, reason: 'cutover_recorded' as const }
      : { ready: false, reason: 'not_migrated' as const };
  } catch {
    /* A missing relation, an unreachable database and a saturated pool all collapse to "cannot say
     * it is ready", which is the only distinction a release needs. The same response already
     * carries `database`, which separates a dead database from a merely unmigrated one, and the
     * driver's message can name hosts and roles so it stays out of an unauthenticated body. */
    return { ready: false, reason: 'unreadable' as const };
  } finally {
    // Serverless will not freeze the invocation while a stray timer is pending, so an uncleared one
    // keeps the function billable after the response has been sent. Same reason as probeDatabase.
    if (timer !== undefined) clearTimeout(timer);
  }
}
