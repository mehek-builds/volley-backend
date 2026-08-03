export const AUTOMATIC_SUBMISSION_CONSENT_VERSION = '2026-07-25';

/**
 * Bumped from the version the 25 pre-existing accounts hold.
 *
 * Those rows were written by codex/litos-captcha-consent, a branch that applied its migration to
 * production and then never merged, so those people agreed to a flow that was never built. The
 * behaviour that actually ships is not the behaviour they saw, and re-using their version string
 * would silently treat a stale agreement as consent to something else.
 *
 * Read `captchaResumeGranted` rather than the boolean alone: a row whose version does not match
 * this constant has not consented to what is here now.
 */
export const AUTOMATIC_CAPTCHA_CONSENT_VERSION = '2026-08-04';

export type AutomationPermissions = {
  automatic_submission_enabled: boolean;
  automatic_verification_enabled: boolean;
  automatic_captcha_enabled?: boolean;
};

/**
 * Whether Litos may pick an application back up after the APPLICANT clears a challenge.
 *
 * It never means Litos solves anything. The applicant passes the check in their own browser, in
 * their own session, and this only decides whether the fill resumes on its own afterwards or waits
 * to be told. Submission permission does not imply it and never has: finishing the remaining fields
 * and sending an application to an employer are different acts with different stakes.
 *
 * Version-checked, not just boolean-checked. See AUTOMATIC_CAPTCHA_CONSENT_VERSION.
 */
export function captchaResumeGranted(row: {
  automatic_captcha_enabled?: boolean | null;
  automatic_captcha_consent_version?: string | null;
} | null | undefined): boolean {
  return row?.automatic_captcha_enabled === true
    && row.automatic_captcha_consent_version === AUTOMATIC_CAPTCHA_CONSENT_VERSION;
}

export function automationConsentValues(settings: AutomationPermissions, now: Date) {
  return {
    automatic_submission_enabled: settings.automatic_submission_enabled,
    automatic_submission_consented_at: settings.automatic_submission_enabled ? now : null,
    automatic_submission_consent_version: settings.automatic_submission_enabled
      ? AUTOMATIC_SUBMISSION_CONSENT_VERSION
      : null,
    automatic_verification_enabled: settings.automatic_verification_enabled,
    automatic_verification_consented_at: settings.automatic_verification_enabled ? now : null,
    automatic_captcha_enabled: settings.automatic_captcha_enabled === true,
    automatic_captcha_consented_at: settings.automatic_captcha_enabled === true ? now : null,
    automatic_captcha_consent_version: settings.automatic_captcha_enabled === true
      ? AUTOMATIC_CAPTCHA_CONSENT_VERSION
      : null,
  };
}
