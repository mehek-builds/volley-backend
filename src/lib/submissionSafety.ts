import type { ApplicationReviewState } from './applicationReview';

export function submitRequestDisposition(
  status: ApplicationReviewState['status'],
  submissionWasClaimed = false,
): 'start' | 'in_flight' | 'submitted' | 'reject' {
  if (status === 'submitted') return 'submitted';
  if (['submit_requested', 'preparing', 'filling', 'submitting'].includes(status)) return 'in_flight';
  // needs_attention covers two materially different states. Before the final click it is safe to
  // rerun preparation after the user supplies a missing answer or a selector fix ships. After the
  // click it represents an uncertain external side effect, so another run could create a duplicate
  // employer application and must stay blocked.
  if (status === 'needs_attention' && !submissionWasClaimed) return 'start';
  if (['resume_ready', 'questions_ready', 'ready_to_submit', 'failed'].includes(status)) return 'start';
  return 'reject';
}

export function resumeEditDisposition(
  status: ApplicationReviewState['status'],
  submissionWasClaimed = false,
): 'start' | 'reject' {
  if (submitRequestDisposition(status, submissionWasClaimed) === 'start') return 'start';
  // A packet at final approval has filled the company form but has not been sent. If its frozen
  // resume no longer matches the profile, editing must be allowed so the next fill reruns with the
  // corrected PDF and a fresh preview. Once the company form has been claimed, the duplicate-send
  // risk wins and the packet stays locked.
  if (status === 'ready_for_final_approval' && !submissionWasClaimed) return 'start';
  return 'reject';
}

export function directPreparationIsSafe(options: {
  blockerCount: number;
  attentionCount: number;
  verificationStatus: 'not_needed' | 'searching' | 'completed' | 'handoff';
}): boolean {
  return options.blockerCount === 0
    && options.attentionCount === 0
    && options.verificationStatus !== 'handoff';
}
