/* The standardized test columns, end to end: stored, resolved, and reaching an employer's field.
 *
 * Each of the three blocked 9 distinct packets in the 158-packet corpus (2026-08-11), and the
 * failure being pinned is the one this whole column group exists to prevent: a field that is
 * COLLECTED and never READ is worse than one that was never collected, because the student
 * answered a question and the application stalled on it anyway.
 *
 * So every test below walks the same three joints a real answer has to survive:
 *   1. STORED   bodySchema keeps the key (a column with no line there is stripped silently)
 *   2. RESOLVED resolveKnownAnswer returns the stored value for the employer's own wording
 *   3. REACHED  the value is the one that would be typed, not a skipReason
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { bodySchema, mergedTestScoreState, testScoreConflict } from '../routes/applicationProfile';
import {
  EEO_QUESTION,
  STANDARDIZED_TEST_TYPE_QUESTION,
  resolveKnownAnswer,
  type ApplicationProfileLike,
} from './questionDiscovery';
import { APPLICATION_FACT_COLUMNS } from './applicationFacts';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

/** A profile that has answered every test question, so a refusal below is never "nothing stored". */
const answered: ApplicationProfileLike = {
  standardized_test_type: 'Both',
  sat_score: '1520',
  act_score: '34',
};

/** The value a fill layer would type, or undefined when the question was left for the student. */
function typedValue(label: string, ap: ApplicationProfileLike): string | undefined {
  const answer = resolveKnownAnswer(label, 'text', ap, undefined);
  return answer && 'value' in answer ? answer.value : undefined;
}

function skipped(label: string, ap: ApplicationProfileLike): boolean {
  const answer = resolveKnownAnswer(label, 'text', ap, undefined);
  return !!answer && 'skipReason' in answer;
}

describe('standardized test scores: stored', () => {
  test('bodySchema keeps all three keys, so PUT cannot discard them silently', () => {
    const parsed = bodySchema.parse({
      standardized_test_type: 'SAT',
      sat_score: '1520',
      act_score: '34',
    });
    assert.equal(parsed.standardized_test_type, 'SAT');
    assert.equal(parsed.sat_score, '1520');
    assert.equal(parsed.act_score, '34');
  });

  test('null round-trips, because the client re-sends the whole fetched profile on save', () => {
    const parsed = bodySchema.parse({
      standardized_test_type: null,
      sat_score: null,
      act_score: null,
    });
    assert.equal(parsed.standardized_test_type, null);
    assert.equal(parsed.sat_score, null);
    assert.equal(parsed.act_score, null);
  });

  test('an unrecognised test type fails the save rather than reading back as never asked', () => {
    assert.throws(() => bodySchema.parse({ standardized_test_type: 'GRE' }));
  });

  test('an empty score is rejected: it is not a score, and null is how you say not answered', () => {
    assert.throws(() => bodySchema.parse({ sat_score: '' }));
    assert.throws(() => bodySchema.parse({ act_score: '   ' }));
  });

  test('all three are in APPLICATION_FACT_COLUMNS, so a deploy ahead of the migration cannot 42703', () => {
    for (const column of ['standardized_test_type', 'sat_score', 'act_score']) {
      assert.ok(
        (APPLICATION_FACT_COLUMNS as readonly string[]).includes(column),
        `${column} must be listed so selectApplicationProfileRow can drop it from the projection`,
      );
    }
  });
});

/* THE ACTUAL LABELS, taken from the owner's 158 packets rather than invented.
 *
 * The first version of this rule was written against "What is your SAT score?", which sounds right
 * and appears in the corpus zero times, in the owner's 300 distinct labels or in all 507 across
 * every account. Extracted from the owner's labels, the complete set of
 * standardized-test questions is these three. Each is required, text, and was blank on all 8 of the
 * packets it appears in. Answering the middle one and missing the other two, which is what a
 * "score"-keyed pattern does, is a migration that delivers a third of what it claims. */
const CORPUS_LABELS = {
  sat: 'provide your best result on sat',
  act: 'provide your best result on act',
  type: 'select your standardized test score type',
} as const;

/* THE CONTRADICTION THE API MUST REFUSE TO STORE.
 *
 * The onboarding step never removed a value: the patch iterated everything typed, and both setState
 * calls were additive spreads. Choosing "Both", filling both scores, then answering "None" posted
 * all three, and this route stored it because the fields were independent optionals. The resolver
 * then told one employer, on one form, that she took no standardized test and that her SAT was 1520.
 *
 * The step now clears the scores, which is the experience. This is the guarantee: the step is one
 * component and the API has other callers. */
describe('standardized test scores: the API refuses a self-contradicting state', () => {
  const merged = (stored: Record<string, unknown> | undefined, body: Record<string, unknown>) =>
    testScoreConflict(mergedTestScoreState(stored, body));

  test('the exact body the old step produced is refused', () => {
    const conflict = merged(undefined, {
      standardized_test_type: 'None',
      sat_score: '1520',
      act_score: '34',
    });
    assert.ok(conflict, 'None alongside two scores must not be storable');
    assert.match(conflict!, /took no standardized test/);
  });

  test('a score with no test named is refused', () => {
    assert.ok(merged(undefined, { sat_score: '1520' }));
  });

  test('a test that excludes the score given is refused', () => {
    assert.ok(merged(undefined, { standardized_test_type: 'SAT', act_score: '34' }));
    assert.ok(merged(undefined, { standardized_test_type: 'ACT', sat_score: '1520' }));
  });

  test('coherent states are stored', () => {
    assert.equal(merged(undefined, { standardized_test_type: 'None' }), null);
    assert.equal(merged(undefined, { standardized_test_type: 'SAT', sat_score: '1520' }), null);
    assert.equal(merged(undefined, { standardized_test_type: 'ACT', act_score: '34' }), null);
    assert.equal(
      merged(undefined, { standardized_test_type: 'Both', sat_score: '1520', act_score: '34' }),
      null,
    );
    // Never answered at all is coherent, and is the state every account starts in.
    assert.equal(merged(undefined, {}), null);
  });

  /* THE MERGED-STATE HALF. A request carrying only a score cannot be judged alone: whether it
   * contradicts anything depends on what is already stored. A body-only check would let a client
   * build the contradiction across two requests. */
  test('a score alone is refused against a stored None', () => {
    assert.ok(merged({ standardized_test_type: 'None' }, { sat_score: '1520' }));
  });

  test('changing the stored type to None while scores are stored is refused', () => {
    assert.ok(merged({ sat_score: '1520', standardized_test_type: 'SAT' }, { standardized_test_type: 'None' }));
  });

  test('clearing the score in the same request makes the change storable', () => {
    assert.equal(
      merged(
        { sat_score: '1520', act_score: '34', standardized_test_type: 'Both' },
        { standardized_test_type: 'None', sat_score: null, act_score: null },
      ),
      null,
    );
  });

  /* An ABSENT key means "leave it alone" and an explicit null means "clear it". Conflating them
   * would make every partial save look like a clear, so this pins the difference. */
  test('an absent key keeps the stored value rather than clearing it', () => {
    assert.ok(merged({ standardized_test_type: 'None' }, { gpa: '3.9', sat_score: '1520' }));
    assert.equal(mergedTestScoreState({ sat_score: '1520' }, {}).sat_score, '1520');
    assert.equal(mergedTestScoreState({ sat_score: '1520' }, { sat_score: null }).sat_score, null);
  });
});

describe('standardized test scores: the measured labels are answered', () => {
  test('the SAT question the employer actually asks', () => {
    assert.equal(typedValue(CORPUS_LABELS.sat, answered), '1520');
  });

  test('the ACT question the employer actually asks, and not with the SAT score', () => {
    assert.equal(typedValue(CORPUS_LABELS.act, answered), '34');
  });

  test('the test-type question the employer actually asks', () => {
    assert.equal(typedValue(CORPUS_LABELS.type, answered), 'Both');
  });

  /* The ordering guard, on the real labels. The type label contains the word "score" and the score
   * labels name a test; if the type pattern ran first it would type "Both" into a field expecting a
   * number. A malformed answer on a required field is worse than the blank it replaced. */
  test('a label naming a specific test never receives the test type', () => {
    assert.notEqual(typedValue(CORPUS_LABELS.sat, answered), 'Both');
    assert.notEqual(typedValue(CORPUS_LABELS.act, answered), 'Both');
  });

  test('the phrasing keyed on "score" still works, so the pattern generalises both ways', () => {
    assert.equal(typedValue('What is your SAT score?', answered), '1520');
    assert.equal(typedValue('ACT score', answered), '34');
  });
});

/* THE GATES THAT KEEP "act" FROM MEANING THE TEST, AND "sat" FROM MEANING "sat down".
 *
 * Two gates, both failing closed. A context word must sit within two tokens of the test name, and
 * the token immediately before the test name must be on a short ALLOWLIST of determiners, or the
 * label must open with the test. The second gate replaced two denylists - one of statutes, one of
 * prepositions - that leaked by omission, which is the only way a denylist ever leaks.
 *
 * Measured end to end over all 507 distinct labels across every account: exactly 3 receive a test
 * value, and they are the 3 real questions. None of the 50 EEO labels or the 4 accommodation labels
 * receives one. These cases guard the forms not yet seen. */
describe('standardized test scores: what must never match', () => {
  const mustNotMatch = [
    'are you protected under the americans with disabilities act?',
    'do you require accommodation under the equality act 2010?',
    'please rate your familiarity with the sarbanes-oxley act',
    'how would you score your ability to act under pressure in a live trading environment',
    'are you satisfied with your current role?',
    'describe a time you had to act on incomplete information and what the outcome was',
  ];

  /* The property is "no test score reaches this field", NOT "nothing answers it". The disability
     label below is correctly handled by the EEO branch, which answers "Decline to self-identify" -
     a right answer to a self-identification question and emphatically not a number. Asserting
     undefined there would pin the wrong thing and break the moment an unrelated rule improved. */
  const TEST_VALUES = ['1520', '34', 'Both', 'SAT', 'ACT', 'None'];

  for (const label of mustNotMatch) {
    test(`no test score reaches: ${label.slice(0, 46)}`, () => {
      const answer = typedValue(label, answered);
      assert.ok(
        answer === undefined || !TEST_VALUES.includes(answer),
        `must not type a test value here, got: ${String(answer)}`,
      );
    });
  }

  /* The two gates, isolated. Each of these labels would match a bare test-name regex and is refused
     by exactly one gate, so a future edit that drops either gate fails here. */
  test('gate 1: a test name with no value word is refused', () => {
    assert.equal(typedValue('did you interact with our team at the career fair?', answered), undefined);
  });

  test('gate 2: a value word and a test name in a sentence are refused on length', () => {
    assert.equal(
      typedValue('how would you score your ability to act under pressure in a live trading environment', answered),
      undefined,
    );
  });
});

/* THE CASES REVIEW FOUND, pinned one by one. Every row below was a real defect in the version of
 * this rule that shipped with a value-word gate and an eight-word length cap. */
describe('standardized test scores: the gates fail in neither direction', () => {
  const cases: Array<{ label: string; expect: string | undefined; why: string }> = [
    // FALSE POSITIVES. "sat" is the past tense of "sit", and "act" names most legislation.
    { label: 'Have you sat for the CPA exam? Score:', expect: undefined, why: 'sat is the verb, and Litos targets finance' },
    { label: 'Equality Act score', expect: undefined, why: 'a statute, not a test' },
    // FALSE NEGATIVES. Bare section labels are the commonest real ATS shape and asked for a number
    // without ever saying "score", so the value-word gate returned null and the essay drafter got
    // them instead of a skipReason.
    { label: 'SAT Math', expect: '1520', why: 'a bare section label is the commonest real shape' },
    { label: 'SAT Total (Evidence-Based Reading and Writing + Math)', expect: '1520', why: 'section label with punctuation' },
    { label: 'ACT English', expect: '34', why: 'the ACT half of the same shape' },
    { label: 'ACT Composite', expect: '34', why: 'composite is a value word' },
    // Long instructional labels were refused by the eight-word cap and are unmistakably test fields.
    { label: 'Please provide your ACT composite score if you have taken the exam', expect: '34', why: 'thirteen words and still an ACT field' },
    // A criminal-record label from another user's corpus, correctly refused.
    { label: '(clean slate) act?', expect: undefined, why: 'a statute with no value word' },

    /* STATUTE CITATIONS. Every one of these filled "34" while `section` was a context word and the
     * statute guard was a denylist. The first is the literal citation on the OFCCP disability
     * self-identification form, so this is round 2's disability failure reached through the
     * statute's own citation format rather than through the word "disability". */
    { label: 'Rehabilitation Act, Section 503', expect: undefined, why: 'the OFCCP disability form citation' },
    { label: 'Uniform Securities Act exam', expect: undefined, why: 'a finance statute, and Litos targets finance' },
    { label: 'Investment Advisers Act score', expect: undefined, why: 'a finance statute' },
    { label: 'Fair Credit Reporting Act - total accounts', expect: undefined, why: 'a finance statute with a value word' },
    { label: 'Fair Labor Standards Act score', expect: undefined, why: 'a statute with a value word' },
    { label: 'Securities Exchange Act reading', expect: undefined, why: 'a statute beside a section name' },
    { label: 'ADA Amendments Act score', expect: undefined, why: 'the inflection the old denylist missed' },
    { label: 'Nondiscrimination Act score', expect: undefined, why: 'the other inflection it missed' },

    /* THE VERB, GUARDED IN THE RIGHT DIRECTION. The old rule keyed on what FOLLOWED "sat", so it
     * caught "sat for" and nothing else. The corpus already contains a UK-English employer. */
    { label: 'Date you sat the exam', expect: undefined, why: 'British phrasing, verb followed by a determiner' },
    { label: 'Have you sat an exam in the last year?', expect: undefined, why: 'verb followed by a determiner' },
    { label: 'Have you ever sat this exam?', expect: undefined, why: 'verb with an adverb in between' },

    /* ACCOMMODATION QUESTIONS are disability questions that need not contain `disab`, so they slip
     * EEO_QUESTION. Every gate above passes the first one: a test name, a context word beside it,
     * and a determiner in front. It is still never a score. */
    { label: 'Do you require accommodations for the ACT exam?', expect: undefined, why: 'a disability question wearing test vocabulary' },
    { label: 'Did you receive an accommodation on a standardized test?', expect: undefined, why: 'no `disab`, so EEO_QUESTION misses it' },
    { label: 'Which tests did you request accommodations for?', expect: undefined, why: 'an accommodation question shaped like a type question' },
  ];

  for (const { label, expect, why } of cases) {
    test(`${expect === undefined ? 'refuses' : `answers ${expect}`}: ${label.slice(0, 44)}`, () => {
      assert.equal(typedValue(label, answered), expect, why);
    });
  }
});

/* FINDING 3: THE EEO ORDERING. standardizedTestAnswer is called BEFORE the EEO_QUESTION branch, so
 * that a plain required test field is not swallowed by a "Decline to self-identify". The cost is
 * that a label matching both arrives here first, and EEO_QUESTION folds disability, veteran and race
 * into one alternation containing `disab`. "Section 503 Disability Act score" matches both and used
 * to fill "34" end to end - verbatim the failure the comment on these matchers calls impossible.
 *
 * The refusal inside standardizedTestAnswer is what makes the ordering safe. These pin it end to
 * end rather than on the matcher alone, because the matcher is not where the bug was. */
describe('standardized test scores: a self-identification question is never a test score', () => {
  const eeoLabels = [
    'Section 503 Disability Act score',
    'Did you receive a disability accommodation on a standardized test?',
    'Are you a veteran or active member of the United States armed forces?',
  ];

  for (const label of eeoLabels) {
    test(`no test value reaches: ${label.slice(0, 44)}`, () => {
      const answer = typedValue(label, answered);
      assert.ok(
        answer === undefined || !['1520', '34', 'Both', 'SAT', 'ACT', 'None'].includes(answer),
        `an EEO question must never receive a test value, got: ${String(answer)}`,
      );
    });
  }

  /* THE ASSERTION THAT COULD NOT FAIL, replaced by one that can.
   *
   * This test used to compare source positions: `body.indexOf('EEO_QUESTION.test(label)') <
   * body.indexOf('isSatScoreQuestion')`. Delete the guard entirely and the left side is -1, which is
   * less than everything, so the assertion passed on a file that no longer had the guard in it.
   * Confirmed by mutation: removing the EEO half of the refusal left the whole file at 54 of 54
   * passing, while `Disability: which standardized test did you take with extended time?` began
   * resolving to "Both".
   *
   * The behaviour is what matters, so the behaviour is what is asserted. This label matches
   * EEO_QUESTION and a test matcher at once, which is the only configuration where the ordering can
   * be observed at all: if the refusal is removed, the test matcher wins and this fails. */
  test('a label matching both an EEO question and a test matcher returns the EEO answer', () => {
    const label = 'Disability: which standardized test did you take with extended time?';
    assert.ok(EEO_QUESTION.test(label), 'the label must match EEO_QUESTION for this to prove anything');
    assert.ok(
      STANDARDIZED_TEST_TYPE_QUESTION.test(label),
      'the label must also match a test matcher, or the ordering is never exercised',
    );
    assert.equal(typedValue(label, answered), 'Decline to self-identify');
  });

  /* The source-order check is kept as a second signal, but it now asserts both positions are REAL
   * first. Without that, "the thing I am looking for is absent" satisfies it, which is exactly how
   * the previous version passed. */
  test('the EEO refusal is present and precedes every score matcher in the source', () => {
    const source = readFileSync('src/lib/questionDiscovery.ts', 'utf8');
    const fn = source.slice(source.indexOf('function standardizedTestAnswer'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    const guard = body.indexOf('EEO_QUESTION.test(label)');
    const matcher = body.indexOf('isSatScoreQuestion');
    assert.ok(guard >= 0, 'the EEO refusal must exist');
    assert.ok(matcher >= 0, 'the score matcher must exist, or this comparison means nothing');
    assert.ok(guard < matcher, 'the EEO refusal must run before any score matcher');
  });
});

describe('standardized test scores: nothing is invented or derived', () => {
  test('a score is never invented: unanswered leaves the question for the student', () => {
    const empty: ApplicationProfileLike = {};
    assert.equal(typedValue(CORPUS_LABELS.sat, empty), undefined);
    assert.ok(skipped(CORPUS_LABELS.sat, empty), 'must report the question as left for you');
    assert.equal(typedValue(CORPUS_LABELS.act, empty), undefined);
    assert.equal(typedValue(CORPUS_LABELS.type, empty), undefined);
  });

  /* Nothing is derived from anything else. A stored SAT score fits both a type of "SAT" and a type
   * of "Both", so it is not evidence for either, and a type of "SAT" is not evidence of any
   * particular number. Each answers only from its own column. */
  test('a stored SAT score does not answer the test-type question', () => {
    assert.equal(typedValue(CORPUS_LABELS.type, { sat_score: '1520' }), undefined);
  });

  test('a stored test type does not answer a score question', () => {
    assert.equal(typedValue(CORPUS_LABELS.sat, { standardized_test_type: 'SAT' }), undefined);
  });

  test('"None" is a real answer and reaches the field', () => {
    assert.equal(typedValue(CORPUS_LABELS.type, { standardized_test_type: 'None' }), 'None');
  });
});

describe('standardized test scores: schema and migration agree', () => {
  test('every column is declared in schema.ts and created by the migration', () => {
    const schema = readFileSync('src/db/schema.ts', 'utf8');
    const migration = readFileSync('scripts/apply-standardized-test-scores-schema.mjs', 'utf8');
    for (const column of ['standardized_test_type', 'sat_score', 'act_score']) {
      assert.match(schema, new RegExp(`${column}: text\\('${column}'\\)`));
      assert.match(migration, new RegExp(`add column if not exists ${column} text`));
    }
  });

  /* NO COLUMN ON `profiles`, and this assertion is the guard on that.
   *
   * A `coursework` column was added there on this branch and removed before merge: `profiles` has 27
   * bare `db.select().from(profiles)` sites and no narrowed-projection helper, so a column declared
   * there ahead of its migration 42703s resume generation, autofill answers, the submission runner,
   * the account export and the INSERT that creates a profile row at all. This migration therefore
   * touches exactly one table, and if that ever changes the change has to be deliberate. */
  test('the migration touches application_profile only', () => {
    const migration = readFileSync('scripts/apply-standardized-test-scores-schema.mjs', 'utf8');
    assert.doesNotMatch(migration, /alter table profiles/i);
    assert.doesNotMatch(migration, /coursework/i);
  });

  /* The columns must stay nullable, and the migration must verify it rather than assume it. Null is
   * the only way the resolver can tell "never asked" from an answer, and a NOT NULL with a default
   * would recreate the referral_source_default defect exactly: a value nobody typed, given to an
   * employer as a statement of fact. */
  test('the migration refuses a NOT NULL column and never backfills a value', () => {
    const migration = readFileSync('scripts/apply-standardized-test-scores-schema.mjs', 'utf8');
    assert.match(migration, /is_nullable/);
    assert.doesNotMatch(migration, /\bupdate\s+application_profile\b/i);
    // No SQL DEFAULT on any of them. This is the referral_source_default defect exactly: a column
    // default put "Company website" on 16 production rows and every one was read as a statement
    // the student had made. A default here would be a test score nobody sat.
    assert.doesNotMatch(migration, /\bset\s+default\b/i);
    assert.doesNotMatch(migration, /\btext\s+default\b/i);
  });

  /* THERE IS NO WORKFLOW, AND THAT IS THE ASSERTION.
   *
   * A workflow shipped here briefly, and the test guarding it asserted the OPPOSITE of the change
   * it was written for: it required `github.ref == 'refs/heads/main'` to be PRESENT after that gate
   * had been deliberately removed, and it passed anyway because the string survived inside a COMMENT
   * explaining the removal. A green assertion, satisfied by prose, pinning the reverse of the truth.
   *
   * The workflow itself could not have worked either: a `workflow_dispatch` workflow is only
   * addressable once it exists on the default branch, so one shipped in the same pull request as its
   * script cannot be dispatched until that pull request merges - after the moment it was for.
   *
   * So the file is gone and the procedure is a hand-run, documented in the migration script. Both
   * halves are asserted below, and against a COMMENT-STRIPPED copy, which is the whole lesson. */
  test('no migration workflow ships in the same change as its script', () => {
    assert.equal(
      existsSync('.github/workflows/standardized-test-scores-migration.yml'),
      false,
      'a workflow_dispatch workflow is not addressable until it is on the default branch',
    );
  });

  test('the hand-run procedure is written down where the operator will look', () => {
    const raw = readFileSync('scripts/apply-standardized-test-scores-schema.mjs', 'utf8');
    assert.match(raw, /npm run db:standardized-test-scores/);
    assert.match(raw, /BEFORE MERGING/);
  });

  /* The assertion the old one should have been. Comments are stripped first, so an explanation of a
   * removed key can never satisfy a check that the key is absent. */
  test('no workflow in the repo runs this migration automatically', () => {
    const dir = '.github/workflows';
    const files = readdirSync(dir);
    // Without this the test passes when the directory is empty or has been moved, which is the same
    // "absent satisfies the check" failure the two assertions above were rewritten for.
    assert.ok(files.length > 0, 'the workflows directory must have files, or this proves nothing');
    for (const file of files) {
      const source = readFileSync(`${dir}/${file}`, 'utf8');
      const code = source.replace(/#.*$/gm, '');
      if (!/db:standardized-test-scores/.test(code)) continue;
      assert.fail(`${file} runs this migration; it must be a hand-run until the workflow is registered`);
    }
  });
});
