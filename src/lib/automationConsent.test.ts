import assert from 'node:assert/strict';
import test from 'node:test';
import { getTableColumns } from 'drizzle-orm';
import { users } from '../db/schema';
import {
  AUTOMATIC_CAPTCHA_CONSENT_VERSION,
  AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION,
  AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  AUTOMATIC_SUBMISSION_CONSENT_VERSION,
  automationConsentState,
  automationConsentValues,
  captchaResumeGranted,
} from './automationConsent';

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
 * <date>." line that could never render. The gap was invisible precisely because writing and sending
 * lived in different files.
 *
 * The columns come from the users TABLE OBJECT rather than from the text of schema.ts, and the
 * response comes from CALLING automationConsentState rather than from grepping the route. Both
 * halves are deliberate: a source-text version of this test passes on a commented-out line and fails
 * on an equivalent refactor, so it would police formatting while missing the defect it exists for. */
const CONSENT_DATE_COLUMNS = Object.keys(getTableColumns(users))
  .filter((name) => /^automatic_\w+_consented_at$/.test(name));

test('the users table still carries the consent dates this rule is about', () => {
  // Guards the guard: a rename that matched nothing would make the assertions below vacuous.
  assert.deepEqual(new Set(CONSENT_DATE_COLUMNS), new Set([
    'automatic_submission_consented_at',
    'automatic_verification_consented_at',
    'automatic_captcha_consented_at',
    'automatic_consent_acceptance_consented_at',
    'automatic_conduct_acceptance_consented_at',
  ]));
});

test('every stored consent date is sent by the state response, with no exemptions', () => {
  const now = new Date('2026-08-12T09:14:00.000Z');
  const row = Object.fromEntries(CONSENT_DATE_COLUMNS.map((name) => [name, now]));
  const sent = automationConsentState({
    automatic_submission_enabled: true,
    automatic_submission_consent_version: AUTOMATIC_SUBMISSION_CONSENT_VERSION,
    automatic_verification_enabled: true,
    ...row,
  } as Parameters<typeof automationConsentState>[0]);
  for (const column of CONSENT_DATE_COLUMNS) {
    assert.deepEqual(
      (sent as Record<string, unknown>)[column],
      now,
      `${column} is stored but the state response never sends it, so no screen can show when the permission was granted`,
    );
  }
});

/* The pairing that makes a superseded grant legible: verdict false, date present. Asserting them
 * together is the point - a date alone would look like a live permission, and a verdict alone leaves
 * a settings screen unable to say anything about a grant that really was given. */
test('a superseded grant sends a false verdict with its real date still attached', () => {
  const granted = new Date('2026-08-04T11:02:00.000Z');
  const sent = automationConsentState({
    automatic_submission_enabled: false,
    automatic_submission_consented_at: null,
    automatic_submission_consent_version: null,
    automatic_verification_enabled: false,
    automatic_captcha_enabled: true,
    automatic_captcha_consented_at: granted,
    automatic_captcha_consent_version: 'not-the-live-version',
  });
  assert.equal(sent.automatic_captcha_enabled, false);
  assert.deepEqual(sent.automatic_captcha_consented_at, granted);
});

/* What a client may know is which wording is LIVE, never which wording a given row carries: the
 * second is the input to a verdict clients must never compute for themselves. */
test('the state response sends the current version constants, never the row values', () => {
  const sent = automationConsentState({
    automatic_submission_enabled: false,
    automatic_submission_consented_at: null,
    automatic_submission_consent_version: null,
    automatic_verification_enabled: false,
    automatic_consent_acceptance_consent_version: 'stale',
    automatic_conduct_acceptance_consent_version: 'stale',
  });
  assert.equal(sent.automatic_consent_acceptance_consent_version, AUTOMATIC_CONSENT_ACCEPTANCE_VERSION);
  assert.equal(sent.automatic_conduct_acceptance_consent_version, AUTOMATIC_CONDUCT_ACCEPTANCE_VERSION);
  assert.equal('automatic_captcha_consent_version' in sent, false);
});
