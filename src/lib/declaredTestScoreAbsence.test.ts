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
  comparableOption,
  noScoreOptionFor,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';
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
    assert.equal(comparableOption('N/A'), 'n a');
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
