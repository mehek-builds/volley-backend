/* THE WHOLE SEND PATH OVER ONE REAL PACKET, BECAUSE ONE PASS OF THE GATE PROVES NOTHING.
 *
 * The gate this change fixes is not called on the stored questions. It is called on what those
 * questions SETTLE TO after the send path has composed them: resolveSubmittedApplicationAnswers
 * merges and refreshes, then resolvePacketAuditQuestionFixpoint runs the refresh and the
 * closed-choice re-open repeatedly until nothing moves. A guard computed inside that transform can
 * be undone by the next pass, so a unit test of the predicate can pass while the packet is still
 * refused. This file runs the composition and then asks the send gate, in that order.
 *
 * THE PACKET, read from production on 2026-09-04:
 *
 *   packet                4a79eec1-5c65-4dd4-8e72-e119fbfbd733 (Hudson River Trading, greenhouse)
 *   status                ready_for_final_approval
 *   questions_reviewed_at 2026-09-01T21:28:12.934Z
 *
 *   "will you now, or in the future, require visa sponsorship ...?"
 *       answer "Yes",   answer_source applicant_review, answer_reviewed_at = the round above
 *   "what is your gender?"
 *       answer "Woman", answer_source applicant_review, answer_reviewed_at = the round above,
 *       answer_override_of "Female"
 *
 * WHAT THIS CHANGE DOES AND DOES NOT CLEAR, stated as assertions rather than as a claim in a PR
 * body, because the two questions fail for different reasons and only one of them is this change's:
 *
 *   sponsorship   the resolver DECLINES the label (three countries), so there is no profile value
 *                 to contradict and her own current-round review settles it. CLEARED here.
 *   gender        the resolver ANSWERS "Female" from her eeo_prefs and the packet holds "Woman",
 *                 which is the same declaration in the control's own vocabulary. The value branch
 *                 compares bytes and still refuses. NOT cleared here, and deliberately so: this
 *                 change must not touch the branch that cross-checks against her profile.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeApplicationReviewQuestions, type ApplicationReviewQuestion, type ApplicationReviewState, type SubmittedApplicationReviewQuestion } from '../lib/applicationReview';
import { resolveKnownAnswer, type ApplicationProfileLike } from '../lib/questionDiscovery';
import { resolveSubmittedApplicationAnswers } from '../lib/submittedAnswers';
import { resolvePacketAuditQuestionFixpoint } from './submissionRunner';
import { sensitiveQuestionFor, sensitiveQuestionsFor } from './applications';

const ROUND = '2026-09-01T21:28:12.934Z';

const SPONSORSHIP_LABEL =
  'will you now, or in the future, require visa sponsorship to legally work in the country specified for this position?';
const GENDER_LABEL = 'what is your gender?';

/** Her stored record, from the owner account. */
const HER_PROFILE = {
  citizenship: 'India',
  eeo_prefs: { gender: 'Female', veteran_status: 'No', disability_status: 'No' },
  work_eligibility_by_country: [{
    country_code: 'US',
    authorized_now: true,
    needs_sponsorship_now: false,
    needs_sponsorship_future: true,
    authorization_type: 'F-1 CPT/OPT',
  }],
} as unknown as ApplicationProfileLike;

const SPONSORSHIP: ApplicationReviewQuestion = {
  id: 'q-sponsorship',
  question: SPONSORSHIP_LABEL,
  answer: 'Yes',
  kind: 'required',
  required: true,
  portal_input_type: 'select',
  answer_source: 'applicant_review',
  answer_reviewed_at: ROUND,
} as ApplicationReviewQuestion;

const GENDER: ApplicationReviewQuestion = {
  id: 'q-gender',
  question: GENDER_LABEL,
  answer: 'Woman',
  kind: 'required',
  required: true,
  portal_input_type: 'select',
  options: ['Woman', 'Man', 'Non-binary', "I don't wish to answer"],
  answer_source: 'applicant_review',
  answer_reviewed_at: ROUND,
  answer_override_of: 'Female',
} as ApplicationReviewQuestion;

function packet(questions: readonly ApplicationReviewQuestion[]): ApplicationReviewState {
  return {
    jd_text: 'Software Engineer at Hudson River Trading. Austin, Chicago, New York, London, Singapore.',
    status: 'ready_for_final_approval',
    edited_terms: [],
    skipped_reasons: [],
    questions: [...questions],
    questions_reviewed_at: ROUND,
    portal_url: 'https://boards.greenhouse.io/hudsonrivertrading/jobs/1234567890',
    ats_name: 'greenhouse',
  } as unknown as ApplicationReviewState;
}

/** The client can vouch for a label and an answer and nothing else; questionSchema strips the rest. */
function asSent(question: ApplicationReviewQuestion): SubmittedApplicationReviewQuestion {
  return {
    id: question.id,
    question: question.question,
    answer: question.answer,
    kind: question.kind,
    required: question.required,
  } as SubmittedApplicationReviewQuestion;
}

/**
 * The send path, composed exactly as POST /submit-request composes it, then asked exactly what
 * POST /submission/approve asks. Returns the questions the send would still refuse over.
 */
function stillRefusedAfterTheSendPath(review: ApplicationReviewState): string[] {
  const merged = resolveSubmittedApplicationAnswers({
    current: review,
    submitted: review.questions.map(asSent),
    profile: HER_PROFILE,
  });
  const settled = normalizeApplicationReviewQuestions(resolvePacketAuditQuestionFixpoint(
    { ...review, questions: merged.questions, questions_reviewed_at: merged.questionsReviewedAt },
    HER_PROFILE,
    review.jd_text,
    undefined,
    undefined,
    new Date(),
  ));
  return sensitiveQuestionsFor(
    settled, HER_PROFILE, review.jd_text, undefined, undefined, merged.questionsReviewedAt,
  ).map((question) => question.question);
}

test('the resolver really does decline one of these labels and answer the other', () => {
  /* Stated first, because every assertion below depends on which branch each question takes and a
   * change to either resolver would otherwise make this file pass for the wrong reason. */
  const sponsorship = resolveKnownAnswer(SPONSORSHIP_LABEL, 'text', HER_PROFILE, undefined, undefined, undefined);
  assert.ok(sponsorship && 'skipReason' in sponsorship,
    'R-004 keeps declining to declare her eligibility across three countries');
  const gender = resolveKnownAnswer(GENDER_LABEL, 'text', HER_PROFILE, undefined, undefined, undefined);
  assert.deepEqual(gender, { value: 'Female' }, 'her eeo_prefs answer this one, in her own spelling');
});

test('the sponsorship declaration survives the whole composition and stops refusing the send', () => {
  /* THE FIX, END TO END. Before it, this list contained the sponsorship label no matter what she
   * answered: the resolver declines, so the old expression was `!(false)` on every evaluation. */
  assert.deepEqual(stillRefusedAfterTheSendPath(packet([SPONSORSHIP])), []);
});

test('and her answer is still the one the employer would receive, not a blank', () => {
  /* A gate cleared beside an answer the composition blanked would be worse than the refusal: the
   * send would stop on "a required answer is still blank" and this fix would read as progress. */
  const merged = resolveSubmittedApplicationAnswers({
    current: packet([SPONSORSHIP]),
    submitted: [asSent(SPONSORSHIP)],
    profile: HER_PROFILE,
  });
  const settled = resolvePacketAuditQuestionFixpoint(
    { ...packet([SPONSORSHIP]), questions: merged.questions, questions_reviewed_at: merged.questionsReviewedAt },
    HER_PROFILE, packet([SPONSORSHIP]).jd_text, undefined, undefined, new Date(),
  );
  assert.equal(settled[0].answer, 'Yes', 'her declaration, unchanged by refresh or re-open');
  assert.equal(settled[0].answer_reviewed_at, merged.questionsReviewedAt,
    'still keyed to the round the packet carries, or the gate cannot read it as hers');
});

test('a packet with no review round is refused, so a frozen round cannot launder one', () => {
  const unreviewed = packet([{ ...SPONSORSHIP, answer_source: undefined, answer_reviewed_at: undefined } as ApplicationReviewQuestion]);
  assert.deepEqual(
    stillRefusedAfterTheSendPath({ ...unreviewed, questions_reviewed_at: undefined } as ApplicationReviewState),
    [SPONSORSHIP_LABEL],
    'an answer nobody attended to is exactly what the gate exists to stop',
  );
});

test('the head form forwards the review round the list form was given', () => {
  /* THE ONE-TOKEN REGRESSION THIS FILE EXISTS TO CATCH. Three of the four send gates in
   * applications.ts call sensitiveQuestionFor, not sensitiveQuestionsFor, and the head form gained
   * its questionsReviewedAt parameter in a merge. A head form that took the round and forgot to
   * pass it on would leave every one of those gates resolving a declined question as unreviewed -
   * the entire defect, restored, with the list form still working and every other test green. */
  const review = packet([SPONSORSHIP]);
  assert.equal(
    sensitiveQuestionFor(review.questions, HER_PROFILE, review.jd_text, undefined, undefined, ROUND),
    undefined,
    'with the round, her own current-round answer settles the declined question',
  );
  assert.equal(
    sensitiveQuestionFor(review.questions, HER_PROFILE, review.jd_text, undefined, undefined)?.question,
    SPONSORSHIP_LABEL,
    'and without it the gate is fail-closed, which is what makes dropping the argument detectable',
  );
});

test('the gender question is NOT cleared by this change, and that is the honest state of it', () => {
  /* The resolver answers this label from her profile, so it takes the value branch, which compares
   * bytes and stays first and unconditional. "Woman" is her profile's "Female" written in the
   * control's own vocabulary, and reading those two as the same declaration is a SEPARATE change to
   * a SEPARATE branch. Pinned here so nobody reads this PR as clearing packet 4a79eec1 whole. */
  assert.deepEqual(stillRefusedAfterTheSendPath(packet([SPONSORSHIP, GENDER])), [GENDER_LABEL]);
});
