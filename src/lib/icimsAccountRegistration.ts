import type { ManagedBrowserAction } from './browserbase';
import { icimsTenantFromUrl, passwordMeetsPortalPolicy } from './portalCredentials';

/* REGISTERING THE ACCOUNT AN iCIMS PORTAL DEMANDS BEFORE IT SHOWS AN APPLICATION FORM.
 *
 * This module builds an ordered plan. It does not run one. Nothing here opens a browser, reaches
 * the network, or touches an employer tenant, and the flag below is off until an operator turns it
 * on deliberately. The first live registration is the owner's to trigger.
 *
 * WHAT REGISTERING IS AND IS NOT. Creating an account is not submitting an application. The submit
 * boundary is unchanged: programmaticSubmit stays false for iCIMS, this plan ends at the account
 * form's own create control, and no action in it touches an application field, a privacy choice, an
 * equal-opportunity question, or an application send button.
 *
 * WHY IT STOPS ON HUMAN VERIFICATION. The captured iCIMS login page carries an hCaptcha textarea
 * beside the email field. Litos does not solve CAPTCHAs, and a plan that walked into one would burn
 * the applicant's alias against a failed registration. The builder therefore requires the caller to
 * have probed the live page first (buildManagedAttendedAccountProbeActions in portalSubmission.ts)
 * and to say whether a human-verification control was seen. Seen means blocked, not "try anyway".
 */

/** Off by default. Only these exact values turn it on; anything else, including "yes", does not. */
export const ICIMS_ACCOUNT_REGISTRATION_FLAG = 'LITOS_ICIMS_ACCOUNT_REGISTRATION';

export function icimsAccountRegistrationEnabled(): boolean {
  const value = process.env[ICIMS_ACCOUNT_REGISTRATION_FLAG]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/* SELECTORS.
 *
 * Only the first of these is measured. `input#email[name="css_loginName"]` and the hCaptcha
 * textarea are the two controls captured live on an iCIMS login page on 2026-07-29 and already
 * pinned in portalSubmission.ts. The account-creation control and the two password fields are NOT
 * from a capture, because building this plan must not mean visiting an employer's portal. Each is
 * written as a candidate list rather than a single guessed id, and every one of them is required in
 * the plan: if the live page does not carry a control matching the list, the run stops on a missing
 * required selector rather than typing into whatever else happens to be on the page.
 *
 * Before the flag is turned on, these three lists want one live capture to confirm or correct them.
 * That capture is a deliberate act on a real tenant, which is exactly what this branch does not do.
 */
export const ICIMS_REGISTRATION_SELECTORS = {
  loginEmail: 'input#email[name="css_loginName"]',
  humanVerification: 'textarea[name="h-captcha-response"]',
  createAccountControl:
    'a#createAccountLink, a[href*="createAccount" i], a[href*="register" i], button[name*="createAccount" i]',
  email:
    'input#email[name="css_loginName"], input[type="email"][name*="loginName" i], input[type="email"][name*="css_" i]',
  password:
    'input[type="password"][name="css_password"], input[type="password"][id="password"], input[type="password"][name*="password" i]:not([name*="confirm" i]):not([name*="2" i])',
  confirmPassword:
    'input[type="password"][name="css_password2"], input[type="password"][name*="confirm" i], input[type="password"][id*="confirm" i]',
  createAccountSubmit:
    'input[type="submit"][value*="create" i], button[type="submit"][name*="create" i], button#createAccountSubmit',
} as const;

const REGISTRATION_ACTION_TIMEOUT_MS = 15_000;

export type IcimsAccountRegistrationPlan =
  | {
      kind: 'ready';
      tenant: string;
      /** The page the managed runner navigates to before running the actions. */
      url: string;
      actions: ManagedBrowserAction[];
    }
  | {
      kind: 'blocked';
      reason:
        | 'feature_disabled'
        | 'unknown_tenant'
        | 'invalid_alias'
        | 'weak_password'
        | 'human_verification_present';
    };

/**
 * The iCIMS login page for a posting, which is where the account-creation control lives.
 *
 * The same rewrite portalSubmission.ts applies when it canonicalizes an iCIMS application URL:
 * `/jobs/{id}/{slug}/job` becomes `/jobs/{id}/{slug}/login`. Query and fragment are dropped so a
 * tracking parameter cannot change which page is opened.
 */
export function icimsAccountUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/job\/?$/i, '/login');
  if (!/^\/jobs\/\d+\/[a-z0-9%._~-]+\/login\/?$/i.test(url.pathname) && !/^\/jobs\/login\/?$/i.test(url.pathname)) {
    return null;
  }
  return url.toString();
}

/**
 * The ordered plan the managed runner would execute to register on one iCIMS tenant.
 *
 * Order, and why each step is there:
 *   1. wait for the login form, so the run proves it is on the captured page before it touches it;
 *   2. click the account-creation control, which is what turns a sign-in page into a sign-up page;
 *   3. wait for the sign-up email field, so step 4 cannot type into the sign-in field by accident;
 *   4. fill the email field with the Litos application alias, so employer mail for this account
 *      arrives on the same alias as everything else from this employer;
 *   5. fill the password field with the generated password;
 *   6. fill the confirm-password field with the same value;
 *   7. click the account form's own create control. This creates an ACCOUNT. It does not send an
 *      application, and there is no application on the page at this point.
 *
 * Returns a blocked result rather than a partial plan whenever any precondition fails. A partial
 * plan is the dangerous shape here: half a registration leaves an alias burned on a tenant with no
 * password that opens it.
 */
export function buildIcimsAccountRegistrationPlan(input: {
  postingUrl: string;
  aliasEmail: string;
  password: string;
  humanVerificationObserved: boolean;
}): IcimsAccountRegistrationPlan {
  if (!icimsAccountRegistrationEnabled()) return { kind: 'blocked', reason: 'feature_disabled' };

  const tenant = icimsTenantFromUrl(input.postingUrl);
  const url = icimsAccountUrl(input.postingUrl);
  if (!tenant || !url) return { kind: 'blocked', reason: 'unknown_tenant' };

  const alias = input.aliasEmail.trim();
  if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(alias)) return { kind: 'blocked', reason: 'invalid_alias' };
  if (!passwordMeetsPortalPolicy(input.password, alias)) return { kind: 'blocked', reason: 'weak_password' };
  if (input.humanVerificationObserved) return { kind: 'blocked', reason: 'human_verification_present' };

  const actions: ManagedBrowserAction[] = [
    {
      type: 'waitForSelector',
      selector: ICIMS_REGISTRATION_SELECTORS.loginEmail,
      label: 'icims_registration_login_page',
      timeout: REGISTRATION_ACTION_TIMEOUT_MS,
    },
    {
      type: 'click',
      selector: ICIMS_REGISTRATION_SELECTORS.createAccountControl,
      label: 'icims_registration_open_account_form',
      timeout: REGISTRATION_ACTION_TIMEOUT_MS,
    },
    {
      type: 'waitForSelector',
      selector: ICIMS_REGISTRATION_SELECTORS.email,
      label: 'icims_registration_account_form',
      timeout: REGISTRATION_ACTION_TIMEOUT_MS,
    },
    {
      type: 'fill',
      selector: ICIMS_REGISTRATION_SELECTORS.email,
      value: alias,
      label: 'icims_registration_email',
      timeout: REGISTRATION_ACTION_TIMEOUT_MS,
    },
    {
      type: 'fill',
      selector: ICIMS_REGISTRATION_SELECTORS.password,
      value: input.password,
      label: 'icims_registration_password',
      timeout: REGISTRATION_ACTION_TIMEOUT_MS,
    },
    {
      type: 'fill',
      selector: ICIMS_REGISTRATION_SELECTORS.confirmPassword,
      value: input.password,
      label: 'icims_registration_confirm_password',
      timeout: REGISTRATION_ACTION_TIMEOUT_MS,
    },
    {
      type: 'click',
      selector: ICIMS_REGISTRATION_SELECTORS.createAccountSubmit,
      label: 'icims_registration_create_account',
      timeout: REGISTRATION_ACTION_TIMEOUT_MS,
    },
  ];

  return { kind: 'ready', tenant, url, actions };
}

/** Labels whose action carries the password. Anything written down must drop these values. */
const SECRET_ACTION_LABELS: ReadonlySet<string> = new Set([
  'icims_registration_password',
  'icims_registration_confirm_password',
]);

/**
 * The only shape of this plan that may be logged, stored, or attached to a review record.
 *
 * The password lives in the `value` of two fill actions, and a plan serialized whole would put it
 * in a log line forever. This drops the value on those two and leaves everything else intact, so a
 * reader can still see exactly what the run would do.
 */
export function redactedRegistrationActions(actions: readonly ManagedBrowserAction[]): ManagedBrowserAction[] {
  return actions.map((action) => {
    if (action.label && SECRET_ACTION_LABELS.has(action.label)) {
      const { value: _password, ...rest } = action;
      return { ...rest, value: '[redacted]' };
    }
    return { ...action };
  });
}
