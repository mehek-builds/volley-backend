import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db';
import { application_submission_attempt_events } from '../db/schema';
import { requireAuth } from '../middleware/auth';
import { canonicalPublicPostingUrl } from '../lib/atsSubmissionChannels';
import {
  appendSubmissionAttemptEvent,
  confirmedOrphanAttributionForParent,
  confirmedWeakPostingIdentityOpening,
  freezePostingIdentity,
  frozenPostingIdentityHasExactScope,
  frozenPostingIdentityFromEvent,
  lockSubmissionAttemptUser,
  ORPHAN_ATTRIBUTION_CONFIRMATION_EVIDENCE,
  ORPHAN_ATTRIBUTION_OPENING_EVIDENCE,
  SubmissionAttemptBindingConflictError,
  SubmissionAttemptEventConflictError,
  submissionAttemptBindingFromEvent,
  submissionAttemptEventId,
  submissionAttemptEventsForUser,
  submissionAttemptRetrySafety,
  type FrozenPostingIdentity,
  type SubmissionAttemptEventRecord,
  type SubmissionAttemptRetrySafety,
} from '../lib/submissionAttemptLedger';
import { exactAttemptPermanentlyBlocksNegativeResolution } from './applications';

const paramsSchema = z.object({ attemptId: z.string().uuid() });
const resolutionSchema = z.object({
  found: z.boolean(),
  checked_all_possible_destinations: z.literal(true).optional(),
  checked_exact_destination: z.literal(true).optional(),
  posting: z.object({
    company: z.string().trim().min(1).max(300),
    role: z.string().trim().min(1).max(300),
    portal_url: z.string().url().max(2_048).refine((value) => {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:')
        && !url.username
        && !url.password;
    }, 'Employer portal URL must use HTTP or HTTPS and cannot contain credentials'),
  }).strict().optional(),
}).strict();

const AUTOFILL_ORPHAN_OPENING_CODES = new Map([
  ['chrome_extension', 'autofill_auto_submit_report'],
  ['legacy_backfill', 'legacy_autofill_auto_submit_report'],
]);

export type SubmissionOrphanRisk = {
  attempt_id: string;
  packet_id: string;
  company: string;
  role: string;
  observed_at: string;
  reason: Extract<SubmissionAttemptRetrySafety, { kind: 'blocked_unverified' }>['reason']
    | 'confirmed_unattributed'
    | 'attributed_confirmed'
    | 'blanket_not_sent';
  scope: 'posting' | 'user';
  blocks_sends: boolean;
  resolution_available: boolean;
};

function exactOrphanAutofillOpening(
  events: readonly SubmissionAttemptEventRecord[],
): SubmissionAttemptEventRecord | null {
  const opening = events.find((event) => event.event_kind === 'attempt_opened');
  if (!opening
    || opening.application_id !== null
    || opening.operation !== 'initial_submission'
    || AUTOFILL_ORPHAN_OPENING_CODES.get(opening.source) !== opening.evidence_code) return null;
  return opening;
}

/** Unverified legacy extension reports use the original orphan workflow. A confirmed root from
 * any channel may also enter this repair path when its immutable facts lack an exact posting key.
 * Confirmation can never be cleared; the only available action is to attribute that fact to the
 * exact posting the applicant found.
 */
function repairableSubmissionRiskOpening(
  events: readonly SubmissionAttemptEventRecord[],
): SubmissionAttemptEventRecord | null {
  return exactOrphanAutofillOpening(events) ?? confirmedWeakPostingIdentityOpening(events);
}

function groupByAttempt(events: readonly SubmissionAttemptEventRecord[]) {
  const grouped = new Map<string, SubmissionAttemptEventRecord[]>();
  for (const event of events) {
    const exact = grouped.get(event.attempt_id) ?? [];
    exact.push(event);
    grouped.set(event.attempt_id, exact);
  }
  return grouped;
}

export function submissionOrphanRisksFromEvents(
  events: readonly SubmissionAttemptEventRecord[],
): SubmissionOrphanRisk[] {
  const risks: SubmissionOrphanRisk[] = [];
  for (const exactEvents of groupByAttempt(events).values()) {
    const opening = repairableSubmissionRiskOpening(exactEvents);
    if (!opening) continue;
    const retrySafety = submissionAttemptRetrySafety(exactEvents);
    const frozenIdentity = frozenPostingIdentityFromEvent(opening);
    const scope = frozenPostingIdentityHasExactScope(frozenIdentity)
      ? 'posting' as const
      : 'user' as const;
    const attribution = scope === 'user'
      ? confirmedOrphanAttributionForParent(events, opening.attempt_id)
      : null;
    if (retrySafety.kind === 'blocked_confirmed' && scope === 'posting') {
      risks.push({
        attempt_id: opening.attempt_id,
        packet_id: opening.packet_id,
        company: frozenIdentity.company,
        role: frozenIdentity.role,
        observed_at: retrySafety.confirmedAt,
        reason: 'attributed_confirmed',
        scope,
        blocks_sends: true,
        resolution_available: false,
      });
      continue;
    }
    if (retrySafety.kind === 'blocked_confirmed' && attribution) {
      risks.push({
        attempt_id: opening.attempt_id,
        packet_id: opening.packet_id,
        company: attribution.postingIdentity.company,
        role: attribution.postingIdentity.role,
        observed_at: attribution.retrySafety.confirmedAt,
        reason: 'attributed_confirmed',
        scope: 'posting',
        blocks_sends: true,
        resolution_available: false,
      });
      continue;
    }
    if (retrySafety.kind === 'safe_not_sent'
      && scope === 'user'
      && retrySafety.proofKind === 'applicant_checked_all_possible_destinations_not_sent') {
      risks.push({
        attempt_id: opening.attempt_id,
        packet_id: opening.packet_id,
        company: opening.company_name,
        role: opening.role,
        observed_at: retrySafety.resolvedAt,
        reason: 'blanket_not_sent',
        scope,
        blocks_sends: false,
        resolution_available: true,
      });
      continue;
    }
    const hasAttributionChild = events.some(
      (event) => event.parent_attempt_id === opening.attempt_id,
    );
    const confirmedNeedsAttribution = retrySafety.kind === 'blocked_confirmed'
      && scope === 'user'
      && !attribution;
    if (retrySafety.kind !== 'blocked_unverified' && !confirmedNeedsAttribution) continue;
    risks.push({
      attempt_id: opening.attempt_id,
      packet_id: opening.packet_id,
      company: opening.company_name,
      role: opening.role,
      observed_at: retrySafety.kind === 'blocked_unverified' ? retrySafety.at : retrySafety.confirmedAt,
      reason: retrySafety.kind === 'blocked_unverified' ? retrySafety.reason : 'confirmed_unattributed',
      scope,
      blocks_sends: true,
      resolution_available: retrySafety.kind === 'blocked_confirmed'
        ? !hasAttributionChild
        : retrySafety.reason === 'opened' || retrySafety.reason === 'pressed',
    });
  }
  return risks.sort((left, right) => left.observed_at.localeCompare(right.observed_at));
}

async function exactAttemptEvents(
  executor: Pick<typeof db, 'select'>,
  userId: string,
  attemptId: string,
): Promise<SubmissionAttemptEventRecord[]> {
  return executor.select().from(application_submission_attempt_events).where(and(
    eq(application_submission_attempt_events.user_id, userId),
    eq(application_submission_attempt_events.attempt_id, attemptId),
  )).orderBy(
    asc(application_submission_attempt_events.created_at),
    asc(application_submission_attempt_events.id),
  );
}

type ResolutionResult =
  | { kind: 'not_found' }
  | { kind: 'not_resolvable'; retrySafety: SubmissionAttemptRetrySafety }
  | { kind: 'global_check_required'; retrySafety: SubmissionAttemptRetrySafety }
  | { kind: 'exact_check_required'; retrySafety: SubmissionAttemptRetrySafety }
  | { kind: 'attribution_required'; retrySafety: SubmissionAttemptRetrySafety }
  | { kind: 'conflict'; retrySafety: SubmissionAttemptRetrySafety }
  | {
    kind: 'resolved';
    alreadyResolved: boolean;
    retrySafety: SubmissionAttemptRetrySafety;
    attributedAttemptId?: string;
  };

type OrphanResolutionPosting = NonNullable<z.infer<typeof resolutionSchema>['posting']>;

function identitylessOpening(opening: SubmissionAttemptEventRecord): boolean {
  const identity = frozenPostingIdentityFromEvent(opening);
  return !frozenPostingIdentityHasExactScope(identity);
}

function attributedPostingIdentity(posting: OrphanResolutionPosting) {
  const rawUrl = new URL(posting.portal_url);
  if (rawUrl.protocol !== 'https:' && rawUrl.protocol !== 'http:') {
    throw new Error('Employer portal URL must use HTTP or HTTPS');
  }
  if (rawUrl.username || rawUrl.password) throw new Error('Employer portal URL cannot contain credentials');
  const publicPostingUrl = canonicalPublicPostingUrl(posting.portal_url);
  if (!publicPostingUrl) throw new Error('Employer portal URL is invalid');
  const identity = freezePostingIdentity({ company: posting.company, role: posting.role }, publicPostingUrl);
  if (!identity.postingKey && !identity.jobId) {
    const publicUrl = new URL(publicPostingUrl);
    const pathSegments = publicUrl.pathname.split('/').filter(Boolean);
    const terminalSteps = new Set([
      'apply', 'application', 'application-form', 'application_form', 'applicationform',
      'apply-form', 'apply-now', 'applynow', 'form', 'job-application',
    ]);
    const exactSegments = [...pathSegments];
    while (exactSegments.length > 0 && terminalSteps.has(exactSegments.at(-1)!.toLowerCase())) {
      exactSegments.pop();
    }
    const lastSegment = exactSegments.at(-1)?.toLowerCase() ?? '';
    const genericPathEnd = new Set([
      'apply', 'career', 'careers', 'job', 'jobs', 'opening', 'openings',
      'list', 'listing', 'listings', 'open-positions', 'opportunities', 'opportunity',
      'position', 'positions', 'results', 'search', 'search-results',
    ]);
    const queryNames = [...rawUrl.searchParams.keys()];
    const trackingOnly = queryNames.every((name) => /^(?:utm_.+|source|ref|referrer|campaign|campaign_id|trk|tracking|fbclid|gclid|msclkid)$/i.test(name));
    if (rawUrl.hash || exactSegments.length < 2 || genericPathEnd.has(lastSegment) || !trackingOnly) {
      throw new Error('For this employer, use a clean job-specific URL whose path identifies the exact posting');
    }
  }
  if (!frozenPostingIdentityHasExactScope(identity)) {
    throw new Error('Employer portal URL does not identify one exact posting');
  }
  return identity;
}

function sameAttributedPosting(
  left: FrozenPostingIdentity,
  right: FrozenPostingIdentity,
): boolean {
  return left.postingKey === right.postingKey
    && left.jobId === right.jobId
    && left.companyRole === right.companyRole
    && left.portalUrl === right.portalUrl
    && left.portalIdentity === right.portalIdentity;
}

export async function resolveSubmissionOrphanRisk(input: {
  userId: string;
  attemptId: string;
  found: boolean;
  checkedAllPossibleDestinations?: true;
  checkedExactDestination?: true;
  posting?: OrphanResolutionPosting;
}): Promise<ResolutionResult> {
  try {
    return await db.transaction(async (tx) => {
    await lockSubmissionAttemptUser(tx, input.userId);
    const events = await exactAttemptEvents(tx, input.userId, input.attemptId);
    const opening = repairableSubmissionRiskOpening(events);
    if (!opening) return { kind: 'not_found' as const };

    const retrySafety = submissionAttemptRetrySafety(events);
    const identityless = identitylessOpening(opening);
    if (!input.found && exactAttemptPermanentlyBlocksNegativeResolution(events, input.attemptId)) {
      return { kind: 'conflict' as const, retrySafety };
    }
    const existingAttribution = confirmedOrphanAttributionForParent(
      await submissionAttemptEventsForUser(input.userId, { executor: tx }),
      input.attemptId,
    );
    if (retrySafety.kind === 'blocked_confirmed') {
      if (!input.found) return { kind: 'conflict' as const, retrySafety };
      if (!identityless) return { kind: 'resolved' as const, alreadyResolved: true, retrySafety };
      if (!input.posting) return { kind: 'attribution_required' as const, retrySafety };
      if (existingAttribution) {
        const requested = attributedPostingIdentity(input.posting);
        const stored = {
          ...existingAttribution.postingIdentity,
          portalUrl: existingAttribution.postingIdentity.portalUrl,
          portalIdentity: existingAttribution.postingIdentity.portalIdentity,
        };
        return sameAttributedPosting(requested, stored)
          ? {
            kind: 'resolved' as const,
            alreadyResolved: true,
            retrySafety,
            attributedAttemptId: existingAttribution.attemptId,
          }
          : { kind: 'conflict' as const, retrySafety };
      }
    }
    if (retrySafety.kind === 'safe_not_sent') {
      if (!input.found && (
        retrySafety.proofKind === 'applicant_checked_not_sent'
        || retrySafety.proofKind === 'applicant_checked_all_possible_destinations_not_sent'
      )) {
        return { kind: 'resolved' as const, alreadyResolved: true, retrySafety };
      }
      if (!input.found) return { kind: 'conflict' as const, retrySafety };
    }
    const confirmedAwaitingAttribution = retrySafety.kind === 'blocked_confirmed'
      && identityless
      && input.found
      && Boolean(input.posting);
    if (!confirmedAwaitingAttribution
      && retrySafety.kind !== 'safe_not_sent'
      && (retrySafety.kind !== 'blocked_unverified'
        || (retrySafety.reason !== 'opened' && retrySafety.reason !== 'pressed'))) {
      return { kind: 'not_resolvable' as const, retrySafety };
    }

    if (identityless && !input.found && input.checkedAllPossibleDestinations !== true) {
      return { kind: 'global_check_required' as const, retrySafety };
    }
    if (!identityless && !input.found && input.checkedExactDestination !== true) {
      return { kind: 'exact_check_required' as const, retrySafety };
    }
    if (identityless && input.found && !input.posting) {
      return { kind: 'attribution_required' as const, retrySafety };
    }

    const binding = submissionAttemptBindingFromEvent(opening);
    const eventKind = input.found ? 'submission_confirmed' as const : 'not_sent_proven' as const;
    if (!(input.found && retrySafety.kind === 'blocked_confirmed')) {
      await appendSubmissionAttemptEvent({
        ...binding,
        eventId: submissionAttemptEventId(
          input.attemptId,
          eventKind,
          'applicant-orphan-risk-resolution',
        ),
        eventKind,
        ...(input.found ? {} : {
          proofKind: identityless
            ? 'applicant_checked_all_possible_destinations_not_sent' as const
            : 'applicant_checked_not_sent' as const,
        }),
        evidenceCode: input.found
          ? 'applicant_found_orphan_autofill_submission'
          : identityless
            ? 'applicant_checked_all_possible_orphan_destinations_not_sent'
            : 'applicant_checked_orphan_autofill_not_sent',
      }, { executor: tx });
    }

    let attributedAttemptId: string | undefined;
    if (identityless && input.found && input.posting) {
      const postingIdentity = attributedPostingIdentity(input.posting);
      attributedAttemptId = submissionAttemptEventId(
        input.attemptId,
        'attempt_opened',
        'applicant-orphan-attribution-attempt',
      );
      const attributedBinding = {
        attemptId: attributedAttemptId,
        userId: input.userId,
        packetId: opening.packet_id,
        applicationId: opening.application_id,
        parentAttemptId: input.attemptId,
        source: 'attended_handoff' as const,
        operation: 'initial_submission' as const,
        postingIdentity,
        submissionRunId: null,
        submissionClaimId: null,
        packetVersion: null,
      };
      await appendSubmissionAttemptEvent({
        ...attributedBinding,
        eventId: submissionAttemptEventId(attributedAttemptId, 'attempt_opened', 'applicant-orphan-attribution'),
        eventKind: 'attempt_opened',
        evidenceCode: ORPHAN_ATTRIBUTION_OPENING_EVIDENCE,
      }, { executor: tx });
      await appendSubmissionAttemptEvent({
        ...attributedBinding,
        eventId: submissionAttemptEventId(attributedAttemptId, 'submission_confirmed', 'applicant-orphan-attribution'),
        eventKind: 'submission_confirmed',
        evidenceCode: ORPHAN_ATTRIBUTION_CONFIRMATION_EVIDENCE,
      }, { executor: tx });
    }

    const finalUserEvents = await submissionAttemptEventsForUser(input.userId, { executor: tx });
    const finalSafety = submissionAttemptRetrySafety(
      finalUserEvents.filter((event) => event.attempt_id === input.attemptId),
    );
    if (attributedAttemptId) {
      const validatedAttribution = confirmedOrphanAttributionForParent(finalUserEvents, input.attemptId);
      if (!validatedAttribution || validatedAttribution.attemptId !== attributedAttemptId) {
        throw new Error('SUBMISSION_ORPHAN_ATTRIBUTION_INVALID');
      }
    }
    const expected = input.found
      ? finalSafety.kind === 'blocked_confirmed'
      : finalSafety.kind === 'safe_not_sent'
        && (finalSafety.proofKind === 'applicant_checked_not_sent'
          || finalSafety.proofKind === 'applicant_checked_all_possible_destinations_not_sent');
    return expected
      ? {
        kind: 'resolved' as const,
        alreadyResolved: false,
        retrySafety: finalSafety,
        ...(attributedAttemptId ? { attributedAttemptId } : {}),
      }
      : { kind: 'conflict' as const, retrySafety: finalSafety };
    });
  } catch (error) {
    if (error instanceof SubmissionAttemptBindingConflictError
      || error instanceof SubmissionAttemptEventConflictError
      || (error instanceof Error && error.message === 'SUBMISSION_ORPHAN_ATTRIBUTION_INVALID')) {
      const retrySafety = submissionAttemptRetrySafety(
        await exactAttemptEvents(db, input.userId, input.attemptId),
      );
      return { kind: 'conflict', retrySafety };
    }
    throw error;
  }
}

export async function submissionOrphanRiskRoutes(fastify: FastifyInstance) {
  fastify.get('/submission-risks/orphans', { preHandler: requireAuth }, async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    reply.header('Cache-Control', 'private, no-store');
    const events = await submissionAttemptEventsForUser(request.jwtPayload!.userId);
    return reply.status(200).send({ risks: submissionOrphanRisksFromEvents(events) });
  });

  fastify.post('/submission-risks/orphans/:attemptId/resolution', { preHandler: requireAuth }, async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    reply.header('Cache-Control', 'private, no-store');
    const params = paramsSchema.safeParse(request.params);
    const body = resolutionSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: 'Say whether you found this exact application, with found true or false.' });
    }
    let result: ResolutionResult;
    try {
      result = await resolveSubmissionOrphanRisk({
        userId: request.jwtPayload!.userId,
        attemptId: params.data.attemptId,
        found: body.data.found,
        checkedAllPossibleDestinations: body.data.checked_all_possible_destinations,
        checkedExactDestination: body.data.checked_exact_destination,
        posting: body.data.posting,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('job-specific URL')) {
        return reply.status(400).send({
          error: error.message,
          code: 'invalid_submission_orphan_posting_url',
        });
      }
      throw error;
    }
    if (result.kind === 'not_found') {
      return reply.status(404).send({ error: 'That submission risk was not found.' });
    }
    if (result.kind === 'not_resolvable') {
      return reply.status(409).send({
        error: 'This attempt has contradictory evidence and cannot be resolved from the Tracker.',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'global_check_required') {
      return reply.status(409).send({
        error: 'This record has no employer identity. Confirm that you checked every employer portal and confirmation email from that period before clearing the user-wide lock.',
        code: 'submission_orphan_global_check_required',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'exact_check_required') {
      return reply.status(409).send({
        error: 'Confirm that you checked this exact employer portal and its confirmation email before marking the application not sent.',
        code: 'submission_orphan_exact_check_required',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'attribution_required') {
      return reply.status(409).send({
        error: 'Enter the company, role, and employer portal URL so the confirmed submission can be narrowed to one posting.',
        code: 'submission_orphan_attribution_required',
        retry_safety: result.retrySafety,
      });
    }
    if (result.kind === 'conflict') {
      return reply.status(409).send({
        error: 'This submission risk was already resolved with a different outcome.',
        retry_safety: result.retrySafety,
      });
    }
    return reply.status(200).send({
      attempt_id: params.data.attemptId,
      resolution: body.data.found ? 'found' : 'not_found',
      already_resolved: result.alreadyResolved,
      retry_safety: result.retrySafety,
      ...(result.attributedAttemptId ? { attributed_attempt_id: result.attributedAttemptId } : {}),
    });
  });
}
