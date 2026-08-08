import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { ExperienceBankEntry } from '../db/schema';
import type { ResumeSpec } from '../llm/resumeSpec';
import {
  deriveEditedTerms,
  finalApprovalCoverLetterIssue,
  finalApprovalFieldIssues,
  mergeSubmittedApplicationReviewQuestions,
  normalizeApplicationReviewQuestions,
  readApplicationReview,
  type ApplicationReviewState,
} from './applicationReview';

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
