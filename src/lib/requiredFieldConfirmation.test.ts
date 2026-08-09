import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runManagedBrowser, type ManagedBrowserResult } from './browserbase';
import {
  assertManagedRequiredFieldsConfirmed,
  AUTONOMOUS_PORTAL_FAMILIES,
  buildManagedPortalActions,
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
  inputAttempts: Array<Omit<NonNullable<ManagedBrowserResult['requiredFieldConfirmation']>['attempts'][number], 'attemptCount'> & { attemptCount?: 1 | 2 }>,
  overrides: Partial<NonNullable<ManagedBrowserResult['requiredFieldConfirmation']>> = {},
): Pick<ManagedBrowserResult, 'requiredFieldConfirmation'> {
  const attempts = inputAttempts.map((attempt) => ({ attemptCount: 1 as const, ...attempt }));
  return {
    requiredFieldConfirmation: {
      version: 1,
      status: 'confirmed',
      requiredControls: attempts.map(({ selector, label, fieldType }) => ({ selector, label, fieldType, matchCount: 1 })),
      retries: 0,
      unresolved: [],
      attempts,
      ...overrides,
    },
  };
}

test('every autonomous managed submit reserves a mandatory confirmation barrier immediately before submit', () => {
  for (const family of AUTONOMOUS_PORTAL_FAMILIES) {
    const actions = buildManagedPortalActions(family as SupportedPortal, packet, true);
    assert.ok(actions.length <= MANAGED_ACTION_LIMIT, `${family} exceeded the managed action limit`);
    assert.deepEqual(actions.at(-2), {
      type: 'confirmRequired',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      label: 'required_field_confirmation',
      optional: false,
      timeout: 10_000,
      maxRetries: 1,
      contractVersion: 1,
    });
    assert.equal(actions.at(-1)?.type, 'click');
  }
});

test('confirmation is bound to the exact final-submit chooser instead of the first form on the page', () => {
  const actions = buildManagedPortalActions('lever', packet, true);
  const confirmation = actions.at(-2);
  const submit = actions.at(-1);
  assert.equal(confirmation?.type, 'confirmRequired');
  assert.equal(confirmation?.selector, MANAGED_FINAL_SUBMIT_SELECTOR);
  assert.equal(submit?.type, 'click');
  assert.equal(submit?.selector, confirmation?.selector);
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
    retries: 1,
    unresolved: ['Application email'],
  })));
});

test('prepare runs do not commit required fields or expose a submit action', () => {
  const actions = buildManagedPortalActions('greenhouse', packet, false);
  assert.equal(actions.some((action) => action.type === 'confirmRequired'), false);
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
        assert.equal(actions.at(-2)?.type, 'confirmRequired');
        assert.equal(actions.at(-1)?.type, 'click');
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
  const cases: Array<[string, unknown]> = [
    ['wrong version', { ...base, version: 2 }],
    ['fractional retries', { ...base, retries: 0.5 }],
    ['excess retries', { ...base, retries: 2 }],
    ['unknown field type', { ...base, requiredControls: [{ selector: '#start', label: 'Start', fieldType: 'slider' }] }],
    ['unknown outcome', { ...base, attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'clicked', attemptCount: 1 }] }],
    ['missing requiredControls', Object.fromEntries(Object.entries(base).filter(([key]) => key !== 'requiredControls'))],
    ['missing uniqueness proof', { ...base, requiredControls: [{ selector: '#start', label: 'Start', fieldType: 'date' }] }],
    ['nonunique control', { ...base, requiredControls: [{ selector: '#start', label: 'Start', fieldType: 'date', matchCount: 2 }] }],
    ['empty attempts with a discovered control', { ...base, attempts: [] }],
    ['duplicate attempts', { ...base, attempts: [...(base.attempts as unknown[]), ...(base.attempts as unknown[])] }],
    ['extra attempt', { ...base, attempts: [...(base.attempts as unknown[]), { selector: '#other', label: 'Other', fieldType: 'text', outcome: 'confirmed' }] }],
    ['coordinate control', { ...base, requiredControls: [{ selector: '20, 30', label: 'Start date', fieldType: 'date' }] }],
    ['failed without reason', { ...base, status: 'blocked', attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'failed', attemptCount: 2 }], retries: 1, unresolved: ['Start date'] }],
    ['retry count without retry evidence', { ...base, retries: 1 }],
    ['retry evidence without retry count', { ...base, attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'confirmed', attemptCount: 2 }] }],
    ['already committed was retried', { ...base, attempts: [{ selector: 'input[name="start_date"]', label: 'Start date', fieldType: 'date', outcome: 'already_committed', attemptCount: 2 }], retries: 1 }],
    ['confirmed with unresolved', { ...base, unresolved: ['Start date'] }],
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
          version: 1,
          status: 'confirmed',
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
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmRequired',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      label: 'required_field_confirmation',
      optional: false,
      maxRetries: 1,
      contractVersion: 1,
    }], { allowSubmit: true });
    assert.deepEqual(body.actions, [{
      type: 'confirmRequired',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      label: 'required_field_confirmation',
      optional: false,
      maxRetries: 1,
      contractVersion: 1,
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
      type: 'confirmRequired',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      maxRetries: 1,
    }]), /contract version/);
    await assert.rejects(() => runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmRequired',
      selector: MANAGED_FINAL_SUBMIT_SELECTOR,
      contractVersion: 1,
      maxRetries: 2,
    }]), /maxRetries/);
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
  const barrier = source.indexOf('assertManagedRequiredFieldsConfirmed(result)');
  const receipt = source.indexOf('const receipt = readManagedReceipt(receiptResult)', barrier);
  assert.ok(barrier >= 0);
  assert.ok(receipt > barrier);
});
