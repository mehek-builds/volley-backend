/* THE 130 PACKETS THE PREVIOUS FIX DID NOT REACH.
 *
 * mergeSubmittedApplicationReviewQuestions learned to record an answer the applicant supplied for a
 * question the resolver holds, so that refreshKnownQuestionAnswers - which runs on its output at the
 * same call site and blanks every held answer it cannot attribute to her - would leave it alone. The
 * record is `answer_source: 'applicant_review'` plus an `answer_reviewed_at`, and the clause that
 * writes it is gated on a review round existing to key it to.
 *
 * That round is `questions_reviewed_at`, and it is written only by a save through the review routes.
 * On 2026-08-12, 130 of the 134 packets carrying a resolver-held question had never had one: NULL.
 * So on all 130 the answer she typed was adopted by the merge, left with nothing to say where it
 * came from, and erased one line later - on POST /submit-request, the request that reaches the
 * employer. The fix was live and repaired 4 packets.
 *
 * These tests are written against the same composition the route runs, in the one function that now
 * runs it, so the round the merge is keyed to, the round the refresh checks, and the round that gets
 * persisted cannot drift apart in three separate edits.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ApplicationReviewQuestion, ApplicationReviewState } from './applicationReview';
import { frozenJobEmployerContext, resolveKnownAnswer, type ApplicationProfileLike } from './questionDiscovery';
import { resolveSubmittedApplicationAnswers } from './submittedAnswers';

/* The live IMC prior-application question, and a profile that declares nothing about it. Together
 * they are what makes the resolver hold this label, which is the precondition every case below
 * depends on and the first assertion checks. */
const HELD_QUESTION = 'have you applied to this role or another role @imc within the last 12-18 months? as a reminder, '
  + 'if you have already applied for this position during the current recruitment season and were not '
  + 'selected, you may reapply when the next recruitment season begins in 2027.';
const JD_TEXT = frozenJobEmployerContext('IMC');
const NOTHING_DECLARED: ApplicationProfileLike = {};
const MINTED_ROUND = '2026-08-13T09:15:00.000Z';

function storedQuestion(answer: string): ApplicationReviewQuestion {
  return { id: 'prior', question: HELD_QUESTION, answer, kind: 'required', required: true };
}

/** A packet that has never been through a review save, which is the shape 130 of the 134 were in. */
function neverReviewed(
  questions: ApplicationReviewQuestion[],
): Pick<ApplicationReviewState, 'questions' | 'questions_reviewed_at' | 'jd_text'> {
  return { questions, questions_reviewed_at: undefined, jd_text: JD_TEXT };
}

function submit(
  current: Pick<ApplicationReviewState, 'questions' | 'questions_reviewed_at' | 'jd_text'>,
  submitted: ApplicationReviewQuestion[],
) {
  return resolveSubmittedApplicationAnswers({
    current,
    submitted,
    profile: NOTHING_DECLARED,
    now: () => MINTED_ROUND,
  });
}

test('precondition: the resolver still refuses to answer this question from this profile', () => {
  assert.ok(
    'skipReason' in (resolveKnownAnswer(HELD_QUESTION, 'text', NOTHING_DECLARED, JD_TEXT) ?? {}),
    'without the hold there is nothing for the refresh to blank and these tests prove nothing',
  );
});

test('an answer typed on a packet that has never been reviewed reaches the employer', () => {
  const { questions, questionsReviewedAt } = submit(
    neverReviewed([storedQuestion('')]),
    [storedQuestion('No')],
  );

  assert.equal(questions[0].answer, 'No', 'the answer she typed is what the form gets filled with');
  assert.equal(questions[0].answer_source, 'applicant_review', 'and the record says who it came from');
  assert.equal(questions[0].answer_reviewed_at, MINTED_ROUND);
  assert.equal(
    questionsReviewedAt,
    MINTED_ROUND,
    'the round is handed back so it is persisted beside the claim that is keyed to it',
  );
});

/* THE HALF THAT MAKES THE OTHER HALF READABLE. A per-answer `answer_reviewed_at` beside a review
 * carrying a different round, or none, is a claim every reader discards - which is the state this is
 * fixing, so writing one without the other would only move the defect. */
test('the round the answer is stamped with is the round the caller is told to persist', () => {
  const { questions, questionsReviewedAt } = submit(
    neverReviewed([storedQuestion('')]),
    [storedQuestion('No')],
  );
  assert.equal(questions[0].answer_reviewed_at, questionsReviewedAt);
});

/* AND LITOS STILL INVENTS NOTHING. The hold exists so a question only she can answer is handed back
 * blank rather than guessed at, and a fresh review round must not turn "she left it alone" into "she
 * answered it". */
test('an unanswered hold stays unanswered and claims no applicant behind it', () => {
  const { questions } = submit(neverReviewed([storedQuestion('')]), [storedQuestion('')]);

  assert.equal(questions[0].answer, '', 'nothing was supplied, so nothing is filled in');
  assert.equal(questions[0].answer_source, undefined);
  assert.equal(questions[0].answer_reviewed_at, undefined);
});

/* THE RESOLVER-REFUSES BEHAVIOUR, OTHERWISE UNCHANGED. A value an earlier run drafted and a client
 * posted straight back has been reviewed by nobody. Stamping it would assert a review that did not
 * happen and would disarm the runner's stale-drafted-answer guard, which reads this exact field, so
 * it is still blanked on a packet with no review round just as it was before. */
test('a replayed machine-drafted answer is still refused rather than promoted to an applicant review', () => {
  const drafted = 'A paragraph an earlier build drafted.';
  const stored = { ...storedQuestion(drafted), kind: 'essay' as const };

  const { questions } = submit(neverReviewed([stored]), [stored]);

  assert.equal(questions[0].answer, '', 'an answer nobody can vouch for is still cleared');
  assert.equal(questions[0].answer_source, undefined, 'a replayed answer is not an applicant review');
});

/* REPLACING an existing held answer is now inside the claim, which is the design decision the
 * comment here used to defer to a later branch.
 *
 * What it cost while it was deferred: she could answer a held question once and never correct it. A
 * "No" she needed to change to "Yes" was adopted by the merge, recorded as nobody's, and blanked by
 * refreshKnownQuestionAnswers on the request that reaches the employer - so the correction was not
 * merely ignored, it took the original answer down with it and left the field empty on a live form.
 *
 * The laundering this used to guard against is still guarded, one test up: a REPLAYED answer is
 * byte-identical, so `answerUnchanged` holds and nothing is minted. Changed-by-this-request is the
 * gate, not non-empty. See applicantSuppliedAnswer. */
test('editing an existing held answer is the applicant\'s answer and survives the send', () => {
  const { questions, questionsReviewedAt } = submit(
    neverReviewed([storedQuestion('No')]),
    [storedQuestion('Yes')],
  );

  assert.equal(questions[0].answer, 'Yes', 'her correction reaches the employer instead of a blank');
  assert.equal(questions[0].answer_source, 'applicant_review');
  assert.equal(questions[0].answer_reviewed_at, questionsReviewedAt,
    'keyed to the round the packet also carries, or the refresh cannot check it');
});

/* THE 4 PACKETS THAT ALREADY WORKED, PROVED TO STILL WORK THE SAME WAY. Where a round is stored,
 * that is the round used, and nothing about this packet's behaviour moved. */
test('a packet that has been reviewed before keeps its stored round rather than minting a new one', () => {
  const storedRound = '2026-08-11T12:00:00.000Z';
  const { questions, questionsReviewedAt } = submit(
    { questions: [storedQuestion('')], questions_reviewed_at: storedRound, jd_text: JD_TEXT },
    [storedQuestion('No')],
  );

  assert.equal(questionsReviewedAt, storedRound, 'the stored round is not replaced by a fresh one');
  assert.equal(questions[0].answer, 'No');
  assert.equal(questions[0].answer_reviewed_at, storedRound);
});

/* A claim from an EARLIER round is not carried by the new one. The stored round is what a stored
 * claim is checked against, and a packet with no stored round has no valid claim to check - so an
 * `answer_reviewed_at` left on a row from some other round must not be honoured just because this
 * request minted a round of its own. */
test('a stale per-answer claim is not revived by the round this submit mints', () => {
  const stale: ApplicationReviewQuestion = {
    ...storedQuestion('A paragraph an earlier build drafted.'),
    kind: 'essay',
    answer_source: 'applicant_review',
    answer_reviewed_at: '2026-07-01T00:00:00.000Z',
  };

  const { questions } = submit(neverReviewed([stale]), [{ ...stale, answer: stale.answer }]);

  assert.equal(questions[0].answer, '', 'a claim keyed to a round the packet does not hold proves nothing');
  assert.equal(questions[0].answer_source, undefined);
});
