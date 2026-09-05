/* THE PRESS THAT WAS ONLY EVER A SENTENCE, AND THE PRESS THE ROW FORGOT.
 *
 * Two shapes of the same wedge. In both, an attempt reached the employer's Send button and nobody
 * knows what came back; in both, the duplicate guard rightly refuses every later packet on the
 * posting and sends the applicant to "tell Litos whether it is there"; and in both the row that
 * carries the press cannot take the answer, because POST /submission/unverified reads the row's own
 * `unverified_submission` and `submission_claim_id`, and these rows have neither.
 *
 *   1. THE SENTENCE. Before `unverified_submission` existed the runner wrote one fixed sentence into
 *      attention_reason - "The final submission was attempted, but Litos could not verify the
 *      employer confirmation." - and nothing else. Deepgram 4bfd5827 (2026-08-11) is the witness;
 *      on 2026-09-05 packet 4ef78910 was refused because of it.
 *   2. THE LEDGER PRESS. The immutable ledger holds an attempt that authorized the boundary or
 *      observed a press and never recorded an outcome, but the row no longer carries the claim that
 *      bound it (released, repaired, or the row itself rewritten by a later stop). Notion a4b7295c
 *      (2026-09-05): refused for "already pressed Send on ... at Notion" with no record on any Notion
 *      row and no claim to answer against.
 *
 * This file reads either shape into the record the dashboard's yes/no card already draws
 * (`unverified_submission`, marked `legacy_prose` or `ledger_attempt` so the writer knows which
 * authority it stands on) and decides her answer over the packet's whole ledger:
 *
 *   - A confirmation anywhere in the packet's ledger outranks everything and refuses: that row is
 *     owed a projection, not a question.
 *   - A press whose employer-boundary lease is still active is refused until it lapses, exactly as
 *     the row-bound arm refuses (the lease is durable employer risk).
 *   - "It is not there" closes every attempt on the packet that has no outcome - the pressed ones
 *     and the reconstructed opens that never reached the employer - with the same
 *     applicant_checked_not_sent proof the row-bound arm writes, in one transaction, so the ledger
 *     and the row stop disagreeing about what happened.
 *   - "I found it there" binds her confirmation to the one pressed attempt when there is exactly
 *     one (applicant_found_submission, as the row-bound arm does); with none it records the mutable
 *     Sent marker only, since inventing an attempt would be a fact the ledger never observed; with
 *     several it refuses, because it cannot tell which one the employer holds.
 */

import type { ApplicationReviewState } from './applicationReview';
import { applyReviewPatch } from './applicationStall';
import { applicantFoundSubmissionReceiptText } from './authoritativeSubmissionProjection';
import { isLegacyUnverifiedAttemptReason } from './duplicateApplication';
import {
  attemptNeverReachedEmployer,
  submissionAttemptRetrySafety,
  type SubmissionAttemptEventRecord,
} from './submissionAttemptLedger';

export type UnverifiedSubmissionRecord = NonNullable<ApplicationReviewState['unverified_submission']>;

export const LEGACY_PRESS_NOT_THERE_REASON =
  'You checked and the employer does not have this one. Litos can send it again when you are ready.';

type LegacyUnverifiedReview = Pick<
  ApplicationReviewState,
  | 'status'
  | 'attention_reason'
  | 'unverified_submission'
  | 'portal_url'
  | 'submission_attempted_at'
  | 'submission_run_id'
  | 'submitted_at'
  | 'receipt'
  | 'applicant_email'
  | 'updated_at'
>;

/**
 * The pre-ledger press, read into the shape the applicant can answer. Null for every row that is not
 * exactly that: a modern record present, a status other than the parked one, any evidence an employer
 * holds something (receipt, submitted_at), or a different sentence.
 *
 * `at` is the newest fact the row keeps about when that runner stopped: submission_attempted_at
 * where the old writer set it, else the moment the packet's employer-facing email was decided (the
 * fill's first act, minutes before the press), else the row's own clock.
 */
export function legacyUnverifiedSubmissionRecord(
  review: LegacyUnverifiedReview,
): UnverifiedSubmissionRecord | null {
  if (review.unverified_submission) return null;
  if (review.status !== 'needs_attention') return null;
  if (review.submitted_at || review.receipt) return null;
  if (!isLegacyUnverifiedAttemptReason(review.attention_reason)) return null;
  const at = review.submission_attempted_at ?? review.applicant_email?.decided_at ?? review.updated_at;
  if (!at) return null;
  return {
    at,
    cause: 'no_confirmation_state',
    ...(review.portal_url ? { portal_url: review.portal_url } : {}),
    ...(review.submission_run_id ? { submission_run_id: review.submission_run_id } : {}),
    legacy_prose: true,
  };
}

export type PacketAttemptReading = {
  attemptId: string;
  opening: SubmissionAttemptEventRecord | null;
  events: SubmissionAttemptEventRecord[];
  safety: ReturnType<typeof submissionAttemptRetrySafety>;
  /** A boundary was authorized or a press observed, and no outcome was ever recorded. */
  pressed: boolean;
  /** One attempt_opened and nothing after it: never reached the employer. */
  neverReached: boolean;
};

/** The packet's ledger, one reading per attempt, oldest attempt first. */
export function readPacketAttempts(events: readonly SubmissionAttemptEventRecord[]): PacketAttemptReading[] {
  const byAttempt = new Map<string, SubmissionAttemptEventRecord[]>();
  for (const event of events) {
    const list = byAttempt.get(event.attempt_id) ?? [];
    list.push(event);
    byAttempt.set(event.attempt_id, list);
  }
  return [...byAttempt.entries()]
    .map(([attemptId, attemptEvents]) => {
      const sorted = [...attemptEvents].sort((left, right) =>
        left.observed_at.getTime() - right.observed_at.getTime());
      const safety = submissionAttemptRetrySafety(sorted);
      return {
        attemptId,
        opening: sorted.find((event) => event.event_kind === 'attempt_opened') ?? null,
        events: sorted,
        safety,
        pressed: safety.kind === 'blocked_unverified' && safety.reason !== 'opened',
        neverReached: attemptNeverReachedEmployer(sorted),
      };
    })
    .sort((left, right) => {
      const l = left.events[0]?.observed_at.getTime() ?? 0;
      const r = right.events[0]?.observed_at.getTime() ?? 0;
      return l - r;
    });
}

/**
 * The press the row forgot, read from the packet's ledger into the answerable record. Null when the
 * row already carries a record, is not parked, holds evidence an employer has something, or when the
 * ledger shows no press without an outcome. Where several presses stand, the newest names the
 * record; the decision below refuses "found it" over several, so nothing is bound blindly.
 */
export function ledgerUnverifiedPressRecord(
  review: Pick<ApplicationReviewState, 'status' | 'unverified_submission' | 'portal_url' | 'submitted_at' | 'receipt'>,
  events: readonly SubmissionAttemptEventRecord[],
): UnverifiedSubmissionRecord | null {
  if (review.unverified_submission) return null;
  if (review.status !== 'needs_attention') return null;
  if (review.submitted_at || review.receipt) return null;
  const attempts = readPacketAttempts(events);
  /* A confirmation anywhere - however its sequence classifies - is owed a projection, not a question. */
  if (attempts.some((attempt) => attempt.safety.kind === 'blocked_confirmed'
    || attempt.events.some((event) => event.event_kind === 'submission_confirmed'))) return null;
  const pressed = attempts.filter((attempt) => attempt.pressed);
  const newest = pressed.at(-1);
  if (!newest || newest.safety.kind !== 'blocked_unverified') return null;
  const portalUrl = newest.opening?.portal_url ?? review.portal_url;
  return {
    at: newest.safety.at,
    cause: 'no_confirmation_state',
    ...(portalUrl ? { portal_url: portalUrl } : {}),
    ...(newest.opening?.submission_run_id ? { submission_run_id: newest.opening.submission_run_id } : {}),
    ledger_attempt: newest.attemptId,
  };
}

/** What the ledger says, in the applicant's terms, for a refusal body or a read. */
export function packetLedgerSummary(events: readonly SubmissionAttemptEventRecord[]): Array<{
  attempt_id: string;
  source: string | null;
  safety: string;
  events: Array<{ kind: string; at: string; evidence: string | null }>;
}> {
  return readPacketAttempts(events).map((attempt) => ({
    attempt_id: attempt.attemptId,
    source: attempt.opening?.source ?? null,
    safety: attempt.safety.kind === 'blocked_unverified'
      ? `blocked_unverified:${attempt.safety.reason}`
      : attempt.safety.kind,
    events: attempt.events.map((event) => ({
      kind: event.event_kind,
      at: event.observed_at.toISOString(),
      evidence: event.evidence_code ?? null,
    })),
  }));
}

export type LegacyUnverifiedPressDecision =
  | { kind: 'authority_conflict'; conflict: 'confirmed' | 'ambiguous_press' }
  | { kind: 'authority_missing' }
  | { kind: 'lease_active'; expiresAt: string }
  | {
    kind: 'resolve';
    review: ApplicationReviewState;
    /** attempt_opened events of every attempt on the packet with no outcome - pressed or never
     * reached; the caller appends applicant_checked_not_sent to each, in the same transaction. */
    closeOpenings: SubmissionAttemptEventRecord[];
    /** The one pressed attempt her "found it" confirms; the caller appends
     * applicant_found_submission to it. Null when the packet's ledger holds no press. */
    confirmOpening: SubmissionAttemptEventRecord | null;
    pipelineStage: 'applied' | null;
  };

export function legacyUnverifiedPressDecision(input: {
  current: ApplicationReviewState;
  pending: UnverifiedSubmissionRecord;
  found: boolean;
  /** Every ledger event on the packet, all attempts. */
  events: readonly SubmissionAttemptEventRecord[];
  /** The employer-boundary lease per pressed attempt, where one was ever written. */
  leases?: ReadonlyMap<string, { active: boolean; expiresAt: string }>;
  now: string;
}): LegacyUnverifiedPressDecision {
  const { current, pending, found, events, now } = input;
  const attempts = readPacketAttempts(events);
  if (attempts.some((attempt) => attempt.safety.kind === 'blocked_confirmed'
    || attempt.events.some((event) => event.event_kind === 'submission_confirmed'))) {
    return { kind: 'authority_conflict', conflict: 'confirmed' };
  }
  const pressed = attempts.filter((attempt) => attempt.pressed);
  const activeLease = pressed
    .map((attempt) => input.leases?.get(attempt.attemptId))
    .find((lease) => lease?.active);
  if (activeLease) return { kind: 'lease_active', expiresAt: activeLease.expiresAt };
  const resolved: UnverifiedSubmissionRecord = {
    ...pending,
    resolution: found ? 'sent' : 'not_sent',
    resolved_at: now,
  };
  if (!found) {
    const closeOpenings = attempts
      .filter((attempt) => attempt.pressed || attempt.neverReached)
      .flatMap((attempt) => (attempt.opening ? [attempt.opening] : []));
    const review = applyReviewPatch(current, {
      status: 'needs_attention',
      unverified_submission: resolved,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
      submission_packet_version: undefined,
      submission_authorization: undefined,
      attention_reason: LEGACY_PRESS_NOT_THERE_REASON,
      attention_categories: ['unverified_submission'],
    }, () => now);
    return { kind: 'resolve', review, closeOpenings, confirmOpening: null, pipelineStage: null };
  }
  if (pressed.length > 1) return { kind: 'authority_conflict', conflict: 'ambiguous_press' };
  const confirmOpening = pressed[0]?.opening ?? null;
  const finalUrl = pending.portal_url ?? current.portal_url;
  if (!finalUrl) return { kind: 'authority_missing' };
  const review = applyReviewPatch(current, {
    status: 'submitted',
    submitted_at: now,
    submission_error: undefined,
    attention_reason: undefined,
    attention_categories: undefined,
    unverified_submission: resolved,
    receipt: {
      confirmation_text: applicantFoundSubmissionReceiptText(true),
      final_url: finalUrl,
      captured_at: now,
      source: 'attended_handoff',
    },
  }, () => now);
  return { kind: 'resolve', review, closeOpenings: [], confirmOpening, pipelineStage: 'applied' };
}
