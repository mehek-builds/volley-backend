import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedPortalActions,
  buildManagedAttendedAccountProbeActions,
  canonicalSupportedPortalUrl,
  detectPortal,
  fillPortal,
  isAccountWalledFamily,
  managedPortalReceiptCapability,
  managedAttendedAccountHold,
  managedAttendedAccountUrlIsSupported,
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
  /* Required on the live form, measured 2026-08-27 on a Western Digital posting. Anchored on
     data-test because the element's own id is generated per render (spl-form-element_5). */
  location: 'spl-autocomplete[data-test="location-autocomplete"] input',
  linkedin: 'spl-input#linkedin-input input',
  portfolio: 'spl-input#website-input input',
  resume: 'spl-dropzone[data-test="resume-upload"] input[type="file"]',
} as const;

test('detects the exact live SmartRecruiters, iCIMS, Jobvite, and Oracle attended routes', () => {
  const fixtures = [
    ['https://jobs.smartrecruiters.com/Lumina1/744000001027275-software-engineer', 'smartrecruiters'],
    ['https://jobs.smartrecruiters.com/BoschGroup/744000142166560-junior-managers-program', 'smartrecruiters'],
    ['https://jobs.smartrecruiters.com/oneclick-ui/company/Lumina1/publication/f137edd9-1f3b-448a-9a5f-2c2ca63fddeb?dcr_ci=Lumina1', 'smartrecruiters'],
    ['https://externalhourly-omnihotels.icims.com/jobs/133505/commis-%c3%a0-la-r%c3%a9ception/job', 'icims'],
    ['https://jobs-express.icims.com/jobs/48173/sales-associate/login', 'icims'],
    // A real SIG posting. iCIMS copies the title into the slug verbatim, so the colon arrives
    // unencoded from the tenant's own search results; the %3a form is the same posting.
    ['https://careers-sig.icims.com/jobs/10837/trading-system-engineering-internship:-summer-2027/job', 'icims'],
    ['https://careers-sig.icims.com/jobs/10837/trading-system-engineering-internship%3a-summer-2027/job', 'icims'],
    ['https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply', 'jobvite'],
    ['https://jobs.jobvite.com/genpactexperience/job/oZCwAfwr', 'jobvite'],
    ['https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/295586', 'oraclecloud'],
    ['https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email', 'oraclecloud'],
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
    'https://jobs-express.icims.com/jobs/48173/sales-associate/apply',
    'https://login.icims.com/u/login/identifier',
    'https://community.icims.com/articles/help',
    'https://www.icims.com/jobs/1234/demo/job',
    'https://jobs.jobvite.com/worldfirst/jobs',
    'https://jobs.jobvite.com/careers/worldfirst/jobs',
    'https://www.jobvite.com/worldfirst/job/oknrAfws/apply',
    'https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply/extra',
    'https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/295587/apply/email',
    'https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/295586/apply/email',
    'https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/295586/apply/password',
    'https://arbitrary.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/295586/apply/email',
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
  assert.equal(
    canonicalSupportedPortalUrl('https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/295586?source=board#apply'),
    'https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/295586',
  );
  assert.equal(
    canonicalSupportedPortalUrl('https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email'),
    'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email',
  );
  assert.equal(
    portalApplicationUrl('oraclecloud', 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email'),
    'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email',
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

test('account-walled iCIMS, Jobvite, and Oracle build no actions from packet questions', () => {
  for (const family of ['icims', 'jobvite', 'oraclecloud'] as const) {
    const actions = buildManagedPortalActions(family, { ...packet, questions: adversarialQuestions }, true);
    assert.deepEqual(actions, [], family);
  }
});

test('Jobvite, iCIMS, and Oracle managed gate probes are extract-only and never operate a user gate', () => {
  for (const family of ['jobvite', 'icims', 'oraclecloud'] as const) {
    const actions = buildManagedAttendedAccountProbeActions(family);
    assert.ok(actions.length > 0, family);
    assert.ok(actions.every((action) => action.type === 'extract'), family);
    assert.equal(actions.some((action) => action.value || action.text || action.file), false, family);
  }
  assert.deepEqual(buildManagedAttendedAccountProbeActions('greenhouse'), []);
});

test('Oracle hold requires every exact captured authentication marker on the frozen job', () => {
  const frozen = 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email';
  const handoff = frozen;
  const extracted = [
    { selector: 'input#primary-email-1[name="primary-email"]', label: 'oracle_primary_email_gate', value: 'primary-email' },
    { selector: 'input#legal-disclaimer-checkbox', label: 'oracle_legal_disclaimer_gate', value: 'legal-disclaimer-checkbox' },
    { selector: 'input#honey-pot-0[name="honey-pot"]', label: 'oracle_honeypot_marker', value: 'honey-pot' },
  ];
  assert.deepEqual(managedAttendedAccountHold('oraclecloud', frozen, {
    title: 'Authentication screen',
    url: handoff,
    text: "You don't need to have an account. I agree with the terms and conditions",
    extracted,
  }), {
    kind: 'account_login',
    reason: portalHandoffReason('oraclecloud'),
    categories: ['account_login', 'privacy_consent'],
  });
  assert.deepEqual(managedAttendedAccountHold('oraclecloud', frozen, {
    title: 'Authentication screen',
    url: handoff,
    text: 'Protected by hCaptcha',
    extracted: [...extracted, {
      selector: 'textarea[name="h-captcha-response"]',
      label: 'oracle_hcaptcha_gate',
      value: 'h-captcha-response',
    }],
  }), {
    kind: 'account_login',
    reason: portalHandoffReason('oraclecloud'),
    categories: ['account_login', 'privacy_consent', 'captcha'],
    captchaProvider: 'hcaptcha',
  });
  for (let index = 0; index < extracted.length; index += 1) {
    assert.equal(managedAttendedAccountHold('oraclecloud', frozen, {
      title: 'Authentication screen',
      url: handoff,
      text: 'Authentication screen',
      extracted: extracted.filter((_, itemIndex) => itemIndex !== index),
    }), null);
  }
  for (const url of [
    handoff.replace('/apply/email', ''),
    `${handoff}?source=tracker`,
    `${handoff}#authentication`,
    handoff.replace('oraclecloud.com', 'oraclecloud.com:444'),
  ]) assert.equal(managedAttendedAccountHold('oraclecloud', frozen, {
    title: 'Authentication screen',
    url,
    text: 'Authentication screen',
    extracted,
  }), null);
  assert.equal(managedAttendedAccountHold('oraclecloud', frozen, {
    title: 'Authentication screen',
    url: handoff.replace('333913', '333914'),
    text: 'Authentication screen',
    extracted,
  }), null);
  assert.equal(managedAttendedAccountHold('oraclecloud', frozen, {
    title: 'Authentication screen',
    url: handoff.replace('eeho.fa.us2.oraclecloud.com', 'arbitrary.fa.us2.oraclecloud.com'),
    text: 'Authentication screen',
    extracted,
  }), null);
});

test('Oracle managed preparation is limited to the exact captured authentication URL', () => {
  const gate = 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913/apply/email';
  assert.equal(managedAttendedAccountUrlIsSupported('oraclecloud', gate), true);
  for (const url of [
    gate.replace('/apply/email', ''),
    `${gate}?source=tracker`,
    `${gate}#authentication`,
    gate.replace('333913', '333914'),
    'https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/295586',
  ]) assert.equal(managedAttendedAccountUrlIsSupported('oraclecloud', url), false, url);
});

test('Jobvite hold requires the exact captured consent control on the same job', () => {
  const frozen = 'https://jobs.jobvite.com/worldfirst/job/oknrAfws/apply';
  const result = {
    title: 'Data Consent',
    url: frozen,
    text: 'Data Consent',
    extracted: [{ selector: 'select#jv-country-select', label: 'jobvite_data_consent_gate', value: 'jv-country-select' }],
  };
  assert.deepEqual(managedAttendedAccountHold('jobvite', frozen, result), {
    kind: 'privacy_consent',
    reason: portalHandoffReason('jobvite'),
    categories: ['privacy_consent'],
  });
  assert.equal(managedAttendedAccountHold(
    'jobvite',
    'https://jobs.jobvite.com/worldfirst/job/adjacentId/apply',
    result,
  ), null);
  assert.equal(managedAttendedAccountHold('jobvite', frozen, { ...result, url: 'https://jobs.jobvite.com/other/job/oknrAfws/apply' }), null);
  assert.equal(managedAttendedAccountHold('jobvite', frozen, { ...result, extracted: [] }), null);
});

test('iCIMS hold requires the exact login and hCaptcha controls on the same tenant and job', () => {
  const frozen = 'https://jobs-express.icims.com/jobs/48173/sales-associate/login';
  const result = {
    title: 'Log in',
    url: `${frozen}?mobile=true&utm_source=board`,
    text: 'Protected by hCaptcha',
    extracted: [
      { selector: 'input#email[name="css_loginName"]', label: 'icims_account_login_gate', value: 'css_loginName' },
      { selector: 'textarea[name="h-captcha-response"]', label: 'icims_hcaptcha_gate', value: 'h-captcha-response' },
    ],
  };
  assert.deepEqual(managedAttendedAccountHold('icims', frozen, result), {
    kind: 'account_login',
    reason: portalHandoffReason('icims'),
    categories: ['account_login', 'captcha'],
    captchaProvider: 'hcaptcha',
  });
  assert.equal(managedAttendedAccountHold(
    'icims',
    'https://jobs-express.icims.com/jobs/48174/sales-associate/login',
    result,
  ), null);
  assert.equal(managedAttendedAccountHold('icims', frozen, { ...result, url: 'https://other.icims.com/jobs/48173/sales-associate/login' }), null);
  assert.equal(managedAttendedAccountHold('icims', frozen, { ...result, extracted: result.extracted.slice(0, 1) }), null);
  assert.equal(managedAttendedAccountHold('icims', frozen, {
    ...result,
    url: 'https://jobs-express.icims.com/jobs/search',
  }), null);
});

test('iCIMS security-code metadata is held without claiming the application was submitted', () => {
  const frozen = 'https://jobs-express.icims.com/jobs/48173/sales-associate/login';
  const hold = managedAttendedAccountHold('icims', frozen, {
    title: 'Security code',
    url: frozen,
    text: 'Enter your security code',
    humanVerification: { kind: 'security_code', fieldCount: 1, sentTo: 'app-123@example.com' },
  });
  assert.equal(hold?.kind, 'security_code');
  assert.deepEqual(hold?.categories, ['security_code', 'account_login']);
  assert.match(hold?.reason ?? '', /did not enter the code or submit/i);
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
