import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedPortalActions,
  canonicalSupportedPortalUrl,
  detectPortal,
  fillPortal,
  isAccountWalledFamily,
  managedPortalReceiptCapability,
  portalApplicationUrl,
  portalCanAutoSubmit,
  portalHandoffReason,
} from './portalSubmission';
import type { Page } from 'playwright-core';
import { POLLABLE_JOB_BOARDS } from './jobMonitor';

const packet = {
  fullName: 'Taylor Example',
  email: 'taylor@example.com',
  phone: '+971500000000',
  city: 'Dubai',
  linkedinUrl: 'https://www.linkedin.com/in/taylor',
  portfolioUrl: 'https://taylor.example',
  resume: Buffer.from('pdf'),
  resumeName: 'resume.pdf',
  questions: [],
};

const adversarialQuestions = [
  { question: 'Why this role?', answer: 'Benign answer', portalSelector: '#benign-text', portalInputType: 'text' },
  { question: 'I certify this application is accurate', answer: 'Yes', portalSelector: '#legal-certification', portalInputType: 'checkbox' },
  { question: 'Social Security Number', answer: '123-45-6789', portalSelector: '#sensitive-ssn', portalInputType: 'text' },
];

const smartRecruitersExactSelectors = {
  first_name: 'spl-input#first-name-input input',
  last_name: 'spl-input#last-name-input input',
  email: 'spl-input#email-input input',
  confirm_email: 'spl-input#confirm-email-input input',
  phone: 'spl-phone-field input[aria-label="Phone number"]',
  linkedin: 'spl-input#linkedin-input input',
  portfolio: 'spl-input#website-input input',
  resume: 'spl-dropzone[data-test="resume-upload"] input[type="file"]',
} as const;

test('detects the exact live SmartRecruiters, iCIMS, and Jobvite job routes', () => {
  const fixtures = [
    ['https://jobs.smartrecruiters.com/Lumina1/744000001027275-software-engineer', 'smartrecruiters'],
    ['https://jobs.smartrecruiters.com/BoschGroup/744000142166560-junior-managers-program', 'smartrecruiters'],
    ['https://jobs.smartrecruiters.com/oneclick-ui/company/Lumina1/publication/f137edd9-1f3b-448a-9a5f-2c2ca63fddeb?dcr_ci=Lumina1', 'smartrecruiters'],
    ['https://externalhourly-omnihotels.icims.com/jobs/133505/commis-%c3%a0-la-r%c3%a9ception/job', 'icims'],
    ['https://jobs-express.icims.com/jobs/48173/sales-associate/login', 'icims'],
    ['https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply', 'jobvite'],
    ['https://jobs.jobvite.com/genpactexperience/job/oZCwAfwr', 'jobvite'],
  ] as const;
  for (const [url, expected] of fixtures) assert.equal(detectPortal(url), expected, url);
});

test('rejects vendor, listing, API, malformed, and over-broad routes', () => {
  const rejected = [
    'https://api.smartrecruiters.com/v1/companies/Lumina1/postings',
    'https://www.smartrecruiters.com/resources',
    'https://jobs.smartrecruiters.com/Lumina1',
    'https://jobs.smartrecruiters.com/oneclick-ui/company/Lumina1/publication/not-a-uuid',
    'https://externalhourly-omnihotels.icims.com/jobs/search',
    'https://externalhourly-omnihotels.icims.com/jobs/intro',
    'https://login.icims.com/u/login/identifier',
    'https://community.icims.com/articles/help',
    'https://www.icims.com/jobs/1234/demo/job',
    'https://jobs.jobvite.com/worldfirst/jobs',
    'https://jobs.jobvite.com/careers/worldfirst/jobs',
    'https://www.jobvite.com/worldfirst/job/oknrAfws/apply',
    'https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply/extra',
  ];
  for (const url of rejected) assert.throws(() => detectPortal(url));
});

test('canonicalizes only stable application identity and strips tracking state', () => {
  assert.equal(
    canonicalSupportedPortalUrl('https://jobs.smartrecruiters.com/Lumina1/744000001027275-software-engineer?trid=tracking#share'),
    'https://jobs.smartrecruiters.com/Lumina1/744000001027275-software-engineer',
  );
  assert.equal(
    canonicalSupportedPortalUrl('https://jobs.smartrecruiters.com/oneclick-ui/company/Lumina1/publication/f137edd9-1f3b-448a-9a5f-2c2ca63fddeb?utm_source=x&dcr_ci=Lumina1'),
    'https://jobs.smartrecruiters.com/oneclick-ui/company/Lumina1/publication/f137edd9-1f3b-448a-9a5f-2c2ca63fddeb?dcr_ci=Lumina1',
  );
  assert.equal(
    canonicalSupportedPortalUrl('https://jobs.smartrecruiters.com/oneclick-ui/company/Lumina1/publication/f137edd9-1f3b-448a-9a5f-2c2ca63fddeb?dcr_ci=AnotherTenant'),
    'https://jobs.smartrecruiters.com/oneclick-ui/company/Lumina1/publication/f137edd9-1f3b-448a-9a5f-2c2ca63fddeb',
  );
  assert.equal(
    canonicalSupportedPortalUrl('https://jobs.jobvite.com/worldfirst/job/oknrAfws?source=board#apply'),
    'https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply',
  );
  assert.equal(
    canonicalSupportedPortalUrl('https://externalhourly-omnihotels.icims.com/jobs/133505/commis-%c3%a0-la-r%c3%a9ception/job?mobile=true'),
    'https://externalhourly-omnihotels.icims.com/jobs/133505/commis-%c3%a0-la-r%c3%a9ception/login',
  );
  assert.equal(
    portalApplicationUrl('jobvite', 'https://jobs.jobvite.com/genpactexperience/job/oZCwAfwr'),
    'https://jobs.jobvite.com/genpactexperience/job/oZCwAfwr/apply',
  );
});

test('all three are denied autonomous submit, polling, and unattended receipt claims', () => {
  for (const family of ['smartrecruiters', 'icims', 'jobvite'] as const) {
    assert.equal(portalCanAutoSubmit(family), false, family);
    assert.equal(managedPortalReceiptCapability(family), 'unavailable_before_handoff', family);
    assert.equal((POLLABLE_JOB_BOARDS as readonly string[]).includes(family), false, family);
    assert.match(portalHandoffReason(family) ?? '', /you|your|human|account|privacy|confirm/i, family);
  }
  assert.equal(isAccountWalledFamily('icims'), true);
  assert.equal(isAccountWalledFamily('jobvite'), true);
  assert.equal(isAccountWalledFamily('smartrecruiters'), false);
});

test('managed actions fill SmartRecruiters step one but never advance or submit', () => {
  const actions = buildManagedPortalActions('smartrecruiters', { ...packet, questions: adversarialQuestions }, true);
  const opening = actions.find((action) => action.label === 'open application form');
  assert.ok(opening);
  assert.match(opening.selector ?? '', /oneclick-ui\/company/);
  assert.doesNotMatch(opening.selector ?? '', /href\*="\/apply"/);
  assert.ok(actions.some((action) => action.type === 'fill' && action.label === 'first_name'));
  assert.ok(actions.some((action) => action.type === 'upload' && action.label === 'resume'));
  for (const [label, selector] of Object.entries(smartRecruitersExactSelectors)) {
    assert.ok(
      actions.some((action) => action.label === label && action.selector === selector),
      `${label} must use only its captured live selector`,
    );
  }
  assert.equal(
    actions.some((action) => action.label === 'phone' && action.selector === '[aria-label="Phone number"]'),
    false,
  );
  assert.equal(actions.some((action) => action.type === 'click' && !action.label), false);
  assert.equal(actions.some((action) => /next|continue|submit/i.test(action.label ?? '')), false);
  assert.equal(actions.some((action) => action.label?.startsWith('question')), false);
  for (const item of adversarialQuestions) {
    assert.equal(actions.some((action) => action.selector?.includes(item.portalSelector)), false, item.question);
  }
  const controlledActions = buildManagedPortalActions(
    'controlled_smartrecruiters',
    { ...packet, questions: adversarialQuestions },
    true,
  );
  assert.equal(controlledActions.some((action) => action.label?.startsWith('question')), false);
  for (const item of adversarialQuestions) {
    assert.equal(controlledActions.some((action) => action.selector?.includes(item.portalSelector)), false, item.question);
  }
});

test('account-walled iCIMS and Jobvite build no actions from benign, legal, or sensitive packet questions', () => {
  for (const family of ['icims', 'jobvite'] as const) {
    const actions = buildManagedPortalActions(family, { ...packet, questions: adversarialQuestions }, true);
    assert.deepEqual(actions, [], family);
  }
});

test('direct SmartRecruiters never replays packet selectors outside its exact fixed controls', async () => {
  const writes: string[] = [];
  const present = new Set(adversarialQuestions.map((item) => item.portalSelector));
  const locator = (selector: string): any => ({
    first: () => locator(selector),
    nth: () => locator(selector),
    count: async () => present.has(selector) ? 1 : 0,
    isVisible: async () => present.has(selector),
    fill: async () => { writes.push(selector); },
    setInputFiles: async () => { writes.push(selector); },
    getAttribute: async () => null,
    inputValue: async () => '',
    evaluate: async () => false,
  });
  const page = { locator } as unknown as Page;
  const results = [];
  for (const portal of ['smartrecruiters', 'controlled_smartrecruiters'] as const) {
    results.push(await fillPortal(page, portal, {
      ...packet,
      questions: adversarialQuestions,
    }));
  }
  assert.deepEqual(writes, []);
  for (const result of results) assert.match(result.blockers.join(' '), /step|review|finish|you/i);
});

test('direct SmartRecruiters fills every exact identity selector and leaves an earlier unrelated aria phone untouched', async () => {
  const writes: string[] = [];
  const exactSelectors = new Set<string>(Object.values(smartRecruitersExactSelectors));
  const broadPhoneSelector = '[aria-label="Phone number"]';
  const unrelatedPhone = '#newsletter-phone[aria-label="Phone number"]';
  const locator = (selector: string): any => {
    const present = exactSelectors.has(selector) || selector === broadPhoneSelector;
    const writeTarget = selector === broadPhoneSelector ? unrelatedPhone : selector;
    return {
      first: () => locator(selector),
      nth: () => locator(selector),
      count: async () => present ? 1 : 0,
      isVisible: async () => present,
      fill: async () => { if (present) writes.push(writeTarget); },
      setInputFiles: async () => { if (present) writes.push(writeTarget); },
      getAttribute: async (name: string) => name === 'type' && selector === smartRecruitersExactSelectors.resume ? 'file' : null,
      inputValue: async () => '',
      evaluate: async () => false,
    };
  };
  const page = { locator } as unknown as Page;
  await fillPortal(page, 'smartrecruiters', { ...packet, questions: [] });
  for (const selector of Object.values(smartRecruitersExactSelectors)) {
    assert.ok(writes.includes(selector), selector);
  }
  assert.equal(writes.includes(unrelatedPhone), false);
});
