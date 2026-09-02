import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, withDedicatedDatabase } from '../db';
import { withReadOnlyRetry } from '../db/readOnlyRetry';
import {
  application_artifacts,
  application_submission_attempt_bindings,
  application_submission_attempt_events,
  application_submission_events,
  applications,
  artifact_versions,
  artifacts,
  generated_resumes,
  monetization_events,
  outreach_draft_generations,
  pending_premium_actions,
  profiles,
  trial_answer_applications,
  users,
} from '../db/schema';
import { canonicalCompanyScope, getEntitlementSnapshot } from '../lib/entitlements';
import { companyDomainFor } from '../lib/companyDomains';
import { INVENTORY_LIMIT } from '../engine/pipeline';
import { requireAuth } from '../middleware/auth';
import { apiBaseFor } from '../lib/apiBase';
import { objectStorageUsesRailway } from '../lib/objectStorage';
import { mintDownloadToken } from '../lib/resumeAccess';
import {
  manualSubmissionTransition,
  preparedSendLifecycle,
  preparedSendLifecycleProjection,
} from '../lib/canonicalApplicationLifecycle';
import {
  buildCanonicalFreeVersionedDocumentBinding,
  CANONICAL_FREE_NONE_BINDING,
} from '../lib/canonicalFreeDocumentBinding';
import { immutableDocumentContentHash } from '../lib/immutableDocumentHash';
import { bindingPdfIdentity } from '../lib/pdfGenerationBinding';
import {
  appendSubmissionAttemptEvent,
  authorizeFinalSubmissionBoundary,
  freezePostingIdentity,
  lockSubmissionAttemptUser,
  submissionAttemptBindingFromEvent,
  submissionAttemptEventId,
  submissionAttemptEventsForPacket,
  submissionAttemptRetrySafety,
  type SubmissionAttemptBinding,
  type SubmissionAttemptEventRecord,
} from '../lib/submissionAttemptLedger';
import { duplicateApplicationVerdict } from '../lib/duplicateApplication';
import {
  authoritativeConfirmedProjectionMatches,
  authoritativeSubmissionProjection,
  measuredPersistedReceiptMatchesOpening,
} from '../lib/authoritativeSubmissionProjection';
import { canonicalMonitoredPortalUrl } from '../lib/portalSubmission';
import { actionPostingRowForUser } from './jdMatch';

export { manualSubmissionTransition };

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
/* THE MAXIMUM IS THE BOARD'S MAXIMUM, and it has to be, because the dashboard renders this list and
   GET /applications/board on one screen. At 100 here against the board's 200 the Tracker showed
   "Your applications 100" directly above "187 of 200 have not been sent yet" (trylitos.com,
   2026-08-29), and an application could sit in the board's Applied column while falling outside
   this window entirely - which is how "Applied 13" and "12 Sent" were both true.

   It is a REFUSAL, not a clamp: anything above the maximum answers 400, and the web app's fallbacks
   turn that into a silently empty canonical list. So the ceiling has to rise here, and this has to
   deploy, before any client may ask for more. See INVENTORY_LIMIT. */
const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(INVENTORY_LIMIT).default(50) });

export const manualSubmissionOutcomeSchema = z.object({
  event_id: z.string().uuid(),
  outcome: z.enum(['confirmed', 'failed', 'unknown']),
  final_url: z.string().url().max(2_048),
  confirmation_text: z.string().trim().min(1).max(1_000).optional(),
});

type ManualSubmissionOutcome = z.infer<typeof manualSubmissionOutcomeSchema>['outcome'];

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
  if (existing.outcome === 'unknown' && (incoming.outcome === 'confirmed' || incoming.outcome === 'failed')) {
    return 'promote';
  }
  return 'terminal_conflict';
}

type CanonicalDocumentApplication = Pick<typeof applications.$inferSelect,
'id' | 'user_id' | 'selected_resume_artifact_id' | 'resume_attached' | 'resume_source' | 'resume_attached_at'>;

/** Freeze the exact retained document tuple before a canonical-only attempt can be opened. */
export function canonicalManualDocumentBindingFromSnapshot(input: {
  application: CanonicalDocumentApplication;
  links: Array<typeof application_artifacts.$inferSelect>;
  artifact: typeof artifacts.$inferSelect | null;
  versions: Array<typeof artifact_versions.$inferSelect>;
}): string | null {
  const { application, links, artifact, versions } = input;
  if (application.resume_source === 'none') {
    return !application.resume_attached
      && application.selected_resume_artifact_id === null
      && application.resume_attached_at === null
      && links.filter((link) => link.purpose === 'resume' && link.selected).length === 0
      ? CANONICAL_FREE_NONE_BINDING
      : null;
  }
  if (application.resume_source !== 'artifact'
    || !application.resume_attached
    || !application.resume_attached_at
    || !application.selected_resume_artifact_id
    || !artifact
    || artifact.id !== application.selected_resume_artifact_id
    || artifact.user_id !== application.user_id
    || artifact.deleted_at
    || (artifact.kind !== 'resume' && artifact.kind !== 'tailored_resume')
    || !artifact.rendered_object_key) return null;
  const exactLinks = links.filter((link) => link.application_id === application.id
    && link.artifact_id === artifact.id
    && link.purpose === 'resume'
    && link.selected
    && link.attached_at?.getTime() === application.resume_attached_at!.getTime());
  if (exactLinks.length !== 1
    || links.filter((link) => link.purpose === 'resume' && link.selected).length !== 1) return null;
  const exactVersions = versions.filter((version) => version.artifact_id === artifact.id
    && version.rendered_object_key === artifact.rendered_object_key
    && version.content_hash === immutableDocumentContentHash(version.structured_content));
  if (exactVersions.length !== 1) return null;
  const version = exactVersions[0]!;
  if (!version.rendered_object_key) return null;
  const structured = version.structured_content
    && typeof version.structured_content === 'object'
    && !Array.isArray(version.structured_content)
    ? version.structured_content as { _quality?: { pdfGenerationBinding?: unknown } }
    : null;
  const pdf = bindingPdfIdentity(
    structured?._quality?.pdfGenerationBinding,
    version.rendered_object_key,
  );
  if (!pdf) return null;
  return buildCanonicalFreeVersionedDocumentBinding('artifact', {
    artifactId: artifact.id,
    versionId: version.id,
    versionNumber: version.version_number,
    contentHash: version.content_hash,
    objectKey: version.rendered_object_key,
    blobUrl: version.rendered_blob_url,
    attachedAt: exactLinks[0]!.attached_at!.toISOString(),
    pdfSha256: pdf.sha256,
  });
}

async function canonicalManualDocumentBinding(
  executor: Pick<typeof db, 'select'>,
  application: CanonicalDocumentApplication,
): Promise<string | null> {
  const links = await executor.select().from(application_artifacts)
    .where(eq(application_artifacts.application_id, application.id));
  const artifactRows = application.selected_resume_artifact_id
    ? await executor.select().from(artifacts).where(and(
      eq(artifacts.id, application.selected_resume_artifact_id),
      eq(artifacts.user_id, application.user_id),
    )).limit(1)
    : [];
  const artifact = artifactRows[0] ?? null;
  const versions = artifact
    ? await executor.select().from(artifact_versions).where(eq(artifact_versions.artifact_id, artifact.id))
    : [];
  return canonicalManualDocumentBindingFromSnapshot({ application, links, artifact, versions });
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
    /* Same rule as the tailor link: a Free extension fill takes the row out of any prepared hold a
       managed run had parked it in, because that filled form is being replaced. */
    submission_state: sql`case
      when ${terminalLifecycle} then ${applications.submission_state}
      when ${applications.submission_state} = ${preparedSendLifecycle.submissionState} then 'not_started'
      else ${applications.submission_state}
    end`,
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
  /* A filled employer form waiting on the applicant outranks "ready" - the work is further along -
     and must never outrank a receipt, so it sits below submitted rather than beside it. Without an
     entry here it would rank 0, tied with not_started, and a duplicate adoption could silently drop
     the readiness of the prepared row it merged. */
  ready_for_final_approval: 4,
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
      /* ADDING THE POSTING AGAIN IS THE UNDO. This upsert reuses the existing row for a posting
         the student already has, and a removed row is still that row - so without this clear, a
         student who removed an application and then added the same job back would get a row they
         could not see, on a fingerprint that stops a second one being created. Reviving it also
         returns the history attached to it rather than starting them at zero. */
      removed_at: null,
      created_at: new Date(Math.min(...merged.map((row) => row.created_at.getTime()))),
      updated_at: new Date(Math.max(Date.now(), ...merged.map((row) => row.updated_at.getTime()))),
    }).where(and(eq(applications.id, winner.id), eq(applications.user_id, input.userId))).returning();
    if (!updated) throw new Error('Canonical application adoption returned no record');
    return { application: updated, created: false, adopted: adoptable.length > 0 || losers.length > 0 };
  });
}

function applicationResponse(
  row: typeof applications.$inferSelect,
  /* The status of the packet this row points at, when the caller has read it. The stored lifecycle
     columns are a projection of that packet, and for every application prepared before writeReview
     learned to project the hold they are behind. Callers that just wrote the row themselves pass
     nothing and get the stored pair, which is what they wrote. */
  packetReviewStatus: string | null = null,
) {
  const lifecycle = preparedSendLifecycleProjection(row, packetReviewStatus);
  return {
    id: row.id,
    legacy_generated_resume_id: row.legacy_generated_resume_id,
    job_id: row.job_id,
    company: row.company_name,
    /* The employer's own domain, resolved from the same verified map the job board and the
       notification emails already use (companyDomainFor). It is here so the Tracker can draw the
       company's logo beside its name the way Jobs and Home already do.
       WHY THE SERVER RESOLVES IT. The dashboard has the company NAME and nothing else, and a domain
       guessed from a name is how a row ends up wearing another company's logo - which tells a
       student this application is to a different employer than it is. The map is in-memory and
       keyed by normalized name, so this costs a lookup per row and no query. Null whenever the map
       does not know the company, which the client renders as a monogram rather than a wrong icon. */
    company_domain: companyDomainFor(row.company_name),
    company_scope_key: row.company_scope_key,
    role: row.role,
    portal_url: safeStoredPortalUrl(row.portal_url),
    source_surface: row.source_surface,
    tracker_state: row.tracker_state,
    review_state: lifecycle.review_state,
    submission_state: lifecycle.submission_state,
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

/* A tracker stage that means the employer already has it. Kept beside the removal route rather
   than imported from the projection module, which exports its own copy for a different question:
   there "terminal" decides whether to keep polling, here it decides whether the student is allowed
   to hide the evidence of a send. Same values today, and they are allowed to diverge. */
const REMOVAL_BLOCKING_TRACKER_STAGES = new Set(['applied', 'interview', 'offer', 'closed']);

async function ownedApplication(request: FastifyRequest, reply: FastifyReply) {
  const parsed = paramsSchema.safeParse(request.params);
  if (!parsed.success) {
    reply.status(400).send({ error: 'Invalid application id' });
    return null;
  }
  const [application] = await db.select().from(applications).where(and(
    eq(applications.id, parsed.data.id),
    eq(applications.user_id, request.jwtPayload!.userId),
  )).limit(1);
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
    /* Removed rows are excluded HERE rather than in the client, because this one route feeds the
       Tracker, the dashboard and the extension alike, and a client-side filter would hide a row on
       one surface and show it on the next. */
    /* THE LINKED PACKET'S REVIEW STATUS IS READ WITH THE ROW, AND THE LIFECYCLE IS HEALED FROM IT.
       This one LEFT JOIN is what lets an application prepared before the projection existed reach
       its send without being prepared again. It is a derivation, not a write: a GET stays a GET,
       every read of every already-parked row heals identically, and a row whose packet has since
       moved on stops advertising a filled form on the same read. */
    const rows = await db.select({
      application: applications,
      packetReviewStatus: sql<string | null>`${generated_resumes.spec}->'_review'->>'status'`,
    }).from(applications)
      .leftJoin(generated_resumes, and(
        eq(generated_resumes.id, applications.legacy_generated_resume_id),
        eq(generated_resumes.user_id, applications.user_id),
      ))
      .where(and(
        eq(applications.user_id, request.jwtPayload!.userId),
        isNull(applications.removed_at),
      )).orderBy(desc(applications.updated_at)).limit(parsed.data.limit);
    return reply.header('Cache-Control', 'private, no-store').send({
      applications: rows.map((row) => applicationResponse(row.application, row.packetReviewStatus)),
    });
  });

  /**
   * TAKE AN APPLICATION OFF THE TRACKER.
   *
   * Until this existed there was no way for a student to undo a row they did not mean to create,
   * on any surface: the only DELETE routes in the product were for cover letters, documents, email
   * connections and the entire account. A mistyped link, a job opened to look at, a build run to
   * try something - each left a permanent row.
   *
   * IT IS A STAMP, NOT A DELETE, and the schema forces that rather than it being a preference.
   * Nine tables carry an application_id with no foreign key, so a DELETE cannot cascade to them:
   * application_submission_attempt_bindings and _events, monetization_events,
   * trial_answer_applications, application_posting_distinctions, pending_premium_actions,
   * user_documents.first_application_id. The first two are the attempt ledger, which is what stops
   * Litos sending the same application to the same employer twice. Deleting the row it points at
   * would trade a tidy Tracker for a duplicate send to a real employer, and the billing events and
   * the trial accounting would start referring to an application that no longer exists.
   *
   * WHAT MAY BE REMOVED: only an application that never reached an employer. The check is made
   * against the ledger and the lifecycle rather than against submission_state alone, because
   * submission_state is a projection and the ledger is the record. Anything with an attempt
   * binding, an attempt event, a submission event, a non-not_started submission state or a
   * terminal tracker stage is refused with 409 and a reason the client can show. That refusal is
   * the point: "remove" must never be a way to make a sent application disappear from the history
   * that proves it was sent.
   *
   * Idempotent: removing an already-removed application answers 200 with the same body, so a
   * double click or a retried request is not an error.
   */
  fastify.post('/applications/:id/remove', { preHandler: requireAuth }, async (request, reply) => {
    const application = await ownedApplication(request, reply);
    if (!application) return reply;
    if (application.removed_at) {
      return reply.header('Cache-Control', 'private, no-store').send({
        application: applicationResponse(application),
        removed: true,
        already_removed: true,
      });
    }

    const blockers: string[] = [];
    /* A packet parked at ready_for_final_approval is FILLED, NOT SENT. Refusing removal on it
       would be this bug's mirror image: a screen asserting a send the evidence contradicts. The
       ledger checks below are what actually enforce "never reached an employer", and they are
       untouched - an attempt binding or event still refuses on its own. */
    if (application.submission_state !== 'not_started'
      && application.submission_state !== preparedSendLifecycle.submissionState) {
      blockers.push(`submission_state is "${application.submission_state}"`);
    }
    if (REMOVAL_BLOCKING_TRACKER_STAGES.has(application.tracker_state)) {
      blockers.push(`tracker_state is "${application.tracker_state}"`);
    }
    /* The ledger is consulted directly. A projection can be rebuilt or lag; these rows are the
       durable evidence that a send was attempted, and one of them is enough to refuse. */
    const [bindings, attemptEvents, submissionEvents] = await Promise.all([
      db.select({ attemptId: application_submission_attempt_bindings.attempt_id })
        .from(application_submission_attempt_bindings)
        .where(and(
          eq(application_submission_attempt_bindings.user_id, request.jwtPayload!.userId),
          eq(application_submission_attempt_bindings.application_id, application.id),
        )).limit(1),
      db.select({ id: application_submission_attempt_events.id })
        .from(application_submission_attempt_events)
        .where(and(
          eq(application_submission_attempt_events.user_id, request.jwtPayload!.userId),
          eq(application_submission_attempt_events.application_id, application.id),
        )).limit(1),
      db.select({ id: application_submission_events.id })
        .from(application_submission_events)
        .where(eq(application_submission_events.application_id, application.id)).limit(1),
    ]);
    if (bindings.length > 0) blockers.push('a submission attempt is on record');
    if (attemptEvents.length > 0) blockers.push('a submission attempt event is on record');
    if (submissionEvents.length > 0) blockers.push('a submission event is on record');

    if (blockers.length > 0) {
      return reply.status(409).send({
        error: 'This application has already been sent or is being sent, so Litos is keeping it on your Tracker.',
        code: 'application_not_removable',
        blockers,
      });
    }

    /* Conditional on still being unremoved and still not_started, so two concurrent requests, or a
       send that claims the row between the checks above and this write, cannot both win. */
    const [removed] = await db.update(applications)
      .set({ removed_at: new Date(), updated_at: new Date() })
      .where(and(
        eq(applications.id, application.id),
        eq(applications.user_id, request.jwtPayload!.userId),
        inArray(applications.submission_state, ['not_started', preparedSendLifecycle.submissionState]),
        isNull(applications.removed_at),
      )).returning();
    if (!removed) {
      return reply.status(409).send({
        error: 'This application changed while Litos was removing it. Reload your Tracker and try again.',
        code: 'application_not_removable',
        blockers: ['the application changed during removal'],
      });
    }
    request.log.info(
      { userId: request.jwtPayload!.userId, applicationId: application.id, company: application.company_name },
      'application removed from the tracker',
    );
    return reply.header('Cache-Control', 'private, no-store').send({
      application: applicationResponse(removed),
      removed: true,
      already_removed: false,
    });
  });

  // This route is deliberately outside every premium gate. A canonical application is the Free
  // execution record and must exist before a user chooses whether to generate anything.
  fastify.post('/applications', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createApplicationSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid application', detail: parsed.error.issues });
    const userId = request.jwtPayload!.userId;
    let portalUrl: string | null;
    if (parsed.data.job_id) {
      const posting = await actionPostingRowForUser(parsed.data.job_id, userId);
      const monitoredPortalUrl = posting ? canonicalMonitoredPortalUrl(
        posting.apply_url,
        posting.ats_name,
        posting.board_token,
        posting.external_id,
        posting.posting_url,
      ) : undefined;
      if (!posting || !monitoredPortalUrl) {
        return reply.status(409).send({
          error: 'Current verified posting not found',
          code: 'job_not_available',
        });
      }
      portalUrl = monitoredPortalUrl;
    } else {
      try {
        portalUrl = canonicalPortalUrl(parsed.data.portal_url);
      } catch (error) {
        return reply.status(400).send({ error: error instanceof Error ? error.message : 'Invalid portal URL' });
      }
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
    const application = await ownedApplication(request, reply);
    if (!application) return;
    const userId = request.jwtPayload!.userId;
    let finalUrl: string;
    let applicationPortalUrl: string;
    let portalIdentity: string;
    try {
      finalUrl = canonicalPortalUrl(parsed.data.final_url, true)!;
      if (!application.portal_url) throw new Error('Application portal URL is required');
      applicationPortalUrl = canonicalPortalUrl(application.portal_url, true)!;
      portalIdentity = canonicalPortalIdentity(applicationPortalUrl);
      if (canonicalPortalIdentity(finalUrl) !== portalIdentity) {
        return reply.status(409).send({
          error: 'Submission outcome URL does not match this application portal',
          code: 'portal_identity_mismatch',
        });
      }
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : 'Submission outcome URL is not safe',
        code: 'unsafe_submission_outcome_url',
      });
    }

    type OutcomeResult = {
      idempotent: boolean;
      event: typeof application_submission_events.$inferSelect;
      application: typeof applications.$inferSelect;
    };
    try {
      const runManualSubmissionOutcomeTransaction = (database: typeof db) => database.transaction(async (tx): Promise<OutcomeResult> => {
        await lockSubmissionAttemptUser(tx, userId);
        const [currentApplication] = await tx.select().from(applications).where(and(
          eq(applications.id, application.id),
          eq(applications.user_id, userId),
        )).limit(1).for('update');
        if (!currentApplication) {
          throw Object.assign(new Error('Application not found'), { statusCode: 404, code: 'application_not_found' });
        }
        if (!currentApplication.portal_url) {
          throw Object.assign(new Error('Application portal URL is required'), {
            statusCode: 409,
            code: 'submission_attempt_authority_missing',
          });
        }
        let lockedPortalUrl: string;
        try {
          lockedPortalUrl = canonicalPortalUrl(currentApplication.portal_url, true)!;
        } catch {
          throw Object.assign(new Error('The application portal changed before its outcome was recorded'), {
            statusCode: 409,
            code: 'submission_portal_changed',
          });
        }
        if (lockedPortalUrl !== applicationPortalUrl) {
          throw Object.assign(new Error('The application portal changed before its outcome was recorded'), {
            statusCode: 409,
            code: 'submission_portal_changed',
          });
        }
        const documentBinding = await canonicalManualDocumentBinding(tx, currentApplication);
        if (!documentBinding) {
          throw Object.assign(new Error('The selected resume does not have one exact retained version for this receipt'), {
            statusCode: 409,
            code: 'submission_document_authority_missing',
          });
        }
        const postingIdentity = freezePostingIdentity({
          job_id: currentApplication.job_id,
          company: currentApplication.company_name,
          role: currentApplication.role,
        }, currentApplication.portal_url);
        const expectedBinding: SubmissionAttemptBinding = {
          attemptId: parsed.data.event_id,
          userId,
          packetId: currentApplication.id,
          applicationId: currentApplication.id,
          parentAttemptId: null,
          source: 'chrome_extension',
          operation: 'manual_submission',
          postingIdentity,
          submissionRunId: null,
          submissionClaimId: null,
          packetVersion: documentBinding,
        };
        const [existing] = await tx.select().from(application_submission_events).where(and(
          eq(application_submission_events.user_id, userId),
          eq(application_submission_events.event_id, parsed.data.event_id),
        )).limit(1);
        const confirmationText = parsed.data.confirmation_text ?? null;
        const allEvents = await submissionAttemptEventsForPacket(userId, currentApplication.id, { executor: tx });
        const exactEvents = allEvents.filter((event) => event.attempt_id === parsed.data.event_id);
        const opening = exactEvents.find((event) => event.event_kind === 'attempt_opened');
        const openingIsExact = opening
          && opening.source === 'chrome_extension'
          && opening.operation === 'manual_submission'
          && opening.evidence_code === 'canonical_manual_submit_reserved'
          && opening.packet_version === documentBinding
          && isDeepStrictEqual(submissionAttemptBindingFromEvent(opening), expectedBinding);
        const assertConfirmedProjection = async (attemptId: string) => {
          const projections = await authoritativeSubmissionProjection({
            userId,
            applicationIds: [currentApplication.id],
            executor: tx,
          });
          const exact = {
            attemptId,
            canonicalApplicationId: currentApplication.id,
            packetId: null,
          };
          if (!authoritativeConfirmedProjectionMatches(
            projections.byApplicationId.get(currentApplication.id),
            exact,
          )) throw Object.assign(new Error('The manual receipt did not produce one exact authority projection'), {
            statusCode: 409,
            code: 'submission_receipt_authority_incomplete',
          });
        };
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
            if (!openingIsExact) {
              throw Object.assign(new Error('This historical receipt has no exact immutable attempt binding'), {
                statusCode: 409,
                code: 'submission_attempt_authority_missing',
              });
            }
            const safety = submissionAttemptRetrySafety(exactEvents);
            if (parsed.data.outcome === 'confirmed') {
              if (safety.kind !== 'blocked_confirmed') {
                throw Object.assign(new Error('This receipt is missing immutable confirmation evidence'), {
                  statusCode: 409,
                  code: 'submission_receipt_authority_incomplete',
                });
              }
              await assertConfirmedProjection(parsed.data.event_id);
            } else if (safety.kind !== 'blocked_unverified') {
              throw Object.assign(new Error('This outcome is missing its immutable employer attempt'), {
                statusCode: 409,
                code: 'submission_attempt_authority_missing',
              });
            }
            return { idempotent: true, event: existing, application: currentApplication };
          }
          if (decision === 'terminal_conflict') {
            throw Object.assign(new Error('A terminal submission event cannot be changed'), {
              statusCode: 409,
              code: 'submission_event_terminal',
            });
          }
          if (!openingIsExact || submissionAttemptRetrySafety(exactEvents).kind !== 'blocked_unverified') {
            throw Object.assign(new Error('This outcome cannot be promoted without its exact immutable attempt'), {
              statusCode: 409,
              code: 'submission_attempt_authority_missing',
            });
          }
          const duplicate = await duplicateApplicationVerdict({
            userId,
            applicationId: currentApplication.id,
            jobContext: {
              job_id: currentApplication.job_id,
              company: currentApplication.company_name,
              role: currentApplication.role,
            },
            portalUrl: currentApplication.portal_url,
            excludeAttemptId: parsed.data.event_id,
          }, tx);
          if (duplicate.kind !== 'clear') {
            throw Object.assign(new Error(duplicate.reason), {
              statusCode: 409,
              code: 'duplicate_application_risk',
            });
          }
          const transition = manualSubmissionTransition(currentApplication.submission_state, parsed.data.outcome);
          const clockResult = await tx.execute(sql`select clock_timestamp() as now`);
          const clockValue = (clockResult.rows[0] as { now?: Date | string } | undefined)?.now;
          const now = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
          if (Number.isNaN(now.getTime())) throw new Error('Database manual outcome clock was unavailable');
          if (parsed.data.outcome === 'confirmed') {
            const confirmationPrototype = {
              ...opening!,
              event_kind: 'submission_confirmed',
              evidence_code: 'canonical_manual_receipt_confirmed',
              observed_at: now,
              created_at: now,
            } as SubmissionAttemptEventRecord;
            if (!confirmationText || !measuredPersistedReceiptMatchesOpening(
              opening!,
              confirmationPrototype,
              finalUrl,
              confirmationText,
            )) throw Object.assign(new Error('The employer result is not an exact receipt for this posting'), {
              statusCode: 409,
              code: 'submission_receipt_not_authoritative',
            });
            await appendSubmissionAttemptEvent({
              ...submissionAttemptBindingFromEvent(opening!),
              eventId: submissionAttemptEventId(parsed.data.event_id, 'submission_confirmed', 'canonical-manual-receipt'),
              eventKind: 'submission_confirmed',
              evidenceCode: 'canonical_manual_receipt_confirmed',
              observedAt: now,
            }, { executor: tx });
          }
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
          if (parsed.data.outcome === 'confirmed') await assertConfirmedProjection(parsed.data.event_id);
          return { idempotent: false, event: promoted, application: updatedApplication };
        }

        const duplicate = await duplicateApplicationVerdict({
          userId,
          applicationId: currentApplication.id,
          jobContext: {
            job_id: currentApplication.job_id,
            company: currentApplication.company_name,
            role: currentApplication.role,
          },
          portalUrl: currentApplication.portal_url,
        }, tx);
        if (duplicate.kind !== 'clear') {
          throw Object.assign(new Error(duplicate.reason), {
            statusCode: 409,
            code: 'duplicate_application_risk',
          });
        }
        const clockResult = await tx.execute(sql`select clock_timestamp() as opened_at`);
        const clockValue = (clockResult.rows[0] as { opened_at?: Date | string } | undefined)?.opened_at;
        const openedAt = clockValue instanceof Date ? clockValue : new Date(clockValue ?? NaN);
        if (Number.isNaN(openedAt.getTime())) throw new Error('Database manual opening clock was unavailable');
        const opened = await appendSubmissionAttemptEvent({
          ...expectedBinding,
          eventId: submissionAttemptEventId(parsed.data.event_id, 'attempt_opened', 'canonical-manual-reservation'),
          eventKind: 'attempt_opened',
          evidenceCode: 'canonical_manual_submit_reserved',
          observedAt: openedAt,
        }, { executor: tx });
        const authorization = await authorizeFinalSubmissionBoundary(expectedBinding, {
          executor: tx,
          factKey: 'canonical-manual-boundary',
          evidenceCode: 'canonical_manual_boundary_authorized',
        });
        if (authorization.kind !== 'fresh') throw new Error('CANONICAL_MANUAL_BOUNDARY_CONFLICT');
        const observedAt = new Date(authorization.authorization.authorizedAt);
        await appendSubmissionAttemptEvent({
          ...expectedBinding,
          eventId: submissionAttemptEventId(parsed.data.event_id, 'press_observed', 'canonical-manual-press'),
          eventKind: 'press_observed',
          evidenceCode: 'canonical_manual_submit_pressed',
          observedAt,
        }, { executor: tx });
        if (parsed.data.outcome === 'confirmed') {
          const confirmationPrototype = {
            ...opened.event,
            event_kind: 'submission_confirmed',
            evidence_code: 'canonical_manual_receipt_confirmed',
            observed_at: observedAt,
            created_at: observedAt,
          } as SubmissionAttemptEventRecord;
          if (!confirmationText || !measuredPersistedReceiptMatchesOpening(
            opened.event,
            confirmationPrototype,
            finalUrl,
            confirmationText,
          )) throw Object.assign(new Error('The employer result is not an exact receipt for this posting'), {
            statusCode: 409,
            code: 'submission_receipt_not_authoritative',
          });
          await appendSubmissionAttemptEvent({
            ...expectedBinding,
            eventId: submissionAttemptEventId(parsed.data.event_id, 'submission_confirmed', 'canonical-manual-receipt'),
            eventKind: 'submission_confirmed',
            evidenceCode: 'canonical_manual_receipt_confirmed',
            observedAt,
          }, { executor: tx });
        }
        const transition = manualSubmissionTransition(currentApplication.submission_state, parsed.data.outcome);
        const [updatedApplication] = await tx.update(applications).set({
          submission_state: transition.submissionState,
          tracker_state: transition.trackerState,
          updated_at: observedAt,
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
          observed_at: observedAt,
        }).returning();
        if (parsed.data.outcome === 'confirmed') await assertConfirmedProjection(parsed.data.event_id);
        return { idempotent: false, event: createdEvent, application: updatedApplication };
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
        application_id: result.application.id,
        event_id: result.event.event_id,
        outcome: result.event.outcome,
        idempotent: result.idempotent,
        applied_submission_state: result.event.applied_submission_state,
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
        return reply.status(typed.statusCode).send({ error: typed.message, code: typed.code });
      }
      throw error;
    }
  });

  // Free-safe attachment selection for the dashboard and extension. Generated or uploaded
  // artifacts use a short-lived capability URL. The saved base resume uses an authenticated render
  // URL that the extension background fetches with the account token before attaching the bytes.
  fastify.get('/applications/:id/fill-data', { preHandler: requireAuth }, async (request, reply) => {
    const application = await ownedApplication(request, reply);
    if (!application) return;
    // New writes are already normalized by POST /applications. This second check protects the
    // extension from historical or manually imported rows that predate that invariant.
    let portalUrl: string | null;
    try {
      portalUrl = canonicalPortalUrl(application.portal_url ?? undefined);
    } catch {
      return reply.status(409).send({
        error: 'This saved application does not have a safe HTTPS portal URL.',
        code: 'unsafe_portal_url',
      });
    }
    const userId = request.jwtPayload!.userId;
    const [selectedArtifact, baseProfile, entitlement, account] = await Promise.all([
      application.selected_resume_artifact_id
        ? db.select().from(artifacts).where(and(
          eq(artifacts.id, application.selected_resume_artifact_id),
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
          blobUrl: objectStorageUsesRailway() ? undefined : artifact.rendered_blob_url ?? undefined,
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
      application_id: application.id,
      application: applicationResponse({ ...application, portal_url: portalUrl }),
      application_fill: true,
      selected_resume: selectedResume,
      resume_attached: application.resume_attached,
      resume_source: application.resume_source,
      resume_required: selectedResume === null,
      automatic_submission_available: entitlement.features.automatic_submission,
      automatic_submission_enabled: automaticSubmissionEnabled,
      automatic_submission_allowed: automaticSubmissionEnabled,
      requires_final_submit: !automaticSubmissionEnabled,
      manual_paths: selectedResume
        ? ['continue_without_attaching']
        : ['upload_resume', 'continue_without_attaching'],
      portal_url: portalUrl,
      handoff: fillHandoffResponse({ ...application, portal_url: portalUrl }),
    });
  });
}
