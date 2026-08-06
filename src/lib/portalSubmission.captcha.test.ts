import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { browserSessionBody, type ManagedBrowserResult } from './browserbase';
import {
  buildManagedCaptchaProbeActions,
  CAPTCHA_CHALLENGE_SELECTOR,
  CAPTCHA_RESPONSE_SELECTOR,
  CAPTCHA_PROVIDER_MARKERS,
  RECAPTCHA_INTERACTIVE_SELECTOR,
  captchaProviderForFamily,
  captchaSnapshotRequiresAttention,
  detectCaptchaProvider,
  isCaptchaGatedFamily,
  clickFinalSubmit,
  hasUnresolvedCaptcha,
  managedResultRequiresCaptchaAttention,
  CaptchaUnresolvedError,
  SUBMIT_CANDIDATE_SELECTOR,
  NoSubmitControlError,
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


/* clickFinalSubmit now reads every button's LABEL and chooses among them (see chooseSubmitControl),
   rather than trusting a name regex and taking .last(). These mocks therefore have to answer
   evaluateAll with the labels a real page would show. One genuine submit control is what each of
   these tests means by "the button". */
function submitButtonLocator(onClick: (label: string) => void, labels = ['Submit application']) {
  /* Models elementHandles(), which is what clickFinalSubmit now uses. Each handle knows its OWN
     label and clicking it reports that label - so a test can assert WHICH control was pressed, not
     merely that something was. The previous mock returned one clickable stub for every ordinal,
     which meant index drift, the riskiest property of this change, could not be expressed as a
     failing test at all. */
  const handles = labels.map((label) => ({
    evaluate: async (fn: (node: unknown) => string) => fn({
      innerText: label,
      disabled: false,
      tagName: 'BUTTON',
      type: '',
      value: '',
      title: '',
      getAttribute: () => null,
      getClientRects: () => ({ length: 1 }),
      /* READ_CONTROL_LABEL walks ancestors for aria-hidden and asks the view for computed
         visibility, so a node shape without these throws before it ever reads the label. */
      parentElement: null,
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
        getElementById: () => null,
      },
    }),
    click: async () => { onClick(label); },
    dispose: async () => undefined,
  }));
  return { elementHandles: async () => handles };
}

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
  const button = submitButtonLocator(() => { clickCount += 1; });
  const page = {
    locator: (selector: string) => {
      if (selector === CAPTCHA_RESPONSE_SELECTOR) return responseLocator;
      if (selector === SUBMIT_CANDIDATE_SELECTOR) return button;
      return challengeLocator;
    },
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), CaptchaUnresolvedError);
  assert.equal(clickCount, 0);
});

test('the final click still happens on a page with no challenge', async () => {
  let clickCount = 0;
  const button = submitButtonLocator(() => { clickCount += 1; });
  const page = {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? button
      : { count: async () => 0, nth: () => ({}) }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await clickFinalSubmit(page);
  assert.equal(clickCount, 1);
});

// ---- the managed-path probe ----
//
// The managed runner has no Page, so the direct-path guard cannot reach it. These cover the pure
// decision function; the extract semantics of the remote runner itself are NOT verified here and
// need one live run against the QA portal.

function probeResult(entries: NonNullable<ManagedBrowserResult['extracted']>): ManagedBrowserResult {
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
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([{ selector: '#ignored', label: 'captcha_challenge', value: 'site-key-abc' }])),
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

// Keys off the PRODUCTION constants and throws on anything else. Transcribing the selectors into
// the test would let a production selector drift while every zero-count expectation kept passing
// against a selector that no longer exists.
const KNOWN_PROVIDER_SELECTORS = new Set<string>([
  ...CAPTCHA_PROVIDER_MARKERS.map((marker) => marker.selector),
  RECAPTCHA_INTERACTIVE_SELECTOR,
]);

function providerPage(selectorsPresent: Record<string, number | 'throws'>): Page {
  return {
    locator: (selector: string) => {
      if (!KNOWN_PROVIDER_SELECTORS.has(selector)) {
        throw new Error(`unexpected selector in providerPage: ${selector}`);
      }
      return {
        count: async () => {
          const value = selectorsPresent[selector] ?? 0;
          if (value === 'throws') throw new Error('element is not attached to the DOM');
          return value;
        },
      };
    },
  } as unknown as Page;
}

const MARKER = Object.fromEntries(
  CAPTCHA_PROVIDER_MARKERS.map((marker) => [marker.provider, marker.selector]),
) as Record<string, string>;

test('a page with no challenge markup reports an unknown provider', async () => {
  assert.equal(await detectCaptchaProvider(providerPage({})), 'unknown');
});

test('Turnstile is identified by its response field', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      [MARKER.turnstile!]: 1,
    })),
    'turnstile',
  );
});

test('hCaptcha is identified by its response field', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      [MARKER.hcaptcha!]: 1,
    })),
    'hcaptcha',
  );
});

test('Arkose is identified by its frame', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      [MARKER.arkose!]: 2,
    })),
    'arkose',
  );
});

// The v2/v3 split runs off the same signal as the badge exclusion: an interactive widget lives
// OUTSIDE the badge, so a page whose only reCAPTCHA markup is the badge is v3 and asks nothing.
test('a reCAPTCHA page with an interactive widget is v2', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      [MARKER.recaptcha_v2!]: 2,
      [RECAPTCHA_INTERACTIVE_SELECTOR]: 1,
    })),
    'recaptcha_v2',
  );
});

test('a reCAPTCHA page with only the badge is v3', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      [MARKER.recaptcha_v2!]: 2,
      [RECAPTCHA_INTERACTIVE_SELECTOR]: 0,
    })),
    'recaptcha_v3',
  );
});

// A page that switched vendors and left markup behind reads as the newer one, which is the one
// actually gating it.
test('a page carrying both reCAPTCHA and Turnstile reports Turnstile', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      [MARKER.turnstile!]: 1,
      [MARKER.recaptcha_v2!]: 1,
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
      if (selector === SUBMIT_CANDIDATE_SELECTOR) return submitButtonLocator(() => undefined);
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

    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), (error: unknown) => {
    assert.ok(error instanceof CaptchaUnresolvedError);
    assert.equal(error.provider, 'hcaptcha');
    assert.equal(error.stage, 'at_submit');
    return true;
  });
});

// The v2/v3 split decides whether a page is recorded as blocking a human at all, so a probe that
// throws must not be read as the harmless variant.
test('a reCAPTCHA page whose interactive probe throws is not recorded as the harmless v3', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      [MARKER.recaptcha_v2!]: 2,
      [RECAPTCHA_INTERACTIVE_SELECTOR]: 'throws',
    })),
    'recaptcha_v2',
  );
});

test('a marker probe that throws does not misreport a different provider', async () => {
  assert.equal(
    await detectCaptchaProvider(providerPage({
      [MARKER.turnstile!]: 'throws',
      [MARKER.hcaptcha!]: 1,
    })),
    'hcaptcha',
  );
});

test('the control that gets pressed is the one that was chosen, not an ordinal', async () => {
  /* THE PROPERTY THE OLD MOCK COULD NOT EXPRESS. The page offers a handoff first and the real
     submit second, which is the live Greenhouse and SmartRecruiters ordering. If clickFinalSubmit
     ever went back to clicking by index against a re-queried locator, this is what would catch it. */
  const pressed: string[] = [];
  const buttons = submitButtonLocator((label) => pressed.push(label),
    ['Apply with LinkedIn', 'Submit application']);
  const page = {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? buttons
      : { count: async () => 0, nth: () => ({}) }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await clickFinalSubmit(page);
  assert.deepEqual(pressed, ['Submit application']);
});

test('a page offering only handoffs reports that nothing was sent', async () => {
  const pressed: string[] = [];
  const buttons = submitButtonLocator((label) => pressed.push(label),
    ['Apply With Indeed', 'Apply with SEEK', 'Next']);
  const page = {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? buttons
      : { count: async () => 0, nth: () => ({}) }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  /* NoSubmitControlError, not a plain Error: fail() reads the type to decide whether to tell the
     applicant to go looking for a confirmation email. Here there cannot be one. */
  await assert.rejects(clickFinalSubmit(page), NoSubmitControlError);
  assert.deepEqual(pressed, [], 'nothing may be pressed');
});

test('a click that times out reports that nothing was sent', async () => {
  /* THE LIKELIER HALF. Playwright's actionability wait fails BEFORE dispatching anything - an
     obscured button under a cookie banner or a sticky consent footer is a routine headless
     failure, more common than finding no control at all. Treating it as "maybe sent" is the exact
     harm this branch exists to remove. */
  const timeout = Object.assign(new Error('locator.click: Timeout 30000ms exceeded'),
    { name: 'TimeoutError' });
  const buttons = {
    elementHandles: async () => [{
      evaluate: async (fn: (node: unknown) => string) => fn({
        innerText: 'Submit application', disabled: false, tagName: 'BUTTON', type: '', value: '',
        title: '', getAttribute: () => null, getClientRects: () => ({ length: 1 }),
        parentElement: null,
        ownerDocument: {
          defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
          getElementById: () => null,
        },
      }),
      click: async () => { throw timeout; },
      dispose: async () => undefined,
    }],
  };
  const page = {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? buttons
      : { count: async () => 0, nth: () => ({}) }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), NoSubmitControlError);
});

test('a pre-click failure is not reported as a submission that may have happened', async () => {
  const page = {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? { elementHandles: async () => { throw new Error('Execution context was destroyed'); } }
      : { count: async () => 0, nth: () => ({}) }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  await assert.rejects(clickFinalSubmit(page), NoSubmitControlError);
});

test('a control relabelled between choosing it and pressing it is not pressed', async () => {
  /* The handle cannot drift to a different element, but the element itself can be relabelled by a
     re-render - and the cost of being wrong is clicking a handoff on a real application. This
     handle reads as the real submit when it is chosen and as a LinkedIn handoff a moment later. */
  let reads = 0;
  let clicked = false;
  const node = (text: string) => ({
    innerText: text, disabled: false, tagName: 'BUTTON', type: '', value: '', title: '',
    getAttribute: () => null, getClientRects: () => ({ length: 1 }), parentElement: null,
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
      getElementById: () => null,
    },
  });
  const buttons = {
    elementHandles: async () => [{
      evaluate: async (fn: (n: unknown) => string) => {
        reads += 1;
        return fn(node(reads === 1 ? 'Submit application' : 'Apply with LinkedIn'));
      },
      click: async () => { clicked = true; },
      dispose: async () => undefined,
    }],
  };
  const page = {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? buttons
      : { count: async () => 0, nth: () => ({}) }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), NoSubmitControlError);
  assert.equal(clicked, false, 'the relabelled control must not be pressed');
});

test('the navigation barrier is armed before the click, not after it', async () => {
  /* THE PASS-SEVEN DEFECT. noWaitAfter removes the barrier Playwright arms before dispatch, so a
     waitForNavigation created AFTER the click races the navigation it is meant to catch and
     waitForLoadState resolves against the page we are still standing on - readReceipt then reads
     the open form, throws, and a genuinely submitted application is reported as unverified.
     Measured 10 of 15 stale reads before this fix. The order is the fix, so the order is the test. */
  const order: string[] = [];
  const buttons = {
    elementHandles: async () => [{
      evaluate: async (fn: (n: unknown) => string) => fn({
        innerText: 'Submit application', disabled: false, tagName: 'BUTTON', type: '', value: '',
        title: '', getAttribute: () => null, getClientRects: () => ({ length: 1 }),
        parentElement: null,
        ownerDocument: {
          defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
          getElementById: () => null,
        },
      }),
      click: async () => { order.push('click'); },
      dispose: async () => undefined,
    }],
  };
  const page = {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? buttons
      : { count: async () => 0, nth: () => ({}) }),
    waitForNavigation: async () => { order.push('waitForNavigation'); },
    waitForLoadState: async () => { order.push('waitForLoadState'); },
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await clickFinalSubmit(page);
  assert.equal(order[0], 'waitForNavigation',
    'the navigation promise must be created before the click is dispatched');
  assert.deepEqual(order, ['waitForNavigation', 'click', 'waitForLoadState']);
});

test('a detached element is pre-dispatch too, and says nothing was sent', async () => {
  /* Playwright throws a PLAIN Error for this, not a TimeoutError, so the name check alone let it
     inherit "the submission was attempted... check your email". It is the SPA-re-render case. */
  const detached = new Error('elementHandle.click: Element is not attached to the DOM');
  const buttons = {
    elementHandles: async () => [{
      evaluate: async (fn: (n: unknown) => string) => fn({
        innerText: 'Submit application', disabled: false, tagName: 'BUTTON', type: '', value: '',
        title: '', getAttribute: () => null, getClientRects: () => ({ length: 1 }),
        parentElement: null,
        ownerDocument: {
          defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
          getElementById: () => null,
        },
      }),
      click: async () => { throw detached; },
      dispose: async () => undefined,
    }],
  };
  const page = {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? buttons
      : { count: async () => 0, nth: () => ({}) }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), NoSubmitControlError);
});
