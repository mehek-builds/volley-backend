import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { completeEmailVerificationIfPresent } from './browserVerification';

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
