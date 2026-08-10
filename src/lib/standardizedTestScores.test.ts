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

describe('standardized test scores: resolved and reaching the field', () => {
  test('a SAT question is answered with the SAT score', () => {
    assert.equal(typedValue('What is your SAT score?', answered), '1520');
    assert.equal(typedValue('SAT Score', answered), '1520');
  });

  test('an ACT question is answered with the ACT score, not the SAT one', () => {
    assert.equal(typedValue('What is your ACT score?', answered), '34');
    assert.equal(typedValue('ACT Score', answered), '34');
  });

  /* The ordering guard. "Which standardized test score do you wish to report?" contains the word
   * "score", and "What is your SAT score?" contains a test name; if the type pattern were tested
   * first it would answer the SAT field with the string "Both". A malformed answer on a required
   * field is worse than the blank it replaced, because nothing downstream can tell it is wrong. */
  test('a label naming a specific test gets that score, never the test type', () => {
    assert.notEqual(typedValue('What is your SAT score?', answered), 'Both');
    assert.notEqual(typedValue('What is your ACT score?', answered), 'Both');
  });

  test('a type question with no test named is answered with the type', () => {
    assert.equal(typedValue('Which standardized test did you take?', answered), 'Both');
    assert.equal(typedValue('Standardized test score type', answered), 'Both');
  });

  test('a score is never invented: unanswered leaves the question for the student', () => {
    const empty: ApplicationProfileLike = {};
    assert.equal(typedValue('What is your SAT score?', empty), undefined);
    assert.ok(skipped('What is your SAT score?', empty), 'must report the question as left for you');
    assert.equal(typedValue('What is your ACT score?', empty), undefined);
    assert.equal(typedValue('Which standardized test did you take?', empty), undefined);
  });

  /* Nothing is derived from anything else. A stored SAT score fits both a type of "SAT" and a type
   * of "Both", so it is not evidence for either, and a type of "SAT" is not evidence of any
   * particular number. Each answers only from its own column. */
  test('a stored SAT score does not answer the test-type question', () => {
    const satOnly: ApplicationProfileLike = { sat_score: '1520' };
    assert.equal(typedValue('Which standardized test did you take?', satOnly), undefined);
  });

  test('a stored test type does not answer a score question', () => {
    const typeOnly: ApplicationProfileLike = { standardized_test_type: 'SAT' };
    assert.equal(typedValue('What is your SAT score?', typeOnly), undefined);
  });

  test('"None" is a real answer and reaches the field', () => {
    assert.equal(
      typedValue('Which standardized test did you take?', { standardized_test_type: 'None' }),
      'None',
    );
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
    assert.match(schema, /coursework: jsonb\('coursework'\)/);
    assert.match(migration, /add column if not exists coursework jsonb/);
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
