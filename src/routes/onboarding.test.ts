import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gapsFrom, hasFocusTargeting, onboardingStepFrom } from './onboarding';
import { encryptField } from '../lib/fieldCrypto';

process.env.ENCRYPTION_KEY ??= 'test-encryption-key-at-least-32-chars-long';

// gapsFrom is what /onboarding/state serves as `gaps`: the screen-03 questions the first
// application did not answer. languages is the first jsonb field on the list, and "answered"
// for it means a non-empty array, not a non-empty string.

describe('onboarding gaps: languages', () => {
  test('no profile row at all: every gap field is open, languages included, in render order', () => {
    assert.deepEqual(gapsFrom(undefined), [
      'gpa',
      'gpa_scale',
      'major',
      'languages',
      'desired_salary',
      'desired_salary_currency',
    ]);
  });

  test('a declared list closes the gap', () => {
    assert.equal(gapsFrom({ languages: ['English', 'Hindi'] }).includes('languages'), false);
  });

  test('an empty array is still a gap - skipped and never-asked are the same fact', () => {
    assert.equal(gapsFrom({ languages: [] }).includes('languages'), true);
  });

  test('null or a malformed non-array value is a gap, not a crash', () => {
    assert.equal(gapsFrom({ languages: null }).includes('languages'), true);
    assert.equal(gapsFrom({ languages: 'English' }).includes('languages'), true);
    assert.equal(gapsFrom({ languages: { fluent: true } }).includes('languages'), true);
  });

  test('text gap fields keep their readable() semantics beside it', () => {
    // major is plaintext, gpa is encrypted at rest; both count as answered exactly as before,
    // and the remaining gaps come back in GAP_FIELDS order.
    const g = gapsFrom({
      major: 'Computer Science',
      gpa: encryptField('3.89'),
      languages: ['English'],
    });
    assert.deepEqual(g, ['gpa_scale', 'desired_salary', 'desired_salary_currency']);
  });
});

describe('onboarding step order', () => {
  const ready = {
    completed: false,
    hasResume: true,
    hasFocus: true,
    hasSponsorshipAnswer: true,
    hasBaseResume: true,
    hasApplied: true,
    hasTargeting: true,
    hasGaps: false,
  };

  test('a new account starts with the resume before targeting', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasResume: false, hasFocus: false }), 'resume');
  });

  test('the resume unlocks the inferred job and type choices', () => {
    assert.equal(onboardingStepFrom({ ...ready, hasFocus: false }), 'focus');
  });

  test('every derived step and the gaps fork follow the intended precedence', () => {
    const cases: Array<[string, Parameters<typeof onboardingStepFrom>[0]]> = [
      ['done', { ...ready, completed: true, hasResume: false }],
      ['resume', { ...ready, hasResume: false, hasFocus: false, hasSponsorshipAnswer: false }],
      ['focus', { ...ready, hasFocus: false, hasSponsorshipAnswer: false }],
      ['sponsorship', { ...ready, hasSponsorshipAnswer: false, hasBaseResume: false }],
      ['base', { ...ready, hasBaseResume: false, hasApplied: false }],
      ['install', { ...ready, hasApplied: false, hasTargeting: false }],
      ['gaps', { ...ready, hasTargeting: false, hasGaps: true }],
      ['targeting', { ...ready, hasTargeting: false, hasGaps: false }],
      ['done', ready],
    ];
    for (const [expected, input] of cases) {
      assert.equal(onboardingStepFrom(input), expected);
    }
  });
});

describe('resume-informed focus completion', () => {
  test('old category-only targeting does not skip the five inferred jobs screen', () => {
    assert.equal(hasFocusTargeting({ categories: ['software-engineering'], role_types: ['internship'] }), false);
  });

  test('titles and role type complete the resume-informed focus screen', () => {
    assert.equal(hasFocusTargeting({
      categories: ['software-engineering'],
      titles: ['Software Engineer'],
      role_types: ['internship'],
    }), true);
  });
});
