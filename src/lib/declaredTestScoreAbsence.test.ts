/* A DECLARED ABSENCE IS ITS OWN STATE, and this file exists to prove there are THREE of them.
 *
 * The failure being pinned is subtle and it survived the first version of the test-score columns:
 * `standardized_test_type: 'None'` was storable from the day the enum was written, and the two
 * SCORE questions could not tell it apart from a column nobody had ever written. Both fell through
 * the same `leaveIt` branch, so a student who ANSWERED the question was held exactly as if she had
 * skipped it, on every application, for ever.
 *
 * A test that only separates "1520" from "not 1520" cannot see that, which is why every assertion
 * below is written against all three states at once:
 *
 *   PRESENT   she took it and the number is on file
 *   ABSENT    she declared she took no standardized test        <- the state that was invisible
 *   UNSET     nobody has asked her yet
 *
 * The property is that no two of them produce the same output. Equality between ABSENT and UNSET is
 * asserted to FAIL, not merely "each behaves reasonably": that equality is the whole defect.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import {
  NO_SCORE_OPTION_TEXTS,
  REFUSAL_OPTION_TEXTS,
  comparableTestOption,
  noScoreOptionFor,
  refreshKnownQuestionAnswers,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { prescriptAskExplanation, resolvePrescript, type PostingQuestion } from './postingQuestions';
import { resolveProfileField } from './profileFieldResolution';
import { testScoreConflict } from '../routes/applicationProfile';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

/* THE THREE STATES, and nothing else differs between them. Each is the whole profile, so any
 * difference in outcome below is caused by the test declaration and by nothing else on the row. */
const PRESENT: ApplicationProfileLike = { standardized_test_type: 'Both', sat_score: '1520', act_score: '34' };
const ABSENT: ApplicationProfileLike = { standardized_test_type: 'None' };
const UNSET: ApplicationProfileLike = {};

/* THE LABELS ARE THE CORPUS'S OWN, verbatim from the run that could not be sent:
 *   "Provide your best result on SAT" is required and is still empty
 *   "Provide your best result on ACT" is required and is still empty
 *   "Select your Standardized Test score type" is required and is still empty
 * The employer writes RESULT, not "score". A fixture that invented "What is your SAT score?" would
 * be testing a label this product has never once been shown. */
const SAT = 'provide your best result on sat';
const ACT = 'provide your best result on act';
const TYPE = 'select your standardized test score type';

type Outcome = { value: string } | { skipReason: string } | null;

function resolve(label: string, ap: ApplicationProfileLike, options?: readonly string[]): Outcome {
  return resolveKnownAnswer(label, 'text', ap, undefined, undefined, undefined, options);
}

function valueOf(outcome: Outcome): string | undefined {
  return outcome && 'value' in outcome ? outcome.value : undefined;
}

function heldReason(outcome: Outcome): string | undefined {
  return outcome && 'skipReason' in outcome ? outcome.skipReason : undefined;
}

/** A real ATS list that offers a way to say "I have none". Ordered as the employer wrote it. */
const LIST_WITH_NONE = ['1400-1600', '1200-1399', 'Below 1200', 'N/A'];
/* THE ADVERSARY THAT CAN WIN. Score bands and nothing else: every option is a claim about a number
 * she does not have. A matcher with any substring or "closest" rung picks one of these. */
const LIST_WITHOUT_NONE = ['1400-1600', '1200-1399', 'Below 1200'];

describe('the three states are distinguishable, which is the point of the feature', () => {
  test('a free-text control tells all three apart', () => {
    /* No option list, which is the corpus's real shape: all 24 blocked occurrences were required
     * TEXT inputs. PRESENT answers, and the other two hold - but they must hold DIFFERENTLY, or the
     * student cannot tell an unanswered question from one this employer gives her no room for. */
    const present = resolve(SAT, PRESENT);
    const absent = resolve(SAT, ABSENT);
    const unset = resolve(SAT, UNSET);

    assert.equal(valueOf(present), '1520');
    assert.equal(valueOf(absent), undefined, 'a declared absence must never produce a number');
    assert.equal(valueOf(unset), undefined, 'an unset column must never produce a number');

    const absentReason = heldReason(absent);
    const unsetReason = heldReason(unset);
    assert.ok(absentReason, 'a declared absence must be reported, not returned as null');
    assert.ok(unsetReason, 'an unset column must be reported, not returned as null');

    /* THE ASSERTION THE WHOLE FILE IS FOR. Before this change these two strings were identical. */
    assert.notEqual(
      absentReason,
      unsetReason,
      'a declared absence and a never-asked column must not report the same thing',
    );
    assert.match(absentReason!, /declared no standardized test scores/);
    assert.match(unsetReason!, /^SAT score left for you/);
    assert.doesNotMatch(unsetReason!, /declared/, 'the unset message must not claim she declared anything');
  });

  test('an option-shaped control answers the declared absence and still holds the unset one', () => {
    assert.equal(valueOf(resolve(SAT, PRESENT, LIST_WITH_NONE)), '1520');
    assert.equal(valueOf(resolve(SAT, ABSENT, LIST_WITH_NONE)), 'N/A', 'the declared absence is answerable here');
    assert.equal(
      valueOf(resolve(SAT, UNSET, LIST_WITH_NONE)),
      undefined,
      'an option list must not turn a never-asked column into an answer',
    );
    assert.match(heldReason(resolve(SAT, UNSET, LIST_WITH_NONE))!, /left for you/);
  });

  test('the ACT question behaves identically, from its own column', () => {
    assert.equal(valueOf(resolve(ACT, PRESENT)), '34');
    assert.equal(valueOf(resolve(ACT, ABSENT, LIST_WITH_NONE)), 'N/A');
    assert.match(heldReason(resolve(ACT, ABSENT))!, /declared no standardized test scores/);
    assert.match(heldReason(resolve(ACT, UNSET))!, /^ACT score left for you/);
  });

  test('the type question separates the three as well', () => {
    assert.equal(valueOf(resolve(TYPE, PRESENT)), 'Both');
    assert.equal(valueOf(resolve(TYPE, ABSENT)), 'None', 'the declaration is itself the answer here');
    assert.equal(valueOf(resolve(TYPE, UNSET)), undefined);
    assert.match(heldReason(resolve(TYPE, UNSET))!, /standardized test question left for you/);
  });
});

describe('what a declared absence may NOT do', () => {
  test('a list of score bands with no way to say "none" HOLDS, it does not pick a band', () => {
    /* Inventing a score is the worst thing in this file's problem space, and choosing "Below 1200"
     * is inventing one. The list here is capable of winning: three plausible options, all of them
     * the same KIND of thing the field wants. */
    const outcome = resolve(SAT, ABSENT, LIST_WITHOUT_NONE);
    assert.equal(valueOf(outcome), undefined);
    assert.match(heldReason(outcome)!, /declared no standardized test scores/);
    for (const band of LIST_WITHOUT_NONE) {
      assert.notEqual(valueOf(outcome), band);
    }
  });

  test('a free-text control is never given "N/A" invented by Litos', () => {
    /* The employer's own wording, or nothing. "N/A" appears in the answer above ONLY because the
     * form offered that exact string; with no list there is no wording to borrow and no way to know
     * what this employer accepts in a box it will read as a number. */
    assert.equal(valueOf(resolve(SAT, ABSENT)), undefined);
    assert.equal(valueOf(resolve(ACT, ABSENT)), undefined);
  });

  test('a refusal is not an absence, whatever order the employer lists them in', () => {
    /* THE CONFUSABLE PAIR. "Prefer not to answer" is a claim about her intent; "None" is a claim
     * about her record. She declared the second and never made the first. Listing the refusal FIRST
     * is what makes this fixture able to win: a matcher that simply scans for the first recognised
     * option answers with a refusal she did not give. */
    const refusalFirst = ['Prefer not to answer', 'SAT', 'ACT', 'None'];
    assert.equal(valueOf(resolve(TYPE, ABSENT, refusalFirst)), 'None');
    assert.equal(valueOf(resolve(SAT, ABSENT, ['Prefer not to answer', 'N/A'])), 'N/A');
    // And with ONLY a refusal on offer, there is no way to state the absence, so it holds.
    assert.equal(valueOf(resolve(SAT, ABSENT, ['Prefer not to answer', '1400-1600'])), undefined);
  });

  test('the absence set and the refusal set are disjoint', () => {
    // Adding "prefer not to say" to the absence set would open this silently, so it is asserted
    // rather than left to the comment above the two sets.
    for (const claim of NO_SCORE_OPTION_TEXTS) {
      assert.equal(REFUSAL_OPTION_TEXTS.has(claim), false, `"${claim}" cannot be both an absence and a refusal`);
    }
    assert.ok(REFUSAL_OPTION_TEXTS.size > 0, 'an empty refusal set would make the disjointness vacuous');
    for (const refusal of REFUSAL_OPTION_TEXTS) {
      assert.equal(noScoreOptionFor([refusal]), null, `"${refusal}" must never be read as an absence`);
    }
  });

  test('a stored score still wins over a stale declared absence', () => {
    // routes/applicationProfile.ts refuses to store this pair, and rows written before that check
    // existed can still hold it. Reporting the number she earned is the honest reading.
    const contradictory: ApplicationProfileLike = { standardized_test_type: 'None', sat_score: '1520' };
    assert.equal(valueOf(resolve(SAT, contradictory, LIST_WITH_NONE)), '1520');
    // And the write path still refuses to create that row in the first place.
    assert.ok(testScoreConflict({ standardized_test_type: 'None', sat_score: '1520' }));
  });
});

describe('the absence reaches the control, not just the resolver', () => {
  test('resolveProfileField selects the employer’s own option text exactly', () => {
    /* A value that resolves and then fails to reach the control is the defect
     * lib/profileFieldResolution.ts was written for, so the fill-shaped path is exercised too. */
    const resolved = resolveProfileField(
      { label: SAT, inputType: 'select', options: LIST_WITH_NONE },
      ABSENT,
    );
    assert.equal(resolved?.value, 'N/A');
    assert.ok(LIST_WITH_NONE.includes(resolved!.value), 'the value must be one of the options verbatim');
  });

  test('and it selects nothing at all when the list cannot say "none"', () => {
    const resolved = resolveProfileField(
      { label: SAT, inputType: 'select', options: LIST_WITHOUT_NONE },
      ABSENT,
    );
    assert.equal(resolved, null);
  });

  test('a caller that passes no list behaves exactly as it did before this change', () => {
    // Every existing call site that cannot see a list keeps its old behaviour, which is to hold.
    assert.equal(valueOf(resolveKnownAnswer(SAT, 'text', ABSENT, undefined)), undefined);
    assert.equal(valueOf(resolveKnownAnswer(SAT, 'text', PRESENT, undefined)), '1520');
  });
});

describe('the option matcher is anchored, not fuzzy', () => {
  test('a whole option is matched, never a fragment of one', () => {
    /* "None of the above" is in the set; "None of the above apply, my score is 1200" is not, and
     * must not match by containing it. A substring rung would answer the second with the first. */
    assert.equal(noScoreOptionFor(['None of the above']), 'None of the above');
    assert.equal(noScoreOptionFor(['None of the above apply, my score is 1200']), null);
    assert.equal(noScoreOptionFor(['I have not taken']), 'I have not taken');
    assert.equal(noScoreOptionFor(['I have not taken it since my sophomore year']), null);
  });

  test('punctuation and case are ignored, so the employer’s formatting does not decide it', () => {
    assert.equal(comparableTestOption('N/A'), 'n a');
    assert.equal(noScoreOptionFor(['N/A']), 'N/A');
    assert.equal(noScoreOptionFor(['n/a']), 'n/a');
    assert.equal(noScoreOptionFor(['  NONE  ']), '  NONE  ', 'the verbatim option text is returned');
    assert.equal(noScoreOptionFor(['Not Applicable']), 'Not Applicable');
  });

  test('an empty or missing list is the same as no list: hold', () => {
    assert.equal(noScoreOptionFor(undefined), null);
    assert.equal(noScoreOptionFor([]), null);
  });
});


/* THE OPTION TEXTS THE LIVE IMC TRADING GREENHOUSE POSTING ACTUALLY SERVES.
 *
 * The first version of this vocabulary was written from imagination. It held "None", "N/A" and
 * "Not applicable", none of which this employer offers, and so it unblocked nothing: the two rows
 * this feature exists for stayed exactly as blocked as before. Measured, and pinned here so the set
 * can only ever be extended against something real. */
const IMC_SAT_OPTIONS = ["I don't have SAT score", '1400-1600', '1200-1399'];
const IMC_ACT_OPTIONS = ["I don't have ACT score", '30-36', '24-29'];
const IMC_TYPE_OPTIONS = ['SAT', 'ACT', 'Other'];

describe('the rows that are actually blocked', () => {
  test('the live SAT and ACT controls are answered from the declared absence', () => {
    assert.equal(valueOf(resolve(SAT, ABSENT, IMC_SAT_OPTIONS)), "I don't have SAT score");
    assert.equal(valueOf(resolve(ACT, ABSENT, IMC_ACT_OPTIONS)), "I don't have ACT score");
  });

  test('the answer survives the packet refresh, which is where it used to be wiped', () => {
    /* THE TWO-STEP PRODUCTION SEQUENCE. Step 1 resolves with the control's options; step 2 has
     * none, and used to blank the answer step 1 had just chosen, leaving the row blocked, shipping
     * "" in the packet and aborting the attended handoff on a spurious `changed`. */
    for (const [label, options] of [[SAT, IMC_SAT_OPTIONS], [ACT, IMC_ACT_OPTIONS]] as Array<[string, string[]]>) {
      const filled = valueOf(resolve(label, ABSENT, options));
      assert.ok(filled, 'step 1 must produce an answer');
      const refreshed = refreshKnownQuestionAnswers([{ question: label, answer: filled! }], ABSENT, undefined);
      assert.equal(refreshed[0].answer, filled, `the refresh must not undo the fill: ${label}`);
    }
  });

  test('the refresh still blanks an answer the profile no longer supports', () => {
    // The other direction, so the fix cannot pass by making the refresh keep everything.
    const refreshed = refreshKnownQuestionAnswers([{ question: SAT, answer: '1520' }], ABSENT, undefined);
    assert.equal(refreshed[0].answer, '', 'a score under a declared absence must not survive');
    const neverAsked = refreshKnownQuestionAnswers([{ question: SAT, answer: 'N/A' }], UNSET, undefined);
    assert.equal(neverAsked[0].answer, '', 'an unset profile supports nothing');
  });

  test('"Other" is not an absence, so the type control stays blocked and that is correct', () => {
    /* It means a DIFFERENT test: the IB, A-levels, a national exam. Selecting it for a student who
     * sat no standardized test asserts she took one and declined to name it. */
    assert.equal(noScoreOptionFor(IMC_TYPE_OPTIONS), null);
    const resolved = resolveProfileField(
      { label: TYPE, inputType: 'select', options: IMC_TYPE_OPTIONS },
      ABSENT,
    );
    assert.notEqual(resolved?.value, 'Other');
  });

  test('a student who took only the SAT has no ACT score, and that is the same fact', () => {
    const satOnly: ApplicationProfileLike = { standardized_test_type: 'SAT', sat_score: '1520' };
    assert.equal(valueOf(resolve(ACT, satOnly, IMC_ACT_OPTIONS)), "I don't have ACT score");
    // And her SAT score still wins on its own field.
    assert.equal(valueOf(resolve(SAT, satOnly, IMC_SAT_OPTIONS)), '1520');
    // Derived from the TYPE, never from an empty column: a blank score under type SAT means the
    // number is missing, not that the exam was never sat.
    const satNoNumber: ApplicationProfileLike = { standardized_test_type: 'SAT' };
    assert.equal(valueOf(resolve(SAT, satNoNumber, IMC_SAT_OPTIONS)), undefined);
  });

  test('the AFFIRMATIVE direction is never read as an absence', () => {
    /* THE ONE-ENTRY DEFECT. `'taken'` was in the reduced-claims set, and TEST_FIELD_NOUN strips
     * `test`, `exam`, `sat` and `score`, so "Test taken" reduced to the same string as
     * "Test not taken" and was read as an absence. noScoreOptionFor returns the FIRST match, so a
     * control offering both directions answered with the one claiming she sat the exam: a false
     * statement about an academic record, submitted under her name.
     *
     * The fixture is the confusable PAIR, in the order that loses, because a single-option test
     * would have passed on the negative alone. */
    assert.equal(noScoreOptionFor(['Test taken', 'Test not taken']), 'Test not taken');
    assert.equal(noScoreOptionFor(['Taken', 'Not taken']), 'Not taken');
    assert.equal(noScoreOptionFor(['SAT taken', 'SAT not taken']), 'SAT not taken');
    for (const affirmative of ['Test taken', 'Taken', 'SAT taken', 'ACT taken', 'Exam taken', 'Score taken']) {
      assert.equal(noScoreOptionFor([affirmative]), null, `must not read as an absence: ${affirmative}`);
    }
    // The negatives still work, so the fix is not "refuse everything containing taken".
    for (const negative of ['Not taken', 'Test not taken', 'None taken', 'No test taken']) {
      assert.equal(noScoreOptionFor([negative]), negative, `must still be an absence: ${negative}`);
    }
  });

  test('the refresh cannot launder an affirmative that is already stored', () => {
    /* The stored answer is offered back as its own candidate list, which is what keeps a legitimate
     * absence alive across a packet rebuild. The same mechanism would have PRESERVED "Test taken"
     * against a declared absence, while correctly wiping every other wrong value on that path. */
    for (const stored of ['Test taken', 'Taken', 'SAT taken']) {
      const refreshed = refreshKnownQuestionAnswers([{ question: SAT, answer: stored }], ABSENT, undefined);
      assert.equal(refreshed[0].answer, '', `a claim she sat the exam must not survive: ${stored}`);
    }
    // And a real absence still does survive, so this is not the refresh wiping everything.
    const kept = refreshKnownQuestionAnswers([{ question: SAT, answer: 'Test not taken' }], ABSENT, undefined);
    assert.equal(kept[0].answer, 'Test not taken');
  });

  test('the vocabulary refuses everything that is not an absence', () => {
    for (const option of ['1400-1600', '1200-1399', 'Below 1200', '30-36', 'Other', 'Yes', 'No', 'SAT', 'ACT', 'Both']) {
      assert.equal(noScoreOptionFor([option]), null, `must not read as an absence: ${option}`);
    }
    // A bare "No" is the answer to a different question. "No SAT score" is an absence. The only
    // difference is whether the field's own nouns were there to remove.
    assert.equal(noScoreOptionFor(['No']), null);
    assert.equal(noScoreOptionFor(['No SAT score']), 'No SAT score');
  });
});

describe('the Apply screen tells the two states apart', () => {
  const question = (label: string, options: string[] | null): PostingQuestion => ({
    label, input_type: options ? 'select' : 'text', options, required: true, max_length: null,
  });

  test('a declared absence is not reported as "nothing on your profile answers it"', () => {
    /* That sentence is FALSE for a declared absence: something IS on file and she put it there.
     * Reporting it was the exact conflation this feature exists to remove, surviving on the one
     * surface the resolver test could not see. */
    const row = resolvePrescript([question(SAT, null)], ABSENT, {} as never).questions[0];
    assert.equal(row.reason, 'declared_absence_unsupported');
    const copy = prescriptAskExplanation(row.reason!, SAT);
    assert.match(copy, /no standardized test scores/);
    assert.doesNotMatch(copy, /nothing on your profile/);
  });

  test('and a never-asked question still is', () => {
    const row = resolvePrescript([question(SAT, null)], UNSET, {} as never).questions[0];
    assert.equal(row.reason, 'nothing_on_file');
    assert.match(prescriptAskExplanation(row.reason!, SAT), /nothing on your profile/);
  });

  test('a control that CAN say it is not asked at all', () => {
    const row = resolvePrescript([question(SAT, IMC_SAT_OPTIONS)], ABSENT, {} as never).questions[0];
    assert.equal(row.ask, false);
    assert.equal(row.answer, "I don't have SAT score");
  });
});
