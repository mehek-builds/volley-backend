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
  ManagedActionBudgetError,
  ManagedRequiredFieldConfirmationError,
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

test('missing protocol proof fails closed for an older managed runner', () => {
  assert.throws(
    () => assertManagedRequiredFieldsConfirmed({}),
    (error: unknown) => error instanceof ManagedRequiredFieldConfirmationError
      && /does not support required-field confirmation/.test(error.message),
  );
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
