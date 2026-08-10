import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  attentionCategoriesForReasons,
  applicationContextForQuestionResolution,
  attentionBlockersForManagedResult,
  atsApiSubmissionEnabled,
  describeDiscoveryFailure,
  discoverAndResolveQuestions,
  discoveryHonestyReasons,
  isProviderSessionFailureMessage,
  mergeDiscoveredPortalQuestions,
  managedExtensionHandoffUrl,
  packetUsesControlledResumeFixture,
  preparationEvidenceBlockers,
  reconcileManagedProviderBlockers,
  readMostRecentRole,
  resumeBytesForPacket,
  sanitizeEeoPrefs,
  shouldUseLocalControlledBrowser,
  submissionFailureOutcome,
  submissionGraduationDateParts,
  unansweredRequiredBlockerLabels,
  type ResumeRow,
} from './submissionRunner';
import { savedAnswerKey } from '../lib/answerReuse';
import {
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from '../lib/questionDiscovery';
import { workEligibilityFromSponsorshipAnswer } from '../lib/applicationProfileLike';
import type { ApplicationReviewState } from '../lib/applicationReview';
import { describeRequiredBlocker } from '../lib/fieldLabel';
import { detectPortal } from '../lib/portalSubmission';
import {
  CONTROLLED_PORTAL_BINDING_PARAM,
  controlledPortalBinding,
} from '../lib/controlledTestPortal';

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

test('an action-budget stop outranks the uncertainty the claim would otherwise imply', () => {
  /* buildManagedPortalActions throws ManagedActionBudgetError while ASSEMBLING the list, before
     runManagedBrowser is called, so nothing reached the employer. But the claim is taken at the top
     of the run, so uncertainAfterClaim is true on this path exactly as it is on every other one.
     Without a branch that outranks it, this stop inherits "the submission was attempted, check the
     portal or your email" - a receipt that cannot exist - AND lands at needs_attention-after-claim,
     which submitRequestDisposition refuses to re-run. The application would be permanently stuck on
     a send that provably never happened.

     Asserted behaviourally, because the file this guards says the branches here had no behavioural
     coverage at all and a review pass found the suite still green after deleting each one. */
  const blocker = 'Litos did not press submit: the greenhouse application needs more than 120 safe '
    + 'browser actions to preserve a fill attempt for each of its 121 reviewed questions.';
  const outcome = submissionFailureOutcome({
    captchaStop: null,
    noSubmitControl: false,
    actionBudgetStop: blocker,
    uncertainAfterClaim: true,
    externalGate: false,
    providerSessionFailure: false,
    currentAttentionReason: undefined,
  });

  assert.equal(outcome.status, 'needs_attention');
  // The error's own sentence survives, so the reason names the portal and the count.
  assert.match(outcome.attentionReason, /needs more than 120 safe browser actions/);
  assert.match(outcome.attentionReason, /Nothing was sent/);
  // And the sentence that sends her hunting for a confirmation is NOT the one she gets.
  assert.doesNotMatch(outcome.attentionReason, /could not verify the employer confirmation/);
});

test('without a budget stop the same inputs still report the uncertainty', () => {
  // The other half of the precedence: this test would pass on a build where the new branch swallowed
  // every failure, so the case it outranks has to still work.
  const outcome = submissionFailureOutcome({
    captchaStop: null,
    noSubmitControl: false,
    actionBudgetStop: null,
    uncertainAfterClaim: true,
    externalGate: false,
    providerSessionFailure: false,
    currentAttentionReason: undefined,
  });
  assert.equal(outcome.status, 'needs_attention');
  assert.match(outcome.attentionReason, /could not verify the employer confirmation/);
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
        company: 'Acme',
        location: 'Mountain View, CA',
        locations: ['San Francisco, CA', 'New York, NY'],
      },
    } as never,
    {
      jd_text: 'Build data infrastructure.',
    } as never,
  );
  assert.match(context, /Build data infrastructure/);
  assert.match(context, /\[LITOS FROZEN JOB EMPLOYER\] Acme/);
  assert.match(context, /Mountain View, CA/);
  assert.match(context, /San Francisco, CA/);
});

test('mixed-country context keeps relocation targets separate from US-only onsite evidence', () => {
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
  assert.match(context, /\[LITOS FROZEN JOB RELOCATION LOCATION\] Mountain View, CA/);
  assert.match(context, /\[LITOS FROZEN JOB RELOCATION LOCATION\] Toronto, Canada/);
  assert.doesNotMatch(context, /\[LITOS FROZEN JOB LOCATION\]/);
});

test('real packet context binds sibling targets and refuses flattened tails', () => {
  const review = {
    role: 'Software Engineer',
    jd_text: 'Build data infrastructure.',
  } as ApplicationReviewState;
  const context = applicationContextForQuestionResolution(
    {
      job_context: {
        company: 'Acme',
        locations: ['Boston, MA', 'London, UK', 'Paris, France', 'Toronto, Canada'],
      },
    } as ResumeRow,
    review,
  );
  const profile: ApplicationProfileLike = {
    prior_application_employers: ['Acme'],
    referral_source_default: 'LinkedIn',
    relocation_willingness: 'yes',
  };
  for (const [label, expected] of [
    ['Have you applied to Acme?', 'Yes'],
    ['How did you hear about Acme?', 'LinkedIn'],
    ['Do you agree to relocate to Boston?', 'Yes'],
    ['Are you willing to relocate to London?', 'Yes'],
    ['Would you relocate to Paris?', 'Yes'],
    ['Would you consider relocating to Toronto?', 'Yes'],
  ] as const) {
    assert.deepEqual(resolveKnownAnswer(label, 'text', profile, context), { value: expected }, label);
    assert.deepEqual(
      refreshKnownQuestionAnswers([{ question: label, answer: 'stale' }], profile, context),
      [{ question: label, answer: expected }],
      label,
    );
  }

  for (const label of [
    'Have you applied to Acme why did you leave',
    'Have you applied to Acme please explain why',
    'Did you ever apply for Acme describe the outcome',
    'How did you hear about Acme why do you want to work here',
    'Where did you learn about Acme who referred you',
    'What is your referral source for Acme explain your answer',
    'Would you relocate for Acme travel 50 percent',
    'Are you comfortable relocating for Acme work weekends',
    'Do you agree to relocate to Boston start immediately',
  ]) {
    const held = resolveKnownAnswer(label, 'text', profile, context);
    assert.ok(held && 'skipReason' in held, label);
    assert.deepEqual(
      refreshKnownQuestionAnswers([{ question: label, answer: 'Yes' }], profile, context),
      [{ question: label, answer: '' }],
      label,
    );
  }
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

test('SmartRecruiters network restriction becomes an attended Chrome handoff, not CAPTCHA', () => {
  const blockers = attentionBlockersForManagedResult(
    'smartrecruiters',
    ['CAPTCHA requires your attention'],
    {
      title: 'Access is temporarily restricted',
      text: '',
      filledFields: [],
    },
    {
      fullName: 'Mehek Mandal',
      email: 'mehek@example.com',
      resume: Buffer.from('exact generated pdf'),
      resumeName: 'Mehek_Mandal_Resume.pdf',
      questions: [],
    },
  );

  assert.equal(blockers.includes('CAPTCHA requires your attention'), false);
  assert.deepEqual(blockers, [
    'The application site temporarily blocked Litos\'s secure browser because of its network activity. This is not a CAPTCHA, and nothing was sent. Open this application in Chrome and Litos will refill the exact saved packet there.',
  ]);
});

test('network reputation handoff is cross-ATS but never swallows real security gates', () => {
  const packet = {
    fullName: 'Mehek Mandal',
    email: 'mehek@example.com',
    resume: Buffer.from('exact generated pdf'),
    resumeName: 'Mehek_Mandal_Resume.pdf',
    questions: [],
  };
  const reputationBlock = attentionBlockersForManagedResult(
    'greenhouse',
    ['CAPTCHA requires your attention'],
    { text: 'Access denied. Your request was blocked because automated traffic from this IP address was flagged.' },
    packet,
  );
  assert.equal(reputationBlock.some((blocker) => /captcha requires/i.test(blocker)), false);
  assert.match(reputationBlock[0], /Open this application in Chrome/);

  assert.deepEqual(attentionBlockersForManagedResult(
    'greenhouse',
    ['CAPTCHA requires your attention'],
    { text: 'Access denied. Prove you are human by completing the security check.' },
    packet,
  ), ['CAPTCHA requires your attention']);
  assert.deepEqual(attentionBlockersForManagedResult(
    'greenhouse',
    ['CAPTCHA requires your attention'],
    { text: 'Sign in. Access denied until your account login is complete.' },
    packet,
  ), ['CAPTCHA requires your attention']);

  for (const securityText of [
    'Access denied after unusual activity. Complete the CAPTCHA to continue.',
    'Request blocked after unusual activity. Verify you are not a robot.',
    'Access denied after unusual activity. Complete the challenge.',
    'Request blocked after unusual activity. Authenticate to continue.',
    'Access denied after unusual activity. Authentication is required.',
    'Access denied. Your IP address was flagged. Verify your identity to continue.',
    'Request blocked because of automated traffic from this IP. Enter your password to continue.',
    'Access is temporarily restricted. Sign-on verification is required.',
    'Access denied after unusual activity. Please verify you are human.',
    'Request blocked after unusual activity. Complete the human verification.',
    'Access denied because automated traffic from this IP was flagged. Confirm you are a person to continue.',
    'Request blocked because automated traffic from this IP was flagged. Complete the security check.',
    'Access denied because automated traffic from this IP was flagged. Prove you are a real person.',
    'Request blocked because automated traffic from this IP was flagged. Tick the checkbox to continue.',
    'Access denied because automated traffic from this IP was flagged. Press and hold to continue.',
    'Request blocked because automated traffic from this IP was flagged. Create an account to continue.',
    'Access denied because automated traffic from this IP was flagged. Register to continue.',
    'Request blocked because automated traffic from this IP was flagged. Continue with Google.',
    'Access denied because automated traffic from this IP was flagged. Confirm you are not a bot.',
    'Request blocked because automated traffic from this IP was flagged. Complete the bot check.',
    'Access denied because automated traffic from this IP was flagged. Confirm your identity.',
    'Request blocked because automated traffic from this IP was flagged. Complete the identity check.',
    'Access denied because automated traffic from this IP was flagged. Accept the terms and conditions to continue.',
    'Request blocked because automated traffic from this IP was flagged. Agree to the privacy policy to proceed.',
    'Access denied because automated traffic from this IP was flagged. Use a passkey to continue.',
  ]) {
    assert.deepEqual(attentionBlockersForManagedResult(
      'greenhouse',
      ['CAPTCHA requires your attention'],
      { text: securityText },
      packet,
    ), ['CAPTCHA requires your attention'], securityText);
  }

  for (const networkOnlyText of [
    'Access denied. Automated traffic from this IP address was flagged.',
    'Request blocked because of automated traffic from this network.',
  ]) {
    const blockers = attentionBlockersForManagedResult(
      'greenhouse',
      ['CAPTCHA requires your attention'],
      { text: networkOnlyText },
      packet,
    );
    assert.equal(blockers.some((blocker) => /captcha requires/i.test(blocker)), false, networkOnlyText);
    assert.match(blockers[0], /Open this application in Chrome/, networkOnlyText);
  }

  assert.deepEqual(attentionBlockersForManagedResult(
    'smartrecruiters',
    ['CAPTCHA requires your attention'],
    { text: 'Access is temporarily restricted for applicants who answered this question.', filledFields: [] },
    packet,
  ), ['CAPTCHA requires your attention']);
  assert.deepEqual(attentionBlockersForManagedResult(
    'smartrecruiters',
    ['CAPTCHA requires your attention'],
    { title: 'Access is temporarily restricted', text: 'Application form', filledFields: ['email'] },
    packet,
  ), ['CAPTCHA requires your attention']);
  assert.deepEqual(attentionBlockersForManagedResult(
    'smartrecruiters',
    ['CAPTCHA requires your attention'],
    { title: 'Access is temporarily restricted', text: '', filledFields: [], discovered: [{ label: 'Email' }] },
    packet,
  ), ['CAPTCHA requires your attention']);
});

test('managed SmartRecruiters attended handoff persists only an exact form URL observed by a blocked run', () => {
  const form = 'https://jobs.smartrecruiters.com/oneclick-ui/company/SeekaTechnology/publication/123e4567-e89b-12d3-a456-426614174000';
  const posting = 'https://jobs.smartrecruiters.com/SeekaTechnology/744000063648206-software-engineer-internship';
  assert.equal(managedExtensionHandoffUrl('smartrecruiters', form, null, true), form);
  assert.equal(managedExtensionHandoffUrl('smartrecruiters', posting, null, true), undefined);
  assert.equal(managedExtensionHandoffUrl('smartrecruiters', undefined, null, true), undefined);
  assert.equal(managedExtensionHandoffUrl('greenhouse', 'https://boards.greenhouse.io/acme/jobs/123', null, true), undefined);
  assert.equal(
    managedExtensionHandoffUrl(
      'greenhouse',
      'https://boards.greenhouse.io/acme/jobs/123',
      'network restriction',
      false,
    ),
    'https://boards.greenhouse.io/embed/job_app?for=acme&token=123',
  );

  const prepareManagedSource = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  assert.match(
    prepareManagedSource,
    /const networkAccessRestriction = managedNetworkAccessRestrictionReason\(portal, result\.text, result\.title, result\)/,
  );
  assert.match(
    prepareManagedSource,
    /extension_handoff_url: managedExtensionHandoffUrl\([\s\S]*?portal,[\s\S]*?result\.url,[\s\S]*?networkAccessRestriction,[\s\S]*?captchaAttention,[\s\S]*?\)/,
  );
  assert.doesNotMatch(
    prepareManagedSource,
    /extension_handoff_url:[^\n]*current\.portal_url/,
  );
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

test('only a signed controlled portal can select fixture resume bytes; Greenhouse still reads Blob', async () => {
  const previous = {
    enabled: process.env.LITOS_ENABLE_TEST_PORTAL,
    origin: process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN,
    secret: process.env.LITOS_TEST_PORTAL_BINDING_SECRET,
    nodeEnv: process.env.NODE_ENV,
  };
  try {
    process.env.LITOS_ENABLE_TEST_PORTAL = 'true';
    process.env.NODE_ENV = 'test';
    process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN = 'https://qa-tunnel.example.test';
    process.env.LITOS_TEST_PORTAL_BINDING_SECRET = '0123456789abcdef0123456789abcdef';
    const unsigned = 'https://qa-tunnel.example.test/qa/portal-submission?board=greenhouse&shape=security-code&case=packet';
    const signed = new URL(unsigned);
    signed.searchParams.set(
      CONTROLLED_PORTAL_BINDING_PARAM,
      controlledPortalBinding(unsigned, process.env.LITOS_TEST_PORTAL_BINDING_SECRET),
    );

    const controlledPortal = detectPortal(signed.toString());
    assert.equal(packetUsesControlledResumeFixture(controlledPortal), true);
    let resolverCalls = 0;
    let fetchCalls = 0;
    const controlledBytes = await resumeBytesForPacket('qa/application.pdf', true, {
      resolveObjectUrl: async () => {
        resolverCalls += 1;
        return 'https://blob.example.test/should-not-be-read';
      },
      fetchObject: async () => {
        fetchCalls += 1;
        return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
      },
    });
    assert.match(controlledBytes.toString('utf8'), /Litos controlled submission fixture/);
    assert.equal(resolverCalls, 0);
    assert.equal(fetchCalls, 0);

    const greenhousePortal = detectPortal('https://boards.greenhouse.io/acme/jobs/123');
    assert.equal(packetUsesControlledResumeFixture(greenhousePortal), false);
    const blobBytes = await resumeBytesForPacket('users/user-1/resume.pdf', false, {
      resolveObjectUrl: async (key) => {
        resolverCalls += 1;
        assert.equal(key, 'users/user-1/resume.pdf');
        return 'https://blob.example.test/resume.pdf';
      },
      fetchObject: async (url) => {
        fetchCalls += 1;
        assert.equal(url, 'https://blob.example.test/resume.pdf');
        return { ok: true, arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer };
      },
    });
    assert.equal(blobBytes.toString('utf8'), '%PDF');
    assert.equal(resolverCalls, 1);
    assert.equal(fetchCalls, 1);
  } finally {
    if (previous.enabled === undefined) delete process.env.LITOS_ENABLE_TEST_PORTAL;
    else process.env.LITOS_ENABLE_TEST_PORTAL = previous.enabled;
    if (previous.origin === undefined) delete process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN;
    else process.env.LITOS_TEST_PORTAL_PUBLIC_ORIGIN = previous.origin;
    if (previous.secret === undefined) delete process.env.LITOS_TEST_PORTAL_BINDING_SECRET;
    else process.env.LITOS_TEST_PORTAL_BINDING_SECRET = previous.secret;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
  }
});

test('managed prepare and final or security-code submit rebuild controlled packets with the exact portal predicate', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const prepareStart = source.indexOf('async function prepareManaged(');
  const prepareEnd = source.indexOf('\nasync function ', prepareStart + 10);
  assert.ok(prepareStart > 0 && prepareEnd > prepareStart);
  const prepareBody = source.slice(prepareStart, prepareEnd);
  assert.match(
    prepareBody,
    /omitCoverLetter\(await buildPacket\(row, packetUsesControlledResumeFixture\(portal\)\)\)/,
  );

  const submitStart = source.indexOf('async function submit(');
  assert.ok(submitStart > 0);
  const submitBody = source.slice(submitStart);
  const managedStart = submitBody.indexOf('if (isManagedStratusProvider())');
  const directStart = submitBody.indexOf("if (!claimedReview.browser_session_id)", managedStart);
  assert.ok(managedStart > 0 && directStart > managedStart);
  const managedBody = submitBody.slice(managedStart, directStart);
  assert.match(
    managedBody,
    /const builtPacket = await buildPacket\(row, packetUsesControlledResumeFixture\(portal\)\)/,
  );
  assert.match(
    managedBody,
    /claimedReview\.cover_letter_supported === true \? builtPacket : omitCoverLetter\(builtPacket\)/,
    'fixture selection must not change the reviewed cover-letter attachment decision',
  );

  const buildStart = source.indexOf('export async function buildPacket(');
  const buildEnd = source.indexOf('\nexport function readMostRecentRole', buildStart);
  const buildBody = source.slice(buildStart, buildEnd);
  const coverLetterBlock = buildBody.slice(buildBody.indexOf('let coverLetter:'));
  assert.doesNotMatch(coverLetterBlock, /controlledTest|packetUsesControlledResumeFixture/,
    'controlled resume bytes must not bypass or suppress normal cover-letter resolution');
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
        label: 'Will you now or in the future require sponsorship for employment visa status in the United States?',
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
      { question: 'Will you now or in the future require sponsorship for employment visa status in the United States?', answer: 'Yes' },
    ],
  );
});

test('portal country metadata reaches managed send resolution without borrowing another country', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'This internship is based in London.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };
  const fields = [{
    label: 'Are you authorized to work in the country where this role is located?',
    selector: 'select[name="work_authorized"]',
    inputType: 'select',
    maxLength: null,
  }];
  const applicationProfile: ApplicationProfileLike = {
    work_eligibility_by_country: [
      { country_code: 'US', authorized_now: true, needs_sponsorship_now: false, needs_sponsorship_future: false },
      { country_code: 'GB', authorized_now: false, needs_sponsorship_now: true, needs_sponsorship_future: true },
      { country_code: 'CA', authorized_now: false, needs_sponsorship_now: true, needs_sponsorship_future: true },
      { country_code: 'IN', authorized_now: false, needs_sponsorship_now: true, needs_sponsorship_future: true },
      { country_code: 'BR', authorized_now: false, needs_sponsorship_now: true, needs_sponsorship_future: true },
    ],
  };

  const british = await discoverAndResolveQuestions(
    fields,
    { user_id: 'user-1', job_context: { location: 'London', portal_country: 'GB' } } as ResumeRow,
    current,
    applicationProfile,
    true,
    'greenhouse',
  );
  assert.deepEqual(british.attentionReasons, []);
  assert.deepEqual(british.questions.map(({ question, answer }) => ({ question, answer })), [{
    question: fields[0].label,
    answer: 'No',
  }]);

  for (const [job_context, answer] of [
    [{ location: 'Paris, TX' }, 'Yes'],
    [{ location: 'London, ON' }, 'No'],
    [{ portal_country: 'US', location: 'Paris, TX' }, 'Yes'],
    [{ location: 'Remote, United States' }, 'Yes'],
    [{ location: 'United States - Remote' }, 'Yes'],
    [{ location: 'Canada - Remote' }, 'No'],
    [{ location: 'United Kingdom - Remote' }, 'No'],
    [{ portal_country: 'US', location: 'Springfield' }, 'Yes'],
    [{ portal_country: 'United States Locations', location: 'New York, NY' }, 'Yes'],
    [{ portal_country: 'India Locations', location: 'Mumbai' }, 'No'],
    [{ portal_country: 'Canada Offices', location: 'Toronto' }, 'No'],
    [{ portal_country: 'United Kingdom Office', location: 'London' }, 'No'],
    [{ portal_country: 'EMEA', location: 'London' }, 'No'],
    [{ portal_country: 'United States Recruiting' }, 'Yes'],
    [{ portal_country: 'EMEA | United Kingdom', location: 'London' }, 'No'],
    [{ portal_country: 'APAC / India', location: 'Mumbai' }, 'No'],
    [{ portal_country: 'LATAM; Brazil', location: 'Sao Paulo' }, 'No'],
  ] as const) {
    const resolved = await discoverAndResolveQuestions(
      fields,
      { user_id: 'user-1', job_context } as ResumeRow,
      current,
      applicationProfile,
      true,
      'greenhouse',
    );
    assert.deepEqual(resolved.attentionReasons, []);
    assert.equal(resolved.questions[0]?.answer, answer);
  }

  for (const job_context of [
    { locations: ['London', 'New York, NY'] },
    { location: 'London office supporting US customers' },
    { portal_country: 'GB', location: 'Paris, TX' },
    { portal_country: 'US', location: 'London, England' },
    { location: 'Paris, TX, France' },
    { location: 'London, UK, supporting US customers' },
    { location: 'Paris team aligned to Texas business hours' },
    { location: 'Sales territory, United States' },
    { location: 'Springfield, United States' },
    { portal_country: 'United States Locations', location: 'London' },
    { portal_country: 'India Locations', location: 'New York, NY' },
    { portal_country: 'Canada Offices', location: 'London' },
    { portal_country: 'United Kingdom Locations', location: 'New York, NY' },
    { portal_country: 'United States Locations', locations: ['London', 'New York, NY'] },
    { portal_country: 'EMEA', location: 'New York, NY' },
    { portal_country: 'APAC', location: 'San Francisco, CA' },
    { portal_country: 'LATAM', location: 'Boston' },
    { portal_country: 'EMEA' },
    { portal_country: 'United States Recruiting', location: 'London' },
    { portal_country: 'EMEA', location: 'Toronto' },
    { portal_country: 'APAC', location: 'London' },
    { portal_country: 'LATAM', location: 'Mumbai' },
    { portal_country: 'EMEA | Canada', location: 'Toronto' },
    { portal_country: 'APAC, EMEA', location: 'London' },
    { portal_country: 'United States / Canada', location: 'Toronto' },
    { portal_country: 'EMEA & US', location: 'London' },
    { portal_country: 'EMEA & APAC', location: 'London' },
    { portal_country: 'APAC & United States', location: 'Mumbai' },
    { portal_country: 'LATAM & USA', location: 'Sao Paulo' },
    { portal_country: 'EMEA + US', location: 'London' },
    { portal_country: 'EMEA - US', location: 'London' },
    { portal_country: 'EMEA (US)', location: 'London' },
    { portal_country: 'EMEA - United States', location: 'London' },
    { portal_country: 'APAC (United States)', location: 'Mumbai' },
    { portal_country: 'LATAM-US', location: 'Sao Paulo' },
    ...['|', ',', '/', ';', '\n', '•', ' and ', ' or ', '&', '+'].map((separator) => ({
      portal_country: `EMEA${separator}US`,
      location: 'London',
    })),
    ...[' - ', '-'].flatMap((separator) => ['EMEA', 'APAC', 'LATAM'].map((region) => ({
      portal_country: `${region}${separator}United States`,
      location: region === 'APAC' ? 'Mumbai' : region === 'LATAM' ? 'Sao Paulo' : 'London',
    }))),
    ...['EMEA', 'APAC', 'LATAM'].map((region) => ({
      portal_country: `${region} (United States)`,
      location: region === 'APAC' ? 'Mumbai' : region === 'LATAM' ? 'Sao Paulo' : 'London',
    })),
  ]) {
    const mixed = await discoverAndResolveQuestions(
      fields,
      { user_id: 'user-1', job_context } as ResumeRow,
      current,
      applicationProfile,
      true,
      'greenhouse',
    );
    assert.equal(mixed.questions[0]?.answer, undefined);
    assert.equal(mixed.attentionReasons.length, 1);
    assert.match(mixed.attentionReasons[0], /work-eligibility question left for you/i);
  }
});

test('select and radio discoveries relay a stored onsite commitment alongside stored academic facts', async () => {
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
    { user_id: 'user-1', job_context: { location: 'San Francisco, CA' } } as ResumeRow,
    current,
    // "Willing to work in person anywhere in the US" covers four days a week in any US office, so
    // the cadence in the label needs no column of its own.
    { currently_enrolled: true, grad_date: 'May 2028', grad_year: 2028, onsite_commitment: 'anywhere' },
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

  // The same two controls on an account that has never answered: the onsite one comes back as work
  // for her, by name, and the academic one is still resolved.
  const unasked = await discoverAndResolveQuestions(
    [
      { label: 'Are you able to work onsite 4 days a week?', selector: 'select[name="question_1"]', inputType: 'select', maxLength: null },
      { label: 'Are you currently enrolled in a degree program?', selector: 'input[name="question_2"][type="radio"]', inputType: 'radio', maxLength: null },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { currently_enrolled: true, grad_date: 'May 2028', grad_year: 2028 },
    true,
    'greenhouse',
  );
  assert.deepEqual(unasked.attentionReasons, [
    'where you will work from is yours to answer: "Are you able to work onsite 4 days a week?"',
  ]);
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

// ─── Which stage a prepare-time stall records ─────────────────────────────────
//
// SOURCE-LEVEL for the same reason as the test above: prepareManaged is not exported and needs a
// database, a blob store and a managed browser provider. What it pins is a literal, which is the one
// thing a grep can check as well as a behavioural test could.
//
// prepareManaged wrote 'before_fill' from the day it shipped, and nothing caught it because nothing
// asserted it: every stage test in the suite passes the stage in by hand. Measured against prod on
// 2026-08-08, the fourteen open stalls this function wrote carried 5 to 15 filled fields each, which
// is what makes stallNudge render "Nothing is filled in yet" about a form Litos had filled and
// screenshotted for them. Undelivered so far only because the nudge endpoint has no scheduler. The
// stall is written AFTER the fill run and after the preview is captured - the same shape the direct
// path in prepare() already records as 'at_submit'.
test('a managed prepare stall records at_submit, because the fill already happened', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const source = readFileSync(join(__dirname, 'submissionRunner.ts'), 'utf8');
  const start = source.indexOf('async function prepareManaged(');
  assert.ok(start > 0, 'prepareManaged() must exist');
  // The end marker is asserted, not assumed. indexOf returns -1 when prepareManaged is the last
  // async function in the file, and slice(start, -1) would then run to the end of the file - so the
  // ordering checks below would happily match the submit path's own beginStall and pass for the
  // wrong function.
  const end = source.indexOf('\nasync function ', start + 10);
  assert.ok(end > start, 'prepareManaged() must be followed by another async function');
  const body = source.slice(start, end);

  // The fill, the screenshot upload and the field list all precede the stall. That ordering is what
  // makes 'at_submit' the true label, so it is asserted rather than assumed: if a later change moves
  // the stall above the fill run, this test should fail loudly instead of leaving a stale stage.
  const stallAt = body.indexOf('beginStall(');
  assert.ok(stallAt > 0, 'prepareManaged() must open a stall when it stops on a challenge');
  for (const earlier of ['buildManagedPortalActions(', 'submission-runs/', 'managedResultFilledFields(']) {
    const at = body.indexOf(earlier);
    assert.ok(at > 0 && at < stallAt, `${earlier} must run before the stall is written`);
  }

  const stallBlock = body.slice(stallAt, body.indexOf('}', body.indexOf('source:', stallAt)));
  assert.match(stallBlock, /stage: 'at_submit'/,
    'a stall written after the form was filled and screenshotted must not claim the form is blank');
  assert.doesNotMatch(stallBlock, /stage: 'before_fill'/);
});

/* R-096: a required field Litos cannot answer must still be answerable BY THE APPLICANT.
 *
 * Measured on 2026-08-08 across the owner's 83 production packets: 126 of 242
 * "is required and is still empty" blocker sentences named a field with no question record at all,
 * so the dashboard had nothing to render an input against and no button could help. On the Anduril
 * run those were Discipline, "What is your top location preference?" and EXPORT CONTROLS.
 *
 * Labels are the VERBATIM raw strings discovery returns for that live posting. The blocker sentence
 * is built through describeRequiredBlocker rather than typed out, so the test breaks if the
 * production wording ever moves. */
const ANDURIL_REVIEW: ApplicationReviewState = {
  jd_text: 'Anduril Industries is hiring a 2027 Software Engineer Intern in Costa Mesa, California.',
  role: '2027 Software Engineer Intern',
  portal_url: 'https://job-boards.greenhouse.io/embed/job_app?for=andurilindustries&token=5148079007',
  ats_name: 'greenhouse',
  status: 'needs_attention',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: new Date().toISOString(),
};

const ANDURIL_ORPHAN_FIELDS = [
  { label: 'Discipline* discipline--0', selector: '[data-litos-discovered-8]', inputType: 'combobox', maxLength: null },
  { label: 'What is your top location preference? * question_12114511007', selector: '[data-litos-discovered-14]', inputType: 'combobox', maxLength: null },
  { label: 'EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls. Your responses to the questions below will be used solely to determine your eligibility under U.S. law to receive information and materials subject to U.S. export controls.* question_12114512007', selector: '[data-litos-discovered-16]', inputType: 'combobox', maxLength: null },
];

test('every Anduril blocker with no question record now has one, with no answer invented', async () => {
  const result = await discoverAndResolveQuestions(
    ANDURIL_ORPHAN_FIELDS,
    { user_id: 'user-1' } as ResumeRow,
    ANDURIL_REVIEW,
    { work_authorized: true, needs_sponsorship: false },
    true,
    'greenhouse',
  );

  for (const label of ['Discipline', 'What is your top location preference?', 'EXPORT CONTROLS']) {
    const question = result.questions.find((item) => item.question.startsWith(label));
    assert.ok(question, `no question record for ${label}`);
    assert.equal(question.required, true, `${label} must be required so the dashboard offers an input`);
    assert.equal(question.answer, '', `${label} must carry NO answer: Litos does not know it`);
  }
});

test('the blocker the applicant used to be stuck on is now backed by a question with the same text', async () => {
  const result = await discoverAndResolveQuestions(
    ANDURIL_ORPHAN_FIELDS,
    { user_id: 'user-1' } as ResumeRow,
    ANDURIL_REVIEW,
    { work_authorized: true, needs_sponsorship: false },
    true,
    'greenhouse',
  );

  // The exact production pairing: the fill pass writes this sentence, and the dashboard suppresses
  // the blocker line only when a question record carries the same field text. Before this fix the
  // sentence appeared with nothing behind it.
  for (const question of result.questions) {
    const blocker = describeRequiredBlocker(question.question);
    assert.ok(blocker.includes(question.question), blocker);
  }
  assert.equal(result.questions.length, 3);
});

test('export controls is surfaced but never auto-answered, and neither is any self-declaration', async () => {
  const legalFields = [
    { label: 'EXPORT CONTROLS - This position requires access to information and technology that is subject to U.S. export controls.* question_12114512007', selector: '[data-litos-discovered-16]', inputType: 'combobox', maxLength: null },
    { label: 'I certify that all information I have provided is true, complete and correct.* question_9911', selector: '[data-litos-discovered-21]', inputType: 'checkbox', maxLength: null },
    { label: 'Privacy Policy Acknowledgement* question_9912', selector: '[data-litos-discovered-22]', inputType: 'checkbox', maxLength: null },
  ];
  const result = await discoverAndResolveQuestions(
    legalFields,
    { user_id: 'user-1' } as ResumeRow,
    ANDURIL_REVIEW,
    { work_authorized: true, needs_sponsorship: false },
    true,
    'greenhouse',
  );

  assert.equal(result.questions.length, legalFields.length);
  for (const question of result.questions) {
    assert.equal(question.answer, '', `${question.question} was auto-answered, which it must never be`);
    assert.equal(question.required, true);
  }
});

test('an optional field Litos cannot answer is still left alone, so submission is not blocked on it', async () => {
  const result = await discoverAndResolveQuestions(
    [
      // No required marker: the employer does not need these, so inventing a required question here
      // would stall an application that was ready to go out.
      { label: 'Gender gender', selector: '[data-litos-discovered-21]', inputType: 'combobox', maxLength: null },
      { label: 'Website Website question_12114508007', selector: '[data-litos-discovered-11]', inputType: 'text', maxLength: null },
      { label: 'What is your favourite bird? question_9999', selector: '[data-litos-discovered-30]', inputType: 'text', maxLength: null },
    ],
    { user_id: 'user-1' } as ResumeRow,
    ANDURIL_REVIEW,
    { work_authorized: true, needs_sponsorship: false },
    true,
    'greenhouse',
  );

  assert.deepEqual(result.questions.filter((question) => !question.answer.trim()), []);
});

test('required-ness reaches the stored question, so the dashboard and the 422 stop being inert', async () => {
  // R-095: `required` was hardcoded false at all three construction sites, so every guard that reads
  // it (the "Required answer missing" row, the "Some answers are missing" check, the backend 422)
  // could never fire on any of the 468 questions stored across the owner's packets.
  const result = await discoverAndResolveQuestions(
    [
      { label: 'How did you hear about Anduril?* question_12114515007', selector: '[data-litos-discovered-19]', inputType: 'combobox', maxLength: null },
      { label: 'Website Website question_12114508007', selector: '[data-litos-discovered-11]', inputType: 'text', maxLength: null },
    ],
    { user_id: 'user-1' } as ResumeRow,
    ANDURIL_REVIEW,
    { work_authorized: true, needs_sponsorship: false, referral_source_default: 'Company website' },
    true,
    'greenhouse',
  );

  const heardAbout = result.questions.find((question) => question.question.startsWith('How did you hear'));
  assert.ok(heardAbout);
  assert.equal(heardAbout.required, true);
  assert.equal(heardAbout.answer, '');
  assert.match(result.attentionReasons.join('\n'), /how you heard about this role is yours to answer/i);
});

test('a stale answer is invalidated when the current resolver refuses the exact field', async () => {
  const answered: ApplicationReviewState = {
    ...ANDURIL_REVIEW,
    questions: [{
      id: 'q-existing',
      question: 'What is your top location preference?',
      answer: 'Costa Mesa, CA',
      kind: 'required',
      required: true,
    }],
  };
  const result = await discoverAndResolveQuestions(
    [ANDURIL_ORPHAN_FIELDS[1]],
    { user_id: 'user-1' } as ResumeRow,
    answered,
    { work_authorized: true, needs_sponsorship: false },
    true,
    'greenhouse',
  );

  const question = result.questions.find((item) => item.question.startsWith('What is your top location'));
  assert.ok(question, 'the required field must remain available for a fresh applicant answer');
  assert.equal(question.answer, '');
  assert.equal(question.id, 'q-existing');
  assert.ok(result.invalidatedQuestionKeys.includes('what is your top location preference?'));
  const merged = mergeDiscoveredPortalQuestions(result.questions, answered.questions, result.invalidatedQuestionKeys);
  assert.equal(merged[0]?.answer, '', 'the later packet merge must not restore the stale value');
});

test('refused required and optional answers cannot re-enter a packet through the stored-question merge', async () => {
  const fields = [
    { label: 'Are you able to work onsite in our office five days per week?* question_1', selector: '#q1', inputType: 'select', maxLength: null, options: ['Yes', 'No'] },
    { label: 'Will you require visa sponsorship for employment?* question_2', selector: '#q2', inputType: 'select', maxLength: null, options: ['Yes', 'No'] },
    { label: 'I certify that all information in this application is true and complete.* question_3', selector: '#q3', inputType: 'checkbox', maxLength: null },
    { label: 'Candidate Privacy Notice question_4', selector: '#q4', inputType: 'checkbox', maxLength: null },
    { label: 'AI Policy for Interviewers question_5', selector: '#q5', inputType: 'checkbox', maxLength: null },
    { label: 'When can you start?* question_6', selector: '#q6', inputType: 'text', maxLength: null },
  ];
  const stored = fields.map((field, index) => ({
    id: `stale-${index}`,
    question: field.label.replace(/\*?\s+question_\d+$/, ''),
    answer: index === 5 ? 'June 1, 2026' : 'Yes',
    kind: 'required' as const,
    required: field.label.includes('*'),
  }));
  const result = await discoverAndResolveQuestions(
    fields,
    { user_id: 'user-1' } as ResumeRow,
    { ...ANDURIL_REVIEW, questions: stored },
    { work_authorized: true, needs_sponsorship: false, availability_date: 'June 1, 2026' },
    true,
    'greenhouse',
  );
  const merged = mergeDiscoveredPortalQuestions(result.questions, stored, result.invalidatedQuestionKeys);
  assert.equal(merged.some((question) => question.answer.trim()), false);
  assert.equal(merged.some((question) => question.question === 'Candidate Privacy Notice'), false);
  assert.equal(merged.some((question) => question.question === 'AI Policy for Interviewers'), false);
});

test('a remembered exact score does not survive changed closed-list options in discovery', async () => {
  const label = 'What was your SAT score?';
  const result = await discoverAndResolveQuestions(
    [{ label: `${label}* question_7`, selector: '#sat', inputType: 'select', maxLength: null, options: ['1200-1399', '1400-1499', '1500-1600'] }],
    { user_id: 'user-1' } as ResumeRow,
    { ...ANDURIL_REVIEW, questions: [{ id: 'stale-sat', question: label, answer: '1510', kind: 'required', required: true }] },
    {},
    true,
    'greenhouse',
    new Map([[savedAnswerKey(label), '1510']]),
  );
  assert.equal(result.questions[0]?.answer, '');
  assert.match(result.attentionReasons.join(' '), /none of the options exactly match your remembered answer/);
  assert.equal(mergeDiscoveredPortalQuestions(
    result.questions,
    [{ id: 'stale-sat', question: label, answer: '1510', kind: 'required', required: true }],
    result.invalidatedQuestionKeys,
  )[0]?.answer, '');
});

test('a failed live GPA selector cannot be restored from a stale stored question', () => {
  const failedId = 'question_37228964002';
  const merged = mergeDiscoveredPortalQuestions(
    [],
    [{
      id: 'stale-gpa',
      question: 'Overall GPA',
      answer: '3.89',
      kind: 'required',
      required: true,
      portal_selector: `#${failedId}`,
      portal_input_type: 'select-one',
    }],
    [],
    new Set([failedId]),
  );
  assert.deepEqual(merged, []);
});

/* R-101, the reporting half. The DRW Software Developer Intern run of 2026-08-08 recorded
 * `questions: 0`, twenty-seven "is required and is still empty" lines, `submission_error: null`
 * and no stall. Every sentence in it was true and the run as a whole was not: it named twenty-seven
 * obstacles and offered no control that could clear any of them, and said nothing about that.
 *
 * These pin the two admissions the run owes. */

test('a required blocker with no question record is counted, even when the label was truncated', () => {
  const blockers = [
    '"Discipline" is required and is still empty',
    '"Please rate your skill level in general purpose Python programming (language features, concurrency, standard library and" is required and is still empty',
    '"Please provide a copy of your most recent transcript from your highest degree level." is required and is still empty',
    'CAPTCHA requires your attention',
  ];
  const questions = [
    { question: 'Discipline' },
    // The provider truncated the blocker at 120 characters; the stored question is the full text.
    { question: 'Please rate your skill level in general purpose Python programming (language features, concurrency, standard library and idioms).' },
  ];
  assert.deepEqual(
    unansweredRequiredBlockerLabels(blockers, questions),
    ['Please provide a copy of your most recent transcript from your highest degree level.'],
  );
});

test('a short stored question never swallows a long blocker by prefix', () => {
  // "GPA" is a prefix of nothing useful, and treating it as one would hide a real gap.
  assert.deepEqual(
    unansweredRequiredBlockerLabels(['"GPA and test scores" is required and is still empty'], [{ question: 'GPA' }]),
    ['GPA and test scores'],
  );
});

test('a run that discovered nothing and a run that could not look are different admissions', () => {
  assert.deepEqual(discoveryHonestyReasons(undefined, []), []);

  const failed = discoveryHonestyReasons('A run may contain at most 120 actions', []);
  assert.equal(failed.length, 1);
  assert.match(failed[0]!, /could not read the questions this form asks/);
  assert.match(failed[0]!, /at most 120 actions/);

  const unanswerable = discoveryHonestyReasons(undefined, ['Please provide a copy of your most recent transcript']);
  assert.equal(unanswerable.length, 1);
  assert.match(unanswerable[0]!, /^1 required field has no question you can answer in Litos/);

  assert.equal(discoveryHonestyReasons('boom', ['A', 'B']).length, 2);
  assert.match(discoveryHonestyReasons(undefined, ['A', 'B'])[0]!, /^2 required fields have/);
});

test('a scan that threw with no message is still a failure, not a silent success', () => {
  /* THE BACK DOOR. `new Error()` carries `message === ''`, and discoveryHonestyReasons tests its
     argument for truthiness, so an empty message renders NO admission. A send decision counted off
     that array would read zero reasons, call the packet safe, and auto-submit under standing
     consent a form whose questions were never read - which is the exact bug the swallow fix exists
     to remove, reintroduced through the presentation layer.

     Two independent guarantees, because either alone leaves a hole: the message is normalized so
     the applicant always gets a sentence, and prepareDirect counts discoveryFailures.length rather
     than honestyReasons.length so the send decision never depends on prose at all. */
  assert.equal(describeDiscoveryFailure(new Error()), 'the scan failed without reporting a reason');
  assert.equal(describeDiscoveryFailure(new Error('   ')), 'the scan failed without reporting a reason');
  assert.equal(describeDiscoveryFailure(''), 'the scan failed without reporting a reason');
  assert.equal(describeDiscoveryFailure(new Error('page closed')), 'page closed');
  assert.equal(describeDiscoveryFailure('page closed'), 'page closed');

  // Normalized, it renders a real admission instead of nothing.
  assert.equal(discoveryHonestyReasons(describeDiscoveryFailure(new Error()), []).length, 1);
  // And the send decision is counted off the failure itself, not off the sentence.
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  assert.match(runner, /attentionCount:[^\n]*\+ discoveryFailures\.length/);
  assert.doesNotMatch(runner, /attentionCount:[^\n]*honestyReasons\.length/);
});

/* A QUESTION THE BUDGET DROPPED MAY NOT BE SENT OVER.
 *
 * buildManagedPortalActions used to refuse a prepare run whose reviewed questions could not all fit,
 * which cost the applicant the fixed fields, the preview and the evidence reads on the packets most
 * likely to need them. It now trims instead - a prepare run has no submit button to withhold - and
 * that trade is only acceptable while every dropped question is surfaced and blocks the send.
 *
 * Without the gate the failure is completely silent: a dropped question is not in filled_fields, it
 * produces no provider blocker unless the employer happens to mark it required, and on the preview
 * screenshot it is a blank that looks like every other optional blank. Standing consent then turns
 * `safe` into a click in the same call, and an answer she gave Litos goes to the employer missing.
 *
 * Asserted against the source for the same reason as the test below: prepareManaged needs a remote
 * runner, a database and blob storage, so the wiring is what can be pinned here. Mutation-checked -
 * removing the gate leaves every behavioural test in the suite green. */
test('a question the action budget dropped blocks the send and is named to the applicant', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');

  // Computed from the finished action list, through the helper that separates a budget drop from a
  // family that never fills questions at all. The undiscriminating helper here would mark every
  // SmartRecruiters, JazzHR and BambooHR packet unsendable over a pre-existing scope limit.
  assert.match(runner, /budgetDroppedReviewedQuestions\(packet, fillActions\)/);
  assert.doesNotMatch(runner, /reviewedQuestionsWithoutActions\(packet, fillActions\)/);

  // It reaches her attention list...
  assert.match(runner, /\.\.\.budgetShortfallReasons/);
  assert.match(runner, /left untouched and nothing has been sent/);
  // ...and it gates the send, not just the display.
  assert.match(runner, /&& unattemptedQuestions\.length === 0/);
  // Logged as an error too: a run that cannot hold the questions it was given is a product defect
  // before it is the applicant's problem.
  assert.match(runner, /The action budget could not hold every reviewed question/);
});

/* NEITHER prepare path may throw the question scan's failure away.
 *
 * prepareManaged learned this on 2026-08-08, from a DRW packet whose discovery call was rejected
 * with HTTP 400 before a browser opened: the run filled the fixed fields, recorded 27 separate
 * "is required and is still empty" blockers, wrote zero question records, and reported no error.
 * `.catch(() => null)` is what made a total failure of the scan look exactly like a form with no
 * custom questions.
 *
 * prepareDirect kept the identical bug in `.catch(() => [])` for the live-Page scan, and the
 * consequence there is worse: standing consent turns a `safe` preparation into a click inside the
 * same call, so a swallowed scan failure could send a form whose questions were never read.
 *
 * Asserted against the SOURCE because neither path is reachable from a unit test - one needs a
 * remote runner, the other a live browser session, a database and blob storage - and the pure
 * pieces above pass whether or not anything calls them. What is being pinned is the wiring: both
 * scans record their failure, both feed discoveryHonestyReasons, and on both paths the result
 * reaches the applicant's attention list and gates `safe`. */
test('neither prepare path can call a form safe on the strength of a scan that failed', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');

  // The two swallows, by their exact original text. This is the assertion that fails if either is
  // ever restored, and it is the whole point of the test.
  assert.doesNotMatch(runner, /discoverPageQuestions\(page\)\s*\.catch\(\(\) => \[\]\)/);
  assert.doesNotMatch(runner, /buildManagedDiscoveryActions\([^)]*\)\)\s*\.catch\(\(\) => null\)/);

  // Both scans record what went wrong rather than returning an empty result that says nothing,
  // and both normalize the thrown value so an empty Error message cannot become an empty record.
  assert.equal(runner.match(/discoveryFailures\.push\(message\)/g)?.length, 2);
  /* THREE normalizers. The option-probe normalizer can hold the send too, but its failure is
   * aggregated separately so one failed batch names every affected durable control once.
   *
   * The third is the option-probe pass: a read-only third managed call that opens each closed
   * control the discovery pass found and reads its real option list. It normalizes its error for the
   * same reason the other two do. Unlike the old fallback, a missing option list is not permission
   * to send a guessed alias into a closed employer control. */
  assert.equal(runner.match(/describeDiscoveryFailure\(error\)/g)?.length, 3);
  assert.match(runner, /closed-control option discovery failed:/);
  assert.match(runner, /const discoveryRoleCapability = managedResultSupportsDiscoveryRole\(discoveryResult\)/);
  assert.match(runner, /buildManagedDiscoveredOptionProbeBatches\([\s\S]{0,300}discoveryRoleCapability/);
  assert.match(runner, /managedOptionProbeAnalysis\([\s\S]{0,500}discoveryRoleCapability/);
  const analysisIndex = runner.indexOf('managedOptionProbeAnalysis(');
  const filterIndex = runner.indexOf('.filter((field) =>', analysisIndex);
  const resolutionIndex = runner.indexOf('discoverAndResolveQuestions(', filterIndex);
  assert.ok(analysisIndex > 0 && filterIndex > analysisIndex && resolutionIndex > filterIndex,
    'failed closed fields must be removed before any alias resolution can run');
  assert.equal(
    runner.match(/'Question discovery pass failed, so this run cannot see the questions this form asks'/g)?.length,
    2,
  );

  // Both turn it into something the applicant reads...
  assert.equal(runner.match(/discoveryHonestyReasons\(discoveryFailures\[0\]/g)?.length, 2);
  assert.match(runner, /\.\.\.coverLetterAttention,\s*\.\.\.honestyReasons\b/);
  // ...and neither can be called safe while it stands. BOTH gates read the failure array itself,
  // never the rendered prose, so a message that renders to nothing cannot restore `safe`. The
  // direct path's count is matched loosely on purpose: it sums several independent hold-the-send
  // reasons and more will be added, so the assertion pins that this term is present, not the
  // arithmetic around it.
  assert.match(runner, /&& discoveryFailures\.length === 0/);
  assert.match(runner, /attentionCount:[^\n]*\+ discoveryFailures\.length/);
});

test('a radio option is not recorded as a question the applicant has to answer', async () => {
  /* The packet side of the same gate the pre-script applies. Fixture is the Palantir Lever form as
   * discovery really reported it on 2026-08-11, across 11 of the owner's packets: the radio and
   * checkbox rows carry their own OPTION text plus the card's name attribute, and the questions the
   * form actually asked are the plain cards beside them.
   *
   * R-096 records an unanswerable required field on purpose, so without this gate every one of
   * these becomes a blocker reading '"Yes" is required and is still empty' and a row on the Apply
   * screen asking her to answer the word "Yes". */
  const current: ApplicationReviewState = {
    jd_text: 'Palantir early talent internship.',
    role: 'Software Engineer Intern',
    portal_url: 'https://jobs.lever.co/palantir/123',
    ats_name: 'lever',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };
  // required: true throughout, as the live form marks them. That is what makes each of these a
  // BLOCKER when it is recorded, and what makes this test fail if the gate is removed.
  const card = (label: string, inputType: string, options?: string[]) => ({
    label,
    selector: '[data-litos-discovered-1]',
    inputType,
    maxLength: null,
    required: true,
    ...(options ? { options } : {}),
  });

  const result = await discoverAndResolveQuestions(
    [
      card('Yes cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]', 'radio'),
      card('Yes, I consent cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]', 'checkbox'),
      card('English (ENG) cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]', 'checkbox'),
      card('cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field1]', 'text'),
      // The composite typeahead whose <label> textContent swallowed its own empty state.
      card('Current location No location found. Try entering a different locationLoading location location-input', 'text'),
      // A real question on the same form, which has to survive all of it.
      card('Year of Graduation cards[a69a985a-eae9-4c14-90fb-b5a4b891523e][field0]', 'text'),
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { grad_date: 'May 2028', grad_year: 2028 },
    true,
    'lever',
  );

  const labels = result.questions.map((question) => question.question.toLowerCase());
  for (const rejected of ['yes', 'yes, i consent', 'english (eng)', 'cards [field0]', 'cards [field1]']) {
    assert.equal(labels.includes(rejected), false, `${rejected} must not be recorded as a question`);
  }
  assert.equal(labels.some((label) => label.includes('no location found')), false);
  assert.ok(labels.some((label) => label.includes('year of graduation')), 'the real question must survive');
});

test('a bare privacy label still reaches the packet as a question', async () => {
  // The packet-side half of the R-PROTECT guard in postingQuestions.test.ts. Point72 and IMC label
  // their consent checkbox exactly this way, and Litos answers it from accept_privacy_notices.
  const current: ApplicationReviewState = {
    jd_text: 'Point72 Academy.',
    role: 'Investment Analyst Intern',
    portal_url: 'https://example.greenhouse.io/jobs/1',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };
  const result = await discoverAndResolveQuestions(
    [
      { label: 'Privacy', selector: '[data-litos-discovered-1]', inputType: 'checkbox', maxLength: null, required: true },
      { label: 'Privacy statement', selector: '[data-litos-discovered-2]', inputType: 'checkbox', maxLength: null, required: true },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { accept_privacy_notices: true },
    true,
    'greenhouse',
  );
  const labels = result.questions.map((question) => question.question.toLowerCase());
  assert.ok(labels.includes('privacy'), 'the bare "Privacy" label must stay a question');
  assert.ok(labels.includes('privacy statement'), 'the bare "Privacy statement" label must stay a question');
});
