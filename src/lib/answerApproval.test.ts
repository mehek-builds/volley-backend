/* THE APPROVAL DECISION, TESTED WHERE IT IS MADE.
 *
 * answerApproval.ts is pure and storage-free so that this is possible, and the route suite
 * (routes/draftedAnswerApproval.test.ts) covers what reaches the row. The two are not redundant: the
 * route writes the approved record back BY POSITION, which independently prevents a sibling being
 * stamped, so a route test cannot tell a correct decision from a wrong one that the route happens to
 * mask. This function is exported and the next caller will not necessarily have that guard.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { approveDraftedAnswer } from './answerApproval';
import type { ApplicationReviewQuestion } from './applicationReview';

const REVIEWED_AT = '2026-08-13T11:30:00.000Z';
const NOW = '2026-08-13T12:00:00.000Z';

function drafted(overrides: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion {
  return {
    id: 'excites-you',
    question: 'What excites you about Deepgram?',
    answer: 'A machine-written draft.',
    kind: 'essay',
    required: true,
    ...overrides,
  };
}

/* DUPLICATE STORED IDS ARE REPRESENTABLE, AND THE STAMP WENT ONTO ALL OF THEM.
 *
 * questionSchema takes a fully client-chosen id (`z.string().min(1).max(200)`, applications.ts) and
 * normalizeApplicationReviewQuestions dedupes on question TEXT, never on id. So two stored records
 * can share an id while holding different questions and different answers. This function found ONE
 * record and validated the applicant's text against that one, then wrote the approval with
 * `questions.map(q => q.id === target.id ? ... : q)` - every record sharing the id. The sibling that
 * came out of that carried "she read this and let it stand" over an answer that was never displayed
 * to her and never validated against anything.
 *
 * mergeSubmittedApplicationReviewQuestions already refuses to match ambiguous duplicate ids, for
 * this exact reason. Indexing the write on the found record's POSITION is what makes the record that
 * was validated and the record that is stamped the same object.
 */
test('an approval stamps the record it validated, not every record sharing its id', () => {
  const target = drafted();
  const sibling = drafted({
    question: 'Why are you a fit for this team?',
    answer: 'A second machine-written draft, which nobody has read.',
  });

  const outcome = approveDraftedAnswer({
    current: { questions: [target, sibling], questions_reviewed_at: REVIEWED_AT },
    questionId: target.id,
    answer: target.answer,
    now: () => NOW,
  });

  assert.equal(outcome.approved, true);
  if (!outcome.approved) return;
  assert.equal(outcome.approvedIndex, 0, 'the first record carrying the id is the one that was validated');
  assert.equal(outcome.questions[0].answer_approved_at, NOW);
  assert.equal(outcome.questions[1].answer_approved_at, undefined,
    'the sibling was never displayed and never validated, so it cannot be approved');
  assert.equal(outcome.questions[1].answer_reviewed_at, undefined);
  assert.equal(outcome.questions[1], sibling,
    'and it is returned by reference, which is the strongest form of untouched');
});

/* The approval names a POSITION, and the route relies on it to write into a different list than the
 * one it passed in: it approves against the refreshed view the screen was served, and persists into
 * the stored row. A caller that had to re-find the record would reintroduce the ambiguity above. */
test('the approval says which record it stamped', () => {
  const first = drafted({ id: 'gender', question: 'Gender', answer: 'Female', kind: 'required' });
  const target = drafted();

  const outcome = approveDraftedAnswer({
    current: { questions: [first, target], questions_reviewed_at: REVIEWED_AT },
    questionId: target.id,
    answer: target.answer,
    now: () => NOW,
  });

  assert.equal(outcome.approved, true);
  if (!outcome.approved) return;
  assert.equal(outcome.approvedIndex, 1);
  assert.equal(outcome.questions[0], first, 'every other record is returned by reference');
});

/* THE REFUSALS, which are the point of the design rather than edge cases. Kept here beside the
 * decision so a change to any of them shows up without a database. */
test('an answer that is not the one the screen showed is refused', () => {
  const outcome = approveDraftedAnswer({
    current: { questions: [drafted()], questions_reviewed_at: REVIEWED_AT },
    questionId: 'excites-you',
    answer: 'Words from a draft that has since been rewritten.',
    now: () => NOW,
  });

  assert.deepEqual(outcome, { approved: false, reason: 'answer_moved' });
});

test('a blank answer is the question still being asked, and is not approvable', () => {
  const outcome = approveDraftedAnswer({
    current: { questions: [drafted({ answer: '' })], questions_reviewed_at: REVIEWED_AT },
    questionId: 'excites-you',
    answer: '',
    now: () => NOW,
  });

  assert.deepEqual(outcome, { approved: false, reason: 'nothing_to_approve' });
});

/* An approval writes no `answer_source`. Litos wrote the words, and the record must not acquire a
 * sentence saying the applicant did: that is the blanket-stamp regression this whole design exists
 * to keep shut. */
test('approving records no authorship', () => {
  const outcome = approveDraftedAnswer({
    current: { questions: [drafted()], questions_reviewed_at: REVIEWED_AT },
    questionId: 'excites-you',
    answer: 'A machine-written draft.',
    now: () => NOW,
  });

  assert.equal(outcome.approved, true);
  if (!outcome.approved) return;
  assert.equal(outcome.questions[0].answer_source, undefined);
  assert.equal(outcome.questions[0].answer_reviewed_at, REVIEWED_AT, 'anchored to the round on the packet');
  assert.equal(outcome.questionsReviewedAt, REVIEWED_AT, 'which existed, so nothing was minted');
});
