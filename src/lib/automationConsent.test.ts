import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATIC_CAPTCHA_CONSENT_VERSION, AUTOMATIC_SUBMISSION_CONSENT_VERSION, automationConsentValues, captchaResumeGranted } from './automationConsent';

test('records each granted permission separately with an auditable submission version', () => {
  const now = new Date('2026-07-25T12:00:00.000Z');
  assert.deepEqual(automationConsentValues({
    automatic_submission_enabled: true,
    automatic_verification_enabled: false,
  }, now), {
    automatic_submission_enabled: true,
    automatic_submission_consented_at: now,
    automatic_submission_consent_version: AUTOMATIC_SUBMISSION_CONSENT_VERSION,
    automatic_verification_enabled: false,
    automatic_verification_consented_at: null,
    // Absent from the input, so it must come back explicitly OFF rather than undefined: this
    // object is spread straight into a column update, and an undefined would leave whatever the row
    // already held. A permission that survives its own revocation is the failure worth pinning.
    automatic_captcha_enabled: false,
    automatic_captcha_consented_at: null,
    automatic_captcha_consent_version: null,
  });
});

test('revocation clears submission consent evidence instead of leaving stale authorization', () => {
  const values = automationConsentValues({
    automatic_submission_enabled: false,
    automatic_verification_enabled: true,
  }, new Date('2026-07-25T12:00:00.000Z'));
  assert.equal(values.automatic_submission_consented_at, null);
  assert.equal(values.automatic_submission_consent_version, null);
  assert.equal(values.automatic_verification_enabled, true);
});

// ---- captcha resume permission ----

test('a granted captcha permission on the current version is honoured', () => {
  assert.equal(captchaResumeGranted({
    automatic_captcha_enabled: true,
    automatic_captcha_consent_version: AUTOMATIC_CAPTCHA_CONSENT_VERSION,
  }), true);
});

/* The 25 accounts that already carry this column agreed on codex/litos-captcha-consent, a branch
 * that applied its migration to production and then never merged. What ships is not what they saw,
 * so their agreement does not carry over and they are asked again. */
test('a permission granted against an older version is not consent to what shipped', () => {
  assert.equal(captchaResumeGranted({
    automatic_captcha_enabled: true,
    automatic_captcha_consent_version: '2026-07-20',
  }), false);
});

test('an enabled flag with no version at all is not consent', () => {
  assert.equal(captchaResumeGranted({ automatic_captcha_enabled: true }), false);
  assert.equal(captchaResumeGranted({ automatic_captcha_enabled: true, automatic_captcha_consent_version: null }), false);
});

test('a disabled permission is never granted, whatever the version says', () => {
  assert.equal(captchaResumeGranted({
    automatic_captcha_enabled: false,
    automatic_captcha_consent_version: AUTOMATIC_CAPTCHA_CONSENT_VERSION,
  }), false);
  assert.equal(captchaResumeGranted(null), false);
  assert.equal(captchaResumeGranted(undefined), false);
});

// Turning it on stamps the version; turning it off clears both, so a later re-read cannot mistake a
// revoked permission for a current one.
test('the consent values record and revoke the version together', () => {
  const now = new Date('2026-08-04T00:00:00.000Z');
  const on = automationConsentValues({
    automatic_submission_enabled: false,
    automatic_verification_enabled: false,
    automatic_captcha_enabled: true,
  }, now);
  assert.equal(on.automatic_captcha_enabled, true);
  assert.equal(on.automatic_captcha_consent_version, AUTOMATIC_CAPTCHA_CONSENT_VERSION);
  assert.deepEqual(on.automatic_captcha_consented_at, now);

  const off = automationConsentValues({
    automatic_submission_enabled: false,
    automatic_verification_enabled: false,
    automatic_captcha_enabled: false,
  }, now);
  assert.equal(off.automatic_captcha_enabled, false);
  assert.equal(off.automatic_captcha_consent_version, null);
  assert.equal(off.automatic_captcha_consented_at, null);
});

// Submission permission has never implied this one, and the reverse is equally true: finishing the
// boxes and sending an application to an employer are different acts with different stakes.
test('turning on automatic submission does not turn on captcha resume', () => {
  const values = automationConsentValues({
    automatic_submission_enabled: true,
    automatic_verification_enabled: true,
  }, new Date('2026-08-04T00:00:00.000Z'));
  assert.equal(values.automatic_captcha_enabled, false);
  assert.equal(values.automatic_captcha_consent_version, null);
});
