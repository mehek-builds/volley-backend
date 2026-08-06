import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import type { Page } from 'playwright-core';
import {
  AUTONOMOUS_PORTAL_FAMILIES,
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  canFillReviewedQuestions,
  canonicalSupportedPortalUrl,
  coverLetterUploadSelector,
  detectPortal,
  fillPortal,
  isAccountWalledFamily,
  isAutonomousPortalFamily,
  isChoiceQuestion,
  isPaylocityTerminalStep,
  managedResultHasCoverLetterUpload,
  portalApplicationUrl,
  portalCanAutoSubmit,
  portalHandoffReason,
  readManagedReceipt,
  chooseSubmitControl,
  READ_CONTROL_LABEL,
} from './portalSubmission';
import { POLLABLE_JOB_BOARDS } from './jobMonitor';

function isGreenhousePreflightClick(action: { type: string; label?: string }) {
  return action.type === 'click'
    && (action.label?.startsWith('greenhouse_cookie_preflight:') === true
      || action.label === 'greenhouse_open_application_form');
}

test('detects the four supported applicant portal families', () => {
  assert.equal(detectPortal('https://boards.greenhouse.io/acme/jobs/123'), 'greenhouse');
  assert.equal(detectPortal('https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002'), 'greenhouse');
  assert.equal(detectPortal('https://www.databricks.com/company/careers/product/product-management-intern-summer-2027-6883068002?gh_jid=6883068002'), 'greenhouse');
  assert.equal(detectPortal('https://jobs.lever.co/acme/123/apply'), 'lever');
  assert.equal(detectPortal('https://jobs.ashbyhq.com/acme/123/application'), 'ashby');
  assert.equal(detectPortal('https://jobs.smartrecruiters.com/Acme/744000-role'), 'smartrecruiters');
});

test('a managed discovery run detects custom questions and cover-letter attachment capability without submitting', () => {
  // R-055 on the managed path: this cheap first call exists only to get the page's custom
  // questions back (stratus-browser-cloud PR #7). It reuses the same fixed-field fills (including
  // the resume upload - harmless and idempotent, the real run below fills them again) but must
  // never send reviewed-question answers or click submit, since nothing has been resolved yet.
  const actions = buildManagedDiscoveryActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: 'Why this role?', answer: 'I enjoy systems work.' }],
  });
  assert.equal(actions.at(-2)?.type, 'discover');
  assert.deepEqual(actions.at(-1), {
    type: 'extract',
    selector: coverLetterUploadSelector('greenhouse'),
    attribute: 'type',
    label: 'cover_letter_capability',
    optional: true,
    timeout: 10_000,
  });
  assert.equal(actions.some((a) => a.type === 'fillByLabelText' && a.label?.startsWith('question:')), false);
  assert.equal(actions.some((a) => a.type === 'click' && !isGreenhousePreflightClick(a)), false);
  const fillSelectors = actions.filter((a) => a.type === 'fill').map((a) => a.selector);
  assert.ok(fillSelectors.some((s) => s?.includes('first_name')));
  assert.equal(actions.some((a) => a.type === 'fillByLabelText' && a.label === 'first_name_label'), true);
});

test('Databricks wrapper URLs use the Greenhouse managed flow without submitting during discovery', () => {
  const databricksUrl = 'https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002';
  const canonical = 'https://boards.greenhouse.io/embed/job_app?token=6883068002';
  assert.equal(detectPortal(databricksUrl), 'greenhouse');
  assert.equal(canonicalSupportedPortalUrl(databricksUrl, 'greenhouse'), canonical);
  assert.equal(portalApplicationUrl('greenhouse', canonical), canonical);

  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  const discovery = buildManagedDiscoveryActions('greenhouse', packet);
  assert.equal(discovery.some((action) => action.type === 'click' && action.selector === 'button[type="submit"], input[type="submit"]'), false);
  assert.ok(discovery.some((action) => action.type === 'fill' && action.selector?.includes('first_name')));
  assert.ok(discovery.some((action) => action.type === 'upload'));

  const submitting = buildManagedPortalActions('greenhouse', packet, true);
  assert.equal(
    submitting.filter((action) => action.type === 'click' && action.selector === 'button[type="submit"], input[type="submit"]').length,
    1,
  );
  assert.ok(submitting.every((action) => action.type !== 'fill' || (action.timeout ?? Infinity) < 30_000));
  assert.ok(submitting.every((action) => action.type !== 'upload' || (action.timeout ?? Infinity) < 30_000));
});

test('managed cover-letter detection requires an actual file input extraction', () => {
  const selector = coverLetterUploadSelector('greenhouse');
  assert.equal(managedResultHasCoverLetterUpload({ title: 'Apply', url: 'https://example.com', text: 'Cover letter is optional', extracted: [{ selector, value: 'file' }] }, 'greenhouse'), true);
  assert.equal(managedResultHasCoverLetterUpload({ title: 'Apply', url: 'https://example.com', text: 'Cover letter is optional', extracted: [{ selector: '#resume', value: 'file' }] }, 'greenhouse'), false);
  assert.equal(managedResultHasCoverLetterUpload({ title: 'Apply', url: 'https://example.com', text: 'Cover letter is optional', extracted: [] }, 'greenhouse'), false);
  assert.equal(managedResultHasCoverLetterUpload(null, 'greenhouse'), false);
});

test('every portal detects a cover-letter file control, not optional wording alone', () => {
  for (const portal of ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'controlled_test'] as const) {
    const selector = coverLetterUploadSelector(portal);
    assert.match(selector, /type="file"/);
    assert.match(selector, /cover/i);
  }
});

test('SmartRecruiters managed actions open the application form before filling', () => {
  const actions = buildManagedPortalActions('smartrecruiters', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  // The JD page and the actual form are different URLs on SmartRecruiters (confirmed live,
  // 2026-07-24) - the first action must be the optional, bounded click that opens the form, so a
  // run started on the JD page still reaches the fields below it.
  assert.equal(actions[0].type, 'click');
  assert.equal(actions[0].optional, true);
  const fillSelectors = actions.filter((a) => a.type === 'fill').map((a) => a.selector);
  assert.ok(fillSelectors.includes('spl-input#first-name-input input'));
  assert.ok(fillSelectors.includes('spl-input#email-input input'));
  assert.ok(fillSelectors.includes('spl-input#confirm-email-input input'));
  assert.equal(fillSelectors.some((selector) => selector?.includes('[id="first-name-input"]')), false);
});

test('opens Ashby directly on its application tab for managed filling', () => {
  const databricksUrl = 'https://databricks.com/company/careers/open-positions/job?gh_jid=6883068002';
  const canonical = 'https://boards.greenhouse.io/embed/job_app?token=6883068002';
  assert.equal(detectPortal(databricksUrl), 'greenhouse');
  assert.equal(canonicalSupportedPortalUrl(databricksUrl, 'greenhouse'), canonical);
  assert.equal(portalApplicationUrl('greenhouse', canonical), canonical);
  assert.equal(
    portalApplicationUrl('ashby', 'https://jobs.ashbyhq.com/acme/123'),
    'https://jobs.ashbyhq.com/acme/123/application',
  );
  assert.equal(
    portalApplicationUrl('ashby', 'https://jobs.ashbyhq.com/acme/123/application'),
    'https://jobs.ashbyhq.com/acme/123/application',
  );
  assert.equal(
    portalApplicationUrl('lever', 'https://jobs.lever.co/acme/123/apply'),
    'https://jobs.lever.co/acme/123/apply',
  );
});

test('rejects insecure and lookalike portal URLs', () => {
  assert.throws(() => detectPortal('http://boards.greenhouse.io/acme/jobs/123'), /secure link/);
  assert.throws(() => detectPortal('https://databricks.com/company/careers/open-positions/job'), /cannot fill in/);
  assert.throws(() => detectPortal('https://databricks.com/company/careers/open-positions/job?gh_jid=abc'), /cannot fill in/);
  assert.throws(() => detectPortal('https://databricks.com/company/careers/open-positions?gh_jid=6883068002'), /cannot fill in/);
  assert.throws(() => detectPortal('https://www.databricks.com/company/careers/product/product-management-intern-summer-2027-111?gh_jid=6883068002'), /cannot fill in/);
  assert.throws(() => detectPortal('https://www.fivetran.com/careers/job?gh_jid=1'), /cannot fill in/);
  assert.throws(() => detectPortal('https://nuro.ai/careers?gh_jid=4512345'), /cannot fill in/);
  assert.throws(() => detectPortal('https://greenhouse.io.attacker.example/acme'), /cannot fill in/);
  assert.throws(() => detectPortal('https://example.com/apply'), /cannot fill in/);
});

test('controlled portal is gated by an explicit server flag', () => {
  const previous = process.env.LITOS_ENABLE_TEST_PORTAL;
  delete process.env.LITOS_ENABLE_TEST_PORTAL;
  assert.throws(() => detectPortal('https://trylitos.com/qa/portal-submission'), /cannot fill in/);
  process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
  assert.equal(detectPortal('https://trylitos.com/qa/portal-submission'), 'controlled_test');
  assert.equal(detectPortal('http://localhost:3000/qa/portal-submission'), 'controlled_test');
  assert.equal(detectPortal('https://trylitos.com/qa/portal-submission?board=lever'), 'controlled_lever');
  assert.equal(detectPortal('https://trylitos.com/qa/portal-submission?board=ashby'), 'controlled_ashby');
  assert.equal(
    detectPortal('https://trylitos.com/qa/portal-submission?board=smartrecruiters'),
    'controlled_smartrecruiters',
  );
  assert.equal(detectPortal('https://trylitos.com/qa/portal-submission/lever/lever-02'), 'controlled_lever');
  assert.equal(detectPortal('https://trylitos.com/qa/portal-submission/ashby/ashby-03'), 'controlled_ashby');
  assert.equal(
    detectPortal('https://trylitos.com/qa/portal-submission/smartrecruiters/smartrecruiters-04'),
    'controlled_smartrecruiters',
  );
  if (previous === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
  else process.env.LITOS_ENABLE_TEST_PORTAL = previous;
});

test('controlled portal variants exercise every real adapter selector family', () => {
  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+1 213 555 0100',
    city: 'Los Angeles',
    linkedinUrl: 'https://linkedin.com/in/taylor',
    githubUrl: 'https://github.com/taylor',
    portfolioUrl: 'https://taylor.example',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  const selectors = new Map([
    ['controlled_test', '#first_name'],
    ['controlled_lever', 'input[name="name"]'],
    ['controlled_ashby', 'input[name="_systemfield_name"]'],
    ['controlled_smartrecruiters', '[id="first-name-input"]'],
  ] as const);
  for (const [portal, expected] of selectors) {
    const actions = buildManagedPortalActions(portal, packet, true);
    assert.ok(actions.some((action) => action.type === 'fill' && action.selector?.includes(expected)));
    // A submit click is appended only where the portal can actually finish. SmartRecruiters moved
    // out of that group on 2026-07-28: it was always step-one-only, and used to rely on the weaker
    // guarantee that clickFinalSubmit would find nothing to press. Once the jobs board started
    // deriving what to SHOW from portalCanAutoSubmit, a predicate that lied about SmartRecruiters
    // would have surfaced postings the student could never complete.
    assert.equal(
      actions.at(-1)?.type === 'click',
      portalCanAutoSubmit(portal),
      `${portal}: a submit click must appear if and only if the portal can finish alone`,
    );
  }
});

test('the jobs board may only source from portals Litos can finish alone', () => {
  // The guarantee behind "only surface jobs we can complete autonomously". POLLABLE_JOB_BOARDS is
  // constrained to AutonomousPortalFamily at compile time; this asserts the runtime lists agree, so
  // a widening that somehow slips past the type checker still fails here.
  for (const board of POLLABLE_JOB_BOARDS) {
    assert.equal(portalCanAutoSubmit(board), true, `${board} is polled but cannot finish alone`);
    assert.ok(isAutonomousPortalFamily(board), board);
  }
  // The portals that must never reach the board, and why.
  for (const blocked of ['smartrecruiters', 'jazzhr', 'paylocity'] as const) {
    assert.equal(portalCanAutoSubmit(blocked), false, blocked);
    assert.equal(isAutonomousPortalFamily(blocked), false, blocked);
    assert.equal((POLLABLE_JOB_BOARDS as readonly string[]).includes(blocked), false, blocked);
  }
  // Workable can finish alone and has a public-board fetcher, so it belongs on the jobs board.
  assert.equal(isAutonomousPortalFamily('workable'), true);
  assert.equal((POLLABLE_JOB_BOARDS as readonly string[]).includes('workable'), true);
});

test('managed controlled-portal actions include reviewed fields, resume upload, and final submit', () => {
  const actions = buildManagedPortalActions('controlled_test', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: 'Why this role?', answer: 'I enjoy systems work.' }],
  }, true);
  assert.deepEqual(
    actions
      .filter((action) => action.type !== 'select' && !isGreenhousePreflightClick(action))
      .map((action) => action.type),
    [
      'waitForSelector',
      'fill',
      'fillByLabelText',
      'fill',
      'fillByLabelText',
      'fill',
      'fillByLabelText',
      'upload',
      'fillByLabelText',
      'click',
    ],
  );
  assert.ok(actions.some((action) => action.type === 'select' && action.label?.startsWith('question_select:')));
  assert.equal(actions.find((action) => action.type === 'upload')?.file?.base64, 'cGRm');
});

test('managed portals upload a tailored cover letter without replacing the resume', () => {
  for (const portal of ['greenhouse', 'lever', 'ashby'] as const) {
    const actions = buildManagedPortalActions(portal, {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      resume: Buffer.from('resume-pdf'),
      resumeName: 'resume.pdf',
      coverLetter: Buffer.from('cover-pdf'),
      coverLetterName: 'cover-letter.pdf',
      questions: [],
    });
    const uploads = actions.filter((action) => action.type === 'upload');
    assert.deepEqual(uploads.map((action) => action.label), ['resume', 'cover_letter']);
    assert.equal(uploads[0]?.file?.name, 'resume.pdf');
    assert.equal(uploads[1]?.file?.name, 'cover-letter.pdf');
    assert.notEqual(uploads[0]?.selector, uploads[1]?.selector);
    if (portal === 'greenhouse') assert.doesNotMatch(uploads[1]?.selector ?? '', /(^|,\s*)#cover_letter/);
    if (portal === 'ashby') assert.doesNotMatch(uploads[0]?.selector ?? '', /cover/i);
  }
});

test('Ashby targets its real resume and optional cover-letter input ids', () => {
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    coverLetter: Buffer.from('cover-pdf'),
    coverLetterName: 'cover-letter.pdf',
    questions: [],
  });
  const uploads = actions.filter((action) => action.type === 'upload');
  assert.match(uploads[0]?.selector ?? '', /#_systemfield_resume/);
  assert.doesNotMatch(uploads[0]?.selector ?? '', /input\[type="file"\]$/);
  assert.match(uploads[1]?.selector ?? '', /#cover_letter/);
  assert.match(coverLetterUploadSelector('ashby'), /#cover_letter/);
});

test('Ashby targets live phone and label-bound profile fields', () => {
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '5550100000',
    linkedinUrl: 'https://linkedin.com/in/taylor-example',
    portfolioUrl: 'https://example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const fills = actions.filter((action) => action.type === 'fill');
  assert.match(fills.find((action) => action.label === 'phone')?.selector ?? '', /#phone/);
  assert.match(fills.find((action) => action.label === 'linkedin')?.selector ?? '', /LinkedIn Profile/);
  assert.match(fills.find((action) => action.label === 'portfolio')?.selector ?? '', /Website/);
});

test('phone fills recognize safe semantic phone controls without matching prose text inputs', () => {
  // Regression: ISSUE-001, live Deepgram and CTC forms left Phone empty even though the saved
  // profile contained a value. Those forms expose the control through type, autocomplete, or its
  // visible phone label instead of the small set of exact ids and names previously recognized.
  // Found by /qa on 2026-07-25.
  // Report: outputs/litos-10-application-trials-2026-07-25.md
  for (const portal of ['greenhouse', 'ashby'] as const) {
    const actions = buildManagedPortalActions(portal, {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      phone: '+971 50 123 4567',
      resume: Buffer.from('resume-pdf'),
      resumeName: 'resume.pdf',
      questions: [],
    });
    const selector = actions.find((action) => action.type === 'fill' && action.label === 'phone')?.selector ?? '';
    assert.match(selector, /input\[type="tel"/);
    assert.match(selector, /autocomplete\*="tel"/);
    assert.match(selector, /Phone/);
    assert.doesNotMatch(selector, /input\[type="text"\](?:,|$)/);
  }
});

test('Rippling phone widget receives only the national number', () => {
  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  const value = buildManagedPortalActions('rippling', packet)
    .find((action) => action.type === 'fill' && action.label === 'phone')?.value;
  assert.equal(value, '567417451');
});

test('single phone-input portals keep the saved international phone value', () => {
  const packet = {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };
  for (const portal of ['greenhouse', 'ashby', 'smartrecruiters', 'lever'] as const) {
    const value = buildManagedPortalActions(portal, packet)
      .find((action) => action.type === 'fill' && action.label === 'phone')?.value;
    assert.equal(value, '+971 567417451', portal);
  }
});

test('Greenhouse managed fill selects phone country and city comboboxes', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 50 123 4567',
    city: 'Dubai',
    country: 'United Arab Emirates',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const phoneCountryIndex = actions.findIndex((action) => action.label === 'phone_country');
  assert.ok(phoneCountryIndex >= 0);
  assert.deepEqual(actions.slice(phoneCountryIndex, phoneCountryIndex + 2), [
    {
      type: 'fill',
      selector: '#country',
      value: 'United Arab Emirates',
      label: 'phone_country',
      optional: true,
      timeout: 10_000,
    },
    {
      type: 'press',
      selector: '#country',
      value: 'Enter',
      label: 'phone_country_select',
      optional: true,
      timeout: 10_000,
    },
  ]);

  const locationIndex = actions.findIndex((action) => action.label === 'location');
  assert.ok(locationIndex >= 0);
  assert.deepEqual(actions.slice(locationIndex, locationIndex + 2), [
    {
      type: 'fill',
      selector: '#candidate-location, input[autocomplete="address-level2"]',
      value: 'Dubai, United Arab Emirates',
      label: 'location',
      optional: true,
      timeout: 10_000,
    },
    {
      type: 'press',
      selector: '#candidate-location, input[autocomplete="address-level2"]',
      value: 'Enter',
      label: 'location_select',
      optional: true,
      timeout: 10_000,
    },
  ]);
});

function directFillPage(selectors: string[]) {
  const values = new Map<string, string>();
  const makeLocator = (selector: string, index?: number): any => {
    const present = selectors.includes(selector);
    return {
      first: () => makeLocator(selector, 0),
      nth: (nextIndex: number) => makeLocator(selector, nextIndex),
      count: async () => (present ? 1 : 0),
      isVisible: async () => present,
      fill: async (value: string) => {
        if (present) values.set(selector, value);
      },
      press: async (key: string) => {
        if (present) values.set(`${selector}::press`, key);
      },
      selectOption: async (option: string | { label?: string }) => {
        if (!present) return [];
        const value = typeof option === 'string' ? option : option.label;
        if (!value) return [];
        values.set(selector, value);
        return [value];
      },
      getAttribute: async () => null,
      inputValue: async () => values.get(selector) ?? '',
      locator: () => makeLocator(`${selector} child`, 0),
      evaluate: async () => false,
      waitFor: async () => undefined,
      click: async () => undefined,
    };
  };
  const page = {
    values,
    page: {
      locator: (selector: string) => makeLocator(selector),
      getByText: () => makeLocator('missing text'),
    } as unknown as Page,
  };
  return page;
}

test('direct Rippling fill writes only the national phone number', async () => {
  const { page, values } = directFillPage([
    '[data-testid="input-first_name"]',
    '[data-testid="input-last_name"]',
    '[data-testid="input-email"]',
    '[data-testid="input-phone_number"]',
  ]);
  await fillPortal(page, 'rippling', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(values.get('[data-testid="input-phone_number"]'), '567417451');
});

test('direct single phone-input fill keeps the saved international phone value', async () => {
  const { page, values } = directFillPage(['input[name="name"]', 'input[name="email"]', 'input[name="phone"]']);
  await fillPortal(page, 'lever', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 567417451',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(values.get('input[name="phone"]'), '+971 567417451');
});

test('direct Greenhouse fill confirms phone country and city comboboxes', async () => {
  const { page, values } = directFillPage([
    '#first_name',
    '#last_name',
    '#email',
    '#country',
    '#phone',
    '#candidate-location',
  ]);
  await fillPortal(page, 'greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+971 50 123 4567',
    city: 'Dubai',
    country: 'United Arab Emirates',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(values.get('#country'), 'United Arab Emirates');
  assert.equal(values.get('#country::press'), 'Enter');
  assert.equal(values.get('#phone'), '+971 50 123 4567');
  assert.equal(values.get('#candidate-location'), 'Dubai, United Arab Emirates');
  assert.equal(values.get('#candidate-location::press'), 'Enter');
});

test('direct Greenhouse fill selects saved demographic choices', async () => {
  const genderSelector = '.field:has(label:has-text("What gender identity do you most closely identify with?")) select';
  const orientationSelector = '.field:has(label:has-text("What sexual orientation do you most closely identify with?")) select';
  const raceSelector = '.field:has(label:has-text("Please select up to 2 ethnicities that you most closely identify with.")) select';
  const { page, values } = directFillPage([
    genderSelector,
    orientationSelector,
    raceSelector,
  ]);
  await fillPortal(page, 'greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'resume.pdf',
    eeoPrefs: {
      gender: 'Female',
      sexual_orientation: 'Heterosexual',
      race: 'White',
    },
    questions: [],
  });
  assert.equal(values.get(genderSelector), 'Female');
  assert.equal(values.get(orientationSelector), 'Heterosexual');
  assert.equal(values.get(raceSelector), 'White');
});

test('managed receipt requires confirmation language and captures the reference', () => {
  assert.deepEqual(readManagedReceipt({
    title: 'Complete',
    url: 'https://trylitos.com/qa/portal-submission?complete=1',
    text: 'Thank you. Application reference: LITOS-QA-2027',
  }), {
    confirmationText: 'Thank you. Application reference: LITOS-QA-2027',
    finalUrl: 'https://trylitos.com/qa/portal-submission?complete=1',
    referenceId: 'LITOS-QA-2027',
  });
  assert.throws(() => readManagedReceipt({ title: 'Form', url: 'https://example.com', text: 'Apply now' }), /confirmation we could check/);
});

test('choice-shaped questions are recognised by their wording', () => {
  for (const q of [
    'Please select all fields of study that closely align with your education background',
    'Have you completed any internships?',
    'Do you have any outstanding offers or deadlines?',
    'Will you require sponsorship?',
    'Are you legally eligible to work in the United States?',
    'What year are you expected to graduate?',
    'Which of the following best describes you?',
  ]) {
    assert.equal(isChoiceQuestion(q), true, `"${q}" should be treated as a choice control`);
  }
});

test('genuinely free-text questions are still typed', () => {
  for (const q of [
    'What are your annualized total compensation expectations?',
    'What is your Github username?',
    'Why do you want to work here?',
    'Tell us about a project you are proud of',
    'Current Location',
  ]) {
    assert.equal(isChoiceQuestion(q), false, `"${q}" should still be filled`);
  }
});

test('a question that cannot be typed degrades to a blocker instead of killing the run', () => {
  // Live failure on Aquatic's Greenhouse form, 2026-07-23: "Please select all fields of study" is
  // a checkbox group, Playwright's fill() cannot fill a checkbox, and because the question action
  // was not optional the whole run ended `failed` with a raw Playwright stack trace, discarding
  // the name, email, phone and resume it had already entered successfully.
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'Please select all fields of study', answer: 'Computer Science' },
      { question: 'What are your annualized total compensation expectations?', answer: 'USD 175,000 per year' },
    ],
  });
  // Both questions are sent now that the runner dispatches on control type (stratus PR #6), and
  // both stay optional so a control it still cannot handle degrades to a blocker rather than
  // taking the whole run down and discarding the fields already filled.
  const questionActions = actions.filter((action) => action.type === 'fillByLabelText' && action.label?.startsWith('question:'));
  assert.equal(questionActions.length, 2);
  for (const action of questionActions) {
    assert.equal(action.optional, true, `"${action.text}" must not be able to abort the run`);
  }
  // first_name, last_name, email (phone and location are omitted from this fixture), resume, then
  // the two optional reviewed questions.
  assert.deepEqual(
    actions
      .filter((a) => a.type !== 'select' && !isGreenhousePreflightClick(a))
      .map((a) => a.type),
    [
      'waitForSelector',
      'fill',
      'fillByLabelText',
      'fill',
      'fillByLabelText',
      'fill',
      'fillByLabelText',
      'upload',
      'fillByLabelText',
      'fillByLabelText',
    ],
  );
  assert.ok(actions.some((a) => a.type === 'select' && a.label?.startsWith('question_select:')));
});

test('managed Greenhouse question fills prefer rediscovered selectors over label text', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Please indicate your overall GPA.',
        answer: '3.89',
        portalSelector: 'textarea[name="job_application[answers_attributes][0][text_value]"]',
      },
    ],
  });
  const questionAction = actions.find((action) => action.label === 'question:Please indicate your overall GPA.');
  assert.equal(questionAction?.type, 'fill');
  assert.equal(questionAction?.selector, 'textarea[name="job_application[answers_attributes][0][text_value]"]');
  assert.equal(questionAction?.value, '3.89');
  assert.equal(actions.some((action) => action.type === 'fillByLabelText' && action.text === 'Please indicate your overall GPA.'), false);
});

test('managed Greenhouse academic questions confirm rediscovered autocomplete selectors', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'School',
        answer: 'University of Southern California',
        portalSelector: 'input[name="job_application[educations_attributes][0][school_name_id]"]',
      },
      {
        question: 'Degree',
        answer: 'Bachelor of Science in Computer Science',
        portalSelector: 'input[name="job_application[educations_attributes][0][degree_id]"]',
      },
    ],
  });

  assert.ok(actions.some((action) => action.type === 'press' && action.label === 'question_confirm:School' && action.value === 'Enter'));
  assert.ok(actions.some((action) => action.type === 'press' && action.label === 'question_confirm:Degree' && action.value === 'Enter'));
});

test('managed question fills fall back to label text when a discovered selector exceeds the provider limit', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Please indicate your overall GPA.',
        answer: '3.89',
        portalSelector: `textarea[name="${'x'.repeat(501)}"]`,
      },
    ],
  });
  const questionAction = actions.find((action) => action.label === 'question:Please indicate your overall GPA.');
  assert.equal(questionAction?.type, 'fillByLabelText');
  assert.equal(questionAction?.text, 'Please indicate your overall GPA.');
  assert.equal(questionAction?.value, '3.89');
});

test('managed question actions skip empty labels and cap long discovered text', () => {
  const longLabel = `Why Samsara? ${'Describe a systems project you are proud of '.repeat(30)}`;
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'required field', answer: 'ignored' },
      { question: '56f41b98-0250-4e12-a2d1-aa038a33af27', answer: 'ignored' },
      { question: longLabel, answer: 'I built a reliable workflow system.' },
    ],
  });
  const questionActions = actions.filter((action) => action.type === 'fillByLabelText' && action.label?.startsWith('question:'));
  assert.equal(questionActions.length, 1);
  const [questionAction] = questionActions;
  assert.ok(questionAction);
  assert.ok((questionAction.text ?? '').length <= 500);
  assert.equal(longLabel.toLowerCase().startsWith((questionAction.text ?? '').toLowerCase()), true);
});

test('managed paylocity traversal also sends provider-safe reviewed question text', () => {
  const longLabel = `Why this program? ${'Share one relevant implementation detail '.repeat(30)}`;
  const actions = buildManagedPortalActions('paylocity', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: longLabel, answer: 'I like applied engineering work.' }],
  }, true);
  const questionActions = actions.filter((action) => action.type === 'fillByLabelText');
  assert.ok(questionActions.length > 1);
  for (const action of questionActions) {
    const text = action.text ?? '';
    assert.ok(text.length <= 500);
    assert.equal(longLabel.toLowerCase().startsWith(text.toLowerCase()), true);
  }
});

test('the Ashby branch fills LinkedIn, GitHub, and portfolio from the packet', () => {
  // Live regression, 2026-07-24: a real Ashby run reported "'LinkedIn Profile' is required and is
  // still empty" even though the account's profile had linkedin_url set, because this branch had no
  // URL fills at all (the Lever branch did). It must now emit them when the packet carries them.
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    phone: '+1 555 0100',
    city: 'Los Angeles',
    linkedinUrl: 'https://www.linkedin.com/in/taylor',
    githubUrl: 'https://github.com/taylor',
    portfolioUrl: 'https://taylor.dev',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const filledLabels = actions.filter((a) => a.type === 'fill').map((a) => a.label);
  assert.ok(filledLabels.includes('linkedin'), 'Ashby must fill LinkedIn when the packet has it');
  assert.ok(filledLabels.includes('github'), 'Ashby must fill GitHub when the packet has it');
  assert.ok(filledLabels.includes('portfolio'), 'Ashby must fill portfolio when the packet has it');
  // The URL selectors are substring/attribute matches so they find Ashby's custom UUID-named fields.
  const linkedin = actions.find((a) => a.label === 'linkedin');
  assert.match(linkedin?.selector ?? '', /linkedin/i);
});

test('the Ashby branch omits URL fills the packet does not carry', () => {
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const filledLabels = actions.filter((a) => a.type === 'fill').map((a) => a.label);
  assert.ok(!filledLabels.includes('linkedin'));
  assert.ok(!filledLabels.includes('github'));
  assert.ok(!filledLabels.includes('portfolio'));
});

test('Ashby reviewed essay questions retry nearby textareas when labels are not associated', () => {
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: "Tell us about something you've built that you're proud of. What was hard about it?",
        answer: 'I built a fast evaluation harness for AI agents.',
      },
    ],
  });

  assert.ok(actions.some((action) =>
    action.type === 'fillByLabelText'
    && action.text === "Tell us about something you've built that you're proud of. What was hard about it?",
  ));
  const fallbacks = actions.filter((action) => action.label?.startsWith('question_text:'));
  assert.ok(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text')));
  assert.ok(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('/parent::*/parent::*[not(self::form)')));
  assert.ok(fallbacks.some((action) => action.type === 'fill' && action.selector?.startsWith('xpath=')));
  assert.equal(fallbacks.length, 9);
  assert.equal(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('following::')), false);
  assert.equal(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('ancestor::')), false);
  assert.ok(fallbacks.every((action) => action.value === 'I built a fast evaluation harness for AI agents.'));
  assert.ok(fallbacks.every((action) => action.optional === true));
});

test('Ashby nested-label textarea fallback stays scoped to its question container', () => {
  const markup = `
    <form>
      <div class="question">
        <div><label>First essay prompt</label></div>
        <div><textarea id="first"></textarea></div>
      </div>
      <div class="question">
        <div><label>Second essay prompt</label></div>
        <div><textarea id="second"></textarea></div>
      </div>
    </form>
  `;

  assert.equal(nearestNonFormTextareaId(markup, 'First essay prompt'), 'first');
  assert.equal(nearestNonFormTextareaId(markup, 'Second essay prompt'), 'second');

  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'First essay prompt', answer: 'First answer' },
      { question: 'Second essay prompt', answer: 'Second answer' },
    ],
  });
  const xpaths = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_text:') && action.selector?.startsWith('xpath='))
    .map((action) => action.selector ?? '');
  assert.ok(xpaths.some((selector) => selector.includes('First essay prompt') && selector.includes('/parent::*/parent::*[not(self::form)')));
  assert.ok(xpaths.some((selector) => selector.includes('Second essay prompt') && selector.includes('/parent::*/parent::*[not(self::form)')));
  assert.equal(xpaths.some((selector) => selector.includes('following::') || selector.includes('ancestor::')), false);
  assert.equal(xpaths.every((selector) => selector.includes('[not(self::form)')), true);
});

test('Ashby long reviewed questions retry the visible prompt stem inside the same fallback budget', () => {
  const question = 'What is the most impressive thing you’ve personally built or automated with AI? Describe exactly what you did, how it worked, and why it mattered.';
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question,
        answer: 'I built a fast evaluation harness for AI agents.',
      },
    ],
  });

  const fallbacks = actions.filter((action) => action.label?.startsWith('question_text:'));
  assert.equal(fallbacks.length, 9);
  assert.ok(fallbacks.some((action) =>
    action.type === 'fill'
    && action.selector?.includes('What is the most impressive thing you’ve personally built or automated with AI?')
    && !action.selector.includes('Describe exactly what you did')));
  assert.ok(fallbacks.some((action) =>
    action.type === 'fill'
    && action.selector?.startsWith('xpath=')
    && action.selector.includes('What is the most impressive thing you’ve personally built or automated with AI?')));
  assert.ok(fallbacks.some((action) =>
    action.type === 'fill'
    && action.selector?.includes('What is the most impressive thing you’ve personally built or automated with AI?')
    && action.selector.includes('/parent::*/parent::*[not(self::form)')));
  assert.ok(fallbacks.some((action) =>
    action.type === 'fill'
    && action.selector?.includes('What is the most impressive thing you’ve personally built or automated with AI?')
    && action.selector.includes('/parent::*/parent::*/parent::*[not(self::form)')));
  assert.equal(fallbacks.some((action) => action.type === 'fill' && action.selector?.includes('following::')), false);
  assert.ok(fallbacks.every((action) => action.value === 'I built a fast evaluation harness for AI agents.'));
});

test('Ashby reviewed essay packet stays inside the Stratus action budget', () => {
  const questions = Array.from({ length: 10 }, (_, index) => ({
    question: `Essay prompt ${index + 1}`,
    answer: `Answer ${index + 1}`,
  }));
  const actions = buildManagedPortalActions('ashby', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    linkedinUrl: 'https://www.linkedin.com/in/mehekmandal/',
    githubUrl: 'https://github.com/mehek-builds',
    portfolioUrl: 'https://github.com/mehek-builds',
    resume: Buffer.from('pdf'),
    resumeName: 'Mehek_Mandal_Engineering_Intern_Resume.pdf',
    questions,
  }, true);

  assert.ok(actions.every((action) => (action.selector?.length ?? 0) <= 500));
  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
});

function nearestNonFormTextareaId(markup: string, labelText: string): string | undefined {
  const doc = new DOMParser().parseFromString(markup, 'text/html');
  const labels = Array.from(doc.getElementsByTagName('label'));
  const label = labels.find((candidate) => candidate.textContent?.replace(/\s+/g, ' ').trim() === labelText);
  let node = label?.parentNode as any;
  while (node && String(node.nodeName).toLowerCase() !== 'form') {
    const textareas = typeof node.getElementsByTagName === 'function'
      ? Array.from(node.getElementsByTagName('textarea') as ArrayLike<any>)
      : [];
    const id = textareas[0]?.getAttribute?.('id');
    if (id) return id;
    node = node.parentNode;
  }
  return undefined;
}

test('Greenhouse core identity fields degrade gracefully instead of a 30s hard timeout', () => {
  // Live regression, 2026-07-24: Jump Trading serves its Greenhouse posting through a branded
  // redirect whose form lacks the classic `job_application[...]` selectors, so a required fill on
  // first_name waited the full 30s Playwright default and then aborted the whole run. These fills
  // must now be optional (a miss becomes a required-field blocker) and time-bounded (well under 30s).
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  for (const label of ['first_name', 'last_name', 'email']) {
    const action = actions.find((a) => a.label === label);
    assert.equal(action?.optional, true, `${label} must not be able to abort the run on a selector miss`);
    assert.ok((action?.timeout ?? Infinity) < 30_000, `${label} must be bounded under the 30s default`);
  }
});

test('Greenhouse fills academic fields from the submission packet', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    major: 'Computer Science',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const byLabel = actions.filter(
    (action) =>
      action.type === 'fillByLabelText'
      && action.label?.startsWith('first_name') !== true
      && action.label?.startsWith('last_name') !== true
      && action.label?.startsWith('email') !== true,
  );
  assert.deepEqual(
    byLabel.map((action) => [action.text, action.value, action.label]),
    [
      ['What is your graduation date?', 'May 2028', 'graduation_date'],
      ['Graduation Date', 'May 2028', 'graduation_date_label'],
      ['Expected Graduation Date', 'May 2028', 'graduation_date_expected'],
      ['End date month', 'May', 'education_end_month'],
      ['End date year', '2028', 'education_end_year'],
      ['Graduation Month', 'May', 'education_graduation_month'],
      ['Graduation Year', '2028', 'education_graduation_year'],
      ['GPA', '3.89', 'gpa'],
      ['What is your GPA?', '3.89', 'gpa_question'],
    ],
  );
  assert.ok(byLabel.every((action) => action.optional === true));
  assert.ok(byLabel.every((action) => (action.timeout ?? Infinity) < 30_000));
  assert.equal(
    actions.some((action) => action.type === 'fillByLabelText' && action.text === 'Degree'),
    false,
  );
  assert.equal(
    actions.some((action) => action.type === 'fillByLabelText' && action.text === 'School'),
    false,
  );
  const comboFills = actions.filter((action) => action.type === 'fill' && action.label?.startsWith('education_'));
  assert.ok(comboFills.some((action) => action.selector === '#school--0' && action.value === 'University of Southern California'));
  assert.equal(comboFills[0]?.selector, '#school--0');
  assert.equal(comboFills[0]?.value, 'University of Southern California');
  assert.equal(comboFills.some((action) => action.selector?.includes('label:has-text("School")')), false);
  const schoolOpenIndex = actions.findIndex((action) => action.type === 'click' && action.selector === '#school--0');
  const schoolFillIndex = actions.findIndex((action) => action.type === 'fill' && action.selector === '#school--0');
  assert.ok(schoolOpenIndex >= 0);
  assert.ok(schoolFillIndex > schoolOpenIndex);
  assert.ok(comboFills.some((action) => action.selector === '#degree--0' && action.value === 'Bachelor\'s Degree'));
  assert.ok(comboFills.some((action) => action.selector === '#degree--0' && action.value === 'Bachelor of Science'));
  assert.ok(comboFills.some((action) => action.selector === '#degree--0' && action.value === 'Bachelor of Science in Computer Science'));
  assert.equal(comboFills.filter((action) => action.selector === '#degree--0').length, 3);
  assert.equal(comboFills.some((action) => action.selector === '#degree--0' && action.value === 'Bachelor\'s'), false);
  assert.equal(comboFills.some((action) => action.selector?.includes('label:has-text("Degree")')), false);
  assert.ok(comboFills.some((action) => action.selector === '#discipline--0' && action.value === 'Computer Science'));
  assert.ok(comboFills.some((action) => action.label?.startsWith('education_graduation_date_combo:') && action.value === 'May 2028'));
  assert.ok(actions.some((action) => action.type === 'click' && action.selector === '#react-select-school--0-option-0' && action.label?.startsWith('education_school_combo')));
  assert.ok(actions.some((action) => action.type === 'click' && action.selector === '#react-select-degree--0-option-0' && action.label?.startsWith('education_degree_combo')));
  assert.ok(actions.some((action) => action.type === 'click' && action.selector === '#react-select-discipline--0-option-0' && action.label?.startsWith('education_discipline_combo')));
  assert.ok(comboFills.some((action) => action.label?.startsWith('education_graduation_date_combo:') && action.value === 'Spring 2028'));
});

test('Greenhouse fixed education combobox questions are not replayed as reviewed text', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'school* school--0', answer: 'University of Southern California, Viterbi School of Engineering' },
      { question: 'degree* degree--0', answer: 'Bachelor\'s Degree' },
      { question: 'discipline* discipline--0', answer: 'Computer Science' },
    ],
  });

  const reviewedQuestionActions = actions.filter((action) => action.label?.startsWith('question:'));
  assert.equal(reviewedQuestionActions.length, 0);
  const schoolFills = actions.filter((action) => action.type === 'fill' && action.selector === '#school--0');
  assert.equal(schoolFills.length, 1);
  assert.equal(schoolFills[0]?.value, 'University of Southern California');
  assert.ok(actions.some((action) => action.label?.startsWith('education_school_combo:')));
  assert.ok(actions.some((action) => action.label?.startsWith('education_degree_combo:')));
  assert.ok(actions.some((action) => action.label?.startsWith('education_discipline_combo:')));
});

test('Greenhouse replays Faire option-style choices through React-select buckets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    city: 'Dubai',
    country: 'United Arab Emirates',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    coverLetter: Buffer.from('cover'),
    coverLetterName: 'cover-letter.pdf',
    referralSourceDefault: 'Company website',
    eeoPrefs: {
      gender: 'Female',
      transgender_status: 'Decline to self-identify',
      sexual_orientation: 'Heterosexual',
      disability_status: 'Decline to self-identify',
      veteran_status: 'Decline to self-identify',
      race: 'White',
    },
    questions: [
      { question: 'Which team opening are you most interested in?', answer: 'Search & Recommendation' },
      { question: 'Are you currently enrolled in a Masters or PhD program?', answer: 'No' },
      {
        question: 'If yes, please provide your program and expected graduation date.',
        answer: 'N/A, I am currently an undergraduate at USC Viterbi and expect to graduate in May 2028.',
      },
      { question: 'Do you currently reside in San Francisco?', answer: 'No' },
      { question: 'How familiar are you with Faire?', answer: 'Somewhat familiar' },
      { question: 'Do you identify as LGBTQIA+?', answer: 'No' },
      { question: 'Which category best describes you?', answer: 'White' },
      { question: 'Gender Identity', answer: 'Female' },
      { question: 'Veteran Status', answer: 'Decline to self-identify' },
      { question: 'Faire Candidate Privacy Policy acknowledgment', answer: 'Yes' },
    ],
  });

  const comboFills = actions.filter((action) =>
    action.type === 'fill'
    && action.label?.startsWith('question_combo_label:'));
  for (const value of [
    'Search & Recommendation',
    'No',
    'White',
    'Female',
    'Decline to self-identify',
  ]) {
    assert.ok(comboFills.some((action) => action.value === value), value);
  }
  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_referral_combo_label:')
    && action.value === 'Company website'));
  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_referral_combo_label:')
    && action.label.includes('How did you hear about us')
    && action.value === 'Company website'));
  assert.equal(actions.some((action) =>
    action.label?.startsWith('greenhouse_demographic:')
    && action.label.includes('Gender')), false);
  assert.equal(actions.some((action) =>
    action.label?.startsWith('greenhouse_demographic:')
    && action.label.includes('veteran')), false);
  assert.equal(comboFills.some((action) => action.label?.includes('Candidate Privacy Policy')), false);
  assert.equal(actions.some((action) => action.text === 'Faire Candidate Privacy Policy acknowledgment'), false);
  assert.ok(comboFills.every((action) => (action.selector?.length ?? Infinity) <= 500));
  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
});

test('Greenhouse demographic aliases keep race fallback for unrelated category questions', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    eeoPrefs: {
      race: 'White',
    },
    questions: [
      { question: 'Which product category are you most interested in?', answer: 'Search' },
    ],
  });

  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_demographic_select:')
    && action.value === 'White'));
  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_demographic_combo:')
    && action.value === 'White'));
  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
});

test('Greenhouse trims low-priority fallbacks before exceeding the managed action budget', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    city: 'Dubai',
    country: 'United Arab Emirates',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    coverLetter: Buffer.from('cover'),
    coverLetterName: 'cover-letter.pdf',
    referralSourceDefault: 'Company website',
    eeoPrefs: {
      gender: 'Female',
      transgender_status: 'Decline to self-identify',
      sexual_orientation: 'Heterosexual',
      disability_status: 'Decline to self-identify',
      veteran_status: 'Decline to self-identify',
      race: 'White',
    },
    questions: [
      { question: 'Which team opening are you most interested in?', answer: 'Search & Recommendation' },
      { question: 'How familiar are you with Faire?', answer: 'Somewhat familiar' },
      { question: 'Are you currently eligible to legally work in the United States?', answer: 'Yes' },
      { question: 'Will you now or in the future require immigration support or sponsorship?', answer: 'Yes' },
      { question: 'Are you able to work onsite in our San Francisco office 5 days a week?', answer: 'Yes' },
      { question: 'Which product category are you most interested in?', answer: 'Search' },
      { question: 'Which opening are you most interested in?', answer: 'Data Science' },
      { question: 'Which location are you most interested in?', answer: 'San Francisco, California' },
      { question: 'What is your graduation date?', answer: 'May 2028' },
      { question: 'What is your GPA?', answer: '3.89' },
    ],
  }, true);

  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
  assert.equal(actions.at(-1)?.type, 'click');
  assert.ok(actions.some((action) => action.label === 'phone_country'));
  assert.ok(actions.some((action) => action.label === 'location'));
  assert.ok(actions.some((action) => action.label?.startsWith('question_combo_label:') && action.label.includes('team opening')));
  assert.equal(actions.some((action) => action.label?.includes('sexual orientation')), false);
  assert.ok(actions.some((action) => action.label?.startsWith('greenhouse_referral_combo_label:') && action.label.includes('Faire')));
  assert.ok(actions.some((action) => action.type === 'upload' && action.label === 'resume'));
  assert.ok(actions.some((action) => action.type === 'upload' && action.label === 'cover_letter'));
});

test('Greenhouse skips submit when preserved answers alone exceed the managed action budget', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: Array.from({ length: 140 }, (_, index) => ({
      question: `Describe project ${index + 1}`,
      answer: `Project ${index + 1} answer`,
    })),
  }, true);

  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
  assert.notEqual(actions.at(-1)?.selector, 'button[type="submit"], input[type="submit"]');
  assert.ok(actions.some((action) => action.type === 'upload' && action.label === 'resume'));
});

test('Greenhouse replays Jump academic and referral choices without consent', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    referralSourceDefault: 'Company website',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'Do you currently have any offers from other firms or deadlines we should be aware of?', answer: 'No' },
      { question: 'If you said yes above, please tell us about your offers and deadlines.', answer: 'N/A' },
      { question: 'Will you require sponsorship for work authorization in the future?', answer: 'Yes' },
      { question: 'Review our Notice at Collection to learn how we will process your personal data.', answer: 'I agree' },
    ],
  });

  const comboFills = actions.filter((action) => action.type === 'fill');
  assert.ok(comboFills.some((action) => action.selector === '#degree--0' && action.value === 'Bachelor\'s Degree'), 'degree level');
  assert.ok(comboFills.some((action) => action.selector === '#degree--0' && action.value === 'Bachelor of Science'), 'degree bachelor science');
  assert.ok(comboFills.some((action) => action.selector === '#degree--0' && action.value === 'Bachelor of Science in Computer Science'), 'degree full');
  assert.ok(comboFills.some((action) => action.label?.startsWith('education_graduation_date_combo:') && action.value === 'May 2028'), 'raw graduation date');
  assert.ok(comboFills.some((action) => action.label?.startsWith('education_graduation_date_combo:') && action.value === 'Spring 2028'), 'graduation bucket');
  assert.ok(actions.some((action) =>
    action.label?.startsWith('greenhouse_referral_combo_label:')
    && action.value === 'Company website'), 'referral combo');
  assert.ok(actions.some((action) =>
    action.label?.startsWith('question_combo_label:')
    && action.value === 'Yes'), 'sponsorship combo');
  assert.equal(actions.some((action) => action.text === 'Review our Notice at Collection to learn how we will process your personal data.'), false, 'privacy text skipped');
  assert.ok(actions.every((action) => !action.selector || action.selector.length <= 500), 'selector length');
  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
});

test('Greenhouse profile-backed academic questions replay through label-scoped comboboxes', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    graduationDate: 'May 2027',
    gpa: '3.89/4.0',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'Degree', answer: 'Bachelor of Science in Computer Science' },
      { question: 'Discipline', answer: 'Computer Science' },
      { question: 'What is your latest field of study?', answer: 'Computer Science' },
      { question: 'What is your current academic performance rating?', answer: '3.89/4.0' },
      { question: 'Expected Graduation semester', answer: 'Spring 2027' },
      { question: 'Which university are you currently enrolled in?', answer: 'University of Southern California' },
      { question: 'What is the current year of your studies?', answer: 'Third year' },
      { question: 'How did you hear about us?', answer: 'Company website' },
      { question: 'What country are you currently residing?', answer: 'United States' },
    ],
  });

  const comboLabels = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo_label:'))
    .map((action) => `${action.label}:${action.value}`);
  assert.ok(comboLabels.some((label) => label.includes('Degree') && label.endsWith('Bachelor\'s Degree')));
  assert.ok(comboLabels.some((label) => label.includes('Discipline') && label.endsWith('Computer Science')));
  assert.ok(comboLabels.some((label) => label.includes('latest field of study') && label.endsWith('Computer Science')));
  assert.ok(comboLabels.some((label) => label.includes('academic performance rating') && label.endsWith('3.6 or above (out of 4.0)')));
  assert.ok(comboLabels.some((label) => label.includes('Expected Graduation semester') && label.endsWith('Earlier than Fall 2027')));
  assert.ok(comboLabels.some((label) => label.includes('Which university are you currently enrolled') && label.endsWith('University of Southern California')));
  assert.ok(comboLabels.some((label) => label.includes('current year of your studies') && label.endsWith('Third')));
  assert.ok(comboLabels.some((label) => label.includes('How did you hear about us') && label.endsWith('Company website')));
  assert.ok(comboLabels.some((label) => label.includes('country are you currently residing') && label.endsWith('United States')));
});

test('Greenhouse replays Cloudflare graduation and degree choice buckets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekman@usc.edu',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'How did you hear about this job?',
        answer: 'Company website',
      },
      {
        question: 'If you are currently enrolled in a university or program, when do you expect to graduate or complete your program? (Select the closest date.)',
        answer: 'May 2028',
      },
      {
        question: 'If you are enrolled in university, what degree are you currently pursuing?',
        answer: 'Bachelor of Science in Computer Science & Business Administration, Finance Emphasis',
      },
    ],
  });

  const comboLabels = actions
    .filter((action) => action.type === 'fill' && action.label?.startsWith('question_combo_label:'))
    .map((action) => `${action.label}:${action.value}`);
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('how did you hear about this job') && label.endsWith('Other (none of the above)')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('when do you expect to') && label.endsWith('June 2028')));
  assert.ok(comboLabels.some((label) => label.toLowerCase().includes('degree are you currently pursuing') && label.endsWith('Bachelor\'s')));
});

test('Greenhouse replays Databricks choice questions through React-select buckets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.",
        answer: 'San Francisco, California',
        portalSelector: 'input[id="question_32707214002"]',
      },
      {
        question: 'What is your graduation date?',
        answer: 'May 2027',
        portalSelector: 'input[id="question_24505242002"]',
      },
      {
        question: 'What is your GPA?',
        answer: '3.89',
        portalSelector: 'input[id="question_32698502002"]',
      },
      {
        question: 'Do you currently or have you previously worked for Databricks in the past?',
        answer: "I have not worked for Databricks before, and I don't currently work there.",
        portalSelector: 'input[id="question_30149518002"]',
      },
    ],
  });

  const comboActions = actions.filter((action) => action.label?.startsWith('question_combo:'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_32707214002"]' && action.value === 'San Francisco, CA'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_24505242002"]' && action.value === 'Earlier than Fall 2027'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_32698502002"]' && action.value === '3.6 or above (out of 4.0)'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector === 'input[id="question_30149518002"]' && action.value === 'No'));
  assert.ok(comboActions.some((action) => action.type === 'click' && action.selector === '[id^="react-select-"][id$="-option-0"]:visible'));
  assert.ok(actions.some((action) => action.type === 'press' && action.selector === 'input[id="question_32707214002"]' && action.label?.startsWith('question_combo')));
  assert.ok(actions.some((action) => action.type === 'press' && action.selector === 'input[id="question_24505242002"]' && action.label?.startsWith('question_combo')));
  assert.ok(actions.some((action) => action.type === 'press' && action.selector === 'input[id="question_32698502002"]' && action.label?.startsWith('question_combo')));
  assert.ok(actions.some((action) => action.type === 'press' && action.selector === 'input[id="question_30149518002"]' && action.label?.startsWith('question_combo')));
});

test('Greenhouse replays Databricks React-select buckets without portal selectors', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.",
        answer: 'San Francisco, California',
      },
      {
        question: 'What is your graduation date?',
        answer: 'May 2027',
      },
      {
        question: 'What is your GPA?',
        answer: '3.89',
      },
      {
        question: 'Do you currently or have you previously worked for Databricks in the past?',
        answer: "I have not worked for Databricks before, and I don't currently work there.",
      },
    ],
  });

  const comboActions = actions.filter((action) => action.label?.startsWith('question_combo_label:'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("Please choose the single location') && action.value === 'San Francisco, CA'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("What is your graduation date?")') && action.value === 'Earlier than Fall 2027'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("What is your GPA?")') && action.value === '3.6 or above (out of 4.0)'));
  assert.ok(comboActions.some((action) => action.type === 'fill' && action.selector?.includes('label:has-text("Do you currently or have you previously worked for Databricks') && action.value === 'No'));
  assert.equal(comboActions.filter((action) => action.type === 'click' && action.selector === '[id^="react-select-"][id$="-option-0"]:visible').length, 4);
  for (const action of comboActions.filter((candidate) => candidate.type === 'fill')) {
    const index = actions.indexOf(action);
    assert.equal(actions[index + 1]?.type, 'click');
    assert.equal(actions[index + 1]?.selector, '[id^="react-select-"][id$="-option-0"]:visible');
    assert.equal(actions[index + 2]?.type, 'press');
    assert.equal(actions[index + 2]?.selector, action.selector);
  }
  assert.ok(actions.some((action) => action.type === 'press' && action.label?.startsWith('question_combo_label:') && action.value === 'Enter'));
  assert.ok(actions.every((action) => (action.selector?.length ?? 0) <= 500));
  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
});

test('Greenhouse work authorization React-select respects negative reviewed answers', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Are you legally authorized to work in the country in which you are applying?',
        answer: 'No',
      },
    ],
  });

  const comboFills = actions.filter((action) =>
    action.type === 'fill'
    && action.label?.startsWith('question_combo_label:')
    && action.label?.includes('Are you legally authorized'));
  assert.equal(comboFills.length, 1);
  assert.equal(comboFills[0]?.value, 'No');
  assert.equal(
    actions.some((action) =>
      action.type === 'fill'
      && action.label?.startsWith('question_combo_label:')
      && action.label?.includes('Are you legally authorized')
      && action.value === 'Yes'),
    false,
  );
});

test('Greenhouse Databricks academic and reviewed question packet stays inside the action budget', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2027',
    graduationMonth: 'May',
    graduationYear: '2027',
    gpa: '3.89',
    major: 'Computer Science',
    linkedinUrl: 'https://www.linkedin.com/in/mehekmandal/',
    portfolioUrl: 'https://github.com/mehek-builds',
    resume: Buffer.from('pdf'),
    resumeName: 'Mehek_Mandal_Product_Management_Intern_Resume.pdf',
    eeoPrefs: {
      gender: 'Female',
      sexual_orientation: 'Heterosexual',
      race: 'White',
      veteran_status: 'Decline to self-identify',
      disability_status: 'Decline to self-identify',
    },
    questions: [
      { question: 'LinkedIn Profile', answer: 'https://www.linkedin.com/in/mehekmandal/' },
      { question: 'Website', answer: 'https://github.com/mehek-builds' },
      { question: 'How did you hear about this job?', answer: 'Company website' },
      { question: 'Are you legally authorized to work in the country in which you are applying?', answer: 'Yes' },
      { question: 'Do you now or will you in the future need sponsorship for employment visa status', answer: 'Yes' },
      { question: 'Gender', answer: 'Female' },
      {
        question: "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.",
        answer: 'San Francisco, California',
      },
      { question: 'What is your graduation date?', answer: 'May 2027' },
      { question: 'What is your GPA?', answer: '3.89' },
      {
        question: 'Do you currently or have you previously worked for Databricks in the past?',
        answer: "I have not worked for Databricks before, and I don't currently work there.",
      },
      {
        question: 'Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.',
        answer: 'None of the above',
      },
      {
        question: 'If you selected a response to the prior question other than none of the above, please confirm whether any of the following also applies to you. Select all that apply.',
        answer: 'Not applicable (i.e., I selected none of the above for the prior question)',
      },
    ],
  }, true);

  assert.ok(actions.some((action) => action.label?.startsWith('education_degree_combo:')));
  assert.equal(actions.some((action) => action.label?.startsWith('education_degree_combo_label:')), false);
  assert.ok(actions.some((action) => action.label?.startsWith('question_combo_label:')));
  assert.ok(actions.some((action) =>
    action.type === 'fill'
    && action.label?.startsWith('question_combo_label:')
    && action.label?.includes('Are you legally authorized')
    && action.value === 'Yes'));
  assert.ok(actions.some((action) => action.label?.startsWith('question_checkbox:')));
  assert.equal(
    actions.some((action) =>
      action.label?.startsWith('question_select:')
      && action.selector?.includes('What is your GPA?')),
    false,
  );
  assert.ok(actions.every((action) => (action.selector?.length ?? 0) <= 500));
  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
});

test('Greenhouse replays Databricks export-control checkbox answers by exact option', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      {
        question: 'Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.',
        answer: 'None of the above',
        portalSelector: 'input[id="question_35110536002[]_221056618002"]',
        portalInputType: 'checkbox',
      },
      {
        question: 'If you selected a response to the prior question other than none of the above, please confirm whether any of the following also applies to you. Select all that apply.',
        answer: 'Not applicable (i.e., I selected none of the above for the prior question)',
        portalSelector: 'input[id="question_35114221002[]_221073825002"]',
        portalInputType: 'checkbox',
      },
    ],
  });

  const checkboxClicks = actions.filter((action) => action.label?.startsWith('question_checkbox:'));
  assert.equal(actions.some((action) => action.label?.startsWith('question_choice:')), false);
  assert.ok(checkboxClicks.some((action) => action.type === 'click' && action.selector === 'input[name="question_35110536002[]"][value="221056618002"]'));
  assert.ok(checkboxClicks.some((action) => action.type === 'click' && action.selector === 'input[name="question_35114221002[]"][value="221073825002"]'));
  assert.equal(checkboxClicks.some((action) => action.selector?.startsWith('label:has-text')), false);
  assert.ok(checkboxClicks.every((action) => action.optional === true));
  assert.ok(checkboxClicks.every((action) => (action.timeout ?? Infinity) < 30_000));
});

test('Greenhouse school aliases do not strip comma-separated campus names generically', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    school: 'University of California, Berkeley',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const schoolValues = actions
    .filter((action) => action.type === 'fill' && action.selector === '#school--0')
    .map((action) => action.value);
  assert.deepEqual(schoolValues, ['University of California, Berkeley']);
});

test('no managed action can burn the 30s default — every fill, upload, and question is bounded', () => {
  // Live Jump Trading retry, 2026-07-24: after the core-field fix the run cleared name/email and
  // then died on `locator.setInputFiles: Timeout 30000ms exceeded` at the resume input, because the
  // upload action was neither optional nor bounded. Same latent 30s trap sat on phone/location and
  // the question fills. Every managed action must now be time-bounded so one wrong selector can't
  // eat the run's budget, and the resume upload must be optional so a missing file input degrades
  // to a blocker card instead of failing the run.
  for (const portal of ['greenhouse', 'lever', 'ashby'] as const) {
    const actions = buildManagedPortalActions(portal, {
      fullName: 'Taylor Example',
      email: 'taylor@example.com',
      phone: '+1 555 0100',
      city: 'Los Angeles',
      resume: Buffer.from('pdf'),
      resumeName: 'resume.pdf',
      questions: [{ question: 'Why this role?', answer: 'I enjoy systems work.' }],
    });
    for (const action of actions) {
      assert.ok(
        (action.timeout ?? Infinity) < 30_000,
        `${portal} ${action.type} (${action.label ?? action.text}) must be bounded under the 30s default`,
      );
    }
    const upload = actions.find((a) => a.type === 'upload');
    assert.equal(upload?.optional, true, `${portal} resume upload must degrade to a blocker, not fail the run`);
    assert.ok((upload?.timeout ?? Infinity) < 30_000, `${portal} resume upload must be bounded`);
  }
});

test('both providers may be sent reviewed questions', () => {
  // False for 'managed' only while its runner threw on checkboxes and ignored `optional`.
  assert.equal(canFillReviewedQuestions('managed'), true);
  assert.equal(canFillReviewedQuestions('direct'), true);
});

test('choice controls are not auto-clicked by matching answer text', () => {
  // Deliberate omission. Matching a label to a short answer like "Yes" can tick a legal
  // acknowledgement or consent box elsewhere on the page, which the student cannot undo. An
  // unanswered choice question is a blocker she clears in seconds.
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [{ question: 'Do you consent to the terms?', answer: 'Yes' }],
  });
  const clicks = actions.filter((action) => action.type === 'click' && !isGreenhousePreflightClick(action));
  assert.equal(clicks.length, 0, 'no click action may be synthesized from an answer string');
});

test('Greenhouse managed actions never include demographic data consent', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  assert.equal(actions.some((action) => action.label === 'greenhouse_demographic_data_consent_checkbox'), false);
  assert.equal(actions.some((action) => action.label === 'greenhouse_demographic_data_consent'), false);
});

test('Greenhouse managed actions include explicitly saved demographic choices', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    eeoPrefs: {
      gender: 'Female',
      transgender_status: 'Decline to self-identify',
      sexual_orientation: 'Heterosexual',
      disability_status: 'Decline to self-identify',
      veteran_status: 'Decline to self-identify',
      race: 'White',
    },
    questions: [],
  });
  assert.deepEqual(
    actions
      .filter((action) => action.label?.startsWith('greenhouse_demographic:'))
      .map((action) => [action.text, action.value]),
    [
      ['What gender identity do you most closely identify with?', 'Female'],
      ['Are you a person of transgender experience?', 'Decline to self-identify'],
      ['What sexual orientation do you most closely identify with?', 'Heterosexual'],
      ['Do you live with a disability (as outlined by the ADA)?', 'Decline to self-identify'],
      ['Are you a veteran/have you served in the military?', 'Decline to self-identify'],
      ['Please select up to 2 ethnicities that you most closely identify with.', 'White'],
    ],
  );
});

test('question wording alone cannot predict a control type', () => {
  // Recorded because it is the lesson that cost three deploys: this reads like free text and is a
  // checkbox group on Aquatic's Greenhouse form. The heuristic is a helper, never the guard.
  assert.equal(isChoiceQuestion('How did you hear about this job?'), true);
});

// ─── Workable / JazzHR / Paylocity (added 2026-07-28) ─────────────────────────
// Every assertion below encodes something read off a LIVE form that day, not a naming pattern.
// See litos-ats-dom-capture-2026-07-28.md. The point of each is to fail if someone "simplifies" a
// selector back to the obvious-but-wrong version.

const capturePacket = {
  fullName: 'Taylor Example',
  email: 'taylor@example.com',
  phone: '+971500000000',
  city: 'Dubai',
  linkedinUrl: 'https://linkedin.com/in/taylor',
  githubUrl: 'https://github.com/taylor',
  portfolioUrl: 'https://taylor.example',
  resume: Buffer.from('pdf'),
  resumeName: 'resume.pdf',
  questions: [],
};

test('the three new hostnames are detected, and their tenant subdomains are too', () => {
  assert.equal(detectPortal('https://apply.workable.com/suade/j/9C43981D17/apply'), 'workable');
  assert.equal(detectPortal('https://ticketmanager.applytojob.com/apply/jobs/details/z8b5ObES2F'), 'jazzhr');
  assert.equal(detectPortal('https://2000recruiting.paylocity.com/Recruiting/Jobs/Apply/44457'), 'paylocity');
});

test('Workable uploads the resume by data-ui, never by id or a bare file selector', () => {
  // The live form randomises the resume input's id per render AND ships a second file input for the
  // profile photo (data-ui="avatar") that appears FIRST in the DOM. A bare input[type="file"] or any
  // id-based match files the student's resume as her headshot.
  const actions = buildManagedPortalActions('workable', capturePacket, true);
  const upload = actions.find((action) => action.type === 'upload' && action.label === 'resume');
  assert.ok(upload, 'Workable must push a resume upload');
  assert.match(upload!.selector!, /data-ui="resume"/);
  assert.doesNotMatch(upload!.selector!, /input_files_input/, 'must not match the per-render random id');
  assert.notEqual(upload!.selector, 'input[type="file"]');
});

test('Workable never ticks the GDPR consent checkbox', () => {
  const actions = buildManagedPortalActions('workable', capturePacket, true);
  assert.equal(actions.some((action) => JSON.stringify(action).includes('gdpr')), false);
});

test('JazzHR fills the form but is never allowed to auto-submit, because of reCAPTCHA', () => {
  // Every JazzHR application form carries a live g-recaptcha-response field. Filling is fine;
  // submitting is not, and that stop is policy, not a missing selector.
  assert.equal(portalCanAutoSubmit('jazzhr'), false);
  const actions = buildManagedPortalActions('jazzhr', capturePacket, true);
  assert.ok(actions.some((action) => action.type === 'fill' && action.selector?.includes('resumator-firstname-value')));
  assert.notEqual(actions.at(-1)?.type, 'click', 'a submit click must NOT be appended');
  assert.equal(actions.some((action) => action.type === 'click'), false);
});

test('JazzHR never answers the voluntary EEO questions', () => {
  const actions = buildManagedPortalActions('jazzhr', capturePacket, true);
  assert.equal(actions.some((action) => JSON.stringify(action).includes('eeo_')), false);
});

test('Paylocity matches its dotted ids by attribute, since #info.firstName is invalid CSS', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  const first = actions.find((action) => action.label === 'first_name');
  assert.ok(first);
  assert.equal(first!.selector, '[id="info.firstName"]');
  assert.doesNotMatch(first!.selector!, /#info\./, 'a #id selector cannot match an id containing a dot');
});

test('Paylocity walks its wizard, but every click is label-scoped and can never hit the terminal submit', () => {
  // Paylocity reuses the id #btn-submit for BOTH "Next Step" and the final submit, so an advance
  // selector that matches on the id alone would press Submit on the last step. Scoping by visible
  // text is what makes the traversal structurally unable to submit, rather than relying on a step
  // count staying in sync with Paylocity's own wizard logic.
  assert.equal(portalCanAutoSubmit('paylocity'), false);
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  const clicks = actions.filter((action) => action.type === 'click');
  assert.ok(clicks.length > 0, 'Paylocity must advance through its wizard');
  for (const click of clicks) {
    assert.match(click.selector!, /:has-text\("Next Step"\)/, 'every click must be label-scoped');
    assert.equal(click.optional, true, 'a missing advance button must be a no-op, not an error');
  }
  // The generic terminal submit selector used by single-step portals must never appear.
  assert.equal(actions.some((a) => a.selector === 'button[type="submit"], input[type="submit"]'), false);
});

test('Paylocity fills work history from the parsed resume, and only the first row', () => {
  const withRole = { ...capturePacket, mostRecentRole: { company: 'Traeco', title: 'Founding Engineer', summary: 'Built the ingest pipeline.', startDate: 'Jun 2025', endDate: 'Present' } };
  const actions = buildManagedPortalActions('paylocity', withRole, true);
  assert.equal(actions.find((a) => a.label === 'work_company')?.selector, '[id="workHistory.companyName.0"]');
  assert.equal(actions.find((a) => a.label === 'work_title')?.value, 'Founding Engineer');
  // Row 1 only - never creates additional rows it may not be able to complete.
  assert.equal(actions.some((a) => /workHistory\.\w+\.[1-9]/.test(a.selector ?? '')), false);
  assert.equal(actions.some((a) => /Add Work History/i.test(a.selector ?? '')), false);
});

test('a profile with no parsed experience simply skips the work-history fills', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  assert.equal(actions.some((a) => a.label?.startsWith('work_')), false);
});

test('Paylocity re-runs the reviewed-question fills on every step, since screeners are not on page one', () => {
  const withQuestions = { ...capturePacket, questions: [{ question: 'Why this role?', answer: 'Because it is backend-heavy.' }] };
  const actions = buildManagedPortalActions('paylocity', withQuestions, true);
  const asked = actions.filter((a) => a.type === 'fillByLabelText' && a.text === 'Why this role?');
  // Once for step one, then once after each advance.
  assert.equal(asked.length, 4);
});

test('the notLastStep markers mean NOT the last step, so a step-one page is never the attestation page', () => {
  // Regression test for a real inversion caught in review. The marker ids end in `notLastStep`:
  // they are Paylocity's own negative flags, present precisely when the page is NOT terminal. The
  // first version treated their presence as proof of the terminal page, so it returned true on step
  // one - which would have told the student "one page left, and it needs you" on page one of four.
  const stepOne = '<div class="progress-header">Step 1 of 4</div>'
    + '<span id="acknowledgements.priorConviction.notLastStep"></span>'
    + '<span id="acknowledgements.authorizedToWorkInUS.notLastStep"></span>'
    + '<input id="info.firstName"><button id="btn-submit">Next Step</button>';
  assert.equal(isPaylocityTerminalStep(stepOne), false);

  // The terminal page: the negative markers are gone, the wizard's control is still there.
  const stepFour = '<div class="progress-header">Step 4 of 4</div>'
    + '<label>By submitting your application you hereby certify...</label>'
    + '<button id="btn-submit">Submit application</button>';
  assert.equal(isPaylocityTerminalStep(stepFour), true);

  // Not a wizard page at all (error, redirect, timeout) - absence of the markers alone is not proof.
  assert.equal(isPaylocityTerminalStep('<h1>Something went wrong</h1>'), false);
});

test('a portal that cannot auto-submit is stopped before either provider path, not inside the action builder', () => {
  // Regression test for the most serious review finding. The gate used to live ONLY inside
  // buildManagedPortalActions, which removed the click from the managed action list but did nothing
  // about (a) the code that then called readManagedReceipt and wrote status:'submitted' anyway, or
  // (b) the direct-Playwright path, which calls clickFinalSubmit(page) unconditionally. The real
  // guarantee has to be enforced by the caller, so assert the predicate the caller keys off.
  for (const portal of ['jazzhr', 'paylocity', 'controlled_jazzhr', 'controlled_paylocity'] as const) {
    assert.equal(portalCanAutoSubmit(portal), false, portal);
    assert.ok(portalHandoffReason(portal), `${portal} must explain the handoff to the student`);
  }
  for (const portal of ['workable', 'greenhouse', 'lever', 'ashby'] as const) {
    assert.equal(portalCanAutoSubmit(portal), true, portal);
  }
});

test('each handoff reason names its own cause rather than a generic stop', () => {
  const captcha = portalHandoffReason('jazzhr')!;
  const wizard = portalHandoffReason('paylocity')!;
  assert.match(captcha, /prove you are human/);
  assert.match(wizard, /last page/);
  assert.notEqual(captcha, wizard);
  assert.equal(portalHandoffReason('controlled_jazzhr'), captcha);
  assert.equal(portalHandoffReason('workable'), null);
});

test('the wizard is only walked on a real submit run, never on the preview that the human approves', () => {
  // prepare() builds actions with submit=false to capture the preview screenshot. Traversing there
  // advanced a real employer's wizard on a run that explicitly asked not to submit, and captured the
  // preview of step 4 - showing the student an empty attestation page as the thing she was approving.
  const preview = buildManagedPortalActions('paylocity', capturePacket, false);
  assert.equal(preview.some((a) => a.type === 'click'), false, 'a preview run must not advance the wizard');
  const real = buildManagedPortalActions('paylocity', capturePacket, true);
  assert.ok(real.some((a) => a.type === 'click'), 'a submit run still walks it');
});

test('direct required-field fallback treats unchecked required choices as empty', async () => {
  const source = await import('node:fs/promises').then((fs) => fs.readFile('src/lib/portalSubmission.ts', 'utf8'));
  const start = source.indexOf("const required = page.locator('input[required], textarea[required], select[required]')");
  assert.ok(start >= 0, 'required-field scanner is missing');
  const end = source.indexOf('blockers.push(...new Set(labelledBlockers))', start);
  assert.ok(end > start, 'could not bound required-field scanner');
  const scanner = source.slice(start, end);

  assert.match(scanner, /type === 'checkbox' \|\| type === 'radio'/);
  assert.match(scanner, /field\.isChecked\(\)/);
  assert.match(scanner, /fillResolvedRequiredField\(field, label, packet, filledFields\)/);
  assert.doesNotMatch(scanner, /const value = await field\.inputValue\(\)[\s\S]{0,80}if \(value\) continue;[\s\S]{0,80}type === 'checkbox'/);
});

test('the QA harness routes to each new controlled adapter, by query param and by path', () => {
  const previous = process.env.LITOS_ENABLE_TEST_PORTAL;
  process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
  for (const board of ['workable', 'jazzhr', 'paylocity'] as const) {
    assert.equal(detectPortal(`https://trylitos.com/qa/portal-submission?board=${board}`), `controlled_${board}`);
    assert.equal(detectPortal(`https://trylitos.com/qa/portal-submission/${board}/${board}-01`), `controlled_${board}`);
  }
  if (previous === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
  else process.env.LITOS_ENABLE_TEST_PORTAL = previous;
});

test('the new host rules reject marketing sites and the Paylocity employee login', () => {
  // access.paylocity.com is a CREDENTIAL page on the same host space as the job boards, and
  // www.workable.com is the vendor's marketing site. A bare host match claimed both, so a mistyped
  // portal_url became a "supported portal" and earned a fill run against a login form.
  assert.throws(() => detectPortal('https://access.paylocity.com/'), /cannot fill in/);
  assert.throws(() => detectPortal('https://www.paylocity.com/company/careers/'), /cannot fill in/);
  assert.throws(() => detectPortal('https://www.workable.com/'), /cannot fill in/);
  assert.throws(() => detectPortal('https://jobs.workable.com/search'), /cannot fill in/);
  // The real application pages still resolve.
  assert.equal(detectPortal('https://apply.workable.com/suade/j/9C43981D17/apply'), 'workable');
  assert.equal(detectPortal('https://2000recruiting.paylocity.com/Recruiting/Jobs/Apply/44457'), 'paylocity');
  assert.equal(detectPortal('https://recruiting.paylocity.com/recruiting/jobs/Details/4084914/X/Y'), 'paylocity');
});

test('each new adapter pushes the exact selector read off the live form', () => {
  // Mutation testing during review showed most of these were unpinned: changing the Workable phone
  // selector, the JazzHR email selector, or deleting the Paylocity location fill all kept the suite
  // green. A table is the cheap way to make every captured selector load-bearing.
  const withRole = {
    ...capturePacket,
    coverLetter: Buffer.from('pdf'),
    coverLetterName: 'cover.pdf',
    mostRecentRole: { company: 'Traeco', title: 'Founding Engineer', summary: 'Built it.', startDate: 'Jun 2025', endDate: 'Present' },
  };
  const expected: Record<string, Record<string, string>> = {
    workable: {
      first_name: 'input[name="firstname"]', last_name: 'input[name="lastname"]',
      email: 'input[name="email"]', phone: 'input[name="phone"]', location: 'input[name="city"]',
      resume: 'input[type="file"][data-ui="resume"]',
    },
    jazzhr: {
      first_name: 'input[name="resumator-firstname-value"]', last_name: 'input[name="resumator-lastname-value"]',
      email: 'input[name="resumator-email-value"]', phone: 'input[name="resumator-phone-value"]',
      location: 'input[name="resumator-city-value"]', linkedin: 'input[name="resumator-linkedin-value"]',
      resume: 'input[type="file"][name="resumator-resume-value"]',
    },
    paylocity: {
      first_name: '[id="info.firstName"]', last_name: '[id="info.lastName"]',
      email: '[id="info.email"]', phone: '[id="info.cellPhone"]', linkedin: '[id="info.linkedIn"]',
      location: '#public-site-address-city', resume: '#btn-resume', cover_letter: '#btn-coverLetter',
      work_company: '[id="workHistory.companyName.0"]', work_title: '[id="workHistory.position.0"]',
      work_summary: '[id="workHistory.responsibilities.0"]',
      work_start: '#txt-workHistory-startDate-0', work_end: '#txt-workHistory-endDate-0',
    },
  };
  for (const [portal, fields] of Object.entries(expected)) {
    const actions = buildManagedPortalActions(portal as 'workable', withRole, true);
    for (const [label, selector] of Object.entries(fields)) {
      assert.equal(actions.find((a) => a.label === label)?.selector, selector, `${portal}.${label}`);
    }
  }
});

test('the Paylocity advance selector is exactly the label-scoped form, never the bare id', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  const clicks = actions.filter((a) => a.type === 'click');
  assert.ok(clicks.length > 0);
  for (const click of clicks) assert.equal(click.selector, '#btn-submit:has-text("Next Step")');
});

test('Paylocity never answers EEO, OFCCP, the conviction question, or the attestation', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  assert.ok(actions.some((a) => a.label === 'first_name'), 'sanity: the adapter actually ran');
  for (const marker of ['acknowledgements.', 'eeoGenderEthnicity', 'priorConviction', 'authorizedToWorkInUS', 'useAttachedResume']) {
    assert.equal(actions.some((a) => JSON.stringify(a).includes(marker)), false, marker);
  }
});

test('Paylocity picks the resume file input out of the three the form renders', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  const upload = actions.find((action) => action.type === 'upload' && action.label === 'resume');
  assert.equal(upload?.selector, '#btn-resume');
});

test('Paylocity leaves the parse-my-resume checkbox alone so it cannot overwrite our fills', () => {
  const actions = buildManagedPortalActions('paylocity', capturePacket, true);
  assert.equal(actions.some((action) => JSON.stringify(action).includes('useAttachedResume')), false);
});

test('the portals that cannot auto-submit each explain why in plain language', () => {
  for (const portal of ['jazzhr', 'paylocity'] as const) {
    const reason = portalHandoffReason(portal);
    assert.ok(reason && reason.length > 0, `${portal} must explain its handoff`);
  }
  assert.equal(portalHandoffReason('workable'), null, 'a fully supported portal has nothing to explain');
});

test('every controlled variant maps to its real family and keeps that family’s guarantees', () => {
  for (const [controlled, live] of [
    ['controlled_workable', 'workable'],
    ['controlled_jazzhr', 'jazzhr'],
    ['controlled_paylocity', 'paylocity'],
  ] as const) {
    assert.equal(portalCanAutoSubmit(controlled), portalCanAutoSubmit(live));
    // The controlled fixture must exercise the SAME selectors as the live adapter, or the harness
    // proves nothing about production.
    const viaControlled = buildManagedPortalActions(controlled, capturePacket, false).map((a) => a.selector);
    const viaLive = buildManagedPortalActions(live, capturePacket, false).map((a) => a.selector);
    assert.deepEqual(viaControlled, viaLive);
  }
});

// ─── 2026-07-29: Rippling, BreezyHR, BambooHR, and the four account-walled platforms ──────────────

test('every autonomous family actually fills something before it is allowed to press submit', () => {
  // The structural hazard this whole file's type design creates, made into a test.
  //
  // AutonomousPortalFamily is derived by EXCLUSION - a family is autonomous unless someone remembers
  // to add it to the multi-step, CAPTCHA or account-walled sets. So a new family whose fill branch is
  // missing or misspelled does not fail to compile and does not fail any selector test. It quietly
  // becomes "autonomous", pushes zero fills, and the runner clicks submit on an empty form. That is
  // the same shape as the 2026-07-28 finding where a gate existed but did not gate.
  //
  // Requiring a real identity fill plus the click closes it for every present and future member.
  for (const family of AUTONOMOUS_PORTAL_FAMILIES) {
    const actions = buildManagedPortalActions(family, capturePacket, true);
    const fills = actions.filter((a) => a.type === 'fill');
    assert.ok(fills.length >= 2, `${family}: an autonomous portal that fills nothing would submit an empty form`);
    assert.ok(
      actions.some((a) => a.type === 'fill' && a.label === 'email'),
      `${family}: no email fill, so the form cannot identify the applicant`,
    );
    assert.ok(
      actions.some((a) => a.type === 'upload' && a.label === 'resume'),
      `${family}: no resume upload`,
    );
    assert.equal(actions.at(-1)?.type, 'click', `${family}: an autonomous portal must end in the submit click`);
  }
});

test('the account-walled four push no actions at all, because there is no form to act on', () => {
  // Jobvite/iCIMS/Oracle/UltiPro never reach an application field: a data-consent choice, a login
  // wall, or an emailed code comes first. Firing optional fills at those pages would miss and produce
  // a blocker card implying the form was found and merely refused, when it was never reached.
  for (const portal of ['jobvite', 'icims', 'oraclecloud', 'ultipro'] as const) {
    assert.deepEqual(buildManagedPortalActions(portal, capturePacket, true), [], portal);
    assert.equal(portalCanAutoSubmit(portal), false, portal);
    assert.equal(isAutonomousPortalFamily(portal), false, portal);
    assert.ok(isAccountWalledFamily(portal), portal);
    assert.equal(
      (POLLABLE_JOB_BOARDS as readonly string[]).includes(portal),
      false,
      `${portal} must never reach the jobs board`,
    );
  }
});

test('an account-walled handoff never claims Litos filled a form it never reached', () => {
  // The CAPTCHA and wizard sentences both open with "Litos filled everything in" / "Litos filled in
  // this application", which is true for those families and a plain lie for these four. A student
  // told that would go hunting for filled fields that do not exist.
  for (const portal of ['jobvite', 'icims', 'oraclecloud', 'ultipro'] as const) {
    const reason = portalHandoffReason(portal)!;
    assert.ok(reason, portal);
    assert.doesNotMatch(reason, /filled everything in|filled in this application/i, portal);
  }
  // And each names its own cause, rather than sharing one vague sentence.
  const reasons = (['jobvite', 'icims', 'oraclecloud', 'ultipro'] as const).map((p) => portalHandoffReason(p)!);
  assert.equal(new Set(reasons).size, 4, 'each account-walled platform explains its own gate');
  assert.match(portalHandoffReason('jobvite')!, /privacy notice/i);
  assert.match(portalHandoffReason('icims')!, /make an account/i);
  assert.match(portalHandoffReason('oraclecloud')!, /code/i);
});

test('BambooHR is CAPTCHA-gated, so it fills and stops however inviting its form looks', () => {
  // BambooHR's fields are the cleanest of the seven captured, which is exactly the trap: the form
  // looks like a one-run submit. Confirmed live 2026-07-29 - g-recaptcha-response present,
  // window.grecaptcha defined, badge rendered, api.js?render=explicit loaded.
  assert.equal(portalCanAutoSubmit('bamboohr'), false);
  assert.equal(portalCanAutoSubmit('controlled_bamboohr'), false);
  assert.equal(isAutonomousPortalFamily('bamboohr'), false);
  const actions = buildManagedPortalActions('bamboohr', capturePacket, true);
  assert.ok(actions.some((a) => a.type === 'fill'), 'it still fills what it can');
  const clicks = actions.filter((a) => a.type === 'click');
  // The ONLY click is the one that reveals the form. Never a submit.
  assert.equal(clicks.length, 1);
  assert.equal(clicks[0]?.label, 'open application form');
  assert.match(portalHandoffReason('bamboohr')!, /prove you are human/);
});

test('BambooHR clicks the reveal button first, since the form does not exist until it is pressed', () => {
  // The form renders into the SAME url behind "Apply for This Job"; /careers/{id}/apply is blank.
  // If this click is not first, every fill below it races a form that is not in the DOM yet.
  const actions = buildManagedPortalActions('bamboohr', capturePacket, true);
  assert.equal(actions[0]?.type, 'click');
  assert.equal(actions[0]?.selector, 'button:has-text("Apply for This Job")');
  assert.equal(actions[0]?.optional, true, 'a tenant already showing the form must not fail the run');
});

test('each 2026-07-29 adapter pushes the exact selector read off the live form', () => {
  // Same mutation-testing lesson as the 07-28 table: without this, changing a captured selector
  // keeps the suite green and the regression only shows up on a real employer's form.
  const withCover = { ...capturePacket, coverLetter: Buffer.from('pdf'), coverLetterName: 'cover.pdf' };
  const expected: Record<string, Record<string, string>> = {
    // Both name and id are randomised per render on Rippling, so data-testid is the ONLY stable hook.
    rippling: {
      first_name: '[data-testid="input-first_name"]', last_name: '[data-testid="input-last_name"]',
      email: '[data-testid="input-email"]', phone: '[data-testid="input-phone_number"]',
      resume: 'input[type="file"][data-testid="input-resume"]',
      cover_letter: 'input[type="file"][data-testid="input-cover_letter"]',
    },
    // cName is ONE full-name field, not a first/last pair.
    breezy: {
      name: 'input[name="cName"]', email: 'input[name="cEmail"]',
      phone: 'input[name="cPhoneNumber"]', location: 'input[name="cAddress"]',
      resume: 'input[type="file"][name="cResume"]',
    },
    bamboohr: {
      first_name: 'input[name="firstName"]', last_name: 'input[name="lastName"]',
      email: 'input[name="email"]', phone: 'input[name="phone"]',
      location: 'input[name="city.value"]', linkedin: 'input[name="linkedinUrl"]',
      portfolio: 'input[name="websiteUrl"]',
      resume: 'input[type="file"][aria-label="file-input"]',
    },
  };
  for (const [portal, fields] of Object.entries(expected)) {
    const actions = buildManagedPortalActions(portal as 'breezy', withCover, true);
    for (const [label, selector] of Object.entries(fields)) {
      assert.equal(actions.find((a) => a.label === label)?.selector, selector, `${portal}.${label}`);
    }
  }
});

test('Breezy uses one full-name field and never splits it into first and last', () => {
  const actions = buildManagedPortalActions('breezy', capturePacket, true);
  assert.equal(actions.find((a) => a.label === 'name')?.value, 'Taylor Example');
  for (const label of ['first_name', 'last_name']) {
    assert.equal(actions.some((a) => a.label === label), false, `Breezy has no ${label} field`);
  }
});

test('Breezy touches neither its honeypot nor its two consent checkboxes', () => {
  // hp_<hex> is randomised per render AND defeats a naive visibility check: the input itself computes
  // to opacity 1 / visibility visible / 250x43, concealed only by a height:0 overflow:hidden
  // ancestor. This adapter is safe because it fills by explicit name, and this test keeps it that way.
  const actions = buildManagedPortalActions('breezy', capturePacket, true);
  const serialised = JSON.stringify(actions);
  for (const forbidden of ['hp_', 'smsConsent', 'gdprAgreement']) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

test('Rippling answers none of the three things that are the applicant’s alone', () => {
  // Its pronouns, phone-country and race controls all share ONE data-testid
  // ("input-select-search-input") and so cannot even be told apart by selector. Two of the three are
  // the applicant's own identity to declare or decline, so there is nothing here to type into.
  // sms_opt_in is a marketing consent radio.
  const actions = buildManagedPortalActions('rippling', capturePacket, true);
  const serialised = JSON.stringify(actions);
  for (const forbidden of ['input-select-search-input', 'sms_opt_in', 'aiOptOut', 'externalPlaceId', 'current_company']) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

test('BambooHR leaves its honeypot and the address fields the packet cannot know', () => {
  const serialised = JSON.stringify(buildManagedPortalActions('bamboohr', capturePacket, true));
  for (const forbidden of ['nickname_', 'streetAddress.value', 'zip.value', 'state.value', 'countryId.value', 'desiredPay']) {
    assert.equal(serialised.includes(forbidden), false, forbidden);
  }
});

test('the 2026-07-29 host rules reject every login, marketing and unrelated-product page on the same hosts', () => {
  // Every one of these is the access.paylocity.com hazard in a new coat: a host that also serves a
  // credential page, a marketing site, or - for Oracle - an entire unrelated product estate.
  const rejected = [
    'https://app.rippling.com/login',                      // Rippling's HR product, not its ATS
    'https://www.rippling.com/careers',
    'https://breezy.hr/',                                  // vendor marketing on the tenant host space
    'https://breezy.hr/pricing',
    'https://www.bamboohr.com/careers/application',        // BambooHR's OWN careers page (Greenhouse)
    'https://www.bamboohr.com/careers/engineering-it-team',
    'https://www.jobvite.com/',
    'https://www.icims.com/',
    'https://community.icims.com/s/article/anything',
    'https://ultipro.com/',                                // UKG employee login
    'https://recruiting.ultipro.com/',
    // The one that would be actively dangerous without a path check: oraclecloud.com hosts every
    // Oracle Cloud application there is, so a bare host match claims somebody's payroll or ERP login.
    'https://myfin.fa.us2.oraclecloud.com/fscmUI/faces/FuseWelcome',
    'https://login.oraclecloud.com/',
  ];
  for (const url of rejected) {
    assert.throws(() => detectPortal(url), /cannot fill in/, url);
  }
  // And the real application pages still resolve, including tenant subdomains.
  assert.equal(detectPortal('https://ats.rippling.com/rippling/jobs/875b2547-84de-4abd-a14e-34ab802e9b27/apply'), 'rippling');
  assert.equal(detectPortal('https://zinier.breezy.hr/p/7eefd4d49b75-platform-support-engineer-l1/apply'), 'breezy');
  assert.equal(detectPortal('https://recruiting.breezy.hr/p/05c7fcbfad27-welding-engineer/apply'), 'breezy');
  assert.equal(detectPortal('https://prentkeromich.bamboohr.com/careers/480'), 'bamboohr');
  assert.equal(detectPortal('https://jobs.jobvite.com/ness/job/o3mfAfwY/apply'), 'jobvite');
  assert.equal(detectPortal('https://jobs-express.icims.com/jobs/48173/sales-associate/job'), 'icims');
  assert.equal(
    detectPortal('https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/333913'),
    'oraclecloud',
  );
  assert.equal(
    detectPortal('https://recruiting.ultipro.com/she1011sphs/JobBoard/62d52737-46c1-4699-83e3-3a1747e3b981'),
    'ultipro',
  );
});

test('Greenhouse fixed actions include semantic and label fallbacks for first name', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const firstNameFill = actions.find((action) => action.label === 'first_name');
  assert.equal(firstNameFill?.type, 'fill');
  assert.match(firstNameFill?.selector ?? '', /autocomplete="given-name"/);
  assert.match(firstNameFill?.selector ?? '', /aria-label="First Name"/);

  const firstNameByLabel = actions.find((action) => action.label === 'first_name_label');
  assert.deepEqual(
    {
      type: firstNameByLabel?.type,
      text: firstNameByLabel?.text,
      value: firstNameByLabel?.value,
      optional: firstNameByLabel?.optional,
    },
    { type: 'fillByLabelText', text: 'First Name', value: 'Taylor', optional: true },
  );
});

test('Greenhouse managed actions open branded job pages and clear cookie overlays before filling', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const openFormIndex = actions.findIndex((action) => action.label === 'greenhouse_open_application_form');
  const firstNameIndex = actions.findIndex((action) => action.label === 'first_name');
  assert.ok(openFormIndex >= 0, 'Greenhouse managed run must click the branded apply button when present');
  assert.ok(firstNameIndex > openFormIndex, 'Greenhouse form entry must happen before fixed-field filling');
  assert.ok(actions.some((action) => action.selector === '#onetrust-accept-btn-handler'));
  assert.ok(actions.some((action) => action.selector?.includes('Allow All')));
  assert.ok(actions.some((action) => action.label === 'greenhouse_application_form_ready'));
});

test('Greenhouse fixed actions include semantic and label fallbacks for last name and email', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const lastNameFill = actions.find((action) => action.label === 'last_name');
  assert.equal(lastNameFill?.type, 'fill');
  assert.match(lastNameFill?.selector ?? '', /autocomplete="family-name"/);
  assert.match(lastNameFill?.selector ?? '', /aria-label="Last Name"/);

  const lastNameByLabel = actions.find((action) => action.label === 'last_name_label');
  assert.deepEqual(
    {
      type: lastNameByLabel?.type,
      text: lastNameByLabel?.text,
      value: lastNameByLabel?.value,
      optional: lastNameByLabel?.optional,
    },
    { type: 'fillByLabelText', text: 'Last Name', value: 'Example', optional: true },
  );

  const emailFill = actions.find((action) => action.label === 'email');
  assert.equal(emailFill?.type, 'fill');
  assert.match(emailFill?.selector ?? '', /type="email"/);
  assert.match(emailFill?.selector ?? '', /autocomplete="email"/);

  const emailByLabel = actions.find((action) => action.label === 'email_label');
  assert.deepEqual(
    {
      type: emailByLabel?.type,
      text: emailByLabel?.text,
      value: emailByLabel?.value,
      optional: emailByLabel?.optional,
    },
    { type: 'fillByLabelText', text: 'Email', value: 'taylor@example.com', optional: true },
  );
});

test('Greenhouse resume upload includes modern semantic file-input fallbacks', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const upload = actions.find((action) => action.label === 'resume');
  assert.equal(upload?.type, 'upload');
  assert.match(upload?.selector ?? '', /id\*="resume"/);
  assert.match(upload?.selector ?? '', /name\*="resume"/);
  assert.match(upload?.selector ?? '', /aria-label\*="resume"/);
  assert.doesNotMatch(upload?.selector ?? '', /cover_letter/);
});

test('Greenhouse managed actions retry known yes-no work and onsite choices by exact portal labels', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'Are you currently eligible to legally work in the US?', answer: 'Yes' },
      { question: 'Are you legally authorized to work in the country where the job is located?', answer: 'Yes' },
      { question: 'Will you now or in the future require immigration support/sponsorship?', answer: 'Yes' },
      { question: 'Are you able to work onsite in our San Francisco office 5 days a week?', answer: 'Yes' },
      {
        question:
          'Will you now, or will you in the future, require immigration sponsorship to work at this company in the United States?',
        answer: 'Yes',
      },
      { question: 'Do you consent to the terms?', answer: 'Yes' },
    ],
  });
  const aliasActions = actions.filter((action) => action.label?.startsWith('greenhouse_known_question:'));
  assert.ok(aliasActions.length >= 8);
  assert.ok(aliasActions.every((action) => action.type === 'fillByLabelText'));
  assert.ok(aliasActions.every((action) => action.value === 'Yes'));
  assert.ok(aliasActions.every((action) => action.optional === true));
  assert.ok(aliasActions.some((action) => action.text === 'Are you currently eligible to legally work in the United States?'));
  assert.ok(aliasActions.some((action) => action.text === 'Are you legally authorized to work in the country where the job is located?'));
  assert.ok(aliasActions.some((action) => action.text === 'Will you now or in the future require immigration support or sponsorship from Postman?'));
  assert.ok(aliasActions.some((action) => action.text === 'Are you able to work onsite in our San Francisco office 5 days a week?'));
  assert.equal(aliasActions.some((action) => action.text === 'Are you able to work onsite four days a week?'), false);
  assert.equal(aliasActions.some((action) => action.text === 'Do you consent to the terms?'), false);

  const selectActions = actions.filter((action) => action.label?.startsWith('greenhouse_known_select'));
  assert.equal(selectActions.length, 0);
  assert.equal(
    actions.filter((action) =>
      action.type === 'click'
      && !isGreenhousePreflightClick(action)
      && !action.label?.startsWith('education_school_combo_label')
      && !action.label?.startsWith('question_combo_label:')).length,
    0,
  );
});

test('managed reviewed questions replay stored answers into label-scoped choice controls', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    ...capturePacket,
    questions: [
      { question: 'Are you currently enrolled in a degree program?', answer: 'Yes' },
      { question: 'Graduation Year', answer: '2028' },
      { question: 'Are you able to work onsite 4 days a week?', answer: 'Yes' },
    ],
  });

  const scoped = actions.filter((action) => action.label?.startsWith('question:'));
  assert.ok(scoped.some((action) => action.type === 'fillByLabelText' && action.text === 'Are you currently enrolled in a degree program?'));
  assert.ok(scoped.some((action) => action.type === 'fillByLabelText' && action.text === 'Graduation Year'));
  assert.ok(scoped.some((action) => action.type === 'fillByLabelText' && action.text === 'Are you able to work onsite 4 days a week?'));

  const selects = actions.filter((action) => action.label?.startsWith('question_select:'));
  assert.ok(selects.some((action) => action.type === 'select' && action.value === '1'));
  assert.ok(selects.some((action) => action.type === 'select' && action.value === 'true'));
  assert.ok(selects.some((action) => action.type === 'select' && action.value === '2028'));
  assert.ok(selects.every((action) => (action.selector?.length ?? Infinity) <= 500));
});

test('Greenhouse managed actions stay inside the Stratus action budget on Reddit-style packets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    city: 'Dubai, United Arab Emirates',
    country: 'United Arab Emirates',
    linkedinUrl: 'https://www.linkedin.com/in/mehekmandal',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'Mehek_Mandal_Staff_Product_Manager_Ads_Trust_and_Safety_Resume.pdf',
    coverLetter: Buffer.from('cover-pdf'),
    coverLetterName: 'Mehek_Mandal_Staff_Product_Manager_Ads_Trust_and_Safety_Cover_Letter.pdf',
    eeoPrefs: {
      gender: "I don't wish to answer",
      transgender_status: "I don't wish to answer",
      sexual_orientation: "I don't wish to answer",
      disability_status: "I don't wish to answer",
      veteran_status: "I don't wish to answer",
      race: "I don't wish to answer",
    },
    questions: [
      { question: 'How did you hear about this job?', answer: 'Company website' },
      {
        question: 'Briefly describe your experience with Ads Review/Ads Trust and Safety',
        answer: 'I have built and operated AI product workflows with review loops and operational controls.',
      },
      { question: 'Are you currently eligible to legally work in the United States?', answer: 'Yes' },
      { question: 'Will you now or in the future require immigration support or sponsorship?', answer: 'Yes' },
      { question: 'I agree to the Candidate Privacy Policy', answer: 'I agree' },
      { question: 'Are you a person of transgender experience?', answer: "I don't wish to answer" },
      { question: 'What gender identity do you most closely identify with?', answer: "I don't wish to answer" },
      { question: 'What sexual orientation do you most closely identify with?', answer: "I don't wish to answer" },
      { question: 'Do you live with a disability (as outlined by the ADA)?', answer: "I don't wish to answer" },
      { question: 'Are you a veteran/have you served in the military?', answer: "I don't wish to answer" },
      { question: 'Please select up to 2 ethnicities that you most closely identify with.', answer: "I don't wish to answer" },
    ],
  }, true);

  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
  assert.equal(actions.some((action) => action.label?.startsWith('greenhouse_known_select:')), false);
  assert.ok(actions.some((action) =>
    action.label?.startsWith('question_combo_label:')
    && action.label.includes('gender identity')));
  assert.equal(actions.some((action) => action.label?.startsWith('greenhouse_demographic_select:')), false);
  assert.equal(actions.some((action) => action.text === 'I agree to the Candidate Privacy Policy'), false);
  assert.ok(
    actions.every((action) => !action.selector || action.selector.length <= 500),
    'Stratus rejects selector strings longer than 500 characters',
  );
});

test('Greenhouse managed actions stay inside the Stratus action budget on Nuro-style onsite packets', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    city: 'Dubai, United Arab Emirates',
    country: 'United Arab Emirates',
    linkedinUrl: 'https://www.linkedin.com/in/mehekmandal/',
    portfolioUrl: 'https://github.com/mehek-builds',
    resume: Buffer.from('resume-pdf'),
    resumeName: 'Mehek_Mandal_Software_Engineer_AI_Platform_Intern_Resume.pdf',
    coverLetter: Buffer.from('cover-pdf'),
    coverLetterName: 'Mehek_Mandal_Software_Engineer_AI_Platform_Intern_Cover_Letter.pdf',
    questions: [
      { question: 'LinkedIn Profile', answer: 'https://www.linkedin.com/in/mehekmandal/' },
      { question: 'Website', answer: 'https://github.com/mehek-builds' },
      { question: 'Are you authorized to work in the country in which you are applying?', answer: 'Yes' },
      {
        question: 'Do you now, or will you in the future, require sponsorship for employment in the country which you are applying?',
        answer: 'Yes',
      },
      {
        question:
          'This position is hybrid and requires 4 days a week in office, including Thursdays in our Mountain View, CA headquarters and the remaining 3 days in either Mountain View or our San Francisco, CA office. Are you able to meet this requirement?',
        answer: 'Yes',
      },
    ],
  }, true);

  const onsiteAliases = actions.filter((action) =>
    action.label?.startsWith('greenhouse_known_question:')
    && /onsite|on-site/i.test(action.text ?? ''),
  );
  assert.equal(onsiteAliases.length, 4);
  assert.ok(onsiteAliases.every((action) => /four|4/.test(action.text ?? '')));
  assert.ok(actions.length <= 120, `expected at most 120 actions, got ${actions.length}`);
});

test('the QA harness routes to the three new controlled adapters, by query param and by path', () => {
  const previous = process.env.LITOS_ENABLE_TEST_PORTAL;
  process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
  for (const board of ['rippling', 'breezy', 'bamboohr'] as const) {
    assert.equal(detectPortal(`https://trylitos.com/qa/portal-submission?board=${board}`), `controlled_${board}`);
    assert.equal(detectPortal(`https://trylitos.com/qa/portal-submission/${board}/${board}-01`), `controlled_${board}`);
  }
  if (previous === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
  else process.env.LITOS_ENABLE_TEST_PORTAL = previous;
});

test('the three new controlled variants exercise their live family’s selectors exactly', () => {
  // A fixture that drifts from the production selectors proves nothing about production.
  for (const [controlled, live] of [
    ['controlled_rippling', 'rippling'],
    ['controlled_breezy', 'breezy'],
    ['controlled_bamboohr', 'bamboohr'],
  ] as const) {
    assert.equal(portalCanAutoSubmit(controlled), portalCanAutoSubmit(live), controlled);
    assert.equal(portalHandoffReason(controlled), portalHandoffReason(live), controlled);
    assert.deepEqual(
      buildManagedPortalActions(controlled, capturePacket, false).map((a) => a.selector),
      buildManagedPortalActions(live, capturePacket, false).map((a) => a.selector),
      controlled,
    );
  }
});

test('no portal claims it can take a cover-letter file it has no input for', () => {
  // Breezy takes long-form text as textarea[name="cSummary"] and BambooHR's captured form had exactly
  // one file input (the resume). Declaring a real-looking cover-letter selector for either would make
  // hasCoverLetterUpload answer yes and attach a PDF to a control that cannot hold one - the same
  // reasoning as the JazzHR textarea note.
  for (const portal of ['breezy', 'bamboohr', 'jobvite', 'icims', 'oraclecloud', 'ultipro'] as const) {
    assert.match(coverLetterUploadSelector(portal), /DoesNotExist|noForm|NoForm/, portal);
  }
  // Rippling genuinely has one, read off the live form alongside the resume input.
  assert.equal(coverLetterUploadSelector('rippling'), 'input[type="file"][data-testid="input-cover_letter"]');
});

test('a third-party handoff is never mistaken for the submit button', () => {
  /* EVERY LABEL BELOW IS REAL, and the first two were read off SmartRecruiters' live first step on
     2026-08-04, before the applicant has typed anything. Greenhouse and Lever render the LinkedIn
     one and both are autonomous today, so this was a live risk rather than a hypothetical. */
  for (const label of [
    'Apply With Indeed',
    'Apply with SEEK',
    'Apply with LinkedIn',
    'Apply using LinkedIn',
    'Autofill with Greenhouse',
    'Sign in with Google',
    'Continue with LinkedIn',
    'Quick Apply',
    'One-click apply',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('the real submit control is still found, and preferred over a bare Apply', () => {
  assert.equal(chooseSubmitControl(['Submit application']), 0);
  assert.equal(chooseSubmitControl(['Submit']), 0);
  assert.equal(chooseSubmitControl(['Apply']), 0);
  assert.equal(chooseSubmitControl(['Apply now']), 0);
  assert.equal(chooseSubmitControl(['Send my application']), 0);

  // A page carrying both: the explicit submit wins wherever it sits.
  assert.equal(chooseSubmitControl(['Apply with LinkedIn', 'Submit application']), 1);
  assert.equal(chooseSubmitControl(['Submit application', 'Apply with Indeed']), 0);
  assert.equal(chooseSubmitControl(['Apply', 'Submit application']), 1, 'explicit beats bare apply');
  // The form's real submit sits at its foot, so the last eligible control wins among equals.
  assert.equal(chooseSubmitControl(['Submit', 'Submit application']), 1);
});

test('a step that only offers Next is not submittable, which is the multi-step guarantee', () => {
  /* SmartRecruiters' first step, verbatim from the live DOM on 2026-08-04. There is no submit
     control here at all, and the only primary button says Next. A run that pressed anything on this
     page would either hand off to Indeed or advance a step while reporting a submission. */
  const smartRecruitersStepOne = [
    'Apply With Indeed', 'Apply with SEEK', 'Add', 'Add', 'Next', 'Cookies Settings',
  ];
  assert.equal(chooseSubmitControl(smartRecruitersStepOne), null);
  // Next and Continue are never submit controls anywhere.
  assert.equal(chooseSubmitControl(['Next']), null);
  assert.equal(chooseSubmitControl(['Continue']), null);
  assert.equal(chooseSubmitControl(['Next Step']), null, "Paylocity's #btn-submit reads Next Step");
});

test('labels that merely contain the word apply are not submit controls', () => {
  assert.equal(chooseSubmitControl(['Why do you want to apply?']), null);
  assert.equal(chooseSubmitControl(['Learn how to apply']), null);
  assert.equal(chooseSubmitControl([]), null);
  assert.equal(chooseSubmitControl(['', '   ']), null);
});

test('a provider name in the label is a handoff however the sentence is arranged', () => {
  /* The verb-shape test is escapable: a word between the verb and "with" defeats it, and
     "Apply now" is itself a legitimate submit label, so these sailed through into the eligible
     pool. Naming the providers cannot be worded around - no employer's own submit button carries
     a job board's name. */
  for (const label of [
    'Apply now with LinkedIn',
    'Apply Now with Indeed',
    'Submit with LinkedIn',
    'Submit your application via Indeed',
    'Apply through SEEK',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
  // And the genuine ones are untouched by the provider backstop.
  assert.equal(chooseSubmitControl(['Apply now']), 0);
  assert.equal(chooseSubmitControl(['Submit your application']), 0);
});

test('an employer named after a job board still has a submit button', () => {
  /* HANDOFF_PROVIDER used to match a provider word ANYWHERE in the label, which rejected these.
     Several of those words are also employer names, and failing here costs a real submission. */
  assert.equal(chooseSubmitControl(['Submit your application to Apple']), 0);
  assert.equal(chooseSubmitControl(['Submit application to Google']), 0);
  assert.equal(chooseSubmitControl(['Submit application - Monster Beverage']), 0);
  // A provider in an actual handoff position is still rejected.
  assert.equal(chooseSubmitControl(['Apply with LinkedIn']), null);
  assert.equal(chooseSubmitControl(['Continue with Google']), null);
  assert.equal(chooseSubmitControl(['Quick Apply with MyGreenhouse']), null);
});

test('a support widget that says submit does not win over the application', () => {
  /* Intercom and Zendesk render these as [role=button] at the FOOT of the page, so they sort after
     the real control and the last-wins rule would hand them the click - which submits nothing and
     then tells the applicant to go check her email. Both labels are live on careers pages. */
  assert.equal(chooseSubmitControl(['Submit application', 'Submit feedback']), 0);
  assert.equal(chooseSubmitControl(['Submit application', 'Submit a request']), 0);
  assert.equal(chooseSubmitControl(['Submit', 'Submit your application']), 1,
    'naming the application beats a bare submit wherever it sits');
});

/* A local copy of SUBMIT_LABEL's shape, so the test can assert its own premise: that each label
   below really does reach the handoff filter rather than being rejected earlier. */
const SUBMIT_LABEL_FOR_TEST =
  /\bsubmit\b|\bsend (?:my )?application\b|^\s*apply\s*$|\bapply now\b|\bfinish (?:and|&) apply\b/i;

test('the handoff filters are load-bearing, not decoration', () => {
  /* THE PREVIOUS HANDOFF TESTS WERE TAUTOLOGICAL, which a review pass proved empirically: delete
     both THIRD_PARTY_HANDOFF and HANDOFF_PROVIDER from chooseSubmitControl and 69 of 70 tests still
     passed, because every label tested also failed SUBMIT_LABEL and so was rejected anyway.
     Every label below MATCHES SUBMIT_LABEL. The handoff filters are the only thing standing between
     them and a click, so deleting either regex has to fail this test. */
  for (const label of [
    'Submit application with LinkedIn',
    'Submit your application via SEEK',
    'Apply now using Indeed',
    'Apply now with LinkedIn',
    'Finish and apply with Greenhouse',
    'Submit application using Google',
  ]) {
    assert.match(label, SUBMIT_LABEL_FOR_TEST, `${label} must reach the handoff filter to test it`);
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('an icon button with no text is not a submit control', () => {
  /* HTMLButtonElement.type defaults to "submit" and its value to "", so keying the UA-default
     fallback off `type` alone made every text-free icon button read as "Submit" - chat launchers,
     scroll-to-top, cookie close - all of which sit at the FOOT of the page where last-wins looks. */
  assert.equal(chooseSubmitControl(['']), null);
  assert.equal(chooseSubmitControl(['Submit application', '']), 0);
});

test('a help-desk widget is never pressed, even when it is the only submit-ish control', () => {
  /* Excluding support widgets only inside the explicit tier left two holes. */
  assert.equal(chooseSubmitControl(['Apply now', 'Submit feedback']), 0,
    'a real control that never says "submit" still beats the widget');
  assert.equal(chooseSubmitControl(['Submit a request']), null,
    'a page whose only submit-ish control is a help desk has no submit control');
  assert.equal(chooseSubmitControl(['Submit feedback']), null);
});

test('a handoff to a platform we do not name by hand is still a handoff', () => {
  /* Pins THIRD_PARTY_HANDOFF specifically. The previous load-bearing test named a provider in every
     label, so deleting THIRD_PARTY_HANDOFF alone left the suite green and only HANDOFF_PROVIDER was
     actually covered. No label here names a listed provider, so the verb-shape rule is the only
     thing that can reject them. */
  for (const label of [
    'Apply now with Handshake',
    'Apply now using Symplicity',
    'Submit application with your university account',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('a handoff to a board we never named is still a handoff', () => {
  /* THE REGRESSION THAT ROUND SIX CAUGHT. An earlier round required the handoff OBJECT to be a
     provider from a hard-coded list, which let every board not on it through - all of these were
     pressable. A roster of somebody-elses can only ever be incomplete; the closed set is the short
     list of things a button legitimately carries, which is your own documents. */
  for (const label of [
    'Apply now with Wellfound',
    'Apply now with Dice',
    'Apply now with our partner',
    'Apply now with Career Services',
    'Apply now with single sign-on',
    'Submit application with our recruiting partner',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('a provider named far from the verb is still a handoff', () => {
  /* Pins HANDOFF_PROVIDER specifically. Once "submit" became a handoff verb, every provider label
     in the other tests was caught by the verb-shape rule instead, so deleting HANDOFF_PROVIDER left
     the suite green. These put enough words between the verb and the preposition that only the
     provider list can reject them. */
  for (const label of [
    'Submit your saved candidate profile with Handshake',
    'Submit the completed application form with LinkedIn',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
  // And a branding tail, which names no verb at all.
  assert.equal(chooseSubmitControl(['Apply now - powered by Handshake']), null);
});

test('the student platforms are named, because those are the ones our users meet', () => {
  /* "Submit with your Handshake profile" passed BOTH filters: submit was not a handoff verb and
     Handshake was not a named provider. Handshake is the dominant platform for the students this
     product is for, so that was the worst possible gap to leave. */
  for (const label of [
    'Submit with your Handshake profile',
    'Submit application via Workable',
    'Submit application with SSO',
    'Apply with Symplicity',
  ]) {
    assert.equal(chooseSubmitControl([label]), null, `${label} must not be pressed`);
  }
});

test('help-desk wording is matched by word, not by exact phrase', () => {
  for (const widget of [
    'Submit a support request', 'Submit your question', 'Submit an issue',
    'Submit review', 'Submit rating', 'Submit a bug report',
  ]) {
    assert.equal(chooseSubmitControl(['Apply now', widget]), 0, `${widget} must not win`);
    assert.equal(chooseSubmitControl([widget]), null, `${widget} alone is not a submit control`);
  }
});

test('a primary "Apply now" outranks a bare footer "Apply"', () => {
  assert.equal(chooseSubmitControl(['Apply now', 'Apply']), 0);
  assert.equal(chooseSubmitControl(['Apply', 'Apply now']), 1);
});

test('READ_CONTROL_LABEL reads the element, and the tag gate is the load-bearing part', () => {
  /* Tested DIRECTLY, because every previous test sat downstream of the reader and would have
     passed unchanged if it regressed to calling every bare <button> "Submit". */
  const node = (over: Record<string, unknown>) => ({
    innerText: '', value: '', title: '', disabled: false, type: '', tagName: 'BUTTON',
    getAttribute: (name: string) => (over[name] as string | undefined) ?? null,
    getClientRects: () => ({ length: 1 }),
    parentElement: null,
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ visibility: 'visible' }) },
      getElementById: () => null,
    },
    ...over,
  });

  // THE headline fix: HTMLButtonElement.type defaults to 'submit' and value to ''.
  assert.equal(READ_CONTROL_LABEL(node({ tagName: 'BUTTON', type: 'submit' })), '',
    'a text-free icon button is not labelled "Submit"');
  // The case the UA default exists for.
  assert.equal(READ_CONTROL_LABEL(node({ tagName: 'INPUT', type: 'submit' })), 'Submit');
  // input[type=image] takes its accessible name from alt.
  assert.equal(READ_CONTROL_LABEL(node({ tagName: 'INPUT', type: 'image', alt: 'Submit application' })),
    'Submit application');
  // aria-disabled is the only disabled a [role=button] div can express.
  assert.equal(READ_CONTROL_LABEL(node({
    tagName: 'DIV', innerText: 'Submit application', 'aria-disabled': 'true',
  })), '');
  // visibility:hidden keeps its client rects, so it needs its own check.
  assert.equal(READ_CONTROL_LABEL({
    ...node({ tagName: 'BUTTON', innerText: 'Submit application' }),
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ visibility: 'hidden' }) },
      getElementById: () => null,
    },
  }), '');
  // aria-hidden hides a whole subtree, not just the node carrying it.
  assert.equal(READ_CONTROL_LABEL({
    ...node({ tagName: 'BUTTON', innerText: 'Submit application' }),
    parentElement: { getAttribute: (n: string) => (n === 'aria-hidden' ? 'true' : null), parentElement: null },
  }), '');
  // And the ordinary case still reads.
  assert.equal(READ_CONTROL_LABEL(node({ innerText: 'Submit application' })), 'Submit application');
});

test('a legitimate submit label is not rejected as a handoff', () => {
  /* The widened handoff verbs (submit, send) turned "<verb> ... with|using|via" into a rejection,
     which caught perfectly ordinary buttons. None of these appear on the four portals we poll
     today, so it was latent rather than live - which is precisely why it needed a test before it
     became live on the next portal added. */
  for (const label of [
    'Submit application with attachments',
    'Submit your application with cover letter',
    'Submit with resume attached',
    'Send application from your profile',
    'Submit application for review',
    'Submit your application - Contact Center Agent',
  ]) {
    assert.notEqual(chooseSubmitControl([label]), null, `${label} must still be pressable`);
  }
  /* "Review and submit" is DELIBERATELY still rejected, and it is the one case worth arguing over.
     It reads like a submit, but on a multi-step form it is the button that leads to a review step -
     a Next wearing a submit's clothes, which is the single failure this module treats as worse than
     not supporting a portal at all. Failing safe here costs a handoff; guessing costs a "submitted"
     state for an application nobody received. */
  assert.equal(chooseSubmitControl(['Review and submit']), null);
});

test('the two application-wordings agree, because they used to be copies that drifted', () => {
  // SUBMIT_LABEL required "send my application" while APPLICATION_SUBMIT allowed "your", so this
  // failed eligibility outright even though the strongest tier would have taken it.
  assert.equal(chooseSubmitControl(['Send your application']), 0);
  assert.equal(chooseSubmitControl(['Send my application']), 0);
  assert.equal(chooseSubmitControl(['Send the application']), 0);
});

test('a help desk scoped to the application is still a help desk', () => {
  /* Exempting any label containing "application" put this back: the feedback widget reached the
     top tier on its prefix and, on last-wins, beat the real submit control. */
  assert.equal(chooseSubmitControl(['Submit application', 'Submit application feedback']), 0);
  assert.equal(chooseSubmitControl(['Submit application', 'Submit application survey']), 0);
  assert.equal(chooseSubmitControl(['Submit application feedback']), null);
  assert.equal(chooseSubmitControl(['Submit feedback on your application']), null);
  // And a job title carrying one of the widget nouns is still pressable.
  assert.equal(chooseSubmitControl(['Submit your application - Contact Center Agent']), 0);
});

test('your own saved profile is not somebody else’s platform', () => {
  // The bare possessive is your details on this site; an intervening name is the handoff.
  assert.notEqual(chooseSubmitControl(['Send application from your profile']), null);
  assert.notEqual(chooseSubmitControl(['Submit application with your saved details']), null);
  assert.equal(chooseSubmitControl(['Submit with your Handshake profile']), null);
  assert.equal(chooseSubmitControl(['Submit your saved candidate profile with Handshake']), null);
});
