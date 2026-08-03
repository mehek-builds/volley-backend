import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { browserSessionBody } from './browserbase';
import {
  captchaSnapshotRequiresAttention,
  clickFinalSubmit,
  hasUnresolvedCaptcha,
  waitForCaptchaResolution,
} from './portalSubmission';

// ---- snapshot logic ----

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

test('a rendered widget with no response field at all needs attention', () => {
  assert.equal(captchaSnapshotRequiresAttention([], 1), true);
});

// ---- page probing ----

type ChallengeNode = { visible: boolean; badge?: boolean };

function fakePage(options: { tokens: string[]; challenges: ChallengeNode[] }): Page {
  const responseLocator = {
    count: async () => options.tokens.length,
    nth: (index: number) => ({ inputValue: async () => options.tokens[index] ?? '' }),
  };
  const challengeLocator = {
    count: async () => options.challenges.length,
    nth: (index: number) => ({
      isVisible: async () => options.challenges[index]!.visible,
      locator: () => ({ count: async () => (options.challenges[index]!.badge ? 1 : 0) }),
      evaluate: async () => Boolean(options.challenges[index]!.badge),
    }),
  };
  return {
    locator: (selector: string) => (selector.includes('captcha-response') || selector.includes('turnstile-response')
      ? responseLocator
      : challengeLocator),
  } as unknown as Page;
}

test('an unsolved interactive widget is reported as unresolved', async () => {
  assert.equal(await hasUnresolvedCaptcha(fakePage({ tokens: [''], challenges: [{ visible: true }] })), true);
});

test('a solved widget is not reported as unresolved', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({ tokens: ['provider-token'], challenges: [{ visible: true }] })),
    false,
  );
});

// The regression this file exists for. reCAPTCHA v3 asks the human for nothing and mints its token
// on submit, so at fill time the response field is empty while the floating badge is visible. The
// badge matches [class*="captcha"], so counting it reported every v3 page as blocked - on JazzHR
// and BambooHR, the two families already typed as CAPTCHA-gated.
test('the reCAPTCHA v3 badge alone is not a challenge', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({ tokens: [''], challenges: [{ visible: true, badge: true }] })),
    false,
  );
});

test('a badge does not hide a real widget rendered beside it', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({
      tokens: [''],
      challenges: [{ visible: true, badge: true }, { visible: true }],
    })),
    true,
  );
});

test('an invisible widget is not a challenge', async () => {
  assert.equal(await hasUnresolvedCaptcha(fakePage({ tokens: [''], challenges: [{ visible: false }] })), false);
});

// ---- bounded wait ----

test('provider solving gets a bounded wait before an unresolved verdict', async () => {
  let responseToken = '';
  const responseLocator = {
    count: async () => 1,
    nth: () => ({ inputValue: async () => responseToken }),
  };
  const challengeLocator = {
    count: async () => 1,
    nth: () => ({
      isVisible: async () => true,
      locator: () => ({ count: async () => 0 }),
      evaluate: async () => false,
    }),
  };
  const page = {
    locator: (selector: string) => (selector.includes('captcha-response') ? responseLocator : challengeLocator),
    waitForTimeout: async () => { responseToken = 'provider-token'; },
  } as unknown as Page;
  assert.equal(await waitForCaptchaResolution(page, 100, 1), true);
});

test('the wait gives up rather than holding a session open forever', async () => {
  let waits = 0;
  const page = {
    locator: (selector: string) => (selector.includes('captcha-response')
      ? { count: async () => 1, nth: () => ({ inputValue: async () => '' }) }
      : {
        count: async () => 1,
        nth: () => ({
          isVisible: async () => true,
          locator: () => ({ count: async () => 0 }),
          evaluate: async () => false,
        }),
      }),
    waitForTimeout: async () => { waits += 1; },
  } as unknown as Page;
  assert.equal(await waitForCaptchaResolution(page, 20, 1), false);
  assert.ok(waits > 0, 'expected at least one poll before giving up');
});

// ---- the final click guard ----

test('the final click guard does not click while any CAPTCHA widget is unresolved', async () => {
  let clickCount = 0;
  const responseLocator = {
    count: async () => 2,
    nth: (index: number) => ({ inputValue: async () => (index === 0 ? 'provider-token' : '') }),
  };
  const challengeLocator = {
    count: async () => 2,
    nth: () => ({
      isVisible: async () => true,
      locator: () => ({ count: async () => 0 }),
      evaluate: async () => false,
    }),
  };
  const button = {
    count: async () => 1,
    click: async () => { clickCount += 1; },
  };
  const page = {
    locator: (selector: string) => (selector.includes('response') ? responseLocator : challengeLocator),
    getByRole: () => ({ last: () => button }),
    waitForLoadState: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), /CAPTCHA_UNRESOLVED/);
  assert.equal(clickCount, 0);
});

test('the final click still happens on a page with no challenge', async () => {
  let clickCount = 0;
  const button = { count: async () => 1, click: async () => { clickCount += 1; } };
  const page = {
    locator: () => ({ count: async () => 0, nth: () => ({}) }),
    getByRole: () => ({ last: () => button }),
    waitForLoadState: async () => undefined,
  } as unknown as Page;

  await clickFinalSubmit(page);
  assert.equal(clickCount, 1);
});

// ---- the boundary itself ----

// Litos does not solve challenges and does not pay anyone to solve them. Browserbase ships a
// solver behind one boolean and Stratus behind one string, so the whole product boundary is two
// values in one object literal that a provider refactor could flip without anyone noticing. These
// two assertions are the tripwire. If a change makes them fail, the change is the problem.
test('the browser provider is never asked to solve a challenge', () => {
  const body = browserSessionBody('ctx', 'https://boards.greenhouse.io/acme/jobs/1', 'proj', 'browserbase') as {
    browserSettings: { solveCaptchas: boolean };
  };
  assert.equal(body.browserSettings.solveCaptchas, false);
});

test('Stratus pauses on a challenge rather than clearing it', () => {
  const body = browserSessionBody('ctx', 'https://boards.greenhouse.io/acme/jobs/1', 'proj', 'stratus') as {
    browserSettings: { protectionPolicy: { challengeBehavior: string } };
  };
  assert.equal(body.browserSettings.protectionPolicy.challengeBehavior, 'pause');
});
