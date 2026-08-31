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
