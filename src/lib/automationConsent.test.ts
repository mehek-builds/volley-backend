import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTOMATIC_SUBMISSION_CONSENT_VERSION, automationConsentValues } from './automationConsent';

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
