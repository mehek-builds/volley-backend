/* The lifecycle vocabulary of the canonical applications table.
 *
 * This lives in lib because writers act on the same fact from different modules: the
 * manual-outcome route (src/routes/canonicalApplications.ts) and the shared packet-submission
 * sync (src/lib/canonicalApplicationSync.ts), which carries it for every writer that stamps a
 * packet submitted - the email confirmation path, the four server submit paths, and the dashboard
 * outcome routes. All of them must mean exactly the same thing by "a confirmed submission", and
 * sharing the constant is what keeps them from drifting apart.
 */
export type ManualSubmissionOutcome = 'confirmed' | 'failed' | 'unknown';

export const confirmedSubmissionLifecycle = {
  submissionState: 'submitted',
  trackerState: 'applied',
} as const;

/* THE LIFECYCLE OF A FILLED FORM THAT HAS NOT BEEN SENT.
 *
 * A managed prepare reads the employer form, fills it, screenshots it and parks the packet at
 * _review.status 'ready_for_final_approval', waiting for the applicant to press Send. Until this
 * existed the canonical applications row learned nothing from that: it kept the
 * (submission_state 'not_started', review_state 'ready') pair its generating INSERT gave it, and
 * every surface reading the row concluded the application still needed work. Measured in prod on
 * 2026-09-02, that is what put a filled Maven Group packet behind a "One thing to finish" card
 * with no Send control, and it is what 83 other prepared applications were sitting behind.
 *
 * IT IS NOT A SEND, AND IT MUST NEVER READ AS ONE. 'ready_for_final_approval' is deliberately a
 * different word from 'submitted' and from the legacy backfill's 'ready_to_submit': no gate in
 * this codebase treats it as evidence that an employer received anything, and the value is named
 * after the applicant's next action rather than after an outcome. */
export const preparedSendLifecycle = {
  submissionState: 'ready_for_final_approval',
  reviewState: 'ready_for_final_approval',
} as const;

/* The resting pair a canonical row returns to when its packet leaves the prepared hold without
 * being sent - a restart, a fresh tailor, an audit that reopened a question. It is exactly the
 * pair the generating INSERT (src/routes/resume.ts) and the packet link
 * (linkGeneratedPacketToCanonicalApplication) already write, so leaving the hold restores the
 * shape every existing reader was written against. */
export const unpreparedSendLifecycle = {
  submissionState: 'not_started',
  reviewState: 'ready',
} as const;

/* The one packet review status that means "filled and waiting on the applicant". Kept as a
 * predicate rather than a bare comparison because both the write path (writeReview) and the
 * read heal (GET /applications) must agree on it exactly, or a row heals one way on read and the
 * other way on write. */
export function packetReviewIsPreparedSend(status: string | null | undefined): boolean {
  return status === preparedSendLifecycle.reviewState;
}

/* The read heal. The stored columns are a projection of the packet, and for every application
 * prepared before the write path above existed they are behind. Rather than a one-off backfill,
 * every canonical read derives the pair from the packet the row points at, in both directions:
 * a packet parked at ready_for_final_approval reports the prepared pair even when the columns
 * say not_started, and a row still wearing the prepared pair whose packet has moved on reports
 * the resting pair. A terminal row - submitted, or a tracker stage that means the employer has
 * it - is never rewritten by this, because the ledger outranks the packet. */
export function preparedSendLifecycleProjection(input: {
  tracker_state: string;
  review_state: string;
  submission_state: string;
}, packetReviewStatus: string | null | undefined): { review_state: string; submission_state: string } {
  const stored = { review_state: input.review_state, submission_state: input.submission_state };
  if (input.submission_state === 'submitted' || isAppliedOrLaterTrackerState(input.tracker_state)) return stored;
  if (packetReviewIsPreparedSend(packetReviewStatus)) {
    return {
      review_state: preparedSendLifecycle.reviewState,
      submission_state: preparedSendLifecycle.submissionState,
    };
  }
  if (input.submission_state === preparedSendLifecycle.submissionState) {
    return {
      review_state: unpreparedSendLifecycle.reviewState,
      submission_state: unpreparedSendLifecycle.submissionState,
    };
  }
  return stored;
}

export function isAppliedOrLaterTrackerState(value: string): boolean {
  return value === 'applied' || value === 'interview' || value === 'offer' || value === 'closed';
}

/**
 * Receipt projection may arrive after the applicant has already advanced the packet in their
 * tracker. Keep every applied-or-later stage and its original timestamp, otherwise advance the
 * packet exactly once to applied at the receipt observation time.
 */
export function confirmedPacketPipelineProjection(observedAt: Date) {
  const alreadyAppliedOrLater = sql`${generated_resumes.pipeline_stage} in ('applied', 'interview', 'offer', 'closed')`;
  return {
    pipeline_stage: sql`case when ${alreadyAppliedOrLater} then ${generated_resumes.pipeline_stage} else 'applied' end`,
    pipeline_stage_at: sql`case
      when ${generated_resumes.pipeline_stage} in ('interview', 'offer', 'closed')
        then ${generated_resumes.pipeline_stage_at}
      when ${generated_resumes.pipeline_stage} = 'applied'
        and ${generated_resumes.pipeline_stage_at} is not null
        then ${generated_resumes.pipeline_stage_at}
      else ${observedAt}
    end`,
  };
}

export function manualSubmissionTransition(
  currentState: string,
  outcome: ManualSubmissionOutcome,
  currentTrackerState = 'saved',
) {
  const confirmedTrackerState = ['interview', 'offer', 'closed'].includes(currentTrackerState)
    ? currentTrackerState
    : confirmedSubmissionLifecycle.trackerState;
  if (currentState === 'submitted') {
    return { ...confirmedSubmissionLifecycle, trackerState: confirmedTrackerState };
  }
  if (outcome === 'confirmed') {
    return { ...confirmedSubmissionLifecycle, trackerState: confirmedTrackerState };
  }
  if (currentState === 'failed') return { submissionState: 'failed', trackerState: 'applying' } as const;
  if (outcome === 'failed') return { submissionState: 'failed', trackerState: 'applying' } as const;
  return { submissionState: 'needs_attention', trackerState: 'applying' } as const;
}
import { sql } from 'drizzle-orm';
import { generated_resumes } from '../db/schema';
