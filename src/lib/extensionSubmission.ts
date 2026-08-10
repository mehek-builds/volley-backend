import type { ApplicationReviewState } from './applicationReview';
import { detectPortal } from './portalSubmission';
import { submitRequestDisposition } from './submissionSafety';

export type ExtensionAuthorization = 'standing_consent' | 'user_initiated';
export type ExtensionOutcome = 'confirmed' | 'failed' | 'unknown' | 'cancelled';

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
  const targetFamily = frozenFamily === 'jobvite' || frozenFamily === 'icims'
    ? frozenFamily
    : declaredFamily === 'jobvite' || declaredFamily === 'icims'
      ? declaredFamily
      : null;
  if (!targetFamily) return true;
  if (!frozenFamily || (declaredFamily && declaredFamily !== frozenFamily)) return false;
  const family = targetFamily;
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
  if (outcome === 'cancelled') {
    return {
      status: 'ready_to_submit',
      submission_error: undefined,
      attention_reason: undefined,
      submission_claimed_at: undefined,
      submission_claim_id: undefined,
      submission_authorization: undefined,
    };
  }
  return {
    status: 'needs_attention',
    attention_reason: 'Litos clicked Submit but could not verify the employer confirmation. Check the portal or your email before trying again.',
    submission_error: undefined,
  };
}
