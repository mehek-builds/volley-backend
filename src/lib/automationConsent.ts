export const AUTOMATIC_SUBMISSION_CONSENT_VERSION = '2026-07-25';

export type AutomationPermissions = {
  automatic_submission_enabled: boolean;
  automatic_verification_enabled: boolean;
};

export function automationConsentValues(settings: AutomationPermissions, now: Date) {
  return {
    automatic_submission_enabled: settings.automatic_submission_enabled,
    automatic_submission_consented_at: settings.automatic_submission_enabled ? now : null,
    automatic_submission_consent_version: settings.automatic_submission_enabled
      ? AUTOMATIC_SUBMISSION_CONSENT_VERSION
      : null,
    automatic_verification_enabled: settings.automatic_verification_enabled,
    automatic_verification_consented_at: settings.automatic_verification_enabled ? now : null,
  };
}
