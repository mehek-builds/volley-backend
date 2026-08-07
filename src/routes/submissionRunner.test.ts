import assert from 'node:assert/strict';
import test from 'node:test';
import {
  attentionCategoriesForReasons,
  applicationContextForQuestionResolution,
  attentionBlockersForManagedResult,
  atsApiSubmissionEnabled,
  discoverAndResolveQuestions,
  isProviderSessionFailureMessage,
  preparationEvidenceBlockers,
  reconcileManagedProviderBlockers,
  readMostRecentRole,
  sanitizeEeoPrefs,
  shouldUseLocalControlledBrowser,
  submissionFailureOutcome,
  submissionGraduationDateParts,
  type ResumeRow,
} from './submissionRunner';
import { workEligibilityFromSponsorshipAnswer } from '../lib/applicationProfileLike';
import type { ApplicationReviewState } from '../lib/applicationReview';

// readMostRecentRole runs inside buildPacket, which every prepare and every submit goes through -
// on EVERY portal, not just the one that needs work history. So its failure mode is not "Paylocity
// misses a field", it is "one malformed parsed resume breaks Greenhouse, Lever and Ashby too".
// Review found it threw a TypeError on a null entry; these pin the whole shape.

test('a profile with no usable experience yields undefined rather than throwing', () => {
  assert.equal(readMostRecentRole({}), undefined);
  assert.equal(readMostRecentRole({ experience: undefined }), undefined);
  assert.equal(readMostRecentRole({ experience: [] }), undefined);
  assert.equal(readMostRecentRole({ experience: 'Traeco' }), undefined);
  assert.equal(readMostRecentRole({ experience: {} }), undefined);
});

test('a malformed first entry never throws, because it would break every other portal too', () => {
  for (const entry of [null, undefined, 'a string', 42, ['nested']]) {
    assert.doesNotThrow(() => readMostRecentRole({ experience: [entry] }), `entry: ${JSON.stringify(entry)}`);
    assert.equal(readMostRecentRole({ experience: [entry] }), undefined);
  }
});

test('a partial entry is dropped, since half a work-history row is worse than none', () => {
  assert.equal(readMostRecentRole({ experience: [{ company: 'Traeco' }] }), undefined);
  assert.equal(readMostRecentRole({ experience: [{ title: 'Engineer' }] }), undefined);
  assert.equal(readMostRecentRole({ experience: [{ company: '   ', title: 'Engineer' }] }), undefined);
  assert.equal(readMostRecentRole({ experience: [{ company: 42, title: 'Engineer' }] }), undefined);
});

test('org is the fallback for company, and the FIRST entry wins because resumes are written newest-first', () => {
  assert.deepEqual(
    readMostRecentRole({ experience: [{ org: 'Traeco', title: 'Engineer' }] }),
    { company: 'Traeco', title: 'Engineer', summary: undefined, startDate: undefined, endDate: undefined },
  );
  const two = readMostRecentRole({ experience: [
    { company: 'Now Co', org: 'Ignored', title: 'Founding Engineer', start: 'Jun 2025', end: 'Present', description: 'Built it.' },
    { company: 'Old Co', title: 'Intern' },
  ] });
  assert.equal(two?.company, 'Now Co');
  assert.equal(two?.startDate, 'Jun 2025');
  assert.equal(two?.summary, 'Built it.');
});

test('submission graduation parts use the end of an education range', () => {
  assert.deepEqual(submissionGraduationDateParts('August 2024 - May 2028', undefined), {
    month: 'May',
    year: '2028',
  });
  assert.deepEqual(submissionGraduationDateParts('August 2024 - 2028-05-15', undefined), {
    month: 'May',
    year: '2028',
  });
  assert.deepEqual(submissionGraduationDateParts('2024-08-15 - 2028-05-15', undefined), {
    month: 'May',
    year: '2028',
  });
  assert.deepEqual(submissionGraduationDateParts('August 2024 - May 2028', 2029), {
    month: 'May',
    year: '2029',
  });
});

test('CAPTCHA blocker display hides empty fields only when preview shows selected values', () => {
  const blockers = attentionBlockersForManagedResult(
    'greenhouse',
    [
      'CAPTCHA requires your attention',
      '"Where have you learned about Samsara? Select all that apply." is required and is still empty',
      '"How do you identify? (gender identity)" is required and is still empty',
      '"[Compensation] Do you accept the listed salary range for this position?" is required and is still empty',
    ],
    {
      text: [
        'Where have you learned about Samsara? Select all that apply.*Other',
        'How do you identify? (gender identity)*Female',
        '[Compensation] Do you accept the listed salary range for this position?*Select...',
      ].join(' '),
    },
    {
      fullName: 'Mehek Mandal',
      email: 'mehek@example.com',
      resume: Buffer.from('pdf'),
      resumeName: 'resume.pdf',
      questions: [
        { question: 'Where have you learned about Samsara? Select all that apply.', answer: 'Company website' },
        { question: 'How do you identify? (gender identity)', answer: 'Female' },
        { question: '[Compensation] Do you accept the listed salary range for this position?', answer: '' },
      ],
    },
  );

  assert.deepEqual(blockers, [
    'CAPTCHA requires your attention',
    '"[Compensation] Do you accept the listed salary range for this position?" is required and is still empty',
  ]);
});

test('provider stream failures are retryable attention, not dead failed applications', () => {
  const outcome = submissionFailureOutcome({
    captchaStop: null,
    noSubmitControl: false,
    uncertainAfterClaim: true,
    externalGate: false,
    providerSessionFailure: true,
    currentAttentionReason: undefined,
  });

  assert.equal(outcome.status, 'needs_attention');
  assert.match(outcome.attentionReason ?? '', /temporary secure-browser error/);
  assert.match(outcome.attentionReason ?? '', /Nothing was sent/);
});

test('provider stream classifier does not absorb post-click page closures', () => {
  assert.equal(isProviderSessionFailureMessage('Sandbox stream was closed and is not accepting commands.'), true);
  assert.equal(isProviderSessionFailureMessage('Target closed while reading receipt'), false);
  assert.equal(isProviderSessionFailureMessage('Page closed during screenshot'), false);
});

test('question resolution context includes stored job locations', () => {
  const context = applicationContextForQuestionResolution(
    {
      job_context: {
        location: 'Mountain View, CA',
        locations: ['San Francisco, CA', 'New York, NY'],
      },
    } as never,
    {
      jd_text: 'Build data infrastructure.',
    } as never,
  );
  assert.match(context, /Build data infrastructure/);
  assert.match(context, /Mountain View, CA/);
  assert.match(context, /San Francisco, CA/);
});

test('question resolution context excludes mixed-country job locations', () => {
  const context = applicationContextForQuestionResolution(
    {
      job_context: {
        locations: ['Mountain View, CA', 'Toronto, Canada'],
      },
    } as never,
    {
      jd_text: 'Build data infrastructure.',
    } as never,
  );
  assert.match(context, /Build data infrastructure/);
  assert.doesNotMatch(context, /Mountain View, CA/);
  assert.doesNotMatch(context, /Toronto/);
});

test('attention categories distinguish captcha from document and attestation blockers', () => {
  assert.deepEqual(
    attentionCategoriesForReasons(['CAPTCHA requires your attention']),
    ['captcha'],
  );
  assert.deepEqual(
    attentionCategoriesForReasons(['open-ended question left for you (could not draft a confident answer): "Have you ever built an hcaptcha integration?"']),
    ['unknown'],
  );
  assert.deepEqual(
    attentionCategoriesForReasons(['"Please provide a recent transcript of your undergraduate studies." is required and is still empty']),
    ['required_document'],
  );
  assert.deepEqual(
    attentionCategoriesForReasons(['sensitive question left for you: "Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls."']),
    ['sensitive_attestation'],
  );
  assert.deepEqual(
    attentionCategoriesForReasons([
      'The filled form did not record a resume upload.',
      '"Portfolio" is required and is still empty',
    ]),
    ['evidence_gap', 'required_field'],
  );
});

test('Greenhouse managed blockers are reconciled with selected React-select preview evidence', () => {
  const packet = {
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    questions: [
      { question: 'What education level are you currently pursuing?', answer: 'Bachelor\'s Degree' },
      { question: 'How did you hear about this job?', answer: 'Company website' },
    ],
  } as unknown as import('../lib/portalSubmission').SubmissionPacket;
  const blockers = reconcileManagedProviderBlockers(
    'greenhouse',
    [
      'CAPTCHA requires your attention',
      '"Graduation Month" is required and is still empty',
      '"Graduation Year" is required and is still empty',
      '"What education level are you currently pursuing?" is required and is still empty',
      '"What is your GPA?" is required and is still empty',
      '"How did you hear about this job?" is required and is still empty',
      '"Do you have prior experience working at an options market making trading firm?" is required and is still empty',
    ],
    {
      text: [
        'Graduation Month*May',
        'Graduation Year*2028',
        'What education level are you currently pursuing?*Bachelors',
        'What is your GPA?*3.9',
        'How did you hear about this job?*Other',
      ].join(' '),
      filledFields: [],
    },
    packet,
  );

  assert.deepEqual(blockers, [
    'CAPTCHA requires your attention',
    '"Do you have prior experience working at an options market making trading firm?" is required and is still empty',
  ]);
});

test('CAPTCHA blocker display hides profile-backed academic and privacy fields when preview shows values', () => {
  const packet = {
    school: 'University of Southern California, Viterbi School of Engineering',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    referralSourceDefault: 'Company website',
    questions: [],
  } as unknown as import('../lib/portalSubmission').SubmissionPacket;
  const blockers = attentionBlockersForManagedResult(
    'greenhouse',
    [
      'CAPTCHA requires your attention',
      '"Discipline" is required and is still empty',
      '"Which university are you currently attending? Select "Other" if not listed" is required and is still empty',
      '"What education level are you currently pursuing?" is required and is still empty',
      '"What is your expected graduation year?" is required and is still empty',
      '"What is your GPA?" is required and is still empty',
      '"How did you hear about this job?" is required and is still empty',
      '"Please review and acknowledge Candidate Privacy Policy." is required and is still empty',
      '"Do you have prior experience working at an options market making trading firm?" is required and is still empty',
    ],
    {
      text: [
        'Discipline*Computer Science',
        'Which university are you currently attending? Select "Other" if not listed*University of Southern California',
        'What education level are you currently pursuing?*Bachelors',
        'What is your expected graduation year?*2028',
        'What is your GPA?*3.9',
        'How did you hear about this job?*Other',
        'Please review and acknowledge Candidate Privacy Policy.*Acknowledge/Confirm',
      ].join(' '),
      filledFields: ['first_name', 'last_name', 'email', 'resume'],
    },
    packet,
  );

  assert.deepEqual(blockers, [
    'CAPTCHA requires your attention',
    '"Do you have prior experience working at an options market making trading firm?" is required and is still empty',
  ]);
});

test('Greenhouse managed blocker reconciliation does not hide labels without matching preview values', () => {
  const packet = {
    graduationMonth: 'May',
    questions: [],
  } as unknown as import('../lib/portalSubmission').SubmissionPacket;
  const blockers = reconcileManagedProviderBlockers(
    'greenhouse',
    ['"Graduation Month" is required and is still empty'],
    { text: 'Graduation Month*Select...' },
    packet,
  );

  assert.deepEqual(blockers, ['"Graduation Month" is required and is still empty']);
});

test('Greenhouse managed blocker reconciliation does not trust attempted-fill labels alone', () => {
  const packet = {
    questions: [
      { question: 'What education level are you currently pursuing?', answer: 'Bachelor\'s Degree' },
    ],
  } as unknown as import('../lib/portalSubmission').SubmissionPacket;
  const blockers = reconcileManagedProviderBlockers(
    'greenhouse',
    ['"What education level are you currently pursuing?" is required and is still empty'],
    {
      text: 'What education level are you currently pursuing?*Select...',
      filledFields: ['question_combo_label:0:What education level are you currently pursuing?'],
    },
    packet,
  );

  assert.deepEqual(blockers, ['"What education level are you currently pursuing?" is required and is still empty']);
});

test('broken previews suppress duplicate core-field evidence noise', () => {
  const packet = {
    fullName: 'Mehek Mandal',
    email: 'mehek@example.com',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    questions: [],
  };

  assert.deepEqual(
    preparationEvidenceBlockers(
      {
        text: 'Sorry, but we cannot find that page.',
        filledFields: [],
      },
      packet,
    ),
    ['The filled form preview looks like an error, login, or missing page instead of a completed application form.'],
  );
  assert.deepEqual(
    preparationEvidenceBlockers(
      {
        text: 'First Name Mehek Last Name Mandal Email mehek@example.com Resume resume.pdf',
        filledFields: [],
      },
      packet,
    ),
    [
      'The filled form did not record an email field.',
      'The filled form did not record a resume upload.',
      'The filled form did not record the applicant name fields.',
    ],
  );
  assert.deepEqual(
    attentionBlockersForManagedResult(
      'greenhouse',
      ['CAPTCHA requires your attention'],
      {
        text: 'Sorry, but we cannot find that page.',
        filledFields: [],
      },
      packet,
    ),
    ['CAPTCHA requires your attention'],
  );
});

test('non-CAPTCHA managed blocker reconciliation waits for normal evidence handling', () => {
  const blockers = attentionBlockersForManagedResult(
    'greenhouse',
    ['The filled form did not record an email field.'],
    {
      text: 'Sorry, but we cannot find that page.',
      filledFields: [],
    },
    {
      fullName: 'Mehek Mandal',
      email: 'mehek@example.com',
      resume: Buffer.from('pdf'),
      resumeName: 'resume.pdf',
      questions: [],
    },
  );

  assert.deepEqual(blockers, ['The filled form did not record an email field.']);
});

test('future sponsorship onboarding answer supplies work eligibility for US applications', () => {
  assert.deepEqual(workEligibilityFromSponsorshipAnswer('needs_future'), {
    workAuthorized: true,
    needsSponsorship: true,
  });
});

test('onboarding sponsorship answers keep non-US-authorized cases explicit', () => {
  assert.deepEqual(workEligibilityFromSponsorshipAnswer('not_authorized'), {
    workAuthorized: false,
    needsSponsorship: true,
  });
  assert.deepEqual(workEligibilityFromSponsorshipAnswer('no'), {
    workAuthorized: true,
    needsSponsorship: false,
  });
  assert.deepEqual(workEligibilityFromSponsorshipAnswer('needs_now'), {
    needsSponsorship: true,
  });
});

test('ATS API submission is disabled unless explicitly enabled', () => {
  assert.equal(atsApiSubmissionEnabled({}), false);
  assert.equal(atsApiSubmissionEnabled({ LITOS_ATS_API_SUBMISSION_ENABLED: 'false' }), false);
  assert.equal(atsApiSubmissionEnabled({ LITOS_ATS_API_SUBMISSION_ENABLED: '1' }), false);
  assert.equal(atsApiSubmissionEnabled({ LITOS_ATS_API_SUBMISSION_ENABLED: 'true' }), true);
});

test('malformed EEO preferences are dropped before packet building can trim them', () => {
  assert.deepEqual(sanitizeEeoPrefs({
    gender: ' Female ',
    race: true,
    veteran_status: '',
    sexual_orientation: 'Heterosexual',
  }), {
    gender: 'Female',
    sexual_orientation: 'Heterosexual',
  });
  assert.equal(sanitizeEeoPrefs({ gender: true }), null);
  assert.equal(sanitizeEeoPrefs(['Female']), null);
});

test('the controlled QA portal uses the managed browser in production', () => {
  const previousProvider = process.env.BROWSER_PROVIDER;
  try {
    process.env.BROWSER_PROVIDER = 'stratus-managed';
    assert.equal(shouldUseLocalControlledBrowser('controlled_test'), false);
    assert.equal(shouldUseLocalControlledBrowser('greenhouse'), false);

    process.env.BROWSER_PROVIDER = 'browserbase';
    assert.equal(shouldUseLocalControlledBrowser('controlled_test'), true);
  } finally {
    if (previousProvider === undefined) delete process.env.BROWSER_PROVIDER;
    else process.env.BROWSER_PROVIDER = previousProvider;
  }
});

test('discovered US work authorization and sponsorship become reviewed Yes answers', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship is based in San Francisco, California.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const result = await discoverAndResolveQuestions(
    [
      {
        label: 'Are you legally authorized to work in the United States?',
        selector: '[data-litos-discovered-1]',
        inputType: 'text',
        maxLength: null,
      },
      {
        label: 'Will you now or in the future require sponsorship for employment visa status?',
        selector: '[data-litos-discovered-2]',
        inputType: 'text',
        maxLength: null,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { work_authorized: true, needs_sponsorship: true },
    true,
    'greenhouse',
  );

  assert.deepEqual(result.attentionReasons, []);
  assert.deepEqual(
    result.questions.map((question) => ({ question: question.question, answer: question.answer })),
    [
      { question: 'Are you legally authorized to work in the United States?', answer: 'Yes' },
      { question: 'Will you now or in the future require sponsorship for employment visa status?', answer: 'Yes' },
    ],
  );
});

test('select and radio discoveries resolve from stored profile without direct textbox selectors', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship is based in San Francisco, California.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const result = await discoverAndResolveQuestions(
    [
      {
        label: 'Are you able to work onsite 4 days a week?',
        selector: 'select[name="question_1"]',
        inputType: 'select',
        maxLength: null,
      },
      {
        label: 'Are you currently enrolled in a degree program?',
        selector: 'input[name="question_2"][type="radio"]',
        inputType: 'radio',
        maxLength: null,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { currently_enrolled: true, grad_date: 'May 2028', grad_year: 2028 },
    true,
    'greenhouse',
  );

  assert.deepEqual(result.attentionReasons, []);
  assert.deepEqual(
    result.questions.map((question) => ({
      question: question.question,
      answer: question.answer,
      portal_selector: question.portal_selector,
    })),
    [
      { question: 'Are you able to work onsite 4 days a week?', answer: 'Yes', portal_selector: undefined },
      { question: 'Are you currently enrolled in a degree program?', answer: 'Yes', portal_selector: undefined },
    ],
  );
});

test('combobox discoveries resolve stored academic facts without direct text selectors', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship asks for an education history.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const result = await discoverAndResolveQuestions(
    [
      {
        label: 'Degree',
        selector: '[data-litos-discovered-6]',
        inputType: 'combobox',
        maxLength: null,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { degree: 'Bachelor of Science in Computer Science' },
    true,
    'greenhouse',
  );

  assert.deepEqual(result.attentionReasons, []);
  assert.deepEqual(
    result.questions.map((question) => ({
      question: question.question,
      answer: question.answer,
      portal_selector: question.portal_selector,
    })),
    [
      { question: 'Degree', answer: 'Bachelor\'s Degree', portal_selector: '[data-litos-discovered-6]' },
    ],
  );
});

/* "I had an answer and I deliberately did not pick anything off this list."
 *
 * resolveProfileField reports that as matchedOption: false, and this function used to read the
 * resolved VALUE off it and throw the flag away. So the one case where Litos knows in advance that
 * a control will be left unfilled was the only case the applicant never heard about: the select
 * stays on "Select...", the employer's own validation calls it required and empty, and the run
 * stalls on a blocker she had no warning of.
 *
 * The refusal is right and stays. `chooseClosestOption(['Yes'], ['Yes, with sponsorship', 'Yes,
 * without sponsorship', 'No'])` returns null because every option adds a legal claim the stored
 * answer does not make, and picking one would submit a sponsorship declaration nobody authorized.
 * What changes is that refusing now says so out loud. */
test('an option list with no match for the saved answer is reported to the applicant', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship is based in San Francisco, California.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const result = await discoverAndResolveQuestions(
    [
      {
        label: 'Are you legally authorized to work in the United States?',
        selector: 'select[name="question_1"]',
        inputType: 'select',
        maxLength: null,
        options: ['Yes, with sponsorship', 'Yes, without sponsorship', 'No'],
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { work_authorized: true, needs_sponsorship: true },
    true,
    'greenhouse',
  );

  assert.deepEqual(result.attentionReasons, [
    'none of the options match your saved answer, so this one is left for you: '
    + '"Are you legally authorized to work in the United States?"',
  ]);
  // The question is still recorded with the honest answer beside it, so a fill layer that CAN see
  // the menu is not deprived of the value; the reason is a warning, not a withdrawal.
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].answer, 'Yes');
});

// The mirror image, and the one this must not cost. A list the answer IS in produces no reason at
// all, and neither does a free-text control, where matchedOption is false for every field on the
// form because there was never a list to match against.
test('a matched option and a free-text field are not reported as work for the applicant', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship asks for an education history.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const result = await discoverAndResolveQuestions(
    [
      {
        label: 'Graduation Month',
        selector: 'select[name="grad_month"]',
        inputType: 'select',
        maxLength: null,
        options: ['Select...', 'January', 'May', 'December'],
      },
      {
        label: 'Graduation Month',
        selector: '[data-litos-discovered-2]',
        inputType: 'text',
        maxLength: null,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { grad_date: 'May 2028', grad_year: 2028 },
    true,
    'greenhouse',
  );

  assert.deepEqual(result.attentionReasons, []);
});

test('discovered GPA and major questions resolve from profile-backed academic fallbacks', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship asks for an education history.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const result = await discoverAndResolveQuestions(
    [
      {
        label: 'What is your GPA?',
        selector: '[data-litos-discovered-7]',
        inputType: 'combobox',
        maxLength: null,
      },
      {
        label: 'What is your major?',
        selector: '[data-litos-discovered-8]',
        inputType: 'combobox',
        maxLength: null,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    {
      degree: 'Bachelor of Science in Computer Science',
      gpa: '3.89',
    },
    true,
    'greenhouse',
  );

  assert.deepEqual(result.attentionReasons, []);
  assert.deepEqual(
    result.questions.map((question) => ({
      question: question.question,
      answer: question.answer,
      portal_selector: question.portal_selector,
    })),
    [
      { question: 'What is your GPA?', answer: '3.89', portal_selector: '[data-litos-discovered-7]' },
      { question: 'What is your major?', answer: 'Computer Science', portal_selector: '[data-litos-discovered-8]' },
    ],
  );
});

test('managed Greenhouse education combobox labels are not replayed as text fields', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship asks for an education history.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const result = await discoverAndResolveQuestions(
    [
      {
        label: 'degree* degree--0',
        selector: '[data-litos-discovered-6]',
        inputType: 'text',
        maxLength: null,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { degree: 'Bachelor of Science in Computer Science' },
    true,
    'greenhouse',
  );

  // The stored question text is now the employer's own label, not the discovery blob.
  //
  // Keeping "degree* degree--0" was the Class A defect. The managed fill run has no durable
  // selector for a discovered control (the `data-litos-discovered-6` marker belongs to the
  // discovery session and is gone by the time the fill run loads the page), so the ONLY way the
  // answer reaches the control is a `label:has-text("<stored question text>")` scope. Scoping on
  // "degree* degree--0" cannot match a page whose label reads "Degree", so the field was left
  // untouched and came back as '"Degree" is required and is still empty' with "Bachelor's Degree"
  // already sitting in the packet. Measured on 25 prod packets on 2026-08-08.
  assert.deepEqual(result.questions.map((question) => ({
    question: question.question,
    answer: question.answer,
    portal_selector: question.portal_selector,
  })), [
    { question: 'degree', answer: 'Bachelor\'s Degree', portal_selector: undefined },
  ]);
});

test('existing reviewed choice answers do not keep direct selectors on retry', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship is based in San Francisco, California.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [
      {
        id: 'q-existing',
        question: 'Are you currently enrolled in a degree program?',
        answer: 'Yes',
        kind: 'required',
        required: false,
        portal_selector: 'input[name="question_2"][type="radio"]',
      },
    ],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const result = await discoverAndResolveQuestions(
    [
      {
        label: 'Are you currently enrolled in a degree program?',
        selector: 'input[name="question_2"][type="radio"]',
        inputType: 'radio',
        maxLength: null,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { currently_enrolled: true },
    true,
    'greenhouse',
  );

  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0]?.id, 'q-existing');
  assert.equal(result.questions[0]?.answer, 'Yes');
  assert.equal(result.questions[0]?.portal_selector, undefined);
});

test('rediscovered profile-backed questions replace stale drafted retry answers', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship is based in Austin, Texas.',
    role: 'Marketing Programs and Analytics Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [
      {
        id: 'degree-existing',
        question: 'If you are enrolled in university, what degree are you currently pursuing?',
        answer: "I'm pursuing a degree at USC.",
        kind: 'essay',
        required: false,
        portal_selector: '[data-litos-discovered-1]',
      },
      {
        id: 'gender-existing',
        question: 'How do you currently describe your gender identity? * 4000408002',
        answer: 'I prefer to focus on my qualifications.',
        kind: 'essay',
        required: false,
        portal_selector: '[data-litos-discovered-2]',
      },
    ],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const result = await discoverAndResolveQuestions(
    [
      {
        label: 'If you are enrolled in university, what degree are you currently pursuing?',
        selector: '[data-litos-discovered-1]',
        inputType: 'combobox',
        maxLength: null,
      },
      {
        label: 'How do you currently describe your gender identity? * 4000408002',
        selector: '[data-litos-discovered-2]',
        inputType: 'select',
        maxLength: null,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { degree: 'Bachelor of Science in Computer Science', eeo_prefs: { gender: 'Female' } },
    true,
    'greenhouse',
  );

  assert.deepEqual(result.attentionReasons, []);
  assert.deepEqual(
    result.questions.map((question) => ({ id: question.id, answer: question.answer, kind: question.kind })),
    [
      { id: 'degree-existing', answer: 'Bachelor\'s Degree', kind: 'required' },
      { id: 'gender-existing', answer: 'Female', kind: 'required' },
    ],
  );
});

// ─── The prepare-time gate for account-walled portals ─────────────────────────
//
// This is a SOURCE-LEVEL test, which is unusual here and deliberate. prepare() is not exported and
// needs a live database and a browser provider, so a behavioural test would cost more than it is
// worth. What it asserts is an ORDERING invariant, and ordering is exactly what went wrong twice:
// the 2026-07-28 review found a gate that only covered the action builder while the caller went on
// to write status:'submitted' anyway, and this branch shipped the same class of bug again - a
// submit-time gate with prepare() left open in front of it.
//
// For Jobvite, iCIMS, Oracle Cloud and UltiPro there is no application form to reach. Without this
// gate prepare() spends two billed managed-browser calls on a page with no fields, then screenshots
// a data-consent page, a login form or an "enter the emailed code" screen and presents THAT to the
// student as the filled application she is approving to send.
test('prepare() stops account-walled portals before it opens any browser', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(__dirname, 'submissionRunner.ts'), 'utf8');
  const prepareStart = source.indexOf('async function prepare(');
  assert.ok(prepareStart > 0, 'prepare() must exist');
  const prepareBody = source.slice(prepareStart, source.indexOf('\nasync function ', prepareStart + 10));

  const gateAt = prepareBody.indexOf('isAccountWalledFamily(portal)');
  assert.ok(gateAt > 0, 'prepare() must check isAccountWalledFamily');

  // Every way prepare() can start paying for a browser. The gate has to come before all of them.
  for (const spend of ['prepareManaged(', 'createBrowserContext(', 'createBrowserSession(']) {
    const spendAt = prepareBody.indexOf(spend);
    if (spendAt === -1) continue;
    assert.ok(
      gateAt < spendAt,
      `the account-walled gate must precede ${spend} - otherwise the student approves a login page`,
    );
  }
});
