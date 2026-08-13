/**
 * APPROVING AN ANSWER LITOS WROTE, WHICH IS A DIFFERENT ACT FROM WRITING ONE.
 *
 * THE DEFECT. A packet is held when a drafted answer needs review: `attention_reason` says so and
 * the status stays needs_attention. The only affordance the applicant had was REVIEW, which opens
 * the answers screen, and the Save there now writes - but a save cannot clear that hold, because the
 * merge's claim rule (`applicantSuppliedAnswer`) mints a claim ONLY where she filled a BLANK.
 * Approving a draft is not filling a blank, so nothing was stamped and the hold stood. Measured on
 * packet b18f1842 on 2026-08-13: `questions_reviewed_at` written, 0 of 9 answers carrying any
 * per-answer claim, both drafted-answer holds still up.
 *
 * THE NARROW RULE IS NOT WIDENED, AND MUST NOT BE. It is narrow because a previous version stamped
 * every answer carrying content, which across the 272 live rows with no stored round would have
 * attributed 802 machine-written answers to the applicant - gender, disability status, veteran
 * status, sponsorship, compensation expectations. Widening the blank-filling rule to cover approval
 * would re-open exactly that, because "has content" and "is a draft she has looked at" are the same
 * predicate on a packet full of resolved answers.
 *
 * SO APPROVAL IS ITS OWN ACT, ONE ANSWER PER REQUEST, NAMED BY ITS OWN FIELD. `answer_approved_at`
 * says she read this text and let it stand. `answer_source` still says where the text came from, and
 * on an approved draft it stays ABSENT, because the text came from Litos. See the field's own
 * comment in applicationReview.ts for why that is a field and not a third `answer_source` value.
 *
 * WHAT IT REFUSES, AND WHY EACH REFUSAL IS THE POINT RATHER THAN AN EDGE CASE:
 *
 *   the answer moved      She approves TEXT, not a row id. If the stored answer is not the text the
 *                         screen showed her, a run rewrote it underneath her and an approval would
 *                         record a sign-off on words she never read. This is the whole difference
 *                         between an approval and a checkbox.
 *   nothing to approve    A blank answer is the question still being asked. There is nothing to
 *                         approve and approving it would clear a hold over an empty box.
 *   already approved      Idempotent rather than refused: the same approval twice is one approval,
 *                         and the second must not move the timestamp, because a re-poll of the same
 *                         screen must not look like a second reading.
 *
 * Pure and storage-free so the decision can be tested without a database, and so the route cannot
 * quietly acquire a second definition of any of it.
 */

import type { ApplicationReviewQuestion, ApplicationReviewState } from './applicationReview';

export type AnswerApprovalRefusal = 'question_not_found' | 'answer_moved' | 'nothing_to_approve';

export type AnswerApprovalResult =
  | { approved: true; questions: ApplicationReviewQuestion[]; questionsReviewedAt: string; alreadyApproved: boolean }
  | { approved: false; reason: AnswerApprovalRefusal };

/** The sentence each refusal is reported to the applicant with. Named here so the route has none. */
export const ANSWER_APPROVAL_REFUSALS: Record<AnswerApprovalRefusal, string> = {
  question_not_found: 'That question is not on this application any more',
  answer_moved: 'Litos rewrote this answer while you were reading it, so it was not approved. Read the new one and approve that.',
  nothing_to_approve: 'There is no answer on this question yet, so there is nothing to approve',
};

export function approveDraftedAnswer(options: {
  current: Pick<ApplicationReviewState, 'questions' | 'questions_reviewed_at'>;
  questionId: string;
  /* THE EXACT TEXT THE SCREEN SHOWED. Not optional and not advisory: it is what makes this an
   * approval of an answer rather than of a row. See `answer_moved` above. */
  answer: string;
  now?: () => string;
}): AnswerApprovalResult {
  const now = options.now ?? (() => new Date().toISOString());
  const questions = options.current.questions ?? [];
  const target = questions.find((question) => question.id === options.questionId);
  if (!target) return { approved: false, reason: 'question_not_found' };
  if (!target.answer.trim()) return { approved: false, reason: 'nothing_to_approve' };
  if (target.answer !== options.answer) return { approved: false, reason: 'answer_moved' };

  /* THE ROUND, MINTED HERE IF THE PACKET HAS NONE, exactly as the answers route mints it and for the
   * same reason: `answer_approved_at` is an applicant-claim and is only readable beside the
   * `questions_reviewed_at` it is anchored to. 272 of the 286 live needs_attention rows carry no
   * round, so an approval that reused an absent one would write a claim the merge discards on the
   * next save. Minting cannot invalidate anything: a packet with no round has no per-answer claim
   * anchored to one either. */
  const questionsReviewedAt = options.current.questions_reviewed_at ?? now();
  const alreadyApproved = typeof target.answer_approved_at === 'string'
    && target.answer_reviewed_at === questionsReviewedAt;
  const approvedAt = alreadyApproved ? target.answer_approved_at! : now();

  return {
    approved: true,
    alreadyApproved,
    questionsReviewedAt,
    /* ONE ANSWER CHANGES AND EVERY OTHER RECORD IS RETURNED BY REFERENCE. Not a convenience: the
     * regression this fix exists beside was a write that touched answers it was not aimed at, and
     * the cheapest way to be sure this one cannot is for it to construct exactly one new object. */
    questions: questions.map((question) => (question.id === target.id
      ? { ...question, answer_approved_at: approvedAt, answer_reviewed_at: questionsReviewedAt }
      : question)),
  };
}
