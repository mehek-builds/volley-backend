/* THE DEFECT, measured live on production (api.trylitos.com, revision 4d35c44 = origin/main),
 * 2026-09-04 ~15:43Z, account mehekmandal05@gmail.com, Sage Greenhouse packet
 * aae653a3-2d5a-4f3e-ba3b-afea4219df37 (status needs_attention, no live run).
 *
 * The dashboard's questions screen saved three closed-choice answers she changed, all three chosen
 * from the question's own `options` list, through PUT /applications/:id/review/answers. Two of the
 * three survived. The third - "When do you expect to graduate?", a required `combobox` offering
 * season/year terms, profile grad_date "May 2028" - was silently dropped: the save answered 200 and
 * genuinely stored "Spring 2028", and the very next GET /applications/:id/submission served the
 * question holding "May 2028" again, with no answer_source and no answer_override_of. The dashboard
 * then read the off-list "May 2028" as unanswered (questionReadsAsAnswered) and re-asked the same
 * question: pick Spring 2028, Save, reverts to May 2028, asked again.
 *
 * ROOT CAUSE. Her pick "Spring 2028" happens to equal what resolveProfileField would ALSO have
 * written into this control (graduationDateLadder already maps May to Spring), so
 * mergeSubmittedApplicationReviewQuestions's own anti-laundering gate (submittedIsMachineValue)
 * correctly declines to stamp `answer_source: 'applicant_review'` on it - stamping it would be the
 * exact 802-answer laundering the 2026-08-13 comment in routes/applications.ts warns against, and
 * that refusal is right and is not touched by this fix. The merge instead writes the honest machine
 * shape: `answer: "Spring 2028"`, `answer_option_source: "May 2028"`, no answer_source. That part
 * already worked before this fix.
 *
 * What was missing is downstream: refreshKnownQuestionAnswers (questionDiscovery.ts) runs on every
 * read and never sees a control's option list by design, so it recomputes the RAW profile fact
 * ("May 2028") and, finding no keep-branch that applies to a plain closed-choice snap outside the
 * EEO family (the band-currency branch demands a parseable date/number RANGE, which a single season
 * term is not), overwrites the correctly-snapped "Spring 2028" back to the off-list "May 2028" and
 * strips every provenance field along with it. combobox is not blanked by reopenUnfitClosedChoiceQuestions
 * (that gate deliberately excludes combobox - a searchable menu can hold an answer its first DOM
 * read never enumerated) so the row is left holding the wrong, off-list value forever.
 *
 * These tests call the REAL merge (mergeSubmittedApplicationReviewQuestions) and the REAL wired
 * read-time compositions (resolvePacketAuditQuestionFixpoint for GET /submission,
 * resolveSubmittedApplicationAnswers for the send path) with profile-shaped inputs matching the
 * measured packet, to prove the mechanism end to end and pin the fix
 * (snapStoredAnswersToProfileFieldOptions in questionMetadata.ts).
 *
 * NOT FIXED HERE BY STAMPING answer_source: 'applicant_review'. That would be the laundering the
 * anti-laundering gate exists to prevent - her pick is honestly a machine echo, not a disagreement -
 * so the fix instead makes sure the machine's own value, in the control's own vocabulary, is what
 * survives every read. See snapStoredAnswersToProfileFieldOptions's own header in
 * questionMetadata.ts for the full mechanism.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mergeSubmittedApplicationReviewQuestions,
  type ApplicationReviewQuestion,
  type ApplicationReviewState,
  type SubmittedApplicationReviewQuestion,
} from './applicationReview';
import { knownAnswerLookup, type ApplicationProfileLike } from './questionDiscovery';
import { machineAnswerLookup, resolveSubmittedApplicationAnswers } from './submittedAnswers';
import { resolvePacketAuditQuestionFixpoint } from '../routes/submissionRunner';

const ROUND = '2026-09-04T15:43:00.000Z';
const AS_OF = new Date(ROUND);

/* Her profile, as measured on the packet. */
const HER_PROFILE: ApplicationProfileLike = {
  school: 'University of Southern California, Viterbi School of Engineering',
  grad_date: 'May 2028',
  grad_year: 2028,
  referral_source_default: 'Job board',
};

/* A representative slice of the school control's real 24-option list. Her exact school is
 * deliberately absent from it, matching the measured packet, and "Other" is the literal option she
 * picked. */
const SCHOOL_OPTIONS = [
  'Arizona State University', 'Carnegie Mellon University', 'Cornell University',
  'Georgia Institute of Technology', 'Massachusetts Institute of Technology',
  'Purdue University', 'Stanford University', 'University of California, Berkeley',
  'University of Illinois Urbana-Champaign', 'University of Michigan',
  'University of Texas at Austin', 'University of Washington', 'Other',
];

const REFERRAL_OPTIONS = [
  'Career Fair – Columbia', 'Career Fair – Cornell', 'Career Fair – UPenn',
  'University Career Center / Job Board', 'LinkedIn', 'Handshake', 'Employee Referral',
];

const GRAD_OPTIONS = [
  'Spring 2027', 'Fall 2027', 'Spring 2028', 'Fall 2028', 'Spring 2029', 'Fall 2029', '2030 or later',
];

const SCHOOL_ID = 'a5ce1d9e-0000-4000-8000-000000000001';
const REFERRAL_ID = '80363491-0000-4000-8000-000000000002';
const GRAD_ID = 'b5c5de64-0000-4000-8000-000000000003';

function storedQuestions(): ApplicationReviewQuestion[] {
  return [
    {
      id: SCHOOL_ID,
      question: 'Which college or university do you currently attend?',
      answer: 'University of Southern California, Viterbi School of Engineering',
      kind: 'required',
      required: true,
      portal_input_type: 'combobox',
      options: [...SCHOOL_OPTIONS],
    },
    {
      id: REFERRAL_ID,
      question: 'How did you hear about this role?',
      answer: 'Job board',
      kind: 'required',
      required: true,
      portal_input_type: 'combobox',
      options: [...REFERRAL_OPTIONS],
    },
    {
      id: GRAD_ID,
      question: 'When do you expect to graduate?',
      answer: 'May 2028',
      kind: 'required',
      required: true,
      portal_input_type: 'combobox',
      options: [...GRAD_OPTIONS],
    },
  ];
}

/** What the dashboard posted back: all three answers, changed to what she picked from the lists. */
function submittedQuestions(): SubmittedApplicationReviewQuestion[] {
  const [school, referral, grad] = storedQuestions();
  return [
    { ...school, answer: 'Other' },
    { ...referral, answer: 'University Career Center / Job Board' },
    { ...grad, answer: 'Spring 2028' },
  ];
}

/** The exact composition routes/applications.ts's PUT /review/answers handler runs. */
function saveThroughReviewAnswers() {
  const resolverAnswerFor = knownAnswerLookup(HER_PROFILE, undefined, undefined, undefined, AS_OF);
  const machineFor = machineAnswerLookup(HER_PROFILE, undefined, undefined, undefined, AS_OF);
  return mergeSubmittedApplicationReviewQuestions(
    storedQuestions(),
    submittedQuestions(),
    ROUND,
    resolverAnswerFor,
    machineFor,
  );
}

function byId(questions: readonly ApplicationReviewQuestion[], id: string): ApplicationReviewQuestion {
  const found = questions.find((q) => q.id === id);
  assert.ok(found, `question ${id} must be present`);
  return found;
}

/* ── Step 1: the save itself (mirrors the PUT handler; nothing here should change) ──────────── */

test('precondition: the profile really does resolve the graduation control to her exact pick', () => {
  // If this fails, the fixture no longer models the packet: chooseClosestOption's own snap of
  // "May 2028" against GRAD_OPTIONS must equal "Spring 2028", or nothing below proves anything.
  const machineFor = machineAnswerLookup(HER_PROFILE, undefined, undefined, undefined, AS_OF);
  assert.equal(
    machineFor(storedQuestions()[2]),
    'Spring 2028',
    'graduationDateLadder\'s May-is-Spring mapping must already resolve this before any of this file\'s claims apply',
  );
});

test('the merge stores her school and referral picks as her own claim, exactly as measured', () => {
  const merged = saveThroughReviewAnswers();
  const school = byId(merged, SCHOOL_ID);
  const referral = byId(merged, REFERRAL_ID);

  assert.equal(school.answer, 'Other');
  assert.equal(school.answer_source, 'applicant_review');
  assert.equal(school.answer_override_of, 'University of Southern California, Viterbi School of Engineering');

  assert.equal(referral.answer, 'University Career Center / Job Board');
  assert.equal(referral.answer_source, 'applicant_review');
});

test('ROOT CAUSE, part 1: the merge itself already stores her graduation pick correctly', () => {
  const merged = saveThroughReviewAnswers();
  const grad = byId(merged, GRAD_ID);

  assert.equal(grad.answer, 'Spring 2028', 'her literal pick is adopted, unconditionally, by the merge');
  /* NOT applicant_review, and that is correct, not the bug. Her pick is byte-identical to what the
   * machine would also have written (see the precondition test above), so stamping applicant_review
   * here would be the exact 802-answer laundering the merge's own anti-laundering gate exists to
   * refuse - a machine echo stamped as a claim she never actually made by disagreeing with anything. */
  assert.equal(grad.answer_source, undefined,
    'a pick that merely echoes the machine\'s own value must not be laundered into her claim');
  assert.equal(grad.answer_option_source, 'May 2028',
    'the honest alternative: a machine snap, recorded as one, in the pre-snap profile wording');
});

/* ── Step 2: the very next read (mirrors GET /applications/:id/submission) ──────────────────── */

function reviewState(questions: ApplicationReviewQuestion[]): ApplicationReviewState {
  return {
    jd_text: '',
    status: 'needs_attention',
    edited_terms: [],
    questions,
    questions_reviewed_at: ROUND,
    skipped_reasons: [],
    updated_at: ROUND,
  } as unknown as ApplicationReviewState;
}

test('ROOT CAUSE, part 2 (THE BUG): without the fix this would revert on the very next read', () => {
  /* This test exercises the FIXED code (snapStoredAnswersToProfileFieldOptions is wired into
   * resolvePacketAuditQuestionFixpoint), so it pins the corrected behaviour. The paragraph above
   * documents, and questionMetadata.ts's own header proves by hand-trace, that the un-snapped
   * resolveKnownAnswer value ("May 2028") is what this same call would have produced before the fix:
   * refreshKnownQuestionAnswers has no keep-branch for a plain non-band, non-EEO closed-choice snap,
   * so it falls to its own bottom-of-function overwrite. */
  const merged = saveThroughReviewAnswers();
  const questions = resolvePacketAuditQuestionFixpoint(reviewState(merged), HER_PROFILE, '', undefined, undefined, AS_OF);
  const grad = byId(questions, GRAD_ID);

  assert.equal(grad.answer, 'Spring 2028', 'her pick must survive the read that follows the save');
  assert.ok(GRAD_OPTIONS.includes(grad.answer), 'and it must be a value the control actually offers');
});

test('the two picks that were never in question are still exactly as she left them after the same read', () => {
  const merged = saveThroughReviewAnswers();
  const questions = resolvePacketAuditQuestionFixpoint(reviewState(merged), HER_PROFILE, '', undefined, undefined, AS_OF);

  assert.equal(byId(questions, SCHOOL_ID).answer, 'Other');
  assert.equal(byId(questions, SCHOOL_ID).answer_source, 'applicant_review');
  assert.equal(byId(questions, REFERRAL_ID).answer, 'University Career Center / Job Board');
  assert.equal(byId(questions, REFERRAL_ID).answer_source, 'applicant_review');
});

test('the fix survives repeated reads: no Spring/May flip-flop on the second or third GET', () => {
  const merged = saveThroughReviewAnswers();
  const first = resolvePacketAuditQuestionFixpoint(reviewState(merged), HER_PROFILE, '', undefined, undefined, AS_OF);
  const second = resolvePacketAuditQuestionFixpoint(reviewState(first), HER_PROFILE, '', undefined, undefined, AS_OF);
  const third = resolvePacketAuditQuestionFixpoint(reviewState(second), HER_PROFILE, '', undefined, undefined, AS_OF);

  assert.equal(byId(first, GRAD_ID).answer, 'Spring 2028');
  assert.equal(byId(second, GRAD_ID).answer, 'Spring 2028');
  assert.equal(byId(third, GRAD_ID).answer, 'Spring 2028');
});

test('the snap never runs on a packet that may already be with the employer', () => {
  /* PRE-EXISTING BEHAVIOUR, NOT CHANGED HERE, and this test pins it rather than claiming this fix
   * solves it. resolvePacketAuditQuestionFixpoint's `packetMayBeWithEmployer` branch skips BOTH the
   * re-open AND (now) this snap, but refreshKnownQuestionAnswers itself runs unconditionally on
   * every branch - it has no `packetMayBeWithEmployer` parameter at all - so a sent packet's GET
   * still recomputes to the raw profile fact here, same as it already does for the un-snappable
   * families (band, EEO-without-a-provable-derivation) on main today. Fixing THAT is a wider,
   * separate change to refreshKnownQuestionAnswers's own contract and is out of scope for this
   * packet's defect, which is entirely about a LIVE, not-yet-sent review (status needs_attention,
   * no live run - see this file's header). What matters here is only that this snap does not make a
   * sent record WORSE: it neither invents a value nor blanks one on this branch, exactly like the
   * re-open it rides beside. */
  const merged = saveThroughReviewAnswers();
  const sentReview = { ...reviewState(merged), submission_claimed_at: ROUND, status: 'submitted' } as ApplicationReviewState;
  const questions = resolvePacketAuditQuestionFixpoint(sentReview, HER_PROFILE, '', undefined, undefined, AS_OF);
  const grad = byId(questions, GRAD_ID);

  assert.equal(grad.answer, 'May 2028', 'refresh alone still recomputes the raw profile fact here');
  assert.equal(grad.answer_option_source, undefined, 'and nothing invents a snap provenance beside it');
});

/* ── Step 3: the send path (resolveSubmittedApplicationAnswers), so a fill would also work ──── */

test('the send-path composition also carries her graduation pick, not the raw profile fact', () => {
  const { questions } = resolveSubmittedApplicationAnswers({
    current: { questions: storedQuestions(), questions_reviewed_at: undefined, jd_text: '' },
    submitted: submittedQuestions(),
    profile: HER_PROFILE,
    now: () => ROUND,
    asOf: AS_OF,
  });
  const grad = byId(questions, GRAD_ID);

  assert.equal(grad.answer, 'Spring 2028', 'the value a fill would actually type into the combobox');
  assert.ok(GRAD_OPTIONS.includes(grad.answer));
});
