import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { eq, desc, and, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { objectStorageUsesRailway, putObject, readObject } from '../lib/objectStorage';
import { db } from '../db/index';
import { RESUME_CONTENT_LIMITS } from '../engine/resumeContentPolicy';
import { claimOnboardingBuildGrant, releaseOnboardingBuildGrant } from '../lib/onboardingBuildGrant';
import {
  applications,
  application_artifacts,
  artifact_versions,
  artifacts,
  profiles,
  generated_resumes,
  autofill_events,
  application_profile,
  monitored_jobs,
  career_page_sources,
  users,
} from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { readExperienceBankOrSeedFromBaseResume } from '../db/experienceBank';
import { allowHourly, claimCounterSlot, getCount, getEntitlements, LIMITS, monthPeriod, quotaExceededPayload, rateLimitedReply, releaseCounterSlot } from '../middleware/quota';
import { generateResumeSpec, type ResumeSpec } from '../llm/resumeSpec';
import {
  findPdfTextFidelityIssues,
  findPdfSafeMarginIssues,
  findResumeTypographyIssues,
  renderResumePdf,
  resumeContactIssues,
  validateResumeVisualLayout,
  type ResumeVisualLayout,
} from '../engine/resumeRender';
import {
  isProviderDependentResumeStyleIssue,
  validateResumeSpec,
  validatePdfLayout,
  pruneUngroundedContent,
} from '../engine/resumeValidate';
import { mintDownloadToken, readDownloadToken, resolveBlobUrl } from '../lib/resumeAccess';
import { apiBaseFor } from '../lib/apiBase';
import {
  resumeGenerateBodySchema,
  resumeGenerationFeatureSequence,
  type ResumeGenerateBody,
} from './resumeRequestSchema';
import {
  ensureApplicationEmailAlias,
  type ApplicantEmailChoice,
  type ApplicationEmailIdentity,
} from '../lib/applicationEmail';
import { planPacketApplicantEmail } from '../lib/packetApplicantEmail';
import {
  resumeGenerateSuccessResponseSchema,
  resumeQualityHoldResponseSchema,
} from './resumeResponseSchema';
import { extractPdfText } from '../lib/pdfText';
import { createPdfGenerationBinding } from '../lib/pdfGenerationBinding';
import { PRODUCT_NAME } from '../lib/product';
import { allowedSparseEntriesForGeneration, applyResumePolicy, educationFrom, enforceExperienceBulletFloor, type CandidateEducation } from '../engine/resumePolicy';
import { academicRecordRowFor } from './profile';
import { warmRequirementCache } from '../engine/warmRequirements';
import {
  actionPostingRowForUser,
  resolveJdText,
  type ActionPostingRow,
} from './jdMatch';
import { baseResumeSelectionIssues } from '../llm/baseResume';
import { leadAlignmentIssues, selectJdAlignedLead, type LeadFallbackDecision } from '../engine/leadAlignment';
import { deriveEditedTerms, readApplicationReview, type ApplicationReviewState } from '../lib/applicationReview';
import {
  repairHistoryReviewPortalFromMonitoredJob,
  repairReviewPortalFromMonitoredJob,
} from '../lib/applicationPortalRepair';
import {
  canonicalMonitoredPortalUrl,
  canonicalSupportedPortalUrl,
  detectPortal,
  isPortalSupported,
} from '../lib/portalSubmission';
import { contentDispositionFileName, resumeFileNameForRole } from '../lib/resumeFileName';
import { monitoredDescriptionHash } from '../lib/monitoredPortalRepair';
import { postingCountryCodeFromJobContext, postingCountryFromJobContext } from '../lib/jobLocation';
import { applicationContextForQuestionResolution, normalizeStoredPortalQuestions, refreshKnownQuestionAnswers, type ApplicationProfileLike } from '../lib/questionDiscovery';
import { packetQuestionFixpoint } from '../lib/packetQuestionIdentity';
import { reopenUnfitClosedChoiceQuestions } from '../lib/questionMetadata';
import { loadApplicationProfileLike } from '../lib/applicationProfileLike';
import { specWithoutDocumentPointers } from '../lib/documentStore';
import { recoverOwnedGeneratedDocument } from '../lib/downloadDocumentRecovery';
import { immutableDocumentContentHash } from '../lib/immutableDocumentHash';
import { authoritativeSubmissionProjection } from '../lib/authoritativeSubmissionProjection';
import { linkGeneratedPacketToCanonicalApplication } from '../lib/resumeArtifactVersions';
import { canonicalApplicationBindingMismatches } from '../lib/canonicalApplicationBinding';
import { selectApplicationProfileRow } from '../lib/applicationFacts';
import { resumeContactOfRecord } from '../lib/resumeContactOfRecord';
import { resumeEmailOfRecord } from '../lib/resumeEmail';
import {
  canonicalCompanyScope,
  commitEntitledUsage,
  entitledUsageRequestHash,
  getEntitledUsageReplay,
  releaseEntitledUsage,
  requireFeature,
  reserveEntitledUsage,
  usesLegacyMonthlyProductQuota,
} from '../lib/entitlements';

async function refreshedResumeReplay(
  request: FastifyRequest,
  userId: string,
  body: unknown,
): Promise<unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const response = body as Record<string, unknown>;
  if (typeof response.artifact_id !== 'string') return body;
  const [artifact] = await db.select({
    object_key: artifacts.rendered_object_key,
    blob_url: artifacts.rendered_blob_url,
  }).from(artifacts).where(and(
    eq(artifacts.id, response.artifact_id),
    eq(artifacts.user_id, userId),
  )).limit(1);
  if (!artifact?.object_key) return body;
  const resumeUrl = `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(
    userId,
    artifact.object_key,
    { blobUrl: objectStorageUsesRailway() ? undefined : artifact.blob_url ?? undefined },
  )}`;
  const application = response.application && typeof response.application === 'object' && !Array.isArray(response.application)
    ? { ...(response.application as Record<string, unknown>), download_url: resumeUrl }
    : response.application;
  return { ...response, resume_url: resumeUrl, application };
}

const MAX_SPEC_ATTEMPTS = 2; // 1 initial pass + 1 feedback-driven retry, per PRD-v2 Section 6.4's
// "automated quality gate" - bounded so a stubborn JD can't loop the endpoint indefinitely.

// Hard wall-clock ceiling for the whole request, measured from function entry (reqStart) so it
// accounts for the pre-loop work (auth, quota, bank/profile reads) too. Every model call is bounded
// to (deadline - post-gen reserve - elapsed), so a slow Anthropic response fails fast instead of
// 504ing AND there is guaranteed room after the last spec for the PDF render + parse + blob upload
// + audit inserts.
//
// DERIVED FROM vercel.json, NOT HAND-SET. This was the literal 55000, chosen on 2026-07-17 when
// maxDuration was 60. On 2026-07-23 (98a5777, "prepare modern portals within runtime budget")
// maxDuration went to 300 and this number did not move, so for eleven days the route gave itself
// 46s of model budget out of an available 300 and returned
// "Resume generation is taking too long" to students whose first Claude call simply ran past 46s.
// A long JD plus the whole experience bank is exactly the request that does that. baseResume.ts was
// updated for the new ceiling; this route was missed, and nothing in the build could notice because
// the coupling lived only in a comment. resume.test.ts now reads vercel.json and asserts the two
// agree, so the next maxDuration change either updates this or fails the build.
const VERCEL_MAX_DURATION_MS = 300_000;
// Left to Vercel for its own teardown, and to absorb cold-start time that reqStart never sees.
const PLATFORM_SAFETY_MARGIN_MS = 60_000;
export const REQUEST_DEADLINE_MS = VERCEL_MAX_DURATION_MS - PLATFORM_SAFETY_MARGIN_MS;
const POST_GEN_RESERVE_MS = 9000;

export const RESUME_DEADLINE_FOR_TEST = {
  vercelMaxDurationMs: VERCEL_MAX_DURATION_MS,
  requestDeadlineMs: REQUEST_DEADLINE_MS,
  postGenReserveMs: POST_GEN_RESERVE_MS,
};

function generatedResumeJobId(row: typeof generated_resumes.$inferSelect): string | null {
  const context = row.job_context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const parsed = z.string().uuid().safeParse((context as Record<string, unknown>).job_id);
  return parsed.success ? parsed.data : null;
}

export function requestedResumeLookupId<T extends { id: string }>(
  latestRows: readonly T[],
  requestedValue: unknown,
): string | null {
  const requestedId = z.string().uuid().safeParse(requestedValue);
  if (!requestedId.success) return null;
  if (latestRows.some((row) => row.id.toLowerCase() === requestedId.data.toLowerCase())) return null;
  return requestedId.data;
}

export function includeRequestedResumeInHistory<T extends { id: string; user_id: string }>(
  latestRows: readonly T[],
  requestedRow: T | null,
  userId: string,
): T[] {
  if (
    !requestedRow
    || requestedRow.user_id !== userId
    || latestRows.some((row) => row.id === requestedRow.id)
  ) return [...latestRows];
  return [requestedRow, ...latestRows];
}

/**
 * The public submission-authority envelope a `/resume/history` packet must carry for the dashboard
 * to authorise a first employer send, and only for a packet whose immutable submission history is
 * genuinely empty.
 *
 * The dashboard derives a packet's send authority from `packet.submission_authority` alone and
 * fail-closes when it is absent or does not parse. The exact envelope it accepts is the release's
 * client contract. This returns that envelope ONLY when the authoritative projection is `none` and
 * retry safety is `no_evidence`, which hold together exactly when the packet has no attempt-opened
 * event: the one state that may become sendable, whose wire projection is the irreducible
 * `{ state: 'none' }`. A `/resume/history` packet carries no embedded canonical row, so the gate's
 * identity for it is the packet id itself, which is what `application_id` and `packet_id` name.
 *
 * Any packet with attempt history classifies non-none (a sent one is `repair_required`) and gets
 * `undefined` here, so it stays without an envelope and as fail-closed at the gate as before: this
 * can free a genuinely un-attempted packet but can never turn a sent one sendable.
 */
export function submissionAuthorityEnvelopeForUnattemptedPacket(input: {
  packetId: string;
  projectionState: string | undefined;
  retrySafetyKind: string | undefined;
  revision: string | undefined;
}):
  | {
    schema_version: 'submission-authority-v1';
    revision: string;
    state: 'none';
    application_id: string;
    packet_id: string;
    projection: { state: 'none' };
    retry_safety: { kind: 'no_evidence' };
  }
  | undefined {
  // The client validator only accepts a canonical numeric revision (digits, <= int64). Requiring
  // the same here means a divergent revision shape returns undefined at the source instead of
  // being emitted and silently rejected downstream, which would strand the packet with no signal.
  const revisionIsCanonical = typeof input.revision === 'string'
    && input.revision.length <= 19
    && /^(?:0|[1-9][0-9]*)$/.test(input.revision)
    && (input.revision.length < 19 || input.revision <= '9223372036854775807');
  if (input.projectionState !== 'none'
    || input.retrySafetyKind !== 'no_evidence'
    || !revisionIsCanonical) return undefined;
  return {
    schema_version: 'submission-authority-v1',
    revision: input.revision as string,
    state: 'none',
    application_id: input.packetId,
    packet_id: input.packetId,
    projection: { state: 'none' },
    retry_safety: { kind: 'no_evidence' },
  };
}

function monitoredApplicationUrlForGenerate(posting: ActionPostingRow | null): string | undefined {
  if (!posting) return undefined;
  return canonicalMonitoredPortalUrl(
    posting.apply_url,
    posting.ats_name,
    posting.board_token,
    posting.external_id,
    posting.posting_url,
  );
}

function repairedHistorySpec(
  row: typeof generated_resumes.$inferSelect,
  monitoredJobs: ReadonlyMap<string, { applyUrl: string; company: string; role: string; description: string; jdHash: string }>,
): unknown {
  const review = readApplicationReview(row.spec);
  const spec = row.spec;
  if (!review || !spec || typeof spec !== 'object' || Array.isArray(spec)) return row.spec;
  const repaired = repairHistoryReviewPortalFromMonitoredJob(row, review, monitoredJobs);
  return { ...(spec as Record<string, unknown>), _review: repaired };
}

function refreshedHistorySpec(spec: unknown, profile: ApplicationProfileLike, jobContext: unknown): unknown {
  const review = readApplicationReview(spec);
  if (!review || !spec || typeof spec !== 'object' || Array.isArray(spec)) return spec;
  const asOf = new Date();
  const normalize = (questions: typeof review.questions) => review.portal_url && isPortalSupported(review.portal_url)
    ? normalizeStoredPortalQuestions(questions, detectPortal(review.portal_url))
    : questions;
  /* Same pre-send guard as resolvePacketAuditQuestionFixpoint: an unfit closed-choice answer
   * re-opens its question on the reading the dashboard renders, so a stuck row shows the blank
   * required question with its exact options without waiting for a new run - but a packet that may
   * already be with the employer keeps its stored answers as the record of what was sent. */
  const packetMayBeWithEmployer = Boolean(review.submission_claimed_at)
    || review.status === 'submitted'
    || review.status === 'awaiting_security_code';
  return {
    ...(spec as Record<string, unknown>),
    _review: {
      ...review,
      // Same context every live fill resolves against; see applicationContextForQuestionResolution.
      questions: packetQuestionFixpoint(
        normalize(review.questions),
        (questions) => {
          const refreshed = refreshKnownQuestionAnswers(
            questions,
            profile,
            applicationContextForQuestionResolution({ job_context: jobContext }, review),
            review.questions_reviewed_at,
            postingCountryFromJobContext(jobContext),
            postingCountryCodeFromJobContext(jobContext),
            asOf,
          );
          return normalize(packetMayBeWithEmployer ? refreshed : reopenUnfitClosedChoiceQuestions(refreshed));
        },
      ),
    },
  };
}

// ─── Transient model-capacity handling (live QA 2026-07-16) ──────────────────
// A real Anthropic `overloaded_error` incident killed a whole fill: the card showed "Failed to
// generate resume spec" and the only recovery was the student re-clicking "Yes, fill it". Two
// separate defects produced that, and they need two separate fixes.
//
// 1. IN-REQUEST WASTE. A 529 fails FAST (~1s), not slow. So an overload burned both
//    MAX_SPEC_ATTEMPTS in ~10s and gave up with ~45s of function budget still unspent. Worse, the
//    single attempt counter conflated two unrelated reasons to retry - a transient CAPACITY failure
//    and a QUALITY feedback pass - so one 529 silently consumed the feedback retry that exists to
//    raise ATS coverage. Fixed here: capacity retries get their own counter and backoff, and only a
//    real (non-transient) error or an exhausted budget ends the attempt.
//
// 2. THE CEILING. In-request retry CANNOT be the whole fix, and it is important not to pretend it
//    is. The observed incident needed ~6 attempts over ~2.5 MINUTES to get a 200. The function
//    ceiling has since moved (60s -> 300s, so REQUEST_DEADLINE_MS is now 240s), which means a
//    single request can now in principle outlast that particular incident where it once could not.
//    It is still not the whole fix: MAX_OVERLOAD_ATTEMPTS bounds the retries by COUNT, a longer
//    incident still outlives any one function, and a request that spends four minutes retrying is
//    a student watching a spinner. So exhausting these retries still returns a 503 +
//    `code: 'llm_overloaded'` + `retry_after_ms` rather than a generic 500 - it is a
//    machine-readable "come back", and the extension retries on it across requests while showing a
//    "capacity busy" state. A 500 is indistinguishable from a bad JD, so the client could only give
//    up. Large prompts are shed first during an overload and this route sends the JD plus the whole
//    experience bank, so it is most fragile exactly when capacity is tight.
const MAX_OVERLOAD_ATTEMPTS = 4;
const MIN_CALL_BUDGET_MS = 6000; // never start a model call with less than this left

export function shouldRetryResumeSpec(spec: ResumeSpec, issues: string[], attempt: number): boolean {
  return issues.length > 0
    && spec.generation_method !== 'local_fallback'
    && attempt < MAX_SPEC_ATTEMPTS;
}
const MAX_BACKOFF_MS = 6000;

// Anthropic returns 529 overloaded_error during a capacity incident and 429 when rate limited; the
// SDK surfaces both as APIError with a numeric `status`. Connection resets carry no status, so match
// those on the message. Deliberately NOT retried: 4xx other than 429 (a bad request stays bad), and
// APIUserAbortError (status undefined, message names an abort) - that is OUR deadline firing, and
// retrying it would just burn the budget we already ran out of.
export function isTransientOverload(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (typeof status === 'number') return status === 429 || status >= 500;
  if (!(err instanceof Error)) return false;
  if (/abort/i.test(err.name) || /abort/i.test(err.message)) return false;
  // Our own parse/truncation errors (resumeSpec.ts) embed up to 200 chars of MODEL OUTPUT in the
  // message. A JD or resume about networking puts the word "network" in that snippet, which would
  // satisfy the connection regex below and misclassify a deterministic parse failure as a transient
  // capacity blip - the client would then retry a request that fails identically every time. Name
  // those errors explicitly before any substring matching.
  if (/^(Claude returned invalid JSON|Resume spec truncated)/.test(err.message)) return false;
  return /connection|econnreset|socket|network|fetch failed/i.test(err.message);
}

// The OTHER permanent failure class R-012 exposed, distinct from both a transient overload and a
// genuinely bad request. Anthropic surfaces credit exhaustion as a 400 invalid_request_error
// whose message says so ("Your credit balance is too low to access the Anthropic API. Please go
// to Plans & Billing to upgrade or purchase credits."), and a revoked/wrong key as a 401 or 403.
// None of these are the student's fault and none are transient: retrying cannot refill a balance,
// and the generic "Failed to generate resume spec" card made a product-down incident look like a
// flaky JD for hours (live, 2026-07-17) - the student's only move was clicking "Yes, fill it"
// forever. Message-matching the 400 is deliberate and narrow: a 400 WITHOUT billing language is a
// malformed request from OUR code and must stay a plain 500, never be blamed on billing.
export function isBillingOrAuthFailure(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  if (status === 401 || status === 403) return true;
  if (status !== 400) return false;
  const message = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? '');
  return /credit balance|billing|purchase credits/i.test(message);
}

// One log line + one payload for every route that calls the model, so the operator action is
// named identically wherever the failure surfaces. 503 + code llm_billing mirrors the
// llm_overloaded plumbing shape, but deliberately carries NO retry_after_ms: the client must not
// hammer a dead account, and the distinct code is how it knows this one is permanent until an
// owner acts.
export const LLM_BILLING_LOG =
  'ANTHROPIC BILLING/AUTH FAILURE: every model-backed feature is DOWN for every user until the owner acts. Fix: top up credits in the Anthropic console, or rotate/restore ANTHROPIC_API_KEY (R-012)';
export const LLM_BILLING_PAYLOAD = {
  error: `Drafting is temporarily unavailable. This is a problem on our side, not something you did, and retrying will not fix it. The ${PRODUCT_NAME} team needs to restore service.`,
  code: 'llm_billing',
} as const;

// Honor Retry-After when the API sends one, else exponential backoff with jitter. Jitter matters:
// every Litos client retrying a shared incident on the same schedule would synchronize into a
// thundering herd against an API that is already shedding load.
export function overloadBackoffMs(err: unknown, attempt: number): number {
  const headers = (err as { headers?: { get?: (k: string) => string | null } })?.headers;
  const raw = typeof headers?.get === 'function' ? headers.get('retry-after') : null;
  const seconds = raw === null || raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  const expo = Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return expo + Math.floor(Math.random() * 250);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mergeEducationFallback(
  primary: CandidateEducation,
  fallback: unknown,
): CandidateEducation {
  const sourceRoot = (fallback && typeof fallback === 'object' ? fallback : {}) as Record<string, unknown>;
  const nested = (sourceRoot.education && typeof sourceRoot.education === 'object'
    ? sourceRoot.education
    : sourceRoot.academic && typeof sourceRoot.academic === 'object'
      ? sourceRoot.academic
      : {}) as Record<string, unknown>;
  const source = { ...nested, ...sourceRoot };
  const str = (value: unknown) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined);
  const gradYear = typeof source.grad_year === 'number' && source.grad_year > 0 ? source.grad_year : undefined;
  const coursework = Array.isArray(source.coursework)
    ? source.coursework.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    : undefined;
  return {
    ...primary,
    school: primary.school?.trim() || str(source.school) || '',
    degree: primary.degree?.trim() || str(source.degree),
    grad_date: primary.grad_date?.trim() || str(source.grad_date) || (gradYear ? String(gradYear) : undefined),
    grad_year: primary.grad_year ?? gradYear,
    currently_enrolled:
      primary.currently_enrolled ?? (typeof source.currently_enrolled === 'boolean' ? source.currently_enrolled : undefined),
    coursework: primary.coursework && primary.coursework.length > 0 ? primary.coursework : coursework,
    school_location: primary.school_location?.trim() || str(source.school_location),
  };
}

export function missingRequiredEducation(education: CandidateEducation): string[] {
  const issues: string[] = [];
  if (!education.school?.trim()) issues.push('education school is missing from the profile source');
  if (!education.degree?.trim()) issues.push('education degree is missing from the profile source');
  return issues;
}

export function missingRenderedEducation(spec: Pick<ResumeSpec, 'school' | 'degree'>): string[] {
  const issues: string[] = [];
  if (!spec.school?.trim()) issues.push('resume education school is blank in the generated preview');
  if (!spec.degree?.trim()) issues.push('resume education degree is blank in the generated preview');
  return issues;
}

// POST /autofill/event's body. Strip-mode on purpose (zod's default): unknown keys from newer
// extension builds are dropped rather than rejected, so the two sides can version independently.
// The flip side is that a field the extension sends but this schema does not name is dropped
// SILENTLY, which is how the R-030 telemetry almost vanished: the extension branch
// fix/r027-tags-r030-log ships r030_candidate_labels (the labels where linkQuestion matched with
// asksForLink false on a text input - the population the register says to sample live before
// designing any fix) and without the field here every sample would have been stripped on arrival.
// Not R-030-only anymore: the extension branch fix/r039-location-commitment-veto reuses the same
// channel for its telemetry, riding tag-prefixed entries "r039-veto:<label>" and
// "r039-third-party:<label>" alongside the plain R-030 label strings, so a consumer of this
// column must filter by prefix rather than assume every row is an R-030 sample.
// Bounds are telemetry-sized: 50 labels of 200 chars covers any real form and caps what a
// misbehaving client can store per event. Optional: older extensions and label-less fills omit it.
export const autofillEventSchema = z.object({
  ats_name: z.string().min(1),
  job_context: z.object({ company: z.string(), role: z.string() }),
  fields_filled: z.number().int().min(0),
  fields_skipped: z.number().int().min(0),
  auto_submitted: z.boolean().optional(),
  r030_candidate_labels: z.array(z.string().max(200)).max(50).optional(),
});

/**
 * The student-facing line explaining an uncitable lead, applied so it SURVIVES.
 *
 * It is added once when the fallback is decided and re-applied after the post-fit validation, which
 * assigns `specWarnings` outright rather than appending. A plain push at the decision point looked
 * correct and was measured wrong in production: the note was created and then discarded, so the
 * build stopped failing but never said why it led with what it led with.
 *
 * Idempotent, because it is applied more than once on the same request and a student reading two
 * copies of the same sentence would reasonably conclude something is broken.
 */
export function withLeadFallbackNote(
  warnings: ReturnType<typeof validateResumeSpec>['warnings'],
  fallback: LeadFallbackDecision | null,
): ReturnType<typeof validateResumeSpec>['warnings'] {
  if (!fallback) return warnings;
  if (warnings.some((w) => w.flags.includes(fallback.reason))) return warnings;
  return [...warnings, { entry: fallback.entry_org, bullet: '', flags: [fallback.reason] }];
}

export async function resumeRoutes(fastify: FastifyInstance) {
  // POST /resume/generate - tailor a resume to a specific JD from the student's experience bank
  /* GIVING THE FREE BUILD BACK WHEN IT DID NOT PRODUCE ANYTHING.
   *
   * The grant is claimed BEFORE generation, because the claim is what decides whether generation is
   * allowed to start at all and a read-then-write would let two concurrent builds each see it
   * unspent. That ordering means a model timeout, a render failure or any of this handler's many
   * early returns would otherwise cost a student a free build for something that produced
   * no resume.
   *
   * onSend rather than a try/catch around the generation: this handler answers from a dozen places
   * and throws from more, and a hook sees every one of them, including the error responses Fastify
   * serialises on its own. Anything from 400 up means nothing was delivered, so the stamp goes
   * back. The flag is cleared as it is read, so a retried send cannot release twice.
   */
  fastify.post('/resume/generate', {
    preHandler: requireAuth,
    onSend: async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
      const claimed = (request as FastifyRequest & { onboardingBuildGrantClaimed?: boolean }).onboardingBuildGrantClaimed;
      if (claimed && reply.statusCode >= 400) {
        (request as FastifyRequest & { onboardingBuildGrantClaimed?: boolean }).onboardingBuildGrantClaimed = false;
        await releaseOnboardingBuildGrant(request.jwtPayload!.userId);
      }
      return payload;
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const reqStart = Date.now(); // wall-clock anchor for the whole-request time budget (see budgetLeftMs)
    const userId = request.jwtPayload!.userId;

    let body: ResumeGenerateBody;
    try {
      body = resumeGenerateBodySchema.parse(request.body);
    } catch (err) {
      const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : undefined;
      return reply.status(400).send({ error: 'Invalid request body', detail });
    }

    const resumeId = randomUUID();
    const operationId = body.operation_id ?? resumeId;
    const requestHash = entitledUsageRequestHash('tailored_resume', {
      ...body,
      operation_id: undefined,
      initiation: undefined,
      prewarm: undefined,
      company: body.company.trim(),
      role: body.role.trim(),
    });
    const reservationScope = body.application_id ?? `resume:${requestHash}`;
    try {
      const replay = await getEntitledUsageReplay({
        userId,
        kind: 'tailored_resume',
        idempotencyKey: operationId,
        scopeKey: reservationScope,
        requestHash,
        requestedUnits: 1,
      });
      if (replay) {
        return reply.status(replay.statusCode).send(await refreshedResumeReplay(request, userId, replay.body));
      }
    } catch (error) {
      const candidate = error as { statusCode?: number; code?: string; message?: string };
      return reply.status(candidate.statusCode ?? 409).send({
        error: candidate.message ?? 'Resume generation cannot be replayed.',
        code: candidate.code ?? 'resume_operation_conflict',
      });
    }

    // Hover and background preparation are a distinct paid initiation. This check intentionally
    // precedes posting reads, quotas, reservations, profile decryption, model calls, and rendering.
    // An explicit click during a trial still checks only ai_resume_tailoring below.
    let tailoringVerdict: Awaited<ReturnType<typeof requireFeature>> | undefined;
    /* THE FREE BUILDS A NEW ACCOUNT GETS (two since 2026-09-01, so going back to re-upload a
       resume does not paywall the rebuild), claimed here rather than granted anywhere else,
       because this is the only place that knows a tailoring request was refused.
     *
       Onboarding builds a real application at step 3 and takes the card at step 10; tailoring is a
       Litos+ feature and a new account has no trial, so without this the flow stopped dead at step
       3 for everybody (measured on production 2026-08-19). The grant is limited per account and
       only while the account is still IN setup - both conditions are in the WHERE clause of the
       claim, so it cannot be overdrawn or taken by a finished account. See
       lib/onboardingBuildGrant.ts.
     *
       It is claimed only on a DENIAL. An entitled account never touches it, which is what keeps a
       paying student's build from silently consuming a grant they did not need. */
    let grantClaimed = false;
    for (const feature of resumeGenerationFeatureSequence(body.initiation)) {
      const initiationVerdict = await requireFeature(
        userId,
        feature,
        feature === 'hover_generation' ? 'hover_resume_tailor' : 'resume_tailor',
      );
      if (!initiationVerdict.allowed) {
        /* Hover generation is a paid convenience and is NOT what onboarding does. Letting it spend
           the grant would burn a student's one free build on a mouse movement they never asked to
           pay for, which is the opposite of what the grant is for. */
        if (feature !== 'ai_resume_tailoring' || !(await claimOnboardingBuildGrant(userId))) {
          return reply.status(402).send(initiationVerdict.denial);
        }
        grantClaimed = true;
        (request as FastifyRequest & { onboardingBuildGrantClaimed?: boolean }).onboardingBuildGrantClaimed = true;
        /* The DENIED verdict is still kept, and it has to be: it carries the entitlement snapshot
           the quota block below reads to decide which meter this account is on. Only `allowed`
           was false, and the grant is what answers that question instead. */
        tailoringVerdict = initiationVerdict;
        continue;
      }
      if (feature === 'ai_resume_tailoring') tailoringVerdict = initiationVerdict;
    }
    if (!tailoringVerdict) throw new Error('Tailoring entitlement preflight did not run');
    if (!grantClaimed && !tailoringVerdict.allowed) throw new Error('Tailoring entitlement preflight did not run');
    const featureVerdict = tailoringVerdict;

    /* THE POSTING, IN FULL, and not the preview the caller almost certainly sent.
     *
     * GET /jobs serves `left(description, 600)`, a preview sized for a list row, and the dashboard
     * hands that straight to this route as jd_text. So every packet built from the job list was
     * tailored to six hundred characters of company blurb and then STORED that as the JD it was
     * tailored against, which is worse than a wrong score: the resume itself was written for text
     * the employer's requirements were not in.
     *
     * Found 2026-08-04 on a real packet: spec._review.jd_text was exactly 600 characters and cut
     * mid-word, and the requirement breakdown built from it scored zero clauses because the
     * requirements section had been truncated away before the JD ever arrived.
     *
     * Fixed HERE rather than in the client, because the extension and any hand-typed link reach
     * this route too, and only the server can turn a job_id into the row. A caller with no job_id
     * still supplies its own text and is unaffected.
     */
    let jdText = body.jd_text;
    let postingLocation: string | null = null;
    let postingPortalCountry: string | null = null;
    let resolvedPosting: ActionPostingRow | null = null;
    let ownedCanonicalApplication: {
      id: string;
      job_id: string | null;
      company_name: string;
      role: string;
      portal_url: string | null;
    } | null = null;
    if (body.application_id) {
      const ownedCanonicalApplications = await db.select({
        id: applications.id,
        job_id: applications.job_id,
        company_name: applications.company_name,
        role: applications.role,
        portal_url: applications.portal_url,
      }).from(applications).where(and(
        eq(applications.id, body.application_id),
        eq(applications.user_id, userId),
      )).limit(1);
      ownedCanonicalApplication = ownedCanonicalApplications[0] ?? null;
      if (!ownedCanonicalApplication) {
        return reply.status(404).send({ error: 'Canonical application not found', code: 'application_not_found' });
      }
      const mismatches = canonicalApplicationBindingMismatches({
        jobId: ownedCanonicalApplication.job_id,
        company: ownedCanonicalApplication.company_name,
        role: ownedCanonicalApplication.role,
        portalUrl: ownedCanonicalApplication.portal_url,
      }, {
        jobId: body.job_id,
        company: body.company,
        role: body.role,
        portalUrl: body.application?.portal_url,
      });
      if (mismatches.length > 0) {
        return reply.status(409).send({
          error: 'Resume request does not match the canonical application',
          code: 'application_context_mismatch',
          mismatches,
        });
      }
    }

    const effectiveJobId = body.job_id ?? ownedCanonicalApplication?.job_id ?? undefined;
    if (effectiveJobId) {
      /* A raw UUID resolves only through the current verified board. The helper permits the
       * historical fallback only when this same user already owns an application or packet bound
       * to the row. Supplying a stale or unverified id alongside caller text cannot smuggle that id
       * into a new packet. */
      resolvedPosting = await actionPostingRowForUser(effectiveJobId, userId);
      if (!resolvedPosting) {
        return reply.status(409).send({
          error: 'Current verified posting not found',
          code: 'job_not_available',
        });
      }
      postingLocation = resolvedPosting.location;
      postingPortalCountry = resolvedPosting.portal_country;
      jdText = resolveJdText(jdText, resolvedPosting.description);
    }

    const monitoredApplicationUrl = monitoredApplicationUrlForGenerate(resolvedPosting);
    if (effectiveJobId && !monitoredApplicationUrl) {
      return reply.status(409).send({
        error: 'Current verified posting not found',
        code: 'job_not_available',
      });
    }
    if (effectiveJobId && ownedCanonicalApplication?.portal_url && resolvedPosting) {
      const boundStoredPortalUrl = canonicalMonitoredPortalUrl(
        ownedCanonicalApplication.portal_url,
        resolvedPosting.ats_name,
        resolvedPosting.board_token,
        resolvedPosting.external_id,
        resolvedPosting.posting_url,
      );
      if (!boundStoredPortalUrl || boundStoredPortalUrl !== monitoredApplicationUrl) {
        return reply.status(409).send({
          error: 'Canonical application portal does not match its monitored posting',
          code: 'application_context_mismatch',
          mismatches: ['portal_url'],
        });
      }
    }

    /* A monitored job is an action capability, not a hint. Once the request or its owned canonical
       application supplies a job id, only
       the URL reconstructed from that row's exact provider, board token, and posting identity may
       reach a browser runner. A cross-family or malformed row fails here before quota, generation,
       rendering, or storage. Caller URLs remain available only for the separate no-job flow. */
    const canonicalApplicationPortalUrl = body.application
      ? effectiveJobId
        ? monitoredApplicationUrl
        : canonicalSupportedPortalUrl(body.application.portal_url, body.application.ats_name)
          ?? body.application.portal_url
      : undefined;
    if (body.application && effectiveJobId && !canonicalApplicationPortalUrl) {
      return reply.status(409).send({
        error: 'Current verified posting not found',
        code: 'job_not_available',
      });
    }
    const canonicalApplicationPortalSupported = isPortalSupported(canonicalApplicationPortalUrl);

    // The v2 trial uses durable lifetime counters below. Existing grandfathered accounts retain
    // their monthly allowance, and paid plans retain the existing high safety ceiling.
    const ent = await getEntitlements(userId);
    const period = monthPeriod();
    /* THE GRANT CLEARS THE METERS TOO, and it has to, or it grants nothing.
     *
       A free account's allowance is zero, so an account that just took its one free build would be
       refused here instead - "You've used your 0 free resume generations this month", which is a
       sentence about a limit rather than about the build the student was promised. Measured against
       production after the entitlement gate was opened: the flow moved from one 402 to another.

       The grant is itself the allowance for this one request. It is capped at one per account by
       the claim, so skipping the meter cannot become an unmetered path: a second build finds the
       grant already spent and lands back on these same checks. */
    const useLegacyMonthlyCounter = !grantClaimed && usesLegacyMonthlyProductQuota(featureVerdict.snapshot);
    if (useLegacyMonthlyCounter) {
      const usedResumes = await getCount(userId, period, 'resumes');
      if (usedResumes >= ent.monthlyResumes) {
        return reply.status(402).send(quotaExceededPayload(ent, usedResumes, 'resumes'));
      }
    }

    if (!(await allowHourly(userId, 'resume', LIMITS.perHour.resume))) {
      return rateLimitedReply(reply);
    }

    const entitlementReservation = await reserveEntitledUsage({
      userId,
      kind: 'tailored_resume',
      idempotencyKey: operationId,
      requestHash,
      trigger: 'resume_tailor',
      applicationId: reservationScope,
    });
    if (!entitlementReservation.allowed) {
      /* The grant covers the reservation as well as the feature check. A free account has no units
         to reserve, so refusing here would take back with one hand exactly what the claim just gave
         with the other. The one-per-account cap still holds: the claim is what is capped, and a
         second build finds it spent and lands on this denial like anyone else. */
      if (!grantClaimed) return reply.status(402).send(entitlementReservation.denial);
    } else if (entitlementReservation.replay) {
      return reply.status(entitlementReservation.replay.statusCode).send(
        await refreshedResumeReplay(request, userId, entitlementReservation.replay.body),
      );
    }
    /* THE RESERVATION ID, OR NOTHING WHEN THE GRANT PAID FOR THIS BUILD.
     *
       A granted build reserves no units, because a free account has none to reserve. So there is
       nothing to release on failure and nothing to commit on success, and the calls below are
       no-ops rather than special cases scattered through a thousand lines of handler. */
    const reservationId = entitlementReservation.allowed ? entitlementReservation.reservationId : null;
    const releaseReservation = async () => {
      if (reservationId) await releaseEntitledUsage(reservationId);
    };
    let entitlementUsageCommitted = false;

    try {

    // These reads are independent. Starting them together removes one database round trip from
    // every generation while preserving readExperienceBank's load-bearing row ordering (R-022).
    /* application_profile joins the pair because it, not the parse, is the source of truth for the
       GPA the rendered PDF prints (see educationFrom) AND for the phone the contact line prints
       (see contactOfRecord below). Read in the same batch rather than after the bank check, so the
       authoritative academic record costs no wall clock on the happy path.

       HOISTED ABOVE THE ALIAS BLOCK, which used to sit here. The alias decision keys off "does this
       packet have an email at all", and that question cannot be answered before the account's own
       address has been merged in. Asking it of the raw request is what let a caller with an empty
       body.contact.email skip the alias AND ship a packet with no address of any kind. */
    const [bank, profileRows, applicationRow] = await Promise.all([
      readExperienceBankOrSeedFromBaseResume(userId),
      db.select().from(profiles).where(eq(profiles.user_id, userId)).limit(1),
      // Tolerant read, see lib/applicationFacts.ts.
      selectApplicationProfileRow(userId),
    ]);
    // Kept immediately after its read, where it has always been. Everything below spends something
    // (a scrypt-backed decrypt, then an MX lookup for the alias) on an account that cannot generate.
    if (bank.length === 0) {
      return reply.status(400).send({ error: 'Nothing saved about your work yet. Finish setting up first.' });
    }

    /* Decrypted ONCE for the two things on this request that read it: the academic record the
       education block prints, and the phone the contact line prints. Both used to decrypt their own
       copy (one inline here, none at all for the phone), and decryptField is scrypt-backed work. */
    const applicationRecord = academicRecordRowFor(applicationRow, (err) =>
      request.log.error(
        { err, userId },
        'application_profile could not be decrypted while generating a tailored resume. Printing no GPA and no stored phone rather than the resume parse, which is not the source of truth for either.',
      ),
    );

    /* THE CONTACT BLOCK, RESOLVED AGAINST THE ACCOUNT, not taken from the caller as gospel.
       See lib/resumeContactOfRecord.ts for the 28 production packets that made this necessary. */
    const resumeEmail = resumeEmailOfRecord(profileRows[0]?.parsed_json);
    if (!resumeEmail) {
      return reply.status(422).send({
        error: 'Add a personal resume email to your profile before generating this resume.',
        code: 'resume_email_required',
      });
    }
    const contactOfRecord = resumeContactOfRecord({
      requested: { ...body.contact, email: resumeEmail },
      accountEmail: resumeEmail,
      profile: applicationRecord,
    });

    /* REFUSED HERE, BEFORE THE MODEL CALL, rather than left to the renderer's own guard.
     *
     * renderResumePdf throws ResumeContactError on the same condition and that throw is the
     * backstop, but reaching it costs a Claude call, a PDF render and a text extraction first, and
     * answers the applicant with a 500 instead of a sentence. Nothing below this line can add an
     * email or a phone, so this is the earliest honest place to stop.
     *
     * NOTHING IS INVENTED to get past it. There is no third source to try: the login email and the
     * stored phone are the only two facts the account has, and a resume that prints a guess is
     * worse than a resume that is not made. */
    if (resumeContactIssues(contactOfRecord).length > 0) {
      return reply.status(422).send(resumeQualityHoldResponseSchema.parse({
        error: 'Litos did not make this resume because it has no way for an employer to reach you.',
        code: 'resume_quality_hold',
        quality: {
          ready_to_attach: false,
          issues: ['Add an email address or a phone number to your profile. A LinkedIn or GitHub link is somewhere to look you up, not somewhere to reply to you.'],
          warnings: [],
        },
      }));
    }

    /* EVERY PACKET GETS THIS DECISION, not only the ones that arrive carrying a portal link.
     *
     * This block used to be gated on `body.application`, and that gate is what put the applicant's
     * personal address on Flow Traders' Greenhouse form on 2026-08-11. `application` is optional in
     * the request schema, so a packet generated before its apply URL is known got no alias row and
     * no frozen decision. The URL is then recovered from the monitored posting afterwards
     * (repairedHistorySpec below, repairReviewPortalFromMonitoredJob), the packet becomes a real
     * application, and at submission resolveFrozenApplicantEmail has nothing pinned to read and
     * falls back to the address in `_contact`. The employer emailed a security code to a mailbox
     * Litos cannot read, and that run cannot finish itself.
     *
     * A missing portal link means the link has not been found YET. It never meant "this is not an
     * application", so it must not decide the address the document is frozen to. See
     * lib/packetApplicantEmail.ts, which now owns the whole decision. */
    const applicantEmailPlan = await planPacketApplicantEmail({
      userId,
      applicationId: resumeId,
      contactEmail: contactOfRecord.email,
      accountEmail: request.jwtPayload!.email,
      contactFromRequest: Boolean(body.contact.email),
    });
    const applicationEmail: ApplicationEmailIdentity | null = applicantEmailPlan.identity;
    const pinnedApplicantEmail: ApplicantEmailChoice | null = applicantEmailPlan.choice;
    if (!applicationEmail
      || !pinnedApplicantEmail
      || pinnedApplicantEmail.source !== 'litos_alias'
      || pinnedApplicantEmail.tracked !== true
      || pinnedApplicantEmail.address.toLowerCase() !== applicationEmail.alias.toLowerCase()
      || pinnedApplicantEmail.address.toLowerCase() === resumeEmail.toLowerCase()) {
      return reply.status(422).send({
        error: 'Litos could not create the tracked application email for this packet. Try again before applying.',
        code: 'applicant_email_regeneration_required',
      });
    }
    const applicationContact = contactOfRecord;
    if (bank.length === 0) {
      return reply.status(400).send({ error: 'Nothing saved about your work yet. Finish setting up first.' });
    }

    // NULL is normal and must stay non-fatal: accounts created before the base-resume step exists,
    // and anyone who skipped it, generate exactly as they did before.
    const baseSpec = (profileRows[0]?.base_resume_json as ResumeSpec | null) ?? null;
    const recentReview = (profileRows[0]?.parsed_json as {
      recent_experience_review?: { selected_entry_id?: string | null; continue_with_found?: boolean };
    } | null)?.recent_experience_review;
    const selectedEntryId = recentReview?.selected_entry_id;
    const priorityEntry = bank.find((entry) => entry.id === selectedEntryId) ?? null;

    const parsed = profileRows[0]?.parsed_json as {
      school?: string;
      degree?: string;
      grad_date?: string;
      grad_year?: number;
      currently_enrolled?: boolean;
      coursework?: string[];
      gpa?: string;
      gpa_scale?: string;
      school_location?: string;
      full_name?: string;
    } | undefined;
    /* The SAME builder /resume/base/stream uses. This was an inline object literal that had drifted
       into a near-copy of it, which is how the base and tailored documents came to disagree about
       the education block more than once - most recently on the GPA, which this path read from the
       parse while every other employer-facing surface read application_profile. */
    const education: CandidateEducation = mergeEducationFallback(
      mergeEducationFallback(
        educationFrom(parsed, applicationRecord),
        baseSpec,
      ),
      body.profile_education,
    );
    const educationIssues = missingRequiredEducation(education);
    if (educationIssues.length > 0) {
      return reply.status(422).send(resumeQualityHoldResponseSchema.parse({
        error: 'Your profile is missing education details, so Litos did not make this resume.',
        code: 'resume_quality_hold',
        quality: {
          ready_to_attach: false,
          issues: educationIssues,
          warnings: [],
        },
      }));
    }
    // The student's declared skills, the only authoritative source for the SKILLS line (R-015).
    // Filtered rather than cast: this is jsonb, so a hand-edited row can hold anything, and a
    // non-string in here would reach the model as junk and the validator as an unmatchable entry.
    const declaredSkills = (Array.isArray(profileRows[0]?.skills) ? profileRows[0].skills : [])
      .filter((s): s is string => typeof s === 'string' && s.trim().length > 0);

    // Generate -> validate -> (if issues) regenerate once with the issues as feedback -> validate
    // again and accept best-effort. Same two-layer pattern as the Dubai engine: the prompt states
    // the rules (resumeSpec.ts's SYSTEM_PROMPT), the validator (resumeValidate.ts) checks them,
    // and only genuine drift triggers a second Claude call instead of trusting the prompt alone.
    let spec: ResumeSpec | undefined;
    let specIssues: string[] = [];
    let leadIssues: string[] = [];
    /* Set by the FINAL reselect, after grounding and the bullet floor, when this posting and this
       resume share no citable evidence and the lead was ordered by rankLeadWithoutCitation instead.
       It is a WARNING, never an issue: see the 422 below for what treating it as an issue did to
       onboarding. */
    let leadFallback: LeadFallbackDecision | null = null;
    let specWarnings: ReturnType<typeof validateResumeSpec>['warnings'] = [];
    let atsCoverage = 0;

    const budgetLeftMs = () => REQUEST_DEADLINE_MS - POST_GEN_RESERVE_MS - (Date.now() - reqStart);

    for (let attempt = 1; attempt <= MAX_SPEC_ATTEMPTS; attempt++) {
      if (budgetLeftMs() < MIN_CALL_BUDGET_MS) {
        // Not enough of the function budget left for another full model call plus the reserved
        // render/upload time within Vercel's 60s.
        if (spec) break; // keep the prior spec and run it through the final deterministic gate
        return reply.status(503).send({ error: 'Resume generation is taking too long. Please try again.' });
      }
      try {
        // Capacity retries run HERE, on their own counter, rather than consuming an outer
        // MAX_SPEC_ATTEMPTS slot: an `overloaded_error` says nothing about spec quality, so
        // spending the feedback pass on one meant a transient 529 could quietly cost the student
        // ATS coverage on a resume that did eventually generate.
        spec = await (async () => {
          let lastErr: unknown;
          for (let tries = 1; tries <= MAX_OVERLOAD_ATTEMPTS; tries++) {
            const budget = budgetLeftMs();
            if (budget < MIN_CALL_BUDGET_MS) break;
            try {
              const generated = await generateResumeSpec(
                jdText,
                body.company,
                body.role,
                bank,
                education,
                attempt > 1 ? specIssues : undefined,
                declaredSkills,
                budget,
                // The approved base resume, when one exists. Tailoring starts from the page the
                // student accepted and swaps against this JD, rather than reselecting from the raw
                // bank on every application - which is also what makes their /start edits reach a
                // real submission instead of dying in base_resume_json.
                baseSpec,
                priorityEntry,
              );
              const policed = applyResumePolicy(generated, education, bank, jdText, { targetRole: body.role }).spec;
              /* Ordering is decided from supported text on both sides of this exact packet, after
               * the model output has been grounded to the bank and before any renderer sees it.
               * The model's proposed lead_alignment is deliberately replaced, not trusted. */
              /* `selected.fallback` is deliberately dropped here. Grounding and the bullet floor
                 below can still remove the evidence this pass ranked on, so the only fallback that
                 describes the document the student receives is the one from the final reselect. */
              const selected = selectJdAlignedLead(policed, jdText, { company: body.company, role: body.role });
              return selected.spec;
            } catch (err) {
              lastErr = err;
              if (!isTransientOverload(err)) throw err;
              const waitMs = overloadBackoffMs(err, tries);
              // Only sleep if a real attempt could still follow it; otherwise fall out now and let
              // the 503 go back while the client still has time to act on it.
              if (budgetLeftMs() - waitMs < MIN_CALL_BUDGET_MS) break;
              fastify.log.warn(
                { tries, waitMs, budgetLeftMs: budgetLeftMs(), status: (err as { status?: number })?.status },
                'model capacity overloaded, backing off and retrying in-request',
              );
              await sleep(waitMs);
            }
          }
          throw lastErr ?? new Error('resume spec generation exhausted its budget');
        })();
      } catch (err) {
        fastify.log.error(err);
        if (spec) break; // a prior spec still has to pass pruning and final validation below
        // Billing/auth first: it is PERMANENT, so neither the transient 503 (which invites a
        // retry) nor the generic 500 (which reads as a bad JD) is honest about it. Distinct code,
        // not-your-fault message, and a log that names the operator action (R-012).
        if (isBillingOrAuthFailure(err)) {
          fastify.log.error({ status: (err as { status?: number })?.status, userId }, LLM_BILLING_LOG);
          return reply.status(503).send(LLM_BILLING_PAYLOAD);
        }
        // A transient capacity failure is a "come back", not a failure to report. Say so in a way
        // the client can act on: a 500 here is indistinguishable from a bad JD, so the extension
        // could only surface a hard "Failed to generate resume spec" and strand the fill. This is
        // the half of the fix that survives an incident longer than the 60s function ceiling, since
        // only a fresh request can outlive it.
        if (isTransientOverload(err)) {
          return reply.status(503).send({
            error: `The model is busy right now. ${PRODUCT_NAME} will retry automatically.`,
            code: 'llm_overloaded',
            retry_after_ms: 5000,
          });
        }
        // A malformed/truncated model response is as retryable as a validation failure - but not if
        // we're out of budget.
        if (attempt === MAX_SPEC_ATTEMPTS) {
          return reply.status(500).send({ error: 'Failed to generate resume spec' });
        }
        continue;
      }

      const result = validateResumeSpec(spec, jdText, bank, declaredSkills, education, body.role);
      const typographyIssues = findResumeTypographyIssues(spec, applicationContact);
      const allValidationIssues = [...result.issues, ...typographyIssues];
      const providerStyleIssues = spec.generation_method === 'local_fallback'
        ? allValidationIssues.filter(isProviderDependentResumeStyleIssue)
        : [];
      specIssues = allValidationIssues.filter((issue) => !providerStyleIssues.includes(issue));
      /* requireFirst: false. The priority entry has to be ON the resume; which entry LEADS it is
         decided against this posting, by leadAlignmentIssues below. See baseResumeSelectionIssues
         for why the position half of that check belongs to the base resume and not here. */
      if (priorityEntry) {
        specIssues.push(...baseResumeSelectionIssues(spec, [priorityEntry], { requireFirst: false }));
      }
      /* Verify the citation the selector produced against the same frozen JD before rendering.
         When it produced none because none exists, this returns empty and the ordering it fell back
         to stands - the selector no longer reports that as an issue, so a retry is never spent
         asking the model to find evidence that is not in either document. */
      leadIssues = leadAlignmentIssues(spec, jdText, { context: { company: body.company, role: body.role } });
      specIssues.push(...leadIssues);
      specWarnings = [
        ...result.warnings,
        ...providerStyleIssues.map((issue) => ({ entry: 'Resume wording', bullet: '', flags: [issue] })),
      ];
      atsCoverage = result.ats_keyword_coverage_pct;

      // A grounded local spec means both providers were unavailable. Repeating the same calls with
      // validation feedback cannot improve an outage fallback and only restores the long spinner.
      if (!shouldRetryResumeSpec(spec, specIssues, attempt)) break;
      fastify.log.warn({ specIssues }, 'resume spec failed validation, retrying with feedback');
    }
    if (!spec) {
      return reply.status(500).send({ error: 'Failed to generate resume spec' });
    }

    // Grounding backstop: if the spec still cites anything not in the bank after the retry loop,
    // strip the offending content rather than render a fabricated claim. If that would remove
    // every entry, hold the resume for review instead of attaching either a blank or unverified file.
    let groundingRemoved: string[] = [];
    const pruned = pruneUngroundedContent(spec, bank, declaredSkills);
    if (pruned.removed.length > 0) {
      if (pruned.spec.experience.length === 0 && spec.experience.length > 0) {
        // Every entry failed to match the bank. This may be an organization-name mismatch, but the
        // system cannot safely distinguish that from fabrication at this point.
        fastify.log.error(
          { userId, company: body.company, removed: pruned.removed },
          'resume grounding could not verify any experience entry; holding attachment',
        );
        return reply.status(422).send(resumeQualityHoldResponseSchema.parse({
          error: 'Litos could not verify this resume against the uploaded experience, so it was not attached.',
          code: 'resume_quality_hold',
          quality: {
            ready_to_attach: false,
            issues: ['grounding: could not verify any experience entry against the bank'],
            warnings: specWarnings,
            omissions: pruned.removed,
          },
        }));
      } else {
        spec = pruned.spec;
        groundingRemoved = pruned.removed;
      }
    }
    /* WHAT FELL UNDER THE FLOOR, so the student is told rather than left to notice an absence.
     *
     * A job dropped for being short used to vanish with nothing said. The resume showed one entry
     * where they had handed over two, and the fix - one more bullet on that entry - was something
     * only the code knew. These ride the same `omissions` channel the renderer already uses for
     * what it trimmed to make the page fit. */
    const droppedForLength: string[] = [];
    spec = enforceExperienceBulletFloor(spec, bank, {
      priorityEntryId: priorityEntry?.id,
      allowSparsePriority: recentReview?.continue_with_found === true,
      allowSparseAll: spec.generation_method === 'local_fallback',
      onDropped: ({ org, bullets }) =>
        droppedForLength.push(
          `Left ${org} off: it has ${bullets === 1 ? 'one bullet' : `${bullets} bullets`} and we recommend at least ${RESUME_CONTENT_LIMITS.minBulletsPerEntry}. Add another and it goes on.`,
        ),
    });
    /* Grounding and the bullet-floor repair can remove or add evidence after the first selection.
     * Recompute from the exact pre-render document so a citation can never survive after its
     * supporting bullet changed. */
    const finalLeadSelection = selectJdAlignedLead(spec, jdText, { company: body.company, role: body.role });
    spec = finalLeadSelection.spec;
    leadFallback = finalLeadSelection.fallback;
    leadIssues = leadAlignmentIssues(spec, jdText, { context: { company: body.company, role: body.role } });
    /* SAID, NOT SPENT. An uncitable lead used to reach the 422 below and cost the student the whole
       build - in onboarding, their one free build - over the absence of a shared word. It is now a
       line on the review screen naming the entry that led and why, next to the omissions the
       renderer already reports. The 422 still stands for what it was written for: a citation that
       is present and wrong. */
    if (leadFallback) {
      fastify.log.info(
        { userId, company: body.company, lead: leadFallback.entry_org, overlap: leadFallback.jd_overlap_terms },
        'lead fit is unscoreable against this posting; ordered by relevance, recency and substance',
      );
      specWarnings = withLeadFallbackNote(specWarnings, leadFallback);
    }
    if (leadIssues.length > 0) {
      fastify.log.error(
        { userId, company: body.company, issues: leadIssues },
        'resume blocked before rendering because the lead citation does not hold against this posting',
      );
      return reply.status(422).send(resumeQualityHoldResponseSchema.parse({
        error: 'Litos could not prove which experience should lead this resume, so it was not attached.',
        code: 'resume_quality_hold',
        quality: {
          ready_to_attach: false,
          issues: leadIssues,
          warnings: specWarnings,
          omissions: groundingRemoved,
        },
      }));
    }
    const renderedEducationIssues = missingRenderedEducation(spec);
    if (renderedEducationIssues.length > 0) {
      fastify.log.error(
        { userId, company: body.company, issues: renderedEducationIssues },
        'resume blocked before rendering because the generated preview education is blank',
      );
      return reply.status(422).send(resumeQualityHoldResponseSchema.parse({
        error: 'This resume is missing education details, so Litos did not attach it.',
        code: 'resume_quality_hold',
        quality: {
          ready_to_attach: false,
          issues: renderedEducationIssues,
          warnings: specWarnings,
          omissions: groundingRemoved,
        },
      }));
    }

    let pdfBuffer: Buffer;
    let trimmedForFit: boolean;
    let sparse: boolean;
    let layoutOmissions: string[];
    let visualLayout: ResumeVisualLayout;
    let visualWarnings: string[];
    let visualIssues: string[];
    try {
      /* The bank goes in so a page with room to spare is filled with the student's own unused
         bullets instead of with spacing. See planResumeLayout's expand pass. */
      const rendered = await renderResumePdf(spec, applicationContact, jdText, bank);
      pdfBuffer = rendered.buffer;
      spec = rendered.spec;
      trimmedForFit = rendered.trimmed;
      sparse = rendered.sparse;
      /* The entries the floor removed lead the list, ahead of what the layout trimmed. They are the
         only omission the student can act on, and the sentence says how. */
      layoutOmissions = [...droppedForLength, ...rendered.omissions];
      visualLayout = rendered.layout;
      const visualValidation = validateResumeVisualLayout(visualLayout);
      visualWarnings = visualValidation.warnings;
      visualIssues = visualValidation.issues;
      if (spec.generation_method === 'local_fallback') {
        const providerStyleIssues = visualIssues.filter(isProviderDependentResumeStyleIssue);
        visualIssues = visualIssues.filter((issue) => !providerStyleIssues.includes(issue));
        visualWarnings.push(...providerStyleIssues.map((issue) => `Review source wording: ${issue}`));
      }
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to render resume PDF' });
    }

    // Authoritative post-render check (mirrors validate_resume.py's PDF section): confirms the
    // pre-render height estimate actually held, and that the text is really extractable.
    // extractPdfText, not bare pdfParse: the raw call threw "bad XRef entry" on every ~2.5KB
    // pooled render buffer (R-017; the byteOffset story lives in lib/pdfText.ts), so this check
    // had NEVER run and its empty issues array read downstream as a clean pass.
    const finalSpecValidation = validateResumeSpec(
      spec,
      jdText,
      bank,
      declaredSkills,
      education,
      body.role,
      {
        allowedSingleBulletEntries: allowedSparseEntriesForGeneration(
          spec.generation_method,
          bank,
          priorityEntry ? [priorityEntry] : [],
          recentReview?.continue_with_found === true,
        ),
      },
    );
    if (spec.generation_method === 'local_fallback') {
      const providerStyleIssues = finalSpecValidation.issues.filter(isProviderDependentResumeStyleIssue);
      finalSpecValidation.issues = finalSpecValidation.issues.filter(
        (issue) => !providerStyleIssues.includes(issue),
      );
      finalSpecValidation.warnings.push(
        ...providerStyleIssues.map((issue) => ({ entry: 'Resume wording', bullet: '', flags: [issue] })),
      );
    }
    if (priorityEntry) {
      finalSpecValidation.issues.push(...baseResumeSelectionIssues(spec, [priorityEntry], { requireFirst: false }));
    }
    /* The complete citation is re-checked after fitting. If the one-page pass removed the exact
     * supporting bullet, the packet is blocked rather than storing an explanation the PDF no
     * longer contains. */
    finalSpecValidation.issues.push(
      ...leadAlignmentIssues(spec, jdText, { context: { company: body.company, role: body.role } }),
    );
    /* REPLACES the array, so the fallback note has to be re-applied rather than assumed to
       survive. Measured live 2026-09-01 on an EQT Corporation midstream-engineering posting: the
       build returned 200 with the lead correctly ordered by rankLeadWithoutCitation, and the line
       telling the student which entry led and why was silently dropped here, three hundred lines
       after it was added. The 422 was fixed and the explanation was not, which is the half of the
       fix the student actually reads. */
    specWarnings = withLeadFallbackNote(finalSpecValidation.warnings, leadFallback);
    atsCoverage = finalSpecValidation.ats_keyword_coverage_pct;
    if (finalSpecValidation.issues.length > 0) {
      fastify.log.error(
        { userId, company: body.company, issues: finalSpecValidation.issues },
        'resume blocked after final content validation',
      );
      return reply.status(422).send(resumeQualityHoldResponseSchema.parse({
        error: 'This resume needs review before Litos can attach it.',
        code: 'resume_quality_hold',
        quality: {
          ready_to_attach: false,
          issues: finalSpecValidation.issues,
          warnings: specWarnings,
          omissions: layoutOmissions,
          visual_warnings: visualWarnings,
        },
      }));
    }

    /* THE VERDICT ON THE DOCUMENT THAT ACTUALLY EXISTS, recorded rather than merely implied.
     *
     * Computed on applicationContact, which is what was rendered and what gets stored as _contact,
     * so it also covers the alias substitution above rather than only the block resolved before it.
     * The refusal near the top of this handler and renderResumePdf's throw both already stand
     * between here and a contactless PDF, so this array is empty on every packet the fixed code
     * writes. That is the point: on Virtu packet 80aeba93 every quality array was empty too, and an
     * empty array meant "nothing was checked" rather than "the check passed". Storing the verdict
     * is what makes those two states distinguishable on the row itself. */
    const contactIssues = resumeContactIssues(applicationContact);

    let layoutIssues: string[] = [...contactIssues, ...visualIssues];
    try {
      const parsedPdf = await extractPdfText(pdfBuffer);
      layoutIssues.push(...validatePdfLayout(parsedPdf.text, parsedPdf.numpages).issues);
      layoutIssues.push(...findPdfSafeMarginIssues(parsedPdf.pages, visualLayout));
      layoutIssues.push(...findPdfTextFidelityIssues(parsedPdf.text, spec, applicationContact));
      if (parsedPdf.text.toLowerCase().includes(pinnedApplicantEmail.address.toLowerCase())) {
        layoutIssues.push('the tracked application routing email must not appear on the resume PDF');
      }
    } catch (err) {
      // Fail closed when validation cannot run. Returning or storing an unverified PDF would
      // turn a parser failure into a false quality pass and repeat R-017's failure mode.
      fastify.log.error(
        { err, userId, company: body.company },
        'POST-RENDER PDF VALIDATION DID NOT RUN: rendered resume could not be parsed, so its quality.issues are INCOMPLETE and the one-page/extractability guarantees are unverified (R-017)',
      );
      return reply.status(500).send(resumeQualityHoldResponseSchema.parse({
        error: 'Litos could not verify the generated PDF, so it was not attached.',
        code: 'resume_quality_hold',
      }));
    }

    if (layoutIssues.length > 0) {
      fastify.log.error({ userId, company: body.company, layoutIssues }, 'resume blocked after PDF validation');
      return reply.status(422).send(resumeQualityHoldResponseSchema.parse({
        error: 'This resume did not pass the visual PDF checks, so it was not attached.',
        code: 'resume_quality_hold',
        quality: {
          ready_to_attach: false,
          issues: layoutIssues,
          warnings: specWarnings,
          omissions: layoutOmissions,
          visual_warnings: visualWarnings,
        },
      }));
    }

    const resumeFileName = resumeFileNameForRole(applicationContact.full_name, body.role);
    const responseTemplate = resumeGenerateSuccessResponseSchema.parse({
      resume_id: resumeId,
      resume_url: 'validated-before-storage',
      file_name: resumeFileName,
      spec,
      /* Said out loud, not left in the stored packet. A student whose replies are going to her own
       * inbox has to know while she is looking at the packet, because it is the difference between
       * an application Litos can finish and one she has to finish herself. */
      ...(pinnedApplicantEmail ? {
        applicant_email: {
          address: pinnedApplicantEmail.address,
          source: pinnedApplicantEmail.source,
          reason: pinnedApplicantEmail.reason,
          tracked: pinnedApplicantEmail.tracked,
          notice: applicantEmailPlan.notice,
        },
      } : {}),
      quality: {
        ready_to_attach: true,
        issues: [],
        warnings: specWarnings,
        ats_keyword_coverage_pct: atsCoverage,
        trimmed_for_one_page_fit: trimmedForFit,
        sparse_add_more_experience: sparse,
        grounding_removed: groundingRemoved,
        omissions: layoutOmissions,
        visual_warnings: visualWarnings,
        layout: {
          fill_ratio_pct: Math.round(visualLayout.fill_ratio * 100),
          bottom_whitespace_pt: Math.round(visualLayout.bottom_whitespace),
          density_expansion_pct: Math.round(visualLayout.density_expansion * 100),
          body_font_size_pt: Number(visualLayout.body_font_size.toFixed(2)),
          section_order: visualLayout.section_order,
        },
      },
    });

    const jdHash = createHash('sha256').update(jdText).digest('hex').slice(0, 16);
    const requestedKey = `users/${userId}/resumes/${jdHash}-${Date.now()}.pdf`;

    const reservedCount = useLegacyMonthlyCounter
      ? await claimCounterSlot(userId, period, 'resumes', ent.monthlyResumes)
      : 0;
    if (useLegacyMonthlyCounter && reservedCount === null) {
      await releaseReservation();
      const currentCount = await getCount(userId, period, 'resumes');
      return reply.status(402).send(quotaExceededPayload(ent, currentCount, 'resumes'));
    }

    let resumeUrl: string;
    let objectKey: string;
    let renderedBlobUrl: string;
    try {
      // `access: 'public'` is not a choice - it is the only value @vercel/blob@0.27.3 accepts.
      // What we control is who ever learns the resulting URL, and the answer is nobody: the
      // blob URL is permanent and unauthenticated, so it stays server-side and the client gets
      // a capability link to /resume/download instead. See lib/resumeAccess.ts.
      const blob = await putObject(requestedKey, pdfBuffer, {
        contentType: 'application/pdf',
      });
      // Store the pathname the API actually assigned, NOT the one we asked for. `addRandomSuffix`
      // defaults to TRUE in this SDK (create-folder-*.d.ts documents `@defaultvalue true`, and the
      // header is only sent when the option is set explicitly), so the stored object is really at
      // `<requestedKey minus .pdf>-<random>.pdf`. Writing requestedKey here instead made every
      // later key -> URL lookup miss, which 404'd every download and silently shipped applications
      // with no resume attached. The suffix is left ON deliberately: an unguessable pathname is
      // defence in depth on an object we cannot make private.
      objectKey = blob.pathname;
      renderedBlobUrl = blob.url;
      // R-040: carry put()'s own URL inside the sealed token. The download route's key -> URL
      // lookup rides list(), which is eventually consistent with no bound - a fresh resume can
      // 404 as "deleted" for the whole window a student is submitting in. put()'s URL is a
      // strong read target and it is in hand right here.
      resumeUrl = `${apiBaseFor(request)}/resume/download?t=${mintDownloadToken(userId, objectKey, {
        ...(objectStorageUsesRailway() ? {} : { blobUrl: blob.url }),
        fileName: resumeFileName,
      })}`;
    } catch (err) {
      fastify.log.error(err);
      if (useLegacyMonthlyCounter) await releaseCounterSlot(userId, period, 'resumes');
      await releaseReservation();
      return reply.status(500).send({ error: 'Failed to store generated resume' });
    }

    // job_id is spread in only when the caller sent one, so rows generated from the extension or
    // a hand-typed link keep exactly the three-key shape they have always had rather than gaining
    // a `job_id: undefined` that serializes into the jsonb as an explicit null.
    const jobContext = {
      company: body.company,
      role: body.role,
      jd_hash: jdHash,
      ...(postingLocation ? { location: postingLocation } : {}),
      ...(postingPortalCountry ? { portal_country: postingPortalCountry } : {}),
      ...(effectiveJobId ? { job_id: effectiveJobId } : {}),
    };
    const now = new Date().toISOString();

    const parsedProfile = (profileRows[0]?.parsed_json && typeof profileRows[0].parsed_json === 'object'
      ? profileRows[0].parsed_json
      : {}) as Record<string, unknown>;
    const portalApplicationProfile = await loadApplicationProfileLike(userId);
    const parsedExperience = Array.isArray(parsedProfile.experience)
      ? parsedProfile.experience.flatMap((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
        const value = entry as Record<string, unknown>;
        const company = typeof value.company === 'string' ? value.company.trim() : '';
        const title = typeof value.title === 'string' ? value.title.trim() : '';
        if (!company || !title) return [];
        return [{
          company,
          title,
          start: typeof value.start === 'string' ? value.start.trim() : '',
          end: typeof value.end === 'string' ? value.end.trim() : '',
          description: typeof value.description === 'string' ? value.description.trim() : '',
        }];
      })
      : [];
    const gradYear = typeof parsedProfile.grad_year === 'number'
      ? parsedProfile.grad_year
      : Number(String(education.grad_date ?? '').match(/(?:19|20)\d{2}/)?.[0] ?? 0);
    let applicationReview: ApplicationReviewState = {
      jd_text: jdText,
      role: body.role,
      ...(body.application ? {
        portal_url: canonicalApplicationPortalUrl,
        ats_name: canonicalApplicationPortalSupported && canonicalApplicationPortalUrl ? detectPortal(canonicalApplicationPortalUrl) : body.application.ats_name,
        // Answered here, at creation, because it is answerable here: the portal is a pure function
        // of the URL we were just handed. Deciding it lazily inside the submission run is what let
        // the Tracker call an unsubmittable packet "Ready" and hand the applicant a send button
        // that could only ever fail, minutes later.
        portal_supported: canonicalApplicationPortalSupported,
      } : {}),
      status: body.application ? 'ready_to_submit' as const : 'resume_ready' as const,
      applicant_email: pinnedApplicantEmail,
      applicant_snapshot: {
        profile: {
          full_name: applicationContact.full_name,
          email: pinnedApplicantEmail.address,
          experience: parsedExperience,
          skills: declaredSkills,
          school: education.school,
          ...(education.degree ? { degree: education.degree } : {}),
          ...(education.grad_date ? { grad_date: education.grad_date } : {}),
          grad_year: gradYear,
          ...(typeof parsedProfile.currently_enrolled === 'boolean'
            ? { currently_enrolled: parsedProfile.currently_enrolled }
            : {}),
        },
        application_profile: portalApplicationProfile,
      },
      edited_terms: deriveEditedTerms(spec, bank),
      questions: [],
      skipped_reasons: [],
      updated_at: now,
    };
    if (effectiveJobId && body.application) {
      applicationReview = await repairReviewPortalFromMonitoredJob(
        { job_context: jobContext, spec: { _review: applicationReview } } as typeof generated_resumes.$inferSelect,
        applicationReview,
      );
    }
    const storedSpec = {
      ...spec,
      _contact: applicationContact,
      ...(pinnedApplicantEmail ? { _applicant_email: pinnedApplicantEmail } : {}),
      ...(applicationEmail ? { _application_email: applicationEmail } : {}),
      _review: applicationReview,
      _quality: {
        pdfGenerationBinding: createPdfGenerationBinding(spec, objectKey, pdfBuffer, applicationContact.email ?? ''),
        specIssues: [],
        /* Its own key rather than folded into specIssues, which means "the model wrote something
           the validator rejected". This is a fact about the ACCOUNT, not about the generated
           content, and a reader auditing packets needs to be able to tell those apart. */
        contactIssues,
        /* Whether the lead entry's justification was ACCEPTED, recorded per packet so criterion 3
           is auditable from the corpus instead of by re-running generation.
           A nonempty value now prevents the packet from reaching storage. Keeping the verdict on a
           clean packet still matters: it distinguishes "checked and passed" from old rows that
           predate the selector. Empty means the lead is justified against a requirement this
           posting actually states and is bound to the stored JD hash. */
        leadAlignmentIssues: leadIssues,
        layoutIssues,
        visualWarnings,
        atsCoverage,
        trimmedForFit,
        sparse,
        groundingRemoved,
        layoutOmissions,
        visualLayout: {
          fillRatio: visualLayout.fill_ratio,
          bottomWhitespace: visualLayout.bottom_whitespace,
          densityExpansion: visualLayout.density_expansion,
          bodyFontSize: visualLayout.body_font_size,
          sectionOrder: visualLayout.section_order,
          maximumBulletLines: Math.max(0, ...visualLayout.bullets.map((bullet) => bullet.lines)),
        },
      },
    };

    let persisted = false;
    let canonicalApplicationId: string | undefined;
    let canonicalArtifactId: string | undefined;
    try {
      await db.transaction(async (tx) => {
        await tx.insert(generated_resumes).values({
          id: resumeId,
          user_id: userId,
          job_context: jobContext,
          spec: storedSpec,
          resume_object_key: objectKey,
        });
        canonicalApplicationId = body.application_id ?? randomUUID();
        canonicalArtifactId = randomUUID();
        if (!body.application_id) {
          await tx.insert(applications).values({
            id: canonicalApplicationId,
            user_id: userId,
            legacy_generated_resume_id: resumeId,
            job_id: effectiveJobId,
            company_scope_key: canonicalCompanyScope({ companyName: body.company }),
            company_name: body.company,
            role: body.role,
            portal_url: canonicalApplicationPortalUrl,
            source_surface: 'dashboard',
            tracker_state: 'applying',
            review_state: 'ready',
            selected_resume_artifact_id: null,
            application_fingerprint: `legacy:${resumeId}`,
          });
        }
        await tx.insert(artifacts).values({
          id: canonicalArtifactId,
          user_id: userId,
          legacy_generated_resume_id: resumeId,
          kind: 'tailored_resume',
          structured_content: storedSpec,
          rendered_object_key: objectKey,
          rendered_blob_url: renderedBlobUrl,
          source: 'ai_tailored',
        });
        await tx.insert(artifact_versions).values({
          artifact_id: canonicalArtifactId,
          version_number: 1,
          generation_source: 'ai_tailored',
          job_context: jobContext,
          content_hash: immutableDocumentContentHash(storedSpec),
          structured_content: storedSpec,
          rendered_object_key: objectKey,
          rendered_blob_url: renderedBlobUrl,
        });
        await tx.insert(application_artifacts).values({
          application_id: canonicalApplicationId,
          artifact_id: canonicalArtifactId,
          purpose: 'resume',
          selected: true,
        });
        await linkGeneratedPacketToCanonicalApplication(tx, {
          userId,
          applicationId: canonicalApplicationId,
          generatedResumeId: resumeId,
          artifactId: canonicalArtifactId,
        });
      });
      persisted = true;
    } catch (err) {
      fastify.log.error(err);
      await releaseReservation();
      if (useLegacyMonthlyCounter) await releaseCounterSlot(userId, period, 'resumes');
      /* `|| applicationEmail` is not decoration. The alias row is a foreign key onto this row, so a
       * lost packet means the portal identity frozen beside the PDF can never exist and employer
       * mail would route nowhere. Returning a document detached from its application identity would
       * leave an unusable packet. */
      if (body.application || applicationEmail) {
        return reply.status(500).send({
          error: 'Litos could not save one email across this application. Nothing was prepared for submission. Try again.',
          code: 'application_identity_persistence_failed',
        });
      }
      // The file is already generated and returned below; failing to log it for audit
      // shouldn't block the student from getting their resume.
    }

    /* THE ALIAS ROW, AND A LOUD FAILURE IF IT DOES NOT LAND.
     *
     * It has to be written after the packet row: application_email_aliases.generated_resume_id is
     * a foreign key onto generated_resumes.id, so there is nothing to point at until the row above
     * exists.
     *
     * `applicationEmail` is non-null ONLY when the route was measured able to receive mail and a
     * forwarding address was found, so a failure here is the second kind of failure, the one worth
     * surfacing: the route is configured and the write went wrong. An unconfigured deployment and
     * a guest with no confirmed mailbox never reach this branch at all; they took the recorded
     * fallback in planPacketApplicantEmail and carry its reason.
     *
     * Refusing is not optional, because the packet is already frozen to the alias by this point.
     * The PDF keeps the personal resume address while the employer form uses the routing alias. A
     * missing route would leave that form address unreadable and hide that nothing can read replies.
     * The packet row survives the refusal and is inert:
     * resolveFrozenApplicantEmail refuses to submit a packet whose pinned alias has no active row,
     * so it becomes a regeneration hold rather than a personal address on a form. */
    if (persisted && applicationEmail) {
      try {
        const written = await ensureApplicationEmailAlias({
          userId,
          applicationId: resumeId,
          forwardTo: applicationEmail.forwards_to,
        });
        if (!written) throw new Error('ensureApplicationEmailAlias wrote no alias row');
      } catch (err) {
        fastify.log.error({ err, application_id: resumeId }, 'application email alias could not be written for a generated packet');
        return reply.status(500).send({
          error: 'Litos could not set up the email address employers reply to, so it did not finish this application. Nothing was prepared for submission. Try again.',
          code: 'application_identity_persistence_failed',
        });
      }
    }

    /* Warm the requirement breakdown for this posting while nobody is waiting on it.
     *
     * A packet is built ahead of time, minutes or hours before the student opens it, so the one
     * model call the breakdown needs is free HERE and was 24 seconds of spinner on the review
     * screen. Bounded and non-fatal by construction: a slow or unavailable model leaves the cache
     * cold and the student pays for the judgement on open, which is exactly today's behaviour.
     * It can never fail a generation, and it writes nothing the review screen would not have. */
    /* ONLY ON A BACKGROUND BUILD, and this became load-bearing the moment the JD above stopped
     * being 600 characters.
     *
     * warmRequirementCache returns instantly when a posting states no competency clause, and a
     * 600-char preview never states one, so this call was a silent no-op for as long as packets
     * carried the preview. Resolving the full posting turns it into a real Sonnet call, awaited on
     * the response path, which would have put up to WARM_TIMEOUT_MS in front of a student who
     * pressed Apply. The justification for awaiting it was always "nobody is waiting on this",
     * which is true of the prewarm loop and false of an interactive generate.
     *
     * Default is NOT to warm, so the expensive path is opt-in rather than something a caller has
     * to know to avoid. POST_GEN_RESERVE_MS budgets for the PDF render and the audit inserts, not
     * for a model call. */
    const warm = body.prewarm
      ? await warmRequirementCache(
      jdText,
      {
        degree: storedSpec.degree,
        school: storedSpec.school,
        gradDate: storedSpec.grad_date,
        resumeText: [
          storedSpec.school,
          storedSpec.degree,
          storedSpec.grad_date,
          storedSpec.coursework,
          ...storedSpec.experience.flatMap((e) => [e.org, e.title, e.date_range, ...(e.bullets ?? [])]),
          ...(storedSpec.skills ?? []),
        ]
          .filter(Boolean)
          .join(' '),
        bullets: storedSpec.experience.flatMap((entry) => entry.bullets ?? []),
      },
          { company: jobContext.company, role: jobContext.role, job_id: jobContext.job_id ?? null },
        )
      : { asked: 0, judged: 0, fromCache: 0, skipped: 'interactive generate, not warmed' };
    if (warm.skipped && body.prewarm) fastify.log.warn({ warm }, 'requirement cache not warmed');

    const successResponse = {
      ...responseTemplate,
      resume_url: resumeUrl,
      canonical_application_id: canonicalApplicationId,
      artifact_id: canonicalArtifactId,
      application: persisted ? {
        id: resumeId,
        job_context: jobContext,
        /* Through the stripper even though this particular spec cannot hold a pointer: it was built
         * a few lines above for an application id that has existed for milliseconds, so no document
         * has ever been attached to it and the call returns its argument by identity.
         *
         * It is here so that "a stored spec on the wire goes through specWithoutDocumentPointers"
         * is a rule with no exceptions to remember. The two leaks this replaced were both routes
         * where the pointer was not visible in the line that shipped it - a whole-row spread, and a
         * spec handed over under a key that says nothing about documents - and an exception list is
         * the mechanism by which the third one gets written. */
        spec: specWithoutDocumentPointers(storedSpec),
        download_url: resumeUrl,
        created_at: now,
      } : undefined,
    };
    /* Nothing to commit when the grant paid for this build: there was no reservation to draw down.
       The grant's own record is the stamp taken at the top of the handler, which by reaching here
       is correctly spent - this is the success path. */
    if (reservationId) {
      await commitEntitledUsage(
        reservationId,
        1,
        new Date(),
        { statusCode: 200, body: successResponse },
      );
    }
    entitlementUsageCommitted = true;
    return reply.status(200).send(successResponse);
    } finally {
      if (!entitlementUsageCommitted) {
        await releaseReservation();
      }
    }
  });

  // GET /resume/download?t=... - streams a generated resume via its capability token.
  //
  // Deliberately NOT behind requireAuth. The extension fetches resume_url from the content
  // script, which runs in the ATS page's origin and has no access to the auth token (that lives
  // in the background worker's chrome.storage) - it does a bare `fetch(resume_url)`. An
  // Authorization header is therefore impossible here, and the token in `t` is the credential
  // instead. It is opaque, single-purpose, scoped to one object key, and expires (see
  // DOWNLOAD_TOKEN_TTL_MS, which is the one place that number lives),
  // which is what makes handing it to a page origin acceptable when handing over a permanent
  // public blob URL was not.
  fastify.get('/resume/download', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = (request.query as { t?: string }).t;
    if (!token) return reply.status(400).send({ error: 'Missing download token' });

    // One 403 for every failure mode (tampered, truncated, expired, wrong key). Distinguishing
    // them would turn this into an oracle for probing keys.
    const payload = readDownloadToken(token);
    if (!payload) return reply.status(403).send({ error: 'Invalid or expired download link' });

    // R-040: tokens minted since the fix carry the blob URL itself (payload.b) - a strong
    // point-read with no list() consistency dependence. Tokens from before the fix (<= 5 min
    // old at any moment) fall back to the list()-based key lookup they were minted against.
    let pdf: Buffer | null = null;
    let storageConfirmedMissing = false;
    try {
      if (payload.b) {
        const upstream = await fetch(payload.b);
        if (upstream.status === 404 || upstream.status === 410) storageConfirmedMissing = true;
        else if (!upstream.ok) throw new Error(`blob fetch ${upstream.status}`);
        else pdf = Buffer.from(await upstream.arrayBuffer());
      } else {
        const stored = await readObject(payload.k);
        if (stored) pdf = stored;
        else storageConfirmedMissing = true;
      }
    } catch (err) {
      fastify.log.error(err);
      return reply.status(502).send({ error: 'Could not read resume from storage' });
    }
    if (!pdf && storageConfirmedMissing) {
      const recovery = await recoverOwnedGeneratedDocument({ userId: payload.u, objectKey: payload.k });
      if (recovery.status === 'not_found') {
        return reply.status(404).send({ error: 'This generated document is no longer available' });
      }
      if (recovery.status === 'unrecoverable') {
        return reply.status(409).send({
          error: 'The saved generated document could not be safely re-rendered.',
          code: 'document_rerender_unavailable',
        });
      }
      pdf = recovery.buffer;
    }
    if (!pdf) return reply.status(502).send({ error: 'Could not read resume from storage' });

    return reply
      .status(200)
      .header('Content-Type', 'application/pdf')
      // The whole point is that this URL is short-lived; a shared cache holding the PDF against
      // the token would quietly recreate the unauthenticated-copy problem.
      .header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `attachment; filename="${contentDispositionFileName(payload.n)}"`)
      .send(pdf);
  });

  // POST /autofill/event - client-reported fill outcome. auto_submitted is true only when the
  // student had opted in to auto-submit (AutofillSetupScreen toggle, off by default) and their
  // own cancelable countdown ran out without them cancelling it.
  fastify.post('/autofill/event', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;

    let body: z.infer<typeof autofillEventSchema>;
    try {
      body = autofillEventSchema.parse(request.body);
    } catch (err) {
      const detail = err instanceof z.ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) : undefined;
      return reply.status(400).send({ error: 'Invalid request body', detail });
    }

    try {
      await db.insert(autofill_events).values({ user_id: userId, ...body });
    } catch (err) {
      fastify.log.error(err);
      return reply.status(500).send({ error: 'Failed to log autofill event' });
    }

    return reply.status(204).send();
  });

  // GET /resume/history - past generated resumes for this student.
  //
  // Each row carries a fresh download link. Until now the history rows held only the object
  // key, so nothing could actually retrieve a past resume; the token makes the list usable and
  // is minted per-request so the links expire with the response rather than being stored.
  // Files older than the retention window are gone, and their link 404s by design.
  //
  // THE SPEC GOES OUT WHOLE, WHICH IS WHY IT GOES OUT THROUGH specWithoutDocumentPointers. This
  // route normally answers with fifty complete specs, plus one explicitly requested older packet
  // for a direct link, so it began serving _documents.transcript.object_key
  // the day attachments were added, without a line of this file ever mentioning documents and
  // without the contract test that fences routes/documents.ts being able to see it. A Blob object
  // is written `access: 'public'` because that is the only mode the SDK has, so that key plus the
  // store's stable base URL is permanent unauthenticated access to a student's transcript. It is
  // also fifty rows of bytes nobody reads: db/schema.ts:1122 records a board list query exhausting
  // Neon's monthly transfer ceiling, and this is the payload the plan named next to it.
  fastify.get('/resume/history', { preHandler: requireAuth }, async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = request.jwtPayload!.userId;
    /* A resume built for an application the student has taken off their Tracker goes with it.
       Removal is stamped on the canonical application, and generated_resumes is joined to it by
       applications.legacy_generated_resume_id, so the exclusion is expressed here rather than
       duplicated as a second flag that could disagree with the first. A resume with no canonical
       application (an extension build, anything predating the canonical row) has nothing to be
       removed by and is unaffected. */
    const removedResumeIds = await db
      .select({ id: applications.legacy_generated_resume_id })
      .from(applications)
      .where(and(
        eq(applications.user_id, userId),
        isNotNull(applications.removed_at),
        isNotNull(applications.legacy_generated_resume_id),
      ));
    const removedIds = removedResumeIds
      .map((row) => row.id)
      .filter((id): id is string => Boolean(id));
    const latestRows = await db
      .select()
      .from(generated_resumes)
      .where(removedIds.length === 0
        ? eq(generated_resumes.user_id, userId)
        : and(eq(generated_resumes.user_id, userId), notInArray(generated_resumes.id, removedIds)))
      .orderBy(desc(generated_resumes.created_at))
      .limit(50);
    const query = request.query && typeof request.query === 'object'
      ? request.query as Record<string, unknown>
      : {};
    const requestedId = requestedResumeLookupId(latestRows, query.application);
    const requestedRows = requestedId
      ? await db
        .select()
        .from(generated_resumes)
        .where(and(
          eq(generated_resumes.id, requestedId),
          eq(generated_resumes.user_id, userId),
        ))
        .limit(1)
      : [];
    const rows = includeRequestedResumeInHistory(latestRows, requestedRows[0] ?? null, userId);
    const jobIds = [...new Set(rows.map(generatedResumeJobId).filter((id): id is string => Boolean(id)))];
    const monitoredRows = jobIds.length === 0 ? [] : await db
      .select({
        id: monitored_jobs.id,
        external_id: monitored_jobs.external_id,
        apply_url: monitored_jobs.apply_url,
        posting_url: monitored_jobs.posting_url,
        ats_name: career_page_sources.ats_name,
        board_token: career_page_sources.board_token,
        company_name: monitored_jobs.company_name,
        title: monitored_jobs.title,
        description: sql<string>`left(${monitored_jobs.description}, 60000)`,
      })
      .from(monitored_jobs)
      .innerJoin(career_page_sources, eq(monitored_jobs.source_id, career_page_sources.id))
      .where(and(
        inArray(monitored_jobs.id, jobIds),
        eq(career_page_sources.enabled, true),
      ));
    const monitoredJobs = new Map(
      monitoredRows
        .map((job) => ({
          ...job,
          apply_url: canonicalMonitoredPortalUrl(
            job.apply_url,
            job.ats_name,
            job.board_token,
            job.external_id,
            job.posting_url,
          ),
        }))
        .filter((job): job is typeof job & { apply_url: string } => Boolean(job.apply_url))
        .map((job) => [job.id, {
          applyUrl: job.apply_url,
          company: job.company_name,
          role: job.title,
          description: job.description,
          jdHash: monitoredDescriptionHash(job.description),
        }] as const),
    );
    const [profile, base] = await Promise.all([
      loadApplicationProfileLike(userId),
      Promise.resolve(apiBaseFor(request)),
    ]);
    /* The public submission-authority envelope the dashboard's employer-action gate reads off each
     * packet. That gate derives the packet's authority from `packet.submission_authority` alone, and
     * treats an ABSENT or unparsable envelope as quarantined: it will not authorize a send. The
     * client contract for that envelope is exact and shipped in the release, but no route ever
     * emitted it, so every packet arrived with no envelope and every application refused with "the
     * exact prior submission evidence needs review" - including packets that have never been
     * submitted at all.
     *
     * This computes the same authoritative projection the submission path itself uses, in one
     * batched read over this page's packets, and attaches the envelope ONLY for a packet whose
     * immutable history is genuinely empty: projection `none` with retry safety `no_evidence`, which
     * hold together exactly when there is not one attempt-opened event for the packet. That is the
     * only state that may become sendable, and its wire projection is the irreducible `{ state:
     * "none" }` with no id fields to (mis)serialise. `canonicalApplicationFromPacket` returns null
     * for a `/resume/history` packet (it carries no embedded canonical row), so the gate's identity
     * for the packet is the packet id itself, which is what `application_id` and `packet_id` name
     * here.
     *
     * Every packet with ANY attempt history classifies non-none (a sent one is `repair_required` with
     * `blocked_unverified` retry safety) and is deliberately left WITHOUT an envelope, so it stays
     * exactly as fail-closed at the gate as it is today. This can only free a genuinely un-attempted
     * packet; it can never turn a sent one sendable. On a projection read error the whole page also
     * degrades to no envelopes, i.e. today's blocked behaviour, never to an authorised send. */
    const submissionAuthority = await (async () => {
      try {
        return await authoritativeSubmissionProjection({ userId, packetIds: rows.map((row) => row.id) });
      } catch (error) {
        request.log.warn(
          { err: error },
          'submission authority projection unavailable for resume history; packets stay fail-closed at the send gate',
        );
        return null;
      }
    })();
    const revision = submissionAuthority?.revision;
    const resumes = rows.map((row) => {
      const coverLetter = ((row.spec as Record<string, unknown>)._cover_letter ?? {}) as Record<string, unknown>;
      const contact = ((row.spec as Record<string, unknown>)._contact ?? {}) as Record<string, unknown>;
      const job = (row.job_context ?? {}) as { role?: unknown };
      const resumeFileName = resumeFileNameForRole(contact.full_name, job.role);
      const submissionAuthorityEnvelope = submissionAuthorityEnvelopeForUnattemptedPacket({
        packetId: row.id,
        projectionState: submissionAuthority?.byPacketId.get(row.id)?.state,
        retrySafetyKind: submissionAuthority?.retrySafetyByPacketId.get(row.id)?.kind,
        revision,
      });
      return {
        ...row,
        spec: specWithoutDocumentPointers(
          refreshedHistorySpec(repairedHistorySpec(row, monitoredJobs), profile, row.job_context),
        ),
        ...(submissionAuthorityEnvelope ? { submission_authority: submissionAuthorityEnvelope } : {}),
        download_url: `${base}/resume/download?t=${mintDownloadToken(userId, row.resume_object_key, { fileName: resumeFileName })}`,
        cover_letter_download_url: typeof coverLetter.object_key === 'string'
          ? `${base}/resume/download?t=${mintDownloadToken(userId, coverLetter.object_key)}`
          : undefined,
      };
    });
    return reply.status(200).send({ resumes });
  });
}
