/* ── THE REVIEW ROUND THAT BACK-DATED EVERY CLAIM MINTED AFTER THE FIRST SAVE ──────────────────────
 *
 * Measured 2026-09-03 on packet 4a79eec1 (Hudson River Trading, greenhouse). The packet's
 * `questions_reviewed_at` reads 2026-09-01T21:28:12.934Z, and it was still being stamped, that day,
 * onto `answer_reviewed_at` for values written on 2026-09-03. Twelve of its twenty-six answers carry
 * an `applicant_review` claim; every one minted after the first save says she reviewed it on the day
 * of that first save.
 *
 * WHERE IT CAME FROM. Two lines compute the round as `current.questions_reviewed_at ?? now()` -
 * resolveSubmittedApplicationAnswers and PUT /applications/:id/review/answers - so the round is
 * minted once, at the FIRST review a packet ever has, and never advances. The mint then wrote THAT
 * STRING into the per-answer stamp. The round has to stay frozen; the per-answer stamp did not, and
 * borrowing one for the other is the whole defect.
 *
 * WHY THE OBVIOUS FIX IS NOT THE FIX. Advancing the round invalidates every standing claim on the
 * packet at once, because claim validity was keyed on EXACT equality between `answer_reviewed_at`
 * and `questions_reviewed_at` in twelve readers. Re-stamping the carried-forward claims to the new
 * round is worse: that is the blanket stamp behind the 802-answer laundering incident recorded at
 * applicationReview.ts's mint site.
 *
 * SO THE ROUND STOPPED BEING AN EQUALITY KEY AND BECAME THE PACKET'S REVIEW EPOCH. A claim is
 * current when it was made AT OR AFTER the epoch. A later honest timestamp stays valid; a claim left
 * over from a superseded epoch does not. Both directions are pinned below, through all three
 * readers, because the change means nothing if only one of them moved.
 *
 * THE FILE ASSERTS ON THE COMPOSITIONS THE ROUTES RUN, not on the predicate alone. The predicate
 * agreeing with itself is not evidence; what the send path writes to the record is.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { applicantReviewIsCurrent, mintedApplicantReviewAt } from './applicantAnswer';
import {
  mergeSubmittedApplicationReviewQuestions,
  type ApplicationReviewQuestion,
  type ApplicationReviewState,
} from './applicationReview';
import {
  frozenJobEmployerContext,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { resolveSubmittedApplicationAnswers } from './submittedAnswers';
import { coveredOptionProbeFailureIds } from '../routes/submissionRunner';

/** The packet's own round, read from the live record. */
const EPOCH = '2026-09-01T21:28:12.934Z';
/** When she is actually at the keyboard, two days into the same packet. */
const NOW = '2026-09-03T15:19:57.000Z';
/** A round the packet has since moved past, for the superseded direction. */
const SUPERSEDED = '2026-08-11T12:00:00.000Z';

/* The live IMC prior-application label with a profile that declares nothing, which is what makes the
 * resolver HOLD the question - and a held question is the shape where the claim is load-bearing:
 * refreshKnownQuestionAnswers blanks a held answer it cannot attribute to her. Borrowed from
 * submittedAnswers.test.ts, where the same pair pins the 130 packets this round was introduced for. */
const HELD_QUESTION = 'have you applied to this role or another role @imc within the last 12-18 months? as a reminder, '
  + 'if you have already applied for this position during the current recruitment season and were not '
  + 'selected, you may reapply when the next recruitment season begins in 2027.';
const JD_TEXT = frozenJobEmployerContext('IMC');
const NOTHING_DECLARED: ApplicationProfileLike = {};

const held = (answer: string, extra: Partial<ApplicationReviewQuestion> = {}): ApplicationReviewQuestion => ({
  id: 'prior', question: HELD_QUESTION, answer, kind: 'required', required: true, ...extra,
});

/** The send path's own composition, with the clock pinned so the record is deterministic. */
const submit = (
  current: Pick<ApplicationReviewState, 'questions' | 'questions_reviewed_at' | 'jd_text'>,
  submitted: ApplicationReviewQuestion[],
  now = NOW,
) => resolveSubmittedApplicationAnswers({
  current, submitted, profile: NOTHING_DECLARED, now: () => now,
});

test('precondition: the resolver holds this question, so only her claim can keep an answer on it', () => {
  assert.ok(
    'skipReason' in (resolveKnownAnswer(HELD_QUESTION, 'text', NOTHING_DECLARED, JD_TEXT) ?? {}),
    'without this the refresh would keep the answer for its own reasons and prove nothing',
  );
});

/* ── THE REGRESSION GATE ─────────────────────────────────────────────────────────────────────────*/

test('an answer she supplies today is not recorded as reviewed on the day of her first save', () => {
  /* THE DEFECT, BYTE FOR BYTE. On origin/main this returns answer_reviewed_at === EPOCH: a sentence
   * on the record saying she reviewed, on 2026-09-01, bytes that did not exist until 2026-09-03. */
  const { questions, questionsReviewedAt } = submit(
    { questions: [held('')], questions_reviewed_at: EPOCH, jd_text: JD_TEXT },
    [held('No')],
  );

  assert.equal(questions[0].answer, 'No', 'her answer reaches the employer');
  assert.equal(questions[0].answer_source, 'applicant_review', 'and the record says it is hers');
  assert.equal(questions[0].answer_reviewed_at, NOW,
    'REVIEWED WHEN SHE REVIEWED IT, which is the whole of this branch');
  assert.notEqual(questions[0].answer_reviewed_at, EPOCH, 'and never the packet\'s first review');
  assert.equal(questionsReviewedAt, EPOCH,
    'while the ROUND stays frozen, because advancing it is what would invalidate the standing claims');
});

/* ── THE THING THAT MADE THE OBVIOUS FIX UNSAFE, PINNED AS THE REASON IT IS SAFE NOW ─────────────*/

test('the eleven claims already standing survive the twelfth being minted, and are not re-stamped', () => {
  /* THE MEASURED PACKET'S OWN SHAPE: twelve of its twenty-six answers carry an applicant_review
   * claim minted in the first review, and she supplies another one now. Advancing the round would
   * invalidate all twelve at once; re-stamping them to the new time is the 802-answer blanket stamp
   * recorded at the mint site. Neither happens, and BOTH halves are asserted, because a test that
   * only checked the claims were still HONOURED would pass against the laundering.
   *
   * The three self-identifications are the real category: gender, veteran status and ethnicity are
   * named in the laundering incident, and are what the live packet carries. Her profile agrees with
   * each stored value, so nothing here is being recomputed and the only thing under test is what the
   * save does to a claim it carries. */
  const eeoProfile = {
    eeo_prefs: { gender: 'Female', race: 'South Asian', veteran_status: 'No', hispanic: 'No', disability: 'No' },
  } as unknown as ApplicationProfileLike;
  const standing = (question: string, answer: string): ApplicationReviewQuestion => ({
    id: question,
    question,
    answer,
    kind: 'required',
    required: true,
    answer_source: 'applicant_review',
    answer_reviewed_at: EPOCH,
  });
  const stored = [
    standing('What is your gender?', 'Female'),
    standing('Veteran status', 'No'),
    standing('Are you Hispanic or Latino?', 'No'),
    held(''),
  ];

  const { questions, questionsReviewedAt } = resolveSubmittedApplicationAnswers({
    current: { questions: stored, questions_reviewed_at: EPOCH, jd_text: JD_TEXT } as never,
    // The review screen posts back the whole list it was shown, untouched but for the one she filled.
    submitted: [...stored.slice(0, 3), held('No')],
    profile: eeoProfile,
    now: () => NOW,
  });

  assert.equal(questionsReviewedAt, EPOCH, 'the round does not advance, so nothing standing is cut off');
  for (const question of stored.slice(0, 3)) {
    const row = questions.find((candidate) => candidate.id === question.id)!;
    assert.equal(row.answer, question.answer, `${question.id} still holds her value`);
    assert.equal(row.answer_source, 'applicant_review', `${question.id}'s standing claim still stands`);
    assert.equal(row.answer_reviewed_at, EPOCH,
      `${question.id} keeps the time she ACTUALLY reviewed it, rather than being re-stamped to now`);
    assert.ok(applicantReviewIsCurrent(row.answer_reviewed_at, questionsReviewedAt),
      `${question.id}'s claim is still current, which is what the frozen round buys`);
  }
  const fresh = questions.find((question) => question.id === 'prior')!;
  assert.equal(fresh.answer, 'No', 'the answer she just supplied survives to the employer');
  assert.equal(fresh.answer_reviewed_at, NOW, 'and it alone carries now');
});

/* ── BOTH DIRECTIONS, THROUGH ALL THREE READERS ──────────────────────────────────────────────────*/

test('reader 1 of 3, the merge: a later claim is carried forward and a superseded one is stripped', () => {
  /* provenanceMatchesCurrentReview, via exactReviewedIdentityUnchanged: an untouched save carries a
   * current claim forward and strips one it can no longer check. */
  const claimed = (at: string) => held('No', { answer_source: 'applicant_review', answer_reviewed_at: at });

  const [carried] = mergeSubmittedApplicationReviewQuestions(
    [claimed(NOW)], [held('No')], EPOCH, undefined, NOW,
  );
  assert.equal(carried.answer_reviewed_at, NOW, 'a claim made AFTER the epoch opened is still hers');
  assert.equal(carried.answer_source, 'applicant_review');

  const [stripped] = mergeSubmittedApplicationReviewQuestions(
    [claimed(SUPERSEDED)], [held('No')], EPOCH, undefined, NOW,
  );
  assert.equal(stripped.answer_source, undefined,
    'and a claim from a round the packet has moved past is not a claim the merge will carry');
  assert.equal(stripped.answer_reviewed_at, undefined);
});

test('reader 2 of 3, the refresh: a later claim keeps her answer and a superseded one does not', () => {
  /* applicantReviewedCurrentAnswer in refreshKnownQuestionAnswers. The resolver HOLDS this label, so
   * the answer survives on the claim alone - which makes the answer itself the readout. */
  const [kept] = refreshKnownQuestionAnswers(
    [held('No', { answer_source: 'applicant_review', answer_reviewed_at: NOW })],
    NOTHING_DECLARED, JD_TEXT, EPOCH,
  );
  assert.equal(kept.answer, 'No', 'her answer survives the request that reaches the employer');

  const [blanked] = refreshKnownQuestionAnswers(
    [held('No', { answer_source: 'applicant_review', answer_reviewed_at: SUPERSEDED })],
    NOTHING_DECLARED, JD_TEXT, EPOCH,
  );
  assert.equal(blanked.answer, '',
    'and a claim the packet has moved past cannot hold an answer on a question Litos refuses to answer');
});

test('reader 3 of 3, the runner: a later claim covers a failed option probe and a superseded one does not', () => {
  /* applicantChoseStoredAnswerInRound, reached through coveredOptionProbeFailureIds - the exported
   * reader that decides whether a control whose option list could not be read this run is a WALL or
   * is already covered by an answer she chose herself. */
  const failures = [{ controlId: 'c1', reason: 'option probe failed' }];
  const failedFields = [{ controlId: 'c1', label: HELD_QUESTION }];
  const chosen = (at: string) => [held('No', { answer_source: 'applicant_review', answer_reviewed_at: at })];

  assert.deepEqual(
    [...coveredOptionProbeFailureIds(failures, failedFields, chosen(NOW), EPOCH)],
    ['c1'],
    'her answer from today needs no list read, so the failure is covered rather than a wall',
  );
  assert.deepEqual(
    [...coveredOptionProbeFailureIds(failures, failedFields, chosen(SUPERSEDED), EPOCH)],
    [],
    'and a claim from a superseded epoch covers nothing, exactly as a mismatched round did',
  );
});

/* ── THE SAFETY ARGUMENT THIS LANDED ON ──────────────────────────────────────────────────────────*/

test('the epoch reading accepts everything exact equality accepted', () => {
  /* WHY THIS COULD LAND UNDER STANDING CLAIMS. The only records it newly admits are those stamped
   * strictly AFTER the round, and no writer in the repo could produce one before this branch: every
   * mint wrote the round itself, applyApplicantReviewedAnswers advances the round and re-stamps in
   * the same breath, and questionSchema strips both provenance keys so no caller can inject one. So
   * the read change is purely additive on live data, and the equality arm below keeps that true even
   * for a round that is not parseable as a date. */
  assert.ok(applicantReviewIsCurrent(EPOCH, EPOCH), 'the shape every live claim is in');
  assert.ok(applicantReviewIsCurrent('some-other-review-round', 'some-other-review-round'),
    'including one whose round no clock can read');

  assert.ok(applicantReviewIsCurrent(NOW, EPOCH), 'at or AFTER is current');
  assert.equal(applicantReviewIsCurrent(SUPERSEDED, EPOCH), false, 'and before is not');

  assert.equal(applicantReviewIsCurrent(undefined, EPOCH), false, 'no claim is not a claim');
  assert.equal(applicantReviewIsCurrent(NOW, undefined), false, 'and no round is nothing to measure against');
  assert.equal(applicantReviewIsCurrent(NOW, 'some-other-review-round'), false,
    'an unreadable round is thrown away rather than trusted, matching every reader before this');
});

test('a claim minted right now is current by construction, even against a round in the future', () => {
  /* THE CLAMP. A packet whose stored round is ahead of the clock - a machine time corrected
   * backwards - would otherwise mint a claim its own readers refuse: 200 returned, nothing recorded,
   * which is the CONFIRM loop this codebase has already paid for twice. */
  const future = '2027-01-01T00:00:00.000Z';
  assert.equal(mintedApplicantReviewAt(NOW, future), future, 'the clamp costs the round\'s own timestamp');
  assert.ok(applicantReviewIsCurrent(mintedApplicantReviewAt(NOW, future), future));
  assert.equal(mintedApplicantReviewAt(NOW, EPOCH), NOW, 'and an ordinary packet just gets the clock');

  const { questions, questionsReviewedAt } = submit(
    { questions: [held('')], questions_reviewed_at: future, jd_text: JD_TEXT },
    [held('No')],
  );
  assert.equal(questions[0].answer, 'No', 'so her answer survives the refresh on that packet too');
  assert.ok(applicantReviewIsCurrent(questions[0].answer_reviewed_at, questionsReviewedAt));
});
