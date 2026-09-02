import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import {
  ANSWER_CLAIM_FIELDS,
  APPLICANT_CLAIM_FIELDS,
  applyApplicationReviewEdit,
  deriveEditedTerms,
  finalApprovalCoverLetterIssue,
  finalApprovalFieldIssues,
  mergeSubmittedApplicationReviewQuestions,
  normalizeManagedFormSnapshot,
  normalizeApplicationReviewQuestions,
  readManagedFormSnapshot,
  readApplicationReview,
  type ApplicationReviewQuestion,
  type ApplicationReviewState,
} from './applicationReview';
import { PACKET_VISIBLE_QUESTION_FIELDS, packetVisibleQuestions } from './packetAudit';
import {
  frozenJobEmployerContext,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';

const bank: ExperienceBankEntry[] = [
  {
    id: '09d813c6-72b6-47ba-aabf-79430408b740',
    user_id: '8e56fe73-daf4-4b79-8ca9-e4d38e2e8ac7',
    type: 'job',
    org: 'Elemental AI',
    title: 'Engineer',
    location: 'Dubai, UAE',
    date_range: '2026',
    bullet_variants: ['Built a client handoff tool used by 18 projects.'],
    tags: [],
    created_at: new Date('2026-01-01'),
  },
];

const spec: ResumeSpec = {
  school: 'USC',
  degree: 'BS',
  grad_date: '2027',
  coursework: '',
  education_position: 'top',
  experience: [
    {
      type: 'job',
      org: 'Elemental AI',
      title: 'Engineer',
      date_range: '2026',
      bullets: ['Built an automated client workflow used by 18 projects.'],
    },
  ],
  skills: ['TypeScript'],
};

describe('application review metadata', () => {
  test('managed form snapshots are bounded and canonical while option order stays exact', () => {
    const snapshot = normalizeManagedFormSnapshot({
      fieldOptions: {
        ' work_authorization ': [' Yes ', 'No', 'Yes'],
      },
      failedFields: [
        { controlId: ' office ', label: ' Preferred office ', selector: ' #office ', inputType: ' select-one ' },
        { controlId: 'degree', label: ' Degree ', selector: '#degree', inputType: 'combobox' },
        { controlId: 'office', label: 'Preferred office', selector: '#office', inputType: 'select-one' },
      ],
      coverLetterSupported: false,
      transcriptSupported: true,
    });

    assert.deepEqual(snapshot, {
      version: 1,
      field_options: { work_authorization: ['Yes', 'No'] },
      failed_fields: [
        { controlId: 'degree', label: 'Degree', selector: '#degree', inputType: 'combobox' },
        { controlId: 'office', label: 'Preferred office', selector: '#office', inputType: 'select-one' },
      ],
      cover_letter_supported: false,
      transcript_supported: true,
    });
    assert.deepEqual(readManagedFormSnapshot({
      cover_letter_supported: false,
      transcript_supported: true,
      managed_form_snapshot: snapshot,
    }), snapshot);
  });

  test('managed form snapshots reject overflow and capability divergence', () => {
    assert.throws(() => normalizeManagedFormSnapshot({
      fieldOptions: Object.fromEntries(Array.from({ length: 81 }, (_, index) => [`field_${index}`, ['Yes', 'No']])),
      failedFields: [],
    }), /at most 80 controls/);
    assert.throws(() => normalizeManagedFormSnapshot({
      fieldOptions: { field: Array.from({ length: 4_097 }, (_, index) => `Option ${index}`) },
      failedFields: [],
    }), /at most 4096 options/);
    assert.throws(() => normalizeManagedFormSnapshot({
      fieldOptions: Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`field_${index}`, ['Yes']])),
      failedFields: [{ controlId: 'different_control', label: 'Different control' }],
    }), /at most 80 controls/);
    const snapshot = normalizeManagedFormSnapshot({
      fieldOptions: {},
      failedFields: [],
      coverLetterSupported: true,
    });
    assert.throws(() => readManagedFormSnapshot({
      cover_letter_supported: false,
      managed_form_snapshot: snapshot,
    }), /cover letter capability/);
    assert.throws(() => readManagedFormSnapshot({
      managed_form_snapshot: { version: 1 } as never,
    }), /missing its form inventory/);
    assert.throws(() => readManagedFormSnapshot({
      managed_form_snapshot: { version: 1, field_options: null, failed_fields: [] } as never,
    }), /field options must be an object/);
    assert.throws(() => readManagedFormSnapshot({
      managed_form_snapshot: { version: 1, field_options: {}, failed_fields: null } as never,
    }), /failed fields must be an array/);
    assert.throws(() => readManagedFormSnapshot({
      managed_form_snapshot: {
        version: 1,
        field_options: {},
        failed_fields: [],
        transcript_supported: true,
      },
    }), /transcript capability differs/);
  });

  test('managed form snapshots preserve large exact employer school inventories', () => {
    const schools = Array.from({ length: 1_500 }, (_, index) => `Fixture University ${index}`);
    const snapshot = normalizeManagedFormSnapshot({
      fieldOptions: { current_school: schools },
      failedFields: [],
    });

    assert.deepEqual(snapshot.field_options.current_school, schools);
  });

  test('managed prepare persists one snapshot and every later packet rebuild restores it', () => {
    const source = readFileSync('src/routes/submissionRunner.ts', 'utf8');
    const buildStart = source.indexOf('export async function buildPacket(');
    const buildEnd = source.indexOf('\nexport function readMostRecentRole', buildStart);
    const prepareStart = source.indexOf('async function prepareManaged(');
    const prepareEnd = source.indexOf('\nasync function prepareManagedAttendedAccountGate', prepareStart);
    assert.ok(buildStart > 0 && buildEnd > buildStart);
    assert.ok(prepareStart > 0 && prepareEnd > prepareStart);
    const build = source.slice(buildStart, buildEnd);
    const prepare = source.slice(prepareStart, prepareEnd);

    assert.match(build, /const managedFormSnapshot = readManagedFormSnapshot\(review\)/);
    assert.match(build, /fieldOptions: managedFormSnapshot\.field_options/);
    assert.match(build, /failedFields: managedFormSnapshot\.failed_fields/);
    assert.match(prepare, /const managedFormSnapshot = managedFormSnapshotWithStableCapabilities\(\{/);
    assert.match(prepare, /packet\.fieldOptions = managedFormSnapshot\.field_options/);
    assert.match(prepare, /packet\.failedFields = managedFormSnapshot\.failed_fields/);
    assert.ok((prepare.match(/managed_form_snapshot: managedFormSnapshot/g) ?? []).length >= 2,
      'both the one-time drift hold and the prepared review must persist the same snapshot');
  });

  test('derives only terms introduced by the tailored bullet', () => {
    const edited = deriveEditedTerms(spec, bank).map((term) => term.toLowerCase());
    assert.deepEqual(edited.sort(), ['automated', 'workflow']);
  });

  /**
   * Measured over the 25 most recent real packets on 2026-08-08: 245 of 267 rendered bullets are
   * BYTE-IDENTICAL to a stored bank variant, so the rewording diff above found nothing and
   * `edited_terms` came back `[]` on every packet - honestly. Tailoring below the skills line is
   * variant SELECTION, and until it was reported the green "wording Litos changed for this job"
   * tone in the review legend had never rendered on a real packet at all.
   */
  const selectionBank: ExperienceBankEntry[] = [
    {
      ...bank[0],
      bullet_variants: [
        'Built a client handoff tool used by 18 projects.',
        'Shipped a Kubernetes deployment pipeline used by 18 projects.',
      ],
    },
  ];

  test('a bank variant the JD reached past the default to pick is the edit', () => {
    const selected: ResumeSpec = {
      ...spec,
      experience: [
        {
          ...spec.experience[0],
          // Verbatim variant two. Not one word of it was written for this job; CHOOSING it was.
          bullets: ['Shipped a Kubernetes deployment pipeline used by 18 projects.'],
        },
      ],
    };
    const edited = deriveEditedTerms(selected, selectionBank).map((term) => term.toLowerCase());
    // Only what the default bullet would never have said. "projects" and "used" are in both, so
    // they are not attributable to this posting and must not go green.
    assert.deepEqual(edited.sort(), ['deployment', 'kubernetes', 'pipeline', 'shipped']);
  });

  test('the variant any job would have got is not an edit', () => {
    const defaulted: ResumeSpec = {
      ...spec,
      experience: [
        { ...spec.experience[0], bullets: ['Built a client handoff tool used by 18 projects.'] },
      ],
    };
    assert.deepEqual(deriveEditedTerms(defaulted, selectionBank), []);
  });

  test('an entry whose every variant is on the page made no choice to report', () => {
    // Two variants, two bullets: nothing was left behind, so nothing is attributable to the JD.
    const both: ResumeSpec = {
      ...spec,
      experience: [{ ...spec.experience[0], bullets: [...selectionBank[0].bullet_variants as string[]] }],
    };
    assert.deepEqual(deriveEditedTerms(both, selectionBank), []);
  });

  test('reads a persisted review packet and ignores plain resume specs', () => {
    assert.equal(readApplicationReview(spec), null);
    const review = {
      jd_text: 'Build workflow software',
      status: 'resume_ready' as const,
      edited_terms: ['workflow'],
      questions: [],
      question_metadata_blockers: [{
        kind: 'missing_exact_options' as const,
        required: true,
        portal_input_type: 'select-one',
        control_id: 'question_123',
        portal_selector: '#question_123',
        question: 'Will you require sponsorship in the future?',
      }],
      skipped_reasons: [],
      updated_at: '2026-07-21T00:00:00.000Z',
    };
    assert.deepEqual(readApplicationReview({ ...spec, _review: review }), review);
  });

  test('normalizes duplicate portal questions by label before submission guards run', () => {
    assert.deepEqual(
      normalizeApplicationReviewQuestions([
        { id: 'blank-gender', question: 'gender', answer: '', kind: 'required', required: true },
        { id: 'answered-gender', question: 'Gender', answer: 'Decline to self-identify', kind: 'required', required: false },
      ]),
      [
        { id: 'blank-gender', question: 'gender', answer: 'Decline to self-identify', kind: 'required', required: true },
      ],
    );
  });

  test('normalization keeps non-empty local answers when a later duplicate is blank', () => {
    assert.deepEqual(
      normalizeApplicationReviewQuestions([
        { id: 'answered-work-auth', question: 'Are you legally authorized to work in the country in which you are applying?', answer: 'Yes', kind: 'required', required: true },
        { id: 'blank-work-auth', question: 'are you legally authorized to work in the country in which you are applying?', answer: '', kind: 'required', required: true },
      ]),
      [
        { id: 'answered-work-auth', question: 'Are you legally authorized to work in the country in which you are applying?', answer: 'Yes', kind: 'required', required: true },
      ],
    );
  });

  test('normalization attaches a fresh portal selector to an existing answered question', () => {
    assert.deepEqual(
      normalizeApplicationReviewQuestions([
        { id: 'answered-gpa', question: 'Please indicate your overall GPA.', answer: '3.89', kind: 'required', required: true },
        {
          id: 'rediscovered-gpa',
          question: 'please indicate your overall gpa.',
          answer: '3.89',
          kind: 'required',
          required: false,
          portal_selector: 'textarea[name="job_application[answers_attributes][0][text_value]"]',
        },
      ]),
      [
        {
          id: 'answered-gpa',
          question: 'Please indicate your overall GPA.',
          answer: '3.89',
          kind: 'required',
          required: true,
          portal_selector: 'textarea[name="job_application[answers_attributes][0][text_value]"]',
        },
      ],
    );
  });

  test('normalization preserves durable ATS API field mappings on duplicate questions', () => {
    assert.deepEqual(
      normalizeApplicationReviewQuestions([
        {
          id: 'answered-work-auth',
          question: 'Are you legally authorized to work in the United States?',
          answer: 'Yes',
          kind: 'required',
          required: true,
        },
        {
          id: 'rediscovered-work-auth',
          question: 'are you legally authorized to work in the united states?',
          answer: 'Yes',
          kind: 'required',
          required: true,
          ats_api_field: 'job_application[answers_attributes][0][boolean_value]',
        },
      ]),
      [
        {
          id: 'answered-work-auth',
          question: 'Are you legally authorized to work in the United States?',
          answer: 'Yes',
          kind: 'required',
          required: true,
          ats_api_field: 'job_application[answers_attributes][0][boolean_value]',
        },
      ],
    );
  });

  test('normalization replaces a stale discovered marker with a durable portal selector', () => {
    assert.deepEqual(
      normalizeApplicationReviewQuestions([
        {
          id: 'answered-gpa',
          question: 'Please indicate your overall GPA.',
          answer: '3.89',
          kind: 'required',
          required: true,
          portal_selector: '[data-litos-discovered-1]',
        },
        {
          id: 'rediscovered-gpa',
          question: 'please indicate your overall gpa.',
          answer: '3.89',
          kind: 'required',
          required: true,
          portal_selector: 'textarea[name="job_application[answers_attributes][0][text_value]"]',
        },
      ]),
      [
        {
          id: 'answered-gpa',
          question: 'Please indicate your overall GPA.',
          answer: '3.89',
          kind: 'required',
          required: true,
          portal_selector: 'textarea[name="job_application[answers_attributes][0][text_value]"]',
        },
      ],
    );
  });

  /* The reviewed row leads the collision so her answer wins (see mergeDiscoveredPortalQuestions),
     and it was stored before `options` existed - so first-wins on the whole object dropped the
     employer's menu on exactly the questions she is being asked to answer. */
  test('normalization carries the employer option list across the duplicate merge, in both directions', () => {
    assert.deepEqual(
      normalizeApplicationReviewQuestions([
        { id: 'reviewed-consent', question: 'Do you consent to the processing described above?', answer: 'I consent to the above.', kind: 'required', required: true },
        { id: 'rediscovered-consent', question: 'do you consent to the processing described above?', answer: '', kind: 'required', required: true, options: ['I consent to the above.'] },
      ]),
      [
        { id: 'reviewed-consent', question: 'Do you consent to the processing described above?', answer: 'I consent to the above.', kind: 'required', required: true, options: ['I consent to the above.'] },
      ],
    );
    assert.deepEqual(
      normalizeApplicationReviewQuestions([
        { id: 'discovered-consent', question: 'Do you consent to the processing described above?', answer: '', kind: 'required', required: true, options: ['I consent to the above.'] },
        { id: 'stored-consent', question: 'do you consent to the processing described above?', answer: 'I consent to the above.', kind: 'required', required: false },
      ]),
      [
        { id: 'discovered-consent', question: 'Do you consent to the processing described above?', answer: 'I consent to the above.', kind: 'required', required: true, options: ['I consent to the above.'] },
      ],
    );
  });

  test('submit-request answer updates keep stored portal selectors', () => {
    assert.deepEqual(
      mergeSubmittedApplicationReviewQuestions(
        [
          {
            id: 'stored-project',
            question: "Tell us about something you've built that you're proud of. What was hard about it?",
            answer: 'Old answer',
            kind: 'essay',
            required: false,
            portal_selector: 'textarea[name="candidate[answers][123]"]',
          },
        ],
        [
          {
            id: 'stored-project',
            question: "Tell us about something you've built that you're proud of. What was hard about it?",
            answer: 'New reviewed answer',
            kind: 'essay',
            required: false,
          },
        ],
      ),
      [
        {
          id: 'stored-project',
          question: "Tell us about something you've built that you're proud of. What was hard about it?",
          answer: 'New reviewed answer',
          kind: 'essay',
          required: false,
          portal_selector: 'textarea[name="candidate[answers][123]"]',
        },
      ],
    );
  });

  test('submit-request answer updates keep stored ATS API field mappings', () => {
    assert.deepEqual(
      mergeSubmittedApplicationReviewQuestions(
        [
          {
            id: 'stored-work-auth',
            question: 'Are you legally authorized to work in the United States?',
            answer: 'Yes',
            kind: 'required',
            required: true,
            ats_api_field: 'job_application[answers_attributes][0][boolean_value]',
          },
        ],
        [
          {
            id: 'stored-work-auth',
            question: 'Are you legally authorized to work in the United States?',
            answer: 'No',
            kind: 'required',
            required: true,
          },
        ],
      ),
      [
        {
          id: 'stored-work-auth',
          question: 'Are you legally authorized to work in the United States?',
          answer: 'No',
          kind: 'required',
          required: true,
          ats_api_field: 'job_application[answers_attributes][0][boolean_value]',
        },
      ],
    );
  });

  test('submit-request answer updates cannot inject ATS API field mappings', () => {
    assert.deepEqual(
      mergeSubmittedApplicationReviewQuestions(
        [
          {
            id: 'stored-work-auth',
            question: 'Are you legally authorized to work in the United States?',
            answer: 'Yes',
            kind: 'required',
            required: true,
          },
        ],
        [
          {
            id: 'stored-work-auth',
            question: 'Are you legally authorized to work in the United States?',
            answer: 'Yes',
            kind: 'required',
            required: true,
            ats_api_field: 'job_application[answers_attributes][0][boolean_value]',
          },
        ],
      ),
      [
        {
          id: 'stored-work-auth',
          question: 'Are you legally authorized to work in the United States?',
          answer: 'Yes',
          kind: 'required',
          required: true,
        },
      ],
    );
  });
});

/* ---------------------------------------------------------------------------------------------
 * THE SEND GATE AND THE COVER LETTER: an optional one may never refuse a finished application.
 *
 * Cresta packet 8142004c-3358-4538-8778-16df5e31c5bb, 2026-08-08. Status ready_for_final_approval,
 * six filled fields, a resume uploaded, no blockers, no screener questions unanswered, and
 * POST /submission/approve answering 422 FINAL_APPROVAL_VERIFICATION_FAILED with a single issue:
 * "The filled form did not record the cover letter attachment." The live form's cover letter
 * offered Attach / Dropbox / Enter manually and carried no required marker, while First Name, Last
 * Name and Email all did.
 *
 * Two conflations, and it took both:
 *   cover_letter_supported, which means the form HAS a cover-letter file control, was read as
 *   meaning the employer REQUIRES one; and
 *   a cover letter stored on the row was read as a cover letter the RUN ATTACHED, when buildPacket
 *   attaches only an approved letter and this one was an unapproved 1,918 character draft.
 * ------------------------------------------------------------------------------------------- */
describe('the final approval cover letter gate', () => {
  const cresta: ApplicationReviewState = {
    role: 'Data Science Intern',
    status: 'ready_for_final_approval',
    updated_at: '2026-08-08T23:29:52.561Z',
    jd_text: 'Data Science Intern, Customer Success. San Francisco.',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    filled_fields: ['first_name', 'last_name', 'preferred_first_name', 'email', 'phone', 'resume'],
    cover_letter_supported: true,
  };

  test('a form that only OFFERS a cover letter does not block the send', () => {
    // The measured Cresta shape, with the requirement measured and false.
    assert.equal(finalApprovalCoverLetterIssue({ ...cresta, cover_letter_required: false }, false), null);
    // And with a draft sitting on the row, which is where the second conflation lived.
    assert.equal(finalApprovalCoverLetterIssue({ ...cresta, cover_letter_required: false }, true), null);
  });

  test('a packet filled before the requirement was measured does not block either', () => {
    // cover_letter_required undefined is every packet already in the database. Unknown must not be
    // read as required: that is the same refusal wearing a new field name, and it is what left
    // three applications unsendable on 2026-08-08.
    assert.equal(finalApprovalCoverLetterIssue(cresta, false), null);
  });

  test('a cover letter the employer requires and she has not written DOES block', () => {
    const issue = finalApprovalCoverLetterIssue({ ...cresta, cover_letter_required: true }, false);
    assert.ok(issue);
    assert.match(issue, /requires a cover letter/i);
  });

  test('a required cover letter is satisfied by a draft on the row, approved or not', () => {
    // Approving is what this endpoint does: approvedReviewSpec stamps _cover_letter.approved_at on
    // the way through and the submit run rebuilds the packet, so a stored draft will be sent.
    assert.equal(finalApprovalCoverLetterIssue({ ...cresta, cover_letter_required: true }, true), null);
  });

  test('the filled-form evidence check asks what the RUN attached, not what the row holds', () => {
    // The run did not attach a letter, so a form with no cover field is correct and complete.
    assert.deepEqual(finalApprovalFieldIssues(cresta, false), []);
    // A run that DID attach one and recorded no cover field is a real defect and still reported.
    assert.deepEqual(
      finalApprovalFieldIssues(cresta, true),
      ['The filled form did not record the cover letter attachment.'],
    );
    // And that report clears the moment the evidence is there.
    assert.deepEqual(
      finalApprovalFieldIssues({ ...cresta, filled_fields: [...cresta.filled_fields!, 'cover_letter'] }, true),
      [],
    );
  });

  test('the other three evidence checks are untouched by any of this', () => {
    assert.deepEqual(
      finalApprovalFieldIssues({ ...cresta, filled_fields: [] }, false),
      [
        'The filled form did not record an email field.',
        'The filled form did not record a resume upload.',
        'The filled form did not record the applicant name fields.',
      ],
    );
  });
});

test('review edits stamp server-owned current-answer provenance', () => {
  const current = {
    jd_text: 'Role',
    status: 'questions_ready',
    edited_terms: [],
    questions: [],
    skipped_reasons: [],
    updated_at: '2026-08-09T00:00:00.000Z',
  } as ApplicationReviewState;
  const edited = applyApplicationReviewEdit(current, {
    questions: [{ id: 'q', question: 'Can you work onsite?', answer: 'Yes', kind: 'required', required: true }],
    skipped_reasons: [],
  });
  assert.equal(edited.questions[0].answer_source, 'applicant_review');
  assert.equal(edited.questions[0].answer_reviewed_at, edited.questions_reviewed_at);
  assert.equal(edited.updated_at, edited.questions_reviewed_at);
});

test('review edits preserve unchanged employer option derivations', () => {
  const current = {
    jd_text: 'Role',
    status: 'needs_attention',
    edited_terms: [],
    questions: [
      {
        id: 'graduation',
        question: 'when is your anticipated graduation date - please select a graduation date range',
        answer: 'January 2028 - July 2028',
        kind: 'required' as const,
        required: true,
        portal_selector: '#question_9170559101',
        answer_option_source: 'May 2028',
      },
      {
        id: 'gpa',
        question: 'what is your gpa?',
        answer: '3.81 - 3.9',
        kind: 'required' as const,
        required: true,
        portal_selector: '#question_9170560101',
        answer_option_source: '3.89',
      },
    ],
    skipped_reasons: [],
    updated_at: '2026-08-13T00:00:00.000Z',
  } as ApplicationReviewState;
  const publicQuestions = current.questions.map(({ answer_option_source: _source, ...question }) => question);

  const edited = applyApplicationReviewEdit(current, {
    questions: publicQuestions,
    skipped_reasons: [],
  });

  assert.equal(edited.questions[0].answer, 'January 2028 - July 2028');
  assert.equal(edited.questions[0].answer_option_source, 'May 2028');
  assert.equal(edited.questions[1].answer, '3.81 - 3.9');
  assert.equal(edited.questions[1].answer_option_source, '3.89');
});

test('current applicant-reviewed ranges recover safely when older packets lost their derivation', () => {
  const reviewedAt = '2026-08-13T14:19:01.979Z';
  const profile = { grad_date: 'May 2028', grad_year: 2028, gpa: '3.89' };
  const currentAnswers = refreshKnownQuestionAnswers([
    {
      id: 'graduation',
      question: 'when is your anticipated graduation date - please select a graduation date range',
      answer: 'January 2028 - July 2028',
      kind: 'required' as const,
      required: true,
      answer_source: 'applicant_review' as const,
      answer_reviewed_at: reviewedAt,
    },
    {
      id: 'gpa',
      question: 'what is your gpa?',
      answer: '3.81 - 3.9',
      kind: 'required' as const,
      required: true,
      answer_source: 'applicant_review' as const,
      answer_reviewed_at: reviewedAt,
    },
  ], profile, undefined, reviewedAt);

  assert.equal(currentAnswers[0].answer, 'January 2028 - July 2028');
  assert.equal(currentAnswers[1].answer, '3.81 - 3.9');

  const staleAnswers = refreshKnownQuestionAnswers([
    { ...currentAnswers[0], answer: 'August 2028 - December 2028' },
    { ...currentAnswers[1], answer: '3.0 - 3.5' },
  ], profile, undefined, reviewedAt);

  assert.equal(staleAnswers[0].answer, 'May 2028');
  assert.equal(staleAnswers[1].answer, '3.89');
  assert.equal(staleAnswers[0].answer_source, undefined);
  assert.equal(staleAnswers[1].answer_source, undefined);
});

test('submit merge preserves provenance only for an exact current reviewed identity', () => {
  const reviewedAt = '2026-08-09T12:00:00.000Z';
  const stored = [{
    id: 'q',
    question: 'Can you work onsite?',
    answer: 'Yes',
    kind: 'required' as const,
    required: true,
    answer_source: 'applicant_review' as const,
    answer_reviewed_at: reviewedAt,
  }];
  const unchanged = mergeSubmittedApplicationReviewQuestions(stored, [{ ...stored[0] }], reviewedAt);
  assert.equal(unchanged[0].answer_source, 'applicant_review');
  assert.equal(unchanged[0].answer_reviewed_at, reviewedAt);

  const changed = mergeSubmittedApplicationReviewQuestions(
    stored,
    [{ ...stored[0], answer: 'No' }],
    reviewedAt,
  );
  assert.equal(changed[0].answer, 'No');
  /* A REPLACEMENT DOES NOT INHERIT THE OLD CLAIM, IT MINTS A NEW ONE, and those are different
   * sentences about the same record. What must never happen is a claim attached to text the
   * applicant reviewed surviving onto something she did not - which is the label-mutation half of
   * this test below, and it still holds. Here she changed the answer herself in the current round,
   * so the record names her and records what she overrode. See applicantSuppliedAnswer. */
  assert.equal(changed[0].answer_source, 'applicant_review');
  assert.equal(changed[0].answer_reviewed_at, reviewedAt);
  /* NO OVERRIDE RECORD, because this caller passed no resolver lookup and the stored record carries no
   * note of what it corresponds to. The recorded value has to be the RESOLVER's, and guessing it from
   * the stored answer is what made the override silently fail on every snapped record. Absent reads as
   * "cannot prove current" and costs one recomputation. See overriddenResolverValue. */
  assert.equal(changed[0].answer_override_of, undefined);

  for (const publicQuestion of [
    '  Can you work onsite?  ',
    'Can  you work onsite?',
    'can you work onsite?',
    'Can you work on-site?',
  ]) {
    const textMutated = mergeSubmittedApplicationReviewQuestions(
      stored,
      [{ ...stored[0], question: publicQuestion }],
      reviewedAt,
    );
    assert.equal(textMutated.length, 1, `mutated public label must not append: ${publicQuestion}`);
    assert.equal(textMutated[0].question, stored[0].question, 'stored canonical label must win');
    assert.equal(textMutated[0].answer, stored[0].answer);
    assert.equal(textMutated[0].answer_source, undefined, `mutation must invalidate: ${publicQuestion}`);
    assert.equal(textMutated[0].answer_reviewed_at, undefined);
  }

  const staleReview = mergeSubmittedApplicationReviewQuestions(
    stored,
    [{ ...stored[0] }],
    '2026-08-09T12:00:01.000Z',
  );
  assert.equal(staleReview[0].answer_source, undefined);
  assert.equal(staleReview[0].answer_reviewed_at, undefined);

  const changedId = mergeSubmittedApplicationReviewQuestions(
    stored,
    [{ ...stored[0], id: 'public-replacement' }],
    reviewedAt,
  );
  assert.equal(changedId[0].answer_source, undefined);
  assert.equal(changedId[0].answer_reviewed_at, undefined);

  const replacedIdentity = mergeSubmittedApplicationReviewQuestions(
    stored,
    [{ ...stored[0], id: 'public-replacement', question: 'Can you work on site?' }],
    reviewedAt,
  );
  assert.equal(replacedIdentity[0].question, stored[0].question);
  assert.equal(replacedIdentity[0].answer_source, undefined);
  assert.equal(replacedIdentity[0].answer_reviewed_at, undefined);
  assert.equal(replacedIdentity[1].question, 'Can you work on site?');
  assert.equal(replacedIdentity[1].answer_source, undefined);
  assert.equal(replacedIdentity[1].answer_reviewed_at, undefined);

  const omitted = mergeSubmittedApplicationReviewQuestions(stored, [], reviewedAt);
  assert.equal(omitted[0].answer_source, undefined);
  assert.equal(omitted[0].answer_reviewed_at, undefined);
});

/* A DERIVATION NEVER OUTLIVES THE ANSWER IT DESCRIBES, ON THIS PATH TOO.
 *
 * answer_option_source records the profile value an option was snapped from, and
 * storedOptionAnswerIsCurrent reads it as proof that the answer beside it is still current. That
 * proof is only worth anything while the answer is the one it was written for. This merge replaces
 * `answer` from the submit body, so a derivation carried across would describe a value it never
 * described, and the next refresh and the next fill would both believe it.
 *
 * Benign today, because the route is authenticated and user-scoped so the substituted answer is the
 * applicant's own edit. Pinned anyway: a record that claims a snap which never happened is
 * undetectable from the record alone, which is the exact failure mode this field was added to end.
 *
 * refreshKnownQuestionAnswers already drops it on the branches that recompute. This is the same
 * invariant on the other function that overwrites an answer. */
test('submit merge drops the option derivation whenever it replaces the answer', () => {
  const reviewedAt = '2026-08-09T12:00:00.000Z';
  const stored = [{
    id: 'q',
    question: 'Expected graduation date',
    answer: 'January 2028 - July 2028',
    kind: 'required' as const,
    required: true,
    answer_source: 'applicant_review' as const,
    answer_reviewed_at: reviewedAt,
    answer_option_source: 'May 2028',
  }];

  // The answer is replaced, so the derivation describes a value that is no longer there.
  const replaced = mergeSubmittedApplicationReviewQuestions(
    stored,
    [{ ...stored[0], answer: 'August 2028 - December 2028' }],
    reviewedAt,
  );
  assert.equal(replaced[0].answer, 'August 2028 - December 2028');
  assert.equal(replaced[0].answer_option_source, undefined,
    'a derivation must not describe an answer it was never derived for');

  // Same when the reviewed provenance is stale, which is the ordinary path for a resubmitted packet.
  const staleReview = mergeSubmittedApplicationReviewQuestions(
    stored,
    [{ ...stored[0], answer: 'August 2028 - December 2028' }],
    '2026-08-09T12:00:01.000Z',
  );
  assert.equal(staleReview[0].answer_option_source, undefined);

  // And the one branch that keeps the whole record keeps it, because that branch requires the
  // answer to be byte-identical. Without this the fix would be a blanket erase, and every
  // resubmitted packet would lose the evidence that its resolved option is current.
  const unchanged = mergeSubmittedApplicationReviewQuestions(stored, [{ ...stored[0] }], reviewedAt);
  assert.equal(unchanged[0].answer, 'January 2028 - July 2028');
  assert.equal(unchanged[0].answer_option_source, 'May 2028',
    'an unchanged answer keeps the derivation that still describes it');
});

/* THE REVIEW SCREEN'S SAVE, END TO END, ON A PACKET THAT HAS NOT BEEN TOUCHED.
 *
 * The test above passes and proved less than it looked like it proved. It reaches the keep branch
 * only through `answer_source: 'applicant_review'`, which is a record the applicant has ALREADY
 * edited once. The ordinary record is the machine-resolved one, written by discovery and never
 * hand-edited, and on 2026-08-12 that was every question record in production: 2790 of 2790 carried
 * no answer_source at all. For all of them the merge fell to the strip branch even when the submit
 * body echoed the stored answer back byte for byte.
 *
 * These two facts compose into silent data loss, which is why this is one test over both functions
 * rather than two unit tests:
 *
 *   1. the merge drops answer_option_source because answer_source is not 'applicant_review', even
 *      though the answer it describes is unchanged; then
 *   2. refreshKnownQuestionAnswers, running on the merge's output at the same call site, sees a band
 *      with nothing left to prove it current and replaces it with the raw profile fact.
 *
 * So opening "Review answers" and pressing Save, changing nothing, rewrites
 * "January 2028 - July 2028" to "May 2028" and "3.81 - 3.9" to "3.89" - the exact values measured
 * on the live IMC packet fc6eade3-90e5-4d17-af94-009f9a22beaa. "May 2028" is not on that control's
 * option list and never could be, so the field it is filled into comes back required-and-still-empty.
 * The screen invites the press: its own button says Save and its copy says these answers go on the
 * company's form.
 *
 * The stored answers are the two real ones. The submit body is what the dashboard actually posts:
 * questionSchema strips every provenance key, so a client echo carries the answer and nothing else,
 * and the merge is the only thing that can carry the derivation across. */
test('an untouched review save leaves the stored option answers exactly as they were', () => {
  const reviewedAt = '2026-08-11T16:56:30.801Z';
  const profile = { grad_date: 'May 2028', grad_year: 2028, gpa: '3.89' };
  const stored = [
    {
      id: '7615a5c5-be2c-4f30-8008-50afdd4ee6ed',
      question: 'when is your anticipated graduation date - please select a graduation date range',
      answer: 'January 2028 - July 2028',
      kind: 'required' as const,
      required: true,
      portal_selector: '#question_9170559101',
      answer_option_source: 'May 2028',
    },
    {
      id: 'f2852c3c-2b80-415a-b8ce-80bfe4260dd5',
      question: 'what is your gpa?',
      answer: '3.81 - 3.9',
      kind: 'required' as const,
      required: true,
      portal_selector: '#question_9170560101',
      answer_option_source: '3.89',
    },
  ];
  const clientEcho = stored.map(({ answer_option_source: _derivation, ...question }) => question);

  // The two calls POST /applications/:id/submit-request makes, in its order, on its own arguments.
  const persisted = refreshKnownQuestionAnswers(
    mergeSubmittedApplicationReviewQuestions(stored, clientEcho, reviewedAt),
    profile,
    undefined,
    reviewedAt,
  );

  assert.equal(persisted[0].answer, 'January 2028 - July 2028',
    'a save that changed nothing must not rewrite the graduation option the control offered');
  assert.equal(persisted[1].answer, '3.81 - 3.9',
    'a save that changed nothing must not rewrite the GPA band the control offered');
});

/* The derivation is not a second answer, so it cannot be preserved by being sticky. It survives
 * exactly as long as the value it describes, and the round trip above is the only reason it needs to
 * survive a merge at all. Both directions are asserted here because keeping it too eagerly rebuilds
 * the hole PR 496 closed from the other side: answer_option_source is read as proof that the answer
 * beside it is current, so one attached to an answer it was never derived for would make a stale
 * band unfalsifiable. */
test('an unedited save leaves no derivation describing a value it was not derived for', () => {
  const reviewedAt = '2026-08-11T16:56:30.801Z';
  const stored = [{
    id: '7615a5c5-be2c-4f30-8008-50afdd4ee6ed',
    question: 'when is your anticipated graduation date - please select a graduation date range',
    answer: 'January 2028 - July 2028',
    kind: 'required' as const,
    required: true,
    answer_option_source: 'May 2028',
  }];

  const untouched = mergeSubmittedApplicationReviewQuestions(
    stored,
    [{ ...stored[0], answer_option_source: undefined }],
    reviewedAt,
  );
  assert.equal(untouched[0].answer, 'January 2028 - July 2028');
  assert.equal(untouched[0].answer_option_source, 'May 2028',
    'the derivation still describes the answer in the record, so it survives');

  const edited = mergeSubmittedApplicationReviewQuestions(
    stored,
    [{ ...stored[0], answer: 'August 2028 - December 2028', answer_option_source: undefined }],
    reviewedAt,
  );
  assert.equal(edited[0].answer, 'August 2028 - December 2028');
  assert.equal(edited[0].answer_option_source, undefined,
    'a replaced answer must not inherit the derivation of the one it replaced');

  /* A derivation cannot arrive from outside either. questionSchema strips it before the route ever
   * calls this, but this function is exported and the tail loop below copies a submitted question
   * wholesale, so a caller with a looser schema could mint proof for an answer nothing resolved. */
  const invented = mergeSubmittedApplicationReviewQuestions(
    [],
    [{
      id: 'new',
      question: 'expected graduation date',
      answer: 'January 2020 - July 2020',
      kind: 'required' as const,
      required: true,
      answer_option_source: 'May 2028',
    }],
    reviewedAt,
  );
  assert.equal(invented[0].answer_option_source, undefined,
    'a submitted question cannot bring its own proof that it is current');
});

/* THE OTHER HALF OF THE ROUND TRIP, and the reason the fix above is a comparison and not a rule that
 * the stored answer wins. The screen exists so the applicant can correct what Litos got wrong; a
 * save that preserved the stored answer unconditionally would make every textarea on it decorative.
 *
 * Note which edit is asserted. On a question the resolver answers from the profile, hers is
 * deliberately NOT the last word - refreshKnownQuestionAnswers re-resolves a graduation date on
 * every send so a packet cannot replay one she has since corrected in her profile (R-118), and that
 * is unchanged here and asserted so. The edit that must survive is the one on a question the
 * resolver has no answer for, which is every essay and every posting-specific question on the
 * screen. */
test('a genuine edit on the review screen still wins', () => {
  const reviewedAt = '2026-08-11T16:56:30.801Z';
  const profile = { grad_date: 'May 2028', grad_year: 2028, gpa: '3.89' };
  const stored = [
    {
      id: 'essay',
      question: 'why do you want to work at IMC?',
      answer: 'A drafted paragraph the applicant did not like.',
      kind: 'essay' as const,
      required: true,
    },
    {
      id: 'grad',
      question: 'when is your anticipated graduation date - please select a graduation date range',
      answer: 'January 2028 - July 2028',
      kind: 'required' as const,
      required: true,
      answer_option_source: 'May 2028',
    },
  ];

  const persisted = refreshKnownQuestionAnswers(
    mergeSubmittedApplicationReviewQuestions(
      stored,
      [
        { ...stored[0], answer: 'Her own sentence, typed on the review screen.' },
        { id: 'grad', question: stored[1].question, answer: 'August 2028 - December 2028', kind: 'required' as const, required: true },
      ],
      reviewedAt,
    ),
    profile,
    undefined,
    reviewedAt,
  );

  assert.equal(persisted[0].answer, 'Her own sentence, typed on the review screen.',
    'an edit to a question the resolver cannot answer is the answer');
  assert.equal(persisted[1].answer, 'May 2028',
    'a graduation date still comes from the profile, and her edited band does not become sticky');
  assert.equal(persisted[1].answer_option_source, undefined,
    'and it carries no derivation, because nothing derived it');
});

/* AN ANSWER TO A QUESTION LITOS DELIBERATELY HANDS BACK, TYPED ON THE SEND.
 *
 * Measured on 2026-08-12 on the live IMC packet. POST /submit-request runs
 * mergeSubmittedApplicationReviewQuestions and then refreshKnownQuestionAnswers on its output at the
 * SAME call site (routes/applications.ts), and persists the result. The merge adopted her typed
 * answer and recorded nothing about where it came from, so the refresh's refusal branch could not
 * tell it from an earlier run's stale value and blanked it - on the one request that reaches the
 * employer, over her own words.
 *
 * The blast radius is the whole human-owned category, not this label: every question the resolver
 * holds is one Litos is ASKING her to answer, and none of them could be answered on the send path.
 *
 * The label below is the live IMC prior-application question and the profile declares nothing, which
 * is what holds it - deliberately not the empty-declaration shape, so this keeps proving the merge's
 * behaviour after the resolver learned to answer that one.
 */
test('an applicant answer filling a held question survives the send-path refresh', () => {
  const reviewedAt = '2026-08-12T17:08:37.791Z';
  const held = 'have you applied to this role or another role @imc within the last 12-18 months? as a reminder, '
    + 'if you have already applied for this position during the current recruitment season and were not '
    + 'selected, you may reapply when the next recruitment season begins in 2027.';
  const jdText = frozenJobEmployerContext('IMC');
  // Nothing declared and no send history read: the resolver holds this question and must keep doing so.
  const profile: ApplicationProfileLike = {};
  const stored = [{ id: 'prior', question: held, answer: '', kind: 'required' as const, required: true }];

  assert.ok(
    'skipReason' in (resolveKnownAnswer(held, 'text', profile, jdText) ?? {}),
    'precondition: the resolver still refuses to answer this question from this profile',
  );

  const sent = (answer: string) => refreshKnownQuestionAnswers(
    mergeSubmittedApplicationReviewQuestions(stored, [{ ...stored[0], answer }], reviewedAt),
    profile,
    jdText,
    reviewedAt,
  )[0];

  const answered = sent('No');
  assert.equal(answered.answer, 'No', 'the answer she typed is what the employer receives');
  assert.equal(answered.answer_source, 'applicant_review', 'and the record says who it came from');
  assert.equal(answered.answer_reviewed_at, reviewedAt);

  /* AND LITOS STILL DOES NOT INVENT ONE. With no answer supplied, the hold stands and the control is
   * left blank for her - which is the property the refusal branch exists for and is untouched. */
  const untouched = sent('');
  assert.equal(untouched.answer, '', 'an unanswered hold stays unanswered');
  assert.equal(untouched.answer_source, undefined, 'and claims no applicant behind it');

  /* NOR IS A REPLAYED ANSWER PROMOTED INTO ONE. A client posting back what a previous run resolved
   * has reviewed nothing, and stamping it would assert a review that did not happen - and would
   * disarm the runner's stale-drafted-answer guard, which reads this exact field. */
  const drafted = 'A paragraph an earlier build drafted.';
  const replayed = refreshKnownQuestionAnswers(
    mergeSubmittedApplicationReviewQuestions(
      [{ ...stored[0], answer: drafted, kind: 'essay' as const }],
      [{ ...stored[0], answer: drafted, kind: 'essay' as const }],
      reviewedAt,
    ),
    profile,
    jdText,
    reviewedAt,
  )[0];
  assert.equal(replayed.answer_source, undefined, 'a replayed answer is not an applicant review');
});

/* EXHAUSTIVE BY CONSTRUCTION. `satisfies Required<ApplicationReviewQuestion>` is the compile-time
 * half of the guard: adding any field to the question type, optional or not, stops this literal
 * compiling until it is listed here. The runtime half below then refuses to let the new field
 * through unclassified. Without the `satisfies`, a new optional field would simply be absent from
 * the literal and every assertion would keep passing while the hash quietly re-widened. */
const everyQuestionField = {
  id: 'question-1',
  question: 'What is your gender/gender identity?',
  answer: 'Female',
  kind: 'required',
  required: true,
  portal_selector: '#gender',
  portal_input_type: 'select',
  ats_api_field: 'gender',
  answer_source: 'applicant_review',
  answer_reviewed_at: '2026-08-12T13:45:27.969Z',
  answer_option_source: 'May 2028',
  answer_override_of: 'Bachelor of Science in Computer Science',
  consent_permission_granted_at: '2026-08-01T00:00:00.000Z',
  consent_permission_version: 'v1',
  options: ['Female', 'Male', 'Decline To Self Identify'],
  answer_draft: 'Woman',
  answer_state: 'unanswered',
} satisfies Required<ApplicationReviewQuestion>;

/* DISPLAY-ONLY FIELDS ARE THE THIRD KIND, named here so the runtime check agrees with the
   compile-time partition in applicationReview.ts. `options` is what the employer's control OFFERS;
   the employer receives the value she chose and never the menu, so it is neither packet identity
   nor a claim about how the answer got there. */
const DISPLAY_ONLY_QUESTION_FIELDS = ['options', 'answer_draft', 'answer_state'] as const;

test('every question field is classified as packet-visible, provenance or display, exactly once', () => {
  const provenance = new Set<string>([...APPLICANT_CLAIM_FIELDS, ...ANSWER_CLAIM_FIELDS]);
  const classified = new Set<string>([
    ...PACKET_VISIBLE_QUESTION_FIELDS, ...provenance, ...DISPLAY_ONLY_QUESTION_FIELDS,
  ]);

  assert.deepEqual(
    Object.keys(everyQuestionField).filter((field) => !classified.has(field)),
    [],
    'a question field belongs to packet identity, to provenance or to display, and someone has to say which',
  );
  /* THE ONE THAT MATTERS. Hashing the option list would spend every stored acknowledgement the
     first time a board reordered its own menu - a change nobody outside the employer can observe,
     which is exactly the deadlock PACKET_VISIBLE_QUESTION_FIELDS was narrowed to prevent. */
  assert.deepEqual(
    DISPLAY_ONLY_QUESTION_FIELDS.filter((field) => (PACKET_VISIBLE_QUESTION_FIELDS as readonly string[]).includes(field)),
    [],
    'a display-only field must never enter packet identity',
  );
  assert.deepEqual(
    PACKET_VISIBLE_QUESTION_FIELDS.filter((field) => provenance.has(field)),
    [],
    'a field on both lists is hashed or not depending on which branch runs first',
  );
});

test('the packet projection keeps employer-visible fields and drops the provenance record', () => {
  const [visible] = packetVisibleQuestions([everyQuestionField]) as Record<string, unknown>[];

  assert.deepEqual(
    Object.keys(visible).sort(),
    [...PACKET_VISIBLE_QUESTION_FIELDS].sort(),
    'the projection is the allow-list, not the allow-list minus whatever happened to be undefined',
  );
  assert.equal(visible.answer, 'Female', 'the value the employer receives survives');
  assert.equal('answer_source' in visible, false, 'who typed it does not reach the employer');
  assert.equal('answer_reviewed_at' in visible, false, 'nor when she last looked at it');
});

test('an absent optional field and an explicitly undefined one project identically', () => {
  const absent = { id: 'q', question: 'Q', answer: 'A', kind: 'required', required: true } as ApplicationReviewQuestion;
  const explicit = { ...absent, portal_selector: undefined, ats_api_field: undefined };

  assert.deepEqual(packetVisibleQuestions([absent]), packetVisibleQuestions([explicit]),
    'a packet must not change identity because a key was written as undefined rather than omitted');
});

/* Malformed input must stay malformed rather than be reshaped into something that hashes cleanly.
 * bindingIssues runs canonicalPacketJson over the raw questions and rejects them there; a projection
 * that quietly turned a cycle or a class instance into a tidy object would hash a packet nobody
 * could describe. */
test('the projection passes non-question shapes straight through to the canonical-JSON check', () => {
  assert.equal(packetVisibleQuestions(null), null);
  assert.equal(packetVisibleQuestions('not a list'), 'not a list');
  assert.deepEqual(packetVisibleQuestions([null, 'raw']), [null, 'raw']);
});

/* 'skipped' IS ABOUT THE CONTROL, NOT ABOUT THE ANSWER.
 *
 * The merge used to clear answer_state outright whenever an answer was present. For the two machine
 * states that is right: 'unanswered' and 'litos_refused' both say Litos had nothing to type, and an
 * answer settles them. 'skipped' says something the answer cannot settle, because it is the
 * applicant's instruction about the control: "the value is United States, the portal's menu will
 * not take it, leave the field alone." Clearing it made her decision unrepresentable, so discovery
 * re-raised the same question on the next fill and the row never became sendable. */
test('a skipped question keeps its skip when an answer sits beside it', () => {
  // Her reviewed row leads the collision, the way mergeDiscoveredPortalQuestions orders them.
  const merged = normalizeApplicationReviewQuestions([
    {
      id: 'calling-code',
      question: 'Select country calling code',
      answer: 'United States',
      kind: 'required',
      required: false,
      answer_state: 'skipped',
    },
    {
      id: 'calling-code',
      question: 'Select country calling code',
      answer: 'United States',
      kind: 'required',
      required: false,
      portal_selector: 'input[name="calling-code"]',
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.answer_state, 'skipped', 'her skip survives the fresh discovery read');
  assert.equal(merged[0]!.answer, 'United States', 'and the answer beside it is untouched');
});

test('an answer still settles the two machine states', () => {
  for (const state of ['unanswered', 'litos_refused'] as const) {
    const merged = normalizeApplicationReviewQuestions([
      {
        id: 'gpa',
        question: 'Please indicate your overall GPA.',
        answer: '',
        kind: 'required',
        required: false,
        answer_state: state,
      },
      {
        id: 'gpa',
        question: 'Please indicate your overall GPA.',
        answer: '3.89',
        kind: 'required',
        required: false,
      },
    ]);
    assert.equal(merged[0]!.answer, '3.89');
    assert.equal(merged[0]!.answer_state, undefined, `${state} is resolved by an answer arriving`);
  }
});

/* THE HAZARD THIS PAIR OF RULES EXISTS TO CLOSE.
 *
 * normalizeApplicationReviewQuestions reads `question.answer_state ?? existing.answer_state`, so a
 * later row carrying a state wins outright. Discovery re-mints its rows on every run and used to
 * default an optional one to 'unanswered', which is the machine saying "Litos has nothing to type".
 * That default landing on a question the applicant had SKIPPED overwrote her decision one fill
 * later and put the question back in front of her, which is the loop this branch was written to
 * end. The mint now carries her skip forward instead (see unansweredRequiredQuestion in
 * routes/submissionRunner.ts), so the collision below should not arise in practice.
 *
 * This test pins the precedence itself: if a machine state ever reaches the merge beside her skip,
 * the merge is honest about which one it keeps, and a future change to either side has to look at
 * this expectation rather than silently move the answer. */
test('a machine answer_state arriving beside a skip is documented, not silently ignored', () => {
  const merged = normalizeApplicationReviewQuestions([
    {
      id: 'calling-code',
      question: 'Select country calling code',
      answer: 'United States',
      kind: 'required',
      required: false,
      answer_state: 'skipped',
    },
    {
      id: 'calling-code',
      question: 'Select country calling code',
      answer: '',
      kind: 'required',
      required: false,
      answer_state: 'unanswered',
    },
  ]);

  assert.equal(merged.length, 1);
  assert.equal(
    merged[0]!.answer_state,
    'unanswered',
    'the later row still wins the merge, which is why the mint must not emit one over her skip',
  );
});

/* THE WRITE THAT NEVER LANDED.
 *
 * Measured live on DSI Innovations 2026-09-02: the optional country-calling-code question was
 * marked SKIPPED in the dashboard, the UI confirmed "Saved. These answers are on this application
 * now", and the stored row came back with answer_state absent. mergeSubmittedApplicationReviewQuestions
 * is the writer behind PUT /review/answers and it dropped the state whenever an answer was present,
 * so the escape the send gate honours could never be recorded for a question that HAS an answer,
 * which is exactly the shape this question has. */
test('a skip posted beside an answer is actually stored', () => {
  const merged = mergeSubmittedApplicationReviewQuestions(
    [{
      id: 'calling-code',
      question: 'Select country calling code',
      answer: 'United States',
      kind: 'required',
      required: false,
    }],
    [{
      id: 'calling-code',
      question: 'Select country calling code',
      answer: 'United States',
      kind: 'required',
      required: false,
      answer_state: 'skipped',
    }],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.answer_state, 'skipped', 'the dashboard said Saved, so it must be saved');
  assert.equal(merged[0]!.answer, 'United States');
});

test('an answer posted over a machine state still clears it', () => {
  for (const state of ['unanswered', 'litos_refused'] as const) {
    const merged = mergeSubmittedApplicationReviewQuestions(
      [{
        id: 'gpa',
        question: 'Please indicate your overall GPA.',
        answer: '',
        kind: 'required',
        required: false,
        answer_state: state,
      }],
      [{
        id: 'gpa',
        question: 'Please indicate your overall GPA.',
        answer: '3.89',
        kind: 'required',
        required: false,
      }],
    );
    assert.equal(merged[0]!.answer, '3.89');
    assert.equal(merged[0]!.answer_state, undefined, `${state} is settled by her answering`);
  }
});
