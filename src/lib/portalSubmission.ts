import type { Page } from 'playwright-core';
import {
  MANAGED_DISCOVERY_ROLE_CAPABILITY,
  MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
  MANAGED_SUBMIT_CHOOSER_POLICY,
  type ManagedBrowserAction,
  type ManagedBrowserResult,
} from './browserbase';
import { describeRequiredBlocker, describeUnlabelledBlockers, humanFieldLabel } from './fieldLabel';
import { applicantChoseStoredAnswer } from './applicantAnswer';
import { optionBandAnswer, storedOptionAnswerIsCurrent } from './optionBand';
import {
  classifyField,
  consentAcknowledgementLicence,
  discoveredFieldIsRequired,
  frozenJobEmployerContext,
  graduationYearFieldAnswer,
  isConsentAcceptingWording,
  isLegalConsentQuestion,
  normalizeReviewQuestionLabel,
  resolveKnownAnswer,
  ROUTINE_APPLICANT_CONSENT_QUESTION,
  type ApplicationProfileLike,
  type ProfileKey,
} from './questionDiscovery';
import {
  chooseClosestOption,
  disciplineLadder,
  isDeclineToState,
  profileAnswerAliases,
  resolveProfileField,
  selfIdentificationDeclineWording,
} from './profileFieldResolution';
import type { ElementHandle, Locator } from 'playwright-core';
import { browserApplicationCapability, type BrowserApplicationFamily } from './browserApplicationCapabilities';
import { isControlledTestPortalUrl } from './controlledTestPortal';
import { chooseCanonicalFinalSubmit } from './finalSubmitChooserPolicy';
import {
  SUBMIT_READINESS_ASTERISK_LEGEND,
  SUBMIT_READINESS_ASTERISK_MARK,
  SUBMIT_READINESS_ERROR_TEXT,
  SUBMIT_READINESS_LEGEND_TEXT,
  SUBMIT_READINESS_OWN_QUESTION_SKIP,
  SUBMIT_READINESS_REQUIRED_ATTRIBUTES,
  SUBMIT_READINESS_REQUIRED_CLASS_MARKERS,
} from './submitReadinessGrammar';
import {
  referralSourceForApplication,
  referralSourceOptionCandidates,
  type ReferralSourceEvidence,
} from './referralSource';
import { embeddedGreenhouseApplicationUrl, embeddedGreenhouseJobId } from './greenhouseEmbeddedBoards';
import {
  postingCountryCodeFromJobContext,
  postingCountryFromJobContext,
  type JobCountry,
} from './jobLocation';

// Portal field ids legitimately contain CSS-syntax characters (Greenhouse uses UUIDs, others use
// dots and colons), so they are matched with the [id="..."] attribute form rather than #id. Inside
// a quoted attribute value only the quote and the backslash need escaping, which keeps this to one
// rule instead of a full CSS identifier escaper, and means a field id can never terminate the
// selector and match something unintended.
function quoteAttr(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/* Exported for one reason: portalSupportInvariants.test.ts enumerates it and asserts that
 * portalCanAutoSubmit and isAutonomousPortalFamily agree on every member. That agreement is what
 * makes the CAPTCHA corroboration rule safe, and it is not otherwise enforced anywhere. */
export type PortalFamily =
  | 'greenhouse'
  | 'lever'
  | 'ashby'
  | 'smartrecruiters'
  | 'workable'
  | 'jazzhr'
  | 'paylocity'
  | 'rippling'
  | 'breezy'
  | 'bamboohr'
  | 'jobvite'
  | 'icims'
  | 'oraclecloud'
  | 'ultipro'
  | 'recruitee'
  | 'teamtailor'
  | 'personio'
  | 'pinpoint'
  | 'comeet'
  | 'zoho_recruit'
  | 'bullhorn'
  | 'sap_successfactors'
  | 'oracle_taleo'
  | 'adp_recruiting'
  | 'avature';
type ControlledPortal =
  | 'controlled_test'
  | 'controlled_lever'
  | 'controlled_ashby'
  | 'controlled_smartrecruiters'
  | 'controlled_workable'
  | 'controlled_jazzhr'
  | 'controlled_paylocity'
  | 'controlled_rippling'
  | 'controlled_breezy'
  | 'controlled_bamboohr';
type ManualPortal = 'manual_recruitee';
export type SupportedPortal = PortalFamily | ControlledPortal | ManualPortal;

function portalFamily(portal: SupportedPortal): PortalFamily {
  if (portal === 'manual_recruitee') return 'recruitee';
  if (portal === 'controlled_test') return 'greenhouse';
  if (portal === 'controlled_lever') return 'lever';
  if (portal === 'controlled_ashby') return 'ashby';
  if (portal === 'controlled_smartrecruiters') return 'smartrecruiters';
  if (portal === 'controlled_workable') return 'workable';
  if (portal === 'controlled_jazzhr') return 'jazzhr';
  if (portal === 'controlled_paylocity') return 'paylocity';
  if (portal === 'controlled_rippling') return 'rippling';
  if (portal === 'controlled_breezy') return 'breezy';
  if (portal === 'controlled_bamboohr') return 'bamboohr';
  return portal;
}

// Portals whose first page is NOT the last page. A run against one of these fills what it can and
// stops; it must never click its way forward, because the control that looks like a submit button
// is a "Next Step"/"Continue" that leads to further pages this adapter has never seen. Letting one
// through would produce a "submitted" state for an application the employer never received, which
// is the single worst failure this module can have - worse than not supporting the portal at all.
// Confirmed live 2026-07-28: Paylocity's #btn-submit is labelled "Next Step".
//
// 'smartrecruiters' joined this set on 2026-07-28. It was always equally multi-step - the scope
// limit is documented at SMARTRECRUITERS_RESUME_SELECTOR - but it relied on the weaker guarantee
// that clickFinalSubmit() finds no submit control on step one, so the click was pushed and landed on
// nothing. That was tolerable while the only consumer was the submission runner.
//
// It stopped being tolerable when the jobs board began deriving "which jobs may we show" from
// portalCanAutoSubmit(). A predicate that answers true for a portal that cannot actually finish
// would surface postings the student can never complete through Litos, which is a worse failure than
// the honest "not supported yet" - she'd spend the effort before finding out. Making the predicate
// truthful is what lets anything else depend on it.
// Declared as TYPES first, not just Sets, so "can this portal finish on its own" is answerable at
// compile time and not only at runtime. That is what lets the jobs board's own union be checked
// against this one by the type checker instead of by a test that someone can forget to run.
type MultiStepFamily = 'paylocity' | 'smartrecruiters';
type CaptchaGatedFamily = 'jazzhr' | 'bamboohr' | 'comeet';
type ConsentGatedFamily = 'teamtailor';

const MULTI_STEP_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['paylocity', 'smartrecruiters'] satisfies MultiStepFamily[],
);

// Portals that gate submission behind a CAPTCHA. Litos fills these and hands off to the human; it
// never attempts the challenge (standing rule, and the same correct stop the Ashby/CTGT run made).
// Confirmed live 2026-07-28: every JazzHR application form carries a g-recaptcha-response field.
// Confirmed live 2026-07-29 for BambooHR on a real PRC-Saltillo posting: g-recaptcha-response is
// present, window.grecaptcha is defined, the badge renders, and recaptcha/api.js?render=explicit is
// loaded. BambooHR's fields are otherwise clean and fully fillable, which is exactly why the ceiling
// has to be written down - the form LOOKS like a one-run submit and is not.
const CAPTCHA_GATED_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['jazzhr', 'bamboohr', 'comeet'] satisfies CaptchaGatedFamily[],
);

// These forms are fillable, but their final action belongs to the applicant. Personio tenants can
// mark fields required without the native required attribute, so the shared readiness reader cannot
// prove the form complete. Pinpoint puts a required privacy-processing consent directly before
// submit. Both were confirmed on two unrelated public tenants on 2026-08-09. Keeping them out of
// autonomous submission also keeps them out of polling through AUTONOMOUS_PORTAL_FAMILIES.
//
// Pinpoint's bar - and ONLY pinpoint's - is conditionally lifted per account by the standing
// consent-acceptance permission: see ConsentGrantConditionalFamily below. Personio's bar is the
// readiness reader, which no permission can lift, so personio stays here unconditionally.
type ManualFinalReviewFamily = 'personio' | 'pinpoint';

const MANUAL_FINAL_REVIEW_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['personio', 'pinpoint'] satisfies ManualFinalReviewFamily[],
);

// Teamtailor puts an applicant privacy acknowledgement beside the send control on every live
// tenant inspected. The checkbox is not consistently marked required in HTML, so the generic
// readiness scan cannot prove that an unchecked control is safe. Fill the factual fields and stop.
const CONSENT_GATED_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['teamtailor'] satisfies ConsentGatedFamily[],
);

/* THE FAMILIES WHOSE ONLY BAR TO AUTONOMY IS A ROUTINE CONSENT CONTROL BESIDE SUBMIT.
 *
 * Teamtailor's candidate[consent_given] and Pinpoint's privacy-processing consent are, on every
 * tenant captured, the single thing standing between a completed fill and the send control. The
 * standing consent-acceptance permission (lib/automationConsent.ts, granted once at onboarding,
 * version-checked, and runner-trust-gated through lib/grantedAnswerReplay.ts) covers exactly that
 * class of control, so an account holding the grant can honestly be carried through submit.
 *
 * WHY THIS IS NOT MEMBERSHIP IN AUTONOMOUS_PORTAL_FAMILIES, stated because the pull toward the
 * static list is strong. That list is ACCOUNT-INDEPENDENT: the jobs board, polling and coverage
 * copy all read it with no user in hand, and an account that never granted the permission must get
 * exactly today's behaviour (fill, stop, hand off). Putting these two on the static list would
 * surface postings that a no-grant account can never finish, which is the exact harm the list's
 * own comment names as its worst. So the static story is unchanged - teamtailor stays
 * consent-gated, pinpoint stays manual-final-review - and the CONDITIONAL story lives in
 * portalCanAutoSubmitWithConsentGrant below, which takes the account's grant as an argument.
 *
 * personio is NOT here, deliberately: its bar is custom required-marking that defeats the
 * readiness reader, which no consent permission can lift.
 *
 * breezy joined on 2026-08-20, and it is in this list for a DIFFERENT reason than the other two,
 * stated here so nobody "fixes" the asymmetry. Teamtailor's and pinpoint's SUBMIT is what the
 * grant unlocks: both are statically denied, and without the grant they never press anything.
 * Breezy is statically AUTONOMOUS (single-step, CAPTCHA-free, on AUTONOMOUS_PORTAL_FAMILIES since
 * 2026-07-29) and stays so; the grant unlocks only the guarded consent TICK on tenants that ship
 * the optional gdprAgreement checkbox. Measured live 2026-08-20 on Transparent Hiring
 * (<tenant>.breezy.hr, "HR Assistant Intern"): the run filled everything, pressed submit, and
 * parked SOLELY on the required, still-empty gdprAgreement control - which is also the live proof
 * the tenant does not pre-tick it, the re-confirmation pushManagedConsentTickActions' comment
 * demands before any new family is admitted. Without the grant a breezy run keeps exactly that
 * measured behaviour: fill, press, park on the tenant's own validation. */
export type ConsentGrantConditionalFamily = 'teamtailor' | 'pinpoint' | 'breezy';

const CONSENT_GRANT_CONDITIONAL_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['teamtailor', 'pinpoint', 'breezy'] satisfies ConsentGrantConditionalFamily[],
);

/* Compile-time: every grant-conditional family whose SUBMIT the grant unlocks is STATICALLY denied
 * by one of the deny sets above, so AutonomousPortalFamily (and with it the jobs board's union) can
 * never claim one. breezy is the named exception, not a loosening of the rule: its submit was never
 * the grant's to unlock, so the second line pins the opposite direction - breezy must STAY on the
 * autonomous list, or the tick plan silently becomes the thing that unlocks its submit and this
 * whole split stops being true. A new family added here must satisfy one line or the other, by
 * name, and this comment is where its measurement belongs. */
type _ConditionalFamilyIsStaticallyGated =
  Exclude<ConsentGrantConditionalFamily, 'breezy'> extends ConsentGatedFamily | ManualFinalReviewFamily ? true : never;
const _conditionalFamilyIsStaticallyGated: _ConditionalFamilyIsStaticallyGated = true;
void _conditionalFamilyIsStaticallyGated;
type _BreezyStaysStaticallyAutonomous = 'breezy' extends AutonomousPortalFamily ? true : never;
const _breezyStaysStaticallyAutonomous: _BreezyStaysStaticallyAutonomous = true;
void _breezyStaysStaticallyAutonomous;

export function isConsentGrantConditionalFamily(portal: SupportedPortal): boolean {
  // manual_recruitee resolves to the recruitee family, which is not conditional; the controlled QA
  // portals resolve to their real families the same way every other family predicate here does.
  return CONSENT_GRANT_CONDITIONAL_FAMILIES.has(portalFamily(portal));
}

function consentGrantConditionalFamilyName(family: PortalFamily): ConsentGrantConditionalFamily | null {
  return family === 'teamtailor' || family === 'pinpoint' || family === 'breezy' ? family : null;
}

// Portals where there is no application form to fill AT ALL until a human passes a gate that only
// they can pass: a data-consent choice, an account wall, or an emailed one-time code. This is a
// different and stronger limit than the two above, which describe forms Litos fills and then stops
// on. Here the first page carries no application fields whatsoever, so there is nothing to fill and
// no selector worth writing.
//
// All four were read live on 2026-07-29 (see litos-ats-dom-capture-2026-07-29.md in the vault):
//  - jobvite:     /apply renders a page headed "Data Consent" whose ONLY control is a select whose
//                 only real option is "Data Privacy Acknowledgement -- Global". Choosing it IS the
//                 act of acknowledging a privacy notice, which is the student's to make, not ours.
//                 Confirmed identical on two unrelated tenants, so it is the platform, not a
//                 customer's configuration.
//  - icims:       the apply route redirects to /login, which is an email field plus an
//                 h-captcha-response textarea. An account wall and a CAPTCHA, before any field.
//  - oraclecloud: the apply route lands on an "Authentication screen" that emails a one-time code,
//                 alongside a legal "I agree with the terms and conditions" checkbox. Litos cannot
//                 read the code and must not tick the checkbox.
//  - ultipro:     the board bootstraps through an AnonymousSessionCheck iframe and never rendered
//                 its job content to an automated browser at all, so the apply form was never
//                 reached. Nothing was captured, so per the standing rule nothing is guessed.
//
// Being in this set is NOT a claim the platform is unsupportable forever. It is a claim that today
// Litos can recognise the page and explain it, which is worth more to a job seeker than a fill that
// silently does nothing.
type AccountWalledFamily = 'jobvite' | 'icims' | 'oraclecloud' | 'ultipro' | 'sap_successfactors' | 'oracle_taleo' | 'adp_recruiting' | 'avature';

const ACCOUNT_WALLED_FAMILIES: ReadonlySet<PortalFamily> = new Set<PortalFamily>(
  ['jobvite', 'icims', 'oraclecloud', 'ultipro', 'sap_successfactors', 'oracle_taleo', 'adp_recruiting', 'avature'] satisfies AccountWalledFamily[],
);

export function isAccountWalledFamily(portal: SupportedPortal): boolean {
  return ACCOUNT_WALLED_FAMILIES.has(portalFamily(portal));
}

export function isManagedAttendedAccountPortal(portal: SupportedPortal): boolean {
  const family = portalFamily(portal);
  return family === 'jobvite' || family === 'icims' || family === 'oraclecloud';
}

export const ORACLE_CAPTURED_ATTENDED_GATE_URL =
  'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email';

/** Oracle attended preparation is limited to the one gate captured in a real browser. */
export function managedAttendedAccountUrlIsSupported(portal: SupportedPortal, rawUrl: string): boolean {
  const family = portalFamily(portal);
  if (family === 'jobvite' || family === 'icims') return true;
  return family === 'oraclecloud' && rawUrl === ORACLE_CAPTURED_ATTENDED_GATE_URL;
}

const JOBVITE_DATA_CONSENT_SELECTOR = 'select#jv-country-select';
const ICIMS_LOGIN_EMAIL_SELECTOR = 'input#email[name="css_loginName"]';
const ICIMS_HCAPTCHA_SELECTOR = 'textarea[name="h-captcha-response"]';
/* Not iCIMS-only despite the constant's original name-until-2026-08-20: readReceipt below reuses
   it verbatim to recognise an emailed-security-code wall on the direct-Playwright path, and the
   controlled_test QA fixture's own code field (autoComplete="one-time-code") matches it the same
   way a real iCIMS or Greenhouse one does. One selector, not two that can drift apart. */
const SECURITY_CODE_FIELD_SELECTOR =
  'input[autocomplete="one-time-code"], input[name*="verification" i], input[name*="securityCode" i]';
const ORACLE_PRIMARY_EMAIL_SELECTOR = 'input#primary-email-1[name="primary-email"]';
const ORACLE_LEGAL_DISCLAIMER_SELECTOR = 'input#legal-disclaimer-checkbox';
const ORACLE_HONEYPOT_SELECTOR = 'input#honey-pot-0[name="honey-pot"]';
const ORACLE_HCAPTCHA_SELECTOR = 'textarea[name="h-captcha-response"]';

/**
 * Read only the exact controls captured on the three account-gated portals. These actions never
 * type identity, choose privacy terms, solve a CAPTCHA, request a code, or submit a form.
 */
export function buildManagedAttendedAccountProbeActions(portal: SupportedPortal): ManagedBrowserAction[] {
  const family = portalFamily(portal);
  if (family === 'jobvite') {
    return [{
      type: 'extract',
      selector: JOBVITE_DATA_CONSENT_SELECTOR,
      attribute: 'id',
      label: 'jobvite_data_consent_gate',
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    }];
  }
  if (family === 'icims') {
    return [
      {
        type: 'extract',
        selector: ICIMS_LOGIN_EMAIL_SELECTOR,
        attribute: 'name',
        label: 'icims_account_login_gate',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      },
      {
        type: 'extract',
        selector: ICIMS_HCAPTCHA_SELECTOR,
        attribute: 'name',
        label: 'icims_hcaptcha_gate',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      },
      {
        type: 'extract',
        selector: SECURITY_CODE_FIELD_SELECTOR,
        attribute: 'name',
        label: 'icims_security_code_gate',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      },
    ];
  }
  if (family === 'oraclecloud') {
    return [
      {
        type: 'extract',
        selector: ORACLE_PRIMARY_EMAIL_SELECTOR,
        attribute: 'name',
        label: 'oracle_primary_email_gate',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      },
      {
        type: 'extract',
        selector: ORACLE_LEGAL_DISCLAIMER_SELECTOR,
        attribute: 'id',
        label: 'oracle_legal_disclaimer_gate',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      },
      {
        type: 'extract',
        selector: ORACLE_HONEYPOT_SELECTOR,
        attribute: 'name',
        label: 'oracle_honeypot_marker',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      },
      {
        type: 'extract',
        selector: ORACLE_HCAPTCHA_SELECTOR,
        attribute: 'name',
        label: 'oracle_hcaptcha_gate',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      },
    ];
  }
  return [];
}

export type ManagedAttendedAccountHold = {
  kind: 'privacy_consent' | 'account_login' | 'security_code';
  reason: string;
  categories: Array<'privacy_consent' | 'account_login' | 'security_code' | 'captcha'>;
  captchaProvider?: 'hcaptcha';
};

function managedExtractMatches(
  result: ManagedBrowserResult | null | undefined,
  label: string,
  expected: string,
): boolean {
  return (result?.extracted ?? []).some((item) => item.label === label && item.value === expected);
}

/** Classify only a measured gate on the exact supported portal route. Missing evidence is unknown. */
export function managedAttendedAccountHold(
  portal: SupportedPortal,
  frozenUrl: string,
  result: ManagedBrowserResult | null | undefined,
): ManagedAttendedAccountHold | null {
  if (!result?.url || !isManagedAttendedAccountPortal(portal)
    || !managedAttendedAccountUrlIsSupported(portal, frozenUrl)) return null;
  let observed: SupportedPortal;
  try {
    observed = detectPortal(result.url);
  } catch {
    return null;
  }
  if (portalFamily(observed) !== portalFamily(portal)) return null;
  const frozenCanonical = canonicalSupportedPortalUrl(frozenUrl, portal);
  const observedCanonical = canonicalSupportedPortalUrl(result.url, observed);
  if (!frozenCanonical || !observedCanonical || frozenCanonical !== observedCanonical) return null;

  const family = portalFamily(portal);
  if (family === 'jobvite') {
    if (!managedExtractMatches(result, 'jobvite_data_consent_gate', 'jv-country-select')) return null;
    return {
      kind: 'privacy_consent',
      reason: ACCOUNT_WALLED_REASONS.jobvite,
      categories: ['privacy_consent'],
    };
  }

  if (family === 'oraclecloud') {
    if (result.url !== ORACLE_CAPTURED_ATTENDED_GATE_URL) return null;
    const email = managedExtractMatches(result, 'oracle_primary_email_gate', 'primary-email');
    const legal = managedExtractMatches(result, 'oracle_legal_disclaimer_gate', 'legal-disclaimer-checkbox');
    const honeypot = managedExtractMatches(result, 'oracle_honeypot_marker', 'honey-pot');
    if (!email || !legal || !honeypot) return null;
    const hcaptcha = managedExtractMatches(result, 'oracle_hcaptcha_gate', 'h-captcha-response');
    return {
      kind: 'account_login',
      reason: ORACLE_ATTENDED_GATE_REASON,
      categories: ['account_login', 'privacy_consent', ...(hcaptcha ? ['captcha' as const] : [])],
      ...(hcaptcha ? { captchaProvider: 'hcaptcha' as const } : {}),
    };
  }

  const securityCode = result.humanVerification?.kind === 'security_code'
    || managedExtractMatches(result, 'icims_security_code_gate', 'verificationCode')
    || managedExtractMatches(result, 'icims_security_code_gate', 'securityCode');
  if (securityCode) {
    return {
      kind: 'security_code',
      reason: ICIMS_SECURITY_CODE_GATE_REASON,
      categories: ['security_code', 'account_login'],
    };
  }
  const login = managedExtractMatches(result, 'icims_account_login_gate', 'css_loginName');
  const hcaptcha = managedExtractMatches(result, 'icims_hcaptcha_gate', 'h-captcha-response');
  if (!login || !hcaptcha) return null;
  return {
    kind: 'account_login',
    reason: ACCOUNT_WALLED_REASONS.icims,
    categories: ['account_login', 'captcha'],
    captchaProvider: 'hcaptcha',
  };
}

export function isCaptchaGatedFamily(portal: SupportedPortal): boolean {
  return CAPTCHA_GATED_FAMILIES.has(portalFamily(portal));
}

// Only for the paths that stop WITHOUT a live Page, where the provider cannot be observed. Both
// values are measured, not assumed: JazzHR carries g-recaptcha-response on every application form
// (confirmed 2026-07-28) and BambooHR does too, with window.grecaptcha defined and the badge
// rendering, on a real PRC-Saltillo posting (confirmed 2026-07-29). Anything else returns 'unknown'
// rather than a guess - a wrong provider label is worse than an absent one, because the whole point
// of recording it is to decide which families are worth building around.
export function captchaProviderForFamily(portal: SupportedPortal): CaptchaProvider {
  return isCaptchaGatedFamily(portal) ? 'recaptcha_v2' : 'unknown';
}

export function portalCanAutoSubmit(portal: SupportedPortal): boolean {
  if (portal === 'manual_recruitee') return false;
  const family = portalFamily(portal);
  if (['zoho_recruit', 'bullhorn', 'sap_successfactors', 'oracle_taleo', 'adp_recruiting', 'jazzhr'].includes(family)) {
    return browserApplicationCapability(family).programmaticSubmit;
  }
  return !MULTI_STEP_FAMILIES.has(family)
    && !CAPTCHA_GATED_FAMILIES.has(family)
    && !CONSENT_GATED_FAMILIES.has(family)
    && !MANUAL_FINAL_REVIEW_FAMILIES.has(family)
    && !ACCOUNT_WALLED_FAMILIES.has(family);
}

/**
 * The applicant's standing consent-acceptance permission, exactly as the profile loader derives it:
 * present only when the grant is enabled, carries the CURRENT consent version, and has passed the
 * grantedAnswerReplay runner-trust gate. Absent covers never-granted, revoked, stale-version, an
 * unmigrated database, and a runner that cannot yet be trusted to hit the control it was asked
 * about - all five read as "no grant" here, which is today's behaviour.
 */
export type PortalConsentGrant = { granted_at?: string; version: string };

/**
 * PER-ACCOUNT autonomy: whether THIS applicant's run may press submit on this portal.
 *
 * portalCanAutoSubmit above stays the account-independent floor (the jobs board, polling and the
 * coverage sentences read it with no user in hand). This adds the one conditional case: a family
 * whose only bar is a routine consent control beside submit, for an account whose standing
 * consent-acceptance permission is granted and current. The grant lifts EXACTLY that one gate;
 * every other deny set is re-checked here so a family later discovered to be multi-step,
 * CAPTCHA-gated or account-walled does not get unlocked by a permission that says nothing about
 * those. With no grant the answer is portalCanAutoSubmit's, byte for byte.
 */
export function portalCanAutoSubmitWithConsentGrant(
  portal: SupportedPortal,
  grant: PortalConsentGrant | null | undefined,
): boolean {
  if (portalCanAutoSubmit(portal)) return true;
  if (!grant) return false;
  if (portal === 'manual_recruitee') return false;
  const family = portalFamily(portal);
  if (!CONSENT_GRANT_CONDITIONAL_FAMILIES.has(family)) return false;
  return !MULTI_STEP_FAMILIES.has(family)
    && !CAPTCHA_GATED_FAMILIES.has(family)
    && !ACCOUNT_WALLED_FAMILIES.has(family);
}

export type ManagedPortalReceiptCapability = 'confirmation_possible' | 'unavailable_before_handoff';

/**
 * Whether the unattended backend path can honestly attempt to read an employer confirmation.
 *
 * This is deliberately derived from the same deny lists as submission. SmartRecruiters stops on
 * its multi-step flow, while Jobvite and iCIMS stop before the application form opens. None of the
 * three can produce a backend receipt because the backend is forbidden from performing the action
 * that could create one. A later attended browser confirmation is a different channel.
 *
 * Takes the account's consent grant for the same reason submission does: a teamtailor or pinpoint
 * run that was allowed to press submit under the grant can read the confirmation that press
 * produced. Defaulted to null so every existing caller keeps the account-independent answer.
 */
export function managedPortalReceiptCapability(
  portal: SupportedPortal,
  grant: PortalConsentGrant | null = null,
): ManagedPortalReceiptCapability {
  return portalCanAutoSubmitWithConsentGrant(portal, grant) ? 'confirmation_possible' : 'unavailable_before_handoff';
}

/* The families whose submit capability is decided by the researched capability table rather than by
 * the deny sets above. portalCanAutoSubmit branches to browserApplicationCapability for exactly
 * these, and the table denies programmaticSubmit on every one of them today.
 *
 * They have to be subtracted here or the type disagrees with the function. zoho_recruit and bullhorn
 * are in no deny set, so before this line AutonomousPortalFamily claimed both were autonomous while
 * portalCanAutoSubmit answered false for both, and the array below could not be complete. If the
 * table ever grants one of them programmaticSubmit, the two answers part company in the other
 * direction and portalSupportInvariants.test.ts is what says so. */
type CapabilityReviewedFamily = Extract<PortalFamily, BrowserApplicationFamily>;

// The portal families Litos can carry all the way to a confirmation on its own.
//
// Subtracted from PortalFamily rather than hand-listed, so a portal that later turns out to be
// multi-step or CAPTCHA-gated leaves this type the moment it is added to either set above.
//
// The TYPE is subtracted; the VALUE below is still hand-listed, and `satisfies` proves only that
// every entry belongs, never that every member is present. The completeness half is asserted in
// portalSupportInvariants.test.ts, which is what makes "no second list to remember to update" true
// rather than merely intended: a family that lands in none of the sets above joins this type, and if
// nobody adds it to the array that test stops compiling.
//
// This is what the jobs board is allowed to source from. Surfacing a posting Litos cannot finish is
// worse than not surfacing it at all: the student picks it, tailors a resume to it, and only then
// discovers the last step needs her anyway. Fewer jobs that all work beats more jobs that mostly do.
export type AutonomousPortalFamily = Exclude<
  PortalFamily,
  MultiStepFamily
  | CaptchaGatedFamily
  | ConsentGatedFamily
  | ManualFinalReviewFamily
  | AccountWalledFamily
  | CapabilityReviewedFamily
>;

export const AUTONOMOUS_PORTAL_FAMILIES = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  // Added 2026-07-29 from live capture. Both are single-step, CAPTCHA-free forms with a real submit
  // button, which is the whole bar for this list. They were the only two of the seven platforms
  // looked at that session that cleared it - the other five each stop on a CAPTCHA, a consent
  // choice, or an account wall.
  'rippling',
  'breezy',
  // Recruitee is a single-page form. Its optional invisible hCaptcha is handled by the shared
  // pre-submit challenge probe, and any tenant agreement remains an empty required-field blocker.
  'recruitee',
] as const satisfies readonly AutonomousPortalFamily[];

export function isAutonomousPortalFamily(value: string): value is AutonomousPortalFamily {
  return (AUTONOMOUS_PORTAL_FAMILIES as readonly string[]).includes(value);
}

// Why a run stopped short of submitting, in the student's words. Surfaced on the blocker card so
// "needs attention" reads as a known platform limit rather than an unexplained failure.
// The four account-walled platforms stop for four different reasons, and a job seeker who is told
// "this one needs you" deserves to know which one so she knows what she is about to face. One shared
// sentence would have been less code and less use.
export const JOBVITE_ATTENDED_GATE_REASON =
  'This company asks you to agree to their privacy notice before the application form opens. That choice is yours to make, so Litos stops here. Open the page and pick your country, and the form appears.';
export const ICIMS_ATTENDED_GATE_REASON =
  'This company asks you to make an account and prove you are human before the application form opens. Litos cannot do either of those for you, so this one needs your hands.';
export const ICIMS_SECURITY_CODE_GATE_REASON =
  'This iCIMS account page is waiting for a security code sent to the stored Litos application email. Litos did not enter the code or submit the application. Open the page and finish the account check in Chrome.';
export const BAMBOOHR_ATTENDED_GATE_REASON =
  'This company’s application page asks you to prove you are human. Litos filled everything in, so all that is left is that check and the send button.';
export const ORACLE_ATTENDED_GATE_REASON =
  'This Oracle application asks for an emailed code and a legal terms choice before the application form opens. Litos did not request the code, accept the terms, or submit anything. Open the exact saved page in Chrome and complete those steps yourself.';
export const UKG_CAPTURE_REQUIRED_REASON =
  'This UKG application did not expose a verified job or application form beyond its anonymous-session frame. Litos did not enter information or submit anything. A new live capture is required before this portal can be continued safely.';
export const SAP_SUCCESSFACTORS_CAPTURE_REQUIRED_REASON =
  'This SuccessFactors application stops at an account wall, and Litos has not captured a verified application form or receipt for this tenant. Litos did not sign in, create an account, accept anything, or submit. A new live capture is required before this portal can be continued safely.';

const ACCOUNT_WALLED_REASONS: Record<AccountWalledFamily, string> = {
  jobvite: JOBVITE_ATTENDED_GATE_REASON,
  icims: ICIMS_ATTENDED_GATE_REASON,
  oraclecloud: ORACLE_ATTENDED_GATE_REASON,
  ultipro: UKG_CAPTURE_REQUIRED_REASON,
  sap_successfactors: SAP_SUCCESSFACTORS_CAPTURE_REQUIRED_REASON,
  oracle_taleo:
    'This Taleo application asks you to accept the employer legal notice before any application fields open. Litos leaves that decision and the later account flow to you.',
  adp_recruiting:
    'This ADP Recruiting application requires an account before any application fields open. Litos leaves the account and every later legal choice to you.',
  avature:
    'This company routes the application through an Avature login or tenant-specific resume intake. Litos leaves that account and every later choice to you.',
};

export function portalHandoffReason(portal: SupportedPortal): string | null {
  const family = portalFamily(portal);
  if (portal === 'manual_recruitee') {
    return 'Litos filled this Recruitee application, but this tenant uses an inline form whose final controls have not been validated for automatic submission. Review the form and send it yourself.';
  }
  // Checked FIRST. An account-walled portal never reached a form, so telling the student "Litos
  // filled everything in" (which both sentences below do) would be a plain lie about work that
  // never happened, and she would go looking for filled fields that are not there.
  if (ACCOUNT_WALLED_FAMILIES.has(family)) {
    return ACCOUNT_WALLED_REASONS[family as AccountWalledFamily];
  }
  if (CAPTCHA_GATED_FAMILIES.has(family)) {
    return 'This company’s application page asks you to prove you are human. Litos filled everything in, so all that is left is that check and the send button.';
  }
  if (CONSENT_GATED_FAMILIES.has(family)) {
    return 'This company asks you to confirm its applicant privacy terms before sending. Litos filled the form but left that choice and the send button to you.';
  }
  if (MULTI_STEP_FAMILIES.has(family)) {
    return 'Litos filled in this application and stopped on the last page. That page asks you to confirm the details are true, and it can ask about your background and your right to work, so those answers need to be yours.';
  }
  if (family === 'personio') {
    return 'Litos filled this Personio application, but Personio does not expose every required field to the final safety check. Review the form and send it yourself.';
  }
  if (family === 'pinpoint') {
    return 'Litos filled this Pinpoint application and left the privacy-processing choice for you. Review the notice, make your choice, and send it yourself.';
  }
  if (family === 'zoho_recruit') {
    return 'Litos filled the public Zoho Recruit form but left every privacy, retention, race and gender question, statement you must swear to, CAPTCHA and send control to you.';
  }
  if (family === 'bullhorn') {
    return 'Litos filled the Bullhorn form but left every legal choice and the send button to you because each company can customize this portal.';
  }
  return null;
}

// What to say when an UNATTENDED run left this application alone.
//
// portalHandoffReason above cannot be reused here, and the reason is the one its own first comment
// gives: both of its sentences promise "Litos filled everything in". On the unattended path nothing
// was filled, because the run stopped before it opened a browser. Telling someone their application
// is filled and waiting on one click, when the form is still blank, sends them to a page that does
// not match what they were told and costs them the trust to believe the next message.
export function unattendedHandoffReason(portal: SupportedPortal): string | null {
  const family = portalFamily(portal);
  if (portal === 'manual_recruitee') {
    return 'This Recruitee tenant uses an inline application whose final controls need review. Open it when you have a minute and Litos will fill it in for you.';
  }
  if (ACCOUNT_WALLED_FAMILIES.has(family)) {
    return ACCOUNT_WALLED_REASONS[family as AccountWalledFamily];
  }
  if (CAPTCHA_GATED_FAMILIES.has(family)) {
    return 'This company asks you to prove you are human before it will take an application, so Litos cannot send this one while you are away. Open it when you have a minute and Litos will fill it in for you.';
  }
  if (CONSENT_GATED_FAMILIES.has(family)) {
    return 'This company asks you to confirm its applicant privacy terms before it will take the application, so Litos cannot send this one while you are away. Open it when you have a minute and Litos will fill it in for you.';
  }
  if (MULTI_STEP_FAMILIES.has(family)) {
    return 'This company asks its questions over several pages, and the last one needs answers only you can give. Litos cannot send this one while you are away. Open it when you have a minute and Litos will fill it in for you.';
  }
  if (MANUAL_FINAL_REVIEW_FAMILIES.has(family)) {
    return 'This company requires a final review on its application page, so Litos cannot send this one while you are away. Open it when you have a minute and Litos will fill it in for you.';
  }
  if (family === 'zoho_recruit' || family === 'bullhorn') {
    return 'This company uses a customizable application form whose final legal controls need you, so Litos cannot send it while you are away. Open it and Litos will fill the factual fields.';
  }
  return null;
}

export type AutofillApplicantSnapshot = {
  profile: {
    full_name?: string;
    email?: string;
    experience: Array<{
      company: string;
      title: string;
      start: string;
      end: string;
      description: string;
    }>;
    skills: string[];
    projects?: Array<{ name: string; description: string }>;
    school: string;
    degree?: string;
    grad_date?: string;
    grad_year: number;
    currently_enrolled?: boolean;
    coursework?: string[];
    target_roles?: string[];
    voice_pref?: string;
  };
  application_profile: ApplicationProfileLike;
};

export type SubmissionPacket = {
  fullName: string;
  email: string;
  /* WHY `email` is what it is. Metadata for the review state, never filled into a form.
   *
   * Litos prefers a per-application alias so employer replies come back through the product, but
   * an alias is only used when its domain has been measured able to receive mail. When it has not,
   * `email` is the applicant's real address and this says so, which is what stops the dashboard
   * telling her replies are being tracked when they are not. Optional because packets built by
   * tests and fixtures do not carry it. */
  applicantEmail?: {
    address: string;
    source: 'litos_alias' | 'contact_email' | 'account_email';
    reason: string;
    tracked: boolean;
    decided_at: string;
  };
  phone?: string;
  city?: string;
  country?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  portfolioUrl?: string;
  school?: string;
  degree?: string;
  graduationDate?: string;
  graduationMonth?: string;
  graduationYear?: string;
  currentlyEnrolled?: boolean;
  gpa?: string;
  major?: string;
  roleLocation?: string;
  roleLocations?: string[];
  roleCountry?: JobCountry;
  roleCountryCode?: string;
  referralSourceDefault?: string;
  referralSourceEvidence?: ReferralSourceEvidence;
  /**
   * The REAL option texts of the closed-list controls on this posting, keyed by the control's own
   * id, as read off the live page by the discovery pass (pushManagedReactSelectOptionProbeActions).
   *
   * Absent when the page was never probed, which is not the same as "the control has no options":
   * every consumer here must fall back to its alias ladder rather than treat an unprobed control as
   * free text.
   */
  fieldOptions?: Record<string, string[]>;
  /** Closed controls whose live option evidence failed. No action builder may guess at these. */
  failedFields?: Array<{
    controlId: string;
    label: string;
    selector?: string;
    inputType?: string;
  }>;
  applicationProfile?: ApplicationProfileLike;
  /** Exact applicant facts frozen with the prepared packet for attended clients. */
  applicantSnapshot?: AutofillApplicantSnapshot;
  /* WHO THIS PACKET APPLIES TO, the job_context company copied on by buildPacket. Metadata, never
   * typed into a form. It exists because a tenant's consent wording can embed the employer's own
   * name mid-sentence (Teamtailor's platform default: "confirm that Fully store my personal
   * details..."), and the consent grammar's coverage accounting absorbs exactly the one proper
   * noun the caller can prove belongs there. jdText below is the raw posting prose and does not
   * carry the frozen employer line the resolver's composed context does, so without this the
   * fill-time licence re-derivation held every such sentence. Absent means no name is accounted
   * for and the label holds, which is the fail-closed direction. */
  employerName?: string;
  jdText?: string;
  resume: Buffer;
  resumeName: string;
  coverLetter?: Buffer;
  coverLetterName?: string;
  /* A file the student attached to this application herself, decrypted for the fill. One carrier
   * for all three delivery paths - Playwright setInputFiles, the managed sandbox's base64 upload,
   * and the ATS API multipart - so a document added here reaches every one of them at once rather
   * than the one the author happened to be looking at.
   *
   * Both fields or neither. uploadFirst and managedUpload each return early unless the file AND the
   * name are truthy, which is what makes an application with no transcript a no-op instead of a
   * half-populated packet that spends an action on an empty upload. */
  transcript?: Buffer;
  transcriptName?: string;
  /* Why the attached transcript is not on this packet, when the application says one is attached.
   *
   * Metadata, not a fill field, the same way applicantEmail above is. Removing a document deletes
   * its blob and tombstones the row, and it deliberately does NOT rewrite the spec of every
   * application that already carried it, so a student who tidies her library leaves live pointers at
   * a file that is gone. buildPacket records that here instead of throwing, because it is called
   * bare at nine sites and only two of them catch anything: a dead pointer must not be able to abort
   * a fully filled application. The run turns this into one fixed sentence for her and logs the
   * detail. */
  transcriptUnavailableReason?: string;
  eeoPrefs?: Record<string, string> | null;
  // The single most recent role from the parsed resume, for portals that ask for work history as
  // structured fields rather than accepting the resume file alone (Paylocity's step one). Only one
  // entry, deliberately: portals render additional rows behind an "Add" button, and creating rows
  // Litos may not be able to complete leaves the form messier than one clean entry the student
  // extends herself. Optional throughout - a profile with no parsed experience simply skips these.
  mostRecentRole?: {
    company: string;
    title: string;
    summary?: string;
    startDate?: string;
    endDate?: string;
  };
  questions: Array<{
    question: string;
    answer: string;
    /**
     * Whether the FORM marks this control required, copied from the question record. Read by the
     * budget trim: a question explicitly marked optional gives up its fill chains before anything
     * required loses its only attempt. Absent means unknown, and unknown is treated as required.
     */
    required?: boolean;
    portalSelector?: string;
    portalInputType?: string;
    portal_selector?: string;
    portal_input_type?: string;
    atsApiField?: string;
    /**
     * The profile value `answer` was snapped from, when discovery read this control's options and
     * resolveProfileField picked one. Copied from the question record's answer_option_source.
     *
     * Absent means "cannot prove this answer is current", which is the reading a hand-built packet,
     * a record written before the field existed, and a free-text answer all get. Every consumer
     * treats absence as a reason to recompute rather than to trust.
     */
    answerOptionSource?: string;
    /**
     * Set when the APPLICANT wrote this answer through the review, copied from the question record's
     * answer_source.
     *
     * It exists because absence of `answerOptionSource` above means two different things, and the
     * fill was reading only one of them. A machine answer with no option evidence genuinely cannot
     * be proven current, so recomputing a bucket ahead of it is right. An answer she chose herself
     * has no option evidence either, and recomputing over it silently discards the choice.
     */
    answerSource?: string;
  }>;
};

export type FillResult = {
  filledFields: string[];
  blockers: string[];
};

const KNOWN_DIAL_CODES = [
  '1',
  '7',
  '20',
  '27',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '52',
  '54',
  '55',
  '61',
  '64',
  '65',
  '81',
  '82',
  '86',
  '90',
  '91',
  '92',
  '971',
] as const;

function nationalPhoneForCountryCodeField(phone: string | undefined): string | undefined {
  if (!phone) return phone;
  const trimmed = phone.trim();
  if (!trimmed.startsWith('+')) return phone;
  const digits = trimmed.replace(/\D/g, '');
  const dialCode = KNOWN_DIAL_CODES
    .filter((code) => digits.startsWith(code))
    .sort((a, b) => b.length - a.length)[0];
  if (!dialCode) return phone;
  const national = digits.slice(dialCode.length);
  return national || phone;
}

const DIAL_CODE_COUNTRY_LABELS: Record<string, string> = {
  '1': 'United States',
  '7': 'Russia',
  '20': 'Egypt',
  '27': 'South Africa',
  '30': 'Greece',
  '31': 'Netherlands',
  '32': 'Belgium',
  '33': 'France',
  '34': 'Spain',
  '36': 'Hungary',
  '39': 'Italy',
  '40': 'Romania',
  '41': 'Switzerland',
  '43': 'Austria',
  '44': 'United Kingdom',
  '45': 'Denmark',
  '46': 'Sweden',
  '47': 'Norway',
  '48': 'Poland',
  '49': 'Germany',
  '52': 'Mexico',
  '55': 'Brazil',
  '60': 'Malaysia',
  '61': 'Australia',
  '62': 'Indonesia',
  '63': 'Philippines',
  '65': 'Singapore',
  '81': 'Japan',
  '82': 'South Korea',
  '86': 'China',
  '90': 'Turkey',
  '91': 'India',
  '92': 'Pakistan',
  '971': 'United Arab Emirates',
};

function countryForPhoneField(phone: string | undefined, fallbackCountry: string | undefined): string | undefined {
  if (!phone) return fallbackCountry;
  const digits = phone.trim().startsWith('+') ? phone.replace(/\D/g, '') : '';
  if (!digits) return fallbackCountry;
  const dialCode = Object.keys(DIAL_CODE_COUNTRY_LABELS)
    .filter((code) => digits.startsWith(code))
    .sort((a, b) => b.length - a.length)[0];
  return dialCode ? DIAL_CODE_COUNTRY_LABELS[dialCode] : fallbackCountry;
}

/* THE DIAL CODE THAT WAS WRITTEN TWICE.
 *
 * Cresta's live Greenhouse form showed "Phone number is too short" under "+971 567417451" while the
 * country control beside it already read +971, and the application could not be submitted. This
 * function stripped the dial code for Rippling and for nothing else, which was never the rule: it
 * was the one board where the rule had been noticed.
 *
 * The rule, stated generally: when the phone field has a SEPARATE control that is already showing
 * THIS number's own dial code, the field takes the national number and the dial code does not go in
 * it. Both halves are load-bearing, and the second half is the whole guard against the mirror-image
 * defect. A number written without its country onto a form that carries no country anywhere is
 * worse than one a validator rejects out loud, because it produces a phone number the employer
 * cannot dial and nothing on the page says so. So: no control, a control showing a different
 * country, or a control showing no dial code at all, and the full international number goes in
 * unchanged.
 *
 * `dialCodesOnForm` is what the field's own group was MEASURED to be showing, never what the board
 * is assumed to render. The DOM read that produces it is READ_FIELD_GROUP_DIAL_CODES_SCRIPT, used
 * by fillPhoneField on the direct path and reimplemented as `separateDialCodesFor` inside the
 * managed runner, which is a standalone script and cannot import this module. Passing it as an
 * argument is what keeps the DECISION in one place and testable without a browser.
 *
 * Rippling keeps a fallback rather than the rule: buildManagedPortalActions has no live DOM, so on
 * that path there is no page to ask, and Rippling's widget was measured to carry its own country
 * selector.
 */
export function phoneForPortalField(
  portal: SupportedPortal,
  phone: string | undefined,
  dialCodesOnForm?: string[],
): string | undefined {
  if (dialCodesOnForm && dialCodesOnForm.length > 0) {
    const trimmed = (phone ?? '').trim();
    // No leading '+' means there is no dial code in the field to remove and no claim to act on.
    const digits = trimmed.startsWith('+') ? trimmed.replace(/\D/g, '') : '';
    const dialCode = dialCodesOnForm
      .map((code) => code.replace(/\D/g, ''))
      // `digits.length > code.length` and not `>=`: a value that is nothing BUT its dial code would
      // otherwise be stripped to an empty field, which is a worse answer than an odd one.
      .filter((code) => code.length > 0 && digits.length > code.length && digits.startsWith(code))
      // Longest first, so a control offering both '+1' and '+971' never lets '+1' eat the longer code.
      .sort((a, b) => b.length - a.length)[0];
    if (dialCode) return digits.slice(dialCode.length);
    // Read literally: the number does not start with any code this form is showing, so nothing about
    // it has been written twice and removing digits would corrupt a number that is currently
    // correct. A wrong country selection is the applicant's to see and fix; a truncated number
    // would hide it.
    return phone;
  }
  if (portalFamily(portal) === 'rippling') {
    return nationalPhoneForCountryCodeField(phone);
  }
  return phone;
}

/* WHAT THE FIELD'S OWN GROUP IS SHOWING, asked of the page rather than assumed from the board.
 *
 * Returns every dial code visible on a country-shaped control that shares this phone field's
 * nearest group. Narrow on purpose, in three ways, because every one of them is a way the
 * mirror-image defect could get in:
 *
 *   1. The element has to look like a phone field at all. A broad match would let this rewrite an
 *      unrelated numeric answer that happened to sit beside something with a plus sign in it.
 *   2. Only a dial code counts, spelled as a dial code ("+971"). A control showing the country NAME
 *      alone is not read as one - Greenhouse's classic '#country' combobox holds "United Arab
 *      Emirates" and no employer's validator objects to the full number beside it.
 *   3. The walk stops at the field's own group, and never crosses a form, section or body boundary.
 *      A dial code found past that is some other field's country.
 *
 * KEPT AS TEXT, like READ_SUBMIT_READINESS_SCRIPT, and for a measured reason rather than a stylistic
 * one. Playwright ships a callback to the browser by calling toString() on it, so whatever the
 * compiler left in the source goes to the page. Written as an ordinary TypeScript callback and run
 * under tsx, esbuild's keepNames wraps every named inner arrow in a `__name(...)` call that exists
 * only in the bundle, and the page throws `ReferenceError: __name is not defined`. The throw was
 * swallowed by the caller's catch, every form came back as a form with no country control, and the
 * fix looked like it had simply not worked. Measured 2026-08-09 against the portal-shapes trial.
 * Text is untouchable by a bundler, which is the property this needs.
 */
const READ_FIELD_GROUP_DIAL_CODES_SCRIPT = String.raw`(element) => {
  const attr = (name) => element.getAttribute(name) || '';
  const type = attr('type').toLowerCase();
  const hint = (
    attr('name') + ' ' + attr('id') + ' ' + attr('aria-label') + ' '
    + attr('placeholder') + ' ' + attr('autocomplete')
  ).toLowerCase();
  if (type !== 'tel' && !/phone|mobile|(^|[^a-z])tel([^a-z]|$)/.test(hint)) return [];
  const dialCodesIn = (control) => {
    if (control === element || control.contains(element) || element.contains(control)) return [];
    let text = '';
    if (control.tagName === 'SELECT') {
      const selected = control.selectedOptions && control.selectedOptions[0];
      text = String(control.value || '') + ' ' + (selected ? String(selected.textContent || '') : '');
    } else {
      text = String(control.getAttribute('aria-label') || '') + ' '
        + String(control.value || '') + ' ' + String(control.textContent || '');
    }
    const found = [];
    const pattern = /\+\s?(\d{1,4})/g;
    let match = pattern.exec(text);
    while (match) { found.push(match[1]); match = pattern.exec(text); }
    return found;
  };
  let node = element.parentElement;
  for (
    let depth = 0;
    node && depth < 4 && !/^(?:BODY|FORM|MAIN|SECTION|ARTICLE|HTML)$/.test(node.tagName);
    depth += 1
  ) {
    const found = [];
    const controls = node.querySelectorAll(
      'select, [class*="select__single-value"], [class*="PhoneInputCountry"], [class*="iti__selected"], [role="combobox"], button'
    );
    for (let i = 0; i < controls.length; i += 1) {
      const codes = dialCodesIn(controls[i]);
      for (let j = 0; j < codes.length; j += 1) found.push(codes[j]);
    }
    // First group outwards that holds a dial code wins. Walking on past it is how an unrelated
    // number elsewhere on the page gets read as this field's country.
    if (found.length > 0) return found;
    node = node.parentElement;
  }
  return [];
}`;

/* Playwright types its evaluate target as `SVGElement | HTMLElement`, which are DOM globals.
 * `tsconfig.json` sets `"lib": ["ES2022"]` with no DOM, so those names resolve only because a
 * `.test.ts` file drags them in. `tsconfig.build.json` excludes tests, so the PRODUCTION build has
 * been failing on `origin/main` with TS2304 while `npm run typecheck` passed: the emitting build
 * and the checking build disagreed, and only the one nobody reads was right.
 *
 * Declared locally rather than adding "dom" to lib, because this is a Node service and exposing
 * `document` and `window` as globals to server code invites the opposite class of bug. `object` is
 * deliberately the widest useful shape: an element satisfies it, nothing on this side can
 * dereference it, and the real element type only exists inside the browser where the body runs. */
type PlaywrightEvaluationTarget = object;

/* Locator.evaluate hands a STRING to the page as an expression and returns whatever it evaluates
 * to, which for a function-shaped string is the function object itself: it is never called, and the
 * result is undefined. page.evaluate(string, elementHandle) does the same. So the text above is
 * wrapped back into a real function here, once, at module scope. new Function compiles it in Node
 * with no bundler in the path, and Playwright then serialises that function normally. */
const readFieldGroupDialCodes = new Function(
  'element',
  'return (' + READ_FIELD_GROUP_DIAL_CODES_SCRIPT + ')(element);',
) as (element: PlaywrightEvaluationTarget) => string[];

function greenhouseLocationSearch(packet: SubmissionPacket): string | undefined {
  if (!packet.city) return undefined;
  if (!packet.country) return packet.city;
  const city = packet.city.trim();
  const country = packet.country.trim();
  if (!city || !country || city.toLowerCase().includes(country.toLowerCase())) return city;
  return `${city}, ${country}`;
}

function receiptReference(body: string): string | undefined {
  return body.match(/(?:confirmation|reference)(?:\s*(?:id|number))?\s*[:#]\s*([A-Z0-9-]{5,})/i)?.[1]
    ?? body.match(/application\s*(?:id|number|#)\s*[:#]?\s*([A-Z0-9-]{5,})/i)?.[1];
}

const RECEIPT_PROOF_RE = /thank you|thanks for your application|application (?:has been )?(?:submitted|received)|we received your application|your application has been successfully submitted|all done![\s\S]{0,160}application|success/i;

// Bounded auto-wait for every managed action. Playwright defaults to 30s, so a single selector
// that never matches (e.g. a Greenhouse posting proxied through a branded domain whose form does
// not use the classic `job_application[...]` field names) used to burn the full 30s per action and
// take the run's whole time budget with it. Capping the wait degrades a missed selector to a fast
// blocker card instead of a hard timeout. Present fields still fill immediately; this only bites
// when the selector is genuinely wrong. Applied by default to every managedFill/managedUpload and
// to the reviewed-question fills, so no one action can ever spend 30s.
const MANAGED_FILL_TIMEOUT_MS = 10_000;

function managedFill(
  actions: ManagedBrowserAction[],
  selector: string,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({ type: 'fill', selector, value, label, optional, timeout });
}

function managedFillByLabel(
  actions: ManagedBrowserAction[],
  text: string,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({ type: 'fillByLabelText', text, value, label, optional, timeout });
}

/* AN ASHBY FIELD HANDLE NAMES THE WRAPPER, NOT THE CONTROL.
 *
 * `data-field-path` sits on the `<div class="_fieldEntry_...">` around a question, and the input
 * inside it has neither an id nor a name - the DOM is written out in full above
 * ASHBY_LOCATION_SELECTOR, read off the live Deepgram form. So discovery reports
 * `[data-field-path="407cc864-..."]` as the field's durable identity, which is true and useful, and
 * a `fill` aimed at it targets a div and cannot type anything.
 *
 * Measured on the Deepgram packet of 2026-08-08: "Expected Graduation Year" was resolved, carried a
 * real answer, produced exactly one action - a fill against that div - and came back
 * required-and-empty. It got no label fallback either, because a present selector makes the
 * reviewed-question loop `continue` before pushAshbyQuestionTextFallbackActions is reached, so the
 * one attempt that could not work was also the only attempt.
 *
 * Descending is the same move ASHBY_LOCATION_SELECTOR already makes by hand for the one field
 * somebody noticed, generalised to every field the same attribute names. The wrapper is kept as the
 * last alternative rather than dropped: the runner takes the first match, and a board that ever put
 * the attribute on the control itself would still resolve.
 */
const ASHBY_FIELD_PATH_SELECTOR = /^\[data-field-path=(?:"[^"]*"|'[^']*'|[^\]]*)\]$/;

/** browserbase.ts refuses to send a longer selector than this, and drops the optional action. */
const MANAGED_SELECTOR_MAX_LENGTH = 500;

export function ashbyControlWithinFieldPath(selector: string): string {
  if (!ASHBY_FIELD_PATH_SELECTOR.test(selector)) return selector;
  const descended = [
    `${selector} input[role="combobox"]`,
    `${selector} input`,
    `${selector} textarea`,
    `${selector} select`,
    selector,
  ].join(', ');
  // The managed provider rejects a selector over MANAGED_SELECTOR_MAX_LENGTH outright, and an
  // over-long alternation would take the field from "filled by the wrong element" to "not sent at
  // all". A field path that long has never been observed; the guard is here so it cannot be the
  // thing that breaks if one ever is.
  return descended.length <= MANAGED_SELECTOR_MAX_LENGTH ? descended : selector;
}

function durablePortalSelector(selector: string | undefined): string | undefined {
  const trimmed = selector?.trim();
  if (!trimmed || trimmed.length > 500 || trimmed.startsWith('[data-litos-discovered-')) return undefined;
  return ashbyControlWithinFieldPath(trimmed);
}

function reviewQuestionPortalSelector(item: SubmissionPacket['questions'][number]): string | undefined {
  return item.portalSelector ?? item.portal_selector;
}

function reviewQuestionPortalInputType(item: SubmissionPacket['questions'][number]): string | undefined {
  return item.portalInputType ?? item.portal_input_type;
}

function managedComboboxFill(
  actions: ManagedBrowserAction[],
  selector: string,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({ type: 'fill', selector, value, label, optional, timeout });
  actions.push({ type: 'press', selector, value: 'Enter', label: `${label}_select`, optional, timeout });
}

function managedGreenhouseReactSelectFill(
  actions: ManagedBrowserAction[],
  inputId: string,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  const selector = `#${inputId}`;
  actions.push({
    type: 'click',
    selector,
    label: `${label}_open`,
    optional,
    timeout,
  });
  actions.push({ type: 'fill', selector, value, label, optional, timeout });
  // Enter FIRST, then the option click as the fallback. The click was the only selector here and it
  // never once landed: the runner tests an optional action's selector with `locator.count()`, which
  // does not auto-wait, and react-select has not re-rendered its filtered menu by the time that
  // snapshot is taken. Measured on the live Anduril posting: all four education option clicks came
  // back "MISSING" and every education field stayed empty, while `#country` on the same page was
  // selected correctly by managedComboboxFill, which uses exactly this Enter.
  //
  // Enter is dispatched as its own action, so the round trip that carries it is itself the settle
  // the click never had, and react-select consumes it against the focused option. Before the click
  // rather than after, so a successful selection is never followed by an Enter on a closed select.
  actions.push({ type: 'press', selector, value: 'Enter', label: `${label}_select`, optional, timeout });
  actions.push({
    type: 'click',
    selector: `#react-select-${inputId}-option-0`,
    label: `${label}_option`,
    optional,
    timeout,
  });
}

/* ─── reading a closed list's REAL options on the managed path ────────────────────────────────
 *
 * PR #361 shipped option snapping and it has never once fired in production, because the managed
 * provider's `discover` action reports only label/selector/inputType/maxLength: `options` is
 * undefined on every managed-discovered control, so chooseClosestOption is handed an empty list and
 * returns null. Measured on the Anduril Greenhouse run of 2026-08-08: "Discipline" came back
 * '"Discipline" is required and is still empty' while the packet held the answer.
 *
 * The provider cannot be asked for option lists, but it does not have to be. `extract` already
 * reads arbitrary DOM (that is how the CAPTCHA evidence reads work), and with no `attribute` it
 * returns the element's innerText. A react-select renders its whole option list into
 * `#react-select-<inputId>-listbox` once the control is open, so three actions per control (open,
 * extract the listbox, close) return the list as newline-separated text. Measured live against the
 * Anduril posting: 100 discipline options came back this way.
 *
 * These ids are Greenhouse's own and are identical on every Greenhouse board, so this is an
 * ATS-family read and not another per-employer selector list.
 */
export const GREENHOUSE_OPTION_PROBE_IDS = ['school--0', 'degree--0', 'discipline--0', 'end-month--0'] as const;

/** Prefix on the extract label that marks an option-list read, so the parser cannot confuse it. */
export const MANAGED_OPTION_EXTRACT_PREFIX = 'options:';

export function reactSelectListboxSelector(inputId: string): string {
  return `[id="react-select-${quoteAttr(inputId)}-listbox"]`;
}

function optionProbeIdForSelector(selector: string | undefined): string | undefined {
  // Matched on the SELECTOR as well as the label because the provider echoes `{selector, value}`
  // and drops `label` entirely (managed-browser.js), so the selector is the only key that is
  // guaranteed to come back.
  return selector?.match(/^\[id="react-select-(.+)-listbox"\]$/)?.[1]
    ?? selector?.match(/^\[id="([A-Za-z0-9][A-Za-z0-9_-]*)"\]:is\(select\)$/)?.[1];
}

/**
 * TWO ROUNDS, and the second one is the one that reads.
 *
 * School and End date month hold their options in the page and come back on the first open.
 * Degree and Discipline load theirs over the network when the menu opens, and the runner has no
 * wait primitive: every action is instantaneous, an optional `waitForSelector` is skipped by the
 * runner's own "missing selector" pre-check before it can wait for anything, and `click`'s
 * networkidle wait returns immediately because the fetch has not started yet. Measured: the first
 * open reads back the literal text "Loading...".
 *
 * The second open reads the real list, because the first one warmed the fetch. Measured on the same
 * posting: round one "Loading...", round two 100 discipline options. So round one exists to make
 * round two work, and it is placed early while round two comes after the `discover` action, which
 * walks the whole DOM and is the longest-running thing in the list.
 *
 * A round that comes back "Loading..." contributes nothing (see managedResultFieldOptions), so the
 * worst case is the behaviour that existed before any of this: no option list, and the alias ladder
 * decides. It can never snap an answer onto a placeholder.
 */
export function pushManagedReactSelectOptionProbeActions(
  actions: ManagedBrowserAction[],
  portal: SupportedPortal,
  round: 1 | 2 | 3 = 1,
  inputIds: readonly string[] = GREENHOUSE_OPTION_PROBE_IDS,
) {
  if (portalFamily(portal) !== 'greenhouse') return;
  for (const inputId of inputIds) {
    const selector = `[id="${quoteAttr(inputId)}"]`;
    actions.push({
      type: 'click',
      selector,
      label: `option_probe_open:${inputId}:${round}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
    actions.push({
      type: 'extract',
      selector: reactSelectListboxSelector(inputId),
      label: `${MANAGED_OPTION_EXTRACT_PREFIX}${inputId}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
    // Escape rather than a second click: clicking an open react-select closes it, but clicking a
    // CLOSED one opens it again, and the probe must leave the control exactly as it found it.
    actions.push({
      type: 'press',
      selector,
      value: 'Escape',
      label: `option_probe_close:${inputId}:${round}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
  }
}

/**
 * A listbox that is not an option list: the async loader's placeholder, the empty-search message,
 * and the prompts an async select shows before anything is typed.
 *
 * This is load-bearing rather than tidy-up. Without it a control read mid-fetch contributes the
 * single "option" `Loading...`, chooseClosestOption is handed a one-entry list, and the closest
 * thing to a stored answer on that list is the placeholder itself.
 */
const NON_OPTION_LISTBOX_LINE =
  /^(?:loading(?:\.{3}|…)?|no options?|no results?(?: found)?|type to search|start typing|searching(?:\.{3}|…)?|(?:please\s+)?select(?:\s+(?:an?|one|option|value))?(?:\.{3}|…)?|choose(?:\s+(?:an?|one|option|value))?(?:\.{3}|…)?|--\s*select\s*--)$/i;

/**
 * How many rows Greenhouse's select renders into an unfiltered menu. A read this long is a WINDOW
 * over the list, not the list.
 *
 * Measured on the live Anduril posting: School stops after 100 rows and is searchable past them
 * (typing "University of Southern" returns 8 entries that were nowhere in the first 100); the
 * Discipline menu also stops at exactly 100, ending on "European Studies", which is plainly not the
 * end of a discipline taxonomy. Degree returns 22 and End date month returns 12, and those really
 * are the whole list.
 *
 * A windowed read must be discarded rather than used, because it cannot answer the question the
 * caller asks of an option list. "The stored answer is not on this list" and "the stored answer is
 * past row 100" look identical, and acting on the first would both skip a correct fill and tell the
 * applicant her saved answer is not offered, on a control that offers it.
 *
 * THE CAP IS A FLOOR IT STOPS AT, NOT A LENGTH IT EXCEEDS, and reading it as ">= 100" was the
 * defect. Measured on the live Jane Street posting 2026-08-16, read-only: "How did you hear about
 * us?" opens with all 128 of its rows in the DOM, first "3Blue1Brown" and last "VLDB", with
 * "University job board" at row 76. Nothing about it is a window - the menu is simply longer than
 * a hundred - and ">= 100" called it one, dropped the control, and held the send. That single
 * comparison was the largest blocker on the owner's queue: 55 of 167 needs_attention packets on
 * 2026-08-16 were stuck behind this one sentence, every one of them on a "how did you hear about
 * us" control whose answer is on file.
 *
 * A menu that stops AT the cap is still the suspicious case and still fails closed, which is what
 * the Anduril reads above are. A menu that runs past it has demonstrably not been truncated by it.
 */
const MANAGED_OPTION_LISTBOX_RENDER_CAP = 100;

function parsedManagedOptionLines(value: unknown): { options?: string[]; invalid?: 'loading' | 'windowed' | 'empty' } {
  const text = managedExtractedValue(value);
  if (!text) return { invalid: 'empty' };
  const raw = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const options = raw.filter((line) => !NON_OPTION_LISTBOX_LINE.test(line));
  if (options.length === 0) return { invalid: raw.length > 0 ? 'loading' : 'empty' };
  if (options.length === MANAGED_OPTION_LISTBOX_RENDER_CAP) return { invalid: 'windowed' };
  return { options: [...new Set(options)] };
}

/** The option lists the probe brought back, keyed by the control's own id. */
export function managedResultFieldOptions(result: ManagedBrowserResult | null | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const item of result?.extracted ?? []) {
    const labelled = typeof item?.label === 'string' && item.label.startsWith(MANAGED_OPTION_EXTRACT_PREFIX)
      ? item.label.slice(MANAGED_OPTION_EXTRACT_PREFIX.length)
      : undefined;
    const inputId = labelled || optionProbeIdForSelector(item?.selector);
    if (!inputId) continue;
    const { options } = parsedManagedOptionLines(item?.value);
    if (!options) continue;
    const seen = new Set(out[inputId] ?? []);
    for (const option of options) {
      if (seen.has(option)) continue;
      seen.add(option);
      out[inputId] = [...(out[inputId] ?? []), option];
    }
  }
  return out;
}

/**
 * Put the probed option lists onto the discovered questions, so resolveProfileField can snap.
 *
 * Matched by the control id appearing in the RAW discovered label. Managed discovery concatenates
 * label + aria-label + placeholder + name + id, so the discipline control arrives as
 * "discipline* discipline--0" and carries its own id; nothing else has to be threaded through.
 */
export function attachManagedFieldOptions<T extends { label: string; selector?: string; options?: string[] | null }>(
  discovered: readonly T[],
  optionsByInputId: Record<string, string[]>,
): T[] {
  const controlCounts = new Map<string, number>();
  for (const field of discovered) {
    const controlId = managedOptionProbeControlId(field);
    if (controlId) controlCounts.set(controlId, (controlCounts.get(controlId) ?? 0) + 1);
  }
  return discovered.map((field) => {
    if (field.options && field.options.length > 0) return field;
    const controlId = managedOptionProbeControlId(field);
    // The same durable id on two discovered fields is ambiguous. Never attach one list to both,
    // and never fall back to a label substring that can match a neighbouring question.
    if (!controlId || controlCounts.get(controlId) !== 1) return field;
    const options = optionsByInputId[controlId];
    return options?.length ? { ...field, options } : field;
  });
}

/* ─── the SAME read, on every closed control the page actually has ─────────────────────────────
 *
 * GREENHOUSE_OPTION_PROBE_IDS is a list of four, and it is four because those are the ids Greenhouse
 * itself owns and so are knowable before the page is read. Every OTHER closed control on a Greenhouse
 * form is a custom question whose id the employer's own configuration decides
 * (`question_37228964002`), and nothing can name those in advance. So they arrived at the fill with
 * `options: undefined`, resolveProfileField had nothing to snap to, and a blind alias ladder decided.
 *
 * Measured on the owner's 2026-08-08 run, against the live forms on 2026-08-09: the answer the ladder
 * guessed was not on the employer's list in nine separate places. Virtu's "Overall GPA" offers
 * "4.0-5.0 / 3.5-3.9 / 3.0-3.4 / below 3.0 / I'd rather not disclose" and was sent "3.89". DRW's
 * "How did you hear about this job?" offers "DRW Careers Page" among sixteen and was sent "Company
 * website", which is on no employer's list anywhere. Point72's degree control offers
 * "Bachelors / Masters / PhD" and was sent "Bachelor of Science in Computer Science".
 *
 * The matcher was never the gap. The gap is that the list never reached it. This is the plumbing:
 * the same three actions (open, extract the listbox, close) pointed at the ids the DISCOVERY pass
 * just read off the live page, instead of at four ids compiled into this file.
 *
 * WHY IT IS A SEPARATE CALL and not more actions on the discovery pass. buildManagedDiscoveryActions
 * already trims itself to land under MANAGED_ACTION_LIMIT on a real Greenhouse packet, and the
 * runner answers anything over that ceiling with HTTP 400 before a browser opens. There is no room
 * there. There is also no information there: the ids being probed here are the discovery pass's own
 * output, so this read cannot be built until that pass has returned. A third call gets its own
 * budget for the same reason it gets its own ids.
 *
 * IT IS READ-ONLY, and that is not incidental. No fill, no upload, no submit, no screenshot: opening
 * a react-select and pressing Escape leaves the control exactly as it was found, which is what makes
 * it safe to run against an employer's form on an application the applicant has not yet approved.
 */

/** A custom control needs one identity read plus two bounded open/read/close rounds. */
export const MANAGED_OPTION_PROBE_ACTIONS_PER_CONTROL = 7;
export const MANAGED_OPTION_PROBE_MAX_CONTROLS = 80;

/**
 * Greenhouse's structural controls, which this pass deliberately does not spend actions on.
 *
 * `country` and `candidate-location` belong to the fixed-field pass, which fills them from the
 * packet by typing and selecting. Measured on all five forms probed on 2026-08-09: `country` renders
 * 244 rows, which managedResultFieldOptions discards at the render cap anyway, and
 * `candidate-location` renders nothing at all until something is typed. Six actions for two reads
 * that cannot be used.
 */
const MANAGED_OPTION_PROBE_SKIP_IDS = new Set<string>(['country', 'candidate-location']);
const MANAGED_FIXED_CLOSED_CONTROL_IDS = new Set<string>(GREENHOUSE_OPTION_PROBE_IDS);

/** `#question_37228964002` or `[id="school--0"]`, and nothing that is not a plain id selector. */
function controlIdFromDiscoveredSelector(selector: string | undefined | null): string | undefined {
  const trimmed = (selector ?? '').trim();
  if (!trimmed) return undefined;
  // Rejects the escaped array-name selectors Greenhouse gives checkbox groups
  // (`#question_67998838\[\]_731437070`): a checkbox group has no listbox, so probing it would spend
  // three actions to read nothing.
  return trimmed.match(/^#([A-Za-z][A-Za-z0-9_-]*)$/)?.[1]
    ?? trimmed.match(/^(?:[a-z][a-z0-9-]*)?\[id="([A-Za-z][A-Za-z0-9_-]*)"\]$/i)?.[1];
}

const MANAGED_OPTION_NAME_KEY_PREFIX = 'name:';
const MANAGED_OPTION_SELECTOR_KEY_PREFIX = 'selector:';

/** Stable name-only controls need an inventory key, but must never be mistaken for a DOM id.
 *
 * BRACKETED SEGMENTS ARE NAMES TOO, AND EVERY LEVER CUSTOM QUESTION IS ONE.
 *
 * The pattern allowed a bare identifier with at most a trailing `[]`, which is Greenhouse's checkbox
 * shape. Lever names its custom questions `cards[<uuid>][field0]`, brackets in the MIDDLE, so no key
 * was derived, managedOptionProbeControlId answered undefined, and managedOptionProbeAnalysis skipped
 * the field at its `!id` guard - discarding an option list discovery had already read correctly. So
 * `packet.fieldOptions` was `{}` on every Lever packet, which is what `has_field_options: false`
 * measured, and it was read as "discovery cannot see Lever's options" when discovery could.
 *
 * WHAT THAT COST, and it is not the resolved answer. Question resolution reads `field.options` off the
 * discovered field, which keeps its own list, so the degree still snaps to the employer's "Bachelor
 * Degree". What went missing is every rule keyed on the packet MAP: packetAnswerOutranksAliasGuess
 * cannot see that a control is already answered with an option the employer offers, so the alias
 * ladder is free to fire the raw profile value at a Lever control that was already correct; and
 * reviewed multi-select replay has no list to decompose an answer against, so it emits nothing.
 *
 * SAFE TO WIDEN ONLY BECAUSE A NAME KEY IS NEVER A SELECTOR. These names contain `[` and `]`, which
 * would be a broken CSS selector if interpolated, and managedOptionProbeTarget refuses every
 * `name:`-prefixed id before any probe selector is built. The key is a Record key and nothing else.
 *
 * A radio or checkbox GROUP shares one name across its options, and discovery emits one entry per
 * group, so the count-of-one guard in managedOptionProbeAnalysis still holds.
 */
function controlNameOptionKeyFromDiscoveredSelector(
  selector: string | undefined | null,
): string | undefined {
  const trimmed = (selector ?? '').trim();
  const name = trimmed.match(
    /^(?:[a-z][a-z0-9-]*)?\[name=["']([A-Za-z0-9][A-Za-z0-9_.:-]*(?:\[[A-Za-z0-9_.:-]*\])*)["']\]$/i,
  )?.[1];
  return name ? `${MANAGED_OPTION_NAME_KEY_PREFIX}${name}` : undefined;
}

/**
 * Greenhouse checkbox options have stable ids such as `question_67998839[]_731437073`.
 * The brackets intentionally keep them out of controlIdFromDiscoveredSelector because they are
 * native checkboxes, not React selects to probe. They still need a stable inventory key so the
 * exact option labels discovery already read can reach reviewed-answer replay.
 */
function greenhouseCheckboxOptionInventoryKey(
  selector: string | undefined | null,
): string | undefined {
  const trimmed = (selector ?? '').trim();
  const id = trimmed.match(
    /^(?:[a-z][a-z0-9-]*)?\[id=["'](question_\d+\[\]_\d+)["']\]$/i,
  )?.[1];
  return id ? `${MANAGED_OPTION_SELECTOR_KEY_PREFIX}${trimmed}` : undefined;
}

function managedOptionInventoryKeyFromSelector(
  selector: string | undefined | null,
): string | undefined {
  return controlIdFromDiscoveredSelector(selector)
    ?? controlNameOptionKeyFromDiscoveredSelector(selector)
    ?? greenhouseCheckboxOptionInventoryKey(selector);
}

// The handles managed discovery concatenates onto the visible label, in the order they are trusted.
// Same shapes normalizeDiscoveredLabel strips out to recover the employer's question text, read here
// for the opposite purpose: the handle IS the control id.
const LABEL_SECTION_HANDLE_RE = /\b([a-z][a-z0-9]*(?:[-_][a-z0-9]+)*--\d+)\b/i;
const LABEL_QUESTION_HANDLE_RE = /\b(question_\d+)\b(?!\s*\[)/i;
// Greenhouse's demographic controls carry a bare numeric id ("how would you describe your gender
// identity? 4001608008") and reach discovery as `[data-litos-discovered-21]`, so the label is the
// only place their id appears. Six digits minimum, and only at the very end, so a year inside a
// question ("ready for full-time employment in 2028?") is never mistaken for a handle.
const LABEL_TRAILING_NUMERIC_HANDLE_RE = /(?:^|\s)(\d{6,})\s*$/;
/* Greenhouse's OWN four self-identification controls, which carry a NAMED id rather than a numeric
 * one and so were the one closed-control shape #428's plumbing could not name.
 *
 * They reach discovery as `[data-litos-discovered-14]` with the id concatenated onto the visible
 * question ("are you hispanic/latino? hispanic_ethnicity"), which is neither a `question_<digits>`
 * handle nor a six-digit one, so managedOptionProbeControlId returned undefined and the probe pass
 * skipped all four. Measured on the live Flow Traders form, 2026-08-09, these are the lists that
 * were therefore never read:
 *
 *   gender             Male / Female / Decline To Self Identify
 *   hispanic_ethnicity Yes / No / Decline To Self Identify
 *   veteran_status     I am not a protected veteran / I identify as one or more ... / I don't wish to answer
 *   disability_status  Yes, I have a disability, or have had one in the past / No, I do not ... /
 *                      I do not want to answer
 *
 * The stored decline answer is "Decline to self-identify", and against those lists it is on two of
 * the four and on neither of the other two. Both production runs of 2026-08-09 reported exactly
 * that: `"are you hispanic/latino? hispanic_ethnicity" (no option matched "Decline to
 * self-identify")` and the same line for disability status. With the list read, the existing
 * snapping picks the employer's own wording and nothing in the matcher has to be loosened.
 *
 * An explicit set of four rather than a trailing-snake_case pattern: these four ids are Greenhouse's
 * and identical on every Greenhouse board, so this stays an ATS-family fact. A general pattern would
 * read the last word of any question that happens to end in an underscored token as a control id. */
const GREENHOUSE_DEMOGRAPHIC_CONTROL_IDS = ['gender', 'hispanic_ethnicity', 'veteran_status', 'disability_status', 'race'] as const;
const LABEL_TRAILING_DEMOGRAPHIC_HANDLE_RE = new RegExp(
  `(?:^|\\s)(${GREENHOUSE_DEMOGRAPHIC_CONTROL_IDS.join('|')})\\s*$`,
  'i',
);

/**
 * The id of the control a discovered field stands for, or undefined when it cannot be named.
 *
 * Selector first, because it is the provider's own handle on the element and cannot be confused with
 * question text. The label is the fallback for controls the provider addressed by data attribute.
 */
export function managedOptionProbeControlId(
  field: { label?: string | null; selector?: string | null; durableSelector?: string | null },
): string | undefined {
  const fromSelector = managedOptionInventoryKeyFromSelector(field.durableSelector)
    ?? managedOptionInventoryKeyFromSelector(field.selector);
  if (fromSelector) return fromSelector;
  const label = (field.label ?? '').trim();
  if (!label) return undefined;
  return label.match(LABEL_SECTION_HANDLE_RE)?.[1]
    ?? label.match(LABEL_QUESTION_HANDLE_RE)?.[1]
    ?? label.match(LABEL_TRAILING_NUMERIC_HANDLE_RE)?.[1]
    ?? label.match(LABEL_TRAILING_DEMOGRAPHIC_HANDLE_RE)?.[1]?.toLowerCase();
}

export type ManagedOptionProbeTarget = {
  controlId: string;
  kind: 'native' | 'custom';
  required: boolean;
  expectsClosed: boolean;
};

function managedOptionProbeTarget(
  field: { label: string; selector?: string; durableSelector?: string | null; inputType?: string; role?: string | null; required?: boolean },
  discoveryRoleCapability = false,
): ManagedOptionProbeTarget | undefined {
  const controlId = managedOptionProbeControlId(field);
  // A stable name is enough to join discovery options to the later packet. It is not a DOM id and
  // cannot be interpolated into Greenhouse's id-based React-select probe selectors.
  if (!controlId
    || controlId.startsWith(MANAGED_OPTION_NAME_KEY_PREFIX)
    || controlId.startsWith(MANAGED_OPTION_SELECTOR_KEY_PREFIX)
    || MANAGED_OPTION_PROBE_SKIP_IDS.has(controlId)) return undefined;
  const inputType = (field.inputType ?? '').trim().toLowerCase();
  const role = (field.role ?? '').trim().toLowerCase();
  const kind = /^select(?:-one|-multiple)?$/.test(inputType) ? 'native' : 'custom';
  const expectsClosed = kind === 'native'
    || /^(?:combobox|listbox)$/.test(inputType)
    || (discoveryRoleCapability && /^(?:combobox|listbox)$/.test(role))
    || MANAGED_FIXED_CLOSED_CONTROL_IDS.has(controlId);
  // Greenhouse's education row mixes React-selects with a plain text graduation-year input. The
  // shared `--0` suffix identifies a row, not a closed control. In particular, end-year--0 must be
  // left to its normal text fill instead of being invalidated when a listbox can never appear.
  if (!expectsClosed) return undefined;
  return {
    controlId,
    kind,
    required: discoveredFieldIsRequired(field),
    expectsClosed,
  };
}

/**
 * Which controls this pass should read, in the order a budget cut should keep.
 *
 * Required first: a required control whose list was never read is the one that ends the run with
 * '"Overall GPA" is required and is still empty'. An optional one costs the applicant nothing.
 *
 * Anything the discovery pass already read is skipped rather than read again, so the four education
 * controls (which need two rounds because their taxonomies load over the network) stay where the
 * warming round already exists and this pass spends nothing on them.
 */
export function managedOptionProbeTargets(
  portal: SupportedPortal,
  discovered: readonly { label: string; selector?: string; durableSelector?: string | null; inputType?: string; role?: string | null; options?: string[] | null; required?: boolean }[],
  alreadyRead: Record<string, string[]> = {},
  discoveryRoleCapability = false,
): string[] {
  if (portalFamily(portal) !== 'greenhouse') return [];
  // A hardcoded education probe is only "already read" when it returned a usable list. Loading,
  // empty and windowed reads are absent from alreadyRead and must enter this fail-closed stage.
  const seen = new Set<string>();
  for (const [inputId, options] of Object.entries(alreadyRead)) {
    if (options.length > 0) seen.add(inputId);
  }
  const required: ManagedOptionProbeTarget[] = [];
  const optional: ManagedOptionProbeTarget[] = [];
  for (const field of discovered) {
    if (field.options && field.options.length > 0) continue;
    const target = managedOptionProbeTarget(field, discoveryRoleCapability);
    if (!target || seen.has(target.controlId)) continue;
    seen.add(target.controlId);
    (target.required ? required : optional).push(target);
  }
  return [...required, ...optional].map(({ controlId }) => controlId);
}

function detailedManagedOptionProbeTargets(
  portal: SupportedPortal,
  discovered: readonly { label: string; selector?: string; durableSelector?: string | null; inputType?: string; role?: string | null; options?: string[] | null; required?: boolean }[],
  alreadyRead: Record<string, string[]> = {},
  discoveryRoleCapability = false,
): ManagedOptionProbeTarget[] {
  const ids = managedOptionProbeTargets(portal, discovered, alreadyRead, discoveryRoleCapability);
  const byId = new Map<string, ManagedOptionProbeTarget>();
  for (const field of discovered) {
    const target = managedOptionProbeTarget(field, discoveryRoleCapability);
    if (target && !byId.has(target.controlId)) byId.set(target.controlId, target);
  }
  return ids.flatMap((id) => byId.get(id) ?? []);
}

function closedControlSelector(controlId: string): string {
  return `[id="${quoteAttr(controlId)}"]:is([role="combobox"],[aria-haspopup="listbox"])`;
}

function nativeSelectSelector(controlId: string): string {
  return `[id="${quoteAttr(controlId)}"]:is(select)`;
}

function pushDiscoveredOptionProbe(actions: ManagedBrowserAction[], target: ManagedOptionProbeTarget) {
  if (target.kind === 'native') {
    actions.push({
      type: 'extract',
      selector: nativeSelectSelector(target.controlId),
      label: `${MANAGED_OPTION_EXTRACT_PREFIX}${target.controlId}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
    return;
  }
  const selector = closedControlSelector(target.controlId);
  actions.push({
    type: 'extract',
    selector,
    attribute: 'id',
    label: `closed_control:${target.controlId}`,
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
  for (const round of [1, 2] as const) {
    actions.push({ type: 'click', selector, label: `option_probe_open:${target.controlId}:${round}`, optional: true, timeout: MANAGED_FILL_TIMEOUT_MS });
    actions.push({ type: 'extract', selector: reactSelectListboxSelector(target.controlId), label: `${MANAGED_OPTION_EXTRACT_PREFIX}${target.controlId}`, optional: true, timeout: MANAGED_FILL_TIMEOUT_MS });
    actions.push({ type: 'press', selector, value: 'Escape', label: `option_probe_close:${target.controlId}:${round}`, optional: true, timeout: MANAGED_FILL_TIMEOUT_MS });
  }
}

/** Pack whole controls into bounded requests. No control is partially probed at a budget edge. */
export function buildManagedDiscoveredOptionProbeBatches(
  portal: SupportedPortal,
  discovered: readonly { label: string; selector?: string; inputType?: string; role?: string | null; options?: string[] | null; required?: boolean }[],
  alreadyRead: Record<string, string[]> = {},
  discoveryRoleCapability = false,
): ManagedBrowserAction[][] {
  const targets = detailedManagedOptionProbeTargets(portal, discovered, alreadyRead, discoveryRoleCapability)
    .slice(0, MANAGED_OPTION_PROBE_MAX_CONTROLS);
  const batches: ManagedBrowserAction[][] = [];
  let actions: ManagedBrowserAction[] = [];
  for (const target of targets) {
    const next: ManagedBrowserAction[] = [];
    pushDiscoveredOptionProbe(next, target);
    if (actions.length > 0 && actions.length + next.length > MANAGED_ACTION_LIMIT) {
      batches.push(actions);
      actions = [];
    }
    actions.push(...next);
  }
  if (actions.length > 0) batches.push(actions);
  return batches;
}

/**
 * The third managed call's whole action list, or an empty list when there is nothing to read.
 *
 * An empty list means the caller skips the call entirely rather than opening a browser to do
 * nothing, which is the case on every non-Greenhouse family and on a Greenhouse form whose only
 * closed controls are the four the discovery pass already covers.
 *
 * ONE ROUND, and that is measured rather than assumed. The two-round shape exists because Greenhouse
 * fetches the school, degree and discipline taxonomies over the network when the menu first opens,
 * so the first read comes back "Loading...". Every custom question's options ship inside the page:
 * probed live on 2026-08-09 across DRW, IMC, Point72, Five Rings and Virtu, all 60 custom and
 * demographic controls returned their full list on the FIRST open. A round that did come back
 * "Loading..." contributes nothing (managedResultFieldOptions drops it) and the alias ladder decides,
 * which is exactly the behaviour that existed before this pass.
 */
export function buildManagedDiscoveredOptionProbeActions(
  portal: SupportedPortal,
  discovered: readonly { label: string; selector?: string; inputType?: string; role?: string | null; options?: string[] | null; required?: boolean }[],
  alreadyRead: Record<string, string[]> = {},
  discoveryRoleCapability = false,
): ManagedBrowserAction[] {
  return buildManagedDiscoveredOptionProbeBatches(portal, discovered, alreadyRead, discoveryRoleCapability)[0] ?? [];
}

export function managedResultSupportsDiscoveryRole(result: ManagedBrowserResult | null | undefined): boolean {
  return result?.capabilities?.includes(MANAGED_DISCOVERY_ROLE_CAPABILITY) === true;
}

/**
 * Two passes' option reads, as one map.
 *
 * Later wins on a key neither pass should produce twice; the guard exists so a control read by both
 * cannot end up with the earlier, possibly mid-fetch, list.
 */
export function mergeManagedFieldOptions(
  ...maps: ReadonlyArray<Record<string, string[]> | null | undefined>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const map of maps) {
    for (const [inputId, options] of Object.entries(map ?? {})) {
      if (options.length > 0) out[inputId] = options;
    }
  }
  return out;
}

export type ManagedOptionProbeFailure = { controlId: string; reason: string };
export type ManagedOptionProbeBatchFailure = { controlIds: string[]; reason: string };

export function managedOptionProbeAnalysis(
  portal: SupportedPortal,
  discovered: readonly { label: string; selector?: string; durableSelector?: string | null; inputType?: string; role?: string | null; options?: string[] | null; required?: boolean }[],
  alreadyRead: Record<string, string[]>,
  results: readonly (ManagedBrowserResult | null | undefined)[],
  batchFailures: readonly ManagedOptionProbeBatchFailure[] = [],
  discoveryRoleCapability = false,
): { options: Record<string, string[]>; failures: ManagedOptionProbeFailure[]; failedIds: Set<string> } {
  const targets = detailedManagedOptionProbeTargets(portal, discovered, alreadyRead, discoveryRoleCapability);
  const options = { ...alreadyRead };
  const failures: ManagedOptionProbeFailure[] = [];
  const failedIds = new Set<string>();
  const counts = new Map<string, number>();
  for (const field of discovered) {
    const id = managedOptionProbeControlId(field);
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // Native choice groups already carry their exact rendered option labels in discovery. Preserve
  // those lists in the same packet map used by probed React selects, so managed Workable replay can
  // distinguish a multi-value answer from a single option whose label contains a comma.
  for (const field of discovered) {
    const id = managedOptionProbeControlId(field);
    if (!id || (counts.get(id) ?? 0) !== 1 || options[id]?.length) continue;
    const read = [...new Set((field.options ?? []).map((option) => option.trim()).filter(Boolean))];
    if (read.length > 0) options[id] = read;
  }

  const closedIds = new Set<string>();
  const validReads = new Map<string, string[][]>();
  const invalidReads = new Map<string, Set<string>>();
  for (const result of results) {
    for (const item of result?.extracted ?? []) {
      const closedId = item.selector?.match(/^\[id="([A-Za-z0-9][A-Za-z0-9_-]*)"\]:is\(\[role="combobox"\],\[aria-haspopup="listbox"\]\)$/)?.[1];
      if (closedId && managedExtractedValue(item.value)) closedIds.add(closedId);
      const id = typeof item.label === 'string' && item.label.startsWith(MANAGED_OPTION_EXTRACT_PREFIX)
        ? item.label.slice(MANAGED_OPTION_EXTRACT_PREFIX.length)
        : optionProbeIdForSelector(item.selector);
      if (!id) continue;
      const parsed = parsedManagedOptionLines(item.value);
      if (parsed.options) validReads.set(id, [...(validReads.get(id) ?? []), parsed.options]);
      if (parsed.invalid) {
        const reasons = invalidReads.get(id) ?? new Set<string>();
        reasons.add(parsed.invalid);
        invalidReads.set(id, reasons);
      }
    }
  }

  const batchFailureById = new Map<string, string>();
  for (const failure of batchFailures) {
    for (const id of failure.controlIds) batchFailureById.set(id, failure.reason);
  }
  const fail = (controlId: string, reason: string) => {
    if (failedIds.has(controlId)) return;
    failedIds.add(controlId);
    failures.push({ controlId, reason });
    delete options[controlId];
  };

  // Validate lists the earlier discovery pass supplied too. A merged union of two different live
  // lists is not an exact option list, even if each individual read was otherwise usable.
  for (const [controlId, reads] of validReads) {
    if (new Set(reads.map((read) => JSON.stringify(read))).size > 1) {
      fail(controlId, 'the live control returned conflicting option lists across bounded reads');
    }
  }

  for (const target of targets) {
    if (failedIds.has(target.controlId)) continue;
    if ((counts.get(target.controlId) ?? 0) > 1) {
      fail(target.controlId, 'the same durable selector identified more than one discovered field');
      continue;
    }
    if (batchFailureById.has(target.controlId)) {
      fail(target.controlId, `the option probe request failed: ${batchFailureById.get(target.controlId)}`);
      continue;
    }
    if (targets.indexOf(target) >= MANAGED_OPTION_PROBE_MAX_CONTROLS) {
      fail(target.controlId, `the form exceeded the bounded ${MANAGED_OPTION_PROBE_MAX_CONTROLS}-control option probe`);
      continue;
    }
    const isClosed = target.kind === 'native' || closedIds.has(target.controlId);
    if (!isClosed && !target.expectsClosed) continue;
    if (!isClosed) {
      fail(target.controlId, 'the field is expected to be a closed control but its live selector did not confirm that identity');
      continue;
    }
    const reads = validReads.get(target.controlId) ?? [];
    const distinct = new Map(reads.map((read) => [JSON.stringify(read), read]));
    if (distinct.size > 1) {
      fail(target.controlId, 'the live control returned conflicting option lists across bounded reads');
      continue;
    }
    const read = [...distinct.values()][0];
    if (!read) {
      const invalid = [...(invalidReads.get(target.controlId) ?? [])];
      const detail = invalid.includes('windowed')
        ? 'the option list was windowed at the render cap'
        : invalid.includes('loading')
          ? 'the option list was still loading after the bounded warm/read'
          : 'the option list returned no readable choices';
      fail(target.controlId, detail);
      continue;
    }
    options[target.controlId] = read;
  }
  return { options, failures, failedIds };
}

function managedGreenhouseScopedReactSelectFill(
  actions: ManagedBrowserAction[],
  inputSelector: string,
  optionSelector: string | undefined,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({
    type: 'click',
    selector: inputSelector,
    label: `${label}_open`,
    optional,
    timeout,
  });
  actions.push({ type: 'fill', selector: inputSelector, value, label, optional, timeout });
  actions.push({
    type: 'click',
    selector: `[id^="react-select-"][id*="-option-"]:has-text("${cssString(value)}"):visible`,
    label: `${label}_option_value`,
    optional,
    timeout,
  });
  if (optionSelector) {
    actions.push({
      type: 'click',
      selector: optionSelector,
      label: `${label}_option`,
      optional,
      timeout,
    });
  }
  actions.push({ type: 'press', selector: inputSelector, value: 'Enter', label: `${label}_select`, optional, timeout });
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * A trailing clause that names a unit INSIDE an institution rather than part of the institution's
 * own name. "Viterbi School of Engineering", "Tandon School of Engineering", "College of Letters and
 * Science", "Department of Physics".
 *
 * The distinction is the whole difficulty, and a bare comma split gets it wrong: in "University of
 * Southern California, Viterbi School of Engineering" the tail is a sub-unit and dropping it is
 * required, while in "University of California, Berkeley" the tail is the institution and dropping
 * it names a DIFFERENT school. Requiring the tail to say what kind of unit it is separates the two
 * without naming either of them.
 */
const SCHOOL_SUBUNIT_TAIL_RE = /\b(?:school|college|faculty|department|division|institute|campus\s+of)\b/i;

/**
 * School values for the education row, best first.
 *
 * An ATS school taxonomy lists INSTITUTIONS, and a resume writes the institution followed by the
 * school inside it. Searching an institution list for the whole phrase returns nothing, exactly as
 * searching a discipline list for a whole major sentence does, so the institution has to lead.
 *
 * This used to be a literal test for "University of Southern California", which is the one school
 * the one person testing it attends. The sub-unit rule is the same fix with no name in it: it
 * produces the identical value for USC and does the same job for every other applicant. The full
 * stored phrasing stays on the ladder behind it, so a board that really does list the sub-unit, or a
 * free-text control, can still reach it.
 */
function greenhouseSchoolAliases(school: string | undefined): string[] {
  const trimmed = school?.trim();
  if (!trimmed) return [];
  const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
  let institution = parts;
  // From the END, because "University of California, Berkeley, College of Engineering" has one of
  // each and only the last clause may go.
  while (institution.length > 1 && SCHOOL_SUBUNIT_TAIL_RE.test(institution[institution.length - 1]!)) {
    institution = institution.slice(0, -1);
  }
  const shortened = institution.length < parts.length ? institution.join(', ') : undefined;
  return uniqueDefined([shortened, trimmed]);
}

function greenhouseDegreeAliases(degree: string | undefined): string[] {
  const trimmed = degree?.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  let level: string | undefined;
  if (/\bph\.?d\b|doctor of philosophy|doctorate/i.test(lower)) level = 'Doctor of Philosophy (Ph.D.)';
  else if (/\bmaster|m\.?s\.?|m\.?a\.?\b|mba|m\.?b\.?a\.?/i.test(lower)) level = 'Master\'s Degree';
  else if (/\bbachelor|b\.?s\.?|b\.?a\.?\b/i.test(lower)) level = 'Bachelor\'s Degree';
  else if (/\bassociate/i.test(lower)) level = 'Associate\'s Degree';
  else if (/\bhigh school/i.test(lower)) level = 'High School';
  const bachelorScience = level === 'Bachelor\'s Degree' && /\b(?:science|b\.?s\.?)\b/i.test(lower)
    ? 'Bachelor of Science'
    : undefined;
  return uniqueDefined([level, bachelorScience, trimmed]).slice(0, 1);
}

/**
 * Discipline values for the education row, best first.
 *
 * The stored major led this list and that is what got typed into Greenhouse's Discipline control:
 * "Computer Science & Business Administration, Finance Emphasis" is a sentence, the control holds a
 * hundred-entry taxonomy, and searching it for that sentence returns nothing. disciplineLadder is
 * the shared vocabulary written for exactly this (it splits the declared subjects off the emphasis
 * clause and offers the standard family names), so its head is "Computer Science" and the stored
 * phrasing falls to the back where a free-text control can still reach it.
 */
function greenhouseDisciplineAliases(packet: SubmissionPacket): string[] {
  return uniqueDefined(disciplineLadder(packet.major, packet.degree));
}

/**
 * The ONE value to type into a react-select, given what the control actually offers.
 *
 * Two measurements, both taken live against the Anduril Greenhouse posting on 2026-08-08, decide
 * the shape of this:
 *
 *  1. When the probe read the control's real options, snapping onto one of them is the whole job.
 *     The stored major is "Computer Science & Business Administration, Finance Emphasis"; the
 *     control offers "Computer Science". Typing the stored phrasing filters the menu to nothing.
 *
 *  2. There is no such thing as a SECOND attempt at a react-select on this path, so the ladder can
 *     never be walked. Every attempt begins by clicking the input; on an already-open menu that
 *     click CLOSES it, and a subsequent fill does not reopen it. The two-alias sequence that ran in
 *     production (full major, then "Computer Science") was measured leaving the field empty, while
 *     a single pass with the right value selects it. So a second alias is not a fallback, it is a
 *     guarantee of failure, and one attempt is strictly better than two.
 */
function greenhouseReactSelectValue(
  packet: SubmissionPacket,
  inputId: string,
  ladder: readonly string[],
): string | undefined {
  const snapped = chooseClosestOption(ladder, packet.fieldOptions?.[inputId]);
  return snapped ?? ladder.find((value) => value.trim().length > 0);
}

function normalizedFailedFieldLabel(value: string): string {
  return normalizeReviewQuestionLabel(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

type ManagedFieldTarget = {
  controlId?: string;
  selector?: string;
  label?: string;
};

function managedClosedFieldFamily(label: string): string | undefined {
  const normalized = normalizedFailedFieldLabel(label);
  if (!normalized) return undefined;
  if (/\bhow did you hear\b|\bwhere did you hear\b|\bwhere have you learned\b|\breferral source\b/.test(normalized)) return 'referral';
  if (/\bcurrent immigration status\b|\bbasis of (?:your )?current work authorization\b|\bcurrent visa status\b/.test(normalized)) return 'immigration-status';
  if (/\bvisa sponsorship\b|\brequire sponsorship\b|\bimmigration support or sponsorship\b|\bneed sponsorship\b/.test(normalized)) return 'sponsorship';
  if (/\b(?:eligible|authorized|authorised|legally)\b.*\bwork\b|\bwork authorization\b/.test(normalized)
    && !/\bcurrent immigration status\b|\bbasis of (?:your )?current work authorization\b/.test(normalized)) return 'work-authorization';
  if (/\bapplied\b.*\b(?:past|previously|before|role|position)\b|\bpreviously applied\b/.test(normalized)) return 'prior-application';
  if (/\boffer deadlines?\b/.test(normalized)) return 'offer-deadline';
  if (/\bgender identity\b|\bwhat gender\b/.test(normalized)) return 'demographic-gender';
  if (/\btransgender\b/.test(normalized)) return 'demographic-transgender';
  if (/\bsexual orientation\b/.test(normalized)) return 'demographic-sexual-orientation';
  if (/\bdisab/.test(normalized)) return 'demographic-disability';
  if (/\bveteran\b|\bserved in the military\b/.test(normalized)) return 'demographic-veteran';
  if (/\brace\b|\bethnicit/.test(normalized)) return 'demographic-race';
  // Academic families are deliberately applicant-field shapes, not keyword buckets. Employer
  // questions such as "GPA requirement for scholarship", "degree comfortable onsite", and
  // "university recruiting event" contain the same nouns but are not asking for the applicant's
  // stored academic fact. Exact failed labels are still caught before this family mapping.
  const unrelatedAcademicPolicy = /\b(?:scholarship|requirement|minimum|required|eligibility|qualif(?:y|ication)|policy|program)\b/.test(normalized);
  if (!unrelatedAcademicPolicy
    && /^(?:(?:please )?(?:indicate|provide|enter|report|select|choose) )?(?:(?:what is) )?(?:your )?(?:(?:overall|cumulative|current|undergraduate|college) )?(?:gpa|grade point average|grade average)(?: (?:range|band))?(?:(?: out of| on a) \d+(?: \d+)?(?: scale)?)?(?: if applicable)?$/.test(normalized)) return 'education-gpa';
  if (/^(?:degree|education level|degree type|type of degree|highest level of education)$/.test(normalized)
    || /^(?:what|which) (?:is )?(?:your )?(?:current )?(?:degree|education level)(?: are you currently pursuing)?$/.test(normalized)
    || /^what (?:degree|education level) are you currently pursuing$/.test(normalized)) return 'education-degree';
  if (/^(?:school|university|college|academic institution)$/.test(normalized)
    || /^(?:which|what) (?:school|university|college|academic institution)(?: do did you attend| are you currently attending| did you attend)?$/.test(normalized)
    || /^(?:school|university|college|academic institution) (?:name|attended)$/.test(normalized)) return 'education-school';
  if (/^(?:(?:what is|please provide) )?(?:your )?(?:expected )?graduation year$/.test(normalized)
    || /^year of graduation$/.test(normalized)) return 'education-graduation-year';
  if (/^(?:(?:what is|please provide) )?(?:your )?(?:expected )?graduation month$/.test(normalized)
    || /^month of graduation$/.test(normalized)) return 'education-graduation-month';
  return undefined;
}

/* Whether an applicant-chosen answer names EXACTLY the control this failed field records.
 *
 * A failed field says the run could not READ the control's option list, and the suppression built
 * on it exists so no builder GUESSES at a list nobody read. An answer with answer_source
 * applicant_review is not a guess: she chose it, the fill types it verbatim and clicks the option
 * whose text matches, and none of that needs the list read in advance.
 *
 * Measured on Jump Trading packet 2e593ac5, 2026-08-17 late, AFTER the reviewed-answer ordering
 * fix deployed: the graduation control's probe failed on the live run, the failed-field record
 * suppressed her verbatim "Spring/Summer 2028" everywhere, and the speculative graduation ladder,
 * whose own suppression needs the very list the probe failed to read, typed the profile's
 * "May 2028" into the same control through a substring label match. The run reported
 * `no option matched "May 2028"` on a question that was already answered correctly.
 *
 * DELIBERATELY NARROWER than the matcher inside packetTargetFailed: no closed-field-family clause.
 * The suppression may be broad, because refusing a guess costs one blocker card; the exemption must
 * be provably about HER control, because a family bucket spans different controls on one form and
 * an exemption at that width let her sponsorship answer lift the suppression off a second, machine-
 * answered sponsorship control whose list nobody read. Only identity evidence counts: the exact
 * selector, the exact control id, or the exact stored label. */
/** The ManagedFieldTarget a reviewed question record resolves to, shared by every matcher below. */
function reviewQuestionFieldTarget(item: SubmissionPacket['questions'][number]): ManagedFieldTarget {
  const selector = reviewQuestionPortalSelector(item);
  return {
    controlId: managedOptionInventoryKeyFromSelector(selector),
    selector,
    label: item.question,
  };
}

/* THE ONE MATCHING CASCADE for a failed field against a target: exact selector, exact control id,
 * exact normalized label, and, only when the caller opts in, the closed-field family.
 *
 * Both directions of the failed-probe logic run through this so they cannot drift: SUPPRESSION
 * (packetTargetFailed) matches with families, because refusing a guess costs one blocker card and
 * a family-wide refusal is the safe direction. The applicant EXEMPTION matches without them,
 * because a family bucket spans different controls on one form, and an exemption at that width let
 * her sponsorship answer lift the suppression off a second, machine-answered sponsorship control
 * whose list nobody read. The flag is the whole difference; everything else is shared. */
function failedFieldMatchesTarget(
  field: NonNullable<SubmissionPacket['failedFields']>[number],
  target: ManagedFieldTarget,
  matchFamilies: boolean,
): boolean {
  if (target.controlId && field.controlId === target.controlId) return true;
  if (target.selector && field.selector && field.selector === target.selector) return true;
  const targetLabel = normalizedFailedFieldLabel(target.label ?? '');
  const failedLabel = normalizedFailedFieldLabel(field.label);
  if (!targetLabel || !failedLabel) return false;
  if (targetLabel === failedLabel) return true;
  if (!matchFamilies) return false;
  const targetFamily = managedClosedFieldFamily(target.label ?? '');
  const failedFamily = managedClosedFieldFamily(field.label);
  return Boolean(targetFamily && failedFamily && targetFamily === failedFamily);
}

/* Whether an applicant-chosen answer names EXACTLY the control this failed field records.
 *
 * A failed field says the run could not READ the control's option list, and the suppression built
 * on it exists so no builder GUESSES at a list nobody read. An answer with answer_source
 * applicant_review is not a guess: she chose it, the fill types it verbatim and clicks the option
 * whose text matches, and none of that needs the list read in advance.
 *
 * Measured on Jump Trading packet 2e593ac5, 2026-08-17 late, AFTER the reviewed-answer ordering
 * fix deployed: the graduation control's probe failed on the live run, the failed-field record
 * suppressed her verbatim "Spring/Summer 2028" everywhere, and the speculative graduation ladder,
 * whose own suppression needs the very list the probe failed to read, typed the profile's
 * "May 2028" into the same control through a substring label match. The run reported
 * `no option matched "May 2028"` on a question that was already answered correctly. */
function applicantChosenQuestionMatchesFailedField(
  item: SubmissionPacket['questions'][number],
  field: NonNullable<SubmissionPacket['failedFields']>[number],
): boolean {
  return failedFieldMatchesTarget(field, reviewQuestionFieldTarget(item), false);
}

function applicantChoseAnswerForFailedField(
  packet: SubmissionPacket,
  field: NonNullable<SubmissionPacket['failedFields']>[number],
): boolean {
  return packet.questions.some((item) => applicantChoseAnswer(item)
    && applicantChosenQuestionMatchesFailedField(item, field));
}

function packetTargetFailed(packet: SubmissionPacket, target: ManagedFieldTarget): boolean {
  return packet.failedFields?.some((field) => failedFieldMatchesTarget(field, target, true)) === true;
}

function packetControlFailed(packet: SubmissionPacket, controlId: string): boolean {
  return packetTargetFailed(packet, { controlId });
}

function packetLabelFailed(packet: SubmissionPacket, label: string): boolean {
  return packetTargetFailed(packet, { label });
}

/* PER-ITEM exemption, not a packet-wide one. An applicant-chosen answer un-suppresses exactly ONE
 * consumer: the reviewed-question fill for that item. Every other reader of failedFields keeps the
 * full record, so the id-scoped education fills, the demographic and known-question alias ladders,
 * and a machine-answered question that happens to share the failed control's label or family all
 * stay refused. An earlier shape of this fix filtered the failed-field list itself, which let the
 * fixed education builder type the raw profile year into a probe-failed react-select one budget
 * position BEFORE her answer reached it; the control's one attempt went to the machine value. */
function packetQuestionFailed(packet: SubmissionPacket, item: SubmissionPacket['questions'][number]): boolean {
  const target = reviewQuestionFieldTarget(item);
  const exempt = applicantChoseAnswer(item);
  return packet.failedFields?.some((field) =>
    !(exempt && applicantChosenQuestionMatchesFailedField(item, field))
    && failedFieldMatchesTarget(field, target, true)) === true;
}

function packetHasFailedReferralField(packet: SubmissionPacket): boolean {
  return packet.failedFields?.some((field) => isReferralSourceQuestion(field.label)) === true;
}

/**
 * The families the speculative alias ladders guess at.
 *
 * Separate from managedClosedFieldFamily, which is the FAILED-control matcher: widening that one
 * would change which fills a failed option read suppresses, and that is a different question with a
 * different measurement behind it. This adds the single family the graduation-date ladder needs and
 * otherwise defers to it. "graduation date" is required as a phrase so that "expected graduation
 * year" keeps falling through to the year family rather than being claimed here.
 */
function managedSpeculativeAliasFamily(label: string): string | undefined {
  const normalized = normalizedFailedFieldLabel(label);
  if (!normalized) return undefined;
  if (/\bgraduation date\b|\bdate of graduation\b/.test(normalized)) return 'education-graduation-date';
  return managedClosedFieldFamily(label);
}

/** The option list the probe actually READ for the control a reviewed question was resolved against. */
function packetReadOptionsForQuestion(
  packet: SubmissionPacket,
  item: SubmissionPacket['questions'][number],
): string[] | undefined {
  const selector = reviewQuestionPortalSelector(item);
  const controlId = managedOptionInventoryKeyFromSelector(selector);
  const options = (selector ? packet.fieldOptions?.[selector] : undefined)
    ?? (controlId ? packet.fieldOptions?.[controlId] : undefined);
  return options && options.length > 0 ? options : undefined;
}

/**
 * A GUESS FIRED AT A CONTROL THAT WAS ALREADY ANSWERED CORRECTLY, AND CANNOT BE RIGHT.
 *
 * The alias ladders below push the RAW profile value at a label: "3.89" at "GPA", "May 2028" at
 * "Graduation Date". fillByLabelText resolves a label to its own container's input, so on a form
 * whose GPA control is a list of bands this lands in the SAME react-select the resolver has just
 * filled with the exact band, "3.81 - 3.9". The raw value is not on the employer's list, so it
 * fails, and the failure is read back to her as `Litos could not leave an answer on the form: no
 * option matched "3.89"` about a field that is filled correctly.
 *
 * Measured across the five prod packets carrying that exact sentence, 2026-08-11: all five have the
 * GPA field present in filled_fields and none has a GPA required-and-empty blocker. Five false
 * alarms, zero real ones.
 *
 * THE CONDITION IS DELIBERATELY THE PROVABLE ONE, not "some question mentions GPA". All four of
 * these have to hold, and the fourth is what makes this safe:
 *
 *   1. a reviewed question names the same control, by exact label or shared closed-field family;
 *   2. that question is not itself suppressed as a failed control, because then the ladder is the
 *      control's ONLY remaining chance and must survive;
 *   3. the option probe READ that control's list, so there is evidence rather than an assumption
 *      about what shape the control is;
 *   4. the resolver's answer is on that list and the guess is not.
 *
 * Without 3 and 4 this suppressed a plain fillByLabelText at a control the resolver only ever
 * attempts as a react-select - Databricks' graduation date is the measured example - which would
 * trade a false alarm for an actually empty field. A value the employer does not offer is the one
 * thing that can be dropped with no loss, because it could never have been accepted.
 */
function packetAnswerOutranksAliasGuess(
  packet: SubmissionPacket,
  label: string,
  guesses: readonly (string | undefined)[],
): boolean {
  const candidates = guesses.flatMap((value) => {
    const trimmed = value?.trim().toLowerCase();
    return trimmed ? [trimmed] : [];
  });
  if (candidates.length === 0) return false;
  const targetLabel = normalizedFailedFieldLabel(label);
  if (!targetLabel) return false;
  const targetFamily = managedSpeculativeAliasFamily(label);
  return packet.questions.some((item) => {
    if (packetQuestionFailed(packet, item)) return false;
    const answer = item.answer?.trim();
    if (!answer) return false;
    const answeredLabel = normalizedFailedFieldLabel(item.question);
    if (!answeredLabel) return false;
    if (answeredLabel !== targetLabel) {
      const answeredFamily = managedSpeculativeAliasFamily(item.question);
      if (!targetFamily || !answeredFamily || targetFamily !== answeredFamily) return false;
    }
    const options = packetReadOptionsForQuestion(packet, item);
    /* No list read, an answer she chose herself, and the reason the list is missing is a measured
     * probe FAILURE on her own control. Then the ladder stands down entirely: her reviewed fill is
     * the one attempt this react-select gets, and every ladder value, including one that happens to
     * equal her answer, would spend or corrupt that attempt with a value the list never vouched
     * for. Firing it anyway is the measured false alarm: Jump Trading, 2026-08-17 late,
     * `no option matched "May 2028"` reported about a control whose reviewed "Spring/Summer 2028"
     * was about to be typed.
     *
     * The probe-failure requirement is what keeps this narrow. packetReadOptionsForQuestion is also
     * undefined for every control that was simply never probed, and on those the ladder may be a
     * DIFFERENT same-family control's only fill (the Databricks free-text case in the doc above),
     * so an answer with no failed probe behind it changes nothing here. */
    if (!options) {
      return applicantChoseAnswer(item)
        && (packet.failedFields ?? []).some((field) => applicantChosenQuestionMatchesFailedField(item, field));
    }
    const offered = new Set(options.map((option) => option.trim().toLowerCase()));
    return offered.has(answer.toLowerCase()) && candidates.every((value) => !offered.has(value));
  });
}

/**
 * The one gate every speculative label-scoped alias fill passes through.
 *
 * Two independent refusals, and they are not the same fact. `packetLabelFailed` says Litos could not
 * READ this control, so guessing at it is forbidden. `packetAnswerOutranksAliasGuess` says Litos has
 * already answered it with an option the employer offers, and this guess is one it does not, so
 * firing it can only fail and lie about a field that is filled.
 *
 * Scoped to LABEL-resolved fills only. An id-scoped fill (`#school--0`, `#end-year--0`) targets a
 * fixed control the reviewed question may have nothing to do with, and suppressing one of those over
 * a same-named custom question would leave a required fixed field empty.
 */
function managedSpeculativeLabelFillSuppressed(
  packet: SubmissionPacket,
  label: string,
  ...guesses: Array<string | undefined>
): boolean {
  return packetLabelFailed(packet, label) || packetAnswerOutranksAliasGuess(packet, label, guesses);
}

function managedActionTargetsFailedField(action: ManagedBrowserAction, packet: SubmissionPacket): boolean {
  if (!packet.failedFields?.length) return false;
  if (action.text && packetLabelFailed(packet, action.text)) return true;
  if (packetHasFailedReferralField(packet) && action.label?.startsWith('greenhouse_referral')) return true;
  const fixedEducation: Array<[string, RegExp]> = [
    ['school--0', /^education_school/],
    ['degree--0', /^education_degree/],
    ['discipline--0', /^education_discipline/],
    ['end-month--0', /^education_(?:end_month|graduation_month)/],
    ['end-year--0', /^education_(?:end_year|graduation_year|expected_graduation_year)/],
  ];
  if (fixedEducation.some(([id, label]) => packetControlFailed(packet, id) && label.test(action.label ?? ''))) return true;
  const selector = action.selector ?? '';
  return packet.failedFields.some((field) => {
    if (!field.selector || selector !== field.selector) {
      const escapedId = field.controlId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!new RegExp(`(?:#${escapedId}(?![A-Za-z0-9_-])|\\[id=["']${escapedId}["']\\])`).test(selector)) return false;
    }
    /* The only actions that reach a failed control by its exact selector are the reviewed-question
     * chain's: every id-scoped builder above gates on packetControlFailed and packetQuestionFailed
     * skips machine answers at failed controls, so an action here either carries her chosen answer
     * or was suppressed before it was built. Stripping hers as a "last line" was the second half of
     * the measured Jump Trading defect. */
    return !applicantChoseAnswerForFailedField(packet, field);
  });
}

function managedFillByLabelUnlessHandled(
  actions: ManagedBrowserAction[],
  packet: SubmissionPacket,
  text: string,
  value: string | undefined,
  label: string,
) {
  if (managedSpeculativeLabelFillSuppressed(packet, text, value)) return;
  managedFillByLabel(actions, text, value, label);
}

/**
 * The applicant's own reviewed answer for the control a speculative label targets, when one exists.
 *
 * The alias ladders compute their values from PROFILE facts: "May 2028" at "Expected Graduation
 * Date". When the packet carries an answer she wrote for the same control (answer_source
 * applicant_review), that answer is the one with a claim behind it - the contract every other
 * reader honours since PR #566 - and on a closed list it is very often the employer's own wording,
 * because she read the list when she wrote it.
 *
 * This is the half packetAnswerOutranksAliasGuess deliberately does not carry. That guard stands
 * the ladder DOWN, and only on evidence: a read option list her answer is on, or a measured probe
 * failure at her own control. A control that was simply never probed keeps its ladder, because on
 * a same-family form the ladder may be a different control's only fill. What that leaves is the
 * measured DV Trading / Jump Trading shape, 2026-08-17 late: an unprobed react-select, her
 * "January 2028 - July 2028" / "Spring/Summer 2028" stored and on the employer's list verbatim,
 * and the ladder's first value - the only one a react-select's single attempt ever sees - was the
 * profile's "May 2028", which is on neither. So the ladder still fires, and her answer LEADS its
 * value list instead of being absent from it. The derived forms stay behind her answer for the
 * board that really does spell it the profile's way.
 */
function packetApplicantAnswerForLabel(packet: SubmissionPacket, label: string): string | undefined {
  const targetLabel = normalizedFailedFieldLabel(label);
  if (!targetLabel) return undefined;
  const targetFamily = managedSpeculativeAliasFamily(label);
  for (const item of packet.questions) {
    if (packetQuestionFailed(packet, item)) continue;
    if (!applicantChoseAnswer(item)) continue;
    const answeredLabel = normalizedFailedFieldLabel(item.question);
    if (!answeredLabel) continue;
    if (answeredLabel !== targetLabel) {
      const answeredFamily = managedSpeculativeAliasFamily(item.question);
      if (!targetFamily || !answeredFamily || targetFamily !== answeredFamily) continue;
    }
    return item.answer.trim();
  }
  return undefined;
}

/** The four fixed education controls, the value each will be given, and the label it reports under. */
function greenhouseEducationComboboxFields(
  packet: SubmissionPacket,
): Array<{ inputId: string; questionLabel: string; value: string | undefined; label: string }> {
  const fields: Array<{ inputId: string; questionLabel: string; ladder: string[]; label: string }> = [
    { inputId: 'school--0', questionLabel: 'School', ladder: greenhouseSchoolAliases(packet.school), label: 'education_school_combo:0' },
    { inputId: 'degree--0', questionLabel: 'Degree', ladder: greenhouseDegreeAliases(packet.degree), label: 'education_degree_combo:0' },
    { inputId: 'discipline--0', questionLabel: 'Discipline', ladder: greenhouseDisciplineAliases(packet), label: 'education_discipline_combo:0' },
    { inputId: 'end-month--0', questionLabel: 'Graduation Month', ladder: packet.graduationMonth ? [packet.graduationMonth] : [], label: 'education_end_month_combo' },
  ];
  return fields.map((field) => ({
    inputId: field.inputId,
    questionLabel: field.questionLabel,
    value: greenhouseReactSelectValue(packet, field.inputId, field.ladder),
    label: field.label,
  }));
}

/**
 * The three education controls whose menu is FETCHED when it first opens, rather than shipped with
 * the page. End date month is not one of them: its twelve rows are in the document.
 */
const GREENHOUSE_ASYNC_TAXONOMY_IDS = ['school--0', 'degree--0', 'discipline--0'] as const;

/** Open, close. Two actions is the whole cost of starting one taxonomy's fetch. */
export const MANAGED_TAXONOMY_WARM_ACTIONS_PER_CONTROL = 2;

/* ─── THE WARMING ROUND THE FILL RUN NEVER HAD ────────────────────────────────────────────────
 *
 * School, Degree and Discipline hold Greenhouse's own taxonomies, and a react-select fetches those
 * over the network the first time its menu is opened. Every consumer of that fact has been written
 * twice already: pushManagedReactSelectOptionProbeActions runs a whole round whose only purpose is
 * to make the NEXT round read a real list, and the runner allows a bounded 1200ms after it opens a
 * control and another 1200ms after it types into one.
 *
 * The discovery pass gets that warming for free, because buildManagedDiscoveryActions asks for
 * `probeOptions` and the round-one probes are pushed AHEAD of the education fills. The fill run
 * asks for no probe - it consumes the discovery pass's reads instead - so its education fill is the
 * first thing on a fresh page to touch those controls, and it is racing a network fetch with 1200ms
 * of headroom and nothing spent in front of it.
 *
 * Measured on the live Flow Traders Greenhouse form on 2026-08-09, timing the two waits the runner
 * actually depends on:
 *
 *              open menu     type the answer, wait for its row
 *   cold       school 330ms   584ms
 *              degree 680ms   965ms      <- against a 1200ms allowance
 *   warmed     school   0ms   568ms
 *              degree  26ms   603ms
 *
 * 965ms of 1200ms from a fast connection is not a margin, it is a coin toss, and it is the whole
 * explanation for '"School" is required and is still empty' arriving with the answer resolved
 * correctly in the packet and the runner reporting `no option matched "University of Southern
 * California"`. The list the matcher was handed was the one the page had rendered so far.
 *
 * So the fill run opens those three controls and presses Escape, once, immediately after the form
 * is ready - before the name, email, phone, location and resume actions, which are what turns two
 * actions of warming into a second of real elapsed time. Escape rather than a second click, for the
 * reason pushManagedReactSelectOptionProbeActions gives: clicking an open react-select closes it,
 * clicking a closed one opens it, and the warm-up must leave every control exactly as it found it.
 *
 * Only the controls this packet is actually going to fill, so a form with no discipline control or
 * an applicant with no stored degree pays nothing for it.
 */
function pushGreenhouseEducationTaxonomyWarmActions(
  actions: ManagedBrowserAction[],
  portal: SupportedPortal,
  packet: SubmissionPacket,
) {
  if (portalFamily(portal) !== 'greenhouse' || packetLooksAkuna(packet)) return;
  const willFill = new Map(greenhouseEducationComboboxFields(packet).map((field) => [field.inputId, field.value]));
  for (const inputId of GREENHOUSE_ASYNC_TAXONOMY_IDS) {
    if (!willFill.get(inputId)) continue;
    const selector = `[id="${quoteAttr(inputId)}"]`;
    actions.push({
      type: 'click',
      selector,
      label: `education_taxonomy_warm:${inputId}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
    actions.push({
      type: 'press',
      selector,
      value: 'Escape',
      label: `education_taxonomy_warm_close:${inputId}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
  }
}

function pushGreenhouseEducationComboboxActions(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  const fields = greenhouseEducationComboboxFields(packet);
  for (const field of fields) {
    if (packetControlFailed(packet, field.inputId) || packetLabelFailed(packet, field.questionLabel)) continue;
    managedGreenhouseReactSelectFill(actions, field.inputId, field.value, field.label);
  }
  if (!packetControlFailed(packet, 'end-year--0') && !packetLabelFailed(packet, 'Graduation Year')) {
    managedFill(actions, '#end-year--0', packet.graduationYear, 'education_end_year_field');
  }
}

function pushGreenhouseGraduationDateComboboxActions(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  /* Her reviewed answer leads. Looked up once against one label because all three labels below
   * share the education-graduation-date alias family, so the same question record answers each.
   * See packetApplicantAnswerForLabel for the measured defect this closes. */
  const applicantAnswer = packetApplicantAnswerForLabel(packet, 'Graduation Date');
  const values = uniqueDefined([
    applicantAnswer,
    packet.graduationDate,
    packet.graduationDate ? greenhouseGraduationBucket(packet.graduationDate) : undefined,
    packet.graduationDate ? greenhouseClosestGraduationOption(packet.graduationDate) : undefined,
  ]).slice(0, 3);
  const databricks = packetLooksDatabricks(packet);
  const labels = databricks
    ? ['What is your graduation date?']
    : ['What is your graduation date?', 'Graduation Date', 'Expected Graduation Date'];
  let index = 0;
  const selectorLimit = databricks ? 3 : QUESTION_COMBOBOX_SELECTOR_LIMIT;
  const labelPrefix = databricks ? 'databricks_graduation_date_combo' : 'education_graduation_date_combo';
  for (const label of labels) {
    // Suppressed when the resolver already answered this control with an option the employer offers:
    // these selectors are derived from the label, so they land in the SAME react-select the reviewed
    // answer is about to fill, and every value below is the stored date or a bucket of it rather
    // than a read option. The whole set is passed, so one candidate that IS on the list keeps them.
    if (managedSpeculativeLabelFillSuppressed(packet, label, ...values)) continue;
    for (const value of values) {
      for (const selector of greenhouseQuestionComboboxSelectors(label).slice(0, selectorLimit)) {
        managedGreenhouseScopedReactSelectFill(
          actions,
          selector,
          GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR,
          value,
          `${labelPrefix}:${index}:${label}`,
        );
        index += 1;
      }
    }
  }
}

function pushGreenhouseFixedQuestionComboboxActions(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  if (!packetLooksAkuna(packet)) return;
  const fixedQuestions: Array<{ label: string; value: string | undefined }> = [
    { label: 'Which University do/did you attend?', value: packet.school },
    { label: 'What education level are you currently pursuing?', value: packet.degree },
    { label: 'Graduation Month', value: packet.graduationMonth },
    { label: 'Graduation Year', value: packet.graduationYear },
    { label: 'What is your GPA?', value: packet.gpa },
  ];
  for (const item of fixedQuestions) {
    /* Same rule as the graduation ladder above: an answer she wrote for the same control leads,
     * and the profile fact becomes the fallback. Measured on the live Akuna run, 2026-08-17 late:
     * 'What is your GPA?' was typed as the profile's "3.89" while her reviewed "3.6-4.0" sat on
     * the packet, and the band list refused the number. answerIsResolved rides along so the
     * candidate builder keeps her wording ahead of its computed buckets. */
    const applicantAnswer = packetApplicantAnswerForLabel(packet, item.label);
    const value = applicantAnswer ?? item.value;
    if (managedSpeculativeLabelFillSuppressed(packet, item.label, value)) continue;
    pushGreenhouseQuestionComboboxLabelActions(
      actions,
      item.label,
      value ?? '',
      'greenhouse_fixed_question',
      packet.jdText,
      undefined,
      Boolean(applicantAnswer),
    );
  }
}

function greenhousePreferredLocationAnswer(packet: SubmissionPacket): string | undefined {
  const sourceLocations = uniqueDefined([
    packet.roleLocation,
    ...(packet.roleLocations ?? []),
  ].flatMap((value) => value?.split(/\s*;\s*/)));
  if (sourceLocations.length === 0) return undefined;
  const preferred = sourceLocations.find((value) => /\bsan\s+francisco\b/i.test(value))
    ?? sourceLocations.find((value) => /\bmountain\s+view\b/i.test(value))
    ?? sourceLocations[0];
  return abbreviatedUsLocation(preferred) ?? preferred;
}

function pushGreenhousePreferredLocationFallbackActions(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  const value = greenhousePreferredLocationAnswer(packet);
  if (!value) return;
  const labels = [
    "Please choose the single location that you're the most interested in",
    'Preferred location',
    'Location preference',
  ];
  let index = 0;
  for (const label of labels) {
    if (managedSpeculativeLabelFillSuppressed(packet, label, value)) continue;
    for (const selector of greenhouseQuestionComboboxSelectors(label).slice(0, QUESTION_COMBOBOX_SELECTOR_LIMIT)) {
      managedGreenhouseScopedReactSelectFill(
        actions,
        selector,
        GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR,
        value,
        `preferred_location_combo:${index}:${label}`,
      );
      index += 1;
    }
  }
}

function managedSelect(
  actions: ManagedBrowserAction[],
  selector: string,
  value: string | undefined,
  label: string,
  optional = true,
  timeout = MANAGED_FILL_TIMEOUT_MS,
) {
  if (!value) return;
  actions.push({ type: 'select', selector, value, label, optional, timeout });
}

// The resume upload is always optional + bounded. On a real ATS form the file input is present and
// setInputFiles returns immediately; on a branded-redirect form that lacks the selector (Jump
// Trading) an unbounded, non-optional upload waited the full 30s on setInputFiles and failed the
// whole run one step after the name/email fills were already made optional. Optional means a missing
// file input degrades to a blocker card; the run never auto-submits, so "resume not attached" is a
// safe thing to hand back to the human rather than a hard error.
function managedUpload(
  actions: ManagedBrowserAction[],
  selector: string,
  label: 'resume' | 'cover_letter' | 'transcript',
  file: Buffer | undefined,
  fileName: string | undefined,
) {
  if (!file || !fileName) return;
  actions.push({
    type: 'upload',
    selector,
    label,
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
    file: { name: fileName, mimeType: 'application/pdf', base64: file.toString('base64') },
  });
}

// Questions that are usually a checkbox, radio group or select on an ATS form, and so cannot be
// typed into. Matching on the QUESTION wording rather than the answer is the informative signal:
// "Yes" tells you nothing about the control, "Have you..." tells you a lot.
//
// Kept and exported because the direct Playwright path can still use it, but note it is NOT a
// sufficient guard on its own: it was written against "Please select all fields of study", and the
// very next run failed on "How did you hear about this job?", which reads like free text and is a
// checkbox group. Question wording cannot reliably predict a control type.
const CHOICE_QUESTION_RE =
  /^\s*(?:do|does|did|have|has|are|is|was|were|will|would|can|could|should|may|must)\s+you\b|select\s+(?:all|one|any|your)\b|please\s+select\b|which\s+of\s+the\s+following\b|\bwhat\s+year\b|\bhow\s+did\s+you\s+hear\b|\byes\s*\/\s*no\b/i;

export function isChoiceQuestion(question: string): boolean {
  return CHOICE_QUESTION_RE.test(question);
}

function shouldSkipReviewedConsentQuestion(questionText: string): boolean {
  return isLegalConsentQuestion(questionText) && /demographic data survey/i.test(questionText);
}

/* A data-RETENTION opt-in ("keep my information for future jobs"), which is NOT the routine
 * privacy acknowledgement the standing permission covers: it creates an ongoing relationship with
 * the employer's talent pool rather than acknowledging the processing this one application needs.
 * Named once because two rules read it: the recruitee/teamtailor fill skip below, and the consent
 * tick plan, which must never mistake Teamtailor's candidate[consent_given_future_jobs] wording for
 * the send-blocking acknowledgement beside it. */
const FUTURE_JOBS_RETENTION_CONSENT_RE =
  /\b(?:keep|retain|store|use)\b[\s\S]{0,120}\b(?:my|your)\s+(?:information|data)\b[\s\S]{0,120}\b(?:future|other)\s+(?:jobs?|positions?|vacancies|opportunities)\b/i;

function shouldSkipPortalConsentQuestion(family: PortalFamily, questionText: string): boolean {
  if (family === 'zoho_recruit' || family === 'bullhorn') {
    return isLegalConsentQuestion(questionText)
      || ROUTINE_APPLICANT_CONSENT_QUESTION.test(questionText)
      || /\b(?:privacy|retain|retention|store|sensitive|race|ethnicity|gender|sex|age|religion|religious|marital|pregnan(?:cy|t)|national\s+origin|genetic\s+(?:data|information)|disab(?:ility|led)|veteran|eeo|equal employment|attest|certif(?:y|ication)|acknowledg(?:e|ment)|captcha)\b/i.test(questionText);
  }
  if (family !== 'recruitee' && family !== 'teamtailor') return false;
  return isLegalConsentQuestion(questionText)
    || ROUTINE_APPLICANT_CONSENT_QUESTION.test(questionText)
    || FUTURE_JOBS_RETENTION_CONSENT_RE.test(questionText);
}

function reviewedQuestionSafetyContext(
  item: SubmissionPacket['questions'][number],
  packet: SubmissionPacket,
): string {
  const selector = reviewQuestionPortalSelector(item) ?? '';
  const inputType = reviewQuestionPortalInputType(item) ?? '';
  const atsIdentity = item.atsApiField ?? '';
  const inventoryKey = managedOptionInventoryKeyFromSelector(selector);
  const options = [
    ...(packet.fieldOptions?.[selector] ?? []),
    ...(inventoryKey ? packet.fieldOptions?.[inventoryKey] ?? [] : []),
  ];
  return [item.question, selector, inputType, atsIdentity, ...options].join(' ');
}

// Whether reviewed questions may be sent to a given provider's runner.
//
// Both providers now can. This was briefly false for 'managed' as a containment measure: that
// runner used to call fill() on every control, which throws on a checkbox or radio, and it did not
// honour the `optional` flag, so one unfillable question aborted the entire run and discarded the
// name, email, phone and resume already entered.
//
// Fixed at the source in stratus-browser-cloud (PR #6, merged and deployed 2026-07-23): every
// action is wrapped so an optional failure is stepped over, and fillByLabelText dispatches on the
// control it actually found (select -> selectOption, checkbox/radio -> check, otherwise fill), with
// option matching scoped to the question's own container. Guessing control types from question
// wording was tried here first and does not work: "How did you hear about this job?" reads like
// free text and is a checkbox group.
//
// Kept as a function rather than deleted because it is the switch to reach for if a provider
// regresses, and the history above is the reason it exists.
export function canFillReviewedQuestions(_provider: 'managed' | 'direct'): boolean {
  return true;
}

// Ashby's core identity inputs use stable `_systemfield_*` names, but LinkedIn/GitHub/portfolio are
// not among them and, when present, are custom fields whose `name` is an opaque UUID. Matching on a
// case-insensitive substring of name/aria-label/placeholder is what reliably finds them without a
// per-employer selector. Verify against a live Ashby form's rendered HTML if a real run still shows
// the URL fields empty; these were written from the naming pattern, not yet confirmed on the wire.
const ASHBY_LINKEDIN_SELECTOR =
  'input[name="_systemfield_linkedin" i], input[name*="linkedin" i], input[aria-label*="linkedin" i], input[placeholder*="linkedin" i], label:has-text("LinkedIn Profile") + div input';
const ASHBY_GITHUB_SELECTOR =
  'input[name="_systemfield_github" i], input[name*="github" i], input[aria-label*="github" i], input[placeholder*="github" i], label:has-text("GitHub") + div input';
const ASHBY_PORTFOLIO_SELECTOR =
  'input[name*="portfolio" i], input[aria-label*="portfolio" i], input[placeholder*="portfolio" i], label:has-text("Portfolio") + div input, label:has-text("Website") + div input';
// Phone controls vary more than the other identity fields. Ashby and branded Greenhouse forms
// often omit the legacy id/name while still exposing the semantic HTML type or autocomplete value.
// Keep the aria-label and placeholder alternatives exact. A broad `*=phone` match can target a
// prose screening question such as "mobile app experience", which previously caused a phone
// number to be entered into an unrelated text answer.
const SEMANTIC_PHONE_SELECTOR =
  'input[type="tel" i], input[autocomplete*="tel" i], input[aria-label="Phone" i], input[aria-label="Phone number" i], input[placeholder="Phone" i], input[placeholder="Phone number" i]';
const GREENHOUSE_FIRST_NAME_SELECTOR =
  '#first_name, input[name="job_application[first_name]"], input[autocomplete="given-name" i], input[aria-label="First Name" i], input[placeholder="First Name" i]';
const GREENHOUSE_LAST_NAME_SELECTOR =
  '#last_name, input[name="job_application[last_name]"], input[autocomplete="family-name" i], input[aria-label="Last Name" i], input[placeholder="Last Name" i]';
const GREENHOUSE_EMAIL_SELECTOR =
  '#email, input[name="job_application[email]"], input[type="email" i], input[autocomplete="email" i], input[aria-label="Email" i], input[placeholder="Email" i]';
const GREENHOUSE_PHONE_SELECTOR =
  `#phone, input[name="job_application[phone]"], ${SEMANTIC_PHONE_SELECTOR}`;
const GREENHOUSE_RESUME_SELECTOR =
  '#resume, input[type="file"][name="job_application[resume]"], input[type="file"][id*="resume" i], input[type="file"][name*="resume" i], input[type="file"][aria-label*="resume" i], label:has-text("Resume") input[type="file"]';
const ASHBY_PHONE_SELECTOR =
  `#phone, input[name="phone"], input[name="_systemfield_phone"], ${SEMANTIC_PHONE_SELECTOR}`;

// SmartRecruiters renders its "Easy Apply" form as web components (spl-input, spl-phone-field,
// spl-dropzone, ...) behind OPEN shadow roots (confirmed live, 2026-07-24, on a real Western
// Digital posting: jobs.smartrecruiters.com/oneclick-ui/company/...). Playwright's locator engine
// auto-pierces open shadow roots for plain CSS selectors, so a compound selector spanning the
// shadow boundary (e.g. the dropzone selector below) resolves without any special syntax - these
// are real ids/data-test attributes read off that live DOM, not guessed from a naming pattern.
//
// SCOPE LIMIT, on purpose: this only fills the first ("Personal information") step and stops.
// A real posting's "Next" button leads to further steps (custom questions, EEO, ...) that this
// pass does not discover or advance through - the same multi-step complexity this milestone
// explicitly carved Workday out for. clickFinalSubmit() will not find a submit control until a
// human clicks through the remaining steps, so a SmartRecruiters run always lands on
// needs_attention/blocked rather than a false "submitted" - the same safe-degradation behavior
// as every other blocker on this path, never a silent partial success.
const SMARTRECRUITERS_RESUME_SELECTOR = 'spl-dropzone[data-test="resume-upload"] input[type="file"]';
const SMARTRECRUITERS_PHONE_SELECTOR = 'spl-phone-field input[aria-label="Phone number"]';
const SMARTRECRUITERS_FIRST_NAME_SELECTOR = 'spl-input#first-name-input input';
const SMARTRECRUITERS_LAST_NAME_SELECTOR = 'spl-input#last-name-input input';
const SMARTRECRUITERS_EMAIL_SELECTOR = 'spl-input#email-input input';
const SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR = 'spl-input#confirm-email-input input';
const SMARTRECRUITERS_LINKEDIN_SELECTOR = 'spl-input#linkedin-input input';
const SMARTRECRUITERS_WEBSITE_SELECTOR = 'spl-input#website-input input';
const CONTROLLED_SMARTRECRUITERS_FIRST_NAME_SELECTOR = '[id="first-name-input"]';
const CONTROLLED_SMARTRECRUITERS_LAST_NAME_SELECTOR = '[id="last-name-input"]';
const CONTROLLED_SMARTRECRUITERS_EMAIL_SELECTOR = '[id="email-input"]';
const CONTROLLED_SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR = '[id="confirm-email-input"]';
// The controlled QA fixture is ordinary light DOM. Keep its compatibility selector isolated from
// the live adapter so it can never broaden a real SmartRecruiters page-wide phone match.
const CONTROLLED_SMARTRECRUITERS_PHONE_SELECTOR = '[aria-label="Phone number"]';
const CONTROLLED_SMARTRECRUITERS_LINKEDIN_SELECTOR = '[id="linkedin-input"]';
const CONTROLLED_SMARTRECRUITERS_WEBSITE_SELECTOR = '[id="website-input"]';
/* THE ASHBY LOCATION CONTROL, and why the obvious selector matches nothing.
 *
 * `input[name="_systemfield_location"]` was the only selector here, on both the managed and the
 * direct path, and on today's Ashby it matches ZERO elements. Read off the live Deepgram form on
 * 2026-08-09, the whole control is:
 *
 *   <div class="_fieldEntry_..." data-field-path="_systemfield_location">
 *     <label class="_heading_... _required_..." for="_systemfield_location">Current Location</label>
 *     <div class="_inputContainer_...">
 *       <input class="_input_..." placeholder="Start typing..." aria-autocomplete="list"
 *              aria-expanded="false" aria-haspopup="listbox" role="combobox" value="">
 *
 * The label's `for` still names `_systemfield_location`, which is why the name looks current, but the
 * input it points at has NEITHER an id NOR a name. So the fill was optional, matched nothing, was
 * skipped, and "location" never appeared in filled_fields - which is exactly what production packet
 * 245c827a shows, with the field left showing its "Start typing..." placeholder on the preview the
 * applicant was offered as a finished application.
 *
 * The entry's `data-field-path` is Ashby's own per-question attribute and is the durable hook. The
 * legacy name is kept AFTER it rather than dropped: a board serving an older bundle still renders it,
 * and the list costs nothing extra, because managedFill pushes ONE action for the whole thing and the
 * runner takes the first match.
 *
 * The runner recognises role="combobox" and drives the typeahead through fillCustomChoice rather than
 * typing into it, which matters here: a location typeahead that is typed at but never picked from
 * leaves the employer's own value empty while looking answered.
 */
const ASHBY_LOCATION_SELECTOR =
  '[data-field-path="_systemfield_location"] input[role="combobox"], [data-field-path="_systemfield_location"] input, input[name="_systemfield_location"]';
const ASHBY_RESUME_SELECTOR = 'input#_systemfield_resume[type="file"], input[type="file"][name="_systemfield_resume"], input[type="file"][name*="resume" i]';
const ASHBY_COVER_LETTER_SELECTOR = 'input#cover_letter[type="file"], input[type="file"][id*="cover" i], input[type="file"][name*="cover" i], input[type="file"][aria-label*="cover" i]';

// Lever's resume control, named rather than written inline in the two fill paths. It was the last
// family whose resume selector existed only as a literal inside its branch, which is precisely the
// shape that left RESUME_UPLOAD_SELECTORS with nothing to point at.
const LEVER_RESUME_SELECTOR = 'input[name="resume"][type="file"]';

function cssString(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function greenhouseQuestionSelectSelectors(label: string): string[] {
  const text = cssString(label);
  return [
    `.field:has(label:has-text("${text}")) select`,
    `div:has(> label:has-text("${text}")) select`,
    `fieldset:has(legend:has-text("${text}")) select`,
    `label:has-text("${text}") ~ select`,
    `label:has-text("${text}") + select`,
  ];
}

function greenhouseQuestionComboboxSelectors(label: string): string[] {
  const text = cssString(label);
  return [
    `.field-wrapper:has(label:has-text("${text}")) input[role="combobox"]`,
    `.field:has(label:has-text("${text}")) input[role="combobox"]`,
    `.select__container:has(> label:has-text("${text}")) input[role="combobox"]`,
    `div:has(> label:has-text("${text}")) input[role="combobox"]`,
    `fieldset:has(legend:has-text("${text}")) input[role="combobox"]`,
    `label:has-text("${text}") + div input[role="combobox"]`,
    `label:has-text("${text}") ~ div input[role="combobox"]`,
  ];
}

const GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR = '[id^="react-select-"][id$="-option-0"]:visible';

const GREENHOUSE_ALIAS_SELECT_SELECTOR_LIMIT = 1;
const QUESTION_SELECT_SELECTOR_LIMIT = 1;
const QUESTION_COMBOBOX_SELECTOR_LIMIT = 1;
const ASHBY_QUESTION_TEXT_SELECTOR_LIMIT = 9;
/**
 * The runner's own ceiling, mirrored here so a run is trimmed before it is sent rather than
 * rejected after.
 *
 * stratus-browser-cloud's normalizeManagedActions throws `TOO_MANY_ACTIONS` (HTTP 400) on
 * `actions.length > 120`, BEFORE the browser opens. Nothing runs, nothing is filled, and the caller
 * gets an error instead of a result. Keep this number equal to that one.
 */
export const MANAGED_ACTION_LIMIT = Number(process.env.LITOS_MEASURE_ACTION_LIMIT ?? 120);
export const MANAGED_FINAL_SUBMIT_SELECTOR =
  'button, input[type="submit"], input[type="button"], input[type="image"], [role="button"]';
const CONFIRM_AFTER_FILL_FIELDS = new Set(['school', 'degree']);

function pushGreenhouseManagedPreflightActions(actions: ManagedBrowserAction[]) {
  const cookieClicks = [
    '#onetrust-accept-btn-handler',
    '.onetrust-close-btn-handler',
    'button:has-text("Allow All")',
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept Cookies")',
    'button:has-text("Confirm My Choices")',
  ];
  for (const [index, selector] of cookieClicks.entries()) {
    actions.push({
      type: 'click',
      selector,
      label: `greenhouse_cookie_preflight:${index}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
  }
  actions.push({
    type: 'click',
    selector: [
      'a:has-text("Apply Now")',
      'button:has-text("Apply Now")',
      'a:has-text("Apply for this job")',
      'button:has-text("Apply for this job")',
      'a:has-text("Apply for this role")',
      'button:has-text("Apply for this role")',
      'a:has-text("Start application")',
      'button:has-text("Start application")',
    ].join(', '),
    label: 'greenhouse_open_application_form',
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
  actions.push({
    type: 'waitForSelector',
    selector: `${GREENHOUSE_EMAIL_SELECTOR}, ${GREENHOUSE_RESUME_SELECTOR}`,
    label: 'greenhouse_application_form_ready',
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
}

function questionSelectSelectors(label: string): string[] {
  const text = cssString(label);
  return [
    `label:has-text("${text}") ~ select`,
    `label:has-text("${text}") + select`,
    `fieldset:has(legend:has-text("${text}")) select`,
    `div:has(> label:has-text("${text}")) select`,
    `[role="group"]:has-text("${text}") select`,
  ];
}

function questionTextInputSelectors(label: string): string[] {
  const text = cssString(label);
  const xpathText = xpathLiteral(label);
  return [
    `label:has-text("${text}") ~ textarea`,
    `label:has-text("${text}") + textarea`,
    `label:has-text("${text}") ~ div textarea`,
    `label:has-text("${text}") + div textarea`,
    `div:has(> label:has-text("${text}")) textarea`,
    `div:has(> label:has-text("${text}")) input[type="text"]`,
    `fieldset:has(legend:has-text("${text}")) textarea`,
    `xpath=(//label[contains(normalize-space(.), ${xpathText})]/parent::*[not(self::form) and .//textarea]//textarea)[1]`,
    `xpath=(//label[contains(normalize-space(.), ${xpathText})]/parent::*/parent::*[not(self::form) and .//textarea]//textarea)[1]`,
    `xpath=(//label[contains(normalize-space(.), ${xpathText})]/parent::*/parent::*/parent::*[not(self::form) and .//textarea]//textarea)[1]`,
  ];
}

function xpathLiteral(value: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"')) return `"${value}"`;
  return `concat(${value.split("'").map((part) => `'${part}'`).join(`, "'", `)})`;
}

function ashbyQuestionTextVariants(label: string): string[] {
  const normalized = label.replace(/\s+/g, ' ').trim();
  const variants = [normalized];
  const prompt = normalized.match(/^(.{12,120}?[?!])(?:\s|$)/)?.[1]?.trim();
  const prefix = normalized.length > 120 ? normalized.slice(0, 120).replace(/\s+\S*$/, '').trim() : undefined;
  if (prompt || prefix) variants.push(prompt ?? prefix!);
  return [...new Set(variants.filter(Boolean))];
}

function ashbyQuestionTextInputSelectors(label: string): string[] {
  const selectorGroups = ashbyQuestionTextVariants(label).map(questionTextInputSelectors);
  const selectors: string[] = [];
  if (selectorGroups.length > 1) {
    const variantPriority: Array<[number, number]> = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0, 7],
      [1, 7],
      [1, 8],
      [1, 9],
      [1, 4],
    ];
    for (const [groupIndex, selectorIndex] of variantPriority) {
      const selector = selectorGroups[groupIndex]?.[selectorIndex];
      if (selector && !selectors.includes(selector)) selectors.push(selector);
      if (selectors.length >= ASHBY_QUESTION_TEXT_SELECTOR_LIMIT) break;
    }
    return selectors;
  }
  const priority = [0, 1, 7, 4, 8, 9, 2, 3, 5, 6];
  for (const index of priority) {
    if (selectors.length >= ASHBY_QUESTION_TEXT_SELECTOR_LIMIT) break;
    let pushed = false;
    for (const group of selectorGroups) {
      const selector = group[index];
      if (!selector || selectors.includes(selector)) continue;
      selectors.push(selector);
      pushed = true;
      if (selectors.length >= ASHBY_QUESTION_TEXT_SELECTOR_LIMIT) break;
    }
    if (!pushed) break;
  }
  return selectors;
}

function selectValuesForAnswer(answer: string): string[] {
  const trimmed = answer.trim();
  if (!trimmed) return [];
  const lower = trimmed.toLowerCase();
  if (lower === 'yes') return ['Yes', 'yes', '1', 'true'];
  if (lower === 'no') return ['No', 'no', '0', 'false'];
  const values = [trimmed];
  if (/\b(?:have\s+not|haven't|never)\s+(?:worked|been employed)\b/.test(lower)) {
    values.push('No', 'No, I have not', 'I have not worked there before');
  }
  if (/\b(?:have\s+not|haven't|never)\s+applied\b|\bnot\s+applied\b/.test(lower)) {
    values.push('No', 'No, I have not');
  }
  if (/\b(?:do\s+not|don't|no)\s+have\b[^.]{0,80}\b(?:offer|deadline)s?\b/.test(lower)) {
    values.push('No');
  }
  if (/\b(?:do\s+not|don't|no)\s+have\b[^.]{0,80}\b(?:market\s+making|trading\s+firm|options)\b/.test(lower)) {
    values.push('No');
  }
  if (/\bnone\s+of\s+the\s+above\b/.test(lower)) {
    values.push('None of the above', 'None');
  }
  if (/^(?:n\/?a|not applicable)$/i.test(trimmed)) {
    values.push('N/A', 'Not applicable');
  }
  return [...new Set(values)];
}

function parsedGpa(value: string): number | null {
  const match = value.match(/\b([0-4](?:\.\d+)?)\b/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function greenhouseGpaBucket(value: string): string | undefined {
  const gpa = parsedGpa(value);
  if (gpa === null) return undefined;
  if (gpa >= 3.6) return '3.6 or above (out of 4.0)';
  if (gpa >= 3.4) return '3.4 - 3.5 (out of 4.0)';
  if (gpa >= 3.1) return '3.1 - 3.3 (out of 4.0)';
  if (gpa >= 2.8) return '2.8 - 3.0 (out of 4.0)';
  if (gpa >= 2.5) return '2.5 - 2.7 (out of 4.0)';
  return '2.4 or below';
}

function greenhouseExactGpaOption(value: string): string | undefined {
  const gpa = parsedGpa(value);
  if (gpa === null) return undefined;
  if (gpa > 4) return '>4.0';
  if (gpa < 2) return '<2.0';
  return (Math.round(gpa * 10) / 10).toFixed(1);
}

function greenhouseGraduationBucket(value: string): string | undefined {
  const year = Number(value.match(/\b(20\d{2})\b/)?.[1]);
  if (!Number.isFinite(year)) return undefined;
  if (year < 2027) return 'Earlier than Fall 2027';
  if (year === 2027) {
    if (/\b(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|spring|summer)\b/i.test(value)) {
      return 'Earlier than Fall 2027';
    }
    return 'Fall 2027';
  }
  if (year === 2028 && /\b(?:jan|january|feb|february|mar|march|apr|april|may|spring)\b/i.test(value)) {
    return 'Spring 2028';
  }
  return 'Later than Summer 2028';
}

function greenhouseClosestGraduationOption(value: string): string | undefined {
  const year = Number(value.match(/\b(20\d{2})\b/)?.[1]);
  if (!Number.isFinite(year)) return undefined;
  if (year < 2025) return 'Before 2025';
  if (year > 2029) return undefined;
  const monthToken = value.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|spring|summer|fall|autumn|winter)\b/i)?.[1]?.toLowerCase();
  const month =
    !monthToken ? 12
      : /^(?:jan|feb|mar|apr|may|jun|spring|summer)/.test(monthToken) ? 6
        : 12;
  return `${month === 6 ? 'June' : 'December'} ${year}`;
}

function abbreviatedUsLocation(value: string): string | undefined {
  const stateMap: Record<string, string> = { california: 'CA', washington: 'WA' };
  const match = value.match(/^\s*([^,]+),\s*([^,]+?)(?:,\s*(?:United States|USA|US|U\.S\.))?\s*$/i);
  if (!match) return undefined;
  const city = match[1]?.trim();
  const state = match[2]?.trim();
  if (!city || !state) return undefined;
  const abbreviation = /^[A-Z]{2}$/i.test(state) ? state.toUpperCase() : stateMap[state.toLowerCase()];
  return abbreviation ? `${city}, ${abbreviation}` : undefined;
}

function cityOnlyLocation(value: string): string | undefined {
  const match = value.match(/^\s*([^,]+),\s*[^,]+(?:,\s*(?:United States|USA|US|U\.S\.))?\s*$/i);
  return match?.[1]?.trim() || undefined;
}

function isReferralSourceQuestion(question: string): boolean {
  return /\b(?:how\s+did\s+you\s+hear|referral\s+source|hear\s+about|where\s+have\s+you\s+learned\s+about|source)\b/i.test(question);
}

function greenhouseComboboxValuesForQuestion(
  question: string,
  answer: string,
  contextText = '',
  referralEvidence?: ReferralSourceEvidence,
  answerIsResolved = false,
): string[] {
  const normalizedQuestion = question.toLowerCase();
  const normalizedAnswer = answer.trim().toLowerCase();
  const normalizedContext = contextText.toLowerCase();
  const isRobloxContext = /\broblox\b/.test(normalizedQuestion) || /\broblox\b/.test(normalizedContext);
  const isAkunaContext = /\bakuna\b/.test(normalizedQuestion) || /\bakuna\b/.test(normalizedContext);
  const isImcContext = /\bimc\b/.test(normalizedQuestion) || /\bimc\b/.test(normalizedContext);
  if (isAkunaContext
    && /\bhigh\s+school\s+diploma\b|\bhigh\s+school\b[^?]{0,120}\bgraduation\b/.test(normalizedQuestion)
    && !/\b(?:spring|summer|fall|winter|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|20\d{2})\b/i.test(answer)) {
    return [];
  }
  const referralQuestion = isReferralSourceQuestion(question);
  /* HER OWN REFERRAL CHOICE LEADS, because the synonym builder throws away anything it did not think of.
   *
   * referralSourceOptionCandidates emits the job-board wordings for a stored job-board default, and
   * an answer outside that vocabulary produces an EMPTY list - which the line below turns into no
   * actions at all, so the control is never touched.
   *
   * Measured on DV Trading packet e0a0eb84, 2026-08-17. That list is LinkedIn / DV Recruitment /
   * DV Employee / DV Intern / DV Website / Student Organization / Campus Event / Word of Mouth /
   * SHRM / Other - no job-board entry exists, so her standing instruction ("Job Board every time,
   * and where the list offers Other with a detail box, Other then Litos") lands on "Other". The
   * answer was stored as "Other" with answer_source applicant_review, the synonym builder did not
   * recognise it, returned [], and the required control came back empty.
   *
   * answerIsResolved is the same gate #573 uses, and after that change it is true exactly when the
   * applicant wrote the answer or the resolver snapped it off this control's real list. Either way
   * the value has a claim behind it that a synonym table cannot improve on, so it leads and the
   * synonyms follow. A bare stored default with neither provenance still goes through the builder
   * alone, which is the relay-never-generate rule selfDeclaration.ts requires. */
  const referralValues = referralQuestion
    ? (answerIsResolved && answer.trim()
      ? uniqueDefined([answer.trim(), ...referralSourceOptionCandidates(answer, referralEvidence)])
      : referralSourceOptionCandidates(answer, referralEvidence))
    : [];
  const values = referralQuestion ? referralValues : selectValuesForAnswer(answer);
  if (referralQuestion && values.length === 0) return [];
  // The general, employer-independent ladder: education level enum, discipline family, the
  // institution name without its trailing "... School of Engineering" clause, GPA to two and one
  // decimal places, month name plus its number, term and year forms of a graduation date, and the
  // standard referral-source wordings. Appended rather than unshifted so every rule below still
  // wins the head of the list; these exist so the SECOND and THIRD attempts are useful instead of
  // absent. uniqueDefined at the end of this function dedupes against whatever they add.
  if (!referralQuestion) values.push(...profileAnswerAliases(question, answer));
  /* WHERE A COMPUTED BUCKET GOES, and it is not unconditionally the head.
   *
   * greenhouseGpaBucket and greenhouseGraduationBucket map a profile fact onto ONE employer's
   * vocabulary: "3.89" becomes "3.6 or above (out of 4.0)", "May 2028" becomes "Spring 2028". That
   * is a guess, and it is the right guess to lead with when the value in hand is a profile fact,
   * because a profile fact is rarely spelled the way a closed list spells it.
   *
   * It is the wrong guess to lead with when the value in hand was READ OFF THIS CONTROL. Measured on
   * the live IMC application 2026-08-11: the resolved answer was "January 2028 - July 2028", one of
   * the three options that control offers, and this unshift put "Spring 2028" in front of it.
   * comboboxValueLimit is 1, so the bucket was the ONLY value the form ever saw, the resolved answer
   * was never attempted, and the field came back required-and-empty. The same run turned a resolved
   * "3.81 - 3.9" into "3.6 or above (out of 4.0)".
   *
   * So the bucket ranks BEHIND such an answer and AHEAD of everything else. Behind, not gone: a
   * profile fact, a stale record and a term form the resolver wrote without seeing a list all still
   * put the bucket first, which is the case it was written for and the case Cloudflare, Databricks
   * and the Akuna fixed-question list all take. answerIsResolved is what draws that line, and it is
   * narrow on purpose: see greenhouseOptionBandAnswer.
   *
   * Only the buckets move. Every other rule below keeps the head of the list, because each of those
   * was measured to BEAT the stored answer on its own control - the self-identify wordings
   * especially, see selfIdentificationDeclineWording. */
  const pushComputedBucket = (...buckets: Array<string | undefined>) => {
    const behindAnswer = answerIsResolved
      ? values.findIndex((value) => value.trim().toLowerCase() === normalizedAnswer) + 1
      : 0;
    values.splice(Math.max(behindAnswer, 0), 0, ...buckets.map((bucket) => bucket ?? ''));
  };
  const isGraduationPartQuestion = /\bgraduat(?:ion|e)\s+(?:month|year)\b|\bwhat\s+is\s+your\s+graduation\s+(?:month|year)\b/.test(normalizedQuestion);
  if (/\bwhat\s+is\s+your\s+gpa\b|\bgpa\b|academic\s+performance|grade\s+average|grade\s+point/.test(normalizedQuestion)) {
    pushComputedBucket(greenhouseGpaBucket(answer));
    if (isAkunaContext) pushComputedBucket(greenhouseExactGpaOption(answer));
  }
  if (/\bclosest\s+date\b|\bgraduate\s+or\s+complete\s+your\s+program\b/.test(normalizedQuestion)) {
    pushComputedBucket(greenhouseClosestGraduationOption(answer) ?? greenhouseGraduationBucket(answer));
  }
  if (!isGraduationPartQuestion && /\bgraduat(?:ion|e)\s+(?:date|semester|term|time\s*frame|timeframe|window|month|year)\b|\bwhat\s+is\s+your\s+graduation\s+(?:date|month|year)\b|\bexpected\s+graduat(?:ion|e)|\bexpect(?:ing)?\s+to\s+graduat(?:e|ion)\b|\bgraduate\s+or\s+complete\s+your\s+program\b/.test(normalizedQuestion)) {
    const closestDateQuestion = /\bclosest\s+date\b|\bgraduate\s+or\s+complete\s+your\s+program\b/.test(normalizedQuestion);
    if (closestDateQuestion) {
      pushComputedBucket(greenhouseClosestGraduationOption(answer) ?? greenhouseGraduationBucket(answer));
    } else {
      pushComputedBucket(greenhouseGraduationBucket(answer), greenhouseClosestGraduationOption(answer));
    }
    if (/\bexpecting\s+to\s+graduat(?:e|ion)\b/.test(normalizedQuestion)) pushComputedBucket(answer.match(/\b20\d{2}\b/)?.[0]);
  }
  if (/\bdegree\b/.test(normalizedQuestion) && /\bbachelor/i.test(answer)) {
    const wantsCompactBachelor = /\b(?:currently\s+pursuing|pursuing|enrolled\s+in\s+university)\b/.test(normalizedQuestion)
      && !/\bdegree--\d+\b/.test(normalizedQuestion);
    values.unshift(wantsCompactBachelor ? 'Bachelor\'s' : 'Bachelor\'s Degree');
    values.push(wantsCompactBachelor ? 'Bachelor\'s Degree' : 'Bachelor\'s');
  }
  if (/\beducation\s+level\b|\blevel\s+of\s+education\b/.test(normalizedQuestion) && /\bbachelor/i.test(answer)) {
    values.unshift(isAkunaContext ? 'Bachelors' : 'Bachelor\'s');
    values.push(isAkunaContext ? 'Bachelor\'s' : 'Bachelors');
  }
  if (/\b(?:discipline|field\s+of\s+study|major|course)\b/.test(normalizedQuestion) && /computer science/i.test(answer)) {
    values.unshift('Computer Science');
  }
  if (/\b(?:current\s+year|year\s+of\s+(?:your\s+)?stud(?:y|ies)|academic\s+year)\b/.test(normalizedQuestion)) {
    values.unshift(answer.replace(/\s+year$/i, ''), answer);
  }
  if (referralQuestion) {
    const hasEmployerSiteEvidence = referralEvidence?.kind === 'employer_career_site'
      && referralEvidence.value === 'Company website';
    if (hasEmployerSiteEvidence && /\bsamsara\b/.test(normalizedQuestion + ' ' + normalizedContext)) {
      values.unshift('Samsara Careers Site');
    }
    if (hasEmployerSiteEvidence && /\bwhere\s+have\s+you\s+learned\s+about\s+samsara\b/.test(normalizedQuestion)) {
      values.unshift('Samsara blog or website');
    }
    if (hasEmployerSiteEvidence && isRobloxContext && /\bhow\s+did\s+you\s+first\s+hear\s+about\s+this\s+role\b/.test(normalizedQuestion)) {
      values.unshift('Roblox Careers Site');
    }
  }
  if (/\bpreferred\s+coding\s+language\b|\binterview\b[^?]{0,120}\bcoding\s+language\b/.test(normalizedQuestion)) {
    if (/\bpython\b/.test(normalizedAnswer)) values.unshift('Python 3');
  }
  if (isRobloxContext
    && /\bjob\s+applicant\s+privacy\s+notice\b/.test(normalizedQuestion)
    && /^(?:yes|i\s+agree|agree|acknowledge(?:d)?|confirm(?:ed)?|understood|read)/i.test(answer.trim())) {
    values.unshift('I acknowledge that I have read and understood Roblox\'s Job Applicant Privacy Notice.');
  }
  if (!isImcContext && /\bgender\s+identity\b/.test(normalizedQuestion) && /^female$/i.test(answer.trim())) {
    values.unshift('Woman');
  }
  if (/\brace\/ethnicity\b|\brace\b|\bethnicit/.test(normalizedQuestion) && /decline|self-ident/i.test(answer.trim())) {
    values.unshift('Decline To Self Identify', 'Decline to self-identify', 'I don\'t wish to answer');
  }
  /* THE ONE ATTEMPT HAS TO BE THE RIGHT ONE.
   *
   * comboboxValueLimit below is 1 for the ordinary question, so exactly one of these values ever
   * reaches the page and every alias after it is decoration. That is why the twenty measured
   * "are you hispanic/latino? hispanic_ethnicity" failures could not recover: the stored
   * "Decline to self-identify" went out alone against a list reading "Decline To Self Identify",
   * and the unhyphenated spelling further down the ladder was never tried.
   *
   * The unshift is last so it takes index 0 when it applies, and it applies only when the label
   * names the control's vocabulary and the answer is already a refusal, so the value it puts in
   * front of her own words is the same refusal in the list's own spelling. See
   * selfIdentificationDeclineWording. */
  const selfIdDecline = isDeclineToState(answer) ? selfIdentificationDeclineWording(question) : undefined;
  if (selfIdDecline) values.unshift(selfIdDecline);
  if (/\bveteran\b/.test(normalizedQuestion) && /^no$/i.test(answer.trim())) {
    values.unshift('I am not a protected veteran');
  }
  if (/\bdisability\b|\bimpairment\b/.test(normalizedQuestion) && /^no$/i.test(answer.trim())) {
    values.unshift('No, I do not have a disability and have not had one in the past');
  }
  if (/^processing\s+of\s+personal\s+data$/i.test(question.trim()) && /^(?:yes|acknowledge|acknowledge\/confirm|confirm)$/i.test(answer.trim())) {
    values.unshift('Acknowledge/Confirm');
  }
  if (/\bwhich\s+(?:school|university|college|institution)\b|\b(?:school|university|college|institution)\b[^?]{0,80}\b(?:name|attend|enrolled\s+in)\b/.test(normalizedQuestion)
    && !/\bgraduat(?:ion|e)\b|\bexpect\s+to\s+graduat(?:e|ion)\b|\bgraduate\s+or\s+complete\b/.test(normalizedQuestion)) {
    values.unshift(...greenhouseSchoolAliases(answer));
  }
  if (/\b(?:country|currently\s+residing|current\s+location|where\s+are\s+you\s+currently\s+(?:located|living|based))\b/.test(normalizedQuestion)) {
    values.unshift(answer, cityOnlyLocation(answer) ?? '');
  }
  if (/\b(?:single|top|preferred|preference|most interested)\b[^?]{0,120}\blocation\b|\blocation\b[^?]{0,120}\b(?:single|top|preferred|preference|most interested)\b/.test(normalizedQuestion)) {
    values.unshift(abbreviatedUsLocation(answer) ?? '', cityOnlyLocation(answer) ?? '');
  }
  if (/\bpreviously\s+worked\b|\bworked\s+for\s+databricks\b/.test(normalizedQuestion)
    && (/\b(?:have\s+not|haven't|never)\b.{0,80}\b(?:worked|work|been employed)\b/.test(answer.toLowerCase())
      || /\bnone\s+of\s+(?:it|this)\s+has\s+been\s+with\s+databricks\b/.test(answer.toLowerCase()))) {
    values.unshift('No');
  }
  if (/\bapplied\b[^?]{0,120}\b(?:past|previously|before|role|position)\b/.test(normalizedQuestion)
    && (/^(?:no|false|0)\b/.test(normalizedAnswer)
      || /\b(?:have\s+not|haven't|never)\s+applied\b|\bnot\s+applied\b/.test(answer.toLowerCase()))) {
    values.unshift('No');
  }
  if (/\boffer\s+deadlines?\b/.test(normalizedQuestion)
    && /\b(?:do\s+not|don't|no)\s+have\b[^.]{0,80}\b(?:offer|deadline)s?\b/.test(answer.toLowerCase())) {
    values.unshift('No');
  }
  if (/\b(?:options\s+market\s+making|trading\s+firm)\b/.test(normalizedQuestion)
    && /\b(?:do\s+not|don't|no)\s+have\b[^.]{0,80}\b(?:market\s+making|trading\s+firm|options)\b/.test(answer.toLowerCase())) {
    values.unshift('No');
  }
  if (/\bcurrent\s+immigration\s+status\b|\bwork\s+authorization\/status\b/.test(normalizedQuestion)) {
    if (/\bf-?1\b|\bcpt\b/.test(normalizedAnswer)) values.unshift('F-1 CPT');
    if (/\bopt\b/.test(normalizedAnswer) && !/\bstem\b/.test(normalizedAnswer)) values.unshift('F-1 OPT');
    if (/\bstem\b/.test(normalizedAnswer)) values.unshift('F-1 STEM');
    if (/n\/?a|not applicable|do not require work authorization|do not require sponsorship/i.test(answer)) {
      values.unshift('N/A (I do not require work authorization)');
    }
  }
  if (/\bresume\b[^?]{0,80}\bpdf\s+format\b/.test(normalizedQuestion)
    && /^(?:yes|true|1|i\s+acknowledge|acknowledge|confirm)/i.test(answer.trim())) {
    values.unshift('Yes');
  }
  if (/\bcertify\b[^?]{0,120}\b(?:true|complete|accurate)\b/.test(normalizedQuestion)
    && /^(?:yes|true|1|i\s+certify|certify|confirm)/i.test(answer.trim())) {
    values.unshift('Yes');
  }
  if (/\btop\s+preference\b|\banswering\s+[“"]?yes[”"]?\s+below\b/.test(normalizedQuestion)
    && /^(?:yes|true|1|i\s+acknowledge|acknowledge|confirm)/i.test(answer.trim())) {
    values.unshift('Yes');
  }
  if (/legally\s+authorized\s+to\s+work|authori[sz](?:ed|ation)\s+to\s+work|work\s+authori[sz]/.test(normalizedQuestion)) {
    const negative = /^(?:no|false|0)\b/.test(normalizedAnswer) || /\bnot\s+authori[sz]ed\b/.test(normalizedAnswer);
    const affirmative = /^(?:yes|true|1)\b/.test(normalizedAnswer) || (!negative && /\bauthori[sz]ed\b/.test(normalizedAnswer));
    if (negative) {
      values.unshift('No');
    } else if (affirmative) {
      values.unshift('Yes');
      values.push(
        'Yes, I am authorized to work in the country where this job is located',
        'Yes, I am authorized to work in the country where the job is located',
        'Yes, I am authorized to work in the United States',
      );
    }
  }
  return uniqueDefined(values);
}

/**
 * The wordings somebody has met and written down. Kept, and no longer the whole test.
 *
 * Every entry here is one employer's exact phrasing. That is what it is good at - "worked for
 * databricks", "AI Policy for Interviewers", "majoring in STEM" are not a class of question, they
 * are strings, and a pattern is the only honest way to hold them. What it is bad at is the ordinary
 * case: an employer asking a question this codebase already understands, in words nobody happened
 * to type here. See isGreenhouseReactSelectQuestion for the rung that covers that.
 */
const GREENHOUSE_REACT_SELECT_LITERALS =
  /\b(?:single|top|preferred|preference|most interested)\b[^?]{0,120}\blocation\b|\btop\s+preference\b|\banswering\s+[“"]?yes[”"]?\s+below\b|\bwhat\s+is\s+your\s+graduation\s+date\b|\bgraduat(?:ion|e)\s+(?:date|semester|term|time\s*frame|timeframe|window|month|year)\b|\bexpected\s+graduat(?:ion|e)\b|\bexpect(?:ing)?\s+to\s+graduat(?:e|ion)\b|\bgraduate\s+or\s+complete\s+your\s+program\b|\bwhat\s+is\s+your\s+gpa\b|\bacademic\s+performance\b|\beducation\s+level\b|\blevel\s+of\s+education\b|\bdegree\b(?!\s+program)|\bdiscipline\b|\bfield\s+of\s+study\b|\bmajor\b|\bcourse\b|\bschool\b|\buniversity\b|\bcurrent\s+year\b|\byear\s+of\s+(?:your\s+)?stud(?:y|ies)\b|\bacademic\s+year\b|\bhow\s+did\s+you\s+hear\b|\breferral\s+source\b|\bhear\s+about\b|\bwhere\s+have\s+you\s+learned\s+about\b|\bsource\b|\bsource\s+of\b|\bcountry\b|\bcurrent\s+location\b|\bwhere\s+are\s+you\s+currently\s+(?:located|living|based)\b|\b(?:live|reside|located)\b[^?]{0,80}\b(?:new\s+york|california)\b|\bpreviously\s+worked\b|\bworked\s+for\s+databricks\b|\bapplied\b[^?]{0,120}\b(?:past|previously|before|role|position)\b|\boffer\s+deadlines?\b|\bprior\s+experience\b[^?]{0,120}\b(?:options\s+market\s+making|trading\s+firm)\b|\bcurrent\s+immigration\s+status\b|\bwork\s+authorization\/status\b|legally\s+authorized\s+to\s+work|(?:require|need)\s+(?:visa\s+)?sponsorship|sponsorship\s+for\s+(?:employment\s+visa|work\s+authorization)|\bsponsor\b[^?]{0,80}\bwork\s+authorization\b|\b(?:are|will)\s+you\s+available\b[^?]{0,160}\b(?:internship|full-time|40\s*hours|weeks?)\b|\b(?:internship|full-time|40\s*hours|weeks?)\b[^?]{0,160}\b(?:are|will)\s+you\s+available\b|\bpreferred\s+coding\s+language\b|\bcoding\s+language\b[^?]{0,120}\bpreference\b|\bjob\s+applicant\s+privacy\s+notice\b|\b(?:candidate|applicant)\s+privacy\s+(?:policy|notice)\b|\bprocessing\s+of\s+personal\s+data\b|\bAI\s+Policy\s+for\s+Interviewers\b|\bmajoring\s+in\s+STEM\b|\bresume\b[^?]{0,80}\bPDF\s+format\b|\bcertify\b[^?]{0,120}\b(?:information|true|complete|accurate)\b|\barea\s+of\s+interest\b|\bteam\s+opening\b|\bopening\b[^?]{0,80}\binterested\b|\bLGBTQIA?\+?\b|sexual\s+orientation|\bgender(?:\s+identity)?\b|\bveteran\b|\bmilitary\b|\brace\b|\bethnicit|\bcategory\b/i;

/**
 * The closed-list profile fields a Greenhouse form renders as a react-select.
 *
 * Every key here was ALREADY reachable through GREENHOUSE_REACT_SELECT_LITERALS for at least one
 * wording - "what is your gpa", "graduation year", "school", "degree", "major". Naming the field
 * instead of the sentence is what stops the list from being one employer's phrasing wide. It adds
 * no new CATEGORY of control, only the other ways of asking for the same thing.
 *
 * Deliberately not here: phone, the URL fields, city, state, salary, date of birth, the employer
 * fields. Greenhouse renders those as text inputs, and pushing a combobox chain at a text input
 * spends action budget on a control that will never open a menu.
 */
const GREENHOUSE_REACT_SELECT_PROFILE_KEYS: ReadonlySet<ProfileKey> = new Set<ProfileKey>([
  'gpa', 'gpa_scale',
  'graduation_date', 'graduation_month', 'graduation_year',
  'education_start_date', 'education_end_date',
  'school', 'degree', 'major', 'study_year', 'current_enrollment',
]);

/**
 * A wording somebody has already met, and knows renders as a react-select.
 *
 * This is the STRONG claim: not just "a menu may be here" but "a plain text fill is the wrong
 * thing for this control". It is what decides to WITHHOLD the scoped text fill, so it stays exactly
 * as wide as the evidence behind it - one employer's measured phrasing - and no wider. Widening it
 * would take the text fill away from controls nobody has ever looked at.
 */
function isGreenhouseReactSelectQuestion(question: string): boolean {
  return GREENHOUSE_REACT_SELECT_LITERALS.test(question);
}

/**
 * MIGHT THIS CONTROL BE A CLOSED LIST? Answered from the QUESTION, not from its wording.
 *
 * The literals used to be the whole test, and the corpus says what that costs. Measured over the
 * owner's 158 packets on 2026-08-11: 22 were blocked with a GPA field required and empty while the
 * packet already carried "3.89". Ten asked "What is your GPA?", which is in the literals and was
 * recognised. The other twelve asked "Overall GPA" (Virtu, 7) and "Please indicate your overall
 * GPA." (Five Rings, 5), which are not, so no combobox chain was ever built for them and the only
 * attempt they got was a text fill into a control whose options read "3.5-3.9".
 *
 * classifyField called all three of those labels `gpa`. The resolver has understood them the whole
 * time - it is how "3.89" got into the packet - and only the fill pass had not. So the fix is not
 * to add two more strings, which leaves the next employer's third phrasing exactly as broken; it is
 * to ask the question-classifier the codebase already has, the same one resolveKnownAnswer asks,
 * and stop keeping two disagreeing definitions of what a question means.
 *
 * THIS IS THE WEAK CLAIM AND IT IS ONLY EVER ADDITIVE. It gates whether a combobox chain is also
 * pushed; it never withholds anything. A control that turns out to be a plain text box still gets
 * its text fill, because isGreenhouseReactSelectQuestion above - not this - is what suppresses that.
 * The cost of being wrong here is a few spent actions, not an unfilled field.
 */
function questionMayBeClosedList(question: string): boolean {
  if (GREENHOUSE_REACT_SELECT_LITERALS.test(question)) return true;
  const key = classifyField(question);
  return key !== null && GREENHOUSE_REACT_SELECT_PROFILE_KEYS.has(key);
}

function isSamsaraLearnedAboutQuestion(question: string): boolean {
  return /\bwhere\s+have\s+you\s+learned\s+about\s+samsara\b/i.test(question);
}

/**
 * A Greenhouse education-row combobox: School, Degree, Discipline.
 *
 * The `--0` handle was the only test here, and PR #361 removed the very thing it keys on:
 * normalizeDiscoveredLabel now strips `discipline--0` out of the stored question text (that strip
 * is correct, it is what makes `label:has-text(...)` match the employer's own label). The
 * consequence was silent: the stored question reads "discipline", this returned false, and the
 * reviewed-question education path stopped running on exactly the fields it exists for. So the
 * NORMALIZED spellings are tested too.
 */
function isGreenhouseEducationComboboxQuestion(question: string): boolean {
  return /\b(?:school|degree|discipline)--\d+\b/i.test(question)
    || /^(?:school|degree|discipline)\b[\s*:]*$/i.test(question.trim());
}

function isRoutineCandidatePrivacyAcknowledgement(question: string): boolean {
  return /\bplease\s+review\s+and\s+acknowledg\w*\b[\s\S]{0,120}\b(?:candidate|applicant)\s+privacy\s+(?:policy|notice)\b/i.test(question)
    || (/\b(?:candidate|applicant)\s+privacy\s+(?:policy|notice)\b/i.test(question)
      && /\b(?:acknowledg\w*|confirm|agree|consent)\b/i.test(question));
}

function pushGreenhouseQuestionComboboxActions(
  actions: ManagedBrowserAction[],
  selector: string,
  questionText: string,
  answer: string,
  labelPrefix: string,
  contextText = '',
  referralEvidence?: ReferralSourceEvidence,
  answerIsResolved = false,
  knownClosedList = false,
) {
  if (!knownClosedList && !questionMayBeClosedList(questionText)) return;
  const selectors = [selector];
  if (isSamsaraLearnedAboutQuestion(questionText)) {
    selectors.push(
      `${selector} input[role="combobox"]`,
      `${selector} [role="combobox"]`,
      `input[role="combobox"]:right-of(${selector})`,
    );
  }
  const valueLimit = comboboxValueLimit(questionText, contextText);
  // The label's own escape hatch, appended last, exactly as the label-scoped builder does it. This
  // branch is the one a question with a durable selector actually takes, so without it the hatch
  // was unreachable for precisely those questions. See greenhouseComboboxCandidateValues.
  const candidates = greenhouseComboboxCandidateValues(
    questionText,
    answer,
    contextText,
    valueLimit,
    referralEvidence,
    answerIsResolved,
  );
  for (const [index, value] of candidates.entries()) {
    for (const [selectorIndex, inputSelector] of selectors.entries()) {
      managedGreenhouseScopedReactSelectFill(
        actions,
        inputSelector,
        GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR,
        value,
        `${labelPrefix}_combo:${index}:${selectorIndex}:${questionText.slice(0, 80)}`,
      );
    }
  }
}

/**
 * How many alias forms one combobox is worth attempting.
 *
 * Deliberately still 1 for the ordinary case. Each attempt costs several actions against
 * MANAGED_ACTION_LIMIT, and the budget is already tight enough that Greenhouse has a dedicated
 * trimming pass; widening this across the board pushed real fills out of the run. The ladder in
 * profileFieldResolution.ts is therefore spent where it is free: on the direct-Playwright path,
 * which reads the control's real options and snaps, and on any question this already widened.
 *
 * AND A SECOND REASON, WHICH IS THE STRONGER ONE. Raising this was considered while fixing the
 * resolved-answer ordering above, so a bucket could be tried after the resolved answer rather than
 * instead of it, and it was rejected on inspection of what a second attempt actually does.
 *
 * managedGreenhouseScopedReactSelectFill emits an unconditional five-action sequence per candidate:
 * click the input open, fill the value, click the option whose text matches, click
 * GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR, press Enter. Every one is `optional: true`, and
 * the action list is a flat script the remote runner executes start to finish - there is no
 * verification helper anywhere that gates a later candidate on an earlier one having failed, and no
 * way to express "stop here" in a ManagedBrowserAction.
 *
 * So a SECOND candidate after a successful first one reopens a control that is already correctly
 * committed and clicks `[id^="react-select-"][id$="-option-0"]:visible` - option ZERO of whatever
 * menu is now open, which is not the value being attempted and need not be related to it at all.
 * That is exactly the "a failed attempt leaves a wrong selection behind" hazard, and it is not
 * hypothetical: option-0 is a positional selector with no text match in it.
 *
 * Ordering the resolved answer first, with the limit left at 1, fixes the measured IMC symptom on
 * its own. Widening this is a separate change that needs the runner to learn a conditional first.
 */
function comboboxValueLimit(questionText: string, contextText: string): number {
  return /\bdatabricks\b/i.test(`${questionText}\n${contextText}`)
    && /\bgraduat(?:ion|e)\b|\bexpect(?:ing)?\s+to\s+graduat(?:e|ion)\b|\bgraduate\s+or\s+complete\s+your\s+program\b/i.test(questionText)
    ? 3
    : 1;
}

/**
 * The option a control's OWN LABEL tells you to pick when your real answer is not on its list.
 *
 * Measured on the live Virtu Software Engineer Internship form, 2026-08-09, read-only. Its question
 * "Which university are you currently attending? Select "Other" if not listed" is not the Greenhouse
 * school taxonomy at all: it is a curated list of fifteen schools (Caltech, Carnegie Mellon, Georgia
 * Tech, Harvard, Howard, Michigan, MIT, Princeton, Rice, Tufts, UChicago, UT Austin, Waterloo, Yale)
 * plus "Other". The applicant's university is genuinely absent, so every candidate value matched
 * nothing and the field came back required-and-empty on a form that had told us what to do about it.
 *
 * "Other" here is not a near-miss and not a guess. It is the accurate answer, and it is the answer
 * the employer asked for in the label. The rule is therefore narrow on purpose: the escape hatch is
 * offered ONLY when the label advertises it in so many words, and it is always the LAST candidate,
 * so it can only be reached after every real value has failed to match. The runner will not undo an
 * earlier correct choice to try it, and will not select it unless the control really offers it.
 *
 * No employer is named. Any board whose label says "if not listed" gets the same treatment.
 */
const ESCAPE_HATCH_LABEL_RE =
  /\b(?:select|choose|pick|use|enter)\b[^.?!]{0,40}["'“”]?\bother\b["'“”]?[^.?!]{0,40}\b(?:if\s+(?:it\s+is\s+|its\s+|your\s+\w+\s+is\s+)?not\s+(?:listed|shown|available|an\s+option|on\s+(?:the|this)\s+list)|if\s+not\s+found)/i;

export function escapeHatchOptionFor(questionText: string): string | undefined {
  return ESCAPE_HATCH_LABEL_RE.test(questionText.replace(/\s+/g, ' ')) ? 'Other' : undefined;
}

/**
 * The candidate values for one combobox, with the label's own escape hatch appended last.
 *
 * SHARED BY BOTH COMBOBOX BUILDERS, because it was not, and that is what undid the fix above.
 * There are two of them - one scoped by the control's own selector
 * (pushGreenhouseQuestionComboboxActions) and one scoped by the employer's label text
 * (pushGreenhouseQuestionComboboxLabelActions) - and the hatch was added only to the second.
 *
 * That is invisible until discovery starts reporting a durable selector for a question, at which
 * point buildManagedPortalActions takes the id-scoped branch and `continue`s, and the label-scoped
 * builder is never reached. Measured on Virtu, 2026-08-08: "Which university are you currently
 * attending? Select "Other" if not listed" was answered "Other" on the run before, then went back
 * to required-and-empty on both runs after, with an action list carrying only "University of
 * Southern California" and "University of Southern California, Viterbi School of Engineering" -
 * neither of which is on that form's fifteen-school list. Not the action budget: the trimmed and
 * untrimmed lists for that packet are identical here.
 *
 * The slice happens before the append, exactly as it does below, so the hatch can only ever be
 * reached after every real value has failed to match.
 */
function greenhouseComboboxCandidateValues(
  questionText: string,
  answer: string,
  contextText: string,
  valueLimit: number,
  referralEvidence?: ReferralSourceEvidence,
  answerIsResolved = false,
): string[] {
  const values = greenhouseComboboxValuesForQuestion(questionText, answer, contextText, referralEvidence, answerIsResolved);
  const sliced = values.slice(0, valueLimit);
  const escapeHatch = escapeHatchOptionFor(questionText);
  if (!escapeHatch || sliced.some((value) => value.trim().toLowerCase() === escapeHatch.toLowerCase())) return sliced;
  return [...sliced, escapeHatch];
}

function pushGreenhouseQuestionComboboxLabelActions(
  actions: ManagedBrowserAction[],
  questionText: string,
  answer: string,
  labelPrefix: string,
  contextText = '',
  referralEvidence?: ReferralSourceEvidence,
  answerIsResolved = false,
) {
  if (!questionMayBeClosedList(questionText)) return;
  let index = 0;
  const valueLimit = comboboxValueLimit(questionText, contextText);
  // The slice happens inside, before the hatch is appended. Running the pair through uniqueDefined
  // instead also dropped the empty strings the slice can contain, which promoted a value from past
  // the limit into first place and emitted a fill where the old code deliberately emitted none.
  const values = greenhouseComboboxCandidateValues(
    questionText,
    answer,
    contextText,
    valueLimit,
    referralEvidence,
    answerIsResolved,
  );
  for (const selector of greenhouseQuestionComboboxSelectors(questionText).slice(0, QUESTION_COMBOBOX_SELECTOR_LIMIT)) {
    for (const value of values) {
      const compactKnownLabel = /^(?:greenhouse_fixed_question|greenhouse_known_question|greenhouse_akuna_attestation)$/.test(labelPrefix);
      managedGreenhouseScopedReactSelectFill(
        actions,
        selector,
        compactKnownLabel ? undefined : GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR,
        value,
        `${labelPrefix}_combo_label:${index}:${questionText.slice(0, 80)}`,
      );
      index += 1;
    }
  }
}

function pushGreenhouseDemographicComboboxLabelActions(
  actions: ManagedBrowserAction[],
  label: string,
  value: string,
) {
  for (const [index, selector] of greenhouseQuestionComboboxSelectors(label).slice(0, QUESTION_COMBOBOX_SELECTOR_LIMIT).entries()) {
    managedGreenhouseScopedReactSelectFill(
      actions,
      selector,
      GREENHOUSE_VISIBLE_REACT_SELECT_OPTION_SELECTOR,
      value,
      `greenhouse_demographic_combo:${index}:${label.slice(0, 80)}`,
    );
  }
}

/**
 * The referral-source label, in the only form that survives contact with a real employer.
 *
 * This list used to name the employer: "How did you hear about Faire?", "How did you hear about
 * us?", "How did you hear about this job?", "Referral source". Every Greenhouse customer writes its
 * OWN name into that question, so the list answered exactly one company. Measured on the Anduril
 * run of 2026-08-08: the employer asks "How did you hear about Anduril?", nothing here matched it,
 * and the field came back required-and-empty with "Company website" already resolved in the packet.
 * Virtu's "How did you hear about this internship?" missed for the same reason.
 *
 * The question's OWN label does get its own action group elsewhere, and that is not a safety net:
 * `question_combo_label:.*how did you hear` is on GREENHOUSE_LOW_PRIORITY_ACTION_GROUPS, so it is
 * the first thing dropped when the action list exceeds its budget, which the Anduril packet did
 * (it built exactly 120 actions).
 *
 * These are PREFIXES, not whole labels. Playwright's `:has-text()` is a case-insensitive substring
 * match, so "How did you hear about" scopes to "How did you hear about Anduril?" and to every other
 * employer's spelling of it. Verified against the live Anduril DOM: the field-wrapper scope built
 * from this prefix resolves to the referral combobox and to nothing else on the page.
 */
const GREENHOUSE_REFERRAL_LABEL_PREFIXES = [
  'How did you hear about',
  'How did you first hear about',
  'Where did you hear about',
  'Where have you learned about',
  'Referral source',
] as const;

function pushGreenhouseReferralSourceAliases(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  if (packetHasFailedReferralField(packet)) return;
  /* THE LABEL PASS RUNS LAST, SO WHATEVER IT TYPES IS WHAT THE EMPLOYER GETS.
   *
   * It typed packet.referralSourceDefault unconditionally. The question-scoped pass a few hundred
   * lines up already resolves this control from the packet question - including, since #573 and
   * #574, an answer the applicant chose herself - and then this ran afterwards and overwrote it with
   * the default.
   *
   * Measured on Five Rings packet 2231fc73 and DV Trading e0a0eb84, 2026-08-17. Neither employer's
   * referral list carries a job-board entry (Five Rings: Coffee Chat / Conference / GitHub /
   * Handshake / LinkedIn / Student Organization Newsletter or Event / University Career Fair /
   * Word of Mouth / Information Session / Other), so her standing instruction lands on "Other". The
   * packet held "Other" with answer_source applicant_review, and the run still reported
   * `no option matched "Job board"` on a required control, because this pass typed the default over
   * it. Both applications were otherwise complete - 22 and 25 fields filled.
   *
   * So the two passes now agree: her choice leads here exactly as it leads there, and a packet with
   * no applicant referral answer still gets the default, which is every case this pass was written
   * for. */
  const applicantReferral = packet.questions.find((item) => {
    const label = normalizeReviewQuestionLabel(item.question);
    return Boolean(label) && isReferralSourceQuestion(label) && applicantChoseAnswer(item);
  });
  const value = applicantReferral?.answer.trim() || packet.referralSourceDefault?.trim();
  if (!value) return;
  for (const alias of GREENHOUSE_REFERRAL_LABEL_PREFIXES) {
    pushGreenhouseQuestionComboboxLabelActions(
      actions,
      alias,
      value,
      'greenhouse_referral',
      '',
      packet.referralSourceEvidence,
      /* Carrying HER provenance through, not just her string.
       *
       * Passing the value alone was not enough: the builder this calls routes a referral question
       * through referralSourceOptionCandidates, which reads the job-board evidence and emits the
       * job-board wordings regardless of the value handed to it. So "Other" went in and
       * "Job board" came out, and the measured failure was unchanged. answerIsResolved is the flag
       * that makes her answer lead there (see #574), and it has to travel with it. */
      Boolean(applicantReferral),
    );
  }
}

function greenhouseCheckboxOptionSelectors(questionText: string, answer: string): string[] {
  const normalizedQuestion = questionText.toLowerCase();
  const normalizedAnswer = answer.toLowerCase();
  if (
    isRoutineCandidatePrivacyAcknowledgement(questionText)
    && /^(?:yes|i\s+agree|agree|acknowledge(?:d)?|confirm(?:ed)?|acknowledge\/confirm)$/i.test(answer.trim())
  ) {
    return [
      'label:has-text("Acknowledge/Confirm") input[type="checkbox"]',
      'input[type="checkbox"]:left-of(label:has-text("Acknowledge/Confirm"))',
      'input[type="checkbox"][name^="question_"][name$="[]"]',
    ];
  }
  if (
    /sanctions\s+and\s+export\s+controls|cuba,\s*iran,\s*north\s+korea/.test(normalizedQuestion)
    && /none\s+of\s+the\s+above/.test(normalizedAnswer)
  ) {
    return [
      '.field:has(label:has-text("Please confirm whether any of the below")) label:has-text("None of the above") input[type="checkbox"]',
      '.field-wrapper:has(label:has-text("Please confirm whether any of the below")) label:has-text("None of the above") input[type="checkbox"]',
      'fieldset:has(legend:has-text("Please confirm whether any of the below")) label:has-text("None of the above") input[type="checkbox"]',
      'input[name="question_35110536002[]"][value="221056618002"]',
    ];
  }
  if (
    /prior\s+question\s+other\s+than\s+[“"]?none\s+of\s+the\s+above|if\s+you\s+selected\s+a\s+response\s+to\s+the\s+prior\s+question/.test(normalizedQuestion)
    && /not\s+applicable|none\s+of\s+the\s+above/.test(normalizedAnswer)
  ) {
    return [
      '.field:has(label:has-text("If you selected a response to the prior question")) label:has-text("Not applicable") input[type="checkbox"]',
      '.field-wrapper:has(label:has-text("If you selected a response to the prior question")) label:has-text("Not applicable") input[type="checkbox"]',
      'fieldset:has(legend:has-text("If you selected a response to the prior question")) label:has-text("Not applicable") input[type="checkbox"]',
      'input[name="question_35114221002[]"][value="221073825002"]',
    ];
  }
  return [];
}

/**
 * TICK A CHECKBOX, ONCE.
 *
 * A CLICK IS A TOGGLE, AND THAT MAKES THIS THE ONE PLACE THE SELECTOR LADDER IS NOT FREE.
 *
 * Everywhere else in this file, alternatives are cheap: managedFill hands the runner one action
 * carrying a comma-joined list, the runner takes the FIRST match, and a fill that happens twice
 * writes the same string twice. So the habit is to widen the ladder whenever a selector misses.
 *
 * This function used to follow that habit with one action per alternative, and on a checkbox it is
 * destructive: stratus runs `locator.click()`, which toggles, so N alternatives that all resolve to
 * the SAME box leave it checked for odd N and unchecked for even N.
 *
 * Measured on the live Cloudflare form, 2026-08-09 (job-boards.greenhouse.io/embed/job_app?for=
 * cloudflare&token=8052785). Four of the five click actions production sent resolved to the single
 * input#question_68005616[]_731478256 - the fixed candidate-privacy click, the discovered id, the
 * :left-of alternative and the name-shape alternative - and replaying them in order gives
 * checked, unchecked, checked, unchecked. The 2026-08-08 packet's own preview screenshot shows that
 * box empty on an otherwise completed form, and the employer's validator called it
 * "required and is still empty". Nothing was mis-matched; it was matched four times.
 *
 * So the ladder is kept and the toggling is not: every alternative goes into ONE selector, the way
 * managedFill has always done it, and the runner ticks the first that resolves. The direct
 * Playwright path never had this bug because it uses `.check()`, which is idempotent, and breaks
 * after the first hit (fillReviewedQuestions below).
 *
 * `leading` is the control's own discovered selector when there is one. It goes first because an id
 * read off this very form beats every shape-based guess after it.
 */
function pushGreenhouseCheckboxOptionActions(
  actions: ManagedBrowserAction[],
  questionText: string,
  answer: string,
  labelPrefix: string,
  leading: readonly string[] = [],
) {
  const selectors = [...leading, ...greenhouseCheckboxOptionSelectors(questionText, answer)]
    .map((selector) => selector.trim())
    .filter(Boolean);
  /* As many alternatives as fit, in order, and never a second action.
   *
   * browserbase.ts refuses a selector over MANAGED_SELECTOR_MAX_LENGTH and silently drops the
   * optional action, and the Databricks export-control ladder joins to just under 500 characters,
   * so this bound is reached in practice rather than in theory. Dropping the tail is the right
   * degradation: the alternatives are ordered best-first, so what is lost is the least likely to
   * have matched - whereas spilling into a second action would put the box back into the toggling
   * this whole function exists to stop. */
  const kept: string[] = [];
  let length = 0;
  for (const selector of new Set(selectors)) {
    const cost = selector.length + (kept.length > 0 ? 2 : 0);
    if (kept.length > 0 && length + cost > MANAGED_SELECTOR_MAX_LENGTH) continue;
    kept.push(selector);
    length += cost;
  }
  if (kept.length === 0) return;
  actions.push({
    type: 'click',
    selector: kept.join(', '),
    label: `${labelPrefix}_checkbox:${questionText.slice(0, 80)}`,
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
}

function questionFillShouldPressEnter(questionText: string): boolean {
  const key = classifyField(questionText);
  return key ? CONFIRM_AFTER_FILL_FIELDS.has(key) : false;
}

function pushScopedQuestionChoiceActions(
  actions: ManagedBrowserAction[],
  questionText: string,
  answer: string,
  labelPrefix: string,
  options: { includeSelectFallbacks?: boolean } = {},
) {
  actions.push({
    type: 'fillByLabelText',
    text: questionText,
    value: answer,
    label: `${labelPrefix}:${questionText.slice(0, 80)}`,
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
  if (options.includeSelectFallbacks === false) return;
  let index = 0;
  const values = selectValuesForAnswer(answer);
  for (const selector of questionSelectSelectors(questionText)) {
    if (index >= QUESTION_SELECT_SELECTOR_LIMIT * values.length) break;
    for (const value of values) {
      managedSelect(actions, selector, value, `${labelPrefix}_select:${index}:${questionText.slice(0, 80)}`);
      index += 1;
    }
  }
}

function normalizedChoiceOption(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim().toLowerCase();
}

/**
 * Resolve a possibly multi-value reviewed answer against the control's exact option labels.
 *
 * A blind comma split is not safe because an option label can itself contain a comma. This walks
 * only prefixes that are complete offered labels and accepts exactly one decomposition. A single
 * offered value such as "None of the above" therefore remains one value, while a joined language
 * answer becomes several values only when the live options prove that reading is unambiguous.
 */
function exactChoiceOptionValues(answer: string, offeredOptions: readonly string[]): string[] | null {
  const target = normalizedChoiceOption(answer);
  if (!target) return null;
  const unique = new Map<string, string>();
  for (const raw of offeredOptions) {
    const canonical = raw.trim();
    const normalized = normalizedChoiceOption(canonical);
    if (normalized && !unique.has(normalized)) unique.set(normalized, canonical);
  }
  const offered = [...unique].map(([normalized, canonical]) => ({ normalized, canonical }));
  const solutions: string[][] = [];
  const visit = (remaining: string, selected: string[], used: Set<string>) => {
    if (solutions.length > 1) return;
    for (const option of offered) {
      if (used.has(option.normalized)) continue;
      if (remaining === option.normalized) {
        solutions.push([...selected, option.canonical]);
        continue;
      }
      const prefix = `${option.normalized}, `;
      if (!remaining.startsWith(prefix)) continue;
      visit(
        remaining.slice(prefix.length),
        [...selected, option.canonical],
        new Set([...used, option.normalized]),
      );
    }
  };
  visit(target, [], new Set());
  return solutions.length === 1 ? solutions[0] : null;
}

function pushAshbyQuestionTextFallbackActions(
  actions: ManagedBrowserAction[],
  questionText: string,
  answer: string,
  labelPrefix: string,
) {
  for (const [index, selector] of ashbyQuestionTextInputSelectors(questionText).entries()) {
    managedFill(actions, selector, answer, `${labelPrefix}_text:${index}:${questionText.slice(0, 80)}`);
  }
}

function greenhouseKnownQuestionAliases(question: string, answer: string): string[] {
  const normalizedQuestion = question.toLowerCase();
  const normalizedAnswer = answer.trim().toLowerCase();
  if (/^\s*yes,\s*i\s+consent\s*$/i.test(question)) return ['Yes, I consent'];
  if (!['yes', 'no'].includes(normalizedAnswer)) return [];
  if (
    /\b(?:eligible|authorized|authorised|legally\s+work|work\s+authorization|work\s+authorisation)\b/.test(normalizedQuestion)
    && (/\b(?:u\.?s\.?a?|united\s+states)\b/.test(normalizedQuestion) || /\bcountry\s+where\s+the\s+job\s+is\s+located\b/.test(normalizedQuestion))
    && !/\bwithout\s+sponsorship\b/.test(normalizedQuestion)
  ) {
    return [
      'Are you currently eligible to legally work in the United States?',
      'Are you currently eligible to legally work in the U.S.?',
      'Are you legally authorized to work in the United States?',
      'Are you authorized to work in the United States?',
      'Are you legally authorized to work in the country where the job is located?',
    ];
  }
  if (
    /\b(?:future|now)\b/.test(normalizedQuestion)
    && /\b(?:immigration|visa|sponsorship|sponsor)\b/.test(normalizedQuestion)
    && !/\bwithout\s+sponsorship\b/.test(normalizedQuestion)
  ) {
    return [
      'Will you now or in the future require immigration support or sponsorship?',
      'Will you now or in the future require immigration support or sponsorship from Postman?',
      'Will you now or in the future require sponsorship for employment visa status?',
      'Do you now or in the future require visa sponsorship?',
      'Do you now, or will you in the future, require visa sponsorship to continue working in the United States?',
      'Do you now, or will you in the future, need sponsorship from an employer in order to obtain, extend or renew your authorization to work in the United States?',
    ];
  }
  if (/\btop\s+preference\b|\banswering\s+[“"]?yes[”"]?\s+below\b/.test(normalizedQuestion)) {
    return [
      'By submitting this application and answering',
      'this role is my top preference',
    ];
  }
  if (/\b(?:options\s+market\s+making|trading\s+firm)\b/.test(normalizedQuestion)) {
    return [
      'Do you have prior experience working at an options market making trading firm?',
      'prior experience working at an options market making trading firm',
    ];
  }
  if (/\b(?:live|reside|located)\b[^?]{0,80}\b(?:new\s+york|california)\b/.test(normalizedQuestion)) {
    return [
      'Do you live in New York or California?',
      'live in New York or California',
    ];
  }
  if (/\bcertify\b[^?]{0,120}\b(?:true|complete|accurate)\b/.test(normalizedQuestion)) {
    return [
      'I certify that all information I have provided',
      'true, complete, and accurate',
    ];
  }
  if (/\bresume\b[^?]{0,80}\bpdf\s+format\b/.test(normalizedQuestion)) {
    return [
      'I acknowledge that my resume must be submitted in PDF format',
      'resume must be submitted in PDF format',
    ];
  }
  if (
    /\b(?:onsite|on[\s-]?site|in[\s-]?office|office|hybrid)\b/.test(normalizedQuestion)
    && /\b(?:three|four|five|3|4|5)\s+days?\b/.test(normalizedQuestion)
  ) {
    const requiredDay = normalizedQuestion.match(/\brequires?\s+(?:\w+\s+){0,4}(three|four|five|3|4|5)\s+days?\b/)?.[1];
    const firstDay = normalizedQuestion.match(/\b(three|four|five|3|4|5)\s+days?\b/)?.[1];
    const day = requiredDay ?? firstDay;
    const aliases: string[] = [];
    if (day === 'three' || day === '3') {
      aliases.push(
        'Are you able to work onsite three days a week?',
        'Are you able to work on-site three days a week?',
        'Are you able to work onsite in our San Francisco office 3 days a week?',
        'Are you able to work onsite in our San Francisco office three days a week?',
      );
    }
    if (day === 'four' || day === '4') {
      aliases.push(
        'Are you able to work onsite four days a week?',
        'Are you able to work on-site four days a week?',
        'Are you able to work onsite in our San Francisco office 4 days a week?',
        'Are you able to work onsite in our San Francisco office four days a week?',
      );
    }
    if (day === 'five' || day === '5') {
      aliases.push(
        'Are you able to work onsite five days a week?',
        'Are you able to work on-site five days a week?',
        'Are you able to work onsite in our San Francisco office 5 days a week?',
        'Are you able to work onsite in our San Francisco office five days a week?',
      );
    }
    return aliases;
  }
  return [];
}

function greenhouseAkunaRequiredQuestionAliases(question: string, answer: string): string[] {
  const normalizedQuestion = question.toLowerCase();
  const normalizedAnswer = answer.trim().toLowerCase();
  if (/\bapplied\b[^?]{0,120}\b(?:past|previously|before|role|position)\b/.test(normalizedQuestion)
    && (/^(?:no|false|0)\b/.test(normalizedAnswer)
      || /\b(?:have\s+not|haven't|never)\s+applied\b|\bnot\s+applied\b/.test(normalizedAnswer))) {
    const aliases: string[] = [];
    if (/\b(?:ever\s+)?applied\b[^?]{0,120}\b(?:full\s*time|internship|position|past)\b|\bin\s+the\s+past\b/.test(normalizedQuestion)) {
      aliases.push('Have you ever applied to a full time or internship position with Akuna in the past?');
    }
    if (/\b(?:this\s+role|role\s+at\s+akuna|this\s+position)\b/.test(normalizedQuestion)) {
      aliases.push('Have you applied to this role at Akuna previously?');
    }
    return aliases.length > 0
      ? aliases
      : [
        'Have you ever applied to a full time or internship position with Akuna in the past?',
        'Have you applied to this role at Akuna previously?',
      ];
  }
  if (/\bcurrent\s+immigration\s+status\b|\bbasis\s+of\s+your\s+current\s+work\s+authorization\b/.test(normalizedQuestion)) {
    if (/\bf-?1\b|\bcpt\b|\bopt\b|\bstem\b|n\/?a|not applicable/i.test(answer)) {
      return ['current immigration status or basis of your current work authorization'];
    }
    return [];
  }
  if (/\bhow\s+did\s+you\s+hear\b|\bhear\s+about\s+this\s+job\b/.test(normalizedQuestion)) {
    return ['How did you hear about this job?'];
  }
  if (/\boffer\s+deadlines?\b/.test(normalizedQuestion)) {
    return ['Do you have any offer deadlines that we should be aware of?'];
  }
  if (!['yes', 'no'].includes(normalizedAnswer)) return [];
  if (/\btop\s+preference\b|\banswering\s+[“"]?yes[”"]?\s+below\b/.test(normalizedQuestion)) {
    return ['this role is my top preference'];
  }
  if (/\b(?:options\s+market\s+making|trading\s+firm)\b/.test(normalizedQuestion)) {
    return ['prior experience working at an options market making trading firm'];
  }
  if (/\bdisclaimer\b[^?]{0,120}\bakuna\b[^?]{0,220}\bsponsor\b/.test(normalizedQuestion)) {
    return ['Disclaimer: Akuna Capital is a global company which wants to attract the highest quality talent. We will sponsor any qualified candidate for US work authorization'];
  }
  if (/\b(?:now|future)\b[^?]{0,180}\bvisa\s+sponsorship\b/.test(normalizedQuestion)) {
    return ['Do you now, or will you in the future, require visa sponsorship'];
  }
  if (/\b(?:live|reside|located)\b[^?]{0,80}\b(?:new\s+york|california)\b/.test(normalizedQuestion)) {
    return ['live in New York or California'];
  }
  return [];
}

function greenhouseAkunaRequiredAliasPriority(alias: string): number {
  const normalized = alias.toLowerCase();
  if (/\bcertify\b|\bresume must\b/.test(normalized)) return 0;
  if (/\btop preference\b|\blive in new york or california\b|\bdisclaimer:\s+akuna\b|\bvisa sponsorship\b/.test(normalized)) return 1;
  if (/\bapplied\b/.test(normalized)) return 1;
  if (/\boffer deadlines?\b|\bhow did you hear\b/.test(normalized)) return 2;
  if (/\bimmigration status\b|\bwork authorization\b|visa sponsorship/.test(normalized)) return 3;
  return 4;
}

function pushGreenhouseAkunaSafeTextActions(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  if (!packetLooksAkuna(packet)) return;
  for (const item of packet.questions) {
    if (packetQuestionFailed(packet, item)) continue;
    const questionText = normalizeReviewQuestionLabel(item.question);
    const value = item.answer.trim();
    if (!questionText || !value) continue;
    if (/\bwhat\s+is\s+your\s+legal\s+first\s+name\b/i.test(questionText)) {
      managedFillByLabel(actions, questionText, value, `greenhouse_akuna_text:${questionText.slice(0, 80)}`);
    }
    if (/\bpreferred\s+name\b/i.test(questionText)) {
      managedFillByLabel(actions, questionText, value, `greenhouse_akuna_text:${questionText.slice(0, 80)}`);
    }
  }
}

function packetLooksAkuna(packet: SubmissionPacket): boolean {
  return /\bakuna\b/i.test(packet.jdText ?? '')
    || packet.questions.some((item) => /\bakuna\b/i.test(item.question));
}

function packetLooksDatabricks(packet: SubmissionPacket): boolean {
  return /\bdatabricks\b/i.test(packet.jdText ?? '')
    || packet.questions.some((item) => /\bdatabricks\b/i.test(`${item.question}\n${item.answer}`));
}

/* THE ONLY SHAPE THAT MAY BE HANDED MORE THAN A YEAR, and why the test is positive rather than a
 * list of exclusions.
 *
 * An open text-entry control that discovery actually saw and reported. Everything else keeps the
 * bare year, and each exclusion is a case where widening could only do harm:
 *   - a closed list (select, radio, checkbox, combobox) is matched against the employer's own option
 *     text, so a wider answer can only miss an option that "2028" matches exactly;
 *   - a number or tel box cannot physically carry a month name;
 *   - NO reported type at all means discovery never saw this control. Greenhouse's known-question
 *     aliases reach here that way, and every one of them is answered against an option list.
 * That last exclusion is not theoretical: without it Akuna's "Graduation Year" React-select was
 * offered "May 2028" beside "2028". */
const OPEN_GRADUATION_TEXT_CONTROL = /^(?:text|textarea)$/i;

/**
 * What goes into a control whose LABEL asks for a graduation year.
 *
 * WHY THIS IS NOT packet.graduationYear (measured on prod packets bbf0115a, 59fb48ae, cd066fee and
 * 4bfd5827 - Deepgram on Ashby, 2026-08-08 to 2026-08-11). "Expected Graduation Year" there is a
 * react-datepicker at day precision behind `[data-field-path="407cc864-..."]`. Handed a bare "2028"
 * the managed runner deliberately writes nothing and says so, because tabbing off a typed year
 * commits 01/01/2028 - four months before a May graduation, and a date the employer reads as fact.
 * All four of those runs then reported "Expected Graduation Year" as required and still empty, on a
 * packet that was otherwise complete.
 *
 * questionDiscovery already settled this: graduationYearFieldAnswer resolves the same label to
 * "May 2028" and refuses to widen a year-only profile. That answer reached the packet, and this
 * function overwrote it with the bare year one layer later, which is why the fix in discovery never
 * showed up on the form. Calling the same helper here is what makes the two layers agree.
 *
 * The month is never invented. graduationYearFieldAnswer returns the bare year whenever the profile
 * states no month, so a year-only profile still hands the runner "2028" and the runner still refuses
 * the date control rather than picking a month - which is the correct outcome and stays correct.
 */
function graduationYearAnswerForControl(
  item: SubmissionPacket['questions'][number],
  packet: SubmissionPacket,
): string {
  const year = packet.graduationYear?.trim();
  const inputType = reviewQuestionPortalInputType(item)?.trim() ?? '';
  if (!OPEN_GRADUATION_TEXT_CONTROL.test(inputType)) return year || item.answer;
  const yearNumber = year && /^\d{4}$/.test(year) ? Number(year) : undefined;
  return graduationYearFieldAnswer(packet.graduationDate, yearNumber, inputType)
    ?? year
    ?? item.answer;
}

/**
 * The graduation value this particular control is asking for.
 *
 * THE NARROW TESTS RUN FIRST, and the order is the whole correctness argument. The date branch
 * matches on `expected graduat(ion|e)` with nothing after it, so it also matches "Expected
 * Graduation Year" and "Expected Graduation Month" - and it used to be first, so it won, which is
 * why "Graduation Month" once received a whole date.
 *
 * Month before year before date, because that is specific-to-general. "Graduation month" cannot be
 * a date question; "graduation date" can never be more specific than the other two.
 *
 * WHAT THE YEAR BRANCH IS NOT. Ordering the tests correctly says which QUESTION is being asked; it
 * says nothing about what the CONTROL can hold. The first version of this ordering also replaced the
 * answer with packet.graduationYear, on the reading that a field labelled "Expected Graduation Year"
 * is a year field. On the live Deepgram Ashby form it is a react-datepicker, and the bare year is
 * exactly the value it refuses - so that reading cost four consecutive runs the same required field.
 * The year branch now asks graduationYearAnswerForControl, which narrows only where the control
 * really is year-shaped.
 */
/**
 * Did the APPLICANT write this answer, as opposed to the resolver.
 *
 * One predicate, because two readers depend on it and they must not drift:
 * greenhouseReviewedQuestionAnswer (which value is sent) and greenhouseReviewedAnswerIsResolved
 * (whether a computed bucket ranks ahead of it). Widening this in one place only would send her
 * answer while still leading with a bucket, or the reverse, and both are silent.
 *
 * `consent_permission` is deliberately NOT here. That provenance marks a permission Litos recorded,
 * not a value she chose off a control, and it must keep going through the branches below.
 */
function applicantChoseAnswer(item: SubmissionPacket['questions'][number]): boolean {
  return applicantChoseStoredAnswer({ answer: item.answer, answer_source: item.answerSource });
}

function greenhouseReviewedQuestionAnswer(item: SubmissionPacket['questions'][number], packet: SubmissionPacket): string {
  const questionText = normalizeReviewQuestionLabel(item.question);
  /* AN ANSWER SHE WROTE IS THE ANSWER, and every branch below would otherwise recompute over it.
   *
   * The branches exist to beat a STALE record: a question written on an earlier run says "May 2027"
   * after she has corrected her graduation to May 2028, and replaying it would submit a date she
   * fixed. greenhouseCurrentOptionAnswer distinguishes a machine answer snapped off a real option
   * list from one that was merely stored, using answerOptionSource.
   *
   * Neither test can see HER. An answer typed into the review was never snapped from a profile
   * value, so answerOptionSource is absent and the date branch falls straight through to
   * packet.graduationDate.
   *
   * Measured on Jump Trading packet 2e593ac5, 2026-08-17: the packet held "Spring/Summer 2028" with
   * answer_source applicant_review, which is on that employer's list verbatim, and the fill typed
   * "May 2028" and then the "Spring 2028" bucket. Neither exists on that list - these are
   * react-selects filtered by the typed string, and "Spring/Summer 2028" contains neither substring -
   * so the menu emptied and the run reported `no option matched "Spring 2028"` on a question that was
   * already answered correctly.
   *
   * This is the contract PR #566 established for every other reader: an applicant override survives
   * until she changes it. Staleness is her business once she has taken the field, exactly as it is
   * for every other answer she edits. */
  if (applicantChoseAnswer(item)) return item.answer.trim();
  if (isReferralSourceQuestion(questionText)) {
    return referralSourceForApplication(
      packet.referralSourceDefault ?? item.answer,
      packet.referralSourceEvidence,
    ) ?? '';
  }
  if (/\bgraduat(?:ion|e)\s+month\b|\bwhat\s+is\s+your\s+graduation\s+month\b|\bmonth\s+of\s+graduation\b/i.test(questionText)) {
    return packet.graduationMonth?.trim() || item.answer;
  }
  if (/\bgraduat(?:ion|e)\s+year\b|\bwhat\s+is\s+your\s+graduation\s+year\b|\byear\s+of\s+graduation\b/i.test(questionText)) {
    return graduationYearAnswerForControl(item, packet);
  }
  /* THE DATE BRANCH STILL OUTRANKS A STALE ANSWER, AND NO LONGER OUTRANKS A SNAPPED ONE.
   *
   * The packet value has to keep winning in the ordinary case, and the reason is the STALE answer: a
   * question record written on an earlier run says "May 2027" long after the profile says "May 2028",
   * and replaying the record would submit a graduation date the applicant has since corrected. That
   * is what this branch was built for and it is still right.
   *
   * What it could not tell apart is an answer that is not the applicant's phrasing at all. Measured
   * on the live IMC application (generated_resumes fc6eade3-90e5-4d17-af94-009f9a22beaa,
   * 2026-08-11): that control's real options read "July 2027 - December 2027", "January 2028 - July
   * 2028", "August 2028 - December 2028". Discovery read the list, resolveProfileField snapped onto
   * "January 2028 - July 2028", and this line threw it away for "May 2028", which is not on that
   * list and never could be. The field came back required-and-still-empty.
   *
   * greenhouseCurrentOptionAnswer is the discriminator, and it takes TWO facts because one is not
   * enough. Band shape says the answer could not have been computed from the profile, so it must
   * have come off a list. answer_option_source says the profile still says what it said when that
   * choice was made. A band alone would let a record written when she said "May 2027" send
   * "January 2027 - July 2027" long after she corrected her graduation to May 2028, which is a
   * window a year early on a real application. */
  if (/\bgraduat(?:ion|e)\s+date\b|\bwhat\s+is\s+your\s+graduation\s+date\b|\bexpected\s+graduat(?:ion|e)\b/i.test(questionText)) {
    return greenhouseCurrentOptionAnswer(item, packet) ?? (packet.graduationDate?.trim() || item.answer);
  }
  return item.answer;
}

/**
 * The stored answer, when it was read off this control's own option list AND is still current.
 *
 * optionBandAnswer supplies the first half: a band is a string no profile holds and no bucket in
 * this file computes, so the only thing that produces one is a real option list. The packet's own
 * profile facts supply the second: answerOptionSource records the profile value the option was
 * chosen for, and if the packet still carries that value, the applicant has not moved underneath it.
 *
 * WHY THE SOURCE IS CHECKED AGAINST A SET rather than the one fact for this question's family. The
 * bucket ladders in this file are computed from exactly four profile values, and a graduation or GPA
 * question can only have been snapped from one of them. Testing the set keeps this function from
 * having to classify the question a second time, in a second place, with a second set of regexes
 * that could disagree with greenhouseComboboxValuesForQuestion's. A source matching some other one
 * of the four is not a false positive worth engineering against: it still proves the profile has not
 * changed since the snap, which is the only thing this is asked.
 *
 * Absent answerOptionSource returns undefined, and that is the safe direction: the caller recomputes
 * from the profile, which is what shipped.
 */
function greenhouseCurrentOptionAnswer(
  item: SubmissionPacket['questions'][number],
  packet: SubmissionPacket,
): string | undefined {
  const band = optionBandAnswer(item.answer);
  if (!band) return undefined;
  const bucketInputs = [packet.gpa, packet.graduationDate, packet.graduationMonth, packet.graduationYear];
  return bucketInputs.some((fact) => storedOptionAnswerIsCurrent(band, item.answerOptionSource, fact))
    ? band
    : undefined;
}

/**
 * Whether the value this control is about to be filled with carries evidence from the CONTROL,
 * rather than being a profile fact that has never been near it.
 *
 * It decides where a locally computed bucket ranks against that value. See
 * greenhouseComboboxValuesForQuestion: a bucket maps a profile fact onto one employer's vocabulary,
 * which is the right thing to lead with when the value in hand IS a profile fact and the wrong thing
 * to lead with when the value was read off this control's own list and is still current.
 *
 * TWO TESTS. The first is greenhouseCurrentOptionAnswer, which is where the evidence lives. The
 * second is that greenhouseReviewedQuestionAnswer actually chose it, so this describes the value
 * that will really be sent rather than one that was overruled a few lines up.
 */
function greenhouseReviewedAnswerIsResolved(
  item: SubmissionPacket['questions'][number],
  packet: SubmissionPacket,
): boolean {
  /* AN ANSWER SHE CHOSE HERSELF RANKS AHEAD OF A BUCKET COMPUTED FROM HER PROFILE.
   *
   * The option-evidence test below cannot see an applicant's own answer: answerOptionSource records
   * the profile value an answer was SNAPPED FROM when discovery read the control's list, and an
   * answer typed into the review has no such snap. So it read as unproven, the bucket went in front
   * of it, and comboboxValueLimit is 1 on these controls - the bucket was the only value the form
   * ever saw.
   *
   * Measured on Jump Trading packet 2e593ac5, 2026-08-17. The packet held
   * "Spring/Summer 2028" with answer_source applicant_review, which is on that employer's list
   * VERBATIM. greenhouseGraduationBucket computed "Spring 2028" from the profile's May 2028, that
   * went first, and the run reported `no option matched "Spring 2028"`. These are react-selects: the
   * value is TYPED to filter the menu, and "Spring/Summer 2028" does not contain the substring
   * "Spring 2028", so the filter emptied and there was nothing to click. Her own answer would have
   * filtered to exactly one row.
   *
   * This does not weaken the bucket where it earns its place. A machine answer with no option
   * evidence still puts the bucket first, which is the Cloudflare, Databricks and Akuna case the
   * bucket was written for. Only an answer with a human behind it moves ahead of it. */
  if (applicantChoseAnswer(item)) return true;

  const stored = greenhouseCurrentOptionAnswer(item, packet);
  if (!stored) return false;
  return greenhouseReviewedQuestionAnswer(item, packet).trim() === stored;
}

function pushGreenhouseKnownQuestionAliases(
  actions: ManagedBrowserAction[],
  packet: SubmissionPacket,
  mode: 'all' | 'akunaRequired' | 'legacy' = 'all',
) {
  const seen = new Set<string>();
  if (mode === 'akunaRequired' && !packetLooksAkuna(packet)) return;
  const packetQuestionContext = packet.jdText ?? packet.questions.map((item) => item.question).join('\n');
  const items = mode === 'akunaRequired'
    ? [...packet.questions].sort((left, right) => {
      const leftAnswer = greenhouseReviewedQuestionAnswer(left, packet);
      const rightAnswer = greenhouseReviewedQuestionAnswer(right, packet);
      const leftPriority = Math.min(...greenhouseAkunaRequiredQuestionAliases(left.question, leftAnswer).map(greenhouseAkunaRequiredAliasPriority), 99);
      const rightPriority = Math.min(...greenhouseAkunaRequiredQuestionAliases(right.question, rightAnswer).map(greenhouseAkunaRequiredAliasPriority), 99);
      return leftPriority - rightPriority;
    })
    : packet.questions;
  for (const item of items) {
    if (packetQuestionFailed(packet, item)) continue;
    const answer = greenhouseReviewedQuestionAnswer(item, packet);
    // An unanswered question drives no action. R-096 makes a required field the applicant has not
    // answered yet a real question record, and greenhouseKnownQuestionAliases has one branch keyed
    // on the QUESTION rather than the answer ("Yes, I consent"), which would otherwise have clicked
    // a consent control on behalf of someone who has consented to nothing. Every other fill path
    // already stops on a blank; this was the one that did not.
    if (!answer.trim()) continue;
    const akunaAliases = greenhouseAkunaRequiredQuestionAliases(item.question, answer);
    const aliases = mode === 'akunaRequired'
      ? akunaAliases
      : mode === 'legacy' && akunaAliases.length > 0
        ? []
        : greenhouseKnownQuestionAliases(item.question, answer);
    for (const alias of aliases) {
      // The source reviewed question is not necessarily the control this fallback targets. A stale
      // immigration answer, for example, can generate the canonical Akuna immigration alias even
      // when that exact live control just failed its option probe. Guard the intended alias target
      // before producing any scoped fill, rather than trying to infer intent from action text later.
      if (packetTargetFailed(packet, { label: alias })) continue;
      const key = `${alias}\n${answer.trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (mode === 'akunaRequired') {
        pushGreenhouseQuestionComboboxLabelActions(actions, alias, answer, 'greenhouse_known_question', packetQuestionContext);
        continue;
      }
      actions.push({
        type: 'fillByLabelText',
        text: alias,
        value: answer.trim(),
        label: `greenhouse_known_question:${alias.slice(0, 80)}`,
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      });
    }
  }
}

const GREENHOUSE_DEMOGRAPHIC_ALIASES: Array<{ key: string; aliases: string[] }> = [
  {
    key: 'gender',
    aliases: [
      'What gender identity do you most closely identify with?',
    ],
  },
  {
    key: 'transgender_status',
    aliases: [
      'Are you a person of transgender experience?',
    ],
  },
  {
    key: 'sexual_orientation',
    aliases: [
      'What sexual orientation do you most closely identify with?',
    ],
  },
  {
    key: 'disability_status',
    aliases: [
      'Do you live with a disability (as outlined by the ADA)?',
    ],
  },
  {
    key: 'veteran_status',
    aliases: [
      'Are you a veteran/have you served in the military?',
    ],
  },
  {
    key: 'race',
    aliases: [
      'Please select up to 2 ethnicities that you most closely identify with.',
    ],
  },
];

function packetHasGreenhouseReviewedDemographicAnswer(packet: SubmissionPacket, key: string): boolean {
  const patterns: Record<string, RegExp> = {
    gender: /\bgender(?:\s+identity)?\b/i,
    transgender_status: /transgender/i,
    sexual_orientation: /sexual\s+orientation/i,
    disability_status: /\bdisab/i,
    veteran_status: /\bveteran\b|\bmilitary\b/i,
    race: /\brace\b|\bethnicit|which\s+categor(?:y|ies)\b[^?]{0,120}(?:describe|identify)|hispanic|latino/i,
  };
  const pattern = patterns[key];
  if (!pattern) return false;
  return packet.questions.some((item) => item.answer.trim() && pattern.test(normalizeReviewQuestionLabel(item.question)));
}

function pushGreenhouseDemographicAliases(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  const prefs = packet.eeoPrefs;
  if (!prefs) return;
  for (const item of GREENHOUSE_DEMOGRAPHIC_ALIASES) {
    const value = prefs[item.key]?.trim();
    if (!value) continue;
    if (packetHasGreenhouseReviewedDemographicAnswer(packet, item.key)) continue;
    for (const alias of item.aliases) {
      if (packetLabelFailed(packet, alias)) continue;
      actions.push({
        type: 'fillByLabelText',
        text: alias,
        value,
        label: `greenhouse_demographic:${alias.slice(0, 80)}`,
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      });
      for (const [index, selectSelector] of greenhouseQuestionSelectSelectors(alias).slice(0, GREENHOUSE_ALIAS_SELECT_SELECTOR_LIMIT).entries()) {
        managedSelect(actions, selectSelector, value, `greenhouse_demographic_select:${index}:${alias.slice(0, 80)}`);
      }
      pushGreenhouseDemographicComboboxLabelActions(actions, alias, value);
    }
  }
}

function managedActionLabelBase(action: ManagedBrowserAction): string | undefined {
  return action.label?.replace(/_(?:open|option_value|option|select)$/, '');
}

/**
 * Speculative REPEAT attempts at one control, past the first.
 *
 * Three families guess at a single question by firing at several possible label wordings, because
 * only one of them exists on any given board. Measured on the live DRW packet: the referral source
 * costs 25 actions across five wordings, the graduation date 45 across three wordings times three
 * date formats, and the preferred location 15 across three wordings. That is 85 of 231 actions, and
 * at most 5, 5 and 5 of them can ever do anything.
 *
 * They come off FIRST, ahead of everything else, because the ordering principle of the list below is
 * to give up a redundant attempt at a control before the only attempt at another one. Before this,
 * DRW gave up the referral question, the demographics and the discipline row while keeping all 45
 * graduation-date guesses at a control that board does not have.
 */
const GREENHOUSE_REDUNDANT_ATTEMPT_GROUPS = [
  /^greenhouse_referral_combo_(?:label|select):\d+:(?:How did you first hear about|Where did you hear about|Where have you learned about|Referral source)/,
  /^education_graduation_date_combo:[1-9]/,
  /^preferred_location_combo:[1-9]:/,
] as const;

/**
 * Ordered most disposable first. The trim walks it, removing one label group at a time, and stops
 * the moment the list is inside the budget.
 *
 * TWO THINGS ARE DELIBERATELY ABSENT and were removed on 2026-08-09, measured against the live DRW
 * Software Developer Intern packet, whose raw action list is 231 actions against a 120 budget:
 * `education_discipline_combo:` and `education_discipline_label`. The trim reached both, so the
 * Discipline control was never touched by the run at all, and the applicant got
 * '"Discipline" is required and is still empty' on a form where the answer was resolved correctly
 * and simply never sent. The four fixed education comboboxes are now protected outright (see
 * isProtectedManagedAction): they are a known, always-required, sixteen-action block on every
 * Greenhouse board, and no budget saving is worth deleting a required field's only attempt.
 *
 * The referral pattern below also USED to read `question_combo_label:.*how did you hear`, which had
 * not matched anything since those actions were relabelled `greenhouse_referral_combo_label`. So the
 * single largest disposable group on the form, 25 actions, was unreachable while a required field
 * was being deleted two groups later.
 *
 * `options market making` is named alongside its Akuna siblings for a different reason, and it is a
 * mask rather than a fix. greenhouseAkunaRequiredQuestionAliases refuses to turn a free-text answer
 * into a Yes/No attestation, but the GENERIC combobox path has no such guard and renders
 * "I don't have prior experience at an options market making firm." as the option "No". That is true
 * of origin/main too; it was invisible only because this trim happened to reach those actions on the
 * one packet large enough to trigger it. Freeing budget made it visible, so it is named here to keep
 * the behaviour where it was rather than change it as a side effect of a budget fix. The real
 * question, whether the generic path should ever answer a prior-experience declaration, belongs with
 * the self-declaration work in lib/selfDeclaration.ts and not inside a budget change.
 */
const GREENHOUSE_LOW_PRIORITY_ACTION_GROUPS = [
  ...GREENHOUSE_REDUNDANT_ATTEMPT_GROUPS,
  /^greenhouse_demographic/,
  /^preferred_(?:first|last)_name$/,
  /^question_select:/,
  /^greenhouse_known_question:/,
  /^(?:question|greenhouse_referral)_combo_label:.*(?:by submitting this application|which university|what education level|graduation month|graduation year|what is your gpa|have you ever applied|have you applied to this role|how did you hear|offer deadlines|disclaimer: akuna|visa sponsorship|live in new york|resume must|options market making|if you selected ['"]?other['"]?)/i,
  /^question_combo_label:.*undergraduate.*master/,
  /^question:.*(?:legal first name|preferred name)/,
  /^question:(?:If yes|How familiar|Do you currently reside|Are you currently enrolled in a Masters|Do you identify as LGBTQIA|Which category best describes you|Gender Identity|Veteran Status)/,
  /^question_combo_label:.*If you answered.*current immigration status/,
  /^preferred_location_combo:[12]:/,
  /^education_graduation_date_combo:/,
  /^(?:graduation_date|graduation_date_label|graduation_date_expected|education_end_month|education_end_year|education_graduation_month|education_expected_graduation_year|gpa_question)$/,
  /^first_name_label$/,
  /^education_degree_combo:2$/,
  /^education_degree_combo:1$/,
] as const;

function trimGreenhouseManagedActionsToBudget(
  actions: ManagedBrowserAction[],
  limit: number,
  protectedActionBases: ReadonlySet<string> = new Set(),
) {
  for (const pattern of GREENHOUSE_LOW_PRIORITY_ACTION_GROUPS) {
    while (actions.length > limit) {
      let removableBase: string | undefined;
      for (let index = actions.length - 1; index >= 0; index -= 1) {
        const action = actions[index]!;
        if (isProtectedManagedAction(action, protectedActionBases)) continue;
        const base = managedActionLabelBase(action);
        if (!base || !pattern.test(base)) continue;
        removableBase = base;
        break;
      }
      if (!removableBase) break;
      const before = actions.length;
      for (let index = actions.length - 1; index >= 0; index -= 1) {
        if (managedActionLabelBase(actions[index]!) === removableBase) actions.splice(index, 1);
      }
      if (actions.length === before) break;
    }
    if (actions.length <= limit) return;
  }
}

/**
 * The actions a budget trim may never remove.
 *
 * Everything here is a READ, or the click that makes the read possible. The budget exists to bound
 * how much a run tries to FILL; spending it by deleting the reads inverts the trade, because the
 * reads are what the run is judged by and what the next step is built from.
 *
 * `discover` is the newest and most important entry. It is one action out of 145 on a large
 * Greenhouse form and it is the entire reason the discovery pass is made at all: without it the
 * applicant gets a packet with zero question records and 27 required-and-empty blockers, which is a
 * form she cannot answer inside the product. It also sat at index 131 of 145, past the runner's own
 * ceiling, so a tail truncation would have taken it first.
 *
 * The fixed education row joined it on 2026-08-09, and it is the only entry here that FILLS rather
 * than reads. School, Degree, Discipline and End date month are one known block of four controls and
 * sixteen actions, present and required on every Greenhouse board, and each has exactly one attempt.
 * Measured on the live DRW packet: the raw list is 231 actions against a 120 budget, the trim
 * reached Discipline, and the applicant was told '"Discipline" is required and is still empty' about
 * a control the run had been forbidden to touch. There is no budget saving worth that, and the
 * sixteen actions are a fixed cost that does not grow with the form.
 *
 * The taxonomy warm-up joined them on 2026-08-09 and belongs to the same block for the same reason.
 * Two actions per control that make the four fills able to land at all: dropping the warm-up to save
 * budget deletes the education row just as surely as dropping the fills, only less visibly, because
 * the fills then run and report `no option matched` on an answer that was correct.
 */
const GREENHOUSE_FIXED_EDUCATION_ACTION_RE =
  /^education_(?:school|degree|discipline|end_month)_combo(?:$|[:_])|^education_end_year_field$|^education_taxonomy_warm/;

function isProtectedManagedAction(
  action: ManagedBrowserAction | undefined,
  protectedActionBases: ReadonlySet<string> = new Set(),
): boolean {
  if (!action) return false;
  if (action.type === 'discover') return true;
  const label = action.label ?? '';
  const base = managedActionLabelBase(action);
  if (base && protectedActionBases.has(base)) return true;
  if (GREENHOUSE_FIXED_EDUCATION_ACTION_RE.test(label)) return true;
  // transcript_capability joins cover_letter_capability here because it is the same kind of thing:
  // a READ whose absence is indistinguishable from a no. If the trim takes it, transcript_supported
  // is written false on a form that has the control, the submit run re-derives its attach decision
  // from that flag, and a document she attached is silently left off. The `upload` action it decides
  // about is deliberately NOT protected - a fill is what the budget is for giving up.
  //
  // Workable's form-ready barrier is also a required wait, and the final cookie decline and cleared
  // barrier belong to the same protected sequence: dropping either one can strand a fresh
  // pointer-intercepting cookie overlay directly in front of the phone country control.
  // resume_upload_verify is protected as a required evidence read one step further along: it says
  // whether the transcript upload took the resume's control. A trim that dropped it would leave the
  // run unable to tell a resume that is still attached from one that was replaced, which is the
  // exact silence this read was added to break.
  return /^(?:filled_field:|captcha_|options:|option_probe_|cover_letter_capability$|transcript_capability$|resume_upload_verify$|controlled_portal_hydrated$|greenhouse_open_application_form$|greenhouse_application_form_ready$|greenhouse_cookie_preflight|workable_cookie_(?:preflight|final_decline|final_cleared)$|workable_application_form_ready$|workable_phone_assertion_capability$)/
    .test(label);
}

function truncateManagedActionsToBudget(
  actions: ManagedBrowserAction[],
  limit: number,
  protectedActionBases: ReadonlySet<string> = new Set(),
) {
  while (actions.length > limit) {
    let tailIndex = actions.length - 1;
    // The evidence reads are protected alongside the filled_field extracts, and for the same reason:
    // they are what the run is JUDGED by afterwards, not part of what it fills. Truncating them off
    // the tail of a large Akuna packet would silently remove the corroboration that decides whether
    // a CAPTCHA blocker is believed, on exactly the packets most likely to hit the budget.
    while (tailIndex >= 0 && isProtectedManagedAction(actions[tailIndex], protectedActionBases)) {
      tailIndex -= 1;
    }
    if (tailIndex < 0) break;
    const action = actions[tailIndex]!;
    const base = managedActionLabelBase(action);
    if (!base) {
      actions.splice(tailIndex, 1);
      continue;
    }
    for (let index = actions.length - 1; index >= 0; index -= 1) {
      if (managedActionLabelBase(actions[index]!) === base) actions.splice(index, 1);
    }
  }
}

/** The 80-char label suffix an action label embeds for a question, shared by the protection,
 * accounting and trim matchers so the three cannot drift. */
function reviewQuestionBudgetSuffix(question: string): string | undefined {
  const text = normalizeReviewQuestionLabel(question);
  return text ? text.slice(0, 80) : undefined;
}

function actionBaseNamesQuestionSuffix(base: string, suffix: string): boolean {
  return base === `question:${suffix}` || base.endsWith(`:${suffix}`);
}

/* WHICH QUESTIONS GO FIRST when whole questions have to go at all.
 *
 * The blunt tail truncation drops whatever sits last in the list, and the list is ordered by
 * builder, not by importance. Measured on Akuna packet 41f0b79d, 2026-08-18: the tail held the five
 * education controls discovery had finally captured, both attestations, and the referral source -
 * eight REQUIRED controls - while an optional "potential master's graduation date" survived near the
 * head. The run then reported all eight as required-and-empty on a packet that had every answer.
 *
 * So BEFORE anything blunt runs - this must precede the tail truncations, or the unprotected
 * required chains are already gone by the time it looks - the questions the form itself marks
 * optional give up their chains first, tail-first among themselves. An optional question the budget
 * drops costs the applicant nothing the employer requires; a required question dropped in its place
 * costs the whole send.
 *
 * Three deliberate refusals shape the matching:
 *
 * - A suffix any required question also names is never trimmed. The suffixes are labels cut at 80
 *   characters, so two long questions can collide; a collision must fail safe, and `endsWith`
 *   through a label's own colon ("Disclaimer: ...") is caught by the same per-base check.
 * - A base is owned by WHATEVER builder produced it, not only the `question*` family: Akuna's
 *   attestations and the referral source fill through greenhouse_known/fixed/referral chains, and
 *   an optional question served by those labels frees no budget if only `question*` bases count.
 *   Class-protected reads (filled_field:, captcha_, options:) are exempted through the same
 *   isProtectedManagedAction the truncations use, so an evidence read whose label quotes a
 *   question is never deleted with it.
 * - The trim stands down entirely rather than remove the last question-labeled action:
 *   budgetDroppedReviewedQuestions reads "no question* action at all" as "this family never fills
 *   questions" and would report NOTHING, which turns a real budget drop invisible.
 *
 * required: false is discovery's word, and discovery's word is an asterisk scan on some providers,
 * so a required control with an unmarked label can carry an explicit false and be sacrificed here.
 * That is a data-quality gap this priority cannot close from below; what it changes is WHICH
 * mistake is possible, and a mis-flagged label is a narrower failure than the old one, where any
 * required chain could die simply for sitting at the tail. */
function trimOptionalQuestionActionsToBudget(
  actions: ManagedBrowserAction[],
  limit: number,
  packet: SubmissionPacket,
  coreProtection: ReadonlySet<string>,
) {
  if (actions.length <= limit) return;
  const optionalSuffixes: string[] = [];
  const requiredSuffixes: string[] = [];
  for (const item of packet.questions) {
    const suffix = reviewQuestionBudgetSuffix(item.question);
    if (!suffix) continue;
    // Only a question the record EXPLICITLY marks optional may be trimmed. An absent flag is
    // unknown, not optional, and unknown keeps the protection it has today.
    (item.required === false ? optionalSuffixes : requiredSuffixes).push(suffix);
  }
  const removable = (action: ManagedBrowserAction, suffix: string): boolean => {
    const base = managedActionLabelBase(action);
    if (!base || !actionBaseNamesQuestionSuffix(base, suffix)) return false;
    if (isProtectedManagedAction(action, coreProtection)) return false;
    return !requiredSuffixes.some((required) => actionBaseNamesQuestionSuffix(base, required));
  };
  const seen = new Set<string>();
  for (let index = optionalSuffixes.length - 1; index >= 0 && actions.length > limit; index -= 1) {
    const suffix = optionalSuffixes[index]!;
    if (seen.has(suffix)) continue;
    seen.add(suffix);
    const survivingQuestionActions = actions.filter((action) => {
      const base = managedActionLabelBase(action);
      return Boolean(base?.startsWith('question')) && !removable(action, suffix);
    });
    if (survivingQuestionActions.length === 0) continue;
    for (let position = actions.length - 1; position >= 0; position -= 1) {
      if (removable(actions[position]!, suffix)) actions.splice(position, 1);
    }
  }
}

/**
 * THE FAMILY-AGNOSTIC BUDGET TRIM, and the reason it had to stop being a Greenhouse-only concern.
 *
 * Only Greenhouse was ever trimmed, because only Greenhouse was ever close to the ceiling: its
 * fixed alias fills cost ~116 actions before a single screener question is answered, so it hit
 * MANAGED_ACTION_LIMIT on a packet with no questions at all. Every other family started small and
 * grew per QUESTION instead, which looked safe for as long as nothing reported many questions.
 *
 * Measured on origin/main (02648ba) with a synthetic packet, Ashby submit list:
 *
 *     questions |  0    4    6    8   10   30
 *     actions   | 11   67   95  123  151  431
 *
 * 14 actions per reviewed question - one scoped fill, four native-select guesses, nine text-input
 * guesses - so eight questions is over the ceiling and the run is answered with HTTP 400
 * TOO_MANY_ACTIONS before a browser opens. Lever, SmartRecruiters, Workable, JazzHR, Rippling,
 * Breezy, BambooHR, Jobvite, iCIMS, Oracle Cloud and UltiPro all cost 5 per question and cross the
 * same line further out; Paylocity costs 20, because its wizard traversal repeats the fills once per
 * step, and crosses it at six.
 *
 * stratus-browser-cloud PR #22 is what turned that from a theoretical limit into a live one: the
 * `discover` action now reports choice questions (radio, checkbox, select, and Ashby's pill groups)
 * where it previously reported only text-shaped inputs, so the reviewed-question count on a real
 * Ashby packet went up sharply. The Deepgram posting is exactly this shape.
 *
 * Raising MAX_ACTIONS is not the fix and must not become one. The runner's ceiling is a real
 * protection, and the last time a list grew past it (discovery, 120 to 145) every managed run was
 * rejected for weeks without anyone seeing it - submissionRunner takes the discovery run with
 * `.catch(() => null)`, so an over-budget list is indistinguishable from a form with no questions.
 *
 * WHAT COMES OFF: repeat attempts at one control, highest attempt index first, across every
 * question before any question loses its next-to-last attempt. A label of the form
 * `<something>_select|_text|_checkbox|_combo...:<n>:<question>` is guess number <n> at a control
 * this builder cannot see; at most one guess in a chain can ever match, so dropping the tail of the
 * chain costs the question nothing. The primary attempt is labelled `question:<question>` with no
 * index and is not matched here - on Ashby it is the fillByLabelText the runner's scoped choice
 * handling actually presses the pill with, and it is the last thing that should be given up.
 *
 * Degrading by index rather than by question is the point. Removing from the tail one question at a
 * time would strip the last questions of every fallback while the first kept all nine; every
 * question losing its ninth guess first is the same saving spread evenly.
 */
const SPECULATIVE_ATTEMPT_LABEL_RE = /^[a-z0-9_]*_(?:select|text|checkbox|combo)[a-z0-9_]*:(\d+)(?::|$)/i;

function speculativeAttemptIndex(
  action: ManagedBrowserAction,
  protectedActionBases: ReadonlySet<string> = new Set(),
): number | undefined {
  if (isProtectedManagedAction(action, protectedActionBases)) return undefined;
  const base = managedActionLabelBase(action);
  const attempt = base ? SPECULATIVE_ATTEMPT_LABEL_RE.exec(base)?.[1] : undefined;
  return attempt === undefined ? undefined : Number(attempt);
}

function trimSpeculativeManagedActionsToBudget(
  actions: ManagedBrowserAction[],
  limit: number,
  protectedActionBases: ReadonlySet<string> = new Set(),
) {
  if (actions.length <= limit) return;
  let highestAttempt = -1;
  for (const action of actions) {
    const attempt = speculativeAttemptIndex(action, protectedActionBases);
    if (attempt !== undefined && attempt > highestAttempt) highestAttempt = attempt;
  }
  for (let attempt = highestAttempt; attempt >= 0 && actions.length > limit; attempt -= 1) {
    while (actions.length > limit) {
      let removableBase: string | undefined;
      for (let index = actions.length - 1; index >= 0; index -= 1) {
        if (speculativeAttemptIndex(actions[index]!, protectedActionBases) !== attempt) continue;
        removableBase = managedActionLabelBase(actions[index]!);
        break;
      }
      if (!removableBase) break;
      // One label group at a time, everywhere it appears. Paylocity's traversal pushes the same
      // labels once per wizard step, and a guess that is worth giving up on step one is worth
      // giving up on all four.
      const before = actions.length;
      for (let index = actions.length - 1; index >= 0; index -= 1) {
        if (managedActionLabelBase(actions[index]!) === removableBase) actions.splice(index, 1);
      }
      if (actions.length === before) break;
    }
  }
}

/**
 * The builder cannot safely trade away a reviewed answer to make the provider's action ceiling.
 * Throwing before the submit action is appended makes that limit an explicit stop instead of a
 * partially filled application that Litos sends anyway.
 */
export class ManagedActionBudgetError extends Error {
  readonly code = 'MANAGED_ACTION_BUDGET';
  readonly blocker: string;
  readonly submitActionAppended = false;

  constructor(portal: SupportedPortal, limit: number, protectedQuestionCount: number) {
    const blocker = `Litos did not press submit: the ${portalFamily(portal)} application needs more than ${limit} safe browser actions to preserve a fill attempt for each of its ${protectedQuestionCount} reviewed questions.`;
    super(blocker);
    this.name = 'ManagedActionBudgetError';
    this.blocker = blocker;
  }
}

type ReviewedQuestionActionProtection = {
  readonly actionBases: ReadonlySet<string>;
  readonly questionCount: number;
};

/**
 * The minimum fixed-field groups that make a Greenhouse application an application at all.
 *
 * A reviewed screener answer is not more important than the applicant's name, email, phone, resume,
 * or required education row. The final tail trim previously protected only the evidence READS for
 * these fields, so it could preserve proof labels while deleting the fills those labels were meant
 * to verify. Keep either the single full-name action or both split-name actions, plus each remaining
 * core group. A phone country combobox is part of the phone group because Greenhouse rejects the
 * national number when its adjacent dial-code control is left on the wrong country.
 */
function coreActionProtection(actions: readonly ManagedBrowserAction[], portal: SupportedPortal): ReadonlySet<string> {
  const available = new Set(actions.map(managedActionLabelBase).filter((base): base is string => Boolean(base)));
  const protectedBases = new Set<string>();
  // The controlled fixture's SSR form is unsafe to mutate until React has attached its handlers.
  // Class-level protection keeps this barrier in discovery trims too; naming it in the core set
  // makes the submit and preview minimum explicit alongside identity and resume.
  if (portal === 'controlled_test' && available.has('controlled_portal_hydrated')) {
    protectedBases.add('controlled_portal_hydrated');
  }
  if (available.has('name')) {
    protectedBases.add('name');
  } else {
    for (const base of ['first_name', 'last_name']) if (available.has(base)) protectedBases.add(base);
  }
  for (const base of ['email', 'phone_country', 'phone', 'resume']) {
    if (available.has(base)) protectedBases.add(base);
  }
  // Greenhouse is the autonomous family with a fixed education row. Protect every complete chain
  // that carries it. The class-level protection in isProtectedManagedAction remains as defence in
  // depth, while keeping the bases here makes the minimum explicit to the budget calculation.
  if (portalFamily(portal) === 'greenhouse') {
    for (const base of available) {
      if (GREENHOUSE_FIXED_EDUCATION_ACTION_RE.test(base)) protectedBases.add(base);
    }
  }
  return protectedBases;
}

/**
 * Pick one COMPLETE action group for every reviewed question that emitted a browser action.
 *
 * React-select fills are multi-action chains: open, fill, choose an option, then press Enter. The
 * shared base label identifies that chain after managedActionLabelBase removes the action suffix.
 * Protecting one action is not enough because a surviving fill without its open or select is not a
 * viable attempt. Ordinary choice questions prefer their scoped fillByLabelText action. Greenhouse
 * React-select questions prefer their first combobox or live-select chain, which is the only path
 * that can drive those controls.
 */
function reviewedQuestionActionProtection(
  actions: readonly ManagedBrowserAction[],
  packet: SubmissionPacket,
): ReviewedQuestionActionProtection {
  const protectedBases = new Set<string>();
  let questionCount = 0;

  for (const item of packet.questions) {
    if (!greenhouseReviewedQuestionAnswer(item, packet).trim()) continue;
    const questionText = normalizeReviewQuestionLabel(item.question);
    if (!questionText || shouldSkipReviewedConsentQuestion(questionText)) continue;
    const suffix = questionText.slice(0, 80);
    const bases = Array.from(new Set(actions.flatMap((action) => {
      const base = managedActionLabelBase(action);
      if (!base || !base.startsWith('question')) return [];
      return actionBaseNamesQuestionSuffix(base, suffix) ? [base] : [];
    })));
    if (bases.length === 0) continue;

    const prefersReactSelect = isGreenhouseReactSelectQuestion(questionText);
    const chosen = bases.find((base) => prefersReactSelect && /^question_(?:combo(?:_label)?|select(?:_live)?):/.test(base))
      ?? bases.find((base) => base === `question:${suffix}`)
      ?? bases.find((base) => /^question_(?:combo(?:_label)?|select(?:_live)?|checkbox):/.test(base));
    if (!chosen || protectedBases.has(chosen)) continue;
    protectedBases.add(chosen);
    questionCount += 1;
  }

  return { actionBases: protectedBases, questionCount };
}

/**
 * The reviewed questions this action list will not attempt at all.
 *
 * Asked of the FINISHED list rather than inferred from the budget arithmetic, because the arithmetic
 * is exactly what keeps being wrong: every silent-drop failure in this module's history looked
 * correct in the code that produced it and only showed up as a question the applicant was told was
 * required and empty on a form Litos had been told to fill.
 *
 * A question is counted as attempted if any action carries its label, whichever branch produced it -
 * the scoped fillByLabelText, a combobox chain, a checkbox click, a direct selector fill. The
 * filters match reviewedQuestionActionProtection deliberately: a question with no answer, no usable
 * label, or a skipped consent question was never going to get an action and is not a shortfall.
 *
 * The prepare path is the caller that needs this. It takes a trimmed list instead of throwing (see
 * the budget block in buildManagedPortalActions), so this is what keeps that trade visible.
 */
export function reviewedQuestionsWithoutActions(
  packet: SubmissionPacket,
  actions: readonly ManagedBrowserAction[],
): string[] {
  const attempted = new Set<string>();
  for (const action of actions) {
    const base = managedActionLabelBase(action);
    if (base?.startsWith('question')) attempted.add(base);
  }
  const missing: string[] = [];
  for (const item of packet.questions) {
    if (!greenhouseReviewedQuestionAnswer(item, packet).trim()) continue;
    const questionText = normalizeReviewQuestionLabel(item.question);
    if (!questionText || shouldSkipReviewedConsentQuestion(questionText)) continue;
    const suffix = questionText.slice(0, 80);
    const hit = [...attempted].some((base) => actionBaseNamesQuestionSuffix(base, suffix));
    if (!hit && !missing.includes(questionText)) missing.push(questionText);
  }
  return missing;
}

/**
 * The reviewed questions the BUDGET dropped, which is not the same set as the ones with no action.
 *
 * Thirteen of the twenty-five families never attempt a reviewed question at any size: the multi-step
 * ones fill page one and stop, and several of the newer adapters carry fixed fields only. On those,
 * reviewedQuestionsWithoutActions correctly returns every question in the packet, and a caller that
 * fed that straight into a send gate would mark every SmartRecruiters, JazzHR, BambooHR, Jobvite,
 * iCIMS, Oracle Cloud, UltiPro, Zoho, Bullhorn, SuccessFactors, Taleo, ADP and Avature packet
 * permanently unsendable over a scope limit that predates the budget and has nothing to do with it.
 *
 * The two cases separate cleanly on one question: did this run attempt ANY of them? A budget that
 * ran out drops a tail and keeps the rest - the core fields are protected and cost far less than the
 * ceiling, so a family that fills questions at all always gets some of them in. A family that fills
 * none of them attempts exactly zero, at every packet size. So zero attempted means a scope limit,
 * and some attempted means the ones missing were dropped to make room.
 *
 * Kept here rather than in the caller because it is the distinction a caller is most likely to get
 * wrong, and getting it wrong is silent in both directions: too eager and every unsupported family
 * stops sending, too lax and a dropped answer goes out unremarked.
 */
export function budgetDroppedReviewedQuestions(
  packet: SubmissionPacket,
  actions: readonly ManagedBrowserAction[],
): string[] {
  const missing = reviewedQuestionsWithoutActions(packet, actions);
  if (missing.length === 0) return [];
  const attemptedAny = actions.some((action) => managedActionLabelBase(action)?.startsWith('question'));
  return attemptedAny ? missing : [];
}

// ─── Workable (apply.workable.com) ────────────────────────────────────────────
// Read off a live Suade posting, 2026-07-28 (apply.workable.com/suade/j/9C43981D17/apply). Plain
// HTML, single step, stable `name` attributes - the simplest of the three added that day.
//
// THE ONE TRAP, and it is a real one: the resume input's id is randomised per render
// (`input_files_input_Zos7eYaJDFVTg6xg`), so it can never be matched by id. Worse, the form ships a
// SECOND file input, `data-ui="avatar"`, for a profile photo - so a bare `input[type="file"]` picks
// whichever comes first and can file the resume as the candidate's headshot. `data-ui="resume"` is
// the stable, correct hook. Same two-file-input hazard the extension's adapters/ashby.ts documents.
const WORKABLE_RESUME_SELECTOR = 'input[type="file"][data-ui="resume"]';
const WORKABLE_ADDRESS_SELECTOR = 'input[name="address"]:visible';
const WORKABLE_LEGACY_CITY_SELECTOR = 'input[name="city"]:visible';
const WORKABLE_PHONE_SELECTOR = 'input[name="phone"][type="tel"]:visible';
const WORKABLE_PHONE_COUNTRY_TRIGGER_SELECTOR =
  'div[role="combobox"][aria-label="Telephone country code"][aria-controls]:visible';
// Selector lists resolve in DOM order, not in the order written. Workable keeps a hidden legacy
// city input before the visible address autocomplete on current forms, so a plain comma list can
// still pick the wrong control. The city arm exists only when no visible address control exists.
const WORKABLE_LOCATION_SELECTOR = `${WORKABLE_ADDRESS_SELECTOR}, body:not(:has(${WORKABLE_ADDRESS_SELECTOR})) ${WORKABLE_LEGACY_CITY_SELECTOR}`;
const WORKABLE_COVER_LETTER_SELECTOR =
  'input[type="file"][data-ui="cover_letter"], input[type="file"][data-ui*="cover" i]';
const WORKABLE_DECLINE_OPTIONAL_COOKIES_SELECTOR = 'button:has-text("Decline all")';
const WORKABLE_COOKIE_DIALOG_SELECTOR =
  'div[role="dialog"][data-ui="cookie-consent"][aria-label="Cookie Consent"]';
const WORKABLE_COOKIE_BACKDROP_SELECTOR = 'div[data-ui="backdrop"]';
const WORKABLE_FINAL_COOKIE_DECLINE_SELECTOR =
  `${WORKABLE_COOKIE_DIALOG_SELECTOR} ${WORKABLE_DECLINE_OPTIONAL_COOKIES_SELECTOR}`;
const WORKABLE_COOKIE_OVERLAY_CLEARED_SELECTOR =
  `body:not(:has(${WORKABLE_COOKIE_DIALOG_SELECTOR})):not(:has(${WORKABLE_COOKIE_BACKDROP_SELECTOR}))`;
const WORKABLE_APPLICATION_FORM_READY_SELECTOR =
  `input[name="firstname"], input[name="email"], ${WORKABLE_RESUME_SELECTOR}`;
const WORKABLE_CHOICE_UNCONFIRMED_ATTR = 'data-litos-choice-unconfirmed-v1';

function pushWorkableManagedPreflightActions(actions: ManagedBrowserAction[]) {
  actions.push({
    type: 'click',
    selector: WORKABLE_DECLINE_OPTIONAL_COOKIES_SELECTOR,
    label: 'workable_cookie_preflight',
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
  actions.push({
    type: 'waitForSelector',
    selector: WORKABLE_APPLICATION_FORM_READY_SELECTOR,
    label: 'workable_application_form_ready',
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
}

type WorkablePhoneCountryPlan = {
  dialCode: string;
  displayedDialCode: string;
  optionSelector: string;
};

type WorkablePhonePlan = {
  fieldValue: string;
  expectedDigits: string;
  country: WorkablePhoneCountryPlan | null;
};

const WORKABLE_PHONE_COUNTRY_SPECS = [
  { countryCode: 'ae', dialCode: '971', nationalDigits: 9, domesticPrefix: '0' },
  { countryCode: 'us', dialCode: '1', nationalDigits: 10, domesticPrefix: '' },
] as const;

function digitsOnly(value: string | null | undefined): string {
  return String(value ?? '').replace(/\D/g, '');
}

function workablePhoneCountryOptionSelector(countryCode: string, dialCode: string): string {
  return `[role="option"][data-country-code="${countryCode}"][data-dial-code="${dialCode}"]`
    + `[id$="__item-${countryCode}"]:visible`;
}

function workablePhonePlan(phone: string | undefined): WorkablePhonePlan | null {
  const raw = phone?.trim();
  if (!raw) return null;
  if (!raw.startsWith('+')) {
    const expectedDigits = digitsOnly(raw);
    return expectedDigits ? { fieldValue: raw, expectedDigits, country: null } : null;
  }
  const digits = digitsOnly(raw);
  const spec = WORKABLE_PHONE_COUNTRY_SPECS.find((candidate) =>
    digits.startsWith(candidate.dialCode)
    && digits.length === candidate.dialCode.length + candidate.nationalDigits);
  // Unknown or malformed international values stay blank instead of being reinterpreted under
  // whichever country the widget happened to start on.
  if (!spec) return null;
  const nationalDigits = digits.slice(spec.dialCode.length);
  const fieldValue = `${spec.domesticPrefix}${nationalDigits}`;
  const displayedDialCode = `+${spec.dialCode}`;
  return {
    fieldValue,
    expectedDigits: digitsOnly(fieldValue),
    country: {
      dialCode: spec.dialCode,
      displayedDialCode,
      optionSelector: workablePhoneCountryOptionSelector(spec.countryCode, spec.dialCode),
    },
  };
}

function workablePhoneBlockerLabel(phone: string | undefined): string {
  const country = workablePhonePlan(phone)?.country;
  return country ? `Phone ${country.displayedDialCode}` : 'Phone';
}

function pushWorkableManagedPhoneActions(
  actions: ManagedBrowserAction[],
  phone: string | undefined,
): boolean {
  const raw = phone?.trim();
  if (!raw) return true;
  const plan = workablePhonePlan(phone);
  if (!plan) return false;
  // This action is deliberately a new action TYPE. An older Stratus rejects the request while
  // normalizing it, before opening a browser, instead of dropping unknown assertion fields and
  // reporting a weak read under the same proof label.
  actions.push({
    type: 'requireCapability',
    value: MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
    label: 'workable_phone_assertion_capability',
    optional: false,
  });
  if (plan.country) {
    // Workable can mount a fresh cookie dialog after resume parsing and the other form mutations.
    // Decline optional cookies again at the final phone boundary, then require both the dialog and
    // its pointer-intercepting backdrop to leave the DOM before touching the country combobox.
    actions.push({
      type: 'click',
      selector: WORKABLE_FINAL_COOKIE_DECLINE_SELECTOR,
      label: 'workable_cookie_final_decline',
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
      requireUnique: true,
    });
    actions.push({
      type: 'waitForSelector',
      selector: WORKABLE_COOKIE_OVERLAY_CLEARED_SELECTOR,
      label: 'workable_cookie_final_cleared',
      optional: false,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
    actions.push({
      type: 'click',
      selector: WORKABLE_PHONE_COUNTRY_TRIGGER_SELECTOR,
      label: 'phone_country_open',
      optional: false,
      timeout: MANAGED_FILL_TIMEOUT_MS,
      requireUnique: true,
    });
    actions.push({
      type: 'click',
      selector: plan.country.optionSelector,
      label: 'phone_country_option',
      optional: false,
      timeout: MANAGED_FILL_TIMEOUT_MS,
      requireUnique: true,
    });
  }
  actions.push({
    type: 'fill',
    selector: WORKABLE_PHONE_SELECTOR,
    value: plan.fieldValue,
    label: 'phone',
    optional: false,
    timeout: MANAGED_FILL_TIMEOUT_MS,
    requireUnique: true,
  });
  if (plan.country) {
    actions.push({
      type: 'extract',
      selector: WORKABLE_PHONE_COUNTRY_TRIGGER_SELECTOR,
      label: 'filled_field:phone_country',
      optional: false,
      timeout: MANAGED_FILL_TIMEOUT_MS,
      requireUnique: true,
      requireNonEmpty: true,
      expectedValueIncludes: plan.country.displayedDialCode,
      expectedValueDigits: plan.country.dialCode,
      stabilityWindowMs: 1_200,
    });
  }
  actions.push({
    type: 'extract',
    selector: WORKABLE_PHONE_SELECTOR,
    attribute: 'value',
    label: 'filled_field:phone',
    optional: false,
    timeout: MANAGED_FILL_TIMEOUT_MS,
    requireUnique: true,
    requireNonEmpty: true,
    expectedValueDigits: plan.expectedDigits,
    stabilityWindowMs: 1_200,
  });
  return true;
}

// ─── JazzHR (*.applytojob.com) ────────────────────────────────────────────────
// Read off a live TicketManager posting, 2026-07-28. The cleanest naming of any ATS Litos supports:
// every field is `resumator-<field>-value` on BOTH id and name, so no fallback chain is needed.
//
// Note JazzHR's submit control is `input[type="button"][name="submit_resume"]` - type BUTTON, not
// submit. The generic `button[type="submit"], input[type="submit"]` selector used for every other
// portal would never find it. Moot in practice (see CAPTCHA_GATED_FAMILIES - JazzHR never
// auto-submits) but recorded here so nobody "fixes" the omission later by wiring up the wrong one.
const JAZZHR_RESUME_SELECTOR = 'input[type="file"][name="resumator-resume-value"]';
// NOTE: JazzHR takes a cover letter as `textarea[name="resumator-coverletter-value"]` - TEXT, not a
// file. SubmissionPacket carries the cover letter only as a rendered PDF Buffer, so there is nothing
// to type into it, and no selector is declared here on purpose: a declared-but-unused constant read
// as though the field were handled. Today an approved cover letter is simply not sent to JazzHR.
// Fixing it means threading the letter's text (not just its PDF) through the packet; until then this
// is a known, deliberate gap rather than a silent one.

// ─── Paylocity (recruiting.paylocity.com) ─────────────────────────────────────
// Read off a live posting, 2026-07-28 (2000recruiting.paylocity.com/Recruiting/Jobs/Apply/44457).
// Two structural quirks:
//  1. Fields carry NO `name` attribute at all, and their ids contain dots (`info.firstName`), which
//     is invalid in a `#id` selector. They must use the [id="..."] attribute form - exactly what
//     quoteAttr() at the top of this file already exists for, so no new escaping is needed.
//  2. THREE file inputs (#btn-resume, #btn-coverLetter, #btn-additionalFiles), so a bare file
//     selector is wrong here too, for the same reason as Workable.
// Paylocity is multi-step (see MULTI_STEP_FAMILIES); these fills cover page one only.
const paylocityId = (id: string) => `[id="${quoteAttr(id)}"]`;
const PAYLOCITY_RESUME_SELECTOR = '#btn-resume';
const PAYLOCITY_COVER_LETTER_SELECTOR = '#btn-coverLetter';

// ─── Paylocity multi-step traversal ───────────────────────────────────────────
// Paylocity is a FOUR-step wizard ("Step 1 of 4" in .progress-header), and its composition is
// per-posting, driven by flags on window.pageData: hasScreener, shouldIncludeEeoQuestions,
// shouldIncludeOfccpQuestions, displayAcknowledgement. Read live 2026-07-28 off a real posting.
//
// THE HAZARD, and the reason this is one careful selector rather than a loop of clicks: the wizard
// reuses the SAME id, #btn-submit, for both "Next Step" and the terminal submit. Clicking it N times
// to walk the wizard therefore ends by pressing the real Submit on the last step. Scoping the click
// by its visible text means the advance action CANNOT match the terminal button - the moment the
// label stops saying "Next Step", the selector stops matching and the run simply stops advancing.
// That is a structural guarantee, not a count we have to keep in sync with Paylocity's step logic.
const PAYLOCITY_ADVANCE_SELECTOR = '#btn-submit:has-text("Next Step")';

// Four steps total, so at most three advances ever. Bounded rather than "advance until it stops
// matching" because the action list is built up-front and the managed runner cannot branch mid-run.
// Every advance and every fill is optional, so a posting with fewer steps just no-ops the extras.
const PAYLOCITY_MAX_ADVANCES = 3;

// What Litos must never fill or click its way past on the final step. These are the exact things
// the live model shows can appear there: EEO/OFCCP self-identification, a prior-conviction
// declaration, a work-authorization declaration, and the acknowledgement whose own text reads "you
// hereby certify that the facts set forth in the above employment application are true and
// complete". Voluntary demographics belong to the student alone; the rest are legal attestations
// made in her name. Litos fills everything up to that page and hands it over.
const PAYLOCITY_TERMINAL_MARKERS = [
  'acknowledgements.priorConviction',
  'acknowledgements.authorizedToWorkInUS',
  'acknowledgements.eeoGenderEthnicity',
] as const;

// ─── Rippling (ats.rippling.com) ──────────────────────────────────────────────
// Read off a live Rippling posting, 2026-07-29 (ats.rippling.com/rippling/jobs/875b2547-.../apply).
//
// THE TRAP: both `name` AND `id` are randomised per render - `name="Z9gMtYRYFO"`, `id="field-8"`.
// Neither can ever be matched, which rules out every hook the other adapters in this file rely on.
// `data-testid` is the one stable attribute, and it is present and stable on every field, so this is
// the rare adapter where data-testid is the correct primary selector rather than a fallback.
//
// Two file inputs again (resume + cover letter). Weaker than Workable's avatar hazard, and worth
// being precise about rather than borrowing that story: on the live form and on the fixture the
// resume input comes FIRST, so a bare input[type="file"] happens to resolve to the right one today.
// Verified in-browser 2026-07-29 - the naive selector and the captured one both resolved to
// input-resume. The captured selector is still what ships, because "correct as long as the DOM order
// never changes" is not a property worth depending on when a stable attribute is right there.
const RIPPLING_RESUME_SELECTOR = 'input[type="file"][data-testid="input-resume"]';
const RIPPLING_COVER_LETTER_SELECTOR = 'input[type="file"][data-testid="input-cover_letter"]';

// NOT filled, and this is the interesting part of the Rippling capture. The form has three
// comboboxes and they ALL share one data-testid ("input-select-search-input"), so they cannot even
// be told apart by selector. Reading the label above each one identifies them as: Pronouns, the
// phone country code, and "Please identify your race". Two of those are the student's own identity
// to declare or decline, and the third is part of a field we already fill. So there is nothing here
// Litos should be typing into, and the ambiguity is moot.
//
// Also never touched: [data-testid="radio-sms_opt_in"], whose label reads "Yes - I consent to
// receiving text messages". A consent control, covered by the standing rule below.

// ─── BreezyHR (*.breezy.hr) ───────────────────────────────────────────────────
// Read off a live Zinier posting, 2026-07-29 (zinier.breezy.hr/p/7eefd4d49b75-.../apply).
// The cleanest naming of the seven: stable `c`-prefixed names on every field.
//
// Note cName is ONE full-name field, not a first/last pair, so this family does not split the name.
const BREEZY_RESUME_SELECTOR = 'input[type="file"][name="cResume"]';

// Breezy takes its long-form answer as `textarea[name="cSummary"]`, not a file, so there is no
// cover-letter FILE input for hasCoverLetterUpload() to find. Deliberately a never-matching
// selector, exactly as JazzHR does and for the same reason: this map answers "can this portal accept
// a cover-letter FILE", and answering yes would attach a PDF to a control that cannot hold one.
// An approved cover letter is therefore not sent to Breezy today. A known, deliberate gap - and the
// same fix as JazzHR's would close both (thread the letter's TEXT through the packet, not just its
// rendered PDF). Only one tenant was captured, so if a Breezy form is ever seen with a real
// cover-letter file input, re-capture before widening this.
const BREEZY_COVER_LETTER_SELECTOR = 'input[type="file"][name="cCoverLetterFileThatDoesNotExist"]';

// NOT filled: input[name="smsConsent"] and input[name="gdprAgreement"]. Both consent checkboxes.
// gdprAgreement is never filled by the fixed-field pass or the reviewed-question replay: on a
// submit run whose packet licenses it, it is ticked by the guarded consent-tick block immediately
// before the submit action (managedConsentTickPlan, breezy entry in CONSENT_TICK_CONTROL_NAMES),
// and on every other run it stays with the applicant exactly as before. smsConsent stays with the
// applicant unconditionally - marketing texts are not the application's routine privacy consent.
//
// AND NOT FILLED, the one worth reading: Breezy ships a honeypot at name="hp_<4 hex>" - randomised
// per render, so it must be matched by prefix if it is ever matched at all. It defeats a visibility
// check completely, and this was measured rather than reasoned about: against the fixture that
// reproduces it, Playwright's own isVisible() returns TRUE, because the input's own box is 293x38
// with opacity 1 and visibility visible. It is concealed ONLY by an ancestor (.apply-field-extra)
// with height 0 and overflow hidden.
//
// So ancestor geometry, not the element's own computed style and not isVisible(), is what a honeypot
// check has to look at. Same class of trap as the Workday 1px sr-only field the extension's
// isHoneypotField already guards. This adapter is safe because it fills by explicit name; anything
// that fills generically walks straight into it, and a filled honeypot means the employer silently
// discards the application.

// ─── BambooHR ({tenant}.bamboohr.com/careers/{id}) ────────────────────────────
// Read off a live PRC-Saltillo posting, 2026-07-29 (prentkeromich.bamboohr.com/careers/480). This
// closes the "not yet captured" item left open by the 2026-07-28 capture.
//
// The form is revealed by an "Apply for This Job" button and renders into the SAME url - there is no
// separate /apply route, and /careers/{id}/apply is a blank page. So the managed run has to click
// that button before anything exists to fill, the same shape as SmartRecruiters' "I'm interested".
//
// ids are FabricTextField-<n>, sequential and render-dependent, so every field matches on `name`.
// Dotted names (city.value) are fine inside a quoted attribute selector and need no escaping.
const BAMBOOHR_OPEN_FORM_SELECTOR = 'button:has-text("Apply for This Job")';
const BAMBOOHR_RESUME_SELECTOR = 'input[type="file"][aria-label="file-input"]';
// One file input only on the captured form, and it is the resume. No cover-letter file control was
// present, so the same never-matching declaration as Breezy/JazzHR applies rather than a guess.
const BAMBOOHR_COVER_LETTER_SELECTOR = 'input[type="file"][name="bambooCoverLetterThatDoesNotExist"]';

// Captured from rebuy and Optiweb Recruitee forms on 2026-08-09.
const RECRUITEE_RESUME_SELECTOR = 'input[type="file"][name="candidate.cv"]';
const RECRUITEE_COVER_LETTER_SELECTOR = 'input[type="file"][name="candidate.coverLetterFile"]';

// Captured from Teamtailor and AICOM tenant forms on 2026-08-09.
const TEAMTAILOR_RESUME_SELECTOR = '#upload_resume_field input[type="file"]';
// Neither captured Teamtailor form exposed a dedicated cover-letter file input. Never let a broad
// file selector replace the resume with the cover letter.
const TEAMTAILOR_COVER_LETTER_SELECTOR = 'input[type="file"][name="teamtailorCoverLetterThatDoesNotExist"]';

// Personio, Pinpoint, and Comeet were captured on two unrelated live tenants per family on
// 2026-08-09. Only stable platform-owned names and ids are used here. None of the three is allowed
// to auto-submit: Personio does not expose requiredness as native HTML, Pinpoint requires a privacy
// processing choice, and Comeet renders reCAPTCHA on both captured forms.
const PERSONIO_RESUME_SELECTOR = 'input[type="file"][name="documents.cv"]';
const PERSONIO_COVER_LETTER_SELECTOR = 'input[type="file"][name="documents.cover-letter"]';
const PINPOINT_RESUME_SELECTOR = 'input[type="file"][name="application_form[application][cv]"]';
const PINPOINT_COVER_LETTER_SELECTOR = 'input[type="file"][name="application_form[application][cover_letter]"]';
const COMEET_RESUME_SELECTOR = 'input[type="file"][name="cv"]';
const COMEET_COVER_LETTER_SELECTOR = 'input[type="file"][name="coverLetter"]';

/* THE ONE CONSENT CONTROL EACH GRANT-CONDITIONAL FAMILY IS EVER ALLOWED TO TICK.
 *
 * Platform-owned names from the 2026-08-09 two-tenant captures, the same source as the resume
 * selectors above. Teamtailor renders candidate[consent_given] beside the send control;
 * candidate[consent_given_future_jobs] is deliberately NOT here - it is the talent-pool retention
 * opt-in, a different act that no standing permission covers, and it stays with the applicant.
 *
 * Pinpoint's privacy-processing consent was captured with the application_form[application] prefix
 * every other Pinpoint control carries; the bare application[process_information] spelling appears
 * in this file's own historical comments, so both are accepted as the control's IDENTITY. Accepting
 * two spellings of one name is not a sweep: the tick plan below still requires exactly ONE packet
 * question to match, and the runner-side guard still requires exactly one visible node. */
const CONSENT_TICK_CONTROL_NAMES: Record<ConsentGrantConditionalFamily, readonly string[]> = {
  teamtailor: ['candidate[consent_given]'],
  pinpoint: [
    'application_form[application][process_information]',
    'application[process_information]',
  ],
  /* Captured as this exact camel-case spelling on the 2026-07-29 Zinier read (see the BreezyHR
   * block above) and matched live on the 2026-08-20 Transparent Hiring run, whose packet selector
   * reads input[name="gdprAgreement"]. selectorControlName hands back the attribute value byte for
   * byte - no case folding, no bracket rewriting - so the one captured spelling is the whole list.
   * smsConsent is deliberately NOT here: text-message marketing is an ongoing relationship no
   * standing permission covers, the same judgement as teamtailor's future-jobs opt-in. */
  breezy: ['gdprAgreement'],
};

/* The name vocabulary the discovery script's isHoneypot uses, applied to the control this plan is
 * about to tick. The fixed names above can never match it; the check exists so a name added to the
 * table later cannot either, and so the rule "the honeypot guard runs before any tick" is written
 * where the tick is built rather than remembered. */
const HONEYPOT_CONTROL_NAME_RE = /\b(?:honeypot|hp_|bot[-_]?field|hidden[-_]?field)\b/i;

/* A discovery-shape selector naming exactly one control: `input[name="..."]` as stableSelector
 * writes it, or the bare `[name="..."]` an earlier capture wrote without the element prefix.
 * Measured live 2026-08-20 on the Transparent Hiring (breezy) packet: the stored consent question
 * carries portal_selector `[name="gdprAgreement"]`, the element-prefixed regex returned null, the
 * plan saw zero candidates, and the run parked on the very consent the grant licenses. A bare
 * attribute selector anchored end to end still names exactly one control by its name attribute,
 * which is the only property this rule exists to guarantee. Anchoring is unchanged, so an
 * alternation, a descendant chain or anything page-wide can still never qualify - the plan ticks
 * one named control or nothing. */
const SINGLE_NAMED_CONTROL_SELECTOR_RE = /^(?:input|textarea|select)?\[name="((?:[^"\\]|\\.)*)"\]$/;

function selectorControlName(selector: string | undefined): string | null {
  const match = SINGLE_NAMED_CONTROL_SELECTOR_RE.exec(selector?.trim() ?? '');
  return match ? match[1].replace(/\\(.)/g, '$1') : null;
}

/* THE CAPTURED LABEL CAN CARRY THE CONTROL'S OWN NAME, and the grammar must not read it.
 *
 * Breezy's discovery capture welds the control name onto the end of the consent sentence: the live
 * 2026-08-20 Transparent Hiring row stores "i've read the privacy notice below and consent the
 * processing of my data as part of my job application. gdpragreement". That trailing token is the
 * control's IDENTITY - the same name the packet's own selector carries, which is exactly how this
 * function's caller proved which control the question is about - not a second document, so it comes
 * off before consentAcknowledgementLicence reads the sentence. Bounded on purpose: only the exact
 * control name, only as the label's final token, only behind whitespace or sentence punctuation,
 * compared case-insensitively because the stored label is lowercased. Anything else stays in the
 * label and holds, which is the direction the grammar is allowed to fail in. */
function consentQuestionWithoutWeldedControlName(questionText: string, controlName: string): string {
  const escaped = controlName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = questionText.replace(new RegExp(String.raw`[\s.,;:]+${escaped}\s*$`, 'i'), '').trim();
  return stripped || questionText;
}

/** Everything a grant-conditional submit run needs in order to tick the consent control: which
 *  control, under which question wording, and under which grant the acceptance is licensed. */
export type ManagedConsentTickPlan = {
  family: ConsentGrantConditionalFamily;
  question: string;
  selector: string;
  licence: PortalConsentGrant;
  /* WHOSE acceptance the tick executes, kept truthful end to end. 'consent_permission' is the
   * machine acceptance the resolver recorded under the standing grant - the only provenance the
   * submit-unlocking families accept. 'applicant_review' is HER OWN reviewed answer replayed onto
   * the control, allowed only on breezy (see managedConsentTickPlan condition 4), and it is never
   * relabelled: the packet record keeps answer_source applicant_review, and the tick's action label
   * says the run replayed her review rather than exercised the permission. */
  answerProvenance: 'consent_permission' | 'applicant_review';
};

export const MANAGED_CONSENT_TICK_GUARD_LABEL = 'consent_tick_honeypot_guard';
export const MANAGED_CONSENT_TICK_LABEL_PREFIX = 'question_consent_tick';

/**
 * WHETHER THIS RUN MAY TICK THE CONSENT CONTROL, and exactly which one.
 *
 * Null is "park": fill what the family always fills, press nothing, hand off - today's behaviour,
 * exactly. Every condition below fails toward null, and each one is a separate fact:
 *
 *   1. The family is grant-conditional and the account's standing permission is present on the
 *      packet's profile. That field is only ever set by the loader after the version check and the
 *      grantedAnswerReplay trust gate (lib/applicationProfileLike.ts), so both come for free here.
 *   2. EXACTLY ONE packet question names the family's captured consent control. Zero means the
 *      prepare never saw the control this plan was written from, so the form in front of the run is
 *      not provably the captured shape; two or more means ambiguity. Both park rather than guess.
 *   3. The question's own wording classifies as the routine consent-acknowledgement class through
 *      consentAcknowledgementLicence - the SAME call the review path records acceptances with, so
 *      the held-declaration veto (HELD_DECLARATION_VOCABULARY, lib/questionDiscovery.ts) runs first
 *      and is not reachable from here. A truth attestation, background-check authorization, EEO or
 *      work-authorization declaration sitting in the consent control's place is never ticked,
 *      whatever control it sits in. The licence is also re-derived from the profile buildPacket
 *      loaded moments ago, so a permission revoked after review kills the plan at fill time.
 *   4. The stored answer is an acceptance the packet can already explain, and WHOSE acceptance it
 *      is depends on what the plan is unlocking. On teamtailor and pinpoint the plan is what
 *      unlocks SUBMIT, so only the machine acceptance qualifies: answerSource
 *      'consent_permission', written by the resolution loop with consent_permission_version and
 *      consent_permission_granted_at beside it (routes/submissionRunner.ts, "THE ACCEPTANCE,
 *      WRITTEN DOWN ON THE QUESTION IT WAS MADE ON"); her own reviewed tick still parks there,
 *      pinned in recruiteeTeamtailorPortal.test.ts, because relabelling her answer as made under
 *      the permission would misreport it. On breezy the submit was never this plan's to unlock -
 *      the family is statically autonomous and the reviewed-question replay already fills her
 *      answers onto every breezy control, consent-shaped included (shouldSkipPortalConsentQuestion
 *      names no breezy skip) - so her own applicant_review acceptance ALSO licenses the tick
 *      there, executed as a replay of HER answer and recorded that way: the plan carries
 *      answerProvenance 'applicant_review', the packet record keeps her provenance untouched, and
 *      the tick's action label says replayed_review. Measured live 2026-08-20 (Transparent
 *      Hiring): the parked row carries her review's "Yes", because the resolver's
 *      applicant-override contract (PR #566) rightly refuses to overwrite or relabel an answer she
 *      gave, so a machine-only gate would park forever on a consent she has already accepted in so
 *      many words.
 *   5. The wording is not the future-jobs retention opt-in, and the control's name is not
 *      honeypot-shaped.
 */
export function managedConsentTickPlan(
  portal: SupportedPortal,
  packet: SubmissionPacket,
): ManagedConsentTickPlan | null {
  const family = consentGrantConditionalFamilyName(portalFamily(portal));
  if (!family || portal === 'manual_recruitee') return null;
  const ap = packet.applicationProfile;
  const grant = ap?.consent_acknowledgement_permission;
  if (!ap || !grant) return null;
  if (!portalCanAutoSubmitWithConsentGrant(portal, grant)) return null;
  const names = CONSENT_TICK_CONTROL_NAMES[family];
  const candidates = packet.questions.flatMap((item) => {
    const selector = durablePortalSelector(reviewQuestionPortalSelector(item));
    const name = selectorControlName(selector);
    return name && names.includes(name) && selector ? [{ item, selector, name }] : [];
  });
  if (candidates.length !== 1) return null;
  const { item, selector, name } = candidates[0];
  if (HONEYPOT_CONTROL_NAME_RE.test(name)) return null;
  // A control whose live evidence failed is refused to every builder; the tick is no exception.
  if (packetQuestionFailed(packet, item)) return null;
  // The welded control name comes off only AFTER the selector proved which control this is, so
  // the strip can never invent a consent: it removes the one token the match itself explains.
  const questionText = consentQuestionWithoutWeldedControlName(
    normalizeReviewQuestionLabel(item.question),
    name,
  );
  if (!questionText || FUTURE_JOBS_RETENTION_CONSENT_RE.test(questionText)) return null;
  /* THE SAME CONTEXT SHAPE THE RESOLVER USED, recomposed rather than trusted. packet.jdText is the
   * raw posting prose; the frozen employer line lives only in the discovery pass's composed
   * context, and Teamtailor's platform-default sentence writes the tenant's name mid-clause
   * ("confirm that Fully store my personal details..."). Without the line, the grammar's coverage
   * accounting cannot place that name and this re-derivation held a licence the resolver had
   * already granted. A packet with no employerName composes no line and parks, fail-closed. */
  const licenceContext = [frozenJobEmployerContext(packet.employerName ?? ''), packet.jdText ?? '']
    .filter(Boolean)
    .join('\n');
  const licence = consentAcknowledgementLicence(questionText, ap, licenceContext || undefined);
  if (!licence) return null;
  // Condition 4 of the block comment above: whose acceptance this is. Machine acceptance
  // everywhere; her own reviewed acceptance only on breezy, and only as itself.
  const answerProvenance = item.answerSource === 'consent_permission'
    ? 'consent_permission' as const
    : family === 'breezy' && applicantChoseAnswer(item)
      ? 'applicant_review' as const
      : null;
  if (!answerProvenance) return null;
  if (!item.answer.trim() || !isConsentAcceptingWording(item.answer)) return null;
  return { family, question: questionText, selector, licence, answerProvenance };
}

/* TICK ONCE, GUARDED, RIGHT BEFORE THE SUBMIT ACTION.
 *
 * Three actions, all required (optional: false), so any one of them failing stops the list and
 * makes the confirmAndSubmit that follows physically unreachable - the run degrades to today's
 * fill-and-hand-off instead of submitting around a consent it could not prove it ticked.
 *
 *   requireCapability  an older Stratus that would silently drop the assertion fields below rejects
 *                      the whole request during normalization, before a browser opens - the same
 *                      device the Workable phone proof uses.
 *   extract            the honeypot guard, and it runs BEFORE the tick: requireUnique proves the
 *                      selector resolves to exactly one node, and requireVisible + requireNonEmpty
 *                      demand a real layout read that returns something a person can see - a
 *                      zero-height-ancestor honeypot (the Breezy hp_ trap this file documents)
 *                      yields no visible entry and refuses the action. requireVisible is a field,
 *                      not a capability, so on a runner deployed before extract-require-visible-v1
 *                      it degrades to uniqueness alone; the capability above pins everything that
 *                      CAN be pinned by rejection.
 *   click              the one authorized tick. click toggles, which is exactly why there is ONE
 *                      click behind a uniqueness guard and never a ladder - see the Cloudflare
 *                      measurement on pushGreenhouseCheckboxOptionActions. No captured tenant
 *                      pre-ticks the control (pre-ticked consent is the pattern GDPR forbids), and
 *                      that must be re-confirmed live before widening this to any new family.
 *                      Re-confirmed for breezy on 2026-08-20: the Transparent Hiring run reached
 *                      submit with gdprAgreement empty and parked on the employer's own
 *                      "required and is still empty" validation, so the tenant does not pre-tick.
 */
function pushManagedConsentTickActions(actions: ManagedBrowserAction[], plan: ManagedConsentTickPlan) {
  actions.push({
    type: 'requireCapability',
    value: MANAGED_EXTRACT_ASSERTIONS_CAPABILITY,
    label: 'consent_tick_assertion_capability',
    optional: false,
  });
  actions.push({
    type: 'extract',
    selector: plan.selector,
    attribute: 'name',
    label: MANAGED_CONSENT_TICK_GUARD_LABEL,
    optional: false,
    requireUnique: true,
    requireVisible: true,
    requireNonEmpty: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
  actions.push({
    type: 'click',
    selector: plan.selector,
    // A replayed applicant_review acceptance says so in the transcript, so the run's own record
    // never reads as a permission being exercised when it was her answer being executed.
    label: plan.answerProvenance === 'applicant_review'
      ? `${MANAGED_CONSENT_TICK_LABEL_PREFIX}:replayed_review:${plan.question.slice(0, 80)}`
      : `${MANAGED_CONSENT_TICK_LABEL_PREFIX}:${plan.question.slice(0, 80)}`,
    optional: false,
    requireUnique: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
}

/** The number of actions pushManagedConsentTickActions reserves out of the managed budget. */
const CONSENT_TICK_ACTION_COUNT = 3;

// Zoho Recruit renders the application inside the public detail route. Field ids are tenant data,
// while the Candidate API names and the resume attachment marker are stable across the two live
// tenants inspected. Consent, retention, EEO and CAPTCHA controls are deliberately absent.
const ZOHO_RECRUIT_RESUME_SELECTOR = 'input[type="file"][name*="Resume" i], input[type="file"][data-zcqa*="resume" i]';
const ZOHO_RECRUIT_COVER_LETTER_SELECTOR = 'input[type="file"][name="zohoCoverLetterThatDoesNotExist"]';

// Bullhorn OSCP is self-hosted but its stock Angular form uses these form-control names. There is
// only one stock file input and app.json names it resume. Custom legal controls are never mapped.
const BULLHORN_RESUME_SELECTOR = 'input[type="file"][formcontrolname="resume"], input[type="file"][name="resume"]';
const BULLHORN_COVER_LETTER_SELECTOR = 'input[type="file"][name="bullhornCoverLetterThatDoesNotExist"]';

// NOT filled: input[name^="nickname_"], BambooHR's honeypot, labelled "Please leave this field
// blank" and concealed the same zero-height-ancestor way Breezy's is.
//
// AND recorded because someone will otherwise "fix" it later: this form has TWO type="submit"
// buttons, "Submit Application" and "Cancel". The generic `button[type="submit"]` selector used for
// the autonomous families is ambiguous here and could press Cancel. Moot while BambooHR is
// CAPTCHA-gated and therefore never auto-submits, which is exactly why it is written down.

/* WHERE THE RESUME GOES, WRITTEN DOWN ONCE SO THAT EVERY LATER UPLOAD CAN BE TOLD TO STAY OFF IT.
 *
 * Until this map existed, "which control is the resume" was knowledge that lived only inside each
 * family branch of pushFixedFieldActions and fillPortal, and the transcript upload, which runs after
 * all of them, had no way to ask. It guessed instead, with a name/id blocklist that spelled the word
 * "resume" - and seven of the families identify their resume input by something else entirely
 * (data-ui, data-testid, candidate.cv, documents.cv, an id-scoped wrapper, a bare cv). Against those
 * the blocklist was inert, setInputFiles replaces rather than appends, and the transcript took the
 * resume's slot on a form that was then submitted.
 *
 * A longer blocklist would have been the same mistake one family wider. This is the same fact stated
 * positively and in one place: the family's own resume selector, the one its fill path really uses.
 * uploadFirst reserves whatever it matches before any other document is offered a control, and
 * transcriptUploadSelector subtracts it from every arm it hands the managed runner. A family added
 * tomorrow gets both protections by having an entry here, which it needs anyway in order to upload a
 * resume at all - there is nothing separate left to remember. resumeSelectorMatchesFillPath (see
 * documentUploadIdentity.test.ts) measures that this map still names what the fill paths use.
 *
 * Keyed by family rather than by portal because the fill branches dispatch on family; the controlled
 * QA portals and manual_recruitee resolve through portalFamily to the same answer their real
 * counterpart gives. */
const RESUME_UPLOAD_SELECTORS: Record<PortalFamily, string> = {
  // Every arm the managed path pushes an upload action for, which is a superset of the direct
  // path's GREENHOUSE_RESUME_SELECTOR. Read from the function rather than restated, so the two
  // cannot drift.
  greenhouse: greenhouseCoreFieldEvidenceSelectors('resume').join(', '),
  lever: LEVER_RESUME_SELECTOR,
  ashby: ASHBY_RESUME_SELECTOR,
  smartrecruiters: SMARTRECRUITERS_RESUME_SELECTOR,
  workable: WORKABLE_RESUME_SELECTOR,
  jazzhr: JAZZHR_RESUME_SELECTOR,
  paylocity: PAYLOCITY_RESUME_SELECTOR,
  rippling: RIPPLING_RESUME_SELECTOR,
  breezy: BREEZY_RESUME_SELECTOR,
  bamboohr: BAMBOOHR_RESUME_SELECTOR,
  recruitee: RECRUITEE_RESUME_SELECTOR,
  teamtailor: TEAMTAILOR_RESUME_SELECTOR,
  personio: PERSONIO_RESUME_SELECTOR,
  pinpoint: PINPOINT_RESUME_SELECTOR,
  comeet: COMEET_RESUME_SELECTOR,
  zoho_recruit: ZOHO_RECRUIT_RESUME_SELECTOR,
  bullhorn: BULLHORN_RESUME_SELECTOR,
  // The account-walled families reach no application form, so no control on the page in front of a
  // run is theirs to claim. A never-matching selector is the honest answer, and it keeps every
  // caller from having to special-case the list.
  sap_successfactors: 'input[type="file"][name="noResumeControlReachableWithoutSuccessFactorsAccount"]',
  oracle_taleo: 'input[type="file"][name="noResumeControlReachableWithoutTaleoLegalAcceptance"]',
  adp_recruiting: 'input[type="file"][name="noResumeControlReachableWithoutAdpAccount"]',
  avature: 'input[type="file"][name="noResumeControlReachableWithoutAvatureAccount"]',
  jobvite: 'input[type="file"][name="noResumeControlReachableWithoutConsent"]',
  icims: 'input[type="file"][name="noResumeControlReachableWithoutAccount"]',
  oraclecloud: 'input[type="file"][name="noResumeControlReachableWithoutAuthCode"]',
  ultipro: 'input[type="file"][name="noResumeControlCaptured"]',
};

export function resumeUploadSelector(portal: SupportedPortal): string {
  return RESUME_UPLOAD_SELECTORS[portalFamily(portal)];
}

/** The label on the managed read-back of the resume's control. See pushResumeUploadVerifyAction. */
export const RESUME_UPLOAD_VERIFY_LABEL = 'resume_upload_verify';

/** `C:\fakepath\Mehek Mandal Resume.pdf` is what a browser reports for a file input's value. */
function uploadedFileName(value: string | null | undefined): string {
  const raw = (value ?? '').trim();
  if (!raw) return '';
  return raw.split(/[\\/]/).pop()?.trim().toLowerCase() ?? '';
}

/* WHICH DOCUMENT IS SITTING IN THE RESUME'S CONTROL, READ OFF THE FORM ITSELF.
 *
 * The managed runner reports the read pushed by pushResumeUploadVerifyAction. This turns it into the
 * only question worth asking of it: does the resume's own control now hold a DIFFERENT document of
 * hers? That is the failure that reports itself as success, because both uploads returned cleanly
 * and both labels reached filled_fields.
 *
 * Three readings and only one of them is a finding:
 *   - the resume's own file name: the upload held, nothing to say;
 *   - the transcript's or the cover letter's file name: displaced, and the resume is gone;
 *   - anything else, including empty: NOT a finding. An uploader that consumes the file and resets
 *     its own input reads back empty on a form where everything worked, and calling that a lost
 *     resume would block correct runs. The missing-upload case is already covered by the filled
 *     fields, so nothing is lost by being strict here.
 * Ordering is deliberate: one arm reading back the resume settles it, whatever any other arm says. */
export function managedResumeUploadDisplacement(
  extracted: ReadonlyArray<{ label?: string; selector?: string; value: string | null }> | undefined,
  packet: Pick<SubmissionPacket, 'resumeName' | 'transcriptName' | 'coverLetterName'>,
): 'transcript' | 'cover_letter' | null {
  const readings = (extracted ?? [])
    .filter((item) => item.label === RESUME_UPLOAD_VERIFY_LABEL)
    .map((item) => uploadedFileName(item.value))
    .filter((name) => name.length > 0);
  if (readings.length === 0) return null;
  const resume = uploadedFileName(packet.resumeName);
  if (resume && readings.includes(resume)) return null;
  const transcript = uploadedFileName(packet.transcriptName);
  if (transcript && readings.includes(transcript)) return 'transcript';
  const coverLetter = uploadedFileName(packet.coverLetterName);
  if (coverLetter && readings.includes(coverLetter)) return 'cover_letter';
  return null;
}

const COVER_LETTER_UPLOAD_SELECTORS: Record<SupportedPortal, string> = {
  greenhouse: 'input#cover_letter[type="file"], input[type="file"][name*="cover_letter" i], input[type="file"][id*="cover_letter" i], label:has-text("Cover Letter") input[type="file"]',
  lever: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  ashby: ASHBY_COVER_LETTER_SELECTOR,
  smartrecruiters: 'spl-dropzone[data-test*="cover" i] input[type="file"], input[type="file"][name*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  controlled_test: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  controlled_lever: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  controlled_ashby: ASHBY_COVER_LETTER_SELECTOR,
  controlled_smartrecruiters: 'input[type="file"][name*="cover" i], input[type="file"][id*="cover" i], label:has-text("Cover Letter") input[type="file"]',
  workable: WORKABLE_COVER_LETTER_SELECTOR,
  controlled_workable: WORKABLE_COVER_LETTER_SELECTOR,
  // JazzHR takes a cover letter as a TEXTAREA, not a file upload, so there is no file input for
  // hasCoverLetterUpload() to find. Deliberately a never-matching file selector: this map answers
  // "can this portal accept a cover-letter FILE", and answering yes would make the caller attach a
  // PDF to a control that cannot hold one. See the JAZZHR_RESUME_SELECTOR note for why the textarea
  // is not filled either.
  jazzhr: 'input[type="file"][name="resumator-coverletter-file"]',
  controlled_jazzhr: 'input[type="file"][name="resumator-coverletter-file"]',
  paylocity: PAYLOCITY_COVER_LETTER_SELECTOR,
  controlled_paylocity: PAYLOCITY_COVER_LETTER_SELECTOR,
  rippling: RIPPLING_COVER_LETTER_SELECTOR,
  controlled_rippling: RIPPLING_COVER_LETTER_SELECTOR,
  breezy: BREEZY_COVER_LETTER_SELECTOR,
  controlled_breezy: BREEZY_COVER_LETTER_SELECTOR,
  bamboohr: BAMBOOHR_COVER_LETTER_SELECTOR,
  controlled_bamboohr: BAMBOOHR_COVER_LETTER_SELECTOR,
  recruitee: RECRUITEE_COVER_LETTER_SELECTOR,
  manual_recruitee: RECRUITEE_COVER_LETTER_SELECTOR,
  teamtailor: TEAMTAILOR_COVER_LETTER_SELECTOR,
  personio: PERSONIO_COVER_LETTER_SELECTOR,
  pinpoint: PINPOINT_COVER_LETTER_SELECTOR,
  comeet: COMEET_COVER_LETTER_SELECTOR,
  zoho_recruit: ZOHO_RECRUIT_COVER_LETTER_SELECTOR,
  bullhorn: BULLHORN_COVER_LETTER_SELECTOR,
  sap_successfactors: 'input[type="file"][name="noFormReachableWithoutSuccessFactorsAccount"]',
  oracle_taleo: 'input[type="file"][name="noFormReachableWithoutTaleoLegalAcceptance"]',
  adp_recruiting: 'input[type="file"][name="noFormReachableWithoutAdpAccount"]',
  avature: 'input[type="file"][name="noFormReachableWithoutAvatureAccount"]',
  // These account-walled families never reach a safe form, so there is no file input to claim. A
  // never-matching selector is the honest answer to "can this portal accept a cover-letter file"
  // here, and it keeps hasCoverLetterUpload() from having to special-case them.
  jobvite: 'input[type="file"][name="noFormReachableWithoutConsent"]',
  icims: 'input[type="file"][name="noFormReachableWithoutAccount"]',
  oraclecloud: 'input[type="file"][name="noFormReachableWithoutAuthCode"]',
  ultipro: 'input[type="file"][name="noFormCaptured"]',
};

export function coverLetterUploadSelector(portal: SupportedPortal): string {
  return COVER_LETTER_UPLOAD_SELECTORS[portal];
}

export function managedResultHasCoverLetterUpload(result: ManagedBrowserResult | null, portal: SupportedPortal): boolean {
  const selector = coverLetterUploadSelector(portal);
  return result?.extracted?.some((item) => (
    (item.label === 'cover_letter_capability' || item.selector === selector)
    && item.value?.trim().toLowerCase() === 'file'
  )) === true;
}

/* A required-field blocker that names the cover letter.
 *
 * The blocker sentences are built by describeRequiredBlocker (fieldLabel.ts) as
 * '"Cover Letter" is required and is still empty', and by sanitizeProviderBlockers from whatever a
 * provider hands back in the '<label> is required' shape. Both spellings are matched, and both are
 * anchored on the required wording rather than on the words "cover letter" alone: a Greenhouse form
 * whose page text says "Cover letter is optional" must not be read as requiring one, and neither
 * must an attention line that merely mentions the letter, such as "We could not write your cover
 * letter for this one, so it is not attached."
 */
const COVER_LETTER_REQUIRED_BLOCKER =
  /\bcover\s*letter\b[^\n]{0,60}?\bis\s+required\b|\bis\s+required\b[^\n]{0,60}?\bcover\s*letter\b/i;

/**
 * Did this run's own required-field scan say the employer requires a cover letter?
 *
 * The scan runs against a form whose cover-letter control is empty (buildPacket attaches a letter
 * only once it is approved, and an unapproved draft is never sent), so a required control is always
 * in a position to be reported. See ApplicationReviewState.cover_letter_required for why absence is
 * read as "optional" rather than as "unknown".
 */
export function blockersRequireCoverLetter(blockers: readonly string[] | undefined): boolean {
  return (blockers ?? []).some((blocker) => COVER_LETTER_REQUIRED_BLOCKER.test(blocker ?? ''));
}

/* ELEMENT IDENTITY, AND WHY THE SECOND DOCUMENT IS EXCLUDED BY IT RATHER THAN BY A NAME.
 *
 * On the direct Playwright path the run holds the live page, so it does not have to reason about how
 * a family spells its resume input: it can hold the node the resume actually went into and refuse to
 * hand that same node to anything else. That is what this ledger is. It compares DOM nodes through
 * the browser (`node === other`), so no naming convention, attribute, label text or document order
 * can defeat it, and it needs no update when a new ATS arrives.
 *
 * Two things go into it. uploadFirst claims the exact control it uploaded to, which is the precise
 * answer whenever an upload happened. reserveUploadControls claims the family's declared resume and
 * cover-letter controls whether or not an upload happened, which covers the run that carried no
 * resume or whose resume upload failed: the transcript must not be posted into the resume's slot
 * even when the resume never made it there, because the employer reads that slot as the resume.
 *
 * DEGRADATION, stated rather than hidden: identity needs elementHandles/evaluate. A page object that
 * does not offer them (a stub in a test, a future non-Playwright driver) yields no claims, and every
 * caller here then falls back to the attribute exclusions derived in transcriptUploadSelector. That
 * is weaker, and it is a fallback behind identity rather than the guard itself. */
type DocumentUploadLabel = 'resume' | 'cover_letter' | 'transcript';

const DOCUMENT_UPLOAD_WORDS: Record<DocumentUploadLabel, string> = {
  resume: 'resume',
  cover_letter: 'cover letter',
  transcript: 'transcript',
};

export type UploadClaimLedger = {
  /** The controls already spoken for, in the order they were claimed. */
  claimed: { label: DocumentUploadLabel; handle: ElementHandle }[];
  /** One sentence per document that had nowhere left to go. See uploadControlConflictBlocker. */
  conflicts: string[];
};

export function newUploadClaimLedger(): UploadClaimLedger {
  return { claimed: [], conflicts: [] };
}

/* THE SENTENCE FOR THE OUTCOME THIS WHOLE MECHANISM EXISTS TO CHOOSE INSTEAD.
 *
 * When the only control a second document can reach is one that already holds another, there are two
 * available behaviours and one of them is unacceptable. Replacing it sends the employer a transcript
 * where the resume should be, with no resume anywhere in the application, and the run reports both
 * documents attached because setInputFiles succeeded. Not uploading loses the transcript, which is
 * visible, recoverable and said out loud right here.
 *
 * Deliberately not phrased as "<field> is required": sanitizeProviderBlockers rewrites that shape
 * into its own required-field wording and this is not a required field, it is a collision. */
function uploadControlConflictBlocker(label: DocumentUploadLabel, holder: DocumentUploadLabel): string {
  const document = DOCUMENT_UPLOAD_WORDS[label];
  const held = DOCUMENT_UPLOAD_WORDS[holder];
  return `Litos did not attach your ${document}: the only upload control it could find for it on this `
    + `form is the one already holding your ${held}. Your ${held} was left in place rather than `
    + `replaced, so please add the ${document} yourself before sending.`;
}

/** Can this page object answer "same element?" at all. See the degradation note above. */
function pageSupportsElementIdentity(page: Page): boolean {
  const probe = page.locator('input') as unknown as { elementHandles?: unknown };
  return typeof probe.elementHandles === 'function';
}

/** Every element the selector resolves to, or null when this page object cannot answer by identity. */
async function locatorElementHandles(locator: Locator): Promise<ElementHandle[] | null> {
  const candidate = locator as unknown as { elementHandles?: () => Promise<ElementHandle[]> };
  if (typeof candidate.elementHandles !== 'function') return null;
  return await candidate.elementHandles().catch(() => null);
}

async function locatorElementHandle(locator: Locator): Promise<ElementHandle | null> {
  const candidate = locator as unknown as { elementHandle?: () => Promise<ElementHandle | null> };
  if (typeof candidate.elementHandle !== 'function') return null;
  return await candidate.elementHandle().catch(() => null);
}

/** Same DOM node, asked of the browser rather than inferred. A failed comparison is never a match. */
async function isSameElement(left: ElementHandle, right: ElementHandle): Promise<boolean> {
  return await left.evaluate((node, other) => node === other, right).catch(() => false) === true;
}

async function uploadClaimHolder(
  handle: ElementHandle,
  ledger: UploadClaimLedger,
): Promise<DocumentUploadLabel | null> {
  for (const claim of ledger.claimed) {
    if (await isSameElement(handle, claim.handle)) return claim.label;
  }
  return null;
}

/* Claim a family's declared controls without uploading to them.
 *
 * Only the element-identifying arms are reserved: a text-scoped arm names a region, and reserving
 * every file input inside a label that mentions "Resume" would delete a transcript control that
 * happens to share that label. The control a resume upload really used is claimed by uploadFirst
 * itself, by identity, so nothing precise is lost by leaving the region arms out here. */
async function reserveUploadControls(
  page: Page,
  selectors: string[],
  label: DocumentUploadLabel,
  ledger: UploadClaimLedger,
): Promise<void> {
  for (const selector of selectors) {
    const handles = await locatorElementHandles(page.locator(selector));
    if (!handles) continue;
    for (const handle of handles) {
      if (await uploadClaimHolder(handle, ledger)) continue;
      ledger.claimed.push({ label, handle });
    }
  }
}

async function documentUploadControlCount(page: Page, portal: SupportedPortal): Promise<number> {
  let total = 0;
  for (const selector of [resumeUploadSelector(portal), coverLetterUploadSelector(portal)]) {
    total += await page.locator(selector).count().catch(() => 0);
  }
  return total;
}

export async function hasCoverLetterUpload(page: Page, portal: SupportedPortal): Promise<boolean> {
  if ((await page.locator(coverLetterUploadSelector(portal)).count()) > 0) return true;
  const labelled = page.getByLabel(/cover\s*letter/i);
  for (let index = 0; index < await labelled.count(); index += 1) {
    if ((await labelled.nth(index).getAttribute('type'))?.toLowerCase() === 'file') return true;
  }
  return false;
}

/* THE TRANSCRIPT CONTROL, and the two facts that are true about it before any of this runs.
 *
 * FIRST: no portal in the corpus has ever been captured exposing one. Every other selector in this
 * file was read off a live form; these were not, and pretending otherwise would be the worse
 * mistake. A transcript field is never a platform control - it is an employer-configured extra
 * question, present on some postings of a family and absent on the next tenant - so no capture of
 * one form could answer for the family anyway. What IS knowable without a capture is the word the
 * employer will have used, which is why every arm below is anchored on "transcript" and none of them
 * is a positional or shape guess.
 *
 * SECOND, and this is the part that has to be right: a transcript selector must never reach the
 * resume or the cover-letter control. uploadFirst takes the first selector that matches and accepts,
 * setInputFiles REPLACES whatever the control was holding, and the resume upload runs first in every
 * family - so a transcript selector broad enough to match the resume input does not merely miss, it
 * overwrites her resume with her transcript on a form that is then submitted. GREENHOUSE_RESUME_
 * SELECTOR and ASHBY_RESUME_SELECTOR both carry input[type="file"][name*="resume" i], so the two
 * live one attribute apart. Requiring the literal token is most of the answer; the :not() arms cover
 * the label-scoped case, where a "Transcript" heading can sit above a block that also holds the
 * resume input and the label scope alone would not tell them apart.
 */
/* AND THE PART THAT WAS WRONG, WHICH IS THE SENTENCE DIRECTLY ABOVE THIS ONE.
 *
 * NOT_RESUME_OR_COVER_FILE below spells the words "resume" and "cover" and excludes any input whose
 * name or id contains them. Greenhouse and Ashby do carry name*="resume", so the guard was true of
 * the two families it was written against and read as though it were true of all of them. Seven do
 * not identify their resume input that way at all: Workable by data-ui, Rippling by data-testid,
 * Recruitee by candidate.cv, Teamtailor by an id-scoped wrapper, Personio by documents.cv, Pinpoint
 * by application_form[application][cv], Comeet by a bare cv. Against every one of those the guard
 * excluded nothing, the label-scoped arm reached the resume input, and setInputFiles replaced the
 * resume with the transcript on a form the run then reported as complete with both attached.
 *
 * So the exclusion is no longer a spelling. transcriptUploadSelector subtracts the family's OWN
 * resume and cover-letter selectors, the same strings its fill path uploads to, arm by arm. Nothing
 * here has to know how a family spells its resume input, and a family added later is covered by the
 * entry it must add to RESUME_UPLOAD_SELECTORS in order to upload a resume at all.
 *
 * NOT_RESUME_OR_COVER_FILE is kept behind that, not in front of it. It is the answer for a control
 * that belongs to no family selector at all, such as an employer-added second resume field on a
 * posting, and for the manual QA portals. It is a fallback, and it was never sufficient alone. */
const NOT_RESUME_OR_COVER_FILE =
  ':not([name*="resume" i]):not([id*="resume" i]):not([name*="cover" i]):not([id*="cover" i])';
const TRANSCRIPT_UPLOAD_ARMS = [
  'input[type="file"][name*="transcript" i]',
  'input[type="file"][id*="transcript" i]',
  'input[type="file"][aria-label*="transcript" i]',
  'label:has-text("Transcript") input[type="file"]',
] as const;
const TRANSCRIPT_UPLOAD_SELECTOR = TRANSCRIPT_UPLOAD_ARMS
  .map((arm) => `${arm}${NOT_RESUME_OR_COVER_FILE}`)
  .join(', ');

/* Which arms of a document selector name ONE ELEMENT, and are therefore safe to subtract.
 *
 * An arm carrying a text pseudo-class (`label:has-text("Resume") input[type="file"]`) names a
 * REGION, not a control: it matches every file input inside any label whose text mentions the word.
 * Subtracting that would delete the transcript control too on any form where one label covers a
 * documents section, which is the exact shape this selector exists to serve. So arms with a
 * parenthesised pseudo-class are left out of the exclusion, and the direct path's element-identity
 * reservation is what covers them - it compares nodes, so text scoping cannot mislead it.
 *
 * Everything else, including id-scoped and tag-scoped descendants such as Teamtailor's
 * `#upload_resume_field input[type="file"]` and SmartRecruiters' `spl-dropzone[...] input`, is
 * element-identifying and is subtracted. Complex arguments to :not() were measured against the real
 * engine before this shipped: Playwright resolves `:not(#upload_resume_field input[type="file"])`
 * exactly as the CSS spec says, and the arms it produces are still one comma-free string each, which
 * is what every caller that splits a selector on ', ' depends on. */
function elementIdentifyingSelectorArms(selector: string): string[] {
  return selector
    .split(', ')
    .map((arm) => arm.trim())
    .filter((arm) => arm.length > 0 && !arm.includes('('));
}

/* Memoised because transcriptUploadSelector is called per action built and per capability read, and
 * the answer is a pure function of two constant maps. Keyed by portal, not by family: the controlled
 * QA portals carry their own cover-letter selectors. */
const DERIVED_TRANSCRIPT_SELECTORS = new Map<SupportedPortal, string>();

function derivedTranscriptUploadSelector(portal: SupportedPortal): string {
  const cached = DERIVED_TRANSCRIPT_SELECTORS.get(portal);
  if (cached) return cached;
  const claimed = [
    ...elementIdentifyingSelectorArms(resumeUploadSelector(portal)),
    ...elementIdentifyingSelectorArms(coverLetterUploadSelector(portal)),
  ];
  const exclusions = [...new Set(claimed)].map((arm) => `:not(${arm})`).join('');
  const derived = TRANSCRIPT_UPLOAD_ARMS
    .map((arm) => `${arm}${NOT_RESUME_OR_COVER_FILE}${exclusions}`)
    .join(', ');
  DERIVED_TRANSCRIPT_SELECTORS.set(portal, derived);
  return derived;
}

/* The honest answer for a family where a transcript could not be attached even if the employer did
 * ask for one, and the rule that decides which families those are: a family gets a real selector
 * exactly when its fill path already pushes a document upload that is not the resume.
 *
 * That is a mechanical test rather than a judgement, and it lands where it should. The
 * account-walled families reach no form at all. SmartRecruiters and JazzHR stop after the exact
 * captured first-page controls and return. Breezy, BambooHR, Zoho Recruit and Bullhorn each had
 * exactly one file input on every form captured, and their adapters are deliberately locked to the
 * controls that were captured - Breezy's form also ships a honeypot that defeats a visibility check,
 * which is reason enough not to widen it on a guess. A never-matching selector keeps that answer in
 * one place instead of making every caller special-case the list. */
const NO_TRANSCRIPT_UPLOAD_SELECTOR = 'input[type="file"][name="noTranscriptControlCapturedOnThisPortal"]';

const TRANSCRIPT_UPLOAD_SELECTORS: Record<SupportedPortal, string> = {
  greenhouse: TRANSCRIPT_UPLOAD_SELECTOR,
  lever: TRANSCRIPT_UPLOAD_SELECTOR,
  ashby: TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_test: TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_lever: TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_ashby: TRANSCRIPT_UPLOAD_SELECTOR,
  workable: TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_workable: TRANSCRIPT_UPLOAD_SELECTOR,
  paylocity: TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_paylocity: TRANSCRIPT_UPLOAD_SELECTOR,
  rippling: TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_rippling: TRANSCRIPT_UPLOAD_SELECTOR,
  recruitee: TRANSCRIPT_UPLOAD_SELECTOR,
  manual_recruitee: TRANSCRIPT_UPLOAD_SELECTOR,
  teamtailor: TRANSCRIPT_UPLOAD_SELECTOR,
  personio: TRANSCRIPT_UPLOAD_SELECTOR,
  pinpoint: TRANSCRIPT_UPLOAD_SELECTOR,
  comeet: TRANSCRIPT_UPLOAD_SELECTOR,
  // SmartRecruiters' capability ends at the captured first page, before any employer question can
  // render, so there is nothing here to attach to even when the posting asks for a transcript later
  // in its wizard.
  smartrecruiters: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_smartrecruiters: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  jazzhr: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_jazzhr: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  breezy: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_breezy: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  bamboohr: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  controlled_bamboohr: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  zoho_recruit: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  bullhorn: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  sap_successfactors: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  oracle_taleo: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  adp_recruiting: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  avature: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  jobvite: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  icims: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  oraclecloud: NO_TRANSCRIPT_UPLOAD_SELECTOR,
  ultipro: NO_TRANSCRIPT_UPLOAD_SELECTOR,
};

export function transcriptUploadSelector(portal: SupportedPortal): string {
  const base = TRANSCRIPT_UPLOAD_SELECTORS[portal];
  // The sentinel families answer "no" and must keep answering it with the exact string
  // portalMayAttachTranscript compares against.
  if (base !== TRANSCRIPT_UPLOAD_SELECTOR) return base;
  return derivedTranscriptUploadSelector(portal);
}

/**
 * Whether this portal carries a real transcript selector rather than the never-match sentinel.
 *
 * Every caller that would spend an action, or claim a capability, asks this first. Spending one is
 * the smaller cost and it still matters - Greenhouse already measures at exactly MANAGED_ACTION_
 * LIMIT with a cover letter - but claiming one is the failure that has teeth: transcript_supported
 * is what the submit run re-derives its attach decision from, so a portal that says yes and cannot
 * attach produces an application recorded as carrying a document it never sent.
 */
export function portalMayAttachTranscript(portal: SupportedPortal): boolean {
  return TRANSCRIPT_UPLOAD_SELECTORS[portal] !== NO_TRANSCRIPT_UPLOAD_SELECTOR;
}

export function managedResultHasTranscriptUpload(result: ManagedBrowserResult | null, portal: SupportedPortal): boolean {
  if (!portalMayAttachTranscript(portal)) return false;
  const selector = transcriptUploadSelector(portal);
  return result?.extracted?.some((item) => (
    (item.label === 'transcript_capability' || item.selector === selector)
    && item.value?.trim().toLowerCase() === 'file'
  )) === true;
}

/**
 * Does this form have somewhere Litos can put a transcript?
 *
 * The sentinel check leads, and it is the one departure from hasCoverLetterUpload's shape. The
 * label fallback below would happily find a file input labelled "Transcript" on a family whose fill
 * path pushes no transcript upload at all, and the answer would then be recorded as
 * transcript_supported: true on a run that can never attach one. "The page has such a control" and
 * "this run can use it" are two different questions, and only the second one is worth writing down.
 *
 * THE SECOND DEPARTURE, and it is the one that made this function part of the same defect. The
 * label fallback below carried no exclusion at all, not even the spelled one the selector had. So on
 * a form where a single control is labelled in a way that mentions a transcript - the shared
 * "Attach your documents" block that produced this bug in the first place - the RESUME's own input
 * answered this question yes, transcript_supported was written as true, and the packet was then
 * built to carry a transcript precisely on the forms where the upload would land on the resume. The
 * capability read and the upload were failing in the same direction, which is why neither caught the
 * other. A labelled control that IS the resume or the cover letter is now excluded by identity. */
export async function hasTranscriptUpload(page: Page, portal: SupportedPortal): Promise<boolean> {
  if (!portalMayAttachTranscript(portal)) return false;
  if ((await page.locator(transcriptUploadSelector(portal)).count()) > 0) return true;
  const ledger = newUploadClaimLedger();
  await reserveUploadControls(page, elementIdentifyingSelectorArms(resumeUploadSelector(portal)), 'resume', ledger);
  await reserveUploadControls(
    page,
    elementIdentifyingSelectorArms(coverLetterUploadSelector(portal)),
    'cover_letter',
    ledger,
  );
  // Nothing on this page belongs to another document, so a labelled file input cannot be one and
  // the identity check has nothing to say. This is the ordinary case and it answers as it always did.
  const documentControls = await documentUploadControlCount(page, portal);
  const labelled = page.getByLabel(/transcript/i);
  for (let index = 0; index < await labelled.count(); index += 1) {
    const field = labelled.nth(index);
    if ((await field.getAttribute('type'))?.toLowerCase() !== 'file') continue;
    if (documentControls === 0) return true;
    const handle = await locatorElementHandle(field);
    // A document control is on the page and identity is unavailable, so this control cannot be
    // shown to be anything other than the resume. Claiming the capability here is what wrote a
    // transcript onto a packet that had nowhere to put it; not claiming it costs a transcript she
    // is told about.
    if (!handle) continue;
    if (await uploadClaimHolder(handle, ledger)) continue;
    return true;
  }
  return false;
}

function managedLabelInputSelector(text: string): string {
  const quoted = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    `label:has-text("${quoted}") input`,
    `label:has-text("${quoted}") textarea`,
    `label:has-text("${quoted}") select`,
  ].join(', ');
}

function managedLabelFileSelector(text: string): string {
  const quoted = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `label:has-text("${quoted}") input[type="file"]`;
}

function greenhouseCoreFieldEvidenceSelectors(label: 'first_name' | 'last_name' | 'email' | 'resume'): string[] {
  if (label === 'first_name') return [GREENHOUSE_FIRST_NAME_SELECTOR, managedLabelInputSelector('First Name')];
  if (label === 'last_name') return [GREENHOUSE_LAST_NAME_SELECTOR, managedLabelInputSelector('Last Name')];
  if (label === 'email') return [GREENHOUSE_EMAIL_SELECTOR, managedLabelInputSelector('Email')];
  return [
    GREENHOUSE_RESUME_SELECTOR,
    managedLabelFileSelector('Resume/CV'),
    managedLabelFileSelector('Resume'),
  ];
}

function pushManagedCoreFieldExtractActions(actions: ManagedBrowserAction[], portal: SupportedPortal) {
  if (portalFamily(portal) !== 'greenhouse') return;
  for (const label of ['first_name', 'last_name', 'email', 'resume'] as const) {
    for (const selector of greenhouseCoreFieldEvidenceSelectors(label)) {
      actions.push({
        type: 'extract',
        selector,
        attribute: 'value',
        label: `filled_field:${label}`,
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      });
    }
  }
}

export function managedResultFilledFields(result: ManagedBrowserResult): string[] {
  const fields = new Set(result.filledFields ?? []);
  const workablePhoneProof = (result.extracted ?? [])
    .filter((item) => item.label === 'filled_field:phone');
  const workableCountryProof = (result.extracted ?? [])
    .filter((item) => item.label === 'filled_field:phone_country');
  const workableResult = (() => {
    try {
      return new URL(result.url).hostname.toLowerCase() === 'apply.workable.com';
    } catch {
      return false;
    }
  })();
  if (workableResult || workablePhoneProof.length > 0 || workableCountryProof.length > 0) {
    // The provider's filledFields records that a command once succeeded. These extracts record what
    // the form still holds after uploads and autofill, so they replace rather than supplement it.
    fields.delete('phone');
    const assertionContract = result.capabilities?.includes(MANAGED_EXTRACT_ASSERTIONS_CAPABILITY) === true;
    const phoneEvidence = workablePhoneProof.length === 1 ? workablePhoneProof[0] : undefined;
    const expectedPhoneDigits = phoneEvidence?.expectedValueDigits;
    const phonePersisted = assertionContract
      && Boolean(expectedPhoneDigits)
      && digitsOnly(phoneEvidence?.value) === expectedPhoneDigits;
    const countryEvidence = workableCountryProof.length === 1 ? workableCountryProof[0] : undefined;
    const expectedCountryDigits = countryEvidence?.expectedValueDigits;
    const countryPersisted = workableCountryProof.length === 0
      || (Boolean(expectedCountryDigits)
        && digitsOnly(countryEvidence?.value) === expectedCountryDigits
        && countryEvidence?.value?.includes(`+${expectedCountryDigits}`));
    if (phonePersisted && countryPersisted) fields.add('phone');
  }
  for (const item of result.extracted ?? []) {
    if (!item.value?.trim()) continue;
    const labelled = item.label?.match(/^filled_field:(first_name|last_name|email|resume)$/)?.[1];
    if (labelled) {
      fields.add(labelled);
      continue;
    }
    for (const label of ['first_name', 'last_name', 'email', 'resume'] as const) {
      if (greenhouseCoreFieldEvidenceSelectors(label).includes(item.selector)) {
        fields.add(label);
        break;
      }
    }
  }
  return [...fields];
}

/* THE ANSWERS THE RUNNER TOLD US IT COULD NOT LAND, WHICH NOBODY WAS READING.
 *
 * `result.skipped` has always come back from the managed provider and this repo has never looked at
 * it: `skipped_reasons` is written as `[]` at routes/resume.ts and set nowhere else. Most of it is
 * noise - one line per optional selector that matched nothing, and a large Greenhouse packet fans
 * out well over a hundred of those - which is presumably why it was left alone.
 *
 * A minority of it is not noise at all. These are the lines where Litos HAD an answer, typed or
 * chose it, and the control did not keep it:
 *
 *   question:overall gpa: value did not persist after fill
 *   question_combo:0:0:which university...: no option matched "University of Southern California",
 *     left for you to choose
 *
 * That is the whole R-076 shape, reported by the one component that can see it, and thrown away.
 * Measured on the run of 2026-08-08: Point72's "What degree are you currently pursuing?" and both
 * Virtu runs' "Which university are you currently attending?" reached the applicant as a bare
 * '"..." is required and is still empty' with no explanation and nothing to act on, while the
 * runner had already said exactly what happened and why.
 *
 * The filter is the shape of the sentence, not a list of labels: every one of these suffixes is
 * emitted only after a value was actually produced for the control. A selector that matched
 * nothing ("nothing matched <selector>") stays filtered out, because it means the alternative was
 * not needed, not that an answer was lost.
 */
const MANAGED_ANSWER_LOSS_SUFFIX =
  /:\s*(?:no option matched\b|(?:choice )?value did not persist\b|left the answer already on the form\b|choice option not found\b)/i;

/**
 * The FIELD the action was for, when the action label carries no employer question.
 *
 * managedActionLabelQuestion strips a leading `^[a-z_]+` run, which is right for a label like
 * `question:overall gpa` and total for a label like `education_discipline_combo:0`: the whole
 * label IS that run, so it returns empty and the applicant is told "Litos could not leave an
 * answer on the form" with no indication of which one.
 *
 * Measured across the Greenhouse batch of 2026-08-18. Seven packets came back blocked and every
 * one of them led with that bare sentence; DV Trading e0a0eb84 was hiding TWO distinct failures
 * behind it, a non-persisting control and `no option matched "Computer Science"` on the discipline
 * combo. An unnamed blocker cannot be acted on by her and cannot be reproduced by an engineer.
 *
 * The internal name is not the employer's wording, and it is not offered as though it were: it is
 * reached only when there is no employer wording to show, and it is the same string the runner and
 * the logs already use, which is what makes a report actionable. Trailing scaffolding is removed
 * (`_combo`, `_combo_label`, `_field`, indices) and underscores become spaces, so
 * `education_discipline_combo:0` reads "education discipline".
 */
function managedActionLabelFieldName(label: string): string {
  const head = /^[a-z_]+/i.exec(label.trim())?.[0] ?? '';
  return head
    .replace(/_(?:combo_label|combo|field|input|select|value)$/i, '')
    .replace(/_+/g, ' ')
    .trim();
}

/** Strip the action-label scaffolding off the front, leaving the employer's own question. */
function managedActionLabelQuestion(label: string): string {
  return label
    .replace(/^[a-z_]+/i, '')
    .replace(/^(?::\d+)+/, '')
    .replace(/^:/, '')
    .trim();
}

/**
 * Does this skipped line EXPLAIN the loss of an answer, as opposed to merely mentioning a label?
 *
 * The distinction is the whole of R-122. `managedAnswerLossReasons` asks "is this worth showing
 * her", and `managedUnexplainedAnswerLabels` asks "did anyone account for this label at all". Those
 * are two different questions, and for three rounds one predicate answered both: a line reading
 * `question:expected graduation year: nothing matched <selector>` satisfied the second while
 * failing the first, so the diagnostic treated the label as accounted for, the sanitizer dropped
 * the line as alias-ladder noise, and the applicant was told the field was empty with no reason.
 */
function managedSkipExplainsLoss(entry: string): boolean {
  return MANAGED_ANSWER_LOSS_SUFFIX.test(entry);
}

export function managedAnswerLossReasons(result: Pick<ManagedBrowserResult, 'skipped'>): string[] {
  const out = new Set<string>();
  for (const entry of result.skipped ?? []) {
    const text = (entry ?? '').trim();
    const match = MANAGED_ANSWER_LOSS_SUFFIX.exec(text);
    if (!match || match.index === undefined) continue;
    // The provider keys these on the ACTION label ("question_combo:0:0:which university..."), which
    // is an internal name. The applicant is shown the employer's question and the runner's own
    // words about it, and nothing about how many selectors were tried.
    const label = text.slice(0, match.index);
    const question = managedActionLabelQuestion(label) || managedActionLabelFieldName(label);
    const detail = text.slice(match.index).replace(/^:\s*/, '').trim();
    out.add(question
      ? `Litos could not leave this answer on the form, so it is yours to finish: "${question.slice(0, 60)}" (${detail.slice(0, 120)})`
      : `Litos could not leave an answer on the form: ${detail.slice(0, 160)}`);
  }
  return [...out];
}

/**
 * THE FILLS THAT WERE SENT AND CAME BACK SAYING NOTHING AT ALL.
 *
 * A fill either lands, in which case its label appears in `result.filledFields`, or it does not, in
 * which case the runner says why and managedAnswerLossReasons turns that into a sentence. There is a
 * third outcome and until now it was invisible: the action is in the list the runner accepted, the
 * run demonstrably continued past it, and the result mentions it in neither place.
 *
 * Measured on DRW's Software Developer Intern packet, 2026-08-08. `question:legal first name` is a
 * single non-speculative fill of "Mehek" into `#question_67998823`, a plain visible textarea, at
 * index 55 of a 120-action list whose last provider-reported fill sits at index 100. The applicant
 * was told '"Legal First Name" is required and is still empty' and nothing else. Deepgram's
 * "Expected Graduation Year" came back the same way on the same run.
 *
 * This does not repair the fill. It ends the ambiguity: silence about a value Litos actually typed
 * is recorded as a defect in Litos rather than read as success. A speculative alias fill is excluded
 * because silence there is the normal case - the ladder tries several selectors expecting most to
 * match nothing - so only labels the caller names as single-attempt are considered.
 */
export type ManagedUnexplainedAnswer = {
  /** The action label, e.g. `question:expected graduation year`. */
  label: string;
  /** The employer's own question, with the action scaffolding stripped. */
  question: string;
  /**
   * The provider's own lines about this label that carried no explanation, kept verbatim.
   *
   * This is the RAW signal, and it is kept for exactly the labels that lost a value and for no
   * others. That bound is the point: `result.skipped` runs to well over a hundred lines on a large
   * Greenhouse packet, almost all of them one optional selector that matched nothing, and storing
   * the lot would bury the two lines that matter. Empty means the run said nothing at all about a
   * value Litos typed, which is the other half of the diagnosis and is worth distinguishing.
   */
  rawMentions: string[];
};

export function managedUnexplainedAnswers(
  actions: readonly ManagedBrowserAction[],
  result: Pick<ManagedBrowserResult, 'filledFields' | 'skipped'>,
): ManagedUnexplainedAnswer[] {
  const filled = new Set(result.filledFields ?? []);
  const skipped = (result.skipped ?? []).map((entry) => (entry ?? '').trim()).filter(Boolean);
  const out: ManagedUnexplainedAnswer[] = [];
  const seen = new Set<string>();
  for (const action of actions) {
    if (action.type !== 'fill' && action.type !== 'select') continue;
    const label = action.label;
    // `question:<label>` is the single durable-selector attempt discovery produced for one control.
    // Everything else with a value is an alias ladder, where a miss is expected and reported.
    if (!label || !label.startsWith('question:') || !action.value?.trim()) continue;
    if (filled.has(label) || seen.has(label)) continue;
    const mentions = skipped.filter((entry) => entry.startsWith(label));
    // Only an EXPLANATION discharges the label. A mention that explains nothing leaves the applicant
    // exactly where an absent mention would: a required field she is told is empty, with no account
    // of why. See managedSkipExplainsLoss.
    if (mentions.some(managedSkipExplainsLoss)) continue;
    seen.add(label);
    out.push({
      label,
      question: managedActionLabelQuestion(label),
      rawMentions: mentions.slice(0, 4).map((entry) => entry.slice(0, 300)),
    });
  }
  return out;
}

/** Names only, for the log line and for the tests that pin the old contract. */
export function managedUnreportedFillLabels(
  actions: readonly ManagedBrowserAction[],
  result: Pick<ManagedBrowserResult, 'filledFields' | 'skipped'>,
): string[] {
  return managedUnexplainedAnswers(actions, result).map((entry) => entry.label);
}

/**
 * What she is told about a value Litos typed that the form did not keep and the run did not explain.
 *
 * She already gets the employer's own '"X" is required and is still empty'. That sentence is true
 * and it is also the reason this defect survived three rounds: read on its own it says she left a
 * field blank. This says the opposite, which is what actually happened.
 */
export function managedUnexplainedAnswerReasons(
  unexplained: readonly ManagedUnexplainedAnswer[],
): string[] {
  return unexplained.map((entry) => (entry.question
    ? `Litos put an answer in this field and the form did not keep it, and the run gave no reason: "${entry.question.slice(0, 60)}". This is a Litos defect, not something you left blank.`
    : 'Litos put an answer in a field on this form and it did not keep it, and the run gave no reason. This is a Litos defect, not something you left blank.'));
}

// Fixed-field fills only (name/email/phone/location/links/resume) - shared by
// buildManagedPortalActions (the real fill+submit run) and buildManagedDiscoveryActions (a
// cheaper first pass that also asks the runner to scan the page for custom questions). Splitting
// this out is what let R-055's discovery step reuse every portal's already-verified selectors
// instead of a third copy of them.
function pushFixedFieldActions(
  actions: ManagedBrowserAction[],
  portal: SupportedPortal,
  packet: SubmissionPacket,
  options: { probeOptions?: boolean } = {},
) {
  const family = portalFamily(portal);
  // Nothing to fill, so nothing is pushed. Returning an EMPTY action list rather than attempting the
  // fills and letting them miss is deliberate: a run that fills nothing and says so is honest, while
  // a run that fires ten optional fills at a consent page produces a blocker card implying the form
  // was found and merely refused. It was never reached.
  if (ACCOUNT_WALLED_FAMILIES.has(family)) return;
  /* THE CONTROLLED PORTAL IS REACT, AND SSR IS NOT READINESS.
   *
   * Its contact fields and submit button exist in the server HTML before React attaches onSubmit.
   * A cold remote browser could therefore fill every input and pass atomic required-field
   * confirmation, then click an unhydrated native form. The browser performed a GET back to the
   * same fixture instead of entering the security-code phase, so the runner honestly observed the
   * old form, no challenge, and no receipt. Waiting longer after that click cannot repair it: the
   * event that changes phase was already missed.
   *
   * The fixture publishes this exact marker only after its effect has run and the handlers are
   * live. Required, not optional, because continuing without it would recreate the uncertain submit
   * D-020 exists to prevent. It is scoped to controlled_test, so no employer page learns a QA-only
   * contract and no production ATS action budget changes. */
  if (portal === 'controlled_test') {
    actions.push({
      type: 'waitForSelector',
      selector: 'form[data-litos-controlled-portal][data-litos-qa-ready="1"]',
      label: 'controlled_portal_hydrated',
      optional: false,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
  }
  if (family === 'greenhouse') {
    pushGreenhouseManagedPreflightActions(actions);
    // After the preflight, because on a JD page the application form (and every combobox on it)
    // only exists once "Apply for this job" has been clicked.
    if (options.probeOptions) pushManagedReactSelectOptionProbeActions(actions, portal);
    // The same warming, for the run that has no probe to do it. See the comment on the function.
    else pushGreenhouseEducationTaxonomyWarmActions(actions, portal, packet);
    const parts = packet.fullName.trim().split(/\s+/);
    // optional (managedFill default) + bounded, not required: a branded-redirect Greenhouse customer
    // (Jump Trading serves its posting through www.jumptrading.com with a different form DOM) has
    // none of these classic selectors, and a required fill there waited the full 30s and then
    // aborted the whole run. Optional means a missed core field degrades to a required-field blocker
    // card. The resume upload is optional + bounded for the same reason (managedUpload): the live
    // Jump Trading retry proved the run now clears name/email and stops at the resume file input.
    managedFill(actions, GREENHOUSE_FIRST_NAME_SELECTOR, parts[0], 'first_name');
    managedFill(actions, GREENHOUSE_LAST_NAME_SELECTOR, parts.slice(1).join(' '), 'last_name');
    managedFillByLabel(actions, 'Preferred First Name', parts[0], 'preferred_first_name');
    managedFillByLabel(actions, 'Preferred Last Name', parts.slice(1).join(' '), 'preferred_last_name');
    managedFill(actions, GREENHOUSE_EMAIL_SELECTOR, packet.email, 'email');
    managedComboboxFill(actions, '#country', countryForPhoneField(packet.phone, packet.country), 'phone_country');
    managedFill(actions, GREENHOUSE_PHONE_SELECTOR, phoneForPortalField(portal, packet.phone), 'phone');
    managedComboboxFill(actions, '#candidate-location, input[autocomplete="address-level2"]', greenhouseLocationSearch(packet), 'location');
    /* HER REVIEWED ANSWER LEADS HERE TOO, not only in the combobox ladder PR #583 fixed.
     *
     * These plain label fills are the SECOND emitter of the raw profile date. fillByLabelText
     * resolves by label substring, so "Expected Graduation Date" lands in the same control as an
     * employer label like "Please re-confirm your expected graduation date". Measured on the live
     * DV Trading run, packet e0a0eb84, 2026-08-18, AFTER #583 deployed: her reviewed
     * "January 2028 - July 2028" led the ladder, and this trio still typed the profile's
     * "May 2028" at the same react-select, whose band list refuses it, so the run reported
     * `no option matched "May 2028", left for you to choose` about a question she had answered.
     *
     * Same rule as the ladder: an applicant_review answer for the education-graduation-date family
     * replaces the derived value. One lookup covers all three labels because they share the family.
     * A packet with no applicant answer keeps typing packet.graduationDate, and machine-resolved
     * question records are invisible to packetApplicantAnswerForLabel, so nothing else moves. */
    const graduationDateLabelValue = packetApplicantAnswerForLabel(packet, 'Graduation Date')
      ?? packet.graduationDate;
    if (!packetLooksAkuna(packet)) {
      pushGreenhouseEducationComboboxActions(actions, packet);
      managedFillByLabelUnlessHandled(actions, packet, 'What is your graduation date?', graduationDateLabelValue, 'graduation_date');
      managedFillByLabelUnlessHandled(actions, packet, 'Graduation Date', graduationDateLabelValue, 'graduation_date_label');
      managedFillByLabelUnlessHandled(actions, packet, 'Expected Graduation Date', graduationDateLabelValue, 'graduation_date_expected');
    }
    if (packetLooksDatabricks(packet)) {
      managedFillByLabelUnlessHandled(actions, packet, 'What is your graduation date?', graduationDateLabelValue, 'databricks_graduation_date');
    }
    if (!packetLooksAkuna(packet)) {
      managedFillByLabelUnlessHandled(actions, packet, 'End date month', packet.graduationMonth, 'education_end_month');
      managedFillByLabelUnlessHandled(actions, packet, 'End date year', packet.graduationYear, 'education_end_year');
      managedFillByLabelUnlessHandled(actions, packet, 'Graduation Month', packet.graduationMonth, 'education_graduation_month');
      managedFillByLabelUnlessHandled(actions, packet, 'Graduation Year', packet.graduationYear, 'education_graduation_year');
      managedFillByLabelUnlessHandled(actions, packet, 'What is your expected graduation year?', packet.graduationYear, 'education_expected_graduation_year');
      // Same value the id-scoped fill uses, for the same reason: this lands in the SAME react-select
      // (fillByLabelText resolves the label's container to its one input), so handing it the stored
      // sentence leaves unmatched search text sitting in a control that was about to be filled
      // correctly.
      const disciplineValue = greenhouseReactSelectValue(packet, 'discipline--0', greenhouseDisciplineAliases(packet));
      if (!packetControlFailed(packet, 'discipline--0')
        && !managedSpeculativeLabelFillSuppressed(packet, 'Discipline', disciplineValue)) {
        managedFillByLabel(actions, 'Discipline', disciplineValue, 'education_discipline_label');
      }
    }
    pushGreenhouseFixedQuestionComboboxActions(actions, packet);
    if (!packetLooksAkuna(packet)) pushGreenhouseGraduationDateComboboxActions(actions, packet);
    if (!packetLooksAkuna(packet)) {
      managedFillByLabelUnlessHandled(actions, packet, 'GPA', packet.gpa, 'gpa');
      managedFillByLabelUnlessHandled(actions, packet, 'What is your GPA?', packet.gpa, 'gpa_question');
    }
    pushGreenhousePreferredLocationFallbackActions(actions, packet);
    for (const selector of greenhouseCoreFieldEvidenceSelectors('resume')) {
      managedUpload(actions, selector, 'resume', packet.resume, packet.resumeName);
    }
    managedUpload(actions, coverLetterUploadSelector(portal), 'cover_letter', packet.coverLetter, packet.coverLetterName);
  } else if (family === 'lever') {
    managedFill(actions, 'input[name="name"]', packet.fullName, 'name', false);
    managedFill(actions, 'input[name="email"]', packet.email, 'email', false);
    managedFill(actions, 'input[name="phone"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="urls[LinkedIn]"]', packet.linkedinUrl, 'linkedin');
    managedFill(actions, 'input[name="urls[GitHub]"]', packet.githubUrl, 'github');
    managedFill(actions, 'input[name="urls[Portfolio]"]', packet.portfolioUrl, 'portfolio');
    managedUpload(actions, LEVER_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, 'input[type="file"][name*="cover" i]', 'cover_letter', packet.coverLetter, packet.coverLetterName);
  } else if (family === 'smartrecruiters') {
    // See navigateToApplicationForm/SMARTRECRUITERS_APPLY_LINK_SELECTOR: the JD page and the
    // actual form are different URLs. The managed runner has no separate "navigate, then act"
    // step, so this click has to be the first action in the same sequence; optional and bounded
    // so it is a no-op when the runner already landed on the form URL directly.
    if (portal === 'smartrecruiters') {
      actions.push({
        type: 'click',
        selector: SMARTRECRUITERS_APPLY_LINK_SELECTOR,
        label: 'open application form',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      });
    }
    const parts = packet.fullName.trim().split(/\s+/);
    const controlled = portal === 'controlled_smartrecruiters';
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_FIRST_NAME_SELECTOR : SMARTRECRUITERS_FIRST_NAME_SELECTOR, parts[0], 'first_name');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_LAST_NAME_SELECTOR : SMARTRECRUITERS_LAST_NAME_SELECTOR, parts.slice(1).join(' '), 'last_name');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_EMAIL_SELECTOR : SMARTRECRUITERS_EMAIL_SELECTOR, packet.email, 'email');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR : SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR, packet.email, 'confirm_email');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_PHONE_SELECTOR : SMARTRECRUITERS_PHONE_SELECTOR, phoneForPortalField(portal, packet.phone), 'phone');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_LINKEDIN_SELECTOR : SMARTRECRUITERS_LINKEDIN_SELECTOR, packet.linkedinUrl, 'linkedin');
    managedFill(actions, controlled ? CONTROLLED_SMARTRECRUITERS_WEBSITE_SELECTOR : SMARTRECRUITERS_WEBSITE_SELECTOR, packet.portfolioUrl ?? packet.githubUrl, 'portfolio');
    managedUpload(actions, SMARTRECRUITERS_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
  } else if (family === 'workable') {
    pushWorkableManagedPreflightActions(actions);
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="firstname"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="lastname"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="email"]', packet.email, 'email');
    managedFill(actions, WORKABLE_LOCATION_SELECTOR, packet.city, 'location');
    if (packet.city) {
      actions.push({
        type: 'press',
        selector: WORKABLE_LOCATION_SELECTOR,
        value: 'Enter',
        label: 'location_select',
        optional: true,
        timeout: MANAGED_FILL_TIMEOUT_MS,
      });
    }
    // Workable has no dedicated LinkedIn/GitHub field on the built-in form - those arrive as custom
    // QA_<numeric> questions when an employer adds them, and so are handled by the reviewed-question
    // path, not here. `headline` is the one free identity field, and it is left alone deliberately:
    // it is candidate-authored positioning, not a fact from the profile, so guessing it would put
    // words in the student's mouth on a real application.
    managedUpload(actions, WORKABLE_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, WORKABLE_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // NOT filled: input[name="gdpr"]. It is a consent checkbox, and the standing rule below about
    // never ticking a consent control on the student's behalf applies with full force here.
  } else if (family === 'jazzhr') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="resumator-firstname-value"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="resumator-lastname-value"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="resumator-email-value"]', packet.email, 'email');
    managedFill(actions, 'input[name="resumator-phone-value"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="resumator-city-value"]', packet.city, 'location');
    managedFill(actions, 'input[name="resumator-linkedin-value"]', packet.linkedinUrl, 'linkedin');
    managedUpload(actions, JAZZHR_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    // NOT filled: resumator-eeo_gender-value / resumator-eeo_race-value. Voluntary EEO
    // self-identification belongs to the student alone and is never inferred or auto-answered.
  } else if (family === 'paylocity') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, paylocityId('info.firstName'), parts[0], 'first_name');
    managedFill(actions, paylocityId('info.lastName'), parts.slice(1).join(' '), 'last_name');
    managedFill(actions, paylocityId('info.email'), packet.email, 'email');
    managedFill(actions, paylocityId('info.cellPhone'), packet.phone, 'phone');
    managedFill(actions, paylocityId('info.linkedIn'), packet.linkedinUrl, 'linkedin');
    managedFill(actions, '#public-site-address-city', packet.city, 'location');
    managedUpload(actions, PAYLOCITY_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, PAYLOCITY_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // Work history and education live on step ONE and were previously skipped entirely, which is
    // why a Paylocity run used to hand back a page that looked half-done. Confirmed live: all seven
    // workHistory.* controls and educationHistory.certificationsAndAwards render visible on step 1.
    // Only the first row (index .0) is filled - Paylocity adds further rows through an "Add Work
    // History" button, and clicking to create rows we may not be able to complete would leave the
    // form in a worse state than one clean entry the student can extend herself.
    if (packet.mostRecentRole) {
      managedFill(actions, paylocityId('workHistory.companyName.0'), packet.mostRecentRole.company, 'work_company');
      managedFill(actions, paylocityId('workHistory.position.0'), packet.mostRecentRole.title, 'work_title');
      managedFill(actions, paylocityId('workHistory.responsibilities.0'), packet.mostRecentRole.summary, 'work_summary');
      managedFill(actions, '#txt-workHistory-startDate-0', packet.mostRecentRole.startDate, 'work_start');
      managedFill(actions, '#txt-workHistory-endDate-0', packet.mostRecentRole.endDate, 'work_end');
    }
    // NOT touched: #useAttachedResumeToFillOutApplication. Paylocity offers to parse the uploaded
    // resume back into the form, which would race our own fills and overwrite them with whatever its
    // parser inferred. Leaving it unchecked keeps the profile the single source of truth.
    // Also not filled: the required address-1/county/state/zip block. The packet carries only `city`,
    // so those surface as required-field blockers for the human rather than being invented here.
  } else if (family === 'rippling') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, '[data-testid="input-first_name"]', parts[0], 'first_name');
    managedFill(actions, '[data-testid="input-last_name"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, '[data-testid="input-email"]', packet.email, 'email');
    managedFill(actions, '[data-testid="input-phone_number"]', phoneForPortalField(portal, packet.phone), 'phone');
    managedUpload(actions, RIPPLING_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, RIPPLING_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // input-current_company is left alone on purpose. The packet's mostRecentRole may be a past role
    // rather than a current one, and stating a current employer the student does not have is a
    // factual claim in her name on a real application. It surfaces as a blocker if required.
    // Location is a places-autocomplete backed by a hidden input-externalPlaceId; typing text into it
    // without selecting a suggestion leaves the hidden id empty, which is worse than leaving it.
  } else if (family === 'breezy') {
    // ONE full-name field, not a first/last pair. See BREEZY_RESUME_SELECTOR.
    managedFill(actions, 'input[name="cName"]', packet.fullName, 'name');
    managedFill(actions, 'input[name="cEmail"]', packet.email, 'email');
    managedFill(actions, 'input[name="cPhoneNumber"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="cAddress"]', packet.city, 'location');
    managedUpload(actions, BREEZY_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    // textarea[name="cSummary"] is left alone: it is candidate-authored positioning, the same
    // judgement already made for Workable's `headline`.
    // gdprAgreement is never filled HERE: on a submit run whose packet licenses it, the guarded
    // consent-tick block immediately before the submit action ticks it (managedConsentTickPlan),
    // and on every other run it stays with the applicant. smsConsent stays with the applicant
    // unconditionally.
  } else if (family === 'bamboohr') {
    // The form does not exist until this button is clicked, so this must be the FIRST action, the
    // same shape as the SmartRecruiters apply link. Optional and bounded, so a page that already
    // shows the form (or a tenant that routes differently) is a no-op rather than a failure.
    actions.push({
      type: 'click',
      selector: BAMBOOHR_OPEN_FORM_SELECTOR,
      label: 'open application form',
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="firstName"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="lastName"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="email"]', packet.email, 'email');
    managedFill(actions, 'input[name="phone"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="city.value"]', packet.city, 'location');
    managedFill(actions, 'input[name="linkedinUrl"]', packet.linkedinUrl, 'linkedin');
    managedFill(actions, 'input[name="websiteUrl"]', packet.portfolioUrl ?? packet.githubUrl, 'portfolio');
    managedUpload(actions, BAMBOOHR_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    // NOT filled: state.value / countryId.value (selects, and the packet has no state), the required
    // streetAddress.value and zip.value (the packet carries only city, so inventing them is out),
    // desiredPay (R-031 governs salary and is currency-gated, handled by the reviewed-question path),
    // and educationLevelId. All surface as required-field blockers for the human.
  } else if (family === 'recruitee') {
    managedFill(actions, 'input[name="candidate.name"]', packet.fullName, 'name');
    managedFill(actions, 'input[name="candidate.email"]', packet.email, 'email');
    managedFill(actions, 'input[name="candidate.phone"]', packet.phone, 'phone');
    managedUpload(actions, RECRUITEE_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, RECRUITEE_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // Tenant agreements, SMS consent, and CAPTCHA controls are never mapped.
  } else if (family === 'teamtailor') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="candidate[first_name]"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="candidate[last_name]"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="candidate[email]"]', packet.email, 'email');
    managedFill(actions, 'input[name="candidate[phone]"]', packet.phone, 'phone');
    managedUpload(actions, TEAMTAILOR_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, TEAMTAILOR_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // candidate[consent_given] is never filled HERE: on a submit run holding the standing
    // consent-acceptance permission it is ticked by the guarded consent-tick block immediately
    // before the submit action (managedConsentTickPlan), and on every other run it stays with the
    // applicant. candidate[consent_given_future_jobs] is the talent-pool retention opt-in and stays
    // with the applicant unconditionally.
  } else if (family === 'personio') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="first_name"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="last_name"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="email"]', packet.email, 'email');
    managedFill(actions, 'input[name="phone"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="location"]', packet.city, 'location');
    managedFill(actions, 'input[name="public_profile"]', packet.linkedinUrl ?? packet.portfolioUrl, 'public_profile');
    managedUpload(actions, PERSONIO_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, PERSONIO_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // Do not touch salary_expectations, available_from, or custom_attribute_* fields. Their labels
    // and answer semantics are tenant-defined and the discovery/review path owns them.
  } else if (family === 'pinpoint') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="application_form[application][first_name]"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="application_form[application][last_name]"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="application_form[application][email]"]', packet.email, 'email');
    managedFill(actions, 'input[name="application_form[application][phone]"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="application_form[application][town]"]', packet.city, 'location');
    managedFill(actions, 'input[name="application_form[application][linkedin_url]"][type="text"]', packet.linkedinUrl, 'linkedin');
    managedUpload(actions, PINPOINT_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, PINPOINT_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // application[process_information] is the required privacy-processing consent. It is never
    // checked here, even when a reviewed question happens to contain affirmative wording. On a
    // submit run holding the standing consent-acceptance permission it is ticked by the guarded
    // consent-tick block immediately before the submit action (managedConsentTickPlan).
  } else if (family === 'comeet') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="firstName"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="lastName"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="email"]', packet.email, 'email');
    managedFill(actions, 'input[name="phone"]', packet.phone, 'phone');
    managedFill(actions, 'input[name="websiteUrl"]', packet.portfolioUrl ?? packet.linkedinUrl ?? packet.githubUrl, 'portfolio');
    managedUpload(actions, COMEET_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, COMEET_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
    // The phone-country combobox, personal note, and tenant questions stay in the generic reviewed
    // question path. Both captured tenants render g-recaptcha-response, so submit stays gated.
  } else if (family === 'zoho_recruit') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[name="First_Name"], input[name="firstName"]', parts[0], 'first_name');
    managedFill(actions, 'input[name="Last_Name"], input[name="lastName"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[name="Email"], input[name="email"]', packet.email, 'email');
    managedFill(actions, 'input[name="Phone"], input[name="phone"]', packet.phone, 'phone');
    managedUpload(actions, ZOHO_RECRUIT_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    // Candidate consent, retention, EEO, attestations and CAPTCHA are tenant-configurable and stay
    // untouched even when they look like ordinary required controls.
  } else if (family === 'bullhorn') {
    const parts = packet.fullName.trim().split(/\s+/);
    managedFill(actions, 'input[formcontrolname="firstName"], input[name="firstName"]', parts[0], 'first_name');
    managedFill(actions, 'input[formcontrolname="lastName"], input[name="lastName"]', parts.slice(1).join(' '), 'last_name');
    managedFill(actions, 'input[formcontrolname="email"], input[name="email"]', packet.email, 'email');
    managedFill(actions, 'input[formcontrolname="phone"], input[name="phone"]', packet.phone, 'phone');
    managedUpload(actions, BULLHORN_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    // OSCP may be changed by each employer. Never map a custom control from one tenant onto another.
  } else if (family === 'sap_successfactors') {
    // The public job page transitions into an account wall. No identity or credential is entered.
  } else {
    const parts = packet.fullName.trim().split(/\s+/);
    const firstName = parts[0] ?? '';
    const lastName = parts.slice(1).join(' ');
    managedFill(actions, 'input[name="_systemfield_name"]', packet.fullName, 'name', false);
    pushScopedQuestionChoiceActions(actions, 'First Name', firstName, 'ashby_first_name', { includeSelectFallbacks: false });
    pushScopedQuestionChoiceActions(actions, 'Last Name / Surname', lastName, 'ashby_last_name', { includeSelectFallbacks: false });
    managedFill(actions, 'input[name="_systemfield_email"]', packet.email, 'email', false);
    managedFill(actions, ASHBY_PHONE_SELECTOR, phoneForPortalField(portal, packet.phone), 'phone');
    managedFill(actions, ASHBY_LOCATION_SELECTOR, packet.city, 'location');
    // LinkedIn/GitHub/portfolio, previously missing entirely from this branch: the packet carries
    // them (confirmed live on a real account via GET /profile/application) and the Lever branch
    // fills its equivalents, but Ashby was silently dropping them, surfacing as a "'LinkedIn
    // Profile' is required and is still empty" blocker on a real run. Ashby does not expose these
    // as `_systemfield_*` names the way name/email/phone/location are, and custom fields carry
    // opaque UUID `name`s, so match by a case-insensitive substring across name/aria-label/
    // placeholder rather than one guessed exact name. Optional (default) and only pushed when the
    // value exists, so a form without the field is a no-op rather than a blocker.
    managedFill(actions, ASHBY_LINKEDIN_SELECTOR, packet.linkedinUrl, 'linkedin');
    managedFill(actions, ASHBY_GITHUB_SELECTOR, packet.githubUrl, 'github');
    managedFill(actions, ASHBY_PORTFOLIO_SELECTOR, packet.portfolioUrl, 'portfolio');
    managedUpload(actions, ASHBY_RESUME_SELECTOR, 'resume', packet.resume, packet.resumeName);
    managedUpload(actions, ASHBY_COVER_LETTER_SELECTOR, 'cover_letter', packet.coverLetter, packet.coverLetterName);
  }
  /* THE TRANSCRIPT GOES LAST, AND IT IS OUTSIDE THE FAMILY CHAIN FOR THAT REASON.
   *
   * Written once here rather than repeated in eleven branches, because "after the resume and the
   * cover letter, in every family" is the whole property and a per-branch copy is one branch away
   * from losing it. The resume selectors are the broad ones (GREENHOUSE_RESUME_SELECTOR and
   * ASHBY_RESUME_SELECTOR both carry name*="resume"), the runner takes the first selector that
   * matches, and setInputFiles replaces rather than adds - so an upload ordered before the resume
   * can end up holding the resume's slot.
   *
   * It is also after the account-walled return at the top of this function, deliberately. Those
   * families reach no form, and an upload placed before that return would be an action fired at a
   * login or consent gate. They get no transcript, and that is the correct answer rather than a gap.
   *
   * Zero cost when there is nothing to attach: managedUpload returns before pushing unless both the
   * file and the name are set, and portalMayAttachTranscript keeps the action off the families whose
   * selector cannot match anything. Greenhouse measures at exactly MANAGED_ACTION_LIMIT with a cover
   * letter, so an action spent on a control that provably does not exist is not free there. */
  if (portalMayAttachTranscript(portal)) {
    const before = actions.length;
    managedUpload(actions, transcriptUploadSelector(portal), 'transcript', packet.transcript, packet.transcriptName);
    if (actions.length > before) pushResumeUploadVerifyAction(actions, portal);
  }
}

/* READ THE RESUME'S CONTROL BACK, AFTER THE LAST THING THAT COULD HAVE TAKEN IT.
 *
 * The managed runner is a remote process handed a list of selectors, so nothing on this side can
 * compare DOM nodes the way the direct path's ledger does. transcriptUploadSelector subtracts the
 * family's own resume and cover-letter selectors from every arm, which is the structural half of the
 * answer, and this is the measurement that says whether it held on the form actually in front of the
 * run. A file input reads its value back as `C:\fakepath\<name>`, so a resume slot that comes back
 * holding the transcript's file name is a displaced resume, stated by the form itself.
 *
 * Pushed only when a transcript upload was actually pushed, which is the only ordering that can
 * displace anything and keeps the read off every run that carries no transcript. Greenhouse lives
 * against MANAGED_ACTION_LIMIT and one action is not free there.
 *
 * What it does NOT prove: that the employer's uploader kept the file. A control that resets its own
 * value after reading it comes back empty, and empty is not read as displacement here for exactly
 * that reason. This catches the specific, silent, worst case: the slot now holds a different
 * document of ours. */
function pushResumeUploadVerifyAction(actions: ManagedBrowserAction[], portal: SupportedPortal) {
  actions.push({
    type: 'extract',
    selector: resumeUploadSelector(portal),
    attribute: 'value',
    label: RESUME_UPLOAD_VERIFY_LABEL,
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
}

// A cheap first pass: fill the fixed fields (idempotent - the real run below fills them again,
// including the resume upload) and ask the runner to scan the resulting page for custom questions
// via the 'discover' action (stratus-browser-cloud PR #7). No reviewed questions, no submit - this
// call exists only to get `result.discovered` back so the caller can resolve answers in Node
// (questionDiscovery.ts) before the real fill run. Direct-Playwright provider skips this call
// entirely (discoverPageQuestions runs against its own live Page instead); this is the managed
// path's only way to see the live DOM mid-run, since /api/run is otherwise stateless.
export function buildManagedDiscoveryActions(portal: SupportedPortal, packet: SubmissionPacket): ManagedBrowserAction[] {
  const actions: ManagedBrowserAction[] = [];
  // probeOptions: read every closed list's real options BEFORE anything is typed. A react-select
  // that has already been filled shows a FILTERED menu, so probing after the fills would read back
  // whatever the search text left standing instead of the employer's actual list, which is the one
  // thing this read exists to get. Discovery only: the fill run consumes the result, it does not
  // need to take the reads again.
  pushFixedFieldActions(actions, portal, packet, { probeOptions: true });
  if (portalFamily(portal) === 'workable') pushWorkableManagedPhoneActions(actions, packet.phone);
  pushManagedCoreFieldExtractActions(actions, portal);
  actions.push({ type: 'discover', optional: true, timeout: MANAGED_FILL_TIMEOUT_MS });
  // Round two, after `discover` has walked the whole DOM: the controls whose option lists load over
  // the network read back "Loading..." on the first open and their real list on the second.
  pushManagedReactSelectOptionProbeActions(actions, portal, 2);
  actions.push({
    type: 'extract',
    selector: coverLetterUploadSelector(portal),
    attribute: 'type',
    label: 'cover_letter_capability',
    optional: true,
    timeout: MANAGED_FILL_TIMEOUT_MS,
  });
  /* The same read for the transcript, and it is pushed ONLY where the answer can be anything other
   * than no. On the sentinel families the selector cannot match, so the extract would spend one of
   * the runner's 120 actions to learn a fact this repo already knows - and this is the builder that
   * went from 120 to 145 once and had every managed Greenhouse discovery call answered with HTTP 400
   * TOO_MANY_ACTIONS before a browser opened. managedResultHasTranscriptUpload returns false for
   * those families without needing the read. */
  if (portalMayAttachTranscript(portal)) {
    actions.push({
      type: 'extract',
      selector: transcriptUploadSelector(portal),
      attribute: 'type',
      label: 'transcript_capability',
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
  }
  /* THE BUDGET, and its absence here is what made R-096 invisible on every real run.
   *
   * buildManagedPortalActions has trimmed itself to MANAGED_ACTION_LIMIT since Greenhouse first
   * needed it. This builder never did, and for a while it did not have to: measured on a Greenhouse
   * packet the list came to exactly 120 actions, one under the runner's `> 120` rejection. Adding
   * the option probes (two rounds of open/read/close over four controls, plus the round-one pass
   * inside pushFixedFieldActions) took it to 145. Every managed Greenhouse discovery call has since
   * been answered with HTTP 400 TOO_MANY_ACTIONS before a browser ever opened, so `discovered` was
   * always empty, so discoverAndResolveQuestions was always handed nothing to resolve. DRW's
   * Software Developer Intern packet is the measured case: 27 required fields, 0 question records.
   *
   * Trim the fills, never the reads. The low-priority groups dropped here are speculative alias
   * fills that buildManagedPortalActions attempts again a moment later against its own budget, so
   * losing them costs this pass nothing; isProtectedManagedAction keeps `discover`, the option
   * reads, the core-field extracts and the form preflight out of both trims' reach. */
  trimGreenhouseManagedActionsToBudget(actions, MANAGED_ACTION_LIMIT);
  trimSpeculativeManagedActionsToBudget(actions, MANAGED_ACTION_LIMIT);
  if (actions.length > MANAGED_ACTION_LIMIT) truncateManagedActionsToBudget(actions, MANAGED_ACTION_LIMIT);
  return actions;
}

/**
 * THE PRE-SCRIPT SCAN: read an employer's form without touching it.
 *
 * buildManagedDiscoveryActions above is a discovery pass that happens to be part of a submission:
 * it fills the fixed fields first (name, email, phone, links, and the resume UPLOAD) because the
 * run it belongs to is going to fill them anyway a moment later, so doing it early is free.
 *
 * This one is not part of a submission. It runs when Litos wants to know what a posting asks, which
 * can be before the applicant has decided to apply to it at all, and typing her name and uploading
 * her resume into an employer's form at that point would be doing something on her behalf that she
 * has not asked for. Some ATSes save a partial application from exactly that.
 *
 * So: no fills, no upload, no submit, and no screenshot either (runManagedBrowser renders a
 * full-page PNG by default and nothing here would look at it). What is left is the two things the
 * scan exists for - the DOM walk, and the option probes around it, which are the reason a closed
 * list comes back with its real choices instead of a guess. Roughly 25 actions on Greenhouse and
 * one everywhere else, against buildManagedDiscoveryActions' 120-action budget.
 */
export function buildManagedPrescriptActions(portal: SupportedPortal): ManagedBrowserAction[] {
  const actions: ManagedBrowserAction[] = [];
  // Round one warms the async option fetches; see pushManagedReactSelectOptionProbeActions for why
  // the read that matters is round two, after `discover` has walked the DOM.
  pushManagedReactSelectOptionProbeActions(actions, portal, 1);
  actions.push({ type: 'discover', optional: true, timeout: MANAGED_FILL_TIMEOUT_MS });
  pushManagedReactSelectOptionProbeActions(actions, portal, 2);
  if (actions.length > MANAGED_ACTION_LIMIT) truncateManagedActionsToBudget(actions, MANAGED_ACTION_LIMIT);
  return actions;
}

export function buildManagedPortalActions(
  portal: SupportedPortal,
  packet: SubmissionPacket,
  submit = false,
): ManagedBrowserAction[] {
  const family = portalFamily(portal);
  // A packet is untrusted input at this boundary. Account-walled portals have no application form,
  // so even a reviewed question carrying a malicious selector must not create an action against the
  // login, CAPTCHA, or privacy gate that happens to be on screen.
  if (ACCOUNT_WALLED_FAMILIES.has(family)) return [];
  const actions: ManagedBrowserAction[] = [];
  let workablePhoneReadyForSubmit = true;
  /* The one consent control this run may tick, or null for "park at the handoff exactly as today".
   * Computed only for a submit run: a prepare or fill run never ticks a consent, because the tick
   * exists solely to clear the way for the submit press that follows it in the same action list. */
  const consentTick = submit ? managedConsentTickPlan(portal, packet) : null;
  pushFixedFieldActions(actions, portal, packet);
  // These three integrations are structurally fixed-field-only. SuccessFactors has no reachable
  // form at all, while Zoho Recruit and Bullhorn have only the exact identity and resume controls
  // mapped above. A stale or malicious reviewed-question packet must never widen that surface.
  if (family === 'sap_successfactors') return actions;
  // SmartRecruiters capability also ends after the exact captured first-page controls. Returning
  // here is stronger than filtering legal-looking questions: no packet selector or input type can
  // widen the adapter into later tenant-specific steps.
  if (family === 'smartrecruiters' || family === 'jazzhr' || family === 'bamboohr') return actions;
  const mayReplayReviewedQuestions = family !== 'zoho_recruit' && family !== 'bullhorn';
  if (family === 'greenhouse') {
    pushGreenhouseAkunaSafeTextActions(actions, packet);
    pushGreenhouseKnownQuestionAliases(actions, packet, 'akunaRequired');
  }
  // Reviewed questions include stored attestations and EEO decline-style answers when present.
  // The managed runner scopes every choice match to this question's container and verifies text
  // values after filling, so a missing or unaccepted value returns as a blocker instead of being
  // reported as completed.
  for (const item of canFillReviewedQuestions('managed') && mayReplayReviewedQuestions ? packet.questions : []) {
    if (packetQuestionFailed(packet, item)) continue;
    const answer = greenhouseReviewedQuestionAnswer(item, packet);
    if (!answer.trim()) continue;
    // Whether that answer is the resolver's own, and therefore already snapped against this
    // control's real option texts. It decides whether a computed bucket leads or follows it.
    const answerIsResolved = greenhouseReviewedAnswerIsResolved(item, packet);
    const questionText = normalizeReviewQuestionLabel(item.question);
    if (!questionText) continue;
    if (shouldSkipReviewedConsentQuestion(questionText)) continue;
    if (shouldSkipPortalConsentQuestion(portalFamily(portal), reviewedQuestionSafetyContext(item, packet))) continue;
    /* The consent control the tick plan owns is filled by the tick plan ALONE. The runner's scoped
     * choice handling uses check(), which is idempotent, but the tick is a click, which toggles -
     * so a reviewed-question fill here followed by the tick would check the box and then uncheck
     * it, submitting a consent recorded as accepted and physically absent. One control, one path. */
    if (consentTick
      && selectorControlName(durablePortalSelector(reviewQuestionPortalSelector(item)))
        === selectorControlName(consentTick.selector)) continue;
    const rawPortalSelector = reviewQuestionPortalSelector(item);
    const portalInputType = reviewQuestionPortalInputType(item);
    const portalSelector = durablePortalSelector(rawPortalSelector);
    const measuredClosedOption = Boolean(item.answerOptionSource?.trim())
      && /^(?:text|combobox)?$/i.test(portalInputType ?? '');
    /* Never replay a data-litos-discovered selector in this managed fill. The discovery pass and
     * the fill pass are separate stateless Stratus runs. Those attributes exist only on the page
     * where discovery assigned them, so preserving one here protects a chain that cannot match and
     * lets the budget trim remove the label-scoped chain that can. Gender and race on IMC were the
     * measured result: both answers existed, both temporary selectors were protected, and both
     * live controls stayed empty. Falling through to the label-scoped Greenhouse path below is the
     * durable replay for these runtime selects. */
    if (portalSelector) {
      if (portalFamily(portal) === 'greenhouse'
        && (/^combobox$/i.test(portalInputType ?? '') || measuredClosedOption)) {
        pushGreenhouseQuestionComboboxActions(
          actions,
          portalSelector,
          questionText,
          answer,
          'question',
          packet.jdText,
          packet.referralSourceEvidence,
          answerIsResolved,
          true,
        );
        pushGreenhouseCheckboxOptionActions(actions, questionText, answer, 'question');
        continue;
      }
      if (/^(?:checkbox|radio)$/i.test(portalInputType ?? '')) {
        if (portalFamily(portal) === 'greenhouse') {
          const offered = /^checkbox$/i.test(portalInputType ?? '')
            ? packetReadOptionsForQuestion(packet, item)
            : undefined;
          const values = offered ? exactChoiceOptionValues(answer, offered) : null;
          if (offered) {
            // One exact scoped action per reviewed value. The managed runner uses check(), not a
            // toggle, so a later language or experience-setting option preserves the earlier ones.
            // When the live list cannot prove one decomposition, emit nothing rather than guess
            // whether a comma belongs inside one option or separates several options.
            if (!values) continue;
            for (const value of values) {
              pushScopedQuestionChoiceActions(
                actions,
                questionText,
                value,
                'question',
                { includeSelectFallbacks: false },
              );
            }
          } else {
            // The discovered selector leads the same single click as the shape alternatives rather
            // than being a click of its own. Two clicks on one checkbox untick it; see
            // pushGreenhouseCheckboxOptionActions.
            pushGreenhouseCheckboxOptionActions(actions, questionText, answer, 'question', [portalSelector]);
          }
        } else if (portalFamily(portal) === 'workable') {
          const offered = packetReadOptionsForQuestion(packet, item);
          const values = offered ? exactChoiceOptionValues(answer, offered) : [answer];
          if (!values || (/^radio$/i.test(portalInputType ?? '') && values.length !== 1)) continue;
          for (const value of values) {
            pushScopedQuestionChoiceActions(
              actions,
              questionText,
              value,
              'question',
              { includeSelectFallbacks: false },
            );
          }
        } else {
          /* A choice question on a non-Greenhouse board used to fall out of this branch having
           * pushed NOTHING, and that was invisible for as long as no choice question could get here:
           * portalSelectorForField withheld a selector for every shape except text, so this arm was
           * unreachable. Discovery now reports a DURABLE selector for choice controls too, so the
           * arm has to exist or a question that has just become fillable would silently stop being
           * attempted at all.
           *
           * fillByLabelText, not a click on the selector. A durable selector on Ashby's yes/no
           * resolves to the display:none mirror input, and clicking that neither drives React nor
           * says which of Yes and No was meant; the runner's scoped choice handling reads the
           * question's own container and presses the matching option pill, which is the only thing
           * that works there. One action, and the same one the no-selector path below would spend.
           */
          pushScopedQuestionChoiceActions(actions, questionText, answer, 'question', { includeSelectFallbacks: false });
        }
        continue;
      }
      managedFill(actions, portalSelector, answer, `question:${questionText.slice(0, 80)}`);
      if (portalFamily(portal) === 'greenhouse' && questionFillShouldPressEnter(questionText)) {
        actions.push({
          type: 'press',
          selector: portalSelector,
          value: 'Enter',
          label: `question_confirm:${questionText.slice(0, 80)}`,
          optional: true,
          timeout: MANAGED_FILL_TIMEOUT_MS,
        });
      }
      if (portalFamily(portal) === 'greenhouse') {
        pushGreenhouseQuestionComboboxActions(
          actions,
          portalSelector,
          questionText,
          answer,
          'question',
          packet.jdText,
          packet.referralSourceEvidence,
          answerIsResolved,
        );
        pushGreenhouseCheckboxOptionActions(actions, questionText, answer, 'question');
      }
      continue;
    }
    if (portalFamily(portal) === 'greenhouse') {
      if (isRoutineCandidatePrivacyAcknowledgement(questionText)) {
        pushGreenhouseCheckboxOptionActions(actions, questionText, answer, 'question');
        if (/\bjob\s+applicant\s+privacy\s+notice\b/i.test(questionText)) {
          pushGreenhouseQuestionComboboxLabelActions(
            actions,
            questionText,
            answer,
            'question',
            packet.jdText,
            packet.referralSourceEvidence,
            answerIsResolved,
          );
        }
        continue;
      }
      if (isGreenhouseEducationComboboxQuestion(questionText)) {
        pushGreenhouseQuestionComboboxLabelActions(
          actions,
          questionText,
          answer,
          'question',
          packet.jdText,
          packet.referralSourceEvidence,
          answerIsResolved,
        );
        continue;
      }
      const isReactSelectQuestion = isGreenhouseReactSelectQuestion(questionText);
      if (!isReactSelectQuestion) {
        pushScopedQuestionChoiceActions(actions, questionText, answer, 'question');
      }
      pushGreenhouseQuestionComboboxLabelActions(
        actions,
        questionText,
        answer,
        'question',
        packet.jdText,
        packet.referralSourceEvidence,
        answerIsResolved,
      );
      pushGreenhouseCheckboxOptionActions(actions, questionText, answer, 'question');
    } else {
      pushScopedQuestionChoiceActions(actions, questionText, answer, 'question');
      if (portalFamily(portal) === 'ashby') {
        pushAshbyQuestionTextFallbackActions(actions, questionText, answer, 'question');
      }
    }
  }
  if (portalFamily(portal) === 'greenhouse') {
    pushGreenhouseKnownQuestionAliases(actions, packet, 'legacy');
    pushGreenhouseReferralSourceAliases(actions, packet);
    pushGreenhouseDemographicAliases(actions, packet);
  }
  // Workable resume parsing can rewrite contact fields. Phone therefore runs after every upload,
  // address commit, and reviewed-question action, then proves the selected dial code and live value.
  if (family === 'workable') {
    workablePhoneReadyForSubmit = pushWorkableManagedPhoneActions(actions, packet.phone);
  }
  // Prepare only. The submit path makes the standalone probe call above this one and reads its
  // evidence from there, so repeating the reads inside the submit action list would spend budget on
  // a page that is about to be clicked anyway. On prepare there is no probe call at all, and this is
  // the only thing that lets the runner's CAPTCHA verdict be corroborated instead of believed.
  if (!submit) {
    pushManagedCoreFieldExtractActions(actions, portal);
    actions.push(...managedCaptchaEvidenceActions());
  }
  // Choice controls are filled only by the runner's scoped question-container logic. That keeps
  // short answers such as "Yes" from matching an unrelated acknowledgement elsewhere on the page.
  // portalCanAutoSubmit is the second gate, and it is deliberately NOT the caller's job. A caller
  // passing submit=true is saying "the human approved sending this"; it is not saying the platform
  // is capable of being sent in one run. Paylocity's "Next Step" button and JazzHR's reCAPTCHA both
  // sit behind a control that LOOKS submittable, so a caller acting in good faith would otherwise
  // click into a half-finished multi-page flow or bounce off a challenge, and in the Paylocity case
  // the run could report success for an application no employer ever received. Gating here means the
  // guarantee holds no matter who calls this.
  // Multi-step portals walk their wizard instead of submitting. This runs AFTER the reviewed-question
  // fills above, so step one is complete before the first advance; each later step then gets another
  // pass of the same question fills, since a screener question can appear on any page.
  // Gated on `submit`, not just on family. prepare() calls this builder with submit=false to capture
  // the preview screenshot the human approves. Traversing there advanced a real employer's wizard on
  // a run that explicitly asked not to submit, and captured the preview of step 4 - so the student
  // was shown an empty attestation page as the evidence of what she was approving.
  if (submit && portalFamily(portal) === 'paylocity') pushPaylocityTraversal(actions, packet);

  // Last-line invariant. Builder-specific guards above keep the intent legible; this exact-id and
  // exact-label filter ensures a newly added fallback cannot silently bypass them later.
  if (packet.failedFields?.length) {
    const allowed = actions.filter((action) => !managedActionTargetsFailedField(action, packet));
    actions.splice(0, actions.length, ...allowed);
  }

  /* THE BUDGET. Applied to every family, not just Greenhouse - see
   * trimSpeculativeManagedActionsToBudget for the measurement that made that necessary, and for why
   * the answer is to trim here rather than to raise the runner's MAX_ACTIONS.
   *
   * Three passes, most discriminating first, each a no-op once the list is inside the budget:
   *   1. the Greenhouse-specific group order, which knows which of that family's alias fills are
   *      disposable and which are a required field's only attempt;
   *   2. the generic one, which gives up repeat guesses at a control before the last guess at any
   *      other, and is the whole of the trim on the other thirteen families;
   *   3. the tail truncation, which is the blunt last resort but cannot take core application fills
   *      or the last viable chain for a reviewed question. If the protected minimum still does not
   *      fit, the builder stops with ManagedActionBudgetError before it creates the submit action.
   *
   * What pass 2 means for Greenhouse, stated precisely because the loose version of it is wrong.
   * Pass 2 can affect Greenhouse when pass 1 cannot get under budget. That is intentional: give up
   * a redundant guess before the blunt pass takes a whole unprotected group from the tail. Core
   * fields and the selected question chains are protected through every pass.
   */
  // A nonempty Workable phone that cannot be mapped to an exact country and national value is not
  // the same as no phone on file. The runner must never reach its atomic submit action in that
  // state. A truly absent phone keeps the previous behavior, so required-field confirmation on the
  // employer form remains the authority on whether the application can proceed without one.
  /* portalCanAutoSubmit OR a live consent-tick plan. The plan is the per-account conditional case:
   * it exists only when the family's single bar is the routine consent control, the account's
   * standing permission is granted and current, and this packet carries the recorded acceptance for
   * exactly one captured control. No plan means the grant-conditional families keep today's exact
   * behaviour: fill, stop, hand off. */
  const canAppendSubmit = submit
    && (portalCanAutoSubmit(portal) || consentTick !== null)
    && workablePhoneReadyForSubmit;
  /* The Akuna carve-out that used to sit here (100 instead of MANAGED_ACTION_LIMIT, 7891fa4) is
   * retired. It was headroom with no measured ceiling behind it, set when Akuna's education block
   * was invisible to discovery. The moment discovery captured those controls (2026-08-18, packet
   * 41f0b79d: 34 reviewed questions), the smaller budget was the direct reason five required
   * education controls, both attestations and the referral source were dropped from the fill. The
   * runner's real ceiling is MANAGED_ACTION_LIMIT and it is enforced with HTTP 400, so the one
   * limit is the honest one. */
  const familyActionLimit = MANAGED_ACTION_LIMIT;
  // Submission reserves one atomic action. It resolves and retains the exact final control and its
  // closest form, confirms the form, and owns the one authorized physical click. The confirmation
  // action is required and fail-closed. It emits input/change plus blur for text and
  // date controls, commits an exact option for native and React selects, and focuses/clicks the
  // exact associated control or label for radio, checkbox and custom controls. It then rescans
  // only affected required fields once. The managed runner must stop the list if any confirmation
  // fails, which makes the submit click physically unreachable.
  //
  // A grant-conditional submit also reserves the consent tick's three actions (capability pin,
  // honeypot guard, the one click), for the same reason the submit reserves its one: they are
  // appended after the trims, so the budget has to leave room for them or the runner rejects the
  // whole list with HTTP 400 before a browser opens.
  const actionLimit = canAppendSubmit
    ? familyActionLimit - 1 - (consentTick ? CONSENT_TICK_ACTION_COUNT : 0)
    : familyActionLimit;
  const questionProtection = reviewedQuestionActionProtection(actions, packet);
  const coreProtection = coreActionProtection(actions, portal);
  const protectedActionBases = new Set([...coreProtection, ...questionProtection.actionBases]);
  if (portalFamily(portal) === 'greenhouse') {
    trimGreenhouseManagedActionsToBudget(actions, actionLimit, protectedActionBases);
  }
  trimSpeculativeManagedActionsToBudget(actions, actionLimit, protectedActionBases);
  /* Ahead of BOTH tail truncations, or it is too late to matter: the first truncate below eats
   * unprotected groups from the tail, and the required attestation and alias chains it would eat
   * are exactly what the optional questions are giving up their chains to save. Never on a submit
   * run: the submit path refuses to trade away any reviewed answer and throws instead, optional or
   * not, and that refusal is preserved unchanged. */
  if (!canAppendSubmit && actions.length > actionLimit) {
    trimOptionalQuestionActionsToBudget(actions, actionLimit, packet, coreProtection);
  }
  if (actions.length > actionLimit) {
    truncateManagedActionsToBudget(actions, actionLimit, protectedActionBases);
  }
  /* WHAT HAPPENS WHEN EVEN THE PROTECTED MINIMUM DOES NOT FIT, and the two answers differ by
   * whether this run can press the button.
   *
   * A SUBMIT run stops. What the stop protects against is sending an application with an answer
   * silently dropped out of it, and there is no version of that trade worth making automatically.
   *
   * A PREPARE run cannot send anything: it fills what it can, screenshots the result, and hands the
   * packet back for a human to look at. Stopping there would trade a partly filled form she can see
   * and finish for a dead packet, and would throw away the fixed fields, the preview and the
   * evidence reads with it, on exactly the packets most likely to need them. So it gives up whole
   * questions instead, dropping the protection that the submit path refuses to drop.
   *
   * It must still FIT. Returning the over-budget list instead of trimming it is the original bug of
   * this whole line of work wearing a different hat: the runner answers anything over the ceiling
   * with HTTP 400 before a browser opens, so "prepare does not throw" would have become "prepare
   * does not run". Measured on a 200-question packet, this is the difference between a 231-action
   * list the runner rejects outright and a 120-action list that fills what it can.
   *
   * The core fields stay protected through this last pass, so what comes off is reviewed questions
   * and nothing else. And it is not quiet: reviewedQuestionsWithoutActions reads the finished list,
   * prepareManaged puts every dropped question in the applicant's attention list and refuses to call
   * the packet safe, so the answer is still never traded away behind her back. It is traded visibly,
   * one step earlier, where she can do something about it.
   */
  if (actions.length > actionLimit) {
    if (canAppendSubmit) {
      throw new ManagedActionBudgetError(portal, familyActionLimit, questionProtection.questionCount);
    }
    truncateManagedActionsToBudget(actions, actionLimit, coreProtection);
  }

  // The tick precedes the submit action IMMEDIATELY, after every trim, so nothing can be inserted
  // between the acceptance and the press it licenses and no trim can take the guard while keeping
  // the click.
  if (canAppendSubmit && consentTick) pushManagedConsentTickActions(actions, consentTick);
  if (canAppendSubmit) {
    actions.push({
      type: 'confirmAndSubmit',
      // This is a candidate set, not an instruction to click its first match. The v2 runner applies
      // the same semantic final-control chooser used on the direct path, binds the chosen node and
      // closest form through opaque fingerprints, confirms that form, then clicks that exact node
      // inside this action. It blocks on ambiguity, replacement, or a changed form identity.
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      label: 'required_field_confirmation',
      optional: false,
      timeout: MANAGED_FILL_TIMEOUT_MS,
      maxRetries: 1,
      contractVersion: 2,
      submitKind: 'application',
      chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY,
    });
  }
  return actions;
}

// Walk Paylocity's four-step wizard, filling each page, and stop at the last one.
//
// Every action here is optional, which is what makes a fixed sequence safe against a variable
// wizard: a posting with only two steps simply no-ops the remaining advances rather than erroring.
// The advance selector is scoped to the "Next Step" label (see PAYLOCITY_ADVANCE_SELECTOR), so the
// sequence physically cannot press the terminal submit no matter how many advances are queued.
//
// What this deliberately does NOT do is answer the final step's content. The live model shows that
// page can carry EEO/OFCCP self-identification, a prior-conviction declaration, a work-authorisation
// declaration, and an acknowledgement reading "you hereby certify that the facts set forth in the
// above employment application are true and complete". Demographics are the student's alone, and the
// rest are legal attestations in her name - so Litos fills the pages before it and hands over one
// page from the end, with everything else already done.
function pushPaylocityTraversal(actions: ManagedBrowserAction[], packet: SubmissionPacket) {
  for (let step = 0; step < PAYLOCITY_MAX_ADVANCES; step += 1) {
    actions.push({
      type: 'click',
      selector: PAYLOCITY_ADVANCE_SELECTOR,
      label: `advance to step ${step + 2}`,
      optional: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    });
    // Screener questions live on the steps after the first, and only reviewed answers are sent -
    // the same rule as everywhere else. Choice controls stay with the human (see the note below
    // about never matching a short answer like "Yes" against an arbitrary label).
    for (const item of canFillReviewedQuestions('managed') ? packet.questions : []) {
      if (!item.answer.trim()) continue;
      const questionText = normalizeReviewQuestionLabel(item.question);
      if (!questionText) continue;
      if (shouldSkipReviewedConsentQuestion(questionText)) continue;
      const portalSelector = durablePortalSelector(reviewQuestionPortalSelector(item));
      if (portalSelector) {
        managedFill(actions, portalSelector, item.answer, `question:${questionText.slice(0, 80)}`);
        continue;
      }
      pushScopedQuestionChoiceActions(actions, questionText, item.answer, 'question');
    }
  }
}

// Whether a page the runner landed on is Paylocity's terminal attestation step.
//
// READ THE SUFFIX BEFORE CHANGING THIS. The marker ids are `...notLastStep` and
// `...notLastStepOrNotIncluded` - they are Paylocity's own negative flags, rendered precisely when
// the page is NOT the last step. A first version of this function treated their PRESENCE as proof of
// the terminal page and so returned true on step one, which is exactly backwards. Their presence
// means "keep going"; their ABSENCE, on a page that still has the wizard's submit control, is what
// identifies the end.
//
// Requiring the submit control too is what keeps this from firing on an unrelated page that merely
// lacks the markers (an error page, a timeout, a redirect to the job board).
export function isPaylocityTerminalStep(pageHtml: string): boolean {
  const hasNotLastStepMarker = PAYLOCITY_TERMINAL_MARKERS.some((marker) => pageHtml.includes(marker));
  if (hasNotLastStepMarker) return false;
  return pageHtml.includes('btn-submit');
}

export function readManagedReceipt(result: ManagedBrowserResult): {
  confirmationText: string;
  finalUrl: string;
  referenceId?: string;
} {
  const body = result.text.replace(/\s+/g, ' ').trim();
  if (!RECEIPT_PROOF_RE.test(body)) {
    throw new Error('The company never showed a confirmation we could check');
  }
  return { confirmationText: body.slice(0, 1000), finalUrl: result.url, referenceId: receiptReference(body) };
}

const HOSTS: Record<PortalFamily, RegExp> = {
  greenhouse: /(^|\.)greenhouse\.io$/i,
  lever: /(^|\.)lever\.co$/i,
  ashby: /(^|\.)ashbyhq\.com$/i,
  // The public posting and one-click form both live on this exact host. API, vendor marketing,
  // authentication, and customer product hosts must never inherit application capability.
  smartrecruiters: /^jobs\.smartrecruiters\.com$/i,
  // apply.* only. A bare workable.com match also claimed www.workable.com, which is the vendor's
  // marketing site, so a mistyped portal_url became a "supported portal" and got a fill run against
  // a page with no application on it.
  workable: /^apply\.workable\.com$/i,
  /* ANY TENANT, and the two-tenant pin it replaces was costing real postings for no safety.
   *
   * The old comment said the applytojob.com suffix "is not proof that an arbitrary subdomain
   * exposes the same application controls", which is true and is not the question. The question is
   * what Litos DOES on a tenant it guessed wrong about, and for this family the answer is bounded
   * by something stronger than a host list: jazzhr is in CAPTCHA_GATED_FAMILIES, so
   * portalCanAutoSubmit is false for every tenant that ever matches here. Widening this cannot
   * produce an unattended send; the worst case is a fill that finds nothing and hands back.
   *
   * Measured 2026-08-19 against 562 live 2027 internship postings: five sit on JazzHR, on five
   * tenants (blackcape, foxconnggroup, gulfmanagement, hiebing, prospectequities) and NONE of the
   * two pinned ones. The pin was rejecting every JazzHR posting a student could actually find.
   *
   * The path rule below is what does the real work, and it stays strict. `www.` is excluded because
   * it is JazzHR's own marketing site. */
  jazzhr: /^(?!www\.)[a-z0-9-]+\.applytojob\.com$/i,
  // Tenant subdomains are arbitrary (2000recruiting.paylocity.com), so the host cannot be pinned the
  // way Workable's can - but it MUST exclude access.paylocity.com, which is Paylocity's employee
  // login. Litos filling an identity into a credential form is not a thing that should be reachable
  // from a bad URL. The apply path check in detectPortal is what actually enforces this.
  paylocity: /(^|\.)paylocity\.com$/i,
  // ats.* ONLY. app.rippling.com is Rippling's HR product, where the equivalent-looking form is an
  // employee login. Exactly the access.paylocity.com hazard, so it gets the same pinned-subdomain
  // treatment rather than the (^|\.) form.
  rippling: /^ats\.rippling\.com$/i,
  // Tenant subdomains are arbitrary (zinier.breezy.hr, recruiting.breezy.hr), so the host cannot be
  // pinned - but the bare breezy.hr is the vendor's marketing site, which the (^|\.) form also
  // matches. The /p/ path check below is what excludes it.
  breezy: /(^|\.)breezy\.hr$/i,
  // Same shape: tenant subdomains, and www.bamboohr.com is the marketing site. Note BambooHR's OWN
  // careers page runs on Greenhouse and lives at www.bamboohr.com/careers/application, which the
  // numeric-id path check below excludes without needing to special-case the host.
  bamboohr: /^(?:mpathic2|prentkeromich)\.bamboohr\.com$/i,
  // jobs.* only. The bare jobvite.com is the vendor's marketing site.
  jobvite: /^jobs\.jobvite\.com$/i,
  // One tenant label only. Excludes vendor marketing, community, login, and API hosts before the
  // path rule is even considered. Real tenants include jobs-express and externalhourly-omnihotels.
  icims: /^(?!(?:www|community|login|api)\.)[a-z0-9-]+\.icims\.com$/i,
  // The widest host space of any portal here BY FAR - oraclecloud.com hosts every Oracle Cloud
  // application there is, not just recruiting. The path check is doing the real work, and this entry
  // would be actively dangerous without it.
  oraclecloud: /^(?:eeho\.fa\.us2\.oraclecloud\.com|iawmqy\.fa\.ocs\.oraclecloud\.com|fa-etxx-saasfaprod1\.fa\.ocs\.oraclecloud\.com|enterpriseplatform\.dell\.com)$/i,
  // Pinned exactly. The bare ultipro.com is the employee login for UKG's HR product.
  ultipro: /^recruiting\.ultipro\.com$/i,
  // One tenant label only. Excludes www.recruitee.com and the vendor's own non-careers services.
  recruitee: /^(?!www\.)[^.]+\.recruitee\.com$/i,
  // career.teamtailor.com is Teamtailor's own public tenant. Product, API, and docs hosts are out.
  teamtailor: /^(?!(?:www|app|api|partner|docs|support)\.)[^.]+\.teamtailor\.com$/i,
  // Personio tenants use {tenant}.jobs.personio.de or .com. Requiring the jobs label prevents a
  // company or employee product on another Personio host from being mistaken for an application.
  personio: /^[a-z0-9-]+\.jobs\.personio\.(?:de|com)$/i,
  pinpoint: /^(?!www\.)[a-z0-9-]+\.pinpointhq\.com$/i,
  // The public www.comeet.com posting is only a wrapper. The actual form is a token-bearing iframe
  // on www.comeet.co, and that token cannot be derived from the posting URL. Only the real form URL
  // is supported so the backend never promises a fill it cannot reach.
  comeet: /^www\.comeet\.co$/i,
  zoho_recruit: /^[^.]+\.zohorecruit\.(?:com|eu|in)$/i,
  // Bullhorn's OSCP is intentionally self-hosted. Only exact tenants inspected live are claimed;
  // no arbitrary marketing domain becomes a supported ATS because it happens to link to Bullhorn.
  bullhorn: /^(?:www\.serverlogic\.com|www\.staffingsolutionsenterprises\.com)$/i,
  sap_successfactors: /^career\d+\.successfactors\.(?:com|eu)$/i,
  oracle_taleo: /^(?:fa007|aa270)\.taleo\.net$/i,
  adp_recruiting: /^myjobs\.adp\.com$/i,
  avature: /^(?:(?:maximus|sandboxxerox)\.avature\.net|jobs\.ea\.com)$/i,
};

/**
 * Every supported family, as a value rather than a type.
 *
 * Derived from HOSTS rather than written out, because HOSTS is a `Record<PortalFamily, RegExp>` and
 * the compiler will not let a family exist without a key here. A hand-maintained copy of this list
 * drifts the moment somebody adds a portal, and it drifts SILENTLY: the budget test that walks every
 * family would keep passing while quietly not covering the new one, which is the exact shape of the
 * blind spot the budget trim exists to close. Eleven families landed between this branch being cut
 * and it being merged; the hardcoded list in the test had covered fourteen.
 */
export const PORTAL_FAMILIES = Object.keys(HOSTS) as readonly PortalFamily[];

// Host alone is not enough for a portal whose host space also serves a login page, a marketing site
// or an unrelated product. Started as one Paylocity special case; it is a map now because five of
// the seven platforms added on 2026-07-29 need the same treatment, and a chain of `if (portal ===
// ...)` in detectPortal would have been the wrong shape for that.
//
// A family absent from this map is matched on host alone, which is the old behaviour for the
// portals that were already here.
const APPLY_PATHS: Partial<Record<PortalFamily, RegExp>> = {
  // Either a public posting or the separate one-click form. No API, company-listing, or account
  // route on the same host is allowed through.
  smartrecruiters: /^\/(?:[a-z0-9._-]+\/\d{6,}(?:-[^/]+)?|oneclick-ui\/company\/[a-z0-9._-]+\/publication\/[0-9a-f-]{36})\/?$/i,
  /* TWO SHAPES, because JazzHR publishes two and only one was here.
   *
   * `/apply/jobs/details/{code}` is the board's own detail route. `/apply/{code}/{slug}` is the
   * direct apply link, and it is the one every JazzHR posting in the 2026-08-19 survey used - so
   * the single-shape rule rejected all five of them even once the host matched.
   *
   * The 10-character code is what keeps this narrow: it is required in both branches, so a bare
   * `/apply`, a careers index, or a login route on the same host still cannot match. The optional
   * slug is untrusted display text and is matched loosely on purpose. */
  jazzhr: /^\/apply\/(?:jobs\/details\/[A-Za-z0-9]{10}|[A-Za-z0-9]{10}(?:\/[^/]*)?)\/?$/,
  // access.paylocity.com is an employee login on the same host space. Litos filling an identity into
  // a credential form is not a thing that should be reachable from a bad URL.
  paylocity: /^\/recruiting\/jobs\/(apply|details)\//i,
  // Excludes the bare breezy.hr marketing site; every real posting is /p/{id}-{slug}.
  breezy: /^\/p\//i,
  // Numeric job id. Excludes www.bamboohr.com/careers/application (their own Greenhouse-backed
  // careers page) and the /careers/{department}-team marketing routes, without an ad-hoc host rule.
  bamboohr: /^\/careers\/\d+\/?$/i,
  jobvite: /^\/[a-z0-9._-]+\/job\/[a-z0-9]+(?:\/apply)?\/?$/i,
  icims: /^\/jobs\/\d+\/[a-z0-9%._~-]+\/(?:job|login)\/?$/i,
  // The one that matters most. Without it this family would claim every Oracle Cloud application
  // under the sun, including ones that are somebody's payroll or ERP login.
  oraclecloud: /^\/hcmUI\/CandidateExperience\/(?:[a-z]{2}\/)?sites\/[a-z0-9_-]+\/(?:job|opportunity)\/\d+(?:\/apply\/email)?\/?$/i,
  ultipro: /^\/[a-z0-9._-]+\/JobBoard\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/OpportunityDetail\/?$/i,
  recruitee: /^\/o\/[^/]+(?:\/c\/new)?\/?$/i,
  teamtailor: /^\/jobs\/[^/]+(?:\/applications\/new)?\/?$/i,
  personio: /^\/job\/\d+(?:\/apply)?\/?$/i,
  pinpoint: /^\/(?:[a-z]{2}\/)?postings\/[0-9a-f-]+(?:\/applications\/new)?\/?$/i,
  comeet: /^\/jobs\/[A-Z0-9.]+\/[A-Z0-9.-]+\/apply\/?$/i,
  zoho_recruit: /^\/jobs\/Careers\/\d+\/[^/]+\/?$/i,
  bullhorn: /^\/wp-content\/plugins\/bullhorn-oscp\/?$/i,
  sap_successfactors: /^\/(?:sfcareer\/jobreqcareer|career|portalcareer)\/?$/i,
  oracle_taleo: /^\/careersection\/ex\/jobdetail\.ftl$/i,
  adp_recruiting: /^\/(?:guitarcenterexternal|kaisercareers)\/cx\/job-details\/?$/i,
  avature: /^\/(?:[a-z]{2}_[a-z]{2}\/)?careers\/(?:JobDetail(?:\/[^/]+\/\d+)?|Job-Application|Login)\/?$/i,
};

function isSmartRecruitersOneClickUrl(url: URL): boolean {
  return url.hostname.toLowerCase() === 'jobs.smartrecruiters.com'
    && /^\/oneclick-ui\/company\/[a-z0-9._-]+\/publication\/[0-9a-f-]{36}\/?$/i.test(url.pathname);
}

// Comeet's public .com job page is only a wrapper. The real .co application URL is usable only
// with the opaque token issued into its iframe query string. Inspect the raw query so validation
// never decodes, trims, re-encodes, or otherwise changes token bytes.
function hasComeetApplicationToken(url: URL): boolean {
  return /(?:^\?|&)token=[^&]+(?:&|$)/.test(url.search);
}

function isExactResearchedBatchIdentity(portal: PortalFamily, url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (portal === 'recruitee'
    && /^\/o\/software-engineer-intern(?:\/c\/new)?\/?$/.test(url.pathname)) return false;
  if (portal === 'teamtailor'
    && /^\/jobs\/7847431-software-engineering-intern-web-scraping-data-acquisition(?:\/applications\/new)?\/?$/.test(url.pathname)
    && host !== 'flanks.teamtailor.com') return false;
  if (portal === 'teamtailor' && host === 'flanks.teamtailor.com') {
    return /^\/jobs\/7847431-software-engineering-intern-web-scraping-data-acquisition(?:\/applications\/new)?\/?$/.test(url.pathname)
      && !url.search && !url.hash;
  }
  if (portal === 'personio') {
    const isReservedArteusJob = /^\/job\/2521967(?:\/apply)?\/?$/.test(url.pathname);
    if (isReservedArteusJob) {
      if (host !== 'arteus-energy.jobs.personio.de' || url.pathname !== '/job/2521967' || url.hash) return false;
      const applyValues = url.searchParams.getAll('apply');
      const languageValues = url.searchParams.getAll('language');
      const queryKeys = [...url.searchParams.keys()];
      return applyValues.length === 1
        && applyValues[0] === ''
        && languageValues.length === 1
        && languageValues[0] === 'de'
        && queryKeys.length === 2
        && queryKeys.every((key) => key === 'apply' || key === 'language');
    }
    if (host === 'arteus-energy.jobs.personio.de') return false;
  }
  if (portal === 'bamboohr') {
    return (host === 'mpathic2.bamboohr.com' && /^\/careers\/99\/?$/.test(url.pathname))
      || (host === 'prentkeromich.bamboohr.com' && /^\/careers\/480\/?$/.test(url.pathname));
  }
  if (portal === 'oraclecloud') {
    return (host === 'eeho.fa.us2.oraclecloud.com'
        && url.pathname === '/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email'
        && !url.search && !url.hash)
      || ((host === 'enterpriseplatform.dell.com' || host === 'iawmqy.fa.ocs.oraclecloud.com')
        && /^\/hcmUI\/CandidateExperience\/en\/sites\/careers\/job\/295586\/?$/i.test(url.pathname))
      || (host === 'fa-etxx-saasfaprod1.fa.ocs.oraclecloud.com'
        && /^\/hcmUI\/CandidateExperience\/en\/sites\/CX_1\/job\/2850\/?$/i.test(url.pathname));
  }
  if (portal === 'ultipro') {
    const opportunityIds = url.searchParams.getAll('opportunityId');
    if (opportunityIds.length !== 1) return false;
    const identity = `${url.pathname}?opportunityId=${opportunityIds[0]}`;
    return identity === '/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9'
      || identity === '/LIT1004LDAC/JobBoard/30702fd2-636e-4886-b1ce-4fc3b07e37ec/OpportunityDetail?opportunityId=4fc30c2a-e2b3-42e0-bcaf-7805f741c04a'
      || identity === '/cov1003covcu/JobBoard/24b0bccd-d0f2-4641-a5f2-6ca809c72521/OpportunityDetail?opportunityId=954bed4e-7b77-4abd-ac78-add89ee3c71e';
  }
  if (portal === 'avature') {
    if (host === 'jobs.ea.com') {
      return url.searchParams.getAll('jobId').length === 0
        && /^\/en_US\/careers\/JobDetail\/Software-Engineer-Intern\/214956\/?$/.test(url.pathname);
    }
    if (host === 'maximus.avature.net') return /^\/careers\/Job-Application\/?$/i.test(url.pathname);
    if (host !== 'sandboxxerox.avature.net') return false;
    if (/^\/en_US\/careers\/JobDetail\/2nd-Line-Technical-Analyst\/44460\/?$/i.test(url.pathname)) return true;
    return /^\/en_US\/careers\/Login\/?$/i.test(url.pathname) && url.searchParams.get('jobId') === '44460';
  }
  return true;
}

function databricksGreenhouseJobId(url: URL): string | undefined {
  if (!/^(?:www\.)?databricks\.com$/i.test(url.hostname)) return undefined;
  const greenhouseJobId = url.searchParams.get('gh_jid') ?? '';
  if (!/^\d+$/.test(greenhouseJobId)) return undefined;
  const canonicalDatabricksJobPath = new RegExp(`^/company/careers/[a-z0-9-]+/[a-z0-9-]+-${greenhouseJobId}$`, 'i');
  return url.pathname === '/company/careers/open-positions/job' || canonicalDatabricksJobPath.test(url.pathname)
    ? greenhouseJobId
    : undefined;
}

function greenhouseEmbedApplicationUrl(rawUrl: string): string | undefined {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') return undefined;
  const databricksJobId = databricksGreenhouseJobId(url);
  if (databricksJobId) return `https://boards.greenhouse.io/embed/job_app?token=${databricksJobId}`;
  // Greenhouse boards embedded on an employer's own domain. The board token is never read off the
  // page; see lib/greenhouseEmbeddedBoards for how it is established.
  const embeddedBoardUrl = embeddedGreenhouseApplicationUrl(url);
  if (embeddedBoardUrl) return embeddedBoardUrl;
  const host = url.hostname.toLowerCase();
  if (host === 'boards.greenhouse.io' && url.pathname === '/embed/job_app') {
    const token = url.searchParams.get('token') ?? '';
    if (!/^\d+$/.test(token)) return undefined;
    const board = url.searchParams.get('for') ?? url.searchParams.get('b') ?? '';
    return board
      ? `https://boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${token}`
      : `https://boards.greenhouse.io/embed/job_app?token=${token}`;
  }
  if (host !== 'boards.greenhouse.io' && host !== 'job-boards.greenhouse.io') return undefined;
  const jobMatch = url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)\/?$/i);
  if (!jobMatch) return undefined;
  const [, board, greenhouseJobId] = jobMatch;
  return `https://boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${greenhouseJobId}`;
}

export function detectPortal(rawUrl: string): SupportedPortal {
  const url = new URL(rawUrl);
  if (isControlledTestPortalUrl(rawUrl)) {
    const pathBoard = url.pathname.split('/').filter(Boolean)[2];
    const board = (url.searchParams.get('board') ?? pathBoard)?.toLowerCase();
    if (board === 'lever') return 'controlled_lever';
    if (board === 'ashby') return 'controlled_ashby';
    if (board === 'smartrecruiters') return 'controlled_smartrecruiters';
    if (board === 'workable') return 'controlled_workable';
    if (board === 'jazzhr') return 'controlled_jazzhr';
    if (board === 'paylocity') return 'controlled_paylocity';
    if (board === 'rippling') return 'controlled_rippling';
    if (board === 'breezy') return 'controlled_breezy';
    if (board === 'bamboohr') return 'controlled_bamboohr';
    return 'controlled_test';
  }
  if (url.protocol !== 'https:') throw new Error('That application page is not a secure link');
  if (url.hostname.toLowerCase() === 'whitecoatglobal1.recruitee.com') {
    if (/^\/o\/software-engineer-intern(?:\/c\/new)?\/?$/.test(url.pathname) && !url.search && !url.hash) {
      return 'manual_recruitee';
    }
    throw new Error('Litos cannot fill in this company\u2019s application page yet.');
  }
  // Databricks hosts Greenhouse applications behind a company-owned wrapper URL. Keep this pinned to
  // the known careers path plus numeric Greenhouse job id so unrelated company pages with `gh_jid`
  // query strings do not become supported by accident.
  if (databricksGreenhouseJobId(url)) {
    return 'greenhouse';
  }
  // Every other employer that serves its Greenhouse board from its own domain. Recognised only
  // when the host resolves to exactly one verified Greenhouse board token, so a `gh_jid` on a page
  // that is not a board we can name stays unsupported and keeps its email fallback.
  if (embeddedGreenhouseJobId(url)) {
    return 'greenhouse';
  }
  const bullhornHash = url.hash.match(/^#\/jobs\/(\d+)(?:\/apply)?\/?$/i);
  const isBullhornTenant = HOSTS.bullhorn.test(url.hostname);
  if (isBullhornTenant && APPLY_PATHS.bullhorn!.test(url.pathname) && bullhornHash) return 'bullhorn';
  for (const [portal, host] of Object.entries(HOSTS)) {
    if (portal === 'bullhorn') continue;
    if (!host.test(url.hostname)) continue;
    // See APPLY_PATHS. A family listed there must match its path too, because its host space also
    // serves logins, marketing pages, or in Oracle's case entire unrelated products.
    const applyPath = APPLY_PATHS[portal as PortalFamily];
    if (applyPath && !applyPath.test(url.pathname)) continue;
    if (portal === 'comeet' && !hasComeetApplicationToken(url)) continue;
    if (portal === 'sap_successfactors') {
      const jobId = url.searchParams.get('jobId') ?? url.searchParams.get('career_job_req_id') ?? url.searchParams.get('job_application');
      const tenant = url.searchParams.get('company');
      if (!jobId || !/^\d+$/.test(jobId) || !tenant || !/^[A-Za-z0-9_-]+$/.test(tenant)) continue;
    }
    if (portal === 'oracle_taleo' && !/^\d+$/.test(url.searchParams.get('job') ?? '')) continue;
    if (portal === 'adp_recruiting' && !/^\d+$/.test(url.searchParams.get('reqId') ?? '')) continue;
    if (portal === 'ultipro') {
      const opportunityId = url.searchParams.get('opportunityId');
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opportunityId ?? '')) continue;
    }
    if (portal === 'avature') {
      const hasPathJobId = /\/JobDetail\/[^/]+\/\d+\/?$/i.test(url.pathname);
      const queryJobId = url.searchParams.get('jobId');
      if (/\/(?:JobDetail|Login)\/?$/i.test(url.pathname) && !hasPathJobId && !/^\d+$/.test(queryJobId ?? '')) continue;
    }
    if (!isExactResearchedBatchIdentity(portal as PortalFamily, url)) continue;
    return portal as SupportedPortal;
  }
  // Names the platforms it can actually DO something useful on. The account-walled four are
  // recognised by the loop above and explained by portalHandoffReason, but listing them here would
  // read as a promise to fill them, which is the opposite of what recognising them is for.
  throw new Error('Litos cannot fill in this company\u2019s application page yet. It works on Greenhouse, Lever, Ashby, SmartRecruiters, Workable, JazzHR, Paylocity, Rippling, BreezyHR, BambooHR, Recruitee, Teamtailor, Personio, Pinpoint and Comeet.');
}

/**
 * Can Litos fill in this page at all? Answerable the moment we have the URL.
 *
 * detectPortal THROWS on an unrecognised page, which is correct for the runner but useless
 * everywhere else: a throw cannot be asked a question, so nothing upstream of the run ever asked.
 * The result was that a packet on a company-owned careers page (jumptrading.com, optiver.com,
 * nuro.ai) sat in the Tracker labelled "Ready" behind a live send button, and the applicant only
 * discovered Litos could not submit it after a multi-minute run failed. Nine of ten failures on the
 * owner's account on 2026-08-04 were exactly this.
 *
 * The portal is knowable from apply_url at CREATION time. This is the non-throwing form of that
 * same question so the Tracker can be honest before anyone clicks. A malformed URL is unsupported
 * rather than an exception, because a caller asking "can we?" wants an answer, not a crash.
 */
export function isPortalSupported(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    detectPortal(rawUrl);
    return true;
  } catch {
    return false;
  }
}

export function canonicalSupportedPortalUrl(rawUrl: string | undefined, atsName?: string | null): string | undefined {
  if (!rawUrl) return undefined;
  // Some company-hosted Greenhouse wrappers keep only gh_jid in the URL and are stored with a
  // generic ats_name on older packets. The Databricks wrapper keeps its own pinned shape, and every
  // other employer domain goes through the verified board-token map in greenhouseEmbeddedBoards; a
  // company page whose board token cannot be established stays unsupported.
  void atsName;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return undefined;
    const greenhouseJobId = databricksGreenhouseJobId(url);
    if (greenhouseJobId) return `https://boards.greenhouse.io/embed/job_app?token=${greenhouseJobId}`;
    const embeddedBoardUrl = embeddedGreenhouseApplicationUrl(url);
    if (embeddedBoardUrl) return embeddedBoardUrl;
    const greenhouseApplicationUrl = greenhouseEmbedApplicationUrl(rawUrl);
    if (greenhouseApplicationUrl) return greenhouseApplicationUrl;
    const portal = detectPortal(rawUrl);
    if (portal === 'zoho_recruit') {
      url.search = '';
      url.hash = '';
      url.pathname = url.pathname.replace(/\/$/, '');
      return url.toString();
    }
    if (portal === 'bullhorn') {
      const jobId = url.hash.match(/^#\/jobs\/(\d+)/i)?.[1];
      if (!jobId) return undefined;
      url.search = '';
      url.hash = `#/jobs/${jobId}`;
      url.pathname = '/wp-content/plugins/bullhorn-oscp/';
      return url.toString();
    }
    if (portal === 'sap_successfactors') {
      const jobId = url.searchParams.get('jobId') ?? url.searchParams.get('career_job_req_id') ?? url.searchParams.get('job_application');
      const company = url.searchParams.get('company');
      if (!jobId || !company) return undefined;
      return `https://${url.hostname}/sfcareer/jobreqcareer?jobId=${encodeURIComponent(jobId)}&company=${encodeURIComponent(company)}`;
    }
    if (portal === 'oracle_taleo') {
      const job = url.searchParams.get('job');
      if (!job) return undefined;
      return `https://${url.hostname}${url.pathname}?job=${job}&lang=en`;
    }
    if (portal === 'adp_recruiting') {
      const reqId = url.searchParams.get('reqId');
      if (!reqId) return undefined;
      return `https://${url.hostname}${url.pathname.replace(/\/$/, '')}?reqId=${reqId}`;
    }
    if (portalFamily(portal) === 'jazzhr') {
      url.search = '';
      url.hash = '';
      url.pathname = url.pathname.replace(/\/$/, '');
      return url.toString();
    }
    if (portal === 'bamboohr' || portal === 'oraclecloud' || portal === 'avature') {
      const jobId = portal === 'avature' ? url.searchParams.get('jobId') : null;
      url.search = '';
      url.hash = '';
      url.pathname = url.pathname.replace(/\/$/, '');
      if (portal === 'avature' && jobId && /^\d+$/.test(jobId) && !/\/JobDetail\/[^/]+\/\d+$/i.test(url.pathname)) {
        url.searchParams.set('jobId', jobId);
      }
      return url.toString();
    }
    if (portal === 'ultipro') {
      const opportunityId = url.searchParams.get('opportunityId');
      url.search = '';
      url.hash = '';
      url.pathname = url.pathname.replace(/\/$/, '');
      if (opportunityId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(opportunityId)) url.searchParams.set('opportunityId', opportunityId);
      return url.toString();
    }
  } catch {
    return undefined;
  }
  if (isPortalSupported(rawUrl)) {
    const portal = detectPortal(rawUrl);
    const family = portalFamily(portal);
    if (family === 'smartrecruiters' || family === 'jobvite' || family === 'icims') {
      const url = new URL(portalApplicationUrl(portal, rawUrl));
      url.hash = '';
      if (family === 'smartrecruiters' && isSmartRecruitersOneClickUrl(url)) {
        const company = url.pathname.split('/')[3] ?? '';
        const dcrCompany = url.searchParams.get('dcr_ci') ?? '';
        url.search = '';
        // dcr_ci is the only observed form query parameter and is tenant identity, not tracking.
        // Keep it only when it agrees with the company already pinned in the path.
        if (dcrCompany && dcrCompany.toLowerCase() === company.toLowerCase()) {
          url.searchParams.set('dcr_ci', company);
        }
      } else {
        url.search = '';
      }
      url.pathname = url.pathname.replace(/\/$/, '');
      return url.toString();
    }
    if (family === 'personio') {
      const url = new URL(portalApplicationUrl(portal, rawUrl));
      if (url.hostname.toLowerCase() === 'arteus-energy.jobs.personio.de') return url.toString();
      const language = url.searchParams.get('language');
      url.search = '';
      if (language && /^[a-z]{2}$/i.test(language)) url.searchParams.set('language', language.toLowerCase());
      return url.toString();
    }
    if (family === 'recruitee' || family === 'teamtailor') {
      const url = new URL(portalApplicationUrl(portal, rawUrl));
      url.search = '';
      url.hash = '';
      url.pathname = url.pathname.replace(/\/$/, '');
      return url.toString();
    }
    if (family === 'pinpoint') {
      const url = new URL(portalApplicationUrl(portal, rawUrl));
      url.search = '';
      url.hash = '';
      return url.toString();
    }
    return rawUrl;
  }
  return undefined;
}

/** Return a canonical URL only for the exact SmartRecruiters oneclick application form shape. */
export function canonicalSmartRecruitersOneClickUrl(rawUrl: string | undefined): string | undefined {
  const canonical = canonicalSupportedPortalUrl(rawUrl, 'smartrecruiters');
  if (!canonical) return undefined;
  try {
    return isSmartRecruitersOneClickUrl(new URL(canonical)) ? canonical : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalMonitoredPortalUrl(
  rawUrl: string | undefined,
  atsName?: string | null,
  boardToken?: string | null,
): string | undefined {
  if (!rawUrl) return undefined;
  const token = boardToken?.trim();
  if (atsName?.trim().toLowerCase() === 'greenhouse' && token) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== 'https:') return undefined;
      const pathJobId = url.pathname.match(/^\/[^/]+\/jobs\/(\d+)/)?.[1] ?? '';
      const greenhouseJobId = url.searchParams.get('gh_jid') ?? url.searchParams.get('token') ?? pathJobId;
      if (/^\d+$/.test(greenhouseJobId)) {
        const embedHost = url.hostname.toLowerCase() === 'job-boards.eu.greenhouse.io'
          ? 'job-boards.eu.greenhouse.io'
          : 'job-boards.greenhouse.io';
        return `https://${embedHost}/embed/job_app?for=${encodeURIComponent(token)}&token=${greenhouseJobId}`;
      }
    } catch {
      return undefined;
    }
  }
  const canonical = canonicalSupportedPortalUrl(rawUrl, atsName);
  if (canonical && !greenhousePortalUrlNeedsBoardToken(canonical)) return canonical;
  return undefined;
}

export function greenhousePortalUrlNeedsBoardToken(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    return (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io' || host === 'job-boards.eu.greenhouse.io')
      && url.pathname === '/embed/job_app'
      && /^\d+$/.test(url.searchParams.get('token') ?? '')
      && !url.searchParams.get('for')
      && !url.searchParams.get('b');
  } catch {
    return false;
  }
}

export function portalApplicationUrl(portal: SupportedPortal, rawUrl: string): string {
  if (portal === 'greenhouse') return greenhouseEmbedApplicationUrl(rawUrl) ?? rawUrl;
  const url = new URL(rawUrl);
  if (portal === 'zoho_recruit' || portal === 'bullhorn' || portal === 'sap_successfactors') {
    return canonicalSupportedPortalUrl(rawUrl, portal) ?? rawUrl;
  }
  // Treat the platform's optional trailing slash as formatting, not another path segment. Without
  // this normalization, an already-canonical form URL received the same suffix a second time.
  const family = portalFamily(portal);
  if (family === 'ashby' || family === 'recruitee' || family === 'teamtailor'
    || family === 'personio' || family === 'pinpoint') {
    url.pathname = url.pathname.replace(/\/$/, '');
  }
  if (family === 'ashby' && !url.pathname.endsWith('/application')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/application`;
  }
  if (family === 'recruitee' && !url.pathname.endsWith('/c/new')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/c/new`;
  }
  if (family === 'workable' && /^\/(?:[^/]+\/)?j\/[^/]+\/?$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/apply`;
  }
  /* A Rippling posting URL (ats.rippling.com/<tenant>/jobs/<id>) is the JD page; the form lives at
   * /apply. Measured live 2026-08-19 on a real tenant: the runner navigated to the JD page, found
   * no controls, and parked with "did not record an email field / a resume upload / the applicant
   * name fields". The 2026-07-29 capture that built this adapter was itself taken at
   * .../jobs/<id>/apply, so the suffix is the family's own form address, not a guess. Bounded to
   * the two-segment posting shape so an already-canonical /apply URL, or any deeper path, passes
   * through unchanged. */
  if (family === 'rippling' && /^\/[^/]+\/jobs\/[^/]+\/?$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/apply`;
  }
  /* Breezy has the same posting-vs-form split: the 2026-07-29 capture behind its adapter was taken
   * at <tenant>.breezy.hr/p/<slug>/apply, and a run sent to the bare /p/<slug> JD page parked with
   * "could not confirm it reached this company's application form", measured live 2026-08-19.
   * Bounded to the one-segment /p/<slug> posting shape for the same reason as Rippling above. */
  if (family === 'breezy' && /^\/p\/[^/]+\/?$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/apply`;
  }
  /* Lever has the same posting-vs-form split: jobs.lever.co/<tenant>/<posting-uuid> is the JD page
   * whose only affordance is an "Apply for this job" link, and the form lives at /apply. Measured
   * live 2026-08-20 on a real tenant: the runner sent to the bare posting page filled nothing and
   * parked with "could not confirm it reached this company's application form". Every prior Lever
   * send on this account went through the extension path, so the managed runner had never
   * exercised this URL shape. Bounded to the tenant-plus-uuid posting shape so an already-canonical
   * /apply URL, a board root, or any deeper path passes through unchanged. */
  if (family === 'lever' && /^\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/?$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/apply`;
  }
  if (family === 'personio' && url.hostname.toLowerCase() !== 'arteus-energy.jobs.personio.de'
    && !url.pathname.endsWith('/apply')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/apply`;
  }
  if ((family === 'teamtailor' || family === 'pinpoint') && !url.pathname.endsWith('/applications/new')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/applications/new`;
  }
  if (family === 'jobvite' && !url.pathname.endsWith('/apply')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/apply`;
  }
  if (family === 'icims' && /\/job\/?$/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/job\/?$/i, '/login');
  }
  return url.toString();
}

// SmartRecruiters' job-posting URL (jobs.smartrecruiters.com/{Company}/{jobId}-{slug}) is a JD
// page only - the actual form lives at a SEPARATE URL
// (oneclick-ui/company/{Company}/publication/{uuid}) behind an "I'm interested" link, and that
// uuid is unrelated to the jobId, so it cannot be derived the way portalApplicationUrl() derives
// Ashby's /application suffix. It has to be found on the live page. Confirmed live, 2026-07-24, on
// a real Western Digital posting. A no-op on every other portal, and a no-op on SmartRecruiters
// once already on the form (the selector simply won't match).
const SMARTRECRUITERS_APPLY_LINK_SELECTOR =
  'a[href^="/oneclick-ui/company/"][href*="/publication/"], a[href^="https://jobs.smartrecruiters.com/oneclick-ui/company/"][href*="/publication/"]';

export async function navigateToApplicationForm(page: Page, portal: SupportedPortal): Promise<void> {
  if (portalFamily(portal) === 'workable') {
    const currentUrl = page.url();
    const destination = portalApplicationUrl(portal, currentUrl);
    if (destination !== currentUrl && detectPortal(destination) === 'workable') {
      await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    const declineOptionalCookies = page.locator(WORKABLE_DECLINE_OPTIONAL_COOKIES_SELECTOR).first();
    if ((await declineOptionalCookies.count()) > 0
      && (await declineOptionalCookies.isVisible().catch(() => false))) {
      await declineOptionalCookies.click().catch(() => undefined);
    }
    await page.locator(WORKABLE_APPLICATION_FORM_READY_SELECTOR).first()
      .waitFor({ state: 'attached', timeout: MANAGED_FILL_TIMEOUT_MS })
      .catch(() => undefined);
    return;
  }
  if (portal !== 'smartrecruiters') return;
  const link = page.locator(SMARTRECRUITERS_APPLY_LINK_SELECTOR).first();
  if ((await link.count()) === 0) return; // already on the form, or the link isn't there this time
  const href = await link.getAttribute('href');
  if (!href) return;
  const destination = new URL(href, page.url()).toString();
  // The selector is narrow, and this validation is the second boundary. It prevents a tenant DOM
  // change from turning a similarly named link into an arbitrary navigation in a managed run.
  if (detectPortal(destination) !== 'smartrecruiters' || !isSmartRecruitersOneClickUrl(new URL(destination))) return;
  await page.goto(destination, { waitUntil: 'domcontentloaded', timeout: 30_000 });
}

/* The phone field is the one field whose value cannot be decided before the page is in front of us.
 * Everything else is a straight fillFirst; this one has to find the control first, ask the control's
 * own group what dial code it is already showing, and only then work out what to write. Hence a
 * writer of its own rather than a value computed at the call site. */
async function fillPhoneField(
  page: Page,
  selectors: string[],
  portal: SupportedPortal,
  phone: string | undefined,
  label: string,
  out: string[],
) {
  if (!phone) return;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) === 0 || !(await field.isVisible().catch(() => false))) continue;
    // A page that will not answer is treated as a page with no country control, which is the answer
    // that leaves the number whole.
    const dialCodes = await field.evaluate(readFieldGroupDialCodes).catch(() => [] as string[]);
    const value = phoneForPortalField(portal, phone, dialCodes);
    if (!value) return;
    await field.fill(value);
    out.push(label);
    return;
  }
}

async function fillFirst(page: Page, selectors: string[], value: string | undefined, label: string, out: string[]) {
  if (!value) return;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
      await field.fill(value);
      out.push(label);
      return;
    }
  }
}

async function fillComboboxFirst(page: Page, selectors: string[], value: string | undefined, label: string, out: string[]) {
  if (!value) return;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
      await field.fill(value);
      await field.press('Enter').catch(() => undefined);
      out.push(label);
      return;
    }
  }
}

async function hiddenWorkableCityValue(page: Page): Promise<string> {
  const cities = page.locator('input[name="city"]');
  for (let index = 0; index < (await cities.count().catch(() => 0)); index += 1) {
    const city = cities.nth(index);
    const type = (await city.getAttribute('type').catch(() => null))?.toLowerCase();
    const ariaHidden = (await city.getAttribute('aria-hidden').catch(() => null))?.toLowerCase();
    const visible = await city.isVisible().catch(() => false);
    if (type !== 'hidden' && ariaHidden !== 'true' && visible) continue;
    const value = await city.inputValue().catch(() => '');
    if (value.trim()) return value.trim();
  }
  return '';
}

function workableCityBackingMatches(backing: string, requested: string): boolean {
  const left = backing.replace(/\s+/g, ' ').trim().toLowerCase();
  const right = requested.replace(/\s+/g, ' ').trim().toLowerCase();
  return left === right || right.startsWith(`${left},`) || left.startsWith(`${right},`);
}

async function fillWorkableLocation(
  page: Page,
  value: string | undefined,
  out: string[],
): Promise<void> {
  if (!value) return;
  const address = await uniqueVisibleLocator(page.locator(WORKABLE_ADDRESS_SELECTOR));
  if (address) {
    const filled = await address.fill(value).then(() => true).catch(() => false);
    const pressed = filled && await address.press('Enter').then(() => true).catch(() => false);
    if (pressed) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        if (workableCityBackingMatches(await hiddenWorkableCityValue(page), value)) {
          out.push('location');
          return;
        }
        await waitForDirectWidget(page, 100);
      }
    }
    // Typed autocomplete search text is not an answer. Clear it before trying a real legacy field
    // or handing the unresolved required address back to the applicant.
    await address.fill('').catch(() => undefined);
  }

  const legacyCity = await uniqueVisibleLocator(page.locator(WORKABLE_LEGACY_CITY_SELECTOR));
  if (!legacyCity) return;
  if (!await legacyCity.fill(value).then(() => true).catch(() => false)) return;
  await legacyCity.press('Enter').catch(() => undefined);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const persisted = await legacyCity.inputValue().catch(() => '');
    if (persisted.trim().toLowerCase() === value.trim().toLowerCase()) {
      out.push('location');
      return;
    }
    await waitForDirectWidget(page, 50);
  }
}

async function fillWorkablePhone(
  page: Page,
  phone: string | undefined,
  out: string[],
): Promise<boolean> {
  if (!phone) return true;
  const plan = workablePhonePlan(phone);
  if (!plan) return false;

  // Give resume parsing and its contact-field autofill a bounded chance to settle before the final
  // write. The value is then sampled repeatedly, so a delayed rewrite is never reported as success.
  await waitForDirectWidget(page, 250);
  const field = await uniqueVisibleLocator(page.locator(WORKABLE_PHONE_SELECTOR));
  if (!field) return false;
  const failClosed = async () => {
    await field.fill('').catch(() => undefined);
    return false;
  };

  let countryTrigger: Locator | null = null;
  if (plan.country) {
    const cookieDialogs = page.locator(WORKABLE_COOKIE_DIALOG_SELECTOR);
    const cookieDialogCount = await cookieDialogs.count().catch(() => 0);
    if (cookieDialogCount > 0) {
      const cookieDialog = await uniqueVisibleLocator(cookieDialogs);
      const declineOptionalCookies = await uniqueVisibleLocator(
        page.locator(WORKABLE_FINAL_COOKIE_DECLINE_SELECTOR),
      );
      if (!cookieDialog || !declineOptionalCookies
        || !await declineOptionalCookies.click().then(() => true).catch(() => false)) {
        return failClosed();
      }
    }
    // Waiting on a body selector that can only match after both overlay nodes unmount is safe when
    // no cookie dialog appeared, and it fails closed if a lone backdrop or a stuck dialog remains.
    const cookieOverlayCleared = await page.locator(WORKABLE_COOKIE_OVERLAY_CLEARED_SELECTOR).first()
      .waitFor({ state: 'attached', timeout: MANAGED_FILL_TIMEOUT_MS })
      .then(() => true)
      .catch(() => false);
    if (!cookieOverlayCleared) return failClosed();

    countryTrigger = await uniqueVisibleLocator(page.locator(WORKABLE_PHONE_COUNTRY_TRIGGER_SELECTOR));
    if (!countryTrigger || !await countryTrigger.click().then(() => true).catch(() => false)) {
      return failClosed();
    }
    const countryOption = await uniqueVisibleLocator(page.locator(plan.country.optionSelector));
    if (!countryOption || !await countryOption.click().then(() => true).catch(() => false)) {
      await countryTrigger.press('Escape').catch(() => undefined);
      return failClosed();
    }
    let selected = false;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const renderedCountry = await locatorRenderedText(countryTrigger);
      if (renderedCountry.includes(plan.country.displayedDialCode)
        && digitsOnly(renderedCountry) === plan.country.dialCode) {
        selected = true;
        break;
      }
      await waitForDirectWidget(page, 50);
    }
    if (!selected) return failClosed();
  }

  if (!await field.fill(plan.fieldValue).then(() => true).catch(() => false)) return failClosed();
  for (let sample = 0; sample < 3; sample += 1) {
    if (sample > 0) await waitForDirectWidget(page, 600);
    const persisted = await field.inputValue().catch(() => '');
    const renderedCountry = countryTrigger ? await locatorRenderedText(countryTrigger) : '';
    const countryPersisted = !countryTrigger
      || (plan.country !== null
        && renderedCountry.includes(plan.country.displayedDialCode)
        && digitsOnly(renderedCountry) === plan.country.dialCode);
    if (digitsOnly(persisted) !== plan.expectedDigits || !countryPersisted) return failClosed();
  }
  out.push('phone');
  return true;
}

async function selectFirst(page: Page, selectors: string[], value: string | undefined, label: string, out: string[]) {
  if (!value) return;
  for (const selector of selectors) {
    const field = page.locator(selector).first();
    if ((await field.count()) === 0 || !(await field.isVisible().catch(() => false))) continue;
    const selected = await field.selectOption({ label: value }).catch(() => field.selectOption(value).catch(() => null));
    if (selected && selected.length > 0) {
      out.push(label);
      return;
    }
  }
}

async function fillGreenhouseDemographicAliases(page: Page, packet: SubmissionPacket, out: string[]) {
  const prefs = packet.eeoPrefs;
  if (!prefs) return;
  for (const item of GREENHOUSE_DEMOGRAPHIC_ALIASES) {
    const value = prefs[item.key]?.trim();
    if (!value) continue;
    for (const alias of item.aliases) {
      await selectFirst(
        page,
        greenhouseQuestionSelectSelectors(alias),
        value,
        `greenhouse_demographic:${alias.slice(0, 80)}`,
        out,
      );
    }
  }
}

/* setInputFiles REPLACES. That one fact is the whole reason this function has a ledger.
 *
 * Every document after the first is offered controls that an earlier one may already be holding, and
 * the old behaviour was to take the first match and overwrite it. On the seven families whose resume
 * input is not spelled "resume", that is what happened: the transcript landed in the resume's slot,
 * the resume was gone, out.push('transcript') recorded a success, and the application went to the
 * employer with a transcript where the resume should have been and no resume at all.
 *
 * So a control that is already claimed is skipped by node identity, and if skipping leaves this
 * document nowhere to go, it is NOT uploaded and a sentence naming the collision is recorded
 * instead. Losing a transcript loudly beats losing a resume silently, and there is no third option
 * available at this point in the run.
 *
 * Without a ledger this is exactly the function it was, including the first-match-per-selector rule
 * and the two quiet `continue`s. Only claimed controls are stepped over. */
async function uploadFirst(
  page: Page,
  selectors: string[],
  file: Buffer | undefined,
  fileName: string | undefined,
  label: DocumentUploadLabel,
  out: string[],
  ledger?: UploadClaimLedger,
) {
  if (!file || !fileName) return;
  let heldBy: DocumentUploadLabel | null = null;
  for (const selector of selectors) {
    const locator = page.locator(selector);
    const handles = ledger ? await locatorElementHandles(locator) : null;
    let chosen: ElementHandle | null = null;
    if (handles) {
      for (const handle of handles) {
        const holder = await uploadClaimHolder(handle, ledger!);
        if (holder) {
          heldBy ??= holder;
          continue;
        }
        chosen = handle;
        break;
      }
      // Every control this selector reaches already holds another document. Fail closed.
      if (!chosen) continue;
    } else if ((await locator.count()) === 0) continue;
    const field = (chosen ?? locator.first()) as {
      getAttribute(name: string): Promise<string | null>;
      setInputFiles(files: { name: string; mimeType: string; buffer: Buffer }): Promise<void>;
    };
    const type = await field.getAttribute('type').catch(() => null);
    if (type?.toLowerCase() !== 'file') continue;
    try {
      await field.setInputFiles({ name: fileName, mimeType: 'application/pdf', buffer: file });
      out.push(label);
      if (ledger) {
        const claimed = chosen ?? await locatorElementHandle(locator.first());
        if (claimed) ledger.claimed.push({ label, handle: claimed });
      }
      return;
    } catch {
      continue;
    }
  }
  if (heldBy) ledger?.conflicts.push(uploadControlConflictBlocker(label, heldBy));
}

function exactVisibleTextPattern(value: string): RegExp {
  return new RegExp(`^\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
}

/** Return one visible match, or null when the locator is absent or ambiguous. */
async function uniqueVisibleLocator(locator: Locator): Promise<Locator | null> {
  let found: Locator | null = null;
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    if (found) return null;
    found = candidate;
  }
  return found;
}

async function locatorRenderedText(locator: Locator): Promise<string> {
  const inner = await locator.innerText().catch(() => null);
  if (typeof inner === 'string') return inner;
  return await locator.textContent().catch(() => '') ?? '';
}

async function waitForDirectWidget(page: Page, milliseconds: number): Promise<void> {
  const wait = (page as Page & { waitForTimeout?: (timeout: number) => Promise<void> }).waitForTimeout;
  if (typeof wait === 'function') await wait.call(page, milliseconds).catch(() => undefined);
}

/**
 * Workable choice groups point at the exact question label with aria-labelledby. Resolve that
 * relationship in both directions and refuse duplicate text instead of borrowing a nearby group.
 */
async function exactWorkableQuestionGroup(page: Page, questionText: string): Promise<Locator | null> {
  const normalizedQuestion = normalizeReviewQuestionLabel(questionText).toLowerCase();
  const groups = page.locator(
    '[role="group"][aria-labelledby], [role="radiogroup"][aria-labelledby], fieldset[aria-labelledby]',
  );
  let found: Locator | null = null;
  for (let index = 0; index < (await groups.count().catch(() => 0)); index += 1) {
    const group = groups.nth(index);
    if (!(await group.isVisible().catch(() => false))) continue;
    const labelledBy = (await group.getAttribute('aria-labelledby').catch(() => null))?.trim();
    if (!labelledBy) continue;
    let labelMatches = false;
    for (const id of labelledBy.split(/\s+/).filter(Boolean)) {
      const label = await uniqueVisibleLocator(page.locator(`[id="${quoteAttr(id)}"]`));
      if (!label) continue;
      const normalizedLabel = normalizeReviewQuestionLabel(await locatorRenderedText(label)).toLowerCase();
      if (normalizedLabel === normalizedQuestion) {
        labelMatches = true;
        break;
      }
    }
    if (!labelMatches) continue;
    if (found) return null;
    found = group;
  }
  return found;
}

async function markWorkableChoiceUnconfirmed(group: Locator, active: boolean): Promise<boolean> {
  return group.evaluate((element, state) => {
    const node = element as unknown as {
      setAttribute(name: string, value: string): void;
      removeAttribute(name: string): void;
    };
    if (state.active) node.setAttribute(state.attribute, 'true');
    else node.removeAttribute(state.attribute);
  }, { attribute: WORKABLE_CHOICE_UNCONFIRMED_ATTR, active }).then(() => true).catch(() => false);
}

async function setDirectChoiceState(control: Locator, checked: boolean): Promise<boolean> {
  const current = await control.isChecked().catch(() => null);
  if (current === null) return false;
  if (current === checked) return true;
  if (checked) {
    await control.check().catch(() => control.click().catch(() => undefined));
  } else {
    await control.uncheck().catch(() => control.click().catch(() => undefined));
  }
  return await control.isChecked().catch(() => null) === checked;
}

async function restoreDirectChoiceStates(
  snapshots: ReadonlyArray<{ control: Locator; checked: boolean }>,
): Promise<boolean> {
  let restored = true;
  for (const snapshot of [...snapshots].reverse()) {
    if (!await setDirectChoiceState(snapshot.control, snapshot.checked)) restored = false;
  }
  return restored;
}

async function failClosedAfterChoiceMutation(
  snapshots: ReadonlyArray<{ control: Locator; checked: boolean }>,
): Promise<false> {
  if (!await restoreDirectChoiceStates(snapshots)) {
    throw new Error('Workable choice replay could not restore its previous selection state');
  }
  return false;
}

async function fillExactWorkableChoice(
  page: Page,
  questionText: string,
  answer: string,
  inputType: string,
): Promise<boolean> {
  const group = await exactWorkableQuestionGroup(page, questionText);
  if (!group) return false;
  // Mark the whole question unresolved before touching any option. The readiness gate treats this
  // marker as authoritative, so even a browser/provider failure that prevents rollback cannot turn
  // one checked peer into proof that the complete reviewed multi-select answer was applied.
  if (!await markWorkableChoiceUnconfirmed(group, true)) return false;
  const controls = group.locator(`input[type="${quoteAttr(inputType.toLowerCase())}"]`);
  const choices: Array<{ control: Locator; labels: string[] }> = [];
  for (let index = 0; index < (await controls.count().catch(() => 0)); index += 1) {
    const candidate = controls.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    const renderedLabels = await candidate.evaluate((element) => {
      const input = element as unknown as {
        labels?: ArrayLike<{ innerText?: string; textContent?: string | null }>;
        getAttribute(name: string): string | null;
      };
      const labels = Array.from(input.labels ?? []);
      const texts = labels.map((label) => (
        typeof label.innerText === 'string' ? label.innerText : (label.textContent ?? '')
      ));
      const ariaLabel = input.getAttribute('aria-label');
      if (ariaLabel) texts.push(ariaLabel);
      return texts;
    }).catch(() => [] as string[]);
    const labels = [...new Set(renderedLabels.map((label) => label.trim()).filter(Boolean))];
    if (labels.length > 0) choices.push({ control: candidate, labels });
  }
  const offered = choices.flatMap((choice) => choice.labels);
  const values = exactChoiceOptionValues(answer, offered);
  if (!values || (/^radio$/i.test(inputType) && values.length !== 1)) return false;

  const selected: Locator[] = [];
  for (const value of values) {
    const normalizedValue = normalizedChoiceOption(value);
    const matching = choices.filter((choice) => choice.labels.some(
      (label) => normalizedChoiceOption(label) === normalizedValue,
    ));
    if (matching.length !== 1 || selected.includes(matching[0].control)) return false;
    selected.push(matching[0].control);
  }

  const snapshots: Array<{ control: Locator; checked: boolean }> = [];
  for (const choice of choices) {
    const checked = await choice.control.isChecked().catch(() => null);
    if (checked === null) return false;
    snapshots.push({ control: choice.control, checked });
  }

  if (/^checkbox$/i.test(inputType)) {
    for (const choice of choices) {
      const shouldBeChecked = selected.includes(choice.control);
      if (!await setDirectChoiceState(choice.control, shouldBeChecked)) {
        return failClosedAfterChoiceMutation(snapshots);
      }
    }
  } else {
    if (!await setDirectChoiceState(selected[0], true)) {
      return failClosedAfterChoiceMutation(snapshots);
    }
  }

  for (const choice of choices) {
    const expected = selected.includes(choice.control);
    if (await choice.control.isChecked().catch(() => null) !== expected) {
      return failClosedAfterChoiceMutation(snapshots);
    }
  }
  // Clearing the marker is part of the commit. If the DOM cannot confirm that clear, the caller
  // reports no filled field and the readiness gate remains closed.
  return markWorkableChoiceUnconfirmed(group, false);
}

async function workableComboboxShowsSelection(
  page: Page,
  field: Locator,
  selectedOption: Locator,
  answer: string,
): Promise<boolean> {
  const normalizedAnswer = answer.trim().toLowerCase();
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // The option may unmount as soon as its click closes the menu. A detached row falls through to
    // the persistent field and widget checks in the same bounded polling pass.
    if ((await selectedOption.getAttribute('aria-selected', { timeout: 100 }).catch(() => null)) === 'true') return true;
    const fieldValues = [
      await field.inputValue().catch(() => ''),
      await field.getAttribute('aria-valuetext').catch(() => null),
    ];
    if (fieldValues.some((value) => value?.trim().toLowerCase() === normalizedAnswer)) return true;

    // Workable clears the readonly search input after a selection and renders the committed answer
    // beside it. Accept exactly one visible copy in this widget, excluding rows still in a menu.
    const widget = await uniqueVisibleLocator(
      field.locator('xpath=ancestor::*[@data-input-type="select"][1]'),
    );
    if (widget) {
      const displayed = widget.getByText(exactVisibleTextPattern(answer), { exact: true });
      let committedMatches = 0;
      for (let index = 0; index < (await displayed.count().catch(() => 0)); index += 1) {
        const candidate = displayed.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const isMenuOption = await candidate.evaluate((element) => Boolean(element.closest('[role="option"]')))
          .catch(() => true);
        if (!isMenuOption) committedMatches += 1;
      }
      if (committedMatches === 1) return true;
    }
    await waitForDirectWidget(page, 100);
  }
  return false;
}

/** Select one exact option from the listbox declared by this Workable combobox, then read it back. */
async function fillExactWorkableCombobox(
  page: Page,
  portalSelector: string,
  answer: string,
): Promise<boolean> {
  const field = await uniqueVisibleLocator(page.locator(portalSelector));
  if (!field || (await field.getAttribute('role').catch(() => null)) !== 'combobox') return false;
  const widget = await uniqueVisibleLocator(
    field.locator('xpath=ancestor::*[@data-input-type="select"][1]'),
  ) ?? field;
  if (!await markWorkableChoiceUnconfirmed(widget, true)) return false;
  if (!await field.click().then(() => true).catch(() => false)) return false;

  let declaredIds: string[] = [];
  for (let attempt = 0; attempt < 3 && declaredIds.length === 0; attempt += 1) {
    declaredIds = [
      await field.getAttribute('aria-controls').catch(() => null),
      await field.getAttribute('aria-owns').catch(() => null),
    ].flatMap((value) => value?.trim().split(/\s+/).filter(Boolean) ?? []);
    if (declaredIds.length === 0) await waitForDirectWidget(page, 100);
  }
  // Current Workable inputs and listboxes share this exact React-select id stem. It remains a
  // question-local fallback when the component has not exposed aria-controls yet.
  const fieldId = (await field.getAttribute('id').catch(() => null))?.trim();
  if (fieldId && /^input_QA_[A-Za-z0-9_-]+_input$/.test(fieldId)) {
    declaredIds.push(fieldId.replace(/_input$/, '_listbox'));
  }
  const uniqueIds = [...new Set(declaredIds)];
  const listboxSelector = uniqueIds.map((id) => `[id="${quoteAttr(id)}"][role="listbox"]`).join(', ');
  let listbox: Locator | null = null;
  for (let attempt = 0; listboxSelector && attempt < 4 && !listbox; attempt += 1) {
    listbox = await uniqueVisibleLocator(page.locator(listboxSelector));
    if (!listbox) await waitForDirectWidget(page, 100);
  }
  if (!listbox) {
    await field.press('Escape').catch(() => undefined);
    return false;
  }

  const options = listbox.getByRole('option', { name: exactVisibleTextPattern(answer), exact: true });
  let option: Locator | null = null;
  for (let attempt = 0; attempt < 4 && !option; attempt += 1) {
    option = await uniqueVisibleLocator(options);
    if (!option) await waitForDirectWidget(page, 100);
  }
  if (!option) {
    await field.press('Escape').catch(() => undefined);
    return false;
  }
  if (!await option.click().then(() => true).catch(() => false)) return false;
  if (!await workableComboboxShowsSelection(page, field, option, answer)) return false;
  // A pre-existing answer is not evidence that this exact reviewed option committed. The marker is
  // cleared only after bounded readback proves the requested value on the field or its widget.
  return markWorkableChoiceUnconfirmed(widget, false);
}

async function fillReviewedQuestions(page: Page, portal: SupportedPortal, packet: SubmissionPacket, out: string[]) {
  for (const item of packet.questions) {
    const answer = greenhouseReviewedQuestionAnswer(item, packet);
    if (!answer.trim()) continue;
    const questionText = normalizeReviewQuestionLabel(item.question);
    if (!questionText) continue;
    if (shouldSkipReviewedConsentQuestion(questionText)) continue;
    if (shouldSkipPortalConsentQuestion(portalFamily(portal), reviewedQuestionSafetyContext(item, packet))) continue;
    const portalSelector = durablePortalSelector(reviewQuestionPortalSelector(item));
    const portalInputType = reviewQuestionPortalInputType(item);
    if (/^(?:checkbox|radio)$/i.test(portalInputType ?? '')) {
      if (portalFamily(portal) === 'greenhouse') {
        for (const selector of greenhouseCheckboxOptionSelectors(questionText, answer)) {
          const field = page.locator(selector).first();
          if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
            await field.check();
            out.push(`question_checkbox:${questionText.slice(0, 80)}`);
            break;
          }
        }
      } else if (portalFamily(portal) === 'workable') {
        if (await fillExactWorkableChoice(page, questionText, answer, portalInputType!)) {
          out.push(`question_checkbox:${questionText.slice(0, 80)}`);
        }
      }
      continue;
    }
    if (/^combobox$/i.test(portalInputType ?? '') && portalFamily(portal) === 'workable') {
      if (portalSelector && await fillExactWorkableCombobox(page, portalSelector, answer)) {
        out.push(`question:${questionText.slice(0, 80)}`);
      }
      continue;
    }
    if (portalSelector) {
      const field = page.locator(portalSelector).first();
      if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
        await field.fill(answer);
        out.push(`question:${questionText.slice(0, 80)}`);
        continue;
      }
    }
    if (portalFamily(portal) === 'greenhouse' && isRoutineCandidatePrivacyAcknowledgement(questionText)) {
      for (const selector of greenhouseCheckboxOptionSelectors(questionText, answer)) {
        const field = page.locator(selector).first();
        if ((await field.count()) > 0 && (await field.isVisible().catch(() => false))) {
          await field.check().catch(() => field.click());
          out.push(`question_checkbox:${questionText.slice(0, 80)}`);
          break;
        }
      }
      continue;
    }
    const label = page.getByText(questionText, { exact: false }).first();
    if ((await label.count()) === 0) continue;
    const container = label.locator('xpath=ancestor::*[self::div or self::fieldset][1]');
    const input = container.locator('textarea, input:not([type=file]):not([type=hidden])').first();
    if ((await input.count()) > 0 && (await input.isVisible().catch(() => false))) {
      await input.fill(answer);
      out.push(`question:${questionText.slice(0, 80)}`);
      continue;
    }
    const select = container.locator('select').first();
    if ((await select.count()) > 0) {
      const candidates = isReferralSourceQuestion(questionText)
        ? referralSourceOptionCandidates(answer, packet.referralSourceEvidence)
        : [answer];
      let selected = false;
      for (const candidate of candidates) {
        selected = await select.selectOption({ label: candidate })
          .then(() => true)
          .catch(() => select.selectOption(candidate).then(() => true).catch(() => false));
        if (selected) break;
      }
      if (selected) out.push(`question:${questionText.slice(0, 80)}`);
      continue;
    }
    const answerPattern = new RegExp(`^\\s*${answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
    const choice = container.getByLabel(answerPattern).first();
    if ((await choice.count()) > 0 && (await choice.isVisible().catch(() => false))) {
      await choice.check().catch(() => choice.click());
      out.push(`question:${questionText.slice(0, 80)}`);
    }
  }
}

async function fillResolvedRequiredField(
  field: Locator,
  label: string,
  packet: SubmissionPacket,
  out: string[],
): Promise<boolean> {
  if (!packet.applicationProfile) return false;
  const tag = (await field.evaluate((el) => el.tagName).catch(() => '')).toLowerCase();
  const type = (await field.getAttribute('type').catch(() => null))?.toLowerCase() ?? (tag === 'textarea' ? 'textarea' : 'text');
  // Read the control's REAL options before deciding what to say. A select used to be handed the
  // profile's own phrasing and told to match it exactly, so a list offering "University of
  // Southern California" was asked for "University of Southern California, Viterbi School of
  // Engineering", matched nothing, and the field was then reported required-and-empty with the
  // answer sitting in the packet the whole time.
  const options = tag === 'select'
    ? await field.locator('option').allTextContents().catch(() => [] as string[])
    : [];
  const resolved = resolveProfileField(
    { label, inputType: tag === 'select' ? 'select' : type, options },
    packet.applicationProfile,
    packet.jdText,
    packet.roleCountry ?? postingCountryFromJobContext({ location: packet.roleLocation, locations: packet.roleLocations }),
    packet.roleCountryCode ?? postingCountryCodeFromJobContext({ location: packet.roleLocation, locations: packet.roleLocations }),
  );
  if (!resolved || !resolved.value.trim()) return false;
  const value = resolved.value.trim();
  try {
    if (tag === 'select') {
      // Try the whole ladder, best first. selectOption throws when nothing matches, so a failed
      // attempt costs one exception and the next alias still gets its turn; before this, one
      // miss ended the field.
      for (const candidate of [value, ...resolved.candidates]) {
        const selected = await field.selectOption({ label: candidate })
          .then(() => true)
          .catch(() => field.selectOption(candidate).then(() => true).catch(() => false));
        if (selected) {
          out.push(`required:${label.slice(0, 80)}`);
          return true;
        }
      }
      return false;
    }
    if (type === 'checkbox' || type === 'radio') {
      const wantsYes = /^(yes|true|i agree|agree|accepted?|confirm(?:ed)?|acknowledge(?:d)?)$/i.test(value);
      if (!wantsYes) return false;
      await field.check();
    } else {
      await field.fill(value);
    }
    out.push(`required:${label.slice(0, 80)}`);
    return true;
  } catch {
    return false;
  }
}

export function portalMayResolveUnknownRequired(portal: SupportedPortal): boolean {
  const family = portalFamily(portal);
  return family !== 'zoho_recruit' && family !== 'bullhorn' && family !== 'jazzhr'
    && family !== 'oracle_taleo' && family !== 'adp_recruiting' && family !== 'bamboohr';
}

export function portalUnknownRequiredBlocker(
  portal: SupportedPortal,
  label: string,
  type: string | null = null,
): string | null {
  return portalMayResolveUnknownRequired(portal) ? null : describeRequiredBlocker(label, { type });
}

export async function fillPortal(page: Page, portal: SupportedPortal, packet: SubmissionPacket): Promise<FillResult> {
  const filledFields: string[] = [];
  // Which control is holding which document, by DOM node. Threaded through every upload below so
  // that no second document can be given a control a first one already has. See UploadClaimLedger.
  const claims = newUploadClaimLedger();
  const family = portalFamily(portal);
  // Same stop as pushFixedFieldActions, and it has to be repeated here rather than inherited: these
  // are two independent paths to the same portals (managed runner vs direct Playwright), and the
  // 2026-07-28 review caught exactly this kind of gate existing on one path and not the other.
  // The blocker is the reason, in the student's words, so the card explains itself.
  if (ACCOUNT_WALLED_FAMILIES.has(family)) {
    return { filledFields, blockers: [portalHandoffReason(portal)!] };
  }
  if (family === 'greenhouse') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, GREENHOUSE_FIRST_NAME_SELECTOR.split(', '), parts[0], 'first_name', filledFields);
    await fillFirst(page, GREENHOUSE_LAST_NAME_SELECTOR.split(', '), parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, GREENHOUSE_EMAIL_SELECTOR.split(', '), packet.email, 'email', filledFields);
    await fillComboboxFirst(page, ['#country'], countryForPhoneField(packet.phone, packet.country), 'phone_country', filledFields);
    await fillPhoneField(page, GREENHOUSE_PHONE_SELECTOR.split(', '), portal, packet.phone, 'phone', filledFields);
    await fillComboboxFirst(page, ['#candidate-location', 'input[autocomplete="address-level2"]'], greenhouseLocationSearch(packet), 'location', filledFields);
    await uploadFirst(page, GREENHOUSE_RESUME_SELECTOR.split(', '), packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, ['input#cover_letter[type="file"]', 'input[type="file"][name*="cover_letter" i]'], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
    await fillGreenhouseDemographicAliases(page, packet, filledFields);
  } else if (family === 'lever') {
    await fillFirst(page, ['input[name="name"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="phone"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="urls[LinkedIn]"]'], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ['input[name="urls[GitHub]"]'], packet.githubUrl, 'github', filledFields);
    await fillFirst(page, ['input[name="urls[Portfolio]"]'], packet.portfolioUrl, 'portfolio', filledFields);
    await uploadFirst(page, [LEVER_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, ['input[type="file"][name*="cover" i]'], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  } else if (family === 'smartrecruiters') {
    const parts = packet.fullName.trim().split(/\s+/);
    const controlled = portal === 'controlled_smartrecruiters';
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_FIRST_NAME_SELECTOR : SMARTRECRUITERS_FIRST_NAME_SELECTOR], parts[0], 'first_name', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_LAST_NAME_SELECTOR : SMARTRECRUITERS_LAST_NAME_SELECTOR], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_EMAIL_SELECTOR : SMARTRECRUITERS_EMAIL_SELECTOR], packet.email, 'email', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR : SMARTRECRUITERS_CONFIRM_EMAIL_SELECTOR], packet.email, 'confirm_email', filledFields);
    await fillPhoneField(page, [controlled ? CONTROLLED_SMARTRECRUITERS_PHONE_SELECTOR : SMARTRECRUITERS_PHONE_SELECTOR], portal, packet.phone, 'phone', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_LINKEDIN_SELECTOR : SMARTRECRUITERS_LINKEDIN_SELECTOR], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, [controlled ? CONTROLLED_SMARTRECRUITERS_WEBSITE_SELECTOR : SMARTRECRUITERS_WEBSITE_SELECTOR], packet.portfolioUrl ?? packet.githubUrl, 'portfolio', filledFields);
    await uploadFirst(page, [SMARTRECRUITERS_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    // The direct Playwright path has its own reviewed-question and required-field writers below.
    // Stop before both. SmartRecruiters is proven only for these exact first-page selectors, and a
    // packet selector or generic required field must never expand that trust boundary.
    const blockers = [portalHandoffReason(portal)!];
    if (await hasUnresolvedCaptcha(page)) blockers.push(CAPTCHA_BLOCKER);
    return { filledFields, blockers };
  } else if (family === 'workable') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="firstname"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="lastname"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="email"]'], packet.email, 'email', filledFields);
    await fillWorkableLocation(page, packet.city, filledFields);
    await uploadFirst(page, [WORKABLE_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, WORKABLE_COVER_LETTER_SELECTOR.split(', '), packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  } else if (family === 'jazzhr') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="resumator-firstname-value"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="resumator-lastname-value"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="resumator-email-value"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="resumator-phone-value"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="resumator-city-value"]'], packet.city, 'location', filledFields);
    await fillFirst(page, ['input[name="resumator-linkedin-value"]'], packet.linkedinUrl, 'linkedin', filledFields);
    await uploadFirst(page, [JAZZHR_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    const blockers = [portalHandoffReason(portal)!];
    if (await hasUnresolvedCaptcha(page)) blockers.push(CAPTCHA_BLOCKER);
    return { filledFields, blockers };
  } else if (family === 'paylocity') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, [paylocityId('info.firstName')], parts[0], 'first_name', filledFields);
    await fillFirst(page, [paylocityId('info.lastName')], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, [paylocityId('info.email')], packet.email, 'email', filledFields);
    await fillFirst(page, [paylocityId('info.cellPhone')], packet.phone, 'phone', filledFields);
    await fillFirst(page, [paylocityId('info.linkedIn')], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ['#public-site-address-city'], packet.city, 'location', filledFields);
    await uploadFirst(page, [PAYLOCITY_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, [PAYLOCITY_COVER_LETTER_SELECTOR], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  } else if (family === 'rippling') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['[data-testid="input-first_name"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['[data-testid="input-last_name"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['[data-testid="input-email"]'], packet.email, 'email', filledFields);
    await fillPhoneField(page, ['[data-testid="input-phone_number"]'], portal, packet.phone, 'phone', filledFields);
    await uploadFirst(page, [RIPPLING_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, [RIPPLING_COVER_LETTER_SELECTOR], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  } else if (family === 'breezy') {
    await fillFirst(page, ['input[name="cName"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="cEmail"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="cPhoneNumber"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="cAddress"]'], packet.city, 'location', filledFields);
    await uploadFirst(page, [BREEZY_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
  } else if (family === 'bamboohr') {
    // Unlike the managed path this one CAN branch, so the button is clicked only when it is there.
    const opener = page.locator(BAMBOOHR_OPEN_FORM_SELECTOR).first();
    if ((await opener.count()) > 0 && (await opener.isVisible().catch(() => false))) {
      await opener.click().catch(() => undefined);
      // Wait for the FIELD, not for the network. The form mounts client-side with no navigation and
      // often no request at all, so waitForLoadState('networkidle') can resolve instantly and let
      // every fill below race a form that is not in the DOM yet - which looks exactly like a bad
      // selector when it fails.
      await page.locator('input[name="firstName"]')
        .waitFor({ state: 'attached', timeout: MANAGED_FILL_TIMEOUT_MS })
        .catch(() => undefined);
    }
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="firstName"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="lastName"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="phone"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="city.value"]'], packet.city, 'location', filledFields);
    await fillFirst(page, ['input[name="linkedinUrl"]'], packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ['input[name="websiteUrl"]'], packet.portfolioUrl ?? packet.githubUrl, 'portfolio', filledFields);
    await uploadFirst(page, [BAMBOOHR_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
  } else if (family === 'recruitee') {
    await fillFirst(page, ['input[name="candidate.name"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="candidate.email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="candidate.phone"]'], packet.phone, 'phone', filledFields);
    await uploadFirst(page, [RECRUITEE_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, [RECRUITEE_COVER_LETTER_SELECTOR], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  } else if (family === 'teamtailor') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="candidate[first_name]"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="candidate[last_name]"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="candidate[email]"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="candidate[phone]"]'], packet.phone, 'phone', filledFields);
    await uploadFirst(page, [TEAMTAILOR_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, [TEAMTAILOR_COVER_LETTER_SELECTOR], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  } else if (family === 'personio') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="first_name"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="last_name"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="phone"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="location"]'], packet.city, 'location', filledFields);
    await fillFirst(page, ['input[name="public_profile"]'], packet.linkedinUrl ?? packet.portfolioUrl, 'public_profile', filledFields);
    await uploadFirst(page, [PERSONIO_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, [PERSONIO_COVER_LETTER_SELECTOR], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  } else if (family === 'pinpoint') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="application_form[application][first_name]"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="application_form[application][last_name]"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="application_form[application][email]"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="application_form[application][phone]"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="application_form[application][town]"]'], packet.city, 'location', filledFields);
    await fillFirst(page, ['input[name="application_form[application][linkedin_url]"][type="text"]'], packet.linkedinUrl, 'linkedin', filledFields);
    await uploadFirst(page, [PINPOINT_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, [PINPOINT_COVER_LETTER_SELECTOR], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  } else if (family === 'comeet') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="firstName"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="lastName"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="phone"]'], packet.phone, 'phone', filledFields);
    await fillFirst(page, ['input[name="websiteUrl"]'], packet.portfolioUrl ?? packet.linkedinUrl ?? packet.githubUrl, 'portfolio', filledFields);
    await uploadFirst(page, [COMEET_RESUME_SELECTOR], packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, [COMEET_COVER_LETTER_SELECTOR], packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  } else if (family === 'zoho_recruit') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[name="First_Name"]', 'input[name="firstName"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[name="Last_Name"]', 'input[name="lastName"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[name="Email"]', 'input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[name="Phone"]', 'input[name="phone"]'], packet.phone, 'phone', filledFields);
    await uploadFirst(page, ZOHO_RECRUIT_RESUME_SELECTOR.split(', '), packet.resume, packet.resumeName, 'resume', filledFields, claims);
  } else if (family === 'bullhorn') {
    const parts = packet.fullName.trim().split(/\s+/);
    await fillFirst(page, ['input[formcontrolname="firstName"]', 'input[name="firstName"]'], parts[0], 'first_name', filledFields);
    await fillFirst(page, ['input[formcontrolname="lastName"]', 'input[name="lastName"]'], parts.slice(1).join(' '), 'last_name', filledFields);
    await fillFirst(page, ['input[formcontrolname="email"]', 'input[name="email"]'], packet.email, 'email', filledFields);
    await fillFirst(page, ['input[formcontrolname="phone"]', 'input[name="phone"]'], packet.phone, 'phone', filledFields);
    await uploadFirst(page, BULLHORN_RESUME_SELECTOR.split(', '), packet.resume, packet.resumeName, 'resume', filledFields, claims);
  } else if (family === 'sap_successfactors') {
    // The public job page transitions into an account wall. No identity or credential is entered.
  } else {
    await fillFirst(page, ['input[name="_systemfield_name"]'], packet.fullName, 'name', filledFields);
    await fillFirst(page, ['input[name="_systemfield_email"]'], packet.email, 'email', filledFields);
    await fillPhoneField(page, ASHBY_PHONE_SELECTOR.split(', '), portal, packet.phone, 'phone', filledFields);
    await fillComboboxFirst(page, ASHBY_LOCATION_SELECTOR.split(', '), packet.city, 'location', filledFields);
    // See ASHBY_*_SELECTOR: these were missing from the direct path too, so a real Ashby run
    // reported LinkedIn as an empty required field even though the packet had it.
    await fillFirst(page, ASHBY_LINKEDIN_SELECTOR.split(', '), packet.linkedinUrl, 'linkedin', filledFields);
    await fillFirst(page, ASHBY_GITHUB_SELECTOR.split(', '), packet.githubUrl, 'github', filledFields);
    await fillFirst(page, ASHBY_PORTFOLIO_SELECTOR.split(', '), packet.portfolioUrl, 'portfolio', filledFields);
    await uploadFirst(page, ASHBY_RESUME_SELECTOR.split(', '), packet.resume, packet.resumeName, 'resume', filledFields, claims);
    await uploadFirst(page, ASHBY_COVER_LETTER_SELECTOR.split(', '), packet.coverLetter, packet.coverLetterName, 'cover_letter', filledFields, claims);
  }
  /* The direct-Playwright twin of the transcript upload in pushFixedFieldActions, and it sits here
   * for the same two reasons: after every family's own uploads, because uploadFirst is
   * first-match-wins and the resume selectors are the broad ones; and after the account-walled
   * return at the top of this function, because those families reach no form to upload to.
   *
   * The families that return early inside the chain above - SmartRecruiters and JazzHR - never reach
   * this line, and both carry the never-match sentinel anyway, so the two answers agree.
   *
   * ORDER IS NO LONGER THE PROTECTION, and that is the point of the reservation immediately below.
   * Running last only helps if the last upload can tell which control the earlier ones took, and for
   * seven families it could not. The reservation states it: the family's own resume and cover-letter
   * controls are claimed by identity before the transcript is offered anything, whether or not those
   * uploads happened or even had a file to place. uploadFirst has already claimed the exact controls
   * it used; this covers the run that carried no resume, or whose resume upload failed, where the
   * transcript would otherwise be free to occupy the slot the employer reads as the resume. */
  if (portalMayAttachTranscript(portal) && packet.transcript && packet.transcriptName) {
    await reserveUploadControls(page, elementIdentifyingSelectorArms(resumeUploadSelector(portal)), 'resume', claims);
    await reserveUploadControls(
      page,
      elementIdentifyingSelectorArms(coverLetterUploadSelector(portal)),
      'cover_letter',
      claims,
    );
    /* IDENTITY FIRST, THE DERIVED SELECTOR ONLY WHEN THERE IS NO IDENTITY TO BE HAD.
     *
     * The two guards are not equal in strength. transcriptUploadSelector subtracts the family's
     * element-identifying resume and cover-letter arms, which is everything the reservation above
     * claims; the ledger claims that same set AND the exact control each upload really used, which
     * a text-scoped arm can reach and a subtraction cannot express. So where identity works it is
     * the whole answer, and running the base arms through it means a collision is SEEN rather than
     * quietly selected away: the run can then say which document is in the way instead of reporting
     * a transcript that matched nothing. Where identity is unavailable the derived selector is what
     * is left, and it is still far stronger than the spelled exclusion it replaced. */
    const transcriptSelectors = pageSupportsElementIdentity(page)
      ? TRANSCRIPT_UPLOAD_SELECTOR.split(', ')
      : transcriptUploadSelector(portal).split(', ');
    await uploadFirst(
      page,
      transcriptSelectors,
      packet.transcript,
      packet.transcriptName,
      'transcript',
      filledFields,
      claims,
    );
  }
  if (family !== 'zoho_recruit' && family !== 'bullhorn' && family !== 'bamboohr') {
    await fillReviewedQuestions(page, portal, packet, filledFields);
  }

  const blockers: string[] = [];
  /* A document that was NOT uploaded because its only control already held another one. First,
   * because it is the sentence that explains an application she will otherwise read as complete,
   * and because it is the whole justification for the upload having been skipped. */
  blockers.push(...claims.conflicts);
  if (CONSENT_GATED_FAMILIES.has(family) || ACCOUNT_WALLED_FAMILIES.has(family) || family === 'zoho_recruit' || family === 'bullhorn') {
    blockers.push(portalHandoffReason(portal)!);
  }
  // String kept verbatim: it is already surfaced to applicants and matched downstream.
  if (await hasUnresolvedCaptcha(page)) {
    blockers.push(CAPTCHA_BLOCKER);
  }
  const required = page.locator('input[required], textarea[required], select[required]');
  const labelledBlockers: string[] = [];
  let unlabelledCount = 0;
  for (let index = 0; index < (await required.count()); index += 1) {
    const field = required.nth(index);
    if (!(await field.isVisible().catch(() => false))) continue;
    const type = (await field.getAttribute('type'))?.toLowerCase() ?? null;
    if (type === 'hidden') continue;
    // Workable phone is owned by the exact widget handler below. Leave it out of the generic
    // fallback so every other required-field mutation runs first, then select, refill, and verify
    // phone against the final DOM rather than a state a later City or address handler can rewrite.
    if (family === 'workable'
      && type === 'tel'
      && (await field.getAttribute('name').catch(() => null)) === 'phone'
      && workablePhonePlan(packet.phone)) {
      continue;
    }
    if (type === 'checkbox' || type === 'radio') {
      if (await field.isChecked().catch(() => false)) continue;
    } else {
      const value = await field.inputValue().catch(() => '');
      if (value) continue;
    }

    const label = await resolveFieldLabel(page, field);
    const forcedBlocker = label ? portalUnknownRequiredBlocker(portal, label, type) : null;
    if (forcedBlocker) {
      labelledBlockers.push(forcedBlocker);
      continue;
    }
    const mayResolveUnknownRequired = portalMayResolveUnknownRequired(portal);
    if (mayResolveUnknownRequired && label && await fillResolvedRequiredField(field, label, packet, filledFields)) continue;
    if (label) labelledBlockers.push(describeRequiredBlocker(label, { type }));
    else unlabelledCount += 1;
  }

  // This is the final form mutation on Workable. Resume parsing, reviewed answers, and the generic
  // required-field fallback above have all finished before country selection and the stable reads.
  if (family === 'workable' && !await fillWorkablePhone(page, packet.phone, filledFields)) {
    labelledBlockers.push(
      describeRequiredBlocker(workablePhoneBlockerLabel(packet.phone), { type: 'tel' }),
    );
  }

  // Deliberately NOT deduped together with the labelled lines. Every unlabelled field produces the
  // identical sentence, so a plain Set collapsed five distinct blocked fields into one: the student
  // would fix the one thing named, resubmit, and fail again with no new information. Labelled lines
  // still dedupe, because two fields sharing a label really are one thing to fix.
  blockers.push(...new Set(labelledBlockers));
  if (unlabelledCount > 0) blockers.push(describeUnlabelledBlockers(unlabelledCount));
  return { filledFields, blockers };
}

// ---- human-verification (CAPTCHA) detection ----
//
// Litos NEVER solves a challenge and never sends one anywhere to be solved. These functions only
// answer "is a human being asked to do something here", so the run can stop, keep what it filled,
// and hand the page back to the person whose application it is. `solveCaptchas: false` in
// browserbase.ts is the other half of that promise and there is a test pinning it.
//
// The check this replaced counted `iframe[src*=captcha], [class*=captcha], [id*=captcha]` and
// called any hit a blocker. That is wrong in both directions. reCAPTCHA v2 ALWAYS ships a
// `g-recaptcha-response` textarea, solved or not, so the old check called every reCAPTCHA page
// blocked forever; and it could not tell a widget the person already cleared from one still
// waiting. Token state is what distinguishes them: an empty response field under a rendered
// widget means a human still has to act.

// Widget count is deliberately NOT compared to token count. Providers render a variable number of
// visible nodes per widget (wrapper div, anchor iframe, and on Turnstile a shadow host), so
// "3 visible nodes, 1 token" is one solved widget, not two missing ones. The honest signal is:
// something is rendered, and at least one response field is still empty.
export function captchaSnapshotRequiresAttention(responseTokens: string[], visibleChallengeCount: number): boolean {
  if (visibleChallengeCount === 0) return false;
  if (responseTokens.length === 0) return true;
  return responseTokens.some((token) => token.trim().length === 0);
}

export const CAPTCHA_RESPONSE_SELECTOR = [
  'textarea[name*="captcha-response" i]',
  'input[name*="captcha-response" i]',
  'textarea[id*="captcha-response" i]',
  'input[id*="captcha-response" i]',
  'textarea[name="cf-turnstile-response"]',
  'input[name="cf-turnstile-response"]',
].join(', ');

// One source, two consumers. The direct path joins these as-is; the managed path maps the same
// parts through a CSS badge exclusion. Adding a sixth shape here reaches both, which a duplicated
// literal did not.
const CAPTCHA_CHALLENGE_SELECTOR_PARTS = [
  'iframe[src*="captcha" i]',
  'iframe[src*="challenges.cloudflare.com" i]',
  '[class*="captcha" i]',
  '[id*="captcha" i]',
  '[data-sitekey]',
];

export const CAPTCHA_CHALLENGE_SELECTOR = CAPTCHA_CHALLENGE_SELECTOR_PARTS.join(', ');

// reCAPTCHA v3 and invisible v2 render a floating "protected by reCAPTCHA" badge on pages that ask
// the human for NOTHING - the score is computed from behaviour and the token is minted on submit.
// The badge matches [class*="captcha"] and is genuinely visible, so counting it stops a page that
// was never blocked, on exactly the two families already typed as CAPTCHA-gated. Measured on
// BambooHR 2026-07-29: badge present, window.grecaptcha defined, no interactive widget.
//
// Matched with closest(), NOT a self-or-descendant check. The badge is a CONTAINER: `div.grecaptcha-badge`
// wraps an anchor `<iframe src=".../recaptcha/api2/anchor...">`, and that iframe matches
// `iframe[src*="captcha" i]` on its own. A self check misses it (its own class list is not the
// badge's) and a descendant check misses it too (it contains no badge). It would have been counted,
// so a v3 page would still have reported blocked - the exact false positive this exclusion exists to
// remove. closest() covers the badge node and everything inside it in one probe.
//
// Excluding it means a v3 page reports "not blocked", which is correct: there is no challenge for a
// human to clear. If v3 scores the session badly it escalates to a real interactive widget, and
// THAT widget is rendered outside the badge, so closest() returns null and it is counted normally.
const CAPTCHA_BADGE_CLASS = 'grecaptcha-badge';

// Same discipline, and the same reason, as LABEL_PROBE_TIMEOUT_MS below: locator actions AUTO-WAIT
// at 30s by default, this cost is paid once per candidate node, and every probe here is wrapped in
// a swallowing catch - so an unbounded stall would burn the run's whole budget and leave no trace of
// why. isVisible() and count() do not auto-wait; inputValue() and evaluate() do, so they are bounded.
const CAPTCHA_PROBE_TIMEOUT_MS = 750;

// A page whose CSS framework happens to use "captcha" in a utility class can match this selector
// dozens of times. The probe is per-node, so cap the scan: past ~20 candidates the page is telling
// us about its class names, not about a challenge.
const CAPTCHA_MAX_CANDIDATE_NODES = 20;

// The managed path asks a DIFFERENT question than the direct path, and the difference is the point.
//
// The direct path asks "is a challenge still waiting?", because a human may be sitting in front of
// it. The managed path is unattended by definition - the run happens inside a remote browser nobody
// is watching - so the only question worth asking there is "is there an interactive challenge on
// this page at all?". If there is, auto-submitting is wrong whatever the token says, because nobody
// is present to clear it. Presence is therefore the whole rule here.
//
// That difference is what lets this probe avoid the token entirely, which matters three ways:
//   1. Litos never handles a challenge token it does not have to. Asking a third-party runner to
//      read one and hand it back would move the token out of the applicant's session and into our
//      infrastructure for no gain, which is the boundary this feature exists to respect.
//   2. `g-recaptcha-response` is a <textarea>, which has no `value` ATTRIBUTE at all - the token
//      lives in the DOM property. An attribute read returns null on a solved widget, so a cleared
//      challenge would have read as unsolved and blocked a legitimate submission.
//   3. data-sitekey is present on every node this now matches, so a match cannot be silently
//      discarded as null the way an attribute-that-is-usually-absent would be.
//
// Narrower than the direct path on purpose: [data-sitekey] is the container reCAPTCHA v2 explicit,
// hCaptcha and Turnstile all render, and it is absent on a pure v3 page, which is exactly the page
// that must NOT be stopped. It will miss shapes the direct path catches. A narrow signal that is
// always right beats a broad one that misfires in both directions.
const MANAGED_CAPTCHA_CHALLENGE_SELECTOR = '[data-sitekey]:not(.grecaptcha-badge):not(.grecaptcha-badge *)';

// The three extra reads that tell an INVISIBLE reCAPTCHA apart from a real one, measured against the
// live Akuna Greenhouse page on 2026-08-08. That page carries `grecaptcha`, a `g-recaptcha-response`
// textarea and an anchor iframe, and asks a human for nothing: the anchor is `size=invisible`, every
// captcha-matching node sits inside `.grecaptcha-badge`, and there is no bframe. A person filling
// that form by hand clicks Submit and never sees a challenge.
//
// The bframe is the load-bearing one. reCAPTCHA renders the image-grid popup in a SECOND iframe
// whose src contains `bframe`; the anchor iframe is only the checkbox-or-badge. So "anchor present"
// means a widget is wired up, and "bframe present" means a human is actually being asked something.
// Read as an attribute, not a count, because the runner's extract contract returns attribute values
// and `src` is present on every iframe it can match.
const MANAGED_CAPTCHA_SIZE_SELECTOR = '[data-sitekey][data-size]:not(.grecaptcha-badge):not(.grecaptcha-badge *)';
/*
 * THE BADGE EXCLUSION IS STRUCTURAL, and it used to be missing here while every other selector in
 * this block carried it.
 *
 * reCAPTCHA v3 and invisible v2 mount their anchor iframe INSIDE `.grecaptcha-badge`, so this
 * selector matched it on essentially every Greenhouse and Ashby posting. Measured on 2026-08-12
 * across 30 live postings: 24 of them carry exactly that badge and nothing else, and the only thing
 * holding the managed predicate at "no challenge" on all 24 was ANCHOR_DECLARES_INVISIBLE_RE reading
 * the literal `&size=invisible` out of Google's own query string.
 *
 * That is a formatting detail of a third party's URL, not a contract with anyone. Rename the
 * parameter, drop it, or move the widget to a host that omits it, and 24 postings become "CAPTCHA
 * requires your attention" in one step, with the applicant asked to finish by hand what nothing on
 * the page was ever going to ask her. WHERE THE NODE SITS is the durable fact: an iframe inside the
 * badge is the badge, whatever its src happens to spell today. The regex stays as the second line
 * for an invisible anchor mounted outside a badge, where position cannot answer.
 */
const MANAGED_CAPTCHA_ANCHOR_SELECTOR = 'iframe[src*="/recaptcha/"][src*="anchor"]:not(.grecaptcha-badge *)';
const MANAGED_CAPTCHA_BFRAME_SELECTOR = 'iframe[src*="/recaptcha/"][src*="bframe"]';

// The read that makes the invisible finding belong to a WIDGET instead of to the page.
//
// Every other read here is a page-aggregate: "is a size of invisible declared anywhere", "is a
// sitekey present anywhere". Two widgets on one page collapse into those same four scalars, and
// the invisible one then cancels the real one standing beside it. Measured: a page reporting
// `captcha_size: invisible` and `captcha_challenge: 6LcRealVisibleWidget` was waved through with an
// unsolved sitekey on it, because "something here is invisible" was allowed to answer "is anything
// here asking a human".
//
// This reads the SITEKEY OF THE INVISIBLE WIDGET, so an invisible finding can only ever cancel the
// widget it actually came from. It is the same node set as the size read, narrowed to the invisible
// value and asked for its identity rather than its size, so it costs one more optional extract and
// no extra page load.
const MANAGED_CAPTCHA_INVISIBLE_SITEKEY_SELECTOR =
  '[data-sitekey][data-size="invisible" i]:not(.grecaptcha-badge):not(.grecaptcha-badge *)';

// The same question asked from the other side, and the reason it exists is CARDINALITY.
//
// Every rule that compares the sitekey list against the invisible sitekey list assumes the runner
// echoes one entry per matched NODE. Nothing in this repo can establish that; `extract` is a remote
// contract, and if it returns one value per SELECTOR instead, both lists collapse to one element,
// a widget cancels itself, and a rendered checkbox standing beside an invisible one goes unseen.
// The comparison degenerates exactly where it is needed most, because reCAPTCHA site keys are
// issued per domain and two widgets on one employer page usually SHARE a key.
//
// This selector needs no comparison and no counting. It matches the challenge node set minus the
// nodes that declare themselves invisible, so ANY match is a widget container that has not said it
// is invisible: one entry or ten, first in DOM order or last, the answer is the same. It adds no
// false positives over the sitekey comparison either - under per-node semantics it matches exactly
// the nodes that already left an unexplained sitekey behind.
const MANAGED_CAPTCHA_RENDERED_SITEKEY_SELECTOR =
  '[data-sitekey]:not([data-size="invisible" i]):not(.grecaptcha-badge):not(.grecaptcha-badge *)';

// The managed runner's /api/run is STATELESS and executes the whole action list before returning,
// so a check placed inside the submit list cannot stop the click it is meant to gate - by the time
// the result comes back the application is already sent. This is a separate, cheap call made first:
// navigate and read one attribute, no fills, no upload, no screenshot. Same two-call idiom as
// buildManagedDiscoveryActions.
//
// TWO KNOWN LIMITS, stated rather than hidden:
//   - It reads the page as it LOADS. A challenge that renders only after the fields are filled, or
//     after submit is pressed, is not caught.
//   - It is a SEPARATE page load from the one that submits. An anti-bot that escalates on a repeat
//     visit can challenge the submit session while the probe session saw nothing.
// Both mean this narrows the gap rather than closing it. portalCanAutoSubmit stays load-bearing.
export function buildManagedCaptchaProbeActions(): ManagedBrowserAction[] {
  return [
    {
      type: 'extract',
      selector: MANAGED_CAPTCHA_CHALLENGE_SELECTOR,
      attribute: 'data-sitekey',
      label: 'captcha_challenge',
      optional: true,
      requireVisible: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    },
    ...managedCaptchaEvidenceActions(),
  ];
}

// The evidence reads, shared by the standalone submit-time probe and the prepare-time fill run.
//
// Appended to the fill run too because the prepare path never calls the probe: it reads a CAPTCHA
// verdict off the REMOTE RUNNER's blocker list, which is a third-party judgement this repo cannot
// see the reasoning behind. Carrying the same three attributes back on the fill result is what lets
// corroboration happen at all. Five optional extracts, no screenshot, no token.
//
// EVERY ONE OF THEM CARRIES requireVisible, and that is the fix for the defect this block spent
// three revisions circling. These reads exist to answer "is a person being shown something", and
// until now the only thing they could see was attributes. So the rules underneath had to infer
// layout from markup, and the inference they settled on - an absent `data-size` means rendered,
// because reCAPTCHA's default is `normal` - is not a rule every provider obeys. Lever mounts
// hCaptcha programmatically in invisible mode and writes no `data-size` at all: measured on
// 2026-08-12, three live Palantir postings returned a site key from a container that is 1380x0 and
// holds two visibility:hidden iframes, and all three were permanently blocked as "CAPTCHA requires
// your attention". The runner's own predicate said no challenge. The direct-Playwright predicate
// said no challenge. This path was the outlier, and it was the outlier because it was the one layer
// with no layout read.
//
// requireVisible gives it one, answered by the SAME visibility rule the runner applies to its own
// blocker predicate, so the three layers now agree by construction instead of by coincidence. It
// also changes the cardinality: the runner returns one entry per visible node in DOM order rather
// than locator.first(), which is what the multiset subtraction in unexplainedChallengeSitekeys has
// always needed and never had.
//
// APPLIED TO ALL SIX rather than to the rendered channel alone, because the rules here compare one
// list of site keys against another. If `captcha_challenge` enumerated visible widgets while
// `captcha_invisible_sitekey` enumerated every widget, a HIDDEN invisible-declared widget could
// cancel a visible one standing beside it on the same domain site key, which is the shared-key page
// the subtraction was written for. The two lists have to be drawn from one node universe.
//
// ZERO ADDITIONAL ACTIONS. These are the same six extracts, and the fill run's budget against
// MANAGED_ACTION_LIMIT is unchanged, which is why the fix is a field on the reads that already exist
// rather than a second set of reads beside them.
//
// A BORDER BOX IS NOT WHAT A PERSON SEES, and the first version of this change got that wrong in the
// one direction that costs an application outright rather than stranding one.
//
// These six selectors match widget CONTAINERS and reCAPTCHA frames. Nothing in them can match an
// hCaptcha or a Turnstile frame, so on those two providers the container is this path's ONLY
// channel. `height:0` under the default `overflow:visible` leaves that container's border box at
// 1380x0 - the measured Lever geometry - while its 303x78 checkbox sits in flow, painted, and
// waiting to be clicked. Asked of the matched node alone, the visibility read answered "nothing
// here" about a page a person is looking at, and this path then DISCARDED a correct CAPTCHA blocker
// the runner had raised from the same DOM. Reproduced on hCaptcha, on Turnstile, and on the
// post-click escalated challenge; reCAPTCHA survived only because its anchor iframe matches a
// selector of its own and happens to be the painted child.
//
// So `requireVisible` asks whether the node OR anything it paints is on screen. The distinction is
// still real rather than a retreat to presence: on the measured Lever page every descendant is
// visibility:hidden or 1x1, so the answer there is still no, which is the whole point of the change.
//
// The first version was believed because its fixture hand-wrote a visible hCaptcha container as
// 303x78. No visible hCaptcha was measured anywhere in the sweep. The one thing that WAS measured is
// that the container's height is 0 while it holds non-zero children, so the height is imposed rather
// than derived from content, and assuming it would go away in the visible state was the entire
// safety margin. The fixture now carries the geometry that was measured.
export function managedCaptchaEvidenceActions(): ManagedBrowserAction[] {
  return [
    {
      type: 'extract',
      selector: MANAGED_CAPTCHA_SIZE_SELECTOR,
      attribute: 'data-size',
      label: 'captcha_size',
      optional: true,
      requireVisible: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    },
    {
      type: 'extract',
      selector: MANAGED_CAPTCHA_INVISIBLE_SITEKEY_SELECTOR,
      attribute: 'data-sitekey',
      label: 'captcha_invisible_sitekey',
      optional: true,
      requireVisible: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    },
    {
      type: 'extract',
      selector: MANAGED_CAPTCHA_RENDERED_SITEKEY_SELECTOR,
      attribute: 'data-sitekey',
      label: 'captcha_rendered_sitekey',
      optional: true,
      requireVisible: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    },
    {
      type: 'extract',
      selector: MANAGED_CAPTCHA_ANCHOR_SELECTOR,
      attribute: 'src',
      label: 'captcha_anchor',
      optional: true,
      requireVisible: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    },
    {
      type: 'extract',
      selector: MANAGED_CAPTCHA_BFRAME_SELECTOR,
      attribute: 'src',
      label: 'captcha_bframe',
      optional: true,
      requireVisible: true,
      timeout: MANAGED_FILL_TIMEOUT_MS,
    },
  ];
}

/**
 * What an extract entry actually SAW, with every spelling of "matched nothing" collapsed to null.
 *
 * `ManagedBrowserResult.extracted` types `value` as `string | null`, but Stratus is an external
 * service and that type is a declaration in this repo, not a contract it enforces. An unmatched
 * optional extract can come back as `null`, as `undefined`, as `""`, or as the selector echoed with
 * a whitespace value, and the previous `item.value !== null` test called three of those four a
 * challenge. The other two readers of this same array already knew better: managedResultFilledFields
 * and managedResultHasCoverLetterUpload both test `value?.trim()`. This puts that reading in one
 * place so a fourth reader cannot reintroduce the strict-null version.
 */
export function managedExtractedValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type ManagedCaptchaEvidence = {
  /** A data-sitekey outside the badge: a widget container is on the page. First one seen. */
  sitekey: string | null;
  /** EVERY sitekey seen outside the badge. One entry per widget container on the page. */
  sitekeys: string[];
  /** The sitekeys of the widgets that declare themselves invisible, by widget, not by page. */
  invisibleSitekeys: string[];
  /**
   * The sitekeys of the widget containers that do NOT declare themselves invisible. Read from its
   * own selector rather than derived, so it stays true when the runner echoes one entry per
   * selector instead of one per node and every list-against-list comparison collapses.
   */
  renderedSitekeys: string[];
  /** The widget's declared size, when it declares one. `invisible` asks a human for nothing. */
  size: string | null;
  /** The reCAPTCHA anchor iframe's src: the checkbox-or-badge frame, never the badge's own. */
  anchorSrc: string | null;
  /** Every reCAPTCHA anchor iframe src on the page that is not inside the badge. */
  anchorSrcs: string[];
  /** The reCAPTCHA bframe's src: the image-grid popup, on screen rather than merely mounted. */
  bframeSrc: string | null;
};

function managedExtractedAll(
  result: ManagedBrowserResult | null,
  label: string,
  selector: string,
): string[] {
  // Scans every entry rather than taking the first, for the reason the old some() call documented:
  // the selectors are multi-match and the runner may echo one entry per matched node, so a leading
  // unmatched entry must not hide a real widget behind it. Keeping ALL of them is what lets the
  // predicates below reason about one widget at a time instead of about the page.
  const values: string[] = [];
  for (const item of result?.extracted ?? []) {
    if (item?.label !== label && item?.selector !== selector) continue;
    const value = managedExtractedValue(item?.value);
    if (value) values.push(value);
  }
  return values;
}

export function readManagedCaptchaEvidence(result: ManagedBrowserResult | null): ManagedCaptchaEvidence {
  const sitekeys = managedExtractedAll(result, 'captcha_challenge', MANAGED_CAPTCHA_CHALLENGE_SELECTOR);
  const anchorSrcs = managedExtractedAll(result, 'captcha_anchor', MANAGED_CAPTCHA_ANCHOR_SELECTOR);
  const sizes = managedExtractedAll(result, 'captcha_size', MANAGED_CAPTCHA_SIZE_SELECTOR);
  return {
    sitekey: sitekeys[0] ?? null,
    sitekeys,
    invisibleSitekeys: managedExtractedAll(
      result,
      'captcha_invisible_sitekey',
      MANAGED_CAPTCHA_INVISIBLE_SITEKEY_SELECTOR,
    ),
    renderedSitekeys: managedExtractedAll(
      result,
      'captcha_rendered_sitekey',
      MANAGED_CAPTCHA_RENDERED_SITEKEY_SELECTOR,
    ),
    size: sizes[0] ?? null,
    anchorSrc: anchorSrcs[0] ?? null,
    anchorSrcs,
    bframeSrc: managedExtractedAll(result, 'captcha_bframe', MANAGED_CAPTCHA_BFRAME_SELECTOR)[0] ?? null,
  };
}

/** The labels every CAPTCHA evidence read is filed under. */
export const MANAGED_CAPTCHA_EVIDENCE_LABELS: ReadonlySet<string> = new Set([
  'captcha_challenge',
  'captcha_size',
  'captcha_invisible_sitekey',
  'captcha_rendered_sitekey',
  'captcha_anchor',
  'captcha_bframe',
]);

const MANAGED_CAPTCHA_EVIDENCE_SELECTORS: ReadonlySet<string> = new Set([
  MANAGED_CAPTCHA_CHALLENGE_SELECTOR,
  MANAGED_CAPTCHA_SIZE_SELECTOR,
  MANAGED_CAPTCHA_INVISIBLE_SITEKEY_SELECTOR,
  MANAGED_CAPTCHA_RENDERED_SITEKEY_SELECTOR,
  MANAGED_CAPTCHA_ANCHOR_SELECTOR,
  MANAGED_CAPTCHA_BFRAME_SELECTOR,
]);

// A value that can only have come from a challenge widget, whatever the entry was labelled.
// Matching on the value as well as the label is not belt-and-braces: the runner is free to echo an
// extract back without the label it was asked with, and the Akuna reproduction did exactly that.
const CAPTCHA_ARTIFACT_VALUE_RE =
  /\/recaptcha\/|\bg-recaptcha\b|hcaptcha\.com|\bh-captcha\b|challenges\.cloudflare\.com|cf-turnstile|arkoselabs|funcaptcha/i;

// The size read is the one evidence extract whose value carries no captcha vocabulary at all: it
// comes back as the bare contents of `data-size`. So the value-shape fallback above caught a
// labelless anchor URL and missed a labelless `invisible`, which is precisely the case the fallback
// was written for. These three are the only values reCAPTCHA's data-size ever holds, and the match
// is against the WHOLE value rather than a substring, so an application answer that merely contains
// the word is not mistaken for a widget read.
const CAPTCHA_SIZE_VALUE_RE = /^(?:invisible|normal|compact)$/i;

/**
 * Is this extract entry a CAPTCHA evidence read rather than something seen on the application form?
 *
 * Exported because the runner has to subtract these before it asks "did we reach the form". Every
 * managed fill run appends the evidence reads, and a reCAPTCHA anchor iframe is present on a large
 * share of employer pages INCLUDING pages with no application form on them at all, so counting one
 * as reach evidence means the reach question is answered yes on any page carrying a reCAPTCHA.
 */
export function isManagedCaptchaEvidenceExtract(
  item: { label?: string; selector?: string; value?: string | null } | null | undefined,
): boolean {
  if (!item) return false;
  if (item.label && MANAGED_CAPTCHA_EVIDENCE_LABELS.has(item.label)) return true;
  if (item.selector && MANAGED_CAPTCHA_EVIDENCE_SELECTORS.has(item.selector)) return true;
  const value = managedExtractedValue(item.value);
  if (value === null) return false;
  return CAPTCHA_ARTIFACT_VALUE_RE.test(value) || CAPTCHA_SIZE_VALUE_RE.test(value);
}

/**
 * An anchor iframe declares its widget's size in its own src. `size=invisible` is the badge; any
 * other value, and an absent value, is a rendered checkbox a person has to click.
 *
 * A rendered anchor is the one CAPTCHA signal that is independent of BOTH the sitekey identity and
 * the number of entries the runner chooses to echo, which is what makes it the load-bearing check
 * rather than a nicety. reCAPTCHA site keys are issued per domain, so two widgets on one employer
 * page are more likely to share a key than to differ, and every sitekey-attribution rule below is
 * blind to a duplicate by construction. The anchor is not: two anchors are two frames whatever they
 * are keyed to, and one of them saying `size=normal` is a checkbox on the page, full stop.
 *
 * Absent `size` reads as rendered because that is what reCAPTCHA does with it: the default is
 * `normal`. Reading an absent size as invisible would hand the benefit of the doubt to the one
 * direction that ends in a submit under an unsolved challenge.
 *
 * THAT DEFAULT IS RECAPTCHA'S, AND IT DOES NOT TRAVEL, which is the whole reason this rule is no
 * longer alone. Stated precisely, because the loose version of it is wrong: `data-size` is
 * documented hCaptcha markup and a site rendering the widget declaratively does write one. What was
 * measured is narrower, and is all the design needs. Lever renders hCaptcha PROGRAMMATICALLY and
 * writes no `data-size` at all, so on that code path "absent means rendered" is exactly wrong, and
 * it blocked three live postings. The states reachable on that same code path differ in layout and
 * in nothing else, which is why the answer is a layout read rather than another provider name in a
 * selector. The evidence reads now carry `requireVisible`, so a widget painting nothing never
 * reaches any rule here. This one keeps its job for the widget that IS on screen and declares a
 * size.
 *
 * NO LONGER THE ONLY THING BETWEEN THE BADGE AND A FALSE BLOCK either: the anchor selector excludes
 * badge descendants structurally, so this regex is a second line rather than the whole wall. It was
 * the whole wall on 24 of the 30 postings measured on 2026-08-12, and a wall made of one substring
 * of somebody else's query string is not a wall.
 */
const ANCHOR_DECLARES_INVISIBLE_RE = /[?&]size=invisible\b/i;

export function renderedAnchorSrcs(evidence: ManagedCaptchaEvidence): string[] {
  return evidence.anchorSrcs.filter((src) => !ANCHOR_DECLARES_INVISIBLE_RE.test(src));
}

/**
 * Everything on this page that is POSITIVE evidence of a rendered widget, on the two channels that
 * need neither a comparison nor a count.
 *
 * The distinction that matters: `unexplainedChallengeSitekeys` below reasons by SUBTRACTION - it
 * asks which of the widgets seen were not cancelled by something else - and subtraction is only as
 * good as the assumption that the two lists enumerate the same nodes. These two are direct
 * observations. A widget container that has not declared itself invisible, and an anchor iframe
 * that has not declared itself invisible, each say "a person is being shown something" on their
 * own, whether the runner returned one entry per node or one per selector, and whether or not the
 * widget beside them shares a site key.
 *
 * Checked BEFORE the subtraction everywhere it is used, so a page that would confuse the
 * subtraction still stops the run.
 */
export function renderedCaptchaEvidence(evidence: ManagedCaptchaEvidence): string[] {
  return [...evidence.renderedSitekeys, ...renderedAnchorSrcs(evidence)];
}

/**
 * The widgets on this page that nothing has shown to be invisible.
 *
 * This is the whole per-widget rule in one function. An invisible finding cancels the widget whose
 * sitekey it carries and no other, so a page holding one invisible widget and one real one has an
 * unexplained sitekey left over and stops the run, where the page-aggregate reading let the
 * invisible one answer for both.
 *
 * MULTISET subtraction, not set membership, and the difference is a defect that shipped. The
 * invisible selector is the challenge selector plus `[data-size="invisible"]`, so its matches are a
 * SUBSET of the challenge matches: each invisible reading accounts for exactly one widget, never
 * for a second one that happens to carry the same key. Set membership gave a single invisible
 * reading the power to cancel every widget sharing its sitekey, and reCAPTCHA keys are issued per
 * domain, so the realistic employer page - an invisible widget on the application form and a
 * rendered v2 checkbox on a "join our talent community" block, both on the company's one site key -
 * cancelled itself out entirely and opened the submit gate under an unsolved challenge. Measured:
 * `sitekeys ['K','K']`, `invisibleSitekeys ['K']` returned [] and now returns ['K'].
 *
 * A page-level `captcha_size: invisible` with no sitekey beside it explains NOTHING here, and that
 * is deliberate rather than an oversight: the reading cannot be attributed to a widget, and an
 * unattributable reading must not be allowed to clear one. It still has an effect where it can be
 * trusted, on the anchor-only page below, where there is no widget container to confuse it with.
 *
 * None of this assumes the runner echoes one entry per matched node. If it returns one value per
 * SELECTOR instead, `sitekeys` holds at most one element and this function degenerates to the
 * page-aggregate reading it replaced. That is why it is not the only check: the rendered-anchor
 * test above is what keeps the gate correct under either cardinality.
 */
export function unexplainedChallengeSitekeys(evidence: ManagedCaptchaEvidence): string[] {
  const unexplained = [...evidence.sitekeys];
  for (const invisible of evidence.invisibleSitekeys) {
    const at = unexplained.indexOf(invisible);
    if (at >= 0) unexplained.splice(at, 1);
  }
  return unexplained;
}

/**
 * An invisible reCAPTCHA is not a human challenge, and must never be counted as one on any path.
 *
 * Invisible mode computes a score from behaviour and mints the token on submit. Nothing is rendered
 * for a person to clear, which is precisely why the badge exclusion above already exists. This is
 * the same judgement expressed on the signals a remote runner can hand back instead of a Page.
 *
 * The bframe check comes FIRST and overrides everything. If reCAPTCHA escalates an invisible widget
 * it opens the image grid in the bframe, and at that moment a human genuinely is being asked
 * something even though the widget still declares itself invisible.
 *
 * Then: if any widget container was read at all, EVERY one of them has to be accounted for. This is
 * the line that used to read "is anything on this page invisible", which one widget could satisfy
 * on behalf of another.
 *
 * The anchor iframe is no longer the last resort. It used to be consulted only on the badge-only
 * page where no widget container matched anything - the live Akuna Greenhouse shape - which meant a
 * rendered checkbox announcing itself in plain text was ignored the moment any `data-sitekey` was
 * also readable. It is now consulted FIRST, before any sitekey reasoning, because it is the only
 * signal here that survives both a shared site key and an unknown extract cardinality. A page with
 * no readable sitekey and one `size=normal` anchor used to pass this and now does not.
 */
// LAST LINE, AFTER THE BADGE EXCLUSION. `anchorSrcs` no longer contains the badge's own anchor, so
// the badge-only page - the live Akuna shape, and 24 of the 30 postings measured on 2026-08-12 -
// reaches this line with an empty list and is no longer NAMED an invisible reCAPTCHA. Every caller
// lands in the same place it did before: managedCaptchaPageEvidence is empty on that page, so
// corroboration is false either way, and managedCaptchaProvider only consults this behind a
// non-empty anchorSrc. What changed is which sentence says so, not the answer.
export function isInvisibleRecaptchaEvidence(evidence: ManagedCaptchaEvidence): boolean {
  if (evidence.bframeSrc) return false;
  if (renderedCaptchaEvidence(evidence).length > 0) return false;
  if (evidence.sitekeys.length > 0) return unexplainedChallengeSitekeys(evidence).length === 0;
  return evidence.anchorSrcs.length > 0;
}

// Fails OPEN by construction, and now actually does. The remote runner's extract semantics are not
// defined in this repo, so if it returns a shape this does not recognise the verdict is "no
// challenge seen" - exactly the behaviour the managed path had before this probe existed. That was
// the promise the previous version made in this comment and did not keep: only a literal `null`
// read as "nothing here", so `""`, `undefined` and a whitespace echo each reported a challenge on a
// page where `[data-sitekey]` matched zero nodes, which is what stopped every managed submission.
export function managedResultRequiresCaptchaAttention(result: ManagedBrowserResult | null): boolean {
  const evidence = readManagedCaptchaEvidence(result);
  // The bframe read is visibility-filtered at the runner now, which changes what this line means
  // and makes it agree with the two predicates that already read it that way. reCAPTCHA MOUNTS the
  // popup iframe and leaves it mounted after it closes, so presence alone is true on pages nobody is
  // being asked anything on - the runner's own predicate calls this out as regression D, and the
  // direct-Playwright predicate only ever uses a bframe to switch the invisible exclusion off. A
  // popup that is on screen is still the strongest signal there is; a popup that is merely in the
  // document is not a signal at all.
  if (evidence.bframeSrc) return true;
  // A widget container or an anchor iframe that does not declare size=invisible is a rendered
  // challenge, and saying so needs no sitekey comparison and no assumption about how many entries
  // the runner echoed back. This is the check that holds when the subtraction below cannot see the
  // second widget at all, which is the ordinary case on an employer page: reCAPTCHA site keys are
  // issued per domain, so a talent-community checkbox and the application form's invisible widget
  // usually carry the SAME key and cancel each other out of the subtraction entirely.
  if (renderedCaptchaEvidence(evidence).length > 0) return true;
  // Per widget, not per page, and one invisible reading accounts for one widget rather than for
  // every widget sharing its key. An unsolved sitekey stops the run even when another widget beside
  // it declared itself invisible; the invisible one only ever answers for itself.
  return unexplainedChallengeSitekeys(evidence).length > 0;
}

/**
 * Which provider a managed run was stopped by, named rather than shrugged at.
 *
 * A stall recorded as `provider: unknown` on a page carrying a reCAPTCHA anchor iframe is a
 * reporting defect in its own right: the whole reason the provider is on the stall is to answer
 * "which families actually gate us", and `unknown` is the one answer that cannot. Every other stop
 * site already records a real provider, either from detectCaptchaProvider on a live Page or from
 * captchaProviderForFamily where there is no Page to read.
 *
 * Falls back to the family reading, not to a guess: a bare `[data-sitekey]` with no reCAPTCHA frame
 * beside it is as consistent with hCaptcha or Turnstile as with reCAPTCHA, and a wrong provider
 * label is worse than an absent one.
 */
export function managedCaptchaProvider(
  result: ManagedBrowserResult | null,
  portal: SupportedPortal,
): CaptchaProvider {
  const evidence = readManagedCaptchaEvidence(result);
  if (evidence.bframeSrc) return 'recaptcha_v2';
  if (evidence.anchorSrc) return isInvisibleRecaptchaEvidence(evidence) ? 'recaptcha_v3' : 'recaptcha_v2';
  return captchaProviderForFamily(portal);
}

/**
 * EVERYTHING ON THIS PAGE THAT IS POSITIVE EVIDENCE A HUMAN IS BEING ASKED SOMETHING.
 *
 * Named once and shared, because "what counts as evidence" was previously spelled out inline in
 * the corroboration check and therefore applied to some portals and not others. Each entry is a
 * direct observation rather than an inference: an open bframe is the image grid a person is looking
 * at, a rendered widget or anchor is a control that has not declared itself invisible, and an
 * unexplained challenge sitekey is a widget nothing on the page accounted for.
 *
 * Empty means the page said nothing about a challenge. It does NOT mean there is no challenge - a
 * page that returned no readable text at all produces an empty list too, and that is precisely the
 * shape the caller has to be able to tell apart from a seen widget.
 */
export function managedCaptchaPageEvidence(evidence: ManagedCaptchaEvidence): string[] {
  return [
    ...(evidence.bframeSrc ? [evidence.bframeSrc] : []),
    ...renderedCaptchaEvidence(evidence),
    ...unexplainedChallengeSitekeys(evidence),
  ];
}

/**
 * Does this repo's own read of the page back up the REMOTE RUNNER's claim that a human is needed?
 *
 * WHAT THIS IS, stated precisely, because it used to be described as something it is not. It is a
 * check of a third-party judgement against first-party markup, and it has exactly one honest
 * caller: the prepare path, which never runs the probe and only ever sees the runner's finished
 * sentence in `result.blockers`. There, "the provider says CAPTCHA, does the page agree" is a real
 * question with two independent sources, and the fourteen prod stalls of 2026-08-08 were every one
 * of them the provider saying CAPTCHA about a page that asks a human for nothing.
 *
 * WHAT IT IS NOT: a second layer under managedResultRequiresCaptchaAttention. It reads the same
 * evidence through the same predicates, so on an autonomous family the two agree by construction
 * and `requires && corroborated` is a tautology. The submit gate used to be written that way and
 * has been un-written; a conjunction whose second term cannot disagree with the first is not
 * defence in depth, it is one check wearing two names, which is worse than one check because it
 * reads as two.
 *
 * THIS IS A PAGE QUESTION, so it is now answered the same way for every family. It used to return
 * true for any portal outside AUTONOMOUS_PORTAL_FAMILIES before looking at a single extract.
 *
 * That carve-out was not only a mistake, and the honest version of this note has to say so. It was
 * written when the exception meant JazzHR and BambooHR, two families measured by hand and known to
 * gate every form, and for them it was correct. It was also, in effect, the belt for every family
 * nobody had measured yet: an unmeasured portal kept the runner's CAPTCHA claim, and keeping a
 * blocker is the cautious direction. What made it wrong was that it silently extended that trust to
 * families added years after the reasoning was written, so the set it protected and the set it was
 * argued for drifted apart with nothing to notice. Measured consequence: packet 1d1de862 (SEEKA,
 * smartrecruiters) carries a CAPTCHA claim and an open human_verification stall on a page whose own
 * preview recorded no readable text whatsoever, which is the signature of an interstitial rather
 * than a widget.
 *
 * So the belt is kept where it was actually earned and dropped where it was merely inherited. The
 * three families that CANNOT auto-submit on any path keep their blocker unconditionally, one layer
 * up in corroborateManagedCaptchaBlockers, which is where a family ceiling belongs. Everything else
 * has to show the page.
 *
 * Uncorroborating is safe at the point it is used. It drops a blocker off a PREPARE result, which
 * fills a form and screenshots it; it never presses submit. The submit path runs its own probe
 * afterwards, and portalCanAutoSubmit still stands in front of that. The cost of a false negative
 * here is a preview the applicant reviews anyway. The cost of the false positive was the product.
 *
 * `portal` is still taken, and still ignored on purpose: the caller passes the portal it is judging
 * and the answer is deliberately independent of it. Removing the parameter would only hide that
 * this is a page question rather than a family question.
 */
export function managedCaptchaVerdictIsCorroborated(
  portal: SupportedPortal,
  result: ManagedBrowserResult | null,
): boolean {
  void portal;
  const evidence = readManagedCaptchaEvidence(result);
  if (isInvisibleRecaptchaEvidence(evidence)) return false;
  return managedCaptchaPageEvidence(evidence).length > 0;
}

/**
 * WHETHER THE RUN STOPS, which is a different question from whether the page agrees.
 *
 * The verdict above is about markup. This is about the packet, and it has one more input: a family
 * whose forms Litos can never finish on its own. On jazzhr, bamboohr and comeet, dropping the
 * CAPTCHA blocker does not merely lose a warning, it makes `blockers.length === 0` in prepareManaged
 * and therefore `safe`, which renders a green "Send it" button, or submits outright under standing
 * consent. She presses it, the approve gate accepts, and the submit path immediately bounces her
 * back to needs_attention because portalCanAutoSubmit is false for those three. A send button that
 * cannot work is the failure this module already names as its worst: it is the same shape as the
 * Cresta cover-letter refusal, pointed the other way.
 *
 * So a family ceiling keeps its blocker whatever the page read said, and it costs nothing to do so:
 * these are exactly the families that cannot auto-submit anyway, so no application is delayed by a
 * blocker that was going to stop at the handoff regardless. It also keeps the whole of the real fix,
 * because smartrecruiters, jobvite, icims and oraclecloud are not on that list and still have to
 * show the page.
 *
 * This is deliberately NOT inside managedCaptchaVerdictIsCorroborated. That function answers "does
 * this repo's read of the markup back the runner up", and a family fact is not evidence about a
 * page; folding it in would put a family carve-out back into the one place the carve-out did damage,
 * and would make an assumed stop indistinguishable from an observed one.
 */
export function corroborateManagedCaptchaBlockers(
  portal: SupportedPortal,
  blockers: readonly string[],
  result: ManagedBrowserResult | null,
): string[] {
  if (!blockersIncludeCaptcha(blockers)) return [...blockers];
  if (isCaptchaGatedFamily(portal)) return [...blockers];
  if (managedCaptchaVerdictIsCorroborated(portal, result)) return [...blockers];
  return blockers.filter((blocker) => blocker !== CAPTCHA_BLOCKER);
}

// Which provider is asking. Recorded on the stall so the instrumentation can answer "which families
// actually gate us, and how long does each take to clear" instead of a single undifferentiated
// count. Deliberately a closed set with an 'unknown' member: a provider nobody has seen yet must
// record as unknown rather than be silently bucketed into the nearest known one.
export type CaptchaProvider =
  | 'recaptcha_v2'
  | 'recaptcha_v3'
  | 'hcaptcha'
  | 'turnstile'
  | 'arkose'
  | 'unknown';

export const RECAPTCHA_INTERACTIVE_SELECTOR = `iframe[src*="recaptcha" i]:not(.${CAPTCHA_BADGE_CLASS} *)`;

// The direct path's half of the same invisible-reCAPTCHA rule the managed path applies to extract
// values. The badge exclusion above already covers the common shape, where every captcha node sits
// inside `.grecaptcha-badge`. It does NOT cover the other one: a form that renders its own
// `<div class="g-recaptcha" data-size="invisible">` outside the badge, or an anchor iframe mounted
// outside it. Both match `[class*="captcha" i]`, both are visible, and both would be counted - a
// false positive on a page where nothing is being asked, which is the exact failure the badge
// exclusion exists to prevent, arriving through a door it does not watch.
export const RECAPTCHA_BFRAME_SELECTOR = 'iframe[src*="/recaptcha/"][src*="bframe" i]';
const RECAPTCHA_INVISIBLE_MARKER_SELECTOR = '[data-size="invisible"], iframe[src*="size=invisible" i]';

export const CAPTCHA_PROVIDER_MARKERS: ReadonlyArray<{ provider: CaptchaProvider; selector: string }> = [
  { provider: 'turnstile', selector: '[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com" i]' },
  { provider: 'hcaptcha', selector: '[name="h-captcha-response"], iframe[src*="hcaptcha.com" i]' },
  { provider: 'arkose', selector: 'iframe[src*="arkoselabs" i], iframe[src*="funcaptcha" i]' },
  { provider: 'recaptcha_v2', selector: '[name="g-recaptcha-response"], iframe[src*="recaptcha" i]' },
];

// Ordered, and the order matters: reCAPTCHA is checked LAST because its response field is the one
// most likely to co-exist with another provider on a page that switched vendors and left markup
// behind. A page carrying both reads as the newer one, which is the one actually gating it.
//
// The reCAPTCHA branch splits v2 from v3 on the same signal the exclusion uses: if the only thing
// rendered is the badge, nothing is being asked of a human, so it is v3. Anything outside the badge
// is an interactive widget, so it is v2.
export async function detectCaptchaProvider(page: Page): Promise<CaptchaProvider> {
  for (const marker of CAPTCHA_PROVIDER_MARKERS) {
    const count = await page.locator(marker.selector).count().catch(() => 0);
    if (count === 0) continue;
    if (marker.provider !== 'recaptcha_v2') return marker.provider;
    // Fails toward v2, the BLOCKING classification, for the same reason the visibility probe fails
    // closed. v3 means "nothing is being asked of a human"; recording that because a probe threw
    // would tell the instrumentation a page was harmless precisely when we could not see it.
    const interactive = await page.locator(RECAPTCHA_INTERACTIVE_SELECTOR).count().catch(() => -1);
    return interactive === 0 ? 'recaptcha_v3' : 'recaptcha_v2';
  }
  return 'unknown';
}

// The blocker line fillPortal emits when a challenge is still waiting. Exported because the runner
// matches on it to decide whether an attention state is a human-verification stall: it is a
// contract between two files, not a local string, and re-typing the literal at the match site is how
// that contract silently breaks.
export const CAPTCHA_BLOCKER = 'CAPTCHA requires your attention';

export const MANAGED_NETWORK_ACCESS_RESTRICTION_REASON =
  'The application site temporarily blocked Litos\'s secure browser because of its network activity. This is not a CAPTCHA, and nothing was sent. Open this application in Chrome and Litos will refill the exact saved packet there.';

/**
 * SmartRecruiters sometimes rejects a datacenter IP before it renders an application form. Its
 * page mentions bots and unusual activity, which made the managed provider report CAPTCHA even
 * though there is no challenge a person can solve. Treat only the complete restriction page as
 * this condition. A normal form mentioning access or activity in an employer question must not be
 * intercepted.
 */
export function managedNetworkAccessRestrictionReason(
  portal: SupportedPortal,
  pageText: string | undefined,
  pageTitle: string | undefined,
  pageEvidence: { filledFields?: readonly string[]; discovered?: readonly unknown[] } = {},
): string | null {
  const normalized = `${pageText ?? ''} ${pageTitle ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim();
  const normalizedTitle = (pageTitle ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const exactSmartRecruitersHeading = portalFamily(portal) === 'smartrecruiters'
    && normalizedTitle === 'access is temporarily restricted';
  const blocked = exactSmartRecruitersHeading
    || /\baccess denied\b|\brequest (?:has been )?blocked\b|\btemporarily blocked\b/.test(normalized);
  const reputationEvidence = exactSmartRecruitersHeading
    || /automated traffic.{0,80}(?:ip|network)|traffic from (?:this|your) ip|(?:this|your) ip address.{0,80}(?:blocked|flagged|reputation)|network reputation|datacenter (?:ip|network)|proxy (?:ip|network)/.test(normalized);
  if (!blocked || !reputationEvidence
    || (pageEvidence.filledFields?.length ?? 0) > 0
    || (pageEvidence.discovered?.length ?? 0) > 0) return null;
  const asksForHumanInteraction = /captcha|\bchallenge\b|\bhuman\b|\brobot\b|\bbot\b|\bidentity\b|\bverif(?:y|ies|ied|ication)\b|one[ -]?time|passcode|passkey|security code|\botp\b|\bauthenticat(?:e|ion|ing)\b|\bsign[ -]?in\b|\blog[ -]?(?:in|on)\b|\baccount (?:is )?required\b|\bsession expired\b|\bpassword\b|\bmfa\b|\b2fa\b|single sign[ -]?on|\bsso\b/.test(normalized)
    || /\b(?:confirm|prove)(?: that)? you(?:'re| are) (?:a )?(?:real )?person\b/.test(normalized)
    || /\b(?:complete|pass) (?:the |a )?security check\b/.test(normalized)
    || /\b(?:tick|check|click|select|mark)(?: the| this| a)? checkbox\b/.test(normalized)
    || /\b(?:press|click)(?: and |-)hold\b/.test(normalized)
    || /\b(?:create|register)(?: for)? (?:an? )?account\b|\bsign up\b|\bregister to continue\b/.test(normalized)
    || /\bcontinue with (?:google|apple|microsoft|linkedin|facebook|github|sso)\b/.test(normalized)
    || /\b(?:accept|agree to)(?: the)? (?:terms(?: and conditions)?|privacy (?:policy|notice)|consent)\b/.test(normalized)
    || /\b(?:terms and conditions|privacy (?:policy|notice)).{0,40}\b(?:must be accepted|required|to (?:continue|proceed))\b/.test(normalized);
  if (asksForHumanInteraction) return null;
  return MANAGED_NETWORK_ACCESS_RESTRICTION_REASON;
}

export function blockersIncludeCaptcha(blockers: readonly string[]): boolean {
  return blockers.includes(CAPTCHA_BLOCKER);
}

export async function hasUnresolvedCaptcha(page: Page): Promise<boolean> {
  const responseFields = page.locator(CAPTCHA_RESPONSE_SELECTOR);
  const responseTokens: string[] = [];
  // count() is hoisted out of the loop CONDITION deliberately: it is a round-trip to the browser, so
  // leaving it there paid one extra crossing per iteration and let the bound move mid-scan.
  const fieldCount = await responseFields.count();
  for (let index = 0; index < fieldCount; index += 1) {
    responseTokens.push(
      await responseFields.nth(index).inputValue({ timeout: CAPTCHA_PROBE_TIMEOUT_MS }).catch(() => ''),
    );
  }

  // Fails CLOSED on a throw, like every other probe here: `1` means "assume the popup is open",
  // which switches the invisible exclusion OFF and leaves the node counted. A probe that cannot see
  // must assume the thing it guards against.
  const bframeCount = await page.locator(RECAPTCHA_BFRAME_SELECTOR).count().catch(() => 1);
  const challenges = page.locator(CAPTCHA_CHALLENGE_SELECTOR);
  const challengeCount = Math.min(await challenges.count(), CAPTCHA_MAX_CANDIDATE_NODES);
  let visibleChallengeCount = 0;
  for (let index = 0; index < challengeCount; index += 1) {
    const challenge = challenges.nth(index);
    // Fails CLOSED, and it is the only probe here that had to be argued about. Every other catch in
    // this function pushes toward "a human is needed"; a visibility probe that swallowed its error
    // as `false` pushed the other way, so a widget that detached mid-probe (routine during a
    // reCAPTCHA re-render) would drop the count to zero and let the submit click through under an
    // uncleared challenge. A guard that cannot see must assume the thing it guards against.
    if (!await challenge.isVisible().catch(() => true)) continue;
    const insideBadge = await challenge
      .evaluate((node, badgeClass) => node.closest(`.${badgeClass}`) !== null, CAPTCHA_BADGE_CLASS, {
        timeout: CAPTCHA_PROBE_TIMEOUT_MS,
      })
      .catch(() => false);
    if (insideBadge) continue;
    // Only while no bframe is open. An escalated invisible widget still declares itself invisible,
    // so without the bframe test this would wave through the one case where a human really is
    // looking at an image grid. Matched with matches() OR closest(), same reasoning as the badge:
    // the invisible marker sits on the widget CONTAINER, and the iframe inside it carries neither.
    if (bframeCount === 0) {
      const invisibleOnly = await challenge
        .evaluate(
          (node, selector) => node.matches(selector) || node.closest(selector) !== null,
          RECAPTCHA_INVISIBLE_MARKER_SELECTOR,
          { timeout: CAPTCHA_PROBE_TIMEOUT_MS },
        )
        .catch(() => false);
      if (invisibleOnly) continue;
    }
    visibleChallengeCount += 1;
  }
  return captchaSnapshotRequiresAttention(responseTokens, visibleChallengeCount);
}

// Playwright's locator actions AUTO-WAIT, defaulting to 30s. Probing four label sources per field
// with the default would spend up to two minutes on a single unlabelled field and blow the
// function's runtime budget, killing the whole submission run: strictly worse than the ugly UUID
// text this replaced. Every probe is therefore explicitly bounded, and the probes run LAZILY,
// stopping at the first source that yields something a human wrote.
const LABEL_PROBE_TIMEOUT_MS = 750;

async function resolveFieldLabel(page: Page, field: Locator): Promise<string | null> {
  const id = await field.getAttribute('id').catch(() => null);
  const labelledBy = await field.getAttribute('aria-labelledby').catch(() => null);
  // aria-labelledby is a space-separated ID list; leading whitespace would make split()[0] the
  // empty string and produce [id=""], which matches nothing and costs a probe for no reason.
  const labelledByFirst = labelledBy?.trim().split(/\s+/)[0] || null;

  // Ordered best to worst. The visible <label> comes first because Greenhouse and Ashby name their
  // custom question inputs with UUIDs, so `name` and `id` are opaque tokens; humanFieldLabel
  // rejects those rather than printing them, and the loop simply moves on to the next source.
  const probes: Array<() => Promise<string | null>> = [];

  if (id) {
    probes.push(() =>
      page.locator(`label[for="${quoteAttr(id)}"]`).first().innerText({ timeout: LABEL_PROBE_TIMEOUT_MS }),
    );
  }
  if (labelledByFirst) {
    // textContent, not innerText: a legitimate sr-only label is display:none-adjacent and innerText
    // renders it as the empty string, discarding a perfectly good name.
    probes.push(() =>
      page.locator(`[id="${quoteAttr(labelledByFirst)}"]`).first().textContent({ timeout: LABEL_PROBE_TIMEOUT_MS }),
    );
  }
  probes.push(async () => {
    // Gated on count() so a field with no ancestor label costs one cheap query instead of a full
    // timeout. Skipped when the label wraps more than one control: innerText of a label wrapping a
    // radio group returns the whole group's text, which is not this field's name.
    const ancestor = field.locator('xpath=ancestor::label[1]');
    if ((await ancestor.count().catch(() => 0)) === 0) return null;
    if ((await ancestor.locator('input, select, textarea').count().catch(() => 0)) > 1) return null;
    return ancestor.first().innerText({ timeout: LABEL_PROBE_TIMEOUT_MS });
  });
  probes.push(() => field.getAttribute('aria-label'));
  probes.push(() => field.getAttribute('placeholder'));
  probes.push(() => field.getAttribute('name'));
  probes.push(async () => id);

  for (const probe of probes) {
    let raw: string | null = null;
    // The try wraps locator CONSTRUCTION as well as the await: a page-controlled id containing a
    // character that is not legal in a CSS string can throw synchronously, and an unhandled throw
    // here would abort the entire fill run rather than degrading to "no label".
    try {
      raw = await probe();
    } catch {
      raw = null;
    }
    const label = humanFieldLabel([raw]);
    if (label) return label;
  }
  return null;
}

// Thrown when a challenge is still unresolved at the moment of the final click. A class, not a
// message prefix, so the runner narrows on `instanceof` the way it already does for
// FieldDecryptError and ResumeUploadError. The message is plain English because it lands in
// submission_error, which is read by a person.
// `stage` exists because the two stop points owe the applicant DIFFERENT sentences, and getting that
// wrong is the specific mistake this whole feature was built to avoid. At 'at_submit' the form is
// filled and one check remains. At 'before_fill' the managed probe stopped the run before it touched
// anything, so the page is blank - telling that applicant "Litos filled everything in, just finish
// the last step" sends them to a form that does not match what they were told. Exactly the
// distinction portalHandoffReason and unattendedHandoffReason already draw, for the same reason.
export type CaptchaStopStage = 'before_fill' | 'at_submit';

export class CaptchaUnresolvedError extends Error {
  constructor(
    readonly stage: CaptchaStopStage = 'at_submit',
    readonly provider: CaptchaProvider = 'unknown',
    message = 'The submit button was not pressed: a human verification check is still waiting.',
  ) {
    super(message);
    this.name = 'CaptchaUnresolvedError';
  }
}

/* Named providers, used ONLY for the shape that carries no preposition - "Apply LinkedIn". The
   general "<verb> ... with|using|via <object>" case is handled by THIRD_PARTY_HANDOFF, which does
   not consult this list: a hard-coded roster of somebody-elses can only ever be incomplete, and
   relying on it was how "Apply now with Wellfound" became pressable. */
const PROVIDER = 'handshake|symplicity|linkedin|indeed|seek|glassdoor|ziprecruiter|monster|xing'
  + '|stepstone|google|facebook|github|apple|greenhouse|workday|workable|ashby|smartrecruiters'
  + '|okta|microsoft|sso';
const HANDOFF_VERB_PROVIDER = new RegExp(
  `\\b(?:apply|autofill|continue|import)\\s+(?:${PROVIDER})\\b`, 'i',
);

/* The send-clause is SHARED with APPLICATION_SUBMIT rather than written twice. The two copies had
   already drifted - this one required "send my application" and the other allowed "your", so
   "Send your application" failed eligibility entirely while the strongest tier would have taken it.
   Same defect as the two label readers, in the regexes. */
const SEND_APPLICATION = '\\bsend\\s+(?:your\\s+|my\\s+|the\\s+)?application\\b';

/* CONTROLS THAT SAY "APPLY" AND HAND OFF TO SOMEBODY ELSE.
 *
 * "Apply with LinkedIn", "Apply With Indeed", "Apply with SEEK" are not submit buttons. They are
 * OAuth handoffs that leave the employer's form and open a third party's consent screen, and every
 * one of them matches the word "apply".
 *
 * THIS IS LIVE ON PORTALS THAT ARE AUTONOMOUS TODAY, not a SmartRecruiters curiosity: Greenhouse
 * and Lever both render "Apply with LinkedIn", and SmartRecruiters' first step carries two of them
 * before the applicant has typed anything. The old selector matched all of them and took `.last()`,
 * so which control got pressed depended on DOM order - it happened to work because the real submit
 * usually sits at the bottom of the form. That is a coin flip, not a guarantee, and the losing side
 * sends the applicant's browser to a third-party sign-in while Litos reports a submitted
 * application the employer never received.
 *
 * Matched on the WHOLE label, anchored, so "apply" as a preposition inside a longer sentence cannot
 * sneak past: it is the shape "<verb> with|using|via <somebody>" that gives these away. */
const THIRD_PARTY_HANDOFF =
  new RegExp(
    /* BROAD ON THE OBJECT, NARROW ON THE EXCEPTION, and that direction is the whole lesson of this
       branch. An earlier round required the object to be a NAMED provider, which stopped
       "Submit application with attachments" being rejected - and re-opened the main hole, because
       every board not on the list walked through: "Apply now with Wellfound", "Apply now with
       Dice", "Apply now with our partner", "Apply now with Career Services". Worse, "Submit
       application with our recruiting partner" reached the top tier and OUTRANKED a real submit.
       A hard-coded list of somebody-elses can only ever be incomplete. A list of the things a
       button legitimately carries - your own documents - is short and closed. So: any
       "<verb> ... with|using|via|from <object>" is a handoff UNLESS the object is a document you
       are attaching. Wrong guesses cost a handoff, never a phantom submission. */
    '\\b(?:apply|submit|send|autofill|sign\\s?in|log\\s?in|continue|register|import)\\b'
    /* Four words of slack, not two: "Submit your saved candidate profile with Handshake" puts
       four between the verb and the preposition, and two let it through. */
    + '(?:\\s+\\w+){0,4}\\s+(?:with|using|via|from)\\s+'
    + '(?!(?:the\\s+|your\\s+|my\\s+|a\\s+|an\\s+)?'
    /* BARE possessive only - "your profile", never "your Handshake profile". The article-and-noun
       form is your own saved details on this same site ("Send application from your profile"); an
       intervening word is almost always somebody else's name, which is the handoff. */
    + '(?:attachments?|resumes?|cvs?|cover\\s+letters?|documents?|files?|e-?signature'
    + '|profiles?|accounts?|saved\\s+(?:details|information))\\b)'
    + '|\\bquick apply\\b|\\bone[-\\s]?click apply\\b|\\bpowered\\s+by\\b',
    'i',
  );

/** Names the application outright. The strongest thing a submit control can say. */
const APPLICATION_SUBMIT = new RegExp(
  `\\bsubmit\\s+(?:your\\s+|my\\s+|the\\s+)?application\\b|${SEND_APPLICATION}`, 'i',
);
/** Help-desk widgets that also say "submit" and also sit at the foot of the page. */
/* A WORD LIST, not a list of exact phrasings. "Submit a request" was covered only because that
   literal string happened to be in it; "Submit a support request", "Submit your question" and
   "Submit an issue" all walked straight through and then won last-wins over the real control. */
const SUPPORT_WIDGET_NOUN =
  /\b(?:feedback|request|ticket|comment|search|report|question|issue|review|rating|survey|contact|bug)\b/i;

/**
 * A help-desk control rather than the thing that sends the application.
 *
 * THE DISCRIMINATOR IS THE WORD "APPLICATION", and it is better than anchoring to the verb. As a
 * bare noun list this rejected "Submit application for review", "Review and submit", and any label
 * carrying a job title that happens to contain one of the words - "Submit your application -
 * Contact Center Agent". Anchoring the noun to the verb instead broke the real widgets, because
 * they say "Submit a support request" and "Submit your question" with words in between.
 * What actually separates them: a help desk never calls the thing an application. Intercom and
 * Zendesk ship "Submit feedback" and "Submit a request"; no employer's application button omits
 * the word while a support widget includes it.
 */
function isSupportWidget(label: string): boolean {
  /* "Submit application feedback" and "Submit application survey" ARE help desks, and blanket-
     exempting anything containing "application" put them back in the top tier - where, on
     last-wins, the feedback widget beat the real submit control. A widget noun sitting on the
     application is the giveaway. */
  if (/\bapplication\s+(?:feedback|survey|issue|question|review|experience)\b/i.test(label)) return true;
  if (/\bfeedback\s+on\s+your\s+application\b/i.test(label)) return true;
  /* Otherwise the word "application" clears it: a help desk never calls the thing an application,
     and without this every job title carrying one of the nouns ("Submit your application -
     Contact Center Agent") is falsely rejected. */
  if (/\bapplication\b/i.test(label)) return false;
  return SUPPORT_WIDGET_NOUN.test(label);
}

const SUBMIT_LABEL = new RegExp(
  `\\bsubmit\\b|${SEND_APPLICATION}|^\\s*apply\\s*$|\\bapply now\\b|\\bfinish (?:and|&) apply\\b`,
  'i',
);

/**
 * Which of a page's buttons is the one that actually submits, or null.
 *
 * A pure function over the visible labels, so the rule that decides whether to press a button on a
 * real person's job application is testable without standing up a browser. Returns an INDEX rather
 * than a label because two buttons can read the same and only the position tells them apart.
 *
 * Order matters and is the whole design: reject the handoffs FIRST, then prefer the most explicit
 * remaining label. An explicit "Submit application" always beats a bare "Apply", and the LAST such
 * control wins because a form's real submit sits at its foot.
 */
export function chooseSubmitControl(labels: string[]): number | null {
  return chooseCanonicalFinalSubmit(labels);
}

/** Every control that could conceivably be a submit button. Exported so a test can match it. */
export const SUBMIT_CANDIDATE_SELECTOR =
  'button, input[type=submit], input[type=button], input[type=image], [role=button]';

/**
 * No control on this page submits the application.
 *
 * ITS OWN TYPE FOR THE SAME REASON CaptchaUnresolvedError HAS ONE. A plain Error falls through
 * fail()'s `uncertainAfterClaim` branch, which tells the applicant "the final submission was
 * attempted, but Litos could not verify the employer confirmation - check the portal or your
 * email". When this throws, the click PROVABLY did not happen, so there is no receipt to look for
 * and that sentence sends her hunting for one that cannot exist.
 *
 * It matters more now than it used to. This used to fire only when a page had no buttons at all;
 * with the handoff filter it is the ROUTINE outcome on every multi-step first page and every page
 * whose only apply-ish controls belong to LinkedIn or Indeed.
 */
export class NoSubmitControlError extends Error {
  constructor(message = 'We could not find the Submit button') {
    super(message);
    this.name = 'NoSubmitControlError';
  }
}

/* Extends NoSubmitControlError deliberately, rather than standing alone. fail() reads that type as
   "the click PROVABLY did not happen", which is the one thing that has to be true of this: the
   applicant must not be sent looking for a receipt that cannot exist. Everything downstream -
   precedence against captchaStop, the attention category, the wording shown on the card - is
   already correct for that meaning, and a new sibling type would have to re-derive all of it. */
export class FormIncompleteError extends NoSubmitControlError {
  readonly fields: string[];

  constructor(fields: string[]) {
    const named = fields.slice(0, 5).join('; ');
    super(
      `Litos did not press submit: ${fields.length} required field${fields.length === 1 ? '' : 's'} `
      + `on the form ${fields.length === 1 ? 'is' : 'are'} still empty (${named}`
      + `${fields.length > 5 ? `, and ${fields.length - 5} more` : ''})`,
    );
    this.name = 'FormIncompleteError';
    this.fields = fields;
  }
}

export class ManagedRequiredFieldConfirmationError extends NoSubmitControlError {
  readonly fields: string[];

  constructor(fields: string[], message?: string) {
    const unique = [...new Set(fields.filter((field) => field.trim()).map((field) => field.trim()))];
    super(message ?? (
      unique.length > 0
        ? `Litos did not press submit: ${unique.length} required field confirmation${unique.length === 1 ? '' : 's'} failed (${unique.slice(0, 5).join('; ')})`
        : 'Litos did not press submit: the browser could not prove required fields were committed'
    ));
    this.name = 'ManagedRequiredFieldConfirmationError';
    this.fields = unique;
  }
}

/* A proof this service COULD NOT READ, as opposed to a proof that says the runner stopped.
 *
 * The two are opposites and were one class until 2026-08-12, when the difference reached
 * production. The runner's submit-scope repair added `scopeKind` to `pass.scope`; the key-set
 * check below rejected the unknown key on every family, form and container alike; and because the
 * rejection was thrown as a NoSubmitControlError subclass, fail() classified it as a stop that
 * provably preceded the click. Measured on the kos.ai row: the runner's own code, driven against
 * a fixture of that exact page, presses Submit and the page records the submission - and the row
 * said "nothing has been sent". A malformed or absent proof arrives AFTER the remote run finished,
 * so the click may already have landed; the only honest classification is uncertainty, which keeps
 * the claim and takes the unverified exit. deliberately extends Error, never NoSubmitControlError.
 */
export class ManagedConfirmationUnprovenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedConfirmationUnprovenError';
  }
}

const REQUIRED_CONFIRMATION_FIELD_TYPES = new Set([
  'text', 'date', 'select', 'react-select', 'radio', 'checkbox', 'file', 'custom',
]);
const REQUIRED_CONFIRMATION_OUTCOMES = new Set(['already_committed', 'confirmed', 'failed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(value);
  return required.every((key) => keys.includes(key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

/**
 * Confirmation proof may identify controls only through selectors that survive layout changes.
 * Coordinates, absolute DOM paths and positional selectors are deliberately rejected. They can
 * point at a different answer after a responsive reflow, which is worse than failing closed.
 */
export function isDurableRequiredControlSelector(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const selector = value.trim();
  if (!selector || selector.length > 500) return false;
  if (/^(?:x\s*[:=]|coordinates?\b|point\s*\()/i.test(selector)) return false;
  if (/^\(?\s*\d+\s*[,;]\s*\d+\s*\)?$/.test(selector)) return false;
  if (/^(?:\/\/|\/html\b)/i.test(selector)) return false;
  if (/:(?:nth-child|nth-of-type)\s*\(/i.test(selector)) return false;
  // Exact identities only. matchCount:1 independently proves the identity was unique on the live
  // page. Generic type, role, aria, autocomplete and label selectors are excluded.
  const tag = '(?:[a-z][a-z0-9-]*)?';
  const quoted = '(?:"[^"\\r\\n]+"|\'[^\'\\r\\n]+\')';
  return new RegExp(
    `^(?:${tag}#[A-Za-z_][\\w:-]*|${tag}\\[name=${quoted}\\]|\\[data-field-path=${quoted}\\]|\\[data-litos-stable-id-v1=${quoted}\\])$`,
    'i',
  ).test(selector);
}

type RequiredControlProof = {
  selector: string;
  label: string | null;
  fieldType: 'text' | 'date' | 'select' | 'react-select' | 'radio' | 'checkbox' | 'file' | 'custom';
  matchCount?: 1;
};

function parseRequiredControl(value: unknown, requireMatchCount = false): RequiredControlProof | null {
  const keys = requireMatchCount
    ? ['selector', 'label', 'fieldType', 'matchCount']
    : ['selector', 'label', 'fieldType'];
  if (!isRecord(value) || !hasOnlyKeys(value, keys)) return null;
  if (!isDurableRequiredControlSelector(value.selector)) return null;
  if (value.label !== null && (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 200)) return null;
  if (typeof value.fieldType !== 'string' || !REQUIRED_CONFIRMATION_FIELD_TYPES.has(value.fieldType)) return null;
  if (requireMatchCount && value.matchCount !== 1) return null;
  return {
    selector: value.selector.trim(),
    label: typeof value.label === 'string' ? value.label.trim() : null,
    fieldType: value.fieldType as RequiredControlProof['fieldType'],
    ...(requireMatchCount ? { matchCount: 1 as const } : {}),
  };
}

/* "UNKNOWN" IS THE RIGHT ANSWER ONLY WHERE IT IS ACTUALLY UNKNOWN.
 *
 * PR 506 made every shape refusal an unproven-press, and against a run whose press state really is
 * unreadable that is exactly right. Against a run that positively reported withholding the click it
 * is a false uncertainty, and a false uncertainty is not free: it keeps the claim, writes an
 * unresolved unverified_submission, and tells the applicant Litos pressed Send. That locks the
 * packet out of the ordinary re-run path and out of a fresh application to the same posting.
 *
 * The escape needs TWO independent statements from the runner, agreeing, because one field on a
 * payload whose shape is already suspect is not enough: submitOutcome.pressed === false, recorded
 * where submitHandle.click() would have been called, AND every pass reporting submissionOutcome
 * 'blocked'. A run that pressed says pressed:true and 'clicked', so neither half can be produced by
 * the case this must never misread.
 */
function observedManagedSubmitWithheld(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const outcome = result.submitOutcome;
  if (!isRecord(outcome) || outcome.pressed !== false) return false;
  const proof = result.requiredFieldConfirmation;
  /* A missing or empty pass list leaves this false on purpose. That is PR 506's older-runner case,
   * where nothing in the payload knows what a confirmation proof is, and it stays unknown. */
  if (!isRecord(proof) || !Array.isArray(proof.passes) || proof.passes.length === 0) return false;
  return proof.passes.every((pass) => isRecord(pass) && pass.submissionOutcome === 'blocked');
}

function confirmationContractError(message: string, submitWithheld = false): never {
  if (submitWithheld) {
    throw new ManagedRequiredFieldConfirmationError(
      [],
      `Litos did not press submit: the run withheld the click and its required-field confirmation proof could not be read (${message})`,
    );
  }
  throw new ManagedConfirmationUnprovenError(`Litos could not read the send run's required-field confirmation proof (${message}), so whether submit was pressed is unknown`);
}

/* WHAT `pass.unresolved` IS ALLOWED TO SAY, AND WHY REJECTING THE PROOF OVER IT WAS THE WRONG LEVER.
 *
 * The old rule was: every entry must be a selector or label of a control in requiredControls, or the
 * whole proof is malformed. Measured against stratus-browser-cloud@4748871, FIVE of the runner's
 * eight push sites emit strings that set can never contain:
 *
 *   managed-browser.js:2928  '"Start date" is required and is still empty'   (the readiness scan)
 *   managed-browser.js:2929  'The bound application form still shows an unmatched validation error: …'
 *   managed-browser.js:2942  'Bound submit control or application form was replaced before submission'
 *   managed-browser.js:2964  'Bound application form or submit identity changed during confirmation'
 *   managed-browser.js:2825  'Selectorless required field'
 *
 * 2928 fires on ANY still-empty required field, so it is not an edge case: it is what an ordinary
 * blocked submission looks like. The backend's own fixtures only ever put bare labels in this array,
 * which is why the whole path was green while nothing in production could use it.
 *
 * AND SINCE PR 506 THE COST OF THAT REJECTION IS NO LONGER A BAD MESSAGE, IT IS A LOCKED PACKET.
 * A shape refusal now throws ManagedConfirmationUnprovenError, which correctly means "the click
 * state is unknown". Applied to a run that reported pressed:false and submissionOutcome 'blocked',
 * it wrote: attention_reason "Litos pressed Send and the page never showed a confirmation it could
 * read", submission_attempted_at set, an unresolved unverified_submission record, and the claim
 * kept. Every one of those is false, and together they send the applicant to check a portal for an
 * application that was never sent and block her from re-running the packet or applying again.
 *
 * SO THE VOCABULARY IS NO LONGER A REJECTION SURFACE AT ALL. An entry this service does not
 * recognise still BLOCKS - it is a failure, it keeps the pass blocked, and it keeps the proof
 * honest - it simply does not get its text repeated to the applicant. That keeps the property the
 * strictness existed for (employer-authored text must not reach Litos's own copy, and 2929 carries
 * exactly that) while removing the failure mode where a wording change in the runner takes the
 * product down. The runner is free to improve its sentences; this service reports the ones it can
 * attribute to a control and counts the rest.
 */
const UNRESOLVED_ENTRY_MAX_LENGTH = 400;

/** The runner's own fixed sentences. Constants in its source, carrying no employer text. */
const RUNNER_AUTHORED_BLOCKERS: ReadonlySet<string> = new Set([
  'A required field on the form has no label Litos can read, and is still empty',
  'Required-field readiness scan failed',
  'Selectorless required field',
  'Bound submit control or application form was replaced before submission',
  'Bound application form or submit identity changed during confirmation',
  'Litos could not bind required-field validation to the selected application form',
]);

/** What the applicant is told when a blocker cannot be attributed to a control on this form. */
export const UNATTRIBUTED_REQUIRED_BLOCKER = 'A required answer on this form is still missing';

/* The readiness scan's template, managed-browser.js:2126. The quoted label is the useful half and is
 * kept ONLY when it names a control this proof already enumerated, so the label reaching the
 * applicant is one this service has independently seen rather than any text the page supplied. */
const READINESS_REQUIRED_TEMPLATE = /^"(.+)" is required and is still empty$/;

function readUnresolvedEntry(value: string, known: ReadonlySet<string>): string {
  if (known.has(value)) return value;
  const readiness = READINESS_REQUIRED_TEMPLATE.exec(value);
  if (readiness && known.has(readiness[1]!)) return readiness[1]!;
  if (RUNNER_AUTHORED_BLOCKERS.has(value)) return value;
  return UNATTRIBUTED_REQUIRED_BLOCKER;
}

/* WHEN THE APPLICATION SEND MAY GO UNPROVEN, AND IT IS NARROWER THAN IT WAS WRITTEN.
 *
 * There is exactly one state in which the initial managed run owes no application-submit proof: a
 * security-code wall that was ALREADY STANDING when the page loaded. Stratus will not press the
 * disabled application control from there, so no application pass exists to assert, and the only
 * click that follows is the verification pass, which asserts its own proof.
 *
 * The skip used to be keyed on the challenge alone. That also excused a run that DID press Send and
 * then landed on a code wall - which is the ordinary way a Greenhouse wall appears - so a runner
 * that pressed with its required-field proof blocked, malformed or absent was no longer caught at
 * the one place this service checks. The pressed half is the half that matters, so it is asked for.
 */
export function managedApplicationProofIsRequired(
  standingChallenge: unknown,
  initialSubmitOutcome: { pressed?: boolean } | null | undefined,
): boolean {
  return !(standingChallenge && initialSubmitOutcome?.pressed === false);
}

/**
 * Require the remote runner's per-field proof before this service records a receipt. The action
 * itself is the pre-click barrier. This read is the independent reporting barrier, so an older
 * runner that silently ignores an unknown action cannot turn a silent fill into `submitted`.
 */
export function assertManagedRequiredFieldsConfirmed(
  result: unknown,
  expectedSubmitKind?: 'application' | 'verification',
): void {
  /* Read from the RAW result, before anything is validated, because the whole point is the case
   * where validation fails. The annotation on the const is load-bearing: TypeScript only narrows
   * past a never-returning arrow when the const carries an explicit type, and every guard below
   * depends on that narrowing to keep reading `result` and `pass` as records. */
  const submitWithheld = observedManagedSubmitWithheld(result);
  const contractError: (detail: string) => never = (detail) => confirmationContractError(detail, submitWithheld);
  if (!isRecord(result)) contractError('result is not an object');
  const proof = result.requiredFieldConfirmation;
  if (proof === undefined || proof === null) {
    /* No proof at all is the unknown-runner case, and unknown is what it must stay: the action
     * list this result answers carried a final submit, so an older runner may have pressed it
     * without knowing how to write the proof. Claiming "did not press" here is the same false
     * release the malformed branch produced. */
    throw new ManagedConfirmationUnprovenError("Litos could not read the send run's required-field confirmation proof (the managed browser returned none), so whether submit was pressed is unknown");
  }
  if (!isRecord(proof) || !hasOnlyKeys(proof, ['version', 'status', 'passes'])) {
    contractError('receipt shape');
  }
  if (proof.version !== 2) contractError('unsupported version');
  if (proof.status !== 'confirmed' && proof.status !== 'blocked') contractError('status');
  if (!Array.isArray(proof.passes) || proof.passes.length !== 1) {
    contractError('confirmation passes');
  }
  const opaqueFingerprint = (value: unknown) => typeof value === 'string'
    && /^[A-Za-z0-9_-]{16,200}$/.test(value);
  const allFailures: string[] = [];
  const blockerFailures: string[] = [];
  for (const pass of proof.passes) {
    if (!isRecord(pass) || !hasOnlyKeys(pass, [
      'submitKind', 'scope', 'requiredControls', 'attempts', 'retries', 'unresolved', 'submissionOutcome',
    ], ['blockerReason'])) contractError('pass shape');
    if (pass.submitKind !== 'application' && pass.submitKind !== 'verification') {
      contractError('submit kind');
    }
    if (expectedSubmitKind && pass.submitKind !== expectedSubmitKind) contractError('unexpected submit kind');
    /* scopeKind is optional because a proof without it (an older runner) was already complete;
     * when present it must be one of the two scopes the runner can actually bind. It is exactly
     * the key whose arrival as an UNKNOWN key rejected every production submission on 2026-08-11,
     * so it is named here rather than tolerated generically: any other new key still fails closed. */
    if (!isRecord(pass.scope) || !hasOnlyKeys(pass.scope, [
      'formFingerprint', 'submitFingerprint', 'formMatchCount', 'submitMatchCount',
      'requiredControlCount', 'sameNode',
    ], ['scopeKind'])) contractError('scope proof');
    if (pass.scope.scopeKind !== undefined && pass.scope.scopeKind !== 'form' && pass.scope.scopeKind !== 'container') {
      contractError('scope kind');
    }
    if (!opaqueFingerprint(pass.scope.formFingerprint)
      || !opaqueFingerprint(pass.scope.submitFingerprint)
      || pass.scope.formMatchCount !== 1 || pass.scope.submitMatchCount !== 1
      || typeof pass.scope.sameNode !== 'boolean' || !Number.isInteger(pass.scope.requiredControlCount)
      || (pass.scope.requiredControlCount as number) < 0
      || (pass.scope.requiredControlCount as number) > 500) contractError('scope identity');
    if (pass.submissionOutcome !== 'clicked' && pass.submissionOutcome !== 'blocked') {
      contractError('submission outcome');
    }
    const blockerReasons = new Set([
      'submit_node_replaced', 'ambiguous_submit', 'form_identity_changed', 'no_submit_control',
    ]);
    if (pass.blockerReason !== undefined
      && (typeof pass.blockerReason !== 'string' || !blockerReasons.has(pass.blockerReason))) {
      contractError('blocker reason');
    }
    if (typeof pass.blockerReason === 'string') blockerFailures.push(pass.blockerReason);
    if (pass.scope.sameNode === false && pass.blockerReason !== 'submit_node_replaced') {
      contractError('detached node reason');
    }
    if (!Number.isInteger(pass.retries) || (pass.retries !== 0 && pass.retries !== 1)) contractError('retries');
    if (!Array.isArray(pass.requiredControls) || !Array.isArray(pass.attempts) || !Array.isArray(pass.unresolved)) {
      contractError('arrays');
    }
    const controls = pass.requiredControls.map((control) => parseRequiredControl(control, true));
    if (controls.some((control) => control === null)) contractError('required control');
    const requiredControls = controls as RequiredControlProof[];
    if (pass.scope.requiredControlCount !== requiredControls.length) contractError('scan control count');
    const requiredBySelector = new Map<string, RequiredControlProof>();
    for (const control of requiredControls) {
      if (requiredBySelector.has(control.selector)) contractError('duplicate required control');
      requiredBySelector.set(control.selector, control);
    }
    const attempts = pass.attempts.map((value) => {
    if (!isRecord(value) || !hasOnlyKeys(value, ['selector', 'label', 'fieldType', 'outcome', 'attemptCount'], ['reason'])) {
      contractError('attempt shape');
    }
    const control = parseRequiredControl({ selector: value.selector, label: value.label, fieldType: value.fieldType });
    if (!control) contractError('attempt control');
    if (typeof value.outcome !== 'string' || !REQUIRED_CONFIRMATION_OUTCOMES.has(value.outcome)) {
      contractError('attempt outcome');
    }
    if (value.attemptCount !== 1 && value.attemptCount !== 2) contractError('attempt count');
    if (value.outcome === 'already_committed' && value.attemptCount !== 1) {
      contractError('already committed retry');
    }
    const reason = value.reason;
    if (value.outcome === 'failed') {
      if (typeof reason !== 'string' || !reason.trim() || reason.length > 300) contractError('failed attempt reason');
    } else if (reason !== undefined) {
      contractError('successful attempt reason');
    }
    return {
      ...control,
      outcome: value.outcome,
      attemptCount: value.attemptCount,
      reason: typeof reason === 'string' ? reason.trim() : undefined,
    };
    });
    if (attempts.length !== requiredControls.length) contractError('attempt coverage count');
    const attempted = new Set<string>();
    for (const attempt of attempts) {
      const required = requiredBySelector.get(attempt.selector);
      if (!required || attempted.has(attempt.selector)) contractError('attempt coverage');
      if (attempt.fieldType !== required.fieldType || attempt.label !== required.label) contractError('attempt identity');
      attempted.add(attempt.selector);
    }
    const observedRetries = attempts.some((attempt) => attempt.attemptCount === 2) ? 1 : 0;
    if (pass.retries !== observedRetries) contractError('retry evidence');
    const knownUnresolved = new Set(requiredControls.flatMap((control) => [control.selector, control.label].filter(Boolean) as string[]));
    const unresolved: string[] = [];
    for (const value of pass.unresolved) {
      if (typeof value !== 'string' || !value.trim() || value.length > UNRESOLVED_ENTRY_MAX_LENGTH) {
        contractError('unresolved field');
      }
      unresolved.push(readUnresolvedEntry(value.trim(), knownUnresolved));
    }
    const failedAttempts = attempts.filter((attempt) => attempt.outcome === 'failed')
      .map((attempt) => attempt.label || attempt.selector);
    const failures = [...unresolved, ...failedAttempts];
    allFailures.push(...failures);
    if (pass.submissionOutcome === 'clicked'
      && (failures.length > 0 || pass.blockerReason !== undefined || pass.scope.sameNode !== true)) {
      contractError('invalid atomic click proof');
    }
    if (pass.submissionOutcome === 'blocked' && failures.length === 0 && pass.blockerReason === undefined) {
      contractError('blocked pass without reason');
    }
  }
  if (proof.status === 'confirmed' && (allFailures.length > 0 || blockerFailures.length > 0)) contractError('confirmed with failures');
  if (proof.status === 'blocked' && allFailures.length === 0 && blockerFailures.length === 0) contractError('blocked without failure');
  if (proof.status !== 'confirmed') {
    throw new ManagedRequiredFieldConfirmationError([...allFailures, ...blockerFailures]);
  }
}

/* THE PRE-SUBMIT GATE.
 *
 * Read immediately before the final click, and it separates two things that look identical in a
 * screenshot and mean opposite things.
 *
 *   1. A required control that is genuinely still empty. Pressing submit here either bounces off
 *      the employer's own validation or sends an application with blank answers in the applicant's
 *      name. An employer keeps the first application it receives, so this is not recoverable.
 *
 *   2. Error text left over from an EARLIER validation pass. Measured on the live Redwood Materials
 *      Greenhouse form on 2026-08-08: one stray keystroke ran the employer's validator while the
 *      form was half filled, six "is required" messages rendered, and NOT ONE cleared when those
 *      fields were subsequently filled correctly - "Phone is required." was still on screen
 *      underneath a filled phone number. Submitting that same form then passed validation with zero
 *      errors and posted normally.
 *
 * So error TEXT is never on its own a reason to refuse. A message blocks only when the control it
 * belongs to is also empty. Refusing on text alone would throw away complete, correct applications,
 * which is the same harm as sending a broken one and considerably harder to notice.
 *
 * Passed to page.evaluate() as a source STRING for the same reason as DISCOVER_QUESTIONS_SCRIPT:
 * this project's tsconfig has no "dom" lib, so a typed function here would need document,
 * getComputedStyle and CSS typed against a lib the backend deliberately does not pull in.
 *
 * Kept deliberately in step with the managed runner's own gate in stratus-browser-cloud
 * (src/managed-browser.js). Two providers that disagree about whether a form is ready to send is a
 * worse failure than either being wrong on its own.
 */
export const READ_SUBMIT_READINESS_SCRIPT = String.raw`(() => {
  const scanRoot = document.querySelector('[data-litos-submit-scope-v1="active"]');
  if (!scanRoot) return { blocking: ['Litos could not bind required-field validation to the selected application form'], stale: [] };
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim().replace(/[\s*:]+$/, '');
  const renderedText = (node) => {
    if (!node) return '';
    return typeof node.innerText === 'string' ? node.innerText : (node.textContent || '');
  };
  const isVisible = (element) => {
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden';
  };
  // The block that owns one question: its label, its control, and its error line.
  const widgetOf = (element) => element.closest(
    '[class*="select__container"], .field, .field-wrapper, .file-upload, fieldset, [role="group"], [data-input-type]'
  ) || element.parentElement || element;
  /* THE LABEL THAT WRAPS ITS CONTROL AND NEVER NAMES IT.
   *
   * '<label>First name<input required></label>' is a legal HTML label association and carries no
   * "for" attribute, so the byFor lookup below finds nothing and widgetOf falls back to the label
   * itself, whose querySelector('label') then finds no label INSIDE it. Greenhouse's first-name,
   * last-name and resume fields are all built this way, and the gate reported all three as
   * "A required field on the form has no label Litos can read, and is still empty" - a refusal the
   * applicant cannot act on, on the three most obvious fields on the form.
   *
   * Disqualified when the label wraps MORE than one control, because a label that speaks for
   * several controls speaks for none of them in particular and would name a whole radio row after
   * its question. That case is already served by the legend and aria-labelledby candidates.
   */
  const wrappingLabelTextOf = (element) => {
    const wrapper = element && element.closest && element.closest('label');
    if (!wrapper) return '';
    if (wrapper.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"]').length > 1) return '';
    return renderedText(wrapper);
  };
  /* The question a control sits under, when the control itself is labelled with nothing useful.
   * Last resort, and deliberately below the wrapping label. It is the only thing that names an
   * Ashby datepicker, whose own label text is "Pick date...". Kept in step with the managed
   * runner's gate in stratus-browser-cloud.
   *
   * A BLOCK HOLDING MORE THAN ONE CONTROL IS REJECTED, because its first label is then somebody
   * else's. Measured against the SmartRecruiters fixture, whose resume input sits bare inside an
   * <spl-dropzone> with no label of any kind: without this test the walk reached the form's field
   * grid and reported the missing resume as "First name is required and is still empty", twice
   * over, and the applicant was never told which document was missing. A wrong name is worse than
   * no name, so an ambiguous block yields nothing and the honest "no label Litos can read" stands.
   */
  const genericControlText = (value) => /^(pick|select|choose)\s+(date|option)|^(type|enter|write)\s+(your\s+)?(answer\s+)?here/i.test(clean(value));
  const nearestQuestionText = (start) => {
    let block = start && start.parentElement;
    for (let depth = 0; block && depth < 6; depth += 1, block = block.parentElement) {
      if (!block.matches || !block.matches('div, section, li, fieldset')) continue;
      if (block.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"]').length > 1) return '';
      const candidate = block.querySelector('label, legend, .question, h3, h4');
      const text = clean(renderedText(candidate));
      if (text && !genericControlText(text)) return text;
    }
    return '';
  };
  const labelOf = (widget, element) => {
    const labelledBy = (widget && widget.getAttribute('aria-labelledby'))
      || (element && element.getAttribute('aria-labelledby'));
    // A Workable composite can keep the question label on its listbox opener, but arbitrary
    // aria-labelledby descendants are not label proxies. In particular, the country-code combobox
    // inside a directly labelled phone widget must not rename that phone field.
    const proxyLabelledBy = widget
      && widget.querySelector('[role="combobox"][aria-labelledby], [aria-haspopup="listbox"][aria-labelledby]')
        ?.getAttribute('aria-labelledby');
    const referenced = labelledBy && document.getElementById(labelledBy.split(/\s+/)[0]);
    const proxyReferenced = proxyLabelledBy && document.getElementById(proxyLabelledBy.split(/\s+/)[0]);
    const byFor = element && element.id && document.querySelector('label[for="' + CSS.escape(element.id) + '"]');
    const legend = widget && widget.querySelector('legend');
    const own = widget && widget.querySelector('label, .label, .upload-label, legend');
    for (const candidate of [
      renderedText(referenced),
      renderedText(byFor),
      wrappingLabelTextOf(element),
      renderedText(proxyReferenced),
      renderedText(legend),
      renderedText(own),
      element && element.getAttribute('aria-label'),
      widget && widget.getAttribute('aria-label'),
      nearestQuestionText(element)
    ]) {
      const text = clean(candidate);
      if (!text) continue;
      if (genericControlText(text)) continue;
      // A machine identifier is not a label. Greenhouse names custom questions with UUIDs and
      // numeric tokens, and "question_19302464004 is required" tells the applicant nothing.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) continue;
      if (!/[a-z]/i.test(text)) continue;
      return text.slice(0, 120);
    }
    return '';
  };
  // Asked of the WIDGET, because on the two control families that matter the answer does not live
  // in an input's value at all:
  //   - a React Select renders its answer as .select__single-value text and shows
  //     .select__placeholder when it has none, and CLEARS the combobox input's search text on
  //     selection, so reading the input calls every answered question empty;
  //   - Greenhouse's uploader REMOVES the file input once the upload finishes and replaces it with
  //     a filename chip, so "no input[type=file] holding a file" is true of a widget that has
  //     already been given one.
  /* AN ANSWER THAT IS A PRESSED BUTTON, WHICH IS HOW ASHBY RENDERS EVERY YES/NO QUESTION.
   *
   * Ashby draws work authorization and sponsorship as a segmented control: a row of buttons plus
   * one 'display:none' mirror input that carries the value. Measured on the live form: pressing
   * "Yes" checks the mirror, pressing "No" leaves it UNCHECKED. So the mirror cannot tell "No"
   * apart from unanswered, and the loop below skips it anyway for being hidden. The pressed state
   * of the button is the ONLY place the answer is legible.
   *
   * Until this was read, every Ashby packet carrying a work-eligibility question stayed in
   * needs_attention forever: the applicant answered it, the gate still called it empty, and the
   * submit was refused on a field that was already correct.
   *
   * Read three ways because three families spell the same state differently: the ARIA states
   * (role="radio" aria-checked, aria-pressed, aria-selected), a data-state attribute, and Ashby's
   * own CSS-module class - verified in its stylesheet on 2026-08-09, '._active_1svni_57' sits in
   * the same module as the pill class '._option_1svni_32' and is the rule that paints the chosen
   * pill. The hash changes between bundles, so the match is on the module-name fragment.
   *
   * ONLY EVER MAKES THE GATE QUIETER. The caller acts on a true and on nothing else, so a block
   * that holds pill-shaped buttons and no chosen one still falls through to its real controls. That
   * asymmetry is deliberate: a filled text input sitting beside a button this recogniser guessed
   * wrong about must not be reported empty, because a gate that refuses a complete application is
   * how 79 prepared resumes produced 0 sent applications.
   */
  const PILL_SELECTED = /_active_|_selected_|_checked_/;
  const chosenPillOf = (scope) => {
    if (!scope || !scope.querySelectorAll) return null;
    const pills = [...scope.querySelectorAll('button, [role="radio"], [role="option"], [role="tab"]')].filter((pill) => {
      const text = clean(pill.textContent);
      // The same exclusion list the extension's Ashby adapter uses: a block can also hold upload,
      // remove and submit controls, and "Submit application" is not an answer to anything.
      return text.length > 0 && text.length <= 40
        && !/upload|replace|drag|drop|submit|browse|remove|delete|\bsave\b|cancel|\+\s*add/i.test(text);
    });
    if (pills.length === 0) return null;
    return pills.some((pill) => PILL_SELECTED.test(String(pill.className || ''))
      || pill.getAttribute('aria-pressed') === 'true'
      || pill.getAttribute('aria-checked') === 'true'
      || pill.getAttribute('aria-selected') === 'true'
      || /^(?:on|true|active|selected|checked)$/i.test(pill.getAttribute('data-state') || ''));
  };
  const widgetHasAnswer = (widget) => {
    if (!widget) return false;
    if (widget.matches?.('[${WORKABLE_CHOICE_UNCONFIRMED_ATTR}="true"]')
      || widget.querySelector('[${WORKABLE_CHOICE_UNCONFIRMED_ATTR}="true"]')) return false;
    if (widget.querySelector('[class*="select__single-value"], [class*="select__multi-value__label"]')) return true;
    if (widget.querySelector('[class*="select__placeholder"]')) return false;
    if (widget.querySelector('.file-upload__filename, [class*="file-upload__filename"], [aria-label="Remove file" i]')) return true;
    if (chosenPillOf(widget) === true) return true;
    for (const control of widget.querySelectorAll('input, textarea, select')) {
      if (control.type === 'hidden') continue;
      if (control.type === 'file') {
        if (control.files && control.files.length > 0) return true;
        continue;
      }
      if (control.type === 'checkbox' || control.type === 'radio') {
        if (control.checked) return true;
        continue;
      }
      if (control.getAttribute('role') === 'combobox') continue;
      if (clean(control.value)) return true;
    }
    return false;
  };
  // A scalar control owns its own answer. Reading its entire widget is unsafe when widgetOf had to
  // fall back to a broad parent such as the form: a different filled field can then answer this
  // empty one. Composite controls are intentionally excluded here because their answer lives in
  // the widget, not in this element: React Select renders a value chip, file uploaders render a
  // filename, and checkbox or radio peers answer one question together.
  const scalarAnswerOf = (element) => {
    if (!element?.matches?.('input, textarea, select')) return null;
    const type = (element.getAttribute('type') || '').toLowerCase();
    if (/^(hidden|file|checkbox|radio)$/.test(type)) return null;
    if (element.getAttribute('role') === 'combobox') return null;
    return Boolean(clean(element.value));
  };
  const semanticChoiceGroupOf = (element) => element?.closest?.(
    '[role="group"][aria-labelledby], [role="group"][aria-label],'
    + ' [role="radiogroup"][aria-labelledby], [role="radiogroup"][aria-label]'
  ) || null;
  const choiceAnswerOf = (widget, element) => {
    if (!element || (element.type !== 'checkbox' && element.type !== 'radio')) return null;
    const semanticGroup = semanticChoiceGroupOf(element);
    if (semanticGroup) {
      const peers = [...semanticGroup.querySelectorAll('input[type="checkbox"], input[type="radio"]')];
      return {
        key: semanticGroup,
        answered: peers.some((peer) => peer.checked) || chosenPillOf(semanticGroup) === true,
      };
    }
    const choiceRoot = element.form || scanRoot;
    const allChoices = [...choiceRoot.querySelectorAll('input[type="checkbox"], input[type="radio"]')];
    const peers = element.name
      ? allChoices.filter((peer) => peer.name === element.name)
      : [element];
    // A pressed pill may carry the answer for one hidden mirror input, most notably Ashby "No".
    // Read it only from a container whose native choices all belong to this exact name group. An
    // outer fieldset holding several independent questions is not one control-specific composite.
    const narrowComposite = element.closest(
      '[data-field-path], [class*="_fieldEntry_"], [class*="_yesno_"], .field, .field-wrapper, [data-input-type]'
    );
    const ownsOnlyPeers = (scope) => {
      if (!scope) return false;
      const choices = [...scope.querySelectorAll('input[type="checkbox"], input[type="radio"]')];
      return choices.length > 0 && choices.every((candidate) => peers.includes(candidate));
    };
    const composite = ownsOnlyPeers(narrowComposite)
      ? narrowComposite
      : ownsOnlyPeers(widget) ? widget : null;
    return {
      key: peers[0] || element,
      answered: peers.some((peer) => peer.checked) || chosenPillOf(composite) === true,
    };
  };
  const blocking = [];
  const seen = new Set();
  const note = (widget, element) => {
    if (!widget) return;
    const unconfirmedChoice = widget.matches?.('[${WORKABLE_CHOICE_UNCONFIRMED_ATTR}="true"]')
      || widget.querySelector('[${WORKABLE_CHOICE_UNCONFIRMED_ATTR}="true"]');
    const scalarAnswer = unconfirmedChoice ? null : scalarAnswerOf(element);
    const choiceAnswer = unconfirmedChoice ? null : choiceAnswerOf(widget, element);
    // Scalar controls are separate questions even when widgetOf falls back to one broad parent.
    // Choice controls use their exact labeled group or HTML name peers for the same reason. Other
    // composites retain widget-level deduplication so one upload or React Select is not repeated.
    const key = scalarAnswer !== null
      ? element
      : choiceAnswer ? choiceAnswer.key : widget;
    if (!key || seen.has(key)) return;
    seen.add(key);
    if (!isVisible(widget)) return;
    const answered = scalarAnswer !== null
      ? scalarAnswer
      : choiceAnswer ? choiceAnswer.answered : widgetHasAnswer(widget);
    if (answered) return;
    const label = labelOf(widget, element);
    blocking.push(label
      ? '"' + label + '" is required and is still empty'
      : 'A required field on the form has no label Litos can read, and is still empty');
  };
  // A failed exact choice replay is a blocker even when the ATS omitted its own required marker.
  // Scan this first so native-required children resolve to their semantic question group below.
  for (const widget of scanRoot.querySelectorAll('[${WORKABLE_CHOICE_UNCONFIRMED_ATTR}="true"]')) {
    const element = widget.querySelector('input, textarea, select') || widget;
    note(widget, element);
  }
  // Native required, PLUS aria-required. React Select's input carries aria-required="true" and no
  // required attribute at all, so a gate built only on [required] cannot see an unanswered
  // Greenhouse screener question - which is exactly the control this gate exists to catch.
  for (const element of scanRoot.querySelectorAll(
    '${SUBMIT_READINESS_REQUIRED_ATTRIBUTES}'
  )) {
    if (element.disabled) continue;
    if (!isVisible(element) && !isVisible(widgetOf(element))) continue;
    const failedChoice = element.closest('[${WORKABLE_CHOICE_UNCONFIRMED_ATTR}="true"]');
    note(failedChoice || widgetOf(element), element);
  }
  /* THE REQUIRED MARKER THAT IS NEITHER AN ATTRIBUTE NOR AN ARIA STATE.
   *
   * Two more spellings of "this field, in particular", one per ATS family, both read off ONE
   * control's own label and neither off page text. Kept in step, loop for loop, with the managed
   * runner's gate in stratus-browser-cloud, where the class arm shipped as PR #22.
   *
   *   ASHBY marks the question's <label> with a CSS-module class and paints the asterisk from it:
   *   '._required_f7cvd_91:after{content:"*"}', read out of Ashby's stylesheet on 2026-08-09. The
   *   mark is therefore a pseudo-element that appears in no attribute and in no text anywhere.
   *   Measured on the live Deepgram form behind packet 245c827a, which shipped as "Done - 5 checked"
   *   with three required fields empty: SIX controls carry 'required', ZERO carry aria-required, and
   *   the three empty ones - Current Location and both work-eligibility questions - carry neither.
   *
   *   GREENHOUSE prints the character itself into the label text. Measured read-only on the live
   *   zscaler posting, 19 of its 30 labels carry a standalone "*", and on yugabyte 3 of 23.
   *
   * WHY THIS IS NOT THE 2026-08-08 MISTAKE. An earlier gate matched the form's own legend text,
   * "* indicates a required field", and would have refused EVERY Greenhouse submission there is
   * (LEGEND_TEXT below is what remains of it). Neither loop reads page text. Each reads ONE element
   * - a <label> or <legend> that speaks for ONE control - and a page-level notice is a <p>, not a
   * label, so it cannot reach either. ASTERISK_LEGEND excludes that same sentence a second time for
   * the boards that do print it inside a label block.
   *
   * The asterisk test is labelMarksRequired's, character for character (questionDiscovery.ts), so
   * discovery and this gate cannot disagree about which fields the employer marked required.
   *
   * MEASURED CONTRIBUTION, read-only against live forms on 2026-08-09. On the zscaler and yugabyte
   * Greenhouse postings the asterisk loop adds ZERO blockers, because every field it finds already
   * carries 'required' or aria-required. On the Deepgram, Ramp and Linear Ashby forms it matches
   * ZERO labels, because Ashby prints no asterisk anywhere. It earns its place on the one shape
   * neither attribute loop can see: a Greenhouse screener question marked with a red asterisk and
   * nothing else.
   *
   * note() dedupes on the widget, so a field caught by an attribute loop and by one of these is
   * still reported once.
   */
  // The control a marked label speaks for. "for=" first, because it is the employer's own statement
  // of which control the mark belongs to, and Ashby sets it even where the input it names has no id
  // (the location combobox), in which case the block's first real control is the right answer. A
  // file input is excluded from the fallback for the same reason widgetHasAnswer treats uploads
  // specially: the block, not the input, holds the evidence of an upload.
  const noteMarkedLabel = (marker, widgetFallback) => {
    const widget = widgetOf(marker);
    if (!widget || !isVisible(widget)) return;
    const named = marker.getAttribute('for');
    const controls = [...widget.querySelectorAll(
      'input:not([type="hidden"]):not([type="file"]), textarea, select, [role="combobox"]'
    )];
    const explicitlyRequired = controls.filter((candidate) => marker.contains(candidate)
      && !candidate.disabled
      && (candidate.required || candidate.getAttribute('aria-required') === 'true'));
    const target = (named && widget.querySelector('#' + CSS.escape(named)))
      // Workable wraps its country-code combobox and required phone input in one starred label,
      // with the combobox first in DOM order. The star belongs to the one descendant Workable
      // actually marks required, not to that adjacent opener. Prefer that unambiguous machine
      // signal only when the marked label owns that control. A broad widget fallback can be
      // the entire form, and must not borrow an unrelated required field. Retain the existing
      // first-control fallback for zero or multiple marked descendants.
      || (explicitlyRequired.length === 1 ? explicitlyRequired[0] : null)
      || controls[0]
      || (widgetFallback ? widget : null);
    if (!target || target.disabled) return;
    note(widget, target);
  };
  for (const marker of scanRoot.querySelectorAll('${SUBMIT_READINESS_REQUIRED_CLASS_MARKERS}')) {
    // An Ashby question block with no readable control still has to block, which is where PR #22
    // measured this arm.
    noteMarkedLabel(marker, true);
  }
  const ASTERISK_MARK = /${SUBMIT_READINESS_ASTERISK_MARK}/;
  const ASTERISK_LEGEND = /${SUBMIT_READINESS_ASTERISK_LEGEND}/i;
  for (const marker of scanRoot.querySelectorAll('label, legend')) {
    const markerText = (marker.textContent || '').replace(/\s+/g, ' ').trim();
    if (!ASTERISK_MARK.test(markerText) || ASTERISK_LEGEND.test(markerText)) continue;
    // No widget fallback: "a label somewhere carries a star and I could not find its control" is
    // not evidence that an application is incomplete.
    noteMarkedLabel(marker, false);
  }
  const stale = [];
  const ERROR_TEXT = /${SUBMIT_READINESS_ERROR_TEXT}/i;
  // A form's own legend says "* indicates a required field", and it matches the line above. On the
  // live Redwood form that legend was the ONLY thing an early version of this found on a completely
  // and correctly filled application, so the gate would have refused every Greenhouse submission
  // there is. A gate that blocks everything is not caution.
  const LEGEND_TEXT = /${SUBMIT_READINESS_LEGEND_TEXT}/i;
  for (const element of scanRoot.querySelectorAll('*')) {
    if (element.children.length > 0) continue;
    const text = clean(element.textContent);
    if (!text || text.length > 160 || !ERROR_TEXT.test(text) || LEGEND_TEXT.test(text)) continue;
    if (!isVisible(element)) continue;
    const widget = widgetOf(element);
    if (!widget || widget === element) continue;
    // A message in a block that holds no control at all is not a field error. It is a legend or a
    // page-level notice, and attributing it to a field invents a blocker.
    // A list rather than the first match, purely so the skip below can be the SAME statement the
    // managed runner's copy of this loop runs. That copy has to pick between several controls in one
    // block, this one takes the first, and neither difference is anything the skip needs to know.
    const controls = [...widget.querySelectorAll('input:not([type="hidden"]), textarea, select, [role="combobox"]')];
    const control = controls[0];
    if (!control) continue;
    /* THE FIELD'S OWN QUESTION IS NOT THE FIELD'S OWN COMPLAINT.
     *
     * A <label for="..."> naming this widget's control is the employer ASKING, and reading it as
     * the employer REFUSING blocks a field on the strength of its own wording. Measured read-only
     * against the live Greenhouse markup on 2026-08-13: Scale AI's question_8788020005 is labelled
     * "If yes, please provide further explanation below." and carries aria-required="false", no
     * required attribute and no asterisk, and DV Trading's question_8954179005 is the same shape.
     * "please provide" is in ERROR_TEXT, and a label is a LEAF element exactly when the field is
     * optional, because a required Greenhouse label carries <span aria-hidden="true">*</span> inside
     * it. So this loop could only ever mis-fire on fields the employer left optional, and it did:
     * four Scale AI and three DV Trading packets stopped on a field neither form requires, and each
     * one also reported "1 required field has no question you can answer in Litos" about it, since
     * an optional field correctly has no question record.
     *
     * THIS OPENS NO HOLE ON A REQUIRED FIELD. Every field this loop can reach that the employer
     * really does mark required is already reached by the three loops above it - the native and
     * aria-required scan, the _required_ class marker, and the asterisk marker - and note() dedupes
     * on the widget, so a genuinely required field caught there is unaffected by anything skipped
     * here. What is given up is a field whose ONLY evidence of being required is that its own label
     * happens to contain "please provide", which was never evidence.
     *
     * NOW ONE STATEMENT, SHARED, RATHER THAN TWO THAT AGREE. When this was written it lived only
     * here, and the copy in stratus-browser-cloud that actually drives a managed application went on
     * producing the sentences above for the whole life of the fix. It is now interpolated from
     * lib/submitReadinessGrammar.ts, whose hash both repos pin, so the next divergence has to change
     * a literal that is one string search away in the file that must match it. */
    ${SUBMIT_READINESS_OWN_QUESTION_SKIP}
    if (widgetHasAnswer(widget)) { stale.push(text); continue; }
    // note() dedupes on the widget, so a field already reported by the scan above is not counted
    // twice for also carrying the matching error line.
    note(widget, control);
  }
  /* Deduped by MESSAGE as well as by widget, which the managed runner's copy of this gate already
     does. Keying only on the widget reports one question twice whenever it wears two blocks: an
     unanswered React Select carries aria-required on both its combobox input and the hidden input
     react-select keeps beside it, and the two resolve to the same question and the same label.
     Measured on the live Deepgram Ashby form, empty: 18 entries covering 15 distinct questions,
     against the managed runner's 15 for the same page. Two providers handing the applicant
     different-length lists for one form is the drift these two copies exist to avoid, and removing
     a duplicate can only ever make this gate quieter. */
  return { blocking: Array.from(new Set(blocking)), stale: Array.from(new Set(stale)) };
})()`;

export type SubmitReadiness = { blocking: string[]; stale: string[] };

export async function readSubmitReadiness(page: Page): Promise<SubmitReadiness> {
  const raw = await page.evaluate(READ_SUBMIT_READINESS_SCRIPT) as Partial<SubmitReadiness> | null;
  return {
    blocking: Array.isArray(raw?.blocking) ? raw!.blocking : [],
    stale: Array.isArray(raw?.stale) ? raw!.stale : [],
  };
}

/* ONE READER, USED BY BOTH PASSES.
 *
 * It was two, and the second was a strict subset of the first: selection read title and
 * aria-labelledby and the UA default, the pre-click re-check read only innerText/value/aria-label.
 * So an <input type=submit> with no value - the exact control the fallbacks were added for -
 * selected fine and then re-read as the empty string, and a page with one perfectly good submit
 * button threw "the submit button changed to ''" and sent nothing. Two copies of a rule is one
 * copy too many when disagreeing between them means no application is ever submitted.
 *
 * Serialised into the page, so it is written against a hand-rolled shape rather than the DOM lib:
 * those types are not in scope for the server build.
 */
export const READ_CONTROL_LABEL = (node: unknown) => {
  const el = node as unknown as {
    innerText?: string; value?: string; title?: string; disabled?: boolean; type?: string;
    tagName?: string;
    getAttribute(name: string): string | null; getClientRects(): { length: number };
  };
  /* A control the accessibility tree would not offer is not a submit button. getByRole did this
     filtering for us; a raw CSS selector does not, and innerText falls back to textContent on a
     hidden node, so a display:none mobile duplicate reads as a perfectly good "Submit
     application" - which the last-wins rule would then prefer over the real one. */
  if (el.disabled === true) return '';
  /* `disabled` is meaningless on a [role=button] div, which is how several ATSs render their
     controls, so the ARIA form has to be honoured too. */
  if (el.getAttribute('aria-disabled') === 'true') return '';
  if (el.getAttribute('aria-hidden') === 'true') return '';
  if (el.getClientRects().length === 0) return '';
  /* getClientRects() is non-empty for visibility:hidden, and aria-hidden hides a whole SUBTREE.
     getByRole excluded both; a raw selector plus a self-only check does not, so a responsive
     duplicate hidden either way still reads as a perfectly good "Submit application". */
  const view = (node as unknown as { ownerDocument: { defaultView: {
    getComputedStyle(e: unknown): { visibility: string } } } }).ownerDocument.defaultView;
  if (view.getComputedStyle(node).visibility === 'hidden') return '';
  let parent = (node as unknown as { parentElement: unknown }).parentElement as {
    getAttribute(name: string): string | null; parentElement: unknown } | null;
  while (parent) {
    if (parent.getAttribute('aria-hidden') === 'true') return '';
    parent = parent.parentElement as typeof parent;
  }
  const labelledBy = el.getAttribute('aria-labelledby');
  const referenced = labelledBy
    ? (node as unknown as { ownerDocument: { getElementById(id: string): { innerText?: string } | null } })
      .ownerDocument.getElementById(labelledBy.split(/\s+/)[0]!)?.innerText ?? ''
    : '';
  /* An <input type=submit> with no value attribute renders the UA default "Submit" and reports
     value === '', so without this a real submit reads as unlabelled and gets skipped.
     GATED ON THE TAG, NOT THE TYPE, and that distinction is the whole thing: HTMLButtonElement.type
     ALSO defaults to "submit" and its value defaults to "", so keying off type alone made every
     text-free icon button - a chat launcher, a scroll-to-top, a cookie close - read as "Submit".
     Those sit at the foot of the page, which is exactly where last-wins looks. */
  const uaDefault = el.tagName === 'INPUT' && el.type === 'submit' && !el.value ? 'Submit' : '';
  return (el.innerText || el.value || el.getAttribute('aria-label') || el.title || referenced
    || el.getAttribute('alt') || uaDefault || '').trim();
};

/** How long to give a submit control that is disabled until client-side validation settles. */
const SUBMIT_ENABLE_WAIT_MS = 3_000;

/**
 * Commit the values already present in required controls on the exact form owned by the retained
 * submit handle. This does not invent answers. It emits the framework event sequence ATS clients
 * use to move a visually filled value into validation state, then proves the sequence did not
 * change the selected value. The scope marker is consumed by READ_SUBMIT_READINESS_SCRIPT.
 *
 * KEPT AS TEXT, for the exact reason READ_FIELD_GROUP_DIAL_CODES_SCRIPT is: this is handed to
 * Playwright's elementHandle.evaluate(), which serialises it with Function.prototype.toString()
 * and re-parses the source INSIDE THE PAGE. Written as an ordinary TypeScript arrow function, under
 * any bundler that transpiles with esbuild's keepNames (tsx's dev/watch runner is one; a Vercel
 * Node.js function built from TypeScript source can be another), the compiled source wraps this in
 * a `__name(...)` call that only exists in the bundle's own scope. The page then throws
 * `ReferenceError: __name is not defined`, elementHandle.evaluate rejects, the call site's
 * `.catch(() => null)` swallows it, and clickFinalSubmit reports "Litos could not bind
 * required-field confirmation to the selected application form" - on every submission, on every
 * board, regardless of whether the form was actually fine. Measured 2026-08-20 against the
 * portal-shapes trial's phone-country and security-code cases, both of which never reached
 * COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT's own logic at all; the failure was in getting the function
 * into the page intact. Text is untouchable by a bundler, which is the property this needs.
 */
const COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT_SCRIPT = String.raw`async (node) => {
  const button = node;
  // Browser DOM elements always expose closest(). A handful of isolated unit doubles predate this
  // callback and intentionally model only label reads. Keep those doubles usable without treating
  // a real DOM node that has no owning form as confirmed.
  if (typeof button.closest !== 'function') return { formFound: true, changed: false, committed: 0 };
  const form = button.closest('form');
  if (!form) return { formFound: false, changed: false, committed: 0 };
  form.setAttribute('data-litos-submit-scope-v1', 'active');
  const view = button.ownerDocument.defaultView;
  const controls = Array.from(form.querySelectorAll(
    '[required], [aria-required="true"], [role="radio"][aria-checked="true"], [role="checkbox"][aria-checked="true"]',
  ));
  const markers = Array.from(form.querySelectorAll(
    'label[class*="_required_"], legend[class*="_required_"], label, legend',
  ));
  const controlSelector = 'input:not([type="hidden"]), textarea, select, [role="combobox"], [role="radio"], [role="checkbox"]';
  for (const marker of markers) {
    const className = typeof marker.className === 'string' ? marker.className : '';
    const literalStar = /\*\s*$/.test((marker.textContent ?? '').trim());
    if (!literalStar && !className.includes('_required_')) continue;
    const named = marker.getAttribute('for');
    const wrapper = marker.closest('fieldset, .field, .field-wrapper, [class*="field"], [role="group"]');
    const candidate = marker.control
      || (named ? button.ownerDocument.getElementById(named) : null)
      || marker.querySelector(controlSelector)
      || wrapper?.querySelector(controlSelector)
      || marker.parentElement?.querySelector(controlSelector);
    if (candidate && !controls.includes(candidate)) controls.push(candidate);
  }
  const state = (control) => JSON.stringify({
    value: control.value ?? null,
    checked: control.checked ?? null,
    ariaChecked: control.getAttribute('aria-checked'),
    files: control.files?.length ?? null,
  });
  let committed = 0;
  let changed = false;
  for (const control of controls) {
    const style = view.getComputedStyle(control);
    if (control.disabled || control.getClientRects().length === 0
      || style.display === 'none' || style.visibility === 'hidden') continue;
    const before = state(control);
    control.focus?.();
    const role = control.getAttribute('role');
    const selectedCustom = (role === 'radio' || role === 'checkbox')
      && control.getAttribute('aria-checked') === 'true';
    if (selectedCustom) {
      // Custom controls often commit only on their exact click handler. Prevent the browser default
      // and verify the selected answer snapshot after the framework has processed the event.
      const click = new view.Event('click', { bubbles: true, cancelable: true });
      click.preventDefault();
      control.dispatchEvent(click);
    } else if (control.type !== 'file') {
      control.dispatchEvent(new view.Event('input', { bubbles: true }));
      control.dispatchEvent(new view.Event('change', { bubbles: true }));
    }
    control.blur?.();
    committed += 1;
    await new Promise((resolve) => view.requestAnimationFrame(resolve));
    if (state(control) !== before) changed = true;
  }
  return { formFound: true, changed, committed };
}`;

export type CommitRequiredControlsResult = { formFound: boolean; changed: boolean; committed: number };

/* new Function compiles the text above in Node, with no bundler in the path, so the function object
   this module exports serialises back out to the exact same text - see readFieldGroupDialCodes for
   the identical pattern. `async` is preserved in the source text itself, so the compiled function
   still returns a Promise and every existing caller (production and this file's own unit tests,
   which call it directly against DOM doubles) keeps working unchanged. */
export const COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT = new Function(
  'node',
  'return (' + COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT_SCRIPT + ')(node);',
) as (node: PlaywrightEvaluationTarget) => Promise<CommitRequiredControlsResult>;

export async function clickFinalSubmit(page: Page): Promise<void> {
  /* ELEMENT HANDLES, NOT nth(). An index is only meaningful against the DOM that produced it, and
     the captcha probe below sits between the two: it can spend the better part of fifteen seconds
     in live round trips, and any re-render, lazy-loaded chat widget or dismissed banner in that
     window shifts every ordinal. `locator.nth(i)` re-queries at click time and carries no label
     constraint, so a shift would land the click on whatever control now holds that position -
     which on these boards is "Apply with LinkedIn" at index 0. A handle references ONE node and
     throws if it detaches, which is the failure we want. */
  let handles: Awaited<ReturnType<ReturnType<Page['locator']>['elementHandles']>> = [];
  /* Flipped immediately before the click, and read in the catch below. Everything up to that point
     is inspection: reading labels, probing for a challenge. If any of it throws - an SPA re-render
     destroying the execution context mid-read is the likely one, and it is the same re-render the
     retry exists to ride out - then no click happened, and a plain Error would reach fail() as
     neither captcha nor no-control and take the uncertainAfterClaim branch: "the final submission
     was attempted... check the portal or your email", for a run that never pressed anything. */
  let clicked = false;
  try {
    handles = await page.locator(SUBMIT_CANDIDATE_SELECTOR).elementHandles();
    let labels = await Promise.all(handles.map((handle) => handle.evaluate(READ_CONTROL_LABEL)));
    let chosen = chooseSubmitControl(labels);

    /* ONE RETRY, and it is not defensive padding. Plenty of ATS forms render the final button
       DISABLED until async client-side validation settles after the fill, and the disabled filter
       reads once, synchronously. The old getByRole().click() waited out that window through
       Playwright's actionability check; reading labels does not, so without this a form that used
       to submit itself quietly becomes a manual handoff.
       INSIDE the try, so the handles it acquires are reachable by the finally even if the wait or
       the second read throws - which is likeliest during exactly the re-render this rides out. */
    if (chosen === null) {
      await page.waitForTimeout(SUBMIT_ENABLE_WAIT_MS);
      await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
      handles = await page.locator(SUBMIT_CANDIDATE_SELECTOR).elementHandles();
      labels = await Promise.all(handles.map((handle) => handle.evaluate(READ_CONTROL_LABEL)));
      chosen = chooseSubmitControl(labels);
    }

    /* THE CAPTCHA PROBE COMES FIRST, before the no-control throw, and the order is the point. A
       challenge routinely suppresses the form entirely, so the page has no submit control BECAUSE
       of the challenge. Reporting "we could not find the button" there hides the one thing the
       applicant can act on, and discards the provider while the page is still open. This mirrors
       fail()'s own precedence, where captchaStop outranks noSubmitControl. */
    if (await hasUnresolvedCaptcha(page)) {
      throw new CaptchaUnresolvedError('at_submit', await detectCaptchaProvider(page));
    }
    if (chosen === null) {
      /* A page whose only apply-ish controls are third-party handoffs, or which renders no controls
         at all, is a page this run cannot finish - and saying so as a type fail() recognises is the
         honest answer. */
      throw new NoSubmitControlError();
    }
    /* Defence in depth, and it covers a case the call-site gate cannot. portalCanAutoSubmit() stops
       the families KNOWN to be gated (JazzHR, BambooHR) before this function is ever reached. It
       knows nothing about a Greenhouse or Lever board whose employer switched a challenge on last
       week. Pressing submit under an unsolved challenge does not just fail: it submits the
       applicant as bot traffic, and the posting can discard it with no error shown to anyone.
       NOTE: this guard only covers the direct-Playwright path. The managed-Stratus path in
       submissionRunner never builds a Page, so it never reaches here. */
    const button = handles[chosen]!;
    const committed = await button.evaluate(COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT).catch(() => null);
    if (committed === null || !committed.formFound || committed.changed) {
      throw new NoSubmitControlError(
        committed?.changed
          ? 'Litos did not submit because required-field confirmation changed a selected answer'
          : 'Litos could not bind required-field confirmation to the selected application form',
      );
    }
    /* THE PRE-SUBMIT GATE, and it sits here for the same reason the captcha probe sits above: after
       the control has been found, before anything is pressed. See READ_SUBMIT_READINESS_SCRIPT for
       why a visible "is required" message is NOT on its own a reason to refuse.
       FAILS CLOSED. If the readiness read itself throws - a re-render destroying the execution
       context is the likely one - this cannot confirm the form is complete, and "we could not
       check, so we sent it anyway" is not a defensible thing to do with a real application. The
       cost of being wrong in this direction is a handoff card telling the applicant to finish it
       herself, which is recoverable; the cost of being wrong in the other direction is an employer
       holding a half-blank application she can never withdraw. */
    const readiness = await readSubmitReadiness(page).catch(() => null);
    if (readiness === null) {
      throw new NoSubmitControlError(
        'Litos could not confirm the form was complete before submitting, so it did not submit',
      );
    }
    if (readiness.blocking.length > 0) throw new FormIncompleteError(readiness.blocking);
    /* Read the label again, off the same node, immediately before pressing it. The handle cannot
       drift to a different element, but the element itself can be relabelled by a re-render, and
       the cost of being wrong here is clicking a handoff on a real application. */
    const finalLabel = await button.evaluate(READ_CONTROL_LABEL);
    if (chooseSubmitControl([finalLabel]) === null) {
      throw new NoSubmitControlError(
        `The submit button changed to "${finalLabel}" before it could be pressed`,
      );
    }
    /* THE BARRIER IS ARMED BEFORE THE CLICK, and that ordering is the whole reason this exists.
       noWaitAfter (below) is what makes "a TimeoutError from click() is pre-dispatch" true rather
       than merely plausible - by default click() awaits scheduled navigations after dispatching,
       inside the same deadline, so a slow confirmation page produced a POST-dispatch timeout that
       got reported as "nothing was sent", and the applicant re-applied into a duplicate.
       But turning that wait off ALSO removes the barrier Playwright had armed before dispatch, and
       without it waitForLoadState resolves against the document we are still standing on: measured
       on an ATS-shaped form, 10 of 15 runs then read the open form rather than the confirmation,
       readReceipt threw, and a genuinely submitted application was reported as unverified. So the
       navigation promise is created HERE, before anything is pressed, and awaited after.
       Five seconds, not twenty: a portal that submits over XHR never navigates at all, and that
       path should not pay a twenty-second wait for a navigation that is never coming. */
    const navigation = page
      .waitForNavigation({ waitUntil: 'networkidle', timeout: 5_000 })
      .catch(() => undefined);
    clicked = true;
    await button.click({ noWaitAfter: true });
    await navigation;
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => undefined);
  } catch (error) {
    if (error instanceof CaptchaUnresolvedError || error instanceof NoSubmitControlError) throw error;
    /* A TIMEOUT FROM click() IS PRE-DISPATCH, and this is the likelier half of the problem. The
       flag is set before the call because the click is the boundary, but Playwright's actionability
       wait fails BEFORE dispatching anything - an obscured button under a cookie banner or a sticky
       consent footer is a routine headless failure, more common than finding no control at all.
       Treating it as "maybe sent" tells the applicant to go looking for a confirmation that cannot
       exist, which is the exact harm this whole change exists to remove. A non-timeout failure
       after the click genuinely might have sent, and stays on the uncertain branch. */
    /* A detached, invisible or disabled element throws a PLAIN Error, not a TimeoutError, and it is
       just as provably pre-dispatch: Playwright reports "Element is not attached to the DOM" from
       the actionability check, before any event is sent. That is the SPA-re-render case the retry
       above exists for, and Ashby and Workable are both React. */
    const message = (error as Error)?.message ?? '';
    const preDispatch = (error as Error)?.name === 'TimeoutError'
      || /not attached to the DOM|Element is not visible|Element is not enabled/i.test(message);
    if (!clicked || preDispatch) {
      throw new NoSubmitControlError(
        `Litos could not press the submit button: ${message || 'unknown error'}`,
      );
    }
    throw error;
  } finally {
    /* EVERY path, including the two throws above and a click that times out. Disposal was on three
       of six exits before; the browser is closed by the caller either way, so this is hygiene
       rather than a live leak, but "hygiene that happens to be covered elsewhere" is how a leak
       gets in later. */
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
  }
}

export async function readReceipt(page: Page): Promise<{ confirmationText: string; finalUrl: string; referenceId?: string }> {
  /* THE AUTO-WAIT HERE IS LOAD-BEARING, and it is not obvious from this line.
   * clickFinalSubmit arms a 5-second navigation barrier before pressing submit. When an employer's
   * POST takes longer than that the barrier expires, and the only thing then carrying the read
   * across the still-pending navigation is `locator.innerText()`, which auto-waits and retries -
   * verified at 7s and 12s server latency. Replacing this with a non-auto-waiting read
   * (`page.content()`, an `evaluate`) would silently reintroduce the stale-read bug: the form would
   * be scraped instead of the confirmation, and a submitted application would be reported as
   * unverified. Measured before the barrier existed: 10 stale reads in 15 runs. */
  /* AND THE READ IS A WATCH, NOT A GLANCE. Workable submits over XHR and renders its confirmation
   * as a client-side transition, so the page that exists the instant after networkidle can still be
   * the form; measured live 2026-08-19, a genuinely pressed Send was reported as "never showed a
   * confirmation it could read". Employers do not reliably email either, so the screen is the only
   * proof there is. Poll the same page for up to thirty seconds and accept the first read that
   * carries a receipt; only a full window with no receipt in any read is a failure. Each pass keeps
   * the auto-waiting innerText read for the reason above. */
  const deadline = Date.now() + 30_000;
  let body = '';
  for (;;) {
    body = (await page.locator('body').innerText()).replace(/\s+/g, ' ').trim();
    if (RECEIPT_PROOF_RE.test(body)) break;
    /* FAIL FAST ON A SECURITY-CODE WALL, RATHER THAN RIDING OUT THE REST OF THE DEADLINE.
     *
     * clickFinalSubmit (both callers: submitControlled's controlled_test path and the plain
     * browserbase-session path) presses submit exactly ONCE and has no idea a second press could
     * ever be required - unlike the managed path, which was given a full two-phase model
     * (securityCodeContinuationActions, status 'awaiting_security_code') after three real
     * Greenhouse runs on 2026-08-08 each got exactly this far and stopped. Nothing built for the
     * managed path reaches this direct-Playwright one, and nothing here can complete a second
     * phase either: a genuine employer code arrives by real email, on nobody's schedule, and this
     * function only ever has the ONE open page in front of it.
     *
     * So a security-code field appearing here is not a page that is merely slow to confirm - it is
     * proof the employer refused the press and is waiting on a code this call can never supply.
     * Riding out the rest of the 30-second wait for a confirmation that cannot come turns that into
     * the exact same generic "never showed a confirmation" message a page that is simply broken
     * gets, which is indistinguishable from the real defect: trial case 'security-code' (regression
     * test below) measured this directly as one submit press, no receipt, and the code field still
     * on screen, with nothing in the error to say why. Checking on every poll, not only once, is
     * deliberate too - the field can render at any point inside the window, not only up front. */
    if (await page.locator(SECURITY_CODE_FIELD_SELECTOR).first().isVisible().catch(() => false)) {
      throw new Error(
        'Litos pressed submit, and the employer is now holding this application behind an emailed '
        + 'security code. This browser has no inbox to read that code from and cannot press submit '
        + 'a second time on its own, so the application was not completed. Open the portal, enter '
        + 'the code from the confirmation email, and finish the application there.',
      );
    }
    if (Date.now() >= deadline) {
      throw new Error('The company never showed a confirmation we could check');
    }
    await page.waitForTimeout(1_000).catch(() => undefined);
  }
  return { confirmationText: body.slice(0, 1000), finalUrl: page.url(), referenceId: receiptReference(body) };
}
