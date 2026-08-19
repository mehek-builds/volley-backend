import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import {
  buildManagedPortalActions,
  canonicalSupportedPortalUrl,
  detectPortal,
  fillPortal,
  portalCanAutoSubmit,
  portalHandoffReason,
  portalMayResolveUnknownRequired,
} from './portalSubmission';
import { browserApplicationCapability } from './browserApplicationCapabilities';

const packet = {
  fullName: 'Taylor Example',
  email: 'apply+frozen@trylitos.com',
  phone: '+971500000000',
  city: 'Dubai',
  linkedinUrl: 'https://www.linkedin.com/in/taylor-example',
  resume: Buffer.from('pdf'),
  resumeName: 'Taylor_Example_Resume.pdf',
  questions: [
    { question: 'Tell us about yourself', answer: 'Hello', portalSelector: 'textarea[name="bio"]', portalInputType: 'textarea' },
    { question: 'Favorite color', answer: 'Blue', portalSelector: 'select[name="color"]', portalInputType: 'select' },
    { question: 'Can you travel?', answer: 'Yes', portalSelector: 'input[name="travel_yes"]', portalInputType: 'radio' },
  ],
};

test('Taleo accepts only exact researched job detail routes with numeric identity', () => {
  const urls = [
    'https://fa007.taleo.net/careersection/ex/jobdetail.ftl?job=25000743&lang=en&src=tracking',
    'https://aa270.taleo.net/careersection/ex/jobdetail.ftl?job=827258&tz=GMT',
  ];
  for (const url of urls) assert.equal(detectPortal(url), 'oracle_taleo');
  assert.equal(canonicalSupportedPortalUrl(urls[1]), 'https://aa270.taleo.net/careersection/ex/jobdetail.ftl?job=827258&lang=en');
  assert.throws(() => detectPortal('https://aa270.taleo.net/careersection/ex/jobsearch.ftl?lang=en'));
  assert.throws(() => detectPortal('https://aa270.taleo.net/careersection/admin/jobdetail.ftl?job=827258'));
  assert.throws(() => detectPortal('https://aa270.taleo.net/other/ex/jobdetail.ftl?job=827258'));
  assert.throws(() => detectPortal('https://aa270.taleo.net/careersection/ex/application.ftl?job=827258'));
  assert.throws(() => detectPortal('https://aa271.taleo.net/careersection/ex/jobdetail.ftl?job=827258'));
  assert.throws(() => detectPortal('https://aa270.taleo.net/careersection/ex/jobdetail.ftl?job=not-a-job'));
});

test('ADP Recruiting accepts only exact researched tenant paths and numeric requisitions', () => {
  const guitar = 'https://myjobs.adp.com/guitarcenterexternal/cx/job-details?reqId=5001217533500&utm_source=test';
  const kaiser = 'https://myjobs.adp.com/kaisercareers/cx/job-details?reqId=5001215578500';
  assert.equal(detectPortal(guitar), 'adp_recruiting');
  assert.equal(detectPortal(kaiser), 'adp_recruiting');
  assert.equal(canonicalSupportedPortalUrl(guitar), 'https://myjobs.adp.com/guitarcenterexternal/cx/job-details?reqId=5001217533500');
  assert.throws(() => detectPortal('https://myjobs.adp.com/guitarcenterexternal/auth'));
  assert.throws(() => detectPortal('https://myjobs.adp.com/unresearched/cx/job-details?reqId=5001217533500'));
  assert.throws(() => detectPortal('https://myjobs.adp.com/kaisercareers/cx/job-details?reqId=abc'));
});

test('Taleo and ADP account or legal walls are structurally zero-action', async () => {
  for (const family of ['oracle_taleo', 'adp_recruiting'] as const) {
    assert.deepEqual(buildManagedPortalActions(family, packet, true), []);
    assert.equal(portalMayResolveUnknownRequired(family), false);
    const untouched = new Proxy({}, { get: () => { throw new Error(`${family} direct runner touched the gate`); } }) as Page;
    assert.deepEqual(await fillPortal(untouched, family, packet), {
      filledFields: [],
      blockers: [portalHandoffReason(family)!],
    });
  }
});

test('JazzHR fills only exact factual controls and never replays packet questions', () => {
  assert.equal(detectPortal('https://utilidata.applytojob.com/apply/jobs/details/VSeisrJblO?source=test'), 'jazzhr');
  assert.equal(detectPortal('https://foundationai.applytojob.com/apply/jobs/details/ZBfHaf2Nv9'), 'jazzhr');
  assert.equal(canonicalSupportedPortalUrl('https://utilidata.applytojob.com/apply/jobs/details/VSeisrJblO/?source=test'), 'https://utilidata.applytojob.com/apply/jobs/details/VSeisrJblO');
  /* ANY TENANT, deliberately, and the two-tenant pin this replaces was rejecting every JazzHR
     posting a student could actually find: all five in the 2026-08-19 survey of 562 live 2027
     internship postings sit on tenants that were not the two pinned ones. Widening is bounded by
     something stronger than a host list - jazzhr is CAPTCHA_GATED, so portalCanAutoSubmit is false
     for every tenant that matches here and no widening can produce an unattended send. */
  assert.equal(detectPortal('https://blackcape.applytojob.com/apply/7o6mmAYryt/Software-Engineer'), 'jazzhr');
  assert.equal(detectPortal('https://prospectequities.applytojob.com/apply/XTbzSAcNtg'), 'jazzhr');
  assert.equal(portalCanAutoSubmit('jazzhr'), false, 'a widened host must never gain an unattended send');

  /* The DIRECT APPLY shape, which is the one every real posting used and which the single-shape
     rule rejected even once the host matched. */
  assert.equal(detectPortal('https://utilidata.applytojob.com/apply/VSeisrJblO/engineer'), 'jazzhr');

  // The 10-character code is what keeps this narrow, and the path rule still does the real work.
  assert.throws(() => detectPortal('https://utilidata.applytojob.com/apply/jobs'));
  assert.throws(() => detectPortal('https://utilidata.applytojob.com/apply'));
  assert.throws(() => detectPortal('https://utilidata.applytojob.com/careers/VSeisrJblO'));
  // www is JazzHR's own marketing site and has no application on it.
  assert.throws(() => detectPortal('https://www.applytojob.com/apply/VSeisrJblO/engineer'));
  // The detail route stays EXACT: an extra segment after the code is still not a posting.
  assert.throws(() => detectPortal('https://utilidata.applytojob.com/apply/jobs/details/VSeisrJblO/engineer'));
  const actions = buildManagedPortalActions('jazzhr', packet, true);
  assert.deepEqual(actions.filter((action) => action.type === 'fill').map((action) => action.selector), [
    'input[name="resumator-firstname-value"]',
    'input[name="resumator-lastname-value"]',
    'input[name="resumator-email-value"]',
    'input[name="resumator-phone-value"]',
    'input[name="resumator-city-value"]',
    'input[name="resumator-linkedin-value"]',
  ]);
  assert.ok(actions.some((action) => action.type === 'upload' && action.selector === 'input[type="file"][name="resumator-resume-value"]'));
  assert.equal(actions.some((action) => /bio|color|travel/i.test(`${action.selector ?? ''} ${action.label ?? ''}`)), false);
  assert.equal(actions.some((action) => action.type === 'click' || action.type === 'fillByLabelText'), false);
  assert.equal(portalMayResolveUnknownRequired('jazzhr'), false);
});

test('all three families default deny submit and polling', () => {
  for (const family of ['oracle_taleo', 'adp_recruiting', 'jazzhr'] as const) {
    const capability = browserApplicationCapability(family);
    assert.equal(capability.programmaticSubmit, false);
    assert.equal(capability.pollPublicListings, false);
    assert.equal(capability.trustedDirectClick, true);
    assert.equal(portalCanAutoSubmit(family), false);
  }
});
