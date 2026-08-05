import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from 'playwright-core';
import {
  AUTONOMOUS_PORTAL_FAMILIES,
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  canFillReviewedQuestions,
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

test('detects the four supported applicant portal families', () => {
  assert.equal(detectPortal('https://boards.greenhouse.io/acme/jobs/123'), 'greenhouse');
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
  assert.equal(actions.some((a) => a.type === 'click'), false);
  const fillSelectors = actions.filter((a) => a.type === 'fill').map((a) => a.selector);
  assert.ok(fillSelectors.some((s) => s?.includes('first_name')));
  assert.equal(actions.some((a) => a.type === 'fillByLabelText' && a.label === 'first_name_label'), true);
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
  assert.deepEqual(actions.map((action) => action.type), [
    'fill', 'fillByLabelText', 'fill', 'fill', 'upload', 'fillByLabelText', 'click',
  ]);
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
  // the two questions.
  assert.deepEqual(actions.map((a) => a.type), [
    'fill', 'fillByLabelText', 'fill', 'fill', 'upload', 'fillByLabelText', 'fillByLabelText',
  ]);
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
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  });
  const byLabel = actions.filter((action) => action.type === 'fillByLabelText' && !action.label?.startsWith('first_name'));
  assert.deepEqual(
    byLabel.map((action) => [action.text, action.value, action.label]),
    [
      ['School', 'University of Southern California', 'education_school'],
      ['Degree', 'Bachelor of Science in Computer Science', 'education_degree'],
      ['What is your graduation date?', 'May 2028', 'graduation_date'],
      ['End date month', 'May', 'education_end_month'],
      ['End date year', '2028', 'education_end_year'],
      ['GPA', '3.89', 'gpa'],
    ],
  );
  assert.ok(byLabel.every((action) => action.optional === true));
  assert.ok(byLabel.every((action) => (action.timeout ?? Infinity) < 30_000));
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
  const clicks = actions.filter((action) => action.type === 'click');
  assert.equal(clicks.length, 0, 'no click action may be synthesized from an answer string');
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

test('Greenhouse managed actions retry known yes-no work and onsite choices by exact portal labels', () => {
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Taylor Example',
    email: 'taylor@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [
      { question: 'Are you currently eligible to legally work in the US?', answer: 'Yes' },
      { question: 'Will you now or in the future require immigration support/sponsorship?', answer: 'Yes' },
      { question: 'Are you able to work onsite in our San Francisco office 5 days a week?', answer: 'Yes' },
      { question: 'Do you consent to the terms?', answer: 'Yes' },
    ],
  });
  const aliasActions = actions.filter((action) => action.label?.startsWith('greenhouse_known_question:'));
  assert.ok(aliasActions.length >= 8);
  assert.ok(aliasActions.every((action) => action.type === 'fillByLabelText'));
  assert.ok(aliasActions.every((action) => action.value === 'Yes'));
  assert.ok(aliasActions.every((action) => action.optional === true));
  assert.ok(aliasActions.some((action) => action.text === 'Are you currently eligible to legally work in the United States?'));
  assert.ok(aliasActions.some((action) => action.text === 'Will you now or in the future require immigration support or sponsorship from Postman?'));
  assert.ok(aliasActions.some((action) => action.text === 'Are you able to work onsite in our San Francisco office 5 days a week?'));
  assert.equal(aliasActions.some((action) => action.text === 'Do you consent to the terms?'), false);

  const selectActions = actions.filter((action) => action.label?.startsWith('greenhouse_known_select'));
  assert.ok(selectActions.length >= aliasActions.length * 2);
  assert.ok(selectActions.every((action) => action.type === 'select'));
  assert.ok(selectActions.every((action) => action.optional === true));
  assert.ok(selectActions.some((action) => action.value === 'Yes'));
  assert.ok(selectActions.some((action) => action.value === '1'));
  assert.ok(selectActions.some((action) => action.selector?.includes('.field:has(label:has-text("Are you currently eligible to legally work in the United States?")) select')));
  assert.equal(selectActions.some((action) => action.selector?.includes('Do you consent to the terms?')), false);
  assert.equal(actions.filter((action) => action.type === 'click').length, 0);
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
