import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyField,
  eeoAnswer,
  fitToBudget,
  graduationDateAnswer,
  isOpenEndedQuestion,
  isRefusedQuestion,
  normalizeDiscoveredLabel,
  normalizeReviewQuestionLabel,
  normalizeStoredPortalQuestions,
  questionRequiresHumanAttention,
  refreshKnownQuestionAnswers,
  REVIEW_QUESTION_TEXT_MAX_LENGTH,
  resolveKnownAnswer,
  sensitiveQuestionRequiresAttention,
  WORK_ELIGIBILITY_QUESTION,
} from './questionDiscovery';

// R-004 originally refused every work-eligibility question after one false legal declaration
// shipped. These are now answerable only from explicit stored booleans, never by inference.
test('answers work authorization and sponsorship only from explicit stored consent', () => {
  assert.equal(isRefusedQuestion('are you legally authorized to work in the United States?'), true);
  assert.equal(classifyField('are you legally authorized to work in the United States?'), null);

  assert.deepEqual(
    resolveKnownAnswer('are you legally authorized to work in the United States?', 'text', { work_authorized: true }, undefined),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer('Are you currently eligible to legally work in the United States?', 'text', { work_authorized: true }, undefined),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer(
      'are you legally authorized to work in the country where the job is located?',
      'text',
      { work_authorized: true },
      'This role is based in San Francisco, California.',
    ),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer(
      'Are you legally authorized to work in the country in which you are applying?',
      'text',
      { work_authorized: true },
      'Mountain View, CA',
    ),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer('Are you currently eligible to work in the United States of America?', 'text', { work_authorized: true }, undefined),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer('will you now or in the future require sponsorship for employment visa status?', 'text', { needs_sponsorship: true }, undefined),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer(
      'Do you now or in the future require visa sponsorship/work authorization to continue working in the United States?',
      'text',
      { work_authorized: true, needs_sponsorship: true },
      undefined,
    ),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer('do you require visa sponsorship to work in the US?', 'text', { needs_sponsorship: false }, undefined),
    { value: 'No' },
  );

  const missingConsent = resolveKnownAnswer(
    'are you legally authorized to work in the United States?',
    'text',
    { citizenship: 'Indian', address_country: 'UAE' },
    undefined,
  );
  assert.ok(missingConsent && 'skipReason' in missingConsent);

  const nonUs = resolveKnownAnswer(
    'are you legally authorized to work in Canada?',
    'text',
    { work_authorized: true },
    undefined,
  );
  assert.ok(nonUs && 'skipReason' in nonUs);

  const unknownJobCountry = resolveKnownAnswer(
    'are you legally authorized to work in the country where the job is located?',
    'text',
    { work_authorized: true },
    'This role is based in Toronto.',
  );
  assert.ok(unknownJobCountry && 'skipReason' in unknownJobCountry);

  const nonUsSponsorship = resolveKnownAnswer(
    'will you now or in the future require sponsorship to work in Canada?',
    'text',
    { needs_sponsorship: true },
    undefined,
  );
  assert.ok(nonUsSponsorship && 'skipReason' in nonUsSponsorship);

  const nonUsSponsorshipWorkAuth = resolveKnownAnswer(
    'Do you now or in the future require visa sponsorship/work authorization to continue working in Canada?',
    'text',
    { work_authorized: true, needs_sponsorship: true },
    undefined,
  );
  assert.ok(nonUsSponsorshipWorkAuth && 'skipReason' in nonUsSponsorshipWorkAuth);

  const nonUsEmployerCountry = resolveKnownAnswer(
    'are you legally authorized to work for Formlabs in Hungary?',
    'text',
    { work_authorized: true },
    undefined,
  );
  assert.ok(nonUsEmployerCountry && 'skipReason' in nonUsEmployerCountry);

  const mixed = resolveKnownAnswer(
    'are you authorized to work in the US without sponsorship?',
    'text',
    { work_authorized: true, needs_sponsorship: true },
    undefined,
  );
  assert.ok(mixed && 'skipReason' in mixed);
});

test('answers EEO / demographic questions with stored preferences or decline', () => {
  const labels = [
    'what is your gender?',
    'are you hispanic or latino?',
    'veteran status',
    'are you a person of transgender experience?',
    'please select your racial/ethnic background',
  ];
  for (const label of labels) {
    assert.equal(isRefusedQuestion(label), true, label);
    assert.equal(classifyField(label), null, label);
    assert.deepEqual(resolveKnownAnswer(label, 'text', {}, undefined), { value: 'Decline to self-identify' });
  }
  assert.deepEqual(
    resolveKnownAnswer('what is your gender?', 'text', { eeo_prefs: { gender: 'Female' } }, undefined),
    { value: 'Female' },
  );
  assert.deepEqual(
    resolveKnownAnswer('are you a person of transgender experience?', 'text', { eeo_prefs: { gender: 'Female' } }, undefined),
    { value: 'Decline to self-identify' },
  );
  assert.deepEqual(
    resolveKnownAnswer('please select your racial/ethnic background', 'text', { eeo_prefs: { gender: 'Female' } }, undefined),
    { value: 'Decline to self-identify' },
  );
});

test('auto-answers candidate privacy consent while leaving demographic survey consent for attention', () => {
  const privacy = resolveKnownAnswer(
    'By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with the Candidate Privacy Policy.',
    'text',
    {},
    undefined,
  );
  assert.deepEqual(privacy, { value: 'Yes' });

  const demographicConsent = resolveKnownAnswer(
    'By checking this box, I consent to Reddit collecting, storing, and processing my responses to the demographic data survey above.',
    'text',
    {},
    undefined,
  );
  assert.ok(demographicConsent && 'skipReason' in demographicConsent);
  assert.match(demographicConsent.skipReason, /consent question left for you/);
});

test('send-time sensitive guard allows stored work and EEO answers while blocking identity numbers', () => {
  assert.equal(
    questionRequiresHumanAttention({ question: 'are you legally authorized to work in the United States?', answer: 'Yes' }),
    false,
  );
  assert.equal(
    questionRequiresHumanAttention({ question: 'Are you currently eligible to work in the United States of America?', answer: 'Yes' }),
    false,
  );
  assert.equal(
    questionRequiresHumanAttention({ question: 'Do you now or in the future require visa sponsorship/work authorization to continue working in the United States?', answer: 'Yes' }),
    false,
  );
  assert.equal(
    questionRequiresHumanAttention({ question: 'will you require sponsorship for work authorization?', answer: '' }),
    true,
  );
  assert.equal(
    questionRequiresHumanAttention({ question: 'gender', answer: 'Decline to self-identify' }),
    false,
  );
  assert.equal(questionRequiresHumanAttention({ question: 'social security number', answer: '123' }), true);
});

test('profile-aware submit gate accepts exact stored work answers only', () => {
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'Are you currently eligible to work in the United States of America?',
      'Yes',
      'text',
      { work_authorized: true },
      undefined,
    ),
    false,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'Do you now or in the future require visa sponsorship/work authorization to continue working in the United States?',
      'Yes',
      'text',
      { work_authorized: true, needs_sponsorship: true },
      undefined,
    ),
    false,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'Do you now or in the future require visa sponsorship/work authorization to continue working in the United States?',
      'No',
      'text',
      { work_authorized: true, needs_sponsorship: true },
      undefined,
    ),
    true,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'are you authorized to work in the US without sponsorship?',
      'Yes',
      'text',
      { work_authorized: true, needs_sponsorship: true },
      undefined,
    ),
    true,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'Do you now or in the future require visa sponsorship/work authorization to continue working in Canada?',
      'Yes',
      'text',
      { work_authorized: true, needs_sponsorship: true },
      undefined,
    ),
    true,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention('social security number', '123', 'text', { work_authorized: true }, undefined),
    true,
  );
});

test('send-time refresh replaces stale EEO prose with stored profile answers', () => {
  const questions = refreshKnownQuestionAnswers([
    {
      question: 'are you a person of transgender experience? * 431',
      answer: "I don't think that's relevant to my qualifications for this role.",
    },
    {
      question: 'will you now or in the future require immigration sponsorship?',
      answer: '',
    },
    {
      question: 'briefly describe your experience with ads review',
      answer: 'Reviewed policy signals in a fintech environment.',
    },
  ], { needs_sponsorship: true, eeo_prefs: null }, 'This role is based in New York.');
  assert.equal(questions[0].answer, 'Decline to self-identify');
  assert.equal(questions[1].answer, 'Yes');
  assert.equal(questions[2].answer, 'Reviewed policy signals in a fintech environment.');
  assert.equal(questionRequiresHumanAttention(questions[0]), false);
});

test('never answers SSN or driver license fields', () => {
  assert.equal(isRefusedQuestion('social security number'), true);
  assert.equal(isRefusedQuestion("driver's license number"), true);
});

test('never answers CAPTCHA or recording consent fields', () => {
  assert.equal(isRefusedQuestion('Please complete the CAPTCHA'), true);
  assert.equal(resolveKnownAnswer('Please complete the CAPTCHA', 'checkbox', {}, undefined), null);
  assert.equal(isRefusedQuestion('Do you consent to this interview being recorded?'), true);
  assert.equal(resolveKnownAnswer('Do you consent to this interview being recorded?', 'checkbox', {}, undefined), null);
});

test('sensitive gates allow only exact stored work eligibility answers', () => {
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'are you legally authorized to work in the United States?',
      'Yes',
      'text',
      { work_authorized: true },
      undefined,
    ),
    false,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'will you now or in the future require sponsorship for employment visa status?',
      'Yes',
      'text',
      { needs_sponsorship: true },
      undefined,
    ),
    false,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'are you legally authorized to work in the United States?',
      'No',
      'text',
      { work_authorized: true },
      undefined,
    ),
    true,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'are you legally authorized to work in the United States?',
      'Yes',
      'text',
      {},
      undefined,
    ),
    true,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'are you legally authorized to work in Canada?',
      'Yes',
      'text',
      { work_authorized: true },
      undefined,
    ),
    true,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'are you authorized to work in the US without sponsorship?',
      'Yes',
      'text',
      { work_authorized: true, needs_sponsorship: true },
      undefined,
    ),
    true,
  );
  assert.equal(sensitiveQuestionRequiresAttention('social security number', '123-45-6789', 'text', {}, undefined), true);
  assert.equal(sensitiveQuestionRequiresAttention('what is your gender?', 'Female', 'text', {}, undefined), true);
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'are you a person of transgender experience? * 431',
      'Decline to self-identify',
      'text',
      { eeo_prefs: null },
      undefined,
    ),
    false,
  );
  assert.equal(
    sensitiveQuestionRequiresAttention(
      'are you a person of transgender experience? * 431',
      "I don't think that's relevant to my qualifications for this role.",
      'text',
      { eeo_prefs: null },
      undefined,
    ),
    true,
  );
});

test('citizenship is answered but never substituted for residence', () => {
  assert.equal(classifyField('country of citizenship'), 'citizenship');
  assert.equal(classifyField('which country do you currently reside in?'), 'address_country');
  const resolved = resolveKnownAnswer('country of citizenship', 'text', { citizenship: 'Indian' }, undefined);
  assert.deepEqual(resolved, { value: 'India' });
});

test('a routine location-commitment question is answered as an approved logistics acknowledgement', () => {
  const label = 'this role is in-office three days a week, can you commit to that?';
  assert.equal(classifyField(label), 'onsite_commitment');
  assert.deepEqual(resolveKnownAnswer(label, 'select', { address_city: 'Dubai' }, undefined), { value: 'Yes' });
  assert.equal(classifyField('are you willing to relocate to San Francisco?'), null);
  assert.deepEqual(resolveKnownAnswer('are you willing to relocate to San Francisco?', 'text', { address_city: 'Dubai' }, undefined), { value: 'Yes' });
});

test('a preferred-location choice is not drafted as prose', () => {
  const label = "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.";
  assert.equal(classifyField(label), null);
  assert.equal(isOpenEndedQuestion(label), false);
  const resolved = resolveKnownAnswer(label, 'text', { address_city: 'Los Angeles' }, 'Locations to be discussed with your recruiter.');
  assert.ok(resolved && 'skipReason' in resolved);
  assert.match(resolved.skipReason, /location choice left for you/);
});

test('routine applicant data and privacy consent questions are answered yes', () => {
  const labels = [
    'Do you consent to Brex processing your personal information for the purpose of assessing your candidacy for this position?',
    "Please review and acknowledge Cloudflare's Candidate Privacy Policy.",
    'Yes, I consent',
  ];
  for (const label of labels) {
    assert.deepEqual(resolveKnownAnswer(label, 'text', {}, undefined), { value: 'Yes' });
  }
});

test('duration beats start date on an ambiguous "availab" label (R-014)', () => {
  assert.equal(classifyField('length or term/length of availability'), 'availability_term');
  assert.equal(classifyField('when can you start?'), 'availability_date');
});

test('expected graduation date resolves from the academic profile, not availability', () => {
  const label = 'Are you currently enrolled in a degree program? If so, expected graduation date';
  assert.equal(classifyField(label), 'graduation_date');
  assert.equal(graduationDateAnswer('May 2028', 2028, 'text'), 'May 2028');
  assert.equal(graduationDateAnswer('May 2028', 2028, 'date'), '2028-05-01');
  assert.deepEqual(
    resolveKnownAnswer(label, 'date', { grad_date: 'May 2028', grad_year: 2028, currently_enrolled: true }, undefined),
    { value: '2028-05-01' },
  );
});

test('school and degree resolve from the academic profile', () => {
  const profile = {
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    major: 'Computer Science',
  };
  assert.equal(classifyField('School'), 'school');
  assert.equal(classifyField('Degree'), 'degree');
  assert.equal(classifyField('Degree subject'), 'major');
  assert.equal(classifyField('Discipline'), 'major');
  assert.equal(classifyField('When did you graduate from High School?'), null);
  assert.deepEqual(resolveKnownAnswer('School', 'text', profile, undefined), { value: profile.school });
  assert.deepEqual(resolveKnownAnswer('Degree', 'text', profile, undefined), { value: profile.degree });
  assert.deepEqual(resolveKnownAnswer('Discipline', 'text', profile, undefined), { value: profile.major });
});

test('referral source handles first-heard wording', () => {
  assert.deepEqual(resolveKnownAnswer('How did you first hear about Five Rings?', 'text', {}, undefined), {
    value: 'Company website',
  });
});

test('stored academic and onsite facts answer repeated select-shaped live questions', () => {
  const profile = {
    school: 'University of Southern California',
    degree: 'Bachelor of Science',
    major: 'Computer Science',
    grad_date: 'May 2028',
    grad_year: 2028,
    currently_enrolled: true,
    languages: ['English', 'Hindi'],
  };

  assert.deepEqual(resolveKnownAnswer('Are you able to work onsite 3 days a week?', 'select', profile, undefined), { value: 'Yes' });
  assert.deepEqual(resolveKnownAnswer('Are you currently enrolled in a degree program?', 'radio', profile, undefined), { value: 'Yes' });
  assert.deepEqual(resolveKnownAnswer('Will you be returning to a degree program after this internship?', 'select', profile, undefined), { value: 'Yes' });
  assert.deepEqual(resolveKnownAnswer('Graduation Month', 'select', profile, undefined), { value: 'May' });
  assert.deepEqual(resolveKnownAnswer('Graduation Year', 'select', profile, undefined), { value: '2028' });
  assert.deepEqual(
    resolveKnownAnswer('If you are enrolled in university, what degree are you currently pursuing?', 'select', profile, undefined),
    { value: 'Bachelor\'s Degree' },
  );
  assert.deepEqual(resolveKnownAnswer('Degree', 'combobox', profile, undefined), { value: 'Bachelor\'s Degree' });
  assert.deepEqual(resolveKnownAnswer('What is the most recent degree you obtained?', 'select', profile, undefined), { value: 'Bachelor\'s Degree' });
  assert.deepEqual(resolveKnownAnswer('What is your major?', 'text', profile, undefined), { value: 'Computer Science' });
  assert.deepEqual(resolveKnownAnswer('What languages are you fluent in?', 'text', profile, undefined), { value: 'English, Hindi' });
  assert.deepEqual(resolveKnownAnswer('Do you speak English fluently?', 'select', profile, undefined), { value: 'Yes' });
});

test('required internship form fields resolve from profile-backed defaults instead of drafts', () => {
  const profile = {
    address_city: 'Dubai',
    address_country: 'United Arab Emirates',
    degree: 'Bachelor of Science in Computer Science',
    currently_enrolled: true,
    grad_date: 'May 2028',
    grad_year: 2028,
    eeo_prefs: { gender: 'Female' },
  };

  assert.deepEqual(
    resolveKnownAnswer(
      'Please select your current state of residence. Select “Not in the US” if you reside outside the United States.',
      'select',
      profile,
      undefined,
    ),
    { value: 'Not in the US' },
  );
  assert.deepEqual(resolveKnownAnswer('Do you currently reside in San Francisco?', 'select', profile, undefined), { value: 'No' });
  assert.deepEqual(
    resolveKnownAnswer(
      'Are you currently residing in the greater Austin area or have confirmed plans to be in Austin for the duration of this internship?',
      'select',
      profile,
      undefined,
    ),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer('Are you currently enrolled in a Masters or PhD program for a technical field?', 'select', profile, undefined),
    { value: 'No' },
  );
  const privacy = resolveKnownAnswer(
    'Please review and acknowledge Cloudflare\'s Candidate Privacy Policy (cloudflare.com/candidate-privacy-notice/).',
    'checkbox',
    profile,
    undefined,
  );
  assert.deepEqual(privacy, { value: 'Yes' });
  assert.deepEqual(
    resolveKnownAnswer('Do you consider yourself a member of the LGBTQIA+ community?', 'select', profile, undefined),
    { value: 'Decline to self-identify' },
  );
  assert.deepEqual(
    resolveKnownAnswer('Which categories describe you? Select all that apply to you', 'checkbox', profile, undefined),
    { value: 'Decline to self-identify' },
  );
  assert.deepEqual(
    resolveKnownAnswer(
      'Are you currently bound by any agreements with a current or former employer that may restrict your ability to work for Scale AI?',
      'select',
      profile,
      undefined,
    ),
    { value: 'No' },
  );
});

test('job location preference questions use the safe posting locations context', () => {
  const label = "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.";
  const context = [
    'Build data systems for customers.',
    'Mountain View, CA',
    'San Francisco, CA',
  ].join('\n');

  assert.equal(classifyField(label), null);
  assert.deepEqual(
    resolveKnownAnswer(
      label,
      'select',
      {},
      context,
    ),
    { value: 'San Francisco, CA' },
  );
  assert.deepEqual(resolveKnownAnswer('What is your current location?', 'text', { address_city: 'Dubai' }, context), { value: 'Dubai' });
});

test('Databricks export-control checkbox questions are not inferred from profile geography', () => {
  assert.equal(
    resolveKnownAnswer(
      'Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.',
      'checkbox',
      { address_country: 'United Arab Emirates', citizenship: 'Indian' },
      undefined,
    ),
    null,
  );
  assert.equal(
    resolveKnownAnswer(
      'If you selected a response to the prior question other than none of the above, please confirm whether any of the following also applies to you. Select all that apply.',
      'checkbox',
      { address_country: 'United Arab Emirates', citizenship: 'Indian' },
      undefined,
    ),
    null,
  );
  assert.equal(
    resolveKnownAnswer(
      'Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be used to ensure compliance with U.S. sanctions and export controls.',
      'checkbox',
      {},
      undefined,
    ),
    null,
  );
});

test('graduation date inputs use the graduation end of an education range', () => {
  assert.equal(graduationDateAnswer('August 2024 - May 2028', 2028, 'date'), '2028-05-01');
  assert.equal(graduationDateAnswer('August 2024 - 2028-05-15', 2028, 'date'), '2028-05-01');
});

test('graduation-related prose is not filled with a graduation date', () => {
  const label = 'Describe your post-graduation plans and why they align with this role';
  assert.equal(classifyField(label), null);
  assert.equal(resolveKnownAnswer(label, 'textarea', { grad_date: 'May 2028', grad_year: 2028 }, undefined), null);
  assert.equal(isOpenEndedQuestion(label), true);
});

test('mixed enrollment and graduation-date prompts require confirmed current enrollment', () => {
  const label = 'Are you currently enrolled in a degree program? If so, expected graduation date';
  const unknown = resolveKnownAnswer(label, 'date', { grad_date: 'May 2099', grad_year: 2099 }, undefined);
  const falseEnrollment = resolveKnownAnswer(
    label,
    'date',
    { grad_date: 'May 2099', grad_year: 2099, currently_enrolled: false },
    undefined,
  );
  assert.deepEqual(unknown, { value: '2099-05-01' });
  assert.ok(falseEnrollment && 'skipReason' in falseEnrollment);
});

test('mixed enrollment and graduation-date prompts still skip past graduation evidence', () => {
  const label = 'Are you currently enrolled in a degree program? If so, expected graduation date';
  const resolved = resolveKnownAnswer(label, 'date', { grad_date: 'May 2024', grad_year: 2024 }, undefined);
  assert.ok(resolved && 'skipReason' in resolved);
});

test('live-audit education variants resolve from stored education profile facts', () => {
  const now = new Date();
  const academicStartYear = now.getUTCMonth() >= 7 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const gradYear = academicStartYear + 2;
  const expectedStudyYear = 'Third year';
  const profile = {
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science & Business Administration, Finance Emphasis',
    grad_date: `May ${gradYear}`,
    grad_year: gradYear,
    currently_enrolled: true,
    gpa: '3.89/4.0',
  };

  assert.deepEqual(resolveKnownAnswer('Please re-confirm the university you currently attend', 'select', profile, undefined), {
    value: 'University of Southern California',
  });
  assert.deepEqual(resolveKnownAnswer('Undergrad Discipline(s)', 'select', profile, undefined), {
    value: 'Computer Science and Business Administration',
  });
  assert.deepEqual(resolveKnownAnswer('What is your latest field of study?', 'select', profile, undefined), {
    value: 'Computer Science and Business Administration',
  });
  assert.deepEqual(resolveKnownAnswer('Which course are you currently enrolled in?', 'select', profile, undefined), {
    value: 'Computer Science and Business Administration',
  });
  assert.deepEqual(resolveKnownAnswer('Please confirm your current degree graduation time frame.', 'select', profile, undefined), {
    value: `May ${gradYear}`,
  });
  assert.deepEqual(resolveKnownAnswer('Expected Graduation semester', 'select', profile, undefined), {
    value: `Spring ${gradYear}`,
  });
  assert.deepEqual(resolveKnownAnswer('What is the current year of your studies?', 'select', profile, undefined), {
    value: expectedStudyYear,
  });
  assert.deepEqual(resolveKnownAnswer('What is your current academic performance rating?', 'select', profile, undefined), {
    value: '3.89/4.0',
  });
});

test('live-audit profile fields use question shape before generic enrollment words', () => {
  const profile = {
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    grad_date: 'May 2027',
    grad_year: 2027,
    currently_enrolled: true,
    address_country: 'United States',
    availability_term: 'Available full-time for 12 weeks',
  };

  assert.deepEqual(resolveKnownAnswer('Which university are you currently enrolled in?', 'select', profile, undefined), {
    value: 'University of Southern California',
  });
  assert.deepEqual(resolveKnownAnswer("University / Institution (Bachelor's Degree)", 'select', profile, undefined), {
    value: 'University of Southern California',
  });
  assert.deepEqual(resolveKnownAnswer('If you are currently enrolled in a university or program, when do you expect to graduate or complete your program?', 'select', profile, undefined), {
    value: 'May 2027',
  });
  assert.ok(
    resolveKnownAnswer('Have you been enrolled in WorldQuant University in the past 12 months?', 'radio', profile, undefined)
    && 'skipReason' in resolveKnownAnswer('Have you been enrolled in WorldQuant University in the past 12 months?', 'radio', profile, undefined)!,
  );
  assert.ok(
    resolveKnownAnswer('Have you ever worked for Redwood Materials?', 'radio', profile, undefined)
    && 'skipReason' in resolveKnownAnswer('Have you ever worked for Redwood Materials?', 'radio', profile, undefined)!,
  );
  assert.ok(
    resolveKnownAnswer('Are you available for a 12-week full-time (40 hours per week) internship between September - December 2026?', 'select', profile, undefined)
    && 'skipReason' in resolveKnownAnswer('Are you available for a 12-week full-time (40 hours per week) internship between September - December 2026?', 'select', profile, undefined)!,
  );
  assert.deepEqual(resolveKnownAnswer('Are you available for a 12-week full-time (40 hours per week) internship between September - December 2026?', 'select', {
    ...profile,
    availability_term: 'Available full-time for 12 weeks between September and December 2026',
  }, undefined), {
    value: 'Yes',
  });
  assert.ok(
    resolveKnownAnswer('Are you available for a 12-week full-time (40 hours per week) internship between September - December 2026?', 'select', {
      ...profile,
      availability_term: undefined,
    }, undefined)
    && 'skipReason' in resolveKnownAnswer('Are you available for a 12-week full-time (40 hours per week) internship between September - December 2026?', 'select', {
      ...profile,
      availability_term: undefined,
    }, undefined)!,
  );
});

test('study year stays blank when graduation evidence cannot support it', () => {
  assert.equal(
    resolveKnownAnswer('What is the current year of your studies?', 'select', { grad_date: 'May 2024', grad_year: 2024 }, undefined),
    null,
  );
  assert.equal(
    resolveKnownAnswer(
      'What is the current year of your studies?',
      'select',
      {
        degree: 'Master of Science in Computer Science',
        grad_date: 'May 2099',
        grad_year: 2099,
        currently_enrolled: true,
      },
      undefined,
    ),
    null,
  );
});

test('salary questions are left for human attention', () => {
  const ap = { desired_salary: '80000', desired_salary_currency: 'USD' };
  const usd = resolveKnownAnswer('expected salary (USD)', 'text', ap, undefined);
  assert.ok(usd && 'skipReason' in usd);
  const eur = resolveKnownAnswer('expected salary (EUR)', 'text', ap, undefined);
  assert.ok(eur && 'skipReason' in eur);
});

test('salary questions stay blank even when the label states a range', () => {
  const resolved = resolveKnownAnswer('desired salary (e.g. USD 90,000 - 110,000)', 'text', {}, undefined);
  assert.ok(resolved && 'skipReason' in resolved);
});

test('eeoAnswer is exact-match-only, never a near-miss (R-018)', () => {
  assert.equal(eeoAnswer('Male'), 'Male');
  assert.equal(eeoAnswer(undefined), 'Decline to self-identify');
});

test('isOpenEndedQuestion recognizes prose asks and rejects short field labels', () => {
  assert.equal(isOpenEndedQuestion('Why do you want to work here?'), true);
  assert.equal(isOpenEndedQuestion('Tell us about a project you are proud of'), true);
  assert.equal(isOpenEndedQuestion('First Name'), false);
  assert.equal(isOpenEndedQuestion('LinkedIn URL'), false);
});

test('a link question resolves via classifyField, so callers never reach the essay drafter', () => {
  // isOpenEndedQuestion is a lone-standing heuristic (a "share" verb fires it here, same as the
  // extension's own copy), and by design it does NOT know about classifyField - see the
  // extension's comment on isOpenEndedQuestion: "Callers must ALSO check that the label maps to
  // no profile field". The real guarantee lives in call ORDER: discoverAndResolveQuestions in
  // submissionRunner.ts always tries resolveKnownAnswer first and only falls through to the
  // drafter when it returns null, so a resolvable link question never reaches isOpenEndedQuestion
  // in practice, even though the predicate alone would fire on this label.
  const label = 'please share a link to your GitHub';
  assert.equal(classifyField(label), 'github_url');
  const resolved = resolveKnownAnswer(label, 'text', { github_url: 'https://github.com/example' }, undefined);
  assert.deepEqual(resolved, { value: 'https://github.com/example' });
});

test('fitToBudget clips to a whole sentence, never mid-word, and returns null when none fits (R-029)', () => {
  const text =
    'I built a real-time data pipeline at Acme that cut p99 latency by 40%. It cut latency by 40%. This is a fragment';
  assert.equal(fitToBudget(text, 1000), text);
  const clipped = fitToBudget(text, 80);
  assert.equal(clipped, 'I built a real-time data pipeline at Acme that cut p99 latency by 40%.');
  // Under the ~40-char floor a "sentence" is almost certainly a fragment of the first clause, not
  // a real answer - a blank flagged for the student beats a confident non-answer.
  assert.equal(fitToBudget('Yes. This is a fragment', 6), null);
  assert.equal(fitToBudget('short', 3), null);
});

test('an unclassifiable, non-essay label resolves to nothing rather than a guess', () => {
  assert.equal(resolveKnownAnswer('First Name', 'text', {}, undefined), null);
  assert.equal(isOpenEndedQuestion('First Name'), false);
});

test('WORK_ELIGIBILITY_QUESTION does not fire on unrelated "sponsor" mentions', () => {
  // A bare `sponsor` match previously classified "How did you hear about us? [..., Sponsored ad]"
  // as a work-eligibility question - see the extension's own comment on this regex.
  assert.equal(WORK_ELIGIBILITY_QUESTION.test('how did you hear about us? (LinkedIn, Sponsored ad, ...)'), false);
});

test('Ashby discovery labels drop placeholder text and provider UUIDs before answer mapping', () => {
  assert.equal(
    normalizeDiscoveredLabel('what excites you about deepgram? type here... e60b1271-ae04-4eec-a264-5684f39b2229 e60b1271-ae04-4eec-a264-5684f39b2229'),
    'what excites you about deepgram?',
  );
});

test('Greenhouse labels drop question handles and duplicate visible labels before answer mapping', () => {
  assert.equal(
    normalizeDiscoveredLabel('linkedin profile linkedin profile question_12447419007'),
    'linkedin profile',
  );
  assert.equal(
    normalizeDiscoveredLabel('how did you hear about us?* question_37536799002'),
    'how did you hear about us?',
  );
});

test('discovered question labels preserve employer capitalization', () => {
  assert.equal(
    normalizeDiscoveredLabel('Do you consent to Brex processing your personal information? question_37536799002'),
    'Do you consent to Brex processing your personal information?',
  );
});

test('Ashby fixed profile fields never reappear as editable custom questions', () => {
  const normalized = normalizeStoredPortalQuestions([
    { id: 'phone', question: 'phone 1-415-555-1234... 9c344ee4-aecc-4162-a897-8e1e99b3025a', answer: '+971 50 123 4567' },
    { id: 'linkedin', question: 'linkedin type here... c4edc16d-6480-47b0-9f7a-1571301d1d16', answer: 'https://linkedin.com/in/example' },
    { id: 'essay', question: 'what excites you about deepgram? type here... e60b1271-ae04-4eec-a264-5684f39b2229', answer: 'Reviewed answer' },
  ], 'ashby');

  assert.deepEqual(normalized, [
    { id: 'essay', question: 'what excites you about deepgram?', answer: 'Reviewed answer' },
  ]);
});

test('review question labels are never empty or longer than the managed runner limit', () => {
  assert.equal(normalizeReviewQuestionLabel('required field'), '');
  assert.equal(normalizeReviewQuestionLabel('56f41b98-0250-4e12-a2d1-aa038a33af27'), '');
  assert.equal(
    normalizeReviewQuestionLabel('how did you hear about this job?* how did you hear about this job?'),
    'how did you hear about this job',
  );
  assert.equal(
    normalizeReviewQuestionLabel(
      'briefly describe your experience with ads review/ads trust and safety* briefly describe your experience with ads review/ads trust and safety',
    ),
    'briefly describe your experience with ads review/ads trust and safety',
  );
  assert.equal(
    normalizeReviewQuestionLabel('what gender identity do you most closely identify with? * 430'),
    'what gender identity do you most closely identify with?',
  );
  assert.equal(
    normalizeReviewQuestionLabel('are you a person of transgender experience? * 431'),
    'are you a person of transgender experience?',
  );

  const longLabel = `Why Samsara? ${'Tell us more about your systems work '.repeat(30)}`;
  const normalized = normalizeReviewQuestionLabel(longLabel);
  assert.ok(normalized.length > 0);
  assert.ok(normalized.length <= REVIEW_QUESTION_TEXT_MAX_LENGTH);
  assert.equal(longLabel.toLowerCase().startsWith(normalized.toLowerCase()), true);
});

test('stored portal questions drop malformed labels and cap long discovered text', () => {
  const longLabel = `What makes you excited about this internship? ${'Please be specific '.repeat(35)}`;
  const normalized = normalizeStoredPortalQuestions([
    { id: 'blank', question: ' ', answer: 'ignored' },
    { id: 'uuid', question: '56f41b98-0250-4e12-a2d1-aa038a33af27', answer: 'ignored' },
    { id: 'long', question: longLabel, answer: 'I like customer-facing infrastructure.' },
  ], 'greenhouse');

  assert.equal(normalized.length, 1);
  assert.equal(normalized[0].id, 'long');
  assert.ok(normalized[0].question.length <= REVIEW_QUESTION_TEXT_MAX_LENGTH);
  assert.equal(longLabel.toLowerCase().startsWith(normalized[0].question.toLowerCase()), true);
});

test('long discovered labels can be capped for storage without hiding refusal checks', () => {
  const longSensitive = `${'Please read this context carefully. '.repeat(20)}Will you now or in the future require sponsorship?`;

  assert.equal(normalizeReviewQuestionLabel(longSensitive).length <= REVIEW_QUESTION_TEXT_MAX_LENGTH, true);
  assert.equal(isRefusedQuestion(longSensitive), true);
});
