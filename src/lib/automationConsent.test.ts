import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AUTOMATIC_CAPTCHA_CONSENT_VERSION,
  AUTOMATIC_SUBMISSION_CONSENT_VERSION,
  automaticCaptchaConsentEnabled,
  automationConsentValues,
} from './automationConsent';

test('records each granted permission separately with an auditable submission version', () => {
  const now = new Date('2026-07-25T12:00:00.000Z');
  assert.deepEqual(automationConsentValues({
    automatic_submission_enabled: true,
    automatic_verification_enabled: false,
    automatic_captcha_enabled: true,
  }, now), {
    automatic_submission_enabled: true,
    automatic_submission_consented_at: now,
    automatic_submission_consent_version: AUTOMATIC_SUBMISSION_CONSENT_VERSION,
    automatic_verification_enabled: false,
    automatic_verification_consented_at: null,
    automatic_captcha_enabled: true,
    automatic_captcha_consented_at: now,
    automatic_captcha_consent_version: AUTOMATIC_CAPTCHA_CONSENT_VERSION,
  });
});

test('CAPTCHA authorization requires the current disclosure version', () => {
  assert.equal(automaticCaptchaConsentEnabled(true, AUTOMATIC_CAPTCHA_CONSENT_VERSION), true);
  assert.equal(automaticCaptchaConsentEnabled(true, '2026-07-25'), false);
  assert.equal(automaticCaptchaConsentEnabled(true, null), false);
  assert.equal(automaticCaptchaConsentEnabled(false, AUTOMATIC_CAPTCHA_CONSENT_VERSION), false);
});

test('revocation clears submission consent evidence instead of leaving stale authorization', () => {
  const values = automationConsentValues({
    automatic_submission_enabled: false,
    automatic_verification_enabled: true,
    automatic_captcha_enabled: false,
  }, new Date('2026-07-25T12:00:00.000Z'));
  assert.equal(values.automatic_submission_consented_at, null);
  assert.equal(values.automatic_submission_consent_version, null);
  assert.equal(values.automatic_verification_enabled, true);
  assert.equal(values.automatic_captcha_consented_at, null);
  assert.equal(values.automatic_captcha_consent_version, null);
});
