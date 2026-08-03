import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { browserSessionBody } from './browserbase';
import {
  captchaSnapshotRequiresAttention,
  clickFinalSubmit,
  hasUnresolvedCaptcha,
  CaptchaUnresolvedError,
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

// A provider that writes whitespace into the response field has not been cleared by anyone. Without
// the trim, this reads as solved and the submit click goes through under a live challenge.
test('a whitespace-only token is not a solved challenge', () => {
  assert.equal(captchaSnapshotRequiresAttention(['  \n '], 1), true);
});

// ---- page probing ----
//
// The fake page models a DOM tree rather than canned booleans, and its evaluate() actually RUNS the
// callback hasUnresolvedCaptcha passes in, against a stub node implementing closest(). An earlier
// version returned a pre-computed answer, which meant the badge-exclusion callback never executed
// and a typo in the class name would have shipped green.

type FakeNode = {
  classes?: string[];
  /** class list of each ancestor, nearest first. Lets a test express "inside the badge". */
  ancestors?: string[][];
  visible?: boolean;
  visibilityThrows?: boolean;
};

// Implements BOTH closest() and classList so the stub does not silently decide which idiom the
// production code is allowed to use. If hasUnresolvedCaptcha is ever refactored to a self-only
// classList check, these tests still run it and still fail on the nested-iframe case, which is the
// point: the stub models the DOM, not the current implementation.
function stubElement(node: FakeNode) {
  const own = node.classes ?? [];
  const chain = [own, ...(node.ancestors ?? [])];
  return {
    classList: { contains: (name: string) => own.includes(name) },
    closest(selector: string) {
      const wanted = selector.replace(/^\./, '');
      return chain.some((classes) => classes.includes(wanted)) ? {} : null;
    },
  };
}

function fakePage(options: { tokens: string[]; challenges: FakeNode[] }): Page {
  const responseLocator = {
    count: async () => options.tokens.length,
    nth: (index: number) => ({ inputValue: async () => options.tokens[index] ?? '' }),
  };
  const challengeLocator = {
    count: async () => options.challenges.length,
    nth: (index: number) => {
      const node = options.challenges[index]!;
      return {
        isVisible: async () => {
          if (node.visibilityThrows) throw new Error('element is not attached to the DOM');
          return node.visible ?? true;
        },
        evaluate: async (fn: (el: unknown, arg: string) => boolean, arg: string) => fn(stubElement(node), arg),
      };
    },
  };
  return {
    locator: (selector: string) => (selector.includes('captcha-response') || selector.includes('turnstile-response')
      ? responseLocator
      : challengeLocator),
  } as unknown as Page;
}

test('an unsolved interactive widget is reported as unresolved', async () => {
  assert.equal(await hasUnresolvedCaptcha(fakePage({ tokens: [''], challenges: [{}] })), true);
});

test('a solved widget is not reported as unresolved', async () => {
  assert.equal(await hasUnresolvedCaptcha(fakePage({ tokens: ['provider-token'], challenges: [{}] })), false);
});

test('an invisible widget is not a challenge', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({ tokens: [''], challenges: [{ visible: false }] })),
    false,
  );
});

// The regression this file exists for. reCAPTCHA v3 asks the human for nothing and mints its token
// on submit, so at fill time the response field is empty while the badge is visible.
test('the reCAPTCHA v3 badge alone is not a challenge', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({
      tokens: [''],
      challenges: [{ classes: ['grecaptcha-badge'] }],
    })),
    false,
  );
});

// The badge is a CONTAINER. Its inner anchor iframe matches iframe[src*="captcha"] on its own, has
// no badge class of its own, and contains no badge - so a self-or-descendant check counted it and
// the v3 page still reported blocked. This is the shape a real page ships.
test('the anchor iframe INSIDE the v3 badge is not a challenge either', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({
      tokens: [''],
      challenges: [
        { classes: ['grecaptcha-badge'] },
        { classes: [], ancestors: [['grecaptcha-badge']] },
      ],
    })),
    false,
  );
});

test('a badge does not hide a real widget rendered outside it', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({
      tokens: [''],
      challenges: [{ classes: ['grecaptcha-badge'] }, { classes: ['g-recaptcha'] }],
    })),
    true,
  );
});

// The guard fails CLOSED. A widget that detaches mid-probe is routine during a reCAPTCHA re-render,
// and a guard that cannot see must assume the thing it guards against.
test('a visibility probe that throws counts as a challenge, not as a clear page', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({ tokens: [''], challenges: [{ visibilityThrows: true }] })),
    true,
  );
});

// ---- the final click guard ----

test('the final click guard does not click while any widget is unresolved', async () => {
  let clickCount = 0;
  const responseLocator = {
    count: async () => 2,
    nth: (index: number) => ({ inputValue: async () => (index === 0 ? 'provider-token' : '') }),
  };
  const challengeLocator = {
    count: async () => 2,
    nth: () => ({
      isVisible: async () => true,
      evaluate: async (fn: (el: unknown, arg: string) => boolean, arg: string) => fn(stubElement({}), arg),
    }),
  };
  const button = { count: async () => 1, click: async () => { clickCount += 1; } };
  const page = {
    locator: (selector: string) => (selector.includes('response') ? responseLocator : challengeLocator),
    getByRole: () => ({ last: () => button }),
    waitForLoadState: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), CaptchaUnresolvedError);
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
//
// Litos does not solve challenges and does not pay anyone to solve them. Browserbase ships a solver
// behind one boolean and Stratus behind one string, so the whole product boundary is two values in
// one object literal that a provider refactor could flip without anyone noticing. browserbase.test.ts
// deep-equals the full session body, which would also catch a flip; these two exist so the failure
// names the boundary instead of printing an object diff.
//
// NEITHER covers BROWSER_PROVIDER=stratus-managed, which sends no browserSettings at all.

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
