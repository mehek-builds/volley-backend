import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import {
  attentionCategoriesForReasons,
  applicationContextForQuestionResolution,
  attentionBlockersForManagedResult,
  atsApiSubmissionEnabled,
  describeDiscoveryFailure,
  discoveredControlInputType,
  compactMaterialQuestions,
  discoverAndResolveQuestions,
  discoveryHonestyReasons,
  isProviderSessionFailureMessage,
  mergeDiscoveredPortalQuestions,
  managedExtensionHandoffUrl,
  measuredRequiredDocuments,
  coveredOptionProbeFailureIds,
  optionProbeAttentionReasons,
  packetUsesControlledResumeFixture,
  FORM_NOT_REACHED_REASON,
  preparationEvidenceBlockers,
  reconcileManagedProviderBlockers,
  readMostRecentRole,
  resolveApplicantClosedChoiceFallbacks,
  resumeBytesForPacket,
  sanitizeEeoPrefs,
  shouldUseLocalControlledBrowser,
  submissionFailureOutcome,
  submissionGraduationDateParts,
  unansweredRequiredBlockerLabels,
  type ResumeRow,
  packetQuestionsForFill,
  truthfulOtherChoice,
} from './submissionRunner';
import { PacketDocumentExpiredError } from '../lib/resumeAccess';
import { savedAnswerKey } from '../lib/answerReuse';
import {
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from '../lib/questionDiscovery';
import { workEligibilityFromSponsorshipAnswer } from '../lib/applicationProfileLike';
import type { ApplicationReviewState } from '../lib/applicationReview';
import type { SubmissionPacket } from '../lib/portalSubmission';
import { describeRequiredBlocker } from '../lib/fieldLabel';
import {
  attachManagedFieldOptions,
  buildManagedPortalActions,
  detectPortal,
  managedOptionProbeAnalysis,
  reactSelectListboxSelector,
} from '../lib/portalSubmission';
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

test('closed taxonomies use Other only for truthful referral and recent-experience fallbacks', () => {
  assert.equal(truthfulOtherChoice(
    'How did you hear about Optiver?',
    'Job board',
    ['Indeed', 'LinkedIn', 'Other'],
  ), 'Other');
  assert.equal(truthfulOtherChoice(
    'Where did you complete your most recent internship or research experience?',
    'Cinematica Labs',
    ['Amazon', 'Anduril Industries', 'Other'],
  ), 'Other');
  assert.equal(truthfulOtherChoice(
    'Which programming language do you prefer?',
    'Rust',
    ['Python', 'TypeScript', 'Other'],
  ), undefined);
  assert.equal(truthfulOtherChoice(
    'How did you hear about Optiver?',
    'LinkedIn',
    ['LinkedIn', 'Other'],
  ), undefined);
});

test('managed choice fallback carries the job-board detail and preserves the original fact as provenance', () => {
  const discovered = [
    {
      label: 'How did you hear about Optiver?* question_1',
      selector: '#source',
      inputType: 'combobox',
      maxLength: null,
      options: ['Indeed', 'LinkedIn', 'Other'],
    },
    {
      label: 'If other, please explain question_2',
      selector: '#source-detail',
      inputType: 'text',
      maxLength: 100,
    },
    {
      label: 'Where did you complete your most recent internship or research experience?* question_3',
      selector: '#experience',
      inputType: 'combobox',
      maxLength: null,
      options: ['Amazon', 'Anduril Industries', 'Other'],
    },
  ];
  const resolved = resolveApplicantClosedChoiceFallbacks(discovered, [
    {
      id: 'source',
      question: 'How did you hear about Optiver?',
      answer: 'Job board',
      kind: 'required',
      required: true,
      options: discovered[0]!.options,
      answer_source: 'applicant_review',
    },
    {
      id: 'detail',
      question: 'If other, please explain',
      answer: 'N/A',
      kind: 'required',
      required: false,
      answer_source: 'applicant_review',
    },
    {
      id: 'experience',
      question: 'Where did you complete your most recent internship or research experience?',
      answer: 'Cinematica Labs, Los Angeles, CA',
      kind: 'required',
      required: true,
      options: discovered[2]!.options,
      answer_source: 'applicant_review',
    },
  ]);

  assert.deepEqual(
    resolved.map(({ answer, answer_source, answer_option_source }) => ({ answer, answer_source, answer_option_source })),
    [
      { answer: 'Other', answer_source: undefined, answer_option_source: 'Job board' },
      { answer: 'Litos', answer_source: undefined, answer_option_source: undefined },
      { answer: 'Other', answer_source: undefined, answer_option_source: 'Cinematica Labs, Los Angeles, CA' },
    ],
  );
  assert.deepEqual(
    refreshKnownQuestionAnswers(
      resolved,
      { referral_source_default: 'Job board' },
      'Optiver Software Engineer Intern',
    ).map((question) => question.answer),
    ['Other', 'Litos', 'Other'],
    'the exact reviewed packet and the submit packet must keep the same truthful choices',
  );
});

test('managed choice fallback carries the job-board detail when options survive only on the review question', () => {
  const resolved = resolveApplicantClosedChoiceFallbacks(
    [
      {
        label: 'How did you hear about Optiver?* question_1',
        selector: '#source',
        inputType: 'combobox',
        maxLength: null,
      },
      {
        label: 'If other, please explain question_2',
        selector: '#source-detail',
        inputType: 'text',
        maxLength: 100,
      },
    ],
    [
      {
        id: 'source',
        question: 'How did you hear about Optiver?',
        answer: 'Job board',
        kind: 'required',
        required: true,
        options: ['LinkedIn', 'Other'],
      },
      {
        id: 'detail',
        question: 'If other, please explain',
        answer: 'N/A',
        kind: 'required',
        required: false,
      },
    ],
  );

  assert.deepEqual(
    resolved.map(({ answer, answer_option_source }) => ({ answer, answer_option_source })),
    [
      { answer: 'Other', answer_option_source: 'Job board' },
      { answer: 'Litos', answer_option_source: undefined },
    ],
  );
});

test('the compact packet preselects only unresolved open prose controls', () => {
  const current: ApplicationReviewState = {
    jd_text: 'Build Python services.',
    role: 'Software Engineer',
    portal_url: 'https://job-boards.greenhouse.io/acme/jobs/1',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [{
      id: 'stored',
      question: 'Why this company?',
      answer: 'My already reviewed answer.',
      kind: 'essay',
      required: true,
    }],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };
  const selected = compactMaterialQuestions([
    { label: 'Why this company?', selector: '#why', inputType: 'textarea', maxLength: 1000 },
    { label: 'Tell us about a project you are proud of.', selector: '#project', inputType: 'textarea', maxLength: 1000 },
    { label: 'Rank these languages by proficiency: Python, Java', selector: '#rank', inputType: 'textarea', maxLength: 1000 },
    { label: 'Choose your office', selector: '#office', inputType: 'select', options: ['New York', 'London'], maxLength: null },
    { label: 'Have you previously applied here?', selector: '#history', inputType: 'textarea', maxLength: 1000 },
  ], current, 'greenhouse', ['Python']);

  assert.deepEqual(selected.map((question) => question.id), [
    'tell us about a project you are proud of.',
  ]);
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

test('an empty LinkedIn field is a required field, not a document the employer wants uploaded', () => {
  /* `file` lives inside `profile`, and the arm that classifies documents had no word boundaries, so
     every packet stopped on an empty LinkedIn or GitHub URL was counted as a stopped-on-a-document
     one. Counting only: nothing keys a control off this category, and the dashboard reads
     review.required_documents instead. See lib/requiredDocuments.ts for why that is structural
     rather than a second regex. */
  for (const label of ['LinkedIn Profile', 'LinkedIn Profile URL', 'GitHub profile']) {
    assert.deepEqual(
      attentionCategoriesForReasons([`"${label}" is required and is still empty`]),
      ['required_field'],
      label,
    );
  }
  // And the boundary must not cost the sentences that really are about a document.
  for (const reason of [
    '"Transcript" is required and is still empty',
    '"Upload transcripts" is required and is still empty',
    '"Supporting documents" is required and is still empty',
    '"Attachments" is required and is still empty',
    '"Additional files" is required and is still empty',
  ]) {
    assert.deepEqual(attentionCategoriesForReasons([reason]), ['required_document'], reason);
  }
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
    /const extensionHandoffUrl = managedExtensionHandoffUrl\([\s\S]*?portal,[\s\S]*?result\.url,[\s\S]*?networkAccessRestriction,[\s\S]*?captchaAttention,[\s\S]*?\)/,
  );
  assert.match(prepareManagedSource, /extension_handoff_binding: extensionHandoffBinding/);
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

test('a resume whose object key resolves to nothing throws the typed expired error, not a bare Error', async () => {
  /* The type is the entire mechanism. fail() reads it to rank the stop above uncertainAfterClaim,
     so a bare Error here silently restores the "check the portal or your email" sentence on a
     packet that was never filled in. Asserting instanceof rather than the message pins the half
     that fail() actually reads. */
  await assert.rejects(
    () => resumeBytesForPacket('users/user-1/resumes/gone.pdf', false, {
      resolveObjectUrl: async () => null,
      fetchObject: async () => { throw new Error('must not be fetched once the key is gone'); },
    }),
    (error: unknown) => {
      assert.ok(error instanceof PacketDocumentExpiredError);
      assert.equal(error.document, 'resume');
      assert.match(error.message, /Generated resume file is unavailable/,
        'message kept verbatim so existing logs and operator greps still match');
      return true;
    },
  );
});

test('a key that resolves but fails to download is NOT an expired packet', () => {
  /* A live storage fault and a deleted file owe different sentences: one is worth retrying and the
     other can only be regenerated. Typing both would collapse that distinction and tell someone to
     regenerate a resume that is still sitting in the blob store. */
  return assert.rejects(
    () => resumeBytesForPacket('users/user-1/resumes/present.pdf', false, {
      resolveObjectUrl: async () => 'https://blob.example.test/present.pdf',
      fetchObject: async () => ({ ok: false, arrayBuffer: async () => new ArrayBuffer(0) }),
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof PacketDocumentExpiredError));
      assert.match(error.message, /could not be downloaded/);
      return true;
    },
  );
});

test('the cover-letter degrade never swallows an expired resume', () => {
  /* buildPacket loads both documents, so an expired RESUME lands in the cover-letter catch too.
     Degrading it there logged a resume failure as an attachment problem and then re-entered
     buildPacket, which threw on the same missing file a second time. */
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const guard = /if \(error instanceof PacketDocumentExpiredError && error\.document === 'resume'\) throw error;/;
  assert.match(source, guard);
  const catchIndex = source.indexOf('Cover letter file could not be attached');
  assert.ok(catchIndex > 0);
  assert.ok(source.slice(0, catchIndex).search(guard) > 0,
    'the rethrow has to come BEFORE the degrade, or the degrade is what runs');
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

/* The Quandela park, measured live 2026-08-20: a required Workable textarea labelled "cover letter"
 * was stored as a question with an empty answer and the run parked on '"Cover letter" is required
 * and is still empty', while the packet already carried a finished cover letter for the attachment
 * path. These pin the fix: the text control gets the SAME stored body the attachment path uses, an
 * answer the applicant wrote herself is never overwritten, and when no letter can be produced the
 * field parks exactly as before instead of crashing the run. */

const coverLetterReviewState = (): ApplicationReviewState => ({
  jd_text: 'Build quantum photonic software in Paris.',
  role: 'Software Engineering Intern',
  portal_url: 'https://apply.workable.com/quandela/j/ABC123/',
  ats_name: 'workable',
  status: 'ready_to_submit',
  edited_terms: [],
  questions: [],
  skipped_reasons: [],
  updated_at: new Date().toISOString(),
});

const COVER_LETTER_TEXTAREA = {
  label: 'Cover letter *',
  selector: '#cover_letter',
  inputType: 'textarea',
  maxLength: null,
  required: true,
};

test('a required cover-letter textarea gets the stored cover-letter body as its answer', async () => {
  const body = 'Dear Quandela team, I build photonic tooling. I would like to keep doing that with you.';
  const row = {
    user_id: 'user-1',
    job_context: { company: 'Quandela', role: 'Software Engineering Intern' },
    spec: {
      _cover_letter: {
        body,
        word_count: 17,
        warnings: [],
        generated_at: new Date().toISOString(),
        object_key: 'users/user-1/resumes/cl.pdf',
        file_name: 'Cover Letter.pdf',
      },
    },
  } as ResumeRow;

  const result = await discoverAndResolveQuestions(
    [COVER_LETTER_TEXTAREA],
    row,
    coverLetterReviewState(),
    {},
    true,
    'workable',
  );

  assert.equal(result.questions.length, 1);
  const question = result.questions[0];
  assert.equal(question.question, 'Cover letter');
  assert.equal(question.answer, body);
  assert.equal(question.required, true);
  assert.equal(question.portal_selector, '#cover_letter');
  assert.equal(question.portal_input_type, 'textarea');
  assert.deepEqual(result.attentionReasons, []);
});

test('an applicant-written cover-letter answer is never overwritten by the stored letter', async () => {
  const hers = 'I wrote this one myself and it says what I want it to say.';
  const current = coverLetterReviewState();
  current.questions = [{
    id: 'her-question',
    question: 'Cover letter',
    answer: hers,
    kind: 'essay',
    required: true,
    answer_source: 'applicant_review',
  }];
  const row = {
    user_id: 'user-1',
    job_context: { company: 'Quandela', role: 'Software Engineering Intern' },
    spec: {
      _cover_letter: {
        body: 'A machine-written letter that must not replace hers.',
        word_count: 9,
        warnings: [],
        generated_at: new Date().toISOString(),
        object_key: 'users/user-1/resumes/cl.pdf',
        file_name: 'Cover Letter.pdf',
      },
    },
  } as ResumeRow;

  const result = await discoverAndResolveQuestions(
    [COVER_LETTER_TEXTAREA],
    row,
    current,
    {},
    true,
    'workable',
  );

  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].answer, hers);
  assert.equal(result.questions[0].answer_source, 'applicant_review');
  assert.equal(result.questions[0].id, 'her-question');
});

test('when no letter is stored and generation fails, the cover-letter field parks exactly as before', async () => {
  // No _cover_letter and no stored review, so generateStoredCoverLetter throws its
  // "missing something we need" error before touching any external service. The field must fall
  // through to the ordinary unanswered-required record: empty answer, required, never a crash.
  const row = {
    user_id: 'user-1',
    job_context: {},
    spec: {},
  } as ResumeRow;

  const result = await discoverAndResolveQuestions(
    [COVER_LETTER_TEXTAREA],
    row,
    coverLetterReviewState(),
    {},
    true,
    'workable',
  );

  assert.equal(result.questions.length, 1);
  const question = result.questions[0];
  assert.equal(question.question, 'Cover letter');
  assert.equal(question.answer, '');
  assert.equal(question.required, true);
  assert.equal(question.portal_selector, '#cover_letter');
  assert.equal(question.portal_input_type, 'textarea');
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
    /* R-096 widened: the refused question is minted even on an optional control, answerless, so
       she can answer it inside the product; `required` carries the employer's own marker so an
       optional blank never gates the send. */
    assert.equal(mixed.questions[0]?.answer, '');
    assert.equal(mixed.questions[0]?.required, false);
    /* Optional control: shown, never gating, since the optional-attention split. */
    assert.equal(mixed.attentionReasons.length, 0);
    assert.equal(mixed.optionalAttentionReasons.length, 1);
    assert.match(mixed.optionalAttentionReasons[0], /work-eligibility question left for you/i);
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
  assert.deepEqual(unasked.attentionReasons, []);
  assert.deepEqual(unasked.optionalAttentionReasons, [
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

test('a text input with combobox role is classified as a dropdown for every replay', () => {
  const portalInputType = discoveredControlInputType({ inputType: 'text', role: 'combobox' });
  assert.equal(portalInputType, 'combobox');
  assert.equal(discoveredControlInputType({
    inputType: 'text',
    role: null,
    options: ['January 2028 - July 2028', 'August 2028 - December 2028'],
  }), 'combobox');
  assert.equal(discoveredControlInputType({ inputType: 'text', role: null }), 'text');
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

  assert.deepEqual(result.attentionReasons, []);
  assert.deepEqual(result.optionalAttentionReasons, [
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

/* REGRESSION (2026-08-21): known-answer text values were typed with no field.maxLength check at
 * all, unlike the essay-drafter path a few lines below in this same file, which always calls
 * fitToBudget(answer, field.maxLength ?? 100_000) before pushing a question. gpaAnswer's
 * classification/percentage branch can produce a string like "3.89/4.00 (US 4.0 scale)" - about six
 * times the length of the bare "3.89" this path used to type - and a real control's own maxLength
 * would silently truncate that into a garbled, unreadable value with no attention flag raised. The
 * fix falls back to the bare stored GPA when the long form does not fit and the bare form does. */
test('a GPA answer that would overflow the control maxLength falls back to the bare number', async () => {
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
        // Long enough for the bare "3.89" (4 chars) but far too short for gpaAnswer's classification
        // string "3.89/4.00 (US 4.0 scale)" (24 chars).
        label: 'Degree classification',
        selector: '[data-litos-discovered-9]',
        inputType: 'text',
        maxLength: 10,
      },
    ],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { gpa: '3.89', gpa_scale: '4.0' },
    true,
    'greenhouse',
  );

  assert.deepEqual(result.attentionReasons, []);
  assert.equal(result.questions.length, 1);
  assert.equal(result.questions[0].answer, '3.89');
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
  /* The two optional attestations now arrive as ANSWERLESS records she can answer herself (R-096
     widened to optional controls); what must never re-enter is an answer, and none does. */
  for (const label of ['Candidate Privacy Notice', 'AI Policy for Interviewers']) {
    const minted = merged.find((question) => question.question === label);
    assert.ok(minted, label);
    assert.equal(minted!.answer, '');
    assert.equal(minted!.required, false);
  }
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

test('current applicant-reviewed test-score absence answers survive managed rediscovery', async () => {
  const reviewedAt = '2026-08-13T12:00:00.000Z';
  const stored = [
    {
      id: 'test-type',
      question: 'select your standardized test score type',
      answer: 'Other',
      options: ['SAT', 'ACT', 'Other'],
    },
    {
      id: 'sat-score',
      question: 'provide your best result on sat',
      answer: "I don't have SAT score",
      options: ["I don't have SAT score", '1200 - 1399', '1400 - 1600'],
    },
    {
      id: 'act-score',
      question: 'provide your best result on act',
      answer: "I don't have ACT score",
      options: ["I don't have ACT score", '30 - 32', '33 - 36'],
    },
  ];
  const current: ApplicationReviewState = {
    ...ANDURIL_REVIEW,
    questions_reviewed_at: reviewedAt,
    questions: stored.map(({ id, question, answer }) => ({
      id,
      question,
      answer,
      kind: 'required' as const,
      required: true,
      answer_source: 'applicant_review' as const,
      answer_reviewed_at: reviewedAt,
    })),
  };
  const result = await discoverAndResolveQuestions(
    stored.map(({ question, options }, index) => ({
      label: `${question}* question_${index + 1}`,
      selector: `#question_${index + 1}`,
      inputType: 'select',
      maxLength: null,
      options,
    })),
    { user_id: 'user-1' } as ResumeRow,
    current,
    {},
    true,
    'greenhouse',
  );

  assert.deepEqual(result.questions.map((question) => question.answer), [
    'Other',
    "I don't have SAT score",
    "I don't have ACT score",
  ]);
  assert.deepEqual(result.invalidatedQuestionKeys, []);
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

/* Jump Trading packet 2e593ac5, 2026-08-17 late. The reviewed answer "Spring/Summer 2028"
 * (answer_source applicant_review, verbatim on the employer's list) never reached the fill because
 * this merge dropped the stored question the moment the run's own option probe failed on its
 * control - and with the question gone from the packet, the only thing left to type was the
 * speculative ladder's profile-derived "May 2028".
 *
 * A failed probe means the list could not be READ this run. An answer she chose herself does not
 * need the list read, and the contract PR #566 set for every other reader is that her override
 * survives until she changes it. The stale-machine-answer drop above is untouched: it has no
 * applicant provenance, and restoring it really would replay a value nobody stands behind. */
test('a stored applicant-reviewed answer survives a failed option probe on its control', () => {
  const failedId = 'question_67595189';
  const stored = {
    id: 'jump-graduation',
    question: 'What is your expected graduation date?',
    answer: 'Spring/Summer 2028',
    kind: 'required' as const,
    required: true,
    portal_selector: `#${failedId}`,
    portal_input_type: 'combobox',
    answer_source: 'applicant_review' as const,
    answer_reviewed_at: '2026-08-17T20:00:00.000Z',
  };
  // The failed control's label key is deliberately absent from the invalidated list: the send path
  // filters probe-failure keys for applicant-reviewed questions before calling this merge, and
  // resolver-driven invalidation keys (which still drop her record so she re-confirms) cannot be
  // told apart from probe keys in here.
  const merged = mergeDiscoveredPortalQuestions(
    [],
    [stored],
    [],
    new Set([failedId]),
  );
  assert.equal(merged.length, 1, 'her reviewed answer must stay in the packet');
  assert.equal(merged[0]?.answer, 'Spring/Summer 2028');
  assert.equal(merged[0]?.answer_source, 'applicant_review');
});

/* The report and the fill must agree. A failed control covered by an applicant-chosen answer is
 * filled with that answer verbatim, so the attention sentence for it must not claim the field was
 * "left for you rather than answered with a guess": that sends her to hand-answer a filled field.
 * A failed control nobody answered keeps the original sentence unchanged. */
test('the attention sentence for a probe-failed control she answered says her answer was typed', () => {
  const failures = [
    { controlId: 'question_67595189', reason: 'windowed at the render cap' },
    { controlId: 'question_99', reason: 'windowed at the render cap' },
  ];
  const failedFields = [
    { controlId: 'question_67595189', label: 'What is your expected graduation date?' },
    { controlId: 'question_99', label: 'Which office are you applying to?' },
  ];
  const stored = [{
    question: 'What is your expected graduation date?',
    answer: 'Spring/Summer 2028',
    answer_source: 'applicant_review',
    portal_selector: '#question_67595189',
  }];
  const reasons = optionProbeAttentionReasons(failures, failedFields, stored);
  assert.match(reasons[0]!, /your reviewed answer was typed exactly as you wrote it/);
  assert.doesNotMatch(reasons[0]!, /left for you rather than answered with a guess/);
  assert.match(reasons[1]!, /left for you rather than answered with a guess/);
});

/* THE SENTENCE AND THE WALL MUST BE THE SAME JUDGEMENT. coveredOptionProbeFailureIds is the one
 * derivation both readers share: the sentence chooser above, and the `safe` term that decides
 * whether a probe failure parks the send. A covered failure's control was typed with her reviewed
 * answer verbatim by the same run, so it is an advisory, not a wall - measured on the Easy
 * Dynamics Rippling packet (2026-08-20), where the phone number's dial-code list read back
 * conflicting windows on every run, the number itself was typed, verified and recorded in
 * filled_fields, and the row re-parked on the same sentence forever. An uncovered failure is a
 * question knowingly left blank and must keep holding the send. */
test('a probe failure covered by her reviewed answer is excused from the wall, an uncovered one is not', () => {
  const failures = [
    { controlId: 'question_67595189', reason: 'conflicting option lists across bounded reads' },
    { controlId: 'question_99', reason: 'windowed at the render cap' },
  ];
  const failedFields = [
    { controlId: 'question_67595189', label: 'phone number*' },
    { controlId: 'question_99', label: 'Which office are you applying to?' },
  ];
  const stored = [{
    question: 'phone number',
    answer: '+1 213 574 6270',
    answer_source: 'applicant_review',
    portal_selector: '#question_67595189',
  }];
  const covered = coveredOptionProbeFailureIds(failures, failedFields, stored);
  assert.deepEqual([...covered], ['question_67595189']);
  // And it is the same judgement the sentences render, case for case.
  const reasons = optionProbeAttentionReasons(failures, failedFields, stored);
  assert.match(reasons[0]!, /your reviewed answer was typed exactly as you wrote it/);
  assert.match(reasons[1]!, /left for you rather than answered with a guess/);
  // Nobody answered anything: nothing is excused, every failure keeps its wall.
  assert.equal(coveredOptionProbeFailureIds(failures, failedFields, []).size, 0);
});

/* Provenance follows the ANSWER. Discovery replaces a reviewed answer with the resolver's value
 * whenever the profile knows one for the label, and the record spread used to carry
 * answer_source: 'applicant_review' onto that machine value. Every applicant-override reader,
 * including the failed-probe exemptions above, would then treat the machine value as a choice she
 * made, and on the next probe failure type it verbatim at a control nobody read. */
test('a machine value replacing a stale reviewed answer does not keep her provenance', async () => {
  const reviewedAt = '2026-08-10T00:00:00.000Z';
  const current: ApplicationReviewState = {
    jd_text: 'This internship is based in San Francisco, California.',
    role: 'Software Engineering Intern',
    portal_url: 'https://example.greenhouse.io/jobs/123',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions_reviewed_at: '2026-08-17T00:00:00.000Z',
    questions: [{
      id: 'wa',
      question: 'Are you legally authorized to work in the United States?',
      answer: 'No',
      kind: 'required',
      required: true,
      answer_source: 'applicant_review',
      answer_reviewed_at: reviewedAt,
    }],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };
  const result = await discoverAndResolveQuestions(
    [{
      label: 'Are you legally authorized to work in the United States?',
      selector: '[data-litos-discovered-1]',
      inputType: 'text',
      maxLength: null,
    }],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { work_authorized: true },
    true,
    'greenhouse',
  );
  assert.equal(result.questions[0]?.answer, 'Yes');
  assert.notEqual(result.questions[0]?.answer_source, 'applicant_review',
    'a machine value must not wear applicant provenance');
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

/* THE SAME MEASUREMENT, READ FOR WHICH DOCUMENT RATHER THAN HOW MANY.
 *
 * unansweredRequiredBlockerLabels answers "how much of this form did we leave her no way to
 * complete", which is honest and entirely unactionable. measuredRequiredDocuments answers "which of
 * those is a file she can actually hand over", which is the one the dashboard can draw a control
 * off. The DRW blocker above is the corpus example of a line that is both. */

test('the DRW transcript blocker is read as a transcript ask, and its neighbours are not', () => {
  const blockers = [
    '"Discipline" is required and is still empty',
    '"LinkedIn Profile" is required and is still empty',
    '"Please provide a copy of your most recent transcript from your highest degree level." is required and is still empty',
  ];
  const unanswered = unansweredRequiredBlockerLabels(blockers, []);
  assert.equal(unanswered.length, 3, 'all three are unanswerable; only one of them is a document');

  assert.deepEqual(measuredRequiredDocuments(unanswered, []), [{
    label: 'Please provide a copy of your most recent transcript from your highest degree level.',
    kind: 'transcript',
    official_requested: false,
  }]);
});

test('a required file question is the second source, and the union is one row', () => {
  /* NOTHING PRODUCES THIS INPUT TODAY, on either runner. The direct-Playwright walk enumerates
     text, email, tel, url, number, date, untyped, textarea, select, radio and checkbox
     (lib/questionDiscovery.ts:4195) and no file input, and stratus's managed discover scan is built
     the same way. So the blocker sentence is currently the only live source, and this half is
     forward-compatible rather than reachable. Tested anyway: it is the behaviour that has to be
     right on the day either walk is widened, and until then nothing exercises it. */
  const questions = [
    { question: 'Unofficial transcript', required: true, portal_input_type: 'file' },
    { question: 'Resume', required: true, portal_input_type: 'file' },
    // Not required, and required but not a file. Neither is an ask.
    { question: 'Optional transcript', required: false, portal_input_type: 'file' },
    { question: 'Tell us about a transcript you enjoyed', required: true, portal_input_type: 'textarea' },
  ];
  assert.deepEqual(measuredRequiredDocuments([], questions), [
    { label: 'Unofficial transcript', kind: 'transcript', official_requested: false },
  ]);

  // Union'd with the blocker source, and still one row: it is one file the employer wants.
  assert.deepEqual(measuredRequiredDocuments(['Official transcript'], questions), [
    { label: 'Official transcript', kind: 'transcript', official_requested: true },
  ]);
});

test('a form that asks for no document measures an empty array, not an absent field', () => {
  // The distinction the dashboard depends on: undefined means no prepare on this build has looked,
  // and must not be read as "nothing is owed".
  assert.deepEqual(measuredRequiredDocuments(['First Name', 'LinkedIn Profile'], []), []);
});

/* BOTH PREPARE PATHS WRITE IT, and that is the entire point of the change.
 *
 * The direct-Playwright path never computed this measurement at all: the second argument to
 * discoveryHonestyReasons was a hard-coded empty array and nothing else there made the comparison.
 * Measured on one runner only, the "your turn" row fires on managed portals and is silently absent
 * on the rest of them, which from the dashboard is indistinguishable from the feature not working.
 *
 * Asserted against the source for the same reason as the budget gate above: both prepare functions
 * need a remote runner, a database and blob storage, so the wiring is what can be pinned here. */
test('required_documents is written by both prepare paths, off both blocker sources', () => {
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');

  assert.equal(
    [...runner.matchAll(/^\s+required_documents: requiredDocuments,$/gm)].length,
    2,
    'one write per prepare path: prepareManaged and the direct-Playwright prepare',
  );
  assert.equal(
    [...runner.matchAll(/measuredRequiredDocuments\(unansweredRequired, mergedQuestions\)/g)].length,
    2,
    'and each one computes it from that path\'s own required-and-empty blockers',
  );
  // The direct path measures against its sanitized blockers, which is the same array its own
  // attention_reason is built from. Reading result.blockers raw there would let a provider's UUID
  // label through into a stored document ask.
  assert.match(runner, /unansweredRequiredBlockerLabels\(sanitizedBlockers, mergedQuestions\)/);
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
  /* AND IT IS NOT A WHOLE-FORM FAILURE. A per-control option read that failed used to be pushed into
   * discoveryFailures, which is this run-level array, so one unreadable control made the packet say
   * Litos could not read ANY of the form's questions and sent every correctly read control on the
   * same page back to a blind alias ladder. Measured on IMC packet 920a6751. The failure still holds
   * the send and still reaches her; it now names only the control it happened to. */
  assert.doesNotMatch(runner, /discoveryFailures\.push\(\s*\n?\s*`closed-control option discovery failed/);
  assert.doesNotMatch(runner, /closed-control option discovery failed:/);
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
  // The per-control failure keeps both halves of that same contract at its own scope: it reaches her
  // attention list, and it holds the send off the failure ARRAY rather than off the rendered prose.
  // The wall reads the UNCOVERED failures: one whose control her reviewed answer already typed is
  // an advisory, not a hold - see coveredOptionProbeFailureIds and the covered-excusal test above.
  assert.match(runner, /\.\.\.optionProbeAttention,/);
  assert.match(runner, /&& uncoveredProbeFailures\.length === 0/);
  assert.match(runner, /coveredOptionProbeFailureIds\(optionProbe\.failures, failedFields, storedQuestions\)/);
});

/* THE IMC FIXTURE. Packet 920a6751, read off the live form on 2026-08-11.
 *
 * Two closed controls on one Greenhouse page. `question_9177934101` renders more choices than the
 * option probe's window, so its list genuinely cannot be read. `question_9176667101` beside it reads
 * perfectly, and resolves to the employer's own wording, "January 2028 - July 2028".
 *
 * WHAT THE CHANGE UNDER TEST DOES, STATED NARROWLY. The failed control used to be promoted into
 * `discoveryFailures`, the run-level honesty gate, so the packet told her Litos could not read the
 * questions this form asks AT ALL. It had read all but one of them. The fix scopes that sentence to
 * the control it belongs to.
 *
 * WHAT IT DOES NOT DO, stated because the first version of this comment claimed otherwise: it does
 * not change any answer. `discoveryFailures` is read only after resolution and the merge have run,
 * and neither takes it as an argument, so the resolved answer below is identical on both branches.
 * The assertions on the merged answer are fixture invariants, not evidence of a fix. The assertions
 * that discriminate are the ones on the attention reasons, and the source-level pins above.
 *
 * This walks the real chain prepareManaged walks, minus the browser: probe analysis, option
 * attachment, the failed-control filter, resolution, the question merge, and the action list. */
const IMC_UNREADABLE_ID = 'question_9177934101';
const IMC_GRADUATION_ID = 'question_9176667101';
const IMC_GRADUATION_OPTIONS = [
  'July 2027 - December 2027',
  'January 2028 - July 2028',
  'August 2028 - December 2028',
];

function imcOptionProbe() {
  const discovered = [
    {
      label: 'Which of the following best describes you?*',
      selector: `#${IMC_UNREADABLE_ID}`,
      inputType: 'text',
      role: 'combobox',
      required: true,
    },
    {
      label: 'Expected graduation date*',
      selector: `#${IMC_GRADUATION_ID}`,
      inputType: 'text',
      role: 'combobox',
      required: true,
    },
  ];
  // 100 rows is the render cap the live control was windowed at. Both reads agree, so this is not a
  // conflicting-list failure: the list is simply longer than the probe can prove it saw the end of.
  const windowed = Array.from({ length: 100 }, (_, index) => `Choice ${index}`).join('\n');
  const analysis = managedOptionProbeAnalysis('greenhouse', discovered, {}, [{
    title: '', url: '', text: '',
    extracted: [
      { selector: `[id="${IMC_UNREADABLE_ID}"]:is([role="combobox"],[aria-haspopup="listbox"])`, value: IMC_UNREADABLE_ID },
      { selector: reactSelectListboxSelector(IMC_UNREADABLE_ID), value: windowed },
      { selector: reactSelectListboxSelector(IMC_UNREADABLE_ID), value: windowed },
      { selector: `[id="${IMC_GRADUATION_ID}"]:is([role="combobox"],[aria-haspopup="listbox"])`, value: IMC_GRADUATION_ID },
      { selector: reactSelectListboxSelector(IMC_GRADUATION_ID), value: IMC_GRADUATION_OPTIONS.join('\n') },
      { selector: reactSelectListboxSelector(IMC_GRADUATION_ID), value: IMC_GRADUATION_OPTIONS.join('\n') },
    ],
  }], [], true);
  const failedFields = discovered.flatMap((field) => {
    const controlId = field.selector.slice(1);
    if (!analysis.failedIds.has(controlId)) return [];
    return [{ controlId, label: field.label, selector: field.selector, inputType: field.inputType }];
  });
  const kept = attachManagedFieldOptions(discovered, analysis.options)
    .filter((field) => !analysis.failedIds.has((field.selector ?? '').slice(1)));
  return { discovered, analysis, failedFields, kept };
}

test('one control that could not be read does not silence the questions that read fine', async () => {
  const { analysis, failedFields, kept } = imcOptionProbe();

  // The read failure is real and belongs to exactly one control.
  assert.deepEqual(analysis.failures.map((failure) => failure.controlId), [IMC_UNREADABLE_ID]);
  assert.match(analysis.failures[0]!.reason, /windowed at the render cap/);
  assert.deepEqual(analysis.options[IMC_GRADUATION_ID], IMC_GRADUATION_OPTIONS);

  // It is NOT a whole-form discovery failure. The sentence that says the form could not be read at
  // all is discoveryHonestyReasons' first reason, and nothing here may produce it.
  const reasons = optionProbeAttentionReasons(analysis.failures, failedFields);
  assert.equal(reasons.length, 1);
  assert.doesNotMatch(reasons[0]!, /could not read the questions this form asks/);
  assert.deepEqual(discoveryHonestyReasons(undefined, []), []);

  // ...and it names the control it happened to, and only that one.
  assert.match(reasons[0]!, /Which of the following best describes you\?\*/);
  assert.doesNotMatch(reasons[0]!, /Expected graduation date/);
  assert.match(reasons[0]!, /windowed at the render cap/);

  // The control that read fine keeps its options and resolves against them. FIXTURE INVARIANT, not
  // a result of this change: it holds identically at unmodified main, because resolution never sees
  // discoveryFailures. It is here to pin the input the assertions below are read against.
  assert.deepEqual(kept.map((field) => field.selector), [`#${IMC_GRADUATION_ID}`]);
  const resolved = await discoverAndResolveQuestions(
    kept.map((field) => ({ ...field, maxLength: null })),
    { user_id: 'user-1' } as ResumeRow,
    {
      jd_text: 'IMC Trading quantitative trader internship.',
      role: 'Quantitative Trader Intern',
      portal_url: 'https://job-boards.greenhouse.io/imc/jobs/1',
      ats_name: 'greenhouse',
      status: 'ready_to_submit',
      edited_terms: [],
      questions: [],
      skipped_reasons: [],
      updated_at: new Date().toISOString(),
    },
    { grad_date: 'May 2028', grad_year: 2028 },
    true,
    'greenhouse',
  );
  const merged = mergeDiscoveredPortalQuestions(resolved.questions, [], [], analysis.failedIds);
  const graduation = merged.find((question) => question.portal_selector === `#${IMC_GRADUATION_ID}`);
  // Same again: true on both branches. The resolved answer is the employer's own wording.
  assert.equal(graduation?.answer, 'January 2028 - July 2028');
  /* And the record says WHAT IT WAS SNAPPED FROM, which is the fact that makes it usable later.
   *
   * Without this the answer above is a string with no provenance, and the submit run's refresh has
   * no way to tell it from a record written a year ago. See refreshKnownQuestionAnswers. */
  assert.equal(graduation?.answer_option_source, 'May 2028',
    'the profile value the option was chosen for is recorded beside it');

  // And it reaches the action list, while the unreadable control reaches nothing. The mapping below
  // is buildPacket's, field for field, because a packet built any other way is not the packet the
  // run fills from.
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    graduationMonth: 'May',
    graduationYear: '2028',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    fieldOptions: analysis.options,
    failedFields,
    questions: merged.map((question) => ({
      question: question.question,
      answer: question.answer,
      portalSelector: question.portal_selector,
      portalInputType: 'combobox',
      answerOptionSource: question.answer_option_source,
    })),
  } as Parameters<typeof buildManagedPortalActions>[1]);
  assert.equal(actions.some((action) => action.selector?.includes(IMC_UNREADABLE_ID)), false);

  /* THE VALUE, NOT JUST THE SELECTOR. THIS PIN USED TO RECORD AN OPEN DEFECT, AND NOW RECORDS ITS FIX.
   *
   * An earlier version of this test asserted only that SOME action reached this selector, which is
   * true and useless: it passes while the fill carries anything at all. It was then pinned to the
   * value that really landed, "Spring 2028", with a note that the pin SHOULD fail once the ordering
   * defect was fixed. It did, and this is the flip.
   *
   * Two things produced the old value, both now repaired in portalSubmission.ts:
   *
   *   greenhouseReviewedQuestionAnswer   replaced a graduation-date question's resolved answer with
   *                                      the raw profile value, "May 2028", unconditionally. It now
   *                                      keeps an answer that came off the control's own option
   *                                      list, and still overrides a stale record with the profile.
   *   greenhouseComboboxValuesForQuestion unshifted greenhouseGraduationBucket ahead of everything.
   *                                      A computed bucket now ranks BEHIND such an answer and still
   *                                      ahead of everything else, so with comboboxValueLimit at 1
   *                                      the one attempt is the option the resolver read off this
   *                                      control.
   *
   * ONE fill, and it carries the resolved answer. The count matters as much as the value: the limit
   * is still 1 on purpose (see comboboxValueLimit), because a second candidate would reopen a
   * correctly committed react-select and click option-0 of whatever menu it found. */
  const graduationFills = actions.filter((action) =>
    (action.selector === `#${IMC_GRADUATION_ID}` && action.type === 'fill')
    || (action.type === 'fillByLabelText' && action.label?.startsWith('question:') && action.text === graduation?.question));
  assert.deepEqual(graduationFills.map((action) => action.value), ['January 2028 - July 2028'],
    'the control is attempted with its resolved answer');
  assert.equal(graduationFills.every((action) => action.value === graduation?.answer), true,
    'the resolved answer is the value that reaches the form');
  assert.equal(graduationFills.some((action) => action.value === 'Spring 2028'), false,
    'the computed bucket does not reach the form when a resolved answer exists');
});

/* WHAT THE EMPLOYER ACTUALLY RECEIVES, WHICH IS NOT WHAT THE PREVIEW WAS BUILT FROM.
 *
 * Every test above this point builds the packet the PREPARE run builds, straight off the merged
 * questions. That is not the packet that fills the employer's form. The managed runner is stateless
 * and one-shot: prepare produces the preview screenshot, and the SUBMIT run calls buildPacket again,
 * which passes review.questions through refreshKnownQuestionAnswers before mapping them onto the
 * packet. A fix that only survives the prepare path reaches nobody.
 *
 * It is worse than that. Before answer_option_source existed, refresh recomputed the answer from the
 * profile and destroyed the band, so prepare showed "January 2028 - July 2028" and submit sent
 * "Spring 2028". A preview that does not match what is sent is the one outcome this product cannot
 * ship, and a prepare-only test is exactly what would let it through.
 *
 * submitRunFills therefore runs buildPacket's chain, refresh then map then build, and the mapping is
 * buildPacket's own field for field. buildPacket itself reads the database and object storage and
 * cannot be executed here; the source-level pin below holds this composition to it. */
const GPA_ID = 'question_9176667102';

const SUBMIT_RUN_PROFILE = {
  fullName: 'Mehek Mandal',
  email: 'mehekmandal05@gmail.com',
  school: 'University of Southern California',
  degree: 'Bachelor of Science in Computer Science',
  graduationMonth: 'May',
  graduationYear: '2028',
  resume: Buffer.from('pdf'),
  resumeName: 'resume.pdf',
};

function submitRunFills(input: {
  label: string;
  selector: string;
  storedAnswer: string;
  /** The question record's answer_option_source: the profile value the option was chosen for. */
  derivedFrom?: string;
  /** What the profile says NOW. Differs from derivedFrom exactly when the record is stale. */
  graduationDate?: string;
  gpa?: string;
}): Array<string | undefined> {
  const refreshed = refreshKnownQuestionAnswers(
    [{
      question: input.label,
      answer: input.storedAnswer,
      answer_option_source: input.derivedFrom,
    } as Parameters<typeof refreshKnownQuestionAnswers>[0][number]],
    { grad_date: input.graduationDate, grad_year: 2028, gpa: input.gpa } as ApplicationProfileLike,
    undefined,
  );
  const actions = buildManagedPortalActions('greenhouse', {
    ...SUBMIT_RUN_PROFILE,
    graduationDate: input.graduationDate,
    gpa: input.gpa,
    questions: refreshed.map((question) => ({
      question: question.question,
      answer: question.answer,
      portalSelector: input.selector,
      portalInputType: 'combobox',
      answerOptionSource: (question as { answer_option_source?: string }).answer_option_source,
    })),
  } as Parameters<typeof buildManagedPortalActions>[1]);
  return actions
    .filter((action) => (action.selector === input.selector && action.type === 'fill')
      || (action.type === 'fillByLabelText' && action.label?.startsWith('question:') && action.text === input.label))
    .map((action) => action.value);
}

function graduationSubmitFills(storedAnswer: string, derivedFrom?: string): Array<string | undefined> {
  return submitRunFills({
    label: 'Expected graduation date',
    selector: `#${IMC_GRADUATION_ID}`,
    storedAnswer,
    derivedFrom,
    graduationDate: 'May 2028',
  });
}

test('the resolved option survives the submit run\'s refresh and reaches the employer', () => {
  // The IMC case, through the chain that actually fills the form.
  assert.deepEqual(graduationSubmitFills('January 2028 - July 2028', 'May 2028'),
    ['January 2028 - July 2028'],
    'the option the resolver read off this control is what the submit run sends');

  // The same for GPA, whose bucket is a different function reached by a different branch.
  assert.deepEqual(submitRunFills({
    label: 'What is your GPA?',
    selector: `#${GPA_ID}`,
    storedAnswer: '3.81 - 3.9',
    derivedFrom: '3.89',
    gpa: '3.89',
  }), ['3.81 - 3.9'], 'the employer\'s own GPA band survives the refresh');
});

/* A STALE BAND IS STILL STALE, and shape alone cannot tell you that.
 *
 * "January 2027 - July 2027" is as well-formed an option text as "January 2028 - July 2028". It is
 * also a graduation window a year early, and once the applicant corrects her graduation to May 2028
 * nothing about the string itself says so. The profile has to win, and the only fact that makes that
 * decidable is the derivation recorded when the option was chosen.
 *
 * This is the case that a band-shape test on its own gets wrong, and it is the reason
 * answer_option_source exists rather than the shape being trusted by itself. */
test('a band-shaped stale record loses to a profile that has moved', () => {
  /* THE FILL LAYER FIRST, ON ITS OWN, because that is where this can actually be observed.
   *
   * Through the submit chain the refresh gets there first and overwrites a stale band before any
   * fill is built, so a submit-only test cannot tell a fill layer that refuses stale bands from one
   * that would happily send them. The PREPARE path takes no refresh at all: it builds actions
   * straight off the merged questions, and it is what renders the preview the applicant approves.
   * So the refusal has to hold here too, and be tested here. */
  const prepareFills = (storedAnswer: string, answerOptionSource?: string) => buildManagedPortalActions(
    'greenhouse',
    {
      ...SUBMIT_RUN_PROFILE,
      graduationDate: 'May 2028',
      questions: [{
        question: 'Expected graduation date',
        answer: storedAnswer,
        portalSelector: `#${IMC_GRADUATION_ID}`,
        portalInputType: 'combobox',
        answerOptionSource,
      }],
    } as Parameters<typeof buildManagedPortalActions>[1],
  )
    .filter((action) => (action.selector === `#${IMC_GRADUATION_ID}` && action.type === 'fill')
      || (action.type === 'fillByLabelText' && action.label?.startsWith('question:') && action.text === 'Expected graduation date'))
    .map((action) => action.value);

  assert.deepEqual(prepareFills('January 2027 - July 2027', 'May 2027'), ['Spring 2028'],
    'the preview must not show a graduation window a year early either');
  assert.deepEqual(prepareFills('January 2027 - July 2027'), ['Spring 2028'],
    'a stale band with no derivation is refused at the fill layer');
  assert.deepEqual(prepareFills('January 2028 - July 2028', 'May 2028'), ['January 2028 - July 2028'],
    'and a current one is still preferred, so this is a staleness test and not a blanket refusal');

  // Recorded against "May 2027"; the profile now says "May 2028". The record is stale.
  assert.deepEqual(graduationSubmitFills('January 2027 - July 2027', 'May 2027'), ['Spring 2028'],
    'a window a year early must not reach the employer');

  // No derivation recorded at all, which is every record written before this field existed, and
  // every free-text answer that merely happens to be band-shaped. Unprovable means recompute.
  assert.deepEqual(graduationSubmitFills('January 2027 - July 2027'), ['Spring 2028'],
    'a band with no recorded derivation cannot prove it is current');
  assert.deepEqual(graduationSubmitFills('Sept 2024 to May 2028'), ['Spring 2028'],
    'free text that reads as a band is not an option the resolver chose');

  // And the derivation is not a rubber stamp: it has to match the profile, not merely exist.
  assert.deepEqual(graduationSubmitFills('January 2028 - July 2028', 'December 2029'), ['Spring 2028'],
    'a derivation the profile no longer agrees with is stale too');
});

/* THE FALLBACK IS INTACT, which is the half of this that is easy to break while fixing the other.
 *
 * The bucket is not wrong, it is second. It maps a profile fact onto one employer's vocabulary, and
 * that is still the best available guess when nothing has been read off the control to prefer over
 * it. All of these must still send a bucket: the R-096 placeholder, where a required control the
 * applicant has not answered carries a BLANK stored answer; the unprobed control, where the stored
 * answer is the profile date itself; and the ordinary stale record.
 *
 * Same control, same profile, four stored answers. Nothing else varies. */
test('a graduation combobox with no resolved answer still leads with the computed bucket', () => {
  // Nothing stored at all: the profile date is substituted in and bucketed, exactly as before.
  assert.deepEqual(graduationSubmitFills(''), ['Spring 2028'],
    'the R-096 placeholder still reaches the form as a bucket');

  // Stored, but only the profile fact itself, which is what an unprobed control leaves behind. No
  // option list was ever consulted, so the bucket is still the better guess and still leads.
  assert.deepEqual(graduationSubmitFills('May 2028'), ['Spring 2028'],
    'a stored answer identical to the profile date is not evidence of snapping');

  // A stale record from an earlier run, naming a year the profile has since corrected.
  assert.deepEqual(graduationSubmitFills('May 2027'), ['Spring 2028'],
    'a stale stored date is still overridden by the profile');

  // And the resolved case, read against the three above rather than on its own.
  assert.deepEqual(graduationSubmitFills('January 2028 - July 2028', 'May 2028'),
    ['January 2028 - July 2028'], 'a current resolved option is the one value attempted');
});

/* THE SAME SET FOR GPA, because it is the same defect on a different control.
 *
 * The IMC run of 2026-08-11 carried a resolved "3.81 - 3.9" and sent "3.6 or above (out of 4.0)".
 * greenhouseGpaBucket is a different function from greenhouseGraduationBucket and is unshifted by a
 * different branch, so fixing one says nothing about the other. */
test('a GPA combobox prefers its resolved answer and keeps the bucket as the fallback', () => {
  const gpaFills = (storedAnswer: string, derivedFrom?: string) => submitRunFills({
    label: 'What is your GPA?', selector: `#${GPA_ID}`, storedAnswer, derivedFrom, gpa: '3.89',
  });

  // The unprobed control: the stored answer is a bare GPA, which is what the profile holds and what
  // the resolver stores when it has no option list to snap onto.
  assert.deepEqual(gpaFills('3.89'), ['3.6 or above (out of 4.0)'], 'a bare stored GPA is still bucketed');

  // A band recorded against a GPA she has since raised. The profile wins.
  assert.deepEqual(gpaFills('3.4 - 3.5', '3.45'), ['3.6 or above (out of 4.0)'],
    'a GPA band derived from a superseded GPA is stale');

  // The probed and current control: "3.81 - 3.9" is one of the employer's own option texts, and it
  // is what the live IMC application resolved to while "3.6 or above (out of 4.0)" went out.
  const resolved = gpaFills('3.81 - 3.9', '3.89');
  assert.deepEqual(resolved, ['3.81 - 3.9'],
    'the bucket the employer really offers, not the one this codebase computes');
  assert.equal(resolved.includes('3.6 or above (out of 4.0)'), false,
    'the computed GPA bucket does not reach the form when a current resolved answer exists');
});

/* A DERIVATION NEVER OUTLIVES THE ANSWER IT DESCRIBES.
 *
 * The refresh has two outcomes, and only one of them keeps the stored answer. When it recomputes,
 * the recorded derivation described a value that is no longer there, and leaving it attached would
 * claim a snap that never happened for the value now in the record. The next reader has no way to
 * detect that from the record alone, which is precisely the failure mode this field was added to
 * remove, so it is dropped with the answer it belonged to. */
test('the recorded option derivation is dropped whenever the answer is recomputed', () => {
  const refresh = (answer: string, source: string) => refreshKnownQuestionAnswers(
    [{ question: 'Expected graduation date', answer, answer_option_source: source } as
      Parameters<typeof refreshKnownQuestionAnswers>[0][number]],
    { grad_date: 'May 2028', grad_year: 2028 } as ApplicationProfileLike,
    undefined,
  )[0] as { answer: string; answer_option_source?: string };

  const recomputed = refresh('January 2027 - July 2027', 'May 2027');
  assert.equal(recomputed.answer, 'May 2028', 'the stale band is recomputed from the profile');
  assert.equal(recomputed.answer_option_source, undefined,
    'and its derivation does not survive to describe a value it never described');

  const kept = refresh('January 2028 - July 2028', 'May 2028');
  assert.equal(kept.answer, 'January 2028 - July 2028');
  assert.equal(kept.answer_option_source, 'May 2028',
    'the branch that keeps the answer keeps the derivation, or the next refresh cannot check it');
});

/* THE COMPOSITION ABOVE IS buildPacket'S, and this is what holds it there.
 *
 * submitRunFills cannot call buildPacket: it reads users, the application profile, the parsed resume
 * and the resume object. So the test asserts the shape of the chain instead, against the real source.
 * If buildPacket ever stops refreshing, or stops carrying the derivation onto the packet, the tests
 * above would keep passing against a composition production no longer performs. */
test('buildPacket refreshes stored answers and carries the option derivation onto the packet', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const buildStart = source.indexOf('export async function buildPacket(');
  const buildEnd = source.indexOf('\nexport function readMostRecentRole', buildStart);
  assert.ok(buildStart > 0 && buildEnd > buildStart);
  const buildBody = source.slice(buildStart, buildEnd);
  assert.match(buildBody, /const refreshedQuestions = refreshKnownQuestionAnswers\(/,
    'the submit run resolves stored answers again before filling');
  assert.match(
    buildBody,
    /questions: refreshedQuestions\.map\(\(item\) => \(\{[\s\S]{0,600}?answerOptionSource: item\.answer_option_source,/,
    'the derivation has to reach the packet, or the fill cannot tell a read option from a profile value',
  );
});

test('managed discovery keeps option provenance on the packet used by the real fill', () => {
  const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
  const prepareStart = source.indexOf('async function prepareManaged(');
  const prepareEnd = source.indexOf('\nasync function prepareControlled', prepareStart);
  assert.ok(prepareStart > 0 && prepareEnd > prepareStart);
  const prepareBody = source.slice(prepareStart, prepareEnd);
  assert.match(
    prepareBody,
    /packet\.questions = mergedQuestions\.map\(\(q\) => \(\{[\s\S]{0,1200}?answerOptionSource: q\.answer_option_source,/,
    'the discovery-to-fill rebuild must not strip the measured option before the action builder sees it',
  );
  const mapping = prepareBody.match(/packet\.questions = mergedQuestions\.map\(\(q\) => \(\{[\s\S]*?\}\)\);/)?.[0] ?? '';
  assert.ok(
    mapping.indexOf('answerOptionSource: q.answer_option_source')
      < prepareBody.indexOf('const fillActions = buildManagedPortalActions(portal, packet)'),
    'option provenance must be restored before the production fill actions are built',
  );
});

/* THE HONESTY THE OLD CODE WAS PROTECTING, kept at the scope it belongs to.
 *
 * Narrowing a run-level admission to a per-control one is only safe while the per-control refusal is
 * absolute: a control whose choices Litos could not read must be left alone, not filled with the
 * closest-looking guess, and she must be told. Without this the change would trade a lie about
 * twelve controls for a silent wrong answer on one, which is the worse of the two. */
test('a control whose options could not be read is never silently given an answer', () => {
  const { analysis, failedFields } = imcOptionProbe();
  assert.equal(analysis.options[IMC_UNREADABLE_ID], undefined, 'a windowed read is not an option list');

  // A stale stored answer for the same control cannot resurrect a fill for it either.
  const actions = buildManagedPortalActions('greenhouse', {
    fullName: 'Mehek Mandal',
    email: 'mehekmandal05@gmail.com',
    phone: '+971501234567',
    school: 'University of Southern California',
    degree: 'Bachelor of Science in Computer Science',
    graduationDate: 'May 2028',
    gpa: '3.89',
    resume: Buffer.from('pdf'),
    resumeName: 'resume.pdf',
    failedFields,
    questions: [{
      question: 'Which of the following best describes you?',
      answer: 'Undergraduate student',
      portalSelector: `#${IMC_UNREADABLE_ID}`,
      portalInputType: 'combobox',
    }],
  } as Parameters<typeof buildManagedPortalActions>[1]);
  assert.equal(actions.some((action) => action.selector?.includes(IMC_UNREADABLE_ID)), false);
  assert.equal(actions.some((action) => action.value === 'Undergraduate student'), false);

  // Silence is not permitted either: the run owes her a sentence naming the control.
  assert.equal(optionProbeAttentionReasons(analysis.failures, failedFields).length, 1);
  // A control discovery reported without a usable label is still named, by its durable id, rather
  // than producing a sentence about nothing.
  const unlabelled = optionProbeAttentionReasons(analysis.failures, []);
  assert.equal(unlabelled.length, 1);
  assert.match(unlabelled[0]!, new RegExp(IMC_UNREADABLE_ID));
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

test('packetQuestionsForFill carries her provenance through to the fill', () => {
  /* The defect this pins: the map that builds packet.questions immediately before fillPortal listed
   * question / answer / portalSelector / portalInputType and NOT answer_source, so applicantChoseAnswer
   * was false for every question on that path and #573, #574 and #577 were all inert. Measured live on
   * DV Trading e0a0eb84, 2026-08-18: packet said "Other" with answer_source applicant_review, the run
   * typed the referral default and reported `no option matched "Job board"`. */
  const [referral, plain] = packetQuestionsForFill([
    {
      question: 'How did you hear about DV Trading?',
      answer: 'Other',
      answer_source: 'applicant_review',
      portal_selector: '#question_17808234008',
      portal_input_type: 'combobox',
    },
    { question: 'Will you require sponsorship?', answer: 'Yes' },
  ]);

  assert.equal(referral.answerSource, 'applicant_review', 'her choice must reach the fill as HER choice');
  assert.equal(referral.answer, 'Other');
  assert.equal(referral.portalSelector, '#question_17808234008');
  assert.equal(referral.portalInputType, 'combobox');
  // An answer nobody reviewed stays unattributed. The bug was a dropped field, not a missing default.
  assert.equal(plain.answerSource, undefined);
  assert.equal(plain.answer, 'Yes');
});

test('an applicant-reviewed answer beats a freshly discovered one', () => {
  /* DV Trading e0a0eb84, 2026-08-18, measured live: "Other" saved and read back as
   * applicant_review, then the fill ran and the persisted row was "Job board" with no
   * answer_source, and the run reported `no option matched "Job board"`. Discovery resolves that
   * label every run, and normalizeApplicationReviewQuestions is first-wins, so spreading
   * ...discovered first meant her choice lost every time. */
  const label = 'How did you hear about DV Trading?';
  const merged = mergeDiscoveredPortalQuestions(
    [{ question: label, answer: 'Job board', required: true, portal_selector: '#question_8969957005', portal_input_type: 'combobox' } as any],
    [{ question: label, answer: 'Other', answer_source: 'applicant_review', required: true } as any],
    [],
  );
  const row = merged.find((q) => /hear about/i.test(q.question));
  assert.ok(row, 'the referral question must survive the merge');
  assert.equal(row!.answer, 'Other', 'her reviewed answer wins the collision');
  assert.equal(row!.answer_source, 'applicant_review', 'and keeps its provenance');
  // The live selector still has to reach the fill, or the winning answer has no control to land on.
  assert.equal(row!.portal_selector, '#question_8969957005');
  assert.equal(row!.portal_input_type, 'combobox');
});

test('a stored machine answer still loses to a freshly discovered one', () => {
  // Only an answer SHE reviewed is privileged. An unattributed stored value is exactly what
  // discovery exists to correct, and this is the half that must not change.
  const label = 'How did you hear about DV Trading?';
  const merged = mergeDiscoveredPortalQuestions(
    [{ question: label, answer: 'Job board', required: true } as any],
    [{ question: label, answer: 'Stale value', required: true } as any],
    [],
  );
  assert.equal(merged.find((q) => /hear about/i.test(q.question))!.answer, 'Job board');
});

test('a discovered answer still fills a blank applicant-reviewed row', () => {
  const label = 'How did you hear about DV Trading?';
  const merged = mergeDiscoveredPortalQuestions(
    [{ question: label, answer: 'Job board', required: true } as any],
    [{ question: label, answer: '   ', answer_source: 'applicant_review', required: true } as any],
    [],
  );
  assert.equal(merged.find((q) => /hear about/i.test(q.question))!.answer, 'Job board');
});

/* The other half of the Teamtailor default-consent fix, measured live 2026-08-20 (Fully, Uproar by
 * Moburst): the managed discovery pass reports the stock candidate[consent_given] checkbox with
 * the platform's own sentence as its label, and the packet must come out of resolution carrying
 * the machine acceptance with its provenance, because managedConsentTickPlan refuses any record
 * whose answerSource is not consent_permission. Before the grammar knew "personal details" and
 * the "to be able to" clause, this produced no consent question at all and every send parked. */
test("Teamtailor's default consent checkbox becomes the consent_permission question on the packet", async () => {
  const sentence = 'By submitting this application, I agree that I have read the Privacy Policy and confirm that Fully store my personal details to be able to process my job application.';
  const current: ApplicationReviewState = {
    jd_text: 'Own the books. Ship the close.',
    role: 'Group Financial Controller',
    portal_url: 'https://career.teamtailor.com/jobs/8124573-group-financial-controller',
    ats_name: 'teamtailor',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const resolve = (ap: ApplicationProfileLike) => discoverAndResolveQuestions(
    [
      {
        label: sentence,
        selector: '[data-litos-discovered-1]',
        durableSelector: 'input[name="candidate[consent_given]"]',
        inputType: 'checkbox',
        maxLength: null,
        required: true,
      },
    ],
    { user_id: 'user-1', job_context: { company: 'Fully' } } as ResumeRow,
    current,
    ap,
    true,
    'teamtailor',
  );

  const granted = await resolve({
    consent_acknowledgement_permission: { granted_at: '2026-08-12T09:15:00.000Z', version: '2026-08-12' },
  });
  assert.equal(granted.questions.length, 1);
  const question = granted.questions[0];
  assert.equal(question.question, sentence);
  assert.equal(question.answer, 'Yes');
  assert.equal(question.answer_source, 'consent_permission');
  assert.equal(question.consent_permission_version, 'privacy_and_terms@2026-08-12');
  assert.equal(question.consent_permission_granted_at, '2026-08-12T09:15:00.000Z');
  assert.equal(question.portal_selector, 'input[name="candidate[consent_given]"]');
  assert.equal(question.portal_input_type, 'checkbox');
  assert.deepEqual(granted.attentionReasons, []);

  // No grant means main's behaviour: the required checkbox surfaces as HER question, unanswered,
  // never as a machine acceptance.
  const ungranted = await resolve({});
  assert.equal(ungranted.questions.length, 1);
  assert.equal(ungranted.questions[0].answer, '');
  assert.notEqual(ungranted.questions[0].answer_source, 'consent_permission');
});

/* The Breezy mirror of the Teamtailor test above, on the label the capture actually stores.
 *
 * MEASURED LIVE 2026-08-20 (Transparent Hiring, "HR Assistant Intern"): Breezy's discovery capture
 * welds the control's own name onto the platform-default sentence, and the run parked on exactly
 * this control, still empty at submit time. The resolver must turn the welded label into the
 * machine acceptance under the grant - "as part of" is now accounted as a scaffolding span, and
 * this particular weld self-accounts because it spells gdpr plus agreement - so a future Breezy
 * row she never reviews carries answer_source consent_permission into managedConsentTickPlan. The
 * live row itself predates this and carries HER review's "Yes"; the plan's breezy replay arm is
 * what unparks that one, and portalSubmission.test.ts pins it. */
test("Breezy's welded default consent label becomes the consent_permission question on the packet", async () => {
  const welded = "i've read the privacy notice below and consent the processing of my data as part of my job application. gdprAgreement";
  const current: ApplicationReviewState = {
    jd_text: 'Support the HR team across sourcing and onboarding.',
    role: 'HR Assistant Intern',
    portal_url: 'https://transparent-hiring.breezy.hr/p/4d5a1d20f0ce-hr-assistant-intern-m-f-d-remote/apply',
    ats_name: 'breezy',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };

  const resolve = (ap: ApplicationProfileLike) => discoverAndResolveQuestions(
    [
      {
        label: welded,
        selector: '[data-litos-discovered-1]',
        durableSelector: 'input[name="gdprAgreement"]',
        inputType: 'checkbox',
        maxLength: null,
        required: true,
      },
    ],
    { user_id: 'user-1', job_context: { company: 'Transparent Hiring' } } as ResumeRow,
    current,
    ap,
    true,
    'breezy',
  );

  const granted = await resolve({
    consent_acknowledgement_permission: { granted_at: '2026-08-12T09:15:00.000Z', version: '2026-08-12' },
  });
  assert.equal(granted.questions.length, 1);
  const question = granted.questions[0];
  assert.equal(question.answer, 'Yes');
  assert.equal(question.answer_source, 'consent_permission');
  assert.equal(question.consent_permission_version, 'privacy_and_terms@2026-08-12');
  assert.equal(question.consent_permission_granted_at, '2026-08-12T09:15:00.000Z');
  assert.equal(question.portal_selector, 'input[name="gdprAgreement"]');
  assert.equal(question.portal_input_type, 'checkbox');
  assert.deepEqual(granted.attentionReasons, []);

  // No grant means main's behaviour: the required checkbox surfaces as HER question, unanswered,
  // never as a machine acceptance - and a no-grant Breezy run then parks on the tenant's own
  // validation exactly as the live run did.
  const ungranted = await resolve({});
  assert.equal(ungranted.questions.length, 1);
  assert.equal(ungranted.questions[0].answer, '');
  assert.notEqual(ungranted.questions[0].answer_source, 'consent_permission');
});

/* THE RUNNER'S TWO PACKET VERIFIERS HASH THE RESOLVED QUESTIONS, the same reading the audit
 * route and the submit-request gate hash. Verified in source because the skew this pins against
 * is a call-shape defect: prepare() and submit() used to call the packet verifiers with no
 * `questions` option, so they hashed the RAW stored rows while the audit bound the RESOLVED
 * reading, and any resolver-answered merge-minted blank made every audit-acknowledge-send round
 * end in packet_stale - measured four rounds in a row on the Easy Dynamics Rippling packet,
 * 2026-08-20. One helper, both call sites, same recipe as the audit route. */
test('prepare and submit verify the packet against the resolved questions, via one helper', async () => {
  const { join } = await import('node:path');
  // path.join(__dirname, ...), not new URL(import.meta.url): this tree compiles as commonjs and
  // import.meta is a TS1343 under it. Same rule as the documentReuse/coverLetterAttachment pins.
  const source = readFileSync(join(__dirname, 'submissionRunner.ts'), 'utf8');
  const helper = source.indexOf('async function resolvedPacketAuditQuestions');
  assert.notEqual(helper, -1, 'the shared resolver helper must exist');
  const helperBody = source.slice(helper, source.indexOf('\n}', helper));
  assert.match(helperBody, /refreshKnownQuestionAnswers\(/);
  assert.match(helperBody, /applicationContextForQuestionResolution\(row, review\)/);
  assert.match(helperBody, /postingCountryFromJobContext\(row\.job_context\)/);
  const calls = source.match(/verifiedPacketForRun\(row, current, current(?:Acknowledged)?PacketAudit\)/g) ?? [];
  assert.equal(calls.length, 2, 'both prepare() and submit() must verify through the two-reading helper');
  const twoReadings = source.slice(source.indexOf('async function verifiedPacketForRun'), source.indexOf('async function prepare('));
  assert.match(twoReadings, /questions: await resolvedPacketAuditQuestions\(row, current\)/,
    'the resolved reading is tried first');
  assert.match(twoReadings, /questions: current\.questions/,
    'the raw stored rows - the set the gate verified and persisted - are the second reading');
  assert.doesNotMatch(source,
    /current(?:Acknowledged)?PacketAudit\(row, \{ restoreExpiredResume: 'authorizing_send' \}\)/,
    'no runner verifier may fall back to hashing the raw stored rows');
});

/* THE SAME CONTRACT, SWEPT ACROSS EVERY VERIFIER THE ROUTES OWN. The acknowledge route was the
 * third verifier found hashing the raw stored rows (measured live on the Mytos lever packet,
 * 2026-08-20: audit green, acknowledge 409 packet_stale, forever), and six call sites in
 * applications.ts had the same shape. A verifier that does not name its questions hashes
 * review.questions raw, and raw disagrees with the resolved reading the audit binds whenever a
 * resolver answers a merge-minted blank. So: every call must carry a `questions:` option. */
test('every route verifier names the questions it hashes', async () => {
  const { join } = await import('node:path');
  const applications = readFileSync(join(__dirname, 'applications.ts'), 'utf8');
  const runner = readFileSync(join(__dirname, 'submissionRunner.ts'), 'utf8');
  for (const [name, source] of [['applications.ts', applications], ['submissionRunner.ts', runner]]) {
    const bare = source.match(/current(?:Acknowledged)?PacketAudit\(\w+(?:\)|, \{(?![^}]*questions)[^}]*\})/g) ?? [];
    assert.deepEqual(bare, [], name + ' has a verifier hashing raw stored rows: ' + bare.join(' | '));
  }
});

/* THE REVIEWED OPTION THE PROFILE CANNOT EXPRESS, measured live on the Mytos Lever form
 * (packet 16f1c744, 2026-08-20). The degree-classification select offers UK honours rows and GPA
 * rows; she reviewed and chose "GPA 3.5-3.8", byte for byte an offered option, and the profile's
 * own answer for that label ("Bachelor's Degree") matches nothing on the list. The old precedence
 * required the profile to be silent, so her choice was discarded on every rebuild and the run
 * re-minted "none of the options match your saved answer" about a choice she had already made. */
test('a current-round reviewed option stands when the profile value matches nothing on the list', async () => {
  const reviewedAt = '2026-08-20T18:30:00.000Z';
  const current: ApplicationReviewState = {
    jd_text: 'Junior software engineer in London.',
    role: 'Junior/Mid Software Engineer',
    portal_url: 'https://jobs.lever.co/mytos/abc',
    ats_name: 'lever',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [{
      id: '94905a8f-baf7-42ca-824a-7bfb6f15bc26',
      question: 'what was your degree classification? ✱',
      answer: 'GPA 3.5-3.8',
      kind: 'required',
      required: true,
      answer_source: 'applicant_review',
      answer_reviewed_at: reviewedAt,
    }],
    questions_reviewed_at: reviewedAt,
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };
  const result = await discoverAndResolveQuestions(
    [{
      label: 'What was your degree classification? ✱',
      selector: '[data-litos-discovered-1]',
      inputType: 'select',
      maxLength: null,
      required: true,
      options: [
        'First-Class Honours (First or 1st) (70% and above)',
        'Upper Second-Class Honours (2:1, 2.i) (60-70%)',
        'GPA 3.0-3.4', 'GPA 3.5-3.8', 'GPA 3.9+', 'Other',
      ],
    }],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { degree: "Bachelor's Degree" },
    true,
    'lever',
  );
  const question = result.questions.find((q) => q.question.toLowerCase().startsWith('what was your degree classification'));
  assert.equal(question?.answer, 'GPA 3.5-3.8');
  assert.equal(question?.answer_source, 'applicant_review');
  assert.deepEqual(result.attentionReasons, []);
});

test('a stored answered choice keeps the employer options discovered on the current run', async () => {
  const current: ApplicationReviewState = {
    jd_text: 'Software engineering internship.',
    role: 'Software Engineer Intern',
    portal_url: 'https://job-boards.greenhouse.io/optiver/jobs/1',
    ats_name: 'greenhouse',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [{
      id: 'pronouns',
      question: 'What are your preferred pronouns?',
      answer: 'She/her',
      kind: 'required',
      required: true,
    }],
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };
  const options = ['He/him', 'She/her', 'They/them', 'Prefer not to say'];
  const result = await discoverAndResolveQuestions(
    [{
      label: 'What are your preferred pronouns?*',
      selector: '#question_12345678',
      durableSelector: '#question_12345678',
      inputType: 'select-one',
      maxLength: null,
      required: true,
      options,
    }],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { pronouns: 'She/her' },
    true,
    'greenhouse',
  );

  assert.equal(result.questions[0]?.answer, 'She/her');
  assert.deepEqual(result.questions[0]?.options, options);
});

test('the profile still wins when it can name an offered option itself', async () => {
  const reviewedAt = '2026-08-20T18:30:00.000Z';
  const current: ApplicationReviewState = {
    jd_text: 'Junior software engineer in London.',
    role: 'Junior/Mid Software Engineer',
    portal_url: 'https://jobs.lever.co/mytos/abc',
    ats_name: 'lever',
    status: 'ready_to_submit',
    edited_terms: [],
    questions: [{
      id: 'q-1',
      question: 'expected graduation date ✱',
      answer: 'January 2027 - July 2027',
      kind: 'required',
      required: true,
      answer_source: 'applicant_review',
      answer_reviewed_at: reviewedAt,
    }],
    questions_reviewed_at: reviewedAt,
    skipped_reasons: [],
    updated_at: new Date().toISOString(),
  };
  const result = await discoverAndResolveQuestions(
    [{
      label: 'Expected graduation date ✱',
      selector: '[data-litos-discovered-1]',
      inputType: 'select',
      maxLength: null,
      required: true,
      options: ['January 2027 - July 2027', 'January 2028 - July 2028'],
    }],
    { user_id: 'user-1' } as ResumeRow,
    current,
    { grad_date: 'May 2028', grad_year: 2028 },
    true,
    'lever',
  );
  const question = result.questions.find((q) => q.question.toLowerCase().startsWith('expected graduation date'));
  assert.equal(question?.answer, 'January 2028 - July 2028');
});


/* THE POSTING THE EMPLOYER TOOK DOWN, measured on the live moburst.teamtailor.com posting
 * (2026-08-20): "This position is no longer active - Either the position was filled, or the ad
 * has expired", no form anywhere, and the not-reached sentence assigned homework on a job that no
 * longer exists. */
test('a closed posting on the no-evidence path is said in the employer\u2019s own words', () => {
  const packet = { email: 'a@b.c' } as SubmissionPacket;
  const closedPage = {
    text: 'Skip to main content CAREER MENU Share page PR Account Coordinator '
      + 'This position is no longer active Either the position was filled, or the ad has expired. Home Jobs',
    filledFields: [], blockers: [], discovered: [], extracted: [],
  };
  const blockers = preparationEvidenceBlockers(closedPage, packet);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /taken this posting down/);
  assert.match(blockers[0], /position was filled, or the ad has expired/);
  assert.doesNotMatch(blockers[0], /finish it off/);

  // An unreachable form with no closed-posting sentence keeps the honest not-reached sentence.
  const blank = preparationEvidenceBlockers({ text: 'A branded careers page.', filledFields: [], blockers: [], discovered: [], extracted: [] }, packet);
  assert.deepEqual(blank, [FORM_NOT_REACHED_REASON]);

  // A REACHED form is never scanned for the vocabulary: a job description may carry the words.
  const reached = preparationEvidenceBlockers({
    text: 'We are no longer accepting applications for our 2025 cohort, but 2026 is open below.',
    filledFields: ['email'], blockers: [], discovered: [], extracted: [],
  }, packet);
  assert.doesNotMatch(reached.join(' '), /taken this posting down/);
});


test('a vanished apply page is said as the page\u2019s own 404, claiming less than a closed job', () => {
  const packet = { email: 'a@b.c' } as SubmissionPacket;
  const blockers = preparationEvidenceBlockers({
    text: 'This website uses cookies to ensure you get the best experience. '
      + 'The page you were looking for doesn\u2019t exist. You may have mistyped the address or the page may have moved.',
    filledFields: [], blockers: [], discovered: [], extracted: [],
  }, packet);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /application page no longer exists/);
  assert.doesNotMatch(blockers[0], /finish it off/);
});


test('the greenhouse closed banner is believed even when the page looks reached', () => {
  const packet = { email: 'a@b.c' } as SubmissionPacket;
  const blockers = preparationEvidenceBlockers({
    text: 'Current openings at Redwood Materials. The job you are looking for is no longer open. '
      + '151 jobs. Engineering & Technology. Abuse Test Engineer, Energy Storage. a@b.c',
    filledFields: [], blockers: [], discovered: [], extracted: [{ value: 'something', label: 'x' }],
  }, packet);
  assert.equal(blockers.length, 1);
  assert.match(blockers[0], /taken this posting down/);
  assert.match(blockers[0], /no longer open/);
});
