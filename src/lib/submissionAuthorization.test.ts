import assert from 'node:assert/strict';
import test from 'node:test';
import { mayClickFinalSubmit, preparedSubmissionStatus } from './submissionAuthorization';

test('standing consent advances only a blocker-free application', () => {
  assert.equal(preparedSubmissionStatus({ safe: true, standingConsentEnabled: true }), 'submitting');
  assert.equal(preparedSubmissionStatus({ safe: false, standingConsentEnabled: true }), 'needs_attention');
});

test('an eligible application waits when standing consent is off', () => {
  assert.equal(preparedSubmissionStatus({ safe: true, standingConsentEnabled: false }), 'ready_for_final_approval');
});

test('revocation stops a standing-consent click but not a one-time approval', () => {
  assert.equal(mayClickFinalSubmit({ source: 'standing_consent', standingConsentEnabled: false }), false);
  assert.equal(mayClickFinalSubmit({ source: 'standing_consent', standingConsentEnabled: true }), true);
  assert.equal(mayClickFinalSubmit({ source: 'per_application_approval', standingConsentEnabled: false }), true);
  assert.equal(mayClickFinalSubmit({ source: undefined, standingConsentEnabled: true }), false);
});
