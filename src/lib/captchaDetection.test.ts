import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { captchaSnapshotRequiresAttention, clickFinalSubmit, waitForCaptchaResolution } from './portalSubmission';

test('a visible challenge without a response token needs attention', () => {
  assert.equal(captchaSnapshotRequiresAttention([''], 1), true);
});

test('a provider-filled response token marks a retained widget as solved', () => {
  assert.equal(captchaSnapshotRequiresAttention(['provider-token'], 1), false);
});

test('one solved widget does not mask another unresolved widget', () => {
  assert.equal(captchaSnapshotRequiresAttention(['provider-token', ''], 2), true);
});

test('one solved widget is not overcounted when its wrapper and iframe are both visible', () => {
  assert.equal(captchaSnapshotRequiresAttention(['provider-token'], 3), false);
});

test('hidden or absent challenge markup does not create a blocker', () => {
  assert.equal(captchaSnapshotRequiresAttention([], 0), false);
});

test('provider solving gets a bounded wait before an unresolved verdict', async () => {
  let responseToken = '';
  const responseLocator = {
    count: async () => 1,
    nth: () => ({ inputValue: async () => responseToken }),
  };
  const challengeLocator = {
    count: async () => 1,
    nth: () => ({ isVisible: async () => true }),
  };
  const page = {
    locator: (selector: string) => selector.includes('captcha-response') ? responseLocator : challengeLocator,
    waitForTimeout: async () => { responseToken = 'provider-token'; },
  } as unknown as Page;
  assert.equal(await waitForCaptchaResolution(page, 100, 1), true);
});

test('the final click guard does not click while any CAPTCHA widget is unresolved', async () => {
  let clickCount = 0;
  const responseLocator = {
    count: async () => 2,
    nth: (index: number) => ({ inputValue: async () => index === 0 ? 'provider-token' : '' }),
  };
  const challengeLocator = {
    count: async () => 2,
    nth: () => ({ isVisible: async () => true }),
  };
  const button = {
    count: async () => 1,
    click: async () => { clickCount += 1; },
  };
  const page = {
    locator: (selector: string) => selector.includes('response') ? responseLocator : challengeLocator,
    getByRole: () => ({ last: () => button }),
    waitForLoadState: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), /CAPTCHA_UNRESOLVED/);
  assert.equal(clickCount, 0);
});
