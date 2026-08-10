import type { ApplicationReviewState } from './applicationReview';
import { canonicalSupportedPortalUrl, detectPortal } from './portalSubmission';

const ELIGIBLE_HANDOFF_STATES = new Set<ApplicationReviewState['status']>([
  'needs_attention',
  'ready_to_submit',
  'questions_ready',
  'ready_for_final_approval',
]);

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
    return url.toString();
  } catch {
    return null;
  }
}

/** Bind an exact stored application to the company form currently hosting the extension. */
export function extensionHandoffPacketMatches(input: {
  frozenUrl: string | undefined;
  currentUrl: string;
  frozenAtsName?: string;
  status: ApplicationReviewState['status'];
  submissionClaimedAt?: string;
}): boolean {
  if (!ELIGIBLE_HANDOFF_STATES.has(input.status) || input.submissionClaimedAt) return false;
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
  if (frozenCanonical && currentCanonical && frozenCanonical === currentCanonical) return true;
  if (frozenCanonical && currentCanonical
    && applicationIdentityKey(frozenCanonical, frozenPortal) === applicationIdentityKey(currentCanonical, currentPortal)) return true;

  if (frozenPortal === 'smartrecruiters') {
    const frozenTenant = smartRecruitersTenant(input.frozenUrl);
    return Boolean(frozenTenant && frozenTenant === smartRecruitersTenant(input.currentUrl));
  }
  return false;
}
