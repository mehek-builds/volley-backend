import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  canonicalSupportedPortalUrl,
  detectPortal,
  MANAGED_CONSENT_TICK_GUARD_LABEL,
  MANAGED_CONSENT_TICK_LABEL_PREFIX,
  portalApplicationUrl,
  portalCanAutoSubmit,
  portalHandoffReason,
  readManagedReceipt,
} from './portalSubmission';
import { AUTOMATIC_CONSENT_ACCEPTANCE_VERSION } from './automationConsent';

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

/* ---- the grant-conditional consent tick, Pinpoint side ---- */

const PINPOINT_CONSENT_SELECTOR = 'input[name="application_form[application][process_information]"]';
const grantedProfile = {
  consent_acknowledgement_permission: {
    granted_at: '2026-08-12T09:15:00.000Z',
    version: AUTOMATIC_CONSENT_ACCEPTANCE_VERSION,
  },
};
const pinpointConsentQuestion = {
  question: 'I consent to the processing of my personal data in accordance with the privacy policy.',
  answer: 'Yes',
  answerSource: 'consent_permission',
  portalSelector: PINPOINT_CONSENT_SELECTOR,
  portalInputType: 'checkbox',
};

test('with the grant and the recorded acceptance, Pinpoint ticks its privacy consent once, guarded, then submits', () => {
  const actions = buildManagedPortalActions('pinpoint', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [pinpointConsentQuestion],
  }, true);
  const ticks = actions.filter((action) => action.type === 'click'
    && action.label?.startsWith(`${MANAGED_CONSENT_TICK_LABEL_PREFIX}:`));
  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].selector, PINPOINT_CONSENT_SELECTOR);
  assert.equal(ticks[0].optional, false);
  assert.equal(ticks[0].requireUnique, true);
  const guardIndex = actions.findIndex((action) => action.label === MANAGED_CONSENT_TICK_GUARD_LABEL);
  const tickIndex = actions.indexOf(ticks[0]);
  assert.ok(guardIndex >= 0 && guardIndex < tickIndex, 'honeypot guard precedes the tick');
  assert.equal(actions[guardIndex].requireVisible, true);
  assert.equal(actions[guardIndex].requireUnique, true);
  assert.equal(actions[guardIndex].optional, false);
  const submits = actions.filter((action) => action.type === 'confirmAndSubmit');
  assert.equal(submits.length, 1);
  assert.equal(actions.indexOf(submits[0]), tickIndex + 1);
  // The reviewed-question loop must not also touch the control - a check plus the tick's toggle
  // would leave it unticked under a submit.
  assert.deepEqual(
    actions.filter((action) => action.selector?.includes('process_information')
      || action.text?.includes('processing of my personal data')),
    [actions[guardIndex], ticks[0]],
  );
});

test('Pinpoint without the grant, with a held declaration, or with two consent-shaped controls stays parked', () => {
  // No grant: no tick, no submit - the exact behaviour the family had before the grant existed.
  const noGrant = buildManagedPortalActions('pinpoint', { ...packet, questions: [pinpointConsentQuestion] }, true);
  assert.doesNotMatch(JSON.stringify(noGrant), /process_information/);
  assert.equal(noGrant.some((action) => action.type === 'confirmAndSubmit'), false);

  // A held declaration wearing the consent control's name is vetoed by the classifier's law.
  const held = buildManagedPortalActions('pinpoint', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [{
      ...pinpointConsentQuestion,
      question: 'I certify that the information provided in this application is true and I authorize a background check.',
    }],
  }, true);
  assert.equal(held.some((action) => action.label?.startsWith(`${MANAGED_CONSENT_TICK_LABEL_PREFIX}:`)), false);
  assert.equal(held.some((action) => action.type === 'confirmAndSubmit'), false);

  // Both captured name spellings present at once is two consent-shaped controls: park, not guess.
  const ambiguous = buildManagedPortalActions('pinpoint', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [
      pinpointConsentQuestion,
      { ...pinpointConsentQuestion, portalSelector: 'input[name="application[process_information]"]' },
    ],
  }, true);
  assert.equal(ambiguous.some((action) => action.label?.startsWith(`${MANAGED_CONSENT_TICK_LABEL_PREFIX}:`)), false);
  assert.equal(ambiguous.some((action) => action.type === 'confirmAndSubmit'), false);

  // Personio's bar is not a consent, so the grant moves nothing there.
  const personio = buildManagedPortalActions('personio', {
    ...packet,
    applicationProfile: grantedProfile,
    questions: [pinpointConsentQuestion],
  }, true);
  assert.equal(personio.some((action) => action.label?.startsWith(`${MANAGED_CONSENT_TICK_LABEL_PREFIX}:`)), false);
  assert.equal(personio.some((action) => action.type === 'confirmAndSubmit'), false);
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
