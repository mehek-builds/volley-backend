import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MANAGED_SUBMIT_CHOOSER_POLICY, runManagedBrowser, type ManagedBrowserResult } from './browserbase';
import {
  assertManagedRequiredFieldsConfirmed,
  AUTONOMOUS_PORTAL_FAMILIES,
  buildManagedPortalActions,
  COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT,
  MANAGED_ACTION_LIMIT,
  MANAGED_FINAL_SUBMIT_SELECTOR,
  managedApplicationProofIsRequired,
  ManagedActionBudgetError,
  ManagedConfirmationUnprovenError,
  ManagedRequiredFieldConfirmationError,
  NoSubmitControlError,
  UNATTRIBUTED_REQUIRED_BLOCKER,
  type SubmissionPacket,
  type SupportedPortal,
} from './portalSubmission';

const packet: SubmissionPacket = {
  fullName: 'Taylor Example',
  email: 'taylor@example.com',
  phone: '+1 415 555 0101',
  city: 'San Francisco',
  resume: Buffer.from('pdf'),
  resumeName: 'resume.pdf',
  questions: [],
};

function proof(
  inputAttempts: Array<Omit<NonNullable<ManagedBrowserResult['requiredFieldConfirmation']>['passes'][number]['attempts'][number], 'attemptCount'> & { attemptCount?: 1 | 2 }>,
  overrides: Partial<NonNullable<ManagedBrowserResult['requiredFieldConfirmation']>['passes'][number]>
    & { status?: 'confirmed' | 'blocked' } = {},
): Pick<ManagedBrowserResult, 'requiredFieldConfirmation'> {
  const attempts = inputAttempts.map((attempt) => ({ attemptCount: 1 as const, ...attempt }));
  const { status = 'confirmed', ...passOverrides } = overrides;
  return {
    requiredFieldConfirmation: {
      version: 2,
      status,
      passes: [{
        submitKind: 'application',
        scope: {
          formFingerprint: 'form_fingerprint_fixture_1234',
          submitFingerprint: 'submit_fingerprint_fixture_1234',
          formMatchCount: 1,
          submitMatchCount: 1,
          requiredControlCount: attempts.length,
          sameNode: true,
        },
        requiredControls: attempts.map(({ selector, label, fieldType }) => ({ selector, label, fieldType, matchCount: 1 })),
        retries: 0,
        unresolved: [],
        attempts,
        submissionOutcome: 'clicked',
        ...passOverrides,
      }],
    },
  };
}

test('every autonomous managed submit reserves a mandatory confirmation barrier immediately before submit', () => {
  for (const family of AUTONOMOUS_PORTAL_FAMILIES) {
    const actions = buildManagedPortalActions(family as SupportedPortal, packet, true);
    assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `${family} exceeded the managed action limit`);
    assert.deepEqual(actions.at(-1), {
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      label: 'required_field_confirmation',
      optional: false,
      timeout: 10_000,
      maxRetries: 1,
      contractVersion: 2,
      submitKind: 'application',
      chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY,
    });
    assert.equal(actions.filter((action) => action.type === 'click'
      && action.selector === MANAGED_FINAL_SUBMIT_SELECTOR).length, 0);
  }
});

test('confirmation is bound to the exact final-submit chooser instead of the first form on the page', () => {
  const actions = buildManagedPortalActions('lever', packet, true);
  const confirmation = actions.at(-1);
  assert.equal(confirmation?.type, 'confirmAndSubmit');
  assert.equal(confirmation?.selector, MANAGED_FINAL_SUBMIT_SELECTOR);
  assert.equal(confirmation?.contractVersion, 2);
  assert.equal(confirmation?.submitKind, 'application');
  assert.notEqual(confirmation?.selector, 'form');

  // Fixture shape: form[0] is an unrelated newsletter with no required controls. The application
  // form selected through its final submit still owns this stale required error and must block.
  assert.throws(() => assertManagedRequiredFieldsConfirmed(proof([{
    selector: 'input[name="application_email"]',
    label: 'Application email',
    fieldType: 'text',
    outcome: 'failed',
    attemptCount: 2,
    reason: 'This requires an answer',
  }], {
    status: 'blocked',
    submissionOutcome: 'blocked',
    retries: 1,
    unresolved: ['Application email'],
  })));
});

test('atomic submit discovery includes common ATS submit shapes without a separate generic click', () => {
  const actions = buildManagedPortalActions('greenhouse', packet, true);
  const atomic = actions.at(-1)!;
  assert.equal(atomic.type, 'confirmAndSubmit');
  for (const shape of ['button', 'input[type="submit"]', 'input[type="image"]', '[role="button"]']) {
    assert.ok(atomic.selector?.includes(shape), shape);
  }
  assert.equal(actions.some((action) => action.type === 'click'
    && action.selector === MANAGED_FINAL_SUBMIT_SELECTOR), false);
});

test('an empty confirmed scan needs a distinct zero-control form proof', () => {
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(proof([])));
  const omitted = proof([]);
  omitted.requiredFieldConfirmation!.passes[0]!.scope.requiredControlCount = 1;
  assert.throws(() => assertManagedRequiredFieldsConfirmed(omitted), /scan control count/);
});

test('each remote run attests exactly one physical click with the expected kind', () => {
  const receipt = proof([]);
  const application = receipt.requiredFieldConfirmation!.passes[0]!;
  const verification = {
    ...application,
    submitKind: 'verification' as const,
    scope: {
      ...application.scope,
      formFingerprint: 'verification_form_fixture_1234',
      submitFingerprint: 'verification_submit_fixture_1234',
    },
  };
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(receipt, 'application'));
  assert.throws(() => assertManagedRequiredFieldsConfirmed(receipt, 'verification'), /unexpected submit kind/);
  receipt.requiredFieldConfirmation!.passes = [verification];
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(receipt, 'verification'));
  receipt.requiredFieldConfirmation!.passes = [application, verification];
  assert.throws(() => assertManagedRequiredFieldsConfirmed(receipt), /confirmation passes/);
});

/* THE ONE STATE THAT OWES NO APPLICATION PROOF, AND IT IS NARROWER THAN THE SKIP WAS WRITTEN.
 *
 * A code wall that was ALREADY STANDING when the page loaded produces no application submit pass,
 * because Stratus will not press the disabled application control from there, so asserting one
 * would fail every retained-wall run. Everything else does owe the proof, including the ordinary
 * way a Greenhouse wall appears: press Send, get refused, get asked for a code. Keying the skip on
 * the challenge alone excused that run too, so a runner that pressed with its required-field proof
 * blocked, malformed or absent walked past the only place this service checks it.
 */
test('only an already standing code wall is excused the application submit proof', () => {
  const standingWall = { digits: 8, sentTo: 'app@apply.trylitos.com' };
  assert.equal(managedApplicationProofIsRequired(standingWall, { pressed: false }), false,
    'no application pass exists on a wall Stratus refused to press through');
  assert.equal(managedApplicationProofIsRequired(standingWall, { pressed: true }), true,
    'a run that pressed Send and then met a code wall still has to prove what it pressed');
  assert.equal(managedApplicationProofIsRequired(null, { pressed: true }), true);
  assert.equal(managedApplicationProofIsRequired(null, { pressed: false }), true);
  // A runner too old to report submitOutcome says nothing about its own click, so it is not excused.
  assert.equal(managedApplicationProofIsRequired(standingWall, null), true);
  assert.equal(managedApplicationProofIsRequired(standingWall, {}), true);
});

test('the pressed half of the skip is what catches an unproven send at a code wall', () => {
  // End to end through the real assertion: the receipt below carries no proof at all, which is the
  // exact shape an older or misbehaving runner returns, and the guard has to reach it.
  const unproven = { requiredFieldConfirmation: undefined } as Record<string, unknown>;
  const standingWall = { digits: 8, sentTo: 'app@apply.trylitos.com' };
  const check = (challenge: unknown, pressed: boolean) => {
    if (!managedApplicationProofIsRequired(challenge, { pressed })) return 'skipped';
    try {
      assertManagedRequiredFieldsConfirmed(unproven, 'application');
      return 'passed';
    } catch {
      return 'caught';
    }
  };
  assert.equal(check(standingWall, true), 'caught', 'the regression let this one through');
  assert.equal(check(null, true), 'caught');
  assert.equal(check(standingWall, false), 'skipped');
});

test('a replaced submit node cannot satisfy the atomic scope proof', () => {
  const replaced = proof([]) as { requiredFieldConfirmation: Record<string, unknown> };
  const replacedPass = (replaced.requiredFieldConfirmation.passes as Array<Record<string, unknown>>)[0]!;
  replacedPass.scope = { ...(replacedPass.scope as Record<string, unknown>), sameNode: false };
  replacedPass.submissionOutcome = 'blocked';
  replacedPass.blockerReason = 'submit_node_replaced';
  replaced.requiredFieldConfirmation.status = 'blocked';
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed(replaced),
    (error: unknown) => error instanceof ManagedRequiredFieldConfirmationError
      && error.fields.includes('submit_node_replaced'),
  );
});

test('direct confirmation commits the visually filled custom box without changing its answer', async () => {
  let committed = false;
  let focused = false;
  const control = {
    disabled: false,
    value: 'Yes',
    getAttribute: (name: string) => name === 'role' ? 'radio' : name === 'aria-checked' ? 'true' : null,
    getClientRects: () => ({ length: 1 }),
    focus: () => { focused = true; },
    blur: () => undefined,
    dispatchEvent: (event: unknown) => {
      if ((event as { type?: string }).type === 'click') committed = true;
      return true;
    },
  };
  const form = { setAttribute: () => undefined, querySelectorAll: () => [control] };
  const result = await COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT({
    closest: () => form,
    ownerDocument: { defaultView: {
      Event,
      requestAnimationFrame: (callback: () => void) => callback(),
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    } },
  });
  assert.deepEqual(result, { formFound: true, changed: false, committed: 1 });
  assert.equal(focused, true);
  assert.equal(committed, true, 'the exact selected box must receive its commit click');
  assert.equal(control.getAttribute('aria-checked'), 'true', 'confirmation must preserve the answer');
});

async function commitMarkerOnlyRequiredControl(marker: { textContent: string; className: string }) {
  let events = 0;
  const control = {
    disabled: false,
    value: 'Yes',
    getAttribute: (name: string) => name === 'role' ? 'radio' : name === 'aria-checked' ? 'true' : null,
    getClientRects: () => ({ length: 1 }),
    focus: () => undefined,
    blur: () => undefined,
    dispatchEvent: () => { events += 1; return true; },
  };
  const markerNode = {
    ...marker,
    control: null,
    parentElement: { querySelector: () => control },
    getAttribute: () => null,
    querySelector: () => null,
    closest: () => ({ querySelector: () => control }),
  };
  const form = {
    setAttribute: () => undefined,
    querySelectorAll: (selector: string) => selector.startsWith('[required]') ? [] : [markerNode],
  };
  const result = await COMMIT_REQUIRED_CONTROLS_FOR_SUBMIT({
    closest: () => form,
    ownerDocument: {
      getElementById: () => null,
      defaultView: {
        Event,
        requestAnimationFrame: (callback: () => void) => callback(),
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      },
    },
  });
  return { result, events };
}

test('direct confirmation commits a Greenhouse literal-star custom question scoped to its form', async () => {
  const { result, events } = await commitMarkerOnlyRequiredControl({
    textContent: 'Are you authorized to work? *',
    className: 'question-label',
  });
  assert.deepEqual(result, { formFound: true, changed: false, committed: 1 });
  assert.equal(events, 1, 'the literal-star required control must receive its exact commit event');
});

test('direct confirmation commits an Ashby _required_ custom question scoped to its form', async () => {
  const { result, events } = await commitMarkerOnlyRequiredControl({
    textContent: 'Will you need sponsorship?',
    className: '_label_8x3 _required_8x3',
  });
  assert.deepEqual(result, { formFound: true, changed: false, committed: 1 });
  assert.equal(events, 1, 'the Ashby class-marked required control must receive its exact commit event');
});

test('prepare runs do not commit required fields or expose a submit action', () => {
  const actions = buildManagedPortalActions('greenhouse', packet, false);
  assert.equal(actions.some((action) => action.type === 'confirmAndSubmit'), false);
  assert.equal(actions.some((action) => action.type === 'click' && action.selector?.includes('button[type="submit"]')), false);
});

test('confirmation proof covers text, date, native select, React select, radio, checkbox, file and custom controls', () => {
  const fieldTypes = ['text', 'date', 'select', 'react-select', 'radio', 'checkbox', 'file', 'custom'] as const;
  const attempts = fieldTypes.map((fieldType, index) => {
    const outcome: 'already_committed' | 'confirmed' = index === 0 ? 'already_committed' : 'confirmed';
    return {
      selector: `[data-litos-stable-id-v1="fixture-${index}"]`,
      label: `Required ${fieldType}`,
      fieldType,
      outcome,
      ...(fieldType === 'react-select' ? { attemptCount: 2 as const } : {}),
    };
  });
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(proof(attempts, { retries: 1 })));
});

test('email, phone, number and textarea normalize to text while a required resume remains file', () => {
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(proof([
    { selector: 'input[name="email"]', label: 'Email', fieldType: 'text', outcome: 'confirmed' },
    { selector: 'input[name="phone"]', label: 'Phone', fieldType: 'text', outcome: 'confirmed' },
    { selector: 'input[name="years_experience"]', label: 'Years experience', fieldType: 'text', outcome: 'confirmed' },
    { selector: 'textarea[name="statement"]', label: 'Statement', fieldType: 'text', outcome: 'confirmed' },
    { selector: 'input[name="resume"]', label: 'Resume', fieldType: 'file', outcome: 'already_committed' },
  ])));
});

test('Lever and Workable keep every fixed core field or block before confirmation and submit', () => {
  const expected: Record<'lever' | 'workable', string[]> = {
    lever: ['name', 'email', 'phone', 'resume'],
    workable: ['first_name', 'last_name', 'email', 'phone', 'resume'],
  };
  for (const family of ['lever', 'workable'] as const) {
    let blocked = 0;
    for (let count = 1; count <= 140; count += 7) {
      const crowded: SubmissionPacket = {
        ...packet,
        questions: Array.from({ length: count }, (_, index) => ({
          question: `Required screener ${index}`,
          answer: `Reviewed answer ${index}`,
        })),
      };
      try {
        const actions = buildManagedPortalActions(family, crowded, true);
        const labels = new Set(actions.map((action) => action.label));
        for (const label of expected[family]) assert.ok(labels.has(label), `${family} lost ${label} at ${count}`);
        assert.equal(actions.at(-1)?.type, 'confirmAndSubmit');
      } catch (error) {
        assert.ok(error instanceof ManagedActionBudgetError, `${family} threw the wrong error at ${count}`);
        assert.equal(error.submitActionAppended, false);
        blocked += 1;
      }
    }
    assert.ok(blocked > 0, `${family} never exercised its fail-closed budget path`);
  }
});

test('missing protocol proof fails closed for an older managed runner, as uncertainty and never as a no-send', () => {
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed({}),
    (error: unknown) => error instanceof ManagedConfirmationUnprovenError
      && /returned none/.test((error as Error).message)
      && /whether submit was pressed is unknown/.test((error as Error).message),
  );
  /* The winning half of the adversary: the action list this result answers carried a final submit,
     so an older runner may have pressed it. A NoSubmitControlError here classifies pre-click,
     releases the claim and tells the applicant nothing was sent. */
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed({}),
    (error: unknown) => !(error instanceof NoSubmitControlError),
  );
});

/* THE PROOF THE DEPLOYED RUNNER ACTUALLY EMITS, captured verbatim rather than reconstructed.
 *
 * Provenance: SANDBOX_RUNNER extracted from stratus-browser-cloud main 4748871 on 2026-08-12 and
 * driven in real Chromium against served fixtures of the two scope shapes - the formless Ashby
 * page (kos.ai's shape, container scope) and a plain Greenhouse form (form scope). In both runs
 * the runner PRESSED SUBMIT and the page recorded the submission before this object was written.
 *
 * On 2026-08-11 production rejected exactly these objects at 'scope proof', because `scopeKind`
 * (added by the runner's submit-scope repair) was an unknown key to the key-set check below, and
 * the rejection was classed as a pre-click stop: the kos.ai row read "nothing has been sent" for a
 * run whose runner had clicked. A reconstruction of this fixture is how that defect shipped, so
 * these two objects must stay byte-shaped as captured. */
const RUNNER_CONTAINER_SCOPE_PROOF = {
  requiredFieldConfirmation: {
    version: 2 as const,
    status: 'confirmed' as const,
    passes: [{
      submitKind: 'application' as const,
      scope: {
        scopeKind: 'container' as const,
        formFingerprint: '8aa80dbd8033841edd98e62edd5bdbbaa4ebec6312a990fffe202726db3c3f47',
        submitFingerprint: '11084192c4838849708ee767588c5f4cceaded9ec0a250686f0bca352cb5123b',
        formMatchCount: 1 as const,
        submitMatchCount: 1 as const,
        requiredControlCount: 3,
        sameNode: true,
      },
      requiredControls: [
        { selector: '#name', label: 'Full name *', fieldType: 'text' as const, matchCount: 1 as const },
        { selector: '#email', label: 'Email *', fieldType: 'text' as const, matchCount: 1 as const },
        { selector: '#resume', label: 'Resume *', fieldType: 'file' as const, matchCount: 1 as const },
      ],
      attempts: [
        { selector: '#name', label: 'Full name *', fieldType: 'text' as const, outcome: 'already_committed' as const, attemptCount: 1 as const },
        { selector: '#email', label: 'Email *', fieldType: 'text' as const, outcome: 'already_committed' as const, attemptCount: 1 as const },
        { selector: '#resume', label: 'Resume *', fieldType: 'file' as const, outcome: 'already_committed' as const, attemptCount: 1 as const },
      ],
      retries: 0,
      unresolved: [],
      submissionOutcome: 'clicked' as const,
    }],
  },
};

test('the deployed runner\'s container-scope proof is accepted exactly as emitted', () => {
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(RUNNER_CONTAINER_SCOPE_PROOF, 'application'));
});

test('the deployed runner\'s form-scope proof shape is accepted, scope captured verbatim', () => {
  const formScope = JSON.parse(JSON.stringify(RUNNER_CONTAINER_SCOPE_PROOF)) as typeof RUNNER_CONTAINER_SCOPE_PROOF;
  const pass = formScope.requiredFieldConfirmation.passes[0]! as { scope: Record<string, unknown> };
  pass.scope = {
    ...pass.scope,
    scopeKind: 'form',
    formFingerprint: '4f37eea4efeef07e039d081e9d8e19b6a240840329b4406c06f304d17677d6e3',
    submitFingerprint: '807d8541e4911e4c6aad82fd63b786d4a8fc174261e8a33044a062977360f641',
  };
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(formScope, 'application'));
});

test('scopeKind admits only the two scopes the runner can bind, and any other new scope key still fails closed', () => {
  const withScope = (patch: Record<string, unknown>) => {
    const copy = JSON.parse(JSON.stringify(RUNNER_CONTAINER_SCOPE_PROOF)) as { requiredFieldConfirmation: { passes: Array<{ scope: Record<string, unknown> }> } };
    copy.requiredFieldConfirmation.passes[0]!.scope = { ...copy.requiredFieldConfirmation.passes[0]!.scope, ...patch };
    return copy;
  };
  assert.throws(() => assertManagedRequiredFieldsConfirmed(withScope({ scopeKind: 'body' })), /scope kind/);
  assert.throws(() => assertManagedRequiredFieldsConfirmed(withScope({ scopeKind: 1 })), /scope kind/);
  assert.throws(() => assertManagedRequiredFieldsConfirmed(withScope({ futureScopeEvidence: true })), /scope proof/);
});

test('a proof this service cannot read is classified as unproven, never as a pre-click stop', () => {
  /* The adversary that won in production: the runner clicked, the page recorded the submission,
     and the proof shape was rejected. If this error is a NoSubmitControlError the row releases the
     claim and reads "nothing has been sent" - for an application the employer may be holding. */
  const rejected = (value: unknown) => {
    try {
      assertManagedRequiredFieldsConfirmed(value, 'application');
      return null;
    } catch (error) {
      return error;
    }
  };
  const unknownScopeKey = (() => {
    const copy = JSON.parse(JSON.stringify(RUNNER_CONTAINER_SCOPE_PROOF)) as { requiredFieldConfirmation: { passes: Array<{ scope: Record<string, unknown> }> } };
    copy.requiredFieldConfirmation.passes[0]!.scope.futureScopeEvidence = true;
    return copy;
  })();
  for (const malformed of [
    unknownScopeKey,
    { requiredFieldConfirmation: { version: 2, status: 'confirmed', passes: [{ bogus: true }] } },
    { requiredFieldConfirmation: { version: 3, status: 'confirmed', passes: [] } },
    {},
  ]) {
    const error = rejected(malformed);
    assert.ok(error instanceof ManagedConfirmationUnprovenError, 'the unreadable proof must be unproven');
    assert.ok(!(error instanceof NoSubmitControlError), 'an unreadable proof must never classify as a pre-click stop');
    assert.ok(!(error instanceof ManagedRequiredFieldConfirmationError), 'unreadable and runner-blocked are opposite claims');
  }
  /* And the opposite stays the opposite: a proof that VALIDATES and says the runner blocked is the
     runner's own pre-click statement, and keeps its release classification. */
  const blocked = rejected(proof([{
    selector: '[data-field-path="work-authorization"]',
    label: 'Are you authorized to work?',
    fieldType: 'radio',
    outcome: 'failed',
    attemptCount: 2,
    reason: 'This requires an answer',
  }], {
    status: 'blocked',
    submissionOutcome: 'blocked',
    retries: 1,
    unresolved: ['Are you authorized to work?'],
  }));
  assert.ok(blocked instanceof ManagedRequiredFieldConfirmationError);
  assert.ok(blocked instanceof NoSubmitControlError, 'a validated blocked proof is a proven pre-click stop');
});

test('a visually filled field that still fails ATS validation blocks submission by name', () => {
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed(proof([{
      selector: '[data-field-path="work-authorization"]',
      label: 'Are you authorized to work?',
      fieldType: 'radio',
      outcome: 'failed',
      attemptCount: 2,
      reason: 'This requires an answer',
    }], {
      status: 'blocked',
      submissionOutcome: 'blocked',
      retries: 1,
      unresolved: ['Are you authorized to work?'],
    })),
    (error: unknown) => error instanceof ManagedRequiredFieldConfirmationError
      && error.fields.includes('Are you authorized to work?'),
  );
});

test('confirmation rejects coordinate-like or selectorless evidence', () => {
  for (const selector of [
    '   ', '412, 980', 'x=412,y=980', '/html/body/form/input[1]', 'form input:nth-child(2)',
    'input[type="text"]', '[role="radio"]', '[aria-required="true"]', 'input[autocomplete="email"]',
    'label[for="start"]', '[data-testid="start"]', '.required-field', 'input[name="first"], input[name="last"]',
  ]) {
    assert.throws(() => assertManagedRequiredFieldsConfirmed(proof([{
      selector,
      label: 'Start date',
      fieldType: 'date',
      outcome: 'confirmed',
    }])), selector);
  }
});

test('Greenhouse bracket ids use a unique versioned stable id instead of a brittle escaped selector', () => {
  assert.throws(() => assertManagedRequiredFieldsConfirmed(proof([{
    selector: '#question_68005616\\[\\]_73190027',
    label: 'Work authorization',
    fieldType: 'react-select',
    outcome: 'confirmed',
  }])));
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(proof([{
    selector: '[data-litos-stable-id-v1="required-73190027"]',
    label: 'Work authorization',
    fieldType: 'react-select',
    outcome: 'confirmed',
  }])));
});

test('untyped hostile receipts cannot bypass the strict versioned confirmation schema', () => {
  const good = proof([{
    selector: 'input[name="start_date"]',
    label: 'Start date',
    fieldType: 'date',
    outcome: 'confirmed',
  }]);
  const raw = JSON.parse(JSON.stringify(good)) as Record<string, unknown>;
  const base = (raw.requiredFieldConfirmation as Record<string, unknown>);
  const basePass = (base.passes as Array<Record<string, unknown>>)[0]!;
  const withPass = (patch: Record<string, unknown>) => ({ ...base, passes: [{ ...basePass, ...patch }] });
  const cases: Array<[string, unknown]> = [
    ['wrong version', { ...base, version: 1 }],
    ['fractional retries', withPass({ retries: 0.5 })],
    ['excess retries', withPass({ retries: 2 })],
    ['unknown field type', withPass({ requiredControls: [{ selector: '#start', label: 'Start', fieldType: 'slider' }] })],
    ['unknown outcome', withPass({ attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'clicked', attemptCount: 1 }] })],
    ['missing requiredControls', { ...base, passes: [Object.fromEntries(Object.entries(basePass).filter(([key]) => key !== 'requiredControls'))] }],
    ['missing uniqueness proof', withPass({ requiredControls: [{ selector: '#start', label: 'Start', fieldType: 'date' }] })],
    ['nonunique control', withPass({ requiredControls: [{ selector: '#start', label: 'Start', fieldType: 'date', matchCount: 2 }] })],
    ['empty attempts with a discovered control', withPass({ attempts: [] })],
    ['duplicate attempts', withPass({ attempts: [...(basePass.attempts as unknown[]), ...(basePass.attempts as unknown[])] })],
    ['extra attempt', withPass({ attempts: [...(basePass.attempts as unknown[]), { selector: '#other', label: 'Other', fieldType: 'text', outcome: 'confirmed' }] })],
    ['coordinate control', withPass({ requiredControls: [{ selector: '20, 30', label: 'Start date', fieldType: 'date' }] })],
    ['failed without reason', { ...withPass({ attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'failed', attemptCount: 2 }], retries: 1, unresolved: ['Start date'], submissionOutcome: 'blocked' }), status: 'blocked' }],
    ['retry count without retry evidence', withPass({ retries: 1 })],
    ['retry evidence without retry count', withPass({ attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'confirmed', attemptCount: 2 }] })],
    ['already committed was retried', withPass({ attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'already_committed', attemptCount: 2 }], retries: 1 })],
    ['confirmed with unresolved', withPass({ unresolved: ['Start date'] })],
    ['blocked without failure', { ...base, status: 'blocked' }],
    ['unknown receipt property', { ...base, clicked: true }],
  ];
  for (const [name, requiredFieldConfirmation] of cases) {
    assert.throws(() => assertManagedRequiredFieldsConfirmed({ requiredFieldConfirmation }), name);
  }
});

test('managed wire contract sends one bounded confirmation action with its durable form scope', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  let body: { actions?: Array<Record<string, unknown>> } = {};
  globalThis.fetch = (async (_input, init) => {
    body = JSON.parse(String(init?.body)) as typeof body;
    return new Response(JSON.stringify({
      run: {
        title: 'Complete',
        url: 'https://portal.example/complete',
        text: 'Thank you',
        requiredFieldConfirmation: {
          version: 2,
          status: 'confirmed',
          passes: [{
            submitKind: 'application',
            scope: {
              formFingerprint: 'form_fingerprint_wire_fixture',
              submitFingerprint: 'submit_fingerprint_wire_fixture',
              formMatchCount: 1,
              submitMatchCount: 1,
              requiredControlCount: 2,
              sameNode: true,
            },
            requiredControls: [
              { selector: 'input[name="full_name"]', label: 'Full name', fieldType: 'text', matchCount: 1 },
              { selector: '[data-field-path="availability"]', label: 'Availability', fieldType: 'custom', matchCount: 1 },
            ],
            attempts: [
              { selector: 'input[name="full_name"]', label: 'Full name', fieldType: 'text', outcome: 'already_committed', attemptCount: 1 },
              { selector: '[data-field-path="availability"]', label: 'Availability', fieldType: 'custom', outcome: 'confirmed', attemptCount: 2 },
            ],
            retries: 1,
            unresolved: [],
            submissionOutcome: 'clicked',
          }],
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      label: 'required_field_confirmation',
      optional: false,
      maxRetries: 1,
      contractVersion: 2,
      submitKind: 'application',
      chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY,
    }], { allowSubmit: true });
    assert.deepEqual(body.actions, [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      label: 'required_field_confirmation',
      optional: false,
      maxRetries: 1,
      contractVersion: 2,
      submitKind: 'application',
      chooserPolicy: MANAGED_SUBMIT_CHOOSER_POLICY,
    }]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('managed wire contract rejects missing versions and unbounded retry counts before network use', async () => {
  const previousKey = process.env.STRATUS_API_KEY;
  const previousUrl = process.env.STRATUS_BASE_URL;
  const previousFetch = globalThis.fetch;
  process.env.STRATUS_API_KEY = 'private-key';
  process.env.STRATUS_BASE_URL = 'https://stratus.example';
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    throw new Error('network should be unreachable');
  }) as typeof fetch;
  try {
    await assert.rejects(() => runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      maxRetries: 1,
    }]), /contract version/);
    await assert.rejects(() => runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      contractVersion: 2,
      maxRetries: 2,
    }]), /maxRetries/);
    await assert.rejects(() => runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      contractVersion: 2,
      maxRetries: 1,
      submitKind: 'application',
    }]), /chooser policy/);
    await assert.rejects(() => runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmAndSubmit',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      contractVersion: 2,
      maxRetries: 1,
      submitKind: 'application',
      chooserPolicy: { name: 'litos-final-submit', version: 2 } as never,
    }]), /chooser policy/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.STRATUS_API_KEY;
    else process.env.STRATUS_API_KEY = previousKey;
    if (previousUrl === undefined) delete process.env.STRATUS_BASE_URL;
    else process.env.STRATUS_BASE_URL = previousUrl;
  }
});

test('submission runner requires confirmation proof before any receipt can be recorded', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  /* The first managed run is ALWAYS an application submit, including on a run that is finishing a
     security-code challenge. It used to be declared 'verification' whenever a code was in hand, and
     that declaration was the shape of the defect: a verification submit types the code before it
     clicks, and on a page that has not been submitted yet there is no code control to type into. */
  const barrier = source.indexOf("assertManagedRequiredFieldsConfirmed(result, 'application')");
  const receipt = source.indexOf("const receipt = verdict.kind === 'confirmed'", barrier);
  assert.ok(barrier >= 0);
  assert.ok(receipt > barrier);
});

/* THE SUPPLIED-CODE CONTINUATION IS GONE, AND THAT IS THE FIX RATHER THAN A REGRESSION.
 *
 * It typed a code the applicant had pasted in, on a page reached by sending the application again.
 * Greenhouse issues a new code on every send and invalidates the last - three codes to one mailbox
 * on a live Cresta application on 2026-08-09, at 20:24:03, 21:13:07 and 21:13:53 - so the code being
 * typed was always one generation stale and the branch could never have succeeded. There is now one
 * continuation, and the code it carries was read inside the same run that raised the challenge.
 */
test('no continuation may carry a code that came from outside the run', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  assert.equal((source.match(/continueManagedBrowser\(continuationToken, codeActions\)/g) ?? []).length, 1,
    'one held verification session, one code answer: a second code call site would mean a second submit');
  assert.equal((source.match(/continueManagedBrowser\(continuationToken, \[\], \{ screenshot: true \}\)/g) ?? []).length, 1,
    'the only other continuation is a read-only receipt observation with no actions');
  // The supplied code survives in exactly one place, and it is not an action list.
  const branch = source.indexOf('if (options.securityCode && initialChallenge) {');
  assert.ok(branch > 0, 'the supplied code is still fingerprinted, so the same dead code cannot resend');
  const body = source.slice(branch, source.indexOf('let enteredCode', branch));
  assert.match(body, /outcome: 'superseded'/);
  assert.doesNotMatch(body, /continueManagedBrowser|securityCodeContinuationActions|withSecurityCode\(/);
});

test('automatic security-code continuation validates its own atomic confirmation receipt', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const continuation = source.indexOf('receiptResult = await continueManagedBrowser(continuationToken, codeActions)');
  const continuationBarrier = source.indexOf("assertManagedRequiredFieldsConfirmed(receiptResult, 'verification')", continuation);
  const receipt = source.indexOf("const receipt = verdict.kind === 'confirmed'", continuation);
  assert.ok(continuation >= 0);
  assert.ok(continuationBarrier > continuation);
  assert.ok(receipt > continuationBarrier);
});

/* THE UNRESOLVED VOCABULARY, MEASURED AGAINST WHAT THE RUNNER ACTUALLY PUSHES.
 *
 * `pass.unresolved` used to be required to contain only selectors and labels of controls in
 * requiredControls, on pain of the whole proof being malformed. Five of the runner's eight push
 * sites emit strings that set can never contain, and the commonest of them,
 * stratus-browser-cloud@4748871 managed-browser.js:2928, fires on ANY still-empty required field.
 * So the ordinary blocked submission was unreadable, and the fixtures in this file never caught it
 * because they only ever used bare labels.
 *
 * The cost of that rejection changed in PR 506. A shape refusal now means "the click state is
 * unknown", which applied to a run that reported withholding the click produced a row saying Litos
 * pressed Send, carrying submission_attempted_at and an unresolved unverified_submission, with the
 * claim kept. See the row-level tests in routes/submissionStopExit.test.ts.
 *
 * Every string below is copied from the runner's source, not invented.
 */
const RUNNER_UNRESOLVED_STRINGS = {
  readiness: '"Start date" is required and is still empty',
  noLabel: 'A required field on the form has no label Litos can read, and is still empty',
  scanFailed: 'Required-field readiness scan failed',
  selectorless: 'Selectorless required field',
  nodeReplaced: 'Bound submit control or application form was replaced before submission',
  identityChanged: 'Bound application form or submit identity changed during confirmation',
  employerText: 'The bound application form still shows an unmatched validation error: '
    + 'Please complete this required field before continuing with your application. ',
} as const;

/** One required control left blank, the runner withheld the click. The ordinary blocked run. */
function blockedRun(unresolved: string[]) {
  return {
    submitOutcome: {
      pressed: false, state: 'not_attempted', source: null, evidence: null, message: null, formStillPresent: true,
    },
    requiredFieldConfirmation: {
      version: 2,
      status: 'blocked',
      passes: [{
        submitKind: 'application',
        scope: {
          scopeKind: 'form',
          formFingerprint: 'form_fingerprint_fixture_1234',
          submitFingerprint: 'submit_fingerprint_fixture_1234',
          formMatchCount: 1,
          submitMatchCount: 1,
          requiredControlCount: 1,
          sameNode: true,
        },
        requiredControls: [{
          selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'text', matchCount: 1,
        }],
        attempts: [{
          selector: 'input[name="start_date"]',
          label: 'Start date',
          fieldType: 'text',
          outcome: 'failed',
          attemptCount: 2,
          reason: 'This requires an answer',
        }],
        retries: 1,
        unresolved,
        submissionOutcome: 'blocked',
      }],
    },
  };
}

function refusalFrom(result: unknown): Error {
  try {
    assertManagedRequiredFieldsConfirmed(result, 'application');
  } catch (error) {
    return error as Error;
  }
  return assert.fail('a blocked proof must never be accepted');
}

test('every sentence the deployed runner puts in unresolved keeps the proof readable', () => {
  for (const [name, sentence] of Object.entries(RUNNER_UNRESOLVED_STRINGS)) {
    const error = refusalFrom(blockedRun([sentence]));
    assert.ok(
      error instanceof ManagedRequiredFieldConfirmationError,
      `${name} produced ${error.name}: a blocked run must refuse as a blocked run, not as an unreadable proof`,
    );
    assert.doesNotMatch(
      error.message,
      /could not read the send run/,
      `${name} must not be reported as an unreadable proof`,
    );
  }
});

test('a readiness blocker surfaces the field it names, and only when this proof enumerated it', () => {
  /* The useful half of managed-browser.js:2126 is the quoted label. It is kept only when it matches
     a control this proof already listed, so what reaches the applicant is a label this service saw
     independently rather than any text the employer's page supplied. */
  const named = refusalFrom(blockedRun([RUNNER_UNRESOLVED_STRINGS.readiness]));
  assert.ok(named instanceof ManagedRequiredFieldConfirmationError, 'a blocked run refuses as a blocked run');
  assert.deepEqual(named.fields, ['Start date']);

  /* Identical to the row a bare label produces. That equality is the point: the runner's wording is
     no longer able to change what this service does. */
  const bare = refusalFrom(blockedRun(['Start date']));
  assert.ok(bare instanceof ManagedRequiredFieldConfirmationError, 'a bare label refuses the same way');
  assert.deepEqual(named.fields, bare.fields);

  const unknownField = refusalFrom(blockedRun(['"Salary expectation" is required and is still empty']));
  assert.ok(unknownField instanceof ManagedRequiredFieldConfirmationError, 'an unknown label still blocks');
  assert.ok(
    !unknownField.fields.includes('Salary expectation'),
    'a label this proof never enumerated is not evidence and must not be quoted back',
  );
  assert.deepEqual(unknownField.fields, [UNATTRIBUTED_REQUIRED_BLOCKER, 'Start date']);
});

test('employer-authored text never reaches the applicant, and still blocks the send', () => {
  /* managed-browser.js:2929 wraps text scraped from the employer's own page. That is the reason the
     old rule was strict, and the property is kept: the entry blocks, its text is not repeated. */
  const error = refusalFrom(blockedRun([RUNNER_UNRESOLVED_STRINGS.employerText]));
  assert.ok(error instanceof ManagedRequiredFieldConfirmationError, 'employer text must not make the proof unreadable');
  assert.ok(!error.message.includes('Please complete this required field'), 'employer text must not reach the message');
  assert.ok(error.fields.includes(UNATTRIBUTED_REQUIRED_BLOCKER), 'the entry must still count as a blocker');
  assert.ok(error.fields.every((field) => !field.includes('Please complete this required field')), 'employer text must not reach the fields');
});

test('a sentence no runner has ever emitted still blocks rather than passing through', () => {
  /* Fail-closed on the axis that matters. An entry this service cannot attribute is still a
     failure, so a future runner cannot turn a blocked pass into a confirmed one by rewording. */
  const error = refusalFrom(blockedRun(['Some wording nobody has written yet']));
  assert.ok(error instanceof ManagedRequiredFieldConfirmationError, 'an unrecognised sentence must not make the proof unreadable');
  assert.ok(error.fields.includes(UNATTRIBUTED_REQUIRED_BLOCKER), 'and it must still block the send');

  /* And it cannot be laundered into a CONFIRMED proof either: status 'confirmed' with any
     unresolved entry is still a contradiction. */
  const laundered = blockedRun(['Some wording nobody has written yet']);
  laundered.requiredFieldConfirmation.status = 'confirmed';
  assert.throws(() => assertManagedRequiredFieldsConfirmed(laundered, 'application'));
});

test('an unreadable proof on a run that withheld the click is not reported as a possible send', () => {
  /* The safety net under the vocabulary fix, for shape drift nobody has predicted yet. Two
     independent statements have to agree that the click was withheld: submitOutcome.pressed false,
     and every pass reporting 'blocked'. */
  const drifted = blockedRun(['Start date']);
  (drifted.requiredFieldConfirmation.passes[0]!.scope as Record<string, unknown>).somethingNew = true;
  const error = refusalFrom(drifted);
  assert.ok(
    error instanceof ManagedRequiredFieldConfirmationError,
    'a run that reported withholding the click must not be recorded as an unproven press',
  );
  assert.match(error.message, /did not press submit/);

  /* The half that must not move: a run that reports a PRESS keeps PR 506's unproven classification,
     because there the uncertainty is real and a false "nothing was sent" costs a duplicate. */
  const pressed = blockedRun(['Start date']);
  pressed.submitOutcome.pressed = true;
  (pressed.requiredFieldConfirmation.passes[0]!.scope as Record<string, unknown>).somethingNew = true;
  assert.ok(
    refusalFrom(pressed) instanceof ManagedConfirmationUnprovenError,
    'a press with an unreadable proof is still an unknown outcome',
  );

  /* And a runner that reports nothing at all about the press stays unknown too. */
  const silent = blockedRun(['Start date']) as Record<string, unknown>;
  delete silent.submitOutcome;
  ((silent.requiredFieldConfirmation as { passes: Array<{ scope: Record<string, unknown> }> })
    .passes[0]!.scope).somethingNew = true;
  assert.ok(refusalFrom(silent) instanceof ManagedConfirmationUnprovenError, 'a runner silent about the press stays unknown');
});
