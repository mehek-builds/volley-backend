import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import {
  AUTONOMOUS_PORTAL_FAMILIES,
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  canonicalSupportedPortalUrl,
  clickFinalSubmit,
  CRELATE_FINAL_SUBMIT_SELECTOR,
  detectPortal,
  fillPortal,
  isAutonomousPortalFamily,
  portalApplicationUrl,
  portalCanAutoSubmit,
  readManagedReceipt,
  readReceipt,
  SUBMIT_CANDIDATE_SELECTOR,
} from './portalSubmission';

const JOB_CODE = 'rz89zks8z4rxa3rksi7ftm4h1y';
const POSTING = `https://jobs.crelate.com/portal/canonrecruiting/job/${JOB_CODE}`;
const APPLICATION = `https://jobs.crelate.com/portal/canonrecruiting/job/apply/${JOB_CODE}`;

const packet = {
  fullName: 'Taylor Morgan Example',
  email: 'taylor@example.com',
  phone: '+971500000000',
  resume: Buffer.from('%PDF resume'),
  resumeName: 'resume.pdf',
  questions: [],
};

test('Crelate detection accepts only exact first-party posting and application routes', () => {
  for (const url of [
    POSTING,
    `${POSTING}/`,
    `${POSTING}/software-engineer`,
    APPLICATION,
    `${APPLICATION}/`,
    `https://jobs.crelate.com/portal/HRMC/job/${JOB_CODE}/VP-CTO`,
  ]) assert.equal(detectPortal(url), 'crelate', url);

  for (const url of [
    'http://jobs.crelate.com/portal/canonrecruiting/job/rz89zks8z4rxa3rksi7ftm4h1y',
    `https://www.crelate.com/portal/canonrecruiting/job/${JOB_CODE}`,
    `https://api.crelate.com/portal/canonrecruiting/job/${JOB_CODE}`,
    `https://tenant.jobs.crelate.com/portal/canonrecruiting/job/${JOB_CODE}`,
    'https://jobs.crelate.com/portal/canonrecruiting',
    'https://jobs.crelate.com/portal/canonrecruiting/Apply',
    'https://jobs.crelate.com/portal/canonrecruiting/job/apply/general',
    `https://jobs.crelate.com/portal/canonrecruiting/job/${JOB_CODE.slice(1)}`,
    `https://jobs.crelate.com/portal/canonrecruiting/job/${JOB_CODE}/one/two`,
    `https://jobs.crelate.com/portal/canonrecruiting/job/apply/${JOB_CODE}/software-engineer`,
    `https://jobs.crelate.com/portal/canonrecruiting/job/applythanks/${JOB_CODE}?applicationId=app_12345678`,
    `${POSTING}?utm_source=test`,
    `${POSTING}#apply`,
  ]) assert.throws(() => detectPortal(url), url);
});

test('Crelate posting URLs canonicalize to the exact application route', () => {
  assert.equal(portalApplicationUrl('crelate', POSTING), APPLICATION);
  assert.equal(portalApplicationUrl('crelate', `${POSTING}/software-engineer`), APPLICATION);
  assert.equal(portalApplicationUrl('crelate', `${APPLICATION}/`), APPLICATION);
  assert.equal(canonicalSupportedPortalUrl(POSTING), APPLICATION);
  assert.equal(canonicalSupportedPortalUrl(`${POSTING}/software-engineer`), APPLICATION);
  assert.equal(canonicalSupportedPortalUrl(`${POSTING}?utm_source=test`), undefined);
});

test('Crelate is statically autonomous and its managed plan uses only captured core controls', () => {
  assert.equal(portalCanAutoSubmit('crelate'), true);
  assert.equal(isAutonomousPortalFamily('crelate'), true);
  assert.ok((AUTONOMOUS_PORTAL_FAMILIES as readonly string[]).includes('crelate'));

  const consentSelector = 'input#candidatePrivacyConsent[name="candidatePrivacyConsent"]';
  const actions = buildManagedPortalActions('crelate', {
    ...packet,
    questions: [{
      question: 'I agree to the privacy policy and consent to processing my personal data.',
      answer: 'Yes',
      portalSelector: consentSelector,
      portalInputType: 'checkbox',
    }],
  }, true, APPLICATION);

  const expected = new Map([
    ['first_name', 'input#firstName[name="firstName"]'],
    ['last_name', 'input#lastName[name="lastName"]'],
    ['email', 'input#email[name="email"]'],
    ['phone', 'input#phone[name="phone"]'],
    ['resume', 'input#file-uploadResume[name="file-uploadResume"][type="file"]'],
  ]);
  for (const [label, selector] of expected) {
    assert.ok(actions.some((action) => action.label === label && action.selector === selector), `${label}: ${selector}`);
  }

  const submits = actions.filter((action) => action.type === 'confirmAndSubmit');
  assert.equal(submits.length, 1);
  assert.equal(submits[0].selector, CRELATE_FINAL_SUBMIT_SELECTOR);
  assert.equal(submits[0].optional, false);
  assert.equal(actions.at(-1), submits[0]);

  const serialized = JSON.stringify(actions);
  assert.equal(serialized.includes(consentSelector), false);
  assert.doesNotMatch(serialized, /captcha-response|data-sitekey|honeypot/i);
  assert.equal(actions.some((action) => action.type === 'click'), false);

  const discovery = buildManagedDiscoveryActions('crelate', packet);
  assert.equal(discovery.some((action) => action.type === 'confirmAndSubmit'), false);
  assert.equal(discovery.some((action) => action.type === 'click'), false);
});

function directFillPage() {
  const values = new Map<string, string>();
  const uploads = new Map<string, string>();
  const present = new Set([
    'input#firstName[name="firstName"]',
    'input#lastName[name="lastName"]',
    'input#email[name="email"]',
    'input#phone[name="phone"]',
    'input#file-uploadResume[name="file-uploadResume"][type="file"]',
  ]);
  const locator = (selector: string): any => ({
    first: () => locator(selector),
    nth: () => locator(selector),
    count: async () => present.has(selector) ? 1 : 0,
    isVisible: async () => present.has(selector),
    fill: async (value: string) => { if (present.has(selector)) values.set(selector, value); },
    setInputFiles: async (file: { name?: string }) => {
      if (present.has(selector)) uploads.set(selector, file.name ?? '');
    },
    getAttribute: async (name: string) => name === 'type' && selector.includes('file-uploadResume') ? 'file' : null,
    inputValue: async () => values.get(selector) ?? '',
    isChecked: async () => false,
    locator: () => locator('missing-child'),
    evaluate: async () => false,
  });
  return {
    page: {
      locator,
      getByText: () => locator('missing-text'),
      getByLabel: () => locator('missing-label'),
    } as unknown as Page,
    values,
    uploads,
  };
}

test('the direct Crelate path fills the same five captured controls', async () => {
  const harness = directFillPage();
  const result = await fillPortal(harness.page, 'crelate', packet);
  assert.equal(harness.values.get('input#firstName[name="firstName"]'), 'Taylor');
  assert.equal(harness.values.get('input#lastName[name="lastName"]'), 'Morgan Example');
  assert.equal(harness.values.get('input#email[name="email"]'), packet.email);
  assert.equal(harness.values.get('input#phone[name="phone"]'), packet.phone);
  assert.equal(
    harness.uploads.get('input#file-uploadResume[name="file-uploadResume"][type="file"]'),
    'resume.pdf',
  );
  assert.deepEqual(result.filledFields.sort(), ['email', 'first_name', 'last_name', 'phone', 'resume'].sort());
  assert.deepEqual(result.blockers, []);
});

function exactSubmitPage() {
  const selectors: string[] = [];
  let clickCount = 0;
  const form = {
    setAttribute: () => undefined,
    querySelectorAll: () => [],
  };
  const node = {
    innerText: '',
    disabled: false,
    tagName: 'INPUT',
    type: 'button',
    value: 'SUBMIT APPLICATION',
    title: '',
    getAttribute: () => null,
    getClientRects: () => ({ length: 1 }),
    closest: (selector: string) => selector === 'form' ? form : null,
    parentElement: null,
    ownerDocument: {
      defaultView: {
        Event,
        requestAnimationFrame: (callback: () => void) => callback(),
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      },
      getElementById: () => null,
    },
  };
  const handle = {
    evaluate: async (fn: (target: unknown) => unknown) => await fn(node),
    click: async () => { clickCount += 1; },
    dispose: async () => undefined,
  };
  const empty = {
    count: async () => 0,
    nth: () => empty,
    first: () => empty,
    isVisible: async () => false,
    inputValue: async () => '',
  };
  const page = {
    url: () => APPLICATION,
    locator: (selector: string) => {
      selectors.push(selector);
      return selector === CRELATE_FINAL_SUBMIT_SELECTOR
        ? { elementHandles: async () => [handle] }
        : empty;
    },
    evaluate: async () => ({ blocking: [], stale: [] }),
    waitForNavigation: async () => undefined,
    waitForLoadState: async () => undefined,
    waitForTimeout: async () => undefined,
  } as unknown as Page;
  return { page, selectors, clicks: () => clickCount };
}

test('the direct final click binds only the exact Crelate submit control', async () => {
  const harness = exactSubmitPage();
  await clickFinalSubmit(harness.page);
  assert.equal(harness.clicks(), 1);
  assert.equal(harness.selectors[0], CRELATE_FINAL_SUBMIT_SELECTOR);
  assert.equal(harness.selectors.includes(SUBMIT_CANDIDATE_SELECTOR), false);
});

test('Crelate receipts require its exact thank-you route, application id, and receipt sentence', async () => {
  const receiptUrl = `https://jobs.crelate.com/portal/canonrecruiting/job/applythanks/${JOB_CODE}`
    + '?applicationId=4fb04402-35d9-4c75-9792-774ee7d536a4';
  const text = 'Thank you for applying to Software Engineer at Canon Recruiting.';
  assert.deepEqual(readManagedReceipt({ title: 'Thank you', url: receiptUrl, text }), {
    confirmationText: text,
    finalUrl: receiptUrl,
    referenceId: '4fb04402-35d9-4c75-9792-774ee7d536a4',
  });
  assert.equal(readManagedReceipt({
    title: 'Thank you',
    url: receiptUrl.replace('4fb04402-35d9-4c75-9792-774ee7d536a4', 'application_12345678'),
    text: 'Thank you for applying to this position.',
  }).referenceId, 'application_12345678');

  for (const fixture of [
    { url: APPLICATION, text },
    { url: receiptUrl.replace(/\?.*$/, ''), text },
    { url: `${receiptUrl}&source=test`, text },
    { url: receiptUrl, text: 'Thank you for visiting the Crelate portal.' },
  ]) assert.throws(() => readManagedReceipt({ title: 'Thank you', ...fixture }), /confirmation we could check/);

  const page = {
    url: () => receiptUrl,
    locator: (selector: string) => selector === 'body'
      ? { innerText: async () => text }
      : { first: () => ({ isVisible: async () => false }) },
  } as unknown as Page;
  assert.equal((await readReceipt(page)).referenceId, '4fb04402-35d9-4c75-9792-774ee7d536a4');
});
