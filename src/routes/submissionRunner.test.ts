import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applicationContextForQuestionResolution,
  atsApiSubmissionEnabled,
  discoverAndResolveQuestions,
  readMostRecentRole,
  sanitizeEeoPrefs,
  shouldUseLocalControlledBrowser,
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
      { question: 'Degree', answer: 'Bachelor\'s Degree', portal_selector: undefined },
    ],
  );
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
      { question: 'What is your GPA?', answer: '3.89', portal_selector: undefined },
      { question: 'What is your major?', answer: 'Computer Science', portal_selector: undefined },
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

  assert.deepEqual(result.questions.map((question) => ({
    question: question.question,
    answer: question.answer,
    portal_selector: question.portal_selector,
  })), [
    { question: 'degree* degree--0', answer: 'Bachelor\'s Degree', portal_selector: undefined },
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
