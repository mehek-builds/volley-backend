import type { ApplicationReviewState } from './applicationReview';
import { detectPortal } from './portalSubmission';
import { submitRequestDisposition } from './submissionSafety';

export type ExtensionAuthorization = 'standing_consent' | 'user_initiated';
export type ExtensionOutcome = 'confirmed' | 'failed' | 'unknown' | 'cancelled';

export function extensionOutcomeClaimDisposition(
  review: ApplicationReviewState,
  claimId: string,
  outcome: ExtensionOutcome,
): 'active' | 'replay_unverified' | 'promote_confirmed' | 'stale' {
  if (review.submission_claim_id !== claimId) return 'stale';
  if (review.status === 'submitting') return 'active';
  const unresolved = review.status === 'needs_attention'
    && Boolean(review.unverified_submission && !review.unverified_submission.resolution);
  if (!unresolved) return 'stale';
  return outcome === 'confirmed' ? 'promote_confirmed' : 'replay_unverified';
}

export function isSafeExtensionReceiptUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
  } catch {
    return false;
  }
}

const EMPLOYER_RECEIPT_TEXT = /(?:^|[.!?]\s*)(?:thank you for (?:your )?(?:application|applying)(?: to [^.!?]{1,160})?|your application (?:has been|was) (?:successfully )?(?:received|submitted)|application (?:successfully )?(?:received|submitted))(?:[.!?]|$)/i;

/**
 * Jobvite and iCIMS begin behind an attended gate, so a generic Chrome success claim is not enough
 * to call them submitted. Bind the employer confirmation to the same tenant and job id and require
 * a terminal sentence rendered after the click. Other portals retain their existing contract.
 */
export function extensionEmployerReceiptIsSufficient(input: {
  portalUrl?: string;
  atsName?: string;
  confirmationText?: string;
  finalUrl: string;
}): boolean {
  const declaredFamily = input.atsName?.trim().toLowerCase();
  let frozenFamily: string | null = null;
  if (input.portalUrl) {
    try {
      frozenFamily = detectPortal(input.portalUrl);
    } catch {
      frozenFamily = null;
    }
  }
  const targetFamily = frozenFamily === 'jobvite' || frozenFamily === 'icims' || frozenFamily === 'oraclecloud'
    ? frozenFamily
    : declaredFamily === 'jobvite' || declaredFamily === 'icims' || declaredFamily === 'oraclecloud'
      ? declaredFamily
      : null;
  if (!targetFamily) return true;
  if (!frozenFamily || (declaredFamily && declaredFamily !== frozenFamily)) return false;
  const family = targetFamily;
  // No Oracle terminal receipt page has been captured yet. An extension may fill only after the
  // attended account gate, but it cannot promote an Oracle outcome to submitted without that
  // evidence contract.
  if (family === 'oraclecloud') return false;
  const confirmation = input.confirmationText?.trim();
  const normalizedConfirmation = confirmation?.replace(/\s+/g, ' ').trim();
  if (!normalizedConfirmation || !EMPLOYER_RECEIPT_TEXT.test(normalizedConfirmation)) return false;
  if (!input.portalUrl || !isSafeExtensionReceiptUrl(input.finalUrl)) return false;
  try {
    const frozen = new URL(input.portalUrl);
    const final = new URL(input.finalUrl);
    if (frozen.origin.toLowerCase() !== final.origin.toLowerCase() || final.username || final.password) return false;
    if (family === 'jobvite') {
      const frozenIdentity = frozen.pathname.match(/^\/([^/]+)\/job\/([a-z0-9]+)(?:\/|$)/i);
      const finalIdentity = final.pathname.match(/^\/([^/]+)\/job\/([a-z0-9]+)(?:\/|$)/i);
      const terminalRoute = /\/(?:confirmation|thank-you|submitted|application-submitted)\/?$/i.test(final.pathname);
      return Boolean(terminalRoute && frozen.pathname !== final.pathname && frozenIdentity && finalIdentity
        && frozenIdentity[1] === finalIdentity[1]
        && frozenIdentity[2] === finalIdentity[2]);
    }
    const frozenJob = frozen.pathname.match(/^\/jobs\/(\d+)\//i)?.[1];
    const finalJob = final.pathname.match(/^\/jobs\/(\d+)(?:\/|$)/i)?.[1];
    const terminalRoute = /\/(?:job|login)\/(?:confirmation|thank-you|submitted|application-submitted)\/?$/i.test(final.pathname);
    return Boolean(terminalRoute && frozen.pathname !== final.pathname && frozenJob && finalJob && frozenJob === finalJob);
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
  /* The row is passed for its no-send evidence and NOT for its unverified resolution, which stays
   * undefined here on purpose. An unverified submission is resolved by the applicant answering the
   * dashboard's question, and that route is the one allowed to act on her answer. */
  return submitRequestDisposition(review.status, Boolean(review.submission_claimed_at), undefined, review);
}

export function extensionOutcomePatch(
  outcome: ExtensionOutcome,
  now: string,
  evidence: { confirmationText?: string; finalUrl: string; submissionRunId?: string },
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
  /* A client-side label is not no-click proof. `failed` can be reported after the employer accepted
   * the request but before the extension read the receipt, and `cancelled` does not currently carry
   * a typed press checkpoint. Releasing either claim would make the ordinary retry path capable of
   * sending a duplicate. Treat every non-confirmed outcome as the same unresolved external side
   * effect until the applicant resolves this exact attempt. */
  const detail = outcome === 'failed'
    ? 'The extension reported a failure after this application was reserved, but Litos cannot prove whether the employer received it.'
    : outcome === 'cancelled'
      ? 'The extension reported that this application was cancelled, but it did not provide proof that Send was never pressed.'
      : 'Litos clicked Submit but could not verify the employer confirmation.';
  return {
    status: 'needs_attention',
    submission_attempted_at: now,
    unverified_submission: {
      at: now,
      cause: 'no_confirmation_state',
      portal_url: evidence.finalUrl,
      ...(evidence.submissionRunId ? { submission_run_id: evidence.submissionRunId } : {}),
    },
    attention_reason: `${detail} Check the employer portal or your email before trying again.`,
    submission_error: outcome === 'failed'
      ? evidence.confirmationText ?? 'The extension could not verify the submission result.'
      : undefined,
  };
}
