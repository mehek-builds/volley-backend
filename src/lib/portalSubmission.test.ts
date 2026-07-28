import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildManagedDiscoveryActions,
  buildManagedPortalActions,
  canFillReviewedQuestions,
  coverLetterUploadSelector,
  detectPortal,
  isChoiceQuestion,
  isPaylocityTerminalStep,
  managedResultHasCoverLetterUpload,
  portalApplicationUrl,
  portalCanAutoSubmit,
  portalHandoffReason,
  readManagedReceipt,
} from './portalSubmission';

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
  assert.equal(actions.some((a) => a.type === 'fillByLabelText'), false);
  assert.equal(actions.some((a) => a.type === 'click'), false);
  const fillSelectors = actions.filter((a) => a.type === 'fill').map((a) => a.selector);
  assert.ok(fillSelectors.some((s) => s?.includes('first_name')));
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
    assert.equal(actions.at(-1)?.type, 'click');
  }
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
