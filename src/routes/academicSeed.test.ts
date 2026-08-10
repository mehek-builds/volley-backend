import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { academicSeedFrom } from './profile';
import { decryptField } from '../lib/fieldCrypto';
import { gapsFrom } from './onboarding';
import { CATEGORIES, targetingBodySchema } from './targeting';

/* The gaps screen used to ask every student for a GPA and a major their own upload had just
 * printed. These pin the seeding that stops that, and the two ways it is allowed to say no. */

process.env.ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');

describe('academicSeedFrom', () => {
  test('seeds what the resume printed, and encrypts only the gpa', () => {
    const seed = academicSeedFrom({ gpa: '3.75', gpa_scale: '4.0', major: 'Psychology' }, undefined);
    assert.equal(seed.gpa_scale, '4.0');
    assert.equal(seed.major, 'Psychology');
    assert.notEqual(seed.gpa, '3.75', 'a stored gpa must be encrypted at rest');
    assert.equal(decryptField(seed.gpa!), '3.75');
  });

  test('never overwrites a value the student or the harvest already supplied', () => {
    const seed = academicSeedFrom(
      { gpa: '3.75', gpa_scale: '4.0', major: 'Psychology' },
      { gpa: 'already-encrypted', gpa_scale: '10.0', major: 'Computer Science' },
    );
    assert.deepEqual(seed, {}, 'a re-upload must not be able to restate a corrected record');
  });

  test('an absent field stays absent rather than becoming a guess', () => {
    assert.deepEqual(academicSeedFrom({ gpa: '', gpa_scale: '', major: '' }, undefined), {});
    assert.deepEqual(academicSeedFrom({}, undefined), {});
  });

  test('a gpa with no printed scale does not invent 4.0', () => {
    const seed = academicSeedFrom({ gpa: '8.9', gpa_scale: '', major: '' }, undefined);
    assert.ok(seed.gpa, 'the gpa itself is still worth keeping');
    assert.equal(seed.gpa_scale, undefined, 'guessing the denominator misstates a 10.0-scale record');
  });

  test('whitespace is not a value', () => {
    assert.deepEqual(academicSeedFrom({ gpa: '   ', major: ' ' }, undefined), {});
    const seed = academicSeedFrom({ major: 'Physics' }, { major: '   ' });
    assert.equal(seed.major, 'Physics', 'a blank column is still a blank, so it may be filled');
  });
});

describe('the gaps a seeded profile still has', () => {
  test('a resume that printed a GPA and a major removes those questions', () => {
    const seeded = academicSeedFrom({ gpa: '3.75', gpa_scale: '4.0', major: 'Psychology' }, undefined);
    assert.deepEqual(gapsFrom(seeded as Record<string, unknown>), [
      'languages',
      // Nothing a resume parse can seed. coursework is the one gap judged against the `profiles`
      // row rather than this one, so an omitted second argument reads as never asked.
      'coursework',
      'standardized_test_type',
      'sat_score',
      'act_score',
      'desired_salary',
      'desired_salary_currency',
      'referral_source_default',
    ]);
  });

  test('a resume that printed nothing leaves the full eleven', () => {
    assert.equal(gapsFrom({}).length, 11);
  });

  /* coursework closes only when the profiles row carries a list. An empty array is a real answer
     ("no coursework to list") and closes the question; a missing row never asked it. */
  test('a declared coursework list closes that gap and nothing else', () => {
    assert.ok(!gapsFrom({}, { coursework: ['Algorithms'] }).includes('coursework'));
    assert.ok(!gapsFrom({}, { coursework: [] }).includes('coursework'));
    assert.ok(gapsFrom({}, {}).includes('coursework'));
    assert.ok(gapsFrom({}, { coursework: 'Algorithms' }).includes('coursework'));
  });
});

describe('targeting categories are a closed list on the server too', () => {
  test('the eight the web app offers are accepted', () => {
    for (const slug of CATEGORIES) {
      assert.equal(targetingBodySchema.safeParse({ categories: [slug] }).success, true, slug);
    }
  });

  test('a category the matcher has never heard of is rejected, not stored', () => {
    assert.equal(targetingBodySchema.safeParse({ categories: ['engineering'] }).success, false);
    assert.equal(targetingBodySchema.safeParse({ categories: ['SWE'] }).success, false);
  });

  test('an empty list is still valid, because it is what "not chosen yet" saves', () => {
    assert.equal(targetingBodySchema.safeParse({ categories: [] }).success, true);
    assert.equal(targetingBodySchema.safeParse({ categories: null }).success, true);
  });
});
