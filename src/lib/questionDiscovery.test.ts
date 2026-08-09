import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyField,
  discoveredFieldIsRequired,
  eeoAnswer,
  isCoreIdentityField,
  labelMarksRequired,
  fitToBudget,
  graduationDateAnswer,
  isOpenEndedQuestion,
  isPolarQuestion,
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
  type ApplicationProfileLike,
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
  for (const [label, jd] of [
    ['are you legally authorized to work in the country where the job is located?', 'This role is based in San Francisco, California.'],
    ['Are you legally authorized to work in the country in which you are applying?', 'Mountain View, CA'],
    ['are you legally authorized to work?', 'US benefits and Canadian customers are described below.'],
  ] as const) {
    const scoped = resolveKnownAnswer(label, 'text', { work_authorized: true }, jd);
    assert.ok(scoped && 'skipReason' in scoped, label);
  }
  assert.deepEqual(
    resolveKnownAnswer('Are you currently eligible to work in the United States of America?', 'text', { work_authorized: true }, undefined),
    { value: 'Yes' },
  );
  const unscopedSponsorship = resolveKnownAnswer(
    'will you now or in the future require sponsorship for employment visa status?',
    'text',
    { needs_sponsorship: true },
    undefined,
  );
  assert.ok(unscopedSponsorship && 'skipReason' in unscopedSponsorship);
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
  const pronounIsNotCountryScope = resolveKnownAnswer(
    'Tell us whether you will require visa sponsorship for employment.',
    'text',
    { needs_sponsorship: false },
    undefined,
  );
  assert.ok(pronounIsNotCountryScope && 'skipReason' in pronounIsNotCountryScope);
  const uppercasePronounIsNotCountryScope = resolveKnownAnswer(
    'Tell US whether you will require visa sponsorship for employment.',
    'text',
    { needs_sponsorship: false },
    undefined,
  );
  assert.ok(uppercasePronounIsNotCountryScope && 'skipReason' in uppercasePronounIsNotCountryScope);

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

  const statusDetail = resolveKnownAnswer(
    'If you answered “Yes” above to requiring visa sponsorship now or in the future for work authorization, please respond to the following questions. What is your current immigration status/basis of your current work authorization?',
    'text',
    { work_authorized: true, needs_sponsorship: true },
    undefined,
  );
  assert.ok(statusDetail && 'skipReason' in statusDetail);

  const expiryDetail = resolveKnownAnswer(
    'If you have a current work authorization/status, when does it expire?',
    'text',
    { work_authorized: true, needs_sponsorship: true },
    undefined,
  );
  assert.ok(expiryDetail && 'skipReason' in expiryDetail);
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

test('candidate privacy consent always requires the exact application notice', () => {
  const label = 'By selecting "I agree," I understand that the information I have provided as part of this job application will be processed in accordance with the Candidate Privacy Policy.';
  const unasked = resolveKnownAnswer(label, 'text', {}, undefined);
  assert.ok(unasked && 'skipReason' in unasked);
  assert.match(unasked.skipReason, /privacy notice left for you to agree to yourself/);

  const privacy = resolveKnownAnswer(label, 'text', { accept_privacy_notices: true }, undefined);
  assert.ok(privacy && 'skipReason' in privacy);

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
      question: 'will you now or in the future require immigration sponsorship in the United States?',
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

test('send-time refresh clears stale refused answers across the reviewer examples', () => {
  const stale = refreshKnownQuestionAnswers([
    { question: 'Can you work onsite in our Chicago office five days per week?', answer: 'Yes' },
    { question: 'When can you start?', answer: 'June 1, 2026' },
    { question: 'Please acknowledge the Candidate Privacy Notice.', answer: 'Yes' },
    { question: 'I certify that all information in this application is true and complete.', answer: 'Yes' },
    { question: 'AI Policy for Interviewers', answer: 'Yes' },
    { question: 'Social Security Number', answer: '123-45-6789' },
  ], {
    onsite_commitment: 'anywhere',
    availability_date: 'June 1, 2026',
    accept_privacy_notices: true,
    attest_truthful_information: true,
  }, undefined);
  assert.deepEqual(stale.map((question) => question.answer), ['', '', '', '', '', '']);
});

test('only provenance from the current explicit applicant review preserves a refused answer', () => {
  const reviewedAt = '2026-08-09T12:00:00.000Z';
  const question = {
    question: 'Can you work onsite in our Chicago office five days per week?',
    answer: 'Yes',
    answer_source: 'applicant_review' as const,
    answer_reviewed_at: reviewedAt,
  };
  assert.equal(refreshKnownQuestionAnswers([question], {}, undefined, reviewedAt)[0].answer, 'Yes');
  const stale = refreshKnownQuestionAnswers([question], {}, undefined, '2026-08-09T13:00:00.000Z')[0];
  assert.equal(stale.answer, '');
  assert.equal('answer_source' in stale, false);
  assert.equal('answer_reviewed_at' in stale, false);
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
  assert.equal(isRefusedQuestion('At the time of application, are you 18+ years of age?'), true);
  assert.equal(resolveKnownAnswer('At the time of application, are you 18+ years of age?', 'text', {}, undefined), null);
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
      'will you now or in the future require sponsorship for employment visa status in the United States?',
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

test('legacy broad location preferences never answer an exact employer commitment', () => {
  /* RENAMED AND REVERSED, 2026-08-09. It used to be called "...is answered as an approved logistics
     acknowledgement" and it asserted exactly what this file now forbids: `{ address_city: 'Dubai' }`
     in, `{ value: 'Yes' }` out, for a question about being in a US office three days a week.

     The word doing the work in the old name was "approved". Nothing approved it. There was no
     column, no consent and no stored value anywhere behind that Yes - just
     `return isLocationCommitmentQuestion(label) ? { value: 'Yes' } : null`, and a comment upstream
     calling the question "routine". A commitment about where a person will physically be for the
     next twelve weeks is not routine, and calling it logistics does not make it less of a statement
     she never made. It was found on a Redwood Materials packet that was ready to send with "Are you
     available to work from our office in San Francisco?" answered Yes.

     What survives from the old test is its real content: these labels must be RECOGNISED, and must
     never fall through to the essay drafter. That is still asserted, and the answer now comes from
     application_profile.onsite_commitment / onsite_locations. */
  const label = 'this role is in-office three days a week, can you commit to that?';
  assert.equal(classifyField(label), 'onsite_commitment');

  // Nothing stored: refused by name, and it is a skipReason rather than a null, so it cannot fall
  // through to classifyField and come back as her home city.
  const unasked = resolveKnownAnswer(label, 'select', { address_city: 'Dubai' }, undefined);
  assert.ok(unasked && 'skipReason' in unasked);
  assert.match(unasked.skipReason, /where you will work from is yours to answer/);

  for (const profile of [
    { address_city: 'Dubai', onsite_commitment: 'anywhere' as const },
    { address_city: 'Dubai', onsite_commitment: 'no' as const },
    { address_city: 'Dubai', onsite_commitment: 'listed_locations' as const, onsite_locations: ['San Francisco'] },
  ]) {
    const held = resolveKnownAnswer(label, 'select', profile, undefined);
    assert.ok(held && 'skipReason' in held);
  }

  // Relocation is its own commitment and its own column: agreeing to sit in an office is not
  // agreeing to move house, so onsite_commitment alone must not answer it.
  assert.equal(classifyField('are you willing to relocate to San Francisco?'), null);
  const relocation = resolveKnownAnswer(
    'are you willing to relocate to San Francisco?',
    'text',
    { address_city: 'Dubai', onsite_commitment: 'anywhere' },
    undefined,
  );
  assert.ok(relocation && 'skipReason' in relocation);
  const legacyRelocation = resolveKnownAnswer(
    'are you willing to relocate to San Francisco?',
    'text',
    { relocation_willingness: 'no' },
    undefined,
  );
  assert.ok(legacyRelocation && 'skipReason' in legacyRelocation);
});

/* THE TOGETHER AI LABEL, which is the day-count shape rather than the bare one.
 *
 * Packet 5b52aba8-124c-4688-8b9c-a7a49d20467b sat at the send gate on 2026-08-08 with "are you
 * willing to work four days per week in our san francisco office?" answered Yes, alongside the
 * Redwood packet covered above. It is here because it is the shape that reads LEAST like a
 * commitment: a cadence and a city buried in a politeness. It must still be recognised, and it must
 * still be refused, and neither may be true only for the bare wording.
 *
 * What it does NOT assert any more is an answer built out of onsite_commitment and onsite_locations.
 * Those columns carry no cadence and no duration, so "four days per week" cannot be settled by
 * them, and the resolver now holds every such commitment. That refusal is the test below.
 */
test('the four-days-per-week shape is recognised as the same commitment and held', () => {
  const together = 'are you willing to work four days per week in our san francisco office?';
  assert.equal(classifyField(together), 'onsite_commitment');

  // Refused by name, and not guessed from her address, whatever the columns happen to hold.
  for (const profile of [
    { address_city: 'Dubai' },
    { onsite_commitment: 'anywhere' as const },
    { onsite_commitment: 'listed_locations' as const, onsite_locations: ['san francisco, ca'] },
  ]) {
    const held = resolveKnownAnswer(together, 'select', profile, undefined);
    assert.ok(held && 'skipReason' in held);
    assert.match(held.skipReason, /where you will work from is yours to answer/);
  }
});

test('location without exact cadence and duration is insufficient for an office commitment', () => {
  const profile = {
    address_city: 'Dubai',
    onsite_commitment: 'listed_locations' as const,
    onsite_locations: ['Los Angeles', 'New York'],
  };
  for (const [label, jd] of [
    ['Are you available to work from our office in Los Angeles?', undefined],
    ['Are you available to work from our office in San Francisco?', undefined],
    ['Are you willing to work in-person for 12 weeks during the internship?', 'Software Engineer Intern\nNew York, NY'],
    ['Can you commute to our Chicago office five days per week?', 'Chicago, IL'],
    ['Are you able to work remotely for the duration of this internship?', 'Remote internship'],
    ['Can you work remotely from the United States five days per week?', 'Remote, United States'],
    ['This is a remote-only role. Are you comfortable with that schedule?', 'Remote-only role'],
  ] as const) {
    const held = resolveKnownAnswer(label, 'select', profile, jd);
    assert.ok(held && 'skipReason' in held, label);
  }
});

test('a preferred-location choice is not drafted as prose', () => {
  const label = "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.";
  assert.equal(classifyField(label), null);
  assert.equal(isOpenEndedQuestion(label), false);
  const resolved = resolveKnownAnswer(label, 'text', { address_city: 'Los Angeles' }, 'Locations to be discussed with your recruiter.');
  assert.ok(resolved && 'skipReason' in resolved);
  assert.match(resolved.skipReason, /location choice left for you/);
});

test('standing profile consent never accepts a posting-specific privacy notice', () => {
  const labels = [
    'Do you consent to Brex processing your personal information for the purpose of assessing your candidacy for this position?',
    "Please review and acknowledge Cloudflare's Candidate Privacy Policy.",
    'Yes, I consent',
  ];
  for (const label of labels) {
    for (const profile of [{}, { accept_privacy_notices: true }]) {
      const held = resolveKnownAnswer(label, 'text', profile, undefined);
      assert.ok(held && 'skipReason' in held, label);
    }
  }
});

test('the bare privacy labels three employers actually ship are recognised', () => {
  // Five Rings ships "Privacy Policy Acknowledgement", IMC "Privacy Statement", Point72 just
  // "Privacy". None of them is a sentence, so the prose-shaped consent rule matched none of them
  // and all three sat empty and blocked the application.
  for (const label of ['Privacy', 'Privacy Statement', 'Privacy Policy Acknowledgement', 'Candidate Privacy Notice']) {
    const stored = resolveKnownAnswer(label, 'checkbox', { accept_privacy_notices: true }, undefined);
    assert.ok(stored && 'skipReason' in stored, label);
    const unasked = resolveKnownAnswer(label, 'checkbox', {}, undefined);
    assert.ok(unasked && 'skipReason' in unasked, label);
  }
});

test('a code of conduct is neither a truthfulness attestation nor a privacy notice, so it is never ticked', () => {
  // IMC ships "Interview Code of Conduct" beside "Privacy Statement". Accepting a behavioural
  // policy is not one of the two things Litos may affirm, and no stored consent unlocks it.
  for (const ap of [{}, { accept_privacy_notices: true, attest_truthful_information: true }]) {
    const resolved = resolveKnownAnswer('Interview Code of Conduct', 'checkbox', ap, undefined);
    assert.ok(resolved && 'skipReason' in resolved);
    assert.match(resolved.skipReason, /code of conduct/);
  }
});

test('high school and offer questions are answered from the stored facts, not from a default', () => {
  /* CHANGED 2026-08-08. Both of these used to answer from a constant with nothing on file: "Yes" to
     a confirmation about a qualification, and "No" to "do you have any offers?". Each is a factual
     claim about the student made to an employer, and neither was hers. */
  const diploma = 'To be considered for this role, you must have earned a high school diploma (or an equivalent degree). Please confirm the statement below.';
  const held = resolveKnownAnswer(diploma, 'select', {}, undefined);
  assert.ok(held && 'skipReason' in held);
  assert.match(held.skipReason, /high school graduation question left for you/);
  assert.deepEqual(
    resolveKnownAnswer(diploma, 'select', { high_school_grad_date: 'June 2024' }, undefined),
    { value: 'Yes' },
  );

  const offers = 'Do you have any offer deadlines that we should be aware of?';
  const offersHeld = resolveKnownAnswer(offers, 'select', {}, undefined);
  assert.ok(offersHeld && 'skipReason' in offersHeld);
  assert.match(offersHeld.skipReason, /offer question left for you/);
  assert.deepEqual(
    resolveKnownAnswer(offers, 'select', { has_outstanding_offers: false }, undefined),
    { value: 'No' },
  );

  // The follow-up detail box after a "no" is N/A, not "No": it is asking what the offers are.
  assert.deepEqual(
    resolveKnownAnswer('If you answered “Yes” above, please provide details about your offer deadlines.', 'textarea', { has_outstanding_offers: false }, undefined),
    { value: 'N/A' },
  );
  // And when there ARE offers, the same box gets the stored detail rather than a blanket N/A.
  assert.deepEqual(
    resolveKnownAnswer(
      'If you answered “Yes” above, please provide details about your offer deadlines.',
      'textarea',
      { has_outstanding_offers: true, outstanding_offer_details: 'One offer, decision due 15 November 2026.' },
      undefined,
    ),
    { value: 'One offer, decision due 15 November 2026.' },
  );
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
  assert.equal(classifyField('What is your expected graduation year?'), 'graduation_year');
  assert.equal(classifyField('When did you graduate from High School?'), null);
  assert.deepEqual(resolveKnownAnswer('School', 'text', profile, undefined), { value: profile.school });
  // A bare "Degree" is the education section's LEVEL picker on every ATS that has one, and it is
  // a closed list. This used to be recognised only through Greenhouse's `degree--0` handle, which
  // normalizeDiscoveredLabel now strips as noise, so the rule moved onto the visible label. The
  // old expectation here (the full degree sentence) is the Class A defect in miniature: a list
  // offering "Bachelor's Degree" was asked for "Bachelor of Science in Computer Science",
  // matched nothing, and the field came back "required and is still empty".
  assert.deepEqual(resolveKnownAnswer('Degree', 'text', profile, undefined), { value: "Bachelor's Degree" });
  assert.deepEqual(
    resolveKnownAnswer('What degree are you currently pursuing?', 'text', profile, undefined),
    { value: profile.degree },
  );
  assert.deepEqual(resolveKnownAnswer('Discipline', 'text', profile, undefined), { value: profile.major });
  assert.deepEqual(resolveKnownAnswer('What is your expected graduation year?', 'text', { grad_year: 2028 }, undefined), { value: '2028' });
});

test('live-audit profile labels beat generic wording and stay out of drafts', () => {
  const profile = {
    full_name: 'Mehek Mandal',
    linkedin_url: 'https://www.linkedin.com/in/mehekmandal/',
    most_recent_employer: 'Tonee - AI Texting Tone Detector',
    employer_history: ['Tonee - AI Texting Tone Detector'],
    degree: 'Bachelor of Science in Computer Science & Business Administration, Finance Emphasis',
    major: 'Computer Science',
    grad_date: 'May 2028',
    grad_year: 2028,
  };

  assert.equal(classifyField('LinkedIn Profile, if available'), 'linkedin_url');
  assert.deepEqual(resolveKnownAnswer('LinkedIn Profile, if available', 'textarea', profile, undefined), {
    value: 'https://www.linkedin.com/in/mehekmandal/',
  });
  assert.deepEqual(resolveKnownAnswer('Where have you most recently worked?', 'text', profile, undefined), {
    value: 'Tonee - AI Texting Tone Detector',
  });
  assert.equal(resolveKnownAnswer('Current employer', 'text', profile, undefined), null);
  assert.deepEqual(resolveKnownAnswer('Have you previously worked at Tonee - AI Texting Tone Detector?', 'select', profile, undefined), {
    value: 'Yes',
  });
  assert.deepEqual(resolveKnownAnswer('Have you previously worked at Samsara?', 'select', profile, undefined), {
    value: 'No',
  });
  const nearMissPriorEmployer = resolveKnownAnswer('Have you previously worked at Tone?', 'select', profile, undefined);
  assert.ok(nearMissPriorEmployer && 'skipReason' in nearMissPriorEmployer && nearMissPriorEmployer.skipReason.startsWith('prior employer'));
  const genericPriorEmployer = resolveKnownAnswer('Have you previously worked at any employer in this industry?', 'select', profile, undefined);
  assert.ok(genericPriorEmployer && 'skipReason' in genericPriorEmployer && genericPriorEmployer.skipReason.startsWith('prior employer'));
  assert.deepEqual(resolveKnownAnswer('When are you expecting to graduate from your degree?', 'select', profile, undefined), {
    value: 'May 2028',
  });
  const storedProcessing = resolveKnownAnswer(
    'Processing of Personal Data',
    'select',
    { ...profile, accept_privacy_notices: true },
    undefined,
  );
  assert.ok(storedProcessing && 'skipReason' in storedProcessing);
  // Same label, no stored acceptance: held rather than confirmed on her behalf.
  const unconsentedProcessing = resolveKnownAnswer('Processing of Personal Data', 'select', profile, undefined);
  assert.ok(unconsentedProcessing && 'skipReason' in unconsentedProcessing);
  assert.deepEqual(
    resolveKnownAnswer('Are you majoring in STEM (Computer Science, Electrical Engineering, Data Science, Cog Sci, Information Management/Systems, Mathematics, Machine Learning, etc.)?', 'select', profile, undefined),
    { value: 'Yes' },
  );
  /* CHANGED 2026-08-09: was `{ value: 'Yes' }`, a constant with nothing stored. "AI Policy for
     Interviewers" is acceptance of a behavioural policy binding her conduct in a live interview.
     applicationConsentAnswer already refuses IMC's "Interview Code of Conduct" with the reasoning
     "A behavioural policy is not a privacy notice and not a statement of truth", and two wordings
     of one policy cannot have two answers. One company asks it, which is below the two-posting bar
     for an onboarding column, so it becomes an ask at Apply. */
  const aiPolicy = resolveKnownAnswer('AI Policy for Interviewers', 'select', profile, undefined);
  assert.ok(aiPolicy && 'skipReason' in aiPolicy);
  assert.match(aiPolicy.skipReason, /interview conduct policy/);
});

test('referral source is relayed when stored and refused when it is not', () => {
  /* CHANGED 2026-08-09. This asserted "Company website" from an EMPTY profile. That constant was
     described elsewhere as "a deliberate product behaviour rather than stored data", and it was
     both: deliberate, and a statement of fact about how she found the posting that she never made -
     usually a false one, since Litos finds these on a monitored job board. Measured the same day:
     all 16 production rows carried "Company website" purely from the column default, so there was
     no account anywhere for which the answer was a person's choice.

     It is the most-asked question in the corpus (25 distinct labels, 20 employers), which is why it
     went to onboarding rather than to an ask at Apply. */
  assert.deepEqual(
    resolveKnownAnswer('How did you first hear about Five Rings?', 'text', { referral_source_default: 'LinkedIn' }, undefined),
    { value: 'LinkedIn' },
  );
  const unstored = resolveKnownAnswer('How did you first hear about Five Rings?', 'text', {}, undefined);
  assert.ok(unstored && 'skipReason' in unstored);
  assert.match(unstored.skipReason, /how you heard about this role is yours to answer/);
});

test('stored academic and onsite facts answer repeated select-shaped live questions', () => {
  const profile = {
    full_name: 'Mehek Mandal',
    school: 'University of Southern California',
    degree: 'Bachelor of Science',
    major: 'Computer Science',
    grad_date: 'May 2028',
    grad_year: 2028,
    currently_enrolled: true,
    languages: ['English', 'Hindi'],
  };

  assert.deepEqual(
    resolveKnownAnswer(
      'What is your legal first name? (Please also ensure that you input your legal first name in the first name field above).',
      'text',
      profile,
      undefined,
    ),
    { value: 'Mehek' },
  );
  const onsite = resolveKnownAnswer(
    'Are you able to work onsite 3 days a week?',
    'select',
    { ...profile, onsite_commitment: 'anywhere' as const },
    undefined,
  );
  assert.ok(onsite && 'skipReason' in onsite);
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
  assert.deepEqual(
    resolveKnownAnswer('If you were to join us for a technical interview, what is your preferred coding language when answering general coding questions?', 'select', { skills: ['Python', 'SQL'] }, undefined),
    { value: 'Python' },
  );
  assert.equal(
    resolveKnownAnswer('If you were to join us for a technical interview, what is your preferred coding language when answering general coding questions?', 'select', {}, undefined),
    null,
  );
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
  assert.deepEqual(resolveKnownAnswer('Do you live in New York or California?', 'select', profile, undefined), { value: 'No' });
  assert.equal(resolveKnownAnswer('Do you live in New York or California?', 'select', {}, undefined), null);
  /* CHANGED 2026-08-09. This asserted Yes for a profile whose address_city is Dubai. The residence
     half of that question had already been checked and failed, so the ONLY way to reach the Yes was
     for her not to live in Austin - and the answer it then gave was that she had confirmed plans to
     move there. It is the office commitment wearing a residence question's clothes, and it is now
     answered from the same stored fact. */
  const austin = 'Are you currently residing in the greater Austin area or have confirmed plans to be in Austin for the duration of this internship?';
  const austinUnasked = resolveKnownAnswer(austin, 'select', profile, undefined);
  assert.ok(austinUnasked && 'skipReason' in austinUnasked);
  for (const onsite_locations of [['Austin'], ['Los Angeles']]) {
    const held = resolveKnownAnswer(
      austin,
      'select',
      { ...profile, onsite_commitment: 'listed_locations' as const, onsite_locations },
      undefined,
    );
    assert.ok(held && 'skipReason' in held);
  }
  assert.deepEqual(
    resolveKnownAnswer('Are you currently enrolled in a Masters or PhD program for a technical field?', 'select', profile, undefined),
    { value: 'No' },
  );
  assert.deepEqual(
    resolveKnownAnswer(
      'Please confirm the season you are applying for.',
      'select',
      profile,
      'Software Engineer- Backend Intern (Fall 2026)',
    ),
    { value: 'Fall 2026' },
  );
  /* CHANGED 2026-08-09. This asserted "Fall 2026" from the JOB DESCRIPTION for "when are you able
     to join Astranis as an intern?" - the season the POSTING is for, replayed as a statement from
     her about when her calendar is free. The assertion directly above it stays, and is the
     distinction: "please confirm the season you are applying for" is asking what she applied to,
     and the posting is the authority on that. This one asks about her, and it is not. The stored
     availability_date still answers it; nothing else does. */
  for (const jd of ['Software Engineer- Backend Intern (Fall 2026)', undefined]) {
    const joinDate = resolveKnownAnswer('When are you able to join Astranis as an intern? (12 week minimum)', 'text', profile, jd);
    assert.ok(joinDate && 'skipReason' in joinDate, String(jd));
  }
  const storedJoinDate = resolveKnownAnswer(
    'When are you able to join Astranis as an intern? (12 week minimum)',
    'text',
    { ...profile, availability_date: 'June 1, 2026' },
    'Software Engineer- Backend Intern (Fall 2026)',
  );
  assert.ok(storedJoinDate && 'skipReason' in storedJoinDate);
  const privacy = resolveKnownAnswer(
    'Please review and acknowledge Cloudflare\'s Candidate Privacy Policy (cloudflare.com/candidate-privacy-notice/).',
    'checkbox',
    { ...profile, accept_privacy_notices: true },
    undefined,
  );
  assert.ok(privacy && 'skipReason' in privacy);
  assert.deepEqual(
    resolveKnownAnswer('Do you consider yourself a member of the LGBTQIA+ community?', 'select', profile, undefined),
    { value: 'Decline to self-identify' },
  );
  assert.deepEqual(
    resolveKnownAnswer('Which categories describe you? Select all that apply to you', 'checkbox', profile, undefined),
    { value: 'Decline to self-identify' },
  );
  /* CHANGED 2026-08-09: was `{ value: 'No' }`, a hardcoded legal declaration that she is under no
     non-compete, non-solicitation or confidentiality obligation to any past employer. No column was
     consulted and none could have been - nothing on file records her contracts. The label is
     already named in selfDeclaration.ts's list; this constant simply ran first and short-circuited
     it, which is the structural gap this change closes. One label, one company, so it is an ask at
     Apply rather than an onboarding column. */
  const restriction = resolveKnownAnswer(
    'Are you currently bound by any agreements with a current or former employer that may restrict your ability to work for Scale AI?',
    'select',
    profile,
    undefined,
  );
  assert.ok(restriction && 'skipReason' in restriction);
  assert.match(restriction.skipReason, /agreements with a past employer/);
});

test('Greenhouse acknowledgements remain posting-specific despite standing booleans', () => {
  /* CHANGED 2026-08-08. Two of these were auto-answered "Yes" with nothing stored:
     - "this role is my top preference and I will not be considered for other tech and/or quant
       roles at Akuna this season" is a binding exclusivity commitment over her whole recruiting
       season. It is not a truthfulness attestation and it is not a privacy notice.
     - "my resume must be submitted in PDF format" is a process term. Harmless and still not ours.
     Meanwhile the ONE thing Litos may legitimately affirm - that her information is true - was
     returning null and blocking every Akuna application. Both halves are now the right way round. */
  const topPreference = resolveKnownAnswer(
    'By submitting this application and answering "yes" below, I acknowledge that this role is my top preference and I will not be considered for other tech and/or quant roles at Akuna for this recruiting season.',
    'combobox',
    { attest_truthful_information: true, accept_privacy_notices: true },
    undefined,
  );
  assert.ok(topPreference && 'skipReason' in topPreference);
  assert.match(topPreference.skipReason, /which roles you will be considered for/);

  const optionsMarket = resolveKnownAnswer(
    'Do you have prior experience working at an options market making trading firm?',
    'combobox',
    {},
    undefined,
  );
  assert.ok(optionsMarket && 'skipReason' in optionsMarket);
  assert.equal(optionsMarket?.skipReason.includes('options market making experience question left for you'), true);

  const certification = 'I certify that all information I have provided in order to apply for this position with Akuna is true, complete, and accurate.';
  const uncertified = resolveKnownAnswer(certification, 'combobox', {}, undefined);
  assert.ok(uncertified && 'skipReason' in uncertified);
  assert.match(uncertified.skipReason, /certification that your information is true/);
  const storedCertification = resolveKnownAnswer(
    certification,
    'combobox',
    { attest_truthful_information: true },
    undefined,
  );
  assert.ok(storedCertification && 'skipReason' in storedCertification);

  const pdf = resolveKnownAnswer(
    'I acknowledge that my resume must be submitted in PDF format to be considered.',
    'combobox',
    { attest_truthful_information: true, accept_privacy_notices: true },
    undefined,
  );
  assert.ok(pdf && 'skipReason' in pdf);
  assert.match(pdf.skipReason, /how your resume is submitted/);
});

test('a job location preference is posting-specific even with a stored metro list', () => {
  /* CHANGED 2026-08-09. The old name was "...use the safe posting locations context" and the rule
     it pinned was: take the last line of the JOB DESCRIPTION that looks like a US city and return
     it as her preferred location. "Safe" meant well-formed, not true. Measured in production, that
     shipped "San Francisco, CA" as the answer to Optiver's "please rank your location preference in
     order of most to least preferred: austin, chicago, greenwich, houston, new york city" and to
     "what is your office location preference? (note: the internship is only available in new york
     and austin, not chicago)" - a preference she never expressed, naming an office the employer had
     just said was not on offer.

     Her stored onsite_locations ARE an ordered preference, so the first of them the employer offers
     is an honest answer, and it is now the only one given. */
  const label = "Please choose the single location that you're the most interested in, and we will discuss more with you as you move through the process.";
  const context = [
    'Build data systems for customers.',
    'Mountain View, CA',
    'San Francisco, CA',
  ].join('\n');

  assert.equal(classifyField(label), null);
  const unasked = resolveKnownAnswer(label, 'select', {}, context);
  assert.ok(unasked && 'skipReason' in unasked);
  assert.match(unasked.skipReason, /location choice left for you/);

  const storedPreference = resolveKnownAnswer(label, 'select', {
    onsite_commitment: 'listed_locations',
    onsite_locations: ['San Francisco', 'Austin'],
  }, context);
  assert.ok(storedPreference && 'skipReason' in storedPreference);
  // Optiver's list offers none of hers, so it stays hers to answer rather than borrowing a city
  // from the posting header.
  const noOverlap = resolveKnownAnswer(
    'Please rank your location preference in order of most to least preferred: Austin, Chicago, Greenwich, Houston, New York City.',
    'select',
    { onsite_commitment: 'listed_locations', onsite_locations: ['Los Angeles'] },
    context,
  );
  assert.ok(noOverlap && 'skipReason' in noOverlap);
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

test('Databricks prior employer questions answer no from known employer history', () => {
  assert.deepEqual(
    resolveKnownAnswer(
      'Do you currently or have you previously worked for Databricks in the past?',
      'combobox',
      { employer_history: ['SoFi', 'Traeco', 'Tonee'] },
      undefined,
    ),
    { value: 'No' },
  );
  assert.deepEqual(
    resolveKnownAnswer(
      'Do you currently or have you previously worked for Databricks in the past?',
      'combobox',
      { employer_history: ['Databricks, Inc.'] },
      undefined,
    ),
    { value: 'Yes' },
  );
  const composite = resolveKnownAnswer(
    'Have you previously worked for Goldman Sachs or its affiliates?',
    'combobox',
    { employer_history: ['SoFi', 'Traeco', 'Tonee'] },
    undefined,
  );
  assert.ok(composite && 'skipReason' in composite && composite.skipReason.startsWith('prior employer'));
  const subsidiary = resolveKnownAnswer(
    'Have you previously worked for Databricks or any subsidiary?',
    'combobox',
    { employer_history: ['SoFi', 'Traeco', 'Tonee'] },
    undefined,
  );
  assert.ok(subsidiary && 'skipReason' in subsidiary && subsidiary.skipReason.startsWith('prior employer'));
  const punctuationComposite = resolveKnownAnswer(
    'Have you previously worked for Databricks, its subsidiaries or affiliates?',
    'combobox',
    { employer_history: ['SoFi', 'Traeco', 'Tonee'] },
    undefined,
  );
  assert.ok(punctuationComposite && 'skipReason' in punctuationComposite && punctuationComposite.skipReason.startsWith('prior employer'));
  const relatedButNotEqual = resolveKnownAnswer(
    'Have you previously worked at Tone?',
    'combobox',
    { employer_history: ['Tonee - AI Texting Tone Detector'] },
    undefined,
  );
  assert.ok(relatedButNotEqual && 'skipReason' in relatedButNotEqual && relatedButNotEqual.skipReason.startsWith('prior employer'));
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
  assert.ok(resolveKnownAnswer('Are you available for a 12-week full-time (40 hours per week) internship between September - December 2026?', 'select', {
    ...profile,
    availability_term: 'Available full-time for 12 weeks between September and December 2026',
  }, undefined) && 'skipReason' in resolveKnownAnswer('Are you available for a 12-week full-time (40 hours per week) internship between September - December 2026?', 'select', {
    ...profile,
    availability_term: 'Available full-time for 12 weeks between September and December 2026',
  }, undefined)!);
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
  /* CHANGED 2026-08-09: was `{ value: 'Backend/Systems' }`, produced by counting backend, frontend
     and full-stack keywords in the EMPLOYER'S OWN job description and returning whichever the
     employer used most. That is not a reading of a fact about her, it is a machine telling the
     employer what the employer wants to hear - and it scored "2nd choice" identically to "1st
     choice", because the JD is the same text both times. An area of interest is a self-assessment,
     the same family as the skill self-ratings selfDeclaration.ts refuses, and nothing is on file. */
  const area = resolveKnownAnswer(
    '1st choice: Area of interest in Software Engineering',
    'select',
    profile,
    'Engineering teams build software that handles traffic across our global network. Technologies include Go, Rust, C/C++ and Python services.',
  );
  assert.ok(area && 'skipReason' in area);
  assert.match(area.skipReason, /area of interest left for you/);
  assert.ok(
    resolveKnownAnswer('1st choice: Area of interest in Software Engineering', 'select', profile, 'Software engineering internship')
    && 'skipReason' in resolveKnownAnswer('1st choice: Area of interest in Software Engineering', 'select', profile, 'Software engineering internship')!,
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

// ---------------------------------------------------------------------------
// Wrong-answer regressions, fixtured on the exact labels found in the owner's
// 25 most recent prod packets (spec._review.questions, pulled 2026-08-08).
// Each of these was SUBMITTED-READY with a factually wrong value. A blank field
// stalls a run; a confident wrong answer goes to the employer.
// ---------------------------------------------------------------------------

const PROD_OWNER_PROFILE = {
  full_name: 'Mehek Mandal',
  phone: '+971 567417451',
  address_city: 'Dubai',
  address_state: 'Dubai',
  address_country: 'United Arab Emirates',
  citizenship: 'India',
  work_authorized: true,
  needs_sponsorship: true,
  availability_date: 'August 6, 2026',
  school: 'University of Southern California, Viterbi School of Engineering',
  degree: 'Bachelor of Science in Computer Science',
  grad_date: 'May 2028',
  grad_year: 2028,
  currently_enrolled: true,
  gpa: '3.89',
  gpa_scale: '4.0',
  major: 'Computer Science',
};

function skipReasonOf(result: ReturnType<typeof resolveKnownAnswer>): string | null {
  return result && 'skipReason' in result ? result.skipReason : null;
}

function refuses(label: string, inputType = 'text', profile = PROD_OWNER_PROFILE): void {
  const result = resolveKnownAnswer(label, inputType, profile, undefined);
  assert.ok(
    result === null || 'skipReason' in result,
    `expected no answer for ${JSON.stringify(label.slice(0, 70))}, got ${JSON.stringify(result)}`,
  );
}

test('Greenhouse education "start date month/year" is not job availability (Five Rings, IMC, Tower)', () => {
  // These went out as "August 6, 2026" - the stored availability_date - inside the education block.
  assert.equal(classifyField('start date month* start-month--0'), 'education_start_date');
  assert.equal(classifyField('start date year* start date year start-year--0'), 'education_start_date');
  refuses('start date month* start-month--0');
  refuses('start date year* start date year start-year--0', 'number');
  assert.match(
    skipReasonOf(resolveKnownAnswer('start date month* start-month--0', 'text', PROD_OWNER_PROFILE, undefined)) ?? '',
    /education start date/i,
  );

  // ...and it resolves from the education history once that history carries a start date.
  const withHistory = { ...PROD_OWNER_PROFILE, education_start_date: 'August 2024' };
  assert.deepEqual(
    resolveKnownAnswer('start date month* start-month--0', 'text', withHistory, undefined),
    { value: 'August' },
  );
  assert.deepEqual(
    resolveKnownAnswer('start date year* start date year start-year--0', 'number', withHistory, undefined),
    { value: '2024' },
  );
  // Job availability is reference-only until its scope and expiry are modeled.
  assert.equal(classifyField('when can you start?'), 'availability_date');
  const availability = resolveKnownAnswer('When are you available to start?', 'text', PROD_OWNER_PROFILE, undefined);
  assert.ok(availability && 'skipReason' in availability);
});

test('education end date is the graduation date, and a whole-range field needs both ends', () => {
  assert.equal(classifyField('end date month* end-month--0'), 'education_end_date');
  assert.deepEqual(
    resolveKnownAnswer('end date month* end-month--0', 'text', PROD_OWNER_PROFILE, undefined),
    { value: 'May' },
  );
  assert.deepEqual(
    resolveKnownAnswer('end date year* end-year--0', 'number', PROD_OWNER_PROFILE, undefined),
    { value: '2028' },
  );
  // Tower's single textarea asks for both ends; without a start there is no partial answer, and
  // it must never fall through to the school NAME the way it did in prod.
  refuses('start month/year of university and end month/year of university', 'textarea');
  assert.deepEqual(
    resolveKnownAnswer(
      'start month/year of university and end month/year of university',
      'textarea',
      { ...PROD_OWNER_PROFILE, education_start_date: 'August 2024' },
      undefined,
    ),
    { value: 'August 2024 to May 2028' },
  );
});

test('a label merely containing a profile keyword is not grounds to answer it with that value', () => {
  // The core discipline. Each label below contains a word the profile has a value for, and each
  // one is asking for something else entirely.
  refuses('if you applied using your personal email address, please provide your university email address'); // IMC: got the university NAME
  refuses('when did you graduate from high school?'); // IMC: got the university NAME
  refuses(
    'are you or have you been entrusted with a position or function in any government, international organization '
    + '(such as the un or world bank), or state-controlled or state-owned bank, brokerage firm, or other enterprise?',
  ); // Tower: got "Dubai", off the word "state" in "state-owned"
  refuses("if you selected 'other', please list your university"); // Akuna: a conditional, answered unconditionally
  assert.equal(classifyField('please provide your university email address'), null);
  assert.equal(classifyField('what is your university campus address?'), null);
  assert.equal(classifyField('may we contact you by phone?'), null);
  assert.equal(classifyField('which state-owned enterprises have you worked for?'), null);

  // The bare field-name labels the fallback exists for still classify.
  assert.equal(classifyField('School'), 'school');
  assert.equal(classifyField('Current university'), 'school');
  assert.equal(classifyField('Phone number'), 'phone');
  assert.equal(classifyField('State / Province'), 'address_state');
  assert.equal(classifyField('City'), 'address_city');
  assert.equal(classifyField('Please re-confirm the university you currently attend'), 'school');
});

/* The gate above was written as "and the label must not contain a question mark", and a question
 * mark is not evidence that a label is naming something other than the field. It is evidence the
 * portal wrote the field name as a sentence, which most of them do. Measured on the tree that
 * shipped it, every one of these returned null and left a required field EMPTY:
 *
 *   What is your phone number?              What university do you attend?
 *   What state do you live in?              Which city do you live in?
 *   In which state do you currently reside? What is your current city of residence?
 *
 * Phone is the one that hurts most. It is required on nearly every application form, and the
 * `type === 'tel'` escape at the top of classifyField cannot save it on the managed path, because
 * the runner reports every inputType as `text`. Asserted here with no type argument for exactly
 * that reason. */
test('a field name written as a question is still a field name', () => {
  assert.equal(classifyField('what is your phone number?'), 'phone');
  assert.equal(classifyField('what university do you attend?'), 'school');
  assert.equal(classifyField('what state do you live in?'), 'address_state');
  assert.equal(classifyField('which city do you live in?'), 'address_city');
  assert.equal(classifyField('in which state do you currently reside?'), 'address_state');
  assert.equal(classifyField('what is your current city of residence?'), 'address_city');
});

/* What the question mark was actually earning its keep on, and the reason it cannot simply be
 * deleted: a POLAR question mentions the noun to ask something ABOUT it, and the stored value is
 * not an answer to it. "May we contact you by phone?" wants a yes; the phone number is not one.
 *
 * The distinction is the opening word, not the punctuation. An auxiliary opens a yes/no question;
 * what, which and where open a request for the value itself. */
test('a yes/no question about a field is not a request for that field', () => {
  assert.equal(classifyField('may we contact you by phone?'), null);
  assert.equal(classifyField('do you have a mobile phone?'), null);
  assert.equal(classifyField('do you live in new york or california?'), null);
  assert.equal(classifyField('are you based in a state that taxes remote work?'), null);
  assert.equal(classifyField('is your school on our partner list?'), null);
  // isPolarQuestion is the one rule, and it needs BOTH halves: an auxiliary at the front and a
  // question mark. Either alone would refuse a field name.
  assert.equal(isPolarQuestion('may we contact you by phone?'), true);
  assert.equal(isPolarQuestion('what is your phone number?'), false);
  assert.equal(isPolarQuestion('may graduation'), false);
  assert.equal(isPolarQuestion('Phone number'), false);
});

/* And the two defects the question-mark gate was added for, verified to be refused without it.
 * Neither one needs it: the first has no question mark at all and is caught by the qualifier list,
 * the second is far past the word budget. Both are asserted in the test above this block as well;
 * repeated here so that deleting the gate a second time cannot pass unnoticed. */
test('the two labels the question-mark gate was added for are refused without it', () => {
  // Six words, no question mark, refused on `email` and `address` in the qualifier list.
  assert.equal(classifyField('please provide your university email address'), null);
  // Seventeen words, refused by the word count, with `owned` in the qualifier list as well.
  const politicallyExposed =
    'are you or an immediate family member a politically exposed person, or connected to a '
    + 'state-owned bank or government body?';
  assert.equal(classifyField(politicallyExposed), null);
  // And refused a second time, before classification is ever consulted, by resolveKnownAnswer.
  assert.deepEqual(
    resolveKnownAnswer(politicallyExposed, 'text', PROD_OWNER_PROFILE, undefined),
    { skipReason: `politically-exposed-person declaration left for you: "${politicallyExposed.slice(0, 60)}"` },
  );
});

test('stored education facts describe the CURRENT programme only (Akuna, Five Rings)', () => {
  // Akuna got "May 2028" - her bachelor's date - as a potential MASTER'S graduation date.
  refuses(
    'if you are an undergraduate considering a master’s degree following graduation, '
    + 'when is your potential master’s graduation date?',
  );
  // Five Rings got her current bachelor's as the degree she "plans to pursue", immediately after
  // she had answered that she was not planning further study.
  refuses('if so, please specify the type of degree you plan to pursue.');
  // The current programme still answers normally.
  assert.deepEqual(
    resolveKnownAnswer('what degree are you currently pursuing?', 'text', PROD_OWNER_PROFILE, undefined),
    { value: 'Bachelor of Science in Computer Science' },
  );
  assert.deepEqual(
    resolveKnownAnswer('when is your anticipated graduation date - please select a graduation date range', 'text', PROD_OWNER_PROFILE, undefined),
    { value: 'May 2028' },
  );
});

test('a high school diploma question that asks for a month and year is not answered "Yes" (Akuna)', () => {
  refuses(
    'to be considered for this role, you must have earned a high school diploma (or an equivalent degree). '
    + 'please confirm the month and year that most accurately reflects your high school (or equivalent) graduation',
    'select',
  );
  /* CHANGED 2026-08-08 by feat/onboarding-application-facts, which supersedes this rule rather than
     contradicting it. The refusal above was right because "the profile does not hold" that date;
     the profile holds it now, so the same label ANSWERS with it. And the plain confirmation variant
     is no longer a routine "Yes" either: confirming that a qualification was earned is a claim
     about the student's record, so it needs the record. */
  const plain = 'To be considered for this role, you must have earned a high school diploma (or an equivalent degree). Please confirm the statement below.';
  refuses(plain, 'select');
  assert.deepEqual(
    resolveKnownAnswer(plain, 'select', { ...PROD_OWNER_PROFILE, high_school_grad_date: 'June 2024' }, undefined),
    { value: 'Yes' },
  );
  assert.deepEqual(
    resolveKnownAnswer(
      'to be considered for this role, you must have earned a high school diploma (or an equivalent degree). '
      + 'please confirm the month and year that most accurately reflects your high school (or equivalent) graduation',
      'select',
      { ...PROD_OWNER_PROFILE, high_school_grad_date: 'June 2024' },
      undefined,
    ),
    { value: 'June 2024' },
  );
});

test('politically-exposed-person declarations are left for the applicant (Tower)', () => {
  refuses(
    'are you or have you been entrusted with a position or function in any government, international organization '
    + '(such as the un or world bank), or state-controlled or state-owned bank, brokerage firm, or other enterprise?',
  );
  refuses(
    'are you an immediate family member of someone holding such a position? an immediate family member is a parent, '
    + 'sibling, spouse or domestic partner, child, or in-law.',
  );
  assert.match(
    skipReasonOf(resolveKnownAnswer(
      'are you an immediate family member of someone holding such a position? an immediate family member is a parent, '
      + 'sibling, spouse or domestic partner, child, or in-law.',
      'radio',
      PROD_OWNER_PROFILE,
      undefined,
    )) ?? '',
    /politically-exposed-person/i,
  );
});

test('"authorized to work for all employers" is not answered Yes while sponsorship is needed (Tower)', () => {
  refuses('are you currently authorized to work for all employers in the united states on a full-time basis ?');
  // The unqualified question is still answered from the stored boolean.
  assert.deepEqual(
    resolveKnownAnswer('are you legally eligible to work in the united states?', 'text', PROD_OWNER_PROFILE, undefined),
    { value: 'Yes' },
  );
  // And an applicant who needs no sponsorship can still claim the unrestricted form.
  assert.deepEqual(
    resolveKnownAnswer(
      'are you currently authorized to work for all employers in the united states on a full-time basis ?',
      'text',
      { ...PROD_OWNER_PROFILE, needs_sponsorship: false },
      undefined,
    ),
    { value: 'Yes' },
  );
});

/* R-095/R-096 required-ness.
 *
 * Every label below is the VERBATIM raw string discovery returns for the live Anduril Greenhouse
 * posting (job-boards.greenhouse.io/embed/job_app?for=andurilindustries&token=5148079007), captured
 * by running DISCOVER_QUESTIONS_SCRIPT against that page. The asterisk is the employer's own
 * required marker and it is the only required-ness signal the MANAGED provider reports, since it
 * runs its own port of the discovery script and sends back no required flag. If normalization ever
 * starts stripping the marker before these read it, or the raw shape changes, these break. */
const ANDURIL_REQUIRED_RAW_LABELS = [
  'Discipline* discipline--0',
  'What is your top location preference? * question_12114511007',
  'EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls. Your responses to the questions below will be used solely to determine your eligibility under U.S. law to receive information and materials subject to U.S. export controls.* question_12114512007',
  'How did you hear about Anduril?* question_12114515007',
];

const ANDURIL_OPTIONAL_RAW_LABELS = [
  'Gender gender',
  'Website Website question_12114508007',
  'Veteran Status veteran_status',
  'Disability Status disability_status',
];

test('the employer required marker is read off every raw Anduril label that carries one', () => {
  for (const label of ANDURIL_REQUIRED_RAW_LABELS) {
    assert.equal(labelMarksRequired(label), true, label.slice(0, 70));
  }
});

test('an optional Anduril field is not promoted to required, which would block a valid submission', () => {
  for (const label of ANDURIL_OPTIONAL_RAW_LABELS) {
    assert.equal(labelMarksRequired(label), false, label);
  }
});

test('the marker has to stand at a word boundary, so an asterisk inside a token is not a marker', () => {
  assert.equal(labelMarksRequired('Rate a*b as a product'), false);
  assert.equal(labelMarksRequired('*First Name'), true);
  assert.equal(labelMarksRequired('First Name *'), true);
});

test('a form legend explaining the marker does not mark that field required', () => {
  assert.equal(labelMarksRequired('* indicates a required field'), false);
  assert.equal(labelMarksRequired('* denotes required'), false);
});

test('discoveredFieldIsRequired trusts the provider flag and falls back to the marker', () => {
  // The direct-Playwright path reports the flag: believed even when the label carries no marker,
  // which is the real Anduril phone field (aria-required="true", asterisk hidden behind a legend).
  assert.equal(discoveredFieldIsRequired({ label: 'Phone', required: true }), true);
  // The managed path reports no flag at all. The marker is what keeps it honest until it does.
  assert.equal(discoveredFieldIsRequired({ label: 'Discipline* discipline--0' }), true);
  assert.equal(discoveredFieldIsRequired({ label: 'Gender gender' }), false);
  assert.equal(discoveredFieldIsRequired({ label: 'Gender gender', required: false }), false);
});

test('normalizeDiscoveredLabel strips the marker, which is why required-ness is read before it', () => {
  // Pins the reason discoveredFieldIsRequired must see the RAW label. If this ever stops being
  // true the fallback still works, but the comment explaining it would be a lie.
  assert.equal(normalizeDiscoveredLabel('Discipline* discipline--0'), 'Discipline');
  assert.equal(labelMarksRequired(normalizeDiscoveredLabel('Discipline* discipline--0')), false);
});

test('name and email are never manufactured as the applicant\'s work, since the packet fills them', () => {
  // Verbatim raw labels from the live Anduril form. All three carry the required marker, so without
  // this guard R-096 would have made every application on every portal stall on its own name field.
  for (const label of ['First Name* First Name first_name', 'Last Name* Last Name last_name', 'Email* Email email']) {
    assert.equal(labelMarksRequired(label), true, label);
    assert.equal(isCoreIdentityField(label), true, label);
  }
});

test('a legal or preferred name is a real question, not the name the packet already carries', () => {
  assert.equal(isCoreIdentityField('What is your legal first name?'), false);
  assert.equal(isCoreIdentityField('Preferred First Name'), false);
  assert.equal(isCoreIdentityField('Maiden name'), false);
  // ...and nothing else gets swept up by the name/email words.
  assert.equal(isCoreIdentityField('Discipline'), false);
  assert.equal(isCoreIdentityField('What is your top location preference?'), false);
  assert.equal(isCoreIdentityField('High School Name & Graduation Year'), false);
});

/* ─── the Anduril Greenhouse run of 2026-08-08, verbatim ─────────────────────────────────────
 *
 * Labels exactly as the managed discovery pass reported them (lowercased, with Greenhouse's own
 * handles concatenated on), and the blocker sentences the applicant was shown for each.
 */

const ANDURIL_IN_PERSON_LABEL =
  'are you willing to work in-person for 12 weeks during the internship? * question_12114510007';
const ANDURIL_EXPORT_CONTROL_LABEL =
  'export controls - this position requires access to information and technology that is subject to u.s. export controls. '
  + 'your responses to the questions below will be used solely to determine your eligibility under u.s. law to receive '
  + 'information and materials subject to u.s. export controls.* question_12114512007';
const ANDURIL_REFERRAL_LABEL = 'how did you hear about anduril?* question_12114515007';

const MEHEK: ApplicationProfileLike = {
  school: 'University of Southern California, Viterbi School of Engineering',
  degree: 'Bachelor of Science in Computer Science',
  major: 'Computer Science & Business Administration, Finance Emphasis',
  gpa: '3.89',
  gpa_scale: '4.0',
  grad_date: 'May 2028',
  grad_year: 2028,
  currently_enrolled: true,
  referral_source_default: 'Company website',
  citizenship: 'Indian',
  work_authorized: true,
  needs_sponsorship: true,
  address_city: 'Dubai',
  address_country: 'United Arab Emirates',
};

test('an in-person commitment is recognised, and is hers to make', () => {
  /* RENAMED 2026-08-09: was "...is the routine location question it has always been", and asserted
     Yes for MEHEK, whose address_city is Dubai and who was in none of these offices.

     The half of this test that was always right is kept intact and is the reason the labels below
     are still listed: '"Are you willing to work in-person for 12 weeks during the internship?" is
     required and is still empty'. With only office/onsite/hybrid in the vocabulary this fell all
     the way to the ESSAY drafter, so a react-select with a Yes/No list was handed a paragraph and
     stayed empty, and the paragraph is where the "Los Angeles" grounding warning on that packet
     came from. Every label here must still be RECOGNISED and must never reach the drafter.

     What changed is what recognition produces. "Routine" was the error: these are commitments about
     where she will physically be, and the answer is now relayed from what she stored or refused. */
  const label = normalizeDiscoveredLabel(ANDURIL_IN_PERSON_LABEL);
  const labels = [
    label,
    'are you able to work onsite in one of our offices, five days a week?',
    'how many days per week can you work on-site in sf, and from what date?',
    'do you currently live in, or plan to relocate to, the specified location to meet this in-office requirement?',
  ];
  for (const other of labels) {
    const unasked = resolveKnownAnswer(other, 'text', MEHEK, undefined);
    // Recognised: never null, so it can never fall through to classifyField or to the drafter.
    assert.ok(unasked && 'skipReason' in unasked, other);
    assert.equal(isOpenEndedQuestion(other) && !('skipReason' in unasked), false, other);
  }
  // The legacy broad fields still lack exact cadence and posting scope, so they cannot unlock any
  // of these variants, including the changed five-day and dated policy shapes.
  const committed = { ...MEHEK, onsite_commitment: 'anywhere' as const, relocation_willingness: 'yes' as const };
  for (const other of labels) {
    const held = resolveKnownAnswer(other, 'text', committed, undefined);
    assert.ok(held && 'skipReason' in held, other);
  }
});

test('an export-control eligibility declaration is refused by name, never inferred', () => {
  // '"EXPORT CONTROLS - This position requires access to information and technology that is subject
  // to U.S. export controls. Y" is required and is still empty'. Nothing recognised it, so it was
  // silently skipped and the applicant was never told it was waiting for her.
  const label = normalizeDiscoveredLabel(ANDURIL_EXPORT_CONTROL_LABEL);
  const answer = resolveKnownAnswer(label, 'text', MEHEK, undefined);
  assert.ok(answer && 'skipReason' in answer);
  assert.match(answer.skipReason, /^export-control declaration left for you: /);

  // The three fields that look like they answer it are the three that must not. A U.S.-person
  // determination is a legal self-declaration; citizenship, work authorization and sponsorship each
  // describe something else, and a wrong answer here is a false statement in her name.
  for (const profile of [
    { citizenship: 'American', work_authorized: true, needs_sponsorship: false },
    { citizenship: 'Indian', work_authorized: false, needs_sponsorship: true },
    {},
  ] as ApplicationProfileLike[]) {
    const result = resolveKnownAnswer(label, 'text', profile, 'Anduril Industries, Costa Mesa, CA');
    assert.ok(result && 'skipReason' in result, JSON.stringify(profile));
  }
});

test('the export-control refusal leaves the sanctions checklist alone', () => {
  // Databricks' "select all that apply" list mentions export controls and is a different question:
  // its true answer, "None of the above", is one the applicant stores and Litos already ticks.
  assert.equal(
    resolveKnownAnswer(
      'Please confirm whether any of the below applies to you. Select all that apply. Note: This information will only be '
      + 'used to ensure compliance with U.S. sanctions and export controls.',
      'checkbox',
      MEHEK,
      undefined,
    ),
    null,
  );
});

test('the referral question is answered even when its label names the employer', () => {
  // '"How did you hear about Anduril?" is required and is still empty', with
  // application_profile.referral_source_default = "Company website" in the same row.
  for (const raw of [
    ANDURIL_REFERRAL_LABEL,
    'how did you hear about this internship?* question_1',
    'how did you hear about this job?* question_2',
  ]) {
    assert.deepEqual(
      resolveKnownAnswer(normalizeDiscoveredLabel(raw), 'text', MEHEK, undefined),
      { value: 'Company website' },
      raw,
    );
  }
});

/* ---------------------------------------------------------------------------------------------
 * THE MEASUREMENT, TURNED INTO A TEST.
 *
 * Every distinct question label Litos has stored - 1924 stored questions across generated_resumes
 * spec._review.questions, posting_questions and saved_application_answers, 495 distinct label/type
 * pairs - was replayed through resolveKnownAnswer against an EMPTY profile on 2026-08-09. An empty
 * profile has no stored fact behind any answer, so a `{ value }` from it is by definition an answer
 * no column supports: a constant, or something lifted out of the job description.
 *
 * 101 labels came back answered. Fifty of them are below, with the number of times each was stored.
 * The other fifty-one are EEO self-identification blocks answered "Decline to self-identify", which
 * is the one approved constant in this file and is asserted separately underneath.
 *
 * Reproduce with: npx tsx scripts/_sweep-untraceable.mts
 * --------------------------------------------------------------------------------------------- */
const UNTRACEABLY_ANSWERED_PRODUCTION_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['how did you hear about this job?', '25x'],
  ['how did you hear about this opportunity?', '10x'],
  ['are you able to work in our austin office 3–5 days a week?', '9x'],
  ['how did you hear about this internship?', '9x'],
  ['when are you able to join astranis as an intern? (12 week minimum)', '9x'],
  ['at astranis, we value in-person collaboration and a strong work ethic. are you comfortable with working onsite at our san francisco hq 5 days a week and commit to 55 hours per week?', '9x'],
  ['how did you hear about astranis', '9x'],
  ['how did you hear about us?', '7x'],
  ['ai policy for interviewers', '7x'],
  ['are you available to work from our office in san francisco?', '6x'],
  ['what is your office location preference? (note: the software engineer internship is only available in new york and austin, not chicago).', '5x'],
  ['how did you first hear about this role?', '5x'],
  ['where have you learned about samsara? select all that apply.* []', '5x'],
  ['how did you hear about this program?', '4x'],
  ['1st choice: area of interest in software engineering', '4x'],
  ['2nd choice (optional): area of interest in software engineering', '4x'],
  ['are you able to work onsite in one of our offices, five days a week?', '3x'],
  ['are you currently bound by any agreements with a current or former employer that may restrict your ability to work for scale ai or perform the duties of the position for which you are applying? this includes, but is not limited to, non-compete agreements, non-solicitation agreements, confidentiality or non-disclosure agreements, or any other contractual obligations that could limit your employment activities.', '3x'],
  ['this position is hybrid and requires 4 days a week in office, including thursdays in our mountain view, ca headquarters and the remaining 3 days in either mountain view or our san francisco, ca office. are you able to meet this requirement?', '3x'],
  ['how many days per week can you work on-site in sf, and from what date?', '3x'],
  ['we are unable to provide relocation assistance. will you be located in the seattle area and have the ability to come into our bellevue office several days a week during the time of the internship?', '3x'],
  ['if this job post is available in multiple cities, what is your preferred work location?', '3x'],
  ['please rank your location preference in order of most to least preferred: austin, chicago, greenwich, houston, new york city. if you are not open to a location, do not rank it. * please rank your location preference in order of most to least preferred: austin, chicago, greenwich, houston, new york city. if you are not open to a location, do not rank it.', '3x'],
  ['please select your current state of residence. select “not in the us” if you reside outside the united states. this information helps us understand our talent pool and ensures we provide accurate resources throughout the hiring process.', '2x'],
  ['this role will be in-office on a hybrid schedule, can you commit to being in-office three days per week at the location where this position is posted?', '2x'],
  ['do you currently reside in san francisco?', '2x'],
  ['how did you hear about optiver?', '2x'],
  ['are you willing to work four days per week in our san francisco office?', '2x'],
  ['how did you hear about anduril?', '2x'],
  ['what is your preferred work location?', '2x'],
  ['Location Preference', '1x'],
  ['how did you hear about this job? how did you hear about this job? question_66274351', '1x'],
  ['this role is required to be based near our new york city, ny office. are you open to relocating if you\'re not currently based there?* question_66274357', '1x'],
  ['are you currently residing in the greater austin area or have confirmed plans to be in austin for the duration of this internship?', '1x'],
  ['how did you hear about hrt?', '1x'],
  ['are you available to work from our office in san francisco?* question_19366889004', '1x'],
  ['how did you hear about this opportunity?* question_31572824003', '1x'],
  ['how did you hear about old mission? * []', '1x'],
  ['how did you hear about beacon?', '1x'],
  ['do you currently live in, or plan to relocate to, the specified location to meet this in-office requirement?', '1x'],
  ['this role requires in-office work three days per week (mon, wed, thurs). do you acknowledge and agree to this requirement?', '1x'],
  ['please choose the single location that you\'re the most interested in, and we will discuss more with you as you move through the process.', '1x'],
  ['we will only consider you for one role/location at a time. therefore, if you are interested in multiple roles, please submit an application for your first preference only.', '1x'],
  ['are you able and willing to work out of the san fransisco office?', '1x'],
  ['how did you first hear about five rings?* []', '1x'],
  ['how did you hear about dv trading?', '1x'],
  ['are you willing to work onsite at our chicago office 5 days a week?', '1x'],
  ['are you willing to work in-person for 12 weeks during the internship?', '1x'],
  ['what is your top location preference?', '1x'],
  ['how did you first hear about five rings?', '1x'],
];

test('no production question is answered from a profile with nothing stored', () => {
  /* THE GENERAL FORM OF THE FIX, and the thing that would have caught onsite_commitment.
   *
   * selfDeclaration.ts was already the general predicate for this class, and onsite_commitment
   * still slipped past it, for two reasons worth naming here so the next one does not:
   *
   *   1. No office, onsite or location pattern was on its list at all. The list was built from the
   *      labels measured on the 25-packet run plus the named defects, and the comment above
   *      LOCATION_COMMITMENT_VOCAB in questionDiscovery.ts called this question "routine".
   *   2. Structurally, isSelfDeclarationQuestion only ever guards the DRAFTER. In the submission
   *      runner it is consulted after resolveKnownAnswer, as the last door before the model; a
   *      `{ value }` from resolveKnownAnswer short-circuits it and is never seen. So a predicate
   *      that is a superset of the labels resolveKnownAnswer REFUSES has no authority whatsoever
   *      over the labels resolveKnownAnswer ANSWERS, which is where all three constants lived.
   *
   * This test has authority over both, because it asks the only question that matters: with nothing
   * on file, does a machine still produce an answer? A new constant anywhere in resolveKnownAnswer
   * fails here without anybody having to remember to add a pattern to a list.
   */
  const jd = 'Redwood Materials\nSan Francisco, CA\nSummer 2026 internship, full-stack engineering.';
  const answered: string[] = [];
  for (const [label, seen] of UNTRACEABLY_ANSWERED_PRODUCTION_LABELS) {
    for (const jdText of [undefined, jd]) {
      const resolved = resolveKnownAnswer(label, 'text', {}, jdText);
      if (resolved && 'value' in resolved) {
        answered.push(`${seen} ${label.slice(0, 70)} -> ${resolved.value}`);
      }
    }
  }
  assert.deepEqual(answered, []);
});

test('the only constant an empty profile may produce is the EEO decline', () => {
  /* R-018, and it is not an exception to the rule so much as the rule reaching its floor.
   * "Decline to self-identify" is a REFUSAL TO STATE, not a statement: it is the option the
   * employer's own form offers for exactly this, and choosing it claims nothing about her race,
   * gender, veteran status or disability. Every other constant in this file made a claim. */
  for (const label of [
    'How would you describe your gender identity?',
    'Are you Hispanic/Latino?',
    'Do you identify as transgender?',
    'Are you a veteran or active member of the United States Armed Forces?',
  ]) {
    assert.deepEqual(resolveKnownAnswer(label, 'select', {}, undefined), { value: 'Decline to self-identify' });
  }
  // And a stored preference still wins over the decline, which is the half that makes it a relay.
  assert.deepEqual(
    resolveKnownAnswer('How would you describe your gender identity?', 'select', { eeo_prefs: { gender: 'Female' } }, undefined),
    { value: 'Female' },
  );
});

test('the season a posting is for is read from the posting, and her calendar is not', () => {
  /* The one JD-derived answer that stays. "Please confirm the season you are applying for" asks
   * which posting she applied to, and the posting is the authority on that - it is a fact about the
   * job, not a claim about her. Its neighbour, "when are you able to join Astranis as an intern?",
   * used to be answered from the same JD season, and that one IS a claim about her: it is now
   * refused unless availability_date is stored. The pair is the whole distinction. */
  assert.deepEqual(
    resolveKnownAnswer('Please confirm the season you are applying for.', 'select', {}, 'Backend Intern (Fall 2026)'),
    { value: 'Fall 2026' },
  );
  const join = resolveKnownAnswer('When are you able to join us as an intern?', 'text', {}, 'Backend Intern (Fall 2026)');
  assert.ok(join && 'skipReason' in join);
});

test('legacy availability facts never authorize a new date, season, duration, or cadence commitment', () => {
  const legacy = {
    availability_date: 'June 1, 2026',
    availability_term: 'Available full-time for 12 weeks between June and August 2026',
  };
  for (const label of [
    'When can you start?',
    'Earliest start date',
    'Length or term of availability',
    'Are you available full-time for Summer 2027?',
    'Can you commit to 40 hours per week for 12 weeks from June through August 2027?',
  ]) {
    const resolved = resolveKnownAnswer(label, 'select', legacy, 'Summer 2027 internship');
    assert.ok(resolved && 'skipReason' in resolved, label);
  }
  assert.deepEqual(
    resolveKnownAnswer('Please confirm the season you are applying for.', 'select', legacy, 'Summer 2027 internship'),
    { value: 'Summer 2027' },
  );
});

test('a missing fact is left blank AND raised, never filled', () => {
  /* THE ABSOLUTE RULE, pinned end to end rather than resolver-by-resolver. For each label, with
   * nothing stored: no value comes back, and what does come back carries a sentence naming the
   * question, so the human is told rather than left to find an empty required field after the run.
   *
   * The first entry is the exact Redwood Materials label from packet
   * 8d12aea8-8476-4f7a-860b-fa6393842df9, which was ready to send answered "Yes". */
  for (const label of [
    'Are you available to work from our office in San Francisco?',
    'AI Policy for Interviewers',
    'Are you currently bound by any agreements with a current or former employer that may restrict your ability to work for Scale AI?',
    'How did you hear about this job?',
    '1st choice: Area of interest in Software Engineering',
    'What is your top location preference?',
    'Do you currently reside in San Francisco?',
  ]) {
    const resolved = resolveKnownAnswer(label, 'text', {}, undefined);
    assert.ok(resolved, `must be recognised, not dropped: ${label}`);
    assert.ok('skipReason' in resolved, `must not be answered: ${label}`);
    assert.ok(resolved.skipReason.trim().length > 20, `must explain itself: ${label}`);
  }
});
