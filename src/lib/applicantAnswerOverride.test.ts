/* THE EDIT PATH THAT COULD NOT MOVE A RESOLVED ANSWER, AND ANSWERED 200 WHILE FAILING TO.
 *
 * Measured on the live Lever degree control. `resolveProfileField` has no options to snap onto, so it
 * answers with the raw profile degree, "Bachelor of Science in Computer Science", against a control
 * offering "Bachelor Degree". The applicant rewrote it to "Bachelor's Degree" through
 * PUT /applications/:id/review/answers. The route returned 200, the row genuinely held her value, and
 * every reader afterwards showed the profile value again.
 *
 * WHY IT LOOKED LIKE A BROKEN WRITE AND WAS NOT. The write landed. refreshKnownQuestionAnswers runs on
 * the merge's output at four read sites - GET /applications/:id/submission, the extension send, the
 * packet audit and the submission runner - and for any question the resolver has a value for it
 * replaced the stored answer with the profile's. No provenance combination protected it: the
 * known-value branch had a currency test for a snapped BAND and no case at all for an applicant who
 * simply disagrees with one resolution. So the supported edit path could not move a single
 * machine-resolved answer anywhere in the product, and a save that had really happened was
 * indistinguishable to the applicant from one that had not.
 *
 * WHY THE TESTS RUN MERGE AND REFRESH TOGETHER. Neither half is the fix and neither half can be
 * checked alone: the merge has to record who supplied the answer and what she typed over, and the
 * refresh has to honour that record while the profile still agrees. Two files pinning one half each
 * is how a green suite went on describing a defect that was still live - see the round-mismatch case
 * below, which is the shape that kept slipping through.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSubmittedApplicationReviewQuestions, type ApplicationReviewQuestion } from './applicationReview';
import { knownAnswerLookup, refreshKnownQuestionAnswers, type ApplicationProfileLike } from './questionDiscovery';

/** The live Belvedere label, as questionLabel reads it off the Lever container. */
const DEGREE_QUESTION = 'What degree are you currently pursuing?';
/** What the resolver answers with no option list to snap onto, and what the employer cannot accept. */
const PROFILE_DEGREE = 'Bachelor of Science in Computer Science';
/** What she types instead, which is on the control's own four-option list. */
const HER_DEGREE = "Bachelor's Degree";
const ROUND = '2026-08-17T09:15:00.000Z';

function profileWith(degree: string): ApplicationProfileLike {
  return { degree, major: 'Computer Science', currently_enrolled: true } as ApplicationProfileLike;
}

/** A question record an earlier run resolved: no answer_source, which is 2790 of 2790 in production. */
function machineResolved(answer: string): ApplicationReviewQuestion {
  return {
    id: 'degree--0',
    question: DEGREE_QUESTION,
    answer,
    kind: 'required',
    required: true,
    portal_selector: '#degree',
    portal_input_type: 'select',
  };
}

/** What the review screen can actually post. questionSchema strips every provenance key. */
function asSent(answer: string): ApplicationReviewQuestion {
  return { id: 'degree--0', question: DEGREE_QUESTION, answer, kind: 'required', required: true };
}

/* The composition every reader runs: the route's merge, then the refresh.
 *
 * TWO PROFILES, DELIBERATELY. The save resolves against the profile as it stands when she presses
 * Save, and the read resolves against the profile as it stands when the packet is next opened or
 * filled. Collapsing them into one argument makes "the profile moved afterwards" untestable - the
 * merge would record the MOVED value as what she overrode, currency would hold, and a case that must
 * drop her override would pass. `readProfile` defaults to `profile`, which is the ordinary case. */
function saveThenRead(
  stored: readonly ApplicationReviewQuestion[],
  submitted: readonly ApplicationReviewQuestion[],
  profile: ApplicationProfileLike,
  round: string | undefined = ROUND,
  readRound: string | undefined = ROUND,
  readProfile: ApplicationProfileLike = profile,
) {
  const merged = mergeSubmittedApplicationReviewQuestions(
    stored,
    submitted,
    round,
    knownAnswerLookup(profile, undefined),
  ) as ApplicationReviewQuestion[];
  const read = refreshKnownQuestionAnswers(merged, readProfile, undefined, readRound);
  return { merged, read };
}

test('precondition: with no options the resolver answers the raw profile degree', () => {
  const [read] = refreshKnownQuestionAnswers(
    [machineResolved(HER_DEGREE)],
    profileWith(PROFILE_DEGREE),
    undefined,
    ROUND,
  );
  assert.equal(read.answer, PROFILE_DEGREE,
    'without her claim on the record the resolver owns this answer, which is the behaviour being narrowed');
});

/* THE DEFECT, STATED AS THE ANSWER THE EMPLOYER RECEIVES. Not "the row holds her bytes" - it always
 * did - but "the value that survives the readers is hers". */
test('an overridden resolved answer is the answer every reader sees', () => {
  const { merged, read } = saveThenRead(
    [machineResolved(PROFILE_DEGREE)],
    [asSent(HER_DEGREE)],
    profileWith(PROFILE_DEGREE),
  );

  assert.equal(merged[0].answer_source, 'applicant_review', 'the save records who supplied it');
  assert.equal(merged[0].answer_reviewed_at, ROUND, 'against the round the row carries');
  assert.equal(merged[0].answer_override_of, PROFILE_DEGREE, 'and what she typed over');
  assert.equal(read[0].answer, HER_DEGREE, 'so the refresh leaves it alone');
});

/* AND IS NOT STICKY, which is the whole reason the override records what it replaced. The profile
 * stays the source of truth; she is allowed to disagree with one resolution of it, not to freeze a
 * fact she later corrects. */
test('an override is dropped once the profile fact it was made against moves', () => {
  const { read } = saveThenRead(
    [machineResolved(PROFILE_DEGREE)],
    [asSent(HER_DEGREE)],
    // She overrode a bachelor degree...
    profileWith(PROFILE_DEGREE),
    ROUND,
    ROUND,
    // ...and corrected her profile to a master's afterwards.
    profileWith('Master of Science in Computer Science'),
  );

  assert.equal(read[0].answer, 'Master of Science in Computer Science',
    'her override described a bachelor degree and she is no longer pursuing one');
  assert.equal(read[0].answer_override_of, undefined,
    'and the record stops claiming an override of a value nothing resolves to');
});

/* BOTH HALVES ARE LOAD-BEARING, proved by removing one. A claim with no record of what it overrode
 * cannot be checked for currency, so it must not outrank the resolver - the same default
 * answer_option_source has for a band with no derivation. */
test('an applicant claim with no record of what it overrode does not outrank the resolver', () => {
  const [read] = refreshKnownQuestionAnswers(
    [{ ...machineResolved(HER_DEGREE), answer_source: 'applicant_review', answer_reviewed_at: ROUND }],
    profileWith(PROFILE_DEGREE),
    undefined,
    ROUND,
  );
  assert.equal(read.answer, PROFILE_DEGREE, 'unprovable currency recomputes, which costs one recomputation');
});

/* THE OTHER HALF OF THE SAME SENTENCE. A stale round is exactly how the previous fix passed its own
 * tests while 130 packets stayed broken, so the round is checked rather than assumed. */
test('an override keyed to a round the packet no longer carries is not honoured', () => {
  const { read } = saveThenRead(
    [machineResolved(PROFILE_DEGREE)],
    [asSent(HER_DEGREE)],
    profileWith(PROFILE_DEGREE),
    ROUND,
    '2026-08-18T09:15:00.000Z',
  );
  assert.equal(read[0].answer, PROFILE_DEGREE, 'a claim no reader can check is not a claim');
});

/* THE LAUNDERING THIS MUST NEVER BECOME. An untouched Save posts back the resolver's own bytes for
 * every question on the packet. Replaying 802 of those across 174 packets as hers - gender,
 * disability status, veteran status, sponsorship, compensation - is what a blanket stamp on
 * "non-empty" did once. The gate is "did this request change it", so an unedited screen claims
 * nothing at all. */
test('an unedited save claims nothing and leaves the resolver in charge', () => {
  const { merged, read } = saveThenRead(
    [machineResolved(PROFILE_DEGREE)],
    [asSent(PROFILE_DEGREE)],
    profileWith(PROFILE_DEGREE),
  );

  assert.equal(merged[0].answer_source, undefined, 'a replayed machine answer is not an applicant review');
  assert.equal(merged[0].answer_override_of, undefined, 'and overrode nothing');
  assert.equal(read[0].answer, PROFILE_DEGREE);
});

/* A SECOND CORRECTION IS STILL A CORRECTION, and this is the case that first read as an acceptable
 * cost and is not one. Recording "her second answer overrode her first" makes currency uncheckable -
 * the profile never said her first answer - so the resolver took the answer back and she could
 * correct a resolved answer exactly once. What her second answer disagrees WITH is still the profile
 * value, and that is what the record has to keep saying. */
test('a second override still overrides the resolver value, so it survives too', () => {
  const { merged } = saveThenRead(
    [machineResolved(PROFILE_DEGREE)],
    [asSent(HER_DEGREE)],
    profileWith(PROFILE_DEGREE),
  );
  const { merged: again, read } = saveThenRead(
    merged,
    [asSent('Bachelor Degree')],
    profileWith(PROFILE_DEGREE),
  );

  assert.equal(again[0].answer, 'Bachelor Degree');
  assert.equal(again[0].answer_override_of, PROFILE_DEGREE,
    'the resolver value the chain has disagreed with all along, not her own earlier answer');
  assert.equal(read[0].answer, 'Bachelor Degree', 'so the second correction reaches the employer too');
});

/* THE SNAPPED RECORD, WHICH THE FIRST VERSION OF THIS FIX SILENTLY FAILED ON.
 *
 * A band answer and the resolver value it came from are DIFFERENT STRINGS - the record holds
 * "January 2028 - July 2028" and the profile says "May 2028" - so recording the stored answer as what
 * she overrode wrote a value the profile never produces, currency could never be proved, and her edit
 * was recomputed away. The degree case worked because a plainly resolved record happens to hold the
 * resolver's own value, which is exactly why one fixture was not enough to see this. */
test('an override of a snapped band answer records the resolver value, not the band', () => {
  const gradProfile = { grad_date: 'May 2028', currently_enrolled: true } as ApplicationProfileLike;
  const snapped: ApplicationReviewQuestion = {
    id: 'grad',
    question: 'Expected graduation date',
    answer: 'January 2028 - July 2028',
    kind: 'required',
    required: true,
    answer_option_source: 'May 2028',
  };
  const sent: ApplicationReviewQuestion = {
    id: 'grad', question: 'Expected graduation date', answer: 'Spring/Summer 2028', kind: 'required', required: true,
  };

  const merged = mergeSubmittedApplicationReviewQuestions(
    [snapped], [sent], ROUND, knownAnswerLookup(gradProfile, undefined),
  ) as ApplicationReviewQuestion[];
  assert.equal(merged[0].answer_override_of, 'May 2028',
    'the value the profile actually produces, or currency can never be proved');

  const read = refreshKnownQuestionAnswers(merged, gradProfile, undefined, ROUND);
  assert.equal(read[0].answer, 'Spring/Summer 2028', 'so her edit reaches the employer');
});

/* THE OTHER HALF OF THE LAUNDERING GATE, AND THE ONE `!answerUnchanged` ALONE DOES NOT COVER.
 *
 * The row is stale and the screen is not: GET /applications/:id/submission refreshes on read without
 * persisting, so a row holding "Male" is DISPLAYED as the resolved value and the client posts back
 * what it was shown. Comparing against the row alone reads that as an edit and stamps an EEO
 * self-identification she never made - the 802-answer laundering arriving through a different door. */
test('an unedited save of a value the refresh corrected is not her claim', () => {
  const eeoProfile = { gender: 'Female' } as ApplicationProfileLike;
  const stale: ApplicationReviewQuestion = {
    id: 'gender', question: 'Gender', answer: 'Male', kind: 'required', required: false,
  };
  const displayed = refreshKnownQuestionAnswers([stale], eeoProfile, undefined, ROUND)[0].answer;
  assert.notEqual(displayed, stale.answer, 'precondition: the refresh changes this value on read');

  const merged = mergeSubmittedApplicationReviewQuestions(
    [stale],
    [{ id: 'gender', question: 'Gender', answer: displayed, kind: 'required', required: false }],
    ROUND,
    knownAnswerLookup(eeoProfile, undefined),
  ) as ApplicationReviewQuestion[];

  assert.equal(merged[0].answer_source, undefined,
    'she pressed Save without touching an EEO answer, and the record must not say she supplied it');
  assert.equal(merged[0].answer_override_of, undefined);
});

/* AND AN ESSAY RECORDS NO OVERRIDE AT ALL. The resolver answers nothing for an essay label, so there
 * is no value to prove currency against and nothing for the override branch to ever read. Copying a
 * 20,000-character answer in beside it would be pure weight in the packet spec, on every revision. */
test('editing an essay records her claim but no override value', () => {
  const essay: ApplicationReviewQuestion = {
    id: 'why', question: 'Why do you want to work here?', answer: 'A first draft.', kind: 'essay', required: true,
  };
  const merged = mergeSubmittedApplicationReviewQuestions(
    [essay],
    [{ ...essay, answer: 'A better draft.' }],
    ROUND,
    knownAnswerLookup(profileWith(PROFILE_DEGREE), undefined),
  ) as ApplicationReviewQuestion[];

  assert.equal(merged[0].answer, 'A better draft.');
  assert.equal(merged[0].answer_source, 'applicant_review', 'the revision is hers');
  assert.equal(merged[0].answer_override_of, undefined, 'and there is no resolver value it overrode');
});

/* A STALE OVERRIDE NOTE ON THE ROW MUST NOT OUTRANK A LIVE RESOLUTION.
 *
 * The row keeps whatever note it was last written with, because the readers that run the refresh do
 * not persist its output - only the served copy gets corrected. So a record can sit there claiming an
 * override of a bachelor degree long after the profile says master's. Preferring that note over a live
 * lookup recorded the stale value against her NEW edit, currency failed, and the edit she just made
 * was recomputed away: the original defect, arriving through the row's own history. */
test('a fresh edit resolves against the profile, not against a stale override note', () => {
  const staleNote: ApplicationReviewQuestion = {
    ...machineResolved(HER_DEGREE),
    answer_source: 'applicant_review',
    answer_reviewed_at: ROUND,
    answer_override_of: PROFILE_DEGREE, // she overrode a bachelor degree, long ago
  };
  const nowAMasters = profileWith('Master of Science in Computer Science');

  const { merged, read } = saveThenRead([staleNote], [asSent('Master Degree')], nowAMasters);

  assert.equal(merged[0].answer_override_of, 'Master of Science in Computer Science',
    'what the resolver says today, not the note the row was carrying');
  assert.equal(read[0].answer, 'Master Degree', 'so the edit she just made survives');
});

/* AND THE CHAIN STILL BREAKS WHEN THE FACT MOVES, which is what makes carrying the original value
 * forward safe rather than a way to make an override permanent. */
test('a twice-corrected answer is still dropped once the profile moves', () => {
  const { merged } = saveThenRead(
    [machineResolved(PROFILE_DEGREE)],
    [asSent(HER_DEGREE)],
    profileWith(PROFILE_DEGREE),
  );
  const { read } = saveThenRead(
    merged,
    [asSent('Bachelor Degree')],
    // Both corrections were made while the profile still said bachelor...
    profileWith(PROFILE_DEGREE),
    ROUND,
    ROUND,
    // ...and it became a master's afterwards.
    profileWith('Master of Science in Computer Science'),
  );

  assert.equal(read[0].answer, 'Master of Science in Computer Science');
});
