import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { courseworkIsUngrounded } from './resumeValidate';

/* The case that started this: a UW sample CV listed "Race, Gender, and Sexuality in the Media".
 * The old check split the rendered line on "," and reported a verbatim-copied coursework line as
 * containing a fabricated course. */

describe('courseworkIsUngrounded', () => {
  const uw = [
    'Psychology of Gender',
    'Women and the Law',
    'Feminist Understanding of Victims',
    'Women and Violence',
    'Self-Concept',
    'Race, Gender, and Sexuality in the Media',
  ];

  test('a course whose own title contains commas is not a fabrication', () => {
    assert.equal(courseworkIsUngrounded(uw.join(', '), uw), false);
  });

  test('a course the resume never printed is still caught', () => {
    assert.equal(courseworkIsUngrounded('Psychology of Gender, Quantum Field Theory', uw), true);
  });

  test('a fabricated course hiding beside a comma-containing one is still caught', () => {
    assert.equal(
      courseworkIsUngrounded('Race, Gender, and Sexuality in the Media, Advanced Wizardry', uw),
      true,
    );
  });

  test('a subset of the printed courses is fine', () => {
    assert.equal(courseworkIsUngrounded('Women and Violence, Self-Concept', uw), false);
  });

  test('the longest allowed title wins when one is a prefix of another', () => {
    const allowed = ['Data Structures', 'Data Structures and Algorithms'];
    assert.equal(courseworkIsUngrounded('Data Structures and Algorithms', allowed), false);
    assert.equal(courseworkIsUngrounded('Data Structures', allowed), false);
    assert.equal(courseworkIsUngrounded('Data Structures and Wizardry', allowed), true);
  });

  test('an empty coursework line claims nothing', () => {
    assert.equal(courseworkIsUngrounded('', uw), false);
    assert.equal(courseworkIsUngrounded('   ', uw), false);
    assert.equal(courseworkIsUngrounded('', undefined), false);
  });

  test('any coursework at all is ungrounded when the resume listed none', () => {
    assert.equal(courseworkIsUngrounded('Psychology of Gender', []), true);
    assert.equal(courseworkIsUngrounded('Psychology of Gender', undefined), true);
  });

  test('the separator may vary without becoming a fabrication', () => {
    assert.equal(courseworkIsUngrounded('Women and Violence,Self-Concept', uw), false);
    assert.equal(courseworkIsUngrounded('  Women and Violence ,  Self-Concept  ', uw), false);
  });
});
