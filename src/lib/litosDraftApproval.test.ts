import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  blankRequiredQuestionLabels,
  pendingRequiredQuestionLabels,
  submissionQuestionGate,
  unapprovedLitosDraftQuestionLabels,
} from './submissionSafety';
import {
  applyApplicantReviewedAnswers,
  mergeSubmittedApplicationReviewQuestions,
  type ApplicationReviewQuestion,
  type ApplicationReviewState,
} from './applicationReview';
import { applicantChoseStoredAnswer } from './applicantAnswer';
import { readFileSync } from 'node:fs';

const DRAFT_TEXT = 'The system I would point to is the ingestion pipeline I built at Acme Labs.';
const LABEL = 'describe a multimodal/cv system you personally shipped to production, and your role in it.';

const drafted = (over: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion => ({
  id: 'q-draft',
  question: LABEL,
  answer: DRAFT_TEXT,
  kind: 'essay',
  required: true,
  answer_source: 'litos_draft',
  ...over,
});

const review = (questions: ApplicationReviewQuestion[]): Pick<ApplicationReviewState, 'questions' | 'question_metadata_blockers'> => ({
  questions,
  question_metadata_blockers: [],
});

describe('an unapproved Litos draft cannot satisfy the send gate', () => {
  test('the gate names it, and refuses to be clear', () => {
    const gate = submissionQuestionGate(review([drafted()]));
    assert.deepEqual(gate.draftQuestionLabels, [LABEL]);
    assert.deepEqual(gate.requiredQuestionLabels, [LABEL]);
    assert.equal(gate.clear, false);
  });

  test('an OPTIONAL draft is held too: they are her words either way', () => {
    // undecidedOptionalQuestionLabels cannot reach this shape - a draft has a non-blank answer and
    // no answer_state, so that check reports it decided. This is why the draft list is its own.
    const gate = submissionQuestionGate(review([drafted({ required: false })]));
    assert.deepEqual(gate.optionalQuestionLabels, []);
    assert.deepEqual(gate.draftQuestionLabels, [LABEL]);
    assert.equal(gate.clear, false);
  });

  test('the box is NOT blank, so the blank-answer reader must not claim it is', () => {
    assert.deepEqual(blankRequiredQuestionLabels([drafted()]), []);
    assert.deepEqual(pendingRequiredQuestionLabels([drafted()]), [LABEL]);
  });

  test('a blank required answer and a draft are counted once each, never twice', () => {
    const blank = drafted({ id: 'q-blank', question: 'Graduation month', answer: '', answer_source: undefined });
    assert.deepEqual(pendingRequiredQuestionLabels([blank, drafted()]), ['Graduation month', LABEL]);
  });

  test('an approved answer clears it', () => {
    const gate = submissionQuestionGate(review([drafted({ answer_source: 'applicant_review', answer_reviewed_at: 'T' })]));
    assert.deepEqual(gate.draftQuestionLabels, []);
    assert.equal(gate.clear, true);
  });

  test('no reader mistakes a draft for something she chose', () => {
    assert.equal(applicantChoseStoredAnswer({ answer: DRAFT_TEXT, answer_source: 'litos_draft' }), false);
  });
});

describe('approving a draft makes it her answer, and nothing else does', () => {
  const reviewedAt = '2026-09-02T04:00:00.000Z';

  test('an explicit per-question confirmation mints applicant_review over the marker', () => {
    const [merged] = mergeSubmittedApplicationReviewQuestions(
      [drafted()],
      [{ ...drafted(), confirmed: true }],
      reviewedAt,
      undefined,
      // She approved at the moment the epoch opened: this packet's first review.
      reviewedAt,
    );
    assert.equal(merged.answer_source, 'applicant_review');
    assert.equal(merged.answer_reviewed_at, reviewedAt);
    assert.equal(merged.answer, DRAFT_TEXT);
    assert.deepEqual(unapprovedLitosDraftQuestionLabels([merged]), []);
  });

  test('editing the words mints the same claim', () => {
    const [merged] = mergeSubmittedApplicationReviewQuestions(
      [drafted()],
      [{ ...drafted(), answer: 'I rewrote this in my own words.' }],
      reviewedAt,
    );
    assert.equal(merged.answer_source, 'applicant_review');
    assert.equal(merged.answer, 'I rewrote this in my own words.');
  });

  test('AN UNTOUCHED SAVE LAUNDERS NOTHING: the marker survives it', () => {
    // The review screen posts back the whole list it was shown. Without the carry-forward the
    // strip would leave answer_source absent, which every reader treats as an ordinary machine
    // answer, and the gate above would open on a paragraph she never read.
    const [merged] = mergeSubmittedApplicationReviewQuestions([drafted()], [drafted()], reviewedAt);
    assert.equal(merged.answer_source, 'litos_draft');
    assert.deepEqual(unapprovedLitosDraftQuestionLabels([merged]), [LABEL]);
  });

  test('a save that never mentions the drafted question leaves it a draft', () => {
    const other: ApplicationReviewQuestion = {
      id: 'q-other', question: 'Work authorization', answer: 'Yes', kind: 'required', required: true,
    };
    const merged = mergeSubmittedApplicationReviewQuestions([drafted(), other], [other], reviewedAt);
    assert.equal(merged.find((question) => question.id === 'q-draft')?.answer_source, 'litos_draft');
  });

  test('the blanket review stamp does not claim a draft as hers', () => {
    const state = { questions: [drafted()], updated_at: 'x' } as unknown as ApplicationReviewState;
    const next = applyApplicantReviewedAnswers(state, [drafted()], reviewedAt);
    assert.equal(next.questions[0].answer_source, 'litos_draft');
    assert.equal(next.questions[0].answer_reviewed_at, undefined);
  });

  test('the blanket stamp still claims every ordinary answer', () => {
    const ordinary: ApplicationReviewQuestion = {
      id: 'q-o', question: 'Work authorization', answer: 'Yes', kind: 'required', required: true,
    };
    const state = { questions: [ordinary], updated_at: 'x' } as unknown as ApplicationReviewState;
    assert.equal(applyApplicantReviewedAnswers(state, [ordinary], reviewedAt).questions[0].answer_source, 'applicant_review');
  });
});

/* THE SENTENCE SHE READS WHEN THE GATE HOLDS. A draft is not a blank, and telling her a required
 * box is empty when it holds a paragraph Litos wrote sends her looking for the wrong field. Every
 * send-facing refusal that can now be caused by a draft says so. */
describe('a held send says a draft is waiting on her, not that a box is blank', () => {
  const routes = readFileSync('src/routes/applications.ts', 'utf8');
  const runner = readFileSync('src/routes/submissionRunner.ts', 'utf8');

  test('the approve route asks for approval, and keeps the blank sentence for real blanks', () => {
    assert.match(routes, /Approve or change the answer Litos drafted for you before sending\./);
    assert.match(routes, /approvalQuestionGate\.requiredQuestionLabels\.length > approvalQuestionGate\.draftQuestionLabels\.length/);
  });

  test('the submit and handoff 422s name approval when a draft caused them', () => {
    assert.match(routes, /Approve or change the answers Litos drafted for you, and answer every required question, before submitting\./);
    assert.match(routes, /Approve or change the answers Litos drafted for you, and answer every required question, before completing this handoff\./);
    // The original sentences survive for the case they were written for.
    assert.match(routes, /'Answer every required question before submitting\.'/);
    assert.match(routes, /'Answer every required question before completing this handoff\.'/);
  });

  test('the runner writes an approval sentence rather than an unanswered one', () => {
    assert.match(runner, /const unapprovedDrafts = questionGate\.draftQuestionLabels;/);
    assert.match(runner, /answer\$\{unapprovedDrafts\.length === 1 \? '' : 's'\} Litos drafted for you/);
    assert.match(runner, /still waiting on your approval, so this was not sent/);
  });

  test('both prepare decisions count a draft as an unanswered required question', () => {
    assert.match(runner, /const unansweredRequiredQuestions = pendingRequiredQuestionLabels\(mergedQuestions\)/);
    assert.match(runner, /unansweredRequiredCount: pendingRequiredQuestionLabels\(mergedQuestions\)\.length/);
  });
});
