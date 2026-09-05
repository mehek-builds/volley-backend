/* THE PRESS THAT WAS ONLY EVER A SENTENCE.
 *
 * Before `unverified_submission` existed, the runner that pressed Send and could not read what came
 * back wrote one fixed sentence into attention_reason - "The final submission was attempted, but
 * Litos could not verify the employer confirmation." - and nothing else: no attempt in the ledger,
 * no claim, no timestamp of the press. Deepgram 4bfd5827 (2026-08-11) is the production witness,
 * and lib/duplicateApplication.ts reads exactly that sentence so a second packet on the posting is
 * refused: on 2026-09-05 packet 4ef78910 was told "Not sent: Litos already pressed Send on ... at
 * Deepgram and could not confirm what came back ... tell Litos whether it is there."
 *
 * The one action that sentence sends her to did not exist for this row. The dashboard draws its
 * yes/no card from `unverified_submission`, which the old writer never set, so the earlier row showed
 * "Answer 2 questions" and no card; and POST /applications/:id/submission/unverified read the same
 * field and answered 409 not_waiting. A refusal on every later packet, with no exit on the row it
 * points at.
 *
 * This file reads the prose as the record it always described and decides her answer over it:
 *
 *   - legacyUnverifiedSubmissionRecord publishes the card. It is a reading, never a write, marked
 *     `legacy_prose` so the resolver knows which authority it stands on.
 *   - legacyUnverifiedPressDecision decides "it is not there" / "I found it there" for that row.
 *     A ledger fact that an employer boundary was reached outranks the prose: if any attempt on the
 *     packet authorized a boundary, observed a press, or recorded a confirmation, the row belongs to
 *     the modern route on its own claim and this one refuses (authority_conflict). "Not there" also
 *     closes every reconstructed attempt on the packet that never reached the employer, with the
 *     same applicant_checked_not_sent proof the modern arm writes, so the ledger and the row stop
 *     disagreeing about what happened. "Found it" is recorded as the mutable Sent marker with an
 *     attended_handoff receipt: a pre-ledger press has no exact attempt to confirm against, and
 *     inventing one would be a fact the ledger never observed. The duplicate guard treats that
 *     marker as it treats every legacy Sent row (receipt_authority 'repair_required'): it keeps
 *     refusing a second application, which is the point of her answer.
 */

import type { ApplicationReviewState } from './applicationReview';
import { applyReviewPatch } from './applicationStall';
import { applicantFoundSubmissionReceiptText } from './authoritativeSubmissionProjection';
import { isLegacyUnverifiedAttemptReason } from './duplicateApplication';
import { attemptNeverReachedEmployer, type SubmissionAttemptEventRecord } from './submissionAttemptLedger';

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

export type LegacyUnverifiedPressDecision =
  | { kind: 'authority_conflict' }
  | { kind: 'authority_missing' }
  | {
    kind: 'resolve';
    review: ApplicationReviewState;
    /** attempt_opened events of every reconstructed attempt on the packet that never reached the
     * employer; the caller appends applicant_checked_not_sent to each, in the same transaction. */
    closeOpenings: SubmissionAttemptEventRecord[];
    pipelineStage: 'applied' | null;
  };

const EMPLOYER_BOUNDARY_EVENT_KINDS = new Set<SubmissionAttemptEventRecord['event_kind']>([
  'boundary_authorized',
  'press_observed',
  'submission_confirmed',
]);

export function legacyUnverifiedPressDecision(input: {
  current: ApplicationReviewState;
  pending: UnverifiedSubmissionRecord;
  found: boolean;
  /** Every ledger event on the packet, all attempts. */
  events: readonly SubmissionAttemptEventRecord[];
  now: string;
}): LegacyUnverifiedPressDecision {
  const { current, pending, found, events, now } = input;
  if (events.some((event) => EMPLOYER_BOUNDARY_EVENT_KINDS.has(event.event_kind))) {
    return { kind: 'authority_conflict' };
  }
  const resolved: UnverifiedSubmissionRecord = {
    ...pending,
    resolution: found ? 'sent' : 'not_sent',
    resolved_at: now,
  };
  if (!found) {
    const closeOpenings = [...new Set(events.map((event) => event.attempt_id))].flatMap((attemptId) => {
      const attemptEvents = events.filter((event) => event.attempt_id === attemptId);
      if (!attemptNeverReachedEmployer(attemptEvents)) return [];
      const opening = attemptEvents.find((event) => event.event_kind === 'attempt_opened');
      return opening ? [opening] : [];
    });
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
    return { kind: 'resolve', review, closeOpenings, pipelineStage: null };
  }
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
  return { kind: 'resolve', review, closeOpenings: [], pipelineStage: 'applied' };
}
