import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedPortalActions,
  canFillReviewedQuestions,
  detectPortal,
  isChoiceQuestion,
  portalApplicationUrl,
  readManagedReceipt,
} from './portalSubmission';

test('detects the four supported applicant portal families', () => {
  assert.equal(detectPortal('https://boards.greenhouse.io/acme/jobs/123'), 'greenhouse');
  assert.equal(detectPortal('https://jobs.lever.co/acme/123/apply'), 'lever');
  assert.equal(detectPortal('https://jobs.ashbyhq.com/acme/123/application'), 'ashby');
  assert.equal(detectPortal('https://jobs.smartrecruiters.com/Acme/744000-role'), 'smartrecruiters');
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
  assert.ok(fillSelectors.includes('#first-name-input'));
  assert.ok(fillSelectors.includes('#email-input'));
  assert.ok(fillSelectors.includes('#confirm-email-input'));
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
  assert.throws(() => detectPortal('http://boards.greenhouse.io/acme/jobs/123'), /HTTPS/);
  assert.throws(() => detectPortal('https://greenhouse.io.attacker.example/acme'), /not supported/);
  assert.throws(() => detectPortal('https://example.com/apply'), /not supported/);
});

test('controlled portal is gated by an explicit server flag', () => {
  const previous = process.env.LITOS_ENABLE_TEST_PORTAL;
  delete process.env.LITOS_ENABLE_TEST_PORTAL;
  assert.throws(() => detectPortal('https://trylitos.com/qa/portal-submission'), /not supported/);
  process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
  assert.equal(detectPortal('https://trylitos.com/qa/portal-submission'), 'controlled_test');
  if (previous === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
  else process.env.LITOS_ENABLE_TEST_PORTAL = previous;
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
    'fill', 'fill', 'fill', 'upload', 'fillByLabelText', 'click',
  ]);
  assert.equal(actions.find((action) => action.type === 'upload')?.file?.base64, 'cGRm');
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
  assert.throws(() => readManagedReceipt({ title: 'Form', url: 'https://example.com', text: 'Apply now' }), /verifiable/);
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
  const questionActions = actions.filter((action) => action.type === 'fillByLabelText');
  assert.equal(questionActions.length, 2);
  for (const action of questionActions) {
    assert.equal(action.optional, true, `"${action.text}" must not be able to abort the run`);
  }
  // first_name, last_name, email (phone and location are omitted from this fixture), resume, then
  // the two questions.
  assert.deepEqual(actions.map((a) => a.type), [
    'fill', 'fill', 'fill', 'upload', 'fillByLabelText', 'fillByLabelText',
  ]);
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
