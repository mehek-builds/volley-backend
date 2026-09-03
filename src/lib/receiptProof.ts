/**
 * WHAT A RECEIPT PAGE HAS TO SAY, AND WHERE IT HAS TO BE, before Litos records an application as
 * sent. A leaf on purpose: portalSubmission.ts (the direct path) and managedSubmitOutcome.ts (the
 * managed verdict) both need it, and portalSubmission imports from managedSubmitOutcome, so the
 * proof cannot live in either without a cycle.
 *
 * Crelate is structural, not just a broad thank-you match: the public bundle routes a successful
 * SubmitApplication to /portal/{org}/job/applythanks/{JobCode}?applicationId={ApplicationId} and
 * renders "Thank you for applying to {Title} at {CompanyName}" or the stock "Thank you for applying
 * to this position." Requiring the first-party host, the exact route, one bounded opaque
 * applicationId and that sentence keeps an unrelated portal thank-you or footer from being recorded
 * as an employer receipt. Every other host answers to the receipt phrases below.
 */
export function receiptReference(body: string): string | undefined {
  return body.match(/(?:confirmation|reference)(?:\s*(?:id|number))?\s*[:#]\s*([A-Z0-9-]{5,})/i)?.[1]
    ?? body.match(/application\s*(?:id|number|#)\s*[:#]?\s*([A-Z0-9-]{5,})/i)?.[1];
}

export const RECEIPT_PROOF_RE = /thank you|thanks for your application|application (?:has been )?(?:submitted|received)|we received your application|your application has been successfully submitted|all done![\s\S]{0,160}application|success/i;

/* Crelate receipt proof is structural, not just a broad thank-you match.
 *
 * The public bundle routes a successful SubmitApplication response to
 * /portal/{org}/job/applythanks/{JobCode}?applicationId={ApplicationId}. It renders either
 * "Thank you for applying to {Title} at {CompanyName}" or the stock fallback "Thank you for
 * applying to this position." Requiring the first-party host, exact route, one bounded opaque
 * applicationId and that narrow sentence prevents an unrelated portal thank-you or footer from
 * being recorded as an employer receipt. */
export const CRELATE_RECEIPT_PATH_RE =
  /^\/portal\/[a-z0-9][a-z0-9_-]{0,127}\/job\/applythanks\/[a-z0-9]{26}\/?$/i;
export const CRELATE_RECEIPT_TEXT_RE =
  /\bthank you for applying to (?:this position\b|.{1,300}\bat\b.{1,300})/i;

export function isCrelateHostUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && url.hostname.toLowerCase() === 'jobs.crelate.com';
  } catch {
    return false;
  }
}

export function crelateReceiptReference(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'jobs.crelate.com'
      || !CRELATE_RECEIPT_PATH_RE.test(url.pathname) || url.hash) return undefined;
    const keys = [...url.searchParams.keys()];
    const values = url.searchParams.getAll('applicationId');
    if (keys.length !== 1 || keys[0] !== 'applicationId' || values.length !== 1) return undefined;
    const applicationId = values[0] ?? '';
    return /^[A-Za-z0-9_-]{8,200}$/.test(applicationId) ? applicationId : undefined;
  } catch {
    return undefined;
  }
}

export function receiptProof(body: string, finalUrl: string): { proven: boolean; referenceId?: string } {
  if (isCrelateHostUrl(finalUrl)) {
    const referenceId = crelateReceiptReference(finalUrl);
    return referenceId && CRELATE_RECEIPT_TEXT_RE.test(body)
      ? { proven: true, referenceId }
      : { proven: false };
  }
  return RECEIPT_PROOF_RE.test(body)
    ? { proven: true, referenceId: receiptReference(body) }
    : { proven: false };
}

