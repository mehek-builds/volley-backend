import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  application_artifacts,
  application_email_aliases,
  applications,
  artifact_versions,
  artifacts,
  career_page_sources,
  generated_resumes,
  managed_prepare_object_cleanups,
  monitored_jobs,
  profiles,
  users,
} from '../db/schema';
import { renderResumePdf, type ContactHeader } from '../engine/resumeRender';
import { normalizeSpec, type ResumeSpec } from '../llm/resumeSpec';
import type { ResumeRow } from '../routes/submissionRunner';
import type { ApplicationReviewState } from './applicationReview';
import { readApplicationReview } from './applicationReview';
import { loadApplicationProfileLike } from './applicationProfileLike';
import { browserDeliveryRuntimeIdentity } from './browserbase';
import { canonicalCompanyScope } from './entitlements';
import {
  browserEmployerDeliveryChannel,
  createEmployerDeliveryBindings,
  employerDeliveryEnvelope,
} from './employerDeliveryIdentity';
import { immutableDocumentContentHash } from './immutableDocumentHash';
import {
  createPacketAudit,
  packetAuditIsSubmissionReady,
  packetAuditSha256,
  packetAuditTextSha256,
} from './packetAudit';
import { planPacketApplicantEmail, type PacketApplicantEmailPlan } from './packetApplicantEmail';
import { parseStatedApplicationDeadline } from './postingDeadline';
import { createPdfGenerationBinding } from './pdfGenerationBinding';
import { detectPortal, portalApplicationUrl, type SubmissionPacket } from './portalSubmission';
import { resumeEmailForUpload } from './resumeEmail';
import { linkGeneratedPacketToCanonicalApplication } from './resumeArtifactVersions';
import { MAIN_RESUME_PROFILE_COLUMNS, mainResumeOfRecordFor } from './mainResumeOfRecord';

const MANAGED_PREPARE_VERSION = 'managed_prepare_v1' as const;

export type ManagedPrepareState = 'ready_for_review' | 'needs_attention';

export type ManagedPrepareResult = {
  application_id: string;
  packet_id: string;
  state: ManagedPrepareState;
  review: ApplicationReviewState;
  reused: boolean;
};

export class ManagedPrepareError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ManagedPrepareError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

type ManagedPrepareMetadata = {
  version: typeof MANAGED_PREPARE_VERSION;
  canonical_application_id: string;
  packet_id: string;
  job_id: string;
  resume_source: 'main_resume';
  main_resume_digest: string;
  rendered_blob_url: string;
  state: ManagedPrepareState;
  phase?: 'stored';
};

type ManagedPrepareReservationMetadata = Omit<ManagedPrepareMetadata, 'rendered_blob_url' | 'phase'> & {
  phase: 'reserved';
  reservation_id: string;
  reserved_at: string;
  lease_expires_at: string;
  requested_object_key: string;
};

const MANAGED_PREPARE_RESERVATION_MS = 5 * 60 * 1000;

type RenderedMainResume = {
  buffer: Buffer;
  spec: ResumeSpec;
};

export type ManagedPrepareDependencies = {
  now: () => Date;
  newId: () => string;
  loadApplicationProfile: typeof loadApplicationProfileLike;
  planApplicantEmail: typeof planPacketApplicantEmail;
  renderMainResume: (input: { spec: ResumeSpec; contact: ContactHeader }) => Promise<RenderedMainResume>;
  storeResume: (requestedKey: string, bytes: Buffer) => Promise<{ pathname: string; url: string }>;
  readResume: (objectKey: string) => Promise<Buffer | null>;
  deleteResume: (objectKey: string) => Promise<void>;
  buildSubmissionPacket: (row: ResumeRow, pdfBytes: Buffer) => Promise<SubmissionPacket>;
  browserRuntime: typeof browserDeliveryRuntimeIdentity;
  upsertCanonicalApplication: (input: {
    userId: string;
    jobId: string;
    companyScopeKey: string;
    companyName: string;
    role: string;
    sourceSurface: 'dashboard';
  }) => Promise<{ application: { id: string } }>;
};

const defaultDependencies: ManagedPrepareDependencies = {
  now: () => new Date(),
  newId: randomUUID,
  loadApplicationProfile: loadApplicationProfileLike,
  planApplicantEmail: planPacketApplicantEmail,
  renderMainResume: async ({ spec, contact }) => {
    const rendered = await renderResumePdf(spec, contact);
    return { buffer: rendered.buffer, spec: rendered.spec };
  },
  storeResume: async (requestedKey, bytes) => {
    const { putObject } = await import('./objectStorage');
    return putObject(requestedKey, bytes, {
      contentType: 'application/pdf',
      addRandomSuffix: false,
      allowOverwrite: true,
    });
  },
  readResume: async (objectKey) => {
    const { readObject } = await import('./objectStorage');
    return readObject(objectKey);
  },
  deleteResume: async (objectKey) => {
    const { deleteObjects } = await import('./objectStorage');
    await deleteObjects(objectKey);
  },
  buildSubmissionPacket: async (row, pdfBytes) => {
    const { buildPacket } = await import('../routes/submissionRunner');
    return buildPacket(row, false, [], true, pdfBytes);
  },
  browserRuntime: browserDeliveryRuntimeIdentity,
  upsertCanonicalApplication: async (input) => {
    const { upsertCanonicalApplicationForUser } = await import('../routes/canonicalApplications');
    return upsertCanonicalApplicationForUser(input);
  },
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function mainResumeContactHeader(
  parsed: unknown,
  applicationProfile: Record<string, unknown> | undefined,
  email: string | undefined,
): ContactHeader {
  const profile = record(parsed) ?? {};
  const stringValue = (value: unknown) => typeof value === 'string' && value.trim()
    ? value.trim()
    : undefined;
  return {
    full_name: stringValue(profile.full_name) ?? 'Applicant',
    email,
    phone: stringValue(applicationProfile?.phone),
    linkedin_url: stringValue(applicationProfile?.linkedin_url),
    github_url: stringValue(applicationProfile?.github_url),
    portfolio_url: stringValue(applicationProfile?.portfolio_url),
  };
}

function managedPrepareMetadata(spec: unknown): ManagedPrepareMetadata | null {
  const raw = record(record(spec)?._managed_prepare);
  if (!raw
    || raw.version !== MANAGED_PREPARE_VERSION
    || typeof raw.canonical_application_id !== 'string'
    || typeof raw.packet_id !== 'string'
    || typeof raw.job_id !== 'string'
    || raw.resume_source !== 'main_resume'
    || typeof raw.main_resume_digest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(raw.main_resume_digest)
    || typeof raw.rendered_blob_url !== 'string'
    || !raw.rendered_blob_url.trim()
    || (raw.phase !== undefined && raw.phase !== 'stored')
    || !['ready_for_review', 'needs_attention'].includes(String(raw.state))) return null;
  return raw as ManagedPrepareMetadata;
}

/* Whether a stored packet is the student's main resume rendered as-is by this path, in any phase.
 * Read by the lead-citation gates: such a packet was never tailored to its posting and owes no
 * lead citation (see LeadAlignmentOptions.untailored). Provenance is the metadata this path wrote,
 * never inferred from the spec's shape. */
export function packetIsUntailoredMainResume(spec: unknown): boolean {
  const raw = record(record(spec)?._managed_prepare);
  return raw?.version === MANAGED_PREPARE_VERSION && raw.resume_source === 'main_resume';
}

function managedPrepareReservationMetadata(spec: unknown): ManagedPrepareReservationMetadata | null {
  const raw = record(record(spec)?._managed_prepare);
  if (!raw
    || raw.version !== MANAGED_PREPARE_VERSION
    || typeof raw.canonical_application_id !== 'string'
    || typeof raw.packet_id !== 'string'
    || typeof raw.job_id !== 'string'
    || raw.resume_source !== 'main_resume'
    || typeof raw.main_resume_digest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(raw.main_resume_digest)
    || raw.phase !== 'reserved'
    || typeof raw.reservation_id !== 'string'
    || !raw.reservation_id
    || typeof raw.reserved_at !== 'string'
    || !Number.isFinite(Date.parse(raw.reserved_at))
    || typeof raw.lease_expires_at !== 'string'
    || !Number.isFinite(Date.parse(raw.lease_expires_at))
    || typeof raw.requested_object_key !== 'string'
    || !raw.requested_object_key
    || !['ready_for_review', 'needs_attention'].includes(String(raw.state))) return null;
  return raw as ManagedPrepareReservationMetadata;
}

function managedPrepareReservation(input: {
  applicationId: string;
  packetId: string;
  jobId: string;
  mainResumeDigest: string;
  state: ManagedPrepareState;
  reservationId: string;
  reservedAt: Date;
  requestedObjectKey: string;
}): ManagedPrepareReservationMetadata {
  return {
    version: MANAGED_PREPARE_VERSION,
    canonical_application_id: input.applicationId,
    packet_id: input.packetId,
    job_id: input.jobId,
    resume_source: 'main_resume',
    main_resume_digest: input.mainResumeDigest,
    state: input.state,
    phase: 'reserved',
    reservation_id: input.reservationId,
    reserved_at: input.reservedAt.toISOString(),
    lease_expires_at: new Date(input.reservedAt.getTime() + MANAGED_PREPARE_RESERVATION_MS).toISOString(),
    requested_object_key: input.requestedObjectKey,
  };
}

function managedPrepareReservationObjectKey(input: {
  userId: string;
  jobId: string;
  mainResumeDigest: string;
  reservationId: string;
}): string {
  return `users/${input.userId}/managed-main-resumes/${input.jobId}/${input.reservationId}/${input.mainResumeDigest}.pdf`;
}

function managedPrepareReservationObjectKeyMatches(input: {
  userId: string;
  jobId: string;
  mainResumeDigest: string;
  objectKey: string;
}): boolean {
  const prefix = `users/${input.userId}/managed-main-resumes/${input.jobId}/`;
  if (!input.objectKey.startsWith(prefix)) return false;
  const suffix = `/${input.mainResumeDigest}.pdf`;
  const reservationId = input.objectKey.slice(prefix.length, -suffix.length);
  return input.objectKey.endsWith(suffix)
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(reservationId);
}

/**
 * Retry every immutable superseded-render cleanup obligation without ever deleting a key that is
 * still referenced. Obligations intentionally remain durable after a successful delete: an old
 * renderer may upload late, and the next prepare or account prefix scrub must delete it again.
 */
export async function retryManagedPrepareObjectCleanup(
  userId: string,
  dependencyOverrides: Pick<Partial<ManagedPrepareDependencies>, 'deleteResume'> = {},
): Promise<number> {
  const deleteResume = dependencyOverrides.deleteResume ?? defaultDependencies.deleteResume;
  const rows = await db.select({
    objectKey: generated_resumes.resume_object_key,
  }).from(generated_resumes).where(eq(generated_resumes.user_id, userId));
  const referenced = new Set(rows.map((row) => row.objectKey));
  const prefix = `users/${userId}/managed-main-resumes/`;
  const obligations = await db.select({ objectKey: managed_prepare_object_cleanups.object_key })
    .from(managed_prepare_object_cleanups)
    .where(eq(managed_prepare_object_cleanups.user_id, userId));
  const cleanupKeys = obligations.map((row) => row.objectKey)
    .filter((key) => key.startsWith(prefix) && !referenced.has(key));
  let deleted = 0;
  for (const key of cleanupKeys) {
    await deleteResume(key);
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId)).limit(1);
    if (owner) {
      try {
        await db.update(managed_prepare_object_cleanups).set({
          last_attempt_at: sql`clock_timestamp()`,
        }).where(and(
          eq(managed_prepare_object_cleanups.user_id, userId),
          eq(managed_prepare_object_cleanups.object_key, key),
        ));
      } catch (error) {
        const [stillExists] = await db.select({ id: users.id }).from(users)
          .where(eq(users.id, userId)).limit(1);
        if (stillExists) throw error;
      }
    }
    deleted += 1;
  }
  return deleted;
}

/** Daily independent retry for late stale-render uploads, even if the packet is never opened again. */
export async function retryAllManagedPrepareObjectCleanup(): Promise<number> {
  const owners = await db.selectDistinct({ userId: managed_prepare_object_cleanups.user_id })
    .from(managed_prepare_object_cleanups);
  let deleted = 0;
  for (const owner of owners) deleted += await retryManagedPrepareObjectCleanup(owner.userId);
  return deleted;
}

function exactManagedReview(row: ResumeRow, applicationId: string): ApplicationReviewState | null {
  const metadata = managedPrepareMetadata(row.spec);
  const review = readApplicationReview(row.spec);
  if (!metadata
    || metadata.canonical_application_id !== applicationId
    || metadata.packet_id !== row.id
    || !review?.packet_audit
    || !packetAuditIsSubmissionReady(review.packet_audit)
    || review.packet_audit.bindings.applicationId !== row.id) return null;
  return review;
}

function prepareError(statusCode: number, code: string, message: string): never {
  throw new ManagedPrepareError(statusCode, code, message);
}

function normalizedSecureDestination(rawUrl: string, sourceFamily: string): {
  destinationUrl: string;
  portalFamily: string;
  state: ManagedPrepareState;
} {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return prepareError(422, 'managed_destination_invalid', 'This job does not have a valid application destination.');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return prepareError(422, 'managed_destination_invalid', 'This job does not have a secure application destination.');
  }
  parsed.hash = '';
  const safeUrl = parsed.toString();
  try {
    const portal = detectPortal(safeUrl);
    return {
      destinationUrl: portalApplicationUrl(portal, safeUrl),
      portalFamily: portal,
      state: 'ready_for_review',
    };
  } catch {
    return {
      destinationUrl: safeUrl,
      portalFamily: sourceFamily || 'unsupported',
      state: 'needs_attention',
    };
  }
}

function exactJdClause(jdText: string) {
  const start = jdText.search(/\S/u);
  if (start < 0) return prepareError(422, 'managed_job_description_missing', 'This job has no description to review.');
  let end = jdText.length;
  while (end > start && /\s/u.test(jdText[end - 1])) end -= 1;
  return { text: jdText.slice(start, end), start, end, verdict: 'unscoreable' as const };
}

function trackedApplicantEmail(plan: PacketApplicantEmailPlan): asserts plan is PacketApplicantEmailPlan & {
  identity: NonNullable<PacketApplicantEmailPlan['identity']>;
  choice: NonNullable<PacketApplicantEmailPlan['choice']>;
} {
  if (!plan.identity
    || !plan.choice
    || plan.choice.source !== 'litos_alias'
    || plan.choice.tracked !== true
    || plan.choice.address !== plan.identity.alias) {
    prepareError(
      409,
      'managed_application_email_unavailable',
      'Litos could not verify the application email for this packet. Nothing was opened or sent.',
    );
  }
}

function packetAuditInput(input: {
  userId: string;
  row: ResumeRow;
  review: ApplicationReviewState;
  packet: SubmissionPacket;
  pdfBytes: Buffer;
}) {
  const stored = record(input.row.spec) ?? {};
  const contact = record(stored._contact) ?? {};
  const resumeEmail = typeof contact.email === 'string' ? contact.email.trim().toLowerCase() : '';
  const applicantEmail = input.packet.applicantEmail?.address.trim().toLowerCase() ?? '';
  return {
    ownerId: input.userId,
    applicationId: input.row.id,
    jdText: input.review.jd_text,
    spec: input.row.spec,
    jobContext: input.row.job_context,
    questions: input.review.questions,
    applicantSnapshot: input.packet.applicantSnapshot ?? null,
    employerDelivery: input.review.employer_delivery_bindings,
    resumeEmail,
    applicantEmail,
    pdfObjectKey: input.row.resume_object_key,
    pdfBytes: input.pdfBytes,
  };
}

async function linkExactPacket(
  tx: Pick<typeof db, 'select' | 'insert' | 'update'>,
  input: {
    userId: string;
    applicationId: string;
    packetId: string;
    artifactId: string;
    attachedAt: Date;
  },
) {
  await linkGeneratedPacketToCanonicalApplication(tx, {
    userId: input.userId,
    applicationId: input.applicationId,
    generatedResumeId: input.packetId,
    artifactId: input.artifactId,
  });
  const [attached] = await tx.update(applications).set({
    resume_attached: true,
    resume_source: 'artifact',
    resume_attached_at: input.attachedAt,
    updated_at: input.attachedAt,
  }).where(and(
    eq(applications.id, input.applicationId),
    eq(applications.user_id, input.userId),
  )).returning({ id: applications.id });
  if (!attached) prepareError(409, 'managed_application_changed', 'The application changed before its packet could be linked.');
}

export async function prepareManagedApplication(
  input: { userId: string; jobId: string },
  dependencyOverrides: Partial<ManagedPrepareDependencies> = {},
): Promise<ManagedPrepareResult> {
  const dependencies = { ...defaultDependencies, ...dependencyOverrides };
  await retryManagedPrepareObjectCleanup(input.userId, dependencies).catch(() => undefined);
  const [[posting], [profile], [account]] = await Promise.all([
    db.select({
      id: monitored_jobs.id,
      companyName: monitored_jobs.company_name,
      role: monitored_jobs.title,
      description: monitored_jobs.description,
      location: monitored_jobs.location,
      applyUrl: monitored_jobs.apply_url,
      active: monitored_jobs.is_active,
      postingDeadline: monitored_jobs.posting_deadline,
      sourceEnabled: career_page_sources.enabled,
      sourceFamily: career_page_sources.ats_name,
    }).from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(eq(monitored_jobs.id, input.jobId))
      .limit(1),
    db.select(MAIN_RESUME_PROFILE_COLUMNS).from(profiles).where(eq(profiles.user_id, input.userId)).limit(1),
    db.select({ email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1),
  ]);

  if (!posting || !posting.active || !posting.sourceEnabled) {
    return prepareError(404, 'managed_job_not_found', 'This monitored job is no longer available.');
  }
  const baseResume = mainResumeOfRecordFor(profile);
  if (!baseResume) {
    return prepareError(409, 'main_resume_missing', 'Build your main resume before preparing this application.');
  }
  /* The same bar /resume/base and /resume/generate hold (missingRequiredEducation): a record with
     no school or degree prints a blank line, and a blank line is not a resume an employer should
     receive. Refused here, before any packet or canonical row exists, with the box to fill named. */
  if (!baseResume.school.trim() || !baseResume.degree.trim()) {
    return prepareError(422, 'main_resume_education_missing', 'Your profile has no school or degree on record. Add them under Documents, then prepare this application again.');
  }
  const mainResumeDigest = packetAuditSha256(baseResume);
  const jdText = posting.description.trim();
  if (!jdText) return prepareError(422, 'managed_job_description_missing', 'This job has no description to review.');
  const destination = normalizedSecureDestination(posting.applyUrl, posting.sourceFamily);
  /* THE MONITOR'S OWN COLUMN FIRST, A LIVE PARSE ONLY AS FALLBACK. posting.postingDeadline is
   * whatever the ingest poll (jobMonitor.ts) computed against the freshest description this row
   * has ever carried; parseStatedApplicationDeadline(jdText) is the SAME parser run against the
   * exact text this packet is freezing, which covers a job whose row has not been repolled since
   * the column shipped (or since a deadline sentence was added to its posting). Frozen once, here,
   * exactly like jd_hash beside it - a later edit to the live posting must not silently move a
   * deadline this packet was already built against. */
  const postingDeadline = posting.postingDeadline ?? parseStatedApplicationDeadline(jdText)?.deadlineUtc ?? null;
  const jobContext = {
    company: posting.companyName,
    role: posting.role,
    jd_hash: packetAuditTextSha256(jdText).slice(0, 16),
    job_id: posting.id,
    ...(posting.location?.trim() ? { location: posting.location.trim() } : {}),
    ...(postingDeadline ? { posting_deadline: postingDeadline.toISOString() } : {}),
  };

  const canonical = await dependencies.upsertCanonicalApplication({
    userId: input.userId,
    jobId: posting.id,
    companyScopeKey: canonicalCompanyScope({ companyName: posting.companyName }),
    companyName: posting.companyName,
    role: posting.role,
    sourceSurface: 'dashboard',
  });
  const applicationId = canonical.application.id;

  type PreparedStage = {
    row: ResumeRow;
    pdfBytes?: Buffer;
    blobUrl?: string;
    created: boolean;
    completed?: ManagedPrepareResult;
    reservation?: {
      id: string;
      previousSpec: unknown;
      baseResume: ResumeSpec;
      parsedProfile: Record<string, unknown>;
      accountEmail?: string;
      requestedKey: string;
    };
  };

  let stage = await db.transaction(async (tx): Promise<PreparedStage> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`canonical-application:${input.userId}`}, 0::bigint))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`managed-prepare:${input.userId}:${posting.id}`}, 0::bigint))`);

    const [currentApplication] = await tx.select().from(applications).where(and(
      eq(applications.id, applicationId),
      eq(applications.user_id, input.userId),
    )).limit(1);
    const [currentProfile] = await tx.select(MAIN_RESUME_PROFILE_COLUMNS).from(profiles)
      .where(eq(profiles.user_id, input.userId)).limit(1);
    const [currentAccount] = await tx.select({ email: users.email })
      .from(users).where(eq(users.id, input.userId)).limit(1);
    if (!currentApplication) {
      return prepareError(409, 'managed_application_changed', 'The application changed before its packet could be prepared.');
    }
    const currentBaseResume = mainResumeOfRecordFor(currentProfile);
    if (!currentBaseResume) {
      return prepareError(409, 'main_resume_missing', 'Build your main resume before preparing this application.');
    }
    if (packetAuditSha256(currentBaseResume) !== mainResumeDigest) {
      return prepareError(409, 'main_resume_changed', 'Your main resume or your education details changed while Litos was preparing it. Try again.');
    }

    const candidates = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.user_id, input.userId),
      sql`${generated_resumes.job_context}->>'job_id' = ${posting.id}`,
      sql`${generated_resumes.spec}->'_managed_prepare'->>'version' = ${MANAGED_PREPARE_VERSION}`,
      sql`${generated_resumes.spec}->'_managed_prepare'->>'canonical_application_id' = ${applicationId}`,
      sql`${generated_resumes.spec}->'_managed_prepare'->>'main_resume_digest' = ${mainResumeDigest}`,
    )).limit(2);
    if (candidates.length > 1) {
      return prepareError(409, 'managed_packet_ambiguous', 'Litos found more than one packet for this exact application and stopped safely.');
    }

    const existing = candidates[0];
    if (existing) {
      const metadata = managedPrepareMetadata(existing.spec);
      const reservation = managedPrepareReservationMetadata(existing.spec);
      const identity = metadata ?? reservation;
      if (!identity
        || identity.packet_id !== existing.id
        || identity.job_id !== posting.id
        || identity.canonical_application_id !== applicationId) {
        return prepareError(409, 'managed_packet_identity_mismatch', 'The saved packet does not match this application. Nothing was opened or sent.');
      }
      const completedReview = metadata ? exactManagedReview(existing, applicationId) : null;
      if (metadata && completedReview) {
        const [artifact] = await tx.select().from(artifacts).where(and(
          eq(artifacts.user_id, input.userId),
          eq(artifacts.legacy_generated_resume_id, existing.id),
        )).limit(1);
        const [version] = artifact
          ? await tx.select().from(artifact_versions).where(eq(artifact_versions.artifact_id, artifact.id)).limit(1)
          : [];
        if (!artifact
          || !version
          || artifact.rendered_object_key !== existing.resume_object_key
          || version.rendered_object_key !== existing.resume_object_key
          || artifact.rendered_blob_url !== version.rendered_blob_url
          || !isDeepStrictEqual(artifact.structured_content, existing.spec)
          || !isDeepStrictEqual(version.structured_content, existing.spec)
          || version.content_hash !== immutableDocumentContentHash(existing.spec)) {
          return prepareError(409, 'managed_packet_incomplete', 'The saved packet is incomplete and was not opened or sent.');
        }
        const [selectedLink] = await tx.select().from(application_artifacts).where(and(
          eq(application_artifacts.application_id, applicationId),
          eq(application_artifacts.artifact_id, artifact.id),
          eq(application_artifacts.purpose, 'resume'),
          eq(application_artifacts.selected, true),
        )).limit(1);
        const exactCanonicalLink = currentApplication.legacy_generated_resume_id === existing.id
          && currentApplication.selected_resume_artifact_id === artifact.id
          && currentApplication.resume_attached
          && currentApplication.resume_source === 'artifact'
          && Boolean(selectedLink);
        if (!exactCanonicalLink) {
          const terminal = currentApplication.submission_state === 'submitted'
            || currentApplication.tracker_state === 'applied';
          if (terminal) {
            return prepareError(409, 'managed_application_already_submitted', 'This application is already submitted and its packet cannot be replaced.');
          }
          await tx.insert(application_artifacts).values({
            application_id: applicationId,
            artifact_id: artifact.id,
            purpose: 'resume',
            selected: false,
          }).onConflictDoNothing();
          await linkExactPacket(tx, {
            userId: input.userId,
            applicationId,
            packetId: existing.id,
            artifactId: artifact.id,
            attachedAt: dependencies.now(),
          });
        }
        return {
          row: existing,
          created: false,
          completed: {
            application_id: applicationId,
            packet_id: existing.id,
            state: metadata.state,
            review: completedReview,
            reused: true,
          },
        };
      }

      const terminal = currentApplication.submission_state === 'submitted'
        || currentApplication.tracker_state === 'applied';
      if (terminal) {
        return prepareError(409, 'managed_application_already_submitted', 'This application is already submitted and its packet cannot be replaced.');
      }

      if (reservation) {
        const expectedReservationKey = reservation.requested_object_key;
        if (!managedPrepareReservationObjectKeyMatches({
          userId: input.userId,
          jobId: posting.id,
          mainResumeDigest,
          objectKey: expectedReservationKey,
        }) || existing.resume_object_key !== expectedReservationKey) {
          return prepareError(409, 'managed_packet_identity_mismatch', 'The saved packet does not match this application. Nothing was opened or sent.');
        }
        const reservationNow = dependencies.now();
        if (Date.parse(reservation.lease_expires_at) > reservationNow.getTime()) {
          return prepareError(409, 'managed_packet_preparing', 'Litos is already preparing this exact packet. Try again shortly.');
        }
        const reservationId = dependencies.newId();
        // Every renderer owns an immutable object identity. Reusing the expired key lets a stale
        // worker overwrite the winner after the winner commits. The old key remains as a durable
        // cleanup obligation so a crash after a late stale upload cannot strand applicant PII.
        const requestedKey = managedPrepareReservationObjectKey({
          userId: input.userId,
          jobId: posting.id,
          mainResumeDigest,
          reservationId,
        });
        const nextReservation = managedPrepareReservation({
          applicationId,
          packetId: existing.id,
          jobId: posting.id,
          mainResumeDigest,
          state: destination.state,
          reservationId,
          reservedAt: reservationNow,
          requestedObjectKey: requestedKey,
        });
        await tx.insert(managed_prepare_object_cleanups).values([
          {
            object_key: expectedReservationKey,
            user_id: input.userId,
            packet_id: existing.id,
            created_at: reservationNow,
          },
          {
            object_key: requestedKey,
            user_id: input.userId,
            packet_id: existing.id,
            created_at: reservationNow,
          },
        ]).onConflictDoNothing();
        const nextSpec = { ...currentBaseResume, _managed_prepare: nextReservation };
        const [takenOver] = await tx.update(generated_resumes).set({
          spec: nextSpec,
          resume_object_key: requestedKey,
        }).where(and(
          eq(generated_resumes.id, existing.id),
          eq(generated_resumes.user_id, input.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(existing.spec)}::jsonb`,
          eq(generated_resumes.resume_object_key, expectedReservationKey),
        )).returning();
        if (!takenOver) {
          return prepareError(409, 'managed_packet_changed', 'The packet changed while Litos was preparing it. Reload and try again.');
        }
        return {
          row: takenOver,
          created: false,
          reservation: {
            id: reservationId,
            previousSpec: takenOver.spec,
            baseResume: currentBaseResume,
            parsedProfile: record(currentProfile.parsed) ?? {},
            accountEmail: currentAccount?.email ?? account?.email ?? undefined,
            requestedKey,
          },
        };
      }
      if (!metadata) {
        return prepareError(409, 'managed_packet_identity_mismatch', 'The saved packet does not match this application. Nothing was opened or sent.');
      }

      const [unexpectedArtifact] = await tx.select({ id: artifacts.id }).from(artifacts).where(and(
        eq(artifacts.user_id, input.userId),
        eq(artifacts.legacy_generated_resume_id, existing.id),
      )).limit(1);
      if (unexpectedArtifact) {
        return prepareError(409, 'managed_packet_incomplete', 'The saved packet is incomplete and was not opened or sent.');
      }
      return { row: existing, blobUrl: metadata.rendered_blob_url, created: false };
    }

    const terminal = currentApplication.submission_state === 'submitted'
      || currentApplication.tracker_state === 'applied';
    if (terminal) {
      return prepareError(409, 'managed_application_already_submitted', 'This application is already submitted and its packet cannot be replaced.');
    }

    const packetId = dependencies.newId();
    const reservationId = dependencies.newId();
    const requestedKey = managedPrepareReservationObjectKey({
      userId: input.userId,
      jobId: posting.id,
      mainResumeDigest,
      reservationId,
    });
    const reservationNow = dependencies.now();
    const reservation = managedPrepareReservation({
      applicationId,
      packetId,
      jobId: posting.id,
      mainResumeDigest,
      state: destination.state,
      reservationId,
      reservedAt: reservationNow,
      requestedObjectKey: requestedKey,
    });
    const reservedSpec = { ...currentBaseResume, _managed_prepare: reservation };
    const [inserted] = await tx.insert(generated_resumes).values({
      id: packetId,
      user_id: input.userId,
      job_context: jobContext,
      spec: reservedSpec,
      resume_object_key: requestedKey,
    }).returning();
    if (!inserted) return prepareError(500, 'managed_packet_persistence_failed', 'Litos could not reserve the prepared packet. Nothing was opened or sent.');
    await tx.insert(managed_prepare_object_cleanups).values({
      object_key: requestedKey,
      user_id: input.userId,
      packet_id: packetId,
      created_at: reservationNow,
    }).onConflictDoNothing();
    return {
      row: inserted,
      created: true,
      reservation: {
        id: reservationId,
        previousSpec: inserted.spec,
        baseResume: currentBaseResume,
        parsedProfile: record(currentProfile.parsed) ?? {},
        accountEmail: currentAccount?.email ?? account?.email ?? undefined,
        requestedKey,
      },
    };
  });

  if (stage.completed) return stage.completed;

  if (stage.reservation) {
    const reservation = stage.reservation;
    let storedByReservation = false;
    const abandonReservation = async (): Promise<boolean> => db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`canonical-application:${input.userId}`}, 0::bigint))`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`managed-prepare:${input.userId}:${posting.id}`}, 0::bigint))`);
        const [current] = await tx.select({
          objectKey: generated_resumes.resume_object_key,
          spec: generated_resumes.spec,
        }).from(generated_resumes).where(and(
          eq(generated_resumes.id, stage.row.id),
          eq(generated_resumes.user_id, input.userId),
        )).limit(1);
        if (!current) return true;
        // A takeover now has a different immutable key. This worker can always remove its own key,
        // including when it uploaded after the takeover committed.
        if (current.objectKey !== reservation.requestedKey) return true;
        const currentReservation = managedPrepareReservationMetadata(current.spec);
        if (currentReservation?.reservation_id !== reservation.id) return false;
        const deleted = await tx.delete(generated_resumes).where(and(
          eq(generated_resumes.id, stage.row.id),
          eq(generated_resumes.user_id, input.userId),
          sql`${generated_resumes.spec}->'_managed_prepare'->>'phase' = 'reserved'`,
          sql`${generated_resumes.spec}->'_managed_prepare'->>'reservation_id' = ${reservation.id}`,
          sql`not exists (
            select 1 from ${artifacts}
             where ${artifacts.legacy_generated_resume_id} = ${generated_resumes.id}
          )`,
        )).returning({ id: generated_resumes.id });
        return deleted.length > 0;
      });

    try {
      const resumeEmail = resumeEmailForUpload(reservation.parsedProfile, reservation.accountEmail);
      const applicationProfile = await dependencies.loadApplicationProfile(input.userId);
      const contact = mainResumeContactHeader(
        reservation.parsedProfile,
        applicationProfile as Record<string, unknown>,
        resumeEmail,
      );
      const applicantEmail = await dependencies.planApplicantEmail({
        userId: input.userId,
        applicationId: stage.row.id,
        contactEmail: resumeEmail,
        accountEmail: reservation.accountEmail,
        contactFromRequest: false,
      });
      trackedApplicantEmail(applicantEmail);

      let rendered: RenderedMainResume;
      try {
        rendered = await dependencies.renderMainResume({ spec: reservation.baseResume, contact });
      } catch {
        return prepareError(422, 'main_resume_render_failed', 'Litos could not render your saved main resume. Nothing was opened or sent.');
      }
      if (!Buffer.isBuffer(rendered.buffer) || rendered.buffer.byteLength === 0) {
        return prepareError(500, 'main_resume_render_failed', 'Litos could not render your saved main resume. Nothing was opened or sent.');
      }
      const renderedSpec = normalizeSpec(rendered.spec);
      const stored = await dependencies.storeResume(reservation.requestedKey, rendered.buffer);
      storedByReservation = true;
      if (stored.pathname !== reservation.requestedKey || !stored.url.trim()) {
        return prepareError(500, 'main_resume_storage_failed', 'Litos could not store the exact main resume packet. Nothing was opened or sent.');
      }
      const storedBytes = await dependencies.readResume(stored.pathname);
      if (!storedBytes || !storedBytes.equals(rendered.buffer)) {
        return prepareError(500, 'main_resume_storage_failed', 'Litos could not verify the exact stored main resume packet. Nothing was opened or sent.');
      }

      const now = dependencies.now().toISOString();
      const review: ApplicationReviewState = {
        jd_text: jdText,
        role: posting.role,
        status: 'resume_ready',
        applicant_email: applicantEmail.choice,
        edited_terms: [],
        questions: [],
        skipped_reasons: [],
        filled_fields: [],
        updated_at: now,
      };
      const metadata: ManagedPrepareMetadata = {
        version: MANAGED_PREPARE_VERSION,
        canonical_application_id: applicationId,
        packet_id: stage.row.id,
        job_id: posting.id,
        resume_source: 'main_resume',
        main_resume_digest: mainResumeDigest,
        rendered_blob_url: stored.url,
        state: destination.state,
        phase: 'stored',
      };
      const storedSpec = {
        ...renderedSpec,
        _contact: contact,
        _applicant_email: applicantEmail.choice,
        _application_email: applicantEmail.identity,
        _managed_prepare: metadata,
        _review: review,
        _quality: {
          pdfGenerationBinding: createPdfGenerationBinding(
            renderedSpec,
            stored.pathname,
            rendered.buffer,
            contact.email ?? '',
          ),
        },
      };

      const preliminary = await db.transaction(async (tx): Promise<ResumeRow> => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`canonical-application:${input.userId}`}, 0::bigint))`);
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`managed-prepare:${input.userId}:${posting.id}`}, 0::bigint))`);
        const [currentApplication] = await tx.select().from(applications).where(and(
          eq(applications.id, applicationId),
          eq(applications.user_id, input.userId),
        )).limit(1);
        const [currentProfile] = await tx.select(MAIN_RESUME_PROFILE_COLUMNS).from(profiles)
          .where(eq(profiles.user_id, input.userId)).limit(1);
        if (!currentApplication) {
          return prepareError(409, 'managed_application_changed', 'The application changed before its packet could be committed.');
        }
        const committedMainResume = mainResumeOfRecordFor(currentProfile);
        if (!committedMainResume || packetAuditSha256(committedMainResume) !== mainResumeDigest) {
          return prepareError(409, 'main_resume_changed', 'Your main resume or your education details changed while Litos was preparing it. Try again.');
        }
        if (currentApplication.submission_state === 'submitted'
          || currentApplication.tracker_state === 'applied') {
          return prepareError(409, 'managed_application_already_submitted', 'This application is already submitted and its packet cannot be replaced.');
        }
        const [updated] = await tx.update(generated_resumes).set({
          spec: storedSpec,
          resume_object_key: stored.pathname,
        }).where(and(
          eq(generated_resumes.id, stage.row.id),
          eq(generated_resumes.user_id, input.userId),
          sql`${generated_resumes.spec} = ${JSON.stringify(reservation.previousSpec)}::jsonb`,
          eq(generated_resumes.resume_object_key, reservation.requestedKey),
          sql`${generated_resumes.spec}->'_managed_prepare'->>'reservation_id' = ${reservation.id}`,
        )).returning();
        if (!updated) {
          return prepareError(409, 'managed_packet_changed', 'The packet changed while Litos was preparing it. Reload and try again.');
        }
        await tx.insert(application_email_aliases).values({
          alias: applicantEmail.identity.alias,
          user_id: input.userId,
          generated_resume_id: updated.id,
          forward_to: applicantEmail.identity.forwards_to,
          status: 'active',
          updated_at: dependencies.now(),
        }).onConflictDoNothing();
        const [storedAlias] = await tx.select().from(application_email_aliases).where(and(
          eq(application_email_aliases.alias, applicantEmail.identity.alias),
          eq(application_email_aliases.user_id, input.userId),
          eq(application_email_aliases.generated_resume_id, updated.id),
          eq(application_email_aliases.forward_to, applicantEmail.identity.forwards_to),
          eq(application_email_aliases.status, 'active'),
        )).limit(1);
        if (!storedAlias) {
          return prepareError(409, 'managed_application_email_conflict', 'Litos could not bind one application email to this exact packet. Nothing was opened or sent.');
        }
        return updated;
      });
      stage = {
        row: preliminary,
        pdfBytes: rendered.buffer,
        blobUrl: stored.url,
        created: stage.created,
      };
    } catch (error) {
      const abandoned = await abandonReservation().catch(() => false);
      if (storedByReservation && abandoned) {
        await dependencies.deleteResume(reservation.requestedKey).catch(() => undefined);
      }
      throw error;
    }
  }

  const pdfBytes = stage.pdfBytes ?? await dependencies.readResume(stage.row.resume_object_key);
  if (!pdfBytes || pdfBytes.byteLength === 0) {
    return prepareError(409, 'managed_packet_document_missing', 'The prepared main resume file is unavailable. Nothing was opened or sent.');
  }
  const packet = await dependencies.buildSubmissionPacket(stage.row, Buffer.from(pdfBytes));
  if (!packet.applicantEmail
    || packet.applicantEmail.source !== 'litos_alias'
    || packet.applicantEmail.tracked !== true
    || !packet.applicantSnapshot
    || !Buffer.isBuffer(packet.resume)
    || !packet.resume.equals(pdfBytes)) {
    return prepareError(409, 'managed_packet_identity_incomplete', 'Litos could not freeze one exact applicant packet. Nothing was opened or sent.');
  }
  const currentReview = readApplicationReview(stage.row.spec);
  if (!currentReview) return prepareError(409, 'managed_packet_incomplete', 'The saved packet has no review state. Nothing was opened or sent.');
  const runtime = dependencies.browserRuntime();
  const delivery = createEmployerDeliveryBindings(packet, currentReview, {
    mode: 'browser',
    envelope: employerDeliveryEnvelope({
      channel: browserEmployerDeliveryChannel(runtime.provider),
      destinationUrl: destination.destinationUrl,
      portalFamily: destination.portalFamily,
      runtime,
    }),
  });
  const reviewWithDelivery: ApplicationReviewState = {
    ...currentReview,
    applicant_email: packet.applicantEmail,
    applicant_snapshot: packet.applicantSnapshot,
    employer_delivery_bindings: delivery,
  };
  const audit = createPacketAudit({
    ...packetAuditInput({
      userId: input.userId,
      row: stage.row,
      review: reviewWithDelivery,
      packet,
      pdfBytes: Buffer.from(pdfBytes),
    }),
    editedTerms: [],
    clauses: [exactJdClause(reviewWithDelivery.jd_text)],
    rejected: [],
    degraded: false,
    terms: { covered: [], missing: [], edited: [] },
  });
  const finalReview: ApplicationReviewState = {
    ...reviewWithDelivery,
    packet_audit: audit,
  };
  const finalSpec = { ...(stage.row.spec as Record<string, unknown>), _review: finalReview };

  const committedResult = await db.transaction(async (tx): Promise<ManagedPrepareResult> => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`canonical-application:${input.userId}`}, 0::bigint))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`managed-prepare:${input.userId}:${posting.id}`}, 0::bigint))`);
    const [currentRow] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, stage.row.id),
      eq(generated_resumes.user_id, input.userId),
    )).limit(1);
    const [currentApplication] = await tx.select().from(applications).where(and(
      eq(applications.id, applicationId),
      eq(applications.user_id, input.userId),
    )).limit(1);
    const [currentProfile] = await tx.select(MAIN_RESUME_PROFILE_COLUMNS).from(profiles)
      .where(eq(profiles.user_id, input.userId)).limit(1);
    if (!currentRow || !currentApplication) {
      return prepareError(409, 'managed_application_changed', 'The application changed before its packet could be committed.');
    }
    const completedMainResume = mainResumeOfRecordFor(currentProfile);
    if (!completedMainResume || packetAuditSha256(completedMainResume) !== mainResumeDigest) {
      return prepareError(409, 'main_resume_changed', 'Your main resume or your education details changed while Litos was preparing it. Try again.');
    }

    const alreadyCompleted = exactManagedReview(currentRow, applicationId);
    if (alreadyCompleted) {
      const metadata = managedPrepareMetadata(currentRow.spec)!;
      return {
        application_id: applicationId,
        packet_id: currentRow.id,
        state: metadata.state,
        review: alreadyCompleted,
        reused: true,
      };
    }
    if (!isDeepStrictEqual(currentRow.spec, stage.row.spec)
      || currentRow.resume_object_key !== stage.row.resume_object_key) {
      return prepareError(409, 'managed_packet_changed', 'The packet changed while Litos was preparing it. Reload and try again.');
    }
    const terminal = currentApplication.submission_state === 'submitted'
      || currentApplication.tracker_state === 'applied';
    if (terminal) {
      return prepareError(409, 'managed_application_already_submitted', 'This application is already submitted and its packet cannot be replaced.');
    }

    const artifactId = dependencies.newId();
    const [updatedPacket] = await tx.update(generated_resumes).set({ spec: finalSpec }).where(and(
      eq(generated_resumes.id, currentRow.id),
      eq(generated_resumes.user_id, input.userId),
      sql`${generated_resumes.spec} = ${JSON.stringify(currentRow.spec)}::jsonb`,
      eq(generated_resumes.resume_object_key, currentRow.resume_object_key),
    )).returning({ id: generated_resumes.id });
    if (!updatedPacket) {
      return prepareError(409, 'managed_packet_changed', 'The packet changed while Litos was preparing it. Reload and try again.');
    }
    const blobUrl = stage.blobUrl?.trim() || null;
    await tx.insert(artifacts).values({
      id: artifactId,
      user_id: input.userId,
      legacy_generated_resume_id: currentRow.id,
      kind: 'resume',
      structured_content: finalSpec,
      rendered_object_key: currentRow.resume_object_key,
      rendered_blob_url: blobUrl,
      source: 'managed_main_resume',
    });
    await tx.insert(artifact_versions).values({
      artifact_id: artifactId,
      version_number: 1,
      generation_source: 'managed_main_resume',
      job_context: currentRow.job_context,
      content_hash: immutableDocumentContentHash(finalSpec),
      structured_content: finalSpec,
      rendered_object_key: currentRow.resume_object_key,
      rendered_blob_url: blobUrl,
    });
    await tx.insert(application_artifacts).values({
      application_id: applicationId,
      artifact_id: artifactId,
      purpose: 'resume',
      selected: false,
    });
    await linkExactPacket(tx, {
      userId: input.userId,
      applicationId,
      packetId: currentRow.id,
      artifactId,
      attachedAt: dependencies.now(),
    });
    const [committed] = await tx.select().from(generated_resumes).where(and(
      eq(generated_resumes.id, currentRow.id),
      eq(generated_resumes.user_id, input.userId),
    )).limit(1);
    const committedReview = committed ? exactManagedReview(committed, applicationId) : null;
    if (!committedReview) {
      return prepareError(500, 'managed_packet_persistence_failed', 'Litos could not commit the exact prepared packet. Nothing was opened or sent.');
    }
    return {
      application_id: applicationId,
      packet_id: committed.id,
      state: managedPrepareMetadata(committed.spec)!.state,
      review: committedReview,
      reused: !stage.created,
    };
  });
  await retryManagedPrepareObjectCleanup(input.userId, dependencies).catch(() => undefined);
  return committedResult;
}
