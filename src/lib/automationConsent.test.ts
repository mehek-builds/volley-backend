import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
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
    // Absent from the input, so absent from the output. This object is spread into a column update,
    // so naming the column here would make every writer that does not mention captcha resume revoke
    // it - including POST /onboarding/complete, which would take the permission away every time
    // someone re-ran /start.
  });
});

test('omitting captcha resume leaves the stored permission alone', () => {
  const values = automationConsentValues({
    automatic_submission_enabled: false,
    automatic_verification_enabled: false,
  }, new Date('2026-08-04T00:00:00.000Z'));
  assert.equal('automatic_captcha_enabled' in values, false);
  assert.equal('automatic_captcha_consent_version' in values, false);
});

test('an explicit false is a revocation and clears the version with it', () => {
  const values = automationConsentValues({
    automatic_submission_enabled: false,
    automatic_verification_enabled: false,
    automatic_captcha_enabled: false,
  }, new Date('2026-08-04T00:00:00.000Z'));
  assert.equal(values.automatic_captcha_enabled, false);
  assert.equal(values.automatic_captcha_consent_version, null);
  assert.equal(values.automatic_captcha_consented_at, null);
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

test('granting captcha resume stamps the current version', () => {
  const now = new Date('2026-08-04T00:00:00.000Z');
  const on = automationConsentValues({
    automatic_submission_enabled: false,
    automatic_verification_enabled: false,
    automatic_captcha_enabled: true,
  }, now);
  assert.equal(on.automatic_captcha_enabled, true);
  assert.equal(on.automatic_captcha_consent_version, AUTOMATIC_CAPTCHA_CONSENT_VERSION);
  assert.deepEqual(on.automatic_captcha_consented_at, now);
});

// Submission permission has never implied this one, and the reverse is equally true: finishing the
// boxes and sending an application to an employer are different acts with different stakes.
test('turning on automatic submission does not turn on captcha resume', () => {
  const values = automationConsentValues({
    automatic_submission_enabled: true,
    automatic_verification_enabled: true,
  }, new Date('2026-08-04T00:00:00.000Z'));
  assert.equal('automatic_captcha_enabled' in values, false);
});

/* A CONSENT DATE THAT IS STORED AND NEVER SENT IS A RECORD NOBODY CAN READ.
 *
 * automatic_captcha_consented_at was written on every grant from 2026-08-04 and sent by no route
 * until 2026-08-12. Nothing failed and no test went red: the settings screen simply had no date to
 * show, so a granted permission displayed as an undated tick, and the website shipped a "Granted
 * <date>." line that could never render. The gap is invisible precisely because writing and sending
 * live in different files.
 *
 * So the pairing is asserted rather than remembered. `user.` and not `users.` is what distinguishes
 * the state response from the update's returning clause, which reads the table object.
 *
 * KNOWN_UNSENT is an allowlist that may shrink and must never grow. Adding a name to it is a
 * decision to store a consent date the account holding it cannot see. */
const KNOWN_UNSENT = new Set([
  // Written by PUT /onboarding/automation and read by nothing. Same defect as the captcha column,
  // found while fixing that one and deliberately left alone here: this permission has no date in
  // any surface today, so exposing it is a product change rather than the repair of a broken one.
  'automatic_verification_consented_at',
]);

test('every automation consent date that is stored is also sent by GET /onboarding/state', () => {
  const schema = readFileSync('src/db/schema.ts', 'utf8');
  const route = readFileSync('src/routes/onboarding.ts', 'utf8');
  const stored = [...schema.matchAll(/^\s*(automatic_\w+_consented_at):/gm)].map((m) => m[1]);
  // Guards the guard: a schema rename that matched nothing would make every assertion below vacuous.
  assert.ok(stored.length >= 5, `expected the consent date columns, found ${stored.join(', ')}`);
  for (const column of stored) {
    if (KNOWN_UNSENT.has(column)) continue;
    assert.ok(
      route.includes(`${column}: user.${column}`),
      `${column} is stored but GET /onboarding/state never sends it, so no screen can show when the permission was granted`,
    );
  }
});
