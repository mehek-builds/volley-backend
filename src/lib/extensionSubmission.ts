import type { ApplicationReviewState } from './applicationReview';
import { submitRequestDisposition } from './submissionSafety';

export type ExtensionAuthorization = 'standing_consent' | 'user_initiated';
export type ExtensionOutcome = 'confirmed' | 'failed' | 'unknown';

export function isSafeExtensionReceiptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch {
    return false;
  }
}

export function canStartExtensionSubmission(
  review: ApplicationReviewState,
  authorization: ExtensionAuthorization,
  standingConsentEnabled: boolean,
): 'start' | 'in_flight' | 'submitted' | 'reject' | 'consent_required' {
  if (authorization === 'standing_consent' && !standingConsentEnabled) return 'consent_required';
  return submitRequestDisposition(review.status, Boolean(review.submission_claimed_at));
}

export function extensionOutcomePatch(
  outcome: ExtensionOutcome,
  now: string,
  evidence: { confirmationText?: string; finalUrl: string },
): Partial<ApplicationReviewState> {
  if (outcome === 'confirmed') {
    return {
      status: 'submitted',
      submitted_at: now,
      submission_error: undefined,
      attention_reason: undefined,
      receipt: {
        confirmation_text: evidence.confirmationText ?? 'Application submitted',
        final_url: evidence.finalUrl,
        captured_at: now,
        source: 'chrome_extension',
      },
    };
  }
  if (outcome === 'failed') {
    return {
      status: 'failed',
      submission_error: evidence.confirmationText ?? 'The company rejected the submission.',
      attention_reason: undefined,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
    };
  }
  return {
    status: 'needs_attention',
    attention_reason: 'Litos clicked Submit but could not verify the employer confirmation. Check the portal or your email before trying again.',
    submission_error: undefined,
  };
}
