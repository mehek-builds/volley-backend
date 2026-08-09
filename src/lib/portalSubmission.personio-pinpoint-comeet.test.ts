import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  canonicalSupportedPortalUrl,
  detectPortal,
  portalApplicationUrl,
  portalCanAutoSubmit,
  portalHandoffReason,
  readManagedReceipt,
} from './portalSubmission';

const packet = {
  fullName: 'Taylor Example',
  email: 'taylor@example.com',
  phone: '+971500000000',
  city: 'Dubai',
  linkedinUrl: 'https://www.linkedin.com/in/taylor',
  portfolioUrl: 'https://taylor.example',
  resume: Buffer.from('pdf'),
  resumeName: 'resume.pdf',
  coverLetter: Buffer.from('letter'),
  coverLetterName: 'cover-letter.pdf',
  questions: [],
};

test('detects two unrelated live tenant URL shapes for each family', () => {
  const fixtures = [
    ['https://matrix42.jobs.personio.com/job/2663722/apply?language=en', 'personio'],
    ['https://chrono24.jobs.personio.de/job/2661227/apply?language=en', 'personio'],
    ['https://propellerindustries.pinpointhq.com/postings/d29a48ed-c460-4ba9-872a-a3b93d025867/applications/new', 'pinpoint'],
    ['https://discogsinc.pinpointhq.com/en/postings/5bccb603-bbe0-4e1f-8f92-d983f78f77a7/applications/new', 'pinpoint'],
    ['https://www.comeet.co/jobs/A0.002/46.A6A/apply?token=public-tenant-token', 'comeet'],
    ['https://www.comeet.co/jobs/59.004/FF.C64/apply?token=public-tenant-token', 'comeet'],
  ] as const;
  for (const [url, family] of fixtures) assert.equal(detectPortal(url), family, url);
});

test('canonicalizes Personio and Pinpoint posting URLs to their application forms', () => {
  assert.equal(
    canonicalSupportedPortalUrl('https://matrix42.jobs.personio.com/job/2663722?utm_source=test&language=EN'),
    'https://matrix42.jobs.personio.com/job/2663722/apply?language=en',
  );
  assert.equal(
    canonicalSupportedPortalUrl('https://discogsinc.pinpointhq.com/en/postings/5bccb603-bbe0-4e1f-8f92-d983f78f77a7?source=test'),
    'https://discogsinc.pinpointhq.com/en/postings/5bccb603-bbe0-4e1f-8f92-d983f78f77a7/applications/new',
  );
  assert.equal(
    portalApplicationUrl('pinpoint', 'https://propellerindustries.pinpointhq.com/postings/d29a48ed-c460-4ba9-872a-a3b93d025867'),
    'https://propellerindustries.pinpointhq.com/postings/d29a48ed-c460-4ba9-872a-a3b93d025867/applications/new',
  );
});

test('uses Personio query application state and keeps legacy path inputs compatible', () => {
  const live = 'https://arteus-energy.jobs.personio.de/job/2521967?apply=&language=de';
  assert.equal(detectPortal(live), 'personio');
  assert.equal(canonicalSupportedPortalUrl(live), live);
  assert.equal(
    detectPortal('https://arteus-energy.jobs.personio.de/job/2521967?language=de&apply='),
    'personio',
  );
  assert.equal(
    portalApplicationUrl('personio', 'https://matrix42.jobs.personio.com/job/2663722/apply?language=DE'),
    'https://matrix42.jobs.personio.com/job/2663722/apply?language=DE',
  );
  for (const url of [
    'https://other.jobs.personio.de/job/2521967?apply=&language=de',
    'https://other.jobs.personio.de/job/2521967?language=de&apply=',
    'https://other.jobs.personio.de/job/2521967/apply?language=de',
    'https://other.jobs.personio.de/job/2521967?language=de&apply=&apply=',
    'https://arteus-energy.jobs.personio.de/job/2521968?apply=&language=de',
    'https://arteus-energy.jobs.personio.de/job/2521967?apply=1&language=de',
    'https://arteus-energy.jobs.personio.de/job/2521967?apply=&apply=&language=de',
    'https://arteus-energy.jobs.personio.de/job/2521967?apply=&language=de&language=de',
    'https://arteus-energy.jobs.personio.de/job/2521967?apply=&language=de&source=test',
    'https://arteus-energy.jobs.personio.de/job/2521967?apply=&language=de#apply',
    'https://arteus-energy.jobs.personio.de/job/2521967?apply=&language=en',
    'https://arteus-energy.jobs.personio.de/job/2521967%2Fapply?apply=&language=de',
    'https://arteus-energy.jobs.personio.de/job/2521967/apply?language=de',
    'https://arteus-energy.jobs.personio.de/jobs/2521967?apply=',
    'https://arteus-energy.jobs.personio.de/job/not-a-number?apply=',
    'https://jobs.personio.de/job/2521967?apply=',
    'https://arteus-energy.personio.de/job/2521967?apply=',
  ]) assert.throws(() => detectPortal(url), url);
});

test('requires a nonempty opaque Comeet iframe token and preserves it byte-for-byte', () => {
  const wrapper = 'https://www.comeet.com/jobs/gett/A0.002/application-security-lead/46.A6A';
  assert.equal(canonicalSupportedPortalUrl(wrapper, 'comeet'), undefined);
  assert.throws(() => detectPortal(wrapper));

  const missing = 'https://www.comeet.co/jobs/A0.002/46.A6A/apply';
  const empty = 'https://www.comeet.co/jobs/A0.002/46.A6A/apply?token=';
  assert.throws(() => detectPortal(missing));
  assert.throws(() => detectPortal(empty));
  assert.equal(canonicalSupportedPortalUrl(missing, 'comeet'), undefined);
  assert.equal(canonicalSupportedPortalUrl(empty, 'comeet'), undefined);

  const iframe = 'https://www.comeet.co/jobs/A0.002/46.A6A/apply?source=x&token=%2FAbC%2B_9&lang=en';
  assert.equal(detectPortal(iframe), 'comeet');
  assert.equal(canonicalSupportedPortalUrl(iframe, 'comeet'), iframe);
});

test('does not claim the Pinpoint vendor site as a tenant', () => {
  assert.throws(() => detectPortal('https://www.pinpointhq.com/postings/demo/applications/new'));
});

test('maps stable core selectors and never maps consent, salary, or honeypot fields', () => {
  const cases = [
    ['personio', ['input[name="first_name"]', 'input[name="email"]', 'input[type="file"][name="documents.cv"]']],
    ['pinpoint', ['input[name="application_form[application][first_name]"]', 'input[name="application_form[application][email]"]', 'input[type="file"][name="application_form[application][cv]"]']],
    ['comeet', ['input[name="firstName"]', 'input[name="email"]', 'input[type="file"][name="cv"]']],
  ] as const;
  for (const [family, selectors] of cases) {
    const actions = buildManagedPortalActions(family, packet, true);
    for (const selector of selectors) assert.ok(actions.some((action) => action.selector === selector), `${family}: ${selector}`);
    const serialized = JSON.stringify(actions);
    for (const forbidden of [
      'application_process_information',
      'application[process_information]',
      'salary_expectations',
      'available_from',
      'g-recaptcha-response',
      'honeypot',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${family} mapped ${forbidden}`);
    }
  }
});

test('discovery is fill-only and every new family is barred from automatic final submit', () => {
  for (const family of ['personio', 'pinpoint', 'comeet'] as const) {
    assert.equal(portalCanAutoSubmit(family), false);
    assert.ok(portalHandoffReason(family));
    const discovery = buildManagedDiscoveryActions(family, packet);
    assert.equal(discovery.filter((action) => action.type === 'discover').length, 1);
    assert.equal(discovery.some((action) => action.type === 'click' && !action.label), false);
    const requestedSubmit = buildManagedPortalActions(family, packet, true);
    assert.equal(requestedSubmit.some((action) => action.type === 'click' && !action.label), false);
  }
});

test('receipt proof accepts provider confirmation fixtures and rejects an open form', () => {
  const confirmations = [
    ['personio', 'Thank you for your application. We have received your application.'],
    ['pinpoint', 'Application submitted. Your reference number: PIN-12345'],
    ['comeet', 'Success. Your application has been received.'],
  ] as const;
  for (const [family, text] of confirmations) {
    const receipt = readManagedReceipt({ title: family, url: `https://example.com/${family}/confirmation`, text });
    assert.match(receipt.confirmationText, /thank you|submitted|success/i);
  }
  assert.throws(() => readManagedReceipt({ title: 'Apply', url: 'https://example.com/apply', text: 'Submit application' }));
});
