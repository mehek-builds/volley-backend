import type { ApplicationReviewState } from './applicationReview';

export function submitRequestDisposition(status: ApplicationReviewState['status']): 'start' | 'in_flight' | 'submitted' | 'reject' {
  if (status === 'submitted') return 'submitted';
  if (['submit_requested', 'preparing', 'filling', 'submitting'].includes(status)) return 'in_flight';
  if (['resume_ready', 'questions_ready', 'ready_to_submit', 'failed'].includes(status)) return 'start';
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
