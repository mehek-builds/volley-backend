import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { browserSessionBody, type ManagedBrowserResult } from './browserbase';
import {
  buildManagedCaptchaProbeActions,
  CAPTCHA_CHALLENGE_SELECTOR,
  CAPTCHA_RESPONSE_SELECTOR,
  captchaProviderForFamily,
  captchaSnapshotRequiresAttention,
  detectCaptchaProvider,
  isCaptchaGatedFamily,
  clickFinalSubmit,
  hasUnresolvedCaptcha,
  managedResultRequiresCaptchaAttention,
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
  // Dispatch on selector IDENTITY, not a substring. A substring test silently misroutes the moment
  // another selector in this file happens to contain the same fragment - which it did: the Turnstile
  // provider marker contains "turnstile-response" and was being answered by the response locator.
  return {
    locator: (selector: string) => {
      if (selector === CAPTCHA_RESPONSE_SELECTOR) return responseLocator;
      if (selector === CAPTCHA_CHALLENGE_SELECTOR) return challengeLocator;
      throw new Error(`unexpected selector in fakePage: ${selector}`);
    },
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
    locator: (selector: string) => (selector === CAPTCHA_RESPONSE_SELECTOR ? responseLocator : challengeLocator),
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

// ---- the managed-path probe ----
//
// The managed runner has no Page, so the direct-path guard cannot reach it. These cover the pure
// decision function; the extract semantics of the remote runner itself are NOT verified here and
// need one live run against the QA portal.

function probeResult(entries: Array<{ selector: string; value: string | null }>): ManagedBrowserResult {
  return { title: '', url: '', text: '', extracted: entries };
}

const probeActions = buildManagedCaptchaProbeActions();
const challengeAction = probeActions.find((action) => action.label === 'captcha_challenge')!;
const CHALLENGE_SEL = challengeAction.selector!;

test('the managed probe excludes the v3 badge in CSS', () => {
  assert.match(CHALLENGE_SEL, /:not\(\.grecaptcha-badge\):not\(\.grecaptcha-badge \*\)/);
});

// The probe must never ask the remote runner to read the token. The applicant's session is where
// that value belongs, and g-recaptcha-response is a <textarea> whose value is a DOM property, so an
// attribute read would have returned null on a solved widget and blocked a cleared challenge.
test('the managed probe never asks the runner for a response token', () => {
  for (const action of probeActions) {
    assert.doesNotMatch(action.selector ?? '', /response/i);
    assert.notEqual(action.attribute, 'value');
  }
});

// Every node this selector matches carries data-sitekey by definition, so a match can never come
// back as a null value and be silently discarded.
test('the managed probe keys on an attribute every matched node has', () => {
  assert.equal(challengeAction.attribute, 'data-sitekey');
  assert.match(CHALLENGE_SEL, /^\[data-sitekey\]/);
});

test('a rendered widget stops the managed submit', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([{ selector: CHALLENGE_SEL, value: 'site-key-abc' }])),
    true,
  );
});

test('no matched widget does not stop the managed submit', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([{ selector: CHALLENGE_SEL, value: null }])),
    false,
  );
});

// If the runner echoes one entry per matched node, a first entry that did not match must not hide a
// real widget behind it. find() would have stopped at the first; some() does not.
test('a later matched node is not hidden by an earlier unmatched one', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: CHALLENGE_SEL, value: null },
      { selector: CHALLENGE_SEL, value: 'site-key-abc' },
    ])),
    true,
  );
});

test('an entry for a different selector never stops the managed submit', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: 'input[type="file"]', value: 'file' },
    ])),
    false,
  );
});

// Fails open, on purpose: an unrecognised shape leaves the managed path exactly where it was before
// the probe existed rather than blocking submissions on a protocol mismatch.
test('an unreadable probe result never blocks a submission', () => {
  assert.equal(managedResultRequiresCaptchaAttention(null), false);
  assert.equal(managedResultRequiresCaptchaAttention(probeResult([])), false);
  assert.equal(managedResultRequiresCaptchaAttention({ title: '', url: '', text: '' }), false);
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

// ---- provider identification ----
//
// Recorded on the stall so instrumentation can answer "which families actually gate us" rather than
// producing one undifferentiated count.

function providerPage(selectorsPresent: Record<string, number>): Page {
  return {
    locator: (selector: string) => ({
      count: async () => selectorsPresent[selector] ?? 0,
    }),
  } as unknown as Page;
}

test('a page with no challenge markup reports an unknown provider', async () => {
  assert.equal(await detectCaptchaProvider(providerPage({})), 'unknown');
});

test('Turnstile is identified by its response field', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      '[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com" i]': 1,
    })),
    'turnstile',
  );
});

test('hCaptcha is identified by its response field', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      '[name="h-captcha-response"], iframe[src*="hcaptcha.com" i]': 1,
    })),
    'hcaptcha',
  );
});

test('Arkose is identified by its frame', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      'iframe[src*="arkoselabs" i], iframe[src*="funcaptcha" i]': 2,
    })),
    'arkose',
  );
});

// The v2/v3 split runs off the same signal as the badge exclusion: an interactive widget lives
// OUTSIDE the badge, so a page whose only reCAPTCHA markup is the badge is v3 and asks nothing.
test('a reCAPTCHA page with an interactive widget is v2', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      '[name="g-recaptcha-response"], iframe[src*="recaptcha" i]': 2,
      'iframe[src*="recaptcha" i]:not(.grecaptcha-badge *)': 1,
    })),
    'recaptcha_v2',
  );
});

test('a reCAPTCHA page with only the badge is v3', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      '[name="g-recaptcha-response"], iframe[src*="recaptcha" i]': 2,
      'iframe[src*="recaptcha" i]:not(.grecaptcha-badge *)': 0,
    })),
    'recaptcha_v3',
  );
});

// A page that switched vendors and left markup behind reads as the newer one, which is the one
// actually gating it.
test('a page carrying both reCAPTCHA and Turnstile reports Turnstile', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      '[name="cf-turnstile-response"], iframe[src*="challenges.cloudflare.com" i]': 1,
      '[name="g-recaptcha-response"], iframe[src*="recaptcha" i]': 1,
    })),
    'turnstile',
  );
});

test('the known-gated families carry their measured provider, others stay unknown', () => {
  assert.equal(captchaProviderForFamily('jazzhr'), 'recaptcha_v2');
  assert.equal(captchaProviderForFamily('bamboohr'), 'recaptcha_v2');
  assert.equal(captchaProviderForFamily('greenhouse'), 'unknown');
  assert.equal(isCaptchaGatedFamily('jazzhr'), true);
  assert.equal(isCaptchaGatedFamily('greenhouse'), false);
});

test('the submit guard carries the provider it saw while the page was open', async () => {
  const page = {
    locator: (selector: string) => {
      if (selector === CAPTCHA_RESPONSE_SELECTOR) {
        return { count: async () => 1, nth: () => ({ inputValue: async () => '' }) };
      }
      if (selector.includes('hcaptcha.com')) return { count: async () => 1 };
      if (selector.includes('cf-turnstile-response')) return { count: async () => 0 };
      return {
        count: async () => 1,
        nth: () => ({
          isVisible: async () => true,
          evaluate: async (fn: (el: unknown, arg: string) => boolean, arg: string) => fn(stubElement({}), arg),
        }),
      };
    },
    getByRole: () => ({ last: () => ({ count: async () => 1, click: async () => undefined }) }),
    waitForLoadState: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), (error: unknown) => {
    assert.ok(error instanceof CaptchaUnresolvedError);
    assert.equal(error.provider, 'hcaptcha');
    assert.equal(error.stage, 'at_submit');
    return true;
  });
});
