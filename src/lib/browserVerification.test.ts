import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import {
  buildManagedVerificationActions,
  completeEmailVerificationIfPresent,
  managedResultNeedsEmailVerification,
  prepareManagedEmailVerification,
} from './browserVerification';

function pageWithOtp(visible: boolean): Page {
  const field = {
    isVisible: async () => visible,
  };
  const fields = {
    count: async () => 1,
    nth: () => field,
  };
  return { locator: () => fields } as unknown as Page;
}

test('does nothing when the active portal has no visible verification field', async () => {
  const result = await completeEmailVerificationIfPresent({
    page: pageWithOtp(false),
    userId: 'user-1',
    portalUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    requestedAt: new Date(),
    permissionGranted: true,
  });
  assert.deepEqual(result, { status: 'not_needed' });
});

test('hands a visible verification field to the applicant when inbox permission is off', async () => {
  let searched = false;
  const result = await completeEmailVerificationIfPresent({
    page: pageWithOtp(true),
    userId: 'user-1',
    portalUrl: 'https://boards.greenhouse.io/acme/jobs/1',
    requestedAt: new Date(),
    permissionGranted: false,
    findCode: async () => {
      searched = true;
      return null;
    },
  });
  assert.deepEqual(result, { status: 'handoff' });
  assert.equal(searched, false);
});

test('fills one character into each split verification control', async () => {
  const values = Array<string>(8).fill('');
  let completed = false;
  const fields = values.map((_, index) => ({
    isVisible: async () => !completed,
    getAttribute: async (name: string) => name === 'maxlength' ? '1' : null,
    fill: async (value: string) => {
      values[index] = value;
      if (index === values.length - 1) completed = true;
    },
  }));
  const page = {
    locator: () => ({ count: async () => fields.length, nth: (index: number) => fields[index] }),
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  const result = await completeEmailVerificationIfPresent({
    page,
    userId: 'user-1',
    portalUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
    requestedAt: new Date('2026-08-09T00:00:00.000Z'),
    permissionGranted: true,
    findCode: async () => ({
      code: 'HJJ53KPD',
      provider: 'gmail',
      receivedAt: '2026-08-09T00:00:01.000Z',
      senderDomain: 'us.greenhouse-mail.io',
    }),
  });
  assert.deepEqual(values, [...'HJJ53KPD']);
  assert.deepEqual(result, { status: 'completed', provider: 'gmail' });
});

test('managed verification recognizes the email-code page without confusing a receipt', () => {
  assert.equal(managedResultNeedsEmailVerification({
    title: 'Continue',
    url: 'https://job-boards.greenhouse.io/acme/jobs/123',
    text: 'Check your inbox',
    humanVerification: { kind: 'security_code', fieldCount: 8, sentTo: 'applicant@example.com' },
  }), true);
  assert.equal(managedResultNeedsEmailVerification({
    title: 'Verify your application',
    url: 'https://job-boards.greenhouse.io/verify/abc',
    text: 'Enter the security code sent to your email to continue.',
  }), true);
  assert.equal(managedResultNeedsEmailVerification({
    title: 'Application received',
    url: 'https://job-boards.greenhouse.io/thanks',
    text: 'Thank you. We received your application.',
  }), false);
});

test('managed verification builds one bounded continuation for single and split inputs', () => {
  const actions = buildManagedVerificationActions('HJJ53KPD');
  assert.equal(actions[0]?.type, 'fill');
  assert.equal(actions[0]?.value, 'HJJ53KPD');
  assert.deepEqual(actions.slice(1, 9).map((action) => action.value), [...'HJJ53KPD']);
  assert.deepEqual(actions.slice(1, 9).map((action) => action.selector), [1, 2, 3, 4, 5, 6, 7, 8]
    .map((index) => `:nth-match(input[maxlength="1"], ${index})`));
  assert.deepEqual(actions.at(-1), {
    type: 'click',
    selector: 'button[type="submit"], input[type="submit"]',
    label: 'continue_email_verification',
  });
});

test('managed verification searches once and returns actions without exposing the code in state', async () => {
  let searchedRecipient = '';
  const result = await prepareManagedEmailVerification({
    result: {
      title: 'Security code',
      url: 'https://job-boards.greenhouse.io/verify/abc',
      text: 'Check your email and enter the security code to continue.',
    },
    userId: 'user-1',
    portalUrl: 'https://job-boards.greenhouse.io/acme/jobs/1',
    requestedAt: new Date('2026-08-09T00:00:00.000Z'),
    permissionGranted: true,
    expectedRecipient: 'applications+app-123@trylitos.com',
    attempts: 1,
    findCode: async (options) => {
      searchedRecipient = options.expectedRecipient ?? '';
      return {
        code: 'HJJ53KPD',
        provider: 'gmail',
        receivedAt: '2026-08-09T00:00:01.000Z',
        senderDomain: 'us.greenhouse-mail.io',
      };
    },
  });
  assert.equal(searchedRecipient, 'applications+app-123@trylitos.com');
  assert.equal(result.status, 'ready');
  if (result.status === 'ready') {
    assert.equal(result.provider, 'gmail');
    assert.equal(result.actions[0]?.value, 'HJJ53KPD');
  }
});
