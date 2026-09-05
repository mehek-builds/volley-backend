/* THE ROW THAT HOLDS ITS RECEIPT AND CANNOT SAY SO.
 *
 * commitVerifiedSubmissionConfirmed (routes/submissionRunner.ts) appends the employer's confirmation
 * to the immutable ledger first and only then projects it onto the row. When that projection cannot
 * be proven it parks the row at needs_attention, keeps the receipt, and writes the one sentence below.
 * Bear Robotics b822b998, 2026-09-05T01:50:46Z: Breezy's "Application Submitted ... Good luck!"
 * receipt in hand, submission_confirmed in the ledger, row parked - because no receipt rule knew a
 * tenant-host Breezy URL. The dashboard then offered "I found it there", which the resolution route
 * refused (the ledger already holds a confirmation, so the attempt is not unverified), and nothing
 * else: the strongest fact the product has about that application was unreadable to the applicant.
 *
 * Once the missing rule ships, the ledger fact is already there; what is owed is a second projection.
 * This file names the exact shape that deserves one, so the reader that performs it cannot widen
 * itself onto a row that is parked for any other reason.
 */

import type { ApplicationReviewState } from './applicationReview';

export const PARKED_CONFIRMED_PROJECTION_REASON =
  'Litos captured the employer receipt, but its saved application projection needs repair. '
  + 'Do not send this application again.';

/** How long a parked row rests between re-projections. The submission read that performs the
 * repair is polled every 2.5s while the applicant looks at the row; a projection that still cannot
 * be proven must not become a write per poll. */
export const PARKED_CONFIRMED_PROJECTION_RETRY_MS = 60_000;

export type ParkedConfirmedReceipt = {
  claimId: string;
  receipt: NonNullable<ApplicationReviewState['receipt']>;
};

export function parkedConfirmedReceipt(
  review: Pick<
    ApplicationReviewState,
    'status' | 'receipt' | 'submission_claim_id' | 'attention_reason' | 'unverified_submission' | 'submitted_at'
  >,
): ParkedConfirmedReceipt | null {
  if (review.status !== 'needs_attention') return null;
  if (review.submitted_at) return null;
  if (!review.receipt || review.receipt.source !== 'managed_browser') return null;
  if (!review.submission_claim_id) return null;
  if (review.attention_reason !== PARKED_CONFIRMED_PROJECTION_REASON) return null;
  if (review.unverified_submission?.resolution) return null;
  return { claimId: review.submission_claim_id, receipt: review.receipt };
}

/** Whether a parked row has rested long enough since its last write to try the projection again. */
export function parkedConfirmedProjectionMayRetry(
  review: Pick<ApplicationReviewState, 'updated_at'>,
  now: number,
): boolean {
  const last = Date.parse(review.updated_at);
  if (Number.isNaN(last)) return true;
  return now - last >= PARKED_CONFIRMED_PROJECTION_RETRY_MS;
}
