import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import { browserSessionBody, type ManagedBrowserResult } from './browserbase';
import {
  buildManagedCaptchaProbeActions,
  buildManagedPortalActions,
  CAPTCHA_BLOCKER,
  CAPTCHA_CHALLENGE_SELECTOR,
  CAPTCHA_RESPONSE_SELECTOR,
  CAPTCHA_PROVIDER_MARKERS,
  RECAPTCHA_BFRAME_SELECTOR,
  RECAPTCHA_INTERACTIVE_SELECTOR,
  captchaProviderForFamily,
  captchaSnapshotRequiresAttention,
  corroborateManagedCaptchaBlockers,
  detectCaptchaProvider,
  isCaptchaGatedFamily,
  clickFinalSubmit,
  FormIncompleteError,
  READ_SUBMIT_READINESS_SCRIPT,
  hasUnresolvedCaptcha,
  managedCaptchaProvider,
  managedCaptchaVerdictIsCorroborated,
  managedResultRequiresCaptchaAttention,
  CaptchaUnresolvedError,
  SUBMIT_CANDIDATE_SELECTOR,
  NoSubmitControlError,
  type SubmissionPacket,
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
  /**
   * True when this node, or a container around it, carries reCAPTCHA's invisible-mode marker
   * (`data-size="invisible"` on the widget div, or `size=invisible` in an anchor iframe's src).
   * Modelled as one flag rather than as attributes because the production selector matches the node
   * OR an ancestor, and both readings must reach the same stub answer.
   */
  invisibleMode?: boolean;
};

// The invisible-mode selector is a compound attribute selector, not a class, so the class-chain
// logic below cannot answer it. Recognised by content rather than by identity so the stub keeps
// working if the selector gains another invisible-mode shape.
const asksAboutInvisibleMode = (selector: string) => /size=("?)invisible\1/i.test(selector);

// Implements matches(), closest() and classList so the stub does not silently decide which idiom the
// production code is allowed to use. If hasUnresolvedCaptcha is ever refactored to a self-only
// classList check, these tests still run it and still fail on the nested-iframe case, which is the
// point: the stub models the DOM, not the current implementation.
function stubElement(node: FakeNode) {
  const own = node.classes ?? [];
  const chain = [own, ...(node.ancestors ?? [])];
  return {
    classList: { contains: (name: string) => own.includes(name) },
    matches(selector: string) {
      if (asksAboutInvisibleMode(selector)) return node.invisibleMode === true;
      return own.includes(selector.replace(/^\./, ''));
    },
    closest(selector: string) {
      if (asksAboutInvisibleMode(selector)) return node.invisibleMode === true ? {} : null;
      const wanted = selector.replace(/^\./, '');
      return chain.some((classes) => classes.includes(wanted)) ? {} : null;
    },
  };
}

function fakePage(options: { tokens: string[]; challenges: FakeNode[]; bframes?: number }): Page {
  const responseLocator = {
    count: async () => options.tokens.length,
    nth: (index: number) => ({ inputValue: async () => options.tokens[index] ?? '' }),
  };
  const bframeLocator = { count: async () => options.bframes ?? 0 };
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
      if (selector === RECAPTCHA_BFRAME_SELECTOR) return bframeLocator;
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

// The badge exclusion does not cover a form that mounts its OWN invisible widget outside the badge,
// and that node matches [class*="captcha"], is visible, and carries an empty response field - so it
// read as a live challenge on a page asking a human for nothing.
test('an invisible reCAPTCHA rendered outside the badge is not a challenge', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({
      tokens: [''],
      challenges: [{ classes: ['g-recaptcha'], invisibleMode: true }],
    })),
    false,
  );
});

// The escalation case, and the reason `size` alone cannot be the whole rule. reCAPTCHA opens the
// image grid in a bframe while the widget still declares itself invisible: at that moment a person
// really is being asked to pick traffic lights.
test('an invisible widget with the challenge popup open IS a challenge', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({
      tokens: [''],
      challenges: [{ classes: ['g-recaptcha'], invisibleMode: true }],
      bframes: 1,
    })),
    true,
  );
});

test('an invisible widget does not hide a real one beside it', async () => {
  assert.equal(
    await hasUnresolvedCaptcha(fakePage({
      tokens: [''],
      challenges: [{ classes: ['g-recaptcha'], invisibleMode: true }, { classes: ['h-captcha'] }],
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
    /* The pre-submit gate reads the page before the click; a clean read keeps each test about the
       thing it is actually testing. The gate has its own tests below. */
    evaluate: async () => ({ blocking: [], stale: [] }),
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
    /* The pre-submit gate reads the page before the click; a clean read keeps each test about the
       thing it is actually testing. The gate has its own tests below. */
    evaluate: async () => ({ blocking: [], stale: [] }),
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

/* THE FALSE POSITIVE THAT STOPPED THE PRODUCT.
 *
 * "Fails OPEN by construction" was true of exactly one spelling of nothing. `value !== null` calls
 * `undefined`, `""` and a whitespace echo a rendered widget, so an optional extract that matched
 * zero nodes reported a challenge on a page that has none. ManagedBrowserResult declares
 * `value: string | null`, but Stratus is an external service and that declaration is this repo's
 * hope, not its contract - the two other readers of the same array already test `value?.trim()`.
 *
 * Table-driven so the next empty representation is one line, not another copy of the test. */
for (const [name, value] of [
  ['undefined', undefined],
  ['an empty string', ''],
  ['whitespace', '   '],
  ['a newline', '\n'],
] as const) {
  test(`an optional extract that matched nothing and came back as ${name} does not block`, () => {
    assert.equal(
      managedResultRequiresCaptchaAttention(probeResult([
        { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: value as unknown as string | null },
      ])),
      false,
    );
  });
}

// The genuine positive still stops the run. Nothing above is allowed to buy the false-negative side
// of this trade: a real widget with a real site key and no invisible marker blocks, as it always did.
test('a real site key with no invisible marker still stops the managed submit', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6Lc-ExampleSiteKey' },
      { selector: 'iframe', label: 'captcha_bframe', value: '' },
    ])),
    true,
  );
});

/* The live Akuna Greenhouse page, measured 2026-08-08 at the portal_url stored on eleven stalled
 * packets: an invisible reCAPTCHA Enterprise. window.grecaptcha defined, a g-recaptcha-response
 * textarea present and empty, an anchor iframe at size=invisible, no bframe, and every node matching
 * any challenge selector sitting inside .grecaptcha-badge. A person filling that form by hand clicks
 * Submit and is never asked anything. */
const AKUNA_INVISIBLE_PROBE = probeResult([
  { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: null },
  { selector: '[data-sitekey][data-size]', label: 'captcha_size', value: 'invisible' },
  {
    selector: 'iframe',
    label: 'captcha_anchor',
    value: 'https://www.recaptcha.net/recaptcha/enterprise/anchor?ar=1&k=6Lc-ExampleSiteKey&size=invisible&anchor-ms=20000&execute-ms=30000',
  },
  { selector: 'iframe', label: 'captcha_bframe', value: null },
]);

test('the invisible reCAPTCHA on the live Greenhouse page is not a human challenge', () => {
  assert.equal(managedResultRequiresCaptchaAttention(AKUNA_INVISIBLE_PROBE), false);
});

// Even if the sitekey extract DOES come back - the widget container is on the page either way -
// size=invisible with no bframe means nothing is being asked. This is the shape that must never
// block on any path.
//
// REWRITTEN, and the rewrite is the fix. This test used to pass `captcha_size: invisible` beside a
// sitekey and assert that the run continued, which made the invisible finding a property of the
// PAGE: any widget could declare invisible on behalf of any other. The fixture below is now
// byte-identical to the one in "an invisible widget does not hide a real one beside it", so the old
// assertion and the correct one could not both be true. What makes THIS page harmless is that the
// invisible declaration carries the sitekey of the widget it describes, and it is the same sitekey.
test('a site key does not block when that same widget declares itself invisible', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6Lc-ExampleSiteKey' },
      { selector: '[data-sitekey][data-size]', label: 'captcha_size', value: 'invisible' },
      { selector: '[data-sitekey][data-size="invisible" i]', label: 'captcha_invisible_sitekey', value: '6Lc-ExampleSiteKey' },
    ])),
    false,
  );
});

/* THE MANAGED PATH'S HALF OF "an invisible widget does not hide a real one beside it".
 *
 * The direct path has closed this since the badge exclusion went in. The managed path is the one
 * that actually runs unattended in production, and it was open: readManagedCaptchaEvidence reduced
 * the whole page to four scalars by first-non-empty-per-label, so one invisible widget switched the
 * gate off for a real one standing next to it. Measured on the merged tree:
 *
 *   extracted: [{label:'captcha_size', value:'invisible'},
 *               {label:'captcha_challenge', value:'6LcRealVisibleWidget'}]
 *   managedResultRequiresCaptchaAttention          -> false
 *   managedCaptchaVerdictIsCorroborated('greenhouse', ...) -> false
 *
 * A real unsolved sitekey was present and the submit gate opened on it. */
const INVISIBLE_BESIDE_A_REAL_ONE = probeResult([
  { selector: '[data-sitekey][data-size]', label: 'captcha_size', value: 'invisible' },
  { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcRealVisibleWidget' },
]);

test('a page-wide invisible reading does not switch off the gate for a real widget beside it', () => {
  assert.equal(managedResultRequiresCaptchaAttention(INVISIBLE_BESIDE_A_REAL_ONE), true);
  assert.equal(managedCaptchaVerdictIsCorroborated('greenhouse', INVISIBLE_BESIDE_A_REAL_ONE), true);
  assert.deepEqual(
    corroborateManagedCaptchaBlockers('greenhouse', [CAPTCHA_BLOCKER], INVISIBLE_BESIDE_A_REAL_ONE),
    [CAPTCHA_BLOCKER],
  );
});

// Two widgets, one of each, with the invisible one properly attributed. The real one still stops
// the run: being able to explain one widget is not being able to explain the other.
test('an attributed invisible widget still leaves an unexplained one blocking', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcInvisibleWidget' },
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcRealVisibleWidget' },
      { selector: '[data-sitekey][data-size="invisible" i]', label: 'captcha_invisible_sitekey', value: '6LcInvisibleWidget' },
    ])),
    true,
  );
});

// And the honest negative for the same shape: both widgets accounted for, nothing asks a human.
test('two widgets that are both attributed as invisible do not block', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcFirst' },
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcSecond' },
      { selector: '[data-sitekey][data-size="invisible" i]', label: 'captcha_invisible_sitekey', value: '6LcFirst' },
      { selector: '[data-sitekey][data-size="invisible" i]', label: 'captcha_invisible_sitekey', value: '6LcSecond' },
    ])),
    false,
  );
});

// The probe has to ASK for the attribution or none of the above can ever be true in production.
test('the managed probe reads the invisible widget its own sitekey', () => {
  const action = buildManagedCaptchaProbeActions().find((entry) => entry.label === 'captcha_invisible_sitekey');
  assert.ok(action, 'the probe must read which widget the invisible declaration belongs to');
  assert.equal(action.attribute, 'data-sitekey');
  assert.equal(action.optional, true);
  assert.match(action.selector ?? '', /\[data-size="invisible" i\]/);
  assert.match(action.selector ?? '', /:not\(\.grecaptcha-badge\):not\(\.grecaptcha-badge \*\)/);
});

/* ---- two widgets, ONE site key ----
 *
 * The per-widget rule above was written as SET membership, and reCAPTCHA site keys are issued per
 * DOMAIN, so the realistic two-widget employer page is the one where both widgets carry the same
 * key. Measured on the tree that shipped the per-widget rule:
 *
 *   two widgets, distinct keys, one invisible  -> requires = true    (the case that was fixed)
 *   SAME sitekey twice, one invisible          -> requires = false   (the case that was not)
 *
 * The live shape: a Greenhouse posting with the invisible reCAPTCHA on the application form and a
 * rendered v2 checkbox on a "join our talent community" block, both wired to the company's single
 * site key. `['K','K'].filter(k => !new Set(['K']).has(k))` is empty, nothing was left unexplained,
 * and the submit gate opened on a challenge no one had cleared.
 *
 * One invisible reading accounts for ONE widget now. The invisible selector is the challenge
 * selector narrowed by `[data-size="invisible"]`, so its matches are a subset of the challenge
 * matches and multiset subtraction is the arithmetic that matches the markup. */
test('two widgets sharing one site key do not cancel each other', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcSharedDomainKey' },
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcSharedDomainKey' },
      { selector: '[data-sitekey][data-size="invisible" i]', label: 'captcha_invisible_sitekey', value: '6LcSharedDomainKey' },
    ])),
    true,
  );
  // The distinct-key case it was already right about must stay right.
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcInvisibleWidget' },
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcRealVisibleWidget' },
      { selector: '[data-sitekey][data-size="invisible" i]', label: 'captcha_invisible_sitekey', value: '6LcInvisibleWidget' },
    ])),
    true,
  );
  // And a page whose every widget is accounted for, duplicates included, still does not block.
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcSharedDomainKey' },
      { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcSharedDomainKey' },
      { selector: '[data-sitekey][data-size="invisible" i]', label: 'captcha_invisible_sitekey', value: '6LcSharedDomainKey' },
      { selector: '[data-sitekey][data-size="invisible" i]', label: 'captcha_invisible_sitekey', value: '6LcSharedDomainKey' },
    ])),
    false,
  );
});

/* ---- the signal that needs no comparison ----
 *
 * An anchor iframe declares its own size in its src, and the code collected that and only ever read
 * it in the NEGATIVE direction: it was consulted for the badge-only page and ignored the moment any
 * data-sitekey was also readable. Measured on the tree that shipped the per-widget rule:
 *
 *   widget with NO sitekey, anchor size=normal   -> requires = false
 *   two anchors, one invisible one normal        -> requires = false
 *
 * A rendered checkbox announcing itself in plain text was waved through. */
test('an anchor that has not declared itself invisible is a rendered checkbox', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: 'iframe', label: 'captcha_anchor', value: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc-Key&size=normal' },
    ])),
    true,
  );
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: 'iframe', label: 'captcha_anchor', value: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc-Key&size=invisible' },
      { selector: 'iframe', label: 'captcha_anchor', value: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc-Key&size=normal' },
    ])),
    true,
  );
  // An anchor that names no size at all is a checkbox too: reCAPTCHA's default size is `normal`,
  // and reading an absent value as invisible would favour the one direction that ends in a submit
  // under an unsolved challenge.
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: 'iframe', label: 'captcha_anchor', value: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=6Lc-Key' },
    ])),
    true,
  );
  // The Akuna badge-only page is the whole reason the anchor reading exists and must stay open.
  assert.equal(managedResultRequiresCaptchaAttention(AKUNA_INVISIBLE_PROBE), false);
  assert.deepEqual(corroborateManagedCaptchaBlockers('greenhouse', [CAPTCHA_BLOCKER], AKUNA_INVISIBLE_PROBE), []);
});

/* ---- correct under either extract cardinality ----
 *
 * Every list-against-list rule here rests on an assumption this repo cannot verify: that the remote
 * Stratus runner echoes one entry per matched NODE. If `extract` returns one value per SELECTOR
 * instead, `sitekeys` holds at most one element, the two-widget page collapses to one entry against
 * one entry, the subtraction cancels, and per-widget reasoning silently becomes the page-aggregate
 * reading it replaced.
 *
 * `captcha_rendered_sitekey` is the answer to that, and it is why the fix is not the subtraction
 * alone. Its selector is the challenge set MINUS the nodes that declare themselves invisible, so
 * any value at all under that label is a widget that has not said it is invisible - one entry or
 * ten, first in DOM order or last. The fixture below is the same shared-key page as above, reported
 * the way a per-selector runner would report it: the subtraction sees nothing and the gate still
 * closes. */
test('a widget that has not declared itself invisible blocks whatever the runner echoed', () => {
  const perSelectorRunner = probeResult([
    { selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6LcSharedDomainKey' },
    { selector: '[data-sitekey][data-size="invisible" i]', label: 'captcha_invisible_sitekey', value: '6LcSharedDomainKey' },
    { selector: '[data-sitekey]:not([data-size="invisible" i])', label: 'captcha_rendered_sitekey', value: '6LcSharedDomainKey' },
  ]);
  assert.equal(managedResultRequiresCaptchaAttention(perSelectorRunner), true);
  assert.equal(managedCaptchaVerdictIsCorroborated('greenhouse', perSelectorRunner), true);
  assert.deepEqual(
    corroborateManagedCaptchaBlockers('greenhouse', [CAPTCHA_BLOCKER], perSelectorRunner),
    [CAPTCHA_BLOCKER],
  );
});

// The probe has to ASK for it, or the test above can never be true in production.
test('the managed probe reads the sitekey of a widget that is NOT invisible', () => {
  const action = buildManagedCaptchaProbeActions().find((entry) => entry.label === 'captcha_rendered_sitekey');
  assert.ok(action, 'the probe must read the widgets that have not declared themselves invisible');
  assert.equal(action.attribute, 'data-sitekey');
  assert.equal(action.optional, true);
  assert.match(action.selector ?? '', /:not\(\[data-size="invisible" i\]\)/);
  assert.match(action.selector ?? '', /:not\(\.grecaptcha-badge\):not\(\.grecaptcha-badge \*\)/);
});

// Escalation. The widget still says invisible; the bframe says a human is looking at an image grid.
test('an invisible widget with a bframe open blocks the managed submit', () => {
  assert.equal(
    managedResultRequiresCaptchaAttention(probeResult([
      { selector: '[data-sitekey][data-size]', label: 'captcha_size', value: 'invisible' },
      { selector: 'iframe', label: 'captcha_bframe', value: 'https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x' },
    ])),
    true,
  );
});

// ---- the provider recorded on the stall ----

test('a stopped run names the provider instead of shrugging', () => {
  assert.equal(
    managedCaptchaProvider(probeResult([
      { selector: 'iframe', label: 'captcha_bframe', value: 'https://www.recaptcha.net/recaptcha/enterprise/bframe?k=x' },
    ]), 'greenhouse'),
    'recaptcha_v2',
  );
  assert.equal(managedCaptchaProvider(AKUNA_INVISIBLE_PROBE, 'greenhouse'), 'recaptcha_v3');
});

// Not a guess. A bare [data-sitekey] with no reCAPTCHA frame beside it is as consistent with
// hCaptcha or Turnstile, and a wrong provider label is worse than an absent one.
test('a provider with no frame evidence falls back to the family reading', () => {
  assert.equal(
    managedCaptchaProvider(probeResult([{ selector: CHALLENGE_SEL, label: 'captcha_challenge', value: 'key' }]), 'greenhouse'),
    captchaProviderForFamily('greenhouse'),
  );
  assert.equal(managedCaptchaProvider(null, 'jazzhr'), 'recaptcha_v2');
});

// ---- corroboration: the second layer ----
//
// One predicate gates every managed submission Litos makes. When it said yes wrongly the whole
// product stopped, so on the families Litos claims it can finish unaided the page has to agree.

test('an uncorroborated CAPTCHA verdict is dropped on an autonomous family', () => {
  assert.deepEqual(
    corroborateManagedCaptchaBlockers('greenhouse', [CAPTCHA_BLOCKER, '"GPA" is required and is still empty'], null),
    ['"GPA" is required and is still empty'],
  );
  assert.deepEqual(
    corroborateManagedCaptchaBlockers('greenhouse', [CAPTCHA_BLOCKER], AKUNA_INVISIBLE_PROBE),
    [],
  );
});

test('a corroborated CAPTCHA verdict still stops an autonomous family', () => {
  const corroborating = probeResult([{ selector: CHALLENGE_SEL, label: 'captcha_challenge', value: '6Lc-ExampleSiteKey' }]);
  assert.deepEqual(corroborateManagedCaptchaBlockers('greenhouse', [CAPTCHA_BLOCKER], corroborating), [CAPTCHA_BLOCKER]);
  assert.equal(managedCaptchaVerdictIsCorroborated('greenhouse', corroborating), true);
});

// Outside the autonomous families the provider's word stands. JazzHR and BambooHR really do gate
// every form, portalCanAutoSubmit already refuses to submit them, and there is nothing to protect.
test('a CAPTCHA-gated family is believed without corroboration', () => {
  assert.equal(managedCaptchaVerdictIsCorroborated('jazzhr', null), true);
  assert.deepEqual(corroborateManagedCaptchaBlockers('jazzhr', [CAPTCHA_BLOCKER], null), [CAPTCHA_BLOCKER]);
});

// ...but an invisible reCAPTCHA is never a human challenge, on ANY path or family.
test('an invisible reCAPTCHA is not believed even on a CAPTCHA-gated family', () => {
  assert.equal(managedCaptchaVerdictIsCorroborated('jazzhr', AKUNA_INVISIBLE_PROBE), false);
});

test('nothing but a CAPTCHA blocker is ever removed', () => {
  const others = ['"GPA" is required and is still empty', 'A required field on the form has no label Litos can read'];
  assert.deepEqual(corroborateManagedCaptchaBlockers('greenhouse', others, null), others);
});

// The prepare run has no probe call of its own - it reads the runner's blocker list - so the
// evidence has to ride along on the fill actions or corroboration has nothing to read. The submit
// run does make the probe call, so repeating the reads there would spend budget for nothing.
test('the prepare fill run carries the CAPTCHA evidence reads and the submit run does not', () => {
  const packet: SubmissionPacket = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  const evidenceLabels = ['captcha_size', 'captcha_invisible_sitekey', 'captcha_anchor', 'captcha_bframe'];
  const preparing = buildManagedPortalActions('greenhouse', packet, false);
  for (const label of evidenceLabels) {
    assert.ok(
      preparing.some((action) => action.type === 'extract' && action.label === label && action.optional === true),
      `prepare run is missing the ${label} read`,
    );
  }
  const submitting = buildManagedPortalActions('greenhouse', packet, true);
  assert.equal(submitting.some((action) => evidenceLabels.includes(action.label ?? '')), false);
});

// Same rule as the challenge read: never ask the runner for the token. It belongs in the applicant's
// session, and g-recaptcha-response is a <textarea> whose value is a DOM property anyway.
test('the evidence reads never ask the runner for a response token', () => {
  for (const action of buildManagedCaptchaProbeActions()) {
    assert.doesNotMatch(action.selector ?? '', /response/i);
    assert.notEqual(action.attribute, 'value');
    assert.equal(action.optional, true);
  }
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

    /* The pre-submit gate reads the page before the click; a clean read keeps each test about the

       thing it is actually testing. The gate has its own tests below. */

    evaluate: async () => ({ blocking: [], stale: [] }),

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
    /* The pre-submit gate reads the page before the click; a clean read keeps each test about the
       thing it is actually testing. The gate has its own tests below. */
    evaluate: async () => ({ blocking: [], stale: [] }),
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
    /* The pre-submit gate reads the page before the click; a clean read keeps each test about the
       thing it is actually testing. The gate has its own tests below. */
    evaluate: async () => ({ blocking: [], stale: [] }),
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
    /* The pre-submit gate reads the page before the click; a clean read keeps each test about the
       thing it is actually testing. The gate has its own tests below. */
    evaluate: async () => ({ blocking: [], stale: [] }),
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
    /* The pre-submit gate reads the page before the click; a clean read keeps each test about the
       thing it is actually testing. The gate has its own tests below. */
    evaluate: async () => ({ blocking: [], stale: [] }),
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
    /* The pre-submit gate reads the page before the click; a clean read keeps each test about the
       thing it is actually testing. The gate has its own tests below. */
    evaluate: async () => ({ blocking: [], stale: [] }),
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
    /* The pre-submit gate reads the page before the click, and deliberately does NOT appear in
       `order`: it is inspection, and the ordering this test pins is barrier-then-dispatch. */
    evaluate: async () => ({ blocking: [], stale: [] }),
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
    /* The pre-submit gate reads the page before the click; a clean read keeps each test about the
       thing it is actually testing. The gate has its own tests below. */
    evaluate: async () => ({ blocking: [], stale: [] }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), NoSubmitControlError);
});

/* ---- the pre-submit required-field gate ----
 *
 * The Redwood Materials incident, 2026-08-08. A packet reached ready_for_final_approval with every
 * question answered, and its preview screenshot showed the correctly filled form under five red
 * "is required" messages. Measured against the live form, the messages were STALE: a stray
 * keystroke had run the employer's validator mid-fill, and Greenhouse never clears those messages
 * once rendered - "Phone is required." stayed on screen underneath a filled phone number.
 * Submitting the completed form passed validation with zero errors.
 *
 * So the gate has to be right in BOTH directions. Refusing on stale text throws away complete
 * applications; trusting a form that is genuinely half empty sends one an employer keeps forever.
 */

function gatedPage(readiness: unknown, onClick: () => void) {
  return {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? submitButtonLocator(onClick)
      : { count: async () => 0, nth: () => ({}) }),
    evaluate: async () => readiness,
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;
}

test('submit is not pressed while a required field is still empty', async () => {
  let clicks = 0;
  const page = gatedPage({
    blocking: ['"Resume/CV" is required and is still empty', '"Are you currently enrolled in a degree program?" is required and is still empty'],
    stale: [],
  }, () => { clicks += 1; });

  await assert.rejects(clickFinalSubmit(page), FormIncompleteError);
  assert.equal(clicks, 0);
});

test('the refusal names the fields, and reads as a click that provably did not happen', async () => {
  // FormIncompleteError extends NoSubmitControlError precisely so fail() keeps saying "nothing was
  // sent" rather than "check the portal or your email" for a run that pressed nothing.
  const error = new FormIncompleteError(['"Resume/CV" is required and is still empty']);
  assert.ok(error instanceof NoSubmitControlError);
  assert.match(error.message, /did not press submit/);
  assert.match(error.message, /Resume\/CV/);
  assert.deepEqual(error.fields, ['"Resume/CV" is required and is still empty']);
  // Six empty fields must not produce a six-line sentence; the count carries the rest.
  const many = new FormIncompleteError(['a', 'b', 'c', 'd', 'e', 'f']);
  assert.match(many.message, /6 required fields/);
  assert.match(many.message, /and 1 more/);
});

test('stale validation text over a filled form does not stop the submit', async () => {
  /* THE REGRESSION THAT MATTERS MOST. The Redwood form carried five "is required" messages while
     being complete and submittable. A gate that refuses on error text would have thrown that
     application away, which is the same harm as sending a broken one and much harder to notice. */
  let clicks = 0;
  const page = gatedPage({
    blocking: [],
    stale: ['Phone is required.', 'Resume/CV is required.', 'This field is required.'],
  }, () => { clicks += 1; });

  await clickFinalSubmit(page);
  assert.equal(clicks, 1);
});

test('a readiness read that throws stops the submit rather than guessing', async () => {
  // Fails closed. A handoff card is recoverable; an employer holding a half-blank application in
  // the applicant's name is not.
  let clicks = 0;
  const page = {
    locator: (selector: string) => (selector === SUBMIT_CANDIDATE_SELECTOR
      ? submitButtonLocator(() => { clicks += 1; })
      : { count: async () => 0, nth: () => ({}) }),
    evaluate: async () => { throw new Error('Execution context was destroyed'); },
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), (error: unknown) => {
    assert.ok(error instanceof NoSubmitControlError);
    assert.match((error as Error).message, /could not confirm the form was complete/);
    return true;
  });
  assert.equal(clicks, 0);
});

test('a captcha still outranks an incomplete form', async () => {
  /* Precedence, and it is the same reason the captcha probe sits above the no-control throw: a
     challenge routinely suppresses the form, so the fields read empty BECAUSE of the challenge.
     Reporting "seven fields are empty" there hides the one thing the applicant can act on. */
  let clicks = 0;
  const responseLocator = { count: async () => 1, nth: () => ({ inputValue: async () => '' }) };
  const challengeLocator = {
    count: async () => 1,
    nth: () => ({
      isVisible: async () => true,
      evaluate: async (fn: (el: unknown, arg: string) => boolean, arg: string) => fn(stubElement({}), arg),
    }),
  };
  const page = {
    locator: (selector: string) => {
      if (selector === CAPTCHA_RESPONSE_SELECTOR) return responseLocator;
      if (selector === SUBMIT_CANDIDATE_SELECTOR) return submitButtonLocator(() => { clicks += 1; });
      return challengeLocator;
    },
    evaluate: async () => ({ blocking: ['"Resume/CV" is required and is still empty'], stale: [] }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;

  await assert.rejects(clickFinalSubmit(page), CaptchaUnresolvedError);
  assert.equal(clicks, 0);
});

test('the readiness script reads a control where its answer actually lives', () => {
  /* The script is a source string evaluated in the live page (this project has no "dom" lib), so
     these pin the properties that were MEASURED on the live Redwood Materials form and that an
     ordinary value-check gets wrong. The behaviour itself is covered end to end by the identical
     gate in stratus-browser-cloud, verified live against that posting in both directions. */
  // React Select clears the combobox input's search text on selection, so the answer is only in the
  // rendered value. Reading the input would call every answered question empty.
  assert.match(READ_SUBMIT_READINESS_SCRIPT, /select__single-value/);
  assert.match(READ_SUBMIT_READINESS_SCRIPT, /select__placeholder/);
  assert.match(READ_SUBMIT_READINESS_SCRIPT, /getAttribute\('role'\) === 'combobox'\) continue;/);
  // Greenhouse removes the file input once the upload finishes and leaves a filename chip.
  assert.match(READ_SUBMIT_READINESS_SCRIPT, /file-upload__filename/);
  // React Select's input carries aria-required and no required attribute, so [required] alone
  // cannot see an unanswered Greenhouse screener question.
  assert.match(READ_SUBMIT_READINESS_SCRIPT, /\[aria-required="true"\]/);
  // The form's own legend is not an error, and it was the only thing an early version of this found
  // on a complete application.
  assert.match(READ_SUBMIT_READINESS_SCRIPT, /const LEGEND_TEXT = /);
  assert.match(READ_SUBMIT_READINESS_SCRIPT, /indicates\?/);
  // An error over a filled control is stale and is reported, not blocked on.
  assert.match(READ_SUBMIT_READINESS_SCRIPT, /if \(widgetHasAnswer\(widget\)\) \{ stale\.push\(text\); continue; \}/);
});
