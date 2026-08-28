import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withDedicatedDatabase } from '../db';
import { withReadOnlyRetry } from '../db/readOnlyRetry';
import {
  application_artifacts,
  application_submission_attempt_events,
  application_submission_events,
  applications,
  artifacts,
  monetization_events,
  outreach_draft_generations,
  pending_premium_actions,
  profiles,
  trial_answer_applications,
  users,
} from '../db/schema';
import { canonicalCompanyScope, getEntitlementSnapshot } from '../lib/entitlements';
import { requireAuth } from '../middleware/auth';
import { apiBaseFor } from '../lib/apiBase';
import { mintDownloadToken } from '../lib/resumeAccess';
import { manualSubmissionTransition } from '../lib/canonicalApplicationLifecycle';
import { exactAttemptPermanentlyBlocksNegativeResolution } from './applications';
import {
  duplicateApplicationResponse,
  duplicateApplicationVerdict,
  unidentifiableDuplicateApplicationResponse,
} from '../lib/duplicateApplication';
import {
  appendSubmissionAttemptEvent,
  blockingSubmissionAttemptsForUser,
  comparePostings,
  freezePostingIdentity,
  frozenPostingIdentityFromEvent,
  lockSubmissionAttemptUser,
  submissionAttemptBindingFromEvent,
  submissionAttemptEventId,
  submissionAttemptEventsForUser,
  submissionAttemptRetrySafety,
  submissionAttemptRetrySafetyForPacketEvents,
  type SubmissionAttemptBinding,
  type SubmissionAttemptLedgerExecutor,
  type SubmissionAttemptRetrySafety,
} from '../lib/submissionAttemptLedger';

export { manualSubmissionTransition };

async function appendCanonicalManualSubmissionFacts(input: {
  tx: SubmissionAttemptLedgerExecutor;
  application: typeof applications.$inferSelect;
  userId: string;
  clientEventId: string;
  outcome: ManualSubmissionOutcome;
  finalUrl: string;
}): Promise<void> {
  /* The extension reports this route only after the applicant has activated the employer's final
   * control. A generic failed or unknown result is therefore still employer-boundary risk. Keep
   * that fact open until an exact later resolution instead of treating a client-side label as
   * proof that nothing was filed. */
  const attemptId = input.clientEventId;
  const [existingOpening] = await input.tx.select()
    .from(application_submission_attempt_events)
    .where(and(
      eq(application_submission_attempt_events.user_id, input.userId),
      eq(application_submission_attempt_events.attempt_id, attemptId),
      eq(application_submission_attempt_events.event_kind, 'attempt_opened'),
    ))
    .limit(1);
  const expectedPacketId = input.application.legacy_generated_resume_id ?? input.application.id;
  if (existingOpening && (
    !(await canonicalAttemptEventMayMutateApplication(
      input.tx,
      input.userId,
      existingOpening,
      input.application,
    ))
    || existingOpening.source !== 'chrome_extension'
    || existingOpening.operation !== 'manual_submission'
  )) {
    throw Object.assign(new Error('This event id belongs to another submission attempt'), {
      statusCode: 409,
      code: 'submission_event_binding_conflict',
    });
  }
  const binding: SubmissionAttemptBinding = existingOpening
    ? submissionAttemptBindingFromEvent(existingOpening)
    : {
      attemptId,
      userId: input.userId,
      // Canonical-only applications have no generated packet. Their own stable UUID is the safe
      // synthetic packet key until a legacy packet exists.
      packetId: expectedPacketId,
      applicationId: input.application.id,
      source: 'chrome_extension',
      operation: 'manual_submission',
      postingIdentity: freezePostingIdentity({
        company: input.application.company_name,
        role: input.application.role,
        job_id: input.application.job_id,
      }, input.application.portal_url ?? input.finalUrl),
    };
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'attempt_opened', 'canonical-manual-reservation'),
    eventKind: 'attempt_opened',
    evidenceCode: 'canonical_manual_submit_reserved',
  }, { executor: input.tx });
  await appendSubmissionAttemptEvent({
    ...binding,
    eventId: submissionAttemptEventId(attemptId, 'press_observed', 'canonical-manual-outcome'),
    eventKind: 'press_observed',
    evidenceCode: 'canonical_manual_submit_pressed',
  }, { executor: input.tx });
  if (input.outcome === 'confirmed') {
    await appendSubmissionAttemptEvent({
      ...binding,
      eventId: submissionAttemptEventId(attemptId, 'submission_confirmed', 'canonical-manual-outcome'),
      eventKind: 'submission_confirmed',
      evidenceCode: 'canonical_manual_receipt_confirmed',
    }, { executor: input.tx });
  }
}

const createApplicationSchema = z.object({
  job_id: z.string().uuid().optional(),
  company: z.string().trim().min(1).max(240),
  company_id: z.string().uuid().optional(),
  company_domain: z.string().trim().max(255).optional(),
  role: z.string().trim().min(1).max(240),
  portal_url: z.string().url().max(2_048).optional(),
  source: z.enum(['dashboard', 'extension', 'website']).optional(),
  source_surface: z.enum(['dashboard', 'extension', 'website']).optional(),
});

export const fillApplicationSchema = z.object({
  selected_resume_artifact_id: z.string().uuid().nullable().optional(),
  resume_attached: z.boolean().optional(),
  resume_source: z.enum(['artifact', 'base_resume', 'none']).optional(),
  unanswered_questions: z.number().int().min(0).max(200).optional(),
}).superRefine((value, context) => {
  if ((value.resume_attached === undefined) !== (value.resume_source === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'resume_attached and resume_source must be sent together',
    });
  }
  if (value.resume_attached === false && value.resume_source !== undefined && value.resume_source !== 'none') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An unattached resume must use source none' });
  }
  if (value.resume_attached === true && value.resume_source === 'none') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'An attached resume must name its source' });
  }
});

const paramsSchema = z.object({ id: z.string().uuid() });
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });
const fillDataQuerySchema = z.object({ event_id: z.string().uuid() });

export const manualSubmissionOutcomeSchema = z.object({
  event_id: z.string().uuid(),
  lease_id: z.string().uuid().optional(),
  activation_id: z.string().uuid().optional(),
  outcome: z.enum(['confirmed', 'failed', 'unknown']),
  final_url: z.string().url().max(2_048),
  confirmation_text: z.string().trim().min(1).max(1_000).optional(),
});

export const manualSubmissionStartSchema = z.object({
  event_id: z.string().uuid(),
  current_url: z.string().url().max(2_048),
});

export const manualSubmissionPreflightSchema = manualSubmissionStartSchema.extend({
  activation_id: z.string().uuid(),
});

export const MANUAL_SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS = 3 * 60_000;

export const manualSubmissionResolutionSchema = z.object({
  attempt_id: z.string().uuid(),
  found: z.boolean(),
  reason: z.literal('extension_cancelled_before_press').optional(),
  lease_id: z.string().uuid().optional(),
}).superRefine((value, context) => {
  if (value.reason && value.found) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['found'],
      message: 'A pre-click cancellation cannot report that the application was found',
    });
  }
});

type ManualSubmissionOutcome = z.infer<typeof manualSubmissionOutcomeSchema>['outcome'];

export function manualSubmissionResolutionDecision(
  safety: SubmissionAttemptRetrySafety,
  found: boolean,
): 'resolve' | 'exact_replay' | 'terminal_conflict' | 'not_resolvable' {
  if (safety.kind === 'blocked_confirmed') return found ? 'exact_replay' : 'terminal_conflict';
  // A later positive observation is stronger evidence than an earlier not-sent answer. Keep the
  // ledger append-only and promote it to confirmed. The reverse transition is never allowed.
  if (safety.kind === 'safe_not_sent') return found ? 'resolve' : 'exact_replay';
  if (safety.kind === 'blocked_unverified') {
    if (safety.reason === 'invalid_sequence') return 'not_resolvable';
    if (safety.reason === 'boundary_authorized' && !found) return 'not_resolvable';
    return 'resolve';
  }
  return 'not_resolvable';
}

async function canonicalSubmissionRetrySafety(
  application: Pick<typeof applications.$inferSelect,
  'id' | 'legacy_generated_resume_id' | 'user_id' | 'job_id' | 'company_name' | 'role' | 'portal_url'>,
  executor?: Pick<SubmissionAttemptLedgerExecutor, 'select'>,
): Promise<SubmissionAttemptRetrySafety> {
  const events = await submissionAttemptEventsForUser(
    application.user_id,
    executor ? { executor } : {},
  );
  return submissionAttemptRetrySafetyForPacketEvents(
    events.filter((event) => canonicalAttemptEventMatchesApplication(event, application)),
  );
}

type ManualSubmissionBoundaryAuthorization = {
  leaseId: string;
  attemptId: string;
  activationId: string;
  authorizedAt: string;
  expiresAt: string;
  serverNow: string;
  active: boolean;
};

async function manualSubmissionBoundaryAuthorization(
  executor: Pick<SubmissionAttemptLedgerExecutor, 'select'>,
  userId: string,
  attemptId: string,
): Promise<ManualSubmissionBoundaryAuthorization | null> {
  const [authorization] = await executor.select({
    event_id: application_submission_attempt_events.event_id,
    attempt_id: application_submission_attempt_events.attempt_id,
    observed_at: application_submission_attempt_events.observed_at,
    boundary_activation_id: application_submission_attempt_events.boundary_activation_id,
    boundary_expires_at: application_submission_attempt_events.boundary_expires_at,
    server_now: sql<Date>`clock_timestamp()`,
    active: sql<boolean>`
      ${application_submission_attempt_events.boundary_expires_at} > clock_timestamp()
    `,
  }).from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, userId),
    eq(application_submission_attempt_events.attempt_id, attemptId),
    eq(application_submission_attempt_events.event_kind, 'boundary_authorized'),
  )).limit(1);
  if (!authorization) return null;
  if (!authorization.boundary_activation_id || !authorization.boundary_expires_at) return null;
  const authorizedAt = authorization.observed_at;
  return {
    leaseId: authorization.event_id,
    attemptId: authorization.attempt_id,
    activationId: authorization.boundary_activation_id,
    authorizedAt: authorizedAt.toISOString(),
    expiresAt: authorization.boundary_expires_at.toISOString(),
    serverNow: new Date(authorization.server_now).toISOString(),
    active: authorization.active,
  };
}

function canonicalAttemptEventMatchesApplication(
  event: typeof application_submission_attempt_events.$inferSelect,
  application: Pick<typeof applications.$inferSelect,
  'id' | 'legacy_generated_resume_id' | 'job_id' | 'company_name' | 'role' | 'portal_url'>,
): boolean {
  if (
    event.application_id === application.id
    || event.packet_id === application.id
    || event.packet_id === application.legacy_generated_resume_id
  ) return true;
  const identity = freezePostingIdentity({
    company: application.company_name,
    role: application.role,
    job_id: application.job_id,
  }, application.portal_url);
  if (event.posting_key && identity.postingKey) return event.posting_key === identity.postingKey;
  if (event.job_id && identity.jobId) return event.job_id === identity.jobId;
  return Boolean(
    event.company_role
    && identity.companyRole
    && event.company_role === identity.companyRole
    && safeStoredPortalUrl(event.portal_url) === safeStoredPortalUrl(application.portal_url),
  );
}

function canonicalAttemptEventDirectlyMatchesApplication(
  event: typeof application_submission_attempt_events.$inferSelect,
  application: Pick<typeof applications.$inferSelect, 'id' | 'legacy_generated_resume_id'>,
): boolean {
  return event.application_id === application.id
    || event.packet_id === application.id
    || event.packet_id === application.legacy_generated_resume_id;
}

async function canonicalAttemptEventMayMutateApplication(
  executor: Pick<typeof db, 'select'>,
  userId: string,
  event: typeof application_submission_attempt_events.$inferSelect,
  application: typeof applications.$inferSelect,
): Promise<boolean> {
  if (event.user_id !== userId) return false;
  if (canonicalAttemptEventDirectlyMatchesApplication(event, application)) return true;
  const owned = await executor.select().from(applications).where(eq(applications.user_id, userId));
  // Posting identity may recover a consolidated alias only after the row named by the immutable
  // binding no longer exists. It may never choose between two still-live rows for the same posting.
  if (owned.some((row) => canonicalAttemptEventDirectlyMatchesApplication(event, row))) return false;
  const aliases = owned.filter((row) => canonicalAttemptEventMatchesApplication(event, row));
  return aliases.length === 1 && aliases[0]!.id === application.id;
}

function manualSubmissionPostingMatches(
  frozen: SubmissionAttemptBinding['postingIdentity'],
  application: Pick<typeof applications.$inferSelect, 'company_name' | 'role' | 'job_id'>,
  currentUrl: string,
): boolean {
  const live = freezePostingIdentity({
    company: application.company_name,
    role: application.role,
  }, currentUrl);
  const comparison = comparePostings(frozen, live);
  return comparison.same
    && frozen.portalIdentity === live.portalIdentity
    && (comparison.basis !== 'company_role'
      || safeStoredPortalUrl(frozen.portalUrl) === safeStoredPortalUrl(currentUrl));
}

export function canonicalPortalIdentity(raw: string): string {
  const normalized = canonicalPortalUrl(raw, true);
  if (!normalized) throw new Error('Application portal URL is required');
  return new URL(normalized).origin.toLowerCase();
}

export function manualOutcomeEventDecision(existing: {
  application_id: string;
  portal_identity: string;
  outcome: string;
  final_url: string;
  confirmation_text: string | null;
}, incoming: {
  applicationId: string;
  portalIdentity: string;
  outcome: ManualSubmissionOutcome;
  finalUrl: string;
  confirmationText: string | null;
}): 'exact_replay' | 'promote' | 'binding_conflict' | 'terminal_conflict' {
  if (existing.application_id !== incoming.applicationId || existing.portal_identity !== incoming.portalIdentity) {
    return 'binding_conflict';
  }
  if (existing.outcome === incoming.outcome
    && existing.final_url === incoming.finalUrl
    && existing.confirmation_text === incoming.confirmationText) return 'exact_replay';
  if ((existing.outcome === 'unknown' || existing.outcome === 'failed')
    && (incoming.outcome === 'confirmed' || incoming.outcome === 'failed' || incoming.outcome === 'unknown')) {
    return 'promote';
  }
  return 'terminal_conflict';
}

export function lifecycleStateAfterFill(input: {
  tracker_state: string;
  review_state: string;
  submission_state: string;
}) {
  const terminal = input.submission_state === 'submitted' || input.tracker_state === 'applied';
  return terminal
    ? { trackerState: input.tracker_state, reviewState: input.review_state }
    : { trackerState: 'applying', reviewState: 'filling' };
}

type FillUpdateExecutor = Pick<typeof db, 'update'>;

export async function updateCanonicalApplicationAfterFill(
  executor: FillUpdateExecutor,
  input: {
    applicationId: string;
    userId: string;
    selectedResumeArtifactId: string | null;
    resumeAttached: boolean;
    resumeSource: 'artifact' | 'base_resume' | 'none';
    resumeAttachedAt: Date | null;
  },
) {
  const terminalLifecycle = sql`${applications.submission_state} = 'submitted' or ${applications.tracker_state} = 'applied'`;
  const [updated] = await executor.update(applications).set({
    // These CASE expressions read the row at UPDATE time. A receipt can land after the route's
    // initial ownership read without a late fill write ever moving submitted/applied backwards.
    tracker_state: sql`case when ${terminalLifecycle} then 'applied' else 'applying' end`,
    review_state: sql`case when ${terminalLifecycle} then ${applications.review_state} else 'filling' end`,
    selected_resume_artifact_id: input.selectedResumeArtifactId,
    resume_attached: input.resumeAttached,
    resume_source: input.resumeSource,
    resume_attached_at: input.resumeAttachedAt,
    updated_at: new Date(),
  }).where(and(
    eq(applications.id, input.applicationId),
    eq(applications.user_id, input.userId),
  )).returning();
  return updated;
}

export function isResumeArtifactKind(kind: unknown): kind is 'resume' | 'tailored_resume' {
  return kind === 'resume' || kind === 'tailored_resume';
}

export function canonicalPortalUrl(raw: string | undefined, requireHttps = process.env.NODE_ENV !== 'test'): string | null {
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'https:' && requireHttps) {
    throw Object.assign(new Error('Application portal URL must use HTTPS'), { statusCode: 400 });
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|ref$|source$)/i.test(key)) url.searchParams.delete(key);
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

function safeStoredPortalUrl(raw: string | null): string | null {
  try {
    return canonicalPortalUrl(raw ?? undefined);
  } catch {
    return null;
  }
}

export function canonicalApplicationFingerprint(input: {
  jobId?: string;
  portalUrl?: string | null;
  companyScopeKey: string;
  role: string;
}): string {
  if (input.jobId) return `job:${input.jobId}`;
  const identity = input.portalUrl
    ? `portal:${input.portalUrl}`
    : `scope:${input.companyScopeKey}:role:${input.role.trim().toLowerCase()}`;
  return `application:${createHash('sha256').update(identity).digest('hex')}`;
}

const lifecycleRanks: Record<string, number> = {
  not_started: 0,
  saved: 0,
  filling: 1,
  applying: 1,
  needs_attention: 2,
  ready: 3,
  approved: 4,
  submitted: 5,
  applied: 5,
  interview: 6,
  offer: 7,
  closed: 8,
};

function mostAdvancedLifecycle(values: string[]): string {
  return values.reduce((best, value) =>
    (lifecycleRanks[value] ?? 0) > (lifecycleRanks[best] ?? 0) ? value : best, values[0] ?? 'not_started');
}

function canonicalIdentityMatches(
  row: typeof applications.$inferSelect,
  input: { jobId?: string; portalUrl: string | null; companyScopeKey: string; companyName: string; role: string },
): boolean {
  if (input.jobId) return row.job_id === input.jobId;
  if (input.portalUrl) return safeStoredPortalUrl(row.portal_url) === input.portalUrl;
  const roleMatches = row.role.normalize('NFKC').trim().toLocaleLowerCase('en-US')
    === input.role.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const companyMatches = row.company_name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US')
    === input.companyName.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  // The name comparison is the compatibility bridge for databases migrated by the brief-lived
  // MD5 scope backfill. New migrations write the same SHA-256 scope as runtime, but an already-run
  // legacy row must still be adopted instead of duplicated.
  return roleMatches && (row.company_scope_key === input.companyScopeKey || companyMatches);
}

function canonicalAliasMatches(
  row: typeof applications.$inferSelect,
  input: { jobId?: string; portalUrl: string | null; companyName: string; role: string },
): boolean {
  const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US');
  if (normalized(row.company_name) !== normalized(input.companyName) || normalized(row.role) !== normalized(input.role)) {
    return false;
  }
  const jobMatches = Boolean(input.jobId && row.job_id === input.jobId);
  const portalMatches = Boolean(input.portalUrl && safeStoredPortalUrl(row.portal_url) === input.portalUrl);
  return jobMatches || portalMatches;
}

export async function upsertCanonicalApplicationForUser(input: {
  userId: string;
  jobId?: string;
  companyScopeKey: string;
  companyName: string;
  role: string;
  portalUrl?: string | null;
  sourceSurface: 'dashboard' | 'extension' | 'website';
}) {
  const portalUrl = canonicalPortalUrl(input.portalUrl ?? undefined);
  const fingerprint = canonicalApplicationFingerprint({
    jobId: input.jobId,
    portalUrl,
    companyScopeKey: input.companyScopeKey,
    role: input.role,
  });
  return db.transaction(async (tx) => {
    // Canonical alias consolidation can move or delete an application referenced by an active
    // manual attempt. Serialize it with reservations, preflights, and outcomes for this user.
    // The submission-user lock is always acquired before the narrower canonical lock.
    await lockSubmissionAttemptUser(tx, input.userId);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`canonical-application:${input.userId}`}, 0::bigint))`);
    const owned = await tx.select().from(applications).where(eq(applications.user_id, input.userId));
    const canonical = owned.find((row) => row.application_fingerprint === fingerprint);
    const adoptable = owned.filter((row) =>
      row.application_fingerprint.startsWith('legacy:')
      && canonicalIdentityMatches(row, {
        jobId: input.jobId,
        portalUrl,
        companyScopeKey: input.companyScopeKey,
        companyName: input.companyName,
        role: input.role,
      }));
    const aliases = owned.filter((row) => canonicalAliasMatches(row, {
      jobId: input.jobId,
      portalUrl,
      companyName: input.companyName,
      role: input.role,
    }));
    let winner = [canonical, ...adoptable, ...aliases]
      .filter((row): row is typeof applications.$inferSelect => Boolean(row))
      .sort((left, right) => Number(Boolean(right.legacy_generated_resume_id)) - Number(Boolean(left.legacy_generated_resume_id)))[0];
    if (!winner) {
      [winner] = await tx.insert(applications).values({
        user_id: input.userId,
        job_id: input.jobId,
        company_scope_key: input.companyScopeKey,
        company_name: input.companyName,
        role: input.role,
        portal_url: portalUrl,
        source_surface: input.sourceSurface,
        application_fingerprint: fingerprint,
      }).returning();
      if (!winner) throw new Error('Canonical application upsert returned no record');
      return { application: winner, created: true, adopted: false };
    }

    const losers = [...new Map(
      [canonical, ...adoptable, ...aliases].filter((row): row is typeof applications.$inferSelect => Boolean(row) && row!.id !== winner!.id)
        .map((row) => [row.id, row]),
    ).values()];
    const merged = [winner, ...losers];
    for (const loser of losers) {
      await tx.execute(sql`
        insert into ${application_artifacts} (
          application_id, artifact_id, purpose, selected, attachment_result, attached_at, created_at
        )
        select ${winner.id}, artifact_id, purpose, selected, attachment_result, attached_at, created_at
        from ${application_artifacts} where application_id = ${loser.id}
        on conflict (application_id, artifact_id, purpose) do update set
          selected = ${application_artifacts.selected} or excluded.selected,
          attachment_result = coalesce(excluded.attachment_result, ${application_artifacts.attachment_result}),
          attached_at = coalesce(excluded.attached_at, ${application_artifacts.attached_at})
      `);
      await tx.delete(application_artifacts).where(eq(application_artifacts.application_id, loser.id));
      await tx.update(application_submission_events).set({ application_id: winner.id })
        .where(eq(application_submission_events.application_id, loser.id));
      await tx.update(outreach_draft_generations).set({ application_id: winner.id })
        .where(eq(outreach_draft_generations.application_id, loser.id));
      await tx.update(pending_premium_actions).set({ application_id: winner.id })
        .where(eq(pending_premium_actions.application_id, loser.id));
      await tx.update(monetization_events).set({ application_id: winner.id })
        .where(eq(monetization_events.application_id, loser.id));
      await tx.execute(sql`
        insert into ${trial_answer_applications} (user_id, application_id, granted_at)
        select user_id, ${winner.id}, granted_at from ${trial_answer_applications}
        where user_id = ${input.userId} and application_id = ${loser.id}
        on conflict (user_id, application_id) do nothing
      `);
      await tx.delete(trial_answer_applications).where(and(
        eq(trial_answer_applications.user_id, input.userId),
        eq(trial_answer_applications.application_id, loser.id),
      ));
      await tx.delete(applications).where(and(
        eq(applications.id, loser.id),
        eq(applications.user_id, input.userId),
      ));
    }

    const resumeSourceRow = merged.find((row) => row.resume_attached && row.resume_source !== 'none');
    const [updated] = await tx.update(applications).set({
      legacy_generated_resume_id: merged.find((row) => row.legacy_generated_resume_id)?.legacy_generated_resume_id ?? null,
      job_id: input.jobId ?? merged.find((row) => row.job_id)?.job_id ?? null,
      company_scope_key: input.companyScopeKey,
      company_name: input.companyName,
      role: input.role,
      portal_url: portalUrl ?? merged.find((row) => row.portal_url)?.portal_url ?? null,
      application_fingerprint: fingerprint,
      tracker_state: mostAdvancedLifecycle(merged.map((row) => row.tracker_state)),
      review_state: mostAdvancedLifecycle(merged.map((row) => row.review_state)),
      submission_state: mostAdvancedLifecycle(merged.map((row) => row.submission_state)),
      selected_resume_artifact_id: merged.find((row) => row.selected_resume_artifact_id)?.selected_resume_artifact_id ?? null,
      resume_attached: Boolean(resumeSourceRow),
      resume_source: resumeSourceRow?.resume_source ?? 'none',
      resume_attached_at: resumeSourceRow?.resume_attached_at ?? null,
      created_at: new Date(Math.min(...merged.map((row) => row.created_at.getTime()))),
      updated_at: new Date(Math.max(Date.now(), ...merged.map((row) => row.updated_at.getTime()))),
    }).where(and(eq(applications.id, winner.id), eq(applications.user_id, input.userId))).returning();
    if (!updated) throw new Error('Canonical application adoption returned no record');
    return { application: updated, created: false, adopted: adoptable.length > 0 || losers.length > 0 };
  });
}

function applicationResponse(row: typeof applications.$inferSelect) {
  return {
    id: row.id,
    legacy_generated_resume_id: row.legacy_generated_resume_id,
    job_id: row.job_id,
    company: row.company_name,
    company_scope_key: row.company_scope_key,
    role: row.role,
    portal_url: safeStoredPortalUrl(row.portal_url),
    source_surface: row.source_surface,
    tracker_state: row.tracker_state,
    review_state: row.review_state,
    submission_state: row.submission_state,
    selected_resume_artifact_id: row.selected_resume_artifact_id,
    resume_attached: row.resume_attached,
    resume_source: row.resume_source,
    resume_attached_at: row.resume_attached_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function fillHandoffResponse(row: typeof applications.$inferSelect) {
  const portalUrl = safeStoredPortalUrl(row.portal_url);
  if (!portalUrl) return null;
  return {
    mode: 'extension_portal_fill' as const,
    application_id: row.id,
    portal_url: portalUrl,
    // This must remain API relative. Extension background code binds it to the configured API
    // origin after independently loading this owned application, so an account-controlled portal
    // URL can never redirect the authenticated fill-data request.
    fill_data_url: `/applications/${row.id}/fill-data`,
    extension_required: true,
  };
}

async function canonicalApplicationForExactAttempt(
  executor: Pick<typeof db, 'select'>,
  userId: string,
  requestedApplicationId: string,
  attemptId: string,
): Promise<typeof applications.$inferSelect | null> {
  const [exact] = await executor.select().from(applications).where(and(
    eq(applications.id, requestedApplicationId),
    eq(applications.user_id, userId),
  )).limit(1);
  if (exact) return exact;
  const [opening] = await executor.select().from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, userId),
    eq(application_submission_attempt_events.attempt_id, attemptId),
    eq(application_submission_attempt_events.event_kind, 'attempt_opened'),
  )).limit(1);
  if (!opening || (opening.application_id !== requestedApplicationId && opening.packet_id !== requestedApplicationId)) {
    return null;
  }
  const owned = await executor.select().from(applications).where(eq(applications.user_id, userId));
  const aliases = owned.filter((row) => canonicalAttemptEventMatchesApplication(opening, row));
  return aliases.length === 1 ? aliases[0]! : null;
}

async function ownedApplication(request: FastifyRequest, reply: FastifyReply, attemptId?: string) {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid application id' });
    return null;
  }
  const application = attemptId
    ? await canonicalApplicationForExactAttempt(
      db,
      request.jwtPayload!.userId,
      parsed.data.id,
      attemptId,
    )
    : (await db.select().from(applications).where(and(
      eq(applications.id, parsed.data.id),
      eq(applications.user_id, request.jwtPayload!.userId),
    )).limit(1))[0];
  if (!application) {
    reply.status(404).send({ error: 'Application not found' });
    return null;
  }
  return application;
}

export async function canonicalApplicationRoutes(fastify: FastifyInstance) {
  fastify.get('/applications', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = listSchema.safeParse(request.query ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid application list request' });
    const userId = request.jwtPayload!.userId;
    const [rows, attemptEvents] = await Promise.all([
      db.select().from(applications).where(eq(
        applications.user_id,
        userId,
      )).orderBy(desc(applications.updated_at)).limit(parsed.data.limit),
      submissionAttemptEventsForUser(userId),
    ]);
    return reply.header('Cache-Control', 'private, no-store').send({
      applications: rows.map((row) => {
        return {
          ...applicationResponse(row),
          retry_safety: submissionAttemptRetrySafetyForPacketEvents(
            attemptEvents.filter((event) => canonicalAttemptEventMatchesApplication(event, row)),
          ),
        };
      }),
    });
  });

  // This route is deliberately outside every premium gate. A canonical application is the Free
  // execution record and must exist before a user chooses whether to generate anything.
  fastify.post('/applications', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createApplicationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid application', detail: parsed.error.issues });
    const userId = request.jwtPayload!.userId;
    let portalUrl: string | null;
    try {
      portalUrl = canonicalPortalUrl(parsed.data.portal_url);
    } catch (error) {
      return reply.status(400).send({ error: error instanceof Error ? error.message : 'Invalid portal URL' });
    }
    const companyScopeKey = canonicalCompanyScope({
      companyId: parsed.data.company_id,
      domain: parsed.data.company_domain,
      companyName: parsed.data.company,
    });
    const result = await upsertCanonicalApplicationForUser({
      userId,
      jobId: parsed.data.job_id,
      companyScopeKey,
      companyName: parsed.data.company,
      role: parsed.data.role,
      portalUrl,
      sourceSurface: parsed.data.source_surface ?? parsed.data.source ?? 'dashboard',
    });
    return reply.header('Cache-Control', 'private, no-store').status(result.created ? 201 : 200).send({
      application: applicationResponse(result.application),
      created: result.created,
      adopted: result.adopted,
    });
  });

  // This is the Free preparation contract consumed by the dashboard and extension. It records the
  // fill handoff and manual requirements. It never calls resume, answer, contact, or draft routes.
  fastify.post('/applications/:id/fill', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = fillApplicationSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid fill request', detail: parsed.error.issues });
    const application = await ownedApplication(request, reply);
    if (!application) return;
    const userId = request.jwtPayload!.userId;
    let selectedResumeArtifactId = application.selected_resume_artifact_id;
    if (parsed.data.selected_resume_artifact_id !== undefined) {
      if (parsed.data.selected_resume_artifact_id) {
        const [artifact] = await db.select({ id: artifacts.id, kind: artifacts.kind }).from(artifacts).where(and(
          eq(artifacts.id, parsed.data.selected_resume_artifact_id),
          eq(artifacts.user_id, userId),
          isNull(artifacts.deleted_at),
        )).limit(1);
        if (!artifact || !isResumeArtifactKind(artifact.kind)) return reply.status(404).send({ error: 'Resume document not found' });
      }
      selectedResumeArtifactId = parsed.data.selected_resume_artifact_id;
    }
    let resumeAttached = application.resume_attached;
    let resumeSource = application.resume_source as 'artifact' | 'base_resume' | 'none';
    if (parsed.data.resume_attached !== undefined && parsed.data.resume_source !== undefined) {
      resumeAttached = parsed.data.resume_attached;
      resumeSource = parsed.data.resume_source;
      if (resumeAttached && resumeSource === 'artifact' && !selectedResumeArtifactId) {
        return reply.status(400).send({
          error: 'selected_resume_artifact_id is required when an artifact resume was attached',
          code: 'resume_artifact_required',
        });
      }
      if (resumeAttached && resumeSource === 'artifact' && selectedResumeArtifactId) {
        const [artifact] = await db.select({ id: artifacts.id, kind: artifacts.kind }).from(artifacts).where(and(
          eq(artifacts.id, selectedResumeArtifactId),
          eq(artifacts.user_id, userId),
          isNull(artifacts.deleted_at),
        )).limit(1);
        if (!artifact || !isResumeArtifactKind(artifact.kind)) {
          return reply.status(404).send({ error: 'Resume document not found', code: 'resume_artifact_missing' });
        }
      }
      if (resumeAttached && resumeSource === 'base_resume') {
        const [baseProfile] = await db.select({ base_resume_json: profiles.base_resume_json })
          .from(profiles).where(eq(profiles.user_id, userId)).limit(1);
        if (!baseProfile?.base_resume_json) {
          return reply.status(409).send({ error: 'No saved main resume is available', code: 'base_resume_missing' });
        }
        selectedResumeArtifactId = null;
      }
    }
    const resumeAttachedAt = parsed.data.resume_attached === undefined
      ? application.resume_attached_at
      : resumeAttached ? new Date() : null;
    const updated = await updateCanonicalApplicationAfterFill(db, {
      applicationId: application.id,
      userId,
      selectedResumeArtifactId,
      resumeAttached,
      resumeSource,
      resumeAttachedAt,
    });
    const [account, entitlement] = await Promise.all([
      db.select({ automatic_submission_enabled: users.automatic_submission_enabled })
        .from(users).where(eq(users.id, userId)).limit(1),
      getEntitlementSnapshot(userId),
    ]);
    const automaticSubmissionAvailable = entitlement.features.automatic_submission;
    const automaticSubmissionEnabled = automaticSubmissionAvailable
      && account[0]?.automatic_submission_enabled === true;
    const unanswered = parsed.data.unanswered_questions ?? 0;
    const needsUser = [
      ...(resumeAttached ? [] : ['resume_attachment']),
      ...(unanswered > 0 ? ['open_questions'] : []),
      ...(automaticSubmissionEnabled ? [] : ['final_submit']),
    ];
    return reply.header('Cache-Control', 'private, no-store').status(200).send({
      application_id: application.id,
      status: 'ready_for_fill',
      application_fill: true,
      automatic_submission_available: automaticSubmissionAvailable,
      automatic_submission_enabled: automaticSubmissionEnabled,
      automatic_submission_allowed: automaticSubmissionEnabled,
      requires_final_submit: !automaticSubmissionEnabled,
      needs_user: needsUser,
      unanswered_questions: unanswered,
      selected_resume_artifact_id: selectedResumeArtifactId,
      resume_attached: resumeAttached,
      resume_source: resumeSource,
      application: applicationResponse(updated ?? application),
      handoff: fillHandoffResponse(updated ?? application),
    });
  });

  /* Reserve the Free extension's manual employer boundary before the form is filled.
   *
   * The click remains the applicant's native trusted click, but it cannot race an automatic Litos
   * attempt. GET_FREE_FILL_DATA waits for this response before it gives the content script any data
   * to put on the employer page. The opening fact is created under the same user lock as automatic
   * claims and duplicate checks. A page reload may resume one exact pre-click manual attempt; once
   * a press or confirmation exists, it can never be reused for another click. */
  fastify.post('/applications/:id/manual-submission-start', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = manualSubmissionStartSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid manual submission reservation',
        code: 'invalid_submission_reservation',
        detail: parsed.error.issues,
      });
    }
    const application = await ownedApplication(request, reply, parsed.data.event_id);
    if (!application) return;
    const requestedApplicationId = paramsSchema.parse(request.params).id;
    const userId = request.jwtPayload!.userId;
    let currentUrl: string;
    try {
      currentUrl = canonicalPortalUrl(parsed.data.current_url, true)!;
      if (!application.portal_url) throw new Error('Application portal URL is required');
      if (canonicalPortalIdentity(currentUrl) !== canonicalPortalIdentity(application.portal_url)) {
        return reply.status(409).send({
          error: 'Manual submission page does not match this application portal',
          code: 'portal_identity_mismatch',
          retry_safety: await canonicalSubmissionRetrySafety(application),
        });
      }
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : 'Manual submission page is not safe',
        code: 'unsafe_submission_reservation_url',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }

    const result = await db.transaction(async (tx) => {
      await lockSubmissionAttemptUser(tx, userId);
      const currentApplication = await canonicalApplicationForExactAttempt(
        tx,
        userId,
        paramsSchema.parse(request.params).id,
        parsed.data.event_id,
      );
      if (!currentApplication) return { kind: 'not_found' as const };
      if (currentApplication.submission_state === 'submitted' || currentApplication.tracker_state === 'applied') {
        return { kind: 'already_submitted' as const };
      }

      const exactEvents = await tx.select().from(application_submission_attempt_events).where(and(
        eq(application_submission_attempt_events.user_id, userId),
        eq(application_submission_attempt_events.attempt_id, parsed.data.event_id),
      ));
      if (exactEvents.length > 0) {
        const opening = exactEvents.find((event) => event.event_kind === 'attempt_opened');
        if (!opening
          || !(await canonicalAttemptEventMayMutateApplication(tx, userId, opening, currentApplication))
          || opening.source !== 'chrome_extension'
          || opening.operation !== 'manual_submission') {
          return { kind: 'event_conflict' as const };
        }
        if (!manualSubmissionPostingMatches(
          frozenPostingIdentityFromEvent(opening),
          currentApplication,
          currentUrl,
        )) return { kind: 'posting_mismatch' as const };
        const safety = submissionAttemptRetrySafety(exactEvents);
        if (safety.kind === 'blocked_unverified' && safety.reason === 'opened') {
          const duplicate = await duplicateApplicationVerdict({
            userId,
            applicationId: currentApplication.legacy_generated_resume_id ?? currentApplication.id,
            jobContext: {
              company: currentApplication.company_name,
              role: currentApplication.role,
              job_id: currentApplication.job_id,
            },
            portalUrl: currentApplication.portal_url,
            excludeAttemptId: parsed.data.event_id,
          }, tx);
          if (duplicate.kind !== 'clear') return { kind: 'duplicate' as const, duplicate };
          return { kind: 'started' as const, eventId: parsed.data.event_id, resumed: true };
        }
        return { kind: 'attempt_terminal' as const };
      }

      const blocking = await blockingSubmissionAttemptsForUser(userId, { executor: tx });
      const resumable = blocking.filter((attempt) => attempt.applicationId === currentApplication.id
        && attempt.source === 'chrome_extension'
        && attempt.operation === 'manual_submission'
        && attempt.retrySafety.kind === 'blocked_unverified'
        && attempt.retrySafety.reason === 'opened');
      /* A tab owns only the UUID it requested. Returning another tab's opened attempt would let
       * two independent page capabilities share one ledger boundary. Exact same-event retries were
       * handled above; every different UUID must remain blocked without exposing the winner. */
      if (resumable.length > 0) return { kind: 'attempt_terminal' as const };

      const storedPosting = freezePostingIdentity({
        company: currentApplication.company_name,
        role: currentApplication.role,
        job_id: currentApplication.job_id,
      }, currentApplication.portal_url);
      if (!manualSubmissionPostingMatches(storedPosting, currentApplication, currentUrl)) {
        return { kind: 'posting_mismatch' as const };
      }

      const duplicate = await duplicateApplicationVerdict({
        userId,
        applicationId: currentApplication.legacy_generated_resume_id ?? currentApplication.id,
        jobContext: {
          company: currentApplication.company_name,
          role: currentApplication.role,
          job_id: currentApplication.job_id,
        },
        portalUrl: currentApplication.portal_url,
      }, tx);
      if (duplicate.kind !== 'clear') return { kind: 'duplicate' as const, duplicate };

      const binding: SubmissionAttemptBinding = {
        attemptId: parsed.data.event_id,
        userId,
        packetId: currentApplication.legacy_generated_resume_id ?? currentApplication.id,
        applicationId: currentApplication.id,
        source: 'chrome_extension',
        operation: 'manual_submission',
        postingIdentity: freezePostingIdentity({
          company: currentApplication.company_name,
          role: currentApplication.role,
          job_id: currentApplication.job_id,
        }, currentUrl),
      };
      await appendSubmissionAttemptEvent({
        ...binding,
        eventId: submissionAttemptEventId(binding.attemptId, 'attempt_opened', 'canonical-manual-reservation'),
        eventKind: 'attempt_opened',
        evidenceCode: 'canonical_manual_submit_reserved',
      }, { executor: tx });
      return { kind: 'started' as const, eventId: binding.attemptId, resumed: false };
    });

    const retrySafety = await canonicalSubmissionRetrySafety(application);
    if (result.kind === 'not_found') {
      return reply.status(404).send({ error: 'Application not found', retry_safety: retrySafety });
    }
    if (result.kind === 'already_submitted') {
      return reply.status(409).send({
        error: 'This application is already recorded as submitted.',
        code: 'application_already_submitted',
        retry_safety: retrySafety,
      });
    }
    if (result.kind === 'event_conflict') {
      return reply.status(409).send({
        error: 'This manual submission reservation belongs to another attempt.',
        code: 'submission_event_binding_conflict',
        retry_safety: retrySafety,
      });
    }
    if (result.kind === 'posting_mismatch') {
      return reply.status(409).send({
        error: 'This page is not the exact posting bound to the manual submission reservation.',
        code: 'manual_submission_posting_mismatch',
        retry_safety: retrySafety,
      });
    }
    if (result.kind === 'attempt_terminal') {
      return reply.status(409).send({
        error: 'An earlier manual attempt may already have reached the employer. Resolve it before trying again.',
        code: 'manual_submission_outcome_unresolved',
        retry_safety: retrySafety,
      });
    }
    if (result.kind === 'duplicate') {
      const refusal = result.duplicate.kind === 'duplicate'
        ? duplicateApplicationResponse(result.duplicate)
        : unidentifiableDuplicateApplicationResponse(result.duplicate);
      return reply.status(409).send({ ...refusal, retry_safety: retrySafety });
    }
    return reply.header('Cache-Control', 'private, no-store').send({
      application_id: requestedApplicationId,
      canonical_application_id: application.id,
      event_id: parsed.data.event_id,
      resumed: result.resumed,
      retry_safety: retrySafety,
    });
  });

  /* Recheck the exact still-open manual reservation under the user lock immediately before the
   * extension replays the applicant's intercepted final activation. This endpoint records no press:
   * the employer boundary still has not happened, so a rejected acknowledgement remains provably
   * cancellable as not sent. */
  fastify.post('/applications/:id/manual-submission-preflight', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = manualSubmissionPreflightSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid manual submission preflight',
        code: 'invalid_manual_submission_preflight',
        detail: parsed.error.issues,
      });
    }
    const application = await ownedApplication(request, reply, parsed.data.event_id);
    if (!application) return;
    const requestedApplicationId = paramsSchema.parse(request.params).id;
    const userId = request.jwtPayload!.userId;
    let currentUrl: string;
    try {
      currentUrl = canonicalPortalUrl(parsed.data.current_url, true)!;
      if (!application.portal_url) throw new Error('Application portal URL is required');
      if (canonicalPortalIdentity(currentUrl) !== canonicalPortalIdentity(application.portal_url)) {
        return reply.status(409).send({
          error: 'Manual submission page does not match this application portal',
          code: 'portal_identity_mismatch',
          retry_safety: await canonicalSubmissionRetrySafety(application),
        });
      }
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : 'Manual submission page is not safe',
        code: 'unsafe_manual_submission_preflight_url',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }

    const result = await db.transaction(async (tx) => {
      await lockSubmissionAttemptUser(tx, userId);
      const currentApplication = await canonicalApplicationForExactAttempt(
        tx,
        userId,
        paramsSchema.parse(request.params).id,
        parsed.data.event_id,
      );
      if (!currentApplication) return { kind: 'not_found' as const };
      if (currentApplication.submission_state === 'submitted' || currentApplication.tracker_state === 'applied') {
        return { kind: 'already_submitted' as const };
      }
      const exactEvents = await tx.select().from(application_submission_attempt_events).where(and(
        eq(application_submission_attempt_events.user_id, userId),
        eq(application_submission_attempt_events.attempt_id, parsed.data.event_id),
      ));
      const opening = exactEvents.find((event) => event.event_kind === 'attempt_opened');
      if (!opening
        || !(await canonicalAttemptEventMayMutateApplication(tx, userId, opening, currentApplication))
        || opening.source !== 'chrome_extension'
        || opening.operation !== 'manual_submission') {
        return { kind: 'binding_conflict' as const };
      }
      if (!manualSubmissionPostingMatches(
        frozenPostingIdentityFromEvent(opening),
        currentApplication,
        currentUrl,
      )) return { kind: 'posting_mismatch' as const };
      const retrySafety = submissionAttemptRetrySafety(exactEvents);
      if (
        retrySafety.kind !== 'blocked_unverified'
        || (retrySafety.reason !== 'opened' && retrySafety.reason !== 'boundary_authorized')
      ) {
        return { kind: 'attempt_terminal' as const, retrySafety };
      }
      const existingAuthorization = await manualSubmissionBoundaryAuthorization(
        tx,
        userId,
        parsed.data.event_id,
      );
      if (existingAuthorization && existingAuthorization.activationId !== parsed.data.activation_id) {
        return { kind: 'activation_conflict' as const, retrySafety };
      }
      if (existingAuthorization && !existingAuthorization.active) {
        return {
          kind: 'authorization_expired' as const,
          retrySafety,
          authorization: existingAuthorization,
        };
      }
      const duplicate = await duplicateApplicationVerdict({
        userId,
        applicationId: currentApplication.legacy_generated_resume_id ?? currentApplication.id,
        jobContext: {
          company: currentApplication.company_name,
          role: currentApplication.role,
          job_id: currentApplication.job_id,
        },
        portalUrl: currentApplication.portal_url ?? currentUrl,
        excludeAttemptId: parsed.data.event_id,
      }, tx);
      if (duplicate.kind !== 'clear') return { kind: 'duplicate' as const, duplicate, retrySafety };
      let authorization = existingAuthorization;
      if (!authorization) {
        const binding = submissionAttemptBindingFromEvent(opening);
        const clockResult = await tx.execute(sql`select clock_timestamp() as authorized_at`);
        const clockValue = (clockResult.rows[0] as { authorized_at?: Date | string } | undefined)?.authorized_at;
        const authorizedAt = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
        if (Number.isNaN(authorizedAt.getTime())) throw new Error('Database authorization clock was unavailable');
        const boundaryExpiresAt = new Date(
          authorizedAt.getTime() + MANUAL_SUBMISSION_BOUNDARY_AUTHORIZATION_TTL_MS,
        );
        await appendSubmissionAttemptEvent({
          ...binding,
          eventId: submissionAttemptEventId(
            binding.attemptId,
            'boundary_authorized',
            'canonical-manual-preflight',
          ),
          eventKind: 'boundary_authorized',
          evidenceCode: 'canonical_manual_boundary_authorized',
          boundaryActivationId: parsed.data.activation_id,
          boundaryExpiresAt,
          observedAt: authorizedAt,
          createdAt: authorizedAt,
        }, { executor: tx });
      }
      // The duplicate check and a contended lock can consume part of a short lease. Re-read the
      // database clock immediately before echoing either a fresh or idempotently replayed lease.
      authorization = await manualSubmissionBoundaryAuthorization(tx, userId, parsed.data.event_id);
      if (!authorization) return { kind: 'binding_conflict' as const };
      if (!authorization.active) {
        return { kind: 'authorization_expired' as const, retrySafety, authorization };
      }
      const authorizedEvents = await tx.select().from(application_submission_attempt_events).where(and(
        eq(application_submission_attempt_events.user_id, userId),
        eq(application_submission_attempt_events.attempt_id, parsed.data.event_id),
      ));
      return {
        kind: 'authorized' as const,
        retrySafety: submissionAttemptRetrySafety(authorizedEvents),
        authorization,
      };
    });

    if (result.kind === 'not_found') {
      return reply.status(404).send({
        error: 'Application not found',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }
    if (result.kind === 'already_submitted') {
      return reply.status(409).send({
        error: 'This application is already recorded as submitted.',
        code: 'application_already_submitted',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }
    if (result.kind === 'binding_conflict') {
      return reply.status(409).send({
        error: 'This manual submission acknowledgement belongs to another attempt.',
        code: 'submission_event_binding_conflict',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }
    if (result.kind === 'posting_mismatch') {
      return reply.status(409).send({
        error: 'The current employer page is not the exact posting bound to this reservation.',
        code: 'manual_submission_posting_mismatch',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }
    if (result.kind === 'attempt_terminal') {
      return reply.status(409).send({
        error: 'This manual submission attempt is no longer open before the employer boundary.',
        code: 'manual_submission_preflight_not_open',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'activation_conflict') {
      return reply.status(409).send({
        error: 'Another page delegate already owns this final submission authorization.',
        code: 'manual_submission_boundary_activation_conflict',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'authorization_expired') {
      return reply.status(409).send({
        error: 'The final submission authorization expired before the employer boundary.',
        code: 'manual_submission_boundary_authorization_expired',
        lease_id: result.authorization.leaseId,
        attempt_id: result.authorization.attemptId,
        activation_id: result.authorization.activationId,
        authorized_at: result.authorization.authorizedAt,
        expires_at: result.authorization.expiresAt,
        server_now: result.authorization.serverNow,
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'duplicate') {
      const refusal = result.duplicate.kind === 'duplicate'
        ? duplicateApplicationResponse(result.duplicate)
        : unidentifiableDuplicateApplicationResponse(result.duplicate);
      return reply.status(409).send({ ...refusal, retry_safety: result.retrySafety });
    }
    return reply.header('Cache-Control', 'private, no-store').send({
      application_id: requestedApplicationId,
      canonical_application_id: application.id,
      event_id: parsed.data.event_id,
      lease_id: result.authorization.leaseId,
      attempt_id: result.authorization.attemptId,
      activation_id: result.authorization.activationId,
      authorized_at: result.authorization.authorizedAt,
      expires_at: result.authorization.expiresAt,
      server_now: result.authorization.serverNow,
      authorized: true,
      retry_safety: result.retrySafety,
    });
  });

  /* Resolve one exact manual attempt only after the applicant has checked the employer portal.
   * This never sends anything. It appends the applicant's observation to the immutable ledger, so
   * clearing a mutable application state cannot erase the evidence or release a different attempt. */
  fastify.post('/applications/:id/manual-submission-resolution', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = manualSubmissionResolutionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Say whether you found this exact application, with found true or false.',
        code: 'invalid_submission_resolution',
        detail: parsed.error.issues,
      });
    }
    const application = await ownedApplication(request, reply, parsed.data.attempt_id);
    if (!application) return;
    const requestedApplicationId = paramsSchema.parse(request.params).id;
    const userId = request.jwtPayload!.userId;

    const result = await db.transaction(async (tx) => {
      await lockSubmissionAttemptUser(tx, userId);
      const currentApplication = await canonicalApplicationForExactAttempt(
        tx,
        userId,
        paramsSchema.parse(request.params).id,
        parsed.data.attempt_id,
      );
      if (!currentApplication) return { kind: 'not_found' as const };

      const events = await tx.select().from(application_submission_attempt_events).where(and(
        eq(application_submission_attempt_events.user_id, userId),
        eq(application_submission_attempt_events.attempt_id, parsed.data.attempt_id),
      ));
      const opening = events.find((event) => event.event_kind === 'attempt_opened');
      const exactManualAttempt = opening?.operation === 'manual_submission'
        && (opening.source === 'chrome_extension' || opening.source === 'legacy_backfill');
      const exactLegacyGeneratedAttempt = opening?.source === 'legacy_backfill'
        && opening.operation === 'initial_submission'
        && Boolean(currentApplication.legacy_generated_resume_id)
        && opening.packet_id === currentApplication.legacy_generated_resume_id;
      if (!opening
        || !(await canonicalAttemptEventMayMutateApplication(tx, userId, opening, currentApplication))
        || (!exactManualAttempt && !exactLegacyGeneratedAttempt)) {
        return {
          kind: 'binding_conflict' as const,
          retrySafety: await canonicalSubmissionRetrySafety(currentApplication, tx),
        };
      }

      const exactSafety = submissionAttemptRetrySafety(events);
      const machinePreClickCleanup = parsed.data.reason === 'extension_cancelled_before_press';
      /* Boundary authorization is an irreversible uncertainty boundary for canonical Free manual
       * attempts. Its TTL limits use of the capability, not the lifetime of the risk fact. Read the
       * immutable event directly so an expired or malformed lease can never make a negative answer
       * append not_sent_proven. A positive observation remains admissible for the exact attempt. */
      const boundaryAuthorizationEvent = events.find(
        (event) => event.event_kind === 'boundary_authorized',
      );
      const exactBoundaryAuthorization = boundaryAuthorizationEvent
        && await canonicalAttemptEventMayMutateApplication(
          tx,
          userId,
          boundaryAuthorizationEvent,
          currentApplication,
        )
        && boundaryAuthorizationEvent.source === opening.source
        && boundaryAuthorizationEvent.operation === opening.operation;
      const authorization = await manualSubmissionBoundaryAuthorization(
        tx,
        userId,
        parsed.data.attempt_id,
      );
      const suppliedLeaseId = parsed.data.lease_id ?? null;
      if (suppliedLeaseId) {
        return { kind: 'lease_conflict' as const, retrySafety: exactSafety };
      }
      if (machinePreClickCleanup && boundaryAuthorizationEvent) {
        return {
          kind: 'authorization_not_cancellable' as const,
          retrySafety: exactSafety,
        };
      }
      if (!parsed.data.found && boundaryAuthorizationEvent) {
        return {
          kind: 'authorization_present' as const,
          retrySafety: exactSafety,
          authorization,
        };
      }
      if (!parsed.data.found
        && exactSafety.kind === 'blocked_unverified'
        && exactAttemptPermanentlyBlocksNegativeResolution(events, parsed.data.attempt_id)) {
        return {
          kind: 'permanent_risk' as const,
          retrySafety: exactSafety,
        };
      }
      const machinePreClickCleanupReplay = machinePreClickCleanup
        && opening.source === 'chrome_extension'
        && exactSafety.kind === 'safe_not_sent'
        && exactSafety.proofKind === 'extension_cancelled_before_press';
      if (machinePreClickCleanup && !machinePreClickCleanupReplay && (
        opening.source !== 'chrome_extension'
        || parsed.data.found
        || exactSafety.kind !== 'blocked_unverified'
        || exactSafety.reason !== 'opened'
        || events.some((event) => event.event_kind !== 'attempt_opened')
      )) {
        return { kind: 'not_resolvable' as const, retrySafety: exactSafety };
      }
      const decision = manualSubmissionResolutionDecision(exactSafety, parsed.data.found);
      if (decision === 'terminal_conflict') {
        return { kind: 'terminal_conflict' as const, retrySafety: exactSafety };
      }
      const exactBoundaryConfirmation = parsed.data.found
        && Boolean(exactBoundaryAuthorization)
        && exactSafety.kind === 'blocked_unverified';
      if (decision === 'not_resolvable' && !exactBoundaryConfirmation) {
        return { kind: 'not_resolvable' as const, retrySafety: exactSafety };
      }
      if (decision === 'exact_replay') {
        return {
          kind: 'resolved' as const,
          idempotent: true,
          application: currentApplication,
          retrySafety: exactSafety,
        };
      }

      const binding = submissionAttemptBindingFromEvent(opening);
      const eventKind = parsed.data.found ? 'submission_confirmed' as const : 'not_sent_proven' as const;
      const proofKind = machinePreClickCleanup
        ? 'extension_cancelled_before_press' as const
        : 'applicant_checked_not_sent' as const;
      const evidenceCode = machinePreClickCleanup
        ? 'extension_cancelled_before_press'
        : parsed.data.found ? 'applicant_found_submission' : 'applicant_checked_not_sent';
      const nextSubmissionState = parsed.data.found ? 'submitted' : 'needs_attention';
      const nextTrackerState = parsed.data.found ? 'applied' : 'applying';
      const [updatedApplication] = await tx.update(applications).set({
        submission_state: nextSubmissionState,
        tracker_state: nextTrackerState,
        updated_at: new Date(),
      }).where(and(
        eq(applications.id, currentApplication.id),
        eq(applications.user_id, userId),
        eq(applications.submission_state, currentApplication.submission_state),
        eq(applications.tracker_state, currentApplication.tracker_state),
      )).returning();
      if (!updatedApplication) return { kind: 'state_conflict' as const };
      await appendSubmissionAttemptEvent({
        ...binding,
        eventId: submissionAttemptEventId(
          binding.attemptId,
          eventKind,
          machinePreClickCleanup ? 'extension-cancelled-before-press' : 'applicant-resolution',
        ),
        eventKind,
        ...(parsed.data.found ? {} : { proofKind }),
        evidenceCode,
      }, { executor: tx });
      const updatedEvents = await tx.select().from(application_submission_attempt_events).where(and(
        eq(application_submission_attempt_events.user_id, userId),
        eq(application_submission_attempt_events.attempt_id, parsed.data.attempt_id),
      ));
      return {
        kind: 'resolved' as const,
        idempotent: false,
        application: updatedApplication,
        retrySafety: submissionAttemptRetrySafety(updatedEvents),
      };
    });

    if (result.kind === 'not_found') return reply.status(404).send({
      error: 'Application not found',
      retry_safety: await canonicalSubmissionRetrySafety(application),
    });
    if (result.kind === 'binding_conflict') {
      return reply.status(409).send({
        error: 'That answer belongs to a different manual submission attempt.',
        code: 'submission_event_binding_conflict',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'lease_conflict') {
      return reply.status(409).send({
        error: 'That boundary authorization does not belong to this manual submission attempt.',
        code: 'manual_submission_boundary_lease_mismatch',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'authorization_present') {
      return reply.status(409).send({
        error: 'This exact attempt crossed the final authorization boundary, so it cannot be recorded as not sent. Confirm it only if you found evidence that it was submitted.',
        code: 'manual_submission_boundary_authorized',
        ...(result.authorization ? {
          lease_id: result.authorization.leaseId,
          attempt_id: result.authorization.attemptId,
          authorized_at: result.authorization.authorizedAt,
          expires_at: result.authorization.expiresAt,
        } : {}),
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'authorization_not_cancellable') {
      return reply.status(409).send({
        error: 'A final boundary authorization was issued, so the extension cannot mark this attempt not sent.',
        code: 'manual_submission_boundary_not_machine_cancellable',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'permanent_risk') {
      return reply.status(409).send({
        error: 'This exact attempt crossed the employer submission boundary and cannot be marked not sent. Confirm it only if you found evidence that it was submitted.',
        code: 'manual_submission_permanent_duplicate_risk',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'terminal_conflict') {
      return reply.status(409).send({
        error: 'This attempt already has contradictory terminal evidence and remains blocked.',
        code: 'submission_resolution_terminal_conflict',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'not_resolvable') {
      return reply.status(409).send({
        error: 'This attempt does not have a valid unresolved sequence to resolve.',
        code: 'submission_attempt_not_resolvable',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'state_conflict') {
      return reply.status(409).send({
        error: 'This application changed while the answer was being recorded. Reload it first.',
        code: 'submission_resolution_state_conflict',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }
    const aggregateRetrySafety = await canonicalSubmissionRetrySafety(result.application);
    return reply.header('Cache-Control', 'private, no-store').send({
      application_id: requestedApplicationId,
      canonical_application_id: result.application.id,
      attempt_id: parsed.data.attempt_id,
      found: parsed.data.found,
      idempotent: result.idempotent,
      retry_safety: aggregateRetrySafety,
      resolved_attempt_retry_safety: result.retrySafety,
      application: applicationResponse(result.application),
    });
  });

  // The extension observes the native employer submission result after a user-initiated click and
  // records it here. This is Free tracking, never automatic submission, and therefore deliberately
  // has no premium feature gate or usage reservation.
  fastify.post('/applications/:id/manual-submission-outcome', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = manualSubmissionOutcomeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: 'Invalid manual submission outcome',
        code: 'invalid_submission_outcome',
        detail: parsed.error.issues,
      });
    }
    const application = await ownedApplication(request, reply, parsed.data.event_id);
    if (!application) return;
    const requestedApplicationId = paramsSchema.parse(request.params).id;
    const userId = request.jwtPayload!.userId;
    let finalUrl: string;
    let portalIdentity: string;
    try {
      finalUrl = canonicalPortalUrl(parsed.data.final_url, true)!;
      if (!application.portal_url) throw new Error('Application portal URL is required');
      portalIdentity = canonicalPortalIdentity(application.portal_url);
      if (canonicalPortalIdentity(finalUrl) !== portalIdentity) {
        return reply.status(409).send({
          error: 'Submission outcome URL does not match this application portal',
          code: 'portal_identity_mismatch',
          retry_safety: await canonicalSubmissionRetrySafety(application),
        });
      }
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : 'Submission outcome URL is not safe',
        code: 'unsafe_submission_outcome_url',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }

    type OutcomeResult = {
      idempotent: boolean;
      event: typeof application_submission_events.$inferSelect;
      application: typeof applications.$inferSelect;
      retrySafety: SubmissionAttemptRetrySafety;
    };
    try {
      const runManualSubmissionOutcomeTransaction = (database: typeof db) => database.transaction(async (tx): Promise<OutcomeResult> => {
        // Share the same user-wide lock as every automatic reservation. A manual receipt and an
        // automatic retry for an alias of the same posting must never pass each other unseen.
        await lockSubmissionAttemptUser(tx, userId);
        const currentApplication = await canonicalApplicationForExactAttempt(
          tx,
          userId,
          paramsSchema.parse(request.params).id,
          parsed.data.event_id,
        );
        if (!currentApplication) {
          throw Object.assign(new Error('Application not found'), { statusCode: 404, code: 'application_not_found' });
        }
        const exactAttemptEvents = await tx.select()
          .from(application_submission_attempt_events)
          .where(and(
            eq(application_submission_attempt_events.user_id, userId),
            eq(application_submission_attempt_events.attempt_id, parsed.data.event_id),
          ));
        const boundaryAuthorization = exactAttemptEvents.find(
          (event) => event.event_kind === 'boundary_authorized',
        );
        const boundaryLeaseMismatch = (
          (boundaryAuthorization && (
            parsed.data.lease_id !== boundaryAuthorization.event_id
            || parsed.data.activation_id !== boundaryAuthorization.boundary_activation_id
          ))
          || (!boundaryAuthorization && (parsed.data.lease_id || parsed.data.activation_id))
        );
        if (boundaryLeaseMismatch && parsed.data.outcome !== 'confirmed') {
          throw Object.assign(new Error('The outcome does not match this attempt boundary authorization'), {
            statusCode: 409,
            code: 'manual_submission_boundary_lease_mismatch',
          });
        }
        const exactRetrySafety = submissionAttemptRetrySafety(exactAttemptEvents);
        /* A delayed unknown or failed callback is not evidence that an already proved pre-click
         * cancellation crossed the employer boundary. Reject it before the mutable event row or
         * immutable press fact can be written. A confirmed receipt is different: it is stronger
         * positive evidence, so it must be preserved even when it contradicts the earlier check. */
        if (exactRetrySafety.kind === 'safe_not_sent' && parsed.data.outcome !== 'confirmed') {
          throw Object.assign(new Error('This manual submission attempt was already proved not sent'), {
            statusCode: 409,
            code: 'manual_submission_attempt_already_not_sent',
          });
        }
        const [existing] = await tx.select().from(application_submission_events).where(and(
          eq(application_submission_events.user_id, userId),
          eq(application_submission_events.event_id, parsed.data.event_id),
        )).limit(1);
        const confirmationText = parsed.data.confirmation_text ?? null;
        if (existing) {
          const decision = manualOutcomeEventDecision(existing, {
            applicationId: currentApplication.id,
            portalIdentity,
            outcome: parsed.data.outcome,
            finalUrl,
            confirmationText,
          });
          if (decision === 'binding_conflict') {
            throw Object.assign(new Error('This event id belongs to another application'), {
              statusCode: 409,
              code: 'submission_event_binding_conflict',
            });
          }
          if (decision === 'exact_replay') {
            await appendCanonicalManualSubmissionFacts({
              tx,
              application: currentApplication,
              userId,
              clientEventId: parsed.data.event_id,
              outcome: parsed.data.outcome,
              finalUrl,
            });
            return {
              idempotent: true,
              event: existing,
              application: currentApplication,
              retrySafety: await canonicalSubmissionRetrySafety(currentApplication, tx),
            };
          }
          if (decision === 'terminal_conflict') {
            throw Object.assign(new Error('A terminal submission event cannot be changed'), {
              statusCode: 409,
              code: 'submission_event_terminal',
            });
          }
          const transition = manualSubmissionTransition(currentApplication.submission_state, parsed.data.outcome);
          const now = new Date();
          const [updatedApplication] = await tx.update(applications).set({
            submission_state: transition.submissionState,
            tracker_state: transition.trackerState,
            updated_at: now,
          }).where(and(
            eq(applications.id, currentApplication.id),
            eq(applications.user_id, userId),
          )).returning();
          const [promoted] = await tx.update(application_submission_events).set({
            outcome: parsed.data.outcome,
            final_url: finalUrl,
            confirmation_text: confirmationText,
            applied_submission_state: transition.submissionState,
            observed_at: now,
          }).where(eq(application_submission_events.id, existing.id)).returning();
          await appendCanonicalManualSubmissionFacts({
            tx,
            application: updatedApplication,
            userId,
            clientEventId: parsed.data.event_id,
            outcome: parsed.data.outcome,
            finalUrl,
          });
          return {
            idempotent: false,
            event: promoted,
            application: updatedApplication,
            retrySafety: await canonicalSubmissionRetrySafety(updatedApplication, tx),
          };
        }

        const transition = manualSubmissionTransition(currentApplication.submission_state, parsed.data.outcome);
        const now = new Date();
        const [updatedApplication] = await tx.update(applications).set({
          submission_state: transition.submissionState,
          tracker_state: transition.trackerState,
          updated_at: now,
        }).where(and(
          eq(applications.id, currentApplication.id),
          eq(applications.user_id, userId),
        )).returning();
        const [createdEvent] = await tx.insert(application_submission_events).values({
          user_id: userId,
          application_id: currentApplication.id,
          event_id: parsed.data.event_id,
          outcome: parsed.data.outcome,
          final_url: finalUrl,
          portal_identity: portalIdentity,
          confirmation_text: confirmationText,
          applied_submission_state: transition.submissionState,
          observed_at: now,
        }).returning();
        await appendCanonicalManualSubmissionFacts({
          tx,
          application: updatedApplication,
          userId,
          clientEventId: parsed.data.event_id,
          outcome: parsed.data.outcome,
          finalUrl,
        });
        return {
          idempotent: false,
          event: createdEvent,
          application: updatedApplication,
          retrySafety: await canonicalSubmissionRetrySafety(updatedApplication, tx),
        };
      });
      const result = await withReadOnlyRetry(
        () => runManualSubmissionOutcomeTransaction(db),
        {
          onRetry: (attempt) => request.log.warn(
            { attempt, applicationId: application.id, eventId: parsed.data.event_id },
            'Manual submission outcome transaction reached a read-only backend; retrying on a fresh pooled connection',
          ),
          onExhausted: () => withDedicatedDatabase((directDb) => {
            request.log.warn(
              { applicationId: application.id, eventId: parsed.data.event_id },
              'Pooled manual submission outcome transactions stayed read-only; retrying on the direct database endpoint',
            );
            return runManualSubmissionOutcomeTransaction(directDb);
          }),
        },
      );
      return reply.header('Cache-Control', 'private, no-store').send({
        application_id: requestedApplicationId,
        canonical_application_id: result.application.id,
        event_id: result.event.event_id,
        outcome: result.event.outcome,
        idempotent: result.idempotent,
        applied_submission_state: result.event.applied_submission_state,
        retry_safety: result.retrySafety,
        event: {
          event_id: result.event.event_id,
          outcome: result.event.outcome,
          final_url: result.event.final_url,
          confirmation_text: result.event.confirmation_text,
          observed_at: result.event.observed_at,
        },
        application: applicationResponse(result.application),
      });
    } catch (error) {
      const typed = error as Error & { statusCode?: number; code?: string };
      if (typed.statusCode && typed.code) {
        return reply.status(typed.statusCode).send({
          error: typed.message,
          code: typed.code,
          retry_safety: await canonicalSubmissionRetrySafety(application),
        });
      }
      throw error;
    }
  });

  // Free-safe attachment selection for the dashboard and extension. Generated or uploaded
  // artifacts use a short-lived capability URL. The saved base resume uses an authenticated render
  // URL that the extension background fetches with the account token before attaching the bytes.
  fastify.get('/applications/:id/fill-data', { preHandler: requireAuth }, async (request, reply) => {
    const parsedQuery = fillDataQuerySchema.safeParse(request.query ?? {});
    if (!parsedQuery.success) {
      const application = await ownedApplication(request, reply);
      if (!application) return;
      return reply.status(409).send({
        error: 'Reserve this exact manual submission before loading any fill data.',
        code: 'manual_submission_reservation_required',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }
    const application = await ownedApplication(request, reply, parsedQuery.data.event_id);
    if (!application) return;
    const requestedApplicationId = paramsSchema.parse(request.params).id;
    const userId = request.jwtPayload!.userId;
    const gate = await db.transaction(async (tx) => {
      await lockSubmissionAttemptUser(tx, userId);
      const currentApplication = await canonicalApplicationForExactAttempt(
        tx,
        userId,
        paramsSchema.parse(request.params).id,
        parsedQuery.data.event_id,
      );
      if (!currentApplication) return { kind: 'not_found' as const };
      const exactEvents = await tx.select().from(application_submission_attempt_events).where(and(
        eq(application_submission_attempt_events.user_id, userId),
        eq(application_submission_attempt_events.attempt_id, parsedQuery.data.event_id),
      ));
      const opening = exactEvents.find((event) => event.event_kind === 'attempt_opened');
      if (!opening
        || !(await canonicalAttemptEventMayMutateApplication(tx, userId, opening, currentApplication))
        || opening.source !== 'chrome_extension'
        || opening.operation !== 'manual_submission') {
        return { kind: 'binding_conflict' as const };
      }
      const retrySafety = submissionAttemptRetrySafety(exactEvents);
      if (retrySafety.kind !== 'blocked_unverified' || retrySafety.reason !== 'opened') {
        return { kind: 'attempt_terminal' as const, retrySafety };
      }
      const duplicate = await duplicateApplicationVerdict({
        userId,
        applicationId: currentApplication.legacy_generated_resume_id ?? currentApplication.id,
        jobContext: {
          company: currentApplication.company_name,
          role: currentApplication.role,
          job_id: currentApplication.job_id,
        },
        portalUrl: currentApplication.portal_url,
        excludeAttemptId: parsedQuery.data.event_id,
      }, tx);
      if (duplicate.kind !== 'clear') return { kind: 'duplicate' as const, duplicate, retrySafety };
      return { kind: 'allowed' as const, application: currentApplication, retrySafety };
    });
    if (gate.kind === 'not_found') {
      return reply.status(404).send({
        error: 'Application not found',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }
    if (gate.kind === 'binding_conflict') {
      return reply.status(409).send({
        error: 'This fill request is not bound to the active manual submission reservation.',
        code: 'submission_event_binding_conflict',
        retry_safety: await canonicalSubmissionRetrySafety(application),
      });
    }
    if (gate.kind === 'attempt_terminal') {
      return reply.status(409).send({
        error: 'This manual submission reservation is no longer safe to fill.',
        code: 'manual_submission_reservation_not_open',
        retry_safety: gate.retrySafety,
      });
    }
    if (gate.kind === 'duplicate') {
      const refusal = gate.duplicate.kind === 'duplicate'
        ? duplicateApplicationResponse(gate.duplicate)
        : unidentifiableDuplicateApplicationResponse(gate.duplicate);
      return reply.status(409).send({ ...refusal, retry_safety: gate.retrySafety });
    }
    const activeApplication = gate.application;
    // New writes are already normalized by POST /applications. This second check protects the
    // extension from historical or manually imported rows that predate that invariant.
    let portalUrl: string | null;
    try {
      portalUrl = canonicalPortalUrl(activeApplication.portal_url ?? undefined);
    } catch {
      return reply.status(409).send({
        error: 'This saved application does not have a safe HTTPS portal URL.',
        code: 'unsafe_portal_url',
        retry_safety: gate.retrySafety,
      });
    }
    const [selectedArtifact, baseProfile, entitlement, account] = await Promise.all([
      activeApplication.selected_resume_artifact_id
        ? db.select().from(artifacts).where(and(
          eq(artifacts.id, activeApplication.selected_resume_artifact_id),
          eq(artifacts.user_id, userId),
          isNull(artifacts.deleted_at),
        )).limit(1)
        : Promise.resolve([]),
      db.select({ base_resume_json: profiles.base_resume_json }).from(profiles).where(eq(profiles.user_id, userId)).limit(1),
      getEntitlementSnapshot(userId),
      db.select({ automatic_submission_enabled: users.automatic_submission_enabled })
        .from(users).where(eq(users.id, userId)).limit(1),
    ]);
    const artifact = selectedArtifact[0];
    const selectedResume = artifact?.rendered_object_key && isResumeArtifactKind(artifact.kind)
      ? {
        artifact_id: artifact.id,
        kind: artifact.kind,
        source: artifact.source,
        file_name: 'litos-resume.pdf',
        download_url: `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(userId, artifact.rendered_object_key, {
          blobUrl: artifact.rendered_blob_url ?? undefined,
          fileName: 'litos-resume.pdf',
        })}`,
        requires_authorization: false,
      }
      : baseProfile[0]?.base_resume_json
        ? {
          artifact_id: null,
          kind: 'base_resume',
          source: 'saved_base_resume',
          file_name: 'litos-base-resume.pdf',
          download_url: `${apiBaseFor(request)}/resume/base/file`,
          requires_authorization: true,
        }
        : null;
    const automaticSubmissionEnabled = entitlement.features.automatic_submission
      && account[0]?.automatic_submission_enabled === true;
    return reply.header('Cache-Control', 'private, no-store').send({
      account_id: userId,
      application_id: requestedApplicationId,
      canonical_application_id: activeApplication.id,
      submission_event_id: parsedQuery.data.event_id,
      retry_safety: gate.retrySafety,
      application: applicationResponse({ ...activeApplication, portal_url: portalUrl }),
      application_fill: true,
      selected_resume: selectedResume,
      resume_attached: activeApplication.resume_attached,
      resume_source: activeApplication.resume_source,
      resume_required: selectedResume === null,
      automatic_submission_available: entitlement.features.automatic_submission,
      automatic_submission_enabled: automaticSubmissionEnabled,
      automatic_submission_allowed: automaticSubmissionEnabled,
      requires_final_submit: !automaticSubmissionEnabled,
      manual_paths: selectedResume
        ? ['continue_without_attaching']
        : ['upload_resume', 'continue_without_attaching'],
      portal_url: portalUrl,
      handoff: fillHandoffResponse({ ...activeApplication, portal_url: portalUrl }),
    });
  });
}
