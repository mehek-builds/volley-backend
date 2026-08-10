import { createHash } from 'node:crypto';
import type { ApplicationReviewState } from './applicationReview';
import {
  canonicalSupportedPortalUrl,
  detectPortal,
  MANAGED_NETWORK_ACCESS_RESTRICTION_REASON,
} from './portalSubmission';

const ELIGIBLE_HANDOFF_STATES = new Set<ApplicationReviewState['status']>([
  'needs_attention',
  'ready_to_submit',
  'questions_ready',
  'ready_for_final_approval',
]);

/** Version the exact server packet disclosed to an attended extension run. */
export function extensionHandoffVersion(input: {
  applicationId: string;
  userId: string;
  resumeObjectKey: string;
  spec: unknown;
  jobContext: unknown;
  currentUrl: string;
}): string | null {
  let canonicalUrl: string | undefined;
  try {
    const portal = detectPortal(input.currentUrl);
    const canonical = canonicalSupportedPortalUrl(input.currentUrl, portal);
    canonicalUrl = canonical ? applicationIdentityKey(canonical, portal) ?? canonical : undefined;
  } catch {
    return null;
  }
  if (!canonicalUrl) return null;
  return createHash('sha256').update(JSON.stringify({
    applicationId: input.applicationId,
    userId: input.userId,
    resumeObjectKey: input.resumeObjectKey,
    spec: input.spec,
    jobContext: input.jobContext,
    currentUrl: canonicalUrl,
  })).digest('hex');
}

export type ExtensionStartHandoffBindingResult =
  | 'valid'
  | 'missing'
  | 'mismatch'
  | 'stale';

/** Validate the packet binding echoed by Chrome before an attended submission is claimed. */
export function extensionStartHandoffBinding(input: {
  handoffVersion?: string;
  currentUrl?: string;
  applicationId: string;
  userId: string;
  resumeObjectKey: string;
  spec: unknown;
  jobContext: unknown;
  review: Pick<ApplicationReviewState,
    | 'portal_url'
    | 'extension_handoff_url'
    | 'ats_name'
    | 'status'
    | 'attention_reason'
    | 'submission_claimed_at'>;
}): ExtensionStartHandoffBindingResult {
  const hasVersion = Boolean(input.handoffVersion);
  const hasUrl = Boolean(input.currentUrl);
  if (!hasVersion || !hasUrl) return 'missing';

  if (!extensionHandoffPacketMatches({
    frozenUrl: input.review.portal_url,
    frozenHandoffUrl: input.review.extension_handoff_url,
    currentUrl: input.currentUrl!,
    frozenAtsName: input.review.ats_name,
    status: input.review.status,
    attentionReason: input.review.attention_reason,
    submissionClaimedAt: input.review.submission_claimed_at,
  })) return 'mismatch';

  const currentVersion = extensionHandoffVersion({
    applicationId: input.applicationId,
    userId: input.userId,
    resumeObjectKey: input.resumeObjectKey,
    spec: input.spec,
    jobContext: input.jobContext,
    currentUrl: input.currentUrl!,
  });
  return currentVersion && currentVersion === input.handoffVersion ? 'valid' : 'stale';
}

function smartRecruitersTenant(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.hostname.toLowerCase() !== 'jobs.smartrecruiters.com') return null;
    const posting = url.pathname.match(/^\/([^/]+)\/\d{6,}(?:-[^/]+)?\/?$/i)?.[1];
    const oneClick = url.pathname.match(/^\/oneclick-ui\/company\/([^/]+)\/publication\/[0-9a-f-]{36}\/?$/i)?.[1];
    return (posting ?? oneClick)?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function applicationIdentityKey(rawUrl: string, portal: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (portal === 'lever' || portal === 'personio' || portal === 'jobvite') {
      url.pathname = url.pathname.replace(/\/apply\/?$/i, '');
    } else if (portal === 'recruitee') {
      url.pathname = url.pathname.replace(/\/c\/new\/?$/i, '');
    } else if (portal === 'teamtailor' || portal === 'pinpoint') {
      url.pathname = url.pathname.replace(/\/applications\/new\/?$/i, '');
    }
    url.pathname = url.pathname.replace(/\/$/, '');
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key)
        || (portal === 'greenhouse' && key.toLowerCase() === 'gh_src')
        || (portal === 'lever' && key.toLowerCase() === 'lever-source')) url.searchParams.delete(key);
    }
    // Bullhorn's job id lives in the hash. Every other supported family either carries identity in
    // path/query or has already been canonicalized to do so.
    if (portal !== 'bullhorn') {
      url.hash = '';
    }
    return url.toString();
  } catch {
    return null;
  }
}

/** Bind an exact stored application to the company form currently hosting the extension. */
export function extensionHandoffPacketMatches(input: {
  frozenUrl: string | undefined;
  frozenHandoffUrl?: string;
  currentUrl: string;
  frozenAtsName?: string;
  status: ApplicationReviewState['status'];
  attentionReason?: string;
  submissionClaimedAt?: string;
}): boolean {
  if (!ELIGIBLE_HANDOFF_STATES.has(input.status) || input.submissionClaimedAt) return false;
  if (input.frozenHandoffUrl && (
    input.status !== 'needs_attention'
    || !input.attentionReason?.split('\n').includes(MANAGED_NETWORK_ACCESS_RESTRICTION_REASON)
  )) return false;
  if (!input.frozenUrl) return false;
  let frozenPortal: string;
  let currentPortal: string;
  try {
    frozenPortal = detectPortal(input.frozenUrl);
    currentPortal = detectPortal(input.currentUrl);
  } catch {
    return false;
  }
  if (frozenPortal !== currentPortal) return false;
  if (input.frozenAtsName && input.frozenAtsName !== frozenPortal) return false;

  const frozenCanonical = canonicalSupportedPortalUrl(input.frozenUrl, input.frozenAtsName);
  const currentCanonical = canonicalSupportedPortalUrl(input.currentUrl, currentPortal);
  if (frozenPortal === 'smartrecruiters') {
    const frozenTenant = smartRecruitersTenant(input.frozenUrl);
    if (!frozenTenant || frozenTenant !== smartRecruitersTenant(input.currentUrl)) return false;
    if (!input.frozenHandoffUrl) return false;
    let handoffPortal: string;
    try {
      handoffPortal = detectPortal(input.frozenHandoffUrl);
    } catch {
      return false;
    }
    if (handoffPortal !== frozenPortal || frozenTenant !== smartRecruitersTenant(input.frozenHandoffUrl)) return false;
    const handoffCanonical = canonicalSupportedPortalUrl(input.frozenHandoffUrl, handoffPortal);
    return Boolean(handoffCanonical && currentCanonical && handoffCanonical === currentCanonical);
  }
  if (frozenCanonical && currentCanonical && frozenCanonical === currentCanonical) return true;
  if (frozenCanonical && currentCanonical
    && applicationIdentityKey(frozenCanonical, frozenPortal) === applicationIdentityKey(currentCanonical, currentPortal)) return true;
  return false;
}
