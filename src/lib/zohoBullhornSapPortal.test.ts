import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { Page } from 'playwright-core';
import {
  buildManagedPortalActions,
  canonicalSupportedPortalUrl,
  detectPortal,
  fillPortal,
  isPortalSupported,
  portalApplicationUrl,
  portalCanAutoSubmit,
  portalHandoffReason,
  portalMayResolveUnknownRequired,
  portalUnknownRequiredBlocker,
  readManagedReceipt,
} from './portalSubmission';
import { browserApplicationCapability, isResearchedBrowserTenant } from './browserApplicationCapabilities';

const packet = {
  fullName: 'Taylor Example',
  email: 'apply+frozen@trylitos.com',
  phone: '+971500000000',
  resume: Buffer.from('pdf'),
  resumeName: 'Taylor_Example_Resume.pdf',
  questions: [],
};

function directPage(selectors: string[]) {
  const values = new Map<string, string>();
  const makeLocator = (selector: string): any => {
    const present = selectors.includes(selector);
    return {
      first: () => makeLocator(selector),
      nth: () => makeLocator(selector),
      count: async () => (present ? 1 : 0),
      isVisible: async () => present,
      isChecked: async () => false,
      fill: async (value: string) => { if (present) values.set(selector, value); },
      press: async () => undefined,
      check: async () => undefined,
      click: async () => undefined,
      selectOption: async () => [],
      setInputFiles: async () => undefined,
      getAttribute: async () => null,
      inputValue: async () => values.get(selector) ?? '',
      locator: () => makeLocator(`${selector} child`),
      evaluate: async () => false,
      waitFor: async () => undefined,
      allTextContents: async () => [],
      all: async () => [],
    };
  };
  return {
    values,
    page: {
      locator: (selector: string) => makeLocator(selector),
      getByText: () => makeLocator('missing text'),
      getByLabel: () => makeLocator('missing label'),
    } as unknown as Page,
  };
}

test('Zoho Recruit accepts only native tenant career detail paths and strips tracking', () => {
  const live = [
    'https://genovice.zohorecruit.com/jobs/Careers/618725000005596009/Calibration-Maintenance-Planner-Scheduler?source=CareerSite',
    'https://solution25.zohorecruit.eu/jobs/Careers/123456789/Engineer',
  ];
  for (const url of live) assert.equal(detectPortal(url), 'zoho_recruit');
  assert.equal(
    canonicalSupportedPortalUrl(live[0]),
    'https://genovice.zohorecruit.com/jobs/Careers/618725000005596009/Calibration-Maintenance-Planner-Scheduler',
  );
  assert.throws(() => detectPortal('https://www.zoho.com/recruit'));
  assert.throws(() => detectPortal('https://accounts.zoho.com/signin'));
});

test('Bullhorn is exact-tenant and exact-OSCP-hash scoped', () => {
  const serverLogic = 'https://www.serverlogic.com/wp-content/plugins/bullhorn-oscp/#/jobs/5942/apply';
  const staffing = 'https://www.staffingsolutionsenterprises.com/wp-content/plugins/bullhorn-oscp/#/jobs/381';
  assert.equal(detectPortal(serverLogic), 'bullhorn');
  assert.equal(detectPortal(staffing), 'bullhorn');
  assert.equal(
    canonicalSupportedPortalUrl(serverLogic),
    'https://www.serverlogic.com/wp-content/plugins/bullhorn-oscp/#/jobs/5942',
  );
  assert.throws(() => detectPortal('https://www.serverlogic.com/login'));
  assert.throws(() => detectPortal('https://example.com/wp-content/plugins/bullhorn-oscp/#/jobs/5942'));
});

test('SuccessFactors canonicalization preserves only proven tenant and job identity', () => {
  const legacy = 'https://career8.successfactors.com/career?career_ns=job_listing&company=MoodysProd&career_job_req_id=10516&_s.crb=secret';
  assert.equal(detectPortal(legacy), 'sap_successfactors');
  assert.equal(
    canonicalSupportedPortalUrl(legacy),
    'https://career8.successfactors.com/sfcareer/jobreqcareer?jobId=10516&company=MoodysProd',
  );
  assert.equal(portalApplicationUrl('sap_successfactors', legacy), canonicalSupportedPortalUrl(legacy));
  assert.throws(() => detectPortal('https://career8.successfactors.com/career'));
  assert.throws(() => detectPortal('https://performancemanager.successfactors.eu/sf/career'));
});

test('keeps the measured SAP wrapper unsupported until its public bindings resolve a direct tenant form', () => {
  const wrapper = 'https://jobs.sap.com/job/Walldorf-SAP-LOB-%26-Solution-Marketing-iXp-Intern-%28fmd%29-Marketing-Germany-69190/1403234233/';
  assert.throws(() => detectPortal(wrapper));
  assert.equal(isPortalSupported(wrapper), false);
  assert.equal(canonicalSupportedPortalUrl(wrapper, 'sap_successfactors'), undefined);
});

test('all three families default-deny programmatic submit and polling', () => {
  for (const family of ['zoho_recruit', 'bullhorn', 'sap_successfactors'] as const) {
    const capability = browserApplicationCapability(family);
    assert.equal(capability.programmaticSubmit, false);
    assert.equal(capability.pollPublicListings, false);
    assert.equal(capability.trustedDirectClick, true);
    assert.equal(portalCanAutoSubmit(family), false);
    const actions = buildManagedPortalActions(family, packet, true);
    assert.equal(actions.some((action) => action.type === 'click'), false);
    assert.match(portalHandoffReason(family) ?? '', /you|account|privacy|legal/i);
  }
});

test('factual actions use the frozen packet email, upload only resume, and never touch gates', () => {
  const guardedPacket = {
    ...packet,
    fieldOptions: { demographic: ['Pregnancy status', 'Prefer not to answer'] },
    questions: [
      { question: 'Race or ethnicity (EEO)', answer: 'Decline to self-identify' },
      { question: 'I attest that this application is accurate', answer: 'Yes' },
      { question: 'Consent to retain my data for future jobs', answer: 'Yes' },
      { question: 'Choose one', answer: 'Prefer not to answer', portalSelector: '[id="demographic"]', portalInputType: 'select' },
      { question: 'Please answer', answer: '18-24', portalSelector: 'input[name="age"]', portalInputType: 'text' },
      { question: 'Tell us about yourself', answer: 'Hello', portalSelector: 'textarea[name="bio"]', portalInputType: 'textarea' },
      { question: 'Favorite color', answer: 'Blue', portalSelector: 'select[name="color"]', portalInputType: 'select' },
      { question: 'Can you travel?', answer: 'Yes', portalSelector: 'input[name="travel_yes"]', portalInputType: 'radio' },
    ],
  };
  for (const family of ['zoho_recruit', 'bullhorn'] as const) {
    const actions = buildManagedPortalActions(family, guardedPacket);
    assert.ok(actions.some((action) => action.value === packet.email));
    assert.ok(actions.some((action) => action.type === 'upload' && action.label === 'resume'));
    assert.equal(actions.some((action) => (
      ['fill', 'fillByLabelText', 'upload', 'click', 'select', 'press'].includes(action.type)
      && /password|consent|privacy|retention|eeo|attest|captcha/i.test(action.label ?? '')
    )), false);
    assert.equal(actions.some((action) => /question:/i.test(action.label ?? '')), false);
    assert.equal(portalMayResolveUnknownRequired(family), false);
    assert.match(portalUnknownRequiredBlocker(family, 'Date of birth', 'text') ?? '', /Date of birth/);
  }
  assert.deepEqual(buildManagedPortalActions('sap_successfactors', packet, true), []);
});

test('Zoho managed identity writes use only exact named selectors', () => {
  const actions = buildManagedPortalActions('zoho_recruit', packet);
  const identity = actions
    .filter((action) => ['first_name', 'last_name', 'email', 'phone'].includes(action.label ?? ''))
    .map((action) => ({ type: action.type, selector: 'selector' in action ? action.selector : undefined, label: action.label }));
  assert.deepEqual(identity, [
    { type: 'fill', selector: 'input[name="First_Name"], input[name="firstName"]', label: 'first_name' },
    { type: 'fill', selector: 'input[name="Last_Name"], input[name="lastName"]', label: 'last_name' },
    { type: 'fill', selector: 'input[name="Email"], input[name="email"]', label: 'email' },
    { type: 'fill', selector: 'input[name="Phone"], input[name="phone"]', label: 'phone' },
  ]);
  assert.equal(actions.some((action) => action.type === 'fillByLabelText'), false);
  assert.equal(actions.some((action) => (
    action.type === 'fill'
    && /\bbody\b|input\[type=["']?(?:email|tel)/i.test(action.selector ?? '')
  )), false);
});

test('fixed-field-only families never replay benign durable reviewed controls', async () => {
  const adversarialPacket = {
    ...packet,
    questions: [
      { question: 'Tell us about yourself', answer: 'Hello', portalSelector: 'textarea[name="bio"]', portalInputType: 'textarea' },
      { question: 'Favorite color', answer: 'Blue', portalSelector: 'select[name="color"]', portalInputType: 'select' },
      { question: 'Can you travel?', answer: 'Yes', portalSelector: 'input[name="travel_yes"]', portalInputType: 'radio' },
    ],
  };
  for (const family of ['zoho_recruit', 'bullhorn'] as const) {
    const actions = buildManagedPortalActions(family, adversarialPacket);
    assert.equal(actions.some((action) => /bio|color|travel/i.test(`${action.selector ?? ''} ${action.label ?? ''}`)), false);
  }
  assert.deepEqual(buildManagedPortalActions('sap_successfactors', adversarialPacket, true), []);

  const sapPage = new Proxy({}, { get: () => { throw new Error('SuccessFactors direct runner touched the page'); } }) as Page;
  assert.deepEqual(await fillPortal(sapPage, 'sap_successfactors', adversarialPacket), {
    filledFields: [],
    blockers: [portalHandoffReason('sap_successfactors')!],
  });
});

test('Zoho direct fill uses exact candidate names and ignores earlier custom contact controls', async () => {
  const selectors = [
    'input[type="email"]',
    'input[type="tel"]',
    'input[name="Email"]',
    'input[name="Phone"]',
    'textarea[name="bio"]',
    'select[name="color"]',
    'input[name="travel_yes"]',
  ];
  const { page, values } = directPage(selectors);
  await fillPortal(page, 'zoho_recruit', {
    ...packet,
    questions: [
      { question: 'Tell us about yourself', answer: 'Hello', portalSelector: 'textarea[name="bio"]', portalInputType: 'textarea' },
      { question: 'Favorite color', answer: 'Blue', portalSelector: 'select[name="color"]', portalInputType: 'select' },
      { question: 'Can you travel?', answer: 'Yes', portalSelector: 'input[name="travel_yes"]', portalInputType: 'radio' },
    ],
  });
  assert.equal(values.get('input[name="Email"]'), packet.email);
  assert.equal(values.get('input[name="Phone"]'), packet.phone);
  assert.equal(values.has('input[type="email"]'), false);
  assert.equal(values.has('input[type="tel"]'), false);
  assert.equal(values.has('textarea[name="bio"]'), false);
  assert.equal(values.has('select[name="color"]'), false);
  assert.equal(values.has('input[name="travel_yes"]'), false);
});

test('researched tenant allowlist is exact', () => {
  assert.equal(isResearchedBrowserTenant('zoho_recruit', 'genovice.zohorecruit.com'), true);
  assert.equal(isResearchedBrowserTenant('bullhorn', 'www.serverlogic.com'), true);
  assert.equal(isResearchedBrowserTenant('sap_successfactors', 'career8.successfactors.com'), true);
  assert.equal(isResearchedBrowserTenant('sap_successfactors', 'career5.successfactors.eu'), true);
  assert.equal(isResearchedBrowserTenant('bullhorn', 'serverlogic.com'), false);
});

test('filled forms and account walls are not receipts', () => {
  const fixtures = JSON.parse(readFileSync('src/lib/fixtures/zoho-bullhorn-sap-receipts.json', 'utf8')) as Record<string, { title: string; url: string; text: string }>;
  for (const fixture of Object.values(fixtures)) {
    assert.throws(() => readManagedReceipt({ ...fixture, extracted: [] }), /never showed a confirmation/i);
  }
});
