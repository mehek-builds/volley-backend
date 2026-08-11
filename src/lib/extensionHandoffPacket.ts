import { createHash } from 'node:crypto';
import type { ApplicationReviewState } from './applicationReview';
import {
  BAMBOOHR_ATTENDED_GATE_REASON,
  canonicalSupportedPortalUrl,
  CAPTCHA_BLOCKER,
  detectPortal,
  ICIMS_ATTENDED_GATE_REASON,
  ICIMS_SECURITY_CODE_GATE_REASON,
  JOBVITE_ATTENDED_GATE_REASON,
  ORACLE_ATTENDED_GATE_REASON,
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
  if (input.frozenHandoffUrl) {
    const reasons = input.attentionReason?.split('\n') ?? [];
    const eligibleRecoveryCause = reasons.includes(MANAGED_NETWORK_ACCESS_RESTRICTION_REASON)
      || (frozenPortal === 'smartrecruiters' && reasons.includes(CAPTCHA_BLOCKER))
      || (frozenPortal === 'jobvite' && reasons.includes(JOBVITE_ATTENDED_GATE_REASON))
      || (frozenPortal === 'icims' && (
        reasons.includes(ICIMS_ATTENDED_GATE_REASON)
        || reasons.includes(ICIMS_SECURITY_CODE_GATE_REASON)
      ))
      || (frozenPortal === 'oraclecloud' && reasons.includes(ORACLE_ATTENDED_GATE_REASON));
    if (input.status !== 'needs_attention' || !eligibleRecoveryCause) return false;
  }

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
  if (frozenPortal === 'jobvite' || frozenPortal === 'icims' || frozenPortal === 'oraclecloud') {
    if (!input.frozenHandoffUrl) return false;
    let handoffPortal: string;
    try {
      handoffPortal = detectPortal(input.frozenHandoffUrl);
    } catch {
      return false;
    }
    if (handoffPortal !== frozenPortal) return false;
    const handoffCanonical = canonicalSupportedPortalUrl(input.frozenHandoffUrl, handoffPortal);
    if (frozenPortal === 'oraclecloud'
      && (input.frozenHandoffUrl !== handoffCanonical || input.currentUrl !== currentCanonical)) return false;
    return Boolean(
      frozenCanonical
      && handoffCanonical
      && currentCanonical
      && frozenCanonical === handoffCanonical
      && handoffCanonical === currentCanonical,
    );
  }
  if (frozenCanonical && currentCanonical && frozenCanonical === currentCanonical) return true;
  if (frozenCanonical && currentCanonical
    && applicationIdentityKey(frozenCanonical, frozenPortal) === applicationIdentityKey(currentCanonical, currentPortal)) return true;
  return false;
}

const DASHBOARD_ATTENDED_PORTALS = new Set([
  'smartrecruiters',
  'jobvite',
  'icims',
  'bamboohr',
]);

export function createDashboardHandoffBinding(input: {
  applicationId: string;
  userId: string;
  frozenUrl: string | undefined;
  frozenHandoffUrl: string;
  frozenAtsName: string | undefined;
  attentionReason?: string;
  attentionCategories?: ApplicationReviewState['attention_categories'];
}): NonNullable<ApplicationReviewState['extension_handoff_binding']> {
  return {
    version: 'dashboard_handoff_v1',
    sha256: createHash('sha256').update(JSON.stringify({
      applicationId: input.applicationId,
      userId: input.userId,
      frozenUrl: input.frozenUrl,
      frozenHandoffUrl: input.frozenHandoffUrl,
      frozenAtsName: input.frozenAtsName,
      attentionReason: input.attentionReason,
      attentionCategories: [...(input.attentionCategories ?? [])],
    })).digest('hex'),
  };
}

/**
 * Return the exact server-observed company URL that the dashboard may open at action time.
 *
 * This is deliberately narrower than extensionHandoffPacketMatches. The dashboard is not allowed
 * to reuse a URL from React state, derive a form URL from a posting, or advertise a future portal.
 * Oracle remains unavailable until a measured post-gate form and receipt exist.
 */
export function verifiedDashboardHandoffUrl(input: {
  applicationId: string;
  userId: string;
  frozenUrl: string | undefined;
  frozenHandoffUrl?: string;
  frozenHandoffBinding?: ApplicationReviewState['extension_handoff_binding'];
  frozenAtsName?: string;
  status: ApplicationReviewState['status'];
  attentionReason?: string;
  attentionCategories?: ApplicationReviewState['attention_categories'];
  submissionClaimedAt?: string;
  submissionClaimId?: string;
  submissionPacketVersion?: string;
  submissionAttemptedAt?: string;
  submittedAt?: string;
  receipt?: ApplicationReviewState['receipt'];
  unverifiedSubmission?: ApplicationReviewState['unverified_submission'];
}): string | null {
  if (input.status !== 'needs_attention'
    || input.submissionClaimedAt
    || input.submissionClaimId
    || input.submissionPacketVersion
    || input.submissionAttemptedAt
    || input.submittedAt
    || input.receipt
    || (input.unverifiedSubmission && input.unverifiedSubmission.resolution !== 'not_sent')
    || !input.frozenHandoffUrl) return null;

  const expectedBinding = createDashboardHandoffBinding({
    applicationId: input.applicationId,
    userId: input.userId,
    frozenUrl: input.frozenUrl,
    frozenHandoffUrl: input.frozenHandoffUrl,
    frozenAtsName: input.frozenAtsName,
    attentionReason: input.attentionReason,
    attentionCategories: input.attentionCategories,
  });
  if (input.frozenHandoffBinding?.version !== expectedBinding.version
    || input.frozenHandoffBinding.sha256 !== expectedBinding.sha256) return null;

  let portal: string;
  try {
    portal = detectPortal(input.frozenHandoffUrl);
  } catch {
    return null;
  }
  if (!DASHBOARD_ATTENDED_PORTALS.has(portal) || input.frozenAtsName !== portal) return null;

  const categories = new Set(input.attentionCategories ?? []);
  const reasons = new Set(input.attentionReason?.split('\n') ?? []);
  const typedCause = portal === 'jobvite'
    ? reasons.has(JOBVITE_ATTENDED_GATE_REASON) && categories.has('privacy_consent')
    : portal === 'icims'
      ? ((reasons.has(ICIMS_ATTENDED_GATE_REASON) && categories.has('account_login'))
        || (reasons.has(ICIMS_SECURITY_CODE_GATE_REASON) && categories.has('security_code')))
      : portal === 'bamboohr'
        ? reasons.has(BAMBOOHR_ATTENDED_GATE_REASON) && categories.has('captcha')
        : (reasons.has(MANAGED_NETWORK_ACCESS_RESTRICTION_REASON)
          || (reasons.has(CAPTCHA_BLOCKER) && categories.has('captcha')));
  if (!typedCause) return null;

  const exactCanonical = canonicalSupportedPortalUrl(input.frozenHandoffUrl, portal);
  if (!exactCanonical || exactCanonical !== input.frozenHandoffUrl) return null;

  if (portal === 'smartrecruiters') {
    try {
      const url = new URL(input.frozenHandoffUrl);
      if (url.protocol !== 'https:'
        || url.hostname !== 'jobs.smartrecruiters.com'
        || url.username
        || url.password
        || url.port
        || url.search
        || url.hash
        || !/^\/oneclick-ui\/company\/[a-z0-9._-]+\/publication\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(url.pathname)) return null;
    } catch {
      return null;
    }
  }

  if (portal === 'bamboohr') {
    const frozenCanonical = input.frozenUrl
      ? canonicalSupportedPortalUrl(input.frozenUrl, input.frozenAtsName)
      : undefined;
    return frozenCanonical === exactCanonical ? input.frozenHandoffUrl : null;
  }

  return extensionHandoffPacketMatches({
    frozenUrl: input.frozenUrl,
    frozenHandoffUrl: input.frozenHandoffUrl,
    currentUrl: input.frozenHandoffUrl,
    frozenAtsName: input.frozenAtsName,
    status: input.status,
    attentionReason: input.attentionReason,
    submissionClaimedAt: input.submissionClaimedAt,
  }) ? input.frozenHandoffUrl : null;
}
