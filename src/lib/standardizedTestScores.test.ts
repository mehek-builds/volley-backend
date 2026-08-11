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
import { readFileSync } from 'node:fs';
import { bodySchema } from '../routes/applicationProfile';
import { resolveKnownAnswer, type ApplicationProfileLike } from './questionDiscovery';
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
 * and appears in the corpus zero times. Extracted from all 300 distinct labels, the complete set of
 * standardized-test questions is these three. Each is required, text, and was blank on all 8 of the
 * packets it appears in. Answering the middle one and missing the other two, which is what a
 * "score"-keyed pattern does, is a migration that delivers a third of what it claims. */
const CORPUS_LABELS = {
  sat: 'provide your best result on sat',
  act: 'provide your best result on act',
  type: 'select your standardized test score type',
} as const;

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

/* THE GATES THAT KEEP "act" FROM MEANING THE TEST. "act" is an ordinary English word and the name
 * of most legislation, so a bare `\bact\b` would type a test score into a disability question. Two
 * gates: a value word must be present, and the label must be field-name length. Measured over the
 * corpus, `\bacts?\b` and `\bsats?\b` each appear in exactly one of the 300 labels and it is the
 * test question both times, so these guard the forms not yet seen. */
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

  test('the EEO refusal is the first act of the matcher, not a side effect of a word list', () => {
    const source = readFileSync('src/lib/questionDiscovery.ts', 'utf8');
    const fn = source.slice(source.indexOf('function standardizedTestAnswer'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    assert.ok(
      body.indexOf('EEO_QUESTION.test(label)') < body.indexOf('isSatScoreQuestion'),
      'the EEO refusal must run before any score matcher',
    );
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

  test('the migration is manual-dispatch only and cannot run itself on a merge', () => {
    const workflow = readFileSync('.github/workflows/standardized-test-scores-migration.yml', 'utf8');
    assert.match(workflow, /github\.ref == 'refs\/heads\/main'/);
    assert.match(workflow, /npm run db:standardized-test-scores/);
    assert.doesNotMatch(workflow, /^on:\s*\n\s*push/m);
  });
});
