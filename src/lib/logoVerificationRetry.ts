export type LogoVerificationOutcome =
  | { verified: true }
  | { verified: false; reason: string };

type RetryOptions = {
  attempts?: number;
  delaysMs?: readonly number[];
  sleep?: (milliseconds: number) => Promise<void>;
};

const SAFE_FAILURE_REASON = /^(?:blocked_host|non_public_host|unsafe_url|response_too_large|bad_redirect|redirect_limit|http_\d{1,3}|timeout)$/;
const TRANSIENT_NETWORK_CODE = /^(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_[A-Z0-9_]+)$/;

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const direct = 'code' in error ? error.code : undefined;
  const cause = 'cause' in error && error.cause && typeof error.cause === 'object'
    && 'code' in error.cause ? error.cause.code : undefined;
  const code = typeof direct === 'string' ? direct : typeof cause === 'string' ? cause : null;
  return code && /^[A-Z0-9_]+$/.test(code) ? code : null;
}

/** Convert transport failures into bounded, non-sensitive reason strings. */
export function logoVerificationErrorReason(error: unknown): string {
  if (error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  const code = errorCode(error);
  if (code) return `network_${code}`;
  const message = error instanceof Error ? error.message : '';
  return SAFE_FAILURE_REASON.test(message) ? message : 'verification_failed';
}

function componentReason(reason: string): string {
  const separator = reason.lastIndexOf(':');
  return separator >= 0 ? reason.slice(separator + 1) : reason;
}

/** Only short-lived provider or transport failures receive an immediate retry. */
export function isTransientLogoVerificationReason(reason: string): boolean {
  return reason.split(';').some((part) => {
    const component = componentReason(part);
    if (component === 'timeout'
      || component === 'empty_response'
      || component === 'verification_failed') return true;
    if (/^http_(?:0|408|425|429|5\d\d)$/.test(component)) return true;
    const network = component.match(/^network_([A-Z0-9_]+)$/)?.[1];
    return network ? TRANSIENT_NETWORK_CODE.test(network) : false;
  });
}

/** Retry only classified transient outcomes, preserving the verifier's exact final reason. */
export async function retryTransientLogoVerification<T extends LogoVerificationOutcome>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 3);
  const delaysMs = options.delaysMs ?? [1_000, 5_000];
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  }));
  let result = await operation();
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    if (result.verified || !isTransientLogoVerificationReason(result.reason)) return result;
    await sleep(delaysMs[Math.min(attempt - 1, delaysMs.length - 1)] ?? 0);
    result = await operation();
  }
  return result;
}
