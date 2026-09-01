import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { DATABASE_CONNECTION_TIMEOUT_MS, db, pool } from '../db/index';
import {
  career_page_sources,
  job_board_group_projection,
  job_board_group_projection_state,
  logo_verification_provider_circuits,
  monitored_jobs,
  profiles,
  sponsor_employers,
  targeting,
  users,
} from '../db/schema';
import { decide, isBlocked } from '../engine/eligibility';
import {
  normalizeEmployerName,
  readPostingSponsorshipAssessment,
  sponsorOnlyBoardRequired,
  sponsorshipVerdict,
  type PostingSponsorship,
  type PostingSponsorshipScope,
} from '../lib/sponsorship';
import { postingCountryCodeFromJobContext, resolveJobCountry } from '../lib/jobLocation';
import { portalNameAgrees } from '../lib/sponsorIdentity';
import { isCronAuthorized, isCronConfigured } from '../lib/cronAuth';
import {
  fetchSourceJobBatch,
  isIngestablePosting,
  POLLABLE_JOB_BOARDS,
  type DetailFetchProgress,
  type JobSourceInput,
  type SupportedJobBoard,
} from '../lib/jobMonitor';
import { JOB_SOURCES } from '../lib/jobSources';
import { discoverJobSources, type JobSourceDiscoveryResult } from '../lib/jobSourceDiscovery';
import { CATALOG_DOMAIN_CANDIDATE_METHOD, catalogBrandedJobSources } from '../lib/jobSourceBrandCatalog';
import { verifyCatalogSourceLogo } from '../lib/jobSourceLogoVerification';
import {
  VERIFIED_ATS_DURABLE_COPY_LOGO_METHOD,
  VERIFIED_ATS_SOURCE_LOGO_METHOD,
  verifyAtsSourceBranding,
} from '../lib/atsSourceBranding';
import { persistDurableAtsLogo } from '../lib/durableAtsLogo';
import {
  isTransientLogoVerificationReason,
  retryTransientLogoVerification,
} from '../lib/logoVerificationRetry';
import { normalizeExecutableAtsBoardToken } from '../lib/atsBoardToken';
import { H1B_EMPLOYERS } from '../lib/sponsorEmployers';
import { AUTONOMOUS_PORTAL_FAMILIES } from '../lib/portalSubmission';
import { rankCities } from '../lib/cities';
import { optionalAuth } from '../middleware/auth';
import { scoreJdMatch } from '../engine/jdMatch';
import { resumeSpecText } from '../engine/resumeValidate';
import type { ResumeSpec } from '../llm/resumeSpec';
import { rankingCacheKey, readRankingShared, writeRankingShared } from '../lib/rankingCache';
import { buildDescriptionDigest } from '../lib/descriptionDigest';
import {
  buildJobCertificationFingerprint,
  normalizeEmployerCertificationIdentity,
} from '../lib/jobCertificationFingerprint';
import {
  JOB_BOARD_CURSOR_START,
  JobBoardCursorError,
  decodeJobBoardCursor,
  encodeJobBoardCursor,
  jobBoardCursorFilterHash,
  jobBoardCursorSigningSecret,
  type GroupedJobsCursorKey,
  type JobsCursorKey,
} from '../lib/jobBoardCursor';
import { applyBoardCacheHeaders } from '../lib/boardCacheHeaders';
import { companyDomainFor } from '../lib/companyDomains';
import { classificationCoverage, summarizeJobVariety } from '../lib/jobVariety';
import {
  MINIMUM_MATCHES_PER_TARGET_ROLE,
  targetRoleCoverageFromCounts,
  unavailableTargetRoleCoverage,
} from '../lib/targetRoleCoverage';
import {
  POLL_CONCURRENCY,
  POLL_SEGMENT_SIZE,
  POLL_SOURCE_LIMIT,
  POLL_START_RESERVE_MS,
  POLL_TIME_BUDGET_MS,
  WORKABLE_START_INTERVAL_MS,
  pollSourcesWithinBudget,
  retryTransient,
} from '../lib/jobPollScheduler';
import { tryAcquireJobMonitorLock } from '../lib/jobMonitorLock';
import {
  hasTargeting,
  isRemoteLocation,
  normalizeTargeting,
  preferenceFit,
  recommendationTargetingEligible,
  roleTypePattern,
  targetTitleTerms,
  type JobTargeting,
} from '../lib/jobPreferences';

export const LOGO_VERIFICATION_STATUSES = ['unverified', 'verified', 'failed'] as const;
export type LogoVerificationStatus = typeof LOGO_VERIFICATION_STATUSES[number];

/**
 * Optional source-level brand proof accepted from the reviewed catalog or operator endpoint.
 *
 * This remains local to the persistence boundary. Provider normalizers return postings, not brand
 * attestations, and must not be able to mint verified evidence merely because an ATS response
 * happened to contain an image-shaped URL.
 */
export type JobSourceWithLogoEvidence = JobSourceInput & {
  company_domain?: string | null;
  company_logo_url?: string | null;
  logo_verification_status?: LogoVerificationStatus;
  logo_verification_method?: string | null;
  logo_verified_at?: Date | string | null;
};

const bareCompanyDomainSchema = z.string().trim().toLowerCase()
  .regex(/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/, 'company_domain must be a bare domain');
const httpsLogoUrlSchema = z.string().url().max(4000)
  .refine((value) => new URL(value).protocol === 'https:', 'company_logo_url must use HTTPS');

const sourceSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  // Derived, never re-listed. This is the runtime gate on POST /internal/job-monitor/sources, and a
  // hand-written copy of the board list here would be the easiest place for the guarantee to rot:
  // it would accept a source the type system forbids, and the row would outlive the mistake.
  // POLLABLE_JOB_BOARDS, not AUTONOMOUS_PORTAL_FAMILIES: a source also needs a fetcher, and
  // accepting one without would store a row the daily poll can only ever record an error against.
  ats_name: z.enum(POLLABLE_JOB_BOARDS),
  board_token: z.string().trim().toLowerCase().min(1).max(300),
  career_url: z.string().url().max(4000),
  company_domain: bareCompanyDomainSchema.nullish(),
  company_logo_url: httpsLogoUrlSchema.nullish(),
  logo_verification_status: z.enum(LOGO_VERIFICATION_STATUSES).optional(),
  logo_verification_method: z.string().trim().min(1).max(100).nullish(),
  logo_verified_at: z.coerce.date().nullish(),
  enabled: z.boolean().optional().default(true),
}).superRefine((source, ctx) => {
  if (!normalizeExecutableAtsBoardToken(source.ats_name, source.board_token)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['board_token'],
      message: 'board_token is not executable by this ATS provider',
    });
  }
  if (source.logo_verified_at
    && source.logo_verified_at.getTime() > Date.now() + 5 * 60 * 1000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['logo_verified_at'],
      message: 'logo verification timestamp cannot be in the future',
    });
  }
  const carriesLogoFields = source.company_domain !== undefined
    || source.company_logo_url !== undefined
    || source.logo_verification_status !== undefined
    || source.logo_verification_method !== undefined
    || source.logo_verified_at !== undefined;
  if (carriesLogoFields && !source.logo_verification_method) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['logo_verification_method'],
      message: 'explicit logo evidence requires a verification method',
    });
  }
  if (source.logo_verification_status !== 'verified') return;
  if (!source.company_logo_url) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['logo_verification_status'],
      message: 'verified logo evidence requires a fetched company_logo_url',
    });
  }
  if (!source.logo_verification_method) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['logo_verification_method'],
      message: 'verified logo evidence requires a verification method',
    });
  }
  if (!source.logo_verified_at) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['logo_verified_at'],
      message: 'verified logo evidence requires a verification timestamp',
    });
  }
}).transform((source) => ({
  ...source,
  /* The provider validator may decode a harmless percent-encoded slug. Persist exactly the token
     the poller executes so identity keys, URLs, and catalog completeness all use one value. */
  board_token: normalizeExecutableAtsBoardToken(source.ats_name, source.board_token)
    ?? source.board_token,
}));

const sourcesBodySchema = z.object({ sources: z.array(sourceSchema).min(1).max(100) });
export const monitorQuerySchema = z.object({
  drain_started_at: z.string().datetime({ offset: true }).optional(),
  initialize_drain: z.literal('true').optional(),
});
export const MONITOR_DRAIN_STARTED_AT_FUTURE_SKEW_MS = 30_000;
export function jobMonitorDrainStartedAtAllowed(
  value: string | undefined,
  now = new Date(),
) {
  if (!value) return true;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed)
    && parsed <= now.getTime() + MONITOR_DRAIN_STARTED_AT_FUTURE_SKEW_MS;
}
export function jobMonitorDrainShouldInitialize(
  drainStartedAt: string | undefined,
  initializeDrain: boolean,
) {
  return !drainStartedAt || initializeDrain;
}
const logoVerificationQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export const LOGO_VERIFICATION_GLOBAL_CONCURRENCY = 16;
export const LOGO_VERIFICATION_PROVIDER_CONCURRENCY = 4;
export const LOGO_VERIFICATION_WORKABLE_START_INTERVAL_MS = 1_100;
export const LOGO_VERIFICATION_REQUEST_CANDIDATES = 16;
export const LOGO_VERIFICATION_PROVIDER_CANDIDATES = 4;
export const LOGO_VERIFICATION_WORKABLE_CANDIDATES = 2;
export const LOGO_VERIFICATION_CRELATE_CANDIDATES = 1;
export const LOGO_VERIFICATION_CRELATE_CONCURRENCY = 1;
/** Leave Railway a full minute to receive the bounded failure response and close the request. */
export const LOGO_VERIFICATION_REQUEST_TIMEOUT_MS = 4 * 60 * 1000;
export const CRELATE_LOGO_CIRCUIT_OPEN_MS = 15 * 60 * 1000;
export const CRELATE_LOGO_CLAIM_LEASE_MS = 5 * 60 * 1000;
export const CRELATE_LOGO_429_EXHAUSTED_REASON = 'ats:http_429_exhausted';
const FAILED_LOGO_RETRY_MS = 7 * 24 * 60 * 60 * 1000;
export const TRANSIENT_LOGO_RETRY_MS = 15 * 60 * 1000;
const PROVISIONAL_SOURCE_LOGO_METHODS = new Set([
  'cc0_board_identifier_candidate',
  'mit_freehire_board_candidate',
  'mit_ats_scrapers_board_candidate',
  CATALOG_DOMAIN_CANDIDATE_METHOD,
]);

export function sourceLogoIdentityMode(method: string): 'provisional' | 'asserted' {
  return PROVISIONAL_SOURCE_LOGO_METHODS.has(method) ? 'provisional' : 'asserted';
}

export function isCrelateLogo429(reason: string): boolean {
  return reason.split(';').some((part) => part.split(':').at(-1) === 'http_429');
}

export function crelateLogoFailureTransition(
  currentAttempts: number,
  previousReason: string | null,
  reason: string,
) {
  if (!isCrelateLogo429(reason)) {
    return { attempts: 0, exhausted: false, reason, opensCircuit: false } as const;
  }
  /* A completed seven-day exhausted cycle starts over at attempt one. During the short retry lane,
     attempts stay consecutive and the third response becomes a durable non-transient failure. */
  const baseline = previousReason === CRELATE_LOGO_429_EXHAUSTED_REASON
    ? 0
    : Math.max(0, Math.min(3, Math.trunc(currentAttempts)));
  const attempts = Math.min(3, baseline + 1);
  const exhausted = attempts >= 3;
  return {
    attempts,
    exhausted,
    reason: exhausted ? CRELATE_LOGO_429_EXHAUSTED_REASON : reason,
    opensCircuit: true,
  } as const;
}

export type CrelateLogoVerificationClaim = {
  token: string;
  halfOpen: boolean;
  leaseExpiresAt: Date;
};

async function ensureCrelateLogoCircuitRow() {
  await db.insert(logo_verification_provider_circuits)
    .values({ provider: 'crelate' })
    .onConflictDoNothing();
}

/** Atomically reserve the single Crelate request allowed in both closed and half-open states. */
export async function acquireCrelateLogoVerificationClaim(
  at = new Date(),
  token: string = randomUUID(),
): Promise<CrelateLogoVerificationClaim | null> {
  await ensureCrelateLogoCircuitRow();
  const leaseExpiresAt = new Date(at.getTime() + CRELATE_LOGO_CLAIM_LEASE_MS);
  const [claimed] = await db.update(logo_verification_provider_circuits).set({
    active_claim_token: token,
    active_claim_expires_at: leaseExpiresAt,
    updated_at: at,
  }).where(and(
    eq(logo_verification_provider_circuits.provider, 'crelate'),
    or(
      isNull(logo_verification_provider_circuits.circuit_open_until),
      lte(logo_verification_provider_circuits.circuit_open_until, at),
    ),
    or(
      isNull(logo_verification_provider_circuits.active_claim_token),
      lte(logo_verification_provider_circuits.active_claim_expires_at, at),
    ),
  )).returning({
    circuitOpenUntil: logo_verification_provider_circuits.circuit_open_until,
  });
  return claimed ? {
    token,
    halfOpen: claimed.circuitOpenUntil !== null,
    leaseExpiresAt,
  } : null;
}

export async function releaseCrelateLogoVerificationClaim(token: string, at = new Date()) {
  const rows = await db.update(logo_verification_provider_circuits).set({
    active_claim_token: null,
    active_claim_expires_at: null,
    updated_at: at,
  }).where(and(
    eq(logo_verification_provider_circuits.provider, 'crelate'),
    eq(logo_verification_provider_circuits.active_claim_token, token),
  )).returning({ provider: logo_verification_provider_circuits.provider });
  return rows.length === 1;
}

export async function openCrelateLogoVerificationCircuit(token: string, at = new Date()) {
  const rows = await db.update(logo_verification_provider_circuits).set({
    circuit_open_until: new Date(at.getTime() + CRELATE_LOGO_CIRCUIT_OPEN_MS),
    active_claim_token: null,
    active_claim_expires_at: null,
    updated_at: at,
  }).where(and(
    eq(logo_verification_provider_circuits.provider, 'crelate'),
    eq(logo_verification_provider_circuits.active_claim_token, token),
  )).returning({ provider: logo_verification_provider_circuits.provider });
  return rows.length === 1;
}

export async function closeCrelateLogoVerificationCircuit(token: string, at = new Date()) {
  const rows = await db.update(logo_verification_provider_circuits).set({
    circuit_open_until: null,
    active_claim_token: null,
    active_claim_expires_at: null,
    updated_at: at,
  }).where(and(
    eq(logo_verification_provider_circuits.provider, 'crelate'),
    eq(logo_verification_provider_circuits.active_claim_token, token),
  )).returning({ provider: logo_verification_provider_circuits.provider });
  return rows.length === 1;
}

export async function readCrelateLogoVerificationBlock(at = new Date()) {
  await ensureCrelateLogoCircuitRow();
  const [state] = await db.select({
    circuitOpenUntil: logo_verification_provider_circuits.circuit_open_until,
    activeClaimExpiresAt: logo_verification_provider_circuits.active_claim_expires_at,
  }).from(logo_verification_provider_circuits)
    .where(eq(logo_verification_provider_circuits.provider, 'crelate'))
    .limit(1);
  const circuitOpenUntil = state?.circuitOpenUntil
    && state.circuitOpenUntil.getTime() > at.getTime()
    ? state.circuitOpenUntil
    : null;
  const activeClaimExpiresAt = state?.activeClaimExpiresAt
    && state.activeClaimExpiresAt.getTime() > at.getTime()
    ? state.activeClaimExpiresAt
    : null;
  const blockedUntil = circuitOpenUntil ?? activeClaimExpiresAt;
  const halfOpen = state?.circuitOpenUntil !== null
    && state?.circuitOpenUntil !== undefined
    && state.circuitOpenUntil.getTime() <= at.getTime();
  return {
    blocked: blockedUntil !== null,
    blockedUntil,
    reason: circuitOpenUntil
      ? 'open'
      : activeClaimExpiresAt ? 'active' : halfOpen ? 'half_open' : 'closed',
  } as const;
}

/** Keep one degraded provider inside the worker request timeout without hiding its deferred rows. */
export function boundedLogoVerificationCandidates<T extends { ats_name: string }>(
  candidates: readonly T[],
): T[] {
  const selected: T[] = [];
  const selectedByProvider = new Map<string, number>();
  for (const candidate of candidates) {
    if (selected.length >= LOGO_VERIFICATION_REQUEST_CANDIDATES) break;
    const providerLimit = candidate.ats_name === 'workable'
      ? LOGO_VERIFICATION_WORKABLE_CANDIDATES
      : candidate.ats_name === 'crelate'
        ? LOGO_VERIFICATION_CRELATE_CANDIDATES
        : LOGO_VERIFICATION_PROVIDER_CANDIDATES;
    const providerSelected = selectedByProvider.get(candidate.ats_name) ?? 0;
    if (providerSelected >= providerLimit) continue;
    selected.push(candidate);
    selectedByProvider.set(candidate.ats_name, providerSelected + 1);
  }
  return selected;
}

type ProviderAwareLogoQueueOptions = {
  concurrency?: number;
  providerConcurrency?: number;
  workableStartIntervalMs?: number;
  timeoutMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
};

export class LogoVerificationRequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Logo verification exceeded its ${timeoutMs}ms request budget`);
    this.name = 'LogoVerificationRequestTimeoutError';
  }
}

/** Bound the whole verifier and each ATS family while spacing the provider with a shared limit. */
export async function runProviderAwareLogoQueue<T extends { ats_name: string }>(
  candidates: readonly T[],
  operation: (candidate: T, signal: AbortSignal) => Promise<void>,
  options: ProviderAwareLogoQueueOptions = {},
): Promise<void> {
  if (candidates.length === 0) return;
  const concurrency = Math.max(1, options.concurrency ?? LOGO_VERIFICATION_GLOBAL_CONCURRENCY);
  const providerConcurrency = Math.max(
    1,
    options.providerConcurrency ?? LOGO_VERIFICATION_PROVIDER_CONCURRENCY,
  );
  const workableStartIntervalMs = Math.max(
    0,
    options.workableStartIntervalMs ?? LOGO_VERIFICATION_WORKABLE_START_INTERVAL_MS,
  );
  const timeoutMs = Math.max(1, options.timeoutMs ?? LOGO_VERIFICATION_REQUEST_TIMEOUT_MS);
  const controller = new AbortController();
  const timeoutError = new LogoVerificationRequestTimeoutError(timeoutMs);
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  const pending = [...candidates];
  const activeByProvider = new Map<string, number>();
  let active = 0;
  let completed = 0;
  let nextWorkableStart = 0;
  let workableTimerPending = false;
  let completionTimerPending = false;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let hasFailure = false;
    let firstFailure: unknown;
    const rejectWhenProviderBarrierClears = () => {
      if (settled || !hasFailure || active !== 0) return;
      const delay = Math.max(0, nextWorkableStart - now());
      if (delay > 0) {
        if (!completionTimerPending) {
          completionTimerPending = true;
          void sleep(delay).then(() => {
            completionTimerPending = false;
            rejectWhenProviderBarrierClears();
          }, () => {
            completionTimerPending = false;
            settled = true;
            reject(firstFailure);
          });
        }
        return;
      }
      settled = true;
      reject(firstFailure);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      if (!hasFailure) {
        hasFailure = true;
        firstFailure = error;
      }
      /* The route holds the shared database advisory lock around this queue. Do not reject while a
         started sibling can still mutate proof state, or while the final Workable start barrier is
         active, because either return would release cross-replica pacing protection too early. */
      rejectWhenProviderBarrierClears();
    };
    const onTimeout = () => {
      controller.abort(timeoutError);
      fail(timeoutError);
    };
    timeout = setTimeout(onTimeout, timeoutMs);
    const schedule = () => {
      if (settled) return;
      if (hasFailure) {
        rejectWhenProviderBarrierClears();
        return;
      }
      if (completed === candidates.length && now() < nextWorkableStart) {
        if (!completionTimerPending) {
          completionTimerPending = true;
          void sleep(nextWorkableStart - now()).then(() => {
            completionTimerPending = false;
            schedule();
          }, fail);
        }
        return;
      }
      if (completed === candidates.length) {
        settled = true;
        resolve();
        return;
      }

      while (active < concurrency) {
        const timestamp = now();
        const index = pending.findIndex((candidate) => {
          const providerActive = activeByProvider.get(candidate.ats_name) ?? 0;
          const providerLimit = candidate.ats_name === 'workable'
            || candidate.ats_name === 'crelate'
            ? 1
            : providerConcurrency;
          return providerActive < providerLimit
            && (candidate.ats_name !== 'workable' || timestamp >= nextWorkableStart);
        });
        if (index < 0) break;
        const [candidate] = pending.splice(index, 1);
        active += 1;
        activeByProvider.set(candidate.ats_name, (activeByProvider.get(candidate.ats_name) ?? 0) + 1);
        if (candidate.ats_name === 'workable') {
          nextWorkableStart = timestamp + workableStartIntervalMs;
        }
        let task: Promise<void>;
        try {
          task = operation(candidate, controller.signal);
        } catch (error) {
          task = Promise.reject(error);
        }
        void task.then(() => {
          active -= 1;
          activeByProvider.set(candidate.ats_name, (activeByProvider.get(candidate.ats_name) ?? 1) - 1);
          completed += 1;
          schedule();
        }, (error) => {
          active -= 1;
          activeByProvider.set(candidate.ats_name, (activeByProvider.get(candidate.ats_name) ?? 1) - 1);
          completed += 1;
          fail(error);
        });
      }

      const workableWaiting = pending.some((candidate) => candidate.ats_name === 'workable');
      if (!workableTimerPending && active < concurrency && workableWaiting) {
        const delay = Math.max(0, nextWorkableStart - now());
        if (delay > 0) {
          workableTimerPending = true;
          void sleep(delay).then(() => {
            workableTimerPending = false;
            schedule();
          }, fail);
        }
      }
    };
    schedule();
  }).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}
const VERIFIED_ATS_BOUND_HOMEPAGE_LOGO_METHOD =
  'first_party_ats_identity_and_homepage_logo_asset';
const VERIFIER_ISSUED_SOURCE_LOGO_METHODS = [
  VERIFIED_ATS_SOURCE_LOGO_METHOD,
  VERIFIED_ATS_DURABLE_COPY_LOGO_METHOD,
  VERIFIED_ATS_BOUND_HOMEPAGE_LOGO_METHOD,
] as const;
/**
 * The two numbers that bound how many BYTES a single board request can pull out of Postgres.
 *
 * They are named, exported and pinned by src/lib/egressBudget.test.ts because on 2026-08-04 this
 * project exhausted its Neon data transfer allowance and every database-backed route began
 * answering 500. Nothing failed until the database refused connections: raising a cap like these
 * is a one-character edit with no visible cost in review, in tests, or on any dashboard the repo
 * owns. Change either one and that test recomputes the worst case and tells you what it costs.
 */
export const MAX_PAGE_SIZE = 100;
/** Characters of description sent per row on the board list. NOT the full column. */
export const BOARD_PREVIEW_CHARS = 600;

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  /* Title-only, and deliberately not the same thing as `q`. `q` matches the title OR the whole
     description, which is right for one general-purpose box and wrong for a field labelled
     "Job title": the board's title field would otherwise return every posting that merely mentions
     the words somewhere in its body. Both are supported and they AND together. */
  title: z.string().trim().max(200).optional(),
  location: z.string().trim().max(200).optional(),
  company: z.string().trim().max(200).optional(),
  remote: z.enum(['true', 'false']).optional(),
  /* Show only postings where visa sponsorship is confirmed. A filter anyone may ask for - the
     public board at /browse-jobs offers it as a checkbox - and one that some accounts get whether
     they ask or not. On GET /jobs the account's own answer is OR-ed with this, never overridden by
     it: somebody who said at onboarding that they need sponsorship cannot turn the filter off by
     omitting a query parameter. See sponsorOnlyBoardRequired in lib/sponsorship.ts. */
  sponsor_only: z.enum(['true', 'false']).optional(),
  /* Drop the account's own PREFERENCE filters for this one request, and nothing else.
   *
   * Onboarding needs a guarantee the board cannot otherwise make: there is always a role to show.
   * A student who has just picked one narrow field, one stage and two titles can legitimately
   * match zero live postings, and an empty match screen is the one outcome that flow cannot
   * survive - it is the payoff every screen before it was spent earning.
   *
   * The line this draws is preference versus constraint, and it is not negotiable in either
   * direction. RELAXED: saved locations, remote_only, role_types, and the desired title terms.
   * Those are things the student asked for, so showing a near miss and saying so is honest.
   * NEVER RELAXED: is_active, the source being enabled, AUTONOMOUS_PORTAL_FAMILIES, the freshness
   * window, and sponsor_only. A posting Litos cannot submit to, or one an applicant is not
   * eligible for, is not a worse match - it is the wrong answer, and widening must not reach it.
   * sponsor_only in particular is OR-ed from the account's own declaration and stays on. */
  relax_targeting: z.enum(['true', 'false']).optional(),
  /* The five product words resolveEmploymentType emits, as an ENUM rather than free text.
     Constrained on purpose: the column also holds pass-through values from employers whose spelling
     the normalizer did not recognise, and letting a caller filter on those would expose one
     employer's vocabulary as though it were a board-wide category. These four are the ones every
     posting is mapped into and the only ones the UI offers.
     Internship is why this parameter exists at all - it was previously renderable on a tile and not
     queryable, so the one category a student most needs to isolate could only be reached by typing
     "intern" into the title box and hoping. */
  employment_type: z
    .enum(['Full-time', 'Part-time', 'Internship', 'Apprenticeship', 'Contract'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(50),
  /* Legacy clients retain numeric offsets. New clients opt into seek pagination with
     `cursor=start`, then pass the opaque next_cursor returned by the route. */
  cursor: z.string().trim().min(1).max(4096).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
}).superRefine((query, ctx) => {
  if (query.cursor !== undefined && query.offset !== 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['offset'],
      message: 'cursor pagination cannot be combined with a nonzero offset',
    });
  }
});
const jobParamsSchema = z.object({ id: z.string().uuid() });

/**
 * THE BOARD MUST NEVER FALL BELOW THIS MANY SURFACED JOBS.
 *
 * A hard product floor, not a target and not a nice-to-have. Below five hundred thousand postings the board
 * stops being a place a job seeker can browse and becomes a list they exhaust in one sitting, so a
 * board that quietly shrinks is a broken product that still returns HTTP 200.
 *
 * RAISED FROM 50,000 to 500,000 on 2026-08-30 (Mehek's call). The floor is intentionally above
 * current supply until source expansion genuinely clears it. Never repair a breach by lowering the
 * number: the 5xx is the alarm doing its job.
 *
 * COUNTED THE WAY A USER SEES IT, which is the only count that means anything: active postings, from
 * enabled sources, on portals Litos can finish autonomously. That last clause is why this constant
 * lives next to the autonomy filter rather than off in a monitoring config - the two constraints
 * pull against each other. Narrowing what Litos may surface (demoting a portal to multi-step, say)
 * directly subtracts from this number, so whoever tightens the first has to answer for the second,
 * and this check is what forces that conversation instead of letting the board silently drain.
 *
 * If this fires, DO NOT fix it by lowering the number. It is a symptom of one of:
 *   - sources failing their polls (check career_page_sources.last_error)
 *   - a portal demoted out of AUTONOMOUS_PORTAL_FAMILIES, taking its boards with it
 *   - the deactivation sweep in pollSource wiping boards (see the empty-response guard there)
 * The fix is more verified sources on application portals that remain autonomous.
 */
export const MINIMUM_SURFACED_JOBS = 500_000;

/** Distinct roles use the public board's exact grouping key: company, title, and ATS family. */
export const MINIMUM_SURFACED_GROUPED_ROLES = 50_000;

/** The sponsor-only view has a separate floor because it is a strict subset of the full board. */
export const MINIMUM_SPONSOR_SURFACED_JOBS = 5_000;

/**
 * THE INTERNSHIP COMMITMENT: 2,000 surfaced internships (Mehek's call, 2026-08-03).
 *
 * NOT YET ENFORCED AS A 5xx, AND THE GAP IS THE REASON. Measured the day it was set (2026-08-03,
 * against the four pollable board APIs of that day): the board surfaced 158 internships and every
 * source we have, probed live at any age, carried 367 in 36,435 postings - 1.0%. Adding the 26
 * densest boards we could find took it to ~240. So 2,000 was roughly 8x the entire supply reachable
 * then, and wiring it to a 500 now would make the daily cron permanently red. That would not surface
 * the shortfall; it
 * would retire the one alarm that currently means "the board is broken NOW", which is exactly the
 * failure MINIMUM_SURFACED_JOBS exists to prevent. Reported on every run instead, so the distance
 * is watched daily rather than asserted once.
 *
 * WHAT WOULD ACTUALLY CLOSE IT, measured, in descending order:
 *   1. Seasonality. Internship supply is not flat. On 2026-08-03 the board's own sources carried
 *      110 internships dated in the trailing week against 23 four weeks earlier. Summer-2027 hiring
 *      opens Aug-Oct, so this number climbs on its own into the autumn - and falls again by spring,
 *      which is the reason a year-round floor is the hard version of this problem.
 *   2. A longer window for internships specifically. An internship req is posted once and stays
 *      open for months; nobody re-saves it, and Greenhouse's date is updated_at, so it ages out of
 *      the old publication-date window while still live. That single mechanism cost 54% - 367 open internships
 *      existed upstream against 170 inside the old publication window. The current verification
 *      model fixes that loss by using successful source observation rather than publication age.
 *   3. More density-sourced boards. Real but slow: 1,501 probed tokens returned 26 usable sources.
 *
 * DO NOT close the gap by loosening what counts as an internship. That was measured too:
 * "University Recruiter", "Campus Recruiter" and "Early Career - Family Medicine Physician" are all
 * live full-time postings that a broader pattern picks up. Inflating this number with full-time
 * roles is worse than missing it, because a student filters to internships precisely to stop
 * reading them.
 */
export const MINIMUM_SURFACED_INTERNSHIPS = 2_000;

/**
 * REQUIRED HEADROOM OVER THE FLOOR.
 *
 * 500,000 is the committed inventory. The warning line is 20 percent above it, giving source decay
 * room before the product breaks its commitment.
 */
export const REQUIRED_HEADROOM_MULTIPLE = 1.2;
export const REQUIRED_SURFACED_JOBS = MINIMUM_SURFACED_JOBS * REQUIRED_HEADROOM_MULTIPLE;
export const REQUIRED_SURFACED_GROUPED_ROLES = 55_000;
/** Early alert boundary, named separately so monitoring consumers do not infer it from health. */
export const GROUPED_ROLE_ALERT_THRESHOLD = REQUIRED_SURFACED_GROUPED_ROLES;

export function groupedRoleAlertTriggered(surfacedGroupedRoles: number): boolean {
  return surfacedGroupedRoles < GROUPED_ROLE_ALERT_THRESHOLD;
}

/**
 * Supply goals measured separately from the hard floor and early warning line.
 *
 * Raised to 625,000 on 2026-08-30, leaving 25 percent operating headroom above the committed floor.
 */
export const TARGET_SURFACED_POSTINGS = 625_000;
export const TARGET_SURFACED_GROUPED_ROLES = 60_000;

export function inventoryTargetMet(surfacedPostings: number, surfacedGroupedRoles: number): boolean {
  return surfacedPostings >= TARGET_SURFACED_POSTINGS
    && surfacedGroupedRoles >= TARGET_SURFACED_GROUPED_ROLES;
}

/** Bound each post-poll metrics statement so the cron still has time to answer and release its lock. */
export const MONITOR_METRICS_STATEMENT_TIMEOUT_MS = 30_000;
export const GROUP_PROJECTION_REFRESH_STATEMENT_TIMEOUT_MS = 120_000;
export const TARGET_ROLE_COVERAGE_STATEMENT_TIMEOUT_MS = 5_000;
export const POLL_SOURCE_LOCK_TIMEOUT_MS = 5_000;
/* One large board may update thousands of rows in chunks. Two minutes leaves room for that bounded
   database work while guaranteeing a stuck statement cannot consume the 15-minute worker request. */
export const POLL_SOURCE_STATEMENT_TIMEOUT_MS = 120_000;
export const POLL_SOURCE_PERSISTENCE_ATTEMPTS = 3;
export const POLL_SOURCE_PERSISTENCE_RETRY_DELAY_MS = 250;
/* Three post-fetch attempts together remain below the original two-minute transaction ceiling, so
   a poison row cannot extend one active poll past the worker's reserved response budget. */
export const POLL_SOURCE_PERSISTENCE_STATEMENT_TIMEOUT_MS = 35_000;
/**
 * Keep post-poll maintenance inside the worker's 15-minute request boundary. The delete is
 * correctness work and fails the request when PostgreSQL cancels it. VACUUM is best-effort, but it
 * still needs a server-side bound so the route cannot retain the shared advisory lock forever.
 */
export const PURGE_POSTINGS_LOCK_TIMEOUT_MS = 5_000;
export const PURGE_POSTINGS_DELETE_TIMEOUT_MS = 60_000;
export const PURGE_POSTINGS_VACUUM_CHECKOUT_TIMEOUT_MS = 5_000;
export const PURGE_POSTINGS_VACUUM_TIMEOUT_MS = 60_000;
/** Variety classification is diagnostic, so keep its Node payload bounded at production scale. */
export const MONITOR_VARIETY_SAMPLE_SIZE = 25_000;

export class JobBoardMetricsTimeoutError extends Error {
  constructor(
    readonly stage: 'group_projection_refresh' | 'variety',
    readonly timeoutMs: number,
  ) {
    super(`Job board ${stage} exceeded its ${timeoutMs}ms statement timeout`);
    this.name = 'JobBoardMetricsTimeoutError';
  }
}

export class JobBoardPurgeTimeoutError extends Error {
  constructor(
    readonly stage: 'purge_checkout' | 'purge_delete' | 'purge_vacuum_checkout',
    readonly timeoutMs: number,
  ) {
    super(`Job board ${stage} exceeded its ${timeoutMs}ms database timeout`);
    this.name = 'JobBoardPurgeTimeoutError';
  }
}

function postgresErrorCode(error: unknown): unknown {
  let current: unknown = error;
  const seen = new Set<object>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && current.code !== undefined) return current.code;
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

function isPostgresStatementTimeout(error: unknown): boolean {
  return postgresErrorCode(error) === '57014';
}

function isPostgresLockTimeout(error: unknown): boolean {
  return postgresErrorCode(error) === '55P03';
}

function isDatabaseConnectionTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message === 'timeout exceeded when trying to connect'
    || error.message === 'Connection terminated due to connection timeout';
}

/**
 * A posting is current when its employer's live ATS has confirmed it recently.
 *
 * Publication age is not a validity signal. Long-running requisitions and internships can stay
 * open for months without being edited, while every supported provider's listing endpoint is a
 * current-openings feed. `last_seen_at` records the stronger fact: Litos fetched the posting from
 * that live feed during a successful source poll. Seven days gives the segmented Railway drain
 * time to cover the full catalog without letting a source that has stopped verifying remain on the
 * product indefinitely.
 */
export const VERIFIED_ACTIVE_WINDOW_DAYS = 7;

/** A full verification window of slack before an unrefreshed row is deleted. */
export const PURGE_UNVERIFIED_POSTINGS_AFTER_DAYS = VERIFIED_ACTIVE_WINDOW_DAYS * 2;

/** Logo proof is refreshed before expiry, with seven days for a transient provider failure. */
export const VERIFIED_LOGO_EVIDENCE_WINDOW_DAYS = 30;
export const VERIFIED_LOGO_RECHECK_DAYS = 23;

/**
 * One helper for every public surface. `/jobs`, `/jobs/grouped`,
 * `/jobs/facets` and `surfacedJobCount()` all call it, and a second copy of this rule is precisely
 * how the floor check ends up watching a number no visitor ever sees. One helper is also why
 * changing the verification window changes the dashboard's job feed by the same amount.
 */
function freshnessPredicate(asOf?: Date) {
  const referenceTime = asOf ? sql`${asOf}::timestamptz` : sql`now()`;
  return sql`${monitored_jobs.last_seen_at} >= ${referenceTime}
    - (${VERIFIED_ACTIVE_WINDOW_DAYS} || ' days')::interval`;
}

/**
 * A posting only exists on the public board when its source carries persisted, audited logo proof.
 *
 * The status alone is deliberately insufficient. A partially applied migration, a bad manual
 * update, or an old row with only a timestamp must not enter the 500,000-job headline. The database
 * check prevents new inconsistent writes and this predicate protects reads while a migration is in
 * flight or against legacy data that predates the constraint.
 */
export function verifiedLogoEvidencePredicate(asOf?: Date) {
  const referenceTime = asOf ? sql`${asOf}::timestamptz` : sql`now()`;
  return and(
    eq(career_page_sources.logo_verification_status, 'verified'),
    isNotNull(career_page_sources.logo_verified_at),
    sql`${career_page_sources.logo_verified_at} >= ${referenceTime}
      - (${VERIFIED_LOGO_EVIDENCE_WINDOW_DAYS} || ' days')::interval`,
    sql`${career_page_sources.logo_verified_at} <= ${referenceTime} + interval '5 minutes'`,
    sql`nullif(btrim(${career_page_sources.logo_verification_method}), '') is not null`,
    inArray(career_page_sources.logo_verification_method, [...VERIFIER_ISSUED_SOURCE_LOGO_METHODS]),
    sql`${career_page_sources.company_logo_url} ~ '^https://[^[:space:]]+$'`,
  )!;
}

/**
 * The source queue must use the same logo-evidence gate as the public inventory. Polling an
 * unverified or expired-logo source cannot make a job visible, but it can still fetch thousands of
 * rows and churn their active state. Keeping this as one predicate also prevents the selection query
 * and the remaining-count query from disagreeing about whether a drain is complete.
 *
 * The FAMILY set is POLLABLE_JOB_BOARDS, deliberately WIDER than the surfacing gate in
 * boardConditions (AUTONOMOUS_PORTAL_FAMILIES). Assisted boards (rippling) are polled and ingested
 * here so their jobs are fresh for the dashboard fill-and-handoff flow, but boardConditions never
 * surfaces them in the autonomous public inventory or the onboarding match. Poll a superset; surface
 * only the autonomous subset.
 */
export function pollingSourceEligibilityPredicate() {
  return and(
    eq(career_page_sources.enabled, true),
    inArray(career_page_sources.ats_name, [...POLLABLE_JOB_BOARDS]),
    eq(career_page_sources.portal_name_mismatch, false),
    sql`nullif(btrim(${career_page_sources.portal_company_name}), '') is not null`,
    verifiedLogoEvidencePredicate(),
  )!;
}

/** Verified proof due for recheck leads each bounded logo-verification batch. */
export function logoVerificationQueueOrder() {
  return [
    sql`case when ${career_page_sources.logo_verification_status} = 'verified' then 0 else 1 end`,
    sql`${career_page_sources.logo_verified_at} asc nulls last`,
    sql`${career_page_sources.logo_last_checked_at} asc nulls first`,
    career_page_sources.created_at,
  ] as const;
}

export type LogoVerificationCandidate = {
  id: string;
  company_name: string;
  ats_name: string;
  board_token: string;
  company_domain: string | null;
  logo_verification_status: string;
  logo_verification_method: string | null;
  logo_verified_at: Date | null;
  logo_last_checked_at: Date | null;
  logo_provider_429_attempts: number;
  logo_verification_error: string | null;
  portal_company_name: string | null;
  portal_name_mismatch: boolean;
};

/**
 * Select one round from every due ATS family before taking a second row from any family.
 *
 * Applying a global LIMIT before provider quotas lets the oldest, largest provider fill the whole
 * scan window. With tens of thousands of sources inserted in provider groups, later families can
 * then wait forever even though the JavaScript limiter is technically respecting its quotas. The
 * window rank moves those quotas into PostgreSQL, where they are applied before the global limit.
 */
export async function selectProviderBalancedLogoVerificationCandidates(
  eligible: SQL,
  requestedLimit: number,
): Promise<LogoVerificationCandidate[]> {
  const queuePriority = sql<number>`case
    when ${career_page_sources.logo_verification_status} = 'verified' then 0
    else 1
  end`.as('queue_priority');
  const providerRank = sql<number>`row_number() over (
    partition by ${career_page_sources.ats_name}
    order by
      case when ${career_page_sources.logo_verification_status} = 'verified' then 0 else 1 end,
      ${career_page_sources.logo_verified_at} asc nulls last,
      ${career_page_sources.logo_last_checked_at} asc nulls first,
      ${career_page_sources.created_at},
      ${career_page_sources.id}
  )`.as('provider_rank');
  const ranked = db.select({
    id: career_page_sources.id,
    company_name: career_page_sources.company_name,
    ats_name: career_page_sources.ats_name,
    board_token: career_page_sources.board_token,
    company_domain: career_page_sources.company_domain,
    logo_verification_status: career_page_sources.logo_verification_status,
    logo_verification_method: career_page_sources.logo_verification_method,
    logo_verified_at: career_page_sources.logo_verified_at,
    logo_last_checked_at: career_page_sources.logo_last_checked_at,
    logo_provider_429_attempts: career_page_sources.logo_provider_429_attempts,
    logo_verification_error: career_page_sources.logo_verification_error,
    portal_company_name: career_page_sources.portal_company_name,
    portal_name_mismatch: career_page_sources.portal_name_mismatch,
    created_at: career_page_sources.created_at,
    queue_priority: queuePriority,
    provider_rank: providerRank,
  })
    .from(career_page_sources)
    .where(eligible)
    .as('ranked_logo_verification_candidates');

  const limit = Math.min(
    LOGO_VERIFICATION_REQUEST_CANDIDATES,
    Math.max(1, Math.trunc(requestedLimit)),
  );
  return db.select({
    id: ranked.id,
    company_name: ranked.company_name,
    ats_name: ranked.ats_name,
    board_token: ranked.board_token,
    company_domain: ranked.company_domain,
    logo_verification_status: ranked.logo_verification_status,
    logo_verification_method: ranked.logo_verification_method,
    logo_verified_at: ranked.logo_verified_at,
    logo_last_checked_at: ranked.logo_last_checked_at,
    logo_provider_429_attempts: ranked.logo_provider_429_attempts,
    logo_verification_error: ranked.logo_verification_error,
    portal_company_name: ranked.portal_company_name,
    portal_name_mismatch: ranked.portal_name_mismatch,
  })
    .from(ranked)
    .where(sql`${ranked.provider_rank} <= case
      when ${ranked.ats_name} = 'workable' then ${LOGO_VERIFICATION_WORKABLE_CANDIDATES}::bigint
      when ${ranked.ats_name} = 'crelate' then ${LOGO_VERIFICATION_CRELATE_CANDIDATES}::bigint
      else ${LOGO_VERIFICATION_PROVIDER_CANDIDATES}::bigint
    end`)
    /* Round robin is intentional. It guarantees every non-empty provider appears before a large
       provider can consume its second slot, while queue_priority preserves verified rechecks at
       the front of each provider's own queue. */
    .orderBy(
      ranked.provider_rank,
      ranked.queue_priority,
      sql`${ranked.logo_verified_at} asc nulls last`,
      sql`${ranked.logo_last_checked_at} asc nulls first`,
      ranked.created_at,
      ranked.id,
    )
    .limit(limit);
}

/**
 * The only supported temporary bypass for the two-phase Railway rollout.
 *
 * The default is fail closed. Operators must spell the explicit value `disabled` while the
 * verifier backfills shadow evidence, then remove it or set any other value after certification.
 */
export function publicVerifiedEvidenceGateEnabled(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return environment.JOB_BOARD_VERIFIED_EVIDENCE_GATE?.trim().toLowerCase() !== 'disabled';
}

/**
 * How long a posting that has left its board is kept before the row is deleted.
 *
 * A posting is REMOVED FROM THE PRODUCT the moment `is_active` goes false - that is what the poll's
 * sweep does, and every board query filters on it, so nothing here affects what a visitor sees. This
 * constant is only about how long the dead row survives in the table.
 *
 * Two days rather than zero, deliberately. `last_seen_at` on a closed row is the only record of when
 * a posting disappeared, and deleting on the same run destroys the evidence for the one question
 * worth asking after a bad poll: did these vanish because the employer closed them, or because a
 * token rotated and a whole board went quiet? Two days is long enough to answer that and short
 * enough that the dead rows never accumulate.
 */
export const CLOSED_POSTING_RETENTION_DAYS = 2;

type PurgeVacuumClient = Pick<PoolClient, 'query' | 'release'>;

/**
 * Keep the best-effort VACUUM from waiting behind a full pool for the rest of the process lifetime.
 * The shared pool has its own longer bound. This shorter route deadline also releases a client that
 * arrives after the caller has moved on, so a driver regression cannot silently shrink the pool.
 */
export async function connectPurgeVacuumClient(
  connect: () => Promise<PurgeVacuumClient> = () => pool.connect(),
  timeoutMs = PURGE_POSTINGS_VACUUM_CHECKOUT_TIMEOUT_MS,
): Promise<PurgeVacuumClient> {
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const checkout = connect().then((client) => {
    if (timedOut) {
      client.release();
      throw new JobBoardPurgeTimeoutError('purge_vacuum_checkout', timeoutMs);
    }
    return client;
  });
  const deadline = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      reject(new JobBoardPurgeTimeoutError('purge_vacuum_checkout', timeoutMs));
    }, timeoutMs);
    timeoutHandle.unref?.();
  });

  try {
    return await Promise.race([checkout, deadline]);
  } finally {
    if (!timedOut) clearTimeout(timeoutHandle!);
  }
}

/**
 * Delete rows that can never be shown again: closed postings past their retention, and anything that
 * aged out of the window before the ingest filter existed.
 *
 * This is the "old listings get pushed off" half of the rolling window. The ingest filter in
 * pollSource stops new stale rows being written; this clears what is already there, including the
 * 12,117 rows that were active-but-invisible before the window was enforced at write time.
 *
 * Runs AFTER the poll, never before: the poll is what marks closed postings inactive in the first
 * place, so purging first would delete a day late and always leave one run's worth behind.
 *
 * Returns the count so the cron can report it, because a purge that silently deletes the wrong thing
 * looks exactly like a purge that works.
 */
export async function purgeExpiredPostings(): Promise<number> {
  let result: Awaited<ReturnType<typeof db.delete>>;
  try {
    result = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(
        `set local lock_timeout = '${PURGE_POSTINGS_LOCK_TIMEOUT_MS}ms'`,
      ));
      await tx.execute(sql.raw(
        `set local statement_timeout = '${PURGE_POSTINGS_DELETE_TIMEOUT_MS}ms'`,
      ));
      return tx.delete(monitored_jobs).where(or(
        // Left its board, and the grace period for diagnosing why has passed.
        and(
          eq(monitored_jobs.is_active, false),
          sql`${monitored_jobs.last_seen_at} < now() - (${CLOSED_POSTING_RETENTION_DAYS} || ' days')::interval`,
        ),
        /* A row no supported ATS has returned for two full verification windows cannot be counted
           as current. This applies equally to internships and every other role because it measures
           the observation, not the employer's publication date. */
        sql`${monitored_jobs.last_seen_at} < now() - (${PURGE_UNVERIFIED_POSTINGS_AFTER_DAYS} || ' days')::interval`,
      ));
    });
  } catch (error) {
    if (isDatabaseConnectionTimeout(error)) {
      throw new JobBoardPurgeTimeoutError(
        'purge_checkout',
        DATABASE_CONNECTION_TIMEOUT_MS,
      );
    }
    if (isPostgresStatementTimeout(error) || isPostgresLockTimeout(error)) {
      throw new JobBoardPurgeTimeoutError(
        'purge_delete',
        isPostgresLockTimeout(error)
          ? PURGE_POSTINGS_LOCK_TIMEOUT_MS
          : PURGE_POSTINGS_DELETE_TIMEOUT_MS,
      );
    }
    throw error;
  }
  const purged = (result as { rowCount?: number }).rowCount ?? 0;

  /* Reclaim after deleting, or the rolling window costs more space than it saves.
   *
   * A DELETE leaves dead tuples; it does not free anything. Measured on the first real purge run:
   * 8,702 rows deleted and the database went UP, 158 MB -> 194 MB, because the churn is now daily
   * and outpaces autovacuum's own schedule. A VACUUM FULL afterwards took it to 73 MB.
   *
   * Plain VACUUM here, NOT VACUUM FULL. Full takes an ACCESS EXCLUSIVE lock and rewrites the table,
   * which would make the board unavailable in the middle of a cron run; plain VACUUM takes no such
   * lock and returns the space for reuse by the next day's inserts, which is exactly what a bounded,
   * high-churn table needs. Space is not returned to the OS - run VACUUM FULL by hand if the file
   * size itself ever matters - but the table stops growing, which is the actual requirement.
   *
   * Best-effort: a failed vacuum must never fail the poll. The postings are already correct at this
   * point; this is housekeeping. */
  try {
    const client = await connectPurgeVacuumClient();
    let operationError: unknown;
    try {
      await client.query(
        "select set_config('lock_timeout', $1, false), set_config('statement_timeout', $2, false)",
        [`${PURGE_POSTINGS_LOCK_TIMEOUT_MS}ms`, `${PURGE_POSTINGS_VACUUM_TIMEOUT_MS}ms`],
      );
      await client.query('vacuum monitored_jobs');
    } catch (error) {
      operationError = error;
      throw error;
    } finally {
      let resetError: Error | undefined;
      try {
        await client.query('reset lock_timeout');
        await client.query('reset statement_timeout');
      } catch (error) {
        resetError = error instanceof Error ? error : new Error(String(error));
      }
      client.release(resetError);
      if (!operationError && resetError) throw resetError;
    }
  } catch {
    // Intentionally swallowed. See above: the board is correct with or without this.
  }

  return purged;
}

/** The floor rule as a predicate, so the number and the comparison are testable without a database. */
export function boardIsBelowFloor(surfacedJobs: number): boolean {
  return surfacedJobs < MINIMUM_SURFACED_JOBS;
}

/**
 * Whether a poll that came back empty should leave the existing postings alone.
 *
 * Extracted and exported for the same reason rankByFit is: it is the decision, and it is worth
 * pinning down without standing up a database. See the long note in pollSource for the reasoning -
 * in short, an empty board response is far more often a rotated token than a company closing every
 * role at once, and the deactivation it would otherwise trigger is what takes the board under
 * MINIMUM_SURFACED_JOBS in a single cron run.
 */
export function shouldKeepPostingsOnEmptyFetch(fetchedCount: number, activeNow: number): boolean {
  return fetchedCount === 0 && activeNow > 0;
}

/**
 * Whether a non-empty list whose postings ALL failed normalization should leave existing rows alone.
 *
 * The complement of shouldKeepPostingsOnEmptyFetch, born from the same wipe reached through a
 * different door: on 2026-08-30 Greenhouse began decorating every absolute_url with `?gh_jid=`, the
 * strict action-URL validator rejected all 2,239 SpaceX postings, and the poll then reported a
 * CLEAN SUCCESS while sweeping the whole board inactive - last_polled_at advanced, last_error
 * stayed null, and the failure was invisible until someone read monitored_jobs by hand. A board
 * that lists postings but normalizes none of them is validator/provider drift, not a company
 * closing every role between two polls, so it is recorded as an error and the rows stay up.
 *
 * Deliberately blind to the ingest-quality gate: Disney's two-placeholder board NORMALIZES fine and
 * must keep deactivating. Only a fetch where normalization itself produced nothing is a fault.
 */
export function shouldKeepPostingsOnFullyRejectedFetch(
  listedCount: number,
  normalizedCount: number,
  activeNow: number,
): boolean {
  return listedCount > 0 && normalizedCount === 0 && activeNow > 0;
}

/* The rejection-spike thresholds, exported so the test pins the numbers rather than inferring them.
 *
 * A DELTA against the previous completed poll, never a fixed rejected-fraction: employer-hosted
 * absolute_url boards (Stripe's and Databricks's shapes) are host-rejected at a steady rate BY
 * DESIGN, so "40% rejected" is a healthy Tuesday on one board and a five-alarm drift on another.
 * The only shape that is always a fault is the rate MOVING - the mixed-CDN version of the SpaceX
 * wipe, where a new query param rolls through some caches first and 2,238 of 2,239 URLs fail while
 * 1 survives, which slips past the fully-rejected guard and sweeps the board on a clean success.
 *
 * Both floors exist so churn cannot page: the absolute floor keeps small boards' organic posting
 * turnover quiet, and the listed-fraction floor keeps a large board's ordinary drift (a few dozen
 * postings closing between polls) below the line. A real format drift clears both at once. */
export const REJECTION_SPIKE_MIN_DELTA = 25;
export const REJECTION_SPIKE_LISTED_FRACTION = 0.2;

/** The one clamp, shared, so the number the alert prints is the number the predicate judged. */
export function rejectedFromCounts(listedCount: number, normalizedCount: number): number {
  return Math.max(0, listedCount - normalizedCount);
}

/**
 * Whether this poll's rejection count (listed minus normalized) jumped against the stored baseline.
 *
 * The baseline is scaled to the CURRENT list size before comparing, because what is steady about a
 * by-design host-rejected board is its rejection RATE, not its count: a board growing tenfold at an
 * unchanged 40% rejection rate has ten times the rejections and none of the drift this predicate
 * hunts. Judging raw counts across different list sizes would page on that growth.
 *
 * NULL (or empty, see below) baseline - a source that has never completed a listing poll since the
 * counts began persisting - never alerts: there is nothing to have jumped FROM, and the first
 * completed poll writes the baseline the next one is judged against. A zero previous list carries
 * no rate at all, which is also why pollSource never stores one. The fully-rejected case never
 * reaches this predicate; shouldKeepPostingsOnFullyRejectedFetch already refuses to let that poll
 * complete at all.
 */
export function rejectionSpikeExceedsBaseline(
  previousListedCount: number | null,
  previousNormalizedCount: number | null,
  listedCount: number,
  normalizedCount: number,
): boolean {
  if (!previousListedCount || previousNormalizedCount === null) return false;
  const expectedRejections = Math.round(
    (rejectedFromCounts(previousListedCount, previousNormalizedCount) / previousListedCount)
      * listedCount,
  );
  const rejected = listedCount - normalizedCount;
  return rejected - expectedRejections
    >= Math.max(REJECTION_SPIKE_MIN_DELTA, Math.ceil(listedCount * REJECTION_SPIKE_LISTED_FRACTION));
}

const DETAIL_CURSOR_PATTERN = /(?:^|\s)next_detail_cursor=(\d+)(?:\s|$)/;
const DETAIL_CURSOR_KEY_PATTERN = /(?:^|\s)next_detail_cursor_key=([A-Za-z0-9_-]{1,1024})(?:\s|$)/;

/** Resume a bounded multi-request provider pass without adding a schema-only cursor column. */
export function detailCursorFromLastError(lastError: string | null | undefined): number {
  const match = lastError?.match(DETAIL_CURSOR_PATTERN);
  if (!match) return 0;
  const cursor = Number(match[1]);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

/** Decode the opaque keyset marker without writing raw provider identifiers into diagnostics. */
export function detailCursorKeyFromLastError(lastError: string | null | undefined): string | undefined {
  const match = lastError?.match(DETAIL_CURSOR_KEY_PATTERN);
  if (!match) return undefined;
  try {
    const key = Buffer.from(match[1], 'base64url').toString('utf8');
    return key && Buffer.byteLength(key, 'utf8') <= 512 ? key : undefined;
  } catch {
    return undefined;
  }
}

function detailCursorKeyMarker(key: string | null | undefined): string | null {
  if (!key || Buffer.byteLength(key, 'utf8') > 512) return null;
  return `next_detail_cursor_key=${Buffer.from(key, 'utf8').toString('base64url')}`;
}

/** Persist cursor progress in the source's existing diagnostic field until one cycle completes. */
export function detailRefreshStatus(progress: DetailFetchProgress | undefined): string | null {
  if (!progress || (progress.cycle_complete && progress.failed === 0)) return null;
  const keyMarker = detailCursorKeyMarker(progress.next_cursor_key);
  return [
    'Job detail refresh partial:',
    `${progress.succeeded}/${progress.attempted} attempted details succeeded;`,
    `${progress.remaining_in_cycle} remain in this cycle;`,
    `next_detail_cursor=${progress.next_cursor}`,
    ...(keyMarker ? [keyMarker] : []),
  ].join(' ');
}

/** A partial detail window remains in the active drain until its cursor reaches the list end. */
export function completedPollFields(
  progress: DetailFetchProgress | undefined,
  completedAt: Date,
): { last_polled_at?: Date; last_successful_poll_at?: Date } {
  return progress && !progress.cycle_complete
    ? {}
    : { last_polled_at: completedAt, last_successful_poll_at: completedAt };
}

/**
 * How many jobs the board would show right now, under exactly the filters GET /jobs applies.
 *
 * Deliberately re-derived from the same three predicates rather than counting monitored_jobs: a
 * count that includes rows the board filters out would report a healthy number while the board
 * itself was empty, which is the precise failure this whole check exists to catch.
 */
export async function surfacedJobCount(sponsorOnly = false): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    // boardConditions(), not a hand-copied predicate list. This number is only meaningful if it
    // counts exactly what GET /jobs returns, and the freshness window is precisely the kind of
    // filter that gets added to the route and forgotten here: the count would have read ~22,000
    // while the board showed ~9,700, and the floor check would have been watching a number no
    // visitor ever sees.
    .where(and(...boardConditions({ sponsorOnly, requireVerifiedEvidence: true })));
  return row?.total ?? 0;
}

/**
 * How many distinct roles the public board would show under its exact grouping definition.
 *
 * A role is one case-sensitive employer title on one ATS family. This matches GET /jobs/grouped,
 * including the ATS field in the key, so the cron, pagination total, and website headline cannot
 * silently count different things.
 */
export async function surfacedGroupedRoleCount(sponsorOnly = false): Promise<number> {
  const result = await db.execute<{ total: number }>(sql`
    select count(*)::int as total from (
      select 1 from ${monitored_jobs}
      inner join ${career_page_sources}
        on ${monitored_jobs.source_id} = ${career_page_sources.id}
      where ${and(...boardConditions({ sponsorOnly, requireVerifiedEvidence: true }))}
      group by ${monitored_jobs.company_name}, ${monitored_jobs.title}, ${career_page_sources.ats_name}
    ) grouped_roles
  `);
  return Number(result.rows[0]?.total ?? 0);
}

/** All cron inventory totals from one joined snapshot and one database round trip. */
type JobMonitorQueryExecutor = Pick<typeof db, 'execute' | 'select'>;

export async function boardInventoryMetrics(
  executor: JobMonitorQueryExecutor = db,
  certifiedSince?: Date,
) {
  const fullBoard = and(...boardConditions({ sponsorOnly: false, requireVerifiedEvidence: true }));
  const sponsorBoard = and(...boardConditions({ sponsorOnly: true, requireVerifiedEvidence: true }));
  const currentFingerprint = sql`${monitored_jobs.certification_fingerprint}
    ~ '^v1:[0-9a-f]{64}:[0-9a-f]{64}$'`;
  /* Public browsing tolerates a short provider outage until last_seen_at ages out. Certification
     is stricter: the source must have completed a successful first-party list read and the exact
     job detail must have been ingested in this drain. A completed paginated list cycle can still
     contain failed or deferred detail requests, so source-level proof alone is insufficient. */
  const currentPollProof = certifiedSince
    ? and(
      gte(career_page_sources.last_successful_poll_at, certifiedSince),
      gte(monitored_jobs.last_seen_at, certifiedSince),
    )
    : and(
      isNotNull(career_page_sources.last_successful_poll_at),
      isNotNull(monitored_jobs.last_seen_at),
    );
  const certifiedBoard = and(fullBoard, currentFingerprint, currentPollProof);
  const certifiedSponsorBoard = and(sponsorBoard, currentFingerprint, currentPollProof);
  const result = await executor.execute<{
    surfaced_postings: number;
    surfaced_grouped_roles: number;
    surfaced_sponsor_only_jobs: number;
    surfaced_internships: number;
    certified_unique_jobs: number;
    certified_unique_grouped_roles: number;
    certified_unique_sponsor_jobs: number;
    certified_unique_internships: number;
  }>(sql`
    select
      count(*) filter (where ${fullBoard})::int as surfaced_postings,
      count(distinct (
        ${monitored_jobs.company_name},
        ${monitored_jobs.title},
        ${career_page_sources.ats_name}
      )) filter (where ${fullBoard})::int as surfaced_grouped_roles,
      count(*) filter (where ${sponsorBoard})::int as surfaced_sponsor_only_jobs,
      count(*) filter (
        where ${fullBoard} and ${monitored_jobs.employment_type} = 'Internship'
      )::int as surfaced_internships,
      count(distinct ${monitored_jobs.certification_fingerprint})
        filter (where ${certifiedBoard})::int as certified_unique_jobs,
      count(distinct split_part(${monitored_jobs.certification_fingerprint}, ':', 2))
        filter (where ${certifiedBoard})::int as certified_unique_grouped_roles,
      count(distinct ${monitored_jobs.certification_fingerprint})
        filter (where ${certifiedSponsorBoard})::int as certified_unique_sponsor_jobs,
      count(distinct ${monitored_jobs.certification_fingerprint}) filter (
        where ${certifiedBoard} and ${monitored_jobs.employment_type} = 'Internship'
      )::int as certified_unique_internships
    from ${monitored_jobs}
    inner join ${career_page_sources}
      on ${monitored_jobs.source_id} = ${career_page_sources.id}
  `);
  const row = result.rows[0];
  return {
    surfacedPostings: Number(row?.surfaced_postings ?? 0),
    surfacedGroupedRoles: Number(row?.surfaced_grouped_roles ?? 0),
    surfacedSponsorOnly: Number(row?.surfaced_sponsor_only_jobs ?? 0),
    surfacedInternships: Number(row?.surfaced_internships ?? 0),
    certifiedUniqueJobs: Number(row?.certified_unique_jobs ?? 0),
    certifiedUniqueGroupedRoles: Number(row?.certified_unique_grouped_roles ?? 0),
    certifiedUniqueSponsorJobs: Number(row?.certified_unique_sponsor_jobs ?? 0),
    certifiedUniqueInternships: Number(row?.certified_unique_internships ?? 0),
  };
}

/** The mix behind the headline count, computed under the exact public-board predicates. */
async function boardVarietyRows(executor: JobMonitorQueryExecutor = db) {
  return executor
    .select({
      company_name: monitored_jobs.company_name,
      title: monitored_jobs.title,
      department: monitored_jobs.department,
      employment_type: monitored_jobs.employment_type,
      remote: monitored_jobs.remote,
      job_country: monitored_jobs.job_country,
      ats_name: career_page_sources.ats_name,
    })
    .from(monitored_jobs)
    .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
    .where(and(...boardConditions({ sponsorOnly: false, requireVerifiedEvidence: true })))
    .limit(MONITOR_VARIETY_SAMPLE_SIZE);
}

export async function boardVarietyMetrics(executor: JobMonitorQueryExecutor = db) {
  return summarizeJobVariety(await boardVarietyRows(executor));
}

/** Zero-result monitoring for the literal target roles users entered during onboarding. */
export async function targetRoleCoverageMetrics(executor: JobMonitorQueryExecutor = db) {
  if (MINIMUM_MATCHES_PER_TARGET_ROLE !== 1) {
    throw new Error('The early-exit target-role coverage query currently supports a one-match threshold.');
  }
  const result = await executor.execute<{
    distinct_target_roles: number;
    covered_target_roles: number;
  }>(sql`
    with target_roles as (
      select distinct lower(regexp_replace(trim(item.value #>> '{}'), '\\s+', ' ', 'g')) as role
      from ${targeting}
      cross join lateral jsonb_array_elements(
        case
          when jsonb_typeof(${targeting.titles}) = 'array' then ${targeting.titles}
          else '[]'::jsonb
        end
      ) as item(value)
      where jsonb_typeof(item.value) = 'string'
        and trim(item.value #>> '{}') <> ''
    ), board_titles as (
      select distinct lower(regexp_replace(trim(${monitored_jobs.title}), '\\s+', ' ', 'g')) as title
      from ${monitored_jobs}
      inner join ${career_page_sources}
        on ${monitored_jobs.source_id} = ${career_page_sources.id}
      where ${and(...boardConditions({ sponsorOnly: false, requireVerifiedEvidence: true }))}
    )
    select
      count(*)::int as distinct_target_roles,
      count(*) filter (where exists (
        select 1
        from board_titles
        where strpos(board_titles.title, target_roles.role) > 0
      ))::int as covered_target_roles
    from target_roles
  `);
  const row = result.rows[0];
  return targetRoleCoverageFromCounts(
    Number(row?.distinct_target_roles ?? 0),
    Number(row?.covered_target_roles ?? 0),
  );
}

/** A connection-bound, time-limited snapshot for inventory and variety metrics. */
export async function boardMonitoringSnapshot(certifiedSince: Date) {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(
      `set local statement_timeout = '${GROUP_PROJECTION_REFRESH_STATEMENT_TIMEOUT_MS}ms'`,
    ));
    try {
      await tx.execute(sql`select refresh_job_board_group_projection(${certifiedSince})`);
    } catch (error) {
      if (isPostgresStatementTimeout(error)) {
        throw new JobBoardMetricsTimeoutError(
          'group_projection_refresh',
          GROUP_PROJECTION_REFRESH_STATEMENT_TIMEOUT_MS,
        );
      }
      throw error;
    }
    const [projection] = await tx
      .select()
      .from(job_board_group_projection_state)
      .where(eq(job_board_group_projection_state.singleton, true))
      .limit(1);
    if (!projection) throw new Error('Job board group projection refresh returned no state row');
    await tx.execute(sql.raw(
      `set local statement_timeout = '${MONITOR_METRICS_STATEMENT_TIMEOUT_MS}ms'`,
    ));
    const inventory = {
      surfacedPostings: projection.surfaced_postings,
      surfacedGroupedRoles: projection.surfaced_grouped_roles,
      surfacedSponsorOnly: projection.surfaced_sponsor_only_jobs,
      surfacedInternships: projection.surfaced_internships,
      certifiedUniqueJobs: projection.certified_unique_jobs,
      certifiedUniqueGroupedRoles: projection.certified_unique_grouped_roles,
      certifiedUniqueSponsorJobs: projection.certified_unique_sponsor_jobs,
      certifiedUniqueInternships: projection.certified_unique_internships,
    };
    let varietyRows: Awaited<ReturnType<typeof boardVarietyRows>>;
    try {
      varietyRows = await boardVarietyRows(tx);
    } catch (error) {
      if (isPostgresStatementTimeout(error)) {
        throw new JobBoardMetricsTimeoutError('variety', MONITOR_METRICS_STATEMENT_TIMEOUT_MS);
      }
      throw error;
    }
    const variety = summarizeJobVariety(varietyRows);
    return {
      inventory,
      projection: {
        generation: projection.generation,
        asOf: projection.projection_as_of,
        refreshedAt: projection.refreshed_at,
      },
      variety,
      varietySample: {
        rows: varietyRows.length,
        limit: MONITOR_VARIETY_SAMPLE_SIZE,
        sampled: inventory.surfacedPostings > varietyRows.length,
      },
    };
  }, { isolationLevel: 'repeatable read' });
}

/** Bound user-target coverage separately so it cannot extend the inventory snapshot transaction. */
export async function targetRoleCoverageMonitoringSnapshot() {
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql.raw(
        `set local statement_timeout = '${TARGET_ROLE_COVERAGE_STATEMENT_TIMEOUT_MS}ms'`,
      ));
      return targetRoleCoverageMetrics(tx);
    });
  } catch {
    return unavailableTargetRoleCoverage();
  }
}

/**
 * Whether the board still has the headroom the product needs, and if not, how it is failing.
 *
 * Two levels rather than one, because they mean different things. 'low' is "someone should look at
 * the sources this week"; 'breached' is "the board is not a browsable product right now". Alarming
 * only at the floor would mean the first warning arrives when it is already unusable.
 */
export function boardHealth(
  surfacedPostings: number,
  surfacedGroupedRoles: number,
): 'ok' | 'low' | 'breached' {
  if (
    boardIsBelowFloor(surfacedPostings)
    || surfacedGroupedRoles < MINIMUM_SURFACED_GROUPED_ROLES
  ) return 'breached';
  if (
    surfacedPostings < REQUIRED_SURFACED_JOBS
    || surfacedGroupedRoles < REQUIRED_SURFACED_GROUPED_ROLES
  ) return 'low';
  return 'ok';
}

export function pollingQueueStatus(remainingSources: number) {
  const deferredSources = Math.max(0, remainingSources);
  return {
    deferredSources,
    pollingComplete: deferredSources === 0,
  };
}

/**
 * How many postings get scored and ranked on a request.
 *
 * Sorting by fit cannot be expressed in the query, because the score is computed in this process,
 * so the sort has to happen over a set this route holds in memory: the newest RANKING_POOL
 * postings that match the filters.
 *
 * THE NUMBER IS A BUDGET, AND THE BUDGET IS EVENT-LOOP TIME. Measured on this engine (Node 22,
 * warm, a ~2KB resume against SCORING_CHARS-capped postings): 0.3-0.5 ms per posting on synthetic
 * text, and up to ~1.3 ms on term-dense real postings. That cost is SYNCHRONOUS — Fastify serves
 * nothing else while it runs. An earlier version of this comment called the pass "the low tens of
 * milliseconds" and the per-call cost "well under a millisecond"; both were asserted rather than
 * measured, and the numbers above replaced them (2026-07-28).
 *
 * 300 is affordable BECAUSE OF THE CACHE, and would not be without it. The ranking is now computed
 * once per (student, resume, filters) and every page is a slice of it, so this cost is paid once
 * per list rather than once per page — which is what makes a pool three times larger cheaper in
 * practice than the old 200 was. Roughly 100-400 ms on a miss, and nothing on a hit.
 *
 * The cap is still real, and is why the response carries `ranked_pool` and `pool_exhausted`: past
 * RANKING_POOL matching postings, the next-newest is not considered for ranking however well it
 * fits. Filters are how a student narrows the pool, and the list has to SAY it stopped ranking
 * rather than quietly reporting no more results.
 *
 * 300 TO 150 (2026-08-04), AND THE BUDGET IS NO LONGER EVENT-LOOP TIME. Everything above was
 * reasoned about CPU, which the cache made affordable. The binding constraint turned out to be a
 * different one: this number also multiplies the phase 2 query, which reads capped description text
 * for every pooled row, and that read exhausted Neon's 5 GB/month free-tier transfer and suspended
 * the compute. Bytes off Neon, not milliseconds on the event loop, is what 150 is buying back.
 *
 * 150 still comfortably exceeds what anyone pages through: RANKED_PAGE_WINDOW is 24, so this is six
 * full pages of ranked results. `pool_exhausted` already exists to tell the truth at the boundary,
 * so the honest failure mode of a smaller pool was built long before it was needed.
 */
export const RANKING_POOL = 150;

/**
 * How much of a posting gets scored.
 *
 * `monitored_jobs.description` is an unbounded `text` column holding whatever the board returned,
 * and the poller stores it verbatim. Without a cap, ranking pulled the FULL description for every
 * row in the pool: at the 5-50KB postings that are ordinary, that is megabytes of detoasted text
 * fetched, shipped from Neon, and held as JS strings in a serverless function on every keystroke
 * of a debounced search.
 *
 * 20k characters is well past where a posting states its requirements (the whole reason this
 * scores the full column instead of the 600-char preview) and it bounds both the transfer and the
 * scoring pass. POST /jd-match already caps its input at 60k for the same reason.
 *
 * 20k TO 6k (2026-08-04). "Well past" was the problem. The cap was set to a number that could not
 * plausibly cut anything off, which meant it was not really bounding the transfer at all: at
 * RANKING_POOL rows this query was the single largest reader of bytes out of Neon in the whole
 * backend, and it exhausted the free tier's monthly transfer allowance and suspended the compute.
 *
 * WHY 6k AND NOT LOWER. Requirements sit after a preamble, and how long that preamble runs is the
 * employer's choice, not something this codebase controls. 4k was considered and rejected: the
 * database was suspended when this was written, so there was no way to measure where requirements
 * actually begin across the real corpus, and picking a boundary that tight on an unmeasured
 * distribution trades a cost problem for a silent ranking-quality one. 6k is a 3.3x cut that keeps
 * a wide margin over any posting inspected by hand.
 *
 * This cap is a stopgap and should stay one. Reading a PREFIX of raw employer HTML-derived text is
 * a crude way to find requirements at any length: it reads too much, and it reads the wrong part,
 * and those two pull against each other so no value of this constant is right.
 *
 * `description_digest`, added in this change, is the real fix: built once at poll time, so this cap
 * no longer governs the normal path and only covers the fallback for rows polled before the column
 * existed. Lower it further only against a measurement, never a guess.
 */
export const SCORING_CHARS = 6_000;

/**
 * How many candidate rows are read before the pool is chosen from them.
 *
 * Only id and company_name are read at this stage — no descriptions — so this is a cheap two-column
 * scan even at a few thousand rows. It exists so the pool can be chosen from a wide enough slice of
 * the board for `PER_COMPANY_CAP` to actually have something to spread across.
 */
const CANDIDATE_SCAN = 3_000;

/**
 * How many postings any ONE employer may contribute to the ranking pool.
 *
 * WHY THIS EXISTS, measured against production 2026-07-28. The pool was the newest RANKING_POOL
 * postings, full stop. On the real board that is not a sample of the market, it is a sample of
 * whoever posted most recently: of 300 pooled rows, 166 were Datadog and 35 companies appeared out
 * of the 53 sources being polled. The top ten "Top matches for you" were ten Datadog jobs.
 *
 * The ranking was working perfectly and the feature was still useless, because a student looking
 * for the best-fitting job in a 7,115-posting board was being shown the best-fitting job at one
 * company. No unit test could have caught it; it only shows up against real data.
 *
 * 3 is RANKING_POOL / 50, so the pool spreads across roughly fifty employers before the cap starts
 * binding, while still letting a genuinely large employer contribute a handful of roles. A student
 * who wants more from one company can search for it, which is what the company filter is for.
 *
 * IT IS A RATIO, NOT A CONSTANT, which is why it moved from 6 to 3 when RANKING_POOL halved
 * (2026-08-04). Fifty employers is the property worth holding; 6 was only ever the number that
 * produced it at a pool of 300. Leaving it at 6 while halving the pool would have quietly cut the
 * spread to twenty-five employers, which is most of the way back to the Datadog board this cap was
 * written to prevent, and no test above would have failed.
 */
export const PER_COMPANY_CAP = 3;

/* Two or three, Mehek's rule, and three is the generous end of it. Measured against a 24-row page:
   three of anything is noticeable, four reads as a takeover. RANKED_PAGE_WINDOW is the page size the
   dashboard actually asks for; the cap is meaningless without knowing the window it applies to. */
const PER_PAGE_COMPANY_CAP = 3;
const RANKED_PAGE_WINDOW = 24;

/** The minimum a row needs to be rankable. Kept structural so the sort can be tested without a DB. */
export type RankableJob = {
  company_name: string;
  title: string;
  location?: string | null;
  employment_type?: string | null;
  remote?: boolean | null;
  /** The posting text to score. Capped at SCORING_CHARS by the query, not the full column. */
  scored_description: string | null;
};

/**
 * Postings ordered best fit first, carrying the score that put them there.
 *
 * Exported for its own tests. The three behaviours worth pinning down, and each is a decision
 * rather than an accident:
 *
 *  - Unscorable postings (jdMatch returned null) sort BELOW every scored one, and hold their
 *    incoming order among themselves. They are not zeros; a zero would rank a posting we declined
 *    to judge alongside one we judged and found nothing in.
 *  - Equal scores keep the incoming order, which the caller has already set to newest first. Two
 *    88% matches are separated by recency, which is the only other fact we have.
 *  - The sort is stable by construction (the index tiebreak), not by trusting the engine's sort to
 *    be. Array#sort stability is specified now, but the comparator saying so is what makes the
 *    intent survive someone swapping the sort.
 */
/**
 * The pool, chosen so it spans employers instead of echoing one.
 *
 * Walks the candidates in the order the query returned them (title matches first when there is a
 * search, then newest) and takes each one unless its employer has already contributed `perCompany`.
 * The result therefore keeps the incoming priority — the newest and most relevant postings still
 * come first — while no single employer can crowd out the rest of the board.
 *
 * Two deliberate properties:
 *
 *  - IT NEVER RETURNS FEWER THAN IT COULD. If capping leaves the pool short of `poolSize` (a board
 *    with only a handful of employers, or a narrow search), a second pass takes the skipped rows,
 *    still in their original order. A student searching for one company must still get that
 *    company's jobs; the cap is there to stop an employer dominating a BROWSE, not to withhold
 *    results from a search that asked for it.
 *  - ONE MORE THAN ASKED FOR, when available, so the caller can tell "the pool ends here" apart
 *    from "the board ends here" exactly as it could before.
 */
export function pickDiversePool<T extends { company_name: string }>(
  candidates: readonly T[],
  perCompany: number,
  poolSize: number,
): T[] {
  const taken: T[] = [];
  const skipped: T[] = [];
  const seen = new Map<string, number>();
  // One past poolSize: the caller reads the overflow as "there was more we did not rank".
  const want = poolSize + 1;

  for (const row of candidates) {
    if (taken.length >= want) break;
    const key = row.company_name.trim().toLowerCase();
    const count = seen.get(key) ?? 0;
    if (count >= perCompany) {
      skipped.push(row);
      continue;
    }
    seen.set(key, count + 1);
    taken.push(row);
  }

  // Backfill in original order, so a thin board still fills the page.
  for (const row of skipped) {
    if (taken.length >= want) break;
    taken.push(row);
  }
  return taken;
}

/**
 * The in-memory half of the one-employer-must-not-own-the-page rule, for the ranked list.
 *
 * The board can scatter in SQL because its order is recency. The dashboard's order is FIT, and a
 * round-robin there would be actively wrong: it would put a 40% match from a rare employer above a
 * 95% match, which is the opposite of what "Top matches for you" promises. So this keeps fit order
 * and only defers the rows that would break the cap, pulling them back in as soon as the next page
 * begins.
 *
 * Applied once, to the ranking that gets cached, so every page is a slice of one decided list —
 * exactly the property the ranking cache exists to hold. Re-sorting each page instead would let a
 * posting appear on two pages or none.
 *
 * A deferred row is never dropped. If a whole page could only be filled by breaking the cap, the
 * cap gives way rather than the page coming up short: a short page is a worse lie than a repeated
 * employer.
 */
export function scatterRanked<T extends { company_name: string }>(
  rows: readonly T[],
  perPage: number,
  pageSize: number,
): T[] {
  const pending = [...rows];
  const out: T[] = [];

  while (pending.length) {
    const windowStart = Math.floor(out.length / pageSize) * pageSize;
    const counts = new Map<string, number>();
    for (let i = windowStart; i < out.length; i += 1) {
      const key = out[i].company_name.trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let index = pending.findIndex(
      (row) => (counts.get(row.company_name.trim().toLowerCase()) ?? 0) < perPage,
    );
    // Nothing left that fits the cap: take the best remaining rather than leave the page short.
    if (index === -1) index = 0;
    out.push(pending[index]);
    pending.splice(index, 1);
  }
  return out;
}

export function rankByFit<T extends RankableJob>(
  rows: readonly T[],
  resumeText: string,
  targetingPreferences: JobTargeting = normalizeTargeting(null),
): Array<{ row: T; score: number | null; required_coverage: number | null }> {
  const scored = rows.map((row, index) => {
    // The posting never asks for experience with its own company, job title or offices, so all
    // three are excluded from the requirement set. Same context the review screen passes.
    const jdMatch = resumeText.trim()
      ? scoreJdMatch(resumeText, row.scored_description ?? '', {
          company: row.company_name,
          role: row.title,
          location: row.location,
        })
      : null;
    return {
      row,
      score: jdMatch?.score ?? null,
      /* Kept alongside score, not discarded the way it used to be: scoreBand()'s own gate needs
         it to tell "high score, but missing the hard requirements" from an actually strong match,
         and every caller of rankByFit that wants a band-accurate verdict needs the same input the
         board's own /jobs/:id route already passes it. */
      required_coverage: jdMatch?.required_coverage ?? null,
      preferenceScore: preferenceFit(row, targetingPreferences).score,
      index,
    };
  });
  scored.sort((a, b) => {
    if (a.score === null && b.score === null) return b.preferenceScore - a.preferenceScore || a.index - b.index;
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    if (a.score !== b.score) return b.score - a.score;
    return b.preferenceScore - a.preferenceScore || a.index - b.index;
  });
  return scored.map(({ row, score, required_coverage }) => ({ row, score, required_coverage }));
}

export const MIN_RANKED_MATCH_SCORE = 25;

export function rankedMatchEligible(score: number | null | undefined, hasResumeScore: boolean): boolean {
  if (!hasResumeScore) return true;
  return score !== null && score !== undefined && score >= MIN_RANKED_MATCH_SCORE;
}

/**
 * The student's main resume as plain text, or null if there is nothing to rank against.
 *
 * Null covers three different situations on purpose — signed out, signed in with no resume yet, and
 * signed in with a resume that holds no text — because the list behaves identically in all three:
 * unranked, unscored, newest first. Returning a 404 here (as POST /jd-match does) would be wrong;
 * that route exists to answer a question about one posting, while this one has a perfectly good
 * answer without a resume.
 */
/**
 * Does this account's board only show employers who sponsor?
 *
 * Signed out, the answer is always no - there is no account to have declared anything - and the
 * caller falls back to the query parameter, which is how the public board's checkbox works.
 *
 * The read is two columns and it happens on every /jobs request. That is deliberate rather than
 * cached: this is the one filter where serving a stale `false` puts someone in front of jobs they
 * cannot take, and the row is already the cheapest kind of lookup this route makes.
 */
export async function accountRequiresSponsor(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({
      declared: users.sponsorship_required_at_onboarding,
      setting: users.sponsor_only_jobs_enabled,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return false;
  return sponsorOnlyBoardRequired({ declaredAtOnboarding: row.declared, settingEnabled: row.setting });
}

/* Whether this account has finished onboarding. The dashboard-only assisted board is gated on this:
 * a guest (no userId) or a signed-in account still in setup is, by definition, in the onboarding
 * flow, which must only ever show fully autonomous jobs. Server-enforced, never a client flag, so
 * "onboarding is autonomous-only" cannot be turned off from the browser. */
export async function accountOnboardingComplete(userId: string | undefined): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({ completedAt: users.onboarding_completed_at })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return Boolean(row?.completedAt);
}

export async function accountJobTargeting(userId: string | undefined): Promise<JobTargeting> {
  if (!userId) return normalizeTargeting(null);
  const [row] = await db.select().from(targeting).where(eq(targeting.user_id, userId)).limit(1);
  return normalizeTargeting(row as unknown as Record<string, unknown> | undefined);
}

/** Which country-scoped evidence, if any, lets this row be shown to someone who needs sponsorship. */
function evidenceFor(row: {
  sponsorship_status: string | null;
  sponsorship_scope?: string | null;
  employer_sponsors: boolean | null;
  job_country?: string | null;
  portal_name_mismatch?: boolean | null;
}) {
  return sponsorshipVerdict({
    posting: (row.sponsorship_status ?? 'unstated') as PostingSponsorship,
    postingScope: (row.sponsorship_scope ?? null) as PostingSponsorshipScope | null,
    jobCountry: (row.job_country ?? 'unknown') as 'us' | 'non_us' | 'unknown',
    employerFilesH1b: row.employer_sponsors === true
      && row.portal_name_mismatch !== true
      && row.job_country !== 'non_us',
  }).evidence;
}

/** The jurisdiction the evidence applies to, never a generic worldwide sponsorship claim. */
export function sponsorshipCountryCodeFor(row: {
  sponsorship_status: string | null;
  sponsorship_scope?: string | null;
  employer_sponsors: boolean | null;
  job_country?: string | null;
  portal_name_mismatch?: boolean | null;
  location?: string | null;
  raw_json?: unknown;
}): string | null {
  const evidence = evidenceFor(row);
  if (evidence === 'employer_h1b_filings') return 'US';
  if (evidence !== 'posting_offers') return null;
  if (row.sponsorship_scope === 'us_h1b') return 'US';
  const metadata = row.raw_json && typeof row.raw_json === 'object'
    ? row.raw_json as Record<string, unknown>
    : {};
  return postingCountryCodeFromJobContext({ ...metadata, location: row.location ?? undefined }) ?? null;
}

export type GroupedPostingOfferContext = {
  sponsorship_scope?: string | null;
  job_country?: string | null;
  location?: string | null;
  raw_json?: unknown;
};

/**
 * Sponsorship proof for a grouped role without detaching an offer from the country it belongs to.
 * The SQL aggregate feeding this helper contains affirmative posting rows only. A refusal or an
 * unstated copy in another country therefore cannot donate its location to the sponsorship badge,
 * and an H-1B clause on a foreign copy contributes nothing.
 */
export function groupedSponsorshipFor(input: {
  postingOffers: GroupedPostingOfferContext[] | null | undefined;
  employerFilesH1b: boolean;
}): { evidence: 'posting_offers' | 'employer_h1b_filings' | null; countryCodes: string[] } {
  const eligibleOffers = (input.postingOffers ?? []).filter((offer) => evidenceFor({
    sponsorship_status: 'offers',
    sponsorship_scope: offer.sponsorship_scope,
    employer_sponsors: false,
    job_country: offer.job_country,
  }) === 'posting_offers');

  if (eligibleOffers.length > 0) {
    const countryCodes = [...new Set(eligibleOffers
      .map((offer) => sponsorshipCountryCodeFor({
        sponsorship_status: 'offers',
        sponsorship_scope: offer.sponsorship_scope,
        employer_sponsors: false,
        job_country: offer.job_country,
        location: offer.location,
        raw_json: offer.raw_json,
      }))
      .filter((code): code is string => Boolean(code)))];
    return { evidence: 'posting_offers', countryCodes };
  }

  if (input.employerFilesH1b) {
    return { evidence: 'employer_h1b_filings', countryCodes: ['US'] };
  }
  return { evidence: null, countryCodes: [] };
}

export async function studentResumeFacts(userId: string | undefined): Promise<{ resumeText: string | null; degree: string | null }> {
  if (!userId) return { resumeText: null, degree: null };
  const [profile] = await db
    .select({ base_resume_json: profiles.base_resume_json, parsed_json: profiles.parsed_json })
    .from(profiles)
    .where(eq(profiles.user_id, userId))
    .limit(1);
  const spec = profile?.base_resume_json as ResumeSpec | null | undefined;
  const parsed = profile?.parsed_json as { degree?: string | null } | null | undefined;
  const text = spec ? resumeSpecText(spec).trim() : '';
  const degree = spec?.degree?.trim() || parsed?.degree?.trim() || null;
  return { resumeText: text || null, degree };
}

/**
 * The student's graduation date, from whichever record actually holds one.
 *
 * There is no grad_date COLUMN anywhere: it lives inside the resume JSON, which is why nothing
 * before this could gate a board on it. base_resume_json is preferred because it is the record the
 * student curates and it survives a re-upload; parsed_json is the fallback and is overwritten
 * wholesale by every upload (see the note on targeting.primary_period).
 *
 * Null when there is nothing on file, and null must never gate: a student who has not finished
 * their profile gets the whole board, not an empty one.
 */
export async function studentGradDate(userId: string | undefined): Promise<string | null> {
  if (!userId) return null;
  const [profile] = await db
    .select({ base_resume_json: profiles.base_resume_json, parsed_json: profiles.parsed_json })
    .from(profiles)
    .where(eq(profiles.user_id, userId))
    .limit(1);
  if (!profile) return null;
  const base = profile.base_resume_json as { grad_date?: string | null; grad_year?: number | null } | null;
  const parsed = profile.parsed_json as { grad_date?: string | null; grad_year?: number | null } | null;
  for (const source of [base, parsed]) {
    if (!source) continue;
    if (typeof source.grad_date === 'string' && source.grad_date.trim()) return source.grad_date.trim();
    /* grad_year is a real stored value - submissionEducationGuard builds grad_date from it - and a
       bare year parses to December, which is the reading that cannot hide a spring internship the
       student can actually do. */
    if (typeof source.grad_year === 'number' && source.grad_year > 1900) return String(source.grad_year);
  }
  return null;
}

const UPSERT_CHUNK = 200;

function requireOperator(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!isCronConfigured() || !isCronAuthorized(request)) {
    reply.status(401).send({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

function configuredSources(): JobSourceWithLogoEvidence[] {
  const raw = process.env.JOB_MONITOR_SOURCES_JSON;
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('JOB_MONITOR_SOURCES_JSON must be valid JSON');
  }
  const result = z.array(sourceSchema).max(100).safeParse(parsed);
  if (!result.success) throw new Error('JOB_MONITOR_SOURCES_JSON contains an invalid source');
  return result.data;
}

/**
 * Combine the reviewed catalog with optional operator additions without polling a board twice.
 * Runtime configuration wins for the same ATS/token so an operator can temporarily disable or
 * correct a source while the reviewed catalog remains the durable default.
 */
export function mergeJobSources(
  reviewed: readonly JobSourceWithLogoEvidence[],
  configured: readonly JobSourceWithLogoEvidence[],
): JobSourceWithLogoEvidence[] {
  const merged = new Map<string, JobSourceWithLogoEvidence>();
  for (const source of [...reviewed, ...configured]) {
    const atsName = source.ats_name.toLowerCase() as SupportedJobBoard;
    if (!(POLLABLE_JOB_BOARDS as readonly string[]).includes(atsName)) {
      throw new Error(`Unsupported job board: ${String(source.ats_name)}`);
    }
    const boardToken = normalizeExecutableAtsBoardToken(atsName, source.board_token);
    if (!boardToken) {
      throw new Error(`Invalid ${atsName} board token`);
    }
    merged.set(`${atsName}/${boardToken}`, {
      ...source,
      ats_name: atsName,
      board_token: boardToken,
    });
  }
  return [...merged.values()];
}

/** Keep the queryable sponsor table aligned with the reviewed generated artifact on every run. */
export async function syncSponsorEmployers() {
  const confirmed = H1B_EMPLOYERS.filter((employer) => employer.sponsors);
  if (confirmed.length === 0) {
    throw new Error('Refusing to sync an empty confirmed sponsor-employer list');
  }
  for (let start = 0; start < confirmed.length; start += UPSERT_CHUNK) {
    const chunk = confirmed.slice(start, start + UPSERT_CHUNK);
    await db.insert(sponsor_employers).values(chunk.map((employer) => ({
      normalized_name: employer.normalized,
      company_name: employer.company,
      legal_names: employer.legal_names,
      evidence_source: employer.evidence!,
      approvals: employer.approvals,
      denials: employer.denials,
      fiscal_years: employer.fiscal_years,
      lca_certifications: employer.lca_certifications,
      verified_at: new Date(),
    }))).onConflictDoUpdate({
      target: sponsor_employers.normalized_name,
      set: {
        company_name: sql`excluded.company_name`,
        legal_names: sql`excluded.legal_names`,
        evidence_source: sql`excluded.evidence_source`,
        approvals: sql`excluded.approvals`,
        denials: sql`excluded.denials`,
        fiscal_years: sql`excluded.fiscal_years`,
        lca_certifications: sql`excluded.lca_certifications`,
        verified_at: sql`excluded.verified_at`,
      },
    });
  }
  await db.delete(sponsor_employers).where(notInArray(
    sponsor_employers.normalized_name,
    confirmed.map((employer) => employer.normalized),
  ));
}

export const REVIEWED_DOMAIN_CANDIDATE_METHOD = 'reviewed_company_domain_candidate';
export const ATS_BRAND_CANDIDATE_METHOD = 'first_party_ats_brand_candidate';

function logoEvidenceForSource(source: JobSourceWithLogoEvidence) {
  const carriesExplicitEvidence = source.company_domain !== undefined
    || source.company_logo_url !== undefined
    || source.logo_verification_status !== undefined
    || source.logo_verification_method !== undefined
    || source.logo_verified_at !== undefined;
  if (carriesExplicitEvidence) {
    return {
      company_domain: source.company_domain ?? null,
      company_logo_url: source.company_logo_url ?? null,
      logo_verification_status: source.logo_verification_status ?? 'unverified' as LogoVerificationStatus,
      logo_verification_method: source.logo_verification_method ?? null,
      logo_verified_at: source.logo_verified_at ? new Date(source.logo_verified_at) : null,
      logo_last_checked_at: source.logo_verification_status === 'verified' && source.logo_verified_at
        ? new Date(source.logo_verified_at)
        : null,
      logo_verification_error: null,
    };
  }

  /* Transitional candidate only. A hand-maintained company-to-domain association is useful for
     finding the homepage, but it is not current image proof. The bounded verifier must fetch an
     identity-matching homepage and a real image before any posting from this source is counted. */
  const reviewedDomain = companyDomainFor(source.company_name);
  return reviewedDomain
    ? {
      company_domain: reviewedDomain,
      company_logo_url: null,
      logo_verification_status: 'unverified' as const,
      logo_verification_method: REVIEWED_DOMAIN_CANDIDATE_METHOD,
      logo_verified_at: null,
      logo_last_checked_at: null,
      logo_verification_error: null,
    }
    : {
      company_domain: null,
      company_logo_url: null,
      logo_verification_status: 'unverified' as const,
      logo_verification_method: ATS_BRAND_CANDIDATE_METHOD,
      logo_verified_at: null,
      logo_last_checked_at: null,
      logo_verification_error: null,
    };
}

/** Insert or refresh source metadata and its current sponsor link in bounded batches. */
export async function upsertSources(
  sources: readonly JobSourceWithLogoEvidence[],
  options: { preserveExistingDisabled?: boolean } = {},
) {
  // This is also called by the operator API, whose validated array may repeat a composite key.
  // PostgreSQL rejects two rows targeting the same conflict key in one INSERT, so deduplicate at
  // the shared write boundary rather than relying on every caller to remember. Last value wins.
  const uniqueSources = mergeJobSources([], sources);
  const sponsorRows = await db
    .select({ id: sponsor_employers.id, normalized_name: sponsor_employers.normalized_name })
    .from(sponsor_employers);
  const sponsorIds = new Map(sponsorRows.map((row) => [row.normalized_name, row.id]));
  const disabledIds: string[] = [];

  for (let start = 0; start < uniqueSources.length; start += UPSERT_CHUNK) {
    /* Validate reviewed TypeScript data too. Compile-time types do not protect generated catalogs
       or environment JSON, and a false `verified` here would inflate the public inventory. */
    const chunk = uniqueSources.slice(start, start + UPSERT_CHUNK)
      .map((source) => sourceSchema.parse(source));
    const rows = await db.insert(career_page_sources).values(chunk.map((source) => ({
      company_name: source.company_name,
      ats_name: source.ats_name,
      board_token: source.board_token,
      career_url: source.career_url,
      enabled: source.enabled ?? true,
      sponsor_employer_id: sponsorIds.get(normalizeEmployerName(source.company_name)) ?? null,
      ...logoEvidenceForSource(source),
    }))).onConflictDoUpdate({
      target: [career_page_sources.ats_name, career_page_sources.board_token],
      set: {
        /* A fresh discovery catalog knows a board token, not necessarily the employer identity.
           Once independent proof has named and branded a source, a later provisional refresh must
           not rename it back to the slug and erase that proof. */
        company_name: sql`case
          when excluded.logo_verification_status = 'unverified'
            and ${career_page_sources.logo_verification_status} = 'verified'
          then ${career_page_sources.company_name} else excluded.company_name end`,
        career_url: sql`excluded.career_url`,
        /* Scheduled discovery is additive and cannot override an operator disable. The operator
           endpoint uses the default mode, so an explicit enabled=true there can still restore a
           reviewed source. */
        enabled: options.preserveExistingDisabled
          ? sql`case when ${career_page_sources.enabled} = false then false else excluded.enabled end`
          : sql`excluded.enabled`,
        /* Unverified catalog candidates seed an empty row but never downgrade verified evidence or
           erase a recorded failure on the next daily sync. Only incoming VERIFIED proof replaces
           stored proof. A verified incoming rename re-evaluates the logo; a provisional slug is
           never allowed to rename a source whose employer identity is already proven. */
        company_domain: sql`case
          when (excluded.company_name is distinct from ${career_page_sources.company_name}
              and not (excluded.logo_verification_status = 'unverified'
                and ${career_page_sources.logo_verification_status} = 'verified'))
            or (excluded.logo_verification_status = 'verified'
              and excluded.logo_verification_method is distinct from ${REVIEWED_DOMAIN_CANDIDATE_METHOD})
            or ${career_page_sources.logo_verification_status} = 'unverified'
          then excluded.company_domain else ${career_page_sources.company_domain} end`,
        company_logo_url: sql`case
          when (excluded.company_name is distinct from ${career_page_sources.company_name}
              and not (excluded.logo_verification_status = 'unverified'
                and ${career_page_sources.logo_verification_status} = 'verified'))
            or (excluded.logo_verification_status = 'verified'
              and excluded.logo_verification_method is distinct from ${REVIEWED_DOMAIN_CANDIDATE_METHOD})
            or ${career_page_sources.logo_verification_status} = 'unverified'
          then excluded.company_logo_url else ${career_page_sources.company_logo_url} end`,
        logo_verification_status: sql`case
          when (excluded.company_name is distinct from ${career_page_sources.company_name}
              and not (excluded.logo_verification_status = 'unverified'
                and ${career_page_sources.logo_verification_status} = 'verified'))
            or (excluded.logo_verification_status = 'verified'
              and excluded.logo_verification_method is distinct from ${REVIEWED_DOMAIN_CANDIDATE_METHOD})
            or ${career_page_sources.logo_verification_status} = 'unverified'
          then excluded.logo_verification_status else ${career_page_sources.logo_verification_status} end`,
        logo_verification_method: sql`case
          when (excluded.company_name is distinct from ${career_page_sources.company_name}
              and not (excluded.logo_verification_status = 'unverified'
                and ${career_page_sources.logo_verification_status} = 'verified'))
            or (excluded.logo_verification_status = 'verified'
              and excluded.logo_verification_method is distinct from ${REVIEWED_DOMAIN_CANDIDATE_METHOD})
            or ${career_page_sources.logo_verification_status} = 'unverified'
          then excluded.logo_verification_method else ${career_page_sources.logo_verification_method} end`,
        logo_verified_at: sql`case
          when (excluded.company_name is distinct from ${career_page_sources.company_name}
              and not (excluded.logo_verification_status = 'unverified'
                and ${career_page_sources.logo_verification_status} = 'verified'))
            or (excluded.logo_verification_status = 'verified'
              and excluded.logo_verification_method is distinct from ${REVIEWED_DOMAIN_CANDIDATE_METHOD})
            or ${career_page_sources.logo_verification_status} = 'unverified'
          then excluded.logo_verified_at else ${career_page_sources.logo_verified_at} end`,
        logo_last_checked_at: sql`case
          when (excluded.company_name is distinct from ${career_page_sources.company_name}
              and not (excluded.logo_verification_status = 'unverified'
                and ${career_page_sources.logo_verification_status} = 'verified'))
            or (excluded.logo_verification_status = 'verified'
              and excluded.logo_verification_method is distinct from ${REVIEWED_DOMAIN_CANDIDATE_METHOD})
            or ${career_page_sources.logo_verification_status} = 'unverified'
          then excluded.logo_last_checked_at else ${career_page_sources.logo_last_checked_at} end`,
        logo_verification_error: sql`case
          when (excluded.company_name is distinct from ${career_page_sources.company_name}
              and not (excluded.logo_verification_status = 'unverified'
                and ${career_page_sources.logo_verification_status} = 'verified'))
            or (excluded.logo_verification_status = 'verified'
              and excluded.logo_verification_method is distinct from ${REVIEWED_DOMAIN_CANDIDATE_METHOD})
            or ${career_page_sources.logo_verification_status} = 'unverified'
          then excluded.logo_verification_error else ${career_page_sources.logo_verification_error} end`,
        // A portal identity disagreement always wins. Once a later successful poll clears the
        // mismatch, the next sync may restore the reviewed employer link.
        sponsor_employer_id: sql`case
          when ${career_page_sources.portal_name_mismatch} then null
          when excluded.logo_verification_status = 'unverified'
            and ${career_page_sources.logo_verification_status} = 'verified'
          then ${career_page_sources.sponsor_employer_id}
          else excluded.sponsor_employer_id end`,
      },
    }).returning({ id: career_page_sources.id, enabled: career_page_sources.enabled });
    disabledIds.push(...rows.filter((row) => !row.enabled).map((row) => row.id));
  }
  if (disabledIds.length > 0) {
    await db.update(monitored_jobs).set({ is_active: false })
      .where(inArray(monitored_jobs.source_id, disabledIds));
  }
}

function pollFailureMessage(error: unknown): string {
  let current: unknown = error;
  let message = 'Career page poll failed';
  const seen = new Set<object>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('message' in current && typeof current.message === 'string' && current.message.trim()) {
      message = current.message;
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return message;
}

/**
 * The one transaction both board-preserving guards share: count the source's live rows, ask the
 * caller what fault (if any) that count proves, and record it on the source without touching
 * monitored_jobs. `buildMessage` returning null means "no fault after all" - the empty-fetch guard
 * uses it to fall through to the ordinary sweep when there is nothing to preserve - and the
 * transaction then commits having written nothing.
 *
 * Deliberately NOT advancing last_successful_poll_at, and deliberately NOT persisting the
 * rejection-baseline counts: a guard firing is a fault, and a fault must neither mint success
 * evidence nor become the baseline the next poll's rejections are judged against (a baseline of
 * "everything rejected" would read recovery as improvement and the next partial drift as noise).
 */
async function recordBoardPreservingFault(
  sourceId: string,
  buildMessage: (activeNow: number) => string | null,
): Promise<string | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local lock_timeout = '${POLL_SOURCE_LOCK_TIMEOUT_MS}ms'`));
    await tx.execute(sql.raw(
      `set local statement_timeout = '${POLL_SOURCE_STATEMENT_TIMEOUT_MS}ms'`,
    ));
    const [existing] = await tx
      .select({ active: sql<number>`count(*)::int` })
      .from(monitored_jobs)
      .where(and(eq(monitored_jobs.source_id, sourceId), eq(monitored_jobs.is_active, true)));
    const message = buildMessage(existing?.active ?? 0);
    if (message === null) return null;
    await tx.update(career_page_sources)
      .set({ last_polled_at: new Date(), last_error: message })
      .where(eq(career_page_sources.id, sourceId));
    return message;
  });
}

export async function pollSource(source: typeof career_page_sources.$inferSelect) {
  const startingDetailCursor = detailCursorFromLastError(source.last_error);
  const startingDetailCursorKey = detailCursorKeyFromLastError(source.last_error);
  let retryDetailCursor: number | null = startingDetailCursor > 0 ? startingDetailCursor : null;
  let retryDetailCursorKey: string | null = startingDetailCursorKey ?? null;
  let keepInCurrentDrainOnError = startingDetailCursor > 0 || startingDetailCursorKey !== undefined;
  try {
    const fetched = await fetchSourceJobBatch(
      {
        ats_name: source.ats_name as SupportedJobBoard,
        board_token: source.board_token,
      },
      fetch,
      {
        detail_cursor: startingDetailCursor,
        detail_cursor_key: startingDetailCursorKey,
      },
    );
    /* Once the first-party fetch succeeds, a database failure must retry in this drain. For a
       multi-request provider it retries the same window, because the next cursor is committed in
       the source row atomically with the jobs below. */
    keepInCurrentDrainOnError = true;
    retryDetailCursor = fetched.detail_progress?.cursor ?? null;
    retryDetailCursorKey = fetched.detail_progress?.cursor_key ?? null;
    const jobs = fetched.jobs;
    const listedCount = fetched.listed_external_ids.length;

    /* AN EMPTY RESPONSE NEVER DEACTIVATES A BOARD.
     *
     * The transaction below flips every one of this source's jobs to is_active = false and then
     * re-inserts whatever the fetch returned. With `jobs` empty that is a silent wipe of the entire
     * board: Databricks alone is ~600 postings, so two or three sources answering with an empty
     * array takes the whole list under the floor in one cron run, and every check we had would still
     * report success. That is the same shape as the failure this file already carries a comment
     * about, where career_page_sources was empty for months and an empty board looked exactly like a
     * healthy one.
     *
     * An empty array from a board API is overwhelmingly a rotated token, a changed endpoint, or a
     * transient 200-with-no-body - not every job at a company closing between two polls. So it is
     * treated as an error to investigate, and the previous postings stay up. Stale beats absent:
     * a job that closed yesterday wastes one click, an empty board wastes the whole product.
     *
     * A board that genuinely empties recovers by hand (disable the source, or let the row age out).
     * That is the correct trade - the manual step is on the rare true case, not the common false one.
     */
    if (listedCount === 0) {
      const emptyFetchMessage = await recordBoardPreservingFault(source.id, (active) =>
        shouldKeepPostingsOnEmptyFetch(listedCount, active)
          ? `Board returned no postings while ${active} are live; keeping them and not deactivating.`
          : null);
      if (emptyFetchMessage) {
        return {
          source_id: source.id,
          company: source.company_name,
          jobs: 0,
          ok: false as const,
          error: emptyFetchMessage,
        };
      }
    }

    /* A LIST WHOSE POSTINGS ALL FAILED NORMALIZATION NEVER DEACTIVATES A BOARD, AND NEVER LOOKS
     * LIKE A CLEAN POLL.
     *
     * The guard above catches the API answering with nothing. This one catches the API answering
     * with everything and this code accepting none of it - which is what a provider format drift
     * looks like from here, and it must not be invisible. When Greenhouse added `?gh_jid=` to every
     * absolute_url, the strict action-URL validator rejected all 2,239 SpaceX postings; the sweep
     * below then flipped every row inactive, the upsert loop had nothing to write, and the source
     * finished as a SUCCESS: last_polled_at and last_successful_poll_at advanced, last_error was
     * cleared. Nothing anywhere recorded that a 2,239-posting board had just ingested zero.
     *
     * So a fully rejected fetch is treated exactly like an empty one - existing rows stay up, the
     * fault lands in last_error where it is queryable - with one addition: it is recorded even when
     * there is nothing to preserve, because a source that has NEVER ingested (a custom-domain
     * Greenhouse board, say) failing silently on every poll is the same invisibility.
     *
     * Single-fetch providers only. For Rippling, Breezy, and Crelate an all-failed detail window is
     * already represented honestly: preserve_external_ids reactivates the list-confirmed rows and
     * detailRefreshStatus persists the failure and cursor, and this early return must not bypass
     * that cursor advancement. */
    if (!fetched.detail_progress && listedCount > 0 && jobs.length === 0) {
      const rejectedFetchMessage = await recordBoardPreservingFault(source.id, (active) =>
        shouldKeepPostingsOnFullyRejectedFetch(listedCount, jobs.length, active)
          ? `Board listed ${listedCount} postings but none survived normalization; keeping the ${active} live rows and not deactivating.`
          : `Board listed ${listedCount} postings but none survived normalization; no live rows to keep.`);
      return {
        source_id: source.id,
        company: source.company_name,
        jobs: 0,
        ok: false as const,
        /* Non-null in fact: unlike the empty-fetch builder, this one never declines to record. */
        error: rejectedFetchMessage!,
      };
    }

    /* CURRENTNESS IS ESTABLISHED AT INGEST, not inferred from publication age.
     *
     * Filtering only in boardConditions() meant the table stored every posting a board had ever
     * carried and then hid most of them on every single read: 22,125 rows active, 10,008 shown,
     * 12,117 stored and re-upserted daily purely to be filtered out again. That is storage and write
     * amplification for rows no visitor can reach, on a 512 MB database.
     *
     * Dropping them here is self-healing rather than lossy. If a board later re-dates a posting into
     * the window - which Greenhouse does routinely, since its date is `updated_at` - the next poll
     * simply sees it as fresh and inserts it. Nothing needs to remember what was skipped.
     *
     * NOTE the guard above keys off `listedCount`, the raw list fetch, and must keep doing so. If it read
     * this filtered count instead, a board whose postings are all older than the window would look
     * identical to a board that returned nothing, and the run would refuse to deactivate postings
     * that genuinely aged out. "The API returned nothing" and "the API returned nothing FRESH" are
     * different facts and only the first one is a fault. */
    /* Two cutoffs, matching freshnessPredicate. The ingest gate is the THIRD place the window is
       enforced (read, purge, here) and the one that decides what exists at all: an internship the
       poll refuses to store can never be shown by a longer read window, so leaving this behind the
       constants would make the other two changes inert. The employment type is resolved by the
       normalizers before this point, which is what lets the gate ask. */
    const ingestable = jobs
      /* Same reasoning as the window, and deliberately on the same side of the guard. Two things
         never reach the table: a posting whose description is a placeholder or the title repeated
         (nothing a student can evaluate or the matcher can score), and a posting that declares
         itself a test or a fake (BCG ships four, two of them with a full and convincing role
         description bolted onto the disclaimer). This is the daily cron's path, so both are
         enforced at ingest every morning rather than hidden at read time.
         It must run HERE and not inside the normalizers: Disney's board is two postings and both
         are placeholders, so filtering upstream would make that board indistinguishable from one
         that answered with nothing, and the guard above would then pin the junk in place. */
      .filter(isIngestablePosting);

    const now = new Date();
    const portalName = jobs.map((job) => job.portal_company_name).find(Boolean) ?? null;
    const agrees = portalNameAgrees(source.company_name, portalName);
    const fingerprintEmployerName = agrees === false
      ? null
      : portalName ?? source.portal_company_name;
    const detailStatus = detailRefreshStatus(fetched.detail_progress);
    /* THE PARTIAL SIBLING OF THE FULLY-REJECTED GUARD, detection only. When most but not ALL of a
     * board fails action-URL validation - a new Greenhouse query param rolling through mixed CDN
     * caches, so 2,238 of 2,239 URLs are rejected while 1 survives - the guard above does not fire,
     * and this poll goes on to sweep every rejected row inactive as a recorded SUCCESS. That sweep
     * is not second-guessed here (one surviving posting is real list evidence, unlike zero), but it
     * must stop being invisible: the fault lands in last_error on a poll that otherwise cleared it,
     * and in the cron result for the route to log.
     *
     * Single-fetch providers only, same scoping and same reason as the guard: a multi-request
     * provider's `jobs` is one detail window against the full list, so listed-minus-normalized is
     * not a rejection count there, and preserve_external_ids already keeps those boards honest. */
    const rejectedCount = fetched.detail_progress ? null : listedCount - jobs.length;
    const rejectionSpikeMessage = rejectedCount !== null
      && rejectionSpikeExceedsBaseline(
        source.last_poll_listed_count,
        source.last_poll_normalized_count,
        listedCount,
        jobs.length,
      )
      ? `Action-URL rejections jumped: ${rejectedCount} of ${listedCount} listed postings failed `
        + `normalization against ${rejectedFromCounts(source.last_poll_listed_count!, source.last_poll_normalized_count!)} `
        + `of ${source.last_poll_listed_count} on the previous completed poll. The rejected rows were `
        + 'swept inactive on a poll recorded as a success; suspect provider URL-format drift.'
      : null;
    try {
      await retryTransient(() => db.transaction(async (tx) => {
        await tx.execute(sql.raw(`set local lock_timeout = '${POLL_SOURCE_LOCK_TIMEOUT_MS}ms'`));
        await tx.execute(sql.raw(
          `set local statement_timeout = '${POLL_SOURCE_PERSISTENCE_STATEMENT_TIMEOUT_MS}ms'`,
        ));
        /* Logo verification locks the source row before it can update that source's postings. Keep
           the poll transaction in the same source-then-jobs order so the two write paths cannot form
           a PostgreSQL row-lock cycle if an operator invokes one outside the shared route lock. */
        await tx.execute(sql`select ${career_page_sources.id}
          from ${career_page_sources}
          where ${career_page_sources.id} = ${source.id}
          for update`);
        await tx.update(monitored_jobs).set({ is_active: false }).where(eq(monitored_jobs.source_id, source.id));
      /* Rippling, Breezy, and Crelate confirm open IDs before fetching descriptions. A failed or
         deferred detail request cannot revoke that stronger list evidence. Reactivate those
         existing rows with their last good descriptions while the persisted cursor advances.
         Successful details are deliberately excluded from this set: if a refreshed description
         is now a placeholder, the ingest quality gate is allowed to remove it. */
        for (let index = 0; index < fetched.preserve_external_ids.length; index += UPSERT_CHUNK) {
          const ids = fetched.preserve_external_ids.slice(index, index + UPSERT_CHUNK);
          await tx.update(monitored_jobs).set({ is_active: true }).where(and(
            eq(monitored_jobs.source_id, source.id),
            inArray(monitored_jobs.external_id, ids),
          ));
        }
      /* One statement per posting meant 7,109 round trips for a full sweep and a 469s run. A
         scheduler deadline could stop halfway through the alphabet, leaving every unreached
         source's jobs flipped to is_active = false by the sweep above. That failure empties the
         public board rather than staling it.
         Chunked so a single board the size of Databricks still fits well
         inside Postgres's 65,535-parameter cap: 21 columns x 200 rows. */
        for (let index = 0; index < ingestable.length; index += UPSERT_CHUNK) {
          const chunk = ingestable.slice(index, index + UPSERT_CHUNK).map(({
          pay,
          portal_country: portalCountry,
          portal_company_name: _portalCompanyName,
          ...job
        }) => {
          const sponsorship = readPostingSponsorshipAssessment(job.description);
          const jobCountry = resolveJobCountry(portalCountry, job.location);
          return {
            source_id: source.id,
            company_name: source.company_name,
            ...job,
            /* Destructured OUT OF the spread above, never spread in. `pay` is a nested object on
               NormalizedJob and there is no such column; drizzle would carry it into the INSERT and
               fail the whole 200-row chunk, which takes that board's poll down with it.
               All four move together. A posting whose pay period could not be established stores
               null in all of them rather than a figure with no period. See lib/compensation.ts. */
            salary_min: pay?.min ?? null,
            salary_max: pay?.max ?? null,
            salary_currency: pay?.currency ?? null,
            salary_interval: pay?.interval ?? null,
            last_seen_at: now,
            is_active: true,
            /* `ingestable` was produced by the complete validator immediately above. Persist that
               decision so every SQL surface can reject legacy or manually inserted junk too. */
            ingest_eligible: true,
            certification_fingerprint: fingerprintEmployerName
              ? buildJobCertificationFingerprint({
                employer_name: fingerprintEmployerName,
                title: job.title,
                description: job.description,
              })
              : null,
            /* Read here, at the moment the description arrives, so the board filter is a plain
               column comparison. Recomputed on every poll rather than kept from the first sighting:
               employers edit this sentence into and out of a live posting, and a policy that changed
               on their page while ours still said the old thing is the one error this feature cannot
               afford. */
            sponsorship_status: sponsorship.status,
            sponsorship_scope: sponsorship.scope,
            /* Built here, at the same moment and for the same reason as sponsorship_status: the
               description is in hand, and this is the only point where computing over it is free.
               Recomputed on every poll rather than kept from the first sighting, because employers
               edit requirements into and out of a live posting. */
            description_digest: buildDescriptionDigest(job.description),
            /* Existing schema-compatible review metadata, not a new column. The exact ATS country
               must survive the poll so resume generation can freeze it into job_context. A coarse
               `job_country = non_us` cannot distinguish London from Toronto, and therefore cannot
               select one applicant declaration truthfully. Old rows remain null until their normal
               board refresh, so this needs no backfill or unreviewed production migration. */
            raw_json: portalCountry ? { portal_country: portalCountry } : null,
            /* The portal's own country field first, the location string only when it published none.
               Reading the string first is what made "IN - Bengaluru" Indiana and "Amsterdam, NH"
               New Hampshire. */
            job_country: jobCountry,
          };
        });
          await tx.insert(monitored_jobs).values(chunk).onConflictDoUpdate({
          target: [monitored_jobs.source_id, monitored_jobs.external_id],
          set: {
            company_name: sql`excluded.company_name`,
            title: sql`excluded.title`,
            location: sql`excluded.location`,
            department: sql`excluded.department`,
            employment_type: sql`excluded.employment_type`,
            description: sql`excluded.description`,
            ingest_eligible: sql`excluded.ingest_eligible`,
            certification_fingerprint: sql`excluded.certification_fingerprint`,
            apply_url: sql`excluded.apply_url`,
            posting_url: sql`excluded.posting_url`,
            remote: sql`excluded.remote`,
            posted_at: sql`excluded.posted_at`,
            last_seen_at: sql`excluded.last_seen_at`,
            is_active: sql`excluded.is_active`,
            sponsorship_status: sql`excluded.sponsorship_status`,
            sponsorship_scope: sql`excluded.sponsorship_scope`,
            description_digest: sql`excluded.description_digest`,
            job_country: sql`excluded.job_country`,
            raw_json: sql`excluded.raw_json`,
            /* Overwritten on every poll, not merged. An employer that REMOVES a published range
               (or edits one into a shape we decline to guess a period for) must see it disappear
               from the board on the next run; a COALESCE here would pin the old figure to the row
               forever, which is the one error a salary display cannot afford. */
            salary_min: sql`excluded.salary_min`,
            salary_max: sql`excluded.salary_max`,
            salary_currency: sql`excluded.salary_currency`,
            salary_interval: sql`excluded.salary_interval`,
          },
          });
        }
        /* Cursor state and the job window are one atomic fact. Committing either without the other
           can skip a window forever after a transient database or source-status write failure. */
        await tx.update(career_page_sources).set({
          ...completedPollFields(fetched.detail_progress, now),
          /* The baseline moves only when a poll completes its sweep, so a spike is always judged
             against the last poll that actually wrote the board - never against a guard fault. An
             EMPTY completed poll (nothing listed and nothing live for the guard to preserve) is
             also excluded: it says nothing about rejection rates, and a 0/0 baseline would make
             the next real poll's steady by-design rejections read as a jump from zero. */
          ...(rejectedCount === null || listedCount === 0 ? {} : {
            last_poll_listed_count: listedCount,
            last_poll_normalized_count: jobs.length,
          }),
          /* Never both: a spike only exists on the single-fetch path, where detailStatus is null. */
          last_error: rejectionSpikeMessage ?? detailStatus,
          ...(portalName ? { portal_company_name: portalName } : {}),
          ...(agrees === null ? {} : { portal_name_mismatch: agrees === false }),
          ...(agrees === false ? { sponsor_employer_id: null } : {}),
        }).where(eq(career_page_sources.id, source.id));
      }), {
        attempts: POLL_SOURCE_PERSISTENCE_ATTEMPTS,
        delayMs: POLL_SOURCE_PERSISTENCE_RETRY_DELAY_MS,
      });
    } catch (error) {
      /* A deterministic row or constraint failure must not pin the oldest-first queue forever.
         Every retry above rolled back as one transaction, so terminal advancement records only
         that the source was attempted. It never mints last_successful_poll_at or job evidence. */
      keepInCurrentDrainOnError = false;
      throw error;
    }
    /* WHO DOES THE PORTAL SAY THIS BOARD BELONGS TO?
     *
     * Recorded on every poll, and a disagreement UNLINKS the source from its sponsoring employer.
     * Six boards on this list turned out to be a different company than their token suggested -
     * `sas` is Superior Alarm Systems, `tcs` is Thornbury Community Services - and each was caught
     * by hand, weeks after it started surfacing. Greenhouse was publishing the right answer on
     * every poll in between.
     *
     * A mismatch does not disable the source: whether a board belongs on the list is a judgement
     * about the board list. It does mean we no longer know WHOSE board it is, and an employer's
     * H-1B record cannot be attached to a board we cannot identify.
     *
     * `jobs`, not `ingestable`: identity evidence remains available even when every description is
     * rejected by the product-quality gate. */
    keepInCurrentDrainOnError = false;
    return {
      source_id: source.id,
      company: source.company_name,
      jobs: ingestable.length,
      fetched: jobs.length,
      listed: listedCount,
      preserved: fetched.preserve_external_ids.length,
      ...(rejectedCount === null ? {} : { rejected: rejectedCount }),
      ...(rejectionSpikeMessage === null ? {} : { rejection_spike: rejectionSpikeMessage }),
      ...(fetched.detail_progress ? { detail_progress: fetched.detail_progress } : {}),
      ok: true as const,
      ...(agrees === false ? { portal_says: portalName } : {}),
    };
  } catch (error) {
    const baseMessage = pollFailureMessage(error);
    const cursorMarker = retryDetailCursor === null ? '' : ` next_detail_cursor=${retryDetailCursor}`;
    const keyMarker = detailCursorKeyMarker(retryDetailCursorKey);
    const marker = `${cursorMarker}${keyMarker ? ` ${keyMarker}` : ''}`;
    const message = `${baseMessage.slice(0, Math.max(1, 2000 - marker.length))}${marker}`;
    await db.transaction(async (tx) => {
      await tx.execute(sql.raw(`set local lock_timeout = '${POLL_SOURCE_LOCK_TIMEOUT_MS}ms'`));
      await tx.execute(sql.raw(
        `set local statement_timeout = '${POLL_SOURCE_STATEMENT_TIMEOUT_MS}ms'`,
      ));
      await tx.update(career_page_sources).set({
        ...(keepInCurrentDrainOnError ? {} : { last_polled_at: new Date() }),
        last_error: message,
      }).where(eq(career_page_sources.id, source.id));
    });
    return { source_id: source.id, company: source.company_name, jobs: 0, ok: false as const, error: message };
  }
}

export type CurrentDrainPollFailure = {
  source_id: string;
  company: string;
  jobs: 0;
  ok: false;
  error: string;
};

/**
 * A terminally attempted source no longer belongs in the queue, but its failure must remain in
 * every recount for this drain. last_successful_poll_at is intentionally older, so the source's
 * jobs cannot contribute to certified inventory even though last_polled_at permits queue progress.
 */
export async function currentDrainPollFailures(
  drainStartedAt: Date,
): Promise<CurrentDrainPollFailure[]> {
  const rows = await db.select({
    source_id: career_page_sources.id,
    company: career_page_sources.company_name,
    error: career_page_sources.last_error,
  }).from(career_page_sources).where(and(
    gte(career_page_sources.last_polled_at, drainStartedAt),
    isNotNull(career_page_sources.last_error),
    or(
      isNull(career_page_sources.last_successful_poll_at),
      lt(career_page_sources.last_successful_poll_at, drainStartedAt),
    ),
  ));
  return rows.map((row) => ({
    source_id: row.source_id,
    company: row.company,
    jobs: 0,
    ok: false,
    error: row.error!,
  }));
}

export function mergeCurrentDrainPollFailures<
  TResult extends { source_id: string; jobs: number; ok: boolean },
>(results: readonly TResult[], persistedFailures: readonly CurrentDrainPollFailure[]) {
  const reportedSourceIds = new Set(results.map((result) => result.source_id));
  return [
    ...results,
    ...persistedFailures.filter((failure) => !reportedSourceIds.has(failure.source_id)),
  ];
}

/* The board's filter set, in ONE place.
 *
 * /jobs and /jobs/grouped answer the same question with different shapes, so the filters have to be
 * identical or the two disagree about what exists — and the autonomous-portal rule in particular is
 * a product guarantee, not a detail: a posting Litos cannot finish is worse on the board than
 * absent, because it looks like every other job right up until the student has tailored a resume
 * for it. Copying these four lines into the second route is how that guarantee rots on one of them.
 */
/**
 * THE SPONSOR-ONLY BOARD, as one SQL predicate, written ONCE.
 *
 * It is the rule in lib/sponsorship.ts (sponsorshipVerdict) expressed for the query planner: the
 * posting says it sponsors, OR the employer has an H-1B filing record and this posting does not
 * refuse.
 *
 * It is a function rather than three inline copies because it is needed in three places that are
 * hundreds of lines apart - the list's WHERE clause, the ranked page's re-read by id, and the
 * detail route - and a change to the rule that reached two of them would show a different board on
 * the list, the ranked page and the posting somebody actually opens, with every test still green.
 *
 * It has to be in the WHERE clause rather than a filter over rows a page returned. Filtering after
 * the fact would leave `total` counting postings the list does not contain, pages holding different
 * numbers of tiles, and the ranking pool spending its 300 slots on postings dropped on the way out,
 * which is the same page-tiling bug the ranking cache exists to prevent.
 */
export function sponsorOnlyPredicate() {
  return and(
    /* The posting itself always wins over company-level filing history: a row whose own text
       reads as refusing sponsorship is excluded regardless of which branch below would otherwise
       admit it.
       THIS USED TO BE `description !~* SPONSORSHIP_BLOCKING_STATUS_PATTERN`, re-run on every
       request. A regex predicate cannot use an index, so it forced a full sequential scan of
       monitored_jobs on every sponsor-only board load - measured on prod 2026-08-27 at ~2s warm
       and ~27s cold, next to ~90ms for the same query without it, and it ran TWICE per
       /jobs/grouped request (once for the rows, once for the count). That is what a visitor
       checking the sponsorship box actually felt: the board "not loading" was this scan timing
       out, not an empty result. `sponsorship_status` is written by the same classifier the regex
       exists to double-check, and a prod audit the same day found zero rows where the two
       disagreed (785 postings match the pattern, all 785 already carry 'refuses'), so this reads
       the already-indexed column the regex was re-deriving instead of re-running it. */
    ne(monitored_jobs.sponsorship_status, 'refuses'),
    or(
      /* Generic sponsorship belongs to the posting's country. An H-1B-only clause is different:
         it can support a US role but cannot support a foreign role just because the same global
         boilerplate appears on both descriptions. Null keeps legacy generic offers eligible until
         the migration and the next first-party poll persist their clause-level scope. */
      and(
        eq(monitored_jobs.sponsorship_status, 'offers'),
        or(
          isNull(monitored_jobs.sponsorship_scope),
          ne(monitored_jobs.sponsorship_scope, 'us_h1b'),
          ne(monitored_jobs.job_country, 'non_us'),
        ),
      ),
      and(
        isNotNull(career_page_sources.sponsor_employer_id),
        /* Belt and braces with the unlink in pollSource: a source whose portal name disagrees with
           ours is one we cannot identify, so nothing on it may be called a confirmed sponsor - even
           if a link survived from before the mismatch was noticed. */
        eq(career_page_sources.portal_name_mismatch, false),
        /* AND THE ROLE HAS TO BE ONE AN H-1B COULD COVER. The employer-level evidence is a US
           petition record; applying it to a Bengaluru or Tokyo posting claims something about a
           visa regime this product knows nothing about. 'unknown' (a bare "Remote") stays in: at a
           company whose entire filing history is American, that is not evidence of a foreign role,
           and hiding it would cost real US openings to avoid a hypothetical. */
        ne(monitored_jobs.job_country, 'non_us'),
      ),
    ),
  )!;
}

/**
 * ONE EMPLOYER MUST NOT OWN THE PAGE.
 *
 * Mehek's rule, 2026-07-28: the same company should not appear more than two or three times on a
 * page, on the signed-out board and on the dashboard's jobs list alike. A board where the first
 * screen is nine Datadog roles reads as one employer's careers page with our name on it, however
 * correct the ordering that produced it.
 *
 * This is the SQL half, for the routes whose pages are database slices. It cannot be done by
 * re-sorting a page in memory: page 2 would be sorted independently of page 1, so a posting could
 * appear on both pages or on neither, and `total` would stop describing the list. The ordering has
 * to be a property of the whole set.
 *
 * `row_number() over (partition by company)` numbers each employer's postings 1, 2, 3… Ordering by
 * that number FIRST is a round-robin: every company's newest posting comes before any company's
 * second. With ~50 companies on the board that puts at most one row per employer in any 50
 * consecutive rows, comfortably inside a 24-row page — stricter than "two or three", and the
 * strictness is the point.
 *
 * What it does NOT do, deliberately:
 * - It never outranks relevance. A title search still puts title matches first and scatters only
 *   within them, or the first page of a search reads as unrelated.
 * - It is skipped entirely when the visitor filtered BY company. Someone who typed "MongoDB" asked
 *   for MongoDB's roles and must get all 267, not one per page.
 * - Deep in the board, once the smaller employers are exhausted, the remaining pages are
 *   necessarily the big ones. That is the shape of the data, not a failure of this rule.
 */
function companyScatter(filters: { company?: string }) {
  if (filters.company) return [];
  return [
    sql`row_number() over (partition by lower(${monitored_jobs.company_name}) order by ${monitored_jobs.posted_at} desc nulls last, ${monitored_jobs.first_seen_at} desc, ${monitored_jobs.id} desc)`,
  ];
}

type CursorSortKey = Pick<JobsCursorKey, 'q_rank' | 'title_rank' | 'posted_at' | 'first_seen_at'>
  & { tie_id: string };

function cursorDate(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Database returned an invalid cursor timestamp');
  return parsed.toISOString();
}

/** Rows after one seek key under relevance ASC, timestamps DESC NULLS LAST, stable id DESC. */
function cursorAfterPredicate(
  key: CursorSortKey,
  expressions: {
    qRank: SQL;
    titleRank: SQL;
    postedAt: SQL;
    firstSeenAt: SQL;
    tieId: SQL;
  },
): SQL {
  const firstSeenAt = new Date(key.first_seen_at);
  const tieAfter = or(
    sql`${expressions.firstSeenAt} < ${firstSeenAt}`,
    and(
      sql`${expressions.firstSeenAt} = ${firstSeenAt}`,
      sql`${expressions.tieId} < ${key.tie_id}`,
    ),
  )!;
  const postedAfter = key.posted_at === null
    ? and(sql`${expressions.postedAt} is null`, tieAfter)!
    : or(
      sql`${expressions.postedAt} is null`,
      sql`${expressions.postedAt} < ${new Date(key.posted_at)}`,
      and(sql`${expressions.postedAt} = ${new Date(key.posted_at)}`, tieAfter),
    )!;
  return or(
    sql`${expressions.qRank} > ${key.q_rank}`,
    and(
      sql`${expressions.qRank} = ${key.q_rank}`,
      sql`${expressions.titleRank} > ${key.title_rank}`,
    ),
    and(
      sql`${expressions.qRank} = ${key.q_rank}`,
      sql`${expressions.titleRank} = ${key.title_rank}`,
      postedAfter,
    ),
  )!;
}

function cursorErrorResponse(error: unknown, reply: FastifyReply) {
  if (!(error instanceof JobBoardCursorError)) throw error;
  return reply.status(400).send({
    error: error.message,
    code: `job_board_cursor_${error.code}`,
  });
}

async function cursorSnapshotTime(): Promise<Date> {
  const clock = await db.execute<{ as_of: Date }>(sql`select now() as as_of`);
  const value = clock.rows[0]?.as_of;
  const asOf = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(asOf.getTime())) throw new Error('Database returned an invalid cursor snapshot time');
  return asOf;
}

function isUnitedStatesLocation(location: string): boolean {
  return location.trim().toLowerCase() === 'united states';
}

/* The pollable boards that are NOT autonomous: assisted-tier families that Litos fills but hands off
 * the final human-check + send (currently just rippling, Cloudflare-Turnstile-gated on submit).
 * Derived from the two classification lists so it can never drift from them, and empty is a valid
 * state (no assisted boards). boardConditions surfaces these ONLY when a caller opts in with
 * includeAssisted, which the shared /jobs route sets solely for signed-in, onboarding-completed
 * accounts (the dashboard). Onboarding and guests always get the autonomous-only board. */
export const ASSISTED_SURFACED_FAMILIES: readonly string[] = POLLABLE_JOB_BOARDS.filter(
  (board) => !(AUTONOMOUS_PORTAL_FAMILIES as readonly string[]).includes(board),
);

export function boardConditions(f: {
  q?: string;
  title?: string;
  location?: string;
  company?: string;
  remote?: 'true' | 'false';
  sponsorOnly?: boolean;
  employmentType?: string;
  targeting?: JobTargeting;
  requireVerifiedEvidence?: boolean;
  asOf?: Date;
  /* Opt-in ONLY. Absent/false keeps the historical autonomous-only board, which every caller but the
     dashboard browse relies on (the onboarding pin, the build route, strong-match emails, the floor
     metrics). When true, the assisted tier is added, so the dashboard can show fill-and-handoff jobs
     alongside the ones Litos submits end to end. */
  includeAssisted?: boolean;
}) {
  const logoEvidence = f.asOf
    ? verifiedLogoEvidencePredicate(f.asOf)
    : verifiedLogoEvidencePredicate();
  const surfacedFamilies = f.includeAssisted
    ? [...AUTONOMOUS_PORTAL_FAMILIES, ...ASSISTED_SURFACED_FAMILIES]
    : [...AUTONOMOUS_PORTAL_FAMILIES];
  const conditions: SQL[] = [
    eq(monitored_jobs.is_active, true),
    eq(career_page_sources.enabled, true),
    inArray(career_page_sources.ats_name, surfacedFamilies),
    /* A first-party board that identifies a different employer is not verified inventory. */
    eq(career_page_sources.portal_name_mismatch, false),
    freshnessPredicate(f.asOf),
  ];
  const requireVerifiedEvidence = f.requireVerifiedEvidence
    ?? publicVerifiedEvidenceGateEnabled();
  if (requireVerifiedEvidence) {
    conditions.push(
      /* The complete validator ran before this row was written. A non-null description alone is
         not evidence that the posting contains enough real information to evaluate. */
      eq(monitored_jobs.ingest_eligible, true),
      /* Positive first-party identity is required. A default false mismatch flag is not proof. */
      sql`nullif(btrim(${career_page_sources.portal_company_name}), '') is not null`,
      /* Logo completeness is part of the product's inventory definition, not presentation polish. */
      logoEvidence,
    );
  }
  if (f.sponsorOnly) conditions.push(sponsorOnlyPredicate());
  /* EXACT MATCH, never ilike. The column holds one normalized product word per posting
     (resolveEmploymentType is the only writer), so a substring match here would make "Contract"
     also match "Contractor" if the vocabulary ever grew, and "Internship" is the one value a
     student filters on expecting a complete, honest set.

     A posting with NO stated type is correctly excluded by this filter rather than swept in as
     Full-time. That is the same call the tile makes: ~84% of the board states no type because
     Greenhouse has no such field, and the product refuses to invent one. So filtering to Full-time
     returns only employers who SAID full-time, and the empty chip stays honest. */
  if (f.employmentType) conditions.push(eq(monitored_jobs.employment_type, f.employmentType));
  if (f.q) {
    conditions.push(or(ilike(monitored_jobs.title, `%${f.q}%`), ilike(monitored_jobs.description, `%${f.q}%`))!);
  }
  if (f.title) conditions.push(ilike(monitored_jobs.title, `%${f.title}%`));
  if (f.location) {
    conditions.push(isUnitedStatesLocation(f.location)
      ? eq(monitored_jobs.job_country, 'us')
      : ilike(monitored_jobs.location, `%${f.location}%`));
  } else if (!f.remote && f.targeting?.locations.length) {
    /* "Remote" is one of the places a student can pick, and it cannot be matched as location text:
       a remote posting is routinely labelled with the head office's city, and a Cape Town office
       job is not remote just because someone wrote "remote-friendly team" in the field. It matches
       the flag instead, OR-ed with the real places so picking London and Remote returns both. */
    const places = f.targeting.locations.filter((location) => !isRemoteLocation(location));
    const wantsRemote = places.length < f.targeting.locations.length;
    const clauses: SQL[] = places.map((location) => isUnitedStatesLocation(location)
      ? eq(monitored_jobs.job_country, 'us')
      : ilike(monitored_jobs.location, `%${location}%`));
    if (wantsRemote) clauses.push(eq(monitored_jobs.remote, true));
    if (clauses.length) conditions.push(clauses.length === 1 ? clauses[0]! : or(...clauses)!);
  }
  if (f.company) conditions.push(ilike(monitored_jobs.company_name, `%${f.company}%`));
  if (f.remote) {
    conditions.push(eq(monitored_jobs.remote, f.remote === 'true'));
  } else if (f.targeting?.remote_only) {
    /* Remote-only and saved locations are independent account requirements. The previous
       else-if made remote-only erase the location filter, so New York plus remote returned jobs
       from every country as long as the posting was remote. */
    conditions.push(eq(monitored_jobs.remote, true));
  }

  if (f.targeting?.role_types.length) {
    const titlePattern = roleTypePattern(f.targeting.role_types);
    const acceptsFullTime = f.targeting.role_types.includes('full-time');
    const fullTime = sql`(
      ${monitored_jobs.title} !~* ${'(^|[^a-z])(intern|internship|trainee|co-op|co op|coop)([^a-z]|$)'}
      and ${monitored_jobs.title} !~* ${'(^|[^a-z])(part.?time|contract|temporary|freelance)([^a-z]|$)'}
      and (${monitored_jobs.employment_type} ~* ${'full.?time'} or ${monitored_jobs.employment_type} is null)
    )`;
    if (titlePattern && acceptsFullTime) {
      conditions.push(or(sql`${monitored_jobs.title} ~* ${titlePattern}`, fullTime)!);
    } else if (titlePattern) {
      conditions.push(sql`${monitored_jobs.title} ~* ${titlePattern}`);
    } else if (acceptsFullTime) {
      conditions.push(fullTime);
    }
  }

  const desiredTitleTerms = f.targeting ? targetTitleTerms(f.targeting) : [];
  if (desiredTitleTerms.length) {
    conditions.push(or(...desiredTitleTerms.map((term) => ilike(monitored_jobs.title, `%${term}%`)))!);
  }
  return conditions;
}

type PersistedCompanyLogoEvidence = {
  company_domain: string | null;
  company_logo_url: string | null;
  logo_verification_status: string;
  logo_verification_method: string | null;
  logo_verified_at: Date | string | null;
};

/**
 * Turn persisted proof into the exact logo evidence a client can render.
 *
 * Only a direct, verified employer image is renderable. There is intentionally no favicon guess or
 * company-name lookup here: every row
 * reaching this helper passed verifiedLogoEvidencePredicate(), and falling back to the static map
 * at response time would make an unpersisted logo look counted even though the inventory query had
 * no proof for it.
 */
export function withVerifiedCompanyLogo<T extends PersistedCompanyLogoEvidence>(
  row: T,
  referenceTime = new Date(Date.now()),
) {
  const {
    company_domain: rawDomain,
    company_logo_url: rawLogoUrl,
    logo_verification_status: verificationStatus,
    logo_verification_method: verificationMethod,
    logo_verified_at: verifiedAt,
    ...rest
  } = row;
  const verifiedAtMs = verifiedAt ? new Date(verifiedAt).getTime() : Number.NaN;
  const referenceTimeMs = referenceTime.getTime();
  const logoProofFresh = Number.isFinite(verifiedAtMs)
    && verifiedAtMs >= referenceTimeMs - VERIFIED_LOGO_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000
    && verifiedAtMs <= referenceTimeMs + 5 * 60 * 1000;
  const directLogoUrl = rawLogoUrl?.trim() || null;
  const evidenceVerified = verificationStatus === 'verified'
    && Boolean(verificationMethod?.trim())
    && VERIFIER_ISSUED_SOURCE_LOGO_METHODS.includes(
      verificationMethod as typeof VERIFIER_ISSUED_SOURCE_LOGO_METHODS[number],
    )
    && logoProofFresh
    && Boolean(directLogoUrl && /^https:\/\/[^\s]+$/.test(directLogoUrl));
  const companyDomain = evidenceVerified ? rawDomain?.trim() || null : null;
  const companyLogoUrl = evidenceVerified ? directLogoUrl : null;
  return {
    ...rest,
    company_domain: companyDomain,
    company_logo_url: companyLogoUrl,
    company_logo_verification_status: verificationStatus,
    company_logo_verification_method: verificationMethod,
    company_logo_verified_at: verifiedAt,
  };
}

export async function jobMonitorRoutes(fastify: FastifyInstance) {
  /**
   * GET /jobs
   *
   * The list of live postings, and — for a signed-in student with a main resume — how well each one
   * matches it, best first.
   *
   * WHY THE RANKING HAPPENS HERE AND NOT IN THE BROWSER
   * ---------------------------------------------------
   * Not because it is free — see RANKING_POOL for the measured cost, which is real and synchronous.
   * Because the ORDER cannot be known until every score is. Scoring in the client would mean one
   * request per row and a list that cannot be SORTED by fit until all of them land, which is to say
   * a list that is not sorted by fit. That argument stands on its own and does not need a
   * performance claim propping it up; an earlier version of this paragraph had one, unmeasured, and
   * it was wrong by roughly an order of magnitude.
   *
   * FOUR RULES THIS HOLDS
   * ---------------------
   *  - IT SCORES THE WHOLE POSTING, NOT THE PREVIEW. The payload's `description` is truncated to
   *    600 characters for transport; the score reads the full column. Scoring the preview would
   *    grade every posting on its intro paragraph, which is where the requirements are not.
   *  - AN UNSCORABLE POSTING GETS null, NEVER 0. jdMatch refuses to score a posting that lists too
   *    few real requirements, and 0 there is a claim about the student's resume that the input
   *    never supported. Those rows sort last, keeping their newest-first order among themselves.
   *  - NO RESUME MEANS NO SCORES AT ALL. Signed in without a main resume, the list behaves exactly
   *    as it does signed out. There is nothing honest to rank against.
   *  - THE RANKING POOL IS BOUNDED AND SAID OUT LOUD. Ordering by fit means the ordering cannot be
   *    pushed into SQL, so the pool is the RANKING_POOL newest matching postings and the response
   *    reports both `ranked` and `ranked_pool` rather than implying the whole board was considered.
   */
  fastify.get('/jobs', { preHandler: optionalAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job filters' });
    const { q, title, location, company, remote, limit, offset, cursor } = parsed.data;
    const cursorMode = cursor !== undefined;
    /* OR, never override. The account's standing answer can only ever ADD the filter, so a request
       that omits the parameter (or sends sponsor_only=false) cannot unfilter the board of someone
       who declared at onboarding that they need sponsorship. */
    const [accountSponsorOnly, jobTargeting, resumeFacts, onboardingComplete] = await Promise.all([
      accountRequiresSponsor(request.jwtPayload?.userId),
      accountJobTargeting(request.jwtPayload?.userId),
      studentResumeFacts(request.jwtPayload?.userId),
      accountOnboardingComplete(request.jwtPayload?.userId),
    ]);
    const { resumeText, degree: candidateDegree } = resumeFacts;
    const sponsorOnly = accountSponsorOnly || parsed.data.sponsor_only === 'true';
    /* The dashboard fill-and-handoff tier. Assisted boards (rippling) are surfaced ONLY to accounts
       that have finished onboarding; guests and in-setup accounts get the autonomous-only board, so
       the onboarding flow only ever shows jobs Litos can submit end to end. Server-side, not a client
       flag. */
    const includeAssisted = onboardingComplete;
    // Only surface jobs Litos can carry all the way to a confirmation on its own.
    //
    // Belt and braces with the compile-time constraint on SupportedJobBoard, and it earns its keep:
    // that type stops NEW sources being added, but monitored_jobs rows outlive their source. A board
    // polled before this rule existed, or one disabled rather than deleted, still has rows joined to
    // a career_page_sources row whose ats_name is whatever it was then. This is the filter that
    // keeps those out of the board and the dashboard, which both read this one route.
    /* `jobTargeting` is still read below for preference_score even when the filters are relaxed,
       and that is the point: a widened row should still be scored against what the student asked
       for, so the screen can see it is a near miss rather than being told it is a perfect fit. */
    const relaxTargeting = parsed.data.relax_targeting === 'true';
    const cursorFilterHash = cursorMode ? jobBoardCursorFilterHash({
      q: q ?? null,
      title: title ?? null,
      location: location ?? null,
      company: company ?? null,
      remote: remote ?? null,
      sponsor_only: sponsorOnly,
      employment_type: parsed.data.employment_type ?? null,
      relax_targeting: relaxTargeting,
      targeting: relaxTargeting ? null : jobTargeting,
      verified_evidence_gate: publicVerifiedEvidenceGateEnabled(),
      /* Part of the hash so a cursor issued for the autonomous-only board can never be replayed
         against the assisted board (or vice versa): the two are different result sets. */
      include_assisted: includeAssisted,
    }) : null;
    const cursorSecret = cursorMode ? jobBoardCursorSigningSecret() : null;
    if (cursorMode && !cursorSecret) {
      return reply.status(503).send({ error: 'Job board cursor signing is not configured' });
    }
    let cursorAsOf: Date | null = null;
    let cursorKey: JobsCursorKey | null = null;
    let cursorTotal: number | null = null;
    if (cursorMode) {
      if (cursor === JOB_BOARD_CURSOR_START) {
        cursorAsOf = await cursorSnapshotTime();
      } else {
        try {
          const decoded = decodeJobBoardCursor(
            cursor!,
            { route: 'jobs', filterHash: cursorFilterHash! },
            cursorSecret!,
          );
          if (decoded.route !== 'jobs') throw new JobBoardCursorError('mismatch', 'Job board cursor route mismatch');
          cursorAsOf = decoded.asOf;
          cursorKey = decoded.key;
          cursorTotal = decoded.total;
        } catch (error) {
          return cursorErrorResponse(error, reply);
        }
      }
    }
    const conditions = boardConditions({
      ...parsed.data,
      employmentType: parsed.data.employment_type,
      sponsorOnly,
      targeting: relaxTargeting ? undefined : jobTargeting,
      asOf: cursorAsOf ?? undefined,
      includeAssisted,
    });
    const pageConditions = cursorAsOf
      ? [...conditions, lte(monitored_jobs.first_seen_at, cursorAsOf)]
      : conditions;

    const selection = {
      id: monitored_jobs.id,
      company_name: monitored_jobs.company_name,
      title: monitored_jobs.title,
      location: monitored_jobs.location,
      department: monitored_jobs.department,
      employment_type: monitored_jobs.employment_type,
      /* Sent as four raw facts, not as a formatted string. The board and the dashboard render pay
         differently (a tile has room for "$145K-200K/yr", a dashboard row shows the full figures),
         and a currency the server has already turned into a symbol cannot be re-rendered for a
         reader's locale. formatPay on the client is the single place that decides how it reads. */
      salary_min: monitored_jobs.salary_min,
      salary_max: monitored_jobs.salary_max,
      salary_currency: monitored_jobs.salary_currency,
      salary_interval: monitored_jobs.salary_interval,
      description: sql<string>`left(${monitored_jobs.description}, ${BOARD_PREVIEW_CHARS})`,
      apply_url: monitored_jobs.apply_url,
      posting_url: monitored_jobs.posting_url,
      remote: monitored_jobs.remote,
      posted_at: monitored_jobs.posted_at,
      first_seen_at: monitored_jobs.first_seen_at,
      ats_name: career_page_sources.ats_name,
      /* 'autonomous' = Litos submits this end to end; 'assisted' = Litos fills the form and hands the
         final human-check + send to the student (rippling's Cloudflare Turnstile). Derived from the
         source family so the client never re-derives the classification, and it only ever reads
         'assisted' when includeAssisted let an assisted row through in the first place. */
      submit_mode: ASSISTED_SURFACED_FAMILIES.length
        ? sql<'autonomous' | 'assisted'>`case when ${inArray(career_page_sources.ats_name, [...ASSISTED_SURFACED_FAMILIES])} then 'assisted' else 'autonomous' end`
        : sql<'autonomous' | 'assisted'>`'autonomous'`,
      /* The company's OWN careers page, which is the only field here that can carry the company's
         own domain. Every other URL on the row points at the job board: apply_url and posting_url
         are all ATS-hosted, including Workable, so a client deriving a company identity from either gets
         the board's identity for every row instead. Operators sometimes register the board URL as
         the careers URL too, so the client still has to check before trusting it. */
      career_url: career_page_sources.career_url,
      company_domain: career_page_sources.company_domain,
      company_logo_url: career_page_sources.company_logo_url,
      logo_verification_status: career_page_sources.logo_verification_status,
      logo_verification_method: career_page_sources.logo_verification_method,
      logo_verified_at: career_page_sources.logo_verified_at,
      /* The two facts behind the sponsorship badge, sent as facts rather than as a verdict. The row
         says what the posting stated and whether the employer has a filing record; evidenceFor()
         turns that into one word, using the same function the filter does. Sending a pre-baked
         "sponsors: true" would let a badge outlive a change to the rule that drew it. */
      sponsorship_status: monitored_jobs.sponsorship_status,
      sponsorship_scope: monitored_jobs.sponsorship_scope,
      employer_sponsors: sql<boolean>`${career_page_sources.sponsor_employer_id} is not null`,
      job_country: monitored_jobs.job_country,
      portal_name_mismatch: career_page_sources.portal_name_mismatch,
      raw_json: monitored_jobs.raw_json,
    };

    /* A search matches the title OR the body, and the body is the whole job description, so
       "product manager" matched 707 postings of which most only mention the phrase in passing
       ("you will work with our product manager"). Sorted by date alone, the top of that page was
       Senior Machine Learning Engineer — a board that looks broken to anyone who types what they
       actually want. Title hits first, then the same date order within each group. Recency alone
       stays the order when there is no search term, which is what a browse wants.
       This also decides WHICH postings enter the ranking pool below, so a search still puts title
       matches in front of the scorer rather than letting them fall off the end of the pool. */
    const relevanceThenNewest = [
      ...(q ? [sql`case when ${monitored_jobs.title} ilike ${`%${q}%`} then 0 else 1 end`] : []),
      ...(title ? [sql`case when ${monitored_jobs.title} ilike ${`%${title}%`} then 0 else 1 end`] : []),
      /* Relevance first, then one employer per turn, then recency. See companyScatter. */
      ...companyScatter(parsed.data),
      desc(monitored_jobs.posted_at),
      desc(monitored_jobs.first_seen_at),
      desc(monitored_jobs.id),
    ];

    /* The board on trylitos.com/browse-jobs prints how many jobs there are and paginates over the
       whole set, and neither is derivable from has_more: a caller reading page 1 can only say
       "more than 24". Counted under the same filters as the page, so the number always describes
       the list beneath it rather than the table. */
    const jobCount = async () => {
      const [row] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(and(...pageConditions));
      return row?.total ?? 0;
    };

    if (cursorMode) {
      const qRank = q
        ? sql<number>`case when ${monitored_jobs.title} ilike ${`%${q}%`} then 0 else 1 end`
        : sql<number>`0::integer`;
      const titleRank = title
        ? sql<number>`case when ${monitored_jobs.title} ilike ${`%${title}%`} then 0 else 1 end`
        : sql<number>`0::integer`;
      const seek = cursorKey ? cursorAfterPredicate({
        ...cursorKey,
        tie_id: cursorKey.id,
      }, {
        qRank,
        titleRank,
        postedAt: sql`${monitored_jobs.posted_at}`,
        firstSeenAt: sql`${monitored_jobs.first_seen_at}`,
        tieId: sql`${monitored_jobs.id}`,
      }) : null;
      const rows = await db
        .select({
          ...selection,
          cursor_q_rank: qRank,
          cursor_title_rank: titleRank,
        })
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(and(...pageConditions, ...(seek ? [seek] : [])))
        /* Cursor mode intentionally omits companyScatter. Its window function has to rank the full
           500,000-row set on every page and therefore cannot become a seek query. Legacy offset
           callers keep that presentation order; cursor callers get relevance, then stable recency. */
        .orderBy(
          qRank,
          titleRank,
          sql`${monitored_jobs.posted_at} desc nulls last`,
          desc(monitored_jobs.first_seen_at),
          desc(monitored_jobs.id),
        )
        .limit(limit + 1);
      const pageRows = rows.slice(0, limit);
      const tail = pageRows.at(-1);
      const total = cursorTotal ?? await jobCount();
      const nextCursor = rows.length > limit && tail
        ? encodeJobBoardCursor({
          route: 'jobs',
          asOf: cursorAsOf!,
          filterHash: cursorFilterHash!,
          total,
          key: {
            q_rank: Number(tail.cursor_q_rank) as 0 | 1,
            title_rank: Number(tail.cursor_title_rank) as 0 | 1,
            posted_at: tail.posted_at ? cursorDate(tail.posted_at) : null,
            first_seen_at: cursorDate(tail.first_seen_at),
            id: tail.id,
          },
        }, cursorSecret!)
        : null;
      return reply.send({
        jobs: pageRows.map(({ cursor_q_rank: _qRank, cursor_title_rank: _titleRank, ...row }) => ({
          ...withVerifiedCompanyLogo(row, cursorAsOf!),
          match_score: null,
          sponsorship_evidence: evidenceFor(row),
          sponsorship_country_code: sponsorshipCountryCodeFor(row),
        })),
        total,
        limit,
        offset: 0,
        has_more: rows.length > limit,
        next_cursor: nextCursor,
        pagination_mode: 'cursor',
        ranked: false,
        ranked_pool: null,
        pool_exhausted: false,
        sponsor_only: sponsorOnly,
      });
    }

    if (!resumeText && !hasTargeting(jobTargeting)) {
      const rows = await db
        .select(selection)
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(and(...conditions))
        .orderBy(...relevanceThenNewest)
        .limit(limit + 1)
        .offset(offset);
      return reply.send({
        jobs: rows.slice(0, limit).map((row) => ({
          ...withVerifiedCompanyLogo(row),
          match_score: null,
          sponsorship_evidence: evidenceFor(row),
          sponsorship_country_code: sponsorshipCountryCodeFor(row),
        })),
        total: await jobCount(),
        limit,
        offset,
        has_more: rows.length > limit,
        ranked: false,
        ranked_pool: null,
        pool_exhausted: false,
        sponsor_only: sponsorOnly,
      });
    }

    /* One ranking per (student, resume, filters), reused across their pages.
       This is what makes the pages TILE. Ranking a live pool on every request meant page 2 was cut
       from a different ordering than page 1, so a posting could appear on both or on neither; now
       the order is decided once and every page is a slice of the same list. It also means the
       scoring pass is paid once per list rather than once per page.
       See lib/rankingCache.ts for what is and is not cached, and for why a miss is always fine. */
    const cacheKey = rankingCacheKey(
      request.jwtPayload!.userId,
      resumeText ?? '',
      /* sponsorOnly is PART OF THE KEY. Without it, one account's two states - before and after the
         filter turns on - share a cached ordering, and the id list computed on the whole board is
         then replayed against the filtered one. Every id it holds still resolves, so the page comes
         back full of exactly the postings the filter exists to hide. */
      JSON.stringify([q ?? '', title ?? '', location ?? '', company ?? '', remote ?? '', sponsorOnly, jobTargeting]),
    );
    let ranking = await readRankingShared(cacheKey);

    if (!ranking) {
      /* TWO PHASES, and the cheap one comes first.
         Phase 1 reads id and company_name only, for a wide slice of the board. No descriptions, so
         a few thousand rows cost almost nothing, and it is what gives PER_COMPANY_CAP enough
         candidates to spread the pool across employers rather than echoing whoever posted last. */
      const candidates = await db
        .select({ id: monitored_jobs.id, company_name: monitored_jobs.company_name })
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(and(...conditions))
        .orderBy(...relevanceThenNewest)
        .limit(CANDIDATE_SCAN);

      const chosen = pickDiversePool(candidates, PER_COMPANY_CAP, RANKING_POOL);
      const poolExhausted = chosen.length > RANKING_POOL;
      const poolIds = chosen.slice(0, RANKING_POOL).map((row) => row.id);

      /* Phase 2 reads the text to score, and ONLY for the rows that made the pool. The scored copy
         is capped at SCORING_CHARS and never reaches the payload: `description` in `selection` is
         the 600-char preview. */
      const pool = poolIds.length
        ? await db
            .select({
              id: monitored_jobs.id,
              company_name: monitored_jobs.company_name,
              title: monitored_jobs.title,
              location: monitored_jobs.location,
              employment_type: monitored_jobs.employment_type,
              remote: monitored_jobs.remote,
              /* The digest when the row has one, the old capped prefix when it does not.
                 The fallback is not dead code and is not temporary in the sense of being removable
                 on a date: it covers every row polled before description_digest existed, and it
                 covers any future row whose digest came back empty. Both resolve themselves on the
                 next poll of that source, and neither is worth a backfill that would spend the
                 transfer this column exists to save. */
              scored_description: sql<string>`coalesce(nullif(${monitored_jobs.description_digest}, ''), left(${monitored_jobs.description}, ${SCORING_CHARS}))`,
            })
            .from(monitored_jobs)
            .where(inArray(monitored_jobs.id, poolIds))
        : [];

      /* Back into candidate order before scoring. `inArray` makes no ordering promise, and
         rankByFit breaks score ties by incoming position — so without this, two equal matches would
         be separated arbitrarily instead of by "most relevant, then newest", which is the only
         other fact we have about them. */
      const poolById = new Map(pool.map((row) => [row.id, row]));
      const orderedPool = poolIds
        .map((id) => poolById.get(id))
        .filter((row): row is (typeof pool)[number] => row !== undefined);

      const scored = rankByFit(orderedPool, resumeText ?? '', jobTargeting);
      /* Fit order decides WHICH jobs lead; this decides that no single employer owns the screen
         while they do. pickDiversePool already spread the POOL across employers, but the pool is
         300 rows and a page is a handful — six Datadog roles could still land together at the top.
         Capped per page, not per pool. */
      const spread = scatterRanked(
        scored.map((entry) => ({ ...entry, company_name: entry.row.company_name })),
        PER_PAGE_COMPANY_CAP,
        RANKED_PAGE_WINDOW,
      );
      ranking = await writeRankingShared(cacheKey, {
        ids: spread.map(({ row }) => row.id),
        scores: new Map(scored.map(({ row, score }) => [row.id, score])),
        poolExhausted,
      });
    }

    /* THE GRADUATION GATE, applied here and not one line earlier or later.
     *
     * Not inside the ranking build: that cache is keyed by filters and SHARED between accounts
     * (readRankingShared), and eligibility depends on the student's own graduation date. Baking it
     * in would serve one student's gate to everybody.
     *
     * Not after pagination either: dropping rows from an already-cut page returns short pages and
     * a has_more that lies. The gate runs across the whole ranked id list, then the page is cut
     * from what survives.
     *
     * TITLE AND TYPE ONLY, no description. Fetching bodies for the entire ranked list to read a
     * term would spend the transfer that description_digest exists to save, and the term parser
     * trusts titles over bodies anyway (a body says "founded in summer 2019"). A posting whose term
     * appears only in its body resolves to `unknown` here, which never gates - the conservative
     * direction, and the clause judge still reads the body when the student opens it. */
    const gradDate = await studentGradDate(request.jwtPayload?.userId);
    let hiddenByGraduation = 0;
    let hiddenByTargeting = 0;
    let eligibleIds = ranking.ids;
    const hasResumeScore = Boolean(resumeText?.trim());
    const beforeMatchGate = eligibleIds.length;
    eligibleIds = eligibleIds.filter((id) => rankedMatchEligible(ranking!.scores.get(id), hasResumeScore));
    const hiddenByMatchScore = beforeMatchGate - eligibleIds.length;
    if (hiddenByMatchScore > 0) {
      request.log.info(
        {
          userId: request.jwtPayload?.userId,
          hiddenByMatchScore,
          minimumMatchScore: MIN_RANKED_MATCH_SCORE,
          pool: ranking.ids.length,
        },
        'match score gate hid postings',
      );
    }
    if (gradDate || hasTargeting(jobTargeting) || candidateDegree) {
      const gateRows = eligibleIds.length
        ? await db
            .select({
              id: monitored_jobs.id,
              title: monitored_jobs.title,
              employment_type: monitored_jobs.employment_type,
            })
            .from(monitored_jobs)
            .where(inArray(monitored_jobs.id, eligibleIds))
        : [];
      /* THE SECOND TARGETING GATE, and relaxing has to reach into it too.
       *
       * boardConditions is not the only place the account's preferences narrow this list.
       * recommendationTargetingEligible re-filters the ranked pool on three things, and they do
       * NOT all sit on the same side of the preference/constraint line that relax_targeting draws:
       *
       *   recruiting period  preference. The student picked Summer 2027; a Spring 2027 posting is
       *                      a near miss, which is exactly what widening is for.
       *   title category     preference, same reasoning.
       *   minimum degree     ELIGIBILITY. A role that requires a PhD is not a worse match for a
       *                      bachelor's student, it is the wrong answer, and widening must no more
       *                      reach it than it reaches an unsendable portal family.
       *
       * So a relaxed request empties the two preferences and keeps the degree check. Leaving this
       * gate un-relaxed entirely would have made the widening useless in precisely the case it
       * exists for: a student whose saved period or category excludes everything still gets an
       * empty board, which is the one outcome the match screen cannot survive. */
      const gateTargeting = relaxTargeting
        ? { ...jobTargeting, primary_period: null, backup_period: null, categories: [] }
        : jobTargeting;
      const targetingBlocked = new Set(
        gateRows
          .filter((row) => !recommendationTargetingEligible(row, gateTargeting, candidateDegree))
          .map((row) => row.id),
      );
      if (targetingBlocked.size > 0) {
        eligibleIds = eligibleIds.filter((id) => !targetingBlocked.has(id));
        hiddenByTargeting = targetingBlocked.size;
        request.log.info(
          {
            userId: request.jwtPayload?.userId,
            hiddenByTargeting,
            primaryPeriod: jobTargeting.primary_period,
            backupPeriod: jobTargeting.backup_period,
            pool: ranking.ids.length,
          },
          'targeting gate hid postings',
        );
      }
      const blocked = new Set(
        gateRows
          .filter((row) => !targetingBlocked.has(row.id))
          .filter((row) => isBlocked(decide({ title: row.title, employment_type: row.employment_type }, gradDate)))
          .map((row) => row.id),
      );
      if (blocked.size > 0) {
        eligibleIds = eligibleIds.filter((id) => !blocked.has(id));
        hiddenByGraduation = blocked.size;
        /* LOGGED AND REPORTED, because the product hides these with nothing on screen to say so.
           A student cannot tell a role they are ineligible for from a role that does not exist, so
           a bad term parse is invisible from the UI by design. This line and the response field are
           the only places it can be caught, which makes them load-bearing rather than telemetry. */
        request.log.info(
          {
            userId: request.jwtPayload?.userId,
            hiddenByGraduation,
            gradDate,
            pool: ranking.ids.length,
          },
          'graduation gate hid postings',
        );
      }
    }

    const pageIds = eligibleIds.slice(offset, offset + limit);
    /* Rows are read fresh every time, never served from the cache, so a posting edited or pulled
       since the ranking was computed is not resurrected by it. Only the ORDER is remembered. */
    const rows = pageIds.length
      ? await db
          .select(selection)
          .from(monitored_jobs)
          .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
          /* Reapply the whole filter contract on the fresh row. A cached id must not survive a
             change to its location, role type, title family, sponsorship facts, or source status. */
          .where(and(...conditions, inArray(monitored_jobs.id, pageIds)))
      : [];

    /* Back into ranked order, and silently dropping any id that no longer resolves — a posting
       deactivated since the ranking was built is simply gone, which is the truth. */
    const byId = new Map(rows.map((row) => [row.id, row]));
    /* NULL WHEN THE STUDENT HAS SAVED NO PREFERENCES, not 0.
       preferenceFit floors at 0, and it returns 0 for two situations that are nothing alike: the
       account asked for nothing, and the account asked for things this posting has none of. Only
       this route can tell them apart, because only this route holds the targeting row. Sending 0
       for both destroyed the distinction at the only point it existed, and the client then had to
       invent one: Home drew a "0" ring labelled "fit" for accounts that had never been asked what
       they wanted, while Jobs drew nothing, so the two screens contradicted each other about the
       same posting in the same session. That is ISSUE-014 in a second shape.
       hasTargeting is the exact signal and it is already computed above for the unranked branch. */
    const scored = hasTargeting(jobTargeting);
    const jobs = pageIds
      .map((id) => byId.get(id))
      .filter((row): row is (typeof rows)[number] => row !== undefined)
      .map((row) => {
        const fit = preferenceFit(row, jobTargeting);
        return {
          ...withVerifiedCompanyLogo(row),
          match_score: ranking!.scores.get(row.id) ?? null,
          preference_score: scored ? fit.score : null,
          preference_reasons: scored ? fit.reasons : [],
          sponsorship_evidence: evidenceFor(row),
          sponsorship_country_code: sponsorshipCountryCodeFor(row),
        };
      });

    return reply.send({
      jobs,
      total: await jobCount(),
      limit,
      offset,
      has_more: eligibleIds.length > offset + limit,
      ranked: true,
      ranked_pool: eligibleIds.length,
      match_hidden: hiddenByMatchScore,
      minimum_match_score: hasResumeScore ? MIN_RANKED_MATCH_SCORE : null,
      /* How many the graduation gate removed. Not rendered anywhere by choice; it exists so the
         gate is debuggable from a response when a student says a role they expected is missing. */
      eligibility_hidden: hiddenByGraduation,
      targeting_hidden: hiddenByTargeting,
      sponsor_only: sponsorOnly,
      /* True when postings exist that were never ranked. Without this the client cannot tell the
         end of the ranking from the end of the board, and `has_more: false` at the pool boundary
         reads as "you have seen everything" when the truth is "we stopped ranking here". */
      pool_exhausted: ranking.poolExhausted,
    });
  });

  /* The same role at the same company, in one row, carrying all of its locations.
   *
   * Companies routinely post one job once per city: Lyft's "Account Manager, Strategic Healthcare
   * Partnerships" is a separate posting for San Francisco and for New York, and the board showed
   * them as two tiles that were identical apart from a line of grey text. That is the same job
   * twice as far as the reader is concerned.
   *
   * Grouped in SQL rather than in the page, because the page is paginated: merging client-side
   * would only ever merge the copies that happened to land on the same page, `total` would still
   * count the un-merged rows, and pages would hold inconsistent numbers of tiles. Grouping here
   * keeps the count, the pagination and the tiles describing the same set.
   *
   * The grouping key is (company, title, ATS family) exactly. No fuzzy matching and no
   * normalisation beyond what the employer typed: "Software Engineer II" and "Software Engineer"
   * are different jobs, and the ATS family keeps distinct apply systems from being folded together.
   *
   * Deliberately its own route rather than a flag on /jobs: that route now carries resume-based
   * ranking, a ranking cache and a pool, all of which are per-posting concepts. Threading a
   * grouped shape through them would put the board's needs inside the dashboard's hot path.
   */
  fastify.get('/jobs/grouped', { preHandler: optionalAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = listQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job filters' });
    const { q, title, location, company, remote, limit, offset, cursor } = parsed.data;
    const cursorMode = cursor !== undefined;
    /* The account's answer counts HERE TOO, and leaving it out was a real hole: this route returns
       company, title, locations and an apply link, so it is a complete substitute for the list it
       mirrors, and a declared account calling it would have been handed the unfiltered board.
       Most callers are anonymous - it serves the public board at /browse-jobs, which is
       server-rendered with no session - and for them the page's checkbox is the whole answer. */
    const sponsorOnly = (await accountRequiresSponsor(request.jwtPayload?.userId))
      || parsed.data.sponsor_only === 'true';
    const projectionMode = cursorMode
      && !q
      && !title
      && !location
      && !company
      && !remote
      && !parsed.data.employment_type
      && !sponsorOnly
      && publicVerifiedEvidenceGateEnabled();
    const [projectionState] = projectionMode
      ? await db.select()
        .from(job_board_group_projection_state)
        .where(eq(job_board_group_projection_state.singleton, true))
        .limit(1)
      : [];
    if (projectionMode && !projectionState) {
      return reply.status(503).send({
        error: 'The grouped job projection has not completed its first certified refresh',
        code: 'job_board_group_projection_unavailable',
      });
    }
    const cursorFilterHash = cursorMode ? jobBoardCursorFilterHash({
      q: q ?? null,
      title: title ?? null,
      location: location ?? null,
      company: company ?? null,
      remote: remote ?? null,
      sponsor_only: sponsorOnly,
      employment_type: parsed.data.employment_type ?? null,
      verified_evidence_gate: publicVerifiedEvidenceGateEnabled(),
      projection_generation: projectionState?.generation ?? null,
    }) : null;
    const cursorSecret = cursorMode ? jobBoardCursorSigningSecret() : null;
    if (cursorMode && !cursorSecret) {
      return reply.status(503).send({ error: 'Job board cursor signing is not configured' });
    }
    let cursorAsOf: Date | null = null;
    let cursorKey: GroupedJobsCursorKey | null = null;
    let cursorTotals: { total: number; postingsTotal: number } | null = null;
    if (cursorMode) {
      if (cursor === JOB_BOARD_CURSOR_START) {
        cursorAsOf = projectionState?.projection_as_of ?? await cursorSnapshotTime();
      } else {
        try {
          const decoded = decodeJobBoardCursor(
            cursor!,
            { route: 'grouped', filterHash: cursorFilterHash! },
            cursorSecret!,
          );
          if (decoded.route !== 'grouped') throw new JobBoardCursorError('mismatch', 'Job board cursor route mismatch');
          cursorAsOf = decoded.asOf;
          cursorKey = decoded.key;
          cursorTotals = {
            total: decoded.total,
            postingsTotal: decoded.postingsTotal,
          };
        } catch (error) {
          if (projectionMode
            && error instanceof JobBoardCursorError
            && error.code === 'mismatch') {
            return cursorErrorResponse(new JobBoardCursorError(
              'mismatch',
              'The grouped job projection refreshed; restart this cursor traversal',
            ), reply);
          }
          return cursorErrorResponse(error, reply);
        }
      }
    }
    const whereConditions = boardConditions({
      ...parsed.data,
      employmentType: parsed.data.employment_type,
      sponsorOnly,
      asOf: cursorAsOf ?? undefined,
    });
    if (cursorAsOf) whereConditions.push(lte(monitored_jobs.first_seen_at, cursorAsOf));
    const where = and(...whereConditions);

    if (projectionMode && projectionState) {
      const zeroRank = sql<number>`0::integer`;
      const seek = cursorKey ? cursorAfterPredicate(cursorKey, {
        qRank: zeroRank,
        titleRank: zeroRank,
        postedAt: sql`${job_board_group_projection.posted_at}`,
        firstSeenAt: sql`${job_board_group_projection.first_seen_at}`,
        tieId: sql`${job_board_group_projection.cursor_tie_id}`,
      }) : null;
      const projectedRows = await db
        .select()
        .from(job_board_group_projection)
        .where(and(
          eq(job_board_group_projection.generation, projectionState.generation),
          ...(seek ? [seek] : []),
        ))
        .orderBy(
          sql`${job_board_group_projection.posted_at} desc nulls last`,
          desc(job_board_group_projection.first_seen_at),
          desc(job_board_group_projection.cursor_tie_id),
        )
        .limit(limit + 1);
      const pageRows = projectedRows.slice(0, limit);
      const tail = pageRows.at(-1);
      const totals = cursorTotals ?? {
        total: projectionState.surfaced_grouped_roles,
        postingsTotal: projectionState.surfaced_postings,
      };
      const nextCursor = projectedRows.length > limit && tail
        ? encodeJobBoardCursor({
          route: 'grouped',
          asOf: cursorAsOf!,
          filterHash: cursorFilterHash!,
          total: totals.total,
          postingsTotal: totals.postingsTotal,
          key: {
            q_rank: 0,
            title_rank: 0,
            posted_at: tail.posted_at ? cursorDate(tail.posted_at) : null,
            first_seen_at: cursorDate(tail.first_seen_at),
            tie_id: tail.cursor_tie_id,
          },
        }, cursorSecret!)
        : null;

      return applyBoardCacheHeaders(request, reply).send({
        jobs: pageRows.map(({
          generation: _generation,
          cursor_tie_id: _cursorTieId,
          posting_offers,
          employer_sponsors,
          ...row
        }) => {
          const sponsorship = groupedSponsorshipFor({
            postingOffers: posting_offers as GroupedPostingOfferContext[],
            employerFilesH1b: employer_sponsors,
          });
          return {
            ...withVerifiedCompanyLogo(row, cursorAsOf!),
            sponsorship_evidence: sponsorship.evidence,
            sponsorship_country_codes: sponsorship.countryCodes,
          };
        }),
        total: totals.total,
        postings_total: totals.postingsTotal,
        limit,
        offset: 0,
        has_more: projectedRows.length > limit,
        next_cursor: nextCursor,
        pagination_mode: 'cursor',
        sponsor_only: false,
      });
    }

    /* One row per (company, title, ATS family). The aggregates are chosen so the row still describes
       something true of the whole group: the newest timestamps, every distinct location, and the
       apply link belonging to the newest posting in the group rather than an arbitrary member. */
    const groupedSelection = {
        id: sql<string>`(array_agg(${monitored_jobs.id} order by ${monitored_jobs.posted_at} desc nulls last, ${monitored_jobs.id} desc))[1]`,
        company_name: monitored_jobs.company_name,
        title: monitored_jobs.title,
        locations: sql<string[]>`array_remove(array_agg(distinct ${monitored_jobs.location}), null)`,
        openings: sql<number>`count(*)::int`,
        apply_url: sql<string>`(array_agg(${monitored_jobs.apply_url} order by ${monitored_jobs.posted_at} desc nulls last, ${monitored_jobs.id} desc))[1]`,
        remote: sql<boolean>`bool_or(${monitored_jobs.remote})`,
        posted_at: sql<string | null>`max(${monitored_jobs.posted_at})`,
        first_seen_at: sql<string>`min(${monitored_jobs.first_seen_at})`,
        ats_name: career_page_sources.ats_name,
        career_url: sql<string>`min(${career_page_sources.career_url})`,
        /* Pick every evidence field from the same, most recently verified source. array_agg keeps
           nulls, unlike min(), so a direct-URL source cannot accidentally inherit another source's
           domain and present a hybrid proof that never existed. */
        company_domain: sql<string | null>`(array_agg(${career_page_sources.company_domain} order by ${career_page_sources.logo_verified_at} desc, ${career_page_sources.id} desc))[1]`,
        company_logo_url: sql<string | null>`(array_agg(${career_page_sources.company_logo_url} order by ${career_page_sources.logo_verified_at} desc, ${career_page_sources.id} desc))[1]`,
        logo_verification_status: sql<string>`(array_agg(${career_page_sources.logo_verification_status} order by ${career_page_sources.logo_verified_at} desc, ${career_page_sources.id} desc))[1]`,
        logo_verification_method: sql<string | null>`(array_agg(${career_page_sources.logo_verification_method} order by ${career_page_sources.logo_verified_at} desc, ${career_page_sources.id} desc))[1]`,
        logo_verified_at: sql<string | null>`max(${career_page_sources.logo_verified_at})`,
        /* Pay and job type, aggregated with the same caution as sponsorship below: a group is one
           role open in several cities, and those copies routinely disagree.
           A range is shown only when every member that published one used the SAME currency and the
           SAME period - a role paying USD in Austin and CAD in Toronto has no single range, and
           spanning them would invent one. Where they do agree, the span runs lowest min to highest
           max, so the row is true of every posting inside it.
           count(distinct) ignores nulls, so members that published nothing neither block the range
           nor get counted into it: the row reports what was stated, by the postings that stated it.
           Job type is the same test with no arithmetic - one distinct value or nothing, so a group
           mixing an internship with a full-time posting of the same title shows no chip rather than
           picking whichever the aggregate happened to reach first. */
        salary_min: sql<number | null>`case when count(distinct ${monitored_jobs.salary_currency}) = 1 and count(distinct ${monitored_jobs.salary_interval}) = 1 then min(${monitored_jobs.salary_min}) end`,
        salary_max: sql<number | null>`case when count(distinct ${monitored_jobs.salary_currency}) = 1 and count(distinct ${monitored_jobs.salary_interval}) = 1 then max(${monitored_jobs.salary_max}) end`,
        salary_currency: sql<string | null>`case when count(distinct ${monitored_jobs.salary_currency}) = 1 and count(distinct ${monitored_jobs.salary_interval}) = 1 then min(${monitored_jobs.salary_currency}) end`,
        salary_interval: sql<string | null>`case when count(distinct ${monitored_jobs.salary_currency}) = 1 and count(distinct ${monitored_jobs.salary_interval}) = 1 then min(${monitored_jobs.salary_interval}) end`,
        employment_type: sql<string | null>`case when count(distinct ${monitored_jobs.employment_type}) = 1 then min(${monitored_jobs.employment_type}) end`,
        /* Keep each affirmative offer attached to its own location and persisted clause scope.
           Aggregating all locations beside one offers_any flag made a Berlin refusal inherit a US
           offer, and made a Berlin H-1B boilerplate clause look like German sponsorship. */
        posting_offers: sql<GroupedPostingOfferContext[]>`coalesce(
          jsonb_agg(jsonb_build_object(
            'sponsorship_scope', ${monitored_jobs.sponsorship_scope},
            'job_country', ${monitored_jobs.job_country},
            'location', ${monitored_jobs.location},
            'raw_json', ${monitored_jobs.raw_json}
          )) filter (where ${monitored_jobs.sponsorship_status} = 'offers'),
          '[]'::jsonb
        )`,
        employer_sponsors: sql<boolean>`bool_or(
          ${career_page_sources.sponsor_employer_id} is not null
          and ${career_page_sources.portal_name_mismatch} = false
          and ${monitored_jobs.sponsorship_status} <> 'refuses'
          and ${monitored_jobs.job_country} <> 'non_us'
        )`,
      };

    const countGroupedBoard = () => db.execute<{ total: number; postings_total: number }>(sql`
      select
        count(*)::int as postings_total,
        count(distinct (
          ${monitored_jobs.company_name},
          ${monitored_jobs.title},
          ${career_page_sources.ats_name}
        ))::int as total
      from ${monitored_jobs}
      inner join ${career_page_sources} on ${monitored_jobs.source_id} = ${career_page_sources.id}
      where ${where}
    `);

    if (cursorMode) {
      const qRank = q
        ? sql<number>`case when min(${monitored_jobs.title}) ilike ${`%${q}%`} then 0 else 1 end`
        : sql<number>`0::integer`;
      const titleRank = title
        ? sql<number>`case when min(${monitored_jobs.title}) ilike ${`%${title}%`} then 0 else 1 end`
        : sql<number>`0::integer`;
      const postedAt = sql<Date | null>`max(${monitored_jobs.posted_at})`;
      const firstSeenAt = sql<Date>`min(${monitored_jobs.first_seen_at})`;
      const tieId = sql<string>`(array_agg(${monitored_jobs.id} order by ${monitored_jobs.id} asc))[1]`;
      const seek = cursorKey ? cursorAfterPredicate({
        ...cursorKey,
        tie_id: cursorKey.tie_id,
      }, {
        qRank,
        titleRank,
        postedAt,
        firstSeenAt,
        tieId,
      }) : null;
      const cursorSelection = {
        ...groupedSelection,
        cursor_q_rank: qRank,
        cursor_title_rank: titleRank,
        cursor_tie_id: tieId,
      };
      const cursorRows = seek
        ? await db
          .select(cursorSelection)
          .from(monitored_jobs)
          .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
          .where(where)
          .groupBy(monitored_jobs.company_name, monitored_jobs.title, career_page_sources.ats_name)
          .having(seek)
          .orderBy(
            qRank,
            titleRank,
            sql`${postedAt} desc nulls last`,
            sql`${firstSeenAt} desc`,
            sql`${tieId} desc`,
          )
          .limit(limit + 1)
        : await db
          .select(cursorSelection)
          .from(monitored_jobs)
          .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
          .where(where)
          .groupBy(monitored_jobs.company_name, monitored_jobs.title, career_page_sources.ats_name)
          .orderBy(
            qRank,
            titleRank,
            sql`${postedAt} desc nulls last`,
            sql`${firstSeenAt} desc`,
            sql`${tieId} desc`,
          )
          .limit(limit + 1);
      const pageRows = cursorRows.slice(0, limit);
      const tail = pageRows.at(-1);
      const counted = cursorTotals ? null : await countGroupedBoard();
      const countRow = counted?.rows[0];
      const totals = cursorTotals ?? {
        total: Number(countRow?.total ?? 0),
        postingsTotal: Number(countRow?.postings_total ?? 0),
      };
      const nextCursor = cursorRows.length > limit && tail
        ? encodeJobBoardCursor({
          route: 'grouped',
          asOf: cursorAsOf!,
          filterHash: cursorFilterHash!,
          total: totals.total,
          postingsTotal: totals.postingsTotal,
          key: {
            q_rank: Number(tail.cursor_q_rank) as 0 | 1,
            title_rank: Number(tail.cursor_title_rank) as 0 | 1,
            posted_at: tail.posted_at ? cursorDate(tail.posted_at) : null,
            first_seen_at: cursorDate(tail.first_seen_at),
            tie_id: tail.cursor_tie_id,
          },
        }, cursorSecret!)
        : null;

      return applyBoardCacheHeaders(request, reply).send({
        jobs: pageRows.map(({
          posting_offers,
          employer_sponsors,
          cursor_q_rank: _qRank,
          cursor_title_rank: _titleRank,
          cursor_tie_id: _tieId,
          ...row
        }) => {
          const sponsorship = groupedSponsorshipFor({
            postingOffers: posting_offers,
            employerFilesH1b: employer_sponsors,
          });
          return {
            ...withVerifiedCompanyLogo(row, cursorAsOf!),
            sponsorship_evidence: sponsorship.evidence,
            sponsorship_country_codes: sponsorship.countryCodes,
          };
        }),
        total: totals.total,
        postings_total: totals.postingsTotal,
        limit,
        offset: 0,
        has_more: cursorRows.length > limit,
        next_cursor: nextCursor,
        pagination_mode: 'cursor',
        sponsor_only: sponsorOnly,
      });
    }

    const rows = await db
      .select(groupedSelection)
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(where)
      .groupBy(monitored_jobs.company_name, monitored_jobs.title, career_page_sources.ats_name)
      .orderBy(
        /* Same relevance-then-recency rule as /jobs: a title hit outranks a body-only hit, or the
           first page of a search reads as unrelated. */
        ...(title ? [sql`case when min(${monitored_jobs.title}) ilike ${`%${title}%`} then 0 else 1 end`] : []),
        /* Scatter across employers, same rule as /jobs but over the grouped rows: the window runs
           on the aggregate, so it numbers each company's ROLES rather than its postings, which is
           what a reader of this board counts. */
        ...(parsed.data.company
          ? []
          : [sql`row_number() over (partition by lower(${monitored_jobs.company_name}) order by max(${monitored_jobs.posted_at}) desc nulls last, min(${monitored_jobs.first_seen_at}) desc)`]),
        sql`max(${monitored_jobs.posted_at}) desc nulls last`,
        sql`min(${monitored_jobs.first_seen_at}) desc`,
      )
      .limit(limit + 1)
      .offset(offset);

    /* count of GROUPS, not of postings. Counting rows here would print a number the page cannot
       show, which is the same lie as the competitor's 644,546. */
    const counted = await countGroupedBoard();

    const countRow = counted.rows[0];

    return applyBoardCacheHeaders(request, reply).send({
      jobs: rows.slice(0, limit).map(({ posting_offers, employer_sponsors, ...row }) => {
        const sponsorship = groupedSponsorshipFor({
          postingOffers: posting_offers,
          employerFilesH1b: employer_sponsors,
        });
        return {
          ...withVerifiedCompanyLogo(row),
          sponsorship_evidence: sponsorship.evidence,
          sponsorship_country_codes: sponsorship.countryCodes,
        };
      }),
      total: Number(countRow?.total ?? 0),
      postings_total: Number(countRow?.postings_total ?? 0),
      limit,
      offset,
      has_more: rows.length > limit,
      sponsor_only: sponsorOnly,
    });
  });

  /* Suggestions for the board's three search fields.
   *
   * The fields accept free text too, so this is a convenience rather than a controlled vocabulary:
   * it exists so a job seeker who does not already know that we watch "Qube Research &
   * Technologies" can find it, and so the city field offers real cities rather than making them
   * guess our formatting. Cities and titles are the most common ones, because the full lists are
   * thousands long and nobody scrolls a datalist that size.
   */
  fastify.get('/jobs/facets', { preHandler: optionalAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    /* The suggestions have to describe the board the visitor is actually looking at. Offering
       "GitLab" to someone browsing with the sponsorship filter on sends them to a search that
       returns nothing, and reads as a broken board rather than as a company we cannot confirm.
       The account's standing answer counts here too, for the same reason it counts on the list.
       Parsed on its OWN rather than off listQuerySchema: this route reads no other filter, so
       validating the whole query object meant an unrelated bad parameter (limit=500) failed the
       parse and silently served unfiltered suggestions - the filter dropping out because of a
       mistake in a field this route does not even look at. */
    const facetQuery = z.object({
      sponsor_only: z.enum(['true', 'false']).optional(),
      /* Job type belongs here for exactly the reason the comment above gives. Filtered to
         Internship the board is ~2% of its size, so suggesting the top-50 companies of the FULL
         board would send almost every click to an empty result - the same broken-board reading
         the sponsorship filter was added here to avoid, only worse because the ratio is bigger. */
      employment_type: z
        .enum(['Full-time', 'Part-time', 'Internship', 'Apprenticeship', 'Contract'])
        .optional(),
      /* Adds company_counts: EVERY company with its live row count, for measuring the board rather
         than for filling a dropdown. Off by default, so the response the website reads is unchanged.

         This exists because the only way to measure per-company coverage used to be paging the
         whole board through GET /jobs, which returns full rows including 600 characters of
         description each. That is ~17 MB per pass for two columns' worth of information, and on
         2026-08-04 the project exhausted its Neon data transfer quota, which took every
         database-backed route down with it (see scripts/check-logo-coverage.mjs). One grouped
         count is ~15 KB and is also a single consistent snapshot, so the reading cannot be skewed
         by the poller writing underneath a paged scan. */
      counts: z.enum(['true', 'false']).optional(),
    }).safeParse(request.query).data;
    const sponsorOnly = (await accountRequiresSponsor(request.jwtPayload?.userId))
      || facetQuery?.sponsor_only === 'true';
    const where = and(...boardConditions({
      sponsorOnly,
      employmentType: facetQuery?.employment_type,
    }));
    /* FIFTY companies, ranked by how much of the board they actually account for
       (Mehek, 2026-07-29). Used to be 202 companies alphabetically: a dropdown
       nobody scrolls, opening on "AQR" rather than on the employers most of the
       board belongs to. */
    const TOP = 50;
    /* Cities get a taller list than companies. A single global company can
       already cover 50 companies' worth of board share, but a real, searched-for
       city like Dubai (~70 postings once every spelling and every compound
       "London | Dubai | Singapore" listing is counted correctly - see below)
       sits well past the 50th slot, behind a long tail of individually smaller
       US metros. 150 is the smallest round number past where that tail with
       genuine international demand starts showing up, without opening the list
       on someone's one-off "Denver, CO - Hybrid" (2026-08-29, Mehek reported
       Dubai never suggesting despite being on the board). */
    const TOP_LOCATIONS = 150;

    const companies = await db
      .select({ v: monitored_jobs.company_name, n: sql<number>`count(*)::int` })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(where)
      .groupBy(monitored_jobs.company_name)
      .orderBy(sql`count(*) desc`)
      .limit(TOP);

    /* Deliberately a SECOND query rather than dropping the limit above and slicing in JS. The
       dropdown path runs on every board visit and the measurement path runs from CI, so the common
       case keeps reading exactly 50 rows and only a caller that asks pays for the full grouping. */
    const companyCounts = facetQuery?.counts === 'true'
      ? await db
        .select({ v: monitored_jobs.company_name, n: sql<number>`count(*)::int` })
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(where)
        .groupBy(monitored_jobs.company_name)
        .orderBy(sql`count(*) desc`)
      : null;

    /* The production logo gate needs the same weighted inventory, split by the exact employer
       board that proves identity. Company name alone is insufficient: Block is the canonical
       example, where guessing the name finds block.co while its Greenhouse board proves block.xyz.
       Only returned to the explicit counts=true measurement request.

       The verifier's evidence rides along per source. The coverage check used to prove coverage
       by driving the website's live resolver once per source, and 64 concurrent resolutions
       through one container flaked a different ~14% of lookups on every run (measured 2026-09-01:
       83.20% then 86.33% with ZERO overlap between the two runs' miss lists, while every named
       miss resolved serially). Handing the check the evidence URL lets it probe the asset itself,
       which is the fact the gate exists to prove, at whatever concurrency the CDNs tolerate. */
    const companyLogoSources = facetQuery?.counts === 'true'
      ? await db
        .select({
          company_name: monitored_jobs.company_name,
          career_url: career_page_sources.career_url,
          company_logo_url: career_page_sources.company_logo_url,
          company_domain: career_page_sources.company_domain,
          logo_verification_status: career_page_sources.logo_verification_status,
          rows: sql<number>`count(*)::int`,
        })
        .from(monitored_jobs)
        .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
        .where(where)
        .groupBy(
          monitored_jobs.company_name,
          career_page_sources.career_url,
          career_page_sources.company_logo_url,
          career_page_sources.company_domain,
          career_page_sources.logo_verification_status,
        )
        .orderBy(sql`count(*) desc`)
      : null;

    /* Cities, not location strings.
       An employer's `location` is whatever they typed: often a list ("Boston;
       New York City; Pennsylvania"), often carrying a country ("San Mateo, CA,
       United States"), and the same place spelled three ways. Grouping the raw
       column offered "United States" as a city and spent three of the fifty
       slots on New York. A wide slice is read here and ranked in rankCities,
       which merges the spellings — see src/lib/cities.ts for why that judgement
       lives in a tested function rather than in SQL.

       NO row limit here on purpose, even though there used to be one (LIMIT 400).
       Global employers post one row with a location listing a dozen offices
       ("London | Dubai | Singapore | ..."), so any one city's raw string sits
       far down the by-count ordering even when that city has real volume once
       every listing mentioning it is added up. A row cap taken before rankCities
       ever runs throws away exactly the rows a real, less-common city depends on
       to be counted at all: measured live, this is why Dubai (68 postings) never
       reached the suggestion list despite being on the board. Safe to leave
       unbounded: distinct `location` values are ~4,200 rows, a few hundred KB
       total, nothing like the per-row description scan that hit the Neon egress
       quota on 2026-08-04 (src/lib/egressBudget.ts). */
    const locationRows = await db
      .select({ location: monitored_jobs.location, n: sql<number>`count(*)::int` })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(where)
      .groupBy(monitored_jobs.location)
      .orderBy(sql`count(*) desc`);

    return applyBoardCacheHeaders(request, reply).send({
      companies: companies.map((r) => r.v).filter(Boolean),
      locations: rankCities(locationRows, TOP_LOCATIONS),
      /* Only present when asked for, so the default response stays byte-identical for the website.
         `rows` is what the board actually holds per employer, which is what a coverage figure has
         to be weighted by: one employer with 300 postings matters 300 times more than one with a
         single posting. */
      ...(companyCounts
        ? {
          company_counts: companyCounts
            .filter((r) => r.v)
            .map((r) => ({ company_name: r.v, rows: r.n })),
        }
        : {}),
      ...(companyLogoSources ? { company_logo_sources: companyLogoSources } : {}),
      /* `titles` is gone on purpose. It returned the board's most common RAW
         posting titles — "Senior Product Manager - Network Path" — which is not
         what a person types into a field labelled Job title. The board now
         offers a curated vocabulary of role families it holds in the website
         (lib/job-titles.ts), so there is nothing useful for this endpoint to
         say about titles. */
    });
  });

  fastify.get('/jobs/:id', { preHandler: optionalAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = jobParamsSchema.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid job id' });
    /* Same reasoning as the autonomy rule below, applied to sponsorship: the list is not the only
       way into a posting. A bookmark, a shared link, or a dashboard row cached before the filter
       turned on all arrive here, and this is the page where somebody commits to applying. Signed
       out there is no account to have declared anything, so the detail page stays open - the promise
       is about a person's board, not about hiding postings from the world. */
    const sponsorOnly = await accountRequiresSponsor(request.jwtPayload?.userId);
    const rows = await db
      .select({
        id: monitored_jobs.id,
        company_name: monitored_jobs.company_name,
        title: monitored_jobs.title,
        location: monitored_jobs.location,
        department: monitored_jobs.department,
        employment_type: monitored_jobs.employment_type,
        salary_min: monitored_jobs.salary_min,
        salary_max: monitored_jobs.salary_max,
        salary_currency: monitored_jobs.salary_currency,
        salary_interval: monitored_jobs.salary_interval,
        description: monitored_jobs.description,
        apply_url: monitored_jobs.apply_url,
        posting_url: monitored_jobs.posting_url,
        remote: monitored_jobs.remote,
        posted_at: monitored_jobs.posted_at,
        first_seen_at: monitored_jobs.first_seen_at,
        is_active: monitored_jobs.is_active,
        ats_name: career_page_sources.ats_name,
        career_url: career_page_sources.career_url,
        company_domain: career_page_sources.company_domain,
        company_logo_url: career_page_sources.company_logo_url,
        logo_verification_status: career_page_sources.logo_verification_status,
        logo_verification_method: career_page_sources.logo_verification_method,
        logo_verified_at: career_page_sources.logo_verified_at,
        sponsorship_status: monitored_jobs.sponsorship_status,
        sponsorship_scope: monitored_jobs.sponsorship_scope,
        employer_sponsors: sql<boolean>`${career_page_sources.sponsor_employer_id} is not null`,
        job_country: monitored_jobs.job_country,
        portal_name_mismatch: career_page_sources.portal_name_mismatch,
        raw_json: monitored_jobs.raw_json,
      })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(and(
        eq(monitored_jobs.id, parsed.data.id),
        /* Same complete rule as the list route. Without it a job excluded for stale activity,
           missing logo evidence, or an unsendable portal stays reachable by bookmark. */
        ...boardConditions({ sponsorOnly }),
      ))
      .limit(1);
    if (!rows[0]) return reply.status(404).send({ error: 'Job not found' });
    return reply.send({ job: {
      ...withVerifiedCompanyLogo(rows[0]),
      sponsorship_evidence: evidenceFor(rows[0]),
      sponsorship_country_code: sponsorshipCountryCodeFor(rows[0]),
    } });
  });

  fastify.post('/internal/job-monitor/sources', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireOperator(request, reply)) return;
    const parsed = sourcesBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid career page sources', detail: parsed.error.issues });
    if (parsed.data.sources.some((source) => source.logo_verification_status === 'verified')) {
      return reply.status(400).send({
        error: 'Verified logo evidence can only be minted by the autonomous verifier',
      });
    }
    await upsertSources(parsed.data.sources);
    return reply.status(204).send();
  });

  /* Promote provisional catalog domains only after independent, current proof.
   *
   * This is a separate bounded drain from job polling because proving a brand can require a
   * homepage request plus an image request. A source stays invisible until this succeeds. Failed
   * candidates remain excluded and are retried after seven days, while successful proof persists
   * the exact image URL shown on every job tile. */
  fastify.get('/internal/job-monitor/verify-logos', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireOperator(request, reply)) return;
    const parsed = logoVerificationQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid logo-verification query', detail: parsed.error.issues });
    }
    const releaseMonitorLock = await tryAcquireJobMonitorLock();
    if (!releaseMonitorLock) {
      return reply.status(409).send({
        error: 'A job-monitor run is already in progress. Retry after it finishes.',
        verification_complete: false,
      });
    }
    try {
    const now = Date.now();
    const retryBefore = new Date(now - FAILED_LOGO_RETRY_MS);
    const transientRetryBefore = new Date(now - TRANSIENT_LOGO_RETRY_MS);
    const recheckBefore = new Date(now - VERIFIED_LOGO_RECHECK_DAYS * 24 * 60 * 60 * 1000);
    const candidateState = and(
      eq(career_page_sources.enabled, true),
      isNotNull(career_page_sources.logo_verification_method),
      or(
        eq(career_page_sources.logo_verification_status, 'unverified'),
        eq(career_page_sources.logo_verification_status, 'failed'),
        and(eq(career_page_sources.logo_verification_status, 'verified'),
          or(
            isNull(career_page_sources.logo_verified_at),
            lt(career_page_sources.logo_verified_at, recheckBefore),
          ),
        ),
      ),
    )!;
    /* The persisted reason remains exact and queryable. Only known provider-pressure and transport
       classes enter the short retry lane; permanent identity and asset failures keep the weekly
       retry cadence. Composite ATS/homepage reasons retain the same component boundaries. */
    const transientFailure = sql<boolean>`coalesce(${career_page_sources.logo_verification_error}, '') ~
      '(^|[;:])(timeout|empty_response|verification_failed|network_(EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z0-9_]+)|http_(0|408|425|429|5[0-9]{2}))($|;)'`;
    const eligible = and(
      candidateState,
      or(
        isNull(career_page_sources.logo_last_checked_at),
        and(
          transientFailure,
          lt(career_page_sources.logo_last_checked_at, transientRetryBefore),
        ),
        and(
          sql<boolean>`not (${transientFailure})`,
          lt(career_page_sources.logo_last_checked_at, retryBefore),
        ),
      ),
    )!;
    /* Claim before selection so a second API replica excludes Crelate while this request is in
       flight. Open circuits return no claim. Closed and half-open states both permit exactly one
       Crelate candidate, while every other ATS family remains independently selectable. */
    const crelateClaim = await acquireCrelateLogoVerificationClaim(new Date(now));
    const selectionEligible = crelateClaim
      ? eligible
      : and(eligible, ne(career_page_sources.ats_name, 'crelate'))!;
    /* Provider quotas are applied in SQL before the global request limit. JavaScript applies the
       same bounds again as defense in depth, but it never receives a single-provider prefix that
       could starve the other seven ATS families. */
    const selectedCandidates = await selectProviderBalancedLogoVerificationCandidates(
      selectionEligible,
      parsed.data.limit,
    );
    const candidates = boundedLogoVerificationCandidates(selectedCandidates);
    const selectedCrelate = candidates.some((candidate) => candidate.ats_name === 'crelate');
    if (crelateClaim && !selectedCrelate) {
      await releaseCrelateLogoVerificationClaim(crelateClaim.token, new Date());
    }

    let verified = 0;
    let failed = 0;
    let gracePreserved = 0;
    let transientDeferred = 0;
    const failureSummaries: Array<{
      source_id: string;
      company: string;
      ats_name: string;
      error: string;
      transient: boolean;
      grace_preserved: boolean;
      crelate_429_exhausted: boolean;
    }> = [];
    await runProviderAwareLogoQueue(candidates, async (candidate, signal) => {
        const candidateMethod = candidate.logo_verification_method;
        if (!candidateMethod) {
          if (candidate.ats_name === 'crelate' && crelateClaim) {
            await releaseCrelateLogoVerificationClaim(crelateClaim.token, new Date());
          }
          return;
        }
        let result: {
          verified: true;
          companyName: string;
          companyLogoUrl: string;
          method: string;
          providerIdentity: true;
        } | { verified: false; reason: string };
        try {
          result = await retryTransientLogoVerification(async () => {
          const atsResult = await verifyAtsSourceBranding({
            company_name: candidate.company_name,
            ats_name: candidate.ats_name as SupportedJobBoard,
            board_token: candidate.board_token,
            identity_mode: sourceLogoIdentityMode(candidateMethod),
          }, fetch, (asset) => persistDurableAtsLogo(asset, undefined, signal), { signal });
          if (atsResult.verified) {
            return {
              verified: true,
              companyName: atsResult.company_name,
              companyLogoUrl: atsResult.company_logo_url,
              method: atsResult.method,
              providerIdentity: true,
            };
          }
          if (candidate.company_domain && atsResult.identity_verified && atsResult.company_name) {
            const homepageResult = await verifyCatalogSourceLogo({
              company_name: atsResult.company_name,
              company_domain: candidate.company_domain,
            }, { signal });
            return homepageResult.verified
              ? {
                verified: true,
                companyName: atsResult.company_name,
                companyLogoUrl: homepageResult.company_logo_url,
                method: VERIFIED_ATS_BOUND_HOMEPAGE_LOGO_METHOD,
                providerIdentity: true,
              }
              : {
                verified: false,
                reason: `ats:${atsResult.reason};homepage:${homepageResult.reason}`,
              };
          }
          return { verified: false, reason: `ats:${atsResult.reason}` };
        }, {
          /* ATS proof followed by bounded homepage redirects and icon candidates can consume about
             three minutes in the worst case. Keep one proof attempt inside this HTTP request. A
             classified transient is persisted and retried by the worker in the same drain after
             the short retry interval, so dropping in-request retries does not drop the work. */
          attempts: 1,
        });
        } catch (error) {
          if (candidate.ats_name === 'crelate' && crelateClaim) {
            await releaseCrelateLogoVerificationClaim(crelateClaim.token, new Date());
          }
          throw error;
        }
        const checkedAt = new Date();
        const crelateTransition = candidate.ats_name === 'crelate' && !result.verified
          ? crelateLogoFailureTransition(
            candidate.logo_provider_429_attempts,
            candidate.logo_verification_error,
            result.reason,
          )
          : null;

        if (candidate.ats_name === 'crelate') {
          if (!crelateClaim) {
            throw new Error('Crelate logo verification ran without the durable provider claim');
          }
          const circuitUpdated = crelateTransition?.opensCircuit
            ? await openCrelateLogoVerificationCircuit(crelateClaim.token, checkedAt)
            : await closeCrelateLogoVerificationCircuit(crelateClaim.token, checkedAt);
          if (!circuitUpdated) {
            throw new Error('Crelate logo verification lost its durable provider claim');
          }
        }

        const unchanged = and(
          eq(career_page_sources.id, candidate.id),
          eq(career_page_sources.company_name, candidate.company_name),
          eq(career_page_sources.logo_verification_status, candidate.logo_verification_status),
          eq(career_page_sources.logo_verification_method, candidateMethod),
          sql`${career_page_sources.company_domain} is not distinct from ${candidate.company_domain}`,
          sql`${career_page_sources.logo_last_checked_at} is not distinct from ${candidate.logo_last_checked_at}`,
          eq(career_page_sources.logo_provider_429_attempts, candidate.logo_provider_429_attempts),
          sql`${career_page_sources.logo_verification_error} is not distinct from ${candidate.logo_verification_error}`,
        );
        if (result.verified) {
          const certificationIdentityChanged = normalizeEmployerCertificationIdentity(candidate.company_name)
            !== normalizeEmployerCertificationIdentity(result.companyName);
          const promoted = await db.transaction(async (tx) => {
            const [sponsor] = await tx.select({ id: sponsor_employers.id })
              .from(sponsor_employers)
              .where(eq(sponsor_employers.normalized_name, normalizeEmployerName(result.companyName)))
              .limit(1);
            const rows = await tx.update(career_page_sources).set({
              company_name: result.companyName,
              company_logo_url: result.companyLogoUrl,
              logo_verification_status: 'verified',
              logo_verification_method: result.method,
              logo_verified_at: checkedAt,
              logo_last_checked_at: checkedAt,
              logo_verification_error: null,
              logo_provider_429_attempts: 0,
              sponsor_employer_id: sponsor?.id ?? null,
              portal_company_name: result.providerIdentity
                ? result.companyName
                : candidate.portal_company_name,
              portal_name_mismatch: result.providerIdentity
                ? false
                : candidate.portal_name_mismatch,
            }).where(unchanged).returning({ id: career_page_sources.id });
            if (rows.length === 0) return false;
            await tx.update(monitored_jobs).set({
              company_name: result.companyName,
              /* The employer identity is part of certification. A rename must be repolled before
                 any old hash can re-enter the unique inventory count. A routine logo recheck with
                 the same normalized identity must retain current-drain certification. */
              ...(certificationIdentityChanged ? { certification_fingerprint: null } : {}),
            })
              .where(eq(monitored_jobs.source_id, candidate.id));
            return true;
          });
          if (promoted) verified += 1;
          return;
        }

        const proofStillFresh = candidate.logo_verification_status === 'verified'
          && candidate.logo_verified_at !== null
          && candidate.logo_verified_at.getTime()
            >= checkedAt.getTime() - VERIFIED_LOGO_EVIDENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
        const terminalCrelate429 = crelateTransition?.exhausted ?? false;
        const persistedReason = crelateTransition?.reason ?? result.reason;
        const transient = !terminalCrelate429
          && isTransientLogoVerificationReason(persistedReason);
        const rows = await db.update(career_page_sources).set({
          /* A transient failure is not contrary brand evidence. Keep the prior proof fields, while
             the public freshness predicate independently excludes an expired proof. */
          company_logo_url: terminalCrelate429
            ? null
            : transient || proofStillFresh ? undefined : null,
          logo_verification_status: terminalCrelate429
            ? 'failed'
            : transient
            ? candidate.logo_verification_status
            : proofStillFresh ? 'verified' : 'failed',
          logo_verified_at: terminalCrelate429 ? null : undefined,
          logo_last_checked_at: checkedAt,
          logo_verification_error: persistedReason,
          logo_provider_429_attempts: crelateTransition?.attempts
            ?? candidate.logo_provider_429_attempts,
        }).where(unchanged).returning({ id: career_page_sources.id });
        if (rows.length > 0) {
          failed += 1;
          if (transient) transientDeferred += 1;
          if (proofStillFresh) gracePreserved += 1;
          failureSummaries.push({
            source_id: candidate.id,
            company: candidate.company_name,
            ats_name: candidate.ats_name,
            error: persistedReason,
            transient,
            grace_preserved: proofStillFresh,
            crelate_429_exhausted: terminalCrelate429,
          });
        }
    });

    const scheduledTransient = and(
      candidateState,
      transientFailure,
      isNotNull(career_page_sources.logo_last_checked_at),
      gte(career_page_sources.logo_last_checked_at, transientRetryBefore),
    )!;
    const queueCheckedAt = new Date();
    const crelateBlock = await readCrelateLogoVerificationBlock(queueCheckedAt);
    const providerBlockedPending = crelateBlock.blocked
      ? and(
        eq(career_page_sources.ats_name, 'crelate'),
        candidateState,
        or(eligible, scheduledTransient),
      )!
      : sql<boolean>`false`;
    const dueAfterProviderCircuit = crelateBlock.blocked
      ? and(eligible, ne(career_page_sources.ats_name, 'crelate'))!
      : eligible;
    const scheduledAfterProviderCircuit = or(scheduledTransient, providerBlockedPending)!;
    const [queue] = await db.select({
      due: sql<number>`count(*) filter (where ${dueAfterProviderCircuit})::int`,
      scheduled_transient: sql<number>`count(*) filter (where ${scheduledAfterProviderCircuit})::int`,
      scheduled_crelate_circuit: sql<number>`count(*) filter (where ${providerBlockedPending})::int`,
      next_transient_checked_at: sql<Date | null>`min(${career_page_sources.logo_last_checked_at})
        filter (where ${scheduledTransient} and not (${providerBlockedPending}))`,
    }).from(career_page_sources);
    const dueSources = queue?.due ?? 0;
    const scheduledTransientSources = queue?.scheduled_transient ?? 0;
    const scheduledCrelateCircuitSources = queue?.scheduled_crelate_circuit ?? 0;
    const remainingSources = dueSources + scheduledTransientSources;
    const nextCheckedAt = queue?.next_transient_checked_at
      ? new Date(queue.next_transient_checked_at).getTime()
      : Number.NaN;
    const nextIndividualRetryAt = Number.isFinite(nextCheckedAt)
      ? nextCheckedAt + TRANSIENT_LOGO_RETRY_MS
      : Number.POSITIVE_INFINITY;
    const nextCrelateRetryAt = scheduledCrelateCircuitSources > 0 && crelateBlock.blockedUntil
      ? crelateBlock.blockedUntil.getTime()
      : Number.POSITIVE_INFINITY;
    const nextRetryAt = Math.min(nextIndividualRetryAt, nextCrelateRetryAt);
    const retryAfterMs = dueSources === 0 && scheduledTransientSources > 0
      ? Math.max(1, nextRetryAt - Date.now())
      : 0;
    return reply.send({
      selected_sources: candidates.length,
      verified_sources: verified,
      failed_sources: failed,
      failure_summaries: failureSummaries,
      transient_deferred_sources: transientDeferred,
      grace_preserved_sources: gracePreserved,
      due_sources: dueSources,
      scheduled_transient_sources: scheduledTransientSources,
      scheduled_crelate_circuit_sources: scheduledCrelateCircuitSources,
      remaining_sources: remainingSources,
      verification_complete: remainingSources === 0,
      retry_after_ms: retryAfterMs,
      next_retry_at: retryAfterMs > 0
        ? new Date(Date.now() + retryAfterMs).toISOString()
        : null,
      concurrency: {
        global: LOGO_VERIFICATION_GLOBAL_CONCURRENCY,
        per_provider: LOGO_VERIFICATION_PROVIDER_CONCURRENCY,
        workable: 1,
        workable_start_interval_ms: LOGO_VERIFICATION_WORKABLE_START_INTERVAL_MS,
        request_candidates: LOGO_VERIFICATION_REQUEST_CANDIDATES,
        per_provider_candidates: LOGO_VERIFICATION_PROVIDER_CANDIDATES,
        workable_candidates: LOGO_VERIFICATION_WORKABLE_CANDIDATES,
        crelate: LOGO_VERIFICATION_CRELATE_CONCURRENCY,
        crelate_candidates: LOGO_VERIFICATION_CRELATE_CANDIDATES,
        request_timeout_ms: LOGO_VERIFICATION_REQUEST_TIMEOUT_MS,
      },
      crelate_circuit: {
        state: crelateBlock.reason,
        retry_at: crelateBlock.blockedUntil?.toISOString() ?? null,
      },
    });
    } catch (error) {
      if (error instanceof LogoVerificationRequestTimeoutError) {
        return reply.status(503).send({
          error: 'Logo verification reached its bounded request deadline. Retry the remaining queue.',
          verification_complete: false,
          request_timeout_ms: error.timeoutMs,
        });
      }
      throw error;
    } finally {
      await releaseMonitorLock();
    }
  });

  fastify.get('/internal/job-monitor', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireOperator(request, reply)) return;
    const parsedQuery = monitorQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.status(400).send({ error: 'Invalid job-monitor query', detail: parsedQuery.error.issues });
    }
    if (!jobMonitorDrainStartedAtAllowed(parsedQuery.data.drain_started_at)) {
      return reply.status(400).send({
        error: 'drain_started_at is too far in the future',
        maximum_future_skew_ms: MONITOR_DRAIN_STARTED_AT_FUTURE_SKEW_MS,
      });
    }
    const drainStartedAt = parsedQuery.data.drain_started_at
      ? new Date(parsedQuery.data.drain_started_at)
      : new Date();
    const initializeDrain = jobMonitorDrainShouldInitialize(
      parsedQuery.data.drain_started_at,
      parsedQuery.data.initialize_drain === 'true',
    );
    const releaseMonitorLock = await tryAcquireJobMonitorLock();
    if (!releaseMonitorLock) {
      return reply.status(409).send({
        error: 'A job-monitor run is already in progress. Retry after it finishes.',
        polling_complete: false,
      });
    }
    try {
    await syncSponsorEmployers();
    /* Refresh the public board catalogs once at the start of a drain, never on every segment.
     * It contributes board identifiers only. Each posting still comes from the employer ATS and
     * remains outside every public count until its source has verified logo evidence.
     *
     * Remote discovery is additive only. Even a catalog that passes absolute completeness floors
     * is not allowed to disable persisted sources because a smaller but syntactically valid
     * publisher snapshot could otherwise retire thousands. Stale boards age out through the live
     * first-party freshness gate; explicit operator actions remain the authority for disabling a
     * source. Static reviewed and operator sources win identity conflicts with discovery data. */
    let discoveredSources: JobSourceInput[] = [];
    let discoveryCandidateSourceCount = 0;
    let discoveryRefreshed = false;
    let discoveryTrustedComplete = false;
    let discoveryProvenance: JobSourceDiscoveryResult['provenance'] | null = null;
    let discoveryError: string | null = null;
    if (initializeDrain) {
      try {
        const discovery = await discoverJobSources();
        discoveryCandidateSourceCount = discovery.candidateSources.length;
        discoveredSources = discovery.sources;
        discoveryRefreshed = true;
        discoveryTrustedComplete = discovery.trustedComplete;
        discoveryProvenance = discovery.provenance;
        if (!discovery.trustedComplete) {
          discoveryError = 'One or more remote source catalogs failed completeness checks';
        }
      } catch (error) {
        discoveryError = error instanceof Error ? error.message : String(error);
        request.log.warn({ error: discoveryError }, 'job source discovery failed; preserving persisted sources');
      }
    }
    const brandedSources = initializeDrain ? catalogBrandedJobSources() : [];
    const discoveredAndBranded = mergeJobSources(discoveredSources, brandedSources);
    const scheduledSources = mergeJobSources(discoveredAndBranded, JOB_SOURCES);
    const operatorConfiguredSources = configuredSources();
    await upsertSources(scheduledSources, { preserveExistingDisabled: true });
    /* Runtime configuration is an operator channel, not publisher discovery. Apply it separately
       so enabled=true can deliberately restore a reviewed source after the additive catalog sync
       has preserved its disabled state. */
    if (operatorConfiguredSources.length > 0) await upsertSources(operatorConfiguredSources);
    const retired: string[] = [];
    const pollEligible = pollingSourceEligibilityPredicate();
    const [[sourceCount], [pollEligibleSourceCount]] = await Promise.all([
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(career_page_sources)
        .where(eq(career_page_sources.enabled, true)),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(career_page_sources)
        .where(pollEligible),
    ]);
    const enabledSourceCount = sourceCount?.total ?? 0;
    const drainEligible = or(
      isNull(career_page_sources.last_polled_at),
      lt(career_page_sources.last_polled_at, drainStartedAt),
    );
    const pollQueueEligible = and(pollEligible, drainEligible)!;
    const sources = await db.select().from(career_page_sources)
      .where(pollQueueEligible)
      .orderBy(sql`${career_page_sources.last_polled_at} asc nulls first`)
      .limit(POLL_SOURCE_LIMIT);
    /* The application-owned Railway budget leaves time for the final batch, metrics and reply.
       A source that is not attempted keeps its old last_polled_at, so the oldest-first query puts
       it first next time. Workable starts are separately spaced below its shared provider limit. */
    const pollRun = await pollSourcesWithinBudget(sources, pollSource);
    const persistedFailures = await currentDrainPollFailures(drainStartedAt);
    const results = mergeCurrentDrainPollFailures(pollRun.results, persistedFailures);
    /* A rejection spike is a SUCCESSFUL poll - the sweep committed, the queue advanced - so it can
       never reach the failed count or the floor 5xx. Logged per source, because the drift it
       detects (see rejectionSpikeExceedsBaseline) starts on one board and the whole point is to
       see it before the fully-rejected guard, the floor, or a user does. */
    for (const result of results) {
      if ('rejection_spike' in result && result.rejection_spike) {
        request.log.warn(
          { sourceId: result.source_id, company: result.company },
          result.rejection_spike,
        );
      }
    }
    const [remaining] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(career_page_sources)
      .where(pollQueueEligible);
    const { deferredSources, pollingComplete } = pollingQueueStatus(remaining?.total ?? 0);
    const pollingPayload = {
      retired_sources: retired,
      discovered_sources: discoveredSources.length,
      discovery_candidate_sources: discoveryCandidateSourceCount,
      discovery_activated_sources: discoveredSources.length,
      catalog_branded_sources: brandedSources.length,
      discovery_refreshed: discoveryRefreshed,
      discovery_trusted_complete: discoveryTrustedComplete,
      discovery_provenance: discoveryProvenance,
      retirement_skipped_reason: 'remote_discovery_is_additive_only',
      discovery_error: discoveryError,
      sources: results.length,
      enabled_sources: enabledSourceCount,
      poll_eligible_sources: pollEligibleSourceCount?.total ?? 0,
      selected_sources: sources.length,
      deferred_sources: deferredSources,
      remaining_polling_sources: deferredSources,
      polling_complete: pollingComplete,
      stopped_for_time_budget: pollRun.stopped_for_time_budget,
      polling_elapsed_ms: pollRun.elapsed_ms,
      polling_time_budget_ms: POLL_TIME_BUDGET_MS,
      polling_start_reserve_ms: POLL_START_RESERVE_MS,
      poll_segment_size: POLL_SEGMENT_SIZE,
      drain_started_at: drainStartedAt.toISOString(),
      poll_source_limit: POLL_SOURCE_LIMIT,
      poll_concurrency: POLL_CONCURRENCY,
      workable_start_interval_ms: WORKABLE_START_INTERVAL_MS,
      jobs: results.reduce((sum, result) => sum + result.jobs, 0),
      failed: results.filter((result) => !result.ok).length,
      results,
    };
    if (!pollingComplete) {
      request.log.warn(
        { enabledSourceCount, attempted: results.length, deferredSources, elapsedMs: pollRun.elapsed_ms },
        'Job monitor deferred sources; the Railway worker should invoke another pass.',
      );
      return reply.send({
        ...pollingPayload,
        metrics_deferred: true,
      });
    }
    /* THE FLOOR CHECK. See MINIMUM_SURFACED_JOBS.
     *
     * Reported on every run, not only on a breach, so the number is watchable while it is still
     * healthy rather than only once it is already a problem. A board does not usually collapse in
     * one step; it erodes as tokens rotate and boards go quiet, and a figure in every cron response
     * is what makes that erosion visible before it crosses the line.
     *
     * A breach answers 5xx ON PURPOSE. This route is the daily Railway cron, and a cron that returns
     * 200 is a cron nobody looks at - which is exactly how career_page_sources sat empty for months
     * while every check reported success. Failing the run is the only signal that reaches anyone.
     * The poll itself still committed; this reports the state, it does not roll anything back.
     */
    /* Purge before counting, so inventory and purged_postings describe the same moment. Counting
       first would report a board that includes rows this run was about to delete. */
    let purged: number;
    try {
      purged = await purgeExpiredPostings();
    } catch (error) {
      if (!(error instanceof JobBoardPurgeTimeoutError)) throw error;
      request.log.error({
        metricsStage: error.stage,
        timeoutMs: error.timeoutMs,
        drainStartedAt: drainStartedAt.toISOString(),
      }, 'Job board purge timed out');
      return reply.status(503).send({
        ...pollingPayload,
        metrics_deferred: true,
        metrics_error: 'statement_timeout',
        metrics_stage: error.stage,
        metrics_timeout_ms: error.timeoutMs,
      });
    }

    /* Three thresholds from one inventory snapshot: postings and grouped roles over the full board,
     * plus postings on the sponsor-only view. The sponsor view is the fragile one: it drains when
     * employer links go NULL, when a data refresh drops confirmations, or when employers add a
     * refusal sentence. Measuring only the full board would let that view fall to zero while this
     * cron reported a healthy total. The snapshot uses one serverless connection and bounds each
     * statement so a slow database still returns an error and releases the advisory lock. */
    let monitoringSnapshot: Awaited<ReturnType<typeof boardMonitoringSnapshot>>;
    try {
      monitoringSnapshot = await boardMonitoringSnapshot(drainStartedAt);
    } catch (error) {
      if (!(error instanceof JobBoardMetricsTimeoutError)) throw error;
      request.log.error({
        metricsStage: error.stage,
        timeoutMs: error.timeoutMs,
        drainStartedAt: drainStartedAt.toISOString(),
      }, 'Job board projection metrics timed out');
      return reply.status(503).send({
        ...pollingPayload,
        metrics_deferred: true,
        metrics_error: 'statement_timeout',
        metrics_stage: error.stage,
        metrics_timeout_ms: error.timeoutMs,
      });
    }
    const { inventory, projection, variety, varietySample } = monitoringSnapshot;
    /* Target-role matching is a separate set-oriented statement. Keeping it out of the inventory
       transaction avoids holding a repeatable-read snapshot during work that grows with users. */
    const targetRoleCoverage = await targetRoleCoverageMonitoringSnapshot();
    const coverage = classificationCoverage(variety);
    const {
      surfacedPostings: surfaced,
      surfacedGroupedRoles,
      surfacedSponsorOnly,
      surfacedInternships,
      certifiedUniqueJobs,
      certifiedUniqueGroupedRoles,
      certifiedUniqueSponsorJobs,
      certifiedUniqueInternships,
    } = inventory;
    const payload = {
      ...pollingPayload,
      metrics_deferred: false,
      group_projection_generation: projection.generation,
      group_projection_as_of: projection.asOf.toISOString(),
      group_projection_refreshed_at: projection.refreshedAt.toISOString(),
      surfaced_postings: surfaced,
      surfaced_grouped_roles: surfacedGroupedRoles,
      /* Backward-compatible alias for existing consumers. */
      surfaced_jobs: surfaced,
      surfaced_sponsor_only_jobs: surfacedSponsorOnly,
      certified_unique_jobs: certifiedUniqueJobs,
      certified_unique_grouped_roles: certifiedUniqueGroupedRoles,
      certified_unique_sponsor_jobs: certifiedUniqueSponsorJobs,
      certified_unique_internships: certifiedUniqueInternships,
      /* Reported every run from the day the commitment was made, while the board is still far
         under it. A number that only starts being reported once it looks good is a number nobody
         can show a trend for. See MINIMUM_SURFACED_INTERNSHIPS for why this is not yet a 5xx. */
      surfaced_internships: surfacedInternships,
      minimum_surfaced_internships: MINIMUM_SURFACED_INTERNSHIPS,
      internship_floor_enforced: false,
      internship_headroom_multiple: Number(
        (certifiedUniqueInternships / MINIMUM_SURFACED_INTERNSHIPS).toFixed(2),
      ),
      variety,
      variety_sample: varietySample,
      classification_coverage: coverage,
      target_role_coverage: targetRoleCoverage,
      minimum_surfaced_jobs: MINIMUM_SURFACED_JOBS,
      minimum_surfaced_grouped_roles: MINIMUM_SURFACED_GROUPED_ROLES,
      minimum_sponsor_surfaced_jobs: MINIMUM_SPONSOR_SURFACED_JOBS,
      minimum_certified_unique_jobs: MINIMUM_SURFACED_JOBS,
      minimum_certified_unique_grouped_roles: MINIMUM_SURFACED_GROUPED_ROLES,
      minimum_certified_unique_sponsor_jobs: MINIMUM_SPONSOR_SURFACED_JOBS,
      certification_started_at: drainStartedAt.toISOString(),
      public_verified_evidence_gate_enabled: publicVerifiedEvidenceGateEnabled(),
      /* THE SUSTAINABILITY CHECK, run every day rather than once.
       *
       * Whether the verification window keeps both postings and grouped roles above their warning lines
       * depends on hiring volume and sources still resolving. Reporting both makes the answer
       * observable instead of relying on a one-time measurement.
       *
       * headroom_multiple is the number to watch. A slide toward 1.0 is the signal to repair
       * verification throughput or add sources before anything breaks. */
      verification_window_days: VERIFIED_ACTIVE_WINDOW_DAYS,
      /* The rolling window's two halves, reported so both are visible: how many stale/closed rows
         this run removed, and how long a closed posting is kept before deletion. A purge that
         suddenly deletes thousands, or nothing at all, is the first sign something upstream changed. */
      purged_postings: purged,
      closed_posting_retention_days: CLOSED_POSTING_RETENTION_DAYS,
      required_surfaced_jobs: REQUIRED_SURFACED_JOBS,
      required_surfaced_grouped_roles: REQUIRED_SURFACED_GROUPED_ROLES,
      grouped_role_alert_threshold: GROUPED_ROLE_ALERT_THRESHOLD,
      grouped_role_alert_triggered: groupedRoleAlertTriggered(certifiedUniqueGroupedRoles),
      target_surfaced_postings: TARGET_SURFACED_POSTINGS,
      target_surfaced_grouped_roles: TARGET_SURFACED_GROUPED_ROLES,
      inventory_target_met: inventoryTargetMet(certifiedUniqueJobs, certifiedUniqueGroupedRoles),
      headroom_multiple: Number((certifiedUniqueJobs / MINIMUM_SURFACED_JOBS).toFixed(1)),
      grouped_role_headroom_multiple: Number(
        (certifiedUniqueGroupedRoles / MINIMUM_SURFACED_GROUPED_ROLES).toFixed(1),
      ),
      board_health: boardHealth(certifiedUniqueJobs, certifiedUniqueGroupedRoles),
    };
    const postingsBelow = boardIsBelowFloor(certifiedUniqueJobs);
    const groupedRolesBelow = certifiedUniqueGroupedRoles < MINIMUM_SURFACED_GROUPED_ROLES;
    const sponsorBelow = certifiedUniqueSponsorJobs < MINIMUM_SPONSOR_SURFACED_JOBS;
    if (!coverage.all_coverage_thresholds_met || !targetRoleCoverage.coverage_threshold_met) {
      request.log.warn(
        {
          classificationCoverage: coverage,
          zeroResultTargetRoles: targetRoleCoverage.zero_result_target_roles,
        },
        'Job board coverage thresholds need attention',
      );
    }
    /* Short of the 1.2x headroom but not yet under the floor: logged as a warning and reported in the
     * payload, NOT a 5xx. The distinction is deliberate. A 5xx here means "the board is broken now";
     * if the merely-thin case also failed the run, the alarm would stop meaning that, and the first
     * real breach would arrive in a channel everyone had learned to ignore. This is the early
     * warning, and it is early precisely because it does not page anyone. */
    if (!postingsBelow && !groupedRolesBelow && payload.board_health === 'low') {
      request.log.warn(
        {
          certifiedUniqueJobs,
          certifiedUniqueGroupedRoles,
          rawSurfacedPostings: surfaced,
          rawSurfacedGroupedRoles: surfacedGroupedRoles,
          requiredPostings: REQUIRED_SURFACED_JOBS,
          requiredGroupedRoles: REQUIRED_SURFACED_GROUPED_ROLES,
          windowDays: VERIFIED_ACTIVE_WINDOW_DAYS,
        },
        `Job board has thin headroom: ${certifiedUniqueJobs} unique jobs and `
        + `${certifiedUniqueGroupedRoles} unique grouped roles. `
        + `Complete the source drain or add sources before it reaches the floor.`,
      );
    }
    if (certifiedUniqueInternships < MINIMUM_SURFACED_INTERNSHIPS) {
      request.log.warn(
        {
          certifiedUniqueInternships,
          rawSurfacedInternships: surfacedInternships,
          committedInternships: MINIMUM_SURFACED_INTERNSHIPS,
          windowDays: VERIFIED_ACTIVE_WINDOW_DAYS,
        },
        `Unique internship inventory is ${certifiedUniqueInternships} against a committed `
        + `${MINIMUM_SURFACED_INTERNSHIPS}. `
        + 'Levers, measured, in order: internship-specific freshness window, seasonal ramp, more '
        + 'density-sourced boards. Never by widening what counts as an internship.',
      );
    }
    if (postingsBelow || groupedRolesBelow || sponsorBelow) {
      request.log.error(
        {
          certifiedUniqueJobs,
          certifiedUniqueGroupedRoles,
          certifiedUniqueSponsorJobs,
          rawSurfacedPostings: surfaced,
          floor: MINIMUM_SURFACED_JOBS,
          groupedRoleFloor: MINIMUM_SURFACED_GROUPED_ROLES,
          sponsorFloor: MINIMUM_SPONSOR_SURFACED_JOBS,
          failedSources: payload.failed,
        },
        'Job board is below an inventory floor',
      );
      return reply.status(500).send({
        ...payload,
        error: `The job board has ${certifiedUniqueGroupedRoles} certified unique grouped roles across `
          + `${certifiedUniqueJobs} certified unique jobs (${certifiedUniqueSponsorJobs} sponsor-only). `
          + `The raw verified views contain ${surfacedGroupedRoles} grouped roles across ${surfaced} postings `
          + `(${surfacedSponsorOnly} sponsor-only). The certified floors are `
          + `${MINIMUM_SURFACED_GROUPED_ROLES} grouped roles, ${MINIMUM_SURFACED_JOBS} postings, and `
          + `${MINIMUM_SPONSOR_SURFACED_JOBS} sponsor-only postings. `
          + 'Check career_page_sources.last_error for failing polls, whether a portal left '
          + 'AUTONOMOUS_PORTAL_FAMILIES, and whether career_page_sources.sponsor_employer_id went '
          + 'NULL after a data refresh. Do not lower the floor to clear this.',
      });
    }
    return reply.send(payload);
    } finally {
      await releaseMonitorLock();
    }
  });
}
