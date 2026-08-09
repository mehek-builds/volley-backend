import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runManagedBrowser, type ManagedBrowserResult } from './browserbase';
import {
  assertManagedRequiredFieldsConfirmed,
  AUTONOMOUS_PORTAL_FAMILIES,
  buildManagedPortalActions,
  MANAGED_ACTION_LIMIT,
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
  attempts: NonNullable<ManagedBrowserResult['requiredFieldConfirmation']>['attempts'],
  overrides: Partial<NonNullable<ManagedBrowserResult['requiredFieldConfirmation']>> = {},
): Pick<ManagedBrowserResult, 'requiredFieldConfirmation'> {
  return {
    requiredFieldConfirmation: {
      status: 'confirmed',
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
      selector: 'form',
      label: 'required_field_confirmation',
      optional: false,
      timeout: 10_000,
      maxRetries: 1,
    });
    assert.equal(actions.at(-1)?.type, 'click');
  }
});

test('prepare runs do not commit required fields or expose a submit action', () => {
  const actions = buildManagedPortalActions('greenhouse', packet, false);
  assert.equal(actions.some((action) => action.type === 'confirmRequired'), false);
  assert.equal(actions.some((action) => action.type === 'click' && action.selector?.includes('button[type="submit"]')), false);
});

test('confirmation proof covers text, date, native select, React select, radio, checkbox and custom controls', () => {
  const fieldTypes = ['text', 'date', 'select', 'react-select', 'radio', 'checkbox', 'custom'] as const;
  assert.doesNotThrow(() => assertManagedRequiredFieldsConfirmed(proof(fieldTypes.map((fieldType, index) => ({
    selector: `[data-litos-field="${index}"]`,
    label: `Required ${fieldType}`,
    fieldType,
    outcome: index === 0 ? 'already_committed' : 'confirmed',
  })))));
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
  assert.throws(() => assertManagedRequiredFieldsConfirmed(proof([{
    selector: '   ',
    label: 'Start date',
    fieldType: 'date',
    outcome: 'confirmed',
  }])));
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
        requiredFieldConfirmation: { status: 'confirmed', attempts: [], retries: 0, unresolved: [] },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  try {
    await runManagedBrowser('https://portal.example/apply', [{
      type: 'confirmRequired',
      selector: 'form[data-application-form]',
      label: 'required_field_confirmation',
      optional: false,
      maxRetries: 99,
    }], { allowSubmit: true });
    assert.deepEqual(body.actions, [{
      type: 'confirmRequired',
      selector: 'form[data-application-form]',
      label: 'required_field_confirmation',
      optional: false,
      maxRetries: 1,
    }]);
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
