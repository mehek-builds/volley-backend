import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import {
  buildManagedPortalActions,
  canonicalSupportedPortalUrl,
  detectPortal,
  fillPortal,
  isAccountWalledFamily,
  managedPortalReceiptCapability,
  portalCanAutoSubmit,
  portalMayResolveUnknownRequired,
} from './portalSubmission';
import { POLLABLE_JOB_BOARDS } from './jobMonitor';

const packet = {
  fullName: 'Taylor Example',
  email: 'taylor@example.com',
  phone: '+971500000000',
  city: 'Dubai',
  linkedinUrl: 'https://linkedin.com/in/taylor',
  resume: Buffer.from('pdf'),
  resumeName: 'resume.pdf',
  questions: [
    { question: 'Benign', answer: 'write', portalSelector: '#benign', portalInputType: 'text' },
    { question: 'Legal', answer: 'Yes', portalSelector: '#legal', portalInputType: 'checkbox' },
    { question: 'Sensitive', answer: '123', portalSelector: '#ssn', portalInputType: 'text' },
  ],
};

test('recognises only the captured recruiting routes', () => {
  assert.equal(detectPortal('https://mpathic2.bamboohr.com/careers/99'), 'bamboohr');
  assert.equal(detectPortal('https://prentkeromich.bamboohr.com/careers/480'), 'bamboohr');
  assert.equal(detectPortal('https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9'), 'ultipro');
  assert.equal(detectPortal('https://recruiting.ultipro.com/LIT1004LDAC/JobBoard/30702fd2-636e-4886-b1ce-4fc3b07e37ec/OpportunityDetail?opportunityId=4fc30c2a-e2b3-42e0-bcaf-7805f741c04a'), 'ultipro');
  assert.equal(detectPortal('https://recruiting.ultipro.com/cov1003covcu/JobBoard/24b0bccd-d0f2-4641-a5f2-6ca809c72521/OpportunityDetail?opportunityId=954bed4e-7b77-4abd-ac78-add89ee3c71e'), 'ultipro');
  assert.equal(detectPortal('https://enterpriseplatform.dell.com/hcmUI/CandidateExperience/en/sites/careers/job/295586'), 'oraclecloud');
  assert.equal(detectPortal('https://iawmqy.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/careers/job/295586'), 'oraclecloud');
  assert.equal(detectPortal('https://fa-etxx-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2850/'), 'oraclecloud');
  assert.equal(detectPortal('https://sandboxxerox.avature.net/en_US/careers/JobDetail/2nd-Line-Technical-Analyst/44460'), 'avature');
  assert.equal(detectPortal('https://maximus.avature.net/careers/Job-Application'), 'avature');
  assert.equal(detectPortal('https://sandboxxerox.avature.net/en_US/careers/Login?jobId=44460'), 'avature');
  assert.equal(detectPortal('https://jobs.ea.com/en_US/careers/JobDetail/Software-Engineer-Intern/214956'), 'avature');
  assert.throws(() => detectPortal('https://www.avature.net/careers/Job-Application'));
  assert.throws(() => detectPortal('https://enterpriseplatform.dell.com/login'));
  assert.throws(() => detectPortal('https://sandboxxerox.avature.net/en_US/careers/Login'));
  for (const raw of [
    'https://mpathic2.bamboohr.com/careers/99evil',
    'https://mpathic2.bamboohr.com/careers/99/admin',
    'https://mpathic2.bamboohr.com/careers/480',
    'https://acme.bamboohr.com/careers/99',
    'https://enterpriseplatform.dell.com/hcmUI/CandidateExperience/en/sites/careers/login',
    'https://enterpriseplatform.dell.com/hcmUI/CandidateExperience/en/sites/careers/job/admin',
    'https://enterpriseplatform.dell.com/hcmUI/CandidateExperience/en/sites/careers/job/295586/payroll',
    'https://enterpriseplatform.dell.com/hcmUI/CandidateExperience/en/sites/careers/job/295587',
    'https://arbitrary.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/2850',
    'https://fa-etxx-saasfaprod1.fa.ocs.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/payroll/2850',
    'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail',
    'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/login',
    'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/admin?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
    'https://recruiting.ultipro.com/ABC1000/JobBoard/11111111-1111-1111-1111-111111111111/OpportunityDetail?opportunityId=22222222-2222-2222-2222-222222222222',
    'https://recruiting.ultipro.com/cov1003covcu/JobBoard/24b0bccd-d0f2-4641-a5f2-6ca809c72521/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
    'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/24b0bccd-d0f2-4641-a5f2-6ca809c72521/OpportunityDetail?opportunityId=954bed4e-7b77-4abd-ac78-add89ee3c71e',
    'https://recruiting.ultipro.com/cov1003covcu/JobBoard/24b0bccd-d0f2-4641-a5f2-6ca809c72521/OpportunityDetail/extra?opportunityId=954bed4e-7b77-4abd-ac78-add89ee3c71e',
    'https://recruiting.ultipro.com/cov1003covcu/JobBoard/24b0bccd-d0f2-4641-a5f2-6ca809c72521/OpportunityDetail?opportunityId=954bed4e-7b77-4abd-ac78-add89ee3c71e&opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
    'https://recruiting.ultipro.com/cov1003covcu/JobBoard/24b0bccd-d0f2-4641-a5f2-6ca809c72521/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9&opportunityId=954bed4e-7b77-4abd-ac78-add89ee3c71e',
    'https://sandboxxerox.avature.net/en_US/careers/JobDetail/Other/44461',
    'https://arbitrary.avature.net/en_US/careers/JobDetail/2nd-Line-Technical-Analyst/44460',
    'https://jobs.ea.com/en_US/careers/JobDetail/Software-Engineer-Intern/214957',
    'https://jobs.ea.com/en_US/careers/JobDetail/Other-Role/214956',
    'https://jobs.ea.com/en_US/careers/JobDetail/Software-Engineer-Intern/214956/extra',
    'https://jobs.ea.com/en_US/careers/JobDetail/Software-Engineer-Intern/214956?jobId=214957',
    'https://jobs.ea.com/en_US/careers/JobDetail/Software-Engineer-Intern/214956?jobId=214956&jobId=214957',
    'https://sandboxxerox.avature.net/en_US/careers/JobDetail/Software-Engineer-Intern/214956',
  ]) assert.throws(() => detectPortal(raw), raw);
});

test('canonical forms retain only stable job identity', () => {
  assert.equal(canonicalSupportedPortalUrl('https://mpathic2.bamboohr.com/careers/99/?source=x#apply'), 'https://mpathic2.bamboohr.com/careers/99');
  assert.equal(canonicalSupportedPortalUrl('https://sandboxxerox.avature.net/en_US/careers/JobDetail/2nd-Line-Technical-Analyst/44460?source=x#apply'), 'https://sandboxxerox.avature.net/en_US/careers/JobDetail/2nd-Line-Technical-Analyst/44460');
  assert.equal(canonicalSupportedPortalUrl('https://sandboxxerox.avature.net/en_US/careers/Login?jobId=44460&utm_source=x'), 'https://sandboxxerox.avature.net/en_US/careers/Login?jobId=44460');
  assert.equal(canonicalSupportedPortalUrl('https://jobs.ea.com/en_US/careers/JobDetail/Software-Engineer-Intern/214956?source=x#apply'), 'https://jobs.ea.com/en_US/careers/JobDetail/Software-Engineer-Intern/214956');
  assert.equal(
    canonicalSupportedPortalUrl('https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?utm_source=x&opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9'),
    'https://recruiting.ultipro.com/WIN1014WINDQ/JobBoard/08eb8299-5b26-4208-adb7-897aa42c6959/OpportunityDetail?opportunityId=f6cd56f9-5b2f-4b53-9e86-2553b54524f9',
  );
  assert.equal(
    canonicalSupportedPortalUrl('https://recruiting.ultipro.com/cov1003covcu/JobBoard/24b0bccd-d0f2-4641-a5f2-6ca809c72521/OpportunityDetail?source=x&opportunityId=954bed4e-7b77-4abd-ac78-add89ee3c71e'),
    'https://recruiting.ultipro.com/cov1003covcu/JobBoard/24b0bccd-d0f2-4641-a5f2-6ca809c72521/OpportunityDetail?opportunityId=954bed4e-7b77-4abd-ac78-add89ee3c71e',
  );
});

test('Bamboo is fixed-field-only and all account walls return zero actions', () => {
  const bamboo = buildManagedPortalActions('bamboohr', packet, true);
  assert.equal(portalCanAutoSubmit('bamboohr'), false);
  assert.ok(bamboo.some((action) => action.label === 'first_name'));
  assert.ok(bamboo.some((action) => action.label === 'resume'));
  assert.equal(bamboo.some((action) => action.type === 'click' && action.label !== 'open application form'), false);
  for (const selector of ['#benign', '#legal', '#ssn']) {
    assert.equal(bamboo.some((action) => action.selector?.includes(selector)), false);
  }
  for (const family of ['ultipro', 'oraclecloud', 'avature'] as const) {
    assert.deepEqual(buildManagedPortalActions(family, packet, true), []);
    assert.equal(isAccountWalledFamily(family), true);
    assert.equal(portalCanAutoSubmit(family), false);
    assert.equal(managedPortalReceiptCapability(family), 'unavailable_before_handoff');
    assert.equal((POLLABLE_JOB_BOARDS as readonly string[]).includes(family), false);
  }
});

test('direct Bamboo required controls are blockers and never writable fallbacks', async () => {
  assert.equal(portalMayResolveUnknownRequired('bamboohr'), false);
  const writes: string[] = [];
  const required = [
    ['textarea', 'Why this role'],
    ['select', 'Country'],
    ['radio', 'Work authorization'],
    ['checkbox', 'Legal certification'],
    ['file', 'Additional attachment'],
  ] as const;
  const zero = (): any => ({
    first: zero,
    nth: zero,
    count: async () => 0,
    isVisible: async () => false,
    getAttribute: async () => null,
    locator: zero,
  });
  const field = (type: string, name: string): any => ({
    first: () => field(type, name),
    count: async () => 1,
    isVisible: async () => true,
    getAttribute: async (attribute: string) => attribute === 'type' ? type : attribute === 'name' ? name : null,
    inputValue: async () => '',
    isChecked: async () => false,
    locator: zero,
    fill: async () => { writes.push(`fill:${name}`); },
    check: async () => { writes.push(`check:${name}`); },
    selectOption: async () => { writes.push(`select:${name}`); return ['x']; },
    setInputFiles: async () => { writes.push(`file:${name}`); },
  });
  const locator = (selector: string): any => selector === 'input[required], textarea[required], select[required]'
    ? {
      ...zero(),
      count: async () => required.length,
      nth: (index: number) => {
        const [type, name] = required[index]!;
        return field(type, name);
      },
    }
    : zero();
  const page = { locator } as unknown as Page;
  await fillPortal(page, 'bamboohr', packet);
  assert.deepEqual(writes, []);
});
