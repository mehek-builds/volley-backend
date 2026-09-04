import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../db';
import {
  application_artifacts,
  application_submission_attempt_events,
  applications,
  generated_resumes,
} from '../db/schema';
import { readApplicationReview } from './applicationReview';
import {
  authoritativeConfirmedProjectionMatches,
  authoritativeSubmissionProjection,
  measuredPersistedReceiptMatchesOpening,
} from './authoritativeSubmissionProjection';
import { canonicalApplicationForAttemptProjection } from './canonicalPacketBinding';
import {
  appendSubmissionAttemptEvent,
  lockSubmissionAttemptUser,
  submissionAttemptBindingFromEvent,
  submissionAttemptEventId,
  submissionAttemptRetrySafety,
  type SubmissionAttemptBinding,
  type SubmissionAttemptEventRecord,
} from './submissionAttemptLedger';

export const SUBMISSION_CONFIRMATION_REPAIR_REFUSALS = [
  'application_not_found',
  'canonical_projection_incomplete',
  'packet_binding_missing',
  'packet_review_missing',
  'receipt_incomplete',
  'receipt_not_verified',
  'attempt_binding_missing',
  'attempt_binding_ambiguous',
  'attempt_sequence_incomplete',
  'immutable_confirmation_exists',
  'immutable_confirmation_ambiguous',
] as const;

export type SubmissionConfirmationRepairRefusal =
  typeof SUBMISSION_CONFIRMATION_REPAIR_REFUSALS[number];

export type SubmissionConfirmationRepairResult =
  | {
    status: 'eligible' | 'applied' | 'already_applied';
    dryRun: boolean;
    userId: string;
    applicationId: string;
    packetId: string;
    attemptId: string;
    confirmationEventId: string;
  }
  | {
    status: 'refused';
    dryRun: boolean;
    userId: string;
    applicationId: string;
    code: SubmissionConfirmationRepairRefusal;
    detail: string;
  };

type EligibleRepair = Extract<SubmissionConfirmationRepairResult,
  { status: 'eligible' | 'applied' | 'already_applied' }>;

class RepairRollback extends Error {
  constructor(readonly result: SubmissionConfirmationRepairResult) {
    super('Roll back submission confirmation repair');
    this.name = 'RepairRollback';
  }
}

function refused(
  input: { userId: string; applicationId: string; dryRun: boolean },
  code: SubmissionConfirmationRepairRefusal,
  detail: string,
): SubmissionConfirmationRepairResult {
  return { status: 'refused', ...input, code, detail };
}

function canonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function safeHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

function receiptScreenshotMatchesAttempt(
  value: unknown,
  userId: string,
  submissionRunId: string | undefined,
): value is string {
  if (!safeHttpsUrl(value) || !submissionRunId) return false;
  try {
    const segments = decodeURIComponent(new URL(value).pathname).split('/').filter(Boolean);
    const usersAt = segments.findIndex((segment) => segment === 'users');
    if (usersAt < 0) return false;
    return segments[usersAt + 1] === userId
      && segments[usersAt + 2] === 'submission-runs'
      && segments[usersAt + 3] === submissionRunId
      && /^receipt(?:-[A-Za-z0-9_-]+)?\.png$/u.test(segments[usersAt + 4] ?? '')
      && usersAt + 5 === segments.length;
  } catch {
    return false;
  }
}

function confirmationEvidenceCode(
  binding: SubmissionAttemptBinding,
  events: readonly SubmissionAttemptEventRecord[],
  review: NonNullable<ReturnType<typeof readApplicationReview>>,
): string | null {
  if (binding.source === 'legacy_backfill') {
    // Only the generated initial-submission capability can carry a managed receipt; the projection
    // admits a legacy confirmation solely under a legacy_* receipt code with no press events.
    return binding.operation === 'initial_submission'
      && review.receipt?.source === 'managed_browser'
      ? 'legacy_managed_receipt'
      : null;
  }
  if (binding.source === 'direct_browser') return 'managed_application_receipt';
  if (binding.source !== 'managed_browser') return null;
  const verificationPress = events.some((event) => event.event_kind === 'press_observed'
    && (event.evidence_code === 'stratus_verification_press_echoed'
      || event.evidence_code === 'stratus_verification_press_progress'));
  if (binding.operation === 'security_code_continuation' || verificationPress) {
    const acceptedAtReceipt = review.security_code?.attempts?.some((attempt) =>
      attempt.outcome === 'accepted' && attempt.at === review.receipt?.captured_at) === true;
    return acceptedAtReceipt ? 'managed_security_code_receipt' : null;
  }
  return binding.operation === 'initial_submission' ? 'managed_application_receipt' : null;
}

function plannedConfirmationRecord(
  opening: SubmissionAttemptEventRecord,
  eventId: string,
  evidenceCode: string,
  observedAt: Date,
): SubmissionAttemptEventRecord {
  return {
    ...opening,
    id: eventId,
    event_id: eventId,
    event_kind: 'submission_confirmed',
    evidence_code: evidenceCode,
    proof_kind: null,
    boundary_activation_id: null,
    boundary_expires_at: null,
    observed_at: observedAt,
    created_at: observedAt,
  };
}

/**
 * Repair one missing immutable confirmation from an already complete canonical receipt tuple.
 * Dry-run is the default. Every apply is simulated through the authoritative projection first,
 * and the transaction is rolled back unless the new fact makes this exact application confirmed.
 */
export async function repairMissingSubmissionConfirmation(input: {
  userId: string;
  applicationId: string;
  legacyAttemptId?: string;
  dryRun?: boolean;
}): Promise<SubmissionConfirmationRepairResult> {
  const dryRun = input.dryRun !== false;
  // Postgres uuid columns read back lowercase; normalize so a pasted uppercase id still binds.
  const legacyAttemptId = input.legacyAttemptId?.toLowerCase();
  const scope = { userId: input.userId, applicationId: input.applicationId, dryRun };
  try {
    return await db.transaction(async (tx) => {
      await lockSubmissionAttemptUser(tx, input.userId);
      const canonicalRows = await tx.select().from(applications).where(and(
        eq(applications.id, input.applicationId),
        eq(applications.user_id, input.userId),
      )).limit(2);
      if (canonicalRows.length !== 1) {
        return refused(scope, 'application_not_found', 'No exact owned canonical application exists.');
      }
      const canonical = canonicalRows[0]!;
      if (canonical.submission_state !== 'submitted'
        || !['applied', 'interview', 'offer', 'closed'].includes(canonical.tracker_state)) {
        return refused(scope, 'canonical_projection_incomplete',
          'The canonical application does not already carry a terminal submitted projection.');
      }
      if (!canonical.legacy_generated_resume_id) {
        return refused(scope, 'packet_binding_missing',
          'The canonical application has no exact generated packet binding.');
      }
      const packets = await tx.select().from(generated_resumes).where(and(
        eq(generated_resumes.id, canonical.legacy_generated_resume_id),
        eq(generated_resumes.user_id, input.userId),
      )).limit(2);
      if (packets.length !== 1) {
        return refused(scope, 'packet_binding_missing',
          'The canonical packet binding is missing or ambiguous.');
      }
      const packet = packets[0]!;
      const review = readApplicationReview(packet.spec);
      if (!review) {
        return refused(scope, 'packet_review_missing', 'The exact packet has no application review.');
      }
      const receipt = review.receipt;
      if (!receipt
        || !receipt.confirmation_text.trim()
        || !safeHttpsUrl(receipt.final_url)
        || !receiptScreenshotMatchesAttempt(
          receipt.screenshot_url,
          input.userId,
          review.submission_run_id,
        )
        || !canonicalIso(receipt.captured_at)
        || review.status !== 'submitted'
        || review.submitted_at !== receipt.captured_at
        || receipt.source !== 'managed_browser') {
        return refused(scope, 'receipt_incomplete',
          'The packet does not contain one exact managed receipt URL, text, timestamp, and screenshot tuple.');
      }
      const relatedEvents = await tx.select().from(application_submission_attempt_events).where(and(
        eq(application_submission_attempt_events.user_id, input.userId),
        or(
          eq(application_submission_attempt_events.application_id, input.applicationId),
          eq(application_submission_attempt_events.packet_id, packet.id),
        ),
      ));
      const confirmations = relatedEvents.filter((event) => event.event_kind === 'submission_confirmed');
      if (confirmations.length > 0) {
        if (confirmations.length !== 1) {
          return refused(scope, 'immutable_confirmation_ambiguous',
            'More than one immutable confirmation already targets this application or packet.');
        }
        const existing = confirmations[0]!;
        const projection = await authoritativeSubmissionProjection({
          userId: input.userId,
          packetIds: [packet.id],
          applicationIds: [input.applicationId],
          executor: tx,
        });
        const exact = {
          attemptId: existing.attempt_id,
          canonicalApplicationId: input.applicationId,
          packetId: packet.id,
        };
        if (authoritativeConfirmedProjectionMatches(projection.byPacketId.get(packet.id), exact)
          && authoritativeConfirmedProjectionMatches(
            projection.byApplicationId.get(input.applicationId),
            exact,
          )) {
          return {
            status: 'already_applied',
            ...scope,
            packetId: packet.id,
            attemptId: existing.attempt_id,
            confirmationEventId: existing.event_id,
          };
        }
        return refused(scope, 'immutable_confirmation_exists',
          'An immutable confirmation exists but does not prove this exact canonical receipt tuple.');
      }
      // Backfilled attempts carry deterministic ids that can never equal a pre-ledger receipt
      // claim, so the operator names the exact legacy opening instead of matching on the claim.
      const openings = relatedEvents.filter((event) => event.event_kind === 'attempt_opened'
        && event.application_id === input.applicationId
        && event.packet_id === packet.id
        && (legacyAttemptId
          ? event.attempt_id === legacyAttemptId && event.source === 'legacy_backfill'
          : event.attempt_id === review.submission_claim_id));
      if (openings.length === 0) {
        return refused(scope, 'attempt_binding_missing', legacyAttemptId
          ? 'No immutable legacy_backfill attempt opening carries the named attempt for this exact application and packet.'
          : 'No immutable attempt opening matches the canonical application, packet, and receipt claim.');
      }
      if (openings.length !== 1) {
        return refused(scope, 'attempt_binding_ambiguous',
          'More than one immutable attempt opening matches the canonical receipt claim.');
      }
      const opening = openings[0]!;
      const attemptEvents = relatedEvents.filter((event) => event.attempt_id === opening.attempt_id);
      if (legacyAttemptId) {
        // A conservative backfilled opening is confirmable only while it is untouched: any later
        // fact means the attempt already progressed and must be resolved through its own route.
        if (attemptEvents.length !== 1) {
          return refused(scope, 'attempt_sequence_incomplete',
            'The named legacy attempt must hold exactly its untouched conservative opening.');
        }
      } else {
        const retrySafety = submissionAttemptRetrySafety(attemptEvents);
        if (retrySafety.kind !== 'blocked_unverified' || retrySafety.reason !== 'pressed') {
          return refused(scope, 'attempt_sequence_incomplete',
            'The immutable attempt does not contain one exact authorized press awaiting confirmation.');
        }
      }
      const binding = submissionAttemptBindingFromEvent(opening);
      const boundApplication = await canonicalApplicationForAttemptProjection(tx, binding);
      if (boundApplication.id !== input.applicationId) {
        return refused(scope, 'attempt_binding_ambiguous',
          'The immutable attempt resolves to a different canonical application.');
      }
      const evidenceCode = confirmationEvidenceCode(binding, attemptEvents, review);
      if (!evidenceCode) {
        return refused(scope, 'receipt_not_verified',
          'The stored receipt cannot be matched to an allowlisted provider confirmation shape.');
      }
      const confirmationEventId = submissionAttemptEventId(
        binding.attemptId,
        'submission_confirmed',
        'operator-receipt-repair',
      );
      const observedAt = new Date(receipt.captured_at);
      const planned = plannedConfirmationRecord(opening, confirmationEventId, evidenceCode, observedAt);
      if (!measuredPersistedReceiptMatchesOpening(
        opening,
        planned,
        receipt.final_url,
        receipt.confirmation_text,
      )) {
        return refused(scope, 'receipt_not_verified',
          'The stored receipt URL and text do not match the posting frozen on the immutable attempt.');
      }

      if (legacyAttemptId) {
        /* Pre-ledger rows never got the mutable document-tuple writes the modern flow performs, so
         * the authoritative projection would stay repair_required even with the confirmation fact
         * in place. Complete ONLY absent values, inside this same transaction: an already-written
         * value is never overwritten, and any inconsistency between existing values still fails the
         * projection assertion below and rolls everything back.
         *
         * RETAINED AS A GUARD, NO LONGER A LIVE PATH. As of 2026-09-04 the database refuses the
         * shape this condition tests for: applications_resume_attachment_state_check requires
         * selected_resume_artifact_id to be present exactly when resume_source is 'artifact', so a
         * row carrying a pointer beside (false, 'none') can no longer be stored. Every row that was
         * already in it, six of the ten boards Mehek was applying to on 2026-09-03, was completed by
         * scripts/apply-resume-linkage-invariant-migration.mjs, INCLUDING the application_artifacts
         * link stamp this block also writes, so nothing this used to complete is left incomplete.
         * It is kept rather than deleted because it costs one predicate on a path that runs by hand,
         * and it is what would still complete such a row if that constraint were ever dropped in an
         * incident. It is not expected to fire again. */
        if (canonical.selected_resume_artifact_id
          && !canonical.resume_attached
          && canonical.resume_source === 'none'
          && !canonical.resume_attached_at) {
          await tx.update(application_artifacts).set({ attached_at: observedAt }).where(and(
            eq(application_artifacts.application_id, input.applicationId),
            eq(application_artifacts.artifact_id, canonical.selected_resume_artifact_id),
            eq(application_artifacts.purpose, 'resume'),
            isNull(application_artifacts.attached_at),
          ));
          await tx.update(applications).set({
            resume_attached: true,
            resume_source: 'artifact',
            resume_attached_at: observedAt,
          }).where(and(
            eq(applications.id, input.applicationId),
            eq(applications.user_id, input.userId),
          ));
        }
        if (!packet.pipeline_stage) {
          await tx.update(generated_resumes).set({
            pipeline_stage: 'applied',
            pipeline_stage_at: observedAt,
          }).where(and(
            eq(generated_resumes.id, packet.id),
            eq(generated_resumes.user_id, input.userId),
            isNull(generated_resumes.pipeline_stage),
          ));
        }
      }

      const candidate: EligibleRepair = {
        status: dryRun ? 'eligible' : 'applied',
        ...scope,
        packetId: packet.id,
        attemptId: binding.attemptId,
        confirmationEventId,
      };
      await appendSubmissionAttemptEvent({
        ...binding,
        eventId: confirmationEventId,
        eventKind: 'submission_confirmed',
        evidenceCode,
        observedAt,
        createdAt: observedAt,
      }, { executor: tx });
      const projection = await authoritativeSubmissionProjection({
        userId: input.userId,
        packetIds: [packet.id],
        applicationIds: [input.applicationId],
        executor: tx,
      });
      const exact = {
        attemptId: binding.attemptId,
        canonicalApplicationId: input.applicationId,
        packetId: packet.id,
      };
      const packetProjection = projection.byPacketId.get(packet.id);
      const applicationProjection = projection.byApplicationId.get(input.applicationId);
      if (!authoritativeConfirmedProjectionMatches(packetProjection, exact)
        || !authoritativeConfirmedProjectionMatches(applicationProjection, exact)) {
        const projectionDetail = [packetProjection, applicationProjection]
          .map((value) => value?.state === 'repair_required'
            ? `repair_required:${value.reasons.join(',')}`
            : value?.state ?? 'missing')
          .join(' / ');
        throw new RepairRollback(refused(scope, 'receipt_not_verified',
          `The planned fact did not produce one authoritative exact-application confirmation: ${projectionDetail}.`));
      }
      if (dryRun) throw new RepairRollback(candidate);
      return candidate;
    });
  } catch (error) {
    if (error instanceof RepairRollback) return error.result;
    throw error;
  }
}
