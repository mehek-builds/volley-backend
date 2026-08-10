import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  ICIMS_ACCOUNT_REGISTRATION_FLAG,
  buildIcimsAccountRegistrationPlan,
  icimsAccountRegistrationEnabled,
  icimsAccountUrl,
  redactedRegistrationActions,
} from './icimsAccountRegistration';
import { generatePortalPassword } from './portalCredentials';

const POSTING = 'https://careers-acme.icims.com/jobs/12345/software-engineer/job';
const ALIAS = 'app-9f2c1b0a7d-3ea51c9d0b77@apply.trylitos.com';

function withFlag<T>(value: string | undefined, run: () => T): T {
  const previous = process.env[ICIMS_ACCOUNT_REGISTRATION_FLAG];
  if (value === undefined) delete process.env[ICIMS_ACCOUNT_REGISTRATION_FLAG];
  else process.env[ICIMS_ACCOUNT_REGISTRATION_FLAG] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[ICIMS_ACCOUNT_REGISTRATION_FLAG];
    else process.env[ICIMS_ACCOUNT_REGISTRATION_FLAG] = previous;
  }
}

test('the feature is off unless somebody turned it on deliberately', () => {
  withFlag(undefined, () => assert.equal(icimsAccountRegistrationEnabled(), false));
  for (const value of ['', '0', 'false', 'yes', 'on', 'maybe', 'TRUE ']) {
    withFlag(value, () => {
      assert.equal(icimsAccountRegistrationEnabled(), value.trim().toLowerCase() === 'true');
    });
  }
  withFlag('1', () => assert.equal(icimsAccountRegistrationEnabled(), true));
});

test('with the flag off there is no plan at all, whatever else is true', () => {
  const plan = withFlag(undefined, () => buildIcimsAccountRegistrationPlan({
    postingUrl: POSTING,
    aliasEmail: ALIAS,
    password: generatePortalPassword(ALIAS),
    humanVerificationObserved: false,
  }));
  assert.deepEqual(plan, { kind: 'blocked', reason: 'feature_disabled' });
});

test('the account page is the login route on the same posting', () => {
  assert.equal(
    icimsAccountUrl(POSTING),
    'https://careers-acme.icims.com/jobs/12345/software-engineer/login',
  );
  // Already on the login route, and a tracking query that must not decide which page opens.
  assert.equal(
    icimsAccountUrl('https://careers-acme.icims.com/jobs/12345/software-engineer/login?mobile=false#top'),
    'https://careers-acme.icims.com/jobs/12345/software-engineer/login',
  );
  assert.equal(icimsAccountUrl('https://careers-acme.icims.com/marketing'), null);
  assert.equal(icimsAccountUrl('not a url'), null);
});

test('the ordered plan navigates, opens the account form, fills, and creates the account', () => {
  const password = generatePortalPassword(ALIAS);
  const plan = withFlag('1', () => buildIcimsAccountRegistrationPlan({
    postingUrl: POSTING,
    aliasEmail: ALIAS,
    password,
    humanVerificationObserved: false,
  }));
  assert.equal(plan.kind, 'ready');
  if (plan.kind !== 'ready') return;

  assert.equal(plan.tenant, 'careers-acme');
  assert.equal(plan.url, 'https://careers-acme.icims.com/jobs/12345/software-engineer/login');
  assert.deepEqual(plan.actions.map((action) => [action.type, action.label]), [
    ['waitForSelector', 'icims_registration_login_page'],
    ['click', 'icims_registration_open_account_form'],
    ['waitForSelector', 'icims_registration_account_form'],
    ['fill', 'icims_registration_email'],
    ['fill', 'icims_registration_password'],
    ['fill', 'icims_registration_confirm_password'],
    ['click', 'icims_registration_create_account'],
  ]);

  // The alias is the account address, so employer mail for this account lands where the rest does.
  assert.equal(plan.actions[3].value, ALIAS);
  // The password is typed twice and both times it is the same value, or the form rejects it.
  assert.equal(plan.actions[4].value, password);
  assert.equal(plan.actions[5].value, password);

  // Nothing in this plan can send an application. There is no application on this page.
  assert.equal(plan.actions.some((action) => action.type === 'confirmAndSubmit'), false);
  assert.equal(plan.actions.some((action) => action.type === 'upload'), false);
  assert.equal(
    plan.actions.some((action) => /submitApplication|apply|consent|agree|eeo/i.test(action.selector ?? '')),
    false,
  );
});

test('a plan is refused rather than partially built', () => {
  const password = generatePortalPassword(ALIAS);
  const base = { postingUrl: POSTING, aliasEmail: ALIAS, password, humanVerificationObserved: false };

  // A tenant that cannot be identified with confidence: hold rather than reuse another account.
  assert.deepEqual(
    withFlag('1', () => buildIcimsAccountRegistrationPlan({ ...base, postingUrl: 'https://www.icims.com/products' })),
    { kind: 'blocked', reason: 'unknown_tenant' },
  );
  assert.deepEqual(
    withFlag('1', () => buildIcimsAccountRegistrationPlan({ ...base, aliasEmail: 'not-an-address' })),
    { kind: 'blocked', reason: 'invalid_alias' },
  );
  // A password that would fail the portal's own policy must never be typed into a signup form.
  assert.deepEqual(
    withFlag('1', () => buildIcimsAccountRegistrationPlan({ ...base, password: 'short' })),
    { kind: 'blocked', reason: 'weak_password' },
  );
  // The captured login page carries an hCaptcha. Litos does not solve those, and a run that walked
  // into one would burn the alias against a registration that cannot complete.
  assert.deepEqual(
    withFlag('1', () => buildIcimsAccountRegistrationPlan({ ...base, humanVerificationObserved: true })),
    { kind: 'blocked', reason: 'human_verification_present' },
  );
});

test('the loggable form of the plan carries no password', () => {
  const password = generatePortalPassword(ALIAS);
  const plan = withFlag('1', () => buildIcimsAccountRegistrationPlan({
    postingUrl: POSTING,
    aliasEmail: ALIAS,
    password,
    humanVerificationObserved: false,
  }));
  assert.equal(plan.kind, 'ready');
  if (plan.kind !== 'ready') return;

  const redacted = redactedRegistrationActions(plan.actions);
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(password), false, 'a serialized plan must not carry the password');
  assert.equal(serialized.includes(ALIAS), true, 'the alias is not a secret and stays readable');
  assert.equal(redacted.length, plan.actions.length, 'redaction must not drop a step');
  assert.equal(redacted[4].value, '[redacted]');
  assert.equal(redacted[5].value, '[redacted]');
  // The original plan is untouched, so redacting for a log cannot break the run.
  assert.equal(plan.actions[4].value, password);
});

test('the submit boundary did not move', () => {
  const source = readFileSync('src/lib/icimsAccountRegistration.ts', 'utf8');
  assert.equal(/confirmAndSubmit/.test(source), false, 'this module must not reach for the application submit action');
  const capabilities = readFileSync('src/lib/browserApplicationCapabilities.ts', 'utf8');
  const icims = capabilities.slice(capabilities.indexOf('  icims: {'), capabilities.indexOf('};', capabilities.indexOf('  icims: {')));
  assert.equal(icims.includes('createAccount: true'), true);
  assert.equal(icims.includes('programmaticSubmit: true'), false);
  assert.equal(icims.includes('fill: true'), false);
});
