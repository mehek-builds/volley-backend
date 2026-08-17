import { createHash } from 'node:crypto';
import type { ApplicationReviewState } from './applicationReview';
import {
  BAMBOOHR_ATTENDED_GATE_REASON,
  canonicalSupportedPortalUrl,
  CAPTCHA_BLOCKER,
  detectPortal,
  isCaptchaGatedPortalName,
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
      /* The CAPTCHA-gated families, and this arm RESTORES prior behaviour rather than loosening it.
       *
       * This whole block only runs when a frozenHandoffUrl exists. Until the same change that added
       * this line, the runner never wrote one for jazzhr/bamboohr/comeet, so their rows skipped this
       * block entirely and fell through to the generic canonical comparison at the bottom, which
       * returns TRUE for a matching form. Writing the URL flips that: the block now runs, finds no
       * eligible cause, and returns false.
       *
       * Measured: same jazzhr row, extensionHandoffPacketMatches was true with frozenHandoffUrl
       * undefined and false with it set. That would have taken out
       * GET /applications/:id/submission/extension-packet (409) and extensionStartHandoffBinding
       * ('mismatch') for every CAPTCHA-gated application - trading the working Chrome-extension path
       * for the new dashboard one instead of adding to it.
       *
       * So this is the second caller of the gate the dashboard change touched, and it had to move
       * with it. Exactly the two-callers-one-gate shape this file's other comments warn about. */
      || (isCaptchaGatedPortalName(frozenPortal) && reasons.includes(CAPTCHA_BLOCKER))
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

/* The portals the DASHBOARD may open at action time, which is narrower than the set the extension
 * can be armed for.
 *
 * jazzhr and comeet join bamboohr here so that all three CAPTCHA-GATED families can be finished by
 * hand. They are the families portalCanAutoSubmit denies for a required challenge, and on an
 * attended run Litos fills their form before stopping, so what is left really is "pass the check and
 * press Send". Before this, bamboohr was the only one listed and its own arm below asked for a reason
 * nothing ever wrote, so no CAPTCHA stall on any family could produce a dashboard handoff.
 *
 * NOT added, deliberately: greenhouse, ashby and lever. They raise the same captcha flag from an
 * invisible v3 badge that asks a human for nothing, they can auto-submit, and offering a handoff
 * there would tell her a challenge is waiting when none is. See managedExtensionHandoffUrl, which is
 * keyed on the same distinction. */
const DASHBOARD_ATTENDED_PORTALS = new Set([
  'smartrecruiters',
  'jobvite',
  'icims',
  'bamboohr',
  'jazzhr',
  'comeet',
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
      /* bamboohr still demands its OWN sentence, and that is deliberate rather than an oversight
       * left in place: the assertion at extensionHandoffPacket.test.ts refuses a bamboohr row
       * carrying only the generic CAPTCHA_BLOCKER, and BAMBOOHR_ATTENDED_GATE_REASON says something
       * the generic blocker does not - that the form is already filled and only the check and the
       * send button remain.
       *
       * KNOWN GAP, deliberately not closed here: nothing in the codebase writes that reason. Grep
       * returns its declaration in portalSubmission.ts and this one consumer. So bamboohr sits in
       * DASHBOARD_ATTENDED_PORTALS behind a cause that cannot currently occur - the
       * composition-root shape this repo has recorded five times. The fix is to EMIT the reason from
       * the runner's captcha stall, not to weaken this check, because weakening it would trade a
       * precise sentence for a vague one on the surface a human acts from. Filed rather than done,
       * so that a reason-composition change gets its own diff and its own review. */
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

  /* The CAPTCHA-gated families are checked for SELF-CONSISTENCY rather than through
   * extensionHandoffPacketMatches, and bamboohr already was.
   *
   * These forms are single-page: the URL the run observed when it met the challenge is the same
   * application URL the packet was frozen against, so the honest invariant is that the handoff URL
   * canonicalizes to exactly the frozen posting. That is strictly stronger than what the shared
   * matcher would ask, since it admits no second URL at all.
   *
   * Routing them here also leaves extensionHandoffPacketMatches untouched. Its own recovery-cause
   * list grants a CAPTCHA exit to smartrecruiters only, and widening it would loosen the EXTENSION
   * packet route as well - a different disclosure surface, on the same predicate. Two callers, one
   * gate: exactly the shape that made a fix land in the wrong copy four times in this repo. */
  if (isCaptchaGatedPortalName(portal)) {
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
